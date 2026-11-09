'use strict';
const assert=require('assert/strict');
const fs=require('fs');
const path=require('path');
const {chromium}=require('playwright');
const {createApp}=require('../server');

async function main(){
  const app=createApp({bossEnabled:false,moleEnabled:false,afkMs:0,respawnMs:0,log:()=>{}}),port=await app.start(0);
  let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,headless:true});
    let passed=0;const ok=name=>{passed++;console.log('ok - '+name)};
    const stubRenderer=process.env.SETTINGS_REAL_RENDERER!=='1';
    for(const [width,height] of (stubRenderer ? [[740,320],[800,360],[844,390],[956,440]] : [[844,390]])){
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
      assert.equal(await page.locator('#gfxBtn').getAttribute('aria-pressed'),'true');
      await page.click('#gfxBtn');assert.equal(await page.locator('#gfxBtn').getAttribute('aria-pressed'),'false');
      assert.equal(await page.evaluate(()=>localStorage.getItem('br-gfx2')),'low');
      await page.click('#gfxBtn');assert.equal(await page.locator('#gfxBtn').getAttribute('aria-pressed'),'true');
      assert.equal(await page.evaluate(()=>localStorage.getItem('br-gfx2')),'high');
      await page.click('#mapBtn');assert.equal(await page.locator('#minimap').isVisible(),false);
      assert.equal(await page.locator('#zoomBtns').evaluate(e=>e.parentElement.id),'sideBtns');
      assert.equal(await page.locator('#skillBtn').evaluate(e=>e.parentElement.id),'bottombar');
      assert.equal(await page.locator('#chatBtn').evaluate(e=>e.parentElement.id),'mobileBottomControls');
      const skill=await page.locator('#skillBtn').boundingBox(), attack=await page.locator('#smashBtn').boundingBox();
      assert.equal(skill.width,attack.width);assert.equal(skill.height,attack.height);
      assert.equal(attack.x-skill.x-skill.width,24,'skill and attack have a deliberate 24px gap');
      assert.equal(skill.y,attack.y);
      // + and − stay stacked on every landscape phone, and nothing on the right covers them, even with ULTI and the drink offer up.
      await page.evaluate(()=>{document.getElementById('ultBtn').hidden=false;document.getElementById('drinkBtn').hidden=false;});
      const right=await page.evaluate(()=>Object.fromEntries(['settingsBtn','zoomIn','zoomOut','ultBtn','drinkBtn','smashBtn','skillBtn'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return [id,{l:r.left,t:r.top,r:r.right,b:r.bottom}]})));
      assert.ok(Math.abs(right.zoomIn.l-right.zoomOut.l)<1&&right.zoomOut.t>=right.zoomIn.b,'zoom buttons stacked at '+width+'x'+height);
      const hit=(a,b)=>a.l<b.r&&b.l<a.r&&a.t<b.b&&b.t<a.b;
      for(const z of ['settingsBtn','zoomIn','zoomOut'])for(const o of ['ultBtn','drinkBtn','smashBtn','skillBtn'])assert.ok(!hit(right[z],right[o]),z+' overlaps '+o+' at '+width+'x'+height);
      assert.ok(!hit(right.drinkBtn,right.ultBtn)&&!hit(right.drinkBtn,right.skillBtn),'drink offer clear of ULTI and Skill');
      await page.evaluate(()=>{document.getElementById('ultBtn').hidden=true;document.getElementById('drinkBtn').hidden=true;});
      assert.equal(await page.locator('#emotes').evaluate(e=>e.parentElement.id),'emoteTray');
      if(process.env.SETTINGS_SCREENSHOT&&width===844)await page.screenshot({path:process.env.SETTINGS_SCREENSHOT});
      await page.click('#settingsClose');assert.equal(await page.locator('#settingsDlg').isVisible(),false);
      // World labels (names, bars, bubbles) pass under every HUD panel, not over it: a boss name used to cover the board.
      const under=await page.evaluate(()=>{const out={};for(const id of ['board','topLeft','joystick','smashBtn','skillBtn','mobileBottomControls','sideBtns','minimap']){const r=document.getElementById(id).getBoundingClientRect();if(!r.width)continue;
        const l=document.createElement('div');l.className='plabel';Object.assign(l.style,{position:'absolute',left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px',pointerEvents:'auto',background:'red'});
        document.getElementById('labels').appendChild(l);const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);out[id]=!!hit&&hit!==l;l.remove();}return out;});
      for(const [id,covered] of Object.entries(under))assert.ok(covered,'a world label covers #'+id+' at '+width+'x'+height);
      // Toasts share the top centre with the office/Prof. K notice: while the notice is up they sit below it.
      const stack=await page.evaluate(async()=>{const n=document.getElementById('officeNotice');n.textContent='Prof. K chuẩn bị đi tìm VKL nói chuyện phải trái. Ngon thì vô làm! · 2s';n.hidden=false;dispatchEvent(new Event('resize'));
        const t=document.createElement('div');t.className='toast';t.textContent='🛡️ Được bảo vệ 10 giây.';document.getElementById('toasts').appendChild(t);await new Promise(r=>requestAnimationFrame(()=>r()));
        const a=n.getBoundingClientRect(),b=t.getBoundingClientRect();n.hidden=true;dispatchEvent(new Event('resize'));await new Promise(r=>requestAnimationFrame(()=>r()));const back=t.getBoundingClientRect().top;t.remove();return {nb:a.bottom,tt:b.top,back};});
      assert.ok(stack.tt>=stack.nb,'toast under the notice at '+width+'x'+height+' '+JSON.stringify(stack));
      assert.ok(stack.back<stack.tt,'and back up when the notice goes');
      await page.click('#settingsBtn');await page.click('#helpBtn');
      assert.equal(await page.locator('#help').isVisible(),true);assert.match(await page.locator('#helpList').innerText(),/25–60 giây/);assert.equal(await page.locator('#settingsDlg').isVisible(),false);
      assert.deepEqual(errors,[]);ok(width+'x'+height+': existing actions work, gameplay controls remain outside settings, zoom stays stacked and uncovered, world labels pass under the HUD, toasts clear the notice');
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
