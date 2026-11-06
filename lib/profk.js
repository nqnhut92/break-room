'use strict';

// "Prof. K": a supporter NPC who lives in the DIRECTOR room. Every 60–90 s (announced 5 s ahead) he goes out for
// 30 s and punches VKL wherever VKL is, then walks home. He cannot be hurt, VKL never targets him, and his
// punches only take HP off VKL while a player has damaged VKL within the last two seconds. His damage is
// credited to nobody. docs/BOSS.md#prof-k explains the rules.
//
// Pure like lib/boss.js: lib/realtime.js feeds it time, VKL and the players, and stores the state.

const { move, nav } = require('./miniboss');
const { BOSS } = require('./boss');
const { FLOOR_ROOMS, clearLine } = require('./world');
const { EVENT_GAP_MS } = require('./office-patrol');

const PROFK = {
  radius: 28, // between TML/DMM (22) and VKL (34)
  walkSpeed: 210, // minis wander at 180–200, VKL patrols at 220
  runSpeed: 470, // minis chase at 440–460, VKL at 480
  restMinMs: 60000,
  restMaxMs: 90000,
  warningMs: 5000,
  seekMs: 20000, // walking out to find VKL; no contact by then and he gives up and walks home
  fightMs: 30000, // counted from the first time he reaches VKL, not from leaving the room
  gaveUpMs: 4000, // how long clients say he gave up
  damage: 12, // per landed punch, only while players are fighting VKL too
  assistMs: 2000, // "players are fighting": a player damaged VKL this recently
  // VKL's punch and telegraph, twice as fast (owner's request: 0.65 s instead of 1.3 s a punch) for a little less damage
  // per punch, so an outing deals about 1.2× what it did at 20 damage. No New Process.
  overlapChance: 0.25, // share of outings allowed to overlap the office patrol (the rest keep EVENT_GAP_MS apart)
  windupMs: 350,
  recoverMs: 300,
  punchStartDist: BOSS.punchStartDist,
  punchOffset: BOSS.punchOffset,
  punchRadius: BOSS.punchRadius,
};
const DIRECTOR = FLOOR_ROOMS.find(r => r.name === 'DIRECTOR');
const inDirector = (p, margin = 0) => p.x >= DIRECTOR.x0 + margin && p.x <= DIRECTOR.x1 - margin && p.y >= DIRECTOR.y0 + margin && p.y <= DIRECTOR.y1 - margin;
let homeCache = null;
// The walkable cell nearest the middle of the room.
function home() {
  if (homeCache) return homeCache;
  const cx = (DIRECTOR.x0 + DIRECTOR.x1) / 2, cy = (DIRECTOR.y0 + DIRECTOR.y1) / 2;
  let best = null;
  for (const p of nav(PROFK.radius).values()) {
    if (inDirector(p, 40) && (!best || Math.hypot(p.x - cx, p.y - cy) < Math.hypot(best.x - cx, best.y - cy))) best = p;
  }
  homeCache = { x: best.x, y: best.y };
  return homeCache;
}
const rest = (now, rnd, cfg) => now + Math.round(cfg.restMinMs + rnd() * (cfg.restMaxMs - cfg.restMinMs));
// Rolled once per rest: this outing may overlap the patrol (owner: "thỉnh thoảng vẫn trùng"), in both directions.
const mayOverlap = (rnd, cfg) => rnd() >= 1 - (cfg.overlapChance ?? PROFK.overlapChance);

function createProfK(now, rnd = Math.random, cfg = PROFK) {
  const h = home();
  return { id: 'PROFK', version: 0, phase: 'home', nextAt: rest(now, rnd, cfg), mayOverlap: mayOverlap(rnd, cfg), until: 0, x: h.x, y: h.y, d: Math.PI, mode: 'idle', wind: null, recoverAt: 0, goal: null, pauseUntil: 0 };
}

function goHome(s, now, rnd, cfg) {
  Object.assign(s, { phase: 'home', homeAt: now, engaged: false, gaveUpUntil: 0, until: 0, nextAt: rest(now, rnd, cfg), mayOverlap: mayOverlap(rnd, cfg), wind: null, recoverAt: 0, goal: null, mode: 'idle' });
}

// The office patrol is on, ended less than EVENT_GAP_MS ago, or starts before this outing would be over (plus the gap).
function patrolNear(p, now, cfg) {
  if (!p) return false;
  if (p.phase && p.phase !== 'idle') return true;
  if (p.endedAt && now - p.endedAt < EVENT_GAP_MS) return true;
  return !!p.nextAt && p.nextAt - now < cfg.warningMs + cfg.seekMs + cfg.fightMs + EVENT_GAP_MS;
}
// Prof. K is out or just came home: the patrol waits (see nextPatrol's `profk`), unless this outing may overlap.
const profkNear = (s, now) => !!s && !s.mayOverlap && (['warning', 'out', 'returning'].includes(s.phase) || (!!s.homeAt && now - s.homeAt < EVENT_GAP_MS));

