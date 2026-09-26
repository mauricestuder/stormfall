import { AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, Color, CylinderGeometry, DoubleSide, Mesh, MeshBasicMaterial, Points, PointsMaterial, Scene, ShaderMaterial, Vector2, Vector3 } from 'three';
import { CONFIG } from '../config';
import { THEME } from '../theme';

/** The Wild West gets a sandstorm instead of the purple storm. */
export const DUST_STORM = THEME === 'western';

/** Sandstorm wall: thick rolling dust, densest at the ground, with streaks of grit blowing past up close. */
const DUST_FRAG = `
  uniform float time, radius, strength; uniform vec3 colA, colB, glow;
  varying vec2 vUv; varying float vY; varying float vDist;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
  void main() {
    float around = vUv.x * 6.2832 * radius;
    vec2 p = vec2(around / 60.0, vY / 45.0);
    // Wind blows along the wall while the billows roll slowly upward.
    vec2 q = vec2(fbm(p + vec2(time * 0.35, -time * 0.05)), fbm(p * 1.3 + vec2(-time * 0.2, time * 0.03) + 5.2));
    float n = fbm(p * 1.6 + q * 1.8 + vec2(time * 0.5, 0.0));
    float ground = 1.0 - smoothstep(0.0, 260.0, vY);
    vec3 c = mix(colA, colB, smoothstep(0.25, 0.85, n)) * (0.75 + 0.35 * ground);
    float a = (0.42 + 0.45 * n) * (0.45 + 0.55 * ground) * strength;
    float grit = smoothstep(0.8, 1.0, noise(vec2(around / 1.5 + time * 22.0, vY / 0.35))) * (1.0 - smoothstep(30.0, 140.0, vDist));
    c = mix(c, glow, grit * 0.45);
    a += grit * 0.15 * strength;
    float seam = exp(-max(vY - 1.0, 0.0) / 6.0);
    c = mix(c, colB * 1.15, seam * 0.5);
    a += seam * 0.3 * strength;
    a *= 1.0 - smoothstep(220.0, 450.0, vY);
    float far = smoothstep(200.0, 700.0, vDist);
    c = mix(c, mix(colA, colB, 0.6), far);
    a *= 1.0 - far * 0.3;
    gl_FragColor = vec4(c, clamp(a, 0.0, 0.93));
  }`;

const DUST_N = 900, DUST_BOX = 36;

type State = 'waiting' | 'shrinking' | 'closed';

/** Shrinking storm circle. The "safe" circle is where the zone is heading next. */
export class Zone {
  center = new Vector2();
  radius = CONFIG.zone.initialRadius;
  phase = 0;
  state: State = 'waiting';
  timer = 0;
  private from = new Vector2();
  private fromR = 0;
  next = new Vector2();
  nextR = 0;
  private wall: Mesh;
  private wallMat: ShaderMaterial;
  private ring: Mesh;
  /** Blowing sand around the camera near and inside a sandstorm. */
  private dust: Points | null = null;

  /** Show or hide the storm wall and its dust (hidden in the menus). */
  set shown(v: boolean) {
    this.wall.visible = v;
    if (this.dust) this.dust.visible = v;
  }
  private dustPos = new Float32Array(DUST_N * 3);
  private dustLocal = new Float32Array(DUST_N * 3);
  private time = 0;
  /** Terrain height lookup so the next-circle ring hugs the hills. */
  groundAt: (x: number, z: number) => number = () => 0;

