'use strict';
const { Pool } = require('pg');
const { migrate } = require('./migrations');
const { randomUUID } = require('crypto');
const { ROLE_IDS, ROOMS } = require('./world');
const normalize = (v, max) => String(v || '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const nameKey = (v) => normalize(v, 14).toLowerCase();
function profile(input) {
  const name = normalize(input.name, 14);
  if (!name || name.startsWith('~') || !['m', 'f'].includes(input.gender) || !ROLE_IDS.includes(input.role)) throw Object.assign(Error('Tên, giới tính hoặc nghề không hợp lệ.'), { status: 400 });
  const allowed = ['name', 'gender', 'role', 'company'];
  if (Object.keys(input).some(k => !allowed.includes(k))) throw Object.assign(Error('Trường hồ sơ không hợp lệ.'), { status: 400 });
  return { name, name_key: nameKey(name), gender: input.gender, role: input.role, company: normalize(input.company, 20) };
}
function createProfiles(url, { migrationUrl = url } = {}) {
  const pool = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000, statement_timeout: 5000, query_timeout: 6000 });
  pool.on('error', () => {}); // Never log a connection string or provider error detail.
  let initialization;
  function ready() {
    // Cache only a successful initialization. Failed attempts can retry on the
    // next profile request; guest fallback and active gameplay remain available.
    if (!initialization) initialization = migrate(migrationUrl).catch(error => { initialization = null; throw error; });
    return initialization;
  }
  async function transaction(room, fn) {
    await ready();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout = '3s'");
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['br:profile:' + room]);
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  }
  return {
    pool, transaction, ready,
    async account(subject) {
      // One transaction and unique provider/subject protect callback retries.
      return transaction('google:' + subject, async c => {
        const existing = await c.query("SELECT account_id FROM auth_identities WHERE provider='google' AND subject=$1", [subject]);
        if (existing.rows[0]) return existing.rows[0].account_id;
        const id = randomUUID();
        await c.query('INSERT INTO accounts(id) VALUES($1)', [id]);
        await c.query("INSERT INTO auth_identities(provider,subject,account_id) VALUES('google',$1,$2)", [subject, id]);
        return id;
      });
    },
    async get(c, account, room) { return (await c.query('SELECT * FROM characters WHERE account_id=$1 AND room_id=$2', [account, room])).rows[0] || null; },
    async reserved(c, room, key) { return (await c.query('SELECT id FROM characters WHERE room_id=$1 AND name_key=$2', [room, key])).rows[0]; },
    async save(c, account, room, input, exists) {
      if (!ROOMS.some(r => r.id === room)) throw Object.assign(Error('Phòng không hợp lệ.'), { status: 400 });
      const p = profile(input);
      const values = [p.name, p.name_key, p.gender, p.role, p.company, account, room];
      if (exists) return (await c.query('UPDATE characters SET name=$1,name_key=$2,gender=$3,role=$4,company=$5,updated_at=now() WHERE account_id=$6 AND room_id=$7 RETURNING *', values)).rows[0];
      return (await c.query('INSERT INTO characters(name,name_key,gender,role,company,account_id,room_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', values)).rows[0];
    },
    close: () => pool.end(),
  };
}
module.exports = { createProfiles, normalize, nameKey, profile };
