import { BoxGeometry, CylinderGeometry, Group, Mesh } from 'three';
import { plastic, type LitMat } from '../game/Look';
import { TOY } from '../theme';

export type AmmoType = 'light' | 'heavy' | 'shells' | 'sniper' | 'rocket';

export const AMMO_INFO: Record<AmmoType, { name: string; color: number; pickup: number; max: number }> = {
  light: { name: 'Light Ammo', color: 0xffc04d, pickup: 60, max: 300 },
  heavy: { name: 'Heavy Ammo', color: 0x3fd6a0, pickup: 50, max: 250 },
  shells: { name: 'Shells', color: 0xff5a4d, pickup: 12, max: 48 },
  sniper: { name: 'Sniper Ammo', color: 0x8a8cff, pickup: 10, max: 40 },
  rocket: { name: 'Rockets', color: 0xb0b84a, pickup: 2, max: 6 },
};

export const AMMO_TYPES: AmmoType[] = ['light', 'heavy', 'shells', 'sniper'];

export type WeaponId = 'pistol' | 'smg' | 'ar' | 'shotgun' | 'sniper' | 'lmg' | 'dmr' | 'burst' | 'revolver' | 'rocket';

/** Learnable spray: pitch climbs for `climb` shots then eases; yaw follows a fixed wave plus bias. */
interface RecoilPattern {
  climb: number;
  late: number;
  yawBias: number;
  yawAmp: number;
  yawFreq: number;
  yawPhase: number;
}

export interface WeaponDef {
  id: WeaponId;
  name: string;
  ammo: AmmoType;
  tier: number; // rough strength for bot decisions
  damage: number;
  pellets: number;
  headMult: number;
  rpm: number;
  auto: boolean;
  /** Rounds fired per trigger pull (burst rifles). */
  burst?: number;
  /** Rockets: a slow projectile that explodes instead of a hitscan ray. */
  projectile?: { speed: number; radius: number };
  mag: number;
  reload: number;
  hipSpread: number; // radians
  adsSpread: number;
  bloomPerShot: number;
  maxBloom: number;
  range: number;
  falloffStart: number;
  falloffEnd: number;
  falloffMin: number;
  adsFov: number;
  recoil: number; // camera pitch kick per shot (radians)
  pattern: RecoilPattern;
  botRange: number; // distance bots like to fight at
  modelLength: number;
  bodyColor: number;
  /** A boss's one-of-a-kind gun (Mythic rarity). */
  mythic?: boolean;
}

