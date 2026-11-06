'use strict';

// Static world definition shared by every instance. Nothing in here changes at
// runtime, so it never needs to live in the shared store.
//
// Coordinates are ground-plane units: x to the right, y towards the viewer.
// Author the original floor plan below; enlarge its space before deriving collision geometry.
const LAYOUT_SCALE = 1;
const layoutUnits = n => Math.round(n * LAYOUT_SCALE * 1000) / 1000;
const layoutPoint = (x, y) => ({ x: layoutUnits(x), y: layoutUnits(y) });

const WORLD = {
  w: 6600,
  h: 3000,
  spawn: { x: 1920, y: 1950, rx: 260, ry: 90 }, // players appear in the lobby, which has nothing solid in it
  // Exit door in the west wall of the lobby. Walking into the zone asks "leave the office?" (client side only,
  // nothing for the server to enforce). Keep it free of solid things.
  exit: { x0: 20, y0: 1610, x1: 120, y1: 1790 },
};
const PLAYER_RADIUS = 16;

// The only rooms players can join (like game "servers"). `id` is the url/slug form,
// `name` is shown in the game as "Server <name>". Edit here to rename or add rooms.
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

// Every workspace seat is a dual-monitor island desk: six seats facing each other, three a side.
// Only the director keeps a single-monitor desk.
function islands(cxs, cys, extra = {}) {
  const seats = [];
  for (const cy of cys) for (const cx of cxs) {
    for (const north of [true, false]) for (const dx of [-160, 0, 160]) {
      seats.push({ x: cx + dx, y: cy + (north ? -58 : 58), it: true, rot: north ? Math.PI : 0, ...extra });
    }
  }
  return seats;
}
const WEST_WORK = { x0: 0, y0: 0, x1: 2700, y1: 1260 };
const IT_DESKS = islands([1700, 2360], [380, 1020]);
// The west half used to hold sixteen single desks; they become the first sixteen seats of four islands.
const WEST_DESKS = islands([360, 1040], [380, 1020], { west: true });
// East workspace: open-plan islands in the middle band.
const EAST_WORK = { x0: 2880, y0: 1260, x1: 5800, y1: 2160 };
const EAST_DESKS = islands([3200, 3860, 4520, 5180], [1490, 1930]);
// Saved object ids follow this order: the original 32 seats first (16 west, 16 IT interleaved), new seats appended.
const DESKS = [];
let itIndex = 0, westIndex = 0;
for (let j = 0; j < 4; j++) for (let i = 0; i < 8; i++) {
  DESKS.push(i < 4 ? WEST_DESKS[westIndex++] : IT_DESKS[itIndex++]);
}
DESKS.push(...IT_DESKS.slice(itIndex));

