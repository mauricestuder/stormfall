import { Group, Mesh, Scene, Vector3 } from 'three';
import { CONFIG } from '../config';
import { boxMesh } from '../weapons/Weapon';

/** The drop ship: flies a straight line across the island; everyone jumps out along the way. */
export class Plane {
  start = new Vector3();
  end = new Vector3();
  dir = new Vector3();
  velocity = new Vector3();
  progress = 0;
  active = true;
  length = 1;
  mesh!: Group;

  constructor(scene: Scene) {
    this.route(Math.random);
    this.mesh = this.buildModel();
    this.mesh.rotation.y = Math.atan2(-this.dir.x, -this.dir.z);
    this.position(this.mesh.position);
    scene.add(this.mesh);
  }

  /** Picks the flight line (seeded online so everyone is on the same plane). */
  route(rnd: () => number) {
    const H = CONFIG.mapSize / 2;
    const a = rnd() * Math.PI * 2;
    this.dir.set(Math.cos(a), 0, Math.sin(a));
    const mid = new Vector3((rnd() - 0.5) * H * 0.6, 0, (rnd() - 0.5) * H * 0.6);
    const reach = H * 1.25;
    const alt = CONFIG.drop.planeAltitude;
    this.start.copy(mid).addScaledVector(this.dir, -reach).setY(alt);
    this.end.copy(mid).addScaledVector(this.dir, reach).setY(alt);
    this.length = this.start.distanceTo(this.end);
    this.velocity.copy(this.dir).multiplyScalar(CONFIG.drop.planeSpeed);
    this.progress = 0;
    if (!this.mesh) return;
    this.mesh.rotation.y = Math.atan2(-this.dir.x, -this.dir.z);
    this.position(this.mesh.position);
  }

  private props: Group[] = [];
  private beacon: Mesh[] = [];
  private time = 0;

