/* ColdChain Monitor: single-page UI (vanilla JS, no build step). All dynamic text goes through esc(). */
'use strict';

const S = {
  token: sessionStorage.getItem('cc_token'),
  user: JSON.parse(sessionStorage.getItem('cc_user') || 'null'),
  sites: [],
  devices: [],
  route: 'dashboard',
  filters: { devices: { q: '', site: '', status: '', class: '', sort: 'name' }, alerts: { status: '', severity: '', site: '', type: '' } },
  detail: null, // { id, range }
  es: null,
};

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isAdmin = () => S.user && S.user.role === 'admin';
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const LABELS = {
  status: { normal: 'In range', excursion: 'Excursion', offline: 'Offline', unknown: 'No data' },
  type: { cold_room: 'Cold room', fridge: 'Refrigerator', freezer: 'Freezer', ultra_freezer: 'Ultra-low freezer' },
  cls: { vaccine: 'Vaccine', blood: 'Blood / plasma', insulin: 'Insulin', medicine: 'Medicine' },
  siteType: { warehouse: 'Warehouse', hospital: 'Hospital', clinic: 'Clinic', pharmacy: 'Pharmacy' },
  alert: { TEMP_HIGH: 'Temperature high', TEMP_LOW: 'Temperature low', HUMIDITY_HIGH: 'Humidity high', DOOR_OPEN: 'Door open', BATTERY_LOW: 'Battery low', OFFLINE: 'Device offline' },
  astatus: { open: 'Open', acknowledged: 'Acknowledged', resolved: 'Resolved' },
};
const PRESETS = { cold_room: [2, 8], fridge: [2, 8], freezer: [-35, -15], ultra_freezer: [-90, -60] };

// ---------- helpers ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token && path !== '/auth/login') { signOut(true); throw new Error('Session expired'); }
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.details = data.details; throw e; }
  return data;
}
const errHtml = (e) => `<div class="errs">${esc(e.message)}${e.details && e.details.length ? `<ul>${e.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}</div>`;

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}
const fmtTime = (ts) => new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const deg = (v) => (v === null || v === undefined ? '--' : `${v.toFixed(1)}°C`);
const siteName = (id) => (S.sites.find((s) => s.id === id) || {}).name || id;

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function openModal(html, narrow = false) {
  const m = $('#modal');
  $('.modal', m).className = 'modal' + (narrow ? ' narrow' : '');
  $('.modal', m).innerHTML = html;
  m.hidden = false;
}
function closeModal() { $('#modal').hidden = true; S.detail = null; }

// ---------- auth ----------
function showLogin() { $('#app').hidden = true; $('#login').hidden = false; if (S.es) { S.es.close(); S.es = null; } }
function signOut(expired) {
  if (S.token && !expired) fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + S.token } }).catch(() => {});
  S.token = null; S.user = null; sessionStorage.clear();
  showLogin();
  if (expired) $('#login-err').innerHTML = '<div class="errs">Your session expired. Please sign in again.</div>';
}

async function boot() {
  if (!S.token) return showLogin();
  $('#login').hidden = true; $('#app').hidden = false;
  $('#user').textContent = `${S.user.username} (${S.user.role})`;
  try { S.sites = await api('/sites'); } catch { return; }
  connectLive();
  route();
}

// ---------- routing ----------
const VIEWS = { dashboard: viewDashboard, devices: viewDevices, alerts: viewAlerts, analytics: viewAnalytics, sites: viewSites };
async function route() {
  S.route = (location.hash.replace('#/', '') || 'dashboard').split('?')[0];
  if (!VIEWS[S.route]) S.route = 'dashboard';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === S.route));
  const view = $('#view');
  try { await VIEWS[S.route](view); } catch (e) { if (S.token) view.innerHTML = errHtml(e); }
  refreshBadge();
}
window.addEventListener('hashchange', () => { closeModal(); route(); });

async function refreshBadge() {
  try {
    const s = await api('/summary');
    const b = $('#alert-badge');
    b.hidden = !s.openAlerts; b.textContent = s.openAlerts;
  } catch { /* ignore */ }
}

// ---------- dashboard ----------
function kpiHtml(s) {
  const k = (n, l, c = '') => `<div class="card kpi ${c}"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  return k(s.devices, 'Devices') + k(s.byStatus.normal, 'In range', 'ok') + k(s.byStatus.excursion, 'In excursion', s.byStatus.excursion ? 'crit' : '')
    + k(s.byStatus.offline, 'Offline', s.byStatus.offline ? 'off' : '') + k(s.openAlerts, 'Open alerts', s.openAlerts ? 'warn' : '') + k(s.reportingToday, 'Reporting today');
}

