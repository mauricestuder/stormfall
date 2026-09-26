import type { Input } from '../core/Input';

interface Btn {
  label: string;
  code: string;
  x: number;
  y: number;
  size?: number;
  toggle?: boolean;
}

// Positions are offsets from the bottom-right corner (px).
const BUTTONS: Btn[] = [
  { label: 'FIRE', code: 'fire', x: 110, y: 190, size: 84 },
  { label: 'ADS', code: 'ads', x: 30, y: 280, toggle: true },
  { label: 'JUMP', code: 'Space', x: 30, y: 110, size: 70 },
  { label: 'CROUCH', code: 'KeyC', x: 120, y: 60 },
  { label: 'RELOAD', code: 'KeyR', x: 210, y: 110 },
  { label: 'SWAP', code: 'KeyQ', x: 210, y: 200 },
  { label: 'USE', code: 'KeyF', x: 200, y: 290 },
  { label: 'E', code: 'KeyE', x: 110, y: 330 },
  { label: 'NADE', code: 'KeyG', x: 30, y: 380 },
  { label: 'HEAL', code: 'KeyH', x: 290, y: 60 },
  { label: 'PLATE', code: 'KeyV', x: 290, y: 150 },
];

/**
 * On-screen controls for phones and tablets: a virtual stick on the left, drag anywhere on the
 * right to look, and buttons that press the same logical keys as the keyboard.
 */
export class Touch {
  root: HTMLDivElement;
  private stickId = -1;
  private stickOrigin = { x: 0, y: 0 };
  private knob: HTMLDivElement;
  private base: HTMLDivElement;
  private lookId = -1;
  private lookLast = { x: 0, y: 0 };
  private adsOn = false;
  sens = 1;

  constructor(private input: Input, onMenu: () => void, onMap: () => void, onBag: () => void = () => {}) {
    const root = (this.root = document.createElement('div'));
    root.id = 'touch';
    this.base = document.createElement('div');
    this.base.className = 'stick-base';
    this.knob = document.createElement('div');
    this.knob.className = 'stick-knob';
    this.base.appendChild(this.knob);
    root.appendChild(this.base);

    for (const b of BUTTONS) {
      const el = document.createElement('div');
      el.className = 'tbtn';
      el.textContent = b.label;
      const s = b.size ?? 58;
      Object.assign(el.style, { right: `${b.x}px`, bottom: `${b.y}px`, width: `${s}px`, height: `${s}px` });
      el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.add('on');
        if (b.code === 'fire') {
          this.input.virtualMouse(0, true);
          // Firing thumb can also aim.
          const t = e.changedTouches[0];
          this.lookId = t.identifier;
          this.lookLast = { x: t.clientX, y: t.clientY };
        } else if (b.code === 'ads') {
          this.adsOn = !this.adsOn;
          this.input.virtualMouse(2, this.adsOn);
          el.classList.toggle('on', this.adsOn);
        } else this.input.virtualDown(b.code);
      }, { passive: false });
      const up = (e: TouchEvent) => {
        e.preventDefault();
        if (b.code === 'ads') return;
        el.classList.remove('on');
        if (b.code === 'fire') {
          this.input.virtualMouse(0, false);
          this.lookId = -1;
        } else this.input.virtualUp(b.code);
      };
      el.addEventListener('touchend', up, { passive: false });
      el.addEventListener('touchcancel', up, { passive: false });
      root.appendChild(el);
    }
    const top = (label: string, x: number, fn: () => void) => {
      const el = document.createElement('div');
      el.className = 'tbtn small';
      el.textContent = label;
      Object.assign(el.style, { left: `${x}px`, top: '12px' });
      el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        fn();
      }, { passive: false });
      root.appendChild(el);
    };
    top('☰', 12, onMenu);
    top('MAP', 70, onMap);
    top('BAG', 128, onBag);
    const tap = (code: string) => () => {
      this.input.virtualDown(code);
      setTimeout(() => this.input.virtualUp(code), 60);
    };
    top('1', 186, tap('Digit1'));
    top('2', 244, tap('Digit2'));
    top('✊', 302, tap('Digit3'));

    root.addEventListener('touchstart', (e) => this.start(e), { passive: false });
    root.addEventListener('touchmove', (e) => this.move(e), { passive: false });
    root.addEventListener('touchend', (e) => this.end(e), { passive: false });
    root.addEventListener('touchcancel', (e) => this.end(e), { passive: false });
    document.body.appendChild(root);
    this.show(false);
  }

  show(on: boolean) {
    this.root.style.display = on ? 'block' : 'none';
  }

  private start(e: TouchEvent) {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < innerWidth * 0.4 && this.stickId < 0) {
        this.stickId = t.identifier;
        this.stickOrigin = { x: t.clientX, y: t.clientY };
        Object.assign(this.base.style, { left: `${t.clientX - 60}px`, top: `${t.clientY - 60}px`, opacity: '1' });
        this.knob.style.transform = 'translate(0px, 0px)';
      } else if (this.lookId < 0) {
        this.lookId = t.identifier;
        this.lookLast = { x: t.clientX, y: t.clientY };
      }
    }
  }

  private move(e: TouchEvent) {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickId) {
        let dx = t.clientX - this.stickOrigin.x, dy = t.clientY - this.stickOrigin.y;
        const d = Math.hypot(dx, dy), max = 55;
        if (d > max) {
          dx *= max / d;
          dy *= max / d;
        }
        this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
        const nx = dx / max, ny = dy / max;
        this.hold('KeyW', ny < -0.35);
        this.hold('KeyS', ny > 0.35);
        this.hold('KeyA', nx < -0.35);
        this.hold('KeyD', nx > 0.35);
        this.hold('ShiftLeft', ny < -0.92);
      } else if (t.identifier === this.lookId) {
        this.input.addLook((t.clientX - this.lookLast.x) * 2.2 * this.sens, (t.clientY - this.lookLast.y) * 2.2 * this.sens);
        this.lookLast = { x: t.clientX, y: t.clientY };
      }
    }
  }

  private end(e: TouchEvent) {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickId) {
        this.stickId = -1;
        this.base.style.opacity = '0.35';
        this.knob.style.transform = 'translate(0px, 0px)';
        for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ShiftLeft']) this.input.virtualUp(k);
      } else if (t.identifier === this.lookId) this.lookId = -1;
    }
  }

  private hold(code: string, on: boolean) {
    if (on) this.input.virtualDown(code);
    else this.input.virtualUp(code);
  }
}
