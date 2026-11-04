'use strict';

// The boss's rules, without any network: health maths, the walking loop, chasing and punching, and a small
// balance simulation that checks the promise behind the numbers (about five players beat it, one cannot).

const assert = require('assert');
const W = require('../lib/world.js');
const B = require('../lib/boss.js');
const { MANA, manaAt, HIT_COOLDOWN_MS } = require('../lib/realtime.js');

let passed = 0;
function step(name, fn) {
  fn();
  passed++;
  console.log('ok - ' + name);
}

const free = (x, y, r) => {
  const p = W.resolveCollisions(x, y, r);
  return Math.hypot(p.x - x, p.y - y) < 0.5;
};

step('boss and player hp: the boss does not heal by default, the formula still works, players regenerate after a delay', () => {
  const { BOSS, PLAYER } = B;
  assert.strictEqual(BOSS.baseRegenPerSec, 0);
  assert.strictEqual(BOSS.regenPerSec, 0);
  assert.strictEqual(B.bossHpAt(1000, 0, 10 * 60 * 1000), 1000, 'damage sticks');
  // the regeneration code is kept: with a non-zero config it is computed, waits for its delay and never passes the maximum
  const cfg = { ...BOSS, baseRegenPerSec: 5, regenPerSec: 20 };
  assert.strictEqual(B.bossHpAt(1000, 0, 1000, cfg), 1000 + cfg.baseRegenPerSec);
  const at5 = B.bossHpAt(1000, 0, cfg.regenDelayMs, cfg);
  assert.strictEqual(at5, 1000 + (cfg.regenDelayMs * cfg.baseRegenPerSec) / 1000);
  assert.strictEqual(B.bossHpAt(1000, 0, cfg.regenDelayMs + 1000, cfg), at5 + cfg.baseRegenPerSec + cfg.regenPerSec);
  assert.strictEqual(B.bossHpAt(BOSS.maxHp - 10, 0, 10 * 60 * 1000, cfg), BOSS.maxHp);
  assert.strictEqual(B.playerHpAt(40, 0, PLAYER.regenDelayMs), 40);
  assert.strictEqual(B.playerHpAt(40, 0, PLAYER.regenDelayMs + 2000), 40 + 2 * PLAYER.regenPerSec);
  assert.strictEqual(B.playerHpAt(40, 0, 10 * 60 * 1000), PLAYER.maxHp);
  // a full bar takes about 20 seconds after the delay: neither instant nor endless
  const full = (PLAYER.maxHp - 1) / PLAYER.regenPerSec;
  assert.ok(full >= 15 && full <= 30);
  assert.strictEqual(B.hitScale(1), 1);
  assert.strictEqual(B.hitScale(BOSS.teamRef), 1);
  assert.strictEqual(B.hitScale(BOSS.teamRef * 4), 4);
});

step('the boss punches hard enough to matter: a handful of punches kill, and the windup can be dodged', () => {
  const { BOSS, PLAYER } = B;
  const punches = Math.ceil(PLAYER.maxHp / BOSS.punchDmg);
  assert.ok(punches >= 3 && punches <= 5, 'punches to kill: ' + punches);
  // a player running at full speed leaves the red circle before it lands
  const escape = (BOSS.punchRadius + W.PLAYER_RADIUS) / 420;
  assert.ok(escape < BOSS.windupMs / 1000, 'escape time ' + escape);
  assert.ok(BOSS.chaseSpeed < 420, 'a player is faster than the boss');
});

step('boss layout: home, patrol loop and the room are open floor, inside the server room', () => {
  const pts = [[W.BOSS_HOME.x, W.BOSS_HOME.y], ...W.BOSS_PATROL];
  for (const [x, y] of pts) {
    assert.ok(W.inBossZone(x, y), 'in zone ' + x + ',' + y);
    assert.ok(free(x, y, B.BOSS.radius + 4), 'free for the boss at ' + x + ',' + y);
  }
  // the door gap is wide enough for the boss to stand in the doorway
  assert.ok(free(W.SERVER_ROOM.x0, 1700, B.BOSS.radius));
  // the glass walls outside the door gap are not in the zone, the racks' room is
  assert.ok(!W.inBossZone(W.SERVER_ROOM.x0 - 200, 1700));
  assert.ok(!W.inBossZone(W.SERVER_ROOM.x0 - 60, 1400));
  assert.ok(W.inBossZone(3300, 1700));
});