function devCard(d) {
  const low = d.battery !== null && d.battery < 20;
  return `<article class="card dev ${d.status}" data-action="open-device" data-id="${esc(d.id)}" data-dev="${esc(d.id)}" tabindex="0">
    <div class="row"><div><div class="name">${esc(d.name)}</div><div class="site">${esc(siteName(d.siteId))}</div></div>
      <span class="pill ${d.status}">${LABELS.status[d.status]}</span></div>
    <div class="t">${deg(d.lastTemp)}</div>
    <div class="range">Safe range ${d.minTemp}° to ${d.maxTemp}°C · ${LABELS.cls[d.productClass]}</div>
    <div class="meta"><span class="bat ${low ? 'low' : ''}" title="Battery"><b><i style="width:${Math.round((d.battery ?? 0) * 0.01 * 100)}%"></i></b>${d.battery ?? '--'}%</span>
      <span class="seen" data-ts="${d.lastSeen || ''}">${d.door ? 'Door open · ' : ''}${ago(d.lastSeen)}</span></div>
  </article>`;
}

function alertItem(a) {
  return `<li><div class="h"><b>${esc(a.deviceName)}</b><span class="pill ${a.severity}">${a.severity}</span></div>
    <div class="m">${esc(a.message)}</div><div class="w">${fmtTime(a.createdAt)} · ${LABELS.astatus[a.status]}</div></li>`;
}

async function viewDashboard(view) {
  const [sum, devs, open] = await Promise.all([api('/summary'), api('/devices?sort=status'), api('/alerts?status=open&limit=6')]);
  S.devices = devs;
  view.innerHTML = `
    <div class="page-head"><div><h1>Live dashboard</h1><p>Every storage unit, updated in real time.</p></div></div>
    <div class="grid kpis" id="kpis">${kpiHtml(sum)}</div>
    <div class="cols">
      <div class="grid devs" id="devgrid">${devs.map(devCard).join('') || '<div class="empty card">No devices yet.</div>'}</div>
      <aside class="card"><div style="padding:16px 16px 6px"><h2>Open alerts</h2><p class="src">SINTER idx:alert:status:open …</p></div>
        <ul class="alist" id="openalerts">${open.map(alertItem).join('') || '<li class="empty">All clear. No open alerts.</li>'}</ul></aside>
    </div>`;
}

// ---------- devices ----------
function devRow(d) {
  return `<tr class="click" data-action="open-device" data-id="${esc(d.id)}">
    <td><b>${esc(d.name)}</b><div class="muted mono">${esc(d.id)}</div></td><td>${esc(siteName(d.siteId))}</td>
    <td>${LABELS.type[d.type]}<div class="muted">${LABELS.cls[d.productClass]}</div></td>
    <td><b>${deg(d.lastTemp)}</b><div class="muted">${d.minTemp}° to ${d.maxTemp}°C</div></td>
    <td><span class="pill ${d.status}">${LABELS.status[d.status]}</span></td>
    <td>${d.battery ?? '--'}%</td><td>${ago(d.lastSeen)}</td></tr>`;
}

const options = (list, sel, all) => (all ? `<option value="">${all}</option>` : '') + list.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
const siteOpts = (sel, all) => options(S.sites.map((s) => [s.id, s.name]), sel, all);

async function loadDeviceTable() {
  const f = S.filters.devices;
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const list = await api('/devices?' + qs);
  $('#dev-results').innerHTML = list.length
    ? `<table><thead><tr><th>Device</th><th>Site</th><th>Type</th><th>Temperature</th><th>Status</th><th>Battery</th><th>Last seen</th></tr></thead><tbody>${list.map(devRow).join('')}</tbody></table>`
    : '<div class="empty">No devices match these filters.</div>';
}