  constructor(scene: Scene) {
    const geo = new CylinderGeometry(1, 1, 900, 160, 1, true);
    geo.translate(0, 350, 0);
    // A purple storm: drifting cloud bands, rain streaks, a bright seam where it meets the ground,
    // fading out high up so it reads as weather rather than a flat wall.
    this.wallMat = new ShaderMaterial({
      transparent: true, side: DoubleSide, depthWrite: false,
      uniforms: {
        time: { value: 0 }, radius: { value: 700 }, strength: { value: DUST_STORM ? 1.7 : 1 },
        colA: { value: new Color(DUST_STORM ? 0x5a3418 : 0x4b1fa8) }, colB: { value: new Color(DUST_STORM ? 0xc07c3c : 0xc04dff) },
        glow: { value: new Color(DUST_STORM ? 0xe2b47a : 0xf0b8ff) },
      },
      vertexShader: `
        varying vec2 vUv; varying float vY; varying float vDist;
        void main() {
          vUv = uv;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vY = w.y;
          vDist = distance(w.xz, cameraPosition.xz);
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: `
        uniform float time, radius, strength; uniform vec3 colA, colB, glow;
        varying vec2 vUv; varying float vY; varying float vDist;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
        }
        void main() {
          float around = vUv.x * 6.2832 * radius;   // metres along the wall
          vec2 p = vec2(around / 90.0, vY / 70.0);
          float n = noise(p + vec2(time * 0.05, -time * 0.12)) * 0.6 + noise(p * 2.7 + vec2(-time * 0.09, -time * 0.25)) * 0.4;
          float rain = smoothstep(0.8, 1.0, noise(vec2(around / 2.5, vY / 30.0 + time * 3.0))) * (1.0 - smoothstep(40.0, 160.0, vDist));
          vec3 c = mix(colA, colB, n);
          float a = (0.22 + 0.3 * n) * strength;
          float seam = exp(-max(vY - 2.0, 0.0) / 10.0);
          c = mix(c, glow, seam * 0.55);
          a += seam * 0.35 * strength + rain * 0.12 * strength;
          a *= 1.0 - smoothstep(180.0, 420.0, vY);
          // Far away it softens into a haze instead of a busy pattern across the sky.
          float far = smoothstep(150.0, 650.0, vDist);
          c = mix(c, mix(colA, colB, 0.5), far);
          a *= 1.0 - far * 0.45;
          gl_FragColor = vec4(c, clamp(a, 0.0, 0.85));
        }`,
    });
    if (DUST_STORM) this.wallMat.fragmentShader = DUST_FRAG;
    this.wall = new Mesh(geo, this.wallMat);
    this.wall.renderOrder = 2;
    scene.add(this.wall);

    this.ring = new Mesh(new BufferGeometry(), new MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.55, side: DoubleSide, depthWrite: false, blending: AdditiveBlending,
    }));
    this.ring.renderOrder = 3;
    scene.add(this.ring);

    if (DUST_STORM) {
      for (let i = 0; i < DUST_N * 3; i++) this.dustLocal[i] = (Math.random() - 0.5) * DUST_BOX * 2;
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(this.dustPos, 3));
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const ctx = c.getContext('2d')!, grd = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, 32, 32);
      this.dust = new Points(g, new PointsMaterial({
        color: 0xd9ad72, size: 0.35, map: new CanvasTexture(c), transparent: true, opacity: 0.8, depthWrite: false,
      }));
      this.dust.frustumCulled = false;
      this.dust.renderOrder = 3;
      scene.add(this.dust);
    }
  }

  /** Sand blowing along the storm wall around the camera; grains stay on the storm side of it. */
  updateDust(cam: Vector3, dt: number) {
    const d = this.dust;
    if (!d) return;
    const dx = cam.x - this.center.x, dz = cam.z - this.center.y, r = Math.hypot(dx, dz) || 1;
    const edge = r - this.radius;
    d.visible = edge > -DUST_BOX * 1.5 && this.radius > 0;
    if (!d.visible) return;
    // Wind runs round the circle (tangent) with a little lift.
    const tx = -dz / r, tz = dx / r, wind = 16 * dt, B = DUST_BOX, L = this.dustLocal, P = this.dustPos;
    for (let i = 0; i < DUST_N; i++) {
      const k = i * 3, s = 0.7 + (i % 7) * 0.08;
      let x = L[k] + tx * wind * s, y = L[k + 1] + wind * 0.08 * Math.sin(i + this.time), z = L[k + 2] + tz * wind * s;
      if (x > B) x -= 2 * B; else if (x < -B) x += 2 * B;
      if (y > B) y -= 2 * B; else if (y < -B) y += 2 * B;
      if (z > B) z -= 2 * B; else if (z < -B) z += 2 * B;
      L[k] = x; L[k + 1] = y; L[k + 2] = z;
      const wx = cam.x + x, wz = cam.z + z;
      const out = Math.hypot(wx - this.center.x, wz - this.center.y) > this.radius - 2;
      P[k] = wx; P[k + 1] = out ? cam.y - 3 + (y + B) * (14 / (2 * B)) : -9999; P[k + 2] = wz;
    }
    (d.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
  }

  /** Against a dark night sky the storm wall needs to be much fainter. */
  setDark(dark: boolean) {
    this.wallMat.uniforms.strength.value = (dark ? 0.45 : 1) * (DUST_STORM ? 1.7 : 1);
  }

  /** Random source for the circles (seeded online so everyone gets the same zone). */
  rnd: () => number = Math.random;

  start() {
    this.center.set((this.rnd() - 0.5) * 100, (this.rnd() - 0.5) * 100);
    this.radius = CONFIG.zone.initialRadius;
    this.phase = 0;
    this.beginPhase();
  }

  private beginPhase() {
    const ph = CONFIG.zone.phases[this.phase];
    this.state = 'waiting';
    this.timer = ph.wait;
    this.from.copy(this.center);
    this.fromR = this.radius;
    // Next circle lies fully inside the current one, and inside the island.
    const maxOff = Math.max(0, this.radius - ph.radius);
    for (let i = 0; i < 30; i++) {
      const a = this.rnd() * Math.PI * 2, r = Math.sqrt(this.rnd()) * maxOff * 0.9;
      this.next.set(this.center.x + Math.cos(a) * r, this.center.y + Math.sin(a) * r);
      if (Math.hypot(this.next.x, this.next.y) < CONFIG.mapSize / 2 - 40 - ph.radius * 0.5) break;
    }
    this.nextR = ph.radius;
    this.rebuildRing();
  }

  /** The next circle: a soft glowing ribbon standing on the ground. */
  private rebuildRing() {
    const segs = 200, pos = new Float32Array((segs + 1) * 2 * 3), idx: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const x = this.next.x + Math.cos(a) * this.nextR, z = this.next.y + Math.sin(a) * this.nextR;
      const y = Math.max(-0.3, this.groundAt(x, z));
      pos.set([x, y + 0.2, z, x, y + 3.2, z], i * 6);
      if (i < segs) idx.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setIndex(idx);
    this.ring.geometry.dispose();
    this.ring.geometry = g;
  }

  update(dt: number) {
    if (this.state === 'closed') return;
    this.timer -= dt;
    const ph = CONFIG.zone.phases[this.phase];
    if (this.state === 'waiting' && this.timer <= 0) {
      this.state = 'shrinking';
      this.timer = ph.shrink;
    } else if (this.state === 'shrinking') {
      const t = 1 - Math.max(0, this.timer) / ph.shrink;
      this.center.lerpVectors(this.from, this.next, t);
      this.radius = this.fromR + (this.nextR - this.fromR) * t;
      if (this.timer <= 0) {
        this.phase++;
        if (this.phase >= CONFIG.zone.phases.length) {
          this.state = 'closed';
          this.phase = CONFIG.zone.phases.length - 1;
        } else this.beginPhase();
      }
    }
    this.time += dt;
    this.wallMat.uniforms.time.value = this.time;
    this.wallMat.uniforms.radius.value = Math.max(1, this.radius);
    (this.ring.material as MeshBasicMaterial).opacity = 0.35 + Math.sin(this.time * 2.5) * 0.12;
    this.wall.position.set(this.center.x, 0, this.center.y);
    this.wall.scale.set(Math.max(0.01, this.radius), 1, Math.max(0.01, this.radius));
    this.ring.visible = false; // the next circle is shown on the map only
  }

  get dps() {
    return CONFIG.zone.phases[this.phase].dps;
  }

  isOutside(x: number, z: number) {
    return Math.hypot(x - this.center.x, z - this.center.y) > this.radius;
  }

  /** Will the gas be over (x, z) within `secs` seconds (or is it already)? */
  closingOn(x: number, z: number, secs: number, margin = 6) {
    if (Math.hypot(x - this.center.x, z - this.center.y) > this.radius - margin) return true;
    if (this.state !== 'shrinking') return false;
    const ph = CONFIG.zone.phases[this.phase];
    const t = Math.min(1, 1 - (this.timer - secs) / ph.shrink);
    const cx = this.from.x + (this.next.x - this.from.x) * t, cz = this.from.y + (this.next.y - this.from.y) * t;
    return Math.hypot(x - cx, z - cz) > this.fromR + (this.nextR - this.fromR) * t - margin;
  }

  /** Outside the circle we're heading to (with a margin; positive margin = stricter). */
  outsideSafe(x: number, z: number, margin: number) {
    const c = this.safeCenter();
    const r = this.state === 'waiting' ? this.nextR : Math.min(this.radius, this.nextR + 20);
    return Math.hypot(x - c.x, z - c.y) > Math.max(2, r - margin);
  }

  safeCenter() {
    return this.next;
  }

  safeCenter3(out = new Vector3()) {
    return out.set(this.next.x, 0, this.next.y);
  }

  randomSafePoint(frac: number) {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * this.nextR * frac;
    return new Vector3(this.next.x + Math.cos(a) * r, 0, this.next.y + Math.sin(a) * r);
  }

  label() {
    if (this.state === 'closed') return 'FINAL ZONE';
    const s = Math.max(0, Math.ceil(this.timer));
    const mm = Math.floor(s / 60), ss = String(s % 60).padStart(2, '0');
    return this.state === 'waiting' ? `ZONE CLOSES IN ${mm}:${ss}` : `ZONE SHRINKING ${mm}:${ss}`;
  }
}
