'use strict';

// Static world definition shared by every instance. Nothing in here changes at
// runtime, so it never needs to live in the shared store.
//
// Coordinates are ground-plane units: x to the right, y towards the viewer.
// Author the original floor plan below; enlarge its space before deriving collision geometry.
const LAYOUT_SCALE = 1.35;
const layoutUnits = n => Math.round(n * LAYOUT_SCALE * 1000) / 1000;
const layoutPoint = (x, y) => ({ x: layoutUnits(x), y: layoutUnits(y) });

const WORLD = {
  w: 4800,
  h: 3000,
  spawn: { x: 1920, y: 1950, rx: 260, ry: 90 }, // players appear in the lobby, which has nothing solid in it
  // Exit door in the west wall of the lobby. Walking into the zone asks "leave the office?" (client side only,
  // nothing for the server to enforce). Keep it free of solid things.
  exit: { x0: 20, y0: 1610, x1: 120, y1: 1790 },
};
const PLAYER_RADIUS = 16;

// The only rooms players can join (like game "servers"). `id` is the url/slug form,
// `name` is shown in the game as "Phòng <name>". Edit here to rename or add rooms.
const ROOMS = [
  { id: 'br-1', name: 'BR-1' },
  { id: 'br-2', name: 'BR-2' },
];

// cost is in millions of VND
const TYPES = {
  laptop: { label: 'Laptop', hp: 3, cost: 25, w: 46, h: 30 },
  monitor: { label: 'Màn hình', hp: 4, cost: 8, w: 44, h: 36 },
  chair: { label: 'Ghế xoay', hp: 2, cost: 2, w: 36, h: 36 },
  printer: { label: 'Máy in', hp: 6, cost: 6, w: 64, h: 48 },
  cooler: { label: 'Bình nước', hp: 5, cost: 3, w: 40, h: 64 },
  coffee: { label: 'Máy pha cà phê', hp: 5, cost: 12, w: 52, h: 56 },
  server: { label: 'Tủ server', hp: 8, cost: 120, w: 60, h: 90 },
  plant: { label: 'Chậu cây', hp: 2, cost: 0.5, w: 30, h: 30 },
  desk: { label: 'Bàn làm việc', hp: 8, cost: 5, w: 150, h: 115 },
  tv: { label: 'Tivi', hp: 4, cost: 20, w: 90, h: 24 },
  toilet: { label: 'Bồn cầu', hp: 4, cost: 4, w: 44, h: 56 },
  sink: { label: 'Bồn rửa mặt', hp: 3, cost: 2, w: 46, h: 36 },
  safe: { label: 'Két sắt', hp: 12, cost: 200, w: 56, h: 56 },
  bookcase: { label: 'Tủ sách', hp: 6, cost: 15, w: 90, h: 40 },
  lamp: { label: 'Đèn cây', hp: 2, cost: 3, w: 30, h: 30 },
  trash: { label: 'Thùng rác', hp: 1, cost: 0.3, w: 30, h: 30 },
  coatrack: { label: 'Cây treo áo', hp: 2, cost: 1, w: 40, h: 40 },
  fridge: { label: 'Tủ lạnh', hp: 7, cost: 18, w: 58, h: 44 },
  speaker: { label: 'Loa', hp: 3, cost: 6, w: 26, h: 26 },
  sofa: { label: 'Sofa', hp: 8, cost: 30, w: 250, h: 105 },
  table: { label: 'Bàn pantry', hp: 6, cost: 8, w: 190, h: 102 },
  conference: { label: 'Bàn họp', hp: 12, cost: 40, w: 570, h: 102 },
};

// Types that stand on the floor and block movement. Only the things on desks do not.
// A broken solid object leaves its wreck behind, so it keeps blocking: collisions never change at runtime.
const SOLID_TYPES = new Set(['printer', 'cooler', 'coffee', 'server', 'desk', 'toilet', 'sink', 'safe', 'bookcase', 'fridge', 'sofa', 'table', 'conference', 'chair', 'trash', 'lamp', 'coatrack', 'speaker', 'tv', 'plant']);

