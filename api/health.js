'use strict';

// GET /api/health: tells you whether the shared store is configured.
module.exports = (req, res) => {
  const configured = Boolean(process.env.REDIS_URL || process.env.KV_URL);
  res.statusCode = configured ? 200 : 503;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ok: configured, store: configured ? 'redis' : 'missing REDIS_URL' }));
};
