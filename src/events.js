// Real-time updates: services PUBLISH to a Redis channel, a single SUBSCRIBEd connection
// fans the messages out to every browser connected over Server-Sent Events.
const { redis, createClient } = require('./redis');

const CHANNEL = 'cc:events';
const clients = new Set();
let subscriber = null;

function publish(type, data) {
  return redis.publish(CHANNEL, JSON.stringify({ type, data })).catch(() => {});
}

async function startHub() {
  if (subscriber) return;
  subscriber = createClient();
  await subscriber.subscribe(CHANNEL);
  subscriber.on('message', (_ch, message) => {
    for (const res of clients) res.write(`data: ${message}\n\n`);
  });
}

function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
  req.on('close', () => {
    clearInterval(beat);
    clients.delete(res);
  });
}

async function stopHub() {
  for (const res of clients) res.end();
  clients.clear();
  if (subscriber) { await subscriber.quit().catch(() => {}); subscriber = null; }
}

module.exports = { publish, startHub, addClient, stopHub };
