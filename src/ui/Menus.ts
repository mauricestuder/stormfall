import { TOY } from '../theme';
import { ACTIONS, keyName } from '../core/Input';
import type { SettingsData } from '../core/Settings';
import type { Game } from '../game/Game';
import { CAMOS, xpForLevel } from '../game/Profile';
import { setViewCamo } from '../weapons/ViewModel';
import { SKINS } from '../game/Skins';
import { skinOf } from '../game/Skins';
import { BACKS, BANNERS, EMOTES, GLIDERS, hex, SHOWCASE, swatch, TRAILS } from '../game/Cosmetics';
import { WEAPONS } from '../weapons/Weapon';
import { CHEAT_LIST, CHEATS } from '../game/Cheats';
import { PAD_LAYOUT, padGlyph } from './Prompts';
import { thumbs } from './Thumbs';

type LobbyTab = 'lobby' | 'locker' | 'arena' | 'career' | 'options' | 'controls';
interface LockerItem { name: string; desc: string; bg: string; icon?: string; locked?: string }
interface LockerCat { id: string; label: string; get: () => number; set: (i: number) => void; items: () => LockerItem[]; thumb?: (i: number) => string }
const EMOTE_ICONS = ['≋', '♫', '⇆', '✦', '✓', '↺', '✺'];
import { ArenaMenu } from './ArenaMenu';

type Row =
  | { section: string }
  | { key: keyof SettingsData; label: string; type: 'range'; min: number; max: number; step: number; fmt: (v: number) => string }
  | { key: keyof SettingsData; label: string; type: 'toggle' }
  | { key: keyof SettingsData; label: string; type: 'select'; options: [string, string][]; num?: boolean };


const pct = (v: number) => `${Math.round(v * 100)}%`;

