'use strict';

const WebSocket = require('ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (c, o) => c.ws.send(JSON.stringify(o));

let tokenSeq = 0;
const newToken = () => 'testtoken' + String(++tokenSeq).padStart(8, '0') + 'abcdef';

// Opens a real WebSocket, joins, and resolves once the welcome arrives.
function client(port, name, room, token = newToken()) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/api/ws');
    const c = { ws, name, token, msgs: [], welcome: null, id: null, closeCode: null };
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      c.msgs.push(m);
      if (m.t === 'welcome') {
        c.welcome = m;
        c.id = m.you;
        const me = m.players.find((p) => p.id === m.you);
        c.x = me.x;
        c.y = me.y;
        resolve(c);
      }
    });
    ws.on('close', (code) => {
      c.closeCode = code;
    });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, room, token })));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('join timeout for ' + name)), 4000);
  });
}

function take(c, pred, ms = 1500) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = c.msgs.find((x) => !x._used && pred(x));
      if (m) {
        m._used = true;
        clearInterval(iv);
        resolve(m);
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error('timeout waiting for message on ' + c.name));
      }
    }, 10);
  });
}

async function none(c, pred, ms = 300) {
  await sleep(ms);
  const m = c.msgs.find((x) => !x._used && pred(x));
  if (m) throw new Error('unexpected message ' + JSON.stringify(m));
}

async function walkTo(c, target, stop) {
  let { x, y } = c;
  while (Math.hypot(target.x - x, target.y - y) > stop) {
    const d = Math.hypot(target.x - x, target.y - y);
    x += ((target.x - x) / d) * 14;
    y += ((target.y - y) / d) * 14;
    send(c, { t: 'move', x: Math.round(x), y: Math.round(y), d: 1 });
    await sleep(50);
  }
  c.x = x;
  c.y = y;
}

const dist = (c, o) => Math.hypot(o.x - c.x, o.y - c.y);

// Breaks one plant (the cheapest object, 2 hp) and returns its info.
async function smashPlant(c, types) {
  const plant = c.welcome.objects
    .filter((o) => o.type === 'plant' && !o.broken)
    .reduce((best, o) => (dist(c, o) < dist(c, best) ? o : best));
  await walkTo(c, plant, 60);
  for (let i = 0; i < types.plant.hp; i++) {
    send(c, { t: 'hit', id: plant.id });
    await sleep(230);
  }
  return plant;
}

module.exports = { sleep, send, client, take, none, walkTo, dist, smashPlant, newToken, WebSocket };
