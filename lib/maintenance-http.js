'use strict';
// Protected operator endpoint: drains the score queue into Postgres and deletes expired data.
// Idempotent and safe to call concurrently or repeatedly (per-room locks, ledger dedupe, conditional deletes).
//   GET|POST /api/maintenance            run the job
//   GET|POST /api/maintenance?status=1   only report backlog, drops, last result, table sizes
// Auth: Authorization: Bearer <MAINTENANCE_SECRET or CRON_SECRET>, or ?key=<secret> (uptime monitors). No secret configured = endpoint disabled.

const { timingSafeEqual, createHash } = require('crypto');

const digest = (v) => createHash('sha256').update(String(v)).digest();

function maintenanceHandler({ persistence, env = process.env }) {
  const secret = env.MAINTENANCE_SECRET || env.CRON_SECRET || '';
  return async (req, res) => {
    const send = (code, body) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    };
    if (secret.length < 16) return send(503, { ok: false, error: 'maintenance disabled: set MAINTENANCE_SECRET (16+ chars)' });
    if (req.method !== 'GET' && req.method !== 'POST') return send(405, { ok: false });
    // Bearer header, or ?key= for monitors that cannot set headers (the secret then appears in URLs/logs; it only lets
    // someone run this idempotent job).
    const given = String(req.headers.authorization || '').replace(/^Bearer /, '') || new URL(req.url, 'http://x').searchParams.get('key') || '';
    if (!timingSafeEqual(digest(given), digest(secret))) return send(401, { ok: false, error: 'unauthorized' });
    if (!persistence) return send(503, { ok: false, error: 'no store' });
    try {
      if (new URL(req.url, 'http://x').searchParams.get('status') !== null) return send(200, { ok: true, ...(await persistence.status()) });
      const out = await persistence.maintain();
      send(out.errors.length ? 500 : 200, { ok: !out.errors.length, ...out });
    } catch (e) {
      send(500, { ok: false, error: String(e.message).slice(0, 200) });
    }
  };
}

module.exports = { maintenanceHandler };
