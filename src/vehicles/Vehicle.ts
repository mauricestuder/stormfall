import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial, Scene, Vector3 } from 'three';
import { moveBody, type Body, type CollisionWorld } from '../core/Collision';
import { clamp, damp } from '../core/rng';
import type { Combatant } from '../game/Combat';

/** Anything that can press the driving keys: the player's Input or a bot's virtual keys. */
export interface DriveInput {
  isDown(code: string): boolean;
}

export type VehicleKind = 'buggy' | 'car' | 'truck';

interface Spec {
  name: string;
  maxSpeed: number;
  accel: number;
  turn: number;
  health: number;
  length: number;
  width: number;
  wheelR: number;
  colors: number[];
}

export const VEHICLE_SPECS: Record<VehicleKind, Spec> = {
  buggy: { name: 'Buggy', maxSpeed: 33, accel: 22, turn: 2.5, health: 220, length: 3.4, width: 2.0, wheelR: 0.5, colors: [0xf0a030, 0x3fbf5f, 0xe53935, 0x2fa0d1] },
  car: { name: 'Hatchback', maxSpeed: 30, accel: 17, turn: 2.1, health: 320, length: 4.2, width: 2.0, wheelR: 0.38, colors: [0xd9382c, 0x2f6fd1, 0xf2f2f2, 0x2a2d31, 0xf0c030, 0x3a9a5a] },
  truck: { name: 'Truck', maxSpeed: 25, accel: 11, turn: 1.6, health: 550, length: 5.4, width: 2.4, wheelR: 0.52, colors: [0x55606b, 0x8a5a3a, 0x2f5f8f, 0xa33a2a] },
};

const GRAVITY = 24;

/** Arcade vehicle: drive with WASD, Space = handbrake (drift), Shift = boost. */
export class Vehicle {
  body: Body;
  yaw: number;
  speed = 0;
  health: number;
  alive = true;
  hasDriver = false;
  /** Who is at the wheel (player or bot). */
  driver: Combatant | null = null;
  mesh: Group;
  spec: Spec;
  /** Throttle input last step (for engine sound). */
  throttle = 0;
  /** Seconds since the last crash sound, to avoid spamming. */
  private crashCd = 0;
  private steerVis = 0;
  private wheels: { pivot: Group; spin: Group; front: boolean }[] = [];
  lastImpact = 0;
  /** Set once the wreck has blown up. */
  exploded = false;
  /** Online: someone elsewhere is driving; follow their updates while this is > 0. */
  netHold = 0;
  netPos = new Vector3();
  netVel = new Vector3();
  netYaw = 0;

  constructor(public kind: VehicleKind, x: number, y: number, z: number, yaw: number, scene: Scene) {
    this.spec = VEHICLE_SPECS[kind];
    this.health = this.spec.health;
    this.yaw = yaw;
    this.body = { pos: new Vector3(x, y + 0.3, z), vel: new Vector3(), radius: (this.spec.length + this.spec.width) / 4.4, height: 1.7, onGround: false };
    this.mesh = this.build();
    scene.add(this.mesh);
    this.syncMesh(0, () => y);
  }

