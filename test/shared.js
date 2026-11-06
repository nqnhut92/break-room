'use strict';

// Shared-state tests. Part 1 runs the same store contract against the in-memory
// store and against a real Redis. Part 2 starts two game servers on one Redis,
// which is what two Vercel instances look like, and plays across them.
//
// Redis comes from TEST_REDIS_URL, or a throwaway `redis-server` on a free port.
// If neither is available the Redis parts are skipped (and say so).

process.env.RESPAWN_MS = '1500';
delete process.env.REDIS_URL;
delete process.env.KV_URL;
delete process.env.VERCEL;
process.env.FIXED_ROOMS = '0';

const assert = require('assert');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const Redis = require('ioredis');
const server = require('../server.js');
const { createMemoryStore } = require('../lib/store-memory');
const { createRedisStore } = require('../lib/store-redis');
const h = require('./helpers.js');
const world = require('../lib/world.js');

const { sleep, send, take, none, WebSocket } = h;
let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log('ok - ' + name);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function startRedis() {
  if (process.env.TEST_REDIS_URL) return { url: process.env.TEST_REDIS_URL, stop: async () => {} };
  const port = await freePort();
  let proc;
  try {
    proc = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], {
      stdio: 'ignore',
    });
  } catch (e) {
    return null;
  }
  let spawnFailed = false;
  proc.on('error', () => {
    spawnFailed = true;
  });
  const url = 'redis://127.0.0.1:' + port;
  for (let i = 0; i < 50; i++) {
    if (spawnFailed) return null;
    const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    r.on('error', () => {});
    try {
      await r.connect();
      await r.ping();
      r.disconnect();
      return { url, stop: async () => proc.kill() };
    } catch (e) {
      r.disconnect();
      await sleep(100);
    }
  }
  proc.kill();
  return null;
}

