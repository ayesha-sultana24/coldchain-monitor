# ColdChain Monitor

**Real-time IoT temperature monitoring for vaccines, blood and medicines, built on Redis.**

A DBMS case-study project (Advanced Database / NoSQL). Sensors in refrigerators, freezers and cold rooms
stream temperature readings; the system stores them, detects unsafe conditions, raises alerts, and shows
live dashboards and compliance analytics.

---

## 1. Problem statement

Vaccines, blood, plasma and insulin must stay inside a strict temperature band (for example 2 to 8 °C).
A single unnoticed power cut or open door can silently destroy an entire batch, and without monitoring the
failure may only be discovered when someone opens the fridge the next morning, long after the stock is
compromised. (For your report, cite a WHO or Ministry of Health source for cold-chain wastage figures.)

A monitoring system for this problem has unusual data needs:

| Need | What it demands from the database |
|---|---|
| Thousands of tiny writes per minute from sensors | Very fast writes, no heavy schema or joins |
| "Show me the last 6 hours for this fridge" | Cheap time-range queries |
| Alert within seconds, not minutes | In-memory speed + push notifications |
| One alert per incident, not one per reading | Atomic de-duplication |
| Dashboard counts, leaderboards, filters | Fast counters, sorted rankings, set operations |
| Old readings are worthless after a while | Built-in expiry / trimming |

## 2. Objectives

1. Ingest sensor readings (temperature, humidity, battery, door state) over an authenticated HTTP API.
2. Detect **temperature excursions, humidity, door-open, low battery and offline** conditions automatically.
3. Manage the alert lifecycle: open → acknowledged → resolved (with automatic recovery).
4. Provide a live dashboard, device history charts and compliance analytics (including Mean Kinetic Temperature).
5. Demonstrate the strengths of Redis as an advanced NoSQL database using **eight different data structures**.
6. Be secure, validated, tested and easy to run locally.

## 3. Why Redis? (database choice)

| Requirement | Redis feature used |
|---|---|
| Time-series range queries | **Sorted Set** scored by timestamp (`ZRANGEBYSCORE`, O(log N + M)) |
| Raw event log | **Stream** (`XADD`, `XREVRANGE`) with size cap |
| Device registry & alert records | **Hash** (field-level read/write, no schema migrations) |
| Filtering by site / status / product | **Sets** + `SINTER` (multi-filter AND in one command) |
| Name search with prefix matching | Sorted Set lexicographic index (`ZRANGEBYLEX`) |
| Leaderboard of risky devices | Sorted Set with `ZINCRBY` / `ZREVRANGE WITHSCORES` |
| Distinct devices reporting today | **HyperLogLog** (`PFADD` / `PFCOUNT`, about 12 KB regardless of count) |
| Atomic "one alert per incident" | `HSETNX` (set-if-absent) |
| Atomic multi-structure write | **Lua script** (one round trip, never half-written) |
| Real-time push to browsers | **Pub/Sub** → Server-Sent Events |
| Sessions that expire on their own | Key **TTL** (`EXPIRE`) |

Everything lives in memory, so reads and writes take microseconds, which is what an alerting system needs.
**Trade-offs** (worth mentioning in a viva): there are no joins and no foreign keys, so the application keeps the
secondary indexes consistent (using `MULTI/EXEC` and Lua); the dataset must fit in RAM, which is why readings
are trimmed after 7 days; and Redis is not a replacement for a long-term archive (a real deployment would
export old data to a data warehouse).

## 4. Architecture

```
 ┌──────────────┐  POST /api/ingest/:id        ┌─────────────────────────────┐
 │ IoT sensors  │  (x-device-key)  ──────────► │  Node.js + Express (REST)   │
 │ or built-in  │                              │  validation · auth · rules  │
 │ simulator    │                              └──────┬───────────────▲──────┘
 └──────────────┘                                     │ ioredis       │ SSE (Pub/Sub fan-out)
                                                      ▼               │
                                         ┌────────────────────────────┴───┐
   Browser (vanilla JS SPA)  ◄── REST ──►│            Redis 7             │
   dashboard · charts · alerts           │ Hash · Set · ZSet · Stream     │
                                         │ HLL · Pub/Sub · Lua · TTL      │
                                         └────────────────────────────────┘
```

