// All three.js rendering lives here. game.js owns the game state and the
// network; this module turns that state into pictures. World coordinates are
// (x, y) on the ground; in 3D, x stays x and the world's y becomes z (so "down"
// on the map is towards the camera). Everything is low-poly geometry built in
// code (no model or texture files), merged per type with vertex colours.

import * as THREE from 'three';
import { mergeGeometries } from './vendor/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from './vendor/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from './vendor/jsm/environments/RoomEnvironment.js';
import { ROLE_BY_ID } from './roles.js?v=179426691686';

// ------------------------------------------------------------- geometry ----
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

function paint(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r;
    a[i * 3 + 1] = c.g;
    a[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return geo;
}
function place(geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _m.compose(_p, _q, _s);
  geo.applyMatrix4(_m);
  return geo;
}
// Furniture is built from rounded boxes (soft edges catch the light); walls and frames use plain ones (sbox).
const box = (w, h, d, hex, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
  const r = Math.min(7, Math.min(w, h, d) * 0.32);
  const geo = r < 0.6 ? new THREE.BoxGeometry(w, h, d) : new RoundedBoxGeometry(w, h, d, 2, r);
  return place(paint(geo, hex), x, y, z, rx, ry, rz);
};
const sbox = (w, h, d, hex, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) =>
  place(paint(new THREE.BoxGeometry(w, h, d), hex), x, y, z, rx, ry, rz);
const cyl = (rt, rb, h, hex, x = 0, y = 0, z = 0, seg = 12, rx = 0, ry = 0, rz = 0) =>
  place(paint(new THREE.CylinderGeometry(rt, rb, h, seg), hex), x, y, z, rx, ry, rz);
const sph = (r, hex, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) => {
  const g = new THREE.SphereGeometry(r, 10, 8);
  g.scale(sx, sy, sz);
  return place(paint(g, hex), x, y, z);
};
// Soft shapes for the rounded furniture: an ellipsoid with its three radii, and a capsule. Both can be rotated.
const ell = (a, b, c, hex, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
  const g = new THREE.SphereGeometry(1, 20, 14);
  g.scale(a, b, c);
  return place(paint(g, hex), x, y, z, rx, ry, rz);
};
const pill = (r, len, hex, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) =>
  place(paint(new THREE.CapsuleGeometry(r, len, 5, 12), hex), x, y, z, rx, ry, rz);
// Models have indexed geometry with UVs; bring every part to the same shape so they can share one merged mesh.
const merge = (list) => {
  if (!list.length) return null;
  const flat = list.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    n.deleteAttribute('uv');
    return n;
  });
  return mergeGeometries(flat, false);
};

// Cheap baked ambient occlusion: vertex colours fade darker towards the floor, so every piece of furniture
// gets a soft contact shadow where it meets the ground, for free at runtime.
// The hammer's handle continues the forearm, with the head at the far end and its long side along the swing: it hangs
// down from a relaxed hand at rest, and swinging the arm swings the hammer.
const _hammerAlongArm = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, Math.PI / 2, 0));
// At rest the hammer is held beside the body: handle straight up, head side-on.
// (spin the head a quarter turn about the handle, then tilt)
const _hammerHeld = new THREE.Quaternion()
  .setFromEuler(new THREE.Euler(0.04, 0, 0.06))
  .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
const _hand = new THREE.Vector3();
const _heldCup = new THREE.Quaternion(); // the cup stays upright
const _heldTaser = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.3, 0, 0)); // the gun's barrel points forward and a little up
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
function bakeAO(geo) {
  if (!geo) return geo;
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  if (!col) return geo;
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, pos.getY(i) / 46));
    const k = 0.7 + 0.3 * t * t * (3 - 2 * t);
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
  return geo;
}

function seeded(seed) {
  let s = (Math.abs(seed) % 2147483646) + 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
function shade(hex, k) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return '#' + c.getHexString();
}

// ----------------------------------------------------- breakable models ----
// Origin = centre of the footprint at floor level. `lift` is how high above
// the floor the thing stands (things on desks stand on the desk top).
const DESK_TOP = 62; // height of the desk and table tops; screens and laptops are lifted by it
const lift = (type) => (type === 'monitor' || type === 'laptop' ? DESK_TOP : 0);
const PICK = { // invisible pick box, bigger than the model so small things are easy to click: [w, h, d]
  laptop: [56, 40, 40], monitor: [56, 66, 36], chair: [44, 66, 44], printer: [72, 50, 56],
  cooler: [48, 118, 48], coffee: [60, 82, 50], server: [68, 170, 58], plant: [44, 96, 44],
  desk: [160, 76, 110], tv: [100, 118, 36], toilet: [50, 70, 64], sink: [54, 64, 44], safe: [64, 72, 60],
};
const RUBBLE = {
  laptop: ['#9aa3b2', '#1c2330', '#4aa8ff'],
  monitor: ['#11151d', '#4aa8ff', '#c7cdd8'],
  chair: ['#394a63', '#222c3d', '#6b7a93'],
  printer: ['#cfd6e0', '#9aa3b2', '#ffffff'],
  cooler: ['#5ab4ff', '#dfe6ee', '#a6d8ff'],
  coffee: ['#3a2f2a', '#ffffff', '#c0392b'],
  server: ['#0f1218', '#37e07a', '#2b3240'],
  plant: ['#8a5a3a', '#3e9b55', '#2f7d45'],
  desk: ['#9c7e5a', '#7d6347', '#b08f66'],
  tv: ['#11151d', '#4aa8ff', '#2b3240'],
  toilet: ['#f2f5f8', '#cfd6e0', '#9aa3b2'],
  sink: ['#eef2f6', '#cfd6e0', '#aab4c2'],
  safe: ['#4b5262', '#2b3240', '#c9d1de'],
  bookcase: ['#d9a066', '#a8743f', '#f0d2a5'],
  lamp: ['#f2e6b0', '#cfcfcf', '#8a8f99'],
  trash: ['#8fa3a8', '#5f7377', '#c7d3d6'],
  coatrack: ['#c89a5e', '#a8743f'],
  fridge: ['#e6ebf0', '#b9c3cf', '#8a8f99'],
  speaker: ['#a8743f', '#2b3240', '#5f7377'],
  sofa: ['#c9706c', '#8a4b49', '#e39a96'],
  table: ['#d9c7a3', '#8a8f99', '#f0e6d0'],
  conference: ['#d9c7a3', '#8a8f99', '#f0e6d0'],
};
const NO_SHADOW_ON_TOUCH = new Set(['monitor', 'laptop', 'trash']);
const ELECTRONIC = new Set(['laptop', 'monitor', 'printer', 'server', 'coffee', 'tv', 'fridge', 'speaker']);

const BOSS_SCALE = 2.1; // the boss is a big man

// Floor textures (ambientCG, CC0): colour + normal map per floor kind, tinted to the office palette. If a file is
// missing the old canvas-drawn floor is used. [file, world units per repeat, tint]
const FLOOR_FILES = { carpet: ['carpet', 300, 0x4d5b7e], wood: ['wood', 340, 0xd4ab80], tile: ['tile', 300, 0xb4c4d6], metal: ['metal', 220, 0x8793a6] };
const FLOOR_TEX = {};
async function loadFloorTextures() {
  const tl = new THREE.TextureLoader();
  await Promise.all(Object.entries(FLOOR_FILES).map(async ([k, [file, size, tint]]) => {
    try {
      const [map, normal] = await Promise.all([tl.loadAsync('./assets/textures/' + file + '_color.jpg'), tl.loadAsync('./assets/textures/' + file + '_normal.jpg')]);
      map.colorSpace = THREE.SRGBColorSpace;
      for (const t of [map, normal]) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = 8;
      }
      FLOOR_TEX[k] = { map, normal, size, tint };
    } catch (e) { /* keep the canvas floor */ }
  }));
}

function buildModel(type, types, largeScreen = false, arm = false, itDesk = false, armSide = 1) {
  const body = [];
  const glow = [];
  let pick = null;
  if (type === 'table' || type === 'conference' || type === 'sofa') {
    const t = types[type];
    for (const g of furnitureFallback(type, t.w, t.h)) body.push(g);
    pick = [t.w + 10, 90, t.h + 10];
  } else if (type === 'desk') {
    for (const g of deskGeometry(itDesk)) body.push(g);
    // a mug and a stack of paper so the desks do not look empty
    body.push(cyl(6, 5.5, 11, '#f2f2ee', -60, DESK_TOP + 5.5, 24, 14));
    body.push(cyl(4.6, 4.6, 1, '#4b2e1d', -60, DESK_TOP + 10.6, 24, 14));
    body.push(box(26, 3, 34, '#f4f1e8', 58, DESK_TOP + 1.5, -34, 0, 0.12));
    body.push(box(26, 2, 34, '#e3dfd2', 57, DESK_TOP + 4, -33, 0, -0.08));
    pick = [170, 80, 120];
  } else switch (type) {
    case 'monitor':
      if (arm) {
        // Both arms converge on the single central pole carried by the desk.
        const base = new THREE.Vector3(-30 * armSide, 30, -22);
        const elbow = new THREE.Vector3(-14 * armSide, 30, -12);
        const mount = new THREE.Vector3(0, 39, -3);
        for (const [a, b] of [[base, elbow], [elbow, mount]]) {
          const direction = b.clone().sub(a);
          const link = box(5, direction.length(), 5, '#7c8da2');
          link.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()));
          link.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
          body.push(link);
        }
        body.push(cyl(3.5, 3.5, 7, '#354052', elbow.x, elbow.y, elbow.z));
        body.push(box(14, 14, 2, '#354052', 0, 39, -3));
      } else {
        body.push(cyl(11, 13, 3, '#2b3240', 0, 1.5, 0));
        body.push(box(6, 20, 4, '#2b3240', 0, 13, -2));
      }
      body.push(box(46, 32, 3.6, '#141720', 0, 39, 0));
      body.push(box(46, 2.5, 4, '#202532', 0, 24.2, 0));
      // IDE workstation screen (dark theme code editor)
      glow.push(box(42, 26, 0.6, '#181a24', 0, 39, 2.0));
      glow.push(box(42, 1.8, 0.7, '#007acc', 0, 27, 2.1)); // VS Code status bar
      glow.push(box(42, 2.2, 0.7, '#242838', 0, 50.8, 2.1)); // tab bar
      glow.push(box(14, 2.2, 0.8, '#181a24', -13, 50.8, 2.15)); // active tab
      glow.push(box(2, 1.2, 0.9, '#e5c07b', -18, 50.8, 2.2));
      glow.push(box(8, 21.6, 0.7, '#13151f', -17, 39, 2.1)); // file explorer
      // syntax-highlighted code strips
      glow.push(box(5, 1.2, 0.75, '#c678dd', -9, 47.5, 2.15));
      glow.push(box(11, 1.2, 0.75, '#61afef', 1.5, 47.5, 2.15));
      glow.push(box(6, 1.2, 0.75, '#e06c75', -8.5, 44.5, 2.15));
      glow.push(box(13, 1.2, 0.75, '#56b6c2', 3, 44.5, 2.15));
      glow.push(box(4, 1.2, 0.75, '#e5c07b', -6.5, 41.5, 2.15));
      glow.push(box(14, 1.2, 0.75, '#98c379', 5, 41.5, 2.15));
      glow.push(box(10, 1.2, 0.75, '#56b6c2', -3.5, 38.5, 2.15));
      glow.push(box(7, 1.2, 0.75, '#e06c75', 7.5, 38.5, 2.15));
      glow.push(box(15, 1.2, 0.75, '#98c379', 0, 35.5, 2.15));
      glow.push(box(3, 1.2, 0.75, '#abb2bf', -10, 32.5, 2.15));
      break;
    case 'laptop':
      body.push(box(46, 2.5, 30, '#8c95a3', 0, 1.3, 0));
      body.push(box(15, 0.4, 9, '#767f8e', 0, 2.7, 8)); // trackpad
      body.push(box(38, 0.4, 13, '#2b313d', 0, 2.7, -4)); // keyboard well
      body.push(box(46, 28, 2, '#21252f', 0, 16, -13, -0.22)); // lid
      // Terminal display
      glow.push(box(42, 24, 0.5, '#161822', 0, 16, -12, -0.22));
      glow.push(box(3, 1.2, 0.6, '#3ddc84', -16, 24.5, -11.9, -0.22)); // prompt
      glow.push(box(14, 1.2, 0.6, '#61afef', -5, 24.5, -11.9, -0.22));
      glow.push(box(24, 1.0, 0.6, '#abb2bf', -3, 21.5, -11.9, -0.22));
      glow.push(box(18, 1.0, 0.6, '#98c379', -6, 18.5, -11.9, -0.22));
      glow.push(box(28, 1.0, 0.6, '#ffd24a', 1, 15.5, -11.9, -0.22));
      break;
    case 'chair': {
      // an office swivel chair: ergonomic seat, breathable mesh back, metallic cylinder, lumbar cushion, 5-star base with casters
      const SEAT = '#e48a8a';
      const SEAT_DARK = '#c96f6f';
      const FRAME = '#2f3644';
      const CHROME = '#b8c5d6';
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        body.push(pill(2.3, 13, FRAME, Math.sin(a) * 9, 6.5, Math.cos(a) * 9, Math.PI / 2, a, 0));
        body.push(sph(3.2, '#1b212c', Math.sin(a) * 17, 3.2, Math.cos(a) * 17));
        body.push(sph(1.6, CHROME, Math.sin(a) * 17, 3.2, Math.cos(a) * 17)); // wheel hub
      }
      body.push(cyl(2.6, 3.2, 17, CHROME, 0, 15, 0, 14)); // shining gas lift
      body.push(cyl(14, 12, 4, FRAME, 0, 23.5, 0, 22));
      body.push(pill(1.2, 8, CHROME, 8, 23, 2, 0, 0, Math.PI / 2)); // lift lever
      body.push(box(3, 1.2, 4, '#1b212c', 13, 23, 2));
      body.push(ell(19.5, 6.8, 18.5, SEAT, 0, 28, 1.5));
      body.push(ell(17, 4, 16, SEAT_DARK, 0, 24.5, 1.5));
      body.push(pill(2.4, 10, FRAME, 0, 33, -14.5));
      body.push(ell(14, 4.5, 3.5, '#a14a52', 0, 41, -15.5)); // lumbar support cushion
      body.push(ell(18.5, 21, 5.4, '#b9565e', 0, 51, -17.5, -0.14)); // tall curved back
      body.push(ell(13.5, 7, 4.2, '#a14a52', 0, 70, -19.5, -0.14)); // headrest
      for (const sx of [-1, 1]) {
        body.push(pill(1.9, 10, FRAME, sx * 19.5, 31.5, 4, Math.PI / 2));
        body.push(ell(3.6, 3, 8, SEAT_DARK, sx * 19.5, 37, 3));
        body.push(pill(1.6, 7, FRAME, sx * 19.5, 31.5, 8));
      }
      break;
    }
    case 'bookcase': {
      const FR = '#c8925c';
      const IN = '#a8743f';
      body.push(box(5, 172, 38, FR, -42.5, 86, 0), box(5, 172, 38, FR, 42.5, 86, 0), box(90, 6, 40, FR, 0, 172, 0), box(86, 8, 36, IN, 0, 5, 0), box(84, 162, 3, IN, 0, 86, -17));
      const rnd = seeded(7);
      const BOOK = ['#d9534f', '#4a7fd0', '#e8b84a', '#4fae7b', '#8a64c8', '#e07fa0', '#f2f2ee'];
      const BINDERS = ['#3b82f6', '#ef4444', '#10b981', '#6366f1'];
      for (const y of [34, 68, 102, 136]) {
        body.push(box(82, 3.5, 34, FR, 0, y, 0));
        let x = -37;
        // Office binder files with spine labels
        if (y === 68 || y === 102) {
          for (let bi = 0; bi < 3; bi++) {
            const bc = BINDERS[(bi + (y > 80 ? 2 : 0)) % BINDERS.length];
            body.push(box(5.5, 23, 24, bc, x + 3, y + 13, -3));
            body.push(box(3.5, 13, 0.4, '#ffffff', x + 3, y + 14, 9.2)); // spine label
            x += 6.5;
          }
          x += 3;
        }
        while (x < 32) {
          const bw = 4 + rnd() * 4;
          const bh = 17 + rnd() * 9;
          body.push(box(bw, bh, 22, BOOK[Math.floor(rnd() * BOOK.length)], x + bw / 2, y + 1.8 + bh / 2, -3, 0, 0, (rnd() - 0.5) * 0.12));
          x += bw + 0.6 + (rnd() < 0.18 ? 6 : 0);
        }
      }
      // Top shelf trophy decor
      body.push(cyl(4, 2, 9, '#e5c07b', 26, 178, 0, 10));
      body.push(cyl(5, 5, 3, '#2b3240', 26, 173, 0, 10));
      pick = [100, 186, 50];
      break;
    }
    case 'lamp':
      body.push(cyl(13, 15, 4, '#3a4252', 0, 2, 0, 20), pill(1.7, 160, '#6b7585', 0, 84, 0), cyl(11, 17, 26, '#f6e6b4', 0, 170, 0, 22), cyl(11.6, 11.6, 1.5, '#e3cf94', 0, 183, 0, 22));
      glow.push(ell(7, 7, 7, '#fff1b8', 0, 164, 0));
      pick = [40, 205, 40];
      break;
    case 'trash':
      body.push(cyl(13.5, 11, 52, '#4b5568', 0, 26, 0, 22), cyl(14.8, 14.8, 3.5, '#b4beca', 0, 53, 0, 22), cyl(11, 11, 1.5, '#1e2430', 0, 52, 0, 22));
      body.push(sph(3.5, '#f4f6f8', 2, 48, -2, 1.2, 0.9, 1.1)); // crumpled paper
      pick = [40, 62, 40];
      break;
    case 'coatrack':
      body.push(cyl(16, 18, 4, '#6b4a2c', 0, 2, 0, 22), pill(2.2, 124, '#8a5a30', 0, 66, 0));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        body.push(pill(1.7, 12, '#8a5a30', Math.sin(a) * 8, 128, Math.cos(a) * 8, Math.cos(a) * 0.9, 0, -Math.sin(a) * 0.9), sph(2.7, '#c0392b', Math.sin(a) * 14, 134, Math.cos(a) * 14));
      }
      pick = [46, 150, 46];
      break;
    case 'fridge':
      body.push(box(56, 76, 40, '#e2e7ef', 0, 40, 0), box(55, 2, 1, '#9aa5b5', 0, 52, 20.2), pill(1.6, 16, '#b4beca', 21, 66, 22.5), pill(1.6, 20, '#b4beca', 21, 33, 22.5));
      body.push(sph(2.5, '#6a7280', -20, 1.5, 15), sph(2.5, '#6a7280', 20, 1.5, 15));
      body.push(box(9, 9, 0.5, '#ffd24a', -12, 64, 20.4, 0, 0, 0.1)); // post-it memo
      body.push(sph(2, '#4aa8ff', -12, 67, 20.7)); // magnet
      body.push(box(6, 9, 0.5, '#37e07a', -12, 38, 20.4)); // eco sticker
      pick = [64, 82, 48];
      break;
    case 'speaker':
      body.push(box(24, 100, 22, '#a8743f', 0, 50, 0), box(20, 92, 2, '#2b3240', 0, 50, 11.2), ell(8.5, 8.5, 3, '#5f6b7d', 0, 34, 12), ell(5, 5, 3, '#5f6b7d', 0, 68, 12), ell(2.2, 2.2, 2, '#9aa6b8', 0, 34, 14), ell(1.6, 1.6, 2, '#9aa6b8', 0, 68, 14));
      pick = [34, 106, 34];
      break;
    case 'printer':
      body.push(box(64, 28, 46, '#d5dce6', 0, 14, 0));
      body.push(box(60, 6, 40, '#2b3240', 0, 31, 0));
      body.push(box(56, 4, 38, '#9aa5b5', 0, 34, 0)); // scanner lid
      body.push(box(46, 14, 3, '#f4f6f9', 0, 42, -14, -0.5)); // paper feed
      body.push(box(48, 2, 16, '#e4e8ee', 0, 15, 28)); // tray
      // Fresh printed sheet emerging with printed text lines
      body.push(box(32, 0.8, 18, '#ffffff', 0, 17, 26, -0.05));
      body.push(sbox(24, 0.2, 1.2, '#2f3646', 0, 17.5, 22));
      body.push(sbox(20, 0.2, 1.2, '#2f3646', -2, 17.5, 25));
      body.push(sbox(26, 0.2, 1.2, '#2f3646', 1, 17.5, 28));
      // Angled LCD touch screen
      body.push(box(20, 12, 3, '#242a36', -18, 26, 24, -0.4));
      glow.push(box(16, 8, 0.8, '#4aa8ff', -18, 26, 25.4, -0.4));
      glow.push(box(4, 4, 0.9, '#ffffff', -21, 26, 25.8, -0.4)); // icon
      glow.push(box(4, 2, 1, '#37e07a', 20, 26, 23.5)); // ready LED
      break;
    case 'cooler':
      body.push(box(36, 62, 36, '#f0f3f7', 0, 31, 0));
      body.push(box(24, 24, 6, '#262b36', 0, 42, 16)); // dispenser alcove
      body.push(box(22, 2.5, 8, '#9aa5b5', 0, 31, 16.5)); // drip tray
      body.push(box(3, 5, 5, '#e5483a', -5, 48, 17.5)); // hot tap
      body.push(box(3, 5, 5, '#3b97e0', 5, 48, 17.5)); // cold tap
      body.push(cyl(2.8, 2.2, 5.5, '#ffffff', 5, 34, 16.5, 12)); // cup
      // Water bottle
      body.push(cyl(13.5, 13.5, 34, '#42a2f8', 0, 84, 0, 16));
      body.push(cyl(5.5, 11, 7, '#2b84dc', 0, 65, 0, 14));
      body.push(cyl(6.5, 6.5, 2.5, '#1e68b8', 0, 63.5, 0, 14));
      body.push(sph(2.2, '#d6efff', -4, 82, 5), sph(1.8, '#d6efff', 3, 91, -4)); // air bubbles
      glow.push(box(2.5, 2.5, 1, '#37e07a', -12, 56, 18.2)); // green power LED
      break;
    case 'coffee':
      body.push(box(52, 56, 40, '#222630', 0, 28, 0));
      body.push(box(46, 20, 2, '#9aa5b5', 0, 44, 20.5)); // chrome front fascia
      body.push(box(44, 6, 32, '#181b22', 0, 59, 0));
      body.push(cyl(14, 12, 10, '#3e2516', 0, 66, 0, 14)); // bean hopper
      body.push(cyl(3.8, 3.2, 7, '#f4f6f8', -13, 65, 4, 12)); // white cup
      body.push(cyl(3.8, 3.2, 7, '#e4572e', 13, 65, 4, 12)); // terracotta cup
      body.push(cyl(5, 5, 4, '#b4beca', 0, 34, 20, 12)); // portafilter
      body.push(pill(1.8, 13, '#161920', 10, 34, 22, 0, 0.4, Math.PI / 2)); // handle
      body.push(box(42, 2.5, 18, '#7b8796', 0, 3, 21)); // drip tray
      body.push(cyl(3.5, 3.0, 6, '#f0f3f6', 0, 7.5, 21, 12)); // cup under spout
      body.push(cyl(2.8, 2.8, 0.5, '#3b2214', 0, 10.2, 21, 10)); // crema
      glow.push(box(12, 6, 0.6, '#4aa8ff', -12, 44, 21.6)); // LCD display
      glow.push(box(4, 4, 0.8, '#37e07a', 14, 44, 21.6)); // green brew button
      break;
    case 'server':
      body.push(box(60, 140, 50, '#10141c', 0, 70, 0));
      body.push(box(64, 4, 54, '#242b38', 0, 142, 0));
      body.push(box(58, 136, 1.5, '#1e2532', 0, 70, 26)); // tinted glass door frame
      body.push(box(3, 14, 3, '#9aa5b5', 26, 70, 27.5)); // rack door handle
      for (let i = 0; i < 8; i++) {
        const y = 14 + i * 16;
        body.push(box(52, 12, 1, '#181e2a', 0, y, 25.5)); // 2U rack blade
        body.push(box(1.8, 7, 2, '#6c7a8e', -23, y, 26.2));
        body.push(box(1.8, 7, 2, '#6c7a8e', 23, y, 26.2));
        for (let k = 0; k < 3; k++) {
          glow.push(box(3.5, 2.2, 1, k === 0 ? '#37e07a' : k === 1 ? '#4aa8ff' : '#ffb02e', -14 + k * 6, y, 26.8));
        }
        // Colorful Ethernet patch cables
        body.push(pill(1.2, 10, i % 2 === 0 ? '#4aa8ff' : '#ffb02e', 12, y, 26.8, Math.PI / 2));
        body.push(pill(1.2, 10, i % 3 === 0 ? '#37e07a' : '#e5483a', 16, y, 26.8, Math.PI / 2));
      }
      glow.push(box(16, 5, 0.8, '#4aa8ff', 0, 130, 26.6)); // top console LCD
      break;
    case 'plant':
      body.push(cyl(15, 12, 28, '#f4f6f9', 0, 16, 0, 16)); // ceramic pot
      body.push(cyl(16, 16, 3, '#c9d3df', 0, 30, 0, 16)); // pot rim
      body.push(cyl(12.5, 12.5, 4, '#b58351', 0, 2, 0, 14)); // wooden base
      body.push(cyl(14, 14, 3, '#322319', 0, 28, 0, 14)); // soil
      body.push(cyl(2.2, 2.8, 22, '#488e36', 0, 39, 0, 8)); // trunk
      body.push(ell(14, 2.5, 18, '#3e9b55', -4, 48, 6, 0.3, -0.4, 0.2));
      body.push(ell(13, 2.5, 16, '#2f7d45', 6, 52, -5, -0.2, 0.6, -0.3));
      body.push(ell(15, 2.5, 17, '#4db26a', -8, 58, -6, -0.4, -0.3, 0.4));
      body.push(ell(12, 2.5, 14, '#38a050', 5, 66, 4, 0.4, 0.2, -0.2));
      body.push(ell(9, 2.2, 11, '#5ec77d', 0, 75, 0, 0, 0, 0));
      break;
    case 'tv':
      body.push(box(44, 3, 26, '#2b3240', 0, 1.5, 0));
      body.push(box(5, 40, 5, '#2b3240', 0, 22, -2));
      {
        const w = largeScreen || 1;
        const h = largeScreen ? largeScreen * 0.9 : 1;
        const cy = 46 + 28 * h; // keep the bottom edge at the top of the stand
        body.push(box(92 * w, 56 * h, 4, '#12151c', 0, cy, 0));
        body.push(box(92 * w, 2.5 * h, 4.5, '#242936', 0, cy - 27 * h, 0)); // bezel chin
        // Growth Bar Chart Dashboard
        glow.push(box(92 * w - 6, 56 * h - 6, 0.8, '#151822', 0, cy, 2.6));
        glow.push(box(92 * w - 6, 4 * h, 0.85, '#252b3d', 0, cy + 24 * h, 2.7));
        glow.push(box(8 * w, 14 * h, 0.9, '#4aa8ff', -26 * w, cy - 10 * h, 2.8));
        glow.push(box(8 * w, 22 * h, 0.9, '#37e07a', -13 * w, cy - 6 * h, 2.8));
        glow.push(box(8 * w, 30 * h, 0.9, '#ffd24a', 0 * w, cy - 2 * h, 2.8));
        glow.push(box(8 * w, 38 * h, 0.9, '#c678dd', 13 * w, cy + 2 * h, 2.8));
        glow.push(box(8 * w, 44 * h, 0.9, '#ff6b5a', 26 * w, cy + 5 * h, 2.8));
        glow.push(box(64 * w, 1.8 * h, 1.0, '#ffffff', 0, cy + 8 * h, 2.9, 0, 0, 0.22)); // trend line
        if (largeScreen) pick = [92 * w + 8, 46 + 56 * h + 8, 36];
      }
      break;
    case 'toilet':
      body.push(ell(14, 11, 19, '#f4f6f9', 0, 12, 6), ell(16.5, 5, 21.5, '#fbfcfd', 0, 24, 7), ell(11, 2.4, 16, '#cfe3f5', 0, 26.8, 7));
      body.push(box(30, 34, 14, '#eef1f5', 0, 35, -16), box(32, 4, 16, '#e0e6ee', 0, 54, -16), pill(1.8, 4, '#aab4c2', 0, 57, -16, 0, 0, Math.PI / 2));
      break;
    case 'sink':
      body.push(cyl(7, 9, 44, '#eef2f6', 0, 22, 0, 18), ell(24, 9, 19, '#f8fafc', 0, 52, 0), ell(19, 1.4, 14, '#cfe3f5', 0, 58.5, 0));
      body.push(pill(1.5, 10, '#aab4c2', 0, 64, -13), pill(1.3, 8, '#aab4c2', 0, 71, -9, Math.PI / 2));
      break;
    case 'safe':
      body.push(box(54, 62, 50, '#4b5262', 0, 31, 0));
      body.push(box(46, 54, 2, '#3a404d', 0, 31, 25.5));
      body.push(cyl(8, 8, 3, '#c9d1de', 0, 34, 27, 12));
      body.push(box(14, 3, 3, '#f2c744', 0, 34, 29));
      glow.push(box(6, 3, 1, '#37e07a', -16, 52, 26.5));
      break;
    default:
      body.push(box(30, 30, 30, '#888888', 0, 15, 0));
  }

  // wrecks first: they clone the parts before merge() strips them
  const wrecks = [];
  for (let v = 0; v < WRECK_VARIANTS; v++) wrecks.push(buildWreck(type, body, glow, types[type], v));
  return { body: bakeAO(merge(body)), glow: merge(glow), wrecks, pick };
}

