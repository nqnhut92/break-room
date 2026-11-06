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
const identityContext = require('./identity-context');
const actorCollision = require('../public/actor-collision');
const { OBJECT_RESPAWN } = require('./object-respawn');
const { WebSocketServer } = require('ws');
const { WORLD, TYPES, PROPS, ZONES, FLOOR_ROOMS, OBJECTS, COLLIDERS, ROLE_IDS, PLAYER_RADIUS, BOSS_HOME, BOSS_ROOM, inBossZone, clearLine, slideMove } = require('./world');
// Room names for the full-office map (layout metadata, not drawn in the 3D scene).
const ROOM_LABELS = FLOOR_ROOMS.map(({ name, x0, y0, x1, y1 }) => ({ name, x0, y0, x1, y1 }));
const { DUEL, emptyDuel, activeDuel, canApologize, nextDuel, duelPosition } = require('./duel');
const { MINI, RADIUS: MINI_RADIUS, REACH: MINI_REACH, initialState: initialMiniState, hitMini, stepMini, miniView } = require('./miniboss');
const { SNAKE, stepSnakes, snakeWaveCount } = require('./snakes');
const { MOLE, randomIdentity, makeMole, stepMole, moleCap } = require('./moles');
const { PATROL, emptyPatrol, patrolActive, nextPatrol } = require('./office-patrol');
const { PROFK, createProfK, stepProfK, profkView } = require('./profk');
const { createScoreboard } = require('./scoreboard');
const { guestActor, botActor, dayOf, dayDate } = require('./daily');
const { BOSS, PLAYER, bossHpAt, playerHpAt, createBossState, stepBoss, respawnDelay } = require('./boss');

const MAX_PLAYERS_PER_ROOM = 20;
const MAX_CONN_PER_IP = 10;
const JOIN_TIMEOUT_MS = 5000;
const HIT_RANGE = 110;
const MILK_TEA_RANGE_MULTIPLIER = 2;
const cleanSkill = (skill) => skill === 'milkTea' || skill === 'electric' ? skill : 'hammer';
// Ranged hits (the milk tea throw reaches twice as far) do half the damage of a melee hit, on objects and on the boss.
const RANGED_DAMAGE_MULTIPLIER = 0.5;
// The personal ultimate: hits on the boss and on a revealed mole fill a bar (hitting furniture does not); a full bar buys
// one huge blow. On the boss it takes a fixed share of its health, on a mole it simply kills it.
const RAGE = { max: 100, perBossHit: 2.5, perMoleHit: 4, bossShare: 0.20, reachMultiplier: 1.5, cooldownMs: 1500 };
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
  return String(raw || '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14);
}

function cleanCompany(raw) {
  return String(raw || '').normalize('NFC')
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
    shieldMs: Math.max(0, (p.protectedUntil || 0) - now), // spawn protection left
    deadMs: p.deadUntil > 0 ? Math.max(1, p.deadUntil - now) : 0,
  };
}

