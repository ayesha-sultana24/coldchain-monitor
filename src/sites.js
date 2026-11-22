const { redis } = require('./redis');
const { notFound, conflict } = require('./errors');

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

function parse(h) {
  if (!h || !h.id) return null;
  return { id: h.id, name: h.name, city: h.city, type: h.type, createdAt: Number(h.createdAt) };
}

async function list() {
  const ids = (await redis.smembers('sites')).sort();
  const p = redis.pipeline();
  ids.forEach((id) => { p.hgetall(`site:${id}`); p.scard(`idx:site:${id}`); });
  const res = await p.exec();
  return ids.map((_, i) => ({ ...parse(res[i * 2][1]), deviceCount: res[i * 2 + 1][1] })).filter((s) => s.id);
}

async function get(id) {
  const s = parse(await redis.hgetall(`site:${id}`));
  if (!s) throw notFound('Site');
  return s;
}

async function create(input) {
  const id = input.id || slug(input.name);
  if (id.length < 3) throw conflict('Could not derive a valid site id from the name; supply an id');
  if (await redis.sismember('sites', id)) throw conflict(`Site "${id}" already exists`);
  const site = { id, name: input.name, city: input.city, type: input.type, createdAt: Date.now() };
  await redis.multi().hset(`site:${id}`, site).sadd('sites', id).exec();
  return { ...site, deviceCount: 0 };
}

async function remove(id) {
  await get(id);
  if (await redis.scard(`idx:site:${id}`)) throw conflict('Site still has devices. Delete or move them first.');
  await redis.multi().del(`site:${id}`).srem('sites', id).exec();
}

module.exports = { list, get, create, remove };
