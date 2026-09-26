import {
  BoxGeometry, Color, DynamicDrawUsage, InstancedMesh, Matrix4, MeshLambertMaterial, Quaternion, Scene, Vector3,
} from 'three';
import { CollisionWorld, type Box } from '../core/Collision';
import type { Particles } from '../game/Particles';
import type { Sfx } from '../game/Sfx';
import type { DestructibleSpec, DoorSpec, GameMap, ZiplineSpec } from './Map';

const unit = new BoxGeometry(1, 1, 1);
const m4 = new Matrix4(), q = new Quaternion(), p = new Vector3(), s = new Vector3(), yAxis = new Vector3(0, 1, 0);
const HIDDEN = new Matrix4().makeScale(0, 0, 0);
const GONE = -9999;

interface Door {
  closed: Box;
  box: Box;
  alongX: boolean;
  width: number;
  height: number;
  hinge: Vector3;
  open: number;
  /** +1 / -1: which side it swings to. */
  side: number;
  openUntil: number;
  center: Vector3;
}

/**
 * Doors. You open and close them by hand (E); bots push through them, and doors a bot opened swing
 * shut again behind it. A door you opened stays open until you close it.
 */
export class Doors {
  list: Door[] = [];
  byBox = new Map<Box, Door>();
  private mesh: InstancedMesh;
  private grid = new Map<string, Door[]>();
  private time = 0;
  private dirty = new Set<number>();

  constructor(scene: Scene, specs: DoorSpec[], private world: CollisionWorld) {
    this.mesh = new InstancedMesh(unit, new MeshLambertMaterial({ color: 0x8a5a3a }), Math.max(1, specs.length));
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    const c = new Color();
    specs.forEach((d, i) => {
      const width = d.alongX ? d.maxX - d.minX : d.maxZ - d.minZ, height = d.maxY - d.minY;
      const hinge = d.alongX ? new Vector3(d.minX, d.minY, (d.minZ + d.maxZ) / 2) : new Vector3((d.minX + d.maxX) / 2, d.minY, d.minZ);
      const box: Box = { ...d, dyn: true };
      const span: Box = d.alongX
        ? { minX: d.minX - 0.2, minY: d.minY, minZ: hinge.z - width - 0.2, maxX: d.maxX, maxY: d.maxY, maxZ: hinge.z + width + 0.2 }
        : { minX: hinge.x - width - 0.2, minY: d.minY, minZ: d.minZ - 0.2, maxX: hinge.x + width + 0.2, maxY: d.maxY, maxZ: d.maxZ };
      world.add(box, span);
      const door: Door = {
        closed: { ...d }, box, alongX: d.alongX, width, height, hinge, open: 0, side: 1, openUntil: 0,
        center: new Vector3((d.minX + d.maxX) / 2, d.minY, (d.minZ + d.maxZ) / 2),
      };
      this.list.push(door);
      this.byBox.set(box, door);
      const key = `${Math.floor(door.center.x / 16)},${Math.floor(door.center.z / 16)}`;
      (this.grid.get(key) ?? this.grid.set(key, []).get(key)!).push(door);
      this.mesh.setColorAt(i, c.setHex(i % 3 === 0 ? 0x6b4a2f : i % 3 === 1 ? 0x8a5a3a : 0x9a7a5a));
      this.place(i);
    });
    this.mesh.count = specs.length;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);
  }

  private place(i: number) {
    const d = this.list[i];
    // Eased swing with a little bounce against the stop when it opens.
    const k = d.open, e = k < 1 ? k * k * (3 - 2 * k) + Math.sin(k * Math.PI) * 0.06 : 1;
    const ang = (d.alongX ? -d.side : d.side) * e * (Math.PI / 2);
    q.setFromAxisAngle(yAxis, ang);
    if (d.alongX) {
      p.set(d.width / 2, d.height / 2, 0).applyQuaternion(q).add(d.hinge);
      s.set(d.width, d.height, 0.08);
    } else {
      p.set(0, d.height / 2, d.width / 2).applyQuaternion(q).add(d.hinge);
      s.set(0.08, d.height, d.width);
    }
    this.mesh.setMatrixAt(i, m4.compose(p, q, s));
  }

  /** Doors near `pos` (within `r` metres). */
  near(pos: Vector3, r: number, out: Door[] = []) {
    out.length = 0;
    const cx = Math.floor(pos.x / 16), cz = Math.floor(pos.z / 16);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const cell = this.grid.get(`${cx + dx},${cz + dz}`);
      if (!cell) continue;
      for (const d of cell) if (Math.abs(d.center.x - pos.x) < r && Math.abs(d.center.z - pos.z) < r && Math.abs(d.center.y - pos.y) < 2.2) out.push(d);
    }
    return out;
  }

  /** The door you'd grab with E: close by, roughly in front of you, on your floor. */
  facing(pos: Vector3, fx: number, fz: number): Door | null {
    let best: Door | null = null, bs = Infinity;
    for (const d of this.near(pos, 2.6, tmpList)) {
      const dx = d.center.x - pos.x, dz = d.center.z - pos.z, dist = Math.hypot(dx, dz);
      if (dist > 2.4) continue;
      const along = (dx * fx + dz * fz) / (dist || 1);
      if (dist > 1.1 && along < 0.3) continue;
      const score = dist - along;
      if (score < bs) {
        bs = score;
        best = d;
      }
    }
    return best;
  }

  isOpen(d: Door) {
    return this.time < d.openUntil;
  }

  /** E on a door: open it away from you (it stays open), or shut it. */
  toggle(d: Door, pos: Vector3, sfx: Sfx) {
    if (this.isOpen(d)) {
      d.openUntil = 0;
      return;
    }
    if (d.open < 0.05) {
      const off = d.alongX ? pos.z - d.hinge.z : pos.x - d.hinge.x;
      d.side = off > 0 ? -1 : 1;
    }
    d.openUntil = Infinity;
    sfx.door(d.center, true);
  }

  /** A bot at `pos` wants through: swing the door away from it for a moment. */
  approach(pos: Vector3, sfx: Sfx | null) {
    for (const d of this.near(pos, 1.9, tmpList)) {
      if (d.open < 0.05 && d.openUntil < this.time) {
        const off = d.alongX ? pos.z - d.hinge.z : pos.x - d.hinge.x;
        d.side = off > 0 ? -1 : 1;
        if (sfx) sfx.door(d.center, true);
      }
      d.openUntil = Math.max(d.openUntil, this.time + 2.5);
    }
  }

  update(dt: number, sfx: Sfx, occupied: (b: Box) => boolean) {
    this.time += dt;
    for (let i = 0; i < this.list.length; i++) {
      const d = this.list[i];
      let want = this.time < d.openUntil ? 1 : 0;
      if (!want && d.open > 0) {
        // Don't slam shut on somebody standing in the doorway.
        if (occupied(d.closed)) {
          d.openUntil = this.time + 0.6;
          want = 1;
        } else if (d.open === 1) sfx.door(d.center, false);
      }
      if (d.open === want) continue;
      d.open = want > d.open ? Math.min(1, d.open + dt * 2.6) : Math.max(0, d.open - dt * 2.2);
      this.place(i);
      this.dirty.add(i);
      const b = d.box;
      if (d.open > 0.5) {
        // Open: a thin leaf standing out from the hinge.
        const w = d.width, sd = d.side;
        if (d.alongX) Object.assign(b, { minX: d.hinge.x - 0.06, maxX: d.hinge.x + 0.06, minZ: sd > 0 ? d.hinge.z : d.hinge.z - w, maxZ: sd > 0 ? d.hinge.z + w : d.hinge.z });
        else Object.assign(b, { minZ: d.hinge.z - 0.06, maxZ: d.hinge.z + 0.06, minX: sd > 0 ? d.hinge.x : d.hinge.x - w, maxX: sd > 0 ? d.hinge.x + w : d.hinge.x });
      } else Object.assign(b, { minX: d.closed.minX, maxX: d.closed.maxX, minZ: d.closed.minZ, maxZ: d.closed.maxZ });
    }
    if (this.dirty.size) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.dirty.clear();
    }
    void this.world;
  }
}
const tmpList: Door[] = [];

