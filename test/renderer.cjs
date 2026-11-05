'use strict';

// Real WebGL resource/lifecycle checks, separate from the server test suite.
// npx playwright install chromium; npm run test:renderer
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createApp } = require('../server');
const W = require('../lib/world');

async function main() {
  const app = createApp({ bossEnabled: false, moleEnabled: false, log: () => {} });
  const port = await app.start(0);
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const touch = process.env.RENDERER_TOUCH !== '0';
    const page = await browser.newPage({ viewport: { width: 956, height: 440 }, deviceScaleFactor: 3, isMobile: touch, hasTouch: touch });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/scene3d.js', route => {
      const source = fs.readFileSync(path.join(__dirname, '../public/scene3d.js'), 'utf8');
      const marker = 'renderer, build, update, pick, resize, setQuality,';
      assert.ok(source.includes(marker), 'private diagnostic export marker still exists');
      return route.fulfill({ contentType: 'application/javascript', body: source.replace(marker, 'debug: { scene, players, miniRigs, sun, bodyMat, pickMat }, ' + marker) });
    });
    await page.route('**/renderer-check', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>body{margin:0}canvas{display:block}</style><canvas></canvas><div id="labels"></div><script type="importmap">{"imports":{"three":"/vendor/three.module.min.js"}}</script><script type="module">
      import {createScene3D} from '/scene3d.js';
      const data=${JSON.stringify({ world: W.WORLD, props: W.PROPS, zones: W.ZONES, objects: W.OBJECTS, types: W.TYPES })};
      const app=createScene3D(document.querySelector('canvas'),document.querySelector('#labels'));
      app.setQuality('low'); app.resize(innerWidth,innerHeight); await app.ready; app.build(data.world,data.props,data.zones);
      const player=id=>({id,name:'Check '+id,gender:'m',role:'dev',company:'',hue:35,x:1920+(id%5)*45,y:1950,heading:0,swing:0,hpFrac:1,moving:false,emoteT:0,chatT:0});
      const S={me:1,players:new Map([[1,player(1)]]),minis:new Map(),snakes:new Map(),types:data.types,shake:0,
        objects:data.objects.map(o=>({...o,hp:data.types[o.type].hp,hpMax:data.types[o.type].hp,broken:false,shake:0,flash:0,pop:0}))};
      app.renderer.info.autoReset=false;
      const frame=()=>{app.renderer.info.reset();app.update(1/60,S)};
      window.probe={app,S,player,frame};frame();window.ready=true;
    </script>` }));
    await page.goto(`http://localhost:${port}/renderer-check`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.ready, null, { timeout: 180000 });
    // Let the transparent shader warmup complete before resource-baseline checks.
    await page.waitForTimeout(200);
    const result = await page.evaluate(() => {
      const { app, S, player, frame } = probe;
      const checks = [], metrics = {};
      const check = (ok, name) => { if(!ok) throw new Error(name); checks.push(name); };
      frame(); frame();
      check(!app.renderer.shadowMap.enabled && !app.debug.sun.castShadow && !app.debug.sun.shadow.map, 'safe mode has no real-time shadow target');
      check(app.debug.players.get(1).g.children.some(o => o.isMesh && o.geometry.type === 'CircleGeometry' && o.visible), 'safe mode retains the player ground shadow');
      metrics.safe = { calls: app.renderer.info.render.calls, triangles: app.renderer.info.render.triangles };
      app.setQuality('high'); frame();
      check(app.renderer.shadowMap.enabled && app.debug.sun.castShadow && !!app.debug.sun.shadow.map, 'high mode restores live shadows');
      check(app.debug.sun.shadow.mapSize.x === (matchMedia('(pointer: coarse)').matches ? 1024 : 2048), 'high mode uses the device-appropriate shadow resolution');
      metrics.high = { calls: app.renderer.info.render.calls, triangles: app.renderer.info.render.triangles };
      check(metrics.high.calls > metrics.safe.calls && metrics.high.triangles > metrics.safe.triangles, 'safe mode removes measured shadow draw work');
      const target = app.debug.sun.shadow.map; let targetDisposals=0;
      target.addEventListener('dispose',()=>targetDisposals++);
      app.setQuality('low'); frame();
      check(targetDisposals===1 && app.debug.sun.shadow.map===null, 'switching to safe mode releases the shadow target once');
      const textures = app.renderer.info.memory.textures;
      for(let i=0;i<4;i++){ app.setQuality('high');frame();app.setQuality('low');frame(); }
      check(app.renderer.info.memory.textures===textures, 'repeated quality switches do not retain shadow textures');
      let sharedDisposals=0;
      for(const m of [app.debug.bodyMat,app.debug.pickMat]) m.addEventListener('dispose',()=>sharedDisposals++);
      S.players.set(2,{...player(2),electricUntil:performance.now()+10000}); frame();
      app.pick(478,220); // Creates the remote player's private pick proxy.
      const rig=app.debug.players.get(2), geometryEvents=new Map(), materialEvents=new Map();
      rig.g.traverse(o=>{ if(o.geometry && !geometryEvents.has(o.geometry)){geometryEvents.set(o.geometry,0);o.geometry.addEventListener('dispose',()=>geometryEvents.set(o.geometry,geometryEvents.get(o.geometry)+1));} });
      for(const m of [...rig.ownedMaterials,rig.electricFx.outline.material,rig.electricFx.arcs.material]){
        if(!materialEvents.has(m)){materialEvents.set(m,0);m.addEventListener('dispose',()=>materialEvents.set(m,materialEvents.get(m)+1));}
      }
      check(!!rig.pickProxy && !!rig.electricFx, 'cleanup case includes accessory, pick proxy and electric effects');
      S.players.delete(2);frame();
      check([...geometryEvents.values()].every(n=>n===1), 'every player-owned geometry is disposed exactly once');
      check([...materialEvents.values()].every(n=>n===1), 'private ground/ring/electric materials are disposed exactly once');
      check(sharedDisposals===0, 'body and picking materials remain shared and live');
      const baseline=app.renderer.info.memory.geometries, counts=[];
      for(let i=0;i<8;i++){S.players.set(2,player(2));frame();S.players.delete(2);frame();counts.push(app.renderer.info.memory.geometries);}
      check(counts.every(n=>n===baseline), 'eight join/leave cycles plateau at the original resource count');
      const mini={...player(-10),mini:'TML',x:2000,y:1850};
      S.minis.set('TML',{x:2000,y:1850,hp:900,mode:'idle',pl:mini});frame();
      check(app.debug.miniRigs.has('TML'), 'mini-boss uses the same owned-resource lifecycle');
      S.minis.set('DMM',{x:2050,y:1850,hp:600,mode:'idle',pl:{...player(-11),mini:'DMM'}});frame();
      const mottos=[...document.querySelectorAll('.boss-motto')].map(el=>el.textContent);
      check(matchMedia('(pointer: coarse)').matches ? mottos.length===0 : mottos.includes('Tranh công, chối tội, đổ lỗi, thanh minh') && mottos.includes('Thiên hạ đệ nhất thái giám'), 'mini-boss mottos appear on desktop only');

      S.minis.clear();frame();
      check(app.renderer.info.memory.geometries===baseline, 'removed mini-boss releases its rig and telegraph geometry');
      S.players.set(2,player(2));frame();
      check(app.debug.players.get(2).g.visible && sharedDisposals===0, 'a player can rejoin after cleanup without disposed shared materials');
      S.players.delete(2);frame();
      check(app.renderer.getContext().getError()===app.renderer.getContext().NO_ERROR, 'quality changes and cleanup leave no WebGL error');
      metrics.lifecycle={baseline,counts,after:app.renderer.info.memory.geometries};
      const me=S.players.get(S.me), home={x:me.x,y:me.y};
      let motionErrors=0;
      for(const quality of ['low','high']) {
        app.setQuality(quality);
        for(let i=0;i<16;i++) {
          me.x=1920;me.y=1380+i*10;me.moving=true;app.cameraTo(me.x,me.y);frame();
          if(app.renderer.getContext().getError()!==app.renderer.getContext().NO_ERROR)motionErrors++;
        }
      }
      Object.assign(me,home,{moving:false});app.cameraTo(me.x,me.y);app.setQuality('low');frame();
      check(motionErrors===0,'camera movement across the former floor-overlap strip works in safe and high modes without WebGL errors');
      S.boss={x:1920,y:1950,dead:false,mode:'patrol',pl:{...player(-1),gender:'boss',role:'boss',name:'VKL'}};frame();
      const mainMotto=[...document.querySelectorAll('.boss-motto')].find(el=>el.textContent==='Mọi người nghĩ dì dẫy?');
      check(matchMedia('(pointer: coarse)').matches ? !mainMotto : !!mainMotto, 'VKL motto appears below its name on desktop only');
      S.boss.pl.alwaysHp=true;S.boss.pl.hpLabel='6.000 / 6.000';
      for(const [id,x,hp] of [['TML',1600,900],['DMM',2240,600]]) {
        S.minis.set(id,{x,y:1950,hp,mode:'idle',pl:{...player(id==='TML'?-10:-11),name:id,role:'',mini:id,x,y:1950,alwaysHp:true,hpLabel:hp+' / '+hp}});
      }
      frame();
      check([...document.querySelectorAll('.boss-motto')].every(el=>el.previousElementSibling.classList.contains('nm') && el.getBoundingClientRect().top>=el.previousElementSibling.getBoundingClientRect().bottom), 'desktop mottos sit directly below names without covering them');
      return {checks,metrics};
    });
    assert.deepStrictEqual(errors, [], 'no browser page errors');
    for (const check of result.checks) console.log('ok - ' + check);
    console.log(JSON.stringify(result.metrics));
    console.log(`All ${result.checks.length + 1} renderer checks passed (including zero page errors). Software WebGL; not an iPhone FPS measurement.`);
    if (process.env.RENDERER_SCREENSHOT) await page.screenshot({ path: process.env.RENDERER_SCREENSHOT });
  } finally {
    if (browser) await browser.close();
    await app.stop();
  }
}
main().catch(e => { console.error(e); process.exitCode=1; });
