import { randomTip, TIPS } from './tips';

export interface LoadInfo {
  mode: string;
  sub: string;
  /** The island map (it already has the town names on it), drawn behind everything. */
  map?: HTMLCanvasElement;
}

const STAGES = ['Building the island', 'Hiding the loot', 'Spawning players', 'Warming up the engines', 'Boarding the plane'];

/**
 * Full-screen loading card between the lobby and a match: the island map, the mode, a tip and a
 * progress bar. Heavy match setup runs while it's up, so the hitch hides behind it.
 */
export class LoadScreen {
  private el: HTMLDivElement;
  private bar: HTMLElement;
  private label: HTMLElement;
  private tip: HTMLElement;
  private cv: HTMLCanvasElement;
  busy = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'loadscreen';
    this.el.innerHTML = `<canvas class="ls-map" width="900" height="900"></canvas><div class="ls-shade"></div>
      <div class="ls-top"><h1>STORM<span>FALL</span></h1></div>
      <div class="ls-card"><small>NOW LOADING</small><b class="ls-mode"></b><span class="ls-sub"></span></div>
      <div class="ls-foot"><div class="ls-tip"><b>TIP</b><span></span></div>
      <div class="ls-bar"><i></i></div><div class="ls-label"></div></div>`;
    document.body.appendChild(this.el);
    this.bar = this.el.querySelector('.ls-bar i')!;
    this.label = this.el.querySelector('.ls-label')!;
    this.tip = this.el.querySelector('.ls-tip span')!;
    this.cv = this.el.querySelector('canvas')!;
  }

  private drawMap(info: LoadInfo) {
    const ctx = this.cv.getContext('2d')!, N = this.cv.width;
    ctx.fillStyle = '#123049';
    ctx.fillRect(0, 0, N, N);
    if (!info.map) return;
    ctx.drawImage(info.map, 0, 0, N, N);
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
    this.el.classList.remove('out');
    this.el.classList.add('on');
    const t0 = performance.now();
    let did = false, tipAt = t0;
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
