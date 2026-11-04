'use strict';
// Exercise the real realtime handlers and two instance runners with a socket transport stub.
// A virtual clock keeps production's 15-second lock/40–60-second interval checks fast.
const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');
class SocketServer extends EventEmitter {
  constructor() { super(); this.clients = new Set(); }
  close(done) { done(); }
}
class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.msgs = []; }
  send(raw) { this.msgs.push(JSON.parse(raw)); }
  close() { if (this.readyState !== 1) return; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  ping() { this.emit('pong'); }
}
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === 'ws' ? { WebSocketServer: SocketServer } : originalLoad.call(this, name, ...args); };
const { createRealtime } = require('../lib/realtime');
Module._load = originalLoad;
const { createMemoryStore } = require('../lib/store-memory');
const world = require('../lib/world');
const { DUEL } = require('../lib/duel');
const clock = Date.now, random = Math.random, interval = global.setInterval, clear = global.clearInterval;
let now = 1000000;
const timers = [];
Date.now = () => now;
Math.random = () => 0;
global.setInterval = (fn, ms) => { const timer = { fn, ms, next: now + ms, active: true, unref() {} }; timers.push(timer); return timer; };
global.clearInterval = timer => { timer.active = false; };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
async function advance(ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    now += Math.min(100, ms - elapsed);
    for (const t of timers) if (t.active && now >= t.next) { t.next += t.ms; t.fn(); }
    await flush();
  }
}
const base = createMemoryStore(), subscribers = new Map();
function instanceStore() {
  const own = new Map();
  return { ...base,
    async subscribe(room, fn) { if (!subscribers.has(room)) subscribers.set(room, new Set()); subscribers.get(room).add(fn); own.set(room, fn); },
    async unsubscribe(room) { subscribers.get(room)?.delete(own.get(room)); own.delete(room); },
    async publish(room, data) { for (const fn of subscribers.get(room) || []) setImmediate(() => fn(data)); },
  };
}
const instances = [];
function instance() {
  const rt = createRealtime({ store: instanceStore(), build: {version:'dev',builtAt:0}, maxConnPerIp:100, log: (...args) => { throw Error(args.join(' ')); } });
  const wss = rt.attach({}); instances.push(rt); return {rt,wss};
}
async function join(host, name, at, token = name.padEnd(20, 'x'), room = 'duel') {
  const oldSpawn = world.WORLD.spawn;
  world.WORLD.spawn = {...at,rx:0,ry:0};
  const ws = new Socket(); host.wss.clients.add(ws);
  host.wss.emit('connection', ws, {headers:{},socket:{remoteAddress:'127.0.0.1'}});
  await flush(); ws.emit('message', Buffer.from(JSON.stringify({t:'join',name,room,token})));
  await flush(); world.WORLD.spawn = oldSpawn;
  const welcome = ws.msgs.find(m=>m.t==='welcome'); assert.ok(welcome, 'joined ' + name);
  ws.id = welcome.you; ws.token = token; ws.welcome = welcome;
  return ws;
}
async function move(ws, x, y) { ws.emit('message', Buffer.from(JSON.stringify({t:'move',x,y,d:1}))); await flush(); }
async function main() {
  const a = instance(), b = instance();
  const near = await join(a,'Near',{x:2750,y:1700});
  const spectator = await join(b,'Inside',{x:3730,y:1700});
  const distant = await join(b,'Far',{x:1900,y:1950});
  // Keep occupants healthy while virtual time advances toward the first cast.
  await advance(1200);
  const initial = await base.duelGet('duel',{now});
  assert.ok(initial.nextAt >= now + 39000 && initial.nextAt <= now + 60000);
  while (now < initial.nextAt + 100) {
    for (const ws of [near,spectator,distant]) { ws.player.hp=100; ws.player.hpAt=now; ws.player.deadUntil=0; }
    await advance(100);
  }
  const cast = near.msgs.find(m=>m.t==='bduel' && m.state.target);
  assert.ok(cast,'boss cast 1:1'); assert.equal(cast.state.target, near.id);
  assert.equal(cast.ms,15000); assert.ok(spectator.msgs.some(m=>m.t==='bduel' && m.state.version===cast.state.version));
  assert.equal(near.player.x,3100); assert.ok(spectator.player.x < world.BOSS_ROOM.x0);
  assert.equal(distant.player.x,1900); assert.equal(distant.player.y,1950);
  console.log('ok - one leader casts after 40s, pulls a nearby user and blows a remote occupant out');
  await move(near,2750,1700); assert.equal(near.player.x,3100,'in-flight pre-pull input is ignored');
  await advance(DUEL.pullMs + 100);
  await move(near,2750,1700); assert.ok(near.player.x >= world.BOSS_ROOM.x0 + world.PLAYER_RADIUS);
  await move(spectator,3100,1700); assert.ok(spectator.player.x < world.BOSS_ROOM.x0);
  console.log('ok - capture and spectator entry are constrained by authoritative movement on both instances');
  // A new socket takes over the same player on the other instance (as with refresh/renewal).
  const again = await join(b,'Near',{x:1900,y:1950},near.token);
  assert.equal(again.id,near.id); assert.equal(near.readyState,3);
  assert.ok(again.welcome.duel.ms > 0 && again.welcome.duel.ms < 15000);
  assert.ok(again.player.x >= world.BOSS_ROOM.x0 + world.PLAYER_RADIUS);
  await move(again,2750,1700); assert.ok(again.player.x >= world.BOSS_ROOM.x0 + world.PLAYER_RADIUS);
  console.log('ok - refresh on a different instance preserves capture and remaining time');
  // Disconnect the leader's last local socket: its lease expires, the other runner takes over.
  const targetUntil = (await base.duelGet('duel',{now})).until;
  while (now < targetUntil) {
    for (const ws of [again,spectator,distant]) { ws.player.hp=100; ws.player.hpAt=now; ws.player.deadUntil=0; }
    await advance(Math.min(100,targetUntil-now));
  }
  assert.ok(again.msgs.some(m=>m.t==='bduel' && m.state.target===0 && m.state.version>cast.state.version));
  await move(again,2750,1700); assert.ok(again.player.x < world.BOSS_ROOM.x0,'released at 15s');
  assert.equal((await base.duelGet('duel',{now})).target,0);
  assert.equal(again.msgs.filter(m=>m.t==='bduel' && m.state.target).length,0,'no replay on handover/reconnect');
  console.log('ok - leader handover preserves the 15s timer, then unlocks without replaying the cast');
  for (const rt of instances) await rt.stop(); await base.close();
  console.log('All 4 realtime duel checks passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
  Date.now=clock; Math.random=random; global.setInterval=interval; global.clearInterval=clear;
});
