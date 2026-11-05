'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../server');
const { createMemoryStore } = require('../lib/store-memory');
async function main() {
  const real = process.env.CHAT_REAL_RENDERER === '1';
  const app = createApp({ store:createMemoryStore(),env:{},bossEnabled:false,moleEnabled:false,log:()=>{} });
  const port = await app.start(0);
  let browser;
  try {
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    const page=await browser.newPage({viewport:{width:956,height:440},isMobile:true,hasTouch:true});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{
      localStorage.setItem('br-gfx2','low');
      const Original=WebSocket;
      window.WebSocket=class extends Original{constructor(...args){super(...args);window.chatTestSocket=this;}};
    });
    if(!real)await page.route('**/scene3d.js',r=>r.fulfill({contentType:'application/javascript',body:`export function createScene3D(){return {resize(){},setQuality(){},update(){},build(){},zoom(){},cameraTo(){},zoomLimits(){return {}},fx:new Proxy({},{get:()=>()=>{}})}}`}));
    await page.goto(`http://127.0.0.1:${port}/?room=br-1`);
    await page.evaluate(()=>{for(const[k,v]of Object.entries({left:59,right:59,bottom:21}))document.documentElement.style.setProperty('--safe-'+k,v+'px')});
    await page.fill('#nameInput','Nick');await page.click('#joinBtn');
    await page.waitForFunction(()=>document.getElementById('overlay').classList.contains('gone'));
    await page.evaluate(()=>{
      const text=['Đi đập sếp không mọi người?','Tui đang ở phòng server nè.','Khoan, để tui hồi máu đã =))','Tủ server giờ giật tê cả người.','Để tui dụ sếp đi chỗ khác.','Ok, nhớ né cú đấm nha!','Có ai thấy TML ở đâu không?','TML vừa đi ngang pantry á.','Sếp đi tuần kìa!','Tui dụ sếp, ông phá server nha!'];
      const messages=text.map((text,i)=>({mid:crypto.randomUUID(),at:Date.now()-60000+i*1000,name:i%2?'tam Co':'Nick2',text}));
      chatTestSocket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({t:'chatHist',dir:'latest',messages,more:false})}));
    });
    // mmPlace() sizes the log on a 250 ms timer; measure the settled layout, not the CSS fallback.
    await page.waitForFunction(()=>document.getElementById('leftCol').style.getPropertyValue('--mobile-chat-height'));
    const buttons=await page.locator('button').count();
    await page.waitForFunction(()=>document.getElementById('chatLog').clientHeight>=100);
    const initial=await page.locator('#chatLog').boundingBox();
    assert.ok(initial.width>=300&&initial.height>=100,JSON.stringify(initial));
    await page.click('#chatLog');
    assert.deepEqual(await page.locator('#chatLog').boundingBox(),initial,'tapping the log does not expand or move it');
    assert.equal(await page.locator('#minimap').evaluate(e=>getComputedStyle(e).visibility),'visible');
    await page.evaluate(()=>document.getElementById('chatLog').scrollTop=0);
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#chatLog').evaluate(e=>e.scrollTop),0,'upkeep preserves native history scrolling');
    await page.click('#chatBtn');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'chatInput');
    assert.deepEqual(await page.locator('#chatLog').boundingBox(),initial,'chat button only opens the input');
    const longText='Tui đang dụ sếp ở ngoài hành lang, ông tranh thủ phá nốt tủ server rồi chạy ra nha, nhớ coi máu kẻo bị giật =))';
    await page.fill('#chatInput',longText);await page.press('#chatInput','Enter');
    await page.waitForFunction(text=>document.getElementById('chatLog').lastElementChild.textContent.includes(text),longText);
    const last=await page.locator('#chatLog .chatline').last().evaluate(e=>({text:e.textContent,height:e.getBoundingClientRect().height,whiteSpace:getComputedStyle(e).whiteSpace,overflow:getComputedStyle(e).textOverflow,font:getComputedStyle(e).fontSize}));
    assert.ok(last.text.includes(longText));assert.ok(last.height>=40,'long message must occupy multiple lines');
    assert.equal(last.whiteSpace,'normal');assert.notEqual(last.overflow,'ellipsis');assert.equal(last.font,'14px');
    assert.equal(await page.locator('#chatLog .chatline:visible').count(),11,'older messages stay in the same scrollable log');
    assert.deepEqual(await page.locator('#chatLog').boundingBox(),initial);
    assert.equal(await page.locator('button').count(),buttons);
    if(real)await page.screenshot({path:'work/chat-iphone-wrapped.png'});
    console.log('ok - fixed wide chat: long server-delivered message wraps fully, native scroll works, taps/input do not expand it or hide the map');
    if(!real)for(const[width,height]of[[844,390],[740,320]]){
      await page.setViewportSize({width,height});
      await page.waitForFunction(({width,height})=>GameViewport.width===width&&GameViewport.height===height,{width,height});
      await page.waitForFunction(()=>{const c=document.getElementById('chatLog').getBoundingClientRect(),m=document.getElementById('minimap').getBoundingClientRect(),j=document.getElementById('joystick').getBoundingClientRect();return c.top>=m.bottom+6&&c.bottom<=j.top-6});
      const r=await page.locator('#chatLog').boundingBox();assert.ok(r.width>=300&&r.height>=38);
      console.log(`ok - ${width}x${height}: chat remains readable without map/joystick overlap`);
    }
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await app.stop()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
