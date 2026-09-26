import {
  AdditiveBlending, BoxGeometry, DirectionalLight, DoubleSide, Group, HemisphereLight, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, Object3D, PerspectiveCamera, PlaneGeometry, PointLight, Scene, Vector3, WebGLRenderer,
} from 'three';
import { clamp, damp, lerp } from '../core/rng';
import type { Player } from '../player/Player';
import { CAMOS } from '../game/Profile';
import { attKey, lambert, type WeaponId, type WeaponInstance } from './Weapon';
import { TOY } from '../theme';

/** A first-person gun with the moving parts the animations need. Units are gun-space (scaled 0.55 on screen). */
interface GunParts {
  root: Group;
  id: WeaponId;
  mag: Object3D | null;
  /** Pistol slide or rifle charging handle. */
  slide: Object3D | null;
  pump: Object3D | null;
  bolt: Object3D | null;
  muzzle: Vector3;
  eject: Vector3;
  /** Height of the sight line: this point is put on the screen centre when aiming. */
  sightY: number;
  /** Where the left hand normally holds the gun. */
  support: Vector3;
  magWell: Vector3;
  handle: Vector3;
  hip: Vector3;
  adsZ: number;
}

export type ReloadAnim =
  | { kind: 'mag'; t: number }
  | { kind: 'shell-start' | 'shell' | 'shell-end'; t: number };

export interface ViewState {
  player: Player;
  ads: number;
  /** 1 right after switching weapons, down to 0. */
  equip: number;
  busy: boolean;
  /** Using a medkit or putting on a plate (0..1 through it). */
  heal: { type: 'medkit' | 'plate'; t: number } | null;
  reload: ReloadAnim | null;
  /** Seconds since the last shot, and the weapon's time between shots. */
  sinceShot: number;
  /** Paragliding: hands up on the brake toggles instead of a gun. */
  glide?: boolean;
  cycle: number;
}

const SCALE = 0.55;
const unit = new BoxGeometry(1, 1, 1);

function box(parent: Object3D, w: number, h: number, d: number, color: number, x: number, y: number, z: number, rx = 0, emissive = 0) {
  const m = new Mesh(unit, lambert(color, emissive));
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  m.rotation.x = rx;
  parent.add(m);
  return m;
}

const LENS = new MeshBasicMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.05, depthWrite: false });

/**
 * A see-through optic: four thin walls, a wider objective bell, a faint lens and a red dot at the
 * front. Aiming looks straight down the tube, so it must be open, not a solid block.
 */
function scopeTube(parent: Object3D, w: number, len: number, y: number, z: number) {
  const t = 0.0035;
  const walls = (size: number, depth: number, cz: number) => {
    const o = (size - t) / 2;
    box(parent, size, t, depth, DARK, 0, y + o, cz);
    box(parent, size, t, depth, DARK, 0, y - o, cz);
    box(parent, t, size, depth, DARK, o, y, cz);
    box(parent, t, size, depth, DARK, -o, y, cz);
  };
  walls(w, len, z);
  const front = z - len / 2;
  walls(w * 1.3, 0.04, front);
  const lens = new Mesh(unit, LENS);
  lens.scale.set(w * 1.25, w * 1.25, 0.001);
  lens.position.set(0, y, front);
  parent.add(lens);
  const dot = new Mesh(unit, DOT);
  dot.scale.set(0.0045, 0.0045, 0.001);
  dot.position.set(0, y, front + 0.002);
  parent.add(dot);
}
const DOT = new MeshBasicMaterial({ color: 0xff2a2a });
/** Bare hands: warm skin, knuckles and finger creases a shade darker. */
const SKIN = new MeshLambertMaterial({ color: 0xd39a76 });
const KNUCKLE = new MeshLambertMaterial({ color: 0xbd8462 });

function boxM(parent: Object3D, w: number, h: number, d: number, mat: MeshLambertMaterial, x: number, y: number, z: number, rx = 0, ry = 0) {
  const m = new Mesh(unit, mat);
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, 0);
  parent.add(m);
  return m;
}
const HOLO = new MeshBasicMaterial({ color: 0x80ffb0, transparent: true, opacity: 0.07, depthWrite: false });
const RETICLE = new MeshBasicMaterial({ color: 0x5aff8a });

