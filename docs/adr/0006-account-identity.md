# 0006 — Separate account identity, durable room profiles and realtime ownership

- Status: Accepted
- Date: 2026-11-05

## Context

Guests must keep immediate access. Google accounts need one durable, editable character per room across devices. Names are display data, not credentials. Redis remains the authoritative realtime store; Postgres cannot be queried for every action. Offline registered names must remain reserved, including during guest/NPC joins and database failures.

## Decision

Use Auth.js Core's Google OIDC provider and encrypted cookie JWT strategy, with state, nonce, PKCE and built-in sign-in/out CSRF. Persist only a verified provider/subject mapping to an internal UUID in `accounts`/`auth_identities`. Google tokens, names and emails are not retained. JWTs contain a random session ID with an absolute seven-day expiry. Redis stores expiring session-validity markers for each fixed room; signout/revocation deletes them. Local single-process mode may use RAM markers. This session strategy needs no SQL session table.

Postgres stores `characters`, with unique account/room and canonical name/room constraints. Normalization is NFC, collapsed whitespace, trim and lowercase key; display casing remains. Profile APIs infer ownership from the verified cookie, reject unknown fields, and reject edits while the character is online. UI edits occur outside gameplay and require explicit save.

Every identity-aware join (including bot joins), profile create and edit uses the same Postgres transaction advisory lock per room and checks live Redis names. This closes the race between a guest joining and an account reserving/renaming a name. SQL uniqueness alone cannot protect Redis. Existing deployments must stop old instances that do not participate in this protocol before enabling account creation. Database errors defer new NPCs and use an unregistrable `~` name namespace for guests; accounts fail explicitly.

Authenticated joins derive the Redis slot token on the server from the stable character UUID and a server HMAC secret. The client reconnect token never selects an account slot. Existing atomic join/leave ownership supports takeover. A server-only async context fences each Redis script/direct mutation against the controlling connection and room session marker at Redis execution time; a JavaScript preflight alone would race takeover/revocation. The RAM store checks the equivalent context. System health writes retain the target connection context, and stale account close handlers do not flush rage. New account/character identifiers are not added to public player/NPC records.

Schema initialization runs automatically before the first profile database operation per instance, using `MIGRATION_DATABASE_URL` when supplied or `DATABASE_URL` otherwise. A successful initialization is cached; failure rolls back and permits retry. A transaction advisory lock serializes cold starts and version ledger entries skip applied migrations without resetting user data. Migration SQL is explicitly bundled into Vercel functions. Builds remain database-free. Separate migration credentials, when used, must target the same database.

## Alternatives

- Email/name ownership or matching legacy guest names: rejected because it allows takeover and Google display names can change.
- Handwritten OAuth: rejected in favor of a maintained protocol implementation with state/nonce/PKCE and cookie handling.
- Postgres for realtime or session checks per action: rejected because gameplay must survive a profile-database outage.
- SQL constraints without coordinating Redis presence: rejected because guest/NPC names are not SQL rows.
- Only checking ownership before an async game handler: rejected because a new join can replace the owner between the check and the write.
- A permanent name registry solely in Redis: rejected because eviction could erase offline reservations without a safe authoritative check.

## Consequences

Guest/database-name decisions depend on Postgres only at join; ordinary gameplay and session checks use Redis. The extra per-room lock serializes joins/edits and must stay short. It does not create a distributed transaction: a failed commit after a Redis join can leave a lease that normal presence cleanup expires. Small pools and bounded timeouts limit stalled profile work. Redis loss drops gameplay state and invalidates account sessions; profiles survive in Postgres.

Phase 2 may attach room/day scoring to stable character IDs and explicit guest-transfer evidence, with midnight Asia/Ho_Chi_Minh boundaries. Phase 3 may persist chat for 24 hours. Neither is implemented here; current transient scores/chat are unchanged. No all-time leaderboard, winner history or persistent bots are introduced.

## Evidence

[Identity guide](../IDENTITY.md), [migration](../../migrations/001-identity.sql), [auth/profile integration](../../lib/identity.js), [database repository](../../lib/profiles.js), [integration tests](../../test/identity.js). The test runner uses disposable Postgres/Redis and a mocked Google provider through Auth.js; live Google/Neon verification is a separate rollout check.