// ------------------------------------------------------------ contract ----
async function contract(label, makeStore) {
  const store = makeStore();
  const room = 'c-' + label + '-' + Date.now();
  const T = (n) => 'token-' + label + '-' + n + '-0123456789';
  const NOW = Date.now();
  const base = { name: 'N', fallbackName: 'Nhân viên ', now: NOW, max: 3, ttlMs: 5000, spawn: { x: 100, y: 200 } };

  await step(label + ': join assigns stable ids, reconnect keeps id and position', async () => {
    const a = await store.join(room, { ...base, token: T(1), connId: 'c1', name: 'An' });
    const b = await store.join(room, { ...base, token: T(2), connId: 'c2', name: 'Binh' });
    assert.ok(a.id && b.id && a.id !== b.id);
    assert.deepStrictEqual(a.pos, { x: 100, y: 200, d: 1 });
    assert.strictEqual(a.prevConn, '');
    // the owner leaves while remembering where it stood
    assert.strictEqual(await store.leave(room, a.id, 'c1', { x: 321, y: 123, d: -1 }, NOW), true);
    const a2 = await store.join(room, { ...base, token: T(1), connId: 'c3', name: 'An' });
    assert.strictEqual(a2.id, a.id);
    assert.deepStrictEqual(a2.pos, { x: 321, y: 123, d: -1 });
    // a new connection for a live slot reports the connection it replaces
    const a3 = await store.join(room, { ...base, token: T(1), connId: 'c4', name: 'An' });
    assert.strictEqual(a3.prevConn, 'c3');
    // ... and the stale connection's late close must not evict the new one
    assert.strictEqual(await store.leave(room, a.id, 'c3', null, NOW), false);
    const snap = await store.read(room, { now: NOW, ttlMs: 5000 });
    assert.deepStrictEqual(snap.players.map((p) => p.id).sort(), [a.id, b.id].sort());
  });

  await step(label + ': a name already used by someone online is refused (exact, case-sensitive)', async () => {
    const r2 = room + '-names';
    const big = { ...base, max: 10 };
    const a = await store.join(r2, { ...big, token: T(11), connId: 'n1', name: 'Nick' });
    assert.ok(a.id);
    const dup = await store.join(r2, { ...big, token: T(12), connId: 'n2', name: 'Nick' });
    assert.strictEqual(dup.taken, true);
    const other = await store.join(r2, { ...big, token: T(13), connId: 'n3', name: 'nick' });
    assert.ok(other.id, 'a different case is a different name');
    // the refused attempt left nothing behind: it did not consume an id or a token
    const again = await store.join(r2, { ...big, token: T(12), connId: 'n4', name: 'Nick2' });
    assert.strictEqual(again.id, other.id + 1);
    // the owner reconnecting with the same token is not a clash
    const back = await store.join(r2, { ...big, token: T(11), connId: 'n5', name: 'Nick' });
    assert.strictEqual(back.id, a.id);
    // once the owner is gone the name is free again
    await store.leave(r2, a.id, 'n5', null, NOW);
    const taker = await store.join(r2, { ...big, token: T(14), connId: 'n6', name: 'Nick' });
    assert.ok(taker.id && taker.id !== a.id);
  });

  await step(label + ': gender is stored with the player and read back', async () => {
    const r3 = room + '-gender';
    const big = { ...base, max: 10 };
    const a = await store.join(r3, { ...big, token: T(51), connId: 'g1', name: 'Hoa', gender: 'f' });
    const b = await store.join(r3, { ...big, token: T(52), connId: 'g2', name: 'Nam', gender: 'm' });
    const snap = await store.read(r3, { now: NOW, ttlMs: 5000 });
    const byId = Object.fromEntries(snap.players.map((p) => [p.id, p.gender]));
    assert.strictEqual(byId[a.id], 'f');
    assert.strictEqual(byId[b.id], 'm');
    // a reconnect that does not say anything keeps the stored gender
    await store.join(r3, { ...big, token: T(51), connId: 'g3', name: 'Hoa' });
    const again = await store.read(r3, { now: NOW, ttlMs: 5000 });
    assert.strictEqual(again.players.find((p) => p.id === a.id).gender, 'f');
  });

  await step(label + ': player health and the knock-out timer are stored with the player and read back', async () => {
    const r5 = room + '-hp';
    const big = { ...base, max: 10 };
    const a = await store.join(r5, { ...big, token: T(71), connId: 'h1', name: 'Hurt' });
    let snap = await store.read(r5, { now: NOW, ttlMs: 5000 });
    assert.strictEqual(snap.players.find((p) => p.id === a.id).hp, null, 'nothing stored yet: the caller treats it as full');
    await store.setHp(r5, a.id, { hp: 0, at: NOW, deadUntil: NOW + 60000 });
    snap = await store.read(r5, { now: NOW, ttlMs: 5000 });
    const me = snap.players.find((p) => p.id === a.id);
    assert.strictEqual(me.hp, 0);
    assert.strictEqual(me.deadUntil, NOW + 60000);
    await store.setHp(r5, a.id, { hp: 62.5, at: NOW + 1, deadUntil: 0 });
    const again = (await store.read(r5, { now: NOW, ttlMs: 5000 })).players.find((p) => p.id === a.id);
    assert.strictEqual(again.hp, 62.5);
    assert.strictEqual(again.deadUntil, 0);
  });

  await step(label + ': mini-boss: concurrent damage commits preserve hits and pay a kill exactly once', async () => {
    const M = require('../lib/miniboss'), r = room + '-mini';
    const a = await store.join(r, { ...base, token: T(901), connId: 'mini-a' });
    const b = await store.join(r, { ...base, token: T(902), connId: 'mini-b' });
    const first = M.initialState(); first.version = 1;
    assert.strictEqual(await store.miniSave(r, { now: NOW, expected: 0, state: first }), true);
    const hit = async (id, damage) => {
      for (;;) {
        const state = await store.miniGet(r, { now: NOW });
        const boss = state.list[0];
        const result = M.hitMini(boss, id, damage, NOW);
        if (!result) return false;
        const expected = state.version; state.version++;
        if (await store.miniSave(r, { now: NOW, expected, state, shares: result.shares })) return true;
      }
    };
    await Promise.all([hit(a.id, 100), hit(b.id, 200)]);
    let current = await store.miniGet(r, { now: NOW });
    assert.strictEqual(current.list[0].hp, 600);
    assert.strictEqual(current.list[0].ledger[a.id], 100);
    assert.strictEqual(current.list[0].ledger[b.id], 200);
    assert.strictEqual((await Promise.all([hit(a.id, 1000), hit(b.id, 1000)])).filter(Boolean).length, 1);
    const snap = await store.read(r, { now: NOW, ttlMs: 5000 });
    assert.ok(Math.abs(snap.total - 40) < 0.0001);
    current = await store.miniGet(r, { now: NOW });
    assert.strictEqual(current.list[0].respawnAt, NOW + 30000);
    assert.strictEqual(await store.miniSave(r, { now: NOW, expected: 1, state: first, shares: [{ id: a.id, bounty: 40 }] }), false);
    assert.ok(Math.abs((await store.read(r, { now: NOW, ttlMs: 5000 })).total - 40) < 0.0001);
  });

  await step(label + ': mini-boss: only the current runner can move or respawn; state survives handover', async () => {
    const M = require('../lib/miniboss'), r = room + '-mini-leader';
    await store.bossLock(r, 'first', { now: NOW, ttlMs: 3000 });
    const first = M.initialState(); first.version = 1;
    M.hitMini(first.list[0], 1, 900, NOW);
    assert.strictEqual(await store.miniSave(r, { now: NOW, owner: 'first', expected: 0, state: first }), true);
    const next = structuredClone(first); next.version++;
    assert.strictEqual(await store.miniSave(r, { now: NOW, owner: 'other', expected: 1, state: next }), false);
    const resumed = await store.miniGet(r, { now: NOW + 30000 });
    M.stepMini(resumed, [], NOW + 29999, 0.1); assert.strictEqual(resumed.list[0].hp, 0);
    M.stepMini(resumed, [], NOW + 30000, 0.1); assert.strictEqual(resumed.list[0].hp, 900);
    resumed.version++;
    assert.strictEqual(await store.miniSave(r, { now: NOW, owner: 'first', expected: 1, state: resumed }), true);
    assert.strictEqual(await store.miniSave(r, { now: NOW, owner: 'first', expected: 1, state: resumed }), false);
    await store.bossLock(r, 'first', { now: NOW, ttlMs: 30 });
    await sleep(50);
    assert.strictEqual(await store.bossLock(r, 'second', { now: NOW + 50, ttlMs: 3000 }), true);
    const transferred = await store.miniGet(r, { now: NOW + 50 });
    transferred.version++;
    assert.strictEqual(await store.miniSave(r, { now: NOW + 50, owner: 'first', expected: 2, state: transferred }), false);
    assert.strictEqual(await store.miniSave(r, { now: NOW + 50, owner: 'second', expected: 2, state: transferred }), true);
  });

  await step(label + ': boss: hits subtract, regenerate with time, and the killing blow pays the bounty by damage, once', async () => {
    const r6 = room + '-boss';
    const big = { ...base, max: 10 };
    const a = await store.join(r6, { ...big, token: T(81), connId: 'b1', name: 'Ann' });
    const b = await store.join(r6, { ...big, token: T(82), connId: 'b2', name: 'Ben' });
    const cfg = { maxHp: 100, baseRegenPerSec: 1, regenPerSec: 10, regenDelayMs: 5000 };
    const hitArgs = (id, dmg, now, respawnAt = now + 60000) => ({ playerId: id, dmg, now, cfg, respawnAt, bounty: 500 });
    assert.deepStrictEqual(await store.bossGet(r6, { now: NOW, maxHp: 100 }), { rev: 0, hp: 100, maxHp: 100, at: NOW, dead: false, respawnAt: 0 });
    let r = await store.bossHit(r6, hitArgs(a.id, 30, NOW));
    assert.strictEqual(r.state, 'hit');
    assert.strictEqual(Math.round(r.hp), 70);
    // two seconds later it has recovered a little (1 hp per second), not yet the fast rate
    r = await store.bossHit(r6, hitArgs(b.id, 10, NOW + 2000));
    assert.strictEqual(Math.round(r.hp), 62);
    // a long quiet moment: it heals fast, up to the maximum
    r = await store.bossHit(r6, hitArgs(a.id, 10, NOW + 62000));
    assert.strictEqual(Math.round(r.hp), 90);
    // beat it: a does 70 more, b has done 10 so far (a: 30 + 10 + 10 = 50 before the last blow)
    const total0 = (await store.read(r6, { now: NOW, ttlMs: 5000 })).total;
    r = await store.bossHit(r6, hitArgs(a.id, 200, NOW + 62100, NOW + 80000));
    assert.strictEqual(r.state, 'killed');
    const shares = Object.fromEntries(r.shares.map((s) => [s.id, s]));
    assert.ok(shares[a.id].bounty > shares[b.id].bounty, 'the bigger damage dealer gets the bigger share');
    assert.ok(Math.abs(shares[a.id].bounty + shares[b.id].bounty - 500) <= 0.2, 'the whole bounty is paid out');
    const after = await store.read(r6, { now: NOW, ttlMs: 5000 });
    assert.ok(Math.abs(after.total - total0 - 500) < 0.01, 'the room total grows by the bounty');
    assert.ok(Math.abs(after.players.find((p) => p.id === b.id).score - shares[b.id].bounty) < 0.01);
    // already down: the next hit does nothing and pays nothing
    assert.strictEqual((await store.bossHit(r6, hitArgs(b.id, 10, NOW + 62200))).state, 'dead');
    assert.strictEqual((await store.read(r6, { now: NOW, ttlMs: 5000 })).total, after.total);
    const st = await store.bossGet(r6, { now: NOW + 62300, maxHp: 100 });
    assert.strictEqual(st.dead, true);
    // it comes back only when its time is up, and exactly one caller brings it back
    assert.strictEqual(await store.bossRespawn(r6, { now: NOW + 70000, maxHp: 100 }), false);
    const both = await Promise.all([0, 1].map(() => store.bossRespawn(r6, { now: NOW + 81000, maxHp: 100 })));
    assert.strictEqual(both.filter(Boolean).length, 1);
    const back = await store.bossGet(r6, { now: NOW + 81000, maxHp: 100 });
    assert.strictEqual(back.dead, false);
    assert.strictEqual(Math.round(back.hp), 100);
    // a fresh fight starts a fresh damage ledger
    r = await store.bossHit(r6, hitArgs(b.id, 100, NOW + 81100));
    assert.strictEqual(r.state, 'killed');
    assert.deepStrictEqual(r.shares.map((s) => s.id), [b.id]);
    assert.ok(Math.abs(r.shares[0].bounty - 500) < 0.01);
  });

  await step(label + ': boss population: real presence only, delayed additive HP, atomic ult/racks, no repeated waves or reconnect inflation', async () => {
    const r = room + '-population', cfg = { maxHp: 6000, baseRegenPerSec: 0, regenPerSec: 0, regenDelayMs: 5000 };
    const humans = [], bots = [], ttlMs = 120000;
    const join = async (i, now = NOW) => store.join(r, { ...base, now, max: 30, ttlMs, token: T(300+i), connId: 'pop'+i, name: 'Pop'+i });
    for (let i=0;i<4;i++) humans.push(await join(i));
    for (let i=10;i<16;i++) { const b=await join(i); bots.push(b); await store.moleAdd(r,b.id,{now:NOW,hp:8,conn:'pop'+i}); }
    const hit = (dmg, now, extra={}) => store.bossHit(r,{playerId:humans[0].id,dmg,now,cfg,respawnAt:now+1000,bounty:500,...extra});
    await hit(5700,NOW);
    await store.summonSnakes(r,{now:NOW,maxHp:6000,count:1,x:3300,y:1700});
    const observe = async (at, owner='a') => {
      assert.ok(await store.bossLock(r,owner,{now:at,ttlMs:120000}));
      return store.bossScale(r,{owner,now:at,ttlMs,maxHp:6000});
    };
    for(let i=0;i<=20;i++) assert.equal((await observe(NOW+i*1000)).maxHp,6000,'six bots do not increase HP');
    humans.push(await join(4,NOW+20000));
    for(let i=20;i<=34;i++) assert.equal((await observe(NOW+i*1000)).maxHp,6000,'must wait the entire 15s');
    await store.bossLock(r,'a',{now:NOW+34000,ttlMs:25}); await sleep(40);
    assert.ok(await store.bossLock(r,'b',{now:NOW+34040,ttlMs:120000}));
    assert.equal(await store.bossScale(r,{owner:'a',now:NOW+35000,ttlMs,maxHp:6000}),null,'stale leader fenced');
    const [grown] = await Promise.all([observe(NOW+35000,'b'),hit(10,NOW+35000)]);
    assert.equal(grown.maxHp,9000);
    let st=await store.bossGet(r,{now:NOW+35000,maxHp:6000});
    assert.equal(st.hp,3290,'damage survives concurrent growth'); assert.equal(st.maxHp,9000);
    assert.deepEqual((await store.summonSnakes(r,{now:NOW+35000,maxHp:6000,count:1,x:3300,y:1700})).waves,[]);
    const ult=await hit(1,NOW+35001,{share:.2}); assert.equal(ult.dmg,1800); assert.equal(ult.hp,1490);
    const rack=await store.hit(r,{objId:800,defaultHp:8,cost:120,playerId:humans[0].id,now:NOW+35002,dmg:8,serverBossHp:6000});
    assert.equal(rack.bossDamage,180); assert.equal(rack.bossHp,1310);
    await store.leave(r,humans[4].id,'pop4',null,NOW+36000);
    assert.equal((await observe(NOW+36000,'b')).maxHp,9000,'leaving does not reduce the current life');
    await join(4,NOW+37000);
    for(let i=37;i<=55;i++) assert.equal((await observe(NOW+i*1000,'b')).maxHp,9000,'rejoining the same tier never adds HP');
    assert.equal((await hit(20000,NOW+55001)).state,'killed');
    assert.equal(await store.bossScale(r,{owner:'b',now:NOW+55002,ttlMs,maxHp:6000}),null,'never revive a dead boss by scaling');
    await store.leave(r,humans[4].id,'pop4',null,NOW+56000);
    assert.ok(await store.bossRespawn(r,{now:NOW+57000,maxHp:6000,ttlMs}));
    st=await store.bossGet(r,{now:NOW+57000,maxHp:6000}); assert.equal(st.hp,6000); assert.equal(st.maxHp,6000);
    assert.deepEqual(Object.keys(st).sort(),['at','dead','hp','maxHp','respawnAt','rev'],'no population counts or bot classification in snapshots');
  });

  await step(label + ': boss population: thresholds must stay reached, lower tiers keep their own timers, stale presence is excluded', async () => {
    const r=room+'-population-timers', ttlMs=60000, people=[];
    const add = async i => people.push(await store.join(r,{...base,max:30,ttlMs,token:T(400+i),connId:'timer'+i,name:'Timer'+i}));
    for(let i=0;i<9;i++) await add(i);
    const observe=async at=>{await store.bossLock(r,'leader',{now:at,ttlMs:120000}); return store.bossScale(r,{owner:'leader',now:at,ttlMs,maxHp:6000});};
    for(let i=0;i<=5;i++) await observe(NOW+i*1000);
    for(let i=5;i<9;i++) await store.leave(r,people[i].id,'timer'+i,null,NOW+5500);
    for(let i=6;i<=15;i++) await observe(NOW+i*1000);
    assert.equal((await store.bossGet(r,{now:NOW+15000,maxHp:6000})).maxHp,9000,'lower threshold keeps its timer when a higher one drops');
    for(let i=5;i<9;i++) await store.join(r,{...base,now:NOW+16000,max:30,ttlMs,token:T(400+i),connId:'timer'+i,name:'Timer'+i});
    for(let i=16;i<=30;i++) assert.equal((await observe(NOW+i*1000)).maxHp,9000);
    assert.equal((await observe(NOW+31000)).maxHp,12000);
    // A long inactive gap cannot be evidence of continuous population.
    for(let i=9;i<13;i++) await add(i);
    await observe(NOW+32000);
    assert.equal((await observe(NOW+38000)).maxHp,12000);
    for(let i=39;i<=52;i++) assert.equal((await observe(NOW+i*1000)).maxHp,12000);
    assert.equal((await observe(NOW+53000)).maxHp,15000);
    // All original presence has expired by this point; it cannot raise another tier.
    assert.equal((await observe(NOW+130000)).maxHp,15000);
  });

  await step(label + ': boss: concurrent killing blows pay out exactly once', async () => {
    const r7 = room + '-boss2';
    const big = { ...base, max: 10 };
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await store.join(r7, { ...big, token: T(90 + i), connId: 'q' + i, name: 'P' + i })).id);
    const cfg = { maxHp: 40, baseRegenPerSec: 0, regenPerSec: 0, regenDelayMs: 5000 };
    const results = await Promise.all(ids.map((id) => store.bossHit(r7, { playerId: id, dmg: 100, now: NOW, cfg, respawnAt: NOW + 1000, bounty: 500 })));
    assert.strictEqual(results.filter((x) => x.state === 'killed').length, 1);
    assert.strictEqual(results.filter((x) => x.state === 'dead').length, 3);
    const snap = await store.read(r7, { now: NOW, ttlMs: 5000 });
    assert.strictEqual(snap.total, 500);
  });

  await step(label + ': boss: one runner at a time holds the lease and keeps it by renewing', async () => {
    const r8 = room + '-bosslock';
    assert.strictEqual(await store.bossLock(r8, 'inst-a', { now: NOW, ttlMs: 250 }), true);
    assert.strictEqual(await store.bossLock(r8, 'inst-b', { now: NOW + 25, ttlMs: 250 }), false);
    assert.strictEqual(await store.bossLock(r8, 'inst-a', { now: NOW + 50, ttlMs: 250 }), true, 'the holder renews');
    await sleep(350); // real time passes: the lease of a store that does not see our fake clock must lapse too
    assert.strictEqual(await store.bossLock(r8, 'inst-b', { now: NOW + 500, ttlMs: 250 }), true, 'a dead holder is replaced after the lease runs out');
  });

  await step(label + ': compaction forgets offline players who never scored, keeps scorers and online players', async () => {
    const r4 = room + '-compact';
    const big = { ...base, max: 10 };
    const idle = await store.join(r4, { ...big, token: T(61), connId: 'k1', name: 'Idle' });
    const scorer = await store.join(r4, { ...big, token: T(62), connId: 'k2', name: 'Scorer' });
    const online = await store.join(r4, { ...big, token: T(63), connId: 'k3', name: 'Online' });
    await store.hit(r4, { objId: 1, defaultHp: 1, cost: 5, playerId: scorer.id, now: NOW });
    await store.leave(r4, idle.id, 'k1', null, NOW);
    await store.leave(r4, scorer.id, 'k2', null, NOW);
    const later = NOW + 130000;
    // the online player keeps being refreshed by its instance, like in the real game
    await store.housekeep(r4, { now: later, ttlMs: 5000, respawnMs: 25000, sweep: false, entries: [{ id: online.id, connId: 'k3', pos: null }] });
    const idleAgain = await store.join(r4, { ...big, token: T(61), connId: 'k4', name: 'Idle', now: later });
    const scorerAgain = await store.join(r4, { ...big, token: T(62), connId: 'k5', name: 'Scorer', now: later });
    const onlineAgain = await store.join(r4, { ...big, token: T(63), connId: 'k6', name: 'Online', now: later });
    assert.notStrictEqual(idleAgain.id, idle.id, 'the idle player was forgotten and gets a new id');
    assert.strictEqual(scorerAgain.id, scorer.id, 'a player with a score is kept');
    assert.strictEqual(onlineAgain.id, online.id, 'a player who is online is kept');
  });

  await step(label + ': room capacity is enforced, existing players can still rejoin', async () => {
    await store.join(room, { ...base, token: T(3), connId: 'c5', name: 'Chi' });
    const full = await store.join(room, { ...base, token: T(4), connId: 'c6', name: 'Dung' });
    assert.strictEqual(full.full, true);
    const again = await store.join(room, { ...base, token: T(2), connId: 'c7', name: 'Binh' });
    assert.ok(again.id);
  });

  await step(label + ': drink offers are shared, expire and can only be claimed once', async () => {
    const r = room + '-drinks';
    const offer = opts => store.drinkOffer(r, { intervalMs: 300000, windowMs: 5000, ...opts });
    const state = await offer({ now: NOW });
    assert.strictEqual(state.id, NOW + 300000);
    assert.ok(!state.available);
    assert.ok((await offer({ now: state.id })).available);
    const claims = await Promise.all(Array.from({ length: 12 }, () => offer({ now: state.id + 10, claim: true, offerId: state.id })));
    assert.strictEqual(claims.filter(r => r.claimed).length, 1);
    assert.ok(!(await offer({ now: state.id + 5000, claim: true, offerId: state.id })).claimed);
    assert.ok((await offer({ now: state.id + 300000 })).available);
  });

  await step(label + ': snake thresholds are atomic and four hits kill without resurrection', async () => {
    const r = room + '-snake-waves';
    const cfg = { maxHp: 100, baseRegenPerSec: 0, regenPerSec: 0, regenDelayMs: 0 };
    const hit = dmg => store.bossHit(r, { playerId: 1, dmg, now: NOW, cfg, respawnAt: NOW + 1000, bounty: 500 });
    const summon = () => store.summonSnakes(r, { maxHp: 100, count: 2, finalCount: 4, x: 3360, y: 1700, now: NOW });
    for (const percent of [70, 40, 10]) {
      await hit(30);
      const attempts = await Promise.all([summon(), summon()]);
      assert.strictEqual(attempts.reduce((n, r) => n + r.snakes.length, 0), percent === 10 ? 4 : 2);
      assert.deepStrictEqual(attempts.flatMap(r => r.waves), [percent]);
      assert.ok(attempts.flatMap(r => r.snakes).every(s => s.variant === (percent === 10 ? 'red' : 'green')));
    }
    const snakes = await store.snakeList(r, { now: NOW });
    assert.strictEqual(snakes.length, 8);
    assert.strictEqual(snakes.filter(s => s.variant === 'red').length, 4);
    for (let i = 0; i < 4; i++) assert.strictEqual((await store.snakeHit(r, snakes[0].id, NOW)).hp, 3 - i);
    await store.snakeMove(r, [{ ...snakes[0], x: 4000 }], NOW);
    assert.strictEqual((await store.snakeList(r, { now: NOW })).length, 7);
    await hit(10); await store.bossRespawn(r, { now: NOW + 1000, maxHp: 100 });
    assert.strictEqual((await store.snakeList(r, { now: NOW + 1000 })).length, 0);
  });

  await step(label + ': knock-outs are counted per player', async () => {
    const r = room + '-deaths';
    await store.deathAdd(r, 3, NOW); await store.deathAdd(r, 3, NOW); await store.deathAdd(r, 4, NOW);
    const list = (await store.deathList(r, NOW)).sort((a, b) => a.id - b.id);
    assert.deepStrictEqual(list, [{ id: 3, n: 2 }, { id: 4, n: 1 }]);
  });

  await step(label + ': the ultimate bar is remembered per player', async () => {
    const r = room + '-rage';
    assert.strictEqual(await store.rageGet(r, 5), 0);
    await store.rageSet(r, 5, 42.5, NOW);
    assert.strictEqual(await store.rageGet(r, 5), 42.5);
    assert.strictEqual(await store.rageGet(r, 6), 0);
  });

  await step(label + ': a mole is secret until hit, dies once and pays its bounty to the one who killed it', async () => {
    const r = room + '-mole';
    await store.moleAdd(r, 7, { hp: 8, conn: 'c7', now: NOW });
    assert.deepStrictEqual(await store.moleList(r, { now: NOW }), [{ id: 7, hp: 8, revealed: false, conn: 'c7' }]);
    assert.deepStrictEqual(await store.moleHit(r, { id: 99, dmg: 1, cost: 120, playerId: 1, now: NOW }), { state: 'none' });
    const first = await store.moleHit(r, { id: 7, dmg: 3, cost: 120, playerId: 1, now: NOW });
    assert.deepStrictEqual([first.state, first.hp], ['hit', 5]);
    assert.strictEqual((await store.moleList(r, { now: NOW }))[0].revealed, true);
    const kills = await Promise.all([1, 2, 3].map((p) => store.moleHit(r, { id: 7, dmg: 5, cost: 120, playerId: p, now: NOW })));
    assert.strictEqual(kills.filter((k) => k.state === 'killed').length, 1);
    assert.deepStrictEqual(await store.moleList(r, { now: NOW }), []);
    const snap = await store.read(r, { now: NOW, ttlMs: 5000 });
    assert.strictEqual(snap.total, 120);
    await store.moleAdd(r, 8, { hp: 8, conn: 'c8', now: NOW });
    await store.moleReveal(r, 8, NOW);
    assert.strictEqual((await store.moleList(r, { now: NOW }))[0].revealed, true);
    await store.moleDel(r, 8, NOW);
    assert.deepStrictEqual(await store.moleList(r, { now: NOW }), []);
  });

  await step(label + ': concurrent hits break an object exactly once and score it once', async () => {
    const r2 = room + '-hits';
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        store.hit(r2, { objId: 5, defaultHp: 2, cost: 0.5, playerId: (i % 3) + 1, now: NOW }),
      ),
    );
    assert.strictEqual(results.filter((r) => r.state === 'broke').length, 1);
    assert.strictEqual(results.filter((r) => r.state === 'hit').length, 1);
    assert.strictEqual(results.filter((r) => r.state === 'none').length, 28);
    const snap = await store.read(r2, { now: NOW, ttlMs: 5000 });
    assert.strictEqual(snap.total, 0.5);
    assert.ok(snap.objects[5].brokenAt > 0);
  });

  await step(label + ': a hit can do half damage: two of them break a one-hit object, and the hp stays readable', async () => {
    const r5 = 'half-' + label + Date.now();
    const pl = await store.join(r5, { ...base, max: 10, token: T(40), connId: 'h1', name: 'Halfer' });
    const NOW2 = Date.now();
    const h1 = await store.hit(r5, { objId: 7, defaultHp: 1, cost: 2, playerId: pl.id, now: NOW2, dmg: 0.5 });
    assert.deepStrictEqual({ state: h1.state, hp: h1.hp }, { state: 'hit', hp: 0.5 });
    const snap1 = await store.read(r5, { now: NOW2, ttlMs: 60000 });
    assert.strictEqual(snap1.objects[7].hp, 0.5, 'the snapshot reads the fractional hp');
    const h2 = await store.hit(r5, { objId: 7, defaultHp: 1, cost: 2, playerId: pl.id, now: NOW2, dmg: 0.5 });
    assert.strictEqual(h2.state, 'broke');
    const h3 = await store.hit(r5, { objId: 8, defaultHp: 3, cost: 2, playerId: pl.id, now: NOW2 }); // a normal hit still takes 1
    assert.deepStrictEqual({ state: h3.state, hp: h3.hp }, { state: 'hit', hp: 2 });
  });

  await step(label + ': housekeeping respawns broken objects and prunes dead players', async () => {
    const r3 = room + '-hk';
    await store.hit(r3, { objId: 1, defaultHp: 1, cost: 2, playerId: 1, now: NOW });
    let hk = await store.housekeep(r3, { now: NOW + 500, ttlMs: 5000, respawnMs: 1000, sweep: true, entries: [] });
    assert.deepStrictEqual([hk.remaining, hk.respawned], [1, []]);
    hk = await store.housekeep(r3, { now: NOW + 1500, ttlMs: 5000, respawnMs: 1000, sweep: true, entries: [] });
    assert.deepStrictEqual([hk.remaining, hk.respawned], [0, [1]]);
    assert.strictEqual((await store.read(r3, { now: NOW, ttlMs: 5000 })).objects[1], undefined);

    const j = await store.join(r3, { ...base, token: T(9), connId: 'x1', now: NOW, name: 'P1' });
    // heartbeats keep a player alive; silence past the ttl removes them
    hk = await store.housekeep(r3, {
      now: NOW + 4000, ttlMs: 5000, respawnMs: 1000, sweep: false,
      entries: [{ id: j.id, connId: 'x1', pos: { x: 5, y: 6, d: 1 } }],
    });
    assert.deepStrictEqual(hk.pruned, []);
    hk = await store.housekeep(r3, { now: NOW + 10000, ttlMs: 5000, respawnMs: 1000, sweep: false, entries: [] });
    assert.deepStrictEqual(hk.pruned, [j.id]);
    assert.strictEqual((await store.read(r3, { now: NOW + 10000, ttlMs: 5000 })).players.length, 0);
  });

  // Controlled clocks exercise the same adaptive contract in RAM and Redis.
  async function adaptiveRoom(suffix, people, count) {
    const r = room + '-adaptive-' + suffix, live = [];
    for (let i = 0; i < people; i++) {
      const connId = 'adaptive-' + suffix + '-' + i;
      const player = await store.join(r, { ...base, now: NOW, ttlMs: 1000000, max: 30, token: T(1000 + i), name: 'A' + i, connId });
      live.push({ id: player.id, connId, pos: null });
    }
    for (let i = 1; i <= count; i++) await store.hit(r, { objId: i, defaultHp: 1, cost: 1, playerId: live[0]?.id || 1, now: NOW });
    return { r, live };
  }
  const sweepAdaptive = (r, at, entries = [], ttlMs = 1000000, extra = {}) =>
    store.housekeep(r, { now: NOW + at, ttlMs, respawnMs: 0, sweep: true, entries, ...extra });

  await step(label + ': adaptive IT gives a quiet room 60s and ignores partially damaged objects', async () => {
    const { r } = await adaptiveRoom('quiet', 1, 3);
    for (let id = 4; id <= 30; id++) await store.hit(r, { objId: id, defaultHp: 3, cost: 1, playerId: 1, now: NOW });
    assert.deepStrictEqual((await sweepAdaptive(r, 59999)).respawned, []);
    const done = await sweepAdaptive(r, 60000);
    assert.strictEqual(done.remaining, 0);
    assert.deepStrictEqual(done.respawned.sort((a,b)=>a-b), [1,2,3]);
    assert.strictEqual((await store.read(r, { now: NOW + 60000, ttlMs: 1000000 })).objects[4].hp, 2);
  });
  await step(label + ': adaptive IT freezes broken count for a sweep, including the 25s lower bound', async () => {
    const { r } = await adaptiveRoom('batch', 1, 20);
    assert.strictEqual((await sweepAdaptive(r, 51499)).remaining, 20);
    assert.strictEqual((await sweepAdaptive(r, 51500)).respawned.length, 20, 'every item uses the pre-sweep count');
    const crowded = await adaptiveRoom('many-items', 1, 100);
    assert.strictEqual((await sweepAdaptive(crowded.r, 24999)).remaining, 100);
    assert.strictEqual((await sweepAdaptive(crowded.r, 25000)).respawned.length, 100);
  });
  await step(label + ': adaptive IT excludes moles and stale humans and keeps each room independent', async () => {
    const busy = await adaptiveRoom('people', 2, 1);
    for (let i = 0; i < 8; i++) {
      const connId = 'fake-' + i;
      const bot = await store.join(busy.r, { ...base, ttlMs: 1000000, max: 30, token: T(2000 + i), name: 'Fake' + i, connId });
      await store.moleAdd(busy.r, bot.id, { hp: 8, conn: connId, now: NOW });
    }
    const quiet = await adaptiveRoom('other-room', 1, 1);
    assert.deepStrictEqual((await sweepAdaptive(busy.r, 57499)).respawned, []);
    assert.deepStrictEqual((await sweepAdaptive(busy.r, 57500)).respawned, [1]);
    assert.deepStrictEqual((await sweepAdaptive(quiet.r, 57500)).respawned, []);
    const expired = await adaptiveRoom('expired', 2, 1);
    const hk = await sweepAdaptive(expired.r, 57500, [expired.live[0]], 5000);
    assert.deepStrictEqual(hk.pruned, [expired.live[1].id]);
    assert.deepStrictEqual(hk.respawned, [], 'a pruned human no longer increases pressure');
    assert.deepStrictEqual((await sweepAdaptive(expired.r, 60000, [expired.live[0]], 5000)).respawned, [1]);
  });
  await step(label + ': adaptive IT re-evaluates demand without restarting age and claims each respawn once', async () => {
    const { r } = await adaptiveRoom('ramp', 1, 1);
    assert.deepStrictEqual((await sweepAdaptive(r, 25000)).respawned, []);
    const peer = label === 'redis' ? makeStore() : store;
    try {
      for (let i = 1; i < 20; i++) await peer.join(r, { ...base, now: NOW + 25000, ttlMs: 1000000, max: 30, token: T(3000+i), name: 'New'+i, connId: 'remote-'+i });
      const attempts = await Promise.all([sweepAdaptive(r, 25000), peer.housekeep(r, { now: NOW+25000, ttlMs:1000000, respawnMs:0, sweep:true, entries:[] })]);
      assert.deepStrictEqual(attempts.flatMap(a=>a.respawned), [1]);
    } finally { if (peer !== store) await peer.close(); }
  });

  await step(label + ': reset cooldown and per-IP leases', async () => {
    const r4 = room + '-rs';
    assert.strictEqual((await store.reset(r4, { now: NOW, cooldownMs: 1000 })).ok, true);
    const second = await store.reset(r4, { now: NOW + 400, cooldownMs: 1000 });
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.waitMs, 600);
    assert.strictEqual((await store.reset(r4, { now: NOW + 1000, cooldownMs: 1000 })).ok, true);

    const ip = '10.0.0.' + (Date.now() % 250);
    const o = { max: 2, ttlMs: 1000, now: NOW };
    assert.strictEqual(await store.acquireConn(ip, 'a', o), true);
    assert.strictEqual(await store.acquireConn(ip, 'b', o), true);
    assert.strictEqual(await store.acquireConn(ip, 'c', o), false);
    await store.releaseConn(ip, 'a');
    assert.strictEqual(await store.acquireConn(ip, 'c', o), true);
    // a crashed instance never releases: leases expire on their own
    assert.strictEqual(await store.acquireConn(ip, 'd', { ...o, now: NOW + 2000 }), true);
  });

  await step(label + ': refreshing leases in one batch keeps them alive past their first expiry', async () => {
    const ip = '10.9.9.' + (Date.now() % 250);
    const o = { max: 1, ttlMs: 1000, now: NOW };
    assert.strictEqual(await store.acquireConn(ip, 'only', o), true);
    await store.touchConns([{ ip, connId: 'only' }], { ttlMs: 1000, now: NOW + 800 });
    // without the refresh the first lease would be gone by now and this would succeed
    assert.strictEqual(await store.acquireConn(ip, 'second', { ...o, now: NOW + 1500 }), false);
    assert.strictEqual(await store.acquireConn(ip, 'second', { ...o, now: NOW + 2000 }), true);
  });

  await step(label + ': housekeeping reports players that live on other instances', async () => {
    const r5 = room + '-inst';
    const j1 = await store.join(r5, { ...base, token: T(21), connId: 'instA-1', now: NOW, name: 'P2' });
    await store.join(r5, { ...base, token: T(22), connId: 'instB-1', now: NOW, name: 'P3' });
    const hk = (instanceId) =>
      store.housekeep(r5, { now: NOW + 100, ttlMs: 5000, respawnMs: 1000, sweep: false, entries: [], instanceId });
    if (label === 'redis') {
      assert.strictEqual((await hk('instA')).others, 1, 'A sees the player on B');
      assert.strictEqual((await hk('instB')).others, 1, 'B sees the player on A');
      await store.leave(r5, j1.id, 'instA-1', null, NOW);
      assert.strictEqual((await hk('instB')).others, 0, 'once A is gone, B is alone');
    } else {
      assert.strictEqual((await hk('instA')).others, 0, 'a memory store is a single process');
    }
  });

  await step(label + ': one-command snapshot returns players, objects and totals', async () => {
    const r6 = room + '-snap';
    const a = await store.join(r6, { ...base, token: T(31), connId: 's1', name: 'Snap', now: NOW });
    await store.hit(r6, { objId: 3, defaultHp: 1, cost: 8, playerId: a.id, now: NOW });
    await store.hit(r6, { objId: 4, defaultHp: 3, cost: 25, playerId: a.id, now: NOW });
    const snap = await store.read(r6, { now: NOW, ttlMs: 5000 });
    assert.strictEqual(snap.total, 8);
    assert.deepStrictEqual(snap.players.map((p) => [p.id, p.name, p.score, p.breaks]), [[a.id, 'Snap', 8, 1]]);
    assert.strictEqual(snap.objects[3].hp, 0);
    assert.ok(snap.objects[3].brokenAt > 0);
    assert.deepStrictEqual(snap.objects[4], { hp: 2, brokenAt: 0 });
  });

  await step(label + ': online counts for the room list come from one call', async () => {
    const rA = room + '-cnt-a';
    const rB = room + '-cnt-b';
    const a = await store.join(rA, { ...base, token: T(41), connId: 'o1', now: NOW, name: 'O1' });
    await store.join(rA, { ...base, token: T(42), connId: 'o2', now: NOW, name: 'O2' });
    await store.join(rB, { ...base, token: T(43), connId: 'o3', now: NOW, name: 'P4' });
    const o = { now: NOW + 100, ttlMs: 5000 };
    assert.deepStrictEqual(await store.online([rA, rB, room + '-none'], o), [2, 1, 0]);
    await store.leave(rA, a.id, 'o1', null, NOW);
    assert.deepStrictEqual(await store.online([rA, rB], o), [1, 1]);
    // players whose heartbeat stopped do not count
    assert.deepStrictEqual(await store.online([rA, rB], { now: NOW + 9000, ttlMs: 5000 }), [0, 0]);
  });

  await step(label + ': duel state uses the boss lease and CAS, and pull positions survive reconnect', async () => {
    const r = room + '-duel', now = Date.now();
    const player = await store.join(r, { ...base, now, name: 'Duelist', token: T(91), connId: 'duel-c1' });
    assert.strictEqual((await store.duelGet(r, { now })).version, 0);
    assert.strictEqual(await store.bossLock(r, 'runner', { now, ttlMs: 3000 }), true);
    const state = { version: 1, nextAt: now + 50000, target: player.id, startedAt: now, until: now + 15000, moves: [{ id: player.id, x: 3100, y: 1700, fromX: 2750, fromY: 1700, kind: 'pull' }] };
    assert.strictEqual(await store.duelSave(r, { owner: 'stale', now, expected: 0, state }), false);
    const races = await Promise.all([0, 1].map(() => store.duelSave(r, { owner: 'runner', now, expected: 0, state })));
    assert.strictEqual(races.filter(Boolean).length, 1, 'only one runner commits this cast');
    assert.deepStrictEqual(await store.duelGet(r, { now }), state);
    const again = await store.join(r, { ...base, now, name: 'Duelist', token: T(91), connId: 'duel-c2' });
    assert.deepStrictEqual(again.pos, { x: 3100, y: 1700, d: 1 });
    assert.strictEqual((await store.duelGet(r, { now })).until, state.until, 'reconnect retains the timer');
    assert.strictEqual(await store.duelSave(r, { owner: 'runner', now, expected: 0, state }), false, 'old version cannot replay the pull');
    const cfg = { maxHp: 10, baseRegenPerSec: 0, regenPerSec: 0, regenDelayMs: 0 };
    await store.bossHit(r, { playerId: player.id, dmg: 10, now, cfg, respawnAt: now + 1000, bounty: 1 });
    assert.strictEqual(await store.duelSave(r, { owner: 'runner', now, expected: 1, state: { ...state, version: 2 } }), false, 'dead boss cannot start or extend a duel');
    assert.strictEqual(await store.duelSave(r, { owner: 'runner', now, expected: 1, state: { ...state, version: 2, target: 0, until: 0, moves: [] } }), true);
  });

  await step(label + ': pub/sub delivers to subscribers', async () => {
    const got = [];
    await store.subscribe(room + '-ps', (m) => got.push(m));
    await sleep(50);
    await store.publish(room + '-ps', 'hello');
    await sleep(100);
    assert.deepStrictEqual(got, ['hello']);
    await store.unsubscribe(room + '-ps');
    await store.publish(room + '-ps', 'ignored');
    await sleep(100);
    assert.deepStrictEqual(got, ['hello']);
  });

  await store.close();
}