Request flow for one reading:

1. Device sends `{temp, hum, battery, door}` with its API key → validated.
2. **Lua script** atomically updates the device Hash, appends to the Stream, adds to the time-series Sorted Set,
   updates the daily HyperLogLog, and moves the device between status Sets.
3. Alert rules run; `HSETNX` guarantees one alert per incident; recovery auto-resolves alerts.
4. A `reading` / `alert` message is **published**; the server pushes it to every open browser over SSE.

## 5. Technology stack

| Layer | Technology |
|---|---|
| Database | Redis 7+ |
| Backend | Node.js 18+, Express 5, ioredis, helmet, express-rate-limit |
| Frontend | HTML, CSS and vanilla JavaScript (no build step); charts are hand-drawn SVG |
| Real time | Redis Pub/Sub + Server-Sent Events |
| Tests | Node's built-in test runner (`node:test`), 17 integration tests |

## 6. Database design

Redis has no tables, so the design is a **key schema**. `{x}` marks a variable part.

### 6.1 Entities and key schema

| Key pattern | Type | Contents | Notes |
|---|---|---|---|
| `site:{id}` | Hash | `id, name, city, type, createdAt` | type: warehouse / hospital / clinic / pharmacy |
| `sites` | Set | all site ids | |
| `device:{id}` | Hash | see 6.2 | config + latest state |
| `devices` | Set | all device ids | |
| `telemetry:{deviceId}` | **Stream** | `temp, hum, battery, door` per entry | capped (about 5000 entries) |
| `ts:temp:{deviceId}` | **Sorted Set** | member `ts\|temp\|hum\|door`, score = timestamp (ms) | trimmed to 7 days |
| `alert:{id}` | Hash | see 6.3 | |
| `alerts:time` | Sorted Set | alert ids scored by creation time | newest-first listing, per-day counts |
| `active:{deviceId}` | Hash | `alertType → alertId` | `HSETNX` de-duplication |
| `risk:board` | Sorted Set | deviceId scored by weighted alert count | leaderboard |
| `stats:alert:type` | Hash | `type → counter` | `HINCRBY` |
| `hll:active:{YYYY-MM-DD}` | HyperLogLog | devices that reported that day | |
| `user:{username}` | Hash | `username, role, salt, hash, createdAt` | scrypt-hashed password |
| `users` | Set | usernames | |
| `session:{token}` | Hash + **TTL** | `username, role` | expires after 8 h idle |
| `seq:alert`, `seq:device` | String | auto-increment counters | `INCR` |
| `cc:events` | Pub/Sub channel | JSON events | live updates |

### 6.2 `device:{id}` fields

| Field | Type | Rule |
|---|---|---|
| `id` | string | 3-24 chars, letters/digits/hyphen, unique |
| `name` | string | 3-60 chars, no `<`, `>` or control characters |
| `siteId` | string | must reference an existing site |
| `type` | enum | `cold_room`, `fridge`, `freezer`, `ultra_freezer` |
| `productClass` | enum | `vaccine`, `blood`, `insulin`, `medicine` |
| `minTemp`, `maxTemp` | number | -100 to 40 °C, `minTemp < maxTemp` |
| `maxHum` | number | 1 to 100 (%), default 80 |
| `simulated` | `0/1` | driven by the built-in simulator or a real sensor |
| `status` | enum | `normal`, `excursion`, `offline`, `unknown` |
| `lastSeen`, `lastTemp`, `lastHum`, `battery`, `door` | number | latest reading |
| `keyHash` | string | SHA-256 of the device API key (key is shown once) |
| `createdAt`, `updatedAt` | number | epoch ms |

