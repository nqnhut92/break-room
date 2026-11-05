'use strict';

// Cache-busting for the static game files. Browsers (Safari in particular) can keep an old copy of one ES
// module while loading new copies of the others, and the game then runs half old and half new. This stamps a
// version into the URLs of our own modules and stylesheet so every deploy uses fresh ones:
//   index.html   game.js, viewport.js, scene3d.js (modulepreload), style.css
//   game.js      ./scene3d.js, ./roles.js
//   scene3d.js   ./roles.js
// Vercel runs it as the build command (see vercel.json); locally nothing needs it. Running it again replaces the
// previous stamp. Usage: node scripts/stamp-assets.js [directory] [version]

const fs = require('fs');
const path = require('path');

const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'public'));
const version = String(process.argv[3] || process.env.VERCEL_GIT_COMMIT_SHA || Date.now()).slice(0, 12);

function edit(file, fn) {
  const p = path.join(dir, file);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (after !== before) fs.writeFileSync(p, after);
}

edit('index.html', (s) =>
  s
    .replace(/(href|src)="(game\.js|scene3d\.js|viewport\.js|style\.css)(?:\?v=[^"]*)?"/g, '$1="$2?v=' + version + '"'));
edit('game.js', s => s.replace(/import '\.\/actor-collision\.js(?:\?v=[^']*)?'/g, "import './actor-collision.js?v=" + version + "'"));
for (const file of ['game.js', 'scene3d.js']) {
  edit(file, (s) => s.replace(/from '\.\/(scene3d|roles|account|vendor\/lucide-icons)\.js(?:\?v=[^']*)?'/g, "from './$1.js?v=" + version + "'"));
}
// The server learns its own build from the same version (only for the real build, not when a test stamps a temp folder),
// so it can tell the players of an older deploy to reload.
if (!process.argv[2]) {
  const info = JSON.stringify({ version, builtAt: Date.now() }) + '\n';
  fs.writeFileSync(path.join(__dirname, '..', 'lib', 'build-info.json'), info);
  // also a static file next to the page: open pages poll it, so they notice a deploy without any server involved
  fs.writeFileSync(path.join(dir, 'version.json'), info);
}
console.log('stamped ' + dir + ' with ' + version);