step('line of sight: furniture and glass walls stop a hammer swing, open floor does not', () => {
  assert.ok(W.clearLine(3200, 1700, 3300, 1700));
  assert.ok(!W.clearLine(2700, 1400, 3000, 1400), 'through the west wall');
  assert.ok(!W.clearLine(3080, 1380, 3080, 1500), 'through a rack');
  assert.ok(W.clearLine(2820, 1700, 2940, 1700), 'through the door gap');
});

step('patrol: for two minutes the boss stays in its room, off the furniture, and visits every waypoint', () => {
  const b = B.createBossState();
  const seen = new Set();
  let nextRnd = 0;
  const rnd = () => ((nextRnd = (nextRnd * 9301 + 49297) % 233280), nextRnd / 233280);
  for (let i = 0; i < 1200; i++) {
    B.stepBoss(b, 0.1, [], rnd);
    assert.ok(W.inBossZone(b.x, b.y), 'in zone at step ' + i);
    assert.ok(free(b.x, b.y, B.BOSS.radius - 1), 'not inside furniture at step ' + i + ' (' + b.x + ',' + b.y + ')');
    W.BOSS_PATROL.forEach(([x, y], k) => {
      if (Math.hypot(b.x - x, b.y - y) < 30) seen.add(k);
    });
  }
  assert.strictEqual(seen.size, W.BOSS_PATROL.length, 'visited waypoints: ' + [...seen]);
});

step('chase: a player anywhere in the room is reached and punched within seconds (no getting stuck on racks)', () => {
  const R = W.BOSS_ROOM;
  let tested = 0;
  for (let x = R.x0 + 40; x < R.x1 - 30; x += 70) {
    for (let y = R.y0 + 40; y < R.y1 - 30; y += 70) {
      if (!free(x, y, W.PLAYER_RADIUS + 2)) continue;
      const b = B.createBossState();
      let wind = null;
      let now = 0;
      let n = 0;
      const rnd = () => ((n = (n * 7 + 13) % 101), n / 101);
      for (; now < 20 && !wind; now += 0.1) wind = B.stepBoss(b, 0.1, [{ id: 7, x, y }], rnd).find((e) => e.type === 'windup');
      assert.ok(wind, 'boss reached a player at ' + x + ',' + y + ' (boss at ' + Math.round(b.x) + ',' + Math.round(b.y) + ')');
      tested++;
    }
  }
  assert.ok(tested > 100, 'positions tried: ' + tested);
});

step('punch: the red circle appears first, the strike lands after the windup, and the boss then recovers', () => {
  const b = B.createBossState();
  b.x = 3300;
  b.y = 1700;
  const target = [{ id: 1, x: 3300, y: 1760 }]; // right next to it
  let ev = [];
  let t = 0;
  const log = [];
  for (; t < 5 && log.filter((e) => e.type === 'strike').length === 0; t += 0.05) {
    ev = B.stepBoss(b, 0.05, target);
    for (const e of ev) log.push({ ...e, at: t });
  }
  const wind = log.find((e) => e.type === 'windup');
  const strike = log.find((e) => e.type === 'strike');
  assert.ok(wind && strike, 'both events happened');
  assert.ok(Math.abs(strike.at - wind.at - B.BOSS.windupMs / 1000) < 0.1, 'strike after the windup');
  assert.strictEqual(strike.dmg, B.BOSS.punchDmg);
  // the circle is in front of the boss, towards the target
  assert.ok(Math.hypot(strike.x - target[0].x, strike.y - target[0].y) < B.BOSS.punchRadius);
  assert.strictEqual(b.mode, 'recover');
});

