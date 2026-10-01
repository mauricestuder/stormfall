import { randomTip, TIPS } from './tips';

export interface LoadShot {
  /** A rendered JPEG of a town. */
  url: string;
  name: string;
  /** Where it is on the map (0..1). */
  u: number;
  v: number;
}

export interface LoadInfo {
  mode: string;
  sub: string;
  /** The island map (it already has the town names on it), shown as a minimap. */
  map?: HTMLCanvasElement;
  /** Shots of the island's towns, cycled behind everything. */
  shots?: LoadShot[];
}

const STAGES = ['Building the island', 'Hiding the loot', 'Spawning players', 'Warming up the engines', 'Boarding the plane'];
const SHOT_MS = 2100;

/**
 * Full-screen loading card between the lobby and a match: slow-panning shots of the island's towns
 * crossfading behind the mode, a minimap marking the town on screen, a tip and a progress bar.
 * Heavy match setup runs while it's up, so the hitch hides behind it.
 */
export class LoadScreen {
  private el: HTMLDivElement;
  private bar: HTMLElement;
  private label: HTMLElement;
  private tip: HTMLElement;
  private cv: HTMLCanvasElement;
  private layers: HTMLDivElement[];
  private place: HTMLElement;
  private brief: HTMLElement;
  private pin: HTMLElement;
  private shots: LoadShot[] = [];
  private shotIx = -1;
  private front = 0;
  busy = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'loadscreen';
    this.el.innerHTML = `<div class="ls-shot"></div><div class="ls-shot"></div><canvas class="ls-map" width="1600" height="1600"></canvas><div class="ls-shade"></div>
      <div class="ls-top"><h1>STORM<span>FALL</span></h1></div>
      <div class="ls-mini"><canvas width="1024" height="1024"></canvas><i class="ls-pin"></i><b>N</b></div>
      <div class="ls-place"><h2></h2><pre></pre></div>
      <div class="ls-card"><small>NOW LOADING</small><b class="ls-mode"></b><span class="ls-sub"></span></div>
      <div class="ls-foot"><div class="ls-tip"><b>TIP</b><span></span></div>
      <div class="ls-bar"><i></i></div><div class="ls-label"></div></div>`;
    document.body.appendChild(this.el);
    this.bar = this.el.querySelector('.ls-bar i')!;
    this.label = this.el.querySelector('.ls-label')!;
    this.tip = this.el.querySelector('.ls-tip span')!;
    this.cv = this.el.querySelector('.ls-mini canvas')!;
    this.layers = [...this.el.querySelectorAll<HTMLDivElement>('.ls-shot')];
    this.place = this.el.querySelector('.ls-place h2')!;
    this.brief = this.el.querySelector('.ls-place pre')!;
    this.pin = this.el.querySelector('.ls-pin')!;
  }

  private drawMap(info: LoadInfo) {
    for (const cv of [this.cv, this.el.querySelector<HTMLCanvasElement>('.ls-map')!]) {
      const ctx = cv.getContext('2d')!, N = cv.width;
      ctx.fillStyle = '#123049';
      ctx.fillRect(0, 0, N, N);
      if (info.map) {
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(info.map, 0, 0, N, N);
      }
    }
  }

  /** Next town: crossfade to its shot, move the minimap pin, type out its briefing. */
  private nextShot() {
    if (!this.shots.length) return;
    this.shotIx = (this.shotIx + 1) % this.shots.length;
    const s = this.shots[this.shotIx];
    this.front ^= 1;
    const on = this.layers[this.front], off = this.layers[this.front ^ 1];
    on.style.backgroundImage = `url(${s.url})`;
    on.classList.remove('on');
    void on.offsetWidth; // restart the pan
    on.style.setProperty('--dx', `${(Math.random() - 0.5) * 4}%`);
    on.classList.add('on');
    off.classList.remove('on');
    this.pin.style.left = `${s.u * 100}%`;
    this.pin.style.top = `${s.v * 100}%`;
    this.place.textContent = s.name.toUpperCase();
    const d = new Date(), hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    const lines = [`Recon ${this.shotIx + 1}/${this.shots.length} – ${hh}:${mm} local`, `Grid ${String.fromCharCode(65 + Math.floor(s.u * 8))}${1 + Math.floor(s.v * 8)}`, `Stormzone Island · ${s.name}`];
    const text = lines.join('\n');
    let n = 0;
    const type = () => {
      if (this.shots[this.shotIx] !== s) return;
      n = Math.min(text.length, n + 2);
      this.brief.textContent = text.slice(0, n);
      if (n < text.length) setTimeout(type, 22);
    };
    this.brief.textContent = '';
    this.place.classList.remove('in');
    void this.place.offsetWidth;
    this.place.classList.add('in');
    setTimeout(type, 250);
  }

  /**
   * Shows the card and runs `work`. Offline the work waits until the bar is most of the way
   * (so the match starts as the card fades); `now` runs it straight away (online, where
   * messages from other players can't wait).
   */
  run(info: LoadInfo, work: () => void, opts: { minMs?: number; now?: boolean } = {}) {
    const minMs = opts.minMs ?? 1900;
    this.busy = true;
    this.el.querySelector('.ls-mode')!.textContent = info.mode;
    this.el.querySelector('.ls-sub')!.textContent = info.sub;
    this.tip.textContent = randomTip();
    this.drawMap(info);
    this.shots = info.shots ?? [];
    this.shotIx = -1;
    this.el.classList.toggle('has-shots', this.shots.length > 0);
    for (const l of this.layers) l.classList.remove('on');
    this.nextShot();
    this.el.classList.remove('out');
    this.el.classList.add('on');
    const t0 = performance.now();
    let did = false, tipAt = t0, shotAt = t0;
    if (opts.now) {
      did = true;
      work();
    }
    const tick = () => {
      const now = performance.now(), k = Math.min(1, (now - t0) / minMs);
      // Eases in quickly, then crawls: feels like real loading.
      this.bar.style.width = `${Math.round((1 - (1 - k) ** 2.2) * 100)}%`;
      this.label.textContent = STAGES[Math.min(STAGES.length - 1, Math.floor(k * STAGES.length))];
      if (now - tipAt > 4000) {
        tipAt = now;
        this.tip.textContent = TIPS[(TIPS.indexOf(this.tip.textContent ?? '') + 1) % TIPS.length];
      }
      if (now - shotAt > SHOT_MS && this.shots.length > 1) {
        shotAt = now;
        this.nextShot();
      }
      if (!did && k >= 0.78) {
        did = true;
        work();
      }
      if (k < 1) return void setTimeout(tick, 30);
      this.el.classList.add('out');
      setTimeout(() => {
        this.el.classList.remove('on', 'out');
        this.busy = false;
      }, 500);
    };
    setTimeout(tick, 30);
  }
}
