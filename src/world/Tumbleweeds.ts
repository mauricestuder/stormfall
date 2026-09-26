import { BoxGeometry, Euler, InstancedMesh, Matrix4, MeshLambertMaterial, Quaternion, Vector3, type Scene } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CollisionWorld } from '../core/Collision';

const COUNT = 22;
const NEAR = 30, FAR = 150;

interface Weed {
  pos: Vector3;
  vel: Vector3;
  rot: Quaternion;
  size: number;
  hop: number;
  y: number;
}

/** Dry tumbleweeds rolling and bouncing across the desert with the wind (visual only). */
export class Tumbleweeds {
  private mesh: InstancedMesh;
  private weeds: Weed[] = [];
  private wind = new Vector3(1, 0, 0.35).normalize();
  private gust = 0;
  private t = 0;

  constructor(scene: Scene, private groundAt: (x: number, z: number) => number, private world: CollisionWorld, private isWater: (x: number, z: number) => boolean) {
    // A tangle of thin twigs in every direction, roughly a ball.
    const parts: BoxGeometry[] = [];
    const e = new Euler(), m = new Matrix4();
    for (let i = 0; i < 16; i++) {
      const g = new BoxGeometry(0.07, 0.07, 0.9 + Math.random() * 0.35);
      e.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      g.applyMatrix4(m.makeRotationFromEuler(e));
      g.translate((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12);
      parts.push(g);
    }
    for (let i = 0; i < 5; i++) {
      const g = new BoxGeometry(0.34, 0.34, 0.34);
      e.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      g.applyMatrix4(m.makeRotationFromEuler(e));
      parts.push(g);
    }
    const geo = mergeGeometries(parts)!;
    this.mesh = new InstancedMesh(geo, new MeshLambertMaterial({ color: 0x9a7a4a }), COUNT);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    for (let i = 0; i < COUNT; i++) {
      this.weeds.push({ pos: new Vector3(1e5, 0, 1e5), vel: new Vector3(), rot: new Quaternion(), size: 0.7 + Math.random() * 0.6, hop: 0, y: 0 });
    }
  }

  set visible(v: boolean) {
    this.mesh.visible = v;
  }

  /** Put a weed somewhere around the camera, mostly upwind so it rolls past. */
  private spawn(w: Weed, cam: Vector3, anywhere: boolean) {
    for (let tries = 0; tries < 8; tries++) {
      const a = anywhere ? Math.random() * Math.PI * 2 : Math.atan2(-this.wind.z, -this.wind.x) + (Math.random() - 0.5) * 2.2;
      const r = anywhere ? NEAR * 0.5 + Math.random() * (FAR - NEAR) : FAR * (0.55 + Math.random() * 0.4);
      const x = cam.x + Math.cos(a) * r, z = cam.z + Math.sin(a) * r;
      if (this.isWater(x, z)) continue;
      const y = this.groundAt(x, z);
      if (this.world.anyOverlap(x - 0.5, y + 0.2, z - 0.5, x + 0.5, y + 1.2, z + 0.5)) continue;
      w.pos.set(x, y, z);
      w.y = 0;
      w.hop = 0;
      w.vel.copy(this.wind).multiplyScalar(3 + Math.random() * 3);
      return;
    }
    w.pos.set(1e5, 0, 1e5);
  }

  update(dt: number, cam: Vector3) {
    if (!this.mesh.visible || dt <= 0) return;
    this.t += dt;
    // Slowly veering wind with gusts.
    const turn = Math.sin(this.t * 0.05) * 0.4;
    this.wind.set(Math.cos(0.35 + turn), 0, Math.sin(0.35 + turn));
    this.gust = 0.6 + 0.4 * Math.sin(this.t * 0.7) + 0.3 * Math.sin(this.t * 2.3);
    const m = new Matrix4(), s = new Vector3(), q = new Quaternion(), axis = new Vector3();
    for (let i = 0; i < COUNT; i++) {
      const w = this.weeds[i];
      const dx = w.pos.x - cam.x, dz = w.pos.z - cam.z;
      if (dx * dx + dz * dz > FAR * FAR * 1.2 || w.pos.x > 5e4) this.spawn(w, cam, w.pos.x > 5e4);
      // Pushed by the wind, dragged by the ground.
      const target = (4 + 5 * this.gust) / w.size;
      w.vel.x += (this.wind.x * target - w.vel.x) * Math.min(1, dt * 0.8);
      w.vel.z += (this.wind.z * target - w.vel.z) * Math.min(1, dt * 0.8);
      const nx = w.pos.x + w.vel.x * dt, nz = w.pos.z + w.vel.z * dt;
      const gy = this.groundAt(nx, nz);
      // Walls and rocks: bounce off sideways.
      if (this.isWater(nx, nz) || this.world.anyOverlap(nx - 0.35, gy + 0.3 + w.y, nz - 0.35, nx + 0.35, gy + 0.9 + w.y, nz + 0.35)) {
        w.vel.set(-w.vel.z * 0.6, 0, w.vel.x * 0.6);
        w.hop = Math.max(w.hop, 3);
      } else {
        w.pos.x = nx;
        w.pos.z = nz;
      }
      // Bounce: little hops, bigger in gusts.
      w.hop -= 16 * dt;
      w.y += w.hop * dt;
      if (w.y <= 0) {
        w.y = 0;
        w.hop = Math.random() < 0.5 * this.gust ? 1.5 + Math.random() * 3 * this.gust : 0;
      }
      w.pos.y = this.groundAt(w.pos.x, w.pos.z);
      // Roll: spin about the axis across the direction of travel.
      const sp = Math.hypot(w.vel.x, w.vel.z);
      if (sp > 0.01) {
        axis.set(w.vel.z / sp, 0, -w.vel.x / sp);
        w.rot.premultiply(q.setFromAxisAngle(axis, (sp / (w.size * 0.5)) * dt));
      }
      s.setScalar(w.size);
      m.compose(tmp.set(w.pos.x, w.pos.y + w.size * 0.5 + w.y, w.pos.z), w.rot, s);
      this.mesh.setMatrixAt(i, m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

const tmp = new Vector3();
