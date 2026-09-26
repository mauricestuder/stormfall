import type { Vector3 } from 'three';

/**
 * Regular heightfield. Each cell is split along the (x0,z0)-(x1,z1) diagonal, and the render mesh
 * uses the exact same triangulation, so feet sit exactly on the visible ground.
 */
export class Terrain {
  readonly n: number; // vertices per side
  heights: Float32Array;
  maxHeight = 0;

  constructor(readonly extent: number, readonly cell: number) {
    this.n = Math.round(extent / cell) + 1;
    this.heights = new Float32Array(this.n * this.n);
  }

  /** World coordinate of vertex index i (same for x and z). */
  coord(i: number) {
    return -this.extent / 2 + i * this.cell;
  }

  get(ix: number, iz: number) {
    return this.heights[iz * this.n + ix];
  }

  heightAt(x: number, z: number): number {
    const n = this.n;
    let gx = (x + this.extent / 2) / this.cell, gz = (z + this.extent / 2) / this.cell;
    gx = gx < 0 ? 0 : gx > n - 1.0001 ? n - 1.0001 : gx;
    gz = gz < 0 ? 0 : gz > n - 1.0001 ? n - 1.0001 : gz;
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const fx = gx - ix, fz = gz - iz;
    const h = this.heights, i = iz * n + ix;
    const h00 = h[i], h10 = h[i + 1], h01 = h[i + n], h11 = h[i + n + 1];
    return fx >= fz
      ? h00 + fx * (h10 - h00) + fz * (h11 - h10)
      : h00 + fz * (h01 - h00) + fx * (h11 - h01);
  }

  recomputeMax() {
    let m = -Infinity;
    for (let i = 0; i < this.heights.length; i++) if (this.heights[i] > m) m = this.heights[i];
    this.maxHeight = m;
  }

  /** Distance along normalized `dir` to the terrain surface, or `maxDist`. Marches, then bisects. */
  raycast(o: Vector3, dir: Vector3, maxDist: number): number {
    // Skip the part of the ray that is entirely above the highest hill.
    let t0 = 0, t1 = maxDist;
    if (o.y > this.maxHeight) {
      if (dir.y >= 0) return maxDist;
      t0 = (o.y - this.maxHeight) / -dir.y;
      if (t0 >= maxDist) return maxDist;
    } else if (dir.y > 0) {
      t1 = Math.min(maxDist, (this.maxHeight - o.y) / dir.y + this.cell);
    }
    const step = this.cell * 0.5;
    let prevT = t0;
    for (let t = t0; t <= t1 + step; t += step) {
      const tt = Math.min(t, t1);
      const y = o.y + dir.y * tt;
      if (y <= this.heightAt(o.x + dir.x * tt, o.z + dir.z * tt)) {
        if (tt === 0) return 0;
        let a = prevT, b = tt;
        for (let k = 0; k < 8; k++) {
          const m = (a + b) / 2;
          if (o.y + dir.y * m <= this.heightAt(o.x + dir.x * m, o.z + dir.z * m)) b = m;
          else a = m;
        }
        return b;
      }
      prevT = tt;
      if (tt >= t1) break;
    }
    return maxDist;
  }
}
