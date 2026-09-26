/** Career progress kept in localStorage: XP, levels, camo unlocks and lifetime stats. */

export interface Stats {
  matches: number;
  wins: number;
  top5: number;
  kills: number;
  deaths: number;
  damage: number;
  shots: number;
  hits: number;
  headshots: number;
  bestKills: number;
  timePlayed: number;
}

export interface ProfileData {
  xp: number;
  camo: number;
  /** Outfit (index into SKINS). */
  skin: number;
  /**
   * Adaptive bot strength, -1 (easier) .. 1 (tougher). Winning nudges it up, losing early nudges it
   * down, so matches stay close whatever the difficulty setting.
   */
  adapt: number;
  /** Other locker picks (indexes into the lists in Cosmetics.ts). */
  back: number;
  glider: number;
  showcase: number;
  emote: number;
  trail: number;
  banner: number;
  /** Melee skin: 0 = fists, 1 = butterfly knife (unlocked by the hidden button in Options). */
  knife: number;
  stats: Stats;
}

export type CosmeticKey = 'skin' | 'back' | 'glider' | 'showcase' | 'emote' | 'trail' | 'banner' | 'knife';

export const CAMOS: { name: string; color: number | null; level: number; accent?: number }[] = [
  { name: 'Factory', color: null, level: 1 },
  { name: 'Woodland', color: 0x4a5d3a, level: 2 },
  { name: 'Desert', color: 0xc2a36b, level: 4 },
  { name: 'Arctic', color: 0xdfe6ea, level: 6 },
  { name: 'Crimson', color: 0x9a2b2b, level: 8 },
  { name: 'Cobalt', color: 0x2c4fa0, level: 10 },
  { name: 'Toxic', color: 0x7ad13a, level: 13 },
  { name: 'Gold', color: 0xd4a63a, level: 16 },
  { name: 'Obsidian', color: 0x1b1b22, level: 20 },
  { name: 'Eclipse', color: 0x0b0b0f, level: 100, accent: 0xffe9b8 },
];

/** Result of one match, fed into XP and stats. */
export interface MatchResult {
  won: boolean;
  placement: number;
  kills: number;
  headshotKills: number;
  damage: number;
  shots: number;
  hits: number;
  headshots: number;
  time: number;
}

const KEY = 'stormfall.profile';

const emptyStats = (): Stats => ({
  matches: 0, wins: 0, top5: 0, kills: 0, deaths: 0, damage: 0, shots: 0, hits: 0, headshots: 0, bestKills: 0, timePlayed: 0,
});

/** Total XP needed to reach `level` (level 1 = 0 XP). Each level costs a bit more than the last. */
export function xpForLevel(level: number) {
  let t = 0;
  for (let l = 1; l < level; l++) t += 800 + l * 200;
  return t;
}

export function levelOf(xp: number) {
  let l = 1;
  while (l < 100 && xp >= xpForLevel(l + 1)) l++;
  return l;
}

export class Profile {
  data: ProfileData;

  constructor() {
    this.data = { xp: 0, camo: 0, skin: 0, adapt: 0, back: 0, glider: 0, showcase: 0, emote: 0, trail: 0, banner: 0, knife: 0, stats: emptyStats() };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw) as Partial<ProfileData>;
        this.data = { ...this.data, ...d, stats: { ...emptyStats(), ...(d.stats ?? {}) } };
      }
    } catch {
      /* storage blocked: play without saving */
    }
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* ignore */
    }
  }

  get level() {
    return levelOf(this.data.xp);
  }

  /** Progress through the current level, 0..1. */
  get levelProgress() {
    const l = this.level, a = xpForLevel(l), b = xpForLevel(l + 1);
    return (this.data.xp - a) / (b - a);
  }

  camoUnlocked(i: number) {
    return this.level >= CAMOS[i].level;
  }

  get camoColor() {
    const c = CAMOS[this.data.camo];
    return c && this.camoUnlocked(this.data.camo) ? c.color : null;
  }

  setCamo(i: number) {
    if (!this.camoUnlocked(i)) return;
    this.data.camo = i;
    this.save();
  }

  setSkin(i: number) {
    this.set('skin', i);
  }

  set(key: CosmeticKey, i: number) {
    this.data[key] = i;
    this.save();
  }

  /**
   * After a battle royale: bots get a little stronger when you do well and a little weaker when you
   * go out early. Returns +1 / -1 / 0 for the results screen.
   */
  private adaptBots(r: MatchResult, field: number) {
    const rank = (r.placement - 1) / Math.max(1, field - 1); // 0 = winner, 1 = first out
    let d = r.won ? 0.22 : rank < 0.2 ? 0.08 : rank > 0.6 ? -0.18 : rank > 0.35 ? -0.08 : 0;
    if (r.kills >= 6) d += 0.06;
    const before = this.data.adapt;
    this.data.adapt = Math.max(-1, Math.min(1, before + d));
    const diff = this.data.adapt - before;
    return Math.abs(diff) < 0.01 ? 0 : diff > 0 ? 1 : -1;
  }

  /** Awards XP for a finished match; returns the itemised breakdown plus level change. */
  finishMatch(r: MatchResult, field = 0) {
    const botShift = field > 1 ? this.adaptBots(r, field) : 0;
    const lines: [string, number][] = [];
    lines.push(['Kills', r.kills * 150]);
    if (r.headshotKills) lines.push(['Headshot kills', r.headshotKills * 50]);
    lines.push(['Damage dealt', Math.round(r.damage / 4)]);
    lines.push(['Time survived', Math.round(r.time)]);
    if (r.placement <= 10) lines.push([`Placed #${r.placement}`, (11 - r.placement) * 60]);
    if (r.won) lines.push(['Victory', 1000]);
    const total = lines.reduce((s, [, v]) => s + v, 0);
    const before = this.level;
    this.data.xp += total;
    const s = this.data.stats;
    s.matches++;
    if (r.won) s.wins++;
    if (r.placement <= 5) s.top5++;
    if (!r.won) s.deaths++;
    s.kills += r.kills;
    s.damage += Math.round(r.damage);
    s.shots += r.shots;
    s.hits += r.hits;
    s.headshots += r.headshots;
    s.bestKills = Math.max(s.bestKills, r.kills);
    s.timePlayed += r.time;
    this.save();
    const after = this.level;
    const unlocked = CAMOS.filter((c) => c.level > before && c.level <= after).map((c) => c.name);
    return { lines, total, before, after, unlocked, botShift };
  }
}
