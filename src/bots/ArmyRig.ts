import {
  Bone, BufferAttribute, BufferGeometry, CapsuleGeometry, Color, CylinderGeometry, Group, Matrix4, Quaternion, Skeleton, SkinnedMesh,
  SphereGeometry, Vector3, type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { roundedBox } from '../core/roundBox';

/**
 * A plastic army man with real human proportions (helmet, webbing, pouches, boots), on a small
 * skeleton that is posed in code: walk and run cycles, crouch, jump, sitting, both hands on the gun
 * (two-bone IK), and going limp when shot. One skinned mesh per figure.
 *
 * Built in character space: feet at y = 0, facing -Z, about 1.85 m to the top of the helmet.
 */

// Bones: index, parent, rest position (character space).
const HIPS = 0, SPINE = 1, CHEST = 2, NECK = 3, HEAD = 4;
const UA_R = 5, LA_R = 6, HAND_R = 7, UA_L = 8, LA_L = 9, HAND_L = 10;
const UL_R = 11, LL_R = 12, FOOT_R = 13, UL_L = 14, LL_L = 15, FOOT_L = 16;
const SH_X = 0.225, HIP_X = 0.095;
const Y_HIPS = 0.95, Y_ELBOW = 1.16, Y_WRIST = 0.92, Y_KNEE = 0.51, Y_ANKLE = 0.09;
const REST: [number, number, number, number][] = [
  [-1, 0, Y_HIPS, 0], [HIPS, 0, 1.06, 0], [SPINE, 0, 1.26, 0], [CHEST, 0, 1.5, 0], [NECK, 0, 1.57, 0],
  [CHEST, SH_X, 1.45, 0], [UA_R, SH_X, Y_ELBOW, 0], [LA_R, SH_X, Y_WRIST, 0],
  [CHEST, -SH_X, 1.45, 0], [UA_L, -SH_X, Y_ELBOW, 0], [LA_L, -SH_X, Y_WRIST, 0],
  [HIPS, HIP_X, 0.92, 0], [UL_R, HIP_X, Y_KNEE, 0], [LL_R, HIP_X, Y_ANKLE, 0],
  [HIPS, -HIP_X, 0.92, 0], [UL_L, -HIP_X, Y_KNEE, 0], [LL_L, -HIP_X, Y_ANKLE, 0],
];

/** Which bone a part follows; near a joint it blends into the neighbour (y of the joint, blend distance). */
interface Rule {
  b: number;
  up?: [number, number, number];
  dn?: [number, number, number];
}

function prep(g: BufferGeometry) {
  const n = g.index ? g.toNonIndexed() : g;
  if (n.getAttribute('uv')) n.deleteAttribute('uv');
  return n;
}
const at = (g: BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => prep(g.rotateX(rx).rotateY(ry).rotateZ(rz).translate(x, y, z));
const sph = (r: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, seg = 14) => at(new SphereGeometry(r, seg, Math.round(seg * 0.7)).scale(sx, sy, sz), x, y, z);
const cyl = (rt: number, rb: number, h: number, x: number, y: number, z: number, sz = 1, seg = 16) => at(new CylinderGeometry(rt, rb, h, seg).scale(1, 1, sz), x, y, z);
const cap = (r: number, len: number, x: number, y: number, z: number, sx = 1, sz = 1) => at(new CapsuleGeometry(r, len, 4, 14).scale(sx, 1, sz), x, y, z);
const box = (w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, k = 0.3) => at(roundedBox(w, h, d, k), x, y, z, rx, ry, rz);

/** The figure, in one colour of plastic (a little darker for straps and boots, so the shapes read). */
function buildGeometry(p: Color, crown: boolean) {
  const dk = p.clone().multiplyScalar(0.8), lt = p.clone().lerp(new Color(0xffffff), 0.06), eye = p.clone().multiplyScalar(0.4);
  const parts: { g: BufferGeometry; c: Color; r: Rule }[] = [];
  const add = (g: BufferGeometry, c: Color, r: Rule) => parts.push({ g, c, r });

  // --- Head: face, helmet, chin strap ---
  const head: Rule = { b: HEAD };
  add(sph(0.098, 0, 1.665, 0.004, 1, 1.18, 1.08), p, head); // skull
  add(sph(0.07, 0, 1.6, -0.028, 1.05, 0.82, 1.0), p, head); // jaw and chin
  add(box(0.026, 0.05, 0.034, 0, 1.64, -0.103, -0.18), p, head); // nose
  add(box(0.13, 0.02, 0.03, 0, 1.682, -0.094), p, head); // brow
  for (const s of [-1, 1]) {
    add(sph(0.012, s * 0.036, 1.664, -0.094, 1.3, 0.8, 0.5, 8), eye, head); // eyes
    add(sph(0.022, s * 0.098, 1.655, 0.006, 0.45, 1, 0.8, 8), p, head); // ears
    add(box(0.012, 0.11, 0.012, s * 0.098, 1.62, -0.012, 0, 0, s * 0.12), dk, head); // chin strap
  }
  add(box(0.05, 0.008, 0.01, 0, 1.604, -0.094), eye, head); // mouth
  add(at(new SphereGeometry(0.136, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.86, 1.1), 0, 1.69, 0.01), lt, head); // helmet
  add(cyl(0.142, 0.152, 0.02, 0, 1.69, 0.01, 1.1, 20), lt, head); // helmet rim
  if (crown) {
    const gold = new Color(0xffc21a), gem = new Color(0xff2a6a);
    add(cyl(0.12, 0.11, 0.07, 0, 1.83, 0.01), gold, head);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      add(box(0.045, 0.08, 0.045, Math.cos(a) * 0.11, 1.89, 0.01 + Math.sin(a) * 0.11), gold, head);
      add(sph(0.022, Math.cos(a) * 0.11, 1.94, 0.01 + Math.sin(a) * 0.11, 1, 1, 1, 6), gem, head);
    }
  }

  // --- Neck and collar ---
  add(cyl(0.048, 0.055, 0.12, 0, 1.54, 0.005), p, { b: NECK, dn: [CHEST, 1.5, 0.03] });
  add(cyl(0.07, 0.085, 0.05, 0, 1.505, 0.005, 0.95), p, { b: CHEST });
  for (const s of [-1, 1]) add(box(0.07, 0.012, 0.06, s * 0.045, 1.49, -0.06, 0.5, s * 0.5, 0), p, { b: CHEST }); // collar points

  // --- Torso: jacket, shoulders, pockets, webbing, backpack ---
  const chest: Rule = { b: CHEST, dn: [SPINE, 1.2, 0.06] };
  add(cyl(0.195, 0.165, 0.34, 0, 1.33, 0, 0.6, 20), p, chest); // chest
  add(sph(0.2, 0, 1.44, 0, 1.08, 0.36, 0.62), p, { b: CHEST }); // shoulder line
  for (const s of [-1, 1]) {
    add(sph(0.068, s * 0.205, 1.43, 0, 1, 0.95, 1), p, { b: CHEST }); // deltoids
    add(box(0.085, 0.075, 0.02, s * 0.085, 1.33, -0.113), p, { b: CHEST }); // breast pockets
    add(box(0.092, 0.03, 0.024, s * 0.085, 1.375, -0.116), dk, { b: CHEST }); // pocket flaps
    add(box(0.032, 0.44, 0.014, s * 0.1, 1.24, -0.12, 0.05, 0, s * -0.12), dk, { b: CHEST }); // webbing straps, front
    add(box(0.032, 0.42, 0.014, s * 0.1, 1.25, 0.125, 0, 0, s * 0.12), dk, { b: CHEST }); // and back
    add(box(0.045, 0.02, 0.1, s * 0.16, 1.47, 0.005), dk, { b: CHEST }); // over the shoulders
  }
  add(box(0.012, 0.3, 0.012, 0, 1.27, -0.118), dk, { b: CHEST }); // button placket
  add(box(0.26, 0.3, 0.11, 0, 1.3, 0.16, 0, 0, 0, 0.35), p, { b: CHEST }); // backpack
  add(box(0.22, 0.08, 0.03, 0, 1.36, 0.22), dk, { b: CHEST }); // backpack flap
  add(at(new CapsuleGeometry(0.045, 0.26, 3, 12), 0, 1.47, 0.16, 0, 0, Math.PI / 2), lt, { b: CHEST }); // bedroll
  add(cyl(0.165, 0.17, 0.22, 0, 1.12, 0, 0.64, 20), p, { b: SPINE, up: [CHEST, 1.2, 0.06], dn: [HIPS, 1.02, 0.05] }); // stomach

  // --- Hips: belt with ammo pouches, canteen ---
  add(cyl(0.17, 0.165, 0.16, 0, 0.94, 0, 0.7, 20), p, { b: HIPS, up: [SPINE, 1.02, 0.05] }); // seat of the trousers
  add(cyl(0.178, 0.178, 0.05, 0, 1.0, 0, 0.7, 20), dk, { b: HIPS }); // belt
  add(box(0.05, 0.04, 0.02, 0, 1.0, -0.125), lt, { b: HIPS }); // buckle
  for (const s of [-1, 1]) {
    add(box(0.07, 0.075, 0.045, s * 0.09, 0.975, -0.115), dk, { b: HIPS }); // ammo pouches
    add(box(0.06, 0.07, 0.05, s * 0.16, 0.975, -0.05, 0, s * -0.7, 0), dk, { b: HIPS });
  }
  add(cyl(0.045, 0.045, 0.11, 0.13, 0.94, 0.1, 0.75, 12), lt, { b: HIPS }); // canteen
  add(cyl(0.015, 0.015, 0.03, 0.13, 1.005, 0.1, 1, 8), dk, { b: HIPS });

  // --- Arms: sleeves rolled at the forearm, fists ---
  for (const [s, ua, la, hand] of [[1, UA_R, LA_R, HAND_R], [-1, UA_L, LA_L, HAND_L]]) {
    const x = s * SH_X;
    add(cap(0.056, 0.24, x, 1.315, 0), p, { b: ua, dn: [la, Y_ELBOW, 0.045] }); // upper arm
    add(box(0.02, 0.07, 0.07, x + s * 0.052, 1.34, 0), p, { b: ua }); // sleeve pocket
    add(cap(0.05, 0.19, x, 1.04, 0, 1, 1.05), p, { b: la, up: [ua, Y_ELBOW, 0.045], dn: [hand, Y_WRIST, 0.025] }); // forearm
    add(cyl(0.056, 0.058, 0.045, x, 1.1, 0, 1, 14), lt, { b: la }); // rolled cuff
    add(sph(0.045, x, 0.875, -0.004, 0.82, 1.2, 1.08, 12), p, { b: hand }); // fist
    add(sph(0.018, x - s * 0.03, 0.9, -0.03, 1, 1.4, 1, 8), p, { b: hand }); // thumb
  }

  // --- Legs: trousers with cargo pockets, laced boots ---
  for (const [s, ul, ll, foot] of [[1, UL_R, LL_R, FOOT_R], [-1, UL_L, LL_L, FOOT_L]]) {
    const x = s * HIP_X;
    add(cyl(0.088, 0.07, 0.46, x, 0.72, 0, 1, 16), p, { b: ul, up: [HIPS, 0.9, 0.05], dn: [ll, Y_KNEE, 0.05] }); // thigh
    add(box(0.03, 0.12, 0.1, x + s * 0.08, 0.7, 0.005), p, { b: ul }); // cargo pocket
    add(sph(0.07, x, Y_KNEE, -0.01, 1, 1, 1, 12), p, { b: ll }); // knee
    add(cyl(0.066, 0.058, 0.3, x, 0.34, 0, 1, 16), p, { b: ll, up: [ul, Y_KNEE, 0.05] }); // shin
    add(cyl(0.068, 0.066, 0.05, x, 0.215, 0, 1, 14), lt, { b: ll }); // trousers bloused over the boot
    add(cyl(0.064, 0.06, 0.13, x, 0.13, 0, 1, 14), dk, { b: ll, dn: [foot, Y_ANKLE, 0.02] }); // boot upper
    for (let i = 0; i < 3; i++) add(box(0.05, 0.008, 0.012, x, 0.1 + i * 0.035, -0.06), p, { b: ll }); // laces
    add(box(0.1, 0.075, 0.24, x, 0.045, -0.045, 0, 0, 0, 0.4), dk, { b: foot }); // boot
    add(box(0.108, 0.02, 0.25, x, 0.01, -0.045), eye, { b: foot }); // sole
  }

  // Colours and skin weights, then one geometry.
  const out: BufferGeometry[] = [];
  for (const { g, c, r } of parts) {
    const pos = g.getAttribute('position'), n = pos.count;
    const col = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      col.set([c.r, c.g, c.b], i * 3);
      const y = pos.getY(i);
      const wu = r.up ? Math.min(1, Math.max(0, 0.5 + (0.5 * (y - r.up[1])) / r.up[2])) : 0;
      const wd = r.dn ? Math.min(1, Math.max(0, 0.5 + (0.5 * (r.dn[1] - y)) / r.dn[2])) : 0;
      si.set([r.b, r.up ? r.up[0] : 0, r.dn ? r.dn[0] : 0, 0], i * 4);
      sw.set([Math.max(0, 1 - wu - wd), wu, wd, 0], i * 4);
    }
    g.setAttribute('color', new BufferAttribute(col, 3));
    g.setAttribute('skinIndex', new BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new BufferAttribute(sw, 4));
    out.push(g);
  }
  const merged = mergeGeometries(out)!;
  merged.computeBoundingSphere();
  return merged;
}