// ------------------------------------------------------------------ props ----
// Furniture that is drawn but cannot be broken. k = kind, x/y = centre,
// w/h = footprint, solid = blocks movement.
const PROPS = [];
const prop = (k, x, y, w, h, solid = true, extra = {}) => PROPS.push({ k, x, y, w, h, solid, ...extra });

// Original desks keep their ordering; the IT wing is four islands of six seats.
const IT_DESKS = [];
for (const cy of [380, 1020]) for (const cx of [1700, 2360]) {
  for (const north of [true, false]) for (const dx of [-160, 0, 160]) {
    IT_DESKS.push({ x: cx + dx, y: cy + (north ? -58 : 58), it: true, rot: north ? Math.PI : 0 });
  }
}
const DESKS = [];
let itIndex = 0;
for (let j = 0; j < 4; j++) for (let i = 0; i < 8; i++) {
  DESKS.push(i < 4 ? { x: 260 + i * 330, y: 220 + j * 280 } : IT_DESKS[itIndex++]);
}
DESKS.push(...IT_DESKS.slice(itIndex));

// Floor plan: shared wall lines, not separate boxes with walkable slivers.
// North rooms open to the cross-corridor; the service spine is x=2700..2880.
const WALL_T = 24;
const SR = { x0: 2880, y0: 1260, x1: 3840, y1: 2160 };
const OPEN = { x0: 0, y0: 0, x1: 1400, y1: 1260 };
const IT = { x0: 1400, y0: 0, x1: 2700, y1: 1260 };
const HALL = { x0: 2700, y0: 0, x1: 3840, y1: 1000 };
const WC_M = { x0: 3840, y0: 0, x1: 4320, y1: 1000 };
const WC_F = { x0: 4320, y0: 0, x1: 4800, y1: 1000 };
const REST = { x0: 3840, y0: 1260, x1: 4800, y1: 2160 };
const MEET_A = { x0: 0, y0: 2360, x1: 1100, y1: 3000 };
const MEET_B = { x0: 1100, y0: 2360, x1: 2200, y1: 3000 };
const DIR = { x0: 2200, y0: 2360, x1: 3300, y1: 3000 };
const PANTRY = { x0: 3300, y0: 2360, x1: 4800, y1: 3000 };
const CONF = { x: 900, y: 1800 };
const PANTRY_TABLES = [[3500, 2600], [3800, 2600], [4100, 2600], [4400, 2600]];
const FLOOR_ROOMS = [
  { ...OPEN, name: 'WORKSPACE', door: { side: 's', at: 700, w: 240 } },
  { ...IT, name: 'IT WORKSPACE', door: { side: 's', at: 2050, w: 240 } },
  { ...HALL, name: 'TOWN HALL', door: { side: 's', at: 3370, w: 220 } },
  { ...WC_M, name: 'WC NAM', door: { side: 's', at: 4080, w: 160 }, opaque: true },
  { ...WC_F, name: 'WC NU', door: { side: 's', at: 4560, w: 160 }, opaque: true },
  { ...SR, name: 'SERVER / VKL', door: { side: 'w', at: 1700, w: 160 } },
  { ...REST, name: 'LOUNGE', door: { side: 's', at: 4300, w: 220 } },
  { ...MEET_A, name: 'MEETING A', door: { side: 'n', at: 550, w: 200 } },
  { ...MEET_B, name: 'MEETING B', door: { side: 'n', at: 1650, w: 200 } },
  { ...DIR, name: 'DIRECTOR', door: { side: 'n', at: 2750, w: 200 } },
  { ...PANTRY, name: 'PANTRY', door: { side: 'n', at: 4000, w: 220 } },
];
// Merge collinear shared walls. Each physical wall is rendered/collided once;
// adjoining rooms meet on the exact same line, including at the perimeter.
const wallLines = new Map();
function wall(horizontal, c, lo, hi, opaque = false) {
  const key = [horizontal, c, opaque].join(':');
  if (!wallLines.has(key)) wallLines.set(key, { horizontal, c, opaque, spans: [] });
  wallLines.get(key).spans.push([lo, hi]);
}
for (const r of FLOOR_ROOMS) {
  for (const [side, a, b, c, horizontal] of [
    ['n', r.x0, r.x1, r.y0, true], ['s', r.x0, r.x1, r.y1, true],
    ['w', r.y0, r.y1, r.x0, false], ['e', r.y0, r.y1, r.x1, false],
  ]) {
    // The existing exterior shell closes perimeter rooms.
    if (c === 0 || (horizontal ? c === WORLD.h : c === WORLD.w)) continue;
    const spans = side === r.door.side ? [[a, r.door.at - r.door.w / 2], [r.door.at + r.door.w / 2, b]] : [[a, b]];
    // Shared WC walls are opaque on both sides.
    const opaque = r.opaque || (!horizontal && c === WC_M.x0 && a === 0 && b === 1000);
    for (const [lo, hi] of spans) wall(horizontal, c, lo, hi, !!opaque);
  }
}
for (const line of wallLines.values()) {
  const merged = [];
  for (const span of line.spans.sort((a, b) => a[0] - b[0])) {
    const prev = merged[merged.length - 1];
    if (prev && span[0] <= prev[1]) prev[1] = Math.max(prev[1], span[1]);
    else merged.push([...span]);
  }
  for (const [lo, hi] of merged) {
    const { horizontal: h, c, opaque } = line;
    prop('wall', h ? (lo + hi) / 2 : c, h ? c : (lo + hi) / 2,
      h ? hi - lo : WALL_T, h ? WALL_T : hi - lo, true, { glass: !opaque, opaque });
  }
}
for (const wc of [WC_M, WC_F]) {
  for (const dx of [160, 310]) prop('wall', wc.x0 + dx, 110, 14, 220, true, { opaque: true });
  for (const [lo, hi] of [[12, 160], [160, 310], [310, 468]]) prop('stallDoor', wc.x0 + (lo + hi) / 2, 220, hi - lo - 14, 8, false);
}
prop('rug', 2250, 1860, 420, 246, false);
prop('rug', CONF.x, CONF.y, 700, 410, false);
for (const r of [MEET_A, MEET_B]) prop('rug', (r.x0 + r.x1) / 2, 2680, 700, 380, false);
prop('rug', 2780, 2750, 620, 340, false);
prop('rug', 4300, 1800, 640, 460, false);
const ZONES = [
  { k: 'wood', ...IT }, { k: 'metal', ...SR },
  { k: 'wood', x0: 0, y0: 1260, x1: 2700, y1: 1460 },
  { k: 'wood', x0: 2700, y0: 1000, x1: 2880, y1: 1460 },
  { k: 'wood', x0: 2880, y0: 1000, x1: 4800, y1: 1260 },
  { k: 'wood', x0: 0, y0: 1460, x1: 2880, y1: 2160 },
  { k: 'wood', x0: 0, y0: 2160, x1: WORLD.w, y1: 2360 },
  { k: 'tile', ...WC_M }, { k: 'tile', ...WC_F },
  { k: 'wood', ...DIR }, { k: 'tile', ...PANTRY }, { k: 'wood', ...REST },
];

