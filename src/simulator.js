// Built-in IoT simulator: plays the role of the sensors so the demo works with no hardware.
// Devices with simulated=true get a reading every tick. Real devices use POST /api/ingest/:id instead.
const config = require('./config');
const devices = require('./devices');
const telemetry = require('./telemetry');
const { Signal } = require('./signal');

const signals = new Map();
let timer = null;
let busy = false;

function signalFor(d) {
  let s = signals.get(d.id);
  if (!s) {
    s = new Signal(d, { k: 0.15, battery: d.battery ?? 90, drain: 0.0004 });
    if (d.lastTemp !== null) s.temp = d.lastTemp; // continue smoothly from the last stored value
    signals.set(d.id, s);
  }
  return s;
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const list = (await devices.list()).filter((d) => d.simulated);
    for (const d of list) {
      const s = signalFor(d);
      if (!s.mode) {
        const roll = Math.random();
        if (roll < 0.003) s.start('door');
        else if (roll < 0.0035) s.start('power');
      }
      const r = s.next();
      await telemetry.ingest(d.id, { ...r, ts: Date.now() }).catch((e) => console.error('[sim]', d.id, e.message));
    }
  } finally {
    busy = false;
  }
}

// Used by the "simulate excursion" button so the demo does not depend on luck.
async function trigger(deviceId, kind) {
  const d = await devices.get(deviceId);
  if (!d.simulated) return false;
  signalFor(d).start(kind);
  return true;
}

function start() {
  if (timer) return;
  timer = setInterval(tick, config.simulatorIntervalMs);
  timer.unref();
  console.log(`[sim] simulator running, one reading per device every ${config.simulatorIntervalMs / 1000}s`);
}

function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, trigger, tick };
