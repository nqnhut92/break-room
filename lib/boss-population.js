'use strict';

// Private population state belongs to the shared store, never to a client snapshot.
const POPULATION = { group: 4, holdMs: 15000, maxGapMs: 3000, stepRatio: 0.5 };
const populationMax = (base, humans, cfg = POPULATION) => base * (1 + Math.floor(Math.max(0, humans - 1) / cfg.group) * cfg.stepRatio);
function growPopulation(b, humans, now, base, cfg = POPULATION) {
  const oldMax = b.maxHp || base;
  const desired = Math.floor(Math.max(0, humans - 1) / cfg.group);
  const pending = now - (b.popAt || 0) <= cfg.maxGapMs ? (b.population || {}) : {};
  const next = {};
  let maxHp = oldMax;
  for (let tier = 1; tier <= desired; tier++) {
    const target = base * (1 + tier * cfg.stepRatio);
    if (target <= oldMax) continue;
    next[tier] = pending[tier] ?? now;
    if (now - next[tier] >= cfg.holdMs) maxHp = target;
  }
  b.population = next; b.popAt = now; b.maxHp = maxHp;
  const changed = maxHp > oldMax;
  if (changed) { b.hp = (b.hp ?? oldMax) + maxHp - oldMax; b.at = now; }
  return changed;
}
module.exports = { POPULATION, populationMax, growPopulation };
