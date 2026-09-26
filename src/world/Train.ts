import { BoxGeometry, BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshLambertMaterial, Vector3, type Scene } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Box, CollisionWorld, MoverGroup } from '../core/Collision';
import type { Combatant } from '../game/Combat';

export interface TrackPoint {
  x: number;
  y: number;
  z: number;
}

/** A box in a car's own frame: x along the train (front = +x), y up from the rail top, z across. */
interface Piece {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  box: Box;
}

interface Car {
  len: number;
  half: number;
  /** Distance from the front of the train to this car's centre. */
  back: number;
  group: Group;
  pieces: Piece[];
  mover: MoverGroup;
  pos: Vector3;
  yaw: number;
  loco: boolean;
}

/** Everything is built at 1.3x: roomier cars, a proper platform-height floor. */
const S = 1.3;
const CRUISE = 19;
const ACCEL = 1.6;
const DWELL = 15;
const GAP = 1.1 * S;

/** Something that rides along if it's inside a car: loot on the floor, chests (and their meshes). */
export interface Cargo {
  pos: Vector3;
  beam?: { position: Vector3 } | null;
  mesh?: { position: Vector3; rotation: { y: number } };
  alive?: boolean;
}

const mat = new MeshLambertMaterial({ vertexColors: true });

/**
 * The Western express: a locomotive, tender and three passenger cars running round a looped track,
 * stopping at each station. Walk in through the doors, ride on board or on the roof, and don't
 * stand on the track: it doesn't stop for you.
 */
export class Train {
  cars: Car[] = [];
  /** Arc length at each point of the track (closed loop). */
  private arc: number[] = [];
  private total = 0;
  /** Where the middle of the passenger cars stops (arc lengths, sorted). */
  private stops: number[] = [];
  private legs: { from: number; d: number; t: number }[] = [];
  private period = 0;
  /** Distance from the front of the train to the middle of the passenger cars. */
  private midBack = 0;
  /** Current speed (m/s) and arc position of the front. */
  speed = 0;
  head = 0;
  private lastT = -1;
  /** Where loot goes (in a car's frame): chests in the express car, piles in the coaches. */
  lootSpots: { car: number; x: number; y: number; z: number; chest: boolean }[] = [];
  /** Round everything, for a quick check of what could be on board. */
  private bounds = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

