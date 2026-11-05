'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFileSync, spawn } = require('child_process');
const { MongoClient } = require('mongodb');
const yaml = require('js-yaml');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOSTNAME || '0.0.0.0';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const GNB_CFG = process.env.GNB_CFG || '/opt/open5gs-lab/manual-gnb.yaml';
const UE_CFG = process.env.UE_CFG || '/opt/open5gs-lab/manual-ue.yaml';
const GNB_BIN = '/opt/UERANSIM/build/nr-gnb';
const UE_BIN = '/opt/UERANSIM/build/nr-ue';
const LOG_DIR = '/var/log/open5gs-lab';

const OPEN5GS_UNITS = [
  { id: 'amf', unit: 'open5gs-amfd', label: 'AMF' },
  { id: 'smf', unit: 'open5gs-smfd', label: 'SMF' },
  { id: 'upf', unit: 'open5gs-upfd', label: 'UPF' },
  { id: 'nrf', unit: 'open5gs-nrfd', label: 'NRF' },
  { id: 'ausf', unit: 'open5gs-ausfd', label: 'AUSF' },
  { id: 'udm', unit: 'open5gs-udmd', label: 'UDM' },
  { id: 'udr', unit: 'open5gs-udrd', label: 'UDR' },
  { id: 'pcf', unit: 'open5gs-pcfd', label: 'PCF' },
  { id: 'webui', unit: 'open5gs-webui', label: 'WebUI SIMs' },
  { id: 'mongo', unit: 'mongod', label: 'MongoDB' },
];

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function sh(cmd, args = [], opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: opts.timeout || 8000,
      maxBuffer: 2 * 1024 * 1024,
    }).trim();
  } catch (err) {
    if (opts.allowFail) return (err.stdout || '').toString().trim();
    throw err;
  }
}

function unitActive(unit) {
  try {
    const out = sh('systemctl', ['is-active', unit], { allowFail: true });
    return out === 'active';
  } catch {
    return false;
  }
}

const RAN_HOST = process.env.RAN_HOST || '';
const RAN_USER = process.env.RAN_USER || 'admin';
const RAN_KEY = process.env.RAN_SSH_KEY || '/root/.ssh/id_mask';

let ranCache = { at: 0, data: null };

function remoteRan() {
  if (!RAN_HOST) return null;
  const now = Date.now();
  if (now - ranCache.at < 4000) return ranCache.data;
  ranCache.at = now;
  try {
    const out = sh('ssh', [
      '-i', RAN_KEY,
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=4',
      '-o', 'StrictHostKeyChecking=accept-new',
      `${RAN_USER}@${RAN_HOST}`,
      'sudo -n /usr/local/sbin/mask-ran status',
    ], { timeout: 6000, allowFail: true });
    const data = { gnb: false, ues: [], log: [] };
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('GNB ')) {
        data.gnb = trimmed.endsWith('1');
      } else if (trimmed.startsWith('UE ')) {
        const [, imsi, iface, ip] = trimmed.split(/\s+/);
        data.ues.push({
          imsi: imsi && imsi !== 'unknown' ? imsi : null,
          iface: iface || null,
          ip: ip && ip.includes('.') ? ip : null,
          namespace: null,
          source: 'ran',
        });
      } else {
        data.log.push(trimmed);
      }
    }
    ranCache.data = data;
  } catch {
    ranCache.data = null;
  }
  return ranCache.data;
}

function pgrep(pattern) {
  try {
    const out = sh('pgrep', ['-af', pattern], { allowFail: true });
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !l.includes('pgrep'));
  } catch {
    return [];
  }
}

function readTail(file, lines = 40) {
  try {
    if (!fs.existsSync(file)) return '';
    return sh('tail', ['-n', String(lines), file], { allowFail: true });
  } catch {
    return '';
  }
}

function ogstunInfo() {
  const out = sh('ip', ['-4', '-o', 'addr', 'show', 'dev', 'ogstun'], { allowFail: true });
  const m = out.match(/inet\s+(\d+\.\d+\.\d+\.\d+\/\d+)/);
  return {
    up: Boolean(out),
    address: m ? m[1] : null,
  };
}

