# Development

English · [Tiếng Việt](DEVELOPMENT.vi.md) · [Documentation](README.md)

## Local and multi-instance runs

Local runs need no Redis: all state lives in the RAM of the `npm start` process. To mimic the Vercel setup (several servers sharing state) set `REDIS_URL=redis://localhost:6379` and start `npm start` in two terminals with different `PORT`s; tabs on both ports show the same office. `vercel dev` also works if you need the exact `api/ws.js` function, but it is not required.

## Layout

```
api/ws.js            Vercel function that accepts WebSockets (exports an http server with a WebSocketServer)
api/health.js        reports whether Redis is configured; ?deep=KEY pings Redis for real and reports its connection count
api/rooms.js         server list with online counts for the join screen (CDN cached 10 s)
lib/room-list.js     counts players per server with one store command, short in-process cache
scripts/check-store.js  checks whether a given Redis can run the game
lib/realtime.js      game logic and WebSocket wiring, unaware of where it runs
lib/world.js         office layout, object types, obstacles and collision helpers (fixed)
lib/store-redis.js   shared state + pub/sub in Redis (atomic Lua scripts)
lib/store-memory.js  same interface in RAM, for local runs and tests
lib/config.js        picks the store from environment variables
server.js            local run: static files + WebSocket at /api/ws
public/              index.html, style.css, game.js (network, input, HUD), audio.js (WebAudio sound),
                     scene3d.js (all the three.js code), vendor/ (vendored three.js),
                     assets/textures/ (floor textures, CC0), assets/audio/ (impact sounds, CC0)
test/                world.js (layout, paths), smoke.js (end-to-end, RAM), shared.js (real Redis, two instances)
vercel.json          static directory and maxDuration
docs/                gameplay, deployment, architecture, development and adr/
```

## Tests

```bash
npm test
```

`test/world.js` checks the layout and paths. `test/smoke.js` runs a real server with real WebSockets and the RAM store (including AFK, connection/room limits, name rules and the kill switch). `test/shared.js` runs one store contract against both the RAM and Redis stores, then starts two servers sharing one Redis to play across instances (smash one object from two instances, reconnect to another instance, cross-instance IP limit, sudden instance death). It starts a temporary `redis-server` on a free port by itself; if the machine has no `redis-server`, the Redis part is skipped with a `SKIP` line. Point it at an existing Redis with `TEST_REDIS_URL`. No `redis-server` installed? `npm run test:redis` starts a throwaway Redis container with podman or docker (`scripts/test-with-redis.sh`), runs the full suite and removes the container; the first run pulls `redis:7-alpine`.

### Fast feedback and full validation

`npm test` runs the same gameplay/store suites in separate Node processes, up to four at once, and reports suite durations. RAM and Redis suites use separate concurrent lanes (two slots each by default). The RAM lane removes Redis URL variables from its child environment. In the Redis lane, `office-patrol`, `profk` and `health` finish before `shared.js` starts: its global deploy announcements and Redis-wide PUBLISH measurements must not affect other Redis fixtures. RAM suites can continue alongside `shared.js`. `TEST_JOBS=1 npm test` restores serial execution for debugging; lower `TEST_JOBS` on a small machine if network waits time out. No game cooldown or negative-assertion observation window is shortened. The store lease contract uses a 250 ms fixture TTL and waits 350 ms for expiry instead of testing a 3 s lease in real time.

| Change / purpose | Command |
| --- | --- |
| Quick layout and pure rules feedback | `npm run test:unit` (viewport, world, boss, snakes, duel; no Redis/network integration) |
| One feature while editing | `node test/moles.js`, or the relevant `test:*` browser command |
| Final gameplay/server/store validation, or changes to shared test helpers/runner | `npm run test:redis` (includes `npm test`; do not run both again on unchanged code) |
| Renderer, controls, CSS or other UI | Relevant browser suites; add gameplay/store validation if server behavior changes |
| Documentation only | Content and local link checks |

