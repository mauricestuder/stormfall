import { BoxGeometry, Color, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial, OctahedronGeometry, CylinderGeometry, type BufferGeometry } from 'three';
import type { WeaponId } from '../weapons/Weapon';

/** Locker items beyond outfits and camos: back bling, gliders, showcase gun, emotes, trails, banners. */

export interface BackBling { name: string; desc: string; color: number; accent: number; level?: number }
export const BACKS: BackBling[] = [
  { name: 'Supply Pack', desc: 'The standard-issue backpack.', color: 0x3d4c5a, accent: 0x3d4c5a },
  { name: 'Ronin Katana', desc: 'A sheathed blade slung across your back.', color: 0x6a1a1a, accent: 0xd8dde3 },
  { name: 'Jet Pack', desc: 'Twin fuel tanks with glowing thrusters.', color: 0x8a939e, accent: 0xff8a2a },
  { name: 'Seraph Wings', desc: 'Folded wings with a soft blue edge.', color: 0xf2f5ff, accent: 0x7fd0ff },
  { name: 'Tower Shield', desc: 'A heavy shield with a glowing crest.', color: 0x59616c, accent: 0xffc043 },
  { name: 'Field Radio', desc: 'Old radio set with a blinking antenna.', color: 0x4d5a3a, accent: 0xff3a2a },
  { name: 'Loot Llama', desc: 'A purple llama plush. Brings good loot.', color: 0xa05ad6, accent: 0x5ad6ff },
  { name: 'Corona', desc: 'Level 100. A black disc ringed in white-gold light.', color: 0x0b0b0f, accent: 0xffe9b8, level: 100 },
];

export interface GliderDesign { name: string; desc: string; color: number; accent: number; pattern: 'stripe' | 'split' | 'tips' | 'center' | 'checker' | 'rainbow'; level?: number }
/** Index 0 follows your outfit's glider colour. */
export const GLIDERS: GliderDesign[] = [
  { name: 'Outfit Match', desc: 'Takes the colours of your outfit.', color: 0xffb020, accent: 0xffffff, pattern: 'stripe' },
  { name: 'Sunburst', desc: 'Half gold, half flame.', color: 0xffb020, accent: 0xff4a1a, pattern: 'split' },
  { name: 'Midnight Raven', desc: 'Black canopy with violet wingtips.', color: 0x1f2433, accent: 0x8a6bff, pattern: 'tips' },
  { name: 'Bubblegum', desc: 'Pink and white checks.', color: 0xff6fb5, accent: 0xffffff, pattern: 'checker' },
  { name: 'Jungle Hawk', desc: 'Olive wings with a sand stripe.', color: 0x3d7a3a, accent: 0xe8d27a, pattern: 'center' },
  { name: 'Royal Crest', desc: 'Deep blue with golden tips.', color: 0x2a3f9a, accent: 0xffc043, pattern: 'tips' },
  { name: 'Prism', desc: 'Every colour of the rainbow.', color: 0xff4a4a, accent: 0xffffff, pattern: 'rainbow' },
  { name: 'Eclipse', desc: 'Level 100. A black canopy edged in white gold.', color: 0x0b0b0f, accent: 0xffe9b8, pattern: 'tips', level: 100 },
];

export const SHOWCASE: WeaponId[] = ['ar', 'smg', 'shotgun', 'sniper', 'lmg', 'burst', 'dmr', 'revolver', 'pistol', 'rocket'];

export interface Emote { name: string; desc: string }
export const EMOTES: Emote[] = [
  { name: 'Wave', desc: 'A friendly hello.' },
  { name: 'Groove', desc: 'Bounce to the beat.' },
  { name: 'Floss', desc: 'Swing those arms.' },
  { name: 'Flex', desc: 'Show them who is boss.' },
  { name: 'Salute', desc: 'Ready for duty.' },
  { name: 'Backflip', desc: 'Stick the landing.' },
  { name: 'Tornado', desc: 'Spin until you are dizzy.' },
];

export interface Trail { name: string; desc: string; color: number | null; level?: number }
/** Skydive contrails from your hands. null colour = off; -1 = rainbow; -2 = eclipse shimmer. */
export const TRAILS: Trail[] = [
  { name: 'None', desc: 'No contrail.', color: null },
  { name: 'Stardust', desc: 'Golden sparkles.', color: 0xfff0a0 },
  { name: 'Toxic', desc: 'Green glow.', color: 0x39ff88 },
  { name: 'Inferno', desc: 'A streak of fire.', color: 0xff6a10 },
  { name: 'Frostbite', desc: 'Icy blue.', color: 0x8ad8ff },
  { name: 'Royal', desc: 'Purple haze.', color: 0xb86bff },
  { name: 'Rainbow', desc: 'All the colours.', color: -1 },
  { name: 'Eclipse', desc: 'Level 100. A white-gold ribbon that flickers like a corona.', color: -2, level: 100 },
];