const ROWS: Row[] = [
  { section: 'Match' },
  { key: 'botDifficulty', label: 'Bot difficulty', type: 'select', options: [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']] },
  { key: 'botCount', label: 'Players in a match (you + bots)', type: 'range', min: 5, max: 149, step: 1, fmt: (v) => String(v + 1) },
  { key: 'squadSize', label: 'Squad size', type: 'select', num: true, options: [['1', 'Solos'], ['2', 'Duos'], ['3', 'Trios'], ['4', 'Quads']] },
  { key: 'timeOfDay', label: 'Time of day', type: 'select', options: [['random', 'Random'], ['day', 'Day'], ['sunset', 'Sunset'], ['night', 'Night']] },
  { key: 'weather', label: 'Weather', type: 'select', options: [['random', 'Random'], ['clear', 'Clear'], ['rain', 'Rain & storms'], ['fog', 'Fog']] },
  {
    key: 'bodyStyle', label: 'Characters', type: 'select',
    options: TOY
      ? [['mix', 'Mix (all the toys)'], ['minifig', 'Mini figures'], ['armyman', 'Plastic army men'], ['teddy', 'Teddy bears'], ['robot', 'Wind-up robots'], ['chubby', 'Chubby (round)'], ['monster', 'Monsters'], ['classic', 'Classic soldiers']]
      : [['mix', 'Mix (all three funny ones)'], ['minifig', 'Mini figures'], ['chubby', 'Chubby (round)'], ['monster', 'Monsters'], ['classic', 'Classic soldiers']],
  },
  { key: 'world', label: 'World (restarts the game)', type: 'select', options: [['toy', 'Toy Box'], ['classic', 'Classic island']] },
  { section: 'Controls' },
  { key: 'sensitivity', label: 'Mouse sensitivity', type: 'range', min: 0.2, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: 'adsSensitivity', label: 'Aiming sensitivity', type: 'range', min: 0.2, max: 1.5, step: 0.05, fmt: pct },
  { key: 'adsSpeed', label: 'Aim-in speed (how fast you raise the sights)', type: 'range', min: 0.25, max: 1.5, step: 0.05, fmt: pct },
  { key: 'invertY', label: 'Invert mouse Y', type: 'toggle' },
  { key: 'autoSprint', label: 'Always sprint', type: 'toggle' },
  { section: 'Controller' },
  { key: 'gamepadSens', label: 'Controller look speed', type: 'range', min: 0.1, max: 5, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: 'gamepadSensY', label: 'Vertical look speed (compared to horizontal)', type: 'range', min: 0.3, max: 2, step: 0.05, fmt: pct },
  { key: 'gamepadCurve', label: 'Stick response', type: 'select', num: true, options: [['1', 'Linear (raw)'], ['2', 'Squared (fine aim)'], ['3', 'Cubic (very fine aim)']] },
  { key: 'gamepadDeadzone', label: 'Stick deadzone', type: 'range', min: 0.03, max: 0.4, step: 0.01, fmt: pct },
  { key: 'gamepadInvertY', label: 'Invert controller Y', type: 'toggle' },
  { key: 'padGlyphs', label: 'Button prompts', type: 'select', options: [['auto', 'Auto (from controller)'], ['xbox', 'Xbox (A B X Y)'], ['ps', 'PlayStation (✕ ○ □ △)']] },
  { key: 'touchControls', label: 'Touch controls', type: 'select', options: [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']] },
  { key: 'toggleAim', label: 'Toggle aim (click once instead of holding)', type: 'toggle' },
  { key: 'toggleCrouch', label: 'Toggle crouch (press once instead of holding)', type: 'toggle' },
  { section: 'Camera' },
  { key: 'screenShake', label: 'Screen shake', type: 'range', min: 0, max: 1.5, step: 0.05, fmt: pct },
  { key: 'cameraTilt', label: 'Camera tilt (slides, ziplines, glider)', type: 'toggle' },
  { key: 'speedFov', label: 'Speed effect (wider view when sprinting)', type: 'toggle' },
  { section: 'Video' },
  { key: 'fov', label: 'Field of view', type: 'range', min: 70, max: 90, step: 1, fmt: (v) => `${v}°` },
  { key: 'brightness', label: 'Brightness', type: 'range', min: 0.6, max: 2.2, step: 0.05, fmt: pct },
  { key: 'quality', label: 'Graphics quality', type: 'select', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
  { key: 'postFx', label: 'Bloom & colour grading', type: 'toggle' },
  { key: 'dynamicRes', label: 'Dynamic resolution', type: 'toggle' },
  { key: 'showFps', label: 'Show FPS', type: 'toggle' },
  { key: 'damageNumbers', label: 'Damage numbers', type: 'toggle' },
  { key: 'damageNumberSize', label: 'Damage number size', type: 'range', min: 0.8, max: 3, step: 0.1, fmt: pct },
  { key: 'visualSound', label: 'Show sound icons (gunfire, footsteps, chests)', type: 'toggle' },
  { section: 'HUD' },
  { key: 'hudScale', label: 'HUD size', type: 'range', min: 0.7, max: 1.3, step: 0.05, fmt: pct },
  { key: 'showMinimap', label: 'Show minimap', type: 'toggle' },
  { key: 'showKillfeed', label: 'Show kill feed', type: 'toggle' },
  { key: 'crosshairStyle', label: 'Crosshair style', type: 'select', options: [['crossdot', 'Cross + dot'], ['cross', 'Cross'], ['dot', 'Dot'], ['circle', 'Circle']] },
  { key: 'crosshairSize', label: 'Crosshair size', type: 'range', min: 0.6, max: 1.8, step: 0.05, fmt: pct },
  {
    key: 'crosshairColor', label: 'Crosshair colour', type: 'select',
    options: [['#ffffff', 'White'], ['#5dff5d', 'Green'], ['#ffe14a', 'Yellow'], ['#4af0ff', 'Cyan'], ['#ff5ad2', 'Pink'], ['#ff4a3d', 'Red']],
  },
  { section: 'Audio' },
  { key: 'volume', label: 'Master volume', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
  { key: 'ambientVolume', label: 'Ambience (storm, rain, birds)', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
  { key: 'musicVolume', label: 'Music volume', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
  { key: 'musicInMatch', label: 'Music during matches', type: 'toggle' },
];

/** Title / pause / options / locker / career overlays. */
export class Menus {
  private returnTo: 'title' | 'pause' = 'title';
  private refreshers: (() => void)[] = [];
  arena!: ArenaMenu;

  constructor(private game: Game) {
    const byId = (id: string) => document.getElementById(id)!;
    game.hud.showOverlay('title');
    const click = (id: string, fn: () => void) => byId(id).addEventListener('click', () => {
      game.sfx.unlock();
      game.sfx.click();
      fn();
    });
    // Lobby: pick a mode, then PLAY. The empty party pads open the Arena to play with friends.
    const MODE_KEY = 'stormfall.mode';
    const MODE_NAMES: Record<string, string> = { br: 'BATTLE ROYALE', arena: 'ARENA', practice: 'PRACTICE RANGE' };
    let mode = 'br';
    try {
      mode = localStorage.getItem(MODE_KEY) ?? 'br';
    } catch {
      /* storage blocked */
    }
    if (!MODE_NAMES[mode]) mode = 'br';
    const setMode = (m: string) => {
      mode = m;
      try {
        localStorage.setItem(MODE_KEY, m);
      } catch {
        /* ignore */
      }
      document.querySelectorAll<HTMLElement>('#title .mode').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
      byId('play-sub').textContent = MODE_NAMES[m];
    };
    setMode(mode);
    document.querySelectorAll<HTMLElement>('#title .mode').forEach((b) => b.addEventListener('click', () => {
      game.sfx.unlock();
      game.sfx.click();
      setMode(b.dataset.mode!);
    }));
    click('play-btn', () => {
      if (mode === 'arena') this.arena.open();
      else if (mode === 'practice') game.practice();
      else game.play();
    });
    document.querySelectorAll<HTMLElement>('#title .party-slot').forEach((b) => b.addEventListener('click', () => {
      game.sfx.unlock();
      game.sfx.click();
      setMode('arena');
      this.arena.open();
    }));
    // Lobby tab: your character centre stage with the party pads and PLAY.
    // Locker tab: outfits, back bling, gliders, wraps, guns, emotes, trails and banners.
    // Career tab: your level and lifetime stats.
    // Options tab: the settings panel moves into the lobby (and back into its dialog for the pause menu).
    const showTab = (this.showTab = (tab: LobbyTab) => {
      for (const t of ['lobby', 'locker', 'arena', 'career', 'options', 'controls']) byId(`${t}-tab`).classList.toggle('on', t === tab);
      byId('title').dataset.tab = tab;
      if (tab === 'career') this.renderCareer();
      if (tab === 'options') {
        this.returnTo = 'title';
        byId('options-host').appendChild(document.querySelector('.options-panel')!);
        this.refreshers.forEach((r) => r());
      }
      if (game.lobby) {
        game.lobby.locker = tab !== 'lobby';
        game.lobby.showGlider = tab === 'locker' && this.cat === 'glider';
      }
    });
    click('lobby-tab', () => showTab('lobby'));
    click('controls-tab', () => showTab('controls'));
    click('rebind-btn', () => {
      showTab('options');
      document.querySelector('#options-list .opt-bind, #options-list .opt-key')?.closest('.opt-row')?.scrollIntoView({ block: 'start' });
    });
    click('locker-tab', () => showTab('locker'));
    click('career-tab', () => showTab('career'));
    click('resume-btn', () => game.resume());
    // The Arena setup lives in its own lobby tab.
    byId('arena-dock').appendChild(document.querySelector('#arena-menu > .panel')!);
    this.arena = new ArenaMenu(game);
    click('arena-tab', () => this.arena.open());
    click('again-btn', () => {
      this.arena.rememberRoom();
      location.reload();
    });
    click('quit-btn', () => {
      this.arena.rememberRoom();
      location.reload();
    });
    click('options-tab', () => showTab('options'));
    click('pause-options-btn', () => this.open('pause'));
    click('options-back', () => (this.returnTo === 'title' ? showTab('lobby') : game.hud.showOverlay(this.returnTo)));
    click('options-reset', () => {
      game.settings.reset();
      this.refreshers.forEach((r) => r());
    });
    click('emote-btn', () => {
      game.sfx.unlock();
      game.lobby?.playEmote();
    });
    addEventListener('keydown', (e) => {
      if (e.code === 'KeyB' && game.state === 'title' && !byId('title').classList.contains('hidden')) game.lobby?.playEmote();
    });
    this.build(byId('options-list'));
    this.buildBinds(byId('options-list'));
    this.buildSecret(byId('options-list'));
    // Controls tab: the controller layout, drawn in the prompts you'd see (Xbox or PlayStation).
    const renderPad = () => {
      const pr = game.prompts, st = pr.style;
      byId('pad-title').textContent = `CONTROLLER · ${st === 'ps' ? 'PLAYSTATION' : 'XBOX'}${game.input.padConnected ? ' · CONNECTED' : ''}`;
      byId('pad-layout').innerHTML = PAD_LAYOUT.map(([b, what]) => {
        const g = padGlyph(b, st);
        return `<div><kbd data-static class="pad ${g.cls}">${g.text}</kbd>${what}</div>`;
      }).join('');
    };
    game.prompts.onChange = renderPad;
    renderPad();
    this.refreshLobby();
  }

  /** Switch the lobby tab (Lobby, Locker, Arena, Career, Options, Controls). */
  showTab: (tab: LobbyTab) => void = () => {};

  open(from: 'title' | 'pause') {
    if (from === 'title') return this.showTab('options');
    this.returnTo = from;
    document.getElementById('options')!.appendChild(document.querySelector('.options-panel')!);
    this.refreshers.forEach((r) => r());
    this.game.hud.showOverlay('options');
  }

  /** Name plate under your character in the lobby (and the locker panel). */
  refreshLobby(locker = true) {
    const p = this.game.profile;
    let name = '';
    try {
      name = localStorage.getItem('stormfall.name') ?? '';
    } catch {
      /* ignore */
    }
    document.getElementById('lobby-player')!.textContent = (name || 'Player').toUpperCase();
    document.getElementById('lobby-sub')!.textContent = `LEVEL ${p.level} · ${(SKINS[p.data.skin] ?? SKINS[0]).name.toUpperCase()}`;
    const ban = BANNERS[p.data.banner] ?? BANNERS[0], bEl = document.getElementById('lobby-banner')!;
    bEl.textContent = ban.icon;
    bEl.style.background = hex(ban.color);
    if (locker) this.renderLocker();
    this.refreshBadge();
  }

  private refreshBadge() {
    const p = this.game.profile;
    const badge = document.getElementById('level-badge');
    if (badge) badge.innerHTML = `LEVEL <b>${p.level}</b><div class="xp-bar"><i style="width:${Math.round(p.levelProgress * 100)}%"></i></div>`;
  }

  // ---------- locker (left side of the lobby) ----------

  private cat = 'outfit';

  private lockerCats(): LockerCat[] {
    const game = this.game, p = game.profile, d = p.data;
    // Level-locked items (the Eclipse set at level 100).
    const lk = (lvl?: number) => (lvl && p.level < lvl ? `LEVEL ${lvl}` : undefined);
    const ds = (desc: string, lvl?: number) => (lk(lvl) ? `${desc} Reach level ${lvl} to unlock.` : desc);
    return [
      {
        id: 'outfit', label: 'OUTFIT', get: () => d.skin, thumb: thumbs.outfit,
        items: () => SKINS.map((s) => ({ name: s.name, desc: ds(s.desc, s.level), locked: lk(s.level), bg: `linear-gradient(135deg, ${hex(s.suit)} 0 55%, ${hex(s.glow || s.trim)} 55% 70%, ${hex(s.suit)} 70%)` })),
        set: (i) => {
          p.setSkin(i);
          game.applySkin();
        },
      },
      { id: 'back', label: 'BACK BLING', get: () => d.back, thumb: thumbs.back, items: () => BACKS.map((x) => ({ name: x.name, desc: ds(x.desc, x.level), locked: lk(x.level), bg: swatch.back(x) })), set: (i) => p.set('back', i) },
      {
        id: 'glider', label: 'GLIDER', get: () => d.glider, thumb: (i) => thumbs.glider(i, skinOf(d.skin).glider),
        items: () => GLIDERS.map((g) => ({ name: g.name, desc: ds(g.desc, g.level), locked: lk(g.level), bg: swatch.glider(g, skinOf(d.skin).glider) })),
        set: (i) => {
          p.set('glider', i);
          game.applySkin();
        },
      },
      {
        id: 'wrap', label: 'WRAP', get: () => d.camo, thumb: (i) => thumbs.gun(SHOWCASE[d.showcase] ?? 'ar', CAMOS[i].color),
        items: () => CAMOS.map((c, i) => ({
          name: c.name, desc: p.camoUnlocked(i) ? 'Weapon camo, on every gun you pick up.' : `Reach level ${c.level} to unlock.`,
          bg: c.color === null ? 'linear-gradient(135deg,#3a3f47,#6b7380)' : hex(c.color), locked: p.camoUnlocked(i) ? undefined : `LEVEL ${c.level}`,
        })),
        set: (i) => {
          p.setCamo(i);
          setViewCamo(p.camoColor);
          game.weapons.view.refresh();
        },
      },
      {
        id: 'weapon', label: 'WEAPON', get: () => d.showcase, thumb: (i) => thumbs.gun(SHOWCASE[i], p.camoColor),
        items: () => SHOWCASE.map((id) => ({ name: WEAPONS[id].name, desc: 'The gun your character shows off in the lobby.', bg: '#141a26' })),
        set: (i) => p.set('showcase', i),
      },
      {
        id: 'emote', label: 'EMOTE', get: () => d.emote,
        items: () => EMOTES.map((e, i) => ({ name: e.name, desc: `${e.desc} Press B or the Emote button to play it.`, bg: '#1a2233', icon: EMOTE_ICONS[i] })),
        set: (i) => {
          p.set('emote', i);
          game.lobby?.playEmote();
        },
      },
      {
        id: 'trail', label: 'TRAIL', get: () => d.trail,
        items: () => TRAILS.map((t) => ({ name: t.name, desc: ds(t.color === null ? t.desc : `${t.desc} Streams from your hands while you skydive.`, t.level), locked: lk(t.level), bg: swatch.trail(t) })),
        set: (i) => p.set('trail', i),
      },
      {
        id: 'banner', label: 'BANNER', get: () => d.banner,
        items: () => BANNERS.map((x) => ({ name: x.name, desc: ds('Shown next to your name.', x.level), locked: lk(x.level), bg: hex(x.color), icon: x.icon })),
        set: (i) => p.set('banner', i),
      },
    ];
  }

  /** Draw the locker panel: category tiles, then the items of the open category. */
  renderLocker() {
    const cats = this.lockerCats(), cur = cats.find((c) => c.id === this.cat) ?? cats[0];
    const tile = (c: LockerCat, it: LockerItem, i: number) => `<i style="background:${c.thumb ? c.thumb(i) : it.bg}">${c.thumb ? '' : it.icon ?? ''}</i>`;
    const catsEl = document.getElementById('lk-cats')!;
    catsEl.innerHTML = '';
    for (const c of cats) {
      const idx = c.items()[c.get()] ? c.get() : 0, it = c.items()[idx];
      const el = document.createElement('button');
      el.className = 'lk-cat' + (c === cur ? ' on' : '');
      el.innerHTML = `${tile(c, it, idx)}<b>${c.label}</b>`;
      el.title = `${c.label}: ${it.name}`;
      el.addEventListener('click', () => {
        this.game.sfx.unlock();
        this.game.sfx.click();
        this.cat = c.id;
        if (this.game.lobby) this.game.lobby.showGlider = c.id === 'glider';
        this.renderLocker();
      });
      catsEl.appendChild(el);
    }
    const items = cur.items(), sel = cur.get();
    document.getElementById('lk-title')!.textContent = `${cur.label} · ${(items[sel] ?? items[0]).name.toUpperCase()}`;
    document.getElementById('lk-desc')!.textContent = (items[sel] ?? items[0]).desc;
    const grid = document.getElementById('lk-grid')!;
    grid.innerHTML = '';
    items.forEach((it, i) => {
      const el = document.createElement('button');
      el.className = 'lk-item' + (i === sel ? ' sel' : '') + (it.locked ? ' locked' : '');
      el.innerHTML = `${tile(cur, it, i)}<b>${it.name}</b><small>${it.locked ?? (i === sel ? 'EQUIPPED' : 'EQUIP')}</small>`;
      el.disabled = !!it.locked;
      el.addEventListener('click', () => {
        this.game.sfx.unlock();
        this.game.sfx.click();
        cur.set(i);
        this.renderLocker();
        this.refreshLobby(false);
      });
      grid.appendChild(el);
    });
  }

  // ---------- career ----------

  private renderCareer() {
    const p = this.game.profile, s = p.data.stats, lvl = p.level;
    const acc = s.shots ? Math.round((s.hits / s.shots) * 100) : 0;
    const hs = s.hits ? Math.round((s.headshots / s.hits) * 100) : 0;
    const kd = (s.kills / Math.max(1, s.deaths)).toFixed(2);
    const h = Math.floor(s.timePlayed / 3600), m = Math.floor((s.timePlayed % 3600) / 60);
    const cell = (v: string | number, k: string) => `<div><b>${v}</b><span>${k}</span></div>`;
    document.getElementById('career-body')!.innerHTML = `
      <div class="xp-level">LEVEL <b>${lvl}</b> · ${p.data.xp - xpForLevel(lvl)} / ${xpForLevel(lvl + 1) - xpForLevel(lvl)} XP</div>
      <div class="xp-bar"><i style="width:${Math.round(p.levelProgress * 100)}%"></i></div>
      <div class="career-grid">
        ${cell(s.matches, 'MATCHES')}${cell(s.wins, 'WINS')}${cell(s.matches ? Math.round((s.wins / s.matches) * 100) + '%' : '—', 'WIN RATE')}
        ${cell(s.top5, 'TOP 5')}${cell(s.kills, 'KILLS')}${cell(kd, 'K/D')}
        ${cell(acc + '%', 'ACCURACY')}${cell(hs + '%', 'HEADSHOT %')}${cell(s.damage, 'DAMAGE')}
        ${cell(s.bestKills, 'BEST GAME')}${cell(`${h}h ${m}m`, 'TIME PLAYED')}${cell(p.data.xp, 'TOTAL XP')}
      </div>`;
  }

  // ---------- options ----------

  private build(list: HTMLElement) {
    const settings = this.game.settings;
    for (const row of ROWS) {
      if ('section' in row) {
        const h = document.createElement('div');
        h.className = 'opt-section';
        h.textContent = row.section;
        list.appendChild(h);
        continue;
      }
      const el = document.createElement('label');
      el.className = 'opt-row';
      const name = document.createElement('span');
      name.textContent = row.label;
      el.appendChild(name);
      const data = settings.data as unknown as Record<string, unknown>;
      if (row.type === 'range') {
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(row.min);
        input.max = String(row.max);
        input.step = String(row.step);
        const val = document.createElement('b');
        const refresh = () => {
          input.value = String(data[row.key]);
          val.textContent = row.fmt(Number(data[row.key]));
        };
        input.addEventListener('input', () => {
          settings.set(row.key, parseFloat(input.value) as never);
          val.textContent = row.fmt(parseFloat(input.value));
        });
        el.append(input, val);
        this.refreshers.push(refresh);
        refresh();
      } else if (row.type === 'toggle') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'opt-toggle';
        const refresh = () => {
          const on = !!data[row.key];
          btn.textContent = on ? 'ON' : 'OFF';
          btn.classList.toggle('on', on);
        };
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          settings.set(row.key, !data[row.key] as never);
          this.game.sfx.click();
          refresh();
        });
        el.appendChild(btn);
        this.refreshers.push(refresh);
        refresh();
      } else {
        const sel = document.createElement('select');
        for (const [v, label] of row.options) {
          const o = document.createElement('option');
          o.value = v;
          o.textContent = label;
          sel.appendChild(o);
        }
        const refresh = () => (sel.value = String(data[row.key]));
        sel.addEventListener('change', () => settings.set(row.key, (row.num ? Number(sel.value) : sel.value) as never));
        el.appendChild(sel);
        this.refreshers.push(refresh);
        refresh();
      }
      list.appendChild(el);
    }
  }

  /** A tiny, barely visible dot under the key bindings: three quick clicks toggle the butterfly knife. */
  private buildSecret(list: HTMLElement) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'opt-secret';
    b.tabIndex = -1;
    b.setAttribute('aria-hidden', 'true');
    let n = 0, last = 0;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const now = performance.now();
      n = now - last < 600 ? n + 1 : 1;
      last = now;
      if (n < 3) return;
      n = 0;
      this.game.sfx.click();
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) refresh();
    });

    const panel = document.createElement('div');
    panel.className = 'admin-panel';
    const title = document.createElement('div');
    title.className = 'opt-section';
    title.textContent = 'Admin';
    const note = document.createElement('div');
    note.className = 'admin-note';
    panel.append(title, note);
    const rows: (() => void)[] = [];
    const toggle = (label: string, hint: string, get: () => boolean, set: (v: boolean) => void) => {
      const r = document.createElement('button');
      r.type = 'button';
      r.className = 'admin-row';
      r.innerHTML = `<span class="admin-l"></span><span class="admin-h"></span><span class="admin-v"></span>`;
      (r.children[0] as HTMLElement).textContent = label;
      (r.children[1] as HTMLElement).textContent = hint;
      const upd = () => {
        const on = get();
        r.classList.toggle('on', on);
        (r.children[2] as HTMLElement).textContent = on ? 'ON' : 'OFF';
      };
      r.addEventListener('click', () => {
        set(!get());
        this.game.sfx.click();
        upd();
      });
      rows.push(upd);
      panel.appendChild(r);
    };
    const p = this.game.profile;
    toggle('Emerald butterfly knife', 'Replaces your fists (key 3), inspect with Y', () => !!p.data.knife, (v) => {
      p.set('knife', v ? 1 : 0);
      this.game.applySkin();
    });
    for (const c of CHEAT_LIST) toggle(c.label, c.hint, () => CHEATS[c.key], (v) => (CHEATS[c.key] = v));
    const tp = document.createElement('button');
    tp.type = 'button';
    tp.className = 'admin-row admin-btn';
    tp.textContent = 'Teleport to the nearest enemy';
    tp.addEventListener('click', () => {
      const ok = this.game.cheats.teleport();
      tp.textContent = ok ? 'Teleported: close Options to see them' : 'Nobody to teleport to (be on foot in a match)';
      setTimeout(() => (tp.textContent = 'Teleport to the nearest enemy'), 2500);
    });
    panel.appendChild(tp);
    const refresh = () => {
      note.textContent = this.game.cheats.allowed ? 'Offline only. Nothing here is saved; it all turns off when you reload.' : 'Switched off in online matches.';
      rows.forEach((u) => u());
    };
    list.append(b, panel);
  }

  /** Key bindings: click a key, press the new one. Taking a key from another action swaps them. */
  private buildBinds(list: HTMLElement) {
    const { settings, input } = this.game;
    const h = document.createElement('div');
    h.className = 'opt-section';
    h.textContent = 'Key bindings';
    list.appendChild(h);
    const buttons: (() => void)[] = [];
    for (const a of ACTIONS) {
      const row = document.createElement('div');
      row.className = 'opt-row';
      const name = document.createElement('span');
      name.textContent = a.label;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'opt-key';
      const current = () => settings.data.binds[a.code] ?? a.code;
      const refresh = () => (btn.textContent = keyName(current()));
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        btn.textContent = 'Press a key…';
        btn.classList.add('wait');
        input.captureKey((code) => {
          btn.classList.remove('wait');
          if (code !== 'Escape') {
            const binds = { ...settings.data.binds };
            const old = current();
            // Whoever had this key gets our old one.
            for (const b of ACTIONS) if (b !== a && (binds[b.code] ?? b.code) === code) binds[b.code] = old;
            binds[a.code] = code;
            settings.set('binds', binds);
          }
          buttons.forEach((r) => r());
        });
      });
      row.append(name, btn);
      list.appendChild(row);
      buttons.push(refresh);
      this.refreshers.push(refresh);
      refresh();
    }
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'secondary small';
    reset.textContent = 'RESET KEYS';
    reset.addEventListener('click', () => {
      settings.resetBinds();
      buttons.forEach((r) => r());
    });
    list.appendChild(reset);
  }
}
