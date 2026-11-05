'use strict';
const assert = require('assert');
const { SNAKE, stepSnakes, snakeWaveCount } = require('../lib/snakes');
const { BOSS_HOME, inBossZone, layoutPoint } = require('../lib/world');
const { createMemoryStore } = require('../lib/store-memory');
(async () => {
  assert.strictEqual(snakeWaveCount(0, 70, () => 0), 1);
  for (const online of [1, 2, 3, 5, 10, 20]) {
    assert.strictEqual(snakeWaveCount(online, 70, () => 0), Math.ceil(online * 1.3));
    assert.strictEqual(snakeWaveCount(online, 70, () => 0.999999), online * 2);
    for (let i = 0; i < 100; i++) {
      const count = snakeWaveCount(online, 70, () => i / 100);
      assert.ok(Number.isInteger(count) && count >= online * 1.3 && count <= online * 2);
    }
  }
  for (const online of [1, 2, 3, 5, 10, 20]) {
    assert.strictEqual(snakeWaveCount(online, 10, () => 0), online * 2);
    assert.strictEqual(snakeWaveCount(online, 10, () => 0.999999), online * 3);
    for (let i = 0; i < 100; i++) {
      const count = snakeWaveCount(online, 10, () => i / 100);
      assert.ok(Number.isInteger(count) && count >= online * 2 && count <= online * 3);
    }
  }
  const snake = { id: 1, x: BOSS_HOME.x, y: BOSS_HOME.y, hp: 4 };
  const target = { id: 1, ...layoutPoint(2600, 1800) };
  for (let t = 0; t < 450; t++) stepSnakes([snake], 0.1, [target], t * 100);
  assert.ok(!inBossZone(snake.x, snake.y), 'snake exits the server room through its door');
  assert.ok(Math.hypot(snake.x - target.x, snake.y - target.y) < 60, 'snake reaches a player outside the boss room');
  target.x += 30; // the snake now stands on the player; step aside so `close` is unambiguously nearer
  const close = { id: 2, x: snake.x, y: snake.y };
  const bites = stepSnakes([snake], 0.01, [target, close], 50000);
  assert.strictEqual(bites[0].target, 2);
  assert.strictEqual(bites[0].dmg, 5);
  assert.deepStrictEqual(stepSnakes([snake], 0.01, [close], 50010), []);
  const redSnake = { ...snake, id: 3, variant: 'red', biteAt: 0 };
  assert.strictEqual(stepSnakes([redSnake], 0.01, [close], 50000)[0].dmg, 7);
  assert.deepStrictEqual(stepSnakes([redSnake], 0.01, [close], 50010), []);
  assert.strictEqual(SNAKE.hp, 4);
  const store = createMemoryStore();
  const cfg = { maxHp: 100, baseRegenPerSec: 0, regenPerSec: 0, regenDelayMs: 0 };
  const hit = dmg => store.bossHit('snakes', { playerId: 1, dmg, now: 1000, cfg, respawnAt: 2000, bounty: 500 });
  const count = snakeWaveCount(3, 70, () => 0);
  const summon = () => store.summonSnakes('snakes', { maxHp: 100, count, finalCount: snakeWaveCount(3, 10, () => 0), x: 3300, y: 1700, now: 1000 });
  await hit(30); let wave = await summon();
  assert.deepStrictEqual(wave.waves, [70]); assert.strictEqual(wave.snakes.length, 4); assert.ok(wave.snakes.every(s => s.variant === 'green'));
  assert.strictEqual((await summon()).snakes.length, 0);
  await hit(30); wave = await summon(); assert.deepStrictEqual(wave.waves, [40]); assert.strictEqual(wave.snakes.length, 4); assert.ok(wave.snakes.every(s => s.variant === 'green'));
  await hit(30); wave = await summon(); assert.deepStrictEqual(wave.waves, [10]); assert.strictEqual(wave.snakes.length, 6); assert.ok(wave.snakes.every(s => s.variant === 'red'));
  assert.strictEqual((await store.snakeList('snakes', { now: 1000 })).length, 14);
  for (let i = 0; i < 4; i++) assert.strictEqual((await store.snakeHit('snakes', 1, 1000)).hp, 3 - i);
  assert.strictEqual(await store.snakeHit('snakes', 1, 1000), null);
  await store.snakeMove('snakes', [{ id: 1, x: 20, y: 20, d: 0 }], 1000);
  assert.ok(!(await store.snakeList('snakes', { now: 1000 })).some(s => s.id === 1), 'late position saves cannot revive a dead snake');
  await hit(10); await store.bossRespawn('snakes', { now: 2000, maxHp: 100 });
  assert.strictEqual((await store.snakeList('snakes', { now: 2000 })).length, 0);
  // A large hit can cross all three thresholds before the store claims any wave.
  await store.bossHit('burst', { playerId: 1, dmg: 90, now: 1000, cfg, respawnAt: 2000, bounty: 500 });
  const burst = await store.summonSnakes('burst', { maxHp: 100, count: 4, finalCount: 6, x: 3300, y: 1700, now: 1000 });
  assert.deepStrictEqual(burst.waves, [70, 40, 10]);
  assert.strictEqual(burst.snakes.filter(s => s.variant === 'red').length, 6);
  assert.strictEqual(burst.snakes.length, 14, 'only the final wave gets the larger count');
  const offer = opts => store.drinkOffer('drinks', { intervalMs: 300000, windowMs: 5000, ...opts });
  const first = await offer({ now: 1000 }); assert.strictEqual(first.id, 301000); assert.ok(!first.available);
  assert.ok((await offer({ now: 301000 })).available);
  const claims = await Promise.all(Array.from({ length: 10 }, () => offer({ now: 301100, claim: true, offerId: first.id })));
  assert.strictEqual(claims.filter(r => r.claimed).length, 1);
  assert.ok(!(await offer({ now: 306000, claim: true, offerId: first.id })).claimed);
  const next = await offer({ now: 601000 }); assert.ok(next.available); assert.strictEqual(next.id, 601000);
  assert.ok(!(await offer({ now: 601001, claim: true, offerId: first.id })).claimed);
  await store.close();
  console.log('All snake navigation/combat, 70/40/10 waves, four-hit death, cleanup, and drink schedule/atomic claim checks passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
