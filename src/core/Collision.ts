import { Vector3 } from 'three';
import type { Terrain } from './Terrain';

export interface Box {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  /** Moving/removable geometry (doors, props). Navigation ignores it. */
  dyn?: boolean;
}

/** Boxes that move every frame (the train): checked directly instead of through the grid. */
export interface MoverGroup {
  /** Covers every box in the group; skipped quickly when a query misses it. */
  bounds: Box;
  boxes: Box[];
}

/** A moving character: `pos` is the feet position (center of the footprint). */
export interface Body {
  pos: Vector3;
  vel: Vector3;
  radius: number;
  height: number;
  onGround: boolean;
}

const CELL = 16;

/** Static world geometry: axis-aligned boxes in a uniform grid, plus the terrain heightfield. */
export class CollisionWorld {
  boxes: Box[] = [];
  movers: MoverGroup[] = [];
  terrain: Terrain | null = null;
  private half: number;
  private cols: number;
  private grid: number[][];
  private stamp: number[] = [];
  private stampId = 1;
  private scratch: Box[] = [];
  /** Box hit by the last raycast (null if it hit terrain or nothing). */
  lastHit: Box | null = null;

  /** `hasGround` = treat y=0 as solid when there is no terrain (off for helper grids like bush occluders). */
  constructor(size: number, private hasGround = true) {
    this.half = size / 2;
    this.cols = Math.ceil(size / CELL);
    this.grid = Array.from({ length: this.cols * this.cols }, () => []);
  }

  private cellOf(v: number) {
    const c = Math.floor((v + this.half) / CELL);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  /** Adds a box. `span` (optional) is the whole area a moving box may ever occupy. */
  add(b: Box, span: Box = b) {
    const idx = this.boxes.push(b) - 1;
    this.stamp.push(0);
    const x0 = this.cellOf(span.minX), x1 = this.cellOf(span.maxX);
    const z0 = this.cellOf(span.minZ), z1 = this.cellOf(span.maxZ);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) this.grid[cz * this.cols + cx].push(idx);
  }

