// Telemetry: ingest, alert rules, time-series queries and offline detection.
//
//   telemetry:{deviceId}   STREAM  append-only log of every reading (XADD / XREVRANGE)
//   ts:temp:{deviceId}     ZSET    score = timestamp, member = "ts|temp|hum|door" (ZRANGEBYSCORE)
//   hll:active:{YYYY-MM-DD} HLL    distinct devices that reported that day (PFADD / PFCOUNT)
const { redis } = require('./redis');
const config = require('./config');
const { publish } = require('./events');
const devices = require('./devices');
const alerts = require('./alerts');
const { RANGES } = require('./validators');
const { notFound, badRequest } = require('./errors');

const dayKey = (ts) => `hll:active:${new Date(ts + config.tzOffsetMin * 60e3).toISOString().slice(0, 10)}`;
const r1 = (x) => Math.round(x * 10) / 10;

// ---------- alert rules ----------
async function evaluate(device, r) {
  const out = [];
  const { id, minTemp, maxTemp, maxHum } = device;

  if (r.temp > maxTemp) {
    const over = r.temp - maxTemp;
    out.push(alerts.raise(device, 'TEMP_HIGH', over > 2 ? 'critical' : 'warning',
      `Temperature ${r1(r.temp)}°C is above the ${maxTemp}°C limit`, r1(r.temp), maxTemp, r.ts));
  } else await alerts.resolveActive(id, 'TEMP_HIGH', 'system', r.ts);

  if (r.temp < minTemp) {
    const under = minTemp - r.temp;
    out.push(alerts.raise(device, 'TEMP_LOW', under > 2 ? 'critical' : 'warning',
      `Temperature ${r1(r.temp)}°C is below the ${minTemp}°C limit (freezing risk)`, r1(r.temp), minTemp, r.ts));
  } else await alerts.resolveActive(id, 'TEMP_LOW', 'system', r.ts);

  if (r.hum > maxHum) {
    out.push(alerts.raise(device, 'HUMIDITY_HIGH', 'warning', `Humidity ${r1(r.hum)}% is above ${maxHum}%`, r1(r.hum), maxHum, r.ts));
  } else await alerts.resolveActive(id, 'HUMIDITY_HIGH', 'system', r.ts);

  if (r.door) out.push(alerts.raise(device, 'DOOR_OPEN', 'warning', 'Door is open', 1, 0, r.ts));
  else await alerts.resolveActive(id, 'DOOR_OPEN', 'system', r.ts);

  if (r.battery < 20) {
    out.push(alerts.raise(device, 'BATTERY_LOW', r.battery < 10 ? 'critical' : 'warning',
      `Sensor battery at ${Math.round(r.battery)}%`, Math.round(r.battery), 20, r.ts));
  } else await alerts.resolveActive(id, 'BATTERY_LOW', 'system', r.ts);

  await alerts.resolveActive(id, 'OFFLINE', 'system', r.ts); // any reading means the device is back
  return (await Promise.all(out)).filter(Boolean);
}

// ---------- ingest ----------
async function ingest(deviceId, r) {
  const device = await devices.get(deviceId);
  const status = r.temp > device.maxTemp || r.temp < device.minTemp ? 'excursion' : 'normal';
  const member = `${r.ts}|${r1(r.temp)}|${Math.round(r.hum)}|${r.door}`;

  const code = await redis.ccIngest(
    `device:${deviceId}`, `telemetry:${deviceId}`, `ts:temp:${deviceId}`, dayKey(r.ts),
    r.ts, r1(r.temp), Math.round(r.hum), Math.round(r.battery), r.door, member,
    config.retentionMs, config.streamMaxLen, deviceId, status, 'idx:status:',
  );
  if (code === -1) throw notFound('Device');

  const fresh = { ...device, status };
  const raised = await evaluate(fresh, r);
  if (code === 1 && Date.now() - r.ts < 60e3) {
    await publish('reading', { id: deviceId, ts: r.ts, temp: r1(r.temp), hum: Math.round(r.hum), battery: Math.round(r.battery), door: !!r.door, status });
  }
  return { stored: true, status, alertsRaised: raised.length };
}

// ---------- queries ----------
function parseMember(m) {
  const [ts, temp, hum, door] = m.split('|');
  return { ts: Number(ts), temp: Number(temp), hum: Number(hum), door: door === '1' };
}

