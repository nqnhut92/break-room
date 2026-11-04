# Break Room

English · [Tiếng Việt](README.vi.md) · [Architecture](docs/ARCHITECTURE.md)

A multiplayer 3D office-smashing game drawn with three.js. Join a server, walk around the office with your colleagues and smash laptops, monitors, printers and server racks. Every broken item adds to the server's "total damage", and whoever smashes the most tops the leaderboard. IT replaces everything after 25 seconds, or press "Call IT" to restore it all immediately.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000. Open another tab to play together (or send the link to someone who can reach your machine).

Local runs need no Redis: all state lives in the RAM of the `npm start` process. To mimic the Vercel setup (several servers sharing state) set `REDIS_URL=redis://localhost:6379` and start `npm start` in two terminals with different `PORT`s; tabs on both ports show the same office. `vercel dev` also works if you need the exact `api/ws.js` function, but it is not required.

## Playing together

The game has **two fixed servers**, **BR-1** and **BR-2**, with at most 20 players each. The join screen shows "x online" per server, coloured green (under 50% full), orange (from 50%) and red (from 80%), and preselects the busiest server that still has room. To play with colleagues, pick the same server; the "Copy server link" button produces `/?room=br-1` or `/?room=br-2`. There are no private rooms: an unknown room name in an old link falls back to the first server. Rename or add servers in the `ROOMS` list in `lib/world.js` (`id` lowercase ASCII, `name` is the display name).

The join screen also asks for a company role (accountant, HR, IT, dev, sale, marketing, designer, intern, security, cleaner or plain employee; shown under the name, with a hat or headphones for some, and role-specific shout-outs when smashing) and the character's look (male or female skin). The role list lives in `public/roles.js` and must match `ROLE_IDS` in `lib/world.js` (a test checks it). An optional company name (up to 20 characters, remembered in the browser) is shown next to the role under the player's name. Names are required, and a name that is already used by someone online on the same server (exact match, case-sensitive) is refused.

## Controls

| Action | How |
| --- | --- |
| Move | WASD / arrow keys, or tap the floor |
| Smash | Space (hold to keep smashing; with nothing in reach it still swings the hammer, for free), the SMASH! button, or tap an object (touch screens) |
| Emoji | Keys 1 to 8 or the emoji buttons |
| Chat | Enter or click the chat box next to the emoji bar (💬 button on touch screens); Enter sends and returns to the game |
| Zoom | Mouse wheel, pinch with two fingers, or the + / − buttons on touch screens |
| Mini map | M to hide or show it (click it too) |

**Mana.** Every smash costs 5 mana out of 100 (the blue bar under your name). Mana comes back at 3/s at first and 12/s once you have gone 2 seconds without smashing (so the walk between two far-apart objects only gives a little back), so you can burst about 20 hits, then you need roughly 10 seconds to refill. Out of mana the hit is refused and the bar flashes. Damaged objects show a health bar: green while healthy, orange from half, red on the last hit. The numbers live in `MANA` in `lib/realtime.js`; the server enforces them (kept per connection, so reconnecting refills it) and the client mirrors the same formula.

On touch screens (and with a pen), tapping the floor walks there and tapping an object walks to it and smashes it once per tap (it stops if a desk or wall is in the way); hold the SMASH! button to keep smashing. With a mouse the canvas ignores clicks: use the keyboard.

## VKL, the boss

Every server has a boss in the server room. Step in and it runs at you; a red circle on the floor shows where its fist will land, so you can dodge. Four punches (30 each) knock you out for 15 seconds, then you come back at the lobby; your health regenerates slowly when you are left alone. It does not heal, so you can hit and run; one or two players can wear it down in the end but the punches make that hard, about five take it down in around a minute, and when it falls a 500 million bounty goes to the damage board, split by damage dealt. It returns 3 to 5 minutes later. The rules, the numbers and the reasons behind them are in [docs/BOSS.md](docs/BOSS.md).

## The office

The floor is 4800×3000 and the camera follows the player (a mini map in the corner shows the whole office: you in yellow, other players in white, smashed things in red). The north half is the open office (32 desks), a pantry with printers, a water cooler and a coffee machine, a server room with glass walls and a door on the west side, and the lobby with a conference table and sofa. The east wing has the toilets (three stalls and two sinks each, with opaque walls) and a hall with rows of chairs facing a screen. The south wing has two glass meeting rooms (table, chairs, a tv), the director's room (big desk, safe worth 200 million, tv, sofa) and a lounge with sofas, tvs and a coffee machine. About 285 objects can be smashed: desks, tables, sofas, tvs, toilets, sinks, bookcases, fridges, speakers, lamps, bins and the safe included. Only the walls, glass, rugs and floors cannot be broken. Solid things (desks, walls, printers, server racks, toilets, sinks, the safe...) are obstacles: **both client and server** block them, so nobody can walk through by editing the client (`slideMove` in `lib/world.js`). A smashed solid object leaves its wreck behind, which keeps blocking (collisions never change while the game runs).

