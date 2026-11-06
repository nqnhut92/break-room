// Short CC0 foley gives impacts their material; synthesis adds weapon accents.
// No AudioContext or downloads until a player gesture enables sound.
const WOOD = new Set(['desk','table','conference','bookcase','coatrack','speaker']);
const METAL = new Set(['server','safe','fridge','trash','lamp']);
const GLASS = new Set(['monitor','tv','toilet','sink','plant']);
export function materialFor(type) {
  return WOOD.has(type) ? 'Wood' : METAL.has(type) ? 'Metal' : GLASS.has(type) ? 'Glass'
    : type === 'body' ? 'Punch' : type === 'sofa' || type === 'chair' ? 'Soft' : 'Plate';
}
export function distanceVolume(distance) {
  const v = Math.max(0, 1 - distance / 1000);
  return v * v;
}
const GROUPS = ['Wood','Metal','Glass','Punch','Soft','Plate'];
const DESTRUCTION = ['shatter-glass','splinter-wood','slam-metal'];
export function createGameAudio(isMuted) {
  let ctx, master, normalBus, bossBus, loading, noiseBuffer;
  const buffers = new Map(), previous = new Map(), voices = new Set();
  function stop() {
    for (const voice of voices) { try { voice.source.stop(); } catch (_) { /* already ended */ } }
    if (musicBus) { musicBus.gain.cancelScheduledValues(ctx.currentTime); musicBus.gain.setValueAtTime(0, ctx.currentTime); }
    clearInterval(musicTimer); musicTimer = 0; musicLevel = 0;
  }
  // Patrol music: a tense loop synthesised on the spot (no downloaded track, nothing to license).
  // 152 bpm in A minor: a pulsing bass and ticking hats while the warning runs, then kick and a staccato lead for the hunt.
  const MUSIC = { bpm: 152, vol: .22 };
  const BASS = [45, 45, 41, 43]; // root per bar (MIDI): A1 A1 F1 G1
  const LEAD = [69, 72, 76, 72, 69, 72, 77, 72, 69, 72, 76, 72, 71, 74, 79, 74]; // one bar of sixteenths
  const hz = n => 440 * 2 ** ((n - 69) / 12);
  let musicBus, musicTimer = 0, musicStep = 0, musicNext = 0, musicLevel = 0; // level: 0 off, 1 warning, 2 hunt
  function musicNote(type, freq, t, dur, vol, cutoff) {
    const osc = ctx.createOscillator(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, t);
    filter.type = 'lowpass'; filter.frequency.value = cutoff; filter.Q.value = 3;
    gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(vol, t + .005); gain.gain.exponentialRampToValueAtTime(.0001, t + dur);
    osc.connect(filter); filter.connect(gain); gain.connect(musicBus);
    osc.onended = () => { osc.disconnect(); filter.disconnect(); gain.disconnect(); };
    osc.start(t); osc.stop(t + dur + .02);
  }
  function musicKick(t, vol) {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.setValueAtTime(130, t); osc.frequency.exponentialRampToValueAtTime(42, t + .12);
    gain.gain.setValueAtTime(vol, t); gain.gain.exponentialRampToValueAtTime(.0001, t + .18);
    osc.connect(gain); gain.connect(musicBus);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    osc.start(t); osc.stop(t + .2);
  }
  function musicHat(t, vol) {
    const src = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    src.buffer = noiseBuffer; filter.type = 'highpass'; filter.frequency.value = 7000;
    gain.gain.setValueAtTime(vol, t); gain.gain.exponentialRampToValueAtTime(.0001, t + .035);
    src.connect(filter); filter.connect(gain); gain.connect(musicBus);
    src.onended = () => { src.disconnect(); filter.disconnect(); gain.disconnect(); };
    src.start(t, Math.random() * .5); src.stop(t + .05);
  }
  function musicTick() {
    if (!ctx || ctx.state !== 'running') return;
    const sixteenth = 60 / MUSIC.bpm / 4;
    if (musicNext < ctx.currentTime) musicNext = ctx.currentTime + .05;
    while (musicNext < ctx.currentTime + .12) { // schedule a little ahead so timer jitter never shows
      const s = musicStep % 64, beat = s % 16, bar = s >> 4, t = musicNext, hunt = musicLevel > 1;
      if (s % 2 === 0) musicNote('sawtooth', hz(BASS[bar]), t, sixteenth * 1.6, hunt ? .5 : .35, 380);
      if (hunt ? beat % 4 === 0 : beat % 8 === 0) musicKick(t, hunt ? .9 : .5); // a heartbeat during the warning
      musicHat(t, beat % 4 === 2 ? .22 : .1);
      if (hunt) musicNote('square', hz(LEAD[beat] + (bar === 2 ? -4 : bar === 3 ? -2 : 0)), t, sixteenth * .8, .09, 2600);
      musicStep++; musicNext += sixteenth;
    }
  }
  function music(level) {
    if (!ctx) return; // sound is not enabled yet
    const want = isMuted() ? 0 : level;
    if (want === musicLevel) return;
    if (!musicBus) { musicBus = ctx.createGain(); musicBus.gain.value = 0; musicBus.connect(master); }
    const t = ctx.currentTime, g = musicBus.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    if (want) {
      if (!musicLevel && !musicTimer) { musicStep = 0; musicNext = 0; }
      g.linearRampToValueAtTime(MUSIC.vol, t + .6);
      if (!musicTimer) musicTimer = setInterval(musicTick, 25);
    } else {
      g.linearRampToValueAtTime(0, t + 1.5);
      setTimeout(() => { if (!musicLevel) { clearInterval(musicTimer); musicTimer = 0; } }, 1700);
    }
    musicLevel = want;
  }
  function init() {
    if (!ctx) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -12; compressor.knee.value = 12;
        compressor.ratio.value = 3; compressor.attack.value = .012; compressor.release.value = .12;
        master = ctx.createGain(); master.gain.value = .65;
        normalBus = ctx.createGain(); normalBus.gain.value = .8;
        bossBus = ctx.createGain();
        normalBus.connect(master); bossBus.connect(master);
        // Catch coincident transients before the compressor's attack has settled.
        const ceiling = ctx.createWaveShaper();
        ceiling.curve = Float32Array.from({length:2049}, (_,i) => {
          const x=i/1024-1, a=Math.abs(x);
          return Math.sign(x)*(a<=.6 ? a : .6+.3*Math.tanh((a-.6)/.3));
        });
        master.connect(compressor); compressor.connect(ceiling); ceiling.connect(ctx.destination);
        noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i=0;i<data.length;i++) data[i]=Math.random()*2-1;
        const keys = GROUPS.flatMap(group => ['medium','heavy'].flatMap(weight => [0,1].map(i => `impact${group}_${weight}_00${i}`)));
        loading = Promise.allSettled([...keys,...DESTRUCTION].map(async key => {
          const response = await fetch(new URL(`./assets/audio/${key}.wav`, import.meta.url));
          if (!response.ok) throw new Error('audio sample unavailable');
          buffers.set(key, await ctx.decodeAudioData(await response.arrayBuffer()));
        }));
      } catch (_) { ctx = null; return Promise.resolve(); }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return loading;
  }
  function available(v) { return ctx && ctx.state === 'running' && !isMuted() && v > .015; }
  function play(source, vol, duration, delay=0, filter=null, options={}) {
    if (!available(vol)) return;
    // Keep busy rooms bounded; a nearby hit can replace the quietest distant layer.
    if (voices.size >= 24) {
      const quietest = [...voices].reduce((a,b) => a.priority < b.priority || (a.priority === b.priority && a.vol < b.vol) ? a : b);
      const priority = options.boss ? 1 : 0;
      if (quietest.priority > priority || (quietest.priority === priority && quietest.vol >= vol)) return;
      try { quietest.source.stop(); } catch (_) { /* already stopped */ }
      voices.delete(quietest);
    }
    const t=ctx.currentTime+delay, gain=ctx.createGain();
    gain.gain.setValueAtTime(0,t);
    gain.gain.linearRampToValueAtTime(vol,t+.002);
    if (options.natural) {
      // PCM already has its own attack/body/debris decay. Fading the entire file
      // exponentially erased its tail (~40dB halfway through every recording).
      gain.gain.setValueAtTime(vol,t+Math.max(.003,duration-.012));
      gain.gain.linearRampToValueAtTime(0,t+duration);
    } else gain.gain.exponentialRampToValueAtTime(.0001,t+duration);
    source.connect(filter || gain); if (filter) filter.connect(gain);
    gain.connect(options.boss ? bossBus : normalBus);
    const voice={source,vol,priority:options.boss ? 1 : 0}; voices.add(voice);
    source.onended=()=>{voices.delete(voice);source.disconnect();filter?.disconnect();gain.disconnect();};
    source.start(t); source.stop(t+duration+.005);
  }
  function noise(dur, freq, vol, delay=0, options={}) {
    if (!available(vol)) return;
    const src=ctx.createBufferSource(); src.buffer=noiseBuffer;
    src.playbackRate.value=.9+Math.random()*.2;
    const filter=ctx.createBiquadFilter(); filter.type='bandpass';filter.frequency.value=freq;filter.Q.value=.7;
    play(src,vol,dur,delay,filter,options);
  }
  function tone(freq,dur,vol,slide=0,delay=0) {
    if (!available(vol)) return;
    const osc=ctx.createOscillator();osc.type='sine';
    osc.frequency.setValueAtTime(freq,ctx.currentTime+delay);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30,freq+slide),ctx.currentTime+delay+dur);
    play(osc,vol,dur,delay);
  }
  function recording(key,v,rate=1,delay=0,options={}) {
    if (!available(v)) return;
    const buffer=buffers.get(key);
    if (!buffer) { noise(.07,2400,v*.3,delay,options); return; }
    const src=ctx.createBufferSource();src.buffer=buffer;
    src.playbackRate.value=rate*(.96+Math.random()*.08);
    play(src,v,buffer.duration/src.playbackRate.value,delay,null,{...options,natural:true});
  }
  function sample(group,weight,v,rate=1,delay=0,options={}) {
    if (!available(v)) return;
    const family=group+weight, last=previous.get(family);
    const i=last === undefined ? Math.floor(Math.random()*2) : 1-last;
    previous.set(family,i);
    recording(`impact${group}_${weight}_00${i}`,v,rate,delay,options);
  }
  function bossFocus(v) {
    if (!available(v)) return false;
    const t=ctx.currentTime, gain=normalBus.gain;
    gain.cancelScheduledValues(t);gain.setValueAtTime(gain.value,t);
    gain.linearRampToValueAtTime(.8*(1-.65*v),t+.008);
    gain.setValueAtTime(.8*(1-.65*v),t+.15);
    gain.linearRampToValueAtTime(.8,t+.32);
    return true;
  }
  function accent(skill,v) {
    if (skill==='electric') { noise(.035,6500,v*.22);noise(.065,3200,v*.13,.035); }
    if (skill==='milkTea') for(let i=0;i<3;i++)tone(600+Math.random()*600,.035,v*.12,-220,i*.018);
  }
  return {
    init, stop, music,
    hit(v,type='body',skill='hammer') {
      sample(materialFor(type),'medium',v*.75);
      // Keep the contact bright; a generic bass thump made all materials sound alike.
      noise(.018,3200,v*.1); accent(skill,v);
    },
    break(v,type='desk') {
      const group=materialFor(type);
      const key=group==='Glass'?'shatter-glass':group==='Wood'||group==='Soft'?'splinter-wood':'slam-metal';
      recording(key,v*.85);
      sample(group,'heavy',v*.32,1.05);
      // Electronics have both a casing and small glass/plastic fragments.
      if (group==='Plate') recording('shatter-glass',v*.24,1.3,.025);
      sample(group,'medium',v*.14,1.35,.13);
      sample(group,'medium',v*.08,1.65,.28);
    },
    strike(v,kind='boss') {
      const mini=kind==='mini';
      if (!bossFocus(v*(mini?.6:1))) return;
      // A blow on a body: a heavy punch over a soft thud, with no metal ring.
      sample('Punch','heavy',v*(mini?.55:.9),mini?1.1:.9,0,{boss:true});
      sample('Soft','heavy',v*(mini?.3:.55),mini?1.05:.8,.012,{boss:true});
      noise(.05,900,v*.16,0,{boss:true});
    },
    hurt() { sample('Punch','medium',.48,1,0,{boss:true}); },
    down(v) {
      if (!bossFocus(v)) return;
      recording('splinter-wood',v*.7,.85,0,{boss:true});
      sample('Punch','heavy',v*.55,.85,0,{boss:true});
      sample('Soft','heavy',v*.4,.75,.09,{boss:true});
    },
    cue(v,kind='cast') {
      // Prof. K's announcement: a friendly rising three-note chime, nothing like the bosses' cues.
      if (kind==='profk') { tone(523,.09,v*.14);tone(659,.09,v*.13,0,.1);tone(784,.16,v*.13,0,.2); return; }
      // Rare abilities only: a short two-note cue, never the old sawtooth wind-up.
      tone(kind==='newProcess'?660:440,.065,v*.16,0);
      tone(kind==='newProcess'?880:660,.075,v*.12,0,.075);
    },
    reset() { tone(880,.1,.15);tone(1320,.14,.12,0,.12); },
    get ready() { return buffers.size; },
    get activeVoices() { return voices.size; },
  };
}
