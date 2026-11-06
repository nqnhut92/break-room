'use strict';

const { BOSS_ROOM, WORLD, PLAYER_RADIUS, resolveCollisions, layoutPoint, serverPoint } = require('./world');
const DUEL = { minMs: 40000, maxMs: 60000, durationMs: 20000, apologyMs: 10000, nearRadius: 320, pullMs: 850, blowMs: 600 };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const insideRoom = (x, y, margin = 0) => x >= BOSS_ROOM.x0 - margin && x <= BOSS_ROOM.x1 + margin && y >= BOSS_ROOM.y0 - margin && y <= BOSS_ROOM.y1 + margin;
const activeDuel = (duel, now) => !!(duel && duel.target && now < duel.until);
const canApologize = (duel, id, version, now) => activeDuel(duel, now) && duel.target === id && duel.version === version && now >= duel.startedAt + DUEL.apologyMs;
const emptyDuel = () => ({ version: 0, nextAt: 0, target: 0, until: 0, moves: [] });
function nearRoom(p) {
  const x = clamp(p.x, BOSS_ROOM.x0, BOSS_ROOM.x1), y = clamp(p.y, BOSS_ROOM.y0, BOSS_ROOM.y1);
  return !p.dead && Math.hypot(p.x - x, p.y - y) <= DUEL.nearRadius;
}
function outsidePoint(index = 0) {
  // The west doorway opens onto a clear corridor. Spread the expelled players out along it.
  return resolveCollisions(BOSS_ROOM.x0 - 180 - Math.floor(index / 5) * 42, WORLD.duelDoor.y-layoutPoint(0,60).y + index % 5 * 30);
}
function containPoint(x, y) {
  return resolveCollisions(clamp(x, BOSS_ROOM.x0 + PLAYER_RADIUS, BOSS_ROOM.x1 - PLAYER_RADIUS), clamp(y, BOSS_ROOM.y0 + PLAYER_RADIUS, BOSS_ROOM.y1 - PLAYER_RADIUS));
}
function duelPosition(duel, id, x, y, now) {
  if (!activeDuel(duel, now)) return { x, y };
  if (id === duel.target) return containPoint(x, y);
  return insideRoom(x, y, PLAYER_RADIUS) ? outsidePoint(id % 5) : { x, y };
}
// Pure scheduling/selection. The store commits this state with a version check and the boss lease.
function nextDuel(state, now, players, bossAlive, rnd = Math.random, cfg = DUEL) {
  const old = state || emptyDuel();
  const schedule = () => now + Math.round(cfg.minMs + rnd() * (cfg.maxMs - cfg.minMs));
  if (!old.nextAt) return { ...old, version: old.version + 1, nextAt: schedule() };
  if (activeDuel(old, now)) {
    // A captured position from an older floor plan must not lock players to a moved room.
    const landing=old.moves?.find(m=>m.kind==='pull');
    if (landing && !insideRoom(landing.x,landing.y)) return {...old,version:old.version+1,target:0,until:0,moves:[]};
    if (bossAlive && !players.some(p => p.id === old.target && p.dead)) return null;
    return { ...old, version: old.version + 1, target: 0, until: 0, moves: [] };
  }
  if (old.target) return { ...old, version: old.version + 1, target: 0, until: 0, moves: [] };
  if (!bossAlive || now < old.nextAt) return null;
  const candidates = players.filter(nearRoom);
  const next = { ...old, version: old.version + 1, nextAt: schedule(), moves: [] };
  if (!candidates.length) return next;
  const target = candidates[Math.min(candidates.length - 1, Math.floor(rnd() * candidates.length))];
  const landing = (({ x, y }) => resolveCollisions(x, y))(serverPoint(220,440));
  next.target = target.id;
  next.startedAt = now;
  next.until = now + cfg.durationMs;
  next.moves.push({ id: target.id, fromX: target.x, fromY: target.y, ...landing, kind: 'pull' });
  let expelled = 0;
  for (const p of players) {
    if (p.id === target.id || p.dead || !insideRoom(p.x, p.y, PLAYER_RADIUS)) continue;
    next.moves.push({ id: p.id, fromX: p.x, fromY: p.y, ...outsidePoint(expelled++), kind: 'blow' });
  }
  return next;
}
module.exports = { DUEL, emptyDuel, activeDuel, canApologize, insideRoom, nearRoom, outsidePoint, duelPosition, nextDuel };
