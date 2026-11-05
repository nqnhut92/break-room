'use strict';

// Rebuild README's panorama and the annotated layout from the current world/renderer.
// The overview camera override exists only in this capture route, not in the game.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../server');
const W = require('../lib/world');
async function main() {
  const app = createApp({ bossEnabled: false, moleEnabled: false, log: () => {} });
  let browser;
  try {
    const port = await app.start(0);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/scene3d.js', r => {
      const source = fs.readFileSync(path.join(__dirname,'../public/scene3d.js'),'utf8');
      return r.fulfill({contentType:'application/javascript',body:source
        .replace('new THREE.PerspectiveCamera(42, 1, 20, 7000)', `new THREE.PerspectiveCamera(42, 1, 20, ${Math.round(7000 * W.LAYOUT_SCALE)})`)
        .replace('const ZOOM_MAX = 2300;', `const ZOOM_MAX = ${Math.round(6000 * W.LAYOUT_SCALE)};`)
        .replace('const ZOOM_START = coarse ? 900 : 1300;', `const ZOOM_START = ${Math.round(5300 * W.LAYOUT_SCALE)};`)});
    });
    const data = JSON.stringify({world:W.WORLD,props:W.PROPS,zones:W.ZONES,objects:W.OBJECTS,types:W.TYPES,rooms:W.FLOOR_ROOMS});
    await page.route('**/office-overview', r => r.fulfill({contentType:'text/html',body:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#0d1017}canvas{display:block;width:100vw;height:100vh}#labels{display:none}</style><canvas id="view"></canvas><div id="labels"></div><script type="importmap">{"imports":{"three":"/vendor/three.module.min.js"}}</script><script type="module">
      import {createScene3D} from '/scene3d.js';
      const data=${data};
      const scene=createScene3D(document.getElementById('view'),document.getElementById('labels'));
      scene.resize(innerWidth,innerHeight);scene.setQuality('high');await scene.ready;
      scene.build(data.world,data.props,data.zones);scene.cameraTo(data.world.w/2,data.world.h/2);
      const S={me:1,players:new Map(),minis:new Map(),snakes:new Map(),types:data.types,shake:0,
        objects:data.objects.map(o=>({...o,hp:data.types[o.type].hp,hpMax:data.types[o.type].hp,broken:false,shake:0,flash:0,pop:0}))};
      window.captureData=data;
      function frame(){scene.update(1/60,S);requestAnimationFrame(frame)}frame();window.captureReady=true;
    </script>`}));
    await page.goto(`http://127.0.0.1:${port}/office-overview`);
    await page.waitForFunction(()=>window.captureReady,null,{timeout:180000});
    await page.waitForTimeout(1000);
    assert.deepEqual(errors,[]);
    const out=path.join(__dirname,'../artifacts');fs.mkdirSync(out,{recursive:true});
    await page.screenshot({path:path.join(out,'map-ingame.png')});
    // A matching plan with metadata labels, for the linked editing guide.
    await page.evaluate(()=>{
      const {world,props,zones,objects,types,rooms}=captureData;
      const cv=document.createElement('canvas');cv.width=1600;cv.height=1000;
      const c=cv.getContext('2d'),k=cv.width/world.w;
      c.fillStyle='#252d3f';c.fillRect(0,0,cv.width,cv.height);
      for(const z of zones){c.fillStyle=z.k==='metal'?'#505a6b':z.k==='wood'?'#6e5538':'#6d7f94';c.fillRect(z.x0*k,z.y0*k,(z.x1-z.x0)*k,(z.y1-z.y0)*k)}
      for(const p of props){if(p.k==='rug')continue;c.fillStyle=p.k==='wall'?'#b9d9eb':'#d9d2c5';c.fillRect((p.x-p.w/2)*k,(p.y-p.h/2)*k,p.w*k,p.h*k)}
      for(const o of objects){const t=types[o.type];c.save();c.translate(o.x*k,o.y*k);c.rotate(-(o.rot||0));c.fillStyle=o.type==='server'?'#a2b4cd':'#bca27e';c.fillRect(-t.w*k/2,-t.h*k/2,t.w*k,t.h*k);c.restore()}
      c.font='bold 15px system-ui';c.textAlign='center';c.lineWidth=4;c.strokeStyle='#18202b';c.fillStyle='#fff';
      for(const r of rooms){const x=(r.x0+r.x1)*k/2,y=(r.y0+40)*k;c.strokeText(r.name,x,y);c.fillText(r.name,x,y)}
      c.fillStyle='#ffd34d';c.beginPath();c.arc(world.spawn.x*k,world.spawn.y*k,6,0,Math.PI*2);c.fill();
      document.querySelectorAll('canvas').forEach(el=>el.remove());document.body.appendChild(cv);
    });
    await page.locator('canvas').screenshot({path:path.join(out,'map-overview.png')});
    console.log('Captured artifacts/map-ingame.png and artifacts/map-overview.png from the current world.');
  } finally {await browser?.close();await app.stop();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