function objectView(o, state) {
  const full = TYPES[o.type].hp;
  const v = { id: o.id, type: o.type, x: o.x, y: o.y };
  if (o.rot) v.rot = o.rot;
  if (o.arm) v.arm = true;
  if (o.itDesk) v.itDesk = true;
  if (o.screenScale) v.screenScale = o.screenScale;
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

const BOARD_LIMIT = 50; // rows sent to every client; a player outside it asks for their own rank
const CHAT_PAGE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const cleanCid = (raw) => (/^[A-Za-z0-9_-]{8,64}$/.test(String(raw || '')) ? String(raw) : '');
function cleanCursor(c) {
  return c && Number.isSafeInteger(c.at) && c.at > 0 && UUID_RE.test(String(c.mid)) ? { at: c.at, mid: String(c.mid) } : null;
}

function createRealtime({
  store,
  identity = null,
  scoreboard = store && createScoreboard({ store }), // daily per-room leaderboard (live Redis, optional Postgres)
  chat = null, // Postgres chat history (lib/chat-store.js); null = chat is broadcast only
  build = require('./build'), // { version, builtAt }: which deploy this instance belongs to
  updateGraceMs = 20000, // how long players of an older deploy get to see the notice before they are disconnected
  respawnMs = 0, // 0: adaptive object replacement; positive: fixed override
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
  patrolOpts = {},
  profkOpts = {}, // tests shorten Prof. K's timing
  spawnProtectionMs = 10000, // after a respawn or a fresh join: nothing hurts or targets you until you move or attack
  duelConfig = DUEL, // tests can shorten the same server-side schedule
  bossEnabled = true, // false: no VKL; independent mini-bosses still roam
  bossMaxHp = BOSS.maxHp, // tests shrink these so a fight fits in a second
  bossRespawnMs = 0, // 0 = the BOSS.respawnMinMs..respawnMaxMs range (one minute by default)
  playerRespawnMs = PLAYER.respawnMs,
  moleEnabled = true, // bạn sếp nằm vùng: fake players the server drives (lib/moles.js)
  moleSpawnMs = [60000, 180000], // one more every 1-3 minutes, while the room has room for it
  moleOpts = {}, // tests override the timings in lib/moles.js MOLE
  rageOpts = {}, // tests override RAGE
}) {
  const bossCfg = { ...BOSS, maxHp: bossMaxHp };
  const rage = { ...RAGE, ...rageOpts };
  const patrolCfg = { ...PATROL, ...patrolOpts };
  const profkCfg = { ...PROFK, ...profkOpts };
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

  // "BXH hôm nay" of one room: the day's scores of everyone who played today (online, offline, guests, bots),
  // top rows only. Public ids appear only on rows of actors online right now; nothing says what kind of actor a row is.
  async function boardMessage(roomName, snap, aids = [], limit = BOARD_LIMIT) {
    let b;
    try { b = await scoreboard.board(roomName, { limit, aids }); } catch (e) { log('[board]', e.message); }
    if (!b || !b.hyd) return boardOf(snap); // no daily data right now: the old online-only table keeps the UI alive
    const online = new Map(snap.players.filter((p) => p.aid).map((p) => [p.aid, p]));
    let prev = null, prevRank = 0;
    const board = b.rows.map((r, i) => {
      const rank = prev !== null && r.tenths === prev ? prevRank : i + 1;
      prev = r.tenths; prevRank = rank;
      const pl = online.get(r.aid);
      return { ...(pl ? { id: pl.id } : {}), name: r.name || pl?.name || 'Nhân viên', score: r.tenths / 10, breaks: r.breaks, rank };
    });
    return { t: 'board', total: round1(b.total / 10), board, online: snap.players.length, count: b.count, day: dayDate(b.day), room: roomName, selfs: b.selfs.map(({ aid, ...mine }) => mine) };
  }
  async function emitBoard(roomName) {
    const snap = await store.read(roomName, { now: Date.now(), ttlMs: presenceTtlMs });
    const msg = await boardMessage(roomName, snap);
    delete msg.selfs;
    emit(roomName, msg);
  }

  function getRoom(name) {
    let room = rooms.get(name);
    if (!room) {
      // remote = some other instance may have players in this room. Assumed true until
      // housekeeping says otherwise, so a new room never starts out deaf to the others.
      room = {
        name, sockets: new Set(), hasBroken: false, tick: 0, idle: 0, busy: false, remote: true, ready: null,
        mini: { version: 0, list: [] }, miniBusy: false, miniLast: 0, day: 0, syncAt: 0, retryAt: 0, scoreBusy: false,
        snakes: new Map(), snakeWaves: new Set(), snakeLast: 0, snakeSaved: 0,
        drinkNextAt: 0, drinkBusy: false, drinkOffered: 0, drinkApplied: 0,
        peers: new Map(), // id -> { x, y, dead }: where everyone in the room is, from the position stream
        bossCache: null, // last { x, y, d, m, e } the boss's runner published
        bossDead: false,
        patrol: emptyPatrol(),
        duel: emptyDuel(), duelBusy: false, duelEventVersion: 0, bossCastUntil: 0,
        lead: false, // this instance runs the boss of the room right now
        profk: null, profkBusy: false, profkLast: 0, bossAssistAt: 0, // Prof. K (lib/profk.js), run by the boss leader
        bossSt: null, // the boss's walking/punching state while we run it
        bossLast: 0,
        bossSent: 0,
        lockBusy: false,
        moles: new Map(), moleNextAt: 0, moleLast: 0, moleBusy: false, moleIds: { at: 0, set: new Set() },
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
    if (msg.t === 'duelApology') {
      if (canApologize(room.duel, msg.id, msg.version, Date.now())) room.duelApologyVersion = msg.version;
      return;
    }
    if (msg.t === 'officePatrol') {
      if (msg.state.version < room.patrol.version) return;
      room.patrol = msg.state;
    }
    if (msg.t === 'miniState') {
      if (msg.state.version <= room.mini.version) return;
      room.mini = msg.state;
    }
    if (msg.t === 'profk') {
      if (msg.state.version <= (room.profkSeen?.version || 0)) return;
      room.profkSeen = msg.state; // where Prof. K stands, for player collisions on every instance
    }
    trackPeers(room, msg);
    if (msg.t === 'moleHit' || msg.t === 'moleReveal') { const m = room.moles.get(msg.id); if (m) m.revealed = true; }
    if (msg.t === 'pl') room.moles.delete(msg.id); // gone for any reason (eviction, a new leader cleaning up)

    if (msg.t === 'kick') {
      for (const ws of room.sockets) if (ws.connId === msg.conn) ws.close(4001, 'replaced');
      return;
    }
    if (msg.t === 'break') room.hasBroken = true;
    else if (msg.t === 'reset') room.hasBroken = false;
    else if (msg.t === 'miniStrike') resolveMiniStrike(room, msg);
    else if (msg.t === 'snakeBite') resolveSnakeBite(room, msg);
    else if (msg.t === 'moleStab') resolveMoleStab(room, msg);
    else if (msg.t === 'moleDead') {
      const m = room.moles.get(msg.id);
      if (m && room.lead) removeMole(room, m.id, true, m.connId).catch((e) => log('[moles]', e.message));
    }
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

  // Keep a rough picture of where everyone in the room is (all instances), for the boss's targeting.
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
      case 'bhp':
        if (msg.rev && msg.rev < (room.bossHpRev || 0)) break;
        room.bossHpRev = msg.rev || room.bossHpRev;
        // A player (not Prof. K, not a disguised mole) just damaged VKL: Prof. K's punches count for a moment.
        if (typeof msg.by === 'number' && !room.moles.has(msg.by)) room.bossAssistAt = Date.now();
        if (msg.maxHp) room.bossMaxHp = msg.maxHp;
        break;
      case 'boss':
        room.bossCache = msg;
        break;
      case 'bdead':
        if (msg.rev && msg.rev < (room.bossHpRev || 0)) break;
        room.bossHpRev = msg.rev || room.bossHpRev;
        room.bossDead = true;
        if (room.lead && room.bossSt) room.bossSt.mode = 'dead';
        break;
      case 'bup':
        if (msg.rev && msg.rev < (room.bossHpRev || 0)) break;
        room.bossHpRev = msg.rev || room.bossHpRev;
        room.bossMaxHp = msg.maxHp || bossCfg.maxHp;
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
    const write = () => store.setHp(room.name, p.id, { hp: p.hp, at: p.hpAt, deadUntil: p.deadUntil });
    (p.identityContext ? identityContext.run(p.identityContext, write) : write()).catch((e) => log('[setHp]', e.message));
  }

  // The boss's fist reached this player: take the health off, or knock them out.
  // Attacking or walking away ends spawn protection; everyone's client drops the shield.
  function unshield(room, p) {
    if (!p.protectedUntil) return;
    const was = Date.now() < p.protectedUntil;
    p.protectedUntil = 0;
    if (was) emit(room.name, { t: 'shield', id: p.id, ms: 0 });
  }
  function hurt(room, p, dmg, now) {
    if (isDown(p)) return;
    if (now < (p.protectedUntil || 0)) { // spawn protection: no damage from any source, but show that it held
      if (dmg > 0) emit(room.name, { t: 'blocked', id: p.id });
      return;
    }
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
    const death = () => store.deathAdd(room.name, p.id, now);
    (p.identityContext ? identityContext.run(p.identityContext, death) : death()).catch((e) => log('[deaths]', e.message));
    saveHp(room, p);
    emit(room.name, { t: 'down', id: p.id, ms: playerRespawnMs, x: Math.round(p.x), y: Math.round(p.y), dmg });
  }

  function resolveStrike(room, msg) {
    const now = Date.now();
    // A bot dragged into a duel takes VKL's blows like a person would (otherwise it stands there unhurt for 20 seconds).
    const duelMole = activeDuel(room.duel, now) && room.moles.has(room.duel.target);
    if (room.lead && (patrolActive(room.patrol, now) || duelMole)) hurtPatrolMoles(room, duelMole ? { ...msg, targets: [room.duel.target] } : msg, now);
    for (const ws of room.sockets) {
      const p = ws.player;
      if (!p || !ws.ready || isDown(p)) continue;
      if (activeDuel(room.duel, now) && p.id !== room.duel.target) continue;
      if (msg.skill === 'newProcess' && !inBossZone(p.x, p.y)) continue;
      if (msg.sx !== undefined && !clearLine(msg.sx, msg.sy, p.x, p.y)) continue;
      if (Math.hypot(p.x - msg.x, p.y - msg.y) <= msg.r + PLAYER_RADIUS) hurt(room, p, msg.dmg, now);
    }
  }

  // Knocked out for playerRespawnMs, then back at the lobby with a full bar (never where they fell).
  function revive(room, p, now) {
    const s = spawnPoint();
    p.deadUntil = 0;
    p.protectedUntil = now + spawnProtectionMs;
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
    emit(room.name, { t: 'up', id: p.id, x: Math.round(s.x), y: Math.round(s.y), d: 1, shieldMs: spawnProtectionMs });
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
    if (patrolActive(room.patrol, Date.now())) {
      return snakeTargets(room).filter(p => !p.dead); // shielded players stay targets: the shield blocks the damage
    }
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
  const duelView = room => ({ ...room.duel, ms: room.bossDead ? 0 : Math.max(0, room.duel.until - Date.now()), apologyMs: Math.max(0, (room.duel.startedAt || 0) + DUEL.apologyMs - Date.now()), bounds: { ...BOSS_ROOM, radius: PLAYER_RADIUS }, pullMs: DUEL.pullMs, blowMs: DUEL.blowMs });
  async function duelTick(room, now) {
    if (room.duelBusy || room.patrol.phase !== 'idle' || ['warning', 'out'].includes(room.profk?.phase)) return;
    const state = room.duelApologyVersion === room.duel.version && canApologize(room.duel, room.duel.target, room.duelApologyVersion, now)
      ? { ...room.duel, version: room.duel.version + 1, target: 0, until: 0, moves: [] }
      : nextDuel(room.duel, now, snakeTargets(room), !room.bossDead, Math.random, duelConfig);
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
      emit(room.name, { t: 'bduel', state, ms: Math.max(0, state.until - Date.now()), apologyMs: Math.max(0, (state.startedAt || 0) + DUEL.apologyMs - Date.now()), bounds: { ...BOSS_ROOM, radius: PLAYER_RADIUS }, pullMs: DUEL.pullMs, blowMs: DUEL.blowMs, x: room.bossSt?.x || BOSS_HOME.x, y: room.bossSt?.y || BOSS_HOME.y });
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
    if (room.patrol.phase === 'idle') duelTick(room, now);
    if (b.mode === 'dead' || now < room.bossCastUntil) { room.bossLast = now; return; }
    const dt = Math.min(0.25, room.bossLast ? (now - room.bossLast) / 1000 : TICK_MS / 1000);
    room.bossLast = now;
    const targets = bossTargets(room).filter(p => !activeDuel(room.duel, now) || p.id === room.duel.target);
    const before = b.mode + ':' + Math.round(b.x) + ':' + Math.round(b.y);
    for (const ev of stepBoss(b, dt, targets, Math.random, { office: patrolActive(room.patrol, now) || room.patrol.phase === 'returning', returning: room.patrol.phase === 'returning', blockers: solidBosses(room, { vkl: false }) })) {
      if (ev.type === 'windup') emit(room.name, { t: 'bwind', skill: ev.skill, x: Math.round(ev.x), y: Math.round(ev.y), r: ev.r, ms: ev.ms });
      else if (ev.type === 'strike') emit(room.name, { t: 'bstrike', sx: b.x, sy: b.y, skill: ev.skill, x: Math.round(ev.x), y: Math.round(ev.y), r: ev.r, dmg: ev.dmg });
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
    if (room.lockBusy) return;
    room.lockBusy = true;
    try {
      const now = Date.now();
      const ok = await store.bossLock(room.name, instanceId, { now, ttlMs: 3000 });
      if (!ok) {
        room.lead = false;
        room.profk = null; // whoever leads now owns it; reload it if the lease comes back
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
        room.bossMaxHp = st.maxHp;
        room.bossHpRev = st.rev;
        room.duel = await store.duelGet(room.name, { now });
        room.patrol = await store.patrolGet(room.name, { now }) || emptyPatrol();
        if (room.patrol.pose && room.patrol.phase !== 'idle') room.bossSt = { ...createBossState(now), ...room.patrol.pose };
        room.bossLast = 0;
        room.lead = true;
        room.moleNextAt = 0;
        // moles run in the memory of whoever led before: they are not ours to continue, so send them home
        for (const m of await store.moleList(room.name, { now })) if (!room.moles.has(m.id)) await removeMole(room, m.id, true, m.conn);
      }
      if (bossEnabled) {
        const scaled = await store.bossScale(room.name, { owner: instanceId, now, ttlMs: presenceTtlMs, maxHp: bossCfg.maxHp });
        if (scaled) {
          room.bossMaxHp = scaled.maxHp;
          if (scaled.changed) emit(room.name, { t: 'bhp', hp: round1(scaled.hp), maxHp: scaled.maxHp, rev: scaled.rev });
        }
        await patrolHousekeep(room, now);
      }
      if (bossEnabled && room.bossDead) {
        const back = await store.bossRespawn(room.name, { now: Date.now(), maxHp: bossCfg.maxHp, ttlMs: presenceTtlMs });
        if (back) {
          const st = await store.bossGet(room.name, { now: Date.now(), maxHp: bossCfg.maxHp });
          emit(room.name, { t: 'bup', x: BOSS_HOME.x, y: BOSS_HOME.y, maxHp: st.maxHp, rev: st.rev });
        }
      }
    } finally {
      room.lockBusy = false;
    }
  }

  async function patrolHousekeep(room, now) {
    const b = room.bossSt || BOSS_HOME, old = room.patrol;
    const state = nextPatrol(old, now, { alive: !room.bossDead, duel: activeDuel(room.duel, now) || room.duelBusy,
      humans: humansOf(room).length, home: Math.hypot(b.x - BOSS_HOME.x, b.y - BOSS_HOME.y) < 24 }, Math.random, patrolCfg);
    const changed = state.phase !== old.phase || state.until !== old.until || state.nextAt !== old.nextAt;
    // Idle schedules only write on transitions; active/returning poses piggyback on the existing one-second lease loop.
    if (!changed && state.phase === 'idle') return;
    state.pose = { x: b.x, y: b.y, d: b.d || 0 };
    state.version = old.version + 1;
    if (await store.patrolSave(room.name, { owner: instanceId, now, expected: old.version, state })) {
      room.patrol = state;
      if (changed) emit(room.name, { t: 'officePatrol', state });
      if (changed && state.phase === 'idle') {
        if (room.bossSt && !room.bossDead) Object.assign(room.bossSt, { mode: 'patrol', office: false, strike: null, wp: 0 });
      }
    } else room.patrol = await store.patrolGet(room.name, { now }) || emptyPatrol();
  }

  function snakeTargets(room) {
    const targets = new Map([...room.peers].map(([id, p]) => [id, { id, ...p }]));
    for (const ws of room.sockets) if (ws.ready && ws.player) {
      const p = ws.player;
      targets.set(p.id, { id: p.id, x: p.x, y: p.y, dead: isDown(p), protected: Date.now() < (p.protectedUntil || 0) });
    }
    for (const m of room.moles.values()) targets.set(m.id, { id: m.id, x: m.x, y: m.y, dead: isDown(m), protected: false });
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
    unshield(ws.room, p);
    if (manaAt(p, now) < MANA.cost) { sendMana(ws, p, now); return; }
    const result = await store.snakeHit(room.name, msg.id, now);
    if (!result) return;
    p.mana = Math.max(0, manaAt(p, now) - MANA.cost); p.manaAt = now;
    sendMana(ws, p, now);
    emit(room.name, { t: 'snakeHit', id: msg.id, hp: result.hp, by: p.id, skill: cleanSkill(msg.skill) });
  }


  // Mini-boss movement and hits share a versioned document. A stale runner cannot
  // overwrite a hit, revive twice, or pay a second bounty after a leader handover.
  async function ensureMinis(room) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const now = Date.now(), state = await store.miniGet(room.name, { now });
      if (state.list.length) { if (state.version > room.mini.version) room.mini = structuredClone(state); return state; }
      const initial = initialMiniState(snakeTargets(room));
      initial.version = state.version + 1;
      if (await store.miniSave(room.name, { now, expected: state.version, state: initial })) { room.mini = structuredClone(initial); return initial; }
    }
    return store.miniGet(room.name, { now: Date.now() });
  }
  async function miniTick(room) {
    if (!room.lead || room.miniBusy) return;
    const now = Date.now();
    if (now - room.miniLast < 180) return;
    room.miniBusy = true;
    try {
      const dt = Math.min(0.25, room.miniLast ? (now - room.miniLast) / 1000 : 0.1);
      room.miniLast = now;
      const state = await ensureMinis(room), expected = state.version;
      const hunting = patrolActive(room.patrol, now);
      const strikes = stepMini(state, snakeTargets(room), now, dt, Math.random, hunting, [room.bossSt?.tid].filter(Boolean), solidBosses(room, { minis: false }));
      state.version++;
      if (await store.miniSave(room.name, { now: Date.now(), owner: instanceId, expected, state })) {
        const update = { t: 'miniState', state: miniView(state, Date.now()) };
        if (room.remote) emit(room.name, update);
        else onEvent(room, JSON.stringify([0, update, instanceId]));
        for (const strike of strikes) emit(room.name, { t: 'miniStrike', ...strike });
      }
    } finally { room.miniBusy = false; }
  }
  function resolveMiniStrike(room, msg) {
    const now = Date.now();
    if (room.lead && patrolActive(room.patrol, now)) hurtPatrolMoles(room, msg, now);
    for (const ws of room.sockets) {
      const p = ws.player;
      if (ws.ready && p && msg.targets.includes(p.id) && Math.hypot(p.x - msg.x, p.y - msg.y) <= msg.r + PLAYER_RADIUS && clearLine(msg.sx, msg.sy, p.x, p.y)) hurt(room, p, msg.dmg, Date.now());
    }
  }
  function hurtPatrolMoles(room, msg, now) {
    for (const m of room.moles.values()) {
      if (isDown(m) || (msg.targets && !msg.targets.includes(m.id)) || Math.hypot(m.x - msg.x, m.y - msg.y) > msg.r + PLAYER_RADIUS) continue;
      if (msg.sx !== undefined && !clearLine(msg.sx, msg.sy, m.x, m.y)) continue;
      const hit = async () => {
        const r = await store.moleHurt(room.name, m.id, msg.dmg, now);
        if (!r) return;
        if (r.hp > 0) {
          m.hp = r.hp / MOLE.hp * PLAYER.maxHp; m.hpAt = now;
          await store.setHp(room.name, m.id, { hp: m.hp, at: now, deadUntil: 0 });
          emit(room.name, { t: 'hp', id: m.id, hp: round1(m.hp), dmg: msg.dmg, ...(r.revealed ? { moleHp: r.hp } : {}) });
        } else {
          m.deadUntil = now + playerRespawnMs;
          await store.setHp(room.name, m.id, { hp: 0, at: now, deadUntil: m.deadUntil });
          await store.deathAdd(room.name, m.id, now);
          emit(room.name, { t: 'down', id: m.id, ms: playerRespawnMs, x: Math.round(m.x), y: Math.round(m.y), dmg: msg.dmg });
        }
      };
      hit().catch(e => log('[patrol hit]', e.message));
    }
  }

  async function handleMiniHit(ws, p, msg, ult = false) {
    const now = Date.now(), room = ws.room;
    if (isDown(p) || !Object.hasOwn(MINI, msg.id) || (!ult && now - p.lastHit < HIT_COOLDOWN_MS)) return false;
    p.lastHit = now;
    unshield(room, p); // attacking ends spawn protection
    for (let attempt = 0; attempt < 12; attempt++) {
      const state = await store.miniGet(room.name, { now }), b = state.list.find(b => b.id === msg.id);
      if (!b || b.hp <= 0 || Math.hypot(p.x - b.x, p.y - b.y) > MINI_REACH * (ult ? rage.reachMultiplier : msg.skill === 'milkTea' ? MILK_TEA_RANGE_MULTIPLIER : 1) || !clearLine(p.x, p.y, b.x, b.y)) return false;
      if (isDown(p)) return false;
      if (!ult && manaAt(p, Date.now()) < MANA.cost) { sendMana(ws, p, Date.now()); return false; }
      const expected = state.version;
      const result = hitMini(b, p.id, ult ? MINI[b.id].maxHp * rage.bossShare : BOSS.hitDmg * damageFactor(msg.skill), now);
      state.version++;
      if (!await store.miniSave(room.name, { now: Date.now(), expected, state, shares: result.shares })) continue;
      p.lastActive = Date.now();
      if (ult) { p.rage = 0; sendRage(ws, p); saveRage(room, p, true); }
      else {
        p.mana = Math.max(0, manaAt(p, Date.now()) - MANA.cost); p.manaAt = Date.now();
        sendMana(ws, p, Date.now()); addRage(ws, p, 1);
      }
      emit(room.name, { t: 'miniState', state: miniView(state, Date.now()) });
      emit(room.name, { t: 'miniHit', id: b.id, hp: b.hp, dmg: result.dmg, by: p.id, skill: cleanSkill(msg.skill), ult, shares: result.shares });
      if (result.shares.length) await emitBoard(room.name);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ moles ----
  // A mole is a fake player that joined through the same door as everybody else (a slot, a name, the online count).
  // The leading instance of the room drives it; whoever it hurts or whoever hits it, the store is the shared truth.
  const moleIdSet = async (room) => {
    const c = room.moleIds, now = Date.now();
    if (now - c.at > 1500) {
      c.at = now;
      c.set = new Set((await store.moleList(room.name, { now })).map((m) => m.id));
    }
    return c.set;
  };

  async function removeMole(room, id, clean, conn) {
    room.moles.delete(id);
    room.peers.delete(id);
    room.moleIds.set.delete(id);
    if (!clean) return;
    const now = Date.now();
    await store.moleDel(room.name, id, now);
    await store.leave(room.name, id, conn, null, now);
    emit(room.name, { t: 'pl', id });
    await emitBoard(room.name);
  }

  function humansOf(room) {
    return snakeTargets(room).filter((h) => !room.moles.has(h.id));
  }

  async function spawnMole(room) {
    const now = Date.now();
    const humans = humansOf(room).length;
    if (room.moles.size >= moleCap(humans, MAX_PLAYERS_PER_ROOM)) return;
    for (let tries = 0; tries < 4; tries++) {
      const who = randomIdentity();
      const connId = 'mole-' + crypto.randomBytes(6).toString('hex');
      const res = await (identity ? identity.join.bind(identity) : store.join.bind(store))(room.name, {
        token: connId, name: who.name, gender: who.gender, role: who.role, company: who.company, fallbackName: 'Nhân viên ',
        connId, now, max: MAX_PLAYERS_PER_ROOM, ttlMs: presenceTtlMs, aid: botActor(),
        spawn: { x: WORLD.spawn.x + Math.round((Math.random() - 0.5) * 2 * WORLD.spawn.rx), y: WORLD.spawn.y + Math.round((Math.random() - 0.5) * 2 * WORLD.spawn.ry) },
      }, null, true);
      if (res.full) return;
      if (res.taken) continue; // a colleague already has that name
      await store.moleAdd(room.name, res.id, { hp: MOLE.hp, conn: connId, now });
      const m = makeMole({ id: res.id, connId, name: who.name, x: res.pos.x, y: res.pos.y }, now, moleOpts);
      m.aid = res.aid; // bot row on the day board, from its first appearance like anybody else
      scoreboard.touch(room.name, m.aid, who.name).then(() => emitBoard(room.name)).catch((e) => log('[scores]', e.message));
      Object.assign(m, { gender: who.gender, role: who.role, company: who.company, hp: PLAYER.maxHp, hpAt: now, deadUntil: 0, score: 0 });
      room.moles.set(m.id, m);
      room.peers.set(m.id, { x: m.x, y: m.y, dead: false });
      room.moleIds.set.add(m.id);
      for (const id of res.pruned) emit(room.name, { t: 'pl', id });
      emit(room.name, { t: 'pj', p: publicPlayer({ ...m, d: 1 }) });
      await emitBoard(room.name);
      return;
    }
  }

  async function smashByMole(room, m, objId) {
    const o = OBJECTS[objId], t = o && TYPES[o.type];
    if (!t) return;
    const r = await store.hit(room.name, { objId: o.id, defaultHp: t.hp, cost: t.cost, playerId: m.id, now: Date.now(), dmg: 1, serverBossHp: o.type === 'server' && bossEnabled ? bossCfg.maxHp : 0 });
    if (r.state === 'none') return;
    if (o.type === 'server') {
      const shock = r.applied * 5;
      emit(room.name, { t: 'serverShock', id: o.id, by: m.id, dmg: shock, bossDamage: round1(r.bossDamage || 0) });
      hurtPatrolMoles(room, { x: m.x, y: m.y, r: 0, dmg: shock, targets: [m.id] }, Date.now());
      if (r.bossDamage > 0) { room.bossMaxHp = r.bossMaxHp; emit(room.name, { t: 'bhp', hp: round1(r.bossHp), maxHp: r.bossMaxHp, rev: r.bossRev, by: m.id, skill: 'server' }); await maybeSummon(room, r.bossHp); }
    }
    emit(room.name, { t: 'swing', id: m.id, skill: 'hammer', h: Math.round(m.d * 100) / 100 });
    emit(room.name, { t: 'hit', id: o.id, hp: Math.round(r.hp * 100) / 100, by: m.id, skill: 'hammer' });
    if (r.state === 'broke') {
      emit(room.name, { t: 'break', id: o.id, by: m.id, name: m.name, type: o.type, cost: t.cost });
      await emitBoard(room.name);
    }
  }

  function moleTick(room) {
    if (!room.lead || !moleEnabled || room.moleBusy) return;
    const now = Date.now();
    const dt = Math.min(0.25, room.moleLast ? (now - room.moleLast) / 1000 : 0.1);
    room.moleLast = now;
    if (!room.moleNextAt) room.moleNextAt = now + moleSpawnMs[0] + Math.random() * (moleSpawnMs[1] - moleSpawnMs[0]);
    const humans = humansOf(room);
    const l = [], work = [];
    for (const m of room.moles.values()) {
      if (m.deadUntil) { if (now >= m.deadUntil) work.push(removeMole(room, m.id, true, m.connId)); continue; }
      for (const ev of stepMole(m, dt, { now, humans, patrol: patrolActive(room.patrol, now), bosses: [room.bossSt || room.bossCache, ...room.mini.list].filter(b => b && b.hp !== 0 && b.mode !== 'dead') }, moleOpts)) {
        if (ev.type === 'smash') work.push(smashByMole(room, m, ev.obj));
        else if (ev.type === 'leave') work.push(removeMole(room, m.id, true, m.connId));
        else if (ev.type === 'stab' || ev.type === 'hit') {
          const first = ev.type === 'stab';
          if (first) {
            work.push(store.moleReveal(room.name, m.id, now).then(() => emit(room.name, { t: 'moleReveal', id: m.id, hp: MOLE.hp })));
            room.moleIds.at = 0;
          }
          emit(room.name, { t: 'moleStab', id: m.id, target: ev.target, dmg: ev.dmg, first, x: Math.round(m.x), y: Math.round(m.y), r: first ? (moleOpts.stabRange || MOLE.stabRange) : (moleOpts.rageRange || MOLE.rageRange), h: Math.round(m.d * 100) / 100 });
        }
      }
      if (m.moved) {
        m.moved = false;
        l.push([m.id, Math.round(m.x), Math.round(m.y), Math.sin(m.d) < 0 ? -1 : 1]);
      }
    }
    if (l.length) {
      if (room.remote) emit(room.name, { t: 'ps', l });
      else onEvent(room, JSON.stringify([0, { t: 'ps', l }, instanceId]));
    }
    if (now >= room.moleNextAt) {
      room.moleNextAt = now + moleSpawnMs[0] + Math.random() * (moleSpawnMs[1] - moleSpawnMs[0]);
      work.push(spawnMole(room));
    }
    if (work.length) {
      room.moleBusy = true;
      Promise.all(work).catch((e) => log('[moles]', e.message)).finally(() => { room.moleBusy = false; });
    }
  }

  // A stab or a hammer blow from a mole: every instance hurts its own player, as it does for snake bites.
  function resolveMoleStab(room, msg) {
    for (const ws of room.sockets) {
      const p = ws.player;
      if (ws.ready && p && p.id === msg.target && Math.hypot(p.x - msg.x, p.y - msg.y) <= msg.r + PLAYER_RADIUS + 24) hurt(room, p, msg.dmg, Date.now());
    }
  }

  // The hit landed on something that turned out to be a mole. Costs mana like any object, pays the bounty if it dies.
  async function hitMole(ws, p, msg, now, ult = false) {
    const room = ws.room;
    if (!ult && manaAt(p, now) < MANA.cost) { sendMana(ws, p, now); return true; }
    const r = await store.moleHit(room.name, { id: msg.id, dmg: ult ? MOLE.hp : damageFactor(msg.skill), cost: TYPES.server.cost, playerId: p.id, now });
    if (r.state === 'none') return false;
    const spent = Date.now();
    if (!ult) {
      p.mana = Math.max(0, manaAt(p, spent) - MANA.cost);
      p.manaAt = spent;
      sendMana(ws, p, spent);
      addRage(ws, p, rage.perMoleHit);
    }
    const skill = cleanSkill(msg.skill);
    if (r.state === 'hit') {
      emit(room.name, { t: 'moleHit', id: msg.id, hp: Math.round(r.hp * 100) / 100, by: p.id, skill });
      return true;
    }
    emit(room.name, { t: 'moleHit', id: msg.id, hp: 0, by: p.id, skill });
    emit(room.name, { t: 'moleDead', id: msg.id, by: p.id, name: p.name, cost: TYPES.server.cost });
    // whoever leads the room sees the event and sends the body off the board
    return true;
  }

  const sendRage = (ws, p) => send(ws, { t: 'rage', v: round1(p.rage || 0) });
  // Kept in the store so a refresh does not empty the bar: saved at most every couple of seconds, and when the player leaves.
  // The ultimate bar belongs to the character (or guest tab), so it survives room expiry, devices and renewals.
  const rageKey = (p) => p.aid || String(p.id);
  function saveRage(room, p, force) {
    const now = Date.now();
    if (!force && now - (p.rageSavedAt || 0) < 2000) return;
    p.rageSavedAt = now;
    store.rageSet(room.name, rageKey(p), p.rage || 0, now).catch((e) => log('[rage]', e.message));
  }
  function addRage(ws, p, n) {
    p.rage = Math.min(rage.max, (p.rage || 0) + n);
    sendRage(ws, p);
    saveRage(ws.room, p, p.rage >= rage.max);
  }

  // The ultimate: needs a full bar and the boss or a revealed mole within a little more than hammer reach.
  async function handleUlt(ws, p, msg) {
    const now = Date.now(), room = ws.room;
    if (isDown(p) || (p.rage || 0) < rage.max || now - (p.lastUlt || 0) < rage.cooldownMs) return;
    p.lastUlt = now;
    unshield(room, p);
    const minis = await store.miniGet(ws.room.name, { now });
    const mini = minis.list.filter(b => b.hp > 0 && Math.hypot(b.x - p.x, b.y - p.y) <= MINI_REACH * rage.reachMultiplier && clearLine(p.x, p.y, b.x, b.y)).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
    if (mini && await handleMiniHit(ws, p, { ...msg, id: mini.id }, true)) return;
    if (bossEnabled && !room.bossDead && (await handleBossHit(ws, p, { skill: msg.skill }, true)) !== false) return;
    const range = HIT_RANGE * rage.reachMultiplier;
    const found = new Set((await store.moleList(room.name, { now })).filter((m) => m.revealed).map((m) => m.id));
    let best = null;
    for (const id of found) {
      const m = room.peers.get(id);
      if (!m || m.dead) continue;
      const d = Math.hypot(m.x - p.x, m.y - p.y);
      if (d <= range && clearLine(p.x, p.y, m.x, m.y) && (!best || d < best.d)) best = { id, d, x: m.x, y: m.y };
    }
    if (!best) { send(ws, { t: 'err', m: 'Chưa có ai trong tầm ulti.' }); return; }
    p.lastActive = now;
    emit(room.name, { t: 'ult', id: p.id, skill: cleanSkill(msg.skill), target: 'mole', tid: best.id, x: Math.round(best.x), y: Math.round(best.y) });
    if (await hitMole(ws, p, { id: best.id, skill: msg.skill }, now, true)) {
      p.rage = 0;
      sendRage(ws, p);
      saveRage(room, p, true);
    }
  }

  async function maybeSummon(room, hp) {
    const roomName = room.name, c = room.bossCache || room.bossSt || BOSS_HOME;
    const maxHp = room.bossMaxHp || bossCfg.maxHp;
    if ([70, 40, 10].some(percent => hp <= maxHp * percent / 100 && !room.snakeWaves.has(percent))) {
      const snap = await store.read(roomName, { now: Date.now(), ttlMs: presenceTtlMs });
      const online = Math.min(MAX_PLAYERS_PER_ROOM, snap.players.length);
      const wave = await store.summonSnakes(roomName, { maxHp, count: snakeWaveCount(online), finalCount: snakeWaveCount(online, 10), x: c.x, y: c.y, now: Date.now() });
      for (const percent of [70, 40, 10]) if (hp <= maxHp * percent / 100) room.snakeWaves.add(percent);
      if (wave.snakes.length) emit(roomName, { t: 'snakeSpawn', x: c.x, y: c.y, ...wave });
    }
  }

  async function handleBossHit(ws, p, msg, ult = false) {
    const now = Date.now();
    if (!bossEnabled || isDown(p) || (!ult && now - p.lastHit < HIT_COOLDOWN_MS)) return;
    const room = ws.room;
    const c = room.bossCache || { x: BOSS_HOME.x, y: BOSS_HOME.y, e: 1 };
    if (room.bossDead || (activeDuel(room.duel, now) && p.id !== room.duel.target)) return;
    if (Math.hypot(c.x - p.x, c.y - p.y) > bossCfg.reach * (ult ? rage.reachMultiplier : msg.skill === 'milkTea' ? MILK_TEA_RANGE_MULTIPLIER : 1)) return false;
    if (!clearLine(p.x, p.y, c.x, c.y)) return false; // a wall or a rack is in the way
    p.lastHit = now;
    p.lastActive = now;
    unshield(ws.room, p);
    if (!ult && manaAt(p, now) < MANA.cost) {
      sendMana(ws, p, now);
      return;
    }
    const roomName = room.name;
    const respawnIn = bossRespawnMs || respawnDelay(); // only used if this blow is the one that finishes it
    const r = await store.bossHit(roomName, {
      playerId: p.id,
      dmg: bossCfg.hitDmg * damageFactor(msg.skill),
      share: ult ? rage.bossShare : 0,
      now,
      cfg: bossCfg,
      respawnAt: now + respawnIn,
      bounty: bossCfg.bounty,
    });
    if (r.state === 'dead') return false; // beaten a moment ago (maybe by someone on another instance): no charge
    room.bossMaxHp = r.maxHp;
    const spent = Date.now();
    if (ult) {
      p.rage = 0;
      sendRage(ws, p);
      saveRage(room, p, true);
      emit(roomName, { t: 'ult', id: p.id, skill: cleanSkill(msg.skill), target: 'boss', x: Math.round(c.x), y: Math.round(c.y), dmg: Math.round(r.dmg) });
    } else {
      p.mana = Math.max(0, manaAt(p, spent) - MANA.cost);
      p.manaAt = spent;
      sendMana(ws, p, spent);
      addRage(ws, p, rage.perBossHit);
    }
    if (r.state === 'hit') await maybeSummon(room, r.hp);
    if (r.state === 'hit') {
      emit(roomName, { t: 'bhp', hp: round1(r.hp), maxHp: r.maxHp, rev: r.rev, by: p.id, skill: cleanSkill(msg.skill) });
      return;
    }
    await bossFell(roomName, r, p.id, cleanSkill(msg.skill), respawnIn);
  }
  // VKL fell: tell everyone who did what, and credit the bounty (players only: Prof. K is never in the ledger).
  async function bossFell(roomName, r, by, skill, respawnIn) {
    const snap = await store.read(roomName, { now: Date.now(), ttlMs: presenceTtlMs });
    const names = new Map(snap.players.map((x) => [x.id, x.name]));
    const shares = r.shares
      .map((s) => ({ id: s.id, name: names.get(s.id) || 'Nhân viên ' + s.id, dmg: Math.round(s.dmg), bounty: s.bounty }))
      .sort((a, b) => b.dmg - a.dmg);
    emit(roomName, { t: 'bhp', hp: 0, maxHp: r.maxHp, rev: r.rev, by, skill });
    emit(roomName, { t: 'bdead', rev: r.rev, by, shares, bounty: bossCfg.bounty, respawnMs: respawnIn });
    await emitBoard(roomName);
  }

  // ---------------------------------------------------------------- Prof. K ----
  // The boss leader walks Prof. K like the minis: one versioned record, saved when something changed, fenced by
  // the boss lease so a stale leader cannot overwrite a newer outing.
  async function profkTick(room) {
    if (!bossEnabled || !room.lead || room.profkBusy) return;
    const now = Date.now();
    if (now - room.profkLast < 180) return;
    room.profkBusy = true;
    try {
      if (!room.profk) room.profk = await store.profkGet(room.name, { now }) || createProfK(now, Math.random, profkCfg);
      const s = room.profk, expected = s.version;
      const dt = Math.min(0.25, room.profkLast ? (now - room.profkLast) / 1000 : 0.1);
      room.profkLast = now;
      const b = room.bossSt;
      const vkl = b && !room.bossDead && b.mode !== 'dead' ? { x: b.x, y: b.y, alive: true } : null;
      const key = () => [s.phase, s.nextAt, Math.round(s.x), Math.round(s.y), s.mode, s.wind ? 1 : 0].join(':');
      const before = key();
      const strikes = stepProfK(s, now, dt, { vkl, duel: activeDuel(room.duel, now) || room.duelBusy, humans: humansOf(room).length, assistAt: room.bossAssistAt, players: snakeTargets(room), blockers: solidBosses(room, { vkl: false, profk: false }) }, Math.random, profkCfg);
      if (before === key() && !strikes.length) return; // standing still: nothing to save or send
      const state = { ...s, version: expected + 1 };
      if (!await store.profkSave(room.name, { owner: instanceId, now, expected, state })) { room.profk = null; return; }
      room.profk = state;
      const update = { t: 'profk', state: profkView(state, Date.now()) };
      if (room.remote) emit(room.name, update);
      else onEvent(room, JSON.stringify([0, update, instanceId]));
      for (const ev of strikes) {
        emit(room.name, { t: 'profkStrike', x: Math.round(ev.x), y: Math.round(ev.y), r: ev.r, hit: ev.hit, real: ev.real });
        if (ev.real) await profkPunch(room);
      }
    } finally { room.profkBusy = false; }
  }
  async function profkPunch(room) {
    const now = Date.now(), respawnIn = bossRespawnMs || respawnDelay();
    const r = await store.bossHit(room.name, { playerId: 0, dmg: profkCfg.damage, now, cfg: bossCfg, respawnAt: now + respawnIn, bounty: bossCfg.bounty, credited: false });
    if (r.state === 'dead') return;
    room.bossMaxHp = r.maxHp;
    if (r.state === 'hit') {
      await maybeSummon(room, r.hp);
      emit(room.name, { t: 'bhp', hp: round1(r.hp), maxHp: r.maxHp, rev: r.rev, by: 'profk', skill: 'profk' });
      return;
    }
    await bossFell(room.name, r, 'profk', 'profk', respawnIn);
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
      send(ws, { t: 'err', m: 'Máy chủ đang quá tải, thử lại sau nhé.' });
      ws.close();
      return;
    }
    const room = getRoom(roomName);
    room.sockets.add(ws);
    ws.room = room;
    await room.ready;

    ws.auth = identity ? await identity.token(ws.request) : null;
    const name = cleanName(msg.name);
    if (!name && !ws.auth) {
      send(ws, { t: 'err', m: 'Nhập tên của bạn trước khi vào nhé.', code: 'name' });
      ws.close();
      return;
    }
    const token = cleanToken(msg.token) || crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    let gender = cleanGender(msg.gender);
    let role = cleanRole(msg.role);
    let company = cleanCompany(msg.company);
    const joinOpts = {
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
      aid: guestActor(roomName, token), // identity.join replaces it with the character's id for a signed-in player
      spawn: {
        x: WORLD.spawn.x + Math.round((Math.random() - 0.5) * 2 * WORLD.spawn.rx),
        y: WORLD.spawn.y + Math.round((Math.random() - 0.5) * 2 * WORLD.spawn.ry),
      },
    };
    const join = () => identity ? identity.join(roomName, joinOpts, ws.auth) : store.join(roomName, joinOpts);
    let res = await join();
    if (res.full) {
      // a real person takes a mole's place: the oldest one that has not given itself away leaves first
      const moles = (await store.moleList(roomName, { now })).sort((a, b) => a.revealed - b.revealed || a.id - b.id);
      if (moles.length) {
        await removeMole(room, moles[0].id, true, moles[0].conn);
        res = await join();
      }
    }

    if (res.taken) {
      send(ws, { t: 'err', m: 'Tên này đã có người dùng ở server này, đổi tên khác nhé.', code: 'name' });
      ws.close();
      return;
    }

    if (res.full) {
      send(ws, { t: 'err', m: 'Server đầy rồi, thử lại sau nhé.' });
      ws.close();
      return;
    }

    if (res.profile) ({ gender, role, company } = res.profile);
    ws.characterId = res.characterId;
    const p = {
      id: res.id,
      aid: res.aid || joinOpts.aid,
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
    if (ws.auth) p.identityContext = { room: roomName, id: p.id, conn: ws.connId, sid: ws.auth.sid, valid: () => (identity.sessions.get(ws.auth.sid) || 0) > Date.now() };

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
    p.protectedUntil = !res.prevConn && Math.hypot(p.x - WORLD.spawn.x, p.y - WORLD.spawn.y) < 180 ? now + spawnProtectionMs : 0;
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

    // Day board: a row for this player from the first moment of the day, and (signed in only) the one-time move of this tab's
    // guest points of today to the character. A scoreboard problem never blocks joining.
    try {
      await scoreboard.touch(roomName, p.aid, p.name);
      if (ws.characterId) {
        const moved = await scoreboard.transfer(roomName, guestActor(roomName, token), p.aid, p.name);
        if (moved.state === 'moved') send(ws, { t: 'info', m: 'Điểm hôm nay của bạn khi chưa đăng nhập đã được chuyển sang nhân vật.' });
      }
    } catch (e) { log('[scores]', e.message); }

    const officePatrol = await store.patrolGet(roomName, { now: Date.now() }) || emptyPatrol();
    if (officePatrol.version >= room.patrol.version) room.patrol = officePatrol;
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
    p.rage = Math.min(rage.max, await store.rageGet(roomName, rageKey(p)));
    const found = (await store.moleList(roomName, { now: Date.now() })).filter((m) => m.revealed).map((m) => ({ id: m.id, hp: m.hp }));
    for (const snake of snakes) if (!room.snakes.has(snake.id)) room.snakes.set(snake.id, snake);
    const drink = await store.drinkOffer(roomName, { now: Date.now(), intervalMs: drinkIntervalMs, windowMs: drinkWindowMs });
    room.drinkNextAt = drink.available ? Date.now() : drink.nextAt;
    send(ws, {
      t: 'welcome',
      shieldMs: Math.max(0, (p.protectedUntil || 0) - Date.now()), // this player's own spawn protection
      guestTemporary: !!res.temporary,
      snakes,
      minis: miniView(await ensureMinis(room), Date.now()),
      profk: bossEnabled ? await (async () => { const k = await store.profkGet(roomName, { now: Date.now() }); return k && profkView(k, Date.now()); })() : null,
      duel: duelView(room),
      moles: found, // only the ones that already gave themselves away
      rage: { max: rage.max, v: round1(p.rage || 0) },
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
      rooms: ROOM_LABELS,
      colliders: COLLIDERS,
      hitRange: HIT_RANGE,
      milkTeaRangeMultiplier: MILK_TEA_RANGE_MULTIPLIER,
      mana: { ...MANA, v: MANA.max, ago: 0 },
      player: { max: PLAYER.maxHp, regenDelayMs: PLAYER.regenDelayMs, regenPerSec: PLAYER.regenPerSec },
      boss: bossNow && {
        name: bossCfg.name, maxHp: bossNow.maxHp, baseRegenPerSec: bossCfg.baseRegenPerSec, regenPerSec: bossCfg.regenPerSec,
        regenDelayMs: bossCfg.regenDelayMs, reach: bossCfg.reach, radius: bossCfg.radius, windupMs: bossCfg.windupMs,
        rev: bossNow.rev, hp: round1(bossNow.hp), ago: Math.max(0, Date.now() - bossNow.at), dead: bossNow.dead || room.bossDead,
        respawnMs: bossNow.dead ? Math.max(0, bossNow.respawnAt - Date.now()) : 0,
        x: bc.x, y: bc.y, d: bc.d, m: bc.m, e: bc.e,
      },
      officePatrol,
      chatHistory: !!chat,
      respawnMs,
      respawnPolicy: respawnMs > 0 ? null : OBJECT_RESPAWN,
      players: snap.players.map(publicPlayer),
      objects: OBJECTS.map((o) => objectView(o, snap.objects[o.id])),
    });
    send(ws, await boardMessage(roomName, snap, [p.aid]));
    ws.ready = true;
    for (const out of ws.queue) if (ws.readyState === 1) ws.send(out);
    ws.queue = [];
    if (chat) handleChatHist(ws, p, {}).catch((e) => log('[chat]', e.message)); // after the queue: live lines first, the page merges by id

    // A player taking over their own slot (planned renewal, or a quick
    // reconnect before the old socket was noticed gone) is not news to the room.
    if (!res.prevConn) {
      emit(roomName, { t: 'pj', p: publicPlayer(p) }, p.id);
      emitBoard(roomName).catch((e) => log('[board]', e.message));
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

  // Living boss bodies as circles. Players slide around all of them; each boss slides around the others
  // (pass false for the one that is moving).
  function solidBosses(room, { vkl = true, minis = true, profk = true } = {}) {
    const circles = [];
    const b = (room.lead && room.bossSt ? room.bossSt : room.bossCache) || BOSS_HOME;
    if (vkl && bossEnabled && !room.bossDead && b && b.mode !== 'dead') circles.push({ x: b.x, y: b.y, r: bossCfg.radius });
    if (minis) for (const mini of room.mini.list) if (mini.hp > 0) circles.push({ x: mini.x, y: mini.y, r: MINI_RADIUS });
    const k = room.lead && room.profk ? room.profk : room.profkSeen;
    if (profk && bossEnabled && k) circles.push({ x: k.x, y: k.y, r: PROFK.radius });
    return circles;
  }
  function slidePlayer(room, x0, y0, x1, y1) {
    return actorCollision.slide(x0, y0, x1, y1, PLAYER_RADIUS, solidBosses(room), (x,y) => slideMove(x,y,x,y));
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
    const fixed = slidePlayer(room, p.x, p.y, nx, ny); // swept furniture and living boss bodies
    const allowed = room.bossDead ? fixed : duelPosition(room.duel, p.id, fixed.x, fixed.y, now);
    const nx2 = clamp(allowed.x, 20, WORLD.w - 20);
    const ny2 = clamp(allowed.y, 20, WORLD.h - 20);
    if (Math.hypot(nx2 - nx, ny2 - ny) > 0.5) send(ws, { t: 'position', id: p.id, x: nx2, y: ny2 });
    if (Math.hypot(nx2 - p.x, ny2 - p.y) > 0.5) {
      p.lastActive = now; // standing still and re-sending the same spot is not activity
      unshield(room, p); // walking off ends spawn protection
    }
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
    unshield(ws.room, p);
    if (manaAt(p, now) < MANA.cost) {
      sendMana(ws, p, now); // out of mana: tell the client where it stands, do not hit
      return;
    }
    const roomName = ws.room.name;
    const t = TYPES[o.type];
    const r = await store.hit(roomName, { objId: o.id, defaultHp: t.hp, cost: t.cost, playerId: p.id, now, dmg: damageFactor(msg.skill), serverBossHp: o.type === 'server' && bossEnabled ? bossCfg.maxHp : 0 });
    if (r.state === 'none') return; // already broken (maybe by someone on another instance): no charge
    const spent = Date.now();
    p.mana = Math.max(0, manaAt(p, spent) - MANA.cost);
    p.manaAt = spent;
    sendMana(ws, p, spent);

    if (o.type === 'server') {
      const shock = (r.applied || 0) * 5;
      emit(roomName, { t: 'serverShock', id: o.id, by: p.id, dmg: shock, bossDamage: round1(r.bossDamage || 0) });
      hurt(ws.room, p, shock, spent);
      if (r.bossDamage > 0) {
        room.bossMaxHp = r.bossMaxHp;
        emit(roomName, { t: 'bhp', hp: round1(r.bossHp), maxHp: r.bossMaxHp, rev: r.bossRev, by: p.id, skill: 'server' });
        await maybeSummon(ws.room, r.bossHp);
      }
    }
    emit(roomName, { t: 'hit', id: o.id, hp: Math.round(r.hp * 100) / 100, by: p.id, skill: cleanSkill(msg.skill) });
    if (r.state === 'broke') {
      emit(roomName, { t: 'break', id: o.id, by: p.id, name: p.name, type: o.type, cost: t.cost });
      await emitBoard(roomName);
    }
  }

  // Playful player hits only broadcast feedback; never mutate health, mana or scores.
  async function handlePlayerHit(ws, p, msg) {
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
    unshield(ws.room, p);
    if ((await moleIdSet(room)).has(msg.id) && (await hitMole(ws, p, msg, now))) return;
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

  // Room chat. With Postgres configured a message exists only once its row committed: then it is acknowledged to
  // the sender and broadcast; if the insert fails the sender is told it was NOT sent and nobody sees it.
  // The sender's client id makes a retry idempotent (same row back, no second row). Without a database the message
  // is broadcast only, as before. Sender name and identity come from the connection, never from the message.
  async function handleChat(ws, p, msg) {
    const text = cleanChat(msg.text);
    if (!text) return;
    const now = Date.now();
    if (now - p.lastChat < CHAT_COOLDOWN_MS) {
      send(ws, { t: 'err', m: 'Nhắn chậm thôi, chờ một chút nhé.' });
      return;
    }
    p.lastChat = now;
    p.lastActive = now;
    const room = ws.room.name;
    const cid = cleanCid(msg.cid) || crypto.randomBytes(12).toString('hex');
    if (!chat) {
      emit(room, { t: 'chat', id: p.id, name: p.name, text, mid: crypto.randomUUID(), at: now });
      return;
    }
    try {
      const saved = await chat.post(room, { actorId: p.aid, characterId: ws.characterId || null, name: p.name, text, cid });
      send(ws, { t: 'chatAck', cid, mid: saved.mid });
      // A retry of an already stored message is broadcast again; receivers de-duplicate by mid.
      emit(room, { t: 'chat', id: p.id, name: saved.name, text: saved.text, mid: saved.mid, at: saved.at });
    } catch (e) {
      log('[chat]', e.message);
      send(ws, { t: 'chatFail', cid, m: 'Chưa gửi được tin nhắn, thử lại nhé.' });
    }
  }

  // History pages for the chat frame: { before } older, { after } newer (gap after a reconnect), none = latest.
  async function handleChatHist(ws, p, msg) {
    if (!chat) return;
    const now = Date.now();
    if (now - (p.lastHist || 0) < 500) return;
    p.lastHist = now;
    const before = msg.before ? cleanCursor(msg.before) : null, after = msg.after ? cleanCursor(msg.after) : null;
    if ((msg.before && !before) || (msg.after && !after)) return;
    try {
      const page = await chat.history(ws.room.name, { before, after, limit: CHAT_PAGE });
      // lines this player sent (same character, or the same guest tab) are flagged so their client can highlight them
      const messages = page.messages.map(({ actor, ...m }) => (actor === p.aid ? { ...m, mine: 1 } : m));
      send(ws, { t: 'chatHist', dir: before ? 'before' : after ? 'after' : 'latest', messages, more: page.more });
    } catch (e) {
      log('[chat]', e.message);
      send(ws, { t: 'chatHist', dir: before ? 'before' : after ? 'after' : 'latest', messages: [], more: false, failed: true });
    }
  }

  // The player's own row when it is not among the rows everyone receives.
  async function handleRank(ws, p) {
    const now = Date.now();
    if (now - (p.lastRank || 0) < 1000) return;
    p.lastRank = now;
    const snap = await store.read(ws.room.name, { now, ttlMs: presenceTtlMs });
    const b = await boardMessage(ws.room.name, snap, [p.aid], 1);
    const me = b.selfs && b.selfs[0];
    if (me) send(ws, { t: 'rank', rank: me.rank, score: me.tenths / 10, breaks: me.breaks, count: b.count });
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
    if (p.rage && !ws.auth) await store.rageSet(roomName, rageKey(p), p.rage, Date.now()).catch(() => {});
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

  // Walking out through the exit door: the next visit starts in the lobby. A dropped connection or a reload sends nothing, so
  // those still put the player back exactly where they stood. It is applied the moment it arrives, before the ordered action
  // queue: the client closes the socket right after sending it, and a queued action would find the socket already closed.
  function exitedThroughDoor(ws, data) {
    const text = data.toString();
    if (text.length > 40 || !text.includes('"leave"') || !ws.player) return false;
    try { if (JSON.parse(text).t !== 'leave') return false; } catch (e) { return false; }
    const s = spawnPoint(), p = ws.player;
    p.x = s.x; p.y = s.y; p.d = 1; p.unsaved = true;
    return true;
  }

  function processMessage(ws, data) {
    if (exitedThroughDoor(ws, data)) return;
    // Preserve the guest-only dispatch path when durable identity is absent.
    if (!identity?.profiles) { dispatchMessage(ws, data).catch(() => ws.close(1011, 'handler error')); return; }
    if (ws.closedFlag || ws.readyState !== 1) return;
    if ((ws.queuedActions || 0) >= 60) { ws.close(1008, 'too many actions'); return; }
    ws.queuedActions = (ws.queuedActions || 0) + 1;
    ws.actions = (ws.actions || Promise.resolve()).then(() => {
      if (ws.closedFlag || ws.readyState !== 1) return;
      return identity && ws.auth && ws.player ? identity.owned(ws, () => dispatchMessage(ws, data)) : dispatchMessage(ws, data);
    }).catch(() => { ws.close(4004, 'session ended'); }).finally(() => { ws.queuedActions--; });
  }

  async function dispatchMessage(ws, data) {
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
      log('[handler]', msg.t, e.status || 'operation failed');
      if (msg.t === 'join') {
        send(ws, { t: 'err', m: e.status ? e.message : 'Máy chủ đang bận, thử lại sau nhé.' });
        ws.close(1011, 'store error');
      }
    };
    try {
      if (msg.t === 'join') {
        await handleJoin(ws, msg);
        return;
      }
      const p = ws.player;
      if (!p) return;
      if (identity?.profiles && !ws.auth && !await store.isOwner(ws.room.name, p.id, ws.connId)) { ws.close(4001, 'replaced'); return; }
      switch (msg.t) {
        case 'move':
          handleMove(ws, p, msg);
          break;
        case 'hit':
          await handleHit(ws, p, msg);
          break;
        case 'miniHit':
          await handleMiniHit(ws, p, msg);
          break;
        case 'snakeHit':
          await handleSnakeHit(ws, p, msg);
          break;
        case 'phit':
          await handlePlayerHit(ws, p, msg);
          break;
        case 'bhit':
          await handleBossHit(ws, p, msg);
          break;
        case 'deaths': {
          // today's "bị sa thải" ranking (online or not); only fetched when somebody opens the tab
          const now = Date.now();
          if (now - (p.lastDeaths || 0) < 1000) break;
          p.lastDeaths = now;
          const d = await scoreboard.deaths(ws.room.name, { aid: p.aid });
          const snap = await store.read(ws.room.name, { now, ttlMs: presenceTtlMs });
          const online = new Map(snap.players.filter((x) => x.aid).map((x) => [x.aid, x.id]));
          let prev = -1, prevRank = 0;
          const list = (d.rows || []).map((r, i) => {
            const rank = r.n === prev ? prevRank : i + 1;
            prev = r.n; prevRank = rank;
            return { ...(online.has(r.aid) ? { id: online.get(r.aid) } : {}), name: r.name || 'Nhân viên', n: r.n, rank };
          });
          send(ws, { t: 'deaths', day: d.day && dayDate(d.day), count: d.count || 0, list, mine: d.mine && d.mine.n > 0 ? d.mine : null });
          break;
        }
        case 'ult':
          await handleUlt(ws, p, msg);
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
          await handleChat(ws, p, msg);
          break;
        case 'chatHist':
          await handleChatHist(ws, p, msg);
          break;
        case 'rank':
          await handleRank(ws, p);
          break;
        case 'duelApology':
          if (bossEnabled && ws.ready && !isDown(p) && canApologize(ws.room.duel, p.id, msg.version, now)) {
            emit(ws.room.name, { t: 'duelApology', id: p.id, version: msg.version });
          }
          break;
        case 'drink':
          await handleDrink(ws, p, msg);
          break;
        case 'reset':
          await handleReset(ws, p);
          break;
        default:
          break;
      }
    } catch (e) {
      fail(e);
    }
  }

  function onConnection(ws, req) {
    ws.request = req;
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
        if (p && ws.ready && !isDown(p) && Date.now() >= (p.forcedUntil || 0)) {
          const fixed = slidePlayer(room, p.x, p.y, p.x, p.y);
          if (Math.hypot(fixed.x-p.x,fixed.y-p.y) > 0.5) {
            p.x = fixed.x; p.y = fixed.y; p.moved = true; p.unsaved = true;
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

  // Daily board upkeep, at most one run per room at a time and never on the gameplay path:
  //  - a new Vietnam day: build its board and give every player online here (humans and the bots we lead) a row,
  //    so people who stay connected past midnight start the new day at 0 without rejoining;
  //  - re-attempt a board that was built without Postgres (state 2);
  //  - opportunistically drain the score queue. Instances may stop at any time, so the maintenance job (see
  //    docs/DEPLOYMENT.md) is the guarantee; this only keeps the lag short while people play.
  function scoreHousekeep(room) {
    if (room.scoreBusy || !scoreboard) return;
    const now = Date.now(), day = dayOf(now);
    const rolled = day !== room.day;
    if (!rolled && now - room.syncAt < 5000) return;
    room.scoreBusy = true;
    (async () => {
      if (rolled) {
        const first = !room.day;
        room.day = day;
        await scoreboard.ensure(room.name, day);
        for (const ws of room.sockets) if (ws.player?.aid) await scoreboard.touch(room.name, ws.player.aid, ws.player.name);
        if (room.lead) for (const m of room.moles.values()) if (m.aid) await scoreboard.touch(room.name, m.aid, m.name);
        if (!first) await emitBoard(room.name);
      }
      if (now - room.syncAt >= 5000) {
        room.syncAt = now;
        if (scoreboard.sink) await scoreboard.sync(room.name);
        if (now >= room.retryAt && await store.dayState(room.name, day) === 2) { room.retryAt = now + 30000; await scoreboard.ensure(room.name, day); }
      }
    })().catch((e) => log('[scores]', e.message)).finally(() => { room.scoreBusy = false; });
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
      if (room.lead) for (const m of room.moles.values()) entries.push({ id: m.id, connId: m.connId, pos: null });
      room.tick++;
      const sweep = room.hasBroken || room.tick % 5 === 0;
      const r = await store.housekeep(room.name, {
        now: Date.now(),
        ttlMs: presenceTtlMs,
        respawnMs,
        sweep,
        entries,
        instanceId,
        strictPresence: !!identity?.profiles,
      });
      room.remote = r.others > 0;
      scoreHousekeep(room);
      for (const p of saved) p.unsaved = false;
      if (sweep && r.remaining === 0) room.hasBroken = false;
      for (const id of r.respawned) emit(room.name, { t: 'respawn', id });
      if (r.pruned.length) {
        for (const id of r.pruned) {
          emit(room.name, { t: 'pl', id });
          if (identity?.profiles) for (const ws of room.sockets) if (ws.player?.id === id) ws.close(4000, 'presence expired');
        }
        await emitBoard(room.name);
      }
    } finally {
      room.busy = false;
    }
  }

  function attach(server, { path } = {}) {
    wss = new WebSocketServer({ server, path, maxPayload: 2048,
      verifyClient: ({ req }) => identity ? identity.allowedOrigin(req) : (!req.headers.origin || req.headers.origin === (trustProxy ? 'https://' : 'http://') + req.headers.host),
    });
    if (identity) timers.push(setInterval(() => {
      for (const ws of conns) if (ws.auth && ws.player && !ws.authChecking) {
        ws.authChecking = true;
        identity.owned(ws, () => {}).catch(() => ws.close(4004, 'session ended')).finally(() => { ws.authChecking = false; });
      }
    }, 1000));
    wss.on('connection', onConnection);
    watchBuild();

    timers.push(setInterval(tickPositions, TICK_MS));
    timers.push(
      setInterval(() => {
        for (const room of rooms.values()) { bossTick(room); snakeTick(room); moleTick(room); miniTick(room).catch(e => log('[minis]', e.message)); profkTick(room).catch(e => log('[profk]', e.message)); }
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
  RAGE,
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