/** Window panes: see-through, stop nothing for long — bullets, bodies and blasts shatter them. */
export class Glass {
  world: CollisionWorld;
  private index = new Map<Box, number>();
  private mesh: InstancedMesh;
  private boxes: Box[];

  constructor(scene: Scene, panes: Box[], size: number, private fx: Particles, private sfx: Sfx) {
    this.world = new CollisionWorld(size, false);
    this.boxes = panes.map((b) => ({ ...b }));
    this.mesh = new InstancedMesh(unit, new MeshLambertMaterial({ color: 0xa8d8ff, transparent: true, opacity: 0.3, depthWrite: false, emissive: 0x16303f }), Math.max(1, panes.length));
    this.boxes.forEach((b, i) => {
      this.world.add(b);
      this.index.set(b, i);
      p.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
      s.set(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
      this.mesh.setMatrixAt(i, m4.compose(p, q.identity(), s));
    });
    this.mesh.count = panes.length;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }

  private shatter(b: Box) {
    const i = this.index.get(b);
    if (i === undefined || b.minY === GONE) return;
    const c = p.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2).clone();
    b.minY = b.maxY = GONE;
    this.mesh.setMatrixAt(i, HIDDEN);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.fx.burst(c, 0xcfeaff, 14, { speed: 4, size: 0.07, life: 0.6, gravity: 18, up: 0.4, alpha: 0.8 });
    this.sfx.glass(c);
  }