// ---------------------------------------------------------------- objects ----
const EAST = Math.PI / 2;
const WEST = -Math.PI / 2;
function buildObjects() {
  const objs = [];
  // rot (radians, optional): which way the object faces. 0 = south (+y); PI/2 = east; PI = north; -PI/2 = west.
  const add = (type, x, y, rot, extra = {}) => {
    objs.push({ id: objs.length, type, x, y, ...(rot ? { rot } : {}), ...extra });
  };
  function workstation(d) {
    const facing = d.rot === Math.PI ? -1 : 1;
    add('desk', d.x, d.y, d.rot, d.it ? { itDesk: true } : {});
    add('monitor', d.x - (d.it ? 30 : 32), d.y - (d.it ? 5 : 14) * facing, d.rot, d.it ? { arm: true } : {});
    add('laptop', d.x + 38 * facing, d.y + (d.it ? 20 : 8) * facing, d.rot);
    add('chair', d.x, d.y + 88 * facing);
  }
  // Append new seats later so every pre-existing breakable keeps its saved id.
  for (const d of DESKS.slice(0, 32)) workstation(d);
  // pantry
  [150, 300, 450].forEach((x) => add('printer', x, 100));
  [4250, 4350].forEach((x) => add('cooler', x, 2440));
  [4450, 4550].forEach((x) => add('coffee', x, 2440));
  for (const [x, y] of PANTRY_TABLES) {
    add('chair', x - 50, y - 78);
    add('chair', x + 50, y + 78);
  }
  // meeting table chairs
  for (const dx of [-190, -65, 65, 190]) {
    add('chair', CONF.x + dx, CONF.y - 92);
    add('chair', CONF.x + dx, CONF.y + 92);
  }
  // server room racks
  for (const y of [1440, 1900]) for (const x of [3080, 3330, 3580]) add('server', x, y);
  // toilets: three stalls and two sinks in each, mirrored for the other one
  for (const wc of [WC_M, WC_F]) {
    for (const dx of [80, 235, 390]) add('toilet', wc.x0 + dx, wc.y0 + 60);
    // two sinks on the side walls, facing each other, a little in from the wall
    add('sink', wc.x0 + 50, wc.y0 + 390, EAST);
    add('sink', wc.x1 - 50, wc.y0 + 390, WEST);
  }
  // meeting rooms: chairs around the table, a tv on the west wall facing the table's end
  for (const r of [MEET_A, MEET_B]) {
    const cx = (r.x0 + r.x1) / 2;
    for (const dx of [-130, 0, 130]) {
      add('chair', cx + dx, 2680 - 92);
      add('chair', cx + dx, 2680 + 92);
    }
    add('tv', r.x0 + 40, 2680, EAST);
  }
  // director's room: the big desk with its kit, a safe, a tv
  add('desk', 2750, 2540);
  add('monitor', 2718, 2526);
  add('laptop', 2788, 2548);
  add('chair', 2750, 2632);
  add('safe', 3220, 2440);
  add('tv', DIR.x0 + 40, 2740, EAST); // west wall; the sofa on the east side faces it
  // lounge: tvs on the north wall facing the sofas, a coffee machine
  add('tv', 4050, REST.y0 + 80);
  add('tv', 4550, REST.y0 + 80);
  add('coffee', 4700, 1350);
  // hall: rows of chairs facing a screen on the west wall
  for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) add('chair', HALL.x0 + 160 + i * 205, 300 + j * 190, WEST);
  add('tv', HALL.x0 + 40, 500, EAST, { screenScale: 3.5 });
  // Plants sit in room corners, never in the circulation spine or doorway.
  [[80,100],[1320,100],[80,1160],[1320,1160],[1480,100],[2620,100],
   [2960,100],[3760,100],[3920,1360],[4720,1360],[3920,2060],[4720,2060],
   [150,2070],[1550,2070],[2500,2070],[80,2440],[1020,2920],
   [1180,2440],[2120,2920],[2280,2440],[3220,2920],[3400,2440],[4700,2920],
   [2960,2070],[3760,2070],[2120,2440]].forEach(([x,y]) => add('plant', x, y));
  // Added later, so they go at the end: the ids above are stored in Redis and must not shift.
  for (const d of DESKS.slice(0, 32)) add('trash', d.x + (d.it ? 60 : 100), d.y + (d.it ? 35 * (d.rot === Math.PI ? -1 : 1) : 62));
  for (const x of [2400, 2490, 3000, 3090]) add('bookcase', x, 2400); // director's room, north wall beside the door
  add('lamp', 3240, 2575);
  add('coatrack', 2280, 2880);
  for (const x of [3920, 4300, 4700]) add('lamp', x, 2000); // lounge
  for (const x of [3500, 3600]) add('fridge', x, 2440); // pantry
  for (const x of [3920, 4720]) add('speaker', x, 1550); // lounge
  // furniture that used to be unbreakable props
  for (const [x, y] of PANTRY_TABLES) add('table', x, y);
  add('conference', CONF.x, CONF.y); // three tables pushed together
  for (const r of [MEET_A, MEET_B]) add('conference', (r.x0 + r.x1) / 2, 2680);
  add('sofa', 2250, 1760);
  add('sofa', 3190, 2740, WEST); // director's room: east side, faces the tv on the west wall
  add('sofa', 4050, 1850, Math.PI); // lounge: faces north, towards the tv
  add('sofa', 4550, 1850, Math.PI);
  // Append new furniture: existing ids must stay stable for saved room state.
  for (const x of [3500, 3800]) {
    add('table', x, 2860);
    add('chair', x - 50, 2782);
    add('chair', x + 50, 2938, Math.PI);
  }
  add('fridge', 3700, 2440);
  add('cooler', 3800, 2440);
  add('coffee', 3900, 2440);
  add('trash', 4700, 2830);
  // The second arm-mounted monitor is appended so saved object ids stay stable.
  for (const d of DESKS.slice(0, 32).filter(d => d.it)) {
    const facing = d.rot === Math.PI ? -1 : 1;
    add('monitor', d.x + 30, d.y - 5 * facing, d.rot, { arm: true });
  }
  for (const d of DESKS.slice(32)) {
    workstation(d);
    const facing = d.rot === Math.PI ? -1 : 1;
    add('monitor', d.x + 30, d.y - 5 * facing, d.rot, { arm: true });
    add('trash', d.x + 60, d.y + 35 * facing);
  }
  return objs;
}

