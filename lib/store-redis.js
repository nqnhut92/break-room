'use strict';

// Redis-backed store: the single source of truth that every Vercel instance
// shares. Each mutating operation is one Lua script, so concurrent hits from
// different instances are applied atomically (an object can only break once and
// the score is credited exactly once).
//
// Keys for a room all share the hash tag {room}, so they live in one cluster
// slot, and every script receives all nine keys in the same order.
//
//   o     hash  object id -> "hp:brokenAt"   (absent = full health; hp can be fractional: a ranged hit does half damage)
//   sc    hash  player id -> score
//   bk    hash  player id -> number of objects broken
//   nm    hash  player id -> display name
//   tok   hash  client token -> player id    (lets a reconnect keep its id/score)
//   meta  hash  nextid, total, lastReset
//   on    zset  player id -> last heartbeat ms (presence; stale entries expire)
//   own   hash  player id -> id of the websocket connection that owns the slot
//   pos   hash  player id -> "x,y,d"         (last persisted position)

const Redis = require('ioredis');
const { emptyDuel } = require('./duel');

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

// ARGV: token, name, fallbackName, connId, now, max, ttlMs, spawnX, spawnY, roomTtlS, gender, role, company
const JOIN = `${PRELUDE}
local now, max, ttl = tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(ARGV[7])
local pruned = prune(now, ttl)
local id = redis.call('HGET', TOK, ARGV[1])
local present = false
if id then present = redis.call('ZSCORE', ON, id) end
if not present and redis.call('ZCARD', ON) >= max then return {'full'} end
if ARGV[2] ~= '' then
  -- exact, case-sensitive: another player who is online right now already uses this name
  for _, other in ipairs(redis.call('ZRANGE', ON, 0, -1)) do
    if other ~= id and redis.call('HGET', NM, other) == ARGV[2] then return {'taken'} end
  end
end
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
-- gender lives in the same hash under the field "g<id>" (names are under "<id>")
if ARGV[11] ~= '' then redis.call('HSET', NM, 'g' .. id, ARGV[11]) end
if ARGV[12] ~= '' then redis.call('HSET', NM, 'r' .. id, ARGV[12]) end
-- company name: always overwritten, so leaving it empty clears an old one
if ARGV[13] ~= '' then redis.call('HSET', NM, 'c' .. id, ARGV[13]) else redis.call('HDEL', NM, 'c' .. id) end
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
-- Compaction: at most every 2 minutes forget people who are offline and never scored (token, name, gender,
-- role, last position, owner). Scorers stay until the room expires, so the leaderboard keeps them.
local lastCompact = tonumber(redis.call('HGET', META, 'lastCompact') or '0')
if now - lastCompact >= 120000 then
  redis.call('HSET', META, 'lastCompact', ARGV[1])
  local toks = redis.call('HGETALL', TOK)
  for i = 1, #toks, 2 do
    local tid = toks[i + 1]
    if redis.call('ZSCORE', ON, tid) == false and redis.call('HEXISTS', SC, tid) == 0 then
      redis.call('HDEL', TOK, toks[i])
      redis.call('HDEL', NM, tid, 'g' .. tid, 'r' .. tid, 'c' .. tid, 'h' .. tid)
      redis.call('HDEL', POS, tid)
      redis.call('HDEL', OWN, tid)
    end
  end
end
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
  local h, b = string.match(v, '^(-?[%d%.]+):(%d+)$')
  hp, broken = tonumber(h), tonumber(b)
end
if broken > 0 then return {0} end
hp = hp - tonumber(ARGV[6])
if hp > 0 then
  local shown = string.format('%.3f', hp)
  redis.call('HSET', O, ARGV[1], shown .. ':0')
  return {1, shown}
end
redis.call('HSET', O, ARGV[1], '0:' .. ARGV[4])
redis.call('HINCRBYFLOAT', META, 'total', ARGV[3])
redis.call('HINCRBYFLOAT', SC, ARGV[5], ARGV[3])
redis.call('HINCRBY', BK, ARGV[5], 1)
return {2}
`;

// ---- the boss. Keys: boss (hash: hp, at, dead, respawnAt), bdmg (hash: player id -> damage dealt), sc, meta.
// hp is stored together with the time it was stored; whoever reads it adds the regeneration since then.