function listConnectedUes() {
  const ues = [];
  const nsList = sh('ip', ['netns', 'list'], { allowFail: true });
  for (const line of nsList.split('\n')) {
    const ns = (line.trim().split(/\s+/)[0] || '').trim();
    if (!ns) continue;
    const addrOut = sh('ip', ['netns', 'exec', ns, 'ip', '-4', '-o', 'addr', 'show'], { allowFail: true });
    for (const a of addrOut.split('\n')) {
      if (!a.includes('uesimtun')) continue;
      const parts = a.trim().split(/\s+/);
      const iface = parts[1];
      const cidr = (parts.find((p) => p.includes('/')) || '').split('/')[0];
      const imsiMatch = ns.match(/(\d{15})/);
      ues.push({
        namespace: ns,
        iface,
        ip: cidr || null,
        imsi: imsiMatch ? imsiMatch[1] : null,
        source: 'namespace',
      });
    }
  }

  // Fallback: TUN without namespace
  const host = sh('ip', ['-4', '-o', 'addr', 'show'], { allowFail: true });
  for (const a of host.split('\n')) {
    if (!a.includes('uesimtun')) continue;
    const parts = a.trim().split(/\s+/);
    const iface = parts[1];
    const cidr = (parts.find((p) => p.includes('/')) || '').split('/')[0];
    if (ues.some((u) => u.iface === iface && u.ip === cidr)) continue;
    ues.push({
      namespace: null,
      iface,
      ip: cidr || null,
      imsi: null,
      source: 'host',
    });
  }
  if (ues.length) return ues;
  return remoteRan()?.ues?.filter((u) => u.ip) || [];
}

function gnbStatus() {
  const procs = pgrep('nr-gnb');
  const log = readTail(path.join(LOG_DIR, 'gnb.log'), 120);
  const setupOk = /NG Setup procedure is successful/i.test(log);
  let connected = setupOk;
  if (!connected && procs.length) {
    const sctp = sh('bash', ['-lc', 'ss --sctp -tn 2>/dev/null | head -40 || true'], { allowFail: true });
    connected = /38412/.test(sctp);
  }
  if (procs.length) {
    return {
      running: true,
      connected: connected || procs.length > 0,
      processes: procs,
      logTail: log.split('\n').slice(-12),
    };
  }
  const remote = remoteRan();
  if (remote?.gnb) {
    return {
      running: true,
      connected: true,
      processes: [`nr-gnb@${RAN_HOST}`],
      logTail: remote.log.length ? remote.log : ['gNB ativo na VM do UERANSIM'],
    };
  }
  return {
    running: false,
    connected: false,
    processes: [],
    logTail: log.split('\n').slice(-12),
  };
}

function ueStatus() {
  const procs = pgrep('nr-ue');
  if (procs.length) {
    return { running: true, count: procs.length, processes: procs };
  }
  const remote = remoteRan();
  const count = remote?.ues?.length || 0;
  return {
    running: count > 0,
    count,
    processes: count ? [`nr-ue@${RAN_HOST}`] : [],
  };
}

async function listSims() {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const docs = await client
      .db('open5gs')
      .collection('subscribers')
      .find({}, { projection: { imsi: 1, security: 1, slice: 1, msisdn: 1 } })
      .toArray();
    return docs.map((d) => {
      const session = d.slice?.[0]?.session?.[0] || {};
      return {
        imsi: d.imsi,
        opc: d.security?.opc || null,
        k: d.security?.k ? `${String(d.security.k).slice(0, 4)}…` : null,
        apn: session.name || 'internet',
        staticIp: session.ue?.ipv4 || null,
      };
    });
  } finally {
    await client.close().catch(() => {});
  }
}

function loadYamlFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return { raw, data: yaml.load(raw) };
}

function backupFile(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, `${file}.bak-${stamp}`);
}

function getAmfConfig() {
  const { data } = loadYamlFile('/etc/open5gs/amf.yaml');
  const amf = data.amf || {};
  return {
    ngapAddress: amf.ngap?.server?.[0]?.address || '',
    sbiAddress: amf.sbi?.server?.[0]?.address || '',
    sbiPort: amf.sbi?.server?.[0]?.port || 7777,
    mcc: amf.guami?.[0]?.plmn_id?.mcc || '',
    mnc: amf.guami?.[0]?.plmn_id?.mnc || '',
    tac: amf.tai?.[0]?.tac ?? '',
    networkName: amf.network_name?.full || '',
  };
}

