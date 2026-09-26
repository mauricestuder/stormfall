import { Color, Group, Vector3 } from 'three';
import { CONFIG } from '../config';
import { moveBody, type Body } from '../core/Collision';
import { clamp, damp } from '../core/rng';
import type { Difficulty } from '../core/Settings';
import { applySpread, type Combatant } from '../game/Combat';
import type { Game } from '../game/Game';
import { Projectiles } from '../game/Projectiles';
import { planMantle, stepMantle, type Mantle } from '../player/Movement';
import type { Vehicle } from '../vehicles/Vehicle';
import { adsSpreadOf, magSize, makeWeapon, weaponScore, type WeaponInstance } from '../weapons/Weapon';
import { Character } from './Character';
import type { Skin } from '../game/Skins';
import { buildGlider, GLIDER_HEIGHT } from '../world/Glider';
import type { ZipLine } from '../world/Interactive';
import { BOSS_LEASH, type BossState } from './Boss';

const P = CONFIG.player;
const D = CONFIG.drop;

export type Mode = 'plane' | 'freefall' | 'glide' | 'ground' | 'vehicle';
/** The player, or a friend playing online. */
const isHuman = (c: Combatant) => c.isPlayer || (c instanceof Bot && c.human);

export interface BotTuning {
  /** Multiplies aim error (lower = sharper). */
  skill: number;
  /** Multiplies reaction time. */
  react: number;
  /** Multiplies damage bots deal to you. */
  damage: number;
  /** How keen they are on grenades (0..1). */
  grenade: number;
  /** How often they duck into cover (0..1). */
  cover: number;
  vision: number;
}

export const DIFFICULTY: Record<Difficulty, BotTuning> = {
  easy: { skill: 1.55, react: 1.5, damage: 0.65, grenade: 0.15, cover: 0.3, vision: 0.8 },
  normal: { skill: 1, react: 1, damage: 1, grenade: 0.45, cover: 0.6, vision: 1 },
  hard: { skill: 0.62, react: 0.65, damage: 1.15, grenade: 0.85, cover: 0.9, vision: 1.15 },
};

/**
 * Bot strength nudged by the adaptive level (-1..1): sharper aim, quicker reactions and a bit more
 * damage as you keep winning; the reverse when you keep losing.
 */
export function adaptTuning(t: BotTuning, a: number): BotTuning {
  const c = (x: number) => Math.max(0, Math.min(1, x));
  return {
    skill: t.skill * (1 - 0.22 * a), react: t.react * (1 - 0.2 * a), damage: t.damage * (1 + 0.15 * a),
    grenade: c(t.grenade + 0.15 * a), cover: c(t.cover + 0.15 * a), vision: t.vision * (1 + 0.1 * a),
  };
}

/** Keys a bot "holds" while driving (same interface the vehicle reads from the keyboard). */
class BotKeys {
  keys = new Set<string>();
  isDown(code: string) {
    return this.keys.has(code);
  }
}

export class Bot implements Combatant {
  readonly isPlayer = false;
  body: Body = { pos: new Vector3(), vel: new Vector3(), radius: P.radius, height: P.standHeight, onGround: false };
  alive = true;
  health = 100;
  armor: number;
  kills = 0;
  plates = Math.random() < 0.5 ? 1 : 0;
  weapon: WeaponInstance = makeWeapon('pistol');
  /** A second gun, if they've found one worth carrying (like you, bots have two slots). */
  backup: WeaponInstance | null = null;
  /** Seconds before they'll swap guns again. */
  private swapCd = 0;
  mode: Mode = 'plane';
  yaw = Math.random() * Math.PI * 2;
  character: Character;
  team = 0;
  /** Everyone on this bot's squad (may include the player). */
  squad: Combatant[] = [];
  frags = Math.random() < 0.55 ? 1 : 0;
  smokes = Math.random() < 0.3 ? 1 : 0;
  /** Practice-range target: never thinks or shoots. */
  dummy = false;
  dummyStrafe = 0;
  inGulag = false;
  /** Driven by another player's machine over the network (no AI, just follows their updates). */
  puppet = false;
  /** A friend playing online (bots treat them like the player). */
  human = false;
  /** Puppets: how the owner is moving (plane, skydiving, on foot, driving). */
  netMode: Mode = 'ground';
  private netPos = new Vector3();
  private netVel = new Vector3();
  private netYaw = 0;
  private netAge = 0;
  /** Seconds of flashbang blindness left. */
  blind = 0;
  vehicle: Vehicle | null = null;
  keys = new BotKeys();

  jumpAt: number;
  landTarget = new Vector3();
  /** Teammates of the player drift after you during the drop. */
  followPlayer = false;
  skill: number;

  target: Combatant | null = null;
  lastKnown = new Vector3();
  private targetVisible = false;
  private lastSeen = 0;
  private reaction = 0;
  private thinkTimer = Math.random() * 0.3;
  private goal: Vector3 | null = null;
  private goalTimer = 0;
  private strafeDir = 1;
  private strafeTimer = 0;
  private fireCd = 0;
  private burstLeft = 0;
  private reloadLeft = 0;
  private stuckTimer = 0;
  private lastPos = new Vector3();
  private unstick = 0;
  private unstickDir = new Vector3();
  private healLeft = 0;
  /** Heals left: a couple to start with, and medkits they pick up. Nobody out-heals the storm forever. */
  heals = 2;
  /** Set for bosses (see Boss.ts): a giant guarding its home spot. */
  boss: BossState | null = null;
  /** Head hitbox radius (bosses have big heads). */
  headR?: number;
  /** Seconds spent barely moving while trying to go somewhere. */
  private stuckLong = 0;
  private ignoreUntil = new Map<number, number>();
  private groundTime = 0;
  private path: Vector3[] | null = null;
  private pathGoal = new Vector3();
  private pathCd = 0;
  private cover: Vector3 | null = null;
  private coverTimer = 0;
  private peek = 0;
  private crouch = false;
  /** Seconds of slide left (bots slide into and around fights). */
  private slideT = 0;
  /** Riding a zipline, and the one we're walking to so we can ride it. */
  private zip: { line: ZipLine; t: number; dir: 1 | -1 } | null = null;
  private zipPlan: { line: ZipLine; end: 0 | 1 } | null = null;
  private grenadeCd = 5 + Math.random() * 10;
  private mantle: Mantle | null = null;
  private wantVehicle: Vehicle | null = null;
  private driveStuck = 0;
  private sprayIdx = 0;
  private ram = false;
  /**
   * Where the bot's crosshair sits relative to the target's chest, in metres. Like a person it starts
   * off target, settles in over a few tenths of a second, trails behind strafing targets and wobbles.
   */
  private aimOff = new Vector3();
  private wobble = new Vector3();
  private aimTarget: Combatant | null = null;

  private glider: Group;
  private gliderT = 0;
  /** Direction of the last hit (a dying bot falls away from it). */
  lastHitDir = new Vector3(0, 0, -1);
  /** Seconds of being knocked flying (hit by a car): no control until it lands. */
  knock = 0;
  /** Death animation clock (-1 = not dying). */
  private deathT = -1;
  private fallX = 0;
  private fallZ = 0;