### 6.3 `alert:{id}` fields

`id, deviceId, deviceName, siteId, type, severity (warning|critical), message, value, threshold, createdAt,
status (open|acknowledged|resolved), ackBy, ackAt, resolvedAt, resolvedBy`

Alert types: `TEMP_HIGH`, `TEMP_LOW`, `HUMIDITY_HIGH`, `DOOR_OPEN`, `BATTERY_LOW`, `OFFLINE`.

### 6.4 Indexes (secondary indexes built from Sets)

| Index | Type | Used for |
|---|---|---|
| `idx:site:{siteId}` | Set of device ids | filter devices by site |
| `idx:class:{productClass}` | Set | filter by product |
| `idx:type:{type}` | Set | filter by equipment |
| `idx:status:{status}` | Set | filter by live status (updated atomically in Lua) |
| `idx:name` | Sorted Set (score 0) | prefix search on each word of the name and the id |
| `idx:alert:status:{s}` / `severity:{s}` / `site:{id}` / `device:{id}` / `type:{t}` | Sets of alert ids | alert filtering |

A multi-filter query is simply `SINTER idx:site:hyd-central idx:class:vaccine idx:status:excursion`.
In SQL this would be a multi-table join with a `WHERE ... AND ...`.

### 6.5 Sample data (created by `npm run seed`)

* **3 sites:** Hyderabad Central Vaccine Store, City General Hospital, PHC Shamirpet
* **8 devices:** cold room, ultra-low freezer (-90 to -60 °C), vaccine fridges, blood bank fridge, plasma freezer,
  insulin fridge, outreach cold box
* **72 hours of readings** at 5-minute intervals (about 6,900 readings) with scripted door-open and power-failure events
* **Alerts generated from that history**, a device with a nearly flat battery, and one device that has stopped
  reporting (detected as **offline**)
* **2 users:** `admin` / `Admin@123` (full access) and `viewer` / `Viewer@123` (read-only)

## 7. Features

| Module | What it does |
|---|---|
| **Dashboard** | KPI strip, live device cards (temperature updates in real time), open-alert panel |
| **Devices (CRUD)** | Create, view, edit, delete; search by name/ID; filter by site, status, product; sort |
| **Device detail** | History chart (1 h to 7 d) with safe-range band and excursion markers; min/avg/max, MKT, time-in-range, excursion count; latest raw readings from the Stream |
| **Alerts** | Filter by status, severity, site, type; acknowledge / resolve; automatic recovery; severity escalation (a worsening warning becomes critical without a duplicate alert) |
| **Analytics** | Alerts per day, highest-risk devices, alerts by type and site, 24 h compliance table |
| **Sites (CRUD)** | Create and delete facilities (deletion blocked while devices exist) |
| **Ingest API** | Authenticated by per-device API key; idempotent (same timestamp overwrites) |
| **Simulator** | Generates realistic readings, door events and power failures; "Simulate" buttons make demos reliable |
| **Auth** | Login, roles (admin / viewer), expiring sessions |

**Mean Kinetic Temperature (MKT)** is the standard (WHO / USP) way to express a fluctuating temperature profile as
a single "equivalent" temperature for stability purposes: `MKT = (ΔH/R) / -ln( Σ e^(-ΔH/RT_i) / n )`, with ΔH/R = 10000 K.

## 8. Redis features demonstrated (viva cheat-sheet)

Start `redis-cli` (add `-n <db>` if you changed `REDIS_DB`) and try:

```bash
HGETALL device:CC-HYD-01                          # Hash: config + latest state
XREVRANGE telemetry:CC-HYD-01 + - COUNT 3         # Stream: newest 3 raw readings
ZREVRANGE ts:temp:CC-HYD-01 0 2                   # Sorted Set time-series: newest 3 (score = timestamp)
SINTER idx:class:vaccine idx:status:normal        # Sets: multi-filter AND
ZRANGEBYLEX idx:name "[plas" "[plas\xff"          # Lexicographic prefix search
ZREVRANGE risk:board 0 -1 WITHSCORES              # Leaderboard
PFCOUNT hll:active:2026-11-21                     # HyperLogLog (use today's date)
HGETALL active:CC-PHC-01                          # HSETNX de-duplication markers
SMEMBERS idx:alert:status:open                    # Open alerts
KEYS session:*                                    # then: TTL session:<token>  -> counts down
SUBSCRIBE cc:events                               # watch live events (run the app in another terminal)
```