step('New Process warns before impact, keeps the marked position, and has a cooldown', () => {
  const b = B.createBossState();
  b.mode = 'chase';
  b.processCooldown = 0;
  const target = { id: 9, x: b.x + 180, y: b.y };
  const wind = B.stepBoss(b, 0.05, [target]).find(e => e.skill === 'newProcess');
  assert.ok(wind);
  assert.strictEqual(wind.ms, 1200);
  assert.strictEqual(wind.r, 220);
  assert.strictEqual(b.mode, 'windup');
  assert.ok(!B.stepBoss(b, 0.5, []).some(e => e.type === 'strike'));
  const strike = B.stepBoss(b, 0.71, [{ ...target, x: target.x + 400 }]).find(e => e.type === 'strike');
  assert.strictEqual(strike.skill, 'newProcess');
  assert.strictEqual(strike.dmg, 20);
  assert.strictEqual(strike.x, wind.x);
  assert.ok(b.processCooldown > 10);
  b.mode = 'dead';
  assert.deepStrictEqual(B.stepBoss(b, 1, [target]), []);
});

step('players outside the zone are ignored: no chase, the boss keeps patrolling', () => {
  const b = B.createBossState();
  for (let i = 0; i < 100; i++) B.stepBoss(b, 0.1, []); // nobody passed in: the caller already filtered by zone
  assert.strictEqual(b.mode, 'patrol');
});

step('dead boss does nothing until the caller revives it', () => {
  const b = B.createBossState();
  b.mode = 'dead';
  const x = b.x;
  assert.deepStrictEqual(B.stepBoss(b, 1, [{ id: 1, x: b.x + 10, y: b.y }]), []);
  assert.strictEqual(b.x, x);
  const d = B.respawnDelay(() => 0);
  assert.strictEqual(d, B.BOSS.respawnMinMs);
  assert.strictEqual(B.respawnDelay(() => 1), B.BOSS.respawnMaxMs);
});

// A deliberately generous model of N players who never die and never miss (the boss does not heal any more). Two ways to
// swing: "greedy" hits whenever there is mana for it, "burst" waits for a full bar and empties it (better use of the
// fast mana regeneration, but it leaves gaps in which the boss heals). Deaths only make the real fight harder, so if
// a group cannot win here it cannot win for real.
function secondsToKill(n, style, limitS = 900) {
  const dt = 0.05;
  let hp = B.BOSS.maxHp;
  let at = 0;
  const ps = Array.from({ length: n }, (_, i) => ({ mana: MANA.max, manaAt: 0, lastHit: -1e9, off: i * 37, burst: true }));
  for (let t = 0; t < limitS; t += dt) {
    const now = t * 1000;
    for (const p of ps) {
      if (now - p.lastHit < HIT_COOLDOWN_MS + (p.off % 20)) continue;
      const m = manaAt(p, now);
      if (style === 'burst') {
        if (!p.burst && m >= MANA.max - MANA.cost) p.burst = true; // full bar again: start swinging
        if (!p.burst) continue;
        if (m < MANA.cost) {
          p.burst = false;
          continue;
        }
      } else if (m < MANA.cost) continue;
      p.mana = m - MANA.cost;
      p.manaAt = now;
      p.lastHit = now;
      hp = B.bossHpAt(hp, at, now) - B.BOSS.hitDmg / B.hitScale(n);
      at = now;
      if (hp <= 0) return t;
    }
  }
  return Infinity;
}
const best = (n) => Math.min(secondsToKill(n, 'greedy'), secondsToKill(n, 'burst'));

step('balance: no regeneration, so it is a damage budget: a lone player takes a long time, five take about a minute, a crowd is not trivial', () => {
  const times = {};
  for (const n of [1, 2, 3, 4, 5, 8, 12, 20]) times[n] = best(n);
  console.log('   seconds to kill by players (best of two swing styles): ' + Object.entries(times).map(([n, t]) => n + ':' + (t === Infinity ? 'never' : Math.round(t))).join('  '));
  assert.ok(times[1] > 240, 'solo is a long job even if the boss never punched: ' + times[1]);
  assert.ok(times[2] > times[3] && times[3] > times[4] && times[4] > times[5], 'more players, faster: ' + JSON.stringify(times));
  assert.ok(times[5] >= 50 && times[5] <= 150, 'five players: ' + times[5]);
  for (const n of [8, 12, 20]) assert.ok(times[n] >= 50 && times[n] <= 180, n + ' players: ' + times[n]);
});

console.log('\nAll ' + passed + ' checks passed');
