// Follow the browser's real orientation. Page zoom must never become a game resize.
(() => {
  'use strict';
  const root = document.documentElement;
  const app = document.getElementById('app');
  let width = 0, height = 0;
  function mobilePortrait() {
    return !!window.matchMedia?.('(pointer: coarse)').matches && height > width;
  }
  function syncOrientation() {
    const overlay = document.getElementById('rotateOverlay');
    if (overlay) overlay.hidden = !mobilePortrait();
  }
  function keyboardInset() {
    const visual = window.visualViewport;
    const editing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
    const inset = editing && visual && Math.abs(visual.scale - 1) < 0.01
      ? Math.max(0, height + (app?.getBoundingClientRect().top || 0) - visual.height - visual.offsetTop) : 0;
    root.style.setProperty('--keyboard-bottom', inset + 'px');
  }
  function sync() {
    // Measure the same CSS layout surface that contains WebGL and the HUD.
    // Safari can update the dynamic app box after the root's resize notification.
    // innerHeight is a layout-viewport measurement. It also covers stale dvh/root
    // values on native rotation; visualViewport measurements never size the game.
    root.style.setProperty('--layout-min-height', (window.innerHeight || root.clientHeight) + 'px');
    const bounds = app?.getBoundingClientRect();
    const w = Math.round(bounds?.width || root.clientWidth || window.innerWidth);
    const h = Math.round(bounds?.height || root.clientHeight || window.innerHeight);
    if (w !== width || h !== height) {
      width = w; height = h;
      root.style.setProperty('--game-vw', width / 100 + 'px');
      root.style.setProperty('--game-vh', height / 100 + 'px');
      window.dispatchEvent(new Event('gameviewportchange'));
    }
    syncOrientation();
    keyboardInset();
  }
  window.GameViewport = {
    point: (x, y) => ({ x, y }),
    rect: el => el.getBoundingClientRect(),
    get width() { return width; }, get height() { return height; },
    get portrait() { return mobilePortrait(); }, syncOrientation,
  };
  function resync() {
    sync();
    // Native rotation/fullscreen can settle over more than one layout pass.
    window.requestAnimationFrame?.(() => { sync(); window.requestAnimationFrame?.(sync); });
    setTimeout(sync, 200);
  }
  window.addEventListener('resize', resync);
  window.addEventListener('orientationchange', resync);
  window.screen?.orientation?.addEventListener('change', resync);
  window.addEventListener('pageshow', resync);
  document.addEventListener('fullscreenchange', resync);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resync(); });
  if (app && window.ResizeObserver) new window.ResizeObserver(sync).observe(app);

  // The page itself never zooms: the game owns pinch (camera zoom). iOS ignores user-scalable=no, so cancel its
  // pinch gesture events here; double-tap zoom is off through touch-action: manipulation in style.css.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, e => e.preventDefault(), { passive: false });
  }
  // A double tap that still reaches the browser (dblclick) must not smart-zoom either.
  document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });

  // Keyboard/zoom changes can update the chat inset, but never the canvas or HUD scale.
  window.visualViewport?.addEventListener('resize', keyboardInset);
  window.visualViewport?.addEventListener('scroll', keyboardInset);
  document.addEventListener('focusin', keyboardInset);
  document.addEventListener('focusout', () => setTimeout(keyboardInset, 0));
  sync();
  // A Home Screen launch can report a short layout height at first paint and fire no resize afterwards, so
  // only rotating the phone corrected it. Measure again once the page has loaded and while iOS settles.
  window.addEventListener('load', resync);
  for (const ms of [300, 1000, 2500]) setTimeout(sync, ms);
})();