const pat = (climb: number, late: number, yawBias: number, yawAmp: number, yawFreq: number, yawPhase = 0): RecoilPattern =>
  ({ climb, late, yawBias, yawAmp, yawFreq, yawPhase });

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: {
    id: 'pistol', name: 'P-9 Sidearm', ammo: 'light', tier: 0,
    damage: 21, pellets: 1, headMult: 1.6, rpm: 400, auto: false, mag: 12, reload: 1.3,
    hipSpread: 0.018, adsSpread: 0.005, bloomPerShot: 0.008, maxBloom: 0.04,
    range: 160, falloffStart: 20, falloffEnd: 70, falloffMin: 0.6,
    adsFov: 72, recoil: 0.014, pattern: pat(3, 0.8, 0.05, 0.3, 1.3), botRange: 18, modelLength: 0.28, bodyColor: 0x3a3f47,
  },
  revolver: {
    id: 'revolver', name: 'Magnum Revolver', ammo: 'heavy', tier: 2,
    damage: 48, pellets: 1, headMult: 2.0, rpm: 170, auto: false, mag: 6, reload: 2.6,
    hipSpread: 0.02, adsSpread: 0.003, bloomPerShot: 0.015, maxBloom: 0.05,
    range: 180, falloffStart: 25, falloffEnd: 80, falloffMin: 0.65,
    adsFov: 70, recoil: 0.045, pattern: pat(2, 0.9, 0.1, 0.25, 2.1), botRange: 20, modelLength: 0.34, bodyColor: 0x5a5f66,
  },
  smg: {
    id: 'smg', name: 'Viper SMG', ammo: 'light', tier: 2,
    damage: 16, pellets: 1, headMult: 1.4, rpm: 900, auto: true, mag: 32, reload: 1.9,
    hipSpread: 0.028, adsSpread: 0.011, bloomPerShot: 0.003, maxBloom: 0.04,
    range: 160, falloffStart: 15, falloffEnd: 55, falloffMin: 0.55,
    adsFov: 70, recoil: 0.0055, pattern: pat(8, 0.5, 0, 0.7, 0.7, 0.5), botRange: 14, modelLength: 0.5, bodyColor: 0x2d3440,
  },
  burst: {
    id: 'burst', name: 'Pulse Burst Rifle', ammo: 'light', tier: 3,
    damage: 25, pellets: 1, headMult: 1.5, rpm: 950, auto: false, burst: 3, mag: 27, reload: 2.1,
    hipSpread: 0.03, adsSpread: 0.004, bloomPerShot: 0.004, maxBloom: 0.04,
    range: 260, falloffStart: 35, falloffEnd: 120, falloffMin: 0.7,
    adsFov: 60, recoil: 0.009, pattern: pat(3, 0.6, 0.15, 0.2, 2.1), botRange: 30, modelLength: 0.7, bodyColor: 0x2e3a48,
  },
  ar: {
    id: 'ar', name: 'Striker AR', ammo: 'heavy', tier: 3,
    damage: 22, pellets: 1, headMult: 1.5, rpm: 640, auto: true, mag: 30, reload: 2.2,
    hipSpread: 0.034, adsSpread: 0.0035, bloomPerShot: 0.004, maxBloom: 0.05,
    range: 320, falloffStart: 50, falloffEnd: 160, falloffMin: 0.72,
    adsFov: 58, recoil: 0.0085, pattern: pat(7, 0.45, 0.2, 0.9, 0.42), botRange: 35, modelLength: 0.8, bodyColor: 0x3b3a36,
  },
  lmg: {
    id: 'lmg', name: 'Titan LMG', ammo: 'heavy', tier: 3,
    damage: 23, pellets: 1, headMult: 1.4, rpm: 560, auto: true, mag: 60, reload: 4.4,
    hipSpread: 0.05, adsSpread: 0.0055, bloomPerShot: 0.004, maxBloom: 0.06,
    range: 320, falloffStart: 45, falloffEnd: 150, falloffMin: 0.7,
    adsFov: 60, recoil: 0.0095, pattern: pat(10, 0.35, -0.25, 0.6, 0.3, 1), botRange: 40, modelLength: 0.95, bodyColor: 0x3d4238,
  },
  shotgun: {
    id: 'shotgun', name: 'Breacher Shotgun', ammo: 'shells', tier: 3,
    damage: 11, pellets: 10, headMult: 1.25, rpm: 75, auto: false, mag: 6, reload: 2.8,
    hipSpread: 0.07, adsSpread: 0.055, bloomPerShot: 0, maxBloom: 0,
    range: 70, falloffStart: 7, falloffEnd: 28, falloffMin: 0.25,
    adsFov: 76, recoil: 0.05, pattern: pat(1, 1, 0, 0.2, 1.7), botRange: 7, modelLength: 0.85, bodyColor: 0x4a3526,
  },
  dmr: {
    id: 'dmr', name: 'Warden DMR', ammo: 'sniper', tier: 3,
    damage: 46, pellets: 1, headMult: 1.8, rpm: 260, auto: false, mag: 10, reload: 2.5,
    hipSpread: 0.05, adsSpread: 0.001, bloomPerShot: 0.006, maxBloom: 0.03,
    range: 500, falloffStart: 120, falloffEnd: 300, falloffMin: 0.8,
    adsFov: 40, recoil: 0.028, pattern: pat(4, 0.8, 0.1, 0.3, 1.9), botRange: 60, modelLength: 0.95, bodyColor: 0x4a4538,
  },
  sniper: {
    id: 'sniper', name: 'Longshot Sniper', ammo: 'sniper', tier: 3,
    damage: 105, pellets: 1, headMult: 2.0, rpm: 42, auto: false, mag: 5, reload: 3.0,
    hipSpread: 0.08, adsSpread: 0.0, bloomPerShot: 0, maxBloom: 0,
    range: 650, falloffStart: 650, falloffEnd: 651, falloffMin: 1,
    adsFov: 22, recoil: 0.06, pattern: pat(1, 1, 0, 0.15, 1), botRange: 80, modelLength: 1.1, bodyColor: 0x2c3a2c,
  },
  rocket: {
    id: 'rocket', name: 'Havoc Launcher', ammo: 'rocket', tier: 4,
    damage: 120, pellets: 1, headMult: 1, rpm: 60, auto: false, projectile: { speed: 55, radius: 6.5 }, mag: 1, reload: 3.2,
    hipSpread: 0.012, adsSpread: 0.002, bloomPerShot: 0, maxBloom: 0,
    range: 400, falloffStart: 400, falloffEnd: 401, falloffMin: 1,
    adsFov: 62, recoil: 0.08, pattern: pat(1, 1, 0, 0.1, 1), botRange: 40, modelLength: 1.15, bodyColor: 0x4a5a3a,
  },
};

