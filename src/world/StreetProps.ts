import { BoxGeometry, BufferGeometry, CapsuleGeometry, Color, ConeGeometry, CylinderGeometry, Euler, Float32BufferAttribute, Matrix4, SphereGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Street furniture for the towns: small multi-part models, merged into one vertex-coloured geometry
 * each so a whole city's worth draws as a handful of instanced meshes. Local space: standing on
 * y = 0, front facing +z.
 */
export type StreetPropKind = 'hydrant' | 'bin' | 'bench' | 'payphone' | 'mailbox' | 'newsbox' | 'hotdog';

/** Collision size (width along x, height, depth along z) of each prop. */
export const STREET_PROP_SIZE: Record<StreetPropKind, [number, number, number]> = {
  hydrant: [0.5, 0.85, 0.5],
  bin: [0.66, 1.05, 0.66],
  bench: [1.8, 0.52, 0.6],
  payphone: [0.72, 2.05, 0.46],
  mailbox: [0.5, 1.25, 0.5],
  newsbox: [0.5, 1.03, 0.45],
  hotdog: [2.5, 1.15, 1.15],
};

type Paint = number | ((x: number, y: number, z: number) => number);

class Kit {
  private parts: BufferGeometry[] = [];

  add(geo: BufferGeometry, color: Paint, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sy = 1) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    g.deleteAttribute('uv');
    const p = g.getAttribute('position'), n = p.count, col = new Float32Array(n * 3), c = new Color();
    for (let t = 0; t < n; t += 3) {
      const cx = (p.getX(t) + p.getX(t + 1) + p.getX(t + 2)) / 3, cy = (p.getY(t) + p.getY(t + 1) + p.getY(t + 2)) / 3, cz = (p.getZ(t) + p.getZ(t + 1) + p.getZ(t + 2)) / 3;
      c.setHex(typeof color === 'number' ? color : color(cx, cy, cz));
      for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], (t + k) * 3);
    }
    g.setAttribute('color', new Float32BufferAttribute(col, 3));
    g.applyMatrix4(new Matrix4().makeScale(1, sy, 1));
    g.applyMatrix4(new Matrix4().makeRotationFromEuler(new Euler(rx, ry, rz)).setPosition(x, y, z));
    this.parts.push(g);
    return this;
  }

  /** Box by size, centred at (x, y, z). */
  box(w: number, h: number, d: number, color: Paint, x: number, y: number, z: number, rx = 0) {
    return this.add(new BoxGeometry(w, h, d), color, x, y, z, rx);
  }

  /** Upright cylinder centred at (x, y, z); rx/rz tip it over. */
  cyl(r0: number, r1: number, h: number, color: Paint, x: number, y: number, z: number, rx = 0, rz = 0, seg = 14) {
    return this.add(new CylinderGeometry(r0, r1, h, seg), color, x, y, z, rx, 0, rz);
  }

  done() {
    const g = mergeGeometries(this.parts)!;
    for (const p of this.parts) p.dispose();
    g.computeBoundingSphere();
    return g;
  }
}

const DARK = 0x222428, STEEL = 0xc9ced4, WHITE = 0xf4f2ea, YELLOW = 0xf2c230, RED = 0xd8342c;

function hydrant() {
  const k = new Kit(), R = 0xd62d2a;
  k.cyl(0.2, 0.22, 0.08, R, 0, 0.04, 0);
  k.cyl(0.14, 0.14, 0.52, R, 0, 0.34, 0);
  k.cyl(0.18, 0.18, 0.07, R, 0, 0.6, 0);
  k.add(new SphereGeometry(0.15, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), R, 0, 0.63, 0);
  k.cyl(0.04, 0.05, 0.09, YELLOW, 0, 0.8, 0, 0, 0, 6);
  for (const s of [-1, 1]) {
    k.cyl(0.055, 0.055, 0.14, R, s * 0.17, 0.42, 0, 0, Math.PI / 2, 10);
    k.cyl(0.065, 0.065, 0.045, YELLOW, s * 0.25, 0.42, 0, 0, Math.PI / 2, 6);
  }
  k.cyl(0.075, 0.075, 0.12, R, 0, 0.38, 0.17, Math.PI / 2, 0, 10);
  k.cyl(0.085, 0.085, 0.05, YELLOW, 0, 0.38, 0.25, Math.PI / 2, 0, 6);
  return k.done();
}

