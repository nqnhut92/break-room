'use strict';
const assert = require('assert');
const { BOSS_ROOM, PLAYER_RADIUS, resolveCollisions } = require('../lib/world');
const { DUEL, emptyDuel, nextDuel, nearRoom, activeDuel, duelPosition, insideRoom } = require('../lib/duel');
const { createMemoryStore } = require('../lib/store-memory');
const near = { id: 1, x: 2750, y: 1700 }, inside = { id: 2, x: 3300, y: 1700 }, far = { id: 3, x: 1900, y: 1950 };
const dead = { id: 4, x: 3200, y: 1700, dead: true };
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok - ' + name); }
check('random schedule is 40–60 seconds; dead and faraway players cannot be selected', () => {
  assert.equal(nextDuel(null, 1000, [], true, () => 0).nextAt, 41000);
  assert.equal(nextDuel(null, 1000, [], true, () => 1).nextAt, 61000);
  assert.ok(nearRoom(near)); assert.ok(nearRoom(inside)); assert.ok(!nearRoom(far)); assert.ok(!nearRoom(dead));
  assert.ok(!nearRoom({ x: BOSS_ROOM.x0 - 300, y: BOSS_ROOM.y0 - 300 }));
});
const scheduled = nextDuel(null, 1000, [], true, () => 0);
const duel = nextDuel(scheduled, scheduled.nextAt, [near, inside, far, dead], true, () => 0);
check('capture one nearby player, blow other live occupants out, leave distant and dead players alone', () => {
  assert.equal(duel.target, near.id); assert.equal(duel.until - duel.startedAt, 15000);
  assert.equal(duel.nextAt - duel.startedAt, 40000);
  assert.deepEqual(duel.moves.map(m => [m.id, m.kind]), [[1, 'pull'], [2, 'blow']]);
  assert.ok(insideRoom(duel.moves[0].x, duel.moves[0].y)); assert.ok(!insideRoom(duel.moves[1].x, duel.moves[1].y));
  for (const m of duel.moves) assert.deepEqual(resolveCollisions(m.x, m.y), {x:m.x, y:m.y});
  assert.equal(scheduled.target, 0, 'scheduling does not mutate previous state');
});
check('selection is random across eligible users, no capture when nobody is nearby or boss is dead', () => {
  assert.equal(nextDuel(scheduled, 41000, [near, inside, far], true, () => 0.99).target, 2);
  assert.equal(nextDuel(scheduled, 41000, [far, dead], true, () => 0).target, 0);
  assert.equal(nextDuel(scheduled, 41000, [near], false, () => 0), null);
  assert.equal(nextDuel(scheduled, 40999, [near], true, () => 0), null);
});
check('doorway blocks escape and entry throughout 15s, free movement immediately after expiry', () => {
  const exit = {x: BOSS_ROOM.x0 - 100, y:1700};
  const captive = duelPosition(duel, 1, exit.x, exit.y, duel.until - 1);
  assert.ok(captive.x >= BOSS_ROOM.x0 + PLAYER_RADIUS); assert.ok(insideRoom(captive.x, captive.y));
  const outsider = duelPosition(duel, 2, 3100, 1700, duel.until - 1);
  assert.ok(!insideRoom(outsider.x, outsider.y, PLAYER_RADIUS));
  assert.deepEqual(duelPosition(duel, 1, exit.x, exit.y, duel.until), exit);
  assert.deepEqual(duelPosition(duel, 2, 3100, 1700, duel.until), {x:3100,y:1700});
});
check('no overlapping duel; disconnect/reconnect retains lock, death or timeout clears it', () => {
  assert.equal(nextDuel(duel, 42000, [near,inside], true), null);
  assert.equal(nextDuel(duel, 42000, [], true), null, 'disconnect cannot evade the timer');
  for (const ended of [nextDuel(duel, duel.until, [near], true), nextDuel(duel, 42000, [{...near,dead:true}], true), nextDuel(duel,42000,[near],false)]) {
    assert.equal(ended.target,0); assert.deepEqual(ended.moves,[]); assert.ok(!activeDuel(ended,42000));
  }
});
(async () => {
  const store = createMemoryStore(), room = 'duel', now = 41000;
  assert.deepEqual(await store.duelGet(room, {now}), emptyDuel());
  await store.bossLock(room, 'a', {now,ttlMs:3000});
  const state = {...duel, version:1};
  assert.equal(await store.duelSave(room, {owner:'b',now,expected:0,state}),false);
  const results = await Promise.all([store.duelSave(room,{owner:'a',now,expected:0,state}),store.duelSave(room,{owner:'a',now,expected:0,state})]);
  assert.equal(results.filter(Boolean).length,1);
  const saved = await store.duelGet(room,{now}); assert.deepEqual(saved,state);
  saved.target=99; assert.equal((await store.duelGet(room,{now})).target,1);
  await store.bossLock(room,'b',{now:45000,ttlMs:3000});
  assert.equal(await store.duelSave(room,{owner:'a',now:45000,expected:1,state:{...state,version:2}}),false);
  assert.equal((await store.duelGet(room,{now:45000})).until,duel.until);
  await store.close();
  console.log('ok - store fences concurrent/stale leaders and retains countdown across handover');
  console.log('All ' + (passed+1) + ' duel checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
