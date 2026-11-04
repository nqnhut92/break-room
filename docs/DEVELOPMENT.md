# Development

English · [Tiếng Việt](DEVELOPMENT.vi.md) · [Documentation](README.md)

## Local and multi-instance runs

Local runs need no Redis: all state lives in the RAM of the `npm start` process. To mimic the Vercel setup (several servers sharing state) set `REDIS_URL=redis://localhost:6379` and start `npm start` in two terminals with different `PORT`s; tabs on both ports show the same office. `vercel dev` also works if you need the exact `api/ws.js` function, but it is not required.

## Layout

```
api/ws.js            Vercel function that accepts WebSockets (exports an http server with a WebSocketServer)
api/health.js        reports whether Redis is configured; ?deep=KEY pings Redis for real
api/rooms.js         server list with online counts for the join screen (CDN cached 10 s)
lib/room-list.js     counts players per server with one store command, short in-process cache
scripts/check-store.js  checks whether a given Redis can run the game
lib/realtime.js      game logic and WebSocket wiring, unaware of where it runs
lib/world.js         office layout, object types, obstacles and collision helpers (fixed)
lib/store-redis.js   shared state + pub/sub in Redis (atomic Lua scripts)
lib/store-memory.js  same interface in RAM, for local runs and tests
lib/config.js        picks the store from environment variables
server.js            local run: static files + WebSocket at /api/ws
public/              index.html, style.css, game.js (network, input, HUD, WebAudio sound),
                     scene3d.js (all the three.js code), vendor/ (vendored three.js),
                     assets/textures/ (floor textures, CC0)
test/                world.js (layout, paths), smoke.js (end-to-end, RAM), shared.js (real Redis, two instances)
vercel.json          static directory and maxDuration
docs/                gameplay, deployment, architecture, development and adr/
```

## Tests

```bash
npm test
```

`test/world.js` checks the layout and paths. `test/smoke.js` runs a real server with real WebSockets and the RAM store (including AFK, connection/room limits, name rules and the kill switch). `test/shared.js` runs one store contract against both the RAM and Redis stores, then starts two servers sharing one Redis to play across instances (smash one object from two instances, reconnect to another instance, cross-instance IP limit, sudden instance death). It starts a temporary `redis-server` on a free port by itself; if the machine has no `redis-server`, the Redis part is skipped with a `SKIP` line. Point it at an existing Redis with `TEST_REDIS_URL`. No `redis-server` installed? `npm run test:redis` starts a throwaway Redis container with podman or docker (`scripts/test-with-redis.sh`), runs the full suite and removes the container; the first run pulls `redis:7-alpine`.

## Rendering and library updates

The 3D art uses licensed textures and code-built geometry:

- **Textures** (ambientCG, CC0, `public/assets/textures/`, licence note in `License.txt`): wood, carpet, tile and diamond-plate floors, colour and normal maps at 512 px (about 0.7 MB), tinted in `FLOOR_FILES` in `scene3d.js`. If a file is missing the old canvas-drawn floor is used.
- **Characters are built in code** (`makePlayer` in `scene3d.js`): round "chibi" bodies made of spheres and capsules, four hairstyles, a role hat, and the boss in a navy suit with silver hair. They are animated by code (breathing, bobbing, leaning, squash and stretch, the hammer swing), with no model files.
- **Everything else is built in code** (`public/scene3d.js`) from rounded boxes, ellipsoids, capsules and cylinders: furniture, characters, glass walls, the debris and the effects. There are no model files, so nothing to license and nothing to download. `box()` rounds the edges, `sbox()` keeps them sharp (walls).

Three.js is vendored in `public/vendor/` (MIT, licence included), not loaded from a CDN. To upgrade: `npm install three@<version> --save-dev`, then copy `three.module.min.js` (from `build`) plus `BufferGeometryUtils.js` (from `examples/jsm/utils`) into `public/vendor/`, and `RoundedBoxGeometry.js` and `RoomEnvironment.js` (from `examples/jsm/geometries` and `examples/jsm/environments`) into `public/vendor/jsm/` under the same folder names.

A browser with WebGL is required. Weak phones may stutter; touch screens default to safe mode with native resolution and ground/blob shadows, without a real-time shadow pass. A saved high-mode preference still applies.

## Changing the map and graphics

Room boundaries, doors and shared walls live in `FLOOR_ROOMS` in `lib/world.js`; game server names live in `ROOMS`. `rot`: 0 south, PI/2 east, PI north, -PI/2 west. Preserve object IDs and types because Redis stores state by ID. Layout changes must check object reachability, walkable doors and continuous walls; see [ADR 0004](adr/0004-static-world.md).

Roles in `public/roles.js` must match `ROLE_IDS` in `lib/world.js`. Mana settings live in `MANA` in `lib/realtime.js`.

Both graphics modes render directly to the screen without EffectComposer. Rationale and revisit conditions: [ADR 0003](adr/0003-direct-rendering.md). Viewport rules and device verification: [MOBILE.md](MOBILE.md).

## Renderer checks and mobile performance

WebGL checks run separately from the server suite, using the Playwright dev dependency (pinned for Node 18 support) and Chromium:

```bash
npx playwright install chromium
npm run test:renderer
```

To use an installed Chromium, run `CHROMIUM_PATH=/path/to/chromium npm run test:renderer`. The default fixture is touch; also run `RENDERER_TOUCH=0 npm run test:renderer` for the desktop configuration. The test intercepts a module to inspect internal resources without changing production behavior. It checks safe/high switching, shadow-target disposal, shared materials, player/mini-boss geometry, electric effects, picking and repeated join/leave. Counters include shadow passes; SwiftShader does not measure iPhone FPS.

Player rig geometry is allocated per rig; `ownedMaterials` lists the private ground-shadow/selection-ring materials. Cleanup disposes each owned geometry once and the private electric materials when present; it leaves the shared body and pick materials intact. Moving rigs to shared geometry caches later requires updating ownership and tests.

See [the investigation and hardware acceptance plan](PERFORMANCE.md), [ADR 0005](adr/0005-safe-mode-shadows.md). Original diagnostic probes/captures remain local; the WebGL regression test is distributed in `test/renderer.cjs`.

Run `npm run test:orientation` after installing Chromium as above (or set `CHROMIUM_PATH`) to check the rotation prompt. This keeps real HTML/CSS, game/viewport logic and WebSockets, stubbing only WebGL; it covers pre-join reload, auto-rejoin, disconnects and rejected orientation/fullscreen APIs. See [Mobile](MOBILE.md#orientation-regression-checks).
