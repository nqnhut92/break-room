# Architecture

English · [Tiếng Việt](ARCHITECTURE.vi.md) · [README](../README.md)

## Overview

```
browser (three.js client)
   │  WebSocket  wss://<domain>/api/ws
   ▼
Vercel Function instance (api/ws.js → lib/realtime.js)     ← several instances may run at once
   │  Redis commands (atomic Lua scripts) + pub/sub
   ▼
Redis  (single source of truth for each server's state)
```

- `lib/realtime.js` holds the game rules and WebSocket handling. It talks to a *store* interface and does not know where it runs.
- Two stores implement that interface: `lib/store-redis.js` (shared, used on Vercel) and `lib/store-memory.js` (RAM, for `npm start` and tests). `lib/config.js` picks one; on Vercel without `REDIS_URL` the game refuses to start instead of falling back to RAM.
- A WebSocket is pinned to the instance that accepted it. A reconnect may land on a different instance. That is why shared state cannot live in RAM.

## What Redis does

**1. Shared state of each server (BR-1, BR-2).** A "room" is one server. Its keys share the hash tag `{room}` (one cluster slot) and every script receives the same nine keys:

| Key | Type | Content |
| --- | --- | --- |
| `o` | hash | object id → `hp:brokenAt` (absent = full health) |
| `sc` | hash | player id → score |
| `bk` | hash | player id → number of objects broken |
| `nm` | hash | player id → display name; field `g<id>` → gender (`m` or `f`), `r<id>` → role, `c<id>` → company name, `h<id>` → `hp|storedAt|knockedOutUntil` |
| `tok` | hash | client token → player id (lets a reconnect keep id and score) |
| `meta` | hash | `nextid`, `total` damage, `lastReset` |
| `on` | zset | player id → last heartbeat (ms); this is "who is online" |
| `own` | hash | player id → id of the connection that owns the slot |
| `pos` | hash | player id → last persisted `x,y,d` |

The boss uses three more keys of the same room, each with the same expiry: `boss` (hash: `hp`, `at`, `dead`, `respawnAt`), `bdmg` (hash: player id → damage dealt to the current boss), `blk` (the lease of the instance that runs the boss). They are not part of the nine-key set above; their scripts take only the keys they need. See [BOSS.md](BOSS.md).

Per-IP connection leases (one zset per IP) and the `br:keepalive` health key live outside the room.

**2. Atomic operations.** Join, leave, hit, housekeeping, snapshot, reset and the boss's hit, respawn and lease are single Lua scripts. Two players hitting one object from two instances break it exactly once and the score is credited once. Name checks happen inside the join script, so two players cannot claim one name at the same instant.

**3. Pub/sub.** An instance that receives an action (smash, emote, chat, position, join/leave) publishes it on the room's channel; every instance holding players of that room forwards it to its own clients. Pub/sub is transient and costs no storage. Delivery is not guaranteed; clients resynchronise on their next join. When every player of a room is on one instance, positions stay in-process and are not published.

## Lifecycle and cleanup

Redis is not written to forever. Everything has an expiry or a bounded size:

| Data | How it is cleaned |
| --- | --- |
| Whole room (all 9 keys) | `touch` sets `EXPIRE` to `ROOM_TTL_S` (default 1800 s) on every join, leave and housekeeping run. A room nobody touches for 30 minutes disappears completely, including scores, names and tokens |
| Online presence (`on`, `own`) | Heartbeat refreshed by housekeeping about every second (every 2 s while nothing is broken). A player with no heartbeat for `PRESENCE_TTL_MS` (20 s) is pruned, for example after an instance dies |
| Broken objects (`o`) | Housekeeping deletes an entry once it has been broken for `RESPAWN_MS` (25 s); "Call IT" deletes the whole hash. Untouched objects are not stored at all, so `o` holds at most the ~140 objects of the office |
| Per-IP leases | Each lease expires after 60 s and is refreshed while the connection lives |
| `br:keepalive` | 3-day expiry, rewritten by each deep health check |

Compaction: housekeeping also runs a small compaction at most every 2 minutes per room (`lastCompact` in `meta`). It forgets the token, name, gender, role, company, last position and slot of every player who is offline and never scored. Players with a score stay until the room expires so the leaderboard keeps them. This bounds the per-token entries by the number of people who actually played, not by everyone who ever visited.

Rough size (estimate, not measured): the state of one room is tens of KB. Redis Cloud counts its own baseline overhead too, which is why an almost empty database already shows about 2 MB.

## Capacity and limits

- **Storage.** The dataset is bounded by 2 servers × (≈285 objects (only damaged or broken ones are stored, about 20 bytes each; measured: all 274 smashed in one room take about 6 KB) + at most 20 online players + the token entries above). It should stay far below the 30 MB of Redis Cloud Free. If memory ever fills up, the eviction policy decides what happens: with `volatile-lru` (the Redis Cloud default seen in the dashboard) Redis evicts keys that have an expiry, that is, stale room keys, instead of refusing writes. The worst case is a room losing its state mid-game (objects respawn, scores reset), not a crash.
- **Throughput is the tighter limit.** Free Redis Cloud allows 100 ops/s and 30 connections. Each room with players costs about 1 command per second per instance holding it for housekeeping, plus pub/sub while players move, plus a few commands per smash. Watch **Metrics → Throughput** under load. Each Vercel instance holds up to two Redis connections (commands and a lazy subscriber); with several instances 30 connections can become the real ceiling.
- **Latency.** Every action crosses Redis, so keep the function region and the database in the same region (both Singapore here). `check:store` run from elsewhere does not represent this latency; use `/api/health?deep=<HEALTH_KEY>` (`pingMs`) from the deployed function.
- **Idle database.** Redis Cloud Free deletes a database with no commands for about 14 days. A monitor hitting the deep health check at least once a day prevents that.
- **Security.** Free Redis Cloud has no TLS (`redis://`), so the password travels unencrypted. Use a password unique to this database and rotate it if it leaks. Never commit or log `REDIS_URL`.

## Where things live

| Concern | File |
| --- | --- |
| Game rules, WebSocket handling, name rules | `lib/realtime.js` |
| Redis scripts and key layout | `lib/store-redis.js` |
| RAM store (same contract) | `lib/store-memory.js` |
| Store selection, limits, TTLs from env | `lib/config.js` |
| Server list (`BR-1`, `BR-2`) | `lib/world.js` (`ROOMS`), `lib/room-list.js` |
| Contract tests for both stores | `test/shared.js` |
| Furniture layout and facing (`rot`: 0 south, PI/2 east, PI north, -PI/2 west) | `lib/world.js` |
| 3D scene, lighting and the ✨ graphics switch (high / safe, direct render, no post-processing) | `public/scene3d.js` |
