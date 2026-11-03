'use strict';

// The room list for the join screen: fixed rooms plus how many players are in each.
// Counting costs one store command, so results are cached briefly per process, and the
// HTTP endpoints also let the CDN cache them. A visitor staring at the join screen
// therefore cannot turn into Redis traffic.

const { ROOMS } = require('./world');
const { MAX_PLAYERS_PER_ROOM, PRESENCE_TTL_MS } = require('./realtime');

const CACHE_MS = 10000;

function createRoomList(store, rooms = ROOMS) {
  let cached = null;
  let at = 0;
  let pending = null;

  async function load() {
    let counts = rooms.map(() => 0);
    if (store) {
      try {
        counts = await store.online(rooms.map((r) => r.id), { now: Date.now(), ttlMs: PRESENCE_TTL_MS });
      } catch (e) {
        /* show the rooms with zero players rather than failing the join screen */
      }
    }
    return rooms.map((r, i) => ({ id: r.id, name: r.name, online: counts[i] || 0, max: MAX_PLAYERS_PER_ROOM }));
  }

  return async function list() {
    const now = Date.now();
    if (cached && now - at < CACHE_MS) return cached;
    if (!pending) {
      pending = load().then((v) => {
        cached = v;
        at = Date.now();
        pending = null;
        return v;
      });
    }
    return pending;
  };
}

module.exports = { createRoomList };
