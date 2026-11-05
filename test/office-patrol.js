'use strict';
const assert = require('node:assert/strict');
const { emptyPatrol, nextPatrol, patrolActive } = require('../lib/office-patrol');
const { BOSS, createBossState, stepBoss } = require('../lib/boss');
const { BOSS_HOME, inBossZone, resolveCollisions, OBJECTS, WORLD } = require('../lib/world');
const { createMini, stepMini } = require('../lib/miniboss');
const { makeMole, stepMole } = require('../lib/moles');
const { createMemoryStore } = require('../lib/store-memory');
const { createRedisStore } = require('../lib/store-redis');
const { createApp } = require('../server');
const { client, take, send, sleep, none } = require('./helpers');
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('ok - office: ' + name); };

async function main() {
  await check('schedule warns, hunts for 30 seconds, returns home and excludes duels/dead bosses', () => {
    const cfg = { minMs: 180000, maxMs: 300000, warningMs: 5000, durationMs: 30000 };
    const ctx = { alive: true, duel: false, humans: 1, home: true };
    let s = nextPatrol(emptyPatrol(), 100, ctx, () => 0, cfg);
    assert.equal(s.nextAt, 180100);
    assert.equal(nextPatrol(s, s.nextAt, { ...ctx, duel: true }, () => 0, cfg).phase, 'idle');
    assert.equal(nextPatrol(s, s.nextAt, { ...ctx, alive: false }, () => 0, cfg).phase, 'idle');
    s = nextPatrol(s, s.nextAt, ctx, () => 0, cfg);
    assert.equal(s.phase, 'warning');
    s = nextPatrol(s, s.until, ctx, () => 0, cfg);
    assert.equal(s.phase, 'active'); assert.ok(patrolActive(s, s.until - 1));
    s = nextPatrol(s, s.until, { ...ctx, home: false }, () => 0, cfg);
    assert.equal(s.phase, 'returning');
    assert.equal(nextPatrol(s, s.until + 1, { ...ctx, home: false }).phase, 'returning');
    assert.equal(nextPatrol(s, 220000, ctx, () => 0, cfg).phase, 'idle');
  });
  await check('VKL exits the server through the doorway, returns without teleporting and cannot cast New Process', () => {
    const b = createBossState();
    let outside = false;
    for (let i = 0; i < 300; i++) {
      const events = stepBoss(b, .1, [], () => .5, { office: true });
      assert.ok(events.every(e => e.skill !== 'newProcess'));
      const p = resolveCollisions(b.x, b.y, BOSS.radius);
      assert.ok(Math.hypot(p.x - b.x, p.y - b.y) < .1);
      outside ||= !inBossZone(b.x, b.y);
    }
    assert.ok(outside, 'VKL must actually leave the room during the event');
    const before = { x: b.x, y: b.y };
    stepBoss(b, .1, [], () => .5, { office: true, returning: true });
    assert.ok(Math.hypot(before.x - b.x, before.y - b.y) <= BOSS.chaseSpeed * .1 + .1);
    for (let i = 0; i < 600 && Math.hypot(b.x - BOSS_HOME.x, b.y - BOSS_HOME.y) > 20; i++) stepBoss(b, .1, [], () => .5, { office: true, returning: true });
    assert.ok(Math.hypot(b.x - BOSS_HOME.x, b.y - BOSS_HOME.y) < 24, 'VKL returns home along the floor graph');
    b.processCooldown = 0;
    const events = [];
    for (let i = 0; i < 30; i++) events.push(...stepBoss(b, .1, [{ id: 1, x: b.x + 50, y: b.y }], () => .5, { office: true }));
    assert.ok(events.some(e => e.type === 'strike'));
    assert.ok(events.every(e => e.skill !== 'newProcess'));
  });
  await check('minis hunt unprovoked players/bots only during patrol, share targets, and cancel pending patrol strikes', () => {
    const a = createMini('TML'), b = createMini('DMM');
    Object.assign(a, { x: WORLD.spawn.x, y: WORLD.spawn.y });
    Object.assign(b, { x: a.x, y: a.y + 40 });
    const state = { version: 0, list: [a, b] };
    const targets = [{ id: 1, x: a.x + 70, y: a.y }, { id: 2, x: a.x + 70, y: a.y + 50 }];
    stepMini(state, targets, 1000, .1, () => .5);
    assert.equal(a.wind, null);
    stepMini(state, targets, 1100, .1, () => .5, true, [1]);
    assert.ok(a.wind && b.wind);
    assert.deepEqual(a.threat, {}, 'patrol targeting must not create lasting provocation');
    assert.deepEqual(stepMini(state, targets, 3000, .1, () => .5, false), [], 'no late strike after the event');
  });
  await check('concealed moles flee instead of stabbing and do not reveal themselves', () => {
    const m = makeMole({ id: 1, connId: 'a', name: 'A', ...WORLD.spawn }, 0, { mingleMs: [0, 0] });
    m.x = WORLD.spawn.x; m.y = WORLD.spawn.y;
    const events = stepMole(m, .1, { now: 1000, patrol: true, humans: [{ id: 2, x: m.x, y: m.y }], bosses: [{ x: m.x - 30, y: m.y }] });
    assert.deepEqual(events, []); assert.equal(m.revealed, false); assert.ok(m.moved);
  });

  for (const kind of ['memory', ...(process.env.TEST_REDIS_URL ? ['redis'] : [])]) {
    const store = kind === 'memory' ? createMemoryStore() : createRedisStore(process.env.TEST_REDIS_URL, { log: () => {} });
    const room = 'of-' + kind + '-' + Date.now().toString(36), now = Date.now();
    try {
      await check(kind + ': six racks cap support at 12%, replacements cannot farm damage, and support cannot kill or claim bounty', async () => {
        const rackIds = OBJECTS.filter(o => o.type === 'server').map(o => o.id);
        const hit = (objId, dmg = 8) => store.hit(room, { objId, dmg, defaultHp: 8, cost: 120, playerId: 1, now, serverBossHp: 6000 });
        let r = await hit(rackIds[0], .5);
        assert.equal(r.applied, .5);
        r = await hit(rackIds[0], 8); assert.equal(r.applied, 7.5); assert.equal(r.bossDamage, 120);
        assert.equal((await hit(rackIds[0])).state, 'none');
        for (const id of rackIds.slice(1)) await hit(id);
        assert.equal((await store.bossGet(room, { now, maxHp: 6000 })).hp, 5280);
        await store.reset(room, { now, cooldownMs: 0 });
        await hit(rackIds[0]);
        assert.equal((await store.bossGet(room, { now, maxHp: 6000 })).hp, 5280);
        const cfg = { ...BOSS, maxHp: 6000 };
        const kill = await store.bossHit(room, { playerId: 2, dmg: 6000, now, cfg, respawnAt: now + 1, bounty: 500 });
        assert.equal(kill.shares.length, 1); assert.equal(kill.shares[0].id, 2);
        await store.bossRespawn(room, { now: now + 2, maxHp: 6000 });
        await store.reset(room, { now: now + 2, cooldownMs: 0 });
        assert.equal((await hit(rackIds[0])).bossDamage, 120, 'new boss life re-arms racks');
        await store.bossHit(room, { playerId: 2, dmg: 5875, now, cfg, respawnAt: now + 1, bounty: 500 });
        await hit(rackIds[1]);
        assert.equal((await store.bossGet(room, { now, maxHp: 6000 })).hp, 1);
      });
      await check(kind + ': patrol saves fence stale leaders and versions; boss hits on bots neither reveal nor award money', async () => {
        const r = room + 'p';
        await store.bossLock(r, 'a', { now, ttlMs: 10000 });
        const state = { ...emptyPatrol(), version: 1, phase: 'active', until: now + 30000, pose: { x: 2500, y: 1600 } };
        assert.equal(await store.patrolSave(r, { owner: 'x', now, expected: 0, state }), false);
        assert.equal(await store.patrolSave(r, { owner: 'a', now, expected: 0, state }), true);
        assert.equal(await store.patrolSave(r, { owner: 'a', now, expected: 0, state }), false);
        assert.deepEqual(await store.patrolGet(r, { now }), state);
        const duel = { version: 1, nextAt: 0, target: 1, until: now + 5000, startedAt: now, moves: [] };
        assert.equal(await store.duelSave(r, { owner: 'a', now, expected: 0, state: duel }), false, 'a duel cannot start during patrol');
        assert.equal(await store.patrolSave(r, { owner: 'a', now, expected: 1, state: { ...state, version: 2, phase: 'idle' } }), true);
        assert.equal(await store.duelSave(r, { owner: 'a', now, expected: 0, state: duel }), true);
        assert.equal(await store.patrolSave(r, { owner: 'a', now, expected: 2, state: { ...state, version: 3, phase: 'warning' } }), false, 'a late patrol warning cannot overlap a committed duel');

        await store.moleAdd(r, 1, { hp: 8, conn: 'm', now });
        let hp = await store.moleHurt(r, 1, 30, now);
        assert.ok(Math.abs(hp.hp - 5.6) < .001); assert.equal(hp.revealed, false);
        const bots = await store.moleList(r, { now }); assert.equal(bots[0].revealed, false);
        for (let i = 0; i < 3; i++) hp = await store.moleHurt(r, 1, 30, now);
        assert.equal(hp.hp, 0); assert.equal(await store.moleHurt(r, 1, 30, now), null);
        assert.equal((await store.read(r, { now, ttlMs: 20000 })).total, 0);
      });
    } finally { await store.close(); }
  }

  await check('WebSocket shocks deduct actual HP and do not charge already broken racks', async () => {
    const store = createMemoryStore();
    const cfg = { env: { FIXED_ROOMS: '0' }, store, bossEnabled: false, moleEnabled: false };
    const app = createApp(cfg), port = await app.start(0);
    let c;
    const old = { ...WORLD.spawn };
    try {
      const rack = OBJECTS.find(o => o.type === 'server');
      Object.assign(WORLD.spawn, { x: rack.x, y: rack.y + 105, rx: 0, ry: 0 });
      c = await client(port, 'Shock', 'shock');
      send(c, { t: 'hit', id: rack.id, skill: 'milkTea' });
      const shock = await take(c, m => m.t === 'serverShock'); assert.equal(shock.dmg, 2.5);
      const hp = await take(c, m => m.t === 'hp' && m.id === c.id); assert.equal(hp.hp, 97.5);
      assert.equal(shock.bossDamage, 0);
      await store.hit('shock', { objId: rack.id, dmg: 8, defaultHp: 8, cost: 120, playerId: c.id, now: Date.now() });
      await sleep(200);
      send(c, { t: 'hit', id: rack.id });
      await none(c, m => m.t === 'serverShock');
      await none(c, m => m.t === 'hp' && m.id === c.id);

    } finally { Object.assign(WORLD.spawn, old); c?.ws.close(); await app.stop(); }
  });
  if (process.env.TEST_REDIS_URL) await check('shared event announces across instances, restores reconnects, and survives leader handover', async () => {
    const url = process.env.TEST_REDIS_URL;
    const make = () => createRedisStore(url, { log: () => {} });
    const storeA = make(), storeB = make(), room = 'patrol-' + Date.now().toString(36);
    const options = { env: { FIXED_ROOMS: '0' }, moleEnabled: false, patrolOpts: { minMs: 50, maxMs: 50, warningMs: 1000, durationMs: 12000 }, log: () => {} };
    const a = createApp({ ...options, store: storeA }), b = createApp({ ...options, store: storeB });
    let ca, cb, again, stopped = false;
    try {
      const pa = await a.start(0), pb = await b.start(0);
      ca = await client(pa, 'PatrolA', room);
      const warning = await take(ca, m => m.t === 'officePatrol' && m.state.phase === 'warning', 6000);
      cb = await client(pb, 'PatrolB', room);
      assert.equal(cb.welcome.officePatrol.phase, 'warning');
      assert.equal(cb.welcome.officePatrol.until, warning.state.until);
      const active = await take(ca, m => m.t === 'officePatrol' && m.state.phase === 'active', 4000);
      const remote = await take(cb, m => m.t === 'officePatrol' && m.state.phase === 'active', 4000);
      assert.equal(remote.state.until, active.state.until);
      const token = cb.token; cb.ws.close();
      again = await client(pb, 'PatrolB', room, token);
      assert.equal(again.welcome.officePatrol.until, active.state.until);
      await sleep(1100);
      const before = await storeB.patrolGet(room, { now: Date.now() });
      await a.stop(); stopped = true;
      const takeoverDeadline = Date.now() + 5500;
      let after;
      do {
        await sleep(100);
        after = await storeB.patrolGet(room, { now: Date.now() });
      } while (after.version <= before.version && Date.now() < takeoverDeadline);
      assert.equal(after.until, active.state.until, 'handover must not restart the 30-second event');
      assert.ok(after.version > before.version, 'successor resumes the committed event');
      assert.ok(Math.hypot(after.pose.x - BOSS_HOME.x, after.pose.y - BOSS_HOME.y) > 10, 'successor retains the roaming position');
    } finally { ca?.ws.close(); cb?.ws.close(); again?.ws.close(); if (!stopped) await a.stop(); await b.stop(); }
  });

  console.log(`All ${passed} office patrol checks passed`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
