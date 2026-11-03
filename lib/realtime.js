'use strict';

// Game logic + WebSocket wiring, independent of where it runs (local `npm start`
// or a Vercel Function) and of which store backs it.
//
// What is shared (lives in the store, visible to every instance):
//   object health / broken state, scores, room total, who is online, the last
//   position of each player, the "call IT" cooldown, the per-IP connection count,
//   and the pub/sub channel every broadcast goes through.
//
// What stays local to one connection (a WebSocket is pinned to one instance for
// its whole life, so this is safe): position used for anti-teleport checks, hit
// and emote cooldowns, the message token bucket.

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { WORLD, TYPES, PROPS, ZONES, OBJECTS, COLLIDERS, ROLE_IDS, slideMove } = require('./world');

const MAX_PLAYERS_PER_ROOM = 20;
const MAX_CONN_PER_IP = 10;
const JOIN_TIMEOUT_MS = 5000;
const HIT_RANGE = 110;
const HIT_COOLDOWN_MS = 180;
const EMOTE_COOLDOWN_MS = 800;

// Mana: every smash costs some. Mana comes back slowly while you keep swinging and much faster once you
// stop for a moment (the RPG "out of combat" rule), so a burst is possible but nonstop smashing is paced.
// The server keeps it per connection (like the hit cooldown) and the client mirrors the same formula.
const MANA = { max: 100, cost: 8, regen: 2.5, restRegen: 9, restMs: 2500 };

// Mana right now: the value stored at p.manaAt, plus regeneration since then.
function manaAt(p, now) {
  const e = Math.max(0, now - p.manaAt);
  const slow = Math.min(e, MANA.restMs);
  const fast = Math.max(0, e - MANA.restMs);
  return Math.min(MANA.max, p.mana + (slow * MANA.regen + fast * MANA.restRegen) / 1000);
}
const RESET_COOLDOWN_MS = 15000;
const PLAYER_SPEED = 440; // units per second, used to reject teleporting (the client walks at 420)
const EMOTE_COUNT = 8;
const TICK_MS = 100; // position batches go out 10 times a second
const HOUSEKEEP_MS = 1000;
const PRESENCE_TTL_MS = 20000; // a player whose heartbeat stops is dropped after this
const IP_LEASE_TTL_MS = 150000;
const IP_LEASE_REFRESH_MS = 60000;
const IDLE_HOUSEKEEP_EVERY = 2; // seconds between housekeeping runs while nothing is broken
const QUEUE_LIMIT = 500;

function cleanRoomName(raw) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
  return s || 'lobby';
}

function cleanName(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14);
}

