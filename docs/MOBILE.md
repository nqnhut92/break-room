# Mobile UI and rendering

The entry form uses a two-column layout on landscape touch screens at least 600 CSS pixels wide. In portrait it remains a scrolling form. After joining, portrait shows a rotate prompt; the DOM is never rotated. Native browser fullscreen/orientation APIs are optional.

The header shows room, online count, sound and rage. Health stays above the local character. Camera zoom buttons sit below settings. Skills, chat and the emoji toggle sit at the bottom center. The emoji toggle opens a single row above the bottom controls. Choices close after selection or an outside tap. A full rage bar reveals ULTI above the attack button; after rage is spent, it hides again.

## Viewport and gestures

`public/viewport.js` uses the layout viewport (`documentElement.clientWidth/clientHeight`) for canvas dimensions and HUD sizing. Do not derive game dimensions from `visualViewport.width/height`: page zoom shrinks those measurements, which can cause the HUD to reflow while the 3D view compensates for the new aspect ratio. Visual viewport events update only the keyboard inset for chat, without reallocating the renderer or resetting controls.

The game canvas, joystick and attack button use `touch-action: none`, cancel native `touchstart`, and cancel double-click default handling. The game handles two-finger camera zoom itself. Dialogs retain vertical scrolling. In help, only `#helpContent` owns scrolling: an unscrollable nested list with `overscroll-behavior: contain` would otherwise swallow swipes before they reach the outer scroller. Mobile text sizing is fixed at 100% so rotation does not trigger automatic text enlargement.

## Impact performance

Impact effects previously initialized some WebGL programs on their first visible use. A local Chromium CPU profile of the first held hammer attack included a synchronous `getProgramInfoLog` wait. Effects now use asynchronous shader preparation plus one transparent draw to initialize first-use uniforms and textures. The transparent warmup uses the normal renderer directly; it adds no compositor, post-processing or framebuffer chain. Preparation is repeated when graphics quality changes.

Debris previously submitted all 520 instance slots on every frame, including zero-scale inactive slots, in both the color and shadow passes. It now packs only living fragments into the draw range, uploads only that part of the matrix/color buffers, and skips tiny fragment shadows on touch devices. Empty scenes submit zero debris instances. Mobile camera shake uses a smaller continuous oscillation instead of independent random offsets on every display frame. This changes impact feedback, not combat timing or damage.

Local verification found zero new program initializations during the measured first hammer attack after warmup, and zero idle debris instances (previously 520 per pass). These are pipeline checks, not an iPhone FPS benchmark: software WebGL in headless Edge is not representative of an iPhone GPU. High/low settings still share scene geometry and much of the effect/CPU work, so a graphics toggle alone cannot eliminate every first-use hitch.

## Verification

Run `npm run test:redis` for the complete suite, including the viewport regression checks. Browser checks should cover 740×320, 844×390 and 956×440 touch viewports, then desktop:

- Entry button visible without scrolling in landscape; inputs usable with native keyboard.
- Portrait/native landscape transitions, with no CSS rotation.
- Repeated double taps on the joystick do not zoom or resize the HUD; moving while holding attack still works.
- Canvas pinching changes the camera, while settings/help still scroll.
- Sound, zoom, emoji and skill hints match their mobile locations; desktop controls restore correctly.
- Full rage reveals ULTI above attack, sends the ult action, and hides after rage is consumed.
- Profile the first impact after entering and after changing quality, then sustained impacts. Check shader initialization and draw/instance counts separately from frame intervals.

Before claiming the Safari smart-zoom issue or impact smoothness fully resolved on hardware, repeat the joystick double-tap, chat keyboard open/close and sustained attacks on an actual iPhone, both from Safari and from the Home Screen app.