  constructor(scene: Scene, world: CollisionWorld, private track: TrackPoint[], stopsAt: { x: number; z: number }[]) {
    let s = 0;
    for (let i = 0; i < track.length; i++) {
      this.arc.push(s);
      const a = track[i], b = track[(i + 1) % track.length];
      s += Math.hypot(b.x - a.x, b.z - a.z);
    }
    this.total = s;

    // Build the cars front to back.
    let back = 0;
    const add = (len: number, build: (p: Put) => { x: number; z: number; chest: boolean }[] | void, loco = false) => {
      len *= S;
      const geos: BufferGeometry[] = [], pieces: Piece[] = [];
      const p = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: number, collide = true) => {
        x0 *= S;
        y0 *= S;
        z0 *= S;
        x1 *= S;
        y1 *= S;
        z1 *= S;
        geos.push(coloredBox(x0, y0, z0, x1, y1, z1, c));
        if (collide) pieces.push({ x0, y0, z0, x1, y1, z1, box: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0, dyn: true } });
      };
      const spots = build(p);
      if (spots) for (const s of spots) this.lootSpots.push({ car: this.cars.length, x: s.x * S, y: 1.2 * S + 0.02, z: s.z * S, chest: s.chest });
      const group = new Group();
      const mesh = new Mesh(mergeGeometries(geos)!, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      scene.add(group);
      const mover: MoverGroup = { bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }, boxes: pieces.map((q) => q.box) };
      world.movers.push(mover);
      this.cars.push({ len, half: len / 2, back: back + len / 2, group, pieces, mover, pos: new Vector3(), yaw: 0, loco });
      back += len + GAP;
    };
    add(15, buildLoco, true);
    add(8, buildTender);
    const firstCar = back;
    add(18, (p) => buildCoach(p, 0xa8382a));
    add(18, (p) => buildCoach(p, 0x3a7a52));
    add(18, buildExpress);
    add(18, (p) => buildCoach(p, 0x3a5a9a));
    this.midBack = (firstCar + back - GAP) / 2;

    // Stops: arc length of the track point nearest each platform.
    this.stops = stopsAt.map((st) => {
      let bi = 0, bd = Infinity;
      track.forEach((q, i) => {
        const d = (q.x - st.x) ** 2 + (q.z - st.z) ** 2;
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      return this.arc[bi];
    }).sort((a, b) => a - b);
    if (!this.stops.length) this.stops = [0];
    for (let i = 0; i < this.stops.length; i++) {
      const from = this.stops[i], to = this.stops[(i + 1) % this.stops.length];
      let d = to - from;
      if (d <= 0) d += this.total;
      this.legs.push({ from, d, t: legTime(d) });
      this.period += legTime(d) + DWELL;
    }
    this.update(0, 0, [], () => {});
  }

  /** Point and heading at arc length s (wraps round the loop). */
  private at(s: number, out: Vector3) {
    s = ((s % this.total) + this.total) % this.total;
    let lo = 0, hi = this.arc.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (this.arc[m] <= s) lo = m;
      else hi = m - 1;
    }
    const a = this.track[lo], b = this.track[(lo + 1) % this.track.length];
    const segLen = (lo + 1 < this.arc.length ? this.arc[lo + 1] : this.total) - this.arc[lo];
    const k = segLen > 0 ? (s - this.arc[lo]) / segLen : 0;
    return out.set(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
  }

  /** Where the middle of the passenger cars is at time t (and how fast it's going). */
  private schedule(t: number) {
    t = ((t % this.period) + this.period) % this.period;
    for (const leg of this.legs) {
      if (t < DWELL) return { s: leg.from, v: 0 };
      t -= DWELL;
      if (t < leg.t) {
        const [x, v] = legPos(leg.d, t);
        return { s: leg.from + x, v };
      }
      t -= leg.t;
    }
    return { s: this.stops[0], v: 0 };
  }

  /**
   * Move the train to where it is at `time`, carrying everyone standing in or on it. `hit` is called
   * for anyone the locomotive runs into.
   */
  /** World position of loot spot i (where the train is now). */
  spotAt(i: number, out: Vector3) {
    const s = this.lootSpots[i], car = this.cars[s.car];
    return toWorld(tmpL.set(s.x, s.y, s.z), car.pos, car.yaw, out);
  }

  /** Heading of the car loot spot i is in. */
  spotYaw(i: number) {
    return this.cars[this.lootSpots[i].car].yaw;
  }

  update(time: number, dt: number, riders: Combatant[], hit: (c: Combatant) => void, cargo: Cargo[] = []) {
    if (time === this.lastT) return;
    this.lastT = time;
    const { s, v } = this.schedule(time);
    this.speed = v;
    this.head = s + this.midBack;
    const f = tmpA, r = tmpB, bb = this.bounds;
    // What's on board (checked against last step's bounds, before anything moves).
    const aboard = dt > 0 ? cargo.filter((c) => c.alive !== false && c.pos.x > bb.minX && c.pos.x < bb.maxX && c.pos.z > bb.minZ && c.pos.z < bb.maxZ && c.pos.y > bb.minY - 1 && c.pos.y < bb.maxY) : [];
    bb.minX = bb.minY = bb.minZ = Infinity;
    bb.maxX = bb.maxY = bb.maxZ = -Infinity;
    for (const car of this.cars) {
      const oldPos = tmpOld.copy(car.pos), oldYaw = car.yaw, wasPlaced = dt > 0;
      // Two bogies: the car sits between them, so it follows curves.
      const c = this.head - car.back;
      this.at(c + car.half - 2, f);
      this.at(c - car.half + 2, r);
      car.pos.set((f.x + r.x) / 2, (f.y + r.y) / 2, (f.z + r.z) / 2);
      car.yaw = Math.atan2(-(f.z - r.z), f.x - r.x);
      // Carry riders: into the old car's frame, back out of the new one.
      if (wasPlaced) {
        for (const b of riders) {
          if (!b.alive) continue;
          const l = toLocal(b.body.pos, oldPos, oldYaw, tmpL);
          const inside = Math.abs(l.x) < car.half + 0.3 && Math.abs(l.z) < 2.0 * S && ((l.y > 0.8 * S && l.y < 4.0 * S) || (l.y >= 4.0 * S && l.y < 6.5 * S));
          if (inside) {
            toWorld(l, car.pos, car.yaw, b.body.pos);
            const turn = Math.atan2(Math.sin(car.yaw - oldYaw), Math.cos(car.yaw - oldYaw)), who = b as unknown as { yaw?: number };
            if (turn && typeof who.yaw === 'number') who.yaw += turn;
          } else if (car.loco && v > 4 && l.x > car.half - 1.4 && l.x < car.half + 1.6 * S && Math.abs(l.z) < 2.1 * S && l.y > -0.6 && l.y < 3.6 * S) hit(b);
        }
        const turn = Math.atan2(Math.sin(car.yaw - oldYaw), Math.cos(car.yaw - oldYaw));
        for (const c of aboard) {
          const l = toLocal(c.pos, oldPos, oldYaw, tmpL);
          if (Math.abs(l.x) > car.half || Math.abs(l.z) > 2.0 * S || l.y < 0.2 || l.y > 6.5 * S) continue;
          toWorld(l, car.pos, car.yaw, c.pos);
          if (c.beam) c.beam.position.copy(c.pos);
          if (c.mesh) {
            c.mesh.position.copy(c.pos);
            c.mesh.rotation.y += turn;
          }
        }
      }
      car.group.position.copy(car.pos);
      car.group.rotation.y = car.yaw;
      // Collision boxes follow (each small piece's axis-aligned bounds).
      const cs = Math.cos(car.yaw), sn = Math.sin(car.yaw), ac = Math.abs(cs), as = Math.abs(sn);
      const u = car.mover.bounds;
      u.minX = u.minY = u.minZ = Infinity;
      u.maxX = u.maxY = u.maxZ = -Infinity;
      for (const q of car.pieces) {
        const lx = (q.x0 + q.x1) / 2, lz = (q.z0 + q.z1) / 2, hx = (q.x1 - q.x0) / 2, hz = (q.z1 - q.z0) / 2;
        const wx = car.pos.x + lx * cs + lz * sn, wz = car.pos.z - lx * sn + lz * cs;
        const ex = ac * hx + as * hz, ez = as * hx + ac * hz, bx = q.box;
        bx.minX = wx - ex;
        bx.maxX = wx + ex;
        bx.minZ = wz - ez;
        bx.maxZ = wz + ez;
        bx.minY = car.pos.y + q.y0;
        bx.maxY = car.pos.y + q.y1;
        u.minX = Math.min(u.minX, bx.minX);
        u.minY = Math.min(u.minY, bx.minY);
        u.minZ = Math.min(u.minZ, bx.minZ);
        u.maxX = Math.max(u.maxX, bx.maxX);
        u.maxY = Math.max(u.maxY, bx.maxY);
        u.maxZ = Math.max(u.maxZ, bx.maxZ);
      }
      bb.minX = Math.min(bb.minX, u.minX);
      bb.minY = Math.min(bb.minY, u.minY);
      bb.minZ = Math.min(bb.minZ, u.minZ);
      bb.maxX = Math.max(bb.maxX, u.maxX);
      bb.maxY = Math.max(bb.maxY, u.maxY + 2);
      bb.maxZ = Math.max(bb.maxZ, u.maxZ);
    }
  }
}

