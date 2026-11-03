'use strict';

// End-to-end smoke test: starts the real server on a random port and drives it
// with real WebSocket clients. Run with `npm test`.

process.env.RESPAWN_MS = '1500';

// The shared-state behaviour across several instances is covered in test/shared.js.

delete process.env.REDIS_URL; // this file always runs against the in-memory store
delete process.env.KV_URL;
delete process.env.VERCEL;
process.env.FIXED_ROOMS = '0'; // most checks below use throw-away room names; the fixed-room rules have their own step

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const server = require('../server.js');
const h = require('./helpers.js');
const world = require('../lib/world.js');

const { sleep, send, take, none, walkTo, dist, WebSocket } = h;
let port;
let fullPort;
const client = (name, room, token) => h.client(port, name, room, token);

function httpGet(p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log('ok - ' + name);
}

async function main() {
  // Everyone spawns in the pantry, a few steps from the printers, so the old walk-and-hit
  // checks stay short. (Real players spawn in the lobby.)
  const lobbySpawn = world.WORLD.spawn;
  world.WORLD.spawn = { x: 3140, y: 300, rx: 0, ry: 0 };
  port = await server.start(0);
  // a second app with a high per-IP cap, for the full-room check
  const bigIp = server.createApp({ maxConnPerIp: 100 });
  fullPort = await bigIp.start(0);

  await step('client script only uses element ids that exist in index.html', async () => {
    const js = fs.readFileSync(path.join(__dirname, '../public/game.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    const ids = new Set([...js.matchAll(/\$\('([A-Za-z]+)'\)/g)].map((m) => m[1]));
    assert.ok(ids.size > 10);
    for (const id of ids) assert.ok(html.includes('id="' + id + '"'), 'missing #' + id);
  });

  await step('static files, health check and path traversal', async () => {
    const root = await httpGet('/');
    assert.strictEqual(root.status, 200);
    assert.ok(root.body.includes('Office Rage Room'));
    assert.strictEqual((await httpGet('/game.js')).status, 200);
    assert.strictEqual((await httpGet('/style.css')).status, 200);
    assert.strictEqual((await httpGet('/healthz')).body, 'ok');
    assert.strictEqual((await httpGet('/nope.txt')).status, 404);
    const trav = await httpGet('/..%2fserver.js');
    assert.ok(trav.status === 403 || trav.status === 404);
    assert.ok(!trav.body.includes('WebSocketServer'));
  });

  const A = await client('An', 'testroom');
  const B = await client('Binh', 'testroom');
  const C = await client('Chi', 'otherroom');

  await step('two players join the same room and see each other', async () => {
    assert.ok(A.welcome.objects.length >= 30);
    assert.strictEqual(B.welcome.players.length, 2);
    const pj = await take(A, (m) => m.t === 'pj' && m.p.id === B.id);
    assert.strictEqual(pj.p.name, 'Binh');
    assert.strictEqual(C.welcome.players.length, 1);
  });

  await step('hitting an object out of reach is rejected', async () => {
    const far = A.welcome.objects.reduce((best, o) => (dist(A, o) > dist(A, best) ? o : best));
    assert.ok(dist(A, far) > server.HIT_RANGE);
    send(A, { t: 'hit', id: far.id });
    await none(A, (m) => m.t === 'hit');
  });

  await step('teleporting is clamped by the server', async () => {
    const near = A.welcome.objects[0];
    send(A, { t: 'move', x: near.x, y: near.y, d: 1 });
    await sleep(100);
    send(A, { t: 'hit', id: near.id });
    await none(A, (m) => m.t === 'hit' && m.id === near.id);
    // The clamp left the server's copy of A part-way to `near`. Walk back to where the
    // client thinks it is so later steps start in sync (the old test skipped this and
    // failed about 1 run in 6 depending on the random spawn).
    for (let i = 0; i < 8; i++) {
      send(A, { t: 'move', x: Math.round(A.x), y: Math.round(A.y), d: 1 });
      await sleep(120);
    }
  });

  const target = A.welcome.objects
    .filter((o) => o.type === 'printer')
    .reduce((best, o) => (dist(A, o) < dist(A, best) ? o : best));
  const info = server.TYPES[target.type];

  await step('walking in range then hitting damages the object for everyone', async () => {
    await walkTo(A, target, 60);
    send(A, { t: 'hit', id: target.id });
    const hitA = await take(A, (m) => m.t === 'hit' && m.id === target.id);
    const hitB = await take(B, (m) => m.t === 'hit' && m.id === target.id);
    assert.strictEqual(hitA.hp, info.hp - 1);
    assert.strictEqual(hitB.hp, info.hp - 1);
    assert.strictEqual(hitB.by, A.id);
  });

  await step('hit cooldown drops rapid duplicate hits', async () => {
    await sleep(250);
    send(A, { t: 'hit', id: target.id });
    send(A, { t: 'hit', id: target.id });
    await sleep(120);
    const hits = A.msgs.filter((m) => !m._used && m.t === 'hit' && m.id === target.id);
    assert.strictEqual(hits.length, 1);
    hits[0]._used = true;
  });

  await step('object breaks at zero hp, cost is scored and broadcast', async () => {
    let hpLeft = info.hp - 2;
    while (hpLeft > 0) {
      await sleep(220);
      send(A, { t: 'hit', id: target.id });
      hpLeft--;
    }
    const brk = await take(B, (m) => m.t === 'break' && m.id === target.id);
    assert.strictEqual(brk.cost, info.cost);
    assert.strictEqual(brk.by, A.id);
    const board = await take(B, (m) => m.t === 'board' && m.total === info.cost);
    assert.strictEqual(board.board[0].name, 'An');
    assert.strictEqual(board.board[0].breaks, 1);
  });

  await step('a broken object cannot be hit again', async () => {
    await sleep(250);
    A.msgs.forEach((m) => (m._used = true));
    send(A, { t: 'hit', id: target.id });
    await none(A, (m) => m.t === 'hit' && m.id === target.id);
  });

  await step('IT reset restores everything, second reset hits the cooldown', async () => {
    send(A, { t: 'reset' });
    const r = await take(B, (m) => m.t === 'reset');
    assert.strictEqual(r.by, 'An');
    send(B, { t: 'reset' });
    const err = await take(B, (m) => m.t === 'err');
    assert.ok(err.m.length > 0);
    send(A, { t: 'hit', id: target.id });
    const hit = await take(A, (m) => m.t === 'hit' && m.id === target.id);
    assert.strictEqual(hit.hp, info.hp - 1);
  });

  await step('emotes are broadcast and invalid ones are ignored', async () => {
    send(B, { t: 'emote', e: 3 });
    const e = await take(A, (m) => m.t === 'emote' && m.id === B.id && m.e === 3);
    assert.strictEqual(e.e, 3);
    await sleep(900);
    send(B, { t: 'emote', e: 99 });
    await none(A, (m) => m.t === 'emote' && m.e === 99);
  });

  await step('garbage input does not break the server', async () => {
    A.ws.send('not json at all');
    send(A, { t: 5 });
    send(A, { t: 'move', x: 'abc', y: null });
    send(A, { t: 'hit', id: 'x' });
    send(A, { t: 'hit', id: -1 });
    await sleep(900);
    send(A, { t: 'emote', e: 1 });
    await take(B, (m) => m.t === 'emote' && m.id === A.id && m.e === 1);
  });

  await step('oversized messages close the connection', async () => {
    const big = await client('Big', 'bigroom');
    const closed = new Promise((r) => big.ws.on('close', (code) => r(code)));
    big.ws.send('x'.repeat(5000));
    assert.strictEqual(await closed, 1009);
  });

  await step('player names are sanitized', async () => {
    const D = await client('<img src=x onerror=1>', 'testroom');
    const pj = await take(A, (m) => m.t === 'pj' && m.p.id === D.id);
    assert.ok(!/[<>]/.test(pj.p.name));
    assert.ok(pj.p.name.length <= 14);
    D.ws.close();
  });

  await step('broken objects respawn after the delay', async () => {
    const R = await client('Ren', 'respawnroom');
    const o = R.welcome.objects
      .filter((x) => x.type === 'plant')
      .reduce((best, x) => (dist(R, x) < dist(R, best) ? x : best));
    await walkTo(R, o, 60);
    for (let i = 0; i < server.TYPES.plant.hp; i++) {
      send(R, { t: 'hit', id: o.id });
      await sleep(220);
    }
    await take(R, (m) => m.t === 'break' && m.id === o.id);
    await take(R, (m) => m.t === 'respawn' && m.id === o.id, 4500);
    R.ws.close();
  });

  await step('rooms are isolated from each other', async () => {
    assert.ok(!C.msgs.some((m) => m.t === 'hit' || m.t === 'break' || m.t === 'emote' || m.t === 'reset'));
  });

  await step('connections per IP are limited', async () => {
    [A, B, C].forEach((c) => c.ws.close());
    await sleep(400);
    const socks = [];
    for (let i = 0; i < 10; i++) {
      const ws = new WebSocket('ws://127.0.0.1:' + port + '/api/ws');
      socks.push(ws);
      await new Promise((r) => ws.on('open', r));
    }
    const extra = new WebSocket('ws://127.0.0.1:' + port + '/api/ws');
    const code = await new Promise((r) => extra.on('close', (c) => r(c)));
    assert.strictEqual(code, 1013);
    socks.forEach((s) => s.close());
    await sleep(400); // let the server release the leases
  });

  await step('rejoining with the same token keeps id, score and position', async () => {
    const room = 'rejoinroom';
    const O = await client('Obs', room);
    const X = await client('Xuan', room);
    await h.smashPlant(X, server.TYPES);
    const board = await take(O, (m) => m.t === 'board' && m.board.some((e) => e.name === 'Xuan'));
    assert.strictEqual(board.board[0].score, server.TYPES.plant.cost);
    const spot = { x: X.x, y: X.y };
    X.ws.terminate(); // like the platform cutting the connection
    const pl = await take(O, (m) => m.t === 'pl' && m.id === X.id, 3000);
    assert.strictEqual(pl.id, X.id);
    const X2 = await client('Xuan', room, X.token);
    assert.strictEqual(X2.id, X.id, 'same player id after reconnect');
    const me = X2.welcome.players.find((p) => p.id === X2.id);
    assert.strictEqual(me.score, server.TYPES.plant.cost, 'score survives the reconnect');
    assert.ok(Math.hypot(me.x - spot.x, me.y - spot.y) < 30, 'position survives the reconnect');
    assert.ok(X2.welcome.objects.some((o) => o.broken), 'broken objects stay broken');
    const pj = await take(O, (m) => m.t === 'pj' && m.p.id === X.id);
    assert.strictEqual(pj.p.id, X.id);
    O.ws.close();
    X2.ws.close();
  });

  await step('a new connection with the same token takes over silently (planned renewal)', async () => {
    const room = 'handover';
    const O = await client('Obs', room);
    const X = await client('Xuan', room);
    await take(O, (m) => m.t === 'pj' && m.p.id === X.id);
    const X2 = await client('Xuan', room, X.token);
    assert.strictEqual(X2.id, X.id);
    await sleep(300);
    assert.strictEqual(X.closeCode, 4001, 'old socket is told it was replaced');
    await none(O, (m) => (m.t === 'pl' || m.t === 'pj') && (m.id === X.id || (m.p && m.p.id === X.id)), 400);
    assert.strictEqual(O.msgs.filter((m) => m.t === 'board').pop().online, 2);
    // the new socket is fully functional, the old one's late close did not evict it
    send(X2, { t: 'emote', e: 2 });
    await take(O, (m) => m.t === 'emote' && m.id === X.id);
    O.ws.close();
    X2.ws.close();
  });

  await step('server asks clients to renew before the max duration', async () => {
    const short = server.createApp({ renewAfterMs: 1200 });
    const p2 = await short.start(0);
    const c = await h.client(p2, 'Ren', 'renewroom');
    const t0 = Date.now();
    await take(c, (m) => m.t === 'renew', 4000);
    assert.ok(Date.now() - t0 > 500);
    c.ws.close();
    await short.stop();
  });

  await step('smashing costs mana, the server reports it, and mana comes back (fast once you stop)', async () => {
    const cfg = A.welcome.mana;
    assert.deepStrictEqual({ max: cfg.max, cost: cfg.cost }, { max: server.MANA.max, cost: server.MANA.cost });
    const m = await take(A, (x) => x.t === 'mana');
    assert.ok(m.v >= 0 && m.v <= cfg.max && m.ago >= 0);
    // pure regeneration rule shared with the client: 10/s while swinging, 30/s after 1 s of rest
    const probe = (ms) => server.manaAt({ mana: 0, manaAt: 0 }, ms);
    assert.strictEqual(probe(500), 5);
    assert.strictEqual(probe(1000), 10);
    assert.strictEqual(probe(2000), 40);
    assert.strictEqual(probe(60000), server.MANA.max);
  });

  await step('a missing or duplicate name is refused, a reconnect with the same token is not', async () => {
    const tryJoin = (name, token) => new Promise((resolve) => {
      const ws = new WebSocket('ws://127.0.0.1:' + port + '/api/ws');
      ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, room: 'dupnames', token })));
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.t === 'err') resolve(m);
        if (m.t === 'welcome') { ws.close(); resolve(m); }
      });
    });
    const empty = await tryJoin('   ', h.newToken());
    assert.strictEqual(empty.t, 'err');
    assert.strictEqual(empty.code, 'name');
    const first = await h.client(port, 'Hoa', 'dupnames');
    const dup = await tryJoin('Hoa', h.newToken());
    assert.strictEqual(dup.code, 'name');
    assert.ok(/đã có người dùng/.test(dup.m));
    const lower = await tryJoin('hoa', h.newToken());
    assert.strictEqual(lower.t, 'welcome');
    const same = await tryJoin('Hoa', first.token);
    assert.strictEqual(same.t, 'welcome');
    first.ws.close();
  });

  await step('a full room rejects new players', async () => {
    const socks = [];
    for (let i = 0; i < 20; i++) {
      socks.push(await h.client(fullPort, 'F' + i, 'fullroom'));
    }
    const extra = await new Promise((resolve) => {
      const ws = new WebSocket('ws://127.0.0.1:' + fullPort + '/api/ws');
      ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: 'late', room: 'fullroom', token: h.newToken() })));
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.t === 'err') resolve(m);
      });
    });
    assert.ok(/đầy/.test(extra.m));
    socks.forEach((c) => c.ws.close());
  });

  await step('furniture is solid: the server stops a player walking through a desk', async () => {
    const desk = world.PROPS.find((p) => p.k === 'desk');
    const edge = desk.y + desk.h / 2 + world.PLAYER_RADIUS; // lowest y a player's centre can reach
    world.WORLD.spawn = { x: desk.x, y: edge + 40, rx: 0, ry: 0 }; // just in front of the first desk
    const O = await client('Obs', 'solidroom');
    const X = await client('Walker', 'solidroom');
    let y = X.y;
    for (let i = 0; i < 30; i++) {
      y -= 12; // straight up, through the desk
      send(X, { t: 'move', x: X.x, y, d: 1 });
      await sleep(60);
    }
    await sleep(200);
    const last = O.msgs.filter((m) => m.t === 'ps').flatMap((m) => m.l).filter((e) => e[0] === X.id).pop();
    assert.ok(last, 'observer saw the walker move');
    assert.ok(last[2] >= edge - 2, 'stopped at the desk edge ' + edge + ', got y=' + last[2]);
    // the server's own copy agrees with the shared collision maths
    const fixed = world.resolveCollisions(last[1], last[2]);
    assert.ok(Math.hypot(fixed.x - last[1], fixed.y - last[2]) < 3);
    O.ws.close();
    X.ws.close();
    world.WORLD.spawn = lobbySpawn;
  });

  await step('players who do nothing are disconnected with code 4002, active ones are not', async () => {
    const app = server.createApp({ afkMs: 900 });
    const p = await app.start(0);
    const idle = await h.client(p, 'Idle', 'afkroom');
    const busy = await h.client(p, 'Busy', 'afkroom');
    let x = busy.x;
    for (let i = 0; i < 28; i++) {
      x += i % 2 ? 6 : -6; // keeps moving for ~2.8 s
      send(busy, { t: 'move', x, y: busy.y, d: 1 });
      await sleep(100);
    }
    assert.strictEqual(idle.closeCode, 4002, 'idle player was told to go (4002)');
    assert.strictEqual(busy.closeCode, null, 'moving player is still connected');
    // re-sending the same spot is not activity
    const faker = await h.client(p, 'Faker', 'afkroom');
    for (let i = 0; i < 18; i++) {
      send(faker, { t: 'move', x: faker.x, y: faker.y, d: 1 });
      await sleep(100);
    }
    assert.strictEqual(faker.closeCode, 4002, 'standing still while spamming moves still counts as AFK');
    busy.ws.close();
    await app.stop();
  });

  await step('only the fixed rooms exist; unknown names land in the first; /api/rooms lists them with counts', async () => {
    const app = server.createApp({ rooms: world.ROOMS });
    const p = await app.start(0);
    const stray = await h.client(p, 'Stray', 'some-private-room');
    assert.strictEqual(stray.welcome.room, world.ROOMS[0].id, 'an unknown room falls back to the first room');
    assert.strictEqual(stray.welcome.roomLabel, world.ROOMS[0].name);
    const other = await h.client(p, 'Other', world.ROOMS[1].id);
    assert.strictEqual(other.welcome.room, world.ROOMS[1].id);
    assert.strictEqual(other.welcome.roomLabel, world.ROOMS[1].name);
    // the two players are in different rooms, so they must not see each other
    assert.strictEqual(other.welcome.players.length, 1);
    const list = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: p, path: '/api/rooms' }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });
    assert.deepStrictEqual(list.rooms.map((r) => [r.id, r.name]), world.ROOMS.map((r) => [r.id, r.name]));
    assert.ok(list.rooms.every((r) => r.max === 20 && Number.isInteger(r.online)));
    const total = list.rooms.reduce((n, r) => n + r.online, 0);
    assert.ok(total >= 0 && total <= 2);
    stray.ws.close();
    other.ws.close();
    await app.stop();
  });

  await step('the join screen offers exactly the server\'s rooms', async () => {
    const js = fs.readFileSync(path.join(__dirname, '../public/game.js'), 'utf8');
    for (const r of world.ROOMS) {
      assert.ok(js.includes("id: '" + r.id + "'") && js.includes("name: '" + r.name + "'"), 'FALLBACK_ROOMS has ' + r.id);
    }
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    assert.ok(html.includes('id="roomList"') && !html.includes('id="roomInput"'), 'rooms are picked, not typed');
  });

  await step('connection and room caps, and the kill switch', async () => {
    const capped = server.createApp({ maxConnections: 2, maxRooms: 1 });
    const p = await capped.start(0);
    const a = await h.client(p, 'A', 'room-one');
    const b = await h.client(p, 'B', 'room-one'); // same room is fine
    const third = new WebSocket('ws://127.0.0.1:' + p + '/api/ws');
    assert.strictEqual(await new Promise((r) => third.on('close', (c) => r(c))), 1013, 'third connection refused');
    b.ws.close();
    await sleep(300);
    const other = await new Promise((resolve) => {
      const ws = new WebSocket('ws://127.0.0.1:' + p + '/api/ws');
      ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: 'C', room: 'room-two', token: h.newToken() })));
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.t === 'err') resolve(m);
      });
    });
    assert.ok(/đầy phòng/.test(other.m), 'a second room is refused when maxRooms is 1');
    a.ws.close();
    await capped.stop();

    const off = server.createApp({ disabled: true });
    const po = await off.start(0);
    const closedMsg = await new Promise((resolve) => {
      const ws = new WebSocket('ws://127.0.0.1:' + po + '/api/ws');
      ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: 'D', room: 'x', token: h.newToken() })));
      ws.on('message', (d) => resolve(JSON.parse(d.toString())));
    });
    assert.strictEqual(closedMsg.t, 'err');
    assert.ok(/tạm đóng/.test(closedMsg.m));
    await off.stop();
  });

  console.log('\nAll ' + passed + ' checks passed');
  await bigIp.stop();
  await server.stop();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\nFAILED:', err && err.stack ? err.stack : err);
  try {
    await server.stop();
  } catch (e) { /* ignore */ }
  process.exit(1);
});
