import { BoxGeometry, BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial, Quaternion, Vector3, type Object3D } from 'three';
import type { Skin } from '../game/Skins';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mergeToGeometry } from '../core/merge';
import { attKey, buildGunModel, type WeaponInstance } from '../weapons/Weapon';

function coloredBox(w: number, h: number, d: number, x: number, y: number, z: number, color: Color) {
  const g = new BoxGeometry(w, h, d).toNonIndexed();
  g.translate(x, y, z);
  const n = g.getAttribute('position').count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([color.r, color.g, color.b], i * 3);
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

const gunCache = new Map<string, BufferGeometry>();
const gunMat = new MeshLambertMaterial({ vertexColors: true });

function gunGeometry(w: WeaponInstance) {
  const key = `${w.def.id}:${w.rarity.tier}:${attKey(w)}:${w.def.bodyColor}`;
  let g = gunCache.get(key);
  if (!g) gunCache.set(key, (g = mergeToGeometry(buildGunModel(w))));
  return g;
}

/** A special outfit's glowing seams, visor and crest: unlit, so they read at night too. */
function glowParts(o: Skin) {
  const g = new Color(o.glow), v = new Color(o.visor);
  const p = [
    coloredBox(0.31, 0.07, 0.05, 0, 1.63, -0.19, v), // visor
    coloredBox(0.05, 0.62, 0.02, 0, 1.12, -0.185, g), // chest seam
    coloredBox(0.66, 0.04, 0.4, 0, 0.84, 0, g), // belt
    coloredBox(0.05, 0.05, 0.38, -0.33, 1.4, 0, g), // shoulder seams
    coloredBox(0.05, 0.05, 0.38, 0.33, 1.4, 0, g),
    coloredBox(0.3, 0.05, 0.03, 0, 1.3, 0.37, g), // backpack light
  ];
  if (o.crest === 'fin') {
    p.push(coloredBox(0.05, 0.12, 0.4, 0, 1.83, 0.02, g), coloredBox(0.05, 0.08, 0.14, 0, 1.9, 0.12, g));
  } else if (o.crest === 'horns') {
    for (const s of [-1, 1]) p.push(coloredBox(0.07, 0.07, 0.07, s * 0.2, 1.74, -0.02, g), coloredBox(0.06, 0.16, 0.06, s * 0.25, 1.83, -0.02, g), coloredBox(0.05, 0.08, 0.05, s * 0.27, 1.94, -0.06, g));
  } else if (o.crest === 'mohawk') {
    for (let i = 0; i < 5; i++) p.push(coloredBox(0.05, 0.1 + (i % 2) * 0.05 + (i === 2 ? 0.04 : 0), 0.07, 0, 1.82 + (i % 2) * 0.02, -0.14 + i * 0.07, g));
  } else if (o.crest === 'halo') {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      p.push(coloredBox(0.07, 0.025, 0.07, Math.cos(a) * 0.2, 2.0, Math.sin(a) * 0.2, g));
    }
  } else if (o.crest === 'corona') {
    // A thin ring standing behind the head, like the sun's rim around the moon.
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      p.push(coloredBox(0.04, 0.04, 0.02, Math.cos(a) * 0.3, 1.64 + Math.sin(a) * 0.3, 0.24, g));
    }
  } else if (o.crest === 'crown') {
    for (const [x, z, h] of [[-0.12, -0.12, 0.2], [0.12, -0.12, 0.2], [0, -0.14, 0.28], [-0.13, 0.1, 0.14], [0.13, 0.1, 0.14]]) p.push(coloredBox(0.06, h, 0.06, x, 1.78 + h / 2, z, g));
  }
  return new Mesh(mergeGeometries(p)!, new MeshBasicMaterial({ vertexColors: true }));
}

const Z = new Vector3(0, 0, 1);
const SHOULDER_R = new Vector3(0.37, 1.4, 0), SHOULDER_L = new Vector3(-0.37, 1.4, 0);
/** Where the hands hold the gun (the gun sits at 0.22, 1.22, -0.3). */
const GRIP = new Vector3(0.22, 1.14, -0.27), FOREGRIP = new Vector3(0.2, 1.2, -0.62);
const POSE_LEN = 0.55;

/** An arm pointing along +z from the shoulder: sleeve then hand. */
function armGeometry(len: number, sleeve: Color, skin: Color) {
  return mergeGeometries([coloredBox(0.13, 0.13, len - 0.06, 0, 0, (len - 0.06) / 2, sleeve), coloredBox(0.11, 0.11, 0.12, 0, 0, len, skin)])!;
}
function armTo(from: Vector3, to: Vector3, sleeve: Color, skin: Color) {
  const d = to.clone().sub(from), g = armGeometry(d.length(), sleeve, skin);
  g.applyQuaternion(new Quaternion().setFromUnitVectors(Z, d.normalize()));
  g.translate(from.x, from.y, from.z);
  return g;
}

/**
 * A blocky soldier: torso, head, visor and backpack are baked into one vertex-coloured mesh,
 * legs swing separately, and the gun is a cached merged mesh. ~4 draw calls per character.
 */
