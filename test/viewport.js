// Page zoom and the native keyboard must not resize the game or change HUD scale.
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
function surface() {
  const listeners = {};
  return { addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
    dispatchEvent(e) { for (const fn of listeners[e.type] || []) fn(e); } };
}
const styles = {}, root = { clientWidth: 844, clientHeight: 390,
  style: { setProperty(k, v) { styles[k] = v; } } };
const visual = Object.assign(surface(), { width: 844, height: 390, scale: 1, offsetTop: 0 });
const win = Object.assign(surface(), { innerWidth: 844, innerHeight: 390, visualViewport: visual });
const rotateOverlay = { hidden: true };
let coarse = true;
win.matchMedia = () => ({ matches: coarse });
const doc = Object.assign(surface(), { documentElement: root, activeElement: null, getElementById: id => id === 'rotateOverlay' ? rotateOverlay : null });
let resizes = 0;
win.addEventListener('gameviewportchange', () => resizes++);
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/viewport.js'), 'utf8'), {
  window: win, document: doc, Event: class { constructor(type) { this.type = type; } }, setTimeout: fn => fn(),
});
const view = win.GameViewport;
assert.deepEqual([view.width, view.height], [844, 390]);
assert.deepEqual(Object.values(view.point(120, 80)), [120, 80]);
assert.equal(rotateOverlay.hidden, true);
console.log('ok - native landscape preserves dimensions and input coordinates');
visual.scale = 2; visual.width = 422; visual.height = 195;
visual.dispatchEvent({ type: 'resize' }); visual.dispatchEvent({ type: 'scroll' });
assert.deepEqual([view.width, view.height], [844, 390]); assert.equal(resizes, 1);
assert.equal(styles['--game-vw'], '8.44px');
console.log('ok - browser zoom does not shrink the game viewport or reset controls');
visual.scale = 1; visual.height = 180;
doc.activeElement = { tagName: 'INPUT' }; doc.dispatchEvent({ type: 'focusin' });
assert.equal(styles['--keyboard-bottom'], '210px');
assert.deepEqual([view.width, view.height], [844, 390]);
doc.activeElement = null; doc.dispatchEvent({ type: 'focusout' });
assert.equal(styles['--keyboard-bottom'], '0px');
console.log('ok - keyboard inset changes only the chat position');
root.clientWidth = win.innerWidth = 390; root.clientHeight = win.innerHeight = 844;
win.dispatchEvent({ type: 'resize' });
assert.deepEqual([view.width, view.height], [390, 844]); assert.equal(resizes, 2);
const rectangle = { left: 20, top: 30, right: 60, bottom: 70 };
assert.equal(view.rect({ getBoundingClientRect: () => rectangle }), rectangle);
console.log('ok - native portrait stays portrait, with no extra rotation');
win.dispatchEvent({ type: 'resize' }); assert.equal(resizes, 2);
console.log('ok - redundant resize notifications do not resize the renderer');
assert.equal(view.portrait, true);
assert.equal(rotateOverlay.hidden, false);
console.log('ok - touch portrait shows the rotate prompt independently of game connection');
coarse = false; view.syncOrientation();
assert.equal(rotateOverlay.hidden, true);
coarse = true;
win.dispatchEvent({ type: 'pageshow' });
assert.equal(rotateOverlay.hidden, false);
console.log('ok - desktop portrait stays usable and returning pages resync the prompt');
rotateOverlay.hidden = true;
const freshWindow = Object.assign(surface(), { innerWidth:390, innerHeight:844, matchMedia:()=>({matches:true}) });
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/viewport.js'),'utf8'), {
  window:freshWindow, document:doc, Event:class { constructor(type){this.type=type;} }, setTimeout:fn=>fn(),
});
assert.equal(rotateOverlay.hidden, false);
assert.equal(freshWindow.GameViewport.portrait, true);
console.log('ok - first portrait load shows the prompt before game.js initializes');
console.log('All 8 viewport checks passed');
