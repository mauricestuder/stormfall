import {
  AdditiveBlending, BoxGeometry, DoubleSide, BufferGeometry, Color, DynamicDrawUsage, IcosahedronGeometry, InstancedBufferAttribute,
  InstancedMesh, MeshBasicMaterial, NormalBlending, Object3D, PlaneGeometry, Scene, ShaderMaterial, UniformsLib, UniformsUtils, Vector3,
} from 'three';

/** Per-instance RGBA, fog-aware, cheap fake lighting. One draw call per particle layer. */
function particleMaterial(additive: boolean, lit: boolean) {
  return new ShaderMaterial({
    side: lit ? DoubleSide : undefined,
    uniforms: UniformsUtils.merge([UniformsLib.fog]),
    vertexShader: /* glsl */ `
      attribute vec4 aColor;
      varying vec4 vColor;
      varying float vShade;
      #include <fog_pars_vertex>
      void main() {
        vColor = aColor;
        vec3 n = normalize(mat3(instanceMatrix) * normal);
        vShade = ${lit ? '0.72 + 0.28 * n.y' : '1.0'};
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      varying vec4 vColor;
      varying float vShade;
      #include <fog_pars_fragment>
      void main() {
        gl_FragColor = vec4(vColor.rgb * vShade, vColor.a);
        #include <fog_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    fog: true,
    blending: additive ? AdditiveBlending : NormalBlending,
  });
}

export interface Particle {
  pos: Vector3;
  vel: Vector3;
  life: number;
  maxLife: number;
  size: number;
  grow: number;
  gravity: number;
  drag: number;
  alpha: number;
  color: Color;
  /** Tracers: stretched from pos to `end`. */
  end: Vector3;
  stretch: boolean;
  spin: number;
}

class Layer {
  mesh: InstancedMesh;
  items: Particle[] = [];
  private colors: InstancedBufferAttribute;
  private free: Particle[] = [];

  constructor(scene: Scene, geo: BufferGeometry, additive: boolean, lit: boolean, private cap: number) {
    this.mesh = new InstancedMesh(geo, particleMaterial(additive, lit), cap);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.colors = new InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(DynamicDrawUsage);
    geo.setAttribute('aColor', this.colors);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = additive ? 3 : 2;
    scene.add(this.mesh);
  }

  spawn(): Particle | null {
    if (this.items.length >= this.cap) {
      // Recycle the oldest particle rather than dropping new effects.
      const old = this.items.shift()!;
      this.items.push(old);
      return old;
    }
    const p = this.free.pop() ?? { pos: new Vector3(), vel: new Vector3(), life: 0, maxLife: 1, size: 1, grow: 0, gravity: 0, drag: 0, alpha: 1, color: new Color(), spin: 0, end: new Vector3(), stretch: false };
    p.stretch = false;
    this.items.push(p);
    return p;
  }

  update(dt: number) {
    let n = 0;
    const arr = this.colors.array as Float32Array;
    for (let i = 0; i < this.items.length; i++) {
      const p = this.items[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.free.push(p);
        this.items[i] = this.items[this.items.length - 1];
        this.items.pop();
        i--;
        continue;
      }
      p.vel.y -= p.gravity * dt;
      if (p.drag) p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
      p.pos.addScaledVector(p.vel, dt);
      const k = 1 - p.life / p.maxLife;
      if (p.stretch) {
        dummy.position.copy(p.pos);
        dummy.lookAt(p.end);
        dummy.scale.set(p.size, p.size, p.pos.distanceTo(p.end));
      } else {
        dummy.position.copy(p.pos);
        dummy.quaternion.setFromAxisAngle(up, p.spin * p.life);
        dummy.scale.setScalar(p.size * (1 + k * p.grow));
      }
      dummy.updateMatrix();
      this.mesh.setMatrixAt(n, dummy.matrix);
      arr[n * 4] = p.color.r;
      arr[n * 4 + 1] = p.color.g;
      arr[n * 4 + 2] = p.color.b;
      arr[n * 4 + 3] = p.alpha * (1 - k * k);
      n++;
    }
    this.mesh.count = n;
    if (n) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.colors.needsUpdate = true;
    }
  }
}

const dummy = new Object3D();
const tmpT = new Vector3();
const up = new Vector3(0.3, 1, 0.2).normalize();

const tracerGeo = new BoxGeometry(1, 1, 1);
tracerGeo.translate(0, 0, 0.5); // lookAt() points +Z at the target

/**
 * All short-lived effects (tracers, sparks, blood, glass, smoke, dust) share three instanced layers,
 * so a big firefight costs three draw calls instead of hundreds.
 */
export class Particles {
  private tracers: Layer;
  private sparks: Layer;
  private smoke: Layer;
  /** Additive: muzzle flashes and hot sparks that glow. */
  private glows: Layer;
  private decals: InstancedMesh;
  private decalNext = 0;
  private static readonly DECALS = 220;

  constructor(scene: Scene) {
    this.tracers = new Layer(scene, tracerGeo, true, false, 160);
    this.sparks = new Layer(scene, new BoxGeometry(1, 1, 1), false, false, 500);
    this.smoke = new Layer(scene, new IcosahedronGeometry(1, 1), false, true, 700);
    this.glows = new Layer(scene, new IcosahedronGeometry(1, 0), true, false, 300);
    // Bullet holes: small dark squares that stay on walls and ground (oldest are reused).
    const mat = new MeshBasicMaterial({ color: 0x17140f, transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.decals = new InstancedMesh(new PlaneGeometry(1, 1), mat, Particles.DECALS);
    this.decals.frustumCulled = false;
    this.decals.count = 0;
    this.decals.renderOrder = 1;
    scene.add(this.decals);
  }

  /** A bullet hole on a surface facing `normal`. */
  decal(at: Vector3, normal: Vector3, size = 0.09) {
    dummy.position.copy(at).addScaledVector(normal, 0.01);
    dummy.lookAt(tmpT.copy(dummy.position).add(normal));
    dummy.rotateZ(Math.random() * Math.PI);
    dummy.scale.setScalar(size * (0.8 + Math.random() * 0.4));
    dummy.updateMatrix();
    this.decals.setMatrixAt(this.decalNext, dummy.matrix);
    this.decalNext = (this.decalNext + 1) % Particles.DECALS;
    this.decals.count = Math.max(this.decals.count, this.decalNext === 0 ? Particles.DECALS : this.decalNext);
    this.decals.instanceMatrix.needsUpdate = true;
  }

  /** A quick bright flash (someone else's muzzle flash, a spark of light). */
  flash(at: Vector3, color: number, size: number, life = 0.05) {
    const p = this.glows.spawn();
    if (!p) return;
    p.pos.copy(at);
    p.vel.set(0, 0, 0);
    p.gravity = p.drag = 0;
    p.size = size;
    p.grow = -0.4;
    p.life = p.maxLife = life;
    p.alpha = 1;
    p.spin = Math.random() * 30;
    p.color.setHex(color);
  }

  get smokeCount() {
    return this.smoke.items.length;
  }

  tracer(from: Vector3, to: Vector3, color: number, width = 0.025, life = 0.07) {
    const p = this.tracers.spawn();
    if (!p) return;
    p.pos.copy(from);
    p.end.copy(to);
    p.stretch = true;
    p.vel.set(0, 0, 0);
    p.gravity = p.drag = 0;
    p.size = width;
    p.life = p.maxLife = life;
    p.alpha = 1;
    p.color.setHex(color);
  }

  /** Small cubes flying outward: bullet sparks, blood, glass. */
  burst(at: Vector3, color: number, count: number, opts: { speed?: number; size?: number; life?: number; gravity?: number; up?: number; dir?: Vector3; alpha?: number; glow?: boolean } = {}) {
    for (let i = 0; i < count; i++) {
      const p = (opts.glow ? this.glows : this.sparks).spawn();
      if (!p) return;
      const s = opts.speed ?? 6;
      p.pos.copy(at);
      p.vel.set(Math.random() - 0.5, Math.random() * (opts.up ?? 0.8), Math.random() - 0.5).multiplyScalar(s);
      if (opts.dir) p.vel.addScaledVector(opts.dir, s * 0.6);
      p.gravity = opts.gravity ?? 20;
      p.drag = 0.5;
      p.size = (opts.size ?? 0.08) * (0.7 + Math.random() * 0.6);
      p.grow = -0.5;
      p.life = p.maxLife = (opts.life ?? 0.25) * (0.7 + Math.random() * 0.6);
      p.alpha = opts.alpha ?? 1;
      p.spin = Math.random() * 20;
      p.color.setHex(color);
    }
  }

  /** Soft rising puffs: smoke, dust, steam, smoke grenades. */
  puff(at: Vector3, color: number, count: number, speed: number, size: number, rise = 1.5, life = 1.2, opts: { alpha?: number; grow?: number; drag?: number; spread?: number } = {}) {
    for (let i = 0; i < count; i++) {
      const p = this.smoke.spawn();
      if (!p) return;
      const sp = opts.spread ?? 0;
      p.pos.set(at.x + (Math.random() - 0.5) * sp, at.y + (Math.random() - 0.5) * sp * 0.4, at.z + (Math.random() - 0.5) * sp);
      p.vel.set((Math.random() - 0.5) * speed, rise + Math.random() * speed * 0.5, (Math.random() - 0.5) * speed);
      p.gravity = 0;
      p.drag = opts.drag ?? 0.8;
      p.size = size;
      p.grow = opts.grow ?? 2.2;
      p.life = p.maxLife = life * (0.7 + Math.random() * 0.6);
      p.alpha = opts.alpha ?? 0.6;
      p.spin = Math.random() * 2;
      p.color.setHex(color);
    }
  }

  update(dt: number) {
    this.tracers.update(dt);
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.glows.update(dt);
  }

}