function getSmfConfig() {
  const { data } = loadYamlFile('/etc/open5gs/smf.yaml');
  const smf = data.smf || {};
  const session = (smf.session || []).find((s) => String(s.subnet || '').includes('.')) || {};
  return {
    pfcpAddress: smf.pfcp?.server?.[0]?.address || '',
    upfAddress: smf.pfcp?.client?.upf?.[0]?.address || '',
    gtpuAddress: smf.gtpu?.server?.[0]?.address || '',
    subnet: session.subnet || '',
    gateway: session.gateway || '',
    dns: (smf.dns || []).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(String(d))),
  };
}

function getUpfConfig() {
  const { data } = loadYamlFile('/etc/open5gs/upf.yaml');
  const upf = data.upf || {};
  const session = (upf.session || []).find((s) => String(s.subnet || '').includes('.')) || {};
  return {
    pfcpAddress: upf.pfcp?.server?.[0]?.address || '',
    gtpuAddress: upf.gtpu?.server?.[0]?.address || '',
    subnet: session.subnet || '',
    gateway: session.gateway || '',
  };
}

function gnbConfigPath() {
  if (fs.existsSync(GNB_CFG)) return GNB_CFG;
  const sample = '/opt/UERANSIM/config/open5gs-gnb.yaml';
  if (fs.existsSync(sample)) return sample;
  return null;
}

function getGnbConfig() {
  const file = gnbConfigPath();
  if (!file) {
    return {
      file: null,
      available: false,
      mcc: '',
      mnc: '',
      tac: '',
      linkIp: '',
      ngapIp: '',
      gtpIp: '',
      amfAddress: '',
      amfPort: 38412,
    };
  }
  const { data } = loadYamlFile(file);
  return {
    file,
    available: true,
    mcc: data.mcc || '',
    mnc: data.mnc || '',
    tac: data.tac ?? '',
    linkIp: data.linkIp || '',
    ngapIp: data.ngapIp || '',
    gtpIp: data.gtpIp || '',
    amfAddress: data.amfConfigs?.[0]?.address || '',
    amfPort: data.amfConfigs?.[0]?.port || 38412,
  };
}

function saveAmfConfig(body) {
  const file = '/etc/open5gs/amf.yaml';
  backupFile(file);
  const { data } = loadYamlFile(file);
  data.amf = data.amf || {};
  data.amf.ngap = data.amf.ngap || {};
  data.amf.ngap.server = [{ address: body.ngapAddress }];
  data.amf.sbi = data.amf.sbi || {};
  data.amf.sbi.server = [{ address: body.sbiAddress, port: Number(body.sbiPort) || 7777 }];
  const plmn = { mcc: String(body.mcc), mnc: String(body.mnc) };
  if (data.amf.guami?.[0]) data.amf.guami[0].plmn_id = { ...data.amf.guami[0].plmn_id, ...plmn };
  if (data.amf.tai?.[0]) {
    data.amf.tai[0].plmn_id = { ...data.amf.tai[0].plmn_id, ...plmn };
    data.amf.tai[0].tac = Number(body.tac);
  }
  if (data.amf.plmn_support?.[0]) data.amf.plmn_support[0].plmn_id = { ...data.amf.plmn_support[0].plmn_id, ...plmn };
  data.amf.network_name = data.amf.network_name || {};
  data.amf.network_name.full = body.networkName || 'Open5GS';
  fs.writeFileSync(file, yaml.dump(data, { lineWidth: 120 }));
}

