import { Vector3 } from 'three';
import type { Body } from '../core/Collision';
import { cheatOn } from './Cheats';

export interface Combatant {
  id: number;
  name: string;
  isPlayer: boolean;
  /** Squad number; teammates never hurt each other. */
  team: number;
  body: Body;
  alive: boolean;
  health: number;
  armor: number;
  kills: number;
  /** Head hitbox radius, when it isn't the normal 0.24 (bosses). */
  headR?: number;
  /** Called when this combatant is hit, so bots can react to attackers. */
  onDamaged(attacker: Combatant | null, amount: number): void;
}

export interface HitInfo {
  t: number;
  head: boolean;
  /** Hit below the hips (a little less damage). */
  legs: boolean;
}

/** Ray vs character hitbox: a body box (legs are its lower part) plus a head sphere. Returns null if missed. */
export function rayHitCombatant(o: Vector3, dir: Vector3, maxDist: number, c: Combatant): HitInfo | null {
  const p = c.body.pos, r = c.body.radius * 0.9, h = c.body.height;
  // Head sphere
  const hr = c.headR ?? 0.24;
  const hx = p.x - o.x, hy = p.y + h - hr + 0.02 - o.y, hz = p.z - o.z;
  const tc = hx * dir.x + hy * dir.y + hz * dir.z;
  let best: HitInfo | null = null;
  if (tc > 0) {
    const d2 = hx * hx + hy * hy + hz * hz - tc * tc;
    if (d2 < hr * hr) {
      const t = tc - Math.sqrt(hr * hr - d2);
      if (t < maxDist) best = { t, head: true, legs: false };
    }
  }
  // Body box
  const bMaxY = p.y + h - 0.44;
  let tmin = 0, tmax = maxDist;
  const slab = (oa: number, da: number, lo: number, hi: number) => {
    if (Math.abs(da) < 1e-9) return oa >= lo && oa <= hi;
    let t1 = (lo - oa) / da, t2 = (hi - oa) / da;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    return tmin <= tmax;
  };
  if (slab(o.x, dir.x, p.x - r, p.x + r) && slab(o.y, dir.y, p.y, bMaxY) && slab(o.z, dir.z, p.z - r, p.z + r)) {
    if (!best || tmin < best.t) best = { t: tmin, head: false, legs: o.y + dir.y * tmin < p.y + h * 0.42 };
  }
  return best;
}

/** Applies damage (armor first). Returns damage split for UI. */
export function applyDamage(target: Combatant, amount: number, ignoreArmor = false) {
  if (target.isPlayer && cheatOn('god')) return { toArmor: 0, toHealth: 0, armorBroken: false, killed: false };
  let toArmor = 0;
  if (!ignoreArmor && target.armor > 0) {
    toArmor = Math.min(target.armor, amount);
    target.armor -= toArmor;
  }
  const toHealth = amount - toArmor;
  target.health -= toHealth;
  return { toArmor, toHealth, armorBroken: toArmor > 0 && target.armor <= 0, killed: target.health <= 0 };
}

/** Random direction inside a cone around `dir` (in place). */
export function applySpread(dir: Vector3, spread: number): Vector3 {
  if (spread <= 0) return dir;
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * spread;
  // Build a perpendicular basis
  const up = Math.abs(dir.y) < 0.99 ? tmpUp.set(0, 1, 0) : tmpUp.set(1, 0, 0);
  const u = tmpU.crossVectors(dir, up).normalize();
  const v = tmpV.crossVectors(dir, u);
  dir.addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r).normalize();
  return dir;
}

const tmpUp = new Vector3(), tmpU = new Vector3(), tmpV = new Vector3();