// Toy Box: every gun is a brightly coloured foam blaster.
if (TOY) {
  const toy: Record<WeaponId, [string, number]> = {
    pistol: ['Dart Pistol', 0x2a7de1], revolver: ['Cap Gun', 0xe8392b], smg: ['Foam SMG', 0x2fb84a], burst: ['Triple-Dart Rifle', 0x8b3fe0],
    ar: ['Foam Blaster AR', 0x2a7de1], lmg: ['Drum Blaster', 0xf5c518], shotgun: ['Splatter Shotgun', 0xff7a1a], dmr: ['Rubber-Band DMR', 0x14b8a6],
    sniper: ['Suction-Cup Sniper', 0xe83e8c], rocket: ['Bottle Rocket', 0xf5c518],
  };
  for (const id of Object.keys(toy) as WeaponId[]) [WEAPONS[id].name, WEAPONS[id].bodyColor] = toy[id];
}

export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];

export interface Rarity {
  name: string;
  color: number;
  css: string;
  mult: number;
  tier: number;
}

export const RARITIES: Rarity[] = [
  { name: 'Common', color: 0xd9d9d9, css: '#d9d9d9', mult: 1.0, tier: 0 },
  { name: 'Rare', color: 0x3a8dff, css: '#4b9bff', mult: 1.08, tier: 1 },
  { name: 'Epic', color: 0xb45cff, css: '#c07aff', mult: 1.16, tier: 2 },
  { name: 'Legendary', color: 0xffb020, css: '#ffc043', mult: 1.25, tier: 3 },
];

/** Only bosses carry these: better than gold. */
export const MYTHIC: Rarity = { name: 'Mythic', color: 0xff3fd0, css: '#ff5ad8', mult: 1.3, tier: 4 };

/**
 * The bosses' guns: each one a souped-up version of a normal gun (same model and ammo, much better stats).
 */
export type MythicId = 'stuffing' | 'windup' | 'marble' | 'cork';
export const MYTHICS: Record<MythicId, WeaponDef> = {
  // Big Ted: a fully automatic shotgun that fires clouds of stuffing.
  stuffing: {
    ...WEAPONS.shotgun, name: 'Stuffing Cannon', mythic: true, tier: 5, auto: true, rpm: 210, mag: 12, reload: 2.4, damage: 12, pellets: 11,
    hipSpread: 0.06, adsSpread: 0.045, falloffEnd: 34, falloffMin: 0.35, bodyColor: 0x8a5a3a,
  },
  // Mecha-Max: a wind-up minigun with a drum you never seem to empty.
  windup: {
    ...WEAPONS.lmg, name: 'Wind-Up Minigun', mythic: true, tier: 5, rpm: 1050, mag: 150, reload: 4.0, damage: 19, hipSpread: 0.04, adsSpread: 0.006,
    bloomPerShot: 0.002, maxBloom: 0.035, recoil: 0.006, bodyColor: 0xc0c6ce,
  },
  // Sergeant Plastic: a marble launcher, four rockets to a load.
  marble: {
    ...WEAPONS.rocket, name: 'Marble Mortar', mythic: true, tier: 5, rpm: 150, mag: 4, reload: 2.6, damage: 110, projectile: { speed: 75, radius: 7 },
    bodyColor: 0x4f7a2a,
  },
  // Jack: a cork-popping sniper that fires as fast as a DMR.
  cork: {
    ...WEAPONS.sniper, name: 'Champagne Cork Sniper', mythic: true, tier: 5, rpm: 95, mag: 8, reload: 2.2, damage: 125, headMult: 2.2, recoil: 0.04,
    bodyColor: 0xff3fd0,
  },
};

