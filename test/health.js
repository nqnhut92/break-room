'use strict';

// /api/health: the deep check reports the Redis connection count (each game instance holds up to two), and leaves the
// field out when a provider restricts INFO. The real round trip needs Redis (TEST_REDIS_URL, as npm run test:redis sets).
const assert = require('node:assert/strict');
const health = require('../api/health');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('ok - health: ' + name); }

function call(query) {
  return new Promise((resolve) => {
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }); } };
    health({ url: '/api/health' + query }, res);
  });
}

async function main() {
  await check('connection count parsed from INFO clients; restricted INFO leaves it out', async () => {
    const info = '# Clients\r\nconnected_clients:7\r\ncluster_connections:0\r\nmaxclients:30\r\nblocked_clients:0\r\n';
    assert.deepEqual(await health.redisClients({ info: async () => info }), { connected: 7, max: 30 });
    assert.equal(await health.redisClients({ info: async () => { throw new Error('ERR unknown command'); } }), undefined);
    assert.equal(await health.redisClients({ info: async () => '# Clients\r\n' }), undefined);
  });
  const url = process.env.TEST_REDIS_URL;
  if (!url) console.log('SKIP - health: TEST_REDIS_URL not set; the real deep check was not run');
  else await check('deep check against a real Redis reports pingMs, the score queues and the connection count', async () => {
    const saved = { REDIS_URL: process.env.REDIS_URL, HEALTH_KEY: process.env.HEALTH_KEY, GAME_DISABLED: process.env.GAME_DISABLED };
    Object.assign(process.env, { REDIS_URL: url, HEALTH_KEY: 'k' }); delete process.env.GAME_DISABLED;
    try {
      assert.equal((await call('?deep=wrong')).status, 401);
      const { status, body } = await call('?deep=k');
      assert.equal(status, 200, JSON.stringify(body));
      assert.ok(body.clients && body.clients.connected >= 1, 'counts at least its own connection: ' + JSON.stringify(body.clients));
      assert.ok(Number.isInteger(body.clients.max) && body.clients.max >= body.clients.connected);
      assert.equal(typeof body.pingMs, 'number');
    } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  console.log('All ' + passed + ' health checks passed' + (url ? '' : ' (real Redis part skipped)'));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
