# Accounts and room characters (phase 1)

[Tiếng Việt](IDENTITY.vi.md) · [Documentation](README.md) · [Decision](adr/0006-account-identity.md)

## Player behavior

Guests can play without signing in or creating database records. Google sign-in saves one character per account per room. BR-1 and BR-2 have independent character IDs and profiles, including when their display names match. Google names and email addresses never overwrite character profiles and are not ownership evidence.

Sign-in returns to the join screen, not gameplay. Outside the room, select a room: its saved character loads automatically. If none exists, fill the visible profile and click “Tạo nhân vật & vào phòng” to create it and join in one explicit action. Creating copies only name, gender, role and company; it neither claims an existing player by name nor transfers guest scores. Leave the guest room before creating; if its name is still online elsewhere, creation is rejected. Existing characters are restored instead of being overwritten by guest defaults. Saved profiles display as a read-only summary; “Sửa nhân vật” reveals the editor. A second authenticated device can join the same character and replaces the first controlling connection. Reconnect/renewal retains the existing Redis slot while it survives.

Edit name, gender, job and company outside gameplay through “Sửa nhân vật”. The primary “Lưu & vào phòng” action saves changes before joining; cancel restores the saved profile. The backend rejects edits while that character is online on any device, including the editing browser. Renaming preserves the character UUID. A stale close cannot remove the replacement connection or save old health/rage over it. Logout, revocation and expiry end account play; they never turn a live character into a guest. Control actions check session validity and ownership; an idle socket is closed by a one-second Redis-only poll.

Scores remain transient Redis gameplay data. They are not saved in Postgres, merged from guests, or guaranteed across Redis loss. Daily room leaderboards (midnight Asia/Ho_Chi_Minh), score synchronization/guest transfer, and 24-hour chat retention are planned later phases, not current features. There is no all-time leaderboard or winner history. Bots have no persistent account/character rows and no new public identity flags.

## Names and failure behavior

Display names are Unicode NFC, stripped of control characters and angle brackets, whitespace collapsed, trimmed, and limited to the existing 14 UTF-16-unit application limit. Company names use the existing 20-unit limit. The server validates the existing gender/job choices. The canonical name key is the normalized name in lowercase; case changes do not create a distinct reservation. Display casing is preserved. There is no accent stripping or email matching. Application and database lowercase behavior must agree; test the deployment database locale when changing supported alphabets.

Registered names stay reserved per room even while offline. Guests and bots cannot use them. Names also conflict case-insensitively with every online actor. Profile create/edit and human/bot join take the same Postgres transaction advisory lock for that room and check Redis presence while holding it. SQL unique constraints separately protect account/room and room/name races. This is coordination across SQL and Redis, not a claim that a SQL transaction rolls back Redis. A failed join/commit can leave a short-lived presence until the normal lease expires; it grants no ownership by name.

If reservations cannot be read, accounts receive an explicit error and new bots are deferred. Guests receive a server-generated `~…` temporary name in a namespace that registered profiles and user-selected guest names cannot use. This protects offline reservations while allowing guest play when Redis works. Existing players do not query Postgres during movement, frames or heartbeats and can continue through a database outage. Missing auth/database configuration leaves local guest play available; Google controls are hidden. Pending schema migrations run automatically before the first profile database operation in each instance. If initialization fails, it is an error, not evidence of an empty reservation table.

## Configuration

Use Node 20+ with Web Crypto (validated on Node 24). Install with `npm ci`. Copy [.env.example](../.env.example) to an ignored `.env` if desired; the server does not implicitly load it. Export variables or use `node --env-file=.env server.js` on Node 20.6+.

- `DATABASE_URL`: Neon **pooled** Postgres URL for runtime. The pool has max 3 connections, 3-second acquisition/connection timeout, 5-second statements, 6-second query timeout and 10-second idle timeout. Preserve TLS certificate verification; use `sslmode=verify-full` with normal trusted roots. Size connection limits for concurrent Vercel instances, not just one pool.
- `MIGRATION_DATABASE_URL`: optional migration connection to the **same database**, preferably direct/unpooled if using a separate schema-owner role. If omitted, migrations use `DATABASE_URL`; no extra variable is required. The selected migration role needs schema/DDL permissions.
- `AUTH_URL`: canonical origin, `http://localhost:3111` locally or `https://break-room.congtynhu.cc` in production. Do not infer the trusted origin from arbitrary forwarded headers. Preview hosts need their own app/origin/callback configuration.
- `AUTH_SECRET`: independently generated random secret, at least 32 characters. Treat it as a credential; never expose it to the browser.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: OAuth web-client credentials, server-side only.
- `REDIS_URL` (or existing `KV_URL`): shared Redis for gameplay and session revocation across production instances. Local single-process play can use RAM; RAM sessions do not survive restart. Redis loss invalidates account sessions; signing in again recreates them.

