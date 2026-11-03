'use strict';

// Redis-backed store: the single source of truth that every Vercel instance
// shares. Each mutating operation is one Lua script, so concurrent hits from
// different instances are applied atomically (an object can only break once and
// the score is credited exactly once).
//
// Keys for a room all share the hash tag {room}, so they live in one cluster
// slot, and every script receives all nine keys in the same order.
//
//   o     hash  object id -> "hp:brokenAt"   (absent = full health)
//   sc    hash  player id -> score
//   bk    hash  player id -> number of objects broken
//   nm    hash  player id -> display name
//   tok   hash  client token -> player id    (lets a reconnect keep its id/score)
//   meta  hash  nextid, total, lastReset
//   on    zset  player id -> last heartbeat ms (presence; stale entries expire)
//   own   hash  player id -> id of the websocket connection that owns the slot
//   pos   hash  player id -> "x,y,d"         (last persisted position)

const Redis = require('ioredis');

const PRELUDE = `
local O, SC, BK, NM, TOK, META, ON, OWN, POS =
  KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7], KEYS[8], KEYS[9]
local function touch(ttl)
  for i = 1, 9 do redis.call('EXPIRE', KEYS[i], ttl) end
end
local function prune(now, ttl)
  local stale = redis.call('ZRANGEBYSCORE', ON, '-inf', string.format('%d', now - ttl))
  for _, id in ipairs(stale) do
    redis.call('ZREM', ON, id)
    redis.call('HDEL', OWN, id)
  end
  return stale
end
`;

// ARGV: token, name, fallbackName, connId, now, max, ttlMs, spawnX, spawnY, roomTtlS
const JOIN = `${PRELUDE}
local now, max, ttl = tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(ARGV[7])
local pruned = prune(now, ttl)
local id = redis.call('HGET', TOK, ARGV[1])
local present = false
if id then present = redis.call('ZSCORE', ON, id) end
if not present and redis.call('ZCARD', ON) >= max then return {'full'} end
if not id then
  id = tostring(redis.call('HINCRBY', META, 'nextid', 1))
  redis.call('HSET', TOK, ARGV[1], id)
end
local prev = redis.call('HGET', OWN, id) or ''
redis.call('HSET', OWN, id, ARGV[4])
redis.call('ZADD', ON, string.format('%d', now), id)
if ARGV[2] ~= '' then
  redis.call('HSET', NM, id, ARGV[2])
elseif redis.call('HEXISTS', NM, id) == 0 then
  redis.call('HSET', NM, id, ARGV[3] .. id)
end
local pos = redis.call('HGET', POS, id)
if not pos then
  pos = ARGV[8] .. ',' .. ARGV[9] .. ',1'
  redis.call('HSET', POS, id, pos)
end
touch(ARGV[10])
local res = {'ok', id, prev, pos}
for _, p in ipairs(pruned) do res[#res + 1] = p end
return res
`;

// ARGV: id, connId, pos ('' = leave unchanged), roomTtlS
const LEAVE = `${PRELUDE}
local cur = redis.call('HGET', OWN, ARGV[1])
if cur ~= ARGV[2] then return 0 end
redis.call('HDEL', OWN, ARGV[1])
redis.call('ZREM', ON, ARGV[1])
if ARGV[3] ~= '' then redis.call('HSET', POS, ARGV[1], ARGV[3]) end
touch(ARGV[4])
return 1
`;

// ARGV: now, ttlMs, respawnMs, sweep (0/1), roomTtlS, instanceId, then (id, connId, pos) triples
// returns { remainingBroken, playersOnOtherInstances, #pruned, ...pruned, ...respawned }
const HOUSEKEEP = `${PRELUDE}
local now, ttl, respawn = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
for i = 7, #ARGV, 3 do
  local id, conn, pos = ARGV[i], ARGV[i + 1], ARGV[i + 2]
  local cur = redis.call('HGET', OWN, id)
  if (not cur) or cur == conn then
    redis.call('HSET', OWN, id, conn)
    redis.call('ZADD', ON, string.format('%d', now), id)
    if pos ~= '' then redis.call('HSET', POS, id, pos) end
  end
end
local pruned = prune(now, ttl)
local others = 0
local prefix = ARGV[6] .. '-'
for _, v in ipairs(redis.call('HVALS', OWN)) do
  if string.sub(v, 1, #prefix) ~= prefix then others = others + 1 end
end
local respawned = {}
local remaining = 0
if ARGV[4] == '1' then
  local all = redis.call('HGETALL', O)
  for i = 1, #all, 2 do
    local b = tonumber(string.match(all[i + 1], ':(%d+)$'))
    if b and b > 0 then
      if now - b >= respawn then
        redis.call('HDEL', O, all[i])
        respawned[#respawned + 1] = all[i]
      else
        remaining = remaining + 1
      end
    end
  end
end
touch(ARGV[5])
local res = {remaining, others, #pruned}
for _, p in ipairs(pruned) do res[#res + 1] = p end
for _, r in ipairs(respawned) do res[#res + 1] = r end
return res
`;