export interface Banner { name: string; icon: string; color: number; level?: number }
export const BANNERS: Banner[] = [
  { name: 'Rookie', icon: '★', color: 0xe8323c },
  { name: 'Spark', icon: '✦', color: 0x4af0ff },
  { name: 'Crown', icon: '♛', color: 0xb86bff },
  { name: 'Diamond', icon: '◆', color: 0x49b8ff },
  { name: 'Summit', icon: '▲', color: 0x39d98a },
  { name: 'Medic', icon: '✚', color: 0xff4a4a },
  { name: 'Moon', icon: '☾', color: 0x8c9bb8 },
  { name: 'Skull', icon: '☠︎', color: 0x2b2f38 },
  { name: 'Eclipse', icon: '◐', color: 0x0b0b0f, level: 100 },
];

/** Colour of a trail right now (rainbow cycles). */
export function trailColor(t: Trail, time: number) {
  if (t.color === null) return null;
  if (t.color >= 0) return t.color;
  if (t.color === -2) return new Color(0xffe9b8).lerp(new Color(0xffffff), 0.5 + 0.5 * Math.sin(time * 9)).getHex();
  return new Color().setHSL((time * 0.35) % 1, 0.9, 0.6).getHex();
}

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
export { hex };

// ---------- back bling models ----------

const lit = new Map<number, MeshLambertMaterial>();
const unlit = new Map<number, MeshBasicMaterial>();
const L = (c: number) => lit.get(c) ?? (lit.set(c, new MeshLambertMaterial({ color: c })), lit.get(c)!);
const U = (c: number) => unlit.get(c) ?? (unlit.set(c, new MeshBasicMaterial({ color: c })), unlit.get(c)!);
const cube = new BoxGeometry(1, 1, 1);

function part(g: Group, geo: BufferGeometry, mat: MeshLambertMaterial | MeshBasicMaterial, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) {
  const m = new Mesh(geo, mat);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  g.add(m);
  return m;
}

