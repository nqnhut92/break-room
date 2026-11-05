# Daily scoreboard, score persistence and chat history

[Tiếng Việt](SCORES.vi.md) · [Documentation](README.md) · [Decision](adr/0008-daily-scores-and-chat.md)

## What players get

- **BXH hôm nay** — one board per room (BR-1, BR-2), reset at 00:00 Asia/Ho_Chi_Minh. It lists everybody who played that room today: online, offline, guests and bots, ranked by today's points. Equal scores share a rank and keep a stable order. The panel and dialog title say "BXH hôm nay · room"; the header total is today's damage in that room. The dialog has a second tab, **bị sa thải**: today's knock-out count per player (offline included), same reset and persistence, top 50 plus your own rank. Everyone receives the top 50 rows; a player outside them gets their own rank on request.
- Players who stay connected past midnight start the new day at 0 without rejoining. Characters are never deleted by a day change. There is no all-time board and no stored history of past winners.
- **Guests** appear on the board with their name. A guest's points are recovered only while their tab's identity token is still valid (it lives in `sessionStorage`); a name is never proof of ownership. After Google sign-in in the same tab, the guest's points of today in that room move **once** to the character and are added to what the character already has. Only points and broken items move: the guest keeps its own row (now at 0) and its knock-outs, which never transfer. A guest who earned nothing today is not transferred at all. Logging out or signing in with another account cannot move them again.
- **Chat** belongs to a room and is kept for 24 hours from the moment the server accepted it. Joining loads the latest 50 lines; scrolling up loads older pages by cursor; a reconnect fills the gap. History lines make no bubble above heads. A line shows as sent only after it is stored; when storage fails the sender gets "Chưa gửi được tin nhắn" and nobody sees it. When a character is renamed (only possible while offline) the lines it sent in the last 24 hours show the new name from the next history load; lines already on someone's screen keep the old name until they rejoin.

## Where the data lives

| Data | Redis | Postgres |
| --- | --- | --- |
| Live day board (`ds:<day>` zset, `di:<day>` hash) | yes, 4-day TTL | rebuilt from it |
| Durable event queue (`evq` list, `qs` stats) | yes, **no TTL**, bounded | — |
| Applied events (`score_events`), day rows (`daily_scores`), transfers | — | yes |
| Chat (`chat_messages`) | — (pub/sub for live delivery only) | yes |

Score is stored in **tenths of a point** (all costs and boss shares are multiples of 0.1). Day = whole days since the epoch in UTC+7, computed from the clock of the instance that commits the payout.

Participant ids are internal: `c:<character uuid>`, `g:<HMAC of room and tab token>`, `b:<random uuid>` (bots). They are different from the Redis player id, which is a small integer reused after a room expires. Nothing sent to a client contains a participant id or says whether a row is a bot. Bots get a row from their first appearance like everyone else and keep it as an offline row after leaving.

## Score flow

1. Every payout (broken object, mole kill, VKL kill shares, TML/DMM shares) runs one Redis Lua script that updates gameplay state **and** the day board **and** appends an event (`{id, actor, tenths, breaks, deaths, name, day}`) to the queue. A score is never credited without its event.
2. A sync worker (`lib/scoreboard.js`, `sync`) takes the room's queue lock, reads up to 500 events, applies them in one SQL transaction (`score_events` primary key = dedupe; per-room advisory lock = order; actor sums in one statement), then removes them with a **conditional** ack (first and last id must still match). Acknowledgement happens only after commit, so a lost ack replays the batch and the ledger skips it. Two workers, or a worker whose lock expired, cannot double-apply or trim someone else's events.
3. Event day = the day when the payout committed, not when the worker runs. Late sync of yesterday's events lands on yesterday's row.
4. An instance drains opportunistically every ~5 s while players are in the room, but **nothing relies on that**: run the maintenance job (below) on a schedule.

### Recovery and consistency

The live board is *derived*: `SQL rows + queued events SQL does not already hold`. It is rebuilt (`ensure`) when a day's board is missing: first use of a new day, Redis restart/eviction, or after degraded mode. The rebuild holds the queue lock, reads the queue, asks SQL which queued event ids are already committed, and runs one Lua script, so it never adds SQL and queue twice. If Postgres is unreachable, a degraded board is built from the queue only and rebuilt from SQL on a later attempt (every ~30 s per room). Gameplay keeps running in all of these cases.

Queue event ids are `<run id>:<sequence>`. The run id is new whenever Redis starts a fresh queue, so ids never repeat the ones Postgres holds from an earlier incarnation.

Accepted loss: points not yet synced when Redis loses its data. Never accepted: double-counting after a retry, ack loss, concurrent workers or hydration.

### Queue limits and monitoring

