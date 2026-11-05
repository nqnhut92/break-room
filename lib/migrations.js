'use strict';
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Each pending version and its ledger entry commit together. The transaction
// advisory lock also works through a transaction-pooled Neon connection.
async function migrate(url, { directory = path.join(__dirname, '../migrations') } = {}) {
  if (!url) throw Error('A database connection is required for migrations.');
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 1000, statement_timeout: 30000, query_timeout: 35000 });
  pool.on('error', () => {});
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('br:migrations',0))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of fs.readdirSync(directory).filter(f => /^\d+.*\.sql$/.test(f)).sort()) {
      if ((await client.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file])).rowCount) continue;
      await client.query(fs.readFileSync(path.join(directory, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [file]);
    }
    await client.query('COMMIT');
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client?.release();
    await pool.end();
  }
}
module.exports = { migrate };
