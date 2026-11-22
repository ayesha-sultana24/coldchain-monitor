const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');
const config = require('./config');

const options = { db: config.redisDb, maxRetriesPerRequest: 3 };

function createClient() {
  const client = new Redis(config.redisUrl, options);
  client.on('error', (e) => console.error('[redis]', e.message));
  return client;
}

const redis = createClient();

// Register the Lua script as a custom command: redis.ccIngest(...)
redis.defineCommand('ccIngest', {
  numberOfKeys: 4,
  lua: fs.readFileSync(path.join(__dirname, 'ingest.lua'), 'utf8'),
});

module.exports = { redis, createClient };
