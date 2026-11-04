'use strict';

// Re-evaluated from one shared room snapshot before each respawn sweep.
const OBJECT_RESPAWN = Object.freeze({ minMs: 25000, maxMs: 60000, playerStepMs: 2500, brokenStepMs: 500, graceBroken: 3 });
function objectRespawnMs(players, broken, fixedMs = 0) {
  if (Number.isFinite(fixedMs) && fixedMs > 0) return fixedMs;
  const p = OBJECT_RESPAWN;
  return Math.max(p.minMs, p.maxMs - p.playerStepMs * Math.max(0, players - 1) - p.brokenStepMs * Math.max(0, broken - p.graceBroken));
}
module.exports = { OBJECT_RESPAWN, objectRespawnMs };
