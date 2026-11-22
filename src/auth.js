// Authentication: scrypt-hashed passwords, random session tokens stored in Redis with a TTL.
// Redis expires idle sessions automatically (EXPIRE), so there is no cleanup job to write.
const crypto = require('crypto');
const { redis } = require('./redis');
const config = require('./config');
const { unauthorized, forbidden } = require('./errors');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function safeEqualHex(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function createUser(username, password, role) {
  const { salt, hash } = hashPassword(password);
  await redis
    .multi()
    .hset(`user:${username}`, { username, role, salt, hash, createdAt: Date.now() })
    .sadd('users', username)
    .exec();
}

async function ensureDefaultUsers() {
  if (await redis.scard('users')) return;
  await createUser('admin', config.adminPassword, 'admin');
  await createUser('viewer', config.viewerPassword, 'viewer');
  console.log('[auth] created default users: admin / viewer (see README for passwords)');
}

async function login(username, password) {
  const u = await redis.hgetall(`user:${username}`);
  // Always run scrypt so response time does not reveal whether the username exists.
  const { hash } = hashPassword(password, u.salt || 'x'.repeat(32));
  if (!u.username || !safeEqualHex(hash, u.hash)) throw unauthorized('Invalid username or password');
  const token = crypto.randomBytes(24).toString('hex');
  await redis
    .multi()
    .hset(`session:${token}`, { username: u.username, role: u.role })
    .expire(`session:${token}`, config.sessionTtlSec)
    .exec();
  return { token, user: { username: u.username, role: u.role }, expiresInSec: config.sessionTtlSec };
}

async function logout(token) {
  await redis.del(`session:${token}`);
}

function tokenFrom(req, allowQuery = false) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  if (allowQuery && typeof req.query.token === 'string') return req.query.token;
  return null;
}

function authenticate({ allowQuery = false } = {}) {
  return async (req, _res, next) => {
    try {
      const token = tokenFrom(req, allowQuery);
      if (!token || !/^[a-f0-9]{48}$/.test(token)) throw unauthorized();
      const s = await redis.hgetall(`session:${token}`);
      if (!s.username) throw unauthorized('Session expired, please sign in again');
      await redis.expire(`session:${token}`, config.sessionTtlSec); // sliding expiry
      req.user = { username: s.username, role: s.role };
      req.token = token;
      next();
    } catch (e) {
      next(e);
    }
  };
}

const requireRole = (role) => (req, _res, next) =>
  req.user && req.user.role === role ? next() : next(forbidden('Admin access required'));

module.exports = { sha256, safeEqualHex, createUser, ensureDefaultUsers, login, logout, authenticate, requireRole };