/** Model for a back bling, in character space (the character faces -z, so the back is +z). */
export function buildBackBling(i: number): Group | null {
  const b = BACKS[i];
  if (!b || i === 0) return null;
  const g = new Group();
  const box = (mat: MeshLambertMaterial | MeshBasicMaterial, x: number, y: number, z: number, w: number, h: number, d: number, rz = 0, rx = 0, ry = 0) => part(g, cube, mat, x, y, z, w, h, d, rx, ry, rz);
  switch (i) {
    case 1: {
      // Katana: sheath across the back, the hilt over the right shoulder.
      const k = new Group();
      k.position.set(0, 1.18, 0.4);
      k.rotation.z = -0.75;
      g.add(k);
      const kb = (mat: MeshLambertMaterial | MeshBasicMaterial, y: number, w: number, h: number, d: number) => part(k, cube, mat, 0, y, 0, w, h, d);
      kb(L(b.color), -0.12, 0.07, 0.9, 0.05);
      kb(L(0xc9a246), -0.52, 0.08, 0.05, 0.06);
      kb(L(0xc9a246), 0.35, 0.16, 0.04, 0.09);
      kb(L(0x1c1410), 0.52, 0.055, 0.3, 0.055);
      kb(L(0xc9a246), 0.68, 0.07, 0.04, 0.07);
      break;
    }
    case 2: {
      const cyl = new CylinderGeometry(1, 1, 1, 12);
      for (const s of [-1, 1]) {
        part(g, cyl, L(b.color), s * 0.14, 1.17, 0.46, 0.1, 0.55, 0.1);
        part(g, cyl, L(0xd23a2a), s * 0.14, 1.47, 0.46, 0.08, 0.06, 0.08);
        part(g, cyl, L(0x3a3f47), s * 0.14, 0.86, 0.46, 0.07, 0.08, 0.07);
        part(g, cyl, U(b.accent), s * 0.14, 0.8, 0.46, 0.055, 0.05, 0.055);
      }
      box(L(0x3a3f47), 0, 1.2, 0.4, 0.2, 0.3, 0.06);
      break;
    }
    case 3: {
      for (const s of [-1, 1]) {
        const w = new Group();
        w.position.set(s * 0.1, 1.38, 0.4);
        w.rotation.set(0.25, s * -0.35, s * -0.5);
        g.add(w);
        for (let f = 0; f < 4; f++) {
          const len = 0.7 - f * 0.12;
          part(w, cube, L(b.color), s * (0.08 + f * 0.1), -0.05 - len / 2 + 0.35, 0.02 * f, 0.1, len, 0.03, 0, 0, s * f * 0.08);
        }
        part(w, cube, U(b.accent), s * 0.05, 0.3, -0.01, 0.06, 0.12, 0.035);
        part(w, cube, U(b.accent), s * 0.37, -0.02, 0.07, 0.035, 0.25, 0.035, 0, 0, s * 0.24);
      }
      break;
    }
    case 4: {
      box(L(b.color), 0, 1.15, 0.42, 0.56, 0.62, 0.05);
      box(L(0x3a3f47), 0, 1.47, 0.43, 0.6, 0.05, 0.07);
      box(L(0x3a3f47), 0, 0.83, 0.43, 0.44, 0.05, 0.07);
      box(L(0x3a3f47), 0.29, 1.15, 0.43, 0.05, 0.6, 0.07);
      box(L(0x3a3f47), -0.29, 1.15, 0.43, 0.05, 0.6, 0.07);
      box(U(b.accent), 0, 1.16, 0.46, 0.2, 0.2, 0.03, Math.PI / 4);
      box(L(0x2a2f38), 0, 1.16, 0.455, 0.3, 0.3, 0.02, Math.PI / 4);
      break;
    }
    case 5: {
      box(L(b.color), 0, 1.12, 0.44, 0.34, 0.42, 0.2);
      box(L(0x2a2f24), 0, 1.2, 0.55, 0.26, 0.12, 0.02);
      for (const x of [-0.08, 0.02, 0.1]) box(L(0xd8d0b0), x, 1.2, 0.565, 0.035, 0.035, 0.02);
      box(L(0x1c1f22), 0.12, 1.65, 0.48, 0.02, 0.75, 0.02);
      part(g, new OctahedronGeometry(1), U(b.accent), 0.12, 2.04, 0.48, 0.035, 0.035, 0.035);
      break;
    }
    case 6: {
      const body = L(b.color), spot = L(b.accent), dark = L(0x241a30);
      box(body, 0, 1.08, 0.48, 0.3, 0.22, 0.2);
      box(spot, 0.08, 1.12, 0.585, 0.08, 0.08, 0.02);
      box(L(0xff6fb5), -0.08, 1.05, 0.585, 0.07, 0.07, 0.02);
      box(body, 0.1, 1.3, 0.48, 0.09, 0.28, 0.09);
      box(body, 0.13, 1.47, 0.47, 0.14, 0.11, 0.18);
      box(dark, 0.13, 1.49, 0.56, 0.1, 0.03, 0.01);
      box(body, 0.1, 1.56, 0.44, 0.03, 0.09, 0.03);
      box(body, 0.16, 1.56, 0.44, 0.03, 0.09, 0.03);
      for (const [x, z] of [[-0.1, 0.42], [0.1, 0.42], [-0.1, 0.55], [0.1, 0.55]]) box(body, x, 0.93, z, 0.06, 0.12, 0.06);
      break;
    }
    case 7: {
      // Eclipse corona: a black disc floating off the back, ringed in light.
      part(g, new CylinderGeometry(1, 1, 1, 32), L(b.color), 0, 1.28, 0.5, 0.27, 0.025, 0.27, Math.PI / 2);
      for (let k = 0; k < 32; k++) {
        const a = (k / 32) * Math.PI * 2;
        box(U(b.accent), Math.cos(a) * 0.3, 1.28 + Math.sin(a) * 0.3, 0.5, 0.045, 0.045, 0.02, a);
      }
      break;
    }
  }
  return g;
}

export const swatch = {
  back: (b: BackBling) => `linear-gradient(135deg, ${hex(b.color)} 0 60%, ${hex(b.accent)} 60%)`,
  glider: (d: GliderDesign, outfitColor: number) =>
    d.pattern === 'rainbow'
      ? 'linear-gradient(90deg,#ff4a4a,#ffb020,#ffe14a,#39d98a,#49b8ff,#b86bff)'
      : `linear-gradient(90deg, ${hex(d.pattern === 'stripe' && d === GLIDERS[0] ? outfitColor : d.color)} 0 50%, ${hex(d.accent)} 50% 62%, ${hex(d.pattern === 'stripe' && d === GLIDERS[0] ? outfitColor : d.color)} 62%)`,
  trail: (t: Trail) =>
    t.color === null ? 'repeating-linear-gradient(135deg,#2a3040 0 6px,#353c4e 6px 12px)' : t.color === -2 ? 'radial-gradient(circle at 50% 50%, #0b0b0f 0 30%, #ffe9b8 34%, #fff 38%, #0b0b0f 46%)' : t.color < 0 ? 'linear-gradient(90deg,#ff4a4a,#ffb020,#39d98a,#49b8ff,#b86bff)' : `radial-gradient(circle at 30% 50%, #fff 0 8%, ${hex(t.color)} 30%, transparent 75%), #141a26`,
};
