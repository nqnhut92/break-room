# 0003 — Direct rendering without a post-processing composer

- Status: Accepted
- Recorded: 2026-11-04 (existing decision documented retrospectively)
- Supersedes / superseded by: none

## Context

Project notes record intermittent flickering black rectangles on the user's GPU with an EffectComposer bloom chain. A bisect pointed to the bloom pass, which was removed. A short screenshot check cannot establish that the intermittent issue is gone. Touch devices also need a lower rendering budget.

## Decision

Render the scene directly in both high and safe graphics modes. Use scene lighting, emissive materials and screen sprites for glow instead of a composer. High mode uses supersampling and larger shadows; touch defaults use native resolution, smaller shadows and no screen halos. Build furniture and characters procedurally, with local vendored three.js modules and licensed floor textures.

Keep the direct path when warming effects and changing quality settings.

## Alternatives

- Composer-based bloom previously produced the recorded GPU artifact.
- More post-processing could add visual polish, but would restore the framebuffer chain and require verification on the affected hardware.
- Safe mode alone lowers cost but does not establish that the reported bloom issue is fixed.

## Consequences

Lighting and geometry carry the look, and some glow effects are approximations. Both modes still share geometry and CPU work; lowering quality cannot fix every performance issue. Do not restore a composer without moving-scene checks on the user's GPU, including screenshots spaced over several seconds. Headless software WebGL is useful for pipeline checks, not proof of hardware performance.

## References

- [Project instructions](../../AGENTS.md)
- [Renderer](../../public/scene3d.js), [development](../DEVELOPMENT.md)
- [Mobile rendering evidence and device checks](../MOBILE.md)
