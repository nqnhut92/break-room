'use strict';

// In-process store. Same contract as store-redis.js, but everything lives in
// this process's RAM. Good for `npm start` and tests; on Vercel it would split
// the world per instance, so the server refuses to use it there.

const ROOM_TTL_MS = 30 * 60 * 1000;

function createMemoryStore() {
  const rooms = new Map();
  const handlers = new Map(); // room -> fn(str)
  const ipConns = new Map(); // ip -> Map(connId -> expiresAt)
  let closed = false;

  function roomOf(name, now) {
    let r = rooms.get(name);
    if (!r) {
      r = {
        obj: new Map(), // id -> { hp, brokenAt }
        score: new Map(),
        breaks: new Map(),
        names: new Map(),
        tok: new Map(),
        meta: { nextid: 0, total: 0, lastReset: 0 },
        on: new Map(), // id -> last seen
        own: new Map(), // id -> connId
        pos: new Map(), // id -> { x, y, d }
        expires: 0,
      };
      rooms.set(name, r);
    }
    r.expires = now + ROOM_TTL_MS;
    return r;
  }

  function gc(now) {
    for (const [name, r] of rooms) if (r.expires < now) rooms.delete(name);
  }

  function prune(r, now, ttlMs) {
    const pruned = [];
    for (const [id, seen] of r.on) {
      if (seen <= now - ttlMs) {
        r.on.delete(id);
        r.own.delete(id);
        pruned.push(id);
      }
    }
    return pruned;
  }

  return {
    kind: 'memory',
    rooms,

    async join(room, { token, name, fallbackName, connId, now, max, ttlMs, spawn }) {
      gc(now);
      const r = roomOf(room, now);
      const pruned = prune(r, now, ttlMs);
      let id = r.tok.get(token);
      if (!(id && r.on.has(id)) && r.on.size >= max) return { full: true };
      if (!id) {
        id = ++r.meta.nextid;
        r.tok.set(token, id);
      }
      const prevConn = r.own.get(id) || '';
      r.own.set(id, connId);
      r.on.set(id, now);
      if (name) r.names.set(id, name);
      else if (!r.names.has(id)) r.names.set(id, fallbackName + id);
      if (!r.pos.has(id)) r.pos.set(id, { x: spawn.x, y: spawn.y, d: 1 });
      return { id, prevConn, pos: { ...r.pos.get(id) }, pruned };
    },

    async leave(room, id, connId, pos, now) {
      const r = rooms.get(room);
      if (!r || r.own.get(id) !== connId) return false;
      r.own.delete(id);
      r.on.delete(id);
      if (pos) r.pos.set(id, { x: pos.x, y: pos.y, d: pos.d });
      r.expires = now + ROOM_TTL_MS;
      return true;
    },

    async housekeep(room, { now, ttlMs, respawnMs, sweep, entries }) {
      const r = roomOf(room, now);
      for (const e of entries) {
        const cur = r.own.get(e.id);
        if (cur === undefined || cur === e.connId) {
          r.own.set(e.id, e.connId);
          r.on.set(e.id, now);
          if (e.pos) r.pos.set(e.id, { x: e.pos.x, y: e.pos.y, d: e.pos.d });
        }
      }
      const pruned = prune(r, now, ttlMs);
      const respawned = [];
      let remaining = 0;
      if (sweep) {
        for (const [id, s] of r.obj) {
          if (s.brokenAt > 0) {
            if (now - s.brokenAt >= respawnMs) {
              r.obj.delete(id);
              respawned.push(id);
            } else remaining++;
          }
        }
      }
      return { remaining, others: 0, pruned, respawned }; // a memory store is one process: no other instances
    },

    async read(room, { now, ttlMs }) {
      const r = roomOf(room, now);
      const players = [];
      for (const [id, seen] of r.on) {
        if (seen <= now - ttlMs) continue;
        const p = r.pos.get(id) || { x: 640, y: 360, d: 1 };
        players.push({
          id,
          name: r.names.get(id) || 'Nhân viên ' + id,
          x: p.x,
          y: p.y,
          d: p.d,
          score: r.score.get(id) || 0,
          breaks: r.breaks.get(id) || 0,
        });
      }
      const objects = {};
      for (const [id, s] of r.obj) objects[id] = { hp: s.hp, brokenAt: s.brokenAt };
      return { players, objects, total: r.meta.total };
    },

    async hit(room, { objId, defaultHp, cost, playerId, now }) {
      const r = roomOf(room, now);
      const s = r.obj.get(objId) || { hp: defaultHp, brokenAt: 0 };
      if (s.brokenAt > 0) return { state: 'none' };
      s.hp -= 1;
      if (s.hp > 0) {
        r.obj.set(objId, s);
        return { state: 'hit', hp: s.hp };
      }
      s.hp = 0;
      s.brokenAt = now;
      r.obj.set(objId, s);
      r.meta.total += cost;
      r.score.set(playerId, (r.score.get(playerId) || 0) + cost);
      r.breaks.set(playerId, (r.breaks.get(playerId) || 0) + 1);
      return { state: 'broke', hp: 0 };
    },

    async reset(room, { now, cooldownMs }) {
      const r = roomOf(room, now);
      if (now - r.meta.lastReset < cooldownMs) {
        return { ok: false, waitMs: cooldownMs - (now - r.meta.lastReset) };
      }
      r.meta.lastReset = now;
      r.obj.clear();
      return { ok: true, waitMs: 0 };
    },

    async online(rooms, { now, ttlMs }) {
      return rooms.map((name) => {
        const r = this.rooms.get(name);
        if (!r) return 0;
        let n = 0;
        for (const seen of r.on.values()) if (seen > now - ttlMs) n++;
        return n;
      });
    },

    async acquireConn(ip, connId, { max, ttlMs, now }) {
      let m = ipConns.get(ip);
      if (!m) {
        m = new Map();
        ipConns.set(ip, m);
      }
      for (const [c, exp] of m) if (exp <= now) m.delete(c);
      if (m.size >= max) return false;
      m.set(connId, now + ttlMs);
      return true;
    },

    async touchConns(entries, { ttlMs, now }) {
      for (const e of entries) {
        const m = ipConns.get(e.ip);
        if (m && m.has(e.connId)) m.set(e.connId, now + ttlMs);
      }
    },

    async releaseConn(ip, connId) {
      const m = ipConns.get(ip);
      if (!m) return;
      m.delete(connId);
      if (m.size === 0) ipConns.delete(ip);
    },

    async subscribe(room, handler) {
      handlers.set(room, handler);
    },

    async unsubscribe(room) {
      handlers.delete(room);
    },

    async publish(room, str) {
      const h = handlers.get(room);
      if (h && !closed) setImmediate(() => h(str));
    },

    async close() {
      closed = true;
      handlers.clear();
    },
  };
}

module.exports = { createMemoryStore };
