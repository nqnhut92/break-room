'use strict';
// In-process twin of lib/daily-lua.js, used by the memory store. Same contract and the same
// invariants (see that file); test/shared.js runs one set of checks against both implementations.

const { dayOf } = require('./daily');

function createDailyMemory({ persist = false, maxQueue = 20000 } = {}) {
  const rooms = new Map();
  const run = require('crypto').randomBytes(6).toString('hex');
  const room = (name) => {
    let r = rooms.get(name);
    if (!r) rooms.set(name, r = { days: new Map(), queue: [], qs: { run: '', seq: 0, dropped: 0, synced: 0, enqAt: 0, syncAt: 0, errAt: 0, err: '' }, lock: null });
    return r;
  };
  const day = (r, d) => {
    let x = r.days.get(d);
    if (!x) r.days.set(d, x = { ds: new Map(), b: new Map(), dt: new Map(), n: new Map(), x: new Map(), total: 0, hyd: 0 });
    return x;
  };
  function enqueue(r, d, ev, now) {
    if (r.queue.length >= maxQueue) { r.qs.dropped++; r.qs.droppedAt = now; return false; }
    if (!r.qs.run) r.qs.run = run;
    r.qs.seq++;
    r.queue.push({ ...ev, i: r.qs.run + ':' + r.qs.seq, y: d });
    r.qs.enqAt = now;
    return true;
  }
  const hydrated = (x) => { if (!persist && !x.hyd) x.hyd = 1; return x.hyd; };
  const sorted = (x) => [...x.ds].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1)); // ties: actor id descending, like ZREVRANGE

  const api = {
    persist,
    // Credit a player's actor (the caller resolved id -> actor and name).
    credit(name, now, actor0, playerName, tenths, breaks, deaths = 0) {
      if (!actor0) return;
      const r = room(name), d = dayOf(now), x = day(r, d);
      // what a guest earns after a transfer stays with the guest (x only blocks a second transfer)
      const actor = actor0, label = playerName || '', pointsName = label;
      const scores = tenths !== 0 || breaks !== 0 || deaths === 0;
      if (hydrated(x)) {
        if (scores) {
          x.ds.set(actor, (x.ds.get(actor) || 0) + tenths);
          x.total += tenths;
          if (breaks) x.b.set(actor, (x.b.get(actor) || 0) + breaks);
          if (pointsName) x.n.set(actor, pointsName);
        }
        if (deaths) {
          x.dt.set(actor0, (x.dt.get(actor0) || 0) + deaths);
          if (!x.ds.has(actor0)) x.ds.set(actor0, 0);
          if (label) x.n.set(actor0, label);
        }
      }
      if (persist) {
        if (scores) enqueue(r, d, { k: 's', a: actor, d: tenths, b: breaks, dt: 0, n: pointsName, t: now }, now);
        if (deaths) enqueue(r, d, { k: 's', a: actor0, d: 0, b: 0, dt: deaths, n: label, t: now }, now);
      }
    },
    dayState(name, d) { return room(name).days.get(d)?.hyd || 0; },
    touch(name, now, actor, label = '') {
      const r = room(name), d = dayOf(now), x = day(r, d);
      if (!hydrated(x)) return 'unhydrated';
      const added = !x.ds.has(actor);
      if (added) x.ds.set(actor, 0);
      const old = x.n.get(actor);
      if (label) x.n.set(actor, label);
      if (persist && (added || (label && old !== label))) enqueue(r, d, { k: 'j', a: actor, n: label, t: now }, now);
      return 'ok';
    },
    transfer(name, now, from, to, toName = '') {
      const r = room(name), d = dayOf(now), x = day(r, d);
      if (!hydrated(x)) return { state: 'unhydrated' };
      if (x.x.has(from)) return { state: 'exists' };
      if (!x.ds.has(from)) return { state: 'noop' };
      const tenths = x.ds.get(from), breaks = x.b.get(from) || 0;
      if (tenths === 0 && breaks === 0) return { state: 'noop' }; // nothing earned: the guest keeps its row and its knock-outs
      x.ds.set(to, (x.ds.get(to) || 0) + tenths);
      if (breaks) x.b.set(to, (x.b.get(to) || 0) + breaks);
      if (toName) x.n.set(to, toName);
      x.ds.set(from, 0); x.b.delete(from);
      x.x.set(from, to);
      if (persist) enqueue(r, d, { k: 'x', f: from, a: to, n: toName, t: now }, now);
      return { state: 'moved', tenths, breaks };
    },
    board(name, d, { limit = 50, aids = [] } = {}) {
      const x = room(name).days.get(d);
      if (!x || !x.hyd) return { hyd: 0 };
      const all = sorted(x);
      const rows = all.slice(0, limit).map(([aid, tenths]) => ({ aid, tenths, breaks: x.b.get(aid) || 0, name: x.n.get(aid) || '', deaths: x.dt.get(aid) || 0 }));
      const selfs = [];
      for (const aid of aids) {
        if (!x.ds.has(aid)) continue;
        const tenths = x.ds.get(aid);
        selfs.push({ aid, rank: 1 + all.filter(([, s]) => s > tenths).length, tenths, breaks: x.b.get(aid) || 0, name: x.n.get(aid) || '', deaths: x.dt.get(aid) || 0 });
      }
      return { hyd: x.hyd, count: x.ds.size, total: x.total, rows, selfs };
    },
    deaths(name, d, { limit = 50, aid = '' } = {}) {
      const x = room(name).days.get(d);
      if (!x || !x.hyd) return { hyd: 0 };
      const list = [...x.dt].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
      const mine = x.dt.get(aid) || 0;
      return { hyd: x.hyd, count: list.length, rows: list.slice(0, limit).map(([a, n]) => ({ aid: a, n, name: x.n.get(a) || '' })), mine: { rank: mine > 0 ? 1 + list.filter(([, n]) => n > mine).length : 0, n: mine } };
    },
    hydrate(name, { day: d, mode, rows, transfers, committed }) {
      const r = room(name), x = day(r, d);
      if (x.hyd === 1) return 0;
      x.ds.clear(); x.b.clear(); x.dt.clear(); x.n.clear(); x.x.clear(); x.total = 0;
      for (const row of rows) {
        x.ds.set(row.a, row.s);
        if (row.b) x.b.set(row.a, row.b);
        if (row.dt) x.dt.set(row.a, row.dt);
        if (row.n) x.n.set(row.a, row.n);
        x.total += row.s;
      }
      for (const t of transfers) x.x.set(t.f, t.t);
      const done = new Set(committed);
      for (const e of r.queue) {
        if (e.y !== d || done.has(e.i)) continue;
        if (e.k === 'x') {
          if (x.ds.has(e.f)) {
            x.ds.set(e.a, (x.ds.get(e.a) || 0) + x.ds.get(e.f));
            if (x.b.get(e.f)) x.b.set(e.a, (x.b.get(e.a) || 0) + x.b.get(e.f));
            x.ds.set(e.f, 0); x.b.delete(e.f);
          }
          x.x.set(e.f, e.a);
          if (e.n) x.n.set(e.a, e.n);
        } else {
          if (!x.ds.has(e.a)) x.ds.set(e.a, 0);
          if (e.k === 's') {
            x.ds.set(e.a, x.ds.get(e.a) + e.d);
            x.total += e.d;
            if (e.b) x.b.set(e.a, (x.b.get(e.a) || 0) + e.b);
            if (e.dt) x.dt.set(e.a, (x.dt.get(e.a) || 0) + e.dt);
          }
          if (e.n) x.n.set(e.a, e.n);
        }
      }
      x.hyd = mode;
      return 1;
    },
    rename(name, { aid, name: label, days }) {
      const r = room(name);
      for (const d of days) { const x = r.days.get(d); if (x?.n.has(aid)) x.n.set(aid, label); }
    },
    // Memory has no TTLs for days; the operator job drops old ones.
    pruneDays(before) {
      for (const r of rooms.values()) for (const d of r.days.keys()) if (d < before) r.days.delete(d);
    },

    queueLock(name, holder, ttlMs, now = Date.now()) {
      const r = room(name);
      if (r.lock && r.lock.until > now && r.lock.holder !== holder) return false;
      r.lock = { holder, until: now + ttlMs };
      return true;
    },
    queueUnlock(name, holder) { const r = room(name); if (r.lock?.holder === holder) r.lock = null; },
    queueRead(name, count) { const q = room(name).queue; return (count > 0 ? q.slice(0, count) : q.slice()).map((e) => ({ ...e })); },
    queueAck(name, events, now) {
      if (!events.length) return true;
      const r = room(name);
      if (r.queue.length < events.length || r.queue[0].i !== events[0].i || r.queue[events.length - 1].i !== events[events.length - 1].i) return false;
      r.queue.splice(0, events.length);
      r.qs.synced += events.length;
      r.qs.syncAt = now;
      r.qs.err = ''; r.qs.errAt = 0;
      return true;
    },
    queueFail(name, message, now) { const r = room(name); r.qs.err = String(message).slice(0, 200); r.qs.errAt = now; },
    queueStat(name) { const r = room(name); return { len: r.queue.length, ...r.qs }; },
  };
  return api;
}

module.exports = { createDailyMemory };
