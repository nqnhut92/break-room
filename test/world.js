'use strict';

// Sanity checks on the office layout itself: nothing unreachable, nothing stuck
// inside furniture, and the collision maths behaves.

const assert = require('assert');
const W = require('../lib/world.js');

const K = W.LAYOUT_SCALE;
const G = 20;
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

step('east wing expands the office without enlarging furniture', () => {
  assert.deepStrictEqual([W.WORLD.w,W.WORLD.h],[8910,4050]);
  const it=W.FLOOR_ROOMS.find(r=>r.name==='IT WORKSPACE');
  const server=W.FLOOR_ROOMS.find(r=>r.name==='SERVER / VKL');
  assert.ok(server.x0-it.x1>=243,'service corridor widens from 180 to 243');
  assert.deepStrictEqual([server.x1-server.x0,server.y1-server.y0],[1296,1215]);
  assert.deepStrictEqual([W.TYPES.desk.w,W.TYPES.desk.h],[150,115],'furniture does not grow with the room');
  assert.equal(W.FLOOR_ROOMS.filter(r=>r.name.startsWith('MEETING ')).length,5);
  assert.ok(server.x0>=W.WORLD.w-1296&&server.y0===0,'server moves to the northeast edge behind a forecourt');
});

step('object ids are dense and every type is known', () => {
  W.OBJECTS.forEach((o, i) => {
    assert.strictEqual(o.id, i);
    assert.ok(W.TYPES[o.type], o.type);
    assert.ok(o.x >= 0 && o.x <= W.WORLD.w && o.y >= 0 && o.y <= W.WORLD.h, 'inside the world: ' + o.id);
  });
  assert.ok(W.OBJECTS.length > 100);
});

step('saved object ids retain their identity and placement outside the relocated server racks',()=>{
  const crypto=require('crypto');
  const original=W.OBJECTS.slice(0,359).map(o=>[o.id,o.type,...(o.type==='server'?[]:[o.x,o.y]),o.rot||0]);
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(original)).digest('hex'),'b32ddedce61f90b13fe3fcc4afbeb3b8c698ad87fb9da313c880dca1ad16cc6b');
  assert.equal(W.OBJECTS.filter(o=>o.type==='server').length,6);
});

step('IT wing has four six-seat islands with facing rows and paired arm monitors', () => {
  const desks = W.OBJECTS.filter(o => o.itDesk);
  assert.strictEqual(desks.length, 24);
  for (const cy of [380, 1020]) for (const cx of [1700, 2360]) {
    const cluster = desks.filter(d => Math.abs(d.x - cx*K) <= 160*K+.001 && Math.abs(Math.abs(d.y-cy*K)-58*K)<.001);
    assert.strictEqual(cluster.length, 6);
    assert.strictEqual(cluster.filter(d => d.y < cy*K).length, 3);
    assert.strictEqual(cluster.filter(d => d.y > cy*K).length, 3);
    for (const d of cluster) {
      const monitors = W.OBJECTS.filter(o => o.arm && Math.abs(o.x - d.x) <= 30*K+.001 && Math.abs(o.y - d.y) <= 5*K+.001);
      assert.strictEqual(monitors.length, 2);
      assert.ok(monitors.every(o => (o.rot || 0) === (d.rot || 0)));
      const chair = W.OBJECTS[d.id + 3];
      assert.strictEqual(chair.type, 'chair');
      assert.ok(d.y < cy*K ? chair.y < d.y : chair.y > d.y);
      assert.strictEqual(d.rot || 0, d.y < cy*K ? Math.PI : 0);
    }
  }
});
step('hall screen is enlarged with a matching server collision footprint', () => {
  const tv = W.OBJECTS.find(o => o.type === 'tv' && o.screenScale);
  assert.ok(tv && tv.screenScale === 3.5);
  assert.ok(W.COLLIDERS.some(([x,y,hw,hh]) => x === tv.x && y === tv.y && hw === W.TYPES.tv.h / 2 && hh === 92 * tv.screenScale / 2));
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
  assert.ok(!walls.some(p=>Math.abs(p.x-1400*K)<1&&p.y<1260*K),'no divider between workspaces');
  assert.ok(!walls.some(p=>Math.abs(p.y-1260*K)<1&&p.x<2700*K),'workspace opens onto circulation');
  const room=W.FLOOR_ROOMS.find(r=>r.name==='SERVER / VKL');
  assert.deepStrictEqual(W.WORLD.duelDoor,{x:room.x0,y:room.door.at,width:room.door.w,axis:'y'});
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