function toLocal(p: Vector3, c: Vector3, yaw: number, out: Vector3) {
  const dx = p.x - c.x, dz = p.z - c.z, cs = Math.cos(yaw), sn = Math.sin(yaw);
  return out.set(dx * cs - dz * sn, p.y - c.y, dx * sn + dz * cs);
}

function toWorld(l: Vector3, c: Vector3, yaw: number, out: Vector3) {
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  return out.set(c.x + l.x * cs + l.z * sn, c.y + l.y, c.z - l.x * sn + l.z * cs);
}

/** Time to cover d metres from standstill to standstill. */
function legTime(d: number) {
  const ramp = CRUISE / ACCEL, rampD = CRUISE * ramp;
  return d >= rampD ? d / CRUISE + ramp : 2 * Math.sqrt(d / ACCEL);
}

/** [distance, speed] t seconds into a leg of length d. */
function legPos(d: number, t: number): [number, number] {
  const T = legTime(d), ramp = CRUISE / ACCEL;
  const vmax = d >= CRUISE * ramp ? CRUISE : Math.sqrt(d * ACCEL);
  const tr = vmax / ACCEL;
  if (t < tr) return [0.5 * ACCEL * t * t, ACCEL * t];
  if (t > T - tr) {
    const u = T - t;
    return [d - 0.5 * ACCEL * u * u, ACCEL * u];
  }
  return [0.5 * ACCEL * tr * tr + (t - tr) * vmax, vmax];
}

function coloredBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, hex: number) {
  const g = new BoxGeometry(x1 - x0, y1 - y0, z1 - z0).toNonIndexed();
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const n = g.getAttribute('position').count, col = new Float32Array(n * 3), c = new Color(hex);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

type Put = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: number, collide?: boolean) => void;

const BLACK = 0x1e1e22, RED = 0x9a2a20, GOLD = 0xc09a38, ROOF = 0x3a3434, STEEL = 0x2a2a2e;

function wheels(p: Put, a: number, b: number, big: boolean) {
  const step = big ? 2.6 : 3.2, r = big ? 0.8 : 0.5;
  for (let u = a + 1.2; u < b - 0.6; u += step) for (const s of [-1, 1]) p(u - r, -0.3 + (big ? 0 : 0.1), s * 1.45 - 0.1, u + r, big ? 1.35 : 0.8, s * 1.45 + 0.1, big ? RED : STEEL, false);
}

/** Locomotive, front at +x: boiler, smokestack, cowcatcher and a cab you can climb into. */
function buildLoco(p: Put) {
  p(-7.5, 0.3, -1.6, 7.5, 1.2, 1.6, BLACK); // chassis and cab floor
  p(-1.5, 1.2, -1.25, 7.0, 3.4, 1.25, BLACK); // boiler
  for (const x of [0.5, 3, 5.6]) p(x, 1.15, -1.3, x + 0.25, 3.45, 1.3, GOLD, false);
  p(5.0, 3.4, -0.45, 5.9, 5.3, 0.45, BLACK); // stack
  p(4.8, 5.3, -0.65, 6.1, 5.7, 0.65, BLACK);
  p(2.1, 3.4, -0.5, 3.1, 4.2, 0.5, GOLD); // dome
  p(6.9, 2.7, -0.35, 7.3, 3.3, 0.35, 0xfff0b0, false); // lamp
  p(7.5, 0.1, -1.5, 8.7, 1.0, 1.5, RED); // cowcatcher
  p(7.5, 1.0, -1.0, 8.0, 1.3, 1.0, RED, false);
  wheels(p, -1.5, 7.5, true);
  // Cab (walk in from either side).
  const wall = (z0: number, z1: number) => {
    p(-7.5, 1.2, z0, -6.8, 3.9, z1, BLACK);
    p(-3.2, 1.2, z0, -1.5, 3.9, z1, BLACK);
    p(-6.8, 3.2, z0, -3.2, 3.9, z1, BLACK); // over the doorway
  };
  wall(-1.6, -1.4);
  wall(1.4, 1.6);
  p(-7.5, 1.2, -1.4, -7.3, 2.4, 1.4, BLACK); // back rail to the tender
  p(-7.8, 3.9, -1.8, -1.2, 4.2, 1.8, ROOF);
  p(-3, 1.2, -1.2, -1.6, 2.2, -0.2, 0x5a4a3a, false); // firebox
  p(-2.4, 1.6, -0.1, -1.6, 2.1, 0.4, 0xff7a2a, false); // fire glow
}

function buildTender(p: Put) {
  p(-4, 0.3, -1.5, 4, 2.7, 1.5, BLACK);
  p(-3.7, 2.7, -1.3, 3.7, 3.1, 1.3, 0x121214, false); // coal
  p(-4, 2.4, -1.55, 4, 2.6, 1.55, GOLD, false);
  wheels(p, -4, 4, false);
}