  forward(out: Vector3) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  right(out: Vector3) {
    return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  private build() {
    const s = this.spec, g = new Group(), L = s.length, W = s.width;
    const color = s.colors[Math.floor(Math.random() * s.colors.length)];
    const paint = new MeshLambertMaterial({ color });
    const dark = new MeshLambertMaterial({ color: 0x24282d });
    const glass = new MeshLambertMaterial({ color: 0x2a3440, emissive: 0x0a1018 });
    const box = (w: number, h: number, d: number, mat: MeshLambertMaterial | MeshBasicMaterial, x: number, y: number, z: number) => {
      const m = new Mesh(unitBox, mat);
      m.scale.set(w, h, d);
      m.position.set(x, y, z);
      m.castShadow = true;
      g.add(m);
      return m;
    };
    if (this.kind === 'car') {
      box(W, 0.7, L, paint, 0, 0.7, 0);
      box(W * 0.88, 0.62, L * 0.5, glass, 0, 1.36, 0.25);
      box(W * 0.9, 0.08, L * 0.5, paint, 0, 1.7, 0.25);
    } else if (this.kind === 'buggy') {
      box(W * 0.9, 0.35, L, dark, 0, 0.75, 0);
      box(W * 0.7, 0.3, L * 0.45, paint, 0, 1.05, -L * 0.25);
      box(W * 0.7, 0.5, 0.4, dark, 0, 1.2, 0.3); // seat back
      for (const x of [-1, 1]) {
        box(0.1, 0.9, 0.1, paint, x * W * 0.4, 1.4, -0.3);
        box(0.1, 0.9, 0.1, paint, x * W * 0.4, 1.4, 0.8);
        box(0.1, 0.1, 1.2, paint, x * W * 0.4, 1.85, 0.25);
      }
      box(W * 0.8, 0.1, 0.1, paint, 0, 1.85, -0.3);
    } else {
      box(W, 0.6, L, dark, 0, 0.8, 0);
      box(W, 1.3, 1.9, paint, 0, 1.6, -L / 2 + 0.95);
      box(W * 0.9, 0.5, 0.05, glass, 0, 1.85, -L / 2 - 0.01);
      box(W, 0.6, 0.12, paint, 0, 1.4, L / 2 - 0.06);
      box(0.12, 0.6, L - 2, paint, -W / 2 + 0.06, 1.4, 0.95);
      box(0.12, 0.6, L - 2, paint, W / 2 - 0.06, 1.4, 0.95);
    }
    const lightMat = new MeshBasicMaterial({ color: 0xfff6c0 });
    const tailMat = new MeshBasicMaterial({ color: 0xff3b30 });
    for (const x of [-1, 1]) {
      box(0.3, 0.16, 0.05, lightMat, x * (W / 2 - 0.3), 0.85, -L / 2 - 0.02);
      box(0.3, 0.14, 0.05, tailMat, x * (W / 2 - 0.3), 0.85, L / 2 + 0.02);
    }
    const r = s.wheelR;
    for (const [x, z, front] of [[-1, -1, true], [1, -1, true], [-1, 1, false], [1, 1, false]] as const) {
      const pivot = new Group();
      pivot.position.set(x * (W / 2 - 0.05), r, z * L * 0.33);
      const spin = new Group();
      const wheel = new Mesh(wheelGeo, dark);
      wheel.scale.set(r, 0.34, r);
      wheel.rotation.z = Math.PI / 2;
      wheel.castShadow = true;
      spin.add(wheel);
      pivot.add(spin);
      g.add(pivot);
      this.wheels.push({ pivot, spin, front });
    }
    g.rotation.order = 'YXZ';
    return g;
  }

  /** One physics step. `input` is null when nobody is driving (the vehicle coasts to a stop). */
  drive(dt: number, input: DriveInput | null, world: CollisionWorld) {
    const b = this.body, v = b.vel, s = this.spec;
    this.crashCd -= dt;
    this.lastImpact = 0;
    const fwd = this.forward(tmpF);
    let throttle = 0, steer = 0, brake = false, boost = false;
    if (input && this.alive) {
      throttle = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
      steer = (input.isDown('KeyA') ? 1 : 0) - (input.isDown('KeyD') ? 1 : 0);
      brake = input.isDown('Space');
      boost = input.isDown('ShiftLeft') && throttle > 0;
    }
    this.throttle = Math.abs(throttle);
    const wet = world.groundAt(b.pos.x, b.pos.z) < -0.3;
    const maxSpeed = (boost ? s.maxSpeed * 1.25 : s.maxSpeed) * (wet ? 0.3 : 1);

    if (b.onGround) {
      if (throttle > 0) this.speed = this.speed < 0 ? this.speed + 30 * dt : Math.min(maxSpeed, this.speed + s.accel * (boost ? 1.4 : 1) * dt);
      else if (throttle < 0) this.speed = this.speed > 0.5 ? this.speed - 30 * dt : Math.max(-9, this.speed - s.accel * 0.6 * dt);
      else this.speed = damp(this.speed, 0, 0.9, dt);
      if (this.speed > maxSpeed) this.speed = damp(this.speed, maxSpeed, 2, dt);
      if (brake) this.speed = damp(this.speed, 0, 1.2, dt);
      const grip = brake ? 1.6 : wet ? 3 : 9;
      const sf = clamp(Math.abs(this.speed) / 7, 0, 1) / (1 + Math.abs(this.speed) / 45);
      this.yaw += steer * s.turn * sf * Math.sign(this.speed || 1) * (brake ? 1.5 : 1) * dt;
      this.forward(fwd);
      v.x = damp(v.x, fwd.x * this.speed, grip, dt);
      v.z = damp(v.z, fwd.z * this.speed, grip, dt);
    } else {
      this.yaw += steer * 0.8 * dt; // a little air control
    }
    v.y -= GRAVITY * dt;

    const before = Math.hypot(v.x, v.z);
    moveBody(world, b, dt, 0.75);
    const after = Math.hypot(v.x, v.z);
    const impact = before - after;
    if (impact > 5) {
      this.lastImpact = impact;
      if (impact > 11) this.damage((impact - 11) * 6);
    }
    // Speed follows what actually happened (walls stop you, sideways slides bleed off).
    const along = v.x * fwd.x + v.z * fwd.z;
    if (b.onGround || impact > 2) this.speed = clamp(this.speed, -Math.abs(along) - 0.5, Math.abs(along) + 0.5);
    this.steerVis = damp(this.steerVis, steer, 10, dt);
  }

  canCrashSound() {
    if (this.crashCd > 0) return false;
    this.crashCd = 0.4;
    return true;
  }

  damage(amount: number) {
    if (!this.alive) return false;
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      // Burnt-out wreck: every material on this vehicle is its own, so just blacken them.
      this.mesh.traverse((o) => {
        const mat = (o as Mesh).material as MeshLambertMaterial | MeshBasicMaterial | undefined;
        mat?.color.setHex(0x2b2826);
      });
      return true;
    }
    return false;
  }

