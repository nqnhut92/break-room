// Follow the browser's real orientation. Page zoom must never become a game resize.
(() => {
  'use strict';
  const root = document.documentElement;
  let width = 0, height = 0;
  function keyboardInset() {
    const visual = window.visualViewport;
    const editing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
    const inset = editing && visual && Math.abs(visual.scale - 1) < 0.01
      ? Math.max(0, height - visual.height - visual.offsetTop) : 0;
    root.style.setProperty('--keyboard-bottom', inset + 'px');
  }
  function sync() {
    const w = root.clientWidth || window.innerWidth;
    const h = root.clientHeight || window.innerHeight;
    if (w !== width || h !== height) {
      width = w; height = h;
      root.style.setProperty('--game-vw', width / 100 + 'px');
      root.style.setProperty('--game-vh', height / 100 + 'px');
      window.dispatchEvent(new Event('gameviewportchange'));
    }
    keyboardInset();
  }
  window.GameViewport = {
    point: (x, y) => ({ x, y }),
    rect: el => el.getBoundingClientRect(),
    get width() { return width; }, get height() { return height; },
  };
  window.addEventListener('resize', sync);
  // Keyboard/zoom changes can update the chat inset, but never the canvas or HUD scale.
  window.visualViewport?.addEventListener('resize', keyboardInset);
  window.visualViewport?.addEventListener('scroll', keyboardInset);
  document.addEventListener('focusin', keyboardInset);
  document.addEventListener('focusout', () => setTimeout(keyboardInset, 0));
  sync();
})();