/** A boss's mythic gun, fully kitted. */
export function makeMythic(id: MythicId): WeaponInstance {
  const def = MYTHICS[id];
  const w: WeaponInstance = { def, rarity: MYTHIC, mag: def.mag, att: rarityAttachments(def, MYTHIC) };
  w.mag = magSize(w);
  return w;
}

// ---- Attachments ----

export type AttachmentKind = 'scope' | 'extmag' | 'grip' | 'muzzle';
export const ATT_KINDS: AttachmentKind[] = ['scope', 'extmag', 'grip', 'muzzle'];
export const ATTACHMENTS: Record<AttachmentKind, { name: string; color: number; desc: string }> = {
  scope: { name: 'Built-in Optic', color: 0x5ad1ff, desc: 'Part of the gun' },
  extmag: { name: 'Extended Mag', color: 0xffb13b, desc: '+50% magazine' },
  grip: { name: 'Vertical Grip', color: 0x8cff6a, desc: '-30% recoil' },
  muzzle: { name: 'Compensator', color: 0xff6ad5, desc: '-25% recoil' },
};

export function canAttach(def: WeaponDef, kind: AttachmentKind) {
  if (def.id === 'rocket') return false;
  if (kind === 'scope') return !['sniper', 'shotgun', 'pistol', 'revolver'].includes(def.id);
  if (kind === 'grip') return !['pistol', 'revolver', 'sniper'].includes(def.id);
  if (kind === 'muzzle') return true;
  return def.id !== 'revolver';
}

export interface WeaponInstance {
  def: WeaponDef;
  rarity: Rarity;
  mag: number;
  att: Record<AttachmentKind, boolean>;
}

/** Guns that come with their own optic built in (the sniper and DMR have theirs modelled already). */
const BUILT_IN_SCOPE: WeaponId[] = ['ar', 'burst', 'lmg'];

/**
 * Attachments aren't looted any more: a gun's rarity decides its kit. Common (grey) has none,
 * Rare adds a compensator, Epic a grip as well, Legendary (gold) is fully kitted with an extended mag.
 */
export function rarityAttachments(def: WeaponDef, rarity: Rarity): Record<AttachmentKind, boolean> {
  const t = rarity.tier;
  return {
    scope: BUILT_IN_SCOPE.includes(def.id),
    muzzle: t >= 1 && canAttach(def, 'muzzle'),
    grip: t >= 2 && canAttach(def, 'grip'),
    extmag: t >= 3 && canAttach(def, 'extmag'),
  };
}

export function makeWeapon(id: WeaponId, rarity: Rarity = RARITIES[0]): WeaponInstance {
  const def = WEAPONS[id];
  const w: WeaponInstance = { def, rarity, mag: def.mag, att: rarityAttachments(def, rarity) };
  w.mag = magSize(w);
  return w;
}

export const magSize = (w: WeaponInstance) => (w.att.extmag ? Math.round(w.def.mag * 1.5) : w.def.mag);
export const recoilMul = (w: WeaponInstance) => (w.att.grip ? 0.7 : 1) * (w.att.muzzle ? 0.75 : 1);
/** Short key for a gun's attachments (mesh caches). */
export const attKey = (w: WeaponInstance) => ATT_KINDS.map((k) => +w.att[k]).join('');
/** Overall recoil strength: a touch more kick than the raw numbers, which attachments tame. */
const RECOIL_SCALE = 1.6;
export const adsFovOf = (w: WeaponInstance) => w.def.adsFov;
export const adsSpreadOf = (w: WeaponInstance) => w.def.adsSpread;

