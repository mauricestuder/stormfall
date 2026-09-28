import { Vector3 } from 'three';
import { CONFIG } from '../config';
import { clamp, damp } from '../core/rng';
import type { SettingsData } from '../core/Settings';
import { Bot } from '../bots/Bot';
import type { Game } from '../game/Game';
import { DUST_STORM } from '../game/Zone';
import { xpForLevel } from '../game/Profile';
import { FIST_ICON, gunIcon } from './icons';
import { TEAM_CSS, TEAM_NAMES, type Arena } from '../game/Arena';
import { cheatOn } from '../game/Cheats';
import { HOOK_CHARGES, HOOK_RECHARGE, WHEEL_SLOTS } from '../weapons/PlayerWeapons';
import { AMMO_INFO, ATT_KINDS, ATTACHMENTS, canAttach, magSize, THROWABLES, WEAPONS, type AmmoType, type ThrowKind, type WeaponInstance } from '../weapons/Weapon';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el(id: string, parent: HTMLElement, cls = '') {
  let e = document.getElementById(id);
  if (!e) {
    e = document.createElement('div');
    e.id = id;
    if (cls) e.className = cls;
    parent.appendChild(e);
  }
  return e;
}

/** What Profile.finishMatch returns. */
export interface XpReport {
  lines: [string, number][];
  total: number;
  before: number;
  after: number;
  unlocked: string[];
  /** Adaptive bots: +1 they got tougher after this match, -1 easier. */
  botShift: number;
}

interface DamageNumber {
  el: HTMLElement;
  pos: Vector3;
  life: number;
  /** Who was hit: follow-up hits on them add to this number instead of making new ones. */
  target: object | null;
  total: number;
  kind: 'armor' | 'health' | 'head';
}

/** DOM overlay: vitals, ammo, minimap, compass, killfeed, hit feedback, menus. */
type MarkKind = 'hit' | 'near' | 'shot' | 'step' | 'chest';

export class Hud {
  private root = $('hud');
  private crosshair = $('crosshair');
  /** Ammo left, as a short arc to the right of the crosshair. */
  private ammoArc = (() => {
    const d = document.createElement('div');
    d.id = 'ammo-arc';
    const arc = 'M 66.05 61.86 A 34 34 0 0 0 66.05 18.14';
    d.innerHTML = `<svg viewBox="0 0 80 80" width="80" height="80"><path class="bg" d="${arc}" pathLength="1"/><path class="fg" d="${arc}" pathLength="1"/></svg>`;
    $('hud').appendChild(d);
    return d;
  })();
  private ammoKey = '';
  private hitmarker = $('hitmarker');
  private scope = $('scope');
  private dmgLayer = $('dmg-layer');
  private indicators = $('indicators');
  private killfeedEl = $('killfeed');
  private prompt = $('prompt');
  private channel = $('channel');
  private ammoHint = $('ammo-hint');
  private dropInfo = $('drop-info');
  private zoneTimer = $('zone-timer');
  private arenaBar = $('arena-bar');
  private respawnEl = $('respawn');
  private scoreEl = $('scoreboard');
  private scoreTimer = 0;
  /** Tab held in the arena: show the scoreboard. */
  scoreboardHeld = false;
  private locationEl = $('location');
  private pickupsEl = $('pickups');
  private vehicleEl = $('vehicle-hud');
  private fpsEl = $('fps');
  private fpsFrames = 0;
  private fpsTime = 0;
  private showDamageNumbers = true;
  private announceEl = $('announce');
  private vignette = $('vignette');
  private stormTint = $('storm-tint');
  private minimap = $<HTMLCanvasElement>('minimap');
  private bigmap = $('bigmap');
  private bigmapCv = $<HTMLCanvasElement>('bigmap-cv');
  private compass = $<HTMLCanvasElement>('compass-cv');
  private armorFills = [...document.querySelectorAll<HTMLElement>('#vitals .seg .fill')];
  private healthFill = document.querySelector<HTMLElement>('#vitals .health .fill')!;
  /** Trails the health bar down so you can see the chunk you just lost. */
  private healthGhost = document.querySelector<HTMLElement>('#vitals .health .ghost')!;
  private healthNum = document.querySelector<HTMLElement>('#vitals .health .num')!;
  private slotEls = [...document.querySelectorAll<HTMLElement>('#slots .slot')];

  private hitTime = 0;
  private hurtFlash = 0;
  private beatCd = 0;
  private healthBar = document.querySelector<HTMLElement>('#vitals .health')!;
  private announceTime = 0;
  private numbers: DamageNumber[] = [];
  private cache = new Map<string, string>();
  bigMapOpen = false;
  private flashEl = el('flash', document.body);
  private smokeEl = el('smoke-veil', document.body);
  private crackEl = el('armor-crack', $('hud'));
  private killcamEl = el('killcam', document.body);
  private throwEl = el('throwables', $('hud'));
  private teamEl = el('team', $('hud'));
  private platesEl = el('nameplates', $('hud'));
  private flashT = 0;
  private crackT = 0;
  private mapTimer = 0;
  private plates = new Map<Bot, HTMLElement>();
  private fadeEl = el('fade', document.body);
  private invEl = el('inventory', document.body);
  invOpen = false;
  /** Which inventory tile is selected: a gun slot (0/1) or an item key. */
  private invSel: number | string = 0;
  onSwapSlots: () => void = () => {};
  onInventoryClose: () => void = () => {};
  /** Markers round the crosshair pointing at whoever hit you, and at nearby sounds. */
  private marks: { el: HTMLElement; icon: HTMLElement; from: Vector3; t: number; life: number; kind: MarkKind; src: object | null }[] = [];
  private visualSound = true;

  constructor(private game: Game) {
    if (DUST_STORM) this.stormTint.style.background = 'radial-gradient(ellipse at center, rgba(210,150,80,0.3), rgba(125,75,30,0.78))';
  }

  /** Flashbang: white-out that fades over a few seconds. */
  flash(strength: number) {
    this.flashT = Math.max(this.flashT, strength * 6.5);
  }

  /** Enemy armor broke: a shattered-shield flash round the crosshair. */
  armorCrack() {
    this.crackT = 0.45;
  }

  /** 0..1: how deep inside a smoke cloud the camera is. */
  smokeVeil(v: number) {
    // Under the HUD, over the world.
    if (this.smokeEl.nextElementSibling !== $('hud')) document.body.insertBefore(this.smokeEl, $('hud'));
    this.smokeEl.style.opacity = v > 0.01 ? v.toFixed(2) : '0';
  }

  killcamBanner(name: string | null) {
    this.killcamEl.style.display = name ? 'block' : 'none';
    if (name) this.killcamEl.innerHTML = `<div class="kc-title">KILLCAM</div><div class="kc-name">Killed by <b>${escapeHtml(name)}</b></div><div class="kc-hint"><kbd>SPACE</kbd> skip</div>`;
  }

  applySettings(s: SettingsData) {
    this.showDamageNumbers = s.damageNumbers;
    this.dmgLayer.style.setProperty('--dn', String(s.damageNumberSize));
    this.visualSound = s.visualSound;
    this.fpsEl.style.display = s.showFps ? 'block' : 'none';
    this.crosshair.style.setProperty('--ch', s.crosshairColor);
    this.crosshair.style.setProperty('--cs', String(s.crosshairSize));
    this.crosshair.dataset.style = s.crosshairStyle;
    this.root.style.setProperty('--hud-scale', String(s.hudScale));
    document.getElementById('minimap')!.style.display = s.showMinimap ? '' : 'none';
    document.getElementById('killfeed')!.style.display = s.showKillfeed ? '' : 'none';
  }

  show(on: boolean) {
    this.root.classList.toggle('hidden', !on);
  }

  private setText(el: HTMLElement, key: string, text: string) {
    if (this.cache.get(key) === text) return;
    this.cache.set(key, text);
    el.textContent = text;
  }

