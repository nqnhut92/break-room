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
    const buttons=await page.locator('button').count();
    await page.waitForFunction(()=>document.getElementById('chatDock').classList.contains('expanded'));
    const initial=await page.locator('#chatLog').boundingBox();
    const anchors=async()=>Promise.all(['skillBtn','chatBtn','emoteBtn','chatDock'].map(id=>page.locator('#'+id).boundingBox()));
    const anchored=await anchors();
    assert.ok(initial.width>=200&&initial.height===104,JSON.stringify(initial));
    const dock=await page.locator('#chatDock').boundingBox();
    assert.equal(initial.y+initial.height,dock.y+dock.height,'history grows upward from the compact dock');
    await page.evaluate(()=>document.getElementById('chatLog').scrollTop=0);
    await page.locator('#chatLog').dispatchEvent('wheel');
    await page.waitForTimeout(8200);
    assert.equal(await page.locator('#chatLog').evaluate(e=>e.scrollTop),0,'history reading preserves scroll');
    assert.equal(await page.locator('#chatLog').isVisible(),true,'history stays expanded while reading older lines');
    await page.evaluate(()=>{const log=document.getElementById('chatLog');log.scrollTop=log.scrollHeight;});
    await page.locator('#chatLog').dispatchEvent('wheel');
    await page.waitForTimeout(8200);
    assert.equal(await page.locator('#chatLog').isVisible(),false,'eight seconds idle collapses history');
    assert.equal(await page.locator('#chatPreview').isVisible(),true,'compact preview stays visible');
    assert.deepEqual(await anchors(),anchored,'collapsing does not move any tap target');
    await page.click('#chatPreview');
    assert.equal(await page.locator('#chatLog').isVisible(),true);
    await page.click('#chatBtn');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'chatInput');
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
    console.log('ok - bottom chat expands to four lines, collapses after eight seconds, keeps history/anchors and wraps server-delivered text');
    if(!real)for(const[width,height]of[[844,390],[740,320]]){
      await page.setViewportSize({width,height});
      await page.waitForFunction(({width,height})=>GameViewport.width===width&&GameViewport.height===height,{width,height});
      const c=await page.locator('#chatLog').boundingBox(), j=await page.locator('#joystick').boundingBox(), attack=await page.locator('#smashBtn').boundingBox();
      assert.ok(c.x>=j.x+j.width && c.x+c.width<=attack.x,'chat clears both thumbs');
      assert.equal(c.height,104);
      console.log(`ok - ${width}x${height}: bottom chat remains between joystick and attack`);
    }
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await app.stop()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
