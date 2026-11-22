// Hand-written input validation. Every API input passes through one of these before touching Redis.
const { badRequest } = require('./errors');

const ENUMS = {
  deviceType: ['cold_room', 'fridge', 'freezer', 'ultra_freezer'],
  productClass: ['vaccine', 'blood', 'insulin', 'medicine'],
  siteType: ['warehouse', 'hospital', 'clinic', 'pharmacy'],
  alertStatus: ['open', 'acknowledged', 'resolved'],
  severity: ['warning', 'critical'],
  alertType: ['TEMP_HIGH', 'TEMP_LOW', 'HUMIDITY_HIGH', 'DOOR_OPEN', 'BATTERY_LOW', 'OFFLINE'],
  deviceStatus: ['normal', 'excursion', 'offline', 'unknown'],
  role: ['admin', 'viewer'],
};

const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '72h': 72 * 3600e3, '7d': 7 * 24 * 3600e3 };

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{2,23}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f<>]/;

function str(errors, field, value, { min = 1, max = 80, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) errors.push(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') { errors.push(`${field} must be text`); return undefined; }
  const v = value.trim();
  if (v.length < min || v.length > max) { errors.push(`${field} must be ${min}-${max} characters`); return undefined; }
  if (CONTROL_RE.test(v)) { errors.push(`${field} contains invalid characters`); return undefined; }
  return v;
}

function num(errors, field, value, { min, max, required = true, int = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) errors.push(`${field} is required`);
    return undefined;
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (typeof value === 'boolean' || !Number.isFinite(n)) { errors.push(`${field} must be a number`); return undefined; }
  if (int && !Number.isInteger(n)) { errors.push(`${field} must be a whole number`); return undefined; }
  if (min !== undefined && n < min) { errors.push(`${field} must be at least ${min}`); return undefined; }
  if (max !== undefined && n > max) { errors.push(`${field} must be at most ${max}`); return undefined; }
  return n;
}

function oneOf(errors, field, value, list, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) errors.push(`${field} is required`);
    return undefined;
  }
  if (!list.includes(value)) { errors.push(`${field} must be one of: ${list.join(', ')}`); return undefined; }
  return value;
}

function finish(errors, value) {
  if (errors.length) throw badRequest('Validation failed', errors);
  return value;
}

function body(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw badRequest('Request body must be a JSON object');
  return b;
}

function validateLogin(b) {
  b = body(b);
  const errors = [];
  const username = str(errors, 'username', b.username, { min: 3, max: 30 });
  const password = str(errors, 'password', b.password, { min: 6, max: 100 });
  return finish(errors, { username: username && username.toLowerCase(), password });
}

function validateSite(b) {
  b = body(b);
  const errors = [];
  const out = {
    name: str(errors, 'name', b.name, { min: 3, max: 60 }),
    city: str(errors, 'city', b.city, { min: 2, max: 40 }),
    type: oneOf(errors, 'type', b.type, ENUMS.siteType),
  };
  if (b.id !== undefined && b.id !== '') {
    if (typeof b.id !== 'string' || !SLUG_RE.test(b.id)) errors.push('id must be 3-30 chars: lowercase letters, digits, hyphens');
    else out.id = b.id;
  }
  return finish(errors, out);
}

function validateDevice(b, { partial = false } = {}) {
  b = body(b);
  const errors = [];
  const req = !partial;
  const has = (k) => b[k] !== undefined;
  const out = {};

  if (req || has('name')) out.name = str(errors, 'name', b.name, { min: 3, max: 60 });
  if (req || has('siteId')) out.siteId = str(errors, 'siteId', b.siteId, { min: 3, max: 30 });
  if (req || has('type')) out.type = oneOf(errors, 'type', b.type, ENUMS.deviceType);
  if (req || has('productClass')) out.productClass = oneOf(errors, 'productClass', b.productClass, ENUMS.productClass);
  if (req || has('minTemp')) out.minTemp = num(errors, 'minTemp', b.minTemp, { min: -100, max: 40 });
  if (req || has('maxTemp')) out.maxTemp = num(errors, 'maxTemp', b.maxTemp, { min: -100, max: 40 });
  if (has('maxHum')) out.maxHum = num(errors, 'maxHum', b.maxHum, { min: 1, max: 100 });
  else if (req) out.maxHum = 80;
  if (has('simulated')) {
    if (typeof b.simulated !== 'boolean') errors.push('simulated must be true or false');
    else out.simulated = b.simulated;
  }
  if (!partial && b.id !== undefined && b.id !== '') {
    if (typeof b.id !== 'string' || !ID_RE.test(b.id)) errors.push('id must be 3-24 chars: letters, digits, hyphens');
    else out.id = b.id.toUpperCase();
  }
  if (out.minTemp !== undefined && out.maxTemp !== undefined && out.minTemp >= out.maxTemp) {
    errors.push('minTemp must be lower than maxTemp');
  }
  // drop undefined keys
  Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
  if (partial && Object.keys(out).length === 0 && !errors.length) errors.push('No updatable fields supplied');
  return finish(errors, out);
}

// A sensor reading as sent by a device over HTTP.
function validateReading(b, now = Date.now()) {
  b = body(b);
  const errors = [];
  const temp = num(errors, 'temp', b.temp, { min: -100, max: 100 });
  const hum = num(errors, 'hum', b.hum, { min: 0, max: 100 });
  const battery = num(errors, 'battery', b.battery, { min: 0, max: 100 });
  let door = 0;
  if (b.door !== undefined) {
    if (b.door === true || b.door === 1) door = 1;
    else if (b.door === false || b.door === 0) door = 0;
    else errors.push('door must be true/false or 1/0');
  }
  let ts = now;
  if (b.ts !== undefined) {
    const t = num(errors, 'ts', b.ts, { int: true });
    if (t !== undefined) {
      if (t > now + 5 * 60e3) errors.push('ts is in the future');
      else if (t < now - RANGES['7d']) errors.push('ts is older than the 7 day retention window');
      else ts = t;
    }
  }
  return finish(errors, { temp, hum, battery, door, ts });
}

function validateAlertQuery(q) {
  const errors = [];
  const out = {
    status: oneOf(errors, 'status', q.status, ENUMS.alertStatus, { required: false }),
    severity: oneOf(errors, 'severity', q.severity, ENUMS.severity, { required: false }),
    type: oneOf(errors, 'type', q.type, ENUMS.alertType, { required: false }),
    site: q.site ? str(errors, 'site', q.site, { max: 30 }) : undefined,
    device: q.device ? str(errors, 'device', q.device, { max: 24 }) : undefined,
    limit: num(errors, 'limit', q.limit, { min: 1, max: 200, int: true, required: false }) || 50,
  };
  return finish(errors, out);
}

function validateDeviceQuery(q) {
  const errors = [];
  const out = {
    status: oneOf(errors, 'status', q.status, ENUMS.deviceStatus, { required: false }),
    productClass: oneOf(errors, 'class', q.class, ENUMS.productClass, { required: false }),
    type: oneOf(errors, 'type', q.type, ENUMS.deviceType, { required: false }),
    site: q.site ? str(errors, 'site', q.site, { max: 30 }) : undefined,
    q: q.q ? str(errors, 'q', q.q, { max: 40 }) : undefined,
    sort: oneOf(errors, 'sort', q.sort || 'name', ['name', 'temp', 'lastSeen', 'status', 'battery']),
  };
  return finish(errors, out);
}

module.exports = {
  ENUMS, RANGES,
  validateLogin, validateSite, validateDevice, validateReading, validateAlertQuery, validateDeviceQuery,
};
