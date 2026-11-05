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
    for (const [width, height] of [[844,390],[740,320],[956,440],[844,390]]) {
      await page.setViewportSize({ width, height });
      await page.waitForFunction(({width,height}) => GameViewport.width===width && GameViewport.height===height, {width,height});
      await page.waitForFunction(() => {
        const m = document.getElementById('minimap').getBoundingClientRect(), c = document.getElementById('chatLog').getBoundingClientRect(), j = document.getElementById('joystick').getBoundingClientRect();
        return Math.abs(m.width / m.height - 1.6) < .03 && c.top >= m.bottom + 6 && c.bottom <= j.top - 6;
      });
      console.log(`ok - ${width}x${height}: map keeps its aspect ratio; chat clears map and joystick after join/resize`);
    }
    await page.keyboard.press('m');
    await page.waitForFunction(() => {
      const c = document.getElementById('chatLog').getBoundingClientRect();
      return document.getElementById('minimap').classList.contains('off') && c.height >= 100 && c.bottom <= document.getElementById('joystick').getBoundingClientRect().top - 6;
    });
    await page.keyboard.press('m');
    await page.waitForFunction(() => document.getElementById('chatLog').getBoundingClientRect().top >= document.getElementById('minimap').getBoundingClientRect().bottom + 6);
    console.log('ok - hiding/showing the map reclaims/restores space without covering chat');
    await page.tap('#minimap');
    assert.equal(await page.locator('#fullMap').isVisible(),true);
    await page.tap('#fullMapClose');
    assert.equal(await page.locator('#fullMap').isVisible(),false);
    await page.tap('#minimap'); await page.tap('#minimap');
    assert.equal(await page.locator('#fullMap').isVisible(),false);
    console.log('ok - touch opens the full room map and closes it through the same map or close button');
    await page.reload();
    await page.waitForFunction(() => document.getElementById('overlay').classList.contains('gone'));
    await page.waitForFunction(() => {
      const m = document.getElementById('minimap').getBoundingClientRect(), c = document.getElementById('chatLog').getBoundingClientRect();
      return Math.abs(m.width / m.height - 1.6) < .03 && c.top > m.bottom;
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
      try { mmDraw(); mmFull(true); return seen; }
      finally {proto.arc=original; S.boss=old; mmFull(false);}
    });
    assert.ok(!markers.includes('minimap') && markers.includes('fullMapCanvas'),'distant boss only appears on full map');
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
