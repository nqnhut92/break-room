'use strict';

// Static world definition shared by every instance. Nothing in here changes at
// runtime, so it never needs to live in the shared store.
//
// Coordinates are ground-plane units: x to the right, y towards the viewer
// (the client draws y as the 3D z axis). The office is 3x larger than the old
// 1280x720 room in each direction.

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

// Open office: 8 x 4 desks, each a 150x115 solid rectangle centred on its (x, y) anchor.
const DESKS = [];
for (let j = 0; j < 4; j++) {
  for (let i = 0; i < 8; i++) DESKS.push({ x: 260 + i * 330, y: 260 + j * 330 });
}

// Pantry tables (north-east)
const PANTRY_TABLES = [
  [3150, 700], [3500, 700], [3150, 960], [3500, 960],
];

// Lobby: conference table and sofa
const CONF = { x: 900, y: 1800 };
prop('rug', 2250, 1860, 420, 246, false);
prop('rug', CONF.x, CONF.y, 700, 410, false);

// Server room: walls with a door gap on the west side
const SR = { x0: 2880, y0: 1260, x1: 3840, y1: 2160 };
const WALL_T = 24;

// A rectangular room made of wall props, with an optional door gap in one side.
// side: 'n' | 's' | 'e' | 'w'; at: centre of the gap along that wall; w: gap width.
function room(x0, y0, x1, y1, door, extra = {}) {
  const sides = {
    n: [x0, x1, y0, true],
    s: [x0, x1, y1, true],
    w: [y0, y1, x0, false],
    e: [y0, y1, x1, false],
  };
  for (const [side, [a, b, c, horizontal]] of Object.entries(sides)) {
    const gap = door && door.side === side ? [door.at - door.w / 2, door.at + door.w / 2] : null;
    const spans = gap ? [[a, gap[0]], [gap[1], b]] : [[a, b]];
    for (const [lo, hi] of spans) {
      if (hi - lo < 1) continue;
      if (horizontal) prop('wall', (lo + hi) / 2, c, hi - lo, WALL_T, true, { glass: true, ...extra });
      else prop('wall', c, (lo + hi) / 2, WALL_T, hi - lo, true, { glass: true, ...extra });
    }
  }
}
prop('wall', (SR.x0 + SR.x1) / 2, SR.y0, SR.x1 - SR.x0, WALL_T, true, { glass: true }); // north
prop('wall', SR.x0, (SR.y0 + 1620) / 2, WALL_T, 1620 - SR.y0, true, { glass: true }); // west, above the door
prop('wall', SR.x0, (1780 + SR.y1) / 2, WALL_T, SR.y1 - 1780, true, { glass: true }); // west, below the door

// ---- east wing: toilets (opaque walls, doors facing south) and a hall for big meetings --------
const WC_M = { x0: 3920, y0: 80, x1: 4340, y1: 700 };
const WC_F = { x0: 4360, y0: 80, x1: 4780, y1: 700 };
for (const wc of [WC_M, WC_F]) {
  room(wc.x0, wc.y0, wc.x1, wc.y1, { side: 's', at: (wc.x0 + wc.x1) / 2, w: 150 }, { opaque: true });
  // two partitions between the three stalls
  for (const dx of [145, 275]) prop('wall', wc.x0 + dx, wc.y0 + 100, 14, 190, true, { glass: false, opaque: true });
}
const HALL = { x0: 3900, y0: 1300, x1: 4780, y1: 2100 };
room(HALL.x0, HALL.y0, HALL.x1, HALL.y1, { side: 'n', at: 4340, w: 200 });

