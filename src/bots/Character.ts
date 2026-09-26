import { BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial, Quaternion, SphereGeometry, Vector3, type Object3D } from 'three';
import type { Skin } from '../game/Skins';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mergeToGeometry } from '../core/merge';
import { attKey, buildGunModel, type WeaponInstance } from '../weapons/Weapon';
import { TOY } from '../theme';

function coloredBox(w: number, h: number, d: number, x: number, y: number, z: number, color: Color) {
  const g = new BoxGeometry(w, h, d).toNonIndexed();
  g.translate(x, y, z);
  const n = g.getAttribute('position').count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([color.r, color.g, color.b], i * 3);
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

/** Any geometry, flat-shaded, scaled, moved and painted one colour (so it merges with the boxes). */
function colored(src: BufferGeometry, x: number, y: number, z: number, color: Color, sx = 1, sy = 1, sz = 1) {
  const g = src.index ? src.toNonIndexed() : src;
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  g.computeVertexNormals();
  const n = g.getAttribute('position').count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([color.r, color.g, color.b], i * 3);
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}
const ball = (r: number, x: number, y: number, z: number, c: Color, sx = 1, sy = 1, sz = 1, seg = 10) =>
  colored(new SphereGeometry(r, seg, Math.round(seg * 0.75)), x, y, z, c, sx, sy, sz);
const cyl = (rt: number, rb: number, h: number, x: number, y: number, z: number, c: Color, seg = 12) =>
  colored(new CylinderGeometry(rt, rb, h, seg), x, y, z, c);

/**
 * Body styles (Settings → Characters). The hitboxes don't change, only the looks:
 * classic blocky soldiers, toy mini figures, round chubby people, or monsters. 'mix' gives
 * every bot a random one of the funny three.
 */
export type BodyKind = 'classic' | 'minifig' | 'chubby' | 'monster' | 'armyman' | 'teddy' | 'robot';
export type BodyStyle = BodyKind | 'mix';
let bodyStyle: BodyStyle = 'mix';
/** Toy Box mixes the toys; the classic island the three funny ones. */
const FUNNY: BodyKind[] = TOY ? ['minifig', 'armyman', 'teddy', 'robot'] : ['minifig', 'chubby', 'monster'];
/** Your own body in 'mix' mode: picked once per session so the Locker and your corpse agree. */
const ownMix = FUNNY[Math.floor(Math.random() * FUNNY.length)];
export function setBodyStyle(s: BodyStyle) {
  bodyStyle = s;
}
export const ownBodyKind = (): BodyKind => (bodyStyle === 'mix' ? ownMix : bodyStyle);
const botBodyKind = (): BodyKind => (bodyStyle === 'mix' ? FUNNY[Math.floor(Math.random() * FUNNY.length)] : bodyStyle);

interface BodySpec {
  parts: BufferGeometry[];
  shoulders: [Vector3, Vector3];
  grip: Vector3;
  foregrip: Vector3;
  gunAt: Vector3;
  arm: number;
  legGeo: BufferGeometry;
  legX: number;
  legY: number;
  markerY: number;
  /** Arm and hand colours, when they aren't the suit and skin. */
  sleeve?: Color;
  hand?: Color;
}

const BLACK = new Color(0x15161a), WHITE = new Color(0xf4f1e8);

function minifigBody(suit: Color, trim: Color, skin: Color): BodySpec {
  // Tapered torso: a 4-sided frustum, narrower at the shoulders.
  const torso = colored(new CylinderGeometry(0.34, 0.44, 0.66, 4, 1, false, Math.PI / 4), 0, 1.12, 0, suit, 1, 1, 0.6);
  const parts = [
    torso,
    coloredBox(0.6, 0.12, 0.3, 0, 0.76, 0, trim), // hips
    cyl(0.08, 0.08, 0.08, 0, 1.47, 0, skin), // neck
    cyl(0.19, 0.19, 0.28, 0, 1.64, 0, skin, 14), // head
    cyl(0.205, 0.205, 0.08, 0, 1.77, 0, trim, 14), // hair piece
    cyl(0.1, 0.1, 0.07, 0, 1.845, 0, trim, 10), // stud
    coloredBox(0.04, 0.06, 0.03, -0.07, 1.67, -0.18, BLACK), // eyes
    coloredBox(0.04, 0.06, 0.03, 0.07, 1.67, -0.18, BLACK),
    coloredBox(0.13, 0.025, 0.03, 0, 1.575, -0.18, BLACK), // smile
    coloredBox(0.03, 0.03, 0.03, -0.075, 1.59, -0.18, BLACK),
    coloredBox(0.03, 0.03, 0.03, 0.075, 1.59, -0.18, BLACK),
    coloredBox(0.36, 0.4, 0.16, 0, 1.15, 0.24, trim), // backpack
  ];
  const legGeo = mergeGeometries([coloredBox(0.27, 0.66, 0.3, 0, -0.35, 0, trim), coloredBox(0.27, 0.08, 0.36, 0, -0.66, -0.03, trim)])!;
  return {
    parts, shoulders: [new Vector3(0.3, 1.4, 0), new Vector3(-0.3, 1.4, 0)], grip: GRIP, foregrip: FOREGRIP, gunAt: new Vector3(0.22, 1.22, -0.3),
    arm: 0.12, legGeo, legX: 0.145, legY: 0.72, markerY: 1.95,
  };
}

function chubbyBody(suit: Color, trim: Color, skin: Color): BodySpec {
  const shirt = suit.clone().lerp(WHITE, 0.3), cheek = new Color(0xf08a8a);
  const parts = [
    ball(0.5, 0, 1.0, 0, suit, 1, 0.95, 0.86, 14), // the big round body
    ball(0.36, 0, 0.98, -0.25, shirt, 1, 1.05, 0.55, 12), // belly
    ball(0.035, 0, 0.88, -0.44, BLACK.clone().lerp(shirt, 0.4), 1, 1, 0.5, 6), // belly button
    ball(0.22, 0, 1.62, -0.02, skin, 1, 1, 1, 12), // head
    colored(new SphereGeometry(0.228, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.42), 0, 1.64, -0.01, trim), // beanie
    ball(0.05, 0, 1.87, -0.01, trim, 1, 1, 1, 6), // pom-pom
    coloredBox(0.05, 0.05, 0.03, -0.08, 1.65, -0.215, BLACK), // eyes
    coloredBox(0.05, 0.05, 0.03, 0.08, 1.65, -0.215, BLACK),
    coloredBox(0.08, 0.03, 0.03, 0, 1.55, -0.21, BLACK), // mouth
    ball(0.04, -0.14, 1.58, -0.17, cheek, 1, 1, 0.5, 6), // cheeks
    ball(0.04, 0.14, 1.58, -0.17, cheek, 1, 1, 0.5, 6),
    coloredBox(0.34, 0.36, 0.16, 0, 1.08, 0.46, trim), // backpack
  ];
  const legGeo = mergeGeometries([coloredBox(0.2, 0.5, 0.22, 0, -0.25, 0, trim), coloredBox(0.24, 0.1, 0.34, 0, -0.5, -0.05, BLACK)])!;
  return {
    parts, shoulders: [new Vector3(0.44, 1.2, -0.05), new Vector3(-0.44, 1.2, -0.05)],
    grip: new Vector3(0.24, 1.08, -0.56), foregrip: new Vector3(0.21, 1.14, -0.88), gunAt: new Vector3(0.24, 1.16, -0.6),
    arm: 0.16, legGeo, legX: 0.2, legY: 0.55, markerY: 2.0,
  };
}

function monsterBody(suit: Color, trim: Color, rnd: () => number): BodySpec {
  const fur = suit.clone(), belly = suit.clone().lerp(WHITE, 0.35), dark = trim.clone();
  const horn = new Color(rnd() < 0.5 ? 0xf2e6c8 : 0x2a2330), tongue = new Color(0xd8455a);
  const parts = [
    coloredBox(0.82, 0.74, 0.5, 0, 1.1, 0.02, fur), // hunched body
    coloredBox(0.56, 0.5, 0.06, 0, 1.06, -0.24, belly),
    coloredBox(0.54, 0.42, 0.46, 0, 1.64, -0.04, fur), // head, no neck
    coloredBox(0.36, 0.1, 0.04, 0, 1.51, -0.28, BLACK), // mouth
    coloredBox(0.1, 0.04, 0.03, 0.05, 1.49, -0.29, tongue),
  ];
  for (const x of [-0.13, -0.04, 0.05, 0.14]) parts.push(coloredBox(0.04, 0.05, 0.03, x, 1.535, -0.3, WHITE)); // teeth
  const eyes = Math.floor(rnd() * 3);
  if (eyes === 0) {
    // Cyclops
    parts.push(coloredBox(0.22, 0.2, 0.04, 0, 1.7, -0.27, WHITE), coloredBox(0.09, 0.1, 0.03, 0, 1.69, -0.295, BLACK));
  } else {
    const xs = eyes === 1 ? [-0.12, 0.12] : [-0.15, 0, 0.15];
    for (const x of xs) parts.push(coloredBox(0.11, 0.11, 0.04, x, 1.72, -0.27, WHITE), coloredBox(0.05, 0.05, 0.03, x, 1.71, -0.295, BLACK));
  }
  const top = Math.floor(rnd() * 3);
  if (top === 0) {
    // Horns
    for (const s of [-1, 1]) parts.push(coloredBox(0.09, 0.12, 0.09, s * 0.22, 1.9, -0.04, horn), coloredBox(0.07, 0.12, 0.07, s * 0.27, 2.0, -0.04, horn), coloredBox(0.05, 0.08, 0.05, s * 0.3, 2.08, -0.08, horn));
  } else if (top === 1) {
    // Antennae with bobbles
    for (const s of [-1, 1]) parts.push(coloredBox(0.03, 0.26, 0.03, s * 0.12, 1.98, -0.02, dark), ball(0.06, s * 0.12, 2.12, -0.02, belly, 1, 1, 1, 6));
  } else {
    // A row of spikes down the back
    for (let i = 0; i < 5; i++) parts.push(coloredBox(0.08, 0.14, 0.08, 0, 1.9 - i * 0.2, 0.2 + i * 0.05, dark));
  }
  const legGeo = mergeGeometries([coloredBox(0.3, 0.66, 0.32, 0, -0.33, 0, dark), coloredBox(0.34, 0.08, 0.4, 0, -0.66, -0.05, dark)])!;
  return {
    parts, shoulders: [new Vector3(0.46, 1.38, 0), new Vector3(-0.46, 1.38, 0)],
    grip: new Vector3(0.24, 1.12, -0.37), foregrip: new Vector3(0.21, 1.18, -0.72), gunAt: new Vector3(0.24, 1.2, -0.4),
    arm: 0.17, legGeo, legX: 0.2, legY: 0.72, markerY: 2.25,
  };
}

/** A green (or tan, grey, blue...) plastic army man, fused to his little base. */
function armymanBody(suit: Color): BodySpec {
  const hsl = { h: 0, s: 0, l: 0 };
  suit.getHSL(hsl);
  const p = new Color().setHSL(hsl.h, 0.42, 0.36), dk = p.clone().multiplyScalar(0.8), lt = p.clone().lerp(WHITE, 0.12);
  const parts = [
    coloredBox(0.56, 0.66, 0.32, 0, 1.12, 0, p), // torso
    coloredBox(0.6, 0.07, 0.34, 0, 0.82, 0, dk), // belt
    coloredBox(0.08, 0.1, 0.36, -0.14, 0.85, 0, dk), // pouches
    coloredBox(0.08, 0.1, 0.36, 0.14, 0.85, 0, dk),
    coloredBox(0.3, 0.32, 0.3, 0, 1.6, 0, p), // head
    colored(new SphereGeometry(0.22, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 1.7, 0, lt, 1, 0.8, 1.05), // helmet
    cyl(0.25, 0.25, 0.03, 0, 1.7, 0, dk, 14), // brim
    coloredBox(0.2, 0.03, 0.03, 0, 1.64, -0.16, dk), // brow
    coloredBox(0.05, 0.03, 0.03, 0, 1.56, -0.17, dk), // nose
    coloredBox(0.4, 0.44, 0.16, 0, 1.16, 0.24, dk), // pack
    cyl(0.07, 0.07, 0.36, 0, 1.18, 0.34, lt, 8).rotateZ(Math.PI / 2), // bedroll
    coloredBox(0.95, 0.05, 0.7, 0, 0.025, 0, p), // the base they stand on
  ];
  const legGeo = coloredBox(0.24, 0.76, 0.28, 0, -0.38, 0, p);
  return {
    parts, shoulders: [new Vector3(0.34, 1.4, 0), new Vector3(-0.34, 1.4, 0)], grip: GRIP, foregrip: FOREGRIP, gunAt: new Vector3(0.22, 1.22, -0.3),
    arm: 0.13, legGeo, legX: 0.15, legY: 0.8, markerY: 1.95, sleeve: p, hand: p,
  };
}

/** A plush teddy bear with button eyes and a bow tie. */
function teddyBody(suit: Color, trim: Color): BodySpec {
  const hsl = { h: 0, s: 0, l: 0 };
  suit.getHSL(hsl);
  // Mostly classic browns, some pastel bears.
  const fur = hsl.s > 0.3 && hsl.h > 0.5 ? new Color().setHSL(hsl.h, 0.45, 0.72) : new Color().setHSL(0.07 + hsl.h * 0.04, 0.45, 0.38 + hsl.l * 0.2);
  const pale = fur.clone().lerp(WHITE, 0.5), nose = new Color(0x2a1a14);
  const parts = [
    ball(0.42, 0, 1.0, 0, fur, 1, 1.05, 0.85, 14), // tummy body
    ball(0.28, 0, 0.98, -0.22, pale, 1, 1.1, 0.5, 12), // tummy patch
    ball(0.3, 0, 1.62, 0, fur, 1, 0.95, 0.95, 14), // head
    ball(0.1, -0.22, 1.86, 0, fur, 1, 1, 0.55, 8), // ears
    ball(0.1, 0.22, 1.86, 0, fur, 1, 1, 0.55, 8),
    ball(0.06, -0.22, 1.86, -0.04, pale, 1, 1, 0.4, 8),
    ball(0.06, 0.22, 1.86, -0.04, pale, 1, 1, 0.4, 8),
    ball(0.12, 0, 1.55, -0.25, pale, 1.1, 0.85, 0.8, 10), // snout
    ball(0.045, 0, 1.6, -0.34, nose, 1.2, 0.9, 1, 8), // nose
    cyl(0.05, 0.05, 0.03, -0.11, 1.7, -0.27, BLACK, 10).rotateX(Math.PI / 2), // button eyes
    cyl(0.05, 0.05, 0.03, 0.11, 1.7, -0.27, BLACK, 10).rotateX(Math.PI / 2),
    coloredBox(0.14, 0.1, 0.06, -0.09, 1.34, -0.27, trim), // bow tie
    coloredBox(0.14, 0.1, 0.06, 0.09, 1.34, -0.27, trim),
    coloredBox(0.06, 0.07, 0.07, 0, 1.34, -0.28, trim.clone().multiplyScalar(0.7)),
    coloredBox(0.02, 0.4, 0.02, 0, 1.0, -0.33, fur.clone().multiplyScalar(0.7)), // stitching
  ];
  const legGeo = mergeGeometries([colored(new CylinderGeometry(0.15, 0.15, 0.46, 10), 0, -0.23, 0, fur), ball(0.13, 0, -0.45, -0.05, pale, 1, 0.5, 1.2, 8)])!;
  return {
    parts, shoulders: [new Vector3(0.38, 1.24, -0.02), new Vector3(-0.38, 1.24, -0.02)],
    grip: new Vector3(0.22, 1.1, -0.5), foregrip: new Vector3(0.2, 1.16, -0.82), gunAt: new Vector3(0.22, 1.18, -0.54),
    arm: 0.17, legGeo, legX: 0.19, legY: 0.52, markerY: 2.05, sleeve: fur, hand: pale,
  };
}

/** A tin wind-up robot: boxy, rivets, a screen face and a big key in its back. */
function robotBody(suit: Color, trim: Color): BodySpec {
  const tin = suit.clone().lerp(new Color(0xc8ccd2), 0.35), dark = trim.clone().lerp(new Color(0x30343a), 0.4);
  const eye = new Color(0x6ff2ff), key = new Color(0xffc21a), rivet = new Color(0xe8ecf0);
  const parts = [
    coloredBox(0.64, 0.62, 0.42, 0, 1.12, 0, tin), // chest can
    coloredBox(0.4, 0.26, 0.04, 0, 1.18, -0.22, dark), // dial panel
    cyl(0.05, 0.05, 0.03, -0.1, 1.2, -0.24, new Color(0xff4a3a), 8).rotateX(Math.PI / 2),
    cyl(0.05, 0.05, 0.03, 0.1, 1.2, -0.24, new Color(0x3aff7a), 8).rotateX(Math.PI / 2),
    coloredBox(0.52, 0.08, 0.44, 0, 0.8, 0, dark), // waist
    coloredBox(0.12, 0.08, 0.12, 0, 1.47, 0, dark), // neck
    coloredBox(0.44, 0.36, 0.38, 0, 1.68, 0, tin), // head box
    coloredBox(0.34, 0.14, 0.03, 0, 1.7, -0.2, BLACK), // face screen
    coloredBox(0.08, 0.06, 0.02, -0.08, 1.71, -0.215, eye), // eyes
    coloredBox(0.08, 0.06, 0.02, 0.08, 1.71, -0.215, eye),
    coloredBox(0.2, 0.03, 0.02, 0, 1.56, -0.2, dark), // mouth grille
    coloredBox(0.03, 0.2, 0.03, 0, 1.96, 0, dark), // antenna
    ball(0.06, 0, 2.08, 0, new Color(0xff4a3a), 1, 1, 1, 8),
    coloredBox(0.06, 0.12, 0.12, -0.25, 1.7, 0, dark), // ear bolts
    coloredBox(0.06, 0.12, 0.12, 0.25, 1.7, 0, dark),
    coloredBox(0.05, 0.05, 0.2, 0, 1.15, 0.3, key), // wind-up key
    coloredBox(0.05, 0.3, 0.08, 0, 1.15, 0.42, key),
    coloredBox(0.05, 0.08, 0.2, 0, 1.28, 0.42, key),
    coloredBox(0.05, 0.08, 0.2, 0, 1.02, 0.42, key),
  ];
  for (const x of [-0.26, 0.26]) for (const y of [0.88, 1.36]) parts.push(coloredBox(0.04, 0.04, 0.03, x, y, -0.215, rivet));
  const legGeo = mergeGeometries([coloredBox(0.22, 0.66, 0.24, 0, -0.33, 0, dark), coloredBox(0.28, 0.1, 0.36, 0, -0.66, -0.04, tin)])!;
  return {
    parts, shoulders: [new Vector3(0.38, 1.36, 0), new Vector3(-0.38, 1.36, 0)], grip: GRIP, foregrip: FOREGRIP, gunAt: new Vector3(0.22, 1.22, -0.3),
    arm: 0.14, legGeo, legX: 0.15, legY: 0.76, markerY: 2.2, sleeve: tin, hand: new Color(0x9aa0a8),
  };
}

/** A gold crown for the bosses, sized for a normal head (the whole boss is scaled up). */
function crownParts(y: number) {
  const gold = new Color(0xffc21a), gem = new Color(0xff2a6a), p = [cyl(0.22, 0.2, 0.1, 0, y, 0, gold, 12)];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    p.push(coloredBox(0.07, 0.14, 0.07, Math.cos(a) * 0.2, y + 0.1, Math.sin(a) * 0.2, gold), ball(0.035, Math.cos(a) * 0.2, y + 0.19, Math.sin(a) * 0.2, gem, 1, 1, 1, 6));
  }
  return p;
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
function armGeometry(len: number, sleeve: Color, skin: Color, t = 0.13) {
  return mergeGeometries([coloredBox(t, t, len - 0.06, 0, 0, (len - 0.06) / 2, sleeve), coloredBox(t * 0.85, t * 0.85, 0.12, 0, 0, len, skin)])!;
}
function armTo(from: Vector3, to: Vector3, sleeve: Color, skin: Color, t = 0.13) {
  const d = to.clone().sub(from), g = armGeometry(d.length(), sleeve, skin, t);
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
  private body!: Mesh;
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

  /** Which body this one got. */
  readonly kind: BodyKind;
  private crown: boolean;

  /** `kind` defaults to the Settings choice (a random funny one per bot in 'mix'). */
  /** Overall size (bosses are giants). */
  size = 1;

  constructor(suit: Color, trim: Color, marker?: number, outfit?: Skin, posable = false, kind: BodyKind = botBodyKind(), crown = false) {
    this.crown = crown;
    this.mat = new MeshLambertMaterial({ vertexColors: true });
    this.kind = kind;
    if (outfit) {
      suit = new Color(outfit.suit);
      trim = new Color(outfit.trim);
    }
    if (kind !== 'classic') {
      this.buildFunny(kind, suit, trim, outfit, marker, posable);
      return;
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

  private buildFunny(kind: BodyKind, suit: Color, trim: Color, outfit: Skin | undefined, marker: number | undefined, posable: boolean) {
    const skin = new Color(kind === 'minifig' ? outfit?.face ?? 0xffd23a : outfit?.face ?? 0xe8b894);
    let s = 1 + Math.floor(Math.random() * 2147483645);
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const spec = kind === 'minifig' ? minifigBody(suit, trim, skin) : kind === 'chubby' ? chubbyBody(suit, trim, skin)
      : kind === 'armyman' ? armymanBody(suit) : kind === 'teddy' ? teddyBody(suit, trim) : kind === 'robot' ? robotBody(suit, trim) : monsterBody(suit, trim, rnd);
    // Army men are one colour of plastic all over; bears have paws, robots tin hands.
    if (spec.sleeve) suit = spec.sleeve;
    const hand = spec.hand ?? (kind === 'monster' ? suit : skin), parts = spec.parts;
    if (this.crown) parts.push(...crownParts(spec.markerY - (kind === 'robot' ? 0.2 : 0.1)));
    if (marker !== undefined) parts.push(coloredBox(0.36, 0.08, 0.36, 0, spec.markerY, 0, new Color(marker)));
    if (!posable) parts.push(armTo(spec.shoulders[0], spec.grip, suit, hand, spec.arm), armTo(spec.shoulders[1], spec.foregrip, suit, hand, spec.arm));
    this.body = new Mesh(mergeGeometries(parts)!, this.mat);
    if (posable) {
      const len = spec.shoulders[0].distanceTo(spec.grip), geo = armGeometry(len, suit, hand, spec.arm);
      for (const sh of spec.shoulders) {
        const pivot = new Group();
        pivot.position.copy(sh);
        pivot.add(new Mesh(geo, this.mat));
        this.armPivots.push(pivot);
        this.root.add(pivot);
      }
      this.pose(null, null);
    }
    for (const x of [-spec.legX, spec.legX]) {
      const leg = new Mesh(spec.legGeo, this.mat);
      leg.position.set(x, spec.legY, 0);
      this.legs.push(leg);
      this.root.add(leg);
    }
    this.gunHolder.position.copy(spec.gunAt);
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
    this.root.scale.set(this.size, this.size * (1 - this.crouchK * 0.3), this.size);
    this.flash -= dt;
    this.mat.emissive.setHex(this.flash > 0 ? 0x993322 : 0x000000);
  }
}
