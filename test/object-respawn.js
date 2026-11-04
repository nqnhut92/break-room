'use strict';
const assert=require('assert/strict');
const {objectRespawnMs}=require('../lib/object-respawn');
const {respawnMsFromEnv}=require('../lib/config');
for(const [people,broken,expected] of [[0,0,60000],[1,1,60000],[1,3,60000],[1,20,51500],[5,20,41500],[10,20,29000],[20,1,25000],[1,100,25000]])assert.equal(objectRespawnMs(people,broken),expected);
for(let p=0;p<=20;p++)for(let b=0;b<=359;b++){
 const ms=objectRespawnMs(p,b);assert.ok(ms>=25000&&ms<=60000);
 assert.ok(objectRespawnMs(p+1,b)<=ms);assert.ok(objectRespawnMs(p,b+1)<=ms);
}
assert.equal(objectRespawnMs(20,359,1500),1500);
assert.equal(respawnMsFromEnv({}),0);
for(const raw of ['','0','-1','NaN','Infinity'])assert.equal(respawnMsFromEnv({RESPAWN_MS:raw}),0);
assert.equal(respawnMsFromEnv({RESPAWN_MS:'1500'}),1500);
console.log('All adaptive IT examples, bounds, monotonicity and explicit fixed-delay override checks passed');

async function wirePolicy() {
  const {createApp}=require('../server');
  const {createMemoryStore}=require('../lib/store-memory');
  const {client}=require('./helpers');
  for(const [env,expected] of [[{},0],[{RESPAWN_MS:'1500'},1500]]) {
    const app=createApp({store:createMemoryStore(),env,bossEnabled:false,moleEnabled:false,afkMs:0});
    let c;
    try {
      const port=await app.start(0);c=await client(port,'IT policy','br-1');
      assert.equal(c.welcome.respawnMs,expected);
      assert.deepEqual(c.welcome.respawnPolicy,expected>0?null:require('../lib/object-respawn').OBJECT_RESPAWN);
    } finally {if(c)c.ws.close();await app.stop();}
  }
  console.log('ok - real WebSocket welcome advertises adaptive policy or the explicit fixed override');
}
wirePolicy().catch(error=>{console.error(error);process.exitCode=1;});
