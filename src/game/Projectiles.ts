import { BoxGeometry, ConeGeometry, CylinderGeometry, Group, IcosahedronGeometry, Mesh, MeshBasicMaterial, MeshLambertMaterial, Scene, Vector3 } from 'three';
import { boxNormal, rayBox } from '../core/Collision';
import { THROWABLES, type ThrowKind, type WeaponInstance } from '../weapons/Weapon';
import type { Combatant } from './Combat';
import type { Game } from './Game';

const GRAVITY = 18;

interface Projectile {
  kind: ThrowKind | 'rocket';
  pos: Vector3;
  vel: Vector3;
  fuse: number;
  owner: Combatant;
  mesh: Group;
  weapon?: WeaponInstance;
  rest: boolean;
}

export interface SmokeCloud {
  pos: Vector3;
  r: number;
  life: number;
}

const grenadeGeo = new IcosahedronGeometry(0.11, 0);
const canGeo = new CylinderGeometry(0.07, 0.07, 0.22, 8);
const rocketGeo = new CylinderGeometry(0.07, 0.07, 0.7, 8).rotateX(Math.PI / 2);
const noseGeo = new ConeGeometry(0.07, 0.2, 8).rotateX(-Math.PI / 2).translate(0, 0, -0.45);
const flameGeo = new BoxGeometry(0.12, 0.12, 0.35).translate(0, 0, 0.5);
/** Shared so a long match of grenades and rockets doesn't pile up materials. */
const mats = {
  rocket: new MeshLambertMaterial({ color: 0x55603a }),
  nose: new MeshLambertMaterial({ color: 0xc9c2a0 }),
  flame: new MeshBasicMaterial({ color: 0xffb040 }),
  frag: new MeshLambertMaterial({ color: THROWABLES.frag.color }),
  smoke: new MeshLambertMaterial({ color: THROWABLES.smoke.color }),
  flash: new MeshLambertMaterial({ color: THROWABLES.flash.color }),
  grapple: new MeshLambertMaterial({ color: THROWABLES.grapple.color }),
};

/** Grenades (frag, smoke, flash) and rockets: real projectiles with bouncing physics. */
export class Projectiles {
  list: Projectile[] = [];
  smokes: SmokeCloud[] = [];

  constructor(private scene: Scene, private game: Game) {}

  private makeMesh(kind: ThrowKind | 'rocket') {
    const g = new Group();
    if (kind === 'rocket') {
      g.add(new Mesh(rocketGeo, mats.rocket), new Mesh(noseGeo, mats.nose), new Mesh(flameGeo, mats.flame));
    } else {
      g.add(new Mesh(kind === 'frag' ? grenadeGeo : canGeo, mats[kind]));
    }
    g.traverse((o) => (o.castShadow = true));
    this.scene.add(g);
    return g;
  }

  throw(kind: ThrowKind, from: Vector3, vel: Vector3, owner: Combatant, remote = false) {
    const a = this.game.netm;
    if (!remote && a && a.owns(owner)) a.sendThrow(owner, kind, from, vel);
    const fuse = kind === 'frag' ? 2.4 : kind === 'flash' ? 1.4 : 1.2;
    this.list.push({ kind, pos: from.clone(), vel: vel.clone(), fuse, owner, mesh: this.makeMesh(kind), rest: false });
  }

  fireRocket(from: Vector3, dir: Vector3, owner: Combatant, w: WeaponInstance, remote = false) {
    this.game.arena?.dropShield(owner);
    const a = this.game.netm;
    if (!remote && a && a.owns(owner)) a.sendThrow(owner, 'rocket', from, dir);
    const speed = w.def.projectile!.speed;
    this.list.push({ kind: 'rocket', pos: from.clone(), vel: dir.clone().multiplyScalar(speed), fuse: 7, owner, mesh: this.makeMesh('rocket'), weapon: w, rest: false });
  }

  /** Ballistic launch velocity that lands on `to` after `t` seconds. */
  static aimArc(from: Vector3, to: Vector3, t: number, out: Vector3) {
    return out.set((to.x - from.x) / t, (to.y - from.y) / t + 0.5 * GRAVITY * t, (to.z - from.z) / t);
  }

  /** Predicted flight path (for the throw preview line). */
  predict(from: Vector3, vel: Vector3, out: Vector3[]) {
    const p = tmpP.copy(from), v = tmpV.copy(vel), dt = 1 / 30;
    out.length = 0;
    for (let i = 0; i < 75; i++) {
      out.push(p.clone());
      v.y -= GRAVITY * dt;
      const len = v.length() * dt;
      const d = tmpD.copy(v).normalize();
      const t = this.game.world.raycast(p, d, len + 0.05);
      if (t < len + 0.05) {
        out.push(p.clone().addScaledVector(d, t));
        break;
      }
      p.addScaledVector(v, dt);
    }
    return out;
  }

  /** True if a smoke cloud blocks the line between two points. */
  smokeBlocks(a: Vector3, b: Vector3) {
    for (const s of this.smokes) {
      if (s.r < 1.5) continue;
      const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
      const len2 = abx * abx + aby * aby + abz * abz;
      const t = Math.max(0, Math.min(1, ((s.pos.x - a.x) * abx + (s.pos.y - a.y) * aby + (s.pos.z - a.z) * abz) / (len2 || 1)));
      const dx = a.x + abx * t - s.pos.x, dy = a.y + aby * t - s.pos.y, dz = a.z + abz * t - s.pos.z;
      if (dx * dx + dy * dy + dz * dz < s.r * s.r * 0.8) return true;
    }
    return false;
  }

