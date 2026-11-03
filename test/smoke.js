'use strict';

// End-to-end smoke test: starts the real server on a random port and drives it
// with real WebSocket clients. Run with `npm test`.

process.env.RESPAWN_MS = '1500';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const server = require('../server.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port;

function client(name, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    const c = { ws, name, msgs: [], welcome: null, id: null };
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      c.msgs.push(m);
      if (m.t === 'welcome') {
        c.welcome = m;
        c.id = m.you;
        const me = m.players.find((p) => p.id === m.you);
        c.x = me.x;
        c.y = me.y;
        resolve(c);
      }
    });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, room })));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('join timeout for ' + name)), 3000);
  });
}

const send = (c, o) => c.ws.send(JSON.stringify(o));

function take(c, pred, ms = 1500) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = c.msgs.find((x) => !x._used && pred(x));
      if (m) {
        m._used = true;
        clearInterval(iv);
        resolve(m);
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error('timeout waiting for message on ' + c.name));
      }
    }, 10);
  });
}

async function none(c, pred, ms = 300) {
  await sleep(ms);
  const m = c.msgs.find((x) => !x._used && pred(x));
  assert.ok(!m, 'unexpected message ' + JSON.stringify(m));
}

async function walkTo(c, target, stop) {
  let { x, y } = c;
  while (Math.hypot(target.x - x, target.y - y) > stop) {
    const d = Math.hypot(target.x - x, target.y - y);
    x += ((target.x - x) / d) * 14;
    y += ((target.y - y) / d) * 14;
    send(c, { t: 'move', x: Math.round(x), y: Math.round(y), d: 1 });
    await sleep(50);
  }
  c.x = x;
  c.y = y;
}

function dist(c, o) {
  return Math.hypot(o.x - c.x, o.y - c.y);
}

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
  port = await server.start(0);

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
  });

  const target = A.welcome.objects
    .filter((o) => o.type !== 'plant')
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
      const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
      socks.push(ws);
      await new Promise((r) => ws.on('open', r));
    }
    const extra = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    const code = await new Promise((r) => extra.on('close', (c) => r(c)));
    assert.strictEqual(code, 1013);
    socks.forEach((s) => s.close());
  });

  console.log('\nAll ' + passed + ' checks passed');
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