  /** Visual sync: wheel spin/steer, and tilt to match the terrain. */
  syncMesh(dt: number, groundAt: (x: number, z: number) => number) {
    const b = this.body, s = this.spec;
    this.mesh.position.copy(b.pos);
    this.mesh.rotation.y = this.yaw;
    const f = this.forward(tmpF), r = this.right(tmpR);
    const hl = s.length / 2, hw = s.width / 2;
    const onTerrain = b.pos.y - groundAt(b.pos.x, b.pos.z) < 0.35;
    let pitch = 0, roll = 0;
    if (onTerrain) {
      const hF = groundAt(b.pos.x + f.x * hl, b.pos.z + f.z * hl), hB = groundAt(b.pos.x - f.x * hl, b.pos.z - f.z * hl);
      const hR = groundAt(b.pos.x + r.x * hw, b.pos.z + r.z * hw), hL = groundAt(b.pos.x - r.x * hw, b.pos.z - r.z * hw);
      pitch = Math.atan2(hF - hB, s.length);
      roll = Math.atan2(hR - hL, s.width);
    } else if (!b.onGround) {
      pitch = clamp(b.vel.y * 0.015, -0.3, 0.3);
    }
    const k = dt > 0 ? 1 - Math.exp(-12 * dt) : 1;
    this.mesh.rotation.x += (pitch - this.mesh.rotation.x) * k;
    this.mesh.rotation.z += (roll - this.mesh.rotation.z) * k;
    for (const w of this.wheels) {
      w.spin.rotation.x -= (this.speed * dt) / s.wheelR;
      if (w.front) w.pivot.rotation.y = this.steerVis * 0.45;
    }
  }
}

const unitBox = new BoxGeometry(1, 1, 1);
const wheelGeo = new CylinderGeometry(1, 1, 1, 12);
const tmpF = new Vector3(), tmpR = new Vector3();
