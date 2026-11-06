'use strict';

// Prof. K: rules (lib/profk.js), the store contract (memory and, with TEST_REDIS_URL, Redis) and one real
// WebSocket outing where his punches only take HP off VKL while a player is hitting it too.

process.env.FIXED_ROOMS = '0';
const assert = require('node:assert/strict');
const { PROFK, DIRECTOR, inDirector, home, createProfK, stepProfK, profkView } = require('../lib/profk');
const { BOSS } = require('../lib/boss');
const { DUEL } = require('../lib/duel');
const { MINI, RADIUS: MINI_RADIUS } = require('../lib/miniboss');
const { BOSS_HOME, WORLD, serverPoint, resolveCollisions } = require('../lib/world');
const { createMemoryStore } = require('../lib/store-memory');
const { createRedisStore } = require('../lib/store-redis');
const { createApp } = require('../server');
const { client, take, send, sleep, none } = require('./helpers');

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('ok - profk: ' + name); };
const world = (o = {}) => ({ vkl: { x: BOSS_HOME.x, y: BOSS_HOME.y, alive: true }, duel: false, humans: 1, assistAt: 0, players: [], ...o });
const cfg = { ...PROFK, restMinMs: 1000, restMaxMs: 1000 };

async function main() {
  await check('size and speed sit between TML/DMM and VKL', () => {
    assert.ok(PROFK.radius > MINI_RADIUS && PROFK.radius < BOSS.radius);
    for (const m of Object.values(MINI)) {
      assert.ok(PROFK.runSpeed > m.speed && PROFK.walkSpeed > m.wanderSpeed);
    }
    assert.ok(PROFK.runSpeed < BOSS.chaseSpeed && PROFK.walkSpeed < BOSS.patrolSpeed);
    assert.equal(PROFK.windupMs, BOSS.windupMs, 'the punch is VKL\'s own');
  });

  await check('stays in the DIRECTOR room between outings and waits 60–90 s', () => {
    const s = createProfK(0, () => 0);
    assert.equal(s.nextAt, 60000);
    assert.equal(createProfK(0, () => 1).nextAt, 90000);
    assert.ok(inDirector(home(), 40));
    for (let t = 0; t < 59000; t += 100) {
      stepProfK(s, t, 0.1, world(), () => 0.5);
      assert.ok(inDirector(s, PROFK.radius - 1), 'left the room at ' + t + ': ' + s.x + ',' + s.y);
      assert.equal(s.phase, 'home');
    }
  });

  await check('a missed outing (no VKL, nobody online, a duel) is skipped, not replayed', () => {
    for (const o of [{ vkl: null }, { humans: 0 }, { duel: true }, { vkl: { ...BOSS_HOME, alive: false } }]) {
      const s = createProfK(0, () => 0, cfg);
      stepProfK(s, 1000, 0.1, world(o), () => 0, cfg);
      assert.equal(s.phase, 'home');
      assert.equal(s.nextAt, 2000);
    }
  });

  await check('warns 5 s, walks out to VKL and punches with VKL\'s telegraph; damage only counts with a player hitting', () => {
    const s = createProfK(0, () => 0, cfg);
    let t = 1000;
    stepProfK(s, t, 0.1, world(), () => 0.5, cfg);
    assert.equal(s.phase, 'warning'); assert.equal(s.until, 6000);
    const strikes = [];
    let windups = 0;
    for (t = 1100; t <= 37000; t += 100) {
      // a player hits VKL every second between 20 s and 25 s
      const assistAt = t >= 20000 && t <= 25000 ? Math.floor(t / 1000) * 1000 : 0;
      if (s.wind && s.mode === 'windup' && s.wind.until === t + PROFK.windupMs) windups++;
      for (const e of stepProfK(s, t, 0.1, world({ assistAt }), () => 0.5, cfg)) strikes.push({ ...e, t, assistAt });
      if (t === 6000) assert.equal(s.phase, 'out');
      if (s.wind) assert.equal(s.wind.r, BOSS.punchRadius);
    }
    assert.ok(strikes.length >= 8, 'kept punching: ' + strikes.length);
    assert.ok(strikes.every(e => e.hit), 'every punch reached VKL standing still');
    assert.ok(strikes.some(e => e.real) && strikes.some(e => !e.real));
    for (const e of strikes) assert.equal(e.real, e.t - e.assistAt <= PROFK.assistMs);
    assert.ok(strikes.every(e => e.t < 36000), 'stops at the end of the 30 s');
    assert.ok(['returning', 'home'].includes(s.phase));
    assert.equal(s.wind, null);
  });

  await check('VKL falling mid-outing sends him home, where the next 60–90 s wait starts', () => {
    const s = createProfK(0, () => 0, cfg);
    stepProfK(s, 1000, 0.1, world(), () => 0, cfg);
    stepProfK(s, 6000, 0.1, world(), () => 0, cfg);
    assert.equal(s.phase, 'out');
    for (let t = 6100; t < 9000; t += 100) stepProfK(s, t, 0.1, world(), () => 0, cfg);
    stepProfK(s, 9000, 0.1, world({ vkl: null }), () => 0, cfg);
    assert.equal(s.phase, 'returning');
    let t = 9000;
    for (; s.phase === 'returning' && t < 40000; t += 100) {
      const events = stepProfK(s, t, 0.1, world({ vkl: null, assistAt: t }), () => 0, cfg);
      assert.equal(events.length, 0, 'no punches on the way home');
    }
    assert.equal(s.phase, 'home');
    assert.ok(Math.hypot(s.x - home().x, s.y - home().y) < 24);
    assert.equal(s.nextAt, t - 100 + 1000);
  });

  await check('follows VKL anywhere (the office patrol) without walking through walls', () => {
    const s = createProfK(0, () => 0, cfg);
    stepProfK(s, 1000, 0.1, world(), () => 0, cfg);
    const roaming = resolveCollisions(1600, 1700, BOSS.radius);
    let near = false;
    for (let t = 6000; t < 30000 && !near; t += 100) {
      stepProfK(s, t, 0.1, world({ vkl: { ...roaming, alive: true } }), () => 0, cfg);
      const p = resolveCollisions(s.x, s.y, PROFK.radius);
      assert.ok(Math.hypot(p.x - s.x, p.y - s.y) < 0.5, 'inside furniture at ' + s.x + ',' + s.y);
      near = Math.hypot(roaming.x - s.x, roaming.y - s.y) <= PROFK.punchStartDist;
    }
    assert.ok(near, 'reached VKL out in the office');
  });

  await check('the view clients get has no hit points', () => {
    const v = profkView(createProfK(0), 0);
    assert.equal(v.hp, undefined); assert.equal(v.phase, 'home'); assert.equal(v.cfg.radius, PROFK.radius);
  });

  const stores = [['memory', createMemoryStore()]];
  if (process.env.TEST_REDIS_URL) stores.push(['redis', createRedisStore(process.env.TEST_REDIS_URL, { log: () => {} })]);
  else console.log('SKIP - profk: TEST_REDIS_URL not set; Redis store contract not run');
  for (const [kind, store] of stores) {
    const room = 'pk-' + kind + Date.now().toString(36), now = Date.now();
    try {
      await check(kind + ': saves are fenced by the lease and version; outings and duels exclude each other', async () => {
        await store.bossLock(room, 'a', { now, ttlMs: 10000 });
        const state = { ...createProfK(now), version: 1, phase: 'out', until: now + 30000 };
        assert.equal(await store.profkSave(room, { owner: 'x', now, expected: 0, state }), false);
        assert.equal(await store.profkSave(room, { owner: 'a', now, expected: 0, state }), true);
        assert.equal(await store.profkSave(room, { owner: 'a', now, expected: 0, state }), false);
        assert.deepEqual(await store.profkGet(room, { now }), state);
        const duel = { version: 1, nextAt: 0, target: 1, until: now + 5000, startedAt: now, moves: [] };
        assert.equal(await store.duelSave(room, { owner: 'a', now, expected: 0, state: duel }), false, 'no duel while Prof. K is out');
        assert.equal(await store.profkSave(room, { owner: 'a', now, expected: 1, state: { ...state, version: 2, phase: 'home' } }), true);
        assert.equal(await store.duelSave(room, { owner: 'a', now, expected: 0, state: duel }), true);
        assert.equal(await store.profkSave(room, { owner: 'a', now, expected: 2, state: { ...state, version: 3, phase: 'warning' } }), false, 'no warning during a duel');
      });
      await check(kind + ': Prof. K damage takes HP but no bounty share, even with the last punch', async () => {
        const r = room + 'b', bcfg = { ...BOSS, maxHp: 100 };
        await store.bossHit(r, { playerId: 7, dmg: 30, now, cfg: bcfg, respawnAt: now + 1000, bounty: 500 });
        const k = await store.bossHit(r, { playerId: 0, dmg: 50, now, cfg: bcfg, respawnAt: now + 1000, bounty: 500, credited: false });
        assert.equal(k.state, 'hit'); assert.equal(Math.round(k.hp), 20);
        const last = await store.bossHit(r, { playerId: 0, dmg: 20, now, cfg: bcfg, respawnAt: now + 1000, bounty: 500, credited: false });
        assert.equal(last.state, 'killed');
        assert.deepEqual(last.shares.map(s => [s.id, s.bounty]), [[7, 500]]);
      });
    } finally { await store.close(); }
  }

  await check('WebSocket: announced outing, VKL loses HP from Prof. K only while a player hits it', async () => {
    const store = createMemoryStore();
    const app = createApp({ env: { FIXED_ROOMS: '0' }, store, moleEnabled: false, bossMaxHp: 6000, spawnProtectionMs: 0,
      patrolOpts: { minMs: 600000, maxMs: 600000 }, duelConfig: { ...DUEL, minMs: 600000, maxMs: 600000 }, profkOpts: { restMinMs: 300, restMaxMs: 300, warningMs: 500, fightMs: 20000 }, log: () => {} });
    const port = await app.start(0), old = { ...WORLD.spawn };
    let c, h;
    try {
      Object.assign(WORLD.spawn, { ...serverPoint(420, 380), rx: 0, ry: 0 });
      c = await client(port, 'Fan', 'pk-ws');
      const warning = await take(c, m => m.t === 'profk' && m.state.phase === 'warning', 6000);
      assert.ok(warning.state.ms > 0);
      await take(c, m => m.t === 'profk' && m.state.phase === 'out', 3000);
      const swing = await take(c, m => m.t === 'profkStrike', 15000);
      assert.equal(swing.real, false, 'nobody hit VKL: a punch for show');
      await none(c, m => m.t === 'bhp' && m.by === 'profk', 1500);
      // VKL knocks a lone watcher out within seconds, so a fresh player joins right next to it and starts hitting.
      const vkl = c.msgs.filter(m => m.t === 'boss').pop();
      Object.assign(WORLD.spawn, { ...resolveCollisions(vkl.x, vkl.y + 60), rx: 0, ry: 0 });
      h = await client(port, 'Hitter', 'pk-ws');
      const hitting = setInterval(() => send(h, { t: 'bhit' }), 300);
      try {
        const real = await take(c, m => m.t === 'bhp' && m.by === 'profk', 8000);
        assert.ok(real.hp < 6000);
        const mine = c.msgs.filter(m => m.t === 'bhp' && m.by === h.id);
        assert.ok(mine.length, 'the player hit VKL too');
      } finally { clearInterval(hitting); }
    } finally { Object.assign(WORLD.spawn, old); c?.ws.close(); h?.ws.close(); await app.stop(); }
  });

  console.log(`All ${passed} Prof. K checks passed`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
