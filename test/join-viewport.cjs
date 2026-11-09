'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../server');

async function main() {
  const app = createApp({ log: () => {} });
  const port = await app.start(0);
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
    const errors = [];
    let recoveredForm;
    for (const [tag, cssHeight, appHeight, expectedColumns] of [
      ['stale CSS viewport from iPhone launch', 378, 440, 2],
      ['settled landscape', 440, 440, 2],
      ['genuinely short landscape', 378, 378, 4],
    ]) {
      const page = await browser.newPage({ viewport: { width: 956, height: cssHeight }, isMobile: true, hasTouch: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Version/27.2 Mobile/15E148 Safari/604.1' });
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(h => {
        Object.defineProperty(navigator, 'standalone', { value: true });
        Object.defineProperty(window, 'innerHeight', { get: () => h });
      }, appHeight);
      await page.route('**/game.js*', r => r.fulfill({ contentType: 'application/javascript', body: '' }));
      // The report has dvh=440 even when CSS media queries/root still use 378.
      // Substitute the CSS unit in the fixture; do not modify product sizing.
      await page.route('**/style.css*', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replaceAll('100dvh', appHeight + 'px') });
      });
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.evaluate(() => {
        document.getElementById('characterSummary').hidden = false;
        document.getElementById('characterEditor').hidden = true;
        for (const [id, text] of Object.entries({ summaryName: 'Nick', summaryCompany: 'Chưa thêm', summaryRole: 'Dev', summaryGender: 'Nam' })) {
          document.getElementById(id).textContent = text;
        }
      });
      await page.waitForFunction(h => GameViewport.height === h, appHeight);
      const geometry = await page.evaluate(() => {
        const details = document.querySelector('.character-details');
        const r = document.getElementById('app').getBoundingClientRect();
        return { rootHeight: document.documentElement.clientHeight, appHeight: r.height, appTop: r.y,
          shortMedia: matchMedia('(max-height:420px)').matches,
          columns: getComputedStyle(details).gridTemplateColumns.split(' ').length };
      });
      assert.equal(geometry.rootHeight, cssHeight);
      assert.equal(geometry.appHeight, appHeight);
      assert.equal(geometry.appTop, 0);
      assert.equal(geometry.shortMedia, cssHeight <= 420);
      assert.equal(geometry.columns, expectedColumns, tag);
      const form = await page.locator('#joinForm').boundingBox();
      if (appHeight === 440) {
        if (!recoveredForm) recoveredForm = form;
        else assert.deepEqual(form, recoveredForm, 'stale and settled CSS viewports produce the same form bounds');
      }
      console.log('ok - ' + tag + ': ' + expectedColumns + ' columns at app height ' + appHeight);
      await page.close();
    }
    assert.deepEqual(errors, []);
    console.log('PASS: join layout follows app size despite stale CSS viewport height. Native iOS shell behavior is not emulated.');
  } finally {
    await browser?.close();
    await app.stop();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
