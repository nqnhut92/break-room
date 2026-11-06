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
export function createGameAudio(isMuted) {
  let ctx, master, loading, noiseBuffer;
  const buffers = new Map(), previous = new Map(), voices = new Set();
  function stop() {
    for (const voice of voices) { try { voice.source.stop(); } catch (_) { /* already ended */ } }
  }
  function init() {
    if (!ctx) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -12; compressor.knee.value = 12;
        compressor.ratio.value = 6; compressor.attack.value = .003; compressor.release.value = .12;
        master = ctx.createGain(); master.gain.value = .65;
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
        loading = Promise.allSettled(GROUPS.flatMap(group => ['medium','heavy'].flatMap(weight => [0,1].map(async i => {
          const key = `impact${group}_${weight}_00${i}`;
          const response = await fetch(new URL(`./assets/audio/${key}.wav`, import.meta.url));
          if (!response.ok) throw new Error('audio sample unavailable');
          buffers.set(key, await ctx.decodeAudioData(await response.arrayBuffer()));
        }))));
      } catch (_) { ctx = null; return Promise.resolve(); }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return loading;
  }
  function available(v) { return ctx && ctx.state === 'running' && !isMuted() && v > .015; }
  function play(source, vol, duration, delay=0, filter=null) {
    if (!available(vol)) return;
    // Keep busy rooms bounded; a nearby hit can replace the quietest distant layer.
    if (voices.size >= 24) {
      const quietest = [...voices].reduce((a,b) => a.vol < b.vol ? a : b);
      if (quietest.vol >= vol) return;
      try { quietest.source.stop(); } catch (_) { /* already stopped */ }
      voices.delete(quietest);
    }
    const t=ctx.currentTime+delay, gain=ctx.createGain();
    gain.gain.setValueAtTime(0,t);
    gain.gain.linearRampToValueAtTime(vol,t+.002);
    gain.gain.exponentialRampToValueAtTime(.0001,t+duration);
    source.connect(filter || gain); if (filter) filter.connect(gain);
    gain.connect(master);
    const voice={source,vol}; voices.add(voice);
    source.onended=()=>{voices.delete(voice);source.disconnect();filter?.disconnect();gain.disconnect();};
    source.start(t); source.stop(t+duration+.005);
  }
  function noise(dur, freq, vol, delay=0) {
    if (!available(vol)) return;
    const src=ctx.createBufferSource(); src.buffer=noiseBuffer;
    src.playbackRate.value=.9+Math.random()*.2;
    const filter=ctx.createBiquadFilter(); filter.type='bandpass';filter.frequency.value=freq;filter.Q.value=.7;
    play(src,vol,dur,delay,filter);
  }
  function tone(freq,dur,vol,slide=0,delay=0) {
    if (!available(vol)) return;
    const osc=ctx.createOscillator();osc.type='sine';
    osc.frequency.setValueAtTime(freq,ctx.currentTime+delay);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30,freq+slide),ctx.currentTime+delay+dur);
    play(osc,vol,dur,delay);
  }
  function sample(group,weight,v,rate=1,delay=0) {
    if (!available(v)) return;
    const family=group+weight, last=previous.get(family);
    const i=last === undefined ? Math.floor(Math.random()*2) : 1-last;
    previous.set(family,i);
    const buffer=buffers.get(`impact${group}_${weight}_00${i}`);
    if (!buffer) { noise(.055,group==='Metal'?3000:1800,v*.35,delay); return; }
    const src=ctx.createBufferSource();src.buffer=buffer;
    src.playbackRate.value=rate*(.94+Math.random()*.12);
    play(src,v,Math.min(.65,buffer.duration/src.playbackRate.value),delay);
  }
  function accent(skill,v) {
    if (skill==='electric') { noise(.035,6500,v*.22);noise(.065,3200,v*.13,.035); }
    if (skill==='milkTea') for(let i=0;i<3;i++)tone(600+Math.random()*600,.035,v*.12,-220,i*.018);
  }
  return {
    init, stop,
    hit(v,type='body',skill='hammer') {
      sample(materialFor(type),'medium',v*.75);
      // A tiny, short body supports small speakers without masking the foley attack.
      tone(170,.065,v*.09,-70); accent(skill,v);
    },
    break(v,type='desk') {
      const group=materialFor(type);
      sample(group,'heavy',v*.9,.92);
      sample(group,'medium',v*.28,1.25,.055);
      noise(.09,group==='Glass'?5800:2400,v*.12,.035);
    },
    strike(v) { sample('Punch','heavy',v*.95,.82);sample('Wood','heavy',v*.25,.8,.015); },
    hurt() { sample('Punch','medium',.58,.88); },
    down(v) { sample('Punch','heavy',v,.72);sample('Soft','heavy',v*.65,.8,.09);tone(110,.12,v*.12,-55); },
    cue(v,kind='cast') {
      // Rare abilities only: a short two-note cue, never the old sawtooth wind-up.
      tone(kind==='newProcess'?660:440,.065,v*.16,0);
      tone(kind==='newProcess'?880:660,.075,v*.12,0,.075);
    },
    reset() { tone(880,.1,.15);tone(1320,.14,.12,0,.12); },
    get ready() { return buffers.size; },
    get activeVoices() { return voices.size; },
  };
}
