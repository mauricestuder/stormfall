import { BufferAttribute, BufferGeometry, Color, Matrix4, Mesh, Vector3, type Material, type Object3D } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import akSrc from './toon/guns/AK.gltf?raw';
import pistolSrc from './toon/guns/Pistol.gltf?raw';
import revolverSrc from './toon/guns/Revolver.gltf?raw';
import smgSrc from './toon/guns/SMG.gltf?raw';
import cannonSrc from './toon/guns/ShortCannon.gltf?raw';
import shotgunSrc from './toon/guns/Shotgun.gltf?raw';
import sniperSrc from './toon/guns/Sniper.gltf?raw';
import sniper2Src from './toon/guns/Sniper_2.gltf?raw';
import rocketSrc from './toon/guns/RocketLauncher.gltf?raw';

/**
 * Quaternius "Toon Shooter Game Kit" (CC0): the guns, all in one cartoon style. Each is baked at
 * load into one vertex-coloured geometry. (The soldiers themselves are built in code: bots/ArmyRig.)
 */

const GUN_SRC: Record<string, string> = {
  AK: akSrc, Pistol: pistolSrc, Revolver: revolverSrc, SMG: smgSrc, ShortCannon: cannonSrc,
  Shotgun: shotgunSrc, Sniper: sniperSrc, Sniper_2: sniper2Src, RocketLauncher: rocketSrc,
};
/** Each gun: its model and its own paint job, so you can tell them apart at a glance. Keys are material names. */
export const GUN_LOOK: Record<string, { model: string; pal: Record<string, number> }> = {
  pistol: { model: 'Pistol', pal: { Grey: 0x2c3036, DarkGrey: 0x16181b, Wood: 0xc9a46a } },
  revolver: { model: 'Revolver', pal: { Grey: 0xd8dde4, Grey2: 0x9aa3ae, DarkGrey: 0x3a3f46, Wood: 0x8a3a1e } },
  smg: { model: 'SMG', pal: { Grey: 0xd9b56e, Grey2: 0x7a5f34, DarkGrey: 0x26282c, Black: 0x141414 } },
  burst: { model: 'AK', pal: { Grey: 0x2c4f86, Grey2: 0x1b2433, DarkGrey: 0x141a24, Wood: 0xd8dde4 } },
  ar: { model: 'AK', pal: { Grey: 0x4e6b34, Grey2: 0x2e3a22, DarkGrey: 0x1e2218, Wood: 0xb06a2c } },
  lmg: { model: 'ShortCannon', pal: { Grey: 0x5a5a2e, DarkGrey: 0x22241c, Wood: 0xd6a53a } },
  shotgun: { model: 'Shotgun', pal: { Grey: 0xc0392b, Grey2: 0x2a2c30, DarkGrey: 0x1a1b1e, Wood: 0x9a5a28 } },
  dmr: { model: 'Sniper_2', pal: { Grey: 0x8a7552, DarkGrey: 0x2a2620, Wood: 0x6a3a1a } },
  sniper: { model: 'Sniper', pal: { Grey: 0x1f5a5a, DarkGrey: 0x14181c, Black: 0x0a0a0a } },
  rocket: { model: 'RocketLauncher', pal: { Grey: 0x5e6e30, DarkGrey: 0x2a3018, Black: 0x16180f, Red: 0xe8402a } },
};
const MYTHIC: Record<string, number> = { Grey: 0xe83cb8, Grey2: 0x9a1a78, Wood: 0xff9ae6 };

const viewGuns = new Map<string, { geo: BufferGeometry; mats: string[]; groups: number[] }>();

const parse = (src: string) => new Promise<GLTF>((ok, fail) => new GLTFLoader().parse(src, '', ok, fail));

/**
 * Merge a set of meshes into one geometry (position, normal).
 * `mats` records each vertex group's material name so the colours can be painted later.
 */