function bin() {
  const k = new Kit(), G = 0x2f8a4a, D = 0x22683a;
  k.cyl(0.3, 0.26, 0.86, G, 0, 0.43, 0, 0, 0, 16);
  for (const y of [0.18, 0.5, 0.78]) k.cyl(0.31, 0.31, 0.05, D, 0, y, 0, 0, 0, 16);
  k.cyl(0.33, 0.33, 0.06, D, 0, 0.88, 0, 0, 0, 16);
  k.cyl(0.14, 0.32, 0.12, G, 0, 0.97, 0, 0, 0, 16);
  k.box(0.2, 0.05, 0.05, DARK, 0, 1.05, 0);
  // Opening on the front and a bit of rubbish poking out.
  k.box(0.22, 0.08, 0.04, DARK, 0, 0.95, 0.26);
  return k.done();
}

function bench() {
  const k = new Kit(), W = 0xb0753c, I = 0x2f3a33;
  for (const s of [-1, 1]) {
    k.box(0.07, 0.44, 0.07, I, s * 0.8, 0.22, 0.2);
    k.box(0.07, 0.9, 0.07, I, s * 0.8, 0.45, -0.22);
    k.box(0.07, 0.06, 0.5, I, s * 0.8, 0.44, 0);
    k.box(0.07, 0.05, 0.45, I, s * 0.8, 0.66, 0.02);
    k.box(0.07, 0.2, 0.05, I, s * 0.8, 0.56, 0.22);
  }
  for (const z of [-0.14, 0.01, 0.16]) k.box(1.8, 0.05, 0.13, W, 0, 0.5, z);
  for (const y of [0.68, 0.84]) k.box(1.8, 0.12, 0.04, W, 0, y, -0.25, -0.12);
  return k.done();
}

function payphone() {
  const k = new Kit(), B = 0x2a62c8;
  k.box(0.14, 1.0, 0.14, STEEL, 0, 0.5, -0.02);
  k.box(0.3, 0.06, 0.25, STEEL, 0, 0.03, -0.02);
  k.box(0.5, 0.78, 0.28, B, 0, 1.36, 0);
  k.box(0.62, 0.1, 0.42, B, 0, 1.8, 0.04);
  k.box(0.56, 0.2, 0.05, WHITE, 0, 1.96, 0.02);
  k.box(0.56, 0.05, 0.055, B, 0, 1.93, 0.02);
  for (const s of [-1, 1]) k.box(0.04, 0.72, 0.36, STEEL, s * 0.31, 1.36, 0.06);
  k.box(0.4, 0.58, 0.02, STEEL, 0, 1.36, 0.15);
  // Keypad, coin slot and the handset on its hook.
  k.box(0.15, 0.2, 0.02, DARK, 0.04, 1.28, 0.165);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) k.box(0.03, 0.03, 0.015, WHITE, 0.0 + c * 0.04, 1.35 - r * 0.045, 0.178);
  k.box(0.07, 0.015, 0.02, DARK, 0.04, 1.54, 0.165);
  k.box(0.075, 0.36, 0.08, DARK, -0.15, 1.36, 0.2);
  k.box(0.1, 0.07, 0.1, DARK, -0.15, 1.52, 0.21);
  k.box(0.1, 0.07, 0.1, DARK, -0.15, 1.2, 0.21);
  return k.done();
}

function mailbox() {
  const k = new Kit(), B = 0x2554a8;
  for (const [x, z] of [[-0.2, -0.18], [0.2, -0.18], [-0.2, 0.18], [0.2, 0.18]]) k.box(0.05, 0.32, 0.05, DARK, x, 0.16, z);
  k.box(0.48, 0.7, 0.46, B, 0, 0.66, 0);
  k.add(new CylinderGeometry(0.24, 0.24, 0.46, 16, 1, false, Math.PI / 2, Math.PI), B, 0, 1.01, 0, Math.PI / 2);
  k.box(0.3, 0.04, 0.02, DARK, 0, 1.0, 0.235);
  k.box(0.3, 0.18, 0.012, WHITE, 0, 0.68, 0.235);
  k.box(0.12, 0.04, 0.03, STEEL, 0, 0.9, 0.24);
  return k.done();
}

