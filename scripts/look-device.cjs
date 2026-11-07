'use strict';

// Drive Safari on a real iPad or iPhone from this Mac: join the game, take screenshots spaced over
// time and print frame rate and draw counts measured on the device. Nothing in the game changes;
// draws are counted by wrapping WebGL calls from the test session.
//
// One-time device setup (docs/DEVELOPMENT.md, "Testing on Safari"): Settings → Apps → Safari →
// Advanced → Web Inspector and Remote Automation on; connect by cable and trust this Mac. The
// device must reach this Mac on the local network.
//
//   node scripts/look-device.cjs [--device ipad|iphone] [--quality high|low] [--shots 3]
//                                [--every 2000] [--out look-out] [--host <this Mac's address>] [--smash 1]
//
// --host picks which of this Mac's addresses the device opens, when the Mac has several networks.
// --smash 1 walks north from the lobby into the desks and keeps smashing, sweeping left and right, while it measures.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createApp } = require('../server');

function options(argv) {
  const o = { device: 'ipad', quality: 'high', shots: 3, every: 2000, out: 'look-out', host: '', smash: 0 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in o) || argv[i + 1] === undefined) throw new Error('unknown or empty option ' + argv[i]);
    o[key] = typeof o[key] === 'number' ? Number(argv[i + 1]) : argv[i + 1];
  }
  if (!['ipad', 'iphone'].includes(o.device)) throw new Error('device must be ipad or iphone');
  return o;
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list) if (a.family === 'IPv4' && !a.internal) return a.address;
  throw new Error('no LAN address: the device has to reach this Mac over the network (or pass --host)');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs on the device. Counts draw calls per frame, split by whether a framebuffer other than the
// screen is bound (the shadow map), and frames per second over one second.
const PROBE = `
  const done = arguments[arguments.length - 1];
  if (!window.__lookGL) {
    const s = window.__lookGL = { main: 0, off: 0, frames: 0, last: { main: 0, off: 0 } };
    let fb = false;
    for (const C of [WebGLRenderingContext, window.WebGL2RenderingContext].filter(Boolean)) {
      const p = C.prototype, bind = p.bindFramebuffer;
      p.bindFramebuffer = function (t, f) { fb = !!f; return bind.call(this, t, f); };
      for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
        const draw = p[name]; if (!draw) continue;
        p[name] = function (...a) { if (fb) s.off++; else s.main++; const t0 = performance.now(); const r = draw.apply(this, a); s.gl += performance.now() - t0; return r; };
      }
    }
    // time spent in each frame's callbacks (the game's update and render; Safari's render also waits on the GPU)
    s.js = 0; s.jsFrames = 0; s.gl = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf((t) => { const t0 = performance.now(); cb(t); s.js += performance.now() - t0; });
    const tick = () => { s.last = { main: s.main, off: s.off }; s.main = 0; s.off = 0; s.frames++; s.jsFrames++; raf(tick); };
    raf(tick);
  }
  const s = window.__lookGL, f0 = s.frames, t0 = performance.now();
  s.js = 0; s.jsFrames = 0; s.gl = 0;
  setTimeout(() => done({ fps: Math.round((s.frames - f0) * 1000 / (performance.now() - t0)),
    jsMsPerFrame: +(s.js / Math.max(1, s.jsFrames)).toFixed(1), drawMsPerFrame: +(s.gl / Math.max(1, s.jsFrames)).toFixed(1),
    draws: s.last.main, shadowDraws: s.last.off, size: innerWidth + 'x' + innerHeight + '@' + devicePixelRatio,
    quality: localStorage.getItem('br-gfx2'), board: (document.getElementById('boardList') || {}).innerText }), 1000);`;

async function main() {
  const o = options(process.argv.slice(2));
  fs.mkdirSync(o.out, { recursive: true });
  const app = createApp({ bossEnabled: false, moleEnabled: false, log: () => {} });
  const port = await app.start(0);
  const driverPort = 4400 + Math.floor(Math.random() * 500);
  const driver = spawn('safaridriver', ['-p', String(driverPort)], { stdio: 'ignore' });
  const wd = async (method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${driverPort}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const json = await res.json();
    if (json.value && json.value.error) throw new Error(json.value.error + ': ' + json.value.message);
    return json.value;
  };
  let session, failed = false;
  try {
    await sleep(1500);
    const deviceType = o.device === 'ipad' ? 'iPad' : 'iPhone';
    session = (await wd('POST', '/session', { capabilities: { alwaysMatch: { platformName: 'iOS', browserName: 'Safari', 'safari:deviceType': deviceType } } })).sessionId;
    const s = `/session/${session}`;
    const run = (script, args = []) => wd('POST', s + '/execute/sync', { script, args });
    const url = `http://${o.host || lanAddress()}:${port}/?room=br-1`;
    console.log('device opens', url);
    await wd('POST', s + '/url', { url });
    await run('localStorage.setItem("br-gfx2", arguments[0])', [o.quality]);
    await wd('POST', s + '/refresh', {});
    await sleep(1500);
    await run(`const n = document.getElementById('nameInput'); n.value = 'Look'; n.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('joinBtn').click();`);
    for (let i = 0; !(await run("return document.getElementById('overlay').classList.contains('gone')")); i++) {
      if (i > 60) throw new Error('did not join within 30 s (is the Home Screen gate or a network error showing?)');
      await sleep(500);
    }
    if (o.smash) {
      // the same keys a keyboard player uses: walk up into the workspace, then hold Space and sweep sideways
      await run(`const key = (type, k) => dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true }));
        // repeat the key while walking, so one press dropped while the game is still settling does not leave us in the lobby
        const walk = setInterval(() => key('keydown', 'w'), 150);
        setTimeout(() => { clearInterval(walk); key('keyup', 'w'); key('keydown', ' '); let left = true;
          const sweep = () => { key('keyup', left ? 'd' : 'a'); key('keydown', left ? 'a' : 'd'); left = !left; };
          sweep(); setInterval(sweep, 1800); }, 1700);`);
      await sleep(4000);
    }
    for (let i = 1; i <= o.shots; i++) {
      await sleep(i === 1 ? 1500 : o.every);
      const stats = await wd('POST', s + '/execute/async', { script: PROBE, args: [] });
      const file = path.join(o.out, `device-${o.device}-${o.quality}-${i}.png`);
      fs.writeFileSync(file, Buffer.from(await wd('GET', s + '/screenshot'), 'base64'));
      console.log(file, JSON.stringify(stats));
    }
  } catch (e) {
    failed = true;
    console.error(String(e.message || e));
    if (/could not be used|No device/i.test(String(e.message)))
      console.error('Turn on Web Inspector and Remote Automation in Settings → Apps → Safari → Advanced, connect the cable and trust this Mac.');
  } finally {
    if (session) await wd('DELETE', `/session/${session}`).catch(() => {});
    driver.kill();
    await app.stop();
  }
  process.exitCode = failed ? 1 : 0;
}

main();
