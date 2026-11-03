(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('c');
  const ctx = canvas.getContext('2d');

  const EMOTES = ['😤', '😂', '💀', '🔥', '☕', '😭', '👍', '🫠'];
  const JOKES = ['KPI!', 'Deadline!', 'Họp lúc 5h!', 'Reply All!', 'OT miễn phí!', 'Task gấp!', 'Sếp ơi!', 'Còn bug!'];
  const HIT_WORDS = ['BỐP!', 'RẦM!', 'CHÁT!', 'BỊCH!', 'RẮC!'];
  const ELECTRONIC = new Set(['laptop', 'monitor', 'printer', 'server', 'coffee']);
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
  const MOVE_KEYS = {
    arrowleft: 'l', a: 'l',
    arrowright: 'r', d: 'r',
    arrowup: 'u', w: 'u',
    arrowdown: 'd', s: 'd',
  };
  const SPEED = 300;
  const MAX_PARTICLES = 600;

  const S = {
    ws: null,
    started: false,
    joined: false,
    fatal: false,
    me: null,
    room: 'lobby',
    name: '',
    world: { w: 1280, h: 720 },
    types: {},
    desks: [],
    hitRange: 110,
    players: new Map(),
    objects: [],
    keys: new Set(),
    target: null,
    attackId: null,
    smashHeld: false,
    lastSend: 0,
    lastSentX: 0,
    lastSentY: 0,
    lastSentD: 1,
    lastHit: 0,
    particles: [],
    texts: [],
    shake: 0,
    muted: false,
    retry: 0,
    t: 0,
    bg: null,
    cam: null,
    dpr: 1,
  };

  // ---------------------------------------------------------------- utils ----
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function fmtShort(m) {
    return String(Math.round(m * 10) / 10).replace('.', ',') + 'tr';
  }
  function fmtMoney(m) {
    if (m >= 1000) return (m / 1000).toFixed(2).replace('.', ',') + ' tỷ';
    return String(Math.round(m * 10) / 10).replace('.', ',') + ' triệu';
  }

  function rng(seed) {
    let s = (Math.abs(seed) % 2147483646) + 1;
    return () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }

  function fillRR(c, color, x, y, w, h, r) {
    c.fillStyle = color;
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, h, r);
    else c.rect(x, y, w, h);
    c.fill();
  }

  function send(obj) {
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
  }

  function toast(text) {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    box.appendChild(el);
    while (box.children.length > 5) box.removeChild(box.firstChild);
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 4500);
  }

  // ---------------------------------------------------------------- audio ----
  let actx = null;
  let noiseBuf = null;

  function initAudio() {
    if (actx) {
      if (actx.state === 'suspended') actx.resume();
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      actx = new AC();
      const len = Math.floor(actx.sampleRate * 0.6);
      noiseBuf = actx.createBuffer(1, len, actx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch (e) {
      actx = null;
    }
  }

  function noise(dur, freq, vol) {
    if (!actx || S.muted) return;
    const t = actx.currentTime;
    const src = actx.createBufferSource();
    src.buffer = noiseBuf;
    const f = actx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    const g = actx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(actx.destination);
    src.start(t);
    src.stop(t + dur);
  }

  function tone(freq, dur, vol, type, slide) {
    if (!actx || S.muted) return;
    const t = actx.currentTime;
    const osc = actx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.linearRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    const g = actx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g);
    g.connect(actx.destination);
    osc.start(t);
    osc.stop(t + dur);
  }

  function sfxHit(v) {
    noise(0.12, 2600, 0.35 * v);
    tone(130, 0.12, 0.35 * v, 'sine', -70);
  }
  function sfxBreak(v) {
    noise(0.5, 5200, 0.6 * v);
    tone(90, 0.35, 0.45 * v, 'sawtooth', -60);
  }
  function sfxReset() {
    tone(880, 0.15, 0.18, 'sine', 0);
    setTimeout(() => tone(1320, 0.25, 0.18, 'sine', 0), 130);
  }

  function volumeAt(x, y) {
    const me = S.players.get(S.me);
    if (!me) return 0.6;
    const d = Math.hypot(x - me.x, y - me.y);
    return clamp(1 - d / 900, 0.15, 1);
  }

  // -------------------------------------------------------------- effects ----
  function addParticle(p) {
    if (S.particles.length < MAX_PARTICLES) S.particles.push(p);
  }

  function sparks(x, y, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(80, 300);
      addParticle({
        k: 'spark', x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60,
        life: rand(0.3, 0.6), max: 0.6, size: rand(2, 4),
        color: pick(['#ffd34d', '#ff9d2e', '#fff3b0']),
      });
    }
  }

  function debris(x, y, n, colors) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(60, 320);
      addParticle({
        k: 'debris', x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 140,
        life: rand(0.6, 1.2), max: 1.2, size: rand(3, 8),
        rot: Math.random() * 6, vr: rand(-12, 12),
        color: pick(colors),
      });
    }
  }

  function smoke(x, y) {
    addParticle({
      k: 'smoke', x: x + rand(-10, 10), y,
      vx: rand(-12, 12), vy: rand(-60, -30),
      life: rand(0.9, 1.5), max: 1.5, size: rand(5, 9),
    });
  }

  function floatText(x, y, text, color, size) {
    S.texts.push({ x, y, text, color, size, life: 1.1, vy: -55 });
  }

  // ---------------------------------------------------------------- state ----
  function addPlayer(p) {
    S.players.set(p.id, {
      id: p.id, name: p.name, hue: p.hue,
      x: p.x, y: p.y, tx: p.x, ty: p.y, d: p.d || 1,
      swing: 0, emote: null, emoteT: 0, moving: false,
    });
  }

  function makeObject(o) {
    const max = S.types[o.type].hp;
    return {
      id: o.id, type: o.type, x: o.x, y: o.y,
      hp: o.hp, hpMax: max, broken: o.broken,
      shake: 0, flash: 0, pop: 0, smokeT: rand(0, 0.5),
    };
  }

  function buildBackground() {
    const { w, h } = S.world;
    const bg = document.createElement('canvas');
    bg.width = w;
    bg.height = h;
    const c = bg.getContext('2d');

    c.fillStyle = '#262d3b';
    c.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 80) {
      for (let x = 0; x < w; x += 80) {
        c.fillStyle = ((x + y) / 80) % 2 === 0 ? '#2a3242' : '#2e3648';
        c.fillRect(x, y, 80, 80);
      }
    }
    fillRR(c, '#33405a', 1050, 70, 130, 560, 18);

    c.fillStyle = '#151922';
    c.fillRect(0, 0, w, 30);
    c.fillStyle = '#4a5468';
    c.font = 'bold 13px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('BREAK ROOM · XẢ STRESS CÙNG ĐỒNG NGHIỆP', w / 2, 15);

    c.fillStyle = '#e9edf3';
    c.beginPath();
    c.arc(1200, 15, 10, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#151922';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(1200, 15);
    c.lineTo(1200, 9);
    c.moveTo(1200, 15);
    c.lineTo(1205, 17);
    c.stroke();

    for (const d of S.desks) {
      fillRR(c, 'rgba(0,0,0,.28)', d.x - 85, d.y - 24, 170, 76, 8);
      fillRR(c, '#8b6f4e', d.x - 85, d.y - 30, 170, 70, 8);
      fillRR(c, '#9c7e5a', d.x - 85, d.y - 30, 170, 10, 8);
      c.fillStyle = '#e9edf3';
      c.fillRect(d.x + 62, d.y + 14, 16, 12);
      c.fillStyle = '#c7cdd8';
      c.fillRect(d.x + 65, d.y + 17, 10, 2);
      fillRR(c, '#e4572e', d.x - 78, d.y + 16, 10, 12, 3);
    }

    c.strokeStyle = '#0e1118';
    c.lineWidth = 8;
    c.strokeRect(0, 0, w, h);
    S.bg = bg;
  }

  // ------------------------------------------------------------- network ----
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(proto + '://' + location.host + '/ws');
    S.ws = ws;
    ws.onopen = () => {
      S.retry = 0;
      ws.send(JSON.stringify({ t: 'join', name: S.name, room: S.room }));
    };
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      onMsg(m);
    };
    ws.onclose = () => {
      if (S.ws !== ws || S.fatal) return;
      S.joined = false;
      $('conn').hidden = false;
      const wait = Math.min(8000, 1000 * Math.pow(2, S.retry++));
      setTimeout(() => {
        if (S.ws === ws && !S.fatal) connect();
      }, wait);
    };
  }

  function onMsg(m) {
    switch (m.t) {
      case 'welcome': {
        S.me = m.you;
        S.room = m.room;
        S.world = m.world;
        S.types = m.types;
        S.desks = m.desks;
        S.hitRange = m.hitRange;
        S.players = new Map();
        m.players.forEach(addPlayer);
        S.objects = m.objects.map(makeObject);
        S.particles = [];
        S.texts = [];
        S.target = null;
        S.attackId = null;
        buildBackground();
        S.joined = true;
        $('overlay').classList.add('gone');
        $('hud').hidden = false;
        $('conn').hidden = true;
        $('roomName').textContent = S.room;
        try {
          history.replaceState(null, '', '?room=' + encodeURIComponent(S.room));
        } catch (e) { /* ignore */ }
        const hint = $('hint');
        hint.classList.remove('fade');
        setTimeout(() => hint.classList.add('fade'), 15000);
        break;
      }
      case 'pj':
        addPlayer(m.p);
        toast(m.p.name + ' vừa vào phòng');
        break;
      case 'pl': {
        const p = S.players.get(m.id);
        if (p) toast(p.name + ' đã rời phòng');
        S.players.delete(m.id);
        break;
      }
      case 'ps':
        for (const e of m.l) {
          if (e[0] === S.me) continue;
          const p = S.players.get(e[0]);
          if (p) {
            p.tx = e[1];
            p.ty = e[2];
            p.d = e[3];
          }
        }
        break;
      case 'hit': {
        const o = S.objects[m.id];
        if (!o) break;
        o.hp = m.hp;
        o.shake = 1;
        o.flash = 1;
        sparks(o.x, o.y, 8);
        floatText(o.x, o.y - 30, pick(HIT_WORDS), '#ffffff', 16);
        const v = volumeAt(o.x, o.y);
        sfxHit(v);
        S.shake = Math.min(1, S.shake + 0.25 * v);
        if (m.by !== S.me) {
          const p = S.players.get(m.by);
          if (p) {
            p.swing = 1;
            p.d = o.x >= p.x ? 1 : -1;
          }
        }
        break;
      }
      case 'break': {
        const o = S.objects[m.id];
        if (!o) break;
        o.broken = true;
        o.hp = 0;
        o.shake = 1;
        debris(o.x, o.y, 16, RUBBLE[o.type] || ['#999999']);
        sparks(o.x, o.y, 18);
        for (let i = 0; i < 3; i++) smoke(o.x, o.y - 10);
        floatText(o.x, o.y - 44, '-' + fmtShort(m.cost), '#ffd34d', 22);
        if (m.cost >= 8) floatText(o.x, o.y - 66, pick(JOKES), '#ff8a78', 15);
        const v = volumeAt(o.x, o.y);
        sfxBreak(v);
        S.shake = Math.min(1.4, S.shake + 0.8 * v);
        const label = S.types[m.type] ? S.types[m.type].label : 'đồ vật';
        toast(m.name + ' đập nát ' + label + ' (-' + fmtShort(m.cost) + ')');
        break;
      }
      case 'respawn': {
        const o = S.objects[m.id];
        if (o) {
          o.broken = false;
          o.hp = o.hpMax;
          o.pop = 1;
        }
        break;
      }
      case 'reset':
        for (const o of S.objects) {
          o.broken = false;
          o.hp = o.hpMax;
          o.pop = 1;
        }
        sfxReset();
        toast(m.by + ' đã gọi IT, đồ mới được thay hết rồi');
        break;
      case 'emote': {
        const p = S.players.get(m.id);
        if (p) {
          p.emote = EMOTES[m.e] || null;
          p.emoteT = 2.2;
        }
        break;
      }
      case 'board':
        renderBoard(m);
        break;
      case 'err':
        if (!S.joined) {
          S.fatal = true;
          $('joinErr').textContent = m.m;
          $('joinBtn').disabled = false;
        } else {
          toast(m.m);
        }
        break;
      default:
        break;
    }
  }

  function renderBoard(m) {
    $('total').textContent = fmtMoney(m.total);
    $('online').textContent = String(m.online);
    const list = $('boardList');
    list.textContent = '';
    for (const e of m.board) {
      const li = document.createElement('li');
      li.textContent = e.name + ' ';
      const span = document.createElement('span');
      span.textContent = fmtShort(e.score);
      li.appendChild(span);
      list.appendChild(li);
    }
  }

  // ---------------------------------------------------------------- input ----
  function nearest() {
    const me = S.players.get(S.me);
    if (!me) return null;
    let best = null;
    let bestD = S.hitRange - 5;
    for (const o of S.objects) {
      if (o.broken) continue;
      const d = Math.hypot(o.x - me.x, o.y - me.y);
      if (d <= bestD) {
        best = o;
        bestD = d;
      }
    }
    return best;
  }

  function tryHit(o) {
    const me = S.players.get(S.me);
    if (!me || !o || o.broken) return false;
    const now = performance.now();
    if (now - S.lastHit < 190) return false;
    if (Math.hypot(o.x - me.x, o.y - me.y) > S.hitRange - 5) return false;
    S.lastHit = now;
    send({ t: 'hit', id: o.id });
    me.swing = 1;
    me.d = o.x >= me.x ? 1 : -1;
    return true;
  }

  function toWorld(cx, cy) {
    const cam = S.cam;
    if (!cam) return { x: 0, y: 0 };
    return { x: cx / cam.zoom + cam.x, y: cy / cam.zoom + cam.y };
  }

  function objectAt(x, y) {
    let best = null;
    let bestD = Infinity;
    for (const o of S.objects) {
      if (o.broken) continue;
      const t = S.types[o.type];
      if (Math.abs(x - o.x) <= t.w / 2 + 12 && Math.abs(y - o.y) <= t.h / 2 + 12) {
        const d = Math.hypot(x - o.x, y - o.y);
        if (d < bestD) {
          best = o;
          bestD = d;
        }
      }
    }
    return best;
  }

  function typing() {
    const tag = document.activeElement && document.activeElement.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA';
  }

  window.addEventListener('keydown', (e) => {
    if (!S.joined || typing()) return;
    const k = e.key.toLowerCase();
    if (MOVE_KEYS[k]) {
      e.preventDefault();
      S.keys.add(MOVE_KEYS[k]);
    } else if (k === ' ') {
      e.preventDefault();
      S.keys.add('space');
    } else if (k >= '1' && k <= '8' && !e.repeat) {
      send({ t: 'emote', e: Number(k) - 1 });
    }
  });

  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (MOVE_KEYS[k]) S.keys.delete(MOVE_KEYS[k]);
    else if (k === ' ') S.keys.delete('space');
  });

  window.addEventListener('blur', () => {
    S.keys.clear();
    S.smashHeld = false;
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (!S.joined || !S.cam) return;
    const pt = toWorld(e.clientX, e.clientY);
    const o = objectAt(pt.x, pt.y);
    if (o) {
      S.attackId = o.id;
      S.target = null;
    } else {
      S.attackId = null;
      S.target = { x: clamp(pt.x, 20, S.world.w - 20), y: clamp(pt.y, 20, S.world.h - 20) };
    }
  });

  const smashBtn = $('smashBtn');
  smashBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    S.smashHeld = true;
    tryHit(nearest());
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
    smashBtn.addEventListener(ev, () => {
      S.smashHeld = false;
    })
  );

  $('resetBtn').addEventListener('click', () => send({ t: 'reset' }));

  const emoteBox = $('emotes');
  EMOTES.forEach((em, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = em;
    b.title = 'Phím ' + (i + 1);
    b.addEventListener('click', () => send({ t: 'emote', e: i }));
    emoteBox.appendChild(b);
  });

  $('copyLink').addEventListener('click', () => {
    const url = location.origin + location.pathname + '?room=' + encodeURIComponent(S.room);
    const done = () => toast('Đã copy link phòng, gửi cho đồng nghiệp nhé');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, () => toast(url));
    } else {
      toast(url);
    }
  });

  $('mute').addEventListener('click', () => {
    S.muted = !S.muted;
    $('mute').textContent = S.muted ? '🔇' : '🔊';
  });

  // ----------------------------------------------------------------- join ----
  (function setupJoin() {
    const params = new URLSearchParams(location.search);
    const roomParam = (params.get('room') || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 24);
    let savedName = '';
    try {
      savedName = localStorage.getItem('br-name') || '';
    } catch (e) { /* ignore */ }
    $('nameInput').value = savedName;
    $('roomInput').value = roomParam;

    $('joinForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('nameInput').value.trim();
      const room = $('roomInput').value.trim().replace(/[^A-Za-z0-9-]/g, '');
      if (!name) return;
      try {
        localStorage.setItem('br-name', name);
      } catch (err) { /* ignore */ }
      S.name = name;
      S.room = room || 'lobby';
      S.fatal = false;
      S.started = true;
      $('joinErr').textContent = '';
      $('joinBtn').disabled = true;
      initAudio();
      connect();
    });
  })();

  // --------------------------------------------------------------- update ----
  function update(dt) {
    S.t += dt;
    S.shake = Math.max(0, S.shake - dt * 3);

    if (S.joined) {
      const me = S.players.get(S.me);
      if (me) updateMe(me, dt);

      for (const p of S.players.values()) {
        if (p.id !== S.me) {
          const k = Math.min(1, dt * 12);
          const ox = p.x;
          const oy = p.y;
          p.x += (p.tx - p.x) * k;
          p.y += (p.ty - p.y) * k;
          p.moving = Math.hypot(p.x - ox, p.y - oy) > 0.15;
        }
        p.swing = Math.max(0, p.swing - dt * 4);
        if (p.emoteT > 0) p.emoteT -= dt;
      }

      for (const o of S.objects) {
        o.shake = Math.max(0, o.shake - dt * 5);
        o.flash = Math.max(0, o.flash - dt * 6);
        o.pop = Math.max(0, o.pop - dt * 3);
        if (o.broken && ELECTRONIC.has(o.type)) {
          o.smokeT -= dt;
          if (o.smokeT <= 0) {
            smoke(o.x, o.y - 6);
            o.smokeT = rand(0.25, 0.6);
          }
        }
      }
    }

    for (let i = S.particles.length - 1; i >= 0; i--) {
      const p = S.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        S.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.k === 'debris') {
        p.vy += 700 * dt;
        p.rot += p.vr * dt;
      } else if (p.k === 'spark') {
        p.vy += 400 * dt;
      } else {
        p.size += dt * 14;
      }
    }

    for (let i = S.texts.length - 1; i >= 0; i--) {
      const t = S.texts[i];
      t.life -= dt;
      if (t.life <= 0) {
        S.texts.splice(i, 1);
        continue;
      }
      t.y += t.vy * dt;
    }
  }

  function updateMe(me, dt) {
    let dx = 0;
    let dy = 0;
    if (S.keys.has('l')) dx -= 1;
    if (S.keys.has('r')) dx += 1;
    if (S.keys.has('u')) dy -= 1;
    if (S.keys.has('d')) dy += 1;

    if (dx || dy) {
      S.target = null;
      S.attackId = null;
    } else if (S.attackId !== null) {
      const o = S.objects[S.attackId];
      if (!o || o.broken) {
        S.attackId = null;
      } else {
        const dist = Math.hypot(o.x - me.x, o.y - me.y);
        if (dist <= S.hitRange - 15) {
          tryHit(o);
        } else {
          dx = (o.x - me.x) / dist;
          dy = (o.y - me.y) / dist;
        }
      }
    } else if (S.target) {
      const dist = Math.hypot(S.target.x - me.x, S.target.y - me.y);
      if (dist < 6) {
        S.target = null;
      } else {
        dx = (S.target.x - me.x) / dist;
        dy = (S.target.y - me.y) / dist;
      }
    }

    const len = Math.hypot(dx, dy);
    const ox = me.x;
    const oy = me.y;
    if (len > 0) {
      const step = SPEED * dt;
      me.x = clamp(me.x + (dx / len) * step, 20, S.world.w - 20);
      me.y = clamp(me.y + (dy / len) * step, 20, S.world.h - 20);
      if (Math.abs(dx) > 0.2) me.d = dx > 0 ? 1 : -1;
    }
    me.moving = Math.hypot(me.x - ox, me.y - oy) > 0.1;

    if (S.keys.has('space') || S.smashHeld) tryHit(nearest());

    const now = performance.now();
    if (
      now - S.lastSend >= 50 &&
      (Math.abs(me.x - S.lastSentX) > 0.5 || Math.abs(me.y - S.lastSentY) > 0.5 || me.d !== S.lastSentD)
    ) {
      send({ t: 'move', x: Math.round(me.x), y: Math.round(me.y), d: me.d });
      S.lastSend = now;
      S.lastSentX = me.x;
      S.lastSentY = me.y;
      S.lastSentD = me.d;
    }
  }

  // --------------------------------------------------------------- render ----
  function resize() {
    S.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.floor(w * S.dpr);
    canvas.height = Math.floor(h * S.dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

  function camAxis(p, view, size) {
    return view >= size ? (size - view) / 2 : clamp(p - view / 2, 0, size - view);
  }

  function render() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.fillStyle = '#0d1017';
    ctx.fillRect(0, 0, W, H);
    if (!S.joined || !S.bg) return;

    const fit = Math.min(W / S.world.w, H / S.world.h);
    const zoom = Math.max(fit, 0.6);
    const viewW = W / zoom;
    const viewH = H / zoom;
    const me = S.players.get(S.me);
    const cx = camAxis(me ? me.x : S.world.w / 2, viewW, S.world.w);
    const cy = camAxis(me ? me.y : S.world.h / 2, viewH, S.world.h);
    S.cam = { x: cx, y: cy, zoom };

    let sx = 0;
    let sy = 0;
    if (S.shake > 0) {
      sx = (Math.random() - 0.5) * S.shake * 10;
      sy = (Math.random() - 0.5) * S.shake * 10;
    }
    ctx.setTransform(S.dpr * zoom, 0, 0, S.dpr * zoom, -(cx + sx) * zoom * S.dpr, -(cy + sy) * zoom * S.dpr);
    ctx.drawImage(S.bg, 0, 0);

    const items = [];
    for (const o of S.objects) items.push({ y: o.y - (o.broken ? 100 : 0), o });
    for (const p of S.players.values()) items.push({ y: p.y, p });
    items.sort((a, b) => a.y - b.y);
    for (const it of items) {
      if (it.o) drawObject(it.o);
      else drawPlayer(it.p);
    }

    drawParticles();
    drawTexts();
  }

  function drawObject(o) {
    const ty = S.types[o.type];
    const w = ty.w;
    const h = ty.h;
    const r = o.hp / o.hpMax;

    ctx.save();
    let sx = 0;
    let sy = 0;
    if (o.shake > 0) {
      sx = (Math.random() - 0.5) * 8 * o.shake;
      sy = (Math.random() - 0.5) * 4 * o.shake;
    }
    const sc = o.pop > 0 ? 1 - 0.6 * o.pop : 1;
    ctx.translate(o.x + sx, o.y + sy);
    ctx.scale(sc, sc);

    if (o.broken) {
      drawRubble(o, w, h);
      ctx.restore();
      return;
    }

    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.beginPath();
    ctx.ellipse(0, h / 2 - 2, w * 0.55, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    switch (o.type) {
      case 'laptop': {
        const glitch = r < 0.5 && Math.sin(S.t * 22 + o.id * 3) > 0.2;
        fillRR(ctx, '#9aa3b2', -w / 2, h * 0.18, w, h * 0.32, 3);
        fillRR(ctx, '#1c2330', -w * 0.42, -h / 2, w * 0.84, h * 0.7, 3);
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = glitch ? '#ff5d5d' : '#4aa8ff';
        ctx.fillRect(-w * 0.36, -h * 0.43, w * 0.72, h * 0.54);
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(255,255,255,.55)';
        for (let i = 0; i < 3; i++) ctx.fillRect(-w * 0.3, -h * 0.36 + i * 6, w * (0.35 + 0.12 * i), 2);
        break;
      }
      case 'monitor': {
        const glitch = r < 0.5 && Math.sin(S.t * 22 + o.id * 3) > 0.2;
        fillRR(ctx, '#11151d', -w / 2, -h / 2, w, h * 0.78, 3);
        ctx.fillStyle = glitch ? '#ff5d5d' : '#3b8fe0';
        ctx.fillRect(-w * 0.44, -h * 0.44, w * 0.88, h * 0.62);
        ctx.fillStyle = 'rgba(255,255,255,.5)';
        for (let i = 0; i < 3; i++) ctx.fillRect(-w * 0.34, -h * 0.34 + i * 7, w * (0.4 + 0.1 * i), 2);
        ctx.fillStyle = '#2b3240';
        ctx.fillRect(-4, h * 0.28, 8, h * 0.16);
        fillRR(ctx, '#2b3240', -w * 0.25, h * 0.42, w * 0.5, 5, 2);
        break;
      }
      case 'chair': {
        fillRR(ctx, '#222c3d', -w * 0.38, -h / 2, w * 0.76, h * 0.4, 8);
        ctx.fillStyle = '#394a63';
        ctx.beginPath();
        ctx.ellipse(0, h * 0.12, w * 0.46, h * 0.28, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#10151f';
        for (const wx of [-11, 0, 11]) {
          ctx.beginPath();
          ctx.arc(wx, h * 0.46, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'printer': {
        fillRR(ctx, '#cfd6e0', -w / 2, -h * 0.3, w, h * 0.8, 6);
        fillRR(ctx, '#e6ebf2', -w * 0.4, -h / 2, w * 0.8, h * 0.28, 4);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-w * 0.3, h * 0.22, w * 0.6, h * 0.2);
        ctx.fillStyle = r < 0.5 ? '#ff4d4d' : '#37e07a';
        ctx.beginPath();
        ctx.arc(w * 0.36, -h * 0.05, 3, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'cooler': {
        fillRR(ctx, '#dfe6ee', -w / 2, h * 0.02, w, h * 0.46, 5);
        fillRR(ctx, 'rgba(90,180,255,.78)', -w * 0.36, -h / 2, w * 0.72, h * 0.55, 10);
        ctx.fillStyle = 'rgba(255,255,255,.4)';
        ctx.fillRect(-w * 0.22, -h * 0.42, 4, h * 0.3);
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.arc(0, h * 0.14, 3, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'coffee': {
        fillRR(ctx, '#3a2f2a', -w / 2, -h / 2, w, h, 6);
        fillRR(ctx, '#262019', -w * 0.38, -h * 0.42, w * 0.76, h * 0.3, 4);
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.arc(w * 0.26, -h * 0.27, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1b1612';
        ctx.fillRect(-w * 0.38, h * 0.3, w * 0.76, 5);
        fillRR(ctx, '#ffffff', -8, h * 0.1, 16, 14, 3);
        break;
      }
      case 'server': {
        fillRR(ctx, '#0f1218', -w / 2, -h / 2, w, h, 4);
        for (let i = 0; i < 6; i++) {
          const yy = -h / 2 + 10 + i * 13;
          fillRR(ctx, '#1b212c', -w * 0.42, yy, w * 0.84, 9, 2);
          ctx.fillStyle = Math.sin(S.t * 4 + i * 1.7 + o.id) > 0 ? '#37e07a' : '#1d5a3a';
          ctx.beginPath();
          ctx.arc(-w * 0.32, yy + 4.5, 2, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'plant': {
        ctx.fillStyle = '#8a5a3a';
        ctx.beginPath();
        ctx.moveTo(-10, 6);
        ctx.lineTo(10, 6);
        ctx.lineTo(7, h / 2);
        ctx.lineTo(-7, h / 2);
        ctx.closePath();
        ctx.fill();
        const leaves = [[0, -4, 12, '#2f7d45'], [-9, -2, 9, '#3e9b55'], [9, -6, 9, '#3e9b55'], [0, -14, 8, '#3e9b55']];
        for (const l of leaves) {
          ctx.fillStyle = l[3];
          ctx.beginPath();
          ctx.arc(l[0], l[1], l[2], 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      default:
        break;
    }

    if (o.type !== 'plant' && r < 1) {
      const rnd = rng(o.id * 7919 + 13);
      const n = o.hpMax - o.hp;
      ctx.strokeStyle = 'rgba(255,255,255,.75)';
      ctx.lineWidth = 1.2;
      for (let i = 0; i < n; i++) {
        let x = (rnd() - 0.5) * w * 0.4;
        let y = (rnd() - 0.5) * h * 0.4;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let s = 0; s < 3; s++) {
          x += (rnd() - 0.5) * w * 0.4;
          y += (rnd() - 0.5) * h * 0.4;
          x = clamp(x, -w * 0.45, w * 0.45);
          y = clamp(y, -h * 0.45, h * 0.45);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    if (o.flash > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + 0.7 * o.flash + ')';
      ctx.fillRect(-w / 2, -h / 2, w, h);
    }
    ctx.restore();
  }

  function drawRubble(o, w, h) {
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath();
    ctx.ellipse(0, h * 0.3, w * 0.5, h * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
    const rnd = rng(o.id * 7919 + 13);
    const colors = RUBBLE[o.type] || ['#999999'];
    for (let i = 0; i < 6; i++) {
      const px = (rnd() - 0.5) * w * 0.9;
      const py = h * 0.15 + (rnd() - 0.5) * h * 0.35;
      const s = 4 + rnd() * 6;
      ctx.fillStyle = colors[i % colors.length];
      ctx.beginPath();
      ctx.moveTo(px, py - s);
      ctx.lineTo(px + s, py + s * 0.6);
      ctx.lineTo(px - s * 0.8, py + s * 0.7);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawPlayer(p) {
    const isMe = p.id === S.me;
    const bob = p.moving ? Math.sin(S.t * 14 + p.id) * 2 : 0;
    const legSwing = p.moving ? Math.sin(S.t * 14 + p.id) * 4 : 0;

    ctx.save();
    ctx.translate(p.x, p.y);

    ctx.fillStyle = 'rgba(0,0,0,.3)';
    ctx.beginPath();
    ctx.ellipse(0, 22, 14, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    if (isMe) {
      ctx.strokeStyle = '#ffd34d';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, 22, 18, 7, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.save();
    ctx.scale(p.d, 1);
    fillRR(ctx, '#1d2230', -8, 12 + bob * 0.3, 6, 10 + legSwing * 0.3, 2);
    fillRR(ctx, '#1d2230', 2, 12 + bob * 0.3, 6, 10 - legSwing * 0.3, 2);
    fillRR(ctx, 'hsl(' + p.hue + ',65%,52%)', -11, -6 + bob, 22, 26, 6);
    ctx.fillStyle = '#f1c9a5';
    ctx.beginPath();
    ctx.arc(0, -16 + bob, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2b2118';
    ctx.beginPath();
    ctx.arc(0, -18 + bob, 9, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#1b1b1b';
    ctx.beginPath();
    ctx.arc(4, -15 + bob, 1.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(8, 2 + bob);
    const angle = p.swing > 0 ? 2.1 - (1 - p.swing) * 2.7 : -0.6;
    ctx.rotate(angle);
    ctx.strokeStyle = '#8b6f4e';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 22);
    ctx.stroke();
    fillRR(ctx, '#9aa3b2', -7, 18, 15, 9, 2);
    ctx.restore();
    ctx.restore();

    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(p.name).width + 12;
    fillRR(ctx, 'rgba(0,0,0,.55)', -tw / 2, -44, tw, 17, 8);
    ctx.fillStyle = isMe ? '#ffd34d' : '#ffffff';
    ctx.fillText(p.name, 0, -35);

    if (p.emote && p.emoteT > 0) {
      ctx.globalAlpha = Math.min(1, p.emoteT);
      fillRR(ctx, '#ffffff', -17, -76, 34, 28, 10);
      ctx.font = '20px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
      ctx.fillStyle = '#000000';
      ctx.fillText(p.emote, 0, -61);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function drawParticles() {
    for (const p of S.particles) {
      const a = clamp(p.life / p.max, 0, 1);
      if (p.k === 'spark') {
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x, p.y, p.size, p.size);
      } else if (p.k === 'debris') {
        ctx.globalAlpha = Math.min(1, a * 1.5);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
        ctx.restore();
      } else {
        ctx.globalAlpha = a * 0.45;
        ctx.fillStyle = '#a0a5af';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawTexts() {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of S.texts) {
      ctx.globalAlpha = clamp(t.life * 2, 0, 1);
      ctx.font = '800 ' + t.size + 'px system-ui, sans-serif';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,.8)';
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
  }

  // ----------------------------------------------------------------- loop ----
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
