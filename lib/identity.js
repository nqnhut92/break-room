'use strict';
const { randomUUID, createHmac } = require('crypto');
const Redis = require('ioredis');
const { createProfiles, nameKey } = require('./profiles');
const { ROOMS } = require('./world');
const context = require('./identity-context');
const { characterActor, guestActor } = require('./daily');
const DAY = 86400;
const error = (message, status = 409) => Object.assign(Error(message), { status });
function createIdentity({ env = process.env, store, profiles = env.DATABASE_URL ? createProfiles(env.DATABASE_URL, { migrationUrl: env.MIGRATION_DATABASE_URL || env.DATABASE_URL }) : null, redis: suppliedRedis, authFetch } = {}) {
  let origin = null;
  try { if (env.AUTH_URL) origin = new URL(env.AUTH_URL).origin; } catch { /* invalid auth config must not stop guest-only startup */ }
  const enabled = !!((!(env.VERCEL || env.NODE_ENV === 'production') || origin?.startsWith('https:')) && (!env.VERCEL || store?.kind === 'redis') && profiles && origin && env.AUTH_SECRET?.length >= 32 && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && (store?.kind !== 'redis' || env.REDIS_URL || env.KV_URL));
  const redis = suppliedRedis || (profiles && (env.REDIS_URL || env.KV_URL) ? new Redis(env.REDIS_URL || env.KV_URL, { maxRetriesPerRequest: 1, connectTimeout: 3000, enableOfflineQueue: false, lazyConnect: true, ...(env.REDIS_TLS_CA ? { tls: { ca: env.REDIS_TLS_CA.replace(/\\n/g, '\n') } } : {}) }) : null);
  redis?.on('error', () => {});
  const sessions = new Map();
  const hooks = {}; // set by the app: hooks.rename(room, actorId, name)
  let connecting;
  async function ready() {
    if (redis?.status === 'wait') connecting = redis.connect().finally(() => { connecting = null; });
    if (connecting) await connecting;
  }
  const sessionKey = (room, sid) => `br:{${room}}:session:${sid}`;
  async function issue(sid, until) {
    if (redis) { await ready(); for (const r of ROOMS) await redis.set(sessionKey(r.id, sid), '1', 'EX', Math.max(1, Math.ceil((until-Date.now())/1000))); }
    else sessions.set(sid, until);
  }
  async function valid(token, room = ROOMS[0].id) {
    if (!token?.accountId || !token.sid || token.until <= Date.now()) return false;
    if (redis) { await ready(); return (await redis.get(sessionKey(room, token.sid))) === '1'; }
    return (sessions.get(token.sid) || 0) > Date.now();
  }
  async function revoke(sid) {
    if (!sid) return;
    if (redis) { await ready(); for (const r of ROOMS) await redis.del(sessionKey(r.id, sid)); }
    else sessions.delete(sid);
  }
  const cookieName = () => (origin?.startsWith('https:') ? '__Secure-' : '') + 'authjs.session-token';
  let imported;
  const imports = () => imported ||= Promise.all([import('@auth/core'), import('@auth/core/providers/google'), import('@auth/core/jwt')]);
  async function token(req) {
    if (!enabled) return null;
    const [, , { getToken }] = await imports();
    const t = await getToken({ req: { headers: new Headers(req.headers) }, secret: env.AUTH_SECRET, cookieName: cookieName(), salt: cookieName() });
    if (!t) {
      if (String(req.headers.cookie || '').includes(cookieName() + '=')) throw error('Phiên đăng nhập đã hết hạn. Đăng nhập lại nhé.', 401);
      return null;
    }
    if (!await valid(t)) throw error('Phiên đăng nhập đã kết thúc. Đăng nhập lại nhé.', 401);
    return t;
  }
  async function authRequest(request) {
    const [{ Auth, customFetch }, { default: Google }] = await imports();
    return Auth(request, {
      basePath: '/api/auth', secret: env.AUTH_SECRET, trustHost: true,
      useSecureCookies: origin.startsWith('https:'),
      providers: [Google({ ...(authFetch ? { [customFetch]: authFetch } : {}), clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, checks: ['pkce', 'state', 'nonce'], authorization: { params: { scope: 'openid email profile' } } })],
      session: { strategy: 'jwt', maxAge: 7 * DAY },
      pages: { error: '/' },
      callbacks: {
        async jwt({ token: t, account, profile }) {
          if (account) {
            if (account.provider !== 'google' || !profile?.sub || profile.sub !== account.providerAccountId) throw error('Không xác minh được Google.', 401);
            t = { accountId: await profiles.account(profile.sub), sid: randomUUID(), until: Date.now() + 7 * DAY * 1000 };
            await issue(t.sid, t.until);
          }
          return await valid(t) ? t : null;
        },
        async session({ session, token: t }) { return { expires: session.expires, authenticated: true }; },
        async redirect({ url }) { return url.startsWith(origin + '/') || url === origin ? url : origin + '/'; },
      },
      events: { async signOut(message) { await revoke(message.token?.sid); } },
      // Provider errors can contain token/connection metadata; show generic errors only.
      logger: { error(e) { console.error('[auth]', e.type || 'error'); }, warn() {}, debug() {} },
    });
  }
  function allowedOrigin(req) {
    if (!req.headers.origin) return !enabled; // browser upgrades must have Origin with auth enabled
    return req.headers.origin === (origin || `http://${req.headers.host}`);
  }
  function accountToken(character) { return 'account_' + createHmac('sha256', env.AUTH_SECRET).update(character.id).digest('hex').slice(0,48); }
  async function join(room, opts, auth, bot = false) {
    // Leaderboard participant: callers pass the guest/bot one; a signed-in character replaces it below.
    if (!opts.aid) opts = { ...opts, aid: guestActor(room, opts.token) };
    if (!profiles) return { ...await store.join(room, opts), aid: opts.aid };
    try {
      return await profiles.transaction(room, async c => {
        if (auth) {
          if (!await valid(auth, room)) throw error('Phiên đã hết hạn.', 401);
          const ch = await profiles.get(c, auth.accountId, room);
          if (!ch) throw error('Tạo nhân vật cho phòng này trước khi vào nhé.', 400);
          opts = { ...opts, name: ch.name, gender: ch.gender, role: ch.role, company: ch.company, token: accountToken(ch), characterId: ch.id, aid: characterActor(ch.id) };
        } else {
          // Reserved namespace is server-generated only, never user-selected.
          if (opts.name.startsWith('~')) throw error('Tên bắt đầu bằng ~ được dành cho khách tạm.', 400);
          if (await profiles.reserved(c, room, nameKey(opts.name))) return { taken: true };
          opts = { ...opts, token: 'guest_' + opts.token };
        }
        const snapshot = await store.read(room, { now: Date.now(), ttlMs: 20000 });
        const ownId = await store.tokenId(room, opts.token);
        if (snapshot.players.some(p => p.id !== ownId && nameKey(p.name) === nameKey(opts.name))) return { taken: true };
        const result = await store.join(room, { ...opts, nameKey: nameKey(opts.name) });
        return { ...result, profile: { name: opts.name, gender: opts.gender, role: opts.role, company: opts.company }, characterId: opts.characterId, aid: opts.aid };
      });
    } catch (e) {
      if (auth || e.status) throw e;
      if (bot) return { taken: true }; // no new NPC identity while reservations cannot be verified
      const temporary = '~' + createHmac('sha256', 'guest-namespace').update(opts.token).digest('hex').slice(0,12);
      return { ...await store.join(room, { ...opts, name: temporary, nameKey: temporary, token: 'temporary_' + opts.token }), profile: { name: temporary, gender: opts.gender, role: opts.role, company: opts.company }, temporary: true, aid: opts.aid };
    }
  }
  async function owned(ws, fn) {
    if (!ws.auth) return fn();
    if (!await valid(ws.auth, ws.room.name) || !await store.isOwner(ws.room.name, ws.player.id, ws.connId)) throw error('Phiên chơi đã kết thúc.', 401);
    return context.run({ room: ws.room.name, id: ws.player.id, conn: ws.connId, sid: ws.auth.sid, valid: () => (sessions.get(ws.auth.sid) || 0) > Date.now() }, fn);
  }
  async function http(req, res) {
    const url = new URL(req.url, origin || `http://${req.headers.host}`);
    if (!url.pathname.startsWith('/api/auth/') && url.pathname !== '/api/profile') return false;
    res.setHeader('Cache-Control', 'no-store');
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      if (url.pathname === '/api/auth/status') {
        if (!enabled) { json(200, { enabled: false }); return true; }
        let t;
        try { t = await token(req); } catch (e) { if (e.status !== 401) throw e; json(200, { enabled: true, authenticated: false, expired: true }); return true; }
        json(200, { enabled: true, authenticated: !!t }); return true;
      }
      if (!enabled) { json(503, { error: 'Đăng nhập chưa được cấu hình.' }); return true; }
      if (req.method !== 'GET' && !allowedOrigin(req)) throw error('Yêu cầu không hợp lệ.', 403);
      if (url.pathname.startsWith('/api/auth/')) {
        const body = await readBody(req);
        const request = new Request(origin + url.pathname + url.search, { method: req.method, headers: req.headers, ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body }) });
        const response = await authRequest(request);
        res.statusCode = response.status;
        for (const [k,v] of response.headers) if (k !== 'set-cookie') res.setHeader(k,v);
        const cookies = response.headers.getSetCookie();
        if (cookies.length) res.setHeader('Set-Cookie', cookies);
        res.end(Buffer.from(await response.arrayBuffer())); return true;
      }
      const auth = await token(req);
      if (!auth) throw error('Đăng nhập trước nhé.', 401);
      const room = url.searchParams.get('room');
      if (!ROOMS.some(r => r.id === room)) throw error('Phòng không hợp lệ.', 400);
      if (!['GET','POST','PATCH'].includes(req.method)) throw error('Phương thức không hợp lệ.', 405);
      let input = null;
      if (req.method !== 'GET') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw error('Yêu cầu hồ sơ không hợp lệ.', 400);
        try { input = JSON.parse(await readBody(req)); } catch (e) { if (e.status) throw e; throw error('Hồ sơ không hợp lệ.', 400); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('Hồ sơ không hợp lệ.', 400);
      }
      const ch = await profiles.transaction(room, async c => {
        const current = await profiles.get(c, auth.accountId, room);
        if (!input) return current;
        if (req.method === 'POST' && current) throw error('Phòng này đã có nhân vật; hãy khôi phục hồ sơ đã lưu.');
        if (req.method === 'PATCH' && !current) throw error('Chưa có nhân vật.', 404);
        const online = await store.read(room, { now: Date.now(), ttlMs: 20000 });
        if (current && await store.tokenOnline(room, accountToken(current))) throw error('Nhân vật đang chơi ở thiết bị khác. Ra khỏi phòng trước khi sửa nhé.');
        if (online.players.some(p => nameKey(p.name) === nameKey(input.name))) throw error('Tên đang có người dùng trong phòng. Ra khỏi phòng hoặc chọn tên khác nhé.');
        return profiles.save(c, auth.accountId, room, input, current);
      });
      // The day board shows the new name; chat already sent keeps the name it was sent under.
      if (req.method === 'PATCH' && ch) await hooks.rename?.(room, characterActor(ch.id), ch.name).catch(() => {});
      // No account ids, session secrets or internal timestamps in player-facing response.
      json(200, { character: ch && { id: ch.id, name: ch.name, gender: ch.gender, role: ch.role, company: ch.company } });
    } catch (e) {
      json(e.status || (e.code === '23505' ? 409 : 503), { error: e.status ? e.message : e.code === '23505' ? 'Tên đã được giữ cho nhân vật khác trong phòng này.' : 'Chưa tải được hồ sơ. Thử lại sau nhé; bạn vẫn có thể chơi khách.' });
    }
    return true;
  }
  return { enabled, profiles, hooks, allowedOrigin, token, valid, revoke, issue, join, owned, http, sessionKey, sessions, accountToken, authRequest,
    close: async () => { if (redis && !suppliedRedis) redis.disconnect(); await profiles?.close(); } };
}
async function readBody(req) {
  // Vercel's Node bridge may already have consumed and parsed the stream.
  if (req.body !== undefined) {
    const parsed = req.body;
    const body = typeof parsed === 'string' || Buffer.isBuffer(parsed) ? String(parsed)
      : String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded') ? new URLSearchParams(parsed).toString() : JSON.stringify(parsed);
    if (Buffer.byteLength(body) > 8192) throw error('Yêu cầu quá dài.', 413);
    return body;
  }
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
    if (size > 8192) throw error('Yêu cầu quá dài.', 413);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
module.exports = { createIdentity };
