'use strict';

// UI-only browser checks: stub WebGL, keep the real HTML/CSS, viewport, game and sockets.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createApp } = require('../server');

async function main() {
  const app = createApp({ bossEnabled: false, moleEnabled: false, log: () => {} });
  const port = await app.start(0);
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let blockGame = true;
    await page.route('**/game.js', route => {
      let source = '';
      if (!blockGame) {
        source = fs.readFileSync(path.join(__dirname, '../public/game.js'), 'utf8');
        const marker = '  requestAnimationFrame(frame);\n})();';
        assert.ok(source.includes(marker));
        source = source.replace(marker, '  window.orientationCheck = { S };\n' + marker);
      }
      return route.fulfill({ contentType: 'application/javascript', body: source });
    });
    await page.route('**/scene3d.js', route => route.fulfill({ contentType: 'application/javascript', body: `export function createScene3D(){return {
      resize(){},setQuality(){},update(){},build(){},zoom(){},cameraTo(){},zoomLimits(){return {atMin:false,atMax:false}},fx:new Proxy({},{get:()=>()=>{}})
    }};` }));
    await page.addInitScript(() => {
      // Model a phone browser that cannot override the user's orientation lock.
      Element.prototype.requestFullscreen = () => Promise.reject(new Error('unsupported'));
      if (screen.orientation) screen.orientation.lock = () => Promise.reject(new Error('locked'));
    });
    const rotate = async expected => {
      await page.waitForFunction(value => document.getElementById('rotateOverlay').hidden === !value, expected);
    };
    await page.goto(`http://localhost:${port}/?room=br-1`);
    await rotate(true);
    assert.equal(await page.evaluate(() => !!window.orientationCheck), false);
    console.log('ok - portrait prompt is visible without game.js or WebGL initialization');
    blockGame = false;
    await page.reload();
    await page.waitForFunction(() => !!window.orientationCheck);
    await rotate(true);
    assert.equal(await page.evaluate(() => orientationCheck.S.joined), false);
    await page.click('#landscapeBtn');
    await rotate(true);
    assert.match(await page.locator('#rotateOverlay').innerText(), /Tắt khóa xoay/);
    console.log('ok - reload before joining and rejected orientation APIs retain the unlock instruction');
    await page.setViewportSize({ width: 844, height: 390 });
    await rotate(false);
    await page.fill('#nameInput', 'Orientation check');
    await page.click('#joinBtn');
    await page.waitForFunction(() => orientationCheck.S.joined);
    await page.setViewportSize({ width: 390, height: 844 });
    await rotate(true);
    await page.reload();
    await rotate(true);
    await page.waitForFunction(() => orientationCheck?.S.joined);
    await rotate(true);
    console.log('ok - portrait prompt remains visible during auto-rejoin after reload');
    await page.evaluate(() => orientationCheck.S.ws.close(4002, 'test inactivity'));
    await page.waitForFunction(() => orientationCheck.S.fatal && !orientationCheck.S.joined);
    await rotate(true);
    await page.reload();
    await page.waitForFunction(() => !!window.orientationCheck);
    await rotate(true);
    assert.equal(await page.evaluate(() => orientationCheck.S.joined), false);
    console.log('ok - disconnect, return to join form and another reload do not hide the portrait prompt');
    if (process.env.ORIENTATION_SCREENSHOT) await page.screenshot({ path: process.env.ORIENTATION_SCREENSHOT });
    await page.setViewportSize({ width: 844, height: 390 });
    await rotate(false);
    const button = await page.locator('#joinBtn').boundingBox();
    assert.ok(button && button.y >= 0 && button.y + button.height <= 390);
    console.log('ok - native landscape restores the join form and visible primary action');
    const desktop = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: false });
    await desktop.route('**/game.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await desktop.goto(`http://localhost:${port}/`);
    assert.equal(await desktop.locator('#rotateOverlay').isVisible(), false);
    console.log('ok - narrow desktop windows do not show the mobile rotate prompt');
    assert.deepEqual(errors, []);
    console.log('All 7 orientation browser checks passed (including zero page errors). Native iPhone lock behavior still needs device verification.');
  } finally {
    if (browser) await browser.close();
    await app.stop();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
