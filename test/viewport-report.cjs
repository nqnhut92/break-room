'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../server');

async function main() {
  const app = createApp({ bossEnabled: false, moleEnabled: false, log: () => {} });
  const port = await app.start(0);
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
    const phone = await browser.newPage({ viewport: { width: 956, height: 440 }, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
    const errors = [];
    phone.on('pageerror', e => errors.push(e.message));
    await phone.route('**/game.js*', r => r.fulfill({ contentType: 'application/javascript', body: '' }));
    await phone.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { value: true });
      Object.defineProperty(navigator, 'clipboard', { value: { async writeText(text) {
        if (window.denyClipboard) throw new Error('denied');
        window.copiedReport = text;
      } } });
      window.prompt = (_, text) => { window.fallbackReport = text; };
      localStorage.setItem('private-account', 'PRIVATE_SENTINEL');
    });
    let reportRequests = 0;
    phone.on('request', r => { if (r.method() !== 'GET') reportRequests++; });
    await phone.goto(`http://127.0.0.1:${port}/?private=PRIVATE_SENTINEL`);
    await phone.locator('#viewportReport').click();
    const first = await phone.evaluate(() => JSON.parse(copiedReport));
    assert.equal(first.version, 1);
    assert.equal(first.build, 'dev');
    assert.equal(first.first.reason, 'initial');
    assert.equal(first.recent.at(-1).reason, 'copy');
    assert.deepEqual(first.recent.at(-1).app, { x: 0, y: 0, width: 956, height: 440 });
    assert.equal(first.recent.at(-1).units.dvh, 440);
    assert.equal(first.recent.at(-1).visual.scale, 1);
    assert.ok(!JSON.stringify(first).includes('PRIVATE_SENTINEL'), 'reports exclude URL and storage values');
    await phone.setViewportSize({ width: 440, height: 956 });
    await phone.waitForFunction(() => GameViewport.portrait);
    await phone.setViewportSize({ width: 956, height: 440 });
    await phone.waitForFunction(() => !GameViewport.portrait);
    await phone.evaluate(() => {
      for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('resize'));
    });
    await phone.locator('#viewportReport').click();
    const after = await phone.evaluate(() => JSON.parse(copiedReport));
    assert.deepEqual(after.first, first.first, 'initial native-launch sample survives later measurements');
    assert.equal(after.recent.length, 12, 'history remains bounded');
    assert.ok(after.recent.some(s => s.reason === 'resize'));
    await phone.evaluate(() => { window.denyClipboard = true; });
    await phone.locator('#viewportReport').click();
    assert.equal(await phone.evaluate(() => JSON.parse(fallbackReport).recent.at(-1).reason), 'copy');
    await phone.evaluate(() => document.getElementById('overlay').classList.add('gone'));
    assert.equal(await phone.locator('#viewportReport').isVisible(), false, 'reporting does not cover gameplay');
    const desktop = await browser.newPage();
    await desktop.route('**/game.js*', r => r.fulfill({ contentType: 'application/javascript', body: '' }));
    await desktop.goto(`http://127.0.0.1:${port}/`);
    assert.equal(await desktop.locator('#viewportReport').isVisible(), false);
    assert.equal(reportRequests, 0, 'reports send no network telemetry');
    assert.deepEqual(errors, []);
    console.log('PASS: initial/current geometry, bounded history across rotation, private-data exclusion, clipboard fallback, visibility and no telemetry. Native iOS lock/sleep behavior still requires device measurements.');
  } finally {
    await browser?.close();
    await app.stop();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
