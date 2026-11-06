'use strict';

// "Bạn sếp nằm vùng": players that are really the boss's friends. They join a room like anybody else (a name, a face, a
// slot in the online count), walk about and smash office things like a player would, and after a while sneak up on someone and
// stab them with no warning. The stab gives them away; from then on they chase and hit people until somebody takes them
// down. Any hit on one also gives it away at once.
//
// This file is pure: no sockets, no store, no clock of its own. lib/realtime.js runs it on the instance that leads the room
// and applies the events it returns; the tests drive it directly.

const { OBJECTS, TYPES, WORLD, inBossZone, resolveCollisions } = require('./world');
const { stepToward } = require('./snakes');

const MOLE = {
  hp: 8, // like a server cabinet, and the bounty is the same as a cabinet's (see TYPES.server)
  speed: 300, // a player runs at 420: you can catch one
  radius: 16,
  mingleMs: [20000, 90000], // how long it passes for a normal player before it goes for someone
  stabRange: 52,
  stabDmg: 30, // the first blow, a boss punch's worth
  rageMs: 40000, // once it is found out it fights this long and then leaves
  rageRange: 58,
  rageDmg: 20, // then a hammer hit
  rageCooldownMs: 1300,
  smashCooldownMs: [650, 1000],
  smashRange: 62,
  goalGiveUpMs: 8000, // could not get next to the thing in this long: pick something else
  lifeMs: 240000, // nobody lingers longer than this, whatever happens
};

// Names the way people actually type them into the join box: nicknames, no diacritics, lowercase handles, a birth year,
// an initial. Fifty full Vietnamese names in a row would give the bots away. 14 characters at most (cleanName).
const SHORT = ['Tuan', 'Linh', 'Hung', 'Mai', 'Khoa', 'Nam', 'Huy', 'An', 'Trang', 'Vy', 'Duc', 'Quan', 'Bao', 'Phuc', 'Thu', 'Ngan', 'Long', 'Son', 'Hieu', 'Dat', 'Minh', 'Lan', 'Nhi', 'Tien', 'Thang', 'Chi', 'Hoa', 'Kien', 'Tam', 'Phong'];
const NICK = ['Nick', 'Jack', 'Ken', 'Tom', 'Leo', 'Amy', 'Kim', 'Mia', 'Sam', 'Max', 'Bin', 'Bu', 'Heo', 'Meo', 'Chip', 'Bo', 'Kem', 'Su', 'Ti', 'Tun', 'Mon', 'Cam', 'Alex', 'Lily', 'Rio', 'Zin', 'Kuro', 'Boss2'];
const ACCENT = ['Hùng', 'Trâm', 'Thảo', 'Quý', 'Dũng', 'Hà', 'Đạt', 'Nhung', 'Tú', 'Phương', 'Lộc', 'Vân'];
const FULL = ['Minh Anh', 'Quốc Bảo', 'Thu Hà', 'Đức Huy', 'Ngọc Lan', 'Hoàng Nam', 'Tuấn Kiệt', 'Gia Hân', 'Mai Chi', 'Khánh Vy'];
const TAGS = ['dev', 'it', 'hr', 'qa', 'pm', 'vn', 'hn', 'sg', 'xd'];
const digits = (rnd, n) => String(Math.floor(rnd() * 10 ** n)).padStart(n, '0');

function randomName(rnd = Math.random) {
  const r = rnd();
  const base = pick(rnd, SHORT);
  if (r < 0.28) return base; // Tuan
  if (r < 0.46) return pick(rnd, NICK); // Nick
  if (r < 0.60) return base.toLowerCase() + digits(rnd, rnd() < 0.5 ? 2 : 4); // tuan97 / tuan07
  if (r < 0.70) return base.toLowerCase() + '_' + pick(rnd, TAGS); // tuan_dev
  if (r < 0.78) return base + ' ' + pick(rnd, ['A', 'B', 'T', 'N', 'H', 'K', 'M']); // Tuan N
  if (r < 0.86) return pick(rnd, ACCENT);
  if (r < 0.93) return base.toLowerCase();
  return pick(rnd, FULL);
}
// kept for the tests: every name this file can make is short enough
const NAMES = [...SHORT, ...NICK, ...ACCENT, ...FULL];
const ROLES = ['nv', 'nv', 'kt', 'hr', 'it', 'dev', 'dev', 'sale', 'mkt', 'dsg', 'ts', 'tv'];
const COMPANIES = ['', '', '', '', 'FPT', 'Viettel', 'VNG', 'Tiki'];

const between = (rnd, [lo, hi]) => lo + rnd() * (hi - lo);
const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];

// Where a mole stands to smash an object: a free spot just off one of its sides (south first, the side players see).
// Desks in an island back onto each other, so the spot below a north-row desk is inside the next desk; try every side.
function standPoint(o) {
  const t = TYPES[o.type];
  const sideways = o.rot && Math.abs(Math.sin(o.rot)) > 0.5;
  const hw = (sideways ? t.h : t.w) / 2, hh = (sideways ? t.w : t.h) / 2, gap = MOLE.radius + 8;
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const x = o.x + dx * (hw + gap), y = o.y + dy * (hh + gap);
    if (x < 20 || y < 20 || x > WORLD.w - 20 || y > WORLD.h - 20 || inBossZone(x, y)) continue;
    const p = resolveCollisions(x, y, MOLE.radius);
    if (Math.hypot(p.x - x, p.y - y) < 0.5) return { x, y };
  }
  return null;
}
// Things a mole may go and smash: not in the boss's room, not the small stuff that sits on desks, and with room to stand.
const SMASHABLE = OBJECTS
  .filter((o) => !inBossZone(o.x, o.y) && o.type !== 'monitor' && o.type !== 'laptop' && o.type !== 'chair')
  .map((o) => ({ ...o, stand: standPoint(o) }))
  .filter((o) => o.stand);

