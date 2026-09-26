import { Vector3 } from 'three';
import type { CollisionWorld } from '../core/Collision';

/** A climb over or onto an obstacle: rise to `mid`, then move to `to`. */
export interface Mantle {
  from: Vector3;
  mid: Vector3;
  to: Vector3;
  t: number;
  dur: number;
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
  // Vault: low obstacle with the ground open on the far side.
  if (top <= 1.45) {
    for (const far of [1.2, 1.7, 2.3]) {
      const vx = pos.x + fx * (r + far), vz = pos.z + fz * (r + far);
      const vy = Math.max(world.groundAt(vx, vz), pos.y - 1.5);
      if (vy > pos.y + 0.6) continue;
      if (free(vx, vy, vz) && free(px, pos.y + top + 0.05, pz)) {
        return { from: pos.clone(), mid: new Vector3(px, pos.y + top + 0.1, pz), to: new Vector3(vx, vy + 0.02, vz), t: 0, dur: 0.38 };
      }
    }
  }
  return null;
}

/** Advances a mantle; writes the position; returns true when finished. */
export function stepMantle(m: Mantle, dt: number, out: Vector3) {
  m.t = Math.min(1, m.t + dt / m.dur);
  const k = m.t;
  if (k < 0.55) out.lerpVectors(m.from, m.mid, easeOut(k / 0.55));
  else out.lerpVectors(m.mid, m.to, easeOut((k - 0.55) / 0.45));
  return m.t >= 1;
}

const easeOut = (x: number) => 1 - (1 - x) * (1 - x);
