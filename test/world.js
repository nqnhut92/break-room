'use strict';

// Sanity checks on the office layout itself: nothing unreachable, nothing stuck
// inside furniture, and the collision maths behaves.

const assert = require('assert');
const W = require('../lib/world.js');

const K = W.LAYOUT_SCALE;
const G = 10; // fine enough to find the gap beside a chair at the island desks
const nx = Math.ceil(W.WORLD.w / G);
const ny = Math.ceil(W.WORLD.h / G);
const free = (x, y) => {
  const r = W.resolveCollisions(x, y);
  return Math.hypot(r.x - x, r.y - y) < 0.5 && x >= 20 && y >= 20 && x <= W.WORLD.w - 20 && y <= W.WORLD.h - 20;
};
let passed = 0;
function step(name, fn) {
  fn();
  passed++;
  console.log('ok - ' + name);
}

step('rooms: unique url-safe ids, readable names, at least one', () => {
  const { cleanRoomName } = require('../lib/realtime.js');
  assert.ok(W.ROOMS.length >= 1);
  assert.strictEqual(new Set(W.ROOMS.map((r) => r.id)).size, W.ROOMS.length);
  for (const r of W.ROOMS) {
    assert.strictEqual(cleanRoomName(r.id), r.id, r.id + ' survives the server\'s room-name cleaning');
    assert.ok(r.name && r.name.length <= 20 && !/[<>]/.test(r.name));
  }
});

step('floor plan: north row, open workspaces, the server room at the head of the lobby spine', () => {
  assert.strictEqual(K, 1, 'the floor plan is authored at full scale');
  assert.deepStrictEqual([W.WORLD.w, W.WORLD.h], [6600, 3000]);
  const room = name => W.FLOOR_ROOMS.find(r => r.name === name);
  const server = room('SERVER'), hall = room('TOWN HALL'), west = room('WEST WORKSPACE'), east = room('EAST WORKSPACE');
  assert.ok(server && hall && west && east && room('LOUNGE') && room('WC NAM') && room('WC NU'));
  assert.ok(!W.FLOOR_ROOMS.some(r => /VKL/.test(r.name)), 'room labels are plain names');
  assert.strictEqual(server.x0, west.x1, 'server room starts where the west workspace ends');
  assert.strictEqual(server.x1, hall.x0, 'town hall is its east neighbour');
  assert.ok(server.y0 === 0 && server.door.side === 's', 'north row, door onto the corridor');
  assert.ok(Math.hypot(server.door.at - W.WORLD.spawn.x, server.y1 - W.WORLD.spawn.y) < 1600, 'VKL door is close to the spawn');
  assert.ok(room('WC NU').x1 === W.WORLD.w && room('WC NAM').y0 === 0, 'the WCs take the far north-east corner');
  assert.ok(room('LOUNGE').y1 === W.WORLD.h && room('LOUNGE').x1 === W.WORLD.w, 'the lounge joins the south row');
  assert.deepStrictEqual([W.TYPES.desk.w, W.TYPES.desk.h], [150, 115], 'furniture keeps its size');
  assert.equal(W.FLOOR_ROOMS.filter(r => r.name.startsWith('MEETING ')).length, 5);
  assert.strictEqual(W.WORLD.bannerX, (hall.x0 + hall.x1) / 2, 'the wall banner hangs in the town hall');
});

step('object ids are dense and every type is known', () => {
  W.OBJECTS.forEach((o, i) => {
    assert.strictEqual(o.id, i);
    assert.ok(W.TYPES[o.type], o.type);
    assert.ok(o.x >= 0 && o.x <= W.WORLD.w && o.y >= 0 && o.y <= W.WORLD.h, 'inside the world: ' + o.id);
  });
  assert.ok(W.OBJECTS.length > 100);
});

step('saved object ids keep their type; new furniture is only appended', () => {
  // Hash of [id, type] for the 410 objects that existed before this layout; positions may move, identities may not.
  const crypto = require('crypto');
  const original = W.OBJECTS.slice(0, 410).map(o => [o.id, o.type]);
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(original)).digest('hex'), 'c9d976503cfed4f6a7a90b6945b3f0afadbf42ef1cb3ec0083f37dd8440cc5d4');
  assert.equal(W.OBJECTS.filter(o => o.type === 'server').length, 6);
});