function saveSmfConfig(body) {
  const file = '/etc/open5gs/smf.yaml';
  backupFile(file);
  const { data } = loadYamlFile(file);
  data.smf = data.smf || {};
  data.smf.pfcp = data.smf.pfcp || {};
  data.smf.pfcp.server = [{ address: body.pfcpAddress }];
  data.smf.pfcp.client = { upf: [{ address: body.upfAddress }] };
  data.smf.gtpu = data.smf.gtpu || {};
  data.smf.gtpu.server = [{ address: body.gtpuAddress }];
  const v6 = (data.smf.session || []).find((s) => String(s.subnet || '').includes(':'));
  data.smf.session = [
    { subnet: body.subnet, gateway: body.gateway },
    ...(v6 ? [v6] : []),
  ];
  const dns6 = (data.smf.dns || []).filter((d) => String(d).includes(':'));
  data.smf.dns = [...(body.dns || []), ...dns6];
  fs.writeFileSync(file, yaml.dump(data, { lineWidth: 120 }));
}

function saveUpfConfig(body) {
  const file = '/etc/open5gs/upf.yaml';
  backupFile(file);
  const { data } = loadYamlFile(file);
  data.upf = data.upf || {};
  data.upf.pfcp = data.upf.pfcp || {};
  data.upf.pfcp.server = [{ address: body.pfcpAddress }];
  data.upf.gtpu = data.upf.gtpu || {};
  data.upf.gtpu.server = [{ address: body.gtpuAddress }];
  const v6 = (data.upf.session || []).find((s) => String(s.subnet || '').includes(':'));
  data.upf.session = [
    { subnet: body.subnet, gateway: body.gateway },
    ...(v6 ? [v6] : []),
  ];
  fs.writeFileSync(file, yaml.dump(data, { lineWidth: 120 }));
}

function saveGnbConfig(body) {
  const file = gnbConfigPath();
  if (!file) throw new Error('Arquivo do gNB não está nesta máquina');
  backupFile(file);
  const { data } = loadYamlFile(file);
  data.mcc = String(body.mcc);
  data.mnc = String(body.mnc);
  data.tac = Number(body.tac);
  data.linkIp = body.linkIp;
  data.ngapIp = body.ngapIp;
  data.gtpIp = body.gtpIp;
  data.amfConfigs = [{ address: body.amfAddress, port: Number(body.amfPort) || 38412 }];
  fs.writeFileSync(file, yaml.dump(data, { lineWidth: 120 }));
  // Keep lab copy in sync with UERANSIM sample when using lab path
  if (file === GNB_CFG) {
    try {
      fs.copyFileSync(file, '/opt/open5gs-lab/gnb.yaml');
    } catch {}
  }
}

function restartUnits(units) {
  for (const u of units) {
    try {
      sh('systemctl', ['restart', u], { timeout: 20000 });
    } catch (err) {
      return { ok: false, error: `Falha ao reiniciar ${u}: ${err.message}` };
    }
  }
  return { ok: true };
}

