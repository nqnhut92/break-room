'use strict';

// Each suite gets its own process: several fixtures replace globals or exit explicitly.
const { spawn } = require('node:child_process');
const path = require('node:path');

const unit = ['viewport', 'world', 'boss', 'snakes', 'duel'];
const memory = ['smoke', 'boss-net', 'moles', 'miniboss', 'actor-collision',
  'object-respawn', 'duel-realtime', ...unit];
const redis = ['office-patrol', 'profk', 'health'];
const jobs = Number(process.env.TEST_JOBS || 4);
if (!Number.isInteger(jobs) || jobs < 1) {
  console.error('TEST_JOBS must be a positive integer');
  process.exit(1);
}
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--unit')) {
  console.error('Usage: node scripts/test.js [--unit]');
  process.exit(1);
}
const children = new Set();
let interrupted = 0;
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    interrupted = code;
    for (const child of children) child.kill(signal);
  });
}
function run(files, concurrency, inMemory = false) {
  if (interrupted) return Promise.resolve(interrupted);
  // RAM suites cannot accidentally connect to a developer's Redis, nor add traffic
  // to shared.js's global PUBLISH counter or receive its deploy announcements.
  const env = { ...process.env };
  if (inMemory) for (const key of ['REDIS_URL', 'KV_URL', 'TEST_REDIS_URL', 'VERCEL']) delete env[key];
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec',
      `--test-concurrency=${concurrency}`, ...files.map(name => `test/${name}.js`)], {
      cwd: path.resolve(__dirname, '..'), stdio: 'inherit', env,
    });
    children.add(child);
    child.on('error', error => { console.error(error.message); resolve(1); });
    child.on('close', code => { children.delete(child); resolve(code ?? 1); });
  });
}
async function redisLane(concurrency) {
  const code = await run(redis, concurrency);
  if (code) return code;
  // shared.js emits global deploy notices and measures Redis-wide PUBLISH counts.
  // Other Redis suites must finish first; RAM suites may keep running alongside it.
  return run(['shared'], 1);
}
async function main() {
  if (args.includes('--unit')) return run(unit, jobs, true);
  if (jobs === 1) {
    const code = await run(memory, 1, true);
    return code || redisLane(1);
  }
  const redisJobs = Math.min(2, Math.floor(jobs / 2));
  const codes = await Promise.all([run(memory, jobs - redisJobs, true), redisLane(redisJobs)]);
  return codes.find(code => code !== 0) || 0;
}
main().then(code => { process.exitCode = interrupted || code; }).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
