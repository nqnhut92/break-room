'use strict';
const assert = require('assert');
const M = require('../lib/miniboss');
const { WORLD, resolveCollisions, SERVER_ROOM, LAYOUT_SCALE: K, layoutPoint } = require('../lib/world');
const h = require('./helpers');
let passed = 0;
async function check(name, fn) { await fn(); console.log('ok - ' + name); passed++; }
const at = layoutPoint(1920,1950);
const player = (id, extra = {}) => ({ id, ...at, dead: false, ...extra });
const state = () => ({ version: 1, list: [{ ...M.createMini('TML'), ...at }] });
async function main() {
  await check('mini-boss HP, damage and movement match the approved settings', () => {
    assert.deepStrictEqual([M.MINI.TML.maxHp, M.MINI.TML.damage, M.MINI.TML.speed, M.MINI.TML.wanderSpeed, M.MINI.TML.bounty], [900, 20, 460, 200, 40]);
    assert.deepStrictEqual([M.MINI.DMM.maxHp, M.MINI.DMM.damage, M.MINI.DMM.speed, M.MINI.DMM.wanderSpeed, M.MINI.DMM.bounty], [600, 15, 440, 180, 30]);
  });
  await check('spawns cover connected floor across the map and avoid players', () => {
    const points = [...M.nav().values()];
    assert.ok(points.some(p => p.x < 500) && points.some(p => p.x > WORLD.w - 500));
    for (let i = 0; i < 80; i++) {
      const p = M.spawn([at]), q = resolveCollisions(p.x, p.y, M.RADIUS);
      assert.ok(Math.hypot(p.x - q.x, p.y - q.y) < 0.1);
      assert.ok(Math.hypot(p.x - at.x, p.y - at.y) >= 180);
    }
  });
  await check('nearby people never provoke a neutral mini-boss', () => {
    const s = state();
    for (let i = 0; i < 100; i++) assert.deepStrictEqual(M.stepMini(s, [player(1)], 1000 + i * 100, 0.1), []);
    assert.deepStrictEqual(s.list[0].threat, {});
  });
  await check('retaliation is telegraphed and only aggressors can be struck', () => {
    const s = state(), b = s.list[0];
    M.hitMini(b, 1, 10, 1000);
    assert.deepStrictEqual(M.stepMini(s, [player(1), player(2)], 1000, 0.1), []);
    assert.strictEqual(b.mode, 'windup');
    assert.deepStrictEqual(M.stepMini(s, [player(1), player(2)], 1849, 0.1), []);
    const [hit] = M.stepMini(s, [player(1), player(2)], 1850, 0.1);
    assert.deepStrictEqual(hit.targets, [1]); assert.strictEqual(hit.dmg, 20);
    assert.strictEqual(b.mode, 'recover');
    assert.deepStrictEqual(M.stepMini(s, [player(1)], 2000, 0.1), []);
  });
  await check('aggro is independent; death, leaving, and eight seconds away clear it without healing', () => {
    const s = state(), b = s.list[0]; s.list.push({ ...M.createMini('DMM'), x: at.x + 80, y: at.y });
    M.hitMini(b, 1, 10, 1000);
    M.stepMini(s, [player(1, { x: 1000 })], 9000, 0.1);
    assert.deepStrictEqual(b.threat, {}); assert.strictEqual(b.hp, 890);
    assert.deepStrictEqual(s.list[1].threat, {});
    M.hitMini(b, 1, 10, 10000); M.stepMini(s, [player(1)], 10000, 0.1);
    M.stepMini(s, [player(1, { dead: true })], 11000, 0.1);
    assert.strictEqual(b.wind, null); assert.deepStrictEqual(b.threat, {});
    M.hitMini(b, 1, 10, 12000); M.stepMini(s, [], 12001, 0.1);
    assert.deepStrictEqual(b.threat, {});
  });
  await check('damage credit is capped at remaining HP, bounty is split by damage, respawn waits exactly 30s', () => {
    const s = state(), b = s.list[0];
    M.hitMini(b, 1, 300, 1000);
    const result = M.hitMini(b, 2, 2000, 2000);
    assert.strictEqual(result.dmg, 600); assert.strictEqual(result.shares.reduce((n, s) => n + s.bounty, 0), 40);
    assert.ok(result.shares[1].bounty > result.shares[0].bounty);
    assert.strictEqual(M.hitMini(b, 1, 10, 3000), null);
    M.stepMini(s, [], 31999, 0.1); assert.strictEqual(s.list[0].hp, 0);
    M.stepMini(s, [], 32000, 0.1); assert.strictEqual(s.list[0].hp, 900);
    assert.ok(Math.hypot(s.list[0].x - b.x, s.list[0].y - b.y) >= 240);
    assert.deepStrictEqual(s.list[0].ledger, {}); assert.deepStrictEqual(s.list[0].threat, {});
  });
  await check('mini-boss navigation can pursue targets across distant map regions', () => {
    const points = [...M.nav().values()];
    for (const i of [0, Math.floor(points.length / 3), Math.floor(points.length * 2 / 3), points.length - 1]) {
      const s = state(), b = s.list[0], target = player(1, points[i]);
      M.hitMini(b, 1, 10, 1000);
      for (let tick = 0; tick < 500 && !b.wind; tick++) {
        b.lastHit = 1000 + tick * 200;
        M.stepMini(s, [target], b.lastHit, 0.2);
      }
      assert.ok(b.wind, 'reaches ' + target.x + ',' + target.y);
    }
  });
  await check('a wall blocks starting retaliation even when the target is close', () => {
    // Either side of the server room's west glass wall (its door is in the south wall).
    const midY = (SERVER_ROOM.y0 + SERVER_ROOM.y1) / 2;
    const s = state(), b = s.list[0]; Object.assign(b, { x: SERVER_ROOM.x0+40, y: midY });
    M.hitMini(b, 1, 10, 1000);
    M.stepMini(s, [player(1, { x: SERVER_ROOM.x0-40, y: midY })], 1000, 0.1);
    assert.strictEqual(b.wind, null);
  });
  await check('both minis travel diagonally at their configured speed on clear floor and cannot cut wall corners', () => {
    for (const id of ['TML','DMM']) {
      const s={version:1,list:[{...M.createMini(id),x:1920,y:1950}]}, b=s.list[0];
      const goal={x:2120,y:2070};
      const before={...b}; M.move(b,goal,.1,M.MINI[id].speed,1000);
      assert.ok(b.x>before.x && b.y>before.y,'both axes advance in the same tick');
      assert.ok(Math.abs(Math.hypot(b.x-before.x,b.y-before.y)-M.MINI[id].speed*.1)<.01,'normalized diagonal speed');
      Object.assign(b,{x:SERVER_ROOM.x0-50,y:1500*K});
      for(let tick=0;tick<100;tick++) {
        M.move(b,layoutPoint(3100,1580),.1,M.MINI[id].speed,2000+tick*100);
        const q=resolveCollisions(b.x,b.y,M.RADIUS);
        assert.ok(Math.hypot(q.x-b.x,q.y-b.y)<.1,'body stays off walls/furniture');
      }
      const wander={...M.createMini(id),x:1920,y:1950,goal:{x:2120,y:2070}};
      M.stepMini({list:[wander]},[],1000,.1);
      assert.ok(wander.x>1920 && wander.y>1950);
      assert.ok(Math.abs(Math.hypot(wander.x-1920,wander.y-1950)-M.MINI[id].wanderSpeed*.1)<.01);
    }
  });
  await check('roaming remains on free floor', () => {
    const s = M.initialState();
    for (let i = 0; i < 600; i++) {
      M.stepMini(s, [], 1000 + i * 200, 0.2);
      for (const b of s.list) {
        const q = resolveCollisions(b.x, b.y, M.RADIUS);
        assert.ok(Math.hypot(q.x - b.x, q.y - b.y) < 0.2);
      }
    }
  });
  await network();
  console.log('\nAll ' + passed + ' checks passed');
}
async function network() {
  process.env.FIXED_ROOMS = '0'; delete process.env.REDIS_URL; delete process.env.KV_URL; delete process.env.VERCEL;
  const { createMemoryStore } = require('../lib/store-memory');
  const store = createMemoryStore(), room = 'mini-net';
  const seed = state(); seed.list.push({ ...M.createMini('DMM'), x: 2300, y: at.y });
  await store.miniSave(room, { now: Date.now(), expected: 0, state: seed });
  const app = require('../server').createApp({ store, bossEnabled: false, rageOpts: { max: 2, cooldownMs: 100 }, log: () => {} });
  const originalSpawn = WORLD.spawn; WORLD.spawn = { ...at, rx: 0, ry: 0 };
  let a, b, c;
  try {
    const port = await app.start(0);
    a = await h.client(port, 'Aggressor', room); b = await h.client(port, 'Bystander', room);
    await check('wire: welcome exposes both mini-bosses, neutral players are safe', async () => {
      assert.strictEqual(a.welcome.minis.list.length, 2);
      assert.strictEqual(a.welcome.minis.list.find(b => b.id === 'TML').cfg.maxHp, 900);
      await h.none(a, m => ['miniStrike', 'hp', 'down'].includes(m.t), 1100);
    });
    await check('wire: bad IDs and out-of-range hits do no damage; hammer and milk tea use 10/5', async () => {
      h.send(a, { t: 'miniHit', id: '__proto__' }); h.send(a, { t: 'miniHit', id: 'DMM' });
      await h.none(a, m => m.t === 'miniHit', 300);
      h.send(a, { t: 'miniHit', id: 'TML' });
      const hit = await h.take(a, m => m.t === 'miniHit', 2000); assert.strictEqual(hit.dmg, 10);
      await h.sleep(230); h.send(a, { t: 'miniHit', id: 'TML', skill: 'milkTea' });
      const milk = await h.take(a, m => m.t === 'miniHit' && m.skill === 'milkTea', 2000); assert.strictEqual(milk.dmg, 5);
    });
    await check('wire: retaliation hurts the aggressor and leaves the overlapping bystander untouched', async () => {
      const hp = await h.take(a, m => m.t === 'hp' && m.id === a.id, 2500); assert.strictEqual(hp.dmg, 20);
      assert.ok(!b.msgs.some(m => ['hp', 'down'].includes(m.t) && m.id === b.id));
    });
    await check('wire: mini hits fill rage and ultimate takes 20%, then empties it', async () => {
      await h.take(a, m => m.t === 'rage' && m.v === 2, 1000);
      h.send(a, { t: 'ult' });
      const hit = await h.take(a, m => m.t === 'miniHit' && m.ult, 2000); assert.strictEqual(hit.dmg, 180);
      await h.take(a, m => m.t === 'rage' && m.v === 0, 1000);
    });
    await check('wire: reconnect reads persisted HP, threat, and respawn timer', async () => {
      a.ws.close(); await h.sleep(100);
      c = await h.client(port, 'Returning', room);
      assert.strictEqual(c.welcome.minis.list.find(b => b.id === 'TML').hp, 705);
    });
  } finally {
    WORLD.spawn = originalSpawn;
    for (const p of [a, b, c]) if (p) p.ws.close();
    await app.stop();
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
