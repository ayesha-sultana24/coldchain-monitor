const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const { redis } = require('./redis');
const { ApiError, badRequest, notFound } = require('./errors');
const auth = require('./auth');
const v = require('./validators');
const events = require('./events');
const sites = require('./sites');
const devices = require('./devices');
const alerts = require('./alerts');
const telemetry = require('./telemetry');
const analytics = require('./analytics');
const simulator = require('./simulator');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '20kb' }));

  const api = express.Router();
  const needAuth = auth.authenticate();
  const admin = [needAuth, auth.requireRole('admin')];

  api.use(rateLimit({ windowMs: 60e3, limit: 600, standardHeaders: true, legacyHeaders: false }));

  api.get('/health', wrap(async (_req, res) => {
    res.json({ status: 'ok', redis: (await redis.ping()) === 'PONG', time: Date.now() });
  }));

  // ---------- auth ----------
  const loginLimiter = rateLimit({
    windowMs: 15 * 60e3, limit: config.loginRateMax, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  });
  api.post('/auth/login', loginLimiter, wrap(async (req, res) => {
    const { username, password } = v.validateLogin(req.body);
    res.json(await auth.login(username, password));
  }));
  api.post('/auth/logout', needAuth, wrap(async (req, res) => { await auth.logout(req.token); res.json({ ok: true }); }));
  api.get('/auth/me', needAuth, (req, res) => res.json(req.user));

  // ---------- device ingest (authenticated by per-device API key, not by user session) ----------
  api.post('/ingest/:id', wrap(async (req, res) => {
    const id = String(req.params.id).toUpperCase();
    if (!(await devices.verifyKey(id, req.get('x-device-key')))) {
      throw new ApiError(401, 'Invalid device id or API key');
    }
    const reading = v.validateReading(req.body);
    res.status(201).json(await telemetry.ingest(id, reading));
  }));

  // ---------- sites ----------
  api.get('/sites', needAuth, wrap(async (_req, res) => res.json(await sites.list())));
  api.post('/sites', ...admin, wrap(async (req, res) => res.status(201).json(await sites.create(v.validateSite(req.body)))));
  api.delete('/sites/:id', ...admin, wrap(async (req, res) => { await sites.remove(req.params.id); res.status(204).end(); }));

  // ---------- devices ----------
  api.get('/devices', needAuth, wrap(async (req, res) => res.json(await devices.list(v.validateDeviceQuery(req.query)))));
  api.post('/devices', ...admin, wrap(async (req, res) => {
    const out = await devices.create(v.validateDevice(req.body));
    res.status(201).json(out);
  }));
  api.get('/devices/:id', needAuth, wrap(async (req, res) => res.json(await devices.get(req.params.id.toUpperCase()))));
  api.put('/devices/:id', ...admin, wrap(async (req, res) => {
    res.json(await devices.update(req.params.id.toUpperCase(), v.validateDevice(req.body, { partial: true })));
  }));
  api.delete('/devices/:id', ...admin, wrap(async (req, res) => { await devices.remove(req.params.id.toUpperCase()); res.status(204).end(); }));

  api.get('/devices/:id/history', needAuth, wrap(async (req, res) => {
    res.json(await telemetry.history(req.params.id.toUpperCase(), req.query.range || '24h', req.query.buckets));
  }));
  api.get('/devices/:id/latest', needAuth, wrap(async (req, res) => {
    res.json(await telemetry.latest(req.params.id.toUpperCase(), Number(req.query.count) || 20));
  }));
  api.post('/devices/:id/simulate', ...admin, wrap(async (req, res) => {
    const kind = req.body && req.body.kind;
    if (!['door', 'power'].includes(kind)) throw badRequest('kind must be "door" or "power"');
    const ok = await simulator.trigger(req.params.id.toUpperCase(), kind);
    if (!ok) throw badRequest('Only simulated devices can be triggered');
    res.json({ ok: true });
  }));

  // ---------- alerts ----------
  api.get('/alerts', needAuth, wrap(async (req, res) => res.json(await alerts.list(v.validateAlertQuery(req.query)))));
  api.post('/alerts/:id/acknowledge', ...admin, wrap(async (req, res) => {
    res.json(await alerts.acknowledge(Number(req.params.id), req.user.username));
  }));
  api.post('/alerts/:id/resolve', ...admin, wrap(async (req, res) => {
    res.json(await alerts.resolve(Number(req.params.id), req.user.username));
  }));

  // ---------- analytics + live stream ----------
  api.get('/summary', needAuth, wrap(async (_req, res) => res.json(await analytics.summary())));
  api.get('/analytics', needAuth, wrap(async (_req, res) => res.json(await analytics.overview())));
  api.get('/stream', auth.authenticate({ allowQuery: true }), (req, res) => events.addClient(req, res));

  api.use((_req, _res, next) => next(notFound('Endpoint')));
  app.use('/api', api);

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    if (err instanceof ApiError) return res.status(err.status).json({ error: err.message, details: err.details });
    console.error('[error]', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
