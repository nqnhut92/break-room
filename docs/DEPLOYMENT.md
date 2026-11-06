# Deployment and operations

English · [Tiếng Việt](DEPLOYMENT.vi.md) · [Documentation](README.md)

The Vercel deployment uses Functions with native WebSockets and Fluid Compute. Static pages in `public/` are served by Vercel; WebSocket connections go to the `api/ws.js` function at `wss://<domain>/api/ws`.

Shared state requires Redis across instances. Vercel refuses joins without `REDIS_URL`/`KV_URL`; see [Architecture](ARCHITECTURE.md) and [ADR 0001](adr/0001-shared-state.md) for storage and pub/sub.

## Steps

1. Push the repo to GitHub, choose **Add New Project** on Vercel and import it. `npm run build` stamps the static assets; `vercel.json` runs it automatically and sets the static directory to `public` and the `maxDuration` of `api/ws.js`.
2. Create a Redis database (via **Storage > Marketplace**, for example Upstash Redis, or any provider, see below) and connect it. An integration adds `KV_URL` or `REDIS_URL` (a `rediss://...` TCP connection string, required for pub/sub). The game reads `REDIS_URL` first, then `KV_URL`. If your integration only provides REST variables (`KV_REST_API_URL`), add `REDIS_URL` by hand with the database's TCP/TLS connection string.
3. Make sure **Fluid Compute** is on (default for projects created after 2025-04-23; for older ones enable it under Settings > Functions and redeploy).
4. Deploy. Open `https://<domain>/api/health`: `{"ok":true,"store":"redis"}` means Redis is configured. Then open the main page and join from two browsers.

