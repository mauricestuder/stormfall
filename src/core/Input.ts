/** Rebindable actions. The code is the default key and also the logical name the game asks for. */
export const ACTIONS: { code: string; label: string }[] = [
  { code: 'KeyW', label: 'Move forward' },
  { code: 'KeyS', label: 'Move back' },
  { code: 'KeyA', label: 'Move left' },
  { code: 'KeyD', label: 'Move right' },
  { code: 'Space', label: 'Jump / Mantle / Deploy' },
  { code: 'KeyC', label: 'Crouch / Slide' },
  { code: 'ShiftLeft', label: 'Sprint' },
  { code: 'KeyR', label: 'Reload' },
  { code: 'KeyF', label: 'Pick up / Open chest / Door' },
  { code: 'KeyE', label: 'Vehicle / Zipline' },
  { code: 'KeyQ', label: 'Swap weapon' },
  { code: 'Digit1', label: 'Weapon 1' },
  { code: 'Digit2', label: 'Weapon 2' },
  { code: 'Digit3', label: 'Hands (run faster)' },
  { code: 'KeyG', label: 'Grenade (tap: throw, hold: wheel)' },
  { code: 'KeyZ', label: 'Next grenade type' },
  { code: 'KeyX', label: 'Grappling hook' },
  { code: 'KeyV', label: 'Armor plate' },
  { code: 'KeyH', label: 'Medkit' },
  { code: 'KeyM', label: 'Map' },
  { code: 'Tab', label: 'Inventory' },
  { code: 'KeyL', label: 'Flashlight' },
  { code: 'KeyY', label: 'Inspect knife' },
];
const ACTION_CODES = new Set(ACTIONS.map((a) => a.code));

export function keyName(code: string) {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return ({ Space: 'SPACE', ShiftLeft: 'SHIFT', ShiftRight: 'R-SHIFT', ControlLeft: 'CTRL', AltLeft: 'ALT', Tab: 'TAB', CapsLock: 'CAPS', Backquote: '`' } as Record<string, string>)[code] ?? code.replace('Arrow', '↑').toUpperCase();
}

// Standard gamepad layout -> logical key.
const PAD_BUTTONS: Record<number, string> = {
  0: 'Space', 1: 'KeyC', 2: 'KeyR', 3: 'KeyQ', 4: 'KeyG', 5: 'KeyV', 8: 'KeyM', 11: 'KeyX', 12: 'KeyH', 13: 'KeyF', 14: 'KeyZ', 15: 'KeyL',
};

export class Input {
  private down = new Set<string>();
  private pressedKeys = new Set<string>();
  /** Keys held by the gamepad or touch buttons. */
  private virtual = new Set<string>();
  private physToLogical = new Map<string, string[]>();
  private capture: ((code: string) => void) | null = null;
  private padPrev: boolean[] = [];
  private padSprint = false;
  mouseDown = [false, false, false];

  /** Let go of every key and button (menus over a live online match). */
  releaseAll() {
    this.down.clear();
    this.mouseDown.fill(false);
  }
  mousePressed = [false, false, false];
  mouseDX = 0;
  /** Smoothed size of recent mouse moves, to spot bogus spikes. */
  private recentMove = 0;
  private lockedAt = 0;
  mouseDY = 0;
  wheel = 0;
  locked = false;
  padConnected = false;
  padSens = 1;
  /** Vertical look speed relative to horizontal. */
  padSensY = 0.75;
  padDeadzone = 0.15;
  padInvertY = false;
  /** Right-stick response: 1 linear, 2 squared (fine aim), 3 cubic. */
  padCurve = 2;
  /** Aim assist slowdown for the right stick (1 = none). */
  padSlow = 1;
  /** How far the sticks are pushed this frame (0..1). */
  padLook = 0;
  padMove = 0;
  /** Raw sticks after the deadzone (menu cursor). */
  padAxes = { lx: 0, ly: 0, rx: 0, ry: 0 };
  private padEdges: boolean[] = [];
  /** Button `i` went down this frame. */
  padJust(i: number) {
    return !!this.padEdges[i];
  }
  /** What you touched last: button prompts follow it. */
  lastDevice: 'kb' | 'pad' = 'kb';
  /** Glyph set guessed from the controller's name. */
  padKind: 'xbox' | 'ps' = 'xbox';
  onDeviceChange: () => void = () => {};

