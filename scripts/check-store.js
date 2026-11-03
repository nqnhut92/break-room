'use strict';

// Checks that a Redis/Valkey service can run this game before you point production at it.
//   REDIS_URL=rediss://... npm run check:store          (optionally REDIS_TLS_CA="-----BEGIN...")
// Prints PASS/FAIL per feature and never prints the connection string. It only creates keys
// under a throw-away room name and deletes them again.

const Redis = require('ioredis');
const { createRedisStore } = require('../lib/store-redis');
const { caFromEnv } = require('../lib/config');

const url = process.env.REDIS_URL || process.env.KV_URL;
if (!url) {
  console.error('Set REDIS_URL (rediss://user:password@host:port) and run again.');
  process.exit(2);
}
const ca = caFromEnv();
const tls = /^rediss:/i.test(url);
const host = (() => {
  try {
    return new URL(url).host.replace(/^[^.]*/, '***');
  } catch (e) {
    return '(unparsable url)';
  }
})();

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push([true, name, note || '']);
    console.log('PASS  ' + name + (note ? '  (' + note + ')' : '') + '  ' + (Date.now() - t0) + 'ms');
  } catch (e) {
    results.push([false, name, String(e && e.message).slice(0, 160)]);
    console.log('FAIL  ' + name + '  -> ' + String(e && e.message).slice(0, 160));
  }
}
const mk = () => {
  const r = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 8000, retryStrategy: () => null, ...(ca ? { tls: { ca } } : {}) });
  r.on('error', () => {});
  return r;
};

(async () => {
  console.log('Target: ' + host + '   TLS: ' + (tls ? 'yes (rediss://)' : 'NO (plain redis://, password travels unencrypted)') + (ca ? '   custom CA: yes' : ''));
  const room = 'check' + Date.now().toString(36);
  const r = mk();

  await check('connect + PING', async () => {
    await r.ping();
    const info = await r.info('server');
    const v = (info.match(/(?:redis|valkey)_version:([\d.]+)/) || [])[1];
    return 'server ' + (v || 'unknown version');
  });

  await check('latency (20 PINGs)', async () => {
    const times = [];
    for (let i = 0; i < 20; i++) {
      const t = process.hrtime.bigint();
      await r.ping();
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    times.sort((a, b) => a - b);
    return 'median ' + times[10].toFixed(0) + ' ms, worst ' + times[19].toFixed(0) + ' ms';
  });

  await check('SET with expiry / GET', async () => {
    await r.set('br:check:' + room, 'x', 'EX', 60);
    if ((await r.get('br:check:' + room)) !== 'x') throw new Error('read back a different value');
    await r.del('br:check:' + room);
  });

  await check('Lua scripting (EVAL / EVALSHA)', async () => {
    r.defineCommand('brcheck', { numberOfKeys: 1, lua: "redis.call('HSET', KEYS[1], 'a', ARGV[1]); return redis.call('HGET', KEYS[1], 'a')" });
    const out = await r.brcheck('br:check:lua' + room, '42');
    await r.del('br:check:lua' + room);
    if (String(out) !== '42') throw new Error('script returned ' + out);
  });

  await check('pub/sub (SUBSCRIBE + PUBLISH round trip)', async () => {
    const sub = mk();
    const got = [];
    sub.on('message', (c, m) => got.push(m));
    await sub.subscribe('br:check:ch' + room);
    await sleep(100);
    await r.publish('br:check:ch' + room, 'hello');
    for (let i = 0; i < 30 && !got.length; i++) await sleep(50);
    sub.disconnect();
    if (got[0] !== 'hello') throw new Error('message was not delivered');
  });

  await check('20 simultaneous connections', async () => {
    const conns = Array.from({ length: 20 }, mk);
    await Promise.all(conns.map((c) => c.ping()));
    conns.forEach((c) => c.disconnect());
  });

  await check("the game's own store (join, hit, snapshot, housekeeping, reset)", async () => {
    const store = createRedisStore(url, { log: () => {}, ca });
    const now = Date.now();
    const base = { name: 'Check', fallbackName: 'N', now, max: 5, ttlMs: 5000, spawn: { x: 1, y: 2 } };
    try {
      const a = await store.join(room, { ...base, token: 'checktoken000000000001', connId: 'chk-1' });
      const hit = await store.hit(room, { objId: 1, defaultHp: 1, cost: 2, playerId: a.id, now });
      if (hit.state !== 'broke') throw new Error('hit did not break the object: ' + JSON.stringify(hit));
      const snap = await store.read(room, { now, ttlMs: 5000 });
      if (snap.total !== 2 || snap.players.length !== 1) throw new Error('snapshot is wrong: ' + JSON.stringify(snap).slice(0, 100));
      const hk = await store.housekeep(room, { now: now + 2000, ttlMs: 5000, respawnMs: 1000, sweep: true, entries: [], instanceId: 'chk' });
      if (hk.respawned.join() !== '1') throw new Error('respawn sweep failed');
      const rs = await store.reset(room, { now, cooldownMs: 1000 });
      if (!rs.ok) throw new Error('reset failed');
    } finally {
      await store.close();
    }
  });

  // remove everything this script created
  const tag = 'br:{' + room + '}:';
  await r.del(...['o', 'sc', 'bk', 'nm', 'tok', 'meta', 'on', 'own', 'pos'].map((k) => tag + k)).catch(() => {});
  r.disconnect();

  const failed = results.filter((x) => !x[0]);
  console.log('\n' + (failed.length ? failed.length + ' check(s) FAILED: ' + failed.map((x) => x[1]).join('; ') : 'All ' + results.length + ' checks passed.'));
  if (!tls) console.log('Note: this connection is not encrypted. Use a unique password for this database only.');
  process.exit(failed.length ? 1 : 0);
})();