/** Passenger coach: doors at both ends on both sides, open end doors, windows you can shoot through, benches. */
function buildCoach(p: Put, body: number) {
  const L = 9, W = 1.8, T = 0.2, FLOOR = 1.2, TOP = 3.9;
  p(-L - 0.55, 0.3, -1.2, L + 0.55, FLOOR, 1.2, STEEL); // floor, reaching over the gaps
  p(-L, 0.3, -W, L, FLOOR, W, 0x2a2626);
  wheels(p, -L, L, false);
  for (const s of [-1, 1]) {
    const z0 = s < 0 ? -W : W - T, z1 = s < 0 ? -W + T : W;
    // Doorways at each end (1.2 m), then window bays.
    p(-L, FLOOR, z0, -L + 0.4, TOP, z1, body);
    p(L - 0.4, FLOOR, z0, L, TOP, z1, body);
    p(-L + 0.4, 3.3, z0, -L + 1.6, TOP, z1, body);
    p(L - 1.6, 3.3, z0, L - 0.4, TOP, z1, body);
    for (let x = -L + 1.6; x < L - 1.6 - 0.01; x += 2.2) {
      const x1 = Math.min(L - 1.6, x + 2.2);
      p(x, FLOOR, z0, x1, 2.1, z1, body); // below the window
      p(x, 3.0, z0, x1, TOP, z1, body); // above it
      p(x, 2.1, z0, x + 0.35, 3.0, z1, body); // post
    }
    p(-L, 3.0, s * (W + 0.02) - 0.02, L, 3.1, s * (W + 0.02) + 0.02, GOLD, false);
    // Steps under the doors.
    for (const x of [-L + 1, L - 1]) p(x - 0.6, 0.55, s * W - (s < 0 ? 0.45 : 0), x + 0.6, 0.8, s * W + (s > 0 ? 0.45 : 0), STEEL, false);
  }
  for (const e of [-1, 1]) {
    const x0 = e < 0 ? -L : L - T, x1 = e < 0 ? -L + T : L;
    p(x0, FLOOR, -W + T, x1, TOP, -0.6, body);
    p(x0, FLOOR, 0.6, x1, TOP, W - T, body);
    p(x0, 3.2, -0.6, x1, TOP, 0.6, body);
  }
  p(-L - 0.2, TOP, -W - 0.15, L + 0.2, TOP + 0.3, W + 0.15, ROOF); // roof you can stand on
  p(-L, TOP + 0.3, -1.1, L, TOP + 0.45, 1.1, ROOF, false);
  // Benches either side of the aisle.
  for (let x = -L + 2.2; x < L - 2; x += 1.8) for (const [z0, z1] of [[-W + T, -0.5], [0.5, W - T]]) {
    p(x, FLOOR, z0, x + 0.6, FLOOR + 0.45, z1, 0x6a4a30);
    p(x, FLOOR + 0.45, z0, x + 0.12, FLOOR + 1.05, z1, 0x5a3a22, false);
  }
  // Lamps.
  for (const x of [-4, 4]) p(x - 0.15, TOP - 0.25, -0.15, x + 0.15, TOP - 0.05, 0.15, 0xfff0b0, false);
  return [{ x: -6.5, z: 0, chest: false }, { x: 6.5, z: 0, chest: false }];
}

/**
 * The express car: an armoured strongbox on wheels with wide doors in the middle of each side. Inside,
 * two chests, gold bars and a pile of good loot. Worth the chase.
 */
