// All three.js rendering lives here. game.js owns the game state and the
// network; this module turns that state into pictures. World coordinates are
// (x, y) on the ground; in 3D, x stays x and the world's y becomes z (so "down"
// on the map is towards the camera). Everything is low-poly geometry built in
// code (no model or texture files), merged per type with vertex colours.

import * as THREE from 'three';
import { mergeGeometries } from './vendor/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from './vendor/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from './vendor/jsm/environments/RoomEnvironment.js';
import { ROLE_BY_ID } from './roles.js';

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

function buildModel(type, types) {
  const body = [];
  const glow = [];
  let pick = null;
  if (type === 'table' || type === 'conference' || type === 'sofa') {
    const t = types[type];
    for (const g of furnitureFallback(type, t.w, t.h)) body.push(g);
    pick = [t.w + 10, 90, t.h + 10];
  } else if (type === 'desk') {
    for (const g of deskGeometry()) body.push(g);
    // a mug and a stack of paper so the desks do not look empty
    body.push(cyl(6, 5.5, 11, '#f2f2ee', -60, DESK_TOP + 5.5, 24, 14));
    body.push(cyl(4.6, 4.6, 1, '#4b2e1d', -60, DESK_TOP + 10.6, 24, 14));
    body.push(box(26, 3, 34, '#f4f1e8', 58, DESK_TOP + 1.5, -34, 0, 0.12));
    body.push(box(26, 2, 34, '#e3dfd2', 57, DESK_TOP + 4, -33, 0, -0.08));
    pick = [170, 80, 120];
  } else switch (type) {
    case 'monitor':
      body.push(cyl(11, 13, 3, '#2b3240', 0, 1.5, 0));
      body.push(box(6, 20, 4, '#2b3240', 0, 13, -2));
      body.push(box(46, 32, 4, '#161a22', 0, 39, 0));
      glow.push(box(41, 26, 0.8, '#4aa8ff', 0, 39, 2.3));
      glow.push(box(36, 3, 0.9, '#bfe3ff', 0, 47, 2.5));
      break;
    case 'laptop':
      body.push(box(46, 2.5, 30, '#9aa3b2', 0, 1.3, 0));
      body.push(box(40, 0.6, 14, '#6f7886', 0, 2.8, 5));
      body.push(box(46, 28, 2, '#8d96a6', 0, 16, -13, -0.22));
      glow.push(box(41, 23, 0.6, '#5fb4ff', 0, 16, -11.9, -0.22));
      break;
    case 'chair': {
      // an office swivel chair made of soft shapes: puffy seat, curved back, round arms, a five-star base on wheels
      const SEAT = '#e48a8a';
      const SEAT_DARK = '#c96f6f';
      const FRAME = '#3a4252';
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        body.push(pill(2.3, 13, FRAME, Math.sin(a) * 9, 6.5, Math.cos(a) * 9, Math.PI / 2, a, 0));
        body.push(sph(3.2, '#1b212c', Math.sin(a) * 17, 3.2, Math.cos(a) * 17));
      }
      body.push(cyl(2.6, 3.2, 17, '#7d8aa3', 0, 15, 0, 14));
      body.push(cyl(14, 12, 4, FRAME, 0, 23.5, 0, 22));
      body.push(ell(19.5, 6.8, 18.5, SEAT, 0, 28, 1.5));
      body.push(ell(17, 4, 16, SEAT_DARK, 0, 24.5, 1.5));
      body.push(pill(2.4, 10, FRAME, 0, 33, -14.5));
      body.push(ell(18.5, 21, 5.4, '#b9565e', 0, 51, -17.5, -0.14)); // tall curved back, darker than the seat so it reads
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
      for (const y of [34, 68, 102, 136]) {
        body.push(box(82, 3.5, 34, FR, 0, y, 0));
        let x = -37;
        while (x < 32) {
          const bw = 4 + rnd() * 4;
          const bh = 17 + rnd() * 9;
          body.push(box(bw, bh, 22, BOOK[Math.floor(rnd() * BOOK.length)], x + bw / 2, y + 1.8 + bh / 2, -3, 0, 0, (rnd() - 0.5) * 0.12));
          x += bw + 0.6 + (rnd() < 0.18 ? 6 : 0);
        }
      }
      pick = [100, 176, 50];
      break;
    }
    case 'lamp':
      body.push(cyl(13, 15, 4, '#3a4252', 0, 2, 0, 20), pill(1.7, 160, '#6b7585', 0, 84, 0), cyl(11, 17, 26, '#f6e6b4', 0, 170, 0, 22), cyl(11.6, 11.6, 1.5, '#e3cf94', 0, 183, 0, 22));
      glow.push(ell(7, 7, 7, '#fff1b8', 0, 164, 0));
      pick = [40, 205, 40];
      break;
    case 'trash':
      body.push(cyl(13.5, 11, 52, '#8fa3a8', 0, 26, 0, 22), cyl(14.8, 14.8, 3.5, '#6c8187', 0, 53, 0, 22), cyl(11, 11, 1.5, '#2b3a3e', 0, 52, 0, 22));
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
      body.push(box(56, 76, 40, '#eef2f6', 0, 40, 0), box(55, 1.6, 1, '#b9c3cf', 0, 52, 20.2), pill(1.5, 14, '#8a8f99', 21, 66, 22.5), pill(1.5, 18, '#8a8f99', 21, 33, 22.5));
      body.push(sph(2.5, '#8a8f99', -20, 1.5, 15), sph(2.5, '#8a8f99', 20, 1.5, 15));
      pick = [64, 82, 48];
      break;
    case 'speaker':
      body.push(box(24, 100, 22, '#a8743f', 0, 50, 0), box(20, 92, 2, '#2b3240', 0, 50, 11.2), ell(8.5, 8.5, 3, '#5f6b7d', 0, 34, 12), ell(5, 5, 3, '#5f6b7d', 0, 68, 12), ell(2.2, 2.2, 2, '#9aa6b8', 0, 34, 14), ell(1.6, 1.6, 2, '#9aa6b8', 0, 68, 14));
      pick = [34, 106, 34];
      break;
    case 'printer':
      body.push(box(64, 28, 46, '#cfd6e0', 0, 14, 0));
      body.push(box(60, 6, 40, '#b4bcc9', 0, 31, 0));
      body.push(box(46, 14, 3, '#f4f6f9', 0, 42, -14, -0.5));
      body.push(box(48, 2, 16, '#e4e8ee', 0, 15, 28));
      body.push(box(16, 8, 4, '#2b3240', -18, 22, 23.2));
      glow.push(box(3, 2, 2, '#37e07a', 22, 24, 23.4));
      glow.push(box(10, 5, 1, '#4aa8ff', -18, 22, 25.3));
      break;
    case 'cooler':
      body.push(box(36, 62, 36, '#e8edf3', 0, 31, 0));
      body.push(box(30, 6, 30, '#cdd5df', 0, 63, 0));
      body.push(cyl(14, 14, 36, '#5ab4ff', 0, 84, 0, 14));
      body.push(cyl(6, 12, 8, '#4a9de0', 0, 105, 0, 12));
      body.push(box(10, 4, 8, '#2b3240', 0, 44, 18));
      body.push(box(10, 4, 8, '#e5483a', -9, 52, 18));
      glow.push(box(4, 4, 2, '#7fd0ff', 9, 52, 18.3));
      break;
    case 'coffee':
      body.push(box(52, 56, 40, '#2b2f38', 0, 28, 0));
      body.push(box(52, 10, 42, '#3a2f2a', 0, 60, 0));
      body.push(box(24, 6, 14, '#161a22', 0, 46, 20));
      body.push(cyl(6, 6, 12, '#f3f3f3', 0, 14, 22, 10));
      body.push(box(40, 3, 18, '#161a22', 0, 4, 22));
      glow.push(box(8, 8, 1, '#ffb02e', -14, 32, 20.4));
      glow.push(box(8, 8, 1, '#37e07a', 14, 32, 20.4));
      break;
    case 'server':
      body.push(box(60, 140, 50, '#12161e', 0, 70, 0));
      body.push(box(64, 4, 54, '#2b3240', 0, 142, 0));
      for (let i = 0; i < 8; i++) {
        const y = 14 + i * 16;
        body.push(box(54, 12, 2, '#1d2330', 0, y, 25.5));
        for (let k = 0; k < 3; k++) {
          glow.push(box(4, 2.5, 1, k === 0 ? '#37e07a' : k === 1 ? '#4aa8ff' : '#ffb02e', -18 + k * 7, y, 26.8));
        }
      }
      break;
    case 'plant':
      body.push(cyl(14, 10, 26, '#8a5a3a', 0, 13, 0, 10));
      body.push(cyl(13, 13, 3, '#3b2a1e', 0, 26, 0, 10));
      body.push(cyl(2, 3, 16, '#5b3b24', 0, 36, 0, 6));
      body.push(sph(16, '#3e9b55', 0, 52, 0, 1, 0.9, 1));
      body.push(sph(11, '#2f7d45', -10, 62, 4));
      body.push(sph(11, '#4db26a', 9, 60, -5));
      body.push(sph(9, '#3e9b55', 2, 74, 2));
      break;
    case 'tv':
      body.push(box(44, 3, 26, '#2b3240', 0, 1.5, 0));
      body.push(box(5, 40, 5, '#2b3240', 0, 22, -2));
      body.push(box(92, 56, 5, '#12151c', 0, 74, 0));
      glow.push(box(84, 48, 0.8, '#4aa8ff', 0, 74, 2.7));
      glow.push(box(60, 4, 0.9, '#bfe3ff', 0, 90, 2.9));
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

  // collapsed pile: dark slab plus tilted shards in the same colours
  const t = types[type];
  const rnd = seeded(type.length * 977 + type.charCodeAt(0));
  const wreck = [box(t.w * 0.9, 2.5, t.h * 0.9, '#17171b', 0, 1.2, 0)];
  const pal = RUBBLE[type] || ['#888888'];
  for (let i = 0; i < 9; i++) {
    const s = 5 + rnd() * 11;
    wreck.push(
      box(s, s * (0.3 + rnd() * 0.5), s * (0.6 + rnd()), shade(pal[i % pal.length], 0.55 + rnd() * 0.3),
        (rnd() - 0.5) * t.w * 0.8, 3 + rnd() * 6, (rnd() - 0.5) * t.h * 0.8,
        (rnd() - 0.5) * 1.2, rnd() * 3, (rnd() - 0.5) * 1.2),
    );
  }
  return { body: bakeAO(merge(body)), glow: merge(glow), wreck: bakeAO(merge(wreck)), pick };
}

