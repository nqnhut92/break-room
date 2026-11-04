# 0001 — Shared authoritative state behind a store contract

- Status: Accepted
- Recorded: 2026-11-04 (existing decision documented retrospectively)
- Supersedes / superseded by: none

## Context

A WebSocket stays on its accepting instance, but reconnects and other players can reach different Vercel instances. Independent RAM state would split one game room into several offices. Concurrent hits must not break an object or pay a bounty twice. Local development should still work without Redis.

## Decision

Keep gameplay in `lib/realtime.js` behind a common store contract. Use the memory implementation for a single local process and Redis when shared state is required. On Vercel, refuse joins when neither `REDIS_URL` nor `KV_URL` is configured rather than silently use per-instance RAM.

Validate reach, movement, cooldowns and messages on the server. Commit shared mutations and payouts atomically with Redis Lua. Relay room events over pub/sub; position traffic may stay in-process when presence indicates that all players are local. Rejoining reads a fresh snapshot. Reconnect tokens reclaim a player slot; they are not account authentication.

## Alternatives

- Per-instance RAM is simple, but cannot provide one room across instances.
- Sticky routing alone cannot retain authoritative state across instance loss or reconnects to another instance.
- A different transactional datastore and event transport could implement the contract, but would need to preserve atomic state transitions and room broadcasts. A Redis REST-only integration does not satisfy the current TCP/pub/sub implementation.

## Consequences

The local game and production share rules and store contract tests. Redis adds latency, operational cost and connection limits. Pub/sub is transient, not a durable event log; clients resynchronise on rejoin, and live delivery can be missed during disconnects. Multiple local processes must explicitly use a shared Redis.

Revisit the backend if measured capacity or reliability requirements exceed the present Redis design; retain atomicity and reconnect semantics when doing so.

## References

- [Architecture](../ARCHITECTURE.md), [deployment](../DEPLOYMENT.md)
- [Store selection](../../lib/config.js), [game rules](../../lib/realtime.js)
- [Redis store](../../lib/store-redis.js), [memory store](../../lib/store-memory.js)
- [Contract and multi-instance tests](../../test/shared.js)