// ARGV: now, dmg, playerId, maxHp, baseRegen, fastRegen, delayMs, respawnAt, bounty, ttlS
// returns {'dead'} | {'hit', hp} | {'killed', id, dmg, bounty, id, dmg, bounty, ...}
const BOSS_HIT = `
local B, D, SC, META = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local now, dmg, maxHp = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[4])
local base, fast, delay = tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(ARGV[7])
if redis.call('HGET', B, 'dead') == '1' then return {'dead'} end
local hp = tonumber(redis.call('HGET', B, 'hp') or ARGV[4])
local at = tonumber(redis.call('HGET', B, 'at') or ARGV[1])
local e = math.max(0, now - at)
hp = math.min(maxHp, hp + (e * base + math.max(0, e - delay) * fast) / 1000)
redis.call('HINCRBYFLOAT', D, ARGV[3], math.min(dmg, hp))
hp = hp - dmg
redis.call('EXPIRE', D, ARGV[10])
if hp > 0 then
  redis.call('HSET', B, 'hp', string.format('%.3f', hp), 'at', ARGV[1])
  redis.call('EXPIRE', B, ARGV[10])
  return {'hit', string.format('%.3f', hp)}
end
redis.call('HSET', B, 'hp', '0', 'at', ARGV[1], 'dead', '1', 'respawnAt', ARGV[8])
redis.call('EXPIRE', B, ARGV[10])
local all = redis.call('HGETALL', D)
local total = 0
for i = 1, #all, 2 do total = total + tonumber(all[i + 1]) end
local bounty = tonumber(ARGV[9])
local out = {'killed'}
for i = 1, #all, 2 do
  local share = math.floor(bounty * tonumber(all[i + 1]) / total * 10 + 0.5) / 10
  redis.call('HINCRBYFLOAT', SC, all[i], share)
  out[#out + 1] = all[i]
  out[#out + 1] = all[i + 1]
  out[#out + 1] = string.format('%.1f', share)
end
redis.call('HINCRBYFLOAT', META, 'total', bounty)
return out
`;

// ARGV: now, maxHp, ttlS   returns 1 when this call brought the boss back, else 0
const BOSS_RESPAWN = `
local B, D = KEYS[1], KEYS[2]
if redis.call('HGET', B, 'dead') ~= '1' then return 0 end
if tonumber(ARGV[1]) < tonumber(redis.call('HGET', B, 'respawnAt') or '0') then return 0 end
redis.call('HSET', B, 'hp', ARGV[2], 'at', ARGV[1], 'dead', '0')
redis.call('DEL', D, KEYS[3])
redis.call('HDEL', B, 'snake70', 'snake40', 'snake10')
redis.call('EXPIRE', B, ARGV[3])
return 1
`;

// KEYS[1] = lease key. ARGV: holder id, ttlMs   returns 1 when the caller holds the lease now
const BOSS_LOCK = `
local cur = redis.call('GET', KEYS[1])
if cur and cur ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1
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

// Number of online players per room in ONE command. KEYS = each room's presence zset, ARGV: now, ttlMs
const ONLINE = `
local lo = '(' .. string.format('%d', tonumber(ARGV[1]) - tonumber(ARGV[2]))
local out = {}
for i = 1, #KEYS do out[i] = redis.call('ZCOUNT', KEYS[i], lo, '+inf') end
return out
`;

// KEYS[1] = ip key. ARGV: now, ttlMs, max, connId
const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], string.format('%d', tonumber(ARGV[1]) + tonumber(ARGV[2])), ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

const SNAKE_SUMMON = `
local B, S, M = KEYS[1], KEYS[2], KEYS[3]
local hp = tonumber(redis.call('HGET', B, 'hp') or '-1')
local out = {waves={}, snakes={}}
if hp < 0 or redis.call('HGET', B, 'dead') == '1' then return cjson.encode(out) end
local count, x, y = tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
for _, percent in ipairs({70,40,10}) do
  local flag = 'snake' .. percent
  if hp <= tonumber(ARGV[1]) * percent / 100 and redis.call('HSETNX', B, flag, 1) == 1 then
    table.insert(out.waves, percent)
    for i=1,count do
      local a = (i-1) / math.max(1,count) * math.pi * 2
      local id = redis.call('HINCRBY', M, 'snakeNext', 1)
      local s = {id=id,x=x+math.cos(a)*48,y=y+math.sin(a)*48,d=a,hp=4}
      redis.call('HSET', S, id, cjson.encode(s))
      table.insert(out.snakes, s)
    end
  end