// ARGV: objId, defaultHp, cost, now, playerId   returns {0} | {1, hp} | {2}
const HIT = `${PRELUDE}
local hp = tonumber(ARGV[2])
local broken = 0
local v = redis.call('HGET', O, ARGV[1])
if v then
  local h, b = string.match(v, '^(-?%d+):(%d+)$')
  hp, broken = tonumber(h), tonumber(b)
end
if broken > 0 then return {0} end
hp = hp - 1
if hp > 0 then
  redis.call('HSET', O, ARGV[1], hp .. ':0')
  return {1, hp}
end
redis.call('HSET', O, ARGV[1], '0:' .. ARGV[4])
redis.call('HINCRBYFLOAT', META, 'total', ARGV[3])
redis.call('HINCRBYFLOAT', SC, ARGV[5], ARGV[3])
redis.call('HINCRBY', BK, ARGV[5], 1)
return {2}
`;

// Whole room snapshot in ONE command (it used to be a 7-command pipeline).
// ARGV: now, ttlMs
const SNAPSHOT = `${PRELUDE}
local lo = '(' .. string.format('%d', tonumber(ARGV[1]) - tonumber(ARGV[2]))
local total = redis.call('HGET', META, 'total') or '0'
return {
  redis.call('ZRANGEBYSCORE', ON, lo, '+inf'),
  redis.call('HGETALL', NM), redis.call('HGETALL', POS), redis.call('HGETALL', SC),
  redis.call('HGETALL', BK), redis.call('HGETALL', O), total,
}
`;

// ARGV: now, cooldownMs   returns {1, 0} | {0, waitMs}
const RESET = `${PRELUDE}
local now, cooldown = tonumber(ARGV[1]), tonumber(ARGV[2])
local last = tonumber(redis.call('HGET', META, 'lastReset') or '0')
if now - last < cooldown then return {0, cooldown - (now - last)} end
redis.call('HSET', META, 'lastReset', ARGV[1])
redis.call('DEL', O)
return {1, 0}
`;

// Refresh many connection leases in one command. KEYS = ip keys, ARGV = now, ttlMs, then one connId per key.
const TOUCH = `
for i = 1, #KEYS do
  redis.call('ZADD', KEYS[i], string.format('%d', tonumber(ARGV[1]) + tonumber(ARGV[2])), ARGV[i + 2])
  redis.call('PEXPIRE', KEYS[i], ARGV[2])
end
return #KEYS
`;

// KEYS[1] = ip key. ARGV: now, ttlMs, max, connId
const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], string.format('%d', tonumber(ARGV[1]) + tonumber(ARGV[2])), ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

const SCRIPTS = { join: JOIN, leave: LEAVE, housekeep: HOUSEKEEP, hit: HIT, reset: RESET, snapshot: SNAPSHOT };

