import { Vector3 } from 'three';
import type { Box, CollisionWorld } from './Collision';

const UNKNOWN = 0, OPEN = 1, BLOCKED = 2;
const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

/**
 * Ground-level walkability on a 1 m grid, worked out lazily the first time a cell is asked about,
 * plus budgeted A* so bots can find doorways and walk around buildings instead of into them.
 */
export class NavGrid {
  private n: number;
  private half: number;
  private cells: Uint8Array;
  private gen: Int32Array;
  private g: Float32Array;
  private parent: Int32Array;
  private stamp = 0;
  private heap: number[] = [];
  private f: Float32Array;
  private scratch: Box[] = [];

  /**
   * `size` metres square, centred on (ox, oz). `floor` sets a flat floor height instead of the
   * terrain (the arena sits on a platform out at sea).
   */
  constructor(private world: CollisionWorld, size: number, private ox = 0, private oz = 0, private floor?: number) {
    this.n = size;
    this.half = size / 2;
    const N = size * size;
    this.cells = new Uint8Array(N);
    this.gen = new Int32Array(N);
    this.g = new Float32Array(N);
    this.f = new Float32Array(N);
    this.parent = new Int32Array(N);
  }

  private idx(x: number, z: number) {
    const i = Math.floor(x - this.ox + this.half), j = Math.floor(z - this.oz + this.half);
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return -1;
    return j * this.n + i;
  }

  private cx(i: number) {
    return (i % this.n) - this.half + 0.5 + this.ox;
  }

  private cz(i: number) {
    return Math.floor(i / this.n) - this.half + 0.5 + this.oz;
  }

  walkable(i: number) {
    if (i < 0) return false;
    let c = this.cells[i];
    if (c === UNKNOWN) c = this.cells[i] = this.probe(this.cx(i), this.cz(i));
    return c === OPEN;
  }

  walkableAt(x: number, z: number) {
    return this.walkable(this.idx(x, z));
  }

  /** Stand on the terrain (or a low floor on top of it) with head-room, and not in deep water. */
  private probe(x: number, z: number) {
    const w = this.world, r = 0.32;
    const g = this.floor ?? w.groundAt(x, z);
    if (g < -1.2) return BLOCKED;
    let floor = g;
    const hits = w.queryAABB(x - r, g - 0.6, z - r, x + r, g + 2.4, z + r, this.scratch);
    for (let k = 0; k < 3; k++) {
      for (const b of hits) if (!b.dyn && b.maxY > floor && b.maxY <= floor + 0.6) floor = b.maxY;
    }
    for (const b of hits) {
      if (b.dyn) continue;
      if (b.minY < floor + 1.7 && b.maxY > floor + 0.6) return BLOCKED;
    }
    return OPEN;
  }

  /** Forget cached cells under a box that changed (a crate was destroyed). */
  invalidate(b: Box) {
    for (let z = Math.floor(b.minZ) - 1; z <= Math.ceil(b.maxZ) + 1; z++) {
      for (let x = Math.floor(b.minX) - 1; x <= Math.ceil(b.maxX) + 1; x++) {
        const i = this.idx(x, z);
        if (i >= 0) this.cells[i] = UNKNOWN;
      }
    }
  }

