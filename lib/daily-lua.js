'use strict';
// Redis (Lua) side of the daily leaderboard.
//
// Per room and day (hash tag {room}, so one cluster slot):
//   DS  zset  actor id -> score in tenths     (the live board)
//   DI  hash  hyd (1 hydrated, 2 degraded), total, b:<actor> breaks, n:<actor> name, x:<guest> -> character
// Per room, without any TTL (a room expiring after 30 idle minutes must not lose unsynced points):
//   EVQ list  durable event queue, FIFO, drained by the sync worker
//   QS  hash  run, seq, dropped, enqAt, synced, syncAt, errAt, err
//
// Invariant (hydrated day): DS = SQL baseline + every event enqueued since hydration, where an
// event that SQL already holds is counted once. Payouts add to DS and append to EVQ inside the
// SAME script as the gameplay change, so a score is never credited without its event.

// Declares KEYS/ARGV locals and helpers. `nm` is a Lua expression for the room name hash (field
// id -> name, a<id> -> actor id); `k` is the index of the first of DS, DI, EVQ, QS; `a` the index
// of the first of: day, persist, maxQueue, runId, dayTtlS, nowMs.
function snippet(nm, k, a) {
  return `
local DNM, DS, DI, EVQ, QS = ${nm}, KEYS[${k}], KEYS[${k + 1}], KEYS[${k + 2}], KEYS[${k + 3}]
local DAY, PERSIST, MAXQ, RUN, DTTL, NOWMS = tonumber(ARGV[${a}]), tonumber(ARGV[${a + 1}]), tonumber(ARGV[${a + 2}]), ARGV[${a + 3}], tonumber(ARGV[${a + 4}]), ARGV[${a + 5}]
local function d_enqueue(ev)
  if redis.call('LLEN', EVQ) >= MAXQ then
    redis.call('HINCRBY', QS, 'dropped', 1)
    redis.call('HSET', QS, 'droppedAt', NOWMS)
    return false
  end
  local run = redis.call('HGET', QS, 'run')
  -- A new queue incarnation (first event, or after Redis lost its data) gets a new run id, so event ids never repeat
  -- the ones Postgres already holds from an earlier incarnation.
  if not run then local t = redis.call('TIME'); run = RUN .. t[1] .. t[2]; redis.call('HSET', QS, 'run', run) end
  local seq = redis.call('HINCRBY', QS, 'seq', 1)
  ev.i = run .. ':' .. seq
  ev.y = DAY
  redis.call('RPUSH', EVQ, cjson.encode(ev))
  redis.call('HSET', QS, 'enqAt', NOWMS)
  return true
end
local function d_hydrated()
  if PERSIST == 0 and not redis.call('HGET', DI, 'hyd') then redis.call('HSET', DI, 'hyd', '1') end
  return redis.call('HGET', DI, 'hyd')
end
local function d_expire() redis.call('EXPIRE', DS, DTTL); redis.call('EXPIRE', DI, DTTL) end
-- Credit a player id (not an actor id): resolves the actor, follows a guest->character transfer for POINTS.
-- Knock-outs always stay with the actor that was knocked out.
local function d_credit(id, tenths, breaks, deaths)
  deaths = deaths or 0
  local actor0 = redis.call('HGET', DNM, 'a' .. id)
  if not actor0 then return end
  local actor = actor0
  local redirected = false
  local to = redis.call('HGET', DI, 'x:' .. actor0)
  if to then actor = to; redirected = true end
  local pname = redis.call('HGET', DNM, id) or ''
  local pointsName = redirected and '' or pname
  local scores = (tenths ~= 0 or breaks ~= 0 or deaths == 0)
  if d_hydrated() then
    if scores then
      redis.call('ZINCRBY', DS, tenths, actor)
      redis.call('HINCRBY', DI, 'total', tenths)
      if breaks ~= 0 then redis.call('HINCRBY', DI, 'b:' .. actor, breaks) end
      if pointsName ~= '' then redis.call('HSET', DI, 'n:' .. actor, pointsName) end
    end
    if deaths ~= 0 then
      redis.call('HINCRBY', DI, 'd:' .. actor0, deaths)
      redis.call('ZADD', DS, 'NX', 0, actor0)
      if pname ~= '' then redis.call('HSET', DI, 'n:' .. actor0, pname) end
    end
    d_expire()
  end
  if PERSIST == 1 then
    if scores then d_enqueue({k = 's', a = actor, d = tenths, b = breaks, dt = 0, n = pointsName}) end
    if deaths ~= 0 then d_enqueue({k = 's', a = actor0, d = 0, b = 0, dt = deaths, n = pname}) end
  end
end
`;
}