// ------------------------------------------------------------------ wrecks ----
// A broken object leaves a wreck made of its own parts, so a smashed chair still reads as a chair: free-standing
// things topple, desks and tables collapse onto their legs, boxy machines are crushed, porcelain shatters. Screens
// go dark and monitors/TVs crack. Loose parts and chips lie around it until IT replaces the object. Each type has
// WRECK_VARIANTS variants and the object's id picks one, so every player (also one who joins later) sees the same
// wreck.
const WRECK_VARIANTS = 3;
const WRECK_MODE = {
  desk: 'collapse', table: 'collapse', conference: 'collapse',
  printer: 'crush', coffee: 'crush', safe: 'crush', laptop: 'crush',
  toilet: 'shatter', sink: 'shatter', sofa: 'shatter', // a sofa loses its cushions and back
  lamp: 'snap', coatrack: 'snap', // too tall to fall over whole without going through a wall: the pole snaps
}; // everything else topples
// These stand free and may fall any way; the other tall things stand against a wall and fall forward (+z).
const TOPPLE_ANY_WAY = new Set(['monitor', 'tv', 'trash', 'plant', 'chair']);
const WRECK_DESK_TOP = 12; // a screen or laptop on a collapsed desk ends up about this high
const MARK_KIND = { cooler: 'water', toilet: 'water', sink: 'water', fridge: 'water', plant: 'soil' }; // electronics scorch, the rest dust
const MARK_KINDS = ['scorch', 'water', 'soil', 'dust'];
// is o (a screen or laptop) standing on the desk or table d?
function standsOn(o, d, types) {
  const t = types[d.type];
  const sideways = Math.abs(Math.sin(d.rot || 0)) > 0.7;
  const hw = (sideways ? t.h : t.w) / 2 + 4;
  const hd = (sideways ? t.w : t.h) / 2 + 4;
  return Math.abs(o.x - d.x) <= hw && Math.abs(o.y - d.y) <= hd;
}
// Irregular soft blobs in one atlas, one cell per mark kind; drawn once, no image files.
// The floor-mark atlas, one cell per kind, painted pixel by pixel (see makeAlphaTexture for why not a canvas):
// soft blobs layered "over" each other, wet highlights on water and soot streaks on scorch. Returns RGBA bytes,
// row 0 at v = 0.
function paintMarks(w, h) {
  const px = new Float32Array(w * h * 4); // straight colour 0..255 and alpha 0..1
  const over = (i, j, r, g, b, a) => {
    if (a <= 0 || i < 0 || j < 0 || i >= w || j >= h) return;
    const k = (j * w + i) * 4, da = px[k + 3], oa = a + da * (1 - a);
    for (let c = 0; c < 3; c++) px[k + c] = ([r, g, b][c] * a + px[k + c] * da * (1 - a)) / oa;
    px[k + 3] = oa;
  };
  // a radial gradient like canvas: alpha stops [[t, a], ...] over the radius, drawn inside the cell [x0, x1)
  const blob = (x, y, rad, [r, g, b], stops, x0, x1) => {
    for (let j = Math.max(0, Math.floor(y - rad)); j < Math.min(h, Math.ceil(y + rad)); j++) {
      for (let i = Math.max(x0, Math.floor(x - rad)); i < Math.min(x1, Math.ceil(x + rad)); i++) {
        const t = Math.hypot(i + 0.5 - x, j + 0.5 - y) / rad;
        if (t >= 1) continue;
        let n = 1;
        while (stops[n][0] < t) n++;
        const [t0, a0] = stops[n - 1], [t1, a1] = stops[n];
        over(i, j, r, g, b, a0 + ((a1 - a0) * (t - t0)) / (t1 - t0));
      }
    }
  };
  // a 2px streak with a soft edge
  const line = (ax, ay, bx, by, [r, g, b], a) => {
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (let j = Math.floor(Math.min(ay, by) - 2); j <= Math.ceil(Math.max(ay, by) + 2); j++) {
      for (let i = Math.floor(Math.min(ax, bx) - 2); i <= Math.ceil(Math.max(ax, bx) + 2); i++) {
        const cx = i + 0.5, cy = j + 0.5;
        const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / len2));
        const d = Math.hypot(cx - ax - dx * t, cy - ay - dy * t);
        over(i, j, r, g, b, a * Math.max(0, Math.min(1, 1.5 - d)));
      }
    }
  };
  const cell = w / MARK_KINDS.length;
  const rnd = seeded(4242);
  const style = {
    scorch: [[24, 18, 15, 0.8], 7],
    water: [[118, 168, 214, 0.5], 5],
    soil: [[74, 48, 30, 0.85], 9],
    dust: [[150, 140, 128, 0.42], 8],
  };
  MARK_KINDS.forEach((k, i) => {
    const [[cr, cg, cb, ca], blobs] = style[k];
    const ox = i * cell;
    for (let b = 0; b < blobs; b++) {
      const x = ox + cell / 2 + (rnd() - 0.5) * cell * 0.35;
      const y = h / 2 + (rnd() - 0.5) * h * 0.35;
      const rad = cell * (0.16 + rnd() * 0.16);
      blob(x, y, rad, [cr, cg, cb], [[0, ca * 0.7], [0.6, ca * 0.35], [1, 0]], ox, ox + cell);
    }
    if (k === 'water') { // a few highlights so it reads as wet
      for (let s = 0; s < 3; s++) {
        const x = ox + cell / 2 + (rnd() - 0.5) * cell * 0.3;
        const y = h / 2 + (rnd() - 0.5) * h * 0.3;
        blob(x, y, cell * 0.07, [235, 245, 255], [[0, 0.55], [1, 0]], ox, ox + cell);
      }
    }
    if (k === 'scorch') { // soot streaks
      for (let s = 0; s < 9; s++) {
        const a = rnd() * Math.PI * 2;
        const far = 0.25 + rnd() * 0.17;
        line(ox + cell / 2 + Math.cos(a) * cell * 0.08, h / 2 + Math.sin(a) * h * 0.08,
          ox + cell / 2 + Math.cos(a) * cell * far, h / 2 + Math.sin(a) * h * far, [10, 8, 7], 0.45);
      }
    }
  });
  const out = new Uint8Array(w * h * 4);
  for (let k = 0; k < out.length; k += 4) {
    out[k] = px[k]; out[k + 1] = px[k + 1]; out[k + 2] = px[k + 2];
    out[k + 3] = Math.round(px[k + 3] * 255);
  }
  return out;
}
const wreckVariant = (id) => (Math.imul(id + 1, 2654435761) >>> 0) % WRECK_VARIANTS;
const idNoise = (id, salt) => ((Math.imul(id + salt, 40503) >>> 0) % 1000) / 1000 - 0.5; // -0.5..0.5, fixed per id
const strSeed = (s) => {
  let h = 7;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 1000003;
  return h;
};
const _box3 = new THREE.Box3();
function boundsOf(list) {
  _box3.makeEmpty();
  for (const g of list) {
    g.computeBoundingBox();
    _box3.union(g.boundingBox);
  }
  return _box3;
}
function centreOf(g) {
  g.computeBoundingBox();
  return g.boundingBox.getCenter(new THREE.Vector3());
}
// rotate a part about a pivot
function turn(g, rx, ry, rz, px, py, pz) {
  g.translate(-px, -py, -pz);
  _e.set(rx, ry, rz);
  g.applyMatrix4(_m.makeRotationFromEuler(_e));
  g.translate(px, py, pz);
  return g;
}
function restOnFloor(list, floor = 0) {
  const y = boundsOf(list).min.y;
  for (const g of list) g.translate(0, floor - y, 0);
}

function buildWreck(type, body, glow, t, variant) {
  const rnd = seeded(strSeed(type) * 13 + variant * 7919);
  const r = (a, b) => a + rnd() * (b - a);
  const parts = body.map((g) => g.clone());
  // a bent, cracked look: every part is knocked a little out of place
  for (const g of parts) {
    const c = centreOf(g);
    turn(g, r(-0.1, 0.1), r(-0.1, 0.1), r(-0.1, 0.1), c.x, c.y, c.z);
    g.translate(r(-1.2, 1.2), 0, r(-1.2, 1.2));
  }
  // screens go dark, small lights go out
  let screen = null;
  for (const g of glow) {
    g.computeBoundingBox();
    const size = g.boundingBox.getSize(new THREE.Vector3());
    const area = size.x * size.y;
    if (area < 120) continue;
    const dark = paint(g.clone(), '#0a0d13');
    parts.push(dark);
    if (!screen || area > screen.area) screen = { area, box: g.boundingBox.clone() };
  }
  if (screen && (type === 'monitor' || type === 'tv')) {
    const b = screen.box;
    const bw = b.max.x - b.min.x;
    const bh = b.max.y - b.min.y;
    const cx = b.min.x + bw * r(0.35, 0.65);
    const cy = b.min.y + bh * r(0.35, 0.65);
    const n = 6 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r(-0.3, 0.3);
      // stop at the edge of the screen
      const room = Math.min(Math.abs((Math.cos(a) > 0 ? b.max.x - cx : cx - b.min.x) / (Math.cos(a) || 1e-6)),
        Math.abs((Math.sin(a) > 0 ? b.max.y - cy : cy - b.min.y) / (Math.sin(a) || 1e-6)));
      const len = room * r(0.55, 0.95);
      parts.push(sbox(len, 0.7, 0.5, '#aebbd0', cx + (Math.cos(a) * len) / 2, cy + (Math.sin(a) * len) / 2, b.max.z + 0.3, 0, 0, a));
    }
  }

  // knocked-off parts lie on the floor around the wreck
  const loose = [];
  const detach = (g) => {
    const c = centreOf(g);
    // lies on its widest side (a panel lies flat, it does not stand on its edge), a little askew
    const s = g.boundingBox.getSize(new THREE.Vector3());
    const thin = s.x < s.y && s.x < s.z ? 'x' : s.z < s.y ? 'z' : 'y';
    turn(g, thin === 'z' ? Math.PI / 2 : 0, 0, thin === 'x' ? Math.PI / 2 : 0, c.x, c.y, c.z);
    turn(g, r(-0.25, 0.25), r(0, Math.PI * 2), r(-0.25, 0.25), c.x, c.y, c.z);
    const a = r(0, Math.PI * 2);
    const d = r(0.35, 0.75);
    g.translate(Math.cos(a) * t.w * d - c.x, 0, Math.sin(a) * t.h * d - c.z);
    restOnFloor([g]);
    loose.push(g);
  };
  const mode = WRECK_MODE[type] || 'topple';
  let surface = null;
  let main = parts.slice(0, body.length);
  const extra = parts.slice(body.length); // dark screens and cracks stay with the main body
  if (mode === 'shatter' || mode === 'snap') main.push(...extra.splice(0)); // a lamp's bulb falls with the shade
  if (mode === 'shatter') {
    const top = boundsOf(main).max.y;
    const keep = [];
    for (const g of main) (centreOf(g).y < top * 0.45 ? keep : loose).push(g);
    main = keep;
    for (const g of loose.splice(0)) detach(g);
  } else if (mode === 'snap') {
    // long upright parts break: a stub stays, the upper piece falls; everything up top comes down
    const top = boundsOf(main).max.y;
    const keep = [];
    for (const g of main) {
      g.computeBoundingBox();
      const b = g.boundingBox;
      if (b.max.y - b.min.y > top * 0.4) {
        const upper = g.clone();
        const y0 = b.min.y;
        const k = r(0.3, 0.45);
        g.translate(0, -y0, 0).scale(1, k, 1).translate(0, y0, 0);
        upper.translate(0, -y0, 0).scale(1, 1 - k, 1).translate(0, y0, 0);
        keep.push(g);
        detach(upper);
      } else if (centreOf(g).y < top * 0.3) keep.push(g);
      else detach(g);
    }
    main = keep;
  } else if (main.length > 2) {
    // one to three of the smaller parts come off
    const vol = (g) => {
      g.computeBoundingBox();
      const s = g.boundingBox.getSize(new THREE.Vector3());
      return s.x * s.y * s.z;
    };
    const total = main.reduce((sum, g) => sum + vol(g), 0);
    const small = main.filter((g) => vol(g) < total * 0.2);
    const k = Math.min(small.length, 1 + Math.floor(rnd() * 3));
    for (let i = 0; i < k; i++) {
      const g = small.splice(Math.floor(rnd() * small.length), 1)[0];
      main.splice(main.indexOf(g), 1);
      detach(g);
    }
  }
  main.push(...extra);

  if (mode === 'topple') {
    const b = boundsOf(main);
    const [x0, y0, z0, x1, z1] = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.z];
    const dir = TOPPLE_ANY_WAY.has(type) ? [0, 1, rnd() < 0.5 ? 2 : 3][variant % 3] : 0;
    const ang = (Math.PI / 2) * r(0.9, 1);
    for (const g of main) {
      if (dir === 0) turn(g, ang, 0, 0, 0, y0, z1); // forward, face down
      else if (dir === 1) turn(g, -ang, 0, 0, 0, y0, z0); // backward, face up
      else if (dir === 2) turn(g, 0, 0, ang, x0, y0, 0); // onto its left side
      else turn(g, 0, 0, -ang, x1, y0, 0); // onto its right side
    }
    restOnFloor(main);
    const yaw = r(-0.35, 0.35);
    for (const g of main) turn(g, 0, yaw, 0, 0, 0, 0);
  } else if (mode === 'crush') {
    const k = type === 'safe' ? r(0.75, 0.85) : r(0.4, 0.6);
    const rx = r(-0.08, 0.08);
    const rz = r(-0.12, 0.12);
    for (const g of main) {
      g.scale(1.06, k, 1.06);
      turn(g, rx, r(-0.05, 0.05), rz, 0, 0, 0);
    }
    restOnFloor(main);
  } else if (mode === 'collapse') {
    // the top falls; the legs and drawers fall over underneath
    const top = [];
    const legs = [];
    for (const g of main) {
      g.computeBoundingBox();
      (g.boundingBox.max.y > DESK_TOP - 9 ? top : legs).push(g);
    }
    for (const g of legs) {
      const c = centreOf(g);
      const a = (Math.PI / 2) * r(0.85, 1) * (rnd() < 0.5 ? 1 : -1);
      if (rnd() < 0.5) turn(g, a, 0, 0, c.x, c.y, c.z);
      else turn(g, 0, 0, a, c.x, c.y, c.z);
      g.translate(c.x * 0.12, 0, c.z * 0.12);
      restOnFloor([g]);
    }
    // tilted about the middle of the top: flat onto the fallen legs (variant 2), or one end on the floor and the
    // other still up on a broken leg
    const a = variant === 2 ? r(-0.04, 0.04) : Math.asin(Math.min(0.5, 22 / t.w)) * (variant === 0 ? 1 : -1);
    const rx = r(-0.05, 0.05);
    for (const g of top) turn(g, rx, 0, a, 0, DESK_TOP - 3, 0);
    restOnFloor(top, variant === 2 ? 5 : 0);
    // where the board's upper face now is, for the screens and laptops that fall onto it
    const board = top.reduce((best, g) => {
      g.computeBoundingBox();
      const s = g.boundingBox.getSize(new THREE.Vector3());
      return !best || s.x * s.z > best.area ? { g, area: s.x * s.z } : best;
    }, null);
    surface = board ? { y: centreOf(board.g).y + 3, slope: Math.tan(a) } : null;
    main = [...top, ...legs];
  } else {
    // shatter: the base stays, a little askew
    const rx = r(-0.08, 0.08);
    const rz = r(-0.08, 0.08);
    for (const g of main) turn(g, rx, 0, rz, 0, 0, 0);
    restOnFloor(main);
  }

  // chips on the floor, more for big things and for porcelain
  const pal = RUBBLE[type] || ['#888888'];
  const chips = [];
  const n = Math.round(Math.min(28, Math.max(8, (t.w * t.h) / 300)) * (mode === 'shatter' ? 1.6 : 1));
  for (let i = 0; i < n; i++) {
    const s = r(2, 6.5);
    const h = r(0.8, 2.2);
    const a = r(0, Math.PI * 2);
    const d = Math.sqrt(rnd());
    chips.push(sbox(s, h, s * r(0.5, 1.2), shade(pal[i % pal.length], r(0.55, 0.95)),
      Math.cos(a) * t.w * 0.62 * d, h / 2, Math.sin(a) * t.h * 0.62 * d, r(-0.25, 0.25), r(0, Math.PI * 2), r(-0.25, 0.25)));
  }
  const geo = bakeAO(merge([...main, ...loose, ...chips]));
  if (surface) geo.userData.surface = surface;
  return geo;
}
// Height of a collapsed desk or table's top under the point (x, z) in world units, or WRECK_DESK_TOP.
function wreckSurfaceAt(rig, x, z) {
  const s = rig && rig.wreck.geometry.userData.surface;
  if (!s) return WRECK_DESK_TOP;
  const rot = rig.group.rotation.y + rig.wreck.rotation.y;
  const dx = x - rig.group.position.x;
  const dz = z - rig.group.position.z;
  const lx = dx * Math.cos(rot) - dz * Math.sin(rot); // along the table's long side
  return Math.max(2, s.y + lx * s.slope);
}

// ------------------------------------------------------- static scenery ----
function deskGeometry(it = false) {
  const DT = DESK_TOP;
  const TOP = it ? '#ffffff' : '#dcbc92';
  const BODY = it ? '#e9edf2' : '#c29d72';
  return [
    ...(it ? [box(12, 5, 14, '#354052', 0, DT + 1.5, -27), cyl(2.2, 2.2, 34, '#7c8da2', 0, DT + 18, -27), cyl(4, 4, 5, '#354052', 0, DT + 30, -27)] : []),
    box(158, 6, it ? 114 : 76, TOP, 0, DT - 3, 0),
    box(6, DT - 6, it ? 108 : 70, BODY, -72, (DT - 6) / 2, 0),
    box(6, DT - 6, it ? 108 : 70, BODY, 72, (DT - 6) / 2, 0),
    box(142, 30, 4, it ? '#e1e6ed' : '#a98156', 0, DT - 24, -32),
    box(38, 44, 64, BODY, 52, 28, 2),
    pill(1.5, 14, '#b4bcc9', 52, 38, 35, 0, 0, Math.PI / 2),
    box(64, 0.8, 24, '#222630', -20, DT + 0.4, 16), // desk pad
    box(34, 2.2, 12, '#333947', -32, DT + 1.5, 16), // keyboard frame
    box(31, 0.8, 9.6, '#1d212b', -32, DT + 2.6, 16), // keycaps
    box(3.5, 1.0, 2.8, '#e67e22', -44, DT + 2.7, 12.5), // accent ESC key
    box(12, 1.0, 2.2, '#55627a', -32, DT + 2.7, 19.5), // spacebar
    ell(3.2, 1.9, 4.8, '#333947', 4, DT + 1.4, 16), // mouse
    box(1.0, 0.7, 2.2, '#61afef', 4, DT + 2.3, 14.5), // mouse wheel
    cyl(4.8, 4.4, 10, '#e4572e', 58, DT + 5, -34, 14), // mug
  ];
}

// Big furniture built from soft shapes. w/h = footprint.
function furnitureFallback(type, w, h) {
  const DT = DESK_TOP;
  if (type === 'table') {
    const legs = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => pill(3.2, DT - 14, '#8a8f99', sx * (w / 2 - 16), (DT - 6) / 2, sz * (h / 2 - 14))));
    return [box(w, 6, h, '#eadfc9', 0, DT - 3, 0), ...legs, cyl(5.5, 5, 9, '#e4572e', -30, DT + 4.5, 8, 14), cyl(4.5, 4.5, 7, '#f3f3f3', 40, DT + 3.5, -12, 14)];
  }
  if (type === 'conference') {
    return [
      box(w - 8, 8, h - 6, '#8a5a36', 0, DT - 4, 0),
      box(w - 24, 2, h - 22, '#9a6a44', 0, DT + 0.5, 0),
      box(26, DT - 8, h - 30, '#5a3a22', -w / 3, (DT - 8) / 2, 0),
      box(26, DT - 8, h - 30, '#5a3a22', w / 3, (DT - 8) / 2, 0),
      // Jabra Conference Speakerphone puck in the center
      cyl(13, 14, 3.5, '#2b3240', 0, DT + 2.5, 0, 16),
      cyl(10, 10, 0.6, '#1e2430', 0, DT + 4.3, 0, 16),
      sph(1.2, '#37e07a', 0, DT + 4.8, 0), // green call/mute LED
      // Meeting notebooks & pens
      box(20, 1.5, 26, '#3a4454', -80, DT + 1.2, -10, 0, 0.1, 0),
      pill(0.7, 12, '#e5c07b', -68, DT + 1.5, -10),
      box(20, 1.5, 26, '#4f5b66', 80, DT + 1.2, 10, 0, -0.15, 0),
      pill(0.7, 12, '#61afef', 68, DT + 1.5, 10),
      cyl(4.6, 4.2, 9, '#ffffff', -150, DT + 5, 20, 14),
      cyl(4.6, 4.2, 9, '#ffffff', 150, DT + 5, -20, 14),
      cyl(4.6, 4.2, 9, '#ffffff', 70, DT + 5, 24, 14),
    ];
  }
  // sofa: a rounded base, a big back, round arms and three puffy seat cushions
  const BASE = '#c97474';
  const CUSH = '#e89a9a';
  const BACK = '#d98585';
  return [
    box(w - 12, 22, h - 10, BASE, 0, 14, 1),
    ell(w / 2 - 8, 25, 13, BACK, 0, 52, -h / 2 + 15, -0.1),
    ...[-1, 1].map((sx) => ell(14, 24, h / 2 - 4, BASE, sx * (w / 2 - 15), 40, 0)),
    ...[-1, 0, 1].map((k) => ell((w - 70) / 6, 9, h / 2 - 20, CUSH, k * ((w - 70) / 3), 33, 9)),
    ...[-1, 0, 1].map((k) => ell((w - 70) / 6 - 3, 17, 8, CUSH, k * ((w - 70) / 3), 52, -h / 2 + 30, -0.28)),
    ...[-1, 1].map((sx) => cyl(3, 3, 8, '#5a4636', sx * (w / 2 - 16), 4, h / 2 - 14, 10)),
    ...[-1, 1].map((sx) => cyl(3, 3, 8, '#5a4636', sx * (w / 2 - 16), 4, -h / 2 + 14, 10)),
  ];
}

function makeCanvasTexture(w, h, draw, repeatX = 1, repeatY = 1) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 4;
  return t;
}

// A texture computed pixel by pixel: alpha(u, v) over a constant colour, u and v in 0..1 at texel centres, v = 0 the
// first row. For soft floor overlays, not canvas gradients: Safari dithers canvas gradients, and where alpha is
// nearly zero the upload's un-premultiply turns that noise into coloured specks across the floor (iPad and iPhone).
function makeAlphaTexture(w, h, rgb, alpha) {
  const data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = (j * w + i) * 4;
      data[k] = rgb[0]; data[k + 1] = rgb[1]; data[k + 2] = rgb[2];
      data[k + 3] = Math.round(255 * Math.min(1, Math.max(0, alpha((i + 0.5) / w, (j + 0.5) / h))));
    }
  }
  return makePixelTexture(w, h, data);
}
function makePixelTexture(w, h, data) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

