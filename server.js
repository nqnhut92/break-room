'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ---------------------------------------------------------------- config ----
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const WORLD = { w: 1280, h: 720 };
const MAX_PLAYERS_PER_ROOM = 40;
const MAX_CONN_PER_IP = 10;
const JOIN_TIMEOUT_MS = 5000;
const HIT_RANGE = 110;
const HIT_COOLDOWN_MS = 180;
const EMOTE_COOLDOWN_MS = 800;
const RESPAWN_MS = Number(process.env.RESPAWN_MS) || 25000;
const RESET_COOLDOWN_MS = 15000;
const PLAYER_SPEED = 320; // px per second, used to reject teleporting
const EMOTE_COUNT = 8;
const TICK_MS = 66;

// cost is in millions of VND
const TYPES = {
  laptop: { label: 'Laptop', hp: 3, cost: 25, w: 46, h: 30 },
  monitor: { label: 'Màn hình', hp: 4, cost: 8, w: 44, h: 36 },
  chair: { label: 'Ghế xoay', hp: 2, cost: 2, w: 36, h: 36 },
  printer: { label: 'Máy in', hp: 6, cost: 6, w: 64, h: 48 },
  cooler: { label: 'Bình nước', hp: 5, cost: 3, w: 40, h: 64 },
  coffee: { label: 'Máy pha cà phê', hp: 5, cost: 12, w: 52, h: 56 },
  server: { label: 'Tủ server', hp: 8, cost: 120, w: 60, h: 90 },
  plant: { label: 'Chậu cây', hp: 2, cost: 0.5, w: 34, h: 44 },
};

// static furniture that is drawn but cannot be broken
const DESKS = [];
const DESK_COLS = [220, 520, 820];
const DESK_ROWS = [150, 340, 530];
for (const cy of DESK_ROWS) for (const cx of DESK_COLS) DESKS.push({ x: cx, y: cy });

function buildObjects() {
  const objs = [];
  const add = (type, x, y) => {
    objs.push({ id: objs.length, type, x, y, hp: TYPES[type].hp, broken: false, brokenAt: 0 });
  };
  for (const d of DESKS) {
    add('monitor', d.x - 34, d.y - 12);
    add('laptop', d.x + 38, d.y + 2);
    add('chair', d.x, d.y + 72);
  }
  add('printer', 1110, 110);
  add('cooler', 1110, 250);
  add('coffee', 1110, 390);
  add('server', 1110, 560);
  add('plant', 50, 50);
  add('plant', 1230, 50);
  add('plant', 50, 670);
  add('plant', 1230, 670);
  add('plant', 990, 330);
  return objs;
}

// ----------------------------------------------------------------- state ----
const rooms = new Map();
let nextPlayerId = 1;
const connsPerIp = new Map();

function createRoom(name) {
  return {
    name,
    players: new Map(),
    objects: buildObjects(),
    total: 0,
    lastReset: 0,
    dirty: false,
  };
}

function cleanRoomName(raw) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
  return s || 'lobby';
}

function cleanName(raw, fallbackId) {
  const s = String(raw || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14);
  return s || 'Nhân viên ' + fallbackId;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(data);
  }
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, hue: p.hue, x: Math.round(p.x), y: Math.round(p.y), d: p.d, score: p.score };
}

function publicObject(o) {
  return { id: o.id, type: o.type, x: o.x, y: o.y, hp: o.hp, broken: o.broken };
}

function boardOf(room) {
  const list = [...room.players.values()]
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((p) => ({ id: p.id, name: p.name, score: Math.round(p.score * 10) / 10, breaks: p.breaks }));
  return { t: 'board', total: Math.round(room.total * 10) / 10, board: list, online: room.players.size };
}

// -------------------------------------------------------------- handlers ----
function handleJoin(ws, msg, ip) {
  if (ws.player) return;
  const roomName = cleanRoomName(msg.room);
  let room = rooms.get(roomName);
  if (!room) {
    room = createRoom(roomName);
    rooms.set(roomName, room);
  }
  if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
    send(ws, { t: 'err', m: 'Phòng đầy rồi, đổi phòng khác nhé.' });
    ws.close();
    return;
  }
  const id = nextPlayerId++;
  const now = Date.now();
  const p = {
    id,
    ws,
    room,
    name: cleanName(msg.name, id),
    hue: (id * 47) % 360,
    x: 640 + Math.round((Math.random() - 0.5) * 160),
    y: 360 + Math.round((Math.random() - 0.5) * 120),
    d: 1,
    score: 0,
    breaks: 0,
    lastMove: now,
    lastHit: 0,
    lastEmote: 0,
  };
  ws.player = p;
  room.players.set(id, p);
  clearTimeout(ws.joinTimer);

  send(ws, {
    t: 'welcome',
    you: id,
    room: room.name,
    world: WORLD,
    types: TYPES,
    desks: DESKS,
    hitRange: HIT_RANGE,
    respawnMs: RESPAWN_MS,
    players: [...room.players.values()].map(publicPlayer),
    objects: room.objects.map(publicObject),
  });
  send(ws, boardOf(room));
  broadcast(room, { t: 'pj', p: publicPlayer(p) }, id);
  broadcast(room, boardOf(room), id);
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
  p.x = nx;
  p.y = ny;
  p.d = msg.d === -1 ? -1 : 1;
  p.lastMove = now;
  p.room.dirty = true;
}