async function viewDevices(view) {
  const f = S.filters.devices;
  view.innerHTML = `
    <div class="page-head"><div><h1>Devices</h1><p>Search and filter your sensors. Filters combine with a Redis set intersection.</p></div>
      ${isAdmin() ? '<button class="btn primary" data-action="new-device">+ Add device</button>' : ''}</div>
    <div class="filters">
      <input type="search" placeholder="Search by name or ID…" data-filter="devices.q" value="${esc(f.q)}" aria-label="Search devices">
      <select data-filter="devices.site" aria-label="Site">${siteOpts(f.site, 'All sites')}</select>
      <select data-filter="devices.status" aria-label="Status">${options(Object.entries(LABELS.status), f.status, 'Any status')}</select>
      <select data-filter="devices.class" aria-label="Product">${options(Object.entries(LABELS.cls), f.class, 'Any product')}</select>
      <select data-filter="devices.sort" aria-label="Sort">${options([['name', 'Sort: name'], ['status', 'Sort: status'], ['temp', 'Sort: temperature'], ['battery', 'Sort: battery'], ['lastSeen', 'Sort: last seen']], f.sort)}</select>
    </div>
    <div class="card tablewrap" id="dev-results"></div>`;
  await loadDeviceTable();
}

// ---------- alerts ----------
function alertRow(a) {
  const act = isAdmin() && a.status !== 'resolved'
    ? `<div class="actions">${a.status === 'open' ? `<button class="btn sm" data-action="ack" data-id="${a.id}">Acknowledge</button>` : ''}<button class="btn sm" data-action="resolve" data-id="${a.id}">Resolve</button></div>` : '';
  const by = a.status === 'acknowledged' ? ` by ${esc(a.ackBy)}` : a.status === 'resolved' ? ` by ${esc(a.resolvedBy)}` : '';
  return `<tr><td>${fmtTime(a.createdAt)}</td><td><span class="pill ${a.severity}">${a.severity}</span></td>
    <td><b>${esc(a.deviceName)}</b><div class="muted">${esc(siteName(a.siteId))}</div></td>
    <td>${esc(a.message)}<div class="muted">${LABELS.alert[a.type]}</div></td>
    <td><span class="pill ${a.status}">${LABELS.astatus[a.status]}</span><div class="muted">${esc(by.trim())}</div></td><td>${act}</td></tr>`;
}

async function loadAlertTable() {
  const qs = new URLSearchParams(Object.entries(S.filters.alerts).filter(([, v]) => v));
  qs.set('limit', '100');
  const list = await api('/alerts?' + qs);
  $('#alert-results').innerHTML = list.length
    ? `<table><thead><tr><th>Raised</th><th>Severity</th><th>Device</th><th>Details</th><th>Status</th><th></th></tr></thead><tbody>${list.map(alertRow).join('')}</tbody></table>`
    : '<div class="empty">No alerts match these filters.</div>';
}

async function viewAlerts(view) {
  const f = S.filters.alerts;
  view.innerHTML = `
    <div class="page-head"><div><h1>Alerts</h1><p>Open → Acknowledged → Resolved. Alerts resolve themselves when a sensor recovers.</p></div></div>
    <div class="filters">
      <select data-filter="alerts.status" aria-label="Status">${options(Object.entries(LABELS.astatus), f.status, 'Any status')}</select>
      <select data-filter="alerts.severity" aria-label="Severity">${options([['critical', 'Critical'], ['warning', 'Warning']], f.severity, 'Any severity')}</select>
      <select data-filter="alerts.site" aria-label="Site">${siteOpts(f.site, 'All sites')}</select>
      <select data-filter="alerts.type" aria-label="Type">${options(Object.entries(LABELS.alert), f.type, 'Any type')}</select>
    </div>
    <div class="card tablewrap" id="alert-results"></div>`;
  await loadAlertTable();
}