  constructor(public id: number, public name: string, game: Game, suitHue = Math.random(), marker?: number, outfit?: Skin) {
    this.armor = 25;
    // Small spread only: no hopeless bot next to an aimbot.
    this.skill = (0.95 + Math.random() * 0.12) * game.tuning.skill;
    this.jumpAt = 0.12 + Math.random() * 0.76;
    const suit = new Color().setHSL(suitHue, 0.65, 0.5), trim = new Color().setHSL(suitHue, 0.4, 0.25);
    this.character = new Character(suit, trim, marker, outfit);
    this.character.setGun(this.weapon);
    game.scene.add(this.character.root);
    this.character.root.visible = false;
    this.glider = buildGlider(outfit ? outfit.glider : new Color().setHSL(suitHue, 0.75, 0.55).getHex());
    this.glider.position.y = GLIDER_HEIGHT;
    this.glider.visible = false;
    this.character.root.add(this.glider);
  }

  get mesh(): Group {
    return this.character.root;
  }

  setWeapon(w: WeaponInstance) {
    this.weapon = w;
    if (w.mag <= 0) w.mag = magSize(w);
    this.character.setGun(w);
  }

  /** The weaker of the two slots (an empty slot is the weakest). */
  private worstScore() {
    return this.backup ? Math.min(weaponScore(this.weapon), weaponScore(this.backup)) : -Infinity;
  }

  /** Takes a gun into whichever slot is empty or weaker; the gun it replaces is thrown away. */
  private takeGun(w: WeaponInstance) {
    if (!this.backup) this.backup = w;
    else if (weaponScore(this.backup) <= weaponScore(this.weapon)) this.backup = w;
    else this.setWeapon(w);
    // Hold the better of the two until a fight says otherwise.
    if (weaponScore(this.backup!) > weaponScore(this.weapon)) this.swapGuns(0);
  }

  private swapGuns(delay = 0.4) {
    if (!this.backup) return;
    const old = this.weapon;
    this.setWeapon(this.backup);
    this.backup = old;
    this.reloadLeft = 0;
    this.burstLeft = 0;
    this.sprayIdx = 0;
    this.fireCd = Math.max(this.fireCd, delay);
    this.swapCd = 1.5;
  }

  /** In a fight: out of ammo, or the other gun suits this range much better? Swap (faster than reloading). */
  private pickGun(dist: number) {
    if (!this.backup || this.swapCd > 0) return;
    const fit = (w: WeaponInstance) => weaponScore(w) - Math.abs(Math.log(Math.max(1, dist) / w.def.botRange)) * 12 + (w.mag > 0 ? 0 : -100);
    if (fit(this.backup) > fit(this.weapon) + 6) this.swapGuns();
  }

  onDamaged(attacker: Combatant | null, _amount: number) {
    this.character.hit();
    if (this.boss && attacker?.isPlayer) this.boss.hurtByYou = 0;
    this.healLeft = 0;
    if (this.dummy) return;
    if (attacker && attacker !== this && attacker.team !== this.team && (!this.target || !this.targetVisible)) {
      this.target = attacker;
      this.lastKnown.copy(attacker.body.pos);
      this.lastSeen = 0;
      this.reaction = Math.min(this.reaction, 0.25);
    }
  }

  /** A squadmate spotted someone. */
  alert(t: Combatant) {
    if (this.target || this.dummy) return;
    this.target = t;
    // A callout is rough: "over there somewhere", not an exact position.
    this.lastKnown.copy(t.body.pos).add(tmpC.set((Math.random() - 0.5) * 12, 0, (Math.random() - 0.5) * 12));
    this.lastSeen = 1;
    this.targetVisible = false;
  }

  eye(out: Vector3) {
    return out.set(this.body.pos.x, this.body.pos.y + this.body.height - 0.2, this.body.pos.z);
  }

  /** Latest state from the network for a puppet. */
  applyNet(p: number[], v: number[], yaw: number, crouch: boolean, mode: Mode = 'ground') {
    this.netMode = mode;
    this.netPos.set(p[0], p[1], p[2]);
    this.netVel.set(v[0], v[1], v[2]);
    this.netYaw = yaw;
    this.netAge = 0;
    this.crouch = crouch;
  }

  get crouching() {
    return this.crouch;
  }

  /** Glide toward where the network says the puppet is (extrapolated a little), and animate. */
  private updatePuppet(dt: number, game: Game) {
    const b = this.body;
    this.netAge += dt;
    const k = Math.min(this.netAge, 0.2);
    const tx = this.netPos.x + this.netVel.x * k, ty = this.netPos.y + this.netVel.y * k, tz = this.netPos.z + this.netVel.z * k;
    const d2 = (tx - b.pos.x) ** 2 + (ty - b.pos.y) ** 2 + (tz - b.pos.z) ** 2;
    const f = d2 > 25 ? 1 : 1 - Math.exp(-14 * dt);
    b.pos.x += (tx - b.pos.x) * f;
    b.pos.y += (ty - b.pos.y) * f;
    b.pos.z += (tz - b.pos.z) * f;
    b.vel.copy(this.netVel);
    b.onGround = Math.abs(this.netVel.y) < 0.8;
    b.height = this.crouch ? P.crouchHeight : P.standHeight;
    let dy = this.netYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += dy * (1 - Math.exp(-20 * dt));
    this.mode = this.netMode;
    this.mesh.visible = this.mode !== 'plane';
    if (this.mode === 'ground' && game.frameNo % 8 === this.id % 8) game.doors.approach(b.pos, null);
    this.animate(dt, game);
    this.glider.visible = this.mode === 'glide';
  }

