'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
async function main() {
  let authenticated=false, configured=false, current=null, saves=0;
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/api/auth/status') return res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({enabled:configured,authenticated}));
    if(url.pathname==='/api/profile') {
      if(req.method==='GET') return res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({character:current}));
      let body='';for await(const c of req)body+=c;
      saves++;current={...JSON.parse(body),id:current?.id||'stable-test-id'};
      return res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({character:current}));
    }
    let file=url.pathname==='/'?'/index.html':url.pathname;
    if(!/^\/[a-zA-Z0-9_./-]+$/.test(file)||file.includes('..'))return res.writeHead(404).end();
    try {
      let content=fs.readFileSync(path.join(__dirname,'../public',file));
      if(file==='/index.html') content=content.toString().replace(/<script[^>]*src="game\.js"[^>]*><\/script>/,'');
      res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'}).end(content);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  let browser;
  try {
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,headless:true});
    for(const viewport of [{width:1280,height:900},{width:844,height:390}]) {
      const page=await browser.newPage({viewport});
      await page.goto(origin);
      await page.evaluate(async()=>{
        const {accountUI}=await import('/account.js');
        const role=document.getElementById('roleSelect');role.add(new Option('Dev','dev'));role.value='dev';
        window.account=accountUI({room:()=> 'br-1',read:()=>({name:document.getElementById('nameInput').value,gender:'f',role:'dev',company:document.getElementById('companyInput').value}),fill:p=>{document.getElementById('nameInput').value=p.name;document.getElementById('companyInput').value=p.company;}});
        await account.ready;
      });
      assert.equal(await page.locator('#googleLogin').isVisible(),false);
      assert.match(await page.locator('#accountNote').textContent(),/Chơi khách không bảo đảm/);
      assert.equal(saves,0);
      console.log('ok - '+viewport.width+'px guest-only mode has no Google entry point or automatic DB write');
      await page.close();
    }
    configured=true;authenticated=true;
    const page=await browser.newPage({viewport:{width:844,height:390},hasTouch:true,isMobile:true});await page.goto(origin);
    await page.evaluate(async()=>{
      const {accountUI}=await import('/account.js');
      window.account=accountUI({room:()=> 'br-1',read:()=>({name:document.getElementById('nameInput').value,gender:'f',role:'dev',company:document.getElementById('companyInput').value}),fill:p=>{document.getElementById('nameInput').value=p.name;document.getElementById('companyInput').value=p.company;}});await account.ready;
    });
    const joinBounds=await page.locator('#joinBtn').boundingBox();assert.ok(joinBounds.y>=0&&joinBounds.y+joinBounds.height<=390);
    const blocked=await page.evaluate(()=>account.beforeJoin().then(()=>false,()=>true));assert.ok(blocked);
    await page.locator('#nameInput').fill('UI Player');
    await page.locator('#characterSave').click();await page.waitForFunction(()=>document.getElementById('accountNote').textContent.includes('Đã lưu'));
    assert.equal(saves,1);assert.equal(current.name,'UI Player');
    const id=current.id;await page.locator('#nameInput').fill('UI Renamed');await page.locator('#characterSave').click();
    await page.waitForFunction(()=>document.getElementById('characterSave').disabled===false);
    assert.equal(current.name,'UI Renamed');assert.equal(current.id,id);
    await page.locator('#nameInput').fill('unsaved');await page.evaluate(()=>account.beforeJoin());assert.equal(await page.locator('#nameInput').inputValue(),'UI Renamed');
    assert.match(await page.locator('#accountNote').textContent(),/Điểm chưa được lưu lâu dài/);
    console.log('ok - mobile account form requires explicit create/save, preserves ID and restores saved data before joining');
    await page.close();
    console.log('All 3 account UI browser checks passed (mock profile endpoints).');
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