// ---------- analytics ----------
function barRows(rows, max, cls = '') {
  return `<div class="bars">${rows.map((r) => `<div class="brow"><span>${esc(r.label)}</span><div class="track"><div class="fill ${r.cls || cls}" style="width:${max ? Math.max(2, (r.value / max) * 100) : 0}%"></div></div><span class="v">${esc(r.text ?? r.value)}</span></div>`).join('')}</div>`;
}

function dayChart(days) {
  const W = 520, H = 190, L = 28, B = 26, T = 10;
  const max = Math.max(1, ...days.map((d) => d.count));
  const bw = (W - L) / days.length;
  const bars = days.map((d, i) => {
    const h = ((H - T - B) * d.count) / max;
    const x = L + i * bw + bw * 0.2;
    return `<rect x="${x}" y="${H - B - h}" width="${bw * 0.6}" height="${h}" rx="4" fill="#0f766e"><title>${d.count} alerts</title></rect>
      <text x="${x + bw * 0.3}" y="${H - 8}" text-anchor="middle">${new Date(d.from + 43200e3).toLocaleDateString([], { weekday: 'short' })}</text>
      <text x="${x + bw * 0.3}" y="${H - B - h - 4}" text-anchor="middle">${d.count}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Alerts per day">${bars}<line x1="${L}" x2="${W}" y1="${H - B}" y2="${H - B}" stroke="#d5dde3"/></svg>`;
}

async function viewAnalytics(view) {
  const a = await api('/analytics');
  const maxScore = Math.max(1, ...a.leaderboard.map((l) => l.score));
  const maxType = Math.max(1, ...a.alertsByType.map((t) => t.count));
  const maxSite = Math.max(1, ...a.alertsBySite.map((s) => s.count));
  view.innerHTML = `
    <div class="page-head"><div><h1>Analytics</h1><p>Compliance and risk, computed from Redis time-series, sets and counters.</p></div></div>
    <div class="grid two">
      <section class="card pad"><h2>Alerts per day (last 7 days)</h2><p class="src">ZCOUNT alerts:time &lt;from&gt; &lt;to&gt;</p>${dayChart(a.alertsByDay)}</section>
      <section class="card pad"><h2>Highest-risk devices</h2><p class="src">ZREVRANGE risk:board 0 4 WITHSCORES</p>
        ${a.leaderboard.length ? barRows(a.leaderboard.map((l) => ({ label: l.name, value: l.score, text: l.score })), maxScore, 'red') : '<div class="empty">No alerts yet.</div>'}
        <p class="hint">Risk score = 1 per warning + 3 per critical alert.</p></section>
      <section class="card pad"><h2>Alerts by type</h2><p class="src">HGETALL stats:alert:type</p>
        ${barRows(a.alertsByType.map((t) => ({ label: LABELS.alert[t.type] || t.type, value: t.count })), maxType, 'amber') || ''}</section>
      <section class="card pad"><h2>Alerts by site</h2><p class="src">SCARD idx:alert:site:&lt;site&gt;</p>
        ${barRows(a.alertsBySite.map((s) => ({ label: s.name, value: s.count })), maxSite)}</section>
    </div>
    <section class="card" style="margin-top:16px"><div style="padding:18px 18px 4px"><h2>Temperature compliance, last 24 hours</h2>
      <p class="src">ZRANGEBYSCORE ts:temp:&lt;device&gt; now-24h now → compliance % and Mean Kinetic Temperature (MKT)</p></div>
      <div class="tablewrap"><table><thead><tr><th>Device</th><th>Site</th><th>Readings</th><th>Time in range</th><th>MKT</th><th>Excursions</th><th>Status</th></tr></thead><tbody>
      ${a.perDevice.map((d) => `<tr class="click" data-action="open-device" data-id="${esc(d.id)}"><td><b>${esc(d.name)}</b></td><td>${esc(siteName(d.siteId))}</td><td>${d.readings}</td>
        <td><div class="bars" style="min-width:160px"><div class="brow" style="grid-template-columns:1fr 50px;margin:0"><div class="track"><div class="fill ${d.compliance >= 99 ? 'green' : d.compliance >= 95 ? 'amber' : 'red'}" style="width:${d.compliance ?? 0}%"></div></div><span class="v">${d.compliance ?? '--'}%</span></div></div></td>
        <td>${d.mkt === null ? '--' : d.mkt + '°C'}</td><td>${d.excursions}</td><td><span class="pill ${d.status}">${LABELS.status[d.status]}</span></td></tr>`).join('')}
      </tbody></table></div></section>`;
}

// ---------- sites ----------
async function viewSites(view) {
  S.sites = await api('/sites');
  view.innerHTML = `
    <div class="page-head"><div><h1>Sites</h1><p>Facilities that hold your cold-storage devices.</p></div>
      ${isAdmin() ? '<button class="btn primary" data-action="new-site">+ Add site</button>' : ''}</div>
    <div class="card tablewrap">${S.sites.length ? `<table><thead><tr><th>Name</th><th>City</th><th>Type</th><th>Devices</th><th></th></tr></thead><tbody>
      ${S.sites.map((s) => `<tr><td><b>${esc(s.name)}</b><div class="muted mono">${esc(s.id)}</div></td><td>${esc(s.city)}</td><td>${LABELS.siteType[s.type]}</td><td>${s.deviceCount}</td>
        <td>${isAdmin() ? `<div class="actions"><button class="btn sm danger" data-action="delete-site" data-id="${esc(s.id)}">Delete</button></div>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No sites yet.</div>'}</div>`;
}

// ---------- device detail ----------
function lineChart(h) {
  if (!h.points.length) return '<div class="empty">No readings in this range.</div>';
  const W = 720, H = 270, L = 46, R = 12, T = 12, B = 28;
  const { minTemp: lo, maxTemp: hi } = h.device;
  let ymin = Math.min(lo, ...h.points.map((p) => p.min));
  let ymax = Math.max(hi, ...h.points.map((p) => p.max));
  const pad = (ymax - ymin) * 0.12 || 1; ymin -= pad; ymax += pad;
  const x = (t) => L + ((t - h.from) / (h.to - h.from)) * (W - L - R);
  const y = (v) => T + (1 - (v - ymin) / (ymax - ymin)) * (H - T - B);
  const top = h.points.map((p) => `${x(p.t).toFixed(1)},${y(p.max).toFixed(1)}`);
  const bot = h.points.slice().reverse().map((p) => `${x(p.t).toFixed(1)},${y(p.min).toFixed(1)}`);
  const avg = h.points.map((p) => `${x(p.t).toFixed(1)},${y(p.avg).toFixed(1)}`).join(' ');
  const bad = h.points.filter((p) => p.max > hi || p.min < lo);
  const yt = Array.from({ length: 5 }, (_, i) => ymin + ((ymax - ymin) * i) / 4);
  const xt = Array.from({ length: 5 }, (_, i) => h.from + ((h.to - h.from) * i) / 4);
  const long = h.to - h.from > 26 * 3600e3;
  const xl = (t) => (long ? new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' }) : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Temperature history">
    <rect x="${L}" y="${y(hi)}" width="${W - L - R}" height="${y(lo) - y(hi)}" fill="#e4f4ec"/>
    ${yt.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#eef1f4"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(0)}°</text>`).join('')}
    ${xt.map((t, i) => `<text x="${x(t)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}">${xl(t)}</text>`).join('')}
    <line x1="${L}" x2="${W - R}" y1="${y(hi)}" y2="${y(hi)}" stroke="#2a9d6f" stroke-dasharray="4 3"/><line x1="${L}" x2="${W - R}" y1="${y(lo)}" y2="${y(lo)}" stroke="#2a9d6f" stroke-dasharray="4 3"/>
    <polygon points="${top.concat(bot).join(' ')}" fill="#0f766e" opacity=".15"/>
    <polyline points="${avg}" fill="none" stroke="#0f766e" stroke-width="2" stroke-linejoin="round"/>
    ${bad.map((p) => `<circle cx="${x(p.t)}" cy="${y(p.max > hi ? p.max : p.min)}" r="3.5" fill="#b8322a"><title>${fmtTime(p.t)}: ${p.min} to ${p.max}°C</title></circle>`).join('')}
  </svg>`;
}

async function renderDetail() {
  const { id, range } = S.detail;
  const [d, h, al, last] = await Promise.all([
    api('/devices/' + id), api(`/devices/${id}/history?range=${range}`), api(`/alerts?device=${id}&limit=5`), api(`/devices/${id}/latest?count=5`),
  ]);
  if (!S.detail || S.detail.id !== id) return;
  const st = h.stats;
  const stat = (b, s) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`;
  openModal(`
    <div class="modal-head"><div><h2 style="font-size:19px">${esc(d.name)}</h2>
      <div class="muted">${esc(siteName(d.siteId))} · ${LABELS.type[d.type]} · ${LABELS.cls[d.productClass]} · <span class="mono">${esc(d.id)}</span></div></div>
      <div><span class="pill ${d.status}">${LABELS.status[d.status]}</span> <button class="btn sm" data-action="close-modal" aria-label="Close">✕</button></div></div>
    <div class="rangebar">${['1h', '6h', '24h', '72h', '7d'].map((r) => `<button class="btn sm ${r === range ? 'on' : ''}" data-action="range" data-range="${r}">${r}</button>`).join('')}</div>
    <p class="src">ZRANGEBYSCORE ts:temp:${esc(d.id)} · shaded band = safe range ${d.minTemp}° to ${d.maxTemp}°C · red dots = excursions</p>
    ${lineChart(h)}
    ${st.count ? `<div class="stats">${stat(deg(st.min), 'Minimum')}${stat(deg(st.avg), 'Average')}${stat(deg(st.max), 'Maximum')}${stat(deg(st.mkt), 'Mean kinetic temp.')}${stat(st.compliance + '%', 'Time in range')}${stat(st.excursions, 'Excursions')}</div>` : ''}
    <div class="grid two" style="margin-top:16px">
      <div><h3>Latest readings <span class="src">(XREVRANGE telemetry:${esc(d.id)})</span></h3>
        <table><tbody>${last.map((r) => `<tr><td>${new Date(r.ts).toLocaleTimeString()}</td><td><b>${r.temp.toFixed(1)}°C</b></td><td>${r.hum}% RH</td><td>${r.door ? 'Door open' : ''}</td></tr>`).join('') || '<tr><td class="muted">No readings</td></tr>'}</tbody></table></div>
      <div><h3>Recent alerts</h3><ul class="alist">${al.map(alertItem).join('') || '<li class="muted">No alerts for this device.</li>'}</ul></div>
    </div>
    ${isAdmin() ? `<div class="formfoot" style="justify-content:space-between">
      <div>${d.simulated ? `<button class="btn sm" data-action="simulate" data-kind="door">Simulate door-open</button> <button class="btn sm" data-action="simulate" data-kind="power">Simulate power failure</button>` : '<span class="hint">Real sensor: sends data to POST /api/ingest/' + esc(d.id) + '</span>'}</div>
      <div><button class="btn" data-action="edit-device" data-id="${esc(d.id)}">Edit</button> <button class="btn danger" data-action="delete-device" data-id="${esc(d.id)}">Delete</button></div></div>` : ''}
  `);
}

// ---------- forms ----------
function deviceForm(d) {
  const e = !!d;
  const [mn, mx] = e ? [d.minTemp, d.maxTemp] : PRESETS.fridge;
  openModal(`
    <div class="modal-head"><h2 style="font-size:19px">${e ? 'Edit device' : 'Add device'}</h2><button class="btn sm" data-action="close-modal" aria-label="Close">✕</button></div>
    <form data-form="device" data-id="${e ? esc(d.id) : ''}">
      <div class="formgrid">
        <label class="full">Name<input name="name" value="${e ? esc(d.name) : ''}" required minlength="3" maxlength="60" placeholder="e.g. Vaccine Refrigerator V4"></label>
        ${e ? '' : '<label>Device ID (optional)<input name="id" maxlength="24" placeholder="auto-generated" pattern="[A-Za-z0-9][A-Za-z0-9\\-]{2,23}"></label>'}
        <label>Site<select name="siteId" required>${siteOpts(e ? d.siteId : '')}</select></label>
        <label>Equipment type<select name="type">${options(Object.entries(LABELS.type), e ? d.type : 'fridge')}</select></label>
        <label>Product stored<select name="productClass">${options(Object.entries(LABELS.cls), e ? d.productClass : 'vaccine')}</select></label>
        <label>Minimum safe temp (°C)<input name="minTemp" type="number" step="0.1" min="-100" max="40" value="${mn}" required></label>
        <label>Maximum safe temp (°C)<input name="maxTemp" type="number" step="0.1" min="-100" max="40" value="${mx}" required></label>
        <label>Max humidity (%)<input name="maxHum" type="number" min="1" max="100" value="${e ? d.maxHum : 80}" required></label>
        <label class="check full"><input type="checkbox" name="simulated" ${!e || d.simulated ? 'checked' : ''}> Driven by the built-in simulator (untick for a real sensor)</label>
      </div>
      <div class="errs" id="form-err"></div>
      <div class="formfoot"><button class="btn" type="button" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${e ? 'Save changes' : 'Create device'}</button></div>
    </form>`, true);
}

function siteForm() {
  openModal(`
    <div class="modal-head"><h2 style="font-size:19px">Add site</h2><button class="btn sm" data-action="close-modal" aria-label="Close">✕</button></div>
    <form data-form="site"><div class="formgrid">
      <label class="full">Name<input name="name" required minlength="3" maxlength="60" placeholder="e.g. District Medical Store"></label>
      <label>City<input name="city" required minlength="2" maxlength="40"></label>
      <label>Type<select name="type">${options(Object.entries(LABELS.siteType), 'warehouse')}</select></label></div>
      <div class="errs" id="form-err"></div>
      <div class="formfoot"><button class="btn" type="button" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Create site</button></div></form>`, true);
}

function keyModal(res) {
  openModal(`
    <div class="modal-head"><h2 style="font-size:19px">Device created</h2></div>
    <p><b>${esc(res.device.name)}</b> (<span class="mono">${esc(res.device.id)}</span>) is registered. Copy its API key now. It is shown only once and only a hash is stored.</p>
    <div class="keybox" id="keybox">${esc(res.apiKey)}</div>
    <p class="hint">A real sensor reports with:</p>
    <div class="keybox">curl -X POST ${esc(location.origin)}/api/ingest/${esc(res.device.id)} \\
  -H "Content-Type: application/json" -H "x-device-key: ${esc(res.apiKey)}" \\
  -d '{"temp":4.8,"hum":45,"battery":92,"door":false}'</div>
    <div class="formfoot"><button class="btn" data-action="copy-key">Copy key</button><button class="btn primary" data-action="close-modal">Done</button></div>`, true);
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  if (e.target.id === 'modal') return closeModal();
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;
  try {
    switch (action) {
      case 'logout': return signOut();
      case 'close-modal': return closeModal();
      case 'open-device': S.detail = { id, range: '24h' }; return await renderDetail();
      case 'range': S.detail.range = el.dataset.range; return await renderDetail();
      case 'new-device': return deviceForm(null);
      case 'edit-device': return deviceForm(await api('/devices/' + id));
      case 'new-site': return siteForm();
      case 'copy-key': await navigator.clipboard.writeText($('#keybox').textContent); return toast('API key copied');
      case 'simulate':
        await api(`/devices/${S.detail.id}/simulate`, { method: 'POST', body: { kind: el.dataset.kind } });
        return toast(el.dataset.kind === 'power' ? 'Power failure started. Watch the temperature climb.' : 'Door-open event started.', 'warn');
      case 'delete-device':
        if (!confirm('Delete this device and all of its readings and alerts?')) return;
        await api('/devices/' + id, { method: 'DELETE' }); closeModal(); toast('Device deleted'); return route();
      case 'delete-site':
        if (!confirm('Delete this site?')) return;
        await api('/sites/' + id, { method: 'DELETE' }); toast('Site deleted'); return route();
      case 'ack': await api(`/alerts/${id}/acknowledge`, { method: 'POST' }); toast('Alert acknowledged'); return route();
      case 'resolve': await api(`/alerts/${id}/resolve`, { method: 'POST' }); toast('Alert resolved'); return route();
    }
  } catch (err) { toast(err.message, 'crit'); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
  if (e.key === 'Enter' && e.target.matches && e.target.matches('.dev')) e.target.click();
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(form));
  const errBox = $('#form-err', form) || $('#login-err');
  errBox.innerHTML = '';
  try {
    if (form.dataset.form === 'login') {
      const res = await api('/auth/login', { method: 'POST', body: { username: fd.username, password: fd.password } });
      S.token = res.token; S.user = res.user;
      sessionStorage.setItem('cc_token', res.token); sessionStorage.setItem('cc_user', JSON.stringify(res.user));
      form.reset(); return boot();
    }
    if (form.dataset.form === 'site') {
      await api('/sites', { method: 'POST', body: fd }); closeModal(); toast('Site created'); return route();
    }
    if (form.dataset.form === 'device') {
      const body = {
        name: fd.name, siteId: fd.siteId, type: fd.type, productClass: fd.productClass,
        minTemp: Number(fd.minTemp), maxTemp: Number(fd.maxTemp), maxHum: Number(fd.maxHum), simulated: fd.simulated === 'on',
      };
      if (fd.id) body.id = fd.id;
      if (form.dataset.id) {
        await api('/devices/' + form.dataset.id, { method: 'PUT', body }); closeModal(); toast('Device updated'); return route();
      }
      const res = await api('/devices', { method: 'POST', body });
      route(); return keyModal(res);
    }
  } catch (err) { errBox.innerHTML = errHtml(err); }
});

// Changing equipment type pre-fills sensible temperature limits (create form only).
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('form[data-form=device][data-id=""] select[name=type]')) {
    const [mn, mx] = PRESETS[t.value];
    t.form.minTemp.value = mn; t.form.maxTemp.value = mx;
  }
  if (t.dataset && t.dataset.filter) applyFilter(t);
});
document.addEventListener('input', debounce((e) => { if (e.target.dataset && e.target.dataset.filter && e.target.type === 'search') applyFilter(e.target); }, 250));

function applyFilter(el) {
  const [group, key] = el.dataset.filter.split('.');
  S.filters[group][key] = el.value;
  (group === 'devices' ? loadDeviceTable() : loadAlertTable()).catch((err) => toast(err.message, 'crit'));
}

// ---------- live updates (Server-Sent Events fed by Redis Pub/Sub) ----------
function connectLive() {
  if (S.es) S.es.close();
  const es = new EventSource('/api/stream?token=' + encodeURIComponent(S.token));
  S.es = es;
  const dot = $('#live');
  es.onopen = () => dot.classList.add('on');
  es.onerror = () => dot.classList.remove('on');
  es.onmessage = (m) => {
    const { type, data } = JSON.parse(m.data);
    if (type === 'reading') onReading(data);
    else if (type === 'alert') {
      toast(`${data.deviceName}: ${data.message}`, data.severity === 'critical' ? 'crit' : 'warn');
      softRefresh();
    } else if (type === 'alert_update' || type === 'device_status') softRefresh();
  };
}

const softRefresh = debounce(() => {
  if (!['dashboard', 'alerts'].includes(S.route) || !$('#modal').hidden) return refreshBadge();
  route();
}, 700);

const refreshKpis = debounce(async () => {
  if (S.route !== 'dashboard') return;
  try { const s = await api('/summary'); if ($('#kpis')) $('#kpis').innerHTML = kpiHtml(s); } catch { /* ignore */ }
}, 800);

function onReading(r) {
  const d = S.devices.find((x) => x.id === r.id);
  if (!d) return;
  const changed = d.status !== r.status;
  Object.assign(d, { lastTemp: r.temp, lastHum: r.hum, battery: r.battery, door: r.door, lastSeen: r.ts, status: r.status });
  const card = $(`[data-dev="${CSS.escape(r.id)}"]`);
  if (card) card.outerHTML = devCard(d);
  if (changed) refreshKpis();
}

setInterval(() => document.querySelectorAll('.seen[data-ts]').forEach((el) => {
  const ts = Number(el.dataset.ts);
  if (ts) el.textContent = (el.textContent.startsWith('Door open') ? 'Door open · ' : '') + ago(ts);
}), 5000);

boot();