end
redis.call('EXPIRE', S, ARGV[5])
return cjson.encode(out)
`;
const SNAKE_MOVE = `
local list = cjson.decode(ARGV[1])
for _, p in ipairs(list) do
  local v = redis.call('HGET', KEYS[1], p.id)
  if v then
    local s = cjson.decode(v)
    s.x=p.x; s.y=p.y; s.d=p.d
    redis.call('HSET', KEYS[1], p.id, cjson.encode(s))
  end
end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;
const SNAKE_HIT = `
local v = redis.call('HGET', KEYS[1], ARGV[1])
if not v then return '' end
local s = cjson.decode(v)
s.hp = math.max(0,s.hp-1)
if s.hp == 0 then redis.call('HDEL', KEYS[1], ARGV[1])
else redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(s)) end
return cjson.encode(s)
`;

// Only the current boss runner may commit a duel. CAS fences delayed writes and leader handovers.
const DUEL_SAVE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local previous = redis.call('HGET', KEYS[2], 'duel')
local version = previous and cjson.decode(previous).version or 0
if version ~= tonumber(ARGV[2]) then return 0 end
local state = cjson.decode(ARGV[3])
if state.target ~= 0 and redis.call('HGET', KEYS[2], 'dead') == '1' then return 0 end
redis.call('HSET', KEYS[2], 'duel', ARGV[3])
for _, m in ipairs(state.moves) do
  redis.call('HSET', KEYS[3], m.id, m.x .. ',' .. m.y .. ',1')
end
redis.call('EXPIRE', KEYS[2], ARGV[4])
redis.call('EXPIRE', KEYS[3], ARGV[4])
return 1
`;

// ---- moles. Keys: moles (hash: player id -> {hp, rev}), sc, bk, meta.
const MOLE_HIT = `
local v = redis.call('HGET', KEYS[1], ARGV[1])
if not v then return {'none'} end
local m = cjson.decode(v)
m.rev = true
m.hp = m.hp - tonumber(ARGV[2])
if m.hp > 0 then
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(m))
  return {'hit', tostring(m.hp)}
end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('HINCRBYFLOAT', KEYS[4], 'total', ARGV[3])
redis.call('HINCRBYFLOAT', KEYS[2], ARGV[4], ARGV[3])
redis.call('HINCRBY', KEYS[3], ARGV[4], 1)
return {'killed', '0'}
`;
const MOLE_REVEAL = `
local v = redis.call('HGET', KEYS[1], ARGV[1])
if not v then return 0 end
local m = cjson.decode(v)
m.rev = true
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(m))
return 1
`;

// Atomic room-wide offer: all instances share the schedule and only one click wins.
const DRINK = `${PRELUDE}
local now, interval, window = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local at = tonumber(redis.call('HGET', META, 'drinkAt') or '0')
if at == 0 then at = now + interval end
if now >= at + window then
  at = at + math.floor((now - at) / interval) * interval
  if now >= at + window then at = at + interval end