The 3D art comes from two sources:

- **Textures** (ambientCG, CC0, `public/assets/textures/`, licence note in `License.txt`): wood, carpet, tile and diamond-plate floors, colour and normal maps at 512 px (about 0.7 MB), tinted in `FLOOR_FILES` in `scene3d.js`. If a file is missing the old canvas-drawn floor is used.
- **Characters are built in code** (`makePlayer` in `scene3d.js`): round "chibi" bodies made of spheres and capsules, four hairstyles, a role hat, and the boss in a navy suit with silver hair and a crown. They are animated by code (breathing, bobbing, leaning, squash and stretch, the hammer swing), with no model files.
- **Everything else is built in code** (`public/scene3d.js`) from rounded boxes, ellipsoids, capsules and cylinders: furniture, characters, glass walls, the debris and the effects. There are no model files, so nothing to license and nothing to download. `box()` rounds the edges, `sbox()` keeps them sharp (walls).

Three.js is vendored in `public/vendor/` (MIT, licence included), not loaded from a CDN. To upgrade: `npm install three@<version> --save-dev`, then copy `three.module.min.js` (from `build`) plus `BufferGeometryUtils.js` (from `examples/jsm/utils`) into `public/vendor/`, and `RoundedBoxGeometry.js` and `RoomEnvironment.js` (from `examples/jsm/geometries` and `examples/jsm/environments`) into `public/vendor/jsm/` under the same folder names.

A browser with WebGL is required. Weak phones may stutter; on touch screens the game lowers resolution and shadows by itself.

## Deploy to Vercel

The game runs on Vercel Functions with native WebSockets (public beta, Fluid Compute). Static pages in `public/` are served by Vercel; WebSocket connections go to the `api/ws.js` function at `wss://<domain>/api/ws`.

### Why Redis

Vercel may run several instances of the function at once. Each WebSocket connection is pinned to the instance that accepted it, but a new connection (including a reconnect) can land on another instance, and RAM is not shared. Keeping state in RAM would let two players in the same server see two different offices. So all shared state lives in Redis and every broadcast goes through Redis pub/sub. **Without `REDIS_URL`, the game refuses to let anyone in on Vercel** (it shows an error) instead of silently splitting the world in two. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data model, cleanup and limits.

| In Redis (shared) | In each connection (safe because connections are pinned) |
| --- | --- |
| object health and broken state, scores, total damage, who is online, each player's last position, the "Call IT" cooldown, connection counts per IP, pub/sub channels | current position (for anti-teleport), smash and emote cooldowns, per-second message limit |

All server-side checks stay: reach, movement speed, cooldowns, rate limits, name sanitising, maximum message size. Subtracting health and awarding points is one atomic Lua script in Redis, so two players on two instances hitting the same object break it exactly once and the points are credited once.

The per-IP connection limit (10 connections per IP) lives in Redis too. In RAM each instance would count separately and the effective limit would become 10 times the number of instances. Each connection's lease expires after 60 seconds if its instance dies, so slots are not stuck.

### Steps

1. Push the repo to GitHub, choose **Add New Project** on Vercel and import it. No build command is needed. `vercel.json` already sets the static directory to `public` and the `maxDuration` of `api/ws.js`.
2. Create a Redis database (via **Storage > Marketplace**, for example Upstash Redis, or any provider, see below) and connect it. An integration adds `KV_URL` or `REDIS_URL` (a `rediss://...` TCP connection string, required for pub/sub). The game reads `REDIS_URL` first, then `KV_URL`. If your integration only provides REST variables (`KV_REST_API_URL`), add `REDIS_URL` by hand with the database's TCP/TLS connection string.
3. Make sure **Fluid Compute** is on (default for projects created after 2025-04-23; for older ones enable it under Settings > Functions and redeploy).
4. Deploy. Open `https://<domain>/api/health`: `{"ok":true,"store":"redis"}` means Redis is configured. Then open the main page and join from two browsers.

Put the function in the same region as the database (for example both in Singapore); every message crosses Redis.

### Environment variables

