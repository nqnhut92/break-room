'use strict';

// Local server: serves public/ and the WebSocket at /api/ws, the same path the
// Vercel Function uses, so the client needs no environment-specific code.
// Without REDIS_URL the game state lives in this process's memory.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createRealtime, HIT_RANGE, HIT_COOLDOWN_MS, RESET_COOLDOWN_MS } = require('./lib/realtime');
const { createStoreFromEnv, renewAfterMsFromEnv, respawnMsFromEnv, limitsFromEnv } = require('./lib/config');
const { TYPES } = require('./lib/world');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const WS_PATH = '/api/ws';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function staticHandler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method not allowed');
    return;
  }

  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Không tìm thấy trang này');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// Builds one self-contained server. Tests build several on one shared store to
// act like several Vercel instances.
function createApp({ store = createStoreFromEnv(), env = process.env, ...overrides } = {}) {
  const server = http.createServer(staticHandler);
  const rt = createRealtime({
    store,
    respawnMs: respawnMsFromEnv(env),
    trustProxy: env.TRUST_PROXY === '1',
    renewAfterMs: renewAfterMsFromEnv(env),
    ...limitsFromEnv(env),
    ...overrides,
  });
  rt.attach(server, { path: WS_PATH });
  return {
    server,
    store,
    instanceId: rt.instanceId,
    start(port) {
      return new Promise((resolve) => server.listen(port, () => resolve(server.address().port)));
    },
    async stop() {
      await rt.stop();
      await new Promise((resolve) => server.close(() => resolve()));
      if (store) await store.close();
    },
  };
}

let defaultApp = null;
const start = (port) => {
  defaultApp = createApp();
  return defaultApp.start(port);
};
const stop = () => (defaultApp ? defaultApp.stop() : Promise.resolve());

if (require.main === module) {
  start(PORT).then((port) => {
    console.log('Office Rage Room đang chạy ở http://localhost:' + port);
    console.log('State phòng: ' + (process.env.REDIS_URL || process.env.KV_URL ? 'Redis' : 'RAM của tiến trình này'));
  });
  const shutdown = () => stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp, start, stop, TYPES, HIT_RANGE, HIT_COOLDOWN_MS, RESET_COOLDOWN_MS };