  private setHtml(el: HTMLElement, key: string, html: string) {
    if (this.cache.get(key) === html) return;
    this.cache.set(key, html);
    el.innerHTML = html;
  }

  private medalBox: HTMLElement | null = null;

  /** Kill medals (headshot, longshot...) popping in under the crosshair. */
  medals(list: string[]) {
    if (!this.medalBox) {
      this.medalBox = document.createElement('div');
      this.medalBox.id = 'medals';
      this.crosshair.parentElement!.appendChild(this.medalBox);
    }
    list.forEach((text, i) => {
      const el = document.createElement('div');
      el.className = `medal${text === 'HEADSHOT' ? ' head' : ''}`;
      el.textContent = text;
      el.style.animationDelay = `${i * 0.12}s`;
      this.medalBox!.appendChild(el);
      setTimeout(() => el.remove(), 2400 + i * 120);
    });
  }

  /** Crosshair gap in px, following the gun's real spread. */
  private chGap = 6;

  hit(kill: boolean, head: boolean) {
    this.hitTime = kill ? 0.35 : 0.15;
    this.hitmarker.classList.toggle('kill', kill);
    this.hitmarker.classList.toggle('head', head && !kill);
  }

  /**
   * Damage you dealt, floating over the target. Hits on the same target in quick succession add up
   * into one growing number (a whole spray or a shotgun blast reads as one total).
   */
  damageNumber(at: Vector3, amount: number, kind: 'armor' | 'health' | 'head', target: object | null = null) {
    if (!this.showDamageNumbers) return;
    const prev = target ? this.numbers.find((n) => n.target === target && n.life > 0.25) : undefined;
    if (prev) {
      prev.total += amount;
      // Headshots win the colour; otherwise show what the latest hit went into.
      prev.kind = prev.kind === 'head' || kind === 'head' ? 'head' : kind;
      prev.el.className = `dn ${prev.kind}`;
      prev.el.textContent = String(Math.round(prev.total));
      prev.pos.lerp(at.clone().setY(at.y + 0.3), 0.5);
      prev.life = 1.1;
      prev.el.animate([{ transform: 'translate(-50%, -50%) scale(1.35)' }, { transform: 'translate(-50%, -50%) scale(1)' }], { duration: 160, easing: 'ease-out' });
      return;
    }
    const el = document.createElement('div');
    el.className = `dn ${kind}`;
    el.textContent = String(Math.round(amount));
    this.dmgLayer.appendChild(el);
    const pos = at.clone().add(new Vector3((Math.random() - 0.5) * 0.4, 0.3, 0));
    this.numbers.push({ el, pos, life: 1.1, target, total: amount, kind });
  }

  private updateAmmoArc(w: WeaponInstance | null) {
    const el = this.ammoArc, g = this.game;
    if (!w || !this.game.player.alive) {
      if (this.ammoKey) {
        this.ammoKey = '';
        el.style.display = 'none';
      }
      return;
    }
    const cap = magSize(w), rl = g.weapons.reloadProgress(g.player);
    const reloading = rl > 0 && w.mag < cap;
    const key = `${w.mag}/${cap}/${reloading ? Math.round(rl * 40) : -1}`;
    if (key === this.ammoKey) return;
    this.ammoKey = key;
    el.style.display = '';
    const bg = el.querySelector('.bg') as SVGPathElement, fg = el.querySelector('.fg') as SVGPathElement;
    // One tick per round for normal mags; a smooth bar for big ones.
    const n = Math.min(cap, 40), f = w.mag / cap;
    if (cap <= 40) {
      const seg = 1 / n, gap = Math.min(0.35 * seg, 0.012);
      const pat = `${seg - gap} ${gap}`;
      bg.style.strokeDasharray = pat;
      fg.style.strokeDasharray = w.mag > 0 ? `${(pat + ' ').repeat(w.mag)}0 2` : '0 2';
    } else {
      bg.style.strokeDasharray = 'none';
      fg.style.strokeDasharray = `${f} 2`;
    }
    el.classList.toggle('low', f <= 0.25);
    el.classList.toggle('reload', reloading);
    if (reloading && w.mag === 0) fg.style.strokeDasharray = `${rl} 2`;
  }

  /** Took damage: a red arc on the side it came from that keeps pointing at the shooter as you turn. */
  hurt(from: Vector3 | null, amount = 20) {
    this.hurtFlash = 0.5;
    if (from) this.mark(from, 'hit', null, 2.4, Math.min(1, 0.55 + amount / 50));
  }

  /** A bullet flew past you or hit close by: a yellow arc toward the shooter. */
  nearShot(from: Vector3, src: object, strength: number) {
    this.mark(from, 'near', src, 1.6, 0.55 + strength * 0.45);
  }

  /** Fortnite-style sound visualizer: gunfire, footsteps and chests shown round the crosshair. */
  soundPing(from: Vector3, kind: 'shot' | 'step' | 'chest', src: object) {
    if (this.visualSound) this.mark(from, kind, src, kind === 'shot' ? 1.4 : 0.8, 1);
  }

  /** Black screen that fades away (travelling to the Gulag). */
  fadeFromBlack(hold: number, fade: number) {
    this.fadeEl.animate([{ opacity: 1 }, { opacity: 1, offset: hold / (hold + fade) }, { opacity: 0 }], { duration: (hold + fade) * 1000 });
  }

  private mark(from: Vector3, kind: MarkKind, src: object | null, life: number, strength: number) {
    // Refresh the marker for the same source instead of stacking new ones.
    let m = this.marks.find((m) => m.kind === kind && (src ? m.src === src : m.from.distanceToSquared(from) < 16));
    if (!m) {
      const el = document.createElement('div');
      el.className = 'mark ' + kind;
      const icon = document.createElement('i');
      el.appendChild(icon);
      this.indicators.appendChild(el);
      m = { el, icon, from: from.clone(), t: 0, life, kind, src };
      this.marks.push(m);
    }
    m.from.copy(from);
    m.t = 0;
    m.life = life;
    m.el.style.setProperty('--s', strength.toFixed(2));
  }

  private updateMarks(dt: number) {
    const p = this.game.player;
    this.marks = this.marks.filter((m) => {
      m.t += dt;
      if (m.t >= m.life) {
        m.el.remove();
        return false;
      }
      const dx = m.from.x - p.body.pos.x, dz = m.from.z - p.body.pos.z;
      const rot = Math.atan2(dx, -dz) + p.yaw; // bearing relative to where you're looking
      m.el.style.transform = `rotate(${rot}rad)`;
      if (m.kind !== 'hit' && m.kind !== 'near') {
        // Closer sounds are bolder; icons stay upright.
        const near = 1 - Math.min(1, Math.hypot(dx, dz) / (m.kind === 'shot' ? 90 : 30));
        m.icon.style.transform = `rotate(${-rot}rad) scale(${0.75 + near * 0.45})`;
        m.el.style.opacity = String((0.65 + near * 0.35) * Math.min(1, (m.life - m.t) * 3));
      } else m.el.style.opacity = String(Math.min(1, (m.life - m.t) * 1.5));
      return true;
    });
  }

