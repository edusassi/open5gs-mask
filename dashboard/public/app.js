const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const WEBUI = `${location.protocol}//${location.hostname}:9999`;

function pointWebuiLinks() {
  for (const id of ['link-webui', 'link-webui-sims']) {
    const a = document.getElementById(id);
    if (a) a.href = WEBUI;
  }
}

function toast(msg, err = false) {
  const el = $('#toast');
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle('err', err);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function setPill(id, state, label) {
  const el = $(id);
  el.classList.remove('on', 'off', 'warn');
  el.classList.add(state);
  el.querySelector('span:last-child').textContent = label;
}

function chip(el, on, onText, offText) {
  el.classList.toggle('on', on);
  el.classList.toggle('off', !on);
  el.textContent = on ? onText : offText;
}

function renderServices(services) {
  const grid = $('#svc-grid');
  grid.innerHTML = services.map((s) => `
    <div class="svc ${s.active ? 'on' : ''}">
      <span>${s.label}</span>
      <span>${s.active ? 'active' : 'down'}</span>
    </div>
  `).join('');
}

function renderUes(target, ues) {
  const el = $(target);
  if (!ues.length) {
    el.innerHTML = '<div class="empty">Nenhum UE com sessão PDU ativa</div>';
    return;
  }
  el.innerHTML = ues.map((u) => `
    <div class="item">
      <div>
        <strong>${u.imsi || 'UE sem IMSI no namespace'}</strong>
        <small>${u.namespace || 'host'} · ${u.iface}</small>
      </div>
      <div class="mono">${u.ip || '—'}</div>
    </div>
  `).join('');
}

function renderSims(sims) {
  const body = $('#sim-table');
  if (!sims.length) {
    body.innerHTML = `<tr><td colspan="5">Nenhum SIM no banco. Cadastre em ${WEBUI}</td></tr>`;
    return;
  }
  body.innerHTML = sims.map((s) => `
    <tr>
      <td class="mono">${s.imsi}</td>
      <td>${s.apn || 'internet'}</td>
      <td class="mono">${s.staticIp || '—'}</td>
      <td class="mono">${s.liveIp || '—'}</td>
      <td><span class="badge ${s.connected ? 'on' : 'off'}">${s.connected ? 'conectado' : 'offline'}</span></td>
    </tr>
  `).join('');
}

function fillForm(form, data) {
  if (!data) return;
  for (const [key, value] of Object.entries(data)) {
    const input = form.elements.namedItem(key);
    if (!input || input.type === 'checkbox') continue;
    if (key === 'dns' && Array.isArray(value)) input.value = value.join(', ');
    else input.value = value ?? '';
  }
}

async function refreshOverview() {
  const data = await api('/api/overview');
  $('#clock').textContent = new Date(data.ts).toLocaleString('pt-BR');
  $('#ogstun-ip').textContent = data.ogstun?.address || 'offline';
  $('#ogstun-note').textContent = data.ogstun?.up ? 'ogstun ativo' : 'ogstun ausente';
  $('#ue-count').textContent = String(data.ues?.length || 0);
  $('#sim-count').textContent = String(data.sims?.length || 0);
  const active = (data.services || []).filter((s) => s.active).length;
  $('#svc-count').textContent = `${active}/${(data.services || []).length}`;

  setPill('#pill-core', data.coreOnline ? 'on' : 'off', data.coreOnline ? 'Core online' : 'Core offline');
  setPill('#pill-gnb', data.gnb?.running ? 'on' : 'off', data.gnb?.running ? 'gNB ligada' : 'gNB parada');
  setPill('#pill-ue', (data.ues?.length || 0) > 0 ? 'on' : (data.ueProc?.running ? 'warn' : 'off'),
    (data.ues?.length || 0) > 0 ? `${data.ues.length} UE(s)` : (data.ueProc?.running ? 'UE sem IP' : 'Sem UE'));

  chip($('#core-chip'), data.coreOnline, 'online', 'offline');
  chip($('#gnb-chip'), !!data.gnb?.running, 'running', 'stopped');
  chip($('#ue-chip'), !!data.ueProc?.running, `${data.ueProc?.count || 0} proc`, 'stopped');

  renderServices(data.services || []);
  renderUes('#live-ues', data.ues || []);
  renderUes('#ran-ues', data.ues || []);
  renderSims(data.sims || []);
  simCache = data.sims || [];
  renderTestSims();

  if (data.gnb?.logTail?.length) {
    $('#log-gnb').textContent = data.gnb.logTail.join('\n');
  }
}

async function refreshLogs() {
  try {
    const [gnb, ue] = await Promise.all([
      fetch('/api/logs/gnb').then((r) => r.text()),
      fetch('/api/logs/ue').then((r) => r.text()),
    ]);
    if (gnb.trim()) $('#log-gnb').textContent = gnb.trim();
    if (ue.trim()) $('#log-ue').textContent = ue.trim();
  } catch {}
}

async function refreshConfig() {
  const cfg = await api('/api/config');
  fillForm($('#form-gnb'), cfg.gnb);
  fillForm($('#form-amf'), cfg.amf);
  fillForm($('#form-smf'), { ...cfg.smf, dns: (cfg.smf.dns || []).join(', ') });
  fillForm($('#form-upf'), cfg.upf);
}

function bindTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $$('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

function formPayload(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  if ('restart' in data) data.restart = true;
  else if (form.querySelector('[name=restart]')) data.restart = false;
  if (data.dns) data.dns = data.dns.split(',').map((s) => s.trim()).filter(Boolean);
  ['amfPort', 'sbiPort', 'tac'].forEach((k) => {
    if (data[k] !== undefined && data[k] !== '') data[k] = Number(data[k]);
  });
  return data;
}

function bindForms() {
  const map = {
    'form-gnb': 'gnb',
    'form-amf': 'amf',
    'form-smf': 'smf',
    'form-upf': 'upf',
  };
  Object.entries(map).forEach(([id, target]) => {
    $(`#${id}`).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        await api(`/api/config/${target}`, {
          method: 'PUT',
          body: JSON.stringify(formPayload(ev.target)),
        });
        toast(`${target.toUpperCase()} salvo`);
        await refreshOverview();
        await refreshConfig();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

function bindActions() {
  $$('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const r = await api(`/api/actions/${btn.dataset.action}`, { method: 'POST', body: '{}' });
        toast(r.message || `Ação ${btn.dataset.action} ok`);
        setTimeout(async () => {
          await refreshOverview();
          await refreshLogs();
        }, 1200);
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $('#btn-refresh').addEventListener('click', async () => {
    await refreshOverview();
    await refreshLogs();
    await refreshConfig();
    toast('Atualizado');
  });
}

let simCache = [];
let testList = [];
let selectedTestId = null;
let selectedSnapshot = '';
let testSimSignature = '';

function internetSims() {
  return simCache.filter((s) => (s.apn || '') === 'internet');
}

function fmtMbps(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return `${Number(v).toFixed(1)} Mb/s`;
}

function fmtMs(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return `${Number(v).toFixed(1)} ms`;
}

function selectedImsis() {
  return [...document.querySelectorAll('[data-sim-pick]')].map((el) => el.value).filter(Boolean);
}

function renderTestSims() {
  const sims = internetSims();
  const countEl = $('#test-ue-count');
  if (!countEl) return;
  const signature = sims.map((s) => s.imsi).join(',');
  const countChanged = countEl.options.length !== sims.length;
  if (signature !== testSimSignature || countChanged) {
    testSimSignature = signature;
    const prev = countEl.value;
    countEl.innerHTML = sims.map((_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
    countEl.value = prev && Number(prev) <= sims.length ? prev : '1';
  }
  const n = Number(countEl.value || 1);
  const box = $('#test-sim-picks');
  const current = [...box.querySelectorAll('[data-sim-pick]')].map((el) => el.value);
  box.innerHTML = Array.from({ length: n }, (_, i) => {
    const chosen = current[i] || sims[i]?.imsi || '';
    const options = sims.map((s) => `<option value="${s.imsi}" ${s.imsi === chosen ? 'selected' : ''}>${s.imsi}</option>`).join('');
    return `<label>UE ${i + 1}<select data-sim-pick>${options}</select></label>`;
  }).join('');
}

function drawChart(canvas, series, unit) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#070b14';
  ctx.fillRect(0, 0, width, height);
  const pad = { l: 54, r: 16, t: 16, b: 28 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const colors = ['#8bb4ff', '#4c7dff', '#f0b429', '#7dffa6'];
  const all = series.flatMap((s) => s.points);
  const maxY = Math.max(1, ...all.map((p) => p.y));
  const maxX = Math.max(1, ...all.map((p) => p.t));
  ctx.strokeStyle = 'rgba(150,190,255,0.18)';
  ctx.lineWidth = 1;
  ctx.font = '12px IBM Plex Mono, monospace';
  ctx.fillStyle = '#8fa3c7';
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.t + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(width - pad.r, y);
    ctx.stroke();
    const value = maxY * (1 - i / 4);
    ctx.fillText(value.toFixed(unit === 'ms' ? 0 : 1), 6, y + 4);
  }
  ctx.fillText(unit, 6, 14);
  ctx.fillText(`${maxX.toFixed(0)}s`, width - pad.r - 28, height - 8);
  series.forEach((s, idx) => {
    if (!s.points.length) return;
    ctx.beginPath();
    ctx.strokeStyle = colors[idx % colors.length];
    ctx.lineWidth = 2;
    s.points.forEach((p, i) => {
      const x = pad.l + (p.t / maxX) * plotW;
      const y = pad.t + (1 - p.y / maxY) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
  series.forEach((s, idx) => {
    ctx.fillStyle = colors[idx % colors.length];
    ctx.fillText(s.name, pad.l + idx * 160, height - 8);
  });
}

function showTestDetail(test) {
  const box = $('#test-detail');
  if (!test) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const when = new Date(test.startedAt).toLocaleString('pt-BR');
  $('#test-detail-title').textContent = test.kind === 'latency' ? 'Latência' : 'Throughput';
  $('#test-detail-meta').textContent = `${when} · ${test.seconds}s · ${test.message || test.status}`;
  const ues = test.ues || [];
  drawChart($('#chart-up'), ues.map((u) => ({
    name: u.imsi.slice(-4),
    points: (u.upload || []).map((p) => ({ t: p.t, y: p.mbps })),
  })), 'Mb/s');
  drawChart($('#chart-down'), ues.map((u) => ({
    name: u.imsi.slice(-4),
    points: (u.download || []).map((p) => ({ t: p.t, y: p.mbps })),
  })), 'Mb/s');
  drawChart($('#chart-rtt'), ues.map((u) => ({
    name: u.imsi.slice(-4),
    points: (u.latency || []).map((p) => ({ t: p.t, y: p.ms })),
  })), 'ms');
  const logs = [];
  if (test.error) logs.push(test.error);
  if (test.logs?.gnb) logs.push(`--- gNB ---\n${test.logs.gnb}`);
  for (const [imsi, text] of Object.entries(test.logs?.ues || {})) {
    if (text) logs.push(`--- UE ${imsi} ---\n${text}`);
  }
  $('#test-logs').textContent = logs.join('\n\n') || 'Sem logs.';
}

function renderTestList() {
  const el = $('#test-list');
  if (!testList.length) {
    el.innerHTML = '<div class="empty">Nenhum teste executado</div>';
    return;
  }
  el.innerHTML = testList.map((t) => {
    const ups = (t.ues || []).map((u) => u.uploadMbps).filter((v) => v != null);
    const downs = (t.ues || []).map((u) => u.downloadMbps).filter((v) => v != null);
    const rtts = (t.ues || []).map((u) => u.latencyMs).filter((v) => v != null);
    const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    const label = t.kind === 'latency' ? 'Latência' : 'Throughput';
    return `<button class="item test-item ${t.id === selectedTestId ? 'active' : ''}" type="button" data-test-id="${t.id}">
      <div>
        <strong>${label} · ${(t.imsis || []).length} UE</strong>
        <small>${new Date(t.startedAt).toLocaleString('pt-BR')} · ${t.status}</small>
      </div>
      <div class="mono">${t.kind === 'latency' ? fmtMs(mean(rtts)) : `${fmtMbps(mean(ups))} / ${fmtMbps(mean(downs))}`}</div>
    </button>`;
  }).join('');
  el.querySelectorAll('[data-test-id]').forEach((btn) => {
    btn.addEventListener('click', () => openTest(btn.dataset.testId));
  });
}

async function openTest(id) {
  selectedTestId = id;
  const summary = testList.find((t) => t.id === id);
  selectedSnapshot = summary ? `${summary.status}|${summary.message}|${summary.finishedAt}` : '';
  renderTestList();
  const test = await api(`/api/tests/${id}`);
  showTestDetail(test);
}

async function refreshTests() {
  if (!$('#test-list')) return;
  const data = await api('/api/tests');
  testList = data.tests || [];
  const running = testList.find((t) => t.status === 'running');
  $('#test-live').textContent = running ? `${running.message || 'Executando'} (${running.phase || ''})` : 'Nenhum teste em andamento.';
  $('#btn-run-test').disabled = Boolean(running);
  $('#btn-latency').disabled = Boolean(running);
  renderTestList();
  if (!selectedTestId && testList[0]) {
    await openTest(testList[0].id);
    return;
  }
  const selected = testList.find((t) => t.id === selectedTestId);
  const snap = selected ? `${selected.status}|${selected.message}|${selected.finishedAt}` : '';
  if (selected && (selected.status === 'running' || snap !== selectedSnapshot)) {
    await openTest(selected.id);
  }
}

function bindTests() {
  const minutes = $('#test-minutes');
  const label = $('#test-minutes-label');
  const syncLabel = () => {
    const n = Number(minutes.value);
    label.textContent = n === 1 ? '1 minuto' : `${n} minutos`;
  };
  minutes.addEventListener('input', syncLabel);
  syncLabel();
  $('#test-ue-count').addEventListener('change', () => {
    testSimSignature = '';
    renderTestSims();
  });
  $('#btn-run-test').addEventListener('click', async () => {
    try {
      const imsis = selectedImsis();
      if (new Set(imsis).size !== imsis.length) throw new Error('Cada UE precisa de um SIM diferente');
      const created = await api('/api/tests', {
        method: 'POST',
        body: JSON.stringify({ imsis, minutes: Number(minutes.value) }),
      });
      selectedTestId = created.id;
      toast('Teste iniciado');
      await refreshTests();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#btn-latency').addEventListener('click', async () => {
    try {
      const imsis = selectedImsis();
      if (new Set(imsis).size !== imsis.length) throw new Error('Cada UE precisa de um SIM diferente');
      const created = await api('/api/tests/latency', {
        method: 'POST',
        body: JSON.stringify({ imsis }),
      });
      selectedTestId = created.id;
      toast('Medindo latência');
      await refreshTests();
    } catch (err) {
      toast(err.message, true);
    }
  });
  renderTestSims();
}

async function boot() {
  pointWebuiLinks();
  bindTabs();
  bindForms();
  bindActions();
  bindTests();
  await refreshOverview();
  await refreshConfig();
  await refreshLogs();
  await refreshTests();
  setInterval(async () => {
    try {
      await refreshOverview();
      await refreshLogs();
      await refreshTests();
    } catch {}
  }, 5000);
}

boot().catch((err) => toast(err.message, true));
