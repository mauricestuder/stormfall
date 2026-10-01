import { Vector3 } from 'three';
import type { CollisionWorld } from '../core/Collision';

/** A climb over or onto an obstacle: rise to `mid`, then move to `to`. */
export interface Mantle {
  from: Vector3;
  mid: Vector3;
  to: Vector3;
  t: number;
  dur: number;
  /** Eye height while going through (a window: ducked under the top of the opening). */
  eye?: number;
}

/**
 * Looks for something to climb in front of a body at `pos` facing (fx, fz): a ledge up to 2.3 m
 * high with room to stand on top (mantle), or a low wall/fence with open ground behind it (vault).
 */
export function planMantle(world: CollisionWorld, pos: Vector3, fx: number, fz: number, r: number, bodyH: number): Mantle | null {
  const ahead = r + 0.3;
  const px = pos.x + fx * ahead, pz = pos.z + fz * ahead;
  const blocked = (h0: number, h1: number) => world.anyOverlap(px - 0.12, pos.y + h0, pz - 0.12, px + 0.12, pos.y + h1, pz + 0.12);
  if (!blocked(0.5, 1.3)) return null;
  // How tall is the obstacle right in front of us?
  let top = -1;
  for (let h = 0.6; h <= 2.5; h += 0.1) {
    if (!blocked(h, h + 0.1)) {
      top = h;
      break;
    }
  }
  if (top < 0) return null;
  // Room above our head to climb?
  if (world.anyOverlap(pos.x - r, pos.y + bodyH, pos.z - r, pos.x + r, pos.y + top + bodyH, pos.z + r)) return null;
  const free = (x: number, y: number, z: number) => !world.anyOverlap(x - r, y + 0.02, z - r, x + r, y + bodyH, z + r);
  const support = (x: number, y: number, z: number) => world.groundAt(x, z) >= y - 0.15 || world.anyOverlap(x - r * 0.6, y - 0.15, z - r * 0.6, x + r * 0.6, y - 0.01, z + r * 0.6);
  // Mantle: stand on top of it.
  const tx = pos.x + fx * (r + 0.75), tz = pos.z + fz * (r + 0.75), ty = pos.y + top;
  const mid = new Vector3(pos.x + fx * 0.15, ty + 0.05, pos.z + fz * 0.15);
  if (free(tx, ty, tz) && support(tx, ty, tz) && free(mid.x, mid.y, mid.z)) {
    return { from: pos.clone(), mid, to: new Vector3(tx, ty + 0.02, tz), t: 0, dur: 0.22 + top * 0.1 };
  }
  // Vault: low obstacle (a fence, or a window sill) with room on the far side. Through a window you
  // go over tucked up, so the opening only has to be about waist high.
  if (top <= 1.45) {
    let gap = bodyH;
    for (let h = top + 0.1; h < top + bodyH; h += 0.1) {
      if (blocked(h, h + 0.1)) {
        gap = h - top;
        break;
      }
    }
    if (gap < 0.75) return null;
    const tuck = Math.min(bodyH, gap - 0.05);
    const pass = (x: number, y: number, z: number) => !world.anyOverlap(x - r * 0.7, y + 0.02, z - r * 0.7, x + r * 0.7, y + tuck, z + r * 0.7);
    // Landing: the first floor below the far side (a room's floor, or the ground outside); from an
    // upper storey, just out into the air.
    const land = (x: number, z: number) => {
      const o = tmpO.set(x, pos.y + top + 0.2, z), t = world.raycast(o, DOWN, top + 1.9);
      const y = Math.max(t < top + 1.9 ? o.y - t : -Infinity, world.groundAt(x, z));
      return y > pos.y - 1.7 ? y : pos.y + top * 0.5;
    };
    for (const far of [1.2, 1.7, 2.3]) {
      const vx = pos.x + fx * (r + far), vz = pos.z + fz * (r + far);
      const vy = land(vx, vz);
      if (vy > pos.y + 0.6) continue;
      const over = pos.y + top + 0.05;
      if (free(vx, vy, vz) && pass(px, over, pz) && pass(pos.x + fx * (r + 0.7), over, pos.z + fz * (r + 0.7))) {
        return { from: pos.clone(), mid: new Vector3(px, pos.y + top + 0.1, pz), to: new Vector3(vx, vy + 0.02, vz), t: 0, dur: gap < bodyH ? 0.45 : 0.38, eye: gap < bodyH ? Math.max(0.5, gap - 0.4) : undefined };
      }
    }
  }
  return null;
}

const DOWN = new Vector3(0, -1, 0), tmpO = new Vector3();

/** Advances a mantle; writes the position; returns true when finished. */
export function stepMantle(m: Mantle, dt: number, out: Vector3) {
  m.t = Math.min(1, m.t + dt / m.dur);
  const k = m.t;
  if (k < 0.55) out.lerpVectors(m.from, m.mid, easeOut(k / 0.55));
  else out.lerpVectors(m.mid, m.to, easeOut((k - 0.55) / 0.45));
  return m.t >= 1;
}

const easeOut = (x: number) => 1 - (1 - x) * (1 - x);