  /** Blocky four-prop cargo plane: striped fuselage, cockpit glass, window rows, spinning props, open rear ramp. */
  private buildModel() {
    const g = new Group();
    const add = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, emissive = 0) => {
      const m = boxMesh(w, h, d, color, emissive);
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };
    const WHITE = 0xe8ecf0, GREY = 0xb9c2ca, RED = 0xd04a3a, GOLD = 0xffb020, DARK = 0x2c323a, GLASS = 0x1d2a3a;
    // Fuselage
    add(4.5, 4.5, 28, WHITE, 0, 0, 0);
    add(3.6, 0.7, 24, WHITE, 0, 2.55, 0.5);
    add(3.8, 1, 26, GREY, 0, -2.6, 0);
    add(4.62, 0.6, 28.2, GOLD, 0, 0.1, 0);
    add(4.62, 0.22, 28.2, RED, 0, -0.5, 0);
    for (let z = -10; z <= 9; z += 2.2) {
      for (const x of [-2.28, 2.28]) add(0.1, 0.75, 0.9, GLASS, x, 1.2, z, 0x0a1826);
    }
    // Side door outline (the one you jump from)
    for (const x of [-2.3, 2.3]) {
      add(0.08, 3, 0.15, DARK, x, -0.3, 6.2);
      add(0.08, 3, 0.15, DARK, x, -0.3, 8.2);
      add(0.08, 0.15, 2.1, DARK, x, 1.2, 7.2);
    }
    // Nose: stepped down to a red cone, with a slanted windshield
    add(4.1, 4.1, 2, WHITE, 0, -0.1, -15);
    add(3.3, 3.3, 1.6, RED, 0, -0.3, -16.8);
    add(2, 2, 1, DARK, 0, -0.4, -18.1);
    const glass = add(3.4, 0.9, 1.6, GLASS, 0, 1.75, -14.6, 0x10263d);
    glass.rotation.x = -0.45;
    for (const x of [-1.72, 1.72]) add(0.1, 0.6, 1.2, GLASS, x, 1.3, -15.2, 0x0a1826);
    // Wings with flaps and nav lights
    add(38, 0.6, 6, 0xc9d0d6, 0, -0.5, -2);
    add(34, 0.3, 1.3, 0x9aa3ab, 0, -0.55, 1.6);
    add(38.2, 0.62, 0.8, GOLD, 0, -0.5, -4.7);
    this.beacon.push(add(0.7, 0.7, 1, 0xff3030, -19.2, -0.5, -2, 0xff2020));
    this.beacon.push(add(0.7, 0.7, 1, 0x30ff60, 19.2, -0.5, -2, 0x20ff50));
    // Four engines with propellers
    for (const x of [-13, -7, 7, 13]) {
      add(2, 2, 5.5, 0x5b6470, x, -1.4, -3);
      add(2.3, 2.3, 0.5, DARK, x, -1.4, -5.8);
      add(1.2, 0.5, 2, 0x444b53, x, -2.5, -0.5);
      const prop = new Group();
      prop.position.set(x, -1.4, -6.3);
      const hub = boxMesh(0.7, 0.7, 0.8, RED);
      const b1 = boxMesh(0.35, 5.2, 0.12, 0x222222);
      const b2 = boxMesh(5.2, 0.35, 0.12, 0x222222);
      prop.add(hub, b1, b2);
      g.add(prop);
      this.props.push(prop);
    }
    // Tail: fin with a gold band and a bolt, tailplane, open cargo ramp
    add(0.6, 6.5, 4.2, RED, 0, 4.2, 12.6);
    add(0.66, 1, 3.8, GOLD, 0, 6.6, 13);
    const bolt1 = add(0.7, 1.6, 0.4, GOLD, 0, 3.7, 12.2, 0x6a4a00);
    bolt1.rotation.x = 0.5;
    const bolt2 = add(0.7, 1.6, 0.4, GOLD, 0, 2.7, 12.9, 0x6a4a00);
    bolt2.rotation.x = 0.5;
    add(13, 0.5, 3, 0xc9d0d6, 0, 1.5, 13.4);
    add(3.8, 3.8, 0.2, 0x181b20, 0, -0.1, 14.05);
    const ramp = add(3.6, 0.3, 4, 0x9aa3ab, 0, -3.2, 15.6);
    ramp.rotation.x = 0.35;
    // Belly gear pods and a roof antenna
    for (const x of [-2.6, 2.6]) add(1.2, 1.1, 4.5, 0x8a939c, x, -2.3, 0);
    add(0.15, 1.3, 0.15, DARK, 0, 3.4, -6);
    add(0.12, 0.12, 2.2, DARK, 0, 4.0, -6.8);
    this.beacon.push(add(0.5, 0.4, 0.5, 0xff3030, 0, 3.05, 3, 0xff2020));
    return g;
  }

  position(out: Vector3) {
    return out.lerpVectors(this.start, this.end, this.progress);
  }

  update(dt: number) {
    this.time += dt;
    for (const p of this.props) p.rotation.z += dt * 38;
    const blink = Math.sin(this.time * 6) > 0.6;
    for (const b of this.beacon) b.visible = blink || b !== this.beacon[2];
    // A gentle roll so it feels like it's flying, not sliding.
    this.mesh.rotation.z = Math.sin(this.time * 0.6) * 0.035;
    if (!this.active) return;
    this.progress += (CONFIG.drop.planeSpeed * dt) / this.length;
    if (this.progress >= 1) {
      this.progress = 1;
      this.active = false;
    }
    this.position(this.mesh.position);
  }

  overIsland() {
    const p = this.mesh.position;
    return Math.hypot(p.x, p.z) < CONFIG.mapSize / 2 - 30;
  }

  /** True once `jumpAt` (0..1 of the path) is reached over land, or when the plane is about to leave the island. */
  shouldJump(jumpAt: number) {
    const over = this.overIsland();
    if (over) return this.progress >= jumpAt;
    return this.progress > 0.5 || !this.active;
  }

  /** Removes the plane from the scene once everyone has jumped. */
  dispose(scene: Scene) {
    scene.remove(this.mesh);
  }
}
