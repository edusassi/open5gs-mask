'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAN_HOST = process.env.RAN_HOST || '';
const RAN_USER = process.env.RAN_USER || 'admin';
const RAN_KEY = process.env.RAN_SSH_KEY || '/root/.ssh/id_mask';
const IPERF_TARGET = process.env.IPERF_TARGET || '10.45.0.1';
const GNB_IP = process.env.GNB_LINK_IP || RAN_HOST;

const jobPath = process.argv[2];
if (!jobPath) {
  console.error('uso: node test-runner.js <job.json>');
  process.exit(1);
}

const dir = path.dirname(jobPath);
const resultPath = path.join(dir, 'result.json');
const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));

function save(patch) {
  const cur = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : {};
  const next = { ...cur, ...patch };
  fs.writeFileSync(resultPath, JSON.stringify(next, null, 2));
  return next;
}

function ssh(remoteCmd, input, timeoutMs) {
  return execFileSync('ssh', [
    '-i', RAN_KEY,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    `${RAN_USER}@${RAN_HOST}`,
    remoteCmd,
  ], {
    input,
    encoding: 'utf8',
    timeout: timeoutMs || 20000,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function ran(args, input, timeoutMs) {
  return ssh(`sudo -n /usr/local/sbin/mask-ran ${args}`, input, timeoutMs).trim();
}

function loadSim(imsi) {
  const evalScript = `const d=db.subscribers.findOne({imsi:${JSON.stringify(imsi)}},{security:1,slice:1,_id:0}); if(!d){print("null"); quit(0);} const s=d.slice&&d.slice[0]&&d.slice[0].session&&d.slice[0].session[0]; print(JSON.stringify({k:d.security&&d.security.k, opc:d.security&&d.security.opc, op:d.security&&d.security.op, amf:d.security&&d.security.amf, apn:s&&s.name}));`;
  const out = execFileSync('mongosh', ['--quiet', 'open5gs', '--eval', evalScript], { encoding: 'utf8' });
  const line = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'))[0];
  if (!line) throw new Error(`SIM ${imsi} não encontrado no Mongo`);
  const sim = JSON.parse(line);
  const hex = (v) => String(v || '').replace(/\s+/g, '').toUpperCase();
  sim.k = hex(sim.k);
  sim.opc = hex(sim.opc || sim.op);
  sim.amf = hex(sim.amf || '8000') || '8000';
  sim.apn = sim.apn || 'internet';
  if (!sim.k || !sim.opc) throw new Error(`SIM ${imsi} sem K/OPc`);
  return sim;
}

function ueYaml(imsi, sim) {
  const tail = String(imsi).slice(-2);
  const imei = `3569380356438${tail}`;
  return `supi: 'imsi-${imsi}'
mcc: '999'
mnc: '70'
key: '${sim.k}'
op: '${sim.opc}'
opType: 'OPC'
amf: '${sim.amf}'
imei: '${imei}'
imeiSv: '${imei}1'

gnbSearchList:
  - '${GNB_IP}'

uacAic:
  mps: false
  mcs: false

uacAcc:
  normalClass: 0
  class11: false
  class12: false
  class13: false
  class14: false
  class15: false

integrityMaxRate:
  uplink: 'full'
  downlink: 'full'

sessions:
  - type: 'IPv4'
    apn: '${sim.apn}'
    slice:
      sst: 1
      sd: 0x000001

configured-nssai:
  - sst: 1
    sd: 0x000001

default-nssai:
  - sst: 1
    sd: 0x000001

integrity:
  IA1: false
  IA2: true
  IA3: false

ciphering:
  EA1: false
  EA2: true
  EA3: false

routingIndicator: '0000'
tunNetmask: '255.255.255.0'
useNamespace: true
nsNamePrefix: 'ueransim'
`;
}

function sleep(ms) {
  execFileSync('sleep', [String(Math.max(1, Math.round(ms / 1000)))]);
}

function connectUes(imsis) {
  const ues = [];
  for (const imsi of imsis) {
    save({ message: `Preparando UE ${imsi}` });
    const sim = loadSim(imsi);
    ran(`ue-write ${imsi}`, ueYaml(imsi, sim), 15000);
    ran(`ue-ensure ${imsi}`, null, 15000);
    let found = null;
    for (let i = 0; i < 25; i += 1) {
      const line = ran(`ue-ip ${imsi}`, null, 15000);
      const [mode, target, ip] = line.split(/\s+/);
      if ((mode === 'ns' || mode === 'host') && ip && ip.includes('.')) {
        found = {
          imsi,
          mode,
          namespace: target,
          iface: mode === 'host' ? target : null,
          ip,
          upload: [],
          download: [],
          latency: [],
        };
        break;
      }
      sleep(2000);
    }
    if (!found) {
      let log = '';
      try { log = ran(`log ue ${imsi}`, null, 15000); } catch { log = ''; }
      fs.writeFileSync(path.join(dir, `ue-${imsi}.log`), log);
      throw new Error(`UE ${imsi} não abriu sessão PDU. Veja o log do UE.`);
    }
    ues.push(found);
    save({ ues, message: `UE ${imsi} em ${found.ip}` });
  }
  return ues;
}

function startServers(ues) {
  const { spawn } = require('child_process');
  const kids = [];
  ues.forEach((ue, i) => {
    ue.uploadPort = 15210 + i;
    ue.downloadPort = 15310 + i;
    for (const port of [ue.uploadPort, ue.downloadPort]) {
      const log = fs.openSync(path.join(dir, `iperf-server-${port}.log`), 'a');
      const child = spawn('iperf3', ['-s', '-4', '-B', IPERF_TARGET, '-p', String(port), '-1'], {
        stdio: ['ignore', log, log],
        detached: true,
      });
      child.unref();
      kids.push(child.pid);
    }
  });
  fs.writeFileSync(path.join(dir, 'iperf-servers.pid'), kids.join('\n'));
  sleep(1000);
}

function stopServers() {
  const pidFile = path.join(dir, 'iperf-servers.pid');
  if (!fs.existsSync(pidFile)) return;
  for (const pid of fs.readFileSync(pidFile, 'utf8').split('\n')) {
    if (!/^\d+$/.test(pid)) continue;
    try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already gone */ }
  }
}

function parseIperf(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(raw.trim().slice(0, 400) || 'iperf sem JSON');
  const doc = JSON.parse(raw.slice(start, end + 1));
  if (doc.error) throw new Error(doc.error);
  const points = (doc.intervals || []).map((iv) => ({
    t: Number(iv.sum?.start ?? 0),
    mbps: Number(iv.sum?.bits_per_second || 0) / 1e6,
  }));
  const endSum = doc.end?.sum_sent?.bits_per_second
    || doc.end?.sum_received?.bits_per_second
    || doc.end?.sum?.bits_per_second
    || 0;
  return { points, mbps: endSum / 1e6 };
}

function parsePing(raw) {
  const points = [];
  let t0 = null;
  for (const line of raw.split('\n')) {
    const m = line.match(/\[(\d+(?:\.\d+)?)\].*time[=<]([0-9.]+)\s*ms/i);
    if (!m) continue;
    const stamp = Number(m[1]);
    if (t0 == null) t0 = stamp;
    points.push({ t: Math.max(0, stamp - t0), ms: Number(m[2]) });
  }
  const avg = points.length ? points.reduce((a, p) => a + p.ms, 0) / points.length : null;
  return { points, avg };
}

function splitBundle(text) {
  const files = {};
  const parts = text.split(/^===== (.+) =====$/m);
  for (let i = 1; i < parts.length; i += 2) files[parts[i]] = parts[i + 1] || '';
  return files;
}

function attachLogs(ues) {
  const logs = { gnb: '', ues: {} };
  try { logs.gnb = ran('log gnb', null, 15000); } catch { logs.gnb = ''; }
  fs.writeFileSync(path.join(dir, 'gnb.log'), logs.gnb);
  for (const ue of ues) {
    try { logs.ues[ue.imsi] = ran(`log ue ${ue.imsi}`, null, 15000); } catch { logs.ues[ue.imsi] = ''; }
    fs.writeFileSync(path.join(dir, `ue-${ue.imsi}.log`), logs.ues[ue.imsi]);
  }
  return logs;
}

function summarize(ue) {
  const avg = (pts, key) => (pts.length ? pts.reduce((a, p) => a + p[key], 0) / pts.length : null);
  ue.uploadMbps = avg(ue.upload, 'mbps');
  ue.downloadMbps = avg(ue.download, 'mbps');
  ue.latencyMs = avg(ue.latency, 'ms');
}

async function main() {
  if (!RAN_HOST) throw new Error('Defina RAN_HOST com o IP da máquina do UERANSIM');
  const imsis = job.imsis;
  const seconds = Number(job.seconds);
  save({ status: 'running', phase: 'gnb', message: 'Subindo gNB e esperando o NG Setup' });
  const gnb = ran('gnb-ensure', null, 40000);
  if (!/^OK|^ALREADY/.test(gnb)) throw new Error(`gNB não conectou ao AMF (${gnb})`);

  save({ phase: 'ue', message: 'Conectando UEs ao core' });
  const ues = connectUes(imsis);

  if (job.kind === 'latency') {
    save({ phase: 'iperf', message: 'Medindo latência', ues });
    for (const ue of ues) {
      const raw = ran(`ping ${ue.imsi} 20`, null, 40000);
      fs.writeFileSync(path.join(dir, `ping-${ue.imsi}.txt`), raw);
      const ping = parsePing(raw);
      ue.latency = ping.points;
      ue.latencyMs = ping.avg;
    }
    const logs = attachLogs(ues);
    save({
      status: 'done',
      phase: 'done',
      message: 'Latência medida',
      finishedAt: new Date().toISOString(),
      ues,
      logs,
      error: null,
    });
    return;
  }

  save({ phase: 'iperf', message: `iperf3 por ${seconds}s, com ping em paralelo`, ues });
  startServers(ues);
  const spec = ues.map((ue) => `${ue.imsi} ${ue.mode} ${ue.namespace} ${ue.ip} ${ue.uploadPort} ${ue.downloadPort} ${seconds}`).join('\n') + '\n';
  let bundle = '';
  try {
    bundle = ran('suite', spec, (seconds + 90) * 1000);
  } finally {
    stopServers();
  }
  const files = splitBundle(bundle);
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  for (const ue of ues) {
    try {
      const up = parseIperf(files[`up-${ue.imsi}.json`] || '');
      ue.upload = up.points;
      ue.uploadMbps = up.mbps;
    } catch (err) {
      ue.error = `upload: ${err.message}`;
      ue.uploadMbps = null;
    }
    try {
      const down = parseIperf(files[`down-${ue.imsi}.json`] || '');
      ue.download = down.points;
      ue.downloadMbps = down.mbps;
    } catch (err) {
      ue.error = `${ue.error ? `${ue.error}; ` : ''}download: ${err.message}`;
      ue.downloadMbps = null;
    }
    const ping = parsePing(files[`ping-${ue.imsi}.txt`] || '');
    ue.latency = ping.points;
    ue.latencyMs = ping.avg;
    summarize(ue);
  }
  const logs = attachLogs(ues);
  const failed = ues.filter((ue) => ue.uploadMbps == null && ue.downloadMbps == null);
  save({
    status: failed.length === ues.length ? 'error' : 'done',
    phase: 'done',
    message: failed.length ? 'Teste terminou com falha no iperf3' : 'Teste concluído',
    finishedAt: new Date().toISOString(),
    ues,
    logs,
    error: failed.length ? failed.map((ue) => `${ue.imsi}: ${ue.error || 'sem medida'}`).join(' | ') : null,
  });
}

main().catch((err) => {
  let logs = {};
  try { logs = { gnb: ran('log gnb', null, 15000) }; } catch { logs = {}; }
  save({
    status: 'error',
    phase: 'done',
    message: err.message,
    error: err.message,
    finishedAt: new Date().toISOString(),
    logs,
  });
  try { stopServers(); } catch { /* ignore */ }
  process.exit(1);
});
