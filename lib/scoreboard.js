'use strict';
// Orchestration of the daily leaderboard across Redis (live) and Postgres (durable):
//   - ensure(room, day): rebuild a day's live board from SQL + the unsynced queue (once per Redis incarnation)
//   - sync(room): drain the queue into Postgres in ordered, deduplicated, transactional batches
//   - board / touch / transfer / rename: thin wrappers the game calls
//
// Authority: Postgres holds every event that was committed; Redis holds the live board and the events
// not yet committed. They are never added together: hydration derives the board once from
// (SQL rows + queued events SQL does not already hold) while holding the queue lock.

const { randomUUID } = require('crypto');
const { dayOf, dayDate } = require('./daily');

const BATCH = 500;
const LOCK_MS = 30000;
const HYDRATE_RETRY_S = 30;
const HYDRATE_ROWS = 20000;
// How many days of rows/ledger Postgres keeps: today and the previous day. Events for older days
// that are still queued are discarded and counted (never written, so cleaned data cannot reappear).
const KEEP_DAYS = 2;

function createScoreboard({ store, pool, ready = async () => {}, clock = Date.now, log = console.error } = {}) {
  const inflight = new Map();
  const sink = !!pool;

  async function withLock(room, ttlMs, waitMs, fn) {
    const holder = randomUUID();
    const t0 = Date.now();
    while (!(await store.queueLock(room, holder, ttlMs))) {
      if (Date.now() - t0 >= waitMs) return { locked: false };
      await new Promise((r) => setTimeout(r, 50));
    }
    try { return { locked: true, value: await fn() }; }
    finally { await store.queueUnlock(room, holder).catch(() => {}); }
  }

  async function readSql(room, day, ids) {
    await ready();
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const date = dayDate(day);
      const rows = (await c.query('SELECT actor_id AS a, name AS n, score_tenths::float8 AS s, breaks AS b, deaths AS dt FROM daily_scores WHERE room_id=$1 AND day=$2 ORDER BY score_tenths DESC LIMIT $3', [room, date, HYDRATE_ROWS])).rows;
      const transfers = (await c.query('SELECT guest_actor_id AS f, character_actor_id AS t FROM score_transfers WHERE room_id=$1 AND day=$2', [room, date])).rows;
      const committed = ids.length ? (await c.query('SELECT event_id FROM score_events WHERE room_id=$1 AND event_id = ANY($2::text[])', [room, ids])).rows.map((r) => r.event_id) : [];
      await c.query('COMMIT');
      return { rows, transfers, committed };
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }

  // Makes sure the live board of (room, day) exists. Never throws: with Postgres unreachable it falls back to a
  // board derived from the queue alone (state 2), which a later call rebuilds from SQL.
  async function ensure(room, day = dayOf(clock())) {
    const key = room + ':' + day;
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      const state = await store.dayState(room, day);
      if (state === 1) return 1;
      if (!sink) { await store.dailyHydrate(room, { day, mode: 1, rows: [], transfers: [], committed: [] }); return 1; }
      try {
        const r = await withLock(room, LOCK_MS, state === 2 ? 0 : 4000, async () => {
          // Recheck after taking the lock: another instance may have hydrated or degraded it.
          const current = await store.dayState(room, day);
          if (current === 1) return 1;
          const retryKey = 'hydrate:{' + room + '}:' + day;
          if (current === 2 && !await store.claim(retryKey, HYDRATE_RETRY_S)) return 2;
          try {
            const queued = await store.queueRead(room, 0);
            const sql = await readSql(room, day, queued.filter((e) => e.y === day).map((e) => e.i));
            const rows = sql.rows.map((x) => ({ a: x.a, n: x.n || '', s: Number(x.s), b: Number(x.b), dt: Number(x.dt) }));
            await store.dailyHydrate(room, { day, mode: 1, rows, transfers: sql.transfers, committed: sql.committed });
            return 1;
          } catch (e) {
            // Also gate the first failed attempt. All readers and instances share this cooldown.
            await store.claim(retryKey, HYDRATE_RETRY_S);
            if (current === 0) await store.dailyHydrate(room, { day, mode: 2, rows: [], transfers: [], committed: [] });
            throw e;
          }
        });
        if (r.locked) return r.value;
      } catch (e) { log('[scores] hydrate failed:', e.message); }
      if (state === 0 && await store.dayState(room, day) === 0) await store.dailyHydrate(room, { day, mode: 2, rows: [], transfers: [], committed: [] });
      return 2;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  async function touch(room, aid, name) {
    if (!aid) return;
    const now = clock();
    await ensure(room, dayOf(now));
    await store.dailyTouch(room, { aid, name, now });
  }

  // Moves the day's points of a guest actor to a character actor, once. Returns the store's verdict.
  async function transfer(room, from, to, toName) {
    if (!from || !to || from === to) return { state: 'noop' };
    const now = clock();
    await ensure(room, dayOf(now));
    return store.dailyTransfer(room, { from, to, toName, now });
  }

  async function board(room, { limit = 50, aids = [] } = {}) {
    const day = dayOf(clock());
    await ensure(room, day);
    return { day, ...(await store.dailyBoard(room, { day, limit, aids })) };
  }

  async function deaths(room, { aid = '', limit = 50 } = {}) {
    const day = dayOf(clock());
    await ensure(room, day);
    return { day, ...(await store.dailyDeaths(room, { day, limit, aid })) };
  }

  async function rename(room, aid, name) {
    const day = dayOf(clock());
    await store.dailyRename(room, { aid, name, days: [day, day - 1] });
    if (sink) await pool.query('UPDATE daily_scores SET name=$4, updated_at=now() WHERE room_id=$1 AND actor_id=$2 AND day >= $3', [room, aid, dayDate(day - 1), name]).catch((e) => log('[scores] rename:', e.message));
  }

  // ---- queue -> Postgres
  async function applyBatch(room, events) {
    await ready();
    const c = await pool.connect();
    const stats = { applied: 0, duplicate: 0, expired: 0 };
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout = '5s'");
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['br:scores:' + room]);
      const oldest = dayOf(clock()) - (KEEP_DAYS - 1);
      const live = events.filter((e) => e.y >= oldest);
      stats.expired = events.length - live.length;
      const fresh = new Set();
      if (live.length) {
        const r = await c.query('INSERT INTO score_events(event_id, room_id, day) SELECT * FROM unnest($1::text[], $2::text[], $3::date[]) ON CONFLICT (room_id, event_id) DO NOTHING RETURNING event_id',
          [live.map((e) => e.i), live.map(() => room), live.map((e) => dayDate(e.y))]);
        for (const row of r.rows) fresh.add(row.event_id);
      }
      stats.duplicate = live.length - fresh.size;
      stats.applied = fresh.size;
      // Consecutive plain events are summed per actor in one statement; a transfer splits the run to keep order.
      let run = new Map();
      const flush = async () => {
        if (!run.size) return;
        const v = [...run.values()];
        await c.query(`INSERT INTO daily_scores(room_id, day, actor_id, name, score_tenths, breaks, deaths)
          SELECT $1, d, a, n, s, b, k FROM unnest($2::date[], $3::text[], $4::text[], $5::bigint[], $6::int[], $7::int[]) AS t(d, a, n, s, b, k)
          ON CONFLICT (room_id, day, actor_id) DO UPDATE SET score_tenths = daily_scores.score_tenths + EXCLUDED.score_tenths,
            breaks = daily_scores.breaks + EXCLUDED.breaks, deaths = daily_scores.deaths + EXCLUDED.deaths, name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE daily_scores.name END, updated_at = now()`,
          [room, v.map((x) => dayDate(x.y)), v.map((x) => x.a), v.map((x) => x.n), v.map((x) => x.s), v.map((x) => x.b), v.map((x) => x.k)]);
        run = new Map();
      };
      for (const e of live) {
        if (!fresh.has(e.i)) continue;
        if (e.k === 'x') {
          await flush();
          const date = dayDate(e.y);
          // points and broken items move; the guest row stays (zeroed) with its knock-outs
          const moved = (await c.query('SELECT score_tenths, breaks FROM daily_scores WHERE room_id=$1 AND day=$2 AND actor_id=$3 FOR UPDATE', [room, date, e.f])).rows[0];
          if (moved) await c.query('UPDATE daily_scores SET score_tenths=0, breaks=0, updated_at=now() WHERE room_id=$1 AND day=$2 AND actor_id=$3', [room, date, e.f]);
          await c.query(`INSERT INTO daily_scores(room_id, day, actor_id, name, score_tenths, breaks, deaths) VALUES($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (room_id, day, actor_id) DO UPDATE SET score_tenths = daily_scores.score_tenths + EXCLUDED.score_tenths,
              breaks = daily_scores.breaks + EXCLUDED.breaks, deaths = daily_scores.deaths + EXCLUDED.deaths, name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE daily_scores.name END, updated_at = now()`,
            [room, date, e.a, e.n || '', moved ? moved.score_tenths : 0, moved ? moved.breaks : 0, 0]);
          await c.query('INSERT INTO score_transfers(room_id, day, guest_actor_id, character_actor_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [room, date, e.f, e.a]);
          continue;
        }
        const key = e.y + '|' + e.a;
        const cur = run.get(key) || { y: e.y, a: e.a, n: '', s: 0, b: 0, k: 0 };
        cur.s += e.k === 's' ? e.d : 0;
        cur.b += e.k === 's' ? e.b : 0;
        cur.k += e.k === 's' ? e.dt || 0 : 0;
        if (e.n) cur.n = e.n;
        run.set(key, cur);
      }
      await flush();
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    return stats;
  }

  // Drains one room. Returns { locked, batches, events, applied, duplicate, expired }.
  async function sync(room, { maxBatches = 20 } = {}) {
    const out = { locked: false, batches: 0, events: 0, applied: 0, duplicate: 0, expired: 0, error: null };
    if (!sink) return out;
    if (!(await store.queueRead(room, 1)).length) { out.locked = true; return out; } // nothing waiting: skip the lock
    const r = await withLock(room, LOCK_MS, 0, async () => {
      for (let i = 0; i < maxBatches; i++) {
        const batch = await store.queueRead(room, BATCH);
        if (!batch.length) break;
        let stats;
        try { stats = await applyBatch(room, batch); }
        catch (e) { out.error = e.message; await store.queueFail(room, e.message, clock()).catch(() => {}); log('[scores] sync failed:', e.message); break; }
        // Only a committed batch is acknowledged. A lost ack just replays it; the ledger dedupes.
        if (!(await store.queueAck(room, batch, clock()))) { out.error = 'ack skipped: queue head changed'; break; }
        out.batches++; out.events += batch.length;
        out.applied += stats.applied; out.duplicate += stats.duplicate; out.expired += stats.expired;
        if (batch.length < BATCH) break;
      }
    });
    out.locked = r.locked;
    return out;
  }

  // Deletes rows/ledger older than the kept days, in bounded batches.
  async function cleanup({ batch = 5000 } = {}) {
    await ready();
    const before = dayDate(dayOf(clock()) - (KEEP_DAYS - 1));
    const removed = { daily_scores: 0, score_events: 0, score_transfers: 0 };
    for (const table of Object.keys(removed)) {
      for (;;) {
        const key = table === 'daily_scores' ? '(room_id, day, actor_id)' : table === 'score_events' ? '(room_id, event_id)' : '(room_id, day, guest_actor_id)';
        const r = await pool.query(`DELETE FROM ${table} WHERE ${key} IN (SELECT ${key.slice(1, -1)} FROM ${table} WHERE day < $1 LIMIT $2)`, [before, batch]);
        removed[table] += r.rowCount;
        if (r.rowCount < batch) break;
      }
    }
    return removed;
  }

  return { ensure, touch, transfer, board, deaths, rename, sync, cleanup, applyBatch, sink, KEEP_DAYS };
}

module.exports = { createScoreboard, KEEP_DAYS };
