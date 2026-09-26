import { Box3, BoxGeometry, Color, DirectionalLight, Group, HemisphereLight, Mesh, MeshLambertMaterial, PerspectiveCamera, Scene, Vector3, WebGLRenderer, type Object3D } from 'three';
import { Character } from '../bots/Character';
import { BACKS, buildBackBling, GLIDERS } from '../game/Cosmetics';
import { SKINS } from '../game/Skins';
import { buildGunModel, makeWeapon, RARITIES, type WeaponId } from '../weapons/Weapon';
import { buildGlider } from '../world/Glider';

/**
 * Little 3D renders of locker items (outfits, back bling, gliders, guns and wraps) for the tiles,
 * drawn once with a tiny offscreen renderer and cached as images.
 */
const SIZE = 160;
const cache = new Map<string, string>();
let renderer: WebGLRenderer | null = null;
const scene = new Scene();
const cam = new PerspectiveCamera(28, 1, 0.01, 100);
scene.add(new HemisphereLight(0xffffff, 0x4a3a3c, 2.2));
const key = new DirectionalLight(0xffffff, 2.4);
key.position.set(-2, 3, 4);
const rim = new DirectionalLight(0xff6060, 1.6);
rim.position.set(3, 2, -3);
scene.add(key, rim);

function shoot(id: string, make: () => Object3D, yaw: number, pitch = 0.12, fill = 1, aimY = 0.5) {
  const hit = cache.get(id);
  if (hit) return hit;
  if (!renderer) {
    renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(SIZE, SIZE, false);
  }
  const obj = make();
  scene.add(obj);
  obj.updateMatrixWorld(true);
  const box = new Box3().setFromObject(obj), c = box.getCenter(new Vector3()), s = box.getSize(new Vector3());
  c.y = box.min.y + s.y * aimY;
  const r = Math.max(s.x, s.y, s.z) * 0.58 * fill;
  const d = r / Math.tan((cam.fov * Math.PI) / 360);
  cam.position.set(c.x + Math.sin(yaw) * Math.cos(pitch) * d, c.y + Math.sin(pitch) * d, c.z + Math.cos(yaw) * Math.cos(pitch) * d);
  cam.lookAt(c);
  renderer.render(scene, cam);
  const url = renderer.domElement.toDataURL('image/png');
  scene.remove(obj);
  cache.set(id, url);
  return url;
}

const backdrop = 'radial-gradient(circle at 50% 60%, #43272c, #151012 75%)';
const css = (url: string) => `url('${url}') center / contain no-repeat, ${backdrop}`;

export const thumbs = {
  outfit: (i: number) => {
    const s = SKINS[i];
    return css(shoot(`o${i}`, () => {
      const c = new Character(new Color(s.suit), new Color(s.trim), undefined, s);
      c.setGun(makeWeapon('ar', RARITIES[3]));
      return c.root;
    }, Math.PI - 0.5, 0.08, 0.72, 0.64));
  },
  back: (i: number) => css(shoot(`b${i}`, () => {
    const g = buildBackBling(i);
    if (g) return g;
    // The standard pack.
    const p = new Group(), m = new MeshLambertMaterial({ color: BACKS[0].color });
    const add = (w: number, h: number, dd: number, y: number, z: number) => {
      const b = new Mesh(new BoxGeometry(w, h, dd), m);
      b.position.set(0, y, z);
      p.add(b);
    };
    add(0.45, 0.45, 0.2, 1.15, 0.26);
    add(0.36, 0.14, 0.1, 1.02, 0.4);
    return p;
  }, 0.7, 0.2)),
  glider: (i: number, outfitGlider: number) => {
    const d = GLIDERS[i];
    return css(shoot(`g${i}:${i === 0 ? outfitGlider : ''}`, () => (i === 0 ? buildGlider(outfitGlider) : buildGlider(d.color, d.accent, d.pattern)), 0.25, -0.35));
  },
  gun: (id: WeaponId, body: number | null) => css(shoot(`w${id}:${body}`, () => {
    const w = makeWeapon(id, RARITIES[3]);
    w.att = { scope: false, extmag: false, grip: false, muzzle: false };
    if (body !== null) w.def = { ...w.def, bodyColor: body };
    return buildGunModel(w);
  }, Math.PI / 2, 0.15, 0.8)),
};
