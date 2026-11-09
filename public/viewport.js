// Follow the browser's real orientation. Page zoom must never become a game resize.
(() => {
  'use strict';
  const root = document.documentElement;
  const app = document.getElementById('app');
  // iPhone hides the status bar in landscape standalone mode. A cold launch
  // can retain a portrait top inset; it must not become an empty play-surface band.
  const iphoneStandalone = /iPhone|iPod/.test(window.navigator?.userAgent || '') &&
    (window.navigator?.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches);
  root.classList?.toggle('iphone-standalone', !!iphoneStandalone);
  // Local-only geometry reports for native Home Screen launch issues. No account,
  // room, storage or URL-query data is included; nothing is sent automatically.
  const reportButton = document.getElementById('viewportReport');
  const viewportBuild = (() => {
    try { return new URL(document.currentScript?.src || '', window.location?.href).searchParams.get('v') || 'dev'; }
    catch (_) { return 'dev'; }
  })();
  const startedAt = Date.now();
  let firstSample;
  const samples = [];
  function geometry() {
    const rect = el => {
      const r = el?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    };
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:0;padding:0;border:0;';
    document.body.appendChild(probe);
    const units = {};
    for (const unit of ['dvh', 'svh', 'lvh']) {
      probe.style.height = '100' + unit;
      units[unit] = probe.getBoundingClientRect().height;
    }
    probe.style.cssText += 'height:0;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);';
    const css = window.getComputedStyle(probe);
    const safe = { top: css.paddingTop, right: css.paddingRight, bottom: css.paddingBottom, left: css.paddingLeft };
    probe.remove();
    const visual = window.visualViewport;
    return {
      atMs: Date.now() - startedAt, hidden: document.hidden,
      layout: { width: window.innerWidth, height: window.innerHeight, rootWidth: root.clientWidth, rootHeight: root.clientHeight },
      app: rect(app), root: rect(root), body: rect(document.body), canvas: rect(document.getElementById('c')),
      units, safe, playTop: window.getComputedStyle(app).top,
      scroll: { x: window.scrollX, y: window.scrollY },
      visual: visual ? { width: visual.width, height: visual.height, offsetTop: visual.offsetTop, offsetLeft: visual.offsetLeft,
        pageTop: visual.pageTop, pageLeft: visual.pageLeft, scale: visual.scale } : null,
      screen: { width: window.screen?.width, height: window.screen?.height, availableWidth: window.screen?.availWidth,
        availableHeight: window.screen?.availHeight, type: window.screen?.orientation?.type, angle: window.screen?.orientation?.angle,
        legacyAngle: window.orientation, landscape: !!window.matchMedia?.('(orientation: landscape)').matches },
    };
  }
  function record(reason) {
    if (!iphoneStandalone) return;
    const sample = { reason, ...geometry() };
    if (!firstSample) firstSample = sample;
    samples.push(sample);
    if (samples.length > 12) samples.shift();
  }
  if (iphoneStandalone && reportButton) {
    reportButton.hidden = false;
    reportButton.addEventListener('click', async () => {
      record('copy');
      const report = JSON.stringify({ version: 1, build: viewportBuild, userAgent: window.navigator.userAgent,
        standalone: true, statusBar: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content || 'default',
        first: firstSample, recent: samples.slice() }, null, 2);
      try {
        await window.navigator.clipboard.writeText(report);
        reportButton.textContent = 'Đã chép thông tin';
      } catch (_) {
        // A selectable fallback also works when clipboard permission is denied.
        window.prompt('Chép thông tin hiển thị bên dưới:', report);
      }
    });
  }
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
  for (const event of ['pageshow', 'resize', 'orientationchange']) {
    window.addEventListener(event, () => record(event));
  }
  document.addEventListener('visibilitychange', () => record('visibilitychange'));
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
  record('initial');
  // A Home Screen launch can report a short layout height at first paint and fire no resize afterwards, so
  // only rotating the phone corrected it. Measure again once the page has loaded and while iOS settles.
  window.addEventListener('load', () => { resync(); record('load'); });
  for (const ms of [300, 1000, 2500]) setTimeout(() => { sync(); record('startup:' + ms); }, ms);
})();