Put the function in the same region as the database (for example both in Singapore); shared-state operations cross Redis.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `REDIS_URL` or `KV_URL` | Redis (TCP) connection string. Required on Vercel. Optional locally |
| `WS_MAX_DURATION_S` | Maximum lifetime of a WebSocket connection. Default 300 on Vercel, 0 (no limit) locally. Set it to your `maxDuration` if you raise it (Pro plan) |
| `RESPAWN_MS` | Optional positive fixed replacement delay in ms. Missing/zero/invalid enables adaptive 25000–60000 ms. Remove a previous `25000` setting to enable the adaptive policy |
| `AFK_MS` | A player who does nothing (no move, smash or emoji) for this many ms is disconnected with code 4002; being hit, knocked out or respawned does not count as activity, default 180000 (3 minutes). The client does not reconnect by itself and shows a join button; the score is kept. Stops forgotten tabs from keeping a Vercel instance alive (memory is billed while an instance is alive) |
| `MAX_CONNECTIONS` | Maximum connections per instance. Default 200 on Vercel, unlimited locally |
| `MAX_ROOMS` | Maximum rooms per instance. Default 40 on Vercel, unlimited locally. Almost irrelevant with the fixed server list |
| `FIXED_ROOMS=0` | Allow any room name instead of only those in `ROOMS` (for experiments and tests) |
| `GAME_DISABLED=1` | Kill switch: everyone gets "Game temporarily closed" and the server opens no Redis connection. Set it and redeploy |
| `REDIS_TLS_CA` | CA certificate (PEM) for Redis providers with a self-signed chain, for example Redis Cloud paid plans. `\n` may stand for a newline |
| `HEALTH_KEY` | If set, `/api/health?deep=<HEALTH_KEY>` performs the deep check (below) |
| `ROOM_TTL_S` | A room with nobody in it loses its state after this many seconds, default 1800 |
| `PORT` | Port for local runs, default 3000 |
| `SCORE_PERSIST=0`, `CHAT_HISTORY=0`, `SCORE_QUEUE_MAX`, `MAINTENANCE_SECRET` / `CRON_SECRET`, `DB_POOL_MAX` | Daily score persistence, chat history, queue bound and the maintenance job secret. A scheduler must call `/api/maintenance` (or `npm run maintenance`); see [Scores](SCORES.md#operations). The deep health check also reports `queue.<room>.len/dropped/syncAt` |
| `TRUST_PROXY=1` | Only needed when running `server.js` behind a reverse proxy outside Vercel (Render, Railway, Nginx...) so connections are counted per real IP. Always on in Vercel |

## What happens when a connection is cut after 5 minutes

A WebSocket is closed when the function reaches `maxDuration` (configured as 300 s in this repository). Check current Vercel limits before raising it, and update `WS_MAX_DURATION_S` to match. The game handles this in two layers:

- **Seamless handover**: about 25 seconds before the deadline the server sends `renew`. The client opens a new socket, rejoins with the same token, then closes the old one. This avoids a visible leave/join during a planned renewal.
- **Reconnect on sudden loss** (network, new deploy, reclaimed instance): the client retries with exponential backoff 1 s, 2 s, 4 s... up to 10 s with jitter. Each tab keeps a token in `sessionStorage`, so rejoining keeps the same id, score, position and smashed objects. A player only leaves the online list if the connection is really gone.

If an instance dies without cleaning up, the others remove its players after 20 seconds without a heartbeat.

Web Analytics: `public/index.html` loads Vercel's cookie-free `/_vercel/insights/script.js` (skipped on localhost). Switch it on once under the project's **Analytics** tab in Vercel; nothing else is needed.

## What players see when you deploy

Every Vercel build writes `lib/build-info.json` (`scripts/stamp-assets.js`): the same version it stamps into the page's module URLs, plus the build time. The page knows its own version from its `game.js?v=...` URL.

- **Joining a newer server with an old page**: the `welcome` message carries the server's `build`. If it differs from the page's version, the player gets an "update available" dialog with a reload button.
- **Playing while a newer deploy goes live**: the first instance of the new build publishes `{ v, t }` on the shared `__build` channel. Instances of an older build (they keep running for a while, up to `maxDuration`) hear it, send every local player an `update` message (the same dialog) and disconnect them with code **4003** after 20 seconds (`updateGraceMs`). The client does not reconnect on 4003; the button reloads the page.
- **Open pages notice by themselves**: the build also writes a static `public/version.json` (same version). Every open page fetches it every 30 seconds and when the tab comes back to the front; a different version means a deploy happened, so the player sees the dialog at once, with a 20 second countdown, and is then disconnected. This works even if no server has told them, and costs no function invocations (it is a static file).
- **Only newer is acted on**: an instance ignores announcements with an older or equal build time, so a late cold start of an old deploy does not kick anyone. Locally (`npm start`) the version is `dev` and nothing of this runs.
- The server push needs the new function to start, that is, a first player reaching it; the `version.json` check above does not, so it is the one that makes sure everybody is told within about 30 seconds.

## Beta limitations

- This deployment targets Vercel native WebSockets. Verify current availability, limits and billing in the [platform documentation](https://vercel.com/docs/functions) before deployment; they can change independently of this repository.
- The docs give no number for concurrent connections per instance. There is no real-world load data for this game yet.
- Shared-state operations and cross-instance traffic depend on Redis latency; positions stay local when everyone is on one instance. Put them in the same region.
- Cost: Fluid Compute Active CPU, Provisioned Memory and Invocations, plus Redis commands. Housekeeping, heartbeats, shared actions and cross-instance position traffic consume Redis commands; measure command rates under the expected load. Check your Redis plan's limits.
- Redis pub/sub does not guarantee delivery. If the Redis connection drops, a message may be lost. Clients are fully resynchronised the next time they join.
- Vercel's firewall and rate limits apply to every upgrade request, so do not set rules too tightly.

## Fallback

`server.js` runs on any always-on Node host (Render, Railway, Fly.io, a VPS): `npm install && npm start`. A single process needs no Redis (state lives in RAM and is lost on restart). To run several instances set `REDIS_URL` as above. The repo has no Dockerfile.

Health checks: `GET /healthz` with `server.js`, `GET /api/health` on Vercel (only checks that the Redis variable is set). `GET /api/health?deep=<HEALTH_KEY>` really connects to Redis, writes a `br:keepalive` key with a 3-day expiry and returns `pingMs`, the score queues and `clients`: `{ connected, max }` from Redis `INFO clients` (the check's own connection included; left out when the provider restricts `INFO`). Connections count per Vercel instance, not per player: each `api/ws` instance holds up to two (commands and pub/sub, which the login code shares), and the HTTP routes open one only while a request runs. Call it while people are playing to see how close the plan's connection limit is. If the provider deletes idle databases, use this endpoint with an uptime monitor at an interval compatible with the actual plan; it also alerts you to failures.

## Choosing and testing a Redis provider

Before pasting `REDIS_URL` into Vercel, run this on your machine:

```bash
REDIS_URL='rediss://user:password@host:port' npm run check:store
```

The script checks connection, latency, `SET`/`GET`, Lua (`EVAL`), pub/sub, 20 simultaneous connections, and runs the game's own store (join, smash, snapshot, housekeeping, Call IT). It only creates keys in a temporary room, deletes them, and never prints the connection string.

The provider must support Redis TCP/TLS, Lua (`EVAL`) and pub/sub; a REST-only endpoint is insufficient. Check connection limits, ops/s, monthly command and bandwidth quotas, TLS and idle-deletion rules for the actual plan. Prices and limits change; consult [Redis Cloud](https://redis.io/cloud/) or [Upstash](https://upstash.com/pricing), then run `check:store` before deployment. Positions stay local on a single instance, but housekeeping and hits still use Redis commands.

## Google login and Neon

Follow [identity setup and rollout](IDENTITY.md#configuration) for Google app/callback URLs, `AUTH_URL`, `AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, pooled `DATABASE_URL` and optional `MIGRATION_DATABASE_URL` (same database). The app automatically applies pending migrations before first profile database use; concurrent instances serialize through a transaction advisory lock and applied versions are skipped. No manual migration step is needed when the database role has schema permissions. Build does not connect to the database. Guest-only local mode requires none of these. Production account sessions share Redis. Do not enable account creation while old instances bypass the reservation protocol.
