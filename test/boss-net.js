'use strict';

// Sếp VKL over real WebSockets, one server, in-memory store. The numbers are shrunk through the same options the
// production code takes (a tiny boss, quick respawns) so a whole fight fits in a few seconds.
// The rules themselves are in test/boss.js; running one boss across several instances is in test/shared.js.

process.env.FIXED_ROOMS = '0';
delete process.env.REDIS_URL;
delete process.env.KV_URL;
delete process.env.VERCEL;

const assert = require('assert');
const server = require('../server.js');
const world = require('../lib/world.js');
const B = require('../lib/boss.js');
const h = require('./helpers.js');

const { sleep, send, take, none, WebSocket } = h;
let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log('ok - ' + name);
}

const INSIDE = { x: 3300, y: 1640 }; // in the server room, near where the boss starts
const LOBBY = { x: 1900, y: 1950 };

async function main() {
  const app = server.createApp({ bossMaxHp: 60, bossRespawnMs: 1500, playerRespawnMs: 1500, maxConnPerIp: 100 });
  const port = await app.start(0);
  const join = (name, room, token = h.newToken(), at = INSIDE) =>
    new Promise((resolve, reject) => {
      world.WORLD.spawn = { ...at, rx: 0, ry: 0 };
      const ws = new WebSocket('ws://127.0.0.1:' + port + '/api/ws');
      const c = { ws, name, token, msgs: [], welcome: null, id: null };
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        c.msgs.push(m);
        if (m.t === 'welcome') {
          c.welcome = m;
          c.id = m.you;
          resolve(c);
        }
      });
      ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, room, token })));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('join timeout')), 4000);
    });

  await step('welcome carries the boss and health settings, and everyone starts at full health', async () => {
    const a = await join('Ann', 'bn-a', undefined, LOBBY);
    assert.strictEqual(a.welcome.boss.maxHp, 60);
    assert.strictEqual(a.welcome.boss.name, B.BOSS.name);
    assert.strictEqual(a.welcome.boss.dead, false);
    assert.strictEqual(a.welcome.player.max, B.PLAYER.maxHp);
    const me = a.welcome.players.find((p) => p.id === a.id);
    assert.strictEqual(me.hp, B.PLAYER.maxHp);
    assert.strictEqual(me.deadMs, 0);
    a.ws.close();
  });

  await step('somebody who stays in the lobby is left alone', async () => {
    const a = await join('Calm', 'bn-calm', undefined, LOBBY);
    await sleep(1500);
    assert.ok(!a.msgs.some((m) => m.t === 'bwind' || m.t === 'hp' || m.t === 'down'));
    a.ws.close();
  });

  await step('walking into the server room: it winds up (red circle), punches, hurts, and finally knocks out; no moving while down; back at the lobby, rejoin cannot cheat', async () => {
    const token = h.newToken();
    const a = await join('Victim', 'bn-fight', token);
    const wind = await take(a, (m) => m.t === 'bwind', 6000);
    assert.strictEqual(wind.r, B.BOSS.punchRadius);
    assert.strictEqual(wind.ms, B.BOSS.windupMs);
    await take(a, (m) => m.t === 'boss' && m.m !== 'patrol', 1000);
    const strike = await take(a, (m) => m.t === 'bstrike', 2000);
    assert.strictEqual(strike.dmg, B.BOSS.punchDmg);
    const first = await take(a, (m) => (m.t === 'hp' || m.t === 'down') && m.id === a.id, 2000);
    assert.strictEqual(first.dmg, B.BOSS.punchDmg, 'it hurts: ' + JSON.stringify(first));
    assert.strictEqual(first.hp, B.PLAYER.maxHp - B.BOSS.punchDmg);
    // stand still and take the rest of it
    const down = await take(a, (m) => m.t === 'down' && m.id === a.id, 12000);
    assert.strictEqual(down.ms, 1500);
    // knocked out: walking and swinging do nothing
    send(a, { t: 'move', x: 2500, y: 1700, d: 1 });
    send(a, { t: 'bhit' });
    await none(a, (m) => m.t === 'ps' && m.l.some((e) => e[0] === a.id), 400);
    // refreshing the page does not bring them back: the knock-out lives in the store
    world.WORLD.spawn = { ...LOBBY, rx: 0, ry: 0 };
    a.ws.close();
    await sleep(200);
    const again = await join('Victim', 'bn-fight', token, LOBBY);
    const me = again.welcome.players.find((p) => p.id === again.id);
    assert.ok(me.deadMs > 0, 'still knocked out after a rejoin: ' + me.deadMs);
    // ... and when the time is up they are back at the lobby (the spawn at that moment), not where they fell
    const up = await take(again, (m) => m.t === 'up' && m.id === again.id, 4000);
    assert.ok(Math.hypot(up.x - LOBBY.x, up.y - LOBBY.y) < 5, 'revived at the lobby: ' + up.x + ',' + up.y);
    assert.ok(!world.inBossZone(up.x, up.y));
    again.ws.close();
  });

  await step('hitting the boss: health drops, a beaten boss pays the bounty by damage, stays down, then returns', async () => {
    const room = 'bn-kill';
    const a = await join('Hitter', room);
    const b = await join('Helper', room);
    await sleep(1500); // let the boss notice them
    let dead = null;
    for (let i = 0; i < 40 && !dead; i++) {
      for (const c of [a, b]) send(c, { t: 'bhit' });
      await sleep(200);
      dead = a.msgs.find((m) => m.t === 'bdead');
    }
    assert.ok(a.msgs.some((m) => m.t === 'bhp' && m.hp > 0), 'it took damage before falling');
    dead = dead || (await take(a, (m) => m.t === 'bdead', 4000));
    assert.strictEqual(dead.bounty, B.BOSS.bounty);
    assert.ok(dead.shares.length >= 1 && dead.shares.every((s) => s.dmg > 0 && s.bounty > 0));
    const paid = dead.shares.reduce((n, s) => n + s.bounty, 0);
    assert.ok(Math.abs(paid - B.BOSS.bounty) < 0.2, 'the whole bounty is paid: ' + paid);
    const board = await take(a, (m) => m.t === 'board' && m.total >= B.BOSS.bounty, 2000);
    assert.ok(board.board.reduce((n, e) => n + e.score, 0) >= B.BOSS.bounty - 0.2);
    // it stays down for a while: more swings do nothing
    for (const m of a.msgs) m._used = true; // only look at what arrives from here on
    send(a, { t: 'bhit' });
    await none(a, (m) => m.t === 'bhp' && m.hp > 0, 300);
    // and then comes back
    const up = await take(a, (m) => m.t === 'bup', 5000);
    assert.deepStrictEqual([up.x, up.y], [world.BOSS_HOME.x, world.BOSS_HOME.y]);
    a.ws.close();
    b.ws.close();
  });

  await step('a hammer swing does not pass through a glass wall', async () => {
    const a = await join('Outside', 'bn-wall', undefined, { x: 2830, y: 1500 }); // outside the west wall, abreast of the boss
    await sleep(800);
    for (let i = 0; i < 6; i++) {
      send(a, { t: 'bhit' });
      await sleep(220);
    }
    assert.ok(!a.msgs.some((m) => m.t === 'bhp'), 'no damage through a wall');
    a.ws.close();
  });

  await app.stop();
  console.log('\nAll ' + passed + ' checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
