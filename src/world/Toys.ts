import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, Mesh, SphereGeometry, TorusGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Box } from '../core/Collision';
import { plastic, type LitMat } from '../game/Look';
import type { Rng } from '../core/rng';

/**
 * Toy Box: the giant toys lying around the island (building blocks, bricks, dice, beach balls,
 * crayons, stacking rings, rockets, teddy bears, rubber ducks) and the toy chest walls round it all.
 * Each toy is one vertex-coloured mesh plus a few collision boxes.
 */

export const TOY_COLORS = [0xe3342f, 0x2f6fe0, 0xffc21a, 0x2fb84a, 0xff7a1a, 0x8b3fe0, 0x14b8a6, 0xe83e8c, 0xf4f4f4];
const pickC = (rng: Rng, list = TOY_COLORS) => list[Math.floor(rng() * list.length)];

function paint(g: BufferGeometry, c: Color) {
  const n = g.getAttribute('position').count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new BufferAttribute(col, 3));
  return g;
}

/** Builds one toy in local space (y = 0 on the ground), then places it with a quarter-turn rotation. */
export class ToyBuilder {
  parts: BufferGeometry[] = [];
  boxes: Box[] = [];

  private prep(g: BufferGeometry, x: number, y: number, z: number, color: number | Color) {
    const geo = g.index ? g.toNonIndexed() : g;
    geo.translate(x, y, z);
    geo.deleteAttribute('uv');
    geo.computeVertexNormals();
    this.parts.push(paint(geo, typeof color === 'number' ? new Color(color) : color));
    return geo;
  }

  /** A box that you also collide with (unless `solid` is false). */
  box(w: number, h: number, d: number, x: number, y: number, z: number, color: number | Color, solid = true) {
    this.prep(new BoxGeometry(w, h, d), x, y, z, color);
    if (solid) this.solid(x - w / 2, y - h / 2, z - d / 2, x + w / 2, y + h / 2, z + d / 2);
  }

  /** Collision only. */
  solid(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) {
    this.boxes.push({ minX, minY, minZ, maxX, maxY, maxZ });
  }

  ball(r: number, x: number, y: number, z: number, color: number | Color, sx = 1, sy = 1, sz = 1, seg = 16) {
    const g = new SphereGeometry(r, seg, Math.round(seg * 0.7));
    g.scale(sx, sy, sz);
    return this.prep(g, x, y, z, color);
  }

  cyl(rt: number, rb: number, h: number, x: number, y: number, z: number, color: number | Color, seg = 16, axis: 'y' | 'x' | 'z' = 'y') {
    const g = new CylinderGeometry(rt, rb, h, seg);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    if (axis === 'z') g.rotateX(Math.PI / 2);
    return this.prep(g, x, y, z, color);
  }

  cone(r: number, h: number, x: number, y: number, z: number, color: number | Color, seg = 16, axis: 'y' | 'x' | 'z' = 'y', flip = false) {
    const g = new ConeGeometry(r, h, seg);
    if (flip) g.rotateZ(Math.PI);
    if (axis === 'x') g.rotateZ(-Math.PI / 2);
    if (axis === 'z') g.rotateX(Math.PI / 2);
    return this.prep(g, x, y, z, color);
  }

  torus(r: number, tube: number, x: number, y: number, z: number, color: number | Color) {
    const g = new TorusGeometry(r, tube, 10, 28);
    g.rotateX(Math.PI / 2);
    return this.prep(g, x, y, z, color);
  }

  /** Merged mesh at (x, y, z), turned `quarter` × 90°; collision boxes moved to match. */
  finish(x: number, y: number, z: number, quarter: number, mat: LitMat) {
    const q = ((quarter % 4) + 4) % 4;
    const geo = mergeGeometries(this.parts)!;
    geo.rotateY((-q * Math.PI) / 2);
    geo.translate(x, y, z);
    geo.computeBoundingSphere();
    const mesh = new Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    const rot = (px: number, pz: number): [number, number] => {
      // Same turn as rotateY(-q·90°): (x, z) → (−z, x) per quarter.
      for (let i = 0; i < q; i++) [px, pz] = [-pz, px];
      return [px, pz];
    };
    const boxes = this.boxes.map((b) => {
      const [ax, az] = rot(b.minX, b.minZ), [bx, bz] = rot(b.maxX, b.maxZ);
      return {
        minX: Math.min(ax, bx) + x, maxX: Math.max(ax, bx) + x, minY: b.minY + y, maxY: b.maxY + y,
        minZ: Math.min(az, bz) + z, maxZ: Math.max(az, bz) + z,
      };
    });
    return { mesh, boxes };
  }
}