// Advance by dt seconds. world = { vkl: { x, y, alive } | null, duel, humans, assistAt, players, blockers, patrol }.
// Returns the punches that landed this step: { sx, sy, x, y, r, hit, real }.
function stepProfK(s, now, dt, world, rnd = Math.random, cfg = PROFK) {
  const events = [];
  const vkl = world.vkl && world.vkl.alive ? world.vkl : null;
  const bodies = (world.players || []).filter(p => !p.dead);
  // Other bosses block Prof. K like players do: the minis (world.blockers) and VKL himself.
  const blockers = [...(world.blockers || []), ...(vkl ? [{ x: vkl.x, y: vkl.y, r: BOSS.radius }] : [])];
  if (s.phase === 'home' && now >= s.nextAt) {
    // A missed outing (no VKL, nobody online, a duel on) is not replayed: just wait for the next one.
    if (vkl && world.humans && !world.duel && !s.mayOverlap && patrolNear(world.patrol, now, cfg)) s.nextAt = now + 2000; // wait for the patrol, not skip
    else if (vkl && world.humans && !world.duel) Object.assign(s, { phase: 'warning', until: now + cfg.warningMs });
    else s.nextAt = rest(now, rnd, cfg);
  }
  if (s.phase === 'warning') {
    if (!vkl) goHome(s, now, rnd, cfg);
    // out: first seeking VKL (until = the seek limit), then engaged (until = 30 s from the first contact)
    else if (now >= s.until) Object.assign(s, { phase: 'out', engaged: false, until: now + cfg.seekMs, goal: null });
  }
  if (s.phase === 'out' && (!vkl || now >= s.until)) {
    const gaveUp = !!vkl && !s.engaged; // could not reach VKL in time (not when VKL died)
    Object.assign(s, { phase: 'returning', until: 0, wind: null, recoverAt: 0, gaveUpUntil: gaveUp ? now + cfg.gaveUpMs : 0 });
  }

  if (s.phase === 'out') {
    if (s.wind) {
      if (now >= s.wind.until) {
        const w = s.wind, hit = Math.hypot(vkl.x - w.x, vkl.y - w.y) <= w.r + BOSS.radius;
        events.push({ sx: s.x, sy: s.y, x: w.x, y: w.y, r: w.r, hit, real: hit && now - (world.assistAt || 0) <= cfg.assistMs });
        s.wind = null; s.mode = 'recover'; s.recoverAt = now + cfg.recoverMs;
      }
    } else if (now < s.recoverAt) s.mode = 'recover';
    else if (Math.hypot(vkl.x - s.x, vkl.y - s.y) <= cfg.punchStartDist && clearLine(s.x, s.y, vkl.x, vkl.y)) {
      if (!s.engaged) Object.assign(s, { engaged: true, until: now + cfg.fightMs }); // the 30 s start at the first contact
      s.d = Math.atan2(vkl.x - s.x, vkl.y - s.y);
      s.wind = { x: s.x + Math.sin(s.d) * cfg.punchOffset, y: s.y + Math.cos(s.d) * cfg.punchOffset, until: now + cfg.windupMs, ms: cfg.windupMs, r: cfg.punchRadius };
      s.mode = 'windup';
    } else {
      s.mode = 'chase';
      move(s, vkl, dt, cfg.runSpeed, now, bodies, cfg.radius, blockers);
    }
  } else if (s.phase === 'returning') {
    const h = home();
    if (Math.hypot(h.x - s.x, h.y - s.y) < 24) goHome(s, now, rnd, cfg);
    else { s.mode = 'chase'; move(s, h, dt, cfg.runSpeed, now, bodies, cfg.radius, blockers); }
  } else if (now >= s.pauseUntil) {
    // home or warning: stroll about the DIRECTOR room
    if (!s.goal || Math.hypot(s.goal.x - s.x, s.goal.y - s.y) < 20) {
      const choices = [...nav(cfg.radius).values()].filter(p => inDirector(p, 60));
      const p = choices[Math.min(choices.length - 1, Math.floor(rnd() * choices.length))];
      s.goal = { x: p.x, y: p.y }; s.pauseUntil = now + 1000 + rnd() * 2000; s.mode = 'idle';
    } else { s.mode = 'wander'; move(s, s.goal, dt, cfg.walkSpeed, now, bodies, cfg.radius, blockers); }
  } else s.mode = 'idle';
  return events;
}

function profkView(s, now) {
  return {
    version: s.version, phase: s.phase, ms: Math.max(0, (s.until || 0) - now), engaged: !!s.engaged,
    gaveUpMs: Math.max(0, (s.gaveUpUntil || 0) - now),
    x: Math.round(s.x), y: Math.round(s.y), d: Math.round(s.d * 100) / 100, mode: s.mode,
    wind: s.wind && { ...s.wind, remainingMs: Math.max(0, s.wind.until - now) },
    cfg: { radius: PROFK.radius, damage: PROFK.damage },
  };
}

module.exports = { PROFK, DIRECTOR, inDirector, home, createProfK, stepProfK, profkView, profkNear };
