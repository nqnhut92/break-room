'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { migrate } = require('../scripts/migrate');
const { createIdentity } = require('../lib/identity');
const { createProfiles, nameKey } = require('../lib/profiles');
const { createMemoryStore } = require('../lib/store-memory');
const { createRedisStore } = require('../lib/store-redis');
const { createApp } = require('../server');
const context = require('../lib/identity-context');
const Redis = require('ioredis');
const WebSocket = require('ws');
let passed = 0;
const step = async (name, fn) => { await fn(); console.log('ok - ' + name); passed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function jar() {
  const values = new Map();
  return {
    add(response) { for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const i = pair.indexOf('='); if (pair.slice(i+1)) values.set(pair.slice(0,i), pair.slice(i+1)); else values.delete(pair.slice(0,i)); } },
    get header() { return [...values].map(([k,v]) => k+'='+v).join('; '); },
  };
}
async function main() {
  const db = process.env.IDENTITY_TEST_DATABASE_URL, redisUrl = process.env.IDENTITY_TEST_REDIS_URL;
  assert.ok(db && redisUrl, 'Use npm run test:identity for disposable services');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const profiles = createProfiles(db);
  const peer = createProfiles(db);
  await step('automatic first-use migrations serialize across instances and are applied once', async () => {
    try { await Promise.all([profiles.ready(), profiles.ready(), peer.ready()]); }
    finally { await peer.close(); }
    const ledger = await profiles.pool.query('SELECT version FROM schema_migrations');
    assert.deepEqual(ledger.rows.map(r => r.version).sort(), ['001-identity.sql', '002-daily-scores-chat.sql', '003-daily-deaths.sql']);
  });
  await step('failed migration rolls back both DDL and ledger; a corrected migration retries safely', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'br-migration-'));
    try {
      const file=path.join(dir,'999-test-only.sql');
      fs.writeFileSync(file,'CREATE TABLE migration_rollback_probe(id int); SELECT * FROM missing_migration_test_table;');
      await assert.rejects(migrate(db,{directory:dir}));
      assert.equal((await profiles.pool.query("SELECT to_regclass('migration_rollback_probe') AS table_name")).rows[0].table_name,null);
      assert.equal((await profiles.pool.query("SELECT 1 FROM schema_migrations WHERE version='999-test-only.sql'")).rowCount,0);
      fs.writeFileSync(file,'CREATE TABLE migration_rollback_probe(id int);');
      await migrate(db,{directory:dir});
      await profiles.pool.query("DROP TABLE migration_rollback_probe; DELETE FROM schema_migrations WHERE version='999-test-only.sql'");
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  const redis = new Redis(redisUrl);
  const stores = [createMemoryStore(), createRedisStore(redisUrl, { log: () => {} })];
  const identities = [];
  try {
    const a = await profiles.account('verified-subject-a'), b = await profiles.account('verified-subject-b');
    await step('Google subject callback retries converge on one account', async () => {
      assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => profiles.account('verified-subject-a'))), Array(8).fill(a));
      assert.equal((await profiles.pool.query('SELECT count(*) FROM accounts')).rows[0].count, '2');
    });
    for (let i = 0; i < stores.length; i++) {
      const store = stores[i], room = i === 0 ? 'br-1' : 'br-2';
      const env = { DATABASE_URL: db, REDIS_URL: i ? redisUrl : undefined, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', AUTH_SECRET: 'test-only-secret-32-characters-long', AUTH_URL: 'http://localhost:3111' };
      const id = createIdentity({ env, store, profiles, ...(i ? {redis} : {}) }); identities.push(id);
      const token = { accountId: a, sid: crypto.randomUUID(), until: Date.now()+60000 };
      await id.issue(token.sid, token.until);
      const opts = (name, token = crypto.randomBytes(16).toString('hex')) => ({ name, token, gender:'m', role:'dev', company:'Team', fallbackName:'Employee ', connId:crypto.randomUUID(), now:Date.now(), max:20, ttlMs:20000, spawn:{x:1800,y:1900} });
      let ch;
      await step(store.kind + ': unique account/room, normalized reserved names, case-insensitive concurrent SQL writes', async () => {
        const attempts = await Promise.allSettled([a,b].map((account,index) => profiles.transaction(room, c => profiles.save(c, account, room, { name:index ? '  nICK  ' : '  NiCk  ', gender:'f', role:'it', company:' A  B ' }, false))));
        assert.equal(attempts.filter(r => r.status === 'fulfilled').length,1);
        assert.equal(attempts.find(r=>r.status==='rejected').reason.code,'23505');
        ch=attempts.find(r=>r.status==='fulfilled').value;
        token.accountId=ch.account_id;
        assert.equal(nameKey(ch.name),'nick'); assert.equal(ch.company,'A B');
        assert.ok((await id.join(room,opts('nick'),null)).taken);
        assert.ok((await id.join(room,opts('NICK'),null,true)).taken);
        const duplicate = await profiles.transaction(room,c=>profiles.save(c,ch.account_id,room,{name:'Other',gender:'m',role:'dev',company:''},false)).catch(e=>e);
        assert.equal(duplicate.code,'23505');
      });
      let old, newer, currentPlaying;
      await step(store.kind + ': authenticated identity ignores forged profile/id and reconnect token', async () => {
        old=opts('attacker-name');
        const joined = await id.join(room,old,token);
        assert.equal(joined.characterId,ch.id); assert.equal(joined.profile.name,ch.name);
        newer=opts('attacker-name',old.token);
        const next=await id.join(room,newer,token);
        assert.equal(next.id,joined.id); assert.equal(next.prevConn,old.connId);
        old.id=joined.id; newer.id=next.id;
        const fake = await id.join(room,opts('NiCk',id.accountToken(ch)),null);
        assert.ok(fake.taken);
      });
      await step(store.kind + ': execution-time fences stop stale writes after takeover, not just after pub/sub', async () => {
        const ctx = { room, id:old.id, conn:old.connId, sid:token.sid, valid:()=>id.sessions.has(token.sid) };
        await assert.rejects(context.run(ctx,()=>store.setHp(room,old.id,{hp:1,at:Date.now(),deadUntil:0})));
        await assert.rejects(context.run(ctx,()=>store.hit(room,{objId:0,defaultHp:2,cost:1,playerId:old.id,now:Date.now()})));
        assert.equal(await store.leave(room,old.id,old.connId,{x:1,y:1,d:1},Date.now()),false);
        assert.equal(await store.isOwner(room,newer.id,newer.connId),true);
        await context.run({...ctx,conn:newer.connId},()=>store.setHp(room,newer.id,{hp:73,at:Date.now(),deadUntil:0}));
        assert.equal((await store.read(room,{now:Date.now(),ttlMs:20000})).players.find(p=>p.id===newer.id).hp,73);
        const hit=await context.run({...ctx,conn:newer.connId},()=>store.hit(room,{objId:0,defaultHp:2,cost:1,playerId:newer.id,now:Date.now()}));
        assert.equal(hit.state,'hit');
      });
      await step(store.kind + ': Unicode online guest/bot conflict and edit do not steal ownership', async () => {
        const guestOpts=opts('Đồng nghiệp'); const guest=await id.join(room,guestOpts,null);
        assert.ok(guest.id);
        assert.ok((await id.join(room,opts('ĐỒNG NGHIỆP'),null,true)).taken);
        assert.equal(await store.isOwner(room,guest.id,guestOpts.connId),true);
        await store.leave(room,guest.id,guestOpts.connId,null,Date.now());
        await store.leave(room,newer.id,newer.connId,null,Date.now());
        const edited=await profiles.transaction(room,c=>profiles.save(c,token.accountId,room,{name:'New Nick',gender:'m',role:'hr',company:'X'},true));
        assert.equal(edited.id,ch.id);
        const currentOpts=opts('ignored');
        const joined=await id.join(room,currentOpts,token);
        currentPlaying={id:joined.id,conn:currentOpts.connId};
        assert.equal(joined.profile.name,'New Nick');
        assert.equal(joined.characterId,ch.id);

      });
      await step(store.kind + ': revocation blocks dispatch and fenced mutations',async()=>{
        assert.equal(await store.isOwner(room,currentPlaying.id,currentPlaying.conn),true);
        await id.revoke(token.sid); assert.equal(await id.valid(token,room),false);
        const sidCtx={room,id:currentPlaying.id,conn:currentPlaying.conn,sid:token.sid,valid:()=>id.sessions.has(token.sid)};
        await assert.rejects(context.run(sidCtx,()=>store.setHp(room,currentPlaying.id,{hp:1,at:Date.now(),deadUntil:0})));
        const p=opts('ignored');
        await assert.rejects(id.join(room,p,token));
      });
      await step(store.kind + ': delayed heartbeat cannot resurrect a guest after an offline name reservation',async()=>{
        const late=opts('Late Guest');late.now=Date.now()-30000;
        const joined=await id.join(room,late,null);assert.ok(joined.id);
        await profiles.transaction(room,c=>profiles.save(c,token.accountId,room,{name:'Late Guest',gender:'m',role:'dev',company:''},true));
        await store.housekeep(room,{now:Date.now(),ttlMs:20000,respawnMs:0,sweep:false,strictPresence:true,entries:[{id:joined.id,connId:late.connId,pos:{x:1,y:1,d:1}}]});
        assert.equal((await store.read(room,{now:Date.now(),ttlMs:20000})).players.some(p=>p.id===joined.id),false);
        assert.ok((await id.join(room,opts('LATE GUEST'),null)).taken);
      });
      await step(store.kind + ': database outage keeps guest in a reserved temporary namespace; account and bots fail closed',async()=>{
        const failed=createIdentity({env,store,redis,profiles:{transaction:async()=>{throw Error('unavailable');}}});
        const guest=await failed.join(room,opts('New Nick'),null);
        assert.match(guest.profile.name,/^~/); assert.ok(guest.temporary);
        assert.ok((await failed.join(room,opts('New Nick'),null,true)).taken);
        await assert.rejects(failed.join(room,opts('New Nick'),token));
      });
    }
    await step('restarting migration initialization preserves all existing account and character data', async () => {
      const before = (await profiles.pool.query('SELECT * FROM characters ORDER BY id')).rows;
      await Promise.all([migrate(db), migrate(db)]);
      const restarted = createProfiles(db);
      try { await restarted.ready(); } finally { await restarted.close(); }
      assert.deepEqual((await profiles.pool.query('SELECT * FROM characters ORDER BY id')).rows, before);
      assert.equal((await profiles.pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count, '3');
    });
    await step('characters in BR1 and BR2 have independent stable IDs',async()=>{
      const own=[];
      for(const room of ['br-1','br-2']) own.push(await profiles.transaction(room,async c=>await profiles.get(c,a,room)||profiles.save(c,a,room,{name:'Scoped User',gender:'m',role:'dev',company:''},false)));
      assert.equal(own[0].account_id,a);assert.equal(own[1].account_id,a);
      assert.notEqual(own[0].id,own[1].id);assert.notEqual(own[0].room_id,own[1].room_id);
    });
    await httpAndOidc(db,redisUrl,profiles,redis);
  } finally { for (const s of stores) await s.close(); redis.disconnect(); await profiles.close(); }
  console.log(`All ${passed} identity checks passed (mock Google OIDC, disposable Postgres and Redis).`);
}
async function httpAndOidc(db, redisUrl, profiles, redis) {
  const store=createRedisStore(redisUrl,{log:()=>{}});
  let origin, nonce, challenge, wrongNonce = false;
  const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk={...publicKey.export({format:'jwk'}),kid:'test-key',alg:'RS256',use:'sig'};
  const env={DATABASE_URL:db,REDIS_URL:redisUrl,GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',AUTH_SECRET:'test-only-secret-32-characters-long',AUTH_URL:'http://localhost:3111'};
  const mockFetch=async(url,options)=>{
    const u=String(url);
    if(u.includes('.well-known')) return Response.json({issuer:'https://accounts.google.com',authorization_endpoint:'https://accounts.google.com/o/oauth2/v2/auth',token_endpoint:'https://oauth2.googleapis.com/token',jwks_uri:'https://www.googleapis.com/oauth2/v3/certs',userinfo_endpoint:'https://openidconnect.googleapis.com/v1/userinfo',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256']});
    if(u.includes('/certs')) return Response.json({keys:[jwk]});
    if(u.includes('/token')) {
      const body=new URLSearchParams(options.body);
      assert.equal(crypto.createHash('sha256').update(body.get('code_verifier')).digest('base64url'),challenge);
      const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'test-key'})).toString('base64url');
      const claims=Buffer.from(JSON.stringify({iss:'https://accounts.google.com',sub:'mock-user',aud:'test-client',exp:Math.floor(Date.now()/1000)+300,iat:Math.floor(Date.now()/1000),nonce:wrongNonce?'wrong-nonce':nonce,email:'ignored@example.test',name:'Not a character'})).toString('base64url');
      const data=header+'.'+claims;const signature=crypto.sign('RSA-SHA256',Buffer.from(data),privateKey).toString('base64url');
      return Response.json({access_token:'not-persisted',token_type:'Bearer',expires_in:300,id_token:data+'.'+signature});
    }
    throw Error('Unexpected provider request');
  };
  const net = require('node:net');
  const probe=net.createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port; await new Promise(r=>probe.close(r));
  origin='http://localhost:'+port; env.AUTH_URL=origin;
  const auth=createIdentity({env,store,profiles,redis,authFetch:mockFetch});
  const app=createApp({store,identity:{...auth,close:async()=>{}},env,bossEnabled:false,moleEnabled:false,log:()=>{}});
  await app.start(port);
  let parsedBody = false;
  const rawHandler=app.server.listeners('request')[0];
  app.server.removeAllListeners('request');
  app.server.on('request',async(req,res)=>{
    if(parsedBody && req.method==='POST') {
      let body='';for await(const chunk of req)body+=chunk;
      req.body=String(req.headers['content-type']).startsWith('application/json') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
    }
    rawHandler(req,res);
  });
  const sockets=[];
  const joinSocket=(cookie, originHeader=origin, room='br-1')=>new Promise((resolve,reject)=>{
    const ws=new WebSocket('ws://localhost:'+port+'/api/ws',{headers:{Origin:originHeader,Cookie:cookie}}); sockets.push(ws);
    const timer=setTimeout(()=>{ws.terminate();reject(Error('WebSocket join timed out'));},5000);
    ws.on('error',e=>{clearTimeout(timer);reject(e);});
    ws.on('message',raw=>{const m=JSON.parse(raw);if(m.t==='welcome'){clearTimeout(timer);resolve({ws,welcome:m});}else if(m.t==='err'){clearTimeout(timer);reject(Error(m.m));}});
    ws.on('open',()=>ws.send(JSON.stringify({t:'join',room,name:'FORGED',token:'forgedreconnecttoken0123456789',characterId:'forged',account_id:'forged',role:'nv',gender:'m'})));
  });
  const cookies=jar();
  async function request(path, options={}) {
    const r=await fetch(origin+path,{redirect:'manual',...options,headers:{cookie:cookies.header,...(options.headers||{})}});cookies.add(r);return r;
  }
  async function login(badState=false) {
    const csrf=await (await request('/api/auth/csrf')).json();
    const r=await request('/api/auth/signin/google',{method:'POST',headers:{Origin:origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrfToken:csrf.csrfToken,callbackUrl:origin+'/'})});
    const location=new URL(r.headers.get('location'));nonce=location.searchParams.get('nonce');challenge=location.searchParams.get('code_challenge');assert.ok(nonce&&challenge);
    return request('/api/auth/callback/google?code=mock-code&state='+(badState?'invalid':location.searchParams.get('state')));
  }
  try {
    await step('real Auth.js Google callback validates state and PKCE using a mock provider',async()=>{
      await login(true);
      assert.equal((await (await request('/api/auth/status')).json()).authenticated,false);
      wrongNonce=true;await login();wrongNonce=false;
      assert.equal((await (await request('/api/auth/status')).json()).authenticated,false);
      const r=await login();assert.equal(r.status,302);
      assert.equal((await (await request('/api/auth/status')).json()).authenticated,true);
      assert.ok(!cookies.header.includes('not-persisted'));
    });
    await step('profile HTTP authorization, CSRF, allowlist validation and create/edit preserve IDs',async()=>{
      const path='/api/profile?room=br-1';
      const input={name:'HTTP Player',gender:'f',role:'dev',company:'Team'};
      const send=body=>request(path,{method:'POST',headers:{Origin:origin,'content-type':'application/json'},body:JSON.stringify(body)});
      assert.equal((await request(path,{method:'POST',body:JSON.stringify(input)})).status,403);
      assert.equal((await send({...input,account_id:'forged'})).status,400);
      const created=await send(input); assert.equal(created.status,200);const ch=(await created.json()).character;
      const edited=await request(path,{method:'PATCH',headers:{Origin:origin,'content-type':'application/json'},body:JSON.stringify({...input,name:'HTTP Edited'})});
      assert.equal(edited.status,200);assert.equal((await edited.json()).character.id,ch.id);
      assert.equal((await send(input)).status,409);
      const noCookie=await fetch(origin+path);assert.equal(noCookie.status,401);
    });
    await step('concurrent guest join and profile rename have only one winner across SQL and Redis',async()=>{
      const guest={name:'Race Name',gender:'m',role:'nv',company:'',token:crypto.randomBytes(16).toString('hex'),connId:crypto.randomUUID(),now:Date.now(),max:20,ttlMs:20000,spawn:{x:1800,y:1900}};
      const [renamed,joined]=await Promise.all([
        request('/api/profile?room=br-1',{method:'PATCH',headers:{Origin:origin,'content-type':'application/json'},body:JSON.stringify({name:'Race Name',gender:'f',role:'dev',company:'Team'})}),
        auth.join('br-1',guest,null),
      ]);
      assert.equal((renamed.status===200?1:0)+(joined.id?1:0),1);
      if(joined.id) await store.leave('br-1',joined.id,guest.connId,null,Date.now());
      const reset=await request('/api/profile?room=br-1',{method:'PATCH',headers:{Origin:origin,'content-type':'application/json'},body:JSON.stringify({name:'HTTP Edited',gender:'f',role:'dev',company:'Team'})});assert.equal(reset.status,200);
    });
    let active;
    await step('WebSocket session identity, cross-device takeover, online edit rejection and Origin enforcement',async()=>{
      await assert.rejects(joinSocket(cookies.header,'https://evil.example'));
      const first=await joinSocket(cookies.header);
      const closed=new Promise(resolve=>first.ws.once('close',resolve));
      active=await joinSocket(cookies.header);
      assert.equal(active.welcome.you,first.welcome.you);
      const me=active.welcome.players.find(p=>p.id===active.welcome.you);
      assert.equal(me.name,'HTTP Edited');assert.equal(me.role,'dev');
      assert.equal(await closed,4001);
      assert.ok(!JSON.stringify(active.welcome).includes('accountId'));
      const r=await request('/api/profile?room=br-1',{method:'PATCH',headers:{Origin:origin,'content-type':'application/json'},body:JSON.stringify({name:'Should Fail',gender:'m',role:'dev',company:''})});
      assert.equal(r.status,409);
      const rooms=(await profiles.pool.query('SELECT count(*) FROM accounts')).rows[0].count;
      assert.equal(rooms,'3');
    });
    parsedBody=true;
    await step('Auth.js signout revokes server-side session, stolen encrypted cookie cannot be reused',async()=>{
      const stolen=cookies.header;
      const closed=new Promise(resolve=>active.ws.once('close',resolve));
      const {csrfToken}=await (await request('/api/auth/csrf')).json();
      const r=await request('/api/auth/signout',{method:'POST',headers:{Origin:origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrfToken,callbackUrl:origin+'/'})});assert.equal(r.status,302);
      assert.equal((await fetch(origin+'/api/profile?room=br-1',{headers:{cookie:stolen}})).status,401);
      assert.equal(await closed,4004);
      await assert.rejects(joinSocket(stolen));
    });
    await step('Vercel parsed-body sign-in, cross-device restore and open-socket expiry',async()=>{
      await login();
      const data=await (await request('/api/profile?room=br-1')).json();assert.equal(data.character.name,'HTTP Edited');
      const joined=await joinSocket(cookies.header);
      const closed=new Promise(resolve=>joined.ws.once('close',resolve));
      const t=await auth.token({headers:{cookie:cookies.header}});
      await redis.pexpire(auth.sessionKey('br-1',t.sid),1);
      assert.equal(await closed,4004);
    });
  } finally { for(const ws of sockets) ws.terminate(); await app.stop(); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
