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
