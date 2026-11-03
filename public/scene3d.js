// All three.js rendering lives here. game.js owns the game state and the
// network; this module turns that state into pictures. World coordinates are
// (x, y) on the ground; in 3D, x stays x and the world's y becomes z (so "down"
// on the map is towards the camera). Everything is low-poly geometry built in
// code (no model or texture files), merged per type with vertex colours.

import * as THREE from 'three';
import { mergeGeometries } from './vendor/BufferGeometryUtils.js';

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
const box = (w, h, d, hex, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) =>
  place(paint(new THREE.BoxGeometry(w, h, d), hex), x, y, z, rx, ry, rz);
const cyl = (rt, rb, h, hex, x = 0, y = 0, z = 0, seg = 12, rx = 0, ry = 0, rz = 0) =>
  place(paint(new THREE.CylinderGeometry(rt, rb, h, seg), hex), x, y, z, rx, ry, rz);
const sph = (r, hex, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) => {
  const g = new THREE.SphereGeometry(r, 10, 8);
  g.scale(sx, sy, sz);
  return place(paint(g, hex), x, y, z);
};
const merge = (list) => (list.length ? mergeGeometries(list, false) : null);

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
const DESK_TOP = 62;
const LIFT = { monitor: DESK_TOP, laptop: DESK_TOP };
const PICK = { // invisible pick box, bigger than the model so small things are easy to click: [w, h, d]
  laptop: [56, 40, 40], monitor: [56, 66, 36], chair: [44, 66, 44], printer: [72, 50, 56],
  cooler: [48, 118, 48], coffee: [60, 82, 50], server: [68, 170, 58], plant: [44, 96, 44],
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
};
const ELECTRONIC = new Set(['laptop', 'monitor', 'printer', 'server', 'coffee']);

function buildModel(type, types) {
  const body = [];
  const glow = [];
  switch (type) {
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
    case 'chair':
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        body.push(box(3, 3, 17, '#222c3d', Math.sin(a) * 8, 6, Math.cos(a) * 8, 0, a));
        body.push(sph(2.6, '#111722', Math.sin(a) * 16, 2.6, Math.cos(a) * 16));
      }
      body.push(cyl(2.5, 2.5, 18, '#6b7a93', 0, 14, 0, 8));
      body.push(box(34, 6, 34, '#394a63', 0, 25, 0));
      body.push(box(32, 32, 5, '#2c3a52', 0, 44, -15, -0.12));
      body.push(box(4, 4, 22, '#222c3d', -17, 32, 0));
      body.push(box(4, 4, 22, '#222c3d', 17, 32, 0));
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
  return { body: merge(body), glow: merge(glow), wreck: merge(wreck) };
}