`SCORE_QUEUE_MAX` (default 20000) bounds unsynced events. Beyond it new events are **not queued**: the live board still shows the points but they will not reach Postgres; each refusal increments `dropped`. Nothing is trimmed silently. Watch `GET /api/health?deep=<HEALTH_KEY>` (`queue.<room>.len`, `dropped`, `syncAt`, `err`) or `npm run maintenance -- --status` (adds last job result, table row counts, database size). A growing `len` with an old `syncAt` means no job is draining the queue.

### Guest transfer

On an authenticated join the server derives the guest participant from the join message's tab token and, in one Lua script, moves the guest's score and broken-item count to the character row (the guest row stays at 0 with its knock-outs; nothing happens when both are 0), stores `x:<guest> = character` for the day and appends a transfer event. Rules: only today and the same room; once per guest participant (`exists` afterwards); no-op when the guest has no points and no broken items; never applies to bots (their ids cannot be derived from anything a client holds). Events the guest connection produces afterwards are redirected to the character, so a late event cannot give the guest new points. Knock-outs are never redirected. SQL applies the transfer in queue order, after the guest's earlier events. The redirect is persisted in `score_transfers` and restored when a board is rebuilt.

### Midnight

The key of the board and the event is computed at payout time, so a player online at 00:00 simply starts crediting the new day. Housekeeping builds the new day's board and gives each local player a 0 row. A VKL fight spanning midnight pays shares on the day the kill commits. No reset job is involved.

## Retention and cleanup

| Data | Kept |
| --- | --- |
| `daily_scores` (score, breaks, deaths), `score_events`, `score_transfers` | today and yesterday (rows with `day` < yesterday are deleted by the job) → 24–48 h after a day ends |
| Queued event for a day older than that | **not written**; counted as `expired` in the job result (so cleaned rows cannot reappear) |
| Chat | 24 h from acceptance; reads filter by age even before cleanup runs; job deletes in batches of 2000 |
| Redis day board keys | 4 days TTL |

## Operations

Nothing configures a scheduler for you. Call the job at least every few minutes (every minute is fine and cheap when idle):

```bash
npm run maintenance                  # run once: drain the queue, delete expired rows, record the result
npm run maintenance -- --status      # backlog, drops, last result, sizes
curl -H "Authorization: Bearer $MAINTENANCE_SECRET" https://<domain>/api/maintenance           # same via HTTP (GET, HEAD or POST)
curl -H "Authorization: Bearer $MAINTENANCE_SECRET" "https://<domain>/api/maintenance?status=1"
```

Monitors that cannot set headers (for example UptimeRobot) can use `https://<domain>/api/maintenance?key=<secret>` with GET or HEAD every 5 minutes (HEAD runs the job too); the secret then appears in URLs and logs, and only lets someone run this idempotent job. The endpoint is disabled unless a secret of 8+ characters exists: `MAINTENANCE_SECRET`, else `CRON_SECRET` (which Vercel Cron sends), else the existing `HEALTH_KEY`. It is idempotent and safe to run concurrently. On Vercel add a cron entry yourself, for example `{ "crons": [{ "path": "/api/maintenance", "schedule": "*/5 * * * *" }] }`; this repository does not add one. Sizes: a row in `daily_scores` is small; expect rows ≈ players per room per day, an event row per queued event for ≤ 2 days, chat ≤ 24 h of lines.

## Configuration

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Enables score persistence and chat history (and accounts). Without it boards are live-only and chat is broadcast only |
| `SCORE_PERSIST=0` | Keep daily boards in Redis only (no queue, no SQL) |
| `CHAT_HISTORY=0` | Broadcast-only chat even with a database |
| `SCORE_QUEUE_MAX` | Unsynced event limit, default 20000 |
| `MAINTENANCE_SECRET` / `CRON_SECRET` / `HEALTH_KEY` | Secret for `/api/maintenance`, first one set wins |
| `DB_POOL_MAX` | Postgres pool size per instance, default 4 |

## Rollout

1. The first request of a new version applies migration `002-daily-scores-chat.sql` automatically (same mechanism as accounts); or run `npm run db:migrate` against a disposable copy first.
2. **The daily board starts empty** when enabled; Redis scores from before are not imported (and never matched by name).
3. Disconnect old-version instances (the build notice already does this): an old instance does not write day boards or events, so its payouts would be missing from the board.
4. Configure the scheduler, then watch `queue.len` / `syncAt` in the health check.
5. Roll back by redeploying the old version; the extra tables and keys are inert. Set `SCORE_PERSIST=0` / `CHAT_HISTORY=0` to disable parts without redeploying code.

## Not verified live

Neon pooled TLS behaviour and latency of the batch SQL, Redis provider script/TIME/memory behaviour and eviction policy, Vercel cron delivery, and behaviour with real Google accounts are not covered by the disposable-container tests. See [Development](DEVELOPMENT.md#score-and-chat-validation).