const FLOOR = {
  carpet: (ctx, w, h) => {
    ctx.fillStyle = '#252d3f';
    ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#2a3348' : '#222a3b';
      ctx.fillRect(x * w / 4 + 2, y * h / 4 + 2, w / 4 - 4, h / 4 - 4);
    }
  },
  tile: (ctx, w, h) => {
    ctx.fillStyle = '#8fa1b5';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#6d7f94';
    ctx.lineWidth = 3;
    for (let i = 0; i <= 2; i++) {
      ctx.strokeRect(0, 0, w, h);
      ctx.beginPath();
      ctx.moveTo(i * w / 2, 0);
      ctx.lineTo(i * w / 2, h);
      ctx.moveTo(0, i * h / 2);
      ctx.lineTo(w, i * h / 2);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,.07)';
    ctx.fillRect(0, 0, w / 2, h / 2);
    ctx.fillRect(w / 2, h / 2, w / 2, h / 2);
  },
  metal: (ctx, w, h) => {
    ctx.fillStyle = '#1a1f29';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#2e3644';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, w - 4, h - 4);
    ctx.strokeStyle = '#242b37';
    ctx.lineWidth = 2;
    for (let i = 1; i < 8; i++) {
      ctx.beginPath();
      ctx.moveTo(8, (h / 8) * i);
      ctx.lineTo(w - 8, (h / 8) * i);
      ctx.stroke();
    }
  },
  wood: (ctx, w, h) => {
    const cols = ['#9b7449', '#a37c50', '#94704a', '#a98456'];
    const n = 8;
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = cols[i % cols.length];
      ctx.fillRect(0, (i * h) / n, w, h / n);
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      ctx.fillRect(0, (i * h) / n, w, 2);
      ctx.fillStyle = 'rgba(0,0,0,.12)';
      ctx.fillRect(((i * 97) % w), (i * h) / n, 2, h / n);
    }
  },
};

