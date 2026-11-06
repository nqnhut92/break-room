# Mobile performance investigation

English · [Tiếng Việt](PERFORMANCE.vi.md) · [Documentation](README.md)

Original investigation recorded 2026-11-04 against runtime revision `dcbcb33`. Baseline findings and tables below describe that revision. Current implementation changes are recorded next; the iPhone 17 Pro Max report still needs hardware validation.

## Implementation for device testing

The user confirmed stutter immediately after joining a fresh session. Retention after repeated joins/leaves **does not explain that case by itself**; it is an independent resource-lifecycle bug. This change addresses both lifecycle and shadow work present from the first frames:

- Safe mode disables the real-time shadow pass while retaining player ground/blob shadows. High mode retains live shadows (1024 on touch, 2048 desktop), selectable with ✨. Saved preferences are preserved.
- Switching to safe mode releases the shadow target; returning to high recreates it correctly.
- Removing a player/mini-boss disposes its private geometries and ground/ring/electric materials, retaining shared materials.

The [WebGL regression test](../test/renderer.cjs) checks actual cleanup without a behavior patch. In its touch fixture with one dev-accessory player, safe submits **52 draws / 27,140 triangles**, high **304 / 813,964**, including shadows. Eight join/leave cycles keep geometries at **92 → 92**. This fixture adds an accessory compared with the original baseline, so compare safe/high within this run rather than subtracting across fixtures.

The initial cleanup/shadow regression run passed **17 checks** in each touch and desktop configuration, with no page or WebGL errors; repeated high/safe transitions do not retain shadow textures.

