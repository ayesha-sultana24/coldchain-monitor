// Device registry.
//
//   device:{id}              HASH   configuration + latest state
//   devices                  SET    all device ids
//   idx:site:{siteId}        SET    ids per site            \
//   idx:class:{class}        SET    ids per product class    |  secondary indexes,
//   idx:type:{type}          SET    ids per equipment type   |  combined with SINTER
//   idx:status:{status}      SET    ids per live status     /
//   idx:name                 ZSET   all members score 0 -> lexicographic prefix search (ZRANGEBYLEX)
const crypto = require('crypto');
const { redis } = require('./redis');
const { sha256 } = require('./auth');
const { notFound, conflict, badRequest } = require('./errors');
const alerts = require('./alerts');

const num = (v) => (v === undefined || v === '' ? null : Number(v));

function parse(h) {
  if (!h || !h.id) return null;
  return {
    id: h.id, name: h.name, siteId: h.siteId, type: h.type, productClass: h.productClass,
    minTemp: num(h.minTemp), maxTemp: num(h.maxTemp), maxHum: num(h.maxHum),
    simulated: h.simulated === '1', status: h.status || 'unknown',
    createdAt: num(h.createdAt), updatedAt: num(h.updatedAt),
    lastSeen: num(h.lastSeen), lastTemp: num(h.lastTemp), lastHum: num(h.lastHum),
    battery: num(h.battery), door: h.door === '1',
  };
}

const tokens = (name, id) =>
  [...new Set([...name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean), id.toLowerCase()])].map((t) => `${t}:${id}`);

async function get(id) {
  const d = parse(await redis.hgetall(`device:${id}`));
  if (!d) throw notFound('Device');
  return d;
}

async function exists(id) {
  return (await redis.sismember('devices', id)) === 1;
}

async function create(input, { apiKey } = {}) {
  if (!(await redis.sismember('sites', input.siteId))) throw badRequest('Validation failed', [`siteId "${input.siteId}" does not exist`]);
  const id = input.id || `CC-${String(await redis.incr('seq:device')).padStart(4, '0')}`;
  if (await exists(id)) throw conflict(`Device "${id}" already exists`);

  const key = apiKey || crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const hash = {
    id, name: input.name, siteId: input.siteId, type: input.type, productClass: input.productClass,
    minTemp: input.minTemp, maxTemp: input.maxTemp, maxHum: input.maxHum,
    simulated: input.simulated ? '1' : '0', status: 'unknown', createdAt: now, updatedAt: now,
    keyHash: sha256(key),
  };
  const p = redis.multi()
    .hset(`device:${id}`, hash)
    .sadd('devices', id)
    .sadd(`idx:site:${input.siteId}`, id)
    .sadd(`idx:class:${input.productClass}`, id)
    .sadd(`idx:type:${input.type}`, id)
    .sadd('idx:status:unknown', id);
  tokens(input.name, id).forEach((t) => p.zadd('idx:name', 0, t));
  await p.exec();
  // The plain API key is returned ONCE; only its SHA-256 hash is stored.
  return { device: await get(id), apiKey: key };
}

async function update(id, patch) {
  const cur = await get(id);
  const next = { ...cur, ...patch };
  if (next.minTemp >= next.maxTemp) throw badRequest('Validation failed', ['minTemp must be lower than maxTemp']);
  if (patch.siteId && !(await redis.sismember('sites', patch.siteId))) {
    throw badRequest('Validation failed', [`siteId "${patch.siteId}" does not exist`]);
  }
  const p = redis.multi();
  const fields = { updatedAt: Date.now() };
  for (const k of ['name', 'siteId', 'type', 'productClass', 'minTemp', 'maxTemp', 'maxHum']) {
    if (patch[k] !== undefined) fields[k] = patch[k];
  }
  if (patch.simulated !== undefined) fields.simulated = patch.simulated ? '1' : '0';
  p.hset(`device:${id}`, fields);
  if (patch.siteId && patch.siteId !== cur.siteId) p.smove(`idx:site:${cur.siteId}`, `idx:site:${patch.siteId}`, id);
  if (patch.productClass && patch.productClass !== cur.productClass) p.smove(`idx:class:${cur.productClass}`, `idx:class:${patch.productClass}`, id);
  if (patch.type && patch.type !== cur.type) p.smove(`idx:type:${cur.type}`, `idx:type:${patch.type}`, id);
  if (patch.name && patch.name !== cur.name) {
    tokens(cur.name, id).forEach((t) => p.zrem('idx:name', t));
    tokens(patch.name, id).forEach((t) => p.zadd('idx:name', 0, t));
  }
  await p.exec();
  return get(id);
}

async function remove(id) {
  const d = await get(id);
  await alerts.deleteForDevice(id);
  const p = redis.multi()
    .del(`device:${id}`, `telemetry:${id}`, `ts:temp:${id}`)
    .srem('devices', id)
    .srem(`idx:site:${d.siteId}`, id)
    .srem(`idx:class:${d.productClass}`, id)
    .srem(`idx:type:${d.type}`, id)
    .srem(`idx:status:${d.status}`, id);
  tokens(d.name, id).forEach((t) => p.zrem('idx:name', t));
  await p.exec();
}

async function list(f = {}) {
  // Start from "all devices", then intersect every filter's index set.
  const keys = [];
  if (f.site) keys.push(`idx:site:${f.site}`);
  if (f.productClass) keys.push(`idx:class:${f.productClass}`);
  if (f.type) keys.push(`idx:type:${f.type}`);
  if (f.status) keys.push(`idx:status:${f.status}`);
  let ids = await redis.sinter(...(keys.length ? keys : ['devices']));

  if (f.q) {
    const q = f.q.toLowerCase();
    // Prefix search on the lexicographic index: every member between "[q" and "[q\xff".
    const hits = await redis.zrangebylex('idx:name', `[${q}`, `[${q}\xff`);
    const matched = new Set(hits.map((m) => m.slice(m.lastIndexOf(':') + 1)));
    ids = ids.filter((id) => matched.has(id));
  }
  if (!ids.length) return [];

  const p = redis.pipeline();
  ids.forEach((id) => p.hgetall(`device:${id}`));
  const rows = (await p.exec()).map(([, h]) => parse(h)).filter(Boolean);

  const by = {
    name: (a, b) => a.name.localeCompare(b.name),
    temp: (a, b) => (b.lastTemp ?? -999) - (a.lastTemp ?? -999),
    lastSeen: (a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0),
    battery: (a, b) => (a.battery ?? 101) - (b.battery ?? 101),
    status: (a, b) => ['excursion', 'offline', 'unknown', 'normal'].indexOf(a.status) - ['excursion', 'offline', 'unknown', 'normal'].indexOf(b.status) || a.name.localeCompare(b.name),
  };
  return rows.sort(by[f.sort] || by.name);
}

// Used by the ingest endpoint: constant-time check of a device's API key.
async function verifyKey(id, key) {
  const stored = await redis.hget(`device:${id}`, 'keyHash');
  if (!stored || typeof key !== 'string') return false;
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(sha256(key), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { get, exists, create, update, remove, list, verifyKey, parse };
