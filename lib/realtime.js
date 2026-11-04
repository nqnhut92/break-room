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
const { WORLD, TYPES, PROPS, ZONES, OBJECTS, COLLIDERS, ROLE_IDS, PLAYER_RADIUS, BOSS_HOME, BOSS_ROOM, inBossZone, clearLine, slideMove } = require('./world');
const { DUEL, emptyDuel, activeDuel, nextDuel, duelPosition } = require('./duel');
const { SNAKE, stepSnakes } = require('./snakes');
const { BOSS, PLAYER, bossHpAt, playerHpAt, hitScale, createBossState, stepBoss, respawnDelay } = require('./boss');

const MAX_PLAYERS_PER_ROOM = 20;
const MAX_CONN_PER_IP = 10;
const JOIN_TIMEOUT_MS = 5000;
const HIT_RANGE = 110;
const MILK_TEA_RANGE_MULTIPLIER = 2;
const cleanSkill = (skill) => skill === 'milkTea' || skill === 'electric' ? skill : 'hammer';
// Ranged hits (the milk tea throw reaches twice as far) do half the damage of a melee hit, on objects and on the boss.
const RANGED_DAMAGE_MULTIPLIER = 0.5;
const damageFactor = (skill) => (cleanSkill(skill) === 'milkTea' ? RANGED_DAMAGE_MULTIPLIER : 1);
const HIT_COOLDOWN_MS = 180;
const EMOTE_COOLDOWN_MS = 800;
const SWING_COOLDOWN_MS = 220; // a swing at thin air: free, only shown to the room
const CHAT_COOLDOWN_MS = 1000;
const CHAT_MAX_LEN = 120;

