// End-to-end API tests. Uses Redis db 15 (flushed first) so demo data in db 0 is never touched.
process.env.REDIS_DB = process.env.TEST_REDIS_DB || '15';
process.env.LOGIN_RATE_MAX = '1000';
process.env.SIMULATOR = 'off';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { redis } = require('../src/redis');
const { createApp } = require('../src/app');
const { ensureDefaultUsers } = require('../src/auth');
const events = require('../src/events');
const telemetry = require('../src/telemetry');

let server, base, admin, viewer, apiKey;
const J = { 'Content-Type': 'application/json' };

async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { ...J, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const login = async (u, p) => (await call('POST', '/auth/login', { body: { username: u, password: p } }));
const ingest = (body, key = apiKey) => call('POST', '/ingest/T-FRIDGE-1', { body, headers: { 'x-device-key': key } });

before(async () => {
  await redis.flushdb();
  await ensureDefaultUsers();
  await events.startHub();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await login('admin', 'Admin@123')).body.token;
  viewer = (await login('viewer', 'Viewer@123')).body.token;
});

after(async () => {
  await events.stopHub();
  server.close();
  await redis.flushdb();
  await redis.quit();
});

test('health check reports Redis is reachable', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.redis, true);
});

test('auth: bad credentials, validation and protected routes', async () => {
  assert.equal((await login('admin', 'wrong-password')).status, 401);
  assert.equal((await login('ab', 'x')).status, 400);
  assert.equal((await call('GET', '/devices')).status, 401);
  assert.equal((await call('GET', '/devices', { token: 'f'.repeat(48) })).status, 401);
  assert.equal((await call('GET', '/auth/me', { token: admin })).body.role, 'admin');
});

test('roles: viewer is read-only', async () => {
  assert.equal((await call('GET', '/sites', { token: viewer })).status, 200);
  const r = await call('POST', '/sites', { token: viewer, body: { name: 'Nope Site', city: 'X1', type: 'clinic' } });
  assert.equal(r.status, 403);
});

test('sites: create, validate, duplicate', async () => {
  assert.equal((await call('POST', '/sites', { token: admin, body: { name: 'A', city: '', type: 'bad' } })).status, 400);
  const ok = await call('POST', '/sites', { token: admin, body: { name: 'Test Depot', city: 'Hyderabad', type: 'warehouse' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.id, 'test-depot');
  assert.equal((await call('POST', '/sites', { token: admin, body: { name: 'Test Depot', city: 'Hyderabad', type: 'warehouse' } })).status, 409);
});

test('devices: validation, XSS characters rejected, create, duplicate id', async () => {
  const good = { id: 't-fridge-1', name: 'Test Fridge One', siteId: 'test-depot', type: 'fridge', productClass: 'vaccine', minTemp: 2, maxTemp: 8 };
  const bad = await call('POST', '/devices', { token: admin, body: { ...good, minTemp: 9 } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.details.some((d) => /minTemp/.test(d)));
  assert.equal((await call('POST', '/devices', { token: admin, body: { ...good, name: '<script>alert(1)</script>' } })).status, 400);
  assert.equal((await call('POST', '/devices', { token: admin, body: { ...good, siteId: 'ghost-site' } })).status, 400);

  const ok = await call('POST', '/devices', { token: admin, body: good });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.device.id, 'T-FRIDGE-1');
  assert.match(ok.body.apiKey, /^[a-f0-9]{32}$/);
  assert.equal(ok.body.device.keyHash, undefined, 'hash must never be returned');
  apiKey = ok.body.apiKey;
  assert.equal((await call('POST', '/devices', { token: admin, body: good })).status, 409);
});

test('ingest: needs a valid device key and a valid payload', async () => {
  assert.equal((await ingest({ temp: 5, hum: 40, battery: 90 }, 'nope')).status, 401);
  assert.equal((await call('POST', '/ingest/T-FRIDGE-1', { body: { temp: 5 } })).status, 401);
  assert.equal((await ingest({ temp: 'hot', hum: 40, battery: 90 })).status, 400);
  assert.equal((await ingest({ temp: 5, hum: 140, battery: 90 })).status, 400);
  assert.equal((await ingest({ temp: 5, hum: 40, battery: 90, ts: Date.now() + 3600e3 })).status, 400);
  const r = await ingest({ temp: 5, hum: 40, battery: 90 });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'normal');
  assert.equal((await call('GET', '/devices/T-FRIDGE-1', { token: viewer })).body.lastTemp, 5);
});

test('alerts: raised once per excursion, auto-resolved on recovery', async () => {
  const hot = await ingest({ temp: 12.5, hum: 40, battery: 90 });
  assert.equal(hot.body.status, 'excursion');
  assert.equal(hot.body.alertsRaised, 1);
  await ingest({ temp: 13.1, hum: 40, battery: 90 }); // same excursion: must NOT create a 2nd alert

  let open = await call('GET', '/alerts?status=open&device=T-FRIDGE-1', { token: viewer });
  const high = open.body.filter((a) => a.type === 'TEMP_HIGH');
  assert.equal(high.length, 1, 'HSETNX de-duplication');
  assert.equal(high[0].severity, 'critical'); // 4.5 C over the limit

  await ingest({ temp: 5, hum: 40, battery: 90 }); // back in range
  open = await call('GET', '/alerts?status=open&device=T-FRIDGE-1', { token: viewer });
  assert.equal(open.body.filter((a) => a.type === 'TEMP_HIGH').length, 0);
  const resolved = await call('GET', '/alerts?status=resolved&device=T-FRIDGE-1&type=TEMP_HIGH', { token: viewer });
  assert.equal(resolved.body.length, 1);
  assert.equal(resolved.body[0].resolvedBy, 'system');
});

test('alerts: a worsening excursion escalates the same alert to critical', async () => {
  await ingest({ temp: 8.6, hum: 40, battery: 90 }); // 0.6 over -> warning
  let a = (await call('GET', '/alerts?status=open&device=T-FRIDGE-1&type=TEMP_HIGH', { token: viewer })).body;
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'warning');
  await ingest({ temp: 11.2, hum: 40, battery: 90 }); // 3.2 over -> critical
  a = (await call('GET', '/alerts?status=open&device=T-FRIDGE-1&type=TEMP_HIGH', { token: viewer })).body;
  assert.equal(a.length, 1, 'still one alert');
  assert.equal(a[0].severity, 'critical');
  assert.equal((await call('GET', '/alerts?status=open&device=T-FRIDGE-1&type=TEMP_HIGH&severity=warning', { token: viewer })).body.length, 0, 'severity index moved');
  await ingest({ temp: 5, hum: 40, battery: 90 });
});