// KEYS: DNM(unused), DS, DI, EVQ, QS   ARGV: actor, name, <bundle>
// returns 'unhydrated' | 'ok'
const TOUCH = `${snippet('KEYS[1]', 2, 3)}
if not d_hydrated() then return 'unhydrated' end
local actor, name = ARGV[1], ARGV[2]
local added = redis.call('ZADD', DS, 'NX', 0, actor)
local old = redis.call('HGET', DI, 'n:' .. actor)
if name ~= '' then redis.call('HSET', DI, 'n:' .. actor, name) end
if PERSIST == 1 and (added == 1 or (name ~= '' and old ~= name)) then d_enqueue({k = 'j', a = actor, n = name}) end
d_expire()
return 'ok'
`;

// KEYS: DNM(unused), DS, DI, EVQ, QS   ARGV: from, to, toName, <bundle>
// returns {'unhydrated'} | {'exists'} | {'noop'} | {'moved', tenths, breaks}
const TRANSFER = `${snippet('KEYS[1]', 2, 4)}
if not d_hydrated() then return {'unhydrated'} end
local from, to, toName = ARGV[1], ARGV[2], ARGV[3]
if redis.call('HEXISTS', DI, 'x:' .. from) == 1 then return {'exists'} end
local s = redis.call('ZSCORE', DS, from)
if not s then return {'noop'} end
local b = tonumber(redis.call('HGET', DI, 'b:' .. from) or '0')
-- Only points and broken items move. A guest who earned nothing keeps its row, and knock-outs stay with whoever had them.
if tonumber(s) == 0 and b == 0 then return {'noop'} end
redis.call('ZINCRBY', DS, s, to)
if b ~= 0 then redis.call('HINCRBY', DI, 'b:' .. to, b) end
if toName ~= '' then redis.call('HSET', DI, 'n:' .. to, toName) end
redis.call('ZADD', DS, 0, from)
redis.call('HDEL', DI, 'b:' .. from)
redis.call('HSET', DI, 'x:' .. from, to)
if PERSIST == 1 then d_enqueue({k = 'x', f = from, a = to, n = toName}) end
d_expire()
return {'moved', tostring(s), tostring(b)}
`;

// KEYS: DS, DI, EVQ   ARGV: day, mode(1|2), rows json, transfers json, committed ids json, ttl
// Rebuilds the day from SQL rows plus every queued event SQL does not already hold.
// The caller holds the queue lock, so no batch is committed between its reads and this script.
const HYDRATE = `
local DS, DI, EVQ = KEYS[1], KEYS[2], KEYS[3]
if redis.call('HGET', DI, 'hyd') == '1' then return 0 end
local day = tonumber(ARGV[1])
redis.call('DEL', DS, DI)
local total = 0
for _, r in ipairs(cjson.decode(ARGV[3])) do
  redis.call('ZADD', DS, r.s, r.a)
  if r.b ~= 0 then redis.call('HSET', DI, 'b:' .. r.a, r.b) end
  if r.dt and r.dt ~= 0 then redis.call('HSET', DI, 'd:' .. r.a, r.dt) end
  if r.n ~= '' then redis.call('HSET', DI, 'n:' .. r.a, r.n) end
  total = total + r.s
end
for _, t in ipairs(cjson.decode(ARGV[4])) do redis.call('HSET', DI, 'x:' .. t.f, t.t) end
local committed = {}
for _, id in ipairs(cjson.decode(ARGV[5])) do committed[id] = true end
local replayed = 0
for _, raw in ipairs(redis.call('LRANGE', EVQ, 0, -1)) do
  local e = cjson.decode(raw)
  if e.y == day and not committed[e.i] then
    replayed = replayed + 1
    if e.k == 'x' then
      local s = redis.call('ZSCORE', DS, e.f)
      if s then
        local b = tonumber(redis.call('HGET', DI, 'b:' .. e.f) or '0')
        redis.call('ZINCRBY', DS, s, e.a)
        if b ~= 0 then redis.call('HINCRBY', DI, 'b:' .. e.a, b) end
        redis.call('ZADD', DS, 0, e.f)
        redis.call('HDEL', DI, 'b:' .. e.f)
      end
      redis.call('HSET', DI, 'x:' .. e.f, e.a)
      if e.n ~= '' then redis.call('HSET', DI, 'n:' .. e.a, e.n) end
    else
      redis.call('ZADD', DS, 'NX', 0, e.a)
      if e.k == 's' then
        redis.call('ZINCRBY', DS, e.d, e.a)
        total = total + e.d
        if e.b ~= 0 then redis.call('HINCRBY', DI, 'b:' .. e.a, e.b) end
        if e.dt and e.dt ~= 0 then redis.call('HINCRBY', DI, 'd:' .. e.a, e.dt) end
      end
      if e.n ~= '' then redis.call('HSET', DI, 'n:' .. e.a, e.n) end
    end
  end
end
redis.call('HSET', DI, 'total', total)
redis.call('HSET', DI, 'hyd', ARGV[2])
redis.call('EXPIRE', DS, ARGV[6])
redis.call('EXPIRE', DI, ARGV[6])
return replayed + 1
`;

