# Break Room

English · [Tiếng Việt](README.vi.md) · [Documentation](docs/README.md)

A multiplayer 3D office-smashing game built with three.js. Smash furniture with colleagues, compete on the damage board or team up against VKL, TML and DMM. IT replaces broken objects in 25–60 seconds depending on players and broken items; Call IT restores everything immediately.

![Current office panorama, rendered from the game](artifacts/map-ingame.png)

## Run locally

Requires Node.js 20+ and a browser with WebGL.

```bash
npm install
npm start
```

Open http://localhost:3000. One local process needs no Redis; RAM state resets on restart. Multiple instances and Vercel need Redis: see [Deployment](docs/DEPLOYMENT.md).

## Play together

Pick the same **BR-1** or **BR-2** server (20 players each), then share its link. Enter a name and choose a role and appearance. On phones, use the joystick and rotate to landscape.

Optional Google login saves a separate character per room; guests remain available. With a database the board is a per-room daily ranking (resets 00:00 Vietnam time, no all-time board) and room chat keeps 24 hours; there is no long-term score history. [Identity setup](docs/IDENTITY.md) · [Scores](docs/SCORES.md).

| Action | Controls |
| --- | --- |
| Move | WASD / arrows; joystick on touch screens |
| Smash | Hold Space; hold SMASH! on touch screens |
| Skill / ultimate | 1, 2, 3 / R; Skill / ULTI buttons |
| Call IT | I |
| Chat / emoji | Enter or `/` / Shift + 1…8 |
| Camera / mini map | Scroll, pinch, +/− / M |
| Full-room map | Hold Tab on desktop; click/tap mini map to toggle; × closes |

## Tests

```bash
npm test
npm run test:redis
npm run test:scores   # daily scoreboard + chat history, disposable Postgres/Redis
```

`npm test` may skip Redis when `redis-server` is unavailable; a `SKIP` is not Redis validation. `test:redis` uses a temporary podman/docker Redis container for the full suite. [Details](docs/DEVELOPMENT.md).

## Documentation

- [Gameplay](docs/GAMEPLAY.md) — controls, mana, boss, map.
- [Deployment and operations](docs/DEPLOYMENT.md) — Vercel, Redis, env, health checks.
- [Architecture](docs/ARCHITECTURE.md) — store, pub/sub, lifecycle.
- [Development](docs/DEVELOPMENT.md) — code, tests, rendering.
- [ADR](docs/adr/README.md) — architecture decisions and their rationale.
- [Scores and chat history](docs/SCORES.md) — daily board, Postgres persistence, maintenance job.
- [Mobile](docs/MOBILE.md) — viewport, gestures and device verification.

## License and credits

Code: [MIT](LICENSE). Floor textures: [ambientCG](https://ambientcg.com/), CC0 ([notice](public/assets/textures/License.txt)). Impact sounds: [Kenney](https://kenney.nl/assets/impact-sounds), CC0 ([notice](public/assets/audio/License.txt), [source](public/assets/audio/SOURCE.md)). Three.js: MIT ([license](public/vendor/three-LICENSE.txt)). Icons: [Lucide](https://lucide.dev), ISC/MIT ([license](public/vendor/lucide-LICENSE.txt)). Furniture and characters are built in code.
