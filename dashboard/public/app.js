const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

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
    body.innerHTML = '<tr><td colspan="5">Nenhum SIM no banco. Cadastre em http://localhost:9999</td></tr>';
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

async function boot() {
  bindTabs();
  bindForms();
  bindActions();
  await refreshOverview();
  await refreshConfig();
  await refreshLogs();
  setInterval(async () => {
    try {
      await refreshOverview();
      await refreshLogs();
    } catch {}
  }, 5000);
}

boot().catch((err) => toast(err.message, true));