export type ToyKind = 'blocks' | 'brick' | 'dice' | 'ball' | 'crayon' | 'rings' | 'rocket' | 'teddy' | 'duck';

/** Footprint radius of each toy (for finding a free spot) and how many to place. */
export const TOY_SPECS: Record<ToyKind, { r: number; count: number; water?: boolean }> = {
  blocks: { r: 9, count: 8 }, brick: { r: 7, count: 7 }, dice: { r: 5, count: 5 }, ball: { r: 6, count: 5 },
  crayon: { r: 11, count: 7 }, rings: { r: 7, count: 3 }, rocket: { r: 8, count: 2 }, teddy: { r: 13, count: 2 },
  duck: { r: 8, count: 5, water: true },
};

/** Where loot can go on top of a toy (local space), so the high ground is worth climbing. */
export type Perch = [number, number, number];

export function buildToy(kind: ToyKind, rng: Rng): { b: ToyBuilder; perches: Perch[] } {
  const b = new ToyBuilder(), perches: Perch[] = [];
  switch (kind) {
    case 'blocks': {
      // Alphabet blocks: 5 m cubes with a raised panel on every side, stacked in a pyramid or a tower.
      const S = 5, layouts: [number, number, number][][] = [
        [[-S / 2 - 0.2, 0, 0], [S / 2 + 0.2, 0, 0], [0, 1, 0]],
        [[0, 0, 0], [0.4, 1, -0.3], [-0.3, 2, 0.2]],
        [[-S - 0.3, 0, 0], [0, 0, 0], [S + 0.3, 0, 0], [-S / 2, 1, 0], [S / 2, 1, 0], [0, 2, 0]],
        [[0, 0, 0], [S + 1.5, 0, 1]],
      ];
      const lay = layouts[Math.floor(rng() * layouts.length)];
      for (const [x, level, z] of lay) {
        const y = level * S + S / 2, c = pickC(rng), inset = pickC(rng, TOY_COLORS.filter((k) => k !== c)), mark = pickC(rng, TOY_COLORS.filter((k) => k !== inset));
        b.box(S, S, S, x, y, z, c);
        for (const [dx, dz, w, d] of [[0, -1, 3.8, 0.2], [0, 1, 3.8, 0.2], [-1, 0, 0.2, 3.8], [1, 0, 0.2, 3.8]]) {
          b.box(w, 3.8, d, x + dx * (S / 2 + 0.05), y, z + dz * (S / 2 + 0.05), inset, false);
          b.box(w === 0.2 ? 0.3 : 1.8, 1.8, d === 0.2 ? 0.3 : 1.8, x + dx * (S / 2 + 0.1), y, z + dz * (S / 2 + 0.1), mark, false);
        }
        b.box(3.8, 0.2, 3.8, x, y + S / 2 + 0.05, z, inset, false);
      }
      const top = lay.reduce((a, c) => (c[1] > a[1] ? c : a));
      perches.push([top[0], (top[1] + 1) * S + 0.3, top[2]]);
      break;
    }
    case 'brick': {
      // A giant plastic building brick: 2 × 4 studs.
      const c = pickC(rng), W = 12.8, D = 6.4, H = 4.6;
      b.box(W, H, D, 0, H / 2, 0, c);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) b.cyl(1.2, 1.2, 0.9, -W / 2 + 1.6 + i * 3.2, H + 0.45, -D / 2 + 1.6 + j * 3.2, c, 18);
      // Sometimes a second one stacked across it.
      if (rng() < 0.5) {
        const c2 = pickC(rng, TOY_COLORS.filter((k) => k !== c));
        b.box(D, H, W, 1.6, H * 1.5 + 0.9, 0, c2);
        b.solid(-1.6, H, -W / 2, 4.8, H + 0.9, W / 2);
        for (let i = 0; i < 2; i++) for (let j = 0; j < 4; j++) b.cyl(1.2, 1.2, 0.9, 1.6 - D / 2 + 1.6 + i * 3.2, H * 2 + 1.35, -W / 2 + 1.6 + j * 3.2, c2, 18);
        perches.push([1.6, H * 2 + 1.2, 0]);
      } else perches.push([0, H + 0.2, 0]);
      break;
    }
    case 'dice': {
      const S = 6, pip = 0x16181c, c = rng() < 0.7 ? 0xf6f6f2 : pickC(rng);
      b.box(S, S, S, 0, S / 2, 0, c);
      // Pips: 5 on top, 1–4 on the sides.
      const face = (n: number, place: (u: number, v: number) => void) => {
        const at: [number, number][] = n === 1 ? [[0, 0]] : n === 2 ? [[-1, -1], [1, 1]] : n === 3 ? [[-1, -1], [0, 0], [1, 1]]
          : n === 4 ? [[-1, -1], [1, -1], [-1, 1], [1, 1]] : [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]];
        for (const [u, v] of at) place(u * 1.6, v * 1.6);
      };
      const pc = c === 0xf6f6f2 ? pip : 0xf6f6f2;
      face(5, (u, v) => b.cyl(0.6, 0.6, 0.12, u, S + 0.03, v, pc, 12));
      face(1, (u, v) => b.cyl(0.6, 0.6, 0.12, u, S / 2 + v, -S / 2 - 0.03, pc, 12, 'z'));
      face(2, (u, v) => b.cyl(0.6, 0.6, 0.12, S / 2 + 0.03, S / 2 + v, u, pc, 12, 'x'));
      face(3, (u, v) => b.cyl(0.6, 0.6, 0.12, u, S / 2 + v, S / 2 + 0.03, pc, 12, 'z'));
      face(4, (u, v) => b.cyl(0.6, 0.6, 0.12, -S / 2 - 0.03, S / 2 + v, u, pc, 12, 'x'));
      perches.push([0, S + 0.2, 0]);
      break;
    }
    case 'ball': {
      // A striped beach ball.
      const R = 5, g = b.ball(R, 0, R - 0.3, 0, 0xffffff, 1, 1, 1, 28);
      const cols = [0xe3342f, 0xf4f4f4, 0x2f6fe0, 0xffc21a, 0x2fb84a, 0xf4f4f4].map((k) => new Color(k));
      const p = g.getAttribute('position'), col = g.getAttribute('color') as BufferAttribute;
      for (let i = 0; i < p.count; i += 3) {
        // Colour per triangle (by its centre) so the stripes have clean edges.
        const cx = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3, cy = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3 - (R - 0.3);
        const cz = (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3;
        const c = Math.abs(cy) > R * 0.93 ? new Color(0xf4f4f4) : cols[Math.floor(((Math.atan2(cz, cx) + Math.PI) / (Math.PI * 2)) * 6) % 6];
        for (let k = 0; k < 3; k++) col.setXYZ(i + k, c.r, c.g, c.b);
      }
      b.solid(-3.6, 0, -3.6, 3.6, R * 2 - 1.2, 3.6);
      b.solid(-4.6, 1.8, -4.6, 4.6, 7.2, 4.6);
      break;
    }
    case 'crayon': {
      // A crayon lying on its side: paper wrapper, bands, and a sharpened tip.
      const c = new Color(pickC(rng, TOY_COLORS.slice(0, 8))), paper = c.clone().lerp(new Color(0xffffff), 0.25), band = c.clone().multiplyScalar(0.55);
      const R = 1.5, L = 15;
      b.cyl(R, R, L, 0, R, 0, paper, 8, 'x');
      for (const x of [-L / 2 + 1.2, -L / 2 + 2.2, L / 2 - 2.2, L / 2 - 1.2]) b.cyl(R + 0.06, R + 0.06, 0.4, x, R, 0, band, 8, 'x');
      b.cyl(R * 0.97, R * 0.97, 1.4, L / 2 + 0.7, R, 0, c, 8, 'x');
      b.cone(R * 0.97, 3.2, L / 2 + 1.4 + 1.6, R, 0, c, 8, 'x');
      b.cyl(R * 0.97, R * 0.97, 0.5, -L / 2 - 0.25, R, 0, c, 8, 'x');
      b.solid(-L / 2 - 0.5, 0, -R, L / 2 + 2.4, R * 2, R);
      perches.push([0, R * 2 + 0.2, 0]);
      break;
    }
    case 'rings': {
      // Stacking rings on a post, biggest at the bottom.
      const cols = [0xe3342f, 0xff7a1a, 0xffc21a, 0x2fb84a, 0x2f6fe0, 0x8b3fe0];
      b.cyl(5.5, 6, 1.2, 0, 0.6, 0, 0xf4f4f4, 24);
      b.solid(-4.2, 0, -4.2, 4.2, 1.2, 4.2);
      let y = 1.2;
      cols.forEach((c, i) => {
        const r = 4.4 - i * 0.55, t = 1.1 - i * 0.08;
        b.torus(r, t, 0, y + t, 0, c);
        b.solid(-(r + t) * 0.72, y, -(r + t) * 0.72, (r + t) * 0.72, y + t * 2, (r + t) * 0.72);
        y += t * 2;
      });
      b.cyl(0.8, 0.8, y + 1.5, 0, (y + 1.5) / 2, 0, 0xf4f4f4, 12);
      b.ball(1.6, 0, y + 2.2, 0, 0xe3342f, 1, 1, 1, 14);
      b.solid(-1.1, 0, -1.1, 1.1, y + 3.6, 1.1);
      break;
    }
    case 'rocket': {
      // A toy space rocket standing on its fins.
      const body = pickC(rng, [0xf4f4f4, 0xe3342f, 0x2f6fe0]), trim = body === 0xe3342f ? 0xf4f4f4 : 0xe3342f, H = 20;
      b.cyl(3.2, 3.2, H, 0, 2.5 + H / 2, 0, body, 20);
      b.cone(3.2, 8, 0, 2.5 + H + 4, 0, trim, 20);
      b.cyl(2.4, 3.0, 2.5, 0, 1.25, 0, 0x55595e, 16);
      for (const [x, z, w, d] of [[4, 0, 3, 0.6], [-4, 0, 3, 0.6], [0, 4, 0.6, 3], [0, -4, 0.6, 3]]) b.box(w, 7, d, x, 3.5, z, trim);
      for (const y of [12, 17]) {
        b.cyl(1.2, 1.2, 0.4, 0, 2.5 + y, -3.2, 0xffc21a, 16, 'z');
        b.cyl(0.9, 0.9, 0.5, 0, 2.5 + y, -3.25, 0x5ad1ff, 16, 'z');
      }
      b.cyl(3.3, 3.3, 0.8, 0, 2.5 + H * 0.35, 0, trim, 20);
      b.solid(-2.4, 0, -2.4, 2.4, 2.5 + H + 5, 2.4);
      break;
    }
    case 'teddy': {
      // A huge teddy bear sitting with its legs out: climb into its lap for the view.
      const hue = rng(), fur = hue < 0.6 ? new Color(0x9a6232) : hue < 0.8 ? new Color(0xe8a6c0) : new Color(0x8ab4e8);
      const pale = fur.clone().lerp(new Color(0xffffff), 0.45), dark = 0x2a1a14, bow = pickC(rng, [0xe3342f, 0x2f6fe0, 0x8b3fe0]);
      b.ball(6.5, 0, 6.5, 1, fur, 1, 1.05, 0.9, 22);
      b.ball(4.5, 0, 6.2, -3.4, pale, 1, 1.1, 0.5, 18);
      b.ball(5, 0, 15.2, 0.8, fur, 1, 0.95, 0.95, 22);
      for (const s of [-1, 1]) {
        b.ball(1.8, s * 3.6, 19.4, 0.8, fur, 1, 1, 0.55, 14);
        b.ball(1.1, s * 3.6, 19.4, 0.2, pale, 1, 1, 0.4, 12);
        b.cyl(0.55, 0.55, 0.3, s * 1.8, 16.4, -3.8, dark, 14, 'z');
        // Legs forward, paws up.
        b.cyl(2.2, 2.4, 8, s * 3.2, 2.2, -5, fur, 16, 'z');
        b.ball(2.4, s * 3.2, 2.4, -9.2, pale, 1, 1.1, 0.5, 14);
        // Arms resting on the tummy.
        b.cyl(1.6, 1.8, 7, s * 5.8, 7, -1.6, fur, 14, 'z');
      }
      b.ball(2, 0, 13.8, -3.6, pale, 1.1, 0.8, 0.8, 14);
      b.ball(0.7, 0, 14.6, -5.1, dark, 1.3, 0.9, 1, 10);
      b.box(2.4, 1.6, 1, -1.4, 11.2, -3.6, bow, false);
      b.box(2.4, 1.6, 1, 1.4, 11.2, -3.6, bow, false);
      b.solid(-5.2, 0, -3.5, 5.2, 12, 5.8);
      b.solid(-3.4, 11, -3.2, 3.4, 19.5, 4.2);
      b.solid(-5.6, 0, -10.8, 5.6, 4.4, -3.4);
      perches.push([0, 4.6, -7]);
      break;
    }
    case 'duck': {
      // A rubber duck bobbing in the water.
      const Y = 0xffd21a;
      b.ball(4.5, 0, 0.8, 0.6, Y, 1, 0.7, 1.35, 20);
      b.ball(3, 0, 5.4, -3.2, Y, 1, 1, 1, 18);
      b.cone(1.2, 2.2, 0, 6.2, 3.6, Y, 10, 'z');
      b.ball(1.4, 0, 4.9, -6, 0xff7a1a, 1.2, 0.45, 1.3, 12);
      for (const s of [-1, 1]) b.ball(0.45, s * 1.5, 6.2, -5.5, 0x16181c, 1, 1, 0.6, 10);
      b.solid(-4, -1, -4.5, 4, 3.8, 6.5);
      b.solid(-2.4, 3.8, -5.6, 2.4, 8.2, -0.8);
      perches.push([0, 3.9, 3]);
      break;
    }
  }
  return { b, perches };
}