// Floor plan: shared wall lines, not separate boxes with walkable slivers.
// North rooms open to the cross-corridor; the service spine is x=2700..2880.
const WALL_T = 24;
// North row, west to east: workspaces, server/VKL (by the lobby spine), town hall, meeting C, then the WCs in the far corner.
// The middle band is open lobby; small meeting rooms D/E sit against the east wall; the lounge joins the south row.
const SR = { x0: 2700, y0: 0, x1: 3660, y1: 1000 }; // door opens south onto the north corridor
const HALL = { x0: 3660, y0: 0, x1: 4800, y1: 1000 };
const WC_M = { x0: 5640, y0: 0, x1: 6120, y1: 1000 };
const WC_F = { x0: 6120, y0: 0, x1: 6600, y1: 1000 };
const REST = { x0: 4800, y0: 2360, x1: 6600, y1: 3000 };
const MEET_A = { x0: 0, y0: 2360, x1: 1100, y1: 3000 };
const MEET_B = { x0: 1100, y0: 2360, x1: 2200, y1: 3000 };
const DIR = { x0: 2200, y0: 2360, x1: 3300, y1: 3000 };
const PANTRY = { x0: 3300, y0: 2360, x1: 4800, y1: 3000 };
const MEETING_WING = [
  { x0: 4800, y0: 0, x1: 5640, y1: 1000, name: 'MEETING C', door: { side: 's', at: 5220, w: 220 } },
  { x0: 5800, y0: 1260, x1: 6600, y1: 1710, name: 'MEETING D', door: { side: 'w', at: 1485, w: 200 } },
  { x0: 5800, y0: 1710, x1: 6600, y1: 2160, name: 'MEETING E', door: { side: 'w', at: 1935, w: 200 } },
];
const CONF = { x: 900, y: 1800 };
const PANTRY_TABLES = [[3500, 2600], [3800, 2600], [4100, 2600], [4400, 2600]];
const FLOOR_ROOMS = [
  { ...WEST_WORK, name: 'WEST WORKSPACE', open: true, door: { side: 's', at: 1350, w: 240 } },
  { ...HALL, name: 'TOWN HALL', door: { side: 's', at: (HALL.x0 + HALL.x1) / 2, w: 220 } }, // the door faces the centre aisle
  { ...WC_M, name: 'WC NAM', door: { side: 's', at: WC_M.x0 + 240, w: 160 }, opaque: true },
  { ...WC_F, name: 'WC NU', door: { side: 's', at: WC_F.x0 + 240, w: 160 }, opaque: true },
  // The door sits in the aisle between the first and second rack columns.
  { ...SR, name: 'SERVER', door: { side: 's', at: SR.x0 + 325, w: 160 } },
  { ...REST, name: 'LOUNGE', door: { side: 'n', at: REST.x0 + 900, w: 240 } },
  { ...MEET_A, name: 'MEETING A', door: { side: 'n', at: 550, w: 200 } },
  { ...MEET_B, name: 'MEETING B', door: { side: 'n', at: 1650, w: 200 } },
  { ...DIR, name: 'DIRECTOR', door: { side: 'n', at: 2750, w: 200 } },
  { ...PANTRY, name: 'PANTRY', door: { side: 'n', at: 4000, w: 220 } },
  ...MEETING_WING.map(r => ({ ...r, door: { ...r.door } })),
  { ...EAST_WORK, name: 'EAST WORKSPACE', open: true, door: { side: 'w', at: 1710, w: 900 } },
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
  if (r.open) continue;
  for (const [side, a, b, c, horizontal] of [
    ['n', r.x0, r.x1, r.y0, true], ['s', r.x0, r.x1, r.y1, true],
    ['w', r.y0, r.y1, r.x0, false], ['e', r.y0, r.y1, r.x1, false],
  ]) {
    // The existing exterior shell closes perimeter rooms.
    if (c === 0 || (horizontal ? c === WORLD.h : c === WORLD.w)) continue;
    const spans = side === r.door.side ? [[a, r.door.at - r.door.w / 2], [r.door.at + r.door.w / 2, b]] : [[a, b]];
    // A wall shared with a WC is opaque on both sides.
    const opaque = r.opaque || FLOOR_ROOMS.some(o => o.opaque && (horizontal
      ? (c === o.y0 || c === o.y1) && a < o.x1 && b > o.x0
      : (c === o.x0 || c === o.x1) && a < o.y1 && b > o.y0));
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
prop('rug', REST.x0 + 900, REST.y0 + 390, 1400, 420, false);
for (const r of MEETING_WING) prop('rug', (r.x0+r.x1)/2, (r.y0+r.y1)/2, 700, Math.min(380, r.y1-r.y0-70), false);
const ZONES = [
  { k: 'metal', ...SR }, // both workspaces keep the carpet
  { k: 'wood', x0: 0, y0: 1260, x1: 2700, y1: 1460 },
  { k: 'wood', x0: 2700, y0: 1000, x1: 2880, y1: 1460 },
  { k: 'wood', x0: 2880, y0: 1000, x1: 6600, y1: 1260 }, // north corridor, full width
  { k: 'wood', x0: 0, y0: 1460, x1: 2880, y1: 2160 }, // lobby; the east workspace beside it keeps the carpet
  { k: 'wood', x0: 0, y0: 2160, x1: 6600, y1: 2360 }, // south corridor, full width
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
  for (const y of [180, 640]) for (const x of [200, 450, 700]) add('server', SR.x0+x, SR.y0+y);
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
  add('tv', REST.x0 + 450, REST.y0 + 80);
  add('tv', REST.x0 + 1350, REST.y0 + 80);
  add('coffee', REST.x1 - 220, REST.y0 + 90);
  // hall: rows of chairs facing the big screen on the north wall; the door at the back (south)
  const hallX = (HALL.x0 + HALL.x1) / 2;
  for (let j = 0; j < 3; j++) for (const dx of [-330, -125, 125, 330]) add('chair', hallX + dx, 400 + j * 190, Math.PI);
  add('tv', hallX, HALL.y0 + 40, 0, { screenScale: 3.5 });
  // Plants sit in room corners, never in the circulation spine or doorway.
  [[80,100],[1320,100],[80,1160],[1320,1160],[1480,100],[2620,100],
   [HALL.x0+100,100],[HALL.x1-80,100],[REST.x0+80,REST.y0+80],[REST.x1-80,REST.y0+80],[REST.x0+80,REST.y1-80],[REST.x1-80,REST.y1-80],
   [150,2070],[1550,2070],[2500,2070],[80,2440],[1020,2920],
   [1180,2440],[2120,2920],[2280,2440],[3220,2920],[3400,2440],[4700,2920],
   [2930,2110],[5740,2110],[2120,2440]].forEach(([x,y]) => add('plant', x, y));
  // Added later, so they go at the end: the ids above are stored in Redis and must not shift.
  for (const d of DESKS.slice(0, 32)) add('trash', d.x + (d.it ? 60 : 100), d.y + (d.it ? 35 * (d.rot === Math.PI ? -1 : 1) : 62));
  for (const x of [2400, 2490, 3000, 3090]) add('bookcase', x, 2400); // director's room, north wall beside the door
  add('lamp', 3240, 2575);
  add('coatrack', 2280, 2880);
  for (const dx of [220, 900, 1580]) add('lamp', REST.x0 + dx, REST.y1 - 60); // lounge
  for (const x of [3500, 3600]) add('fridge', x, 2440); // pantry
  for (const x of [REST.x0 + 80, REST.x1 - 80]) add('speaker', x, REST.y0 + 300); // lounge
  // furniture that used to be unbreakable props
  for (const [x, y] of PANTRY_TABLES) add('table', x, y);
  add('conference', CONF.x, CONF.y); // three tables pushed together
  for (const r of [MEET_A, MEET_B]) add('conference', (r.x0 + r.x1) / 2, 2680);
  add('sofa', 2250, 1760);
  add('sofa', 3190, 2740, WEST); // director's room: east side, faces the tv on the west wall
  add('sofa', REST.x0 + 450, REST.y0 + 400, Math.PI); // lounge: faces north, towards the tv
  add('sofa', REST.x0 + 1350, REST.y0 + 400, Math.PI);
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
  for (const d of DESKS.slice(0, 32).filter(d => d.it && !d.west)) {
    const facing = d.rot === Math.PI ? -1 : 1;
    add('monitor', d.x + 30, d.y - 5 * facing, d.rot, { arm: true });
  }
  for (const d of DESKS.slice(32)) {
    workstation(d);
    const facing = d.rot === Math.PI ? -1 : 1;
    add('monitor', d.x + 30, d.y - 5 * facing, d.rot, { arm: true });
    add('trash', d.x + 60, d.y + 35 * facing);
  }
  // Append the wing so every existing saved object id still identifies the same item.
  for (const r of MEETING_WING) {
    const x=(r.x0+r.x1)/2, y=(r.y0+r.y1)/2;
    add('conference',x,y);
    for (const dx of [-190,-65,65,190]) {
      add('chair',x+dx,y-92);
      add('chair',x+dx,y+92,Math.PI);
    }
    add('chair',x-260,y,EAST); add('chair',x+260,y,WEST);
    add('tv',r.x1-60,y,WEST);
    add('laptop',x-70,y); add('laptop',x+70,y,Math.PI);
    add('plant',r.x1-60,r.y0+80);add('plant',r.x1-60,r.y1-80);
    add('cooler',r.x0+70,r.y0+(r.y1-r.y0 < 600 ? 60 : 100));
  }
  for (const d of EAST_DESKS) {
    workstation(d);
    const facing = d.rot === Math.PI ? -1 : 1;
    add('monitor', d.x + 30, d.y - 5 * facing, d.rot, { arm: true });
    add('trash', d.x + 60, d.y + 35 * facing);
  }
  // West islands: the converted seats get their second arm monitor, then the eight new seats are added.
  for (const d of WEST_DESKS.slice(0, westIndex)) {
    const facing = d.rot === Math.PI ? -1 : 1;
    add('monitor', d.x + 30, d.y - 5 * facing, d.rot, { arm: true });
  }
  for (const d of WEST_DESKS.slice(westIndex)) {
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
// Closed rooms keep walls; open workspaces connect directly to the circulation area.
const scaleRect = r => { for (const key of ['x0','y0','x1','y1']) r[key] = layoutUnits(r[key]); };
WORLD.w = layoutUnits(WORLD.w); WORLD.h = layoutUnits(WORLD.h);
for (const key of ['x','y','rx','ry']) WORLD.spawn[key] = layoutUnits(WORLD.spawn[key]);
scaleRect(WORLD.exit); scaleRect(SR);
for (const r of FLOOR_ROOMS) { scaleRect(r); r.door.at = layoutUnits(r.door.at); r.door.w = layoutUnits(r.door.w); }
// The north-wall banner hangs in the town hall, above its screen.
WORLD.bannerX = layoutUnits((HALL.x0 + HALL.x1) / 2);
const serverDoor = FLOOR_ROOMS.find(r=>r.name==='SERVER');
// axis is the line the doorway runs along: 'y' for a west door, 'x' for a south door.
WORLD.duelDoor = serverDoor.door.side === 'w'
  ? { x:serverDoor.x0, y:serverDoor.door.at, width:serverDoor.door.w, axis:'y' }
  : { x:serverDoor.door.at, y:serverDoor.y1, width:serverDoor.door.w, axis:'x' };
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
const serverPoint = (x,y) => ({x:SR.x0+layoutUnits(x),y:SR.y0+layoutUnits(y)});
const BOSS_HOME = serverPoint(480,440); // between the two rows of racks
// Walking loop inside the room (all in the open band between the rack rows, checked by test/world.js).
const BOSS_PATROL = [[120,440],[320,360],[570,440],[850,360],[850,540],[570,540],[320,520]].map(([x,y])=>{const p=serverPoint(x,y);return [p.x,p.y];});
const BOSS_ROOM = { x0: SR.x0 + 12, y0: SR.y0 + 12, x1: SR.x1 - 12, y1: SR.y1 - 12 }; // inside the glass walls
// A little floor in front of the door.
const BOSS_APRON = WORLD.duelDoor.axis === 'y'
  ? { x0: SR.x0 - 140, y0: WORLD.duelDoor.y-layoutUnits(100), x1: SR.x0 + 12, y1: WORLD.duelDoor.y+layoutUnits(100) }
  : { x0: WORLD.duelDoor.x-layoutUnits(100), y0: SR.y1 - 12, x1: WORLD.duelDoor.x+layoutUnits(100), y1: SR.y1 + 140 };
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
  LAYOUT_SCALE, layoutPoint, serverPoint, BOSS_HOME, BOSS_PATROL, BOSS_ROOM, BOSS_APRON, inBossZone, clearLine, SERVER_ROOM: SR,
  FLOOR_ROOMS, ROLE_IDS, WORLD, ROOMS, TYPES, DESKS, PROPS, ZONES, OBJECTS, COLLIDERS, PLAYER_RADIUS, resolveCollisions, slideMove,
};