function group(parent: Object3D, x: number, y: number, z: number) {
  const g = new Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

// Toy Box: yellow and white plastic instead of steel and polymer, orange instead of wood.
const METAL = TOY ? 0xffc21a : 0x4a4f57, DARK = TOY ? 0xf0f0f0 : 0x2c3036, WOOD = TOY ? 0xff7a1a : 0x7a5436;

/** Camo colour from the locker (null = the gun's own colour). */
let camo: number | null = null, camoAccent: number | null = null;
export function setViewCamo(c: number | null) {
  camo = c;
  camoAccent = (c !== null && CAMOS.find((x) => x.color === c)?.accent) || null;
}

/** The base gun plus whatever attachments it carries. */
export function buildViewGun(w: WeaponInstance): GunParts {
  const P = buildBase(w);
  const a = w.att;
  if (a.scope && w.def.id !== 'sniper') {
    // Low-power optic sitting on the rail; the aim point moves up to its centre.
    const y = P.sightY + 0.045, z = P.id === 'rocket' ? -0.05 : -0.08;
    box(P.root, 0.03, 0.03, 0.04, DARK, 0, y - 0.035, z);
    scopeTube(P.root, 0.046, 0.2, y, z);
    P.sightY = y;
  }
  if (a.extmag && P.mag) P.mag.scale.set(1, 1.45, 1.1);
  if (a.muzzle && P.id !== 'rocket') {
    // Compensator: a slotted block on the end of the barrel.
    const m = P.muzzle, cz = m.z + 0.03;
    box(P.root, 0.034, 0.034, 0.07, DARK, m.x, m.y, cz);
    for (const dz of [-0.018, 0.012]) box(P.root, 0.038, 0.008, 0.012, 0xff6ad5, m.x, m.y + 0.018, cz + dz, 0, 0x551a44);
    P.muzzle = m.clone().setZ(m.z - 0.01);
  }
  if (a.grip) {
    const g = group(P.root, P.support.x, P.support.y - 0.02, P.support.z);
    box(g, 0.03, 0.09, 0.035, DARK, 0, -0.045, 0);
    P.support = P.support.clone().setY(P.support.y - 0.07);
  }
  if (TOY && P.id !== 'rocket') {
    // The orange safety tip every toy blaster has.
    const m = P.muzzle;
    box(P.root, 0.036, 0.036, 0.03, 0xff6a00, m.x, m.y, m.z - 0.012, 0, 0x5a2400);
    P.muzzle = m.clone().setZ(m.z - 0.03);
  }
  if (w.def.mythic) {
    // Mythic: a glowing pink stripe down the side.
    for (const s of [-1, 1]) box(P.root, 0.004, 0.012, 0.22, 0xff3fd0, s * 0.032, P.sightY - 0.035, -0.12, 0, 0xff3fd0);
  }
  return P;
}

function buildBase(w: WeaponInstance): GunParts {
  const root = new Group();
  const body = camo ?? w.def.bodyColor, acc = camoAccent ?? w.rarity.color;
  const accEm = ((((acc >> 16) & 255) * 0.3) << 16) | ((((acc >> 8) & 255) * 0.3) << 8) | ((acc & 255) * 0.3);
  const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
  switch (w.def.id) {
    case 'pistol': {
      box(root, 0.05, 0.045, 0.2, body, 0, 0.02, -0.085);
      const slide = group(root, 0, 0.066, -0.09);
      box(slide, 0.056, 0.048, 0.235, METAL, 0, 0, 0);
      box(slide, 0.058, 0.012, 0.1, acc, 0, 0.012, -0.03, 0, accEm);
      box(slide, 0.008, 0.012, 0.01, 0xdddddd, 0, 0.03, -0.105); // front sight
      box(slide, 0.01, 0.014, 0.01, DARK, -0.014, 0.031, 0.1);
      box(slide, 0.01, 0.014, 0.01, DARK, 0.014, 0.031, 0.1);
      box(root, 0.028, 0.028, 0.03, DARK, 0, 0.066, -0.215);
      box(root, 0.048, 0.13, 0.065, DARK, 0, -0.05, 0.015, -0.2);
      box(root, 0.012, 0.03, 0.05, DARK, 0, -0.012, -0.045);
      const mag = group(root, 0, -0.05, 0.02);
      box(mag, 0.04, 0.12, 0.05, METAL, 0, 0, 0, -0.2);
      box(mag, 0.05, 0.02, 0.066, DARK, 0, -0.066, 0.014, -0.2);
      return {
        root, id: 'pistol', mag, slide, pump: null, bolt: null,
        muzzle: v(0, 0.066, -0.235), eject: v(0.03, 0.085, -0.06), sightY: 0.105,
        support: v(-0.028, -0.07, 0.035), magWell: v(0, -0.14, 0.03), handle: v(0, 0.1, 0.0),
        hip: v(0.13, -0.15, -0.52), adsZ: -0.45,
      };
    }
    case 'smg': {
      box(root, 0.06, 0.09, 0.32, body, 0, 0.03, -0.12);
      box(root, 0.062, 0.02, 0.2, acc, 0, 0.035, -0.12, 0, accEm);
      box(root, 0.05, 0.02, 0.3, METAL, 0, 0.085, -0.12);
      box(root, 0.048, 0.048, 0.14, METAL, 0, 0.04, -0.34);
      box(root, 0.026, 0.026, 0.06, DARK, 0, 0.04, -0.44);
      box(root, 0.045, 0.11, 0.055, DARK, 0, -0.06, 0.01, -0.25);
      box(root, 0.035, 0.09, 0.035, DARK, 0, -0.05, -0.28);
      box(root, 0.03, 0.03, 0.18, METAL, 0, 0.03, 0.12);
      box(root, 0.035, 0.09, 0.02, DARK, 0, 0.0, 0.21);
      box(root, 0.01, 0.024, 0.015, DARK, -0.013, 0.105, 0.0); // rear notch
      box(root, 0.01, 0.024, 0.015, DARK, 0.013, 0.105, 0.0);
      box(root, 0.008, 0.03, 0.01, DARK, 0, 0.1, -0.26); // front post
      const mag = group(root, 0, -0.02, -0.12);
      box(mag, 0.035, 0.2, 0.05, DARK, 0, -0.1, -0.01, 0.15);
      const slide = group(root, -0.042, 0.06, -0.03);
      box(slide, 0.02, 0.02, 0.035, 0x55595e, 0, 0, 0);
      return {
        root, id: 'smg', mag, slide, pump: null, bolt: null,
        muzzle: v(0, 0.04, -0.475), eject: v(0.035, 0.06, -0.08), sightY: 0.118,
        support: v(0, -0.07, -0.28), magWell: v(0, -0.22, -0.14), handle: v(-0.05, 0.06, -0.03),
        hip: v(0.14, -0.155, -0.5), adsZ: -0.37,
      };
    }
    case 'ar': {
      box(root, 0.065, 0.09, 0.3, body, 0, 0.03, -0.05);
      box(root, 0.067, 0.02, 0.18, acc, 0, 0.005, -0.05, 0, accEm);
      box(root, 0.06, 0.07, 0.3, METAL, 0, 0.035, -0.35);
      box(root, 0.035, 0.015, 0.55, DARK, 0, 0.085, -0.2);
      box(root, 0.025, 0.025, 0.16, DARK, 0, 0.035, -0.56);
      box(root, 0.04, 0.04, 0.05, DARK, 0, 0.035, -0.645);
      box(root, 0.045, 0.11, 0.055, DARK, 0, -0.065, 0.03, -0.3);
      box(root, 0.035, 0.035, 0.12, METAL, 0, 0.04, 0.16);
      box(root, 0.05, 0.1, 0.14, body, 0, 0.02, 0.27);
      box(root, 0.045, 0.02, 0.1, DARK, 0, 0.075, 0.26);
      // Red dot: an open frame with a glowing dot on the sight line
      box(root, 0.03, 0.02, 0.05, DARK, 0, 0.1, -0.1);
      box(root, 0.006, 0.05, 0.05, DARK, -0.02, 0.13, -0.1);
      box(root, 0.006, 0.05, 0.05, DARK, 0.02, 0.13, -0.1);
      box(root, 0.046, 0.006, 0.05, DARK, 0, 0.158, -0.1);
      box(root, 0.009, 0.009, 0.002, 0xff3030, 0, 0.13, -0.124, 0, 0xff2020);
      const mag = group(root, 0, -0.015, -0.14);
      box(mag, 0.04, 0.1, 0.07, DARK, 0, -0.05, 0);
      box(mag, 0.04, 0.1, 0.07, DARK, 0, -0.135, -0.03, 0.35);
      const slide = group(root, 0, 0.08, 0.1);
      box(slide, 0.03, 0.015, 0.03, 0x55595e, 0, 0, 0);
      return {
        root, id: 'ar', mag, slide, pump: null, bolt: null,
        muzzle: v(0, 0.035, -0.675), eject: v(0.036, 0.05, -0.07), sightY: 0.13,
        support: v(0, -0.02, -0.37), magWell: v(0, -0.25, -0.17), handle: v(0, 0.1, 0.13),
        hip: v(0.14, -0.16, -0.54), adsZ: -0.33,
      };
    }
    case 'shotgun': {
      box(root, 0.06, 0.09, 0.24, body, 0, 0.03, -0.03);
      box(root, 0.062, 0.02, 0.14, acc, 0, 0.05, -0.03, 0, accEm);
      box(root, 0.036, 0.036, 0.5, METAL, 0, 0.055, -0.4);
      box(root, 0.03, 0.03, 0.4, DARK, 0, 0.012, -0.35);
      box(root, 0.05, 0.1, 0.26, WOOD, 0, -0.03, 0.2, -0.12);
      box(root, 0.045, 0.1, 0.05, WOOD, 0, -0.05, 0.05, -0.3);
      box(root, 0.01, 0.01, 0.01, 0xf2f2f2, 0, 0.078, -0.64); // bead
      box(root, 0.008, 0.012, 0.012, DARK, -0.011, 0.082, -0.02);
      box(root, 0.008, 0.012, 0.012, DARK, 0.011, 0.082, -0.02);
      const pump = group(root, 0, 0.012, -0.33);
      box(pump, 0.056, 0.052, 0.16, WOOD, 0, 0, 0);
      return {
        root, id: 'shotgun', mag: null, slide: null, pump, bolt: null,
        muzzle: v(0, 0.055, -0.66), eject: v(0.036, 0.05, -0.03), sightY: 0.086,
        support: v(0, -0.03, -0.33), magWell: v(0, -0.03, -0.09), handle: v(0, -0.03, -0.33),
        hip: v(0.14, -0.16, -0.54), adsZ: -0.4,
      };
    }
    case 'sniper': {
      box(root, 0.06, 0.08, 0.3, body, 0, 0.03, -0.05);
      box(root, 0.062, 0.02, 0.2, acc, 0, 0.0, -0.05, 0, accEm);
      box(root, 0.055, 0.11, 0.35, body, 0, 0.0, 0.25);
      box(root, 0.05, 0.03, 0.15, DARK, 0, 0.07, 0.22);
      box(root, 0.045, 0.11, 0.05, DARK, 0, -0.07, 0.08, -0.3);
      box(root, 0.03, 0.03, 0.55, METAL, 0, 0.04, -0.47);
      box(root, 0.046, 0.046, 0.08, DARK, 0, 0.04, -0.76);
      box(root, 0.055, 0.06, 0.25, body, 0, 0.03, -0.3);
      box(root, 0.046, 0.046, 0.3, DARK, 0, 0.13, -0.08);
      box(root, 0.064, 0.064, 0.07, DARK, 0, 0.13, -0.25);
      box(root, 0.056, 0.056, 0.05, DARK, 0, 0.13, 0.08);
      box(root, 0.05, 0.05, 0.004, 0x4fa3ff, 0, 0.13, 0.106, 0, 0x14305a);
      for (const z of [-0.15, 0.0]) box(root, 0.02, 0.05, 0.02, DARK, 0, 0.09, z);
      const bolt = group(root, 0.035, 0.05, 0.04);
      box(bolt, 0.05, 0.012, 0.012, METAL, 0.025, 0, 0);
      box(bolt, 0.022, 0.022, 0.022, DARK, 0.052, 0, 0);
      const mag = group(root, 0, -0.01, -0.1);
      box(mag, 0.045, 0.07, 0.08, DARK, 0, -0.035, 0);
      return {
        root, id: 'sniper', mag, slide: null, pump: null, bolt,
        muzzle: v(0, 0.04, -0.8), eject: v(0.04, 0.06, 0.0), sightY: 0.13,
        support: v(0, -0.01, -0.3), magWell: v(0, -0.1, -0.1), handle: v(0.06, 0.05, 0.04),
        hip: v(0.14, -0.16, -0.56), adsZ: -0.26,
      };
    }
    case 'revolver': {
      box(root, 0.05, 0.05, 0.1, body, 0, 0.055, 0.0);
      box(root, 0.032, 0.032, 0.2, METAL, 0, 0.075, -0.15);
      box(root, 0.036, 0.012, 0.2, METAL, 0, 0.097, -0.15);
      box(root, 0.008, 0.016, 0.01, 0xdddddd, 0, 0.108, -0.24); // front sight
      box(root, 0.007, 0.012, 0.012, DARK, -0.009, 0.1, 0.04);
      box(root, 0.007, 0.012, 0.012, DARK, 0.009, 0.1, 0.04);
      box(root, 0.052, 0.012, 0.06, acc, 0, 0.03, 0.0, 0, accEm);
      box(root, 0.046, 0.13, 0.06, WOOD, 0, -0.04, 0.05, -0.35);
      box(root, 0.012, 0.03, 0.04, DARK, 0, 0.015, -0.03);
      const mag = group(root, 0, 0.06, -0.035);
      box(mag, 0.066, 0.066, 0.075, METAL, 0, 0, 0);
      for (const [x, y] of [[-0.018, 0.018], [0.018, 0.018], [-0.018, -0.018], [0.018, -0.018]]) box(mag, 0.012, 0.012, 0.077, DARK, x, y, 0);
      return {
        root, id: 'revolver', mag, slide: null, pump: null, bolt: null,
        muzzle: v(0, 0.075, -0.255), eject: v(0.03, 0.07, -0.03), sightY: 0.119,
        support: v(-0.028, -0.07, 0.06), magWell: v(0, 0.02, -0.04), handle: v(0, 0.1, 0.0),
        hip: v(0.13, -0.15, -0.5), adsZ: -0.43,
      };
    }
    case 'burst': {
      box(root, 0.065, 0.1, 0.34, body, 0, 0.03, -0.06);
      box(root, 0.067, 0.022, 0.2, acc, 0, 0.0, -0.06, 0, accEm);
      box(root, 0.07, 0.08, 0.22, METAL, 0, 0.03, -0.33);
      box(root, 0.03, 0.03, 0.14, DARK, 0, 0.035, -0.5);
      box(root, 0.045, 0.045, 0.04, DARK, 0, 0.035, -0.585);
      box(root, 0.04, 0.02, 0.5, DARK, 0, 0.09, -0.17);
      box(root, 0.045, 0.11, 0.055, DARK, 0, -0.065, 0.04, -0.3);
      box(root, 0.055, 0.1, 0.12, body, 0, 0.02, 0.2);
      box(root, 0.06, 0.08, 0.1, DARK, 0, 0.0, 0.3);
      // Holo sight: a thin open frame, a faint green pane and a small reticle.
      box(root, 0.04, 0.012, 0.06, DARK, 0, 0.105, -0.1);
      box(root, 0.046, 0.005, 0.012, DARK, 0, 0.113, -0.13);
      box(root, 0.046, 0.005, 0.012, DARK, 0, 0.158, -0.13);
      box(root, 0.005, 0.05, 0.012, DARK, -0.021, 0.135, -0.13);
      box(root, 0.005, 0.05, 0.012, DARK, 0.021, 0.135, -0.13);
      const pane = new Mesh(unit, HOLO);
      pane.scale.set(0.037, 0.04, 0.001);
      pane.position.set(0, 0.135, -0.13);
      root.add(pane);
      const ret = new Mesh(unit, RETICLE);
      ret.scale.set(0.0035, 0.0035, 0.001);
      ret.position.set(0, 0.133, -0.131);
      root.add(ret);
      const mag = group(root, 0, -0.02, -0.16);
      box(mag, 0.042, 0.16, 0.07, DARK, 0, -0.08, -0.01, 0.12);
      const slide = group(root, 0.04, 0.06, 0.05);
      box(slide, 0.02, 0.02, 0.035, 0x55595e, 0, 0, 0);
      return {
        root, id: 'burst', mag, slide, pump: null, bolt: null,
        muzzle: v(0, 0.035, -0.61), eject: v(0.036, 0.05, -0.07), sightY: 0.133,
        support: v(0, -0.02, -0.33), magWell: v(0, -0.25, -0.18), handle: v(0.05, 0.06, 0.05),
        hip: v(0.14, -0.16, -0.54), adsZ: -0.33,
      };
    }
    case 'lmg': {
      box(root, 0.08, 0.11, 0.36, body, 0, 0.03, -0.05);
      box(root, 0.082, 0.022, 0.24, acc, 0, 0.0, -0.05, 0, accEm);
      box(root, 0.07, 0.05, 0.32, METAL, 0, 0.09, -0.08); // feed cover
      box(root, 0.04, 0.04, 0.42, METAL, 0, 0.04, -0.44);
      for (let i = 0; i < 6; i++) box(root, 0.05, 0.05, 0.02, DARK, 0, 0.04, -0.3 - i * 0.05); // barrel shroud fins
      box(root, 0.05, 0.05, 0.06, DARK, 0, 0.04, -0.68);
      box(root, 0.05, 0.12, 0.06, DARK, 0, -0.07, 0.07, -0.3);
      box(root, 0.06, 0.1, 0.2, body, 0, 0.01, 0.26);
      box(root, 0.006, 0.03, 0.006, DARK, 0, 0.13, -0.2);
      box(root, 0.01, 0.02, 0.012, DARK, -0.012, 0.125, 0.05);
      box(root, 0.01, 0.02, 0.012, DARK, 0.012, 0.125, 0.05);
      // Bipod folded under the barrel
      box(root, 0.012, 0.012, 0.2, DARK, -0.015, 0.0, -0.5);
      box(root, 0.012, 0.012, 0.2, DARK, 0.015, 0.0, -0.5);
      const mag = group(root, -0.02, -0.03, -0.1);
      box(mag, 0.1, 0.13, 0.12, 0x3b4a2a, -0.02, -0.07, 0);
      box(mag, 0.03, 0.03, 0.08, 0xd4a93a, 0.04, 0.0, 0);
      const slide = group(root, -0.05, 0.05, 0.02);
      box(slide, 0.02, 0.025, 0.04, 0x55595e, 0, 0, 0);
      return {
        root, id: 'lmg', mag, slide, pump: null, bolt: null,
        muzzle: v(0, 0.04, -0.72), eject: v(0.045, 0.04, -0.05), sightY: 0.147,
        support: v(0, -0.02, -0.35), magWell: v(-0.04, -0.2, -0.1), handle: v(-0.06, 0.05, 0.02),
        hip: v(0.14, -0.17, -0.55), adsZ: -0.4,
      };
    }
    case 'dmr': {
      box(root, 0.06, 0.09, 0.3, body, 0, 0.03, -0.05);
      box(root, 0.062, 0.02, 0.2, acc, 0, 0.0, -0.05, 0, accEm);
      box(root, 0.055, 0.065, 0.3, WOOD, 0, 0.02, -0.36);
      box(root, 0.028, 0.028, 0.34, METAL, 0, 0.045, -0.6);
      box(root, 0.04, 0.04, 0.06, DARK, 0, 0.045, -0.79);
      box(root, 0.045, 0.11, 0.05, DARK, 0, -0.07, 0.06, -0.3);
      box(root, 0.055, 0.1, 0.3, WOOD, 0, 0.0, 0.24);
      // Medium scope
      scopeTube(root, 0.044, 0.24, 0.12, -0.08);
      for (const z of [-0.14, -0.02]) box(root, 0.02, 0.04, 0.02, DARK, 0, 0.085, z);
      const mag = group(root, 0, -0.01, -0.12);
      box(mag, 0.042, 0.1, 0.07, DARK, 0, -0.05, 0);
      const slide = group(root, 0.04, 0.05, 0.03);
      box(slide, 0.03, 0.015, 0.02, 0x55595e, 0, 0, 0);
      return {
        root, id: 'dmr', mag, slide, pump: null, bolt: null,
        muzzle: v(0, 0.045, -0.82), eject: v(0.036, 0.05, -0.02), sightY: 0.12,
        support: v(0, -0.02, -0.36), magWell: v(0, -0.2, -0.14), handle: v(0.05, 0.05, 0.03),
        hip: v(0.14, -0.16, -0.56), adsZ: -0.24,
      };
    }
    case 'rocket': {
      box(root, 0.13, 0.13, 0.9, body, 0, 0.06, -0.1);
      box(root, 0.135, 0.03, 0.4, acc, 0, 0.1, -0.1, 0, accEm);
      box(root, 0.15, 0.15, 0.08, DARK, 0, 0.06, -0.56);
      box(root, 0.15, 0.15, 0.08, DARK, 0, 0.06, 0.36);
      box(root, 0.045, 0.12, 0.055, DARK, 0, -0.07, 0.02, -0.25);
      box(root, 0.04, 0.1, 0.04, DARK, 0, -0.06, -0.26);
      // Flip-up iron sight
      box(root, 0.05, 0.06, 0.012, DARK, -0.07, 0.15, -0.1);
      box(root, 0.02, 0.02, 0.013, 0xffd24a, -0.07, 0.17, -0.1, 0, 0x805a00);
      const mag = group(root, 0, 0.06, -0.62);
      box(mag, 0.09, 0.09, 0.14, 0x55603a, 0, 0, -0.02);
      box(mag, 0.06, 0.06, 0.08, 0xc9c2a0, 0, 0, -0.12);
      return {
        root, id: 'rocket', mag, slide: null, pump: null, bolt: null,
        muzzle: v(0, 0.06, -0.72), eject: v(0, 0.06, 0.4), sightY: 0.17,
        support: v(0, -0.08, -0.26), magWell: v(0, 0.06, -0.72), handle: v(0, 0.06, -0.7),
        hip: v(0.16, -0.14, -0.5), adsZ: -0.3,
      };
    }
  }
}

// --- animation helpers ---
const ease = (x: number) => x * x * (3 - 2 * x);
const seg = (t: number, a: number, b: number) => ease(clamp((t - a) / (b - a), 0, 1));
const bump = (t: number, a: number, b: number) => (t <= a || t >= b ? 0 : Math.sin(((t - a) / (b - a)) * Math.PI));

interface Casing {
  mesh: Mesh;
  vel: Vector3;
  spin: Vector3;
  life: number;
}

/**
 * First-person arms + gun, with procedural fire, reload, sway, sprint and equip animations.
 * Rendered in its own scene with a narrower FOV (like most shooters) so it doesn't look stretched
 * and never clips into walls.
 */
export class ViewModel {
  holder = new Group();
  vmScene = new Scene();
  vmCamera = new PerspectiveCamera(54, 1, 0.01, 20);
  private pose = new Group();
  private parts: GunParts | null = null;
  private partsFor: WeaponInstance | null = null;
  private homes = new Map<Object3D, Vector3>();
  private rightArm = new Group();
  private leftHand = new Group();
  private shellInHand: Mesh;
  private flash = new Group();
  private flashLight = new PointLight(0xffc060, 0, 8);
  private flashTime = 0;
  private flashAds = 0;
  private casings: Casing[] = [];
  private kickZ = 0;
  private kickPitch = 0;
  private kickRoll = 0;
  private swayX = 0;
  private swayY = 0;
  private lookX = 0;
  private lookY = 0;
  private bobPhase = 0;
  private sprintT = 0;
  private slideT = 0;
  private busyT = 0;
  private landDip = 0;
  private landVel = 0;
  private time = 0;
  private ejectedFor = -1;
  /** Medkit / plate in your left hand while you use it. */
  private item = new Group();
  private plateMesh = new Group();
  private kitMesh = new Group();
  private syringe = new Group();
  private healT = 0;
  private punchT = 1;
  private punchSide = 0;
  /** Brake toggles and their lines, held while paragliding. */
  private toggles: Object3D[] = [];
  /** The outfit's sleeves and cuffs (recoloured by the locker). */
  private sleeveMat = new MeshLambertMaterial({ color: 0x55687a });
  private cuffMat = new MeshLambertMaterial({ color: 0x3d4c5a });
  private glideT = 0;
  /** Butterfly knife in the right fist while your hands are out (the secret melee skin). */
  knifeOn = false;
  private knife = new Group();
  private kBlade = new Group();
  private kHandleB = new Group();
  private kGlint: MeshLambertMaterial[] = [];
  private inspectT = 1;
  private drawT = 1;
  private wasKnife = false;

  constructor(private camera: PerspectiveCamera, private scene: Scene) {
    this.vmScene.add(this.holder, new HemisphereLight(0xeaf4ff, 0x4a5a3a, 1.6));
    const key = new DirectionalLight(0xfff1d6, 1.8);
    key.position.set(1, 2, 1.5);
    this.vmScene.add(key);
    this.holder.add(this.pose);
    this.pose.scale.setScalar(SCALE);
    const sleeve = this.sleeveMat, cuff = this.cuffMat;
    // Right hand round the grip: palm, fingers wrapped in front, index finger along the guard, thumb
    // over the top; forearm dropping steeply out of view with the outfit's sleeve and cuff.
    boxM(this.rightArm, 0.058, 0.08, 0.07, SKIN, 0, -0.055, 0.035);
    boxM(this.rightArm, 0.063, 0.07, 0.024, KNUCKLE, 0, -0.062, -0.01);
    boxM(this.rightArm, 0.017, 0.017, 0.05, SKIN, -0.02, -0.008, -0.028);
    boxM(this.rightArm, 0.02, 0.021, 0.056, SKIN, -0.034, -0.022, 0.012);
    boxM(this.rightArm, 0.075, 0.075, 0.26, sleeve, 0.04, -0.16, 0.12, 1.0, -0.2);
    boxM(this.rightArm, 0.086, 0.086, 0.04, cuff, 0.047, -0.1, 0.082, 1.0, -0.2);
    this.pose.add(this.rightArm);
    this.buildKnife();
    // Left hand cupping the handguard: palm underneath, fingers curled up the far side, thumb on the near side.
    boxM(this.leftHand, 0.06, 0.048, 0.09, SKIN, 0, -0.01, 0);
    boxM(this.leftHand, 0.02, 0.05, 0.086, KNUCKLE, 0.032, 0.012, -0.002);
    boxM(this.leftHand, 0.018, 0.034, 0.06, SKIN, -0.032, 0.012, 0.012);
    boxM(this.leftHand, 0.075, 0.075, 0.26, sleeve, -0.05, -0.13, 0.1, 1.05, 0.35);
    boxM(this.leftHand, 0.086, 0.086, 0.04, cuff, -0.062, -0.069, 0.065, 1.05, 0.35);
    this.shellInHand = box(this.leftHand, 0.02, 0.02, 0.05, 0xd9382c, 0.02, 0.04, -0.02);
    this.shellInHand.visible = false;
    this.pose.add(this.leftHand);
    // Paraglider arms: gloved fists round the brake toggles, forearms reaching up from below.
    for (const side of [1, -1]) {
      const arm = new Group(), fore = new Group();
      boxM(arm, 0.07, 0.085, 0.075, SKIN, 0, 0, 0);
      boxM(arm, 0.074, 0.028, 0.08, KNUCKLE, 0, 0.03, -0.004);
      boxM(arm, 0.022, 0.05, 0.03, SKIN, -side * 0.03, 0.035, 0.02);
      box(arm, 0.03, 0.11, 0.03, 0xffb020, 0, 0.02, -0.05, 0, 0x402a00);
      box(arm, 0.007, 2, 0.007, 0xe8e8e8, 0, 1.06, -0.05);
      boxM(fore, 0.085, 0.55, 0.085, sleeve, 0, -0.3, 0);
      boxM(fore, 0.09, 0.05, 0.09, cuff, 0, -0.06, 0);
      fore.rotation.set(-0.4, 0, side * 0.22);
      arm.add(fore);
      arm.visible = false;
      this.pose.add(arm);
      this.toggles.push(arm);
    }

    const fmat = new MeshBasicMaterial({ color: 0xffd27a, transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
    const star = new Mesh(new PlaneGeometry(0.24, 0.24), fmat);
    const star2 = new Mesh(new PlaneGeometry(0.34, 0.1), fmat);
    const streak = new Mesh(new PlaneGeometry(0.08, 0.3), fmat);
    streak.rotation.set(Math.PI / 2, 0, 0);
    streak.position.z = -0.12;
    const streak2 = streak.clone();
    streak2.rotation.set(Math.PI / 2, Math.PI / 2, 0);
    this.flash.add(star, star2, streak, streak2);
    this.flash.visible = false;
    this.pose.add(this.flash);
    this.holder.add(this.flashLight);

    // Armor plate: a blue slab with a darker rim; medkit: white case, red cross, a syringe.
    box(this.plateMesh, 0.2, 0.26, 0.022, 0x39a0ff, 0, 0, 0, 0, 0x0d3a66);
    box(this.plateMesh, 0.21, 0.02, 0.026, 0x1a4f8a, 0, 0.12, 0);
    box(this.plateMesh, 0.21, 0.02, 0.026, 0x1a4f8a, 0, -0.12, 0);
    boxM(this.plateMesh, 0.05, 0.05, 0.03, SKIN, -0.08, -0.08, 0.02);
    box(this.kitMesh, 0.18, 0.12, 0.08, 0xf2f2f2, 0, 0, 0, 0, 0x333333);
    box(this.kitMesh, 0.1, 0.03, 0.084, 0xe53935, 0, 0, 0, 0, 0x551111);
    box(this.kitMesh, 0.03, 0.1, 0.084, 0xe53935, 0, 0, 0, 0, 0x551111);
    boxM(this.kitMesh, 0.06, 0.06, 0.05, SKIN, -0.08, -0.05, 0.03);
    box(this.syringe, 0.018, 0.018, 0.12, 0xe8f4ff, 0, 0, 0, 0, 0x406080);
    box(this.syringe, 0.006, 0.006, 0.05, 0xb0b0b0, 0, 0, -0.08);
    box(this.syringe, 0.03, 0.008, 0.008, 0xd0d0d0, 0, 0, 0.065);
    boxM(this.syringe, 0.05, 0.05, 0.05, SKIN, 0.0, -0.03, 0.06);
    this.item.add(this.plateMesh, this.kitMesh, this.syringe);
    this.item.visible = false;
    this.holder.add(this.item);
  }

  /**
   * Emerald balisong: a green gem-cut blade (deep emerald at the pin to mint at the tip) and black
   * handles with emerald inlays. The fist holds handle A; the blade and handle B swing on the pivot pin.
   */
  private buildKnife() {
    const k = this.knife, HANDLE = 0x121614, PIN = 0xd8c07a;
    k.position.set(-0.004, -0.05, 0.02);
    k.scale.setScalar(1.3);
    this.rightArm.add(k);
    k.visible = false;
    const gem = (c: number, e: number) => {
      const m = new MeshLambertMaterial({ color: c, emissive: e });
      this.kGlint.push(m);
      return m;
    };
    box(k, 0.009, 0.026, 0.13, HANDLE, 0.0065, 0, -0.01);
    boxM(k, 0.0095, 0.007, 0.1, gem(0x18c47a, 0x06402a), 0.0068, 0.004, -0.01);
    box(k, 0.024, 0.01, 0.01, PIN, 0, 0, -0.072);
    box(k, 0.022, 0.006, 0.02, PIN, 0, -0.012, 0.05);
    const b = this.kBlade, h = this.kHandleB;
    b.position.set(0, 0, -0.075);
    h.position.set(0, 0, -0.075);
    k.add(b, h);
    box(b, 0.005, 0.022, 0.02, PIN, 0, 0, -0.005);
    boxM(b, 0.004, 0.023, 0.036, gem(0x0b6b40, 0x032a18), 0, 0, -0.031);
    boxM(b, 0.004, 0.022, 0.034, gem(0x14a860, 0x05402a), 0, 0.0005, -0.065);
    boxM(b, 0.004, 0.019, 0.028, gem(0x2fdc8e, 0x0a5a38), 0, 0.002, -0.095);
    boxM(b, 0.004, 0.011, 0.018, gem(0x8dffcf, 0x1a6a4a), 0, 0.005, -0.117);
    // Bevel: a pale green edge along the bottom, and a gem facet line down the flat.
    boxM(b, 0.0045, 0.004, 0.1, gem(0xd8fff0, 0x3a6a5a), 0, -0.009, -0.062);
    boxM(b, 0.0046, 0.002, 0.08, gem(0x5cffb4, 0x1a7a50), 0, 0.004, -0.07);
    box(h, 0.009, 0.026, 0.13, HANDLE, -0.0065, 0, 0.065);
    boxM(h, 0.0095, 0.007, 0.1, gem(0x18c47a, 0x06402a), -0.0068, 0.004, 0.065);
  }

  /** Y: flips, a toss, a spin and a close look at the blade. */
  inspect() {
    if (this.knifeOn && this.inspectT >= 1 && this.drawT >= 1) this.inspectT = 0;
  }

  /** Knife pose for this frame (called in the hands-out branch). */
  private updateKnife(dt: number) {
    const k = this.knife, arm = this.rightArm;
    k.position.set(-0.004, -0.05, 0.02);
    // Idle: a slow breathing sway in the wrist.
    k.rotation.set(0.35 + Math.sin(this.time * 1.7) * 0.03, Math.sin(this.time * 1.1) * 0.05, Math.sin(this.time * 1.3) * 0.04);
    let bladeAng = 0, bAng = 0, glint = 0;
    const back = (x: number) => 1 + 2.7 * Math.pow(x - 1, 3) + 1.7 * Math.pow(x - 1, 2);
    // Drawing it: comes up from below while handle B whips all the way round and the blade snaps open.
    if (this.drawT < 1) {
      this.drawT = Math.min(1, this.drawT + dt / 0.6);
      const d = this.drawT;
      arm.position.y -= (1 - seg(d, 0, 0.35)) * 0.18;
      bAng = -Math.PI * 2 * seg(d, 0.05, 0.75);
      bladeAng = Math.PI * (1 - back(clamp((d - 0.2) / 0.6, 0, 1)));
      k.rotation.z += bump(d, 0.1, 0.9) * 0.9;
      k.rotation.y -= bump(d, 0.3, 1) * 0.4;
      glint = bump(d, 0.7, 1);
    }
    if (this.inspectT < 1) {
      this.inspectT = Math.min(1, this.inspectT + dt / 3.8);
      const t = this.inspectT, up = seg(t, 0, 0.08) * (1 - seg(t, 0.92, 1));
      // Bring it up in front of you, flat of the blade toward you.
      arm.position.x -= 0.2 * up;
      arm.position.y += 0.17 * up;
      arm.position.z += 0.02 * up;
      k.rotation.x -= 0.35 * up;
      k.rotation.y += 1.25 * up;
      k.rotation.z += 0.3 * up;
      // Fan: three fast flips, the handle chasing the blade, the wrist rolling with each one.
      const f = clamp((t - 0.08) / 0.26, 0, 1);
      if (f > 0 && f < 1) {
        bladeAng = Math.PI * 6 * seg(f, 0, 1);
        bAng = -Math.PI * 6 * seg(f, 0.08, 1);
        k.rotation.z += Math.sin(f * Math.PI * 6) * 0.35;
      }
      // Toss: up it goes, tumbling twice and spinning once, then a soft catch.
      const a = clamp((t - 0.36) / 0.2, 0, 1);
      if (a > 0 && a < 1) {
        k.position.y += Math.sin(a * Math.PI) * 0.3;
        k.rotation.x += Math.PI * 4 * a;
        k.rotation.y += Math.PI * 2 * seg(a, 0.1, 0.9);
      }
      arm.position.y -= bump(t, 0.55, 0.6) * 0.035;
      // Helicopter: the whole knife spins flat round the pin.
      const hcopt = clamp((t - 0.6) / 0.14, 0, 1);
      if (hcopt > 0 && hcopt < 1) {
        bladeAng = Math.PI * 2 * seg(hcopt, 0, 1);
        k.rotation.y += Math.PI * 2 * seg(hcopt, 0, 1);
      }
      // Close look: tilt it through the light so the emerald flashes.
      const s = clamp((t - 0.76) / 0.16, 0, 1);
      if (s > 0) {
        k.rotation.z += Math.sin(s * Math.PI) * 0.9;
        k.rotation.x += Math.sin(s * Math.PI) * 0.25;
        glint = Math.max(glint, bump(s, 0.3, 0.8));
      }
    }
    // Slash: wind up on one side, sweep across the screen, alternating direction each swing.
    const pt = this.punchT;
    if (pt < 1) {
      const side = this.punchSide ? 1 : -1;
      const wind = seg(pt, 0, 0.18) * (1 - seg(pt, 0.18, 0.5));
      const sweep = seg(pt, 0.15, 0.55), home = 1 - seg(pt, 0.55, 1);
      const x = (wind * 0.1 - sweep * 0.32) * side * home;
      arm.position.x += x;
      arm.position.y += (wind * 0.08 + bump(pt, 0.15, 0.6) * 0.06 - sweep * 0.1 * home);
      arm.position.z -= bump(pt, 0.1, 0.75) * 0.22;
      k.rotation.z += (wind * 0.7 - sweep * 1.3) * side * home;
      k.rotation.x -= bump(pt, 0.1, 0.7) * 0.6;
      k.rotation.y += bump(pt, 0.15, 0.6) * 0.35 * side;
      glint = Math.max(glint, bump(pt, 0.2, 0.6) * 0.6);
    }
    this.kBlade.rotation.x = bladeAng;
    this.kHandleB.rotation.x = bAng;
    for (const m of this.kGlint) m.emissiveIntensity = 1 + glint * 2.2;
  }

  /** Outfit colours for the sleeves; glowing cuffs on the special skins. */
  setSkin(sleeve: number, cuff: number, glow: number) {
    this.sleeveMat.color.setHex(sleeve);
    this.cuffMat.color.setHex(cuff);
    this.cuffMat.emissive.setHex(glow ? glow : 0);
    this.cuffMat.emissiveIntensity = glow ? 0.6 : 0;
  }

  /** Throw a punch (alternating hands). */
  punch() {
    this.inspectT = 1;
    this.punchT = 0;
    this.punchSide = 1 - this.punchSide;
  }

  /** Plate: lifted into view, then slammed down into the vest. Medkit: opened, then a jab. */
  private updateItem(dt: number, heal: ViewState['heal']) {
    this.healT = damp(this.healT, heal ? 1 : 0, 12, dt);
    this.item.visible = !!heal;
    if (!heal) return;
    const t = heal.t, it = this.item;
    const up = ease(seg(t, 0, 0.22));
    this.plateMesh.visible = heal.type === 'plate';
    this.kitMesh.visible = this.syringe.visible = heal.type === 'medkit';
    if (heal.type === 'plate') {
      const slam = ease(seg(t, 0.72, 0.95));
      it.position.set(-0.04 + slam * 0.05, -0.5 + up * 0.32 - slam * 0.2 + Math.sin(t * 20) * 0.003, -0.36 + slam * 0.12);
      it.rotation.set(-0.35 - slam * 1.0, 0.25 - up * 0.2, 0.15 - up * 0.1);
    } else {
      const jab = seg(t, 0.45, 0.62) * (1 - seg(t, 0.72, 0.88)), down = ease(seg(t, 0.88, 1));
      it.position.set(0.0, -0.46 + up * 0.26 - down * 0.25, -0.36);
      it.rotation.set(-0.5, 0.1, 0.05 + Math.sin(t * 14) * 0.02);
      this.syringe.position.set(0.1 - jab * 0.06, 0.05 - jab * 0.12, 0.02 + jab * 0.04);
      this.syringe.rotation.set(-0.3 - jab * 0.6, -0.4, 0);
    }
  }

  /** Mouse movement this frame, for weapon sway. */
  addLook(dx: number, dy: number) {
    this.lookX += dx;
    this.lookY += dy;
  }

  land(intensity: number) {
    this.landVel -= clamp(intensity, 0, 20) * 0.03;
  }

  get sightY() {
    return this.parts?.sightY ?? 0.1;
  }

  private attKey = '';

  /** Forces a rebuild (after an attachment or camo change). */
  refresh() {
    this.partsFor = null;
    this.attKey = '';
  }

  setWeapon(w: WeaponInstance | null) {
    const key = w ? attKey(w) : '';
    if (w === this.partsFor && key === this.attKey) return;
    this.attKey = key;
    if (this.parts) this.pose.remove(this.parts.root);
    this.partsFor = w;
    this.parts = w ? buildViewGun(w) : null;
    this.homes.clear();
    if (this.parts) {
      this.pose.add(this.parts.root);
      for (const o of [this.parts.mag, this.parts.slide, this.parts.pump, this.parts.bolt]) if (o) this.homes.set(o, o.position.clone());
      this.flash.position.copy(this.parts.muzzle);
    }
    this.rightArm.visible = this.leftHand.visible = !!this.parts;
  }

  /** Viewmodel-space point -> world space (the viewmodel camera sits at the main camera's eye). */
  private toWorld(local: Vector3, out: Vector3) {
    this.pose.updateWorldMatrix(true, false);
    this.pose.localToWorld(out.copy(local));
    this.camera.updateMatrixWorld();
    return this.camera.localToWorld(out);
  }

  muzzleWorld(out: Vector3) {
    if (!this.parts) return this.camera.getWorldPosition(out);
    return this.toWorld(this.parts.muzzle, out);
  }

  /** Draw the viewmodel on top of the already-rendered world. */
  render(renderer: WebGLRenderer, aspect: number) {
    if (!this.holder.visible) return;
    if (this.vmCamera.aspect !== aspect) {
      this.vmCamera.aspect = aspect;
      this.vmCamera.updateProjectionMatrix();
    }
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.vmScene, this.vmCamera);
    renderer.autoClear = true;
  }

  onFire(w: WeaponInstance, adsAmount: number) {
    const heavy = w.def.pellets > 1 || w.def.id === 'sniper' || w.def.id === 'rocket' || w.def.id === 'revolver';
    const a = lerp(1, 0.45, adsAmount);
    this.kickZ += (heavy ? 0.07 : w.def.id === 'pistol' ? 0.035 : 0.022) * a;
    this.kickPitch += (heavy ? 0.16 : w.def.id === 'pistol' ? 0.09 : 0.035) * a;
    this.kickRoll += (Math.random() - 0.5) * (heavy ? 0.1 : 0.04) * a;
    this.flashTime = 0.05;
    this.flash.rotation.z = Math.random() * Math.PI;
    // Aimed in, the flash shrinks right down so it doesn't hide what you're shooting at.
    this.flash.scale.setScalar((heavy ? 1.5 : 1) * (0.8 + Math.random() * 0.4) * (1 - 0.8 * adsAmount));
    this.flashAds = adsAmount;
    this.ejectedFor = -1;
    // Semi-auto and automatic guns eject immediately; pump/bolt guns eject while cycling.
    if (w.def.id !== 'shotgun' && w.def.id !== 'sniper' && w.def.id !== 'rocket' && w.def.id !== 'revolver') this.ejectCasing(false);
  }

  private ejectCasing(shell: boolean) {
    if (!this.parts) return;
    let c = this.casings.find((k) => k.life <= 0);
    if (!c) {
      if (this.casings.length >= 24) return;
      c = { mesh: new Mesh(unit, new MeshLambertMaterial()), vel: new Vector3(), spin: new Vector3(), life: 0 };
      this.scene.add(c.mesh);
      this.casings.push(c);
    }
    (c.mesh.material as MeshLambertMaterial).color.setHex(shell ? 0xc0302a : 0xd4a93a);
    c.mesh.scale.set(shell ? 0.022 : 0.012, shell ? 0.022 : 0.012, shell ? 0.055 : 0.03);
    this.toWorld(this.parts.eject, c.mesh.position);
    const m = this.camera.matrixWorld;
    const right = tmpA.setFromMatrixColumn(m, 0), up = tmpB.setFromMatrixColumn(m, 1);
    c.vel.copy(right).multiplyScalar(1.6 + Math.random()).addScaledVector(up, 1.6 + Math.random());
    c.spin.set(Math.random() * 20, Math.random() * 20, Math.random() * 20);
    c.mesh.visible = true;
    c.life = 0.9;
  }

  update(dt: number, s: ViewState) {
    this.time += dt;
    this.updateCasings(dt);
    const P = this.parts, p = s.player;
    this.flashTime -= dt;
    const flashing = this.flashTime > 0;
    this.flash.visible = flashing;
    this.flashLight.intensity = flashing ? 3 * (1 - 0.8 * this.flashAds) : 0;
    this.updateItem(dt, s.heal);
    const glide = !!s.glide;
    for (const t of this.toggles) t.visible = glide;
    if (P) P.root.visible = !glide;
    if (glide) {
      // Hands up on the brake toggles; turning pulls one side down.
      this.glideT = Math.min(1, this.glideT + dt * 3);
      this.swayX = damp(this.swayX, clamp(this.lookX * 0.004, -1, 1), 5, dt);
      this.lookX = this.lookY = 0;
      const rise = (1 - ease(this.glideT)) * 0.3, drift = Math.sin(this.time * 1.4) * 0.012;
      this.rightArm.visible = this.leftHand.visible = false;
      this.flash.visible = false;
      this.pose.position.set(0, -rise, -0.72);
      this.pose.rotation.set(0, 0, 0);
      const [r, l] = this.toggles;
      r.position.set(0.46, 0.34 + drift - Math.max(0, this.swayX) * 0.14, 0);
      l.position.set(-0.46, 0.34 - drift - Math.max(0, -this.swayX) * 0.14, 0);
      return;
    }
    this.glideT = 0;
    if (P) {
      this.rightArm.visible = this.leftHand.visible = true;
      // Holding a gun: the knife is put away (even mid-inspect), and comes back out with a fresh draw.
      this.knife.visible = false;
      this.wasKnife = false;
      this.inspectT = 1;
    }
    if (!P) {
      this.lookX = this.lookY = 0;
      // Hands out: fists pumping as you run.
      const fists = s.player.unarmed && s.player.alive;
      this.rightArm.visible = this.leftHand.visible = fists;
      const knife = fists && this.knifeOn;
      this.knife.visible = knife;
      if (knife && !this.wasKnife) {
        this.drawT = 0;
        this.inspectT = 1;
      }
      this.wasKnife = knife;
      if (knife) {
        const hs = Math.hypot(p.body.vel.x, p.body.vel.z);
        if (p.body.onGround) this.bobPhase += dt * hs * 1.1;
        const pump = Math.sin(this.bobPhase) * Math.min(1, hs / 8) * 0.06;
        this.pose.position.set(0, -0.2 - Math.abs(Math.cos(this.bobPhase)) * 0.012 * Math.min(1, hs / 8), -0.42);
        this.pose.rotation.set(0.15, 0, 0);
        this.rightArm.position.set(0.26, -0.03 + pump * 0.3, pump);
        this.leftHand.position.set(-0.34, -0.2 - pump * 0.3, 0.05 - pump);
        this.punchT = Math.min(1, this.punchT + dt / 0.34);
        this.updateKnife(dt);
        if (s.heal) this.leftHand.position.y -= this.healT * 0.4;
      } else if (fists) {
        const hs = Math.hypot(p.body.vel.x, p.body.vel.z);
        if (p.body.onGround) this.bobPhase += dt * hs * 1.1;
        const pump = Math.sin(this.bobPhase) * Math.min(1, hs / 8) * 0.12;
        this.pose.position.set(0, -0.2 - Math.abs(Math.cos(this.bobPhase)) * 0.015 * Math.min(1, hs / 8), -0.42);
        this.pose.rotation.set(0.15, 0, 0);
        this.rightArm.position.set(0.3, -0.05 + pump * 0.3, pump);
        this.leftHand.position.set(-0.3, -0.05 - pump * 0.3, -pump);
        // Punch: one fist drives forward toward the centre of the screen and snaps back.
        this.punchT = Math.min(1, this.punchT + dt / 0.34);
        const k = Math.sin(Math.PI * Math.min(1, this.punchT * 1.5)) * (this.punchT < 1 ? 1 : 0);
        const arm = this.punchSide ? this.rightArm : this.leftHand, dir = this.punchSide ? -1 : 1;
        arm.position.x += dir * k * 0.22;
        arm.position.y += k * 0.14;
        arm.position.z -= k * 0.34;
        if (s.heal) this.leftHand.position.y -= this.healT * 0.4;
      }
      return;
    }
    this.rightArm.position.set(0, 0, 0);
    const ads = s.ads, hipK = 1 - ads;
    const pos = tmpPos.copy(P.hip).lerp(tmpB.set(0, -P.sightY * SCALE, P.adsZ), ads);
    let rx = 0, ry = hipK * 0.07, rz = -hipK * 0.03;

    // Sprint pose: gun swings across the body
    this.sprintT = damp(this.sprintT, p.sprinting && !s.reload ? 1 : 0, 9, dt);
    pos.x += this.sprintT * 0.02;
    pos.y -= this.sprintT * 0.05;
    rx -= this.sprintT * 0.25;
    ry += this.sprintT * 0.65;
    rz += this.sprintT * 0.2;

    // Walk bob (figure-eight) and idle breathing
    const hs = Math.hypot(p.body.vel.x, p.body.vel.z);
    if (p.body.onGround && !p.sliding) this.bobPhase += dt * hs * 1.25;
    const amt = (1 - ads * 0.85) * Math.min(hs / 9, 1) * (1 + this.sprintT * 0.8);
    pos.x += Math.sin(this.bobPhase) * 0.012 * amt;
    pos.y -= Math.abs(Math.cos(this.bobPhase)) * 0.014 * amt;
    rz += Math.sin(this.bobPhase) * 0.025 * amt;
    pos.y += Math.sin(this.time * 1.7) * 0.0025 * hipK;
    rx += Math.sin(this.time * 1.3) * 0.006 * hipK;

    // Sway: the gun lags behind your mouse
    const swayK = 1 - ads * 0.75;
    this.swayX = damp(this.swayX, clamp(-this.lookX * 0.0012, -0.08, 0.08), 8, dt);
    this.swayY = damp(this.swayY, clamp(-this.lookY * 0.0012, -0.06, 0.06), 8, dt);
    this.lookX = this.lookY = 0;
    ry += this.swayX * swayK;
    rx += this.swayY * swayK;
    pos.x += this.swayX * 0.12 * swayK;
    pos.y += this.swayY * 0.08 * swayK;

    // Air, landing, sliding
    if (!p.body.onGround) pos.y += clamp(-p.body.vel.y * 0.0025, -0.03, 0.03) * hipK;
    this.landVel += (-this.landDip * 160 - this.landVel * 13) * dt;
    this.landDip += this.landVel * dt;
    // Aimed in, the sight stays on the crosshair: body motion only moves the gun from the hip.
    const dipK = 1 - ads * 0.9;
    pos.y += this.landDip * dipK;
    rx += this.landDip * 1.5 * dipK;
    this.slideT = damp(this.slideT, p.sliding ? 1 : 0, 10, dt);
    rz += this.slideT * 0.3 * hipK;
    pos.x -= this.slideT * 0.02 * hipK;

    // Equip: gun swings up from below
    const e = ease(clamp(s.equip, 0, 1));
    pos.y -= e * 0.2;
    rx -= e * 0.9;
    rz += e * 0.3;

    // Healing / plating: lower the gun (right out of view while your hands are busy with the item)
    this.busyT = damp(this.busyT, s.busy ? 1 : 0, 10, dt);
    pos.y -= this.busyT * 0.16 + this.healT * 0.22;
    rx -= this.busyT * 0.7;

    // Recoil springs
    this.kickZ = damp(this.kickZ, 0, 14, dt);
    this.kickPitch = damp(this.kickPitch, 0, 11, dt);
    this.kickRoll = damp(this.kickRoll, 0, 10, dt);
    pos.z += this.kickZ;
    pos.y += this.kickPitch * 0.04;
    rx += this.kickPitch;
    rz += this.kickRoll;

    // Reset animated parts
    for (const [o, h] of this.homes) o.position.copy(h);
    if (P.mag) P.mag.visible = true;
    if (P.bolt) P.bolt.rotation.z = 0;
    this.shellInHand.visible = false;
    const hand = tmpHand.copy(P.support);

    const r = s.reload;
    if (r && r.kind === 'mag') {
      const t = r.t;
      const tilt = seg(t, 0, 0.15) * (1 - seg(t, 0.85, 1));
      rz -= tilt * (P.id === 'pistol' ? 0.3 : 0.4);
      rx += tilt * 0.22;
      ry += tilt * 0.12;
      pos.x -= tilt * 0.045;
      pos.y += tilt * 0.03;
      // Bolt gun opens its bolt first
      if (P.bolt) {
        const up = seg(t, 0.05, 0.14) * (1 - seg(t, 0.86, 0.95)), back = seg(t, 0.14, 0.24) * (1 - seg(t, 0.76, 0.86));
        P.bolt.rotation.z = up * 1.2;
        P.bolt.position.z += back * 0.09;
      }
      if (P.mag) {
        const home = this.homes.get(P.mag)!;
        if (t < 0.34) P.mag.position.y = home.y - seg(t, 0.14, 0.3) * 0.4;
        else P.mag.position.y = home.y - (1 - seg(t, 0.4, 0.58)) * 0.32;
        P.mag.visible = t < 0.3 || t > 0.4;
      }
      // Slap it home
      pos.y += bump(t, 0.58, 0.66) * 0.014;
      rx += bump(t, 0.58, 0.66) * 0.06;
      // Charge / rack
      if (P.slide) P.slide.position.z += bump(t, 0.7, 0.84) * (P.id === 'pistol' ? 0.045 : 0.07);
      // Left hand choreography
      const down = tmpC.copy(P.magWell).add(tmpD.set(0, -0.35, 0.1));
      const keys: [number, Vector3][] = [
        [0.08, P.support], [0.2, P.magWell], [0.32, down], [0.4, down], [0.58, P.magWell], [0.64, P.magWell],
      ];
      if (P.slide) keys.push([0.7, P.handle], [0.84, tmpE.copy(P.handle).setZ(P.handle.z + 0.07)], [0.95, P.support]);
      else keys.push([0.8, P.support]);
      path(hand, t, P.support, keys);
    } else if (r) {
      // Shotgun: tilt, feed shells one by one, pump.
      const tilt = r.kind === 'shell-start' ? seg(r.t, 0, 1) : r.kind === 'shell-end' ? 1 - seg(r.t, 0, 0.45) : 1;
      rz -= tilt * 0.5;
      rx += tilt * 0.12;
      pos.x -= tilt * 0.02;
      const port = P.magWell, low = tmpC.copy(port).add(tmpD.set(-0.02, -0.28, 0.12));
      if (r.kind === 'shell-start') hand.lerpVectors(P.support, port, seg(r.t, 0.2, 1));
      else if (r.kind === 'shell') {
        hand.lerpVectors(port, low, bump(r.t, 0, 0.75));
        this.shellInHand.visible = r.t > 0.35 && r.t < 0.85;
        pos.y += bump(r.t, 0.78, 0.95) * 0.006;
      } else {
        const pump = bump(r.t, 0.4, 1) * 0.08;
        if (P.pump) P.pump.position.z += pump;
        hand.lerpVectors(port, P.support, seg(r.t, 0, 0.4)).z += pump;
      }
    } else if (s.sinceShot < s.cycle + 0.05) {
      // Post-shot cycling: pistol slide, shotgun pump, sniper bolt
      const c = s.sinceShot / s.cycle;
      if (P.id === 'pistol' && P.slide) P.slide.position.z += bump(s.sinceShot, 0, 0.09) * 0.045;
      if (P.pump) {
        const pump = bump(c, 0.25, 0.7) * 0.085;
        P.pump.position.z += pump;
        hand.z += pump;
        if (c > 0.45 && this.ejectedFor < 0) this.ejectOnce(true);
      }
      if (P.bolt) {
        const up = seg(c, 0.15, 0.25) * (1 - seg(c, 0.62, 0.72)), back = seg(c, 0.25, 0.4) * (1 - seg(c, 0.47, 0.6));
        P.bolt.rotation.z = up * 1.2;
        P.bolt.position.z += back * 0.09;
        rx -= up * 0.06;
        if (c > 0.4 && this.ejectedFor < 0) this.ejectOnce(false);
      }
    }
    this.leftHand.position.copy(hand);

    this.pose.position.copy(pos);
    this.pose.rotation.set(rx, ry, rz);
  }

  private ejectOnce(shell: boolean) {
    this.ejectedFor = 1;
    this.ejectCasing(shell);
  }

  private updateCasings(dt: number) {
    for (const c of this.casings) {
      if (c.life <= 0) continue;
      c.life -= dt;
      c.vel.y -= 9.8 * dt;
      c.mesh.position.addScaledVector(c.vel, dt);
      c.mesh.rotation.x += c.spin.x * dt;
      c.mesh.rotation.y += c.spin.y * dt;
      c.mesh.rotation.z += c.spin.z * dt;
      if (c.life <= 0) c.mesh.visible = false;
    }
  }

  setVisible(v: boolean) {
    this.holder.visible = v;
  }
}

/** Piecewise-eased path through keyframes [(time, position)], starting from `start` at t=0. */
function path(out: Vector3, t: number, start: Vector3, keys: [number, Vector3][]) {
  let prevT = 0, prev = start;
  for (const [kt, kp] of keys) {
    if (t <= kt) {
      out.lerpVectors(prev, kp, ease(clamp((t - prevT) / Math.max(1e-4, kt - prevT), 0, 1)));
      return out;
    }
    prevT = kt;
    prev = kp;
  }
  return out.copy(prev);
}

const tmpPos = new Vector3(), tmpA = new Vector3(), tmpB = new Vector3(), tmpC = new Vector3(), tmpD = new Vector3(), tmpE = new Vector3();
const tmpHand = new Vector3();
