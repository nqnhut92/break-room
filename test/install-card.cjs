'use strict';

// The "Add to Home Screen" suggestion: iOS gets the steps (no install API in any iOS browser), Android/Chromium gets
// a button behind beforeinstallprompt, desktops and Home Screen launches get nothing. WebGL is stubbed.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');
const { createApp } = require('../server');

const IPHONE_SAFARI = devices['iPhone 13 landscape'];
const EDGE_IOS = { ...IPHONE_SAFARI, userAgent: IPHONE_SAFARI.userAgent.replace('Version/', 'EdgiOS/131.0 Version/') };
const ANDROID = devices['Pixel 7 landscape'];
// iPadOS presents itself as a Mac: "Macintosh" user agent, platform MacIntel, several touch points.
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPAD_SAFARI = { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, isMobile: false, hasTouch: true, userAgent: MAC_UA, ipadOs: true };
const IPAD_EDGE = { ...IPAD_SAFARI, userAgent: MAC_UA + ' EdgiOS/131.0.2903.92' };
const IPAD_EDGE_IOS_UA = { ...devices['iPad Pro 11 landscape'], userAgent: devices['iPad Pro 11 landscape'].userAgent.replace('Version/', 'EdgiOS/131.0 Version/') };

async function open(browser, port, device, { standalone = false, prompt = false, noticeEarly = false } = {}) {
  const { ipadOs = false, ...contextOptions } = device;
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/scene3d.js', route => route.fulfill({ contentType: 'application/javascript', body: `export function createScene3D(){return {resize(){},setQuality(){},update(){},build(){},zoom(){},zoomStep(){},cameraTo(){},zoomLimits(){return {atMin:false,atMax:false}},fx:new Proxy({},{get:()=>()=>{}})}}` }));
  await page.addInitScript(({ standalone, ipadOs }) => {
    if (ipadOs) {
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
      Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5 });
      // an iPad with a trackpad reports a fine pointer; the card must still appear
      const mm = window.matchMedia.bind(window);
      window.matchMedia = q => { const m = mm(q); return /pointer:\s*coarse/.test(q) ? new Proxy(m, { get: (o, k) => k === 'matches' ? false : typeof o[k] === 'function' ? o[k].bind(o) : o[k] }) : m; };
    }
    Element.prototype.requestFullscreen = () => Promise.reject(new Error('unsupported'));
    if (screen.orientation) screen.orientation.lock = () => Promise.reject(new Error('unsupported'));
    if (standalone) Object.defineProperty(navigator, 'standalone', { value: true });
  }, { standalone, ipadOs });
  await page.goto(`http://localhost:${port}/?server=br-1`);
  await page.fill('#nameInput', 'Install check'); await page.click('#joinBtn');
  await page.waitForSelector('#topbar', { state: 'visible' });
  // An office event (patrol or Prof. K) on screen when the card is due used to cancel the card for the whole visit.
  if (noticeEarly) await page.evaluate(() => { const n = document.getElementById('officeNotice'); n.textContent = 'Prof. K đang đánh VKL · 20s'; n.hidden = false; });
  if (prompt) await page.evaluate(() => {
    const e = new Event('beforeinstallprompt', { cancelable: true });
    window.prompted = 0; e.prompt = () => { window.prompted++; }; e.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(e);
  });
  await page.waitForTimeout(3000);
  return { context, page, errors };
}

async function main() {
  const app = createApp({ bossEnabled: false, moleEnabled: false, log: () => {} });
  const port = await app.start(0);
  let browser, passed = 0;
  const ok = name => { passed++; console.log('ok - ' + name); };
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });

    let t = await open(browser, port, IPHONE_SAFARI);
    assert.ok(await t.page.locator('#installCard').isVisible(), 'shown in Safari on iPhone');
    assert.match(await t.page.locator('#installText').textContent(), /Chia sẻ → Thêm vào Màn hình chính/);
    assert.equal(await t.page.locator('#installBtn').isVisible(), false, 'no install button on iOS');
    await t.page.tap('#installClose');
    assert.equal(await t.page.locator('#installCard').isVisible(), false);
    assert.equal(await t.page.evaluate(() => localStorage.getItem('br-install-hidden')), '1');
    await t.page.reload(); // a reload puts you straight back in the office
    await t.page.waitForSelector('#topbar', { state: 'visible' }); await t.page.waitForTimeout(3000);
    assert.equal(await t.page.locator('#installCard').isVisible(), false, '× hides it for good');
    assert.deepEqual(t.errors, []); await t.context.close();
    ok('iPhone Safari: the steps, no button; × hides the suggestion for good');

    t = await open(browser, port, EDGE_IOS);
    assert.match(await t.page.locator('#installText').textContent(), /⋯ → Chia sẻ/);
    await t.context.close();
    ok('Edge on iPhone: the steps through its menu');

    t = await open(browser, port, IPHONE_SAFARI, { noticeEarly: true });
    assert.ok(await t.page.locator('#installCard').isVisible(), 'an office notice no longer cancels the card');
    const [notice, card] = await Promise.all(['#officeNotice', '#installCard'].map(s => t.page.locator(s).boundingBox()));
    assert.ok(card.y >= notice.y + notice.height, 'the card sits under the notice, not on top of it');
    await t.page.evaluate(() => { document.getElementById('officeNotice').hidden = true; dispatchEvent(new Event('resize')); });
    assert.ok((await t.page.locator('#installCard').boundingBox()).y < card.y, 'and moves back up when the notice goes');
    assert.deepEqual(t.errors, []); await t.context.close();
    ok('an office notice and the card share the top: the card stacks under it');

    t = await open(browser, port, IPAD_SAFARI);
    assert.ok(await t.page.locator('#installCard').isVisible(), 'iPadOS with a Mac user agent and a fine pointer still gets the card');
    assert.match(await t.page.locator('#installText').textContent(), /^Chơi toàn màn hình: Chia sẻ/);
    await t.context.close();
    for (const device of [IPAD_EDGE, IPAD_EDGE_IOS_UA]) {
      t = await open(browser, port, device);
      assert.match(await t.page.locator('#installText').textContent(), /mở game bằng Safari/, 'Edge on iPad has no Add to Home Screen');
      await t.context.close();
    }
    ok('iPad: Safari gets the steps, Edge is sent to Safari');

    t = await open(browser, port, IPHONE_SAFARI, { standalone: true });
    assert.equal(await t.page.locator('#installCard').isVisible(), false);
    await t.context.close();
    ok('a Home Screen launch gets no suggestion');

    t = await open(browser, port, ANDROID);
    assert.equal(await t.page.locator('#installCard').isVisible(), false, 'no prompt event, no card on Android');
    await t.context.close();
    t = await open(browser, port, ANDROID, { prompt: true });
    assert.ok(await t.page.locator('#installBtn').isVisible(), 'Android gets an install button');
    await t.page.tap('#installBtn'); await t.page.waitForTimeout(200);
    assert.equal(await t.page.evaluate(() => window.prompted), 1, 'the browser dialog is asked for');
    assert.equal(await t.page.locator('#installCard').isVisible(), false);
    assert.deepEqual(t.errors, []); await t.context.close();
    ok('Android: the button opens the browser install dialog once');

    t = await open(browser, port, { viewport: { width: 1280, height: 720 } });
    assert.equal(await t.page.locator('#installCard').isVisible(), false);
    await t.context.close();
    ok('desktop: nothing');

    console.log(`All ${passed} install suggestion checks passed (emulated devices; real install dialogs need a phone).`);
  } finally { if (browser) await browser.close(); await app.stop(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