export class Character {
  root = new Group();
  private body: Mesh;
  private legs: Mesh[] = [];
  private gun: Mesh | null = null;
  private gunHolder = new Group();
  private mat: MeshLambertMaterial;
  private walkPhase = 0;
  private flash = 0;
  private crouchK = 0;
  /** Shoulder pivots when the character is posable (the lobby hero); otherwise the arms are baked in. */
  private armPivots: Group[] = [];
  private back: Object3D | null = null;

  constructor(suit: Color, trim: Color, marker?: number, outfit?: Skin, posable = false) {
    this.mat = new MeshLambertMaterial({ vertexColors: true });
    if (outfit) {
      suit = new Color(outfit.suit);
      trim = new Color(outfit.trim);
    }
    const skin = new Color(outfit?.face ?? 0xe0b48f), visor = new Color(outfit?.glow ? 0x0c0e12 : 0x222831);
    const eyes = outfit?.eyes ?? 'visor';
    const parts = [
      coloredBox(0.62, 0.7, 0.36, 0, 1.12, 0, suit),
      coloredBox(0.34, 0.36, 0.34, 0, 1.6, 0, skin),
      coloredBox(0.45, 0.45, 0.2, 0, 1.15, 0.26, trim),
      coloredBox(0.64, 0.08, 0.38, 0, 0.8, 0, trim),
    ];
    if (eyes === 'visor') parts.push(coloredBox(0.3, 0.1, 0.05, 0, 1.63, -0.18, visor));
    else if (eyes === 'dots') for (const x of [-0.07, 0.07]) parts.push(coloredBox(0.05, 0.05, 0.03, x, 1.64, -0.18, new Color(0x1a1a1a)));
    for (const [w, h, d, x, y, z, c] of outfit?.parts ?? []) parts.push(coloredBox(w, h, d, x, y, z, new Color(c)));
    if (marker !== undefined) parts.push(coloredBox(0.36, 0.08, 0.36, 0, 1.82, 0, new Color(marker)));
    if (!posable) parts.push(armTo(SHOULDER_R, GRIP, suit, skin), armTo(SHOULDER_L, FOREGRIP, suit, skin));
    this.body = new Mesh(mergeGeometries(parts)!, this.mat);
    if (posable) {
      const geo = armGeometry(POSE_LEN, suit, skin);
      for (const s of [SHOULDER_R, SHOULDER_L]) {
        const pivot = new Group();
        pivot.position.copy(s);
        pivot.add(new Mesh(geo, this.mat));
        this.armPivots.push(pivot);
        this.root.add(pivot);
      }
      this.pose(null, null);
    }
    if (outfit && outfit.glow) this.root.add(glowParts(outfit));
    const legGeo = coloredBox(0.24, 0.78, 0.26, 0, -0.39, 0, trim);
    for (const x of [-0.16, 0.16]) {
      const leg = new Mesh(legGeo, this.mat);
      leg.position.set(x, 0.78, 0);
      this.legs.push(leg);
      this.root.add(leg);
    }
    this.gunHolder.position.set(0.22, 1.22, -0.3);
    this.root.add(this.body, this.gunHolder);
    this.root.traverse((o) => (o.castShadow = true));
  }

  get legsList() {
    return this.legs;
  }

  get gunMount() {
    return this.gunHolder;
  }

  /** Resting arm directions: holding the gun. */
  static get holdDirs() {
    return [GRIP.clone().sub(SHOULDER_R).normalize(), FOREGRIP.clone().sub(SHOULDER_L).normalize()];
  }

  /** Point the arms (posable characters only). Directions are in character space; null = holding the gun. */
  pose(right: Vector3 | null, left: Vector3 | null) {
    if (!this.armPivots.length) return;
    const [hr, hl] = Character.holdDirs;
    this.armPivots[0].quaternion.setFromUnitVectors(Z, (right ?? hr).clone().normalize());
    this.armPivots[1].quaternion.setFromUnitVectors(Z, (left ?? hl).clone().normalize());
  }

  /** Back bling model (or null for the plain backpack). */
  setBack(model: Object3D | null) {
    if (this.back) this.root.remove(this.back);
    this.back = model;
    if (model) this.root.add(model);
  }

  setGun(w: WeaponInstance | null) {
    if (this.gun) this.gunHolder.remove(this.gun);
    this.gun = null;
    if (!w) return;
    this.gun = new Mesh(gunGeometry(w), gunMat);
    this.gun.scale.setScalar(1.3);
    this.gun.castShadow = true;
    this.gunHolder.add(this.gun);
  }

  hit() {
    this.flash = 0.1;
  }

  /** Walk cycle, crouch squash, hit flash. */
  animate(dt: number, speed: number, onGround: boolean, crouched: boolean, seated = false) {
    this.walkPhase += dt * speed * 1.6;
    const swing = seated ? -1.3 : onGround ? Math.sin(this.walkPhase) * Math.min(speed / 6, 1) * 0.6 : 0.3;
    this.legs[0].rotation.x = seated ? swing : swing;
    this.legs[1].rotation.x = seated ? swing : -swing;
    this.crouchK += ((crouched || seated ? 1 : 0) - this.crouchK) * Math.min(1, dt * 12);
    this.root.scale.y = 1 - this.crouchK * 0.3;
    this.flash -= dt;
    this.mat.emissive.setHex(this.flash > 0 ? 0x993322 : 0x000000);
  }
}
