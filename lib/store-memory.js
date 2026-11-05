'use strict';

// In-process store. Same contract as store-redis.js, but everything lives in
// this process's RAM. Good for `npm start` and tests; on Vercel it would split
// the world per instance, so the server refuses to use it there.

const context = require('./identity-context');
const { nameKey: canonicalName } = require('./profiles');
const { emptyDuel } = require('./duel');
const { objectRespawnMs } = require('./object-respawn');

const ROOM_TTL_MS = 30 * 60 * 1000;

const hpFields = (h) => (h ? { hp: h.hp, hpAt: h.at, deadUntil: h.deadUntil } : { hp: null, hpAt: 0, deadUntil: 0 });

function createMemoryStore() {
  const rooms = new Map();
  const handlers = new Map(); // room -> fn(str)
  const ipConns = new Map(); // ip -> Map(connId -> expiresAt)
  let closed = false;

  function roomOf(name, now) {
    let r = rooms.get(name);
    if (!r) {
      r = {
        snakes: new Map(),
        moles: new Map(), // id -> { hp, rev }
        rage: new Map(), // id -> the ultimate bar
        deaths: new Map(), // id -> times knocked out
        obj: new Map(), // id -> { hp, brokenAt }
        score: new Map(),
        breaks: new Map(),
        names: new Map(),
        genders: new Map(),
        roles: new Map(),
        companies: new Map(),
        hps: new Map(), // id -> { hp, at, deadUntil }
        boss: { hp: null, at: 0, dead: false, respawnAt: 0, lockId: '', lockUntil: 0 },
        bdmg: new Map(), // player id -> damage dealt to the current boss
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

  const api = {
    kind: 'memory',
    rooms,
    async tokenId(room, token) { return rooms.get(room)?.tok.get(token) || null; },
    async isOwner(room, id, conn) { const r=rooms.get(room); return r?.own.get(id) === conn && r.on.get(id) > Date.now()-20000; },
    async tokenOnline(room, token) { const r = rooms.get(room); const id = r?.tok.get(token); return !!(id && r.on.has(id) && r.on.get(id) > Date.now()-20000); },

    async join(room, { token, name, fallbackName, connId, now, max, ttlMs, spawn, gender = '', role = '', company = '', nameKey }) {
      gc(now);
      const r = roomOf(room, now);
      const pruned = prune(r, now, ttlMs);
      let id = r.tok.get(token);
      if (!(id && r.on.has(id)) && r.on.size >= max) return { full: true };
      if (name) {
        // exact, case-sensitive: another player who is online right now already uses this name
        for (const other of r.on.keys()) if (other !== id && (nameKey ? canonicalName(r.names.get(other)) === nameKey : r.names.get(other) === name)) return { taken: true };
      }
      if (!id) {
        id = ++r.meta.nextid;
        r.tok.set(token, id);
      }
      const prevConn = r.own.get(id) || '';
      r.own.set(id, connId);
      r.on.set(id, now);
      if (name) r.names.set(id, name);
      else if (!r.names.has(id)) r.names.set(id, fallbackName + id);
      if (gender) r.genders.set(id, gender);
      if (role) r.roles.set(id, role);
      if (company) r.companies.set(id, company);
      else r.companies.delete(id);
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

    async housekeep(room, { now, ttlMs, respawnMs = 0, sweep, entries, strictPresence = false }) {
      const r = roomOf(room, now);
      for (const e of entries) {
        const cur = r.own.get(e.id);
        if ((cur === undefined || cur === e.connId) && (!strictPresence || (cur === e.connId && r.on.get(e.id) > now - ttlMs))) {
          r.own.set(e.id, e.connId);
          r.on.set(e.id, now);
          if (e.pos) r.pos.set(e.id, { x: e.pos.x, y: e.pos.y, d: e.pos.d });
        }
      }
      const pruned = prune(r, now, ttlMs);
      // compaction (same rule as the Redis script): forget offline players who never scored
      if (now - (r.meta.lastCompact || 0) >= 120000) {
        r.meta.lastCompact = now;
        for (const [token, id] of [...r.tok]) {
          if (!r.on.has(id) && !r.score.has(id)) {
            r.tok.delete(token);
            r.names.delete(id);
            r.genders.delete(id);
            r.roles.delete(id);
            r.companies.delete(id);
            r.hps.delete(id);
            r.pos.delete(id);
            r.own.delete(id);
          }
        }
      }
      const respawned = [];
      let remaining = 0;
      if (sweep) {
        const broken = [...r.obj].filter(([, s]) => s.brokenAt > 0);
        const humans = [...r.on.keys()].filter(id => !r.moles.has(id)).length;
        const delay = objectRespawnMs(humans, broken.length, respawnMs);
        // Freeze the count for this sweep: earlier respawns must not delay later ones.
        for (const [id, s] of broken) {
          if (now - s.brokenAt >= delay) {
            r.obj.delete(id);
            respawned.push(id);
          } else remaining++;
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
          gender: r.genders.get(id) === 'f' ? 'f' : 'm',
          role: r.roles.get(id) || 'nv',
          company: r.companies.get(id) || '',
          ...hpFields(r.hps.get(id)),
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

    async hit(room, { objId, defaultHp, cost, playerId, now, dmg = 1 }) {
      const r = roomOf(room, now);
      const s = r.obj.get(objId) || { hp: defaultHp, brokenAt: 0 };
      if (s.brokenAt > 0) return { state: 'none' };
      s.hp -= dmg;
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

    // ---- player health (survives reconnects, so a refresh does not heal or revive anyone)
    async setHp(room, id, { hp, at, deadUntil }) {
      roomOf(room, at).hps.set(id, { hp, at, deadUntil });
    },

    // ---- the room's boss. hp is stored with the time it was stored; regeneration is computed by the reader.
    async bossGet(room, { now, maxHp }) {
      const b = roomOf(room, now).boss;
      return { hp: b.hp === null ? maxHp : b.hp, at: b.hp === null ? now : b.at, dead: b.dead, respawnAt: b.respawnAt };
    },

    // One hit on the boss, atomically. cfg = { maxHp, baseRegenPerSec, regenPerSec, regenDelayMs }.
    async bossHit(room, { playerId, dmg, now, cfg, respawnAt, bounty }) {
      const r = roomOf(room, now);
      const b = r.boss;
      if (b.dead) return { state: 'dead' };
      let hp = b.hp === null ? cfg.maxHp : b.hp;
      const at = b.hp === null ? now : b.at;
      const e = Math.max(0, now - at);
      hp = Math.min(cfg.maxHp, hp + (e * cfg.baseRegenPerSec + Math.max(0, e - cfg.regenDelayMs) * cfg.regenPerSec) / 1000);
      r.bdmg.set(playerId, (r.bdmg.get(playerId) || 0) + Math.min(dmg, hp));
      hp -= dmg;
      if (hp > 0) {
        b.hp = hp;
        b.at = now;
        return { state: 'hit', hp, at: now };
      }
      b.hp = 0;
      b.at = now;
      b.dead = true;
      b.respawnAt = respawnAt;
      let total = 0;
      for (const d of r.bdmg.values()) total += d;
      const shares = [];
      for (const [id, d] of r.bdmg) {
        const bountyShare = Math.round(((bounty * d) / total) * 10) / 10;
        r.score.set(id, (r.score.get(id) || 0) + bountyShare);
        shares.push({ id, dmg: d, bounty: bountyShare });
      }
      r.meta.total += bounty;
      return { state: 'killed', shares };
    },

    async summonSnakes(room, { maxHp, count, finalCount = count, x, y, now }) {
      const r = roomOf(room, now), b = r.boss;
      const waves = [], snakes = [];
      if (b.dead || b.hp === null) return { waves, snakes };
      b.snakeWaves = b.snakeWaves || [];
      for (const percent of [70, 40, 10]) {
        if (b.hp > maxHp * percent / 100 || b.snakeWaves.includes(percent)) continue;
        b.snakeWaves.push(percent); waves.push(percent);
        const waveCount = percent === 10 ? finalCount : count;
        for (let i = 0; i < waveCount; i++) {
          const a = i / Math.max(1, waveCount) * Math.PI * 2;
          const snake = { id: r.meta.snakeNext = (r.meta.snakeNext || 0) + 1, x: x + Math.cos(a) * 48, y: y + Math.sin(a) * 48, d: a, hp: 4, variant: percent === 10 ? 'red' : 'green' };
          r.snakes.set(snake.id, snake); snakes.push({ ...snake });
        }
      }
      return { waves, snakes };
    },
    async snakeList(room, { now }) { return [...roomOf(room, now).snakes.values()].map(s => ({ ...s })); },
    async snakeMove(room, list, now) {
      const r = roomOf(room, now);
      for (const p of list) { const s = r.snakes.get(p.id); if (s) { s.x = p.x; s.y = p.y; s.d = p.d; } }
    },
    async snakeHit(room, id, now) {
      const r = roomOf(room, now), s = r.snakes.get(id);
      if (!s) return null;
      s.hp = Math.max(0, s.hp - 1);
      if (!s.hp) r.snakes.delete(id);
      return { ...s };
    },

    async deathAdd(room, id, now) { const m = roomOf(room, now).deaths; m.set(id, (m.get(id) || 0) + 1); },
    async deathList(room, now) { return [...roomOf(room, now).deaths].map(([id, n]) => ({ id, n })); },
    async rageSet(room, id, v, now) { roomOf(room, now).rage.set(id, v); },
    async rageGet(room, id) { return rooms.has(room) ? rooms.get(room).rage.get(id) || 0 : 0; },

    // ---- moles: fake players the server drives (see lib/moles.js). The secret lives here, never on the wire until revealed.
    async moleAdd(room, id, { hp, conn, now }) { roomOf(room, now).moles.set(id, { hp, rev: false, conn }); },
    async moleList(room, { now }) { return [...roomOf(room, now).moles].map(([id, m]) => ({ id, hp: m.hp, revealed: m.rev, conn: m.conn })); },
    async moleReveal(room, id, now) { const m = roomOf(room, now).moles.get(id); if (m) m.rev = true; },
    async moleDel(room, id, now) { roomOf(room, now).moles.delete(id); },
    // One hit on a mole. Hitting it gives it away. When it dies the hitter gets the bounty, like for any broken object.
    async moleHit(room, { id, dmg, cost, playerId, now }) {
      const r = roomOf(room, now), m = r.moles.get(id);
      if (!m) return { state: 'none' };
      m.rev = true;
      m.hp -= dmg;
      if (m.hp > 0) return { state: 'hit', hp: m.hp };
      r.moles.delete(id);
      r.meta.total += cost;
      r.score.set(playerId, (r.score.get(playerId) || 0) + cost);
      r.breaks.set(playerId, (r.breaks.get(playerId) || 0) + 1);
      return { state: 'killed', hp: 0 };
    },

    // Brings the boss back once its time is up. true for exactly one caller.
    async bossRespawn(room, { now, maxHp }) {
      const r = roomOf(room, now);
      if (!r.boss.dead || now < r.boss.respawnAt) return false;
      r.boss.dead = false;
      r.boss.hp = maxHp;
      r.boss.at = now;
      r.bdmg.clear();
      r.boss.snakeWaves = [];
      r.snakes.clear();
      return true;
    },

    // Only one instance at a time runs the boss of a room: whoever holds this lease. Renewed by the holder.
    async bossLock(room, id, { now, ttlMs }) {
      const b = roomOf(room, now).boss;
      if (b.lockId && b.lockId !== id && b.lockUntil > now) return false;
      b.lockId = id;
      b.lockUntil = now + ttlMs;
      return true;
    },

    async miniGet(room, { now }) {
      return structuredClone(roomOf(room, now).mini || { version: 0, list: [] });
    },
    async miniSave(room, { now, owner = '', expected, state, shares = [] }) {
      const r = roomOf(room, now), b = r.boss;
      if ((owner && (b.lockId !== owner || b.lockUntil <= now)) || (r.mini?.version || 0) !== expected) return false;
      r.mini = structuredClone(state);
      for (const s of shares) {
        r.score.set(s.id, (r.score.get(s.id) || 0) + s.bounty);
        r.meta.total += s.bounty;
      }
      return true;
    },

    async duelGet(room, { now }) {
      return structuredClone(roomOf(room, now).boss.duel || emptyDuel());
    },
    async duelSave(room, { owner, now, expected, state }) {
      const r = roomOf(room, now), b = r.boss;
      if (b.lockId !== owner || b.lockUntil <= now || (b.duel?.version || 0) !== expected || (b.dead && state.target)) return false;
      b.duel = structuredClone(state);
      for (const m of state.moves) r.pos.set(m.id, { x: m.x, y: m.y, d: 1 });
      return true;
    },

    async drinkOffer(room, { now, intervalMs, windowMs, claim = false, offerId }) {
      const meta = roomOf(room, now).meta;
      if (!meta.drinkAt) meta.drinkAt = now + intervalMs;
      if (now >= meta.drinkAt + windowMs) {
        meta.drinkAt += Math.floor((now - meta.drinkAt) / intervalMs) * intervalMs;
        if (now >= meta.drinkAt + windowMs) meta.drinkAt += intervalMs;
      }
      const id = meta.drinkAt;
      const available = now >= id && now < id + windowMs && meta.drinkClaimed !== id;
      const claimed = available && claim && offerId === id;
      if (claimed) meta.drinkClaimed = id;
      return { id, available: available && !claimed, claimed, endsAt: id + windowMs, nextAt: now < id ? id : id + intervalMs };
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
  return new Proxy(api, { get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') return value;
    return (...args) => {
      const ctx = context.getStore();
      if (ctx && (rooms.get(ctx.room)?.own.get(ctx.id) !== ctx.conn || !(rooms.get(ctx.room)?.on.get(ctx.id) > Date.now()-20000) || !ctx.valid())) return Promise.reject(Error('stale connection'));
      return value.apply(target, args);
    };
  } });
}

module.exports = { createMemoryStore };