These are measured submission reductions on SwiftShader, not an established iPhone FPS improvement. See [ADR 0005](adr/0005-safe-mode-shadows.md) and [test instructions](DEVELOPMENT.md#renderer-checks-and-mobile-performance). Remaining proposals below are not implemented.

## Moving horizontal flicker follow-up

A later iPhone report says both modes are smooth but show a horizontal flickering line while moving. Layout inspection found two corridor zones overlapping reception over `y=1420..1460`, together spanning `x=0..2880`; all are rendered at the same height. This is a concrete coplanar/z-fighting defect shared by both graphics modes, not a direct reproduction of the observed line on the iPhone GPU.

The fix starts reception at `y=1460`, sharing only an edge with the corridor, while keeping the shadow optimizations. `test/world.js` checks all zone pairs for area overlap; renderer checks move the camera through this region in safe/high. Floating room-name signs were also removed at the user's request. Confirm the reported line on hardware while moving; a still image cannot establish that it is resolved. The latest touch renderer regression run passes 18 checks, with 50 safe-mode draws versus 302 in high and a resource plateau at 90 geometries; removing signs changes the visible-mesh counts from the earlier run.

## Findings

There is no evidence yet that the phone has too little RAM. A rendering workload problem and retained WebGL resources are both supported by the local investigation. Either can coexist with Safari scheduling, thermal throttling or a high graphics setting restored from an earlier session.

1. **Safe mode still pays for a large real-time shadow pass.** At a fixed reception view, turning off shadows cuts submitted draw calls from 302 to 51 and triangles from 813,404 to 26,860. `setQuality('low')` reduces shadow-map resolution, but retains real-time shadow casters and the broad camera-following shadow frustum. Lower resolution alone does not eliminate geometry submission.
2. **Departing player rigs retain uploaded geometry.** `disposePlayer()` removes the group and label but disposes only a pick proxy and electric-effect resources, leaving the rig's other geometries. After a crowd leaves, renderer geometry counts stay elevated; eight further join/leave cycles add ten geometries each, even after forced JavaScript GC. A response-only disposal patch keeps the count flat.
3. **A saved high setting can multiply pixel work on phones.** `public/game.js` restores `br-gfx2` before applying the default. At the probe's DPR 3, high renders at DPR 2 and low at DPR 1: four times as many canvas pixels in high mode. Both retain the context's antialiasing. We have not inspected the user's saved setting.
4. **Crowds raise submission costs substantially.** A synthetic 20-player/40-snake view submits 823 draw calls and 1,396,808 triangles including shadows. Each player builds its own rig geometry. Frustum culling does not prevent all scene traversal, per-object updates or shadow work.

## Evidence and limits

The local probe uses the actual `createScene3D` and world definition, synthetic state, a fixed reception camera, and a 956×440 CSS-pixel touch viewport with DPR 3. It runs headless Chromium with SwiftShader software WebGL, not Safari or an iPhone. It bypasses network, input, HUD and audio. No result below is an iPhone FPS, GPU-time or RAM-capacity measurement.

Counters explicitly reset once before each frame with `renderer.info.autoReset = false`, so totals include shadow passes. The normal automatic reset occurs after shadow rendering in the vendored renderer and would hide that cost. Results below are settled counters after four diagnostic frames per case; they are not time averages.

| Synthetic case | Canvas pixels | Draw calls incl. shadows | Triangles incl. shadows |
| --- | ---: | ---: | ---: |
| Low, one player | 420,640 | 302 | 813,404 |
| Low, same view, shadows off | 420,640 | 51 | 26,860 |
| Low, DPR 0.75 | 236,610 | 302 | 813,404 |
| High, one player | 1,682,560 | 302 | 813,404 |
| Low, 20 players + 40 snakes | 420,640 | 823 | 1,396,808 |
| Same crowd + debris/dust/sparks | 420,640 | 833 | 1,398,266 |

The shadow-off counterfactual removes about 83% of draws and 97% of submitted triangles in this particular view. It does **not** establish the same reduction in GPU time or improvement in FPS. DPR 0.75 reduces canvas pixels by about 44%, while leaving geometry counts unchanged. Shadow-map texture and multisample costs are not included in canvas-pixel counts.

| Resource-lifecycle checkpoint | Current renderer: uploaded geometries | Geometry-disposal counterfactual |
| --- | ---: | ---: |
| Initial one-player view | 91 | 91 |
| After crowd removed and effects expired | 284 | 94 |
| After eight more join/leave cycles | 364 | 94 |
| After forced JS GC and another render | 364 | 94 |

The extra three geometries in the counterfactual are retained shared snake geometry/proxy/health-bar resources created by the crowd case. A one-player scene returns to the same approximately 18.1 MiB of **referenced geometry attribute/index arrays** after the crowd is removed in both cases; that figure excludes textures, driver buffers, framebuffer storage and other process memory. `renderer.info.memory` counts resources, not bytes. A stable JS heap alone would therefore not rule out missing WebGL disposal.

Raw captures and diagnostic tooling currently remain local and are not distributed in this repository. Captures contain `mobile-probe.json` and `mobile-probe.cpuprofile` for the baseline and disposal counterfactual.

Both probes completed with zero page errors. CPU profiles include quality changes, rig creation and repeated manual renders; do not treat aggregate hotspots as a steady-gameplay CPU breakdown. The tables above record the counters; the hardware plan below describes independent validation.

## Proposed order of work

| Priority | Change | Verification / tradeoff |
| --- | --- | --- |
| P0 (implemented; device validation pending) | Dispose player-owned geometries and private blob/ring materials when removing a rig. Deduplicate ownership; never dispose the shared body material, shared model caches or snake geometry while in use. | Repeat crowd teardown and join/leave with an actual implementation; resource counts must plateau. Rejoin, role accessories, electric effects and new players must still render. The diagnostic patch proves the geometry hypothesis only; it is not a complete production ownership implementation. |
| P1 (no-live-shadow safe mode implemented) | Make safe-mode shadows substantially cheaper: first compare no real-time shadows with existing ground/blob shadows, then character-only or smaller-frustum shadows if the look requires them. Keep high mode available. | Measure on the iPhone at the same camera and workload. Inspect depth/readability, moving shadows and room edges. Avoid introducing a composer; follow ADR 0003. |
| P1 | Add an opt-in performance overlay or capture flag showing effective quality/DPR, frame interval percentiles, long tasks where supported, draw/triangle counts including shadows and resource counts. | Confirm actual saved quality and whether hitches track rendering, GC, warmup or network snapshots. Keep normal player flows free of diagnostic details. Safari lacks some Chromium memory/long-task APIs; detect support. |
| P2 | Trial DPR 0.85/0.75 in safe mode, with a bounded, slow adaptive policy only after measuring. | Pixel work falls, geometry work remains. Compare text/UI sharpness and sustained frame pacing; do not alter the layout viewport or gesture mapping. |
| P2 | Reduce character complexity at distance, share immutable rig geometry, and reduce offscreen updates. Consider instancing repeated static furniture where per-object damage visuals allow it. | Profile crowds first. Preserve damage targeting, accessories, picking, electric effects and shared ownership. Avoid hiding objects needed by shadows or effects. |
| P3 | Cache unchanged HUD/object updates and spatially index movement/target queries if CPU traces identify them. Investigate MSAA changes only if fill/attachment cost remains dominant. | These are secondary candidates, not measured root causes here. MSAA context changes can require renderer recreation and broader verification. |

Implement P0 and a measured P1 comparison before a broad renderer rewrite. Resource cleanup addresses longer sessions; shadow work can affect a fresh session too, so a new session stuttering does not rule out the shadow finding. Do not reset the user's graphics preference silently.

## High mode on iPad and iPhone (November 2026)

Measured with a temporary frame-time overlay (since removed) on an iPad Pro M4 11-inch (2420×1572 drawing buffer) and an iPhone with an A19 Pro, Safari, high mode, standing in the lobby. Game logic, scene update and labels took about 2 ms together; nearly all the frame was `renderer.render`, which in Safari waits for the GPU.

| iPad, high mode | render | FPS |
|---|---|---|
| Before | 17.1 ms | 35 |
| Pixel ratio 1.5 instead of 2 | 17.0 ms | 36 |
| PCF instead of PCFSoft shadows | 18.1 ms | 34 |
| No environment map | 16.5 ms | 37 |
| No real-time shadows | 10.8 ms | 53 |
| Shadow box fitted to the view, no shadows from screens/laptops/bins on touch | 12.5 ms | 42 |
| …and untouched objects share one material | 11.6 ms | 48 |

So the cost was not pixels but the shadow pass: its box was a square sized from the camera distance, 5400 units wide when zoomed out, and drew 726 draws and 2.2M triangles (counted in the headless renderer; `renderer.info` leaves out the shadow pass because three.js resets its counter after it) against 327 for the picture. The box is now fitted to the ground the camera sees, in light space, with a 220-unit margin, which brings that view to 488 shadow draws; on touch screens the 393 screens, laptops and bins do not cast real-time shadows (bins keep their contact blob), which brings it to 215. Objects also used to carry their own clone of the body material, so every draw re-uploaded its uniforms; they now share `bodyMat` and get a private copy only while damaged, flashing or electrified. The workspace (about 600 draws) still runs near 37 FPS on the iPad while smashing; batching or instancing the furniture would be the next step.

## iPhone acceptance plan

Use the same iPhone 17 Pro Max in Safari and the Home Screen app, recording actual viewport, browser/OS, quality, DPR and refresh cadence. Compare one change at a time with a cool phone and unchanged Low Power Mode/brightness; repeat after 10–15 minutes to distinguish sustained thermal behavior. These are checks to perform, not conditions already tested here.

- Compare safe/high, shadows on/off and DPR 1/0.75 at the same camera. Include quiet lobby, continuous movement, first impact, sustained impacts, VKL/snakes and a representative crowd. Separate slow network corrections from local frame stalls.
- Record frame intervals (p50/p95/p99), >50 ms stalls, JS/GC timelines, supported GPU timings and resource counts. Use Safari Web Inspector for allocations and process/memory evidence where available. Do not equate a 120 Hz display with measured 120 FPS.
- Proposed initial target: stable 60 FPS where supported, p95 frame interval at most 20 ms and p99 at most 33.3 ms in a controlled representative scene after warmup. Report misses instead of claiming the target was achieved.
- Run repeated join/leave and effects cycles: resources should settle rather than grow linearly. Confirm no missing meshes, context loss or reloads. Repeat native rotation, joystick double taps, keyboard/chat and pinch checks from [Mobile](MOBILE.md).

RAM pressure remains a hypothesis until actual memory-pressure/context-loss/reload or allocation evidence supports it. The phone's total RAM specification alone would not establish the browser's budget or explain a frame stall.