// Immutable object layout. Per-room mutable state (hp, broken) is stored as
// a sparse overlay: an object with no entry is at full health.
const objects = buildObjects();
// Expand room/floor geometry and placement, not furniture or character model dimensions.
// Keep walls closed and the same object IDs; larger gaps create actual walking space.
const scaleRect = r => { for (const key of ['x0','y0','x1','y1']) r[key] = layoutUnits(r[key]); };
WORLD.w = layoutUnits(WORLD.w); WORLD.h = layoutUnits(WORLD.h);
for (const key of ['x','y','rx','ry']) WORLD.spawn[key] = layoutUnits(WORLD.spawn[key]);
scaleRect(WORLD.exit); scaleRect(SR);
for (const r of FLOOR_ROOMS) { scaleRect(r); r.door.at = layoutUnits(r.door.at); r.door.w = layoutUnits(r.door.w); }
for (const z of ZONES) scaleRect(z);
for (const d of DESKS) Object.assign(d,layoutPoint(d.x,d.y));
for (const p of PROPS) {
  Object.assign(p,layoutPoint(p.x,p.y));
  if (p.k === 'wall' || p.k === 'stallDoor') {
    if (p.w > p.h) p.w = layoutUnits(p.w); else p.h = layoutUnits(p.h);
  } else { p.w = layoutUnits(p.w); p.h = layoutUnits(p.h); }
}
const OBJECTS = Object.freeze(objects.map(o => Object.freeze({ ...o, ...layoutPoint(o.x,o.y) })));