// --------------------------------------------------------- a new deploy ----
// An instance of a newer build announces itself on a shared channel. Players of the older instance get an 'update' notice,
// are disconnected with code 4003 after the grace, and anyone who joins the older instance afterwards is told it is outdated.
async function newDeploy(url) {
  const quiet = () => {};
  // Spawn protection is off: the boss steps join straight into the server room (boss-net covers the shield).
  const mk = (build, extra = {}) => server.createApp({ store: createRedisStore(url, { log: quiet }), log: quiet, build, spawnProtectionMs: 0, ...extra });
  const old = mk({ version: 'old1', builtAt: 1000 }, { updateGraceMs: 500 });
  const po = await old.start(0);
  const room = 'deploy-' + Date.now();
  await sleep(300); // let the older instance subscribe to the build channel

  await step('redis: a newer deploy makes the older one tell its players to reload and then disconnect them', async () => {
    const A = await h.client(po, 'An', room);
    assert.strictEqual(A.welcome.build, 'old1');
    assert.strictEqual(A.welcome.newer, undefined);
    const closed = new Promise((resolve, reject) => {
      A.ws.on('close', (code) => resolve(code));
      setTimeout(() => reject(new Error('not disconnected')), 5000);
    });
    const fresh = mk({ version: 'new2', builtAt: 2000 });
    await fresh.start(0);
    const upd = await take(A, (m) => m.t === 'update', 4000);
    assert.strictEqual(upd.v, 'new2');
    assert.strictEqual(await closed, 4003);
    // someone who still lands on the older instance is told straight away
    const B = await h.client(po, 'Binh', room);
    assert.strictEqual(B.welcome.build, 'old1');
    assert.strictEqual(B.welcome.newer, 'new2');
    B.ws.close();
    await fresh.stop();
  });

  await step('redis: an older or the same build does not trigger the notice', async () => {
    const A = await h.client(po, 'Chi', room + '-b');
    const same = mk({ version: 'other', builtAt: 500 }); // older than the running one
    await same.start(0);
    await none(A, (m) => m.t === 'update');
    A.ws.close();
    await same.stop();
  });

  await old.stop();
}

