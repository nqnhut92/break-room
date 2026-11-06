'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
async function main() {
  let authenticated=false, saves=0, holdMutation=null;
  const characters=new Map();
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    const json=data=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(data));
    if(url.pathname==='/api/auth/status')return json({enabled:true,authenticated});
    if(url.pathname==='/api/auth/csrf')return json({csrfToken:'test-csrf'});
    if(url.pathname==='/api/auth/signin/google')return res.writeHead(200).end('Mock provider');
    if(url.pathname==='/api/profile') {
      const room=url.searchParams.get('room');
      if(req.method==='GET')return json({character:characters.get(room)||null});
      let body='';for await(const c of req)body+=c;
      if(holdMutation) await holdMutation;
      saves++;const current={...JSON.parse(body),id:characters.get(room)?.id||'test-'+room};characters.set(room,current);
      return json({character:current});
    }
    const file=url.pathname==='/'?'/index.html':url.pathname;
    if(!/^\/[a-zA-Z0-9_./-]+$/.test(file)||file.includes('..'))return res.writeHead(404).end();
    try {
      let content=fs.readFileSync(path.join(__dirname,'../public',file));
      if(file==='/index.html')content=content.toString().replace(/<script[^>]*src="game\.js"[^>]*><\/script>/,'');
      res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html'}).end(content);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  let browser;
  // The game ships with the server picker hidden, already in index.html (SHOW_SERVER_PICKER in game.js only shows it);
  // `picker` shows it to test switching.
  async function setup(page, picker = false) {
    await page.goto(origin);
    await page.evaluate(async(picker)=>{
      if(picker){document.getElementById('roomPick').hidden=false;document.getElementById('joinForm').classList.remove('no-server-pick');}
      const {accountUI}=await import('/account.js');
      const $=id=>document.getElementById(id);
      const role=$('roleSelect');role.add(new Option('Dev','dev'));role.value='dev';
      $('nameInput').value='Nick';
      const sync=()=>{$('joinBtn').disabled=$('joinBtn').dataset.accountBusy==='true'||!$('nameInput').value.trim();};
      $('nameInput').addEventListener('input',sync);
      window.testRoom='br-1';window.entered=0;
      const box=$('roomList');box.textContent='';
      for(const [room,label] of [['br-1','BR-1'],['br-2','BR-2']]){
        const b=document.createElement('button');b.type='button';b.className='roomcard'+(room==='br-1'?' on':'');
        const name=document.createElement('span');name.className='rn';name.textContent=label;
        const count=document.createElement('span');count.className='rc cool';count.textContent='0 online';
        b.append(name,count);b.setAttribute('aria-label',label+' · 0 online');
        b.onclick=()=>{window.testRoom=room;account.roomChanged();};box.append(b);
      }
      window.account=accountUI({room:()=>window.testRoom,read:()=>({name:$('nameInput').value,gender:document.querySelector('input[name="gender"]:checked').value,role:$('roleSelect').value,company:$('companyInput').value}),fill:p=>{$('nameInput').value=p.name;$('companyInput').value=p.company;$('roleSelect').value=p.role;for(const radio of document.querySelectorAll('input[name="gender"]'))radio.checked=radio.value===p.gender;}});
      $('joinForm').addEventListener('submit',async e=>{e.preventDefault();try{await account.beforeJoin();window.entered++;}catch(err){$('joinErr').textContent=err.message;}});
      await account.ready;sync();
    },picker);
  }
  try {
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,headless:true});
    // Slow network: before game.js has run, the hidden server picker must not flash its skeleton rows.
    for(const viewport of [{width:1366,height:768},{width:844,height:390,touch:true}]){
      const page=await browser.newPage({viewport:{width:viewport.width,height:viewport.height},hasTouch:!!viewport.touch,isMobile:!!viewport.touch});
      await page.route('**/game.js*',route=>route.abort());
      await page.goto(origin);
      assert.equal(await page.locator('#roomPick').isVisible(),false,'no picker before the script');
      assert.equal(await page.locator('.roomskel').first().isVisible(),false,'no skeleton rows before the script');
      assert.ok(await page.locator('#joinForm').evaluate(e=>e.classList.contains('no-server-pick')),'the picker-less layout from the first paint');
      await page.close();
    }
    console.log('ok - the hidden server picker shows no skeleton rows before game.js runs');
    for(const viewport of [{width:1366,height:768},{width:1280,height:720},{width:844,height:390,touch:true},{width:740,height:320,touch:true}]) {
      const page=await browser.newPage({viewport:{width:viewport.width,height:viewport.height},hasTouch:!!viewport.touch,isMobile:!!viewport.touch});
      await setup(page);
      const form=await page.locator('#joinForm').boundingBox(),button=await page.locator('#joinBtn').boundingBox();
      assert.ok(form.x>=0&&form.x+form.width<=viewport.width);
      assert.ok(button.y>=0&&button.y+button.height<=viewport.height,'primary action stays within viewport '+JSON.stringify([viewport,button]));
      // Picker hidden: the fields take the full width and the join button sits beside the score note.
      const fields=await page.locator('.joinFields').boundingBox(),note=await page.locator('#scoreNote').boundingBox();
      assert.ok(fields.width>form.width*0.8,'profile fields use the full width');
      assert.ok(note.x+note.width<=button.x,'score note and join button share a row');
      assert.ok(await page.locator('#googleLogin .google-mark').isVisible());
      assert.equal(await page.locator('#googleLogin').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
      assert.match(await page.locator('#accountNote').textContent(),/Chơi không đăng nhập không bảo đảm/);
      assert.equal(saves,0);
      assert.equal(await page.locator('#roomList .rc').first().evaluate(e=>getComputedStyle(e).color),'rgb(61, 220, 132)');
      assert.equal(await page.locator('#roomList .rc').first().evaluate(e=>getComputedStyle(e,'::before').backgroundColor),'rgb(61, 220, 132)');
      for (const [level,color] of [['warm','rgb(255, 176, 46)'],['hot','rgb(255, 93, 74)']]) {
        const actual=await page.locator('#roomList .rc').first().evaluate((e,level)=>{e.className='rc '+level;const c=getComputedStyle(e).color;e.className='rc cool';return c;},level);assert.equal(actual,color);
      }
      await page.screenshot({path:'/tmp/br-join-'+viewport.width+'.png'});
      console.log('ok - '+viewport.width+'x'+viewport.height+': full-width fields without the server picker, recognizable Google button and visible primary action');
      if(viewport.width===1366){
        const navigation=page.waitForRequest(r=>r.url().endsWith('/api/auth/signin/google'));
        await page.locator('#googleLogin').click();const request=await navigation;
        assert.equal(new URLSearchParams(request.postData()).get('csrfToken'),'test-csrf');
      }
      await page.close();
    }
    authenticated=true;
    const page=await browser.newPage({viewport:{width:1280,height:720}});await setup(page,true);
    assert.equal(saves,0,'login does not create or join automatically');
    assert.equal(await page.locator('#joinBtn').textContent(),'Tạo nhân vật & vào văn phòng');
    assert.equal(await page.locator('#characterSave').isVisible(),false);
    assert.equal(await page.locator('#characterRestore').isVisible(),false);
    await page.screenshot({path:'/tmp/br-join-account-new.png'});
    await page.locator('#nameInput').fill('UI Player');await page.locator('#joinBtn').click();
    await page.waitForFunction(()=>window.entered===1);
    assert.equal(saves,1);const id=characters.get('br-1').id;
    assert.ok(await page.locator('#characterSummary').isVisible());
    assert.equal(await page.locator('#characterEditor').isVisible(),false);
    assert.equal(await page.locator('#summaryName').textContent(),'UI Player');
    assert.equal(await page.locator('#summaryCompany').textContent(),'Chưa thêm');
    assert.equal(await page.locator('#summaryGender').textContent(),'Nam');
    await page.screenshot({path:'/tmp/br-profile-readonly.png'});
    assert.equal(await page.locator('#joinBtn').textContent(),'Vào văn phòng');
    await page.locator('#characterSave').click();
    assert.equal(await page.evaluate(()=>document.activeElement.id),'nameInput');
    assert.equal(await page.locator('#characterSummary').isVisible(),false);
    const focus=await page.locator('#nameInput').evaluate(e=>({offset:getComputedStyle(e).outlineOffset,width:getComputedStyle(e).outlineWidth}));
    assert.equal(focus.offset,'-2px');assert.equal(focus.width,'2px');
    await page.screenshot({path:'/tmp/br-profile-focus.png'});
    await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'companyInput');
    await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'roleSelect');
    await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.name),'gender');
    await page.keyboard.press('ArrowRight');assert.ok(await page.locator('input[name="gender"][value="f"]').isChecked());
    await page.locator('.gender label').filter({hasText:'Nam'}).click();assert.ok(await page.locator('input[name="gender"][value="m"]').isChecked());
    await page.locator('#nameInput').fill('Unsaved');
    await page.locator('#characterRestore').click();
    assert.equal(await page.locator('#nameInput').inputValue(),'UI Player');assert.equal(saves,1);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'characterSave');
    await page.locator('#characterSave').click();await page.locator('#nameInput').fill('UI Renamed');
    assert.equal(await page.locator('#joinBtn').textContent(),'Lưu & vào văn phòng');
    let releaseMutation;holdMutation=new Promise(resolve=>{releaseMutation=resolve;});
    await page.locator('#joinBtn').click();
    await page.waitForFunction(()=>document.querySelector('.joinFields').getAttribute('aria-busy')==='true');
    assert.ok(await page.locator('#nameInput').isDisabled());
    assert.equal(await page.locator('#nameInput').evaluate(e=>getComputedStyle(e).opacity),'0.55');
    for(const radio of await page.locator('.gender input').all()) {
      const appearance=await radio.evaluate(e=>({opacity:getComputedStyle(e).opacity,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}));
      assert.equal(appearance.opacity,'0');assert.ok(appearance.width<=1&&appearance.height<=1);
    }
    await page.screenshot({path:'/tmp/br-profile-saving.png'});
    releaseMutation();holdMutation=null;await page.waitForFunction(()=>window.entered===2);
    assert.equal(saves,2);assert.equal(characters.get('br-1').id,id);
    assert.equal(characters.get('br-1').name,'UI Renamed');
    await page.screenshot({path:'/tmp/br-join-account-ready.png'});
    await page.getByRole('button',{name:'BR-2 · 0 online',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('joinBtn').dataset.accountBusy==='false');
    assert.equal(await page.locator('#joinBtn').textContent(),'Tạo nhân vật & vào văn phòng');assert.equal(saves,2);
    await page.locator('#nameInput').fill('Room Two');await page.locator('#joinBtn').click();await page.waitForFunction(()=>window.entered===3);
    assert.equal(characters.get('br-1').name,'UI Renamed');assert.equal(characters.get('br-2').name,'Room Two');
    assert.match(await page.locator('#scoreNote').textContent(),/BXH tính theo ngày.*khách cũng có tên trên bảng.*đăng nhập Google/);
    console.log('ok - one primary action creates/enters; returning character restores; edit/cancel and room switching preserve independent profiles');
    await page.close();
    const mobile=await browser.newPage({viewport:{width:740,height:320},hasTouch:true,isMobile:true});await setup(mobile);
    assert.ok(await mobile.locator('#characterSummary').isVisible());
    assert.equal(await mobile.locator('#characterEditor').isVisible(),false);
    const action=await mobile.locator('#joinBtn').boundingBox();assert.ok(action.y>=0&&action.y+action.height<=320);
    await mobile.screenshot({path:'/tmp/br-profile-readonly-mobile.png'});await mobile.close();
    console.log('ok - read-only summary, keyboard/pointer editing, focus restoration and busy radios remain accessible on desktop/mobile');
    console.log('All 7 account UI browser checks passed (mock profile endpoints).');
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
