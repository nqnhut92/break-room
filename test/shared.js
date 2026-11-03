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

  await step(label + ': room capacity is enforced, existing players can still rejoin', async () => {
    await store.join(room, { ...base, token: T(3), connId: 'c5' });
    const full = await store.join(room, { ...base, token: T(4), connId: 'c6' });
    assert.strictEqual(full.full, true);
    const again = await store.join(room, { ...base, token: T(2), connId: 'c7' });
    assert.ok(again.id);
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

  await step(label + ': housekeeping respawns broken objects and prunes dead players', async () => {
    const r3 = room + '-hk';
    await store.hit(r3, { objId: 1, defaultHp: 1, cost: 2, playerId: 1, now: NOW });
    let hk = await store.housekeep(r3, { now: NOW + 500, ttlMs: 5000, respawnMs: 1000, sweep: true, entries: [] });
    assert.deepStrictEqual([hk.remaining, hk.respawned], [1, []]);
    hk = await store.housekeep(r3, { now: NOW + 1500, ttlMs: 5000, respawnMs: 1000, sweep: true, entries: [] });
    assert.deepStrictEqual([hk.remaining, hk.respawned], [0, [1]]);
    assert.strictEqual((await store.read(r3, { now: NOW, ttlMs: 5000 })).objects[1], undefined);

    const j = await store.join(r3, { ...base, token: T(9), connId: 'x1', now: NOW });
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
    const j1 = await store.join(r5, { ...base, token: T(21), connId: 'instA-1', now: NOW });
    await store.join(r5, { ...base, token: T(22), connId: 'instB-1', now: NOW });
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
    const a = await store.join(rA, { ...base, token: T(41), connId: 'o1', now: NOW });
    await store.join(rA, { ...base, token: T(42), connId: 'o2', now: NOW });
    await store.join(rB, { ...base, token: T(43), connId: 'o3', now: NOW });
    const o = { now: NOW + 100, ttlMs: 5000 };
    assert.deepStrictEqual(await store.online([rA, rB, room + '-none'], o), [2, 1, 0]);
    await store.leave(rA, a.id, 'o1', null, NOW);
    assert.deepStrictEqual(await store.online([rA, rB], o), [1, 1]);
    // players whose heartbeat stopped do not count
    assert.deepStrictEqual(await store.online([rA, rB], { now: NOW + 9000, ttlMs: 5000 }), [0, 0]);
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

// ------------------------------------------------------- two instances ----
async function twoInstances(url) {
  const quiet = () => {};
  const mk = () =>
    server.createApp({ store: createRedisStore(url, { log: quiet }), presenceTtlMs: 2500, log: quiet });
  const app1 = mk();
  const app2 = mk();
  // spawn next to the pantry so the walk-and-hit steps are short
  world.WORLD.spawn = { x: 3140, y: 330, rx: 0, ry: 0 };
  const p1 = await app1.start(0);
  const p2 = await app2.start(0);
  const room = 'shared-' + Date.now();
  const mon = new Redis(url);
  const publishCalls = async () => {
    const t = await mon.info('commandstats');
    return Number((t.match(/cmdstat_publish:calls=(\d+)/) || [])[1] || 0);
  };
  const closeAll = (...cs) => cs.forEach((c) => c.ws.readyState < 2 && c.ws.close());

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