test('alerts: acknowledge and resolve workflow, filters', async () => {
  await ingest({ temp: 3, hum: 40, battery: 15 }); // low battery -> warning
  const list = await call('GET', '/alerts?status=open&type=BATTERY_LOW&severity=warning&site=test-depot', { token: admin });
  assert.equal(list.body.length, 1);
  const id = list.body[0].id;

  assert.equal((await call('POST', `/alerts/${id}/acknowledge`, { token: viewer })).status, 403);
  const ack = await call('POST', `/alerts/${id}/acknowledge`, { token: admin });
  assert.equal(ack.body.status, 'acknowledged');
  assert.equal(ack.body.ackBy, 'admin');
  assert.equal((await call('POST', `/alerts/${id}/acknowledge`, { token: admin })).status, 400);
  assert.equal((await call('POST', `/alerts/${id}/resolve`, { token: admin })).body.status, 'resolved');
  assert.equal((await call('GET', '/alerts?status=bogus', { token: admin })).status, 400);
  assert.equal((await call('POST', '/alerts/99999/resolve', { token: admin })).status, 404);
});

test('time series: history buckets, stats and idempotent re-send', async () => {
  const now = Date.now();
  for (let i = 30; i >= 1; i--) await ingest({ temp: 4 + (i % 3), hum: 45, battery: 80, ts: now - i * 60e3 });
  const before = (await call('GET', '/devices/T-FRIDGE-1/history?range=1h', { token: viewer })).body.stats.count;
  await ingest({ temp: 5, hum: 45, battery: 80, ts: now - 5 * 60e3 }); // same timestamp again
  const h = await call('GET', '/devices/T-FRIDGE-1/history?range=1h', { token: viewer });
  assert.equal(h.status, 200);
  assert.equal(h.body.stats.count, before, 'duplicate timestamp must overwrite, not duplicate');
  assert.ok(h.body.points.length > 5);
  assert.ok(h.body.stats.compliance > 0 && h.body.stats.compliance <= 100);
  assert.ok(h.body.stats.mkt >= h.body.stats.avg - 0.05, 'MKT is never below the arithmetic mean');
  assert.equal((await call('GET', '/devices/T-FRIDGE-1/history?range=9y', { token: viewer })).status, 400);

  const latest = await call('GET', '/devices/T-FRIDGE-1/latest?count=3', { token: viewer });
  assert.equal(latest.body.length, 3); // Redis Stream XREVRANGE
});

test('mean kinetic temperature maths', () => {
  assert.ok(Math.abs(telemetry.mkt([5, 5, 5]) - 5) < 1e-9);
  assert.ok(telemetry.mkt([2, 8]) > 5); // MKT weights warm excursions more heavily
});

