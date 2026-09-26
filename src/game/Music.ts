/**
 * Procedural background music: a small step sequencer driving synthesized drums, bass, pads and leads.
 * Each song is a loop in 16th-note steps; switching songs crossfades on the next beat.
 */

export type SongName = 'lobby' | 'drop' | 'match' | 'final';

const midi = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** Instruments, all rendered into one destination node. */
class Synth {
  constructor(private ctx: AudioContext, private out: AudioNode, private noise: AudioBuffer) {}

  private env(t: number, peak: number, attack: number, decay: number) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }

  private osc(type: OscillatorType, freq: number, t: number, stop: number, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.detune.value = detune;
    o.start(t);
    o.stop(stop);
    return o;
  }

  private noiseSrc(t: number, dur: number) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.05);
    return s;
  }

  kick(t: number, g = 1) {
    const o = this.osc('sine', 150, t, t + 0.4);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    o.connect(this.env(t, 0.9 * g, 0.003, 0.32)).connect(this.out);
    // Click for punch.
    const c = this.noiseSrc(t, 0.02), f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 3000;
    c.connect(f).connect(this.env(t, 0.25 * g, 0.001, 0.015)).connect(this.out);
  }

  clap(t: number, g = 1) {
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1400;
    f.Q.value = 0.9;
    f.connect(this.out);
    // A clap is a few tight bursts then a short tail.
    for (const [dt, dec] of [[0, 0.02], [0.012, 0.02], [0.024, 0.16]] as const) {
      this.noiseSrc(t + dt, dec + 0.02).connect(this.env(t + dt, 0.45 * g, 0.001, dec)).connect(f);
    }
    this.osc('triangle', 190, t, t + 0.1).connect(this.env(t, 0.12 * g, 0.002, 0.07)).connect(this.out);
  }

  hat(t: number, g = 1, open = false) {
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7500;
    const dur = open ? 0.22 : 0.04;
    this.noiseSrc(t, dur).connect(f).connect(this.env(t, 0.16 * g, 0.001, dur)).connect(this.out);
  }

  shaker(t: number, g = 1) {
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 6000;
    f.Q.value = 1.2;
    this.noiseSrc(t, 0.07).connect(f).connect(this.env(t, 0.08 * g, 0.02, 0.05)).connect(this.out);
  }

  bass(t: number, note: number, len: number, g = 1, bright = 1) {
    const stop = t + len + 0.1;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 4;
    f.frequency.setValueAtTime(180, t);
    f.frequency.exponentialRampToValueAtTime(500 + 900 * bright, t + 0.02);
    f.frequency.exponentialRampToValueAtTime(220, t + Math.min(len, 0.25));
    const amp = this.ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(0.32 * g, t + 0.008);
    amp.gain.setValueAtTime(0.32 * g, t + len * 0.8);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + len);
    this.osc('sawtooth', midi(note), t, stop).connect(f);
    this.osc('sine', midi(note - 12), t, stop).connect(amp);
    f.connect(amp).connect(this.out);
  }

  pad(t: number, notes: number[], len: number, g = 1, cutoff = 1400) {
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const amp = this.ctx.createGain();
    const a = Math.min(0.4, len * 0.3);
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(0.05 * g, t + a);
    amp.gain.setValueAtTime(0.05 * g, t + len - 0.1);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.3);
    f.connect(amp).connect(this.out);
    for (const n of notes) {
      for (const d of [-9, 9]) this.osc('sawtooth', midi(n), t, t + len + 0.4, d).connect(f);
    }
  }

  pluck(t: number, note: number, g = 1, decay = 0.25, type: OscillatorType = 'square') {
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(4000, t);
    f.frequency.exponentialRampToValueAtTime(600, t + decay);
    this.osc(type, midi(note), t, t + decay + 0.05).connect(f).connect(this.env(t, 0.1 * g, 0.003, decay)).connect(this.out);
  }

  lead(t: number, note: number, len: number, g = 1) {
    const stop = t + len + 0.15;
    const vib = this.osc('sine', 5.5, t, stop), depth = this.ctx.createGain();
    depth.gain.value = 9;
    vib.connect(depth);
    const amp = this.ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(0.09 * g, t + 0.015);
    amp.gain.setValueAtTime(0.08 * g, t + Math.max(0.03, len - 0.05));
    amp.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.12);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 3200;
    for (const [type, det] of [['square', -6], ['sawtooth', 6]] as const) {
      const o = this.osc(type, midi(note), t, stop, det);
      depth.connect(o.detune);
      o.connect(f);
    }
    f.connect(amp).connect(this.out);
  }

  /** Noise rising into the downbeat. */
  riser(t: number, len: number, g = 1) {
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.5;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(6000, t + len);
    const amp = this.ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(0.14 * g, t + len);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.05);
    this.noiseSrc(t, len + 0.1).connect(f).connect(amp).connect(this.out);
  }
}

