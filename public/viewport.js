// Keep the game's coordinate system landscape even when the browser is locked in portrait.
// This script runs before game.js, so its first render already has the right dimensions.
(() => {
  'use strict';
  const root = document.documentElement;
  const app = document.getElementById('app');
  const touch = window.matchMedia('(pointer: coarse)');
  let width = window.innerWidth, height = window.innerHeight;
  let rotated = false, lastLayoutWidth = 0, keyboardHeight = 0;
  const editing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

  function sync() {
    const layoutWidth = window.innerWidth;
    // A keyboard can make a portrait viewport wider than it is tall. Keep the previous
    // direction while editing, unless the layout width changes (a real device rotation).
    const widthChanged = Math.abs(layoutWidth - lastLayoutWidth) > 2;
    if (widthChanged || (!editing() && window.innerHeight >= keyboardHeight - 80)) keyboardHeight = 0;
    if ((!editing() && !keyboardHeight) || !lastLayoutWidth || widthChanged) {
      rotated = touch.matches && window.innerHeight > layoutWidth;
    }
    if (!touch.matches) rotated = false;
    lastLayoutWidth = layoutWidth;
    const visual = window.visualViewport;
    const w = touch.matches ? (visual?.width || layoutWidth) : layoutWidth;
    const h = touch.matches ? (visual?.height || window.innerHeight) : window.innerHeight;
    width = rotated ? h : w;
    height = rotated ? w : h;
    root.classList.toggle('mobile-landscape', touch.matches);
    root.classList.toggle('game-rotated', rotated);
    for (const [name, value] of Object.entries({
      'game-width': width + 'px', 'game-height': height + 'px',
      'game-vw': width / 100 + 'px', 'game-vh': height / 100 + 'px',
      'game-left': (rotated ? w : 0) + (visual?.offsetLeft || 0) + 'px',
      'game-top': (visual?.offsetTop || 0) + 'px',
      'game-rotation': rotated ? '90deg' : '0deg',
    })) root.style.setProperty('--' + name, value);
    window.dispatchEvent(new Event('gameviewportchange'));
  }

  // Inverse of translate(w, 0) rotate(90deg), including the visual viewport offset.
  function point(clientX, clientY) {
    if (!touch.matches) return { x: clientX, y: clientY };
    const rect = app.getBoundingClientRect();
    return rotated
      ? { x: clientY - rect.top, y: rect.right - clientX }
      : { x: clientX - rect.left, y: clientY - rect.top };
  }
  function rect(el) {
    const r = el.getBoundingClientRect();
    const a = point(r.left, r.top), b = point(r.right, r.bottom);
    return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y),
      right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y),
      width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
  }
  window.GameViewport = { point, rect, get width() { return width; }, get height() { return height; } };
  window.addEventListener('resize', sync);
  window.visualViewport?.addEventListener('resize', sync);
  window.visualViewport?.addEventListener('scroll', sync);
  touch.addEventListener('change', sync);
  document.addEventListener('focusin', () => {
    if (editing()) keyboardHeight = Math.max(keyboardHeight, window.innerHeight);
  });
  document.addEventListener('focusout', () => setTimeout(sync, 0));
  sync();
})();