// ------------------------------------------------------- static scenery ----
function deskGeometry() {
  const DT = DESK_TOP;
  const TOP = '#dcbc92';
  const BODY = '#c29d72';
  return [
    box(158, 6, 76, TOP, 0, DT - 3, 0),
    box(6, DT - 6, 70, BODY, -72, (DT - 6) / 2, 0),
    box(6, DT - 6, 70, BODY, 72, (DT - 6) / 2, 0),
    box(142, 30, 4, '#a98156', 0, DT - 24, -32),
    box(38, 44, 64, BODY, 52, 28, 2),
    pill(1.5, 14, '#8a8f99', 52, 38, 35, 0, 0, Math.PI / 2),
    box(36, 2.6, 12, '#2f3646', -34, DT + 1.3, 16), // keyboard
    ell(3.2, 1.8, 4.8, '#2f3646', -8, DT + 1, 16), // mouse
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
      ell(14, 3, 9, '#eef0f4', 0, DT + 2.5, 0),
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
  renderer.shadowMap.enabled = true;
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
  scene.environmentIntensity = 0.22;

  const camera = new THREE.PerspectiveCamera(42, 1, 20, 7000);
  const ZOOM_MIN = 560;
  const ZOOM_MAX = 2300;
  const ZOOM_START = 1300; // roughly the middle of the range: a whole meeting room fits, characters stay readable
  const cam = { x: 0, z: 0, dist: ZOOM_START, pitch: 0.97, ready: false };
  try {
    const saved = Number(localStorage.getItem('br-zoom'));
    if (saved >= ZOOM_MIN && saved <= ZOOM_MAX) cam.dist = saved; // the player's own choice, remembered
  } catch (e) { /* ignore */ }
  let shadowR = 900;

  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x6a5f58, 0.8));
  // a cool fill from the opposite side (no shadows) so the shaded faces keep some colour
  const fill = new THREE.DirectionalLight(0x8fb4ff, 0.45);
  fill.position.set(900, 700, -600);
  scene.add(fill);
  const sun = new THREE.DirectionalLight(0xffe6c4, 1.9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
  const sc = sun.shadow.camera;
  sc.left = -900; sc.right = 900; sc.top = 900; sc.bottom = -900; sc.near = 100; sc.far = 2600;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 1.5;
  scene.add(sun, sun.target);

  const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false, roughness: 0.8, metalness: 0.04 });
  const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.22, roughness: 0.1, depthWrite: false });
  const pickMat = new THREE.MeshBasicMaterial({ visible: false });

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
  function buildNow(w, props, zones) {
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
      const pool = makeCanvasTexture(128, 128, (ctx, w, h) => {
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, 'rgba(255,236,190,.5)');
        g.addColorStop(1, 'rgba(255,236,190,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        // feather the left and right edges so the patch has no hard border
        ctx.globalCompositeOperation = 'destination-in';
        const e = ctx.createLinearGradient(0, 0, w, 0);
        e.addColorStop(0, 'rgba(0,0,0,0)');
        e.addColorStop(0.3, 'rgba(0,0,0,1)');
        e.addColorStop(0.7, 'rgba(0,0,0,1)');
        e.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = e;
        ctx.fillRect(0, 0, w, h);
      });
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
    signMesh.position.set(W / 2, 215, 7); // in front of the window frames (they reach z = 4)
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
  function build(w, props, zones) {
    if (!loaded) pendingBuild = [w, props, zones];
    else buildNow(w, props, zones);
  }

  // ---- Sếp VKL -----------------------------------------------------------
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
    bossRig.g.visible = !b.dead;
    bossRig.label.classList.toggle('gone', !!b.dead);
    if (!b.dead) updatePlayer(bossRig, b.pl, dt, false, S);
    // the punch circle: an outline plus a disc that fills up until the fist lands
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
    windMesh.visible = true;
    windMesh.position.x = w.x;
    windMesh.position.z = w.y;
    windMesh.scale.setScalar(w.r);
    windMesh.userData.fill.scale.setScalar(Math.max(0.02, t));
    windMesh.userData.fill.material.opacity = 0.3 + 0.35 * t;
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
    if (!models[o.type]) models[o.type] = buildModel(o.type, types);
    const mod = models[o.type];
    const group = new THREE.Group();
    group.position.set(o.x, lift(o.type), o.y);
    const mat = bodyMat.clone();
    const body = new THREE.Mesh(mod.body, mat);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);
    let glow = null;
    if (mod.glow) {
      glow = new THREE.Mesh(mod.glow, glowMat);
      group.add(glow);
    }
    const wreck = new THREE.Mesh(mod.wreck, bodyMat);
    wreck.receiveShadow = true;
    wreck.castShadow = true;
    wreck.visible = false;
    group.add(wreck);
    const pk = mod.pick || PICK[o.type] || [40, 40, 40];
    PICK[o.type] = pk;
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(pk[0], pk[1], pk[2]), pickMat);
    proxy.position.y = pk[1] / 2;
    proxy.userData.objId = o.id;
    group.add(proxy);
    proxies.push(proxy);
    if (o.type === 'chair') faceNearestFurniture(group, o, types, all);
    else if (o.rot) group.rotation.y = o.rot;
    const halo = makeHalo(o.type);
    if (halo) group.add(halo);
    scene.add(group);
    rig = { group, body, glow, halo, wreck, mat, proxy, o, popPrev: 0, shown: null };
    rigs.set(o.id, rig);
    return rig;
  }

  // ---- players ------------------------------------------------------------
  const players = new Map();
  const SKIN = ['#f1c9a5', '#e0ac82', '#c68a5f', '#8d5a3b', '#f6d6b8'];
  const HAIR = ['#1b1b22', '#3a2a1c', '#6b4a2a', '#c9a227', '#7a2e2e'];

  // Small hats and gear per company role, built in head units (about 1 unit = 1 world unit, y up from the head's
  // centre) and parented to the head. Roles without an entry wear nothing.
  const ACCESSORY_POS = [0, 19, 0];
  const ACCESSORY_SCALE = 1.5;
  function accessoryParts(role) {
    switch (role) {
      case 'boss': {
        const g = '#f2c744';
        const parts = [cyl(8.4, 8.4, 3, g, 0, 0, 0, 10)];
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          parts.push(box(2.4, 5.5, 2.4, g, Math.sin(a) * 7, 4, Math.cos(a) * 7));
        }
        return parts;
      }
      case 'it':
        return [
          box(17, 1.6, 2, '#2b2f3a', 0, 1, 0),
          box(1.6, 12, 2, '#2b2f3a', -8.4, -5, 0),
          box(1.6, 12, 2, '#2b2f3a', 8.4, -5, 0),
          sph(3.6, '#ff5d4a', -9.2, -10, 0, 0.55, 1, 1),
          sph(3.6, '#ff5d4a', 9.2, -10, 0, 0.55, 1, 1),
        ];
      case 'dev':
        return [sph(9, '#2f3d52', 0, 0, 0, 1, 0.7, 1), sph(1.6, '#2f3d52', 0, 6, 0)];
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
    const female = p.gender === 'f';
    const jacket = boss ? '#1f2a44' : shirtHex;
    const pantsHex = boss ? '#161c2c' : '#2a3040';
    const hairHex = boss ? '#d3d9e3' : hair;
    // hairstyles: 0 long bob, 1 spiky, 2 bun, 3 side part. Girls get 0 or 2, boys 1 or 3, the boss is always spiky silver.
    const style = boss ? 1 : female ? (p.id % 2 ? 0 : 2) : p.id % 2 ? 1 : 3;

    // A round "chibi" body: big head, capsule limbs, no hard edges.
    const capsule = (r, len, hex, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) => {
      const g = new THREE.CapsuleGeometry(r, len, 4, 14);
      g.scale(sx, sy, sz);
      return place(paint(g, hex), x, y, z);
    };
    const cone = (r, h, hex, x, y, z, rx = 0, ry = 0, rz = 0) => place(paint(new THREE.ConeGeometry(r, h, 10), hex), x, y, z, rx, ry, rz);

    const torsoParts = [capsule(14, 8, jacket, 0, 0, 0, 1, 1, 0.82), cyl(14.6, 14.6, 3.5, shade(jacket, 0.7), 0, -13, 0, 16)];
    if (boss) {
      torsoParts.push(box(9, 20, 2.4, '#f4f6fa', 0, 6, 11.2), box(3.8, 17, 2.4, '#c0392b', 0, 3, 12.6));
    }
    const torso = merge(torsoParts);

    const ez = 16.6; // eyes sit on the front of the head
    const headParts = [
      sph(19, skin, 0, 0, 0, 1, 0.96, 0.98),
      sph(3.1, '#161a24', -7.2, -1, ez, 0.85, 1.3, 0.55),
      sph(3.1, '#161a24', 7.2, -1, ez, 0.85, 1.3, 0.55),
      sph(1.15, '#ffffff', -6.3, 1, ez + 1.4),
      sph(1.15, '#ffffff', 8.1, 1, ez + 1.4),
      sph(3.4, '#f09a9a', -12, -6.5, 12.2, 1, 0.6, 0.4),
      sph(3.4, '#f09a9a', 12, -6.5, 12.2, 1, 0.6, 0.4),
      sph(1.8, '#8b3a3a', 0, -8, 16.6, 1.5, 0.45, 0.4),
      sph(20.4, hairHex, 0, 3, -3.2, 1, 0.94, 1), // hair cap
    ];
    if (style === 0) {
      headParts.push(sph(10, hairHex, 0, 11, 11.5, 1.5, 0.5, 0.9), sph(7, hairHex, -17.5, -4, -1, 0.7, 1.7, 1), sph(7, hairHex, 17.5, -4, -1, 0.7, 1.7, 1), sph(19, hairHex, 0, -5, -8, 1, 1.1, 0.8));
    } else if (style === 1) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        headParts.push(cone(4.2, 12, hairHex, Math.sin(a) * 11, 21 + (i % 2) * 1.5, Math.cos(a) * 9 - 3, Math.cos(a) * 0.55, 0, -Math.sin(a) * 0.55));
      }
    } else if (style === 2) {
      headParts.push(sph(10, hairHex, 0, 11, 11.5, 1.5, 0.5, 0.9), sph(7.5, hairHex, 0, 21, -6), sph(2.4, '#c0392b', 0, 17, -6));
    } else {
      headParts.push(sph(9, hairHex, -6, 12, 12, 1.7, 0.5, 0.8), sph(6, hairHex, -16, 3, 2, 0.7, 1.2, 1));
    }
    const head = merge(headParts);

    const limb = (hex, withHand) => merge([capsule(4.8, 20, hex, 0, -16, 0), ...(withHand ? [sph(4.5, skin, 0, -31.5, 0)] : [])]);
    const legGeo = () => merge([capsule(5.6, 18, pantsHex, 0, -14, 0), sph(6.4, '#262c3b', 0, -33, 3.5, 1, 0.62, 1.5)]);
    const mat = bodyMat;
    const mk = (geo) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      return m;
    };
    const root = new THREE.Group(); // bobbing part
    g.add(root);
    const torsoM = mk(torso);
    torsoM.position.y = 58;
    root.add(torsoM);
    const headM = mk(head);
    headM.position.y = 90;
    headM.scale.setScalar(1.12); // a slightly bigger head reads as cuter from the camera
    root.add(headM);
    const acc = buildAccessory(p.role);
    if (acc) {
      acc.scale.setScalar(ACCESSORY_SCALE);
      acc.position.set(ACCESSORY_POS[0], ACCESSORY_POS[1], ACCESSORY_POS[2]);
      headM.add(acc);
    }

    const legL = new THREE.Group();
    legL.position.set(-8, 38, 0);
    legL.add(mk(legGeo()));
    const legR = new THREE.Group();
    legR.position.set(8, 38, 0);
    legR.add(mk(legGeo()));
    g.add(legL, legR);

    // The model faces +z, towards the camera, so its own right hand is on the -x side (the viewer's left).
    const armL = new THREE.Group();
    armL.position.set(19, 72, 0);
    armL.add(mk(limb(jacket, true)));
    const armR = new THREE.Group();
    armR.position.set(-19, 72, 0);
    armR.add(mk(limb(jacket, true)));
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
    hammer.position.set(0, -30, 0);
    hammer.rotation.set(Math.PI, Math.PI / 2, 0);
    hammer.scale.setScalar(0.82);
    armR.add(hammer);
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
    label.append(bub, emo, nm, rl, hpb, bar);
    labelsEl.appendChild(label);

    scene.add(g);
    return { g, root, torsoM, headM, legL, legR, armL, armR, hammer, ring, label, bub, emo, nm, rl, hpb, hpf, bar, fill, lie: 0, lastHp: -1, walk: 0, lastRole: '', lastCompany: null, lastName: p.name, lastEmote: '', lastChat: '' };
  }

  function updatePlayer(rig, p, dt, isMe, S) {
    rig.g.position.set(p.x, 0, p.y);
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
    if (p.moving) rig.walk += dt * 11;
    const wp = rig.walk;
    const sw = Math.sin(wp) * 1.0 * mv;
    const breathe = Math.sin(rig.t * 2.3) * idle;
    rig.legL.rotation.x = sw;
    rig.legR.rotation.x = -sw;
    rig.legL.position.y = 38 + Math.max(0, -Math.sin(wp)) * 3 * mv; // the stepping foot lifts
    rig.legR.position.y = 38 + Math.max(0, Math.sin(wp)) * 3 * mv;
    const bob = Math.abs(Math.sin(wp)) * 5 * mv;
    rig.root.position.y = bob;
    const sy = 1 + breathe * 0.018 + (0.5 - Math.abs(Math.sin(wp))) * 0.07 * mv; // squash and stretch
    rig.root.scale.set(1 / Math.sqrt(sy), sy, 1 / Math.sqrt(sy));
    rig.torsoM.rotation.y = Math.sin(wp) * 0.2 * mv + Math.sin(rig.t * 0.9) * 0.03 * idle;
    rig.headM.rotation.y = -Math.sin(wp) * 0.12 * mv + Math.sin(rig.t * 0.8) * 0.07 * idle;
    rig.headM.rotation.z = Math.sin(wp) * 0.06 * mv + Math.sin(rig.t * 1.3) * 0.05 * idle;
    rig.headM.rotation.x = -Math.sin(wp * 2) * 0.05 * mv + breathe * 0.02;
    rig.armL.rotation.x = -sw * 0.95 + breathe * 0.05;
    rig.armL.rotation.z = 0.14 + Math.sin(rig.t * 1.7) * 0.03 * idle + Math.abs(sw) * 0.12;

    // right arm + hammer: carried raised over the shoulder, wound up, slammed down in front, then lifted again.
    // (The boss has no hammer: it keeps the old low guard and the punch.)
    const eo = (t) => 1 - (1 - t) * (1 - t);
    const ei = (t) => t * t;
    const lerp = (x, y, t) => x + (y - x) * t;
    const armed = rig.hammer.visible;
    const CARRY = -2.3;
    let a = armed ? CARRY + sw * 0.2 + breathe * 0.03 : -0.35 + sw * 0.55 + breathe * 0.04;
    let lean = 0.1 * mv;
    if (p.swing > 0) {
      const ph = 1 - p.swing; // 0..1 over the swing
      if (armed) {
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
    rig.root.rotation.x = lean;
    rig.armR.rotation.x = a;
    rig.armR.rotation.z = -0.1 - Math.abs(sw) * 0.1;

    // knocked out: lie flat on one side. Sideways rather than backwards, because the camera looks from the south and
    // a body lying north-south would just look like it is still standing.
    rig.lie += ((p.dead ? 1 : 0) - rig.lie) * Math.min(1, dt * 8);
    if (rig.lie > 0.001 || p.dead) {
      rig.root.rotation.z = 1.5 * rig.lie;
    }
    const hf = p.dead ? 0 : p.hpFrac == null ? 1 : p.hpFrac;
    if (Math.abs(hf - rig.lastHp) > 0.004) {
      rig.lastHp = hf;
      rig.hpf.style.transform = 'scaleX(' + Math.max(0, Math.min(1, hf)).toFixed(3) + ')';
      rig.hpf.className = hf < 0.25 ? 'low' : hf < 0.55 ? 'mid' : '';
    }
    rig.hpb.style.display = p.alwaysHp || (!p.dead && hf < 0.999) ? '' : 'none';
    rig.label.classList.toggle('down', !!p.dead);

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
    scene.remove(rig.g);
    rig.label.remove();
  }

  // ---- particles ----------------------------------------------------------
  const MAXD = 520;
  const debrisMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9 }), MAXD);
  debrisMesh.frustumCulled = false;
  debrisMesh.castShadow = true;
  debrisMesh.count = MAXD;
  const dZero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < MAXD; i++) {
    debrisMesh.setMatrixAt(i, dZero);
    debrisMesh.setColorAt(i, new THREE.Color(0xffffff));
  }
  scene.add(debrisMesh);
  const D = Array.from({ length: MAXD }, () => ({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, vr: 0, s: 1 }));
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
  const tmpC = new THREE.Color();

  function fxDebris(x, y, z, n, colors) {
    for (let i = 0; i < n; i++) {
      const d = D[dNext];
      dNext = (dNext + 1) % MAXD;
      const a = Math.random() * Math.PI * 2;
      const sp = rand(90, 340);
      Object.assign(d, {
        life: rand(1.0, 1.9), max: 1.9, x: x + rand(-10, 10), y: y + rand(4, 24), z: z + rand(-10, 10),
        vx: Math.cos(a) * sp, vy: rand(180, 460), vz: Math.sin(a) * sp,
        rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6, vr: rand(-10, 10), s: rand(4, 11),
      });
      tmpC.set(colors[Math.floor(Math.random() * colors.length)]);
      debrisMesh.setColorAt(dNext === 0 ? MAXD - 1 : dNext - 1, tmpC);
    }
    debrisMesh.instanceColor.needsUpdate = true;
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
  function updateParticles(dt) {
    let dirty = false;
    for (let i = 0; i < MAXD; i++) {
      const d = D[i];
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life <= 0) {
        debrisMesh.setMatrixAt(i, dZero);
        dirty = true;
        continue;
      }
      d.vy -= 950 * dt;
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
      scl.set(k, k * 0.7, k);
      mtx.compose(pos, quat, scl);
      debrisMesh.setMatrixAt(i, mtx);
      dirty = true;
    }
    if (dirty) debrisMesh.instanceMatrix.needsUpdate = true;

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
      const pr = project(o.x, BAR_LIFT[o.type] || 70, o.y);
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
  function update(dt, S) {
    if (!loaded || !built) return; // models still loading
    time += dt;
    const me = S.players.get(S.me);

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
    const d = cam.dist * wide;
    const sh = S.shake;
    const jx = sh > 0 ? (Math.random() - 0.5) * sh * 14 : 0;
    const jy = sh > 0 ? (Math.random() - 0.5) * sh * 10 : 0;
    camera.position.set(cam.x + jx, Math.sin(cam.pitch) * d + 40 + jy, cam.z + Math.cos(cam.pitch) * d);
    camera.lookAt(cam.x, 30, cam.z);

    // The sun's shadow box follows the view: wide enough to cover everything visible, so zooming out does not
    // reveal the edge of the shadowed area (it used to be a fixed 1800-wide box).
    const R = Math.min(2700, Math.max(900, d * 1.6));
    if (Math.abs(R - shadowR) > 8) {
      shadowR = R;
      const sc2 = sun.shadow.camera;
      sc2.left = -R; sc2.right = R; sc2.top = R; sc2.bottom = -R;
      sc2.near = 10;
      sc2.far = 1300 + R * 1.8 + 400;
      sc2.updateProjectionMatrix();
    }
    const sunDist = 1280 + shadowR * 0.9; // further away for a bigger box, so no ground point ends up behind the light
    sun.position.set(cam.x - (500 / 1280) * sunDist, (1100 / 1280) * sunDist, cam.z + (450 / 1280) * sunDist);
    sun.target.position.set(cam.x, 0, cam.z);

    // objects
    for (const o of S.objects) {
      const rig = objectRig(o, S.types, S.objects);
      if (rig.halo) rig.halo.visible = haloOn && !o.broken;
      if (rig.shown !== o.broken) {
        rig.shown = o.broken;
        rig.body.visible = !o.broken;
        if (rig.glow) rig.glow.visible = !o.broken;
        rig.wreck.visible = o.broken;
        rig.proxy.userData.broken = o.broken;
      }
      let sx = 0;
      let sz = 0;
      if (o.shake > 0) {
        sx = (Math.random() - 0.5) * 9 * o.shake;
        sz = (Math.random() - 0.5) * 9 * o.shake;
      }
      const sc = o.pop > 0 ? 1 - 0.6 * o.pop : 1;
      rig.group.position.x = o.x + sx;
      rig.group.position.z = o.y + sz;
      rig.group.scale.setScalar(sc);
      const dmg = 1 - o.hp / o.hpMax;
      const dark = 1 - dmg * 0.45;
      const f = o.flash;
      rig.mat.color.setRGB(dark, dark, dark);
      rig.mat.emissive.setRGB(f * 0.7, f * 0.6, f * 0.5);
      rig.group.rotation.z = dmg * 0.05 * (o.id % 2 ? 1 : -1);
      if (o.broken && ELECTRONIC.has(o.type)) {
        o.smokeT -= dt;
        if (o.smokeT <= 0) {
          fxSmoke(o.x, lift(o.type) + 16, o.y);
          o.smokeT = rand(0.25, 0.6);
        }
      }
    }

    // players
    for (const [id, p] of S.players) {
      let rig = players.get(id);
      if (!rig) {
        rig = makePlayer(p);
        players.set(id, rig);
      }
      updatePlayer(rig, p, dt, id === S.me, S);
    }
    for (const [id, rig] of players) {
      if (!S.players.has(id)) {
        disposePlayer(rig);
        players.delete(id);
      }
    }
    updateBoss(dt, S);

    updateParticles(dt);
    renderer.render(scene, camera);

    // DOM overlays (after render so the camera matrices are current)
    updateHealthBars(S);
    if (bossRig) {
      const bp = S.boss && S.boss.pl;
      const pr = bp ? project(bp.x, 132 * BOSS_SCALE + 14, bp.y) : null;
      const on = !!pr && !S.boss.dead && pr.ok && pr.sx > -120 && pr.sx < W + 120 && pr.sy > -60 && pr.sy < H + 60;
      bossRig.label.style.display = on ? '' : 'none';
      if (on) bossRig.label.style.transform = 'translate(' + pr.sx.toFixed(1) + 'px,' + pr.sy.toFixed(1) + 'px) translate(-50%,-100%)';
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
    ndc.set((clientX / W) * 2 - 1, -(clientY / H) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const live = proxies.filter((p) => !p.userData.broken);
    const hits = ray.intersectObjects(live, false);
    if (hits.length) return { objectId: hits[0].object.userData.objId };
    if (ray.ray.intersectPlane(ground, hitPt)) return { x: hitPt.x, y: hitPt.z };
    return null;
  }

  // ---- graphics quality. High (the default on computers): supersampled, sharp shadows, soft studio light and the
  // screen halos. Low (the safe option, default on touch screens): native resolution, smaller shadow map, no halos. Both
  // render straight to the screen: there is no post-processing chain. ----
  let haloOn = true;
  let quality = 'high';
  function setQuality(q) {
    quality = q === 'low' ? 'low' : 'high';
    const dpr = window.devicePixelRatio || 1;
    renderer.setPixelRatio(quality === 'high' ? Math.min(2, Math.max(dpr, 1.5)) : Math.min(dpr, 1));
    const size = quality === 'high' ? (coarse ? 1024 : 2048) : 1024;
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      if (sun.shadow.map) {
        sun.shadow.map.dispose();
        sun.shadow.map = null;
      }
    }
    scene.environment = quality === 'high' ? envTex : null;
    haloOn = quality === 'high';
    if (W) resize(W, H);
  }

  function resize(w, h) {
    W = w;
    H = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // for the zoom buttons: are we at the closest or the furthest view?
  function zoomLimits() {
    return { atMin: cam.dist <= ZOOM_MIN + 1, atMax: cam.dist >= ZOOM_MAX - 1 };
  }

  function zoom(delta) {
    cam.dist = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.dist * (1 + delta)));
    try {
      localStorage.setItem('br-zoom', String(Math.round(cam.dist)));
    } catch (e) { /* ignore */ }
  }

  function cameraTo(x, y) {
    cam.x = x;
    cam.z = y;
    cam.ready = true;
  }

  return {
    renderer, build, update, pick, resize, setQuality, getQuality: () => quality, zoom, zoomLimits, cameraTo, ready,
    fx: { debris: fxDebris, sparks: fxSparks, smoke: fxSmoke, floatText },
    objectHeight: (type) => (PICK[type] ? PICK[type][1] : 40) + lift(type),
    lift: (type) => lift(type),
  };
}
