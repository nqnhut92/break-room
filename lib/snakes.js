'use strict';

const { WORLD, PLAYER_RADIUS, resolveCollisions, slideMove } = require('./world');
const SNAKE = { hp: 4, radius: 9, speed: 200, biteRange: 26, biteDmg: 5, redBiteDmg: 7, biteCooldownMs: 1200 };
function snakeWaveCount(online, percent = 70, rnd = Math.random) {
  const min = Math.max(1, Math.ceil(online * (percent === 10 ? 2 : 1.3)));
  const max = Math.max(min, online * (percent === 10 ? 3 : 2));
  return min + Math.floor(rnd() * (max - min + 1));
}
const GRID = 40;
const NX = Math.ceil(WORLD.w / GRID), NY = Math.ceil(WORLD.h / GRID);
let nav;
const fields = new Map();
function navigation() {
  if (nav) return nav;
  nav = new Uint8Array(NX * NY);
  for (let y = 1; y < NY; y++) for (let x = 1; x < NX; x++) {
    const p = resolveCollisions(x * GRID, y * GRID, SNAKE.radius);
    if (Math.hypot(p.x - x * GRID, p.y - y * GRID) < 0.5) nav[y * NX + x] = 1;
  }
  return nav;
}
function cell(x, y) {
  const map = navigation(), cx = Math.round(x / GRID), cy = Math.round(y / GRID);
  let best = -1, distance = Infinity;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const a = cx + dx, b = cy + dy, id = b * NX + a;
    if (a < 1 || b < 1 || a >= NX || b >= NY || !map[id]) continue;
    const d = Math.hypot(a * GRID - x, b * GRID - y);
    if (d < distance) { best = id; distance = d; }
  }
  return best;
}
function route(target, now) {
  const goal = cell(target.x, target.y);
  const cached = fields.get(target.id);
  if (cached && cached.goal === goal && now - cached.at < 1000) return cached.distance;
  const map = navigation(), distance = new Int32Array(NX * NY).fill(-1), queue = new Int32Array(NX * NY);
  if (goal >= 0) {
    let head = 0, tail = 1; queue[0] = goal; distance[goal] = 0;
    while (head < tail) {
      const at = queue[head++];
      for (const n of [at - 1, at + 1, at - NX, at + NX]) {
        if (n < 0 || n >= map.length || !map[n] || distance[n] >= 0 || Math.abs(n % NX - at % NX) > 1) continue;
        distance[n] = distance[at] + 1; queue[tail++] = n;
      }
    }
  }
  fields.set(target.id, { goal, at: now, distance });
  return distance;
}
function stepSnakes(snakes, dt, targets, now) {
  const live = targets.filter(p => !p.dead);
  // Keep navigation caches bounded as players leave and join rooms.
  for (const [id, field] of fields) if (now - field.at > 10000) fields.delete(id);
  const events = [];
  for (const s of snakes) {
    if (s.hp <= 0 || !live.length) continue;
    const target = live.reduce((a, b) => Math.hypot(a.x - s.x, a.y - s.y) <= Math.hypot(b.x - s.x, b.y - s.y) ? a : b);
    let tx = target.x, ty = target.y;
    const distance = route(target, now), here = cell(s.x, s.y);
    if (here >= 0 && distance[here] > 0) {
      let next = here;
      for (const n of [here - 1, here + 1, here - NX, here + NX]) {
        if (n >= 0 && n < distance.length && distance[n] >= 0 && distance[n] < distance[next]) next = n;
      }
      tx = next % NX * GRID; ty = Math.floor(next / NX) * GRID;
    }
    const dx = tx - s.x, dy = ty - s.y, len = Math.hypot(dx, dy);
    if (len > 1) {
      const step = Math.min(len, SNAKE.speed * dt);
      const p = slideMove(s.x, s.y, s.x + dx / len * step, s.y + dy / len * step, SNAKE.radius);
      s.x = p.x; s.y = p.y; s.d = Math.atan2(dx, dy);
    }
    if (Math.hypot(target.x - s.x, target.y - s.y) <= SNAKE.biteRange + PLAYER_RADIUS && now >= (s.biteAt || 0)) {
      s.biteAt = now + SNAKE.biteCooldownMs;
      events.push({ id: s.id, target: target.id, x: s.x, y: s.y, dmg: s.variant === 'red' ? SNAKE.redBiteDmg : SNAKE.biteDmg });
    }
  }
  return events;
}
// Walk one entity (anything with x, y, d) a step towards a point along the same navigation grid the snakes use.
// `key` names the goal so its route can be cached for a second. Returns the distance left to the point.
function stepToward(e, goalX, goalY, dt, speed, radius, now, key) {
  const distance = route({ id: key, x: goalX, y: goalY }, now), here = cell(e.x, e.y);
  let tx = goalX, ty = goalY;
  if (here >= 0 && distance[here] > 0) {
    let next = here;
    for (const n of [here - 1, here + 1, here - NX, here + NX]) {
      if (n >= 0 && n < distance.length && distance[n] >= 0 && distance[n] < distance[next]) next = n;
    }
    tx = next % NX * GRID; ty = Math.floor(next / NX) * GRID;
  }
  const dx = tx - e.x, dy = ty - e.y, len = Math.hypot(dx, dy);
  if (len > 1) {
    const step = Math.min(len, speed * dt);
    const p = slideMove(e.x, e.y, e.x + dx / len * step, e.y + dy / len * step, radius);
    e.x = p.x; e.y = p.y; e.d = Math.atan2(dx, dy);
  }
  return Math.hypot(goalX - e.x, goalY - e.y);
}
module.exports = { SNAKE, stepSnakes, stepToward, snakeWaveCount };
