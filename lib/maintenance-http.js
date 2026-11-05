'use strict';
// Protected operator endpoint: drains the score queue into Postgres and deletes expired data.
// Idempotent and safe to call concurrently or repeatedly (per-room locks, ledger dedupe, conditional deletes).
//   GET|POST|HEAD /api/maintenance       run the job
//   GET|POST /api/maintenance?status=1   only report backlog, drops, last result, table sizes
// Auth: Authorization: Bearer <MAINTENANCE_SECRET, CRON_SECRET or, failing those, HEALTH_KEY>, or ?key=<secret> (uptime monitors). No secret configured (8+ chars) = endpoint disabled.

const { timingSafeEqual, createHash } = require('crypto');

const digest = (v) => createHash('sha256').update(String(v)).digest();

// `open` (optional) builds the persistence on demand and returns { persistence, close }: serverless callers use it so no Redis or
// Postgres connection exists unless the key was right, and none outlives the request (connections of frozen instances leak).
function maintenanceHandler({ persistence, open, env = process.env }) {
  const secret = env.MAINTENANCE_SECRET || env.CRON_SECRET || env.HEALTH_KEY || '';
  return async (req, res) => {
    const send = (code, body) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    };
    if (secret.length < 8) return send(503, { ok: false, error: 'maintenance disabled: set HEALTH_KEY or MAINTENANCE_SECRET (8+ chars)' });
    // HEAD runs the job too: uptime monitors often probe with HEAD and ignore the body.
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') return send(405, { ok: false });
    // Bearer header, or ?key= for monitors that cannot set headers (the secret then appears in URLs/logs; it only lets
    // someone run this idempotent job).
    const given = String(req.headers.authorization || '').replace(/^Bearer /, '') || new URL(req.url, 'http://x').searchParams.get('key') || '';
    if (!timingSafeEqual(digest(given), digest(secret))) return send(401, { ok: false, error: 'unauthorized' });
    let session = null;
    try {
      session = open ? await open() : { persistence, close: async () => {} };
      if (!session || !session.persistence) return send(503, { ok: false, error: 'no store' });
      if (new URL(req.url, 'http://x').searchParams.get('status') !== null) return send(200, { ok: true, ...(await session.persistence.status()) });
      const out = await session.persistence.maintain();
      send(out.errors.length ? 500 : 200, { ok: !out.errors.length, ...out });
    } catch (e) {
      send(500, { ok: false, error: String(e.message).slice(0, 200) });
    } finally {
      if (session) await session.close().catch(() => {});
    }
  };
}

module.exports = { maintenanceHandler };
