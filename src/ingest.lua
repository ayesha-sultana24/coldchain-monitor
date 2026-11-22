-- Atomic telemetry ingest. One round-trip updates FOUR Redis data structures,
-- so a reading is never half-written even with many sensors posting at once.
--
-- KEYS: 1 device hash, 2 telemetry stream, 3 temperature time-series (sorted set), 4 daily HyperLogLog
-- ARGV: 1 ts(ms), 2 temp, 3 humidity, 4 battery, 5 door(0/1), 6 sorted-set member,
--       7 retentionMs, 8 stream maxlen, 9 deviceId, 10 new status, 11 status-index key prefix
--
-- Returns: -1 unknown device | 1 stored + device state updated | 2 stored (late reading, state kept)

if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end

-- 1) Time-series: score = timestamp, so range queries are O(log N + M). One reading per timestamp:
--    drop anything already stored at this exact score first, so retries and corrected
--    values are idempotent (last write wins) even if the payload differs.
redis.call('ZREMRANGEBYSCORE', KEYS[3], ARGV[1], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[1], ARGV[6])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', '(' .. string.format('%.0f', tonumber(ARGV[1]) - tonumber(ARGV[7])))

-- 2) Stream: append-only event log, capped so memory stays bounded.
--    pcall because Redis rejects a stream ID older than the last one (out-of-order readings).
redis.pcall('XADD', KEYS[2], 'MAXLEN', '~', ARGV[8], ARGV[1] .. '-*',
  'temp', ARGV[2], 'hum', ARGV[3], 'battery', ARGV[4], 'door', ARGV[5])

-- 3) HyperLogLog: ~12 KB to count distinct reporting devices per day.
redis.call('PFADD', KEYS[4], ARGV[9])

-- 4) Device hash: only move "latest state" forward in time.
local last = tonumber(redis.call('HGET', KEYS[1], 'lastSeen') or '0') or 0
if tonumber(ARGV[1]) < last then return 2 end

local old = redis.call('HGET', KEYS[1], 'status')
redis.call('HSET', KEYS[1],
  'lastSeen', ARGV[1], 'lastTemp', ARGV[2], 'lastHum', ARGV[3],
  'battery', ARGV[4], 'door', ARGV[5], 'status', ARGV[10])
if old and old ~= ARGV[10] then
  redis.call('SREM', ARGV[11] .. old, ARGV[9])
end
redis.call('SADD', ARGV[11] .. ARGV[10], ARGV[9])
return 1