/** Per-shot camera kick for the i-th shot of a spray: [pitch, yaw] in radians. */
export function recoilKick(w: WeaponInstance, i: number): [number, number] {
  const d = w.def, p = d.pattern, m = recoilMul(w);
  const pitch = d.recoil * (i < p.climb ? 1 : p.late) * m * RECOIL_SCALE;
  const yaw = d.recoil * (p.yawBias + p.yawAmp * Math.sin(i * p.yawFreq + p.yawPhase)) * m * RECOIL_SCALE;
  return [pitch * (0.92 + Math.random() * 0.16), yaw + (Math.random() - 0.5) * d.recoil * 0.12 * m];
}

export function randomRarity(rng: () => number = Math.random): Rarity {
  const r = rng();
  if (r < 0.012) return RARITIES[3];
  if (r < 0.06) return RARITIES[2];
  if (r < 0.3) return RARITIES[1];
  return RARITIES[0];
}

const DROP_TABLE: [WeaponId, number][] = [
  ['ar', 0.2], ['smg', 0.16], ['shotgun', 0.14], ['burst', 0.1], ['sniper', 0.07], ['dmr', 0.08],
  ['lmg', 0.07], ['pistol', 0.08], ['revolver', 0.06], ['rocket', 0.015],
];

export function randomWeaponId(rng: () => number = Math.random): WeaponId {
  let r = rng() * DROP_TABLE.reduce((s, [, w]) => s + w, 0);
  for (const [id, w] of DROP_TABLE) {
    r -= w;
    if (r <= 0) return id;
  }
  return 'ar';
}

/** How much a bot wants this gun. Bots don't carry rocket launchers (bosses bring their own). */
export function weaponScore(w: WeaponInstance | null) {
  if (!w || (w.def.id === 'rocket' && !w.def.mythic)) return -1;
  return w.def.tier * 10 + w.rarity.tier * 3;
}

export function damageFalloff(def: WeaponDef, dist: number) {
  if (dist <= def.falloffStart) return 1;
  if (dist >= def.falloffEnd) return def.falloffMin;
  const t = (dist - def.falloffStart) / (def.falloffEnd - def.falloffStart);
  return 1 + (def.falloffMin - 1) * t;
}

// ---- Throwables ----

export type ThrowKind = 'frag' | 'smoke' | 'flash' | 'grapple';
export const THROWABLES: Record<ThrowKind, { name: string; color: number; max: number }> = {
  frag: { name: 'Frag Grenade', color: 0x4f6b3a, max: 3 },
  smoke: { name: 'Smoke Grenade', color: 0xb8bcc2, max: 3 },
  flash: { name: 'Flashbang', color: 0xe8e2c8, max: 3 },
  grapple: { name: 'Grappling Hook', color: 0x2f8ad8, max: 3 },
};

// ---- Procedural gun models, shared by loot and bots ----

const unitBox = new BoxGeometry(1, 1, 1);
const tube = new CylinderGeometry(1, 1, 1, 10).rotateX(Math.PI / 2);
const matCache = new Map<string, LitMat>();

export function lambert(color: number, emissive = 0): LitMat {
  const key = `${color}:${emissive}`;
  let m = matCache.get(key);
  if (!m) {
    m = plastic({ color, emissive }, 0.32);
    matCache.set(key, m);
  }
  return m;
}

export function boxMesh(w: number, h: number, d: number, color: number, emissive = 0): Mesh {
  const m = new Mesh(unitBox, lambert(color, emissive));
  m.scale.set(w, h, d);
  return m;
}

/** Gun pointing down -Z, origin at the grip. Returns group with `muzzleZ` in userData. */
const TP_DARK = TOY ? 0xf2f2f2 : 0x1d1f23, TP_DARKER = TOY ? 0xffc21a : 0x15171a, TP_BARREL = TOY ? 0xf2f2f2 : 0x22252a;