There is no repository pre-commit hook or CI workflow that automatically runs everything. `AGENTS.md` requires the full Redis run for changes under `lib/`. Run focused checks during editing, then the required full validation once on the final changes. `test:unit` is fast feedback, not a replacement for integration coverage. Identity and Postgres score tests remain separate commands below; `npm test` does not run all browser/database suites.

## Rendering and library updates

The 3D art uses licensed textures and code-built geometry:

- **Textures** (ambientCG, CC0, `public/assets/textures/`, licence note in `License.txt`): wood, carpet, tile and diamond-plate floors, colour and normal maps at 512 px (about 0.7 MB), tinted in `FLOOR_FILES` in `scene3d.js`. If a file is missing the old canvas-drawn floor is used.
- **Characters are built in code** (`makePlayer` in `scene3d.js`): round "chibi" bodies made of spheres and capsules, four hairstyles, a role hat, and the boss in a navy suit with silver hair. They are animated by code (breathing, bobbing, leaning, squash and stretch, the hammer swing), with no model files.
- **Everything else is built in code** (`public/scene3d.js`) from rounded boxes, ellipsoids, capsules and cylinders: furniture, characters, glass walls, the debris and the effects. There are no model files, so nothing to license and nothing to download. `box()` rounds the edges, `sbox()` keeps them sharp (walls).
- **Wrecks** (`buildWreck` in `scene3d.js`) are built from the object's own parts when its model is first needed: free-standing things topple (wall-side ones forward), desks and tables collapse onto their legs, boxy machines are crushed, porcelain and sofas shatter, lamps and coat racks snap at the pole. Screens go dark and monitors/TVs crack; a few parts and chips lie around. Each type has `WRECK_VARIANTS` variants and the object ID picks one, so every client (also a late joiner) sees the same wreck. Non-desk-top wrecks get a canvas-drawn floor mark (scorch for electronics, water, soil or dust). A screen or laptop on a desk or table that collapses falls onto the wreck's top, and stands again when the desk is replaced.
- **Uneven light without extra lights** (`buildFloorLight`, `buildContactShadows`): three merged, depth-write-free floor layers, one draw call each: darker strips at the foot of every wall, soft contact shadows under furniture (built once the objects arrive) and additive pools under the ceiling panels, tinted per room name (`ROOM_LIGHT`; corridors get dimmer ones). The renderer receives the room rectangles as the fourth `build()` argument. Their heights and render order are fixed in `FLOOR_LAYER`, above the rugs (1.8) and apart from the wreck marks (2.0–2.24), so no two layers share a height.
- **Soft transparent textures are computed, not drawn on a canvas** (`makeAlphaTexture`, `paintMarks`). WebKit (Safari, and Edge or Chrome on iPhone and iPad) dithers canvas gradients; where alpha is nearly zero the upload's un-premultiply turns that noise into coloured specks across the floor. The floor pools, wall feet, contact shadows, wreck marks and window sunlight are built pixel by pixel as `DataTexture`s. Desktop Chromium does not dither, so test new soft overlays on an iPhone or iPad.
- **Shadows and materials for Safari** (`fitShadowBox`, `NO_SHADOW_ON_TOUCH`): the sun's shadow box is fitted every frame to the ground the camera sees (in light space, with a margin, snapped to 40 units), not a square sized from the camera distance; on touch screens screens, laptops and bins cast no real-time shadow; untouched objects share `bodyMat` and get a private copy only while damaged, flashing or electrified. Measurements and reasons: [Performance](PERFORMANCE.md#high-mode-on-ipad-and-iphone-november-2026).

Three.js is vendored in `public/vendor/` (MIT, licence included), not loaded from a CDN. To upgrade: `npm install three@<version> --save-dev`, then copy `three.module.min.js` (from `build`) plus `BufferGeometryUtils.js` (from `examples/jsm/utils`) into `public/vendor/`, and `RoundedBoxGeometry.js` and `RoomEnvironment.js` (from `examples/jsm/geometries` and `examples/jsm/environments`) into `public/vendor/jsm/` under the same folder names.

