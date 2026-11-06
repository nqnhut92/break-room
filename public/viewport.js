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
    // One line of raw measurements for device reports (shown in Settings on touch screens).
    describe() {
      const measure = css => {
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;top:0;left:0;width:0;box-sizing:content-box;visibility:hidden;pointer-events:none;' + css;
        document.body.appendChild(el);
        const cs = getComputedStyle(el), out = { h: el.getBoundingClientRect().height, top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
        el.remove(); return out;
      };
      const r = n => Math.round(n * 10) / 10, s = window.screen || {}, a = app?.getBoundingClientRect();
      const safe = measure('height:0;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)');
      const mode = window.navigator?.standalone === true || !!window.matchMedia?.('(display-mode: standalone)').matches ? 'yes' : 'no';
      return `screen ${s.width}x${s.height} · inner ${window.innerWidth}x${window.innerHeight} · client ${root.clientHeight}`
        + ` · dvh ${r(measure('height:100dvh').h)} · lvh ${r(measure('height:100lvh').h)} · svh ${r(measure('height:100svh').h)}`
        + ` · safe ${safe.top}/${safe.bottom} · app ${r(a?.top || 0)}+${r(a?.height || 0)} · standalone ${mode}`;
    },
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
