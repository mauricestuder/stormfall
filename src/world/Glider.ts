import { BufferAttribute, type BufferGeometry, Color, CylinderGeometry, DoubleSide, Group, Mesh, MeshLambertMaterial, Quaternion, SphereGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Height of the canopy above the pilot's feet. */
export const GLIDER_HEIGHT = 4.1;

const UP = new Vector3(0, 1, 0);

/**
 * A round paratrooper's parachute (like the toy army men's): a dome of coloured panels with lines
 * down to the pilot's shoulders. Reads as a parachute from any angle, even far below you. Origin =
 * canopy centre. The patterns paint the panels (gores) and rings of the dome.
 */
export type GliderPattern = 'stripe' | 'split' | 'tips' | 'center' | 'checker' | 'rainbow';

/** Cloth: lit, but half self-lit, so the underside you look up at never goes black. */
const clothMat = new MeshLambertMaterial({ vertexColors: true, side: DoubleSide });
clothMat.onBeforeCompile = (sh) => {
  sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * 0.45;');
};
const lineMat = new MeshLambertMaterial({ color: 0x2a2a2a });

const GORES = 12, RINGS = 3, R = 3.0, THETA = 1.15, SQUASH = 0.55, DROP = 1.2;
const cache = new Map<string, { dome: BufferGeometry; lines: BufferGeometry }>();

function paint(g: BufferGeometry, c: Color) {
  const n = g.getAttribute('position').count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new BufferAttribute(col, 3));
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  return g;
}

function build(color: number, accent: number, pattern: GliderPattern) {
  const main = new Color(color), second = new Color(accent), parts: BufferGeometry[] = [];
  const rim = (t: number) => new Vector3(Math.sin(t) * R * Math.sin(THETA), Math.cos(THETA) * R * SQUASH - DROP, Math.cos(t) * R * Math.sin(THETA));
  for (let i = 0; i < GORES; i++) {
    for (let k = 0; k < RINGS; k++) {
      const alt =
        pattern === 'stripe' ? i % 2 === 1
        : pattern === 'split' ? i >= GORES / 2
        : pattern === 'tips' ? k === RINGS - 1
        : pattern === 'center' ? k === 0
        : pattern === 'checker' ? (i + k) % 2 === 1
        : false;
      const c = pattern === 'rainbow' ? new Color().setHSL(i / GORES, 0.85, 0.55) : alt ? second : main;
      const t0 = (THETA * k) / RINGS, t1 = (THETA * (k + 1)) / RINGS;
      const seg = new SphereGeometry(R, 3, 3, (i / GORES) * Math.PI * 2, (Math.PI * 2) / GORES, t0, t1 - t0).toNonIndexed();
      seg.scale(1, SQUASH, 1).translate(0, -DROP, 0);
      parts.push(paint(seg, c));
    }
  }
  const dome = mergeGeometries(parts)!;
  dome.computeVertexNormals();
  // Lines from the rim down to the harness at the pilot's shoulders.
  const harness = new Vector3(0, -(GLIDER_HEIGHT - 1.5), 0), lines: BufferGeometry[] = [];
  for (let i = 0; i < 8; i++) {
    const t = (i / 8) * Math.PI * 2, top = rim(t), bottom = harness.clone().setX(Math.sin(t) * 0.22).setZ(Math.cos(t) * 0.12);
    const dir = bottom.clone().sub(top), len = dir.length();
    const l = new CylinderGeometry(0.015, 0.015, len, 4).toNonIndexed();
    l.applyQuaternion(new Quaternion().setFromUnitVectors(UP, dir.clone().normalize()));
    l.translate(top.x + dir.x / 2, top.y + dir.y / 2, top.z + dir.z / 2);
    if (l.getAttribute('uv')) l.deleteAttribute('uv');
    lines.push(l);
  }
  return { dome, lines: mergeGeometries(lines)! };
}

export function buildGlider(color: number, accent = 0xffffff, pattern: GliderPattern = 'stripe'): Group {
  const key = `${color}:${accent}:${pattern}`;
  let geo = cache.get(key);
  if (!geo) cache.set(key, (geo = build(color, accent, pattern)));
  const g = new Group();
  const dome = new Mesh(geo.dome, clothMat), lines = new Mesh(geo.lines, lineMat);
  dome.castShadow = true;
  g.add(dome, lines);
  return g;
}
