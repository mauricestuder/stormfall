import { Vector3 } from 'three';
import type { Combatant } from '../game/Combat';
import type { Game } from '../game/Game';
import { TOY } from '../theme';
import { PEN_DAMAGE, type WeaponInstance } from './Weapon';

/** Bullet drop (m/s²). */
const GRAVITY = 9.8;
/** The first slice of a bullet's flight is traced the moment it's fired, so close fights still feel instant. */
const INSTANT = 0.045;
/** Longest a bullet flies before it's dropped. */
const MAX_LIFE = 2.5;

interface Bullet {
  shooter: Combatant;
  w: WeaponInstance;
  pos: Vector3;
  vel: Vector3;
  muzzle: Vector3;
  traveled: number;
  life: number;
  dmgMul: number;
  first: boolean;
}

/**
 * Rifle rounds that travel and drop instead of hitting instantly (guns with a `bulletVel`).
 * Each frame a bullet moves one short straight step, traced with Game.fireShot, so hits, walls, glass,
 * penetration and damage all behave exactly like hitscan shots: you just have to lead and hold over at range.
 */
export class Bullets {
  private list: Bullet[] = [];

  constructor(private game: Game) {}

  fire(shooter: Combatant, origin: Vector3, dir: Vector3, w: WeaponInstance, muzzle: Vector3) {
    const b: Bullet = {
      shooter, w, pos: origin.clone(), vel: dir.clone().multiplyScalar(w.def.bulletVel), muzzle: muzzle.clone(),
      traveled: 0, life: 0, dmgMul: 1, first: true,
    };
    if (this.step(b, INSTANT)) this.list.push(b);
  }

  update(dt: number) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (!this.step(this.list[i], dt)) this.list.splice(i, 1);
    }
  }

  /** Moves a bullet one step. Returns false once it has hit something or run out of range. */
  private step(b: Bullet, dt: number): boolean {
    const next = tmpNext.copy(b.pos).addScaledVector(b.vel, dt);
    next.y -= 0.5 * GRAVITY * dt * dt;
    b.vel.y -= GRAVITY * dt;
    const seg = tmpSeg.subVectors(next, b.pos);
    const len = seg.length();
    if (len < 1e-4) return false;
    seg.divideScalar(len);
    const r = this.game.fireShot(b.shooter, b.pos, seg, b.w, b.muzzle, {
      range: len, traveled: b.traveled, dmgMul: b.dmgMul, cont: !b.first, bullet: true,
    });
    const end = r.t < len ? tmpEnd.copy(b.pos).addScaledVector(seg, r.t) : next;
    this.trail(b, end);
    b.first = false;
    if (r.through) {
      b.traveled += b.pos.distanceTo(r.through);
      b.pos.copy(r.through);
      b.dmgMul *= PEN_DAMAGE;
      return true;
    }
    if (r.stopped) return false;
    b.traveled += len;
    b.pos.copy(next);
    b.life += dt;
    return b.life < MAX_LIFE && b.traveled < b.w.def.range;
  }

  /** A streak along this step (from the muzzle on the first one). */
  private trail(b: Bullet, end: Vector3) {
    const cam = this.game.camera.position, byPlayer = b.shooter.isPlayer;
    if (!byPlayer && end.distanceToSquared(cam) > 300 * 300) return;
    const from = b.first ? b.muzzle : b.pos;
    if (TOY) this.game.fx.tracer(from, end, byPlayer ? 0xff8a1a : 0x5ad1ff, byPlayer ? 0.035 : 0.05, 0.09);
    else this.game.fx.tracer(from, end, byPlayer ? 0xffe08a : 0xff8a5a, byPlayer ? 0.022 : 0.035, 0.06);
  }
}

const tmpNext = new Vector3(), tmpSeg = new Vector3(), tmpEnd = new Vector3();