// KEYS: DS, DI   ARGV: limit, then actor ids whose rank is wanted
// returns {hyd, count, total, n, {actor, tenths, breaks, name, deaths}*, then per wanted actor: rank, tenths, breaks, name, deaths (rank '0' = none)}
const BOARD = `
local DS, DI = KEYS[1], KEYS[2]
local hyd = redis.call('HGET', DI, 'hyd')
if not hyd then return {'0'} end
local limit = tonumber(ARGV[1])
local out = {hyd, tostring(redis.call('ZCARD', DS)), redis.call('HGET', DI, 'total') or '0'}
local top = redis.call('ZREVRANGE', DS, 0, limit - 1, 'WITHSCORES')
out[#out + 1] = tostring(#top / 2)
for i = 1, #top, 2 do
  out[#out + 1] = top[i]
  out[#out + 1] = top[i + 1]
  out[#out + 1] = redis.call('HGET', DI, 'b:' .. top[i]) or '0'
  out[#out + 1] = redis.call('HGET', DI, 'n:' .. top[i]) or ''
  out[#out + 1] = redis.call('HGET', DI, 'd:' .. top[i]) or '0'
end
for i = 2, #ARGV do
  local s = redis.call('ZSCORE', DS, ARGV[i])
  if s then
    out[#out + 1] = tostring(redis.call('ZCOUNT', DS, '(' .. s, '+inf') + 1)
    out[#out + 1] = s
    out[#out + 1] = redis.call('HGET', DI, 'b:' .. ARGV[i]) or '0'
    out[#out + 1] = redis.call('HGET', DI, 'n:' .. ARGV[i]) or ''
    out[#out + 1] = redis.call('HGET', DI, 'd:' .. ARGV[i]) or '0'
  else
    out[#out + 1] = '0'; out[#out + 1] = '0'; out[#out + 1] = '0'; out[#out + 1] = ''; out[#out + 1] = '0'
  end
end
return out
`;

// KEYS: EVQ, QS   ARGV: count, firstId, lastId, nowMs
// Removes the first `count` events only if both ends still match what the caller committed.
// A stale worker whose lock expired therefore cannot trim events a successor has not seen.
const ACK = `
local count = tonumber(ARGV[1])
local first = redis.call('LINDEX', KEYS[1], 0)
local last = redis.call('LINDEX', KEYS[1], count - 1)
if not first or not last then return 0 end
if cjson.decode(first).i ~= ARGV[2] or cjson.decode(last).i ~= ARGV[3] then return 0 end
redis.call('LTRIM', KEYS[1], count, -1)
redis.call('HINCRBY', KEYS[2], 'synced', count)
redis.call('HSET', KEYS[2], 'syncAt', ARGV[4])
redis.call('HDEL', KEYS[2], 'err', 'errAt')
return 1
`;

// KEYS: DI   ARGV: limit, actor whose rank is wanted ('' = none)
// returns {hyd, players with deaths, {actor, deaths, name}*, selfRank, selfDeaths}
const DEATHS = `
local DI = KEYS[1]
local hyd = redis.call('HGET', DI, 'hyd')
if not hyd then return {'0'} end
local all = redis.call('HGETALL', DI)
local list = {}
for i = 1, #all, 2 do
  if string.sub(all[i], 1, 2) == 'd:' then
    local n = tonumber(all[i + 1])
    if n > 0 then list[#list + 1] = {string.sub(all[i], 3), n} end
  end
end
table.sort(list, function(x, y) if x[2] ~= y[2] then return x[2] > y[2] end return x[1] > y[1] end)
local out = {hyd, tostring(#list)}
local limit = math.min(tonumber(ARGV[1]), #list)
for i = 1, limit do
  out[#out + 1] = list[i][1]
  out[#out + 1] = tostring(list[i][2])
  out[#out + 1] = redis.call('HGET', DI, 'n:' .. list[i][1]) or ''
end
local mine = tonumber(redis.call('HGET', DI, 'd:' .. ARGV[2]) or '0')
local rank = 0
if mine > 0 then
  rank = 1
  for i = 1, #list do if list[i][2] > mine then rank = rank + 1 end end
end
out[#out + 1] = tostring(rank)
out[#out + 1] = tostring(mine)
return out
`;

const UNLOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

// KEYS: DNM, DS, DI, EVQ, QS   ARGV: player id, <bundle>
const DEATH = `${snippet('KEYS[1]', 2, 2)}
d_credit(ARGV[1], 0, 0, 1)
return 1
`;

module.exports = { snippet, TOUCH, TRANSFER, HYDRATE, BOARD, DEATHS, DEATH, ACK, UNLOCK };
