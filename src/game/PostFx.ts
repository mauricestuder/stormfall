import { PerspectiveCamera, Scene, Vector2, WebGLRenderer } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { INK, InkPass, TOON } from './Style';

/** Colour grade: contrast, saturation, a warm/cool tint, vignette, and a red edge when hurt. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uContrast: { value: 1.08 },
    uSaturation: { value: 1.12 },
    uTint: { value: [1.0, 1.0, 1.0] },
    uVignette: { value: 0.35 },
    uHurt: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uContrast, uSaturation, uVignette, uHurt;
    uniform vec3 uTint;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb * uTint;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);
      col = (col - 0.18) * uContrast + 0.18;
      vec2 d = vUv - 0.5;
      float v = smoothstep(0.85, 0.2, length(d) * (1.0 + uVignette));
      col *= mix(1.0, v, uVignette * 1.6);
      float edge = smoothstep(0.25, 0.75, length(d));
      col = mix(col, vec3(0.75, 0.05, 0.05), edge * uHurt * 0.6);
      gl_FragColor = vec4(max(col, 0.0), c.a);
    }
  `,
};

/**
 * Clamps each pixel before bloom. A light right next to a surface can produce a huge value (or a NaN) in
 * a few pixels, which bloom would spread into a big glowing disc.
 */
const ClampShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
      gl_FragColor = vec4(clamp(col, 0.0, 2.2), c.a);
    }
  `,
};

/** Bloom + grading. The viewmodel is drawn on top afterwards, straight to the screen. */
export class PostFx {
  composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;

  constructor(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera) {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(INK ? new InkPass(scene, camera) : new RenderPass(scene, camera));
    this.composer.addPass(new ShaderPass(ClampShader));
    this.bloom = new UnrealBloomPass(new Vector2(innerWidth, innerHeight), 0.35, 0.5, 0.88);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
  }

  /** Tune the grade for the time of day. */
  setLook(tod: string, wx: string) {
    const u = this.grade.uniforms;
    u.uTint.value = tod === 'sunset' ? [1.06, 0.98, 0.9] : tod === 'night' ? [0.95, 0.99, 1.06] : [1.0, 1.0, 1.0];
    u.uSaturation.value = (wx === 'clear' ? 1.12 : 0.92) * (TOON ? 1.05 : INK ? 1.08 : 1);
    if (INK) u.uContrast.value = TOON ? 1.06 : 1.14;
    if (TOON) u.uVignette.value = 0.15;
    this.bloom.strength = tod === 'night' ? 0.55 : 0.35;
    this.bloom.threshold = tod === 'night' ? 0.7 : 0.88;
  }

  set hurt(v: number) {
    this.grade.uniforms.uHurt.value = v;
  }

  setSize(w: number, h: number, pixelRatio: number) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
  }

  render(dt: number) {
    this.composer.render(dt);
  }
}
