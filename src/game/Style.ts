import {
  BackSide, Box3, Color, Group, IcosahedronGeometry, MeshBasicMaterial, DepthTexture, HalfFloatType, Material, Mesh, MeshLambertMaterial, MeshPhongMaterial, MeshStandardMaterial,
  Object3D, OrthographicCamera, PerspectiveCamera, PlaneGeometry, Scene, ShaderChunk, ShaderMaterial, SphereGeometry, Vector2,
  Vector3, WebGLRenderTarget, WebGLRenderer,
} from 'three';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';

declare const __STYLE__: string;

/**
 * Art style, fixed at build time (`STYLE=ink npm run share`). Both are tests.
 * 'ink' = cel outlines + semi-realistic shading; 'toon' = full cartoon (thick lines, flat bands, no grain, clouds).
 */
export const TOON = __STYLE__ === 'toon';
export const INK = __STYLE__ === 'ink' || TOON;

// ---------------------------------------------------------------- materials

const PARS = ['lights_physical_pars_fragment', 'lights_lambert_pars_fragment', 'lights_phong_pars_fragment'] as const;
const DOTNL = 'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );';
// Two soft bands (cel) blended with a bit of the real falloff so round things still read as round.
const BANDED = TOON
  ? `float dotNLr = dot( geometryNormal, directLight.direction );
	float dotNL = smoothstep( 0.0, 0.025, dotNLr ) * 0.72 + smoothstep( 0.5, 0.52, dotNLr ) * 0.28;`
  : `float dotNLr = dot( geometryNormal, directLight.direction );
	float dotNL = mix( smoothstep( 0.0, 0.07, dotNLr ) * 0.66 + smoothstep( 0.38, 0.46, dotNLr ) * 0.34, saturate( dotNLr ), 0.3 );`;

const NOISE = /* glsl */ `
varying vec3 vInkW;
float inkHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float inkNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(inkHash(i), inkHash(i + vec3(1,0,0)), f.x), mix(inkHash(i + vec3(0,1,0)), inkHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(inkHash(i + vec3(0,0,1)), inkHash(i + vec3(1,0,1)), f.x), mix(inkHash(i + vec3(0,1,1)), inkHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
`;

const patched = new WeakSet<Material>();

