import {
  BufferAttribute, BufferGeometry, Color, DirectionalLight, Fog, HemisphereLight, LineBasicMaterial, LineSegments, Object3D,
  PerspectiveCamera, Points, PointsMaterial, Scene, SpotLight, Vector3,
} from 'three';
import type { TimeOfDay, Weather } from '../core/Settings';
import type { Sfx } from './Sfx';
import { THEME } from '../theme';

export type Tod = Exclude<TimeOfDay, 'random'>;
export type Wx = Exclude<Weather, 'random'>;

interface Look {
  sky: number;
  fog: number;
  hemiSky: number;
  hemiGround: number;
  hemi: number;
  sun: number;
  sunColor: number;
  /** Sun offset from the player (direction the light comes from). */
  sunDir: [number, number, number];
  exposure: number;
}

const LOOKS: Record<Tod, Look> = {
  day: { sky: 0x9fd4ff, fog: 0x9fd4ff, hemiSky: 0xdff1ff, hemiGround: 0x5a7a3a, hemi: 1.4, sun: 2.2, sunColor: 0xfff1d6, sunDir: [60, 120, 40], exposure: 1.5 },
  sunset: { sky: 0xf2a86b, fog: 0xe8a278, hemiSky: 0xffc9a0, hemiGround: 0x5a4a3a, hemi: 1.0, sun: 2.4, sunColor: 0xffa35a, sunDir: [150, 45, 60], exposure: 1.45 },
  night: { sky: 0x121c36, fog: 0x2a3a5e, hemiSky: 0x8ea4e0, hemiGround: 0x3e4a62, hemi: 1.75, sun: 1.25, sunColor: 0xb4c6ff, sunDir: [-50, 110, -70], exposure: 2.0 },
};

const RAIN_N = 1400, RAIN_BOX = 38;

/** Time of day, weather (rain with lightning, fog), stars and the player's flashlight. */
export class Environment {
  tod: Tod = 'day';
  wx: Wx = 'clear';
  /** Multiplier on fog distance (rain and fog close it in). */
  fogMul = 1;
  /** Multiplier on how far bots can spot things. */
  visionMul = 1;
  exposure = 1.05;
  flashlightOn = false;
  private stars: Points;
  private rain: LineSegments;
  private rainPos: Float32Array;
  private flashlight: SpotLight;
  private lightning = 0;
  private boltTimer = 8;
  private thunderAt = -1;
  private base!: Look;