const geoCache = new Map<string, BufferGeometry>();

/** The plastic colour for a suit: always a saturated, fairly dark shade (green stays army green). */
export function plasticOf(suit: Color) {
  const hsl = { h: 0, s: 0, l: 0 };
  suit.getHSL(hsl);
  return new Color().setHSL(hsl.h, Math.min(0.62, Math.max(0.4, hsl.s)), Math.min(0.3, Math.max(0.15, 0.1 + hsl.l * 0.6)));
}

const DOWN = new Vector3(0, -1, 0);
/** Where the gun sits (character space) and how the chest turns to hold it (a bladed stance). */
const GUN_AT = new Vector3(0.12, 1.34, -0.16), STANCE = -0.3;
/** Resting arm directions for the lobby poses (shoulder → hand on the gun). */
export const ARMY_HOLD: [Vector3, Vector3] = [new Vector3(-0.1, -0.35, -0.9).normalize(), new Vector3(0.45, -0.3, -0.84).normalize()];

const v1 = new Vector3(), v2 = new Vector3(), v3 = new Vector3(), v4 = new Vector3(), v5 = new Vector3(), q1 = new Quaternion(), q2 = new Quaternion();
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const approach = (v: number, t: number, rate: number, dt: number) => v + (t - v) * Math.min(1, dt * rate);

