// Shared by browser prediction and server movement validation.
(function (root) {
  'use strict';
  function slide(x0, y0, x1, y1, radius, circles, resolveStatic, step = 8) {
    circles = circles.filter(c => c.x + c.r + radius >= Math.min(x0,x1) && c.x - c.r - radius <= Math.max(x0,x1)
      && c.y + c.r + radius >= Math.min(y0,y1) && c.y - c.r - radius <= Math.max(y0,y1));
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    const sx = (x1 - x0) / n, sy = (y1 - y0) / n;
    let x = x0, y = y0;
    const penetration = (px, py) => circles.reduce((sum, c) => sum + Math.max(0, radius + c.r - Math.hypot(px - c.x, py - c.y)), 0);
    for (let i = 0; i < n; i++) {
      let next = resolveStatic(x + sx, y + sy);
      for (let pass = 0; circles.length && pass < 4; pass++) {
        for (const c of circles) {
          const reach = radius + c.r;
          let dx = next.x - c.x, dy = next.y - c.y, d = Math.hypot(dx, dy);
          if (d >= reach) continue;
          if (d < 1e-6) {
            dx = x - c.x; dy = y - c.y; d = Math.hypot(dx, dy);
            if (d < 1e-6) { dx = -sx || 1; dy = -sy; d = Math.hypot(dx, dy); }
          }
          next = { x: c.x + dx / d * reach, y: c.y + dy / d * reach };
        }
        next = resolveStatic(next.x, next.y);
      }
      // Do not resolve an actor overlap by pushing through a wall. Existing
      // spawn/network overlap may escape only toward less penetration.
      if (penetration(next.x, next.y) > Math.max(1e-4, penetration(x, y)) + 1e-4) continue;
      x = next.x; y = next.y;
    }
    return { x, y };
  }
  const api = { slide };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BreakRoomActorCollision = api;
})(globalThis);
