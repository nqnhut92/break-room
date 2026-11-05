'use strict';
// Daily leaderboard, durable score queue, guest transfer and chat history against disposable Redis + Postgres.
// Run with: npm run test:scores   (scripts/test-scores.sh starts the containers). Never reads DATABASE_URL.
const assert = require('node:assert/strict');
const Redis = require('ioredis');
const { Pool } = require('pg');
const { migrate } = require('../scripts/migrate');
const { createMemoryStore } = require('../lib/store-memory');
const { createRedisStore } = require('../lib/store-redis');
const { createScoreboard } = require('../lib/scoreboard');
const { createChatStore } = require('../lib/chat-store');
const { dayOf, dayDate, guestActor, characterActor, botActor } = require('../lib/daily');
const { createApp, TYPES } = require('../server');
const { client, take, none, send, smashPlant, sleep } = require('./helpers');

let passed = 0;
const step = async (name, fn) => { await fn(); console.log('ok - ' + name); passed++; };
let seq = 0;
const uniq = (p) => `${p}-${Date.now().toString(36)}${++seq}`;
// 23:59:50 on a Vietnam day, then times either side of midnight.
const BASE = Date.UTC(2031, 5, 1, 16, 59, 50); // 2031-06-01 23:59:50 +07
const CFG = { maxHp: 1000, baseRegenPerSec: 0, regenPerSec: 0, regenDelayMs: 0 };

