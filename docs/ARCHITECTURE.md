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
- Two stores implement that interface: `lib/store-redis.js` (shared, used on Vercel) and `lib/store-memory.js` (RAM, for `npm start` and tests). `lib/config.js` picks one; on Vercel without `REDIS_URL` or `KV_URL`, the game refuses joins instead of falling back to RAM.
- A WebSocket is pinned to the instance that accepted it. A reconnect may land on a different instance. That is why shared state cannot live in RAM.

## What Redis does

**1. Shared state of each server (BR-1, BR-2).** A "room" is one server. Its keys share the hash tag `{room}` (one cluster slot) and base-state scripts receive the following nine-key set (feature scripts use additional keys; housekeeping also receives `moles` to exclude bots from replacement pressure):

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

The boss uses three more room keys: `boss` (hash: current/max HP, health revision, timestamps and feature state), `bdmg` (hash: damage dealt to the current boss) and `blk` (runner lease). Boss data uses the room expiry when written; `blk` has a separate three-second lease renewed by its holder. These are outside the base nine-key set; each feature script takes the keys it needs. See [Boss](BOSS.md) and [population health](#population-scaled-boss-health).

Feature state also uses `mini`, `snakes`, `rage` and `moles`; captured duels live in the `boss` hash field `duel`. These do not change the base nine-key set. Each personal ultimate bar uses a `rage:<participant id>` string key (character or guest tab), not the recycled player id, with its own seven-day TTL from the last save. Other players and reads do not renew it. The bar follows the character across devices and renewals; it is not copied from a guest to the character on sign-in. Existing `rage` hash fields migrate on the next read or save and are removed from the old hash; unread fields expire with the legacy hash. See [TML/DMM](MINIBOSSES.md), [VKL](BOSS.md) and `lib/store-redis.js` for individual operations.

The name hash also stores `a<id>`, the server-internal leaderboard actor of each player. Day boards (`ds:<day>`, `di:<day>`) and the score queue (`evq`, `qs`, no TTL) live in the same hash-tag slot but outside the nine-key set and outside the room TTL. See [Scores](SCORES.md).

Per-IP connection leases (one zset per IP) and the `br:keepalive` health key live outside the room.

**2. Atomic operations.** Join, leave, hit, housekeeping, snapshot, reset and the boss's hit, respawn and lease are single Lua scripts. Two players hitting one object from two instances break it exactly once and the score is credited once. Name checks happen inside the join script, so two players cannot claim one name at the same instant.

**3. Pub/sub.** An instance that receives an action (smash, emote, chat, position, join/leave) publishes it on the room's channel; every instance holding players of that room forwards it to its own clients. Pub/sub is transient and costs no storage. Delivery is not guaranteed; clients resynchronise on their next join. When every player of a room is on one instance, positions stay in-process and are not published.

## Lifecycle and cleanup

Redis is not written to forever. Everything has an expiry or a bounded size:

| Data | How it is cleaned |
| --- | --- |
| Whole room (all 9 keys) | `touch` sets `EXPIRE` to `ROOM_TTL_S` (default 1800 s) on every join, leave and housekeeping run. A room nobody touches for 30 minutes disappears completely, including scores, names and tokens |
| Online presence (`on`, `own`) | Heartbeat refreshed by housekeeping about every second (every 2 s while nothing is broken). A player with no heartbeat for `PRESENCE_TTL_MS` (20 s) is pruned, for example after an instance dies |
| Broken objects (`o`) | Housekeeping atomically calculates a 25–60 s threshold from current human presence and pre-sweep broken count; positive `RESPAWN_MS` keeps a fixed override. It deletes entries old enough; "Call IT" deletes the whole hash. Untouched objects are not stored at all, so `o` holds at most the number of objects in `lib/world.js` (currently 359) |
| Per-IP leases | Each lease expires after 60 s and is refreshed while the connection lives |
| `br:keepalive` | 3-day expiry, rewritten by each deep health check |

Compaction: housekeeping also runs a small compaction at most every 2 minutes per room (`lastCompact` in `meta`). It forgets the token, name, gender, role, company, last position and slot of every player who is offline and never scored. Players with a score stay until the room expires so the leaderboard keeps them. This bounds the per-token entries by the number of people who actually played, not by everyone who ever visited.

Measure room-state memory using Redis diagnostics and the provider dashboard. Baseline database overhead is separate from game keys; do not infer a player limit from an almost-empty database’s displayed memory usage.

## Capacity and limits

- **Storage.** Object state is bounded by the room and object counts (the server list in `ROOMS` times the objects built in `lib/world.js`), plus player and NPC state. Only damaged or broken objects are stored. Under memory pressure Redis eviction may remove expiring keys and lose room state; check the actual provider configuration.
- **Throughput and connections.** Each game instance uses a command connection and a lazy subscriber; the login code shares that command connection. The short-lived routes (`/api/profile`, `/api/auth/*`, `/api/rooms`, `/api/maintenance`) open Redis only when they need it and close it before finishing, so recycled serverless instances cannot leak connections against a plan's connection limit. Monitor housekeeping, pub/sub and hit traffic; measure load instead of inferring capacity from Redis storage alone.
- **Latency.** Put the function and Redis in the same region. Positions stay local on one instance; shared-state operations still use Redis. Measure `pingMs` through the deployed deep health check.
- **Operations.** Quotas, TLS, eviction and idle-deletion policies depend on the current provider plan. See [Deployment](DEPLOYMENT.md).

## Where things live

| Concern | File |
| --- | --- |
| Game rules, WebSocket handling, name rules | `lib/realtime.js` |
| Redis scripts and key layout | `lib/store-redis.js`, `lib/daily-lua.js` |
| Daily board, sync worker, guest transfer | `lib/scoreboard.js` (RAM twin: `lib/daily-memory.js`) |
| Chat history, maintenance job | `lib/chat-store.js`, `lib/persistence.js`, `lib/maintenance-http.js` |
| RAM store (same contract) | `lib/store-memory.js` |
| Store selection, limits, TTLs from env | `lib/config.js` |
| Server list (`BR-1`, `BR-2`) | `lib/world.js` (`ROOMS`), `lib/room-list.js` |
| Contract tests for both stores | `test/shared.js` |
| Boss, mini-boss and Prof. K rules | `lib/boss.js`, `lib/miniboss.js`, `lib/profk.js` |
| Furniture layout and facing (`rot`: 0 south, PI/2 east, PI north, -PI/2 west) | `lib/world.js` |
| 3D scene, lighting and the ✨ graphics switch (high / safe, direct render, no post-processing) | `public/scene3d.js` |

## Validation and token boundaries

The server decides everything important: the client only sends its position and smash requests, and the server checks distance, prevents teleporting, and limits smash rate and messages per second. Player names are sanitised on the server and displayed only through `textContent` or canvas on the client. A player's token only lets them reclaim their place after a reconnect; it is not an account authentication credential. Account ownership comes from the verified session; a player's public realtime id remains an integer unrelated to that session.

## Architecture decisions

See [ADRs](adr/README.md) for the rationale behind shared storage, leased runners, direct rendering and static collision geometry. [Development](DEVELOPMENT.md) covers editing and verification.

Object replacement policy lives in `lib/object-respawn.js`; Lua embeds the same constants and computes pressure from shared Redis state inside housekeeping, not an instance-local count. Break timestamps stay unchanged. [Formula and examples](GAMEPLAY.md#automatic-it-replacement).

## Accounts and durable profiles

[Phase 1 identity](IDENTITY.md) separates verified Google accounts and Postgres room characters from Redis gameplay, session validity and connection ownership. Offline registered names remain reserved. Join/profile mutations coordinate SQL reservations with online guests and bots; Redis writes carry connection/session fences. No Postgres queries occur per frame or heartbeat. Daily scores (Redis day board + durable queue drained into Postgres) and 24-hour chat are described in [Scores](SCORES.md); Redis stays authoritative for live play and Postgres is touched per payout batch, never per frame or heartbeat.

With persistent profile reservations configured, presence renewal must arrive before its lease expires. A delayed heartbeat cannot recreate a pruned/expired owner; the client must rejoin and recheck name reservations.

## Dynamic actor bodies

`public/actor-collision.js` supplies the same swept circle movement to browser prediction and server validation. Furniture remains authoritative static geometry. Living boss/mini-boss centers come from the existing runner/pubsub snapshots; no new database, heartbeat or identity fields are needed. Servers correct blocked movement and separate residual overlaps after snapshot changes. Player/player and player/bot bodies remain nonblocking. Forced duel animations complete before ordinary body separation resumes. See [ADR 0007](adr/0007-dynamic-actor-collision.md).


The boss hash also holds the versioned office-patrol schedule and one-second roaming pose. Updates require the current boss lease and expected version. Rack support markers (`rack:<object id>`) live in the same hash until boss respawn; the object-hit script atomically commits the break, normal reward and bounded boss damage. See [office patrol](BOSS.md#office-patrol). Prof. K's versioned record (`profk`) lives in the same hash under the same lease; see [Prof. K](BOSS.md#prof-k).


Canvas and fixed HUD share the dynamic `#app` layout surface, observed by `viewport.js`; layout `innerHeight` supplies a floor when rotation leaves older root/dynamic-unit values. Browser safe-area insets protect content without shrinking the world background. Visual viewport measurements remain limited to keyboard placement. See [mobile layout and verification limits](MOBILE.md#safe-areas-and-rotation-previews).

## Population-scaled boss health

The boss hash stores current/max HP, monotonic `rev`, private per-tier `population` confirmation start times and `popAt`. The existing lease holder calls `bossScale` once per second; one store mutation verifies the lease, counts fresh room-wide presence excluding mole IDs, and applies additive tier growth. Downed humans count; stale presence does not. A gap over three seconds restarts pending confirmation. Respawn resets max/current HP using current real population. Ordinary hits no longer divide damage by nearby target count.

`bossHit` accepts a percentage `share` for ultimate and calculates damage against stored max HP atomically; rack support and snake thresholds also read that maximum. Growth retains contribution, rack and wave markers. Health-changing operations advance `rev`; `bhp`, `bup` and welcome carry current max/revision so reordered pub/sub health cannot overwrite a newer state. Population fields and human/bot classifications are never included in those messages. Public HP still permits some inference. See [ADR 0010](adr/0010-population-boss-health.md) and [rules](BOSS.md#population-health).


The welcome world includes `duelDoor` (doorway center, width and axis: `'x'` for the server room's south door, `'y'` for a west door), shared by rendered lock indicators and the static room layout. Boss home/routes, rack placement, the doorway apron, duel landing and expelled-player positions derive from the server room and its door. The welcome also carries `rooms` (name and bounds from `FLOOR_ROOMS`), which the full-office overview uses for its labels. Existing object identities (ID and type) stay stable; new furniture appends. An active saved capture whose landing lies outside the current server bounds is released by the normal versioned duel update; no new store key or lock is introduced. Patrol poses may still restore in the office and return by navigation to the current home.

Spawn protection is per-player connection state (`protectedUntil`), set by the realtime server on a respawn or a fresh lobby join for `spawnProtectionMs` (default 10 s). `hurt` blocks every damage source while it lasts and broadcasts `blocked`; moving or attacking clears it and broadcasts `shield` with `ms: 0`. Player snapshots, `welcome` and `up` carry the remaining `shieldMs`. Bosses keep shielded players as targets. Nothing about it is stored in Redis.
