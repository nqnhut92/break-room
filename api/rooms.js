'use strict';

// GET /api/rooms -> [{ id, name, online, max }] for the join screen.
const { createStoreFromEnv, limitsFromEnv } = require('../lib/config');
const { createRoomList } = require('../lib/room-list');
const { ROOMS } = require('../lib/world');

const limits = limitsFromEnv();
const store = limits.disabled ? null : createStoreFromEnv();
const list = createRoomList(store, ROOMS);

module.exports = async (req, res) => {
  const rooms = await list();
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // let the CDN absorb bursts: at most about one store read per 10 s per region
  res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
  res.end(JSON.stringify({ rooms, disabled: limits.disabled }));
};
