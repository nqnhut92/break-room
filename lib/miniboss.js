'use strict';

const actorCollision = require('../public/actor-collision');
const { PLAYER_RADIUS, WORLD, resolveCollisions, clearLine } = require('./world');
const MINI = {
  TML: { maxHp: 900, damage: 20, windupMs: 850, recoverMs: 1000, speed: 460, wanderSpeed: 200, bounty: 40 },
  DMM: { maxHp: 600, damage: 15, windupMs: 650, recoverMs: 800, speed: 440, wanderSpeed: 180, bounty: 30 },
};
const RADIUS = 22, REACH = 130, STRIKE_RADIUS = 75, RESPAWN_MS = 30000;
const GRID = 40, NX = Math.ceil(WORLD.w / GRID);
const navigation = new Map();
const routes = new Map();
function free(x, y, radius = RADIUS) {
  const p = resolveCollisions(x, y, radius);
  return Math.hypot(p.x - x, p.y - y) < 0.1;
}
function clearWalk(a, b, radius) {
  if (!clearLine(a.x, a.y, b.x, b.y)) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 10));
  for (let i = 1; i <= steps; i++) if (!free(a.x + (b.x-a.x)*i/steps, a.y + (b.y-a.y)*i/steps, radius)) return false;
  return true;
}
// Only floor connected to the lobby is eligible. Test edges too, so thin walls cannot join two cells.
function nav(radius = RADIUS) {
  if (navigation.has(radius)) return navigation.get(radius);
  const cells = new Map();
  for (let y = GRID; y < WORLD.h; y += GRID) for (let x = GRID; x < WORLD.w; x += GRID) {
    if (free(x, y, radius)) cells.set(y / GRID * NX + x / GRID, { x, y, edges: [] });
  }
  for (const [id, p] of cells) for (const n of [id + 1, id + NX]) {
    const q = cells.get(n);
    if (q && Math.hypot(p.x - q.x, p.y - q.y) <= GRID && clearLine(p.x, p.y, q.x, q.y) && free((p.x + q.x) / 2, (p.y + q.y) / 2, radius)) {
      p.edges.push(n); q.edges.push(id);
    }
  }
  const home = [...cells].reduce((a, b) => Math.hypot(b[1].x - WORLD.spawn.x, b[1].y - WORLD.spawn.y) < Math.hypot(a[1].x - WORLD.spawn.x, a[1].y - WORLD.spawn.y) ? b : a);
  const seen = new Set([home[0]]), queue = [home[0]];
  for (let i = 0; i < queue.length; i++) for (const n of cells.get(queue[i]).edges) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  const connected = new Map([...cells].filter(([id]) => seen.has(id)));
  navigation.set(radius, connected);
  return connected;
}
function nearest(x, y, radius = RADIUS) {
  let best, d = Infinity;
  for (const [id, p] of nav(radius)) {
    const next = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (next < d) { d = next; best = id; }
  }
  return best;
}
function spawn(avoid = [], rnd = Math.random) {
  const points = [...nav().values()];
  const choices = points.filter(p => avoid.every(a => Math.hypot(a.x - p.x, a.y - p.y) >= (a.distance || 180)));
  const p = (choices.length ? choices : points)[Math.min((choices.length || points.length) - 1, Math.floor(rnd() * (choices.length || points.length)))];
  return { x: p.x, y: p.y };
}
function createMini(id, avoid = [], rnd = Math.random) {
  return { id, ...spawn(avoid, rnd), d: 0, hp: MINI[id].maxHp, mode: 'idle', respawnAt: 0, threat: {}, ledger: {}, lastHit: 0, wind: null, recoverAt: 0, goal: null, pauseUntil: 0 };
}
function initialState(avoid = [], rnd = Math.random) {
  const a = createMini('TML', avoid, rnd);
  return { version: 0, list: [a, createMini('DMM', [...avoid, { ...a, distance: 240 }], rnd)] };
}
const nearestId = p => p.y / GRID * NX + p.x / GRID;
function move(b, target, dt, speed, now, players = [], radius = RADIUS) {
  const map = nav(radius), goal = nearest(target.x, target.y, radius), here = nearest(b.x, b.y, radius);
  const routeKey = b.id + ':' + radius;
  let cache = routes.get(routeKey);
  if (!cache || cache.goal !== goal || now - cache.at >= 1000) {
    const dist = new Map([[goal, 0]]), queue = [goal];
    for (let i = 0; i < queue.length; i++) for (const n of map.get(queue[i]).edges) if (!dist.has(n)) { dist.set(n, dist.get(queue[i]) + 1); queue.push(n); }
    cache = { goal, at: now, dist }; routes.set(routeKey, cache);
  }
  let point = map.get(here);
  if (cache.dist.get(here) > 0) {
    for (const n of point.edges) if (cache.dist.get(n) < cache.dist.get(here)) { point = map.get(n); break; }
  }
  if (clearWalk(b, target, radius)) point = target;
  else {
    let cursor = point;
    for (let i = 0; i < 12; i++) {
      const next = cursor.edges.map(n => map.get(n)).find(p => cache.dist.get(nearestId(p)) < cache.dist.get(nearestId(cursor)));
      if (!next) break;
      if (clearWalk(b, next, radius)) point = next;
      else break;
      cursor = next;
    }
  }
  const dx = point.x - b.x, dy = point.y - b.y, len = Math.hypot(dx, dy);
  if (len > 1) {
    const step = Math.min(len, dt * speed), p = actorCollision.slide(b.x, b.y, b.x + dx / len * step, b.y + dy / len * step, radius, players.filter(p=>!p.dead).map(p=>({x:p.x,y:p.y,r:PLAYER_RADIUS})), (x,y)=>resolveCollisions(x,y,radius));
    b.x = p.x; b.y = p.y; b.d = Math.atan2(dx, dy);
  }
}
function hitMini(b, playerId, damage, now) {
  if (!b || b.hp <= 0) return null;
  const dmg = Math.min(b.hp, damage);
  b.hp -= dmg; b.lastHit = now;
  const old = b.threat[playerId];
  b.threat[playerId] = { at: now, damage: dmg + (old && now - old.at < 8000 ? old.damage : 0) };
  b.ledger[playerId] = (b.ledger[playerId] || 0) + dmg;
  const shares = [];
  if (b.hp <= 0) {
    b.mode = 'dead'; b.wind = null; b.respawnAt = now + RESPAWN_MS;
    const total = Object.values(b.ledger).reduce((n, d) => n + d, 0);
    for (const [id, dealt] of Object.entries(b.ledger)) shares.push({ id: Number(id), dmg: dealt, bounty: MINI[b.id].bounty * dealt / total });
  }
  return { dmg, shares };
}
function stepMini(state, targets, now, dt, rnd = Math.random, patrol = false, reserved = []) {
  const events = [];
  for (let i = 0; i < state.list.length; i++) {
    let b = state.list[i];
    if (b.hp <= 0) {
      if (now >= b.respawnAt) state.list[i] = createMini(b.id, [...targets.filter(p => !p.dead), ...state.list.filter(p => p !== b && p.hp > 0).map(p => ({ ...p, distance: 240 })), { ...b, distance: 240 }], rnd);
      continue;
    }
    if (!!b.onPatrol !== patrol) { b.wind = null; b.onPatrol = patrol; }
    const cfg = MINI[b.id], live = targets.filter(p => !p.dead && b.threat[p.id]);
    for (const id of Object.keys(b.threat)) if (!live.some(p => String(p.id) === id)) delete b.threat[id];
    if (now - b.lastHit >= 8000 && !live.some(p => Math.hypot(p.x - b.x, p.y - b.y) < 600)) b.threat = {};
    const candidates = targets.filter(p => !p.dead && Math.hypot(p.x - b.x, p.y - b.y) <= 650);
    const unclaimed = candidates.filter(p => !reserved.includes(p.id));
    const eligible = patrol ? candidates : live.filter(p => b.threat[p.id]);
    const choices = patrol && unclaimed.length ? unclaimed : eligible;
    const target = choices.sort((a, c) => {
      const score = p => now - b.threat[p.id].at < 8000 ? b.threat[p.id].damage : 0;
      return (patrol ? 0 : score(c) - score(a)) || Math.hypot(a.x - b.x, a.y - b.y) - Math.hypot(c.x - b.x, c.y - b.y);
    })[0];
    if (patrol && target) reserved.push(target.id);
    if (!target) { b.wind = null; b.mode = 'idle'; }
    if (b.wind) {
      if (now >= b.wind.until) {
        const w = b.wind;
        events.push({ id: b.id, sx: b.x, sy: b.y, x: w.x, y: w.y, r: STRIKE_RADIUS, dmg: cfg.damage, targets: eligible.map(p => p.id) });
        b.wind = null; b.mode = 'recover'; b.recoverAt = now + cfg.recoverMs;
      }
      continue;
    }
    if (target) {
      if (now < b.recoverAt) { b.mode = 'recover'; continue; }
      if (Math.hypot(target.x - b.x, target.y - b.y) <= 100 && clearLine(b.x, b.y, target.x, target.y)) {
        b.d = Math.atan2(target.x - b.x, target.y - b.y);
        b.wind = { x: b.x + Math.sin(b.d) * 50, y: b.y + Math.cos(b.d) * 50, until: now + cfg.windupMs, ms: cfg.windupMs, r: STRIKE_RADIUS };
        b.mode = 'windup';
      } else { b.mode = 'chase'; move(b, target, dt, cfg.speed, now, targets); }
    } else if (now >= b.pauseUntil) {
      if (!b.goal || Math.hypot(b.goal.x - b.x, b.goal.y - b.y) < 20) {
        const choices = [...nav().values()].filter(p => Math.hypot(p.x - b.x, p.y - b.y) < 400);
        const p = choices[Math.min(choices.length - 1, Math.floor(rnd() * choices.length))];
        b.goal = { x: p.x, y: p.y }; b.pauseUntil = now + 1000 + rnd() * 2000;
      } else { b.mode = 'wander'; move(b, b.goal, dt, cfg.wanderSpeed, now, targets); }
    }
  }
  return events;
}
function miniView(state, now) {
  return { version: state.version, list: state.list.map(b => ({ id: b.id, x: b.x, y: b.y, d: b.d, hp: b.hp, mode: b.mode, respawnMs: Math.max(0, b.respawnAt - now), wind: b.wind && { ...b.wind, remainingMs: Math.max(0, b.wind.until - now) }, cfg: { ...MINI[b.id], reach: REACH, radius: RADIUS } })) };
}
module.exports = { MINI, RADIUS, REACH, RESPAWN_MS, move, nav, spawn, createMini, initialState, hitMini, stepMini, miniView };
