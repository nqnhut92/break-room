'use strict';

const PATROL = { minMs: 180000, maxMs: 300000, warningMs: 5000, durationMs: 30000, protectionMs: 3000 };
const emptyPatrol = () => ({ version: 0, phase: 'idle', nextAt: 0, until: 0, pose: null });
const patrolActive = (s, now) => s?.phase === 'active' && now < s.until;
function nextPatrol(old, now, { alive, duel, humans, home }, rnd = Math.random, cfg = PATROL) {
  const s = { ...(old || emptyPatrol()) };
  const idle = () => ({ ...s, phase: 'idle', until: 0, nextAt: now + Math.round(cfg.minMs + rnd() * (cfg.maxMs - cfg.minMs)) });
  if (!s.nextAt) return idle();
  if (s.phase === 'warning') {
    if (!alive || now >= s.until + cfg.durationMs) return idle();
    if (now >= s.until) return { ...s, phase: 'active', until: now + cfg.durationMs };
  } else if (s.phase === 'active') {
    if (now >= s.until) return { ...s, phase: 'returning', until: 0 };
  } else if (s.phase === 'returning') {
    if (home || !alive) return idle();
  } else if (now >= s.nextAt && !duel) {
    return alive && humans ? { ...s, phase: 'warning', until: now + cfg.warningMs } : idle();
  }
  return s;
}
module.exports = { PATROL, emptyPatrol, patrolActive, nextPatrol };
