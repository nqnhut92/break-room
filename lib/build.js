'use strict';

// Which build this process runs. scripts/stamp-assets.js (the Vercel build command) writes lib/build-info.json with the
// same version it stamps into the module URLs, so the server and the page of a given deploy agree. Locally the file is
// absent and the version is "dev": nobody is told to update.

const fs = require('fs');
const path = require('path');

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8'));
    if (j && typeof j.version === 'string' && j.version) return { version: j.version, builtAt: Number(j.builtAt) || 0 };
  } catch (e) { /* no build info: a local run */ }
  return { version: 'dev', builtAt: 0 };
}

module.exports = load();