// Axis-aligned solid rectangles as [centreX, centreY, halfW, halfH].
const COLLIDERS = [];
for (const p of PROPS) if (p.solid) COLLIDERS.push([p.x, p.y, p.w / 2, p.h / 2]);
for (const o of OBJECTS) {
  if (SOLID_TYPES.has(o.type)) {
    const sideways = o.rot && Math.abs(Math.sin(o.rot)) > 0.5; // turned a quarter: the footprint swaps
    const { w, h } = TYPES[o.type];
    const width = o.screenScale ? 92 * o.screenScale : w;
    COLLIDERS.push([o.x, o.y, (sideways ? h : width) / 2, (sideways ? width : h) / 2]);
  }
}

// Push a circle out of every solid rectangle. Used by the server to validate
// moves and by the client to slide along furniture; the same maths on both
// sides keeps them in agreement.
function resolveCollisions(x, y, r = PLAYER_RADIUS) {
  for (let pass = 0; pass < 2; pass++) {
    for (const [cx, cy, hw, hh] of COLLIDERS) {
      const dx = x - cx;
      const dy = y - cy;
      if (Math.abs(dx) > hw + r || Math.abs(dy) > hh + r) continue;
      const nx = Math.max(-hw, Math.min(hw, dx));
      const ny = Math.max(-hh, Math.min(hh, dy));
      const ex = dx - nx;
      const ey = dy - ny;
      const d2 = ex * ex + ey * ey;
      if (d2 >= r * r) continue;
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        x += (ex / d) * (r - d);
        y += (ey / d) * (r - d);
      } else {
        // centre is inside the rectangle: leave through the nearest side
        const px = hw - Math.abs(dx);
        const py = hh - Math.abs(dy);
        if (px < py) x += (dx >= 0 ? 1 : -1) * (px + r);
        else y += (dy >= 0 ? 1 : -1) * (py + r);
      }
    }
  }
  return { x, y };
}

