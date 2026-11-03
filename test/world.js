'use strict';

// Sanity checks on the office layout itself: nothing unreachable, nothing stuck
// inside furniture, and the collision maths behaves.

const assert = require('assert');
const W = require('../lib/world.js');

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

step('object ids are dense and every type is known', () => {
  W.OBJECTS.forEach((o, i) => {
    assert.strictEqual(o.id, i);
    assert.ok(W.TYPES[o.type], o.type);
    assert.ok(o.x >= 0 && o.x <= W.WORLD.w && o.y >= 0 && o.y <= W.WORLD.h, 'inside the world: ' + o.id);
  });
  assert.ok(W.OBJECTS.length > 100);
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

console.log('\nAll ' + passed + ' checks passed');
