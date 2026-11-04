// Regression checks for portrait-lock fallback and keyboard resize/orientation transitions.
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
function surface() {
  const listeners = {};
  return {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(event) { for (const fn of listeners[event.type] || []) fn(event); },
  };
}
const classes = new Set(), styles = {};
const root = { classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); } },
  style: { setProperty(name, value) { styles[name] = value; } } };
const touch = Object.assign(surface(), { matches: true });
const visual = Object.assign(surface(), { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 });
const win = Object.assign(surface(), { innerWidth: 390, innerHeight: 844, visualViewport: visual, matchMedia: () => touch });
const app = { getBoundingClientRect() { return { left: visual.offsetLeft, right: visual.offsetLeft + visual.width, top: visual.offsetTop }; } };
const doc = Object.assign(surface(), { documentElement: root, activeElement: null, getElementById: () => app });
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/viewport.js'), 'utf8'), {
  window: win, document: doc, Event: class { constructor(type) { this.type = type; } }, setTimeout: fn => fn(),
});
const view = win.GameViewport;
function size(w, h) {
  win.innerWidth = visual.width = w; win.innerHeight = visual.height = h;
  win.dispatchEvent({ type: 'resize' });
}
const pair = p => [p.x, p.y];
assert(classes.has('game-rotated'));
assert.deepEqual([view.width, view.height], [844, 390]);
assert.deepEqual(pair(view.point(390, 0)), [0, 0]);
assert.deepEqual(pair(view.point(0, 844)), [844, 390]);
// A screen-space downward drag must move the thumb to the game's right.
const start = view.point(300, 60), end = view.point(300, 100);
assert.deepEqual([end.x - start.x, end.y - start.y], [40, 0]);
const rect = view.rect({ getBoundingClientRect: () => ({ left: 250, right: 350, top: 20, bottom: 120 }) });
assert.deepEqual([rect.left, rect.top, rect.right, rect.bottom], [20, 40, 120, 140]);
console.log('ok - portrait lock: logical dimensions, corners, joystick direction and HUD rectangles');
doc.activeElement = { tagName: 'INPUT' }; doc.dispatchEvent({ type: 'focusin' });
size(390, 300); assert(classes.has('game-rotated'));
doc.activeElement = null; doc.dispatchEvent({ type: 'focusout' });
assert(classes.has('game-rotated'), 'keyboard closing must not flip orientation');
size(390, 844); assert(classes.has('game-rotated'));
console.log('ok - keyboard opening and closing preserve the game orientation');
size(844, 390); assert(!classes.has('game-rotated'));
assert.deepEqual([view.width, view.height], [844, 390]);
assert.deepEqual(pair(view.point(120, 80)), [120, 80]);
doc.activeElement = { tagName: 'INPUT' }; doc.dispatchEvent({ type: 'focusin' });
size(390, 844); assert(classes.has('game-rotated'), 'real rotation still works while typing');
doc.activeElement = null; doc.dispatchEvent({ type: 'focusout' });
console.log('ok - real landscape removes CSS rotation; rotating back while typing works');
visual.offsetLeft = 5; visual.offsetTop = 23; visual.dispatchEvent({ type: 'scroll' });
assert.deepEqual(pair(view.point(395, 23)), [0, 0]);
assert.equal(styles['--game-left'], '395px');
assert.equal(styles['--game-top'], '23px');
console.log('ok - keyboard viewport offsets are included in rendering and input');
touch.matches = false; size(1280, 800);
assert(!classes.has('mobile-landscape')); assert(!classes.has('game-rotated'));
assert.deepEqual([view.width, view.height], [1280, 800]);
assert.deepEqual(pair(view.point(120, 80)), [120, 80]);
console.log('ok - desktop keeps normal coordinates and dimensions');
console.log('All 5 viewport checks passed');
