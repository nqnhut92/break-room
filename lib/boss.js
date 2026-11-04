'use strict';

// "Sếp VKL": the boss of each server room, and the health rules for players.
//
// Everything that decides how hard the fight is lives in BOSS and PLAYER below, so balance changes are one
// edit. docs/BOSS.md explains why the numbers are what they are.
//
// This file is pure: no sockets, no store, no clock of its own. lib/realtime.js feeds it time and targets,
// and the tests drive it directly.

const { BOSS_HOME, BOSS_PATROL, BOSS_ROOM, inBossZone, slideMove } = require('./world');

const BOSS = {
  name: 'Sếp VKL',
  maxHp: 3600, // about five players need two minutes; one or two cannot out-damage the regeneration at all
  hitDmg: 10, // damage of one hammer hit on the boss (an object loses 1 "hp" per hit; these are separate scales)
  teamRef: 5, // players in the room it was tuned for: with more of them inside, every hit counts for less (see hitScale)
  baseRegenPerSec: 5, // hp it always recovers per second, so one player trickling hits can never wear it down
  regenPerSec: 20, // and this much more per second...
  regenDelayMs: 5000, // ...once nobody has hit it for this long (so hit and run does not work either)
  respawnMinMs: 180000, // after it is beaten it comes back 3 to 5 minutes later
  respawnMaxMs: 300000,
  bounty: 500, // million VND added to the damage board when it falls, split by damage dealt
  radius: 34, // how much floor it takes up (collisions)
  reach: 150, // a hammer hit lands when the player is within this distance of its centre
  patrolSpeed: 110,
  chaseSpeed: 280, // slower than a player (420): you can run away, you cannot out-run it for long and still hit it
  punchDmg: 30, // four punches kill a player
  windupMs: 700, // the fist is raised and the red circle shows where it will land
  recoverMs: 600,
  punchStartDist: 115, // it starts a punch when the target is this close
  punchOffset: 85, // the punch lands this far in front of it...
  punchRadius: 105, // ...in a circle of this radius
};