In Google Cloud Console → Google Auth Platform, configure Branding and External Audience. While Testing, add test users. Create a **Web application** client. Use only `openid email profile`. Add `congtynhu.cc` as an authorized domain when required. Register JavaScript origins `http://localhost:3111` and `https://break-room.congtynhu.cc`, and these exact redirect URIs:

```text
http://localhost:3111/api/auth/callback/google
https://break-room.congtynhu.cc/api/auth/callback/google
```

Set environment variables securely in Vercel for the intended environment. Vercel settings do not automatically inject credentials into the Codex machine. When opening access beyond test users, publish the Google consent app after configuring its required public disclosures. Do not put secrets in source, browser storage, URLs, or logs.

## Migrations and rollout

Schema initialization is automatic: before the first account/profile/reservation database operation in an instance, the app applies pending versioned SQL. A successful initialization is cached in that process. Redis gameplay and movement do not run migrations or query Postgres. Missing database configuration still permits guest-only local play.

A transaction advisory lock serializes simultaneous cold starts, including through Neon transaction pooling. SQL changes and `schema_migrations` entries commit together; failure rolls both back and a later request can retry. Already applied versions are skipped, so restarts and redeployments do not rerun the initial schema, reset characters, or reseed user data. Add a new migration file for schema changes; do not edit an applied migration. The temporary migration pool has at most one connection and bounded connection, lock and statement timeouts, then closes. Vercel functions explicitly include `migrations/*.sql` in their bundles.

With `DATABASE_URL` configured and a schema-capable role, deployment requires no manual migration command. If separate runtime/migration roles are used, set `MIGRATION_DATABASE_URL` to the same database. The optional manual command uses that override or falls back to `DATABASE_URL`:

```bash
npm run db:migrate
```

Build/install do not connect to the database. Automatic initialization happens in the running app, before it accesses profile tables. Validate migrations on a disposable database before shipping them. This implementation task does not connect to or migrate production. Keep old and new application versions from concurrently bypassing the reservation protocol; use a controlled rollout and disconnect old game instances before enabling account creation. Existing transient guest data is not imported by matching names.

Auth.js Core owns OIDC state/nonce/PKCE, CSRF for sign-in/out, and encrypted HttpOnly session cookies (Secure on HTTPS, SameSite=Lax). Tokens contain only internal account ID, a random revocable session ID and expiry, not Google access/refresh tokens. The absolute session lifetime is seven days. Runtime session validity lives in Redis, not Postgres; no `auth_sessions` SQL table is needed for this JWT strategy. Profile mutations additionally require an exact Origin match, JSON bodies, authenticated session and backend ownership. WebSocket Origin is checked against `AUTH_URL`; reconnect tokens never authenticate accounts.

## Validation and remaining live checks

```bash
npm test
npm run test:redis
npm run test:identity
CHROMIUM_PATH=/usr/bin/chromium npm run test:account-ui
CHROMIUM_PATH=/usr/bin/chromium npm run test:orientation
CHROMIUM_PATH=/usr/bin/chromium npm run test:settings
```

`test:identity` uses fresh Docker/podman Postgres 16 and Redis 7 containers and explicit test-only connection URLs. It does not use `DATABASE_URL`, `MIGRATION_DATABASE_URL` or a production Redis. It exercises automatic/concurrent cold-start migration, repeated initialization without data loss, failed-DDL rollback/retry, account callback concurrency, uniqueness, restoration/edit authorization, SQL/Redis name races, guest fallback, ownership fences, real WebSockets, logout/expiry and a mock Google OIDC flow through Auth.js. Mock provider tests are not live Google verification. `npm test` without `redis-server` can report SKIP; only a complete Redis run validates that portion.

Before production rollout, separately verify real Google consent/callback, canonical-domain cookies, Neon pooled TLS/locale behavior, Redis connectivity, and account creation/restoration on two physical devices. Browser tests with software rendering do not establish iPhone behavior or performance. Review Auth.js release notes and rerun callback/security tests when upgrading its pinned core integration.
