'use strict';

// GET /api/rooms -> [{ id, name, online, max }] for the join screen.
// The Redis connection lives only for this request (see lib/identity-http.js for why); the CDN cache keeps requests rare.
const { createStoreFromEnv, limitsFromEnv } = require('../lib/config');
const { createRoomList } = require('../lib/room-list');
const { ROOMS } = require('../lib/world');

module.exports = async (req, res) => {
  const limits = limitsFromEnv();
  const store = limits.disabled ? null : createStoreFromEnv(process.env, { lazy: true });
  let rooms;
  try {
    rooms = await createRoomList(store, ROOMS)();
  } finally {
    await store?.close().catch(() => {});
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // let the CDN absorb bursts: at most about one store read per 10 s per region
  res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
  res.end(JSON.stringify({ rooms, disabled: limits.disabled }));
};