  queryAABB(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out: Box[] = this.scratch): Box[] {
    out.length = 0;
    const id = ++this.stampId;
    const x0 = this.cellOf(minX), x1 = this.cellOf(maxX);
    const z0 = this.cellOf(minZ), z1 = this.cellOf(maxZ);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const cell = this.grid[cz * this.cols + cx];
        for (let i = 0; i < cell.length; i++) {
          const bi = cell[i];
          if (this.stamp[bi] === id) continue;
          this.stamp[bi] = id;
          const b = this.boxes[bi];
          if (b.minX < maxX && b.maxX > minX && b.minY < maxY && b.maxY > minY && b.minZ < maxZ && b.maxZ > minZ) out.push(b);
        }
      }
    }
    for (const g of this.movers) {
      const u = g.bounds;
      if (!(u.minX < maxX && u.maxX > minX && u.minY < maxY && u.maxY > minY && u.minZ < maxZ && u.maxZ > minZ)) continue;
      for (const b of g.boxes) if (b.minX < maxX && b.maxX > minX && b.minY < maxY && b.maxY > minY && b.minZ < maxZ && b.maxZ > minZ) out.push(b);
    }
    return out;
  }

  groundAt(x: number, z: number) {
    return this.terrain ? this.terrain.heightAt(x, z) : 0;
  }

  anyOverlap(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) {
    return this.queryAABB(minX, minY, minZ, maxX, maxY, maxZ, []).length > 0;
  }

  /** Distance along normalized `dir` to the first solid (boxes or terrain), or `maxDist` if nothing hit. */
  raycast(o: Vector3, dir: Vector3, maxDist: number): number {
    let best = maxDist;
    this.lastHit = null;
    if (this.terrain) best = this.terrain.raycast(o, dir, maxDist);
    else if (this.hasGround && dir.y < 0 && o.y > 0) best = Math.min(best, -o.y / dir.y);
    const idx = 1 / dir.x, idy = 1 / dir.y, idz = 1 / dir.z;
    const id = ++this.stampId;

    const gx = o.x + this.half, gz = o.z + this.half;
    let cx = Math.floor(gx / CELL), cz = Math.floor(gz / CELL);
    const stepX = dir.x > 0 ? 1 : -1, stepZ = dir.z > 0 ? 1 : -1;
    const adx = Math.abs(dir.x), adz = Math.abs(dir.z);
    let tMaxX = adx > 1e-9 ? (dir.x > 0 ? (cx + 1) * CELL - gx : gx - cx * CELL) / adx : Infinity;
    let tMaxZ = adz > 1e-9 ? (dir.z > 0 ? (cz + 1) * CELL - gz : gz - cz * CELL) / adz : Infinity;
    const tDX = adx > 1e-9 ? CELL / adx : Infinity, tDZ = adz > 1e-9 ? CELL / adz : Infinity;
    let t = 0;

    while (t <= best) {
      if (cx >= 0 && cz >= 0 && cx < this.cols && cz < this.cols) {
        const cell = this.grid[cz * this.cols + cx];
        for (let i = 0; i < cell.length; i++) {
          const bi = cell[i];
          if (this.stamp[bi] === id) continue;
          this.stamp[bi] = id;
          const hit = rayBox(o, idx, idy, idz, this.boxes[bi]);
          if (hit < best) {
            best = hit;
            this.lastHit = this.boxes[bi];
          }
        }
      } else if ((cx < 0 && stepX < 0) || (cz < 0 && stepZ < 0) || (cx >= this.cols && stepX > 0) || (cz >= this.cols && stepZ > 0)) {
        break;
      }
      if (tMaxX < tMaxZ) {
        t = tMaxX;
        tMaxX += tDX;
        cx += stepX;
      } else {
        t = tMaxZ;
        tMaxZ += tDZ;
        cz += stepZ;
      }
      if (t === Infinity) break;
    }
    for (const g of this.movers) {
      if (rayBox(o, idx, idy, idz, g.bounds) >= best) continue;
      for (const b of g.boxes) {
        const hit = rayBox(o, idx, idy, idz, b);
        if (hit < best) {
          best = hit;
          this.lastHit = b;
        }
      }
    }
    return best;
  }
}

/** Outward face normal of a box at a point on its surface. */
export function boxNormal(b: Box, p: Vector3, out: Vector3) {
  const d = [p.x - b.minX, b.maxX - p.x, p.y - b.minY, b.maxY - p.y, p.z - b.minZ, b.maxZ - p.z];
  let k = 0;
  for (let i = 1; i < 6; i++) if (d[i] < d[k]) k = i;
  return out.set(k === 0 ? -1 : k === 1 ? 1 : 0, k === 2 ? -1 : k === 3 ? 1 : 0, k === 4 ? -1 : k === 5 ? 1 : 0);
}

/** Slab test. Returns entry distance, or Infinity. */
export function rayBox(o: Vector3, idx: number, idy: number, idz: number, b: Box): number {
  let t1 = (b.minX - o.x) * idx, t2 = (b.maxX - o.x) * idx;
  let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2);
  t1 = (b.minY - o.y) * idy;
  t2 = (b.maxY - o.y) * idy;
  tmin = Math.max(tmin, Math.min(t1, t2));
  tmax = Math.min(tmax, Math.max(t1, t2));
  t1 = (b.minZ - o.z) * idz;
  t2 = (b.maxZ - o.z) * idz;
  tmin = Math.max(tmin, Math.min(t1, t2));
  tmax = Math.min(tmax, Math.max(t1, t2));
  if (tmax < 0 || tmin > tmax || Number.isNaN(tmin)) return Infinity;
  return tmin < 0 ? 0 : tmin;
}

