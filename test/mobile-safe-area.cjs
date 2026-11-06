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
    await page.route('**/scene3d.js', r => r.fulfill({ contentType: 'application/javascript', body: `export function createScene3D(){return {resize(w,h){window.safeRendererSize={w,h}},setQuality(){},update(){},build(){},zoom(){},cameraTo(){},zoomLimits(){return {}},fx:new Proxy({},{get:()=>()=>{}})}}` }));
    await page.goto(`http://127.0.0.1:${port}/?room=br-1`);
    assert.equal(await page.locator('meta[name="apple-mobile-web-app-status-bar-style"]').count(),0,
      'Home Screen app uses the system status bar instead of forcing deprecated translucency');
    await page.fill('#nameInput','Safe area'); await page.click('#joinBtn');
    await page.waitForFunction(() => document.getElementById('overlay').classList.contains('gone'));
    const profiles = [
      ['iPhone landscape left/right housing',844,390,59,59,0,21],
      ['short landscape with housing',740,320,59,59,0,21],
      ['Android left cutout and gesture bar',844,390,32,0,0,24],
      ['Android right cutout and gesture bar',844,390,0,32,0,24],
      ['Android side navigation bar',844,390,0,48,0,0],
      ['no cutout',844,390,0,0,0,0],
      // Supplied insets test layout; Chromium does not reproduce iPadOS system chrome.
      ['iPad Pro 11 landscape with status/home bars',1210,834,0,0,24,20],
      ['iPad landscape with taller top inset',1210,834,0,0,36,20],
    ];
    for (const [name,w,h,left,right,top,bottom] of profiles) {
      await page.setViewportSize({ width:w,height:h });
      await page.waitForFunction(w => GameViewport.width===w, w);
      await page.evaluate(v => { for (const [key,value] of Object.entries(v)) document.documentElement.style.setProperty('--safe-'+key,value+'px'); }, {left,right,top,bottom});
      const inset=top+Math.min(top,16);
      await page.waitForFunction(({w,h,inset})=>GameViewport.width===w&&GameViewport.height===h-inset,{w,h,inset});
      const ids=['topbar','minimap','chatDock','joystick','smashBtn','mobileBottomControls','sideBtns'];
      const boxes=await page.evaluate(ids=>Object.fromEntries(ids.map(id=>{const r=document.getElementById(id).getBoundingClientRect();return [id,{left:r.left,right:r.right,top:r.top,bottom:r.bottom}]})),ids);
      for (const [id,r] of Object.entries(boxes)) {
        assert.ok(r.left >= left && r.right <= w-right+.5 && r.top >= top && r.bottom <= h-bottom+.5, `${name}: ${id} outside safe area ${JSON.stringify(r)}`);
      }
      const surface=await page.locator('#c').boundingBox();
      assert.deepEqual(surface,{x:0,y:inset,width:w,height:h-inset}, `${name}: canvas fills layout behind safe areas`);
      assert.deepEqual(await page.evaluate(()=>safeRendererSize),{w,h:h-inset}, `${name}: renderer matches canvas`);
      await page.click('#settingsBtn');
      const card=await page.locator('#settingsDlg .card').boundingBox();
      assert.ok(card.x>=left&&card.x+card.width<=w-right&&card.y>=top&&card.y+card.height<=h-bottom);
      await page.click('#settingsClose');
      console.log('ok - '+name+': HUD, map/chat, controls and settings stay inside injected safe-area bounds');
    }
    await page.evaluate(()=>document.documentElement.style.setProperty('--safe-top','0px'));
    await page.setViewportSize({width:844,height:390});
    await page.waitForFunction(()=>GameViewport.height===390&&safeRendererSize.h===390);
    // Model a late/stale root height while the dynamic app surface has already expanded.
    await page.evaluate(() => { document.documentElement.style.height='300px'; document.getElementById('app').style.height='300px'; });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await page.waitForFunction(() => GameViewport.height===390&&safeRendererSize.h===390);
    const sizes=await page.evaluate(()=>({app:document.getElementById('app').getBoundingClientRect().height,canvas:document.getElementById('c').getBoundingClientRect().height,viewport:GameViewport.height}));
    assert.deepEqual(sizes,{app:390,canvas:390,viewport:390});
    await page.evaluate(() => document.getElementById('app').style.height='');
    await page.setViewportSize({width:390,height:844});
    await page.waitForFunction(()=>!document.getElementById('rotateOverlay').hidden);
    await page.setViewportSize({width:844,height:440});
    await page.waitForFunction(()=>GameViewport.height===440&&safeRendererSize.h===440);
    assert.equal(await page.locator('#c').evaluate(e=>e.getBoundingClientRect().height),440);
    console.log('ok - stale root height, native rotation and late viewport growth keep app/canvas/renderer in sync');
    // Home Screen launch: both CSS and innerHeight start short, then only innerHeight
    // recovers. No resize/rotation event is sent; startup rechecks must fill the gap.
    await page.setViewportSize({width:1210,height:834});
    await page.route('**/style.css', async route => {
      const response=await route.fetch();
      await route.fulfill({response,body:(await response.text())+'\n#app { height: calc(100dvh - 24px); }'});
    });
    await page.addInitScript(() => {
      const nativeHeight=Object.getOwnPropertyDescriptor(window,'innerHeight').get;
      window.testShortLaunch=true;
      Object.defineProperty(window,'innerHeight',{configurable:true,get(){return nativeHeight.call(window)-(window.testShortLaunch?24:0);}});
    });
    await page.reload();
    await page.waitForFunction(()=>GameViewport.height===810);
    await page.evaluate(()=>{window.testShortLaunch=false;});
    await page.waitForFunction(()=>GameViewport.height===834);
    assert.deepEqual(await page.locator('#c').boundingBox(),{x:0,y:0,width:1210,height:834});
    console.log('ok - iPad short Home Screen launch recovers full canvas height without rotation or resize');
    // An opaque system status bar can sit OUTSIDE the content viewport. Screen
    // dimensions and legacy root/vh sizing must not push controls below that viewport.
    const cropped=await browser.newPage({viewport:{width:1210,height:810},screen:{width:1210,height:834},isMobile:true,hasTouch:true});
    cropped.on('pageerror',e=>errors.push(e.message));
    await cropped.route('**/scene3d.js',r=>r.fulfill({contentType:'application/javascript',body:`export function createScene3D(){return {resize(w,h){window.safeRendererSize={w,h}},setQuality(){},update(){},build(){},zoom(){},cameraTo(){},zoomLimits(){return {}},fx:new Proxy({},{get:()=>()=>{}})}}`}));
    await cropped.goto(`http://127.0.0.1:${port}/?room=br-1`);
    await cropped.addStyleTag({content:'html, body { height: 834px; }'});
    await cropped.evaluate(()=>document.documentElement.style.setProperty('--safe-bottom','20px'));
    await cropped.fill('#nameInput','System status bar');await cropped.click('#joinBtn');
    await cropped.waitForFunction(()=>document.getElementById('overlay').classList.contains('gone'));
    await cropped.waitForFunction(()=>GameViewport.height===810&&safeRendererSize.h===810);
    assert.deepEqual(await cropped.locator('#c').boundingBox(),{x:0,y:0,width:1210,height:810});
    const geometry=await cropped.evaluate(()=>({screen:screen.height,layout:innerHeight,top:document.getElementById('app').getBoundingClientRect().top,
      buttons:['skillBtn','smashBtn','chatDock','joystick'].map(id=>document.getElementById(id).getBoundingClientRect().bottom)}));
    assert.equal(geometry.screen,834);assert.equal(geometry.layout,810);assert.equal(geometry.top,0,'no double reservation when the status bar is outside the viewport');
    assert.ok(geometry.buttons.every(bottom=>bottom<=790),'controls stay in the usable viewport above the home safe area');
    await cropped.close();
    console.log('ok - external status bar: canvas fills the shorter content viewport without double top padding or clipped bottom controls');
    // iPad Home Screen app without black-translucent: the web view runs under the status bar
    // (safe-area-inset-top 0) but innerHeight is one status-bar height short of the window, so
    // the game sat under the scroll-edge blur and a dark band showed below it. Modeled here as a
    // 1210x810 layout viewport on a 1210x834 screen; Chromium cannot reproduce the compositor.
    const iPadUA='Mozilla/5.0 (iPad; CPU OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';
    const iPhoneUA=iPadUA.replace('iPad; CPU OS','iPhone; CPU iPhone OS');
    for (const [label,userAgent,standalone,gap] of [['iPad Home Screen',iPadUA,true,24],['iPad Safari tab',iPadUA,false,0],['iPhone Home Screen',iPhoneUA,true,0]]) {
      const ipad=await browser.newPage({viewport:{width:1210,height:810},screen:{width:1210,height:834},isMobile:true,hasTouch:true,userAgent});
      ipad.on('pageerror',e=>errors.push(e.message));
      if (standalone) await ipad.addInitScript(()=>Object.defineProperty(Navigator.prototype,'standalone',{configurable:true,get:()=>true}));
      await ipad.route('**/scene3d.js',r=>r.fulfill({contentType:'application/javascript',body:`export function createScene3D(){return {resize(w,h){window.safeRendererSize={w,h}},setQuality(){},update(){},build(){},zoom(){},cameraTo(){},zoomLimits(){return {}},fx:new Proxy({},{get:()=>()=>{}})}}`}));
      await ipad.goto(`http://127.0.0.1:${port}/?room=br-1`);
      await ipad.evaluate(()=>document.documentElement.style.setProperty('--safe-bottom','20px'));
      await ipad.fill('#nameInput','iPad bar');await ipad.click('#joinBtn');
      await ipad.waitForFunction(()=>document.getElementById('overlay').classList.contains('gone'));
      await ipad.waitForFunction(()=>GameViewport.height===810&&safeRendererSize.h===810);
      assert.equal(await ipad.evaluate(()=>GameViewport.statusGap),gap,`${label}: status gap`);
      assert.deepEqual(await ipad.locator('#c').boundingBox(),{x:0,y:gap,width:1210,height:810},`${label}: canvas runs from below the status bar to the bottom edge`);
      assert.deepEqual(await ipad.evaluate(()=>safeRendererSize),{w:1210,h:810},`${label}: renderer matches canvas`);
      const band=await ipad.locator('#statusBand').boundingBox();
      if (gap) assert.deepEqual(band,{x:0,y:0,width:1210,height:gap},`${label}: opaque band covers the status bar`);
      else assert.ok(!band||band.height===0,`${label}: no status band`);
      const hud=await ipad.evaluate(()=>['topbar','minimap','skillBtn','smashBtn','chatDock','joystick'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,top:r.top,bottom:r.bottom};}));
      for (const r of hud) assert.ok(r.top>=gap&&r.bottom<=810+gap-20,`${label}: ${r.id} clear of status bar and home indicator ${JSON.stringify(r)}`);
      await ipad.close();
      console.log(`ok - ${label}: canvas ${gap?'fills from below the status bar to the screen bottom':'keeps layout-viewport sizing'}`);
    }
    assert.deepEqual(errors,[]);
  } finally { await browser?.close(); await app.stop(); }
}
main().catch(e=>{console.error(e);process.exitCode=1});
