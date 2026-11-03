'use strict';

// Static world definition shared by every instance. Nothing in here changes at
// runtime, so it never needs to live in the shared store.

const WORLD = { w: 1280, h: 720 };

// cost is in millions of VND
const TYPES = {
  laptop: { label: 'Laptop', hp: 3, cost: 25, w: 46, h: 30 },
  monitor: { label: 'Màn hình', hp: 4, cost: 8, w: 44, h: 36 },
  chair: { label: 'Ghế xoay', hp: 2, cost: 2, w: 36, h: 36 },
  printer: { label: 'Máy in', hp: 6, cost: 6, w: 64, h: 48 },
  cooler: { label: 'Bình nước', hp: 5, cost: 3, w: 40, h: 64 },
  coffee: { label: 'Máy pha cà phê', hp: 5, cost: 12, w: 52, h: 56 },
  server: { label: 'Tủ server', hp: 8, cost: 120, w: 60, h: 90 },
  plant: { label: 'Chậu cây', hp: 2, cost: 0.5, w: 34, h: 44 },
};

// static furniture that is drawn but cannot be broken
const DESKS = [];
const DESK_COLS = [220, 520, 820];
const DESK_ROWS = [150, 340, 530];
for (const cy of DESK_ROWS) for (const cx of DESK_COLS) DESKS.push({ x: cx, y: cy });

function buildObjects() {
  const objs = [];
  const add = (type, x, y) => {
    objs.push({ id: objs.length, type, x, y });
  };
  for (const d of DESKS) {
    add('monitor', d.x - 34, d.y - 12);
    add('laptop', d.x + 38, d.y + 2);
    add('chair', d.x, d.y + 72);
  }
  add('printer', 1110, 110);
  add('cooler', 1110, 250);
  add('coffee', 1110, 390);
  add('server', 1110, 560);
  add('plant', 50, 50);
  add('plant', 1230, 50);
  add('plant', 50, 670);
  add('plant', 1230, 670);
  add('plant', 990, 330);
  return objs;
}

// Immutable object layout. Per-room mutable state (hp, broken) is stored as
// a sparse overlay: an object with no entry is at full health.
const OBJECTS = Object.freeze(buildObjects().map((o) => Object.freeze(o)));

module.exports = { WORLD, TYPES, DESKS, OBJECTS };
