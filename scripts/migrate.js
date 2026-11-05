'use strict';
// Optional manual entry point; runtime uses the same versioned migration engine.
const { migrate } = require('../lib/migrations');
if (require.main === module) migrate(process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL).catch(() => {
  console.error('Migration failed. Check database connectivity, privileges and migration SQL.');
  process.exitCode = 1;
});
module.exports = { migrate };
