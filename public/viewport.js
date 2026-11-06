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
  // iPadOS Home Screen apps without black-translucent: the web view still runs under the
  // status bar (iPad draws its scroll-edge blur there) but reports env(safe-area-inset-top)=0
  // and a layout viewport one status-bar height short. A fixed full-height layer then stops
  // short of the bottom edge, leaving the dark page background as a band, while the top of
  // the game sits under the blur. Only this mode is corrected: Safari tabs and iPhones keep
  // layout-viewport sizing. The gap is the full window height (100lvh, or the screen's short
  // side for a full-width landscape window) minus innerHeight, capped at a status-bar height.
  const nav = window.navigator || {};
  let probe = null;
  function standaloneIPad() {
    const standalone = nav.standalone === true || !!window.matchMedia?.('(display-mode: standalone)').matches;
    const ua = nav.userAgent || '';
    return standalone && (/iPad/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1));
  }
  function statusGap(layoutHeight) {
    if (!standaloneIPad() || !document.createElement || !document.body) return 0;
    if (!probe) {
      probe = document.createElement('div');
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:100vh;height:100lvh;visibility:hidden;pointer-events:none';
      document.body.appendChild(probe);
    }
    let full = probe.getBoundingClientRect().height;
    const s = window.screen, long = Math.max(s?.width || 0, s?.height || 0), short = Math.min(s?.width || 0, s?.height || 0);
    if (window.innerWidth > layoutHeight && Math.abs(window.innerWidth - long) <= 1) full = Math.max(full, short);
    const gap = Math.round(full - layoutHeight);
    return gap > 0 && gap <= 48 ? gap : 0;
  }
  function sync() {
    // Measure the same CSS layout surface that contains WebGL and the HUD.
    // Safari can update the dynamic app box after the root's resize notification.
    // innerHeight is a layout-viewport measurement. It also covers stale dvh/root
    // values on native rotation; visualViewport measurements never size the game.
    const layoutHeight = window.innerHeight || root.clientHeight;
    const gap = statusGap(layoutHeight);
    root.style.setProperty('--status-gap', gap + 'px');
    root.style.setProperty('--layout-min-height', layoutHeight + gap + 'px');
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
    get statusGap() { return parseFloat(root.style.getPropertyValue?.('--status-gap')) || 0; },
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
