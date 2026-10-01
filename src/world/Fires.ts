import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, Color, NormalBlending, PerspectiveCamera, PointLight, Points,
  Scene, ShaderMaterial, UniformsLib, UniformsUtils, Vector3, type Blending,
} from 'three';

interface Fire { x: number; y: number; z: number; s: number; seed: number }

/** Flames and embers per fire (near ones only), smoke puffs per fire (every fire: the columns are seen from afar). */
const FLAMES = 18, EMBERS = 5, SMOKE = 12;
const FLAME_R = 170, LIGHTS = 3, ASH = 0, ASH_BOX = 40;

function softTexture(noisy: boolean) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(noisy ? 0.45 : 0.3, `rgba(255,255,255,${noisy ? 0.7 : 0.55})`);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  if (noisy) {
    // Lumpy, so the smoke billows instead of looking like soft balls.
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, d = 12 + Math.random() * 20, r = 3 + Math.random() * 7;
      ctx.fillStyle = `rgba(0,0,0,${0.15 + Math.random() * 0.3})`;
      ctx.beginPath();
      ctx.arc(32 + Math.cos(a) * d, 32 + Math.sin(a) * d, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return new CanvasTexture(cv);
}

/** Points with a size and colour+alpha per point, sized in metres. */
class Cloud {
  pts: Points;
  pos: Float32Array;
  size: Float32Array;
  tint: Float32Array;
  n = 0;
  mat: ShaderMaterial;
  constructor(scene: Scene, max: number, noisy: boolean, blending: Blending, fog: boolean) {
    const g = new BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.tint = new Float32Array(max * 4);
    g.setAttribute('position', new BufferAttribute(this.pos, 3));
    g.setAttribute('size', new BufferAttribute(this.size, 1));
    g.setAttribute('tint', new BufferAttribute(this.tint, 4));
    this.mat = new ShaderMaterial({
      uniforms: UniformsUtils.merge([UniformsLib.fog, { map: { value: null }, scale: { value: 500 } }]),
      vertexShader: `attribute float size; attribute vec4 tint; uniform float scale; varying vec4 vTint;
        #include <fog_pars_vertex>
        void main() {
          vTint = tint;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = min(size * scale / max(0.5, -mvPosition.z), 900.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `uniform sampler2D map; varying vec4 vTint;
        #include <fog_pars_fragment>
        void main() {
          vec4 t = texture2D(map, gl_PointCoord);
          gl_FragColor = vec4(vTint.rgb, t.a * vTint.a);
          if (gl_FragColor.a < 0.004) discard;
          #include <fog_fragment>
        }`,
      transparent: true, depthWrite: false, blending, fog,
    });
    this.mat.uniforms.map.value = softTexture(noisy);
    this.pts = new Points(g, this.mat);
    this.pts.frustumCulled = false;
    scene.add(this.pts);
  }
  push(x: number, y: number, z: number, s: number, r: number, g: number, b: number, a: number) {
    const i = this.n++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.size[i] = s;
    this.tint.set([r, g, b, a], i * 4);
  }
  commit(scale: number) {
    const g = this.pts.geometry;
    g.setDrawRange(0, this.n);
    for (const k of ['position', 'size', 'tint']) (g.getAttribute(k) as BufferAttribute).needsUpdate = true;
    this.mat.uniforms.scale.value = scale;
    this.n = 0;
  }
}

const frac = (v: number) => v - Math.floor(v);
const tmpC = new Color();

/**
 * The battlefield burning: flickering flames, embers and a column of black smoke over every fire,
 * orange light from the nearest few, and ash drifting down round the camera.
 */
export class Fires {
  private fires: Fire[];
  private flames: Cloud;
  private smoke: Cloud;
  private ash: Cloud;
  private ashPos: Float32Array;
  private lights: PointLight[] = [];
  private t = 0;
  /** Wind the smoke leans with. */
  private wind = new Vector3(1.6, 0, 0.9);

  constructor(scene: Scene, fires: { x: number; y: number; z: number; s: number }[]) {
    this.fires = fires.map((f, i) => ({ ...f, seed: frac(Math.sin(i * 91.7) * 4375.5) }));
    this.flames = new Cloud(scene, this.fires.length * (FLAMES + EMBERS + 1), false, AdditiveBlending, false);
    this.smoke = new Cloud(scene, this.fires.length * SMOKE, true, NormalBlending, true);
    this.ash = new Cloud(scene, ASH, false, NormalBlending, true);
    this.flames.pts.renderOrder = 3;
    this.smoke.pts.renderOrder = 2;
    this.ashPos = new Float32Array(ASH * 3);
    for (let i = 0; i < ASH; i++) this.ashPos.set([(Math.random() - 0.5) * 2, Math.random(), (Math.random() - 0.5) * 2], i * 3);
    for (let i = 0; i < LIGHTS; i++) {
      const l = new PointLight(0xff7a2a, 0, 22, 1.6);
      this.lights.push(l);
      scene.add(l);
    }
  }

  set visible(v: boolean) {
    this.flames.pts.visible = this.smoke.pts.visible = this.ash.pts.visible = v;
    if (!v) for (const l of this.lights) l.intensity = 0;
  }

  update(dt: number, cam: PerspectiveCamera, viewH: number, night: boolean) {
    this.t += dt;
    const t = this.t, c = cam.position;
    const scale = (viewH * 0.5) / Math.tan((cam.fov * Math.PI) / 360);
    const near: { f: Fire; d: number }[] = [];
    for (const f of this.fires) {
      const d = Math.hypot(f.x - c.x, f.z - c.z);
      // Smoke column: puffs rise ~35 m over 11 s, swelling and leaning downwind.
      if (d < 1100) {
        for (let j = 0; j < SMOKE; j++) {
          const a = frac(t / 11 + j / SMOKE + f.seed), h = a * 34 * (0.6 + f.s * 0.5);
          const wob = Math.sin(j * 7.3 + f.seed * 20 + t * 0.4) * (0.6 + a * 2.5);
          const fade = Math.min(1, a * 6) * (1 - a);
          // Sooty black, lit orange from below by the flames (much more so at night).
          const g = night ? 0.02 + a * 0.04 : 0.045 + a * 0.09, glow = Math.max(0, 1 - a / 0.3) * (night ? 0.45 : 0.18);
          this.smoke.push(f.x + this.wind.x * a * 9 + wob, f.y + 1.2 + h, f.z + this.wind.z * a * 9 + wob * 0.6, (1.6 + a * 12) * f.s,
            g + glow, g * 0.95 + glow * 0.35, g * 0.9 + glow * 0.08, fade * 0.85);
        }
      }
      // Far away: just a glow, so the fires dot the land at night.
      if (d > 60) this.flames.push(f.x, f.y + 0.7 * f.s, f.z, (night ? 6 : 3.5) * f.s, 1, 0.42, 0.1, (night ? 0.45 : 0.22) * Math.min(1, (d - 60) / 60));
      if (d > FLAME_R) continue;
      near.push({ f, d });
      for (let j = 0; j < FLAMES; j++) {
        const a = frac(t / (0.7 + f.seed * 0.2) + j / FLAMES + f.seed), k = j * 12.9898 + f.seed * 78.2;
        // Tongues: each flame licks up from somewhere across the base and narrows to the tip.
        const spread = (1 - a * 0.8) * 0.75 * f.s;
        const x = f.x + Math.sin(k) * spread + Math.sin(t * 5 + j) * 0.12 * a, z = f.z + Math.cos(k * 1.3) * spread + Math.cos(t * 4 + j) * 0.12 * a;
        const y = f.y + a * a * 3.2 * f.s + a * 0.4;
        // Yellow at the root, orange, then a dull red tip.
        if (a < 0.3) tmpC.setRGB(1, 0.62 - a * 0.5, 0.18 - a * 0.4);
        else tmpC.setRGB(1 - (a - 0.3) * 0.6, 0.47 - (a - 0.3) * 0.55, 0.06);
        const alpha = Math.sin(Math.min(1, a * 1.1) * Math.PI) * 0.5;
        this.flames.push(x, y, z, f.s * (0.95 * Math.pow(1 - a, 0.8) + 0.15), tmpC.r, Math.max(0.05, tmpC.g), tmpC.b, alpha);
      }
      for (let j = 0; j < EMBERS; j++) {
        const a = frac(t / 3.2 + j / EMBERS + f.seed * 3), k = j * 3.7 + f.seed * 11;
        const x = f.x + Math.sin(k + a * 5) * a * 2, z = f.z + Math.cos(k + a * 4) * a * 2 + this.wind.z * a * 2;
        this.flames.push(x + this.wind.x * a * 2, f.y + a * 9 * f.s, z, 0.14, 1, 0.55, 0.15, (1 - a) * (0.6 + 0.4 * Math.sin(t * 20 + j)));
      }
    }
    // Light from the three nearest fires, flickering.
    near.sort((a, b) => a.d - b.d);
    this.lights.forEach((l, i) => {
      const n = near[i];
      if (!n || n.d > 70) return void (l.intensity = 0);
      const f = n.f;
      l.position.set(f.x, f.y + 1.3 * f.s, f.z);
      l.intensity = (night ? 26 : 12) * f.s * (0.8 + 0.2 * Math.sin(t * 17 + f.seed * 9) * Math.sin(t * 7.3 + i));
    });
    this.flames.commit(scale);
    this.smoke.commit(scale);

    // Ash: grey flakes drifting down in a box that travels with the camera.
    for (let i = 0; i < ASH; i++) {
      const p = this.ashPos;
      p[i * 3 + 1] -= dt * 0.045;
      p[i * 3] += dt * 0.02 * Math.sin(t * 0.7 + i);
      if (p[i * 3 + 1] < 0) p[i * 3 + 1] += 1;
      const wrap = (v: number) => ((((v + 0.5) % 1) + 1) % 1) - 0.5;
      const x = c.x + wrap(p[i * 3] + (-c.x / (ASH_BOX * 2))) * ASH_BOX * 2;
      const z = c.z + wrap(p[i * 3 + 2] + (-c.z / (ASH_BOX * 2))) * ASH_BOX * 2;
      const y = c.y - 12 + p[i * 3 + 1] * 30;
      const ember = i % 23 === 0;
      if (ember) this.ash.push(x, y, z, 0.07, 1, 0.5, 0.15, 0.9);
      else this.ash.push(x, y, z, 0.06, 0.55, 0.53, 0.5, 0.7);
    }
    this.ash.commit(scale);
  }
}
