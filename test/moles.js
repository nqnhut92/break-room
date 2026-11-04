'use strict';

// "Bạn sếp nằm vùng" over real WebSockets: fake players that join like anybody, mingle, stab, and can be beaten.
// The timings are shrunk through the options the production code takes.

process.env.FIXED_ROOMS = '0';
delete process.env.REDIS_URL;
delete process.env.KV_URL;
delete process.env.VERCEL;

const assert = require('assert');
const server = require('../server.js');
const world = require('../lib/world.js');
const M = require('../lib/moles.js');
const h = require('./helpers.js');

const { sleep, send, take, none } = h;
let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log('ok - ' + name);
}

const LOBBY = { x: 1900, y: 1950 };

function unit() {
  const cap = M.moleCap;
  assert.deepStrictEqual([0, 1, 2, 5, 6, 7, 19, 20].map((n) => cap(n, 20)), [0, 0, 1, 2, 3, 3, 0, 0]);
  assert.deepStrictEqual([13, 14].map((n) => cap(n, 20)), [6, 5], 'a slot always stays free for a real person');
  assert.ok(M.NAMES.every((n) => n.length <= 14));
  const made = Array.from({ length: 2000 }, () => M.randomName());
  assert.ok(made.every((n) => n.length >= 1 && n.length <= 14 && !/[<>]/.test(n)), 'every generated name fits the join box');
  assert.ok(new Set(made).size > 150, 'and they are varied');
  assert.ok(made.some((n) => n === n.toLowerCase()) && made.some((n) => /\d/.test(n)), 'some look like handles');
  // it idles near things, then walks to its victim and stabs once, then fights
  const humans = [{ id: 1, x: 1960, y: 1950 }];
  const mole = M.makeMole({ id: 9, connId: 'c', name: 'X', x: 1900, y: 1950 }, 0, { mingleMs: [0, 0] }, () => 0);
  const seen = [];
  for (let t = 0; t < 8000 && !seen.includes('stab'); t += 100) for (const e of M.stepMole(mole, 0.1, { now: t, humans }, { mingleMs: [0, 0] }, () => 0)) seen.push(e.type);
  assert.ok(seen.includes('stab'), 'it reaches and stabs: ' + seen);
  assert.strictEqual(mole.revealed, true);
}

async function main() {
  unit();
  console.log('ok - moles: cap, names and the stab');
  passed++;

  const opts = { moleSpawnMs: [300, 300], moleOpts: { mingleMs: [60000, 60000] }, maxConnPerIp: 100 };
  let app = server.createApp(opts);
  let port = await app.start(0);
  world.WORLD.spawn = { ...LOBBY, rx: 20, ry: 20 };

  await step('a lone player never meets one; two players get one, who looks like anybody and counts online', async () => {
    const a = await h.client(port, 'Ann', 'mo-a');
    await none(a, (m) => m.t === 'pj', 900);
    const b = await h.client(port, 'Bob', 'mo-a');
    const pj = await take(a, (m) => m.t === 'pj' && m.p.id !== b.id, 3000);
    assert.ok(pj.p.name && pj.p.name.length <= 14);
    assert.strictEqual(pj.p.deadMs, 0);
    assert.ok(!JSON.stringify(pj).includes('mole'), 'nothing on the wire says what it is');
    const board = await take(a, (m) => m.t === 'board' && m.online === 3, 2000);
    assert.ok(board.board.some((e) => e.id === pj.p.id));
    const c = await h.client(port, 'Cy', 'mo-a');
    assert.strictEqual(c.welcome.players.length, 4, 'three people and the mole');
    assert.deepStrictEqual(c.welcome.moles, [], 'a mole that has not given itself away is not disclosed');
    for (const x of [a, b, c]) x.ws.close();
  });
  await app.stop();

  // the next ones: it goes for somebody at once
  app = server.createApp({ moleSpawnMs: [200, 200], moleOpts: { mingleMs: [100, 100], rageMs: 60000, rageDmg: 1, rageCooldownMs: 100 }, maxConnPerIp: 100 });
  port = await app.start(0);
  world.WORLD.spawn = { ...LOBBY, rx: 0, ry: 0 };

  await step('it stabs without warning for 30, gives itself away, and anyone who hits it for 8 blows takes the bounty', async () => {
    const a = await h.client(port, 'Ann', 'mo-b');
    const b = await h.client(port, 'Bob', 'mo-b');
    const stab = await take(a, (m) => m.t === 'moleStab' && m.first, 6000);
    assert.strictEqual(stab.dmg, M.MOLE.stabDmg);
    const hurt = await take(stab.target === a.id ? a : b, (m) => m.t === 'hp' && m.id === stab.target && m.dmg === M.MOLE.stabDmg, 1500);
    assert.strictEqual(hurt.hp, 100 - M.MOLE.stabDmg);
    const reveal = await take(a, (m) => m.t === 'moleReveal' && m.id === stab.id, 1000);
    assert.strictEqual(reveal.hp, M.MOLE.hp);
    // a newcomer is told about the ones already found out
    const c = await h.client(port, 'Cy', 'mo-b');
    assert.ok(c.welcome.moles.some((m) => m.id === stab.id));
    // hit it until it falls (mana costs 5 a blow, a cabinet's worth of health)
    const before = (await take(c, (m) => m.t === 'board', 2000)).total;
    let dead = null;
    for (let i = 0; i < 40 && !dead; i++) {
      send(c, { t: 'phit', id: stab.id, skill: 'hammer' });
      await sleep(260);
      dead = c.msgs.find((m) => m.t === 'moleDead');
      if (i === 2) assert.ok(c.msgs.some((m) => m.t === 'moleHit' && m.id === stab.id && m.hp > 0 && m.hp < M.MOLE.hp), 'it shows its health');
    }
    assert.ok(dead, 'it falls');
    assert.strictEqual(dead.by, c.id);
    assert.strictEqual(dead.cost, world.TYPES.server.cost);
    const pl = await take(c, (m) => m.t === 'pl' && m.id === stab.id, 2000);
    const board = (await take(c, (m) => m.t === 'board' && !m.board.some((e) => e.id === stab.id), 2000));
    assert.ok(board.board.find((e) => e.id === c.id).score >= world.TYPES.server.cost);
    assert.ok(board.total >= before + world.TYPES.server.cost);
    for (const x of [a, b, c]) x.ws.close();
  });

  await step('hitting a real person is still free and only cosmetic', async () => {
    const a = await h.client(port, 'Dan', 'mo-c');
    const b = await h.client(port, 'Eve', 'mo-c');
    const mana = (c) => c.msgs.filter((m) => m.t === 'mana').length;
    send(a, { t: 'phit', id: b.id, skill: 'hammer' });
    const ph = await take(b, (m) => m.t === 'phit' && m.id === b.id, 1000);
    assert.strictEqual(ph.by, a.id);
    assert.strictEqual(mana(a), 0);
    a.ws.close(); b.ws.close();
  });
  await app.stop();

  console.log('\nAll ' + passed + ' checks passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
