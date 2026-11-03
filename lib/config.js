'use strict';

const { createMemoryStore } = require('./store-memory');
const { createRedisStore } = require('./store-redis');

// Shared store selection. REDIS_URL (or KV_URL, which the Upstash integration
// on Vercel sets) turns on the Redis store. Without it the game runs fully in
// this process's memory, which is correct for exactly one process, so it is
// only allowed outside Vercel.
function createStoreFromEnv(env = process.env) {
  const url = env.REDIS_URL || env.KV_URL;
  if (url) return createRedisStore(url, { roomTtlS: Number(env.ROOM_TTL_S) || 1800 });
  if (env.VERCEL) return null; // refuse to silently give every instance its own world
  return createMemoryStore();
}

// How long before the platform cuts a WebSocket we ask the client to move to a
// fresh connection. Hobby is capped at 300s; Pro can raise it with maxDuration
// in vercel.json plus WS_MAX_DURATION_S here. Locally there is no limit.
function renewAfterMsFromEnv(env = process.env) {
  const maxS = Number(env.WS_MAX_DURATION_S) || (env.VERCEL ? 300 : 0);
  return maxS > 0 ? Math.max(10, maxS - 25) * 1000 : 0;
}

function respawnMsFromEnv(env = process.env) {
  return Number(env.RESPAWN_MS) || 25000;
}

module.exports = { createStoreFromEnv, renewAfterMsFromEnv, respawnMsFromEnv };
