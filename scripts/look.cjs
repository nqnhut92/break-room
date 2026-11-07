'use strict';

// Open the real game in a headless browser, join, take screenshots spaced over time and print
// what the renderer did. WebKit (the Safari engine) by default, so Safari-only rendering bugs show
// up without an iPad. Frame rates here come from the Mac, not the device: compare draw counts.
//
//   npx playwright install webkit      (once)
//   node scripts/look.cjs [--device ipad|iphone|desktop] [--browser webkit|chromium]
//                         [--quality high|low] [--shots 3] [--every 2000] [--out look-out] [--smash 1]
//
// --smash 1 walks north from the lobby into the desks and keeps smashing, sweeping left and right.
const fs = require('fs');
const path = require('path');
const playwright = require('playwright');
const { createApp } = require('../server');

const DEVICES = {
  ipad: { viewport: { width: 1210, height: 834 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  iphone: { viewport: { width: 956, height: 440 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 },
};

function options(argv) {
  const o = { device: 'ipad', browser: 'webkit', quality: 'high', shots: 3, every: 2000, out: 'look-out', smash: 0 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in o) || argv[i + 1] === undefined) throw new Error('unknown or empty option ' + argv[i]);
    o[key] = typeof o[key] === 'number' ? Number(argv[i + 1]) : argv[i + 1];
  }
  if (!DEVICES[o.device]) throw new Error('device must be one of ' + Object.keys(DEVICES).join(', '));
  if (!['webkit', 'chromium'].includes(o.browser)) throw new Error('browser must be webkit or chromium');
  return o;
}

// Runs in the page. Alternates frames so one counts the whole frame (shadow pass included) and the
// next only the main pass: three.js resets renderer.info after the shadow pass.
function probe() {
  const r = window.__look.renderer, render = r.render.bind(r), seen = { all: 0, main: 0, tris: 0, frames: 0 };
  let whole = false;
  r.render = (...a) => {
    whole = !whole; r.info.autoReset = !whole; if (whole) r.info.reset();
    render(...a);
    if (whole) seen.all = r.info.render.calls; else { seen.main = r.info.render.calls; seen.tris = r.info.render.triangles; }
    seen.frames++;
  };
  window.__lookStats = () => {
    const t0 = seen.frames, s0 = performance.now();
    return new Promise((done) => setTimeout(() => done({
      fps: Math.round((seen.frames - t0) * 1000 / (performance.now() - s0)),
      draws: seen.main, shadowDraws: Math.max(0, seen.all - seen.main), triangles: seen.tris,
      quality: window.__look.getQuality(),
    }), 1000));
  };
}

async function main() {
  const o = options(process.argv.slice(2));
  fs.mkdirSync(o.out, { recursive: true });
  const app = createApp({ bossEnabled: false, moleEnabled: false, log: () => {} });
  const port = await app.start(0);
  const launch = o.browser === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {};
  const browser = await playwright[o.browser].launch({ headless: true, ...launch });
  let failed = false;
  try {
    const page = await browser.newPage(DEVICES[o.device]);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
    await page.addInitScript((q) => localStorage.setItem('br-gfx2', q), o.quality);
    // Expose the scene to this script only; nothing in the shipped game changes.
    await page.route('**/game.js*', async (route) => {
      const body = (await (await route.fetch()).text());
      const hook = "scene = createScene3D(canvas, $('labels'));";
      if (!body.includes(hook)) throw new Error('game.js no longer creates the scene with: ' + hook);
      route.fulfill({ contentType: 'application/javascript', body: body.replace(hook, hook + ' window.__look = scene;') });
    });
    await page.goto(`http://localhost:${port}/?room=br-1`);
    await page.fill('#nameInput', 'Look');
    await page.click('#joinBtn');
    await page.waitForFunction(() => document.getElementById('overlay').classList.contains('gone') && window.__look, null, { timeout: 60000 });
    await page.evaluate(probe);
    if (o.smash) {
      await page.keyboard.down('w'); await page.waitForTimeout(1700); await page.keyboard.up('w');
      await page.keyboard.down(' ');
      let left = true;
      const sweep = setInterval(() => { page.keyboard.up(left ? 'd' : 'a').then(() => page.keyboard.down(left ? 'a' : 'd')).catch(() => {}); left = !left; }, 1800);
      page.once('close', () => clearInterval(sweep));
      browser.once('disconnected', () => clearInterval(sweep));
      await page.keyboard.down('d');
      await page.waitForTimeout(2300);
    }
    for (let i = 1; i <= o.shots; i++) {
      await page.waitForTimeout(i === 1 ? 1500 : o.every);
      const stats = await page.evaluate(() => window.__lookStats());
      const file = path.join(o.out, `${o.browser}-${o.device}-${o.quality}-${i}.png`);
      await page.screenshot({ path: file });
      console.log(file, JSON.stringify(stats));
    }
    console.log(errors.length ? 'page errors/warnings:\n  ' + errors.join('\n  ') : 'no page errors');
  } catch (e) {
    failed = true;
    console.error(e);
  } finally {
    await browser.close();
    await app.stop();
  }
  process.exitCode = failed ? 1 : 0;
}

main();