function handleHit(p, msg) {
  const now = Date.now();
  if (now - p.lastHit < HIT_COOLDOWN_MS) return;
  if (!Number.isInteger(msg.id)) return;
  const room = p.room;
  const o = room.objects[msg.id];
  if (!o || o.broken) return;
  const dx = o.x - p.x;
  const dy = o.y - p.y;
  if (dx * dx + dy * dy > HIT_RANGE * HIT_RANGE) return;

  p.lastHit = now;
  o.hp -= 1;
  broadcast(room, { t: 'hit', id: o.id, hp: o.hp, by: p.id });

  if (o.hp <= 0) {
    o.broken = true;
    o.brokenAt = now;
    const cost = TYPES[o.type].cost;
    room.total += cost;
    p.score += cost;
    p.breaks += 1;
    broadcast(room, { t: 'break', id: o.id, by: p.id, name: p.name, type: o.type, cost });
    broadcast(room, boardOf(room));
  }
}

function handleEmote(p, msg) {
  const now = Date.now();
  if (now - p.lastEmote < EMOTE_COOLDOWN_MS) return;
  if (!Number.isInteger(msg.e) || msg.e < 0 || msg.e >= EMOTE_COUNT) return;
  p.lastEmote = now;
  broadcast(p.room, { t: 'emote', id: p.id, e: msg.e });
}

function handleReset(ws, p) {
  const room = p.room;
  const now = Date.now();
  if (now - room.lastReset < RESET_COOLDOWN_MS) {
    const wait = Math.ceil((RESET_COOLDOWN_MS - (now - room.lastReset)) / 1000);
    send(ws, { t: 'err', m: 'IT đang bận, đợi ' + wait + 's nữa nhé.' });
    return;
  }
  room.lastReset = now;
  for (const o of room.objects) {
    o.hp = TYPES[o.type].hp;
    o.broken = false;
    o.brokenAt = 0;
  }
  broadcast(room, { t: 'reset', by: p.name });
}

function handleLeave(ws) {
  const p = ws.player;
  if (!p) return;
  ws.player = null;
  const room = p.room;
  room.players.delete(p.id);
  if (room.players.size === 0) {
    rooms.delete(room.name);
    return;
  }
  broadcast(room, { t: 'pl', id: p.id });
  broadcast(room, boardOf(room));
}

// ----------------------------------------------------------------- http -----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method not allowed');
    return;
  }

  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Không tìm thấy trang này');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

// ------------------------------------------------------------ websocket -----
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || 'unknown';
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const count = (connsPerIp.get(ip) || 0) + 1;
  if (count > MAX_CONN_PER_IP) {
    ws.close(1013, 'too many connections');
    return;
  }
  connsPerIp.set(ip, count);

  ws.isAlive = true;
  ws.tokens = 60;
  ws.lastRefill = Date.now();
  ws.player = null;
  ws.joinTimer = setTimeout(() => ws.close(4000, 'join timeout'), JOIN_TIMEOUT_MS);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
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

    if (msg.t === 'join') {
      handleJoin(ws, msg, ip);
      return;
    }
    const p = ws.player;
    if (!p) return;
    switch (msg.t) {
      case 'move':
        handleMove(p, msg);
        break;
      case 'hit':
        handleHit(p, msg);
        break;
      case 'emote':
        handleEmote(p, msg);
        break;
      case 'reset':
        handleReset(ws, p);
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    clearTimeout(ws.joinTimer);
    const left = (connsPerIp.get(ip) || 1) - 1;
    if (left <= 0) connsPerIp.delete(ip);
    else connsPerIp.set(ip, left);
    handleLeave(ws);
  });

  ws.on('error', () => {});
});

// ----------------------------------------------------------------- loops ----
const tickTimer = setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.dirty) continue;
    room.dirty = false;
    const l = [];
    for (const p of room.players.values()) l.push([p.id, Math.round(p.x), Math.round(p.y), p.d]);
    broadcast(room, { t: 'ps', l });
  }
}, TICK_MS);

const respawnTimer = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const o of room.objects) {
      if (o.broken && now - o.brokenAt >= RESPAWN_MS) {
        o.broken = false;
        o.hp = TYPES[o.type].hp;
        o.brokenAt = 0;
        broadcast(room, { t: 'respawn', id: o.id });
      }
    }
  }
}, 1000);

const pingTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

function stop() {
  clearInterval(tickTimer);
  clearInterval(respawnTimer);
  clearInterval(pingTimer);
  for (const ws of wss.clients) ws.terminate();
  return new Promise((resolve) => {
    wss.close(() => server.close(() => resolve()));
  });
}

function start(port) {
  return new Promise((resolve) => {
    server.listen(port, () => resolve(server.address().port));
  });
}

if (require.main === module) {
  start(PORT).then((port) => {
    console.log('Office Rage Room đang chạy ở http://localhost:' + port);
  });
}

module.exports = { start, stop, TYPES, HIT_RANGE, HIT_COOLDOWN_MS, RESET_COOLDOWN_MS };
