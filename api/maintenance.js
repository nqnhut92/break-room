'use strict';

// Operator job endpoint (see docs/SCORES.md). Nothing schedules it for you: point an uptime monitor or a cron at it.
// Connections are opened per request, only after the key checked out, and closed before the response is forgotten:
// a serverless instance that keeps them open leaks one Redis connection per cold start.

const { createPersistence } = require('../lib/persistence');
const { createProfiles } = require('../lib/profiles');
const { createStoreFromEnv } = require('../lib/config');
const { maintenanceHandler } = require('../lib/maintenance-http');

const handler = maintenanceHandler({
  env: process.env,
  async open() {
    const env = process.env;
    const store = createStoreFromEnv(env);
    if (!store) return null;
    const profiles = env.DATABASE_URL ? createProfiles(env.DATABASE_URL, { migrationUrl: env.MIGRATION_DATABASE_URL || env.DATABASE_URL }) : null;
    return {
      persistence: createPersistence({ profiles, store, env }),
      close: async () => { await store.close(); await profiles?.close(); },
    };
  },
});

module.exports = (req, res) => handler(req, res);
