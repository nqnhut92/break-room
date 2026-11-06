'use strict';
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {createApp}=require('../server');
async function main(){
  const app=createApp({bossEnabled:false,moleEnabled:false,log:()=>{}}),port=await app.start(0);
  let browser;
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined});
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const samples=[];page.on('request',r=>{if(r.url().includes('/assets/audio/'))samples.push(r.url())});
    await page.route('**/scene3d.js',r=>r.fulfill({contentType:'application/javascript',body:`export function createScene3D(){return {resize(){},setQuality(){},update(){},build(){},zoom(){},cameraTo(){},zoomLimits(){return {}},fx:new Proxy({},{get:()=>()=>{}})}}`}));
    await page.route('**/game.js',async r=>{
      const response=await r.fetch();
      await r.fulfill({response,body:(await response.text()).replace('  // -------------------------------------------------------------- effects','  window.audioProbe={audio,S,bossWind};\n  // -------------------------------------------------------------- effects')});
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    assert.equal(samples.length,0,'muted launch does not download sound');
    await page.fill('#nameInput','Audio check');await page.click('#joinBtn');
    await page.waitForFunction(()=>document.getElementById('overlay').classList.contains('gone'));
    assert.equal(samples.length,0,'joining while muted does not download sound');
    await page.click('#mute');await page.waitForFunction(()=>audioProbe.audio.ready===27);
    assert.equal(samples.length,27,'every PCM sample decodes in WebAudio');
    const wind=await page.evaluate(()=>{
      const {S,audio,bossWind}=audioProbe, old=S.boss, me=S.players.get(S.me);
      S.boss={x:me.x,y:me.y,dead:false};
      try {
        bossWind({x:me.x,y:me.y,r:100,ms:600,skill:'punch'});const normal=audio.activeVoices;
        bossWind({x:me.x,y:me.y,r:100,ms:600,skill:'newProcess'});return {normal,special:audio.activeVoices};
      } finally { S.boss=old; }
    });
    assert.equal(wind.normal,0,'ordinary wind-up is silent');assert.ok(wind.special>0,'special ability has a short distinct cue');
    await page.click('#mute');await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>audioProbe.audio.activeVoices),0,'mute stops existing voices');
    console.log('ok - gesture-only loading, 27 decoded WAVs, silent normal wind-up, special cue and immediate mute');
    const renders=await page.evaluate(async()=>{
      const {createGameAudio,distanceVolume}=await import('./audio.js');
      const Real=window.AudioContext, realFetch=window.fetch;const results={};
      try{
        for(const kind of ['desk','server','monitor','body','storm','muted','fallback','glassBreak','bossStrike']){
          const offline=new OfflineAudioContext(1,22050*2,22050);
          Object.defineProperty(offline,'state',{get:()=> 'running'});
          window.AudioContext=function(){return offline;};
          window.fetch=kind==='fallback'?async()=>new Response(null,{status:503}):realFetch;
          const audio=createGameAudio(()=>kind==='muted');await audio.init();
          if(kind==='storm')for(let i=0;i<100;i++)audio.break(1,'server');
          else if(kind==='glassBreak')audio.break(1,'monitor');
          else if(kind==='bossStrike')audio.strike(1);
          else audio.hit(1,kind,'hammer');
          const voices=audio.activeVoices,buffer=await offline.startRendering(),data=buffer.getChannelData(0);
          let peak=0,energy=0,tail=0,signature=0;for(let i=0;i<data.length;i++){peak=Math.max(peak,Math.abs(data[i]));energy+=data[i]*data[i];signature+=data[i]*(i%101);if(i>22050*.3)tail+=data[i]*data[i];}
          results[kind]={peak,energy,tail,signature,voices};
        }
        results.distance=[distanceVolume(0),distanceVolume(500),distanceVolume(1000),distanceVolume(3000)];
        return results;
      }finally{window.AudioContext=Real;window.fetch=realFetch;}
    });
    for(const key of ['desk','server','monitor','body','storm','fallback','glassBreak','bossStrike']){
      assert.ok(renders[key].energy>.001,`${key} renders a real signal`);
      assert.ok(renders[key].peak<1,`${key} avoids clipping: ${renders[key].peak}`);
      assert.ok(renders[key].voices<=24,'simultaneous voices stay bounded');
    }
    assert.ok(renders.glassBreak.tail>renders.glassBreak.energy*.1,'glass keeps an audible debris tail after 300ms');
    assert.notEqual(renders.bossStrike.signature,renders.body.signature,'boss slam has its own signal');
    assert.equal(renders.muted.energy,0);assert.deepEqual(renders.distance,[1,.25,0,0]);
    assert.equal(new Set(['desk','server','monitor','body'].map(k=>renders[k].signature)).size,4,'materials and body hits sound different');
    assert.deepEqual(errors,[]);
    console.log('ok - offline renders distinguish materials/body, mute is silent, distant audio vanishes and crowded combat is bounded without clipping');
  }finally{await browser?.close();await app.stop();}
}
main().catch(e=>{console.error(e);process.exitCode=1});