function patch(m: Material) {
  if (patched.has(m)) return;
  patched.add(m);
  if (!(m instanceof MeshStandardMaterial || m instanceof MeshLambertMaterial || m instanceof MeshPhongMaterial)) return;
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = (s, r) => {
    prev.call(m, s, r);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vInkW;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 inkW = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          inkW = instanceMatrix * inkW;
        #endif
        vInkW = (modelMatrix * inkW).xyz;`);
    let f = s.fragmentShader.replace('#include <common>', '#include <common>\n' + NOISE);
    for (const p of PARS) if (f.includes(`#include <${p}>`)) f = f.replace(`#include <${p}>`, ShaderChunk[p].split(DOTNL).join(BANDED));
    f = f
      // Weathering: fine grain + big soft blotches, so flat boxes read as wood/stone/plaster instead of plastic.
      .replace('#include <color_fragment>', TOON ? `#include <color_fragment>
        float inkG = 0.5;
        diffuseColor.rgb = max(mix(vec3(dot(diffuseColor.rgb, vec3(0.3333))), diffuseColor.rgb, 1.12), 0.0);` : `#include <color_fragment>
        float inkG = inkNoise(vInkW * 3.1) * 0.55 + inkNoise(vInkW * 0.7) * 0.3 + inkNoise(vInkW * 0.09) * 0.15;
        diffuseColor.rgb *= 0.84 + inkG * 0.3;`)
      // Rim light for the cel look (a hard band in cartoon mode).
      .replace('#include <opaque_fragment>', (TOON
        ? `outgoingLight += diffuseColor.rgb * smoothstep(0.62, 0.66, 1.0 - saturate(dot(normal, normalize(vViewPosition)))) * 0.3;`
        : `outgoingLight += diffuseColor.rgb * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 4.0) * 0.22;`) + '\n#include <opaque_fragment>');
    if (f.includes('roughnessFactor')) f = f.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n roughnessFactor = clamp(roughnessFactor * (0.8 + inkG * 0.4), ${TOON ? '0.75' : '0.04'}, 1.0);`);
    s.fragmentShader = f;
  };
  m.customProgramCacheKey = () => prevKey.call(m) + '|ink';
  m.needsUpdate = true;
}

/** Gives every lit material in the tree the ink look (idempotent, cheap to call repeatedly). */
export function stylize(root: Object3D) {
  root.traverse((o) => {
    const m = (o as Mesh).material;
    if (!m) return;
    if (Array.isArray(m)) m.forEach(patch);
    else patch(m);
  });
}

// ---------------------------------------------------------------- sky

/** A gradient dome with a sun glow, tinted from the flat background/fog colours the environment sets. */
export class InkSky {
  mesh: Mesh;
  private mat: ShaderMaterial;
  constructor(scene: Scene) {
    this.mat = new ShaderMaterial({
      uniforms: { uSky: { value: new Color() }, uFog: { value: new Color() }, uSun: { value: new Vector3(0, 1, 0) }, uSunCol: { value: new Color() } },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w; }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSky, uFog, uSun, uSunCol;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          float s = max(dot(d, normalize(uSun)), 0.0);
          #ifdef TOON
            vec3 top = uSky * vec3(0.5, 0.72, 1.05);
            vec3 col = mix(uFog * 1.05, top, smoothstep(0.02, 0.4, h));
            col = mix(col, uFog * 0.8, smoothstep(0.0, -0.2, h));
            col = mix(col, vec3(1.0, 0.97, 0.8) * 2.2, smoothstep(0.9975, 0.998, s));
            col = mix(col, col + uSunCol * 0.25, smoothstep(0.985, 0.986, s));
          #else
            vec3 top = uSky * vec3(0.62, 0.74, 0.95);
            vec3 col = mix(uFog, top, smoothstep(0.0, 0.55, h));
            col = mix(col, uFog * 0.8, smoothstep(0.0, -0.2, h));
            col += uSunCol * (pow(s, 8.0) * 0.25 + pow(s, 90.0) * 0.6 + smoothstep(0.9993, 0.9996, s) * 2.0);
          #endif
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: BackSide, depthWrite: false, fog: false,
      defines: TOON ? { TOON: '' } : {},
    });
    this.mesh = new Mesh(new SphereGeometry(2500, 32, 16), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    scene.add(this.mesh);
    if (TOON) scene.add(makeClouds());
  }
  update(camera: PerspectiveCamera, background: unknown, fog: Color, sunDir: Vector3, sunCol: Color) {
    this.mesh.position.copy(camera.position);
    const u = this.mat.uniforms;
    if (background instanceof Color) u.uSky.value.copy(background);
    u.uFog.value.copy(fog);
    u.uSun.value.copy(sunDir);
    u.uSunCol.value.copy(sunCol);
  }
}

/** Puffy cartoon clouds: clusters of low-poly balls in a ring high over the island. */
function makeClouds() {
  const g = new Group();
  const geo = new IcosahedronGeometry(1, 1);
  const mat = new MeshLambertMaterial({ color: 0xffffff, emissive: 0x8a96b0, fog: false, flatShading: false });
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2, r = 450 + rnd() * 900;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r, cy = 200 + rnd() * 140, size = 16 + rnd() * 22;
    const n = 4 + Math.floor(rnd() * 4);
    for (let j = 0; j < n; j++) {
      const m = new Mesh(geo, mat);
      const s = size * (0.6 + rnd() * 0.6) * (j === 0 ? 1.3 : 1);
      m.scale.set(s, s * 0.8, s);
      m.position.set(cx + (j - n / 2) * size * 0.75 + rnd() * 6, cy + rnd() * size * 0.4, cz + (rnd() - 0.5) * size);
      g.add(m);
    }
  }
  return g;
}

// ---------------------------------------------------------------- viewmodel outlines

const hullMat = new MeshBasicMaterial({ color: 0x0a0808, side: BackSide });
const hulled = new WeakSet<Object3D>();
const tmpBox = new Box3(), tmpWs = new Vector3();

/** Cartoon outlines for the first-person hands and gun: a slightly bigger black back-face copy of each part. */
export function outlineHulls(root: Object3D, t = 0.0035) {
  root.updateMatrixWorld(true);
  const add: [Mesh, Mesh][] = [];
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || hulled.has(m) || m.material === hullMat) return;
    hulled.add(m);
    const mat = m.material as Material;
    if (Array.isArray(mat) || mat.transparent || mat instanceof MeshBasicMaterial || !m.geometry) return;
    m.geometry.computeBoundingBox();
    tmpBox.copy(m.geometry.boundingBox!);
    const sx = tmpBox.max.x - tmpBox.min.x, sy = tmpBox.max.y - tmpBox.min.y, sz = tmpBox.max.z - tmpBox.min.z;
    const ws = m.getWorldScale(tmpWs);
    if (Math.max(sx * ws.x, sy * ws.y, sz * ws.z) > 3) return;
    const h = new Mesh(m.geometry, hullMat);
    // Thickness in the viewmodel's world units, whatever the part's own scale.
    const s = (v: number, w: number) => (v + (2 * t) / Math.max(Math.abs(w), 1e-4)) / Math.max(v, 1e-4);
    h.scale.set(s(sx, ws.x), s(sy, ws.y), s(sz, ws.z));
    const cx = (tmpBox.max.x + tmpBox.min.x) / 2, cy = (tmpBox.max.y + tmpBox.min.y) / 2, cz = (tmpBox.max.z + tmpBox.min.z) / 2;
    h.position.set(cx - cx * h.scale.x, cy - cy * h.scale.y, cz - cz * h.scale.z);
    h.renderOrder = m.renderOrder;
    add.push([m, h]);
  });
  for (const [m, h] of add) m.add(h);
}

// ---------------------------------------------------------------- outlines + contact shadows

const InkShader = {
  uniforms: {
    tColor: { value: null }, tDepth: { value: null },
    uNear: { value: 0.05 }, uFar: { value: 3000 }, uRes: { value: new Vector2(1, 1) }, uProj: { value: 1 }, uProjX: { value: 1 }, uPx: { value: 1 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  defines: TOON ? { TOON: '' } : {},
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tColor, tDepth;
    uniform float uNear, uFar, uProj, uProjX, uPx;
    uniform vec2 uRes;
    varying vec2 vUv;
    float lin(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar); }
    vec3 vpos(vec2 uv) { float z = lin(uv); return vec3((uv * 2.0 - 1.0) * z / vec2(uProjX, uProj), -z); }
    void main() {
      vec4 c = texture2D(tColor, vUv);
      float z = lin(vUv);
      if (z > 2000.0) { gl_FragColor = c; return; }
      vec2 px = uPx / uRes;
      // 3x3 view-space positions; a normal per 2x2 quad. Creases = the quads disagree, silhouettes = big depth jumps.
      vec3 p00 = vpos(vUv - px), p10 = vpos(vUv + vec2(0.0, -px.y)), p20 = vpos(vUv + vec2(px.x, -px.y));
      vec3 p01 = vpos(vUv + vec2(-px.x, 0.0)), p11 = vec3((vUv * 2.0 - 1.0) * z / vec2(uProjX, uProj), -z), p21 = vpos(vUv + vec2(px.x, 0.0));
      vec3 p02 = vpos(vUv + vec2(-px.x, px.y)), p12 = vpos(vUv + vec2(0.0, px.y)), p22 = vpos(vUv + px);
      vec3 nA = normalize(cross(p10 - p00, p01 - p00)), nB = normalize(cross(p20 - p10, p11 - p10));
      vec3 nC = normalize(cross(p11 - p01, p02 - p01)), nD = normalize(cross(p21 - p11, p12 - p11));
      float crease = 1.0 - min(min(dot(nA, nD), dot(nB, nC)), min(dot(nA, nB), dot(nC, nD)));
      // Inverse depth changes linearly across any flat face (even a floor seen at a grazing angle), so its second
      // difference is ~0 there and only jumps at real depth steps.
      float iz = 1.0 / z;
      float sil = max(abs(1.0 / -p01.z + 1.0 / -p21.z - 2.0 * iz), abs(1.0 / -p10.z + 1.0 / -p12.z - 2.0 * iz)) * z;
      #ifdef TOON
        float edge = max(smoothstep(0.05, 0.15, crease), smoothstep(0.06, 0.14, sil));
        edge *= 1.0 - smoothstep(180.0, 420.0, z);
      #else
        float edge = max(smoothstep(0.08, 0.22, crease), smoothstep(0.08, 0.18, sil));
        edge *= 1.0 - smoothstep(90.0, 260.0, z);
      #endif
      // Contact shadows: darken where nearby geometry sits in front of this pixel (corners, under ledges).
      float r = clamp(0.5 * uRes.y * uProj * 0.45 / z, 2.0, 22.0);
      float occ = 0.0;
      for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.785398 + 0.39;
        vec2 o = vec2(cos(a), sin(a)) * r * (0.55 + 0.45 * float(i % 2)) / uRes;
        float dz = z - lin(vUv + o);
        occ += smoothstep(0.03, 0.25, dz) * (1.0 - smoothstep(0.5, 1.2, dz));
      }
      occ = occ / 8.0 * (1.0 - smoothstep(60.0, 160.0, z));
      #ifdef TOON
        vec3 col = c.rgb;
        col = mix(col, vec3(0.04, 0.03, 0.05), edge);
      #else
        vec3 col = c.rgb * (1.0 - occ * 0.4);
        vec3 ink = col * vec3(0.16, 0.12, 0.1);
        col = mix(col, ink, edge * 0.92);
      #endif
      gl_FragColor = vec4(col, c.a);
    }`,
};

/** Replaces RenderPass: draws the scene into its own target with a depth texture, then inks it into the chain. */
export class InkPass extends Pass {
  private rt: WebGLRenderTarget;
  private mat: ShaderMaterial;
  private quad: Mesh;
  private cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  constructor(private scene: Scene, private camera: PerspectiveCamera) {
    super();
    this.needsSwap = false;
    this.rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthTexture: new DepthTexture(1, 1) });
    this.mat = new ShaderMaterial({ ...InkShader, uniforms: { ...InkShader.uniforms, uRes: { value: new Vector2(1, 1) } }, depthTest: false, depthWrite: false });
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.mat);
  }
  setSize(w: number, h: number) {
    this.rt.setSize(w, h);
    this.mat.uniforms.uRes.value.set(w, h);
    this.mat.uniforms.uPx.value = Math.max(1, Math.round(h / (TOON ? 380 : 650)));
  }
  render(renderer: WebGLRenderer, _write: WebGLRenderTarget, read: WebGLRenderTarget) {
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    const u = this.mat.uniforms;
    u.tColor.value = this.rt.texture;
    u.tDepth.value = this.rt.depthTexture;
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    u.uProj.value = this.camera.projectionMatrix.elements[5];
    u.uProjX.value = this.camera.projectionMatrix.elements[0];
    renderer.setRenderTarget(this.renderToScreen ? null : read);
    renderer.render(this.quad, this.cam);
  }
  dispose() {
    this.rt.dispose();
    this.mat.dispose();
  }
}