// Mean Kinetic Temperature: the single "equivalent" temperature that has the same
// degradation effect as the real fluctuating profile (WHO / USP standard for vaccines).
function mkt(tempsC) {
  if (!tempsC.length) return null;
  const dHR = 10000; // ΔH/R in kelvin (ΔH = 83.144 kJ/mol)
  const mean = tempsC.reduce((s, t) => s + Math.exp(-dHR / (t + 273.15)), 0) / tempsC.length;
  return -dHR / Math.log(mean) - 273.15;
}

function stats(readings, device) {
  if (!readings.length) return { count: 0 };
  const temps = readings.map((x) => x.temp);
  const out = (x) => x.temp > device.maxTemp || x.temp < device.minTemp;
  let excursions = 0;
  let prev = false;
  let worst = null;
  for (const x of readings) {
    const o = out(x);
    if (o && !prev) excursions++;
    prev = o;
    if (o) {
      const dev = x.temp > device.maxTemp ? x.temp - device.maxTemp : device.minTemp - x.temp;
      if (!worst || dev > worst) worst = dev;
    }
  }
  return {
    count: readings.length,
    min: r1(Math.min(...temps)),
    max: r1(Math.max(...temps)),
    avg: r1(temps.reduce((a, b) => a + b, 0) / temps.length),
    mkt: r1(mkt(temps)),
    compliance: Math.round((readings.filter((x) => !out(x)).length / readings.length) * 1000) / 10,
    excursions,
    worstDeviation: worst === null ? 0 : r1(worst),
  };
}

async function readings(deviceId, rangeMs, to = Date.now()) {
  const members = await redis.zrangebyscore(`ts:temp:${deviceId}`, to - rangeMs, to);
  return members.map(parseMember);
}

async function history(deviceId, rangeKey = '24h', buckets = 60) {
  const rangeMs = RANGES[rangeKey];
  if (!rangeMs) throw badRequest(`range must be one of: ${Object.keys(RANGES).join(', ')}`);
  buckets = Math.min(Math.max(parseInt(buckets, 10) || 60, 10), 200);
  const device = await devices.get(deviceId);
  const now = Date.now();
  const list = await readings(deviceId, rangeMs, now);

  const size = Math.ceil(rangeMs / buckets);
  const start = now - rangeMs;
  const agg = new Map();
  for (const x of list) {
    const i = Math.floor((x.ts - start) / size);
    const a = agg.get(i) || { min: Infinity, max: -Infinity, sum: 0, hum: 0, n: 0 };
    a.min = Math.min(a.min, x.temp); a.max = Math.max(a.max, x.temp);
    a.sum += x.temp; a.hum += x.hum; a.n++;
    agg.set(i, a);
  }
  const points = [...agg.entries()].sort((a, b) => a[0] - b[0]).map(([i, a]) => ({
    t: start + i * size + size / 2, min: r1(a.min), max: r1(a.max), avg: r1(a.sum / a.n), hum: Math.round(a.hum / a.n),
  }));
  return {
    device: { id: device.id, name: device.name, minTemp: device.minTemp, maxTemp: device.maxTemp },
    range: rangeKey, from: start, to: now, points, stats: stats(list, device),
  };
}

// Latest raw readings straight from the Stream (XREVRANGE = newest first).
async function latest(deviceId, count = 20) {
  await devices.get(deviceId);
  const rows = await redis.xrevrange(`telemetry:${deviceId}`, '+', '-', 'COUNT', Math.min(count, 100));
  return rows.map(([sid, f]) => {
    const o = {};
    for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1];
    return { ts: Number(sid.split('-')[0]), temp: Number(o.temp), hum: Number(o.hum), battery: Number(o.battery), door: o.door === '1' };
  });
}

// ---------- offline detection ----------
async function sweepOffline() {
  const cutoff = Date.now() - config.offlineAfterSec * 1000;
  const ids = await redis.smembers('devices');
  let flagged = 0;
  for (const id of ids) {
    const d = await devices.get(id).catch(() => null);
    if (!d || d.status === 'offline' || !d.lastSeen || d.lastSeen >= cutoff) continue;
    await redis.multi()
      .hset(`device:${id}`, 'status', 'offline')
      .smove(`idx:status:${d.status}`, 'idx:status:offline', id)
      .exec();
    await alerts.raise(d, 'OFFLINE', 'critical',
      `No data received for ${Math.round((Date.now() - d.lastSeen) / 60e3)} min`, null, config.offlineAfterSec, Date.now());
    await publish('device_status', { id, status: 'offline' });
    flagged++;
  }
  return flagged;
}

module.exports = { ingest, history, latest, readings, stats, mkt, sweepOffline, dayKey };
