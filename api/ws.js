'use strict';

// Vercel Function that accepts the game's WebSocket connections at /api/ws.
// The default export is the http server with a WebSocketServer attached.
// It is created once per instance and reused for every connection that lands
// on that instance; all game state lives in Redis (see lib/store-redis.js).

const http = require('http');
const { createIdentity } = require('../lib/identity');
const { createPersistence } = require('../lib/persistence');
const { createRealtime } = require('../lib/realtime');
const { createStoreFromEnv, renewAfterMsFromEnv, respawnMsFromEnv, limitsFromEnv, bossOptsFromEnv } = require('../lib/config');

const limits = limitsFromEnv();
// With the kill switch on we never open a Redis connection at all.
const store = limits.disabled ? null : createStoreFromEnv();
if (!store && !limits.disabled) console.error('[break-room] REDIS_URL is not set: players will be told the server is not configured');

const server = http.createServer((req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8', Upgrade: 'websocket' });
  res.end('Endpoint này chỉ nhận kết nối WebSocket.');
});

const identity = createIdentity({ store });
const persistence = store ? createPersistence({ profiles: identity.profiles, store }) : null;
if (persistence) identity.hooks.rename = persistence.rename;

createRealtime({
  store,
  identity,
  scoreboard: persistence?.scoreboard,
  chat: persistence?.chat,
  respawnMs: respawnMsFromEnv(),
  trustProxy: true, // Vercel sets the client address headers itself
  renewAfterMs: renewAfterMsFromEnv(),
  ...limits,
  ...bossOptsFromEnv(),
}).attach(server);

module.exports = server;
module.exports.default = server;
