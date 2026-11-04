'use strict';

const { createMemoryStore } = require('./store-memory');
const { createRedisStore } = require('./store-redis');
const { ROOMS } = require('./world');

// Shared store selection. REDIS_URL (or KV_URL, which the Upstash integration
// on Vercel sets) turns on the Redis store. Without it the game runs fully in
// this process's memory, which is correct for exactly one process, so it is
// only allowed outside Vercel.
function createStoreFromEnv(env = process.env) {
  const url = env.REDIS_URL || env.KV_URL;
  if (url) return createRedisStore(url, { roomTtlS: Number(env.ROOM_TTL_S) || 1800, ca: caFromEnv(env) });
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

// Optional PEM for providers whose TLS certificate is not signed by a public CA
// (Redis Cloud's paid plans). A literal "\n" in the value is turned into a newline.
function caFromEnv(env = process.env) {
  return env.REDIS_TLS_CA ? String(env.REDIS_TLS_CA).replace(/\\n/g, '\n') : undefined;
}

// Guard rails against a runaway bill or a forgotten tab keeping an instance (and the
// whole Hobby team's memory quota) busy. All are per instance; 0 means no limit.
function limitsFromEnv(env = process.env) {
  const onVercel = Boolean(env.VERCEL);
  return {
    afkMs: env.AFK_MS !== undefined ? Number(env.AFK_MS) : 180000, // disconnect players who do nothing for 3 minutes
    maxConnections: env.MAX_CONNECTIONS !== undefined ? Number(env.MAX_CONNECTIONS) : onVercel ? 200 : 0,
    maxRooms: env.MAX_ROOMS !== undefined ? Number(env.MAX_ROOMS) : onVercel ? 40 : 0,
    disabled: env.GAME_DISABLED === '1', // kill switch: refuse everyone, never touch Redis
    // Players can only join the rooms in lib/world.js ROOMS. FIXED_ROOMS=0 allows any room name (tests, experiments).
    rooms: env.FIXED_ROOMS === '0' ? null : ROOMS,
  };
}

function respawnMsFromEnv(env = process.env) {
  return Number(env.RESPAWN_MS) || 25000;
}

// VKL and player health. Normally untouched; handy for trying the fight quickly or switching the boss off.
//   BOSS_DISABLED=1      no boss in any room
//   BOSS_MAX_HP=300      shrink the boss
//   BOSS_RESPAWN_MS=5000 how long it stays down (default: random 3 to 5 minutes)
//   PLAYER_RESPAWN_MS    how long a knocked-out player waits (default 15 seconds)
function bossOptsFromEnv(env = process.env) {
  const o = {};
  if (env.BOSS_DISABLED === '1') o.bossEnabled = false;
  if (Number(env.BOSS_MAX_HP) > 0) o.bossMaxHp = Number(env.BOSS_MAX_HP);
  if (Number(env.BOSS_RESPAWN_MS) > 0) o.bossRespawnMs = Number(env.BOSS_RESPAWN_MS);
  if (Number(env.PLAYER_RESPAWN_MS) > 0) o.playerRespawnMs = Number(env.PLAYER_RESPAWN_MS);
  return o;
}

module.exports = { bossOptsFromEnv, createStoreFromEnv, renewAfterMsFromEnv, respawnMsFromEnv, limitsFromEnv, caFromEnv };