function createRedisStore(url, { roomTtlS = 1800, log = console.error, ca } = {}) {
  const opts = { maxRetriesPerRequest: 3, enableReadyCheck: true };
  if (ca) opts.tls = { ca };
  const redis = new Redis(url, opts);
  const sub = new Redis(url, opts);
  let lastErr = 0;
  const onError = (e) => {
    const now = Date.now();
    if (now - lastErr > 5000) {
      lastErr = now;
      log('[redis]', e && e.message ? e.message : e);
    }
  };
  redis.on('error', onError);
  sub.on('error', onError);

  for (const [name, lua] of Object.entries(SCRIPTS)) redis.defineCommand(name, { numberOfKeys: 9, lua });
  redis.defineCommand('acquire', { numberOfKeys: 1, lua: ACQUIRE });
  redis.defineCommand('touch', { lua: TOUCH }); // key count is given per call

  const handlers = new Map(); // channel -> fn(str)
  sub.on('message', (channel, message) => {
    const h = handlers.get(channel);
    if (h) h(message);
  });
  // After a dropped connection ioredis resubscribes by itself; a message
  // published in between is lost, which clients tolerate (see README).

  const tag = (room) => 'br:{' + room + '}:';
  const keys = (room) => {
    const p = tag(room);
    return ['o', 'sc', 'bk', 'nm', 'tok', 'meta', 'on', 'own', 'pos'].map((k) => p + k);
  };
  const channel = (room) => tag(room) + 'ev';
  const ipKey = (ip) => 'br:ip:' + ip;
  const posStr = (p) => (p ? Math.round(p.x) + ',' + Math.round(p.y) + ',' + (p.d === -1 ? -1 : 1) : '');
  const parsePos = (s) => {
    const [x, y, d] = String(s).split(',').map(Number);
    return { x, y, d: d === -1 ? -1 : 1 };
  };

  return {
    kind: 'redis',

    async join(room, { token, name, fallbackName, connId, now, max, ttlMs, spawn }) {
      const r = await redis.join(
        ...keys(room), token, name, fallbackName, connId, now, max, ttlMs,
        Math.round(spawn.x), Math.round(spawn.y), roomTtlS,
      );
      if (r[0] === 'full') return { full: true };
      return { id: Number(r[1]), prevConn: r[2], pos: parsePos(r[3]), pruned: r.slice(4).map(Number) };
    },

    async leave(room, id, connId, pos, now) {
      return (await redis.leave(...keys(room), id, connId, posStr(pos), roomTtlS)) === 1;
    },

    async housekeep(room, { now, ttlMs, respawnMs, sweep, entries, instanceId = '' }) {
      const args = [];
      for (const e of entries) args.push(e.id, e.connId, posStr(e.pos));
      const r = await redis.housekeep(...keys(room), now, ttlMs, respawnMs, sweep ? 1 : 0, roomTtlS, instanceId, ...args);
      const n = r[2];
      return {
        remaining: r[0],
        others: r[1],
        pruned: r.slice(3, 3 + n).map(Number),
        respawned: r.slice(3 + n).map(Number),
      };
    },

    async read(room, { now, ttlMs }) {
      const [ids, nmF, posF, scF, bkF, oF, total] = await redis.snapshot(...keys(room), now, ttlMs);
      const toMap = (flat) => {
        const m = {};
        for (let i = 0; i < flat.length; i += 2) m[flat[i]] = flat[i + 1];
        return m;
      };
      const names = toMap(nmF);
      const poss = toMap(posF);
      const scores = toMap(scF);
      const breaks = toMap(bkF);
      const players = ids.map((sid) => {
        const p = poss[sid] ? parsePos(poss[sid]) : { x: 640, y: 360, d: 1 };
        return {
          id: Number(sid),
          name: names[sid] || 'Nhân viên ' + sid,
          x: p.x,
          y: p.y,
          d: p.d,
          score: Number(scores[sid] || 0),
          breaks: Number(breaks[sid] || 0),
        };
      });
      const objects = {};
      for (const [oid, v] of Object.entries(toMap(oF))) {
        const m = /^(-?\d+):(\d+)$/.exec(v);
        if (m) objects[oid] = { hp: Number(m[1]), brokenAt: Number(m[2]) };
      }
      return { players, objects, total: Number(total || 0) };
    },

    async hit(room, { objId, defaultHp, cost, playerId, now }) {
      const r = await redis.hit(...keys(room), objId, defaultHp, cost, now, playerId);
      if (r[0] === 0) return { state: 'none' };
      if (r[0] === 1) return { state: 'hit', hp: r[1] };
      return { state: 'broke', hp: 0 };
    },

    async reset(room, { now, cooldownMs }) {
      const r = await redis.reset(...keys(room), now, cooldownMs);
      return { ok: r[0] === 1, waitMs: r[1] };
    },

    async acquireConn(ip, connId, { max, ttlMs, now }) {
      return (await redis.acquire(ipKey(ip), now, ttlMs, max, connId)) === 1;
    },

    async touchConns(entries, { ttlMs, now }) {
      if (!entries.length) return;
      await redis.touch(entries.length, ...entries.map((e) => ipKey(e.ip)), now, ttlMs, ...entries.map((e) => e.connId));
    },

    async releaseConn(ip, connId) {
      await redis.zrem(ipKey(ip), connId);
    },

    async subscribe(room, handler) {
      handlers.set(channel(room), handler);
      await sub.subscribe(channel(room));
    },

    async unsubscribe(room) {
      handlers.delete(channel(room));
      await sub.unsubscribe(channel(room));
    },

    async publish(room, str) {
      await redis.publish(channel(room), str);
    },

    async close() {
      handlers.clear();
      redis.disconnect();
      sub.disconnect();
    },
  };
}

module.exports = { createRedisStore };