A browser with WebGL is required. Weak phones may stutter; touch screens default to safe mode with native resolution and ground/blob shadows, without a real-time shadow pass. A saved high-mode preference still applies.

## Changing the map and graphics

Room boundaries, doors and shared walls live in `FLOOR_ROOMS` in `lib/world.js`; game server names live in `ROOMS`. `rot`: 0 south, PI/2 east, PI north, -PI/2 west. Floor zones at the same height may share edges but must not overlap: coplanar faces can flicker during camera movement in either graphics mode. `test/world.js` checks this invariant. Floating room-name signs have been removed from props/rendering; room names remain layout metadata. Preserve object IDs and types because Redis stores state by ID. Layout changes must check object reachability, walkable doors and continuous walls; see [ADR 0004](adr/0004-static-world.md).

Roles in `public/roles.js` must match `ROLE_IDS` in `lib/world.js`. Mana settings live in `MANA` in `lib/realtime.js`.

Both graphics modes render directly to the screen without EffectComposer. Rationale and revisit conditions: [ADR 0003](adr/0003-direct-rendering.md). Viewport rules and device verification: [MOBILE.md](MOBILE.md).

## Sound

`public/audio.js` mixes Kenney CC0 material impacts with synthesized weapon accents. The 27 mono PCM WAVs in `public/assets/audio/` load/decode only after sound is enabled by a gesture; missing samples use a short synthesis fallback without delaying gameplay. Voices clean up on end, mute stops active/scheduled sources, and at most 24 layers play together. Distance gain falls quadratically to zero at 1,000 world units. A shared compressor plus a soft output ceiling handles coincident hits; a nearby layer can replace a quieter distant one. Regular VKL windups are silent; special abilities retain short cues. Material hits, breaks, boss strikes and boss defeat use separate events. A boss strike on a body is the Kenney heavy punch over a soft thud, with no metal ring. During an office patrol, `audio.music(level)` plays a tense loop synthesised with Web Audio (no downloaded track, nothing to license): level 1 is the heartbeat bass of the warning, level 2 the full hunt loop, 0 fades it out; mute silences it.

Run `npm run test:audio` with Chromium/`CHROMIUM_PATH`: gesture loading, all WAV decodes, normal/special windups, mute, offline material/body renders, crowd peak bounds and distance silence. Automated renders cannot judge subjective punch or device speaker balance; compare repeated wood/metal/glass hits, breaks, boss combat and busy rooms on iPad speakers and headphones. Sample origin/conversion details and the original CC0 notice sit beside the WAVs.

## Renderer checks and mobile performance

WebGL checks run separately from the server suite, using the pinned Playwright dev dependency and Chromium. Use the project’s Node.js 20+ runtime:

```bash
npx playwright install chromium
npm run test:renderer
```

To use an installed Chromium, run `CHROMIUM_PATH=/path/to/chromium npm run test:renderer`. The default fixture is touch; also run `RENDERER_TOUCH=0 npm run test:renderer` for the desktop configuration. The test intercepts a module to inspect internal resources without changing production behavior. It checks safe/high switching, shadow-target disposal, shared materials, player/mini-boss geometry, electric effects, picking and repeated join/leave. Counters include shadow passes; SwiftShader does not measure iPhone FPS.

Player rig geometry is allocated per rig; `ownedMaterials` lists the private ground-shadow/selection-ring materials. Cleanup disposes each owned geometry once and the private electric materials when present; it leaves the shared body and pick materials intact. Moving rigs to shared geometry caches later requires updating ownership and tests.

See [the investigation and hardware acceptance plan](PERFORMANCE.md), [ADR 0005](adr/0005-safe-mode-shadows.md). Original diagnostic probes/captures remain local; the WebGL regression test is distributed in `test/renderer.cjs`.

