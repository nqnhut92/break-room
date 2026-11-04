# Notes for agents

- **Tests:** `npm test`. The Redis half of `test/shared.js` only runs when a Redis is reachable; without one it prints `SKIP`, which is not a pass. Before finishing a change that touches `lib/`, run **`npm run test:redis`** (starts a throwaway Redis container with podman or docker, runs everything, removes it). The full run must say `All 45 checks passed` or more, with no `SKIP`. The user's machine uses podman.
- **Run the game locally:** `npm install` (once), then `PORT=3111 node server.js` and open `http://localhost:3111/?room=br-1`. The browser may keep old copies of JS for a while; reload with the cache bypassed after editing. State lives in RAM and resets on restart.
- **To look at a far corner of the map**, change `WORLD.spawn` in `lib/world.js` temporarily and restart; put it back before committing.
- **Layout and facing:** all furniture is laid out in `lib/world.js`. `rot` is where an object faces: 0 south (+y), `Math.PI / 2` east, `Math.PI` north, `-Math.PI / 2` west. Kenney models face +z, so rot 0 faces the camera.
- **Assets:** only CC0 models (Kenney) go into `public/assets/`; keep the licence file next to them and update the credits in `README.md`.
- **Commits:** follow the user's git rules (work on `main`, author `Nicholas Nguyen`, no co-author trailers).
- **Look:** code-built furniture uses `box()` (rounded edges); walls and frames use `sbox()` (sharp). Kenney models get soft normals in `fitKenney` (`SOFT_ANGLE`), and `bodyMat` is not flat-shaded. Graphics "high" adds bloom and FXAA through a composer (not MSAA: a multisampled target rendered a black rectangle on some GPUs); "low" renders directly.
- **Smash button:** `#smashBtn` is only shown on touch screens and pens; with a mouse and keyboard Space does the same.