  killfeed(killer: string, victim: string, weapon: string | null, involvesMe: boolean) {
    const el = document.createElement('div');
    el.className = 'kf' + (involvesMe ? ' me' : '');
    const name = (n: string) => (n === 'You' ? `<span class="me-name">${n}</span>` : escapeHtml(n));
    el.innerHTML = `${name(killer)}<span class="w">${weapon ? escapeHtml(weapon) : '☠'}</span>${name(victim)}`;
    this.killfeedEl.prepend(el);
    while (this.killfeedEl.children.length > 6) this.killfeedEl.lastElementChild!.remove();
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 600);
    }, 5000);
  }

  announce(text: string, seconds = 3) {
    this.announceEl.textContent = text;
    this.announceTime = seconds;
  }

  pickupToast(text: string, color: string) {
    const el = document.createElement('div');
    el.className = 'pk';
    el.style.borderLeftColor = color;
    el.textContent = text;
    this.pickupsEl.appendChild(el);
    while (this.pickupsEl.children.length > 5) this.pickupsEl.firstElementChild!.remove();
    el.animate([{ opacity: 0, transform: 'translateX(-12px)' }, { opacity: 1, transform: 'none' }], { duration: 150 });
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 400);
    }, 2200);
  }

  setInventory(open: boolean) {
    this.invOpen = open;
    this.invEl.classList.toggle('open', open);
    this.cache.delete('inv');
    if (open && !this.invEl.dataset.wired) {
      this.invEl.dataset.wired = '1';
      this.invEl.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        const sel = t.closest<HTMLElement>('[data-sel]');
        if (t.closest('[data-swap]')) {
          this.onSwapSlots();
          if (typeof this.invSel === 'number') this.invSel = 1 - this.invSel;
        } else if (sel) {
          const v = sel.dataset.sel!;
          this.invSel = /^\d$/.test(v) ? +v : v;
        } else if (!t.closest('.inv-panel')) return this.onInventoryClose();
        this.cache.delete('inv');
        this.renderInventory();
      });
      let dragFrom = -1;
      this.invEl.addEventListener('dragstart', (e) => {
        const s = (e.target as HTMLElement).closest<HTMLElement>('[data-sel]');
        dragFrom = s && /^\d$/.test(s.dataset.sel!) ? +s.dataset.sel! : -1;
        if (dragFrom < 0) e.preventDefault();
      });
      this.invEl.addEventListener('dragover', (e) => {
        if (dragFrom >= 0 && (e.target as HTMLElement).closest('[data-sel="0"],[data-sel="1"]')) e.preventDefault();
      });
      this.invEl.addEventListener('drop', (e) => {
        const s = (e.target as HTMLElement).closest<HTMLElement>('[data-sel]');
        if (dragFrom >= 0 && s && +s.dataset.sel! !== dragFrom) {
          e.preventDefault();
          this.onSwapSlots();
          this.invSel = +s.dataset.sel!;
          this.cache.delete('inv');
          this.renderInventory();
        }
        dragFrom = -1;
      });
    }
    if (open) this.renderInventory();
  }

  /**
   * Fortnite-style backpack: a row of rarity tiles (guns, then items) and a details card for
   * the selected one, with its stats and attachments (click to take one off). Ammo along the top.
   */
  private renderInventory() {
    const p = this.game.player;
    const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
    const guns = Object.values(WEAPONS);
    const top = {
      dmg: Math.max(...guns.map((d) => d.damage * d.pellets)) * 1.25,
      rpm: Math.max(...guns.map((d) => d.rpm)),
      mag: Math.max(...guns.map((d) => d.mag)) * 1.5,
      range: Math.max(...guns.map((d) => d.range)),
    };
    const bar = (label: string, v: number, max: number, txt: string) =>
      `<div class="inv-stat"><span>${label}</span><div><i style="width:${Math.min(100, (v / max) * 100).toFixed(0)}%"></i></div><b>${txt}</b></div>`;

    const gunTile = (i: number) => {
      const w = p.slots[i], sel = this.invSel === i ? ' sel' : '';
      if (!w) return `<div class="inv-tile2 empty${sel}" data-sel="${i}"><b>${i + 1}</b><small>Empty</small></div>`;
      const dots = ATT_KINDS.filter((a) => a !== 'scope' && w.att[a]).map((a) => `<i style="background:${hex(ATTACHMENTS[a].color)}"></i>`).join('');
      return `<div class="inv-tile2 r${w.rarity.tier}${sel}${i === p.active && !p.unarmed ? ' eq' : ''}" data-sel="${i}" draggable="true">`
        + `<b>${i + 1}</b>${gunIcon(w.def.id)}<em>${w.mag}</em><span class="dots">${dots}</span></div>`;
    };
    const items: { key: string; name: string; n: number; color: string; desc: string; keyHint: string }[] = [
      { key: 'plates', name: 'Armor Plate', n: p.plates, color: '#3aa0ff', desc: 'Restores a bar of armor. Works while moving.', keyHint: 'V' },
      { key: 'medkits', name: 'Medkit', n: p.medkits, color: '#ff6b6b', desc: 'Restores health.', keyHint: 'H' },
      ...(['frag', 'smoke', 'flash', 'grapple'] as ThrowKind[]).map((t) => ({
        key: t, name: THROWABLES[t].name, n: p.throwables[t], color: hex(THROWABLES[t].color | 0x202020),
        desc: t === 'frag' ? 'Bounces, then explodes after a short fuse.' : t === 'smoke' ? 'A thick cloud that blocks sight lines.'
          : t === 'flash' ? 'Blinds and deafens anyone looking at it — for a long time.' : 'Fire at a wall or roof and get reeled in. 3 charges; each one comes back after 30 s.',
        keyHint: t === 'grapple' ? 'X' : 'G',
      })),
    ];
    const itemTile = (it: (typeof items)[number]) =>
      `<div class="inv-tile2 item${it.n ? '' : ' none'}${this.invSel === it.key ? ' sel' : ''}" data-sel="${it.key}" style="--c:${it.color}">`
      + `<span class="orb"></span><small>${it.name.split(' ')[0]}</small><em>${it.n}</em></div>`;

    let detail = '';
    if (typeof this.invSel === 'number') {
      const i = this.invSel, w = p.slots[i];
      if (!w) detail = `<div class="inv-detail empty"><h4>Slot ${i + 1}</h4><p>Empty — pick up a gun with <kbd>F</kbd>.</p></div>`;
      else {
        const d = w.def, dmg = d.damage * d.pellets * w.rarity.mult;
        // Kit comes with the rarity: a better colour means more of these slots filled.
        const atts = ATT_KINDS.filter((a) => a !== 'scope' && canAttach(d, a)).map((a) => {
          const info = ATTACHMENTS[a], c = hex(info.color);
          if (!w.att[a]) return `<div class="inv-att off"><b>${info.name}</b><small>Needs a better rarity</small></div>`;
          return `<div class="inv-att" style="border-color:${c}"><b style="color:${c}">${info.name}</b><small>${info.desc}</small></div>`;
        }).join('');
        detail = `<div class="inv-detail" style="--c:${w.rarity.css}"><div class="inv-rarity">${w.rarity.name}</div><h4>${d.name}</h4>`
          + `<div class="inv-big r${w.rarity.tier}">${gunIcon(d.id)}</div>`
          + bar('Damage', dmg, top.dmg, d.pellets > 1 ? `${Math.round(d.damage * w.rarity.mult)}×${d.pellets}` : String(Math.round(dmg)))
          + bar('Fire rate', d.rpm, top.rpm, `${d.rpm}`)
          + bar('Magazine', magSize(w), top.mag, `${w.mag}/${magSize(w)}`)
          + bar('Range', d.range, top.range, `${d.range}m`)
          + `<div class="inv-ammo-line">${AMMO_INFO[d.ammo].name}: <b>${p.ammo[d.ammo]}</b> spare</div>`
          + `<div class="inv-atts">${atts || '<small>This gun takes no attachments</small>'}<small>Grey: none · Blue: compensator · Purple: + grip · Gold: fully kitted</small></div>`
          + (p.slots[0] || p.slots[1] ? `<div class="inv-swap"><button data-swap="1">⇄ Swap slots</button></div>` : '')
          + `</div>`;
      }
    } else {
      const it = items.find((x) => x.key === this.invSel) ?? items[0];
      detail = `<div class="inv-detail" style="--c:${it.color}"><div class="inv-rarity">Item</div><h4>${it.name}</h4>`
        + `<div class="inv-big item" style="--c:${it.color}"><span class="orb"></span></div>`
        + `<p>${it.desc}</p><div class="inv-ammo-line">Carrying <b>${it.n}</b> · use with <kbd>${it.keyHint}</kbd></div></div>`;
    }

    const ammo = (Object.keys(AMMO_INFO) as AmmoType[])
      .map((a) => `<span class="${p.ammo[a] ? '' : 'none'}"><i style="background:${hex(AMMO_INFO[a].color)}"></i>${AMMO_INFO[a].name}<b>${p.ammo[a]}</b></span>`).join('');
    const html = `<div class="inv-panel fn"><div class="inv-head"><h2>Inventory</h2><div class="inv-ammo">${ammo}</div></div>`
      + `<div class="inv-body"><div class="inv-left">`
      + `<h3>Weapons <small>drag to swap</small></h3><div class="inv-bar">${gunTile(0)}${gunTile(1)}</div>`
      + `<h3>Items</h3><div class="inv-bar items">${items.map(itemTile).join('')}</div>`
      + `<div class="inv-hint"><kbd>TAB</kbd> close · keep moving with WASD</div></div>`
      + detail + `</div></div>`;
    this.setHtml(this.invEl, 'inv', html);
  }

  private wheelEl: HTMLDivElement | null = null;

  /** Hold G: three big slices (frag, smoke, flash) round the crosshair; move the mouse to pick one. */
  private updateWheel() {
    const g = this.game, w = g.weapons.wheel, p = g.player;
    if (!this.wheelEl) {
      const el = (this.wheelEl = document.createElement('div'));
      el.id = 'nade-wheel';
      const R = 210, r0 = 78, slice = (a: number) => {
        const a0 = a - Math.PI / 3 + 0.04, a1 = a + Math.PI / 3 - 0.04;
        const pt = (rr: number, t: number) => `${(R + Math.cos(t) * rr).toFixed(1)} ${(R + Math.sin(t) * rr).toFixed(1)}`;
        return `M ${pt(r0, a0)} L ${pt(R - 4, a0)} A ${R - 4} ${R - 4} 0 0 1 ${pt(R - 4, a1)} L ${pt(r0, a1)} A ${r0} ${r0} 0 0 0 ${pt(r0, a0)} Z`;
      };
      el.innerHTML = `<svg viewBox="0 0 420 420">${WHEEL_SLOTS.map(([k, a]) => `<path data-k="${k}" d="${slice(a)}"/>`).join('')}</svg>`
        + WHEEL_SLOTS.map(([k, a]) => {
          const c = '#' + (THROWABLES[k].color | 0x303030).toString(16).padStart(6, '0');
          return `<div class="nw-item" data-k="${k}" style="left:${50 + Math.cos(a) * 34}%;top:${50 + Math.sin(a) * 34}%"><i style="background:${c}"></i><b>${THROWABLES[k].name.toUpperCase()}</b><em></em></div>`;
        }).join('')
        + '<div class="nw-center"><small>GRENADE</small><b></b></div><div class="nw-dot"></div>';
      document.getElementById('hud')!.appendChild(el);
    }
    const el = this.wheelEl;
    el.classList.toggle('open', w.open);
    if (!w.open) return;
    const key = `${w.sel}|${p.throwables.frag}|${p.throwables.smoke}|${p.throwables.flash}`;
    if (el.dataset.key !== key) {
      el.dataset.key = key;
      el.querySelectorAll<HTMLElement>('[data-k]').forEach((n) => {
        const k = n.dataset.k as ThrowKind;
        n.classList.toggle('sel', k === w.sel);
        n.classList.toggle('none', !p.throwables[k]);
        const em = n.querySelector('em');
        if (em) em.textContent = `× ${p.throwables[k]}`;
      });
      el.querySelector('.nw-center b')!.textContent = THROWABLES[w.sel].name.toUpperCase();
    }
    (el.querySelector('.nw-dot') as HTMLElement).style.transform = `translate(${w.x.toFixed(0)}px, ${w.y.toFixed(0)}px)`;
  }

  toggleBigMap() {
    this.bigMapOpen = !this.bigMapOpen;
    this.bigmap.classList.toggle('open', this.bigMapOpen);
  }

  private bossEl: HTMLDivElement | null = null;

  /** The boss you're fighting: name, title and a big health bar across the top of the screen. */
  private updateBossBar() {
    const g = this.game, p = g.player;
    let boss: Bot | null = null, bd = Infinity;
    if (p.alive && !g.arena) {
      for (const b of g.bots.bots) {
        const s = b.boss;
        if (!s || !b.alive) continue;
        const d = b.body.pos.distanceTo(p.body.pos);
        if (d < 110 && (b.target === p || s.hurtByYou < 8 || d < 35) && d < bd) {
          bd = d;
          boss = b;
        }
      }
    }
    if (!this.bossEl) {
      const el = (this.bossEl = document.createElement('div'));
      el.id = 'boss-bar';
      el.innerHTML = '<div class="bb-name"><b></b><small></small></div><div class="bb-bar"><i class="bb-lag"></i><i class="bb-hp"></i></div><div class="bb-gun"></div>';
      document.getElementById('hud')!.appendChild(el);
    }
    const el = this.bossEl;
    el.classList.toggle('show', !!boss);
    if (!boss) return;
    const s = boss.boss!, k = clamp(boss.health / s.maxHealth, 0, 1);
    if (el.dataset.id !== s.def.id) {
      el.dataset.id = s.def.id;
      el.querySelector('.bb-name b')!.textContent = boss.name.toUpperCase();
      el.querySelector('.bb-name small')!.textContent = s.def.title;
      el.querySelector('.bb-gun')!.textContent = `Drops: Mythic ${boss.weapon.def.name}`;
      el.style.setProperty('--boss', s.def.color);
    }
    (el.querySelector('.bb-hp') as HTMLElement).style.width = `${(k * 100).toFixed(1)}%`;
    (el.querySelector('.bb-lag') as HTMLElement).style.width = `${(k * 100).toFixed(1)}%`;
  }

  update(dt: number) {
    const g = this.game, p = g.player, w = p.weapon, wpn = g.weapons;
    this.updateMarks(dt);
    this.updateBossBar();
    const onFoot = p.mode === 'ground';

    // Vitals
    const armor = p.armor;
    this.armorFills.forEach((f, i) => {
      const segVal = Math.max(0, Math.min(50, armor - i * 50));
      f.style.width = `${(segVal / 50) * 100}%`;
    });
    const hp = Math.max(0, p.health);
    this.healthFill.style.width = `${hp}%`;
    this.healthGhost.style.width = `${hp}%`;
    this.healthFill.classList.toggle('low', hp < 35);
    this.setText(this.healthNum, 'hp', String(Math.ceil(hp)));
    this.setText($('plates'), 'plates', String(p.plates));
    this.setText($('medkits'), 'medkits', String(p.medkits));

    // Weapon
    if (w) {
      this.setText($('mag'), 'mag', String(w.mag));
      $('mag').classList.toggle('low', w.mag <= Math.ceil(w.def.mag * 0.25) && w.def.mag > 2);
      this.setText($('reserve'), 'reserve', `/ ${p.ammo[w.def.ammo]}`);
      const atts = ATT_KINDS.filter((a) => a !== 'scope' && w.att[a])
        .map((a) => `<i class="att" style="background:#${ATTACHMENTS[a].color.toString(16).padStart(6, '0')}" title="${ATTACHMENTS[a].name}"></i>`).join('');
      $('wname').style.setProperty('--rar', w.rarity.css);
      this.setHtml($('wname'), 'wname', `<span style="color:${w.rarity.css}">${w.rarity.name.toUpperCase()}</span> ${w.def.name.toUpperCase()} ${atts}`);
    } else {
      this.setText($('mag'), 'mag', '—');
      this.setText($('reserve'), 'reserve', '');
      this.setText($('wname'), 'wname', p.unarmed ? 'HANDS · RUNNING FAST' : 'UNARMED');
    }
    // Fortnite-style tiles: the gun's silhouette on its rarity colour, rounds left in the corner.
    p.slots.forEach((s, i) => {
      const el = this.slotEls[i];
      const cls = `slot${s ? ' r' + s.rarity.tier : ' empty'}${i === p.active && !p.unarmed ? ' active' : ''}`;
      if (el.className !== cls) el.className = cls;
      this.setHtml(el, `slot${i}`, `<b>${i + 1}</b>${s ? gunIcon(s.def.id) + `<em>${s.mag}</em>` : ''}`);
    });
    const hands = this.slotEls[2];
    if (hands) {
      hands.classList.toggle('active', p.unarmed);
      this.setHtml(hands, 'slot2', `<b>3</b>${FIST_ICON}`);
    }

    // Grenades
    const th = (['frag', 'smoke', 'flash'] as ThrowKind[]).map((t) => {
      const n = p.throwables[t], sel = t === p.throwSel;
      const c = '#' + (THROWABLES[t].color | 0x303030).toString(16).padStart(6, '0');
      return `<span class="${sel ? 'sel' : ''}${n ? '' : ' none'}"><i style="background:${c}"></i>${THROWABLES[t].name.split(' ')[0]} <b>${n}</b></span>`;
    }).join('');
    const hook = p.hookOwned || p.throwables.grapple ? `<span class="${p.throwables.grapple ? '' : 'none'}"><i style="background:#3f9ae8"></i>Hook <b>${p.throwables.grapple}/${HOOK_CHARGES}</b>${p.hookOwned && p.throwables.grapple < HOOK_CHARGES ? ` <small>+1 in ${Math.ceil(HOOK_RECHARGE - p.hookCharge)}s</small>` : ''} <kbd>X</kbd></span>` : '';
    this.setHtml(this.throwEl, 'throw', `${th}${hook}<em><kbd>G</kbd> tap: ready · hold: wheel</em>`);
    this.updateWheel();

    // Flash / armor crack
    this.flashT = Math.max(0, this.flashT - dt);
    this.flashEl.style.opacity = String(Math.min(1, this.flashT / 2));
    this.crackT = Math.max(0, this.crackT - dt);
    this.crackEl.style.opacity = String(Math.min(1, this.crackT * 3));
    this.crackEl.style.transform = `translate(-50%, -50%) scale(${1 + (0.45 - this.crackT) * 0.8})`;

    this.updateTeam();

    // Crosshair
    // Always shown, fixed size, dead centre (only the sniper scope's own reticle replaces it).
    const scoped = w?.def.id === 'sniper' && wpn.adsAmount > 0.85;
    const armed = (onFoot && !p.swimming) || p.mode === 'zipline';
    // Aiming down sights uses the gun's own sights / red dot instead.
    this.crosshair.style.display = !p.alive || (scoped && armed) || (w && wpn.adsAmount > 0.45) ? 'none' : '';
    // The lines sit where your shots can actually land: they open up with bloom and close as you aim.
    const spread = w && !p.unarmed ? wpn.currentSpread(p) : 0;
    const px = (Math.tan(spread) / Math.tan(((g.camera.fov * Math.PI) / 180) / 2)) * (innerHeight / 2);
    this.chGap = damp(this.chGap, clamp(3 + px, 4, 70), 18, dt);
    this.crosshair.style.setProperty('--gap', `${this.chGap.toFixed(1)}px`);
    this.scope.style.display = scoped && armed ? 'block' : 'none';
    this.updateAmmoArc(w && armed && !scoped && !p.unarmed ? w : null);
    if (this.invOpen) this.renderInventory();

    this.hitTime -= dt;
    this.hitmarker.style.opacity = this.hitTime > 0 ? '1' : '0';

    // Damage numbers
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i];
      n.life -= dt;
      n.pos.y += dt * 0.5;
      const v = tmp.copy(n.pos).project(g.camera);
      if (n.life <= 0 || v.z > 1) {
        n.el.remove();
        this.numbers.splice(i, 1);
        continue;
      }
      n.el.style.left = `${((v.x + 1) / 2) * innerWidth}px`;
      n.el.style.top = `${((1 - v.y) / 2) * innerHeight}px`;
      n.el.style.opacity = String(Math.min(1, n.life * 3));
    }

    // Hurt vignette + storm tint
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    // Low health: dark red edges that close in and pulse like a heartbeat, a shaking health bar.
    const danger = p.alive && p.mode !== 'plane' ? clamp((55 - hp) / 45, 0, 1) : 0;
    const beatT = (performance.now() / 1000) * (1 + danger * 0.6);
    const beat = Math.pow(Math.max(0, Math.sin(beatT * Math.PI * 2)), 6);
    this.vignette.style.opacity = String(Math.min(1, this.hurtFlash * 1.6 + danger * (0.55 + beat * 0.3)));
    this.vignette.style.setProperty('--edge', `${Math.round(55 - danger * 20)}%`);
    this.healthBar.classList.toggle('critical', p.alive && hp < 30);
    if (danger > 0.5 && g.state === 'playing') {
      this.beatCd -= dt;
      if (this.beatCd <= 0) {
        this.beatCd = 1 / (1 + danger * 0.6);
        g.sfx.heartbeat(danger);
      }
    }
    const inStorm = p.mode !== 'plane' && !g.gulagFight && !g.practiceMode && g.zone.isOutside(p.body.pos.x, p.body.pos.z);
    this.stormTint.style.opacity = inStorm ? '1' : '0';

    // Prompts
    const promptText = g.pickupPrompt;
    this.prompt.style.display = promptText ? 'block' : 'none';
    if (promptText) this.setHtml(this.prompt, 'prompt', promptText);

    const ch = wpn.channel;
    const reload = wpn.reloadProgress(p);
    if (ch || reload > 0) {
      this.channel.style.display = 'block';
      const label = ch ? (ch.type === 'medkit' ? 'HEALING' : 'PLATING') : 'RELOADING';
      this.setText(this.channel.querySelector('.label')!, 'chl', label);
      (this.channel.querySelector('.fill') as HTMLElement).style.width = `${(ch ? ch.time / ch.total : reload) * 100}%`;
    } else this.channel.style.display = 'none';

    // Reminders under the crosshair: reload when the mag runs low, heal when you're hurt and safe to.
    let hint = '', hintCls = '';
    if (armed && p.alive && !ch && reload <= 0 && g.state === 'playing' && !g.gulagPrep) {
      if (w && w.def.id !== 'rocket') {
        const cap = magSize(w), reserve = p.ammo[w.def.ammo];
        if (w.mag === 0 && reserve === 0) [hint, hintCls] = ['NO AMMO', 'bad'];
        else if (w.mag <= Math.max(1, Math.floor(cap * 0.25)) && reserve > 0) [hint, hintCls] = ['<kbd>R</kbd> RELOAD', 'warn'];
        else if (reserve === 0 && w.mag <= cap * 0.25) [hint, hintCls] = ['LOW AMMO', 'bad'];
      }
      if (!hint && hp < 50 && p.medkits > 0 && p.killHeal <= 0) [hint, hintCls] = ['<kbd>H</kbd> HEAL', 'heal'];
      else if (!hint && p.armor < 50 && p.plates > 0 && hp >= 50) [hint, hintCls] = ['<kbd>V</kbd> PLATE UP', 'heal'];
    }
    this.ammoHint.style.display = hint ? 'block' : 'none';
    if (hint) {
      this.setHtml(this.ammoHint, 'ahint', hint);
      this.ammoHint.className = hintCls;
    }

    // Drop info
    let drop = '';
    if (p.mode === 'plane') drop = g.plane.overIsland() ? `<kbd>SPACE</kbd> JUMP` : 'APPROACHING THE ISLAND…';
    else if (p.mode === 'freefall') drop = `<div class="alt">${Math.round(p.altitude)}m</div>Hold <kbd>W</kbd> + look down to dive · <kbd>SPACE</kbd> open glider`;
    else if (p.mode === 'glide') drop = `<div class="alt">${Math.round(p.altitude)}m</div>GLIDING${p.altitude > 14 ? ' · <kbd>SPACE</kbd> fold glider' : ''}`;
    else if (p.canRedeploy) drop = `<kbd>SPACE</kbd> OPEN GLIDER`;
    this.dropInfo.style.display = drop ? 'block' : 'none';
    if (drop) this.setHtml(this.dropInfo, 'drop', drop);

    if (g.arena) this.updateArena(dt, g.arena);
    // Zone / counters
    const zoneLabel = g.practiceMode ? 'PRACTICE RANGE — ESC TO LEAVE' : g.gulagFight ? `GULAG · ${Math.max(0, Math.ceil(g.gulagTimer))}s` : g.zone.label();
    this.setText(this.zoneTimer, 'zone', zoneLabel);
    this.zoneTimer.classList.toggle('shrinking', g.zone.state === 'shrinking');
    const here = p.mode === 'plane' || g.gulagFight ? null : g.map.poiAt(p.body.pos.x, p.body.pos.z);
    this.setText(this.locationEl, 'loc', here ? here.name.toUpperCase() : '');
    this.locationEl.style.display = here ? 'block' : 'none';
    if (!g.arena) this.setText($('alive'), 'alive', String(g.aliveCount));
    this.setText($('kills'), 'kills', String(p.kills));

    this.announceTime -= dt;
    this.announceEl.style.opacity = this.announceTime > 0 ? '1' : '0';

    // Vehicle
    const v = g.driving;
    this.vehicleEl.style.display = v ? 'block' : 'none';
    if (v) {
      const kmh = Math.round(Math.hypot(v.body.vel.x, v.body.vel.z) * 3.6);
      this.setHtml(this.vehicleEl, 'veh', `<div class="vname">${v.spec.name.toUpperCase()}</div><div class="speed">${kmh}<span>KM/H</span></div>
        <div class="vbar"><div style="width:${(v.health / v.spec.health) * 100}%"></div></div>
        <div class="vhint"><kbd>SPACE</kbd> Drift &nbsp;<kbd>SHIFT</kbd> Boost &nbsp;<kbd>E</kbd> Exit</div>`);
    }

    // FPS
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fpsEl.textContent = `${Math.round(this.fpsFrames / this.fpsTime)} FPS`;
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }

    // Maps and compass redraw at ~20 Hz; that's plenty and saves canvas work every frame.
    this.mapTimer -= dt;
    if (this.mapTimer <= 0) {
      this.mapTimer = 0.05;
      this.drawCompass();
      this.drawMinimap();
      if (this.bigMapOpen) this.drawBigMap();
    }
  }

  /** Arena: score bar, respawn banner, scoreboard, and deaths in place of the alive count. */
  private updateArena(dt: number, a: Arena) {
    const g = this.game, p = g.player;
    this.zoneTimer.style.display = 'none';
    this.arenaBar.style.display = 'flex';
    const t = Math.max(0, Math.ceil(a.timeLeft)), clock = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    let html: string;
    if (a.kind === 'tdm') {
      const mine = p.team === 1 ? 1 : 0;
      const side = (team: number) => {
        const pct = Math.min(100, (a.teamScore[team] / a.rules.scoreTo) * 100);
        return `<div class="ab-team t${team}${team === mine ? ' mine' : ''}"><span>${TEAM_NAMES[team]}${team === mine ? ' · YOU' : ''}</span><b>${a.teamScore[team]}</b><i style="width:${pct}%"></i></div>`;
      };
      html = `${side(0)}<div class="ab-clock">${clock}<small>FIRST TO ${a.rules.scoreTo}</small></div>${side(1)}`;
    } else {
      const lead = a.leader(), leadMe = lead === p;
      html = `<div class="ab-team mine"><span>YOU</span><b>${p.kills}</b><i style="width:${Math.min(100, (p.kills / a.rules.scoreTo) * 100)}%"></i></div>`
        + `<div class="ab-clock">${clock}<small>FIRST TO ${a.rules.scoreTo}</small></div>`
        + `<div class="ab-team lead"><span>${leadMe ? 'YOU LEAD' : 'LEADER · ' + escapeHtml(lead?.name ?? '—').toUpperCase()}</span><b>${lead?.kills ?? 0}</b><i style="width:${Math.min(100, ((lead?.kills ?? 0) / a.rules.scoreTo) * 100)}%"></i></div>`;
    }
    this.setHtml(this.arenaBar, 'abar', html);
    this.setText($('alive'), 'alive', String(a.deaths.get(p) ?? 0));
    this.setText($('alive-label'), 'alivel', 'DEATHS');
    // Respawn countdown
    const dead = !p.alive && !a.over;
    this.respawnEl.style.display = dead ? 'block' : 'none';
    if (dead) this.setHtml(this.respawnEl, 'resp', `<div class="rs-by">ELIMINATED BY <b>${escapeHtml(a.killedBy.toUpperCase())}</b></div><div class="rs-in">RESPAWNING IN <b>${Math.max(1, Math.ceil(a.respawnIn))}</b></div>`);
    // Scoreboard (hold Tab, or while you wait to respawn)
    const show = (this.scoreboardHeld || dead) && !a.over;
    this.scoreEl.style.display = show ? 'block' : 'none';
    this.scoreTimer -= dt;
    if (show && this.scoreTimer <= 0) {
      this.scoreTimer = 0.25;
      this.setHtml(this.scoreEl, 'sb', this.scoreboardHtml(a));
    }
  }

  private scoreboardHtml(a: Arena) {
    const rows = a.scoreboard();
    const row = (r: (typeof rows)[number], i: number) =>
      `<tr class="${r.me ? 'me' : ''}${r.c.alive ? '' : ' dead'}"><td>${i + 1}</td><td>${a.kind === 'tdm' ? `<i style="background:${TEAM_CSS[r.team === 1 ? 1 : 0]}"></i>` : ''}${escapeHtml(r.name)}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${(r.kills / Math.max(1, r.deaths)).toFixed(1)}</td></tr>`;
    const head = '<tr><th>#</th><th>PLAYER</th><th>K</th><th>D</th><th>K/D</th></tr>';
    if (a.kind === 'tdm') {
      const table = (t: number) => `<div class="sb-team"><h4 style="color:${TEAM_CSS[t]}">${TEAM_NAMES[t]} <b>${a.teamScore[t]}</b></h4><table>${head}${rows.filter((r) => (r.team === 1 ? 1 : 0) === t).map(row).join('')}</table></div>`;
      return `<div class="sb-cols">${table(0)}${table(1)}</div>`;
    }
    return `<div class="sb-team"><h4>FREE-FOR-ALL</h4><table>${head}${rows.map(row).join('')}</table></div>`;
  }

  /** Arena results: win/loss, your line, and the full scoreboard. */
  showArenaEnd(a: Arena, xp?: XpReport) {
    const res = a.result(), g = this.game, title = $('end-title');
    title.textContent = res > 0 ? 'VICTORY' : res < 0 ? 'DEFEAT' : 'DRAW';
    title.classList.toggle('win', res > 0);
    const lead = a.leader();
    $('end-sub').textContent = a.kind === 'tdm'
      ? `${TEAM_NAMES[0]} ${a.teamScore[0]} – ${a.teamScore[1]} ${TEAM_NAMES[1]}`
      : res > 0 ? `You won with ${g.player.kills} kills` : `${lead?.name ?? '—'} won with ${lead?.kills ?? 0} kills`;
    const d = a.deaths.get(g.player) ?? 0;
    $('end-stats').innerHTML = `
      <div><b>${g.player.kills}</b><span>KILLS</span></div>
      <div><b>${d}</b><span>DEATHS</span></div>
      <div><b>${(g.player.kills / Math.max(1, d)).toFixed(2)}</b><span>K/D</span></div>`;
    this.showEnd(res > 0, a.placement(), g.player.kills, null, g.matchTime, xp, true);
    const board = el('end-board', $('end-stats').parentElement!);
    board.innerHTML = this.scoreboardHtml(a);
    $('end-stats').after(board);
    this.scoreEl.style.display = 'none';
    this.respawnEl.style.display = 'none';
    $('again-btn').textContent = a.online ? 'BACK TO LOBBY' : 'PLAY AGAIN';
  }

  /** Squad panel (health bars) and floating names over your teammates. */
  private updateTeam() {
    const g = this.game, mates = g.bots.mates;
    this.teamEl.style.display = mates.length ? 'block' : 'none';
    if (!mates.length) return;
    const html = mates.map((b) => {
      const hp = b.alive ? Math.min(100, Math.max(0, Math.round(b.health))) : 0, ar = b.alive ? Math.min(100, Math.max(0, Math.round(b.armor))) : 0;
      return `<div class="mate${b.alive ? '' : ' dead'}"><span>${escapeHtml(b.name)}</span><div class="bar"><i class="a" style="width:${ar}%"></i></div><div class="bar"><i style="width:${hp}%"></i></div></div>`;
    }).join('');
    this.setHtml(this.teamEl, 'team', html);
    const cam = g.camera;
    for (const b of mates) {
      let tag = this.plates.get(b);
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'nameplate';
        tag.textContent = b.name;
        this.platesEl.appendChild(tag);
        this.plates.set(b, tag);
      }
      const v = tmp.set(b.body.pos.x, b.body.pos.y + 2.25, b.body.pos.z).project(cam);
      const show = b.alive && b.mode !== 'plane' && g.player.mode !== 'plane' && v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      tag.style.display = show ? 'block' : 'none';
      if (show) {
        tag.style.left = `${((v.x + 1) / 2) * innerWidth}px`;
        tag.style.top = `${((1 - v.y) / 2) * innerHeight}px`;
      }
    }
  }

  private drawCompass() {
    const cv = this.compass, ctx = cv.getContext('2d')!;
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(12,16,24,0.55)';
    ctx.fillRect(0, 0, W, H - 8);
    const heading = ((-this.game.player.yaw * 180) / Math.PI % 360 + 360) % 360;
    const span = 120, pxPerDeg = W / span;
    ctx.textAlign = 'center';
    ctx.font = '600 15px Rajdhani, sans-serif';
    const labels: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let d = Math.floor(heading - span / 2); d <= heading + span / 2; d++) {
      const nd = ((d % 360) + 360) % 360;
      if (nd % 15 !== 0) continue;
      const x = W / 2 + (d - heading) * pxPerDeg;
      const label = labels[nd];
      ctx.fillStyle = label ? (nd === 0 ? '#ffcf3a' : '#fff') : 'rgba(255,255,255,0.6)';
      if (label) ctx.fillText(label, x, 21);
      else {
        ctx.fillRect(x - 0.5, 8, 1, 10);
      }
    }
    ctx.fillStyle = '#ffcf3a';
    ctx.beginPath();
    ctx.moveTo(W / 2 - 5, H);
    ctx.lineTo(W / 2 + 5, H);
    ctx.lineTo(W / 2, H - 7);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '700 12px Rajdhani, sans-serif';
    ctx.fillText(String(Math.round(heading) % 360), W / 2, H - 9 + 0);
  }

  /** Draws the map (world region [cx±view/2, cz±view/2]) into a canvas, with zone and player overlays. */
  private drawMapView(cv: HTMLCanvasElement, cx: number, cz: number, view: number, full: boolean) {
    const g = this.game, ctx = cv.getContext('2d')!;
    if (g.arena) return this.drawArenaView(cv, full);
    const N = cv.width, half = CONFIG.mapSize / 2;
    const img = g.map.mapCanvas, ik = img.width / CONFIG.mapSize;
    const k = N / view;
    const sx = (x: number) => (x - cx) * k + N / 2;
    const sz = (z: number) => (z - cz) * k + N / 2;
    ctx.fillStyle = '#2f8fcf';
    ctx.fillRect(0, 0, N, N);
    ctx.drawImage(img, (cx - view / 2 + half) * ik, (cz - view / 2 + half) * ik, view * ik, view * ik, 0, 0, N, N);

    const z = g.zone;
    // Storm fill (outside current circle)
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, N, N);
    ctx.arc(sx(z.center.x), sz(z.center.y), Math.max(0, z.radius * k), 0, Math.PI * 2, true);
    ctx.fillStyle = DUST_STORM ? 'rgba(170,105,45,0.42)' : 'rgba(140,60,230,0.38)';
    ctx.fill('evenodd');
    ctx.restore();
    ctx.lineWidth = 2;
    ctx.strokeStyle = DUST_STORM ? 'rgba(255,190,110,0.95)' : 'rgba(214,140,255,0.95)';
    ctx.beginPath();
    ctx.arc(sx(z.center.x), sz(z.center.y), Math.max(0, z.radius * k), 0, Math.PI * 2);
    ctx.stroke();
    if (z.state !== 'closed') {
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.arc(sx(z.next.x), sz(z.next.y), Math.max(0, z.nextR * k), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Plane path
    const pl = g.plane;
    if (pl.active) {
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.setLineDash([3, 6]);
      ctx.beginPath();
      ctx.moveTo(sx(pl.start.x), sz(pl.start.z));
      ctx.lineTo(sx(pl.end.x), sz(pl.end.z));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // The train.
    if (g.train) {
      for (const c of g.train.cars) {
        const x = sx(c.pos.x), y = sz(c.pos.z);
        if (x < -20 || y < -20 || x > N + 20 || y > N + 20) continue;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-c.yaw);
        const L = Math.max(4, c.len * k), Wd = Math.max(2.5, 3.6 * k);
        ctx.fillStyle = c.loco ? '#141416' : '#a8382a';
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1;
        ctx.fillRect(-L / 2, -Wd / 2, L, Wd);
        ctx.strokeRect(-L / 2, -Wd / 2, L, Wd);
        ctx.restore();
      }
    }

    // Admin ESP: every enemy on the map.
    if (cheatOn('esp')) {
      for (const c of g.combatants) {
        if (!g.cheats.isEnemy(c)) continue;
        const x = sx(c.body.pos.x), y = sz(c.body.pos.z);
        if (x < -5 || y < -5 || x > N + 5 || y > N + 5) continue;
        ctx.fillStyle = '#ff3b30';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, full ? 3.5 : 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // Vehicles, launch pads and supply drops
    const iconScale = full ? 1 : 1.2;
    for (const veh of g.vehicles) {
      if (!veh.alive) continue;
      const x = sx(veh.body.pos.x), y = sz(veh.body.pos.z);
      if (x < -5 || y < -5 || x > N + 5 || y > N + 5) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-veh.yaw);
      ctx.fillStyle = veh.hasDriver ? '#ffcf3a' : '#e8eef4';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 1;
      ctx.fillRect(-2.5 * iconScale, -4 * iconScale, 5 * iconScale, 8 * iconScale);
      ctx.strokeRect(-2.5 * iconScale, -4 * iconScale, 5 * iconScale, 8 * iconScale);
      ctx.restore();
    }
    if (full) {
      ctx.fillStyle = '#3ff0ff';
      for (const pad of g.features.pads) {
        ctx.beginPath();
        ctx.arc(sx(pad.pos.x), sz(pad.pos.z), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const pulse = 0.6 + Math.sin(performance.now() / 180) * 0.4;
    for (const d of g.features.drops) {
      const x = sx(d.chest.pos.x), y = sz(d.chest.pos.z);
      ctx.fillStyle = `rgba(90,180,255,${pulse})`;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.fillRect(x - 6, y - 6, 12, 12);
      ctx.strokeRect(x - 6, y - 6, 12, 12);
    }

    // Bosses: a crown on their home, in their colour.
    if (!g.arena) {
      for (const b of g.bots.bots) {
        if (!b.boss || !b.alive) continue;
        const x = sx(b.boss.home.x), y = sz(b.boss.home.z), s = full ? 1.3 : 1;
        if (x < -10 || y < -10 || x > N + 10 || y > N + 10) continue;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(s, s);
        ctx.fillStyle = b.boss.def.color;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-8, 5);
        ctx.lineTo(-8, -4);
        ctx.lineTo(-4, 0);
        ctx.lineTo(0, -7);
        ctx.lineTo(4, 0);
        ctx.lineTo(8, -4);
        ctx.lineTo(8, 5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        if (full) {
          ctx.font = 'bold 11px sans-serif';
          ctx.textAlign = 'center';
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(0,0,0,0.8)';
          ctx.strokeText(b.name, x, y + 20);
          ctx.fillStyle = b.boss.def.color;
          ctx.fillText(b.name, x, y + 20);
        }
      }
    }

    // Teammates
    for (const b of g.bots.mates) {
      if (!b.alive || b.mode === 'plane') continue;
      ctx.fillStyle = '#4cff6a';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx(b.body.pos.x), sz(b.body.pos.z), full ? 5 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Player arrow
    const p = g.player;
    ctx.save();
    ctx.translate(sx(p.body.pos.x), sz(p.body.pos.z));
    ctx.rotate(-p.yaw);
    ctx.fillStyle = '#ffcf3a';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    const s = full ? 9 : 7;
    ctx.beginPath();
    ctx.moveTo(0, -s * 1.4);
    ctx.lineTo(s, s);
    ctx.lineTo(0, s * 0.4);
    ctx.lineTo(-s, s);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private arenaBoxes: { minX: number; minZ: number; maxX: number; maxZ: number; maxY: number }[] | null = null;

  /** Top-down plan of the arena: floor, cover shaded by height, teammates and you. */
  private drawArenaView(cv: HTMLCanvasElement, full: boolean) {
    const g = this.game, ctx = cv.getContext('2d')!, N = cv.width, m = g.map, A = m.arena, H = m.arenaHalf;
    this.arenaBoxes ??= g.world.queryAABB(A.x - H.x - 2, 0.2, A.z - H.z - 2, A.x + H.x + 2, 12, A.z + H.z + 2, []).map((b) => ({ ...b }));
    const k = (N - 16) / (H.x * 2 + 4);
    const sx = (x: number) => N / 2 + (x - A.x) * k, sz = (z: number) => N / 2 + (z - A.z) * k;
    ctx.fillStyle = '#10141b';
    ctx.fillRect(0, 0, N, N);
    ctx.fillStyle = '#3a3f47';
    ctx.fillRect(sx(A.x - H.x), sz(A.z - H.z), H.x * 2 * k, H.z * 2 * k);
    ctx.fillStyle = 'rgba(75,155,255,0.18)';
    ctx.fillRect(sx(A.x - H.x), sz(A.z - H.z), 12 * k, H.z * 2 * k);
    ctx.fillStyle = 'rgba(255,90,77,0.18)';
    ctx.fillRect(sx(A.x + H.x - 12), sz(A.z - H.z), 12 * k, H.z * 2 * k);
    for (const b of this.arenaBoxes) {
      if (b.maxY < 0.5) continue;
      const hgt = clamp(b.maxY / 8, 0, 1);
      ctx.fillStyle = `rgb(${120 + hgt * 90},${126 + hgt * 90},${136 + hgt * 90})`;
      ctx.fillRect(sx(b.minX), sz(b.minZ), Math.max(1, (b.maxX - b.minX) * k), Math.max(1, (b.maxZ - b.minZ) * k));
    }
    for (const b of g.bots.mates) {
      if (!b.alive) continue;
      ctx.fillStyle = '#4cff6a';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx(b.body.pos.x), sz(b.body.pos.z), full ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    const p = g.player;
    if (!p.alive) return;
    ctx.save();
    ctx.translate(sx(p.body.pos.x), sz(p.body.pos.z));
    ctx.rotate(-p.yaw);
    ctx.fillStyle = '#ffcf3a';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    const s = full ? 10 : 6;
    ctx.beginPath();
    ctx.moveTo(0, -s * 1.4);
    ctx.lineTo(s, s);
    ctx.lineTo(0, s * 0.4);
    ctx.lineTo(-s, s);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private drawMinimap() {
    const p = this.game.player.body.pos;
    const mode = this.game.player.mode;
    const view = mode === 'ground' ? 260 : mode === 'vehicle' ? 420 : 700;
    this.drawMapView(this.minimap, p.x, p.z, view, false);
  }

  private drawBigMap() {
    this.drawMapView(this.bigmapCv, 0, 0, CONFIG.mapSize + 40, true);
  }

  // ---------- menus ----------

  showOverlay(id: 'title' | 'pause' | 'end' | 'options' | 'arena-menu' | null) {
    for (const o of ['title', 'pause', 'end', 'options', 'arena-menu']) $(o)?.classList.toggle('hidden', o !== id);
  }

  showEnd(won: boolean, placement: number, kills: number, killer: string | null, time: number, xp?: XpReport, keepText = false) {
    const title = $('end-title');
    if (!keepText) {
    title.textContent = won ? '#1 VICTORY' : 'ELIMINATED';
    title.classList.toggle('win', won);
    $('end-sub').textContent = won ? 'Last one standing. Legendary.' : killer ? `Eliminated by ${killer}` : 'Taken by the storm';
    const mm = Math.floor(time / 60), ss = String(Math.floor(time % 60)).padStart(2, '0');
    $('end-stats').innerHTML = `
      <div><b>#${placement}</b><span>PLACE</span></div>
      <div><b>${kills}</b><span>KILLS</span></div>
      <div><b>${mm}:${ss}</b><span>SURVIVED</span></div>`;
    }
    const xpEl = el('end-xp', $('end-stats').parentElement!);
    $('end-stats').after(xpEl);
    if (xp) {
      const prof = this.game.profile, lvl = xp.after;
      const a = xpForLevel(lvl), b = xpForLevel(lvl + 1);
      const rows = xp.lines.map(([k, v]) => `<div><span>${k}</span><b>+${v}</b></div>`).join('');
      xpEl.innerHTML = `<div class="xp-rows">${rows}<div class="xp-total"><span>TOTAL XP</span><b>+${xp.total}</b></div></div>
        <div class="xp-level">${xp.after > xp.before ? '<span class="lvlup">LEVEL UP!</span> ' : ''}LEVEL <b>${lvl}</b></div>
        <div class="xp-bar"><i style="width:${Math.round(((prof.data.xp - a) / (b - a)) * 100)}%"></i></div>
        ${xp.unlocked.includes('Eclipse') ? `<div class="xp-unlock">LEVEL 100: the <b>ECLIPSE</b> set is yours — outfit, wrap, glider, trail, back bling and banner are in the Locker</div>` : xp.unlocked.length ? `<div class="xp-unlock">Unlocked camo: <b>${xp.unlocked.join(', ')}</b> — equip it under Wrap in the lobby</div>` : ''}
        ${xp.botShift ? `<div class="xp-bots ${xp.botShift > 0 ? 'up' : 'down'}">${xp.botShift > 0 ? '▲ Bots are getting a little tougher' : '▼ Bots will go a little easier on you'}</div>` : ''}`;
    } else xpEl.innerHTML = this.game.cheats.used ? `<div class="xp-bots down">Admin tools were used: this match isn't saved to your career</div>` : '';
    this.showOverlay('end');
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const tmp = new Vector3();