| Operation | Command | Complexity |
|---|---|---|
| Time-range query | `ZRANGEBYSCORE` | O(log N + M) |
| Append reading | `XADD` | O(1) |
| Filter intersection | `SINTER` | O(N·K), N = smallest set |
| Prefix search | `ZRANGEBYLEX` | O(log N + M) |
| Leaderboard top-5 | `ZREVRANGE` | O(log N + 5) |
| Unique count | `PFCOUNT` | O(1) |

The atomic ingest script is in [`src/ingest.lua`](src/ingest.lua).

## 9. Security and validation

* **Input validation** on every endpoint ([`src/validators.js`](src/validators.js)): types, ranges, enums, lengths,
  cross-field rules (`minTemp < maxTemp`), rejected control characters and `<` `>`. Errors return HTTP 400 with a list of problems.
* **Passwords** hashed with scrypt and a per-user salt; constant-time comparison; login always does the hashing
  work so response time does not reveal whether a username exists.
* **Sessions** are random 192-bit tokens stored in Redis with a sliding TTL. **Roles** are enforced on the server
  (viewers get HTTP 403 on every write).
* **Device API keys**: random 128-bit; only the SHA-256 hash is stored; verified in constant time.
* **Rate limiting:** 10 login attempts per 15 minutes per IP, 600 requests per minute overall.
* **helmet** sets security headers (CSP, no sniffing, etc.); JSON bodies limited to 20 KB.
* **XSS:** all dynamic text in the UI goes through an `esc()` function; the CSP blocks inline scripts.
* **Injection:** Redis commands are built from validated values only (there is no query language to inject into).
* **Errors** never leak stack traces (generic 500 message, details only in the server log).

Known limitations (acceptable for a course project): no HTTPS (put it behind a reverse proxy), the live stream passes
the session token in the URL because browsers' `EventSource` cannot send headers, no user-management UI, and a single Redis node.

## 10. Setup and run

### Prerequisites
* **Node.js 18 or newer** (20+ recommended)
* **Redis 7.0 or newer** (needed for stream auto-IDs)

### Install Redis (pick one)
```bash
# macOS
brew install redis && brew services start redis
# Ubuntu / Debian / WSL
sudo apt install redis-server && sudo service redis-server start
# Any OS with Docker
docker compose up -d          # uses the included docker-compose.yml
```
Check it with `redis-cli ping` (should print `PONG`). On Windows use WSL or Docker.

### Run the project
```bash
cd coldchain-monitor
npm install
npm run seed        # loads demo data (use "npm run reseed" to wipe the Redis db and start over)
npm start           # http://localhost:3000
```
Open **http://localhost:3000** and sign in as `admin` / `Admin@123`.

> `npm run reseed` runs `FLUSHDB` on the configured Redis database. Use a dedicated db with `REDIS_DB=5` if your
> local Redis holds other data.

### Configuration (environment variables, all optional)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | web port |
| `REDIS_URL` | `redis://127.0.0.1:6379` | connection string |
| `REDIS_DB` | 0 | Redis database number |
| `ADMIN_PASSWORD`, `VIEWER_PASSWORD` | `Admin@123`, `Viewer@123` | passwords for the default users (used only when no users exist) |
| `SIMULATOR` | `on` | `off` if real sensors send the data |
| `SIM_INTERVAL_MS` | 5000 | simulator tick |
| `OFFLINE_AFTER_SEC` | 120 | silence before a device is flagged offline |
| `TZ_OFFSET_MIN` | 330 | timezone offset used for "reporting today" (IST) |

