# Mobile UI and rendering

The entry form uses a two-column layout on landscape touch screens at least 600 CSS pixels wide. On portrait touch screens, the rotate prompt covers entry immediately, including first load, reload, auto-rejoin and disconnected states. `viewport.js` owns this gate before the game/WebGL module initializes; it does not depend on `S.joined`. Landscape reveals the entry form. The DOM is never rotated. Native browser fullscreen/orientation APIs are optional.

The header shows room, online count, sound and rage. Health stays above the local character. Camera zoom buttons sit below settings. Skills, chat and the emoji toggle sit at the bottom center. The emoji toggle opens a single row above the bottom controls. Choices close after selection or an outside tap. A full rage bar reveals ULTI above the attack button; after rage is spent, it hides again.

## Viewport and gestures

`public/viewport.js` measures the shared CSS layout surface `#app` for canvas dimensions and HUD sizing. The app uses `100dvh` with a minimum from layout `window.innerHeight`, plus the existing percentage fallback, so a stale root/dynamic-height value after rotation cannot leave the app shorter than the layout viewport. Layout containment gives the canvas and fixed HUD the same containing block. ResizeObserver, native orientation/fullscreen events and brief deferred rechecks handle late layout changes. Do not derive game dimensions from `visualViewport.width/height`: page zoom shrinks those measurements. Visual viewport events update only the keyboard inset for chat, without reallocating the renderer or resetting controls.

The game canvas, joystick and attack button use `touch-action: none`, cancel native `touchstart`, and cancel double-click default handling. The game handles two-finger camera zoom itself. Dialogs retain vertical scrolling. In help, only `#helpContent` owns scrolling: an unscrollable nested list with `overscroll-behavior: contain` would otherwise swallow swipes before they reach the outer scroller. Mobile text sizing is fixed at 100% so rotation does not trigger automatic text enlargement.

## Impact performance

Impact effects previously initialized some WebGL programs on their first visible use. A local Chromium CPU profile of the first held hammer attack included a synchronous `getProgramInfoLog` wait. Effects now use asynchronous shader preparation plus one transparent draw to initialize first-use uniforms and textures. The transparent warmup uses the normal renderer directly; it adds no compositor, post-processing or framebuffer chain. Preparation is repeated when graphics quality changes.

Debris previously submitted all 520 instance slots on every frame, including zero-scale inactive slots, in both the color and shadow passes. It now packs only living fragments into the draw range, uploads only that part of the matrix/color buffers, and skips tiny fragment shadows on touch devices. Empty scenes submit zero debris instances. Mobile camera shake uses a smaller continuous oscillation instead of independent random offsets on every display frame. This changes impact feedback, not combat timing or damage.

Local verification found zero new program initializations during the measured first hammer attack after warmup, and zero idle debris instances (previously 520 per pass). These are pipeline checks, not an iPhone FPS benchmark: software WebGL in headless Edge is not representative of an iPhone GPU. High/low settings still share scene geometry and much of the effect/CPU work, so a graphics toggle alone cannot eliminate every first-use hitch.

## Verification

Run `npm run test:redis` for the complete suite, including the viewport regression checks. Browser checks should cover 740×320, 844×390 and 956×440 touch viewports, then desktop:

- Entry button visible without scrolling in landscape; inputs usable with native keyboard.
- Portrait first load/reload before game.js or WebGL initialization; auto-rejoin and disconnect retain the rotate prompt. Landscape reveals the form again; desktop portrait windows remain usable.
- Portrait/native landscape transitions, with no CSS rotation. Native APIs may fail while the device orientation lock is enabled; the manual unlock instruction remains visible.
- Repeated double taps on the joystick do not zoom or resize the HUD; moving while holding attack still works.
- Canvas pinching changes the camera, while settings/help still scroll.
- Sound, zoom, emoji and skill hints match their mobile locations; desktop controls restore correctly.
- Full rage reveals ULTI above attack, sends the ult action, and hides after rage is consumed.
- Profile the first impact after entering and after changing quality, then sustained impacts. Check shader initialization and draw/instance counts separately from frame intervals.

