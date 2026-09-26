import {
  BoxGeometry, BufferAttribute, IcosahedronGeometry, BufferGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry, InstancedMesh, LOD,
  Matrix4, Mesh, MeshLambertMaterial, Object3D, PlaneGeometry, Quaternion, RepeatWrapping, Scene, SRGBColorSpace, Vector3, type Material,
} from 'three';
import { CONFIG } from '../config';
import { CollisionWorld, type Box } from '../core/Collision';
import { Terrain } from '../core/Terrain';
import { clamp, lerp, mulberry32, pick, rand, randInt, type Rng } from '../core/rng';
import { THEME } from '../theme';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type TownSize = 'city' | 'town' | 'village';
type Flavor = 'downtown' | 'residential' | 'industrial' | 'harbor' | 'labs' | 'farm' | 'military' | 'castle' | 'airport'
  | 'fair' | 'coaster' | 'wheel' | 'haunted' | 'prison' | 'frontier';
/** Centrepiece built in the middle of a themed town. */
type Feature = 'bigtop' | 'carousel' | 'bumper' | 'silo' | 'station' | 'mine' | 'bunker' | 'fuel';

/** A closed door (world AABB). Doors swing open automatically when someone walks up. */
export interface DoorSpec extends Box {
  alongX: boolean;
}

export interface DestructibleSpec extends Box {
  kind: 'crate' | 'fence';
  color: number;
}

export interface ZiplineSpec {
  a: Vector3;
  b: Vector3;
  /** Vertical lines up a building: at the top you're pushed this way (x, z) onto the roof. */
  push?: [number, number];
}

interface Bridge {
  x: number;
  z: number;
  dx: number;
  dz: number;
  len: number;
  hA: number;
  hB: number;
}

/** Something that can be hidden once it is far enough from the camera. */
interface Cullable {
  obj: Object3D;
  /** Part of an offshore arena: only drawn from close by. */
  offshore?: boolean;
  x: number;
  z: number;
  r: number;
  /** Metres beyond the bounding radius, or 0 = "as far as the fog reaches". */
  max: number;
}

export interface POI {
  name: string;
  x: number;
  z: number;
  radius: number;
  size: TownSize;
  flavor: Flavor;
  feature?: Feature;
  /** Ground height of the town plateau. */
  y: number;
}

export interface Spot {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

interface Lot extends Rect {
  y: number;
}

interface Footprint extends Rect {
  color: string;
}

interface Solid {
  minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number;
  color: number;
}

interface Opening {
  a: number;
  b: number;
  bottom: number;
  top: number;
  /** Leave the hole empty (no door or glass). */
  open?: boolean;
}

type BoxFn = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number, collide?: boolean) => void;
type RectFn = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => void;
/** Local-space building helper: solid boxes plus doors, glass panes and breakable props. */
type Builder = BoxFn & { door: RectFn; glass: RectFn; prop: (kind: 'crate' | 'fence', x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number) => void };

/** The island layout is hand-placed so every match is played on the same, learnable map. */
const BASE_TOWNS: Omit<POI, 'y'>[] = [
  { name: 'Neon City', x: -110, z: -70, radius: 118, size: 'city', flavor: 'downtown' },
  { name: 'Skyline', x: 275, z: 70, radius: 90, size: 'city', flavor: 'downtown' },
  { name: 'Old Town', x: -290, z: -262, radius: 78, size: 'town', flavor: 'residential' },
  { name: 'Rust Yard', x: -285, z: 265, radius: 80, size: 'town', flavor: 'industrial' },
  { name: 'Harbor Point', x: 290, z: 295, radius: 72, size: 'town', flavor: 'harbor' },
  { name: 'Summit Labs', x: 250, z: -290, radius: 55, size: 'village', flavor: 'labs' },
  { name: 'Pine Ridge', x: -385, z: 25, radius: 45, size: 'village', flavor: 'residential' },
  { name: 'Dustbowl', x: 55, z: 320, radius: 48, size: 'village', flavor: 'farm' },
  { name: 'Mill Creek', x: -10, z: -330, radius: 42, size: 'village', flavor: 'farm' },
  { name: 'Crater Farm', x: -120, z: 300, radius: 40, size: 'village', flavor: 'farm' },
  { name: 'Fort Talon', x: -175, z: 385, radius: 58, size: 'town', flavor: 'military' },
  { name: 'Ravencrest Castle', x: -230, z: 120, radius: 40, size: 'village', flavor: 'castle' },
  { name: 'Sunfield Airport', x: 125, z: -378, radius: 85, size: 'town', flavor: 'airport' },
];
/** A themed town: new name and flavour, and (for the themed layouts) a new place on the island. */
type TownTheme = Pick<POI, 'name' | 'flavor'> & Partial<Pick<POI, 'x' | 'z' | 'radius' | 'size'>> & { feature?: Feature };
const THEMED_TOWNS: Partial<Record<typeof THEME, TownTheme[]>> = {
  // Canyon country: the railway runs east-west through Railroad Junction, the canyon cuts down the east side.
  western: [
    { name: 'Dust Creek', flavor: 'downtown', x: -160, z: -170, radius: 110 },
    { name: 'Silver Gulch', flavor: 'downtown', x: 340, z: -160, radius: 85 },
    { name: 'Tombstone', flavor: 'residential', x: -300, z: 200, radius: 78 },
    { name: 'Gold Mine', flavor: 'industrial', feature: 'mine', x: -310, z: -300, radius: 60 },
    { name: 'Riverboat Landing', flavor: 'harbor', x: 300, z: 320, radius: 70 },
    { name: 'Eagle Peak', flavor: 'residential', x: 350, z: 140, radius: 50 },
    { name: 'Cedar Ranch', flavor: 'farm', x: -400, z: -110, radius: 45 },
    { name: 'Railroad Junction', flavor: 'residential', feature: 'station', x: -40, z: 40, radius: 55 },
    { name: 'Mill Creek', flavor: 'farm', x: -160, z: 270, radius: 42 },
    { name: 'Cactus Flats', flavor: 'farm', x: 20, z: 280, radius: 40 },
    { name: 'Fort Talon', flavor: 'military', x: -60, z: 410, radius: 58 },
    { name: 'Mission Rosa', flavor: 'castle', x: 60, z: -230, radius: 40 },
    { name: 'Barnstormer Field', flavor: 'airport', x: 40, z: -380, radius: 85 },
  ],
  // One big walled base in the middle, fenced zones round it and a long runway up north.
  military: [
    { name: 'Command Center', flavor: 'downtown', x: 0, z: 0, radius: 125 },
    { name: 'Radar Station', flavor: 'labs', feature: 'bunker', x: 300, z: -200, radius: 65, size: 'town' },
    { name: 'Barracks', flavor: 'military', x: -300, z: -230, radius: 70 },
    { name: 'Motor Pool', flavor: 'industrial', x: -300, z: 230, radius: 75 },
    { name: 'Naval Docks', flavor: 'harbor', x: 300, z: 290, radius: 75 },
    { name: 'Silo 7', flavor: 'labs', feature: 'silo', x: 350, z: 60, radius: 55 },
    { name: 'Outpost Echo', flavor: 'military', x: -400, z: 0, radius: 48 },
    { name: 'Firing Range', flavor: 'farm', x: 90, z: 340, radius: 50 },
    { name: 'Supply Depot', flavor: 'farm', feature: 'fuel', x: -150, z: -200, radius: 45 },
    { name: 'Tank Graveyard', flavor: 'farm', x: 150, z: 200, radius: 45 },
    { name: 'Fort Talon', flavor: 'military', x: -150, z: 390, radius: 58 },
    { name: 'Blackrock Prison', flavor: 'prison', x: 230, z: -20, radius: 45 },
    { name: 'Airbase', flavor: 'airport', x: 0, z: -385, radius: 90 },
  ],
  // Zones in a ring round the lake, joined by footpaths; the castle stands on an island in the middle.
  park: [
    { name: 'Main Street', flavor: 'downtown', x: 0, z: 320, radius: 105 },
    { name: 'Grand Hotels', flavor: 'downtown', x: 350, z: 30, radius: 85 },
    { name: 'Haunted Hollow', flavor: 'haunted', x: -250, z: -290, radius: 70 },
    { name: 'Coaster Canyon', flavor: 'coaster', x: -300, z: 210, radius: 80 },
    { name: 'Pirate Cove', flavor: 'harbor', x: 290, z: 300, radius: 65 },
    { name: 'Sky Wheel', flavor: 'wheel', x: 300, z: -250, radius: 55 },
    { name: 'Frontier Land', flavor: 'residential', x: -390, z: -50, radius: 50 },
    { name: 'Big Top', flavor: 'fair', feature: 'bigtop', x: -200, z: 60, radius: 50 },
    { name: 'Carousel Square', flavor: 'fair', feature: 'carousel', x: 170, z: 150, radius: 45 },
    { name: 'Bumper Alley', flavor: 'fair', feature: 'bumper', x: 120, z: -180, radius: 42 },
    { name: 'Adventure Fort', flavor: 'military', x: -160, z: -160, radius: 58 },
    { name: 'Fairy Castle', flavor: 'castle', x: 0, z: 0, radius: 40 },
    { name: 'Park Airfield', flavor: 'airport', x: 60, z: -370, radius: 85 },
  ],
};
/** The all-in-one island: a bit of everything, placed on the classic island's hills, rivers and lakes. */
const WORLD_TOWNS: Omit<POI, 'y'>[] = [
  { name: 'Neon City', x: -110, z: -70, radius: 118, size: 'city', flavor: 'downtown' },
  { name: 'Skyline', x: 275, z: 70, radius: 90, size: 'city', flavor: 'downtown' },
  { name: 'Old Town', x: -290, z: -262, radius: 78, size: 'town', flavor: 'residential' },
  { name: 'Rust Yard', x: -285, z: 265, radius: 80, size: 'town', flavor: 'industrial' },
  { name: 'Harbor Point', x: 290, z: 295, radius: 72, size: 'town', flavor: 'harbor' },
  { name: 'Summit Labs', x: 250, z: -290, radius: 62, size: 'town', flavor: 'labs', feature: 'bunker' },
  { name: 'Gold Mine', x: -385, z: 25, radius: 50, size: 'village', flavor: 'industrial', feature: 'mine' },
  { name: 'Blackrock Prison', x: 55, z: 320, radius: 48, size: 'village', flavor: 'prison' },
  { name: 'Mill Creek', x: -10, z: -330, radius: 42, size: 'village', flavor: 'farm' },
  { name: 'Dust Creek', x: -120, z: 300, radius: 44, size: 'village', flavor: 'frontier' },
  { name: 'Fort Talon', x: -175, z: 385, radius: 58, size: 'town', flavor: 'military' },
  { name: 'Ravencrest Castle', x: -230, z: 120, radius: 40, size: 'village', flavor: 'castle' },
  { name: 'Sunfield Airport', x: 125, z: -378, radius: 85, size: 'town', flavor: 'airport' },
  { name: 'Silo 7', x: 405, z: -45, radius: 44, size: 'village', flavor: 'labs', feature: 'silo' },
  { name: 'Funland', x: 165, z: 175, radius: 44, size: 'village', flavor: 'fair', feature: 'bigtop' },
];
const TOWNS: Omit<POI, 'y'>[] = THEME === 'world' ? WORLD_TOWNS : THEME === 'default' ? BASE_TOWNS : BASE_TOWNS.map((t, i) => ({ ...t, ...THEMED_TOWNS[THEME]?.[i] }));

/** Rivers carve a channel down to below sea level; roads that cross them get bridges. */
const RIVERS: { w: number; pts: number[][] }[] = THEME === 'western' || THEME === 'park' ? [] : [
  { w: 11, pts: [[150, -120], [200, -128], [250, -130], [300, -160], [360, -190], [430, -215], [540, -230]] },
  { w: 9, pts: [[-40, 190], [-22, 250], [-10, 320], [-4, 400], [0, 540]] },
];
/** Where the dam crosses the first river (the river runs along X there). */
const DAM: { x: number; z: number } | null = RIVERS.length ? { x: 222, z: -129 } : null;

const MOUNTAINS = THEME === 'western' ? [
  { x: -330, z: -400, h: 28, s: 55 }, { x: 420, z: -260, h: 22, s: 50 }, { x: -440, z: 270, h: 20, s: 45 }, { x: 240, z: 430, h: 18, s: 45 },
] : THEME === 'park' ? [
  { x: -80, z: -330, h: 20, s: 45 }, { x: 430, z: -120, h: 20, s: 50 }, { x: -440, z: 150, h: 18, s: 45 }, { x: 170, z: 430, h: 16, s: 40 },
] : [
  { x: 250, z: -290, h: 34, s: 85 },
  { x: -230, z: 120, h: 42, s: 80 },
  { x: 60, z: 140, h: 30, s: 70 },
  { x: -430, z: -130, h: 30, s: 70 },
  { x: 430, z: -90, h: 28, s: 60 },
  { x: -10, z: -200, h: 20, s: 55 },
  { x: 160, z: 420, h: 18, s: 50 },
];

/** Lowland lakes: the terrain dips below sea level and the sea plane fills them. */
const LAKES: { x: number; z: number; r: number }[] = THEME === 'western' ? [] : THEME === 'park' ? [{ x: 0, z: 0, r: 135 }] : [
  { x: 150, z: -120, r: 42 },
  { x: -40, z: 190, r: 28 },
];

/** Wild West landscape: flat-topped mesas (absolute top height), a dry canyon, and the railway across the island. */
const MESAS = THEME === 'western' ? [
  { x: 350, z: 140, r: 72, top: 30 }, { x: 250, z: -30, r: 36, top: 26 }, { x: -200, z: 110, r: 30, top: 24 }, { x: -420, z: 120, r: 30, top: 22 },
] : [];
const CANYON = THEME === 'western' ? { w: 12, wall: 16, pts: [[250, -490], [240, -330], [175, -200], [160, -60], [175, 80], [125, 220], [140, 490]] } : null;
/**
 * Walls and floors in the blocky style: a pixel grid of slightly lighter and darker squares, courses
 * of bricks or boards on walls and tiles on floors. Worked out from world position in the shader, so
 * every box gets it without textures or UVs, fading out with distance.
 */
const BX_VARYINGS = `#include <common>
varying vec3 vBxPos;
varying vec3 vBxN;`;

function blockyMaterial() {
  const m = new MeshLambertMaterial();
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', BX_VARYINGS)
      .replace('#include <project_vertex>', `#include <project_vertex>
  vec4 bxW = vec4(transformed, 1.0);
  mat3 bxM = mat3(modelMatrix);
  #ifdef USE_INSTANCING
    bxW = instanceMatrix * bxW;
    bxM = bxM * mat3(instanceMatrix);
  #endif
  vBxPos = (modelMatrix * bxW).xyz;
  vBxN = normalize(bxM * objectNormal);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', BX_VARYINGS)
      .replace('#include <color_fragment>', `#include <color_fragment>
  {
    vec3 an = abs(vBxN);
    bool floorish = an.y > 0.5;
    vec2 uv = floorish ? vBxPos.xz : (an.x > 0.5 ? vBxPos.zy : vBxPos.xy);
    vec2 cell = floor(uv * 4.0 + 0.001);
    float h = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
    float shade = 1.0 + (h - 0.5) * 0.1;
    if (floorish) {
      vec2 f = fract(uv);
      shade *= 1.0 - 0.08 * min(1.0, step(f.x, 0.035) + step(f.y, 0.035));
    } else {
      float row = floor(uv.y * 2.0);
      vec2 f = vec2(fract(uv.x / 1.5 + mod(row, 2.0) * 0.5), fract(uv.y * 2.0));
      shade *= 1.0 - 0.1 * min(1.0, step(f.y, 0.07) + step(f.x, 0.02));
    }
    float fade = clamp(1.0 - length(vBxPos - cameraPosition) / 140.0, 0.0, 1.0);
    diffuseColor.rgb *= mix(1.0, shade, fade);
  }`);
  };
  return m;
}

/**
 * The railway: a closed spline through these points. It runs straight past each platform (Railroad
 * Junction, then the halts), sweeps in S-bends between towns and crosses the canyon twice on trestles.
 */
const RAIL = THEME === 'western' ? [
  [-110, 40], [-70, 40], [-40, 40], [-10, 40], [20, 40], [70, 30], [110, 5], [140, -12], [170, -18], [200, 0], [222, 50],
  [235, 110], [235, 150], [235, 180], [235, 210], [225, 262], [190, 300], [132, 328], [70, 345], [20, 345], [-20, 345],
  [-60, 345], [-120, 352], [-195, 345], [-250, 318], [-300, 300], [-350, 290], [-395, 240], [-395, 200], [-395, 160],
  [-362, 108], [-312, 72], [-250, 52], [-190, 44], [-150, 40],
] : null;
/** Train stops besides Railroad Junction: a platform on one side of the track (dx/dz points away from it). */
const HALTS = THEME === 'western' ? [
  { name: 'Tombstone Halt', x: -395, z: 200, dx: 1, dz: 0 },
  { name: 'Fort Talon Halt', x: -20, z: 345, dx: 0, dz: 1 },
  { name: 'Eagle Halt', x: 235, z: 180, dx: 1, dz: 0 },
] : [];
/** Height of the coach floors above the rail top (the train is built 1.3x life size). */
const TRAIN_FLOOR = 1.56;

/** Closed Catmull-Rom spline through the points, resampled every `step` metres. */
function sampleLoop(ctrl: number[][], step: number) {
  const n = ctrl.length, dense: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [ctrl[(i - 1 + n) % n], ctrl[i], ctrl[(i + 1) % n], ctrl[(i + 2) % n]];
    for (let k = 0; k < 40; k++) {
      const t = k / 40, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      dense.push({ x: f(p0[0], p1[0], p2[0], p3[0]), z: f(p0[1], p1[1], p2[1], p3[1]) });
    }
  }
  const out: { x: number; z: number }[] = [dense[0]];
  let acc = 0;
  for (let i = 1; i <= dense.length; i++) {
    const a = dense[i - 1], b = dense[i % dense.length], d = Math.hypot(b.x - a.x, b.z - a.z);
    acc += d;
    while (acc >= step) {
      acc -= step;
      const k = 1 - acc / d;
      out.push({ x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k });
    }
  }
  // Drop a last point that nearly repeats the first.
  const l = out[out.length - 1];
  if (Math.hypot(l.x - out[0].x, l.z - out[0].z) < step * 0.5) out.pop();
  return out;
}

const PALETTES = {
  default: {
    wall: [0xf2e3c6, 0xe8b27a, 0xa7c7e7, 0xf4a6a6, 0xc8e6a0, 0xf7d774, 0xd9d4ce, 0xb9a6e0],
    apartment: [0xd8cfc4, 0xc97b5a, 0x9fb4c7, 0xe0c28a, 0xb5b0a8, 0xa35f4a],
    roof: [0x8c3b2e, 0x4a5563, 0x3d6b8c, 0x6b4e3d, 0x2f6e4f],
    warehouse: [0x9aa5b1, 0x7f8c8d, 0xb0845a, 0x6f8f9f],
    container: [0xd9534f, 0x2f7fd1, 0x2fa36b, 0xf0a030, 0x8e44ad, 0x16a0a0],
    glass: [0x5a7fa0, 0x6b8fb3, 0x3f5f7f, 0x8aa4bf, 0x4f6f6a, 0x7d8a99],
    car: [0xd9382c, 0x2f6fd1, 0xf0f0f0, 0x222428, 0xf0b030, 0x3a9a5a, 0x9aa0a8],
    sign: [0xe53935, 0x1e88e5, 0xfdd835, 0x43a047, 0xfb8c00, 0x8e24aa],
  },
  military: {
    wall: [0x7d8566, 0x8a8f7a, 0xa39a7c, 0x6b7a5a, 0x9a978e, 0xb5ad8f],
    apartment: [0x9a978e, 0x8a8a80, 0x7d8566, 0xa8a497, 0x6f7563],
    roof: [0x4a5040, 0x55595e, 0x3d4535, 0x5a5f66],
    warehouse: [0x5f6b55, 0x6b7a5a, 0x7a806a, 0x8a8f7a],
    container: [0x5f6b55, 0x7d6a48, 0x8a8f7a, 0x4f5a45, 0xa39a7c, 0x6b7a5a],
    glass: [0x3f4a40, 0x4f5a55, 0x505a60, 0x5a6258],
    car: [0x5f6b55, 0x6b7a5a, 0x7d6a48, 0x8a8f7a, 0x3d4535],
    sign: [0xf2d43a, 0xd9382c, 0x6b7a5a, 0xe0e0d8],
  },
  park: {
    wall: [0xe4b4b8, 0xa8d4dc, 0xecd690, 0xc4dca4, 0xd4b8e0, 0xecc8a0, 0xf0e0d0],
    apartment: [0xe0c8b0, 0xc8a8b8, 0xa8c0d0, 0xe8d8a8, 0xd0b0a0],
    roof: [0xb04848, 0x4878a8, 0xd8a838, 0x7a4a8a, 0x3a8a6a],
    warehouse: [0x9a8a9a, 0x8a9aa8, 0xb09a80, 0xa87a7a],
    container: [0xc0504a, 0x4a7ab0, 0xd8a840, 0x8a5aa0, 0x4aa08a],
    glass: [0x6a88a0, 0x8a9ab0, 0x9a88b0, 0x70a0a0],
    car: [0xc05050, 0x5080c0, 0xe0c060, 0x60a080, 0xe0e0e0, 0xb070c0],
    sign: [0xe53935, 0xfdd835, 0x1e88e5, 0xab47bc, 0x43a047, 0xff7043],
  },
  western: {
    wall: [0xa8845a, 0x8a6a48, 0xc8a878, 0xb89a70, 0x9a7a58, 0xd8c0a0, 0x7a5a3a],
    apartment: [0xc8a878, 0xb08a60, 0xd8c0a0, 0xa07850],
    roof: [0x5a3d2a, 0x6b4a2f, 0x4a3a2a, 0x8a5a3a],
    warehouse: [0x8a6a48, 0x9a7a58, 0x7a5a3a],
    container: [0x8a6a48, 0x9a7a58, 0x6b4a2f, 0xa8845a],
    glass: [0x5a6a70, 0x6a7a80],
    car: [0x6b4a2f, 0x8a2a2a, 0x3a3a3a, 0xc8a878],
    sign: [0xd8c8a0, 0xc03a2a, 0x2a4a7a, 0xe0b040],
  },
}[THEME === 'world' ? 'default' : THEME];
const WALL_COLORS = PALETTES.wall;
const APARTMENT_COLORS = PALETTES.apartment;
const ROOF_COLORS = PALETTES.roof;
const WAREHOUSE_COLORS = PALETTES.warehouse;
const CONTAINER_COLORS = PALETTES.container;
const GLASS_COLORS = PALETTES.glass;
const CAR_COLORS = PALETTES.car;
const SIGN_COLORS = PALETTES.sign;
/** Faded fairground stripes. */
const STRIPES = [[0xd04848, 0xf0e8e0], [0x3a78c0, 0xf0e8e0], [0xe0b030, 0xc04040], [0x8a50a8, 0xf0d040], [0x40a080, 0xf0e8e0]];

const ASPHALT = THEME === 'western' ? 0x8a6c4a : 0x4b4f55;
const CONCRETE = 0xa8a8a0;

/** Hand-placed towns on a seeded, hilly island: identical every match. */
export class GameMap {
  readonly size = CONFIG.mapSize;
  readonly half = CONFIG.mapSize / 2;
  world: CollisionWorld;
  terrain: Terrain;
  pois: POI[] = [];
  lootSpots: Vector3[] = [];
  footprints: Footprint[] = [];
  roads: { x0: number; z0: number; x1: number; z1: number }[] = [];
  /** Railway line segments (Wild West). */
  rails: { x0: number; z0: number; x1: number; z1: number }[] = [];
  /** The train's loop (rail-top height), closed: the last point joins the first. */
  track: { x: number; y: number; z: number }[] = [];
  /** Platforms the train stops at. */
  trainStops: { x: number; z: number }[] = [];
  /** Where the best loot is: vaults and armouries get a golden chest every match. */
  vaultSpots: Vector3[] = [];
  /** k: 0 pine, 1 spruce, 2 oak, 3 birch, 4 autumn maple, 5 dead tree. */
  trees: { x: number; y: number; z: number; r: number; k: number }[] = [];
  bushes: { x: number; y: number; z: number; r: number }[] = [];
  padSpots: Vector3[] = [];
  turbineSpots: Spot[] = [];
  lighthouseSpots: Vector3[] = [];
  fireSpots: Vector3[] = [];
  barrelSpots: Vector3[] = [];
  vehicleSpots: Spot[] = [];
  landmarks: { name: string; x: number; z: number }[] = [];
  /** Purely decorative meshes (grass, flowers) that low graphics quality hides. */
  detail: Object3D[] = [];
  mapCanvas!: HTMLCanvasElement;
  doors: DoorSpec[] = [];
  glass: Box[] = [];
  props: DestructibleSpec[] = [];
  ziplines: ZiplineSpec[] = [];
  bridges: Bridge[] = [];
  /** Flat, open spot on the airport runway used by the practice range. */
  rangeSpot = new Vector3();
  /** Gulag arenas, far out at sea. `gulag` is the one in use this time. */
  readonly gulags = [new Vector3(0, 0, 1150), new Vector3(1150, 0, 0)];
  readonly gulagNames = ['THE PRISON YARD', 'THE SHIPYARD'];
  gulag = this.gulags[0];
  sea!: Mesh;
  /** The Foundry: a walled deathmatch arena on a platform out at sea (Arena and Team Deathmatch). */
  readonly arena = new Vector3(-1100, 0, 0);
  /** Half-size of the arena floor (x, z). */
  readonly arenaHalf = { x: 48, z: 30 };
  /** Spawn points per side: [0] west (blue), [1] east (red). */
  arenaSpawns: Vector3[][] = [[], []];
  /** Where the power weapons lie. */
  arenaPickups: { at: Vector3; weapon: 'sniper' | 'rocket' | 'shotgun' | 'lmg' }[] = [];

  private solids: Solid[] = [];
  private decals: Solid[] = [];
  private occupied: Rect[] = [];
  private locked: Uint8Array;
  private rng: Rng;
  private noiseA: (x: number, y: number) => number;
  private noiseB: (x: number, y: number) => number;
  private inCity = false;
  private lastLot: Lot | null = null;
  private towerTops: Vector3[] = [];
  /** Walls of tall buildings a vertical zipline can climb: wall middle, roof height, outward direction. */
  private climbSpots: { x: number; z: number; top: number; ox: number; oz: number }[] = [];
  private cullables: Cullable[] = [];

  constructor(private scene: Scene) {
    this.rng = mulberry32(CONFIG.mapSeed);
    this.noiseA = makeNoise(CONFIG.mapSeed + 1);
    this.noiseB = makeNoise(CONFIG.mapSeed + 2);
    this.terrain = new Terrain(1400, 4);
    this.locked = new Uint8Array(this.terrain.n * this.terrain.n);
    // Big enough to include the gulag arena out at sea.
    this.world = new CollisionWorld(2400);
    this.world.terrain = this.terrain;
  }

  /** Generates everything in stages, yielding a progress label between them (keeps the loading bar alive). */
  *build(): Generator<string> {
    yield 'Raising the island';
    this.buildTerrain();
    yield 'Paving roads';
    this.generateTowns();
    yield 'Building towns';
    this.generateCountryside();
    yield 'Planting forests';
    this.generateScatter();
    yield 'Assembling meshes';
    this.buildMeshes();
    yield 'Drawing the map';
    this.mapCanvas = this.drawMapCanvas();
  }

  /** Hides chunks beyond their draw distance. `fogFar` is the current fog distance. */
  cull(cam: Vector3, fogFar: number, detailMul: number) {
    for (const c of this.cullables) {
      const d = Math.hypot(c.x - cam.x, c.z - cam.z) - c.r;
      // The gulag and arena out at sea only show up once you're actually there (not from the plane).
      const max = c.offshore ? 160 : c.max ? c.max * detailMul : fogFar + 40;
      const vis = d < max;
      if (c.obj.userData.detail && c.obj.userData.hidden) c.obj.visible = false;
      else c.obj.visible = vis;
    }
  }

  groundAt(x: number, z: number) {
    if (this.inArenaBounds(x, z, 2)) return 0.1;
    return this.terrain.heightAt(x, z);
  }

  inArenaBounds(x: number, z: number, margin = 0) {
    return Math.abs(x - this.arena.x) < this.arenaHalf.x + margin && Math.abs(z - this.arena.z) < this.arenaHalf.z + margin;
  }

  /** Standing in a lake or the sea. */
  isWater(x: number, z: number) {
    return this.terrain.heightAt(x, z) < -0.3;
  }

  /** The named location containing (x, z), if any. */
  poiAt(x: number, z: number): POI | null {
    for (const p of this.pois) if (Math.hypot(p.x - x, p.z - z) < p.radius + 10) return p;
    return null;
  }

  // ---------- terrain ----------

  private rawHeight(x: number, z: number) {
    const n = fbm(this.noiseA, x * 0.0045, z * 0.0045, 4);
    let h = 1.6 + 24 * Math.pow(Math.max(0, (n - 0.38) / 0.62), 1.5);
    h += (fbm(this.noiseB, x * 0.03, z * 0.03, 2) - 0.5) * 1.8;
    for (const m of MOUNTAINS) {
      const d2 = (x - m.x) ** 2 + (z - m.z) ** 2;
      h += m.h * Math.exp(-d2 / (2 * m.s * m.s));
    }
    if (THEME === 'western') {
      h += 6;
      for (const m of MESAS) {
        const k = 1 - smoothstep(m.r, m.r + 12, Math.hypot(x - m.x, z - m.z));
        if (k > 0) h = lerp(h, Math.max(h, m.top), k);
      }
      if (CANYON) {
        const d = this.canyonDist(x, z);
        if (d < CANYON.w + CANYON.wall) h = lerp(0.7, h, smoothstep(CANYON.w, CANYON.w + CANYON.wall, d));
      }
    }
    // Coastline: a wobbly beach that falls away into the sea.
    for (const l of LAKES) {
      const d = Math.hypot(x - l.x, z - l.z);
      if (d < l.r * 1.8) h = lerp(-2.4, h, smoothstep(0.55, 1.8, d / l.r));
    }
    const wobble = -18 * this.noiseB(x * 0.012 + 50, z * 0.012 + 50);
    // A round island: distance from the centre, with a wobbly shoreline.
    const edge = this.half + 4 - Math.hypot(x, z) + wobble;
    const inland = 1.0 + (h - 1.0) * smoothstep(20, 120, edge);
    return lerp(-3, inland, smoothstep(0, 1, (edge + 15) / 35));
  }

  private buildTerrain() {
    const T = this.terrain, n = T.n;
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) T.heights[iz * n + ix] = this.rawHeight(T.coord(ix), T.coord(iz));
    }
    // Flatten each town onto a plateau that blends into the hills around it.
    for (const t of TOWNS) {
      const y = Math.max(1.6, this.rawHeight(t.x, t.z));
      this.pois.push({ ...t, y });
      const flat = t.radius + 12, blend = 55;
      this.forVerts(t.x - flat - blend, t.z - flat - blend, t.x + flat + blend, t.z + flat + blend, (i, x, z) => {
        const d = Math.hypot(x - t.x, z - t.z);
        if (d <= flat) {
          T.heights[i] = y;
          this.locked[i] = 1;
        } else if (d < flat + blend && !this.locked[i]) {
          T.heights[i] = lerp(y, T.heights[i], smoothstep(0, 1, (d - flat) / blend));
        }
      });
    }
    // Rivers are carved after the towns so plateaus never fill them in.
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const x = T.coord(ix), z = T.coord(iz), i = iz * n + ix;
        const r = this.riverAt(x, z);
        if (!r) continue;
        const bed = -2.7 + clamp(r.d / r.w, 0, 1) * 0.6;
        const k = smoothstep(r.w * 0.55, r.w * 2.3, r.d);
        if (k < 1) {
          T.heights[i] = Math.min(T.heights[i], lerp(bed, T.heights[i], k));
          if (k < 0.5) this.locked[i] = 1;
        }
      }
    }
  }

  /** Distance to the canyon's centreline (Wild West only). */
  canyonDist(x: number, z: number) {
    if (!CANYON) return Infinity;
    let best = Infinity;
    for (let i = 0; i < CANYON.pts.length - 1; i++) {
      const [ax, az] = CANYON.pts[i], [bx, bz] = CANYON.pts[i + 1];
      const vx = bx - ax, vz = bz - az, t = clamp(((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz), 0, 1);
      best = Math.min(best, Math.hypot(ax + vx * t - x, az + vz * t - z));
    }
    return best;
  }

  /** Distance to the nearest river centreline (only within ~2.5 widths), or null. */
  riverAt(x: number, z: number): { d: number; w: number; dx: number; dz: number } | null {
    let best: { d: number; w: number; dx: number; dz: number } | null = null;
    for (const r of RIVERS) {
      for (let i = 0; i < r.pts.length - 1; i++) {
        const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
        const vx = bx - ax, vz = bz - az, len2 = vx * vx + vz * vz;
        const t = clamp(((x - ax) * vx + (z - az) * vz) / len2, 0, 1);
        const d = Math.hypot(ax + vx * t - x, az + vz * t - z);
        if (d < r.w * 2.5 && (!best || d < best.d)) {
          const l = Math.sqrt(len2);
          best = { d, w: r.w, dx: vx / l, dz: vz / l };
        }
      }
    }
    return best;
  }

  private forVerts(x0: number, z0: number, x1: number, z1: number, fn: (i: number, x: number, z: number) => void) {
    const T = this.terrain;
    const i0 = clamp(Math.floor((x0 + T.extent / 2) / T.cell), 0, T.n - 1), i1 = clamp(Math.ceil((x1 + T.extent / 2) / T.cell), 0, T.n - 1);
    const j0 = clamp(Math.floor((z0 + T.extent / 2) / T.cell), 0, T.n - 1), j1 = clamp(Math.ceil((z1 + T.extent / 2) / T.cell), 0, T.n - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * T.n + i, T.coord(i), T.coord(j));
  }

  /** Levels the ground under a building footprint and returns the floor height. */
  private prepareGround(r: Rect): number | null {
    const T = this.terrain;
    let sum = 0, lo = Infinity, hi = -Infinity, cnt = 0;
    for (let a = 0; a <= 2; a++) for (let b = 0; b <= 2; b++) {
      const h = T.heightAt(lerp(r.x0, r.x1, a / 2), lerp(r.z0, r.z1, b / 2));
      sum += h;
      cnt++;
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    if (hi - lo > 7 || lo < 0.6) return null; // too steep, or in the water
    const y = sum / cnt;
    const pad = 2, blend = 9;
    this.forVerts(r.x0 - pad - blend, r.z0 - pad - blend, r.x1 + pad + blend, r.z1 + pad + blend, (i, x, z) => {
      if (this.locked[i]) return;
      const dx = Math.max(r.x0 - pad - x, 0, x - r.x1 - pad), dz = Math.max(r.z0 - pad - z, 0, z - r.z1 - pad);
      const d = Math.hypot(dx, dz);
      if (d === 0) {
        T.heights[i] = y;
        this.locked[i] = 1;
      } else if (d < blend) {
        T.heights[i] = lerp(y, T.heights[i], smoothstep(0, 1, d / blend));
      }
    });
    // Anything still lower than the floor (e.g. a locked plateau edge) gets a foundation.
    let minAfter = Infinity;
    for (let a = 0; a <= 2; a++) for (let b = 0; b <= 2; b++) minAfter = Math.min(minAfter, T.heightAt(lerp(r.x0, r.x1, a / 2), lerp(r.z0, r.z1, b / 2)));
    if (minAfter < y - 0.05) this.addSolid(r.x0, minAfter - 0.5, r.z0, r.x1, y, r.z1, 0x9a948a);
    return y;
  }

  // ---------- generation ----------

  private generateTowns() {

    // Roads connect each town to its two nearest neighbours; cities use their own street grid inside.
    const seen = new Set<string>();
    const link = (p: POI, q: POI) => {
      const key = [p.name, q.name].sort().join('|');
      if (seen.has(key)) return;
      seen.add(key);
      this.roads.push(...this.clipRoad(p.x, p.z, q.x, q.z));
    };
    if (THEME === 'park') {
      // Footpaths: a ring joining each zone to the next round the lake, and bridges out to the castle island.
      const hub = this.pois.find((p) => p.flavor === 'castle')!;
      const ring = this.pois.filter((p) => p !== hub).sort((a, b) => Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x));
      ring.forEach((p, i) => link(p, ring[(i + 1) % ring.length]));
      for (const p of [...ring].sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z)).slice(0, 4)) link(hub, p);
      link(hub, this.pois[0]);
    } else {
      for (const p of this.pois) {
        const near = this.pois.filter((q) => q !== p).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
        for (const q of near.slice(0, 2)) link(p, q);
      }
    }
    this.buildBridges();
    if (RAIL) this.buildRailway();

    for (const poi of this.pois) {
      if (poi.size === 'city') this.populateCity(poi);
      else this.populateTown(poi);
    }
    if (THEME === 'military') {
      for (const poi of this.pois) {
        if (poi.size === 'city') this.baseWall(poi);
        else if (!['military', 'prison', 'airport'].includes(poi.flavor)) this.fenceZone(poi);
      }
      this.placeCheckpoints();
    }
    if (THEME === 'park') this.swanBoats();
    this.buildDam();
  }

  private generateCountryside() {
    const rng = this.rng;

    // Lone buildings out in the countryside
    for (let i = 0; i < 70; i++) {
      const x = rand(rng, -460, 460), z = rand(rng, -460, 460);
      if (this.pois.some((p) => Math.hypot(p.x - x, p.z - z) < p.radius + 25)) continue;
      const r = rng();
      if (THEME === 'military') {
        if (r < 0.06) this.tryObstacleCourse(x, z);
        else if (r < 0.1) this.tryFuelDepot(x, z);
        else if (r < 0.2) this.tryBunker(x, z);
        else if (r < 0.38) this.tryContainerStack(x, z);
        else if (r < 0.52) this.tryCamoNet(x, z);
        else if (r < 0.66) this.tryTank(x, z);
        else if (r < 0.76) this.tryRadarDome(x, z);
        else if (r < 0.86) this.tryHouse(x, z, 1);
        else if (r < 0.94) this.tryRuins(x, z);
        else this.tryRadioTower(x, z);
        continue;
      }
      if (THEME === 'western') {
        if (r < 0.25) this.tryWesternHouse(x, z);
        else if (r < 0.33) this.tryStables(x, z);
        else if (r < 0.4) this.tryBarn(x, z);
        else if (r < 0.55) this.tryWaterTower(x, z);
        else if (r < 0.7) this.tryRuins(x, z);
        else if (r < 0.85) this.tryWagon(x, z);
        else this.tryShop(x, z);
        continue;
      }
      if (THEME === 'park') {
        if (r < 0.26) this.stallRow(x, z);
        else if (r < 0.4) this.tryRuins(x, z);
        else if (r < 0.52) this.tryHouse(x, z, 1);
        else if (r < 0.62) this.tryCarousel(x, z);
        else if (r < 0.7) this.tryShop(x, z);
        else if (r < 0.78) this.tryContainerStack(x, z);
        else if (r < 0.86) this.tryBarn(x, z);
        else if (r < 0.93) this.tryBumperCars(x, z);
        else this.tryDropTower(x, z);
        continue;
      }
      if (THEME === 'world') {
        if (r < 0.26) this.tryHouse(x, z, rng() < 0.35 ? 2 : 1);
        else if (r < 0.34) this.tryRuins(x, z);
        else if (r < 0.42) this.tryContainerStack(x, z);
        else if (r < 0.5) this.tryBarn(x, z);
        else if (r < 0.56) this.tryGasStation(x, z);
        else if (r < 0.62) this.tryShop(x, z);
        else if (r < 0.68) this.tryBunker(x, z);
        else if (r < 0.73) this.tryWaterTower(x, z);
        else if (r < 0.78) this.tryTank(x, z);
        else if (r < 0.83) this.tryWesternHouse(x, z);
        else if (r < 0.88) this.tryRadarDome(x, z);
        else if (r < 0.93) this.trySilo(x, z);
        else this.tryRadioTower(x, z);
        continue;
      }
      if (r < 0.32) this.tryHouse(x, z, rng() < 0.35 ? 2 : 1);
      else if (r < 0.45) this.tryRuins(x, z);
      else if (r < 0.58) this.tryContainerStack(x, z);
      else if (r < 0.7) this.tryBarn(x, z);
      else if (r < 0.78) this.trySilo(x, z);
      else if (r < 0.86) this.tryShop(x, z);
      else if (r < 0.92) this.tryGasStation(x, z);
      else this.tryRadioTower(x, z);
    }

    this.placeParkour();
    this.placeLandmarks();
    // The terrain raycast skips everything above the highest hill, so that has to be current first.
    this.terrain.recomputeMax();
    this.placeZiplines();
  }

  private generateScatter() {
    const rng = this.rng;
    this.placeFieldCover();

    // Trees
    for (let i = 0; i < 900; i++) {
      const x = rand(rng, -485, 485), z = rand(rng, -485, 485);
      if (this.pois.some((p) => Math.hypot(p.x - x, p.z - z) < p.radius * 0.9 + 6)) continue;
      if (this.nearRoad(x, z, 7)) continue;
      if (this.overlapsOccupied({ x0: x - 1, z0: z - 1, x1: x + 1, z1: z + 1 }, 1)) continue;
      const y = this.terrain.heightAt(x, z);
      if (y < 1.2) continue; // no trees on the beach
      this.addTree(x, z, rand(rng, 1.8, 2.9));
    }

    // Bushes: soft cover you can hide in (bots can't see through them)
    for (let i = 0; i < 1100; i++) {
      const x = rand(rng, -485, 485), z = rand(rng, -485, 485);
      const poi = this.poiAt(x, z);
      if (poi && Math.hypot(poi.x - x, poi.z - z) < poi.radius * 0.8) continue;
      if (this.nearRoad(x, z, 5) || this.overlapsOccupied({ x0: x - 1, z0: z - 1, x1: x + 1, z1: z + 1 }, 0.8)) continue;
      const y = this.terrain.heightAt(x, z);
      if (y < 1.2) continue;
      this.bushes.push({ x, y, z, r: rand(rng, 0.9, 1.5) });
    }

    // Rocks: small ones everywhere, big boulders up in the hills.
    for (let i = 0; i < 300; i++) {
      const x = rand(rng, -480, 480), z = rand(rng, -480, 480);
      const y = this.terrain.heightAt(x, z);
      const big = y > 14 && rng() < 0.6;
      const w = rand(rng, 1.2, big ? 7 : 4.5), d = rand(rng, 1.2, big ? 7 : 4.5), h = rand(rng, 0.8, big ? 5 : 3.2);
      const rect = { x0: x - w / 2, z0: z - d / 2, x1: x + w / 2, z1: z + d / 2 };
      if (this.overlapsOccupied(rect, 2) || this.nearRoad(x, z, 6) || this.poiAt(x, z) || y < 0.5) continue;
      const base = Math.min(...[[rect.x0, rect.z0], [rect.x1, rect.z0], [rect.x0, rect.z1], [rect.x1, rect.z1]].map(([a, b]) => this.terrain.heightAt(a, b))) - 0.4;
      const shade = pick(rng, THEME === 'western' ? [0xc07a4a, 0xb0683a, 0xd09060, 0xa86040] : [0x8a8f96, 0x9da3a8, 0x7a7f86, 0xa59e94]);
      const top = y + h;
      this.addSolid(rect.x0, base, rect.z0, rect.x1, top, rect.z1, shade);
      if (rng() < 0.5) {
        const w2 = w * rand(rng, 0.4, 0.7), d2 = d * rand(rng, 0.4, 0.7), ox = rand(rng, -0.5, 0.5);
        this.addSolid(x - w2 / 2 + ox, top, z - d2 / 2, x + w2 / 2 + ox, top + rand(rng, 0.4, 1.2), z + d2 / 2, shade);
      }
      this.occupied.push(rect);
    }

    // Invisible map boundary walls
    const H = this.half, T = 200; // thick so nothing can tunnel out of the island
    for (const [x0, z0, x1, z1] of [
      [-H - T, -H - T, H + T, -H], [-H - T, H, H + T, H + T], [-H - T, -H, -H, H], [H, -H, H + T, H],
    ]) this.world.add({ minX: x0, minY: -50, minZ: z0, maxX: x1, maxY: 3000, maxZ: z1 });

    this.buildGulag();
    this.buildShipyard();
    this.buildArena();
    this.terrain.recomputeMax();
  }

  /** Splits a road into the parts that lie outside city limits. */
  private clipRoad(x0: number, z0: number, x1: number, z1: number) {
    const out: { x0: number; z0: number; x1: number; z1: number }[] = [];
    const inside = (t: number) => {
      const x = lerp(x0, x1, t), z = lerp(z0, z1, t);
      return this.pois.some((p) => p.size === 'city' && Math.hypot(p.x - x, p.z - z) < p.radius * 0.93);
    };
    const N = 300;
    let start = -1;
    for (let i = 0; i <= N; i++) {
      const t = i / N, ins = inside(t);
      if (!ins && start < 0) start = t;
      if ((ins || i === N) && start >= 0) {
        if (t - start > 0.02) out.push({ x0: lerp(x0, x1, start), z0: lerp(z0, z1, start), x1: lerp(x0, x1, t), z1: lerp(z0, z1, t) });
        start = -1;
      }
    }
    return out;
  }

  private populateCity(poi: POI) {
    const rng = this.rng;
    const P = 34, street = 9, block = P - street;
    const n = Math.ceil(poi.radius / P);
    this.inCity = true;
    const must: ((x: number, z: number) => boolean)[] = THEME === 'western' ? [
      (x, z) => this.tryBank(x, z), (x, z) => this.trySaloon(x, z), (x, z) => this.trySheriff(x, z),
      (x, z) => this.tryChurch(x, z), (x, z) => this.tryHotel(x, z), (x, z) => this.trySaloon(x, z),
    ] : THEME === 'world' ? [(x, z) => this.tryBank(x, z), (x, z) => this.tryBank(x, z)] : [];
    // Street grid
    for (let i = -n; i < n; i++) {
      const s = (i + 0.5) * P;
      if (Math.abs(s) > poi.radius) continue;
      const half = Math.sqrt(poi.radius ** 2 - s * s);
      this.addDecal(poi.x - half, poi.z + s - street / 2, poi.x + half, poi.z + s + street / 2, poi.y, ASPHALT);
      this.addDecal(poi.x + s - street / 2, poi.z - half, poi.x + s + street / 2, poi.z + half, poi.y, ASPHALT);
    }
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        const cx = poi.x + i * P, cz = poi.z + j * P;
        if (Math.hypot(i * P, j * P) + block * 0.6 > poi.radius) continue;
        const bx0 = cx - block / 2, bz0 = cz - block / 2, bx1 = cx + block / 2, bz1 = cz + block / 2;
        this.addDecal(bx0, bz0, bx1, bz1, poi.y, THEME === 'western' ? 0xb8986a : 0xb9b5ab, 0.035); // sidewalk slab
        if (i === 0 && j === 0) {
          this.plaza(cx, cz, poi.y, block);
          continue;
        }
        const edge = Math.hypot(i * P, j * P) / poi.radius; // 0 center .. 1 outskirts
        const r = rng();
        let ok = false;
        if (must.length && edge < 0.7 && must[0](cx, cz)) {
          must.shift();
          continue;
        }
        if (THEME === 'military') {
          if (r < 0.18) ok = this.tryHouse(cx, cz, randInt(rng, 2, 4));
          else if (r < 0.28) ok = this.tryBarracks(cx, cz);
          else if (r < 0.36) ok = this.tryMotorShed(cx, cz);
          else if (r < 0.44) ok = this.tryWarehouse(cx, cz);
          else if (r < 0.54) ok = this.tryContainerStack(cx - 5, cz) && (this.tryContainerStack(cx + 5, cz) || true);
          else if (r < 0.63) ok = this.tryRadarDome(cx, cz);
          else if (r < 0.72) ok = this.tryBunker(cx, cz);
          else if (r < 0.8) ok = this.tryCamoNet(cx, cz);
          else if (r < 0.88) ok = this.parking(cx, cz, poi.y, block);
          else ok = this.tryTank(cx, cz);
        } else if (THEME === 'western') {
          if (r < 0.3) ok = this.tryShop(cx, cz - 5.5, -1) && (this.tryShop(cx, cz + 6.5, 1) || true);
          else if (r < 0.38) ok = this.tryBank(cx, cz);
          else if (r < 0.46) ok = this.trySaloon(cx, cz);
          else if (r < 0.52) ok = this.trySheriff(cx, cz);
          else if (r < 0.6) ok = this.tryHotel(cx, cz);
          else if (r < 0.74) ok = this.tryWesternHouse(cx, cz);
          else if (r < 0.78) ok = this.tryChurch(cx, cz);
          else if (r < 0.83) ok = this.tryWaterTower(cx, cz);
          else if (r < 0.9) ok = this.tryStables(cx, cz);
          else if (r < 0.95) ok = this.tryWagon(cx - 4, cz) && (this.tryWagon(cx + 4, cz + 3) || true);
          else ok = this.tryBarn(cx, cz);
        } else if (THEME === 'park') {
          if (r < 0.26) ok = this.tryShop(cx, cz - 5.5, -1) && (this.tryShop(cx, cz + 6.5, 1) || true);
          else if (r < 0.46) ok = this.tryHouse(cx, cz, randInt(rng, 2, poi.name === 'Grand Hotels' ? 5 : 3));
          else if (r < 0.58) ok = this.stallRow(cx, cz);
          else if (r < 0.67) ok = this.tryCarousel(cx, cz);
          else if (r < 0.74) ok = this.tryBumperCars(cx, cz);
          else if (r < 0.79) ok = this.tryDropTower(cx, cz);
          else if (r < 0.86) ok = this.parking(cx, cz, poi.y, block);
          else ok = this.park(cx, cz, poi.y, block);
        } else if (r < 0.34 - edge * 0.15) ok = this.tryTower(cx, cz, edge);
        else if (r < 0.56) ok = this.tryHouse(cx, cz, randInt(rng, 3, 5));
        else if (r < 0.68) ok = this.tryShop(cx, cz - 5.5, -1) && (this.tryShop(cx, cz + 6.5, 1) || true);
        else if (r < 0.78) ok = this.parking(cx, cz, poi.y, block);
        else if (r < 0.86) ok = this.park(cx, cz, poi.y, block);
        else if (r < 0.93) ok = this.tryWarehouse(cx, cz);
        else ok = this.tryHouse(cx - 6.3, cz, 2, 11.4) && (this.tryHouse(cx + 6.3, cz, 1, 11.4) || true);
        if (!ok) this.park(cx, cz, poi.y, block);
      }
    }
    this.inCity = false;
  }

  private populateTown(poi: POI) {
    const rng = this.rng;
    if (poi.flavor === 'military') return this.buildMilitary(poi);
    if (poi.flavor === 'castle') return this.buildCastle(poi);
    if (poi.flavor === 'prison') return this.buildPrison(poi);
    if (poi.flavor === 'airport') return this.buildAirport(poi);
    type Maker = [number, (x: number, z: number) => boolean];
    let reach = poi.radius;
    if (poi.feature === 'bigtop') this.centrepiece(poi, (x, z) => this.tryBigTop(x, z));
    else if (poi.feature === 'carousel') this.centrepiece(poi, (x, z) => this.tryCarousel(x, z));
    else if (poi.feature === 'bumper') this.centrepiece(poi, (x, z) => this.tryBumperCars(x, z));
    else if (poi.feature === 'silo') this.centrepiece(poi, (x, z) => this.tryMissileSilo(x, z));
    else if (poi.feature === 'station') this.buildStation(poi);
    else if (poi.feature === 'mine') this.centrepiece(poi, (x, z) => this.tryMine(x, z));
    else if (poi.feature === 'bunker') this.centrepiece(poi, (x, z) => this.tryCommandBunker(x, z));
    else if (poi.feature === 'fuel') this.centrepiece(poi, (x, z) => this.tryFuelDepot(x, z));
    if (THEME === 'military' && poi.flavor === 'harbor') this.buildWarship(poi);
    if (poi.flavor === 'wheel') this.centrepiece(poi, (x, z) => this.buildFerrisWheel(x, z));
    if (poi.flavor === 'coaster') {
      this.buildCoaster(poi);
      reach = poi.radius * 0.58;
    }
    const western: Partial<Record<Flavor, Maker[]>> = {
      residential: [
        [0.24, (x, z) => this.tryShop(x, z)], [0.26, (x, z) => this.tryWesternHouse(x, z)], [0.1, (x, z) => this.trySaloon(x, z)],
        [0.07, (x, z) => this.trySheriff(x, z)], [0.06, (x, z) => this.tryBank(x, z)], [0.05, (x, z) => this.tryChurch(x, z)],
        [0.06, (x, z) => this.tryHotel(x, z)], [0.06, (x, z) => this.tryWaterTower(x, z)], [0.06, (x, z) => this.tryWagon(x, z)],
        [0.04, (x, z) => this.tryStables(x, z)],
      ],
      industrial: [
        [0.25, (x, z) => this.tryWarehouse(x, z)], [0.18, (x, z) => this.tryWagon(x, z)], [0.14, (x, z) => this.tryWaterTower(x, z)],
        [0.18, (x, z) => this.tryWesternHouse(x, z)], [0.1, (x, z) => this.tryStables(x, z)], [0.08, (x, z) => this.trySaloon(x, z)],
        [0.07, (x, z) => this.tryRuins(x, z)],
      ],
      harbor: [
        [0.26, (x, z) => this.tryWarehouse(x, z)], [0.2, (x, z) => this.tryShop(x, z)], [0.14, (x, z) => this.tryWagon(x, z)],
        [0.14, (x, z) => this.trySaloon(x, z)], [0.12, (x, z) => this.tryHotel(x, z)], [0.14, (x, z) => this.tryWesternHouse(x, z)],
      ],
      farm: [
        [0.2, (x, z) => this.tryBarn(x, z)], [0.22, (x, z) => this.tryStables(x, z)], [0.14, (x, z) => this.tryWaterTower(x, z)],
        [0.22, (x, z) => this.tryWesternHouse(x, z)], [0.12, (x, z) => this.tryField(x, z)], [0.1, (x, z) => this.tryWagon(x, z)],
      ],
    };
    const themed: Partial<Record<Flavor, Maker[]>> = THEME === 'western' ? western : THEME !== 'military' ? {} : {
        residential: [[0.5, (x, z) => this.tryHouse(x, z, 2)], [0.2, (x, z) => this.tryBunker(x, z)], [0.3, (x, z) => this.tryHouse(x, z, 1)]],
        industrial: [
          [0.2, (x, z) => this.tryMotorShed(x, z)], [0.2, (x, z) => this.tryWarehouse(x, z)], [0.14, (x, z) => this.tryContainerStack(x, z)],
          [0.1, (x, z) => this.tryFuelDepot(x, z)], [0.12, (x, z) => this.tryCamoNet(x, z)], [0.12, (x, z) => this.tryTank(x, z)],
          [0.08, (x, z) => this.tryHangar(x, z)], [0.06, (x, z) => this.tryBarracks(x, z)],
        ],
        harbor: [
          [0.3, (x, z) => this.tryContainerStack(x, z)], [0.22, (x, z) => this.tryWarehouse(x, z)], [0.1, (x, z) => this.tryCrane(x, z)],
          [0.14, (x, z) => this.tryBarracks(x, z)], [0.12, (x, z) => this.tryFuelDepot(x, z)], [0.12, (x, z) => this.tryBunker(x, z)],
        ],
        labs: [
          [0.3, (x, z) => this.tryRadarDome(x, z)], [0.2, (x, z) => this.tryHouse(x, z, 3, 99, 0xdfe2dc)], [0.2, (x, z) => this.tryBunker(x, z)],
          [0.1, (x, z) => this.tryBarracks(x, z)],
          [0.15, (x, z) => this.tryRadioTower(x, z)], [0.1, (x, z) => this.tryContainerStack(x, z)],
        ],
        farm: [
          [0.16, (x, z) => this.tryBunker(x, z)], [0.14, (x, z) => this.tryCamoNet(x, z)], [0.18, (x, z) => this.tryTank(x, z)],
          [0.1, (x, z) => this.tryWatchtower(x, z)], [0.12, (x, z) => this.tryContainerStack(x, z)], [0.14, (x, z) => this.tryObstacleCourse(x, z)],
          [0.08, (x, z) => this.tryBarracks(x, z)], [0.08, (x, z) => this.tryFuelDepot(x, z)],
        ],
    };
    const tables: Record<Flavor, Maker[]> = {
      downtown: [], military: [], castle: [], airport: [], prison: [], frontier: western.residential!,
      fair: [
        [0.35, (x, z) => this.stallRow(x, z)], [0.15, (x, z) => this.tryShop(x, z)], [0.12, (x, z) => this.tryCarousel(x, z)],
        [0.1, (x, z) => this.tryHouse(x, z, 1)], [0.08, (x, z) => this.tryDropTower(x, z)], [0.1, (x, z) => this.tryRuins(x, z)],
        [0.1, (x, z) => this.tryContainerStack(x, z)],
      ],
      coaster: [
        [0.4, (x, z) => this.stallRow(x, z)], [0.2, (x, z) => this.tryShop(x, z)], [0.15, (x, z) => this.tryHouse(x, z, 2)],
        [0.1, (x, z) => this.tryCarousel(x, z)], [0.15, (x, z) => this.tryWarehouse(x, z)],
      ],
      wheel: [
        [0.4, (x, z) => this.stallRow(x, z)], [0.2, (x, z) => this.tryShop(x, z)], [0.2, (x, z) => this.tryHouse(x, z, 1)],
        [0.2, (x, z) => this.tryRuins(x, z)],
      ],
      haunted: [
        [0.55, (x, z) => this.tryHauntedHouse(x, z)], [0.15, (x, z) => this.tryRuins(x, z)], [0.12, (x, z) => this.stallRow(x, z)],
        [0.1, (x, z) => this.tryHouse(x, z, 1, 99, 0x4a4450)], [0.08, (x, z) => this.tryBarn(x, z)],
      ],
      residential: [
        [0.3, (x, z) => this.tryHouse(x, z, 1)], [0.26, (x, z) => this.tryHouse(x, z, 2)],
        [0.1, (x, z) => this.tryHouse(x, z, 3)], [0.14, (x, z) => this.tryShop(x, z)],
        [0.06, (x, z) => this.tryGasStation(x, z)], [0.07, (x, z) => this.tryRuins(x, z)], [0.07, (x, z) => this.tryBarn(x, z)],
      ],
      industrial: [
        [0.3, (x, z) => this.tryWarehouse(x, z)], [0.22, (x, z) => this.tryContainerStack(x, z)],
        [0.14, (x, z) => this.trySilo(x, z)], [0.1, (x, z) => this.tryChimney(x, z)],
        [0.12, (x, z) => this.tryHouse(x, z, 2)], [0.12, (x, z) => this.tryRuins(x, z)],
      ],
      harbor: [
        [0.34, (x, z) => this.tryContainerStack(x, z)], [0.22, (x, z) => this.tryWarehouse(x, z)],
        [0.08, (x, z) => this.tryCrane(x, z)], [0.16, (x, z) => this.tryHouse(x, z, 2)],
        [0.1, (x, z) => this.tryShop(x, z)], [0.1, (x, z) => this.tryHouse(x, z, 1)],
      ],
      labs: [
        [0.35, (x, z) => this.tryWarehouse(x, z, 0xe8ecef)], [0.25, (x, z) => this.tryHouse(x, z, 3, 99, 0xeef1f4)],
        [0.15, (x, z) => this.tryRadioTower(x, z)], [0.1, (x, z) => this.trySilo(x, z)],
        [0.15, (x, z) => this.tryContainerStack(x, z)],
      ],
      farm: [
        [0.3, (x, z) => this.tryBarn(x, z)], [0.22, (x, z) => this.trySilo(x, z)],
        [0.28, (x, z) => this.tryHouse(x, z, rng() < 0.4 ? 2 : 1)], [0.2, (x, z) => this.tryField(x, z)],
      ],
      ...themed,
    };
    const table = tables[poi.flavor];
    const target = poi.size === 'town' ? randInt(rng, 13, 17) : randInt(rng, 6, 9);

    // Town square
    if (poi.size === 'town') this.plaza(poi.x, poi.z, poi.y, 16);

    let placed = 0;
    for (let attempt = 0; attempt < 200 && placed < target; attempt++) {
      const a = rng() * Math.PI * 2, d = 12 + Math.sqrt(rng()) * (reach - 12);
      const x = poi.x + Math.cos(a) * d, z = poi.z + Math.sin(a) * d;
      let r = rng() * table.reduce((s, m) => s + m[0], 0);
      const maker = table.find((m) => (r -= m[0]) <= 0) ?? table[0];
      if (maker[1](x, z)) placed++;
    }
    // Loose cover crates
    for (let i = 0; i < (poi.size === 'town' ? 14 : 7); i++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * poi.radius;
      const x = poi.x + Math.cos(a) * d, z = poi.z + Math.sin(a) * d;
      const s = rand(rng, 1.1, 1.6);
      const rect = { x0: x - s / 2, z0: z - s / 2, x1: x + s / 2, z1: z + s / 2 };
      if (this.overlapsOccupied(rect, 1.5) || this.nearRoad(x, z, 5)) continue;
      const y = this.terrain.heightAt(x, z);
      this.addProp('crate', rect.x0, y - 0.2, rect.z0, rect.x1, y + s, rect.z1, poi.flavor === 'farm' ? 0xd9b95a : 0xb5874f);
      this.occupied.push(rect);
      if (rng() < 0.5) this.lootSpots.push(new Vector3(x + s, y, z));
    }
  }

  /** Builds a town's centrepiece as near the middle as it fits, off the roads that lead into town. */
  private centrepiece(poi: POI, fn: (x: number, z: number) => boolean) {
    const was = this.inCity;
    this.inCity = true;
    const spots: [number, number][] = [[0, 0]];
    for (const d of [10, 18, 26]) for (let k = 0; k < 8; k++) spots.push([Math.cos((k * Math.PI) / 4) * d, Math.sin((k * Math.PI) / 4) * d]);
    for (const [dx, dz] of spots) {
      const x = poi.x + dx, z = poi.z + dz;
      if (!this.nearRoad(x, z, 7) && fn(x, z)) break;
    }
    this.inCity = was;
  }

  private inBounds(r: Rect) {
    return r.x0 > -this.half + 14 && r.x1 < this.half - 14 && r.z0 > -this.half + 14 && r.z1 < this.half - 14;
  }

  private overlapsOccupied(r: Rect, margin: number) {
    for (const o of this.occupied) {
      if (r.x0 - margin < o.x1 && r.x1 + margin > o.x0 && r.z0 - margin < o.z1 && r.z1 + margin > o.z0) return true;
    }
    return false;
  }

  private nearRoad(x: number, z: number, dist: number) {
    for (const r of this.roads.length && this.rails.length ? [...this.roads, ...this.rails] : this.rails.length ? this.rails : this.roads) {
      const dx = r.x1 - r.x0, dz = r.z1 - r.z0;
      const t = Math.max(0, Math.min(1, ((x - r.x0) * dx + (z - r.z0) * dz) / (dx * dx + dz * dz)));
      if (Math.hypot(r.x0 + dx * t - x, r.z0 + dz * t - z) < dist) return true;
    }
    return false;
  }

  /** Reserves a footprint (w along X, d along Z) and levels the ground. Inside cities the grid handles spacing. */
  private claim(x: number, z: number, w: number, d: number, margin: number): Lot | null {
    const rect = { x0: x - w / 2, z0: z - d / 2, x1: x + w / 2, z1: z + d / 2 };
    const m = this.inCity ? 0.6 : margin;
    if (!this.inBounds(rect) || this.overlapsOccupied(rect, m)) return null;
    if (!this.inCity && this.nearRoad(x, z, Math.max(w, d) / 2 + 5)) return null;
    const y = this.prepareGround(rect);
    if (y === null) return null;
    this.occupied.push(rect);
    this.lastLot = { ...rect, y };
    return this.lastLot;
  }

  addSolid(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, color: number, collide = true) {
    const s = { minX, minY, minZ, maxX, maxY, maxZ, color };
    this.solids.push(s);
    if (collide) this.world.add(s);
  }

  /** Flat ground marking (streets, lots, fields). Rendered with polygon offset so it never flickers. */
  private addDecal(x0: number, z0: number, x1: number, z1: number, y: number, color: number, lift = 0.03) {
    this.decals.push({ minX: x0, minY: y - 0.5, minZ: z0, maxX: x1, maxY: y + lift, maxZ: z1, color });
  }

  private addTree(x: number, z: number, r: number, kind?: number) {
    const y = this.terrain.heightAt(x, z), q = this.rng();
    const mix = THEME === 'western' ? [0.04, 0.04, 0.08, 0.08, 0.08, 0.3, 1] : THEME === 'military' ? [0.45, 0.75, 0.85, 0.9, 0.9, 1] : THEME === 'park' ? [0.2, 0.3, 0.6, 0.7, 0.8, 1] : [0.3, 0.48, 0.73, 0.86, 0.95, 1];
    const k = kind ?? mix.findIndex((m) => q < m);
    this.trees.push({ x, y, z, r, k });
    // Trunk: the solid part (cover, blocks bullets). Canopies are visual only.
    const [w, h, col] = ([[0.3, 3.2, 0x6b4a2f], [0.3, 3.6, 0x5a3d26], [0.4, 3.0, 0x6e4b30], [0.2, 4.4, 0xe4dfd4], [0.38, 3.0, 0x5e4130], [0.26, 5.2, 0x7a6a5a], [0.38, 3.6, 0x4f7a3a]] as const)[k];
    this.addSolid(x - w, y - 0.5, z - w, x + w, y + h, z + w, col);
    if (k === 6) {
      // Cactus arms: out and up.
      for (const [s, ay] of [[1, 1.4 + this.rng() * 0.6], [-1, 2.0 + this.rng() * 0.6]] as const) {
        const alongX = this.rng() < 0.5, o = w + 0.7;
        if (alongX) {
          this.addSolid(x + (s > 0 ? w : -o), y + ay, z - 0.22, x + (s > 0 ? o : -w), y + ay + 0.44, z + 0.22, col, false);
          this.addSolid(x + s * o - 0.24, y + ay, z - 0.24, x + s * o + 0.24, y + ay + 1.5, z + 0.24, col, false);
        } else {
          this.addSolid(x - 0.22, y + ay, z + (s > 0 ? w : -o), x + 0.22, y + ay + 0.44, z + (s > 0 ? o : -w), col, false);
          this.addSolid(x - 0.24, y + ay, z + s * o - 0.24, x + 0.24, y + ay + 1.5, z + s * o + 0.24, col, false);
        }
      }
    } else if (k === 3) {
      // Birch bark: dark flecks up the white trunk.
      for (let i = 0; i < 4; i++) {
        const fy = y + 0.5 + i * 0.95 + this.rng() * 0.3, side = this.rng() < 0.5 ? -1 : 1;
        this.addSolid(x + side * w - 0.02, fy, z - 0.08, x + side * w + 0.02, fy + 0.12, z + 0.08, 0x3b3833, false);
      }
    } else if (k === 5) {
      // Bare branches sticking out at different heights.
      for (let i = 0; i < 4; i++) {
        const by = y + 2.2 + i * 0.75, len = 0.9 + this.rng() * 1.1, t = 0.09;
        if (i % 2 === 0) this.addSolid(x + (i % 4 === 0 ? w : -w - len), by, z - t, x + (i % 4 === 0 ? w + len : -w), by + t * 2, z + t, 0x6a5a4a, false);
        else this.addSolid(x - t, by, z + (i % 4 === 1 ? w : -w - len), x + t, by + t * 2, z + (i % 4 === 1 ? w + len : -w), 0x6a5a4a, false);
      }
    }
  }

  /**
   * Cover out in the open, built as little places rather than loose blocks: garden sheds, dug
   * trenches with sandbag lips, stone sheep pens, sandbag outposts under a tarp and woodsheds.
   */
  private placeFieldCover() {
    const rng = this.rng;
    const kinds = ['hut', 'hut', 'trench', 'trench', 'pen', 'outpost', 'woodshed'] as const;
    let placed = 0;
    for (let i = 0; i < 1400 && placed < 95; i++) {
      const x = rand(rng, -465, 465), z = rand(rng, -465, 465);
      if (this.terrain.heightAt(x, z) < 2) continue;
      if (this.poiAt(x, z) || this.pois.some((p) => Math.hypot(p.x - x, p.z - z) < p.radius + 14)) continue;
      const kind = pick(rng, kinds);
      const ok = kind === 'hut' ? this.coverHut(x, z) : kind === 'trench' ? this.coverTrench(x, z)
        : kind === 'pen' ? this.coverPen(x, z) : kind === 'outpost' ? this.coverOutpost(x, z) : this.coverWoodshed(x, z);
      if (ok) placed++;
    }
  }

  /**
   * A builder for a small site at (x, z), randomly turned and mirrored, plus `at(lx, ly, lz)` for
   * world positions of local points.
   */
  private site(x: number, z: number, base: number) {
    const rng = this.rng, swap = rng() < 0.5, fx = rng() < 0.5 ? -1 : 1, fz = rng() < 0.5 ? -1 : 1;
    const inner = this.builder(x, z, swap, base);
    const box = ((x0, y0, z0, x1, y1, z1, color, collide) => inner(fx * x0, y0, fz * z0, fx * x1, y1, fz * z1, color, collide)) as Builder;
    box.door = (x0, y0, z0, x1, y1, z1) => inner.door(fx * x0, y0, fz * z0, fx * x1, y1, fz * z1);
    box.glass = (x0, y0, z0, x1, y1, z1) => inner.glass(fx * x0, y0, fz * z0, fx * x1, y1, fz * z1);
    box.prop = (k, x0, y0, z0, x1, y1, z1, color) => inner.prop(k, fx * x0, y0, fz * z0, fx * x1, y1, fz * z1, color);
    const at = (lx: number, ly: number, lz: number) => this.local(x, z, swap, base, fx * lx, ly, fz * lz);
    return { box, at, swap, fx, fz };
  }

  /** Garden shed / hunter's hut: one room, a door, two windows and a pitched roof. */
  private coverHut(x: number, z: number) {
    const rng = this.rng, w = rand(rng, 4.2, 5.4), d = rand(rng, 3.6, 4.4);
    const lot = this.claim(x, z, w + 3, d + 3, 3);
    if (!lot) return false;
    const { box, at } = this.site(x, z, lot.y);
    const wall = pick(rng, [0x9c7a54, 0x8a6a48, 0xb8a58a, 0x7d8a6a, 0xa05a48]), roof = pick(rng, [0x5a3d2e, 0x3f4a55, 0x6b2f2a]);
    const hw = w / 2, hd = d / 2, h = 2.5, t = 0.18;
    box(-hw - 0.1, -0.6, -hd - 0.1, hw + 0.1, 0.12, hd + 0.1, 0x7a6e60); // floor
    this.wall(box, true, -hw, hw, hd - t / 2, 0.12, h, t, [{ a: -0.55, b: 0.55, bottom: 0, top: 2.1 }], wall);
    this.wall(box, true, -hw, hw, -hd + t / 2, 0.12, h, t, [{ a: -0.6, b: 0.6, bottom: 1.0, top: 1.8, open: rng() < 0.5 }], wall);
    this.wall(box, false, -hd + t, hd - t, -hw + t / 2, 0.12, h, t, [{ a: -0.5, b: 0.5, bottom: 1.0, top: 1.8, open: rng() < 0.5 }], wall);
    this.wall(box, false, -hd + t, hd - t, hw - t / 2, 0.12, h, t, [], wall);
    // Pitched roof in steps, ridge along X, with overhangs.
    const y0 = 0.12 + h;
    for (let s = 0; s < 4; s++) box(-hw - 0.35, y0 + s * 0.28, -hd - 0.4 + s * (hd / 4 + 0.08), hw + 0.35, y0 + (s + 1) * 0.28, hd + 0.4 - s * (hd / 4 + 0.08), roof);
    // Porch clutter: a crate or a rain barrel by the door.
    if (rng() < 0.6) box.prop('crate', hw - 1.2, 0.12, hd + 0.35, hw - 0.3, 1.0, hd + 1.2, 0x9a7a4a);
    else box(hw - 1.0, 0, hd + 0.35, hw - 0.3, 1.0, hd + 1.05, 0x5a4a3a);
    this.lootSpots.push(at(0, 0.17, -0.3));
    this.footprints.push({ ...lot, color: '#8a7a66' });
    return true;
  }

  /**
   * A dug trench (a ditch you can crouch in) with sandbags along both lips, timber posts and a
   * roofed dugout section. The terrain itself is lowered along one row of grid points.
   */
  private coverTrench(x: number, z: number) {
    const rng = this.rng, T = this.terrain;
    const along = rng() < 0.5, cells = randInt(rng, 4, 6), L = cells * T.cell;
    const lot = this.claim(x, z, along ? L + 8 : 11, along ? 11 : L + 8, 4);
    if (!lot || lot.y < 2.6) return false;
    // Snap the trench line onto a row of grid points so it can be dug.
    const snap = (v: number) => T.coord(Math.round((v + T.extent / 2) / T.cell));
    const cx = snap(x), cz = snap(z), depth = 1.75;
    const s0 = -(cells / 2) * T.cell, s1 = (cells / 2) * T.cell;
    this.forVerts(along ? cx + s0 : cx - 0.1, along ? cz - 0.1 : cz + s0, along ? cx + s1 : cx + 0.1, along ? cz + 0.1 : cz + s1, (i, vx, vz) => {
      const s = along ? vx - cx : vz - cz;
      if ((along ? Math.abs(vz - cz) : Math.abs(vx - cx)) > 0.5 || s < s0 - 0.1 || s > s1 + 0.1) return;
      // Full depth in the middle, ramps at both ends to walk in.
      const end = Math.min(s - s0, s1 - s) < 0.5;
      T.heights[i] = lot.y - (end ? 0.6 : depth);
    });
    // Local frame: u along the trench, v across. (Built straight, not through site(): it must stay on the grid.)
    const seg = (u0: number, u1: number, v0: number, v1: number, y0: number, y1: number, color: number) => along
      ? this.addSolid(cx + u0, lot.y + y0, cz + v0, cx + u1, lot.y + y1, cz + v1, color)
      : this.addSolid(cx + v0, lot.y + y0, cz + u0, cx + v1, lot.y + y1, cz + u1, color);
    const bag = 0xb3a274, bag2 = 0xa39264, wood = 0x6b4a2f;
    for (const side of [-1, 1]) {
      // Sandbag lip with a couple of firing gaps.
      const gaps = [rand(rng, s0 + 3, -1), rand(rng, 1, s1 - 3)];
      let u = s0 + 0.6;
      for (const g of gaps) {
        if (g - 0.5 > u) seg(u, g - 0.5, side * 2.35 - 0.45, side * 2.35 + 0.45, -1.0, 0.55, side < 0 ? bag : bag2);
        u = g + 0.5;
      }
      if (s1 - 0.6 > u) seg(u, s1 - 0.6, side * 2.35 - 0.45, side * 2.35 + 0.45, -1.0, 0.55, side < 0 ? bag : bag2);
      seg(s0 + 1, s1 - 1, side * 2.35 - 0.35, side * 2.35 + 0.35, 0.55, 0.8, bag); // top row
      // Revetment posts down the trench wall.
      for (let p = s0 + 2; p < s1 - 1; p += 3) seg(p - 0.1, p + 0.1, side * 1.5 - 0.1, side * 1.5 + 0.1, -1.4, 0.2, wood);
    }
    // Dugout: planks roofing over a stretch of the trench.
    const r0 = rand(rng, s0 + 3, s1 - 7);
    seg(r0, r0 + 3.5, -2.2, 2.2, 0.45, 0.6, 0x7a5a3a);
    seg(r0, r0 + 3.5, -2.0, 2.0, 0.6, 0.85, bag2);
    for (const e of [r0, r0 + 3.4]) for (const side of [-1, 1]) seg(e, e + 0.15, side * 1.1 - 0.08, side * 1.1 + 0.08, -1.6, 0.45, wood);
    this.lootSpots.push(along ? new Vector3(cx + r0 + 1.7, lot.y - depth + 0.05, cz) : new Vector3(cx, lot.y - depth + 0.05, cz + r0 + 1.7));
    this.footprints.push({ ...lot, color: '#8a7a55' });
    return true;
  }

  /** A dry-stone sheep pen: waist-high walls with a gate gap, hay bales and a trough inside. */
  private coverPen(x: number, z: number) {
    const rng = this.rng, w = rand(rng, 9, 12), d = rand(rng, 7, 9);
    const lot = this.claim(x, z, w + 2, d + 2, 3);
    if (!lot) return false;
    const { box, at } = this.site(x, z, lot.y);
    const stone = pick(rng, [0x8d877c, 0x9a938a, 0x837d72]), hw = w / 2, hd = d / 2, h = 1.15;
    const wall = (x0: number, z0: number, x1: number, z1: number) => {
      box(x0, -0.4, z0, x1, h, z1, stone);
      box(x0 + (x1 - x0 > 1 ? 0.1 : -0.05), h, z0 + (z1 - z0 > 1 ? 0.1 : -0.05), x1 - (x1 - x0 > 1 ? 0.1 : -0.05), h + 0.14, z1 - (z1 - z0 > 1 ? 0.1 : -0.05), 0x77716a);
    };
    wall(-hw, -hd, hw, -hd + 0.6);
    wall(-hw, -hd, -hw + 0.6, hd);
    wall(hw - 0.6, -hd, hw, hd);
    const gate = rand(rng, -hw + 2.5, hw - 2.5);
    wall(-hw, hd - 0.6, gate - 1.4, hd);
    wall(gate + 1.4, hd - 0.6, hw, hd);
    box.prop('fence', gate - 1.4, 0, hd - 0.35, gate + 1.4, 1.05, hd - 0.25, 0x8a6a48); // the gate
    const hay = [0xd8bd68, 0xcfb25a, 0xe0c878];
    box(-hw + 0.8, 0, -hd + 0.8, -hw + 2.3, 1.0, -hd + 1.9, pick(rng, hay));
    box(-hw + 2.4, 0, -hd + 0.8, -hw + 3.9, 1.0, -hd + 1.9, pick(rng, hay));
    box(-hw + 1.4, 1.0, -hd + 0.8, -hw + 2.9, 1.9, -hd + 1.9, pick(rng, hay));
    box(hw - 3.2, 0, 0, hw - 1.0, 0.6, 0.7, 0x6b5a48); // trough
    this.lootSpots.push(at(1, 0.05, -0.5));
    this.footprints.push({ ...lot, color: '#8d877c' });
    return true;
  }

  /** A sandbag outpost: a horseshoe of bags with firing slots, crates and a tarp on posts. */
  private coverOutpost(x: number, z: number) {
    const rng = this.rng;
    const lot = this.claim(x, z, 9, 9, 3);
    if (!lot) return false;
    const { box, at } = this.site(x, z, lot.y);
    const bag = 0xb3a274, bag2 = 0xa39264, tarp = pick(rng, [0x4f5a3a, 0x5a5040, 0x3f5048]);
    // Horseshoe, open at +z, with slots in the front.
    box(-3, -0.3, -3, -1.0, 1.1, -2.2, bag);
    box(-0.4, -0.3, -3, 0.4, 1.1, -2.2, bag2);
    box(1.0, -0.3, -3, 3, 1.1, -2.2, bag);
    box(-3.4, 0.55, -3, 3.4, 1.35, -2.2, bag2); // over the slots
    box(-3, -0.3, -2.2, -2.2, 1.35, 2, bag);
    box(2.2, -0.3, -2.2, 3, 1.35, 2, bag2);
    // Tarp on four posts.
    for (const [px, pz] of [[-2.1, -2.1], [2.1, -2.1], [-2.1, 1.9], [2.1, 1.9]]) box(px - 0.08, 0, pz - 0.08, px + 0.08, 2.5, pz + 0.08, 0x5a4030);
    box(-2.5, 2.5, -2.5, 2.5, 2.6, 2.3, tarp);
    box.prop('crate', -1.6, 0, 0.4, -0.6, 1.0, 1.4, 0x7a6a3a);
    box.prop('crate', 0.8, 0, 0.6, 1.8, 0.8, 1.4, 0x6f7a4a);
    this.lootSpots.push(at(0, 0.05, -0.8));
    this.footprints.push({ ...lot, color: '#8a8360' });
    return true;
  }

  /** A lean-to woodshed with stacked firewood, and a chopping block with a log pile outside. */
  private coverWoodshed(x: number, z: number) {
    const rng = this.rng;
    const lot = this.claim(x, z, 8, 6.5, 3);
    if (!lot) return false;
    const { box, at } = this.site(x, z, lot.y);
    const wood = 0x6b4a2f, plank = 0x8a6a48, roof = pick(rng, [0x4a3a30, 0x3f4a55]);
    box(-3, -0.4, -2, 3, 2.6, -1.8, plank); // back wall
    box(-3, -0.4, -1.8, -2.8, 2.4, 1, plank); // side walls
    box(2.8, -0.4, -1.8, 3, 2.4, 1, plank);
    for (const px of [-2.9, 2.9]) box(px - 0.1, 0, 0.9, px + 0.1, 2.1, 1.1, wood);
    box(-3.3, 2.1, -2.2, 3.3, 2.3, 1.4, roof);
    box(-3.3, 2.3, -2.2, 3.3, 2.5, -0.4, roof);
    // Firewood stacked against the back wall (chest high), leaving a gap in the middle.
    const logs = [0x7a5638, 0x6e4b30, 0x85603f];
    box(-2.7, 0, -1.75, -0.6, 1.3, -0.9, pick(rng, logs));
    box(0.6, 0, -1.75, 2.7, 1.3, -0.9, pick(rng, logs));
    // Outside: log pile and a chopping block.
    box(-2.4, 0, 2.0, 0.6, 0.45, 2.9, 0x6e4b30);
    box(-2.1, 0.45, 2.1, 0.2, 0.85, 2.8, 0x7a5638);
    box(1.6, 0, 2.1, 2.2, 0.55, 2.7, 0x8a6a48);
    this.lootSpots.push(at(0, 0.05, -1.1));
    this.footprints.push({ ...lot, color: '#7a6a55' });
    return true;
  }

  /**
   * Builder in building-local coordinates, offset to the floor height `base`. When `swap` is set the
   * building is mirrored across the diagonal (local x -> world z) for the other axis-aligned orientation.
   */
  private builder(cx: number, cz: number, swap: boolean, base: number): Builder {
    const world = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): Box => {
      const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by), z0 = Math.min(az, bz), z1 = Math.max(az, bz);
      return swap
        ? { minX: cx + z0, minY: base + y0, minZ: cz + x0, maxX: cx + z1, maxY: base + y1, maxZ: cz + x1 }
        : { minX: cx + x0, minY: base + y0, minZ: cz + z0, maxX: cx + x1, maxY: base + y1, maxZ: cz + z1 };
    };
    const fn = ((x0, y0, z0, x1, y1, z1, color, collide = true) => {
      const b = world(x0, y0, z0, x1, y1, z1);
      this.addSolid(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, color, collide);
    }) as Builder;
    fn.door = (x0, y0, z0, x1, y1, z1) => {
      const b = world(x0, y0, z0, x1, y1, z1);
      this.doors.push({ ...b, alongX: b.maxX - b.minX > b.maxZ - b.minZ });
    };
    fn.glass = (x0, y0, z0, x1, y1, z1) => this.glass.push(world(x0, y0, z0, x1, y1, z1));
    fn.prop = (kind, x0, y0, z0, x1, y1, z1, color) => {
      const b = world(x0, y0, z0, x1, y1, z1);
      this.addProp(kind, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, color);
    };
    return fn;
  }

  /** Breakable crates and fences (rendered and collided by the Destructibles system, not as map solids). */
  private addProp(kind: 'crate' | 'fence', minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, color: number) {
    this.props.push({ kind, minX, minY, minZ, maxX, maxY, maxZ, color });
  }

  private local(cx: number, cz: number, swap: boolean, base: number, lx: number, ly: number, lz: number) {
    return swap ? new Vector3(cx + lz, base + ly, cz + lx) : new Vector3(cx + lx, base + ly, cz + lz);
  }

  /** Wall running along local X (at z = c) or local Z (at x = c), with door/window openings. */
  private wall(box: Builder, alongX: boolean, s0: number, s1: number, c: number, y0: number, h: number, t: number, openings: Opening[], color: number) {
    const piece = (a: number, b: number, ya: number, yb: number) => {
      if (b - a < 0.01 || yb - ya < 0.01) return;
      if (alongX) box(a, ya, c - t / 2, b, yb, c + t / 2, color);
      else box(c - t / 2, ya, a, c + t / 2, yb, b, color);
    };
    const pane = (fn: RectFn, a: number, b: number, ya: number, yb: number, th: number) => {
      if (alongX) fn(a, ya, c - th / 2, b, yb, c + th / 2);
      else fn(c - th / 2, ya, a, c + th / 2, yb, b);
    };
    let cur = s0;
    for (const o of [...openings].sort((p, q) => p.a - q.a)) {
      piece(cur, o.a, y0, y0 + h);
      piece(o.a, o.b, y0, y0 + o.bottom);
      piece(o.a, o.b, y0 + o.top, y0 + h);
      // Person-sized doorways get a door; raised openings get a pane of glass.
      if (o.bottom === 0 && o.b - o.a <= 1.8 && o.top <= 2.7 && !o.open) pane(box.door, o.a + 0.02, o.b - 0.02, y0 + 0.02, y0 + o.top - 0.02, 0.1);
      else if (o.bottom > 0.3 && !o.open) pane(box.glass, o.a, o.b, y0 + o.bottom, y0 + o.top, 0.06);
      cur = o.b;
    }
    piece(cur, s1, y0, y0 + h);
  }

  private windowsFor(s0: number, s1: number, count: number): Opening[] {
    const out: Opening[] = [];
    const len = s1 - s0;
    for (let i = 0; i < count; i++) {
      const c = s0 + (len * (i + 1)) / (count + 1);
      out.push({ a: c - 0.7, b: c + 0.7, bottom: 1.0, top: 2.2 });
    }
    return out;
  }

  // ---------- buildings ----------

  /**
   * Houses and apartment blocks. Multi-storey buildings get switchback stairs: flights alternate
   * between two columns so every floor is reachable and there's always headroom.
   */
  private tryHouse(x: number, z: number, floors: number, fit = 99, colorOverride?: number, noSwap = false): boolean {
    const rng = this.rng;
    const big = floors >= 3;
    const w = Math.min(fit, big ? rand(rng, 12.5, 16) : rand(rng, 9, 13)), d = Math.min(fit, big ? rand(rng, 10, 13) : rand(rng, 9, 12));
    const swap = noSwap ? false : rng() < 0.5;
    const lot = this.claim(x, z, swap ? d : w, swap ? w : d, 5);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const wallColor = colorOverride ?? (big ? pick(rng, APARTMENT_COLORS) : pick(rng, WALL_COLORS));
    const roofColor = big ? 0x5a5f66 : pick(rng, ROOF_COLORS);
    const t = 0.3, H = 3.4;
    const hw = w / 2, hd = d / 2;
    const stairW = 1.7, run = 0.45, rise = 0.34, nSteps = 10, L = nSteps * run;
    const zs = -hd + 1.4;
    const ax0 = -hw + t / 2, ax1 = ax0 + stairW, bx0 = ax1, bx1 = bx0 + stairW;
    const stairsEnd = floors > 2 ? bx1 : floors > 1 ? ax1 : -hw;
    const winCount = big ? 3 : 2;

    box(-hw, 0, -hd, hw, 0.1, hd, big ? 0x9a9186 : 0xb08a5e); // floor
    for (let f = 0; f < floors; f++) {
      const y0 = f * H;
      const doorC = rand(rng, Math.max(-hw + 2.5, stairsEnd + 1.3), hw - 2.2);
      const frontOpen: Opening[] = f === 0
        ? [{ a: doorC - 0.8, b: doorC + 0.8, bottom: 0, top: 2.5 }]
        : this.windowsFor(-hw, hw, winCount);
      this.wall(box, true, -hw, hw, -hd, y0, H, t, frontOpen, wallColor);
      const backOpen: Opening[] = f === 0 && rng() < 0.6
        ? [{ a: -0.8, b: 0.8, bottom: 0, top: 2.5 }]
        : this.windowsFor(-hw, hw, winCount);
      this.wall(box, true, -hw, hw, hd, y0, H, t, backOpen, wallColor);
      this.wall(box, false, -hd + t / 2, hd - t / 2, -hw, y0, H, t, floors > 1 ? this.windowsFor(zs + L + 0.4, hd, 1) : this.windowsFor(-hd, hd, 2), wallColor);
      this.wall(box, false, -hd + t / 2, hd - t / 2, hw, y0, H, t, this.windowsFor(-hd, hd, winCount), wallColor);
      if (f > 0) {
        // Floor slab with a hole above the flight that arrives here.
        const [h0, h1] = (f - 1) % 2 === 0 ? [ax0, ax1] : [bx0, bx1 + 0.3];
        const hz0 = zs - 0.2, hz1 = zs + L + 0.3, sc = big ? 0x8f877c : 0xa07c52;
        box(-hw, y0 - 0.25, -hd, h0, y0, hd, sc);
        box(h1, y0 - 0.25, -hd, hw, y0, hd, sc);
        box(h0, y0 - 0.25, -hd, h1, y0, hz0, sc);
        box(h0, y0 - 0.25, hz1, h1, y0, hd, sc);
      }
      if (f < floors - 1) {
        for (let i = 0; i < nSteps; i++) {
          if (f % 2 === 0) box(ax0, y0, zs + i * run, ax1, y0 + (i + 1) * rise, zs + (i + 1) * run, 0x8a6a48);
          else box(bx0, y0, zs + L - (i + 1) * run, bx1, y0 + (i + 1) * rise, zs + L - i * run, 0x8a6a48);
        }
      }
      for (let i = 0; i < 2; i++) {
        this.lootSpots.push(this.local(x, z, swap, lot.y, rand(rng, stairsEnd + 0.8, hw - 1), y0 + 0.12, rand(rng, -hd + 1, hd - 1)));
      }
    }
    if (floors === 1 && rng() < 0.5) {
      // Interior divider with a doorway
      this.wall(box, false, -hd + t, hd - t, rand(rng, -hw * 0.3, hw * 0.3), 0, H, 0.2, [{ a: -0.7, b: 0.7, bottom: 0, top: 2.3 }], 0xece6dc);
    }
    const top = floors * H;
    box(-hw - 0.4, top, -hd - 0.4, hw + 0.4, top + 0.3, hd + 0.4, roofColor);
    if (floors >= 3) {
      const s = rng() < 0.5 ? -1 : 1, p = this.local(x, z, swap, lot.y, s * hw, 0, 0);
      this.climbSpots.push({ x: p.x, z: p.z, top: lot.y + top + 0.3, ox: swap ? 0 : s, oz: swap ? s : 0 });
    }
    if (big) {
      // Rooftop clutter: AC units and a water tank
      box(hw * 0.2, top + 0.3, -hd * 0.5, hw * 0.2 + 2, top + 1.3, -hd * 0.5 + 1.4, 0xb0b4b8);
      box(-hw * 0.5, top + 0.3, hd * 0.2, -hw * 0.5 + 2.2, top + 2.8, hd * 0.2 + 2.2, 0x7a6a5a);
    } else if (floors === 1 && rng() < 0.5) {
      box(hw - 2, top + 0.3, hd - 2.5, hw - 1.2, top + 1.6, hd - 1.7, 0x8c5a4a); // chimney
    }
    this.footprints.push({ ...lot, color: big ? '#b9aea0' : floors === 2 ? '#c9b48f' : '#d8c7a4' });
    return true;
  }

  private tryTower(x: number, z: number, edge: number): boolean {
    const rng = this.rng;
    const w = rand(rng, 13, 19), d = rand(rng, 13, 19);
    const lot = this.claim(x, z, w, d, 3);
    if (!lot) return false;
    const box = this.builder(x, z, false, lot.y);
    const glass = pick(rng, GLASS_COLORS), frame = pick(rng, [0xd8d8d2, 0x9aa0a6, 0x55595e, 0xe6e0d4]);
    const H = 3.4, floors = randInt(rng, Math.round(6 - edge * 3), Math.round(14 - edge * 6));
    const h = floors * H, hw = w / 2, hd = d / 2;
    const bands = (x0: number, z0: number, x1: number, z1: number, y0: number, y1: number) => {
      for (let y = y0 + H; y < y1 - 0.1; y += H) box(x0 - 0.15, y - 0.4, z0 - 0.15, x1 + 0.15, y, z1 + 0.15, frame, false);
    };
    box(-hw, 0, -hd, hw, h, hd, glass);
    bands(-hw, -hd, hw, hd, 0, h);
    box(-hw - 0.25, h, -hd - 0.25, hw + 0.25, h + 0.5, hd + 0.25, frame);
    let top = h + 0.5;
    if (rng() < 0.55) {
      const w2 = w * rand(rng, 0.5, 0.7), d2 = d * rand(rng, 0.5, 0.7), h2 = randInt(rng, 2, 6) * H;
      box(-w2 / 2, top, -d2 / 2, w2 / 2, top + h2, d2 / 2, glass);
      bands(-w2 / 2, -d2 / 2, w2 / 2, d2 / 2, top, top + h2);
      box(-w2 / 2 - 0.2, top + h2, -d2 / 2 - 0.2, w2 / 2 + 0.2, top + h2 + 0.4, d2 / 2 + 0.2, frame);
      top += h2 + 0.4;
    }
    box(-0.2, top, -0.2, 0.2, top + rand(rng, 4, 10), 0.2, 0xdddddd, false); // antenna
    if (h > 24) this.towerTops.push(new Vector3(x + hw * 0.5, lot.y + h + 0.5, z + hd * 0.5));
    const cs = rng() < 0.5 ? -1 : 1;
    this.climbSpots.push({ x: x + cs * hw, z, top: lot.y + h + 0.5, ox: cs, oz: 0 });
    // Entrance canopy + planters as street-level cover
    const side = rng() < 0.5 ? -1 : 1;
    box(-3.5, 3.0, side < 0 ? -hd - 2.8 : hd, 3.5, 3.3, side < 0 ? -hd : hd + 2.8, frame);
    for (const px of [-5.5, 5.5]) box(px - 0.8, 0, side * (hd + 1.2) - 0.8, px + 0.8, 0.9, side * (hd + 1.2) + 0.8, 0x7a7f86);
    this.lootSpots.push(this.local(x, z, false, lot.y, 0, 0.12, side * (hd + 1.6)));
    this.footprints.push({ ...lot, color: '#7f93a8' });
    return true;
  }

  private tryShop(x: number, z: number, front = -1): boolean {
    const rng = this.rng;
    const w = rand(rng, 10, 15), d = this.inCity ? rand(rng, 8, 9.5) : rand(rng, 8, 10.5);
    const swap = this.inCity ? false : rng() < 0.5;
    const lot = this.claim(x, z, swap ? d : w, swap ? w : d, 4);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const color = pick(rng, WALL_COLORS), sign = pick(rng, SIGN_COLORS);
    const t = 0.3, H = 3.9, hw = w / 2, hd = d / 2;
    const fz = front * hd, bz = -front * hd;
    box(-hw, 0, -hd, hw, 0.1, hd, 0x9c8f7c);
    this.wall(box, true, -hw, hw, fz, 0, H, t, [
      { a: -hw + 0.8, b: -1.3, bottom: 0.7, top: 2.9 },
      { a: -0.9, b: 0.9, bottom: 0, top: 2.6 },
      { a: 1.3, b: hw - 0.8, bottom: 0.7, top: 2.9 },
    ], color);
    this.wall(box, true, -hw, hw, bz, 0, H, t, [{ a: hw - 2.4, b: hw - 1.2, bottom: 0, top: 2.4 }], color);
    this.wall(box, false, -hd + t / 2, hd - t / 2, -hw, 0, H, t, [], color);
    this.wall(box, false, -hd + t / 2, hd - t / 2, hw, 0, H, t, this.windowsFor(-hd, hd, 1), color);
    box(-hw - 0.3, H, -hd - 0.3, hw + 0.3, H + 0.3, hd + 0.3, 0x5a5f66);
    const az0 = front < 0 ? fz - 1.8 : fz, az1 = front < 0 ? fz : fz + 1.8;
    if (THEME === 'western') {
      box(-hw, H + 0.3, fz - 0.15, hw, H + 2.6, fz + 0.15, color); // false front
      box(-hw * 0.6, H + 1.0, fz - front * 0.2, hw * 0.6, H + 2.0, fz + front * 0.05, sign, false);
      box(-hw, 0, az0, hw, 0.25, az1, 0x7a5a3a); // boardwalk
      box(-hw - 0.2, 3.0, az0, hw + 0.2, 3.2, az1, 0x5a3d2a); // porch roof
      for (const px of [-hw + 0.2, 0, hw - 0.2]) {
        if (px !== 0) box(px - 0.12, 0.25, front < 0 ? az0 : az1 - 0.24, px + 0.12, 3.0, front < 0 ? az0 + 0.24 : az1, 0x6b4a2f);
      }
    } else {
      box(-hw * 0.75, H + 0.3, fz - 0.15, hw * 0.75, H + 1.4, fz + 0.15, sign); // sign board
      box(-hw + 0.2, 3.0, az0, hw - 0.2, 3.2, az1, sign, false); // awning
    }
    box(-hw + 1, 0, bz - front * 2.6, hw - 3.2, 1.0, bz - front * 1.9, 0x7a5a3a); // counter
    box(-hw + 0.4, 0, -1.2, -hw + 1, 2, 1.2, 0x6f6a64); // shelf
    this.lootSpots.push(this.local(x, z, swap, lot.y, rand(rng, -hw + 2, hw - 2), 0.12, 0));
    if (rng() < 0.6) this.lootSpots.push(this.local(x, z, swap, lot.y, rand(rng, -hw + 2, hw - 2), 0.12, fz - front * 1.2));
    this.footprints.push({ ...lot, color: '#d9b98f' });
    return true;
  }

  private tryGasStation(x: number, z: number): boolean {
    const rng = this.rng;
    const swap = rng() < 0.5;
    const lot = this.claim(x, z, swap ? 16 : 18, swap ? 18 : 16, 4);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const accent = pick(rng, [0xd9382c, 0x2f6fd1, 0x2fa36b, 0xf0a030]);
    box(-9, -0.3, -8, 9, 0.05, 8, CONCRETE);
    // Canopy on four pillars
    for (const [px, pz] of [[-6, -6], [6, -6], [-6, 0], [6, 0]]) box(px - 0.25, 0, pz - 0.25, px + 0.25, 4.4, pz + 0.25, 0xe0e0e0);
    box(-7.5, 4.4, -7.2, 7.5, 5.0, 1.2, 0xf2f2f2);
    box(-7.6, 4.5, -7.3, 7.6, 4.8, 1.3, accent, false);
    for (const px of [-2.6, 2.6]) box(px - 0.45, 0, -3.4, px + 0.45, 1.6, -2.6, accent);
    // Kiosk
    const t = 0.25, hw = 5, z0 = 3, z1 = 7.6;
    this.wall(box, true, -hw, hw, z0, 0, 3.4, t, [{ a: -0.8, b: 0.8, bottom: 0, top: 2.5 }, { a: 1.5, b: 4, bottom: 0.8, top: 2.6 }], 0xf4f1ea);
    this.wall(box, true, -hw, hw, z1, 0, 3.4, t, [], 0xf4f1ea);
    this.wall(box, false, z0 + t / 2, z1 - t / 2, -hw, 0, 3.4, t, [], 0xf4f1ea);
    this.wall(box, false, z0 + t / 2, z1 - t / 2, hw, 0, 3.4, t, this.windowsFor(z0, z1, 1), 0xf4f1ea);
    box(-hw - 0.2, 3.4, z0 - 0.2, hw + 0.2, 3.7, z1 + 0.2, accent);
    box(-hw + 0.6, 0, z1 - 1.2, -hw + 3.5, 1.0, z1 - 0.6, 0x7a5a3a);
    this.lootSpots.push(this.local(x, z, swap, lot.y, 1, 0.15, 5.3));
    this.barrelSpots.push(this.local(x, z, swap, lot.y, 7.6, 0, 4), this.local(x, z, swap, lot.y, 7.8, 0, 6.2));
    const vs = this.local(x, z, swap, lot.y, 0, 0, -3);
    this.vehicleSpots.push({ x: vs.x, y: vs.y, z: vs.z, yaw: swap ? Math.PI / 2 : 0 });
    this.lootSpots.push(this.local(x, z, swap, lot.y, 0, 0.15, -3));
    this.footprints.push({ ...lot, color: '#c4c4bc' });
    return true;
  }

  private tryWarehouse(x: number, z: number, colorOverride?: number): boolean {
    const rng = this.rng;
    const w = this.inCity ? rand(rng, 20, 24) : rand(rng, 22, 30), d = this.inCity ? rand(rng, 14, 18) : rand(rng, 14, 19);
    const swap = rng() < 0.5;
    const lot = this.claim(x, z, swap ? d : w, swap ? w : d, 6);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const color = colorOverride ?? pick(rng, WAREHOUSE_COLORS);
    const t = 0.4, H = 7, hw = w / 2, hd = d / 2;
    const bigDoor = (c: number): Opening => ({ a: c - 2.2, b: c + 2.2, bottom: 0, top: 5 });
    const hiWin = (s0: number, s1: number) => this.windowsFor(s0, s1, 3).map((o) => ({ ...o, bottom: 4.6, top: 6.1 }));
    box(-hw, 0, -hd, hw, 0.1, hd, 0x6d6f73);
    this.wall(box, true, -hw, hw, -hd, 0, H, t, [bigDoor(rand(rng, -hw + 4, hw - 4))], color);
    this.wall(box, true, -hw, hw, hd, 0, H, t, [bigDoor(rand(rng, -hw + 4, hw - 4))], color);
    this.wall(box, false, -hd + t / 2, hd - t / 2, -hw, 0, H, t, [{ a: -1, b: 1, bottom: 0, top: 2.5 }, ...hiWin(-hd, -2).slice(0, 1)], color);
    this.wall(box, false, -hd + t / 2, hd - t / 2, hw, 0, H, t, hiWin(-hd, hd), color);
    box(-hw - 0.3, H, -hd - 0.3, hw + 0.3, H + 0.35, hd + 0.3, 0x55606b);
    // Catwalk along the back wall with a ladder-stair up to it
    if (rng() < 0.5) {
      box(-hw + t / 2, 3.2, hd - 2.2, hw - t / 2, 3.45, hd - t / 2, 0x6b7078);
      // Ten steps, the highest right against the catwalk edge and level with its top.
      for (let i = 0; i < 10; i++) box(hw - 2.4, 0, hd - 2.2 - (i + 1) * 0.5, hw - t / 2, 3.45 - i * 0.345, hd - 2.2 - i * 0.5, 0x6b7078);
      this.lootSpots.push(this.local(x, z, swap, lot.y, -hw + 3, 3.5, hd - 1.2));
    }
    // Crate stacks inside for cover
    for (let i = 0; i < randInt(rng, 3, 6); i++) {
      const cx = rand(rng, -hw + 3, hw - 3), cz = rand(rng, -hd + 3, hd - 4);
      const s = 1.5, stack = rng() < 0.4 ? 2 : 1;
      for (let k = 0; k < stack; k++) box.prop('crate', cx - s, k * s, cz - s / 2, cx + s, (k + 1) * s, cz + s / 2, 0xb5874f);
    }
    for (let i = 0; i < 3; i++) this.lootSpots.push(this.local(x, z, swap, lot.y, rand(rng, -hw + 2, hw - 2), 0.12, rand(rng, -hd + 2, hd - 3)));
    if (!this.inCity || rng() < 0.5) for (let i = 0; i < randInt(rng, 1, 3); i++) this.barrelSpots.push(this.local(x, z, swap, lot.y, hw + 1.2, 0, rand(rng, -hd + 1, hd - 1)));
    this.footprints.push({ ...lot, color: '#a3acb5' });
    return true;
  }

  private tryBarn(x: number, z: number): boolean {
    const rng = this.rng;
    const w = rand(rng, 14, 18), d = rand(rng, 10, 13);
    const swap = rng() < 0.5;
    const lot = this.claim(x, z, swap ? d : w, swap ? w : d, 5);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const red = pick(rng, [0xa8322a, 0x8f2d24, 0x9a6b3f]);
    const t = 0.3, H = 4.6, hw = w / 2, hd = d / 2;
    box(-hw, 0, -hd, hw, 0.1, hd, 0x8a7458);
    const door: Opening = { a: -2, b: 2, bottom: 0, top: 3.8 };
    this.wall(box, false, -hd + t / 2, hd - t / 2, -hw, 0, H, t, [door], red);
    this.wall(box, false, -hd + t / 2, hd - t / 2, hw, 0, H, t, [door], red);
    const hi = this.windowsFor(-hw, hw, 3).map((o) => ({ ...o, bottom: 2.4, top: 3.4 }));
    this.wall(box, true, -hw, hw, -hd, 0, H, t, hi, red);
    this.wall(box, true, -hw, hw, hd, 0, H, t, hi, red);
    // Stepped gable roof
    const roof = 0x5a3d33;
    for (let k = 0; k < 4; k++) {
      const inset = k * (hd / 4.5);
      box(-hw - 0.3, H + k * 0.7, -hd - 0.4 + inset, hw + 0.3, H + (k + 1) * 0.7, hd + 0.4 - inset, roof);
    }
    for (let i = 0; i < randInt(rng, 2, 4); i++) {
      const bx = rand(rng, -hw + 2, hw - 2), bz = rand(rng, -hd + 1.5, hd - 1.5);
      box.prop('crate', bx - 0.7, 0, bz - 0.5, bx + 0.7, 1.0, bz + 0.5, 0xd9b95a);
    }
    for (let i = 0; i < 2; i++) this.lootSpots.push(this.local(x, z, swap, lot.y, rand(rng, -hw + 2, hw - 2), 0.12, rand(rng, -hd + 1.5, hd - 1.5)));
    this.footprints.push({ ...lot, color: '#b0544a' });
    return true;
  }

  private trySilo(x: number, z: number): boolean {
    const rng = this.rng;
    const n = randInt(rng, 1, 3), s = rand(rng, 3.2, 4.2), gap = 1;
    const w = n * s + (n - 1) * gap;
    const lot = this.claim(x, z, w, s, 3);
    if (!lot) return false;
    const box = this.builder(x, z, false, lot.y);
    const H = rand(rng, 9, 14);
    for (let i = 0; i < n; i++) {
      const x0 = -w / 2 + i * (s + gap);
      box(x0, 0, -s / 2, x0 + s, H, s / 2, 0xc9ccd1);
      box(x0 - 0.2, H, -s / 2 - 0.2, x0 + s + 0.2, H + 0.5, s / 2 + 0.2, 0x8a9099);
      box(x0 + s * 0.3, H + 0.5, -s * 0.2, x0 + s * 0.7, H + 1.3, s * 0.2, 0x8a9099);
    }
    this.lootSpots.push(this.local(x, z, false, lot.y, 0, 0, s / 2 + 1.3));
    this.footprints.push({ ...lot, color: '#b8bcc2' });
    return true;
  }

  private tryChimney(x: number, z: number): boolean {
    const lot = this.claim(x, z, 5, 5, 3);
    if (!lot) return false;
    const box = this.builder(x, z, false, lot.y);
    box(-2.5, 0, -2.5, 2.5, 3, 2.5, 0x8a6a5a);
    box(-1.3, 3, -1.3, 1.3, 26, 1.3, 0xa35f4a);
    box(-1.5, 22, -1.5, 1.5, 23, 1.5, 0xf2f2f2, false);
    this.lootSpots.push(this.local(x, z, false, lot.y, 3.4, 0, 0));
    this.footprints.push({ ...lot, color: '#8a6a5a' });
    return true;
  }

  private tryCrane(x: number, z: number): boolean {
    const rng = this.rng;
    const swap = rng() < 0.5;
    const lot = this.claim(x, z, swap ? 8 : 10, swap ? 10 : 8, 4);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const c = pick(rng, [0xf0a030, 0xd9382c, 0x2f6fd1]);
    for (const [lx, lz] of [[-4, -3], [4, -3], [-4, 3], [4, 3]]) box(lx - 0.5, 0, lz - 0.5, lx + 0.5, 18, lz + 0.5, c);
    box(-4.5, 18, -3.5, 4.5, 19.5, 3.5, c);
    box(-1, 19.5, -18, 1, 21, 14, c); // boom
    box(-2, 19.5, 8, 2, 23, 12, 0x55606b); // cab/counterweight
    this.lootSpots.push(this.local(x, z, swap, lot.y, 0, 0.12, 0));
    this.footprints.push({ ...lot, color: '#d99a3a' });
    return true;
  }

  private tryRadioTower(x: number, z: number): boolean {
    const rng = this.rng;
    const lot = this.claim(x, z, 12, 10, 4);
    if (!lot) return false;
    const box = this.builder(x, z, false, lot.y);
    const H = rand(rng, 22, 34);
    for (const [lx, lz] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]]) box(lx - 0.15, 0, lz - 0.15, lx + 0.15, H, lz + 0.15, 0xd9382c);
    for (let y = 4; y < H; y += 4) box(-1.35, y, -1.35, 1.35, y + 0.2, 1.35, 0xf2f2f2, false);
    box(-0.1, H, -0.1, 0.1, H + 6, 0.1, 0xdddddd, false);
    // Equipment hut
    const t = 0.25;
    this.wall(box, true, 2.5, 6, -2, 0, 3, t, [{ a: 3.6, b: 4.9, bottom: 0, top: 2.4 }], 0xe8e8e2);
    this.wall(box, true, 2.5, 6, 2, 0, 3, t, [], 0xe8e8e2);
    this.wall(box, false, -2 + t / 2, 2 - t / 2, 2.5, 0, 3, t, [], 0xe8e8e2);
    this.wall(box, false, -2 + t / 2, 2 - t / 2, 6, 0, 3, t, this.windowsFor(-2, 2, 1), 0xe8e8e2);
    box(2.3, 3, -2.2, 6.2, 3.3, 2.2, 0x5a5f66);
    box(-5, 0, -1.5, -3, 2.2, 1.5, 0xb0b4b8); // satellite dish base
    box(-5.6, 2.2, -2.4, -3.2, 4.8, 2.4, 0xf2f2f2);
    this.lootSpots.push(this.local(x, z, false, lot.y, 4.2, 0.12, 0));
    this.footprints.push({ ...lot, color: '#c9c9c3' });
    return true;
  }

  private tryContainerStack(x: number, z: number): boolean {
    const rng = this.rng;
    const swap = rng() < 0.5;
    const n = randInt(rng, 1, 3);
    const w = 6.1, d = 2.5 * n + 0.5 * (n - 1);
    const lot = this.claim(x, z, swap ? d : w, swap ? w : d, 3);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    for (let i = 0; i < n; i++) {
      const z0 = -d / 2 + i * 3;
      const h = 2.6;
      box(-w / 2, 0, z0, w / 2, h, z0 + 2.5, pick(rng, CONTAINER_COLORS));
      if (rng() < 0.3) box(-w / 2 + 0.3, h, z0, w / 2 - 0.3, h * 2, z0 + 2.5, pick(rng, CONTAINER_COLORS));
    }
    this.lootSpots.push(this.local(x, z, swap, lot.y, w / 2 + 1.2, 0, 0));
    if (rng() < 0.4) this.barrelSpots.push(this.local(x, z, swap, lot.y, -w / 2 - 1, 0, rand(rng, -d / 2, d / 2)));
    this.footprints.push({ ...lot, color: '#b8746a' });
    return true;
  }

  private tryRuins(x: number, z: number): boolean {
    const rng = this.rng;
    const w = rand(rng, 7, 11), d = rand(rng, 7, 11);
    const lot = this.claim(x, z, w, d, 4);
    if (!lot) return false;
    const box = this.builder(x, z, false, lot.y);
    const color = 0xbdb6a8;
    const hw = w / 2, hd = d / 2, t = 0.5;
    box(-hw, 0, -hd, -hw + t, rand(rng, 1.2, 3.5), hd * rand(rng, 0.2, 1), color);
    box(-hw, 0, -hd, hw * rand(rng, -0.2, 1), rand(rng, 1.0, 3.0), -hd + t, color);
    if (rng() < 0.7) box(hw - t, 0, -hd * rand(rng, -1, 0.3), hw, rand(rng, 1.0, 2.6), hd, color);
    box(-hw, 0, -hd, hw, 0.12, hd, 0x9c9588);
    this.lootSpots.push(new Vector3(x, lot.y + 0.15, z));
    this.footprints.push({ ...lot, color: '#aaa393' });
    return true;
  }

  /** Crop field with a fence around it. */
  private tryField(x: number, z: number): boolean {
    const rng = this.rng;
    const w = rand(rng, 16, 26), d = rand(rng, 12, 20);
    const lot = this.claim(x, z, w, d, 4);
    if (!lot) return false;
    const crop = pick(rng, [0x9c7a3c, 0xc9b24a, 0x6f9a3a]);
    this.addDecal(lot.x0 + 0.5, lot.z0 + 0.5, lot.x1 - 0.5, lot.z1 - 0.5, lot.y, 0x6b5233, 0.03);
    for (let zz = lot.z0 + 1; zz < lot.z1 - 1.2; zz += 1.6) this.addDecal(lot.x0 + 1, zz, lot.x1 - 1, zz + 0.8, lot.y, crop, 0.18);
    const box = this.builder(x, z, false, lot.y);
    const hw = w / 2, hd = d / 2, fc = 0x8a6a48;
    const gate = rand(rng, -hw + 3, hw - 3);
    this.fence(box, true, -hw, gate - 1.5, -hd, fc);
    this.fence(box, true, gate + 1.5, hw, -hd, fc);
    this.fence(box, true, -hw, hw, hd, fc);
    this.fence(box, false, -hd, hd, -hw, fc);
    this.fence(box, false, -hd, hd, hw, fc);
    if (rng() < 0.6) {
      const bx = rand(rng, -hw + 2, hw - 2), bz = rand(rng, -hd + 2, hd - 2);
      box.prop('crate', bx - 0.7, 0, bz - 0.5, bx + 0.7, 1.0, bz + 0.5, 0xd9b95a);
      this.lootSpots.push(this.local(x, z, false, lot.y, bx + 1.3, 0.05, bz));
    }
    this.footprints.push({ ...lot, color: '#b39a5a' });
    return true;
  }

  // ---------- special locations ----------

  /** Fence panels (about 3 m each) that break when shot, blown up or driven through. */
  private fence(box: Builder, alongX: boolean, s0: number, s1: number, c: number, color: number) {
    for (let a = s0; a < s1 - 0.2; a += 3) {
      const b = Math.min(s1, a + 3);
      if (alongX) box.prop('fence', a, 0, c - 0.07, b, 1.05, c + 0.07, color);
      else box.prop('fence', c - 0.07, 0, a, c + 0.07, 1.05, b, color);
    }
  }

  /** A flight of stairs along local Z starting at (x0..x1, zStart), climbing `rise` while moving in `dir` (±1). */
  private stairs(box: Builder, x0: number, x1: number, zStart: number, dir: number, y0: number, rise: number, color: number) {
    const n = Math.ceil(rise / 0.35), step = rise / n, run = 0.45;
    for (let i = 0; i < n; i++) {
      const za = zStart + dir * i * run, zb = zStart + dir * (i + 1) * run;
      box(x0, y0, Math.min(za, zb), x1, y0 + (i + 1) * step, Math.max(za, zb), color);
    }
  }

  private buildMilitary(poi: POI) {
    const rng = this.rng;
    this.inCity = true;
    const R = Math.round(poi.radius * 0.82), X = poi.x, Z = poi.z;
    const box = this.builder(X, Z, false, poi.y);
    const wallC = THEME === 'park' ? 0x8a6a48 : THEME === 'western' ? 0x7a5a3a : 0x8f8f86, gate: Opening[] = [{ a: -4.5, b: 4.5, bottom: 0, top: 3, open: true }];
    this.wall(box, true, -R, R, -R, 0, 2.6, 0.5, gate, wallC);
    this.wall(box, true, -R, R, R, 0, 2.6, 0.5, gate, wallC);
    this.wall(box, false, -R, R, -R, 0, 2.6, 0.5, [], wallC);
    this.wall(box, false, -R, R, R, 0, 2.6, 0.5, gate, wallC);
    for (const [x0, z0, x1, z1] of [[-R, -R, R, -R], [-R, R, R, R], [-R, -R, -R, R], [R, -R, R, R]]) {
      this.occupied.push({ x0: X + x0 - 0.8, z0: Z + z0 - 0.8, x1: X + x1 + 0.8, z1: Z + z1 + 0.8 });
    }
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) this.tryWatchtower(X + sx * (R - 5), Z + sz * (R - 7));
    const olive = THEME === 'park' ? 0xb08a5e : THEME === 'western' ? 0xa8845a : 0x6b7a5a;
    if (THEME === 'military') {
      for (const [bx, bz] of [[-0.5, -0.3], [-0.5, 0.2], [0.05, -0.55]]) if (!this.tryBarracks(X + bx * R, Z + bz * R)) this.tryHouse(X + bx * R, Z + bz * R, 1, 12, olive);
      if (!this.tryMotorShed(X + R * 0.45, Z + R * 0.42)) this.tryWarehouse(X + R * 0.45, Z + R * 0.42, 0x5f6b55);
      this.gateBooth(X + 6.5, Z - R + 3, poi.y, true);
      this.gateBooth(X + 6.5, Z + R - 3, poi.y, true);
      this.gateBooth(X + R - 3, Z + 6.5, poi.y, false);
    } else {
      for (const [bx, bz] of [[-0.5, -0.3], [-0.5, 0.2], [0.05, -0.55]]) this.tryHouse(X + bx * R, Z + bz * R, 1, 12, olive);
      this.tryWarehouse(X + R * 0.45, Z + R * 0.42, 0x5f6b55);
    }
    this.tryHouse(X + R * 0.05, Z + R * 0.05, 2, 11, 0x7a806a); // HQ

    // Bunker: low concrete box with firing slits
    const bx = X + R * 0.5, bz = Z - R * 0.4;
    const bk = this.builder(bx, bz, false, poi.y);
    const slits = (s0: number, s1: number) => this.windowsFor(s0, s1, 3).map((o) => ({ ...o, bottom: 1.3, top: 1.7, open: true }));
    this.wall(bk, true, -4, 4, -3, 0, 2.4, 0.5, slits(-4, 4), 0x9a978e);
    this.wall(bk, true, -4, 4, 3, 0, 2.4, 0.5, [{ a: -0.8, b: 0.8, bottom: 0, top: 2.2 }], 0x9a978e);
    this.wall(bk, false, -2.75, 2.75, -4, 0, 2.4, 0.5, slits(-3, 3).slice(0, 1), 0x9a978e);
    this.wall(bk, false, -2.75, 2.75, 4, 0, 2.4, 0.5, slits(-3, 3).slice(0, 1), 0x9a978e);
    bk(-4.3, 2.4, -3.3, 4.3, 2.9, 3.3, 0x86837b);
    this.occupied.push({ x0: bx - 5, z0: bz - 4, x1: bx + 5, z1: bz + 4 });
    this.lootSpots.push(new Vector3(bx, poi.y + 0.12, bz), new Vector3(bx + 2, poi.y + 0.12, bz - 1));

    // Helipad
    const hx = X - R * 0.1, hz = Z + R * 0.55;
    this.addDecal(hx - 7, hz - 7, hx + 7, hz + 7, poi.y, 0x3f4247, 0.05);
    this.addDecal(hx - 2.2, hz - 3, hx - 1.4, hz + 3, poi.y, 0xf2d43a, 0.09);
    this.addDecal(hx + 1.4, hz - 3, hx + 2.2, hz + 3, poi.y, 0xf2d43a, 0.09);
    this.addDecal(hx - 1.4, hz - 0.4, hx + 1.4, hz + 0.4, poi.y, 0xf2d43a, 0.09);
    this.occupied.push({ x0: hx - 7, z0: hz - 7, x1: hx + 7, z1: hz + 7 });
    this.lootSpots.push(new Vector3(hx + 4, poi.y + 0.1, hz + 4));

    // Sandbag walls and crate stacks for cover
    for (let i = 0; i < 16; i++) {
      const x = X + rand(rng, -R + 4, R - 4), z = Z + rand(rng, -R + 4, R - 4);
      const alongX = rng() < 0.5, L = rand(rng, 2.5, 4.5);
      const rect = alongX ? { x0: x - L / 2, z0: z - 0.4, x1: x + L / 2, z1: z + 0.4 } : { x0: x - 0.4, z0: z - L / 2, x1: x + 0.4, z1: z + L / 2 };
      if (this.overlapsOccupied(rect, 1.2)) continue;
      this.occupied.push(rect);
      if (rng() < 0.55) this.addSolid(rect.x0, poi.y - 0.2, rect.z0, rect.x1, poi.y + 0.95, rect.z1, 0xb3a37a);
      else {
        const c = pick(rng, [0x6b7a5a, 0x7d6a48, 0x5f6b55]);
        this.addProp('crate', rect.x0, poi.y, rect.z0, rect.x1, poi.y + 1.2, rect.z1, c);
        if (rng() < 0.4) this.addProp('crate', rect.x0 + 0.2, poi.y + 1.2, rect.z0 + 0.1, rect.x1 - 0.2, poi.y + 2.3, rect.z1 - 0.1, c);
      }
      if (rng() < 0.5) this.lootSpots.push(new Vector3(x + (alongX ? 0 : 1.2), poi.y + 0.1, z + (alongX ? 1.2 : 0)));
    }
    for (let i = 0; i < 4; i++) this.barrelSpots.push(new Vector3(X + rand(rng, -R + 3, R - 3), poi.y, Z + rand(rng, -R + 3, R - 3)));
    for (const [vx, vz] of [[0, -R - 8], [0, R + 8], [R + 8, 0]]) this.addVehicleSpot(X + vx, Z + vz, rng() * 6);
    this.inCity = false;
  }

  private buildCastle(poi: POI) {
    const rng = this.rng;
    this.inCity = true;
    const S = 19, H = 7, T2 = 2.2, X = poi.x, Z = poi.z;
    const W = THEME === 'western';
    const stone = THEME === 'park' ? 0xecc8d8 : W ? 0xd8b890 : 0x9d998e, dark = THEME === 'park' ? 0xd0a0bc : W ? 0xc09a70 : 0x7d796f;
    this.tryHouse(X + 3, Z + 3, 3, 12, THEME === 'park' ? 0xf0dce6 : W ? 0xe8d0b0 : 0xa8a397); // the keep
    const box = this.builder(X, Z, false, poi.y);
    this.wall(box, true, -S, S, S, 0, H, T2, [{ a: -2.2, b: 2.2, bottom: 0, top: 4.4, open: true }], stone);
    this.wall(box, true, -S, S, -S, 0, H, T2, [], stone);
    this.wall(box, false, -S + T2 / 2, S - T2 / 2, -S, 0, H, T2, [], stone);
    this.wall(box, false, -S + T2 / 2, S - T2 / 2, S, 0, H, T2, [], stone);
    // Battlements on the outer edge of the wall walk
    const o = S + T2 / 2;
    for (let k = -S + 3; k < S - 3; k += 2) {
      box(k, H, -o, k + 1, H + 1, -o + 0.5, dark);
      box(k, H, o - 0.5, k + 1, H + 1, o, dark);
      box(-o, H, k, -o + 0.5, H + 1, k + 1, dark);
      box(o - 0.5, H, k, o, H + 1, k + 1, dark);
    }
    // Corner towers: platforms level with the wall walk, parapets and a pointed roof on posts
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = sx * S, cz = sz * S;
      box(cx - 3, 0, cz - 3, cx + 3, H, cz + 3, stone);
      box(cx - 3, H, cz + sz * 2.6, cx + 3, H + 1.2, cz + sz * 3, dark);
      box(cx + sx * 2.6, H, cz - 3, cx + sx * 3, H + 1.2, cz + 3, dark);
      for (const [px, pz] of [[-2.7, -2.7], [2.7, -2.7], [-2.7, 2.7], [2.7, 2.7]]) box(cx + px - 0.15, H, cz + pz - 0.15, cx + px + 0.15, H + 3, cz + pz + 0.15, 0x5a4a3a, false);
      for (let k = 0; k < 4; k++) box(cx - 3.3 + k * 0.8, H + 3 + k * 0.6, cz - 3.3 + k * 0.8, cx + 3.3 - k * 0.8, H + 3.6 + k * 0.6, cz + 3.3 - k * 0.8, THEME === 'park' ? 0x7a4ab0 : THEME === 'western' ? 0xa85a3a : 0x7a3b2e, false);
      this.lootSpots.push(this.local(X, Z, false, poi.y, cx - sx * 1.2, H + 0.05, cz - sz * 1.2));
    }
    // Stairs up to the wall walk along the inside of the east and west walls
    for (const sx of [-1, 1]) {
      const x0 = sx < 0 ? -S + T2 / 2 : S - T2 / 2 - 1.6, x1 = x0 + 1.6;
      this.stairs(box, x0, x1, 8, -1, 0, H, dark);
    }
    // Courtyard: well, market stalls, crates
    box(-9.5, 0, 9, -7.5, 0.9, 11, stone);
    for (let i = 0; i < 3; i++) {
      const sx = -12 + i * 5, sz = 14;
      for (const [px, pz] of [[-1.5, -1], [1.5, -1], [-1.5, 1], [1.5, 1]]) box(sx + px - 0.1, 0, sz + pz - 0.1, sx + px + 0.1, 2.4, sz + pz + 0.1, 0x6b4a2f, false);
      box(sx - 1.8, 2.4, sz - 1.3, sx + 1.8, 2.6, sz + 1.3, pick(rng, [0xc0392b, 0x2e86c1, 0xd4ac0d]), false);
      box.prop('crate', sx - 1, 0, sz - 0.5, sx + 1, 0.9, sz + 0.5, 0x9a7446);
      this.lootSpots.push(this.local(X, Z, false, poi.y, sx, 0.95, sz));
    }
    for (let i = 0; i < 5; i++) {
      const cx = rand(rng, -14, 14), cz = rand(rng, -14, -8);
      box.prop('crate', cx - 0.7, 0, cz - 0.7, cx + 0.7, 1.4, cz + 0.7, 0xa47a4a);
    }
    this.lootSpots.push(this.local(X, Z, false, poi.y, -10, 0.1, -12), this.local(X, Z, false, poi.y, 12, 0.1, -12), this.local(X, Z, false, poi.y, 0, H + 0.05, -S));
    this.occupied.push({ x0: X - S - 3, z0: Z - S - 3, x1: X + S + 3, z1: Z + S + 3 });
    this.inCity = false;
  }

  private buildAirport(poi: POI) {
    const rng = this.rng;
    this.inCity = true;
    const y = poi.y, X = poi.x, Z = poi.z, rz = Z - 38, RL = THEME === 'military' ? 150 : 82;
    if (RL > 82) {
      // The long runway runs past the edge of the plateau: level the ground under it.
      const T = this.terrain;
      this.forVerts(X - RL - 30, rz - 40, X + RL + 30, rz + 40, (i, vx, vz) => {
        const d = Math.hypot(Math.max(Math.abs(vx - X) - RL - 2, 0), Math.max(Math.abs(vz - rz) - 13, 0));
        if (d === 0) {
          T.heights[i] = y;
          this.locked[i] = 1;
        } else if (d < 26 && !this.locked[i]) T.heights[i] = lerp(y, T.heights[i], smoothstep(0, 1, d / 26));
      });
    }
    // Runway with centre dashes and threshold stripes
    this.addDecal(X - RL, rz - 11, X + RL, rz + 11, y, 0x3f4247, 0.05);
    for (let x = X - RL + 10; x < X + RL - 10; x += 10) this.addDecal(x, rz - 0.3, x + 5, rz + 0.3, y, 0xf2f2f2, 0.09);
    for (const s of [-1, 1]) for (let k = -8.8; k <= 8.8; k += 2.2) this.addDecal(X + s * (RL - 5) - 2.5, rz + k - 0.5, X + s * (RL - 5) + 2.5, rz + k + 0.5, y, 0xf2f2f2, 0.09);
    this.occupied.push({ x0: X - RL, z0: rz - 11, x1: X + RL, z1: rz + 11 });
    // Apron and taxiway
    this.addDecal(X - 70, Z - 22, X + 45, Z + 16, y, 0x8e8c86, 0.04);
    this.addDecal(X + 30, rz + 11, X + 42, Z - 22, y, 0x8e8c86, 0.04);
    this.cargoPlane(X - 25, Z - 5, y);
    if (THEME === 'military') {
      this.tryHangar(X - 45, Z + 36, 'jet');
      this.tryHangar(X - 12, Z + 36, 'heli');
      for (const jx of [12, 30]) {
        const jb = this.builder(X + jx, Z - 8, false, y);
        this.jet(jb, 0, 0);
        this.occupied.push({ x0: X + jx - 7, z0: Z - 16, x1: X + jx + 7, z1: Z });
      }
      const hb = this.builder(X - 62, Z - 10, false, y);
      this.addDecal(X - 69, Z - 17, X - 55, Z - 3, y, 0x3f4247, 0.06);
      this.heli(hb, 0, 0);
      this.occupied.push({ x0: X - 69, z0: Z - 17, x1: X - 55, z1: Z - 3 });
    } else {
      this.tryWarehouse(X - 45, Z + 36);
      this.tryWarehouse(X - 8, Z + 36);
    }
    if (this.tryHouse(X + 30, Z + 34, 4, 9, 0xe6e9ec) && this.lastLot) {
      // Control-tower cab
      const l = this.lastLot, cx = (l.x0 + l.x1) / 2, cz = (l.z0 + l.z1) / 2, hw = (l.x1 - l.x0) / 2, hd = (l.z1 - l.z0) / 2;
      const cab = this.builder(cx, cz, false, l.y + 4 * 3.4 + 0.3);
      cab(-hw + 0.5, 0, -hd + 0.5, hw - 0.5, 0.9, hd - 0.5, 0xd8dcdf);
      cab(-hw + 0.6, 0.9, -hd + 0.6, hw - 0.6, 2.6, hd - 0.6, 0x6fa8c9);
      cab(-hw + 0.2, 2.6, -hd + 0.2, hw - 0.2, 3.0, hd - 0.2, 0xd8dcdf);
      cab(-0.1, 3.0, -0.1, 0.1, 6.5, 0.1, 0xdddddd, false);
    }
    this.trySilo(X + 62, Z + 32);
    this.tryShop(X + 60, Z + 4);
    for (let i = 0; i < 6; i++) {
      const cx = X + rand(rng, -60, 40), cz = Z + rand(rng, -18, 12);
      if (this.overlapsOccupied({ x0: cx - 1, z0: cz - 1, x1: cx + 1, z1: cz + 1 }, 1)) continue;
      this.addProp('crate', cx - 0.8, y, cz - 0.6, cx + 0.8, y + 1.1, cz + 0.6, 0x9a7446);
      this.occupied.push({ x0: cx - 0.8, z0: cz - 0.6, x1: cx + 0.8, z1: cz + 0.6 });
      this.lootSpots.push(new Vector3(cx + 1.4, y + 0.1, cz));
    }
    for (const [vx, vz] of [[-62, 8], [20, 6], [34, -12]]) this.addVehicleSpot(X + vx, Z + vz, rng() * 6);
    for (let i = 0; i < 3; i++) this.barrelSpots.push(new Vector3(X + 58 + i * 1.1, y, Z + 22));
    this.rangeSpot.set(X + 40, y, rz);
    this.inCity = false;
  }

  /** A parked cargo plane with an open rear ramp you can walk into. */
  private cargoPlane(x: number, z: number, y: number) {
    const box = this.builder(x, z, false, y);
    const white = 0xe9ecef, grey = 0xaab1b8, red = 0xd04a3a;
    const ports = this.windowsFor(-14, 8, 5).map((o) => ({ ...o, bottom: 1.5, top: 2.2 }));
    box(-14, 0, -2.4, 10, 0.4, 2.4, grey);
    this.wall(box, true, -14, 10, -2.4, 0.4, 3.6, 0.2, ports, white);
    this.wall(box, true, -14, 10, 2.4, 0.4, 3.6, 0.2, ports, white);
    box(-14, 4.0, -2.5, 10, 4.3, 2.5, white);
    box(-17, 0.6, -1.8, -14, 3.6, 1.8, white);
    box(-17.3, 2.4, -1.2, -16.9, 3.4, 1.2, 0x2a3440);
    box(10, 0, -2, 14, 0.25, 2, grey);
    box(10, 3.6, -0.3, 16, 9, 0.3, red);
    box(12, 3.9, -5, 16, 4.2, 5, white);
    box(-6, 3.9, -16, 2, 4.2, 16, grey);
    for (const s of [-1, 1]) box(-5, 2.4, s * 9 - 1, -1, 3.8, s * 9 + 1, 0x5b6470);
    for (const [lx, lz] of [[-9, 0], [-2, 0], [5, 0]]) this.lootSpots.push(this.local(x, z, false, y, lx, 0.45, lz));
    this.occupied.push({ x0: x - 18, z0: z - 16, x1: x + 17, z1: z + 16 });
  }

  /** Concrete dam across the first river, with a walkway on the crest. */
  private buildDam() {
    if (!DAM) return;
    const T = this.terrain, { x, z } = DAM;
    const bank = Math.max(T.heightAt(x, z - 28), T.heightAt(x, z + 28));
    const top = Math.max(bank + 2.5, 6);
    const ends: number[] = [];
    for (const s of [-1, 1]) {
      let e = 60;
      for (let d = 12; d <= 60; d++) {
        if (T.heightAt(x, z + s * d) >= top - 0.3) {
          e = d;
          break;
        }
      }
      ends.push(e);
    }
    const z0 = z - ends[0], z1 = z + ends[1], conc = 0xbab6ab;
    this.addSolid(x - 3.5, -3.5, z0, x + 3.5, top, z1, conc);
    this.addSolid(x + 3.5, -3.5, z - 9, x + 9, top - 4, z + 9, 0xaaa69b);
    this.addSolid(x + 9, -3.5, z - 9, x + 14, top - 7.5, z + 9, 0xaaa69b);
    this.addSolid(x - 3.5, top, z0, x - 3.2, top + 1.1, z1, 0x6b7078);
    this.addSolid(x + 3.2, top, z0, x + 3.5, top + 1.1, z + 8.2, 0x6b7078);
    this.addSolid(x + 3.2, top, z + 9.1, x + 3.5, top + 1.1, z1, 0x6b7078);
    this.addSolid(x + 14, -0.6, z - 7, x + 14.4, top - 7.5, z + 7, 0xdff2ff, false); // spillway water
    this.addDecal(x + 14, z - 9, x + 32, z + 9, -0.5, 0xeaf6ff, 0.06); // foam
    // Where the crest doesn't reach the hillside, stairs lead down to the ground.
    const box = this.builder(x, 0, false, 0);
    for (const [s, e] of [[-1, ends[0]], [1, ends[1]]] as const) {
      const g = T.heightAt(x, z + s * (e + 6));
      if (top - g > 0.6) this.stairs(box, -1.5, 1.5, z + s * (e + (top - g) / 0.35 * 0.45), -s, g, top - g, conc);
    }
    // Pump house on the lower terrace, reached from the crest by a short stair
    const ph = this.builder(x + 6.2, z, false, top - 4);
    this.wall(ph, false, -3.2, 3.2, -2.3, 0, 3, 0.25, [], 0xe4e0d6);
    this.wall(ph, false, -3.2, 3.2, 2.3, 0, 3, 0.25, this.windowsFor(-3, 3, 1), 0xe4e0d6);
    this.wall(ph, true, -2.3, 2.3, -3.2, 0, 3, 0.25, this.windowsFor(-2, 2, 1), 0xe4e0d6);
    this.wall(ph, true, -2.3, 2.3, 3.2, 0, 3, 0.25, [{ a: -0.7, b: 0.7, bottom: 0, top: 2.3 }], 0xe4e0d6);
    ph(-2.6, 3, -3.5, 2.6, 3.3, 3.5, 0x3d6b8c);
    const st = this.builder(x, 0, false, 0);
    for (let i = 0; i < 11; i++) st(3.5, top - 4, z + 8.9 - (i + 1) * 0.45, 5.2, top - (i + 1) * 0.36, z + 8.9 - i * 0.45, conc);
    this.lootSpots.push(new Vector3(x, top + 0.1, z - 8), new Vector3(x, top + 0.1, z + 8), new Vector3(x + 6.2, top - 4 + 0.12, z));
    this.landmarks.push({ name: 'Stormfall Dam', x, z });
    this.footprints.push({ x0: x - 3.5, z0: z0, x1: x + 14, z1: z1, color: '#bab6ab' });
    this.occupied.push({ x0: x - 5, z0: z0 - 4, x1: x + 16, z1: z1 + 4 });
  }

  // ---------- railway ----------

  /**
   * The railway: a smooth loop (a spline through RAIL) laid on a smoothed profile of the ground.
   * Dips narrower than ~80 m (both canyon crossings, gullies) are bridged by a wooden trestle.
   * Rails and sleepers follow the curve exactly (one merged mesh); only trestle decks and legs collide.
   */
  private buildRailway() {
    const T = this.terrain;
    const ground = (x: number, z: number) => Math.max(T.heightAt(x, z), 0.8);
    const pts = sampleLoop(RAIL!, 2).map((p) => ({ ...p, h: ground(p.x, p.z) }));
    const N = pts.length, W = 20;
    // Map + minimap outline, and keeping buildings off the line: 10 m pieces.
    for (let i = 0; i < N; i += 5) {
      const a = pts[i], b = pts[(i + 5) % N];
      this.rails.push({ x0: a.x, z0: a.z, x1: b.x, z1: b.z });
    }
    const win = (arr: number[], i: number, r: number, f: (a: number, b: number) => number, init: number) => {
      let m = init;
      for (let j = i - r; j <= i + r; j++) m = f(m, arr[((j % N) + N) % N]);
      return m;
    };
    // Smooth profile: bridge dips, keep out of the ground.
    const hs = pts.map((p) => p.h);
    const dil = hs.map((_, i) => win(hs, i, W, Math.max, -Infinity));
    const clo = dil.map((_, i) => win(dil, i, W, Math.min, Infinity));
    const prof = clo.map((_, i) => Math.max(win(clo, i, 3, (a, b) => a + b, 0) / 7, hs[i]));
    const tie = 0x5a4030, steel = 0x55555c, wood = 0x6b4a2f, gravel = 0x8a7a68, dark = 0x4a3222;
    const geos: BufferGeometry[] = [];
    // A box centred at (x, y, z), `len` along the heading `yaw`, `w` across it.
    const rbox = (x: number, y: number, z: number, len: number, h: number, w: number, yaw: number, c: number) => {
      const g = new BoxGeometry(len, h, w).rotateY(yaw).translate(x, y, z);
      const n = g.getAttribute('position').count, col = new Float32Array(n * 3), cc = tmpC.setHex(c);
      for (let k = 0; k < n; k++) col.set([cc.r, cc.g, cc.b], k * 3);
      g.setAttribute('color', new BufferAttribute(col, 3));
      g.deleteAttribute('uv');
      geos.push(g);
    };
    const bridges: { gap: number; x: number; z: number }[] = [];
    let run = { gap: 0, x: 0, z: 0 }, inRun = false;
    for (let i = 0; i < N; i++) {
      const a = pts[i], b = pts[(i + 1) % N], y = (prof[i] + prof[(i + 1) % N]) / 2;
      this.track.push({ x: a.x, y: prof[i] + 0.3, z: a.z });
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1, ux = dx / len, uz = dz / len;
      const yaw = Math.atan2(-dz, dx), mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const g = T.heightAt(mx, mz), gap = y - g;
      // Rails (a hair longer so the joints close on curves) and a sleeper.
      for (const s of [-0.72, 0.72]) rbox(mx - uz * s, y + 0.21, mz + ux * s, len + 0.08, 0.18, 0.12, yaw, steel);
      rbox(mx, y + 0.05, mz, 0.5, 0.14, 2.5, yaw, tie);
      if (gap > 0.6) {
        // Trestle: a plank deck you can walk along, legs down to the ground every few metres.
        rbox(mx, y - 0.19, mz, len + 0.05, 0.33, 3.0, yaw, wood);
        this.addSolid(mx - 1.1, y - 0.35, mz - 1.1, mx + 1.1, y - 0.02, mz + 1.1, wood, true);
        this.solids.pop(); // drawn by the deck above
        if (i % 3 === 0) {
          for (const s of [-1.3, 1.3]) {
            const px = mx - uz * s, pz = mz + ux * s;
            this.addSolid(px - 0.2, g - 0.5, pz - 0.2, px + 0.2, y - 0.35, pz + 0.2, wood, true);
          }
          for (let hh = g + 3; hh < y - 1; hh += 4) rbox(mx, hh, mz, 0.24, 0.25, 3.0, yaw, dark);
          // Cross-bracing on the tall ones.
          if (gap > 6) for (const s of [-1.3, 1.3]) rbox(mx - uz * s, (g + y) / 2, mz + ux * s, 0.18, gap * 0.9, 0.18, yaw, dark);
        }
        if (!inRun || gap > run.gap) run = { gap, x: mx, z: mz };
        inRun = true;
      } else {
        rbox(mx, (g - 0.4 + y - 0.02) / 2, mz, len + 0.1, Math.max(0.1, y - 0.02 - g + 0.4), 3.4, yaw, gravel);
        if (inRun && run.gap > 3) bridges.push(run);
        inRun = false;
      }
      // Keep the whole width clear: the train is 4.7 m wide and runs through here.
      this.occupied.push({ x0: mx - 4.2, z0: mz - 4.2, x1: mx + 4.2, z1: mz + 4.2 });
    }
    if (inRun && run.gap > 3) bridges.push(run);
    const mesh = new Mesh(mergeGeometries(geos)!, new MeshLambertMaterial({ vertexColors: true }));
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    // Halts: a platform at coach-floor height on one side, a shelter and a sign.
    const railAt = (x: number, z: number) => {
      let bi = 0, bd = Infinity;
      this.track.forEach((q, i) => {
        const d = (q.x - x) ** 2 + (q.z - z) ** 2;
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      return this.track[bi].y;
    };
    for (const h of HALTS) {
      const top = railAt(h.x, h.z) + TRAIN_FLOOR, len = 34, along = h.dx === 0;
      // (u along the track, v away from it) -> world box
      const box = (u0: number, u1: number, v0: number, v1: number, y0: number, y1: number, c: number, collide = true) => {
        const p0 = along ? h.z + h.dz * v0 : h.x + h.dx * v0, p1 = along ? h.z + h.dz * v1 : h.x + h.dx * v1;
        const q0 = Math.min(p0, p1), q1 = Math.max(p0, p1);
        if (along) this.addSolid(h.x + u0, y0, q0, h.x + u1, y1, q1, c, collide);
        else this.addSolid(q0, y0, h.z + u0, q1, y1, h.z + u1, c, collide);
      };
      let lo = Infinity;
      for (let u = -len / 2; u <= len / 2; u += 3) lo = Math.min(lo, along ? T.heightAt(h.x + u, h.z + h.dz * 4.5) : T.heightAt(h.x + h.dx * 4.5, h.z + u));
      box(-len / 2, len / 2, 2.6, 6.4, lo - 0.5, top, 0xb0a080);
      for (let k = 0; k < 4; k++) box(-len / 2 - 0.6 * (k + 1), -len / 2 - 0.6 * k, 2.6, 6.4, lo - 0.5, top - (k + 1) * (top - lo) / 5, 0xb0a080);
      for (const u of [-8, 0, 8]) box(u - 0.12, u + 0.12, 5.8, 6.1, top, top + 3.2, 0x5a3d2a);
      box(-10, 10, 3.4, 6.7, top + 3.2, top + 3.45, 0x6a4a3a);
      box(-2.2, 2.2, 6.0, 6.2, top + 2.0, top + 2.8, 0x2a3a2a, false); // sign
      box(-4, -2, 5.2, 5.8, top, top + 0.5, 0x6b4a2f); // bench
      box(3, 5, 5.2, 5.8, top, top + 0.5, 0x6b4a2f);
      this.lootSpots.push(along ? new Vector3(h.x + 6, top + 0.05, h.z + h.dz * 4.6) : new Vector3(h.x + h.dx * 4.6, top + 0.05, h.z + 6));
      this.occupied.push(along ? { x0: h.x - 22, z0: h.z + Math.min(0, h.dz * 8), x1: h.x + 22, z1: h.z + Math.max(0, h.dz * 8) } : { x0: h.x + Math.min(0, h.dx * 8), z0: h.z - 22, x1: h.x + Math.max(0, h.dx * 8), z1: h.z + 22 });
      this.landmarks.push({ name: h.name, x: h.x + h.dx * 10, z: h.z + h.dz * 10 });
      this.trainStops.push({ x: h.x, z: h.z });
    }
    bridges.sort((a, b) => b.gap - a.gap).slice(0, 2).forEach((b, i) => this.landmarks.push({ name: i ? 'High Trestle' : 'Trestle Bridge', x: b.x, z: b.z }));
    if (CANYON) this.landmarks.push({ name: 'Red Canyon', x: 168, z: -130 });
  }

  // ---------- rivers ----------

  private buildBridges() {
    for (const road of [...this.roads]) {
      const len = Math.hypot(road.x1 - road.x0, road.z1 - road.z0);
      const dx = (road.x1 - road.x0) / len, dz = (road.z1 - road.z0) / len;
      let start = -1;
      for (let d = 0; d <= len; d += 1) {
        const wet = this.gapAt(road.x0 + dx * d, road.z0 + dz * d);
        if (wet && start < 0) start = d;
        if ((!wet || d + 1 > len) && start >= 0) {
          const a = Math.max(0, start - 7), b = Math.min(len, d + 7);
          this.addBridge(road.x0 + dx * a, road.z0 + dz * a, dx, dz, b - a);
          start = -1;
        }
      }
    }
  }

  /** Somewhere a road needs a bridge: a river, the park lake or the canyon. */
  private gapAt(x: number, z: number) {
    const r = this.riverAt(x, z);
    if (r && r.d < r.w * 1.9) return true;
    if (THEME === 'park') return this.terrain.heightAt(x, z) < -0.2;
    if (CANYON) return this.canyonDist(x, z) < CANYON.w + CANYON.wall * 0.55;
    return false;
  }

  private addBridge(x0: number, z0: number, dx: number, dz: number, len: number) {
    const T = this.terrain;
    const hA = Math.max(0.8, T.heightAt(x0, z0)), hB = Math.max(0.8, T.heightAt(x0 + dx * len, z0 + dz * len));
    const br: Bridge = { x: x0, z: z0, dx, dz, len, hA, hB };
    this.bridges.push(br);
    // The deck is rotated, so collision is a carpet of small boxes that follows it closely.
    const nx = -dz, nz = dx, step = 1.1;
    for (let u = 0; u <= len; u += step) {
      const y = this.bridgeY(br, u);
      for (let v = -4.4; v <= 4.45; v += step) {
        const cx = x0 + dx * u + nx * v, cz = z0 + dz * u + nz * v;
        this.world.add({ minX: cx - 0.6, minY: y - 0.6, minZ: cz - 0.6, maxX: cx + 0.6, maxY: y, maxZ: cz + 0.6 });
      }
    }
    this.occupied.push({ x0: Math.min(x0, x0 + dx * len) - 6, z0: Math.min(z0, z0 + dz * len) - 6, x1: Math.max(x0, x0 + dx * len) + 6, z1: Math.max(z0, z0 + dz * len) + 6 });
  }

  private bridgeY(b: Bridge, u: number) {
    return lerp(b.hA, b.hB, u / b.len) + 0.25 + Math.sin((Math.PI * u) / b.len) * 1.2;
  }

  /** Deck height if (x, z) is on a bridge, else -Infinity. */
  private deckAt(x: number, z: number) {
    for (const b of this.bridges) {
      const px = x - b.x, pz = z - b.z;
      const u = px * b.dx + pz * b.dz, v = -px * b.dz + pz * b.dx;
      if (u >= -0.5 && u <= b.len + 0.5 && Math.abs(v) <= 5.2) return this.bridgeY(b, clamp(u, 0, b.len));
    }
    return -Infinity;
  }

  // ---------- ziplines ----------

  private placeZiplines() {
    const rng = this.rng;
    const pole = (x: number, y0: number, z: number, y1: number) => this.addSolid(x - 0.15, y0, z - 0.15, x + 0.15, y1, z + 0.15, 0x3a3f45);
    const tryLine = (a: Vector3, minD: number, maxD: number) => {
      for (let i = 0; i < 200; i++) {
        const ang = rng() * Math.PI * 2, d = rand(rng, minD, maxD);
        const bx = a.x + Math.cos(ang) * d, bz = a.z + Math.sin(ang) * d;
        if (Math.abs(bx) > 465 || Math.abs(bz) > 465) continue;
        const gy = this.terrain.heightAt(bx, bz);
        if (gy < 1.2 || this.overlapsOccupied({ x0: bx - 2, z0: bz - 2, x1: bx + 2, z1: bz + 2 }, 1)) continue;
        const b = new Vector3(bx, gy + 3.2, bz);
        if (a.y - b.y < 8) continue;
        const dir = b.clone().sub(a), len = dir.length();
        dir.divideScalar(len);
        // The cable and the rider hanging 2 m below it both need a clear run.
        if (this.world.raycast(a, dir, len) < len - 0.5) continue;
        // Walk the cable: the rider (2.1 m under it) must stay clear of the ground the whole way.
        let clear = true;
        for (let s = 2; s < len - 3 && clear; s += 1) {
          const px = a.x + dir.x * s, pz = a.z + dir.z * s;
          if (a.y + dir.y * s - 2.4 < this.terrain.heightAt(px, pz)) clear = false;
        }
        if (!clear) continue;
        if (this.world.raycast(a.clone().setY(a.y - 2.1), dir, len) < len - 3) continue;
        this.ziplines.push({ a: a.clone(), b });
        // Keep trees, rocks and later buildings (which reshape the ground) out from under the cable.
        for (let s = 0; s < len; s += 3) {
          const px = a.x + dir.x * s, pz = a.z + dir.z * s;
          this.occupied.push({ x0: px - 1.5, z0: pz - 1.5, x1: px + 1.5, z1: pz + 1.5 });
        }
        pole(bx, gy - 0.3, bz, gy + 3.4);
        this.occupied.push({ x0: bx - 1, z0: bz - 1, x1: bx + 1, z1: bz + 1 });
        return true;
      }
      return false;
    };
    let n = 0;
    for (const t of this.towerTops) {
      if (n >= 20) break;
      const a = t.clone().setY(t.y + 2.6);
      if (tryLine(a, 55, 110)) {
        pole(t.x, t.y, t.z, a.y + 0.2);
        n++;
      }
    }
    for (const m of MOUNTAINS) {
      for (let k = 0; k < 6; k++) {
        const gx = m.x + rand(rng, -14, 14), gz = m.z + rand(rng, -14, 14), gy = this.terrain.heightAt(gx, gz);
        if (this.overlapsOccupied({ x0: gx - 2, z0: gz - 2, x1: gx + 2, z1: gz + 2 }, 1)) continue;
        const a = new Vector3(gx, gy + 3.2, gz);
        if (tryLine(a, 70, 170)) {
          pole(gx, gy - 0.3, gz, gy + 3.4);
          this.occupied.push({ x0: gx - 1, z0: gz - 1, x1: gx + 1, z1: gz + 1 });
          break;
        }
      }
    }
    for (const l of this.lighthouseSpots) tryLine(l.clone().setY(l.y - 1.2), 60, 110);
    // Extra lines down from high ground all over the island.
    let extra = 0;
    for (let i = 0; i < 400 && extra < 14; i++) {
      const gx = rand(rng, -430, 430), gz = rand(rng, -430, 430), gy = this.terrain.heightAt(gx, gz);
      if (gy < 12 || this.poiAt(gx, gz) || this.overlapsOccupied({ x0: gx - 2, z0: gz - 2, x1: gx + 2, z1: gz + 2 }, 1)) continue;
      if (this.ziplines.some((z) => Math.hypot(z.a.x - gx, z.a.z - gz) < 60)) continue;
      const a = new Vector3(gx, gy + 3.2, gz);
      if (tryLine(a, 60, 150)) {
        pole(gx, gy - 0.3, gz, gy + 3.4);
        this.occupied.push({ x0: gx - 1, z0: gz - 1, x1: gx + 1, z1: gz + 1 });
        extra++;
      }
    }
    // Vertical lines straight up the side of tall buildings: ride up and you're shoved onto the roof.
    let up = 0;
    for (const s of this.climbSpots) {
      if (up >= 40) break;
      const cx = s.x + s.ox * 1.3, cz = s.z + s.oz * 1.3, g = this.terrain.heightAt(cx, cz);
      if (s.top - g < 8 || g < 0.5) continue;
      if (this.world.anyOverlap(cx - 0.45, g + 0.2, cz - 0.45, cx + 0.45, s.top + 2.8, cz + 0.45)) continue;
      this.ziplines.push({ a: new Vector3(cx, s.top + 2.65, cz), b: new Vector3(cx, g + 2.3, cz), push: [-s.ox, -s.oz] });
      this.addSolid(cx - 0.15, g - 0.3, cz - 0.15, cx + 0.15, g + 0.15, cz + 0.15, 0x3a3f45, false);
      this.occupied.push({ x0: cx - 1, z0: cz - 1, x1: cx + 1, z1: cz + 1 });
      up++;
    }
  }

  // ---------- gulag ----------

  /** A walled 1v1 arena out at sea, far beyond the fog. */
  private buildGulag() {
    const { x, z } = this.gulags[0], box = this.builder(x, z, false, 0);
    const conc = 0x8d8a82, dark = 0x5c5a55;
    box(-24, -2, -15, 24, 0.1, 15, 0x6f6c66);
    this.wall(box, true, -24, 24, -15, 0, 7, 1, [], conc);
    this.wall(box, true, -24, 24, 15, 0, 7, 1, [], conc);
    this.wall(box, false, -15, 15, -24, 0, 7, 1, [], conc);
    this.wall(box, false, -15, 15, 24, 0, 7, 1, [], conc);
    for (const s of [-1, 1]) {
      box(s * 11 - 1, 0, -8, s * 11 + 1, 1.1, -3, dark);
      box(s * 11 - 1, 0, 3, s * 11 + 1, 1.1, 8, dark);
      box(s * 5 - 2, 0, s * 6 - 0.6, s * 5 + 2, 2.2, s * 6 + 0.6, conc);
      box(s * 17 - 0.5, 0, -1.5, s * 17 + 0.5, 1.2, 1.5, dark);
    }
    box(-1.5, 0, -1.5, 1.5, 3.2, 1.5, conc);
    for (let i = -20; i <= 20; i += 8) box(i - 0.2, 7, -15.5, i + 0.2, 9, -14.5, 0x2a2a2a, false);
  }

  /** Second arena: a container yard on a steel dock. Same size and spawn gates as the first. */
  private buildShipyard() {
    const { x, z } = this.gulags[1], box = this.builder(x, z, false, 0);
    const rust = 0x8a4b32, steel = 0x59636b, wood = 0x9a6b3c;
    box(-24, -2, -15, 24, 0.1, 15, 0x5d6a70);
    for (let i = -22; i <= 22; i += 4) box(i - 0.05, 0.1, -15, i + 0.05, 0.12, 15, 0xd9a520, false); // deck lines
    this.wall(box, true, -24, 24, -15, 0, 7, 1, [], rust);
    this.wall(box, true, -24, 24, 15, 0, 7, 1, [], rust);
    this.wall(box, false, -15, 15, -24, 0, 7, 1, [], rust);
    this.wall(box, false, -15, 15, 24, 0, 7, 1, [], rust);
    const container = (x0: number, z0: number, x1: number, z1: number, y: number, color: number) => {
      box(x0, y, z0, x1, y + 2.6, z1, color);
      // Ribs along the long sides
      const alongX = x1 - x0 > z1 - z0;
      const len = alongX ? x1 - x0 : z1 - z0;
      for (let d = 0.6; d < len - 0.3; d += 0.9) {
        if (alongX) {
          box(x0 + d - 0.05, y + 0.1, z0 - 0.05, x0 + d + 0.05, y + 2.5, z1 + 0.05, color - 0x101010, false);
        } else {
          box(x0 - 0.05, y + 0.1, z0 + d - 0.05, x1 + 0.05, y + 2.5, z0 + d + 0.05, color - 0x101010, false);
        }
      }
    };
    // Centre stack blocks the straight line between the gates.
    container(-3, -1.2, 3, 1.2, 0, 0xb8412f);
    container(-1.2, -3, 1.2, 3, 2.6, 0x2f6fb8);
    for (const sd of [-1, 1]) {
      container(sd * 12 - 1.2, -10, sd * 12 + 1.2, -4, 0, sd < 0 ? 0x3f8a4a : 0xc9a23a);
      container(sd * 12 - 1.2, 4, sd * 12 + 1.2, 10, 0, sd < 0 ? 0xc9a23a : 0x3f8a4a);
      box(sd * 7 - 0.8, 0, sd * 8 - 0.8, sd * 7 + 0.8, 1.4, sd * 8 + 0.8, wood);
      box(sd * 7 - 0.6, 1.4, sd * 8 - 0.6, sd * 7 + 0.6, 2.4, sd * 8 + 0.6, wood);
      box(sd * 6 - 0.8, 0, -sd * 11 - 0.8, sd * 6 + 0.8, 1.4, -sd * 11 + 0.8, wood);
      box(sd * 16.5 - 0.4, 0, -2.5, sd * 16.5 + 0.4, 1.15, 2.5, steel); // cover in front of each gate
      box(sd * 20 - 1.5, 0, 12, sd * 20 + 1.5, 0.9, 14, steel);
      box(sd * 20 - 1.5, 0, -14, sd * 20 + 1.5, 0.9, -12, steel);
    }
    // Gantry crane overhead
    for (const sd of [-1, 1]) box(sd * 18 - 0.4, 0, -14.4, sd * 18 + 0.4, 10, -13.6, 0xd9a520, false);
    for (const sd of [-1, 1]) box(sd * 18 - 0.4, 0, 13.6, sd * 18 + 0.4, 10, 14.4, 0xd9a520, false);
    box(-18.4, 10, -14.4, -17.6, 10.8, 14.4, 0xd9a520, false);
    box(17.6, 10, -14.4, 18.4, 10.8, 14.4, 0xd9a520, false);
    box(-18.4, 10.8, -0.6, 18.4, 11.6, 0.6, 0xd9a520, false);
    box(-1, 9, -1, 1, 10.8, 1, 0x2a2a2a, false);
    for (let i = -20; i <= 20; i += 8) box(i - 0.2, 7, 14.5, i + 0.2, 9, 15.5, 0x2a2a2a, false);
  }

  // ---------- arena ----------

  /**
   * The Foundry: 96 × 60 m, mirrored west (blue) to east (red). A two-storey control building in the
   * middle with a rooftop, raised catwalks over both side lanes, containers, barricades and crates.
   */
  private buildArena() {
    const { x: X, z: Z } = this.arena, box = this.builder(X, Z, false, 0), side = this.builder(X, Z, true, 0);
    const HX = this.arenaHalf.x, HZ = this.arenaHalf.z;
    const floor = 0x5b5f66, wallC = 0x80858c, trim = 0x3d4148, conc = 0x9a978f, steel = 0x5f6a73;
    const blue = 0x2f6fd8, red = 0xd8412f, amber = 0xe0a21a;
    box(-HX - 2, -2, -HZ - 2, HX + 2, 0.1, HZ + 2, floor);
    // Perimeter: tall walls with a dark band and the team colours on each end.
    this.wall(box, true, -HX - 1, HX + 1, -HZ - 0.5, 0, 10, 1, [], wallC);
    this.wall(box, true, -HX - 1, HX + 1, HZ + 0.5, 0, 10, 1, [], wallC);
    this.wall(box, false, -HZ, HZ, -HX - 0.5, 0, 10, 1, [], wallC);
    this.wall(box, false, -HZ, HZ, HX + 0.5, 0, 10, 1, [], wallC);
    box(-HX, 0.1, -HZ + 0.02, HX, 1.1, -HZ + 0.1, trim, false);
    box(-HX, 0.1, HZ - 0.1, HX, 1.1, HZ - 0.02, trim, false);
    box(-HX + 0.02, 3, -HZ, -HX + 0.1, 4.2, HZ, blue, false);
    box(HX - 0.1, 3, -HZ, HX - 0.02, 4.2, HZ, red, false);
    // Floor markings: lane lines and a centre ring of hazard stripes.
    for (const s of [-1, 1]) {
      box(-HX + 2, 0.1, s * 10 - 0.08, HX - 2, 0.115, s * 10 + 0.08, 0xc9c2a8, false);
      box(s * 36 - 0.1, 0.1, -HZ + 1, s * 36 + 0.1, 0.115, HZ - 1, s < 0 ? blue : red, false);
    }
    for (let k = -8; k <= 8; k += 2) {
      box(k - 0.5, 0.1, -8.6, k + 0.5, 0.118, -8, amber, false);
      box(k - 0.5, 0.1, 8, k + 0.5, 0.118, 8.6, amber, false);
    }

    // --- control building: ground floor room, stairs up to a walled rooftop ---
    const B = 6, H = 4.2;
    const door: Opening = { a: -1.3, b: 1.3, bottom: 0, top: 2.7, open: true };
    const win = (a: number): Opening => ({ a: a - 0.8, b: a + 0.8, bottom: 1.1, top: 2.4, open: true });
    this.wall(box, true, -B, B, -B, 0, H, 0.4, [win(-3.8), door, win(3.8)], conc);
    this.wall(box, true, -B, B, B, 0, H, 0.4, [win(-3.8), door, win(3.8)], conc);
    this.wall(box, false, -B, B, -B, 0, H, 0.4, [win(-3.8), door, win(3.8)], conc);
    this.wall(box, false, -B, B, B, 0, H, 0.4, [{ a: -4.9, b: -2.7, bottom: 0, top: 2.7, open: true }, win(3.8)], conc);
    // Stairs along the inside of the east wall, then the roof slab with a hole above them.
    this.stairs(box, 3.3, 5.6, 5.4, -1, 0.1, H + 0.3 - 0.1, trim);
    box(-B, H, -B, 3.3, H + 0.3, B, conc);
    box(3.3, H, -B, B, H + 0.3, -0.6, conc);
    box(3.3, H, 5.5, B, H + 0.3, B, conc);
    for (const s of [-1, 1]) {
      box(-B, H + 0.3, s * B - 0.2, B, H + 1.35, s * B + 0.2, conc);
      box(s * B - 0.2, H + 0.3, -B, s * B + 0.2, H + 1.35, B, conc);
    }
    box(3.1, H + 0.3, -0.6, 3.3, H + 1.3, 5.5, steel); // railing round the stairwell
    box(-1.5, 0.1, -1.5, 1.5, 1.0, 1.5, trim); // a low table to fight round inside
    this.arenaPickups.push({ at: new Vector3(X - 3, H + 0.35, Z), weapon: 'sniper' });

    // --- side lanes: catwalks over them, containers under them ---
    for (const s of [-1, 1]) {
      const cz = s * 23;
      // Catwalk deck (world x -9..9) and its rails, on posts.
      box(-9, 3.1, cz - 1.6, 9, 3.4, cz + 1.6, steel);
      box(-9, 3.4, cz + s * 1.5, 9, 4.4, cz + s * 1.6, trim);
      for (const px of [-8, -3, 3, 8]) box(px - 0.15, 0.1, cz - 0.15, px + 0.15, 3.1, cz + 0.15, trim);
      // Stairs up from both ends (a swapped builder runs them along world x).
      this.stairs(side, cz - 1.5, cz + 1.5, -13.4, 1, 0.1, 3.3, trim);
      this.stairs(side, cz - 1.5, cz + 1.5, 13.4, -1, 0.1, 3.3, trim);
      this.arenaPickups.push({ at: new Vector3(X, 3.45, Z + cz), weapon: s < 0 ? 'lmg' : 'shotgun' });
      // Containers
      for (const sx of [-1, 1]) {
        const x0 = sx * 17;
        box(x0 - 3, 0.1, cz - s * 4.5, x0 + 3, 2.7, cz - s * 2.2, sx < 0 ? 0x2f6fb8 : 0xb8412f);
        box(x0 - 3.05, 0.4, cz - s * 4.55, x0 + 3.05, 0.5, cz - s * 2.15, 0x222222, false);
        box(sx * 26 - 1.2, 0.1, s * 14 - 3, sx * 26 + 1.2, 2.7, s * 14 + 3, 0x3f8a4a);
        box(sx * 26 - 1.2, 2.7, s * 14 - 1.4, sx * 26 + 1.2, 5.3, s * 14 + 1.4, 0xc9a23a);
      }
      box.prop('crate', -1, 0.1, cz - s * 5.2, 1, 1.1, cz - s * 4.2, 0x9a7446);
      box.prop('crate', 5, 0.1, cz + s * 3.5 - 0.5, 6.2, 1.1, cz + s * 3.5 + 0.5, 0x9a7446);
      box.prop('crate', -6.2, 0.1, cz + s * 3.5 - 0.5, -5, 1.1, cz + s * 3.5 + 0.5, 0x9a7446);
    }

    // --- mid: barricades and pillars between the spawns and the building ---
    for (const sx of [-1, 1]) {
      box(sx * 13 - 0.4, 0.1, -3.5, sx * 13 + 0.4, 1.25, 3.5, conc);
      box(sx * 21 - 1.5, 0.1, -7.4, sx * 21 + 1.5, 1.25, -6.6, conc);
      box(sx * 21 - 1.5, 0.1, 6.6, sx * 21 + 1.5, 1.25, 7.4, conc);
      for (const sz of [-1, 1]) box(sx * 9 - 0.7, 0.1, sz * 9 - 0.7, sx * 9 + 0.7, 7, sz * 9 + 0.7, trim);
      box.prop('crate', sx * 17 - 0.6, 0.1, -0.6, sx * 17 + 0.6, 1.2, 0.6, 0x9a7446);
      box.prop('crate', sx * 30 - 0.6, 0.1, sx * 4 - 0.6, sx * 30 + 0.6, 1.2, sx * 4 + 0.6, 0x9a7446);
      // Spawn: a canopy on posts and two cover walls in front of it.
      const t = sx < 0 ? blue : red;
      box(sx * HX - sx * 8, 4, -9, sx * HX, 4.3, 9, steel, true);
      for (const sz of [-9, 9]) box(sx * (HX - 8) - 0.2, 0.1, sz - 0.2, sx * (HX - 8) + 0.2, 4, sz + 0.2, trim);
      box(sx * HX - sx * 8, 4.3, -9, sx * HX, 4.5, -8.6, t, false);
      box(sx * HX - sx * 8, 4.3, 8.6, sx * HX, 4.5, 9, t, false);
      box(sx * 36 - 0.4, 0.1, -12, sx * 36 + 0.4, 1.3, -6, conc);
      box(sx * 36 - 0.4, 0.1, 6, sx * 36 + 0.4, 1.3, 12, conc);
      const team = sx < 0 ? 0 : 1;
      for (const [lx, lz] of [[44, -5], [44, 0], [44, 5], [41, -3], [41, 3], [43, -18], [43, 18], [40, -25], [40, 25]]) {
        this.arenaSpawns[team].push(new Vector3(X + sx * lx, 0.15, Z + lz));
      }
    }
    this.arenaPickups.push({ at: new Vector3(X, 1.05, Z), weapon: 'rocket' });
    // Floodlights on the walls (emissive panels) so night matches stay readable.
    for (let k = -40; k <= 40; k += 20) {
      for (const s of [-1, 1]) box(k - 1.2, 8.6, s * (HZ - 0.12) - 0.1, k + 1.2, 9.2, s * (HZ - 0.12) + 0.1, 0xfff4d8, false);
    }
  }

  // ---------- themed: military ----------

  /** Concrete bunker with firing slits and sandbags out front. */
  private tryBunker(x: number, z: number): boolean {
    const rng = this.rng, swap = rng() < 0.5;
    const lot = this.claim(x, z, swap ? 8 : 10, swap ? 10 : 8, 4);
    if (!lot) return false;
    const bk = this.builder(x, z, swap, lot.y);
    const c = 0x9a978e;
    const slits = (s0: number, s1: number) => this.windowsFor(s0, s1, 3).map((o) => ({ ...o, bottom: 1.3, top: 1.7, open: true }));
    bk(-4, 0, -3, 4, 0.1, 3, 0x7a776f);
    this.wall(bk, true, -4, 4, -3, 0, 2.4, 0.5, slits(-4, 4), c);
    this.wall(bk, true, -4, 4, 3, 0, 2.4, 0.5, [{ a: -0.8, b: 0.8, bottom: 0, top: 2.2 }], c);
    this.wall(bk, false, -2.75, 2.75, -4, 0, 2.4, 0.5, slits(-3, 3).slice(0, 1), c);
    this.wall(bk, false, -2.75, 2.75, 4, 0, 2.4, 0.5, slits(-3, 3).slice(0, 1), c);
    bk(-4.3, 2.4, -3.3, 4.3, 2.9, 3.3, 0x86837b);
    bk(-3, 0, -4.9, 3, 0.9, -4.3, 0xb3a37a); // sandbags
    this.lootSpots.push(this.local(x, z, swap, lot.y, -1.5, 0.15, 0), this.local(x, z, swap, lot.y, 1.8, 0.15, 1));
    this.footprints.push({ ...lot, color: '#9a978e' });
    return true;
  }

  /** Radar hut with a white dome on the roof. */
  private tryRadarDome(x: number, z: number): boolean {
    const rng = this.rng;
    const lot = this.claim(x, z, 11, 11, 4);
    if (!lot) return false;
    const box = this.builder(x, z, false, lot.y);
    const c = 0xb8b8ae, t = 0.3, H = 4;
    box(-4, 0, -4, 4, 0.1, 4, 0x8a877e);
    this.wall(box, true, -4, 4, -4, 0, H, t, [{ a: -0.8, b: 0.8, bottom: 0, top: 2.5 }], c);
    this.wall(box, true, -4, 4, 4, 0, H, t, this.windowsFor(-4, 4, 2), c);
    this.wall(box, false, -4 + t / 2, 4 - t / 2, -4, 0, H, t, this.windowsFor(-4, 4, 1), c);
    this.wall(box, false, -4 + t / 2, 4 - t / 2, 4, 0, H, t, [], c);
    box(-4.3, H, -4.3, 4.3, H + 0.3, 4.3, 0x6f7563);
    [3.9, 3.8, 3.5, 3.0, 2.3, 1.3].forEach((r, i) => box(-r, H + 0.3 + i * 0.75, -r, r, H + 0.3 + (i + 1) * 0.75, r, 0xeef0ee));
    box(3, 0, 4.2, 5.2, 1.4, 5.4, 0x6b7a5a); // generator
    for (let i = 0; i < 2; i++) this.lootSpots.push(this.local(x, z, false, lot.y, rand(rng, -2.8, 2.8), 0.15, rand(rng, -2.5, 2.8)));
    this.footprints.push({ ...lot, color: '#e6e8e4' });
    return true;
  }

  /** Abandoned tank: solid cover you can hide behind. */
  private tryTank(x: number, z: number): boolean {
    const rng = this.rng, swap = rng() < 0.5, f = rng() < 0.5 ? 1 : -1;
    const lot = this.claim(x, z, swap ? 4.4 : 9.4, swap ? 9.4 : 4.4, 3);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const hull = pick(rng, [0x5f6b55, 0x6b7a5a, 0x7d6a48]), dark = 0x3d4535;
    box(-3.2, 0, -1.9, 3.2, 0.9, -1.2, dark);
    box(-3.2, 0, 1.2, 3.2, 0.9, 1.9, dark);
    box(-3, 0.5, -1.6, 3, 1.6, 1.6, hull);
    box(-1.3, 1.6, -1.1, 1.3, 2.4, 1.1, hull);
    box(f > 0 ? 1.3 : -4.6, 1.85, -0.13, f > 0 ? 4.6 : -1.3, 2.1, 0.13, dark, false);
    this.lootSpots.push(this.local(x, z, swap, lot.y, rand(rng, -2, 2), 0.1, 2.9));
    this.footprints.push({ ...lot, color: '#5f6b55' });
    return true;
  }

  /** Supply dump under a camouflage net. */
  private tryCamoNet(x: number, z: number): boolean {
    const rng = this.rng, swap = rng() < 0.5;
    const lot = this.claim(x, z, swap ? 8 : 10, swap ? 10 : 8, 3);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    for (const [px, pz] of [[-4.6, -3.6], [4.6, -3.6], [-4.6, 3.6], [4.6, 3.6]]) box(px - 0.1, 0, pz - 0.1, px + 0.1, 3.2, pz + 0.1, 0x5a4a3a);
    const cols = [0x55603f, 0x6b7a4a, 0x7d6a48, 0x4a5236];
    for (let i = -5; i < 5; i += 2) for (let k = -4; k < 4; k += 2) {
      const o = rng() * 0.25;
      box(i, 3.1 + o, k, i + 2, 3.25 + o, k + 2, pick(rng, cols), false);
    }
    for (let i = 0; i < 3; i++) {
      const cx = (rng() < 0.5 ? -1 : 1) * rand(rng, 1.8, 3.4), cz = rand(rng, -2.4, 2.4);
      box.prop('crate', cx - 0.7, 0, cz - 0.5, cx + 0.7, 1.0, cz + 0.5, pick(rng, [0x6b7a5a, 0x7d6a48]));
    }
    this.lootSpots.push(this.local(x, z, swap, lot.y, 0, 0.1, 0), this.local(x, z, swap, lot.y, 0, 0.1, 2.5));
    this.barrelSpots.push(this.local(x, z, swap, lot.y, 4.2, 0, 0));
    this.footprints.push({ ...lot, color: '#6b7a5a' });
    return true;
  }

  /** A missile standing in its launch collar, with a gantry you can climb for a view. */
  private tryMissileSilo(x: number, z: number): boolean {
    const lot = this.claim(x, z, 22, 22, 4);
    if (!lot) return false;
    const box = this.builder(x, z, false, lot.y);
    const conc = 0x9a978e, white = 0xeef0ee, G = 0x6b7a5a;
    box(-10, -0.4, -10, 10, 0.15, 10, 0x8a877e);
    box(-3.5, 0, -3.5, 3.5, 1.2, -2.9, conc);
    box(-3.5, 0, 2.9, 3.5, 1.2, 3.5, conc);
    box(-3.5, 0, -2.9, -2.9, 1.2, 2.9, conc);
    box(2.9, 0, -2.9, 3.5, 1.2, 2.9, conc);
    box(-1.2, 0, -1.2, 1.2, 15, 1.2, white);
    box(-1.25, 5, -1.25, 1.25, 5.6, 1.25, 0x3d4535, false);
    let y = 15;
    for (const [r, h] of [[1.0, 1.4], [0.75, 1.2], [0.45, 1.0]]) {
      box(-r, y, -r, r, y + h, r, white);
      y += h;
    }
    box(-0.25, y, -0.25, 0.25, y + 0.7, 0.25, 0xd9382c);
    box(1.2, 0.5, -0.1, 2.2, 3.5, 0.1, 0xd9382c);
    box(-2.2, 0.5, -0.1, -1.2, 3.5, 0.1, 0xd9382c);
    box(-0.1, 0.5, 1.2, 0.1, 3.5, 2.2, 0xd9382c);
    box(-0.1, 0.5, -2.2, 0.1, 3.5, -1.2, 0xd9382c);
    // Gantry: legs, three decks, a stair to the first one and an arm across to the missile.
    for (const [lx, lz] of [[5, 0.3], [9.5, 0.3], [5, 2.8], [9.5, 2.8]]) box(lx - 0.2, 0, lz - 0.2, lx + 0.2, 18, lz + 0.2, G);
    for (const dy of [6, 12, 18]) box(5, dy - 0.3, 0, 9.7, dy, 3, 0x5f6b55);
    box(1.2, 11.7, 1.0, 5, 12, 2.0, 0x5f6b55);
    this.stairs(box, 8.5, 9.7, -8.2, 1, 0, 6, G);
    this.lootSpots.push(
      this.local(x, z, false, lot.y, 7, 6.05, 1.5), this.local(x, z, false, lot.y, -6, 0.2, -6),
      this.local(x, z, false, lot.y, -6, 0.2, 6), this.local(x, z, false, lot.y, 6, 0.2, 7),
    );
    this.footprints.push({ ...lot, color: '#c9c9c3' });
    return true;
  }

  /** Swan pedal boats on the park lake: bits of cover out on the water. */
  private swanBoats() {
    const L = LAKES[0];
    if (!L) return;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.3, d = L.r * (0.7 + (i % 3) * 0.07);
      const x = L.x + Math.cos(a) * d, z = L.z + Math.sin(a) * d;
      if (this.terrain.heightAt(x, z) > -1.2) continue;
      const ax = i % 2 === 0, hx = ax ? 1.1 : 0.7, hz = ax ? 0.7 : 1.1, y = -0.5;
      const col = i % 4 === 3 ? 0x2a2a2a : 0xf4f2ee;
      this.addSolid(x - hx, y - 0.4, z - hz, x + hx, y + 0.7, z + hz, col);
      const nx = x + (ax ? hx - 0.25 : 0), nz = z + (ax ? 0 : hz - 0.25);
      this.addSolid(nx - 0.14, y + 0.7, nz - 0.14, nx + 0.14, y + 1.9, nz + 0.14, col, false);
      this.addSolid(nx - (ax ? 0.1 : 0.16), y + 1.75, nz - (ax ? 0.16 : 0.1), nx + (ax ? 0.4 : 0.16), y + 2.05, nz + (ax ? 0.16 : 0.4), col, false);
      this.addSolid(nx + (ax ? 0.4 : -0.06), y + 1.8, nz + (ax ? -0.06 : 0.4), nx + (ax ? 0.62 : 0.06), y + 1.95, nz + (ax ? 0.06 : 0.62), 0xe07020, false);
      this.lootSpots.push(new Vector3(x - (ax ? 0.4 : 0), y + 0.72, z - (ax ? 0 : 0.4)));
      this.occupied.push({ x0: x - hx, z0: z - hz, x1: x + hx, z1: z + hz });
    }
  }

  // ---------- themed: military buildings ----------

  /** Guard booth at (bx, bz) with a striped boom reaching out along X or Z (dir = which way). */
  private gateBooth(bx: number, bz: number, y: number, alongX: boolean, dir = -1) {
    const box = this.builder(bx, bz, false, y);
    const c = 0xd8d4c8, t = 0.15;
    this.wall(box, true, -1.2, 1.2, -1.2, 0, 2.6, t, [{ a: -0.6, b: 0.6, bottom: 1.0, top: 2.0 }], c);
    this.wall(box, true, -1.2, 1.2, 1.2, 0, 2.6, t, [{ a: -0.6, b: 0.6, bottom: 1.0, top: 2.0 }], c);
    this.wall(box, false, -1.05, 1.05, -1.2, 0, 2.6, t, [{ a: -0.5, b: 0.5, bottom: 0, top: 2.2, open: true }], c);
    this.wall(box, false, -1.05, 1.05, 1.2, 0, 2.6, t, [{ a: -0.5, b: 0.5, bottom: 1.0, top: 2.0 }], c);
    box(-1.5, 2.6, -1.5, 1.5, 2.85, 1.5, 0x4a5040);
    for (let k = 0; k < 9; k++) {
      const a = dir * (1.6 + k * 0.5) + (dir < 0 ? 0 : 0.5), col = k % 2 ? 0xf0f0f0 : 0xd03030;
      if (alongX) box(a - 0.5, 1.0, -0.06, a, 1.12, 0.06, col, false);
      else box(-0.06, 1.0, a - 0.5, 0.06, 1.12, a, col, false);
    }
    box(-1.7, 0, -1.7, -1.4, 1.2, -1.4, 0x3a3a3a);
    this.lootSpots.push(new Vector3(bx, y + 0.1, bz));
    this.occupied.push({ x0: bx - 1.8, z0: bz - 1.8, x1: bx + 1.8, z1: bz + 1.8 });
  }

  /** Long single-storey barracks: rows of bunks, lockers, a door at each end. */
  private tryBarracks(x: number, z: number): boolean {
    const rng = this.rng, swap = rng() < 0.5;
    const w = rand(rng, 18, 22), d = 8, hw = w / 2, hd = d / 2, t = 0.3, H = 3.2;
    const lot = this.claim(x, z, swap ? d + 2 : w + 2, swap ? w + 2 : d + 2, 4);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const c = pick(rng, [0x7d8566, 0x8a8f7a, 0x6b7a5a]), roof = 0x4a5040;
    box(-hw, 0, -hd, hw, 0.12, hd, 0x8a877e);
    this.wall(box, true, -hw, hw, -hd, 0, H, t, this.windowsFor(-hw, hw, 5), c);
    this.wall(box, true, -hw, hw, hd, 0, H, t, this.windowsFor(-hw, hw, 5), c);
    this.wall(box, false, -hd + t / 2, hd - t / 2, -hw, 0, H, t, [{ a: -0.8, b: 0.8, bottom: 0, top: 2.4 }], c);
    this.wall(box, false, -hd + t / 2, hd - t / 2, hw, 0, H, t, [{ a: -0.8, b: 0.8, bottom: 0, top: 2.4 }], c);
    this.gable(box, -hw, hw, -hd, hd, H, 4, roof);
    for (let bx = -hw + 1.8; bx < hw - 1.8; bx += 2.6) {
      for (const s of [-1, 1]) {
        const z0 = s < 0 ? -hd + t / 2 : hd - t / 2 - 2, z1 = z0 + 2;
        box(bx - 0.45, 0, z0, bx + 0.45, 0.5, z1, 0x5a6048);
        box(bx - 0.45, 1.3, z0, bx + 0.45, 1.45, z1, 0x5a6048);
        box(bx - 0.45, 0.5, z0, bx - 0.4, 1.3, z0 + 0.1, 0x3a3a3a, false);
      }
    }
    for (let i = 0; i < 3; i++) this.lootSpots.push(this.local(x, z, swap, lot.y, rand(rng, -hw + 2, hw - 2), 0.15, 0));
    this.footprints.push({ ...lot, color: '#7d8566' });
    return true;
  }

  /** A military truck (cab, canvas-covered bed); `tanker` puts a fuel tank on the back instead. */
  private truck(box: Builder, x: number, z: number, alongX: boolean, tanker = false) {
    const olive = 0x5a6440, dark = 0x2a2a2a;
    const b = (u0: number, y0: number, v0: number, u1: number, y1: number, v1: number, c: number, col = true) => alongX ? box(x + u0, y0, z + v0, x + u1, y1, z + v1, c, col) : box(x + v0, y0, z + u0, x + v1, y1, z + u1, c, col);
    b(-3.6, 0.5, -1.2, 3.6, 1.1, 1.2, dark);
    b(2.0, 1.1, -1.2, 3.6, 2.6, 1.2, olive);
    b(3.4, 1.8, -1.0, 3.62, 2.4, 1.0, 0x2a3440, false);
    if (tanker) {
      b(-3.4, 1.1, -1.0, 1.8, 2.7, 1.0, 0xc8c8c0);
      b(-3.4, 1.4, -1.15, 1.8, 2.4, 1.15, 0xc8c8c0);
      b(-3.4, 1.8, -0.3, 1.8, 2.0, 0.3, 0xd03030, false);
    } else {
      b(-3.6, 1.1, -1.2, 1.9, 1.4, 1.2, olive);
      b(-3.6, 1.4, -1.2, 1.9, 3.0, -1.1, 0x6b7a4a, false);
      b(-3.6, 1.4, 1.1, 1.9, 3.0, 1.2, 0x6b7a4a, false);
      b(-3.6, 3.0, -1.2, 1.9, 3.2, 1.2, 0x6b7a4a);
    }
    for (const u of [-2.4, 0.2, 2.6]) for (const s of [-1, 1]) b(u - 0.5, 0, s * 1.15 - 0.2, u + 0.5, 1.0, s * 1.15 + 0.2, dark, false);
  }

  /** Motor pool shed: an open-sided roof over parked trucks, with oil drums and a workbench. */
  private tryMotorShed(x: number, z: number): boolean {
    const rng = this.rng, swap = rng() < 0.5;
    const lot = this.claim(x, z, swap ? 13 : 22, swap ? 22 : 13, 4);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    box(-10.5, 0, -6, 10.5, 0.08, 6, 0x6d6f73);
    for (let px = -10; px <= 10; px += 5) for (const pz of [-5.6, 5.6]) box(px - 0.2, 0, pz - 0.2, px + 0.2, 4.6, pz + 0.2, 0x5a5f55);
    box(-10.8, 4.6, -6.2, 10.8, 4.9, 6.2, 0x4a5040);
    box(-10.5, 0, 5.2, 10.5, 2.5, 5.5, 0x6b7a5a); // back wall
    for (let i = 0; i < 3; i++) if (rng() < 0.8) this.truck(box, -6.5 + i * 6.5, 0, false, rng() < 0.2);
    box(-10.2, 0, 3.6, -7.5, 0.95, 5.0, 0x6b4a2f);
    for (let i = 0; i < 2; i++) this.barrelSpots.push(this.local(x, z, swap, lot.y, 9.2, 0, 3 - i * 1.2));
    this.lootSpots.push(this.local(x, z, swap, lot.y, -8.8, 0.1, 2.4), this.local(x, z, swap, lot.y, -3.2, 0.1, -4), this.local(x, z, swap, lot.y, 3.2, 0.1, -4));
    this.footprints.push({ ...lot, color: '#5f6b55' });
    return true;
  }

  /** A parked fighter jet, nose toward -z (builder-local). */
  private jet(box: Builder, x: number, z: number) {
    const grey = 0x8a9098, dark = 0x3a3e44;
    box(x - 0.9, 0.9, z - 6, x + 0.9, 2.4, z + 6, grey);
    box(x - 0.6, 1.1, z - 7.8, x + 0.6, 2.1, z - 6, grey);
    box(x - 0.25, 1.3, z - 8.6, x + 0.25, 1.8, z - 7.8, dark);
    box(x - 0.5, 2.4, z - 5, x + 0.5, 3.0, z - 2.4, 0x2a3440);
    box(x - 6.5, 1.4, z - 0.6, x + 6.5, 1.7, z + 2.8, grey);
    box(x - 3, 1.8, z + 4.4, x + 3, 2.0, z + 6, grey);
    for (const s of [-0.7, 0.7]) box(x + s - 0.08, 2.4, z + 3.6, x + s + 0.08, 4.8, z + 6, grey);
    box(x - 0.8, 1.1, z + 6, x + 0.8, 2.2, z + 6.6, dark);
    for (const [gx, gz] of [[0, -5.5], [-1.8, 1.2], [1.8, 1.2]]) box(x + gx - 0.1, 0, z + gz - 0.1, x + gx + 0.1, 1.0, z + gz + 0.1, dark, false);
    for (const s of [-1, 1]) box(x + s * 5.2 - 0.12, 1.1, z + 0.2, x + s * 5.2 + 0.12, 1.4, z + 2.2, 0xd8d8d8, false);
  }

  /** A parked helicopter: cabin, tail boom, rotors and skids. */
  private heli(box: Builder, x: number, z: number) {
    const olive = 0x4f5a3a, dark = 0x2a2a2a;
    box(x - 1.3, 0.6, z - 2.4, x + 1.3, 2.8, z + 2.2, olive);
    box(x - 1.1, 0.8, z - 3.4, x + 1.1, 2.4, z - 2.4, 0x2a3440);
    box(x - 0.3, 1.9, z + 2.2, x + 0.3, 2.4, z + 9, olive);
    box(x - 0.06, 2.1, z + 8.4, x + 0.06, 3.6, z + 9.2, olive);
    box(x - 0.08, 2.0, z + 8.6, x + 0.08, 3.9, z + 8.9, dark, false);
    box(x - 0.15, 2.8, z - 0.15, x + 0.15, 3.3, z + 0.15, dark);
    box(x - 7, 3.3, z - 0.2, x + 7, 3.4, z + 0.2, dark, false);
    box(x - 0.2, 3.3, z - 7, x + 0.2, 3.4, z + 7, dark, false);
    for (const s of [-1, 1]) {
      box(x + s * 1.2 - 0.08, 0, z - 2.8, x + s * 1.2 + 0.08, 0.12, z + 2.4, dark, false);
      box(x + s * 1.2 - 0.05, 0.12, z - 1.5, x + s * 1.2 + 0.05, 0.6, z - 1.3, dark, false);
      box(x + s * 1.2 - 0.05, 0.12, z + 1.2, x + s * 1.2 + 0.05, 0.6, z + 1.4, dark, false);
    }
  }

  /** Aircraft hangar with a wide-open front, a jet or helicopter parked inside and crates along the walls. */
  private tryHangar(x: number, z: number, kind: 'jet' | 'heli' | 'random' = 'random'): boolean {
    const rng = this.rng, swap = this.inCity ? false : rng() < 0.5;
    const w = 26, d = 22, hw = w / 2, hd = d / 2, t = 0.4, H = 9;
    const lot = this.claim(x, z, swap ? d + 2 : w + 2, swap ? w + 2 : d + 2, 5);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const c = pick(rng, [0x8a9088, 0x7d8566, 0x9a978e]);
    box(-hw, 0, -hd, hw, 0.1, hd, 0x6d6f73);
    this.wall(box, true, -hw, hw, -hd, 0, H, t, [{ a: -hw + 1.5, b: hw - 1.5, bottom: 0, top: 7.5, open: true }], c);
    this.wall(box, true, -hw, hw, hd, 0, H, t, [{ a: hw - 3, b: hw - 1.8, bottom: 0, top: 2.4 }], c);
    const hi = (s0: number, s1: number) => this.windowsFor(s0, s1, 3).map((o) => ({ ...o, bottom: 5.5, top: 7 }));
    this.wall(box, false, -hd + t / 2, hd - t / 2, -hw, 0, H, t, hi(-hd, hd), c);
    this.wall(box, false, -hd + t / 2, hd - t / 2, hw, 0, H, t, [{ a: 4, b: 5.2, bottom: 0, top: 2.4 }, ...hi(-hd, hd)], c);
    for (let k = 0; k < 5; k++) box(-hw - 0.3 + k * 2.4, H + k * 0.6, -hd - 0.3, hw + 0.3 - k * 2.4, H + (k + 1) * 0.6, hd + 0.3, 0x6a7068);
    box(-2, H - 1.2, -hd - 0.35, 2, H - 0.2, -hd - 0.2, 0xf0f0f0, false);
    if ((kind === 'random' ? (rng() < 0.5 ? 'jet' : 'heli') : kind) === 'jet') this.jet(box, 0, 0.5);
    else this.heli(box, 0, -1);
    for (let i = 0; i < 4; i++) {
      const cx = (i % 2 ? 1 : -1) * rand(rng, 9, 11.5), cz = rand(rng, -6, 8);
      box.prop('crate', cx - 0.8, 0, cz - 0.8, cx + 0.8, 1.4, cz + 0.8, 0x6b7a5a);
    }
    box(-hw + t / 2, 0, hd - 3, -hw + 3, 1.0, hd - t / 2, 0x6b4a2f);
    this.barrelSpots.push(this.local(x, z, swap, lot.y, hw - 1.2, 0, -hd + 2), this.local(x, z, swap, lot.y, hw - 1.2, 0, -hd + 3.2));
    this.lootSpots.push(this.local(x, z, swap, lot.y, -8, 0.12, 6), this.local(x, z, swap, lot.y, 8, 0.12, -4), this.local(x, z, swap, lot.y, -hw + 1.6, 1.05, hd - 1.6));
    this.footprints.push({ ...lot, color: '#8a9088' });
    return true;
  }

  /**
   * Command bunker: a hut on the surface over a stairwell, leading down to rooms dug into the ground
   * (war room, radio room, bunk room and an armoury with a golden chest). Two stairwells, two ways out.
   */
  private tryCommandBunker(x: number, z: number): boolean {
    if (this.nearRoad(x, z, 22)) return false;
    const lot = this.claim(x, z, 38, 32, 5);
    if (!lot) return false;
    const T = this.terrain, D = 3.8, floor = lot.y - D;
    // Dig the pit: every grid point that could touch the rooms goes down to the floor.
    this.forVerts(x - 14, z - 11, x + 14, z + 11, (i, vx, vz) => {
      if (Math.abs(vx - x) <= 14 && Math.abs(vz - z) <= 11) T.heights[i] = floor;
    });
    const box = this.builder(x, z, false, floor), conc = 0x8a877e, t = 0.5;
    const top = (x0: number, z0: number, x1: number, z1: number) => box(x0, D, z0, x1, D + 0.4, z1, 0x6b7560);
    // Roof over the whole pit, with holes over the two stairwells.
    top(-18, -16, 18, -7);
    top(-18, 7, 18, 16);
    top(-18, -7, -1, 7);
    top(1, -7, 18, 7);
    top(-1, -1.3, 1, 1.3);
    // Outer walls and the floor
    box(-10, -0.2, -7, 10, 0.05, 7, 0x7a776f);
    this.wall(box, true, -10, 10, -7, 0, D, t, [], conc);
    this.wall(box, true, -10, 10, 7, 0, D, t, [], conc);
    this.wall(box, false, -7, 7, -10, 0, D, t, [], conc);
    this.wall(box, false, -7, 7, 10, 0, D, t, [], conc);
    // Rooms off a corridor along X; the stairwells sit in the middle of each side.
    for (const s of [-1, 1]) {
      const zc = s * 1.5, z0 = s < 0 ? -7 : 1.5, z1 = s < 0 ? -1.5 : 7;
      this.wall(box, true, -10, -2, zc, 0, D, 0.3, [{ a: -6.6, b: -5.4, bottom: 0, top: 2.4 }], conc);
      this.wall(box, true, 2, 10, zc, 0, D, 0.3, [{ a: 5.4, b: 6.6, bottom: 0, top: 2.4 }], conc);
      this.wall(box, false, z0, z1, -2, 0, D, 0.3, [], conc);
      this.wall(box, false, z0, z1, 2, 0, D, 0.3, [], conc);
      this.stairs(box, -0.9, 0.9, zc, s, 0, D + 0.4, 0x6a6a64);
      // The hut over the stairwell.
      const hz0 = s < 0 ? -8.6 : 1.3, hz1 = s < 0 ? -1.3 : 8.6, door = s < 0 ? hz0 : hz1;
      const hut = this.builder(x, z, false, lot.y + 0.4);
      this.wall(hut, false, hz0, hz1, -1.9, 0, 2.6, 0.25, [], 0x7d8566);
      this.wall(hut, false, hz0, hz1, 1.9, 0, 2.6, 0.25, [], 0x7d8566);
      this.wall(hut, true, -1.9, 1.9, door, 0, 2.6, 0.25, [{ a: -0.7, b: 0.7, bottom: 0, top: 2.3 }], 0x7d8566);
      this.wall(hut, true, -1.9, 1.9, s < 0 ? hz1 : hz0, 0, 2.6, 0.25, [], 0x7d8566);
      hut(-2.2, 2.6, hz0 - 0.3, 2.2, 2.9, hz1 + 0.3, 0x4a5040);
      for (const sx of [-3.2, 2.6]) hut(sx, 0, door - s * 0.2 - 0.3, sx + 0.6, 0.9, door - s * 0.2 + 0.3, 0xb3a37a);
    }
    // Furniture
    box(-8, 0, 3, -4, 0.9, 5.5, 0x4a6a4a); // map table
    box(3, 0, 6.2, 9.5, 1.1, 6.7, 0x3a3e44); // radio consoles
    for (const cx of [4, 6, 8]) box(cx - 0.4, 1.1, 6.3, cx + 0.4, 1.7, 6.6, 0x6fd06a, false);
    for (const bx of [-9, -7, -5]) {
      box(bx - 0.4, 0, -6.6, bx + 0.4, 0.5, -4.6, 0x5a6048);
      box(bx - 0.4, 1.3, -6.6, bx + 0.4, 1.45, -4.6, 0x5a6048);
    }
    box(9, 0, -6.6, 9.6, 2.2, -2, 0x3a3e44); // weapon racks
    box(3, 0, -6.6, 6, 2.2, -6.2, 0x3a3e44);
    for (const lx of [-6, 6]) for (const lz of [-4, 4]) box(lx - 0.15, D - 0.2, lz - 0.15, lx + 0.15, D - 0.05, lz + 0.15, 0xffe8a0, false);
    // Antennas and sandbags on the roof.
    box(10, D + 0.4, -3, 10.3, D + 8, -2.7, 0x9a9a9a, false);
    box(-12, D + 0.4, 3, -11.8, D + 6, 3.2, 0x9a9a9a, false);
    this.vaultSpots.push(new Vector3(x + 6.5, floor + 0.1, z - 4));
    this.lootSpots.push(
      new Vector3(x - 6, floor + 0.1, z + 3), new Vector3(x + 6, floor + 0.1, z + 3.5), new Vector3(x - 6, floor + 0.1, z - 3.5),
      new Vector3(x - 7, floor + 0.1, z), new Vector3(x + 7, floor + 0.1, z),
    );
    this.footprints.push({ ...lot, color: '#6b7560' });
    return true;
  }

  /** Fuel depot: three round tanks, pipework, fuel trucks and a lot of explosive drums. */
  private tryFuelDepot(x: number, z: number): boolean {
    if (this.nearRoad(x, z, 15)) return false;
    const rng = this.rng, swap = rng() < 0.5;
    const lot = this.claim(x, z, swap ? 24 : 32, swap ? 32 : 24, 5);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const tankC = pick(rng, [0xd8dad6, 0xc8ccc4, 0xb8bca8]), pipe = 0x7a7a80;
    box(-15, 0, -11, 15, 0.06, 11, 0x8a8a84);
    for (const tx of [-9, 0, 9]) {
      const R = 3.6, h = rand(rng, 5.5, 7);
      box(tx - R, 0, -5 - R * 0.45, tx + R, h, -5 + R * 0.45, tankC);
      box(tx - R * 0.45, 0, -5 - R, tx + R * 0.45, h, -5 + R, tankC);
      box(tx - R * 0.78, 0, -5 - R * 0.78, tx + R * 0.78, h, -5 + R * 0.78, tankC);
      box(tx - R * 0.6, h, -5 - R * 0.6, tx + R * 0.6, h + 0.5, -5 + R * 0.6, tankC);
      box(tx - R - 0.02, h * 0.5, -5 - 0.6, tx + R + 0.02, h * 0.5 + 0.4, -5 + 0.6, 0xd03030, false);
      box(tx + R - 0.1, 0, -5 + 1.2, tx + R + 0.1, h, -5 + 1.5, 0x5a5a5a, false); // ladder
    }
    box(-13, 2.4, -0.7, 13, 2.8, -0.3, pipe, false);
    for (const px of [-12, -4.5, 4.5, 12]) box(px - 0.12, 0, -0.62, px + 0.12, 2.4, -0.38, pipe);
    for (const px of [-9, 0, 9]) box(px - 0.2, 0.2, -1.6, px + 0.2, 2.8, -0.3, pipe, false);
    box(-3, 0, 1.2, -1.2, 1.3, 2.6, 0xd03030); // pump
    this.truck(box, 6, 4.5, true, true);
    this.truck(box, -7, 7.5, true, rng() < 0.6);
    for (let i = 0; i < 6; i++) this.barrelSpots.push(this.local(x, z, swap, lot.y, 13.5 - (i % 3) * 1.1, 0, 3 + Math.floor(i / 3) * 1.1));
    const fc = 0x8a8f94;
    this.fence(box, true, -15, -2, -11, fc);
    this.fence(box, true, 2, 15, -11, fc);
    this.fence(box, false, -11, 11, -15, fc);
    this.fence(box, false, -11, 11, 15, fc);
    this.lootSpots.push(this.local(x, z, swap, lot.y, -4.5, 0.1, -9.5), this.local(x, z, swap, lot.y, 1, 0.1, 9), this.local(x, z, swap, lot.y, -12, 0.1, 5));
    this.footprints.push({ ...lot, color: '#d8dad6' });
    return true;
  }

  /** Obstacle course: vault walls, a tall wall, tyre run, climbing frame, balance beam, crawl net. */
  // ---------- parkour ----------

  /**
   * Movement playgrounds out between the towns: scaffold towers, crate runs, rock stairs, slide lanes
   * and jump gaps. Everything is climbable in steps a jump (or a mantle) can make, and the tops are
   * good grapple anchors.
   */
  private placeParkour() {
    const rng = this.rng, makers = [
      (x: number, z: number) => this.tryScaffold(x, z),
      (x: number, z: number) => this.tryCrateRun(x, z),
      (x: number, z: number) => this.tryRockStairs(x, z),
      (x: number, z: number) => this.trySlideLane(x, z),
      (x: number, z: number) => this.tryJumpGap(x, z),
    ];
    let placed = 0;
    for (let i = 0; i < 400 && placed < 48; i++) {
      const x = rand(rng, -455, 455), z = rand(rng, -455, 455);
      if (this.pois.some((p) => Math.hypot(p.x - x, p.z - z) < p.radius + 12)) continue;
      if (this.terrain.heightAt(x, z) < 1.5) continue;
      if (makers[placed % makers.length](x, z)) placed++;
    }
  }

  private parkourColors() {
    return THEME === 'western' ? { wood: 0x7a5a3a, dark: 0x4a3222, rock: 0xc07a4a, rock2: 0xa8643a, crate: 0x9a7040, accent: 0xd8b060 }
      : THEME === 'military' ? { wood: 0x6b6a4a, dark: 0x3a3a32, rock: 0x8a8a80, rock2: 0x74746a, crate: 0x5a6a3a, accent: 0xd8c040 }
      : THEME === 'park' ? { wood: 0x8a5ab0, dark: 0x4a3060, rock: 0xd8b48a, rock2: 0xc49a70, crate: 0xe06a4a, accent: 0xffd24a }
      : { wood: 0x7a5a3a, dark: 0x3a3a3a, rock: 0x9a968c, rock2: 0x86827a, crate: 0xa07a48, accent: 0xff8a3a };
  }

  /** Scaffold tower: three decks (3.2, 6.4, 9.6 m) climbed by a staircase of crates round the outside. */
  private tryScaffold(x: number, z: number): boolean {
    const rng = this.rng, swap = rng() < 0.5;
    const lot = this.claim(x, z, 14, 14, 4);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y), C = this.parkourColors();
    for (const px of [-3, 3]) for (const pz of [-3, 3]) box(px - 0.18, -0.3, pz - 0.18, px + 0.18, 10.6, pz + 0.18, C.dark);
    for (const [i, h] of [3.2, 6.4, 9.6].entries()) {
      // Each deck leaves a gap on one side to jump up through.
      if (i % 2 === 0) box(-3.2, h - 0.2, -3.2, 1.2, h, 3.2, C.wood);
      else box(-1.2, h - 0.2, -3.2, 3.2, h, 3.2, C.wood);
    }
    box(-3.2, 10.4, -3.2, 3.2, 10.6, -3.0, C.accent, false);
    box(-3.2, 10.4, 3.0, 3.2, 10.6, 3.2, C.accent, false);
    // Stepping crates: up the outside to the first deck, then ledges between decks.
    const steps: [number, number, number][] = [[-5.2, 1.1, 4.8], [-5.2, 2.2, 2.4], [-5.2, 3.2, 0]];
    for (const [sx, h, sz] of steps) box(sx - 1, -0.3, sz - 1, sx + 1, h, sz + 1, C.crate);
    box(2.2, 4.3, -3.2, 3.2, 4.5, -2.0, C.wood); // ledge from deck 1 toward deck 2
    box(2.2, 5.4, -1.0, 3.2, 5.6, 0.2, C.wood);
    box(-3.2, 7.5, 2.0, -2.2, 7.7, 3.2, C.wood); // deck 2 to 3
    box(-3.2, 8.6, 0, -2.2, 8.8, 1.2, C.wood);
    this.lootSpots.push(this.local(x, z, swap, lot.y, 0, 9.65, 0), this.local(x, z, swap, lot.y, -1, 3.25, 0));
    this.footprints.push({ ...lot, color: '#8a6a4a' });
    return true;
  }

  /** Crate run: hop up a line of crates to a plank walkway, then a jump to a second stack. */
  private tryCrateRun(x: number, z: number): boolean {
    const rng = this.rng, swap = rng() < 0.5;
    const lot = this.claim(x, z, 30, 8, 3);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y), C = this.parkourColors();
    const hs = [0.9, 1.8, 2.7, 3.6];
    hs.forEach((h, i) => box(-14 + i * 2.2, -0.3, -1 + (i % 2) * 0.6, -12 + i * 2.2, h, 1 + (i % 2) * 0.6, C.crate));
    box(-5.2, 3.4, -0.8, 3, 3.6, 0.8, C.wood); // walkway
    for (const px of [-4.8, -0.8, 2.6]) box(px - 0.12, -0.3, -0.12, px + 0.12, 3.4, 0.12, C.dark);
    // A 3.5 m gap, then a lower landing stack and steps down.
    box(6.5, -0.3, -1.4, 9.5, 3.0, 1.4, C.crate);
    box(9.5, -0.3, -1.2, 11.5, 2.0, 1.2, C.crate);
    box(11.5, -0.3, -1.0, 13.5, 1.0, 1.0, C.crate);
    box(-8, -0.3, 2.6, 8, 0.9, 3.2, C.dark); // cover along one side
    this.lootSpots.push(this.local(x, z, swap, lot.y, 8, 3.05, 0), this.local(x, z, swap, lot.y, -1, 3.65, 0));
    this.footprints.push({ ...lot, color: '#8a6a4a' });
    return true;
  }

  /** Rock stairs: a pile of sandstone blocks stepping up to a flat top 5 m above the ground. */
  private tryRockStairs(x: number, z: number): boolean {
    const rng = this.rng;
    const lot = this.claim(x, z, 16, 16, 3);
    if (!lot) return false;
    const box = this.builder(x, z, false, lot.y), C = this.parkourColors();
    box(-2.5, -0.5, -2.5, 2.5, 5, 2.5, C.rock);
    // A ring of steps around the core, climbing 1 m at a time (with a little random wobble).
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 1.6 + rng() * 0.2, r = 4.4 - k * 0.35, h = 1 + k;
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r, s = 1.2 + rng() * 0.4;
      box(cx - s, -0.5, cz - s, cx + s, h + rand(rng, -0.1, 0.1), cz + s, k % 2 ? C.rock2 : C.rock);
    }
    for (let k = 0; k < 4; k++) {
      const a = rng() * Math.PI * 2, r = 6 + rng() * 1.2, s = 0.6 + rng() * 0.5;
      box(Math.cos(a) * r - s, -0.5, Math.sin(a) * r - s, Math.cos(a) * r + s, 0.5 + rng() * 1.2, Math.sin(a) * r + s, C.rock2);
    }
    this.lootSpots.push(this.local(x, z, false, lot.y, 0, 5.05, 0));
    this.footprints.push({ ...lot, color: '#b07050' });
    return true;
  }

  /** Slide lane: two long low walls to run between, beams you have to slide under, a jump log at the end. */
  private trySlideLane(x: number, z: number): boolean {
    const rng = this.rng, swap = rng() < 0.5;
    const lot = this.claim(x, z, 28, 9, 3);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y), C = this.parkourColors();
    for (const s of [-1, 1]) box(-13, -0.3, s * 3 - 0.3, 13, 1.1, s * 3 + 0.3, C.wood);
    for (const bx of [-6, 0, 6]) {
      for (const s of [-1, 1]) box(bx - 0.15, -0.3, s * 2.6 - 0.15, bx + 0.15, 1.9, s * 2.6 + 0.15, C.dark);
      box(bx - 0.2, 1.3, -2.7, bx + 0.2, 1.9, 2.7, C.accent); // slide under (crouch height is 1.15 m)
    }
    box(10, -0.3, -2.4, 10.8, 0.7, 2.4, C.crate); // hurdle
    box(-12.5, -0.3, -2, -10.5, 1.1, 2, C.crate); // start block
    this.lootSpots.push(this.local(x, z, swap, lot.y, 3, 0.1, 0));
    this.footprints.push({ ...lot, color: '#8a6a4a' });
    return true;
  }

  /** Jump gap: two platforms 4 m up with a 4 m gap between them, stairs up to the first one. */
  private tryJumpGap(x: number, z: number): boolean {
    const rng = this.rng, swap = rng() < 0.5;
    const lot = this.claim(x, z, 26, 10, 3);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y), C = this.parkourColors();
    for (let k = 0; k < 8; k++) box(-12 + k * 0.7, -0.3, -1.5, -11.3 + k * 0.7, 0.5 * (k + 1), 1.5, C.rock2);
    box(-6.4, -0.3, -2.5, -2, 4, 2.5, C.rock);
    box(2, -0.3, -2.5, 7, 4.4, 2.5, C.rock);
    box(7, -0.3, -2, 9.5, 3.0, 2, C.rock2);
    box(9.5, -0.3, -1.6, 11.5, 1.6, 1.6, C.rock2);
    // A plank half way across for the careful, a crate below to climb back out of the pit.
    box(-2, 3.6, -0.3, 2, 3.8, 0.3, C.wood, true);
    box(-1, -0.3, 1.2, 1, 1.0, 2.5, C.crate);
    this.lootSpots.push(this.local(x, z, swap, lot.y, 4.5, 4.45, 0));
    this.footprints.push({ ...lot, color: '#b07050' });
    return true;
  }

  private tryObstacleCourse(x: number, z: number): boolean {
    const rng = this.rng, swap = rng() < 0.5;
    const lot = this.claim(x, z, swap ? 14 : 46, swap ? 46 : 14, 4);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const wood = 0x7a5a3a, dark = 0x3a3a3a;
    box(-23, 0, -6.5, 23, 0.05, 6.5, 0x9a8a60);
    for (const px of [-22.5, 22.5]) for (const pz of [-3.5, 3.5]) box(px - 0.15, 0, pz - 0.15, px + 0.15, 3.4, pz + 0.15, wood);
    for (const px of [-22.5, 22.5]) box(px - 0.2, 3.0, -3.7, px + 0.2, 3.5, 3.7, 0xd8c040);
    for (const wx of [-19, -16.5]) box(wx - 0.2, 0, -3.5, wx + 0.2, 1.0, 3.5, wood);
    box(-13.2, 0, -3.5, -12.8, 2.2, 3.5, wood);
    box(-14.2, 0, -1, -13.2, 0.8, 1, wood);
    for (let tx = -10; tx < -4; tx += 1) for (let tz = -3; tz <= 3; tz += 2) box(tx + 0.1, 0, tz - 0.4 + (tx % 2 ? 1 : 0) * 0.5, tx + 0.8, 0.3, tz + 0.3 + (tx % 2 ? 1 : 0) * 0.5, dark);
    // Climbing frame: two decks on posts, climbed like steps.
    for (const px of [-2.5, 2.5]) for (const pz of [-2.5, 2.5]) box(px - 0.12, 0, pz - 0.12, px + 0.12, 3.4, pz + 0.12, wood);
    box(-2.5, 1.0, -2.5, 0, 1.15, 2.5, wood);
    box(0, 2.1, -2.5, 2.5, 2.25, 2.5, wood);
    box(-2.5, 3.3, -2.5, 2.5, 3.4, -2.35, wood, false);
    box(-2.5, 3.3, 2.35, 2.5, 3.4, 2.5, wood, false);
    box(5, 0, -0.15, 13, 0.8, 0.15, wood);
    for (const px of [5.2, 12.8]) box(px - 0.2, 0, -0.5, px + 0.2, 0.8, 0.5, wood);
    for (const px of [15, 20]) for (const pz of [-2.5, 2.5]) box(px - 0.08, 0, pz - 0.08, px + 0.08, 0.8, pz + 0.08, wood);
    box(15, 0.75, -2.5, 20, 0.8, 2.5, 0x5a6a4a, false);
    box(-23, 0, 5.4, 23, 0.9, 6.2, 0xb3a274);
    this.lootSpots.push(this.local(x, z, swap, lot.y, 1.2, 2.3, 0), this.local(x, z, swap, lot.y, -15, 0.1, 4.5), this.local(x, z, swap, lot.y, 17.5, 0.1, 0));
    this.footprints.push({ ...lot, color: '#9a8a60' });
    return true;
  }

  /**
   * Blackrock Prison: high walls with four guard towers (two with stairs up), a two-storey cell block,
   * an exercise yard and a guard house by the gate.
   */
  private buildPrison(poi: POI) {
    const rng = this.rng, X = poi.x, Z = poi.z, y = poi.y, S = 30;
    this.inCity = true;
    const box = this.builder(X, Z, false, y), wallC = 0x9a968c, dark = 0x7a766c, t = 1;
    this.wall(box, true, -S, S, S, 0, 6, t, [{ a: -3, b: 3, bottom: 0, top: 4.2, open: true }], wallC);
    this.wall(box, true, -S, S, -S, 0, 6, t, [], wallC);
    this.wall(box, false, -S + t / 2, S - t / 2, -S, 0, 6, t, [], wallC);
    this.wall(box, false, -S + t / 2, S - t / 2, S, 0, 6, t, [], wallC);
    for (const [x0, z0, x1, z1] of [[-S, -S, S, -S], [-S, S, S, S], [-S, -S, -S, S], [S, -S, S, S]]) {
      this.occupied.push({ x0: X + x0 - 1, z0: Z + z0 - 1, x1: X + x1 + 1, z1: Z + z1 + 1 });
      const ax = x0 === x1, s0 = ax ? z0 : x0, s1 = ax ? z1 : x1;
      for (let s = s0; s < s1; s += 2) if (ax) box(x0 - 0.1, 6, s, x0 + 0.1, 6.5, s + 1.6, 0x5a5a5a, false);
      else box(s, 6, z0 - 0.1, s + 1.6, 6.5, z0 + 0.1, 0x5a5a5a, false);
    }
    // Guard towers
    const TH = 8.5;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = sx * (S - 2), cz = sz * (S - 2);
      box(cx - 2.5, 0, cz - 2.5, cx + 2.5, TH, cz + 2.5, dark);
      const segs = [[-2.5, -2.5, 2.5, -2.2], [-2.5, 2.2, 2.5, 2.5], [-2.5, -2.5, -2.2, 2.5], [2.2, -2.5, 2.5, 2.5]];
      if (sx === sz) segs[sz < 0 ? 1 : 0] = sz < 0 ? [0.3, 2.2, 2.5, 2.5] : [-2.5, -2.5, -0.3, -2.2]; // gap where the stairs arrive
      for (const [a, b, c2, d2] of segs) box(cx + a, TH, cz + b, cx + c2, TH + 1.1, cz + d2, dark);
      for (const [px, pz] of [[-2.4, -2.4], [2.1, -2.4], [-2.4, 2.1], [2.1, 2.1]]) box(cx + px, TH + 1.1, cz + pz, cx + px + 0.3, TH + 3, cz + pz + 0.3, 0x5a5a5a, false);
      box(cx - 3, TH + 3, cz - 3, cx + 3, TH + 3.3, cz + 3, 0x4a4a4a);
      box(cx - 0.4, TH + 1.1, cz - 0.4, cx + 0.4, TH + 1.7, cz + 0.4, 0xf0f0d0, false); // searchlight
      this.lootSpots.push(this.local(X, Z, false, y, cx, TH + 0.05, cz));
    }
    // Stairs up the inside of the side walls to the south-west and north-east towers.
    this.stairs(box, -S + t / 2, -S + t / 2 + 1.6, -S + 4.5 + 11.5, -1, 0, TH, dark);
    this.stairs(box, S - t / 2 - 1.6, S - t / 2, S - 4.5 - 11.5, 1, 0, TH, dark);
    // Cell block: corridor along Z, eight cells a side, two floors, stairs in the corridor.
    const bx = -8, bz = -8, bw = 6, bl = 13, H = 3.4, cb = this.builder(X + bx, Z + bz, false, y), c = 0xb0aca0;
    cb(-bw, 0, -bl, bw, 0.1, bl, 0x8a877e);
    for (let f = 0; f < 2; f++) {
      const y0 = f * H;
      this.wall(cb, true, -bw, bw, -bl, y0, H, 0.4, f === 0 ? [{ a: -0.8, b: 0.8, bottom: 0, top: 2.4 }] : this.windowsFor(-bw, bw, 2), c);
      this.wall(cb, true, -bw, bw, bl, y0, H, 0.4, f === 0 ? [{ a: -0.8, b: 0.8, bottom: 0, top: 2.4 }] : this.windowsFor(-bw, bw, 2), c);
      const slits = this.windowsFor(-bl, bl, 8).map((o) => ({ ...o, a: o.a + 0.4, b: o.b - 0.4, bottom: 1.8, top: 2.4, open: true }));
      this.wall(cb, false, -bl + 0.2, bl - 0.2, -bw, y0, H, 0.4, slits, c);
      this.wall(cb, false, -bl + 0.2, bl - 0.2, bw, y0, H, 0.4, slits, c);
      for (const side of [-1, 1]) {
        const gaps: [number, number][] = [];
        for (let k = 0; k < 8; k++) {
          const cz0 = -bl + 0.2 + k * 3.2;
          if (k > 0) this.wall(cb, true, side < 0 ? -bw + 0.2 : 1.5, side < 0 ? -1.5 : bw - 0.2, cz0, y0, H, 0.2, [], c);
          gaps.push([cz0 + 1.1, cz0 + 2.1]);
          cb(side < 0 ? -bw + 0.25 : bw - 1.1, y0, cz0 + 0.3, side < 0 ? -bw + 1.1 : bw - 0.25, y0 + 0.5, cz0 + 2.2, 0x6a6a64);
          if (rng() < 0.25) this.lootSpots.push(this.local(X + bx, Z + bz, false, y, side * 3.5, y0 + 0.12, cz0 + 1.6));
        }
        this.bars(cb, false, -bl + 0.2, bl - 0.2, side * 1.5, y0, 2.6, gaps);
      }
    }
    cb(-bw, H - 0.25, -bl, -1.5, H, bl, 0x8a877e);
    cb(1.5, H - 0.25, -bl, bw, H, bl, 0x8a877e);
    cb(-1.5, H - 0.25, -bl, 1.5, H, 3.5, 0x8a877e);
    cb(-1.5, H - 0.25, 3.5, 0, H, bl, 0x8a877e);
    cb(0, H - 0.25, 8.6, 1.5, H, bl, 0x8a877e);
    this.stairs(cb, 0, 1.45, 3.9, 1, 0, H, 0x6a6a64);
    for (let bxs = -bw; bxs < bw; bxs += 3) cb(bxs, 0, -1.5, bxs + 0.05, 0.05, 1.5, 0xd0c040, false);
    cb(-bw - 0.3, 2 * H, -bl - 0.3, bw + 0.3, 2 * H + 0.35, bl + 0.3, 0x5a5f66);
    this.lootSpots.push(this.local(X + bx, Z + bz, false, y, 0, 0.12, -8), this.local(X + bx, Z + bz, false, y, -0.7, H + 0.05, 0));
    this.footprints.push({ x0: X + bx - bw, z0: Z + bz - bl, x1: X + bx + bw, z1: Z + bz + bl, color: '#b0aca0' });
    // Exercise yard: basketball hoop, benches, weights, and a guard house by the gate.
    box(12, 0, -4, 12.3, 3.2, -3.7, 0x5a5a5a);
    box(11.4, 3.0, -4.4, 12.3, 4.0, -3.5, 0xf0f0f0);
    this.addDecal(X + 4, Z - 10, X + 20, Z + 2, y, 0x8a8a84, 0.04);
    for (const [px, pz] of [[6, 8], [14, 8], [6, 14]]) box(px - 1.6, 0, pz - 0.3, px + 1.6, 0.5, pz + 0.3, 0x6b6b64);
    box(16, 0, 14, 19, 0.9, 15, 0x3a3a3a);
    const gh = this.builder(X + 16, Z + 24, false, y);
    this.wall(gh, true, -4, 4, -3, 0, 3, 0.3, [{ a: -0.7, b: 0.7, bottom: 0, top: 2.3 }, { a: 1.5, b: 3.2, bottom: 1, top: 2.2 }], 0xd8d4c8);
    this.wall(gh, true, -4, 4, 3, 0, 3, 0.3, this.windowsFor(-4, 4, 2), 0xd8d4c8);
    this.wall(gh, false, -2.85, 2.85, -4, 0, 3, 0.3, [{ a: -0.6, b: 0.6, bottom: 1, top: 2.2 }], 0xd8d4c8);
    this.wall(gh, false, -2.85, 2.85, 4, 0, 3, 0.3, [], 0xd8d4c8);
    gh(-4.3, 3, -3.3, 4.3, 3.3, 3.3, 0x4a5040);
    gh(-3.5, 0, 1.6, -1.5, 1.0, 2.7, 0x3a3e44);
    this.vaultSpots.push(new Vector3(X + 18, y + 0.12, Z + 25));
    this.lootSpots.push(new Vector3(X + 14, y + 0.12, Z + 23), new Vector3(X + 10, y + 0.1, Z - 2), new Vector3(X + 18, y + 0.1, Z + 10));
    this.gateBooth(X + 6.5, Z + S + 3, y, true);
    this.footprints.push({ x0: X - S, z0: Z - S, x1: X + S, z1: Z - S + 1, color: '#9a968c' }, { x0: X - S, z0: Z + S - 1, x1: X + S, z1: Z + S, color: '#9a968c' });
    this.footprints.push({ x0: X - S, z0: Z - S, x1: X - S + 1, z1: Z + S, color: '#9a968c' }, { x0: X + S - 1, z0: Z - S, x1: X + S, z1: Z + S, color: '#9a968c' });
    this.occupied.push({ x0: X - S, z0: Z - S, x1: X + S, z1: Z + S });
    for (const [vx, vz] of [[0, S + 10], [S + 8, 0]]) this.addVehicleSpot(X + vx, Z + vz, rng() * 6);
    this.inCity = false;
  }

  /**
   * Naval Docks: a grey warship moored along the shore, reached by a pier and a gangway. The deck,
   * the deckhouse, the bridge on top and the bow gun can all be climbed.
   */
  private buildWarship(poi: POI) {
    const T = this.terrain;
    let best: { dx: number; dz: number; deep: number; shore: number } | null = null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let shore = -1;
      for (let d = poi.radius * 0.4; d < poi.radius + 150; d += 2) {
        const h = T.heightAt(poi.x + dx * d, poi.z + dz * d);
        if (h > 0.6) shore = d;
        else if (h < -1.8 && shore > 0) {
          if (!best || d < best.deep) best = { dx, dz, deep: d, shore };
          break;
        }
      }
    }
    if (!best) return;
    const { dx, dz } = best, off = best.deep + 9;
    const cx = poi.x + dx * off, cz = poi.z + dz * off;
    // Local frame: u along the hull, v out to sea (the pier comes in from -v).
    const swap = dx !== 0, fv = (dx || dz) > 0 ? 1 : -1;
    const inner = this.builder(cx, cz, swap, 0);
    const box = ((u0, y0, v0, u1, y1, v1, c, col) => inner(u0, y0, fv * v0, u1, y1, fv * v1, c, col)) as Builder;
    box.door = (u0, y0, v0, u1, y1, v1) => inner.door(u0, y0, fv * v0, u1, y1, fv * v1);
    box.glass = (u0, y0, v0, u1, y1, v1) => inner.glass(u0, y0, fv * v0, u1, y1, fv * v1);
    box.prop = (k, u0, y0, v0, u1, y1, v1, c) => inner.prop(k, u0, y0, fv * v0, u1, y1, fv * v1, c);
    const at = (u: number, y: number, v: number) => this.local(cx, cz, swap, 0, u, y, fv * v);
    const hull = 0x6a6e72, deck = 0x55595e, light = 0x8a8e92, DY = 3.0;
    box(-32, -3.5, -6, 26, 2.6, 6, hull);
    box(-32, 2.6, -6, 26, DY, 6, deck);
    for (let k = 0; k < 4; k++) box(26 + k * 2, -3.5, -5.2 + k * 1.3, 28 + k * 2, DY, 5.2 - k * 1.3, hull);
    box(-32, DY, 5.7, 34, DY + 0.8, 6, hull);
    box(-32, DY, -6, -5, DY + 0.8, -5.7, hull);
    box(0, DY, -6, 34, DY + 0.8, -5.7, hull);
    box(-32, DY, -6, -31.7, DY + 0.8, 6, hull);
    box(-32.2, -0.5, -6.2, 26, 0.2, 6.2, 0x7a2a24, false); // boot stripe
    // Deckhouse with stairs to its roof, and the bridge on top.
    const d0 = -14, d1 = -2;
    this.wall(box, true, d0, d1, -4, DY, 3, 0.25, [{ a: -9, b: -7.8, bottom: 0, top: 2.3 }, ...this.windowsFor(-6, d1, 1)], light);
    this.wall(box, true, d0, d1, 4, DY, 3, 0.25, [{ a: -9, b: -7.8, bottom: 0, top: 2.3 }], light);
    this.wall(box, false, -3.9, 3.9, d0, DY, 3, 0.25, [], light);
    this.wall(box, false, -3.9, 3.9, d1, DY, 3, 0.25, this.windowsFor(-4, 4, 2), light);
    this.stairs(box, d0 + 0.3, d0 + 1.9, 3.6, -1, DY, 3, 0x4a4e52);
    box(d0 - 0.2, DY + 3 - 0.25, -4.2, d1 + 0.2, DY + 3, -0.6, light);
    box(d0 + 2.1, DY + 3 - 0.25, -0.6, d1 + 0.2, DY + 3, 4.2, light);
    box(d0 - 0.2, DY + 3 - 0.25, -0.6, d0 + 2.1, DY + 3, -0.3, light);
    const b0 = -12, b1 = -5, BY = DY + 3;
    this.wall(box, true, b0, b1, -3, BY, 2.8, 0.2, [{ a: -10.4, b: -9.4, bottom: 0, top: 2.2 }], light);
    this.wall(box, true, b0, b1, 3, BY, 2.8, 0.2, this.windowsFor(b0, b1, 2), light);
    this.wall(box, false, -2.9, 2.9, b0, BY, 2.8, 0.2, [], light);
    this.wall(box, false, -2.9, 2.9, b1, BY, 2.8, 0.2, [{ a: -2.4, b: 2.4, bottom: 1.1, top: 2.3 }], light);
    box(b0 - 0.3, BY + 2.8, -3.3, b1 + 0.3, BY + 3.1, 3.3, deck);
    box(-6.4, BY, -1, -5.4, BY + 1.1, 1, 0x3a3e44); // helm console
    box(-8.3, BY + 3.1, -0.3, -7.7, BY + 11, 0.3, light, false); // mast
    box(-8.2, BY + 8.5, -2.5, -7.8, BY + 8.8, 2.5, light, false);
    box(-8.8, BY + 10, -0.8, -7.2, BY + 10.8, 0.8, 0xe0e0e0, false); // radar
    for (const [x0, x1] of [[d0 - 0.2, d0 + 0.1], [d1 - 0.1, d1 + 0.2]]) box(x0, BY, -4.2, x1, BY + 1, -3.9, light);
    // Funnel, bow gun, lifeboats, a helipad at the stern.
    box(-20, DY, -2, -16, DY + 5.5, 2, light);
    box(-20.1, DY + 5.5, -2.1, -15.9, DY + 6.2, 2.1, 0x2a2a2a);
    box(12, DY, -2.5, 18, DY + 2, 2.5, light);
    box(13, DY + 2, -1.8, 17, DY + 2.8, 1.8, light);
    for (const s of [-0.6, 0.6]) box(17, DY + 1.5 + 0.3, s - 0.18, 25, DY + 1.5 + 0.62, s + 0.18, 0x3a3e44, false);
    for (const s of [-1, 1]) box(-26, DY, s * 4.2 - 0.8, -22, DY + 1.1, s * 4.2 + 0.8, 0xe06a20);
    box(-31, DY, -4.5, -24, DY + 0.02, 4.5, 0x4a4e52, false);
    for (const [u0, v0, u1, v1] of [[-29, -2, -28.4, 2], [-26.6, -2, -26, 2], [-28.4, -0.3, -26.6, 0.3]]) box(u0, DY + 0.02, v0, u1, DY + 0.05, v1, 0xf0f0f0, false);
    for (let i = 0; i < 4; i++) box.prop('crate', 2 + i * 2.2, DY, 3, 3.6 + i * 2.2, DY + 1.3, 4.6, 0x6b7a5a);
    // Pier from the shore to the gangway.
    const pierLen = off - 6 - (best.shore - 4);
    box(-4, 0, -6 - pierLen, -1, 1.2, -8.6, 0x7a6a58);
    for (let p = -8.6; p > -6 - pierLen; p -= 4) for (const s of [-3.8, -1.2]) box(s - 0.2, -3.5, p - 0.2, s + 0.2, 1.2, p + 0.2, 0x5a4a3a);
    this.stairs(box, -3.8, -1.2, -8.6, 1, 1.2, DY - 1.2, 0x7a6a58);
    this.lootSpots.push(at(8, DY + 0.05, -2), at(-26, DY + 0.05, 0), at(-8, DY + 0.1, 0), at(-9, BY + 0.05, 1.5), at(15, DY + 2.85, 0), at(-10, DY + 3.05, -2.5));
    this.vaultSpots.push(at(-12, DY + 0.1, 2.5));
    const p0 = at(-34, 0, -6 - pierLen), p1 = at(34, 0, 6);
    this.occupied.push({ x0: Math.min(p0.x, p1.x), z0: Math.min(p0.z, p1.z), x1: Math.max(p0.x, p1.x), z1: Math.max(p0.z, p1.z) });
    const h0 = at(-32, 0, -6), h1 = at(34, 0, 6);
    this.footprints.push({ x0: Math.min(h0.x, h1.x), z0: Math.min(h0.z, h1.z), x1: Math.max(h0.x, h1.x), z1: Math.max(h0.z, h1.z), color: '#6a6e72' });
    this.landmarks.push({ name: 'Warship', x: cx, z: cz });
  }

  /** The central base: a concrete perimeter wall with gates where the roads come in, and towers on the corners. */
  private baseWall(poi: POI) {
    const S = poi.radius + 10, T = this.terrain, conc = 0x9a978e;
    for (const [alongX, c] of [[true, -S], [true, S], [false, -S], [false, S]] as const) {
      let gateAt: number[] = [];
      for (let s = -S; s < S; s += 4) {
        const mx = poi.x + (alongX ? s + 2 : c), mz = poi.z + (alongX ? c : s + 2);
        if (this.nearRoad(mx, mz, 8) || Math.abs(s + 2) < 6) {
          gateAt.push(s + 2);
          continue;
        }
        const g = T.heightAt(mx, mz);
        if (g < 0.5) continue;
        const r = alongX ? { x0: mx - 2, z0: mz - 0.35, x1: mx + 2, z1: mz + 0.35 } : { x0: mx - 0.35, z0: mz - 2, x1: mx + 0.35, z1: mz + 2 };
        this.addSolid(r.x0, g - 1, r.z0, r.x1, g + 3.2, r.z1, conc);
        this.addSolid(r.x0, g + 3.2, r.z0, r.x1, g + 3.6, r.z1, 0x5a5a5a, false);
        this.occupied.push(r);
        this.footprints.push({ ...r, color: '#9a978e' });
      }
      // One booth per gate.
      gateAt = gateAt.filter((v, i, a) => i === 0 || v - a[i - 1] > 4);
      for (const gv of gateAt) {
        const gx = poi.x + (alongX ? gv : c), gz = poi.z + (alongX ? c : gv);
        const bx = gx + (alongX ? 6.5 : -Math.sign(c) * 3), bz = gz + (alongX ? -Math.sign(c) * 3 : 6.5);
        if (!this.overlapsOccupied({ x0: bx - 1.3, z0: bz - 1.3, x1: bx + 1.3, z1: bz + 1.3 }, 0) && !this.nearRoad(bx, bz, 5.5) && T.heightAt(bx, bz) > 0.5) this.gateBooth(bx, bz, T.heightAt(bx, bz), alongX);
      }
    }
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) this.tryWatchtower(poi.x + sx * (S + 5), poi.z + sz * (S + 5));
  }

  /** A chain-link fence round a military zone, with gaps where the roads come through. */
  private fenceZone(poi: POI) {
    const S = poi.radius + 12, T = this.terrain, steel = 0x8a8f94;
    for (const [alongX, c] of [[true, -S], [true, S], [false, -S], [false, S]] as const) {
      for (let s = -S; s < S; s += 3) {
        const mx = poi.x + (alongX ? s + 1.5 : c), mz = poi.z + (alongX ? c : s + 1.5);
        const r = alongX ? { x0: mx - 1.5, z0: mz - 0.1, x1: mx + 1.5, z1: mz + 0.1 } : { x0: mx - 0.1, z0: mz - 1.5, x1: mx + 0.1, z1: mz + 1.5 };
        if (this.nearRoad(mx, mz, 7) || Math.abs(s + 1.5) < 3 || this.overlapsOccupied(r, 0.3) || !this.inBounds(r)) continue;
        const g = T.heightAt(mx, mz);
        if (g < 1) continue;
        this.addProp('fence', r.x0, g, r.z0, r.x1, g + 1.05, r.z1, steel);
        const px = alongX ? r.x0 : mx, pz = alongX ? mz : r.z0;
        this.addSolid(px - 0.06, g - 0.3, pz - 0.06, px + 0.06, g + 2.3, pz + 0.06, 0x6a6e72);
        for (const wy of [1.5, 1.9, 2.25]) this.addSolid(r.x0, g + wy, r.z0 + (alongX ? 0.06 : 0), r.x1, g + wy + 0.04, r.z1 - (alongX ? 0.06 : 0), 0x5a5e62, false);
        this.occupied.push(r);
      }
    }
  }

  /** Checkpoints on the roads between towns: a guard booth, a boom, jersey barriers in a chicane and sandbag posts. */
  private placeCheckpoints() {
    for (const r of this.roads) {
      const len = Math.hypot(r.x1 - r.x0, r.z1 - r.z0);
      if (len < 100) continue;
      const dx = (r.x1 - r.x0) / len, dz = (r.z1 - r.z0) / len, nx = -dz, nz = dx;
      const x = (r.x0 + r.x1) / 2, z = (r.z0 + r.z1) / 2, y = this.terrain.heightAt(x, z);
      if (y < 1.2 || !this.farFromTowns(x, z, 25) || this.overlapsOccupied({ x0: x - 12, z0: z - 12, x1: x + 12, z1: z + 12 }, 0)) continue;
      const at = (u: number, v: number) => [x + dx * u + nx * v, z + dz * u + nz * v];
      const [bx, bz] = at(0, 7.5);
      const ax = Math.abs(nx) > Math.abs(nz);
      this.gateBooth(bx, bz, this.terrain.heightAt(bx, bz), ax, -Math.sign(ax ? nx : nz));
      for (const [u, v] of [[-4, -2.2], [-4, -3.4], [4, 2.2], [4, 3.4], [4, 1.0], [-4, -1.0]]) {
        const [px, pz] = at(u, v), g = this.terrain.heightAt(px, pz);
        this.addSolid(px - 0.5, g - 0.2, pz - 0.5, px + 0.5, g + 0.9, pz + 0.5, 0xc8c4b8);
        this.occupied.push({ x0: px - 0.5, z0: pz - 0.5, x1: px + 0.5, z1: pz + 0.5 });
      }
      for (const side of [-1, 1]) {
        const [sx, sz] = at(side * 10, -side * 9), g = this.terrain.heightAt(sx, sz), bag = 0xb3a274;
        this.addSolid(sx - 2, g - 0.3, sz - 2, sx + 2, g + 1.1, sz - 1.3, bag);
        this.addSolid(sx - 2, g - 0.3, sz - 1.3, sx - 1.3, g + 1.1, sz + 2, bag);
        this.addSolid(sx + 1.3, g - 0.3, sz - 1.3, sx + 2, g + 1.1, sz + 2, bag);
        this.occupied.push({ x0: sx - 2, z0: sz - 2, x1: sx + 2, z1: sz + 2 });
        this.lootSpots.push(new Vector3(sx, g + 0.1, sz));
      }
      this.landmarks.push({ name: 'Checkpoint', x, z });
    }
  }

  // ---------- themed: western ----------

  /** Wooden water tank on stilts; the catwalk round the tank is reachable by a ladder-stair. */
  private tryWaterTower(x: number, z: number): boolean {
    const rng = this.rng;
    const lot = this.claim(x, z, 7, 7, 4);
    if (!lot) return false;
    const box = this.builder(x, z, false, lot.y);
    const wood = 0x8a6a48, dark = 0x5a3d2a, P = 7;
    for (const [lx, lz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) box(lx - 0.18, 0, lz - 0.18, lx + 0.18, P, lz + 0.18, dark);
    box(-2.6, P, -2.6, 2.6, P + 0.3, 2.6, wood);
    box(-2.1, P + 0.3, -2.1, 2.1, P + 4.3, 2.1, 0x9a7a58);
    box(-2.2, P + 1.3, -2.2, 2.2, P + 1.5, 2.2, 0x3a3a3a, false);
    box(-2.2, P + 3.1, -2.2, 2.2, P + 3.3, 2.2, 0x3a3a3a, false);
    for (let k = 0; k < 3; k++) box(-2.3 + k * 0.7, P + 4.3 + k * 0.5, -2.3 + k * 0.7, 2.3 - k * 0.7, P + 4.8 + k * 0.5, 2.3 - k * 0.7, dark);
    box(0.4, 0, -0.1, 0.6, P, 0.1, 0x6a6a6a, false); // pipe
    this.lootSpots.push(this.local(x, z, false, lot.y, 0, 0.1, 0));
    if (rng() < 0.5) this.barrelSpots.push(this.local(x, z, false, lot.y, 2.8, 0, -1));
    this.footprints.push({ ...lot, color: '#8a6a48' });
    return true;
  }

  /** Covered wagon: canvas top over a wooden bed, good low cover. */
  private tryWagon(x: number, z: number): boolean {
    const rng = this.rng, swap = rng() < 0.5;
    const lot = this.claim(x, z, swap ? 3.6 : 7, swap ? 7 : 3.6, 3);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const wood = 0x7a5a3a, dark = 0x3a2a1a, canvas = 0xe8dcc0;
    for (const wx of [-2, 2]) for (const wz of [-1.25, 1.25]) box(wx - 0.6, 0, wz - 0.08, wx + 0.6, 1.2, wz + 0.08, dark);
    box(-2.6, 0.7, -1.15, 2.6, 1.4, 1.15, wood);
    box(-2.4, 1.4, -1.1, 2.4, 2.4, -0.95, canvas, false);
    box(-2.4, 1.4, 0.95, 2.4, 2.4, 1.1, canvas, false);
    box(-2.4, 2.4, -1.0, 2.4, 2.75, 1.0, canvas, false);
    box(2.6, 0.9, -0.08, 4.2, 1.0, 0.08, wood, false); // tongue
    for (let i = 0; i < randInt(rng, 0, 2); i++) box.prop('crate', -3.6, 0, -0.5 + i * 1.1, -2.8, 0.8, 0.3 + i * 1.1, 0x9a7446);
    this.lootSpots.push(this.local(x, z, swap, lot.y, 0, 1.42, 0));
    this.footprints.push({ ...lot, color: '#b0a080' });
    return true;
  }

  /** Red rock mesa: a stepped butte, with loot on top for anyone who glides in. */
  private tryMesa(x: number, z: number): boolean {
    const rng = this.rng;
    const s = rand(rng, 9, 14);
    const lot = this.claim(x, z, s * 2, s * 2, 8);
    if (!lot) return false;
    const box = this.builder(x, z, false, lot.y);
    const cols = [0xc07a4a, 0xb0683a, 0xd09060], H = rand(rng, 14, 22);
    box(-s, -0.5, -s, s, 3, s, cols[0]);
    box(-s * 0.8, 3, -s * 0.85, s * 0.85, H * 0.6, s * 0.75, cols[1]);
    box(-s * 0.65, H * 0.6, -s * 0.6, s * 0.7, H, s * 0.6, cols[2]);
    box(-s * 0.7, H, -s * 0.65, s * 0.75, H + 0.4, s * 0.65, cols[0]);
    this.lootSpots.push(this.local(x, z, false, lot.y, 0, H + 0.45, 0), this.local(x, z, false, lot.y, s + 1.5, 0.1, 0));
    this.footprints.push({ ...lot, color: '#c07a4a' });
    return true;
  }

  /** Bars: thin posts you can shoot between but not walk through, with gaps for cell doors. */
  private bars(box: Builder, alongX: boolean, s0: number, s1: number, c: number, y0: number, h: number, gaps: [number, number][] = []) {
    const steel = 0x3a3a40;
    for (let s = s0 + 0.15; s < s1 - 0.05; s += 0.3) {
      if (gaps.some(([a, b]) => s > a && s < b)) continue;
      if (alongX) box(s - 0.03, y0, c - 0.03, s + 0.03, y0 + h, c + 0.03, steel);
      else box(c - 0.03, y0, s - 0.03, c + 0.03, y0 + h, s + 0.03, steel);
    }
    if (alongX) box(s0, y0 + h - 0.08, c - 0.05, s1, y0 + h, c + 0.05, steel, false);
    else box(c - 0.05, y0 + h - 0.08, s0, c + 0.05, y0 + h, s1, steel, false);
  }

  /** Stepped gable roof over (x0..x1, z0..z1), ridge along X. */
  private gable(box: Builder, x0: number, x1: number, z0: number, z1: number, y: number, steps: number, color: number) {
    const hd = (z1 - z0) / 2, step = 0.45;
    for (let s = 0; s < steps; s++) {
      const inset = s * (hd / steps) * 0.9;
      box(x0 - 0.4, y + s * step, z0 - 0.5 + inset, x1 + 0.4, y + (s + 1) * step, z1 + 0.5 - inset, color);
    }
  }

  // ---------- themed: wild west buildings ----------

  /** Frontier bank: stone front with columns, a teller counter behind bars, and a walk-in vault with the best loot. */
  private tryBank(x: number, z: number): boolean {
    const rng = this.rng, swap = this.inCity ? false : rng() < 0.5;
    const w = 14, d = 12, hw = w / 2, hd = d / 2, t = 0.4, H = 4.6;
    const lot = this.claim(x, z, swap ? d + 2 : w, swap ? w : d + 2, 4);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const stone = pick(rng, [0xc8b89a, 0xb8a888, 0xd0c0a0]), dark = 0x7a7a80, wood = 0x5a3a22;
    box(-hw, 0, -hd, hw, 0.12, hd, 0x8a7a64);
    this.wall(box, true, -hw, hw, -hd, 0, H, t, [{ a: -5, b: -3, bottom: 1.0, top: 3.0 }, { a: -0.9, b: 0.9, bottom: 0, top: 2.7 }, { a: 3, b: 5, bottom: 1.0, top: 3.0 }], stone);
    this.wall(box, true, -hw, hw, hd, 0, H, t, [], stone);
    this.wall(box, false, -hd + t / 2, hd - t / 2, -hw, 0, H, t, [{ a: -4, b: -2.6, bottom: 1.2, top: 2.8 }], stone);
    this.wall(box, false, -hd + t / 2, hd - t / 2, hw, 0, H, t, [{ a: -3.4, b: -2.2, bottom: 0, top: 2.4 }], stone);
    // Teller counter across the hall with bars on top; the gap at +x leads behind it.
    box(-hw + t / 2, 0, 0.3, hw - 2.6, 1.15, 0.8, wood);
    box(-hw + t / 2, 1.15, 0.25, hw - 2.6, 1.22, 0.85, 0x3a2414);
    this.bars(box, true, -hw + t / 2, hw - 2.6, 0.55, 1.22, 1.3);
    // The vault: thick steel walls in the back corner, round door swung open.
    const vx1 = -hw + 5.8, vz0 = hd - 4.6;
    this.wall(box, true, -hw + t / 2, vx1, vz0, 0, H, 0.6, [{ a: vx1 - 2.4, b: vx1 - 1.1, bottom: 0, top: 2.3, open: true }], dark);
    this.wall(box, false, vz0, hd - t / 2, vx1, 0, H, 0.6, [], dark);
    box(vx1 - 1.1, 0.1, vz0 - 1.6, vx1 - 0.85, 2.3, vz0 - 0.3, 0x8a8a92); // the open vault door
    box(vx1 - 1.2, 1.0, vz0 - 1.1, vx1 - 1.1, 1.4, vz0 - 0.8, 0xc0a040, false); // its wheel
    for (const [gx, gz] of [[-hw + 1, hd - 1.2], [-hw + 1.9, hd - 1.2], [-hw + 1, hd - 2.1]]) {
      box(gx - 0.35, 0.12, gz - 0.2, gx + 0.35, 0.32, gz + 0.2, 0xe0b830);
      box(gx - 0.3, 0.32, gz - 0.15, gx + 0.3, 0.5, gz + 0.15, 0xe8c040);
    }
    box(-hw + t / 2, 0, hd - 4.2, -hw + 0.8, 2.2, hd - 2.6, 0x5a5a60); // deposit boxes
    this.vaultSpots.push(this.local(x, z, swap, lot.y, -hw + 3.2, 0.12, hd - 2.3));
    // Front: parapet, columns by the door, a sign board and steps.
    box(-hw, H, -hd - 0.2, hw, H + 1.8, -hd + 0.3, stone);
    box(-hw - 0.2, H + 1.8, -hd - 0.35, hw + 0.2, H + 2.1, -hd + 0.4, 0x8a7a64);
    box(-hw - 0.2, H, -hd - 0.2, hw + 0.2, H + 0.3, hd + 0.2, 0x6a5a48);
    for (const px of [-1.8, 1.8]) box(px - 0.3, 0, -hd - 0.9, px + 0.3, H, -hd - 0.3, 0xe0d8c8);
    box(-2.4, H - 0.2, -hd - 1.1, 2.4, H + 0.2, -hd - 0.2, 0xe0d8c8);
    box(-3, H + 0.5, -hd - 0.45, 3, H + 1.4, -hd - 0.2, 0x2a3a2a, false);
    box(-2.6, H + 0.8, -hd - 0.5, 2.6, H + 1.1, -hd - 0.44, 0xd8b840, false);
    box(-2.4, 0, -hd - 1.1, 2.4, 0.2, -hd, 0xa89a80);
    this.lootSpots.push(this.local(x, z, swap, lot.y, -2, 0.12, -3), this.local(x, z, swap, lot.y, hw - 1.5, 0.12, 2.5));
    this.footprints.push({ ...lot, color: '#c8b89a' });
    return true;
  }

  /** Two-storey saloon: swinging doors, a long bar to hide behind, stairs up to the rooms and a balcony over the street. */
  private trySaloon(x: number, z: number): boolean {
    const rng = this.rng, swap = this.inCity ? false : rng() < 0.5;
    const w = 16, d = 13, hw = w / 2, hd = d / 2, t = 0.3, H = 3.6;
    const lot = this.claim(x, z, swap ? d + 5 : w, swap ? w : d + 5, 4);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const color = pick(rng, WALL_COLORS), wood = 0x6b4a2f, dark = 0x3a2414;
    box(-hw, 0, -hd, hw, 0.12, hd, 0x7a5a3a);
    // Ground floor
    this.wall(box, true, -hw, hw, -hd, 0, H, t, [{ a: -6, b: -3.6, bottom: 1.0, top: 2.6 }, { a: -1.1, b: 1.1, bottom: 0, top: 2.7, open: true }, { a: 3.6, b: 6, bottom: 1.0, top: 2.6 }], color);
    box(-1.05, 0.7, -hd - 0.05, -0.08, 2.0, -hd + 0.05, 0x8a5a30, false); // swinging doors
    box(0.08, 0.7, -hd - 0.05, 1.05, 2.0, -hd + 0.05, 0x8a5a30, false);
    this.wall(box, true, -hw, hw, hd, 0, H, t, [{ a: -hw + 1.4, b: -hw + 2.6, bottom: 0, top: 2.4 }], color);
    this.wall(box, false, -hd + t / 2, hd - t / 2, -hw, 0, H, t, this.windowsFor(-hd, hd, 2), color);
    this.wall(box, false, -hd + t / 2, hd - t / 2, hw, 0, H, t, this.windowsFor(-hd, 0, 1), color);
    // The bar, the shelves behind it and a piano.
    box(-hw + 1, 0, hd - 2.9, 2, 1.15, hd - 2.3, 0x5a3a22);
    box(-hw + 0.9, 1.15, hd - 3.0, 2.1, 1.25, hd - 2.2, dark);
    box(-hw + 1, 0, hd - 0.6, 2, 2.6, hd - t / 2, 0x5a3a22);
    for (let i = 0; i < 10; i++) box(-hw + 1.3 + i * 0.95, 1.4 + (i % 2) * 0.5, hd - 0.75, -hw + 1.5 + i * 0.95, 1.75 + (i % 2) * 0.5, hd - 0.6, pick(rng, [0x4a8a4a, 0x8a4a2a, 0xc0a060]), false);
    box(hw - 1.2, 0, -hd + 1, hw - t / 2, 1.3, -hd + 2.8, 0x2a1a10);
    for (const [tx, tz] of [[-4.5, -2], [-1.5, 0.5], [2, -2.5]]) {
      box(tx - 0.6, 0, tz - 0.6, tx + 0.6, 0.8, tz + 0.6, wood);
      for (const [sx, sz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) box(tx + sx - 0.2, 0, tz + sz - 0.2, tx + sx + 0.2, 0.45, tz + sz + 0.2, dark);
    }
    // Stairs up along the east wall, and the upper floor with a hole over them.
    const sx0 = hw - 1.9, sx1 = hw - t / 2;
    this.stairs(box, sx0, sx1, hd - t / 2 - 0.1, -1, 0, H, wood);
    const hz0 = hd - 5.6;
    box(-hw, H - 0.25, -hd, sx0, H, hd, 0x7a5a3a);
    box(sx0, H - 0.25, -hd, sx1, H, hz0, 0x7a5a3a);
    // Upper floor: rooms along the back, balcony door at the front.
    this.wall(box, true, -hw, hw, -hd, H, H, t, [{ a: -5.5, b: -3.5, bottom: 1.0, top: 2.4 }, { a: -0.8, b: 0.8, bottom: 0, top: 2.5 }, { a: 3.5, b: 5.5, bottom: 1.0, top: 2.4 }], color);
    this.wall(box, true, -hw, hw, hd, H, H, t, this.windowsFor(-hw, hw, 3), color);
    this.wall(box, false, -hd + t / 2, hd - t / 2, -hw, H, H, t, this.windowsFor(-hd, hd, 2), color);
    this.wall(box, false, -hd + t / 2, hd - t / 2, hw, H, H, t, this.windowsFor(-hd, 0, 1), color);
    this.wall(box, true, -hw + t / 2, sx0 - 0.4, 1.2, H, H, 0.2, [{ a: -5, b: -3.8, bottom: 0, top: 2.3 }, { a: 0.4, b: 1.6, bottom: 0, top: 2.3 }], 0xd8c8a8);
    this.wall(box, false, 1.3, hd - t / 2, -1, H, H, 0.2, [], 0xd8c8a8);
    for (const bx of [-6, 2]) box(bx, H, hd - 2.4, bx + 2, H + 0.6, hd - t / 2, 0xe0d8c8);
    // Balcony on posts over the boardwalk.
    box(-hw, H - 0.25, -hd - 2.3, hw, H, -hd, wood);
    box(-hw, H, -hd - 2.3, hw, H + 1.0, -hd - 2.15, wood);
    box(-hw, H, -hd - 2.3, -hw + 0.15, H + 1.0, -hd, wood);
    box(hw - 0.15, H, -hd - 2.3, hw, H + 1.0, -hd, wood);
    for (const px of [-hw + 0.2, -3.5, 3.5, hw - 0.2]) box(px - 0.12, 0, -hd - 2.3, px + 0.12, H - 0.25, -hd - 2.06, wood);
    box(-hw, 0, -hd - 2.3, hw, 0.25, -hd, 0x7a5a3a); // boardwalk
    // Roof and false front with the sign.
    box(-hw - 0.3, 2 * H, -hd - 0.3, hw + 0.3, 2 * H + 0.3, hd + 0.3, 0x5a3d2a);
    box(-hw, 2 * H + 0.3, -hd - 0.15, hw, 2 * H + 2.6, -hd + 0.15, color);
    box(-hw * 0.65, 2 * H + 0.8, -hd - 0.35, hw * 0.65, 2 * H + 2.1, -hd - 0.15, pick(rng, SIGN_COLORS), false);
    this.lootSpots.push(
      this.local(x, z, swap, lot.y, -3, 0.15, hd - 1.4), this.local(x, z, swap, lot.y, 0, 0.15, -1),
      this.local(x, z, swap, lot.y, -4, H + 0.05, 3), this.local(x, z, swap, lot.y, 3, H + 0.05, 3),
      this.local(x, z, swap, lot.y, 0, H + 0.05, -hd - 1.2),
    );
    this.footprints.push({ ...lot, color: '#a8845a' });
    return true;
  }

  /** Sheriff's office and jail: desk up front, barred cells at the back, a star on the facade. */
  private trySheriff(x: number, z: number): boolean {
    const rng = this.rng, swap = this.inCity ? false : rng() < 0.5;
    const w = 13, d = 10, hw = w / 2, hd = d / 2, t = 0.3, H = 3.6;
    const lot = this.claim(x, z, swap ? d + 4 : w, swap ? w : d + 4, 4);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const color = pick(rng, [0xb89a70, 0xa8845a, 0xc8a878]), wood = 0x6b4a2f;
    box(-hw, 0, -hd, hw, 0.12, hd, 0x8a7458);
    this.wall(box, true, -hw, hw, -hd, 0, H, t, [{ a: -4.5, b: -2.7, bottom: 1.0, top: 2.5 }, { a: -0.8, b: 0.8, bottom: 0, top: 2.5 }, { a: 2.7, b: 4.5, bottom: 1.0, top: 2.5 }], color);
    this.wall(box, true, -hw, hw, hd, 0, H, t, [{ a: 1, b: 2, bottom: 2.2, top: 2.8, open: true }, { a: 4, b: 5, bottom: 2.2, top: 2.8, open: true }], color);
    this.wall(box, false, -hd + t / 2, hd - t / 2, -hw, 0, H, t, [{ a: -2.5, b: -1.3, bottom: 0, top: 2.4 }], color);
    this.wall(box, false, -hd + t / 2, hd - t / 2, hw, 0, H, t, this.windowsFor(-hd, 0, 1), color);
    // Office
    box(-4.5, 0, -2.8, -2.2, 0.85, -1.8, wood);
    box(-3.7, 0, -1.4, -3.0, 0.5, -0.8, 0x3a2a1a);
    box(-hw + t / 2, 1.0, 1.0, -hw + 0.35, 2.2, 3.0, 0x5a3a22, false); // gun rack
    // Cells: two side by side at the back, barred fronts with doors, a partition between.
    this.wall(box, false, 0.8, hd - t / 2, 3, 0, H, 0.2, [], 0x9a8a78);
    this.bars(box, true, -0.5, hw - t / 2, 0.8, 0, 2.5, [[0.4, 1.4], [4.2, 5.2]]);
    this.bars(box, false, 0.8, hd - t / 2, -0.5, 0, 2.5);
    box(1.4, 0.1, 0.8, 1.45, 2.3, -0.1, 0x3a3a40, false); // a cell door swung open
    for (const cx of [1.2, 4.6]) box(cx - 0.9, 0, hd - 1.2, cx + 0.9, 0.5, hd - t / 2, 0x7a6a58);
    // Porch, roof, false front and the star.
    const color2 = 0x5a3d2a;
    box(-hw, 0, -hd - 2, hw, 0.25, -hd, 0x7a5a3a);
    box(-hw - 0.2, 3.0, -hd - 2, hw + 0.2, 3.2, -hd, color2);
    for (const px of [-hw + 0.2, hw - 0.2]) box(px - 0.12, 0.25, -hd - 2, px + 0.12, 3.0, -hd - 1.76, wood);
    box(-hw - 0.3, H, -hd - 0.3, hw + 0.3, H + 0.3, hd + 0.3, color2);
    box(-hw, H + 0.3, -hd - 0.15, hw, H + 2.5, -hd + 0.15, color);
    for (const [sw, sh] of [[0.22, 1.2], [1.2, 0.22], [0.8, 0.8]]) box(-sw / 2, H + 1.4 - sh / 2, -hd - 0.3, sw / 2, H + 1.4 + sh / 2, -hd - 0.15, 0xe0c040, false);
    for (const px of [-4.5, 4.5]) box(px - 0.4, 1.2, -hd - 0.2, px + 0.4, 2.2, -hd - 0.16, 0xe8dcc0, false); // wanted posters
    this.lootSpots.push(
      this.local(x, z, swap, lot.y, -3.3, 0.15, -3.3), this.local(x, z, swap, lot.y, -4, 0.15, 2.5),
      this.local(x, z, swap, lot.y, 1.2, 0.15, 3), this.local(x, z, swap, lot.y, 4.8, 0.15, 3),
    );
    this.footprints.push({ ...lot, color: '#b89a70' });
    return true;
  }

  /** Frontier homestead: porch with a rocking chair, pitched roof, chimney and a fenced yard. */
  private tryWesternHouse(x: number, z: number): boolean {
    const rng = this.rng, swap = rng() < 0.5;
    const w = rand(rng, 8.5, 11), d = rand(rng, 7.5, 9), hw = w / 2, hd = d / 2, t = 0.25, H = 3.2;
    const lot = this.claim(x, z, swap ? d + 7.2 : w + 3.4, swap ? w + 3.4 : d + 7.2, 3);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const color = pick(rng, WALL_COLORS), roof = pick(rng, ROOF_COLORS), wood = 0x6b4a2f, fenceC = 0x8a6a48;
    box(-hw, 0, -hd, hw, 0.15, hd, 0x8a6a48);
    this.wall(box, true, -hw, hw, -hd, 0, H, t, [{ a: -hw + 0.9, b: -hw + 2.3, bottom: 0.9, top: 2.2 }, { a: -0.7, b: 0.7, bottom: 0, top: 2.4 }, { a: hw - 2.3, b: hw - 0.9, bottom: 0.9, top: 2.2 }], color);
    this.wall(box, true, -hw, hw, hd, 0, H, t, rng() < 0.5 ? [{ a: hw - 2, b: hw - 0.9, bottom: 0, top: 2.3 }] : this.windowsFor(-hw, hw, 2), color);
    this.wall(box, false, -hd + t / 2, hd - t / 2, -hw, 0, H, t, this.windowsFor(-hd, hd, 1), color);
    this.wall(box, false, -hd + t / 2, hd - t / 2, hw, 0, H, t, this.windowsFor(-hd, hd, 1), color);
    this.wall(box, false, -hd + t, hd - t, rand(rng, -1, 1), 0, H, 0.18, [{ a: -0.6, b: 0.6, bottom: 0, top: 2.3 }], 0xd8c8a8);
    this.gable(box, -hw, hw, -hd, hd, H, 5, roof);
    box(hw - 1.6, H, 0.4, hw - 0.8, H + 2.9, 1.2, 0x8a5a4a); // chimney
    // Porch
    box(-hw, 0, -hd - 2.4, hw, 0.3, -hd, 0x7a5a3a);
    box(-hw - 0.2, 2.75, -hd - 2.5, hw + 0.2, 2.95, -hd, roof);
    for (const px of [-hw + 0.15, hw - 0.15]) box(px - 0.1, 0.3, -hd - 2.4, px + 0.1, 2.75, -hd - 2.2, wood);
    box(-hw, 0.3, -hd - 2.4, -1.1, 1.1, -hd - 2.3, wood);
    box(1.1, 0.3, -hd - 2.4, hw, 1.1, -hd - 2.3, wood);
    box(-hw + 0.8, 0.3, -hd - 1.6, -hw + 1.5, 1.1, -hd - 0.9, 0x5a3a22); // rocking chair
    // Yard fence with a gate in front, a rain barrel out back.
    const fx = hw + 1.6, fz0 = -hd - 3.5, fz1 = hd + 2.1;
    this.fence(box, true, -fx, -1.3, fz0, fenceC);
    this.fence(box, true, 1.3, fx, fz0, fenceC);
    this.fence(box, true, -fx, fx, fz1, fenceC);
    this.fence(box, false, fz0, fz1, -fx, fenceC);
    this.fence(box, false, fz0, fz1, fx, fenceC);
    box(-hw + 0.3, 0, hd + 0.4, -hw + 1.1, 1.1, hd + 1.2, 0x5a4a3a);
    this.lootSpots.push(this.local(x, z, swap, lot.y, -hw / 2, 0.2, 0), this.local(x, z, swap, lot.y, hw / 2, 0.2, 1));
    this.footprints.push({ ...lot, color: '#b8946a' });
    return true;
  }

  /** Hotel: two or three floors with a tall false front and balconies along the street. */
  private tryHotel(x: number, z: number): boolean {
    const rng = this.rng, floors = rng() < 0.5 ? 2 : 3, color = pick(rng, APARTMENT_COLORS);
    if (!this.tryHouse(x, z, floors, 13, color, true) || !this.lastLot) return false;
    const l = this.lastLot, H = 3.4, top = l.y + floors * H + 0.3, wood = 0x6b4a2f;
    this.addSolid(l.x0 - 0.4, top, l.z0 - 0.55, l.x1 + 0.4, top + 3.2, l.z0 - 0.25, color);
    const cx = (l.x0 + l.x1) / 2, sw = (l.x1 - l.x0) * 0.35;
    this.addSolid(cx - sw, top + 0.9, l.z0 - 0.75, cx + sw, top + 2.4, l.z0 - 0.55, pick(rng, SIGN_COLORS), false);
    for (let f = 1; f < floors; f++) {
      const y = l.y + f * H;
      this.addSolid(l.x0, y - 0.25, l.z0 - 1.8, l.x1, y, l.z0, wood);
      this.addSolid(l.x0, y, l.z0 - 1.8, l.x1, y + 1.0, l.z0 - 1.65, wood);
    }
    for (const px of [l.x0 + 0.2, cx, l.x1 - 0.2]) if (px !== cx) this.addSolid(px - 0.12, l.y, l.z0 - 1.8, px + 0.12, l.y + H - 0.25, l.z0 - 1.56, wood);
    this.addSolid(l.x0, l.y - 0.2, l.z0 - 1.8, l.x1, l.y + 0.25, l.z0, 0x7a5a3a); // boardwalk
    this.footprints[this.footprints.length - 1].color = '#c8a878';
    return true;
  }

  /** Whitewashed church: pews, an altar, and a bell tower whose belfry makes a fine sniper's nest. */
  private tryChurch(x: number, z: number): boolean {
    const rng = this.rng, swap = rng() < 0.5;
    const hw = 4.5, zt0 = -11.2, zt1 = -4.8, zn1 = 11.2, t = 0.3, H = 5;
    const lot = this.claim(x, z, swap ? 24 : 11, swap ? 11 : 24, 4);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const white = 0xe8e0d0, roof = 0x6a4a3a, wood = 0x6b4a2f;
    // Nave
    box(-hw, 0, zt1, hw, 0.15, zn1, 0x9a8a70);
    this.wall(box, true, -hw, hw, zt1, 0, H, t, [{ a: -0.9, b: 0.9, bottom: 0, top: 2.7, open: true }], white);
    this.wall(box, true, -hw, hw, zn1, 0, H, t, [{ a: -0.8, b: 0.8, bottom: 2.6, top: 4.2 }], white);
    const tall = (s0: number, s1: number) => this.windowsFor(s0, s1, 3).map((o) => ({ ...o, bottom: 1.4, top: 3.9 }));
    this.wall(box, false, zt1 + t / 2, zn1 - t / 2, -hw, 0, H, t, [...tall(zt1, zn1), { a: 8.6, b: 9.8, bottom: 0, top: 2.4 }], white);
    this.wall(box, false, zt1 + t / 2, zn1 - t / 2, hw, 0, H, t, tall(zt1, zn1), white);
    for (let pz = -2.5; pz < 7.5; pz += 1.6) {
      for (const [a, b] of [[-3.9, -0.8], [0.8, 3.9]]) {
        box(a, 0, pz, b, 0.48, pz + 0.5, wood);
        box(a, 0.48, pz + 0.4, b, 1.0, pz + 0.5, wood);
      }
    }
    box(-1.3, 0, 9.3, 1.3, 1.0, 10.2, 0xd8d0c0);
    box(-0.08, 1.0, 9.7, 0.08, 1.8, 9.86, 0xc0a040, false);
    box(-0.4, 1.45, 9.7, 0.4, 1.55, 9.86, 0xc0a040, false);
    for (let s = 0; s < 6; s++) {
      const inset = s * 0.78;
      box(-hw - 0.4 + inset, H + s * 0.55, zt1 - 0.2, hw + 0.4 - inset, H + (s + 1) * 0.55, zn1 + 0.4, roof);
    }
    // Bell tower: three flights of switchback stairs up to the belfry.
    const tx = 2.3, F = 3.4, run = 0.45, rise = 0.34, n = 10, L = n * run, zs = zt0 + 0.5;
    const ax0 = -tx + t / 2, ax1 = ax0 + 1.7, bx0 = ax1, bx1 = bx0 + 1.7;
    box(-tx, 0, zt0, tx, 0.15, zt1, 0x9a8a70);
    for (let f = 0; f < 3; f++) {
      const y0 = f * F;
      this.wall(box, true, -tx, tx, zt0, y0, F, t, f === 0 ? [{ a: -0.8, b: 0.8, bottom: 0, top: 2.6 }] : [{ a: -0.4, b: 0.4, bottom: 1.2, top: 2.4, open: true }], white);
      this.wall(box, false, zt0 + t / 2, zt1, -tx, y0, F, t, [{ a: -8.6, b: -7.8, bottom: 1.2, top: 2.4, open: true }], white);
      this.wall(box, false, zt0 + t / 2, zt1, tx, y0, F, t, [{ a: -8.6, b: -7.8, bottom: 1.2, top: 2.4, open: true }], white);
      if (f > 0) this.wall(box, true, -tx, tx, zt1, y0, F, t, [], white);
      for (let i = 0; i < n; i++) {
        if (f % 2 === 0) box(ax0, y0, zs + i * run, ax1, y0 + (i + 1) * rise, zs + (i + 1) * run, wood);
        else box(bx0, y0, zs + L - (i + 1) * run, bx1, y0 + (i + 1) * rise, zs + L - i * run, wood);
      }
    }
    for (let f = 1; f <= 3; f++) {
      const y = f * F, [h0, h1] = (f - 1) % 2 === 0 ? [ax0, ax1] : [bx0, bx1 + 0.3], hz0 = zs - 0.2, hz1 = zs + L + 0.3;
      box(-tx, y - 0.25, zt0, h0, y, zt1, 0x8a7a64);
      box(h1, y - 0.25, zt0, tx, y, zt1, 0x8a7a64);
      box(h0, y - 0.25, zt0, h1, y, hz0, 0x8a7a64);
      box(h0, y - 0.25, hz1, h1, y, zt1, 0x8a7a64);
    }
    // Belfry: waist-high parapet, corner posts, the bell, a pointed roof and a cross.
    const B = 3 * F;
    for (const [x0, z0, x1, z1] of [[-tx, zt0, tx, zt0 + 0.3], [-tx, zt1 - 0.3, tx, zt1], [-tx, zt0, -tx + 0.3, zt1], [tx - 0.3, zt0, tx, zt1]]) box(x0, B, z0, x1, B + 1.0, z1, white);
    for (const [px, pz] of [[-tx, zt0], [tx - 0.4, zt0], [-tx, zt1 - 0.4], [tx - 0.4, zt1 - 0.4]]) box(px, B + 1.0, pz, px + 0.4, B + 3.2, pz + 0.4, white);
    box(-0.1, B + 2.6, -8.1, 0.1, B + 3.2, -7.9, 0x3a3a3a, false);
    box(-0.55, B + 1.8, -8.55, 0.55, B + 2.6, -7.45, 0xb08a30, false);
    for (let s = 0; s < 4; s++) box(-tx - 0.3 + s * 0.6, B + 3.2 + s * 0.7, zt0 - 0.3 + s * 0.6, tx + 0.3 - s * 0.6, B + 3.9 + s * 0.7, zt1 + 0.3 - s * 0.6, roof);
    box(-0.08, B + 6.0, -8.08, 0.08, B + 7.6, -7.92, 0xe0d8c0, false);
    box(-0.45, B + 6.9, -8.08, 0.45, B + 7.05, -7.92, 0xe0d8c0, false);
    this.lootSpots.push(
      this.local(x, z, swap, lot.y, 0.9, B + 0.05, -6), this.local(x, z, swap, lot.y, 0, 0.2, 8.5),
      this.local(x, z, swap, lot.y, -2.4, 0.2, 2), this.local(x, z, swap, lot.y, 0, F + 0.05, -9.5),
    );
    this.footprints.push({ ...lot, color: '#e8e0d0' });
    return true;
  }

  /** Stables with horse stalls and hay, and a fenced corral beside them. */
  private tryStables(x: number, z: number): boolean {
    const rng = this.rng, swap = rng() < 0.5;
    const lot = this.claim(x, z, swap ? 16 : 33, swap ? 33 : 16, 4);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const wood = 0x7a5a3a, dark = 0x5a3d2a, roof = pick(rng, [0x5a3d2a, 0x6b4a2f, 0x4a3a2a]), hay = [0xd8bd68, 0xcfb25a, 0xe0c878];
    const x0 = -15.5, x1 = 0.5, H = 3.4;
    box(x0, 0, -3.5, x1, 0.12, 3.5, 0x8a7458);
    this.wall(box, true, x0, x1, 3.5, 0, H, 0.25, this.windowsFor(x0, x1, 3).map((o) => ({ ...o, bottom: 2.0, top: 2.8, open: true })), wood);
    this.wall(box, false, -3.5, 3.5, x0, 0, H, 0.25, [], wood);
    this.wall(box, false, -3.5, 3.5, x1, 0, H, 0.25, [], wood);
    for (let px = x0 + 0.2; px <= x1; px += 3.2) box(px - 0.12, 0, -3.62, px + 0.12, H, -3.38, dark);
    box(x0 - 0.4, H, -4.4, x1 + 0.4, H + 0.3, 3.9, roof);
    box(x0 - 0.4, H + 0.3, -1, x1 + 0.4, H + 0.8, 3.9, roof);
    for (let k = 1; k < 5; k++) {
      const px = x0 + k * 3.2;
      box(px - 0.1, 0, -1.4, px + 0.1, 1.5, 3.4, dark); // half-height stall walls
    }
    const horse = (hx: number, hz: number, alongX: boolean, c: number) => {
      const L = alongX ? [0.9, 0.35] : [0.35, 0.9];
      box(hx - L[0], 0.9, hz - L[1], hx + L[0], 1.6, hz + L[1], c);
      for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(hx + lx * (L[0] - 0.12) - 0.08, 0, hz + lz * (L[1] - 0.12) - 0.08, hx + lx * (L[0] - 0.12) + 0.08, 0.9, hz + lz * (L[1] - 0.12) + 0.08, c, false);
      const nx = alongX ? hx - 0.9 : hx, nz = alongX ? hz : hz - 0.9;
      box(nx - 0.18, 1.4, nz - 0.18, nx + 0.18, 2.1, nz + 0.18, c, false);
      box(nx - (alongX ? 0.45 : 0.14), 1.95, nz - (alongX ? 0.14 : 0.45), nx + (alongX ? 0.05 : 0.14), 2.25, nz + (alongX ? 0.14 : 0.05), c, false);
      box(nx - 0.05, 1.7, nz - 0.05, nx + 0.05, 2.35, nz + 0.05, 0x2a1a10, false);
    };
    horse(x0 + 1.6, 1.2, false, 0x6a3a1a);
    horse(x0 + 8, 1.2, false, 0x2a2018);
    for (const hx of [x0 + 4.8, x0 + 11.2]) {
      box(hx - 0.8, 0, 2.2, hx + 0.8, 0.9, 3.3, pick(rng, hay));
      box(hx - 0.7, 0, -0.8, hx + 0.5, 0.5, -0.2, 0x6b5a48); // trough
    }
    // Corral
    const cx0 = 1.5, cx1 = 15.5, fc = 0x8a6a48;
    this.fence(box, true, cx0, 7.5, -7, fc);
    this.fence(box, true, 9.5, cx1, -7, fc);
    this.fence(box, true, cx0, cx1, 7, fc);
    this.fence(box, false, -7, 7, cx0, fc);
    this.fence(box, false, -7, 7, cx1, fc);
    box(4, 0, 2, 5.5, 1.0, 3.1, pick(rng, hay));
    box(5.6, 0, 2, 7.1, 1.0, 3.1, pick(rng, hay));
    box(4.8, 1.0, 2, 6.3, 1.9, 3.1, pick(rng, hay));
    box(11, 0, -4.5, 13.5, 0.6, -3.8, 0x6b5a48);
    horse(12, 2.5, true, 0x8a5a2a);
    this.lootSpots.push(this.local(x, z, swap, lot.y, x0 + 4.8, 0.15, 0.8), this.local(x, z, swap, lot.y, x0 + 11.2, 0.15, 0.8), this.local(x, z, swap, lot.y, 8.5, 0.1, -2));
    this.footprints.push({ ...lot, color: '#9a7a50' });
    return true;
  }

  /**
   * Gold mine: a rocky hill with a timbered tunnel through it. A cart track runs in from the entrance to
   * a chamber full of gold (a golden chest every match), and a side tunnel leads out the other flank.
   */
  private tryMine(x: number, z: number): boolean {
    if (this.nearRoad(x, z, 17)) return false;
    const rng = this.rng, swap = rng() < 0.5;
    const lot = this.claim(x, z, swap ? 34 : 30, swap ? 30 : 34, 5);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const rock = [0xb0683a, 0xa86040, 0xc07a4a, 0x9a5a38], timber = 0x6b4a2f, C = 2, ceil = 3.4;
    const void_ = (cx: number, cz: number) =>
      (Math.abs(cx) < 2 && cz > -12 && cz < -2) || (Math.abs(cx) < 6 && cz > -2 && cz < 6) || (cx > 6 && cz > 0 && cz < 4);
    for (let i = 0; i < 14; i++) for (let k = 0; k < 13; k++) {
      const x0 = -14 + i * C, z0 = -12 + k * C, cx = x0 + 1, cz = z0 + 1;
      const dx = cx / 14, dz = (cz - 1) / 13, hh = 2 + 9.5 * Math.max(0, 1 - (dx * dx + dz * dz) * 0.95) + rng() * 0.8;
      const c = pick(rng, rock);
      if (void_(cx, cz)) box(x0, ceil, z0, x0 + C, Math.max(hh, ceil + 1.2), z0 + C, c);
      else box(x0, -0.5, z0, x0 + C, Math.max(hh, 1.4), z0 + C, c);
    }
    // Timber sets along the tunnels, the entrance frame and a sign.
    for (let tz = -11.5; tz < -2; tz += 3) {
      for (const s of [-1.8, 1.8]) box(s - 0.12, 0, tz - 0.12, s + 0.12, ceil, tz + 0.12, timber);
      box(-2, ceil - 0.3, tz - 0.15, 2, ceil, tz + 0.15, timber, false);
    }
    for (let tx = 7.5; tx < 14; tx += 3) {
      for (const s of [0.2, 3.8]) box(tx - 0.12, 0, s - 0.12, tx + 0.12, ceil, s + 0.12, timber);
      box(tx - 0.15, ceil - 0.3, 0, tx + 0.15, ceil, 4, timber, false);
    }
    box(-2.6, 0, -12.6, -2, 4.2, -12, timber);
    box(2, 0, -12.6, 2.6, 4.2, -12, timber);
    box(-2.8, 3.6, -12.7, 2.8, 4.3, -11.9, timber);
    box(-1.8, 4.5, -12.8, 1.8, 5.4, -12.6, 0xd8c8a0, false);
    // Cart track from outside into the chamber, two carts, gold ore and lanterns.
    for (const s of [-0.6, 0.6]) box(s - 0.05, 0, -17, s + 0.05, 0.15, 4, 0x55555c, false);
    for (let tz = -16.5; tz < 4; tz += 1.2) box(-0.9, 0, tz - 0.12, 0.9, 0.08, tz + 0.12, 0x5a4030, false);
    const cart = (cz: number) => {
      box(-0.7, 0.3, cz - 0.9, 0.7, 1.2, cz + 0.9, 0x5a5a60);
      box(-0.6, 1.2, cz - 0.8, 0.6, 1.45, cz + 0.8, 0xd8b030, false);
    };
    cart(-7);
    cart(-15);
    for (const [gx, gz] of [[-4.5, 4], [-3.4, 4.6], [4, 4.8]]) box(gx - 0.5, 0, gz - 0.4, gx + 0.5, 0.5, gz + 0.4, 0xe0b830);
    box(-5.5, 0, -1.5, -4, 1.0, -0.5, 0x9a7446);
    for (const [lx, lz] of [[-1.7, -8], [5.7, 2], [-5.7, 2]]) box(lx - 0.1, 2.2, lz - 0.1, lx + 0.1, 2.5, lz + 0.1, 0xffd070, false);
    // A shack by the entrance.
    this.wall(box, true, -9, -4.5, -16, 0, 2.8, 0.2, [{ a: -7.2, b: -6.2, bottom: 0, top: 2.2 }], 0x8a6a48);
    this.wall(box, true, -9, -4.5, -13.2, 0, 2.8, 0.2, [], 0x8a6a48);
    this.wall(box, false, -16, -13.2, -9, 0, 2.8, 0.2, [], 0x8a6a48);
    this.wall(box, false, -16, -13.2, -4.5, 0, 2.8, 0.2, this.windowsFor(-16, -13.2, 1), 0x8a6a48);
    box(-9.3, 2.8, -16.3, -4.2, 3.05, -12.9, 0x5a3d2a);
    this.vaultSpots.push(this.local(x, z, swap, lot.y, 0, 0.1, 3.5));
    this.lootSpots.push(
      this.local(x, z, swap, lot.y, 0, 0.1, -5), this.local(x, z, swap, lot.y, -3.5, 0.1, 1),
      this.local(x, z, swap, lot.y, 10, 0.1, 2), this.local(x, z, swap, lot.y, -6.7, 0.1, -14.6),
    );
    this.footprints.push({ ...lot, color: '#b0683a' });
    return true;
  }

  /**
   * Railroad Junction: a platform and depot beside the track, where the train stops on its loop.
   */
  private buildStation(poi: POI) {
    const rng = this.rng, y = poi.y + 0.3, box = this.builder(poi.x, poi.z, false, y);
    const was = this.inCity;
    this.inCity = true;
    // The train runs round the loop and stops here, alongside the platform.
    this.trainStops.push({ x: poi.x + 2, z: poi.z });
    // Platform, canopy and depot on the south side.
    const PF = TRAIN_FLOOR;
    box(-22, -0.3, 2.6, 26, PF, 5.9, 0xb0a080);
    for (let i = 0; i < 4; i++) box(26 + i * 0.45, -0.3, 2.6, 26.45 + i * 0.45, PF - (i + 1) * 0.36, 5.9, 0xb0a080);
    for (const px of [-18, -8, 2, 12, 22]) box(px - 0.12, PF, 5.5, px + 0.12, 5.2, 5.74, 0x5a3d2a);
    box(-20, 5.2, 3.0, 24, 5.4, 5.95, 0x6a4a3a);
    const t = 0.25, dH = 3.6, dy = 1.2;
    this.wall(box, true, -10, 10, 6, dy, dH, t, [{ a: -0.8, b: 0.8, bottom: 0, top: 2.5 }, { a: -6, b: -4, bottom: 1.0, top: 2.2 }, { a: 4, b: 6, bottom: 1.0, top: 2.2 }], 0xc8a878);
    this.wall(box, true, -10, 10, 14, dy, dH, t, [{ a: 5, b: 6.2, bottom: 0, top: 2.4 }], 0xc8a878);
    this.wall(box, false, 6 + t / 2, 14 - t / 2, -10, dy, dH, t, this.windowsFor(6, 14, 1), 0xc8a878);
    this.wall(box, false, 6 + t / 2, 14 - t / 2, 10, dy, dH, t, this.windowsFor(6, 14, 1), 0xc8a878);
    box(-10, -0.3, 6, 10, dy, 14, 0x9a8a70);
    box(-10.4, dy + dH, 5.4, 10.4, dy + dH + 0.3, 14.4, 0x5a3d2a);
    box(-4, dy + dH + 0.3, 5.8, 4, dy + dH + 1.5, 6.1, 0x2a3a2a);
    box(-3, dy, 11.5, 3, dy + 1.1, 12.2, 0x6b4a2f); // ticket counter
    for (const bx of [-8, 6]) box(bx, dy, 8, bx + 2, dy + 0.5, 8.6, 0x6b4a2f);
    for (let i = 0; i < 4; i++) box(10.5 + i * 0.45, -0.3, 12.5, 10.95 + i * 0.45, dy - i * 0.3, 13.8, 0x9a8a70); // back steps
    this.lootSpots.push(new Vector3(poi.x - 5, y + dy + 0.05, poi.z + 10), new Vector3(poi.x + 4, y + dy + 0.05, poi.z + 13), new Vector3(poi.x + 16, y + TRAIN_FLOOR + 0.05, poi.z + 4.2));
    this.occupied.push({ x0: poi.x - 26, z0: poi.z - 2.5, x1: poi.x + 29, z1: poi.z + 15 });
    this.footprints.push({ x0: poi.x - 22, z0: poi.z + 1.7, x1: poi.x + 26, z1: poi.z + 5.6, color: '#b0a080' });
    this.footprints.push({ x0: poi.x - 10, z0: poi.z + 6, x1: poi.x + 10, z1: poi.z + 14, color: '#c8a878' });
    void rng;
    this.inCity = was;
  }

  // ---------- themed: amusement park ----------

  /** Three fairground booths side by side under striped awnings. */
  private stallRow(x: number, z: number): boolean {
    const rng = this.rng, swap = rng() < 0.5;
    const lot = this.claim(x, z, swap ? 5.5 : 13, swap ? 13 : 5.5, 3);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    for (const sx of [-4.3, 0, 4.3]) {
      if (rng() < 0.15) continue; // one torn down
      const [a, b] = pick(rng, STRIPES), w = 1.9;
      box(sx - w, 0, -1.6, sx + w, 0.1, 1.9, 0x9a8a78);
      box(sx - w, 0, 1.6, sx + w, 2.6, 1.9, a);
      box(sx - w, 0, -1.6, sx - w + 0.25, 2.6, 1.6, b);
      box(sx + w - 0.25, 0, -1.6, sx + w, 2.6, 1.6, b);
      box(sx - w + 0.25, 0, -1.6, sx + 0.3, 1.05, -1.3, 0x8a6a48); // counter, with a gap to walk in
      for (let k = 0; k < 4; k++) box(sx - w + (k * w) / 2, 2.6, -2.4, sx - w + ((k + 1) * w) / 2, 2.8, 1.9, k % 2 ? b : a);
      box(sx - w + 0.3, 1.3, 1.2, sx + w - 0.3, 1.45, 1.6, 0x6b4a2f); // prize shelf
      this.lootSpots.push(this.local(x, z, swap, lot.y, sx, 0.12, 0.2));
    }
    this.footprints.push({ ...lot, color: '#d98a7a' });
    return true;
  }

  private tryCarousel(x: number, z: number): boolean {
    const rng = this.rng;
    const lot = this.claim(x, z, 15, 15, 3);
    if (!lot) return false;
    const box = this.builder(x, z, false, lot.y);
    const [a, b] = pick(rng, STRIPES), deck = 0xc8b8a0, P = 0.3;
    box(-6, 0, -2.5, 6, P, 2.5, deck);
    box(-2.5, 0, -6, 2.5, P, 6, deck);
    box(-4.4, 0, -4.4, 4.4, P, 4.4, deck);
    box(-1.1, P, -1.1, 1.1, 5.2, 1.1, 0xe8d8b0);
    box(-1.3, 2.2, -1.3, 1.3, 2.8, 1.3, a, false);
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2, hx = Math.cos(ang) * 4.2, hz = Math.sin(ang) * 4.2, up = (i % 2) * 0.4;
      box(hx - 0.06, P, hz - 0.06, hx + 0.06, 5.2, hz + 0.06, 0xe0c060, false);
      box(hx - 0.5, 1.1 + up, hz - 0.2, hx + 0.5, 1.7 + up, hz + 0.2, pick(rng, [0xf0f0f0, 0x8a5a3a, 0xd0a060, 0x404040]));
    }
    for (let k = 0; k < 4; k++) {
      const r = 6.6 - k * 1.5, y = 5.2 + k * 0.6, c = k % 2 ? a : b;
      box(-r, y, -r * 0.42, r, y + 0.6, r * 0.42, c);
      box(-r * 0.42, y, -r, r * 0.42, y + 0.6, r, c);
      box(-r * 0.72, y, -r * 0.72, r * 0.72, y + 0.6, r * 0.72, c);
    }
    box(-0.2, 7.6, -0.2, 0.2, 8.8, 0.2, 0xe0c060, false);
    this.lootSpots.push(this.local(x, z, false, lot.y, 2.5, P + 0.05, 0), this.local(x, z, false, lot.y, -1.8, P + 0.05, 1.8));
    this.footprints.push({ ...lot, color: '#e0b060' });
    return true;
  }

  private tryBumperCars(x: number, z: number): boolean {
    const rng = this.rng, swap = rng() < 0.5;
    const lot = this.claim(x, z, swap ? 15 : 20, swap ? 20 : 15, 3);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const [a, b] = pick(rng, STRIPES), rail = 0xd0c0a0;
    box(-9, 0, -6.5, 9, 0.12, 6.5, 0x4a4a52);
    box(-9, 0, -6.5, -2, 0.7, -6.2, rail);
    box(2, 0, -6.5, 9, 0.7, -6.2, rail);
    box(-9, 0, 6.2, 9, 0.7, 6.5, rail);
    box(-9, 0, -6.2, -8.7, 0.7, 6.2, rail);
    box(8.7, 0, -6.2, 9, 0.7, 1, rail);
    box(8.7, 0, 3, 9, 0.7, 6.2, rail);
    for (const [px, pz] of [[-9, -6.5], [9, -6.5], [-9, 6.5], [9, 6.5], [0, -6.5], [0, 6.5]]) box(px - 0.2, 0.7, pz - 0.2, px + 0.2, 4.6, pz + 0.2, 0xb0a090);
    box(-9.4, 4.6, -6.9, 9.4, 4.9, 6.9, 0x6a6a72);
    for (let k = 0; k < 10; k++) {
      const s0 = -9.4 + k * 1.88, c = k % 2 ? a : b;
      box(s0, 4.1, -6.95, s0 + 1.88, 4.6, -6.75, c, false);
      box(s0, 4.1, 6.75, s0 + 1.88, 4.6, 6.95, c, false);
    }
    for (let i = 0; i < 7; i++) {
      const cx = rand(rng, -7, 7), cz = rand(rng, -4.5, 4.5);
      box(cx - 0.9, 0.12, cz - 0.6, cx + 0.9, 0.75, cz + 0.6, pick(rng, CAR_COLORS));
      box(cx - 0.04, 0.75, cz - 0.04, cx + 0.04, 4.6, cz + 0.04, 0x888888, false);
    }
    for (let i = 0; i < 3; i++) this.lootSpots.push(this.local(x, z, swap, lot.y, rand(rng, -7, 7), 0.15, rand(rng, -5, 5)));
    this.footprints.push({ ...lot, color: '#6a6a72' });
    return true;
  }

  private tryDropTower(x: number, z: number): boolean {
    const rng = this.rng;
    const lot = this.claim(x, z, 8, 8, 5);
    if (!lot) return false;
    const box = this.builder(x, z, false, lot.y);
    const [a, b] = pick(rng, STRIPES), H = rand(rng, 34, 44);
    box(-3.5, 0, -3.5, 3.5, 0.3, 3.5, 0x9a948a);
    for (let y = 0.3, i = 0; y < H; y += 4, i++) box(-1.1, y, -1.1, 1.1, Math.min(H, y + 4), 1.1, i % 2 ? a : b);
    // The seat ring, dropped all the way down and stuck there.
    box(-3, 0.3, -3, 3, 1.1, -1.1, a);
    box(-3, 0.3, 1.1, 3, 1.1, 3, a);
    box(-3, 0.3, -1.1, -1.1, 1.1, 1.1, a);
    box(1.1, 0.3, -1.1, 3, 1.1, 1.1, a);
    box(-2.4, H, -2.4, 2.4, H + 1.2, 2.4, b);
    box(-0.15, H + 1.2, -0.15, 0.15, H + 4, 0.15, 0xdddddd, false);
    this.lootSpots.push(this.local(x, z, false, lot.y, 2, 1.15, 2));
    this.footprints.push({ ...lot, color: '#c05050' });
    return true;
  }

  /** Striped circus tent with two entrances, a ring and bleachers inside. */
  private tryBigTop(x: number, z: number): boolean {
    const rng = this.rng;
    const lot = this.claim(x, z, 26, 26, 4);
    if (!lot) return false;
    const box = this.builder(x, z, false, lot.y);
    const S = 11, H = 4.5, st = 2.2, [a, b] = pick(rng, STRIPES);
    box(-S, 0, -S, S, 0.1, S, 0xb09a70);
    for (let s = -S, i = 0; s < S - 0.01; s += st, i++) {
      const c = i % 2 ? a : b, e = s + st, door = Math.abs(s + st / 2) < 2.3;
      box(s, door ? 3.2 : 0, -S, e, H, -S + 0.3, c);
      box(s, door ? 3.2 : 0, S - 0.3, e, H, S, c);
      box(-S, 0, s, -S + 0.3, H, e, c);
      box(S - 0.3, 0, s, S, H, e, c);
    }
    for (let k = 0; k < 6; k++) {
      const r = S + 0.6 - k * 2, y = H + k * 1.25;
      for (let s = -r, i = 0; s < r - 0.01; s += st, i++) box(s, y, -r, Math.min(r, s + st), y + 1.25, r, (i + k) % 2 ? a : b);
    }
    box(-0.25, 0, -0.25, 0.25, 14, 0.25, 0xd8c8a8);
    box(0.25, 12.8, -0.05, 1.8, 13.8, 0.05, a, false);
    for (let i = 0; i < 14; i++) {
      const ang = (i / 14) * Math.PI * 2, cx = Math.cos(ang) * 5, cz = Math.sin(ang) * 5;
      box(cx - 0.5, 0, cz - 0.5, cx + 0.5, 0.45, cz + 0.5, 0xc04040);
    }
    for (const side of [-1, 1]) for (let k = 0; k < 3; k++) {
      const x0 = side * (S - 0.3), x1 = side * (S - 0.3 - (3 - k));
      box(Math.min(x0, x1), 0, -6, Math.max(x0, x1), (k + 1) * 0.6, 6, 0x8a6a48);
    }
    this.lootSpots.push(
      this.local(x, z, false, lot.y, 0, 0.15, -7.5), this.local(x, z, false, lot.y, -2.5, 0.15, 2.5),
      this.local(x, z, false, lot.y, 2.5, 0.15, -2), this.local(x, z, false, lot.y, 0, 0.15, 7.5),
      this.local(x, z, false, lot.y, S - 0.8, 1.85, 0),
    );
    this.footprints.push({ ...lot, color: '#d04848' });
    return true;
  }

  /** The Sky Wheel: a giant Ferris wheel, one gondola fallen off. */
  private buildFerrisWheel(x: number, z: number): boolean {
    const rng = this.rng, swap = rng() < 0.5;
    const R = 15, C = R + 3.5;
    const lot = this.claim(x, z, swap ? 9 : 36, swap ? 36 : 9, 4);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const steel = 0xd8d8d0, cols = STRIPES.map((s) => s[0]);
    for (const lz of [-2.6, 2.6]) for (const sx of [-1, 1]) {
      const n = 24;
      for (let i = 0; i < n; i++) {
        const xa = sx * 9 * (1 - i / n), xb = sx * 9 * (1 - (i + 1) / n);
        box(Math.min(xa, xb) - 0.3, (C * i) / n, lz - 0.3, Math.max(xa, xb) + 0.3, (C * (i + 1)) / n, lz + 0.3, steel);
      }
    }
    box(-1, C - 1, -2.9, 1, C + 1, 2.9, 0x8a8a90);
    for (let i = 0; i < 90; i++) {
      const ang = (i / 90) * Math.PI * 2, rx = Math.cos(ang) * R, ry = C + Math.sin(ang) * R;
      for (const lz of [-1.3, 1.3]) box(rx - 0.55, ry - 0.55, lz - 0.2, rx + 0.55, ry + 0.55, lz + 0.2, steel, false);
    }
    for (let k = 0; k < 12; k++) {
      const ang = (k / 12) * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
      for (let d = 1.5; d < R; d += 1.1) for (const lz of [-1.3, 1.3]) box(ca * d - 0.18, C + sa * d - 0.18, lz - 0.12, ca * d + 0.18, C + sa * d + 0.18, lz + 0.12, steel, false);
      if (k === 7) continue;
      const gx = ca * R, gy = C + sa * R, c = cols[k % cols.length];
      box(gx - 0.06, gy - 1.4, -0.06, gx + 0.06, gy, 0.06, 0x888888, false);
      box(gx - 1.1, gy - 2.4, -1.0, gx + 1.1, gy - 1.4, 1.0, c);
      box(gx - 1.2, gy - 0.6, -1.1, gx + 1.2, gy - 0.4, 1.1, c, false);
    }
    box(11, 0, -1, 13.2, 1.0, 1, cols[7 % cols.length]); // the fallen gondola
    box(-13.2, 0, -1.5, -10.6, 2.6, 1.5, cols[0]); // ticket booth
    box(-13.5, 2.6, -1.8, -10.3, 2.8, 1.8, cols[1]);
    this.lootSpots.push(
      this.local(x, z, swap, lot.y, 0, 0.1, 0), this.local(x, z, swap, lot.y, 12, 1.05, 0),
      this.local(x, z, swap, lot.y, -11.8, 0.1, 2.6), this.local(x, z, swap, lot.y, 6, 0.1, -3.8),
    );
    this.footprints.push({ ...lot, color: '#d8d8d0' });
    return true;
  }

  /** A roller coaster looping round the edge of Coaster Canyon, with a lift hill and a station. */
  private buildCoaster(poi: POI) {
    const X = poi.x, Z = poi.z, y0 = poi.y, A = poi.radius * 0.86, B = poi.radius * 0.78;
    const TAU = Math.PI * 2, station = 4.32;
    const pos = (t: number) => {
      const r = 1 + 0.07 * Math.sin(3 * t + 1);
      const lift = Math.exp(-((t - 1.2) ** 2) / 0.12) * 15;
      const dip = Math.exp(-((t - station) ** 2) / 0.1) * 5;
      return new Vector3(X + Math.cos(t) * A * r, y0 + Math.max(0.5, 7 + 3 * Math.sin(4 * t) + lift - dip), Z + Math.sin(t) * B * r);
    };
    const N = 950, pts: Vector3[] = [];
    for (let i = 0; i < N; i++) pts.push(pos((i / N) * TAU));
    const rail = 0xc03a3a, spine = 0x6b5a4a, sup = 0x9a9aa0;
    const normal = (i: number) => {
      const p = pts[i], q = pts[(i + 1) % N], l = Math.hypot(q.x - p.x, q.z - p.z) || 1;
      return [-(q.z - p.z) / l, (q.x - p.x) / l];
    };
    for (let i = 0; i < N; i++) {
      const p = pts[i], [nx, nz] = normal(i);
      for (const s of [-0.75, 0.75]) this.addSolid(p.x + s * nx - 0.22, p.y - 0.15, p.z + s * nz - 0.22, p.x + s * nx + 0.22, p.y + 0.15, p.z + s * nz + 0.22, rail, false);
      if (i % 3 === 0) this.addSolid(p.x - 0.18, p.y - 0.4, p.z - 0.18, p.x + 0.18, p.y - 0.15, p.z + 0.18, spine, false);
      if (i % 22 === 0 && p.y - y0 > 1.6 && !this.nearRoad(p.x, p.z, 5)) {
        this.addSolid(p.x - 0.3, y0 - 0.3, p.z - 0.3, p.x + 0.3, p.y - 0.4, p.z + 0.3, sup);
        this.occupied.push({ x0: p.x - 1, z0: p.z - 1, x1: p.x + 1, z1: p.z + 1 });
      }
      if (i % 10 === 0) this.footprints.push({ x0: p.x - 0.8, z0: p.z - 0.8, x1: p.x + 0.8, z1: p.z + 0.8, color: '#c03a3a' });
    }
    // Station: a platform beside the track and the train parked in it.
    const si = Math.round((station / TAU) * N);
    for (let d = -14; d <= 14; d += 4) {
      const i = (si + d + N) % N, p = pts[i], [nx, nz] = normal(i), cx = p.x + nx * 2.4, cz = p.z + nz * 2.4;
      this.addSolid(cx - 1.4, y0 - 0.3, cz - 1.4, cx + 1.4, y0 + 0.6, cz + 1.4, 0xb0a090);
      this.occupied.push({ x0: cx - 1.4, z0: cz - 1.4, x1: cx + 1.4, z1: cz + 1.4 });
    }
    STRIPES.slice(0, 4).forEach(([c], k) => {
      const p = pts[(si - 9 + k * 6 + N) % N];
      this.addSolid(p.x - 0.85, p.y + 0.15, p.z - 0.85, p.x + 0.85, p.y + 1.05, p.z + 0.85, c);
    });
    for (const d of [-8, 8]) {
      const i = (si + d + N) % N, p = pts[i], [nx, nz] = normal(i);
      this.lootSpots.push(new Vector3(p.x + nx * 2.4, y0 + 0.65, p.z + nz * 2.4));
    }
    this.landmarks.push({ name: 'Coaster', x: pts[Math.round((1.2 / TAU) * N)].x, z: pts[Math.round((1.2 / TAU) * N)].z });
  }

  /** Dark, peeling house with a crooked turret. */
  private tryHauntedHouse(x: number, z: number): boolean {
    const rng = this.rng;
    const floors = rng() < 0.6 ? 2 : 3;
    if (!this.tryHouse(x, z, floors, 99, pick(rng, [0x4a4450, 0x3e3a44, 0x5a4a44, 0x46504a])) || !this.lastLot) return false;
    const l = this.lastLot, tx = l.x1 + 1.3, tz = l.z0 + 1.3, top = l.y + floors * 3.4 + 3;
    const rect = { x0: tx - 1.3, z0: tz - 1.3, x1: tx + 1.3, z1: tz + 1.3 };
    if (!this.overlapsOccupied(rect, 0) && this.inBounds(rect)) {
      this.occupied.push(rect);
      this.addSolid(tx - 1.2, l.y - 0.4, tz - 1.2, tx + 1.2, top, tz + 1.2, 0x3a3640);
      for (let k = 0; k < 4; k++) {
        const r = 1.6 - k * 0.4;
        this.addSolid(tx - r, top + k * 0.8, tz - r, tx + r, top + (k + 1) * 0.8, tz + r, 0x2a2430, false);
      }
      this.addSolid(tx + 1.2, top - 2.2, tz - 0.35, tx + 1.27, top - 1.4, tz + 0.35, 0xe0c060, false);
    }
    for (let i = 0; i < 2; i++) {
      const ang = rng() * Math.PI * 2, dx = x + Math.cos(ang) * 10, dz = z + Math.sin(ang) * 10;
      if (!this.overlapsOccupied({ x0: dx - 0.5, z0: dz - 0.5, x1: dx + 0.5, z1: dz + 0.5 }, 0.5) && !this.nearRoad(dx, dz, 4)) this.addTree(dx, dz, 2, 5);
    }
    return true;
  }

  // ---------- landmarks ----------

  private farFromTowns(x: number, z: number, margin: number) {
    return !this.pois.some((p) => Math.hypot(p.x - x, p.z - z) < p.radius + margin);
  }

  private placeLandmarks() {
    const rng = this.rng;
    const tryN = (want: number, attempts: number, fn: (x: number, z: number) => boolean, pickSpot?: () => [number, number] | null) => {
      let n = 0;
      for (let i = 0; i < attempts && n < want; i++) {
        const s = pickSpot ? pickSpot() : [rand(rng, -440, 440), rand(rng, -440, 440)] as [number, number];
        if (s && this.farFromTowns(s[0], s[1], 30) && fn(s[0], s[1])) n++;
      }
    };
    // Wind turbines line the high ground.
    tryN(10, 400, (x, z) => this.tryWindTurbine(x, z), () => {
      const x = rand(rng, -440, 440), z = rand(rng, -440, 440);
      return this.terrain.heightAt(x, z) > 11 ? [x, z] : null;
    });
    // Lighthouses on the coast
    tryN(3, 300, (x, z) => this.tryLighthouse(x, z), () => {
      const a = rng() * Math.PI * 2, r = this.half - rand(rng, 26, 50);
      const [x, z] = [Math.cos(a) * r, Math.sin(a) * r];
      const h = this.terrain.heightAt(x, z);
      return h > 0.9 && h < 8 ? [x, z] : null;
    });
    tryN(12, 300, (x, z) => this.tryWatchtower(x, z));
    if (THEME === 'military') {
      tryN(5, 300, (x, z) => this.tryRadarDome(x, z));
      tryN(8, 300, (x, z) => this.tryTank(x, z));
      tryN(1, 300, (x, z) => this.tryMissileSilo(x, z) && this.landmarks.push({ name: 'Missile Silo', x, z }) > 0);
      tryN(1, 300, (x, z) => this.tryCommandBunker(x, z) && this.landmarks.push({ name: 'Command Bunker', x, z }) > 0);
      tryN(2, 300, (x, z) => this.tryHangar(x, z) && this.landmarks.push({ name: 'Hangar', x, z }) > 0);
    } else if (THEME === 'western') {
      tryN(6, 300, (x, z) => this.tryWaterTower(x, z));
      tryN(10, 300, (x, z) => this.tryWagon(x, z));
      tryN(7, 400, (x, z) => this.tryMesa(x, z));
      tryN(2, 300, (x, z) => this.tryChurch(x, z) && this.landmarks.push({ name: 'Chapel', x, z }) > 0);
      tryN(1, 300, (x, z) => this.tryMine(x, z) && this.landmarks.push({ name: 'Lost Mine', x, z }) > 0);
    } else if (THEME === 'world') {
      tryN(2, 300, (x, z) => this.tryMine(x, z) && this.landmarks.push({ name: 'Caves', x, z }) > 0);
      tryN(1, 300, (x, z) => this.tryHangar(x, z) && this.landmarks.push({ name: 'Hangar', x, z }) > 0);
      tryN(1, 300, (x, z) => this.tryCommandBunker(x, z) && this.landmarks.push({ name: 'Bunker', x, z }) > 0);
      tryN(2, 300, (x, z) => this.tryDropTower(x, z) && this.landmarks.push({ name: 'Drop Tower', x, z }) > 0);
      tryN(4, 300, (x, z) => this.tryTank(x, z));
      tryN(1, 300, (x, z) => this.tryPlaneWreck(x, z));
    } else if (THEME === 'park') {
      tryN(3, 300, (x, z) => this.tryDropTower(x, z) && this.landmarks.push({ name: 'Drop Tower', x, z }) > 0);
      tryN(1, 300, (x, z) => this.tryBigTop(x, z) && this.landmarks.push({ name: 'Circus', x, z }) > 0);
    }
    tryN(7, 300, (x, z) => this.tryCampsite(x, z));
    tryN(2, 300, (x, z) => this.tryPlaneWreck(x, z));
    // Stone circles on two of the peaks
    for (const m of [MOUNTAINS[1], MOUNTAINS[3]]) {
      for (let i = 0; i < 20; i++) if (this.tryStoneCircle(m.x + rand(rng, -12, 12), m.z + rand(rng, -12, 12))) break;
    }
    // Launch pads: one near every town, plus some out in the wild.
    for (const p of this.pois) {
      for (let i = 0; i < 30; i++) {
        const a = rng() * Math.PI * 2, d = p.radius * rand(rng, 0.35, 0.95);
        if (this.tryLaunchPad(p.x + Math.cos(a) * d, p.z + Math.sin(a) * d)) break;
      }
    }
    tryN(9, 300, (x, z) => this.tryLaunchPad(x, z));

    // Vehicles park along the roads and in every town.
    for (const r of this.roads) {
      const len = Math.hypot(r.x1 - r.x0, r.z1 - r.z0);
      const dx = (r.x1 - r.x0) / len, dz = (r.z1 - r.z0) / len;
      for (let d = 40; d < len - 30; d += rand(rng, 110, 170)) {
        const side = rng() < 0.5 ? -1 : 1;
        const x = r.x0 + dx * d - dz * 6.5 * side, z = r.z0 + dz * d + dx * 6.5 * side;
        this.addVehicleSpot(x, z, Math.atan2(-dx, -dz));
      }
    }
    for (const p of this.pois) {
      for (let i = 0; i < 10; i++) {
        const a = rng() * Math.PI * 2, d = p.radius * rand(rng, 0.2, 0.7);
        if (this.addVehicleSpot(p.x + Math.cos(a) * d, p.z + Math.sin(a) * d, rng() * Math.PI * 2)) break;
      }
    }
  }

  private addVehicleSpot(x: number, z: number, yaw: number) {
    const rect = { x0: x - 2.6, z0: z - 2.6, x1: x + 2.6, z1: z + 2.6 };
    const y = this.terrain.heightAt(x, z);
    if (!this.inBounds(rect) || this.overlapsOccupied(rect, 0.5) || y < 0.8) return false;
    this.occupied.push(rect);
    this.vehicleSpots.push({ x, y, z, yaw });
    return true;
  }

  private tryWindTurbine(x: number, z: number): boolean {
    const lot = this.claim(x, z, 4, 4, 10);
    if (!lot) return false;
    const box = this.builder(x, z, false, lot.y);
    box(-2, -0.5, -2, 2, 0.6, 2, 0xb5b5ad);
    box(-0.7, 0.6, -0.7, 0.7, 30, 0.7, 0xf2f2f0);
    box(-0.5, 30, -0.5, 0.5, 31.4, 0.5, 0xf2f2f0, false);
    this.turbineSpots.push({ x, y: lot.y + 31, z, yaw: this.rng() * Math.PI * 2 });
    this.footprints.push({ ...lot, color: '#e8e8e8' });
    return true;
  }

  private tryLighthouse(x: number, z: number): boolean {
    const lot = this.claim(x, z, 8, 8, 20);
    if (!lot) return false;
    const box = this.builder(x, z, false, lot.y);
    box(-4, -1, -4, 4, 0.4, 4, 0x9a948a);
    const seg = [4.2, 3.9, 3.6, 3.3, 3.0];
    seg.forEach((w, i) => box(-w / 2, 0.4 + i * 4.5, -w / 2, w / 2, 0.4 + (i + 1) * 4.5, w / 2, i % 2 ? 0xd9382c : 0xf4f4f0));
    const top = 0.4 + seg.length * 4.5;
    box(-2.6, top, -2.6, 2.6, top + 0.3, 2.6, 0x3a3f45);
    box(-1.3, top + 0.3, -1.3, 1.3, top + 2.8, 1.3, 0xfff1b0);
    box(-1.6, top + 2.8, -1.6, 1.6, top + 3.3, 1.6, 0xd9382c);
    this.lighthouseSpots.push(new Vector3(x, lot.y + top + 1.6, z));
    // Keeper's hut
    const t = 0.25;
    this.wall(box, true, 4.8, 9.5, -2, 0, 3, t, [{ a: 6.4, b: 7.8, bottom: 0, top: 2.4 }], 0xf4f1ea);
    this.wall(box, true, 4.8, 9.5, 2, 0, 3, t, this.windowsFor(4.8, 9.5, 1), 0xf4f1ea);
    this.wall(box, false, -2 + t / 2, 2 - t / 2, 9.5, 0, 3, t, [], 0xf4f1ea);
    box(4.6, 3, -2.2, 9.7, 3.3, 2.2, 0x3d6b8c);
    this.lootSpots.push(this.local(x, z, false, lot.y, 7.2, 0.12, 0), this.local(x, z, false, lot.y, 0, 0.5, 3.5));
    this.landmarks.push({ name: 'Lighthouse', x, z });
    this.footprints.push({ ...lot, color: '#d9382c' });
    return true;
  }

  /** Sniper perch: wooden platform reached by a steep stair. */
  private tryWatchtower(x: number, z: number): boolean {
    const swap = this.rng() < 0.5;
    const lot = this.claim(x, z, swap ? 9.6 : 4.8, swap ? 4.8 : 9.6, 5);
    if (!lot) return false;
    const box = this.builder(x, z, swap, lot.y);
    const wood = 0x8a6a48, dark = 0x6b4a2f, P = 7;
    for (const [lx, lz] of [[-2.1, -4.6], [2.1, -4.6], [-2.1, -0.4], [2.1, -0.4]]) {
      box(lx - 0.15, -0.3, lz - 0.15, lx + 0.15, P - 0.3, lz + 0.15, dark);
      box(lx - 0.1, P, lz - 0.1, lx + 0.1, P + 2.6, lz + 0.1, dark);
    }
    box(-2.3, P - 0.3, -4.8, 2.3, P, -0.2, wood);
    box(-2.3, P, -4.8, 2.3, P + 1, -4.7, wood);
    box(-2.3, P, -4.7, -2.2, P + 1, -0.2, wood);
    box(2.2, P, -4.7, 2.3, P + 1, -0.2, wood);
    box(-2.3, P, -0.3, -0.8, P + 1, -0.2, wood);
    box(0.8, P, -0.3, 2.3, P + 1, -0.2, wood);
    box(-2.7, P + 2.6, -5.2, 2.7, P + 2.85, 0.2, 0x5a3d33);
    const n = 14, run = 0.33, rise = P / n;
    for (let k = 0; k < n; k++) box(-0.7, -0.3, 4.4 - (k + 1) * run, 0.7, (k + 1) * rise, 4.4 - k * run, wood);
    this.lootSpots.push(this.local(x, z, swap, lot.y, 0, P + 0.05, -2.5));
    this.footprints.push({ ...lot, color: '#8a6a48' });
    return true;
  }

  private tryCampsite(x: number, z: number): boolean {
    const rng = this.rng;
    const lot = this.claim(x, z, 12, 12, 4);
    if (!lot) return false;
    const box = this.builder(x, z, false, lot.y);
    this.addDecal(x - 1.2, z - 1.2, x + 1.2, z + 1.2, lot.y, 0x3a3430, 0.04);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      box(Math.cos(a) * 1.1 - 0.2, 0, Math.sin(a) * 1.1 - 0.2, Math.cos(a) * 1.1 + 0.2, 0.3, Math.sin(a) * 1.1 + 0.2, 0x7a7f86);
    }
    this.fireSpots.push(new Vector3(x, lot.y + 0.2, z));
    box(-3.2, 0, -0.3, -2.4, 0.45, 1.5, 0x6b4a2f); // log benches
    box(2.4, 0, -1.5, 3.2, 0.45, 0.3, 0x6b4a2f);
    const tents = randInt(rng, 2, 3);
    const colors = [0x2f7fd1, 0xf0a030, 0x2fa36b, 0xd9382c];
    for (let i = 0; i < tents; i++) {
      const a = (i / tents) * Math.PI * 2 + 0.6, tx = Math.cos(a) * 4, tz = Math.sin(a) * 4;
      for (let k = 0; k < 3; k++) {
        const w = 1.3 - k * 0.42;
        box(tx - w, k * 0.55, tz - 1.4, tx + w, (k + 1) * 0.55, tz + 1.4, colors[i % colors.length]);
      }
      this.lootSpots.push(this.local(x, z, false, lot.y, tx * 0.55, 0.1, tz * 0.55));
    }
    box(-1, 0, 3.8, 0.2, 0.6, 4.4, 0xe0e0e0); // cooler
    this.landmarks.push({ name: 'Camp', x, z });
    this.footprints.push({ ...lot, color: '#9c8a6a' });
    return true;
  }

  private tryPlaneWreck(x: number, z: number): boolean {
    const lot = this.claim(x, z, 30, 26, 6);
    if (!lot) return false;
    const box = this.builder(x, z, false, lot.y);
    const white = 0xdfe3e6, grey = 0x9aa0a6;
    this.addDecal(x - 14, z - 8, x + 14, z + 8, lot.y, 0x3a3632, 0.03);
    // Fuselage broken in two, with an open end to walk into
    const portholes = this.windowsFor(-12, -2, 3).map((o) => ({ ...o, bottom: 1.4, top: 2.1 }));
    this.wall(box, true, -12, -2, -2.1, 0, 3.4, 0.2, portholes, white);
    this.wall(box, true, -12, -2, 2.1, 0, 3.4, 0.2, portholes, white);
    box(-12, 3.3, -2.2, -2, 3.6, 2.2, white);
    box(-12, 0, -2, -11.8, 3.4, 2, grey);
    box(-15, 0.2, -1.6, -12, 2.8, 1.6, 0xd04a3a); // nose
    box(1, 0, -1.2, 9, 3, 2.6, white);
    box(9, 0, 0, 12, 5.5, 0.5, 0xd04a3a); // tail fin
    box(-6, 0, 3, 0, 0.6, 12, 0xc9d0d6); // wing
    box(3, 0, -11, 7, 0.5, -4, 0xc9d0d6); // torn wing
    box(-8, 0, 8, -6, 1.8, 10, 0x5b6470); // engine
    for (let i = 0; i < 8; i++) {
      const dx = rand(this.rng, -13, 13), dz = rand(this.rng, -11, 11), s = rand(this.rng, 0.4, 1.2);
      if (Math.abs(dz) < 3 && dx < 0) continue; // keep the cabin walkable
      box(dx - s, 0, dz - s * 0.6, dx + s, s * 0.7, dz + s * 0.6, pick(this.rng, [white, grey, 0x3a3f45]));
    }
    this.fireSpots.push(this.local(x, z, false, lot.y, -7, 1.8, 9), this.local(x, z, false, lot.y, 5, 3.1, 0.5));
    for (const [lx, lz] of [[-9, 0], [-5, 0], [4, -2.5], [-3, 6], [8, 3]]) this.lootSpots.push(this.local(x, z, false, lot.y, lx, 0.12, lz));
    this.landmarks.push({ name: 'Crash Site', x, z });
    this.footprints.push({ ...lot, color: '#6f6a64' });
    return true;
  }

  private tryStoneCircle(x: number, z: number): boolean {
    const lot = this.claim(x, z, 18, 18, 4);
    if (!lot) return false;
    const box = this.builder(x, z, false, lot.y);
    const stone = 0x9a978c;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2, sx = Math.cos(a) * 7, sz = Math.sin(a) * 7;
      box(sx - 0.6, -0.5, sz - 0.6, sx + 0.6, 4.2, sz + 0.6, stone);
      if (i % 2 === 0) {
        const b = ((i + 1) / 10) * Math.PI * 2, bx = Math.cos(b) * 7, bz = Math.sin(b) * 7;
        box(Math.min(sx, bx) - 0.6, 4.2, Math.min(sz, bz) - 0.6, Math.max(sx, bx) + 0.6, 4.9, Math.max(sz, bz) + 0.6, stone);
      }
    }
    box(-1.2, 0, -0.7, 1.2, 1.0, 0.7, 0x8a877c);
    this.lootSpots.push(this.local(x, z, false, lot.y, 0, 1.05, 0), this.local(x, z, false, lot.y, 3, 0.1, 3));
    this.landmarks.push({ name: 'Stones', x, z });
    this.footprints.push({ ...lot, color: '#9a978c' });
    return true;
  }

  private tryLaunchPad(x: number, z: number): boolean {
    const lot = this.claim(x, z, 4, 4, 3);
    if (!lot) return false;
    this.padSpots.push(new Vector3(x, lot.y, z));
    return true;
  }

  // ---------- city blocks ----------

  private plaza(cx: number, cz: number, y: number, size: number) {
    const rect = { x0: cx - size / 2, z0: cz - size / 2, x1: cx + size / 2, z1: cz + size / 2 };
    if (this.overlapsOccupied(rect, 0.5)) return;
    this.occupied.push(rect);
    this.addDecal(rect.x0, rect.z0, rect.x1, rect.z1, y, 0xcfc6b4, 0.045);
    // Fountain
    this.addSolid(cx - 3, y, cz - 3, cx + 3, y + 0.7, cz - 2.6, 0xd8d2c4);
    this.addSolid(cx - 3, y, cz + 2.6, cx + 3, y + 0.7, cz + 3, 0xd8d2c4);
    this.addSolid(cx - 3, y, cz - 2.6, cx - 2.6, y + 0.7, cz + 2.6, 0xd8d2c4);
    this.addSolid(cx + 2.6, y, cz - 2.6, cx + 3, y + 0.7, cz + 2.6, 0xd8d2c4);
    this.addSolid(cx - 2.6, y, cz - 2.6, cx + 2.6, y + 0.35, cz + 2.6, 0x4fa3d9);
    this.addSolid(cx - 0.4, y, cz - 0.4, cx + 0.4, y + 2.6, cz + 0.4, 0xd8d2c4);
    for (const [bx, bz] of [[-6, 0], [6, 0], [0, -6], [0, 6]]) {
      const alongX = bz !== 0;
      this.addSolid(cx + bx - (alongX ? 1 : 0.3), y, cz + bz - (alongX ? 0.3 : 1), cx + bx + (alongX ? 1 : 0.3), y + 0.5, cz + bz + (alongX ? 0.3 : 1), 0x8a6a48);
    }
    this.lootSpots.push(new Vector3(cx + 4, y + 0.1, cz + 4), new Vector3(cx - 4, y + 0.1, cz - 4));
  }

  private parking(cx: number, cz: number, y: number, size: number): boolean {
    const rng = this.rng;
    const rect = { x0: cx - size / 2, z0: cz - size / 2, x1: cx + size / 2, z1: cz + size / 2 };
    if (this.overlapsOccupied(rect, 0.5)) return false;
    this.occupied.push(rect);
    this.addDecal(rect.x0 + 0.5, rect.z0 + 0.5, rect.x1 - 0.5, rect.z1 - 0.5, y, 0x3f4247, 0.05);
    for (const row of [-1, 1]) {
      for (let k = 0; k < 6; k++) {
        const sx = rect.x0 + 1.5 + k * 3.7;
        const z0 = cz + row * 3 - (row < 0 ? 5.5 : 0), z1 = z0 + 5.5;
        this.addDecal(sx - 0.08, z0, sx + 0.08, z1, y, 0xf2f2f2, 0.08);
        if (rng() < 0.55) this.car(sx + 1.85, (z0 + z1) / 2, y, false);
      }
    }
    this.lootSpots.push(new Vector3(cx, y + 0.1, cz));
    this.vehicleSpots.push({ x: cx - 4, y, z: cz, yaw: Math.PI / 2 });
    this.footprints.push({ ...rect, color: '#5d6168' });
    return true;
  }

  private car(x: number, z: number, y: number, alongX: boolean) {
    const c = pick(this.rng, CAR_COLORS);
    const [hx, hz] = alongX ? [2.1, 0.95] : [0.95, 2.1];
    this.addSolid(x - hx, y + 0.3, z - hz, x + hx, y + 1.1, z + hz, c);
    const [cx, cz] = alongX ? [1.2, 0.85] : [0.85, 1.2];
    this.addSolid(x - cx, y + 1.1, z - cz, x + cx, y + 1.75, z + cz, 0x2a3440);
  }

  private park(cx: number, cz: number, y: number, size: number): boolean {
    const rng = this.rng;
    const rect = { x0: cx - size / 2, z0: cz - size / 2, x1: cx + size / 2, z1: cz + size / 2 };
    if (this.overlapsOccupied(rect, 0.5)) return false;
    this.occupied.push(rect);
    this.addDecal(rect.x0 + 1, rect.z0 + 1, rect.x1 - 1, rect.z1 - 1, y, 0x5fae4f, 0.06);
    for (let i = 0; i < randInt(rng, 4, 8); i++) this.addTree(rand(rng, rect.x0 + 3, rect.x1 - 3), rand(rng, rect.z0 + 3, rect.z1 - 3), rand(rng, 1.6, 2.4));
    for (let i = 0; i < 3; i++) {
      const bx = rand(rng, rect.x0 + 3, rect.x1 - 3), bz = rand(rng, rect.z0 + 3, rect.z1 - 3);
      this.addSolid(bx - 1, y, bz - 0.3, bx + 1, y + 0.5, bz + 0.3, 0x8a6a48);
    }
    this.lootSpots.push(new Vector3(cx + rand(rng, -5, 5), y + 0.1, cz + rand(rng, -5, 5)));
    this.footprints.push({ ...rect, color: '#4f9a45' });
    return true;
  }

  // ---------- rendering ----------

  private groundColor(x: number, z: number, h: number, slope: number, out: Color) {
    const poi = this.poiAt(x, z);
    if (h < 1.25 && !poi) return out.setHex(h < -0.2 ? 0xb9a878 : 0xd8c897);
    const n = this.noiseB(x * 0.02, z * 0.02);
    out.setHex(0x5b8a45).lerp(tmpC.setHex(0x466d36), n);
    // Chunky patches, like the rest of the world's flat colours.
    const patch = this.noiseA(Math.floor(x / 6) * 0.37, Math.floor(z / 6) * 0.37);
    out.lerp(tmpC.setHex(patch > 0.5 ? 0x6e9650 : 0x3f6231), Math.abs(patch - 0.5) * 0.45);
    if (h > 12) out.lerp(tmpC.setHex(0x8a9a5a), clamp((h - 12) / 30, 0, 0.6));
    if (THEME === 'military') out.lerp(tmpC.setHex(0x8a8a5a), 0.3);
    else if (THEME === 'park') out.lerp(tmpC.setHex(0x7a9a4a), 0.15);
    else if (THEME === 'western') {
      const dune = this.noiseB(x * 0.008 + 40, z * 0.008 - 17);
      out.setHex(patch > 0.5 ? 0xdcbd84 : 0xd0ae72).lerp(tmpC.setHex(0xc49a60), clamp((dune - 0.45) * 1.6, 0, 0.7));
      // Now and then a patch of dry scrub.
      if (n > 0.72) out.lerp(tmpC.setHex(0xa89660), (n - 0.72) * 2);
    }
    if (poi) {
      const k = clamp(1 - Math.hypot(poi.x - x, poi.z - z) / (poi.radius + 10), 0, 1) * 1.6;
      const town = THEME === 'western' ? 0xc0a070 : poi.size === 'city' ? 0x9d9b94 : poi.flavor === 'farm' ? 0x9cae5a : poi.flavor === 'industrial' || poi.flavor === 'harbor' ? 0x9a9384 : 0x86a85a;
      out.lerp(tmpC.setHex(town), clamp(k, 0, 1));
    }
    if (slope > 0.5) out.lerp(tmpC.setHex(THEME === 'western' ? 0xb4643c : 0x9c9a8f), clamp((slope - 0.5) * 2, 0, THEME === 'western' ? 0.85 : 0.7));
    return out;
  }

  /**
   * Instanced meshes split into square chunks, so the camera frustum and the draw-distance culler
   * can skip whole parts of the map instead of pushing every box on the island through the GPU.
   */
  private chunked(geo: BufferGeometry, mat: Material, items: { m: Matrix4; c: Color; x: number; z: number }[], size: number, max: number, opts: { cast?: boolean; receive?: boolean; detail?: boolean } = {}) {
    const buckets = new Map<string, typeof items>();
    for (const it of items) {
      const key = `${Math.floor(it.x / size)},${Math.floor(it.z / size)}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = []));
      b.push(it);
    }
    for (const list of buckets.values()) {
      const mesh = new InstancedMesh(geo, mat, list.length);
      list.forEach((it, i) => {
        mesh.setMatrixAt(i, it.m);
        mesh.setColorAt(i, it.c);
      });
      mesh.castShadow = !!opts.cast;
      mesh.receiveShadow = !!opts.receive;
      mesh.computeBoundingSphere();
      const bs = mesh.boundingSphere!;
      mesh.userData.detail = !!opts.detail;
      this.scene.add(mesh);
      const offshore = [...this.gulags, this.arena].some((g) => Math.hypot(g.x - bs.center.x, g.z - bs.center.z) < 150);
      this.cullables.push({ obj: mesh, x: bs.center.x, z: bs.center.z, r: bs.radius, max, offshore });
      if (opts.detail) this.detail.push(mesh);
    }
  }

  /** Low graphics quality hides grass and flowers entirely. */
  setDetail(on: boolean) {
    for (const d of this.detail) d.userData.hidden = !on;
  }

  private buildMeshes() {
    const rng = this.rng;
    const q = new Quaternion(), p = new Vector3(), s = new Vector3();
    const unit = new BoxGeometry(1, 1, 1);
    const item = (x: number, y: number, z: number, sx: number, sy: number, sz: number, color: number | Color, rot?: Quaternion) => ({
      m: new Matrix4().compose(p.set(x, y, z), rot ?? q, s.set(sx, sy, sz)),
      c: typeof color === 'number' ? new Color(color) : color.clone(),
      x, z,
    });

    // Buildings, rocks, props: 100 m chunks, drawn out to the fog.
    const solidItems = this.solids.map((b) => item(
      (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2,
      b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ,
      new Color(b.color).offsetHSL(0, 0, (rng() - 0.5) * 0.04),
    ));
    this.chunked(unit, blockyMaterial(), solidItems, 100, 0, { cast: true, receive: true });

    // Flat markings: polygon offset pulls them in front of the ground so they never z-fight.
    const decalMat = new MeshLambertMaterial({ polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    const decalItems = this.decals.map((b) => item(
      (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2,
      b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ, b.color,
    ));
    this.chunked(unit, decalMat, decalItems, 150, 520, { receive: true });

    // Tree canopies (visual only): cone layers for conifers, clumps of leafy blobs for the rest.
    const coneItems: ReturnType<typeof item>[] = [], blobItems: ReturnType<typeof item>[] = [];
    const spin = () => new Quaternion().setFromAxisAngle(tmpV.set(0, 1, 0), rng() * 6);
    for (const t of this.trees) {
      if (t.k === 0) {
        for (let k = 0; k < 2; k++) {
          const r = t.r * (k === 0 ? 1 : 0.7), h = t.r * (k === 0 ? 2.0 : 1.6);
          coneItems.push(item(t.x, t.y + 2.4 + k * t.r * 1.1 + h / 2, t.z, r, h, r, pick(rng, [0x3f8f3a, 0x2f7a3a, 0x4ea244, 0x36823f]), spin()));
        }
      } else if (t.k === 1) {
        // Spruce: tall and narrow, three dark tiers.
        for (let k = 0; k < 3; k++) {
          const r = t.r * (0.85 - k * 0.2), h = t.r * (1.6 - k * 0.25);
          coneItems.push(item(t.x, t.y + 2.2 + k * t.r * 0.95 + h / 2, t.z, r, h, r, pick(rng, [0x24583a, 0x2a6440, 0x1f4f34]), spin()));
        }
      } else if (t.k >= 5) continue; // dead tree / cactus: just the trunk and branches
      else {
        // Oak / maple / birch: a round crown made of a few overlapping blobs.
        const cols = t.k === 2 ? [0x4f9a3a, 0x5aa844, 0x3f8a35, 0x4a9440] : t.k === 3 ? [0x8cc653, 0x9bd060, 0x7fb84a] : [0xd9822b, 0xc9502a, 0xe0b23a, 0xd06a2a];
        const R = t.r * (t.k === 3 ? 0.75 : 1.05), top = t.y + (t.k === 3 ? 4.0 : 3.0);
        blobItems.push(item(t.x, top + R * 0.55, t.z, R * 1.15, R * 0.95, R * 1.15, pick(rng, cols), spin()));
        const n = t.k === 3 ? 2 : 3;
        for (let b = 0; b < n; b++) {
          const a = rng() * Math.PI * 2, d = R * 0.6;
          blobItems.push(item(t.x + Math.cos(a) * d, top + R * (0.25 + rng() * 0.6), t.z + Math.sin(a) * d, R * 0.75, R * 0.65, R * 0.75, pick(rng, cols), spin()));
        }
      }
    }
    this.chunked(new ConeGeometry(1, 1, 7), new MeshLambertMaterial(), coneItems, 125, 0, { cast: true });
    this.chunked(new IcosahedronGeometry(1, 1), new MeshLambertMaterial({ flatShading: true }), blobItems, 125, 0, { cast: true });

    // Bushes (hideable) plus grass tufts and flowers to break up open fields.
    const bushItems = this.bushes.map((b) => item(b.x, b.y + b.r * 0.55, b.z, b.r * 1.2, b.r * 0.9, b.r * 1.1,
      pick(rng, THEME === 'western' ? [0x7a8a4a, 0x8a8a55, 0x6f7a45, 0x9a9a60] : [0x3e8a36, 0x4c9a3c, 0x357a33, 0x5aa545]), new Quaternion().setFromAxisAngle(tmpV.set(0, 1, 0), rng() * 6)));
    this.chunked(new IcosahedronGeometry(1, 0), new MeshLambertMaterial({ flatShading: true }), bushItems, 100, 380, { cast: true, receive: true });

    const tuftGeo = new ConeGeometry(0.12, 0.55, 3);
    tuftGeo.translate(0, 0.27, 0);
    const flowerGeo = new BoxGeometry(0.16, 0.16, 0.16);
    flowerGeo.translate(0, 0.35, 0);
    const tufts: ReturnType<typeof item>[] = [], flowers: ReturnType<typeof item>[] = [];
    for (let tries = 0; tries < 40000 && (tufts.length < 9000 || flowers.length < 2500); tries++) {
      // Clumps: tufts gather around random centres so fields look patchy, not uniform.
      const cx = rand(rng, -480, 480), cz = rand(rng, -480, 480);
      const poi = this.poiAt(cx, cz);
      if (poi && (poi.size === 'city' || Math.hypot(poi.x - cx, poi.z - cz) < poi.radius * 0.7)) continue;
      if (this.nearRoad(cx, cz, 5) || this.terrain.heightAt(cx, cz) < 1.3) continue;
      const flower = rng() < (THEME === 'western' ? 0.05 : 0.25);
      const col = flower ? pick(rng, [0xf2e14c, 0xf2f2f2, 0xe86fa0, 0x9a7ae0, 0xf08a3c]) : 0;
      for (let k = 0; k < 8; k++) {
        const x = cx + rand(rng, -2.5, 2.5), z = cz + rand(rng, -2.5, 2.5), y = this.terrain.heightAt(x, z);
        const sc = rand(rng, 0.7, 1.4);
        if (flower && flowers.length < 2500) flowers.push(item(x, y - 0.05, z, sc, sc, sc, col));
        else if (!flower && tufts.length < 9000) tufts.push(item(x, y - 0.05, z, sc, sc, sc, pick(rng, THEME === 'western' ? [0xb8a060, 0xa89050, 0xc4ac6a, 0x9a8a4a] : [0x4f9a3f, 0x5fae4f, 0x6fb655, 0x7aa04a])));
      }
    }
    this.chunked(tuftGeo, new MeshLambertMaterial(), tufts, 50, 110, { detail: true });
    this.chunked(flowerGeo, new MeshLambertMaterial(), flowers, 50, 110, { detail: true });

    for (const c of this.buildTerrainChunks()) this.scene.add(c);

    const sea = (this.sea = new Mesh(new PlaneGeometry(8000, 8000), new MeshLambertMaterial({ color: 0x2f8fcf })));
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -0.5;
    sea.receiveShadow = true;
    this.scene.add(sea);

    this.scene.add(this.buildRoadMesh());
    this.buildBridgeMeshes();
    this.buildZiplineMeshes();
  }

  private buildBridgeMeshes() {
    const unit = new BoxGeometry(1, 1, 1);
    const concrete = new MeshLambertMaterial({ color: 0x9d9a92 }), rail = new MeshLambertMaterial({ color: 0x6b7078 });
    for (const b of this.bridges) {
      const yaw = Math.atan2(b.dx, b.dz), segs = Math.max(4, Math.ceil(b.len / 4));
      for (let i = 0; i < segs; i++) {
        const u0 = (b.len * i) / segs, u1 = (b.len * (i + 1)) / segs, um = (u0 + u1) / 2;
        const y0 = this.bridgeY(b, u0), y1 = this.bridgeY(b, u1);
        const pitch = Math.atan2(y1 - y0, u1 - u0), L = Math.hypot(u1 - u0, y1 - y0) + 0.05;
        const cx = b.x + b.dx * um, cz = b.z + b.dz * um, cy = (y0 + y1) / 2;
        const deck = new Mesh(unit, concrete);
        deck.rotation.order = 'YXZ';
        deck.rotation.set(-pitch, yaw, 0);
        deck.position.set(cx, cy - 0.35, cz);
        deck.scale.set(10.2, 0.7, L);
        deck.castShadow = deck.receiveShadow = true;
        this.scene.add(deck);
        for (const side of [-1, 1]) {
          const r = new Mesh(unit, rail);
          r.rotation.copy(deck.rotation);
          r.position.set(cx - b.dz * side * 4.95, cy + 0.5, cz + b.dx * side * 4.95);
          r.scale.set(0.2, 1, L);
          r.castShadow = true;
          this.scene.add(r);
        }
      }
      // Pillars down into the river
      for (const f of [0.33, 0.67]) {
        const u = b.len * f, x = b.x + b.dx * u, z = b.z + b.dz * u, top = this.bridgeY(b, u) - 0.7;
        const bottom = this.terrain.heightAt(x, z) - 0.5, pillar = new Mesh(unit, concrete);
        pillar.position.set(x, (top + bottom) / 2, z);
        pillar.rotation.y = yaw;
        pillar.scale.set(7, top - bottom, 1.6);
        this.scene.add(pillar);
      }
    }
  }

  private buildZiplineMeshes() {
    const geo = new CylinderGeometry(0.035, 0.035, 1, 5);
    geo.rotateX(Math.PI / 2);
    const mat = new MeshLambertMaterial({ color: 0x2a2d31 });
    for (const z of this.ziplines) {
      const m = new Mesh(geo, mat);
      m.position.lerpVectors(z.a, z.b, 0.5);
      m.lookAt(z.b);
      m.scale.set(1, 1, z.a.distanceTo(z.b));
      this.scene.add(m);
      // A bright tag on each end so you can spot them.
      for (const e of [z.a, z.b]) {
        const tag = new Mesh(new BoxGeometry(0.5, 0.5, 0.5), new MeshLambertMaterial({ color: 0xffcf3a, emissive: 0x6a4a00 }));
        tag.position.copy(e).y += 0.1;
        this.scene.add(tag);
      }
    }
  }

  /**
   * Terrain as 7x7 chunks, each a LOD with three resolutions sharing one vertex buffer.
   * Skirts hang down from every chunk edge so resolution changes never open cracks.
   */
  private buildTerrainChunks(): Object3D[] {
    const T = this.terrain, n = T.n, C = 50;
    const nrm = new Float32Array(n * n * 3), col = new Float32Array(n * n * 3);
    const c = new Color();
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix, x = T.coord(ix), z = T.coord(iz), h = T.heights[i];
        const hx = T.get(Math.min(ix + 1, n - 1), iz) - T.get(Math.max(ix - 1, 0), iz);
        const hz = T.get(ix, Math.min(iz + 1, n - 1)) - T.get(ix, Math.max(iz - 1, 0));
        const l = Math.hypot(hx, 2 * T.cell, hz);
        nrm.set([-hx / l, (2 * T.cell) / l, -hz / l], i * 3);
        this.groundColor(x, z, h, Math.hypot(hx, hz) / (2 * T.cell), c);
        col.set([c.r, c.g, c.b], i * 3);
      }
    }
    const tex = new CanvasTexture(makeDetailCanvas());
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.anisotropy = 8;
    tex.colorSpace = SRGBColorSpace;
    // Toned down: flat ground faces the sun head-on and otherwise glows next to the walls.
    const mat = new MeshLambertMaterial({ color: 0xc4c4c4, map: tex, vertexColors: true, flatShading: true });
    const out: Object3D[] = [];
    const chunks = Math.ceil((n - 1) / C);
    for (let cz = 0; cz < chunks; cz++) {
      for (let cx = 0; cx < chunks; cx++) {
        const ix0 = cx * C, iz0 = cz * C, ix1 = Math.min(ix0 + C, n - 1), iz1 = Math.min(iz0 + C, n - 1);
        const w = ix1 - ix0 + 1, h = iz1 - iz0 + 1;
        const ox = (T.coord(ix0) + T.coord(ix1)) / 2, oz = (T.coord(iz0) + T.coord(iz1)) / 2;
        const vcount = w * h + 2 * w + 2 * h;
        const pos = new Float32Array(vcount * 3), vn = new Float32Array(vcount * 3), vc = new Float32Array(vcount * 3), uv = new Float32Array(vcount * 2);
        let v = 0;
        const put = (ix: number, iz: number, drop: number) => {
          const i = iz * n + ix, x = T.coord(ix), z = T.coord(iz);
          pos.set([x - ox, T.heights[i] - drop, z - oz], v * 3);
          vn.set([nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]], v * 3);
          vc.set([col[i * 3], col[i * 3 + 1], col[i * 3 + 2]], v * 3);
          uv.set([x / 7, z / 7], v * 2);
          return v++;
        };
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(ix0 + i, iz0 + j, 0);
        const top = v; for (let i = 0; i < w; i++) put(ix0 + i, iz0, 8);
        const bot = v; for (let i = 0; i < w; i++) put(ix0 + i, iz1, 8);
        const left = v; for (let j = 0; j < h; j++) put(ix0, iz0 + j, 8);
        const right = v; for (let j = 0; j < h; j++) put(ix1, iz0 + j, 8);
        const gi = (i: number, j: number) => j * w + i;
        const attrs = {
          position: new BufferAttribute(pos, 3), normal: new BufferAttribute(vn, 3),
          color: new BufferAttribute(vc, 3), uv: new BufferAttribute(uv, 2),
        };
        const lod = new LOD();
        lod.position.set(ox, 0, oz);
        for (const [step, dist] of [[1, 0], [2, 290], [5, 600]] as const) {
          const idx: number[] = [];
          for (let j = 0; j < h - 1; j += step) {
            for (let i = 0; i < w - 1; i += step) {
              const a = gi(i, j), b = gi(i + step, j), d = gi(i, j + step), e = gi(i + step, j + step);
              idx.push(a, d, e, a, e, b);
            }
          }
          for (let i = 0; i < w - 1; i += step) {
            idx.push(gi(i, 0), gi(i + step, 0), top + i, gi(i + step, 0), top + i + step, top + i);
            idx.push(gi(i, h - 1), bot + i, gi(i + step, h - 1), gi(i + step, h - 1), bot + i, bot + i + step);
          }
          for (let j = 0; j < h - 1; j += step) {
            idx.push(gi(0, j), left + j, gi(0, j + step), gi(0, j + step), left + j, left + j + step);
            idx.push(gi(w - 1, j), gi(w - 1, j + step), right + j, gi(w - 1, j + step), right + j + step, right + j);
          }
          const geo = new BufferGeometry();
          for (const [k, a] of Object.entries(attrs)) geo.setAttribute(k, a);
          geo.setIndex(idx);
          geo.computeBoundingSphere();
          const mesh = new Mesh(geo, mat);
          mesh.receiveShadow = true;
          lod.addLevel(mesh, dist);
        }
        this.cullables.push({ obj: lod, x: ox, z: oz, r: C * T.cell * 0.72, max: 0 });
        out.push(lod);
      }
    }
    return out;
  }

  /** Roads are ribbons draped over the terrain (and over bridge decks). */
  private buildRoadMesh() {
    const T = this.terrain;
    const pos: number[] = [], idx: number[] = [];
    const yAt = (x: number, z: number) => Math.max(T.heightAt(x, z) + 0.06, this.deckAt(x, z) + 0.04);
    for (const r of this.roads) {
      const len = Math.hypot(r.x1 - r.x0, r.z1 - r.z0);
      const dx = (r.x1 - r.x0) / len, dz = (r.z1 - r.z0) / len;
      const hw = THEME === 'park' ? 2.4 : 4, nx = -dz * hw, nz = dx * hw;
      const segs = Math.max(1, Math.ceil(len / 2));
      const startV = pos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const x = r.x0 + dx * len * (i / segs), z = r.z0 + dz * len * (i / segs);
        pos.push(x + nx, yAt(x + nx, z + nz), z + nz);
        pos.push(x - nx, yAt(x - nx, z - nz), z - nz);
        if (i > 0) {
          const a = startV + (i - 1) * 2, b = a + 1, c = a + 2, d = a + 3;
          idx.push(a, c, b, b, c, d);
        }
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // Make sure the ribbon faces up regardless of winding.
    const nrm = geo.getAttribute('normal') as BufferAttribute;
    for (let i = 0; i < nrm.count; i++) if (nrm.getY(i) < 0) nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i));
    const mesh = new Mesh(geo, new MeshLambertMaterial({
      color: THEME === 'western' ? 0x8a6c4a : THEME === 'park' ? 0xcdbb98 : 0x5b5f66, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, side: 2,
    }));
    mesh.receiveShadow = true;
    return mesh;
  }

  /** 1024px top-down map image (with hill shading) used by the minimap and the big map. */
  private drawMapCanvas(): HTMLCanvasElement {
    const N = 1024;
    const cv = document.createElement('canvas');
    cv.width = cv.height = N;
    const ctx = cv.getContext('2d')!;
    const k = N / this.size;
    const tx = (x: number) => (x + this.half) * k;
    const img = ctx.createImageData(N, N);
    const c = new Color();
    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const x = px / k - this.half, z = py / k - this.half;
        const h = this.terrain.heightAt(x, z);
        const gx = this.terrain.heightAt(x + 2, z) - this.terrain.heightAt(x - 2, z);
        const gz = this.terrain.heightAt(x, z + 2) - this.terrain.heightAt(x, z - 2);
        if (h < -0.5) c.setHex(0x2f8fcf);
        else this.groundColor(x, z, h, Math.hypot(gx, gz) / 4, c);
        const shade = clamp(1 - (gx + gz) * 0.09 + h * 0.004, 0.55, 1.35);
        const o = (py * N + px) * 4;
        img.data[o] = clamp(Math.pow(c.r, 1 / 2.2) * 255 * shade, 0, 255);
        img.data[o + 1] = clamp(Math.pow(c.g, 1 / 2.2) * 255 * shade, 0, 255);
        img.data[o + 2] = clamp(Math.pow(c.b, 1 / 2.2) * 255 * shade, 0, 255);
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
    for (const d of this.decals) {
      ctx.fillStyle = hex(d.color);
      ctx.fillRect(tx(d.minX), tx(d.minZ), (d.maxX - d.minX) * k, (d.maxZ - d.minZ) * k);
    }
    ctx.fillStyle = 'rgba(30,80,30,0.5)';
    for (const t of this.trees) {
      ctx.beginPath();
      ctx.arc(tx(t.x), tx(t.z), t.r * k * 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = THEME === 'western' ? '#8a6c4a' : THEME === 'park' ? '#cdbb98' : '#5b5f66';
    ctx.lineWidth = (THEME === 'park' ? 5 : 8) * k;
    ctx.lineCap = 'round';
    for (const r of this.roads) {
      ctx.beginPath();
      ctx.moveTo(tx(r.x0), tx(r.z0));
      ctx.lineTo(tx(r.x1), tx(r.z1));
      ctx.stroke();
    }
    // The railway: a dark line with sleepers.
    for (const r of this.rails) {
      ctx.strokeStyle = '#3a2c20';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(tx(r.x0), tx(r.z0));
      ctx.lineTo(tx(r.x1), tx(r.z1));
      ctx.stroke();
      const len = Math.hypot(r.x1 - r.x0, r.z1 - r.z0), ux = (r.x1 - r.x0) / len, uz = (r.z1 - r.z0) / len;
      ctx.lineWidth = 1.2;
      for (let d = 0; d < len; d += 9) {
        const cx = tx(r.x0 + ux * d), cz = tx(r.z0 + uz * d);
        ctx.beginPath();
        ctx.moveTo(cx - uz * 3.5, cz + ux * 3.5);
        ctx.lineTo(cx + uz * 3.5, cz - ux * 3.5);
        ctx.stroke();
      }
    }
    for (const f of this.footprints) {
      ctx.fillStyle = f.color;
      ctx.fillRect(tx(f.x0), tx(f.z0), (f.x1 - f.x0) * k, (f.z1 - f.z0) * k);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(tx(f.x0), tx(f.z0), (f.x1 - f.x0) * k, (f.z1 - f.z0) * k);
    }
    ctx.textAlign = 'center';
    ctx.font = '600 12px system-ui, sans-serif';
    for (const l of this.landmarks) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(l.name, tx(l.x), tx(l.z) - 12);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(l.name, tx(l.x), tx(l.z) - 12);
    }
    for (const p of this.pois) {
      const px = p.size === 'city' ? 30 : p.size === 'town' ? 22 : 17;
      ctx.font = `bold ${px}px system-ui, sans-serif`;
      const label = p.name.toUpperCase(), y = tx(p.z) - p.radius * k * 0.75 - 4;
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(label, tx(p.x), y);
      ctx.fillStyle = p.size === 'city' ? '#ffe28a' : '#fff';
      ctx.fillText(label, tx(p.x), y);
    }
    return cv;
  }
}

const tmpC = new Color();
const tmpV = new Vector3();

function smoothstep(a: number, b: number, x: number) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Seeded 2D value noise in [0, 1]. */
function makeNoise(seed: number) {
  const rng = mulberry32(seed);
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) vals[i] = rng();
  const perm = new Uint8Array(512);
  const base = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [base[i], base[j]] = [base[j], base[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255];
  const at = (x: number, y: number) => vals[perm[(perm[x & 255] + y) & 511]];
  return (x: number, y: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
  };
}

function fbm(noise: (x: number, y: number) => number, x: number, y: number, octaves: number) {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * f + i * 17.3, y * f - i * 9.1) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Subtle, tileable light/dark mottling; the colour comes from the terrain's vertex colours. */
function makeDetailCanvas() {
  const N = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#f4f4f4';
  ctx.fillRect(0, 0, N, N);
  const rng = mulberry32(7);
  for (let i = 0; i < 320; i++) {
    const x = rng() * N, y = rng() * N, r = 4 + rng() * 22;
    const l = 80 + rng() * 20;
    ctx.fillStyle = `hsla(0, 0%, ${l}%, 0.2)`;
    for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) {
      ctx.beginPath();
      ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return cv;
}