export class ArmyRig {
  root = new Group();
  mesh: SkinnedMesh;
  bones: Bone[] = [];
  /** The gun goes in here (grip at the origin, barrel along -Z); both hands reach for it. */
  gunMount = new Group();
  dead = false;
  private gripR = new Vector3(0, -0.07, 0.01);
  private gripL = new Vector3(0, -0.08, -0.32);
  private phase = Math.random() * 6;
  private moveK = 0;
  private crouchK = 0;
  private airK = 0;
  private seatK = 0;
  private armK = 0;
  private deathT = 0;
  private breath = Math.random() * 6;
  private hideUpper = false;
  /** Lobby poses: arm directions in character space (null = on the gun). */
  poseR: Vector3 | null = null;
  poseL: Vector3 | null = null;

  constructor(suit: Color, mat: Material, crown = false) {
    const p = plasticOf(suit), key = p.getHexString() + (crown ? 'c' : '');
    let geo = geoCache.get(key);
    if (!geo) geoCache.set(key, (geo = buildGeometry(p, crown)));
    for (const [parent, x, y, z] of REST) {
      const b = new Bone();
      if (parent >= 0) {
        const [, px, py, pz] = REST[parent];
        b.position.set(x - px, y - py, z - pz);
        this.bones[parent].add(b);
      } else b.position.set(x, y, z);
      this.bones.push(b);
    }
    this.mesh = new SkinnedMesh(geo, mat);
    this.mesh.add(this.bones[HIPS]);
    this.mesh.bind(new Skeleton(this.bones));
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.root.add(this.mesh);
    // The gun hangs off the chest, so it leans and turns with the body.
    const chest = this.bones[CHEST];
    chest.rotation.y = STANCE;
    this.root.updateMatrixWorld(true);
    const m = new Matrix4().copy(chest.matrixWorld).invert().multiply(new Matrix4().makeTranslation(GUN_AT.x, GUN_AT.y, GUN_AT.z));
    m.decompose(this.gunMount.position, this.gunMount.quaternion, this.gunMount.scale);
    chest.add(this.gunMount);
  }