// ---- south wing: two meeting rooms, the director's room and a lounge, doors facing the corridor ---------------
const W_ = WORLD.w;
const MEET_A = { x0: 60, y0: 2280, x1: 1080, y1: 2940 };
const MEET_B = { x0: 1180, y0: 2280, x1: 2200, y1: 2940 };
const DIR = { x0: 2300, y0: 2280, x1: 3300, y1: 2940 };
const REST = { x0: 3400, y0: 2280, x1: 4780, y1: 2940 };
room(MEET_A.x0, MEET_A.y0, MEET_A.x1, MEET_A.y1, { side: 'n', at: 570, w: 180 });
room(MEET_B.x0, MEET_B.y0, MEET_B.x1, MEET_B.y1, { side: 'n', at: 1690, w: 180 });
room(DIR.x0, DIR.y0, DIR.x1, DIR.y1, { side: 'n', at: 2800, w: 180 });
room(REST.x0, REST.y0, REST.x1, REST.y1, { side: 'n', at: 4000, w: 220 });
for (const r of [MEET_A, MEET_B]) {
  const cx = (r.x0 + r.x1) / 2;
  prop('rug', cx, 2610, 560, 330, false);
}
prop('rug', 2800, 2600, 520, 340, false);
prop('rug', 3700, 2800, 420, 246, false);
prop('rug', 4300, 2800, 420, 246, false);

// Floors of the different zones (decor only)
const ZONES = [
  { k: 'tile', x0: 2800, y0: 60, x1: 3840, y1: 1230 }, // pantry
  { k: 'metal', x0: SR.x0, y0: SR.y0, x1: SR.x1, y1: SR.y1 }, // server room
  { k: 'wood', x0: 0, y0: 1420, x1: 2880, y1: 2160 }, // lobby
  { k: 'wood', x0: 0, y0: 2160, x1: W_, y1: 2250 }, // corridor along the south wing
  { k: 'tile', x0: 3900, y0: 60, x1: 4780, y1: 1240 }, // toilets and the corridor south of them
  { k: 'wood', x0: DIR.x0, y0: DIR.y0, x1: DIR.x1, y1: DIR.y1 }, // director's room
  { k: 'tile', x0: REST.x0, y0: REST.y0, x1: REST.x1, y1: REST.y1 }, // lounge
];

// ---------------------------------------------------------------- objects ----
const EAST = Math.PI / 2;
const WEST = -Math.PI / 2;
function buildObjects() {
  const objs = [];
  // rot (radians, optional): which way the object faces. 0 = south (+y); PI/2 = east; PI = north; -PI/2 = west.
  const add = (type, x, y, rot) => {
    objs.push(rot ? { id: objs.length, type, x, y, rot } : { id: objs.length, type, x, y });
  };
  for (const d of DESKS) {
    add('desk', d.x, d.y);
    add('monitor', d.x - 32, d.y - 14);
    add('laptop', d.x + 38, d.y + 8);
    add('chair', d.x, d.y + 88);
  }
  // pantry
  [3000, 3140, 3280].forEach((x) => add('printer', x, 150));
  [3430, 3540].forEach((x) => add('cooler', x, 150));
  [3660, 3760].forEach((x) => add('coffee', x, 150));
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
    for (const dx of [75, 210, 345]) add('toilet', wc.x0 + dx, wc.y0 + 60);
    // two sinks on the side walls, facing each other, a little in from the wall
    add('sink', wc.x0 + 50, wc.y0 + 390, EAST);
    add('sink', wc.x1 - 50, wc.y0 + 390, WEST);
  }
  // meeting rooms: chairs around the table, a tv on the west wall facing the table's end
  for (const r of [MEET_A, MEET_B]) {
    const cx = (r.x0 + r.x1) / 2;
    for (const dx of [-130, 0, 130]) {
      add('chair', cx + dx, 2610 - 92);
      add('chair', cx + dx, 2610 + 92);
    }
    add('tv', r.x0 + 40, 2610, EAST);
  }
  // director's room: the big desk with its kit, a safe, a tv
  add('desk', 2800, 2520);
  add('monitor', 2768, 2506);
  add('laptop', 2838, 2528);
  add('chair', 2800, 2612);
  add('safe', 3230, 2340);
  add('tv', DIR.x0 + 40, 2740, EAST); // west wall; the sofa on the east side faces it
  // lounge: tvs on the north wall facing the sofas, a coffee machine
  add('tv', 3700, REST.y0 + 50);
  add('tv', 4300, REST.y0 + 50);
  add('coffee', 4700, 2340);
  // hall: rows of chairs facing a screen on the west wall
  for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) add('chair', HALL.x0 + 130 + i * 205, 1600 + j * 150, WEST);
  add('tv', HALL.x0 + 40, 1700, EAST);
  // plants
  [
    [50, 50], [3790, 50], [50, 2110], [3790, 2110], [1920, 60],
    [2780, 650], [2780, 1150], [60, 1450], [1500, 1450], [2700, 1500],
    [3400, 480], [2750, 2100], [1500, 2100], [120, 1900],
    [100, 2330], [1030, 2330], [1220, 2330], [2150, 2330], [2350, 2330], [3250, 2900], [3450, 2330], [4730, 2900], [3950, 1340], [4730, 1340], [3960, 1250], [4720, 1250],
  ].forEach(([x, y]) => add('plant', x, y));
  // Added later, so they go at the end: the ids above are stored in Redis and must not shift.
  for (const d of DESKS) add('trash', d.x + 100, d.y + 62);
  for (const x of [2450, 2540, 2990, 3080]) add('bookcase', x, 2322); // director's room, north wall beside the door
  add('lamp', 3240, 2575);
  add('coatrack', 2350, 2880);
  for (const x of [3480, 4000, 4640]) add('lamp', x, 2850); // lounge
  for (const x of [2850, 2915]) add('fridge', x, 150); // pantry
  for (const x of [3440, 4740]) add('speaker', x, 2500); // lounge
  // furniture that used to be unbreakable props
  for (const [x, y] of PANTRY_TABLES) add('table', x, y);
  add('conference', CONF.x, CONF.y); // three tables pushed together
  for (const r of [MEET_A, MEET_B]) add('conference', (r.x0 + r.x1) / 2, 2610);
  add('sofa', 2250, 1760);
  add('sofa', 3190, 2740, WEST); // director's room: east side, faces the tv on the west wall
  add('sofa', 3700, 2860, Math.PI); // lounge: faces north, towards the tv
  add('sofa', 4300, 2860, Math.PI);
  return objs;
}