| Variable | Meaning |
| --- | --- |
| `REDIS_URL` or `KV_URL` | Redis (TCP) connection string. Required on Vercel. Optional locally |
| `WS_MAX_DURATION_S` | Maximum lifetime of a WebSocket connection. Default 300 on Vercel, 0 (no limit) locally. Set it to your `maxDuration` if you raise it (Pro plan) |
| `RESPAWN_MS` | Time before smashed objects are replaced, default 25000 |
| `AFK_MS` | A player who does nothing (no move, smash or emoji) for this many ms is disconnected with code 4002, default 180000 (3 minutes). The client does not reconnect by itself and shows a join button; the score is kept. Stops forgotten tabs from keeping a Vercel instance alive (memory is billed while an instance is alive) |
| `MAX_CONNECTIONS` | Maximum connections per instance. Default 200 on Vercel, unlimited locally |
| `MAX_ROOMS` | Maximum rooms per instance. Default 40 on Vercel, unlimited locally. Almost irrelevant with the fixed server list |
| `FIXED_ROOMS=0` | Allow any room name instead of only those in `ROOMS` (for experiments and tests) |
| `GAME_DISABLED=1` | Kill switch: everyone gets "Game temporarily closed" and the server opens no Redis connection. Set it and redeploy |
| `REDIS_TLS_CA` | CA certificate (PEM) for Redis providers with a self-signed chain, for example Redis Cloud paid plans. `\n` may stand for a newline |
| `HEALTH_KEY` | If set, `/api/health?deep=<HEALTH_KEY>` performs the deep check (below) |
| `ROOM_TTL_S` | A room with nobody in it loses its state after this many seconds, default 1800 |
| `PORT` | Port for local runs, default 3000 |
| `TRUST_PROXY=1` | Only needed when running `server.js` behind a reverse proxy outside Vercel (Render, Railway, Nginx...) so connections are counted per real IP. Always on in Vercel |

### What happens when a connection is cut after 5 minutes

A WebSocket is closed when the function reaches `maxDuration` (Hobby: 300 s, Pro: up to 800 s, the beta extends it to 1800 s). The game handles this in two layers:

- **Seamless handover**: about 25 seconds before the deadline the server sends `renew`. The client opens a new socket, rejoins with the same token, then closes the old one. Nobody sees "left/joined", no frame drops.
- **Reconnect on sudden loss** (network, new deploy, reclaimed instance): the client retries with exponential backoff 1 s, 2 s, 4 s... up to 10 s with jitter. Each tab keeps a token in `sessionStorage`, so rejoining keeps the same id, score, position and smashed objects. A player only leaves the online list if the connection is really gone.

If an instance dies without cleaning up, the others remove its players after 20 seconds without a heartbeat.

Web Analytics: `public/index.html` loads Vercel's cookie-free `/_vercel/insights/script.js` (skipped on localhost). Switch it on once under the project's **Analytics** tab in Vercel; nothing else is needed.

### What players see when you deploy

Every Vercel build writes `lib/build-info.json` (`scripts/stamp-assets.js`): the same version it stamps into the page's module URLs, plus the build time. The page knows its own version from its `game.js?v=...` URL.

- **Joining a newer server with an old page**: the `welcome` message carries the server's `build`. If it differs from the page's version, the player gets an "update available" dialog with a reload button.
- **Playing while a newer deploy goes live**: the first instance of the new build publishes `{ v, t }` on the shared `__build` channel. Instances of an older build (they keep running for a while, up to `maxDuration`) hear it, send every local player an `update` message (the same dialog) and disconnect them with code **4003** after 20 seconds (`updateGraceMs`). The client does not reconnect on 4003; the button reloads the page.
- **Open pages notice by themselves**: the build also writes a static `public/version.json` (same version). Every open page fetches it every 30 seconds and when the tab comes back to the front; a different version means a deploy happened, so the player sees the dialog at once, with a 20 second countdown, and is then disconnected. This works even if no server has told them, and costs no function invocations (it is a static file).
- **Only newer is acted on**: an instance ignores announcements with an older or equal build time, so a late cold start of an old deploy does not kick anyone. Locally (`npm start`) the version is `dev` and nothing of this runs.
- The server push needs the new function to start, that is, a first player reaching it; the `version.json` check above does not, so it is the one that makes sure everybody is told within about 30 seconds.

### Beta limitations

- WebSockets on Vercel are in **public beta** (since 2026-06-22); the docs say behaviour and API may change. Follow the changelog before relying on it for anything important.
- The docs give no number for concurrent connections per instance. There is no real-world load data for this game yet.
- Every message goes through Redis, so latency depends on the distance between the function region and the database. Put them in the same region.
- Cost: Fluid Compute Active CPU, Provisioned Memory and Invocations, plus Redis commands. Each room with players costs about 1 Redis command per second for housekeeping and heartbeats (per instance holding that room), plus pub/sub for position messages while someone moves, plus a few commands per smash. Check your Redis plan's limits.
- Redis pub/sub does not guarantee delivery. If the Redis connection drops, a message may be lost. Clients are fully resynchronised the next time they join.
- Vercel's firewall and rate limits apply to every upgrade request, so do not set rules too tightly.

