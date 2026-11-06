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
    let page = await browser.newPage({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
    const errors = [];
    const prepare = async page => {
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/scene3d.js', r => r.fulfill({ contentType: 'application/javascript', body: `export function createScene3D(){return {resize(){},setQuality(){},update(){},build(){},zoom(){},cameraTo(){},zoomLimits(){return {}},fx:new Proxy({},{get:()=>()=>{}})}}` }));
    await page.route('**/game.js', r => {
      const source=require('fs').readFileSync(require('path').join(__dirname,'../public/game.js'),'utf8');
      return r.fulfill({contentType:'application/javascript',body:source.replace('  // On narrow screens', '  window.mapProbe={S,mm,mmDraw,mmFull,bossHit,bossBack};\n  // On narrow screens')});
    });
    };
    await prepare(page);
    await page.goto(`http://127.0.0.1:${port}/?room=br-1`);
    await page.fill('#nameInput', 'Map layout'); await page.click('#joinBtn');
    await page.waitForFunction(() => document.getElementById('overlay').classList.contains('gone'));
    for (const [width, height] of [[844,390],[740,320],[956,440],[1210,834],[1366,1024],[1133,744],[844,390]]) {
      await page.setViewportSize({ width, height });
      await page.waitForFunction(({width,height}) => GameViewport.width===width && GameViewport.height===height, {width,height});
      await page.waitForFunction(() => {
        const m=document.getElementById('minimap').getBoundingClientRect(), h=document.getElementById('topLeft').getBoundingClientRect();
        return Math.abs(m.width/m.height-1)<.03 && m.top>=h.bottom+7 && m.top<=h.bottom+9;
      });
      const map=await page.locator('#minimap').boundingBox(), joystick=await page.locator('#joystick').boundingBox();
      assert.ok(map.y+map.height+8<=joystick.y,'radar clears the joystick');
      if(width===1210)assert.ok(map.width>=180,'large iPad gets a readable radar');
      if(width===1366)assert.ok(map.width>=200&&map.width<=208,'larger tablets grow within the radar cap');
      if(height<=440)assert.ok(map.width<=110,'phone radar stays compact');
      await page.waitForFunction(()=>{const c=document.getElementById('mobileBottomControls').getBoundingClientRect(),j=document.getElementById('joystick').getBoundingClientRect(),s=document.getElementById('skillBtn').getBoundingClientRect();return c.left>=j.right+15&&c.right<=s.left-15;});
      const skill=await page.locator('#skillBtn').boundingBox(),attack=await page.locator('#smashBtn').boundingBox();
      assert.deepEqual([skill.width,skill.height],[attack.width,attack.height]);
      assert.equal(attack.x-skill.x-skill.width,24);
      await page.evaluate(()=>{document.getElementById('ultBtn').hidden=false;document.getElementById('drinkBtn').hidden=false;});
      assert.deepEqual(await page.locator('#skillBtn').boundingBox(),skill,'ULTI/drink offers do not move skill');
      assert.deepEqual(await page.locator('#smashBtn').boundingBox(),attack,'ULTI/drink offers do not move attack');
      await page.evaluate(()=>{document.getElementById('ultBtn').hidden=true;document.getElementById('drinkBtn').hidden=true;});
      console.log(`ok - ${width}x${height}: responsive radar clears header/joystick; skill matches attack with a 24px gap and chat stays clear`);
    }
    const dock=await page.locator('#chatDock').boundingBox();
    await page.keyboard.press('m');
    assert.equal(await page.locator('#minimap').evaluate(e=>e.classList.contains('off')),true);
    assert.deepEqual(await page.locator('#chatDock').boundingBox(),dock);
    await page.keyboard.press('m');
    console.log('ok - hiding/showing the map never moves the bottom chat dock');
    await page.tap('#minimap');
    assert.equal(await page.locator('#fullMap').isVisible(),true);
    await page.tap('#fullMapClose');
    assert.equal(await page.locator('#fullMap').isVisible(),false);
    await page.tap('#minimap'); await page.tap('#minimap');
    assert.equal(await page.locator('#fullMap').isVisible(),false);
    await page.tap('#minimap');
    const stick=await page.locator('#joystick').boundingBox();
    await page.touchscreen.tap(stick.x+stick.width/2,stick.y+stick.height/2);
    assert.equal(await page.locator('#fullMap').isVisible(),true,'using the joystick keeps the overview open');
    const panel=await page.locator('#fullMapCanvas').boundingBox();
    await page.touchscreen.tap(panel.x+panel.width/2,panel.y+panel.height/2);
    assert.equal(await page.locator('#fullMap').isVisible(),false,'tapping the overview closes it');
    await page.tap('#minimap');
    const vp=page.viewportSize();
    await page.touchscreen.tap(vp.width*0.5,Math.max(panel.y-30,vp.height*0.08));
    assert.equal(await page.locator('#fullMap').isVisible(),false,'tapping outside the overview closes it');
    console.log('ok - touch opens the full room map and closes it through the same map, the close button or a tap outside; the joystick keeps it open');
    await page.reload();
    await page.waitForFunction(() => document.getElementById('overlay').classList.contains('gone'));
    await page.waitForFunction(() => {
      const m = document.getElementById('minimap').getBoundingClientRect(), h = document.getElementById('topLeft').getBoundingClientRect();
      return Math.abs(m.width / m.height - 1) < .03 && m.top >= h.bottom+7;
    });
    await page.close();
    page = await browser.newPage({viewport:{width:1280,height:800}});
    await prepare(page);
    await page.goto(`http://127.0.0.1:${port}/?room=br-1`);
    await page.fill('#nameInput','Desktop map');await page.click('#joinBtn');
    await page.waitForFunction(()=>document.getElementById('overlay').classList.contains('gone'));
    await page.keyboard.down('w'); await page.keyboard.down('Tab');
    assert.equal(await page.locator('#fullMap').isVisible(),true);
    assert.equal(await page.evaluate(()=>mapProbe.S.keys.has('u')),true);
    await page.keyboard.up('Tab'); await page.keyboard.up('w');
    assert.equal(await page.locator('#fullMap').isVisible(),false);
    await page.keyboard.press('Enter'); await page.keyboard.down('Tab');
    assert.equal(await page.locator('#fullMap').isVisible(),false,'typing does not open the map');
    await page.keyboard.up('Tab'); await page.keyboard.press('Escape');
    await page.evaluate(()=>document.activeElement.blur());
    await page.keyboard.down('Tab');
    await page.evaluate(()=>dispatchEvent(new Event('blur')));
    assert.equal(await page.locator('#fullMap').isVisible(),false,'blur clears held map');
    await page.keyboard.up('Tab');
    const markers=await page.evaluate(()=>{
      const {S,mm,mmDraw,mmFull}=mapProbe, me=S.players.get(S.me), old=S.boss;
      S.boss={x:me.x+1500,y:me.y,dead:false};
      const proto=CanvasRenderingContext2D.prototype, original=proto.arc, seen=[];
      proto.arc=function(...args){if(this.fillStyle==='#ff3b2a')seen.push(this.canvas.id); return original.apply(this,args);};
      try { mmDraw(); const nearby=seen.includes('minimap'); seen.length=0; S.boss.x=me.x+2500; mmDraw(); mmFull(true); return {nearby,distant:seen}; }
      finally {proto.arc=original; S.boss=old; mmFull(false);}
    });
    assert.ok(markers.nearby,'the wider radar shows a boss 1,500 units away');
    assert.ok(!markers.distant.includes('minimap') && markers.distant.includes('fullMapCanvas'),'distant boss only appears on full map');
    const radar=await page.evaluate(()=>{
      const {mm,mmDraw,S}=mapProbe;
      mmDraw(); const cv=mm.cv, c=cv.getContext('2d'), r=cv.width/2;
      const alpha=(x,y)=>c.getImageData(Math.round(x),Math.round(y),1,1).data[3];
      const me=S.players.get(S.me), original=me.x;
      const center=alpha(r,r), middle=alpha(r*.5,r), edge=alpha(r*.02,r), corner=alpha(0,0);
      me.x+=200;mmDraw();const followed=alpha(r,r);me.x=original;
      return {center,middle,edge,corner,followed};
    });
    assert.ok(radar.center>240 && radar.middle>230 && radar.edge<100 && radar.corner===0 && radar.followed>240,JSON.stringify(radar));
    console.log('ok - radar keeps player centered, transparent corners and a clear center fading toward the circular edge');
    const health=await page.evaluate(()=>{
      const {S,bossHit,bossBack}=mapProbe, old=S.boss;
      S.boss={cfg:{maxHp:6000},hp:300,hpRev:1,pl:{}};
      bossHit({hp:3300,maxHp:9000,rev:3});bossHit({hp:290,maxHp:6000,rev:2});
      const grown=[S.boss.hp,S.boss.cfg.maxHp];
      bossBack({x:3300,y:1700,maxHp:6000,rev:4});
      const back=[S.boss.hp,S.boss.cfg.maxHp];S.boss=old;
      return {grown,back};
    });
    assert.deepEqual(health,{grown:[3300,9000],back:[6000,6000]});
    console.log('ok - hold Tab preserves walking; release/blur closes; typing is ignored; local map excludes distant bosses; stale HP cannot undo growth');
    assert.deepEqual(errors, []);
    console.log('ok - desktop input and mobile auto-rejoin map layout work without browser errors');
  } finally { await browser?.close(); await app.stop(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