function randomIdentity(rnd = Math.random) {
  return { name: randomName(rnd), gender: rnd() < 0.5 ? 'm' : 'f', role: pick(rnd, ROLES), company: pick(rnd, COMPANIES) };
}

// state of one mole. `x, y` is where the store put it (the spawn point).
function makeMole({ id, connId, name, x, y }, now, opts = {}, rnd = Math.random) {
  const m = { ...MOLE, ...opts };
  return {
    id, connId, name, x, y, d: 0, moved: true, born: now,
    phase: 'mingle', revealed: false,
    huntAt: now + between(rnd, m.mingleMs), rageUntil: 0,
    goal: null, goalUntil: 0, smashes: 0, smashAt: 0, victim: 0, attackAt: 0,
  };
}

const nearest = (list, x, y) => list.reduce((best, p) => (!best || Math.hypot(p.x - x, p.y - y) < Math.hypot(best.x - x, best.y - y) ? p : best), null);

// ctx: { now, humans: [{ id, x, y, dead, boss }] }  (boss = recently hit the boss). Returns events:
//   { type: 'smash', obj }  { type: 'stab', target, dmg }  { type: 'hit', target, dmg }  { type: 'leave' }
function stepMole(mole, dt, ctx, opts = {}, rnd = Math.random) {
  const m = { ...MOLE, ...opts };
  const { now } = ctx;
  const events = [];
  const live = ctx.humans.filter((h) => !h.dead);
  const before = mole.x + ':' + mole.y;
  const go = (x, y, key) => stepToward(mole, x, y, dt, m.speed, m.radius, now, 'm' + mole.id + key);

  if (now - mole.born > m.lifeMs) return [{ type: 'leave' }];
  if (ctx.patrol && !mole.revealed) {
    const boss = nearest(ctx.bosses || [], mole.x, mole.y);
    if (boss && Math.hypot(mole.x - boss.x, mole.y - boss.y) < 650) {
      const d = Math.hypot(mole.x - boss.x, mole.y - boss.y) || 1;
      go(mole.x + (mole.x - boss.x) / d * 300, mole.y + (mole.y - boss.y) / d * 300, 'flee');
    }
    mole.huntAt = Math.max(mole.huntAt, now + 1000);
    if (mole.x + ':' + mole.y !== before) mole.moved = true;
    return events;
  }


  if (mole.phase === 'mingle') {
    if (now >= mole.huntAt && live.length) {
      mole.phase = 'hunt';
      const keen = live.filter((h) => h.boss);
      mole.victim = (keen.length ? pick(rnd, keen) : pick(rnd, live)).id; // whoever is hurting the boss first
    } else {
      if (!mole.goal || mole.smashes <= 0 || now >= mole.goalUntil) {
        // choose the closest of a few random things, so it ambles instead of crossing the map
        const options = Array.from({ length: 6 }, () => pick(rnd, SMASHABLE));
        mole.goal = nearest(options, mole.x, mole.y);
        mole.smashes = 1 + Math.floor(rnd() * 3);
        mole.goalUntil = now + m.goalGiveUpMs;
      }
      const left = go(mole.goal.stand.x, mole.goal.stand.y, 'o' + mole.goal.id);
      if (left < m.smashRange && now >= mole.smashAt) {
        mole.smashAt = now + between(rnd, m.smashCooldownMs);
        mole.smashes--;
        mole.goalUntil = now + m.goalGiveUpMs; // still at it: no need to give up
        events.push({ type: 'smash', obj: mole.goal.id });
        mole.d = Math.atan2(mole.goal.x - mole.x, mole.goal.y - mole.y);
      }
    }
  }

  if (mole.phase === 'hunt') {
    let victim = live.find((h) => h.id === mole.victim) || null;
    if (!victim) victim = nearest(live, mole.x, mole.y);
    if (!victim) mole.phase = 'mingle'; // everyone left or is down: blend in again
    else {
      mole.victim = victim.id;
      const left = go(victim.x, victim.y, 'v');
      if (left <= m.stabRange) {
        events.push({ type: 'stab', target: victim.id, dmg: m.stabDmg });
        mole.d = Math.atan2(victim.x - mole.x, victim.y - mole.y);
        mole.phase = 'rage';
        mole.revealed = true;
        mole.rageUntil = now + m.rageMs;
        mole.attackAt = now + m.rageCooldownMs;
      }
    }
  } else if (mole.phase === 'rage') {
    if (now >= mole.rageUntil || !live.length) return [{ type: 'leave' }];
    const target = nearest(live, mole.x, mole.y);
    const left = go(target.x, target.y, 'v');
    if (left <= m.rageRange && now >= mole.attackAt) {
      mole.attackAt = now + m.rageCooldownMs;
      mole.d = Math.atan2(target.x - mole.x, target.y - mole.y);
      events.push({ type: 'hit', target: target.id, dmg: m.rageDmg });
    }
  }

  if (mole.x + ':' + mole.y !== before) mole.moved = true;
  return events;
}

// How many moles a room may hold: never more than half the real players, and always one slot left for a real one.
function moleCap(humans, max) {
  return Math.max(0, Math.min(Math.floor(humans / 2), max - 1 - humans));
}

module.exports = { MOLE, NAMES, randomName, SMASHABLE, randomIdentity, makeMole, stepMole, moleCap };