  /** True if a straight walk between two points crosses only walkable cells. */
  clearLine(ax: number, az: number, bx: number, bz: number) {
    const d = Math.hypot(bx - ax, bz - az), steps = Math.ceil(d / 0.5);
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      if (!this.walkableAt(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return true;
  }

  /** Waypoints from `from` towards `to` (partial if the search budget runs out), or null. */
  findPath(from: Vector3, to: Vector3, budget = 4000): Vector3[] | null {
    const start = this.idx(from.x, from.z);
    let goal = this.idx(to.x, to.z);
    if (start < 0 || goal < 0) return null;
    if (!this.walkable(goal)) {
      // Aim for the nearest open cell around the goal instead.
      let found = -1;
      for (let r = 1; r <= 3 && found < 0; r++) {
        for (const [dx, dz] of DIRS) {
          const k = this.idx(to.x + dx * r, to.z + dz * r);
          if (this.walkable(k)) {
            found = k;
            break;
          }
        }
      }
      if (found < 0) return null;
      goal = found;
    }
    const id = ++this.stamp, n = this.n;
    const gx = goal % n, gz = Math.floor(goal / n);
    const h = (i: number) => {
      const dx = Math.abs((i % n) - gx), dz = Math.abs(Math.floor(i / n) - gz);
      return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
    };
    const heap = this.heap;
    heap.length = 0;
    this.gen[start] = id;
    this.g[start] = 0;
    this.parent[start] = -1;
    this.f[start] = h(start);
    this.push(start);
    let best = start, bestH = h(start), expanded = 0;
    while (heap.length) {
      const cur = this.pop();
      if (cur === goal) {
        best = goal;
        break;
      }
      if (++expanded > budget) break;
      const ch = this.f[cur] - this.g[cur];
      if (ch < bestH) {
        bestH = ch;
        best = cur;
      }
      const x = cur % n, z = Math.floor(cur / n);
      for (const [dx, dz, cost] of DIRS) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const ni = nz * n + nx;
        if (!this.walkable(ni)) continue;
        if (dx && dz && (!this.walkable(z * n + nx) || !this.walkable(nz * n + x))) continue;
        const ng = this.g[cur] + cost;
        if (this.gen[ni] === id && ng >= this.g[ni]) continue;
        this.gen[ni] = id;
        this.g[ni] = ng;
        this.parent[ni] = cur;
        this.f[ni] = ng + h(ni);
        this.push(ni);
      }
    }
    if (best === start) return null;
    // Walk back, then pull the string tight.
    const raw: number[] = [];
    for (let c = best; c !== -1; c = this.parent[c]) raw.push(c);
    raw.reverse();
    const out: Vector3[] = [];
    let anchor = raw[0];
    for (let k = 1; k < raw.length; k++) {
      const next = raw[k + 1];
      if (next === undefined || !this.clearLine(this.cx(anchor), this.cz(anchor), this.cx(next), this.cz(next))) {
        out.push(new Vector3(this.cx(raw[k]), 0, this.cz(raw[k])));
        anchor = raw[k];
      }
    }
    return out;
  }

  private push(i: number) {
    const heap = this.heap, f = this.f;
    heap.push(i);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (f[heap[p]] <= f[i]) break;
      heap[k] = heap[p];
      k = p;
    }
    heap[k] = i;
  }

  private pop() {
    const heap = this.heap, f = this.f;
    const top = heap[0], last = heap.pop()!;
    const n = heap.length;
    if (n) {
      let k = 0;
      const fl = f[last];
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = -1, fm = fl;
        if (l < n && f[heap[l]] < fm) {
          m = l;
          fm = f[heap[l]];
        }
        if (r < n && f[heap[r]] < fm) m = r;
        if (m < 0) break;
        heap[k] = heap[m];
        k = m;
      }
      heap[k] = last;
    }
    return top;
  }
}

/** Buckets combatants into 32 m cells so "who is near me?" doesn't scan everyone. */
export class SpatialGrid<T extends { body: { pos: Vector3 } }> {
  private cells = new Map<number, T[]>();

  rebuild(items: T[], keep: (t: T) => boolean) {
    for (const list of this.cells.values()) list.length = 0;
    for (const it of items) {
      if (!keep(it)) continue;
      const k = key(it.body.pos.x, it.body.pos.z);
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, (list = []));
      list.push(it);
    }
  }

  query(x: number, z: number, r: number, out: T[] = []) {
    out.length = 0;
    const x0 = Math.floor((x - r) / 32), x1 = Math.floor((x + r) / 32), z0 = Math.floor((z - r) / 32), z1 = Math.floor((z + r) / 32);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
      const list = this.cells.get(cz * 4096 + cx + 2048 * 4097);
      if (!list) continue;
      for (const it of list) {
        const dx = it.body.pos.x - x, dz = it.body.pos.z - z;
        if (dx * dx + dz * dz <= r * r) out.push(it);
      }
    }
    return out;
  }
}

function key(x: number, z: number) {
  return Math.floor(z / 32) * 4096 + Math.floor(x / 32) + 2048 * 4097;
}
