// Central configuration. Every value can be overridden with an environment variable.
const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};

module.exports = {
  port: num(process.env.PORT, 3000),
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  redisDb: num(process.env.REDIS_DB, 0),

  // Auth
  sessionTtlSec: num(process.env.SESSION_TTL_SEC, 8 * 3600),
  loginRateMax: num(process.env.LOGIN_RATE_MAX, 10), // login attempts per 15 min per IP
  adminPassword: process.env.ADMIN_PASSWORD || 'Admin@123',
  viewerPassword: process.env.VIEWER_PASSWORD || 'Viewer@123',

  // Telemetry
  retentionMs: 7 * 24 * 3600 * 1000, // time-series window kept per device
  streamMaxLen: 5000, // approximate cap on each device's Redis Stream
  offlineAfterSec: num(process.env.OFFLINE_AFTER_SEC, 120),
  tzOffsetMin: num(process.env.TZ_OFFSET_MIN, 330), // IST, used only for "today" bucketing

  // Built-in IoT simulator (so the demo works without real sensors)
  simulator: (process.env.SIMULATOR || 'on') === 'on',
  simulatorIntervalMs: num(process.env.SIM_INTERVAL_MS, 5000),
};
