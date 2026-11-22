const config = require('./config');
const { redis } = require('./redis');
const { createApp } = require('./app');
const { ensureDefaultUsers } = require('./auth');
const events = require('./events');
const telemetry = require('./telemetry');
const simulator = require('./simulator');

async function main() {
  await redis.ping();
  await ensureDefaultUsers();
  await events.startHub();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`\n  ColdChain Monitor running at http://localhost:${config.port}`);
    console.log(`  Redis: ${config.redisUrl} (db ${config.redisDb})\n`);
  });

  // One simulator tick first, so simulated devices are "fresh" before the first offline sweep
  // (otherwise a restart after a short downtime would flag every simulated sensor as offline).
  if (config.simulator) { await simulator.tick(); simulator.start(); }
  const sweep = setInterval(() => telemetry.sweepOffline().catch((e) => console.error('[sweep]', e.message)), 30e3);
  sweep.unref();
  telemetry.sweepOffline().catch(() => {});

  const shutdown = async () => {
    console.log('\nShutting down...');
    simulator.stop();
    clearInterval(sweep);
    await events.stopHub();
    server.close(() => redis.quit().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  if (e.code === 'ECONNREFUSED') console.error(`\nCannot reach Redis at ${config.redisUrl}. Start it first (see README).\n`);
  else console.error(e);
  process.exit(1);
});
