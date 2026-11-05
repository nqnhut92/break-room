'use strict';
// Shared handler for explicit Vercel Node routes (profile and Auth.js). Postgres pools are reused across requests (they close their
// idle sockets by themselves), but Redis connections are opened per request and closed after it: a frozen or recycled instance
// that keeps them open leaks connections, and the Redis plan allows few (a full plan made session checks, hence profile loading, fail).
const { createIdentity } = require('./identity');
const { createProfiles } = require('./profiles');
const { createStoreFromEnv } = require('./config');

let profiles;
function sharedProfiles(env) {
  if (profiles === undefined) profiles = env.DATABASE_URL ? createProfiles(env.DATABASE_URL, { migrationUrl: env.MIGRATION_DATABASE_URL || env.DATABASE_URL }) : null;
  return profiles;
}

module.exports = async (req, res) => {
  const store = createStoreFromEnv(process.env, { lazy: true });
  const identity = createIdentity({ store, profiles: sharedProfiles(process.env) });
  try {
    if (!await identity.http(req, res)) res.writeHead(404).end();
  } finally {
    await identity.release().catch(() => {});
    await store?.close().catch(() => {});
  }
};
