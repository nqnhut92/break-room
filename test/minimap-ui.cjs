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
    const page = await browser.newPage({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/scene3d.js', r => r.fulfill({ contentType: 'application/javascript', body: `export function createScene3D(){return {resize(){},setQuality(){},update(){},build(){},zoom(){},cameraTo(){},zoomLimits(){return {}},fx:new Proxy({},{get:()=>()=>{}})}}` }));
    await page.goto(`http://127.0.0.1:${port}/?room=br-1`);
    await page.fill('#nameInput', 'Map layout'); await page.click('#joinBtn');
    await page.waitForFunction(() => document.getElementById('overlay').classList.contains('gone'));
    for (const [width, height] of [[844,390],[740,320],[956,440],[844,390]]) {
      await page.setViewportSize({ width, height });
      await page.waitForFunction(({width,height}) => GameViewport.width===width && GameViewport.height===height, {width,height});
      await page.waitForFunction(() => {
        const m = document.getElementById('minimap').getBoundingClientRect(), c = document.getElementById('chatLog').getBoundingClientRect(), j = document.getElementById('joystick').getBoundingClientRect();
        return Math.abs(m.width / m.height - 1.6) < .03 && c.top >= m.bottom + 6 && c.bottom <= j.top - 6;
      });
      console.log(`ok - ${width}x${height}: map keeps its aspect ratio; chat clears map and joystick after join/resize`);
    }
    await page.keyboard.press('m');
    await page.waitForFunction(() => {
      const c = document.getElementById('chatLog').getBoundingClientRect();
      return document.getElementById('minimap').classList.contains('off') && c.top < 100;
    });
    await page.keyboard.press('m');
    await page.waitForFunction(() => document.getElementById('chatLog').getBoundingClientRect().top >= document.getElementById('minimap').getBoundingClientRect().bottom + 6);
    console.log('ok - hiding/showing the map reclaims/restores space without covering chat');
    await page.reload();
    await page.waitForFunction(() => document.getElementById('overlay').classList.contains('gone'));
    await page.waitForFunction(() => {
      const m = document.getElementById('minimap').getBoundingClientRect(), c = document.getElementById('chatLog').getBoundingClientRect();
      return Math.abs(m.width / m.height - 1.6) < .03 && c.top > m.bottom;
    });
    assert.deepEqual(errors, []);
    console.log('ok - auto-rejoin rebuilds the hidden-HUD map at the phone size');
  } finally { await browser?.close(); await app.stop(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