interface Song {
  bpm: number;
  gain: number;
  swing?: number;
  /** `step` counts 16ths since the song started. */
  play(s: Synth, step: number, t: number, sixteenth: number): void;
}

type Note = [step: number, note: number, len: number];

const at = <T,>(xs: T[], i: number) => xs[((i % xs.length) + xs.length) % xs.length];

// ---- Lobby: bright, bouncy, C major ----
const LOBBY_CHORDS = [[60, 64, 67], [59, 62, 67], [57, 60, 64], [57, 60, 65]];
const LOBBY_ROOTS = [36, 43, 45, 41];
const LOBBY_MELODY: Note[] = [
  [0, 72, 2], [2, 74, 2], [4, 76, 4], [10, 79, 2], [12, 76, 4],
  [16, 74, 2], [18, 76, 2], [20, 74, 4], [26, 71, 2], [28, 74, 4],
  [32, 72, 2], [34, 74, 2], [36, 76, 4], [42, 72, 2], [44, 69, 4],
  [48, 72, 4], [54, 74, 2], [56, 72, 8],
];
const lobby: Song = {
  bpm: 104, gain: 0.9, swing: 0.1,
  play(s, step, t, d) {
    const bar = Math.floor(step / 16), i = step % 16, ch = at(LOBBY_CHORDS, bar), root = at(LOBBY_ROOTS, bar);
    const section = Math.floor(bar / 4) % 4; // 0 intro, 1 groove, 2 melody, 3 melody + arp
    if (i === 0) s.pad(t, ch, d * 16, section === 0 ? 0.8 : 1, section === 0 ? 900 : 1500);
    if (section > 0) {
      if (i === 0 || i === 8 || i === 11) s.kick(t, i === 11 ? 0.6 : 1);
      if (i === 4 || i === 12) s.clap(t, 0.8);
    }
    if (i % 2 === 0) s.hat(t, i % 4 === 2 ? 0.8 : 0.45);
    if (section > 0 && (i === 0 || i === 3 || i === 6 || i === 8 || i === 11 || i === 14)) {
      s.bass(t, i === 6 || i === 14 ? root + 7 : i === 8 ? root + 12 : root, d * 2, 0.9, 0.6);
    }
    if (section !== 2 && i % 2 === 0) s.pluck(t, ch[[0, 1, 2, 1][(i / 2) % 4]] + 12, section === 0 ? 0.6 : 0.8, 0.2, 'triangle');
    if (section >= 2) for (const [st, n, len] of LOBBY_MELODY) if (st === step % 64) s.lead(t, n, len * d, 0.85);
    if (bar % 16 === 15 && i === 8) s.riser(t, d * 8, 0.7);
  },
};

