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

The boss uses three more keys of the same room, each with the same expiry: `boss` (hash: `hp`, `at`, `dead`, `respawnAt`), `bdmg` (hash: player id → damage dealt to the current boss), `blk` (the lease of the instance that runs the boss). They are not part of the nine-key set above; their scripts take only the keys they need. See [BOSS.md](BOSS.md).

Feature state also uses `mini`, `snakes`, `rage` and `moles`; captured duels live in the `boss` hash field `duel`. These do not change the base nine-key set. See [TML/DMM](MINIBOSSES.md), [VKL](BOSS.md) and `lib/store-redis.js` for individual operations.

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

Rough size (estimate, not measured): the state of one room is tens of KB. Redis Cloud counts its own baseline overhead too, which is why an almost empty database already shows about 2 MB.

## Capacity and limits

- **Storage.** Object state is bounded by the room and object counts (currently 2 rooms × 359 objects), plus player and NPC state. Only damaged or broken objects are stored. Under memory pressure Redis eviction may remove expiring keys and lose room state; check the actual provider configuration.
- **Throughput and connections.** Each instance uses a command connection and a lazy subscriber. Monitor housekeeping, pub/sub and hit traffic; measure load instead of inferring capacity from Redis storage alone.
- **Latency.** Put the function and Redis in the same region. Positions stay local on one instance; shared-state operations still use Redis. Measure `pingMs` through the deployed deep health check.
- **Operations.** Quotas, TLS, eviction and idle-deletion policies depend on the current provider plan. See [Deployment](DEPLOYMENT.md).

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

## Validation and token boundaries

The server decides everything important: the client only sends its position and smash requests, and the server checks distance, prevents teleporting, and limits smash rate and messages per second. Player names are sanitised on the server and displayed only through `textContent` or canvas on the client. A player's token only lets them reclaim their place after a reconnect; it is not an account authentication credential. Account ownership comes from the verified session; a player's public realtime id remains an integer unrelated to that session.

## Architecture decisions

See [ADRs](adr/README.md) for the rationale behind shared storage, leased runners, direct rendering and static collision geometry. [Development](DEVELOPMENT.md) covers editing and verification.

Object replacement policy lives in `lib/object-respawn.js`; Lua embeds the same constants and computes pressure from shared Redis state inside housekeeping, not an instance-local count. Break timestamps stay unchanged. [Formula and examples](GAMEPLAY.md#automatic-it-replacement).

## Accounts and durable profiles

[Phase 1 identity](IDENTITY.md) separates verified Google accounts and Postgres room characters from Redis gameplay, session validity and connection ownership. Offline registered names remain reserved. Join/profile mutations coordinate SQL reservations with online guests and bots; Redis writes carry connection/session fences. No Postgres queries occur per frame or heartbeat. Daily scores and 24-hour chat persistence remain planned.

With persistent profile reservations configured, presence renewal must arrive before its lease expires. A delayed heartbeat cannot recreate a pruned/expired owner; the client must rejoin and recheck name reservations.

## Dynamic actor bodies

`public/actor-collision.js` supplies the same swept circle movement to browser prediction and server validation. Furniture remains authoritative static geometry. Living boss/mini-boss centers come from the existing runner/pubsub snapshots; no new database, heartbeat or identity fields are needed. Servers correct blocked movement and separate residual overlaps after snapshot changes. Player/player and player/bot bodies remain nonblocking. Forced duel animations complete before ordinary body separation resumes. See [ADR 0007](adr/0007-dynamic-actor-collision.md).