// ------------------------------------------------------- static scenery ----
function deskGeometry() {
  const g = [
    box(170, 6, 70, '#9c7e5a', 0, DESK_TOP - 3, 0),
    box(170, 2, 70, '#b08f66', 0, DESK_TOP - 0.5, 0),
    box(6, 56, 66, '#7d6347', -80, 28, 0),
    box(6, 56, 66, '#7d6347', 80, 28, 0),
    box(160, 30, 4, '#7d6347', 0, 44, -31),
    box(40, 40, 58, '#8b6f4e', -55, 36, 3),
    box(36, 2, 12, '#222a38', -34, DESK_TOP + 1.5, 12), // keyboard
    box(5, 2, 8, '#222a38', -8, DESK_TOP + 1.5, 12), // mouse
    box(12, 1.5, 16, '#f3f1ea', 62, DESK_TOP + 1, 14), // paper
    cyl(4.5, 4.5, 10, '#e4572e', 62, DESK_TOP + 5, 2, 10), // mug
    box(10, 10, 0.5, '#ffd34d', 8, DESK_TOP + 5, -28), // sticky note
  ];
  return g;
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
export function createScene3D(canvas, labelsEl, hooks = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const BG = 0x0d1017;
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 2200, 5200);

  const camera = new THREE.PerspectiveCamera(42, 1, 20, 7000);
  const cam = { x: 0, z: 0, dist: 820, pitch: 0.97, ready: false };

  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x59606e, 1.05));
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
  const sc = sun.shadow.camera;
  sc.left = -900; sc.right = 900; sc.top = 900; sc.bottom = -900; sc.near = 100; sc.far = 2600;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 1.5;
  scene.add(sun, sun.target);

  const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0.05 });
  const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.22, roughness: 0.1, depthWrite: false });
  const pickMat = new THREE.MeshBasicMaterial({ visible: false });

  const textures = {};
  const staticGroup = new THREE.Group();
  scene.add(staticGroup);
  let built = false;
  let world = { w: 3840, h: 2160 };

  // ---- static world -------------------------------------------------------
  function build(w, props, zones) {
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

    for (const p of props) {
      if (p.k === 'desk') addAll(deskGeometry(), p.x, p.y);
      else if (p.k === 'table') {
        addAll([
          box(p.w, 6, p.h, '#d9d2c5', 0, DESK_TOP - 3, 0),
          box(8, 56, 8, '#8a8f99', -p.w / 2 + 14, 28, -p.h / 2 + 14),
          box(8, 56, 8, '#8a8f99', p.w / 2 - 14, 28, -p.h / 2 + 14),
          box(8, 56, 8, '#8a8f99', -p.w / 2 + 14, 28, p.h / 2 - 14),
          box(8, 56, 8, '#8a8f99', p.w / 2 - 14, 28, p.h / 2 - 14),
          cyl(7, 7, 12, '#e4572e', -20, DESK_TOP + 6, 6, 10),
          cyl(5, 5, 8, '#f3f3f3', 40, DESK_TOP + 4, -10, 10),
        ], p.x, p.y);
      } else if (p.k === 'conference') {
        addAll([
          box(p.w, 8, p.h, '#6b4a30', 0, DESK_TOP + 2, 0),
          box(p.w - 14, 2, p.h - 14, '#7b5738', 0, DESK_TOP + 7, 0),
          box(30, 62, p.h - 50, '#3a2a1c', -p.w / 3, 31, 0),
          box(30, 62, p.h - 50, '#3a2a1c', p.w / 3, 31, 0),
          box(60, 3, 40, '#e9edf3', 0, DESK_TOP + 9, 0),
          cyl(5, 5, 9, '#ffffff', -150, DESK_TOP + 11, 20, 10),
          cyl(5, 5, 9, '#ffffff', 150, DESK_TOP + 11, -20, 10),
        ], p.x, p.y);
      } else if (p.k === 'sofa') {
        addAll([
          box(p.w, 28, p.h, '#3d5a80', 0, 20, 0),
          box(p.w, 44, 22, '#34506f', 0, 44, -p.h / 2 + 11),
          box(22, 34, p.h, '#2d4663', -p.w / 2 + 11, 34, 0),
          box(22, 34, p.h, '#2d4663', p.w / 2 - 11, 34, 0),
          box(p.w - 50, 8, p.h - 28, '#4a6a95', 0, 38, 8),
        ], p.x, p.y);
      } else if (p.k === 'rug') {
        addAll([
          box(p.w, 1.2, p.h, '#6e3a3a', 0, 0.8, 0),
          box(p.w - 30, 1.6, p.h - 30, '#7f4646', 0, 1.0, 0),
        ], p.x, p.y);
      } else if (p.k === 'wall') {
        const hgt = 210;
        const b = bucket(p.x, p.y);
        b.body.push(at(box(p.w + 2, 18, p.h + 2, '#3a4458', 0, 9, 0), p.x, 0, p.y));
        b.body.push(at(box(p.w + 2, 10, p.h + 2, '#3a4458', 0, hgt - 5, 0), p.x, 0, p.y));
        b.glass.push(at(box(p.w, hgt - 28, p.h, '#9fd4ff', 0, 18 + (hgt - 28) / 2, 0), p.x, 0, p.y));
        // posts
        const long = Math.max(p.w, p.h);
        const horiz = p.w >= p.h;
        for (let i = 0; i <= Math.ceil(long / 240); i++) {
          const o = -long / 2 + Math.min(long, i * 240);
          b.body.push(at(box(8, hgt, 8, '#2f384a', horiz ? o : 0, hgt / 2, horiz ? 0 : o), p.x, 0, p.y));
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
      b.body.push(at(box(w, h, d, c, 0, h / 2, 0), x, 0, z));
    }
    // windows and light strips on the north wall
    for (let x = 220; x < W; x += 480) {
      const b = bucket(x, 0);
      b.glow.push(at(box(260, 120, 2, '#8cc8ff', 0, 170, 0), x, 0, 1.2));
      b.body.push(at(box(272, 6, 4, '#1b2130', 0, 232, 0), x, 0, 2));
      b.body.push(at(box(272, 6, 4, '#1b2130', 0, 108, 0), x, 0, 2));
      b.body.push(at(box(6, 128, 4, '#1b2130', -130, 170, 0), x, 0, 2));
      b.body.push(at(box(6, 128, 4, '#1b2130', 130, 170, 0), x, 0, 2));
    }

    for (const b of buckets.values()) {
      const parts = [
        [merge(b.body), bodyMat, true],
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
      const tex = makeCanvasTexture(256, 256, FLOOR[k], w / 256, d / 256);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(x0 + w / 2, lift, y0 + d / 2);
      m.receiveShadow = true;
      staticGroup.add(m);
    };
    floorPlane('carpet', -60, -60, W + 60, H + 60, 0);
    for (const z of zones) floorPlane(z.k, z.x0, z.y0, z.x1, z.y1, 0.4);

    // wall sign and clock
    const sign = makeCanvasTexture(1024, 128, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(14,17,24,.92)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ff5d4a';
      ctx.fillRect(0, 0, 14, h);
      ctx.font = '800 52px system-ui, sans-serif';
      ctx.fillStyle = '#eef1f6';
      ctx.textBaseline = 'middle';
      ctx.fillText('BREAK ROOM · XẢ STRESS CÙNG ĐỒNG NGHIỆP', 44, h / 2 + 2);
    });
    const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(1000, 125), new THREE.MeshBasicMaterial({ map: sign, transparent: true }));
    signMesh.position.set(W / 2, 215, 3);
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

  // ---- objects ------------------------------------------------------------
  const models = {};
  const rigs = new Map(); // object id -> rig
  const proxies = [];

  function objectRig(o, types) {
    let rig = rigs.get(o.id);
    if (rig) return rig;
    if (!models[o.type]) models[o.type] = buildModel(o.type, types);
    const mod = models[o.type];
    const group = new THREE.Group();
    group.position.set(o.x, LIFT[o.type] || 0, o.y);
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
    const pk = PICK[o.type] || [40, 40, 40];
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(pk[0], pk[1], pk[2]), pickMat);
    proxy.position.y = pk[1] / 2;
    proxy.userData.objId = o.id;
    group.add(proxy);
    proxies.push(proxy);
    scene.add(group);
    rig = { group, body, glow, wreck, mat, proxy, o, popPrev: 0, shown: null };
    rigs.set(o.id, rig);
    return rig;
  }

  // ---- players ------------------------------------------------------------
  const players = new Map();
  const SKIN = ['#f1c9a5', '#e0ac82', '#c68a5f', '#8d5a3b', '#f6d6b8'];
  const HAIR = ['#1b1b22', '#3a2a1c', '#6b4a2a', '#c9a227', '#7a2e2e'];

  function makePlayer(p) {
    const g = new THREE.Group();
    const hue = p.hue;
    const shirt = new THREE.Color().setHSL(hue / 360, 0.65, 0.52);
    const shirtHex = '#' + shirt.getHexString();
    const skin = SKIN[p.id % SKIN.length];
    const hair = HAIR[(p.id * 3) % HAIR.length];
    const pantsHex = '#2a3040';

    const torso = merge([
      box(30, 30, 18, shirtHex, 0, 0, 0),
      box(32, 8, 20, shade(shirtHex, 0.8), 0, -16, 0),
    ]);
    const head = merge([
      sph(14, skin, 0, 0, 0),
      sph(14.5, hair, 0, 3.5, -2, 1, 0.8, 1),
      sph(2, '#14171f', -5, 1, 12.5),
      sph(2, '#14171f', 5, 1, 12.5),
    ]);
    const limb = (hex) => merge([box(9, 34, 9, hex, 0, -17, 0)]);
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
    root.add(headM);

    const legL = new THREE.Group();
    legL.position.set(-8, 38, 0);
    legL.add(mk(limb(pantsHex)));
    const legR = legL.clone();
    legR.position.x = 8;
    // clone shares mesh geometry but not materials issues: fine, same material
    g.add(legL, legR);

    const armL = new THREE.Group();
    armL.position.set(-19, 72, 0);
    armL.add(mk(limb(shirtHex)));
    const armR = new THREE.Group();
    armR.position.set(19, 72, 0);
    armR.add(mk(limb(shirtHex)));
    // hammer in the right hand
    const hammer = new THREE.Group();
    hammer.position.set(0, -32, 4);
    hammer.add(mk(merge([
      cyl(2.6, 2.6, 52, '#6b4a2a', 0, 14, 0, 8),
      box(24, 15, 15, '#9aa3b2', 0, 42, 0),
      box(26, 4, 17, '#6f7886', 0, 36, 0),
    ])));
    hammer.rotation.x = Math.PI / 2.4;
    armR.add(hammer);
    root.add(armL, armR);

    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(22, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.8;
    g.add(blob);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(24, 29, 28),
      new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 1.2;
    ring.visible = false;
    g.add(ring);

    const label = document.createElement('div');
    label.className = 'plabel';
    const emo = document.createElement('span');
    emo.className = 'emo';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p.name;
    label.append(emo, nm);
    labelsEl.appendChild(label);

    scene.add(g);
    return { g, root, torsoM, headM, legL, legR, armL, armR, hammer, ring, label, emo, nm, walk: 0, lastName: p.name, lastEmote: '' };
  }

  function updatePlayer(rig, p, dt, isMe) {
    rig.g.position.set(p.x, 0, p.y);
    // face the heading smoothly
    let diff = p.heading - rig.g.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    rig.g.rotation.y += diff * Math.min(1, dt * 14);

    if (p.moving) rig.walk += dt * 11;
    const sw = p.moving ? Math.sin(rig.walk) * 0.85 : 0;
    rig.legL.rotation.x = sw;
    rig.legR.rotation.x = -sw;
    rig.root.position.y = p.moving ? Math.abs(Math.sin(rig.walk)) * 3 : 0;
    rig.armL.rotation.x = -sw * 0.7;

    // right arm + hammer: idle carry, or the swing
    let a = -0.35 + (p.moving ? sw * 0.5 : 0);
    if (p.swing > 0) {
      const ph = 1 - p.swing; // 0..1 over the swing
      if (ph < 0.35) a = -0.35 - (ph / 0.35) * 2.0; // wind up
      else if (ph < 0.6) a = -2.35 + ((ph - 0.35) / 0.25) * 3.1; // smash
      else a = 0.75 - ((ph - 0.6) / 0.4) * 1.1; // recover
      rig.root.rotation.x = ph > 0.35 && ph < 0.6 ? 0.18 : 0;
    } else rig.root.rotation.x = 0;
    rig.armR.rotation.x = a;

    rig.ring.visible = isMe;
    if (rig.lastName !== p.name) {
      rig.nm.textContent = p.name;
      rig.lastName = p.name;
    }
    const em = p.emoteT > 0 && p.emote ? p.emote : '';
    if (em !== rig.lastEmote) {
      rig.emo.textContent = em;
      rig.lastEmote = em;
    }
    rig.label.classList.toggle('me', isMe);
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

  // ---- per-frame ----------------------------------------------------------
  let time = 0;
  function update(dt, S) {
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

    sun.position.set(cam.x - 500, 1100, cam.z + 450);
    sun.target.position.set(cam.x, 0, cam.z);

    // objects
    for (const o of S.objects) {
      const rig = objectRig(o, S.types);
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
          fxSmoke(o.x, (LIFT[o.type] || 0) + 16, o.y);
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
      updatePlayer(rig, p, dt, id === S.me);
    }
    for (const [id, rig] of players) {
      if (!S.players.has(id)) {
        disposePlayer(rig);
        players.delete(id);
      }
    }

    updateParticles(dt);
    renderer.render(scene, camera);

    // DOM overlays (after render so the camera matrices are current)
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

  function resize(w, h) {
    W = w;
    H = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function zoom(delta) {
    cam.dist = Math.min(1700, Math.max(560, cam.dist * (1 + delta)));
  }

  function cameraTo(x, y) {
    cam.x = x;
    cam.z = y;
    cam.ready = true;
  }

  return {
    renderer, build, update, pick, resize, zoom, cameraTo,
    fx: { debris: fxDebris, sparks: fxSparks, smoke: fxSmoke, floatText },
    objectHeight: (type) => (PICK[type] ? PICK[type][1] : 40) + (LIFT[type] || 0),
    lift: (type) => LIFT[type] || 0,
  };
}
