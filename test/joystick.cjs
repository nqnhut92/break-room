'use strict';

// Real touch/pointer input and game state; WebGL is stubbed to isolate controls.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createApp } = require('../server');

async function main() {
  const app = createApp({ bossEnabled:false, moleEnabled:false, log:()=>{} });
  const port = await app.start(0);
  let browser;
  try {
    browser = await chromium.launch({ executablePath:process.env.CHROMIUM_PATH || undefined, headless:true });
    const page = await browser.newPage({viewport:{width:844,height:390},hasTouch:true,isMobile:true});
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/game.js', route=>{
      const source=fs.readFileSync(path.join(__dirname,'../public/game.js'),'utf8');
      const marker='  requestAnimationFrame(frame);\n})();';assert.ok(source.includes(marker));
      return route.fulfill({contentType:'application/javascript',body:source.replace(marker,'  window.joystickCheck={S};\n'+marker)});
    });
    await page.route('**/scene3d.js',route=>route.fulfill({contentType:'application/javascript',body:`export function createScene3D(){return {resize(){},setQuality(){},update(){},build(){},zoom(){},zoomStep(){},cameraTo(){},zoomLimits(){return {atMin:false,atMax:false}},fx:new Proxy({},{get:()=>()=>{}})}}` }));
    await page.addInitScript(()=>{Element.prototype.requestFullscreen=()=>Promise.reject(new Error('unsupported'));if(screen.orientation)screen.orientation.lock=()=>Promise.reject(new Error('unsupported'));});
    await page.goto(`http://localhost:${port}/?room=br-1`);
    await page.fill('#nameInput','Joystick check');await page.click('#joinBtn');
    await page.waitForFunction(()=>window.joystickCheck?.S.joined);
    const cdp=await page.context().newCDPSession(page);
    const points=await page.evaluate(()=>{
      const j=document.getElementById('joystick').getBoundingClientRect(),s=document.getElementById('smashBtn').getBoundingClientRect();
      return {x:j.x+j.width/2,y:j.y+j.height/2,r:j.width*0.3,smashX:s.x+s.width/2,smashY:s.y+s.height/2};
    });
    const state=()=>page.evaluate(()=>({...joystickCheck.S.joystick,active:document.getElementById('joystick').classList.contains('active')}));
    const touch=async(type,touchPoints=[])=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints});
    const right={id:1,x:points.x+points.r*0.8,y:points.y};
    const start=()=>touch('touchStart',[right]);
    const end=()=>touch('touchEnd');
    let passed=0;
    const ok=name=>{passed++;console.log('ok - '+name);};
    const neutral=async()=>{await page.waitForFunction(()=>joystickCheck.S.joystick.pointerId===null);const j=await state();assert.equal(j.x,0);assert.equal(j.y,0);assert.equal(j.active,false);};
    await start();let j=await state();assert.ok(j.x>0.5);assert.equal(j.pointerType,'touch');
    await touch('touchMove',[{...right,x:points.x,y:points.y-points.r*0.8}]);j=await state();assert.ok(j.y< -0.5);assert.ok(Math.abs(j.x)<0.1);
    ok('native touch drag changes direction without sticking');
    await page.waitForTimeout(450);assert.ok((await state()).y< -0.5);
    ok('a stationary held thumb remains active without a movement timeout');
    const held={...right,x:points.x,y:points.y-points.r*0.8},smash={id:2,x:points.smashX,y:points.smashY};
    await touch('touchStart',[held,smash]);
    assert.equal(await page.evaluate(()=>joystickCheck.S.smashHeld),true);const owner=(await state()).pointerId;
    await touch('touchStart',[held,smash,{id:3,x:points.x-points.r*0.8,y:points.y}]);
    assert.equal((await state()).pointerId,owner);assert.ok((await state()).y< -0.5);
    ok('a secondary thumb on the pad cannot steal a live joystick capture');
    await page.evaluate(id=>window.dispatchEvent(new PointerEvent('pointerup',{pointerId:id+1000,pointerType:'touch'})),owner);
    await page.evaluate(()=>{const target=document.getElementById('joystick');window.dispatchEvent(new TouchEvent('touchend',{touches:[new Touch({identifier:1,target})]}));});
    assert.equal((await state()).pointerId,owner);await end();await neutral();
    ok('another finger can hold smash and end without resetting the joystick owner');
    for(const type of ['pointerup','pointercancel']){
      await start();const id=(await state()).pointerId;
      await page.evaluate(({type,id})=>window.dispatchEvent(new PointerEvent(type,{pointerId:id,pointerType:'touch'})),{type,id});
      await neutral();await end();ok(type+' delivered outside the joystick clears its vector');
    }
    for(const type of ['touchend','touchcancel']){
      await start();
      await page.evaluate(type=>{const target=document.getElementById('smashBtn');window.dispatchEvent(new TouchEvent(type,{touches:[new Touch({identifier:2,target})]}));},type);
      await neutral();await end();ok(type+' recovers a missed pointer terminal event while another control is touched');
    }
    await start();const owned=(await state()).pointerId;
    await page.evaluate(id=>document.getElementById('joystick').dispatchEvent(new PointerEvent('lostpointercapture',{pointerId:id,pointerType:'touch'})),owned);
    assert.equal((await state()).pointerId,owned);assert.ok((await state()).x>0.5);
    ok('a delayed lost-capture notification cannot clear a currently captured gesture');
    await page.evaluate(id=>document.getElementById('joystick').releasePointerCapture(id),owned);
    await neutral();await end();ok('actual capture loss releases the joystick');
    await page.evaluate(()=>Object.assign(joystickCheck.S.joystick,{pointerId:999999,pointerType:'touch',x:1,y:0}));
    await neutral();await start();assert.ok((await state()).x>0.5);await end();await neutral();
    ok('an uncaptured stale id is neutralized and the next touch works without chat');
    await page.evaluate(()=>{const el=document.getElementById('joystick');el.savedHasCapture=el.hasPointerCapture;el.hasPointerCapture=function(id){return id===999999 || this.savedHasCapture(id)};Object.assign(joystickCheck.S.joystick,{pointerId:999999,pointerType:'touch',x:1,y:0});});
    await start();assert.notEqual((await state()).pointerId,999999);assert.ok((await state()).x>0.5);
    await page.evaluate(()=>{const el=document.getElementById('joystick');el.hasPointerCapture=el.savedHasCapture;delete el.savedHasCapture;});
    await end();await neutral();ok('a fresh primary gesture can reclaim stale ownership even if capture is reported active');

    await page.evaluate(()=>{const j=document.getElementById('joystick');j.savedCapture=j.setPointerCapture;j.setPointerCapture=()=>{throw new DOMException('native capture unavailable','NotFoundError')};});
    await start();await neutral();await end();
    await page.evaluate(()=>{const j=document.getElementById('joystick');j.setPointerCapture=j.savedCapture;delete j.savedCapture;});
    await start();assert.ok((await state()).x>0.5);await end();await neutral();
    ok('capture failure leaves no poisoned pointer id and a later gesture can start');
    await start();
    await page.evaluate(()=>{const j=document.getElementById('joystick');j.savedRelease=j.releasePointerCapture;j.releasePointerCapture=()=>{throw new DOMException('pointer ended','NotFoundError')};window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:joystickCheck.S.joystick.pointerId,pointerType:'touch'}));});
    await neutral();
    await page.evaluate(()=>{const j=document.getElementById('joystick');j.releasePointerCapture=j.savedRelease;delete j.savedRelease;});await end();
    ok('a release-capture exception cannot prevent returning to neutral');
    await start();await page.evaluate(()=>document.getElementById('chatBtn').click());await neutral();
    await page.evaluate(()=>document.getElementById('chatInput').blur());await end();
    for(let i=0;i<8;i++){await start();assert.ok((await state()).x>0.5);await end();await neutral();}
    ok('chat focus still resets controls and repeated fresh gestures remain responsive');
    // A second finger reaches the action buttons while the thumb holds the joystick; each tap acts exactly once.
    for(const id of ['skillBtn','zoomIn']){
      const at=await page.evaluate(id=>{const el=document.getElementById(id),r=el.getBoundingClientRect();window.tapCount=0;el.addEventListener('click',()=>window.tapCount++);return {x:r.x+r.width/2,y:r.y+r.height/2};},id);
      const skillBefore=await page.evaluate(()=>joystickCheck.S.skill);
      await start();
      await touch('touchStart',[right,{id:4,...at}]);
      await touch('touchEnd',[{id:4,...at}]); // CDP lists the point that ends: the button finger lifts, the thumb stays on the pad
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(()=>window.tapCount),1,id+' acted once');
      assert.ok((await state()).x>0.5,'the joystick kept moving');
      if(id==='skillBtn')assert.notEqual(await page.evaluate(()=>joystickCheck.S.skill),skillBefore);
      await end();await neutral();
    }
    ok('action buttons answer a second finger while the joystick is held, once per tap');
    await page.evaluate(()=>{window.tapCount=0;document.getElementById('zoomOut').addEventListener('click',()=>window.tapCount++);});
    await page.tap('#zoomOut');await page.waitForTimeout(400);
    assert.equal(await page.evaluate(()=>window.tapCount),1,'a plain tap (with the browser\'s own click) acts once');
    ok('a plain single-finger tap still acts exactly once');
    assert.deepEqual(errors,[]);ok('no browser page errors');
    console.log(`All ${passed} joystick browser checks passed. Missing-event cases are fault injection, not proof of a specific Safari bug.`);
  } finally {if(browser)await browser.close();await app.stop();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