  update(dt: number) {
    const g = this.game, world = g.world;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const pr = this.list[i];
      pr.fuse -= dt;
      if (pr.kind === 'rocket') {
        const speed = pr.vel.length(), d = tmpD.copy(pr.vel).divideScalar(speed), step = speed * dt;
        let t = world.raycast(pr.pos, d, step);
        // Rockets also stop on people and vehicles.
        const ix = 1 / d.x, iy = 1 / d.y, iz = 1 / d.z;
        for (const c of g.combatants) {
          if (c === pr.owner || !c.alive || !g.inWorld(c)) continue;
          const b = c.body;
          const ht = rayBox(pr.pos, ix, iy, iz, { minX: b.pos.x - 0.5, minY: b.pos.y, minZ: b.pos.z - 0.5, maxX: b.pos.x + 0.5, maxY: b.pos.y + b.height, maxZ: b.pos.z + 0.5 });
          if (ht < t) t = ht;
        }
        for (const v of g.vehicles) {
          const r = v.body.radius, bp = v.body.pos;
          const ht = rayBox(pr.pos, ix, iy, iz, { minX: bp.x - r, minY: bp.y, minZ: bp.z - r, maxX: bp.x + r, maxY: bp.y + 1.75, maxZ: bp.z + r });
          if (ht < t) t = ht;
        }
        g.glass.shoot(pr.pos, d, Math.min(t, step));
        if (t < step || pr.fuse <= 0) {
          pr.pos.addScaledVector(d, Math.min(t, step) - 0.1);
          this.remove(i);
          g.explode(pr.pos, pr.weapon!.def.projectile!.radius, pr.weapon!.def.damage * pr.weapon!.rarity.mult, pr.owner, 'Havoc Launcher');
          continue;
        }
        pr.pos.addScaledVector(d, step);
        pr.mesh.position.copy(pr.pos);
        pr.mesh.lookAt(tmpP.copy(pr.pos).sub(d));
        if (Math.random() < 0.8) g.fx.puff(pr.pos, 0xd0ccc4, 1, 0.3, 0.25, 0.3, 1.2, { alpha: 0.5 });
        continue;
      }
      if (!pr.rest) {
        pr.vel.y -= GRAVITY * dt;
        const speed = pr.vel.length(), step = speed * dt;
        if (step > 1e-4) {
          const d = tmpD.copy(pr.vel).divideScalar(speed);
          const t = world.raycast(pr.pos, d, step + 0.06);
          g.glass.shoot(pr.pos, d, step + 0.06);
          if (t < step + 0.06) {
            const hit = tmpP.copy(pr.pos).addScaledVector(d, t);
            const n = world.lastHit ? boxNormal(world.lastHit, hit, tmpN) : this.terrainNormal(hit.x, hit.z, tmpN);
            pr.pos.copy(hit).addScaledVector(n, 0.06);
            const vn = pr.vel.dot(n);
            pr.vel.addScaledVector(n, -1.55 * vn).multiplyScalar(0.55);
            if (-vn > 2.5) g.sfx.bounce(pr.pos);
            if (pr.vel.length() < 1.2 && n.y > 0.6) {
              pr.rest = true;
              pr.vel.set(0, 0, 0);
            }
          } else pr.pos.addScaledVector(pr.vel, dt);
        }
        pr.mesh.position.copy(pr.pos);
        pr.mesh.rotation.x += dt * 9;
        pr.mesh.rotation.z += dt * 6;
      }
      if (pr.fuse <= 0) {
        this.remove(i);
        this.detonate(pr);
      }
    }
    // Smoke clouds grow, linger and keep puffing so they stay opaque.
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.life -= dt;
      s.r = Math.min(7, s.r + dt * 4);
      if (s.life > 1.5 && Math.random() < dt * 30) g.fx.puff(s.pos, 0xbfc3c9, 1, 1.0, 2.4, 0.08, 4, { alpha: 1, grow: 0.8, drag: 1.4, spread: s.r * 1.15 });
      if (s.life <= 0) this.smokes.splice(i, 1);
    }
  }

  private terrainNormal(x: number, z: number, out: Vector3) {
    const h = (a: number, b: number) => this.game.map.groundAt(a, b);
    return out.set(h(x - 1, z) - h(x + 1, z), 2, h(x, z - 1) - h(x, z + 1)).normalize();
  }

  private remove(i: number) {
    this.scene.remove(this.list[i].mesh);
    this.list.splice(i, 1);
  }

  private detonate(pr: Projectile) {
    const g = this.game;
    if (pr.kind === 'frag') g.explode(pr.pos, 7, 115, pr.owner, 'Frag Grenade');
    else if (pr.kind === 'smoke') {
      this.smokes.push({ pos: pr.pos.clone().setY(pr.pos.y + 1), r: 0.5, life: 16 });
      g.fx.puff(pr.pos, 0xe4e6ea, 16, 4, 1.4, 0.8, 3, { alpha: 0.9, grow: 1.4 });
      g.sfx.smokePop(pr.pos);
    } else g.flashbang(pr.pos, pr.owner);
  }
}

const tmpP = new Vector3(), tmpV = new Vector3(), tmpD = new Vector3(), tmpN = new Vector3();