// Mana: every smash costs some. Mana comes back slowly while you keep swinging and much faster once you
// stop for a moment (the RPG "out of combat" rule), so a burst is possible but nonstop smashing is paced.
// The server keeps it per connection (like the hit cooldown) and the client mirrors the same formula.
const MANA = { max: 100, cost: 5, regen: 3, restRegen: 12, restMs: 2000 };

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
  const v = { id: o.id, type: o.type, x: o.x, y: o.y };
  if (o.rot) v.rot = o.rot;
  if (o.arm) v.arm = true;
  if (o.itDesk) v.itDesk = true;
  if (!state) return { ...v, hp: full, broken: false };
  return { ...v, hp: state.brokenAt > 0 ? 0 : state.hp, broken: state.brokenAt > 0 };
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
  build = require('./build'), // { version, builtAt }: which deploy this instance belongs to
  updateGraceMs = 20000, // how long players of an older deploy get to see the notice before they are disconnected
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
  drinkIntervalMs = 5 * 60 * 1000,
  drinkWindowMs = 5000,
  duelConfig = DUEL, // tests can shorten the same server-side schedule
  bossEnabled = true, // false: no VKL (players still have health, nothing hurts them)
  bossMaxHp = BOSS.maxHp, // tests shrink these so a fight fits in a second
  bossRespawnMs = 0, // 0 = the BOSS.respawnMinMs..respawnMaxMs range (one minute by default)
  playerRespawnMs = PLAYER.respawnMs,
}) {
  const bossCfg = { ...BOSS, maxHp: bossMaxHp };
  const instanceId = crypto.randomBytes(4).toString('hex');
  let connSeq = 0;
  const conns = new Set();
  const rooms = new Map(); // rooms that have at least one local socket

  // ---- new deploys: an instance of a newer build announces itself on a shared channel; an older instance then tells
  // its players to reload and disconnects them after a short grace (they come back through the new deploy).
  const BUILD_CHANNEL = '__build';
  let newerBuild = null; // { v, t } of the newest build seen that is newer than ours
  function onBuildAnnounce(data) {
    let m;
    try {
      m = JSON.parse(data);
    } catch (e) {
      return;
    }
    if (!m || typeof m.v !== 'string' || !(m.t > build.builtAt) || m.v === build.version) return;
    if (newerBuild && newerBuild.t >= m.t) return;
    newerBuild = { v: m.v, t: m.t };
    log('[build] newer deploy ' + m.v + ' seen, telling local players to reload');
    for (const room of rooms.values()) {
      for (const ws of room.sockets) {
        send(ws, { t: 'update', v: m.v, ms: updateGraceMs });
        const timer = setTimeout(() => ws.close(4003, 'update'), updateGraceMs);
        timer.unref();
      }
    }
  }
  async function watchBuild() {
    if (!store || build.version === 'dev') return;
    try {
      await store.subscribe(BUILD_CHANNEL, onBuildAnnounce);
      await store.publish(BUILD_CHANNEL, JSON.stringify({ v: build.version, t: build.builtAt }));
    } catch (e) {
      log('[build]', e.message);
    }
  }
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
        snakes: new Map(), snakeWaves: new Set(), snakeLast: 0, snakeSaved: 0,
        drinkNextAt: 0, drinkBusy: false, drinkOffered: 0, drinkApplied: 0,
        peers: new Map(), // id -> { x, y, dead }: where everyone in the room is, from the position stream
        bossCache: null, // last { x, y, d, m, e } the boss's runner published
        bossDead: false,
        duel: emptyDuel(), duelBusy: false, duelEventVersion: 0, bossCastUntil: 0,
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
    if (msg.t === 'bduel' && (msg.state.version <= room.duelEventVersion || msg.state.version < room.duel.version)) return;
    trackPeers(room, msg);

    if (msg.t === 'kick') {
      for (const ws of room.sockets) if (ws.connId === msg.conn) ws.close(4001, 'replaced');
      return;
    }
    if (msg.t === 'break') room.hasBroken = true;
    else if (msg.t === 'reset') room.hasBroken = false;
    else if (msg.t === 'snakeBite') resolveSnakeBite(room, msg);
    else if (msg.t === 'drink') applyDrink(room, msg);
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
      case 'bduel':
        room.duel = msg.state;
        room.duelEventVersion = msg.state.version;
        if (activeDuel(room.duel, Date.now())) {
          room.bossCastUntil = Date.now() + 1200;
          for (const m of room.duel.moves) {
            const peer = room.peers.get(m.id);
            if (peer && !peer.dead) { peer.x = m.x; peer.y = m.y; }
            for (const ws of room.sockets) if (ws.player?.id === m.id && !isDown(ws.player)) forcePosition(ws.player, m, Date.now());
          }
          if (room.bossSt) {
            // Interrupt an old area strike before the duel starts.
            room.bossSt.mode = 'chase'; room.bossSt.strike = null;
            room.bossSt.tid = room.duel.target; room.bossSt.retarget = 0;
          }
        }
        break;
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
      case 'snakeSpawn':
        room.bossCastUntil = Date.now() + 1300;
        for (const s of msg.snakes) room.snakes.set(s.id, { ...s });
        for (const percent of msg.waves) room.snakeWaves.add(percent);
        break;
      case 'snakePs':
        for (const p of msg.list) { const s = room.snakes.get(p.id); if (s) Object.assign(s, p); }
        break;
      case 'snakeHit': {
        const s = room.snakes.get(msg.id);
        if (msg.hp <= 0) room.snakes.delete(msg.id);
        else if (s) s.hp = msg.hp;
        break;
      }
      case 'boss':
        room.bossCache = msg;
        break;
      case 'bdead':
        room.bossDead = true;
        if (room.lead && room.bossSt) room.bossSt.mode = 'dead';
        break;
      case 'bup':
        room.snakes.clear(); room.snakeWaves.clear();
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
      if (activeDuel(room.duel, now) && p.id !== room.duel.target) continue;
      if (msg.skill === 'newProcess' && !inBossZone(p.x, p.y)) continue;
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

  async function refreshDrink(room) {
    if (room.drinkBusy) return;
    room.drinkBusy = true;
    try {
      const now = Date.now();
      const offer = await store.drinkOffer(room.name, { now, intervalMs: drinkIntervalMs, windowMs: drinkWindowMs });
      room.drinkNextAt = offer.nextAt;
      if (offer.available && room.drinkOffered !== offer.id) {
        room.drinkOffered = offer.id;
        emit(room.name, { t: 'drinkOffer', id: offer.id, ms: Math.max(0, offer.endsAt - Date.now()) });
      }
    } finally { room.drinkBusy = false; }
  }

  async function handleDrink(ws, p, msg) {
    if (!Number.isSafeInteger(msg.id)) return;
    const now = Date.now();
    const state = await store.drinkOffer(ws.room.name, { now, intervalMs: drinkIntervalMs, windowMs: drinkWindowMs });
    if (!state.available || state.id !== msg.id) return;
    const result = await store.drinkOffer(ws.room.name, { now: Date.now(), intervalMs: drinkIntervalMs, windowMs: drinkWindowMs, claim: true, offerId: msg.id });
    if (result.claimed && result.id === msg.id) {
      p.lastActive = now;
      emit(ws.room.name, { t: 'drink', id: result.id, name: p.name });
    }
  }

  function applyDrink(room, msg) {
    if (room.drinkApplied >= msg.id) return;
    room.drinkApplied = msg.id;
    const now = Date.now();
    for (const ws of room.sockets) {
      const p = ws.player;
      if (!p || !ws.ready) continue;
      if (isDown(p)) revive(room, p, now);
      p.hp = PLAYER.maxHp;
      p.hpAt = now;
      p.mana = MANA.max;
      p.manaAt = now;
      saveHp(room, p);
      sendMana(ws, p, now);
      emit(room.name, { t: 'heal', id: p.id, hp: PLAYER.maxHp });
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

  function forcePosition(p, pos, now) {
    p.x = pos.x; p.y = pos.y;
    p.lastMove = now;
    p.moved = true; p.unsaved = true;
    // Ignore in-flight movement sent before the pull/blow animation finishes.
    p.forcedUntil = now + (pos.kind === 'pull' ? DUEL.pullMs : DUEL.blowMs);
  }
  const duelView = room => ({ ...room.duel, ms: room.bossDead ? 0 : Math.max(0, room.duel.until - Date.now()), bounds: { ...BOSS_ROOM, radius: PLAYER_RADIUS }, pullMs: DUEL.pullMs, blowMs: DUEL.blowMs });
  async function duelTick(room, now) {
    if (room.duelBusy) return;
    const state = nextDuel(room.duel, now, snakeTargets(room), !room.bossDead, Math.random, duelConfig);
    if (!state) return;
    room.duelBusy = true;
    try {
      const expected = room.duel.version;
      const saved = await store.duelSave(room.name, { owner: instanceId, now, expected, state });
      if (!saved) {
        const fresh = await store.duelGet(room.name, { now: Date.now() });
        if (fresh.version > room.duel.version) room.duel = fresh;
        return;
      }
      // onEvent updates local authority too; all instances receive the same committed move list.
      emit(room.name, { t: 'bduel', state, ms: Math.max(0, state.until - Date.now()), bounds: { ...BOSS_ROOM, radius: PLAYER_RADIUS }, pullMs: DUEL.pullMs, blowMs: DUEL.blowMs, x: room.bossSt?.x || BOSS_HOME.x, y: room.bossSt?.y || BOSS_HOME.y });
    } catch (e) { log('[duel]', e.message); }
    finally { room.duelBusy = false; }
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
    const now = Date.now();
    duelTick(room, now);
    if (b.mode === 'dead' || now < room.bossCastUntil) { room.bossLast = now; return; }
    const dt = Math.min(0.25, room.bossLast ? (now - room.bossLast) / 1000 : TICK_MS / 1000);
    room.bossLast = now;
    const targets = bossTargets(room).filter(p => !activeDuel(room.duel, now) || p.id === room.duel.target);
    const before = b.mode + ':' + Math.round(b.x) + ':' + Math.round(b.y);
    for (const ev of stepBoss(b, dt, targets)) {
      if (ev.type === 'windup') emit(room.name, { t: 'bwind', skill: ev.skill, x: Math.round(ev.x), y: Math.round(ev.y), r: ev.r, ms: ev.ms });
      else if (ev.type === 'strike') emit(room.name, { t: 'bstrike', skill: ev.skill, x: Math.round(ev.x), y: Math.round(ev.y), r: ev.r, dmg: ev.dmg });
    }
    if (activeDuel(room.duel, now)) {
      const p = duelPosition(room.duel, room.duel.target, b.x, b.y, now);
      b.x = p.x; b.y = p.y;
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
        room.snakes = new Map((await store.snakeList(room.name, { now })).map(s => [s.id, s]));
        room.bossDead = st.dead;
        room.duel = await store.duelGet(room.name, { now });
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

  function snakeTargets(room) {
    const targets = new Map([...room.peers].map(([id, p]) => [id, { id, ...p }]));
    for (const ws of room.sockets) if (ws.ready && ws.player) {
      const p = ws.player;
      targets.set(p.id, { id: p.id, x: p.x, y: p.y, dead: isDown(p) });
    }
    return [...targets.values()];
  }
  function snakeTick(room) {
    if (!room.lead || !room.snakes.size) { room.snakeLast = 0; return; }
    const now = Date.now();
    const dt = Math.min(0.25, room.snakeLast ? (now - room.snakeLast) / 1000 : 0.1);
    room.snakeLast = now;
    for (const bite of stepSnakes([...room.snakes.values()], dt, snakeTargets(room), now)) emit(room.name, { t: 'snakeBite', ...bite });
    const list = [...room.snakes.values()].map(s => ({ id: s.id, x: Math.round(s.x), y: Math.round(s.y), d: s.d }));
    if (room.remote) emit(room.name, { t: 'snakePs', list });
    else onEvent(room, JSON.stringify([0, { t: 'snakePs', list }, instanceId]));
    if (now - room.snakeSaved >= 1000) {
      room.snakeSaved = now;
      store.snakeMove(room.name, list, now).catch(e => log('[snakes]', e.message));
    }
  }
  function resolveSnakeBite(room, msg) {
    for (const ws of room.sockets) {
      const p = ws.player;
      if (ws.ready && p && p.id === msg.target && Math.hypot(p.x - msg.x, p.y - msg.y) <= SNAKE.biteRange + PLAYER_RADIUS) hurt(room, p, msg.dmg, Date.now());
    }
  }
  async function handleSnakeHit(ws, p, msg) {
    const now = Date.now(), room = ws.room;
    if (isDown(p) || now - p.lastHit < HIT_COOLDOWN_MS || !Number.isInteger(msg.id)) return;
    const snake = room.snakes.get(msg.id);
    if (!snake || Math.hypot(snake.x - p.x, snake.y - p.y) > HIT_RANGE * (msg.skill === 'milkTea' ? MILK_TEA_RANGE_MULTIPLIER : 1)) return;
    if (!clearLine(p.x, p.y, snake.x, snake.y)) return;
    p.lastHit = now;
    p.lastActive = now;
    if (manaAt(p, now) < MANA.cost) { sendMana(ws, p, now); return; }
    const result = await store.snakeHit(room.name, msg.id, now);
    if (!result) return;
    p.mana = Math.max(0, manaAt(p, now) - MANA.cost); p.manaAt = now;
    sendMana(ws, p, now);
    emit(room.name, { t: 'snakeHit', id: msg.id, hp: result.hp, by: p.id, skill: cleanSkill(msg.skill) });
  }

  async function handleBossHit(ws, p, msg) {
    const now = Date.now();
    if (!bossEnabled || isDown(p) || now - p.lastHit < HIT_COOLDOWN_MS) return;
    const room = ws.room;
    const c = room.bossCache || { x: BOSS_HOME.x, y: BOSS_HOME.y, e: 1 };
    if (room.bossDead || (activeDuel(room.duel, now) && p.id !== room.duel.target)) return;
    if (Math.hypot(c.x - p.x, c.y - p.y) > bossCfg.reach * (msg.skill === 'milkTea' ? MILK_TEA_RANGE_MULTIPLIER : 1)) return;
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
      dmg: (bossCfg.hitDmg / hitScale(Math.max(1, c.e || 1), bossCfg)) * damageFactor(msg.skill),
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
    if (r.state === 'hit' && [70, 40, 10].some(percent => r.hp <= bossCfg.maxHp * percent / 100 && !room.snakeWaves.has(percent))) {
      const snap = await store.read(roomName, { now: Date.now(), ttlMs: presenceTtlMs });
      const wave = await store.summonSnakes(roomName, { maxHp: bossCfg.maxHp, count: Math.min(MAX_PLAYERS_PER_ROOM, snap.players.length), x: c.x, y: c.y, now: Date.now() });
      for (const percent of [70, 40, 10]) if (r.hp <= bossCfg.maxHp * percent / 100) room.snakeWaves.add(percent);
      if (wave.snakes.length) emit(roomName, { t: 'snakeSpawn', x: c.x, y: c.y, ...wave });
    }
    if (r.state === 'hit') {
      emit(roomName, { t: 'bhp', hp: round1(r.hp), by: p.id, skill: cleanSkill(msg.skill) });
      return;
    }
    // it fell: tell everyone who did what, and credit the bounty
    const snap = await store.read(roomName, { now: Date.now(), ttlMs: presenceTtlMs });
    const names = new Map(snap.players.map((x) => [x.id, x.name]));
    const shares = r.shares
      .map((s) => ({ id: s.id, name: names.get(s.id) || 'Nhân viên ' + s.id, dmg: Math.round(s.dmg), bounty: s.bounty }))
      .sort((a, b) => b.dmg - a.dmg);
    emit(roomName, { t: 'bhp', hp: 0, by: p.id, skill: cleanSkill(msg.skill) });
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
      lastSwing: 0,
      lastSkill: 0,
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
    if (bossNow) room.bossDead = bossNow.dead;
    const duel = bossEnabled ? await store.duelGet(roomName, { now: Date.now() }) : emptyDuel();
    if (duel.version >= room.duel.version) room.duel = duel;
    if (!bossNow?.dead && !isDown(p)) {
      const fixed = duelPosition(room.duel, p.id, p.x, p.y, Date.now());
      if (fixed.x !== p.x || fixed.y !== p.y) { p.x = fixed.x; p.y = fixed.y; p.unsaved = true; }
      if (me) { me.x = p.x; me.y = p.y; }
    }
    const bc = room.bossCache || { x: BOSS_HOME.x, y: BOSS_HOME.y, d: 0, m: 'patrol', e: 0 };
    const snakes = await store.snakeList(roomName, { now: Date.now() });
    for (const snake of snakes) if (!room.snakes.has(snake.id)) room.snakes.set(snake.id, snake);
    const drink = await store.drinkOffer(roomName, { now: Date.now(), intervalMs: drinkIntervalMs, windowMs: drinkWindowMs });
    room.drinkNextAt = drink.available ? Date.now() : drink.nextAt;
    send(ws, {
      t: 'welcome',
      snakes,
      duel: duelView(room),
      drink: { id: drink.id, ms: Math.max(0, drink.endsAt - Date.now()), available: drink.available },
      you: p.id,
      room: roomName,
      maxPlayers: MAX_PLAYERS_PER_ROOM,
      build: build.version,
      newer: newerBuild ? newerBuild.v : undefined, // set when this instance is already known to be out of date
      roomLabel: (roomList && roomList.find((r) => r.id === roomName) || {}).name || roomName,
      world: WORLD,
      types: TYPES,
      props: PROPS,
      zones: ZONES,
      colliders: COLLIDERS,
      hitRange: HIT_RANGE,
      milkTeaRangeMultiplier: MILK_TEA_RANGE_MULTIPLIER,
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

  function handleMove(ws, p, msg) {
    const room = ws.room;
    if (isDown(p)) return; // knocked out: no walking
    const x = Number(msg.x);
    const y = Number(msg.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const now = Date.now();
    if (now < (p.forcedUntil || 0)) {
      send(ws, { t: 'position', id: p.id, x: p.x, y: p.y });
      return;
    }
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
    const allowed = room.bossDead ? fixed : duelPosition(room.duel, p.id, fixed.x, fixed.y, now);
    const nx2 = clamp(allowed.x, 20, WORLD.w - 20);
    const ny2 = clamp(allowed.y, 20, WORLD.h - 20);
    if (allowed.x !== fixed.x || allowed.y !== fixed.y) send(ws, { t: 'position', id: p.id, x: nx2, y: ny2 });
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
    const range = HIT_RANGE * (msg.skill === 'milkTea' ? MILK_TEA_RANGE_MULTIPLIER : 1);
    if (dx * dx + dy * dy > range * range) return;

    p.lastHit = now;
    p.lastActive = now;
    if (manaAt(p, now) < MANA.cost) {
      sendMana(ws, p, now); // out of mana: tell the client where it stands, do not hit
      return;
    }
    const roomName = ws.room.name;
    const t = TYPES[o.type];
    const r = await store.hit(roomName, { objId: o.id, defaultHp: t.hp, cost: t.cost, playerId: p.id, now, dmg: damageFactor(msg.skill) });
    if (r.state === 'none') return; // already broken (maybe by someone on another instance): no charge
    const spent = Date.now();
    p.mana = Math.max(0, manaAt(p, spent) - MANA.cost);
    p.manaAt = spent;
    sendMana(ws, p, spent);

    emit(roomName, { t: 'hit', id: o.id, hp: Math.round(r.hp * 100) / 100, by: p.id, skill: cleanSkill(msg.skill) });
    if (r.state === 'broke') {
      emit(roomName, { t: 'break', id: o.id, by: p.id, name: p.name, type: o.type, cost: t.cost });
      await emitBoard(roomName);
    }
  }

  // Playful player hits only broadcast feedback; never mutate health, mana or scores.
  function handlePlayerHit(ws, p, msg) {
    const now = Date.now();
    if (isDown(p) || now - p.lastHit < HIT_COOLDOWN_MS || !Number.isInteger(msg.id) || msg.id === p.id) return;
    const room = ws.room;
    let target = room.peers.get(msg.id);
    for (const peer of room.sockets) {
      if (peer.ready && peer.player && peer.player.id === msg.id) {
        target = { x: peer.player.x, y: peer.player.y, dead: isDown(peer.player) };
        break;
      }
    }
    if (!target || target.dead) return;
    const range = HIT_RANGE * (msg.skill === 'milkTea' ? MILK_TEA_RANGE_MULTIPLIER : 1);
    if (Math.hypot(target.x - p.x, target.y - p.y) > range || !clearLine(p.x, p.y, target.x, target.y)) return;
    p.lastHit = now;
    p.lastActive = now;
    emit(room.name, { t: 'phit', id: msg.id, by: p.id, skill: cleanSkill(msg.skill) });
  }

  function handleEmote(ws, p, msg) {
    const now = Date.now();
    if (isDown(p) || now - p.lastEmote < EMOTE_COOLDOWN_MS) return;
    if (!Number.isInteger(msg.e) || msg.e < 0 || msg.e >= EMOTE_COUNT) return;
    p.lastEmote = now;
    p.lastActive = now;
    emit(ws.room.name, { t: 'emote', id: p.id, e: msg.e });
  }

  // Pressing Space with nothing in reach still swings the hammer. It costs no mana and changes nothing; the room
  // just sees the animation, in the direction the player is facing.
  function handleSwing(ws, p, msg) {
    const now = Date.now();
    if (isDown(p) || now - p.lastSwing < SWING_COOLDOWN_MS) return;
    p.lastSwing = now;
    p.lastActive = now;
    const h = Number(msg.h);
    emit(ws.room.name, { t: 'swing', id: p.id, skill: cleanSkill(msg.skill), h: Number.isFinite(h) ? Math.round(h * 100) / 100 : 0 });
  }

  // Choosing a skill: nothing to store, the room just sees what the player now holds in their hand.
  function handleSkill(ws, p, msg) {
    const now = Date.now();
    if (isDown(p) || now - p.lastSkill < 120) return;
    p.lastSkill = now;
    p.lastActive = now;
    emit(ws.room.name, { t: 'skill', id: p.id, skill: cleanSkill(msg.skill) });
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
          handleMove(ws, p, msg);
          break;
        case 'hit':
          handleHit(ws, p, msg).catch(fail);
          break;
        case 'snakeHit':
          handleSnakeHit(ws, p, msg).catch(fail);
          break;
        case 'phit':
          handlePlayerHit(ws, p, msg);
          break;
        case 'bhit':
          handleBossHit(ws, p, msg).catch(fail);
          break;
        case 'emote':
          handleEmote(ws, p, msg);
          break;
        case 'swing':
          handleSwing(ws, p, msg);
          break;
        case 'skill':
          handleSkill(ws, p, msg);
          break;
        case 'chat':
          handleChat(ws, p, msg);
          break;
        case 'drink':
          handleDrink(ws, p, msg).catch(fail);
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
        if (p && ws.ready && !isDown(p) && !room.bossDead) {
          const fixed = duelPosition(room.duel, p.id, p.x, p.y, Date.now());
          if (fixed.x !== p.x || fixed.y !== p.y) {
            forcePosition(p, fixed, Date.now());
            send(ws, { t: 'position', id: p.id, x: p.x, y: p.y });
          }
        }
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
    watchBuild();

    timers.push(setInterval(tickPositions, TICK_MS));
    timers.push(
      setInterval(() => {
        for (const room of rooms.values()) { bossTick(room); snakeTick(room); }
      }, TICK_MS),
    );
    timers.push(
      setInterval(() => {
        reviveTick();
        for (const room of rooms.values()) if (Date.now() >= room.drinkNextAt) refreshDrink(room).catch(e => log('[drink]', e.message));
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
  RANGED_DAMAGE_MULTIPLIER,
  RESET_COOLDOWN_MS,
  PRESENCE_TTL_MS,
  MAX_PLAYERS_PER_ROOM,
};
