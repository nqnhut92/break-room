'use strict';
// Room chat history in Postgres. A message is "sent" only once this insert commits.
// Retention is 24 hours from the moment the server accepted the message; reads filter by age
// themselves, so a delayed cleanup job never shows an expired message.

const { randomUUID } = require('crypto');

const RETENTION_MS = 24 * 3600 * 1000;
const PAGE = 50;
const NOW_MS = '(extract(epoch from clock_timestamp()) * 1000)::bigint';

function createChatStore({ pool, ready = async () => {}, queryTimeoutMs = 3000 } = {}) {
  const q = async (text, values) => { await ready(); return pool.query({ text, values, query_timeout: queryTimeoutMs }); };
  const view = (r) => ({ mid: r.id, at: Number(r.at_ms), name: r.sender_name, text: r.body, actor: r.actor_id }); // actor is internal: the game strips it

  return {
    // Idempotent per (room, actor, client id): a retry returns the original row with fresh=false.
    async post(room, { actorId, characterId = null, name, text, cid }) {
      const r = await q(`WITH ins AS (
          INSERT INTO chat_messages(id, room_id, actor_id, client_id, character_id, sender_name, body, at_ms)
          VALUES($1, $2, $3, $4, $5, $6, $7, ${NOW_MS})
          ON CONFLICT (room_id, actor_id, client_id) DO NOTHING RETURNING id, at_ms, sender_name, body)
        SELECT id, at_ms, sender_name, body, true AS fresh FROM ins
        UNION ALL
        SELECT id, at_ms, sender_name, body, false FROM chat_messages
          WHERE room_id = $2 AND actor_id = $3 AND client_id = $4 AND NOT EXISTS (SELECT 1 FROM ins)`,
        [randomUUID(), room, actorId, cid, characterId, name, text]);
      return { ...view(r.rows[0]), fresh: r.rows[0].fresh };
    },

    // before = { at, mid }: the page of older messages; after: newer ones; neither: the latest page.
    // Always returns oldest-first. `more` says whether further messages exist in the direction asked.
    async history(room, { before = null, after = null, limit = PAGE } = {}) {
      limit = Math.min(Math.max(1, limit | 0 || PAGE), 100);
      const params = [room, limit + 1];
      let cond = '', order = 'DESC';
      if (before) { params.push(before.at, before.mid); cond = 'AND (at_ms, id) < ($3::bigint, $4::uuid)'; }
      else if (after) { params.push(after.at, after.mid); cond = 'AND (at_ms, id) > ($3::bigint, $4::uuid)'; order = 'ASC'; }
      const r = await q(`SELECT id, at_ms, sender_name, body, actor_id FROM chat_messages
        WHERE room_id = $1 AND at_ms > ${NOW_MS} - ${RETENTION_MS} ${cond}
        ORDER BY at_ms ${order}, id ${order} LIMIT $2`, params);
      const more = r.rows.length > limit;
      const rows = r.rows.slice(0, limit);
      if (order === 'DESC') rows.reverse();
      return { messages: rows.map(view), more };
    },

    // A character's new name replaces the old one on the lines it sent in the last 24 hours (the only ones that exist).
    async rename(characterId, name) {
      await ready();
      await pool.query(`UPDATE chat_messages SET sender_name = $2 WHERE character_id = $1 AND at_ms > ${NOW_MS} - ${RETENTION_MS}`, [characterId, name]);
    },

    async cleanup({ batch = 2000 } = {}) {
      await ready();
      let removed = 0;
      for (;;) {
        const r = await pool.query(`DELETE FROM chat_messages WHERE id IN (SELECT id FROM chat_messages WHERE at_ms <= ${NOW_MS} - ${RETENTION_MS} LIMIT $1)`, [batch]);
        removed += r.rowCount;
        if (r.rowCount < batch) return removed;
      }
    },
  };
}

module.exports = { createChatStore, RETENTION_MS, PAGE };