step('every workspace seat is a six-seat island desk with paired arm monitors; only the director keeps one screen', () => {
  const desks = W.OBJECTS.filter(o => o.type === 'desk');
  const single = desks.filter(o => !o.itDesk);
  assert.strictEqual(single.length, 1, 'the director desk');
  assert.ok(W.FLOOR_ROOMS.find(r => r.name === 'DIRECTOR'), 'director room exists');
  const islands = desks.filter(o => o.itDesk);
  assert.strictEqual(islands.length, 96);
  for (const d of islands) {
    const monitors = W.OBJECTS.filter(o => o.arm && Math.abs(o.x - d.x) <= 30.001 && Math.abs(o.y - d.y) <= 5.001);
    assert.strictEqual(monitors.length, 2, 'two arm monitors on desk ' + d.id);
    assert.ok(monitors.every(o => (o.rot || 0) === (d.rot || 0)));
    const chair = W.OBJECTS.find(o => o.type === 'chair' && o.x === d.x && Math.abs(o.y - d.y) === 88);
    assert.ok(chair, 'a chair at desk ' + d.id);
    assert.ok(d.rot === Math.PI ? chair.y < d.y : chair.y > d.y, 'the chair is on the seat side');
  }
  // The west workspace: 16 converted seats plus 8 new ones, in four islands.
  const west = W.FLOOR_ROOMS.find(r => r.name === 'WEST WORKSPACE');
  assert.strictEqual(islands.filter(d => d.x < 1400 && d.y < west.y1).length, 24);
});
step('hall screen is enlarged with a matching server collision footprint', () => {
  const tv = W.OBJECTS.find(o => o.type === 'tv' && o.screenScale);
  assert.ok(tv && tv.screenScale === 3.5);
  // On the town hall's north wall, facing the camera: the footprint lies along the wall.
  const hall = W.FLOOR_ROOMS.find(r => r.name === 'TOWN HALL');
  assert.ok(!tv.rot && tv.x === (hall.x0 + hall.x1) / 2 && tv.y < hall.y0 + 60);
  assert.ok(W.COLLIDERS.some(([x,y,hw,hh]) => x === tv.x && y === tv.y && hw === 92 * tv.screenScale / 2 && hh === W.TYPES.tv.h / 2));
  // The audience faces the screen (north).
  const chairs = W.OBJECTS.filter(o => o.type === 'chair' && o.x > hall.x0 && o.x < hall.x1 && o.y < hall.y1);
  assert.strictEqual(chairs.length, 12);
  assert.ok(chairs.every(c => c.rot === Math.PI));
});

step('floor overlays never overlap at the shared render height', () => {
  for (let i = 0; i < W.ZONES.length; i++) for (let j = i + 1; j < W.ZONES.length; j++) {
    const a = W.ZONES[i], b = W.ZONES[j];
    const width = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const height = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    assert.ok(width <= 0 || height <= 0, 'coplanar floor overlap between zones ' + i + ' and ' + j);
  }
});


step('working areas are open and the duel door matches the relocated room',()=>{
  const walls=W.PROPS.filter(p=>p.k==='wall');
  assert.ok(W.FLOOR_ROOMS.filter(r=>r.name.includes('WORKSPACE')).every(r=>r.open));
  assert.ok(!walls.some(p=>Math.abs(p.y-1260)<1&&p.x<2700),'west workspace opens onto circulation');
  const east=W.FLOOR_ROOMS.find(r=>r.name==='EAST WORKSPACE');
  assert.ok(!walls.some(p=>p.x>east.x0+20&&p.x<east.x1-20&&p.y>east.y0+20&&p.y<east.y1-20),'no walls inside the east workspace');
  const room=W.FLOOR_ROOMS.find(r=>r.name==='SERVER');
  assert.deepStrictEqual(W.WORLD.duelDoor,{x:room.door.at,y:room.y1,width:room.door.w,axis:'x'});
});

step('spawn area is open floor', () => {
  const s = W.WORLD.spawn;
  for (const [dx, dy] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    assert.ok(free(s.x + dx * s.rx, s.y + dy * s.ry), 'spawn corner ' + dx + ',' + dy);
  }
});

step('collision pushes a circle out of a box, from outside and from inside', () => {
  const [cx, cy, hw, hh] = W.COLLIDERS[0];
  const out = W.resolveCollisions(cx, cy - hh - 5); // overlapping the top edge
  assert.ok(Math.abs(out.y - (cy - hh - W.PLAYER_RADIUS)) < 0.01);
  const inside = W.resolveCollisions(cx + 3, cy + 2); // dead centre
  assert.ok(Math.abs(inside.x - cx) > hw || Math.abs(inside.y - cy) > hh, 'left the box');
  const again = W.resolveCollisions(inside.x, inside.y);
  assert.ok(Math.hypot(again.x - inside.x, again.y - inside.y) < 0.5, 'stable after one push');
});

step('every breakable object can be reached from the spawn point', () => {
  const seen = new Uint8Array(nx * ny);
  const sx = Math.round(W.WORLD.spawn.x / G);
  const sy = Math.round(W.WORLD.spawn.y / G);
  const stack = [[sx, sy]];
  seen[sy * nx + sx] = 1;
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = x + dx;
      const b = y + dy;
      if (a < 0 || b < 0 || a >= nx || b >= ny || seen[b * nx + a] || !free(a * G, b * G)) continue;
      seen[b * nx + a] = 1;
      stack.push([a, b]);
    }
  }
  const range = 100; // a little under the server's hit range
  const unreachable = W.OBJECTS.filter((o) => {
    for (let a = Math.max(0, Math.floor((o.x - range) / G)); a <= Math.min(nx - 1, Math.ceil((o.x + range) / G)); a++) {
      for (let b = Math.max(0, Math.floor((o.y - range) / G)); b <= Math.min(ny - 1, Math.ceil((o.y + range) / G)); b++) {
        if (seen[b * nx + a] && Math.hypot(a * G - o.x, b * G - o.y) <= range) return false;
      }
    }
    return true;
  });
  assert.deepStrictEqual(unreachable.map((o) => o.type + '#' + o.id), []);
});