async function main() {
  const db = process.env.SCORES_TEST_DATABASE_URL, redisUrl = process.env.SCORES_TEST_REDIS_URL;
  assert.ok(db && redisUrl, 'Use npm run test:scores for disposable services');
  await migrate(db);
  const pool = new Pool({ connectionString: db, max: 6 });
  const raw = new Redis(redisUrl);
  const ledger = (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version);
  assert.deepEqual(ledger, ['001-identity.sql', '002-daily-scores-chat.sql', '003-daily-deaths.sql']);

  const kinds = [['memory', (o) => createMemoryStore({ persistScores: true, ...o })], ['redis', (o) => createRedisStore(redisUrl, { log: () => {}, persistScores: true, ...o })]];
  const stores = [];
  let rstore;
  try {
    for (const [label, make] of kinds) {
      const store = make({}); stores.push(store);
      if (label === 'redis') rstore = store;
      const clock = { now: BASE };
      const sb = createScoreboard({ store, pool, clock: () => clock.now, log: () => {} });
      const sb2 = createScoreboard({ store, pool, clock: () => clock.now, log: () => {} }); // a second "instance"
      const join = async (room, n, aid, name) => (await store.join(room, { token: 'tok-' + room + '-' + n + '-0123456789', name, fallbackName: 'N', connId: 'c' + n, now: clock.now, max: 20, ttlMs: 60000, spawn: { x: 1, y: 1 }, aid })).id;
      const top = async (room, aids = []) => sb.board(room, { limit: 50, aids });
      const byName = (b) => Object.fromEntries(b.rows.map((r) => [r.name, r.tenths]));
      const sqlRows = async (room) => Object.fromEntries((await pool.query('SELECT actor_id, name, score_tenths::int AS s, breaks, deaths, day::text AS d FROM daily_scores WHERE room_id=$1 ORDER BY day, actor_id', [room])).rows.map((r) => [r.actor_id + '@' + r.d, r]));

      await step(`${label}: every payout source credits the day board in tenths, with the actor's row from join`, async () => {
        const room = uniq('p');
        const A = characterActor('00000000-0000-4000-8000-00000000000a'), G = guestActor(room, 'guesttoken0000000000'), Bot = botActor();
        const a = await join(room, 1, A, 'An'), g = await join(room, 2, G, 'Khách'), b = await join(room, 3, Bot, 'Bao');
        for (const [aid, n] of [[A, 'An'], [G, 'Khách'], [Bot, 'Bao']]) await sb.touch(room, aid, n);
        let board = await top(room);
        assert.equal(board.rows.length, 3, 'three rows at 0, bot included from the start');
        assert.ok(board.rows.every((r) => r.tenths === 0));
        await store.hit(room, { objId: 'x1', defaultHp: 1, cost: 25, playerId: a, now: clock.now });                // object: 250, 1 break
        await store.moleAdd(room, b, { hp: 1, conn: 'c3', now: clock.now });
        await store.moleHit(room, { id: b, dmg: 1, cost: 5, playerId: g, now: clock.now });                         // mole bounty: 50, 1 break
        await store.bossHit(room, { playerId: a, dmg: 1000 / 3, now: clock.now, cfg: CFG, respawnAt: clock.now + 1000, bounty: 100 });
        const killed = await store.bossHit(room, { playerId: g, dmg: 2000, now: clock.now, cfg: CFG, respawnAt: clock.now + 1000, bounty: 100 });
        assert.equal(killed.state, 'killed');                                                                      // shares of 100 by damage: fractional tenths
        await store.miniSave(room, { now: clock.now, expected: 0, state: { version: 1, list: [] }, shares: [{ id: a, bounty: 40 }] }); // mini-boss: 400
        board = await top(room, [A]);
        const share = Object.fromEntries(killed.shares.map((s) => [s.id, s.bounty]));
        assert.equal(board.rows.find((r) => r.aid === A).tenths, 250 + Math.round(share[a] * 10) + 400);
        assert.equal(board.rows.find((r) => r.aid === G).tenths, 50 + Math.round(share[g] * 10));
        assert.equal(board.rows.find((r) => r.aid === A).breaks, 1);
        assert.equal(board.rows.find((r) => r.aid === G).breaks, 1);
        assert.equal(board.selfs[0].rank, 1);
        assert.equal(board.rows[0].aid, A);
      });

      await step(`${label}: queue -> Postgres is applied once even when the ack is lost, and with two workers`, async () => {
        const room = uniq('s');
        const A = characterActor('00000000-0000-4000-8000-0000000000a1');
        const a = await join(room, 1, A, 'Lan');
        await sb.touch(room, A, 'Lan');
        for (let i = 0; i < 7; i++) await store.hit(room, { objId: 'o' + i, defaultHp: 1, cost: 2, playerId: a, now: clock.now });
        const batch = await store.queueRead(room, 500);
        assert.equal(batch.length, 8); // join row + 7 breaks
        await sb.applyBatch(room, batch);                 // SQL committed ...
        const replay = await sb.applyBatch(room, batch);  // ... ack lost: the same batch comes back
        assert.deepEqual([replay.applied, replay.duplicate], [0, 8]);
        assert.equal((await sqlRows(room))[A + '@' + dayDate(dayOf(BASE))].s, 140);
        const [r1, r2] = await Promise.all([sb.sync(room), sb2.sync(room)]);
        assert.ok(r1.locked || r2.locked);
        assert.equal((await store.queueStat(room)).len, 0, 'queue drained');
        assert.equal((await sqlRows(room))[A + '@' + dayDate(dayOf(BASE))].s, 140, 'no double count');
        assert.equal(byName(await top(room))['Lan'], 140);
      });

      await step(`${label}: points belong to the day of the payout; late sync and midnight cross correctly`, async () => {
        const room = uniq('m');
        const A = characterActor('00000000-0000-4000-8000-0000000000b1');
        clock.now = BASE;
        const a = await join(room, 1, A, 'Mai');
        await sb.touch(room, A, 'Mai');
        await store.hit(room, { objId: 'o1', defaultHp: 1, cost: 8, playerId: a, now: BASE });           // 23:59:50 -> day D
        clock.now = BASE + 30000;                                                                        // 00:00:20 -> day D+1
        await store.hit(room, { objId: 'o2', defaultHp: 1, cost: 3, playerId: a, now: BASE + 30000 });
        let board = await top(room);
        assert.equal(board.day, dayOf(BASE) + 1);
        assert.equal(byName(board)['Mai'], 30, JSON.stringify(board));
        await sb.sync(room);                                                                             // processed after midnight, still sorted by payout day
        const rows = await sqlRows(room);
        assert.equal(rows[A + '@' + dayDate(dayOf(BASE))].s, 80);
        assert.equal(rows[A + '@' + dayDate(dayOf(BASE) + 1)].s, 30);
        clock.now = BASE;
      });

      await step(`${label}: guest transfer moves today's points once, including unsynced events; late events follow`, async () => {
        const room = uniq('t');
        clock.now = BASE;
        const G = guestActor(room, 'abcdefghijklmnop0001'), C = characterActor('00000000-0000-4000-8000-0000000000c1'), C2 = characterActor('00000000-0000-4000-8000-0000000000c2');
        const g = await join(room, 1, G, 'Khách7'), c = await join(room, 2, C, 'Chi');
        await sb.touch(room, G, 'Khách7'); await sb.touch(room, C, 'Chi');
        await store.hit(room, { objId: 'a', defaultHp: 1, cost: 10, playerId: g, now: BASE });
        await sb.sync(room);                                                                             // 100 synced for the guest
        await store.hit(room, { objId: 'b', defaultHp: 1, cost: 5, playerId: g, now: BASE });           // 50 still queued
        await store.hit(room, { objId: 'c', defaultHp: 1, cost: 2, playerId: c, now: BASE });           // character already has 20
        await store.deathAdd(room, g, BASE); await store.deathAdd(room, g, BASE); await store.deathAdd(room, c, BASE);
        const before = await sb.deaths(room);
        assert.deepEqual(before.rows.map((r) => [r.name, r.n]), [['Khách7', 2], ['Chi', 1]], 'today ranking by knock-outs, offline players included');
        assert.equal((await sb.transfer(room, G, C, 'Chi')).state, 'moved');
        assert.equal((await sb.transfer(room, G, C, 'Chi')).state, 'exists', 'callback retry / reconnect');
        assert.equal((await sb.transfer(room, G, C2, 'Khác')).state, 'exists', 'logout + another account cannot move it again');
        await store.hit(room, { objId: 'd', defaultHp: 1, cost: 1, playerId: g, now: BASE });           // a late hit by the old guest connection
        let board = await top(room);
        assert.deepEqual(byName(board), { Chi: 100 + 50 + 20 + 10 });
        assert.equal(board.rows.some((r) => r.aid === G), false, 'no guest row is recreated');
        await Promise.all([sb.sync(room), sb2.sync(room)]);
        const rows = await sqlRows(room), d = dayDate(dayOf(BASE));
        assert.equal(rows[G + '@' + d], undefined);
        assert.equal(rows[C + '@' + d].s, 180);
        assert.equal(rows[C + "@" + d].breaks, 4);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM score_transfers WHERE room_id=$1', [room])).rows[0].n, 1);
      });

      await step(`${label}: ties share a rank and keep a stable order; rename changes the board, not history`, async () => {
        const room = uniq('r');
        const ids = ['1', '2', '3', '4'].map((n) => characterActor('00000000-0000-4000-8000-00000000000' + n));
        const ps = [];
        for (let i = 0; i < 4; i++) { ps.push(await join(room, i, ids[i], 'P' + i)); await sb.touch(room, ids[i], 'P' + i); }
        for (const i of [0, 1]) await store.hit(room, { objId: 'x' + i, defaultHp: 1, cost: 5, playerId: ps[i], now: BASE });
        const one = (await top(room, ids)).rows.map((r) => r.aid), two = (await top(room, ids)).rows.map((r) => r.aid);
        assert.deepEqual(one, two);
        const selfs = (await top(room, ids)).selfs;
        assert.deepEqual(selfs.map((s) => s.rank).sort(), [1, 1, 3, 3]);
        await sb.rename(room, ids[0], 'Moi');
        assert.ok(byName(await top(room)).Moi !== undefined);
      });

      await step(`${label}: a full queue is reported (dropped) and never silently trimmed`, async () => {
        const small = make({ maxQueue: 4 }); stores.push(small);
        const room = uniq('q');
        const A = characterActor('00000000-0000-4000-8000-0000000000d1');
        const id = (await small.join(room, { token: 'tok-q-0000000000000001', name: 'Q', fallbackName: 'N', connId: 'c', now: BASE, max: 5, ttlMs: 60000, spawn: { x: 1, y: 1 }, aid: A })).id;
        for (let i = 0; i < 6; i++) await small.hit(room, { objId: 'o' + i, defaultHp: 1, cost: 1, playerId: id, now: BASE });
        const st = await small.queueStat(room);
        assert.equal(st.len, 4); assert.equal(st.dropped, 2);
        await small.close();
      });
    }

    // ---- Redis-only: losing the live data
    await step('redis: Redis data loss recovers the synced part from SQL, never adds it twice', async () => {
      const room = uniq('l'), clock = { now: BASE };
      const sb = createScoreboard({ store: rstore, pool, clock: () => clock.now, log: () => {} });
      const A = characterActor('00000000-0000-4000-8000-0000000000e1');
      const a = (await rstore.join(room, { token: 'tok-l-0000000000000001', name: 'Lo', fallbackName: 'N', connId: 'c', now: BASE, max: 5, ttlMs: 60000, spawn: { x: 1, y: 1 }, aid: A })).id;
      await sb.touch(room, A, 'Lo');
      await rstore.hit(room, { objId: 'o1', defaultHp: 1, cost: 10, playerId: a, now: BASE });
      await sb.sync(room);
      await rstore.hit(room, { objId: 'o2', defaultHp: 1, cost: 4, playerId: a, now: BASE });          // 40 unsynced
      // (1) commit succeeded, ack lost, then the live day vanished (eviction): queue still holds the committed batch
      const batch = await rstore.queueRead(room, 500);
      await sb.applyBatch(room, batch);
      const day = dayOf(BASE);
      await raw.del(`br:{${room}}:ds:${day}`, `br:{${room}}:di:${day}`);
      let b = await sb.board(room);
      assert.equal(b.rows.find((r) => r.aid === A).tenths, 140, 'SQL 140 once, queue replay skipped by the ledger');
      await sb.sync(room);
      // (2) the whole Redis database is lost with 40 more unsynced: only that part is lost
      await rstore.hit(room, { objId: 'o3', defaultHp: 1, cost: 4, playerId: a, now: BASE });
      await raw.flushall();
      const a2 = (await rstore.join(room, { token: 'tok-l-0000000000000001', name: 'Lo', fallbackName: 'N', connId: 'c2', now: BASE, max: 5, ttlMs: 60000, spawn: { x: 1, y: 1 }, aid: A })).id;
      b = await sb.board(room);
      assert.equal(b.rows.find((r) => r.aid === A).tenths, 140);
      await rstore.hit(room, { objId: 'o4', defaultHp: 1, cost: 1, playerId: a2, now: BASE });
      assert.equal((await sb.board(room)).rows.find((r) => r.aid === A).tenths, 150);
      assert.equal((await sb.sync(room)).error, null);
      assert.equal(Number((await pool.query('SELECT score_tenths FROM daily_scores WHERE room_id=$1 AND actor_id=$2', [room, A])).rows[0].score_tenths), 150);
    });

    await step('redis: the queue and the day board outlive the room key TTL', async () => {
      const room = uniq('k'), sb = createScoreboard({ store: rstore, pool, clock: () => BASE, log: () => {} });
      const A = characterActor('00000000-0000-4000-8000-0000000000f1');
      const a = (await rstore.join(room, { token: 'tok-k-0000000000000001', name: 'Ka', fallbackName: 'N', connId: 'c', now: BASE, max: 5, ttlMs: 60000, spawn: { x: 1, y: 1 }, aid: A })).id;
      await sb.touch(room, A, ''); await rstore.hit(room, { objId: 'o1', defaultHp: 1, cost: 6, playerId: a, now: BASE });
      for (const k of await raw.keys(`br:{${room}}:*`)) if (!/:(evq|qs|ds:|di:)/.test(k)) await raw.del(k); // what the 30 minute room expiry removes
      assert.equal((await rstore.queueStat(room)).len, 2);
      assert.equal(await raw.ttl(`br:{${room}}:evq`), -1, 'no TTL on the queue');
      assert.equal((await sb.sync(room)).error, null);
      assert.equal(Number((await pool.query('SELECT score_tenths FROM daily_scores WHERE room_id=$1', [room])).rows[0].score_tenths), 60);
    });

    await step('postgres: failure leaves points queued; recovery applies them once; old days are cleaned, never resurrected', async () => {
      const room = uniq('f'), clock = { now: BASE };
      const bad = new Pool({ connectionString: db, max: 1 }); await bad.end();
      const down = createScoreboard({ store: rstore, pool: bad, clock: () => clock.now, log: () => {} });
      const A = characterActor('00000000-0000-4000-8000-0000000000f2');
      const a = (await rstore.join(room, { token: 'tok-f-0000000000000001', name: 'Fa', fallbackName: 'N', connId: 'c', now: BASE, max: 5, ttlMs: 60000, spawn: { x: 1, y: 1 }, aid: A })).id;
      await down.touch(room, A, 'Fa');                                           // hydrate degrades instead of throwing
      await rstore.hit(room, { objId: 'o1', defaultHp: 1, cost: 3, playerId: a, now: BASE });
      assert.equal((await down.board(room)).rows[0].tenths, 30, 'gameplay and board continue while Postgres is down');
      assert.ok((await down.sync(room)).error, 'sync reports the failure');
      const st = await rstore.queueStat(room); assert.ok(st.len >= 1 && st.err);
      const sb = createScoreboard({ store: rstore, pool, clock: () => clock.now, log: () => {} });
      assert.equal((await sb.sync(room)).error, null);
      assert.equal((await sb.board(room)).rows[0].tenths, 30, 'degraded board rebuilt from SQL + queue, not doubled');
      // retention: events for a day older than the kept window are counted and dropped
      clock.now = BASE + 3 * 86400000;
      await rstore.hit(room, { objId: 'o2', defaultHp: 1, cost: 1, playerId: a, now: BASE });                // stamped with the old day
      const r = await sb.sync(room); assert.equal(r.expired, 1);
      assert.equal(Number((await pool.query('SELECT score_tenths FROM daily_scores WHERE room_id=$1', [room])).rows[0].score_tenths), 30);
      const removed = await sb.cleanup();
      assert.ok(removed.daily_scores >= 1 && removed.score_events >= 1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM daily_scores WHERE room_id=$1', [room])).rows[0].n, 0);
    });

    // ---- chat
    await step('chat: idempotent post, 50-message pages by cursor, 24h filter before and after cleanup, no gaps or repeats', async () => {
      const chat = createChatStore({ pool });
      const room = uniq('chat'), actor = guestActor(room, 'chattoken000000000'), now = Date.now();
      const first = await chat.post(room, { actorId: actor, name: 'Gia', text: 'xin chào', cid: 'cid-000000001' });
      const again = await chat.post(room, { actorId: actor, name: 'Gia', text: 'xin chào', cid: 'cid-000000001' });
      assert.equal(first.fresh, true); assert.equal(again.fresh, false); assert.equal(again.mid, first.mid);
      await pool.query(`INSERT INTO chat_messages(id, room_id, actor_id, client_id, sender_name, body, at_ms)
        SELECT gen_random_uuid(), $1, $2, 'bulk-0000-' || g, 'Gia', 'm' || g, $3::bigint + g FROM generate_series(1, 119) g`, [room, actor, now]);
      await pool.query(`INSERT INTO chat_messages(id, room_id, actor_id, client_id, sender_name, body, at_ms) VALUES(gen_random_uuid(), $1, $2, 'old-00001', 'Gia', 'cũ', $3)`, [room, actor, now - 24 * 3600 * 1000 - 5000]);
      const latest = await chat.history(room), seen = new Set(latest.messages.map((m) => m.mid));
      assert.equal(latest.messages.length, 50); assert.equal(latest.more, true);
      let cursor = latest.messages[0], all = [...latest.messages];
      for (;;) {
        const page = await chat.history(room, { before: cursor });
        for (const m of page.messages) { assert.ok(!seen.has(m.mid), 'no repeat'); seen.add(m.mid); }
        all = [...page.messages, ...all];
        if (!page.more) break;
        cursor = page.messages[0];
      }
      assert.equal(all.length, 120, 'the 24h-old message is not returned although cleanup has not run');
      assert.ok(all.every((m, i) => i === 0 || all[i - 1].at < m.at || (all[i - 1].at === m.at && all[i - 1].mid < m.mid)));
      const gap = await chat.history(room, { after: all[100] });                      // reconnect gap fill
      assert.deepEqual(gap.messages.map((m) => m.mid), all.slice(101, 120).map((m) => m.mid));
      assert.equal(await chat.cleanup(), 1);
      await pool.query('DELETE FROM chat_messages WHERE room_id=$1', [room]);
    });

    await step('maintenance endpoint falls back to HEALTH_KEY and stays closed without any key', async () => {
      const { maintenanceHandler } = require('../lib/maintenance-http');
      const call = async (env, url) => {
        const out = {};
        await maintenanceHandler({ persistence: { status: async () => ({ queue: {} }) }, env })({ method: 'GET', url, headers: {} }, { setHeader() {}, end(b) { out.body = b; }, set statusCode(v) { out.code = v; } });
        return out.code;
      };
      assert.equal(await call({ HEALTH_KEY: 'health-key-1' }, '/api/maintenance?status=1&key=health-key-1'), 200);
      assert.equal(await call({ HEALTH_KEY: 'health-key-1' }, '/api/maintenance?status=1&key=nope'), 401);
      assert.equal(await call({}, '/api/maintenance?status=1&key=anything'), 503);
    });

    // ---- real WebSockets against the app
    await step('websocket: day board rows, chat acknowledged only after the insert, history on join, failures not shown as sent', async () => {
      const app = createApp({ store: createMemoryStore({ persistScores: true }), env: { DATABASE_URL: db, MOLE_DISABLED: '1', BOSS_DISABLED: '1', MAINTENANCE_SECRET: 'maintenance-test-secret' } });
      const port = await app.start(0);
      const room = 'br-1';
      const a = await client(port, 'Ann', room), b = await client(port, 'Bob', room);
      try {
        assert.equal(a.welcome.chatHistory, true);
        await smashPlant(a, TYPES);
        const board = await take(b, (m) => m.t === 'board' && m.board.some((r) => r.name === 'Ann' && r.score > 0), 2500);
        assert.ok(board.board.every((r) => Number.isInteger(r.rank) && r.rank >= 1) && board.day && board.room === room);
        assert.ok(board.board.some((r) => r.name === 'Bob' && r.score === 0), 'players with 0 points are listed');
        const wire = JSON.stringify([...a.msgs, ...b.msgs]);
        const leak = wire.match(/"aid"|"actor"|"bot"|[bgc]:[0-9a-f]{8}-|[g]:[0-9a-f]{20}/);
        assert.ok(!leak, 'no internal actor/bot markers reach clients: ' + (leak && wire.slice(Math.max(0, leak.index - 40), leak.index + 60)));

        send(a, { t: 'chat', text: 'hello <3', cid: 'cid-ws-000001' });
        const ack = await take(a, (m) => m.t === 'chatAck' && m.cid === 'cid-ws-000001');
        const live = await take(b, (m) => m.t === 'chat' && m.text === 'hello <3');
        assert.equal(live.mid, ack.mid);
        assert.ok(live.at > 0);
        await sleep(1100);
        send(a, { t: 'chat', text: 'hello <3', cid: 'cid-ws-000001' });                      // client retry
        const again = await take(a, (m) => m.t === 'chatAck' && m.cid === 'cid-ws-000001');
        assert.equal(again.mid, ack.mid);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM chat_messages WHERE room_id=$1 AND body='hello <3'", [room])).rows[0].n, 1);

        const c = await client(port, 'Cat', room);                                          // joins later: gets history, not live lines
        const hist = await take(c, (m) => m.t === 'chatHist');
        assert.equal(hist.dir, 'latest');
        assert.deepEqual(hist.messages.map((m) => m.text), ['hello <3']);
        assert.equal(hist.messages[0].name, 'Ann');
        assert.ok(!c.msgs.some((m) => m.t === 'chat'), 'history is not replayed as live chat');

        const real = app.persistence.chat.post;
        app.persistence.chat.post = async () => { throw new Error('db down'); };
        await sleep(1100);
        send(a, { t: 'chat', text: 'lost', cid: 'cid-ws-000002' });
        await take(a, (m) => m.t === 'chatFail' && m.cid === 'cid-ws-000002');
        await none(b, (m) => m.t === 'chat' && m.text === 'lost', 400);
        app.persistence.chat.post = real;

        await sleep(1100);
        send(a, { t: 'rank' });
        const rank = await take(a, (m) => m.t === 'rank').catch(() => null);                 // in the top rows already: no reply needed
        assert.ok(rank === null || rank.rank >= 1);
        const base = `http://127.0.0.1:${port}/api/maintenance`;
        assert.equal((await fetch(base)).status, 401);
        assert.equal((await fetch(base + '?key=wrong-secret-value')).status, 401);
        assert.equal((await fetch(base, { headers: { Authorization: 'Bearer maintenance-test-secret' } })).status, 200);
        const viaKey = await fetch(base + '?key=maintenance-test-secret');
        assert.equal(viaKey.status, 200); assert.equal((await viaKey.json()).ok, true);
        let row;
        for (let i = 0; i < 40 && !(row && row.s > 0); i++) {               // the game's own 5 s drain may hold the lock; either drain is fine
          assert.ok((await app.persistence.scoreboard.sync(room)).error === null);
          row = (await pool.query("SELECT score_tenths::int AS s, name FROM daily_scores WHERE room_id=$1 AND name='Ann'", [room])).rows[0];
          if (!(row && row.s > 0)) await sleep(100);
        }
        assert.ok(row && row.s > 0);
      } finally {
        for (const x of [a, b]) x.ws.close();
        await app.stop();
      }
    });
  } finally {
    for (const s of stores) await s.close().catch(() => {});
    raw.disconnect();
    await pool.end();
  }
  console.log(`\nAll ${passed} score/chat checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