// ---- Drop: energetic dance track, A minor ----
const DROP_CHORDS = [[57, 60, 64], [57, 60, 65], [55, 60, 64], [55, 59, 62]];
const DROP_ROOTS = [45, 41, 48, 43];
const DROP_HOOK: Note[] = [
  [0, 76, 3], [3, 76, 3], [6, 79, 2], [8, 76, 2], [10, 74, 2], [12, 72, 4],
  [16, 72, 3], [19, 74, 3], [22, 76, 2], [24, 74, 4], [28, 71, 4],
  [32, 76, 3], [35, 76, 3], [38, 79, 2], [40, 76, 2], [42, 74, 2], [44, 72, 4],
  [48, 72, 3], [51, 74, 3], [54, 76, 2], [56, 79, 4], [60, 81, 4],
];
const drop: Song = {
  bpm: 126, gain: 0.95,
  play(s, step, t, d) {
    const bar = Math.floor(step / 16), i = step % 16, ch = at(DROP_CHORDS, bar), root = at(DROP_ROOTS, bar);
    const intro = bar < 2;
    if (i === 0) s.pad(t, ch, d * 16, 0.9, intro ? 700 : 2000);
    if (intro) {
      if (bar === 1 && i === 0) s.riser(t, d * 16, 1);
      if (i % 2 === 0) s.hat(t, 0.4);
      if (i % 4 === 0) s.pluck(t, ch[i / 4 % 3] + 12, 0.7);
      return;
    }
    if (i % 4 === 0) s.kick(t);
    if (i === 4 || i === 12) s.clap(t);
    s.hat(t, i % 4 === 2 ? 0.9 : 0.3, i % 4 === 2);
    if (i % 2 === 0) s.bass(t, i % 4 === 2 ? root + 12 : root, d * 1.6, 0.9, 1);
    if (i === 0 || i === 3 || i === 6 || i === 10) for (const n of ch) s.pluck(t, n + 12, 0.55, 0.18, 'sawtooth');
    if (bar % 8 >= 4) for (const [st, n, len] of DROP_HOOK) if (st === step % 64) s.lead(t, n, len * d, 1);
    if (bar % 8 === 7 && i === 0) s.riser(t, d * 16, 0.8);
  },
};

// ---- Match: laid-back groove that sits under the gunfire, D minor ----
const MATCH_CHORDS = [[50, 53, 57], [50, 53, 58], [48, 53, 57], [48, 52, 55]];
const MATCH_ROOTS = [38, 34, 41, 36];
const match: Song = {
  bpm: 84, gain: 0.3, swing: 0.14,
  play(s, step, t, d) {
    const bar = Math.floor(step / 16), i = step % 16, ch = at(MATCH_CHORDS, bar), root = at(MATCH_ROOTS, bar);
    const breakdown = bar % 16 >= 12;
    if (i === 0) s.pad(t, ch, d * 16, 0.8, 800);
    if (!breakdown) {
      if (i === 0) s.kick(t, 0.45);
      if (i === 0 || i === 10) s.bass(t, root, d * (i === 0 ? 6 : 4), 0.6, 0.25);
    }
    if (i % 4 === 2) s.hat(t, 0.18);
    if (i % 8 === 7) s.shaker(t, 0.5);
    if (bar % 4 === 2 && (i === 2 || i === 6 || i === 14)) s.pluck(t, ch[(i >> 2) % 3] + 12, 0.7, 0.4, 'triangle');
  },
};

// ---- Final circles: driving and tense, E minor ----
const FINAL_CHORDS = [[52, 55, 59], [52, 55, 59], [52, 55, 60], [51, 54, 59]];
const FINAL_ROOTS = [40, 40, 36, 35];
const final: Song = {
  bpm: 132, gain: 0.7,
  play(s, step, t, d) {
    const bar = Math.floor(step / 16), i = step % 16, ch = at(FINAL_CHORDS, bar), root = at(FINAL_ROOTS, bar);
    if (i === 0) s.pad(t, ch, d * 16, 0.8, 900);
    if (i % 4 === 0) s.kick(t, 0.9);
    if (i === 4 || i === 12) s.clap(t, 0.7);
    s.hat(t, i % 2 === 0 ? 0.35 : 0.2);
    s.bass(t, i % 4 === 2 ? root + 12 : root, d * 0.9, 0.7, 0.5 + (bar % 4) * 0.2);
    if (bar % 2 === 1) s.pluck(t, ch[i % 3] + 12 + (i >= 8 ? 12 : 0), 0.45, 0.12, 'sawtooth');
    if (bar % 8 === 7 && i === 0) s.riser(t, d * 16, 0.7);
  },
};

