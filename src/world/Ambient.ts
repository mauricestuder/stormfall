import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, InstancedMesh, Matrix4, MeshLambertMaterial, Object3D, Scene, Vector3,
} from 'three';

const tmpC = new Color(), tmpR = new Matrix4(), tmpE = new Object3D();

/** One wing: a triangle hinged along the body at x = 0, reaching out to x = side * span / 2. */
function wing(span: number, chord: number, side: number) {
  const g = new BufferGeometry(), h = (span / 2) * side, c = chord / 2;
  g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, -c, h, 0, c * 0.2, 0, 0, c]), 3));
  g.computeVertexNormals();
  return g;
}

interface Flock { cx: number; cz: number; y: number; r: number; speed: number; a: number; birds: { da: number; dy: number; dr: number; ph: number }[] }
interface Fly { x: number; y: number; z: number; hx: number; hz: number; ph: number; sp: number }

const MAX_BIRDS = 28, MAX_FLIES = 36;

/** A pair of instanced meshes (left and right wings) that flap by turning about the body axis. */
class Wings {
  l: InstancedMesh;
  r: InstancedMesh;
  n = 0;
  constructor(scene: Scene, span: number, chord: number, mat: MeshLambertMaterial, max: number) {
    this.l = new InstancedMesh(wing(span, chord, -1), mat, max);
    this.r = new InstancedMesh(wing(span, chord, 1), mat, max);
    for (const m of [this.l, this.r]) {
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
    }
  }
  /** Adds one: body transform from tmpE, wings raised by `flap` radians. */
  put(flap: number) {
    tmpE.updateMatrix();
    this.l.setMatrixAt(this.n, tmpR.makeRotationZ(-flap).premultiply(tmpE.matrix));
    this.r.setMatrixAt(this.n, tmpR.makeRotationZ(flap).premultiply(tmpE.matrix));
    this.n++;
  }
  color(i: number, c: number) {
    this.l.setColorAt(i, tmpC.setHex(c));
    this.r.setColorAt(i, tmpC);
  }
  commit(visible: boolean) {
    for (const m of [this.l, this.r]) {
      m.visible = visible;
      m.count = this.n;
      m.instanceMatrix.needsUpdate = true;
    }
    this.n = 0;
  }
}

/**
 * Life around the player: flocks of birds wheeling overhead and butterflies over the grass
 * (daytime only). Everything stays near the camera, so it costs the same anywhere on the map.
 */
export class Ambient {
  private birds: Wings;
  private flies: Wings;
  private flocks: Flock[] = [];
  private bugs: Fly[] = [];
  private t = 0;
  day = true;
  /** Battlefield: black crows, no butterflies. */
  war = false;

  constructor(scene: Scene, private groundAt: (x: number, z: number) => number, private isWater: (x: number, z: number) => boolean) {
    this.birds = new Wings(scene, 1.2, 0.4, new MeshLambertMaterial({ color: 0x141416, side: DoubleSide }), MAX_BIRDS);
    this.flies = new Wings(scene, 0.3, 0.22, new MeshLambertMaterial({ color: 0xffffff, side: DoubleSide }), MAX_FLIES);
    const cols = [0xffd23a, 0xffffff, 0xff8a2a, 0x7ec8ff, 0xf28ad8];
    for (let i = 0; i < MAX_FLIES; i++) this.flies.color(i, cols[i % cols.length]);
  }

  update(dt: number, cam: Vector3, show: boolean) {
    this.t += dt;
    if (!show) {
      this.birds.commit(false);
      this.flies.commit(false);
      return;
    }
    // Flocks: keep four circling within ~250 m, drop ones left far behind.
    this.flocks = this.flocks.filter((f) => Math.hypot(f.cx - cam.x, f.cz - cam.z) < 320);
    while (this.flocks.length < 4) {
      const a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 180;
      const cx = cam.x + Math.cos(a) * d, cz = cam.z + Math.sin(a) * d;
      this.flocks.push({
        cx, cz, y: Math.max(0, this.groundAt(cx, cz)) + 28 + Math.random() * 30, r: 18 + Math.random() * 30,
        speed: (0.18 + Math.random() * 0.15) * (Math.random() < 0.5 ? -1 : 1), a: Math.random() * 6,
        birds: Array.from({ length: 5 + Math.floor(Math.random() * 3) }, () => ({ da: (Math.random() - 0.5) * 0.5, dy: (Math.random() - 0.5) * 4, dr: (Math.random() - 0.5) * 6, ph: Math.random() * 6 })),
      });
    }
    for (const f of this.flocks) {
      f.a += f.speed * dt;
      for (const b of f.birds) {
        if (this.birds.n >= MAX_BIRDS) break;
        const a = f.a + b.da, r = f.r + b.dr, dir = Math.sign(f.speed);
        tmpE.position.set(f.cx + Math.cos(a) * r, f.y + b.dy + Math.sin(this.t * 0.7 + b.ph) * 1.5, f.cz + Math.sin(a) * r);
        // Heading along the circle (tangent), banked into the turn.
        tmpE.rotation.set(0, Math.atan2(-Math.sin(a) * dir, Math.cos(a) * dir), -0.3 * dir, 'YXZ');
        // Flap, with glides now and then.
        const gliding = Math.sin(this.t * 0.8 + b.ph) < -0.3;
        this.birds.put(gliding ? 0.12 : Math.sin(this.t * 9 + b.ph) * 0.7);
      }
    }
    this.birds.commit(true);

    // Butterflies (daytime): flutter round a home spot on dry land near the camera.
    if (!this.day || this.war) {
      this.flies.commit(false);
      return;
    }
    this.bugs = this.bugs.filter((b) => Math.hypot(b.hx - cam.x, b.hz - cam.z) < 55);
    for (let tries = 0; this.bugs.length < MAX_FLIES && tries < 10; tries++) {
      const a = Math.random() * Math.PI * 2, d = 8 + Math.random() * 40;
      const hx = cam.x + Math.cos(a) * d, hz = cam.z + Math.sin(a) * d, gy = this.groundAt(hx, hz);
      if (gy < 1 || this.isWater(hx, hz)) continue;
      this.bugs.push({ x: hx, y: gy + 0.8, z: hz, hx, hz, ph: Math.random() * 6, sp: 1 + Math.random() });
    }
    for (const b of this.bugs) {
      const t = this.t * b.sp + b.ph;
      const nx = b.hx + Math.sin(t * 0.7) * 2.5 + Math.sin(t * 1.9) * 0.8, nz = b.hz + Math.cos(t * 0.5) * 2.5 + Math.cos(t * 2.3) * 0.8;
      const yaw = Math.atan2(nx - b.x, nz - b.z);
      b.x = nx;
      b.z = nz;
      b.y = this.groundAt(nx, nz) + 0.7 + Math.sin(t * 1.3) * 0.35 + Math.abs(Math.sin(t * 7)) * 0.12;
      tmpE.position.set(b.x, b.y, b.z);
      tmpE.rotation.set(0, yaw, 0);
      this.flies.put(0.2 + Math.abs(Math.sin(this.t * 20 + b.ph)) * 1.2);
    }
    this.flies.commit(true);
  }
}
