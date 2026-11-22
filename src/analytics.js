// Dashboard analytics computed directly from Redis data structures.
const { redis } = require('./redis');
const config = require('./config');
const devices = require('./devices');
const telemetry = require('./telemetry');

async function summary() {
  const now = Date.now();
  const p = redis.pipeline();
  p.scard('devices');
  ['normal', 'excursion', 'offline', 'unknown'].forEach((s) => p.scard(`idx:status:${s}`));
  p.scard('idx:alert:status:open');
  p.sinter('idx:alert:status:open', 'idx:alert:severity:critical');
  p.pfcount(telemetry.dayKey(now)); // HyperLogLog distinct count
  p.scard('sites');
  const r = (await p.exec()).map(([, v]) => v);
  return {
    devices: r[0],
    byStatus: { normal: r[1], excursion: r[2], offline: r[3], unknown: r[4] },
    openAlerts: r[5],
    openCritical: r[6].length,
    reportingToday: r[7],
    sites: r[8],
  };
}

async function overview() {
  const now = Date.now();

  // Per-device compliance + MKT over the last 24 h
  const all = await devices.list({ sort: 'name' });
  const perDevice = [];
  for (const d of all) {
    const s = telemetry.stats(await telemetry.readings(d.id, 24 * 3600e3, now), d);
    perDevice.push({
      id: d.id, name: d.name, siteId: d.siteId, productClass: d.productClass, status: d.status,
      compliance: s.compliance ?? null, mkt: s.mkt ?? null, excursions: s.excursions ?? 0, readings: s.count,
    });
  }

  // Risk leaderboard: ZREVRANGE ... WITHSCORES
  const board = await redis.zrevrange('risk:board', 0, 4, 'WITHSCORES');
  const names = Object.fromEntries(all.map((d) => [d.id, d.name]));
  const leaderboard = [];
  for (let i = 0; i < board.length; i += 2) {
    if (names[board[i]]) leaderboard.push({ id: board[i], name: names[board[i]], score: Number(board[i + 1]) });
  }

  // Alerts per day, last 7 days: ZCOUNT over the time-sorted alert index
  const day = 24 * 3600e3;
  const p = redis.pipeline();
  for (let i = 6; i >= 0; i--) p.zcount('alerts:time', now - (i + 1) * day, now - i * day - 1);
  const alertsByDay = (await p.exec()).map(([, c], idx) => ({ from: now - (7 - idx) * day, count: c }));

  const typeCounts = await redis.hgetall('stats:alert:type');
  const alertsByType = Object.entries(typeCounts).map(([type, n]) => ({ type, count: Number(n) })).sort((a, b) => b.count - a.count);

  // Alerts per site (set cardinality)
  const sites = await redis.smembers('sites');
  const sp = redis.pipeline();
  sites.forEach((s) => { sp.hgetall(`site:${s}`); sp.scard(`idx:alert:site:${s}`); });
  const sr = await sp.exec();
  const alertsBySite = sites.map((s, i) => ({ id: s, name: sr[i * 2][1].name, count: sr[i * 2 + 1][1] }));

  return { perDevice, leaderboard, alertsByDay, alertsByType, alertsBySite, generatedAt: now, retentionDays: config.retentionMs / 86400e3 };
}

module.exports = { summary, overview };
