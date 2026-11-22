// Loads realistic demo data: 3 sites, 8 devices, 72 hours of 5-minute readings with scripted
// door-open / power-failure events, plus the alerts those events generate.
//   npm run seed              (refuses to run if data already exists)
//   npm run seed -- --reset   (FLUSHDB on the configured Redis db, then seeds)
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { redis } = require('../src/redis');
const { ensureDefaultUsers } = require('../src/auth');
const sites = require('../src/sites');
const devices = require('../src/devices');
const telemetry = require('../src/telemetry');
const { Signal, mulberry32 } = require('../src/signal');

const STEP = 5 * 60e3;
const HOURS = 72;
const STEPS = (HOURS * 3600e3) / STEP;

const SITES = [
  { id: 'hyd-central', name: 'Hyderabad Central Vaccine Store', city: 'Hyderabad', type: 'warehouse' },
  { id: 'city-general', name: 'City General Hospital', city: 'Secunderabad', type: 'hospital' },
  { id: 'phc-shamirpet', name: 'PHC Shamirpet', city: 'Shamirpet', type: 'clinic' },
];

// events: [hoursAgo, kind, steps]
const DEVICES = [
  { id: 'CC-HYD-01', name: 'Walk-in Cold Room A', siteId: 'hyd-central', type: 'cold_room', productClass: 'vaccine', minTemp: 2, maxTemp: 8, maxHum: 80, simulated: true, events: [[5, 'door', 2]], battery: [96, 90] },
  { id: 'CC-HYD-02', name: 'Ultra-Low Freezer U1', siteId: 'hyd-central', type: 'ultra_freezer', productClass: 'vaccine', minTemp: -90, maxTemp: -60, maxHum: 80, simulated: true, events: [[20, 'door', 2]], battery: [93, 88] },
  { id: 'CC-HYD-03', name: 'Vaccine Refrigerator V3', siteId: 'hyd-central', type: 'fridge', productClass: 'vaccine', minTemp: 2, maxTemp: 8, maxHum: 80, simulated: true, events: [[26, 'power', 5], [9, 'door', 2]], battery: [90, 82] },
  { id: 'CC-BB-01', name: 'Blood Bank Refrigerator', siteId: 'city-general', type: 'fridge', productClass: 'blood', minTemp: 1, maxTemp: 6, maxHum: 80, simulated: true, events: [[10, 'door', 2], [33, 'door', 2]], battery: [88, 80] },
  { id: 'CC-BB-02', name: 'Plasma Freezer', siteId: 'city-general', type: 'freezer', productClass: 'blood', minTemp: -40, maxTemp: -25, maxHum: 80, simulated: true, events: [], battery: [94, 89] },
  { id: 'CC-PHC-01', name: 'Ice-Lined Refrigerator', siteId: 'phc-shamirpet', type: 'fridge', productClass: 'vaccine', minTemp: 2, maxTemp: 8, maxHum: 60, simulated: true, events: [[50, 'power', 5], [3, 'door', 2]], battery: [60, 14] },
  { id: 'CC-PHC-02', name: 'Insulin Storage Fridge', siteId: 'phc-shamirpet', type: 'fridge', productClass: 'insulin', minTemp: 2, maxTemp: 8, maxHum: 80, simulated: true, events: [], battery: [85, 79] },
  // Not simulated, stops reporting 30 min before the seed finishes -> detected as OFFLINE
  { id: 'CC-PHC-03', name: 'Outreach Cold Box', siteId: 'phc-shamirpet', type: 'fridge', productClass: 'medicine', minTemp: 2, maxTemp: 8, maxHum: 80, simulated: false, events: [], battery: [70, 66], stopsAgoMin: 30 },
];

async function seed({ reset = false } = {}) {
  if (await redis.scard('sites')) {
    if (!reset) {
      console.log('Data already present. Run "npm run seed -- --reset" to wipe this Redis db and reseed.');
      return false;
    }
  }
  if (reset) {
    console.log(`Flushing Redis db ${config.redisDb} ...`);
    await redis.flushdb();
  }

  await ensureDefaultUsers();
  for (const s of SITES) await sites.create(s);

  const keys = {};
  const now = Date.now();
  const start = now - HOURS * 3600e3;

  for (const [n, d] of DEVICES.entries()) {
    const { apiKey } = await devices.create(
      { id: d.id, name: d.name, siteId: d.siteId, type: d.type, productClass: d.productClass, minTemp: d.minTemp, maxTemp: d.maxTemp, maxHum: d.maxHum, simulated: d.simulated },
    );
    keys[d.id] = apiKey;

    const rand = mulberry32(1000 + n * 77);
    const [b0, b1] = d.battery;
    const sig = new Signal(d, { k: 0.5, rand, battery: b0, drain: (b0 - b1) / STEPS });
    const lastStep = d.stopsAgoMin ? STEPS - Math.round((d.stopsAgoMin * 60e3) / STEP) : STEPS;
    const scripted = new Map(d.events.map(([h, kind, steps]) => [Math.round(STEPS - (h * 3600e3) / STEP), [kind, steps]]));

    for (let i = 1; i <= lastStep; i++) {
      if (scripted.has(i)) sig.start(...scripted.get(i));
      else if (!sig.mode && rand() < 0.0015) sig.start('door', 1); // brief background door-open, no excursion
      const r = sig.next();
      await telemetry.ingest(d.id, { ...r, ts: start + i * STEP }); // last reading lands exactly at "now"
    }
    process.stdout.write(`  ${d.id} ${d.name}: ${lastStep} readings\n`);
  }

  await telemetry.sweepOffline();
  fs.writeFileSync(path.join(__dirname, '..', '.demo-keys.json'), JSON.stringify(keys, null, 2));
  console.log('\nDevice API keys saved to .demo-keys.json (used to try the HTTP ingest endpoint).');
  return true;
}

if (require.main === module) {
  seed({ reset: process.argv.includes('--reset') })
    .then(async (done) => {
      if (done) {
        const [dev, al] = await Promise.all([redis.scard('devices'), redis.zcard('alerts:time')]);
        console.log(`Seeded ${SITES.length} sites, ${dev} devices, ${al} alerts.`);
      }
    })
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => redis.quit());
}

module.exports = { seed };
