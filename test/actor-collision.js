'use strict';
const assert=require('node:assert/strict');
const C=require('../public/actor-collision');
const W=require('../lib/world');
const B=require('../lib/boss');
const M=require('../lib/miniboss');
const h=require('./helpers');
const {createMemoryStore}=require('../lib/store-memory');
const {createApp}=require('../server');
let passed=0;
async function check(name,fn){await fn();passed++;console.log('ok - '+name);}
const free=(x,y)=>({x,y});
async function main(){
  await check('swept movement cannot tunnel through boss or mini-boss bodies',()=>{
    for(const radius of [B.BOSS.radius,M.RADIUS]){
      const p=C.slide(-150,0,150,0,W.PLAYER_RADIUS,[{x:0,y:0,r:radius}],free);
      assert.ok(p.x<=-radius-W.PLAYER_RADIUS+0.01);assert.ok(Math.abs(p.y)<0.01);
    }
  });
  await check('a player can slide around a boss and move freely after leaving its body',()=>{
    let p={x:-60,y:0};const circles=[{x:0,y:0,r:34}];
    for(let i=0;i<12;i++)p=C.slide(p.x,p.y,p.x+15,p.y+12,16,circles,free);
    assert.ok(p.x>50&&p.y>50);
    assert.deepEqual(C.slide(0,0,100,0,16,[],free),{x:100,y:0});
  });
  await check('circle resolution cannot push through a wall and an initial overlap can escape',()=>{
    const wall=(x,y)=>({x:Math.min(x,0),y});
    const p=C.slide(-40,0,40,0,16,[{x:50,y:0,r:34}],wall);
    assert.ok(p.x<=0);
    const escape=C.slide(0,0,-60,0,16,[{x:0,y:0,r:34}],free);
    assert.ok(escape.x<=-50);
  });
  await check('mini-boss wandering avoids a stationary bystander without provoking it',()=>{
    const mini={...M.createMini('TML'),x:1880,y:1950,goal:{x:2040,y:1950},pauseUntil:0};
    const state={version:1,list:[mini]},person={id:1,x:1920,y:1950};
    for(let i=0;i<20;i++)M.stepMini(state,[person],1000+i*100,0.1,()=>0);
    assert.ok(Math.hypot(mini.x-person.x,mini.y-person.y)>=M.RADIUS+W.PLAYER_RADIUS-0.1);
    assert.deepEqual(mini.threat,{});
  });
  // A straight open corridor of floor: a nav point with a clear line 360 units east.
  const lane=(radius)=>{const p=[...M.nav(radius).values()].find(q=>W.clearLine(q.x,q.y,q.x+360,q.y)&&W.clearLine(q.x,q.y+40,q.x+360,q.y+40)&&W.clearLine(q.x,q.y-40,q.x+360,q.y-40)&&W.inBossZone?.(q.x,q.y)!==undefined);assert.ok(p,'an open lane exists');return p;};
  await check('living mini-bosses walk around each other, not through',()=>{
    const p=lane(M.RADIUS),target={id:7,x:p.x+340,y:p.y,dead:false};
    const state=M.initialState([],()=>0),[a,b]=state.list;
    Object.assign(a,{x:p.x,y:p.y,threat:{},goal:null,wind:null,recoverAt:0});Object.assign(b,{x:p.x+120,y:p.y,threat:{},goal:null,wind:null,recoverAt:0});
    let closest=Infinity;
    for(let i=0;i<30;i++){M.stepMini(state,[target],1000+i*100,0.1,()=>0,true,[]);closest=Math.min(closest,Math.hypot(a.x-b.x,a.y-b.y));}
    assert.ok(closest>=2*M.RADIUS-0.1,'TML and DMM overlapped: '+closest);
    b.hp=0;b.respawnAt=Infinity;a.x=p.x;a.y=p.y;
    for(let i=0;i<30;i++)M.stepMini(state,[target],5000+i*100,0.1,()=>0,true,[]);
    assert.ok(a.x>p.x+150,'a dead mini blocks nothing');
  });
  await check('VKL slides around a living mini-boss in his way, and a mini around VKL',()=>{
    const p=lane(B.BOSS.radius),mini={x:p.x+130,y:p.y,r:M.RADIUS},target={id:7,x:p.x+340,y:p.y};
    const b=B.createBossState(0);Object.assign(b,{x:p.x,y:p.y,mode:'chase',tid:7,processCooldown:99});
    let closest=Infinity;
    for(let i=0;i<30;i++){B.stepBoss(b,0.1,[target],()=>0,{office:true,blockers:[mini]});closest=Math.min(closest,Math.hypot(b.x-mini.x,b.y-mini.y));}
    assert.ok(closest>=B.BOSS.radius+M.RADIUS-0.1,'VKL overlapped a mini: '+closest);
    assert.ok(b.x>mini.x+M.RADIUS,'VKL walks around a mini met head-on instead of stopping behind it');
    assert.equal(Object.keys(JSON.parse(JSON.stringify(b))).includes('blockers'),false,'blockers are not saved with VKL');
    const state=M.initialState([],()=>0),[a]=state.list;state.list[1].hp=0;state.list[1].respawnAt=Infinity;
    Object.assign(a,{x:p.x,y:p.y,threat:{},goal:null,wind:null,recoverAt:0});
    const vkl={x:p.x+130,y:p.y,r:B.BOSS.radius};closest=Infinity;
    for(let i=0;i<30;i++){M.stepMini(state,[target],1000+i*100,0.1,()=>0,true,[],[vkl]);closest=Math.min(closest,Math.hypot(a.x-vkl.x,a.y-vkl.y));}
    assert.ok(closest>=B.BOSS.radius+M.RADIUS-0.1,'a mini overlapped VKL: '+closest);
    assert.ok(a.x>vkl.x,'the mini gets round VKL');
  });
  await check('Prof. K stops at VKL\'s body and slides around mini-bosses',()=>{
    const K=require('../lib/profk');
    const p=lane(K.PROFK.radius),s=K.createProfK(0,()=>0);
    Object.assign(s,{phase:'out',until:1e9,x:p.x,y:p.y,wind:null,recoverAt:0});
    const mini={x:p.x+120,y:p.y,r:M.RADIUS},vkl={x:p.x+340,y:p.y,alive:true};
    let nearMini=Infinity,nearVkl=Infinity;
    for(let i=0;i<40;i++){K.stepProfK(s,1000+i*100,0.1,{vkl,humans:1,players:[],blockers:[mini]},()=>0);nearMini=Math.min(nearMini,Math.hypot(s.x-mini.x,s.y-mini.y));nearVkl=Math.min(nearVkl,Math.hypot(s.x-vkl.x,s.y-vkl.y));}
    assert.ok(nearMini>=K.PROFK.radius+M.RADIUS-0.1,'Prof. K overlapped a mini: '+nearMini);
    assert.ok(nearVkl>=K.PROFK.radius+B.BOSS.radius-0.1,'Prof. K overlapped VKL: '+nearVkl);
    assert.ok(nearVkl<=K.PROFK.punchStartDist,'he still reaches VKL to punch');
    assert.ok(s.x>mini.x,'past the mini, not stuck behind it');
  });
  for(const boss of [false,true])await network(boss);
  console.log('All '+passed+' actor collision checks passed');
}
async function network(boss){
  const original=W.WORLD.spawn,store=createMemoryStore(),room=boss?'actor-boss':'actor-mini';
  const x=boss?W.BOSS_HOME.x:1900,y=boss?W.BOSS_HOME.y:1950;
  const seed={version:1,list:[{...M.createMini('TML'),x:boss?1900:x,y:1950}]};
  await store.miniSave(room,{now:Date.now(),expected:0,state:seed});
  await store.bossLock(room,'stationary-fixture',{now:Date.now(),ttlMs:60000});
  W.WORLD.spawn={x:x-140,y,rx:0,ry:0};
  const app=createApp({env:{},rooms:null,store,bossEnabled:boss,moleEnabled:false,log:()=>{}});
  const clients=[];
  try{
    const port=await app.start(0),a=await h.client(port,'Walker',room),b=await h.client(port,'Bystander',room);clients.push(a,b);
    await check((boss?'boss':'mini')+': players share space without blocking or exposing bot flags',async()=>{
      const snap=await store.read(room,{now:Date.now(),ttlMs:20000});
      const one=snap.players.find(p=>p.id===a.id),two=snap.players.find(p=>p.id===b.id);
      assert.equal(one.x,two.x);assert.equal(one.y,two.y);
      assert.ok(!Object.keys(a.welcome.players[0]).some(k=>/account|character|bot/i.test(k)));
    });
    await check((boss?'boss':'mini')+': server corrects movement through a living body, including large requested steps',async()=>{
      for(let i=0;i<8;i++){h.send(a,{t:'move',x:x+140,y,d:1});await h.sleep(70);}
      const correction=await h.take(a,m=>m.t==='position');assert.ok(correction.x<x);
      const updates=a.msgs.filter(m=>m.t==='ps').flatMap(m=>m.l).filter(p=>p[0]===a.id);
      const last=updates.at(-1);assert.ok(last);const me={x:last[1],y:last[2]};
      const center=boss?[...a.msgs].reverse().find(m=>m.t==='boss')||W.BOSS_HOME:{x,y};
      assert.ok(me.x<center.x);
      assert.ok(Math.hypot(me.x-center.x,me.y-center.y)>=(boss?B.BOSS.radius:M.RADIUS)+W.PLAYER_RADIUS-1);
    });
    await check((boss?'boss':'mini')+': defeated body no longer blocks passage',async()=>{
      if(boss){
        await store.bossHit(room,{playerId:a.id,dmg:100000,now:Date.now(),cfg:B.BOSS,respawnAt:Date.now()+60000,bounty:0});
        await store.publish(room,JSON.stringify([0,{t:'bdead',shares:[]},'fixture']));
      }else{
        const dead=structuredClone(seed);dead.version=2;dead.list[0].hp=0;dead.list[0].respawnAt=Date.now()+60000;
        assert.equal(await store.miniSave(room,{now:Date.now(),expected:1,state:dead}),true);
        await store.publish(room,JSON.stringify([0,{t:'miniState',state:dead},'fixture']));
      }
      await h.take(a,m=>boss?m.t==='bdead':m.t==='miniState'&&m.state.list[0].hp===0);
      for(let i=0;i<7;i++){h.send(a,{t:'move',x:x+100,y,d:1});await h.sleep(70);}
      const movement=await h.take(a,m=>m.t==='ps'&&m.l.some(p=>p[0]===a.id&&p[1]>x+30));
      assert.ok(movement.l.find(p=>p[0]===a.id)[1]>x+30);
    });
  }finally{for(const c of clients)c.ws.terminate();await app.stop();W.WORLD.spawn=original;}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