Before claiming the Safari smart-zoom issue or impact smoothness fully resolved on hardware, repeat the joystick double-tap, chat keyboard open/close and sustained attacks on an actual iPhone, both from Safari and from the Home Screen app.

## Current performance investigation

The iPhone 17 Pro Max stutter report is still open. See [Performance](PERFORMANCE.md) ([Tiếng Việt](PERFORMANCE.vi.md)) for measured draw/resource counters, a geometry-disposal counterfactual, prioritized proposals and the hardware acceptance plan. The current implementation disables real-time shadows in safe mode and releases player-owned resources on removal; real-device FPS validation is still pending. Saved high-mode preferences are preserved. See [ADR 0005](adr/0005-safe-mode-shadows.md).

## Orientation regression checks

`node test/viewport.js` checks native sizing and early prompt visibility. After installing Chromium with `npx playwright install chromium`, run `npm run test:orientation` (or set `CHROMIUM_PATH`). It uses real HTML/CSS, viewport/game logic and WebSockets while stubbing WebGL. Checks cover blocked game-module initialization, locked/unsupported fullscreen APIs, reload, auto-rejoin, inactivity disconnect, native landscape and desktop portrait. These browser checks do not simulate the actual iPhone OS rotation lock.

## Joystick recovery

Joystick ownership is a pointer id plus pointer type. Move/up/cancel are observed at window capture phase so a terminal event delivered outside the pad still clears movement. Native touchend/touchcancel provide a fallback when no touch originating on the pad remains, even if an attack finger is still down. A new primary touch can replace stale ownership; a secondary finger cannot steal a valid capture. Before movement, a pointer that no longer owns capture is returned to neutral. Capture/release failures also clear state, and a delayed lost-capture event is ignored if capture is currently active.

There is no inactivity timeout on a stationary held thumb. Chat focus, window blur, rotation and visibility changes retain their existing reset paths. The iPhone report (a direction sometimes sticks until opening/closing chat) suggests stale input state but does not establish which native event Safari lost.

Run `npm run test:joystick` with Chromium installed (or set `CHROMIUM_PATH`). The test uses native Chromium touch input, real game/UI/socket logic, and a stub renderer. It exercises direction changes, stationary holds, simultaneous attack, terminal events outside the pad, missing pointer-end fallbacks, delayed capture loss, capture/release exceptions, stale ids and chat recovery. Missing-event cases are fault injection, not a reproduction of the exact iPhone failure.

On the actual iPhone, test repeated drags/lifts including off-pad release, joystick plus attack, opening/closing chat, app switching and native rotation. Releasing and touching the pad again should recover without opening chat; a continuously held thumb should not stop just because it stays still.

## Settings layout

Touch settings contains five actions in one grid: Help/Map on the first row, High graphics/Copy server link on the second, and Call IT across the final row. Existing button elements are moved rather than recreated, preserving their listeners and state. Zoom stays at the right edge; skill/chat/emoji stay at the bottom; sound stays in the header. Desktop controls return to their original toolbar positions. [Current panel screenshot](../artifacts/settings-mobile.png).

Run `npm run test:settings` with Chromium installed (or `CHROMIUM_PATH`) for alignment, action behavior and desktop placement at the 740×320, 844×390 and 956×440 touch layouts. `SETTINGS_REAL_RENDERER=1` runs the 844×390 smoke check with actual WebGL instead of the UI-only renderer stub; `SETTINGS_SCREENSHOT=/path/image.png` saves the open panel.

## Account form

The join screen shares a horizontal layout on laptops (760px+) and touch landscape screens (600px+). An account strip spans both columns, with a white Google button and its multicolor mark. Profile fields are on the left; room selection and the single primary action are on the right. On short screens, fields and room cards scroll while the primary action stays visible.

