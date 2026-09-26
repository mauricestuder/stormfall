import type { Game } from '../game/Game';

/**
 * A mouse pointer for controllers in the menus: the left stick moves it, A clicks,
 * the right stick scrolls, and sliders / dropdowns can be changed with A (and the D-pad on sliders).
 */
export class PadCursor {
  private el = document.createElement('div');
  private x = innerWidth / 2;
  private y = innerHeight / 2;
  private hover: HTMLElement | null = null;
  private shown = false;

  constructor(private game: Game) {
    this.el.id = 'pad-cursor';
    document.body.appendChild(this.el);
  }

  update(dt: number) {
    const g = this.game, inp = g.input;
    const on = inp.padConnected && inp.lastDevice === 'pad' && (g.state !== 'playing' || g.hud.invOpen) && g.state !== 'loading';
    if (on !== this.shown) {
      this.shown = on;
      this.el.classList.toggle('on', on);
      if (!on) this.setHover(null);
    }
    if (!on) return;
    const { lx, ly, rx, ry } = inp.padAxes;
    const m = Math.hypot(lx, ly);
    if (m > 0) {
      const sp = 1100 * Math.pow(m, 1.6) * dt;
      this.x = Math.max(0, Math.min(innerWidth - 2, this.x + (lx / m) * sp));
      this.y = Math.max(0, Math.min(innerHeight - 2, this.y + (ly / m) * sp));
    }
    this.el.style.transform = `translate(${this.x}px, ${this.y}px)`;
    const target = this.at();
    this.setHover(target);
    if (Math.abs(ry) > 0 || Math.abs(rx) > 0) this.scroll(target, rx * 900 * dt, ry * 900 * dt);
    if (inp.padJust(0)) this.click(target);
    // D-pad left / right nudges a slider under the cursor.
    const nudge = (inp.padJust(15) ? 1 : 0) - (inp.padJust(14) ? 1 : 0);
    if (nudge && target instanceof HTMLInputElement && target.type === 'range') {
      if (nudge > 0) target.stepUp();
      else target.stepDown();
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  private at(): HTMLElement | null {
    this.el.style.display = 'none';
    const e = document.elementFromPoint(this.x, this.y) as HTMLElement | null;
    this.el.style.display = '';
    return e;
  }

  private setHover(t: HTMLElement | null) {
    const h = (t?.closest('button, a, select, input, label, [data-click], .mode-card, .party-slot, .locker-item') as HTMLElement | null) ?? null;
    if (h === this.hover) return;
    this.hover?.classList.remove('pad-hover');
    h?.classList.add('pad-hover');
    this.hover = h;
    this.el.classList.toggle('over', !!h);
  }

  private scroll(t: HTMLElement | null, dx: number, dy: number) {
    for (let e = t; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth)) {
        e.scrollBy(dx, dy);
        return;
      }
    }
  }

  private click(t: HTMLElement | null) {
    if (!t) return;
    this.el.classList.remove('press');
    void this.el.offsetWidth;
    this.el.classList.add('press');
    if (t instanceof HTMLInputElement && t.type === 'range') {
      // Jump the slider to where the cursor is.
      const r = t.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (this.x - r.left) / r.width));
      const min = +t.min || 0, max = +t.max || 100, step = +t.step || 1;
      t.value = String(Math.round((min + f * (max - min)) / step) * step);
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (t instanceof HTMLSelectElement) {
      // Dropdowns can't be opened from script: A steps to the next option.
      t.selectedIndex = (t.selectedIndex + 1) % t.options.length;
      t.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const opts = { bubbles: true, cancelable: true, clientX: this.x, clientY: this.y, view: window };
    t.dispatchEvent(new PointerEvent('pointerdown', opts));
    t.dispatchEvent(new MouseEvent('mousedown', opts));
    t.dispatchEvent(new PointerEvent('pointerup', opts));
    t.dispatchEvent(new MouseEvent('mouseup', opts));
    if (t instanceof HTMLInputElement && (t.type === 'text' || t.type === 'number')) t.focus();
    t.dispatchEvent(new MouseEvent('click', opts));
  }
}