  get skeleton() {
    return this.mesh.skeleton;
  }

  /** Where the hands go on this gun (its grip, and under the front of it). */
  setGunShape(geo: BufferGeometry | null, scale: number) {
    if (!geo) return;
    geo.computeBoundingBox();
    const b = geo.boundingBox!, p = geo.getAttribute('position');
    const zf = b.min.z * 0.42;
    let lo = Infinity, gl = Infinity;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i), z = p.getZ(i);
      if (Math.abs(z - zf) < 0.05) lo = Math.min(lo, y);
      if (Math.abs(z) < 0.04) gl = Math.min(gl, y);
    }
    this.gripR.set(0, (gl === Infinity ? -0.08 : gl * 0.55) * scale, 0.02 * scale);
    this.gripL.set(0, (lo === Infinity ? -0.06 : lo - 0.01) * scale, zf * scale);
  }

  legsOnly() {
    this.hideUpper = true;
    this.gunMount.visible = false;
  }

  get legs() {
    return [this.bones[UL_L], this.bones[UL_R]];
  }

  animate(dt: number, speed: number, onGround: boolean, crouched: boolean, seated: boolean, armed: boolean) {
    if (this.dead) return this.tick(dt);
    const B = this.bones;
    this.moveK = approach(this.moveK, Math.min(1, speed / 2.5), 8, dt);
    this.crouchK = approach(this.crouchK, crouched && !seated ? 1 : 0, 10, dt);
    this.airK = approach(this.airK, !onGround && !seated ? 1 : 0, 7, dt);
    this.seatK = approach(this.seatK, seated ? 1 : 0, 10, dt);
    this.armK = approach(this.armK, armed ? 1 : 0, 10, dt);
    this.breath += dt * 1.7;
    if (speed > 0.3) this.phase += dt * Math.min(12.5, 3 + speed * 0.95);
    const run = clamp((speed - 5) / 4, 0, 1), ck = this.crouchK, ak = this.airK, sk = this.seatK;
    const amp = this.moveK * (0.42 + 0.38 * run) * (1 - ak) * (1 - sk) * (1 - ck * 0.35);
    const s = Math.sin(this.phase), c = Math.cos(this.phase);
    for (const b of B) b.rotation.set(0, 0, 0);

    // Legs: swing, bend the knee on the way forward, keep the foot roughly flat.
    const legs: [number, number, number, number][] = [[UL_R, LL_R, FOOT_R, 1], [UL_L, LL_L, FOOT_L, -1]];
    for (const [ul, ll, ft, side] of legs) {
      let th = side * s * amp, kn = Math.max(0, side * c) * amp * (1.5 + run) + 0.06 * this.moveK;
      th += ck * 1.25 + ak * (side > 0 ? 0.75 : 0.05) + sk * 1.5;
      kn += ck * 2.0 + ak * (side > 0 ? 1.1 : 0.45) + sk * 1.5;
      B[ul].rotation.x = th;
      B[ll].rotation.x = -kn;
      B[ft].rotation.x = clamp(kn - th, -0.6, 1.2) * (1 - sk * 0.5);
      B[ul].rotation.z = side * (0.02 + ck * 0.12);
    }
    // Body: bob with each step, lean into a run, sink into a crouch or a seat.
    const hips = B[HIPS];
    hips.position.y = Y_HIPS - Math.abs(c) * 0.035 * amp - ck * 0.4 - sk * 0.42 - ak * 0.08;
    hips.rotation.y = s * amp * 0.18;
    B[SPINE].rotation.x = -(0.05 * this.moveK + 0.2 * run) * (1 - sk) - ck * 0.22;
    B[CHEST].rotation.x = Math.sin(this.breath) * 0.015 - ck * 0.08;
    B[CHEST].rotation.y = -hips.rotation.y + STANCE * this.armK;
    B[HEAD].rotation.x = -(B[SPINE].rotation.x + B[CHEST].rotation.x) * 0.8;
    B[HEAD].rotation.y = -STANCE * this.armK * 0.8;
    B[SPINE].scale.setScalar(this.hideUpper ? 1e-4 : 1);

    // Arms: on the gun, swinging, or where the lobby points them.
    if (this.hideUpper) return;
    const posed = this.poseR || this.poseL;
    if (this.armK > 0.5 || posed) {
      this.root.updateMatrixWorld(true);
      this.root.getWorldQuaternion(q1);
      const gm = this.gunMount;
      const tR = gm.localToWorld(v4.copy(this.gripR)), tL = gm.localToWorld(v5.copy(this.gripL));
      if (this.poseR) this.pointTarget(UA_R, this.poseR, tR, ARMY_HOLD[0]);
      if (this.poseL) this.pointTarget(UA_L, this.poseL, tL, ARMY_HOLD[1]);
      this.ik(UA_R, tR, 1);
      this.ik(UA_L, tL, -1);
    } else {
      for (const [ua, la, side] of [[UA_R, LA_R, 1], [UA_L, LA_L, -1]]) {
        B[ua].rotation.set(-side * s * amp * 0.9 + ck * 0.3 + ak * -0.4, 0, side * (0.08 + ak * 0.5));
        B[la].rotation.x = 0.2 + run * 1.1 + ck * 0.4 + ak * 0.6;
      }
    }
  }

  /** Lobby: moves a hand target out along a pointing direction (blending from the gun as it turns away). */
  private pointTarget(ua: number, dir: Vector3, target: Vector3, hold: Vector3) {
    const k = clamp(dir.angleTo(hold) / 0.45, 0, 1);
    if (k <= 0) return;
    const S = this.bones[ua].getWorldPosition(v1);
    const d = v2.copy(dir).normalize().applyQuaternion(q1).multiplyScalar(0.6 * this.root.getWorldScale(v3).x);
    target.lerp(v3.copy(S).add(d), k);
  }

  /** Two-bone IK: shoulder → elbow → fist onto `target` (world), elbow pointing down and out. */
  private ik(ua: number, target: Vector3, side: number) {
    const U = this.bones[ua], L = this.bones[ua + 1], H = this.bones[ua + 2];
    const S = U.getWorldPosition(v1).clone(), E0 = L.getWorldPosition(v2).clone();
    const F0 = H.localToWorld(v3.set(0, -0.045, 0));
    const a = S.distanceTo(E0), b = E0.distanceTo(F0);
    const d = v2.subVectors(target, S);
    const len = clamp(d.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3);
    const n = d.normalize();
    // Trigger arm: elbow out to the side; support arm: elbow tucked down under the gun.
    const pole = (side > 0 ? v3.set(1, -0.45, 0.25) : v3.set(-0.35, -1, 0.05)).applyQuaternion(q1);
    pole.addScaledVector(n, -pole.dot(n)).normalize();
    const x = (a * a - b * b + len * len) / (2 * len), h = Math.sqrt(Math.max(0, a * a - x * x));
    const E = S.clone().addScaledVector(n, x).addScaledVector(pole, h);
    const T = S.clone().addScaledVector(n, len);
    U.parent!.getWorldQuaternion(q2).invert();
    U.quaternion.setFromUnitVectors(DOWN, v4.subVectors(E, S).normalize().applyQuaternion(q2));
    U.getWorldQuaternion(q2).invert();
    L.quaternion.setFromUnitVectors(DOWN, v4.subVectors(T, E).normalize().applyQuaternion(q2));
    H.rotation.set(0.35, 0, 0);
  }

  die() {
    this.dead = true;
    this.deathT = 0;
  }

  revive() {
    this.dead = false;
    for (const b of this.bones) b.rotation.set(0, 0, 0);
  }

  /** Going limp (the whole figure topples; this is the arms flopping and the knees giving). */
  tick(dt: number) {
    if (!this.dead) return;
    this.deathT += dt;
    const B = this.bones, k0 = Math.min(1, this.deathT / 0.5), k = k0 * k0 * (3 - 2 * k0);
    B[HIPS].position.y = Y_HIPS;
    B[HIPS].rotation.set(0, 0, 0);
    B[SPINE].rotation.set(0.12 * k, 0, 0);
    B[CHEST].rotation.set(0.1 * k, 0, 0);
    B[HEAD].rotation.set(0.35 * k, 0, 0.25 * k);
    B[UA_R].rotation.set(0.5 * k, 0, 1.25 * k);
    B[LA_R].rotation.set(0.6 * k, 0, 0);
    B[UA_L].rotation.set(-0.2 * k, 0, -1.05 * k);
    B[LA_L].rotation.set(0.9 * k, 0, 0);
    B[HAND_R].rotation.set(0, 0, 0);
    B[HAND_L].rotation.set(0, 0, 0);
    B[LL_R].rotation.set(-0.45 * k, 0, 0);
    B[LL_L].rotation.set(-0.15 * k, 0, 0);
    B[FOOT_R].rotation.set(0.5 * k, 0, 0);
    B[FOOT_L].rotation.set(0.3 * k, 0, 0);
  }
}
