import { BoxGeometry, Color, CylinderGeometry, DoubleSide, Group, Mesh, MeshLambertMaterial, Quaternion, Vector3 } from 'three';

/** Height of the canopy above the pilot's feet. */
export const GLIDER_HEIGHT = 4.1;

const lineGeo = new CylinderGeometry(0.015, 0.015, 1, 4);
const lineMat = new MeshLambertMaterial({ color: 0x2a2a2a });
const stripeMat = new MeshLambertMaterial({ color: 0xffffff, emissive: 0x9a9a9a, side: DoubleSide });
const UP = new Vector3(0, 1, 0);

/** A paraglider: an arched, striped canopy with lines down to the pilot's shoulders. Origin = canopy centre. */
export type GliderPattern = 'stripe' | 'split' | 'tips' | 'center' | 'checker' | 'rainbow';

export function buildGlider(color: number, accent = 0xffffff, pattern: GliderPattern = 'stripe'): Group {
  const g = new Group();
  // Emissive so the underside you look up at stays bright instead of falling into shadow.
  const cloth = (c: number) => new MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0.5, side: DoubleSide });
  const main = cloth(color), second = pattern === 'stripe' && accent === 0xffffff ? stripeMat : cloth(accent);
  const n = 9, span = 5.6, arc = 1.15, R = span / arc;
  const seg = new BoxGeometry(span / n + 0.03, 0.09, 1.6);
  const tip = (i: number) => {
    const a = ((i + 0.5) / n - 0.5) * arc;
    return new Vector3(Math.sin(a) * R, Math.cos(a) * R - R, 0);
  };
  for (let i = 0; i < n; i++) {
    const alt =
      pattern === 'stripe' ? i % 4 === 2
      : pattern === 'split' ? i >= n / 2
      : pattern === 'tips' ? i === 0 || i === n - 1
      : pattern === 'center' ? i === (n - 1) / 2
      : i % 2 === 1;
    const mat = pattern === 'rainbow' ? cloth(new Color().setHSL(i / n, 0.85, 0.55).getHex()) : alt ? second : main;
    const m = new Mesh(seg, mat);
    m.position.copy(tip(i));
    m.rotation.z = -((i + 0.5) / n - 0.5) * arc;
    g.add(m);
  }
  const harness = new Vector3(0, -(GLIDER_HEIGHT - 1.5), 0);
  for (const i of [0, 2, 6, 8]) {
    for (const z of [-0.6, 0.6]) {
      const top = tip(i).setZ(z), bottom = harness.clone().setX(i < n / 2 ? -0.25 : 0.25);
      const dir = bottom.clone().sub(top), len = dir.length();
      const l = new Mesh(lineGeo, lineMat);
      l.scale.y = len;
      l.position.copy(top).addScaledVector(dir, 0.5);
      l.quaternion.copy(new Quaternion().setFromUnitVectors(UP, dir.normalize()));
      g.add(l);
    }
  }
  return g;
}