/** Distance along a ray (unit `d`) at which it leaves a box it has entered. */
export function boxExit(o: Vector3, d: Vector3, b: Box): number {
  const ax = (lo: number, hi: number, oa: number, da: number) =>
    Math.abs(da) < 1e-9 ? Infinity : Math.max((lo - oa) / da, (hi - oa) / da);
  return Math.min(ax(b.minX, b.maxX, o.x, d.x), ax(b.minY, b.maxY, o.y, d.y), ax(b.minZ, b.maxZ, o.z, d.z));
}

const hits: Box[] = [];

/** Moves a body through the world with axis-separated collision, stair stepping and sub-stepping. */
export function moveBody(world: CollisionWorld, body: Body, dt: number, stepHeight: number) {
  const dist = body.vel.length() * dt;
  const steps = Math.max(1, Math.ceil(dist / 0.3));
  const sdt = dt / steps;
  const wasGround = body.onGround;
  body.onGround = false;
  for (let s = 0; s < steps; s++) {
    body.pos.x += body.vel.x * sdt;
    resolveHorizontal(world, body, true, wasGround, stepHeight);
    body.pos.z += body.vel.z * sdt;
    resolveHorizontal(world, body, false, wasGround, stepHeight);
    body.pos.y += body.vel.y * sdt;
    resolveVertical(world, body);
  }
  // Stick to the ground when walking down slopes instead of hopping off every hill.
  if (wasGround && !body.onGround && body.vel.y <= 0 && stepHeight > 0) {
    const g = world.groundAt(body.pos.x, body.pos.z);
    const drop = body.pos.y - g;
    if (drop > 0 && drop < 0.6) {
      body.pos.y = g;
      body.vel.y = 0;
      body.onGround = true;
    }
  }
}

function resolveHorizontal(world: CollisionWorld, body: Body, isX: boolean, canStep: boolean, stepHeight: number) {
  const p = body.pos, r = body.radius, h = body.height;
  world.queryAABB(p.x - r, p.y + 0.001, p.z - r, p.x + r, p.y + h, p.z + r, hits);
  for (let i = 0; i < hits.length; i++) {
    const b = hits[i];
    // Earlier pushes may have already separated us.
    if (!(b.minX < p.x + r && b.maxX > p.x - r && b.minZ < p.z + r && b.maxZ > p.z - r && b.minY < p.y + h && b.maxY > p.y + 0.001)) continue;
    if (canStep && b.maxY - p.y <= stepHeight && !world.anyOverlap(p.x - r, b.maxY + 0.001, p.z - r, p.x + r, b.maxY + h, p.z + r)) {
      p.y = b.maxY;
      body.onGround = true;
      continue;
    }
    if (isX) {
      if (p.x < (b.minX + b.maxX) / 2) {
        p.x = b.minX - r - 1e-4;
        if (body.vel.x > 0) body.vel.x = 0;
      } else {
        p.x = b.maxX + r + 1e-4;
        if (body.vel.x < 0) body.vel.x = 0;
      }
    } else {
      if (p.z < (b.minZ + b.maxZ) / 2) {
        p.z = b.minZ - r - 1e-4;
        if (body.vel.z > 0) body.vel.z = 0;
      } else {
        p.z = b.maxZ + r + 1e-4;
        if (body.vel.z < 0) body.vel.z = 0;
      }
    }
  }
}

function resolveVertical(world: CollisionWorld, body: Body) {
  const p = body.pos, r = body.radius, h = body.height;
  const g = world.groundAt(p.x, p.z);
  if (p.y <= g) {
    p.y = g;
    if (body.vel.y < 0) body.vel.y = 0;
    body.onGround = true;
  }
  world.queryAABB(p.x - r, p.y + 0.001, p.z - r, p.x + r, p.y + h, p.z + r, hits);
  for (let i = 0; i < hits.length; i++) {
    const b = hits[i];
    if (body.vel.y <= 0 && p.y > b.maxY - 0.7) {
      p.y = b.maxY;
      body.vel.y = 0;
      body.onGround = true;
    } else if (body.vel.y > 0) {
      p.y = b.minY - h - 1e-4;
      body.vel.y = 0;
    } else {
      p.y = b.maxY;
      body.onGround = true;
    }
  }
}