end
redis.call('HSET', META, 'drinkAt', at)
local used = tonumber(redis.call('HGET', META, 'drinkClaimed') or '0')
local available = now >= at and now < at + window and used ~= at
local claimed = available and ARGV[4] == '1' and tonumber(ARGV[6]) == at
if claimed then redis.call('HSET', META, 'drinkClaimed', at) end
touch(ARGV[5])
return {at, available and not claimed and 1 or 0, claimed and 1 or 0, at + window, now < at and at or at + interval}
`;

const SCRIPTS = { join: JOIN, leave: LEAVE, housekeep: HOUSEKEEP, hit: HIT, reset: RESET, snapshot: SNAPSHOT, drink: DRINK };

function createRedisStore(url, { roomTtlS = 1800, log = console.error, ca } = {}) {
  const opts = { maxRetriesPerRequest: 3, enableReadyCheck: true };
  if (ca) opts.tls = { ca };
  const redis = new Redis(url, opts);
  // The subscriber only connects when something subscribes, so a function that just reads
  // (for example the room list) holds one connection, not two.
  const sub = new Redis(url, { ...opts, lazyConnect: true });
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
  redis.defineCommand('snakeSummon', { numberOfKeys: 3, lua: SNAKE_SUMMON });
  redis.defineCommand('snakeMove', { numberOfKeys: 1, lua: SNAKE_MOVE });
  redis.defineCommand('snakeHit', { numberOfKeys: 1, lua: SNAKE_HIT });
  redis.defineCommand('moleHit', { numberOfKeys: 4, lua: MOLE_HIT });
  redis.defineCommand('moleReveal', { numberOfKeys: 1, lua: MOLE_REVEAL });
  redis.defineCommand('bossHit', { numberOfKeys: 4, lua: BOSS_HIT });
  redis.defineCommand('bossRespawn', { numberOfKeys: 3, lua: BOSS_RESPAWN });
  redis.defineCommand('duelSave', { numberOfKeys: 3, lua: DUEL_SAVE });
  redis.defineCommand('bossLock', { numberOfKeys: 1, lua: BOSS_LOCK });
  redis.defineCommand('touch', { lua: TOUCH }); // key count is given per call
  redis.defineCommand('onlineCounts', { lua: ONLINE });

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
  const bossKeys = (room) => ['boss', 'bdmg', 'sc', 'meta'].map((k) => tag(room) + k);
  const channel = (room) => tag(room) + 'ev';
  const ipKey = (ip) => 'br:ip:' + ip;
  const posStr = (p) => (p ? Math.round(p.x) + ',' + Math.round(p.y) + ',' + (p.d === -1 ? -1 : 1) : '');
  const parseHp = (s) => {
    if (!s) return { hp: null, hpAt: 0, deadUntil: 0 };
    const [hp, at, du] = String(s).split('|').map(Number);
    return { hp, hpAt: at, deadUntil: du || 0 };
  };
  const parsePos = (s) => {
    const [x, y, d] = String(s).split(',').map(Number);
    return { x, y, d: d === -1 ? -1 : 1 };
  };

  return {
    kind: 'redis',

    async join(room, { token, name, fallbackName, connId, now, max, ttlMs, spawn, gender = '', role = '', company = '' }) {
      const r = await redis.join(
        ...keys(room), token, name, fallbackName, connId, now, max, ttlMs,
        Math.round(spawn.x), Math.round(spawn.y), roomTtlS, gender, role, company,
      );
      if (r[0] === 'full') return { full: true };
      if (r[0] === 'taken') return { taken: true };
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
          gender: names['g' + sid] === 'f' ? 'f' : 'm',
          role: names['r' + sid] || 'nv',
          company: names['c' + sid] || '',
          ...parseHp(names['h' + sid]),
          x: p.x,
          y: p.y,
          d: p.d,
          score: Number(scores[sid] || 0),
          breaks: Number(breaks[sid] || 0),
        };
      });
      const objects = {};
      for (const [oid, v] of Object.entries(toMap(oF))) {
        const m = /^(-?[\d.]+):(\d+)$/.exec(v);
        if (m) objects[oid] = { hp: Number(m[1]), brokenAt: Number(m[2]) };
      }
      return { players, objects, total: Number(total || 0) };
    },

    // ---- player health, kept in the name hash under "h<id>" = "hp|at|deadUntil"
    async setHp(room, id, { hp, at, deadUntil }) {
      await redis.hset(tag(room) + 'nm', 'h' + id, hp.toFixed(2) + '|' + at + '|' + deadUntil);
    },

    async bossGet(room, { now, maxHp }) {
      const [hp, at, dead, respawnAt] = await redis.hmget(tag(room) + 'boss', 'hp', 'at', 'dead', 'respawnAt');
      return {
        hp: hp === null ? maxHp : Number(hp),
        at: at === null ? now : Number(at),
        dead: dead === '1',
        respawnAt: Number(respawnAt || 0),
      };
    },

    async bossHit(room, { playerId, dmg, now, cfg, respawnAt, bounty }) {
      const r = await redis.bossHit(
        ...bossKeys(room), now, dmg, playerId, cfg.maxHp, cfg.baseRegenPerSec, cfg.regenPerSec, cfg.regenDelayMs, respawnAt, bounty, roomTtlS,
      );
      if (r[0] === 'dead') return { state: 'dead' };
      if (r[0] === 'hit') return { state: 'hit', hp: Number(r[1]), at: now };
      const shares = [];
      for (let i = 1; i < r.length; i += 3) shares.push({ id: Number(r[i]), dmg: Number(r[i + 1]), bounty: Number(r[i + 2]) });
      return { state: 'killed', shares };
    },

    async summonSnakes(room, { maxHp, count, x, y }) {
      const out = JSON.parse(await redis.snakeSummon(tag(room) + 'boss', tag(room) + 'snakes', tag(room) + 'meta', maxHp, count, x, y, roomTtlS));
      return { waves: Array.isArray(out.waves) ? out.waves : [], snakes: Array.isArray(out.snakes) ? out.snakes : [] };
    },
    async snakeList(room) { return Object.values(await redis.hgetall(tag(room) + 'snakes')).map(v => JSON.parse(v)); },
    async snakeMove(room, list) { await redis.snakeMove(tag(room) + 'snakes', JSON.stringify(list), roomTtlS); },
    async snakeHit(room, id) { const v = await redis.snakeHit(tag(room) + 'snakes', id); return v ? JSON.parse(v) : null; },

    async bossRespawn(room, { now, maxHp }) {
      return (await redis.bossRespawn(...bossKeys(room).slice(0, 2), tag(room) + 'snakes', now, maxHp, roomTtlS)) === 1;
    },

    async bossLock(room, id, { ttlMs }) {
      return (await redis.bossLock(tag(room) + 'blk', id, ttlMs)) === 1;
    },

    async duelGet(room) {
      const raw = await redis.hget(tag(room) + 'boss', 'duel');
      return raw ? JSON.parse(raw) : emptyDuel();
    },
    async duelSave(room, { owner, expected, state }) {
      return (await redis.duelSave(tag(room) + 'blk', tag(room) + 'boss', tag(room) + 'pos', owner, expected, JSON.stringify(state), roomTtlS)) === 1;
    },

    async rageSet(room, id, v) {
      await redis.hset(tag(room) + 'rage', id, v);
      await redis.expire(tag(room) + 'rage', roomTtlS);
    },
    async rageGet(room, id) { return Number(await redis.hget(tag(room) + 'rage', id)) || 0; },
    async moleAdd(room, id, { hp, conn }) {
      await redis.hset(tag(room) + 'moles', id, JSON.stringify({ hp, rev: false, conn }));
      await redis.expire(tag(room) + 'moles', roomTtlS);
    },
    async moleList(room) {
      const all = await redis.hgetall(tag(room) + 'moles');
      return Object.entries(all).map(([id, v]) => { const m = JSON.parse(v); return { id: Number(id), hp: m.hp, revealed: !!m.rev, conn: m.conn }; });
    },
    async moleReveal(room, id) { await redis.moleReveal(tag(room) + 'moles', id); },
    async moleDel(room, id) { await redis.hdel(tag(room) + 'moles', id); },
    async moleHit(room, { id, dmg, cost, playerId }) {
      const p = tag(room);
      const r = await redis.moleHit(p + 'moles', p + 'sc', p + 'bk', p + 'meta', id, dmg, cost, playerId);
      if (r[0] === 'none') return { state: 'none' };
      return { state: r[0], hp: Number(r[1]) };
    },

    async hit(room, { objId, defaultHp, cost, playerId, now, dmg = 1 }) {
      const r = await redis.hit(...keys(room), objId, defaultHp, cost, now, playerId, dmg);
      if (r[0] === 0) return { state: 'none' };
      if (r[0] === 1) return { state: 'hit', hp: Number(r[1]) };
      return { state: 'broke', hp: 0 };
    },

    async drinkOffer(room, { now, intervalMs, windowMs, claim = false, offerId }) {
      const r = await redis.drink(...keys(room), now, intervalMs, windowMs, claim ? 1 : 0, roomTtlS, offerId || 0);
      return { id: Number(r[0]), available: r[1] === 1, claimed: r[2] === 1, endsAt: Number(r[3]), nextAt: Number(r[4]) };
    },

    async reset(room, { now, cooldownMs }) {
      const r = await redis.reset(...keys(room), now, cooldownMs);
      return { ok: r[0] === 1, waitMs: r[1] };
    },

    async online(rooms, { now, ttlMs }) {
      if (!rooms.length) return [];
      const counts = await redis.onlineCounts(rooms.length, ...rooms.map((r) => tag(r) + 'on'), now, ttlMs);
      return counts.map(Number);
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
