'use strict';

// Operator job endpoint (see docs/DEPLOYMENT.md). Nothing schedules it for you: point a scheduler,
// for example a Vercel cron or any HTTP monitor, at it with the bearer secret.

const { createPersistence } = require('../lib/persistence');
const { createProfiles } = require('../lib/profiles');
const { createStoreFromEnv } = require('../lib/config');
const { maintenanceHandler } = require('../lib/maintenance-http');

let handler;
module.exports = async (req, res) => {
  if (!handler) {
    const env = process.env;
    const store = createStoreFromEnv(env);
    const profiles = env.DATABASE_URL ? createProfiles(env.DATABASE_URL, { migrationUrl: env.MIGRATION_DATABASE_URL || env.DATABASE_URL }) : null;
    handler = maintenanceHandler({ persistence: store ? createPersistence({ profiles, store, env }) : null, env });
  }
  return handler(req, res);
};