// ------------------------------------------------------- two instances ----
async function twoInstances(url) {
  const quiet = () => {};
  const mk = () =>
    server.createApp({
      store: createRedisStore(url, { log: quiet }), presenceTtlMs: 2500, log: quiet,
      // This suite checks shared wreck snapshots; replacement timing is
      // covered by the contract and smoke suites, not cold-start latency.
      respawnMs: 60000,
      bossMaxHp: 60, bossRespawnMs: 1500, playerRespawnMs: 1500, // a tiny boss for the boss step below
      spawnProtectionMs: 0, // the boss step joins straight into the server room
    });
  const app1 = mk();
  const app2 = mk();
  // Spawn near the printers and chairs so walk-and-hit steps are short.
  world.WORLD.spawn = { x: 60, y: 400, rx: 0, ry: 0 }; // the aisle west of the first west-workspace island
  const p1 = await app1.start(0);
  const p2 = await app2.start(0);
  const room = 'shared-' + Date.now();
  const mon = new Redis(url);
  const publishCalls = async () => {
    const t = await mon.info('commandstats');
    return Number((t.match(/cmdstat_publish:calls=(\d+)/) || [])[1] || 0);
  };
  const closeAll = (...cs) => cs.forEach((c) => c.ws.readyState < 2 && c.ws.close());

  await step('redis: population HP grows across two live servers and reconnect welcomes preserve the shared maximum', async () => {
    const group=[], r=room+'-population-live';
    try {
      for(let i=0;i<5;i++) group.push(await h.client(i%2?p2:p1,'Population '+i,r));
      const grown=await take(group[0],m=>m.t==='bhp' && m.maxHp===90,22000);
      assert.equal(grown.hp,90); assert.ok(grown.rev>0);
      const peer=await take(group[1],m=>m.t==='bhp' && m.rev===grown.rev,3000);
      assert.deepEqual([peer.hp,peer.maxHp],[90,90]);
      group[4].ws.close();await sleep(100);
      const again=await h.client(p2,'Returning population',r);group.push(again);
      assert.deepEqual([again.welcome.boss.hp,again.welcome.boss.maxHp],[90,90]);
      assert.ok(!('humans' in again.welcome.boss) && !('population' in again.welcome.boss));
    } finally {closeAll(...group);await sleep(100);}
  });

  await step('redis: two servers show the same office to players on different instances', async () => {
    const A = await h.client(p1, 'An', room);
    const B = await h.client(p2, 'Binh', room);
    assert.notStrictEqual(app1.instanceId, app2.instanceId);
    assert.strictEqual(B.welcome.players.length, 2);
    const pj = await take(A, (m) => m.t === 'pj' && m.p.id === B.id);
    assert.strictEqual(pj.p.name, 'Binh');
    assert.ok(B.id !== A.id);
    const board = await take(A, (m) => m.t === 'board' && m.online === 2);
    assert.strictEqual(board.online, 2);

    send(A, { t: 'phit', id: B.id, skill: 'electric' });
    await take(B, m => m.t === 'phit' && m.id === B.id && m.by === A.id && m.skill === 'electric');
    assert.ok(!B.msgs.some(m => m.t === 'hp' || m.t === 'down'));
    await sleep(220);

    // A hits on instance 1, B (instance 2) sees it, and breaking it updates everyone's board
    const target = A.welcome.objects
      .filter((o) => o.type === 'chair')
      .reduce((best, o) => (h.dist(A, o) < h.dist(A, best) ? o : best));
    await h.walkTo(A, target, 50);
    for (let i = 0; i < server.TYPES.chair.hp; i++) {
      send(A, { t: 'hit', id: target.id });
      await sleep(230);
    }
    const hit = await take(B, (m) => m.t === 'hit' && m.id === target.id);
    assert.strictEqual(hit.by, A.id);
    const brk = await take(B, (m) => m.t === 'break' && m.id === target.id);
    assert.strictEqual(brk.cost, server.TYPES.chair.cost);
    const b2 = await take(B, (m) => m.t === 'board' && m.total === server.TYPES.chair.cost);
    assert.strictEqual(b2.board[0].name, 'An');

    // a late joiner on the other instance sees the wreck and the score, not a fresh office
    const C = await h.client(p2, 'Chi', room);
    assert.ok(C.welcome.objects.find((o) => o.id === target.id).broken);
    assert.strictEqual(C.welcome.players.find((p) => p.id === A.id).score, server.TYPES.chair.cost);
    closeAll(A, B, C);
    await sleep(300);
  });

  await step('redis: mini-bosses share HP, retaliation, bounty and respawn across two servers', async () => {
    const M = require('../lib/miniboss'), r = room.slice(0, 16) + '-minis', now = Date.now();
    const first = M.initialState(); first.version = 1;
    Object.assign(first.list[0], { x: world.WORLD.spawn.x, y: world.WORLD.spawn.y, hp: 20, pauseUntil: now + 10000 });
    await app1.store.miniSave(r, { now, expected: 0, state: first });
    const A = await h.client(p1, 'MiniA', r), B = await h.client(p2, 'MiniB', r);
    try {
      assert.strictEqual(B.welcome.minis.list.find(b => b.id === 'TML').hp, 20);
      send(A, { t: 'miniHit', id: 'TML' }); send(B, { t: 'miniHit', id: 'TML' });
      const dead = await take(B, m => m.t === 'miniHit' && m.hp === 0, 2500);
      assert.strictEqual(dead.shares.length, 2);
      assert.ok(Math.abs(dead.shares.reduce((n, s) => n + s.bounty, 0) - 40) < 0.001);
      await take(A, m => m.t === 'board' && Math.abs(m.total - 40) < 0.001, 1500);
      for (let tries = 0; tries < 20; tries++) {
        const state = await app1.store.miniGet(r, { now: Date.now() });
        state.list[0].respawnAt = Date.now() + 400;
        const expected = state.version; state.version++;
        if (await app1.store.miniSave(r, { now: Date.now(), expected, state })) break;
      }
      const up = await take(A, m => m.t === 'miniState' && m.state.list.some(b => b.id === 'TML' && b.hp === 900), 2500);
      assert.ok(up.state.list.find(b => b.id === 'TML').respawnMs === 0);
      const read = await app2.store.miniGet(r, { now: Date.now() });
      assert.strictEqual(read.list[0].hp, 900);
      assert.deepStrictEqual(read.list[0].ledger, {});
    } finally { closeAll(A, B); await sleep(300); }
  });

  await step('redis: a room served by one instance sends no position traffic through Redis', async () => {
    const r = room + '-solo';
    const A = await h.client(p1, 'An', r);
    const B = await h.client(p1, 'Binh', r);
    await sleep(2600); // housekeeping learns that nobody else is in the room
    const before = await publishCalls();
    for (let i = 0; i < 40; i++) {
      send(A, { t: 'move', x: A.x + (i % 2 ? 3 : -3), y: A.y, d: 1 });
      await sleep(50); // 2 seconds of walking, 20 moves a second
    }
    await sleep(300);
    const used = (await publishCalls()) - before;
    assert.ok(used <= 3, 'expected ~0 PUBLISH while moving in a single-instance room, saw ' + used);
    // ... yet the other player still sees every step
    const ps = B.msgs.filter((m) => m.t === 'ps' && m.l.some((e) => e[0] === A.id));
    assert.ok(ps.length >= 10, 'B received position batches for A: ' + ps.length);
    closeAll(A, B);
    await sleep(300);
  });

  await step('redis: positions still cross instances when a room is split across them', async () => {
    const r = room + '-split';
    const A = await h.client(p1, 'An', r);
    const B = await h.client(p2, 'Binh', r);
    await sleep(2600);
    for (let i = 0; i < 20; i++) {
      send(A, { t: 'move', x: A.x + (i % 2 ? 3 : -3), y: A.y, d: 1 });
      await sleep(50);
    }
    await sleep(300);
    const ps = B.msgs.filter((m) => m.t === 'ps' && m.l.some((e) => e[0] === A.id));
    assert.ok(ps.length >= 5, 'B (other instance) saw A move: ' + ps.length);
    closeAll(A, B);
    await sleep(300);
  });

  await step('redis: players hitting one object from two instances break it exactly once', async () => {
    const r = room + '-race';
    const A = await h.client(p1, 'An', r);
    const B = await h.client(p2, 'Binh', r);
    const plant = A.welcome.objects
      .filter((o) => o.type === 'plant')
      .reduce((best, o) => (h.dist(A, o) < h.dist(A, best) ? o : best));
    await Promise.all([h.walkTo(A, plant, 50), h.walkTo(B, plant, 50)]);
    for (let i = 0; i < 3; i++) {
      send(A, { t: 'hit', id: plant.id });
      send(B, { t: 'hit', id: plant.id });
      await sleep(230);
    }
    await sleep(300);
    for (const c of [A, B]) {
      assert.strictEqual(c.msgs.filter((m) => m.t === 'break' && m.id === plant.id).length, 1);
      assert.strictEqual(c.msgs.filter((m) => m.t === 'hit' && m.id === plant.id).length, server.TYPES.plant.hp);
    }
    const last = A.msgs.filter((m) => m.t === 'board').pop();
    assert.strictEqual(last.total, server.TYPES.plant.cost, 'cost counted once, not once per instance');
    closeAll(A, B);
    await sleep(300);
  });

  await step('redis: IT reset and emotes cross instances; the cooldown is shared', async () => {
    const r = room + '-reset';
    const A = await h.client(p1, 'An', r);
    const B = await h.client(p2, 'Binh', r);
    send(B, { t: 'emote', e: 4 });
    await take(A, (m) => m.t === 'emote' && m.id === B.id && m.e === 4);
    send(A, { t: 'reset' });
    assert.strictEqual((await take(B, (m) => m.t === 'reset')).by, 'An');
    send(B, { t: 'reset' });
    assert.ok((await take(B, (m) => m.t === 'err')).m.includes('IT'));
    closeAll(A, B);
    await sleep(300);
  });

  await step('redis: reconnecting to the other instance keeps id, score and place', async () => {
    const r = room + '-hop';
    const O = await h.client(p2, 'Obs', r);
    const X = await h.client(p1, 'Xuan', r);
    await h.smashPlant(X, server.TYPES);
    await take(O, (m) => m.t === 'board' && m.total === server.TYPES.plant.cost);
    await sleep(1200); // let the position be persisted
    X.ws.terminate();
    await take(O, (m) => m.t === 'pl' && m.id === X.id, 3000);
    const X2 = await h.client(p2, 'Xuan', r, X.token); // lands on the other instance
    assert.strictEqual(X2.id, X.id);
    const me = X2.welcome.players.find((p) => p.id === X2.id);
    assert.strictEqual(me.score, server.TYPES.plant.cost);
    assert.ok(Math.hypot(me.x - X.x, me.y - X.y) < 80);
    closeAll(O, X2);
    await sleep(300);
  });

  await step('redis: the per-IP limit counts connections across instances', async () => {
    const socks = [];
    const open = (port) =>
      new Promise((resolve) => {
        const ws = new WebSocket('ws://127.0.0.1:' + port + '/api/ws');
        socks.push(ws);
        ws.on('open', () => resolve(ws));
      });
    for (let i = 0; i < 5; i++) {
      await open(p1);
      await open(p2);
    }
    const extra = new WebSocket('ws://127.0.0.1:' + p2 + '/api/ws');
    const code = await new Promise((resolve) => extra.on('close', (c) => resolve(c)));
    assert.strictEqual(code, 1013);
    socks.forEach((s) => s.close());
    await sleep(500);
  });

  await step('redis: one boss per room across two instances: a punch hurts players on both, both can hit it, one bounty', async () => {
    const r = room + '-boss';
    world.WORLD.spawn = { ...world.serverPoint(420,380), rx: 0, ry: 0 };
    const A = await h.client(p1, 'An', r);
    const B = await h.client(p2, 'Binh', r);
    const winds = [];
    for (const c of [A, B]) c.ws.on('message', (d) => { if (JSON.parse(d.toString()).t === 'bwind') winds.push(Date.now()); });
    // the same strike hurts each player on their own instance, and each sees the other's health change
    await take(A, (m) => m.t === 'bstrike', 8000);
    await take(A, (m) => (m.t === 'hp' || m.t === 'down') && m.id === A.id, 3000);
    await take(A, (m) => (m.t === 'hp' || m.t === 'down') && m.id === B.id, 3000);
    await take(B, (m) => (m.t === 'hp' || m.t === 'down') && m.id === B.id, 3000);
    // only one instance runs the boss: windups are never closer together than a windup plus a recovery
    await sleep(3500);
    assert.ok(winds.length >= 2, 'it kept fighting: ' + winds.length);
    const sorted = winds.slice().sort((x, y) => x - y);
    for (let i = 1; i < sorted.length; i++) {
      // each client hears each windup once; the same one twice (A and B) is less than 200 ms apart
      if (sorted[i] - sorted[i - 1] > 200) assert.ok(sorted[i] - sorted[i - 1] >= 1000, 'two runners? windups ' + (sorted[i] - sorted[i - 1]) + 'ms apart');
    }
    // players from both instances hit it; it falls exactly once and the bounty is shared
    let dead = null;
    for (let i = 0; i < 50 && !dead; i++) {
      send(A, { t: 'bhit' });
      send(B, { t: 'bhit' });
      await sleep(200);
      dead = A.msgs.find((m) => m.t === 'bdead') || null;
    }
    dead = dead || (await take(A, (m) => m.t === 'bdead', 3000));
    await sleep(500);
    for (const c of [A, B]) assert.strictEqual(c.msgs.filter((m) => m.t === 'bdead').length, 1, 'one kill, heard once by ' + c.name);
    assert.ok(Math.abs(dead.shares.reduce((n, s) => n + s.bounty, 0) - 500) < 0.2);
    const last = A.msgs.filter((m) => m.t === 'board').pop();
    assert.strictEqual(last.total, 500, 'the bounty is paid once, not once per instance');
    await take(B, (m) => m.t === 'bup', 6000);
    closeAll(A, B);
    await sleep(300);
  });

  await step('redis: if an instance dies without cleaning up, the others drop its players', async () => {
    const r = room + '-crash';
    const A = await h.client(p1, 'An', r);
    const B = await h.client(p2, 'Binh', r);
    await take(A, (m) => m.t === 'pj' && m.p.id === B.id);
    // cut instance 1 off from Redis first, so its close handlers cannot say goodbye
    await app1.store.close();
    A.ws.terminate();
    const pl = await take(B, (m) => m.t === 'pl' && m.id === A.id, 8000);
    assert.strictEqual(pl.id, A.id);
    const board = await take(B, (m) => m.t === 'board' && m.online === 1, 3000);
    assert.strictEqual(board.online, 1);
    closeAll(B);
  });

  await app1.stop().catch(() => {});
  await app2.stop();
  mon.disconnect();
}