const PLAYER = {
  maxHp: 100,
  regenDelayMs: 4000, // out of trouble for this long, then...
  regenPerSec: 5, // ...a full bar again in about 20 seconds
  respawnMs: 15000, // knocked out for 15 seconds, then back at the lobby, never on the spot
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The boss's hp now, given the value stored at time `at` (ms). Regeneration is computed, never ticked, so it
// costs nothing while nobody is around and works the same on every instance.
function bossHpAt(hp, at, now, cfg = BOSS) {
  const e = Math.max(0, now - at);
  const fast = Math.max(0, e - cfg.regenDelayMs);
  return Math.min(cfg.maxHp, hp + (e * cfg.baseRegenPerSec + fast * cfg.regenPerSec) / 1000);
}

function playerHpAt(hp, at, now, cfg = PLAYER) {
  const e = now - at - cfg.regenDelayMs;
  return e > 0 ? Math.min(cfg.maxHp, hp + (e * cfg.regenPerSec) / 1000) : Math.min(cfg.maxHp, hp);
}

// Up to teamRef players inside the room the boss is as tuned; with more of them each hit counts for less, so a
// crowd of twenty does not walk over it. Counted from who is actually in the boss's room, not who is online.
function hitScale(engaged, cfg = BOSS) {
  return Math.max(1, engaged / cfg.teamRef);
}

function createBossState(now = 0) {
  return {
    x: BOSS_HOME.x,
    y: BOSS_HOME.y,
    d: 0, // heading in radians, (sin d, cos d) is the way it faces (the world's y is the 3D z)
    mode: 'patrol', // patrol | chase | windup | recover | dead
    t: 0, // time left in windup / recover (s)
    pause: 0, // time left standing at a waypoint (s)
    wp: 0,
    tid: 0, // current target id
    retarget: 0,
    lose: 0, // time without any target while chasing
    strike: null, // { x, y } of the punch being wound up
    stuckT: 0,
    sx: BOSS_HOME.x,
    sy: BOSS_HOME.y,
    side: 0, // sidestep direction while stuck (-1, 0, 1)
    sideT: 0,
    since: now,
  };
}

// Walk towards (tx, ty) for `step` units; slide along furniture and never leave the boss's zone.
function walk(b, tx, ty, step) {
  const dx = tx - b.x;
  const dy = ty - b.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return len;
  let vx = dx / len;
  let vy = dy / len;
  if (b.sideT > 0 && b.side) {
    // stuck behind something: lean sideways for a moment
    const px = -vy * b.side;
    const py = vx * b.side;
    vx = vx * 0.5 + px;
    vy = vy * 0.5 + py;
    const l = Math.hypot(vx, vy) || 1;
    vx /= l;
    vy /= l;
  }
  const s = Math.min(step, len);
  const moved = slideMove(b.x, b.y, b.x + vx * s, b.y + vy * s, BOSS.radius);
  if (inBossZone(moved.x, moved.y)) {
    b.x = moved.x;
    b.y = moved.y;
  }
  b.d = Math.atan2(dx, dy);
  return len;
}

// Advance the boss by dt seconds. `targets` are the alive players inside the zone ({ id, x, y }).
// Returns the things that happened: { type: 'windup' | 'strike', x, y, r, ms | dmg }.
function stepBoss(b, dt, targets, rnd = Math.random) {
  const ev = [];
  if (b.mode === 'dead') return ev;

  // stuck detection: standing still for a second while trying to get somewhere
  b.stuckT += dt;
  if (b.sideT > 0) b.sideT -= dt;
  if (b.stuckT >= 1) {
    const moved = Math.hypot(b.x - b.sx, b.y - b.sy);
    const trying = b.mode === 'chase' || (b.mode === 'patrol' && b.pause <= 0);
    if (trying && moved < 10) {
      b.side = rnd() < 0.5 ? -1 : 1;
      b.sideT = 0.8;
    }
    b.stuckT = 0;
    b.sx = b.x;
    b.sy = b.y;
  }

  const pickTarget = () => {
    let best = null;
    let bd = Infinity;
    for (const t of targets) {
      const d = Math.hypot(t.x - b.x, t.y - b.y);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return best;
  };

  switch (b.mode) {
    case 'patrol': {
      if (targets.length) {
        b.mode = 'chase';
        b.lose = 0;
        b.retarget = 0;
        break;
      }
      if (b.pause > 0) {
        b.pause -= dt;
        break;
      }
      const [wx, wy] = BOSS_PATROL[b.wp % BOSS_PATROL.length];
      const left = walk(b, wx, wy, BOSS.patrolSpeed * dt);
      if (left < 24) {
        b.wp = (b.wp + 1) % BOSS_PATROL.length;
        b.pause = 1.2 + rnd() * 1.8;
      }
      break;
    }
    case 'chase': {
      b.retarget -= dt;
      let tgt = targets.find((t) => t.id === b.tid);
      if (!tgt || b.retarget <= 0) {
        tgt = pickTarget() || tgt;
        b.retarget = 0.5;
      }
      if (!tgt) {
        b.tid = 0;
        b.lose += dt;
        if (b.lose > 2) b.mode = 'patrol';
        break;
      }
      b.lose = 0;
      b.tid = tgt.id;
      const dist = Math.hypot(tgt.x - b.x, tgt.y - b.y);
      if (dist <= BOSS.punchStartDist) {
        b.d = Math.atan2(tgt.x - b.x, tgt.y - b.y);
        b.strike = { x: b.x + Math.sin(b.d) * BOSS.punchOffset, y: b.y + Math.cos(b.d) * BOSS.punchOffset };
        b.mode = 'windup';
        b.t = BOSS.windupMs / 1000;
        ev.push({ type: 'windup', x: b.strike.x, y: b.strike.y, r: BOSS.punchRadius, ms: BOSS.windupMs });
        break;
      }
      walk(b, tgt.x, tgt.y, BOSS.chaseSpeed * dt);
      break;
    }
    case 'windup': {
      b.t -= dt;
      if (b.t <= 0) {
        ev.push({ type: 'strike', x: b.strike.x, y: b.strike.y, r: BOSS.punchRadius, dmg: BOSS.punchDmg });
        b.mode = 'recover';
        b.t = BOSS.recoverMs / 1000;
      }
      break;
    }
    case 'recover': {
      b.t -= dt;
      if (b.t <= 0) b.mode = targets.length ? 'chase' : 'patrol';
      break;
    }
    default:
      break;
  }
  return ev;
}

// Random wait before the boss comes back after being beaten.
function respawnDelay(rnd = Math.random) {
  return Math.round(BOSS.respawnMinMs + rnd() * (BOSS.respawnMaxMs - BOSS.respawnMinMs));
}

module.exports = {
  BOSS,
  PLAYER,
  BOSS_ROOM,
  bossHpAt,
  playerHpAt,
  hitScale,
  createBossState,
  stepBoss,
  respawnDelay,
  clamp,
};
