import type { Vector3 } from 'three';
import type { WeaponId } from '../weapons/Weapon';

/** Tiny synthesized sound kit (WebAudio), no audio files needed. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private master: GainNode | null = null;
  private ambient: GainNode | null = null;
  private engine: { osc: OscillatorNode; sub: OscillatorNode; filter: BiquadFilterNode; gain: GainNode; air: BiquadFilterNode; airGain: GainNode; rpm: number } | null = null;
  private storm: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  private rain: { gain: GainNode; tone: BiquadFilterNode } | null = null;
  private rainLevel = 0;
  private roofT = 0;
  /** Bus cabin, skydiving and glider loops. */
  private air: { drone: GainNode; cabin: GainNode; wind: GainNode; windF: BiquadFilterNode; droneOsc: OscillatorNode[] } | null = null;
  private flapAt = 0;
  /** Soft brown-ish noise for loops: no hiss, no audible repeat. */
  private pink: AudioBuffer | null = null;
  private zip: { gain: GainNode; osc: OscillatorNode } | null = null;
  /** Live one-shot voices; new low-priority sounds are skipped once we hit the cap. */
  /** When each live one-shot ends; counting by time can never leak a slot. */
  private ends: number[] = [];
  get voices() {
    return this.ends.length;
  }
  private static readonly MAX_VOICES = 64;
  /** Gunshot bodies go through a soft clipper for punch. */
  private punchBus: GainNode | null = null;
  /** Reverb send (a generated room / valley impulse). */
  private verbIn: GainNode | null = null;
  /** Reload sounds still to play, so a cancelled reload goes quiet. */
  private pending: AudioScheduledSourceNode[] = [];
  private impactCd = 0;
  /** Under a roof: gunfire rings in the room instead of echoing across the valley. */
  indoor = false;
  listener: { pos: Vector3; yaw: number } | null = null;
  volume = 0.6;
  ambientVolume = 0.5;

  private paused = false;

  /** Paused: game sounds (rain, wind, storm...) fade out; the music has its own output and plays on. */
  setPaused(p: boolean) {
    this.paused = p;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(p ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  setVolume(v: number, ambient = this.ambientVolume) {
    this.volume = v;
    this.ambientVolume = ambient;
    if (this.master) this.master.gain.value = this.paused ? 0 : v;
    if (this.ambient) this.ambient.gain.value = ambient;
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    // A gentle bus compressor glues the layers together and stops big firefights from clipping.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 5;
    comp.attack.value = 0.002;
    comp.release.value = 0.18;
    this.master.connect(comp).connect(ctx.destination);
    // Punch bus: soft saturation so gunshots hit hard without getting louder.
    this.punchBus = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    this.punchBus.connect(shaper).connect(this.master);
    // Reverb: decaying stereo noise, darker as it fades.
    const irLen = Math.floor(ctx.sampleRate * 2.4);
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < irLen; i++) {
        const t = i / irLen;
        const k = 0.35 + 0.6 * t; // more smoothing (darker) later in the tail
        lp = lp * k + (Math.random() * 2 - 1) * (1 - k);
        d[i] = lp * Math.pow(1 - t, 3.2) * (i < ctx.sampleRate * 0.01 ? i / (ctx.sampleRate * 0.01) : 1);
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    this.verbIn = ctx.createGain();
    this.verbIn.gain.value = 1;
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.9;
    this.verbIn.connect(conv).connect(verbOut).connect(this.master);
    this.ambient = ctx.createGain();
    this.ambient.gain.value = this.ambientVolume;
    this.ambient.connect(this.master);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // Pink noise (Paul Kellet's filter), 6 s so the loop never sounds like a loop.
    const plen = ctx.sampleRate * 6;
    this.pink = ctx.createBuffer(1, plen, ctx.sampleRate);
    const p = this.pink.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < plen; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      p[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    // Crossfade the ends so the loop point is seamless.
    const xf = Math.floor(ctx.sampleRate * 0.25);
    for (let i = 0; i < xf; i++) {
      const k = i / xf;
      p[i] = p[i] * k + p[plen - xf + i] * (1 - k);
    }
  }

  /** The shared context, for the music player. */
  get audio() {
    return this.ctx;
  }

  private loop(buf: AudioBuffer, ...chain: AudioNode[]) {
    const src = this.ctx!.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    let n: AudioNode = src;
    for (const c of chain) n = n.connect(c);
    src.start(0, Math.random() * buf.duration);
    return src;
  }

  private filter(type: BiquadFilterType, freq: number, q = 0.7) {
    const f = this.ctx!.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  private silentGain() {
    const g = this.ctx!.createGain();
    g.gain.value = 0;
    return g;
  }

  /** A filtered noise swoosh whose pitch sweeps from f0 to f1. */
  private sweep(dur: number, f0: number, f1: number, gain: number, attack = 0.1, q = 0.8, delay = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.pink || !this.master) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.pink;
    const f = this.filter('bandpass', f0, q);
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 4);
    src.stop(t + dur + 0.05);
  }

  /** Stereo pan and distance attenuation for a world position. */
  private spatial(at: Vector3 | undefined, dist: number, falloff = 30) {
    const att = 1 / (1 + dist / falloff);
    let pan = 0;
    if (at && this.listener) {
      const dx = at.x - this.listener.pos.x, dz = at.z - this.listener.pos.z;
      const rx = Math.cos(this.listener.yaw), rz = -Math.sin(this.listener.yaw);
      pan = Math.max(-1, Math.min(1, (dx * rx + dz * rz) / (Math.hypot(dx, dz) || 1)));
    }
    return { att, pan };
  }

  private distTo(at: Vector3) {
    return this.listener ? Math.hypot(at.x - this.listener.pos.x, at.y - this.listener.pos.y, at.z - this.listener.pos.z) : 0;
  }

  private burst(opts: { dur: number; freq: number; q?: number; gain: number; type?: BiquadFilterType; pan?: number; delay?: number; bus?: 'master' | 'ambient' | 'punch'; attack?: number; verb?: number; sweepTo?: number }) {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.master || opts.gain < 0.002) return null;
    const t = ctx.currentTime + (opts.delay ?? 0);
    if (!this.claimVoice(opts.gain, t + opts.dur + 0.05)) return null;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = opts.type ?? 'lowpass';
    f.frequency.value = opts.freq;
    f.Q.value = opts.q ?? 0.8;
    if (opts.sweepTo) {
      f.frequency.setValueAtTime(opts.freq, t);
      f.frequency.exponentialRampToValueAtTime(opts.sweepTo, t + opts.dur);
    }
    const g = ctx.createGain();
    if (opts.attack) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(opts.gain, t + opts.attack);
    } else g.gain.setValueAtTime(opts.gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + opts.dur);
    const p = ctx.createStereoPanner();
    p.pan.value = opts.pan ?? 0;
    src.connect(f).connect(g).connect(p).connect(this.busNode(opts.bus));
    if (opts.verb && this.verbIn) {
      const s = ctx.createGain();
      s.gain.value = opts.verb;
      p.connect(s).connect(this.verbIn);
    }
    src.start(t, Math.random() * 1.5);
    src.stop(t + opts.dur + 0.05);
    return src;
  }

  private busNode(bus?: 'master' | 'ambient' | 'punch') {
    return bus === 'ambient' ? this.ambient! : bus === 'punch' ? this.punchBus ?? this.master! : this.master!;
  }

  /** Quiet sounds give way first when lots are playing at once. */
  private claimVoice(gain: number, until: number) {
    const now = this.ctx!.currentTime;
    if (this.ends.length > 8) this.ends = this.ends.filter((e) => e > now);
    const load = this.ends.length / Sfx.MAX_VOICES;
    if (load >= 1 || (load > 0.7 && gain < 0.08)) return false;
    this.ends.push(until);
    return true;
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', slideTo?: number, delay = 0, pan = 0, bus: 'master' | 'ambient' | 'punch' = 'master', verb = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.master || gain < 0.002) return null;
    const t = ctx.currentTime + delay;
    if (!this.claimVoice(gain, t + dur + 0.05)) return null;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    o.connect(g).connect(p).connect(this.busNode(bus));
    if (verb && this.verbIn) {
      const s = ctx.createGain();
      s.gain.value = verb;
      p.connect(s).connect(this.verbIn);
    }
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  /**
   * A gunshot built from layers: a sharp transient snap, a saturated body, a sub thump, a short crack,
   * then the environment answering (a room ring indoors, a rolling echo outdoors). Distant shots arrive
   * late (speed of sound), dull and boomy. Every shot is slightly different so sprays don't sound
   * like a loop. `dist` 0 = our own gun.
   */
  shot(id: WeaponId, dist: number, at?: Vector3, lowMag = false) {
    if (dist > 420) return;
    const own = dist === 0;
    const P = GUN[id];
    const { att, pan } = this.spatial(at, dist, 35);
    const v = 0.93 + Math.random() * 0.14;
    const far = dist > 70;
    const delay = own ? 0 : Math.min(0.9, dist / 343);
    const g = P.gain * att * (own ? 1 : 1.15);
    const room = this.indoor;
    const verb = (room ? 0.5 : 0.16) * (far ? 1.6 : 1);
    if (!far) {
      this.burst({ dur: 0.02, freq: 3800 * v, type: 'highpass', q: 0.6, gain: g * 0.55 * P.snap, pan, delay, bus: 'punch' });
      this.burst({ dur: P.body * v, freq: P.freq * v, q: 1.2, gain: g * 1.15, pan, delay, bus: 'punch', verb });
      this.tone(P.thump * v, P.body * 1.3, g * 0.8, 'sine', 36, delay, pan, 'punch');
      this.burst({ dur: P.body * 0.55, freq: 1700 * v, type: 'bandpass', q: 1.4, gain: g * 0.3 * P.snap, pan, delay });
    } else {
      // Far away: the crack is gone, just a thump and a boom rolling across the island.
      this.burst({ dur: P.body * 1.8, freq: P.freq * 0.28, q: 0.9, gain: g * 1.1, pan, delay, verb });
      this.tone(P.thump * 0.75, P.body * 1.6, g * 0.45, 'sine', 32, delay, pan);
    }
    // The environment answers.
    this.burst({ dur: P.tail * (room ? 0.55 : 1), freq: far ? 380 : room ? 1100 : 720, sweepTo: far ? 180 : 320, type: 'bandpass', q: 0.6, gain: g * (room ? 0.3 : 0.2), pan, delay: delay + 0.02, attack: 0.015, verb });
    if (!room && dist < 200) this.burst({ dur: P.tail * 0.7, freq: 520, type: 'bandpass', q: 0.8, gain: g * 0.09, pan: -pan * 0.6, delay: delay + 0.14 + Math.random() * 0.08, attack: 0.02 });
    if (id === 'rocket') {
      this.tone(210, 0.55, g * 0.35, 'sawtooth', 80, delay, pan);
      this.sweep(0.8, 900, 2600, g * 0.25, 0.05, 0.8, delay);
    }
    if (!own) return;
    // Mechanical bits you only hear on your own gun.
    if (id === 'shotgun') this.pump(0.34);
    else if (id === 'sniper') this.bolt(0.42);
    else if (id === 'revolver') this.burst({ dur: 0.03, freq: 3200, type: 'bandpass', q: 5, gain: 0.12, delay: 0.16 });
    else if (id !== 'rocket') {
      this.burst({ dur: 0.012, freq: 5200, type: 'bandpass', q: 3, gain: 0.08 });
      // Brass bouncing on the ground.
      if (Math.random() < 0.45) {
        const d = 0.32 + Math.random() * 0.25, f = 4200 + Math.random() * 1800;
        this.tone(f, 0.05, 0.022, 'triangle', undefined, d, 0.4);
        this.tone(f * 1.12, 0.04, 0.014, 'triangle', undefined, d + 0.07 + Math.random() * 0.05, 0.45);
      }
    }
    // Running dry: a bright ping on the last few rounds so you know without looking.
    if (lowMag) this.tone(2100, 0.09, 0.06, 'triangle', 2000, 0.02);
  }

  /** Pump-action rack: back, then forward. */
  private pump(delay: number) {
    this.burst({ dur: 0.07, freq: 1300, type: 'bandpass', q: 2, gain: 0.3, delay });
    this.burst({ dur: 0.03, freq: 3200, type: 'bandpass', q: 4, gain: 0.18, delay: delay + 0.02 });
    this.burst({ dur: 0.07, freq: 1000, type: 'bandpass', q: 2, gain: 0.32, delay: delay + 0.17 });
    this.burst({ dur: 0.025, freq: 2600, type: 'bandpass', q: 4, gain: 0.2, delay: delay + 0.2 });
  }
  /** Bolt action: lift, pull, push, lock. */
  private bolt(delay: number) {
    [[0, 2600, 0.12], [0.12, 1500, 0.2], [0.34, 1800, 0.22], [0.46, 3000, 0.14]].forEach(([d, f, gn]) =>
      this.burst({ dur: 0.05, freq: f, type: 'bandpass', q: 3, gain: gn, delay: delay + d }));
  }

  /** Where a bullet lands near you: a dusty thwack, sometimes a ricochet whine. */
  impact(at: Vector3, hard: boolean) {
    if (this.impactCd > (this.ctx?.currentTime ?? 0)) return;
    const dist = this.distTo(at);
    if (dist > 45) return;
    this.impactCd = (this.ctx?.currentTime ?? 0) + 0.035;
    const { att, pan } = this.spatial(at, dist, 10);
    this.burst({ dur: 0.05, freq: hard ? 2400 : 900, type: 'bandpass', q: 1.2, gain: 0.22 * att, pan });
    this.burst({ dur: 0.08, freq: 300, gain: 0.14 * att, pan });
    if (hard && Math.random() < 0.18) this.tone(3200 + Math.random() * 1500, 0.22, 0.045 * att, 'sine', 1300, 0.01, pan, 'master', 0.2);
  }

  /** Reload foley timed to the animation: mag out, mag in, charging handle. */
  reloadStart(id: WeaponId, total: number) {
    this.cancelReload();
    const keep = (n: AudioScheduledSourceNode | null) => n && this.pending.push(n);
    this.burst({ dur: 0.18, freq: 900, type: 'bandpass', q: 0.7, gain: 0.08, attack: 0.04 }); // cloth / grab
    if (id === 'shotgun') return;
    if (id === 'revolver') {
      keep(this.burst({ dur: 0.05, freq: 2400, type: 'bandpass', q: 4, gain: 0.2, delay: total * 0.12 }));
      for (let i = 0; i < 3; i++) keep(this.tone(3600 + i * 150, 0.05, 0.03, 'triangle', undefined, total * 0.3 + i * 0.05, 0.3));
      keep(this.burst({ dur: 0.05, freq: 2000, type: 'bandpass', q: 4, gain: 0.25, delay: total * 0.88 }));
      return;
    }
    if (id === 'rocket') {
      keep(this.burst({ dur: 0.25, freq: 600, type: 'bandpass', q: 1, gain: 0.2, delay: total * 0.3, attack: 0.05 }));
      keep(this.burst({ dur: 0.06, freq: 1600, type: 'bandpass', q: 3, gain: 0.3, delay: total * 0.75 }));
      return;
    }
    // Mag out: release click, then the slide of the mag.
    keep(this.burst({ dur: 0.025, freq: 3400, type: 'bandpass', q: 5, gain: 0.2, delay: total * 0.12 }));
    keep(this.burst({ dur: 0.09, freq: 1200, type: 'bandpass', q: 1.5, gain: 0.16, delay: total * 0.14 }));
    // Mag in: a solid seat.
    keep(this.burst({ dur: 0.05, freq: 700, gain: 0.25, delay: total * 0.58 }));
    keep(this.burst({ dur: 0.03, freq: 2600, type: 'bandpass', q: 4, gain: 0.28, delay: total * 0.6 }));
    // Charging handle / slide.
    keep(this.burst({ dur: 0.04, freq: 2200, type: 'bandpass', q: 3, gain: 0.24, delay: total * 0.84 }));
    keep(this.burst({ dur: 0.035, freq: 3000, type: 'bandpass', q: 4, gain: 0.26, delay: total * 0.84 + 0.09 }));
  }
  cancelReload() {
    for (const n of this.pending) {
      try { n.stop(); } catch { /* already done */ }
    }
    this.pending.length = 0;
  }
  /** One shotgun shell pushed into the tube. */
  shellIn() {
    this.burst({ dur: 0.04, freq: 1500, type: 'bandpass', q: 2, gain: 0.22 });
    this.burst({ dur: 0.03, freq: 3000, type: 'bandpass', q: 4, gain: 0.12, delay: 0.05 });
  }
  shotgunClose() {
    this.pump(0.02);
  }

  punch() {
    this.burst({ dur: 0.14, freq: 1100, type: 'bandpass', q: 1.2, gain: 0.18, attack: 0.03 });
    this.tone(130, 0.09, 0.22, 'sine', 55, 0.08);
  }
  /** Low health: a soft double thump. */
  heartbeat(strength: number) {
    this.tone(62, 0.12, 0.35 * strength, 'sine', 40);
    this.tone(58, 0.14, 0.25 * strength, 'sine', 38, 0.22);
  }
  /** Your bullet landing: a meaty tick on flesh, a metallic clink on armor, a ringing dink on the head. */
  hit(head: boolean, armor = false) {
    if (head) {
      this.tone(2600, 0.16, 0.2, 'triangle', 2500);
      this.tone(3900, 0.1, 0.07, 'sine');
      this.burst({ dur: 0.04, freq: 5000, type: 'bandpass', q: 3, gain: 0.12 });
    } else if (armor) {
      this.burst({ dur: 0.07, freq: 3300, type: 'bandpass', q: 7, gain: 0.28 });
      this.tone(1850, 0.06, 0.07, 'triangle');
    } else {
      this.burst({ dur: 0.05, freq: 900, gain: 0.3 });
      this.tone(1400, 0.035, 0.07, 'square');
    }
  }
  armorBreak() {
    this.burst({ dur: 0.25, freq: 3500, type: 'bandpass', q: 3, gain: 0.5 });
    this.tone(700, 0.2, 0.15, 'triangle', 300);
  }
  kill() {
    this.tone(95, 0.3, 0.45, 'sine', 42, 0, 0, 'punch');
    this.burst({ dur: 0.12, freq: 600, gain: 0.25 });
    this.tone(880, 0.12, 0.16, 'triangle', undefined, 0.02);
    this.tone(1320, 0.22, 0.16, 'triangle', undefined, 0.1, 0, 'master', 0.3);
  }
  streak(n: number) {
    for (let i = 0; i < Math.min(n, 5); i++) this.tone(660 * Math.pow(1.26, i), 0.12, 0.16, 'triangle', undefined, 0.1 + i * 0.07);
  }
  hurt() {
    this.burst({ dur: 0.15, freq: 400, gain: 0.35 });
  }
  pickup() {
    this.tone(660, 0.08, 0.15, 'triangle');
    this.tone(990, 0.1, 0.12, 'triangle', undefined, 0.05);
  }
  /** Drawing a weapon: cloth rustle and a click. */
  swap() {
    this.burst({ dur: 0.16, freq: 1100, type: 'bandpass', q: 0.8, gain: 0.1, attack: 0.03 });
    this.burst({ dur: 0.03, freq: 2600, type: 'bandpass', q: 4, gain: 0.2, delay: 0.12 });
  }
  dry() {
    this.burst({ dur: 0.02, freq: 3600, type: 'bandpass', q: 6, gain: 0.3 });
    this.tone(1700, 0.025, 0.05, 'square', undefined, 0.01);
  }
  heal() {
    this.tone(520, 0.3, 0.15, 'sine', 780);
  }
  plate() {
    this.burst({ dur: 0.12, freq: 4200, type: 'bandpass', q: 5, gain: 0.35 });
    this.tone(400, 0.12, 0.12, 'triangle', 600);
  }
  slide() {
    this.burst({ dur: 0.45, freq: 900, type: 'bandpass', q: 0.6, gain: 0.18 });
  }
  jump() {
    this.burst({ dur: 0.08, freq: 500, gain: 0.12 });
  }
  land() {
    this.burst({ dur: 0.12, freq: 250, gain: 0.35 });
  }
  /** Leaping out of the bus: a big rush of air. */
  jumpOut() {
    this.sweep(1.1, 300, 1400, 0.5, 0.12, 0.6);
    this.sweep(0.5, 2500, 900, 0.12, 0.02, 1.5);
  }

  /**
   * Continuous air sounds: inside the bus you hear a warm engine hum, skydiving is a smooth
   * rush of wind that grows with speed, and the glider adds a soft canopy flutter.
   */
  setAir(mode: 'plane' | 'freefall' | 'glide' | null, speed = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.pink || !this.master) return;
    if (!this.air) {
      if (!mode) return;
      const drone = this.silentGain(), cabin = this.silentGain(), wind = this.silentGain();
      // Engine drone: two slightly detuned low saws, softened.
      const droneF = this.filter('lowpass', 240);
      droneF.connect(drone).connect(this.master);
      const droneOsc = [55, 55.6, 110.4].map((f, i) => {
        const o = ctx.createOscillator();
        o.type = i === 2 ? 'triangle' : 'sawtooth';
        o.frequency.value = f;
        o.connect(droneF);
        o.start();
        return o;
      });
      this.loop(this.pink, this.filter('lowpass', 420), cabin, this.master);
      // Wind: a gusty recorded-style loop (gusts baked in), darkened by a lowpass that opens with speed.
      const windF = this.filter('lowpass', 500, 0.5);
      this.loop(this.windBuffer(), windF, wind, this.master);
      this.air = { drone, cabin, wind, windF, droneOsc };
    }
    const a = this.air, t = ctx.currentTime, k = 0.35;
    const fall = Math.min(1, speed / 55);
    a.drone.gain.setTargetAtTime(mode === 'plane' ? 0.08 : 0, t, k);
    a.cabin.gain.setTargetAtTime(mode === 'plane' ? 0.2 : 0, t, k);
    // Quiet: air rushing past, well under the music.
    a.wind.gain.setTargetAtTime(mode === 'freefall' ? 0.05 + fall * 0.07 : mode === 'glide' ? 0.035 : 0, t, k);
    a.windF.frequency.setTargetAtTime(mode === 'freefall' ? 450 + fall * 900 : 380, t, k);
    // Under the glider: now and then the canopy ripples.
    if (mode === 'glide' && t > this.flapAt) {
      if (this.flapAt > 0) {
        this.sweep(0.35, 380, 180, 0.035, 0.08, 0.6);
        if (Math.random() < 0.5) this.sweep(0.25, 420, 200, 0.025, 0.05, 0.6, 0.18);
      }
      this.flapAt = t + 1.8 + Math.random() * 3;
    } else if (mode !== 'glide') this.flapAt = 0;
  }

  private windBuf: AudioBuffer | null = null;
  /** 8 s of soft brown noise with slow random gusts, looped seamlessly. */
  private windBuffer() {
    if (this.windBuf) return this.windBuf;
    const ctx = this.ctx!, sr = ctx.sampleRate, len = sr * 8;
    const buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    // Gust envelope: a few slow sines with whole-number cycles over the loop so it wraps cleanly.
    const g = [1, 2, 3, 5].map((c) => ({ c, ph: Math.random() * 6.28, a: 0.5 / c }));
    let br = 0;
    for (let i = 0; i < len; i++) {
      br = br * 0.995 + (Math.random() * 2 - 1) * 0.1;
      let env = 0.6;
      for (const s of g) env += Math.sin((i / len) * Math.PI * 2 * s.c + s.ph) * s.a * 0.5;
      d[i] = br * Math.max(0.15, env);
    }
    this.normalizeLoop(d, sr);
    return (this.windBuf = buf);
  }

  /** Scale to a steady level and crossfade the ends so the loop point can't be heard. */
  private normalizeLoop(d: Float32Array, sr: number) {
    let peak = 0;
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    const s = 0.9 / Math.max(1e-6, peak), xf = Math.floor(sr * 0.3), n = d.length;
    for (let i = 0; i < n; i++) d[i] *= s;
    for (let i = 0; i < xf; i++) {
      const k = i / xf;
      d[i] = d[i] * k + d[n - xf + i] * (1 - k);
    }
  }

  private rainBuf: AudioBuffer | null = null;
  /**
   * 6 s of stereo rain built from thousands of individual droplets (tiny damped pings, most soft,
   * a few close and loud) over a faint wash, rather than filtered static.
   */
  private rainBuffer() {
    if (this.rainBuf) return this.rainBuf;
    const ctx = this.ctx!, sr = ctx.sampleRate, len = sr * 6;
    const buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let a = 0, b = 0;
      const ka = 1 - Math.exp((-2 * Math.PI * 2200) / sr), kb = 1 - Math.exp((-2 * Math.PI * 350) / sr);
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        a += (w - a) * ka;
        b += (a - b) * kb;
        d[i] = (a - b) * 0.05;
      }
      const drops = 6 * 1100;
      for (let n = 0; n < drops; n++) {
        const at = Math.floor(Math.random() * len), r = Math.random();
        const amp = 0.015 + Math.pow(r, 6) * 0.35;
        const f = 1800 + Math.random() * 4200, tau = (0.0008 + Math.random() * 0.0025) * sr, w = (2 * Math.PI * f) / sr;
        const end = Math.min(len - at, Math.floor(tau * 5));
        for (let k = 0; k < end; k++) d[at + k] += amp * Math.sin(w * k) * Math.exp(-k / tau);
      }
      // A few nearby "plip"s: a drop hitting a puddle, pitch rising.
      for (let n = 0; n < 14; n++) {
        const at = Math.floor(Math.random() * (len - sr * 0.05)), f0 = 900 + Math.random() * 700, dur = sr * 0.035;
        let ph = 0;
        for (let k = 0; k < dur; k++) {
          ph += (2 * Math.PI * f0 * (1 + (k / dur) * 1.2)) / sr;
          d[at + k] += 0.08 * Math.sin(ph) * Math.exp(-k / (dur * 0.3));
        }
      }
      this.normalizeLoop(d, sr);
    }
    return (this.rainBuf = buf);
  }
  zoneWarning() {
    this.tone(330, 0.35, 0.2, 'sawtooth', 220);
  }
  click() {
    this.tone(1200, 0.04, 0.08, 'square');
  }

  // --- movement ---
  footstep(at: Vector3 | undefined, dist: number, loud: number, water = false) {
    if (dist > 45) return;
    const { att, pan } = this.spatial(at, dist, 8);
    if (water) {
      this.burst({ dur: 0.18, freq: 1400, type: 'bandpass', q: 0.7, gain: 0.22 * att * loud, pan });
      return;
    }
    this.burst({ dur: 0.07, freq: 380 + Math.random() * 180, gain: 0.3 * att * loud, pan });
    this.burst({ dur: 0.04, freq: 2600, type: 'bandpass', q: 1.5, gain: 0.05 * att * loud, pan });
  }
  launch() {
    this.tone(180, 0.6, 0.3, 'sawtooth', 900);
    this.burst({ dur: 0.8, freq: 1200, type: 'bandpass', q: 0.5, gain: 0.35, attack: 0.05 });
  }
  /** Glider pops open: fabric snap, a whoomp of air catching, then a soft settle. */
  glider() {
    this.burst({ dur: 0.05, freq: 1800, type: 'bandpass', q: 1.5, gain: 0.16 });
    this.burst({ dur: 0.06, freq: 1400, type: 'bandpass', q: 1.5, gain: 0.12, delay: 0.07 });
    this.sweep(0.6, 900, 220, 0.22, 0.03, 0.6);
    this.tone(90, 0.3, 0.22, 'sine', 50, 0.02);
  }
  whiz(pan: number) {
    this.tone(2400 + Math.random() * 800, 0.12, 0.12, 'sine', 900, 0, pan);
    this.burst({ dur: 0.1, freq: 5000, type: 'highpass', gain: 0.1, pan });
  }

  // --- world ---
  explosion(at: Vector3) {
    const dist = this.distTo(at);
    if (dist > 700) return;
    const { att, pan } = this.spatial(at, dist, 60);
    const delay = Math.min(1.2, dist / 343), near = dist < 80;
    if (near) this.burst({ dur: 0.04, freq: 3000, type: 'highpass', gain: 0.6 * att, pan, delay, bus: 'punch' });
    this.burst({ dur: 1.6, freq: near ? 260 : 140, sweepTo: 70, gain: 1.1 * att, pan, delay, bus: 'punch', verb: 0.5 });
    this.tone(62, 1.1, 0.7 * att, 'sine', 26, delay, pan, 'punch');
    if (near) this.burst({ dur: 0.5, freq: 1400, gain: 0.45 * att, pan, delay });
    // Rolling rumble off the hills, then debris pattering down.
    this.burst({ dur: 2.6, freq: 320, sweepTo: 90, type: 'bandpass', q: 0.5, gain: 0.35 * att, pan, delay: delay + 0.15, attack: 0.2, verb: 0.6 });
    if (near) for (let i = 0; i < 6; i++) this.burst({ dur: 0.04, freq: 1800 + Math.random() * 2500, type: 'bandpass', q: 3, gain: 0.08 * att, pan: pan + (Math.random() - 0.5) * 0.6, delay: delay + 0.5 + Math.random() * 0.9 });
  }
  crash(intensity: number) {
    this.burst({ dur: 0.3, freq: 600, gain: Math.min(0.8, 0.2 + intensity * 0.04) });
    this.burst({ dur: 0.2, freq: 3000, type: 'bandpass', q: 2, gain: Math.min(0.4, intensity * 0.02) });
  }
  carDoor() {
    this.burst({ dur: 0.1, freq: 700, gain: 0.35 });
    this.burst({ dur: 0.05, freq: 2200, type: 'bandpass', q: 3, gain: 0.15, delay: 0.05 });
  }
  chestOpen() {
    [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.25, 0.13, 'triangle', undefined, i * 0.05));
    this.burst({ dur: 0.3, freq: 6000, type: 'highpass', gain: 0.12 });
  }
  /** The shimmer you hear near an unopened chest. */
  chestHum(at: Vector3) {
    const dist = this.distTo(at);
    if (dist > 14) return;
    const { att, pan } = this.spatial(at, dist, 4);
    const f = [1568, 1760, 2093, 2349][Math.floor(Math.random() * 4)];
    this.tone(f, 0.35, 0.05 * att, 'sine', undefined, 0, pan);
  }
  supplyIncoming() {
    this.tone(880, 0.15, 0.2, 'square');
    this.tone(880, 0.15, 0.2, 'square', undefined, 0.25);
    this.tone(1175, 0.3, 0.2, 'square', undefined, 0.5);
  }
  thud(at: Vector3) {
    const dist = this.distTo(at);
    const { att, pan } = this.spatial(at, dist, 40);
    this.burst({ dur: 0.4, freq: 150, gain: 0.8 * att, pan });
  }
  campfire(at: Vector3) {
    const dist = this.distTo(at);
    if (dist > 20 || Math.random() > 0.3) return;
    const { att, pan } = this.spatial(at, dist, 5);
    this.burst({ dur: 0.03, freq: 3000 + Math.random() * 2000, type: 'bandpass', q: 3, gain: 0.12 * att, pan, bus: 'ambient' });
  }
  bird() {
    const base = 2600 + Math.random() * 1400, pan = Math.random() * 1.6 - 0.8;
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) this.tone(base, 0.09, 0.05, 'sine', base * 1.35, i * 0.13, pan, 'ambient');
  }
  victory() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.5, 0.18, 'triangle', undefined, i * 0.14));
    this.tone(1047, 1.2, 0.18, 'triangle', undefined, 0.6);
  }
  defeat() {
    [392, 330, 262].forEach((f, i) => this.tone(f, 0.5, 0.16, 'triangle', undefined, i * 0.22));
  }

  // --- new gear ---
  glass(at: Vector3) {
    const dist = this.distTo(at);
    if (dist > 60) return;
    const { att, pan } = this.spatial(at, dist, 12);
    this.burst({ dur: 0.35, freq: 5200, type: 'highpass', gain: 0.35 * att, pan });
    for (let i = 0; i < 4; i++) this.tone(3000 + Math.random() * 3000, 0.12, 0.05 * att, 'sine', undefined, 0.03 + i * 0.05, pan);
  }
  woodBreak(at: Vector3) {
    const dist = this.distTo(at);
    if (dist > 60) return;
    const { att, pan } = this.spatial(at, dist, 14);
    this.burst({ dur: 0.25, freq: 900, type: 'bandpass', q: 1.2, gain: 0.5 * att, pan });
    this.burst({ dur: 0.12, freq: 300, gain: 0.4 * att, pan, delay: 0.04 });
  }
  door(at: Vector3, open: boolean) {
    const dist = this.distTo(at);
    if (dist > 30) return;
    const { att, pan } = this.spatial(at, dist, 6);
    this.burst({ dur: 0.18, freq: open ? 500 : 350, type: 'bandpass', q: 2, gain: 0.25 * att, pan });
    if (!open) this.burst({ dur: 0.08, freq: 180, gain: 0.35 * att, pan, delay: 0.16 });
  }
  bounce(at: Vector3) {
    const dist = this.distTo(at);
    if (dist > 40) return;
    const { att, pan } = this.spatial(at, dist, 8);
    this.tone(1400 + Math.random() * 400, 0.05, 0.12 * att, 'triangle', undefined, 0, pan);
  }
  pin() {
    this.burst({ dur: 0.04, freq: 4000, type: 'bandpass', q: 5, gain: 0.25 });
    this.tone(2200, 0.06, 0.08, 'square', undefined, 0.05);
  }
  throwWhoosh() {
    this.burst({ dur: 0.25, freq: 900, type: 'bandpass', q: 0.7, gain: 0.2, attack: 0.03 });
  }
  flashbang(at: Vector3) {
    this.explosion(at);
    const dist = this.distTo(at);
    this.burst({ dur: 0.2, freq: 6000, type: 'highpass', gain: 0.8 / (1 + dist / 20) });
  }
  /** High-pitched ringing after being flashed. */
  tinnitus(strength: number) {
    this.tone(3400, 2.5 * strength, 0.12 * strength, 'sine');
  }
  smokePop(at: Vector3) {
    const dist = this.distTo(at);
    const { att, pan } = this.spatial(at, dist, 15);
    this.burst({ dur: 1.4, freq: 1500, type: 'bandpass', q: 0.4, gain: 0.35 * att, pan, attack: 0.1 });
  }
  splash(big: boolean) {
    this.burst({ dur: big ? 0.6 : 0.25, freq: 1100, type: 'bandpass', q: 0.6, gain: big ? 0.45 : 0.2 });
    this.burst({ dur: 0.3, freq: 300, gain: big ? 0.3 : 0.1 });
  }
  swimStroke() {
    this.burst({ dur: 0.3, freq: 900, type: 'bandpass', q: 0.8, gain: 0.12 });
  }
  mantle() {
    this.burst({ dur: 0.12, freq: 700, gain: 0.2 });
    this.burst({ dur: 0.06, freq: 2200, type: 'bandpass', q: 2, gain: 0.08, delay: 0.1 });
  }
  zipAttach() {
    this.burst({ dur: 0.08, freq: 3200, type: 'bandpass', q: 4, gain: 0.3 });
    this.tone(900, 0.1, 0.1, 'square');
  }
  /** A crack followed by a long rolling rumble. */
  thunder() {
    const ctx = this.ctx;
    if (!ctx || !this.pink || !this.ambient) return;
    const t = ctx.currentTime, dur = 3.5 + Math.random() * 2;
    this.burst({ dur: 0.4, freq: 2200, gain: 0.25, bus: 'ambient' });
    const src = ctx.createBufferSource();
    src.buffer = this.pink;
    const f = this.filter('lowpass', 900);
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(90, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1.6, t + 0.08);
    // Rolling: a few swells on the way down.
    for (let i = 1; i <= 3; i++) g.gain.exponentialRampToValueAtTime(0.5 + Math.random() * 0.9, t + (dur * i) / 5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.ambient);
    src.start(t, Math.random() * 3);
    src.stop(t + dur + 0.1);
  }
  levelUp() {
    [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => this.tone(f, 0.3, 0.14, 'triangle', undefined, i * 0.07));
  }
  gulagBell() {
    this.tone(196, 1.8, 0.25, 'triangle');
    this.tone(392, 1.4, 0.1, 'sine', undefined, 0.02);
  }
  countdown(go: boolean) {
    this.tone(go ? 1320 : 880, go ? 0.45 : 0.15, 0.2, 'square');
    if (go) this.tone(660, 0.45, 0.12, 'square');
  }
  xpTick() {
    this.tone(1800 + Math.random() * 400, 0.04, 0.05, 'square');
  }

  // --- loops ---
  /** Rain loop, 0 = off, 1 = downpour. */
  setRain(intensity: number) {
    const ctx = this.ctx;
    this.rainLevel = intensity;
    if (!ctx || !this.ambient) return;
    if (!this.rain) {
      if (intensity <= 0) return;
      const gain = this.silentGain(), tone = this.filter('lowpass', 9000, 0.5);
      this.loop(this.rainBuffer(), tone, gain, this.ambient);
      this.rain = { gain, tone };
    }
    this.rain.gain.gain.setTargetAtTime(intensity * 0.14, ctx.currentTime, 0.8);
  }

  /** Individual drops pattering around you and the odd heavier drip. Call every frame while it rains. */
  rainTick(dt: number, sheltered: boolean) {
    if (!this.ctx || !this.rain || this.rainLevel <= 0) return;
    // Under a roof the rain is muffled, with soft taps on the roof above.
    this.rain.tone.frequency.setTargetAtTime(sheltered ? 1100 : 9000, this.ctx.currentTime, 0.25);
    if (!sheltered) return;
    this.roofT -= dt;
    if (this.roofT <= 0) {
      this.roofT = 0.05 + Math.random() * 0.18;
      this.burst({ dur: 0.04, freq: 500 + Math.random() * 500, type: 'bandpass', q: 2, gain: 0.02 + Math.random() * 0.02, pan: Math.random() * 1.4 - 0.7, bus: 'ambient' });
    }
  }

  /** Zipline whine; speed in m/s, or null to stop. */
  setZip(speed: number | null) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    if (!this.zip) {
      if (speed === null) return;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1800;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(f).connect(gain).connect(this.master);
      osc.start();
      this.zip = { gain, osc };
    }
    const t = ctx.currentTime;
    this.zip.gain.gain.setTargetAtTime(speed === null ? 0 : 0.05, t, 0.08);
    if (speed !== null) this.zip.osc.frequency.setTargetAtTime(300 + speed * 22, t, 0.1);
  }
  /** Engine loop: pass throttle speed (m/s) or null to stop. */
  setEngine(speed: number | null, throttle = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    if (speed === null) {
      if (this.engine) this.engine.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
      return;
    }
    if (!this.engine) {
      // Exhaust note: firing pulses have strong low harmonics that fall off quickly.
      const real = new Float32Array(16), imag = new Float32Array(16);
      const amps = [0, 1, 0.75, 0.5, 0.42, 0.25, 0.2, 0.12, 0.1, 0.06, 0.05, 0.03, 0.03, 0.02, 0.015, 0.01];
      amps.forEach((a, i) => (imag[i] = a * (i % 2 ? 1 : 0.8)));
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(ctx.createPeriodicWave(real, imag));
      const sub = ctx.createOscillator(); // crankshaft rumble, half the firing rate
      sub.type = 'sine';
      const subGain = ctx.createGain();
      subGain.gain.value = 0.55;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 0.8;
      filter.frequency.value = 400;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(filter);
      sub.connect(subGain).connect(filter);
      filter.connect(gain).connect(this.master);
      // Intake / road hiss: soft band of pink noise that opens up with throttle and speed.
      const src = ctx.createBufferSource();
      src.buffer = this.pink ?? this.noise;
      src.loop = true;
      const air = ctx.createBiquadFilter();
      air.type = 'bandpass';
      air.Q.value = 0.9;
      air.frequency.value = 300;
      const airGain = ctx.createGain();
      airGain.gain.value = 0;
      if (src.buffer) src.connect(air).connect(airGain).connect(gain);
      osc.start();
      sub.start();
      if (src.buffer) src.start();
      this.engine = { osc, sub, filter, gain, air, airGain, rpm: 900 };
    }
    const e = this.engine, t = ctx.currentTime;
    // Five gears: revs climb through each gear, then drop on the shift.
    const v = Math.abs(speed), tops = [7, 14, 22, 31, 42];
    let g = 0;
    while (g < tops.length - 1 && v > tops[g]) g++;
    const lo = g ? tops[g - 1] : 0, frac = Math.min(1, (v - lo) / (tops[g] - lo));
    const target = v < 0.5 && throttle < 0.1 ? 850 : 1500 + frac * 3600 * (g ? 1 : 0.9) + throttle * 500;
    e.rpm += (target - e.rpm) * 0.12;
    const rpm = e.rpm * (1 + (Math.random() - 0.5) * 0.012); // slight unevenness
    const fire = (rpm / 60) * 2; // 4 cylinders, 4-stroke
    e.osc.frequency.setTargetAtTime(fire, t, 0.04);
    e.sub.frequency.setTargetAtTime(fire * 0.5, t, 0.04);
    e.filter.frequency.setTargetAtTime(fire * (3 + throttle * 4), t, 0.06);
    e.air.frequency.setTargetAtTime(250 + fire * 3, t, 0.08);
    e.airGain.gain.setTargetAtTime(0.25 + throttle * 0.6 + Math.min(v, 40) * 0.01, t, 0.1);
    e.gain.gain.setTargetAtTime(0.07 + throttle * 0.05, t, 0.08);
  }

  /** Storm rumble, 0 = silent, 1 = inside the storm. */
  setStorm(intensity: number) {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.ambient) return;
    if (!this.storm) {
      const src = ctx.createBufferSource();
      src.buffer = this.pink ?? this.noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 220;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.ambient);
      src.start();
      this.storm = { gain, filter };
    }
    const t = ctx.currentTime;
    this.storm.gain.gain.setTargetAtTime(intensity * 0.9, t, 0.3);
    this.storm.filter.frequency.setTargetAtTime(160 + intensity * 400, t, 0.3);
  }
}