### Fallback

`server.js` runs on any always-on Node host (Render, Railway, Fly.io, a VPS): `npm install && npm start`. A single process needs no Redis (state lives in RAM and is lost on restart). To run several instances set `REDIS_URL` as above. The repo has no Dockerfile.

Health checks: `GET /healthz` with `server.js`, `GET /api/health` on Vercel (only checks that the Redis variable is set). `GET /api/health?deep=<HEALTH_KEY>` really connects to Redis, writes a `br:keepalive` key with a 3-day expiry and returns `pingMs`. Free Redis plans delete a database after about two weeks without any command, so point a free uptime monitor (for example UptimeRobot) at this URL once or twice a day: it keeps the database alive and alerts you when the game breaks.

### Choosing and testing a Redis provider

Before pasting `REDIS_URL` into Vercel, run this on your machine:

```bash
REDIS_URL='rediss://user:password@host:port' npm run check:store
```

The script checks connection, latency, `SET`/`GET`, Lua (`EVAL`), pub/sub, 20 simultaneous connections, and runs the game's own store (join, smash, snapshot, housekeeping, Call IT). It only creates keys in a temporary room, deletes them, and never prints the connection string. Notes on plans (figures as of 2026-11, check their pricing pages again):

- **Redis Cloud Free (30 MB)**: 30 connections, 100 ops/s, 5 GB bandwidth per month, no monthly command quota. **No TLS** (stated in their docs), so use a password unique to this database. The database is deleted after about 14 days without any command (use the `deep` health check above). Their docs do not confirm that Lua and pub/sub work on the Free plan, so run the script first.
- **Redis Cloud Essentials (paid, about $5/month)**: TLS (enable it under Security; may need `REDIS_TLS_CA`), 256 connections, 1000 ops/s, 100 GB bandwidth.
- **Upstash Free**: 500K commands/month, one database. If you attach a payment card, their docs say all free resources on the account become paid.
- The game cuts commands when everyone is on one instance (positions stay in-process, Redis is used only when someone is on another instance), but it still spends commands on housekeeping every few seconds and on every smash.

## Layout

```
api/ws.js            Vercel function that accepts WebSockets (exports an http server with a WebSocketServer)
api/health.js        reports whether Redis is configured; ?deep=KEY pings Redis for real
api/rooms.js         server list with online counts for the join screen (CDN cached 10 s)
lib/room-list.js     counts players per server with one store command, short in-process cache
scripts/check-store.js  checks whether a given Redis can run the game
lib/realtime.js      game logic and WebSocket wiring, unaware of where it runs
lib/world.js         office layout, object types, obstacles and collision helpers (fixed)
lib/store-redis.js   shared state + pub/sub in Redis (atomic Lua scripts)
lib/store-memory.js  same interface in RAM, for local runs and tests
lib/config.js        picks the store from environment variables
server.js            local run: static files + WebSocket at /api/ws
public/              index.html, style.css, game.js (network, input, HUD, WebAudio sound),
                     scene3d.js (all the three.js code), vendor/ (vendored three.js),
                     assets/textures/ (floor textures, CC0)
test/                world.js (layout, paths), smoke.js (end-to-end, RAM), shared.js (real Redis, two instances)
vercel.json          static directory and maxDuration
docs/                ARCHITECTURE.md (English) and ARCHITECTURE.vi.md: what Redis does, cleanup, limits
```

## Tests

```bash
npm test
```

`test/world.js` checks the layout and paths. `test/smoke.js` runs a real server with real WebSockets and the RAM store (including AFK, connection/room limits, name rules and the kill switch). `test/shared.js` runs one store contract against both the RAM and Redis stores, then starts two servers sharing one Redis to play across instances (smash one object from two instances, reconnect to another instance, cross-instance IP limit, sudden instance death). It starts a temporary `redis-server` on a free port by itself; if the machine has no `redis-server`, the Redis part is skipped with a `SKIP` line. Point it at an existing Redis with `TEST_REDIS_URL`. No `redis-server` installed? `npm run test:redis` starts a throwaway Redis container with podman or docker (`scripts/test-with-redis.sh`), runs the full suite and removes the container; the first run pulls `redis:7-alpine`.

## Design notes

The server decides everything important: the client only sends its position and smash requests, and the server checks distance, prevents teleporting, and limits smash rate and messages per second. Player names are sanitised on the server and displayed only through `textContent` or canvas on the client. A player's token only lets them reclaim their place after a reconnect; it is not an authentication credential: there are no accounts, and a player's public id is an integer unrelated to the token.
