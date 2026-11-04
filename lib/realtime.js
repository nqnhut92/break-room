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
const { WORLD, TYPES, PROPS, ZONES, OBJECTS, COLLIDERS, ROLE_IDS, PLAYER_RADIUS, BOSS_HOME, inBossZone, clearLine, slideMove } = require('./world');
const { BOSS, PLAYER, bossHpAt, playerHpAt, hitScale, createBossState, stepBoss, respawnDelay } = require('./boss');

const MAX_PLAYERS_PER_ROOM = 20;
const MAX_CONN_PER_IP = 10;
const JOIN_TIMEOUT_MS = 5000;
const HIT_RANGE = 110;
const HIT_COOLDOWN_MS = 180;
const EMOTE_COOLDOWN_MS = 800;
const CHAT_COOLDOWN_MS = 1000;
const CHAT_MAX_LEN = 120;

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

// Chat keeps < and > (so "<3" works): the client only ever renders it as text nodes, never as HTML.
function cleanChat(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX_LEN);
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

// hp is sent as the stored value plus how long ago it was stored, so every client can add the same regeneration.
function publicPlayer(p) {
  const now = Date.now();
  const hasHp = typeof p.hp === 'number';
  return {
    id: p.id, name: p.name, gender: p.gender === 'f' ? 'f' : 'm', role: cleanRole(p.role), company: p.company || '',
    hue: (p.id * 47) % 360, x: Math.round(p.x), y: Math.round(p.y), d: p.d, score: p.score,
    hp: hasHp ? round1(p.hp) : PLAYER.maxHp, hpAgo: hasHp ? Math.max(0, now - p.hpAt) : 0,
    deadMs: p.deadUntil > 0 ? Math.max(1, p.deadUntil - now) : 0,
  };
}

function objectView(o, state) {
  const full = TYPES[o.type].hp;
  if (!state) return { id: o.id, type: o.type, x: o.x, y: o.y, hp: full, broken: false };
  return { id: o.id, type: o.type, x: o.x, y: o.y, hp: state.brokenAt > 0 ? 0 : state.hp, broken: state.brokenAt > 0 };
}

