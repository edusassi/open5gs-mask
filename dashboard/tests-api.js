'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TEST_DIR = path.join(__dirname, 'testes');
const RUNNER = path.join(__dirname, 'test-runner.js');

function ensureDir() {
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

function readResult(dirName) {
  const file = path.join(TEST_DIR, dirName, 'result.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listResults() {
  ensureDir();
  return fs.readdirSync(TEST_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const result = readResult(d.name);
      if (!result) return null;
      if (result.status === 'running' && result.startedAt) {
        const age = Date.now() - new Date(result.startedAt).getTime();
        const limit = ((Number(result.seconds) || 60) + 180) * 1000;
        if (age > limit) {
          result.status = 'error';
          result.phase = 'done';
          result.error = result.error || 'O teste passou do tempo previsto e foi interrompido';
          result.finishedAt = result.finishedAt || new Date().toISOString();
          fs.writeFileSync(path.join(TEST_DIR, d.name, 'result.json'), JSON.stringify(result, null, 2));
        }
      }
      return result;
    })
    .filter(Boolean)
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      phase: r.phase,
      message: r.message,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      seconds: r.seconds,
      imsis: r.imsis,
      error: r.error,
      ues: (r.ues || []).map((u) => ({
        imsi: u.imsi,
        ip: u.ip,
        uploadMbps: u.uploadMbps ?? null,
        downloadMbps: u.downloadMbps ?? null,
        latencyMs: u.latencyMs ?? null,
        error: u.error || null,
      })),
    }))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function runningTest() {
  return listResults().find((r) => r.status === 'running');
}

function validImsis(list) {
  if (!Array.isArray(list) || !list.length || list.length > 8) return null;
  const imsis = list.map((v) => String(v || '').trim());
  if (imsis.some((imsi) => !/^\d{15}$/.test(imsi))) return null;
  if (new Set(imsis).size !== imsis.length) return null;
  return imsis;
}

function startJob({ kind, imsis, seconds }) {
  ensureDir();
  const active = runningTest();
  if (active) {
    const err = new Error('Já existe um teste em andamento');
    err.status = 409;
    throw err;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const id = `${kind === 'latency' ? 'lat' : 'thr'}-${stamp}`;
  const dir = path.join(TEST_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const job = { id, kind, imsis, seconds };
  const result = {
    ...job,
    status: 'running',
    phase: 'gnb',
    message: 'Iniciando',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ues: [],
    logs: { gnb: '', ues: {} },
    error: null,
  };
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job, null, 2));
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  const child = spawn(process.execPath, [RUNNER, path.join(dir, 'job.json')], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return result;
}

function register(app) {
  app.get('/api/tests', (_req, res) => {
    res.json({ tests: listResults() });
  });

  app.get('/api/tests/:id', (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[\w.-]+$/.test(id)) return res.status(400).json({ error: 'id inválido' });
    const result = readResult(id);
    if (!result) return res.status(404).json({ error: 'Teste não encontrado' });
    res.json(result);
  });

  app.post('/api/tests', (req, res) => {
    try {
      const imsis = validImsis(req.body?.imsis);
      const minutes = Number(req.body?.minutes);
      if (!imsis) return res.status(400).json({ error: 'Escolha de 1 a 8 SIM cards, sem repetir' });
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 5) {
        return res.status(400).json({ error: 'A duração deve ser de 1 a 5 minutos' });
      }
      const result = startJob({ kind: 'throughput', imsis, seconds: minutes * 60 });
      res.status(202).json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/tests/latency', (req, res) => {
    try {
      const imsis = validImsis(req.body?.imsis);
      if (!imsis) return res.status(400).json({ error: 'Escolha os SIM cards para a latência' });
      const result = startJob({ kind: 'latency', imsis, seconds: 20 });
      res.status(202).json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
}

module.exports = { register };