  constructor(private scene: Scene, camera: PerspectiveCamera, private sun: DirectionalLight, private hemi: HemisphereLight, private fog: Fog, private sfx: Sfx) {
    // Stars: a big dome of points that follows the camera.
    const sp = new Float32Array(1800 * 3);
    for (let i = 0; i < 1800; i++) {
      const u = Math.random(), v = Math.random() * 0.9 + 0.1;
      const a = u * Math.PI * 2, r = Math.sqrt(1 - v * v);
      sp.set([Math.cos(a) * r * 2000, v * 2000, Math.sin(a) * r * 2000], i * 3);
    }
    const sg = new BufferGeometry();
    sg.setAttribute('position', new BufferAttribute(sp, 3));
    this.stars = new Points(sg, new PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.9 }));
    this.stars.frustumCulled = false;
    this.stars.visible = false;
    scene.add(this.stars);

    // Rain: short streaks in a box around the camera.
    this.rainPos = new Float32Array(RAIN_N * 6);
    for (let i = 0; i < RAIN_N; i++) this.resetDrop(i, new Vector3(), true);
    const rg = new BufferGeometry();
    rg.setAttribute('position', new BufferAttribute(this.rainPos, 3));
    this.rain = new LineSegments(rg, new LineBasicMaterial({ color: 0xb8c8dc, transparent: true, opacity: 0.45, fog: false }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);

    // A narrow beam with a soft edge that reaches down range rather than floodlighting everything.
    this.flashlight = new SpotLight(0xfff4dc, 0, 95, 0.42, 0.55, 1.2);
    this.flashlight.position.set(0.25, -0.2, 0);
    const target = new Object3D();
    target.position.set(0, 0, -10);
    camera.add(this.flashlight, target);
    this.flashlight.target = target;
  }

  /** Resolve 'random' and apply the look. */
  setup(tod: TimeOfDay, wx: Weather) {
    const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
    this.tod = tod === 'random' ? pick<Tod>(['day', 'day', 'sunset', 'night']) : tod;
    this.wx = wx === 'random' ? pick<Wx>(['clear', 'clear', 'clear', 'rain', 'fog']) : wx;
    const L = (this.base = { ...LOOKS[this.tod] });
    const sky = new Color(L.sky), fogC = new Color(L.fog);
    // Military island: flat, overcast light. The old park: a warm, hazy day.
    if (THEME === 'military' && this.tod !== 'night') {
      sky.lerp(new Color(0xa9b4b8), 0.45);
      fogC.lerp(new Color(0xa9b4b8), 0.45);
      L.sun *= 0.85;
    } else if (THEME === 'western' && this.tod !== 'night') {
      sky.lerp(new Color(0xf0cc98), 0.3);
      fogC.lerp(new Color(0xe8c898), 0.35);
      L.hemiGround = 0x8a6a45;
    } else if (THEME === 'park' && this.tod === 'day') {
      sky.lerp(new Color(0xf0d8c0), 0.18);
      fogC.lerp(new Color(0xf0d8c0), 0.18);
    }
    if (this.wx === 'rain') {
      sky.lerp(new Color(this.tod === 'night' ? 0x141c2c : 0x6c7684), 0.7);
      fogC.copy(sky);
      L.sun *= this.tod === 'night' ? 0.7 : 0.35;
      L.hemi *= this.tod === 'night' ? 1 : 0.8;
    } else if (this.wx === 'fog') {
      const grey = new Color(this.tod === 'night' ? 0x262e40 : 0xc4ccd4);
      sky.lerp(grey, 0.75);
      fogC.copy(sky);
      L.sun *= 0.6;
    }
    this.scene.background = sky;
    this.fog.color.copy(fogC);
    this.hemi.color.setHex(L.hemiSky);
    this.hemi.groundColor.setHex(L.hemiGround);
    this.hemi.intensity = L.hemi;
    this.sun.color.setHex(L.sunColor);
    this.sun.intensity = L.sun;
    this.exposure = L.exposure;
    this.stars.visible = this.tod === 'night' && this.wx === 'clear';
    this.rain.visible = this.wx === 'rain';
    this.fogMul = this.wx === 'fog' ? 0.32 : this.wx === 'rain' ? 0.6 : this.tod === 'night' ? 0.8 : 1;
    this.visionMul = (this.tod === 'night' ? 0.8 : 1) * (this.wx === 'fog' ? 0.55 : this.wx === 'rain' ? 0.8 : 1);
    this.sfx.setRain(this.wx === 'rain' ? 1 : 0);
  }

  /** Extra fill light (the arena's floodlights): more sky light, a little less contrast from the sun. */
  boostAmbient(k: number) {
    this.base.hemi *= k;
    this.hemi.intensity = this.base.hemi;
    this.exposure *= 1 + (k - 1) * 0.25;
  }

  get sunOffset() {
    return this.base.sunDir;
  }

  get isNight() {
    return this.tod === 'night';
  }

  toggleFlashlight() {
    this.flashlightOn = !this.flashlightOn;
    this.flashlight.intensity = this.flashlightOn ? 42 : 0;
  }

  /** Distance to what the flashlight points at: close up it turns down so the spot doesn't glare. */
  flashlightRange(dist: number) {
    if (!this.flashlightOn) return;
    const k = Math.min(1, Math.max(0.1, Math.pow(dist / 14, 1.4)));
    this.flashlight.intensity += (42 * k - this.flashlight.intensity) * 0.25;
  }

  private resetDrop(i: number, around: Vector3, anyHeight: boolean) {
    const x = around.x + (Math.random() - 0.5) * RAIN_BOX * 2, z = around.z + (Math.random() - 0.5) * RAIN_BOX * 2;
    const y = around.y + (anyHeight ? (Math.random() - 0.4) * 40 : 20 + Math.random() * 8);
    this.rainPos.set([x, y, z, x + 0.05, y + 0.9, z + 0.05], i * 6);
  }

  update(dt: number, cam: Vector3) {
    this.stars.position.copy(cam);
    if (this.wx === 'rain') {
      const p = this.rainPos, fall = 34 * dt;
      for (let i = 0; i < RAIN_N; i++) {
        const k = i * 6;
        p[k + 1] -= fall;
        p[k + 4] -= fall;
        if (p[k + 1] < cam.y - 14 || Math.abs(p[k] - cam.x) > RAIN_BOX || Math.abs(p[k + 2] - cam.z) > RAIN_BOX) this.resetDrop(i, cam, false);
      }
      (this.rain.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
      // Lightning: a bright flash, thunder a moment later.
      this.boltTimer -= dt;
      if (this.boltTimer <= 0) {
        this.boltTimer = 9 + Math.random() * 18;
        this.lightning = 1;
        this.thunderAt = 0.4 + Math.random() * 1.6;
      }
      if (this.thunderAt > 0) {
        this.thunderAt -= dt;
        if (this.thunderAt <= 0) this.sfx.thunder();
      }
    }
    if (this.lightning > 0) {
      this.lightning = Math.max(0, this.lightning - dt * 3);
      const flick = this.lightning > 0.5 ? 1 : this.lightning * 2 * (Math.random() < 0.5 ? 1 : 0.3);
      this.hemi.intensity = this.base.hemi + flick * 2.5;
    }
  }
}