step('closed rooms have continuous walls and a single intentional doorway', () => {
  const walls = W.PROPS.filter(p => p.k === 'wall');
  for (const r of W.FLOOR_ROOMS.filter(r=>!r.open)) {
    for (const [side, lo, hi, c, horizontal] of [
      ['n',r.x0,r.x1,r.y0,true], ['s',r.x0,r.x1,r.y1,true],
      ['w',r.y0,r.y1,r.x0,false], ['e',r.y0,r.y1,r.x1,false],
    ]) {
      if (c === 0 || c === (horizontal ? W.WORLD.h : W.WORLD.w)) continue;
      for (let v = lo + 2; v < hi; v += 4) {
        const inDoor = side === r.door.side && Math.abs(v - r.door.at) < r.door.w / 2;
        if (inDoor) continue;
        const x = horizontal ? v : c, y = horizontal ? c : v;
        assert.ok(walls.some(p => Math.abs(p.x-x) <= p.w/2 && Math.abs(p.y-y) <= p.h/2), r.name + ': sealed ' + side + ' at ' + v);
      }
    }
    const d = r.door;
    const x = d.side === 'w' ? r.x0 : d.side === 'e' ? r.x1 : d.at;
    const y = d.side === 'n' ? r.y0 : d.side === 's' ? r.y1 : d.at;
    const dx = d.side === 'w' || d.side === 'e' ? 1 : 0, dy = 1-dx;
    const from = { x:x-dx*55, y:y-dy*55 }, to = { x:x+dx*55, y:y+dy*55 };
    const end = W.slideMove(from.x, from.y, to.x, to.y);
    assert.ok(Math.hypot(end.x-to.x,end.y-to.y) < 0.5, r.name + ': doorway is walkable');
  }
});

step('stamp-assets puts one version on every module URL and can run twice', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
  fs.cpSync(path.join(__dirname, '..', 'public'), tmp, { recursive: true });
  const run = (v) => execFileSync('node', [path.join(__dirname, '..', 'scripts', 'stamp-assets.js'), tmp, v]);
  run('aaa111');
  run('bbb222');
  const read = (f) => fs.readFileSync(path.join(tmp, f), 'utf8');
  const html = read('index.html');
  for (const f of ['game.js', 'scene3d.js', 'viewport.js', 'style.css']) assert.ok(html.includes(f + '?v=bbb222'), f + ' stamped in index.html');
  assert.ok(!/aaa111/.test(html + read('game.js') + read('scene3d.js')), 'the old stamp is replaced, not stacked');
  assert.ok(read('game.js').includes("from './scene3d.js?v=bbb222'") && read('game.js').includes("from './roles.js?v=bbb222'"));
  assert.ok(read('scene3d.js').includes("from './roles.js?v=bbb222'"), 'scene3d and game.js import roles.js by the same URL');
  fs.rmSync(tmp, { recursive: true, force: true });
});

step('exit door: a free spot in the lobby, reachable from the spawn', () => {
  const e = W.WORLD.exit;
  assert.ok(e && e.x1 > e.x0 && e.y1 > e.y0);
  const lobby = W.ZONES.find(z => z.k === 'wood' && z.x0 <= e.x0 && z.x1 >= e.x1 && z.y0 <= e.y0 && z.y1 >= e.y1);
  assert.ok(e.y0 >= lobby.y0 && e.y1 <= lobby.y1, 'inside the lobby');
  for (let x = e.x0; x <= e.x1; x += 10) for (let y = e.y0; y <= e.y1; y += 10) assert.ok(free(x, y), 'free at ' + x + ',' + y);
  const mx = (e.x0 + e.x1) / 2;
  const my = (e.y0 + e.y1) / 2;
  const start = { x: W.WORLD.spawn.x, y: W.WORLD.spawn.y };
  const seen = new Set([Math.round(start.x / G) + ':' + Math.round(start.y / G)]);
  const queue = [[Math.round(start.x / G), Math.round(start.y / G)]];
  let ok = false;
  while (queue.length && !ok) {
    const [cx, cy] = queue.shift();
    if (Math.abs(cx * G - mx) <= 40 && Math.abs(cy * G - my) <= 40) ok = true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = cx + dx + ':' + (cy + dy);
      if (seen.has(k) || !free((cx + dx) * G, (cy + dy) * G)) continue;
      seen.add(k);
      queue.push([cx + dx, cy + dy]);
    }
  }
  assert.ok(ok, 'the door can be walked to from the spawn');
});

console.log('\nAll ' + passed + ' checks passed');
