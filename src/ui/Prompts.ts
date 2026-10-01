import type { Input } from '../core/Input';

export type PadStyle = 'xbox' | 'ps';

/** Keyboard key (as written in a <kbd>) -> controller button (Xbox name). */
const KEY_TO_PAD: Record<string, string> = {
  SPACE: 'A', C: 'B', R: 'X', Q: 'Y', G: 'LB', V: 'RB', H: 'D▲', F: 'D▼', E: 'D▼', Z: 'D◀', L: 'D▶',
  M: 'VIEW', X: 'R3', SHIFT: 'L3', LMB: 'RT', RMB: 'LT', WASD: 'LS', W: 'LS↑', ESC: 'MENU',
};

const PS: Record<string, string> = { A: '✕', B: '○', X: '□', Y: '△', LB: 'L1', RB: 'R1', LT: 'L2', RT: 'R2', VIEW: 'CREATE', MENU: 'OPTIONS' };

/** How a controller button is written, and its colour class (face buttons get their usual colours). */
export function padGlyph(btn: string, style: PadStyle) {
  const text = style === 'ps' ? PS[btn] ?? btn : btn;
  const cls = { A: 'pad-a', B: 'pad-b', X: 'pad-x', Y: 'pad-y' }[btn] ?? '';
  return { text, cls };
}

/** Everything a controller does, for the layout card in Controls. */
export const PAD_LAYOUT: [string, string][] = [
  ['LS', 'Move (click L3 to sprint)'],
  ['RS', 'Look (click R3: grappling hook)'],
  ['RT', 'Fire'],
  ['LT', 'Aim'],
  ['A', 'Jump / Mantle / Deploy'],
  ['B', 'Crouch / Slide'],
  ['X', 'Reload'],
  ['Y', 'Swap weapon'],
  ['LB', 'Grenade (tap: throw, hold: wheel)'],
  ['RB', 'Armor plate'],
  ['D▲', 'Medkit'],
  ['D▼', 'Pick up / Open / Drive / Zipline'],
  ['D◀', 'Next grenade type'],
  ['D▶', 'Flashlight'],
  ['VIEW', 'Map'],
  ['MENU', 'Pause'],
];

/**
 * Button prompts follow the last thing you touched: keyboard letters, or controller buttons as soon
 * as you use a pad. Every <kbd> on the page is swapped in place (the keyboard text is kept in data-k).
 */
export class Prompts {
  style: PadStyle = 'xbox';
  /** 'auto' picks the glyphs from the controller's name. */
  pref: 'auto' | PadStyle = 'auto';

  constructor(private input: Input) {
    new MutationObserver((recs) => {
      if (input.lastDevice !== 'pad') return;
      for (const r of recs) for (const n of r.addedNodes) if (n instanceof HTMLElement) this.apply(n);
    }).observe(document.body, { childList: true, subtree: true });
    input.onDeviceChange = () => this.refresh();
  }

  refresh() {
    this.style = this.pref === 'auto' ? this.input.padKind : this.pref;
    document.body.classList.toggle('pad-prompts', this.input.lastDevice === 'pad');
    this.apply(document.body);
    this.onChange();
  }

  /** Called after the prompts switch (the controls card re-renders). */
  onChange: () => void = () => {};

  private apply(root: HTMLElement) {
    const pad = this.input.lastDevice === 'pad';
    const list = root.tagName === 'KBD' ? [root] : root.querySelectorAll<HTMLElement>('kbd');
    for (const el of list) {
      if (el.dataset.static !== undefined) continue;
      const k = (el.dataset.k ??= el.textContent ?? '');
      const btn = pad ? KEY_TO_PAD[k.trim().toUpperCase()] : undefined;
      el.classList.remove('pad', 'pad-a', 'pad-b', 'pad-x', 'pad-y');
      if (btn) {
        const g = padGlyph(btn, this.style);
        el.textContent = g.text;
        el.classList.add('pad');
        if (g.cls) el.classList.add(g.cls);
      } else if (el.textContent !== k) el.textContent = k;
    }
  }
}