function buildExpress(p: Put) {
  const L = 9, W = 1.8, T = 0.2, FLOOR = 1.2, TOP = 3.9, body = 0x2c3a46, dark = 0x1c252e;
  p(-L - 0.55, 0.3, -1.2, L + 0.55, FLOOR, 1.2, STEEL);
  p(-L, 0.3, -W, L, FLOOR, W, 0x2a2626);
  wheels(p, -L, L, false);
  for (const s of [-1, 1]) {
    const z0 = s < 0 ? -W : W - T, z1 = s < 0 ? -W + T : W;
    // Solid sides with a 3.6 m door opening in the middle, a slid-back door beside it.
    p(-L, FLOOR, z0, -1.8, TOP, z1, body);
    p(1.8, FLOOR, z0, L, TOP, z1, body);
    p(-1.8, 3.2, z0, 1.8, TOP, z1, body);
    p(-5.6, FLOOR + 0.1, s * (W + 0.08) - 0.06, -1.9, 3.1, s * (W + 0.08) + 0.06, dark, false);
    // Gold bands, rivets and the lettering strip.
    for (const y of [1.5, 3.55]) p(-L, y, s * (W + 0.02) - 0.02, L, y + 0.12, s * (W + 0.02) + 0.02, GOLD, false);
    p(3, 2.3, s * (W + 0.03) - 0.02, 8, 2.8, s * (W + 0.03) + 0.02, GOLD, false);
    for (let x = -L + 0.5; x < L; x += 1.5) if (Math.abs(x) > 2) p(x - 0.05, 2.0, s * (W + 0.03) - 0.02, x + 0.05, 2.1, s * (W + 0.03) + 0.02, GOLD, false);
    for (const x of [-L + 1, L - 1]) p(x - 0.6, 0.55, s * W - (s < 0 ? 0.45 : 0), x + 0.6, 0.8, s * W + (s > 0 ? 0.45 : 0), STEEL, false);
    p(-2.2, 0.55, s * W - (s < 0 ? 0.5 : 0), 2.2, 0.8, s * W + (s > 0 ? 0.5 : 0), STEEL, false);
  }
  for (const e of [-1, 1]) {
    const x0 = e < 0 ? -L : L - T, x1 = e < 0 ? -L + T : L;
    p(x0, FLOOR, -W + T, x1, TOP, -0.6, body);
    p(x0, FLOOR, 0.6, x1, TOP, W - T, body);
    p(x0, 3.2, -0.6, x1, TOP, 0.6, body);
  }
  p(-L - 0.2, TOP, -W - 0.15, L + 0.2, TOP + 0.3, W + 0.15, dark);
  // Pale plank lining, floor and ceiling so the inside isn't a black box.
  p(-L + T, FLOOR, -W + T, L - T, FLOOR + 0.02, W - T, 0xa07a50, false);
  p(-L + T, TOP - 0.04, -W + T, L - T, TOP, W - T, 0xc8b89a, false);
  for (const s of [-1, 1]) for (const [x0, x1] of [[-L + T, -1.8], [1.8, L - T]]) {
    const z = s * (W - T - 0.015);
    p(x0, FLOOR, z - 0.015, x1, TOP - 0.04, z + 0.015, 0xb89468, false);
  }
  // Inside: strongboxes and crates for cover, stacks of gold, lamps.
  for (const [x0, x1, z0, z1, h] of [[-8.6, -7.2, -1.6, -0.5, 1.2], [-8.6, -7.2, 0.5, 1.6, 0.8], [7.2, 8.6, -1.6, -0.6, 1.0], [7.2, 8.6, 0.6, 1.6, 1.3], [-3.6, -2.6, -1.6, -1.0, 0.7], [2.6, 3.6, 1.0, 1.6, 0.7]]) {
    p(x0, FLOOR, z0, x1, FLOOR + h, z1, 0x6b5030);
    p(x0 - 0.02, FLOOR + h - 0.1, z0 - 0.02, x1 + 0.02, FLOOR + h - 0.02, z1 + 0.02, 0x3a2a1a, false);
  }
  for (const [x, z] of [[-7.9, -1.05], [7.9, 1.1]]) {
    for (let k = 0; k < 3; k++) p(x - 0.35 + k * 0.23, FLOOR + 1.3, z - 0.2, x - 0.17 + k * 0.23, FLOOR + 1.42, z + 0.2, 0xffd24a, false);
  }
  for (const x of [-5, 0, 5]) p(x - 0.15, TOP - 0.25, -0.15, x + 0.15, TOP - 0.05, 0.15, 0xfff0b0, false);
  return [
    { x: -5.2, z: 0, chest: true },
    { x: 5.2, z: 0, chest: true },
    { x: 0, z: 0, chest: false },
  ];
}

const tmpA = new Vector3(), tmpB = new Vector3(), tmpOld = new Vector3(), tmpL = new Vector3();