function soft(ctx, w, h, stops) {
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

// ------------------------------------------------------------- the scene ----
// Same stack as --font-ui in style.css: Segoe UI on Windows, San Francisco on macOS, both with full Vietnamese coverage.
const UI_FONT = '"Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", Arial, sans-serif';

export function createScene3D(canvas, labelsEl, hooks = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2));
  renderer.shadowMap.enabled = !coarse;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const BG = 0x0d1017;
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 2200, 5200);
  // soft image-based light from a built-in studio room: reflections and gentler shading everywhere
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.35;

  const camera = new THREE.PerspectiveCamera(40, 1, 20, 7000);
  // The starting view scales with the height of the game in CSS pixels.
  // Tuned closer (~380-450 on phone) so anime humanoid proportions, outfits, and 3D details are prominent and clear.
  const ZOOM_STEPS = 5;
  const zoomRange = h => {
    const start = Math.round(Math.min(1000, Math.max(380, 0.48 * (280 + 1.1 * h))));
    const min = Math.round(start * 0.45);
    const max = Math.min(2200, Math.max(1100, Math.round(start * 2.0)));
    return { min, max, start };
  };
  let zoomMin, zoomMax, zoomStart;
  ({ min: zoomMin, max: zoomMax, start: zoomStart } = zoomRange(window.innerHeight || 600));
  const cam = { x: 0, z: 0, dist: zoomStart, pitch: 0.46, ready: false };
  let zoomChosen = false; // until the player zooms, the start view follows window size changes
  try {
    const saved = Number(localStorage.getItem('br-zoom-v3'));
    if (saved > 0) { cam.dist = Math.min(zoomMax, Math.max(zoomMin, saved)); zoomChosen = true; } // the player's own choice
  } catch (e) { /* ignore */ }
  let shadowR = 900;

  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x6a5f58, 0.8));
  // a cool fill from the opposite side (no shadows) so the shaded faces keep some colour
  const fill = new THREE.DirectionalLight(0x8fb4ff, 0.45);
  fill.position.set(900, 700, -600);
  scene.add(fill);
  const sun = new THREE.DirectionalLight(0xffe6c4, 1.9);
  sun.castShadow = !coarse;
  sun.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
  const sc = sun.shadow.camera;
  sc.left = -900; sc.right = 900; sc.top = 900; sc.bottom = -900; sc.near = 100; sc.far = 2600;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 1.5;
  scene.add(sun, sun.target);

  const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false, roughness: 0.62, metalness: 0.08 });
  const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.22, roughness: 0.1, depthWrite: false });
  const pickMat = new THREE.MeshBasicMaterial({ visible: false });
  // floor marks under wrecks: lit like the floor, drawn over it without writing depth
  const markTex = makePixelTexture(512, 128, paintMarks(512, 128));
  const markMat = new THREE.MeshLambertMaterial({
    map: markTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, // mirrored marks show their back
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
  });
  const markGeos = {};
  function markGeometry(kind) {
    if (markGeos[kind]) return markGeos[kind];
    const g = new THREE.PlaneGeometry(1, 1);
    const i = MARK_KINDS.indexOf(kind);
    const uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setX(k, (i + uv.getX(k)) / MARK_KINDS.length);
    return (markGeos[kind] = g);
  }

  const textures = {};
  const staticGroup = new THREE.Group();
  scene.add(staticGroup);
  let built = false;
  let loaded = false;
  let pendingBuild = null;
  let propList = [];
  let world = { w: 3840, h: 2160 };

  // ---- static world -------------------------------------------------------
  let exitMat = null;
  const stallDoors = [];
  function buildNow(w, props, zones, rooms = []) {
    if (built) return;
    built = true;
    world = w;
    const CELL = 900;
    const buckets = new Map();
    const bucket = (x, z) => {
      const key = Math.floor(x / CELL) + ':' + Math.floor(z / CELL);
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { body: [], glow: [], glass: [] }));
      return b;
    };
    const at = (g, x, y, z) => {
      g.translate(x, y, z);
      return g;
    };
    const addAll = (list, x, z, kind = 'body') => {
      const b = bucket(x, z);
      for (const g of list) b[kind].push(at(g, x, 0, z));
    };

    propList = props;
    for (const p of props) {
      if (p.k === 'rug') {
        addAll([
          sbox(p.w, 1.2, p.h, '#6e3a3a', 0, 0.8, 0),
          sbox(p.w - 30, 1.6, p.h - 30, '#7f4646', 0, 1.0, 0),
        ], p.x, p.y);
      } else if (p.k === 'stallDoor') {
        const frame = [
          sbox(7, 180, 10, '#2f384a', -p.w / 2 - 3.5, 90),
          sbox(7, 180, 10, '#2f384a', p.w / 2 + 3.5, 90),
          sbox(p.w + 14, 7, 10, '#2f384a', 0, 180),
        ];
        addAll(frame, p.x, p.y);
        const hinge = new THREE.Group();
        hinge.position.set(p.x - p.w / 2, 0, p.y);
        const leaf = new THREE.Mesh(merge([
          box(p.w - 4, 152, 7, '#758c9a', p.w / 2, 94),
          box(5, 17, 4, '#dce5eb', p.w - 16, 94, 6),
          cyl(3, 3, 3, '#53d49a', p.w - 16, 112, 5, 10, Math.PI / 2),
        ]), bodyMat);
        leaf.castShadow = true;
        leaf.receiveShadow = true;
        hinge.add(leaf);
        staticGroup.add(hinge);
        stallDoors.push({ hinge, x: p.x, y: p.y });
      } else if (p.k === 'wall') {
        const hgt = 210;
        const b = bucket(p.x, p.y);
        b.body.push(at(sbox(p.w + 2, 18, p.h + 2, '#3a4458', 0, 9, 0), p.x, 0, p.y));
        b.body.push(at(sbox(p.w + 2, 10, p.h + 2, '#3a4458', 0, hgt - 5, 0), p.x, 0, p.y));
        if (p.opaque) b.body.push(at(sbox(p.w, hgt - 28, p.h, '#5a6478', 0, 18 + (hgt - 28) / 2, 0), p.x, 0, p.y));
        else b.glass.push(at(sbox(p.w, hgt - 28, p.h, '#9fd4ff', 0, 18 + (hgt - 28) / 2, 0), p.x, 0, p.y));
        // posts
        const long = Math.max(p.w, p.h);
        const horiz = p.w >= p.h;
        for (let i = 0; i <= Math.ceil(long / 240); i++) {
          const o = -long / 2 + Math.min(long, i * 240);
          b.body.push(at(sbox(8, hgt, 8, '#2f384a', horiz ? o : 0, hgt / 2, horiz ? 0 : o), p.x, 0, p.y));
        }
      }
    }

    // plants and objects are separate; here: perimeter and wall decor
    const W = world.w;
    const H = world.h;
    const perim = [];
    perim.push([W / 2, -30, W + 120, 60, 280, '#262e40']);
    perim.push([-30, H / 2, 60, H + 120, 150, '#262e40']);
    perim.push([W + 30, H / 2, 60, H + 120, 150, '#262e40']);
    perim.push([W / 2, H + 20, W + 120, 40, 36, '#262e40']);
    for (const [x, z, w, d, h, c] of perim) {
      const b = bucket(Math.max(0, Math.min(W - 1, x)), Math.max(0, Math.min(H - 1, z)));
      b.body.push(at(sbox(w, h, d, c, 0, h / 2, 0), x, 0, z));
    }
    // exit door in the west wall: frame, green door, sign and a mat in front of it
    if (world.exit) {
      const ex = world.exit;
      const ey = (ex.y0 + ex.y1) / 2;
      const dw = ex.y1 - ex.y0;
      const b = bucket(2, ey);
      b.body.push(at(sbox(8, 120, 8, '#1b2130', 4, 60, 0), 0, 0, ex.y0 - 4));
      b.body.push(at(sbox(8, 120, 8, '#1b2130', 4, 60, 0), 0, 0, ex.y1 + 4));
      b.body.push(at(sbox(8, 10, dw + 16, '#1b2130', 4, 124, 0), 0, 0, ey));
      b.glow.push(at(sbox(2, 112, dw, '#3ddc84', 1, 56, 0), 0, 0, ey));
      const exitSign = makeCanvasTexture(256, 64, (ctx, w, h) => {
        ctx.fillStyle = '#0f3d27';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#3ddc84';
        ctx.lineWidth = 5;
        ctx.strokeRect(3, 3, w - 6, h - 6);
        ctx.fillStyle = '#c9ffe2';
        ctx.font = '800 38px ' + UI_FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('EXIT · LỐI RA', w / 2, h / 2 + 2);
      });
      const exitMesh = new THREE.Mesh(new THREE.PlaneGeometry(200, 50), new THREE.MeshBasicMaterial({ map: exitSign }));
      // The camera looks from the south, so a sign flat on the west wall is seen edge-on. Hang it across the
      // corridor instead, facing south, just north of the door.
      exitMesh.position.set(130, 100, ex.y0 - 14);
      staticGroup.add(exitMesh);
      exitMat = { x0: ex.x0 - 20, y0: ex.y0, x1: ex.x1, y1: ex.y1 };
    }
    // windows and light strips on the north wall
    for (let x = 220; x < W; x += 480) {
      const b = bucket(x, 0);
      b.glow.push(at(sbox(260, 120, 2, '#8cc8ff', 0, 170, 0), x, 0, 1.2));
      b.body.push(at(sbox(272, 6, 4, '#1b2130', 0, 232, 0), x, 0, 2));
      b.body.push(at(sbox(272, 6, 4, '#1b2130', 0, 108, 0), x, 0, 2));
      b.body.push(at(sbox(6, 128, 4, '#1b2130', -130, 170, 0), x, 0, 2));
      b.body.push(at(sbox(6, 128, 4, '#1b2130', 130, 170, 0), x, 0, 2));
    }

    for (const b of buckets.values()) {
      const parts = [
        [bakeAO(merge(b.body)), bodyMat, true],
        [merge(b.glow), glowMat, false],
        [merge(b.glass), glassMat, false],
      ];
      for (const [geo, mat, shadow] of parts) {
        if (!geo) continue;
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = shadow;
        mesh.receiveShadow = true;
        if (mat === glassMat) mesh.renderOrder = 2;
        staticGroup.add(mesh);
      }
    }

    // floors
    const floorPlane = (k, x0, y0, x1, y1, lift) => {
      const w = x1 - x0;
      const d = y1 - y0;
      const ft = FLOOR_TEX[k];
      let mat;
      if (ft) {
        const map = ft.map.clone();
        const normal = ft.normal.clone();
        for (const t of [map, normal]) {
          t.repeat.set(w / ft.size, d / ft.size);
          t.needsUpdate = true;
        }
        mat = new THREE.MeshStandardMaterial({ map, normalMap: normal, normalScale: new THREE.Vector2(0.7, 0.7), color: ft.tint, roughness: k === 'metal' ? 0.55 : 0.85, metalness: k === 'metal' ? 0.5 : 0 });
      } else {
        mat = new THREE.MeshStandardMaterial({ map: makeCanvasTexture(256, 256, FLOOR[k], w / 256, d / 256), roughness: 0.95 });
      }
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x0 + w / 2, lift, y0 + d / 2);
      m.receiveShadow = true;
      staticGroup.add(m);
    };
    floorPlane('carpet', -60, -60, W + 60, H + 60, 0);
    for (const z of zones) floorPlane(z.k, z.x0, z.y0, z.x1, z.y1, 0.4);
    if (exitMat) {
      const m = exitMat;
      const tex = makeCanvasTexture(128, 256, (ctx, w, h) => {
        ctx.fillStyle = 'rgba(61,220,132,.28)';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(61,220,132,.9)';
        ctx.lineWidth = 6;
        ctx.strokeRect(3, 3, w - 6, h - 6);
        ctx.fillStyle = 'rgba(201,255,226,.95)';
        ctx.font = '800 40px ' + UI_FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.rotate(-Math.PI / 2); // reads along the corridor, from the room towards the door
        ctx.fillText('◀ EXIT', 0, 0);
        ctx.restore();
      });
      const mat = new THREE.Mesh(new THREE.PlaneGeometry(m.x1 - m.x0, m.y1 - m.y0), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
      mat.rotation.x = -Math.PI / 2;
      mat.position.set((m.x0 + m.x1) / 2, 0.8, (m.y0 + m.y1) / 2);
      staticGroup.add(mat);
    }

    // sunlight from the north windows falling on the floor, and posters between the windows
    {
      // bright at the window (v = 1), gone at the far end, feathered at the sides (computed: see makeAlphaTexture)
      const pool = makeAlphaTexture(128, 128, [255, 236, 190], (u, v) => 0.5 * v * Math.min(1, u / 0.3, (1 - u) / 0.3));
      const poolMat = new THREE.MeshBasicMaterial({ map: pool, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.4 });
      const posters = [
        ['DEADLINE', 'LÀ HÔM NAY', '#c0392b'],
        ['KPI', '▂▃▅▇ +120%', '#2d7d5a'],
        ['TEAM', 'WORK ♥', '#2f5f9e'],
        ['HỌP', 'LÚC 8:00', '#8a5a1f'],
      ];
      let n = 0;
      for (let x = 220; x < W; x += 480) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(250, 330), poolMat);
        m.rotation.x = -Math.PI / 2;
        m.position.set(x, 0.9, 175);
        m.renderOrder = 1;
        staticGroup.add(m);
        const [t1, t2, col] = posters[n++ % posters.length];
        const tex = makeCanvasTexture(128, 176, (ctx, w, h) => {
          ctx.fillStyle = '#f3efe4';
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = col;
          ctx.fillRect(8, 8, w - 16, 70);
          ctx.fillStyle = '#fff';
          ctx.font = '800 30px ' + UI_FONT;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(t1, w / 2, 44);
          ctx.fillStyle = '#2b3240';
          ctx.font = '700 17px ' + UI_FONT;
          ctx.fillText(t2, w / 2, 112);
          ctx.fillRect(24, 140, w - 48, 4);
          ctx.fillRect(24, 152, w - 70, 4);
        });
        const poster = new THREE.Mesh(new THREE.PlaneGeometry(76, 104), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }));
        poster.position.set(x + 240, 160, 1.5);
        poster.receiveShadow = true;
        staticGroup.add(poster);
      }
    }

    // wall sign and clock
    const sign = makeCanvasTexture(1024, 128, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(14,17,24,.92)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ff5d4a';
      ctx.fillRect(0, 0, 14, h);
      const text = 'BREAK ROOM · XẢ STRESS CÙNG ĐỒNG NGHIỆP';
      // Shrink the font until the whole sentence fits: system fonts differ in width (macOS is wider than Linux)
      // and the end of the sentence used to be cut off.
      let size = 52;
      ctx.font = '800 ' + size + 'px ' + UI_FONT;
      const room = w - 44 - 32;
      const needed = ctx.measureText(text).width;
      if (needed > room) {
        size = Math.max(24, Math.floor(size * (room / needed)));
        ctx.font = '800 ' + size + 'px ' + UI_FONT;
      }
      ctx.fillStyle = '#eef1f6';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 44, h / 2 + 2);
    });
    const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(1000, 125), new THREE.MeshBasicMaterial({ map: sign, transparent: true }));
    signMesh.position.set(world.bannerX || W / 2, 215, 7); // in front of the window frames (they reach z = 4)
    staticGroup.add(signMesh);
    const clock = makeCanvasTexture(128, 128, (ctx, w, h) => {
      ctx.fillStyle = '#e9edf3';
      ctx.beginPath();
      ctx.arc(64, 64, 58, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#151922';
      ctx.lineWidth = 8;
      ctx.stroke();
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(64, 64); ctx.lineTo(64, 28);
      ctx.moveTo(64, 64); ctx.lineTo(90, 76);
      ctx.stroke();
    });
    const clockMesh = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), new THREE.MeshBasicMaterial({ map: clock, transparent: true }));
    clockMesh.position.set(W / 2 + 640, 200, 3);
    staticGroup.add(clockMesh);
    buildFloorLight(rooms, props);
  }

  // ---- uneven light on the floor ------------------------------------------
  // Real offices are not lit evenly. Without extra lights or a post pass (ADR 0003), three flat layers drawn over
  // the floor fake it: darker strips along the foot of every wall, soft contact shadows under furniture, and pools
  // of light under the ceiling panels, tinted per room (warm pantry and lounge, cold server room). Each layer is one
  // merged mesh (one draw call), with fixed heights and render order so they never fight with each other.
  const FLOOR_LAYER = { wallFoot: [1.9, 0], contact: [1.95, 0], pools: [2.4, 2] }; // [height, renderOrder]; wreck marks are 2.0-2.24
  const ROOM_LIGHT = [ // [name prefix, light colour]
    ['PANTRY', [1.0, 0.8, 0.56]], ['LOUNGE', [1.0, 0.8, 0.56]], ['DIRECTOR', [1.0, 0.84, 0.62]],
    ['SERVER', [0.5, 0.72, 1.0]], ['WC', [0.88, 0.95, 1.0]],
    ['MEETING', [1.0, 0.9, 0.76]], ['TOWN HALL', [1.0, 0.9, 0.76]],
  ];
  const OFFICE_LIGHT = [1.0, 0.96, 0.88];
  const POOL_STRENGTH = 0.06;
  // a flat quad on the floor, rotated by `rot` about its centre, with the given uvs (u0..u1, v0..v1) and colour
  function floorQuad(list, cx, cz, w, d, rot, y, uv = [0, 1, 0, 1], col = null) {
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    g.rotateY(rot);
    g.translate(cx, y, cz);
    const a = g.attributes.uv;
    for (let k = 0; k < a.count; k++) a.setXY(k, uv[0] + a.getX(k) * (uv[1] - uv[0]), uv[2] + a.getY(k) * (uv[3] - uv[2]));
    if (col) {
      const c = new Float32Array(a.count * 3);
      for (let k = 0; k < a.count; k++) c.set(col, k * 3);
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    list.push(g);
  }
  function floorLayer(list, mat, [y, order]) {
    if (!list.length) return null;
    const mesh = new THREE.Mesh(mergeGeometries(list, false), mat);
    mesh.renderOrder = order;
    mesh.frustumCulled = false; // spans the whole office
    staticGroup.add(mesh);
    return mesh;
  }
  // one soft dark blob (a blurred rounded box) for contact shadows
  const contactTex = makeAlphaTexture(128, 128, [0, 0, 0], (u, v) => {
    // a rounded box filling the middle 56%, its edge blurred over about a sixth of the texture
    const qx = Math.abs(u - 0.5) - 0.28 + 0.14, qy = Math.abs(v - 0.5) - 0.28 + 0.14;
    const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 0.14;
    const t = Math.min(1, Math.max(0, (sd + 0.09) / 0.18));
    return 1 - t * t * (3 - 2 * t);
  });
  const contactMat = new THREE.MeshBasicMaterial({ map: contactTex, transparent: true, opacity: 0.5, depthWrite: false });

  function buildFloorLight(rooms, props) {
    const W = world.w;
    const H = world.h;
    // the foot of the walls: dark at the wall, gone 50 units out
    const footTex = makeAlphaTexture(4, 64, [0, 0, 0], (u, v) => 1 - v);
    const foot = [];
    const FOOT = 50;
    // a strip along a wall: its dark edge (v = 1, the quad's -z side before turning) touches the wall
    const strip = (cx, cz, len, rot) => floorQuad(foot, cx, cz, len, FOOT, rot, FLOOR_LAYER.wallFoot[0]);
    for (const p of props) {
      if (p.k !== 'wall') continue;
      if (p.w >= p.h) {
        strip(p.x, p.y + p.h / 2 + FOOT / 2, p.w, 0); // south side
        strip(p.x, p.y - p.h / 2 - FOOT / 2, p.w, Math.PI); // north side
      } else {
        strip(p.x + p.w / 2 + FOOT / 2, p.y, p.h, Math.PI / 2); // east side
        strip(p.x - p.w / 2 - FOOT / 2, p.y, p.h, -Math.PI / 2); // west side
      }
    }
    strip(W / 2, FOOT / 2, W, 0); // the outer walls, from inside
    strip(W / 2, H - FOOT / 2, W, Math.PI);
    strip(FOOT / 2, H / 2, H, Math.PI / 2);
    strip(W - FOOT / 2, H / 2, H, -Math.PI / 2);
    floorLayer(foot, new THREE.MeshBasicMaterial({ map: footTex, transparent: true, opacity: 0.32, depthWrite: false }), FLOOR_LAYER.wallFoot);

    // pools of light under the ceiling panels, on a grid per room; the corridors get dimmer ones
    const poolTex = makeAlphaTexture(128, 128, [255, 255, 255], (u, v) => {
      const r = Math.hypot(u - 0.5, v - 0.5) * 2; // 0 at the centre, 1 at the edge
      return r < 0.45 ? 1 - r : r < 1 ? 0.55 * (1 - (r - 0.45) / 0.55) : 0;
    });
    const pools = [];
    const SPACING = 440;
    const SIZE = 480;
    const pool = (x, z, rgb, k) => floorQuad(pools, x, z, SIZE, SIZE, 0, FLOOR_LAYER.pools[0], undefined, rgb.map((c) => c * k));
    const inRoom = (x, z) => rooms.find((r) => x > r.x0 && x < r.x1 && z > r.y0 && z < r.y1);
    for (const r of rooms) {
      const rgb = (ROOM_LIGHT.find(([pre]) => r.name.startsWith(pre)) || [0, OFFICE_LIGHT])[1];
      const nx = Math.max(1, Math.round((r.x1 - r.x0) / SPACING));
      const nz = Math.max(1, Math.round((r.y1 - r.y0) / SPACING));
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          pool(r.x0 + ((i + 0.5) * (r.x1 - r.x0)) / nx, r.y0 + ((j + 0.5) * (r.y1 - r.y0)) / nz, rgb, POOL_STRENGTH);
        }
      }
    }
    for (let x = SPACING / 2; x < W; x += SPACING) {
      for (let z = SPACING / 2; z < H; z += SPACING) {
        if (!inRoom(x, z)) pool(x, z, OFFICE_LIGHT, POOL_STRENGTH * 0.7);
      }
    }
    floorLayer(pools, new THREE.MeshBasicMaterial({
      map: poolTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }), FLOOR_LAYER.pools);
  }

  // Contact shadows need the objects, which arrive after the static world: built once, the first time they are here.
  let contactBuilt = false;
  function buildContactShadows(objects, types) {
    contactBuilt = true;
    const list = [];
    for (const o of objects) {
      if (lift(o.type)) continue; // screens and laptops stand on desks
      const t = types[o.type];
      if (!t) continue;
      const round = o.type === 'chair' || o.type === 'plant' || o.type === 'trash' || o.type === 'lamp' || o.type === 'coatrack';
      const w = round ? Math.max(t.w, t.h) : t.w;
      const d = round ? w : t.h;
      // the texture's box fills the middle 56%, so the blob is drawn a little larger than the footprint
      floorQuad(list, o.x, o.y, w * 1.45, d * 1.45, o.rot || 0, FLOOR_LAYER.contact[0]);
    }
    floorLayer(list, contactMat, FLOOR_LAYER.contact);
  }

  const ready = loadFloorTextures()
    .then(() => {
      loaded = true;
      if (pendingBuild) {
        const a = pendingBuild;
        pendingBuild = null;
        buildNow(...a);
      }
    });
  function build(w, props, zones, rooms) {
    if (!loaded) pendingBuild = [w, props, zones, rooms];
    else buildNow(w, props, zones, rooms);
  }

  // ---- VKL -----------------------------------------------------------
  // One big character drawn with the same rig as the players (a cloned model with its own skin and a crown), plus
  // the red circle that shows where the next punch will land.
  let bossRig = null;
  let windMesh = null;
  function updateBoss(dt, S) {
    const b = S.boss;
    if (!b || !b.pl) {
      if (bossRig) bossRig.g.visible = false;
      if (windMesh) windMesh.visible = false;
      return;
    }
    if (!bossRig) {
      bossRig = makePlayer(b.pl);
      bossRig.g.scale.setScalar(BOSS_SCALE);
      bossRig.hammer.visible = false; // fists, not a hammer
      bossRig.hpb.classList.add('boss');
    }
    if (b.dead) {
      if (!bossRig.deadAt) bossRig.deadAt = performance.now();
    } else {
      bossRig.deadAt = 0;
    }
    const corpseLinger = b.dead && (performance.now() - bossRig.deadAt < 15000);
    bossRig.g.visible = !b.dead || corpseLinger;
    bossRig.label.classList.toggle('gone', !!b.dead);
    if (!b.dead) updatePlayer(bossRig, b.pl, dt, false, S);
    else if (corpseLinger) updatePlayer(bossRig, { ...b.pl, dead: true, hpFrac: 0, moving: false }, dt, false, S);
    if (!b.dead && b.cast && performance.now() < b.cast.until) {
      const pulse = Math.sin(time * 12) * 0.12;
      bossRig.armL.rotation.x = -2.4 + pulse;
      bossRig.armR.rotation.x = -2.4 - pulse;
      bossRig.foreL.rotation.x = bossRig.foreR.rotation.x = -0.5;
      bossRig.root.rotation.x = -0.12;
    }
    updateElectricTarget(bossRig, bossRig.torsoM, bossRig.torsoM.geometry, b.electricUntil);
    // the punch circle: an outline plus a disc that fills up until the fist lands
    // A wind-up the server cancelled (patrol over, duel) sends no strike: drop the circle once its time is up.
    if (b.wind && performance.now() - b.wind.t0 > b.wind.ms + 400) b.wind = null;
    const w = b.wind;
    if (!w || b.dead) {
      if (windMesh) windMesh.visible = false;
      return;
    }
    if (!windMesh) {
      windMesh = new THREE.Group();
      const outline = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 56), new THREE.MeshBasicMaterial({ color: 0xff3b2a, transparent: true, opacity: 0.9, depthWrite: false }));
      const base = new THREE.Mesh(new THREE.CircleGeometry(1, 56), new THREE.MeshBasicMaterial({ color: 0xff3b2a, transparent: true, opacity: 0.16, depthWrite: false }));
      const fill = new THREE.Mesh(new THREE.CircleGeometry(1, 56), new THREE.MeshBasicMaterial({ color: 0xff3b2a, transparent: true, opacity: 0.4, depthWrite: false }));
      for (const m of [base, fill, outline]) {
        m.rotation.x = -Math.PI / 2;
        windMesh.add(m);
      }
      windMesh.userData.fill = fill;
      windMesh.userData.base = base;
      windMesh.position.y = 1.6;
      scene.add(windMesh);
    }
    const t = Math.max(0, Math.min(1, (performance.now() - w.t0) / w.ms));
    for (const mesh of windMesh.children) mesh.material.color.setHex(w.skill === 'newProcess' ? 0xa86dff : 0xff3b2a);
    windMesh.visible = true;
    windMesh.position.x = w.x;
    windMesh.position.z = w.y;
    windMesh.scale.setScalar(w.r);
    windMesh.userData.fill.scale.setScalar(Math.max(0.02, t));
    windMesh.userData.fill.material.opacity = 0.3 + 0.35 * t;
  }

  const miniRigs = new Map();
  // Prof. K (S.profk) uses the same rig, walk and punch as the minis; he has no HP, so his bar stays hidden.
  const PROFK_SCALE = [1.75, 1.65, 1.65]; // between DMM (1.65, 1.3, 1.5) and VKL (2.1)
  function updateMinis(dt, S) {
    for (const [id, b] of S.profk ? [...S.minis, ['PROFK', S.profk]] : S.minis) {
      let rig = miniRigs.get(id);
      if (!rig) {
        rig = makePlayer(b.pl);
        // TML keeps a compact silhouette; DMM is broad despite its lower HP.
        if (id === 'PROFK') rig.g.scale.set(...PROFK_SCALE);
        else rig.g.scale.set(id === 'TML' ? 1.15 : 1.65, 1.3, id === 'TML' ? 1.15 : 1.5);
        rig.hpb.classList.add('boss');
        const wind = new THREE.Group();
        const mat = new THREE.MeshBasicMaterial({ color: id === 'TML' ? 0xffa13d : id === 'PROFK' ? 0x2fd08e : 0xc87dff, transparent: true, opacity: 0.65, depthWrite: false });
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 48), mat);
        const fill = new THREE.Mesh(new THREE.CircleGeometry(1, 48), mat.clone());
        ring.rotation.x = fill.rotation.x = -Math.PI / 2;
        fill.material.opacity = 0.22; wind.add(ring, fill); wind.position.y = 2; scene.add(wind);
        rig.miniWind = wind; rig.miniFill = fill;
        miniRigs.set(id, rig);
      }
      rig.g.visible = b.hp > 0;
      if (b.hp > 0) {
        updatePlayer(rig, b.pl, dt, false, S);
        updateElectricTarget(rig, rig.torsoM, rig.torsoM.geometry, b.pl.electricUntil);
        // Walking, standing and the punch come from the same rig code as players and VKL (updatePlayer above). The
        // mini-boss pose only takes over for the wind-up and the slam, which that code has no telegraph for.
        if (b.wind || (b.pl.swing || 0) > 0 || (rig.miniWindPose || 0) > 0.01) animateMini(rig, b, dt);
      }
      if (b.wind && performance.now() - b.wind.t0 > b.wind.ms + 400) b.wind = null; // cancelled wind-up: no strike follows
      rig.miniWind.visible = !!b.wind && b.hp > 0;
      if (b.wind) {
        rig.miniWind.position.set(b.wind.x, 2, b.wind.y); rig.miniWind.scale.setScalar(b.wind.r);
        rig.miniFill.scale.setScalar(Math.max(0.02, Math.min(1, (performance.now() - b.wind.t0) / b.wind.ms)));
      }
    }
    for (const [id, rig] of miniRigs) if (id === 'PROFK' ? !S.profk : !S.minis.has(id)) {
      disposePlayer(rig);
      scene.remove(rig.miniWind);
      for (const m of rig.miniWind.children) { m.geometry.dispose(); m.material.dispose(); }
      miniRigs.delete(id);
    }
  }

  // Independent two-legged boss motion. Keep VKL's one-legged rig and players untouched.
  function animateMini(rig, b, dt) {
    const compact = b.pl.mini === 'TML';
    const smooth = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
    const now = performance.now();
    // Drive strides from actual interpolated travel, so wandering has a slower cadence
    // and a blocked boss does not run on the spot. Ignore respawn teleports.
    const distance = rig.miniX == null ? 0 : Math.hypot(b.x - rig.miniX, b.y - rig.miniY);
    rig.miniX = b.x; rig.miniY = b.y;
    const speed = dt > 0 && distance < 100 ? distance / dt : 0;
    const ease = 1 - Math.exp(-10 * dt);
    // A stroll is a full walk cycle at a natural cadence (6.5 to 11 rad/s, the range players use), not a faint wobble that
    // slows down with the speed: legs and arms must visibly move whenever the body does.
    rig.miniMove = (rig.miniMove || 0) + (Math.min(1, speed / 60) - (rig.miniMove || 0)) * ease;
    const cadence = Math.min(11, Math.max(6.5, speed / (compact ? 30 : 37)));
    rig.miniWalk = (rig.miniWalk || 0) + (speed > 6 ? cadence * dt : 0);
    const mv = rig.miniMove, phase = rig.miniWalk;
    const step = Math.sin(phase), breath = Math.sin(rig.t * 2.1);
    const guard = b.mode === 'chase' || b.mode === 'windup' || b.mode === 'recover';
    rig.miniGuard = (rig.miniGuard || 0) + ((guard ? 1 : 0) - (rig.miniGuard || 0)) * ease;
    const ready = rig.miniGuard;
    const windTarget = b.wind ? smooth((now - b.wind.t0) / b.wind.ms) : 0;
    rig.miniWindPose = (rig.miniWindPose || 0) + (windTarget - (rig.miniWindPose || 0)) * (1 - Math.exp(-22 * dt));
    const wind = rig.miniWindPose;
    // miniStrike starts swing at the actual server impact. Start at contact rather
    // than replaying another windup after the warning circle has disappeared.
    const strike = Math.max(0, Math.min(1, b.pl.swing || 0));
    const impact = smooth(Math.min(1, strike / 0.8));
    const follow = Math.sin((1 - strike) * Math.PI) * (strike > 0 ? 1 : 0);
    const roll = step * mv;
    rig.root.position.set(roll * (compact ? 1.8 : 3), Math.abs(step) * 3 * mv - wind * 3 - follow * 3, 0);
    rig.root.rotation.set(0.07 * mv - wind * 0.13 + impact * 0.24, wind * 0.23 - impact * 0.28,
      roll * (compact ? 0.035 : 0.065));
    const sy = 1 + breath * 0.012 * (1 - mv) - wind * 0.025;
    rig.root.scale.set(1 / Math.sqrt(sy), sy, 1 / Math.sqrt(sy));
    rig.legL.rotation.set(step * 0.55 * mv - wind * 0.1, 0, 0.035);
    rig.legR.rotation.set(-step * 0.55 * mv + wind * 0.1, 0, -0.035);
    rig.legL.position.y = 38 + Math.max(0, -step) * 4 * mv;
    rig.legR.position.y = 38 + Math.max(0, step) * 4 * mv;
    rig.torsoM.rotation.y = roll * 0.1 + wind * 0.18 - impact * 0.22;
    rig.headM.rotation.set(-0.03 + breath * 0.015 - wind * 0.06, -roll * 0.08 - wind * 0.1, roll * 0.025);
    // Bent elbows, balanced free hand, and a full-body punch / heavy double slam.
    rig.armR.rotation.set(-0.2 + breath * 0.025 - ready * 0.35 + roll * 0.55 * (1 - ready * 0.5) - wind * 1.65 - impact * 1.0,
      -wind * 0.22, -0.16 - wind * 0.2);
    rig.foreR.rotation.x = -0.35 - ready * 0.65 - wind * 0.5 + impact * 0.9;
    rig.armL.rotation.set(-0.18 - breath * 0.025 - ready * 0.4 - roll * 0.55 * (1 - ready * 0.5) - wind * (compact ? 0.25 : 1.55) - impact * (compact ? 0.25 : 1.0),
      wind * 0.12, 0.16 + wind * 0.18);
    rig.foreL.rotation.x = -0.3 - ready * 0.7 - wind * 0.4 + impact * (compact ? 0.1 : 0.85);
  }

  // Local visual feedback only: no stun or extra damage. Reuse each target's buffers.
  function updateElectricTarget(rig, parent, geometry, until) {
    const remaining = Math.max(0, ((until || 0) - performance.now()) / 1000);
    if (!remaining) {
      if (rig.electricFx) rig.electricFx.group.visible = false;
      return 0;
    }
    if (!rig.electricFx) {
      geometry.computeBoundingBox();
      const bounds = geometry.boundingBox;
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const group = new THREE.Group();
      const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 35),
        new THREE.LineBasicMaterial({ color: 0x78ecff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      const positions = new Float32Array(3 * 12 * 6);
      const arcGeo = new THREE.BufferGeometry();
      arcGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const arcs = new THREE.LineSegments(arcGeo,
        new THREE.LineBasicMaterial({ color: 0xb18aff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      arcs.frustumCulled = false;
      group.add(outline, arcs);
      parent.add(group);
      rig.electricFx = { group, outline, arcs, positions, center, size };
    }
    const fx = rig.electricFx;
    fx.group.visible = true;
    fx.outline.material.opacity = Math.min(1, Math.max(0, remaining - 0.2) / 0.1);
    fx.arcs.material.opacity = Math.min(1, remaining / 0.2);
    let offset = 0;
    for (let ring = 0; ring < 3; ring++) {
      const height = fx.center.y + (ring - 1) * fx.size.y * 0.28;
      let px, py, pz;
      for (let i = 0; i <= 12; i++) {
        const angle = i / 12 * Math.PI * 2 + time * (ring % 2 ? -8 : 8);
        const x = fx.center.x + Math.cos(angle) * (fx.size.x / 2 + 4 + Math.random() * 5);
        const y = height + (Math.random() - 0.5) * 12;
        const z = fx.center.z + Math.sin(angle) * (fx.size.z / 2 + 4 + Math.random() * 5);
        if (i) {
          fx.positions.set([px, py, pz, x, y, z], offset);
          offset += 6;
        }
        px = x; py = y; pz = z;
      }
    }
    fx.arcs.geometry.attributes.position.needsUpdate = true;
    return Math.min(1, remaining / 0.3);
  }

  // ---- objects ------------------------------------------------------------
  const models = {};
  const rigs = new Map(); // object id -> rig
  const proxies = [];

  // A chair turns to face the nearest desk or table (the model's front is +z).
  const CHAIR_FRONT = 0;
  function faceNearestFurniture(group, o, types, all) {
    let best = null;
    let bd = Infinity;
    // desks and tables are objects (so they can be smashed), not props
    const rects = [];
    for (const d of all) {
      const t = types && types[d.type];
      if (t && (d.type === 'desk' || d.type === 'table' || d.type === 'conference')) rects.push({ x: d.x, y: d.y, w: t.w, h: t.h });
    }
    for (const p of rects) {
      const nx = Math.max(p.x - p.w / 2, Math.min(p.x + p.w / 2, o.x));
      const ny = Math.max(p.y - p.h / 2, Math.min(p.y + p.h / 2, o.y));
      const d = Math.hypot(nx - o.x, ny - o.y);
      if (d < bd) {
        bd = d;
        best = [nx, ny];
      }
    }
    if (best && bd < 160) group.rotation.y = Math.atan2(best[0] - o.x, best[1] - o.y) + CHAIR_FRONT;
    else if (o.rot) group.rotation.y = o.rot + CHAIR_FRONT;
  }

  // A soft additive halo over lit screens: a cheap "bloom" made of sprites, so there is no post-processing chain to
  // flicker. One shared material; it is hidden when the screen is smashed.
  const HALO = { monitor: [24, 80, 0.45], laptop: [22, 80, 0.4], tv: [40, 170, 0.5] }; // [height of the screen centre, size, opacity]
  let haloMat = null;
  function makeHalo(type) {
    const h = HALO[type];
    if (!h) return null;
    if (!haloMat) {
      const tex = makeCanvasTexture(128, 128, (ctx, w, hh) => soft(ctx, w, hh, [[0, 'rgba(120,190,255,1)'], [0.35, 'rgba(90,160,255,.45)'], [1, 'rgba(60,120,255,0)']]));
      haloMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, opacity: 1 });
    }
    const sp = new THREE.Sprite(haloMat.clone());
    sp.material.opacity = h[2];
    sp.scale.set(h[1], h[1] * 0.7, 1);
    sp.position.set(0, h[0], 8);
    sp.raycast = () => {}; // never picked: it must not block clicks on the object
    return sp;
  }

  function objectRig(o, types, all) {
    let rig = rigs.get(o.id);
    if (rig) return rig;
    // Meeting-room screens face the end of a conference table on the same axis.
    const largeScreen = o.screenScale || (o.type === 'tv' && all.some(d =>
      d.type === 'conference' && Math.abs(d.y - o.y) < 1 && Math.abs(d.x - o.x) < 650) ? 2 : 0);
    const desk = o.arm && all.find(d => d.itDesk && Math.abs(d.x - o.x) <= 30 && Math.abs(d.y - o.y) <= 5);
    const armSide = desk ? Math.sign((o.x - desk.x) * Math.cos(o.rot || 0)) : 1;
    const modelKey = largeScreen ? 'tv-' + largeScreen : o.arm ? 'armMonitor-' + armSide : o.itDesk ? 'itDesk' : o.type;
    if (!models[modelKey]) models[modelKey] = buildModel(o.type, types, largeScreen, o.arm, o.itDesk, armSide);
    const mod = models[modelKey];
    const group = new THREE.Group();
    group.position.set(o.x, lift(o.type), o.y);
    // Untouched objects share bodyMat, so the renderer does not re-upload a full set of uniforms for each of the
    // hundreds of draws (expensive in Safari, where every WebGL call crosses to another process). An object gets its
    // own copy (created once, kept) only while it is damaged, flashing or electrified; see update.
    const mat = null;
    const body = new THREE.Mesh(mod.body, bodyMat);
    // On touch screens the small, numerous things (393 screens, laptops and bins) cast no real-time shadow: each one
    // is a draw in the shadow pass, which Safari on iPad/iPhone pays for. Bins keep their contact blob on the floor.
    body.castShadow = !(coarse && NO_SHADOW_ON_TOUCH.has(o.type));
    body.receiveShadow = true;
    group.add(body);
    let glow = null;
    if (mod.glow) {
      glow = new THREE.Mesh(mod.glow, glowMat);
      group.add(glow);
    }
    const wreck = new THREE.Mesh(mod.wrecks[wreckVariant(o.id)], bodyMat);
    wreck.rotation.y = idNoise(o.id, 7) * (types[o.type].w > 100 ? 0.2 : 0.8);
    wreck.receiveShadow = true;
    wreck.castShadow = false; // flat rubble on the floor does not need real-time shadow draws
    wreck.visible = false;
    group.add(wreck);
    // a scorch, puddle, soil or dust mark on the floor under the wreck
    let mark = null;
    if (!lift(o.type)) {
      const t = types[o.type];
      mark = new THREE.Mesh(markGeometry(MARK_KIND[o.type] || (ELECTRONIC.has(o.type) ? 'scorch' : 'dust')), markMat);
      mark.rotation.set(-Math.PI / 2, 0, idNoise(o.id, 3) * 0.8);
      mark.scale.set(t.w * 1.3 * (o.id % 2 ? 1 : -1), t.h * 1.3, 1);
      mark.position.y = 2 + (o.id % 5) * 0.06; // overlapping marks never share a height
      mark.renderOrder = 1;
      mark.visible = false;
      group.add(mark);
    }
    // a screen or laptop knows the desk or table it stands on, and drops when that collapses
    let support = -1;
    if (lift(o.type)) {
      const s = all.find((d) => (d.type === 'desk' || d.type === 'table' || d.type === 'conference') && standsOn(o, d, types));
      if (s) support = s.id;
    }
    const pk = mod.pick || PICK[o.type] || [40, 40, 40];
    if (!largeScreen) PICK[o.type] = pk;
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(pk[0], pk[1], pk[2]), pickMat);
    proxy.position.y = pk[1] / 2;
    proxy.userData.objId = o.id;
    group.add(proxy);
    proxies.push(proxy);
    if (o.type === 'chair') faceNearestFurniture(group, o, types, all);
    else if (o.rot) group.rotation.y = o.rot;
    const halo = makeHalo(o.type);
    if (halo) {
      if (largeScreen) {
        halo.position.y += 22.4;
        halo.scale.multiplyScalar(1.8);
      }
      group.add(halo);
    }
    scene.add(group);
    rig = { group, body, glow, halo, wreck, mark, support, y: lift(o.type), vy: 0, mat, proxy, o, barLift: largeScreen ? 158 : null, popPrev: 0, shown: null, modelKey, slot: null, batched: false };
    rigs.set(o.id, rig);
    return rig;
  }

  // Untouched furniture is drawn in batches: one InstancedMesh per model and per 600-unit cell of the office holds
  // every idle copy (body, lit screen and screen halo), so a view of 170 desks, chairs and screens costs a few dozen
  // draws instead of three per object, in both the picture and the shadow pass (each draw is a cross-process call in
  // Safari). An object leaves its batch and draws its own meshes while it is hit, flashing, shaking, electrified,
  // falling, popping or broken, and returns when it is whole and still again. The cells keep frustum culling useful.
  // Measured on an iPad (M4) in the lobby: high mode 51 → 60 FPS (333 → 157 draws, 222 → 86 shadow draws, script time
  // 10.5 → 6.2 ms a frame). Bigger cells mean fewer draws but more off-screen copies drawn: 900 tripled the triangles
  // of a phone view in safe mode, 300 cost more script time than it saved.
  const BATCH_CELL = 600;
  const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
  const batchM = new THREE.Matrix4();
  const batches = [];
  let batchesBuilt = false;
  const haloBatchMats = {};
  // A halo batch faces the view like a sprite: each copy is a quad grown around its centre in view space.
  function haloBatchMat(opacity) {
    if (haloBatchMats[opacity]) return haloBatchMats[opacity];
    const m = new THREE.MeshBasicMaterial({ map: haloMat.map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, opacity });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        mvPosition.xy += position.xy * vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
        gl_Position = projectionMatrix * mvPosition;`);
    };
    m.customProgramCacheKey = () => 'haloBatch';
    return (haloBatchMats[opacity] = m);
  }
  function buildBatches() {
    batchesBuilt = true;
    const groups = new Map();
    for (const rig of rigs.values()) {
      const key = rig.modelKey + ':' + Math.floor(rig.o.x / BATCH_CELL) + ':' + Math.floor(rig.o.y / BATCH_CELL);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(rig);
    }
    const haloGeo = new THREE.PlaneGeometry(1, 1);
    for (const list of groups.values()) {
      const first = list[0], mod = models[first.modelKey], n = list.length;
      const layer = (geo, mat, shadow) => {
        const m = new THREE.InstancedMesh(geo, mat, n);
        m.castShadow = !!shadow;
        m.receiveShadow = shadow !== null;
        m.raycast = () => {}; // picking uses each object's proxy box
        scene.add(m);
        return m;
      };
      const batch = {
        body: layer(mod.body, bodyMat, first.body.castShadow),
        glow: first.glow ? layer(mod.glow, glowMat, false) : null,
        halo: first.halo ? layer(haloGeo, haloBatchMat(first.halo.material.opacity), null) : null,
      };
      if (batch.halo) batch.halo.renderOrder = first.halo.renderOrder;
      list.forEach((rig, i) => {
        rig.slot = { batch, i };
        rig.group.updateMatrix();
        batch.body.setMatrixAt(i, rig.group.matrix);
        if (batch.glow) batch.glow.setMatrixAt(i, rig.group.matrix);
        if (batch.halo) { rig.halo.updateMatrix(); batch.halo.setMatrixAt(i, batchM.multiplyMatrices(rig.group.matrix, rig.halo.matrix)); }
      });
      // bounds of every copy in place; hiding a copy later never needs them to grow
      for (const m of [batch.body, batch.glow, batch.halo]) if (m) { m.computeBoundingBox(); m.computeBoundingSphere(); }
      for (const rig of list) setBatched(rig, false);
      batches.push(batch);
    }
  }
  function setBatched(rig, on) {
    const { batch, i } = rig.slot;
    rig.batched = on;
    // A batched object also leaves the scene graph, so three.js does not walk and re-multiply the matrices of
    // ~1000 idle groups (five meshes each) every frame. Its pick box keeps the world matrix it had when it left.
    if (on) {
      rig.group.updateMatrixWorld(true);
      scene.remove(rig.group);
      batch.body.setMatrixAt(i, rig.group.matrix);
      if (batch.glow) batch.glow.setMatrixAt(i, rig.group.matrix);
      if (batch.halo) batch.halo.setMatrixAt(i, batchM.multiplyMatrices(rig.group.matrix, rig.halo.matrix));
    } else {
      if (!rig.group.parent) scene.add(rig.group);
      batch.body.setMatrixAt(i, HIDDEN);
      if (batch.glow) batch.glow.setMatrixAt(i, HIDDEN);
      if (batch.halo) batch.halo.setMatrixAt(i, HIDDEN);
    }
    for (const m of [batch.body, batch.glow, batch.halo]) if (m) m.instanceMatrix.needsUpdate = true;
  }

  const snakeRigs = new Map();
  const snakeGeometries = new Map();
  const snakeProxyGeo = new THREE.BoxGeometry(38, 30, 138);
  const snakeBarGeo = new THREE.BoxGeometry(28, 3, 2);
  const snakeBarMat = new THREE.MeshBasicMaterial({ color: 0x8af28a });
  const snakeBarBackMat = new THREE.MeshBasicMaterial({ color: 0x294834 });
  function makeSnake(s) {
    const red = s.variant === 'red';
    let snakeGeometry = snakeGeometries.get(red);
    if (!snakeGeometry) {
      // One tapered S-shaped body: no stacked round segments that read as a caterpillar.
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 13, 4), new THREE.Vector3(7, 9, -15),
        new THREE.Vector3(-9, 8, -39), new THREE.Vector3(9, 6, -65), new THREE.Vector3(0, 3, -92),
      ]);
      const positions = [], colors = [], indices = [], radial = 10, rings = 36;
      const skin = new THREE.Color(red ? '#d13d45' : '#3da85c'), belly = new THREE.Color(red ? '#ffbb9e' : '#c9e995');
      for (let i = 0; i <= rings; i++) {
        const t = i / rings, c = curve.getPoint(t), tangent = curve.getTangent(t);
        const side = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize();
        const radius = 8.2 * Math.pow(1 - t, 0.65) + 0.35;
        for (let j = 0; j <= radial; j++) {
          const angle = j / radial * Math.PI * 2, lateral = Math.cos(angle) * radius;
          positions.push(c.x + side.x * lateral, c.y + Math.sin(angle) * radius * 0.72, c.z + side.z * lateral);
          const col = Math.sin(angle) < -0.2 ? belly : skin;
          colors.push(col.r, col.g, col.b);
          if (i < rings && j < radial) {
            const a = i * (radial + 1) + j, b = a + radial + 1;
            indices.push(a, a + 1, b, a + 1, b + 1, b);
          }
        }
      }
      const body = new THREE.BufferGeometry();
      body.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      body.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      body.setIndex(indices); body.computeVertexNormals();
      snakeGeometry = merge([
        body,
        ell(11, 6, 15, red ? '#ed5158' : '#50bc69', 0, 14, 14),
        ell(9, 2, 12, red ? '#ffd0b0' : '#d0eaa0', 0, 10, 17),
        // Small sideways eyes, narrow pupils, a low muzzle and a forked tongue.
        ell(2.8, 2.8, 3.2, '#ffd65c', -8, 18, 17), ell(2.8, 2.8, 3.2, '#ffd65c', 8, 18, 17),
        ell(0.8, 2.4, 1.2, '#142b22', -9, 18, 19), ell(0.8, 2.4, 1.2, '#142b22', 9, 18, 19),
        box(11, 0.8, 1, '#254a31', 0, 12, 28),
        box(1.4, 1, 10, '#eb586a', 0, 11, 32),
        box(1, 1, 6, '#eb586a', -1.7, 11, 38, 0, -0.5), box(1, 1, 6, '#eb586a', 1.7, 11, 38, 0, 0.5),
      ]);
      snakeGeometry.userData.rest = snakeGeometry.attributes.position.array.slice();
      snakeGeometries.set(red, snakeGeometry);
    }
    const group = new THREE.Group(), body = new THREE.Mesh(snakeGeometry, bodyMat);
    body.castShadow = true; body.receiveShadow = true; group.add(body);
    const proxy = new THREE.Mesh(snakeProxyGeo, pickMat);
    proxy.position.set(0, 15, -26); proxy.userData.snakeId = s.id; group.add(proxy);
    const back = new THREE.Mesh(snakeBarGeo, snakeBarBackMat), fill = new THREE.Mesh(snakeBarGeo, snakeBarMat);
    back.position.set(0, 38, 0); fill.position.set(0, 38, 1.5); group.add(back, fill);
    scene.add(group);
    return { group, body, proxy, fill, geometry: snakeGeometry };
  }
  function updateSnakes(dt, S) {
    for (const snakeGeometry of snakeGeometries.values()) {
      const position = snakeGeometry.attributes.position, rest = snakeGeometry.userData.rest;
      for (let i = 0; i < position.count; i++) {
        const z = rest[i * 3 + 2], weight = Math.max(0, -z / 92);
        position.array[i * 3] = rest[i * 3] + Math.sin(time * 8 + z * 0.09) * 4 * weight;
      }
      position.needsUpdate = true;
    }
    for (const [id, s] of S.snakes) {
      let rig = snakeRigs.get(id);
      if (!rig) { rig = makeSnake(s); snakeRigs.set(id, rig); }
      const k = Math.min(1, dt * 14);
      s.x += (s.tx - s.x) * k; s.y += (s.ty - s.y) * k;
      rig.group.position.set(s.x, 0, s.y);
      const diff = Math.atan2(Math.sin((s.d || 0) - rig.group.rotation.y), Math.cos((s.d || 0) - rig.group.rotation.y));
      rig.group.rotation.y += diff * k;
      rig.body.rotation.z = Math.sin(time * 8 + id) * 0.025;
      rig.fill.scale.x = Math.max(0, s.hp / 4);
      updateElectricTarget(rig, rig.group, rig.geometry, s.electricUntil);
    }
    for (const [id, rig] of snakeRigs) if (!S.snakes.has(id)) {
      scene.remove(rig.group);
      if (rig.electricFx) for (const mesh of [rig.electricFx.outline, rig.electricFx.arcs]) { mesh.geometry.dispose(); mesh.material.dispose(); }
      snakeRigs.delete(id);
    }
  }

  // ---- players ------------------------------------------------------------
  const players = new Map();
  let localPlayerId = null;
  const SKIN = ['#f1c9a5', '#e0ac82', '#c68a5f', '#8d5a3b', '#f6d6b8'];
  const HAIR = ['#1b1b22', '#3a2a1c', '#6b4a2a', '#c9a227', '#7a2e2e'];

  // Small hats and gear per company role, built in head units and parented to the head.
  const ACCESSORY_POS = [0, 8.2, 0];
  const ACCESSORY_SCALE = 0.52;
  function accessoryParts(role) {
    switch (role) {
      case 'it':
        return [
          box(17, 1.6, 2, '#2b2f3a', 0, 1, 0),
          box(1.6, 12, 2, '#2b2f3a', -8.4, -5, 0),
          box(1.6, 12, 2, '#2b2f3a', 8.4, -5, 0),
          sph(3.6, '#ff5d4a', -9.2, -10, 0, 0.55, 1, 1),
          sph(3.6, '#ff5d4a', 9.2, -10, 0, 0.55, 1, 1),
        ];
      case 'dev':
        return [sph(9, '#2f3d52', 0, 0, 0, 1, 0.65, 1), sph(1.6, '#2f3d52', 0, 5.5, 0)];
      case 'mkt':
        return [sph(10.2, '#c0392b', 0, 0, 0, 1, 0.4, 1), sph(1.2, '#7a2218', 0, 4.2, 0)];
      case 'dsg':
        return [sph(10.2, '#2d6cdf', 0, 0, 0, 1, 0.4, 1), sph(1.2, '#1c3f86', 0, 4.2, 0)];
      case 'ts':
        return [
          sph(8.2, '#3aa0ff', 0, 0, 0, 1, 0.6, 1),
          box(1, 4, 1, '#cfd6e0', 0, 5, 0),
          box(12, 0.7, 2.4, '#ffd34d', 0, 7.2, 0),
          box(2.4, 0.7, 12, '#ffd34d', 0, 7.3, 0),
        ];
      case 'bv':
        return [cyl(8.8, 8.8, 4.2, '#1f2a44', 0, 0, 0, 10), box(12, 0.8, 7, '#141a2c', 0, -1, 7), sph(1.6, '#f2c744', 0, 0.5, 8.8)];
      case 'kt':
        return [cyl(8.6, 8.6, 1.4, '#2f8f5a', 0, 0, 0, 10), box(15, 0.8, 7.5, '#2f8f5a', 0, 0, 7)];
      default:
        return null;
    }
  }
  function buildAccessory(role) {
    const parts = accessoryParts(role);
    if (!parts) return null;
    const m = new THREE.Mesh(merge(parts), bodyMat);
    m.castShadow = true;
    const grp = new THREE.Group();
    grp.add(m);
    return grp;
  }

  function makePlayer(p) {
    const g = new THREE.Group();
    const hue = p.hue;
    const shirt = new THREE.Color().setHSL(hue / 360, 0.65, 0.52);
    const shirtHex = '#' + shirt.getHexString();
    const skin = p.gender === 'boss' ? '#f1c9a5' : SKIN[Math.abs(p.id) % SKIN.length]; // the boss has a negative id
    const hair = HAIR[Math.abs(p.id * 3) % HAIR.length];
    const boss = p.gender === 'boss';
    const mini = !!p.mini;
    const bossLook = boss || mini;
    const female = p.gender === 'f';
    const jacket = boss ? '#1a2233' : mini ? (p.mini === 'TML' ? '#68432c' : p.mini === 'PROFK' ? '#5d6675' : '#49315e') : shirtHex;
    const pantsHex = bossLook ? '#161c2c' : '#222733';
    const hairHex = boss ? '#cfd6e0' : mini ? (p.mini === 'TML' ? '#8a8482' : p.mini === 'PROFK' ? '#eceef2' : '#1e1b26') : hair;
    const style = boss ? 0 : Math.abs(p.id) % 4;

    const capsule = (r, len, hex, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) => {
      const g = new THREE.CapsuleGeometry(r, len, 4, 14);
      g.scale(sx, sy, sz);
      return place(paint(g, hex), x, y, z);
    };
    const cone = (r, h, hex, x, y, z, rx = 0, ry = 0, rz = 0) => place(paint(new THREE.ConeGeometry(r, h, 10), hex), x, y, z, rx, ry, rz);

    const mat = bodyMat;
    const mk = (geo) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      return m;
    };

    let torso, head, thighGeoL, thighGeoR, shinGeoL, shinGeoR, makeArm;
    let legBaseY = 46, legOffsetX = 4.8;
    let torsoPosY = 46, headPosY = 73;
    let armPosY = 67, armPosX = 9.2;
    let thighLen = 22;
    let ponytailGroup = null;

    if (boss) {
      // ---------------- BOSS VKL (WUXIA EXECUTIVE RIG - 1:7 PROPORTION, SEAMLESS JOINTS) ----------------
      legBaseY = 46;
      legOffsetX = 5.4;
      torsoPosY = 46;
      headPosY = 75;
      armPosY = 68;
      armPosX = 11.0;
      thighLen = 22;

      // Torso: navy trench coat, waistcoat vest, crisp white collar, crimson tie, gold tie bar
      const torsoParts = [
        // Pelvis socket block (encloses top of thighs with 0 gap)
        box(16, 6.5, 9.5, '#161c2c', 0, 0, 0),
        // Tailored vest & waist
        box(15, 8, 9.0, '#242b3d', 0, 6.5, 0),
        box(18, 12, 10.2, '#242b3d', 0, 15, 0),
        // Draped overcoat & shoulder bar (shoulders extend to X = ±11.0, seamlessly meeting arms)
        box(22.5, 20, 12.0, '#1a2233', 0, 14, -0.5),
        box(22.0, 5.5, 11.0, '#1a2233', 0, 22, 0),
        // White collar & placket
        cyl(3.2, 3.8, 3.2, '#f4f6fa', 0, 24.5, 1.2, 12),
        box(4.5, 12, 0.8, '#f4f6fa', 0, 18, 5.2),
        // Crimson silk tie & gold clip
        box(2.4, 14, 1.0, '#991b1b', 0, 17, 5.5),
        box(2.8, 0.8, 1.2, '#eab308', 0, 19, 5.6),
        // Trench coat open lapels
        box(3.8, 18, 1.5, '#101624', -8.0, 15, 5.2, 0, 0.15, -0.1),
        box(3.8, 18, 1.5, '#101624', 8.0, 15, 5.2, 0, -0.15, 0.1),
      ];
      torso = merge(torsoParts);

      // Head: proportional 1:7 head (~14 units tall), flat eyes, swept-back silver hair
      const headParts = [
        cyl(2.6, 3.0, 6.0, skin, 0, 0.5, 0, 10), // neck
        sph(5.8, skin, 0, 6.4, 0, 0.95, 1.15, 0.95), // head core
        box(5.0, 3.6, 5.0, skin, 0, 2.4, 0.6, 0.22, 0, 0), // jaw
        ell(1.2, 2.0, 1.2, skin, -5.6, 6.2, -0.4), // ears
        ell(1.2, 2.0, 1.2, skin, 5.6, 6.2, -0.4),
        // Flat eyes (depth 0.08, completely flush with face, zero bulging!)
        box(1.8, 1.1, 0.08, '#181d28', -2.4, 6.2, 5.4),
        box(1.8, 1.1, 0.08, '#181d28', 2.4, 6.2, 5.4),
        box(0.5, 0.45, 0.08, '#ffffff', -2.1, 6.45, 5.44),
        box(0.5, 0.45, 0.08, '#ffffff', 2.7, 6.45, 5.44),
        // Stern grey eyebrows
        box(2.2, 0.45, 0.08, '#4b5563', -2.4, 7.3, 5.42, 0, 0, -0.15),
        box(2.2, 0.45, 0.08, '#4b5563', 2.4, 7.3, 5.42, 0, 0, 0.15),
        // Swept-back silver hair: skull cap seated at back & top
        sph(5.8, '#d1d5db', 0, 7.6, -1.8, 1.02, 1.05, 0.82),
        box(6.8, 7.5, 3.2, '#d1d5db', 0, 2.5, -5.2, 0.18, 0, 0),
        ell(4.5, 2.2, 2.2, '#cbd5e1', -2.8, 10.2, 5.0, 0.15, 0.2, -0.2),
        ell(3.8, 2.0, 2.0, '#cbd5e1', 2.6, 10.4, 4.8, 0.15, -0.25, 0.15),
      ];
      head = merge(headParts);

      // Healthy Left Leg: socket ball at top + knee sphere at bottom, zero gap
      thighGeoL = merge([
        sph(2.9, '#161c2c', 0, 0, 0), // hip ball (sockets in pelvis)
        cyl(2.9, 2.5, 21, '#161c2c', 0, -10.5, 0, 10),
        sph(2.5, '#161c2c', 0, -21.5, 0), // knee ball
      ]);
      shinGeoL = merge([
        sph(2.52, '#161c2c', 0, 0, 0), // knee socket (matches thigh knee ball)
        cyl(2.4, 2.0, 20, '#161c2c', 0, -10, 0, 10),
        box(5.0, 4.2, 11.5, '#0d1117', 0, -21, 1.6), // black oxford leather shoe
        box(5.2, 1.8, 12.0, '#080a0f', 0, -23, 1.6),
        sph(2.5, '#161b24', 0, -22, 6.8),
      ]);

      // Injured Right Leg: steel orthopedic brace mechanism with articulated hinge & struts
      thighGeoR = merge([
        sph(2.9, '#161c2c', 0, 0, 0),
        cyl(2.9, 2.5, 21, '#161c2c', 0, -10.5, 0, 10),
        sph(2.5, '#161c2c', 0, -21.5, 0),
        cyl(3.3, 3.3, 4.0, '#718096', 0, -13, 0, 12), // steel thigh cuff
        box(3.8, 2.5, 1.2, '#334155', 0, -13, 3.2), // buckle
      ]);
      shinGeoR = merge([
        sph(2.52, '#161c2c', 0, 0, 0),
        cyl(2.4, 2.0, 20, '#161c2c', 0, -10, 0, 10),
        // Steel orthopedic hinge mechanism
        cyl(2.8, 2.8, 1.4, '#94a3b8', 3.0, 0, 0, 12, 0, 0, Math.PI / 2),
        sph(0.8, '#f8fafc', 3.7, 0, 0),
        cyl(2.8, 2.8, 1.4, '#94a3b8', -3.0, 0, 0, 12, 0, 0, Math.PI / 2),
        sph(0.8, '#f8fafc', -3.7, 0, 0),
        // Vertical steel struts down calf
        box(1.0, 18, 1.4, '#718096', 3.0, -9, 0),
        box(1.0, 18, 1.4, '#718096', -3.0, -9, 0),
        // Support shoe
        box(5.2, 4.4, 11.8, '#1e293b', 0, -21, 1.6),
        box(5.4, 2.2, 12.2, '#0f172a', 0, -23, 1.6),
        box(5.3, 5.5, 1.6, '#94a3b8', 0, -20, -3.8), // heel bracket
      ]);

      // Arms: shoulder sphere penetrates deep into torso shoulder (armPosX = 11.0); cane in left hand
      makeArm = (isLeft) => {
        const shoulder = new THREE.Group();
        shoulder.add(mk(merge([
          sph(3.0, '#1a2233', 0, 0, 0), // shoulder ball (inside torso shoulder)
          cyl(2.9, 2.6, 12, '#1a2233', 0, -6, 0, 10),
          sph(2.4, '#1a2233', 0, -12, 0), // elbow ball
        ])));
        const fore = new THREE.Group();
        fore.position.y = -12;
        fore.add(mk(merge([
          sph(2.42, '#1a2233', 0, 0, 0), // elbow socket
          cyl(2.5, 2.2, 12, '#1a2233', 0, -6, 0, 10),
          cyl(2.7, 2.7, 1.8, '#f4f6fa', 0, -11.5, 0, 10), // white cuff
          box(2.8, 3.4, 2.0, skin, 0, -13.5, 0), // hand
        ])));
        if (isLeft) {
          // Ebony cane with gold lion-head handle
          const cane = mk(merge([
            cyl(1.0, 0.8, 45, '#1e140e', 0, -12, 0, 8),
            ell(2.2, 1.6, 3.5, '#eab308', 0, 9.5, 1.4),
            cyl(1.4, 1.4, 2.0, '#ca8a04', 0, 8.0, 0, 8),
            cyl(1.0, 1.0, 1.8, '#18181b', 0, -34, 0, 8),
          ]));
          fore.add(cane);
        }
        shoulder.add(fore);
        return { shoulder, fore };
      };
    } else if (mini) {
      // ---------------- MINI-BOSSES (TML, DMM, PROF. K - 1:7 PROPORTIONS, SEAMLESS) ----------------
      legBaseY = 46;
      legOffsetX = 5.0;
      torsoPosY = 46;
      headPosY = 74;
      armPosY = 67;
      armPosX = 10.4;
      thighLen = 22;

      const miniType = p.mini;
      const suitColor = miniType === 'TML' ? '#68432c' : miniType === 'DMM' ? '#49315e' : '#e2e8f0';
      const torsoParts = [
        box(15.5, 6.5, 9.0, suitColor, 0, 0, 0),
        box(15.0, 8, 8.5, suitColor, 0, 6.5, 0),
        box(18.0, 12, 10.0, suitColor, 0, 15, 0),
        box(20.8, 5.5, 9.8, suitColor, 0, 21.5, 0),
        cyl(3.0, 3.6, 3.2, '#f4f6fa', 0, 24, 0.8, 12),
      ];
      if (miniType === 'TML') {
        torsoParts.push(box(12, 16, 1.5, '#4a2f1e', 0, 14, 5.0));
      } else if (miniType === 'DMM') {
        torsoParts.push(box(3.6, 2.4, 1.4, '#b91c1c', 0, 22.5, 5.2));
      } else {
        torsoParts.push(box(10, 15, 1.5, '#1e293b', 0, 14, 5.0));
      }
      torso = merge(torsoParts);

      const headParts = [
        cyl(2.4, 2.8, 6.0, skin, 0, 0.5, 0, 10),
        sph(5.6, skin, 0, 6.4, 0, 0.95, 1.15, 0.95),
        box(4.8, 3.6, 4.8, skin, 0, 2.4, 0.6, 0.22, 0, 0),
        ell(1.2, 2.0, 1.2, skin, -5.4, 6.2, -0.4),
        ell(1.2, 2.0, 1.2, skin, 5.4, 6.2, -0.4),
        box(1.8, 1.1, 0.08, '#181d28', -2.3, 6.2, 5.3),
        box(1.8, 1.1, 0.08, '#181d28', 2.3, 6.2, 5.3),
        box(0.5, 0.45, 0.08, '#ffffff', -2.0, 6.45, 5.34),
        box(0.5, 0.45, 0.08, '#ffffff', 2.6, 6.45, 5.34),
        sph(5.6, hairHex, 0, 7.6, -1.8, 1.02, 1.05, 0.82),
      ];
      if (miniType === 'TML') {
        headParts.push(ell(4.5, 2.2, 2.2, hairHex, -2.8, 10.2, 5.0, 0.15, 0.2, -0.2));
      } else if (miniType === 'DMM') {
        headParts.push(box(3.4, 0.7, 0.08, '#111111', 0, 3.2, 5.35)); // pencil mustache
      } else {
        headParts.push(sph(3.2, hairHex, 0, 11.5, -4.5)); // scholar bun
        headParts.push(box(2.4, 1.8, 0.08, '#94a3b8', -2.3, 6.2, 5.38)); // spectacles
        headParts.push(box(2.4, 1.8, 0.08, '#94a3b8', 2.3, 6.2, 5.38));
      }
      head = merge(headParts);

      thighGeoL = thighGeoR = merge([
        sph(2.8, '#161c2c', 0, 0, 0),
        cyl(2.8, 2.4, 21, '#161c2c', 0, -10.5, 0, 10),
        sph(2.4, '#161c2c', 0, -21.5, 0),
      ]);
      shinGeoL = shinGeoR = merge([
        sph(2.42, '#161c2c', 0, 0, 0),
        cyl(2.3, 1.9, 20, '#161c2c', 0, -10, 0, 10),
        box(4.8, 4.0, 11.2, '#0d1117', 0, -21, 1.6),
        box(5.0, 1.8, 11.6, '#080a0f', 0, -23, 1.6),
      ]);

      makeArm = () => {
        const shoulder = new THREE.Group();
        shoulder.add(mk(merge([
          sph(2.8, suitColor, 0, 0, 0),
          cyl(2.7, 2.4, 12, suitColor, 0, -6, 0, 10),
          sph(2.3, suitColor, 0, -12, 0),
        ])));
        const fore = new THREE.Group();
        fore.position.y = -12;
        fore.add(mk(merge([
          sph(2.32, suitColor, 0, 0, 0),
          cyl(2.4, 2.0, 12, suitColor, 0, -6, 0, 10),
          box(2.6, 3.2, 1.8, skin, 0, -13, 0),
        ])));
        shoulder.add(fore);
        return { shoulder, fore };
      };
    } else if (female) {
      // ---------------- FEMALE PLAYERS (1:7 PROPORTIONS, SEAMLESS BALL SOCKETS, FLAT EYES) ----------------
      legBaseY = 46;
      legOffsetX = 4.2;
      torsoPosY = 46;
      headPosY = 73;
      armPosY = 66;
      armPosX = 8.6;
      thighLen = 22;

      // Torso: slender feminine waist, blouse, collar/ribbon; shoulders extend to X = ±8.6
      const torsoParts = [
        box(13.0, 6.0, 8.0, '#222a38', 0, 0, 0), // pelvis socket
        box(11.5, 7.0, 7.5, shirtHex, 0, 6.0, 0), // waist
        box(14.0, 11.0, 8.5, shirtHex, 0, 14.0, 0), // chest
        box(16.2, 4.8, 8.2, shirtHex, 0, 20.5, 0), // shoulders (ends at X = ±8.1, arm at 8.6 -> 0 gap!)
        cyl(2.6, 3.2, 3.0, shirtHex, 0, 23.5, 0, 12), // collar
        box(1.2, 14, 0.4, shade(shirtHex, 0.85), 0, 14, 4.3), // placket
      ];
      if (style === 0) {
        // High ponytail: ribbon bow tie & high pleated skirt
        torsoParts.push(box(2.8, 2.4, 1.2, '#e11d48', 0, 22.8, 4.6));
        torsoParts.push(box(14.0, 6.5, 9.2, '#222a38', 0, 1.5, 0));
      } else if (style === 1) {
        // Twin tails: Peter Pan collar & pencil skirt
        torsoParts.push(cyl(3.2, 3.2, 0.8, '#ffffff', 0, 23.2, 2.6, 10));
        torsoParts.push(box(13.5, 6.5, 8.8, '#1c212d', 0, 1.5, 0));
      } else if (style === 2) {
        // Wuxia bun: mandarin clasp & dress slacks
        torsoParts.push(sph(0.9, '#34d399', 0, 23.5, 4.4));
        torsoParts.push(box(13.2, 4.5, 8.6, '#282f3d', 0, 1.0, 0));
      } else {
        // Bob: tailored office vest
        torsoParts.push(box(14.6, 12, 8.8, '#262d3a', 0, 14, 0));
        torsoParts.push(box(13.5, 6.5, 9.0, '#262d3a', 0, 1.5, 0));
      }
      torso = merge(torsoParts);

      // Head: slender anime face, flat flush eyes (0 bug eyes!), blush, hair
      const headParts = [
        cyl(1.8, 2.2, 5.0, skin, 0, 0.5, 0, 10), // neck
        sph(5.2, skin, 0, 5.8, 0, 0.95, 1.12, 0.95), // core
        box(4.2, 3.2, 4.2, skin, 0, 2.2, 0.6, 0.22, 0, 0), // jaw
        ell(1.0, 1.8, 1.0, skin, -5.0, 5.6, -0.4), // ears
        ell(1.0, 1.8, 1.0, skin, 5.0, 5.6, -0.4),
        ell(1.2, 0.8, 0.08, '#f472b6', -3.2, 4.8, 4.85), // cheek blush
        ell(1.2, 0.8, 0.08, '#f472b6', 3.2, 4.8, 4.85),
        // Flat eyes (depth 0.08, completely flush with skin!)
        box(1.6, 1.2, 0.08, '#181d28', -2.0, 5.6, 4.85),
        box(1.6, 1.2, 0.08, '#181d28', 2.0, 5.6, 4.85),
        box(0.45, 0.45, 0.08, '#ffffff', -1.7, 5.9, 4.88),
        box(0.45, 0.45, 0.08, '#ffffff', 2.3, 5.9, 4.88),
        // Eyebrows
        box(1.8, 0.3, 0.08, hairHex, -2.0, 6.8, 4.86, 0, 0, -0.1),
        box(1.8, 0.3, 0.08, hairHex, 2.0, 6.8, 4.86, 0, 0, 0.1),
        // Hair base: shifted to back and top so the face and eyes remain clean and unobstructed
        sph(5.3, hairHex, 0, 7.0, -1.8, 1.02, 1.05, 0.82),
        box(5.8, 6.5, 2.6, hairHex, 0, 2.2, -4.5, 0.18, 0, 0),
      ];

      if (style === 0) {
        // High ponytail: face fringe in head, ponytail in swinging group
        headParts.push(ell(4.2, 2.2, 2.2, hairHex, -2.5, 9.2, 4.4, 0.15, 0.2, -0.2));
        headParts.push(ell(3.6, 2.0, 2.0, hairHex, 2.4, 9.4, 4.2, 0.15, -0.25, 0.15));
        ponytailGroup = new THREE.Group();
        ponytailGroup.position.set(0, 9.8, -4.6);
        ponytailGroup.add(mk(merge([
          cyl(1.8, 1.8, 1.5, '#e11d48', 0, 0, 0, 10, 0.35, 0, 0), // red scrunchie
          pill(1.6, 16, hairHex, 0, -7.5, -2.5, 0.35, 0, 0),
          pill(1.2, 12, hairHex, 0, -14, -5.0, 0.45, 0, 0),
        ])));
      } else if (style === 1) {
        // Twin tails
        headParts.push(ell(4.5, 2.2, 2.2, hairHex, 0, 9.4, 4.4));
        headParts.push(pill(1.4, 14, hairHex, -5.8, 1.5, -2.5, 0.15, 0, 0.2));
        headParts.push(pill(1.4, 14, hairHex, 5.8, 1.5, -2.5, 0.15, 0, -0.2));
        headParts.push(cyl(1.8, 1.8, 1.2, '#e11d48', -5.8, 6.5, -2.5, 8));
        headParts.push(cyl(1.8, 1.8, 1.2, '#e11d48', 5.8, 6.5, -2.5, 8));
      } else if (style === 2) {
        // Wuxia chignon bun with hairpin needle & jade bead
        headParts.push(ell(4.5, 2.2, 2.2, hairHex, -2.2, 9.2, 4.4, 0.15, 0.2, -0.2));
        headParts.push(sph(3.6, hairHex, 0, 10.5, -4.2)); // chignon
        headParts.push(cyl(0.35, 0.35, 14, '#fde047', 0, 10.5, -4.2, 8, 0, 0, 1.1)); // hairpin
        headParts.push(sph(0.9, '#34d399', 6.5, 13.2, -4.2)); // jade bead
      } else {
        // Chic layered bob
        headParts.push(ell(4.2, 6.5, 2.6, hairHex, -5.5, 2.2, 0.2, 0.1, 0, 0.08));
        headParts.push(ell(4.2, 6.5, 2.6, hairHex, 5.5, 2.2, 0.2, 0.1, 0, -0.08));
        headParts.push(ell(4.8, 2.4, 2.2, hairHex, -1.2, 9.6, 4.4, 0.12, 0.15, -0.15));
      }
      head = merge(headParts);

      // Legs: seamless ball socket at hip and knee
      const isSlacks = style === 2;
      const legColor = isSlacks ? '#282f3d' : skin;
      thighGeoL = thighGeoR = merge([
        sph(2.6, legColor, 0, 0, 0), // hip ball (inside pelvis socket)
        cyl(2.6, 2.2, 21, legColor, 0, -10.5, 0, 10),
        sph(2.2, legColor, 0, -21.5, 0), // knee ball
      ]);

      if (style === 0) {
        // Dark knee-high socks + buckle loafers
        shinGeoL = shinGeoR = merge([
          sph(2.22, '#1e232e', 0, 0, 0), // knee socket
          cyl(2.1, 1.7, 20, '#1e232e', 0, -10, 0, 10),
          box(4.2, 3.8, 10.5, '#11141a', 0, -21, 1.5),
          box(4.4, 1.6, 11.0, '#080a0f', 0, -22.8, 1.5),
          box(2.2, 0.8, 0.8, '#e2e8f0', 0, -19.5, 3.5),
        ]);
      } else if (style === 1) {
        // White ankle socks + pumps
        shinGeoL = shinGeoR = merge([
          sph(2.22, skin, 0, 0, 0),
          cyl(2.1, 1.7, 20, skin, 0, -10, 0, 10),
          cyl(2.3, 2.3, 2.8, '#ffffff', 0, -16.5, 0, 10), // sock
          box(4.0, 3.6, 10.2, '#2a2f3a', 0, -21, 1.5),
          box(4.2, 1.6, 10.6, '#1a1e28', 0, -22.8, 1.5),
        ]);
      } else if (style === 2) {
        // Flared slacks + flats
        shinGeoL = shinGeoR = merge([
          sph(2.22, '#282f3d', 0, 0, 0),
          cyl(2.3, 1.9, 20, '#282f3d', 0, -10, 0, 10),
          box(4.2, 3.8, 10.5, '#1a1e28', 0, -21, 1.5),
          box(4.4, 1.6, 11.0, '#0d1117', 0, -22.8, 1.5),
        ]);
      } else {
        // Tights + heels
        shinGeoL = shinGeoR = merge([
          sph(2.22, '#252932', 0, 0, 0),
          cyl(2.1, 1.7, 20, '#252932', 0, -10, 0, 10),
          box(4.0, 3.6, 10.2, '#161922', 0, -21, 1.5),
          box(4.2, 1.6, 10.6, '#0a0d13', 0, -22.8, 1.5),
        ]);
      }

      // Arms: shoulder sphere penetrates deep into torso shoulder (armPosX = 8.6, shoulder width = 16.2 -> 0 gap!)
      makeArm = () => {
        const shoulder = new THREE.Group();
        shoulder.add(mk(merge([
          sph(2.5, shirtHex, 0, 0, 0),
          cyl(2.4, 2.1, 10, shirtHex, 0, -5, 0, 10),
          cyl(2.6, 2.6, 2.0, shade(shirtHex, 1.15), 0, -9.5, 0, 10),
          sph(2.0, skin, 0, -10, 0), // elbow ball
        ])));
        const fore = new THREE.Group();
        fore.position.y = -10;
        fore.add(mk(merge([
          sph(2.02, skin, 0, 0, 0), // elbow socket
          cyl(1.9, 1.6, 11, skin, 0, -5.5, 0, 10),
          box(2.4, 3.0, 1.8, skin, 0, -12, 0),
        ])));
        shoulder.add(fore);
        return { shoulder, fore };
      };
    } else {
      // ---------------- MALE PLAYERS (1:7 PROPORTIONS, SEAMLESS BALL SOCKETS, FLAT EYES) ----------------
      legBaseY = 46;
      legOffsetX = 4.6;
      torsoPosY = 46;
      headPosY = 74;
      armPosY = 67;
      armPosX = 9.8;
      thighLen = 23;

      // Torso: slim-fit shirt, tie, belt, lanyard; shoulders extend to X = ±9.3 (armPosX = 9.8 -> 0 gap!)
      const torsoParts = [
        box(14.5, 6.0, 8.5, pantsHex, 0, 0, 0), // pelvis socket
        box(13.5, 7.0, 8.0, shirtHex, 0, 6.0, 0), // waist
        box(16.5, 12.0, 9.5, shirtHex, 0, 14.0, 0), // chest
        box(18.6, 5.0, 9.2, shirtHex, 0, 21.0, 0), // shoulders (ends at X = ±9.3)
        cyl(3.0, 3.6, 3.2, shirtHex, 0, 24.2, 0, 12), // collar
        box(1.5, 15, 0.4, shade(shirtHex, 0.85), 0, 14, 4.8), // placket
      ];
      if (style === 0) {
        // 7/3 side part: classic red necktie + ID card lanyard
        torsoParts.push(box(2.2, 14, 0.8, '#9e2a2b', 0, 16, 5.2));
        torsoParts.push(box(0.6, 14, 0.3, '#3b82f6', -4.2, 17, 5.0, 0, 0, -0.2));
        torsoParts.push(box(2.4, 3.8, 0.3, '#ffffff', -5.5, 9.5, 5.2));
      } else if (style === 1) {
        // Spiky: open collar + dark undershirt
        torsoParts.push(box(4.5, 8, 0.6, '#1e232e', 0, 19, 4.6));
        torsoParts.push(box(0.6, 14, 0.3, '#e11d48', -4.2, 17, 5.0, 0, 0, -0.2));
        torsoParts.push(box(2.4, 3.8, 0.3, '#ffffff', -5.5, 9.5, 5.2));
      } else if (style === 2) {
        // Man bun: office vest over shirt
        torsoParts.push(box(17.0, 13, 9.8, '#242a38', 0, 14, 0));
        torsoParts.push(box(0.6, 10, 0.4, '#eab308', -3.5, 11, 5.1)); // gold chain
      } else {
        // Comma bangs: button-down with slim knit tie & clip
        torsoParts.push(box(2.0, 14, 0.7, '#374151', 0, 16, 5.1));
        torsoParts.push(box(2.4, 0.7, 0.8, '#e2e8f0', 0, 17.5, 5.3));
      }
      torso = merge(torsoParts);

      // Head: 1:7 human proportion (~14 units tall), FLAT FLUSH EYES (0 bulging!), layered hair
      const headParts = [
        cyl(2.2, 2.6, 5.5, skin, 0, 0.5, 0, 10), // neck
        sph(5.6, skin, 0, 6.2, 0, 0.95, 1.15, 0.95), // core
        box(4.6, 3.4, 4.6, skin, 0, 2.4, 0.6, 0.22, 0, 0), // jaw
        ell(1.1, 1.9, 1.1, skin, -5.4, 6.0, -0.4), // ears
        ell(1.1, 1.9, 1.1, skin, 5.4, 6.0, -0.4),
        // Flat eyes (depth 0.08, completely flush with skin surface, zero bug eyes!)
        box(1.8, 1.3, 0.08, '#181d28', -2.2, 6.0, 5.35),
        box(1.8, 1.3, 0.08, '#181d28', 2.2, 6.0, 5.35),
        box(0.5, 0.5, 0.08, '#ffffff', -1.9, 6.3, 5.38),
        box(0.5, 0.5, 0.08, '#ffffff', 2.5, 6.3, 5.38),
        // Eyebrows
        box(2.0, 0.4, 0.08, hairHex, -2.2, 7.2, 5.36, 0, 0, -0.1),
        box(2.0, 0.4, 0.08, hairHex, 2.2, 7.2, 5.36, 0, 0, 0.1),
        // Hair base: shifted to back and top so the face and eyes remain clean and unobstructed
        sph(5.7, hairHex, 0, 7.5, -1.8, 1.02, 1.05, 0.82),
        box(6.2, 7.0, 2.8, hairHex, 0, 2.4, -4.8, 0.18, 0, 0),
      ];

      if (style === 0) {
        // Side part 7/3
        headParts.push(ell(4.5, 2.2, 2.2, hairHex, -2.8, 9.8, 4.8, 0.15, 0.2, -0.2));
        headParts.push(ell(3.8, 2.0, 2.0, hairHex, 2.6, 10.0, 4.5, 0.15, -0.25, 0.15));
      } else if (style === 1) {
        // Textured spiky
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2;
          headParts.push(cone(2.2, 6.5, hairHex, Math.sin(a) * 4.6, 11 + (i % 2) * 1.0, Math.cos(a) * 4.2 - 0.8, Math.cos(a) * 0.4, 0, -Math.sin(a) * 0.4));
        }
      } else if (style === 2) {
        // Man bun / topknot
        headParts.push(sph(3.2, hairHex, 0, 11.5, -4.5));
        headParts.push(ell(4.6, 2.0, 2.0, hairHex, -2.4, 9.8, 4.5, 0.12, 0.15, -0.15));
      } else {
        // Comma bangs / curtain bangs
        headParts.push(ell(3.8, 2.2, 2.2, hairHex, -2.6, 9.6, 4.6, 0.18, 0.25, -0.25));
        headParts.push(ell(3.8, 2.2, 2.2, hairHex, 2.6, 9.6, 4.6, 0.18, -0.25, 0.25));
      }
      head = merge(headParts);

      // Legs: seamless ball socket at hip and knee
      thighGeoL = thighGeoR = merge([
        sph(2.8, pantsHex, 0, 0, 0), // hip ball (sockets inside pelvis block)
        cyl(2.8, 2.4, 22, pantsHex, 0, -11, 0, 10),
        sph(2.4, pantsHex, 0, -22, 0), // knee ball
      ]);
      shinGeoL = shinGeoR = merge([
        sph(2.42, pantsHex, 0, 0, 0), // knee socket (shared center with thigh knee ball)
        cyl(2.3, 1.9, 21, pantsHex, 0, -10.5, 0, 10),
        box(4.8, 4.2, 11.5, '#262d3d', 0, -22.5, 1.8),
        box(5.0, 1.8, 12.0, '#f4f6fa', 0, -24.4, 1.8),
        sph(2.5, '#f4f6fa', 0, -23.5, 7.2),
        box(2.8, 0.8, 4.5, '#f4f6fa', 0, -20.8, 2.8),
      ]);

      // Arms: shoulder sphere penetrates deep into torso shoulder (armPosX = 9.8, shoulder width = 18.6 -> 0 gap!)
      makeArm = () => {
        const shoulder = new THREE.Group();
        shoulder.add(mk(merge([
          sph(2.8, shirtHex, 0, 0, 0),
          cyl(2.6, 2.3, 11, shirtHex, 0, -5.5, 0, 10),
          cyl(2.8, 2.8, 2.2, shade(shirtHex, 1.15), 0, -10.5, 0, 10),
          sph(2.2, skin, 0, -11, 0), // elbow ball
        ])));
        const fore = new THREE.Group();
        fore.position.y = -11;
        fore.add(mk(merge([
          sph(2.22, skin, 0, 0, 0), // elbow socket
          cyl(2.1, 1.8, 12, skin, 0, -6, 0, 10),
          box(2.8, 3.4, 2.0, skin, 0, -12.5, 0),
          capsule(0.7, 1.8, skin, 1.4, -12, 0.7, 0.35, 0.25, 0),
        ])));
        shoulder.add(fore);
        return { shoulder, fore };
      };
    }

    const root = new THREE.Group();
    g.add(root);
    const torsoM = mk(torso);
    torsoM.position.y = torsoPosY;
    root.add(torsoM);
    if (mini) torsoM.scale.set(1.16, 1.05, 1.08);
    const headM = mk(head);
    headM.position.y = headPosY;
    headM.scale.setScalar(1.0);
    if (ponytailGroup) headM.add(ponytailGroup);
    root.add(headM);
    const acc = buildAccessory(p.role);
    if (acc) {
      acc.scale.setScalar(ACCESSORY_SCALE);
      acc.position.set(ACCESSORY_POS[0], ACCESSORY_POS[1], ACCESSORY_POS[2]);
      headM.add(acc);
    }

    // Articulated legs with hip & knee joints
    const legL = new THREE.Group();
    legL.position.set(-legOffsetX, legBaseY, 0);
    legL.add(mk(thighGeoL));
    const shinL = new THREE.Group();
    shinL.position.set(0, -thighLen, 0);
    shinL.add(mk(shinGeoL));
    legL.add(shinL);

    const legR = new THREE.Group();
    legR.position.set(legOffsetX, legBaseY, 0);
    legR.add(mk(thighGeoR));
    const shinR = new THREE.Group();
    shinR.position.set(0, -thighLen, 0);
    shinR.add(mk(shinGeoR));
    legR.add(shinR);

    root.add(legL, legR);

    const armLg = makeArm(true);
    const armRg = makeArm(false);
    const armL = armLg.shoulder;
    const foreL = armLg.fore;
    const armR = armRg.shoulder;
    const foreR = armRg.fore;
    armL.position.set(armPosX, armPosY, 0);
    armR.position.set(-armPosX, armPosY, 0);
    // Mjolnir-ish hammer in the right hand: short leather-wrapped handle with a lanyard loop,
    // a wide rectangular steel head with darker bevelled end caps and gold rune inlays.
    const STEEL = '#c3ccda';
    const STEEL_DARK = '#8591a5';
    const PEWTER = '#6f7a8c';
    const WIRE = '#c9d1dd';
    const LEATHER = '#4a3020';
    const hammer = new THREE.Group();
    hammer.position.set(0, -32, 4);
    hammer.add(mk(merge([
      // handle: dark red leather with silver wire wraps, a metal collar where it enters the head
      cyl(2.9, 2.9, 40, '#6a3b2a', 0, 11, 0, 8),
      ...[0, 5, 10, 15, 20, 25].map((y) => cyl(3.25, 3.25, 1.1, WIRE, 0, y, 0, 8)),
      cyl(4.6, 4.6, 3.2, STEEL_DARK, 0, 30.4, 0, 10),
      // pommel cap and the leather strap loop hanging from it
      cyl(3.9, 3.1, 5.5, STEEL_DARK, 0, -8.2, 0, 8),
      cyl(4.1, 4.1, 1.2, STEEL, 0, -5.4, 0, 8),
      box(1.2, 16, 1.2, LEATHER, -5.2, -17, 0),
      box(1.2, 16, 1.2, LEATHER, 5.2, -17, 0),
      box(11.6, 1.2, 1.2, LEATHER, 0, -25, 0),
      // head: a bright block with chamfered corners, seams on top, pewter knotwork panels at both ends
      box(34, 19, 17, STEEL, 0, 40, 0),
      box(34, 15, 18.6, STEEL, 0, 40, 0), // slightly proud middle band = the chamfer line
      box(36.4, 12.5, 14.5, STEEL, 0, 40, 0),
      box(0.9, 0.5, 15, STEEL_DARK, -6, 49.7, 0),
      box(0.9, 0.5, 15, STEEL_DARK, 6, 49.7, 0),
      box(0.9, 18, 0.5, STEEL_DARK, -6.5, 40, 8.9),
      box(0.9, 18, 0.5, STEEL_DARK, 6.5, 40, 8.9),
      box(8.4, 5.2, 0.7, PEWTER, -12.8, 45.6, 8.9),
      box(8.4, 5.2, 0.7, PEWTER, 12.8, 45.6, 8.9),
      box(8.4, 5.2, 0.7, PEWTER, -12.8, 34.4, 8.9),
      box(8.4, 5.2, 0.7, PEWTER, 12.8, 34.4, 8.9),
      box(8.4, 5.2, 0.7, PEWTER, -12.8, 45.6, -8.9),
      box(8.4, 5.2, 0.7, PEWTER, 12.8, 45.6, -8.9),
      // end faces: square knotwork medallions
      box(0.7, 9, 9, PEWTER, -18.5, 40, 0),
      box(0.7, 9, 9, PEWTER, 18.5, 40, 0),
      box(0.6, 5, 5, STEEL, -18.9, 40, 0),
      box(0.6, 5, 5, STEEL, 18.9, 40, 0),
    ])));
    // The handle continues the arm and the head sits at the far end, with its long side along the swing, so raising the
    // arm lifts the hammer and swinging it down brings the head onto whatever is in front.
    hammer.position.set(0, -12, 1); // in the fist, at the end of the forearm
    hammer.quaternion.copy(_hammerHeld);
    hammer.scale.setScalar(0.72);
    foreR.add(hammer);
    // A bubble tea cup (for the milk tea throw) and a stun gun (for the electric skill) in the same fist, shown instead
    // of the hammer when that skill is chosen. Origin = where the fist holds them, "up" = the cup's / the gun's barrel.
    const cup = new THREE.Group();
    cup.position.set(0, -12, 1);
    cup.add(mk(merge([
      cyl(6.8, 4.9, 15, '#f3d7a9', 0, 0, 0, 18),
      cyl(6.1, 5.4, 5, '#e8648a', 0, -0.5, 0, 18),
      cyl(7.4, 7.4, 2.2, '#ffffff', 0, 8.6, 0, 18),
      ell(6.1, 2.6, 6.1, '#ffffff', 0, 10.4, 0),
      pill(0.7, 13, '#ff6fa5', 1.6, 17, 0, 0, 0, -0.1),
    ])));
    cup.visible = false;
    foreR.add(cup);
    const taser = new THREE.Group();
    taser.position.set(0, -12, 1);
    taser.add(mk(merge([
      box(6, 12, 8, '#2b3240', 0, 0, 0),
      box(8, 12, 10, '#3a4252', 0, 10, 0),
      box(10, 8, 11, '#e5483a', 0, 18, 0),
      box(2, 3, 2, '#ffd34d', 0, 6, 4.6),
      pill(1.1, 9, '#c9d1dd', -3.2, 26, 0),
      pill(1.1, 9, '#c9d1dd', 3.2, 26, 0),
      ell(3.6, 0.9, 0.9, '#8fe9ff', 0, 31, 0),
      ell(1.7, 1.7, 1.7, '#cdf7ff', -3.2, 31.5, 0),
      ell(1.7, 1.7, 1.7, '#cdf7ff', 3.2, 31.5, 0),
    ])));
    taser.visible = false;
    foreR.add(taser);
    root.add(armL, armR);

    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(22, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 3.4; // above the rugs (about 2.7 thick), or they hide the ring and the shadow
    g.add(blob);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(24, 29, 28),
      new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 4;
    ring.visible = false;
    g.add(ring);

    const label = document.createElement('div');
    label.className = 'plabel';
    const bub = document.createElement('span'); // chat bubble, shown for a few seconds after a message
    bub.className = 'bub';
    const emo = document.createElement('span');
    emo.className = 'emo';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p.name;
    const bar = document.createElement('span'); // mana bar, only shown for our own player
    bar.className = 'mana';
    const fill = document.createElement('i');
    bar.appendChild(fill);
    const rl = document.createElement('span'); // company role under the name
    rl.className = 'rl';
    const hpb = document.createElement('span'); // health bar, shown once hurt (always for the boss)
    hpb.className = 'hpb';
    const hpf = document.createElement('i');
    hpb.appendChild(hpf);
    let hpt = null; // the boss's bar also shows the number
    if (p.gender === 'boss' || p.mini) {
      hpt = document.createElement('span');
      hpt.className = 'hpt';
      hpb.appendChild(hpt);
    }
    label.append(bub, emo, nm);
    if (p.gender === 'boss' || p.mini) {
      const motto = document.createElement('span');
      motto.className = 'boss-motto';
      motto.textContent = p.mini === 'TML' ? 'Tranh công, chối tội, đổ lỗi, thanh minh'
        : p.mini === 'DMM' ? 'Thiên hạ đệ nhất thái giám' : p.mini === 'PROFK' ? 'Ngon thì vô làm' : 'Mọi người nghĩ dì dẫy?';
      label.appendChild(motto);
    }
    label.append(rl, hpb, bar);
    labelsEl.appendChild(label);

    scene.add(g);
    return { g, root, torsoM, headM, legL, legR, shinL, shinR, armL, armR, foreL, foreR, hammer, cup, taser, ring, label, bub, emo, nm, rl, hpb, hpf, hpt, bar, fill, ownedMaterials: [blob.material, ring.material], lie: 0, lastHp: -1, walk: 0, lastRole: '', lastCompany: null, lastName: p.name, lastEmote: '', lastChat: '', legBaseY, isBoss: boss, ponytail: ponytailGroup };
  }

  function updatePlayer(rig, p, dt, isMe, S) {
    const reacting = (p.hitUntil || 0) > performance.now();
    rig.g.position.set(p.x + (reacting ? (Math.random() - 0.5) * 6 : 0), p.fxLift || 0, p.y + (reacting ? (Math.random() - 0.5) * 6 : 0));
    // face the heading smoothly
    let diff = p.heading - rig.g.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    rig.g.rotation.y += diff * Math.min(1, dt * 14);

    // Lively motion: everything eases in and out with `mv` (0 standing, 1 running) so nothing snaps, and the body
    // breathes, bobs, leans, twists and squashes a little so it does not move like a stiff doll.
    rig.t = (rig.t || 0) + dt;
    rig.mv = (rig.mv || 0) + ((p.moving ? 1 : 0) - (rig.mv || 0)) * Math.min(1, dt * 9);
    const mv = rig.mv;
    const idle = 1 - mv;
    const isBoss = p.gender === 'boss';
    if (p.moving) rig.walk += dt * (isBoss ? 6.5 : 10.5); // the boss lurches along slowly
    const wp = rig.walk;
    const sw = Math.sin(wp) * 0.95 * mv;
    const breathe = p.dead ? 0 : Math.sin(rig.t * 2.3) * idle;
    const legBase = rig.legBaseY || 50;

    if (isBoss) {
      // ---------------- BOSS VKL REALISTIC LIMP WITH WALKING CANE ----------------
      // Healthy Left Leg: takes a solid, confident stride forward
      const swBossL = Math.sin(wp) * 0.75 * mv;
      rig.legL.rotation.x = swBossL;
      rig.legL.rotation.z = 0;
      // Healthy left knee flexes naturally during swing phase
      rig.shinL.rotation.x = -Math.max(0, Math.sin(wp)) * 0.75 * mv;
      rig.legL.position.y = legBase + Math.max(0, -Math.sin(wp)) * 3 * mv;

      // Injured Right Leg: steel hinge brace restricts knee flexion; circumduction arcing outward
      const swBossR = -Math.sin(wp) * 0.75 * mv;
      rig.legR.rotation.x = swBossR;
      // Brace heavily restricts flexion
      rig.shinR.rotation.x = -Math.max(0, -Math.sin(wp)) * 0.12 * mv;
      // Circumduction: swing outward laterally to clear the floor
      rig.legR.rotation.z = -Math.max(0, -Math.sin(wp)) * 0.16 * mv;
      rig.legR.position.y = legBase + Math.max(0, Math.sin(wp)) * 2 * mv;

      // Heavy body lean toward the supporting cane / healthy side
      const limpLean = Math.sin(wp) * 0.14 * mv;
      rig.root.rotation.z = limpLean + 0.04 * idle; // slight permanent lean onto cane when idle
      rig.root.position.x = Math.sin(wp) * 4.2 * mv;

      // Antalgic limp hop
      const bob = Math.abs(Math.sin(wp)) * 7.5 * mv;
      rig.root.position.y = bob;

      // Left Arm: plants the walking cane down firmly in sync with left stride
      rig.armL.rotation.x = -Math.sin(wp) * 0.45 * mv - 0.25 + breathe * 0.04;
      rig.foreL.rotation.x = -0.45 - Math.max(0, Math.sin(wp)) * 0.25;
      rig.armL.rotation.z = 0.22;
    } else {
      // ---------------- AUTHENTIC ARTICULATED BIPEDAL GAIT ----------------
      rig.legL.rotation.x = sw;
      rig.legR.rotation.x = -sw;
      rig.legL.rotation.z = 0;
      rig.legR.rotation.z = 0;

      // Articulated Knee Flexion:
      // Knee flexes back during forward swing phase for foot clearance, straightens right before heel strike
      const kneeFlexL = Math.max(0, Math.sin(wp)) * 0.85 * mv;
      const kneeFlexR = Math.max(0, -Math.sin(wp)) * 0.85 * mv;
      rig.shinL.rotation.x = -kneeFlexL;
      rig.shinR.rotation.x = -kneeFlexR;

      // Stepping foot lifts off floor
      rig.legL.position.y = legBase + Math.max(0, -Math.sin(wp)) * 3.5 * mv;
      rig.legR.position.y = legBase + Math.max(0, Math.sin(wp)) * 3.5 * mv;

      // Pelvic sway & translation (smooth hip roll)
      rig.root.rotation.z = Math.sin(wp) * 0.045 * mv;
      rig.root.position.x = Math.sin(wp) * 1.5 * mv;

      // Bipedal vertical bobbing
      const bob = Math.abs(Math.sin(wp)) * 3.2 * mv;
      rig.root.position.y = bob;

      // Torso counter-twist: shoulders twist opposite to hips for human movement
      rig.torsoM.rotation.y = Math.sin(wp) * 0.16 * mv + Math.sin(rig.t * 0.9) * 0.03 * idle;

      // Head counter-stabilization: eyes stay locked forward
      rig.headM.rotation.y = -Math.sin(wp) * 0.10 * mv + Math.sin(rig.t * 0.8) * 0.05 * idle;
      rig.headM.rotation.z = -Math.sin(wp) * 0.04 * mv + Math.sin(rig.t * 1.3) * 0.04 * idle;
      rig.headM.rotation.x = -Math.sin(wp * 2) * 0.03 * mv + breathe * 0.02;

      // Left arm natural swing
      rig.armL.rotation.x = -sw * 0.85 + breathe * 0.04;
      rig.foreL.rotation.x = -0.32 - Math.abs(sw) * 0.35;
      rig.armL.rotation.z = 0.12 + Math.sin(rig.t * 1.7) * 0.03 * idle;

      // Secondary hair dynamics (female high ponytail bounce)
      if (rig.ponytail) {
        rig.ponytail.rotation.x = -0.35 + Math.sin(wp * 2) * 0.22 * mv + Math.sin(rig.t * 3) * 0.06 * idle;
        rig.ponytail.rotation.z = Math.sin(wp) * 0.18 * mv;
      }
    }

    const sy = 1 + breathe * 0.018 + (0.5 - Math.abs(Math.sin(wp))) * 0.06 * mv; // squash and stretch
    rig.root.scale.set(1 / Math.sqrt(sy), sy, 1 / Math.sqrt(sy));

    // right arm + hammer: carried raised over the shoulder, wound up, slammed down in front, then lifted again.
    // (The boss has no hammer: it keeps the old low guard and the punch.)
    const eo = (t) => 1 - (1 - t) * (1 - t);
    const ei = (t) => t * t;
    const lerp = (x, y, t) => x + (y - x) * t;
    const skill = isBoss || p.mini ? 'boss' : (isMe ? S.skill : p.skill) === 'milkTea' ? 'milkTea' : (isMe ? S.skill : p.skill) === 'electric' ? 'electric' : 'hammer';
    if (!isBoss) rig.hammer.visible = !p.mini && skill === 'hammer';
    const armed = rig.hammer.visible;
    // the ultimate: whatever is in the hand swells for a moment
    const giantTarget = (p.ultUntil || 0) > performance.now() ? 3.2 : 1;
    rig.giant = (rig.giant || 1) + (giantTarget - (rig.giant || 1)) * Math.min(1, dt * (giantTarget > 1 ? 14 : 6));
    rig.hammer.scale.setScalar(0.82 * rig.giant);
    rig.cup.scale.setScalar(rig.giant);
    rig.taser.scale.setScalar(rig.giant);
    const CARRY = -0.12; // at rest: the arm hangs naturally at the side
    let a = armed ? CARRY + sw * 0.2 + breathe * 0.03 : -0.35 + sw * 0.55 + breathe * 0.04;
    let lean = 0.1 * mv;
    let hk = 0; // 0 hammer upright, 1 hammer along the arm
    if (p.swing > 0) {
      const ph = 1 - p.swing; // 0..1 over the swing
      if (armed) {
        hk = ph < 0.2 ? eo(ph / 0.2) : ph < 0.5 ? 1 : 1 - eo((ph - 0.5) / 0.5);
        if (ph < 0.25) {
          a = lerp(CARRY, -3.1, eo(ph / 0.25)); // wind up: the hammer goes high and back
          lean += -0.25 * (ph / 0.25);
        } else if (ph < 0.45) {
          const t = ei((ph - 0.25) / 0.2);
          a = lerp(-3.1, -1.05, t); // slam
          lean += lerp(-0.25, 0.32, t);
        } else {
          const t = eo((ph - 0.45) / 0.55);
          a = lerp(-1.05, CARRY, t); // lift it back up
          lean += 0.32 * (1 - t);
        }
      } else {
        if (ph < 0.35) a = -0.35 - (ph / 0.35) * 2.0;
        else if (ph < 0.6) a = -2.35 + ((ph - 0.35) / 0.25) * 3.1;
        else a = 0.75 - ((ph - 0.6) / 0.4) * 1.1;
        lean += ph > 0.35 && ph < 0.6 ? 0.28 : ph <= 0.35 ? -0.12 * (ph / 0.35) : 0;
      }
    }
    // the hammer lands: dust on the floor in front, and a small shake for our own screen
    if (armed && (rig.prevSwing || 0) > 0.55 && p.swing <= 0.55) {
      fxDust(p.x + Math.sin(p.heading) * 64, p.y + Math.cos(p.heading) * 64);
      if (isMe) S.shake = Math.min(1.4, S.shake + 0.2);
    }
    rig.prevSwing = p.swing;
    rig.root.rotation.x = lean;
    rig.armR.rotation.x = a;
    rig.armR.rotation.z = -0.58 - Math.abs(sw) * 0.1; // the fist held out a little, so the hammer stays clear of the head
    // Elbow: a relaxed bend at rest, straight for the swing. The hammer's own rotation cancels the arm's, so it stays
    // "held up" in the body's frame whatever the arm does, and blends to "along the arm" for the swing.
    rig.foreR.rotation.x = armed ? lerp(-0.8, -0.2, hk) : -0.2;
    if (p.mini && p.swing <= 0) {
      // no hammer in this fist: hang it exactly like the left arm (mirrored), instead of held out to clear a hammer
      rig.armR.rotation.x = sw * 0.95 + breathe * 0.05;
      rig.armR.rotation.z = -(0.14 + Math.sin(rig.t * 1.7) * 0.03 * idle + Math.abs(sw) * 0.12);
      rig.foreR.rotation.x = -0.3 - Math.abs(sw) * 0.4;
    } else if (p.mini) rig.armR.rotation.z = -0.14; // and in a punch it comes from the side, not from out in the air
    if (skill === 'milkTea' || skill === 'electric') {
      // Other skills hold something else in the same fist. The cup is carried up in front of the chest; a throw winds
      // up over the shoulder, snaps forward and lets go (the cup that flies is drawn by the effect, so the one in the
      // hand disappears for a moment). The stun gun points forward and jabs straight out.
      const ph = p.swing > 0 ? 1 - p.swing : -1; // -1 = not swinging
      let bend;
      let q;
      if (skill === 'milkTea') {
        a = -0.7;
        bend = -1.9;
        lean = 0.1 * mv;
        if (ph >= 0) {
          if (ph < 0.3) {
            const t = eo(ph / 0.3);
            a = lerp(-0.7, -2.9, t);
            bend = lerp(-1.9, -0.7, t);
            lean += -0.2 * t;
          } else if (ph < 0.45) {
            const t = ei((ph - 0.3) / 0.15);
            a = lerp(-2.9, -1.3, t);
            bend = lerp(-0.7, -0.1, t);
            lean += lerp(-0.2, 0.25, t);
          } else {
            const t = eo((ph - 0.45) / 0.55);
            a = lerp(-1.3, -0.7, t);
            bend = lerp(-0.1, -1.9, t);
            lean += 0.25 * (1 - t);
          }
        }
        rig.cup.visible = ph < 0 || ph < 0.42 || ph > 0.8; // released at the snap, a fresh cup in hand a moment later
        q = _heldCup;
      } else {
        a = -0.5;
        bend = -1.5;
        lean = 0.1 * mv;
        if (ph >= 0) {
          if (ph < 0.25) {
            const t = eo(ph / 0.25);
            a = lerp(-0.5, -0.2, t);
            bend = lerp(-1.5, -2.1, t); // pull the gun back
          } else if (ph < 0.45) {
            const t = ei((ph - 0.25) / 0.2);
            a = lerp(-0.2, -1.45, t);
            bend = lerp(-2.1, -0.1, t); // jab it straight out
            lean += 0.2 * t;
          } else {
            const t = eo((ph - 0.45) / 0.55);
            a = lerp(-1.45, -0.5, t);
            bend = lerp(-0.1, -1.5, t);
            lean += 0.2 * (1 - t);
          }
        }
        q = _heldTaser;
      }
      rig.cup.visible = skill === 'milkTea' && rig.cup.visible;
      rig.taser.visible = skill === 'electric';
      rig.root.rotation.x = lean;
      rig.armR.rotation.x = a;
      rig.armR.rotation.z = -0.3;
      rig.foreR.rotation.x = bend;
      const item = skill === 'milkTea' ? rig.cup : rig.taser;
      _qa.copy(rig.armR.quaternion).multiply(rig.foreR.quaternion);
      item.quaternion.copy(_qa.invert()).multiply(q); // stays "up" (cup) or "forward" (gun) in the body's frame
      // The shot leaves the hand at the moment of the throw / jab (not from the middle of the body when the swing starts):
      // game.js leaves the target in p.fxShot, this fires it once the animation reaches the release point.
      if (p.fxShot) {
        const releaseAt = p.fxShot.skill === 'milkTea' ? 0.42 : 0.45;
        if ((p.swing > 0 ? 1 - p.swing : 1) >= releaseAt) {
          rig.g.updateMatrixWorld(true);
          const milk = p.fxShot.skill === 'milkTea';
          _hand.set(0, milk ? 6 : 33, 0); // the cup's middle, or the gun's prongs
          (milk ? rig.cup : rig.taser).localToWorld(_hand);
          if (milk) fxMilkTea(_hand.x, _hand.z, p.fxShot.tx, p.fxShot.ty, _hand.y);
          else fxElectric(_hand.x, _hand.z, p.fxShot.tx, p.fxShot.ty, _hand.y);
          p.fxShot = null;
        }
      }
    } else {
      rig.cup.visible = false;
      rig.taser.visible = false;
      p.fxShot = null;
    }
    if (armed) {
      _qa.copy(rig.armR.quaternion).multiply(rig.foreR.quaternion);
      _qb.copy(_qa).multiply(_hammerAlongArm);
      _qc.slerpQuaternions(_hammerHeld, _qb, hk);
      rig.hammer.quaternion.copy(_qa.invert()).multiply(_qc);
    }

    // Knocked out: whole connected body collapses smoothly onto floor
    rig.lie += ((p.dead ? 1 : 0) - rig.lie) * Math.min(1, dt * 8);
    if (rig.lie > 0.001 || p.dead) {
      const lie = rig.lie;
      rig.root.rotation.x = -1.48 * lie; // collapse flat on back
      rig.root.rotation.y = 0;
      rig.root.rotation.z = 0.12 * lie;
      rig.root.position.y = 3.5 * lie; // flush with floor surface
      rig.root.position.z = -18.0 * lie;
      // Relax limbs on ground
      rig.legL.rotation.x = 0;
      rig.legR.rotation.x = 0;
      rig.legL.rotation.z = -0.12 * lie; // feet naturally turned outward
      rig.legR.rotation.z = 0.12 * lie;
      rig.legL.position.y = legBase;
      rig.legR.position.y = legBase;
      rig.shinL.rotation.x = 0;
      rig.shinR.rotation.x = 0;
      rig.armL.rotation.x = 0.15 * lie;
      rig.armR.rotation.x = 0.15 * lie;
      rig.armL.rotation.z = 0.38 * lie;
      rig.armR.rotation.z = -0.38 * lie;
      rig.foreL.rotation.x = -0.05 * lie;
      rig.foreR.rotation.x = -0.05 * lie;
      if (rig.hammer) rig.hammer.visible = false;
      if (rig.cup) rig.cup.visible = false;
      if (rig.taser) rig.taser.visible = false;
    }
    const hf = p.dead ? 0 : p.hpFrac == null ? 1 : p.hpFrac;
    if (Math.abs(hf - rig.lastHp) > 0.004) {
      rig.lastHp = hf;
      rig.hpf.style.transform = 'scaleX(' + Math.max(0, Math.min(1, hf)).toFixed(3) + ')';
      rig.hpf.className = hf < 0.25 ? 'low' : hf < 0.55 ? 'mid' : '';
    }
    if (rig.hpt && p.hpLabel !== rig.lastHpLabel) {
      rig.lastHpLabel = p.hpLabel;
      rig.hpt.textContent = p.hpLabel || '';
    }
    rig.hpb.style.display = p.alwaysHp || (!p.dead && hf < 0.999) ? '' : 'none';
    rig.label.classList.toggle('down', !!p.dead);
    rig.label.classList.toggle('shielded', !p.dead && performance.now() < (p.shieldUntil || 0));

    rig.ring.visible = isMe;
    if (rig.lastName !== p.name) {
      rig.nm.textContent = p.name;
      rig.lastName = p.name;
    }
    if (rig.lastRole !== p.role || rig.lastCompany !== p.company) {
      rig.lastRole = p.role;
      rig.lastCompany = p.company;
      const r = ROLE_BY_ID[p.role];
      const parts = [];
      if (r) parts.push(r.emoji + ' ' + r.short);
      if (p.company) parts.push(p.company);
      rig.rl.textContent = parts.join(' · ');
    }
    const em = p.dead ? '💀' : p.emoteT > 0 && p.emote ? p.emote : '';
    if (em !== rig.lastEmote) {
      rig.emo.textContent = em;
      rig.lastEmote = em;
    }
    const ch = p.chatT > 0 && p.chat ? p.chat : '';
    if (ch !== rig.lastChat) {
      rig.bub.textContent = ch;
      rig.lastChat = ch;
    }
    rig.label.classList.toggle('me', isMe);
    rig.bar.style.display = isMe ? '' : 'none';
    if (isMe) {
      const f = Math.max(0, Math.min(1, S.manaFrac == null ? 1 : S.manaFrac));
      rig.fill.style.transform = 'scaleX(' + f.toFixed(3) + ')';
      rig.bar.classList.toggle('low', f < 0.2);
      rig.bar.classList.toggle('flash', S.manaEmptyT > 0);
    }
  }

  function disposePlayer(rig) {
    // Player rigs allocate their own geometry (including accessories and pick proxies).
    // Materials on the body/accessories are shared; only these private materials belong
    // to the rig. Keep both sets deduplicated when effects are attached under the torso.
    const geometries = new Set();
    const materials = new Set(rig.ownedMaterials);
    rig.g.traverse(o => { if (o.geometry) geometries.add(o.geometry); });
    if (rig.electricFx) {
      for (const mesh of [rig.electricFx.outline, rig.electricFx.arcs]) materials.add(mesh.material);
    }
    scene.remove(rig.g);
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    rig.label.remove();
  }

  // ---- particles ----------------------------------------------------------
  const MAXD = 520;
  const debrisMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9 }), MAXD);
  debrisMesh.frustumCulled = false;
  debrisMesh.castShadow = !coarse; // tiny airborne fragments do not need a second draw pass on phones
  debrisMesh.count = 0;
  debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const dZero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < MAXD; i++) {
    debrisMesh.setMatrixAt(i, dZero);
    debrisMesh.setColorAt(i, new THREE.Color(0xffffff));
  }
  debrisMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  scene.add(debrisMesh);
  const D = Array.from({ length: MAXD }, () => ({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, vr: 0, s: 1, color: new THREE.Color(0xffffff) }));
  let dNext = 0;

  const MAXS = 300;
  const sparkGeo = new THREE.BufferGeometry();
  const sparkPos = new Float32Array(MAXS * 3).fill(-9999);
  const sparkCol = new Float32Array(MAXS * 3);
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkCol, 3));
  const glowTex = makeCanvasTexture(64, 64, (ctx, w, h) => soft(ctx, w, h, [[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,.55)'], [1, 'rgba(255,255,255,0)']]));
  const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ size: 14, map: glowTex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  sparks.frustumCulled = false;
  scene.add(sparks);
  const S_ = Array.from({ length: MAXS }, () => ({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, c: [1, 1, 1] }));
  let sNext = 0;

  const puffTex = makeCanvasTexture(64, 64, (ctx, w, h) => soft(ctx, w, h, [[0, 'rgba(255,255,255,.9)'], [0.6, 'rgba(255,255,255,.35)'], [1, 'rgba(255,255,255,0)']]));
  const MAXP = 56;
  const puffs = [];
  for (let i = 0; i < MAXP; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, color: 0x9aa0ab, transparent: true, depthWrite: false, opacity: 0 }));
    sp.visible = false;
    sp.userData = { life: 0, max: 1, vx: 0, vy: 0, vz: 0, s: 20 };
    scene.add(sp);
    puffs.push(sp);
  }
  let pNext = 0;

  const rand = (a, b) => a + Math.random() * (b - a);

  function fxDebris(x, y, z, n, colors) {
    for (let i = 0; i < n; i++) {
      const d = D[dNext];
      dNext = (dNext + 1) % MAXD;
      const a = Math.random() * Math.PI * 2;
      const sp = rand(90, 340);
      Object.assign(d, {
        paper: false, life: rand(1.0, 1.9), max: 1.9, x: x + rand(-10, 10), y: y + rand(4, 24), z: z + rand(-10, 10),
        vx: Math.cos(a) * sp, vy: rand(180, 460), vz: Math.sin(a) * sp,
        rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6, vr: rand(-10, 10), s: rand(4, 11),
      });
      d.color.set(colors[Math.floor(Math.random() * colors.length)]);
    }
  }
  function fxSparks(x, y, z, n) {
    const cols = [[1, 0.83, 0.3], [1, 0.62, 0.18], [1, 0.95, 0.7]];
    for (let i = 0; i < n; i++) {
      const s = S_[sNext];
      sNext = (sNext + 1) % MAXS;
      const a = Math.random() * Math.PI * 2;
      const sp = rand(120, 380);
      Object.assign(s, {
        life: rand(0.3, 0.65), max: 0.65, x, y, z,
        vx: Math.cos(a) * sp, vy: rand(80, 320), vz: Math.sin(a) * sp, c: cols[i % 3],
      });
    }
  }
  // a ring of dust where the hammer lands
  function fxDust(x, z, n = 9) {
    for (let i = 0; i < n; i++) {
      const sp = puffs[pNext];
      pNext = (pNext + 1) % MAXP;
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const v = rand(50, 130);
      sp.visible = true;
      sp.position.set(x + Math.cos(a) * 8, 5, z + Math.sin(a) * 8);
      Object.assign(sp.userData, { life: rand(0.45, 0.8), max: 0.8, vx: Math.cos(a) * v, vy: rand(14, 42), vz: Math.sin(a) * v, s: rand(14, 24) });
    }
  }
  function fxProcess(x, z, radius) {
    for (let i = 0; i < 36; i++) {
      const index = dNext;
      fxDebris(x + rand(-radius * 0.65, radius * 0.65), rand(120, 220), z + rand(-radius * 0.65, radius * 0.65), 1, ['#ffffff', '#ddc9ff', '#a86dff']);
      const paper = D[index];
      paper.paper = true;
      paper.vy = rand(-100, -30);
      paper.vx *= 0.15;
      paper.vz *= 0.15;
      paper.life = paper.max = 1.4;
      paper.s = rand(12, 20);
    }
  }
  // Reused spell rings and ropes keep the mobile renderer bounded, without extra lights.
  const spellRings = Array.from({ length: 16 }, () => {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 48), new THREE.MeshBasicMaterial({ color: 0x79ed9b, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    mesh.rotation.x = -Math.PI / 2; mesh.visible = false; scene.add(mesh);
    return { mesh, life: 0 };
  });
  let ringNext = 0;
  function spellRing(x, z, color, radius, life, rise = 0) {
    const ring = spellRings[ringNext++ % spellRings.length];
    Object.assign(ring, { life, max: life, radius, rise });
    ring.mesh.material.color.set(color); ring.mesh.material.opacity = 0.85;
    ring.mesh.position.set(x, 4, z); ring.mesh.visible = true;
  }
  function fxSummon(x, z) {
    for (let i = 0; i < 3; i++) spellRing(x, z, i % 2 ? '#d1ff80' : '#53ec93', 70 + i * 32, 1.3 + i * 0.15, 100 + i * 45);
    fxDebris(x, 100, z, 22, ['#54dc87', '#caff83', '#25865b']);
    floatText(x, 260, z, 'TRIỆU HỒI RẮN', '#aaff9d', 22);
  }
  function fxDuelCast(x, z) {
    for (let i = 0; i < 3; i++) spellRing(x, z, '#ffc265', 90 + i * 55, 0.8 + i * 0.12, 25);
    floatText(x, 260, z, 'ĐẤU 1:1!', '#ffd38a', 24);
  }
  function fxBlow(x, z, tx, tz) {
    spellRing(x, z, '#d5f6ff', 65, 0.6, 60);
    // A short trail follows the direction of the gust.
    for (let i = 0; i < 8; i++) {
      const t = i / 8;
      fxSmoke(x + (tx - x) * t, 20 + t * 35, z + (tz - z) * t);
    }
  }
  const ropeGeometry = new THREE.CylinderGeometry(2.2, 2.2, 1, 6);
  const ropeMaterial = new THREE.MeshBasicMaterial({ color: 0xffc16a });
  const ropes = Array.from({ length: 4 }, () => {
    const group = new THREE.Group();
    for (let i = 0; i < 16; i++) group.add(new THREE.Mesh(ropeGeometry, ropeMaterial));
    group.visible = false; scene.add(group);
    return { group, life: 0 };
  });
  let ropeNext = 0;
  function fxRope(x, z, fromX, fromZ, tx, tz, duration) {
    const rope = ropes[ropeNext++ % ropes.length];
    Object.assign(rope, { life: duration, max: duration, x, z, fromX, fromZ, tx, tz });
    rope.group.visible = true;
  }
  const ropeStart = new THREE.Vector3(), ropeEnd = new THREE.Vector3(), ropeDirection = new THREE.Vector3();
  const ropeUp = new THREE.Vector3(0, 1, 0);
  // Door placement comes from the shared world, never unscaled map coordinates.
  const duelGate = new THREE.Group(); duelGate.name='duelGate';
  const gateGeo=new THREE.BoxGeometry(1,1,1);
  const gateRed=new THREE.MeshBasicMaterial({color:0xff493c});
  const gateAmber=new THREE.MeshBasicMaterial({color:0xffce63});
  const gateParts=[];
  for(const [y,z,height,width,material] of [
    [90,-.5,180,.065,gateAmber],[90,.5,180,.065,gateAmber],
    [38,0,14,1,gateRed],[90,0,14,1,gateRed],[142,0,14,1,gateRed],
    [90,-.25,130,.045,gateAmber],[90,.25,130,.045,gateAmber],
  ]) {
    const mesh=new THREE.Mesh(gateGeo,material);mesh.position.y=y;mesh.scale.set(14,height,1);
    gateParts.push({mesh,z,width});duelGate.add(mesh);
  }
  duelGate.visible=false;scene.add(duelGate);
  const duelFloor=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial({color:0xff493c,transparent:true,opacity:.065,depthWrite:false,side:THREE.DoubleSide}));
  duelFloor.rotation.x=-Math.PI/2;duelFloor.visible=false;scene.add(duelFloor);
  const duelBorder=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-.5,0,-.5),new THREE.Vector3(.5,0,-.5),new THREE.Vector3(.5,0,.5),new THREE.Vector3(-.5,0,.5),
  ]),new THREE.LineBasicMaterial({color:0xffba55,transparent:true,opacity:.9,depthWrite:false}));
  duelBorder.visible=false;scene.add(duelBorder);
  const duelGateLabel=document.createElement('div');duelGateLabel.className='duel-gate-label';
  duelGateLabel.hidden=true;duelGateLabel.setAttribute('aria-hidden','true');labelsEl.appendChild(duelGateLabel);
  const duelMark = new THREE.Mesh(new THREE.RingGeometry(27, 32, 40), new THREE.MeshBasicMaterial({ color: 0xffb02e, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  duelMark.rotation.x = -Math.PI / 2; duelMark.visible = false; scene.add(duelMark);
  function updateSpells(dt, S) {
    for (const ring of spellRings) {
      if (ring.life <= 0) continue;
      ring.life = Math.max(0, ring.life - dt);
      const t = 1 - ring.life / ring.max;
      ring.mesh.visible = ring.life > 0;
      ring.mesh.scale.setScalar(ring.radius * (0.4 + t * 1.4));
      ring.mesh.position.y = 4 + t * ring.rise;
      ring.mesh.material.opacity = (1 - t) * 0.85;
    }
    for (const rope of ropes) {
      if (rope.life <= 0) continue;
      rope.life = Math.max(0, rope.life - dt); rope.group.visible = rope.life > 0;
      const t = 1 - rope.life / rope.max;
      const eased = t * t * (3 - 2 * t);
      const tx = rope.fromX + (rope.tx - rope.fromX) * eased, tz = rope.fromZ + (rope.tz - rope.fromZ) * eased;
      const extension = Math.min(1, t / 0.2);
      const ex = rope.x + (tx - rope.x) * extension, ez = rope.z + (tz - rope.z) * extension;
      for (let i = 0; i < rope.group.children.length; i++) {
        const a = i / 16, b = (i + 1) / 16;
        ropeStart.set(rope.x + (ex - rope.x) * a, 135 - 90 * a + Math.sin(a * Math.PI) * 35 * (1 - t), rope.z + (ez - rope.z) * a);
        ropeEnd.set(rope.x + (ex - rope.x) * b, 135 - 90 * b + Math.sin(b * Math.PI) * 35 * (1 - t), rope.z + (ez - rope.z) * b);
        const mesh = rope.group.children[i];
        mesh.position.copy(ropeStart).add(ropeEnd).multiplyScalar(0.5);
        ropeDirection.subVectors(ropeEnd, ropeStart);
        mesh.scale.y = ropeDirection.length();
        mesh.quaternion.setFromUnitVectors(ropeUp, ropeDirection.normalize());
      }
    }
    const active = S.duel?.target && performance.now() < S.duel.until && !S.boss?.dead;
    const door=S.world?.duelDoor, bounds=S.duel?.bounds;
    duelGate.visible=!!(active&&door);
    duelFloor.visible=duelBorder.visible=!!(active&&bounds);
    if (active&&bounds) {
      const width=bounds.x1-bounds.x0,depth=bounds.y1-bounds.y0;
      duelFloor.scale.set(width,depth,1);duelFloor.position.set((bounds.x0+bounds.x1)/2,4,(bounds.y0+bounds.y1)/2);
      duelBorder.scale.set(width,1,depth);duelBorder.position.set(duelFloor.position.x,5,duelFloor.position.z);
    }
    if(active&&door) {
      duelGate.position.set(door.x,0,door.y);duelGate.rotation.y=door.axis==='x'?Math.PI/2:0;
      for(const part of gateParts){part.mesh.position.z=part.z*door.width;part.mesh.scale.z=part.width*door.width;}
      const projected=project(door.x,215,door.y);
      duelGateLabel.hidden=!(projected.ok&&projected.sx>-120&&projected.sx<W+120&&projected.sy>0&&projected.sy<H);
      const text='🔒 PHÒNG KHÓA · '+Math.max(0,Math.ceil((S.duel.until-performance.now())/1000))+'s';
      if(duelGateLabel.textContent!==text)duelGateLabel.textContent=text;
      duelGateLabel.style.transform='translate('+projected.sx.toFixed(1)+'px,'+projected.sy.toFixed(1)+'px) translate(-50%,-100%)';
    } else duelGateLabel.hidden=true;
    duelMark.visible = !!active;
    if (active) {
      duelBorder.material.opacity = .8 + Math.sin(time * 3) * .1;
      const p = S.players.get(S.duel.target);
      duelMark.visible = !!p && !p.dead;
      if (p) duelMark.position.set(p.x, 5, p.y);
    }
  }

  function fxSmoke(x, y, z) {
    const sp = puffs[pNext];
    pNext = (pNext + 1) % MAXP;
    sp.visible = true;
    sp.position.set(x + rand(-10, 10), y, z + rand(-10, 10));
    Object.assign(sp.userData, { life: rand(1.1, 1.8), max: 1.8, vx: rand(-12, 12), vy: rand(34, 60), vz: rand(-12, 12), s: rand(16, 26) });
  }

  const eul = new THREE.Euler();
  const quat = new THREE.Quaternion();
  const mtx = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  // Reuse a bounded pool of code-built cups, even while everyone holds Space.
  const teaGeo = merge([
    cyl(9, 6, 23, 0xc58d62), cyl(10, 10, 3, 0xffe6d0, 0, 13),
    cyl(1.5, 1.5, 20, 0xf57ca2, 3, 24),
    ...[-4, 0, 4].map(x => sph(2, 0x352321, x, -6, 5)),
  ]);
  const teaCups = Array.from({ length: 32 }, () => {
    const mesh = new THREE.Mesh(teaGeo, bodyMat);
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, life: 0, x: 0, z: 0, tx: 0, tz: 0 };
  });
  let teaNext = 0;
  function fxMilkTea(x, z, tx, tz, y = 65) {
    const cup = teaCups[teaNext];
    teaNext = (teaNext + 1) % teaCups.length;
    Object.assign(cup, { life: 0.3, x, z, tx, tz, y0: y });
    cup.mesh.position.set(x, y, z);
    cup.mesh.rotation.set(0, 0, 0);
    cup.mesh.visible = true;
  }

  // Short-lived branching arcs: bounded buffers and no extra lights or post-processing.
  const electricArcs = Array.from({ length: 24 }, () => {
    const positions = new Float32Array(3 * 8 * 2 * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color: 0x9bf5ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.LineSegments(geometry, material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { mesh, positions, life: 0, x: 0, z: 0, tx: 0, tz: 0 };
  });
  let electricNext = 0;
  function fxElectric(x, z, tx, tz, y = 65) {
    const arc = electricArcs[electricNext];
    electricNext = (electricNext + 1) % electricArcs.length;
    Object.assign(arc, { life: 0.25, x, z, tx, tz, y0: y });
    // Fill its reused buffer on the next update before making it visible.
    arc.mesh.visible = false;
    fxSparks(tx, 45, tz, 5);
  }

  function updateParticles(dt) {
    for (const arc of electricArcs) {
      if (arc.life <= 0) continue;
      arc.life = Math.max(0, arc.life - dt);
      arc.mesh.visible = arc.life > 0;
      if (!arc.life) continue;
      let offset = 0;
      for (let branch = 0; branch < 3; branch++) {
        let px = arc.x, py = arc.y0, pz = arc.z;
        for (let segment = 1; segment <= 8; segment++) {
          const t = segment / 8;
          const jitter = segment === 8 ? 0 : 12;
          const x = arc.x + (arc.tx - arc.x) * t + rand(-jitter, jitter);
          const y = arc.y0 + (45 - arc.y0) * t + rand(-jitter, jitter);
          const z = arc.z + (arc.tz - arc.z) * t + rand(-jitter, jitter);
          arc.positions.set([px, py, pz, x, y, z], offset);
          offset += 6;
          px = x; py = y; pz = z;
        }
      }
      arc.mesh.geometry.attributes.position.needsUpdate = true;
      arc.mesh.material.opacity = Math.min(1, arc.life / 0.1);
    }

    for (const cup of teaCups) {
      if (cup.life <= 0) continue;
      cup.life = Math.max(0, cup.life - dt);
      const t = 1 - cup.life / 0.3;
      cup.mesh.position.set(cup.x + (cup.tx - cup.x) * t, cup.y0 + (35 - cup.y0) * t + Math.sin(t * Math.PI) * 45, cup.z + (cup.tz - cup.z) * t);
      cup.mesh.rotation.z = t * Math.PI * 2;
      if (cup.life === 0) {
        cup.mesh.visible = false;
        fxDebris(cup.tx, 35, cup.tz, 12, ['#c58d62', '#ffe6d0', '#352321']);
      }
    }

    let liveDebris = 0;
    for (let i = 0; i < MAXD; i++) {
      const d = D[i];
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life <= 0) continue;
      d.vy -= (d.paper ? 180 : 950) * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      if (d.y < d.s / 2) {
        d.y = d.s / 2;
        d.vy *= -0.35;
        d.vx *= 0.7;
        d.vz *= 0.7;
        d.vr *= 0.6;
      }
      d.rx += d.vr * dt;
      d.rz += d.vr * 0.6 * dt;
      const k = Math.min(1, d.life / 0.5) * d.s;
      eul.set(d.rx, d.ry, d.rz);
      quat.setFromEuler(eul);
      pos.set(d.x, d.y, d.z);
      scl.set(k, k * (d.paper ? 0.06 : 0.7), d.paper ? k * 0.72 : k);
      mtx.compose(pos, quat, scl);
      debrisMesh.setMatrixAt(liveDebris, mtx);
      debrisMesh.setColorAt(liveDebris, d.color);
      liveDebris++;
    }
    debrisMesh.count = liveDebris;
    debrisMesh.visible = liveDebris > 0;
    if (liveDebris) {
      debrisMesh.instanceMatrix.clearUpdateRanges();
      debrisMesh.instanceMatrix.addUpdateRange(0, liveDebris * 16);
      debrisMesh.instanceColor.clearUpdateRanges();
      debrisMesh.instanceColor.addUpdateRange(0, liveDebris * 3);
      debrisMesh.instanceMatrix.needsUpdate = true;
      debrisMesh.instanceColor.needsUpdate = true;
    }

    let sd = false;
    for (let i = 0; i < MAXS; i++) {
      const s = S_[i];
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) {
        sparkPos[i * 3 + 1] = -9999;
        sd = true;
        continue;
      }
      s.vy -= 600 * dt;
      s.x += s.vx * dt;
      s.y = Math.max(1, s.y + s.vy * dt);
      s.z += s.vz * dt;
      const f = s.life / s.max;
      sparkPos[i * 3] = s.x;
      sparkPos[i * 3 + 1] = s.y;
      sparkPos[i * 3 + 2] = s.z;
      sparkCol[i * 3] = s.c[0] * f;
      sparkCol[i * 3 + 1] = s.c[1] * f;
      sparkCol[i * 3 + 2] = s.c[2] * f;
      sd = true;
    }
    if (sd) {
      sparkGeo.attributes.position.needsUpdate = true;
      sparkGeo.attributes.color.needsUpdate = true;
    }

    for (const sp of puffs) {
      const u = sp.userData;
      if (!sp.visible) continue;
      u.life -= dt;
      if (u.life <= 0) {
        sp.visible = false;
        continue;
      }
      sp.position.x += u.vx * dt;
      sp.position.y += u.vy * dt;
      sp.position.z += u.vz * dt;
      const f = u.life / u.max;
      sp.material.opacity = f * 0.5;
      const s = u.s * (1.6 - f * 0.6);
      sp.scale.set(s, s, 1);
    }
  }

  // ---- floating texts (DOM, pinned to a 3D point) --------------------------
  const texts = [];
  function floatText(x, y, z, text, color, size) {
    const el = document.createElement('div');
    el.className = 'ftext';
    el.textContent = text;
    el.style.color = color;
    el.style.fontSize = size + 'px';
    labelsEl.appendChild(el);
    texts.push({ el, x, y, z, life: 1.2, max: 1.2 });
    while (texts.length > 40) texts.shift().el.remove();
  }

  // Hidden effects otherwise compile their programs on the first hammer impact.
  // compileAsync uses parallel shader compilation where the driver supports it.
  const effectPrograms = new THREE.Group();
  const warmPuff = puffs[0].clone();
  warmPuff.visible = true;
  warmPuff.frustumCulled = false;
  warmPuff.material = puffs[0].material.clone(); // opacity stays zero, so the warmup never paints a puff
  effectPrograms.add(debrisMesh.clone(), sparks.clone(), warmPuff);
  effectPrograms.visible = false;
  let warmedQuality = null;
  function warmEffects() {
    if (warmedQuality === quality) return;
    warmedQuality = quality;
    renderer.compileAsync(effectPrograms, camera, scene).then(() => {
      // A transparent first draw also initializes uniforms/textures; compile alone leaves
      // driver queries deferred until the first real hit on some WebGL implementations.
      effectPrograms.visible = true;
      scene.add(effectPrograms);
    }).catch(() => {
      warmedQuality = null; // rendering still works; a later quality change can retry
    });
  }
  ready.then(warmEffects);

  // ---- projection ---------------------------------------------------------
  const v3 = new THREE.Vector3();
  let W = 1;
  let H = 1;
  function project(x, y, z) {
    v3.set(x, y, z).project(camera);
    return { sx: (v3.x * 0.5 + 0.5) * W, sy: (-v3.y * 0.5 + 0.5) * H, ok: v3.z < 1 && v3.z > -1 };
  }

  // ---- health bars over damaged objects -------------------------------------
  // Green while healthy, orange once half gone, red on the last hit. Undamaged and broken objects show none.
  const BAR_LIFT = { laptop: 48, monitor: 74, chair: 80, printer: 76, cooler: 122, coffee: 92, server: 168, plant: 88, desk: 78, tv: 112, toilet: 72, sink: 72, safe: 74, bookcase: 200, lamp: 200, trash: 70, coatrack: 150, fridge: 86, speaker: 110, sofa: 80, table: 80, conference: 80 };
  const hpBars = new Map(); // object id -> { el, fill, tone, ratio }
  function hpTone(hp, max) {
    const r = hp / max;
    if (hp <= 1 || r <= 0.34) return 'hot';
    return r <= 0.6 ? 'warm' : 'cool';
  }
  function updateHealthBars(S) {
    for (const o of S.objects) {
      const damaged = !o.broken && o.hp > 0 && o.hp < o.hpMax;
      let b = hpBars.get(o.id);
      if (!damaged) {
        if (b && !b.hidden) {
          b.el.style.display = 'none';
          b.hidden = true;
        }
        continue;
      }
      const rg = rigs.get(o.id);
      const dropped = rg ? lift(o.type) - rg.group.position.y : 0; // a screen that fell with its desk
      const pr = project(o.x, (rg?.barLift || BAR_LIFT[o.type] || 70) - dropped, o.y);
      const on = pr.ok && pr.sx > -60 && pr.sx < W + 60 && pr.sy > -30 && pr.sy < H + 30;
      if (!b) {
        const el = document.createElement('div');
        el.className = 'hpbar';
        el.setAttribute('aria-hidden', 'true');
        el.style.display = 'none'; // shown below once it is on screen and positioned
        const fill = document.createElement('i');
        el.appendChild(fill);
        labelsEl.appendChild(el);
        b = { el, fill, tone: '', ratio: -1, hidden: true };
        hpBars.set(o.id, b);
      }
      if (!on) {
        if (!b.hidden) {
          b.el.style.display = 'none';
          b.hidden = true;
        }
        continue;
      }
      if (b.hidden) {
        b.el.style.display = '';
        b.hidden = false;
      }
      const ratio = o.hp / o.hpMax;
      if (ratio !== b.ratio) {
        b.ratio = ratio;
        b.fill.style.transform = 'scaleX(' + ratio.toFixed(3) + ')';
      }
      const tone = hpTone(o.hp, o.hpMax);
      if (tone !== b.tone) {
        b.tone = tone;
        b.el.className = 'hpbar ' + tone;
      }
      b.el.style.transform = 'translate(' + pr.sx.toFixed(1) + 'px,' + pr.sy.toFixed(1) + 'px) translate(-50%,-100%)';
    }
  }

  // ---- per-frame ----------------------------------------------------------
  let time = 0;
  // Shadow box fitted to the view (see update). Scratch objects are reused: this runs every frame.
  const SHADOW_MARGIN = 220; // the tallest walls (280) throw shadows about 170 long; a little extra for safety
  const fitRay = new THREE.Raycaster();
  const fitNdc = new THREE.Vector2();
  const fitHit = new THREE.Vector3();
  const fitGround = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const fitView = new THREE.Matrix4();
  const fitPts = [];
  for (let i = 0; i < 8; i++) fitPts.push(new THREE.Vector3());
  let fitKey = '';
  function fitShadowBox() {
    camera.updateMatrixWorld();
    let n = 0;
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      fitNdc.set(x, y);
      fitRay.setFromCamera(fitNdc, camera);
      // a corner above the horizon (never with this camera, but be safe) is clamped to a far ground point
      if (!fitRay.ray.intersectPlane(fitGround, fitHit) || fitHit.distanceTo(camera.position) > 6000) fitRay.ray.at(6000, fitHit);
      fitPts[n++].set(fitHit.x, 0, fitHit.z);
      fitPts[n++].set(fitHit.x, 160, fitHit.z); // the tops of furniture standing at the edge of the view
    }
    // light space: the shadow camera sits at the sun and looks at its target
    fitView.lookAt(sun.position, sun.target.position, THREE.Object3D.DEFAULT_UP);
    fitView.setPosition(sun.position);
    fitView.invert();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of fitPts) {
      p.applyMatrix4(fitView);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
    }
    // snap to 40 units so the box does not change size (and the shadows shimmer) on every small camera move
    const q = (v, up) => (up ? Math.ceil(v / 40) : Math.floor(v / 40)) * 40;
    const l = q(x0 - SHADOW_MARGIN, false), r = q(x1 + SHADOW_MARGIN, true), b = q(y0 - SHADOW_MARGIN, false), t = q(y1 + SHADOW_MARGIN, true);
    const near = Math.max(10, -z1 - 400), far = -z0 + 400;
    const key = l + ',' + r + ',' + b + ',' + t + ',' + Math.round(near / 40) + ',' + Math.round(far / 40);
    if (key === fitKey) return;
    fitKey = key;
    const sc2 = sun.shadow.camera;
    sc2.left = l; sc2.right = r; sc2.bottom = b; sc2.top = t;
    sc2.near = near; sc2.far = far;
    sc2.updateProjectionMatrix();
    shadowR = Math.max(r - l, t - b) / 2;
  }
  function update(dt, S) {
    if (!loaded || !built) return; // models still loading
    time += dt;
    const me = S.players.get(S.me);
    localPlayerId = S.me;

    for (const door of stallDoors) {
      const nearby = [...S.players.values()].some(p => !p.dead && Math.hypot(p.x - door.x, p.y - door.y) < 160);
      const angle = nearby ? Math.PI / 2 : 0;
      door.hinge.rotation.y += (angle - door.hinge.rotation.y) * Math.min(1, dt * 10);
    }

    // camera follows the player
    if (me) {
      if (!cam.ready) {
        cam.x = me.x;
        cam.z = me.y;
        cam.ready = true;
      }
      const k = 1 - Math.exp(-dt * 7);
      cam.x += (me.x - cam.x) * k;
      cam.z += (me.y - cam.z) * k;
    }
    const aspect = W / H;
    const wide = aspect < 1.25 ? 1 + (1.25 - aspect) * 0.9 : 1;
    const d = Math.min(cam.dist * wide, zoomMax * 1.45);
    // the fog follows the camera: with fixed distances the far half of the screen went dark whenever we zoomed out,
    // and a phone (which pulls the camera back further) was always dark
    scene.fog.near = d * 1.8;
    scene.fog.far = d * 4.5;
    const sh = S.shake;
    // Continuous, lighter impact feedback on phones; random jumps at every display frame
    // looked like dropped frames even when the renderer kept up (especially at 120 Hz).
    const jx = sh > 0 ? (coarse ? Math.sin(time * 44) * sh * 2.5 : (Math.random() - 0.5) * sh * 14) : 0;
    const jy = sh > 0 ? (coarse ? Math.sin(time * 51) * sh * 1.5 : (Math.random() - 0.5) * sh * 10) : 0;
    camera.position.set(cam.x + jx, Math.sin(cam.pitch) * d + 40 + jy, cam.z + Math.cos(cam.pitch) * d);
    camera.lookAt(cam.x, 38, cam.z);

    // The sun's shadow box is fitted to the ground the camera actually sees (plus a margin for shadows cast into the
    // view from just outside it), in the light's own space. It used to be a square sized from the camera distance:
    // 5400 wide when zoomed out, so the shadow pass drew almost the whole office (726 draws, 2.2M triangles on an
    // iPad view, against 327 for the picture itself) and cost about 6 ms a frame in Safari on iPad and iPhone.
    const sunDist = 1280 + shadowR * 0.9; // further away for a bigger box, so no ground point ends up behind the light
    sun.position.set(cam.x - (500 / 1280) * sunDist, (1100 / 1280) * sunDist, cam.z + (450 / 1280) * sunDist);
    sun.target.position.set(cam.x, 0, cam.z);
    fitShadowBox();

    // objects
    if (!contactBuilt && built && S.objects.length) buildContactShadows(S.objects, S.types);
    for (const o of S.objects) {
      const rig = objectRig(o, S.types, S.objects);
      if (rig.shown !== o.broken) {
        // IT cleared a wreck: a puff of dust where it lay
        if (rig.shown === true && !lift(o.type)) fxDust(o.x, o.y, 12);
        rig.shown = o.broken;
        rig.wreck.visible = o.broken;
        if (rig.mark) rig.mark.visible = o.broken;
        rig.proxy.userData.broken = o.broken;
      }
      if (rig.support >= 0) {
        // the desk under this screen collapsed: it falls with it, and stands up again when the desk is replaced
        const sup = S.objects[rig.support];
        const target = sup && sup.broken ? wreckSurfaceAt(rigs.get(sup.id), o.x, o.y) : lift(o.type);
        if (rig.y > target) {
          rig.vy -= 900 * dt;
          rig.y = Math.max(target, rig.y + rig.vy * dt);
        } else {
          rig.y = target;
          rig.vy = 0;
        }
        rig.group.position.y = rig.y;
      }
      const electric = updateElectricTarget(rig, rig.group, rig.body.geometry, o.electricUntil);
      let sx = 0;
      let sz = 0;
      const shake = Math.max(o.shake, electric * 0.45);
      if (shake > 0) {
        sx = (Math.random() - 0.5) * 9 * shake;
        sz = (Math.random() - 0.5) * 9 * shake;
      }
      const sc = o.pop > 0 ? 1 - 0.6 * o.pop : 1;
      rig.group.position.x = o.x + sx;
      rig.group.position.z = o.y + sz;
      rig.group.scale.setScalar(sc);
      const dmg = 1 - o.hp / o.hpMax;
      const dark = 1 - dmg * 0.45;
      const f = o.flash;
      if (!o.broken && (dmg > 0.001 || f > 0 || electric > 0)) {
        if (!rig.mat) rig.mat = bodyMat.clone();
        if (rig.body.material !== rig.mat) rig.body.material = rig.mat;
        rig.mat.color.setRGB(dark, dark, dark);
        rig.mat.emissive.setRGB(f * 0.7 + electric * 0.18, f * 0.6 + electric * 0.3, f * 0.5 + electric * 0.65);
      } else if (rig.body.material !== bodyMat) rig.body.material = bodyMat;
      rig.group.rotation.z = o.broken ? 0 : dmg * 0.05 * (o.id % 2 ? 1 : -1); // a wreck lies flat on the floor
      // whole and still: drawn by its batch; otherwise by its own meshes
      const idle = !o.broken && dmg <= 0.001 && f <= 0 && electric <= 0 && shake <= 0 && sc === 1 && rig.vy === 0 && rig.y === lift(o.type);
      if (rig.slot && idle !== rig.batched) setBatched(rig, idle);
      const own = !o.broken && !rig.batched;
      rig.body.visible = own;
      if (rig.glow) rig.glow.visible = own;
      if (rig.halo) rig.halo.visible = haloOn && own;
      if (o.broken && ELECTRONIC.has(o.type)) {
        o.smokeT -= dt;
        if (o.smokeT <= 0) {
          fxSmoke(o.x, rig.group.position.y + 16, o.y);
          o.smokeT = rand(0.25, 0.6);
        }
      }
    }

    if (!batchesBuilt && rigs.size && rigs.size === S.objects.length) buildBatches();
    for (const b of batches) if (b.halo) b.halo.visible = haloOn;

    // players
    for (const [id, p] of S.players) {
      let rig = players.get(id);
      if (!rig) {
        rig = makePlayer(p);
        players.set(id, rig);
      }
      rig.g.userData.down = p.dead;
      updatePlayer(rig, p, dt, id === S.me, S);
      updateElectricTarget(rig, rig.torsoM, rig.torsoM.geometry, p.electricUntil);
    }
    for (const [id, rig] of players) {
      if (!S.players.has(id)) {
        disposePlayer(rig);
        players.delete(id);
      }
    }
    updateBoss(dt, S);
    updateSnakes(dt, S);
    updateMinis(dt, S);

    updateSpells(dt, S);
    updateParticles(dt);
    renderer.render(scene, camera);
    if (effectPrograms.visible) {
      scene.remove(effectPrograms);
      effectPrograms.visible = false;
    }

    // DOM overlays (after render so the camera matrices are current)
    updateHealthBars(S);
    if (bossRig) {
      const bp = S.boss && S.boss.pl;
      const pr = bp ? project(bp.x, 132 * BOSS_SCALE + 14, bp.y) : null;
      const on = !!pr && !S.boss.dead && pr.ok && pr.sx > -120 && pr.sx < W + 120 && pr.sy > -60 && pr.sy < H + 60;
      bossRig.label.style.display = on ? '' : 'none';
      if (on) bossRig.label.style.transform = 'translate(' + pr.sx.toFixed(1) + 'px,' + pr.sy.toFixed(1) + 'px) translate(-50%,-100%)';
    }
    for (const [id, rig] of miniRigs) {
      const b = id === 'PROFK' ? S.profk : S.minis.get(id), pr = b ? project(b.x, id === 'PROFK' ? 240 : 190, b.y) : null; // Prof. K is taller
      const on = !!pr && b.hp > 0 && pr.ok && pr.sx > -120 && pr.sx < W + 120 && pr.sy > -60 && pr.sy < H + 60;
      rig.label.style.display = on ? '' : 'none';
      if (on) rig.label.style.transform = 'translate(' + pr.sx.toFixed(1) + 'px,' + pr.sy.toFixed(1) + 'px) translate(-50%,-100%)';
    }
    for (const [id, rig] of players) {
      const p = S.players.get(id);
      if (!p) continue;
      const pr = project(p.x, 132, p.y);
      const on = pr.ok && pr.sx > -80 && pr.sx < W + 80 && pr.sy > -40 && pr.sy < H + 40;
      rig.label.style.display = on ? '' : 'none';
      if (on) rig.label.style.transform = 'translate(' + pr.sx.toFixed(1) + 'px,' + pr.sy.toFixed(1) + 'px) translate(-50%,-100%)';
    }
    for (let i = texts.length - 1; i >= 0; i--) {
      const t = texts[i];
      t.life -= dt;
      if (t.life <= 0) {
        t.el.remove();
        texts.splice(i, 1);
        continue;
      }
      t.y += 70 * dt;
      const pr = project(t.x, t.y, t.z);
      t.el.style.display = pr.ok ? '' : 'none';
      t.el.style.opacity = String(Math.min(1, t.life * 2));
      t.el.style.transform = 'translate(' + pr.sx.toFixed(1) + 'px,' + pr.sy.toFixed(1) + 'px) translate(-50%,-50%)';
    }
  }

  // ---- picking ------------------------------------------------------------
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPt = new THREE.Vector3();
  function pick(clientX, clientY) {
    const bounds = canvas.getBoundingClientRect();
    ndc.set(((clientX - bounds.left) / bounds.width) * 2 - 1, -((clientY - bounds.top) / bounds.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const live = proxies.filter((p) => !p.userData.broken);
    for (const rig of snakeRigs.values()) { rig.proxy.updateWorldMatrix(true, false); live.push(rig.proxy); }
    for (const [id, rig] of players) {
      if (id === localPlayerId || rig.g.userData.down) continue;
      if (!rig.pickProxy) {
        rig.pickProxy = new THREE.Mesh(new THREE.BoxGeometry(44, 105, 44), pickMat);
        rig.pickProxy.position.y = 52;
        rig.pickProxy.userData.playerId = id;
        rig.g.add(rig.pickProxy);
      }
      rig.pickProxy.updateWorldMatrix(true, false);
      live.push(rig.pickProxy);
    }
    const hits = ray.intersectObjects(live, false);
    if (hits.length) {
      const data = hits[0].object.userData;
      if (data.snakeId !== undefined) return { snakeId: data.snakeId };
      return data.playerId !== undefined ? { playerId: data.playerId } : { objectId: data.objId };
    }
    if (ray.ray.intersectPlane(ground, hitPt)) return { x: hitPt.x, y: hitPt.z };
    return null;
  }

  // ---- graphics quality. High (the default on computers): supersampled, sharp shadows, soft studio light and the
  // screen halos. Low (the safe option, default on touch screens): native resolution, ground/blob shadows only, no halos. Both
  // render straight to the screen: there is no post-processing chain. ----
  let haloOn = true;
  let quality = 'high';
  function setQuality(q) {
    quality = q === 'low' ? 'low' : 'high';
    const dpr = window.devicePixelRatio || 1;
    renderer.setPixelRatio(quality === 'high' ? Math.min(2, Math.max(dpr, 1.5)) : Math.min(dpr, 1));
    const shadows = quality === 'high';
    const size = coarse ? 1024 : 2048;
    renderer.shadowMap.enabled = shadows;
    sun.castShadow = shadows;
    if (!shadows || sun.shadow.mapSize.x !== size) {
      if (sun.shadow.map) {
        sun.shadow.map.dispose();
        sun.shadow.map = null;
      }
      if (sun.shadow.mapPass) {
        sun.shadow.mapPass.dispose();
        sun.shadow.mapPass = null;
      }
    }
    sun.shadow.mapSize.set(size, size);
    if (shadows) sun.shadow.needsUpdate = true;
    scene.environment = quality === 'high' ? envTex : null;
    haloOn = quality === 'high';
    ready.then(warmEffects);
    if (W) resize(W, H);
  }

  function resize(w, h) {
    W = w;
    H = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    ({ min: zoomMin, max: zoomMax, start: zoomStart } = zoomRange(h));
    cam.dist = zoomChosen ? Math.min(zoomMax, Math.max(zoomMin, cam.dist)) : zoomStart;
  }

  // for the zoom buttons: are we at the closest or the furthest view?
  function zoomLimits() {
    return { atMin: cam.dist <= zoomMin + 1, atMax: cam.dist >= zoomMax - 1, min: zoomMin, max: zoomMax, start: zoomStart, dist: cam.dist };
  }

  function zoom(delta) {
    cam.dist = Math.min(zoomMax, Math.max(zoomMin, cam.dist * (1 + delta)));
    zoomChosen = true;
    try {
      localStorage.setItem('br-zoom-v3', String(Math.round(cam.dist)));
    } catch (e) { /* ignore */ }
  }

  function resetZoom() {
    cam.dist = zoomStart;
    zoomChosen = false;
    try {
      localStorage.removeItem('br-zoom-v3');
    } catch (e) { /* ignore */ }
  }

  // One button press: snap to the next of the evenly spaced levels between the closest and furthest view.
  function zoomStep(dir) {
    const ratio = Math.log(zoomMax / zoomMin) / ZOOM_STEPS;
    const level = Math.log(cam.dist / zoomMin) / ratio;
    const next = Math.min(ZOOM_STEPS, Math.max(0, dir > 0 ? Math.floor(level + 0.01) + 1 : Math.ceil(level - 0.01) - 1));
    zoom(zoomMin * Math.exp(next * ratio) / cam.dist - 1);
  }

  function cameraTo(x, y) {
    cam.x = x;
    cam.z = y;
    cam.ready = true;
  }

  return {
    renderer, build, update, pick, resize, setQuality, getQuality: () => quality, zoom, zoomStep, resetZoom, zoomLimits, cameraTo, ready,
    fx: { summon: fxSummon, duelCast: fxDuelCast, blow: fxBlow, rope: fxRope, process: fxProcess, electric: fxElectric, milkTea: fxMilkTea, debris: fxDebris, sparks: fxSparks, smoke: fxSmoke, dust: fxDust, floatText },
    objectHeight: (type) => (PICK[type] ? PICK[type][1] : 40) + lift(type),
    lift: (type) => lift(type),
  };
}
