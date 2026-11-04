import { createScene3D } from './scene3d.js';
import { ROLES, ROLE_BY_ID } from './roles.js';

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // The join button is only usable with a name, and not while a join is in flight.
  let joinBusy = false;
  function syncJoin() {
    $('joinBtn').disabled = joinBusy || !$('nameInput').value.trim();
  }
  function setJoinBusy(b) {
    joinBusy = b;
    syncJoin();
  }
  const canvas = $('c');
  let scene = null;
  try {
    scene = createScene3D(canvas, $('labels'));
  } catch (e) {
    scene = null;
  }

  const EMOTES = ['😤', '😂', '💀', '🔥', '☕', '😭', '👍', '🫠'];
  const JOKES = ['KPI!', 'Deadline!', 'Họp lúc 5h!', 'Reply All!', 'OT miễn phí!', 'Task gấp!', 'Sếp ơi!', 'Còn bug!'];
  const SKILLS = [
    { id: 'hammer', label: '🔨 Skill: Đập búa', action: 'ĐẬP!' },
    { id: 'milkTea', label: '🧋 Skill: Ném ly trà sữa', action: 'NÉM!' },
    { id: 'electric', label: '⚡ Skill: Chích điện', action: 'CHÍCH!' },
  ];
  const HIT_WORDS = ['BỐP!', 'RẦM!', 'CHÁT!', 'BỊCH!', 'RẮC!'];
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
  const MOVE_KEYS = {
    arrowleft: 'l', a: 'l',
    arrowright: 'r', d: 'r',
    arrowup: 'u', w: 'u',
    arrowdown: 'd', s: 'd',
  };
  const SPEED = 420;

  const S = {
    mana: null, // { v, t }: value stored at time t (performance.now), same model as lib/realtime.js
    manaCfg: null,
    manaFrac: 1,
    manaToastAt: 0,
    ws: null,
    pendingWs: null,
    stuck: 0,
    colliders: [],
    welcomed: false,
    started: false,
    joined: false,
    fatal: false,
    me: null,
    room: 'lobby',
    name: '',
    gender: 'm',
    role: 'nv',
    company: '',
    world: { w: 1280, h: 720 },
    types: {},
    desks: [],
    hitRange: 110,
    milkTeaRangeMultiplier: 2,
    players: new Map(),
    objects: [],
    boss: null, // VKL of this server (see the boss section)
    hpCfg: null,
    keys: new Set(),
    target: null,
    attackId: null,
    smashHeld: false,
    skill: 'hammer',
    lastAir: 0,
    lastSend: 0,
    lastSentX: 0,
    lastSentY: 0,
    lastSentD: 1,
    lastHit: 0,
    shake: 0,
    muted: true, // sound is off until the player turns it on (the choice is remembered)
    retry: 0,
    t: 0,
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
  function sfxPunch(v) {
    noise(0.22, 900, 0.8 * v);
    tone(70, 0.3, 0.7 * v, 'sine', -40);
  }
  function sfxWind(v) {
    tone(180, 0.6, 0.14 * v, 'sawtooth', 140);
  }
  function sfxHurt() {
    noise(0.16, 1800, 0.45);
    tone(210, 0.22, 0.35, 'square', -130);
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
  // World (x, y) on the ground; height above the floor is added here.
  function objTop(o) {
    return scene ? scene.objectHeight(o.type) * 0.6 : 20;
  }
  function sparks(o, n) {
    if (scene) scene.fx.sparks(o.x, objTop(o), o.y, n);
  }
  function debris(o, n, colors) {
    if (scene) scene.fx.debris(o.x, scene.lift(o.type), o.y, n, colors);
  }
  function smoke(o) {
    if (scene) scene.fx.smoke(o.x, objTop(o), o.y);
  }
  function floatText(o, dy, text, color, size) {
    if (scene) scene.fx.floatText(o.x, objTop(o) + dy, o.y, text, color, size);
  }

  // ---------------------------------------------------------------- state ----
  function addPlayer(p) {
    S.players.set(p.id, {
      id: p.id, name: p.name, hue: p.hue, gender: p.gender === 'f' ? 'f' : 'm', role: ROLE_BY_ID[p.role] ? p.role : 'nv', company: String(p.company || ''),
      x: p.x, y: p.y, tx: p.x, ty: p.y, d: p.d || 1,
      swing: 0, emote: null, emoteT: 0, chat: '', chatT: 0,
      hp: typeof p.hp === 'number' ? p.hp : 100, hpT: performance.now() - (p.hpAgo || 0), hpFrac: 1,
      dead: (p.deadMs || 0) > 0, deadAt: performance.now() + (p.deadMs || 0), moving: false, heading: 0,
    });
  }

  function makeObject(o) {
    const max = S.types[o.type].hp;
    return {
      id: o.id, type: o.type, x: o.x, y: o.y, rot: o.rot || 0,
      hp: o.hp, hpMax: max, broken: o.broken,
      shake: 0, flash: 0, pop: 0, smokeT: rand(0, 0.5),
    };
  }

  // ------------------------------------------------------------- network ----
  // A random id kept per tab. The server uses it to recognise us after a
  // reconnect, so we keep our player id, score and position instead of
  // joining as a stranger with zero points.
  let memToken = '';
  function getToken() {
    const ok = (t) => /^[A-Za-z0-9_-]{16,64}$/.test(t || '');
    try {
      let t = sessionStorage.getItem('br-token');
      if (!ok(t)) {
        t = makeToken();
        sessionStorage.setItem('br-token', t);
      }
      return t;
    } catch (e) {
      if (!memToken) memToken = makeToken();
      return memToken;
    }
  }
  function makeToken() {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Connections are cut by the platform after a fixed time (5 min on the Vercel
  // Hobby plan) and may drop at any time, so every close is treated as normal.
  // handover = true opens the new socket while the old one is still working;
  // we only switch once the new one has joined, so nothing visibly blinks.
  function connect(handover) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(proto + '://' + location.host + '/api/ws');
    if (handover) S.pendingWs = ws;
    else S.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'join', name: S.name, gender: S.gender, role: S.role, company: S.company, room: S.room, token: getToken() }));
    };
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (S.pendingWs === ws) {
        if (m.t !== 'welcome') return;
        const old = S.ws;
        S.pendingWs = null;
        S.ws = ws;
        if (old && old !== ws) old.close(1000);
      } else if (S.ws !== ws) {
        return;
      }
      if (m.t === 'welcome') S.retry = 0;
      if (m.t === 'renew') {
        if (!S.pendingWs && !S.fatal) connect(true);
        return;
      }
      onMsg(m);
    };
    ws.onclose = (ev) => {
      if (S.pendingWs === ws) {
        // the replacement never made it; fall back to the normal path if the old one is gone too
        S.pendingWs = null;
        if (S.ws && S.ws.readyState > 1 && !S.fatal) scheduleReconnect(S.ws);
        return;
      }
      if (S.ws !== ws || S.fatal) return;
      if (S.pendingWs) return; // a replacement is already joining; it takes over
      if (ev && ev.code === 4002) {
        // kicked for inactivity: do not reconnect on our own, that would defeat the purpose
        S.fatal = true;
        S.joined = false;
        S.keys.clear();
        S.smashHeld = false;
        $('conn').hidden = true;
        $('overlay').classList.remove('gone');
        chatLog.hidden = true;
        setJoinBusy(false);
        $('joinErr').textContent = 'Bạn đứng yên lâu quá nên bị ngắt kết nối để tiết kiệm tài nguyên. Bấm "Vào văn phòng" để quay lại, điểm của bạn vẫn còn.';
        return;
      }
      if (ev && ev.code === 4003) {
        // disconnected because a newer deploy is live: reconnecting would only land on the new server with an old page
        S.fatal = true;
        S.joined = false;
        $('conn').hidden = true;
        showUpdate(true);
        return;
      }
      if (ev && ev.code === 4001) {
        S.fatal = true;
        S.joined = false;
        $('conn').textContent = 'Server này đang mở ở tab khác. Đóng tab kia hoặc tải lại trang.';
        $('conn').hidden = false;
        return;
      }
      scheduleReconnect(ws);
    };
  }

  function scheduleReconnect(ws) {
    S.joined = false;
    $('conn').hidden = false;
    const base = Math.min(10000, 1000 * Math.pow(2, S.retry++));
    const wait = base * (0.5 + Math.random() * 0.5); // jitter so a deploy does not stampede
    setTimeout(() => {
      if (S.ws === ws && !S.fatal) connect(false);
    }, wait);
  }

  function onMsg(m) {
    switch (m.t) {
      case 'welcome': {
        if (m.newer || (m.build && m.build !== 'dev' && MY_BUILD && m.build !== MY_BUILD)) showUpdate(false);
        S.me = m.you;
        S.room = m.room;
        S.world = m.world;
        S.types = m.types;
        S.colliders = m.colliders;
        S.hitRange = m.hitRange;
        S.milkTeaRangeMultiplier = m.milkTeaRangeMultiplier || 2;
        S.manaCfg = m.mana;
        S.maxPlayers = m.maxPlayers || 20;
        S.hpCfg = m.player || { max: 100, regenDelayMs: 4000, regenPerSec: 5 };
        S.mana = { v: m.mana.v, t: performance.now() - m.mana.ago };
        S.players = new Map();
        m.players.forEach(addPlayer);
        S.objects = m.objects.map(makeObject);
        initBoss(m.boss);
        const meNow = S.players.get(S.me);
        $('downOverlay').hidden = !(meNow && meNow.dead); // refreshing while knocked out keeps the countdown
        S.target = null;
        S.attackId = null;
        if (scene) scene.build(m.world, m.props, m.zones);
        mmBuild(m.world, m.props, m.zones);
        S.joined = true;
        $('overlay').classList.add('gone');
        $('hud').hidden = false;
        if (chatLog.hidden) {
          chatLog.textContent = ''; // a fresh join starts with an empty frame; a reconnect keeps what was said
          chatLog.hidden = false;
        }
        chatWake();
        $('conn').hidden = true;
        $('roomName').textContent = m.roomLabel || S.room;
        try {
          history.replaceState(null, '', '?room=' + encodeURIComponent(S.room));
        } catch (e) { /* ignore */ }
        if (!S.welcomed) {
          S.welcomed = true;
          const hint = $('hint');
          const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
          if (touch) hint.textContent = 'Chạm vào nền để đi · chạm vào đồ vật để đập · giữ nút ĐẬP! để đập liên tục';
          hint.classList.remove('fade'); // the hint stays on screen, kept subtle by its style
        }
        break;
      }
      case 'pj':
        addPlayer(m.p);
        toast(m.p.name + ' vừa vào server');
        break;
      case 'pl': {
        const p = S.players.get(m.id);
        if (p) toast(p.name + ' đã rời server');
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
      case 'boss':
        bossMove(m);
        break;
      case 'bwind':
        bossWind(m);
        break;
      case 'bstrike':
        bossStrike(m);
        break;
      case 'bhp':
        bossHit(m);
        break;
      case 'bdead':
        bossDown(m);
        break;
      case 'bup':
        bossBack(m);
        break;
      case 'hp':
        playerHurt(m);
        break;
      case 'down':
        playerDown(m);
        break;
      case 'up':
        playerUp(m);
        break;
      case 'mana':
        if (S.manaCfg) S.mana = { v: m.v, t: performance.now() - m.ago };
        break;
      case 'update':
        showUpdate(false);
        break;
      case 'swing': {
        const swinger = S.players.get(m.id);
        if (swinger && m.id !== S.me) showSkill(swinger, m.skill);
        if (m.id !== S.me) {
          const p = S.players.get(m.id);
          if (p) {
            p.swing = 1;
            p.heading = m.h;
          }
        }
        break;
      }
      case 'hit': {
        const o = S.objects[m.id];
        if (!o) break;
        o.hp = m.hp;
        o.shake = 1;
        o.flash = 1;
        sparks(o, 8);
        const hitter = S.players.get(m.by);
        if (hitter) showSkill(hitter, m.skill, o);
        const roleWords = hitter && ROLE_BY_ID[hitter.role] ? ROLE_BY_ID[hitter.role].hit : null;
        floatText(o, 22, roleWords && Math.random() < 0.4 ? pick(roleWords) : pick(HIT_WORDS), '#ffffff', 16);
        const v = volumeAt(o.x, o.y);
        sfxHit(v);
        S.shake = Math.min(1, S.shake + 0.25 * v);
        if (m.by !== S.me) {
          const p = S.players.get(m.by);
          if (p) {
            p.swing = 1;
            p.d = o.x >= p.x ? 1 : -1;
            p.heading = Math.atan2(o.x - p.x, o.y - p.y);
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
        debris(o, 34, RUBBLE[o.type] || ['#999999']);
        sparks(o, 26);
        for (let i = 0; i < 4; i++) smoke(o);
        floatText(o, 46, '-' + fmtShort(m.cost), '#ffd34d', 22);
        if (m.cost >= 8) floatText(o, 74, pick(JOKES), '#ff8a78', 15);
        const v = volumeAt(o.x, o.y);
        sfxBreak(v);
        S.shake = Math.min(1.4, S.shake + 0.8 * v);
        const label = S.types[m.type] ? S.types[m.type].label : 'đồ vật';
        const breaker = S.players.get(m.by);
        const rl = breaker && ROLE_BY_ID[breaker.role];
        toast((rl ? rl.emoji + ' ' : '') + m.name + ' đập nát ' + label + ' (-' + fmtShort(m.cost) + ')' + (rl && m.cost >= 8 ? ' · ' + rl.joke : ''));
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
      case 'chat':
        chatReceive(m);
        break;
      case 'board':
        renderBoard(m);
        break;
      case 'err':
        if (m.code === 'name') {
          // name missing or taken (also if someone took it while we were reconnecting): back to the join form
          S.fatal = true;
          S.joined = false;
          S.keys.clear();
          S.smashHeld = false;
          $('conn').hidden = true;
          $('overlay').classList.remove('gone');
          setJoinBusy(false);
          $('joinErr').textContent = m.m;
          $('nameInput').focus();
        } else if (!S.joined) {
          S.fatal = true;
          $('joinErr').textContent = m.m;
          setJoinBusy(false);
        } else {
          toast(m.m);
        }
        break;
      default:
        break;
    }
  }

  const BOARD_TOP = 3; // rows shown in the panel; the dialog shows everyone
  function renderBoard(m) {
    $('total').textContent = fmtMoney(m.total);
    $('online').textContent = String(m.online);
    // same colours as the server picker: green below half full, orange from half, red from 80%
    const load = m.online / (S.maxPlayers || 20);
    $('onlinePill').className = 'pill online ' + (load >= 0.8 ? 'hot' : load >= 0.5 ? 'warm' : 'cool');
    S.board = m.board;
    const list = $('boardList');
    list.textContent = '';
    for (const e of m.board.slice(0, BOARD_TOP)) {
      const li = document.createElement('li');
      li.textContent = e.name + ' ';
      const span = document.createElement('span');
      span.textContent = fmtShort(e.score);
      li.appendChild(span);
      list.appendChild(li);
    }
    $('boardMore').hidden = m.board.length <= BOARD_TOP;
    if (!rankEl.hidden) renderRanking();
  }

  // Full ranking dialog: everyone online, best score first, then joining order.
  function renderRanking() {
    const list = $('rankList');
    list.textContent = '';
    for (const e of S.board || []) {
      const li = document.createElement('li');
      if (e.id === S.me) li.className = 'me';
      const who = document.createElement('div');
      who.className = 'who';
      const nm = document.createElement('b');
      nm.textContent = e.name;
      who.appendChild(nm);
      const p = S.players.get(e.id);
      const rl = p && ROLE_BY_ID[p.role];
      const sub = [rl ? rl.emoji + ' ' + rl.short : '', p && p.company ? p.company : ''].filter(Boolean).join(' · ');
      if (sub) {
        const s = document.createElement('small');
        s.textContent = sub;
        who.appendChild(s);
      }
      const sc = document.createElement('span');
      sc.className = 'sc';
      sc.textContent = fmtShort(e.score) + (e.breaks ? ' · ' + e.breaks + ' món' : '');
      li.append(who, sc);
      list.appendChild(li);
    }
  }
  const rankEl = $('ranking');
  function rankOpen() {
    renderRanking();
    rankEl.hidden = false;
    $('rankClose').focus();
  }
  function rankClose() {
    rankEl.hidden = true;
    $('boardMore').focus();
  }
  $('boardMore').addEventListener('click', rankOpen);
  $('rankClose').addEventListener('click', rankClose);
  rankEl.addEventListener('pointerdown', (e) => {
    if (e.target === rankEl) rankClose();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !rankEl.hidden) rankClose();
  });

  // ------------------------------------------------- VKL and health ----
  // The server runs the boss (walking, noticing people, punching) and every client just draws what it is told:
  // a position stream, a red circle during the windup, strikes, hit points and the bounty. Health works like
  // mana: the server sends the stored value plus how long ago it was stored, and each client adds the same
  // regeneration, so nothing needs to be sent while a bar refills.
  const narrowMQ = window.matchMedia('(max-width: 640px)');
  const BOSS_TARGET = -2; // value of S.attackId while tapping on the boss walks over and swings at it
  const hurtEl = $('hurt');

  function hpNow(p) {
    const c = S.hpCfg;
    if (!c) return 100;
    if (p.dead) return 0;
    const fast = Math.max(0, performance.now() - p.hpT - c.regenDelayMs);
    return Math.min(c.max, p.hp + (fast * c.regenPerSec) / 1000);
  }
  function bossHpNow() {
    const b = S.boss;
    if (!b) return 0;
    if (b.dead) return 0;
    const c = b.cfg;
    const e = Math.max(0, performance.now() - b.hpT);
    const fast = Math.max(0, e - c.regenDelayMs);
    return Math.min(c.maxHp, b.hp + (e * c.baseRegenPerSec + fast * c.regenPerSec) / 1000);
  }
  function initBoss(bc) {
    if (!bc) {
      S.boss = null;
      return;
    }
    const now = performance.now();
    S.boss = {
      cfg: bc,
      x: bc.x, y: bc.y, tx: bc.x, ty: bc.y,
      mode: bc.m,
      eng: bc.e || 0,
      hp: bc.hp,
      hpT: now - bc.ago,
      dead: !!bc.dead,
      respawnAt: bc.dead ? now + bc.respawnMs : 0,
      wind: null,
      pl: {
        id: -1, name: '👔 ' + bc.name, gender: 'boss', role: 'boss', company: '', hue: 0,
        x: bc.x, y: bc.y, heading: bc.d || 0, moving: false, swing: 0, emote: null, emoteT: 0, chat: '', chatT: 0,
        hpFrac: 1, alwaysHp: true, dead: false,
      },
    };
  }
  function bossObj() {
    const b = S.boss;
    return b && !b.dead ? { boss: true, x: b.x, y: b.y, broken: false } : null;
  }
  function bossMove(m) {
    const b = S.boss;
    if (!b) return;
    b.tx = m.x;
    b.ty = m.y;
    b.mode = m.m;
    b.eng = m.e || 0;
    b.pl.heading = m.d;
  }
  function bossWind(m) {
    const b = S.boss;
    if (!b || b.dead) return;
    b.wind = { x: m.x, y: m.y, r: m.r, ms: m.ms, t0: performance.now() };
    sfxWind(volumeAt(b.x, b.y));
  }
  function bossStrike(m) {
    const b = S.boss;
    if (b) {
      b.wind = null;
      b.pl.swing = 1;
    }
    const v = volumeAt(m.x, m.y);
    sfxPunch(v);
    S.shake = Math.min(1.4, S.shake + 0.55 * v);
    if (scene) for (let i = 0; i < 6; i++) scene.fx.smoke(m.x + rand(-m.r, m.r) * 0.7, 6, m.y + rand(-m.r, m.r) * 0.7);
  }
  function bossHit(m) {
    const b = S.boss;
    if (!b) return;
    const hitter = S.players.get(m.by);
    if (hitter) showSkill(hitter, m.skill, b);
    b.hp = m.hp;
    b.hpT = performance.now();
    const v = volumeAt(b.x, b.y);
    sfxHit(v);
    if (scene) {
      scene.fx.sparks(b.x, 120, b.y, 6);
      scene.fx.floatText(b.x + rand(-30, 30), 250, b.y, pick(HIT_WORDS), '#ffffff', 16);
    }
    if (m.by !== S.me) {
      const p = S.players.get(m.by);
      if (p) {
        p.swing = 1;
        p.d = b.x >= p.x ? 1 : -1;
        p.heading = Math.atan2(b.x - p.x, b.y - p.y);
      }
    }
  }
  function bossDown(m) {
    const b = S.boss;
    if (b) {
      b.dead = true;
      b.wind = null;
      b.respawnAt = performance.now() + (m.respawnMs || 0);
      b.hp = 0;
      if (scene) {
        for (let i = 0; i < 10; i++) scene.fx.smoke(b.x + rand(-50, 50), 20 + i * 12, b.y + rand(-50, 50));
        scene.fx.sparks(b.x, 140, b.y, 30);
      }
      sfxBreak(volumeAt(b.x, b.y));
    }
    S.shake = Math.min(1.4, S.shake + 0.9);
    const names = m.shares.map((s) => s.name);
    toast('🏆 VKL đã bị hạ gục! Tiền thưởng ' + fmtMoney(m.bounty) + ' chia theo sát thương');
    toast(m.shares.slice(0, 3).map((s, i) => i + 1 + '. ' + s.name + ' +' + fmtShort(s.bounty)).join('  ·  '));
    const mine = m.shares.find((s) => s.id === S.me);
    if (mine) toast('💰 Bạn nhận ' + fmtMoney(mine.bounty) + ' thưởng (gây ' + mine.dmg + ' sát thương)');
    else if (names.length) toast('Lần sau nhớ đánh cùng mọi người nhé');
  }
  function bossBack(m) {
    const b = S.boss;
    if (!b) return;
    b.dead = false;
    b.x = b.tx = b.pl.x = m.x;
    b.y = b.ty = b.pl.y = m.y;
    b.hp = b.cfg.maxHp;
    b.hpT = performance.now();
    b.wind = null;
    toast('👔 VKL đã quay lại phòng server');
  }
  function playerHurt(m) {
    const p = S.players.get(m.id);
    if (!p) return;
    p.hp = m.hp;
    p.hpT = performance.now();
    if (scene) scene.fx.floatText(p.x, 150, p.y, '-' + m.dmg, '#ff6b5a', 20);
    if (m.id === S.me) {
      hurtEl.classList.remove('on');
      void hurtEl.offsetWidth; // restart the animation
      hurtEl.classList.add('on');
      S.shake = Math.min(1.4, S.shake + 0.6);
      sfxHurt();
      if (navigator.vibrate) navigator.vibrate(60);
    }
  }
  function playerDown(m) {
    const p = S.players.get(m.id);
    if (!p) return;
    p.dead = true;
    p.hp = 0;
    p.deadAt = performance.now() + m.ms;
    p.moving = false;
    p.swing = 0;
    if (scene) scene.fx.floatText(p.x, 150, p.y, '-' + m.dmg, '#ff6b5a', 20);
    if (m.id === S.me) {
      S.keys.clear();
      S.smashHeld = false;
      S.target = null;
      S.attackId = null;
      hurtEl.classList.remove('on');
      void hurtEl.offsetWidth;
      hurtEl.classList.add('on');
      sfxHurt();
      $('downOverlay').hidden = false;
    } else toast('💀 ' + p.name + ' bị VKL hạ gục');
  }
  function playerUp(m) {
    const p = S.players.get(m.id);
    if (!p) return;
    p.dead = false;
    p.hp = S.hpCfg ? S.hpCfg.max : 100;
    p.hpT = performance.now();
    p.x = p.tx = m.x;
    p.y = p.ty = m.y;
    if (m.id === S.me) {
      $('downOverlay').hidden = true;
      S.target = null;
      if (scene) scene.cameraTo(m.x, m.y);
      toast('Bạn đã hồi sinh ở sảnh, nhớ né đòn nhé');
    }
  }

  // Per-frame upkeep: bars, the boss's smooth walk, the HUD pieces.
  function bossTick(dt) {
    const me = S.players.get(S.me);
    for (const p of S.players.values()) p.hpFrac = hpNow(p) / (S.hpCfg ? S.hpCfg.max : 100);
    if (me) {
      const pct = clamp(me.hpFrac, 0, 1);
      $('hpFill').style.transform = 'scaleX(' + pct.toFixed(3) + ')';
      $('hpFill').className = pct < 0.25 ? 'low' : pct < 0.55 ? 'mid' : '';
      $('hpNum').textContent = String(Math.round(pct * (S.hpCfg ? S.hpCfg.max : 100)));
      if (me.dead) $('downSecs').textContent = String(Math.max(0, Math.ceil((me.deadAt - performance.now()) / 1000)));
    }
    if (me) me.alwaysHp = narrowMQ.matches; // on a phone the health bar lives over the character instead of the top row
    const b = S.boss;
    if (!b || !me) {
      return;
    }
    const k = Math.min(1, dt * 12);
    const ox = b.x;
    const oy = b.y;
    b.x += (b.tx - b.x) * k;
    b.y += (b.ty - b.y) * k;
    b.pl.x = b.x;
    b.pl.y = b.y;
    b.pl.moving = Math.hypot(b.x - ox, b.y - oy) > 0.15;
    b.pl.swing = Math.max(0, b.pl.swing - dt * 3);
    b.pl.dead = false;
    b.pl.hpFrac = bossHpNow() / b.cfg.maxHp;
    b.pl.hpLabel = Math.ceil(Math.max(0, bossHpNow())).toLocaleString('vi-VN') + ' / ' + b.cfg.maxHp.toLocaleString('vi-VN');
  }

  // Room chat. Messages are broadcast to the room and never stored: the log keeps the last few lines for a
  // while in a frame under the system toasts, and each message also shows as a bubble over the speaker for 3 seconds.
  const CHAT_LINES = 60; // kept in the frame, scrolled to the newest
  const CHAT_BUBBLE_S = 3;
  const chatForm = $('chatForm');
  const chatInput = $('chatInput');
  const chatLog = $('chatLog');
  const coarseUi = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  function chatReceive(m) {
    if (typeof m.text !== 'string' || !m.text) return;
    const p = S.players.get(m.id);
    const li = document.createElement('li');
    li.className = 'chatline' + (m.id === S.me ? ' me' : '');
    const nm = document.createElement('b');
    nm.textContent = (p ? p.name : String(m.name || '?')) + ': ';
    li.append(nm, document.createTextNode(m.text)); // text nodes only: never HTML
    const atEnd = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40; // do not yank someone reading older lines
    chatLog.appendChild(li);
    while (chatLog.children.length > CHAT_LINES) chatLog.removeChild(chatLog.firstChild);
    if (atEnd || m.id === S.me) chatLog.scrollTop = chatLog.scrollHeight;
    chatWake();
    if (p) {
      p.chat = m.text;
      p.chatT = CHAT_BUBBLE_S;
    }
  }
  // The frame fades out after 3 seconds without a new message, and comes back with the next one, when the box is
  // focused (Enter or 💬) or while the pointer rests on it.
  const CHAT_IDLE_MS = 3000;
  let chatIdleTimer = 0;
  function chatWake() {
    chatLog.classList.remove('idle');
    clearTimeout(chatIdleTimer);
    chatIdleTimer = setTimeout(() => {
      if (document.activeElement !== chatInput && !chatLog.matches(':hover')) chatLog.classList.add('idle');
      else chatWake();
    }, CHAT_IDLE_MS);
  }
  function chatOpen() {
    if (coarseUi) chatForm.classList.add('open');
    chatInput.focus();
  }
  chatInput.addEventListener('focus', () => {
    S.keys.clear(); // a key held while clicking into the box must not keep walking
    S.smashHeld = false;
    chatWake();
  });
  chatInput.addEventListener('blur', () => {
    chatForm.classList.remove('open');
    chatWake();
  });
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') chatInput.blur();
  });
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.replace(/\s+/g, ' ').trim().slice(0, 120);
    chatInput.value = '';
    if (text && S.joined) send({ t: 'chat', text });
    chatInput.blur(); // back to the game: WASD walks again
  });
  $('chatSend').addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus so the click still sends
  $('chatBtn').addEventListener('click', chatOpen);

  // Exit door (west wall of the lobby): walking into the zone asks to leave the office. Leaving closes our
  // socket like any disconnect, so the others get the usual "left the server" toast and the score is kept.
  // A newer deploy exists: the page that is open is out of date. We find out three ways: the server we joined says so
  // (it belongs to a newer deploy than this page, or it already knows of one), an 'update' message while we play, or
  // being disconnected with code 4003. In every case the player gets a button that reloads the page.
  const MY_BUILD = (() => {
    try {
      return new URL(import.meta.url).searchParams.get('v') || '';
    } catch (e) {
      return '';
    }
  })();
  const updateEl = $('updateDlg');
  let updateTimer = 0;
  function showUpdate(kicked) {
    S.keys.clear();
    S.smashHeld = false;
    updateEl.hidden = false;
    if (kicked) {
      clearInterval(updateTimer);
      updateTimer = 0;
      $('updateNote').textContent = 'Game vừa được cập nhật nên bạn đã bị ngắt kết nối. Tải lại trang để vào bản mới, điểm của bạn vẫn được giữ.';
    } else startUpdateCountdown(); // a short countdown, then we disconnect (the server does the same)
  }
  $('updateReload').addEventListener('click', () => location.reload());
  // The deploy writes /version.json next to the page (see scripts/stamp-assets.js). An open page asks for it every 30 s
  // and when the tab comes back to the front: a different version means a deploy happened, so this page is out of date.
  // Whoever is playing gets the notice at once and is disconnected after a short countdown, whether or not any server
  // has told them. (Locally there is no such file and nothing happens.)
  function startUpdateCountdown() {
    if (updateTimer) return;
    let left = 20;
    const tick = () => {
      $('updateNote').textContent = 'Game vừa được cập nhật. Tải lại trang để chơi bản mới, điểm của bạn vẫn được giữ. Bạn sẽ bị ngắt kết nối sau ' + left + ' giây.';
      if (left-- <= 0) {
        S.fatal = true; // no reconnecting into an old page
        S.joined = false;
        for (const w of [S.pendingWs, S.ws]) if (w) w.close(1000);
        $('conn').hidden = true;
        showUpdate(true);
      }
    };
    updateTimer = setInterval(tick, 1000);
    tick();
  }
  async function checkVersion() {
    if (!MY_BUILD || !updateEl.hidden) return;
    try {
      const r = await fetch('/version.json', { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (j && typeof j.version === 'string' && j.version && j.version !== 'dev' && j.version !== MY_BUILD) {
        showUpdate(false);
      }
    } catch (e) { /* offline or no file: try again later */ }
  }
  setInterval(checkVersion, 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkVersion();
  });

  const exitEl = $('exitDlg');
  let exitArmed = true; // false after "Ở lại", until we have walked away from the door
  function inExit(me) {
    const e = S.world && S.world.exit;
    return !!e && me.x >= e.x0 - 30 && me.x <= e.x1 && me.y >= e.y0 && me.y <= e.y1;
  }
  function exitOpen() {
    S.keys.clear();
    S.smashHeld = false;
    S.target = null;
    S.attackId = null;
    exitEl.hidden = false;
    $('exitStay').focus();
  }
  function exitStay() {
    exitEl.hidden = true;
    exitArmed = false;
    const me = S.players.get(S.me);
    if (me && S.world && S.world.exit) S.target = { x: S.world.exit.x1 + 140, y: me.y }; // step back into the room
  }
  function exitLeave() {
    exitEl.hidden = true;
    S.fatal = true; // no auto-reconnect
    S.joined = false;
    S.keys.clear();
    S.smashHeld = false;
    S.target = null;
    S.attackId = null;
    chatLog.hidden = true;
    for (const ws of [S.pendingWs, S.ws]) if (ws) ws.close(1000);
    S.pendingWs = null;
    $('conn').hidden = true;
    $('overlay').classList.remove('gone');
    setJoinBusy(false);
    const err = $('joinErr');
    err.textContent = 'Bạn đã rời văn phòng. Bấm "Vào văn phòng" để quay lại, điểm của bạn vẫn còn.';
    err.classList.add('ok');
  }
  $('exitStay').addEventListener('click', exitStay);
  $('exitLeave').addEventListener('click', exitLeave);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !exitEl.hidden) exitStay();
  });

  // -------------------------------------------------------------- minimap ----
  const MM_ZONE = { tile: '#6d7f94', metal: '#505a6b', wood: '#6e5538' };
  const mm = { cv: $('minimap'), base: null, k: 1, dpr: 1, on: true, w: 0, h: 0 };
  try {
    mm.on = localStorage.getItem('br-minimap') !== '0';
  } catch (e) { /* ignore */ }
  mm.cv.classList.toggle('off', !mm.on);
  function mmToggle() {
    mm.on = !mm.on;
    if (typeof syncMapBtn === 'function') syncMapBtn();
    mm.cv.classList.toggle('off', !mm.on);
    try {
      localStorage.setItem('br-minimap', mm.on ? '1' : '0');
    } catch (e) { /* ignore */ }
  }
  mm.cv.addEventListener('click', mmToggle);
  const syncMapBtn = () => $('mapBtn').setAttribute('aria-pressed', String(mm.on));
  $('mapBtn').addEventListener('click', () => {
    mmToggle();
    syncMapBtn();
  });
  syncMapBtn();
  // graphics: high by default on computers, the safe (low) mode by default on touch screens; the choice is remembered
  {
    const coarseGfx = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    let q = coarseGfx ? 'low' : 'high';
    try {
      q = localStorage.getItem('br-gfx2') || q;
    } catch (e) { /* ignore */ }
    const applyGfx = () => {
      $('gfxBtn').setAttribute('aria-pressed', String(q === 'high'));
      $('gfxBtn').title = q === 'high' ? 'Đồ họa cao (bấm để chuyển sang chế độ an toàn)' : 'Chế độ an toàn (bấm để bật đồ họa cao)';
      if (scene && scene.setQuality) scene.setQuality(q);
    };
    $('gfxBtn').addEventListener('click', () => {
      q = q === 'high' ? 'low' : 'high';
      try {
        localStorage.setItem('br-gfx2', q);
      } catch (e) { /* ignore */ }
      applyGfx();
    });
    applyGfx();
  }
  // the static part: floor zones and walls/furniture, drawn once per welcome into an offscreen canvas
  function mmBuild(world, props, zones) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = mm.cv.clientWidth || 200;
    const ch = Math.round((cw * world.h) / world.w);
    mm.cv.style.height = ch + 'px';
    mm.cv.width = Math.round(cw * dpr);
    mm.cv.height = Math.round(ch * dpr);
    mm.k = mm.cv.width / world.w;
    mm.dpr = dpr;
    const base = document.createElement('canvas');
    base.width = mm.cv.width;
    base.height = mm.cv.height;
    const c = base.getContext('2d');
    c.fillStyle = '#252d3f';
    c.fillRect(0, 0, base.width, base.height);
    for (const z of zones) {
      c.fillStyle = MM_ZONE[z.k] || '#252d3f';
      c.fillRect(z.x0 * mm.k, z.y0 * mm.k, (z.x1 - z.x0) * mm.k, (z.y1 - z.y0) * mm.k);
    }
    for (const p of props) {
      if (p.k === 'rug') continue;
      c.fillStyle = p.k === 'wall' ? (p.opaque ? '#aab4c4' : '#9fd4ff') : p.k === 'sofa' ? '#3d5a80' : '#d9d2c5';
      const w = Math.max(1.5, p.w * mm.k);
      const h = Math.max(1.5, p.h * mm.k);
      c.fillRect(p.x * mm.k - w / 2, p.y * mm.k - h / 2, w, h);
    }
    if (world.exit) {
      c.fillStyle = '#3ddc84';
      c.fillRect(0, world.exit.y0 * mm.k, Math.max(3, 6 * mm.dpr), (world.exit.y1 - world.exit.y0) * mm.k);
    }
    mm.base = base;
  }
  function mmDraw() {
    if (!mm.on || !mm.base || !S.joined) return;
    const c = mm.cv.getContext('2d');
    c.drawImage(mm.base, 0, 0);
    for (const o of S.objects) {
      const t = S.types[o.type];
      const solid = t && t.w >= 44 && t.h >= 36 && o.type !== 'chair' && o.type !== 'plant';
      c.fillStyle = o.broken ? '#ff5d4a' : solid ? '#8b6f4e' : '#7a869a';
      const sz = Math.max(1.6, (solid ? t.w * 0.7 : 24) * mm.k);
      c.fillRect(o.x * mm.k - sz / 2, o.y * mm.k - sz / 2, sz, sz);
    }
    for (const p of S.players.values()) {
      if (p.id === S.me) continue;
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.arc(p.x * mm.k, p.y * mm.k, 2.6 * mm.dpr, 0, Math.PI * 2);
      c.fill();
    }
    if (S.boss && !S.boss.dead) {
      c.fillStyle = '#ff3b2a';
      c.strokeStyle = '#ffffff';
      c.lineWidth = 1.2 * mm.dpr;
      c.beginPath();
      c.arc(S.boss.x * mm.k, S.boss.y * mm.k, 4.6 * mm.dpr, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    }
    const me = S.players.get(S.me);
    if (me) {
      c.fillStyle = '#ffd34d';
      c.strokeStyle = '#000000';
      c.lineWidth = 1.2 * mm.dpr;
      c.beginPath();
      c.arc(me.x * mm.k, me.y * mm.k, 3.8 * mm.dpr, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    }
  }
  // On narrow screens the top bar wraps onto two rows and the damage board sits under it: keep the map below all of it.
  function mmPlace() {
    const narrow = window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
    if (!narrow) {
      mm.cv.style.top = '';
      return;
    }
    const board = $('board');
    const bottom = board ? board.getBoundingClientRect().bottom : 0;
    mm.cv.style.top = Math.max(56, Math.round(bottom) + 8) + 'px';
  }
  // the side buttons sit in the top-right corner, right under the damage board
  function sidePlace() {
    const board = $('board');
    if (!board) return;
    const top = Math.max(56, Math.round(board.getBoundingClientRect().bottom) + 8);
    $('sideBtns').style.top = top + 'px';
  }
  setInterval(() => {
    mmPlace();
    sidePlace();
    mmDraw();
    // zoom buttons fade out at the end of their range
    if (scene) {
      const z = scene.zoomLimits();
      $('zoomIn').classList.toggle('dim', z.atMin);
      $('zoomOut').classList.toggle('dim', z.atMax);
      $('zoomIn').setAttribute('aria-disabled', String(z.atMin));
      $('zoomOut').setAttribute('aria-disabled', String(z.atMax));
    }
  }, 250);

  // help panel: what the controls are on this device, plus the rules people only discover by accident
  const helpEl = $('help');
  function helpOpen() {
    const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const items = touch
      ? [
          '<b>Chạm vào nền</b> để đi tới đó, <b>chạm vào đồ vật</b> để đi tới và đập một cú.',
          '<b>Giữ nút ĐẬP!</b> để đập liên tục khi đã đứng cạnh đồ.',
          '<b>Bấm 💬</b> để nhắn cho cả phòng, tin hiện dưới thông báo và thành bong bóng trên đầu bạn vài giây.',
          '<b>Chụm hai ngón</b> hoặc bấm <b>+ / −</b> để zoom, nút <b>🗺</b> ẩn hiện bản đồ nhỏ.',
        ]
      : [
          '<b>WASD</b> hoặc <b>mũi tên</b> để đi, <b>Space</b> để đập (giữ để đập liên tục).',
          '<b>Enter</b> hoặc bấm vào ô chat để nhắn cho cả phòng, tin hiện dưới thông báo và thành bong bóng trên đầu bạn vài giây.',
          '<b>Lăn chuột</b> để zoom, <b>M</b> để ẩn hiện bản đồ nhỏ, <b>1 đến 8</b> để thả emoji.',
        ];
    items.push(
      '<b>Thanh xanh dưới tên bạn là mana.</b> Mỗi cú đập tốn một ít, hết thì phải nghỉ vài giây mới hồi.',
      'Đồ đã bị đập hiện <b>thanh máu</b>: xanh khi còn khoẻ, cam từ nửa trở xuống, đỏ ở cú cuối.',
      '<b>VKL</b> canh phòng server (kho tủ server 120 triệu). Bước vào là bị đấm: <b>vòng đỏ dưới đất</b> báo chỗ nắm đấm sắp rơi, chạy ra khỏi vòng là né được. Mỗi đấm mất 30 máu, hết 100 máu thì nằm 1 phút rồi hồi sinh ở sảnh.',
      'Một mình hay hai người không hạ nổi sếp (sếp tự hồi máu). <b>Từ 5 người</b> đánh cùng nhau thì được, sếp ngã thì <b>500 triệu tiền thưởng</b> chia theo sát thương. Sếp bị hạ sẽ quay lại sau 3 đến 5 phút.',
      'Máu của bạn tự hồi chậm sau vài giây không bị đánh. Ra khỏi phòng server là sếp không đuổi theo.',
      'Bấm nút <b>Skill</b> cạnh Gọi IT để đổi giữa <b>Đập búa</b>, <b>Ném ly trà sữa</b> và <b>Chích điện</b>. Dùng Space hoặc nút ra đòn trên màn hình cảm ứng.',
      'Đập đồ để cộng vào <b>tổng thiệt hại</b> của cả server. Bấm <b>Gọi IT</b> để thay hết đồ mới ngay.',
      'Đứng yên khoảng 3 phút thì bị ngắt kết nối để tiết kiệm tài nguyên, bấm vào lại là về đúng chỗ cũ.',
    );
    $('helpList').innerHTML = items.map((t) => '<li>' + t + '</li>').join('');
    helpEl.hidden = false;
    $('helpClose').focus();
  }
  function helpClose() {
    helpEl.hidden = true;
    $('helpBtn').focus();
  }
  $('helpBtn').addEventListener('click', helpOpen);
  $('helpClose').addEventListener('click', helpClose);
  helpEl.addEventListener('pointerdown', (e) => {
    if (e.target === helpEl) helpClose();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !helpEl.hidden) helpClose();
  });

  // ---------------------------------------------------------------- input ----
  function showSkill(p, skill, target) {
    p.skill = SKILLS.some(s => s.id === skill) ? skill : 'hammer';
    if (p.skill === 'milkTea' && scene) {
      const distance = 100 * S.milkTeaRangeMultiplier;
      const x = target ? target.x : p.x + Math.sin(p.heading) * distance;
      const y = target ? target.y : p.y + Math.cos(p.heading) * distance;
      scene.fx.milkTea(p.x, p.y, x, y);
    } else if (p.skill === 'electric' && scene) {
      const x = target ? target.x : p.x + Math.sin(p.heading) * 100;
      const y = target ? target.y : p.y + Math.cos(p.heading) * 100;
      scene.fx.electric(p.x, p.y, x, y);
    }
  }

  function attackRange(boss = false, margin = 0) {
    const base = boss ? S.boss.cfg.reach : S.hitRange;
    return (base - margin) * (S.skill === 'milkTea' ? S.milkTeaRangeMultiplier : 1);
  }

  function nearest() {
    const me = S.players.get(S.me);
    if (!me) return null;
    let best = null;
    let bestD = attackRange(false, 5);
    for (const o of S.objects) {
      if (o.broken) continue;
      const d = Math.hypot(o.x - me.x, o.y - me.y);
      if (d <= bestD) {
        best = o;
        bestD = d;
      }
    }
    const bo = bossObj();
    if (bo && S.boss) {
      const center = Math.hypot(bo.x - me.x, bo.y - me.y);
      if (center <= attackRange(true, 10) && center - S.boss.cfg.radius <= bestD) best = bo;
    }
    return best;
  }

  // Same regeneration rule as manaAt() in lib/realtime.js.
  function manaNow() {
    const c = S.manaCfg;
    if (!c || !S.mana) return 0;
    const e = Math.max(0, performance.now() - S.mana.t);
    const slow = Math.min(e, c.restMs);
    const fast = Math.max(0, e - c.restMs);
    return Math.min(c.max, S.mana.v + (slow * c.regen + fast * c.restRegen) / 1000);
  }

  function tryHit(o) {
    const me = S.players.get(S.me);
    if (!me || !o || o.broken || me.dead) return false;
    const now = performance.now();
    if (now - S.lastHit < 190) return false;
    if (S.manaCfg && manaNow() < S.manaCfg.cost) {
      S.manaEmptyT = 1; // flash the bar
      if (now - S.manaToastAt > 2500) {
        S.manaToastAt = now;
        toast('Hết mana, nghỉ tay một chút nhé');
      }
      return false;
    }
    if (Math.hypot(o.x - me.x, o.y - me.y) > attackRange(o.boss, o.boss ? 10 : 5)) return false;
    S.lastHit = now;
    send(o.boss ? { t: 'bhit', skill: S.skill } : { t: 'hit', id: o.id, skill: S.skill });
    me.skill = S.skill;
    me.heading = Math.atan2(o.x - me.x, o.y - me.y);
    me.swing = 1;
    me.d = o.x >= me.x ? 1 : -1;
    return true;
  }

  // Same push-out maths as lib/world.js resolveCollisions, so the client slides
  // along furniture exactly where the server would stop it.
  function resolve(x, y) {
    const r = 16;
    for (let pass = 0; pass < 2; pass++) {
      for (const c of S.colliders) {
        const cx = c[0];
        const cy = c[1];
        const hw = c[2];
        const hh = c[3];
        const dx = x - cx;
        const dy = y - cy;
        if (Math.abs(dx) > hw + r || Math.abs(dy) > hh + r) continue;
        const ex = dx - Math.max(-hw, Math.min(hw, dx));
        const ey = dy - Math.max(-hh, Math.min(hh, dy));
        const d2 = ex * ex + ey * ey;
        if (d2 >= r * r) continue;
        if (d2 > 1e-6) {
          const d = Math.sqrt(d2);
          x += (ex / d) * (r - d);
          y += (ey / d) * (r - d);
        } else {
          const px = hw - Math.abs(dx);
          const py = hh - Math.abs(dy);
          if (px < py) x += (dx >= 0 ? 1 : -1) * (px + r);
          else y += (dy >= 0 ? 1 : -1) * (py + r);
        }
      }
    }
    return { x, y };
  }

  function typing() {
    const tag = document.activeElement && document.activeElement.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA';
  }

  window.addEventListener('keydown', (e) => {
    if (!S.joined || typing() || !exitEl.hidden || !updateEl.hidden) return;
    const k = e.key.toLowerCase();
    if (MOVE_KEYS[k]) {
      e.preventDefault();
      S.keys.add(MOVE_KEYS[k]);
    } else if (k === ' ') {
      e.preventDefault();
      S.keys.add('space');
    } else if ((k === 'enter' || k === '/') && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); // so the / is not typed into the box that is about to get focus
      chatOpen();
    } else if (k === 'm' && !e.repeat) {
      mmToggle();
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

  // Two fingers on the canvas pinch to zoom (out as well as in); the zoom buttons do the same in steps.
  const fingers = new Map();
  let pinchLast = 0;
  const fingerDist = () => {
    const [a, b] = [...fingers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  canvas.addEventListener('pointermove', (e) => {
    if (!fingers.has(e.pointerId)) return;
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.size === 2 && scene) {
      const d = fingerDist();
      if (pinchLast > 0 && d > 0) scene.zoom(pinchLast / d - 1); // fingers apart: closer; together: further
      pinchLast = d;
    }
  });
  for (const ev of ['pointerup', 'pointercancel']) {
    canvas.addEventListener(ev, (e) => {
      fingers.delete(e.pointerId);
      pinchLast = 0;
    });
  }
  $('zoomIn').addEventListener('click', () => scene && scene.zoom(-0.2));
  $('zoomOut').addEventListener('click', () => scene && scene.zoom(0.25));

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (fingers.size >= 2) {
        S.target = null; // a second finger means pinching, not walking
        S.attackId = null;
        pinchLast = fingerDist();
        return;
      }
    }
    if (!S.joined || !scene) return;
    // Tap-to-walk and tap-to-smash are for touch screens (and pens). With a mouse, play with the keyboard.
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    const hit = scene.pick(e.clientX, e.clientY);
    if (!hit) return;
    if (hit.objectId !== undefined) {
      S.attackId = hit.objectId;
      S.target = null;
    } else if (S.boss && !S.boss.dead && Math.hypot(hit.x - S.boss.x, hit.y - S.boss.y) < 110) {
      S.attackId = BOSS_TARGET; // tapping on the boss walks over and swings at it
      S.target = null;
    } else {
      S.attackId = null;
      S.target = { x: clamp(hit.x, 20, S.world.w - 20), y: clamp(hit.y, 20, S.world.h - 20) };
    }
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (scene) scene.zoom(e.deltaY * 0.001);
    },
    { passive: false }
  );

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

  $('skillBtn').addEventListener('click', () => {
    const next = SKILLS[(SKILLS.findIndex(s => s.id === S.skill) + 1) % SKILLS.length];
    S.skill = next.id;
    $('skillBtn').textContent = next.label;
    $('smashBtn').textContent = next.action;
    toast(next.label + ' · Space hoặc nút ' + next.action + ' để dùng');
  });

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
    const done = () => toast('Đã copy link server, gửi cho đồng nghiệp nhé');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, () => toast(url));
    } else {
      toast(url);
    }
  });

  function showMute() {
    $('mute').textContent = S.muted ? '🔇' : '🔊';
    $('mute').setAttribute('aria-pressed', String(!S.muted));
  }
  try {
    S.muted = localStorage.getItem('br-sound') !== '1';
  } catch (e) { /* ignore */ }
  showMute();

  $('mute').addEventListener('click', () => {
    S.muted = !S.muted;
    showMute();
    if (!S.muted) initAudio();
    try {
      localStorage.setItem('br-sound', S.muted ? '0' : '1');
    } catch (e) { /* ignore */ }
  });

  // ----------------------------------------------------------------- join ----
  // The two rooms that exist (keep in sync with ROOMS in lib/world.js; the server sends
  // the live list with player counts, this is only the fallback if that request fails).
  const FALLBACK_ROOMS = [
    { id: 'br-1', name: 'BR-1' },
    { id: 'br-2', name: 'BR-2' },
  ];

  (function setupJoin() {
    const params = new URLSearchParams(location.search);
    const roomParam = (params.get('room') || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 24);
    let savedName = '';
    try {
      savedName = localStorage.getItem('br-name') || '';
    } catch (e) { /* ignore */ }
    $('nameInput').value = savedName;
    // company name (optional): free text, remembered like the name
    try {
      $('companyInput').value = (localStorage.getItem('br-company') || '').slice(0, 20);
    } catch (e) { /* ignore */ }
    // company role: a native select (one choice from a plain list), remembered like the name
    const roleSel = $('roleSelect');
    for (const r of ROLES) {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.emoji + '  ' + r.label;
      roleSel.appendChild(o);
    }
    try {
      const sr = localStorage.getItem('br-role');
      if (ROLE_BY_ID[sr]) roleSel.value = sr;
    } catch (e) { /* ignore */ }
    S.role = roleSel.value;
    roleSel.addEventListener('change', () => {
      S.role = roleSel.value;
      try {
        localStorage.setItem('br-role', S.role);
      } catch (e) { /* ignore */ }
    });
    // character gender: remembered like the name
    let savedGender = 'm';
    try {
      savedGender = localStorage.getItem('br-gender') === 'f' ? 'f' : 'm';
    } catch (e) { /* ignore */ }
    S.gender = savedGender;
    for (const r of document.querySelectorAll('input[name="gender"]')) {
      r.checked = r.value === savedGender;
      r.addEventListener('change', () => {
        S.gender = r.value;
        try {
          localStorage.setItem('br-gender', r.value);
        } catch (e) { /* ignore */ }
      });
    }
    $('nameInput').addEventListener('input', syncJoin);
    syncJoin();

    let rooms = FALLBACK_ROOMS.map((r) => ({ ...r, online: null, max: 20 }));
    let picked = rooms.some((r) => r.id === roomParam) ? roomParam : null;
    let chosenByUser = picked !== null;

    let loaded = false;
    let lastSig = '';

    function render() {
      const box = $('roomList');
      // Skip identical repaints: the page already shows the skeleton from the HTML, and rebuilding the
      // list every 15 s would restart animations and drop hover/focus.
      const sig = loaded ? JSON.stringify([rooms, picked]) : 'skeleton';
      if (sig === lastSig) return;
      lastSig = sig;
      box.setAttribute('aria-busy', String(!loaded));
      if (!loaded) {
        if (box.querySelector('.roomskel')) return; // the HTML skeleton is already there
        box.textContent = '';
        // Skeleton rows while the first /api/rooms answer is on its way.
        for (let i = 0; i < rooms.length; i++) {
          const s = document.createElement('div');
          s.className = 'roomskel';
          s.setAttribute('aria-hidden', 'true');
          box.appendChild(s);
        }
        return;
      }
      box.textContent = '';
      for (const r of rooms) {
        const full = r.online !== null && r.online >= r.max;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'roomcard' + (r.id === picked ? ' on' : '');
        b.setAttribute('aria-pressed', String(r.id === picked));
        b.disabled = full;
        const n = document.createElement('span');
        n.className = 'rn';
        n.textContent = r.name;
        const c = document.createElement('span');
        // Green while there is plenty of space, orange from 50% full, red from 80% (and when full).
        const load = r.online === null ? 0 : r.online / r.max;
        c.className = 'rc ' + (r.online === null ? '' : load >= 0.8 ? 'hot' : load >= 0.5 ? 'warm' : 'cool');
        c.textContent = r.online === null ? '' : (full ? 'Đầy · ' : '') + r.online + ' online';
        b.append(n, c);
        b.addEventListener('click', () => {
          picked = r.id;
          chosenByUser = true;
          render();
        });
        box.appendChild(b);
      }
    }

    // Until the player chooses, preselect the liveliest room that still has space.
    function preselect() {
      if (chosenByUser && rooms.some((r) => r.id === picked)) return;
      let best = null;
      for (const r of rooms) {
        if (r.online !== null && r.online >= r.max) continue;
        if (!best || (r.online || 0) > (best.online || 0)) best = r;
      }
      picked = (best || rooms[0]).id;
    }

    async function refresh(first) {
      try {
        let data;
        if (first && window.__rooms) {
          data = await window.__rooms; // already requested by the page head
          window.__rooms = null;
        } else {
          const res = await fetch('/api/rooms', { cache: 'no-store' });
          data = await res.json();
        }
        if (data && Array.isArray(data.rooms) && data.rooms.length) rooms = data.rooms;
      } catch (e) { /* keep what we have */ }
      loaded = true;
      preselect();
      render();
    }
    preselect();
    render();
    refresh(true);
    setInterval(() => {
      if (!$('overlay').classList.contains('gone')) refresh();
    }, 15000);

    $('joinForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('nameInput').value.trim();
      if (!name) return;
      if (!scene) {
        $('joinErr').textContent = 'Thiết bị hoặc trình duyệt này không bật được WebGL nên chưa chơi được bản 3D.';
        return;
      }
      try {
        localStorage.setItem('br-name', name);
      } catch (err) { /* ignore */ }
      S.name = name;
      S.company = $('companyInput').value.replace(/\s+/g, ' ').trim().slice(0, 20);
      try {
        localStorage.setItem('br-company', S.company);
      } catch (err) { /* ignore */ }
      S.room = picked || rooms[0].id;
      S.fatal = false;
      S.started = true;
      $('joinErr').textContent = '';
      $('joinErr').classList.remove('ok');
      setJoinBusy(true);
      initAudio();
      connect();
    });
  })();

  // --------------------------------------------------------------- update ----
  function update(dt) {
    S.t += dt;
    S.shake = Math.max(0, S.shake - dt * 3);
    if (!S.joined) return;

    const me = S.players.get(S.me);
    if (me) updateMe(me, dt);
    bossTick(dt);

    for (const p of S.players.values()) {
      if (p.id !== S.me) {
        const k = Math.min(1, dt * 12);
        const ox = p.x;
        const oy = p.y;
        p.x += (p.tx - p.x) * k;
        p.y += (p.ty - p.y) * k;
        p.moving = Math.hypot(p.x - ox, p.y - oy) > 0.15;
        if (p.moving && p.swing <= 0) p.heading = Math.atan2(p.tx - p.x, p.ty - p.y);
      }
      p.swing = Math.max(0, p.swing - dt * 3);
      if (p.emoteT > 0) p.emoteT -= dt;
      if (p.chatT > 0) p.chatT -= dt;
    }

    for (const o of S.objects) {
      o.shake = Math.max(0, o.shake - dt * 5);
      o.flash = Math.max(0, o.flash - dt * 6);
      o.pop = Math.max(0, o.pop - dt * 3);
    }
  }

  function updateMe(me, dt) {
    const now0 = performance.now();
    if (me.dead) {
      me.moving = false;
      return; // knocked out: no walking, no swinging until the server revives us
    }
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
      const o = S.attackId === BOSS_TARGET ? bossObj() : S.objects[S.attackId];
      if (!o || o.broken) {
        S.attackId = null;
      } else {
        const dist = Math.hypot(o.x - me.x, o.y - me.y);
        if (dist <= attackRange(o.boss, o.boss ? 25 : 15)) {
          if (tryHit(o)) S.attackId = null; // one tap, one smash
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
      const r = resolve(
        clamp(me.x + (dx / len) * step, 20, S.world.w - 20),
        clamp(me.y + (dy / len) * step, 20, S.world.h - 20)
      );
      me.x = clamp(r.x, 20, S.world.w - 20);
      me.y = clamp(r.y, 20, S.world.h - 20);
      if (Math.abs(dx) > 0.2) me.d = dx > 0 ? 1 : -1;
      if (me.swing <= 0) me.heading = Math.atan2(dx, dy);
    }
    me.moving = Math.hypot(me.x - ox, me.y - oy) > 0.1;

    if (inExit(me)) {
      if (exitArmed && exitEl.hidden) exitOpen();
    } else if (!exitEl.hidden) {
      exitEl.hidden = true;
    } else exitArmed = true;

    // a click-to-walk that is pinned against furniture gives up instead of pushing forever
    if (len > 0 && !me.moving && (S.target || S.attackId !== null) && !S.keys.size) {
      S.stuck += dt;
      if (S.stuck > 0.5) {
        S.target = null;
        S.attackId = null;
      }
    } else {
      S.stuck = 0;
    }

    if (S.keys.has('space') || S.smashHeld) {
      const target = nearest();
      if (target) tryHit(target);
      else if (me.swing <= 0 && now0 - S.lastAir >= 230) {
        // nothing in reach: swing anyway, so Space always feels like a hit (free, only the animation)
        S.lastAir = now0;
        me.swing = 1;
        showSkill(me, S.skill);
        send({ t: 'swing', skill: S.skill, h: Math.round(me.heading * 100) / 100 });
      }
    }

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
    if (scene) scene.resize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', resize);
  resize();

  // ----------------------------------------------------------------- loop ----
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    if (S.manaCfg) S.manaFrac = manaNow() / S.manaCfg.max;
    if (S.manaEmptyT > 0) S.manaEmptyT = Math.max(0, S.manaEmptyT - dt * 2.5);
    if (scene && S.joined) scene.update(dt, S);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