app.get('/api/overview', async (_req, res) => {
  try {
    const services = OPEN5GS_UNITS.map((s) => ({
      ...s,
      active: unitActive(s.unit),
    }));
    const gnb = gnbStatus();
    const ue = ueStatus();
    const ues = listConnectedUes();
    const ogstun = ogstunInfo();
    let sims = [];
    try {
      sims = await listSims();
    } catch (e) {
      sims = [];
    }
    const connectedImsis = new Set(ues.map((u) => u.imsi).filter(Boolean));
    const simsEnriched = sims.map((s) => ({
      ...s,
      connected: connectedImsis.has(s.imsi) || ues.some((u) => u.ip && s.staticIp && u.ip === s.staticIp),
      liveIp: ues.find((u) => u.imsi === s.imsi)?.ip || null,
    }));

    const coreOnline = ['amf', 'smf', 'upf', 'mongo'].every((id) => services.find((s) => s.id === id)?.active);

    res.json({
      ts: new Date().toISOString(),
      coreOnline,
      ogstun,
      services,
      gnb: { running: gnb.running, connected: gnb.running, logTail: gnb.logTail },
      ueProc: ue,
      ues,
      sims: simsEnriched,
      links: {
        open5gsWebui: 'http://localhost:9999',
        dashboard: `http://localhost:${PORT}`,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/config', (_req, res) => {
  try {
    res.json({
      amf: getAmfConfig(),
      smf: getSmfConfig(),
      upf: getUpfConfig(),
      gnb: getGnbConfig(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/config/:target', (req, res) => {
  try {
    const target = req.params.target;
    const restart = Boolean(req.body?.restart);
    delete req.body.restart;

    if (target === 'amf') {
      saveAmfConfig(req.body);
      if (restart) {
        const r = restartUnits(['open5gs-amfd']);
        if (!r.ok) return res.status(500).json(r);
      }
    } else if (target === 'smf') {
      saveSmfConfig(req.body);
      if (restart) {
        const r = restartUnits(['open5gs-smfd']);
        if (!r.ok) return res.status(500).json(r);
      }
    } else if (target === 'upf') {
      saveUpfConfig(req.body);
      if (restart) {
        sh('bash', ['/opt/open5gs-lab/setup-tun.sh'], { allowFail: true, timeout: 10000 });
        const r = restartUnits(['open5gs-upfd']);
        if (!r.ok) return res.status(500).json(r);
      }
    } else if (target === 'gnb') {
      saveGnbConfig(req.body);
    } else {
      return res.status(400).json({ error: 'Alvo inválido' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/actions/:action', (req, res) => {
  try {
    const action = req.params.action;
    fs.mkdirSync(LOG_DIR, { recursive: true });

    if (action === 'start-gnb') {
      if (pgrep('nr-gnb').length) return res.json({ ok: true, message: 'gNB já está rodando' });
      if (!fs.existsSync(GNB_BIN)) {
        return res.status(400).json({ error: 'UERANSIM não está nesta máquina. O gNB sobe no host do RAN.' });
      }
      const cfg = gnbConfigPath();
      if (!cfg) return res.status(400).json({ error: 'Arquivo de configuração do gNB não encontrado' });
      const out = fs.openSync(path.join(LOG_DIR, 'gnb.log'), 'a');
      const child = spawn(GNB_BIN, ['-c', cfg], { detached: true, stdio: ['ignore', out, out] });
      child.unref();
      return res.json({ ok: true, pid: child.pid });
    }
    if (action === 'stop-gnb') {
      sh('pkill', ['-x', 'nr-gnb'], { allowFail: true });
      return res.json({ ok: true });
    }
    if (action === 'start-ue') {
      if (pgrep('nr-ue').length) return res.json({ ok: true, message: 'UE já está rodando' });
      if (!fs.existsSync(UE_BIN)) {
        return res.status(400).json({ error: 'UERANSIM não está nesta máquina. O UE sobe no host do RAN.' });
      }
      const cfg = fs.existsSync(UE_CFG) ? UE_CFG : '/opt/UERANSIM/config/open5gs-ue.yaml';
      if (!fs.existsSync(cfg)) return res.status(400).json({ error: 'Arquivo de configuração do UE não encontrado' });
      // ensure namespace mode
      try {
        let txt = fs.readFileSync(cfg, 'utf8');
        if (/useNamespace:\s*false/.test(txt)) {
          txt = txt.replace(/useNamespace:\s*false/, 'useNamespace: true');
          fs.writeFileSync(cfg, txt);
        }
      } catch {}
      const out = fs.openSync(path.join(LOG_DIR, 'ue-manual.log'), 'a');
      const child = spawn(UE_BIN, ['-c', cfg], { detached: true, stdio: ['ignore', out, out] });
      child.unref();
      return res.json({ ok: true, pid: child.pid });
    }
    if (action === 'stop-ue') {
      sh('pkill', ['-x', 'nr-ue'], { allowFail: true });
      return res.json({ ok: true });
    }
    if (action === 'setup-tun') {
      sh('bash', ['/opt/open5gs-lab/setup-tun.sh'], { timeout: 10000 });
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'Ação inválida' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

require('./tests-api').register(app);

app.get('/api/logs/:kind', (req, res) => {
  const kind = req.params.kind;
  const map = {
    gnb: path.join(LOG_DIR, 'gnb.log'),
    ue: path.join(LOG_DIR, 'ue-manual.log'),
    amf: '/var/log/open5gs/amf.log',
    upf: '/var/log/open5gs/upf.log',
  };
  if (!map[kind]) return res.status(400).json({ error: 'log inválido' });
  res.type('text/plain').send(readTail(map[kind], 80));
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Open5GS Mask Dashboard em http://${HOST}:${PORT}`);
});