### Run the tests
```bash
npm test            # 17 integration tests, uses Redis db 15 and never touches your demo data
```

### Try a "real" sensor
`npm run seed` saves each device's API key in `.demo-keys.json`.
```bash
curl -X POST http://localhost:3000/api/ingest/CC-PHC-03 \
  -H "Content-Type: application/json" -H "x-device-key: <key from .demo-keys.json>" \
  -d '{"temp": 4.9, "hum": 44, "battery": 66, "door": false}'
```
CC-PHC-03 is the "offline" device: this reading brings it back online and resolves its alert.

### Suggested demo flow (5 minutes)
1. **Dashboard:** show live cards, the open alerts (low battery, offline device).
2. Open **Vaccine Refrigerator V3 → Simulate power failure**: watch the temperature climb, the card turn red, a toast
   appear, and the alert escalate from warning to critical (no duplicate alert).
3. Open **Alerts**, acknowledge it, filter by status/severity/site.
4. **Analytics:** compliance, MKT, risk leaderboard (show the `ZREVRANGE` caption on each card).
5. In `redis-cli`, run the commands from section 8 on the same data.

## 11. REST API summary

All routes except `/api/health`, `/api/auth/login` and `/api/ingest/:id` need `Authorization: Bearer <token>`.
`(admin)` = admin role required.

| Method & path | Purpose |
|---|---|
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` | authentication |
| `POST /api/ingest/:id` | device reading (header `x-device-key`) |
| `GET /api/devices?q=&site=&status=&class=&type=&sort=` | search / filter / sort |
| `POST /api/devices` (admin) · `GET/PUT/DELETE /api/devices/:id` (PUT, DELETE admin) | device CRUD |
| `GET /api/devices/:id/history?range=1h\|6h\|24h\|72h\|7d` | bucketed series + statistics |
| `GET /api/devices/:id/latest?count=` | newest raw readings (Stream) |
| `POST /api/devices/:id/simulate` (admin) | trigger a simulated door/power event |
| `GET /api/alerts?status=&severity=&site=&device=&type=&limit=` | filtered alerts |
| `POST /api/alerts/:id/acknowledge` · `POST /api/alerts/:id/resolve` (admin) | lifecycle |
| `GET/POST /api/sites` · `DELETE /api/sites/:id` (POST, DELETE admin) | site CRUD |
| `GET /api/summary` · `GET /api/analytics` | dashboard numbers |
| `GET /api/stream?token=` | live Server-Sent Events |

## 12. Project structure

```
coldchain-monitor/
├── src/
│   ├── server.js        start-up, simulator, offline sweeper, graceful shutdown
│   ├── app.js           Express routes, middleware, error handling
│   ├── config.js        environment configuration
│   ├── redis.js         connection + registers the Lua script
│   ├── ingest.lua       atomic multi-structure ingest
│   ├── validators.js    input validation
│   ├── auth.js          users, scrypt, sessions, roles
│   ├── sites.js         site CRUD
│   ├── devices.js       device CRUD, indexes, search, API keys
│   ├── telemetry.js     ingest, alert rules, history, statistics, MKT, offline detection
│   ├── alerts.js        alert lifecycle, de-duplication, escalation, filtering
│   ├── analytics.js     summary and analytics queries
│   ├── events.js        Pub/Sub → SSE hub
│   ├── signal.js        physical model of a cold-storage unit
│   └── simulator.js     built-in virtual sensors
├── scripts/seed.js      demo data generator
├── public/              index.html, styles.css, app.js (single-page UI)
├── tests/api.test.js    17 integration tests
├── docker-compose.yml   optional Redis container
└── README.md
```

## 13. Possible extensions

Redis Cluster / replication for high availability; RedisTimeSeries module for compression and downsampling rules;
SMS / e-mail notification on critical alerts; archiving expired readings to PostgreSQL; MQTT bridge for real sensors.