function boardOf(snap) {
  // everyone online, best score first; equal scores (zero included) keep joining order (ids are handed out in order)
  const list = snap.players
    .slice()
    .sort((a, b) => b.score - a.score || a.id - b.id)
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
  bossEnabled = true, // false: no Sếp Tổng (players still have health, nothing hurts them)
  bossMaxHp = BOSS.maxHp, // tests shrink these so a fight fits in a second
  bossRespawnMs = 0, // 0 = a random 3 to 5 minutes
  playerRespawnMs = PLAYER.respawnMs,
}) {
  const bossCfg = { ...BOSS, maxHp: bossMaxHp };
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
      room = {
        name, sockets: new Set(), hasBroken: false, tick: 0, idle: 0, busy: false, remote: true, ready: null,
        peers: new Map(), // id -> { x, y, dead }: where everyone in the room is, from the position stream
        bossCache: null, // last { x, y, d, m, e } the boss's runner published
        bossDead: false,
        lead: false, // this instance runs the boss of the room right now
        bossSt: null, // the boss's walking/punching state while we run it
        bossLast: 0,
        bossSent: 0,
        lockBusy: false,
      };
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
    trackPeers(room, msg);

    if (msg.t === 'kick') {
      for (const ws of room.sockets) if (ws.connId === msg.conn) ws.close(4001, 'replaced');
      return;
    }
    if (msg.t === 'break') room.hasBroken = true;
    else if (msg.t === 'reset') room.hasBroken = false;
    else if (msg.t === 'bstrike') resolveStrike(room, msg); // every instance hurts its own players, from their true positions

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

  // ------------------------------------------------------------ health ----
  const isDown = (p) => p.deadUntil > 0;

  // Keep a rough picture of where everyone in the room is (all instances), for the boss's eyes and for hit scaling.
  function trackPeers(room, msg) {
    switch (msg.t) {
      case 'ps':
        for (const [id, x, y] of msg.l) {
          const e = room.peers.get(id);
          if (e) {
            e.x = x;
            e.y = y;
          } else room.peers.set(id, { x, y, dead: false });
        }
        break;
      case 'pj':
        room.peers.set(msg.p.id, { x: msg.p.x, y: msg.p.y, dead: msg.p.deadMs > 0 });
        break;
      case 'pl':
        room.peers.delete(msg.id);
        break;
      case 'down': {
        const e = room.peers.get(msg.id);
        if (e) e.dead = true;
        break;
      }
      case 'up':
        room.peers.set(msg.id, { x: msg.x, y: msg.y, dead: false });
        break;
      case 'boss':
        room.bossCache = msg;
        break;
      case 'bdead':
        room.bossDead = true;
        if (room.lead && room.bossSt) room.bossSt.mode = 'dead';
        break;
      case 'bup':
        room.bossDead = false;
        room.bossCache = null;
        if (room.lead) room.bossSt = createBossState();
        break;
      default:
        break;
    }
  }

  function spawnPoint() {
    return {
      x: WORLD.spawn.x + Math.round((Math.random() - 0.5) * 2 * WORLD.spawn.rx),
      y: WORLD.spawn.y + Math.round((Math.random() - 0.5) * 2 * WORLD.spawn.ry),
    };
  }

  function saveHp(room, p) {
    store.setHp(room.name, p.id, { hp: p.hp, at: p.hpAt, deadUntil: p.deadUntil }).catch((e) => log('[setHp]', e.message));
  }

  // The boss's fist reached this player: take the health off, or knock them out.
  function hurt(room, p, dmg, now) {
    if (isDown(p)) return;
    const left = playerHpAt(p.hp, p.hpAt, now) - dmg;
    p.lastActive = now;
    if (left > 0) {
      p.hp = left;
      p.hpAt = now;
      saveHp(room, p);
      emit(room.name, { t: 'hp', id: p.id, hp: round1(left), dmg });
      return;
    }
    p.hp = 0;
    p.hpAt = now;
    p.deadUntil = now + playerRespawnMs;
    p.moved = false;
    saveHp(room, p);
    emit(room.name, { t: 'down', id: p.id, ms: playerRespawnMs, x: Math.round(p.x), y: Math.round(p.y), dmg });
  }

  function resolveStrike(room, msg) {
    const now = Date.now();
    for (const ws of room.sockets) {
      const p = ws.player;
      if (!p || !ws.ready || isDown(p)) continue;
      if (Math.hypot(p.x - msg.x, p.y - msg.y) <= msg.r + PLAYER_RADIUS) hurt(room, p, msg.dmg, now);
    }
  }

  // Knocked out for playerRespawnMs, then back at the lobby with a full bar (never where they fell).
  function revive(room, p, now) {
    const s = spawnPoint();
    p.deadUntil = 0;
    p.hp = PLAYER.maxHp;
    p.hpAt = now;
    p.x = s.x;
    p.y = s.y;
    p.d = 1;
    p.lastMove = now;
    p.lastActive = now;
    p.unsaved = true;
    p.moved = false;
    saveHp(room, p);
    emit(room.name, { t: 'up', id: p.id, x: Math.round(s.x), y: Math.round(s.y), d: 1 });
  }

  function reviveTick() {
    const now = Date.now();
    for (const ws of conns) {
      const p = ws.player;
      if (p && ws.ready && ws.room && p.deadUntil > 0 && now >= p.deadUntil) revive(ws.room, p, now);
    }
  }

  // --------------------------------------------------------------- boss ----
  // One instance at a time runs the boss of a room (whoever holds the store's lease); it walks, notices people and
  // throws punches, and publishes what it does. Everyone else just relays it. Each instance applies a punch to its
  // own players, so nobody needs to know where a remote player really is.
  function bossTargets(room) {
    const out = [];
    const mine = new Set();
    for (const ws of room.sockets) {
      const p = ws.player;
      if (!p || !ws.ready) continue;
      mine.add(p.id);
      if (!isDown(p) && inBossZone(p.x, p.y)) out.push({ id: p.id, x: p.x, y: p.y });
    }
    for (const [id, e] of room.peers) {
      if (!mine.has(id) && !e.dead && inBossZone(e.x, e.y)) out.push({ id, x: e.x, y: e.y });
    }
    return out;
  }

  const bossSnapshot = (b, e) => ({ t: 'boss', x: Math.round(b.x), y: Math.round(b.y), d: Math.round(b.d * 100) / 100, m: b.mode, e });

  function bossTick(room) {
    if (!bossEnabled || !room.lead) return;
    if (!room.bossSt) {
      room.bossSt = createBossState();
      const c = room.bossCache;
      if (c) {
        room.bossSt.x = c.x;
        room.bossSt.y = c.y;
        room.bossSt.d = c.d;
      }
    }
    const b = room.bossSt;
    if (room.bossDead) b.mode = 'dead';
    if (b.mode === 'dead') return;
    const now = Date.now();
    const dt = Math.min(0.25, room.bossLast ? (now - room.bossLast) / 1000 : TICK_MS / 1000);
    room.bossLast = now;
    const targets = bossTargets(room);
    const before = b.mode + ':' + Math.round(b.x) + ':' + Math.round(b.y);
    for (const ev of stepBoss(b, dt, targets)) {
      if (ev.type === 'windup') emit(room.name, { t: 'bwind', x: Math.round(ev.x), y: Math.round(ev.y), r: ev.r, ms: ev.ms });
      else if (ev.type === 'strike') emit(room.name, { t: 'bstrike', x: Math.round(ev.x), y: Math.round(ev.y), r: ev.r, dmg: ev.dmg });
    }
    // publish where it is: 10 times a second while it fights, 5 while it walks, nothing while it stands still
    const busy = b.mode !== 'patrol';
    const changed = before !== b.mode + ':' + Math.round(b.x) + ':' + Math.round(b.y);
    if (changed && now - room.bossSent >= (busy ? 90 : 190)) {
      room.bossSent = now;
      const snap = bossSnapshot(b, targets.length);
      if (room.remote) emit(room.name, snap);
      else onEvent(room, JSON.stringify([0, snap, instanceId]));
    }
  }

  // Once a second per room: hold or renew the lease, and bring the boss back when its time is up.
  async function bossHousekeep(room) {
    if (!bossEnabled || room.lockBusy) return;
    room.lockBusy = true;
    try {
      const now = Date.now();
      const ok = await store.bossLock(room.name, instanceId, { now, ttlMs: 3000 });
      if (!ok) {
        room.lead = false;
        return;
      }
      if (!room.lead) {
        // just took over: learn where everyone is and whether the boss is alive
        const snap = await store.read(room.name, { now, ttlMs: presenceTtlMs });
        for (const pl of snap.players) {
          if (!room.peers.has(pl.id)) room.peers.set(pl.id, { x: pl.x, y: pl.y, dead: pl.deadUntil > now });
        }
        const st = await store.bossGet(room.name, { now, maxHp: bossCfg.maxHp });
        room.bossDead = st.dead;
        room.bossLast = 0;
        room.lead = true;
      }
      if (room.bossDead) {
        const back = await store.bossRespawn(room.name, { now: Date.now(), maxHp: bossCfg.maxHp });
        if (back) emit(room.name, { t: 'bup', x: BOSS_HOME.x, y: BOSS_HOME.y });
      }
    } finally {
      room.lockBusy = false;
    }
  }

  async function handleBossHit(ws, p) {
    const now = Date.now();
    if (!bossEnabled || isDown(p) || now - p.lastHit < HIT_COOLDOWN_MS) return;
    const room = ws.room;
    const c = room.bossCache || { x: BOSS_HOME.x, y: BOSS_HOME.y, e: 1 };
    if (room.bossDead) return;
    if (Math.hypot(c.x - p.x, c.y - p.y) > bossCfg.reach) return;
    if (!clearLine(p.x, p.y, c.x, c.y)) return; // a wall or a rack is in the way
    p.lastHit = now;
    p.lastActive = now;
    if (manaAt(p, now) < MANA.cost) {
      sendMana(ws, p, now);
      return;
    }
    const roomName = room.name;
    const respawnIn = bossRespawnMs || respawnDelay(); // only used if this blow is the one that finishes it
    const r = await store.bossHit(roomName, {
      playerId: p.id,
      dmg: bossCfg.hitDmg / hitScale(Math.max(1, c.e || 1), bossCfg),
      now,
      cfg: bossCfg,
      respawnAt: now + respawnIn,
      bounty: bossCfg.bounty,
    });
    if (r.state === 'dead') return; // beaten a moment ago (maybe by someone on another instance): no charge
    const spent = Date.now();
    p.mana = Math.max(0, manaAt(p, spent) - MANA.cost);
    p.manaAt = spent;
    sendMana(ws, p, spent);
    if (r.state === 'hit') {
      emit(roomName, { t: 'bhp', hp: round1(r.hp), by: p.id });
      return;
    }
    // it fell: tell everyone who did what, and credit the bounty
    const snap = await store.read(roomName, { now: Date.now(), ttlMs: presenceTtlMs });
    const names = new Map(snap.players.map((x) => [x.id, x.name]));
    const shares = r.shares
      .map((s) => ({ id: s.id, name: names.get(s.id) || 'Nhân viên ' + s.id, dmg: Math.round(s.dmg), bounty: s.bounty }))
      .sort((a, b) => b.dmg - a.dmg);
    emit(roomName, { t: 'bhp', hp: 0, by: p.id });
    emit(roomName, { t: 'bdead', by: p.id, shares, bounty: bossCfg.bounty, respawnMs: respawnIn });
    await emitBoard(roomName);
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
      lastChat: 0,
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
    p.hp = PLAYER.maxHp;
    p.hpAt = now;
    p.deadUntil = 0;
    if (me && typeof me.hp === 'number') {
      // a refresh or a renewal must not heal or revive anyone: health and the knock-out timer live in the store
      p.hp = me.hp;
      p.hpAt = me.hpAt;
      if (me.deadUntil > now) p.deadUntil = me.deadUntil;
      else if (me.deadUntil > 0) {
        // the time was up while nobody was around: back on their feet at the lobby
        const s = spawnPoint();
        p.hp = PLAYER.maxHp;
        p.hpAt = now;
        p.x = s.x;
        p.y = s.y;
        me.x = s.x;
        me.y = s.y;
        p.unsaved = true;
        saveHp(room, p);
      }
    }
    for (const pl of snap.players) if (!room.peers.has(pl.id)) room.peers.set(pl.id, { x: pl.x, y: pl.y, dead: pl.deadUntil > now });
    if (me) {
      p.name = me.name;
      p.gender = me.gender;
      p.role = me.role;
      p.company = me.company || '';
      me.hp = p.hp;
      me.hpAt = p.hpAt;
      me.deadUntil = p.deadUntil;
    } else {
      p.name = 'Nhân viên ' + p.id;
      snap.players.push({ id: p.id, name: p.name, gender, role, company, x: p.x, y: p.y, d: p.d, score: 0, breaks: 0, hp: p.hp, hpAt: p.hpAt, deadUntil: p.deadUntil });
    }
    if (Object.values(snap.objects).some((s) => s.brokenAt > 0)) room.hasBroken = true;

    const bossNow = bossEnabled ? await store.bossGet(roomName, { now: Date.now(), maxHp: bossCfg.maxHp }) : null;
    const bc = room.bossCache || { x: BOSS_HOME.x, y: BOSS_HOME.y, d: 0, m: 'patrol', e: 0 };
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
      player: { max: PLAYER.maxHp, regenDelayMs: PLAYER.regenDelayMs, regenPerSec: PLAYER.regenPerSec },
      boss: bossNow && {
        name: bossCfg.name, maxHp: bossCfg.maxHp, baseRegenPerSec: bossCfg.baseRegenPerSec, regenPerSec: bossCfg.regenPerSec,
        regenDelayMs: bossCfg.regenDelayMs, reach: bossCfg.reach, radius: bossCfg.radius, windupMs: bossCfg.windupMs,
        hp: round1(bossNow.hp), ago: Math.max(0, Date.now() - bossNow.at), dead: bossNow.dead || room.bossDead,
        respawnMs: bossNow.dead ? Math.max(0, bossNow.respawnAt - Date.now()) : 0,
        x: bc.x, y: bc.y, d: bc.d, m: bc.m, e: bc.e,
      },
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
    if (isDown(p)) return; // knocked out: no walking
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
    if (isDown(p) || now - p.lastHit < HIT_COOLDOWN_MS) return;
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
    if (isDown(p) || now - p.lastEmote < EMOTE_COOLDOWN_MS) return;
    if (!Number.isInteger(msg.e) || msg.e < 0 || msg.e >= EMOTE_COUNT) return;
    p.lastEmote = now;
    p.lastActive = now;
    emit(ws.room.name, { t: 'emote', id: p.id, e: msg.e });
  }

  // Room chat: one broadcast per message, nothing is stored. Late joiners see no history.
  function handleChat(ws, p, msg) {
    const text = cleanChat(msg.text);
    if (!text) return;
    const now = Date.now();
    if (now - p.lastChat < CHAT_COOLDOWN_MS) {
      send(ws, { t: 'err', m: 'Nhắn chậm thôi, chờ một chút nhé.' });
      return;
    }
    p.lastChat = now;
    p.lastActive = now;
    emit(ws.room.name, { t: 'chat', id: p.id, name: p.name, text });
  }

  async function handleReset(ws, p) {
    if (isDown(p)) return;
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
        case 'bhit':
          handleBossHit(ws, p).catch(fail);
          break;
        case 'emote':
          handleEmote(ws, p, msg);
          break;
        case 'chat':
          handleChat(ws, p, msg);
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
        for (const room of rooms.values()) bossTick(room);
      }, TICK_MS),
    );
    timers.push(
      setInterval(() => {
        reviveTick();
        for (const room of rooms.values()) bossHousekeep(room).catch((e) => log('[boss]', e.message));
      }, HOUSEKEEP_MS),
    );
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
  BOSS,
  PLAYER,
  HIT_RANGE,
  HIT_COOLDOWN_MS,
  RESET_COOLDOWN_MS,
  PRESENCE_TTL_MS,
  MAX_PLAYERS_PER_ROOM,
};