After Google sign-in, an empty room profile uses “Tạo nhân vật & vào phòng”: this explicitly creates the displayed profile before joining. A returning character loads automatically as a plain read-only summary, not a disabled form, with “Vào văn phòng”. Focus indicators stay inside controls so scrolling columns cannot clip them; native radios remain visually hidden even while loading/saving. “Sửa nhân vật” enables editing; “Lưu & vào phòng” saves before joining, and cancel restores the saved profile. Room changes load that room's character. Login alone never creates or joins a character. Score limitations appear separately beneath the primary action.

Verify the primary action after rotating; use `npm run test:orientation` and `npm run test:account-ui`. Physical phone keyboard and Google redirect behavior still need device checks.


The office-patrol warning/countdown sits below the measured header, wraps within the landscape viewport and never captures taps. It adds no action button. `CHROMIUM_PATH=/path/to/chromium npm run test:office-ui` checks 844×390 touch and desktop layouts with real WebGL, including visible rack electricity and player HP loss.


Minimap sizing resolves its CSS width while the welcome HUD is still hidden, then rebuilds its backing canvas on layout-viewport changes. In touch landscape, chat starts below the visible map and fits above the joystick; hiding the map reclaims that space. `CHROMIUM_PATH=/path/to/chromium node test/minimap-ui.cjs` covers join/auto-rejoin, 740×320, 844×390, 956×440, resize and map toggling.


## Safe areas and rotation previews

The world background fills the app surface. Important content uses the browser-provided `safe-area-inset-*` values plus normal margins: header, map/chat, joystick, attack/skill/chat/emoji controls, notices, keyboard chat and dialog contents. The centered groups shift to the center of the usable width when left/right insets differ. No iPhone model detection or fixed notch width is used in production; Android cutouts and gesture/side-navigation bars use the same CSS variables. On short landscape surfaces, the map shrinks to leave chat above the joystick. Server shocks now use pooled electric arcs/sparks and normal HP-loss numbers, without a floating “GIẬT ĐIỆN” label or introductory toast.

This follows [WebKit's edge-to-edge and safe-area guidance](https://webkit.org/blog/7929/designing-websites-for-iphone-x/) and [Chrome Android's edge-to-edge guidance](https://developer.chrome.com/docs/css-ui/edge-to-edge). Background coverage and safe content placement are separate concerns; do not pad the whole WebGL surface into a smaller rectangle or disable pinch accessibility globally.

Run `npm run test:mobile-safe-area` with Chromium/`CHROMIUM_PATH` for injected insets representing left/right cutouts, bottom gestures, side navigation, no cutout and a short landscape display. It also fault-injects stale root/app heights and checks native rotation/viewport growth. `npm run test:office-ui` uses real WebGL for desktop, plain mobile and simulated iPhone-left/iPhone-right/Android previews; hardware-shaped masks are test-only visual aids. These checks establish layout behavior under supplied insets, not the exact Dynamic Island dimensions or a reproduction on physical Safari/Android hardware. Repeat rotation both ways, browser toolbar changes, keyboard open/close and Home Screen launch on devices before claiming the reported iPhone gap fully resolved.


## Mobile chat layout

On landscape touch screens, chat anchors immediately above the joystick with a width up to 320px and 14px text. The fixed height fits roughly four text lines (104px) on a larger landscape display, and adapts to the space between map and joystick on shorter screens. Long messages wrap naturally and consume multiple lines; nothing is replaced by an ellipsis or hidden behind a click. Older messages remain in the same native scrollable log. The existing chat button opens only the input, and tapping the log does not expand or move it. An empty log stays hidden; the existing three-second idle fade is unchanged.

`CHROMIUM_PATH=/path/to/chromium npm run test:mobile-chat` checks populated chat at 956×440 with safe-area insets, a long message sent through the actual form/server, wrapping, native scroll preservation, unchanged panel size on tap/input focus, and 844×390/740×320 layouts. `CHAT_REAL_RENDERER=1` uses actual WebGL and saves a local screenshot in `work/`; supplied history is test data, not production chat. Physical iPhone keyboard behavior still needs device verification.
