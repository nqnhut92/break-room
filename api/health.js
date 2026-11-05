'use strict';

// GET /api/health          tells you whether a shared store is configured (no network call).
// GET /api/health?deep=KEY does a real round trip to Redis (PING), which also counts as
//                          activity: free Redis plans delete a database that sees no commands
//                          for ~2 weeks, so point an uptime monitor at this once a day.
// If HEALTH_KEY is set, KEY must match it, so strangers cannot make the app open connections.

const Redis = require('ioredis');
const { caFromEnv } = require('../lib/config');
const { ROOMS } = require('../lib/world');

module.exports = async (req, res) => {
  const url = process.env.REDIS_URL || process.env.KV_URL;
  const send = (code, body) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };

  if (process.env.GAME_DISABLED === '1') return send(503, { ok: false, store: 'disabled (GAME_DISABLED=1)' });
  if (!url) return send(503, { ok: false, store: 'missing REDIS_URL' });

  const deep = new URL(req.url || '/', 'http://x').searchParams.get('deep');
  if (deep === null) return send(200, { ok: true, store: 'redis' });
  if (process.env.HEALTH_KEY && deep !== process.env.HEALTH_KEY) return send(401, { ok: false, error: 'bad key' });

  const ca = caFromEnv();
  const r = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    retryStrategy: () => null,
    ...(ca ? { tls: { ca } } : {}),
  });
  r.on('error', () => {});
  const t0 = Date.now();
  try {
    await r.connect();
    await r.set('br:keepalive', String(Date.now()), 'EX', 3 * 24 * 3600);
    await r.ping();
    // Unsynced score events per room: a growing len with an old syncAt means nothing is draining the queue
    // (run the maintenance job, see docs/DEPLOYMENT.md); dropped > 0 means points were NOT queued (queue full).
    const queue = {};
    for (const room of ROOMS) {
      const [len, qs] = await Promise.all([r.llen('br:{' + room.id + '}:evq'), r.hgetall('br:{' + room.id + '}:qs')]);
      queue[room.id] = { len, dropped: Number(qs.dropped || 0), syncAt: Number(qs.syncAt || 0), err: qs.err || undefined };
    }
    send(200, { ok: true, store: 'redis', pingMs: Date.now() - t0, queue });
  } catch (e) {
    send(503, { ok: false, store: 'redis unreachable', error: String(e && e.message).slice(0, 120) });
  } finally {
    r.disconnect();
  }
};