/**
 * Per gun: body filter frequency, body length, sub-thump pitch, environment tail length, how sharp
 * the transient snap is, and overall level.
 */
const GUN: Record<WeaponId, { freq: number; body: number; thump: number; tail: number; snap: number; gain: number }> = {
  pistol: { freq: 2600, body: 0.09, thump: 150, tail: 0.45, snap: 1.0, gain: 0.5 },
  smg: { freq: 2900, body: 0.075, thump: 140, tail: 0.4, snap: 0.9, gain: 0.42 },
  burst: { freq: 2300, body: 0.09, thump: 125, tail: 0.5, snap: 1.0, gain: 0.46 },
  ar: { freq: 2000, body: 0.11, thump: 115, tail: 0.6, snap: 1.1, gain: 0.55 },
  lmg: { freq: 1700, body: 0.12, thump: 105, tail: 0.65, snap: 1.0, gain: 0.58 },
  revolver: { freq: 1400, body: 0.17, thump: 95, tail: 0.85, snap: 1.3, gain: 0.72 },
  shotgun: { freq: 1100, body: 0.22, thump: 80, tail: 0.9, snap: 1.2, gain: 0.8 },
  dmr: { freq: 1500, body: 0.16, thump: 95, tail: 1.0, snap: 1.3, gain: 0.7 },
  sniper: { freq: 1000, body: 0.26, thump: 70, tail: 1.5, snap: 1.5, gain: 0.85 },
  rocket: { freq: 500, body: 0.4, thump: 60, tail: 1.2, snap: 0.6, gain: 0.8 },
};