/** 5×7 pixel letters for the words painted inside the toy chest. */
const FONT: Record<string, string[]> = {
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

/**
 * The toy chest round the whole island: four huge wooden walls (plank stripes, a painted rim) with
 * words in giant letters on the inside. Visual only; drawn without fog so they frame the horizon.
 */
export function buildToyChest(D: number, H: number) {
  const b = new ToyBuilder();
  const T = 30, planks = 8, wood = [0xc98a4b, 0xb97a3d];
  const walls: { word: string; cx: number; cz: number; along: 'x' | 'z'; face: number }[] = [
    { word: 'TOY BOX', cx: 0, cz: -D, along: 'x', face: 1 },
    { word: 'ABC', cx: 0, cz: D, along: 'x', face: -1 },
    { word: 'PLAY', cx: D, cz: 0, along: 'z', face: -1 },
    { word: '123', cx: -D, cz: 0, along: 'z', face: 1 },
  ];
  for (const w of walls) {
    const len = D * 2 + T * 2;
    // Planks from below the sea up to the rim.
    const ph = (H + 60) / planks;
    for (let i = 0; i < planks; i++) {
      const y = -60 + ph * (i + 0.5);
      if (w.along === 'x') b.box(len, ph - 1, T, w.cx, y, w.cz + (-w.face * T) / 2, wood[i % 2], false);
      else b.box(T, ph - 1, len, w.cx + (-w.face * T) / 2, y, w.cz, wood[i % 2], false);
    }
    // Painted rim along the top.
    if (w.along === 'x') b.box(len + 10, 24, T + 10, w.cx, H + 10, w.cz + (-w.face * T) / 2, 0xe3342f, false);
    else b.box(T + 10, 24, len + 10, w.cx + (-w.face * T) / 2, H + 10, w.cz, 0xe3342f, false);
    // The word, in pixels, one colour per letter.
    const px = 22, gap = px, cw = 5 * px + gap, total = w.word.length * cw - gap;
    [...w.word].forEach((ch, li) => {
      const rows = FONT[ch] ?? FONT[' '], col = TOY_COLORS[(li * 3 + w.word.length) % 8];
      rows.forEach((row, r) => {
        [...row].forEach((on, c) => {
          if (on !== '#') return;
          const u = -total / 2 + li * cw + c * px + px / 2, y = H * 0.62 - r * px;
          // Letters read left to right from inside the chest.
          if (w.along === 'x') b.box(px - 2, px - 2, 3, w.cx + u * w.face, y, w.cz + w.face * 1.5, col, false);
          else b.box(3, px - 2, px - 2, w.cx + w.face * 1.5, y, w.cz - u * w.face, col, false);
        });
      });
    });
  }
  const mat = plastic({ vertexColors: true, fog: false }, 0.75);
  const { mesh } = b.finish(0, 0, 0, 0, mat);
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  return mesh;
}

/** The ball-pit sea: a tile of packed plastic balls, repeated across the whole water plane. */
export function ballPitCanvas() {
  const N = 256, cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#1b3f8a';
  ctx.fillRect(0, 0, N, N);
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const cols = ['#e3342f', '#2f6fe0', '#ffc21a', '#2fb84a', '#ff7a1a', '#8b3fe0', '#e83e8c', '#14b8a6'];
  for (let i = 0; i < 260; i++) {
    const x = rnd() * N, y = rnd() * N, r = 12 + rnd() * 4, c = cols[Math.floor(rnd() * cols.length)];
    // Draw wrapped so the tile repeats seamlessly.
    for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) {
      const g = ctx.createRadialGradient(x + ox - r * 0.35, y + oy - r * 0.35, r * 0.1, x + ox, y + oy, r);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.25, c);
      g.addColorStop(1, c);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return cv;
}
