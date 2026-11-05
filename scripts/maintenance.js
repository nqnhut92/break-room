'use strict';
// Manual operator command: drain the score queue into Postgres and run cleanup, or show status.
//   node scripts/maintenance.js            run the job once (exit 1 if it reported errors)
//   node scripts/maintenance.js --status   backlog, dropped events, last result, table sizes
// Uses the same environment as the app: REDIS_URL (or KV_URL) and DATABASE_URL.

const { createPersistence } = require('../lib/persistence');
const { createProfiles } = require('../lib/profiles');
const { createStoreFromEnv } = require('../lib/config');

(async () => {
  const env = process.env;
  const store = createStoreFromEnv(env);
  if (!store || store.kind !== 'redis') { console.error('REDIS_URL is required: the queue lives in the shared store.'); process.exit(2); }
  const profiles = env.DATABASE_URL ? createProfiles(env.DATABASE_URL, { migrationUrl: env.MIGRATION_DATABASE_URL || env.DATABASE_URL }) : null;
  const persistence = createPersistence({ profiles, store, env });
  let code = 0;
  try {
    const out = process.argv.includes('--status') ? await persistence.status() : await persistence.maintain({ force: true });
    console.log(JSON.stringify(out, null, 2));
    if (out.errors?.length) code = 1;
  } catch (e) { console.error(e.message); code = 1; }
  await store.close();
  await profiles?.close();
  process.exit(code);
})();
