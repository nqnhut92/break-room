'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../server');
const { createMemoryStore } = require('../lib/store-memory');
const { WORLD, OBJECTS } = require('../lib/world');

async function main() {
  const rack = OBJECTS.find(o => o.type === 'server'), old = { ...WORLD.spawn };
  Object.assign(WORLD.spawn, { x: rack.x, y: rack.y + 110, rx: 0, ry: 0 });
  const app = createApp({ store: createMemoryStore(), env: {}, bossEnabled: false, moleEnabled: false, log: () => {} });
  const port = await app.start(0);
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    for (const touch of [false, true]) {
      const page = await browser.newPage({ viewport: touch ? { width: 844, height: 390 } : { width: 1280, height: 800 }, isMobile: touch, hasTouch: touch });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(() => {
        localStorage.setItem('br-gfx2', 'low');
        const Original = window.WebSocket;
        window.WebSocket = class extends Original { constructor(...args) { super(...args); window.officeTestSocket = this; this.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.t === 'serverShock') window.officeTestShock = m; if (m.t === 'hp') window.officeTestHp = m; if (m.t === 'welcome') window.officeTestWelcome = m; }); } };
      });
      // Observe real pooled electric FX without adding any product-facing diagnostic API.
      await page.route('**/scene3d.js', async route => {
        const fs = require('fs'), source = fs.readFileSync(require('path').join(__dirname, '../public/scene3d.js'), 'utf8');
        await route.fulfill({ contentType: 'application/javascript', body: source.replace('function fxElectric(x, z, tx, tz, y = 65) {', 'function fxElectric(x, z, tx, tz, y = 65) { window.officeTestArcs = (window.officeTestArcs || 0) + 1;') });
      });
      await page.goto(`http://127.0.0.1:${port}/?room=br-1`);
      await page.fill('#nameInput', touch ? 'Mobile' : 'Desktop');
      await page.click('#joinBtn');
      await page.waitForFunction(() => document.getElementById('overlay').classList.contains('gone'));
      await page.evaluate(() => window.officeTestSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'officePatrol', state: { version: 10, phase: 'warning', until: Date.now() + 5000 } }) })));
      await page.waitForFunction(() => !document.getElementById('officeNotice').hidden);
      const boxes = await page.evaluate(() => {
        const a = document.getElementById('topbar').getBoundingClientRect(), b = document.getElementById('officeNotice').getBoundingClientRect();
        return { headerBottom: a.bottom, noticeTop: b.top, left: b.left, right: b.right, bottom: b.bottom, width: innerWidth, height: innerHeight, pointer: getComputedStyle(document.getElementById('officeNotice')).pointerEvents };
      });
      assert.ok(boxes.noticeTop >= boxes.headerBottom, JSON.stringify(boxes));
      assert.ok(boxes.left >= 0 && boxes.right <= boxes.width && boxes.bottom < boxes.height);
      assert.equal(boxes.pointer, 'none');
      assert.match(await page.locator('#officeNotice').innerText(), /Ban lãnh đạo xuống lắng nghe/);
      await page.evaluate(() => window.officeTestSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'officePatrol', state: { version: 9, phase: 'idle', until: 0 } }) })));
      assert.equal(await page.locator('#officeNotice').isVisible(), true, 'stale queued events cannot replace the welcome/current event');
      await page.evaluate(id => window.officeTestSocket.send(JSON.stringify({ t: 'hit', id, skill: 'milkTea' })), rack.id);
      await page.waitForFunction(() => window.officeTestShock && window.officeTestArcs > 0);
      assert.equal(await page.evaluate(() => window.officeTestShock.dmg), 2.5);
      await page.waitForFunction(() => window.officeTestHp);
      assert.equal(await page.evaluate(() => window.officeTestHp.hp), 97.5);
      await page.screenshot({ path: `work/office-${touch ? 'mobile' : 'desktop'}.png` });
      assert.deepEqual(errors, []);
      console.log(`ok - ${touch ? 'mobile' : 'desktop'}: visible banner below header, no added controls, real electric arcs and HP loss`);
      await page.close();
    }
  } finally { Object.assign(WORLD.spawn, old); await browser?.close(); await app.stop(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