export function buildGunModel(w: WeaponInstance): Group {
  const g = buildGunModelBase(w);
  if (TOY && w.def.id !== 'rocket') {
    const L = w.def.modelLength, tip = boxMesh(0.05, 0.05, 0.05, 0xff6a00, 0x552200);
    tip.position.set(0, 0.055, -L * 0.8 - 0.05);
    g.add(tip);
  }
  if (w.def.mythic) {
    // Mythic guns glow.
    const glow = boxMesh(0.08, 0.03, w.def.modelLength * 0.5, 0xff3fd0, 0xff3fd0);
    glow.position.set(0, 0.1, -w.def.modelLength * 0.3);
    g.add(glow);
  }
  return g;
}

function buildGunModelBase(w: WeaponInstance): Group {
  const g = new Group();
  const L = w.def.modelLength, id = w.def.id;
  const accent = w.rarity.color;
  const add = (m: Mesh, x: number, y: number, z: number) => {
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  if (id === 'rocket') {
    const t = new Mesh(tube, lambert(w.def.bodyColor));
    t.scale.set(0.085, 0.085, L);
    add(t, 0, 0.08, -L * 0.3);
    add(boxMesh(0.05, 0.12, 0.06, 0x1d1f23), 0, -0.03, 0);
    add(boxMesh(0.06, 0.06, 0.16, 0x15171a), -0.1, 0.13, -0.3);
    add(boxMesh(0.09, 0.02, L * 0.3, accent, darken(accent)), 0, 0.17, -L * 0.3);
    g.userData.muzzleZ = -L * 0.8;
    return g;
  }
  add(boxMesh(0.07, 0.1, L * 0.6, w.def.bodyColor), 0, 0.03, -L * 0.25);
  add(boxMesh(0.035, 0.035, L * 0.45, TP_BARREL), 0, 0.055, -L * 0.55 - 0.02);
  add(boxMesh(0.05, 0.12, 0.06, TP_DARK), 0, -0.06, 0).rotation.x = -0.25;
  add(boxMesh(0.075, 0.025, L * 0.35, accent, darken(accent)), 0, 0.09, -L * 0.25);
  if (id === 'revolver') add(boxMesh(0.08, 0.08, 0.09, 0x3a3f47), 0, 0.03, -0.06);
  if (id !== 'pistol' && id !== 'revolver') {
    const magH = id === 'shotgun' ? 0.06 : id === 'lmg' ? 0.12 : 0.14;
    const mag = add(boxMesh(id === 'lmg' ? 0.12 : 0.045, magH, 0.07, TP_DARKER), 0, -0.07, -L * 0.3);
    if (w.att.extmag) mag.scale.y *= 1.6;
    add(boxMesh(0.05, 0.08, L * 0.25, w.def.bodyColor), 0, 0.0, L * 0.12);
  }
  if (id === 'sniper' || id === 'ar' || id === 'dmr' || w.att.scope) add(boxMesh(0.045, 0.05, 0.22, 0x15171a), 0, 0.125, -L * 0.2);
  if (w.att.grip) add(boxMesh(0.03, 0.1, 0.035, 0x1d1f23), 0, -0.05, -L * 0.55);
  if (w.att.muzzle) add(boxMesh(0.05, 0.05, 0.09, 0x15171a), 0, 0.055, -L * 0.78 - 0.02);
  g.userData.muzzleZ = -L * 0.78 - 0.04;
  return g;
}

export function darken(c: number, k = 0.35) {
  const r = ((c >> 16) & 255) * k, gg = ((c >> 8) & 255) * k, b = (c & 255) * k;
  return (r << 16) | (gg << 8) | b;
}

/** Bare hands (key 3): a short-range punch. */
export const FISTS: WeaponInstance = {
  ...makeWeapon('pistol'),
  def: { ...WEAPONS.pistol, name: 'Fists', damage: 30, headMult: 1.3, pellets: 1, range: 2.3, falloffStart: 50, falloffEnd: 60, falloffMin: 1 },
};
