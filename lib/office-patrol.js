'use strict';

const PATROL = { minMs: 120000, maxMs: 180000, warningMs: 5000, durationMs: 30000 };
// The patrol and Prof. K's outing both still happen, but not on top of each other: one that falls due while the other is
// on (or ended less than this long ago) waits. Prof. K also stays home when the patrol is about to start.
const EVENT_GAP_MS = 20000;
const emptyPatrol = () => ({ version: 0, phase: 'idle', nextAt: 0, until: 0, pose: null });
const patrolActive = (s, now) => s?.phase === 'active' && now < s.until;
// profk: Prof. K is out (warning, fighting or walking home) or came home less than EVENT_GAP_MS ago; the patrol waits.
function nextPatrol(old, now, { alive, duel, humans, home, profk = false }, rnd = Math.random, cfg = PATROL) {
  const s = { ...(old || emptyPatrol()) };
  // endedAt: when the last patrol finished, so Prof. K can keep his distance
  const idle = () => ({ ...s, phase: 'idle', until: 0, endedAt: s.phase !== 'idle' ? now : (s.endedAt || 0), nextAt: now + Math.round(cfg.minMs + rnd() * (cfg.maxMs - cfg.minMs)) });
  if (!s.nextAt) return idle();
  if (s.phase === 'warning') {
    if (!alive || now >= s.until + cfg.durationMs) return idle();
    if (now >= s.until) return { ...s, phase: 'active', until: now + cfg.durationMs };
  } else if (s.phase === 'active') {
    if (now >= s.until) return { ...s, phase: 'returning', until: 0 };
  } else if (s.phase === 'returning') {
    if (home || !alive) return idle();
  } else if (now >= s.nextAt && !duel && !profk) {
    return alive && humans ? { ...s, phase: 'warning', until: now + cfg.warningMs } : idle();
  }
  return s;
}
module.exports = { PATROL, EVENT_GAP_MS, emptyPatrol, patrolActive, nextPatrol };
