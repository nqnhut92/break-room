'use strict';
// Shared handler for explicit Vercel Node routes; each instance reuses its pools.
const { createIdentity } = require('./identity');
const { createStoreFromEnv } = require('./config');
const identity = createIdentity({ store: createStoreFromEnv() });
module.exports = async (req, res) => {
  if (!await identity.http(req, res)) res.writeHead(404).end();
};
