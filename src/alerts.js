// Alert lifecycle:  open -> acknowledged -> resolved
//
// Redis structures used here
//   alert:{id}                    HASH   the alert record
//   alerts:time                   ZSET   all alert ids scored by creation time (time-range counts, newest-first)
//   idx:alert:status:{s}          SET    secondary indexes ...
//   idx:alert:severity:{s}        SET
//   idx:alert:site:{siteId}       SET
//   idx:alert:device:{deviceId}   SET
//   idx:alert:type:{type}         SET    ... filtering = SINTER of the chosen sets
//   active:{deviceId}             HASH   alertType -> alertId, HSETNX gives atomic de-duplication
//   risk:board                    ZSET   deviceId scored by weighted alert count (leaderboard)
//   stats:alert:type              HASH   running counters per alert type
const { redis } = require('./redis');
const { publish } = require('./events');
const { notFound, badRequest } = require('./errors');

const RECENT_MS = 10 * 60e3; // only push live events for alerts that are genuinely recent (not seed history)

function parse(h) {
  if (!h || !h.id) return null;
  const n = (v) => (v === '' || v === undefined ? null : Number(v));
  return {
    id: Number(h.id), deviceId: h.deviceId, deviceName: h.deviceName, siteId: h.siteId,
    type: h.type, severity: h.severity, message: h.message, value: n(h.value), threshold: n(h.threshold),
    status: h.status, createdAt: n(h.createdAt), ackBy: h.ackBy || null, ackAt: n(h.ackAt),
    resolvedAt: n(h.resolvedAt), resolvedBy: h.resolvedBy || null,
  };
}

async function raise(device, type, severity, message, value, threshold, ts = Date.now()) {
  // HSETNX is atomic: only the first caller for (device, type) wins, so a stuck sensor
  // produces ONE alert, not one per reading.
  const first = await redis.hsetnx(`active:${device.id}`, type, 'pending');
  if (!first) return escalate(device, type, severity, message, value, ts);

  const id = await redis.incr('seq:alert');
  const alert = {
    id, deviceId: device.id, deviceName: device.name, siteId: device.siteId, type, severity, message,
    value: value ?? '', threshold: threshold ?? '', createdAt: ts, status: 'open',
    ackBy: '', ackAt: '', resolvedAt: '', resolvedBy: '',
  };
  await redis
    .multi()
    .hset(`alert:${id}`, alert)
    .hset(`active:${device.id}`, type, id)
    .zadd('alerts:time', ts, id)
    .sadd('idx:alert:status:open', id)
    .sadd(`idx:alert:severity:${severity}`, id)
    .sadd(`idx:alert:site:${device.siteId}`, id)
    .sadd(`idx:alert:device:${device.id}`, id)
    .sadd(`idx:alert:type:${type}`, id)
    .hincrby('stats:alert:type', type, 1)
    .zincrby('risk:board', severity === 'critical' ? 3 : 1, device.id)
    .exec();

  const parsed = parse(Object.fromEntries(Object.entries(alert).map(([k, v]) => [k, String(v)])));
  if (Date.now() - ts < RECENT_MS) await publish('alert', parsed);
  return parsed;
}

// An existing open alert is upgraded (not duplicated) if the situation gets worse.
async function escalate(device, type, severity, message, value, ts) {
  if (severity !== 'critical') return null;
  const id = await redis.hget(`active:${device.id}`, type);
  if (!id || id === 'pending') return null;
  if ((await redis.hget(`alert:${id}`, 'severity')) !== 'warning') return null;
  await redis
    .multi()
    .hset(`alert:${id}`, { severity: 'critical', message, value: value ?? '' })
    .srem('idx:alert:severity:warning', id)
    .sadd('idx:alert:severity:critical', id)
    .zincrby('risk:board', 2, device.id)
    .exec();
  if (Date.now() - ts < RECENT_MS) await publish('alert', parse(await redis.hgetall(`alert:${id}`)));
  return null; // not a NEW alert, so callers do not count it as raised
}

async function transition(id, from, to, by, ts) {
  const key = `alert:${id}`;
  const a = parse(await redis.hgetall(key));
  if (!a) throw notFound('Alert');
  if (!from.includes(a.status)) throw badRequest(`Alert is already ${a.status}`);
  const p = redis.multi().srem(`idx:alert:status:${a.status}`, id).sadd(`idx:alert:status:${to}`, id);
  if (to === 'acknowledged') p.hset(key, { status: to, ackBy: by, ackAt: ts });
  else {
    p.hset(key, { status: to, resolvedBy: by, resolvedAt: ts });
    p.eval(
      // only clear the "active" marker if it still points at THIS alert
      "if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then redis.call('HDEL', KEYS[1], ARGV[1]) end",
      1, `active:${a.deviceId}`, a.type, String(id),
    );
  }
  await p.exec();
  const updated = parse(await redis.hgetall(key));
  if (Date.now() - ts < RECENT_MS) await publish('alert_update', updated);
  return updated;
}

const acknowledge = (id, by) => transition(id, ['open'], 'acknowledged', by, Date.now());
const resolve = (id, by, ts = Date.now()) => transition(id, ['open', 'acknowledged'], 'resolved', by, ts);

// Resolve the device's active alert of a given type, if there is one (used for auto-recovery).
async function resolveActive(deviceId, type, by = 'system', ts = Date.now()) {
  const id = await redis.hget(`active:${deviceId}`, type);
  if (!id || id === 'pending') return null;
  try { return await resolve(Number(id), by, ts); } catch { return null; }
}

async function list(filters) {
  const sets = [];
  if (filters.status) sets.push(`idx:alert:status:${filters.status}`);
  if (filters.severity) sets.push(`idx:alert:severity:${filters.severity}`);
  if (filters.site) sets.push(`idx:alert:site:${filters.site}`);
  if (filters.device) sets.push(`idx:alert:device:${filters.device}`);
  if (filters.type) sets.push(`idx:alert:type:${filters.type}`);

  let ids;
  if (sets.length) ids = await redis.sinter(...sets); // set intersection = AND of all filters
  else ids = await redis.zrevrange('alerts:time', 0, filters.limit - 1);
  if (!ids.length) return [];

  const p = redis.pipeline();
  ids.forEach((id) => p.hgetall(`alert:${id}`));
  const rows = (await p.exec()).map(([, h]) => parse(h)).filter(Boolean);
  return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, filters.limit);
}

async function deleteForDevice(deviceId) {
  const ids = await redis.smembers(`idx:alert:device:${deviceId}`);
  if (ids.length) {
    const p = redis.pipeline();
    for (const id of ids) {
      const h = await redis.hgetall(`alert:${id}`);
      if (!h.id) continue;
      p.del(`alert:${id}`).zrem('alerts:time', id)
        .srem(`idx:alert:status:${h.status}`, id).srem(`idx:alert:severity:${h.severity}`, id)
        .srem(`idx:alert:site:${h.siteId}`, id).srem(`idx:alert:type:${h.type}`, id);
    }
    await p.exec();
  }
  await redis.multi().del(`idx:alert:device:${deviceId}`).del(`active:${deviceId}`).zrem('risk:board', deviceId).exec();
}

module.exports = { raise, acknowledge, resolve, resolveActive, list, deleteForDevice, parse };
