import { BufferAttribute, BufferGeometry } from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * A 1×1×1 box with its four long edges rounded (a rounded rectangle pushed along Z), for parts
 * that get scaled: the rounding stays in proportion to each part's width and height, and the
 * length is left alone so long barrels don't taper to a point.
 */
export function roundedBar(r = 0.3, seg = 3): BufferGeometry {
  const ring: [number, number, number, number][] = [];
  const c = 0.5 - r;
  const corners: [number, number][] = [[c, c], [-c, c], [-c, -c], [c, -c]];
  corners.forEach(([cx, cy], q) => {
    for (let i = 0; i <= seg; i++) {
      const a = ((q + i / seg) * Math.PI) / 2;
      ring.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, Math.cos(a), Math.sin(a)]);
    }
  });
  const pos: number[] = [], nor: number[] = [];
  const v = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    pos.push(x, y, z);
    nor.push(nx, ny, nz);
  };
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0, nx0, ny0] = ring[i], [x1, y1, nx1, ny1] = ring[(i + 1) % n];
    // Side (smooth), then both caps (flat).
    v(x0, y0, -0.5, nx0, ny0, 0); v(x1, y1, -0.5, nx1, ny1, 0); v(x1, y1, 0.5, nx1, ny1, 0);
    v(x0, y0, -0.5, nx0, ny0, 0); v(x1, y1, 0.5, nx1, ny1, 0); v(x0, y0, 0.5, nx0, ny0, 0);
    v(0, 0, 0.5, 0, 0, 1); v(x0, y0, 0.5, 0, 0, 1); v(x1, y1, 0.5, 0, 0, 1);
    v(0, 0, -0.5, 0, 0, -1); v(x1, y1, -0.5, 0, 0, -1); v(x0, y0, -0.5, 0, 0, -1);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  g.computeBoundingSphere();
  return g;
}

/** A box of real size with every edge rounded, non-indexed and without UVs (merges with the rest). */
export function roundedBox(w: number, h: number, d: number, k = 0.3): BufferGeometry {
  const r = Math.min(w, h, d) * k;
  const g0 = new RoundedBoxGeometry(w, h, d, 2, r), g = g0.index ? g0.toNonIndexed() : g0;
  g.deleteAttribute('uv');
  return g;
}