function collect(meshes: { mesh: Mesh; m: Matrix4 }[]) {
  const geos: BufferGeometry[] = [], mats: string[] = [], groups: number[] = [];
  for (const { mesh, m } of meshes) {
    const src = mesh.geometry;
    const g = new BufferGeometry();
    g.setAttribute('position', src.getAttribute('position').clone());
    g.setAttribute('normal', src.getAttribute('normal').clone());
    if (src.index) g.setIndex(src.index.clone());
    g.applyMatrix4(m);
    const ng = g.index ? g.toNonIndexed() : g;
    geos.push(ng);
    mats.push((mesh.material as Material).name);
    groups.push(ng.getAttribute('position').count);
  }
  return { geo: mergeGeometries(geos)!, mats, groups };
}

/** Vertex colours from material names: palette overrides first, else the model's own colour. */
function paint(p: { geo: BufferGeometry; mats: string[]; groups: number[] }, base: Map<string, Color>, pal: Record<string, number> = {}) {
  const g = p.geo.clone(), col = new Float32Array(g.getAttribute('position').count * 3), c = new Color();
  let v = 0;
  p.mats.forEach((name, i) => {
    if (pal[name] !== undefined) c.setHex(pal[name]);
    else c.copy(base.get(name) ?? new Color(0x808080));
    for (let k = 0; k < p.groups[i]; k++, v++) col.set([c.r, c.g, c.b], v * 3);
  });
  g.setAttribute('color', new BufferAttribute(col, 3));
  return g;
}

const baseColors = new Map<string, Color>();
function noteColors(root: Object3D) {
  root.traverse((o) => {
    const m = (o as Mesh).material as (Material & { color?: Color }) | undefined;
    if (m && m.color && !baseColors.has(m.name)) baseColors.set(m.name, m.color.clone());
  });
}

let ready = false;
export const toonReady = () => ready;

/** Parse the models (once, before the game builds anything). */
export async function loadToon() {
  for (const [name, src] of Object.entries(GUN_SRC)) {
    const g = await parse(src);
    g.scene.updateMatrixWorld(true);
    noteColors(g.scene);
    const ms: { mesh: Mesh; m: Matrix4 }[] = [];
    g.scene.traverse((o) => {
      if ((o as Mesh).isMesh) ms.push({ mesh: o as Mesh, m: o.matrixWorld.clone() });
    });
    const c = collect(ms);
    // Barrel along -X in the file; turn it to -Z (forward in gun space).
    c.geo.rotateY(-Math.PI / 2);
    viewGuns.set(name, c);
  }
  ready = true;
}

const gunGeoCache = new Map<string, BufferGeometry>();
/**
 * A gun on its own (first person, loot, lockers), barrel along -Z, grip at the origin, `len` long.
 * Painted in the weapon's colours (pink for Mythic).
 */
export function toonGunGeometry(id: string, mythic: boolean, len: number, camo: number | null = null) {
  const key = `${id}:${mythic}:${len}:${camo}`;
  let g = gunGeoCache.get(key);
  if (!g) {
    const look = GUN_LOOK[id] ?? GUN_LOOK.ar, src = viewGuns.get(look.model)!;
    g = paint(src, baseColors, mythic ? { ...look.pal, ...MYTHIC } : camo !== null ? { ...look.pal, Grey: camo } : look.pal);
    g.computeBoundingBox();
    const b = g.boundingBox!, k = len / (b.max.z - b.min.z);
    g.scale(k, k, k);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    gunGeoCache.set(key, g);
  }
  return g;
}

/**
 * Measurements of a gun geometry: the muzzle (front end, at barrel height), the top (sight line)
 * and how low the gun reaches at a given z (where the left hand goes).
 */
export function gunInfo(g: BufferGeometry) {
  const p = g.getAttribute('position');
  g.computeBoundingBox();
  const b = g.boundingBox!, len = b.max.z - b.min.z;
  let my = 0, mn = 0, top = -Infinity;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), z = p.getZ(i);
    if (z < b.min.z + len * 0.04) {
      my += y;
      mn++;
    }
    if (z > b.min.z + len * 0.25) top = Math.max(top, y);
  }
  const bottomAt = (z: number) => {
    let lo = Infinity;
    for (let i = 0; i < p.count; i++) if (Math.abs(p.getZ(i) - z) < len * 0.06) lo = Math.min(lo, p.getY(i));
    return lo === Infinity ? 0 : lo;
  };
  return { muzzle: new Vector3(0, mn ? my / mn : 0, b.min.z), top, bottomAt, rear: b.max.z };
}