function cleanCompany(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

function cleanGender(raw) {
  return raw === 'f' ? 'f' : 'm';
}

const ROLE_SET = new Set(ROLE_IDS);
function cleanRole(raw) {
  return ROLE_SET.has(raw) ? raw : 'nv';
}

function cleanToken(raw) {
  const s = String(raw || '');
  return /^[A-Za-z0-9_-]{16,64}$/.test(s) ? s : '';
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (n) => Math.round(n * 10) / 10;

function publicPlayer(p) {
  return { id: p.id, name: p.name, gender: p.gender === 'f' ? 'f' : 'm', role: cleanRole(p.role), company: p.company || '', hue: (p.id * 47) % 360, x: Math.round(p.x), y: Math.round(p.y), d: p.d, score: p.score };
}

function objectView(o, state) {
  const full = TYPES[o.type].hp;
  if (!state) return { id: o.id, type: o.type, x: o.x, y: o.y, hp: full, broken: false };
  return { id: o.id, type: o.type, x: o.x, y: o.y, hp: state.brokenAt > 0 ? 0 : state.hp, broken: state.brokenAt > 0 };
}

function boardOf(snap) {
  const list = snap.players
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((p) => ({ id: p.id, name: p.name, score: round1(p.score), breaks: p.breaks }));
  return { t: 'board', total: round1(snap.total), board: list, online: snap.players.length };
}

function createRealtime({
  store,
  respawnMs = 25000,
  trustProxy = false,
  maxConnPerIp = MAX_CONN_PER_IP,
  renewAfterMs = 0, // 0 = never ask clients to move to a fresh connection
  presenceTtlMs = PRESENCE_TTL_MS,
  afkMs = 0, // disconnect a player with no activity for this long (0 = never)
  maxConnections = 0, // per instance, 0 = unlimited
  maxRooms = 0, // rooms this instance will host at once, 0 = unlimited
  disabled = false, // kill switch: tell everyone the game is closed
  rooms: roomList = null, // [{ id, name }]: the only rooms that exist (null = any name)
  log = console.error,
}) {
  const instanceId = crypto.randomBytes(4).toString('hex');
  let connSeq = 0;
  const conns = new Set();
  const rooms = new Map(); // rooms that have at least one local socket
  let wss = null;
  const timers = [];

  // ------------------------------------------------------------ plumbing ----
  function send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  // Every broadcast goes through the store's pub/sub, including to sockets on
  // this very instance, so all clients see events in one consistent order.
  function emit(roomName, msg, except = 0) {
    store.publish(roomName, JSON.stringify([except, msg, instanceId])).catch((e) => log('[publish]', e.message));
  }

  async function emitBoard(roomName) {
    const snap = await store.read(roomName, { now: Date.now(), ttlMs: presenceTtlMs });
    emit(roomName, boardOf(snap));
  }

  function getRoom(name) {
    let room = rooms.get(name);
    if (!room) {
      // remote = some other instance may have players in this room. Assumed true until
      // housekeeping says otherwise, so a new room never starts out deaf to the others.
      room = { name, sockets: new Set(), hasBroken: false, tick: 0, idle: 0, busy: false, remote: true, ready: null };
      room.ready = store.subscribe(name, (data) => onEvent(room, data));
      // a failed subscribe must not leave a poisoned room behind
      room.ready.catch(() => {
        if (rooms.get(name) === room) rooms.delete(name);
      });
      rooms.set(name, room);
    }
    return room;
  }

  function detach(ws) {
    const room = ws.room;
    if (!room) return;
    ws.room = null;
    room.sockets.delete(ws);
    if (room.sockets.size === 0 && rooms.get(room.name) === room) {
      rooms.delete(room.name);
      store.unsubscribe(room.name).catch(() => {});
    }
  }

  function onEvent(room, data) {
    let ev;
    try {
      ev = JSON.parse(data);
    } catch (e) {
      return;
    }
    if (!Array.isArray(ev)) return;
    const [except, msg, src] = ev;
    if (!msg || typeof msg.t !== 'string') return;
    if (src && src !== instanceId) room.remote = true; // someone elsewhere is active in this room

    if (msg.t === 'kick') {
      for (const ws of room.sockets) if (ws.connId === msg.conn) ws.close(4001, 'replaced');
      return;
    }
    if (msg.t === 'break') room.hasBroken = true;
    else if (msg.t === 'reset') room.hasBroken = false;

    const out = JSON.stringify(msg);
    for (const ws of room.sockets) {
      if (except && ws.player && ws.player.id === except) continue;
      if (ws.ready) {
        if (ws.readyState === 1) ws.send(out);
      } else if (ws.queue.length < QUEUE_LIMIT) {
        ws.queue.push(out); // still joining: replay once the welcome is out
      }
    }
  }

  // -------------------------------------------------------------- handlers ----
  async function handleJoin(ws, msg) {
    if (ws.player || ws.joining) return;
    ws.joining = true;
    clearTimeout(ws.joinTimer);

    if (disabled) {
      send(ws, { t: 'err', m: 'Game đang tạm đóng, quay lại sau nhé.' });
      ws.close();
      return;
    }
    if (!store) {
      send(ws, { t: 'err', m: 'Server chưa cấu hình Redis (biến REDIS_URL), chưa chơi chung được.' });
      ws.close();
      return;
    }

    let roomName = cleanRoomName(msg.room);
    // Only the listed rooms exist. Old links and typos land in the first one.
    if (roomList && !roomList.some((r) => r.id === roomName)) roomName = roomList[0].id;
    if (maxRooms && !rooms.has(roomName) && rooms.size >= maxRooms) {
      send(ws, { t: 'err', m: 'Server đang đầy phòng, thử lại sau nhé.' });
      ws.close();
      return;
    }
    const room = getRoom(roomName);
    room.sockets.add(ws);
    ws.room = room;
    await room.ready;

    const name = cleanName(msg.name);
    if (!name) {
      send(ws, { t: 'err', m: 'Nhập tên của bạn trước khi vào nhé.', code: 'name' });
      ws.close();
      return;
    }
    const token = cleanToken(msg.token) || crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    const gender = cleanGender(msg.gender);
    const role = cleanRole(msg.role);
    const company = cleanCompany(msg.company);
    const res = await store.join(roomName, {
      token,
      name,
      gender,
      role,
      company,
      fallbackName: 'Nhân viên ',
      connId: ws.connId,
      now,
      max: MAX_PLAYERS_PER_ROOM,
      ttlMs: presenceTtlMs,
      spawn: {
        x: WORLD.spawn.x + Math.round((Math.random() - 0.5) * 2 * WORLD.spawn.rx),
        y: WORLD.spawn.y + Math.round((Math.random() - 0.5) * 2 * WORLD.spawn.ry),
      },
    });

    if (res.taken) {
      send(ws, { t: 'err', m: 'Tên này đã có người dùng ở server này, đổi tên khác nhé.', code: 'name' });
      ws.close();
      return;
    }

    if (res.full) {
      send(ws, { t: 'err', m: 'Phòng đầy rồi, đổi phòng khác nhé.' });
      ws.close();
      return;
    }

    const p = {
      id: res.id,
      connId: ws.connId,
      name: '',
      x: res.pos.x,
      y: res.pos.y,
      d: res.pos.d,
      lastMove: now,
      lastHit: 0,
      mana: MANA.max,
      manaAt: now,
      lastEmote: 0,
      lastActive: now,
      moved: false,
      unsaved: false,
    };

    if (ws.closedFlag || ws.readyState !== 1) {
      // the socket died while we were joining; give the slot back
      await store.leave(roomName, p.id, ws.connId, null, Date.now());
      return;
    }
    ws.player = p;

    for (const id of res.pruned) if (id !== p.id) emit(roomName, { t: 'pl', id }, p.id);
    if (res.prevConn && res.prevConn !== ws.connId) emit(roomName, { t: 'kick', conn: res.prevConn });

    const snap = await store.read(roomName, { now: Date.now(), ttlMs: presenceTtlMs });
    const me = snap.players.find((x) => x.id === p.id);
    p.gender = gender;
    p.role = role;
    p.company = company;
    if (me) {
      p.name = me.name;
      p.gender = me.gender;
      p.role = me.role;
      p.company = me.company || '';
    } else {
      p.name = 'Nhân viên ' + p.id;
      snap.players.push({ id: p.id, name: p.name, gender, role, company, x: p.x, y: p.y, d: p.d, score: 0, breaks: 0 });
    }
    if (Object.values(snap.objects).some((s) => s.brokenAt > 0)) room.hasBroken = true;

    send(ws, {
      t: 'welcome',
      you: p.id,
      room: roomName,
      roomLabel: (roomList && roomList.find((r) => r.id === roomName) || {}).name || roomName,
      world: WORLD,
      types: TYPES,
      props: PROPS,
      zones: ZONES,
      colliders: COLLIDERS,
      hitRange: HIT_RANGE,
      mana: { ...MANA, v: MANA.max, ago: 0 },
      respawnMs,
      players: snap.players.map(publicPlayer),
      objects: OBJECTS.map((o) => objectView(o, snap.objects[o.id])),
    });
    send(ws, boardOf(snap));
    ws.ready = true;
    for (const out of ws.queue) if (ws.readyState === 1) ws.send(out);
    ws.queue = [];

    // A player taking over their own slot (planned renewal, or a quick
    // reconnect before the old socket was noticed gone) is not news to the room.
    if (!res.prevConn) {
      emit(roomName, { t: 'pj', p: publicPlayer(p) }, p.id);
      emit(roomName, boardOf(snap), p.id);
    }

    if (renewAfterMs > 0) {
      const jitter = Math.random() * Math.min(10000, renewAfterMs / 4);
      ws.renewTimer = setTimeout(() => renew(ws), Math.max(1000, renewAfterMs - jitter));
    }
  }

  // Ask the client to open a fresh connection before the platform's max duration
  // cuts this one. The new socket joins with the same token and takes over the
  // slot; the old one is kicked without anyone seeing a leave/join.
  async function renew(ws) {
    if (ws.readyState !== 1) return;
    if (ws.room) await housekeepRoom(ws.room).catch(() => {}); // persist position first
    send(ws, { t: 'renew' });
  }

  function handleMove(p, msg) {
    const x = Number(msg.x);
    const y = Number(msg.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const now = Date.now();
    const dt = Math.min(0.5, (now - p.lastMove) / 1000);
    let nx = clamp(x, 20, WORLD.w - 20);
    let ny = clamp(y, 20, WORLD.h - 20);
    const maxD = PLAYER_SPEED * dt * 1.4 + 24;
    const dx = nx - p.x;
    const dy = ny - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist > maxD) {
      nx = p.x + (dx / dist) * maxD;
      ny = p.y + (dy / dist) * maxD;
    }
    const fixed = slideMove(p.x, p.y, nx, ny); // furniture is solid for everyone, enforced here too
    const nx2 = clamp(fixed.x, 20, WORLD.w - 20);
    const ny2 = clamp(fixed.y, 20, WORLD.h - 20);
    if (Math.hypot(nx2 - p.x, ny2 - p.y) > 0.5) p.lastActive = now; // standing still and re-sending the same spot is not activity
    p.x = nx2;
    p.y = ny2;
    p.d = msg.d === -1 ? -1 : 1;
    p.lastMove = now;
    p.moved = true;
    p.unsaved = true;
  }

  // v is the stored value and ago says how long ago it was stored, so the client can rebuild the same baseline.
  function sendMana(ws, p, now) {
    send(ws, { t: 'mana', v: round1(p.mana), ago: Math.max(0, now - p.manaAt) });
  }

  async function handleHit(ws, p, msg) {
    const now = Date.now();
    if (now - p.lastHit < HIT_COOLDOWN_MS) return;
    if (!Number.isInteger(msg.id)) return;
    const o = OBJECTS[msg.id];
    if (!o) return;
    const dx = o.x - p.x;
    const dy = o.y - p.y;
    if (dx * dx + dy * dy > HIT_RANGE * HIT_RANGE) return;

    p.lastHit = now;
    p.lastActive = now;
    if (manaAt(p, now) < MANA.cost) {
      sendMana(ws, p, now); // out of mana: tell the client where it stands, do not hit
      return;
    }
    const roomName = ws.room.name;
    const t = TYPES[o.type];
    const r = await store.hit(roomName, { objId: o.id, defaultHp: t.hp, cost: t.cost, playerId: p.id, now });
    if (r.state === 'none') return; // already broken (maybe by someone on another instance): no charge
    const spent = Date.now();
    p.mana = Math.max(0, manaAt(p, spent) - MANA.cost);
    p.manaAt = spent;
    sendMana(ws, p, spent);

    emit(roomName, { t: 'hit', id: o.id, hp: r.hp, by: p.id });
    if (r.state === 'broke') {
      emit(roomName, { t: 'break', id: o.id, by: p.id, name: p.name, type: o.type, cost: t.cost });
      await emitBoard(roomName);
    }
  }

  function handleEmote(ws, p, msg) {
    const now = Date.now();
    if (now - p.lastEmote < EMOTE_COOLDOWN_MS) return;
    if (!Number.isInteger(msg.e) || msg.e < 0 || msg.e >= EMOTE_COUNT) return;
    p.lastEmote = now;
    p.lastActive = now;
    emit(ws.room.name, { t: 'emote', id: p.id, e: msg.e });
  }

  async function handleReset(ws, p) {
    p.lastActive = Date.now();
    const r = await store.reset(ws.room.name, { now: Date.now(), cooldownMs: RESET_COOLDOWN_MS });
    if (!r.ok) {
      send(ws, { t: 'err', m: 'IT đang bận, đợi ' + Math.ceil(r.waitMs / 1000) + 's nữa nhé.' });
      return;
    }
    emit(ws.room.name, { t: 'reset', by: p.name });
  }

  async function handleLeave(ws) {
    const p = ws.player;
    const roomName = ws.room ? ws.room.name : null;
    ws.player = null;
    detach(ws);
    if (!p || !roomName) return;
    // Only the socket that currently owns the slot removes the player, so a
    // stale close arriving after a reconnect cannot kick the new connection out.
    const removed = await store.leave(roomName, p.id, ws.connId, { x: p.x, y: p.y, d: p.d }, Date.now());
    if (removed) {
      emit(roomName, { t: 'pl', id: p.id });
      await emitBoard(roomName);
    }
  }

  // ------------------------------------------------------------ websocket ----
  function clientIp(req) {
    if (trustProxy) {
      const real = String(req.headers['x-real-ip'] || '').trim();
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      const ip = real || xff;
      if (ip) return ip.slice(0, 64);
    }
    return String(req.socket.remoteAddress || 'unknown').slice(0, 64);
  }

  function processMessage(ws, data) {
    const now = Date.now();
    ws.tokens = Math.min(60, ws.tokens + ((now - ws.lastRefill) / 1000) * 40);
    ws.lastRefill = now;
    if (ws.tokens < 1) return;
    ws.tokens -= 1;

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

    const fail = (e) => {
      log('[handler]', msg.t, e && e.message ? e.message : e);
      if (msg.t === 'join') {
        send(ws, { t: 'err', m: 'Máy chủ đang bận, thử lại sau nhé.' });
        ws.close(1011, 'store error');
      }
    };
    try {
      if (msg.t === 'join') {
        handleJoin(ws, msg).catch(fail);
        return;
      }
      const p = ws.player;
      if (!p) return;
      switch (msg.t) {
        case 'move':
          handleMove(p, msg);
          break;
        case 'hit':
          handleHit(ws, p, msg).catch(fail);
          break;
        case 'emote':
          handleEmote(ws, p, msg);
          break;
        case 'reset':
          handleReset(ws, p).catch(fail);
          break;
        default:
          break;
      }
    } catch (e) {
      fail(e);
    }
  }

  function onConnection(ws, req) {
    const ip = clientIp(req);
    ws.connId = instanceId + '-' + ++connSeq;
    ws.ip = ip;
    ws.on('error', () => {});
    if (maxConnections && conns.size >= maxConnections) {
      ws.close(1013, 'server full');
      return;
    }
    ws.isAlive = true;
    ws.tokens = 60;
    ws.lastRefill = Date.now();
    ws.player = null;
    ws.room = null;
    ws.joining = false;
    ws.ready = false;
    ws.queue = [];
    ws.open = false; // true once the per-IP lease is granted
    ws.leased = false;
    ws.closedFlag = false;
    ws.pending = [];
    conns.add(ws);
    ws.joinTimer = setTimeout(() => ws.close(4000, 'join timeout'), JOIN_TIMEOUT_MS);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data) => {
      if (!ws.open) {
        if (ws.pending.length < 20) ws.pending.push(data);
        return;
      }
      processMessage(ws, data);
    });

    ws.on('close', () => {
      ws.closedFlag = true;
      clearTimeout(ws.joinTimer);
      clearTimeout(ws.renewTimer);
      conns.delete(ws);
      if (ws.leased) store.releaseConn(ip, ws.connId).catch(() => {});
      handleLeave(ws).catch((e) => log('[leave]', e.message));
    });

    ws.on('error', () => {});

    if (!store || disabled) {
      ws.open = true; // let the join message through so it can be told why it cannot play
      return;
    }
    store
      .acquireConn(ip, ws.connId, { max: maxConnPerIp, ttlMs: IP_LEASE_TTL_MS, now: Date.now() })
      .then((ok) => {
        if (!ok) {
          ws.close(1013, 'too many connections');
          return;
        }
        ws.leased = true;
        if (ws.closedFlag) {
          store.releaseConn(ip, ws.connId).catch(() => {});
          return;
        }
        ws.open = true;
        const queued = ws.pending;
        ws.pending = [];
        for (const d of queued) processMessage(ws, d);
      })
      .catch((e) => {
        log('[acquire]', e.message);
        ws.close(1011, 'store error');
      });
  }

  // ---------------------------------------------------------------- loops ----
  // Position batches: each instance publishes only its own players that moved.
  function tickPositions() {
    for (const room of rooms.values()) {
      const l = [];
      for (const ws of room.sockets) {
        const p = ws.player;
        if (p && p.moved) {
          p.moved = false;
          l.push([p.id, Math.round(p.x), Math.round(p.y), p.d]);
        }
      }
      if (!l.length) continue;
      // With every player of the room on this instance there is nobody to tell through
      // Redis, so deliver locally. This is what keeps a quiet room from costing
      // ~10 Redis commands a second.
      if (room.remote) emit(room.name, { t: 'ps', l });
      else onEvent(room, JSON.stringify([0, { t: 'ps', l }, instanceId]));
    }
  }

  // One store call per second per room with local players: refresh presence,
  // persist positions, drop dead players, respawn broken objects.
  async function housekeepRoom(room) {
    if (room.busy) return;
    room.busy = true;
    try {
      const entries = [];
      const saved = [];
      for (const ws of room.sockets) {
        const p = ws.player;
        if (!p) continue;
        const e = { id: p.id, connId: ws.connId, pos: p.unsaved ? { x: p.x, y: p.y, d: p.d } : null };
        if (e.pos) saved.push(p);
        entries.push(e);
      }
      room.tick++;
      const sweep = room.hasBroken || room.tick % 5 === 0;
      const r = await store.housekeep(room.name, {
        now: Date.now(),
        ttlMs: presenceTtlMs,
        respawnMs,
        sweep,
        entries,
        instanceId,
      });
      room.remote = r.others > 0;
      for (const p of saved) p.unsaved = false;
      if (sweep && r.remaining === 0) room.hasBroken = false;
      for (const id of r.respawned) emit(room.name, { t: 'respawn', id });
      if (r.pruned.length) {
        for (const id of r.pruned) emit(room.name, { t: 'pl', id });
        await emitBoard(room.name);
      }
    } finally {
      room.busy = false;
    }
  }

  function attach(server, { path } = {}) {
    wss = new WebSocketServer({ server, path, maxPayload: 2048 });
    wss.on('connection', onConnection);

    timers.push(setInterval(tickPositions, TICK_MS));
    timers.push(
      setInterval(() => {
        for (const room of rooms.values()) {
          // every second while something is waiting to respawn, otherwise every couple of seconds
          if (!room.hasBroken && ++room.idle < IDLE_HOUSEKEEP_EVERY) continue;
          room.idle = 0;
          housekeepRoom(room).catch((e) => log('[housekeep]', e.message));
        }
      }, HOUSEKEEP_MS),
    );
    timers.push(
      setInterval(() => {
        const entries = [...conns].filter((ws) => ws.leased).map((ws) => ({ ip: ws.ip, connId: ws.connId }));
        store.touchConns(entries, { ttlMs: IP_LEASE_TTL_MS, now: Date.now() }).catch(() => {});
      }, IP_LEASE_REFRESH_MS),
    );
    timers.push(
      setInterval(() => {
        for (const ws of wss.clients) {
          if (!ws.isAlive) {
            ws.terminate();
            continue;
          }
          ws.isAlive = false;
          ws.ping();
        }
      }, 30000),
    );
    if (afkMs > 0) {
      timers.push(
        setInterval(() => {
          const now = Date.now();
          for (const ws of conns) {
            const p = ws.player;
            if (p && ws.ready && now - p.lastActive > afkMs) ws.close(4002, 'afk');
          }
        }, Math.min(5000, Math.max(100, afkMs / 4))),
      );
    }
    for (const t of timers) t.unref();
    return wss;
  }

  function stop() {
    for (const t of timers) clearInterval(t);
    timers.length = 0;
    if (!wss) return Promise.resolve();
    for (const ws of wss.clients) ws.terminate();
    return new Promise((resolve) => wss.close(() => resolve()));
  }

  return { attach, stop, instanceId };
}

module.exports = {
  createRealtime,
  cleanRoomName,
  cleanName,
  MANA,
  manaAt,
  HIT_RANGE,
  HIT_COOLDOWN_MS,
  RESET_COOLDOWN_MS,
  PRESENCE_TTL_MS,
  MAX_PLAYERS_PER_ROOM,
};