const SONGS: Record<SongName, Song> = { lobby, drop, match, final };

interface Playing {
  name: SongName;
  song: Song;
  gain: GainNode;
  synth: Synth;
  step: number;
  next: number;
  stopAt: number;
}

export class Music {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private duckGain: GainNode | null = null;
  private muffle: BiquadFilterNode | null = null;
  private noise: AudioBuffer | null = null;
  private cur: Playing | null = null;
  private fading: Playing[] = [];
  private duckLevel = 1;
  volume = 0.5;

  /** Hook up to the shared AudioContext once the browser allows sound. */
  attach(ctx: AudioContext) {
    if (this.ctx) return;
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = this.volume * 1.1;
    this.duckGain = ctx.createGain();
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3;
    this.duckGain.connect(this.muffle).connect(comp).connect(this.bus).connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.bus && this.ctx) this.bus.gain.setTargetAtTime(v * 1.1, this.ctx.currentTime, 0.05);
  }

  get playing() {
    return this.cur?.name ?? null;
  }

  /** Switch songs (null = silence). The old song fades out, the new one fades in on the next beat. */
  play(name: SongName | null, fade = 1.5) {
    if (!this.ctx || !this.duckGain || !this.noise || this.cur?.name === name) return;
    const now = this.ctx.currentTime;
    if (this.cur) {
      const c = this.cur;
      c.gain.gain.cancelScheduledValues(now);
      c.gain.gain.setValueAtTime(c.gain.gain.value, now);
      c.gain.gain.linearRampToValueAtTime(0, now + fade);
      c.stopAt = now + fade;
      this.fading.push(c);
      this.cur = null;
    }
    if (!name) return;
    const song = SONGS[name];
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(song.gain, now + Math.max(0.3, fade * 0.6));
    gain.connect(this.duckGain);
    this.cur = { name, song, gain, synth: new Synth(this.ctx, gain, this.noise), step: 0, next: now + 0.15, stopAt: Infinity };
  }

  /** Lower the music for a moment (gunfire), recovering over a few seconds. */
  duck(amount = 0.45) {
    this.duckLevel = Math.min(this.duckLevel, amount);
  }

  /** Muffled music while paused. */
  setMuffled(on: boolean) {
    if (this.muffle && this.ctx) this.muffle.frequency.setTargetAtTime(on ? 700 : 20000, this.ctx.currentTime, 0.15);
  }

  update(dt: number) {
    const ctx = this.ctx;
    if (!ctx || !this.duckGain) return;
    this.duckLevel = Math.min(1, this.duckLevel + dt * 0.18);
    this.duckGain.gain.setTargetAtTime(this.duckLevel, ctx.currentTime, 0.15);
    const now = ctx.currentTime;
    this.fading = this.fading.filter((p) => {
      if (now < p.stopAt) {
        this.schedule(p, now);
        return true;
      }
      p.gain.disconnect();
      return false;
    });
    if (this.cur) this.schedule(this.cur, now);
  }

  private schedule(p: Playing, now: number) {
    const d = 60 / p.song.bpm / 4;
    // After a stall (hidden tab) skip ahead rather than play a burst of catch-up notes.
    if (p.next < now - 0.05) p.next = now + 0.05;
    while (p.next < now + 0.2 && p.next < p.stopAt) {
      const swing = p.step % 2 === 1 ? (p.song.swing ?? 0) * d : 0;
      p.song.play(p.synth, p.step, p.next + swing, d);
      p.step++;
      p.next += d;
    }
  }
}
