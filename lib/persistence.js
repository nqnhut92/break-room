'use strict';
// Wires Postgres-backed daily scores and chat to the game, and the operator maintenance job.
// Everything here is optional: without DATABASE_URL the game keeps working with live-only boards
// and ephemeral chat.

const { createScoreboard } = require('./scoreboard');
const { createChatStore } = require('./chat-store');
const { ROOMS } = require('./world');

function createPersistence({ profiles, store, env = process.env, clock = Date.now, log = console.error } = {}) {
  const pool = profiles?.pool || null;
  const scoreOn = !!pool && env.SCORE_PERSIST !== '0';
  const scoreboard = createScoreboard({ store, pool: scoreOn ? pool : null, ready: profiles?.ready, clock, log });
  const chat = pool && env.CHAT_HISTORY !== '0' ? createChatStore({ pool, ready: profiles.ready }) : null;

  async function setStatus(key, value) {
    if (!pool) return;
    await pool.query("INSERT INTO ops_status(key, value) VALUES($1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [key, JSON.stringify(value)]);
  }

  // Idempotent and safe to run concurrently: per-room queue lock + advisory locks + conditional deletes.
  // An idle run touches Redis only: Postgres is woken for events to apply, and for cleanup at most every CLEANUP_EVERY_S
  // (the schedule may fire every few minutes; a serverless database that is never idle would never suspend).
  const CLEANUP_EVERY_S = 6 * 3600;
  async function maintain({ rooms = ROOMS.map((r) => r.id), maxBatches = 50, force = false } = {}) {
    const out = { at: clock(), rooms: {}, cleanup: null, chatRemoved: 0, errors: [] };
    for (const room of rooms) {
      try { out.rooms[room] = await scoreboard.sync(room, { maxBatches }); if (out.rooms[room].error) out.errors.push(room + ': ' + out.rooms[room].error); }
      catch (e) { out.errors.push(room + ': ' + e.message); }
    }
    const worked = Object.values(out.rooms).some((r) => r.events > 0);
    const dueCleanup = pool && (force || await store.claim('cleanup', CLEANUP_EVERY_S).catch(() => true));
    if (dueCleanup) {
      try { out.cleanup = scoreOn ? await scoreboard.cleanup() : null; } catch (e) { out.errors.push('cleanup scores: ' + e.message); }
      try { out.chatRemoved = chat ? await chat.cleanup() : 0; } catch (e) { out.errors.push('cleanup chat: ' + e.message); }
    }
    out.cleanupRan = !!dueCleanup;
    if (pool && (dueCleanup || worked || out.errors.length)) await setStatus('maintenance', { ...out, ok: !out.errors.length }).catch(() => {});
    return out;
  }

  // Backlog, drops and last results for health checks and the CLI.
  async function status({ rooms = ROOMS.map((r) => r.id) } = {}) {
    const queue = {};
    for (const room of rooms) queue[room] = await store.queueStat(room);
    let maintenance = null, size = null;
    if (pool) {
      try {
        if (profiles.ready) await profiles.ready();
        maintenance = (await pool.query("SELECT value, updated_at FROM ops_status WHERE key='maintenance'")).rows[0] || null;
        size = (await pool.query("SELECT (SELECT count(*) FROM daily_scores)::int AS daily_scores, (SELECT count(*) FROM score_events)::int AS score_events, (SELECT count(*) FROM chat_messages)::int AS chat_messages, pg_database_size(current_database())::bigint AS database_bytes")).rows[0];
      } catch (e) { maintenance = { error: e.message }; }
    }
    return { persistScores: scoreOn, chatHistory: !!chat, queue, maintenance, size };
  }

  // Character renamed (while offline): the day board and the last 24 h of chat show the new name.
  async function rename(room, aid, name) {
    await scoreboard.rename(room, aid, name);
    if (chat && aid.startsWith('c:')) await chat.rename(aid.slice(2), name).catch((e) => log('[chat] rename:', e.message));
  }

  return { scoreboard, chat, maintain, status, scoreOn, rename };
}

module.exports = { createPersistence };