  private setDevice(d: 'kb' | 'pad') {
    if (d === this.lastDevice) return;
    this.lastDevice = d;
    this.onDeviceChange();
  }
  onLockChange: (locked: boolean) => void = () => {};
  /** Gamepad Start button. */
  onPadPause: () => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    this.setBinds({});
    window.addEventListener('keydown', (e) => {
      if (this.capture) {
        e.preventDefault();
        const cb = this.capture;
        this.capture = null;
        cb(e.code);
        return;
      }
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      this.setDevice('kb');
      for (const code of this.resolve(e.code)) {
        if (!e.repeat) this.pressedKeys.add(code);
        this.down.add(code);
      }
    });
    window.addEventListener('keyup', (e) => {
      for (const code of this.resolve(e.code)) this.down.delete(code);
    });
    window.addEventListener('blur', () => {
      this.down.clear();
      this.mouseDown.fill(false);
    });
    window.addEventListener('mousedown', (e) => {
      this.setDevice('kb');
      if (!this.locked) return;
      this.mouseDown[e.button] = true;
      this.mousePressed[e.button] = true;
    });
    window.addEventListener('mouseup', (e) => (this.mouseDown[e.button] = false));
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Browsers sometimes report one huge bogus jump (right after locking, or when the hidden
      // cursor wraps at the screen edge), which snaps the view. Ignore moves far outside recent motion.
      const mag = Math.abs(e.movementX) + Math.abs(e.movementY);
      if (performance.now() - this.lockedAt < 120) return;
      if (mag > 160 && mag > this.recentMove * 6 + 60) {
        this.recentMove *= 0.5;
        return;
      }
      this.recentMove = this.recentMove * 0.75 + mag * 0.25;
      if (mag > 6) this.setDevice('kb');
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener('wheel', (e) => {
      if (this.locked) this.wheel += Math.sign(e.deltaY);
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.lockedAt = performance.now();
      this.recentMove = 0;
      if (!this.locked) {
        this.down.clear();
        this.mouseDown.fill(false);
      }
      this.onLockChange(this.locked);
    });
  }

  /** `binds` maps an action's logical code to the physical key the player chose. */
  setBinds(binds: Record<string, string>) {
    this.physToLogical.clear();
    for (const a of ACTIONS) {
      const phys = binds[a.code] ?? a.code;
      const list = this.physToLogical.get(phys) ?? [];
      list.push(a.code);
      this.physToLogical.set(phys, list);
    }
    this.down.clear();
  }

  private resolve(phys: string): string[] {
    const m = this.physToLogical.get(phys);
    if (m) return m;
    // Keys that belong to an action which was moved elsewhere do nothing; everything else passes through.
    return ACTION_CODES.has(phys) ? [] : [phys];
  }

  /** Next key press goes to `cb` instead of the game (key rebinding). */
  captureKey(cb: (code: string) => void) {
    this.capture = cb;
  }

  lock() {
    // Raw (unaccelerated) mouse input where supported: steadier aim, and it avoids the snap bug.
    const plain = () => {
      const p = this.canvas.requestPointerLock?.() as unknown;
      if (p instanceof Promise) p.catch(() => {});
    };
    try {
      const p = (this.canvas.requestPointerLock as (o?: unknown) => unknown)?.call(this.canvas, { unadjustedMovement: true });
      if (p instanceof Promise) p.catch(plain);
    } catch {
      plain();
    }
  }

  isDown(code: string) {
    return this.down.has(code) || this.virtual.has(code);
  }

  pressed(code: string) {
    return this.pressedKeys.has(code);
  }