function newsbox() {
  const k = new Kit();
  k.box(0.4, 0.2, 0.35, DARK, 0, 0.1, 0);
  k.box(0.46, 0.72, 0.42, RED, 0, 0.56, 0);
  k.box(0.47, 0.12, 0.43, YELLOW, 0, 0.97, 0);
  k.box(0.36, 0.26, 0.012, 0x9fc6e0, 0, 0.68, 0.215);
  k.box(0.3, 0.16, 0.01, WHITE, 0, 0.68, 0.222);
  k.box(0.12, 0.05, 0.03, STEEL, 0, 0.45, 0.22);
  return k.done();
}

function hotdog() {
  const k = new Kit();
  // The cart: steel box with a red band, counter on top, two big wheels and a push handle.
  k.box(1.9, 0.76, 0.9, STEEL, 0, 0.73, 0);
  k.box(1.92, 0.14, 0.92, RED, 0, 0.92, 0);
  k.box(2.02, 0.05, 1.0, 0xa9aeb4, 0, 1.13, 0);
  k.box(1.5, 0.3, 0.012, YELLOW, 0, 0.66, 0.456);
  for (const s of [-1, 1]) {
    k.cyl(0.34, 0.34, 0.1, DARK, -0.45, 0.34, s * 0.52, Math.PI / 2, 0, 16);
    k.cyl(0.1, 0.1, 0.12, YELLOW, -0.45, 0.34, s * 0.52, Math.PI / 2, 0, 8);
    k.box(0.06, 0.36, 0.06, STEEL, 0.78, 0.18, s * 0.36);
    k.box(0.35, 0.04, 0.04, STEEL, 1.08, 1.0, s * 0.35);
  }
  k.cyl(0.03, 0.03, 0.74, DARK, 1.25, 1.0, 0, Math.PI / 2, 0, 8);
  // Sausages on the grill, ketchup and mustard.
  for (let i = 0; i < 4; i++) k.add(new CapsuleGeometry(0.035, 0.16, 3, 8), 0xb5452a, -0.55 + i * 0.12, 1.19, 0.12, 0, 0, Math.PI / 2);
  k.box(0.6, 0.02, 0.36, 0x6a6e74, -0.37, 1.16, 0.1);
  k.cyl(0.045, 0.05, 0.2, RED, 0.45, 1.25, 0.25, 0, 0, 10);
  k.cyl(0.045, 0.05, 0.2, YELLOW, 0.58, 1.25, 0.25, 0, 0, 10);
  // Striped umbrella on a pole.
  k.cyl(0.03, 0.03, 1.55, WHITE, 0, 1.9, 0, 0, 0, 8);
  const stripes = (x: number, _y: number, z: number) => (Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * 12) % 2 ? RED : YELLOW);
  k.add(new ConeGeometry(1.4, 0.5, 12, 1), stripes, 0, 2.88, 0);
  // The giant hot dog on top: bun, sausage and a squiggle of mustard.
  k.add(new CapsuleGeometry(0.17, 0.6, 4, 12), 0xe0a860, 0, 3.26, 0, 0, 0, Math.PI / 2);
  k.add(new CapsuleGeometry(0.115, 0.92, 4, 12), 0xb5452a, 0, 3.36, 0, 0, 0, Math.PI / 2);
  for (let i = 0; i < 6; i++) k.box(0.16, 0.03, 0.05, YELLOW, -0.38 + i * 0.15, 3.48, i % 2 ? 0.04 : -0.04, 0);
  return k.done();
}

const BUILDERS: Record<StreetPropKind, () => BufferGeometry> = { hydrant, bin, bench, payphone, mailbox, newsbox, hotdog };
const cache = new Map<StreetPropKind, BufferGeometry>();

export function streetPropGeometry(kind: StreetPropKind) {
  let g = cache.get(kind);
  if (!g) cache.set(kind, (g = BUILDERS[kind]()));
  return g;
}
