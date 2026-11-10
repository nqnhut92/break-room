'use strict';
const fs = require('fs');
const path = require('path');
const playwright = require('playwright');
const { createApp } = require('../server');
const W = require('../lib/world');

async function main() {
  const out = 'inspect-out';
  fs.mkdirSync(out, { recursive: true });
  const app = createApp({ bossEnabled: true, moleEnabled: false, log: () => {} });
  const port = await app.start(0);

  const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1024, height: 500 },
      deviceScaleFactor: 2
    });
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERR:', err.message));

    await page.route('**/catalog-view', route => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css">
  <style>
    body { margin: 0; background: #111; overflow: hidden; }
    canvas { display: block; width: 100vw; height: 100vh; }
    #labels { position: absolute; top: 0; left: 0; pointer-events: none; }
  </style>
  <script type="importmap">
    { "imports": { "three": "/vendor/three.module.min.js" } }
  </script>
</head>
<body>
  <canvas></canvas>
  <div id="labels"></div>
  <script type="module">
    import { createScene3D } from '/scene3d.js';
    const data = ${JSON.stringify({
      world: W.WORLD, props: W.PROPS, zones: W.ZONES, bossRoom: W.BOSS_ROOM, objects: W.OBJECTS, types: W.TYPES
    })};
    const canvas = document.querySelector('canvas');
    const labels = document.querySelector('#labels');
    const app = createScene3D(canvas, labels);
    window.app = app;
    app.setQuality('high');
    app.resize(window.innerWidth, window.innerHeight);
    await app.ready;
    app.build(data.world, data.props, data.zones);

    const S = {
      world: data.world,
      me: 1,
      players: new Map(),
      minis: new Map(),
      snakes: new Map(),
      types: data.types,
      shake: 0,
      objects: [],
      boss: null
    };
    window.S = S;

    window.setupScene = (playersList, bossObj) => {
      S.players.clear();
      for (const p of playersList) {
        S.players.set(p.id, p);
      }
      S.boss = bossObj || null;
      app.update(0.016, S);
    };

    window.renderFrame = (dt = 0.016) => {
      app.update(dt, S);
    };

    window.ready = true;
  </script>
</body>
</html>`
    }));

    await page.goto(`http://localhost:${port}/catalog-view`);
    await page.waitForFunction(() => window.ready, null, { timeout: 15000 });
    await page.waitForTimeout(300);

    const centerX = 1920, centerY = 1950;

    // --- 1. MALE STYLES (0: Side part 7/3, 1: Spiky, 2: Man bun, 3: Comma bangs) ---
    await page.evaluate(({ cx, cy }) => {
      const roles = ['dev', 'nv', 'pm', 'lead'];
      const hues = [35, 195, 140, 280];
      const names = ['7/3 Side Part', 'Textured Spiky', 'Man Bun', 'Comma Bangs'];
      const players = [];
      for (let i = 0; i < 4; i++) {
        players.push({
          id: i, // style = id % 4
          name: names[i],
          gender: 'm',
          role: roles[i],
          company: '',
          hue: hues[i],
          x: cx + (i - 1.5) * 48,
          y: cy,
          heading: 0, // face camera
          moving: false,
          swing: 0,
          hpFrac: 1,
          dead: false
        });
      }
      window.setupScene(players, null);
      for (let f = 0; f < 10; f++) window.renderFrame(0.016);
    }, { cx: centerX, cy: centerY });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, 'catalog-male-styles.png') });
    console.log('Captured catalog-male-styles.png');

    // --- 1b. RUNNING STRIDE (Profile running view: side view heading = -PI/2, moving = true) ---
    await page.evaluate(({ cx, cy }) => {
      const runner = {
        id: 1,
        name: 'Runner',
        gender: 'm',
        role: 'dev',
        company: '',
        hue: 35,
        x: cx,
        y: cy,
        heading: -Math.PI / 2, // run left in profile
        moving: true,
        swing: 0,
        hpFrac: 1,
        dead: false
      };
      window.setupScene([runner], null);
      // Advance to mid-stride where back foot is pushing off and flexing
      for (let f = 0; f < 28; f++) window.renderFrame(0.016);
    }, { cx: centerX, cy: centerY });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, 'catalog-running-legs.png') });
    console.log('Captured catalog-running-legs.png');

    // --- 2. FEMALE STYLES (0: High ponytail, 1: Twin tails, 2: Wuxia bun, 3: Bob) ---
    await page.evaluate(({ cx, cy }) => {
      const roles = ['designer', 'hr', 'lead', 'intern'];
      const hues = [340, 45, 160, 210];
      const names = ['High Ponytail', 'Twin Tails', 'Wuxia Bun', 'Layered Bob'];
      const players = [];
      for (let i = 0; i < 4; i++) {
        players.push({
          id: 10 + i, // female style = id % 4: 10 % 4 = 2, 11 = 3, 12 = 0, 13 = 1
          name: names[i],
          gender: 'f',
          role: roles[i],
          company: '',
          hue: hues[i],
          x: cx + (i - 1.5) * 48,
          y: cy,
          heading: 0,
          moving: false,
          swing: 0,
          hpFrac: 1,
          dead: false
        });
      }
      // re-index id to match style:
      // style = Math.abs(p.id) % 4
      players[0].id = 4; // 0: ponytail
      players[1].id = 5; // 1: twin tails
      players[2].id = 6; // 2: wuxia bun
      players[3].id = 7; // 3: bob
      window.setupScene(players, null);
      for (let f = 0; f < 10; f++) window.renderFrame(0.016);
    }, { cx: centerX, cy: centerY });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, 'catalog-female-styles.png') });
    console.log('Captured catalog-female-styles.png');

    // --- 3. BOSS VKL & MINI-BOSSES (Standing: cane in hand, limp leg with brace, proportional heights) ---
    await page.evaluate(({ cx, cy }) => {
      const me = {
        id: 1,
        name: 'Player',
        gender: 'm',
        role: 'dev',
        company: '',
        hue: 35,
        x: cx - 110,
        y: cy,
        heading: 0,
        moving: false,
        swing: 0,
        hpFrac: 1,
        dead: false
      };
      const boss = {
        dead: false,
        hp: 6000,
        x: cx + 110,
        y: cy,
        pl: {
          id: -1,
          name: 'VKL (Boss)',
          gender: 'boss',
          role: 'boss',
          company: '',
          hue: 0,
          x: cx + 110,
          y: cy,
          heading: 0, // facing camera
          moving: false,
          swing: 0,
          hpFrac: 1,
          alwaysHp: true,
          dead: false
        }
      };
      // Minis
      window.S.minis.clear();
      window.S.minis.set('TML', {
        hp: 1200,
        x: cx - 50,
        y: cy,
        pl: { id: 101, name: 'TML', mini: 'TML', role: 'lead', hue: 35, x: cx - 50, y: cy, heading: 0, moving: false, hpFrac: 1 }
      });
      window.S.minis.set('DMM', {
        hp: 1500,
        x: cx + 0,
        y: cy,
        pl: { id: 102, name: 'DMM', mini: 'DMM', role: 'pm', hue: 280, x: cx + 0, y: cy, heading: 0, moving: false, hpFrac: 1 }
      });
      window.S.minis.set('PROFK', {
        hp: 2000,
        x: cx + 55,
        y: cy,
        pl: { id: 103, name: 'Prof. K', mini: 'PROFK', role: 'dev', hue: 140, x: cx + 55, y: cy, heading: 0, moving: false, hpFrac: 1 }
      });
      window.setupScene([me], boss);
      for (let f = 0; f < 10; f++) window.renderFrame(0.016);
    }, { cx: centerX, cy: centerY });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, 'catalog-boss-vkl.png') });
    console.log('Captured catalog-boss-vkl.png');

    // --- 3b. PANORAMIC ZOOM OUT (Max zoom-out birds-eye overview) ---
    await page.evaluate(() => {
      for (let i = 0; i < 6; i++) window.app.zoomStep(1);
      window.renderFrame(0.016);
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, 'catalog-zoom-out.png') });
    console.log('Captured catalog-zoom-out.png');
    await page.evaluate(() => {
      window.app.resetZoom();
      window.renderFrame(0.016);
    });

    // --- 4. PLAYER & BOSS VKL DEFEATED (Natural knockout flat on floor) ---
    await page.evaluate(({ cx, cy }) => {
      const me = {
        id: 1,
        name: 'Player (Knocked Out)',
        gender: 'm',
        role: 'dev',
        company: '',
        hue: 35,
        x: cx - 40,
        y: cy,
        heading: 0,
        moving: false,
        swing: 0,
        hpFrac: 0,
        dead: true // dead!
      };
      const boss = {
        dead: true, // dead!
        hp: 0,
        x: cx + 45,
        y: cy,
        pl: {
          id: -1,
          name: 'VKL (Beaten - 15s Linger)',
          gender: 'boss',
          role: 'boss',
          company: '',
          hue: 0,
          x: cx + 45,
          y: cy,
          heading: 0,
          moving: false,
          swing: 0,
          hpFrac: 0,
          alwaysHp: false,
          dead: true
        }
      };
      // Mini beaten and lingering
      S.minis.set('TML', {
        hp: 0,
        x: cx - 95,
        y: cy,
        pl: { id: 101, name: 'TML (Beaten)', mini: 'TML', role: 'lead', hue: 35, x: cx - 95, y: cy, heading: 0, moving: false, hpFrac: 0, dead: true }
      });
      // Lingering beaten mini-boss
      window.S.minis.clear();
      window.S.minis.set('TML', {
        hp: 0,
        x: cx - 110,
        y: cy,
        pl: { id: 101, name: 'TML (Defeated)', mini: 'TML', role: 'lead', hue: 35, x: cx - 110, y: cy, heading: 0, moving: false, hpFrac: 0, dead: true }
      });
      window.setupScene([me], boss);
      // Run enough frames for rig.lie to interpolate smoothly to 1.0
      for (let f = 0; f < 30; f++) window.renderFrame(0.05);
    }, { cx: centerX, cy: centerY });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, 'catalog-death-pose.png') });
    console.log('Captured catalog-death-pose.png');

  } catch (e) {
    console.error('Error in render-catalog:', e);
  } finally {
    await browser.close();
    await app.stop();
    process.exit(0);
  }
}

main();
