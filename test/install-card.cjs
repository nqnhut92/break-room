'use strict';

// The Home Screen gate: phones and tablets in a browser tab get the steps to add the game instead of the join form
// (iOS: steps only, no install API in any iOS browser; Android/Chromium: a button behind beforeinstallprompt). Home Screen
// launches and desktops join as usual. Playwright sets navigator.webdriver, which the game exempts so the other touch
// suites can join; this suite turns it off. WebGL is stubbed.
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

// Opens the join screen (the card lives there); `join` also enters the office.
async function open(browser, port, device, { standalone = false, prompt = false, join = false } = {}) {
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
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
    Element.prototype.requestFullscreen = () => Promise.reject(new Error('unsupported'));
    if (screen.orientation) screen.orientation.lock = () => Promise.reject(new Error('unsupported'));
    if (standalone) Object.defineProperty(navigator, 'standalone', { value: true });
  }, { standalone, ipadOs });
  await page.goto(`http://localhost:${port}/?server=br-1`);
  await page.waitForSelector('#joinForm h1', { state: 'visible' });
  await page.waitForTimeout(300);
  if (prompt) await page.evaluate(() => {
    const e = new Event('beforeinstallprompt', { cancelable: true });
    window.prompted = 0; e.prompt = () => { window.prompted++; }; e.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(e);
  });
  if (join) {
    await page.fill('#nameInput', 'Install check'); await page.click('#joinBtn');
    await page.waitForSelector('#topbar', { state: 'visible' });
  }
  return { context, page, errors };
}

// Gated: the steps sit in the join form on screen, and nothing to join with is shown.
async function gated(page) {
  const card = page.locator('#installCard');
  assert.ok(await card.isVisible(), 'steps on the join screen');
  const box = await card.boundingBox(), vp = page.viewportSize();
  assert.ok(box.x >= 0 && box.x + box.width <= vp.width && box.y >= 0 && box.y + box.height <= vp.height, 'steps inside the screen ' + JSON.stringify(box));
  for (const id of ['#joinBtn', '#nameInput', '#googleLogin', '#scoreNote']) assert.equal(await page.locator(id).isVisible(), false, id + ' hidden in a tab');
}
async function joins(page) {
  assert.equal(await page.locator('#installCard').isVisible(), false);
  await page.fill('#nameInput', 'Install check ' + Math.floor(Math.random() * 1e4)); await page.click('#joinBtn');
  await page.waitForSelector('#topbar', { state: 'visible' });
}

async function main() {
  const app = createApp({ bossEnabled: false, moleEnabled: false, log: () => {} });
  const port = await app.start(0);
  let browser, passed = 0;
  const ok = name => { passed++; console.log('ok - ' + name); };
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });

    let t = await open(browser, port, IPHONE_SAFARI);
    await gated(t.page);
    assert.match(await t.page.locator('#installText').textContent(), /Bấm Chia sẻ → Thêm vào Màn hình chính, rồi mở game từ icon mới/);
    assert.equal(await t.page.locator('#installBtn').isVisible(), false, 'no install button on iOS');
    assert.equal(await t.page.locator('#installCopy').isVisible(), false);
    // Not even a scripted submit or the reload auto-join gets in from the tab.
    await t.page.evaluate(() => { document.getElementById('nameInput').value = 'Sneaky'; document.getElementById('joinForm').requestSubmit(); });
    await t.page.evaluate(() => { sessionStorage.setItem('br-auto', '1'); localStorage.setItem('br-name', 'Sneaky'); });
    await t.page.reload(); await t.page.waitForTimeout(1500);
    assert.equal(await t.page.locator('#topbar').isVisible(), false, 'still outside the office');
    await gated(t.page);
    assert.deepEqual(t.errors, []); await t.context.close();
    ok('iPhone Safari tab: only the steps; no join, not even by submit or reload auto-join');

    t = await open(browser, port, EDGE_IOS);
    await gated(t.page);
    assert.match(await t.page.locator('#installText').textContent(), /⋯ → Chia sẻ → Thêm vào Màn hình chính/);
    await t.context.close();
    ok('Edge on iPhone: the steps through its menu');

    t = await open(browser, port, IPAD_SAFARI);
    await gated(t.page);
    assert.match(await t.page.locator('#installText').textContent(), /Bấm Chia sẻ → Thêm vào Màn hình chính/);
    await t.context.close();
    for (const device of [IPAD_EDGE, IPAD_EDGE_IOS_UA]) {
      t = await open(browser, port, device);
      await gated(t.page);
      assert.match(await t.page.locator('#installText').textContent(), /mở trang bằng Safari/, 'Edge on iPad has no Add to Home Screen');
      assert.ok(await t.page.locator('#installCopy').isVisible(), 'a link to paste into Safari');
      await t.context.close();
    }
    ok('iPad (Mac user agent, fine pointer): Safari gets the steps, Edge is sent to Safari with a copy-link button');

    t = await open(browser, port, IPHONE_SAFARI, { standalone: true });
    await joins(t.page);
    assert.deepEqual(t.errors, []); await t.context.close();
    ok('a Home Screen launch joins as usual');

    t = await open(browser, port, ANDROID);
    await gated(t.page);
    assert.match(await t.page.locator('#installText').textContent(), /⋮ → Thêm vào màn hình chính/);
    await t.context.close();
    t = await open(browser, port, ANDROID, { prompt: true });
    await gated(t.page);
    assert.ok(await t.page.locator('#installBtn').isVisible(), 'Android gets an install button');
    await t.page.tap('#installBtn'); await t.page.waitForTimeout(200);
    assert.equal(await t.page.evaluate(() => window.prompted), 1, 'the browser dialog is asked for');
    assert.match(await t.page.locator('#installText').textContent(), /Mở game từ icon/);
    assert.equal(await t.page.locator('#installBtn').isVisible(), false);
    assert.deepEqual(t.errors, []); await t.context.close();
    ok('Android tab: manual steps, or the install button when the browser offers it; then "open the icon"');

    for (const viewport of [{ width: 740, height: 320 }, { width: 667, height: 375 }]) {
      t = await open(browser, port, { ...IPHONE_SAFARI, viewport });
      await gated(t.page);
      await t.page.screenshot({ path: path.join(require('os').tmpdir(), `br-install-${viewport.width}x${viewport.height}.png`) });
      await t.context.close();
    }
    ok('small landscape phones: the steps fit on screen');

    t = await open(browser, port, { viewport: { width: 1280, height: 720 } });
    await joins(t.page);
    await t.context.close();
    ok('desktop: no gate');

    console.log(`All ${passed} Home Screen gate checks passed (emulated devices; real install dialogs and Home Screen launches need a phone).`);
  } finally { if (browser) await browser.close(); await app.stop(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
