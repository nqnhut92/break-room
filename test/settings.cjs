'use strict';
const assert=require('assert/strict');
const fs=require('fs');
const path=require('path');
const {chromium}=require('playwright');
const {createApp}=require('../server');

async function main(){
  const app=createApp({bossEnabled:false,moleEnabled:false,afkMs:0,log:()=>{}}),port=await app.start(0);
  let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,headless:true});
    let passed=0;const ok=name=>{passed++;console.log('ok - '+name)};
    const stubRenderer=process.env.SETTINGS_REAL_RENDERER!=='1';
    for(const [width,height] of (stubRenderer ? [[740,320],[844,390],[956,440]] : [[844,390]])){
      const page=await browser.newPage({viewport:{width,height},isMobile:true,hasTouch:true});
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      if(stubRenderer)await page.route('**/scene3d.js',r=>r.fulfill({contentType:'application/javascript',body:`export function createScene3D(){return {resize(){},setQuality(q){window.testQuality=q},update(){},build(){},zoom(){},cameraTo(){},zoomLimits(){return {atMin:false,atMax:false}},fx:new Proxy({},{get:()=>()=>{}})}}`}));
      await page.addInitScript(()=>{Element.prototype.requestFullscreen=()=>Promise.reject(new Error('unsupported'));if(screen.orientation)screen.orientation.lock=()=>Promise.reject(new Error('unsupported'));});
      await page.goto(`http://localhost:${port}/?room=br-1`);
      await page.fill('#nameInput','Settings '+width);await page.click('#joinBtn');await page.waitForFunction(()=>document.getElementById('overlay').classList.contains('gone'));
      await page.click('#settingsBtn');
      const layout=await page.evaluate(()=>{
        const box=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom}};
        return {ids:[...document.getElementById('settingsActions').children].map(e=>e.id),boxes:Object.fromEntries(['helpBtn','mapBtn','gfxBtn','copyLink','resetBtn'].map(id=>[id,box(id)])),card:box('settingsDlg'),close:box('settingsClose')};
      });
      assert.deepEqual(layout.ids,['helpBtn','mapBtn','gfxBtn','copyLink','resetBtn']);
      const b=layout.boxes;assert.ok(Math.abs(b.helpBtn.y-b.mapBtn.y)<1&&Math.abs(b.gfxBtn.y-b.copyLink.y)<1);
      assert.ok(Math.abs(b.helpBtn.x-b.gfxBtn.x)<1&&Math.abs(b.mapBtn.x-b.copyLink.x)<1);
      assert.ok(b.resetBtn.y>b.copyLink.y&&Math.abs(b.resetBtn.w-(b.copyLink.x+b.copyLink.w-b.helpBtn.x))<1);
      assert.ok(Object.values(b).every(v=>v.h>=44&&v.bottom<=height&&v.x>=0&&v.x+v.w<=width));
      ok(width+'x'+height+': five controls form two aligned pairs and a full-width reset row');
      await page.click('#gfxBtn');assert.equal(await page.locator('#gfxBtn').getAttribute('aria-pressed'),'true');
      assert.equal(await page.evaluate(()=>localStorage.getItem('br-gfx2')),'high');
      await page.click('#mapBtn');assert.equal(await page.locator('#minimap').isVisible(),false);
      assert.equal(await page.locator('#zoomBtns').evaluate(e=>e.parentElement.id),'sideBtns');
      for(const id of ['skillBtn','chatBtn'])assert.equal(await page.locator('#'+id).evaluate(e=>e.parentElement.id),'mobileBottomControls');
      assert.equal(await page.locator('#emotes').evaluate(e=>e.parentElement.id),'emoteTray');
      if(process.env.SETTINGS_SCREENSHOT&&width===844)await page.screenshot({path:process.env.SETTINGS_SCREENSHOT});
      await page.click('#settingsClose');assert.equal(await page.locator('#settingsDlg').isVisible(),false);
      await page.click('#settingsBtn');await page.click('#helpBtn');
      assert.equal(await page.locator('#help').isVisible(),true);assert.equal(await page.locator('#settingsDlg').isVisible(),false);
      assert.deepEqual(errors,[]);ok(width+'x'+height+': existing actions work and gameplay controls remain outside settings');
      await page.close();
    }
    const desktop=await browser.newPage({viewport:{width:1100,height:720}});
    await desktop.route('**/scene3d.js',r=>r.fulfill({contentType:'application/javascript',body:'export function createScene3D(){return {resize(){},setQuality(){},zoomLimits(){return {}}}}'}));
    await desktop.goto(`http://localhost:${port}`);await desktop.waitForFunction(()=>document.getElementById('roomList').getAttribute('aria-busy')==='false');
    for(const id of ['helpBtn','mapBtn','gfxBtn'])assert.equal(await desktop.locator('#'+id).evaluate(e=>e.parentElement.id),'sideTools');
    assert.equal(await desktop.locator('#copyLink').evaluate(e=>e.parentElement.id),'topLeft');
    assert.equal(await desktop.locator('#settingsBtn').isVisible(),false);
    ok('desktop toolbar retains its original controls and placement');
    console.log(`All ${passed} settings browser checks passed.`);
  }finally{if(browser)await browser.close();await app.stop();}
}
main().catch(e=>{console.error(e);process.exitCode=1});