  /** Breaks every pane a shot passes through before `maxT`. */
  shoot(o: Vector3, dir: Vector3, maxT: number) {
    for (let k = 0; k < 4; k++) {
      const t = this.world.raycast(o, dir, maxT);
      if (t >= maxT || !this.world.lastHit) return;
      this.shatter(this.world.lastHit);
    }
  }

  /** Breaks panes overlapping a volume (people running through, explosions). */
  smash(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) {
    for (const b of [...this.world.queryAABB(minX, minY, minZ, maxX, maxY, maxZ)]) this.shatter(b);
  }
}

interface Prop {
  spec: DestructibleSpec;
  box: Box;
  hp: number;
  mesh: InstancedMesh;
  i: number;
}

/** Crates and fence panels: solid cover until they take enough damage (or a car hits them). */
export class Destructibles {
  byBox = new Map<Box, Prop>();
  private list: Prop[] = [];
  /** Called when a prop is destroyed, so navigation can re-open the space. */
  onBreak: (b: Box) => void = () => {};

  constructor(scene: Scene, specs: DestructibleSpec[], world: CollisionWorld, private fx: Particles, private sfx: Sfx) {
    const buckets = new Map<string, DestructibleSpec[]>();
    for (const sp of specs) {
      const key = `${Math.floor(sp.minX / 100)},${Math.floor(sp.minZ / 100)}`;
      (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(sp);
    }
    const mat = new MeshLambertMaterial();
    const c = new Color();
    for (const list of buckets.values()) {
      const mesh = new InstancedMesh(unit, mat, list.length);
      list.forEach((sp, i) => {
        p.set((sp.minX + sp.maxX) / 2, (sp.minY + sp.maxY) / 2, (sp.minZ + sp.maxZ) / 2);
        s.set(sp.maxX - sp.minX, sp.maxY - sp.minY, sp.maxZ - sp.minZ);
        mesh.setMatrixAt(i, m4.compose(p, q.identity(), s));
        mesh.setColorAt(i, c.setHex(sp.color));
        const box: Box = { minX: sp.minX, minY: sp.minY, minZ: sp.minZ, maxX: sp.maxX, maxY: sp.maxY, maxZ: sp.maxZ };
        world.add(box);
        const prop: Prop = { spec: sp, box, hp: sp.kind === 'crate' ? 70 : 35, mesh, i };
        this.list.push(prop);
        this.byBox.set(box, prop);
      });
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      scene.add(mesh);
    }
  }

  damage(b: Box, amount: number) {
    const pr = this.byBox.get(b);
    if (!pr || pr.hp <= 0) return false;
    pr.hp -= amount;
    if (pr.hp > 0) return false;
    const sp = pr.spec, c = new Vector3((sp.minX + sp.maxX) / 2, (sp.minY + sp.maxY) / 2, (sp.minZ + sp.maxZ) / 2);
    this.onBreak({ ...pr.box });
    pr.box.minY = pr.box.maxY = GONE;
    pr.mesh.setMatrixAt(pr.i, HIDDEN);
    pr.mesh.instanceMatrix.needsUpdate = true;
    this.fx.burst(c, sp.color, 16, { speed: 5, size: 0.14, life: 0.8, gravity: 16, up: 0.9 });
    this.fx.puff(c, 0xb8a080, 3, 1.5, 0.5, 0.5, 0.8);
    this.sfx.woodBreak(c);
    return true;
  }

  /** Everything overlapping a sphere takes damage (explosions) or breaks outright (`amount` = Infinity). */
  hitSphere(at: Vector3, r: number, amount: number) {
    for (const pr of this.list) {
      const b = pr.box;
      if (b.minY === GONE) continue;
      const dx = Math.max(b.minX - at.x, 0, at.x - b.maxX), dy = Math.max(b.minY - at.y, 0, at.y - b.maxY), dz = Math.max(b.minZ - at.z, 0, at.z - b.maxZ);
      if (dx * dx + dy * dy + dz * dz < r * r) this.damage(b, amount);
    }
  }
}

export interface ZipLine extends ZiplineSpec {
  dir: Vector3;
  len: number;
}

/** Cables between high points and the ground. Ride them either way. */
export class Ziplines {
  lines: ZipLine[];

  constructor(map: GameMap) {
    this.lines = map.ziplines.map((z) => {
      const dir = z.b.clone().sub(z.a);
      const len = dir.length();
      return { ...z, dir: dir.divideScalar(len), len };
    });
  }

  /** Closest cable to a point (the eye), with the parameter t along it. */
  nearest(pos: Vector3, maxDist: number): { line: ZipLine; t: number } | null {
    let best: { line: ZipLine; t: number } | null = null, bd = maxDist;
    for (const l of this.lines) {
      const t = Math.max(0, Math.min(1, p.subVectors(pos, l.a).dot(l.dir) / l.len));
      const d = p.copy(l.a).addScaledVector(l.dir, t * l.len).distanceTo(pos);
      if (d < bd) {
        bd = d;
        best = { line: l, t };
      }
    }
    return best;
  }
}