// Immutable object layout. Per-room mutable state (hp, broken) is stored as
// a sparse overlay: an object with no entry is at full health.
const OBJECTS = Object.freeze(buildObjects().map((o) => Object.freeze(o)));

// Axis-aligned solid rectangles as [centreX, centreY, halfW, halfH].
const COLLIDERS = [];
for (const p of PROPS) if (p.solid) COLLIDERS.push([p.x, p.y, p.w / 2, p.h / 2]);
for (const o of OBJECTS) {
  if (SOLID_TYPES.has(o.type)) {
    const sideways = o.rot && Math.abs(Math.sin(o.rot)) > 0.5; // turned a quarter: the footprint swaps
    const { w, h } = TYPES[o.type];
    COLLIDERS.push([o.x, o.y, (sideways ? h : w) / 2, (sideways ? w : h) / 2]);
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
// "Sếp VKL" lives in the server room. These are static layout facts; the fight rules are in lib/boss.js.
const BOSS_HOME = { x: 3360, y: 1700 }; // between the two rows of racks
// Walking loop inside the room (all in the open band between the rack rows, checked by test/world.js).
const BOSS_PATROL = [[3000, 1700], [3200, 1620], [3450, 1700], [3730, 1620], [3730, 1800], [3450, 1800], [3200, 1780]];
const BOSS_ROOM = { x0: SR.x0 + 12, y0: SR.y0 + 12, x1: SR.x1 - 12, y1: SR.y1 - 12 }; // inside the glass walls
const BOSS_APRON = { x0: SR.x0 - 140, y0: 1600, x1: SR.x0 + 12, y1: 1800 }; // a little floor in front of the door
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
  BOSS_HOME, BOSS_PATROL, BOSS_ROOM, BOSS_APRON, inBossZone, clearLine, SERVER_ROOM: SR,
  ROLE_IDS, WORLD, ROOMS, TYPES, DESKS, PROPS, ZONES, OBJECTS, COLLIDERS, PLAYER_RADIUS, resolveCollisions, slideMove,
};
