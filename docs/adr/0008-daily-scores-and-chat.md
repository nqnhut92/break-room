# 0008 — Daily scores through a durable Redis queue into Postgres, and stored chat

- Status: Accepted
- Recorded: 2026-11-05
- Supersedes / superseded by: none (extends [0001](0001-shared-state.md) and [0006](0006-account-identity.md))

## Context

Scores were transient Redis counters that died with the room's 30-minute TTL, so there was no daily board, no way to keep points across Redis loss, and no way to give a guest's points to the account they sign in with. Chat was broadcast only. Redis must stay the authority for realtime play (atomic mutations, presence, ownership); Postgres already holds accounts and characters. Requirements: per-room daily board in Asia/Ho_Chi_Minh including offline players, guests and bots; no double counting on retry; accepted loss only for points not yet synced when Redis loses data; 24-hour chat that is never reported sent unless stored.

## Decision

- **Participants.** A board row is keyed by an internal actor id (`c:`character, `g:`HMAC of tab token, `b:`random bot), independent of the Redis player id (recycled) and of the character UUID's role as a profile key. Bots and guests need no database profile. Nothing sent to clients carries the id or the kind.
- **Atomic credit + event.** Every payout script updates gameplay state, the day board and appends an event to a TTL-free, bounded Redis list in one Lua execution. Score is an integer in tenths; the daily knock-out count rides on the same events. The day is taken from the committing instance's clock at payout time.
- **Sync.** A worker applies batches in one SQL transaction (event ledger primary key, per-room advisory lock, ordered transfers) and acknowledges with a conditional trim only after commit. Delivery is at-least-once; the ledger makes it effectively once.
- **Live board is derived.** `SQL rows + queued events not in the ledger`, rebuilt by one Lua script while holding the queue lock whenever a day's board is missing. SQL and Redis totals are never summed blindly.
- **Guest transfer** is a Lua move plus a queued transfer event applied in order; a per-day marker allows one transfer per guest participant, and nothing is redirected afterwards (queue order already puts the guest's earlier events before the transfer).
- **Chat** is inserted first (idempotent on `(room, actor, client id)`), then acknowledged and broadcast; history is read by `(at_ms, id)` cursor, filtered by age in the query.
- **Cleanup** is an idempotent job (CLI and protected HTTP endpoint) that also drains the queue; no scheduler is assumed or provisioned.

## Alternatives

- *Write to SQL after the Redis mutation, ignoring failures* — loses points on any DB error. Rejected.
- *Flush on disconnect/shutdown only* — serverless instances die without notice. Rejected.
- *Redis pub/sub or capped streams as the queue* — pub/sub is not durable; capped streams trim silently. Rejected in favour of an explicit bounded list with visible `dropped`.
- *Add SQL total and Redis total* — double counts the synced prefix. Rejected.
- *Reset job at midnight* — leaves the board wrong when the job is late. Rejected; the day is part of every key.
- *Match guest to account by name* — names are not ownership. Rejected.
- Not run: Redis Streams with consumer groups (more commands per payout on a free-tier Redis; the single-worker-per-room lock was enough).

## Consequences

- Points not synced when Redis loses all data are lost; points that exceed `SCORE_QUEUE_MAX` are shown live but never persisted (counted in `dropped`). Events older than the two kept days are discarded at sync and counted.
- A scheduler (or manual command) is required to bound the queue and clean old data; instances only drain opportunistically.
- Payout scripts need extra keys and Lua `TIME` for new queue run ids; the Redis provider must support them.
- Old-version instances do not credit the new board; roll out by draining them.
- Revisit if the queue limit is hit in practice, if per-payout Lua cost matters, or if an all-time board is ever wanted.

## References

[Scores guide](../SCORES.md) · `lib/daily-lua.js`, `lib/daily-memory.js`, `lib/scoreboard.js`, `lib/chat-store.js`, `lib/persistence.js`, `migrations/002-daily-scores-chat.sql` · `test/scores.js` (`npm run test:scores`).