test('devices: prefix search, filters, update, sort', async () => {
  await call('POST', '/devices', { token: admin, body: { id: 'T-FREEZER-2', name: 'Plasma Deep Freezer', siteId: 'test-depot', type: 'freezer', productClass: 'blood', minTemp: -40, maxTemp: -25 } });
  const byName = await call('GET', '/devices?q=plas', { token: viewer });
  assert.deepEqual(byName.body.map((d) => d.id), ['T-FREEZER-2']);
  assert.equal((await call('GET', '/devices?q=fridge', { token: viewer })).body.length, 1); // matches any word
  assert.equal((await call('GET', '/devices?class=blood&site=test-depot', { token: viewer })).body.length, 1);
  assert.equal((await call('GET', '/devices?class=blood&status=normal', { token: viewer })).body.length, 0); // no data yet -> "unknown"
  assert.equal((await call('GET', '/devices?status=nonsense', { token: viewer })).status, 400);

  const up = await call('PUT', '/devices/T-FREEZER-2', { token: admin, body: { name: 'Plasma Freezer Renamed', maxTemp: -20 } });
  assert.equal(up.body.maxTemp, -20);
  assert.equal((await call('GET', '/devices?q=renam', { token: viewer })).body.length, 1);
  assert.equal((await call('GET', '/devices?q=deep', { token: viewer })).body.length, 0, 'old name tokens removed from index');
  assert.equal((await call('PUT', '/devices/T-FREEZER-2', { token: admin, body: { minTemp: 0 } })).status, 400);
  assert.equal((await call('PUT', '/devices/T-FREEZER-2', { token: admin, body: {} })).status, 400);
});

test('offline detection raises a critical alert and recovery resolves it', async () => {
  await redis.hset('device:T-FRIDGE-1', 'lastSeen', Date.now() - 10 * 60e3);
  assert.equal(await telemetry.sweepOffline(), 1);
  assert.equal((await call('GET', '/devices/T-FRIDGE-1', { token: viewer })).body.status, 'offline');
  const a = await call('GET', '/alerts?status=open&type=OFFLINE', { token: viewer });
  assert.equal(a.body.length, 1);
  assert.equal(a.body[0].severity, 'critical');
  await ingest({ temp: 5, hum: 40, battery: 90 });
  assert.equal((await call('GET', '/alerts?status=open&type=OFFLINE', { token: viewer })).body.length, 0);
});

test('summary and analytics endpoints', async () => {
  const s = (await call('GET', '/summary', { token: viewer })).body;
  assert.equal(s.devices, 2);
  assert.equal(s.byStatus.normal + s.byStatus.unknown + s.byStatus.excursion + s.byStatus.offline, 2);
  assert.ok(s.reportingToday >= 1);
  const a = (await call('GET', '/analytics', { token: viewer })).body;
  assert.equal(a.alertsByDay.length, 7);
  assert.ok(a.leaderboard.length >= 1);
  assert.ok(a.alertsByType.some((t) => t.type === 'TEMP_HIGH'));
  assert.equal(a.perDevice.length, 2);
});

test('live stream delivers readings via Redis Pub/Sub', async () => {
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/stream?token=${viewer}`, { signal: ctl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  await new Promise((r) => setTimeout(r, 150));
  await ingest({ temp: 4.4, hum: 41, battery: 90 });
  let buf = '';
  const deadline = Date.now() + 3000;
  while (!buf.includes('"type":"reading"') && Date.now() < deadline) {
    const { value } = await reader.read();
    buf += Buffer.from(value).toString();
  }
  ctl.abort();
  assert.match(buf, /"type":"reading"/);
  assert.match(buf, /T-FRIDGE-1/);
  assert.equal((await fetch(`${base}/api/stream`)).status, 401);
});

test('errors: malformed JSON, unknown routes, oversized body', async () => {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: J, body: '{bad json' });
  assert.equal(res.status, 400);
  assert.equal((await call('GET', '/nope', { token: admin })).status, 404);
  const big = await fetch(base + '/api/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ x: 'a'.repeat(30000) }) });
  assert.equal(big.status, 413);
  const h = await fetch(base + '/api/health');
  assert.ok(h.headers.get('content-security-policy'), 'helmet security headers present');
});

test('delete: removes device, readings, alerts and index entries', async () => {
  assert.equal((await call('DELETE', '/sites/test-depot', { token: admin })).status, 409); // still has devices
  assert.equal((await call('DELETE', '/devices/T-FRIDGE-1', { token: viewer })).status, 403);
  assert.equal((await call('DELETE', '/devices/T-FRIDGE-1', { token: admin })).status, 204);
  assert.equal((await call('GET', '/devices/T-FRIDGE-1', { token: admin })).status, 404);
  assert.equal((await call('GET', '/alerts?device=T-FRIDGE-1', { token: admin })).body.length, 0);
  assert.equal(await redis.exists('ts:temp:T-FRIDGE-1', 'telemetry:T-FRIDGE-1', 'active:T-FRIDGE-1'), 0);
  assert.equal(await redis.scard('idx:alert:device:T-FRIDGE-1'), 0);
  assert.equal((await call('DELETE', '/devices/T-FREEZER-2', { token: admin })).status, 204);
  assert.equal((await call('DELETE', '/sites/test-depot', { token: admin })).status, 204);
});
