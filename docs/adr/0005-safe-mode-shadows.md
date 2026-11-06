# 0005 — Disable real-time shadow passes in safe mode

- Status: Accepted
- Recorded: 2026-11-04
- Supersedes: the safe-mode shadow policy in [0003](0003-direct-rendering.md); direct rendering without a composer remains accepted.

## Context

Stutter was reported on an iPhone 17 Pro Max immediately after entering the game. Resource retention after players leave is a separate bug and cannot explain a fresh session by itself. The earlier safe mode reduced shadow-map resolution but still rendered a broad shadow frustum. A local synthetic reception view submitted 302 draws and 813,404 triangles with shadows versus 51 and 26,860 without them. These counters establish submission cost, not iPhone FPS.

## Decision

Disable the real-time shadow pass in safe mode and retain the existing player ground/blob shadows. Keep high-mode live shadows and existing resolution limits available through the graphics switch. Release shadow render targets when disabling shadows and recreate them when high mode returns. Preserve saved player quality settings, native viewport and gesture behavior. Do not add a composer or dynamic resolution in this change.

Separately fix ownership cleanup for departed character rigs: dispose private geometry and private ground/ring/electric materials, while keeping shared materials alive.

## Alternatives

- A smaller shadow map reduces texture/pixel costs but leaves shadow geometry submission.
- Character-only casters, a smaller frustum or cached shadow updates may retain more visual detail but need additional shadow-boundary, invalidation and device checks.
- Lower DPR reduces canvas pixels but leaves the shadow pass and its geometry work.
- Rewriting the renderer or adding adaptive quality before device measurements would broaden the change without establishing the reported cause.

## Consequences

Safe mode loses directional real-time furniture/character shadows, while retaining lighting, baked geometry shading and player ground shadows. High mode remains more expensive and can still be selected or restored from storage. The browser regression test checks resource ownership, mode switching and actual shadow draw work. The updated touch fixture submits 52 draws in safe versus 304 in high; player geometry counts plateau across repeated joins/leaves.

Real iPhone frame pacing, thermal behavior and visual acceptance remain unverified. Revisit the safe-mode shadow choice if hardware testing shows unacceptable depth/readability or a better measured shadow strategy.

## References

- [Performance investigation](../PERFORMANCE.md), [mobile checks](../MOBILE.md)
- [Renderer](../../public/scene3d.js), [WebGL regression test](../../test/renderer.cjs)
- [Development and reproduction](../DEVELOPMENT.md#renderer-checks-and-mobile-performance)