Run `npm run test:orientation` after installing Chromium as above (or set `CHROMIUM_PATH`) to check the rotation prompt. This keeps real HTML/CSS, game/viewport logic and WebSockets, stubbing only WebGL; it covers pre-join reload, auto-rejoin, disconnects and rejected orientation/fullscreen APIs. See [Mobile](MOBILE.md#orientation-regression-checks).

Run `npm run test:joystick` (Chromium/`CHROMIUM_PATH`) for joystick lifecycle checks, including second-finger taps on action buttons while the pad is held. `npm run test:install` checks the Home Screen gate (phones and tablets in a browser tab get install steps instead of the join form) on emulated iPhone/iPad (Safari and Edge)/Android/desktop. The game exempts automated browsers (`navigator.webdriver`) from the gate so the other touch suites can join; that suite turns the exemption off. It combines native Chromium touch input with fault-injected missing events to check direction, held touches, simultaneous attack, capture loss and chat focus. This does not establish the exact Safari failure; see [Mobile](MOBILE.md#joystick-recovery) and repeat on hardware.

Run `npm run test:settings` (Chromium/`CHROMIUM_PATH`) for paired button alignment, the full-width Call IT row, preserved listeners/state and desktop toolbar placement. `SETTINGS_REAL_RENDERER=1` enables a real-WebGL smoke test; see [Mobile](MOBILE.md#settings-layout). Renderer checks also move the camera across the former overlapping floor boundary in safe/high; moving-scene checks on actual hardware are still needed.

Tune automatic IT policy in `lib/object-respawn.js`: constants are shared by RAM and Lua. `test/object-respawn.js` checks examples/bounds/monotonicity; `test/shared.js` runs the same contract on RAM/Redis, including bots, stale presence, batch consistency, changing population and competing Redis clients. Run `npm run test:redis`; positive `RESPAWN_MS` remains a fixed-delay override for fast tests.

## Score and chat validation

`npm run test:scores` (`scripts/test-scores.sh`, podman or docker) starts disposable Postgres 16 and Redis 7 and runs `test/scores.js` against both the RAM and Redis stores: every payout source in tenths, ack loss and two concurrent workers, midnight with an injected clock and late sync, guest transfer with queued events and late events, ties/rename, queue overflow, Redis data loss and room-TTL expiry, Postgres outage/recovery and retention, chat idempotency/pagination/24 h filter, and a real WebSocket run (board rows, chat ack/failure/history, no internal ids on the wire). It never reads `DATABASE_URL`/`REDIS_URL`. `npm test` and `npm run test:redis` cover the Lua scripts through the store contract and gameplay suites.

## Identity validation

Use Node 20+ (Node 24 validated). Run `npm run test:identity` for disposable Postgres/Redis, migrations and mock Google OIDC through Auth.js. The runner never reads production database URLs. See [identity validation](IDENTITY.md#validation-and-remaining-live-checks); mock authentication does not verify live Google/Neon. Use `CHROMIUM_PATH` for installed browsers as above.

On constrained cloud machines, `TEST_WAIT_FACTOR=3 npm test` (or `TEST_WAIT_FACTOR=3 npm run test:redis`) extends only positive network-result/join waits in shared helpers. It does not alter game cooldowns, negative assertions or the default test timing.

Schema initialization is automatic on first profile database use. `test:identity` covers simultaneous instances, repeated startup preserving existing rows, and transactional rollback/retry. Optional `npm run db:migrate` uses `MIGRATION_DATABASE_URL` or `DATABASE_URL`; tests use only disposable targets.

The account UI browser suite checks laptop/touch columns, Google submission, online-count colors and the single create/edit/enter primary action. `test/actor-collision.js` covers swept actor bodies, sliding, wall safety, neutral NPC avoidance and real WebSocket passage before/after boss death; it runs in `npm test`.

Saved characters render as a read-only summary; edit mode reveals the form. Account browser checks cover complete inset focus outlines, keyboard/pointer gender selection, focus return after cancel, and visually hidden native radios during pending saves.


`test/office-patrol.js` is part of `npm test`/`npm run test:redis`: it checks rack support caps/reset/respawn/bounty, fractional electricity, global boss navigation/return, mini targeting, concealed-mole behavior, version/lease fences, real WebSocket HP loss and Redis multi-instance event/reconnect/runner handover. `CHROMIUM_PATH=/path/to/chromium npm run test:office-ui` checks real WebGL electric arcs and the noninteractive banner below the header on desktop and mobile.


`CHROMIUM_PATH=/path/to/chromium npm run test:minimap` covers hidden-HUD sizing, auto-rejoin, resizing and map/chat/joystick separation. `npm run test:mobile-safe-area` uses injected cutout/navigation insets and stale-height fault injection; real-WebGL safe-area previews are in `npm run test:office-ui`. See [Mobile](MOBILE.md#safe-areas-and-rotation-previews) for sources and physical-device checks.


`npm run test:mobile-chat` (Chromium/`CHROMIUM_PATH`) verifies populated fixed-size mobile chat, long-message wrapping and unchanged tap behavior; `CHAT_REAL_RENDERER=1` captures the Pro Max-size layout with actual WebGL. See [mobile chat layout](MOBILE.md#mobile-chat-layout) for interaction and hardware limits.

## Population, navigation and map verification

`test/shared.js` covers private human-only population tiers against memory/Redis, threshold timing and interruption, concurrent growth/hits, leader handover, percentage ultimate/rack damage, wave retention, reconnects, respawn and live two-server HP propagation. `test/miniboss.js` checks normalized diagonal movement and full-body clearance through wall/furniture routes. Closed rooms have one designated doorway; working areas are explicitly open. Layout regressions cover continuous closed-room walls outside those doorways, walkable doors, reachability and nonoverlapping floor zones; preserve existing object IDs/types when editing.

`npm run test:minimap` checks touch toggle/close, desktop hold-Tab with walking, release/blur cleanup, typing exclusions, circular radar sizing, centered player, edge fading, distant-boss clipping, preserved M behavior and out-of-order health updates. `RENDERER_TOUCH=0 npm run test:renderer` and the default touch run check desktop/tablet-only boss mottos and resource cleanup. These are browser/software-WebGL checks, not physical-device performance results.

Rebuild both README panorama and annotated plan with `CHROMIUM_PATH=/path/to/chromium node scripts/capture-office.cjs`. The script serves the current world/renderer with an overview-only camera override; it does not alter game camera limits or spawn. Inspect both `artifacts/map-ingame.png` and `artifacts/map-overview.png` before committing. The panorama contains rendered office geometry; the plan's room names are editing annotations.


## Open office layout

The floor plan is authored at full scale (`LAYOUT_SCALE` is 1). Open workspace metadata (`WEST WORKSPACE`, `EAST WORKSPACE`) skips partition generation; closed meeting/server/restroom rooms retain merged walls and doors. Workspace seats come from `islands()` (six-seat island desks with two arm monitors); only the director keeps a single-monitor desk. New objects append after the existing ones; `test/world.js` fingerprints the ID and type of every object that existed before the current layout, so positions may move but identities may not. `serverPoint` uses local coordinates relative to `SERVER_ROOM`; racks, boss routes and duel landing share that origin. `WORLD.duelDoor` supplies the actual server doorway (and its axis) to the renderer, the boss apron and duel expulsion; `WORLD.bannerX` places the north-wall banner in the town hall. Never hardcode door coordinates. Test reachability, all closed doors, nonoverlapping floor zones, full boss patrol/chase, captured movement/reconnect and a complete Redis run after edits.

PCM playback preserves natural sample envelopes and fades only the last 12 ms. Recorded glass shatter/wood splinter/metal slam layers distinguish destruction from ordinary hits. Boss attacks have a separate priority bus and briefly duck ordinary impacts; mini-boss slams use a lighter layer. The shared ceiling still prevents coincident clipping and the voice cap remains 24. `test:audio` additionally checks destruction tail energy and boss/body distinction; these are regression properties, not proof of subjective punch. The CC0 source notice lists direct author pages and transformations. Design references: [God of War sound team](https://www.asoundeffect.com/god-of-war-sound/), [Rovio sound team](https://www.asoundeffect.com/angry-birds-journey-game-audio/). No audio from those games is included.