async function main() {
  await contract('memory', () => createMemoryStore());

  const redis = await startRedis();
  if (!redis) {
    console.log('SKIP - no redis-server found and TEST_REDIS_URL not set; Redis tests not run');
    console.log('\nAll ' + passed + ' checks passed (Redis part skipped)');
    process.exit(0);
  }
  try {
    await contract('redis', () => createRedisStore(redis.url, { log: () => {} }));
    await step('npm run check:store passes against a real Redis and never prints the URL', async () => {
      const out = spawnSync('node', ['scripts/check-store.js'], {
        cwd: require('path').join(__dirname, '..'),
        env: { ...process.env, REDIS_URL: redis.url },
        encoding: 'utf8',
        timeout: 60000,
      });
      assert.strictEqual(out.status, 0, out.stdout + out.stderr);
      assert.ok(/All 7 checks passed/.test(out.stdout), out.stdout);
      assert.ok(!out.stdout.includes(redis.url) && !out.stdout.includes('127.0.0.1:' + redis.url.split(':').pop()), 'URL leaked into the output');
      const bad = spawnSync('node', ['scripts/check-store.js'], {
        cwd: require('path').join(__dirname, '..'),
        env: { ...process.env, REDIS_URL: 'redis://127.0.0.1:1' },
        encoding: 'utf8',
        timeout: 60000,
      });
      assert.strictEqual(bad.status, 1, 'an unreachable store fails the check');
    });

    await step('/api/health: shallow, deep with ping, key protected, kill switch', async () => {
      const health = require('../api/health.js');
      const call = async (env, url) => {
        const saved = { ...process.env };
        Object.assign(process.env, env);
        try {
          let code;
          let body = '';
          await health({ url }, {
            setHeader() {},
            end(b) {
              body = b;
            },
            set statusCode(c) {
              code = c;
            },
          });
          return { code, body: JSON.parse(body) };
        } finally {
          for (const k of Object.keys(env)) delete process.env[k];
          Object.assign(process.env, saved);
        }
      };
      assert.deepStrictEqual((await call({ REDIS_URL: redis.url }, '/api/health')).body, { ok: true, store: 'redis' });
      const deep = await call({ REDIS_URL: redis.url }, '/api/health?deep=1');
      assert.strictEqual(deep.code, 200);
      assert.ok(deep.body.pingMs >= 0);
      assert.strictEqual((await call({ REDIS_URL: redis.url, HEALTH_KEY: 'sekret' }, '/api/health?deep=nope')).code, 401);
      assert.strictEqual((await call({ REDIS_URL: redis.url, HEALTH_KEY: 'sekret' }, '/api/health?deep=sekret')).code, 200);
      assert.strictEqual((await call({ REDIS_URL: 'redis://127.0.0.1:1' }, '/api/health?deep=1')).code, 503);
      assert.strictEqual((await call({ REDIS_URL: redis.url, GAME_DISABLED: '1' }, '/api/health')).code, 503);
      const k = new Redis(redis.url);
      assert.ok((await k.ttl('br:keepalive')) > 0, 'the keepalive key has an expiry');
      k.disconnect();
    });

    await twoInstances(redis.url);
    await newDeploy(redis.url);
  } finally {
    await redis.stop();
  }
  console.log('\nAll ' + passed + ' checks passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
