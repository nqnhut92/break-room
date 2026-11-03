'use strict';

// Cache-busting for the static game files. Browsers (Safari in particular) can keep an old copy of one ES
// module while loading new copies of the others, and the game then runs half old and half new. This stamps a
// version into the URLs of our own modules and stylesheet so every deploy uses fresh ones:
//   index.html   game.js, scene3d.js (modulepreload), style.css
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
    .replace(/(href|src)="(game\.js|scene3d\.js|style\.css)(?:\?v=[^"]*)?"/g, '$1="$2?v=' + version + '"'));
for (const file of ['game.js', 'scene3d.js']) {
  edit(file, (s) => s.replace(/from '\.\/(scene3d|roles)\.js(?:\?v=[^']*)?'/g, "from './$1.js?v=" + version + "'"));
}
console.log('stamped ' + dir + ' with ' + version);
