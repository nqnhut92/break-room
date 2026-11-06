import { createGameAudio, distanceVolume } from './audio.js';
import './actor-collision.js';
import { accountUI } from './account.js';
import { renderIcons, setButtonIcon } from './vendor/lucide-icons.js';
import { createScene3D } from './scene3d.js';
import { ROLES, ROLE_BY_ID } from './roles.js';

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  renderIcons();
  const viewport = window.GameViewport;

  // The join button is only usable with a name, and not while a join is in flight.
  let joinBusy = false;
  function syncJoin() {
    $('joinBtn').disabled = joinBusy || $('joinBtn').dataset.accountBusy === 'true' || !$('nameInput').value.trim();
  }
  function setJoinBusy(b) {
    joinBusy = b;
    syncJoin();
    if (!b) document.documentElement.classList.remove('autojoin');
  }
  // Reloading the page (F5, or the "new version" button) should put you straight back in the office, not at the join
  // form. The tab remembers that it was in a game; leaving on purpose, being kicked for inactivity, being replaced by
  // another tab or a refused join clears it, and a new tab always starts at the form.
  const autoJoin = {
    set() {
      try {
        sessionStorage.setItem('br-auto', '1');
      } catch (e) { /* ignore */ }
    },
    clear() {
      try {
        sessionStorage.removeItem('br-auto');
      } catch (e) { /* ignore */ }
      document.documentElement.classList.remove('autojoin');
    },
    on() {
      try {
        return sessionStorage.getItem('br-auto') === '1';
      } catch (e) {
        return false;
      }
    },
  };
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
    { id: 'hammer', icon: 'hammer', label: 'Skill: Đập búa', action: 'ĐẬP!' },
    { id: 'milkTea', icon: 'cup-soda', label: 'Skill: Ném ly trà sữa', action: 'NÉM!' },
    { id: 'electric', icon: 'zap', label: 'Skill: Chích điện', action: 'CHÍCH!' },
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
    minis: new Map(), miniVersion: 0,
    snakes: new Map(),
    objects: [],
    duel: null,
    boss: null, // VKL of this server (see the boss section)
    hpCfg: null,
    keys: new Set(),
    target: null,
    attackId: null,
    smashHeld: false,
    respawnMs: 0, respawnPolicy: null,
    joystick: { x: 0, y: 0, pointerId: null, pointerType: null },
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
  const audio = createGameAudio(() => S.muted);
  const initAudio = () => { if (!S.muted) return audio.init(); };
  const sfxHit = (v, type = 'body', skill = 'hammer') => audio.hit(v, type, skill);
  const sfxBreak = (v, type) => audio.break(v, type);
  const sfxPunch = (v,kind) => audio.strike(v,kind);
  const sfxWind = (v, kind) => audio.cue(v, kind);
  const sfxHurt = () => audio.hurt();
  const sfxReset = () => audio.reset();
  function volumeAt(x, y) {
    const me = S.players.get(S.me);
    return me ? distanceVolume(Math.hypot(x-me.x,y-me.y)) : 0;
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
  // A "bạn sếp" gives itself away when it stabs or when somebody hits it. From then on it carries a label and a health bar.
  const MOLE_HP = 8;
  function setRage(v) {
    S.rage = v;
    const full = S.rageMax > 0 && v >= S.rageMax;
    $('rageFill').style.transform = 'scaleX(' + Math.max(0, Math.min(1, v / (S.rageMax || 100))).toFixed(3) + ')';
    $('ragePill').classList.toggle('full', full);
    $('ultBtn').hidden = !full;
  }
  function revealMole(id, hp) {
    const p = S.players.get(id);
    if (!p) return null;
    p.mole = true;
    p.moleHp = hp;
    p.alwaysHp = true;
    p.company = '🐍 BẠN SẾP';
    return p;
  }

  function addPlayer(p) {
    S.players.set(p.id, {
      id: p.id, name: p.name, hue: p.hue, gender: p.gender === 'f' ? 'f' : 'm', role: ROLE_BY_ID[p.role] ? p.role : 'nv', company: String(p.company || ''),
      x: p.x, y: p.y, tx: p.x, ty: p.y, d: p.d || 1,
      swing: 0, emote: null, emoteT: 0, chat: '', chatT: 0, skill: 'hammer',
      hp: typeof p.hp === 'number' ? p.hp : 100, hpT: performance.now() - (p.hpAgo || 0), hpFrac: 1,
      dead: (p.deadMs || 0) > 0, deadAt: performance.now() + (p.deadMs || 0), moving: false, heading: 0,
      shieldUntil: performance.now() + (p.shieldMs || 0), // spawn protection: no damage until it ends, you move or you attack
    });
  }

  function makeObject(o) {
    const max = S.types[o.type].hp;
    return {
      id: o.id, type: o.type, x: o.x, y: o.y, rot: o.rot || 0, arm: !!o.arm, itDesk: !!o.itDesk, screenScale: o.screenScale || 0,
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
      $('drinkBtn').hidden = true;
      clearTimeout(drinkTimer);
      if (S.pendingWs) return; // a replacement is already joining; it takes over
      if (ev && ev.code === 4004) {
        exitLeave();
        $('joinErr').textContent = 'Phiên đăng nhập hoặc phiên chơi đã kết thúc. Tải lại trang để đăng nhập lại nhé.';
        return;
      }
      if (ev && ev.code === 4002) {
        // kicked for inactivity: do not reconnect on our own, that would defeat the purpose
        autoJoin.clear();
        S.fatal = true;
        S.joined = false;
        syncOrientation();
        S.keys.clear();
        resetJoystick();
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
        syncOrientation();
        $('conn').hidden = true;
        showUpdate(true);
        return;
      }
      if (ev && ev.code === 4001) {
        autoJoin.clear();
        S.fatal = true;
        S.joined = false;
        syncOrientation();
        $('conn').textContent = 'Server này đang mở ở tab khác. Đóng tab kia hoặc tải lại trang.';
        $('conn').hidden = false;
        return;
      }
      scheduleReconnect(ws);
    };
  }

  function scheduleReconnect(ws) {
    S.joined = false;
    syncOrientation();
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
        S.officePatrol = m.officePatrol || null;
        if (m.guestTemporary) toast('Chưa kiểm tra được tên đã giữ. Bạn đang dùng tên khách tạm trên server này.');
        if (m.newer || (m.build && m.build !== 'dev' && MY_BUILD && m.build !== MY_BUILD)) showUpdate(false);
        $('drinkBtn').hidden = true;
        clearTimeout(drinkTimer);
        drinkId = 0; drinkClaimed = 0; drinkExpires = 0;
        if (m.drink && m.drink.available) showDrinkOffer(m.drink);
        S.me = m.you;
        S.room = m.room;
        S.world = m.world;
        S.types = m.types;
        S.colliders = m.colliders;
        S.hitRange = m.hitRange;
        S.respawnMs = Number(m.respawnMs) || 0;
        S.respawnPolicy = m.respawnPolicy || null;
        S.milkTeaRangeMultiplier = m.milkTeaRangeMultiplier || 2;
        S.manaCfg = m.mana;
        S.maxPlayers = m.maxPlayers || 20;
        S.chatHistory = !!m.chatHistory;
        S.roomLabel = m.roomLabel || '';
        S.hpCfg = m.player || { max: 100, regenDelayMs: 4000, regenPerSec: 5 };
        S.mana = { v: m.mana.v, t: performance.now() - m.mana.ago };
        S.players = new Map();
        m.players.forEach(addPlayer);
        { const self = S.players.get(S.me); if (self && m.shieldMs) { self.shieldUntil = performance.now() + m.shieldMs; toast('🛡️ Được bảo vệ ' + Math.round(m.shieldMs / 1000) + ' giây. Di chuyển hoặc đánh là hết.'); } }
        for (const f of m.moles || []) revealMole(f.id, f.hp);
        S.rageMax = (m.rage && m.rage.max) || 100;
        setRage((m.rage && m.rage.v) || 0);
        S.objects = m.objects.map(makeObject);
        S.snakes = new Map((m.snakes || []).map(s => [s.id, { ...s, tx: s.x, ty: s.y }]));
        S.minis.clear(); S.miniVersion = 0;
        receiveMinis(m.minis);
        initBoss(m.boss);
        receiveDuel({ state: m.duel, ...m.duel }, true);
        const meNow = S.players.get(S.me);
        $('downOverlay').hidden = !(meNow && meNow.dead); // refreshing while knocked out keeps the countdown
        S.target = null;
        S.attackId = null;
        if (scene) scene.build(m.world, m.props, m.zones);
        mm.rooms = m.rooms || [];
        mmBuild(m.world, m.props, m.zones);
        S.joined = true;
        syncOrientation();
        autoJoin.set();
        document.documentElement.classList.remove('autojoin');
        $('overlay').classList.add('gone');
        $('hud').hidden = false;
        if (chatLog.hidden) {
          chatLog.textContent = ''; // a fresh join starts with an empty frame (history fills it); a reconnect keeps what was said
          chatSeen.clear();
          S.chatLastSeen = null;
          S.chatMore = undefined;
          chatLog.hidden = false;
        } else S.chatLastSeen = chatNewest();
        chatWake();
        $('conn').hidden = true;
        $('roomName').textContent = m.roomLabel || S.room;
        try {
          history.replaceState(null, '', '?server=' + encodeURIComponent(S.room));
        } catch (e) { /* ignore */ }
        if (!S.welcomed) {
          S.welcomed = true;
          const hint = $('hint');
          const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
          if (touch) hint.textContent = 'Kéo núm trái để đi · giữ nút ĐẬP! để đập liên tục · chụm hai ngón để zoom';
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
        if (p && !p.mole) toast(p.name + ' đã rời server');
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
      case 'position': {
        const p = S.players.get(m.id);
        if (p && !p.forcedMotion) { p.x = p.tx = m.x; p.y = p.ty = m.y; }
        break;
      }
      case 'bduel':
        receiveDuel(m);
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
      case 'deaths':
        S.deaths = m.list;
        S.deathsMine = m.mine;
        if (!rankEl.hidden) renderRanking();
        break;
      case 'rage':
        setRage(m.v);
        break;
      case 'ult': {
        const who = S.players.get(m.id);
        if (who) {
          who.swing = 1;
          who.ultUntil = performance.now() + 900;
          if (SKILLS.some((s) => s.id === m.skill)) who.skill = m.skill;
          who.heading = Math.atan2(m.x - who.x, m.y - who.y);
          showSkill(who, who.skill, { x: m.x, y: m.y });
        }
        if (scene) {
          scene.fx.sparks(m.x, 80, m.y, 30);
          scene.fx.floatText(m.x, 190, m.y, m.target === 'boss' ? 'ULTI! -' + m.dmg : 'ULTI!', '#ffd24a', 28);
        }
        S.shake = Math.min(1.6, S.shake + 1.1 * volumeAt(m.x, m.y));
        sfxHit(volumeAt(m.x, m.y), 'body', m.skill);
        break;
      }
      case 'hp':
        playerHurt(m);
        break;
      case 'down':
        playerDown(m);
        break;
      case 'up':
        playerUp(m);
        break;
      case 'blocked': {
        const p = S.players.get(m.id);
        if (p && scene) scene.fx.floatText(p.x, 150, p.y, '🛡️ CHẶN!', '#8fd3ff', 18);
        break;
      }
      case 'shield': {
        const p = S.players.get(m.id);
        if (p) p.shieldUntil = performance.now() + (m.ms || 0);
        break;
      }
      case 'mana':
        if (S.manaCfg) S.mana = { v: m.v, t: performance.now() - m.ago };
        break;
      case 'update':
        showUpdate(false);
        break;
      case 'skill': {
        if (m.id !== S.me) {
          const p = S.players.get(m.id);
          if (p && SKILLS.some((s) => s.id === m.skill)) p.skill = m.skill;
        }
        break;
      }
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
      case 'miniState':
        receiveMinis(m.state);
        break;
      case 'miniHit': {
        const b = S.minis.get(m.id), p = S.players.get(m.by);
        if (!b) break;
        if (p) { showSkill(p, m.skill, b); p.swing = 1; p.heading = Math.atan2(b.x - p.x, b.y - p.y); if (m.ult) p.ultUntil = performance.now() + 700; }
        b.pl.hitUntil = performance.now() + 160;
        if (m.skill === 'electric') b.pl.electricUntil = performance.now() + 700;
        sfxHit(volumeAt(b.x, b.y), 'body', m.skill);
        if (scene) { scene.fx.sparks(b.x, 100, b.y, 6); scene.fx.floatText(b.x, 180, b.y, '-' + Math.round(m.dmg), '#ffd27c', 20); }
        if (m.hp <= 0) toast(m.id + ' bị hạ! Thưởng ' + b.cfg.bounty + ' triệu, hồi sinh sau 30 giây.');
        break;
      }
      case 'miniStrike': {
        const b = S.minis.get(m.id);
        if (b) { b.pl.swing = 1; b.wind = null; }
        sfxPunch(volumeAt(m.x, m.y),'mini');
        break;
      }
      case 'snakeSpawn':
        for (const s of m.snakes) S.snakes.set(s.id, { ...s, tx: s.x, ty: s.y });
        if (S.boss && !S.boss.dead) {
          S.boss.cast = { kind: 'summon', until: performance.now() + 1300 };
          if (scene) scene.fx.summon(m.x ?? S.boss.x, m.y ?? S.boss.y);
          sfxWind(volumeAt(S.boss.x, S.boss.y));
        }
        toast('🐍 Chiêu ẩn của VKL! Rắn xuất hiện ở mốc ' + m.waves.join('%, ') + '% máu.');
        break;
      case 'snakePs':
        for (const p of m.list) { const s = S.snakes.get(p.id); if (s) { s.tx = p.x; s.ty = p.y; s.d = p.d; } }
        break;
      case 'snakeHit': {
        const s = S.snakes.get(m.id), attacker = S.players.get(m.by);
        if (!s) break;
        if (attacker) { attacker.swing = 1; attacker.heading = Math.atan2(s.x - attacker.x, s.y - attacker.y); showSkill(attacker, m.skill, s); }
        s.hp = m.hp;
        s.hitUntil = performance.now() + 250;
        if (scene) scene.fx.sparks(s.x, 20, s.y, 5);
        if (m.hp <= 0) {
          if (scene) scene.fx.debris(s.x, 15, s.y, 10, ['#86e66e', '#c8ffae', '#40a957']);
          S.snakes.delete(m.id);
        }
        break;
      }
      case 'drinkOffer':
        showDrinkOffer(m);
        break;
      case 'drink':
        drinkClaimed = Math.max(drinkClaimed, m.id);
        clearTimeout(drinkTimer);
        $('drinkBtn').hidden = true;
        toast('🧃 ' + m.name + ' mời nước! Cả server được hồi đầy máu và mana.');
        break;
      case 'heal': {
        const p = S.players.get(m.id);
        if (p) {
          p.hp = m.hp;
          p.hpT = performance.now();
          if (scene) scene.fx.floatText(p.x, 150, p.y, '♥ + MANA', '#7df3ba', 18);
        }
        break;
      }
      case 'moleReveal': {
        const mole = revealMole(m.id, m.hp);
        if (mole && scene) scene.fx.floatText(mole.x, 170, mole.y, '🐍 BẠN SẾP!', '#ff5a5a', 22);
        break;
      }
      case 'moleStab': {
        const mole = S.players.get(m.id);
        const target = S.players.get(m.target);
        if (!mole) break;
        mole.swing = 1;
        mole.skill = 'hammer';
        mole.heading = m.h || 0;
        if (target) showSkill(mole, 'hammer', target);
        if (m.first && target && scene) {
          scene.fx.sparks(target.x, 65, target.y, 10);
          scene.fx.floatText(target.x, 110, target.y, 'ĐÂM LÉN!', '#ff5a5a', 20);
        }
        break;
      }
      case 'moleHit': {
        const mole = revealMole(m.id, m.hp);
        const attacker = S.players.get(m.by);
        if (!mole || !attacker) break;
        attacker.swing = 1;
        attacker.heading = Math.atan2(mole.x - attacker.x, mole.y - attacker.y);
        showSkill(attacker, m.skill, mole);
        mole.hitUntil = performance.now() + 300;
        if (scene && m.skill !== 'milkTea') scene.fx.sparks(mole.x, 65, mole.y, 8);
        if (scene) scene.fx.floatText(mole.x, 130, mole.y, m.skill === 'electric' ? '⚡ TÊ TÊ!' : m.skill === 'milkTea' ? 'TRÀ SỮA!' : 'BỐP!', '#ffd24a', 18);
        sfxHit(volumeAt(mole.x, mole.y), 'body', m.skill);
        break;
      }
      case 'moleDead': {
        const mole = S.players.get(m.id);
        const killer = S.players.get(m.by);
        toast('🐍 ' + (killer ? killer.name : 'Ai đó') + ' hạ gục bạn sếp ' + (mole ? mole.name : '') + '! +' + m.cost);
        if (mole && scene) scene.fx.floatText(mole.x, 150, mole.y, '+' + m.cost, '#7df3ba', 24);
        if (mole) S.shake = Math.min(1, S.shake + 0.4 * volumeAt(mole.x, mole.y));
        break;
      }
      case 'phit': {
        const victim = S.players.get(m.id);
        const attacker = S.players.get(m.by);
        if (!victim || !attacker) break;
        attacker.swing = 1;
        attacker.heading = Math.atan2(victim.x - attacker.x, victim.y - attacker.y);
        showSkill(attacker, m.skill, victim);
        victim.hitUntil = performance.now() + 300;
        if (scene && m.skill !== 'milkTea') scene.fx.sparks(victim.x, 65, victim.y, 8);
        if (scene) scene.fx.floatText(victim.x, 130, victim.y, m.skill === 'electric' ? '⚡ TÊ TÊ!' : m.skill === 'milkTea' ? 'TRÀ SỮA!' : 'BỐP!', '#b8efff', 16);
        sfxHit(volumeAt(victim.x, victim.y), 'body', m.skill);
        break;
      }
      case 'officePatrol':
        if (!S.officePatrol || m.state.version >= S.officePatrol.version) S.officePatrol = m.state;
        // The patrol's end cancels any wind-up on the server without a strike: clear the warning circles now.
        if (m.state.phase !== 'active') { if (S.boss) S.boss.wind = null; for (const b of S.minis.values()) b.wind = null; }
        positionOfficeNotice();
        break;
      case 'serverShock': {
        const o = S.objects[m.id], p = S.players.get(m.by);
        if (!o) break;
        o.electricUntil = performance.now() + 450;
        if (p) p.electricUntil = performance.now() + 450;
        if (scene) {
          scene.fx.sparks(o.x, objTop(o), o.y, 14);
          scene.fx.electric(o.x, o.y, p ? p.x : o.x + 25, p ? p.y : o.y + 20, 90);
        }
        if (m.bossDamage > 0) floatText(o, 65, 'VKL −' + m.bossDamage + ' HP', '#ffd24a', 20);
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
        if (o.type !== 'server') floatText(o, 22, roleWords && Math.random() < 0.4 ? pick(roleWords) : pick(HIT_WORDS), '#ffffff', 16);
        const v = volumeAt(o.x, o.y);
        sfxHit(v, o.type, m.skill);
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
        sfxBreak(v, o.type);
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
      case 'rank':
        S.myRank = { rank: m.rank, score: m.score, breaks: m.breaks };
        S.boardCount = m.count || S.boardCount;
        if (!rankEl.hidden) renderRanking();
        break;
      case 'chatAck':
        chatPending.delete(m.cid);
        break;
      case 'chatFail':
        chatPending.delete(m.cid);
        toast(m.m || 'Chưa gửi được tin nhắn.');
        break;
      case 'chatHist':
        chatHistory(m);
        break;
      case 'info':
        toast(m.m);
        break;
      case 'err':
        if (m.code === 'name' || !S.joined) autoJoin.clear(); // a refused join (name taken, room full...) shows the form with the reason
        if (m.code === 'name') {
          // name missing or taken (also if someone took it while we were reconnecting): back to the join form
          S.fatal = true;
          S.joined = false;
          syncOrientation();
          S.keys.clear();
          resetJoystick();
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
    S.boardCount = m.count || m.board.length;
    if (m.selfs && m.selfs[0]) S.myRank = { rank: m.selfs[0].rank, score: m.selfs[0].tenths / 10, breaks: m.selfs[0].breaks };
    if (m.room) $('boardTitle').textContent = 'BXH hôm nay · ' + (S.roomLabel || m.room.toUpperCase());
    // our own row is outside the rows everyone receives: ask for our rank (the server throttles this)
    if (S.joined && S.me && !m.board.some((e) => e.id === S.me)) {
      if (!S.rankAskAt || Date.now() - S.rankAskAt > 2000) { S.rankAskAt = Date.now(); send({ t: 'rank' }); }
    } else S.myRank = null;
    const list = $('boardList');
    list.textContent = '';
    for (const e of m.board.slice(0, BOARD_TOP)) {
      const li = document.createElement('li');
      li.textContent = (e.rank ? e.rank + '. ' : '') + e.name + ' ';
      const span = document.createElement('span');
      span.textContent = fmtShort(e.score);
      li.appendChild(span);
      list.appendChild(li);
    }
    $('boardMore').hidden = false; // the dialog also holds the knock-out tab, so it is always reachable
    if (!rankEl.hidden) renderRanking();
  }

  // Full ranking dialog: today's top rows (online or not), our own row if outside them. The deaths tab ranks today's knock-outs the same way.
  function renderRanking() {
    const list = $('rankList');
    list.textContent = '';
    const byDeaths = S.rankMode === 'deaths';
    $('rankTabScore').setAttribute('aria-selected', String(!byDeaths));
    $('rankTabDeaths').setAttribute('aria-selected', String(byDeaths));
    let rows = S.board || [];
    if (byDeaths) {
      // today's "bị sa thải" ranking from the server: top rows including players who are offline now
      rows = (S.deaths || []).map((e) => ({ ...e, deaths: e.n }));
      if (S.deathsMine && !rows.some((e) => e.id === S.me)) rows.push({ id: S.me, name: 'Bạn', rank: S.deathsMine.rank, deaths: S.deathsMine.n });
      if (!(S.deaths || []).length) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'Hôm nay chưa ai bị sa thải. Đi gặp sếp đi 😈';
        list.appendChild(li);
      }
    }
    if (!byDeaths && S.myRank && !rows.some((e) => e.id === S.me)) rows = rows.concat([{ id: S.me, name: 'Bạn', rank: S.myRank.rank, score: S.myRank.score, breaks: S.myRank.breaks, out: true }]);
    for (const e of rows) {
      const li = document.createElement('li');
      if (e.id === S.me) li.className = 'me';
      else if (e.id === undefined) li.className = 'off'; // played today, not online now
      const who = document.createElement('div');
      who.className = 'who';
      const nm = document.createElement('b');
      nm.textContent = e.name;
      li.dataset.rank = e.rank || String(list.children.length + 1); // the left column shows the server's rank (ties share it)
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
      sc.textContent = byDeaths ? '💀 ' + e.deaths + ' lần bị sa thải hôm nay' : fmtShort(e.score) + (e.breaks ? ' · ' + e.breaks + ' món' : '');
      li.append(who, sc);
      list.appendChild(li);
    }
  }
  const rankEl = $('ranking');
  function rankMode(mode) {
    S.rankMode = mode;
    if (mode === 'deaths') send({ t: 'deaths' });
    renderRanking();
  }
  $('rankTabScore').addEventListener('click', () => rankMode('score'));
  $('rankTabDeaths').addEventListener('click', () => rankMode('deaths'));
  function rankOpen() {
    if (S.rankMode === 'deaths') send({ t: 'deaths' });
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

  function receiveMinis(state) {
    if (!state || state.version <= S.miniVersion) return;
    S.miniVersion = state.version;
    for (const item of state.list) {
      let b = S.minis.get(item.id);
      if (!b) {
        b = { x: item.x, y: item.y, pl: { id: item.id === 'TML' ? -10 : -11, mini: item.id, name: item.id, gender: 'm', role: '', company: '', hue: item.id === 'TML' ? 32 : 280, heading: item.d, swing: 0, emote: null, emoteT: 0, chat: '', chatT: 0, alwaysHp: true } };
        S.minis.set(item.id, b);
      }
      const wasDead = b.hp <= 0;
      // Snapshots arrive about five times a second. Chasing each one with a plain ease makes a walker lurch and stall, so
      // keep the speed the server just showed us and keep walking at it until the next snapshot corrects the course.
      const at = performance.now(), dtSnap = (at - (b.snapT || 0)) / 1000;
      const walking = item.mode === 'chase' || item.mode === 'wander';
      if (walking && b.snapT && dtSnap > 0.04 && dtSnap < 1 && item.hp > 0 && b.hp > 0) {
        const vx = (item.x - b.tx) / dtSnap, vy = (item.y - b.ty) / dtSnap;
        b.vx = Math.hypot(vx, vy) < 700 ? vx : 0; // a respawn teleport is not a speed
        b.vy = Math.hypot(vx, vy) < 700 ? vy : 0;
      } else { b.vx = 0; b.vy = 0; }
      b.snapT = at;
      b.cfg = item.cfg; b.hp = item.hp; b.mode = item.mode; b.tx = item.x; b.ty = item.y; b.d = item.d;
      if (wasDead && item.hp > 0) { b.x = item.x; b.y = item.y; }
      b.wind = item.wind ? { ...item.wind, t0: performance.now() - (item.wind.ms - item.wind.remainingMs) } : null;
    }
  }
  function miniTick(dt) {
    for (const b of S.minis.values()) {
      const age = Math.min(0.35, (performance.now() - (b.snapT || 0)) / 1000); // never run on past a missed snapshot
      const gx = b.tx + (b.vx || 0) * age, gy = b.ty + (b.vy || 0) * age;
      const ox = b.x, oy = b.y, k = Math.min(1, dt * 10);
      b.x += (gx - b.x) * k; b.y += (gy - b.y) * k;
      const p = b.pl;
      p.x = b.x; p.y = b.y; p.heading = b.d; p.dead = b.hp <= 0;
      p.moving = Math.hypot(b.x - ox, b.y - oy) > 0.15; // legs move when the body does
      p.swing = Math.max(0, p.swing - dt * 3.5);
      p.hpFrac = b.hp / b.cfg.maxHp;
      p.hpLabel = Math.ceil(b.hp).toLocaleString('vi-VN') + ' / ' + b.cfg.maxHp.toLocaleString('vi-VN');
      p.name = (b.mode === 'idle' || b.mode === 'wander' || b.mode === 'dead' ? '' : '💢 ') + p.mini;
    }
  }
  function miniObj(id) {
    const b = S.minis.get(id);
    return b && b.hp > 0 ? { mini: true, id, x: b.x, y: b.y } : null;
  }
  function targetRange(o, margin = 0) {
    return o.mini ? (S.minis.get(o.id).cfg.reach - margin) * (S.skill === 'milkTea' ? S.milkTeaRangeMultiplier : 1) : attackRange(o.boss, margin);
  }

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
      hpRev: bc.rev || 0,
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
  function duelActive() {
    return !!(S.duel?.target && performance.now() < S.duel.until && !S.boss?.dead);
  }
  function receiveDuel(m, welcome = false) {
    const state = m.state;
    if (!state) { S.duel = null; return; }
    if (!welcome && S.duel && state.version <= S.duel.version) return;
    const wasActive = duelActive();
    S.duel = { ...state, bounds: m.bounds, apologyAt: performance.now() + Math.max(0, m.apologyMs || 0), until: performance.now() + Math.max(0, m.ms || 0) };
    if (!duelActive()) {
      $('duelBanner').hidden = true;
      if (wasActive && !welcome) toast('🔓 Kết thúc 1:1, phòng server đã mở lại.');
      return;
    }
    if (welcome) return; // reconnect restores the remaining timer, never replays the pull
    S.keys.clear(); resetJoystick(); S.smashHeld = false; S.target = null; S.attackId = null;
    if (S.boss) { S.boss.wind = null; S.boss.cast = { kind: 'duel', until: performance.now() + 1200 }; }
    const captured = S.players.get(state.target);
    toast('🪢 VKL kéo ' + (captured?.name || 'một đồng nghiệp') + ' vào đấu 1:1 trong 20 giây!');
    if (scene) scene.fx.duelCast(m.x, m.y);
    for (const move of state.moves || []) {
      const p = S.players.get(move.id);
      if (!p || p.dead) continue;
      p.x = move.fromX; p.y = move.fromY;
      p.tx = move.x; p.ty = move.y;
      p.forcedMotion = { ...move, t0: performance.now(), ms: move.kind === 'pull' ? m.pullMs : m.blowMs };
      if (scene && move.kind === 'pull') scene.fx.rope(m.x, m.y, move.fromX, move.fromY, move.x, move.y, m.pullMs / 1000);
      if (scene && move.kind === 'blow') scene.fx.blow(move.fromX, move.fromY, move.x, move.y);
    }
    sfxWind(volumeAt(m.x, m.y));
  }
  $('duelApologyBtn').addEventListener('click', () => {
    if (duelActive() && S.duel.target === S.me && performance.now() >= S.duel.apologyAt) {
      if (performance.now() < (S.duel.apologyPendingUntil || 0)) return;
      if (S.ws?.readyState !== WebSocket.OPEN) {
        toast('Mất kết nối, hãy thử xin lỗi lại khi kết nối được khôi phục.');
        return;
      }
      S.duel.apologyPendingUntil = performance.now() + 1500;
      updateApologyButton();
      send({ t: 'duelApology', version: S.duel.version });
    }
  });
  function updateApologyButton() {
    const button = $('duelApologyBtn');
    const pending = performance.now() < (S.duel?.apologyPendingUntil || 0);
    button.disabled = pending;
    button.setAttribute('aria-busy', String(pending));
    const label = pending ? 'Đang xin lỗi…' : 'Em xin lỗi';
    if (button.textContent !== label) button.textContent = label;
  }
  function constrainDuel(p, x, y) {
    if (!duelActive()) return { x, y };
    const r = S.duel.bounds;
    if (!r) return { x, y };
    const radius = r.radius || 16;
    if (p.id === S.duel.target) return resolve(clamp(x, r.x0 + radius, r.x1 - radius), clamp(y, r.y0 + radius, r.y1 - radius));
    if (x >= r.x0 - radius && x <= r.x1 + radius && y >= r.y0 - radius && y <= r.y1 + radius) return { x: p.x, y: p.y };
    return { x, y };
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
    b.wind = { skill: m.skill, x: m.x, y: m.y, r: m.r, ms: m.ms, t0: performance.now() };
    if (m.skill === 'newProcess') {
      toast('📋 VKL: NEW PROCESS · Quy trình mới! Chạy khỏi vùng tím!');
      if (scene) scene.fx.floatText(m.x, 180, m.y, 'NEW PROCESS', '#ceadff', 24);
    }
    if (m.skill === 'newProcess') sfxWind(volumeAt(b.x, b.y), 'newProcess');
  }
  function bossStrike(m) {
    const b = S.boss;
    if (b) {
      b.wind = null;
      b.pl.swing = 1;
    }
    if (m.skill === 'newProcess' && scene) scene.fx.process(m.x, m.y, m.r);
    const v = volumeAt(m.x, m.y);
    sfxPunch(v);
    S.shake = Math.min(1.4, S.shake + 0.55 * v);
    if (scene) for (let i = 0; i < 6; i++) scene.fx.smoke(m.x + rand(-m.r, m.r) * 0.7, 6, m.y + rand(-m.r, m.r) * 0.7);
  }
  function bossHit(m) {
    const b = S.boss;
    if (!b) return;
    if (m.rev && m.rev <= (b.hpRev || 0)) return;
    b.hpRev = m.rev || b.hpRev;
    const hitter = S.players.get(m.by);
    if (hitter) showSkill(hitter, m.skill, b);
    if (m.maxHp) b.cfg.maxHp = m.maxHp;
    b.hp = m.hp;
    b.hpT = performance.now();
    if (!m.by) return;
    const v = volumeAt(b.x, b.y);
    sfxHit(v, 'body', m.skill);
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
    if (!S.boss || (m.rev && m.rev < (S.boss.hpRev || 0))) return;
    S.boss.hpRev = m.rev || S.boss.hpRev;
    S.duel = null;
    $('duelBanner').hidden = true;
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
      audio.down(volumeAt(b.x, b.y));
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
    if (!b || (m.rev && m.rev < (b.hpRev || 0))) return;
    b.hpRev = m.rev || b.hpRev;
    b.dead = false;
    S.snakes.clear();
    b.x = b.tx = b.pl.x = m.x;
    b.y = b.ty = b.pl.y = m.y;
    if (m.maxHp) b.cfg.maxHp = m.maxHp;
    b.hp = b.cfg.maxHp;
    b.hpT = performance.now();
    b.wind = null;
    toast('👔 VKL đã quay lại phòng server');
  }
  function playerHurt(m) {
    const p = S.players.get(m.id);
    if (!p) return;
    p.hp = m.hp;
    if (p.mole && typeof m.moleHp === 'number') p.moleHp = m.moleHp;
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
    if (S.duel?.target === m.id) { S.duel = null; $('duelBanner').hidden = true; }
    const p = S.players.get(m.id);
    if (!p) return;
    p.dead = true;
    p.forcedMotion = null; p.fxLift = 0;
    p.hp = 0;
    p.deadAt = performance.now() + m.ms;
    p.moving = false;
    p.swing = 0;
    if (scene) scene.fx.floatText(p.x, 150, p.y, '-' + m.dmg, '#ff6b5a', 20);
    if (m.id === S.me) {
      S.keys.clear();
      resetJoystick();
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
    p.forcedMotion = null; p.fxLift = 0;
    p.hp = S.hpCfg ? S.hpCfg.max : 100;
    p.hpT = performance.now();
    p.x = p.tx = m.x;
    p.y = p.ty = m.y;
    p.shieldUntil = performance.now() + (m.shieldMs || 0);
    if (m.id === S.me) {
      $('downOverlay').hidden = true;
      S.target = null;
      if (scene) scene.cameraTo(m.x, m.y);
      toast(m.shieldMs ? '🛡️ Hồi sinh ở sảnh, được bảo vệ ' + Math.round(m.shieldMs / 1000) + ' giây. Di chuyển hoặc đánh là hết.' : 'Bạn đã hồi sinh ở sảnh, nhớ né đòn nhé');
    }
  }

  // Per-frame upkeep: bars, the boss's smooth walk, the HUD pieces.
  function bossTick(dt) {
    const me = S.players.get(S.me);
    for (const p of S.players.values()) p.hpFrac = p.mole ? clamp(p.moleHp / MOLE_HP, 0, 1) : hpNow(p) / (S.hpCfg ? S.hpCfg.max : 100);
    if (me) {
      const pct = clamp(me.hpFrac, 0, 1);
      $('hpFill').style.transform = 'scaleX(' + pct.toFixed(3) + ')';
      $('hpFill').className = pct < 0.25 ? 'low' : pct < 0.55 ? 'mid' : '';
      $('hpNum').textContent = String(Math.round(pct * (S.hpCfg ? S.hpCfg.max : 100)));
      if (me.dead) $('downSecs').textContent = String(Math.max(0, Math.ceil((me.deadAt - performance.now()) / 1000)));
    }
    if (me) me.alwaysHp = (narrowMQ.matches || coarseUi); // on a phone the health bar lives over the character instead of the top row
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

  // Room chat: live lines and optional durable history share one native scrolling log.
  // Mobile keeps a wider fixed-height log; long messages wrap and older lines use native scrolling.
  const CHAT_LINES = 60; // kept in the frame, scrolled to the newest (history pages raise it while they are loaded)
  const chatPending = new Map(); // client message id -> text, until the server confirms it was stored
  const chatSeen = new Map(); // message id -> its <li>: de-duplicates live lines, history pages and server retries
  const chatNewCid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  const CHAT_BUBBLE_S = 3;
  const chatForm = $('chatForm');
  const chatInput = $('chatInput');
  const chatLog = $('chatLog');
  const coarseUi = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const chatKey = (m) => m.at + '|' + m.mid;
  function chatLine(m, hist) {
    const li = document.createElement('li');
    li.className = 'chatline' + (m.mine || (m.id !== undefined && m.id === S.me) ? ' me' : '') + (hist ? ' hist' : '');
    li.dataset.k = chatKey(m);
    const nm = document.createElement('b');
    nm.textContent = String(m.name || '?') + ': ';
    li.append(nm, document.createTextNode(m.text)); // text nodes only: never HTML
    return li;
  }
  // Keeps the log ordered by (server time, id) whether a line arrived live or from a history page.
  function chatInsert(m, hist) {
    if (typeof m.text !== 'string' || !m.text) return null;
    if (m.mid && chatSeen.has(m.mid)) return null;
    const li = chatLine(m, hist);
    if (m.mid) chatSeen.set(m.mid, li);
    const key = chatKey(m);
    let before = null;
    for (let n = chatLog.lastElementChild; n; n = n.previousElementSibling) {
      if (!n.dataset.k || n.dataset.k <= key) break;
      before = n;
    }
    if (before) chatLog.insertBefore(li, before); else chatLog.appendChild(li);
    return li;
  }
  const chatOldest = () => { const f = chatLog.querySelector('li[data-k]'); return f ? { at: Number(f.dataset.k.split('|')[0]), mid: f.dataset.k.split('|')[1] } : null; };
  const chatNewest = () => { const l = [...chatLog.querySelectorAll('li[data-k]')].pop(); return l ? { at: Number(l.dataset.k.split('|')[0]), mid: l.dataset.k.split('|')[1] } : null; };
  function chatTrim() {
    const cap = S.chatHistory ? 400 : CHAT_LINES;
    while (chatLog.children.length > cap) { const f = chatLog.firstChild; if (f.dataset && f.dataset.k) chatSeen.delete(f.dataset.k.split('|')[1]); chatLog.removeChild(f); }
  }
  function chatReceive(m) {
    const atEnd = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40; // do not yank someone reading older lines
    const li = m.mid ? chatInsert(m, false) : (() => { const x = chatLine({ ...m, at: Date.now(), mid: '' }, false); chatLog.appendChild(x); return x; })();
    if (!li) return; // already shown
    chatTrim();
    if (atEnd || m.id === S.me) chatLog.scrollTop = chatLog.scrollHeight;
    chatWake();
    const p = S.players.get(m.id);
    if (p) {
      p.chat = m.text;
      p.chatT = CHAT_BUBBLE_S;
    }
  }
  // History pages (join, reconnect gap, scrolling up): lines go into the frame without bubbles or sounds.
  function chatHistory(m) {
    S.chatBusy = false;
    if (m.failed) return;
    const keepBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
    const prevHeight = chatLog.scrollHeight, prevTop = chatLog.scrollTop;
    for (const x of m.messages) chatInsert(x, true);
    chatTrim();
    S.chatMore = m.dir === 'before' ? m.more : S.chatMore;
    if (m.dir === 'before') chatLog.scrollTop = prevTop + (chatLog.scrollHeight - prevHeight); // stay on the same line
    else if (keepBottom || m.dir === 'latest') chatLog.scrollTop = chatLog.scrollHeight;
    // after a reconnect the latest page may not reach back to what we already show: fill the gap
    if (m.dir === 'latest' && S.chatLastSeen && m.messages.length && chatKey(m.messages[0]) > chatKey(S.chatLastSeen) && m.more) chatAsk({ after: S.chatLastSeen });
    if (m.dir === 'after' && m.more && m.messages.length) chatAsk({ after: m.messages[m.messages.length - 1] });
    if (m.dir === 'latest' && S.chatMore === undefined) S.chatMore = m.more;
    chatWake();
  }
  function chatAsk(extra) { if (S.joined && S.chatHistory) { S.chatBusy = true; send({ t: 'chatHist', ...extra }); } }
  chatLog.addEventListener('scroll', () => {
    if (chatLog.scrollTop > 20 || S.chatBusy || !S.chatMore || !S.chatHistory) return;
    const o = chatOldest();
    if (o) chatAsk({ before: o });
  });
  // Mobile chat expands upward without moving the skill/compose/emoji targets.
  const CHAT_IDLE_MS = 8000;
  let chatIdleTimer = 0, chatTouching = false, chatReading = false;
  function chatWake(force = false) {
    const dock = $('chatDock'), preview = $('chatPreview');
    preview.textContent = chatLog.lastElementChild?.textContent || '💬 Nhắn cả server…';
    chatLog.classList.remove('idle');
    dock.classList.toggle('expanded', !!(force || chatLog.children.length));
    clearTimeout(chatIdleTimer);
    if (!coarseUi) return;
    chatIdleTimer = setTimeout(() => {
      const older = chatReading && chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight > 24;
      if (document.activeElement === chatInput || chatTouching || older) chatWake(true);
      else {
        chatLog.classList.add('idle');
        dock.classList.remove('expanded');
      }
    }, CHAT_IDLE_MS);
  }
  $('chatPreview').addEventListener('click', () => {
    if (!chatLog.children.length) { chatOpen(); return; }
    chatReading = false;
    chatWake(true);
    chatLog.scrollTop = chatLog.scrollHeight;
  });
  chatLog.addEventListener('pointerdown', () => { chatTouching = true; chatReading = true; chatWake(true); });
  window.addEventListener('pointerup', () => { if (chatTouching) { chatTouching = false; chatWake(true); } });
  window.addEventListener('pointercancel', () => { chatTouching = false; });
  window.addEventListener('blur', () => { chatTouching = false; chatReading = false; });
  chatLog.addEventListener('wheel', () => { chatReading = true; chatWake(true); }, {passive:true});
  function chatOpen() {
    mm.held = false; mmFull(false);
    if (coarseUi) chatForm.classList.add('open');
    chatInput.focus();
  }
  chatInput.addEventListener('focus', () => {
    S.keys.clear(); // a key held while clicking into the box must not keep walking
    resetJoystick();
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
    if (text && S.joined) { const cid = chatNewCid(); chatPending.set(cid, text); send({ t: 'chat', text, cid }); }
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
    resetJoystick();
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
        syncOrientation();
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
    resetJoystick();
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
    autoJoin.clear();
    exitEl.hidden = true;
    S.fatal = true; // no auto-reconnect
    S.joined = false;
    syncOrientation();
    S.keys.clear();
    resetJoystick();
    S.smashHeld = false;
    S.target = null;
    S.attackId = null;
    chatLog.hidden = true;
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ t: 'leave' })); // deliberate exit: come back in the lobby
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
  const mm = { cv: $('minimap'), base: null, k: 1, dpr: 1, on: true, w: 0, h: 0, rooms: [] };
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
  const fullMap = $('fullMap'), fullMapCanvas = $('fullMapCanvas');
  function mmFull(open) {
    mm.open = !!open;
    fullMap.hidden = !mm.open;
    mm.cv.setAttribute('aria-expanded', String(mm.open));
    if (mm.open) {
      const rect = fullMapCanvas.getBoundingClientRect();
      fullMapCanvas.width = Math.round(rect.width * mm.dpr);
      fullMapCanvas.height = Math.round(rect.height * mm.dpr);
      mmDraw();
    }
  }
  mm.cv.addEventListener('click', () => mmFull(!mm.open));
  mm.cv.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); mmFull(!mm.open); }
  });
  $('fullMapClose').addEventListener('click', () => { mm.held = false; mmFull(false); });
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
    // The HUD is hidden during welcome: clientWidth is zero even on a phone.
    const cw = parseFloat(getComputedStyle(mm.cv).width) || 200;
    mm.source = { world, props, zones };
    const ch = Math.round(cw);
    mm.cv.style.height = ch + 'px';
    mm.cv.width = Math.round(cw * dpr);
    mm.cv.height = Math.round(ch * dpr);
    mm.k = mm.cv.width / world.w;
    mm.dpr = dpr;
    const base = document.createElement('canvas');
    base.width = 1600;
    base.height = Math.round(base.width * world.h / world.w);
    mm.k = base.width / world.w;
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
    if ((!mm.on && !mm.open) || !mm.base || !S.joined) return;
    if (mm.on) mmRender(mm.cv, false);
    if (mm.open) mmRender(fullMapCanvas, true);
  }
  function mmRender(canvas, full) {
    const me = S.players.get(S.me), world = mm.source.world;
    if (!me) return;
    const c = canvas.getContext('2d'), aspect = canvas.width / canvas.height;
    // A steady local scale prevents camera zoom from shrinking the whole office into the radar.
    const range = 1500;
    const width = full ? world.w : range * 2;
    const height = full ? world.h : width / aspect;
    const x0 = full ? 0 : me.x - width / 2, y0 = full ? 0 : me.y - height / 2;
    const k = Math.min(canvas.width / width, canvas.height / height);
    const ox = (canvas.width - width*k)/2, oy = (canvas.height - height*k)/2;
    const x = value => ox + (value-x0)*k, y = value => oy + (value-y0)*k;
    const inside = p => full || Math.hypot(p.x-me.x,p.y-me.y) <= range;
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.save();
    if (!full) {
      c.beginPath(); c.arc(canvas.width/2,canvas.height/2,canvas.width/2,0,Math.PI*2); c.clip();
    }
    c.fillStyle = '#101622'; c.fillRect(0, 0, canvas.width, canvas.height);
    c.drawImage(mm.base, x(0), y(0), world.w*k, world.h*k);
    for (const o of S.objects) {
      const t = S.types[o.type];
      const solid = t && t.w >= 44 && t.h >= 36 && o.type !== 'chair' && o.type !== 'plant';
      c.fillStyle = o.broken ? '#ff5d4a' : solid ? '#8b6f4e' : '#7a869a';
      const sz = Math.max(1.6, (solid ? t.w * 0.7 : 24) * k);
      c.fillRect(x(o.x) - sz / 2, y(o.y) - sz / 2, sz, sz);
    }
    if (full) {
      // Room names, so players can say where to meet. The lobby is open floor around the spawn.
      const labels = [...mm.rooms, { name: 'LOBBY', x0: world.spawn.x, x1: world.spawn.x, y0: world.spawn.y - 260, y1: 0 }];
      c.font = '700 ' + Math.round(11 * mm.dpr) + 'px system-ui, sans-serif';
      c.textAlign = 'center'; c.textBaseline = 'top';
      c.lineJoin = 'round'; c.lineWidth = 3 * mm.dpr; c.strokeStyle = 'rgba(10,14,22,.85)'; c.fillStyle = '#ffffff';
      for (const r of labels) {
        const lx = x((r.x0 + r.x1) / 2), ly = y(r.y0) + 6 * mm.dpr;
        c.strokeText(r.name, lx, ly); c.fillText(r.name, lx, ly);
      }
    }
    for (const p of S.players.values()) {
      if (p.id === S.me || !inside(p)) continue;
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.arc(x(p.x), y(p.y), 2.6 * mm.dpr, 0, Math.PI * 2);
      c.fill();
    }
    if (S.boss && !S.boss.dead && inside(S.boss)) {
      c.fillStyle = '#ff3b2a';
      c.strokeStyle = '#ffffff';
      c.lineWidth = 1.2 * mm.dpr;
      c.beginPath();
      c.arc(x(S.boss.x), y(S.boss.y), 4.6 * mm.dpr, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    }
    // mini-bosses (TML orange, DMM purple) while they are alive, like the boss's red dot but a little smaller
    for (const b of S.minis.values()) {
      if (!(b.hp > 0) || !inside(b)) continue;
      c.fillStyle = 'hsl(' + b.pl.hue + ', 85%, 58%)';
      c.strokeStyle = '#ffffff';
      c.lineWidth = 1.2 * mm.dpr;
      c.beginPath();
      c.arc(x(b.x), y(b.y), 3.8 * mm.dpr, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    }
    if (me) {
      c.fillStyle = '#ffd34d';
      c.strokeStyle = '#000000';
      c.lineWidth = 1.2 * mm.dpr;
      c.beginPath();
      c.arc(x(me.x), y(me.y), 3.8 * mm.dpr, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    }
    if (!full) {
      const radius = canvas.width/2;
      const fade = c.createRadialGradient(radius,radius,0,radius,radius,radius);
      fade.addColorStop(0,'rgba(0,0,0,1)');
      fade.addColorStop(.78,'rgba(0,0,0,1)');
      fade.addColorStop(.92,'rgba(0,0,0,.7)');
      fade.addColorStop(1,'rgba(0,0,0,.08)');
      c.globalCompositeOperation = 'destination-in';
      c.fillStyle = fade; c.fillRect(0,0,canvas.width,canvas.height);
    }
    c.restore();
  }
  // On narrow screens, follow the left header; the taller scoreboard must not push the radar down.
  function mmPlace() {
    const narrow = coarseUi || window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
    if (!narrow) {
      mm.cv.style.top = '';
      return;
    }
    const header = $('topLeft').getBoundingClientRect();
    const appTop = $('app').getBoundingClientRect().top;
    const mapTop = Math.max(48, Math.round(header.bottom - appTop) + 8);
    mm.cv.style.top = mapTop + 'px';
    if (coarseUi && viewport.width > viewport.height && S.joined) {
      const joystickTop = $('joystick').getBoundingClientRect().top - appTop;
      const desired = Math.max(96, Math.min(208, Math.round(Math.min(viewport.width * .16, viewport.height * .24))));
      const mapWidth = Math.max(32, Math.min(desired, Math.floor(joystickTop - mapTop - 8)));
      if (mm.cv.style.getPropertyValue('--mobile-map-width') !== mapWidth + 'px') {
        mm.cv.style.setProperty('--mobile-map-width', mapWidth + 'px');
        if (mm.source) mmBuild(mm.source.world, mm.source.props, mm.source.zones);
      }
      const joystick = $('joystick').getBoundingClientRect(), skill = $('skillBtn').getBoundingClientRect();
      const dock = $('mobileBottomControls'), origin = $('app').getBoundingClientRect().left;
      dock.style.setProperty('--dock-left', Math.ceil(joystick.right - origin + 16) + 'px');
      dock.style.setProperty('--dock-right', Math.ceil(viewport.width - (skill.left - origin) + 16) + 'px');
    }
  }

  // the side buttons sit in the top-right corner, right under the damage board
  function sidePlace() {
    const board = $('board');
    if (!board) return;
    const top = Math.max(56, Math.round(viewport.rect(board).bottom - $('app').getBoundingClientRect().top) + 8);
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
          '<b>Kéo núm bên trái</b> để di chuyển. Đến gần mục tiêu rồi dùng nút ra đòn bên phải.',
          '<b>Giữ nút ĐẬP!</b> để đập liên tục khi đã đứng cạnh đồ.',
          '<b>Bấm 💬</b> để nhắn cho cả server, tin hiện dưới thông báo và thành bong bóng trên đầu bạn vài giây.',
          '<b>Chụm hai ngón</b> hoặc bấm <b>+ / −</b> để zoom trong game, nút <b>🗺</b> ẩn hiện bản đồ nhỏ; chạm bản đồ nhỏ để xem toàn văn phòng.',
          'Tắt khóa xoay và cầm máy ngang để chơi. Trong Safari, chọn <b>Chia sẻ → Thêm vào Màn hình chính</b> (bật <b>Mở dưới dạng ứng dụng web</b> nếu có) để chơi không có thanh trình duyệt.',
        ]
      : [
          '<b>WASD</b> hoặc <b>mũi tên</b> để đi, <b>Space</b> để đập (giữ để đập liên tục).',
          '<b>Enter</b> hoặc bấm vào ô chat để nhắn cho cả server, tin hiện dưới thông báo và thành bong bóng trên đầu bạn vài giây.',
          '<b>Lăn chuột</b> để zoom, <b>M</b> để ẩn hiện bản đồ nhỏ, giữ <b>Tab</b> xem toàn văn phòng, <b>Shift + 1 đến 8</b> để thả emoji.',
        ];
    const itPolicy = S.respawnPolicy || { minMs: 25000, maxMs: 60000 };
    const autoIT = S.respawnMs > 0
      ? 'IT tự thay đồ vỡ sau khoảng <b>' + (S.respawnMs / 1000) + ' giây</b>.'
      : 'IT tự thay đồ vỡ trong <b>' + (itPolicy.minMs / 1000) + '–' + (itPolicy.maxMs / 1000) + ' giây</b>: càng đông người thật và càng nhiều đồ vỡ thì thay càng nhanh.';
    items.push(
      autoIT,
      '<b>Thanh xanh dưới tên bạn là mana.</b> Mỗi cú đập tốn một ít, hết thì phải nghỉ vài giây mới hồi.',
      'Đồ đã bị đập hiện <b>thanh máu</b>: xanh khi còn khoẻ, cam từ nửa trở xuống, đỏ ở cú cuối.',
      '<b>VKL</b> canh phòng server (kho tủ server 120 triệu). Bước vào là bị đấm: <b>vòng đỏ dưới đất</b> báo chỗ nắm đấm sắp rơi, chạy ra khỏi vòng là né được. Mỗi đấm mất 30 máu, hết 100 máu thì nằm 15 giây rồi hồi sinh ở sảnh.',
      'Sếp không hồi máu nên cứ đánh bớt rồi chạy cũng được, máu tối đa tăng theo từng nhóm 4 người online trên server. Sếp ngã thì <b>500 triệu tiền thưởng</b> chia theo sát thương. Sếp bị hạ sẽ quay lại sau 1 phút.',
      'Máu của bạn tự hồi chậm sau vài giây không bị đánh. Ngoài sự kiện đi tuần, ra khỏi khu phòng server là sếp không đuổi theo.',
      touch ? 'Bấm <b>Skill</b> để đổi giữa <b>Đập búa</b>, <b>Ném ly trà sữa</b> và <b>Chích điện</b>. Giữ nút ra đòn bên phải để dùng skill.' : 'Đổi giữa <b>Đập búa</b>, <b>Ném ly trà sữa</b> và <b>Chích điện</b> bằng phím <b>1, 2, 3</b> hoặc nút <b>Skill</b>. Giữ <b>Space</b> để dùng.',
      'Mỗi 40–60 giây, VKL kéo ngẫu nhiên một người ở gần phòng server vào đấu 1:1 trong 20 giây. Sau 10 giây đầu, bấm <b>Em xin lỗi</b>' + (touch ? '' : ' (phím <b>E</b>)') + ' để được thả sớm. Những người khác bị thổi ra; phòng khóa đến khi hết giờ hoặc một bên bị hạ.',
      'VKL triệu hồi rắn ở 70%, 40% và 10% máu. Đợt 70% và 40% có số rắn nguyên ngẫu nhiên từ 1,3 đến 2 lần số người online (làm tròn lên ở mức tối thiểu); đợt cuối ở 10% thả rắn đỏ, tăng lên 2–3 lần. Rắn xanh cắn 5 máu, rắn đỏ cắn 7 máu mỗi 1,2 giây; cả hai chịu 4 cú búa và đuổi khắp bản đồ. Rắn còn lại biến mất khi boss hồi sinh.',
      '<b>TML và DMM</b> đi khắp bản đồ, chỉ trả đũa người đánh mình. TML có 900 máu, đánh 20; DMM có 600 máu, đánh 15. Né vòng báo đòn, hạ được thưởng 40/30 triệu chia theo damage. Chết sau 30 giây sẽ xuất hiện ở nơi khác. Đánh mỗi cú tăng 1 nộ; ulti gây 20% máu tối đa.',
      'Mỗi 5 phút có <b>Đồng nghiệp mời nước</b>: bấm nút' + (touch ? '' : ' (phím <b>Q</b>)') + ' trong 5 giây để hồi đầy máu và mana cho cả server.',
      'Boss dùng <b>New Process (Quy trình mới)</b>: chạy khỏi vòng tím trước khi giấy rơi xuống để né đòn.',
      'Có thể đánh người chơi khác để tạo hiệu ứng vui, không mất máu.',
      'Đập đồ để cộng vào <b>tổng thiệt hại</b> của cả server. ' + (touch ? 'Mở cài đặt và bấm <b>Gọi IT</b>' : 'Bấm <b>Gọi IT</b> (phím <b>I</b>)') + ' để thay hết đồ mới ngay.',
      'Đứng yên khoảng 3 phút thì bị ngắt kết nối để tiết kiệm tài nguyên, bấm vào lại là về đúng chỗ cũ.',
    );
    $('helpList').innerHTML = items.map((t) => '<li>' + t + '</li>').join('');
    helpEl.hidden = false;
    $('helpClose').focus();
  }
  function helpClose() {
    helpEl.hidden = true;
    $(coarseUi ? 'settingsBtn' : 'helpBtn').focus();
  }
  $('helpBtn').addEventListener('click', helpOpen);
  $('helpClose').addEventListener('click', helpClose);
  helpEl.addEventListener('pointerdown', (e) => {
    if (e.target === helpEl) helpClose();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !helpEl.hidden) helpClose();
  });

  function closeEmotes() {
    $('emoteTray').hidden = true;
    $('emoteBtn').setAttribute('aria-expanded', 'false');
  }
  $('emoteBtn').addEventListener('click', () => {
    const open = $('emoteTray').hidden;
    $('emoteTray').hidden = !open;
    $('emoteBtn').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('#emoteTray, #emoteBtn')) closeEmotes();
  });
  window.addEventListener('keydown', e => { if (e.key === 'Escape') closeEmotes(); });
  const settingsEl = $('settingsDlg');
  const settingsMQ = window.matchMedia('(pointer: coarse)');
  // Move the existing controls so state, cooldowns and listeners stay shared.
  const settingsMoves = ['helpBtn', 'mapBtn', 'gfxBtn', 'copyLink', 'resetBtn', 'emotes', 'skillBtn', 'chatBtn', 'chatDock', 'zoomBtns'].map(id => {
    const el = $(id), slot = document.createComment(id);
    el.before(slot);
    return { el, slot };
  });
  function settingsClose(restoreFocus = true) {
    settingsEl.hidden = true;
    $('settingsBtn').setAttribute('aria-expanded', 'false');
    if (restoreFocus) $('settingsBtn').focus();
  }
  function settingsLayout() {
    settingsClose(false);
    closeEmotes();
    setButtonIcon($('ultBtn'), 'zap', settingsMQ.matches ? 'ULTI!' : 'ULTI! (R)');
    $('ultBtn').title = settingsMQ.matches ? 'Dùng chiêu cuối' : 'Phím R';
    $('ragePill').title = settingsMQ.matches ? 'Nộ: đánh sếp hoặc bạn sếp để nạp. Đầy thì chạm ULTI!' : 'Nộ: đánh sếp hoặc bạn sếp để nạp. Đầy thì bấm R để tung ulti';
    for (const { el, slot } of settingsMoves) {
      if (settingsMQ.matches) {
        const target = el.id === 'zoomBtns' ? 'sideBtns' : el.id === 'emotes' ? 'emoteTray' : el.id === 'skillBtn' ? 'bottombar'
          : el.id === 'chatBtn' || el.id === 'chatDock' ? 'mobileBottomControls'
          : 'settingsActions';
        $(target).append(el);
      } else slot.after(el);
    }
    $('sideTools').hidden = settingsMQ.matches;
    const selected = SKILLS.find(s => s.id === S.skill) || SKILLS[0];
    setButtonIcon($('skillBtn'), selected.icon, settingsMQ.matches ? '' : selected.label);
    $('skillBtn').setAttribute('aria-label', selected.label + ' · Chạm để đổi skill');
    $('skillBtn').title = selected.label + ' · Chạm để đổi skill';
    mmPlace(); sidePlace();
  }
  $('settingsBtn').addEventListener('click', () => {
    if (!settingsMQ.matches) return;
    S.keys.clear(); resetJoystick(); S.smashHeld = false; S.target = null; S.attackId = null;
    settingsEl.hidden = false;
    $('settingsBtn').setAttribute('aria-expanded', 'true');
    $('settingsClose').focus();
  });
  $('settingsClose').addEventListener('click', () => settingsClose());
  settingsEl.addEventListener('pointerdown', e => {
    if (e.target === settingsEl) settingsClose();
  });
  settingsEl.addEventListener('click', e => {
    if (e.target.closest('#helpBtn, #chatBtn, #resetBtn, #emotes button')) settingsClose(false);
  }, true);
  window.addEventListener('keydown', e => {
    if (settingsEl.hidden) return;
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { e.preventDefault(); settingsClose(); }
    if (e.key === 'Tab') {
      const buttons = [...settingsEl.querySelectorAll('button')].filter(b => !b.disabled && b.getClientRects().length);
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }, true);
  settingsMQ.addEventListener('change', settingsLayout);
  settingsLayout();

  let drinkTimer = null;
  let drinkId = 0;
  let drinkClaimed = 0;
  let drinkExpires = 0;
  function showDrinkOffer(m) {
    if (!m || m.id <= drinkClaimed || m.ms <= 0) return;
    const expiry = performance.now() + Math.min(m.ms, 5000);
    drinkExpires = drinkId === m.id && drinkExpires ? Math.min(drinkExpires, expiry) : expiry;
    drinkId = m.id;
    clearTimeout(drinkTimer);
    $('drinkBtn').hidden = false;
    $('drinkBtn').disabled = false;
    drinkTimer = setTimeout(() => { $('drinkBtn').hidden = true; }, Math.max(0, drinkExpires - performance.now()));
  }
  $('drinkBtn').addEventListener('click', () => {
    if (performance.now() >= drinkExpires) return;
    $('drinkBtn').disabled = true;
    send({ t: 'drink', id: drinkId });
  });

  // ---------------------------------------------------------------- input ----
  function showSkill(p, skill, target) {
    p.skill = SKILLS.some(s => s.id === skill) ? skill : 'hammer';
    if (p.skill === 'electric' && target) target.electricUntil = performance.now() + 500;
    // The cup / the arcs leave the hand when the arm reaches the throw: the scene fires p.fxShot at that moment.
    if (p.skill === 'milkTea' && scene) {
      const distance = 100 * S.milkTeaRangeMultiplier;
      p.fxShot = { skill: 'milkTea', tx: target ? target.x : p.x + Math.sin(p.heading) * distance, ty: target ? target.y : p.y + Math.cos(p.heading) * distance };
    } else if (p.skill === 'electric' && scene) {
      p.fxShot = { skill: 'electric', tx: target ? target.x : p.x + Math.sin(p.heading) * 100, ty: target ? target.y : p.y + Math.cos(p.heading) * 100 };
    }
  }

  function attackRange(boss = false, margin = 0) {
    const base = boss ? S.boss.cfg.reach : S.hitRange;
    return (base - margin) * (S.skill === 'milkTea' ? S.milkTeaRangeMultiplier : 1);
  }

  function snakeObj(id) {
    const s = S.snakes.get(id);
    return s && s.hp > 0 ? { snake: true, id, x: s.x, y: s.y } : null;
  }
  function playerObj(id) {
    const p = S.players.get(id);
    return p && id !== S.me && !p.dead ? { player: true, mole: !!p.mole, id, x: p.x, y: p.y } : null;
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
      if (center <= attackRange(true, 10) && center - S.boss.cfg.radius <= bestD) {
        best = bo;
        bestD = center - S.boss.cfg.radius;
      }
    }
    for (const b of S.minis.values()) {
      if (b.hp <= 0) continue;
      const o = miniObj(b.pl.mini), d = Math.hypot(b.x - me.x, b.y - me.y);
      if (d <= targetRange(o, 8) && d - 22 <= bestD) { best = o; bestD = d - 22; }
    }
    for (const s of S.snakes.values()) {
      const d = Math.hypot(s.x - me.x, s.y - me.y);
      if (d < bestD) { best = snakeObj(s.id); bestD = d; }
    }
    for (const p of S.players.values()) {
      if (p.id === S.me || p.dead) continue;
      const d = Math.hypot(p.x - me.x, p.y - me.y);
      if (d < bestD) { best = playerObj(p.id); bestD = d; }
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
    if ((!o.player || o.mole) && S.manaCfg && manaNow() < S.manaCfg.cost) {
      S.manaEmptyT = 1; // flash the bar
      if (now - S.manaToastAt > 2500) {
        S.manaToastAt = now;
        toast('Hết mana, nghỉ tay một chút nhé');
      }
      return false;
    }
    if (Math.hypot(o.x - me.x, o.y - me.y) > targetRange(o, o.boss ? 10 : 5)) return false;
    S.lastHit = now;
    send({ t: o.mini ? 'miniHit' : o.snake ? 'snakeHit' : o.player ? 'phit' : o.boss ? 'bhit' : 'hit', id: o.id, skill: S.skill });
    me.skill = S.skill;
    me.heading = Math.atan2(o.x - me.x, o.y - me.y);
    me.swing = 1;
    me.d = o.x >= me.x ? 1 : -1;
    return true;
  }

  function solidBosses() {
    const circles = [];
    if (S.boss && !S.boss.dead) circles.push({ x:S.boss.tx ?? S.boss.x, y:S.boss.ty ?? S.boss.y, r:S.boss.cfg.radius });
    for (const b of S.minis.values()) if (b.hp > 0) circles.push({ x:b.tx ?? b.x, y:b.ty ?? b.y, r:b.cfg.radius || 22 });
    return circles;
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
    if (!S.joined || mobilePortrait() || typing() || !exitEl.hidden || !updateEl.hidden || !helpEl.hidden || !rankEl.hidden || !settingsEl.hidden) return;
    const k = e.key.toLowerCase();
    if (k === 'tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); if (!e.repeat) { mm.held = true; mmFull(true); }
    } else if (k === 'escape' && mm.open) {
      mm.held = false; mmFull(false);
    } else if (MOVE_KEYS[k]) {
      e.preventDefault();
      S.keys.add(MOVE_KEYS[k]);
    } else if (k === ' ') {
      e.preventDefault();
      S.keys.add('space');
    } else if ((k === 'enter' || k === '/') && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); // so the / is not typed into the box that is about to get focus
      chatOpen();
    } else if (e.code === 'KeyE' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (!$('duelApologyBtn').hidden) $('duelApologyBtn').click(); // "Em xin lỗi" while you are locked in a duel
    } else if (e.code === 'KeyQ' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (!$('drinkBtn').hidden && !$('drinkBtn').disabled) $('drinkBtn').click(); // accept "Đồng nghiệp mời nước"
    } else if (k === 'i' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      $('resetBtn').click(); // call IT (replace everything with new stuff): the same as the button, with the same cooldown
    } else if (k === 'r' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (!$('ultBtn').hidden) send({ t: 'ult', skill: S.skill });
    } else if (k === 'm' && !e.repeat) {
      mmToggle();
    } else if (/^(Digit|Numpad)[1-9]$/.test(e.code) && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // 1, 2, 3 choose a skill (hammer, milk tea, electric); Shift + 1 to 8 throw the emoji. Read from the physical key
      // (e.code), because Shift turns the character into a symbol.
      const n = Number(e.code.slice(-1));
      if (e.shiftKey) {
        if (n <= 8) send({ t: 'emote', e: n - 1 });
      } else if (n <= SKILLS.length) setSkill(n - 1);
    }
  });

  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'tab' && mm.held) { mm.held = false; mmFull(false); }
    if (MOVE_KEYS[k]) S.keys.delete(MOVE_KEYS[k]);
    else if (k === ' ') S.keys.delete('space');
  });

  window.addEventListener('blur', () => {
    mm.held = false; mmFull(false);
    S.keys.clear();
    resetJoystick();
    S.smashHeld = false;
  });

  // Fixed left thumb stick; pointer capture lets the other thumb hold smash independently.
  function resetJoystick() {
    const j = S.joystick, id = j.pointerId;
    j.x = j.y = 0;
    j.pointerId = null;
    j.pointerType = null;
    $('joystickKnob').style.transform = '';
    $('joystick').classList.remove('active');
    // Clear our state first: capture may already have vanished during a native cancel.
    try {
      if (id !== null && $('joystick').hasPointerCapture(id)) $('joystick').releasePointerCapture(id);
    } catch (err) { /* a stale native pointer must not prevent resetting the control */ }
  }
  async function requestLandscape() {
    if (!coarseUi) return;
    // Ask the browser for native fullscreen/orientation support; never rotate the DOM.
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.();
    } catch (err) { /* continue with the browser viewport */ }
    try {
      await screen.orientation?.lock?.('landscape');
    } catch (err) { /* show the rotate prompt if a physical turn is needed */ }
  }
  function mobilePortrait() {
    return viewport.portrait;
  }
  function syncOrientation() {
    viewport.syncOrientation();
  }
  $('landscapeBtn').addEventListener('click', requestLandscape);
  window.addEventListener('gameviewportchange', syncOrientation);
  function resetControls() {
    closeEmotes();
    resetJoystick();
    S.keys.clear();
    S.smashHeld = false;
    S.target = null;
    S.attackId = null;
    fingers.clear();
    pinchLast = 0;
  }
  window.addEventListener('gameviewportchange', resetControls);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) resetControls();
  });
  // Safari versions with smart-zoom quirks need native touch cancellation as well as CSS.
  // Keep this on game controls only, so forms and scrolling dialogs retain normal touch behavior.
  for (const el of [canvas, $('joystick'), $('smashBtn')]) {
    el.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
    el.addEventListener('dblclick', e => e.preventDefault());
  }
  const joystick = $('joystick');
  function moveJoystick(e) {
    if (e.pointerId !== S.joystick.pointerId) return;
    const rect = viewport.rect(joystick);
    const point = viewport.point(e.clientX, e.clientY);
    const radius = rect.width * 0.3;
    const dx = point.x - rect.left - rect.width / 2;
    const dy = point.y - rect.top - rect.height / 2;
    const distance = Math.hypot(dx, dy);
    const scale = distance > radius ? radius / distance : 1;
    $('joystickKnob').style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;
    const strength = clamp((distance / radius - 0.16) / 0.84, 0, 1);
    S.joystick.x = distance ? dx / distance * strength : 0;
    S.joystick.y = distance ? dy / distance * strength : 0;
    S.target = null;
    S.attackId = null;
  }
  joystick.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!S.joined || mobilePortrait() || typing() || !exitEl.hidden || !updateEl.hidden || !helpEl.hidden || !rankEl.hidden || !settingsEl.hidden) return;
    const j = S.joystick;
    // A new primary touch starts a fresh gesture. A stale id must not lock out
    // that gesture; a second thumb must not steal a still-captured joystick.
    if (j.pointerId !== null && (!joystick.hasPointerCapture(j.pointerId) || (e.pointerType === 'touch' && e.isPrimary))) resetJoystick();
    if (j.pointerId !== null) return;
    try {
      joystick.setPointerCapture(e.pointerId);
    } catch (err) {
      resetJoystick();
      return;
    }
    j.pointerId = e.pointerId;
    j.pointerType = e.pointerType;
    joystick.classList.add('active');
    moveJoystick(e);
  });
  // Native cancellation can route terminal events away from the original element.
  // Observe the owned pointer at window capture phase, wherever it is delivered.
  window.addEventListener('pointermove', moveJoystick, { capture: true });
  for (const type of ['pointerup', 'pointercancel']) {
    window.addEventListener(type, e => {
      if (e.pointerId === S.joystick.pointerId) resetJoystick();
    }, { capture: true });
  }
  joystick.addEventListener('lostpointercapture', e => {
    // Ignore a delayed loss from an earlier gesture if a new capture is active.
    if (e.pointerId === S.joystick.pointerId && !joystick.hasPointerCapture(e.pointerId)) resetJoystick();
  });
  for (const type of ['touchend', 'touchcancel']) {
    window.addEventListener(type, e => {
      if (S.joystick.pointerType !== 'touch' || !e.touches) return;
      const stillHeld = Array.from(e.touches).some(t => t.target && joystick.contains(t.target));
      if (!stillHeld) resetJoystick(); // fallback when Safari omits a pointer terminal event
    }, { capture: true, passive: true });
  }

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
    if (fingers.size === 2 && scene && !typing()) {
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
    if (e.pointerType !== 'touch' || !S.joined || typing()) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinchLast = fingers.size === 2 ? fingerDist() : 0;
  });
  canvas.addEventListener('lostpointercapture', (e) => {
    fingers.delete(e.pointerId);
    pinchLast = 0;
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
    if (!S.joined || mobilePortrait() || typing() || !exitEl.hidden || !updateEl.hidden || !helpEl.hidden || !rankEl.hidden || !settingsEl.hidden) return;
    smashBtn.setPointerCapture(e.pointerId);
    S.smashHeld = true;
    tryHit(nearest());
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) =>
    smashBtn.addEventListener(ev, () => {
      S.smashHeld = false;
    })
  );

  // skills: the button cycles forward; on a keyboard the keys 1, 2, 3 pick one directly
  const skillIndex = () => SKILLS.findIndex((s) => s.id === S.skill);
  function setSkill(i) {
    const next = SKILLS[(i + SKILLS.length) % SKILLS.length];
    S.skill = next.id;
    setButtonIcon($('skillBtn'), next.icon, coarseUi ? '' : next.label);
    $('skillBtn').setAttribute('aria-label', next.label + ' · Chạm để đổi skill');
    $('skillBtn').title = next.label + ' · Chạm để đổi skill';
    $('smashBtn').textContent = next.action;
    send({ t: 'skill', skill: next.id }); // so the others see what is in your hand
    toast(next.label + (coarseUi ? ' · Giữ nút ' + next.action + ' để dùng · chạm Skill để đổi' : ' · Space để dùng · phím 1-3 đổi skill'));
  }
  $('skillBtn').addEventListener('click', () => setSkill(skillIndex() + 1));

  $('resetBtn').addEventListener('click', () => send({ t: 'reset' }));
  $('ultBtn').addEventListener('click', () => send({ t: 'ult', skill: S.skill }));

  const emoteBox = $('emotes');
  EMOTES.forEach((em, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = em;
    b.title = coarseUi ? 'Thả ' + em : 'Shift + ' + (i + 1);
    b.addEventListener('click', () => { send({ t: 'emote', e: i }); closeEmotes(); });
    emoteBox.appendChild(b);
  });

  $('copyLink').addEventListener('click', () => {
    const url = location.origin + location.pathname + '?server=' + encodeURIComponent(S.room);
    const done = () => toast('Đã copy link server, gửi cho đồng nghiệp nhé');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, () => toast(url));
    } else {
      toast(url);
    }
  });

  function showMute() {
    setButtonIcon($('mute'), S.muted ? 'volume-x' : 'volume-2');
    $('mute').setAttribute('aria-pressed', String(!S.muted));
  }
  try {
    S.muted = localStorage.getItem('br-sound') !== '1';
  } catch (e) { /* ignore */ }
  showMute();

  // A returning Home Screen app may need a fresh gesture to resume iOS audio.
  window.addEventListener('pointerdown', initAudio, {passive:true});
  window.addEventListener('keydown', initAudio);

  $('mute').addEventListener('click', () => {
    S.muted = !S.muted;
    showMute();
    if (!S.muted) initAudio();
    else audio.stop();
    try {
      localStorage.setItem('br-sound', S.muted ? '0' : '1');
    } catch (e) { /* ignore */ }
  });

  // ----------------------------------------------------------------- join ----
  // The two rooms that exist (keep in sync with ROOMS in lib/world.js; the server sends
  // the live list with player counts, this is only the fallback if that request fails).
  // The server picker is hidden while one server is enough; set true to show it again.
  const SHOW_SERVER_PICKER = false;
  const FALLBACK_ROOMS = [
    { id: 'br-1', name: 'BR-1' },
    { id: 'br-2', name: 'BR-2' },
  ];

  (function setupJoin() {
    const params = new URLSearchParams(location.search);
    // ?server= is the public name; ?room= keeps old shared links working.
    const roomParam = (params.get('server') || params.get('room') || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 24);
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
    // With the picker hidden everyone lands in the first server unless a ?server= link names another.
    if (!SHOW_SERVER_PICKER) {
      picked = picked || rooms[0].id;
      $('roomPick').hidden = true;
      $('joinForm').classList.add('no-server-pick');
    }
    let chosenByUser = picked !== null;
    const account = accountUI({
      room: () => picked || rooms[0].id,
      read: () => ({ name: $('nameInput').value, gender: S.gender, role: $('roleSelect').value, company: $('companyInput').value }),
      fill: p => {
        $('nameInput').value = S.name = p.name;
        $('companyInput').value = S.company = p.company;
        $('roleSelect').value = S.role = p.role;
        S.gender = p.gender;
        for (const radio of document.querySelectorAll('input[name="gender"]')) radio.checked = radio.value === p.gender;
        syncJoin();
      },
    });

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
          account.roomChanged();
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
      const previousRoom = picked;
      preselect();
      if (picked !== previousRoom) account.roomChanged();
      render();
    }
    preselect();
    render();
    // back into the office straight away after a reload (see autoJoin); the form stays hidden meanwhile
    const resume = () => {
      if (!autoJoin.on() || S.started) return;
      if (!$('nameInput').value.trim() || !scene) {
        document.documentElement.classList.remove('autojoin');
        return;
      }
      document.documentElement.classList.add('autojoin');
      setTimeout(() => document.documentElement.classList.remove('autojoin'), 8000); // never leave the form hidden
      $('joinForm').dispatchEvent(new Event('submit', { cancelable: true }));
    };
    if (picked !== null) resume(); // the room is in the URL: no need to wait for the server list
    refresh(true).then(async () => { await account.ready; resume(); }); // signed in or guest: a reload in game goes straight back in (sign-in/out clears the flag)
    setInterval(() => {
      if (!$('overlay').classList.contains('gone')) refresh();
    }, 15000);

    $('joinForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (joinBusy) return;
      if (!scene) { $('joinErr').textContent = 'Thiết bị hoặc trình duyệt này không bật được WebGL nên chưa chơi được bản 3D.'; return; }
      setJoinBusy(true);
      try { await account.beforeJoin(); } catch (err) { $('joinErr').textContent = err.message; setJoinBusy(false); return; }
      const name = $('nameInput').value.trim();
      if (!name) { setJoinBusy(false); return; }
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
      if (e.isTrusted) requestLandscape();
      connect();
    });
  })();

  // --------------------------------------------------------------- update ----
  function update(dt) {
    S.t += dt;
    S.shake = Math.max(0, S.shake - dt * 3);
    if (!S.joined) return;

    const duelOn = duelActive();
    $('duelBanner').hidden = !duelOn;
    $('duelApologyBtn').hidden = !(duelOn && S.duel.target === S.me && !S.players.get(S.me)?.dead && performance.now() >= S.duel.apologyAt);
    $('duelApologyHint').hidden = $('duelApologyBtn').hidden;
    updateApologyButton();
    if (duelOn) {
      const name = S.players.get(S.duel.target)?.name || 'Đồng nghiệp';
      $('duelText').textContent = (S.duel.target === S.me ? '🔒 PHÒNG KHÓA · Bạn đấu 1:1 với VKL' : '🔒 PHÒNG KHÓA · VKL vs ' + name) + ' · ' + Math.ceil((S.duel.until - performance.now()) / 1000) + 's';
    }
    const me = S.players.get(S.me);
    if (me) updateMe(me, dt);
    bossTick(dt);
    miniTick(dt);

    for (const p of S.players.values()) {
      if (p.forcedMotion) {
        const f = p.forcedMotion, t = clamp((performance.now() - f.t0) / f.ms, 0, 1);
        const eased = t * t * (3 - 2 * t);
        p.x = f.fromX + (f.x - f.fromX) * eased;
        p.y = f.fromY + (f.y - f.fromY) * eased;
        p.fxLift = Math.sin(t * Math.PI) * (f.kind === 'blow' ? 75 : 18);
        p.moving = false;
        if (t >= 1) { p.forcedMotion = null; p.fxLift = 0; p.x = p.tx = f.x; p.y = p.ty = f.y; }
      } else if (p.id !== S.me) {
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
    if (me.forcedMotion) { me.moving = false; return; }
    if (me.dead) {
      resetJoystick();
      me.moving = false;
      return; // knocked out: no walking, no swinging until the server revives us
    }
    if (mobilePortrait() || typing() || !exitEl.hidden || !updateEl.hidden || !helpEl.hidden || !rankEl.hidden || !settingsEl.hidden) {
      resetJoystick();
      me.moving = false;
      return;
    }
    // Recover even if capture disappeared without a lostpointercapture event.
    if (S.joystick.pointerId !== null && !joystick.hasPointerCapture(S.joystick.pointerId)) resetJoystick();
    let dx = S.joystick.x;
    let dy = S.joystick.y;
    if (S.keys.has('l')) dx -= 1;
    if (S.keys.has('r')) dx += 1;
    if (S.keys.has('u')) dy -= 1;
    if (S.keys.has('d')) dy += 1;

    if (dx || dy) {
      S.target = null;
      S.attackId = null;
    } else if (S.attackId !== null) {
      const o = typeof S.attackId === 'string' ? (S.attackId.startsWith('s:') ? snakeObj(Number(S.attackId.slice(2))) : playerObj(Number(S.attackId.slice(2)))) : S.attackId === BOSS_TARGET ? bossObj() : S.objects[S.attackId];
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
      const step = SPEED * dt * Math.min(1, len);
      const r = globalThis.BreakRoomActorCollision.slide(me.x, me.y,
        clamp(me.x + (dx / len) * step, 20, S.world.w - 20),
        clamp(me.y + (dy / len) * step, 20, S.world.h - 20), 16, solidBosses(), resolve
      );
      const allowed = constrainDuel(me, r.x, r.y);
      me.x = clamp(allowed.x, 20, S.world.w - 20);
      me.y = clamp(allowed.y, 20, S.world.h - 20);
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
    if (scene) scene.resize(viewport.width, viewport.height);
    if (mm.source) { mmBuild(mm.source.world, mm.source.props, mm.source.zones); mmPlace(); if (mm.open) mmFull(true); }
  }
  window.addEventListener('gameviewportchange', resize);
  resize();

  // ----------------------------------------------------------------- loop ----
  let last = performance.now();
  function positionOfficeNotice() {
    const bottom = $('topbar').getBoundingClientRect().bottom - $('app').getBoundingClientRect().top;
    $('officeNotice').style.setProperty('--office-notice-top', Math.ceil(bottom + 8) + 'px');
  }
  if (window.ResizeObserver) new ResizeObserver(positionOfficeNotice).observe($('topbar'));
  window.addEventListener('resize', positionOfficeNotice);
  let officeNoticeText = '';
  function updateOfficeNotice() {
    const s = S.officePatrol;
    const active = S.joined && s && s.phase !== 'idle';
    const seconds = s ? Math.max(0, Math.ceil((s.until - Date.now()) / 1000)) : 0;
    const text = !active ? '' : s.phase === 'warning'
      ? 'Ban lãnh đạo xuống lắng nghe. Bằng nắm đấm. · ' + seconds + 's'
      : s.phase === 'active' && seconds > 0
        ? 'VKL, TML và DMM đang đi tuần — gặp ai cũng hỏi thăm! · ' + seconds + 's'
        : 'Ban lãnh đạo đang về phòng. Tạm thời được thở.';
    // Tense music while the bosses are out: a heartbeat for the warning, the full loop for the hunt.
    audio.music(!active ? 0 : s.phase === 'warning' ? 1 : s.phase === 'active' && seconds > 0 ? 2 : 0);
    if (text === officeNoticeText) return;
    officeNoticeText = text;
    $('officeNotice').textContent = text;
    $('officeNotice').hidden = !text;
    if (text) positionOfficeNotice();
  }

  function frame(now) {
    updateOfficeNotice();
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