  /** Touch buttons and the gamepad hold / tap logical keys through these. */
  virtualDown(code: string) {
    if (!this.virtual.has(code)) this.pressedKeys.add(code);
    this.virtual.add(code);
  }

  virtualUp(code: string) {
    this.virtual.delete(code);
  }

  virtualMouse(button: number, down: boolean) {
    if (down && !this.mouseDown[button]) this.mousePressed[button] = true;
    this.mouseDown[button] = down;
  }

  addLook(dx: number, dy: number) {
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  consumeMouse() {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = this.mouseDY = 0;
    return d;
  }

  /** Reads the first connected gamepad (standard mapping). Call once per frame. */
  pollGamepad(dt: number) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp: Gamepad | null = null;
    for (const p of pads) if (p && p.connected) {
      gp = p;
      break;
    }
    this.padConnected = !!gp;
    this.padLook = this.padMove = 0;
    this.padEdges = [];
    this.padAxes.lx = this.padAxes.ly = this.padAxes.rx = this.padAxes.ry = 0;
    if (!gp) return;
    const kind = /054c|playstation|dualsense|dualshock|wireless controller/i.test(gp.id) ? 'ps' : 'xbox';
    if (kind !== this.padKind) {
      this.padKind = kind;
      if (this.lastDevice === 'pad') this.onDeviceChange();
    }
    const dzv = this.padDeadzone;
    const dz = (v: number) => (Math.abs(v) < dzv ? 0 : Math.sign(v) * (Math.abs(v) - dzv) / (1 - dzv));
    const lx = dz(gp.axes[0] ?? 0), ly = dz(gp.axes[1] ?? 0), rx = dz(gp.axes[2] ?? 0), ry = dz(gp.axes[3] ?? 0);
    const hold = (code: string, on: boolean) => (on ? this.virtualDown(code) : this.virtualUp(code));
    hold('KeyW', ly < -0.35);
    hold('KeyS', ly > 0.35);
    hold('KeyA', lx < -0.35);
    hold('KeyD', lx > 0.35);
    // Right stick: curved response for fine aim, fast turns at full tilt.
    this.padAxes.lx = lx;
    this.padAxes.ly = ly;
    this.padAxes.rx = rx;
    this.padAxes.ry = ry;
    this.padLook = Math.min(1, Math.hypot(rx, ry));
    this.padMove = Math.min(1, Math.hypot(lx, ly));
    const k = 1100 * dt * this.padSens * this.padSlow, c = this.padCurve;
    this.mouseDX += Math.sign(rx) * Math.pow(Math.abs(rx), c) * k;
    this.mouseDY += Math.sign(ry) * Math.pow(Math.abs(ry), c) * k * this.padSensY * (this.padInvertY ? -1 : 1);
    const b = gp.buttons.map((x) => x.pressed);
    if (lx || ly || rx || ry || b.some((x) => x)) this.setDevice('pad');
    // D-pad down: pick up / open, and get in a car or on a zipline.
    if (!!b[13] !== !!this.padPrev[13]) hold('KeyE', !!b[13]);
    for (const [i, code] of Object.entries(PAD_BUTTONS)) {
      const on = !!b[+i];
      if (on !== !!this.padPrev[+i]) hold(code, on);
    }
    // L3 toggles sprint, the triggers fire and aim, Start pauses.
    if (b[10] && !this.padPrev[10]) this.padSprint = !this.padSprint;
    if (ly > -0.35) this.padSprint = false;
    hold('ShiftLeft', this.padSprint);
    if (!!b[7] !== !!this.padPrev[7]) this.virtualMouse(0, !!b[7]);
    if (!!b[6] !== !!this.padPrev[6]) this.virtualMouse(2, !!b[6]);
    if (b[9] && !this.padPrev[9]) this.onPadPause();
    this.padEdges = b.map((x, i) => x && !this.padPrev[i]);
    this.padPrev = b;
  }

  /** Clear one-shot events. Called after at least one simulation step consumed them. */
  endStep() {
    this.pressedKeys.clear();
    this.mousePressed.fill(false);
    this.wheel = 0;
  }
}
