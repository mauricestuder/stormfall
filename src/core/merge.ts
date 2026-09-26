import { BufferAttribute, BufferGeometry, Color, Matrix4, Mesh, type Material, type Object3D } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const c = new Color(), e = new Color(), inv = new Matrix4(), rel = new Matrix4();

/**
 * Bakes every mesh under `root` into one geometry with per-vertex colours (material colour plus
 * emissive), so a whole multi-part model draws in a single call with a shared vertex-colour material.
 */
export function mergeToGeometry(root: Object3D): BufferGeometry {
  root.updateMatrixWorld(true);
  // Bake relative to the root's frame, but keep a lone mesh's own scale (ammo boxes, plates).
  if ((root as Mesh).isMesh) inv.identity();
  else inv.copy(root.matrixWorld).invert();
  const parts: BufferGeometry[] = [];
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || !m.visible) return;
    const src = m.geometry;
    const g = new BufferGeometry();
    g.setAttribute('position', src.getAttribute('position').clone());
    g.setAttribute('normal', src.getAttribute('normal').clone());
    if (src.index) g.setIndex(src.index.clone());
    const g2 = g.index ? g.toNonIndexed() : g;
    rel.multiplyMatrices(inv, m.matrixWorld);
    g2.applyMatrix4(rel);
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as Material & { color?: Color; emissive?: Color };
    c.copy(mat.color ?? c.set(0xffffff));
    if (mat.emissive) c.add(e.copy(mat.emissive));
    const n = g2.getAttribute('position').count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([Math.min(1, c.r), Math.min(1, c.g), Math.min(1, c.b)], i * 3);
    g2.setAttribute('color', new BufferAttribute(col, 3));
    parts.push(g2);
  });
  const merged = mergeGeometries(parts, false)!;
  merged.computeBoundingSphere();
  return merged;
}