  update(dt: number, game: Game) {
    if (!this.alive) {
      if (this.deathT >= 0) this.updateDeath(dt, game);
      return;
    }
    if (this.puppet) return this.updatePuppet(dt, game);
    switch (this.mode) {
      case 'plane':
        game.plane.position(this.body.pos);
        this.body.vel.copy(game.plane.velocity);
        // Squadmates bail out right behind you (a beat apart); everyone else picks their own moment.
        if (this.followPlayer ? game.player.mode !== 'plane' && Math.random() < 0.05 : game.plane.shouldJump(this.jumpAt)) this.jump();
        break;
      case 'freefall':
      case 'glide':
        this.updateAir(dt, game);
        break;
      case 'ground':
        this.updateGround(dt, game);
        break;
      case 'vehicle':
        this.updateVehicle(dt, game);
        break;
    }
    this.animate(dt, game);
    // The glider snaps open from a bundle and settles.
    const gl = this.mode === 'glide';
    this.glider.visible = gl;
    this.gliderT = gl ? Math.min(1, this.gliderT + dt / 0.5) : 0;
    if (gl) {
      const k = this.gliderT, open = k < 1 ? 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2) : 1;
      this.glider.scale.set(Math.max(0.05, open), Math.max(0.05, 0.3 + 0.7 * open), Math.max(0.05, 0.6 + 0.4 * open));
      this.glider.position.y = GLIDER_HEIGHT * (0.55 + 0.45 * Math.min(1, k * 1.4));
    }
  }

  jump() {
    this.mode = 'freefall';
    this.mesh.visible = true;
  }

  private updateAir(dt: number, game: Game) {
    const b = this.body;
    if (this.followPlayer) {
      // Stick with the player: aim for a spot next to where they're heading.
      const p = game.player.body.pos, a = this.id * 1.7;
      this.landTarget.set(p.x + Math.cos(a) * 6 + game.player.body.vel.x * 2, 0, p.z + Math.sin(a) * 6 + game.player.body.vel.z * 2);
    }
    const to = tmpA.set(this.landTarget.x - b.pos.x, 0, this.landTarget.z - b.pos.z);
    const dist = to.length();
    const glide = this.mode === 'glide';
    const hs = Math.min(glide ? D.glideHorizontal : D.freefallHorizontal, dist * 0.8);
    if (dist > 0.01) to.multiplyScalar(hs / dist);
    b.vel.x = damp(b.vel.x, to.x, 2, dt);
    b.vel.z = damp(b.vel.z, to.z, 2, dt);
    const ground = game.world.groundAt(b.pos.x, b.pos.z);
    // Dive hard when far above the landing spot, like a player would.
    const fall = glide ? D.glideFall : dist < b.pos.y - ground ? D.diveSpeed : D.freefallSpeed;
    b.vel.y = damp(b.vel.y, -fall, 3, dt);
    if (Math.abs(to.x) + Math.abs(to.z) > 0.1) this.yaw = Math.atan2(-to.x, -to.z);
    moveBody(game.world, b, dt, P.stepHeight);
    if (!glide && b.pos.y - ground < D.deployAltitude) this.mode = 'glide';
    if (b.onGround) {
      this.mode = 'ground';
      b.vel.set(0, 0, 0);
      this.lastPos.copy(b.pos);
    }
  }

  // ---------- on foot ----------

  private updateGround(dt: number, game: Game) {
    const b = this.body;
    this.groundTime += dt;
    this.fireCd -= dt;
    this.strafeTimer -= dt;
    this.goalTimer -= dt;
    this.reaction -= dt;
    this.lastSeen += dt;
    this.pathCd -= dt;
    this.grenadeCd -= dt;
    this.blind = Math.max(0, this.blind - dt);

    if (this.mantle) {
      if (stepMantle(this.mantle, dt, b.pos)) {
        this.mantle = null;
        b.vel.set(0, 0, 0);
      }
      return;
    }

    if (this.zip) {
      const z = this.zip, L = z.line;
      z.t += (z.dir * ZIP_SPEED * dt) / L.len;
      const c = tmpC.copy(L.a).addScaledVector(L.dir, clamp(z.t, 0, 1) * L.len);
      b.vel.set(c.x - b.pos.x, c.y - 2.05 - b.pos.y, c.z - b.pos.z).divideScalar(Math.max(dt, 1e-4));
      b.pos.set(c.x, c.y - 2.05, c.z);
      b.onGround = false;
      if (z.t <= 0 || z.t >= 1) {
        this.zip = null;
        b.vel.copy(L.dir).multiplyScalar(ZIP_SPEED * z.dir * 0.7);
        b.vel.y = Math.min(b.vel.y, 0);
        if (L.push && z.dir < 0) b.vel.set(L.push[0] * 6, 5, L.push[1] * 6);
        this.goalTimer = 0;
      }
      return;
    }

    // Knocked flying by a car: no control until we're back on our feet.
    if (this.knock > 0) {
      this.knock -= dt;
      b.vel.y -= P.gravity * dt;
      if (b.onGround && this.knock < 1.35) {
        b.vel.x = damp(b.vel.x, 0, 8, dt);
        b.vel.z = damp(b.vel.z, 0, 8, dt);
        this.knock = Math.min(this.knock, 0.35);
      }
      moveBody(game.world, b, dt, P.stepHeight);
      return;
    }

    if (this.dummy) return this.updateDummy(dt, game);
    if (this.boss) return this.updateBoss(dt, game);

    // AI level of detail: far-away bots think less often.
    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      const d = b.pos.distanceTo(game.camera.position);
      this.thinkTimer = (d < 150 ? 0.2 : d < 320 ? 0.45 : 0.8) + Math.random() * 0.1;
      this.think(game);
    }

    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) this.weapon.mag = magSize(this.weapon);
    }

    // Heal when safe
    const inStorm = game.zone.isOutside(b.pos.x, b.pos.z);
    if (!this.target && !inStorm && this.heals > 0 && this.health < 70 && this.healLeft <= 0 && Math.random() < 0.01) this.healLeft = 2.5;
    if (this.healLeft > 0) {
      this.healLeft -= dt;
      if (this.healLeft <= 0) {
        this.health = Math.min(100, this.health + 50);
        this.heals--;
      }
    }

    const move = tmpA.set(0, 0, 0);
    let speed = P.walkSpeed;
    this.crouch = false;
    const t = this.target;
    if (this.blind > 0) {
      // Flashed: stumble around blindly.
      if (this.strafeTimer <= 0) {
        this.strafeDir = Math.random() < 0.5 ? -1 : 1;
        this.strafeTimer = 0.5;
      }
      move.set(Math.cos(this.yaw + this.strafeDir), 0, Math.sin(this.yaw + this.strafeDir));
      speed = P.crouchSpeed;
    } else if (t && t.alive) {
      const to = tmpB.subVectors(this.targetVisible ? t.body.pos : this.lastKnown, b.pos);
      to.y = 0;
      const dist = to.length();
      to.normalize();
      this.yaw = turnToward(this.yaw, Math.atan2(-to.x, -to.z), 9 * dt);
      if (this.cover) {
        // Hold cover: crouch to reload/heal, then pop out and shoot.
        this.coverTimer -= dt;
        const at = distXZ(this.cover, b.pos) < 1.2;
        if (!at && this.coverTimer > 0) {
          this.steer(this.cover, game, move);
          speed = P.sprintSpeed;
        } else {
          this.peek -= dt;
          if (this.peek > 0) {
            move.set(-to.z * this.strafeDir, 0, to.x * this.strafeDir);
            speed = P.walkSpeed * 0.7;
            if (this.targetVisible) this.tryFire(dt, game, t, dist);
          } else {
            this.crouch = true;
            if (this.weapon.mag < magSize(this.weapon) && this.reloadLeft <= 0 && this.weapon.mag < magSize(this.weapon) * 0.5) this.reloadLeft = this.weapon.def.reload * 1.1;
            if (this.health < 60 && this.healLeft <= 0 && this.heals > 0) this.healLeft = 2.2;
            if (this.peek < -1.2 - Math.random() * 1.5) {
              this.peek = 1.2 + Math.random();
              this.strafeDir = Math.random() < 0.5 ? -1 : 1;
            }
          }
          if (this.coverTimer <= 0) this.cover = null;
        }
      } else if (this.targetVisible) {
        if (this.strafeTimer <= 0) {
          this.strafeDir = Math.random() < 0.5 ? -1 : 1;
          this.strafeTimer = 0.6 + Math.random() * 1.2;
          if (Math.random() < 0.3 && b.onGround) b.vel.y = P.jumpVelocity;
          else if (Math.random() < 0.3 && b.onGround && dist > 8) this.slideT = 0.8;
        }
        const pref = this.weapon.def.botRange;
        const approach = dist > pref * 1.3 ? 1 : dist < pref * 0.6 ? -0.6 : 0;
        move.set(-to.z * this.strafeDir, 0, to.x * this.strafeDir).addScaledVector(to, approach);
        speed = P.walkSpeed * 0.9;
        this.tryFire(dt, game, t, dist);
      } else {
        // Hunt: run to where they were last seen (around walls if needed), sliding now and then.
        this.steer(this.lastKnown, game, move);
        speed = P.sprintSpeed * 0.9;
        if (b.onGround && this.slideT <= 0 && Math.random() < dt * 0.5) this.slideT = 0.8;
        if (distXZ(this.lastKnown, b.pos) < 2) this.target = null;
      }
    } else {
      if (this.wantVehicle) {
        const v = this.wantVehicle;
        if (!v.alive || v.hasDriver) this.wantVehicle = null;
        else if (distXZ(v.body.pos, b.pos) < 3.2) {
          this.enterVehicle(v, game);
          return;
        } else this.goal = v.body.pos.clone();
      }
      if (!this.goal || this.goalTimer <= 0 || distXZ(this.goal, b.pos) < 1.5) this.pickGoal(game);
      const zp = this.zipPlan;
      if (zp) {
        const end = zp.end === 0 ? zp.line.a : zp.line.b;
        if (distXZ(end, b.pos) < 2 && Math.abs(b.pos.y + 1.9 - end.y) < 2.6) {
          this.zip = { line: zp.line, t: zp.end, dir: zp.end === 0 ? 1 : -1 };
          this.zipPlan = null;
          return;
        }
        this.steer(end, game, move);
        speed = P.sprintSpeed;
        if (distXZ(end, b.pos) > 80 || this.target) this.zipPlan = null;
      } else if (this.goal) {
        this.steer(this.goal, game, move);
        const d = distXZ(this.goal, b.pos);
        speed = d > 25 || game.zone.outsideSafe(b.pos.x, b.pos.z, 0) ? P.sprintSpeed : P.walkSpeed;
      }
      if (this.healLeft > 0) speed = P.crouchSpeed;
      if (move.lengthSq() > 0.01) this.yaw = turnToward(this.yaw, Math.atan2(-move.x, -move.z), 6 * dt);
    }
    // Zone pressure overrides everything once the gas is close, or will be within ~10 s.
    if (!this.inGulag && (game.zone.outsideSafe(b.pos.x, b.pos.z, -5) || game.zone.closingOn(b.pos.x, b.pos.z, 10))) {
      const c = game.zone.safeCenter();
      this.steer(tmpC.set(c.x, 0, c.y), game, move);
      speed = P.sprintSpeed;
      this.cover = null;
    }

    if (this.unstick > 0) {
      this.unstick -= dt;
      move.copy(this.unstickDir);
    }
    // Sliding: a burst of speed low to the ground, sometimes finished with a slide-jump.
    let sliding = false;
    if (this.slideT > 0) {
      this.slideT -= dt;
      if (this.slideT > 0 && b.onGround && move.lengthSq() > 0.01) {
        sliding = true;
        this.crouch = true;
        speed = P.sprintSpeed + P.slideBoost * (this.slideT / 0.8);
        if (this.slideT < 0.1 && Math.random() < 0.35) {
          b.vel.y = P.jumpVelocity;
          this.slideT = 0;
        }
      }
    }
    if (this.crouch && !sliding) speed = Math.min(speed, P.crouchSpeed);
    b.height = this.crouch ? P.crouchHeight : P.standHeight;
    // Deep water: swim along the surface.
    const ground = game.world.groundAt(b.pos.x, b.pos.z);
    const swimming = ground < -1.3 && b.pos.y < -0.5 - 1.2;
    if (swimming) speed *= 0.5;
    if (move.lengthSq() > 0.0001) move.normalize().multiplyScalar(speed);
    b.vel.x = damp(b.vel.x, move.x, 10, dt);
    b.vel.z = damp(b.vel.z, move.z, 10, dt);
    if (swimming) {
      b.vel.y = damp(b.vel.y, (-0.5 - 1.35 - b.pos.y) * 4, 6, dt);
      b.onGround = false;
    } else b.vel.y -= P.gravity * dt;
    moveBody(game.world, b, dt, P.stepHeight);
    game.doors.approach(b.pos, null);

    // Stuck: try to climb over, else wiggle and re-path.
    this.stuckTimer += dt;
    if (this.stuckTimer > 0.8) {
      const moved = distXZ(this.lastPos, b.pos);
      this.stuckLong = move.lengthSq() > 1 && moved < 2 ? this.stuckLong + this.stuckTimer : 0;
      // Wedged for ages somewhere nobody can see: hop along the path (or toward the zone) instead.
      if (this.stuckLong > 6 && b.pos.distanceTo(game.camera.position) > 90) {
        this.stuckLong = 0;
        const wp = this.path?.[Math.min(2, this.path.length - 1)];
        const c = game.zone.safeCenter();
        let x = wp ? wp.x : b.pos.x, z = wp ? wp.z : b.pos.z;
        if (!wp) {
          const d = Math.hypot(c.x - x, c.y - z) || 1;
          x += ((c.x - x) / d) * 8;
          z += ((c.y - z) / d) * 8;
        }
        b.pos.set(x, game.world.groundAt(x, z) + 0.05, z);
        b.vel.set(0, 0, 0);
        this.path = null;
      }
      if (move.lengthSq() > 1 && moved < 1.2 && this.unstick <= 0) {
        const ml = Math.hypot(move.x, move.z);
        this.mantle = b.onGround ? planMantle(game.world, b.pos, move.x / ml, move.z / ml, b.radius, b.height) : null;
        if (!this.mantle) {
          const a = Math.random() * Math.PI * 2;
          this.unstickDir.set(Math.cos(a), 0, Math.sin(a));
          this.unstick = 0.9;
          if (b.onGround) b.vel.y = P.jumpVelocity;
          this.path = null;
          this.goalTimer = Math.min(this.goalTimer, 1.5);
        }
      }
      this.stuckTimer = 0;
      this.lastPos.copy(b.pos);
    }

    this.tryPickup(game);
  }

  /**
   * A boss: patrols round its home, turns on anyone who comes close (or shoots it), chases only so
   * far, and heals up again when it's left alone. No looting, cover, cars or ziplines.
   */
  private updateBoss(dt: number, game: Game) {
    const b = this.body, S = this.boss!;
    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer = 0.25;
      this.think(game);
    }
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) this.weapon.mag = magSize(this.weapon);
    }
    S.hurtByYou += dt;
    const move = tmpA.set(0, 0, 0), fromHome = distXZ(b.pos, S.home);
    let speed = P.walkSpeed * 0.85;
    const t = this.target;
    if (t && t.alive) {
      S.calm = 0;
      const to = tmpB.subVectors(this.targetVisible ? t.body.pos : this.lastKnown, b.pos);
      to.y = 0;
      const dist = to.length();
      to.normalize();
      this.yaw = turnToward(this.yaw, Math.atan2(-to.x, -to.z), 5 * dt);
      if (this.targetVisible) {
        if (this.strafeTimer <= 0) {
          this.strafeDir = Math.random() < 0.5 ? -1 : 1;
          this.strafeTimer = 1.5 + Math.random() * 1.5;
        }
        const pref = this.weapon.def.botRange * 0.8, approach = dist > pref ? 1 : dist < pref * 0.5 ? -0.5 : 0;
        move.set(-to.z * this.strafeDir * 0.5, 0, to.x * this.strafeDir * 0.5).addScaledVector(to, approach);
        this.tryFire(dt, game, t, dist);
      } else if (fromHome < BOSS_LEASH) {
        // Stomp over to where it last saw you.
        this.steer(this.lastKnown, game, move);
        speed = P.walkSpeed;
        if (distXZ(this.lastKnown, b.pos) < 3) this.target = null;
      } else this.target = null;
    } else {
      // Left alone: heal up and wander round home.
      S.calm += dt;
      if (S.calm > 5 && this.health < S.maxHealth) this.health = Math.min(S.maxHealth, this.health + S.maxHealth * 0.06 * dt);
      if (!this.goal || this.goalTimer <= 0 || distXZ(this.goal, b.pos) < 1.5) {
        const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 14;
        this.goal = new Vector3(S.home.x + Math.cos(a) * r, 0, S.home.z + Math.sin(a) * r);
        this.goalTimer = 5 + Math.random() * 4;
      }
      this.steer(this.goal, game, move);
      speed = P.walkSpeed * 0.5;
      if (move.lengthSq() > 0.01) this.yaw = turnToward(this.yaw, Math.atan2(-move.x, -move.z), 3 * dt);
    }
    // Never strays far from home.
    if (fromHome > BOSS_LEASH) {
      this.steer(S.home, game, move);
      speed = P.walkSpeed;
    }
    if (move.lengthSq() > 0.0001) move.normalize().multiplyScalar(speed);
    b.vel.x = damp(b.vel.x, move.x, 8, dt);
    b.vel.z = damp(b.vel.z, move.z, 8, dt);
    b.vel.y -= P.gravity * dt;
    this.crouch = false;
    b.height = P.standHeight * S.def.size;
    moveBody(game.world, b, dt, P.stepHeight * 1.6);
    // Wedged somewhere for a while (nobody watching): back home.
    this.stuckTimer += dt;
    if (this.stuckTimer > 1) {
      this.stuckLong = move.lengthSq() > 1 && distXZ(this.lastPos, b.pos) < 1 ? this.stuckLong + this.stuckTimer : 0;
      if (this.stuckLong > 5 && !this.targetVisible) {
        b.pos.copy(S.home);
        b.vel.set(0, 0, 0);
        this.stuckLong = 0;
        this.path = null;
      }
      this.stuckTimer = 0;
      this.lastPos.copy(b.pos);
    }
  }

  private updateDummy(dt: number, game: Game) {
    const b = this.body;
    if (this.dummyStrafe) {
      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0) {
        this.strafeDir *= -1;
        this.strafeTimer = 1.4 + Math.random();
      }
      const s = this.dummyStrafe * this.strafeDir;
      b.vel.x = damp(b.vel.x, Math.cos(this.yaw) * s, 8, dt);
      b.vel.z = damp(b.vel.z, -Math.sin(this.yaw) * s, 8, dt);
    } else b.vel.x = b.vel.z = 0;
    b.vel.y -= P.gravity * dt;
    moveBody(game.world, b, dt, P.stepHeight);
  }

  /** Direction toward `to`, following a path around obstacles when the straight line is blocked. */
  private steer(to: Vector3, game: Game, out: Vector3) {
    const b = this.body, nav = game.nav;
    const d = distXZ(to, b.pos);
    if (this.path && this.path.length && distXZ(this.pathGoal, to) < 4) {
      let wp = this.path[0];
      while (wp && distXZ(wp, b.pos) < 1.1) {
        this.path.shift();
        wp = this.path[0];
      }
      if (wp) return out.set(wp.x - b.pos.x, 0, wp.z - b.pos.z);
      this.path = null;
    }
    const lookX = b.pos.x + ((to.x - b.pos.x) / (d || 1)) * Math.min(d, 40), lookZ = b.pos.z + ((to.z - b.pos.z) / (d || 1)) * Math.min(d, 40);
    const direct = d < 3 || nav.clearLine(b.pos.x, b.pos.z, lookX, lookZ);
    if (!direct && this.pathCd <= 0 && game.pathBudget > 0) {
      game.pathBudget--;
      this.pathCd = 1.2;
      const aim = d > 70 ? tmpC.set(b.pos.x + ((to.x - b.pos.x) / d) * 70, 0, b.pos.z + ((to.z - b.pos.z) / d) * 70) : to;
      this.path = nav.findPath(b.pos, aim, 3500);
      this.pathGoal.copy(to);
      if (this.path?.length) return out.set(this.path[0].x - b.pos.x, 0, this.path[0].z - b.pos.z);
    }
    return out.set(to.x - b.pos.x, 0, to.z - b.pos.z);
  }

  /** A long way to go: is there a zipline start nearby whose far end gets us a lot closer? */
  private planZip(game: Game) {
    const b = this.body, g = this.goal;
    if (!g || this.zip || this.zipPlan || this.target || this.vehicle) return;
    const far = distXZ(g, b.pos);
    const highGround = Math.random() < 0.25;
    for (const l of game.ziplines.lines) {
      // A vertical line close by: ride up for the high ground now and then.
      if (l.push && highGround && distXZ(l.b, b.pos) < 30 && !game.zone.outsideSafe(l.b.x, l.b.z, 5)) {
        this.zipPlan = { line: l, end: 1 };
        return;
      }
      if (far < 60) continue;
      for (const end of [0, 1] as const) {
        const s = end === 0 ? l.a : l.b, e = end === 0 ? l.b : l.a;
        if (distXZ(s, b.pos) > 60 || s.y - game.world.groundAt(s.x, s.z) > 4) continue;
        if (distXZ(e, g) < far - 30 && !game.zone.outsideSafe(e.x, e.z, 0)) {
          this.zipPlan = { line: l, end };
          return;
        }
      }
    }
  }

  private think(game: Game) {
    if (!this.boss && Math.random() < 0.3) this.planZip(game);
    const eye = this.eye(tmpE);
    const B = CONFIG.bots;
    const range = B.visionRange * game.tuning.vision * game.visionMul;
    const fwdX = -Math.sin(this.yaw), fwdZ = -Math.cos(this.yaw);
    const cosFov = Math.cos(B.fovHalfAngle);

    if (this.target && (!this.target.alive || this.lastSeen > (isHuman(this.target) ? 6 : 3) || !game.canTarget(this, this.target))) this.target = null;
    let best: Combatant | null = null, bestD = Infinity;
    const cur = this.target;
    this.targetVisible = false;
    if (this.blind <= 0) {
      for (const c of game.grid.query(eye.x, eye.z, range, nearby)) {
        if (c === this || !c.alive || c.team === this.team || !game.onFoot(c) || !game.canTarget(this, c)) continue;
        // Bots leave bosses alone unless the boss started it; bosses only care about their patch.
        if (c !== cur && (c as Bot).boss && !this.boss) continue;
        if (this.boss && c !== cur && distXZ(c.body.pos, this.boss.home) > BOSS_LEASH + 40) continue;
        const dx = c.body.pos.x - eye.x, dz = c.body.pos.z - eye.z;
        const d = Math.hypot(dx, dz);
        // Bots on the enemy side mostly leave each other alone; your squad is always fair game.
        const casual = !isHuman(c) && !game.humanTeam(c.team) && !game.humanTeam(this.team) && !game.arena;
        if (casual && c !== cur && !this.inGulag && !this.boss) {
          if (d > B.botVsBotRange || this.groundTime < B.botLootTime) continue;
          const until = this.ignoreUntil.get(c.id);
          if (until !== undefined && game.matchTime < until) continue;
        }
        const inFov = d < (this.boss ? 40 : 12) || (dx * fwdX + dz * fwdZ) / (d || 1) > cosFov || c === cur;
        if (!inFov || !game.canSee(eye, c)) continue;
        const score = d * (c === cur ? 0.6 : 1) * (isHuman(c) ? B.playerPreference : 1);
        if (score < bestD) {
          bestD = score;
          best = c;
        }
      }
    }
    const playerSide = (c: Combatant) => game.humanTeam(c.team);
    if (best && !this.boss && !playerSide(best) && !playerSide(this) && best !== cur && !this.inGulag && !game.arena && Math.random() > B.botEngageChance) {
      // Not worth the fight right now.
      this.ignoreUntil.set(best.id, game.matchTime + 25 + Math.random() * 20);
      best = null;
    }
    if (best) {
      if (best !== this.target) {
        this.ram = Math.random() < game.tuning.grenade + 0.3;
        this.reaction = (0.58 + Math.random() * 0.2) * this.skill * game.tuning.react * (isHuman(best) ? 1 : 1.6);
        for (const m of this.squad) if (m !== this && m instanceof Bot && m.alive && m.body.pos.distanceTo(this.body.pos) < 90) m.alert(best);
      }
      else if (this.lastSeen > 0.5) {
        // Lost sight and got it back (you peeked, or came round a corner): they have to react and
        // aim again. Their crosshair was on where they last saw you, not where you are now.
        this.reaction = Math.max(this.reaction, (0.25 + Math.random() * 0.35) * this.skill * game.tuning.react);
        const off = tmpC.subVectors(this.lastKnown, best.body.pos);
        off.y = 0;
        if (off.length() > 4) off.setLength(4);
        const d = distXZ(best.body.pos, this.body.pos), r = (0.4 + d * 0.02) * this.skill, a = Math.random() * Math.PI * 2;
        this.aimOff.set(off.x + Math.cos(a) * r, Math.sin(a) * r * 0.5, off.z + Math.sin(a) * r);
        this.aimTarget = best;
      }
      this.target = best;
      this.targetVisible = true;
      this.lastSeen = 0;
      this.lastKnown.copy(best.body.pos);
      this.healLeft = 0;
    }
    const t = this.target;
    if (t && !this.inGulag) {
      const hurt = this.health + this.armor < 90 || this.weapon.mag <= magSize(this.weapon) * 0.25;
      if (!this.cover && !this.boss && this.targetVisible && hurt && Math.random() < game.tuning.cover * 0.5) {
        this.cover = this.findCover(game, t);
        if (this.cover) {
          this.coverTimer = 6 + Math.random() * 4;
          this.peek = -0.5;
          if (this.smokes > 0 && this.health < 50 && Math.random() < 0.5) this.throwAt(game, 'smoke', tmpC.lerpVectors(this.body.pos, t.body.pos, 0.25));
        }
      }
      // Flush them out of cover with a grenade.
      const d = distXZ(t.body.pos, this.body.pos);
      if (!this.targetVisible && this.lastSeen > 1 && this.lastSeen < 5 && d > 9 && d < 38 && this.frags > 0 && this.grenadeCd <= 0 && Math.random() < game.tuning.grenade * 0.5) {
        this.throwAt(game, 'frag', this.lastKnown);
      }
    }
  }

  private throwAt(game: Game, kind: 'frag' | 'smoke', at: Vector3) {
    const from = this.eye(tmpE).clone();
    const dist = distXZ(at, from);
    const flight = clamp(dist / 15, 0.6, 1.7);
    const target = tmpD.copy(at).setY(game.map.groundAt(at.x, at.z) + 0.3);
    const vel = Projectiles.aimArc(from, target, flight, new Vector3());
    applySpread(vel, 0.04 * this.skill);
    game.projectiles.throw(kind, from, vel, this);
    if (kind === 'frag') this.frags--;
    else this.smokes--;
    this.grenadeCd = 12 + Math.random() * 10;
  }

  /** Somewhere nearby, reachable, that a wall or hill hides from the threat. */
  private findCover(game: Game, threat: Combatant): Vector3 | null {
    const b = this.body, te = tmpE.set(threat.body.pos.x, threat.body.pos.y + 1.5, threat.body.pos.z);
    let best: Vector3 | null = null, bd = Infinity;
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2 + Math.random() * 0.4, r = 3 + Math.random() * 9;
      const x = b.pos.x + Math.cos(a) * r, z = b.pos.z + Math.sin(a) * r;
      if (!game.nav.walkableAt(x, z)) continue;
      const y = game.map.groundAt(x, z) + 1.0;
      const dir = tmpD.set(x - te.x, y - te.y, z - te.z);
      const dist = dir.length();
      dir.divideScalar(dist);
      if (game.world.raycast(te, dir, dist) > dist - 0.6) continue;
      const score = r + Math.max(0, 14 - dist) * 2;
      if (score < bd) {
        bd = score;
        best = new Vector3(x, 0, z);
      }
    }
    return best;
  }

  /** Moves the bot's crosshair the way a person's would. */
  private updateAim(dt: number, t: Combatant, dist: number) {
    const sk = this.skill * (isHuman(t) ? 1 : 1.4);
    if (this.aimTarget !== t) {
      // Just spotted them: the crosshair starts somewhere off to the side.
      this.aimTarget = t;
      const r = (0.7 + dist * 0.035) * sk * (0.85 + Math.random() * 0.3), a = Math.random() * Math.PI * 2;
      this.aimOff.set(Math.cos(a) * r, Math.sin(a) * r * 0.5, Math.sin(a + 1.3) * r);
      this.wobble.set(0, 0, 0);
    }
    // Settle in (a flick, then fine corrections)...
    this.aimOff.multiplyScalar(Math.exp((-1.7 / sk) * dt));
    // ...but a moving target drags the crosshair behind it, so strafing and jumping really help.
    this.aimOff.addScaledVector(t.body.vel, -dt * 0.4 * Math.sqrt(sk));
    // Hand wobble, bigger at range and while moving.
    const own = Math.hypot(this.body.vel.x, this.body.vel.z);
    const amp = (0.08 + dist * 0.007) * sk * (1 + own * 0.06), k = amp * 2 * Math.sqrt(dt);
    const n = () => Math.random() + Math.random() + Math.random() - 1.5;
    this.wobble.set(this.wobble.x * (1 - 2 * dt) + n() * k, this.wobble.y * (1 - 2 * dt) + n() * k * 0.6, this.wobble.z * (1 - 2 * dt) + n() * k);
  }

  private tryFire(dt: number, game: Game, t: Combatant, dist: number) {
    this.swapCd -= dt;
    this.pickGun(dist);
    const w = this.weapon;
    this.updateAim(dt, t, dist);
    if (this.reaction > 0 || this.reloadLeft > 0 || this.fireCd > 0 || dist > w.def.range * 0.9 || this.blind > 0) return;
    if (this.inGulag && game.gulagPrep > 0) return;
    // Like a player: turn to face them first, and don't open fire until the crosshair is roughly on.
    const face = Math.atan2(-(t.body.pos.x - this.body.pos.x), -(t.body.pos.z - this.body.pos.z));
    // Wrapped properly: yaw keeps counting past ±π as they turn, and % keeps the sign in JS.
    let dYaw = (face - this.yaw) % (Math.PI * 2);
    if (dYaw > Math.PI) dYaw -= Math.PI * 2;
    else if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const turn = Math.abs(dYaw);
    if (turn > 0.45) return;
    if (this.sprayIdx === 0 && this.aimOff.length() > 1 + dist * 0.012) return;
    if (w.mag <= 0) {
      this.reloadLeft = w.def.reload * 1.1;
      return;
    }
    const eye = this.eye(tmpE);
    const aimHead = Math.random() < 0.08 / this.skill;
    const aim = tmpB.set(t.body.pos.x, t.body.pos.y + t.body.height * (aimHead ? 0.88 : 0.6), t.body.pos.z).add(this.aimOff).add(this.wobble);
    // Spinbot: the hitbox jerks around, most shots go wide.
    const dir = aim.sub(eye).normalize();
    const muzzle = this.character.root.localToWorld(tmpM.set(0.22, 1.25, -0.9));
    if (w.def.projectile) game.projectiles.fireRocket(tmpD.copy(muzzle), applySpread(dir, adsSpreadOf(w) * 2 + 0.01), this, w);
    else for (let i = 0; i < w.def.pellets; i++) {
      const d = applySpread(tmpD.copy(dir), adsSpreadOf(w) * 1.5 + w.def.hipSpread * 0.15);
      game.fireShot(this, eye, d, w, muzzle);
    }
    w.mag--;
    const heard = eye.distanceTo(game.camera.position);
    game.sfx.shot(w.def.id, heard, eye);
    if (heard < 90 && this.team !== game.player.team && game.canTarget(this, game.player)) game.hud.soundPing(eye, 'shot', this);
    // Bursts make bots beatable: short strings of shots, then a pause.
    if (w.def.auto || w.def.burst) {
      if (this.burstLeft <= 0) this.burstLeft = w.def.burst ?? 3 + Math.floor(Math.random() * 5);
      this.burstLeft--;
      this.sprayIdx++;
      // Recoil climbs the crosshair; better players pull it down more (and the rest settles back).
      const kick = (0.04 + dist * 0.006) * (w.def.damage / 25) * Math.min(1, 0.35 * this.skill + 0.2);
      this.aimOff.y += kick;
      this.aimOff.x += (Math.random() - 0.5) * kick;
      this.fireCd = this.burstLeft > 0 ? (60 / w.def.rpm) * 1.15 : 0.35 + Math.random() * 0.5;
    } else {
      this.sprayIdx = 0;
      // Launchers: a beat between rockets, so there's time to dodge.
      this.fireCd = 60 / w.def.rpm + 0.2 + Math.random() * 0.35 + (w.def.projectile ? 1.1 : 0);
    }
    if (this.burstLeft <= 0) this.sprayIdx = 0;
    void dt;
  }

  private pickGoal(game: Game) {
    const b = this.body;
    this.goalTimer = 8 + Math.random() * 6;
    this.path = null;
    if (this.inGulag) {
      this.goal = game.map.gulag.clone();
      return;
    }
    if (game.arena) {
      // Hunt: head for an enemy (where they roughly are), else roam the arena.
      this.goalTimer = 4 + Math.random() * 4;
      const foes = game.combatants.filter((c) => c.alive && c.team !== this.team);
      const a = game.map.arena, h = game.map.arenaHalf;
      if (foes.length && Math.random() < 0.7) {
        const f = foes[Math.floor(Math.random() * foes.length)];
        this.goal = f.body.pos.clone().add(tmpC.set((Math.random() - 0.5) * 10, 0, (Math.random() - 0.5) * 10));
      } else this.goal = new Vector3(a.x + (Math.random() - 0.5) * h.x * 1.6, 0, a.z + (Math.random() - 0.5) * h.z * 1.6);
      return;
    }
    // Stick with the squad leader.
    const lead = this.squad.find((m) => m.alive && game.inWorld(m));
    if (lead && lead !== this && distXZ(lead.body.pos, b.pos) > 16) {
      const a = this.id * 2.1;
      this.goal = lead.body.pos.clone().add(tmpC.set(Math.cos(a) * 5, 0, Math.sin(a) * 5));
      this.goalTimer = 2.5;
      return;
    }
    // Zone first — and grab a car if it's a long way.
    if (game.zone.outsideSafe(b.pos.x, b.pos.z, 15) || game.zone.closingOn(b.pos.x, b.pos.z, 20)) {
      this.goal = game.zone.randomSafePoint(0.5);
      if (distXZ(this.goal, b.pos) > 160 && !this.target) {
        let bestV: Vehicle | null = null, bd = 40;
        for (const v of game.vehicles) {
          if (!v.alive || v.hasDriver) continue;
          const d = distXZ(v.body.pos, b.pos);
          if (d < bd) {
            bd = d;
            bestV = v;
          }
        }
        this.wantVehicle = bestV;
      }
      return;
    }
    // Supply drops are worth a detour; unopened chests nearby too.
    let bestChest = null, bcd = Infinity;
    for (const c of game.loot.chests) {
      if (c.opened || !c.landed) continue;
      const d = Math.hypot(c.pos.x - b.pos.x, c.pos.z - b.pos.z);
      const limit = c.supply ? 170 : 35;
      if (d < limit && d < bcd && !game.zone.outsideSafe(c.pos.x, c.pos.z, 5)) {
        bcd = d;
        bestChest = c;
      }
    }
    if (bestChest && Math.random() < 0.7) {
      this.goal = bestChest.pos.clone();
      return;
    }
    const want = game.loot.nearest(b.pos, 45, (it) =>
      (it.kind.type === 'weapon' && weaponScore(it.kind.weapon) > this.worstScore() && it.kind.weapon.def.id !== this.weapon.def.id) ||
      (it.kind.type === 'plate' && this.armor < 100));
    if (want) {
      this.goal = want.pos.clone();
      return;
    }
    // Wander within the safe area, drifting toward the next circle.
    const a = Math.random() * Math.PI * 2, r = 20 + Math.random() * 50;
    const g = new Vector3(b.pos.x + Math.cos(a) * r, 0, b.pos.z + Math.sin(a) * r);
    if (game.zone.outsideSafe(g.x, g.z, 10)) this.goal = game.zone.randomSafePoint(0.7);
    else this.goal = g;
  }

  private tryPickup(game: Game) {
    const chest = game.loot.nearestChest(this.body.pos, 1.8);
    if (chest) {
      game.loot.openChest(chest);
      if (chest.pos.distanceTo(game.camera.position) < 30) game.sfx.chestOpen();
      this.goalTimer = 0;
      return;
    }
    const it = game.loot.nearest(this.body.pos, 1.4);
    if (!it) return;
    const k = it.kind;
    if (k.type === 'weapon' && weaponScore(k.weapon) > this.worstScore() && k.weapon.def.id !== this.weapon.def.id) {
      this.takeGun(k.weapon);
      game.loot.remove(it);
      this.goalTimer = 0;
    } else if (k.type === 'plate' && this.armor < 100) {
      this.armor = Math.min(100, this.armor + 50 * k.count);
      game.loot.remove(it);
    } else if (k.type === 'medkit' && (this.health < 100 || this.heals < 3)) {
      if (this.health < 100) this.health = Math.min(100, this.health + 60);
      else this.heals += k.count;
      game.loot.remove(it);
    } else if (k.type === 'throwable' && k.t !== 'flash' && this.frags + this.smokes < 3) {
      if (k.t === 'frag') this.frags += k.count;
      else this.smokes += k.count;
      game.loot.remove(it);
    }
  }

  // ---------- driving ----------

  private enterVehicle(v: Vehicle, game: Game) {
    this.vehicle = v;
    this.wantVehicle = null;
    v.hasDriver = true;
    v.driver = this;
    this.mode = 'vehicle';
    this.driveStuck = 0;
    if (v.body.pos.distanceTo(game.camera.position) < 40) game.sfx.carDoor();
  }

  exitVehicle(game: Game) {
    const v = this.vehicle;
    if (!v) return;
    v.hasDriver = false;
    v.driver = null;
    this.keys.keys.clear();
    this.vehicle = null;
    this.mode = 'ground';
    const r = v.right(tmpC);
    this.body.pos.set(v.body.pos.x - r.x * (v.spec.width / 2 + 0.9), Math.max(v.body.pos.y, game.map.groundAt(v.body.pos.x, v.body.pos.z)) + 0.2, v.body.pos.z - r.z * (v.spec.width / 2 + 0.9));
    this.body.vel.set(0, 0, 0);
    this.goal = null;
  }

  /** Called by the game after the vehicle has moved: sit in it, decide the keys for next step. */
  private updateVehicle(dt: number, game: Game) {
    const v = this.vehicle!;
    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer = 0.3;
      this.think(game);
    }
    this.body.pos.copy(v.body.pos).y += 0.35;
    this.body.vel.copy(v.body.vel);
    this.yaw = v.yaw;
    if (!v.alive) return this.exitVehicle(game);
    // Ram a visible enemy that's close; otherwise drive to the goal.
    let dest = this.goal ?? game.zone.safeCenter3();
    let ramming = false;
    const t = this.target;
    if (t && t.alive && this.targetVisible) {
      const d = distXZ(t.body.pos, this.body.pos);
      if (d < 55 && this.ram) {
        dest = t.body.pos;
        ramming = true;
      } else if (d < 30) return this.exitVehicle(game);
    }
    const dx = dest.x - v.body.pos.x, dz = dest.z - v.body.pos.z, dist = Math.hypot(dx, dz);
    if (!ramming && dist < 30) return this.exitVehicle(game);
    const f = v.forward(tmpD);
    const ang = Math.atan2(f.x * dz - f.z * dx, f.x * dx + f.z * dz);
    const k = this.keys.keys;
    k.clear();
    const speed = Math.hypot(v.body.vel.x, v.body.vel.z);
    this.driveStuck = speed < 1.5 ? this.driveStuck + dt : 0;
    if (this.driveStuck > 3) {
      // Back up and turn, then try again.
      k.add('KeyS');
      k.add(ang > 0 ? 'KeyD' : 'KeyA');
      if (this.driveStuck > 4.2) this.driveStuck = 0;
      if (this.driveStuck > 3 && Math.random() < 0.01) return this.exitVehicle(game);
      return;
    }
    if (Math.abs(ang) > 2.4 && speed < 6) k.add('KeyS');
    else k.add('KeyW');
    if (ang < -0.08) k.add('KeyA');
    else if (ang > 0.08) k.add('KeyD');
    if (Math.abs(ang) < 0.3 && dist > 80) k.add('ShiftLeft');
  }

  // ---------- visuals ----------

  private animate(dt: number, game: Game) {
    const b = this.body, root = this.character.root;
    root.position.copy(b.pos);
    if (this.mode === 'vehicle') root.position.y -= 0.55;
    // (A car hit launches us upright: no cartwheels.)
    root.rotation.order = 'YXZ';
    root.rotation.set(0, this.yaw, 0);
    if (b.pos.distanceToSquared(game.camera.position) > 250 * 250) return;
    this.character.animate(dt, Math.hypot(b.vel.x, b.vel.z), b.onGround, this.crouch, this.mode === 'vehicle');
  }

  die(game: Game) {
    this.alive = false;
    if (this.vehicle) this.exitVehicle(game);
    if (!this.mesh.parent || !this.mesh.visible || this.mode === 'plane') {
      game.scene.remove(this.mesh);
      return;
    }
    // Death: knocked down away from the shot (or keep flying from a car), lie there, then sink away.
    this.deathT = 0;
    this.glider.visible = false;
    this.character.setGun(null);
    const h = this.lastHitDir, fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw), rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const along = h.x * fx + h.z * fz, side = h.x * rx + h.z * rz, n = Math.hypot(along, side) || 1;
    // Pushed from behind: fall on your face; from the front: on your back; from the side: sideways.
    // Lie along the ground, not into it: on a slope the fall stops short (uphill) or goes further (downhill).
    let ang = 1.5;
    const pos = this.body.pos, g0 = game.map.groundAt(pos.x, pos.z), hl0 = Math.hypot(h.x, h.z) || 1;
    if (Math.abs(pos.y - g0) < 0.6) {
      const dh = game.map.groundAt(pos.x + (h.x / hl0) * 1.7, pos.z + (h.z / hl0) * 1.7) - g0;
      ang = clamp(Math.PI / 2 - Math.atan2(dh, 1.7), 0.6, 2.0);
    }
    this.fallX = (-along / n) * ang;
    this.fallZ = (-side / n) * ang;
    if (this.knock <= 0 && this.body.vel.y < 4) {
      const hl = Math.hypot(h.x, h.z) || 1;
      this.body.vel.set((h.x / hl) * 2.4, 2.6, (h.z / hl) * 2.4);
      this.body.onGround = false;
    }
    this.body.height = P.crouchHeight;
  }

  private updateDeath(dt: number, game: Game) {
    const b = this.body, root = this.character.root;
    this.deathT += dt;
    const t = this.deathT;
    if (!b.onGround || b.vel.lengthSq() > 0.01) {
      b.vel.y -= P.gravity * dt;
      if (b.onGround) {
        b.vel.x = damp(b.vel.x, 0, 6, dt);
        b.vel.z = damp(b.vel.z, 0, 6, dt);
      }
      moveBody(game.world, b, dt, 0.2);
    }
    // Topple over (easing in like a real fall, with a small bounce as the body hits the ground).
    const k = Math.min(1, t / 0.55), fall = k * k + (k >= 1 ? Math.sin(Math.min(1, (t - 0.55) / 0.25) * Math.PI) * -0.06 : 0);
    root.rotation.order = 'YXZ';
    root.rotation.set(this.fallX * fall, this.yaw, this.fallZ * fall);
    const legs = this.character.legsList;
    legs[0].rotation.x = damp(legs[0].rotation.x, 0.35, 6, dt);
    legs[1].rotation.x = damp(legs[1].rotation.x, -0.15, 6, dt);
    root.position.copy(b.pos);
    root.position.y += Math.min(1, fall) * 0.12;
    if (t > 3.5) root.position.y -= (t - 3.5) * 0.7;
    if (t > 5) {
      this.deathT = -1;
      game.scene.remove(this.mesh);
    }
  }

  /** Brings a dead bot back (gulag opponents, practice dummies). */
  revive(game: Game, at: Vector3) {
    this.alive = true;
    this.backup = null;
    this.health = 100;
    this.armor = 0;
    this.mode = 'ground';
    this.target = null;
    this.cover = null;
    this.path = null;
    this.blind = 0;
    this.heals = 2;
    this.stuckLong = 0;
    this.goal = null;
    this.mantle = null;
    this.unstick = 0;
    this.reloadLeft = 0;
    this.healLeft = 0;
    this.burstLeft = 0;
    this.sprayIdx = 0;
    this.aimTarget = null;
    this.wantVehicle = null;
    this.crouch = false;
    this.body.pos.copy(at);
    this.lastPos.copy(at);
    this.body.vel.set(0, 0, 0);
    this.mesh.visible = true;
    this.deathT = -1;
    this.knock = 0;
    this.body.height = P.standHeight;
    this.mesh.rotation.set(0, this.yaw, 0);
    this.character.setGun(this.weapon);
    game.scene.add(this.mesh);
  }
}

const nearby: Combatant[] = [];

function turnToward(cur: number, target: number, maxStep: number) {
  let d = target - cur;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return cur + Math.max(-maxStep, Math.min(maxStep, d));
}

function distXZ(a: Vector3, b: Vector3) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

const ZIP_SPEED = 17;
const tmpA = new Vector3(), tmpB = new Vector3(), tmpC = new Vector3(), tmpE = new Vector3(), tmpD = new Vector3(), tmpM = new Vector3();