// Move from (x0, y0) towards (x1, y1) in small steps, pushing out of furniture at
// every step. The server accepts jumps of 60+ units per message, which is more
// than half the thickness of a desk; resolving only the end point would let a
// player tunnel through it.
function slideMove(x0, y0, x1, y1, r = PLAYER_RADIUS, step = 10) {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
  const sx = (x1 - x0) / n;
  const sy = (y1 - y0) / n;
  let x = x0;
  let y = y0;
  for (let i = 0; i < n; i++) {
    const p = resolveCollisions(x + sx, y + sy, r);
    x = p.x;
    y = p.y;
  }
  return { x, y };
}

// ------------------------------------------------------------------- boss ----
// "VKL" lives in the server room. These are static layout facts; the fight rules are in lib/boss.js.
const BOSS_HOME = layoutPoint(3360,1700); // between the two rows of racks
// Walking loop inside the room (all in the open band between the rack rows, checked by test/world.js).
const BOSS_PATROL = [[3000, 1700], [3200, 1620], [3450, 1700], [3730, 1620], [3730, 1800], [3450, 1800], [3200, 1780]].map(([x,y]) => [layoutUnits(x),layoutUnits(y)]);
const BOSS_ROOM = { x0: SR.x0 + 12, y0: SR.y0 + 12, x1: SR.x1 - 12, y1: SR.y1 - 12 }; // inside the glass walls
const BOSS_APRON = { x0: SR.x0 - 140, y0: layoutUnits(1600), x1: SR.x0 + 12, y1: layoutUnits(1800) }; // a little floor in front of the door
const inRect = (r, x, y) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
// Where the boss may walk and whom it notices: the server room plus the doorway apron.
const inBossZone = (x, y) => inRect(BOSS_ROOM, x, y) || inRect(BOSS_APRON, x, y);

// True when no solid rectangle lies between the two points (walls and furniture block a hammer swing).
function clearLine(x0, y0, x1, y1, step = 8) {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
  for (let i = 1; i < n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const y = y0 + ((y1 - y0) * i) / n;
    for (const [cx, cy, hw, hh] of COLLIDERS) if (Math.abs(x - cx) < hw && Math.abs(y - cy) < hh) return false;
  }
  return true;
}

// Company roles a player can pick. "Sếp" is not one of them: the boss of the server room is the only boss. Must match public/roles.js (a test checks it).
const ROLE_IDS = ['nv', 'kt', 'hr', 'it', 'dev', 'sale', 'mkt', 'dsg', 'ts', 'bv', 'tv'];

module.exports = {
  LAYOUT_SCALE, layoutPoint, BOSS_HOME, BOSS_PATROL, BOSS_ROOM, BOSS_APRON, inBossZone, clearLine, SERVER_ROOM: SR,
  FLOOR_ROOMS, ROLE_IDS, WORLD, ROOMS, TYPES, DESKS, PROPS, ZONES, OBJECTS, COLLIDERS, PLAYER_RADIUS, resolveCollisions, slideMove,
};
