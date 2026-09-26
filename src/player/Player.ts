import { Vector3 } from 'three';
import { CONFIG } from '../config';
import { moveBody, type Body, type CollisionWorld } from '../core/Collision';
import type { Input } from '../core/Input';
import { clamp, damp } from '../core/rng';
import type { Combatant } from '../game/Combat';
import { makeWeapon, type AmmoType, type ThrowKind, type WeaponInstance } from '../weapons/Weapon';
import type { ZipLine, Ziplines } from '../world/Interactive';
import { planMantle, stepMantle, type Mantle } from './Movement';

export type MoveMode = 'plane' | 'freefall' | 'glide' | 'ground' | 'vehicle' | 'zipline';

/** Water surface height (rivers, lakes and the sea). */
export const WATER_Y = -0.5;
const ZIP_SPEED = 17;
/** How fast the grappling hook reels you in (m/s). */
const GRAPPLE_SPEED = 30;

const P = CONFIG.player;
const D = CONFIG.drop;
/** Running with nothing in your hands is this much faster. */
const HANDS_SPEED = 1.15;
/** Metres you can drop without getting hurt. */
const SAFE_FALL = 7;

export class Player implements Combatant {
  readonly id = 0;
  readonly name = 'You';
  readonly isPlayer = true;
  team = 0;
  body: Body = { pos: new Vector3(), vel: new Vector3(), radius: P.radius, height: P.standHeight, onGround: false };
  alive = true;
  health = P.maxHealth;
  armor = 0;
  kills = 0;
  plates = 0;
  medkits = 0;
  ammo: Record<AmmoType, number> = { light: 24, heavy: 0, shells: 0, sniper: 0, rocket: 0 };
  slots: (WeaponInstance | null)[] = [makeWeapon('pistol'), null];
  active = 0;
  throwables: Record<ThrowKind, number> = { frag: 0, smoke: 0, flash: 0, grapple: 0 };
  /** Hooked on something with the grappling hook: where, and how long we've been reeled in. */
  grapple: { at: Vector3; t: number } | null = null;
  /** Found a grappling hook: its charges (throwables.grapple, max 3) come back one every HOOK_RECHARGE s. */
  hookOwned = false;
  hookCharge = 0;
  throwSel: ThrowKind = 'frag';
  swimming = false;
  mantle: Mantle | null = null;
  zip: { line: ZipLine; t: number; dir: 1 | -1 } | null = null;
  /** Set by the game so E can grab a zipline. */
  zips: Ziplines | null = null;
  /** One-shot sound cues for the game to play this step. */
  cues: ('mantle' | 'zip' | 'splash' | 'stroke')[] = [];
  /** Seconds in the air on foot; the glider can't open in the first moments of a jump. */
  private airTime = 0;
  /** Real drop to whatever is below (floors and roofs count, not just the terrain). */
  drop = 0;
  /** Knocked flying (hit by a car): no fall damage on this landing. */
  flung = false;
  private strokeT = 0;
  /** The E press that grabbed the cable must not also let go of it. */
  private zipGrace = 0;

  mode: MoveMode = 'plane';
  yaw = 0;
  pitch = -0.2;
  eyeHeight = P.eyeStand;
  crouching = false;
  /** Option: crouch toggles instead of being held. */
  toggleCrouch = false;
  private crouchLatched = false;
  sliding = false;
  sprinting = false;
  ads = false;
  private slideCooldown = 0;
  /** Seconds since the slide started; used for camera effects and sound. */
  slideTime = 0;
  justLanded = false;
  /** Height above the ground below (used for auto-deploy and the HUD). */
  altitude = 0;
  /** Sprint whenever moving forward (option). */
  autoSprint = false;
  /** Seconds left before you can sprint again (shooting knocks you out of a sprint). */
  sprintLock = 0;
  /** Health still to come back after a kill, trickled in over a few seconds. */
  killHeal = 0;
  /** Thrown by a launch pad: the glider opens automatically on the way down. */
  launched = false;
  inWater = false;
  lastAttacker: Combatant | null = null;
  damageEvents: { from: Vector3 | null; amount: number }[] = [];
  /** Held in place (Gulag countdown): can look around but not move or shoot. */
  frozen = false;
  /** Hands out (key 3): nothing to shoot with, but you run a lot faster. */
  unarmed = false;
  /** Set on a hard landing; the game applies it. */
  fallDamage = 0;

  get weapon() {
    return this.unarmed ? null : this.slots[this.active];
  }

  onDamaged(attacker: Combatant | null, amount: number) {
    if (attacker) this.lastAttacker = attacker;
    this.damageEvents.push({ from: attacker ? attacker.body.pos.clone() : null, amount });
  }

  look(dx: number, dy: number, sensMult: number) {
    const s = CONFIG.mouseSensitivity * sensMult;
    this.yaw -= dx * s;
    this.pitch = clamp(this.pitch - dy * s, -1.55, 1.55);
  }

  forward(out: Vector3) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  private freefallTime = 0;

  jumpFromPlane(planeVel: Vector3) {
    this.freefallTime = 0;
    this.mode = 'freefall';
    this.body.vel.copy(planeVel).multiplyScalar(0.3);
  }

  update(dt: number, input: Input, world: CollisionWorld) {
    this.justLanded = false;
    switch (this.mode) {
      case 'plane': return;
      case 'freefall': return this.updateFreefall(dt, input, world);
      case 'glide': return this.updateGlide(dt, input, world);
      case 'ground': return this.updateGround(dt, input, world);
      case 'vehicle': return;
      case 'zipline': return this.updateZip(dt, input, world);
    }
  }

  private wishDir(input: Input, out: Vector3) {
    const f = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
    const s = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    out.set(-sy * f + cy * s, 0, -cy * f - sy * s);
    if (out.lengthSq() > 0) out.normalize();
    return out;
  }

  /** Freefall out of the plane: hold W and look down to dive, Space opens the glider (it opens by itself low down). */
  private updateFreefall(dt: number, input: Input, world: CollisionWorld) {
    const wish = this.wishDir(input, tmp);
    const dive = input.isDown('KeyW') ? clamp(-this.pitch / 1.2, 0, 1) : 0;
    const hSpeed = wish.lengthSq() > 0 ? D.freefallHorizontal * (1 - 0.5 * dive) : 3;
    const v = this.body.vel;
    v.x = damp(v.x, wish.x * hSpeed, 3, dt);
    v.z = damp(v.z, wish.z * hSpeed, 3, dt);
    v.y = damp(v.y, -(D.freefallSpeed + (D.diveSpeed - D.freefallSpeed) * dive), 3, dt);
    this.body.height = P.standHeight;
    moveBody(world, this.body, dt, 0);
    const alt = (this.altitude = this.body.pos.y - world.groundAt(this.body.pos.x, this.body.pos.z));
    this.freefallTime += dt;
    if (alt < D.deployAltitude || (input.pressed('Space') && this.freefallTime > 0.3)) this.mode = 'glide';
    if (this.body.onGround) this.land();
  }

  private glideTime = 0;

  /** Falling from high up (cliffs, towers, ziplines, launch pads): Space opens the glider. */
  get canRedeploy() {
    return this.mode === 'ground' && !this.body.onGround && this.drop > 6 && this.airTime > 0.3 && this.body.vel.y < 2 && !this.grapple
      && !this.swimming && !this.mantle && !this.frozen;
  }

  private updateGlide(dt: number, input: Input, world: CollisionWorld) {
    // Space folds the glider up again to drop faster; open it again before you land.
    if (input.pressed('Space') && this.glideTime > 0.25) {
      this.mode = 'ground';
      this.glideTime = 0;
      return;
    }
    this.glideTime += dt;
    const wish = this.wishDir(input, tmp);
    const v = this.body.vel;
    v.x = damp(v.x, wish.x * D.glideHorizontal, 4, dt);
    v.z = damp(v.z, wish.z * D.glideHorizontal, 4, dt);
    v.y = damp(v.y, -D.glideFall, 4, dt);
    moveBody(world, this.body, dt, P.stepHeight);
    this.altitude = this.body.pos.y - world.groundAt(this.body.pos.x, this.body.pos.z);
    if (this.body.onGround) this.land();
  }

  startGrapple(at: Vector3) {
    if (this.mode !== 'ground') return;
    this.grapple = { at: at.clone(), t: 0 };
    this.sliding = this.crouching = false;
    this.body.onGround = false;
    this.body.pos.y += 0.05;
    this.cues.push('zip');
  }

  /** Launch pad: straight up with a forward shove. */
  launch() {
    const f = this.forward(tmp);
    this.body.vel.set(this.body.vel.x * 0.5 + f.x * 8, 26, this.body.vel.z * 0.5 + f.z * 8);
    this.body.onGround = false;
    this.body.pos.y += 0.1;
    this.sliding = false;
    this.launched = true;
  }

  private land() {
    this.mode = 'ground';
    this.glideTime = 0;
    this.body.vel.y = 0;
    this.justLanded = true;
  }

  /** Grab the nearest zipline cable within reach, riding in the direction you're looking. */
  tryZip() {
    if (!this.zips || this.mode !== 'ground') return false;
    const eye = tmp2.set(this.body.pos.x, this.body.pos.y + 1.9, this.body.pos.z);
    const hit = this.zips.nearest(eye, 2.4);
    if (!hit) return false;
    const f = this.forward(tmp);
    let dir: 1 | -1 = f.x * hit.line.dir.x + f.z * hit.line.dir.z >= 0 ? 1 : -1;
    if ((dir === 1 && hit.t > 0.97) || (dir === -1 && hit.t < 0.03)) dir = dir === 1 ? -1 : 1;
    this.zip = { line: hit.line, t: hit.t, dir };
    this.mode = 'zipline';
    this.sliding = this.crouching = this.sprinting = false;
    this.body.height = P.standHeight;
    this.cues.push('zip');
    this.zipGrace = 0.25;
    return true;
  }

  detachZip(jump: boolean) {
    const z = this.zip;
    this.zip = null;
    this.mode = 'ground';
    this.body.onGround = false;
    if (z) {
      const v = this.body.vel.copy(z.line.dir).multiplyScalar(ZIP_SPEED * z.dir * 0.7);
      v.y = jump ? P.jumpVelocity * 0.8 : Math.min(v.y, 0);
    }
  }

  private updateZip(dt: number, input: Input, world: CollisionWorld) {
    const z = this.zip;
    if (!z) return void (this.mode = 'ground');
    this.zipGrace -= dt;
    if (this.zipGrace <= 0 && (input.pressed('Space') || input.pressed('KeyE') || input.pressed('KeyC'))) return this.detachZip(input.pressed('Space'));
    z.t += (z.dir * ZIP_SPEED * dt) / z.line.len;
    const cable = tmp2.copy(z.line.a).addScaledVector(z.line.dir, Math.max(0, Math.min(1, z.t)) * z.line.len);
    const next = tmp.set(cable.x, cable.y - 2.05, cable.z);
    this.body.vel.subVectors(next, this.body.pos).divideScalar(Math.max(dt, 1e-4));
    this.body.pos.copy(next);
    // End of the line, or about to hit something: let go.
    const b = this.body, r = b.radius;
    if (z.t <= 0 || z.t >= 1 || world.anyOverlap(b.pos.x - r, b.pos.y + 0.3, b.pos.z - r, b.pos.x + r, b.pos.y + b.height, b.pos.z + r)) {
      if (z.t > 0 && z.t < 1) b.pos.addScaledVector(z.line.dir, -z.dir * 0.5);
      const top = z.t <= 0 && z.dir < 0 && z.line.push;
      this.detachZip(false);
      if (top) {
        b.vel.set(top[0] * 6, 5, top[1] * 6);
        this.flung = true;
      }
    }
    this.eyeHeight = damp(this.eyeHeight, P.eyeStand, 14, dt);
    this.altitude = b.pos.y - world.groundAt(b.pos.x, b.pos.z);
  }

  private updateGround(dt: number, input: Input, world: CollisionWorld) {
    const b = this.body, v = b.vel;
    // Mantling takes over movement until the climb is done.
    if (this.mantle) {
      if (stepMantle(this.mantle, dt, b.pos)) {
        this.mantle = null;
        b.vel.set(0, 0, 0);
        b.onGround = true;
      }
      return;
    }
    // Grappling hook: reeled in toward the hook until we arrive, bump into something or let go (Space).
    if (this.grapple) {
      const g = this.grapple;
      g.t += dt;
      const to = tmp.set(g.at.x - b.pos.x, g.at.y - (b.pos.y + 1.0), g.at.z - b.pos.z);
      const d = to.length();
      if (d < 2.2 || g.t > 2.4 || (g.t > 0.15 && input.pressed('Space')) || (g.t > 0.3 && v.length() < 3)) {
        this.grapple = null;
        v.y = Math.max(v.y, 5.5); // pop up at the end so you can land on (or mantle onto) what you hooked
        this.flung = true;
      } else {
        to.divideScalar(d);
        const sag = -3.2 * Math.sin(Math.min(1, g.t / 0.9) * Math.PI);
        v.x = damp(v.x, to.x * GRAPPLE_SPEED, 6, dt);
        v.y = damp(v.y, to.y * GRAPPLE_SPEED + 1.5 + sag, 6, dt);
        v.z = damp(v.z, to.z * GRAPPLE_SPEED, 6, dt);
        const steer = this.wishDir(input, tmp2);
        v.x += steer.x * 55 * dt;
        v.z += steer.z * 55 * dt;
        b.height = P.standHeight;
        moveBody(world, b, dt, P.stepHeight);
        this.airTime += dt;
        this.altitude = b.pos.y - world.groundAt(b.pos.x, b.pos.z);
        this.eyeHeight = damp(this.eyeHeight, P.eyeStand, 14, dt);
        return;
      }
    }
    const groundY = world.groundAt(b.pos.x, b.pos.z);
    const wasSwimming = this.swimming;
    this.swimming = groundY < WATER_Y - 1.3 && b.pos.y < WATER_Y - 1.2;
    if (this.swimming && !wasSwimming) {
      this.sliding = false;
      if (v.y < -4) this.cues.push('splash');
    }
    if (this.swimming) return this.updateSwim(dt, input, world);
    const wish = this.wishDir(input, tmp);
    const fwdInput = input.isDown('KeyW') && !input.isDown('KeyS');
    const hSpeed = Math.hypot(v.x, v.z);
    const crouchPressed = input.pressed('KeyC') || input.pressed('ControlLeft');
    // Toggle crouch: one press to crouch, another (or a jump / sprint) to stand.
    if (this.toggleCrouch) {
      if (crouchPressed) this.crouchLatched = !this.crouchLatched;
      if (input.pressed('Space') || input.pressed('ShiftLeft')) this.crouchLatched = false;
    } else this.crouchLatched = false;
    const crouchHeld = input.isDown('KeyC') || input.isDown('ControlLeft') || this.crouchLatched;
    this.slideCooldown -= dt;

    // Start slide: crouch while moving fast on the ground.
    if (b.onGround && !this.sliding && crouchPressed && hSpeed > P.walkSpeed * 0.85) {
      this.sliding = true;
      this.slideTime = 0;
      const boost = this.slideCooldown <= 0 ? P.slideBoost : 0.5;
      const ns = Math.min(Math.max(hSpeed + boost, hSpeed), P.slideMaxSpeed);
      v.x *= ns / hSpeed;
      v.z *= ns / hSpeed;
      this.slideCooldown = P.slideCooldown;
    }

    if (this.sliding) {
      this.slideTime += dt;
      if (!crouchHeld) this.sliding = false;
      else if (b.onGround) {
        const s = Math.hypot(v.x, v.z);
        const ns = Math.max(0, s - P.slideFriction * dt);
        // Gentle steering toward input
        if (wish.lengthSq() > 0 && s > 0.1) {
          const cur = Math.atan2(v.x, v.z), want = Math.atan2(wish.x, wish.z);
          let da = want - cur;
          while (da > Math.PI) da -= Math.PI * 2;
          while (da < -Math.PI) da += Math.PI * 2;
          const a = cur + clamp(da, -P.slideSteer * dt, P.slideSteer * dt);
          v.x = Math.sin(a) * ns;
          v.z = Math.cos(a) * ns;
        } else if (s > 0) {
          v.x *= ns / s;
          v.z *= ns / s;
        }
        // Slopes: gravity pulls you along, so sliding downhill builds speed instead of losing it.
        const gx = (world.groundAt(b.pos.x + 1, b.pos.z) - world.groundAt(b.pos.x - 1, b.pos.z)) / 2;
        const gz = (world.groundAt(b.pos.x, b.pos.z + 1) - world.groundAt(b.pos.x, b.pos.z - 1)) / 2;
        const onTerrain = b.pos.y - world.groundAt(b.pos.x, b.pos.z) < 0.4;
        let downhill = false;
        if (onTerrain && gx * gx + gz * gz > 0.004) {
          const along = -(v.x * gx + v.z * gz) / (Math.hypot(v.x, v.z) || 1);
          downhill = along > 0.05;
          // Friction is already applied above; on the way down most of it is given back.
          const back = downhill ? P.slideFriction * 0.85 * dt : 0;
          v.x += -gx * P.gravity * 1.15 * dt;
          v.z += -gz * P.gravity * 1.15 * dt;
          const s2 = Math.hypot(v.x, v.z);
          if (s2 > 0.01) {
            const want = Math.min(s2 + back, Math.max(P.slideDownhillMax, ns));
            v.x *= want / s2;
            v.z *= want / s2;
          }
        }
        if (Math.hypot(v.x, v.z) < P.slideEndSpeed && !downhill) this.sliding = false;
      }
    }

    // Crouch state (can't stand up under a ceiling)
    const wantCrouch = crouchHeld || this.sliding;
    if (wantCrouch) this.crouching = true;
    else if (this.crouching) {
      const p = b.pos, r = b.radius;
      if (!world.anyOverlap(p.x - r, p.y + P.crouchHeight, p.z - r, p.x + r, p.y + P.standHeight, p.z + r)) this.crouching = false;
    }
    b.height = this.crouching ? P.crouchHeight : P.standHeight;

    this.inWater = world.groundAt(b.pos.x, b.pos.z) < -0.3 && b.pos.y < -0.2;
    this.sprintLock -= dt;
    this.sprinting = fwdInput && (input.isDown('ShiftLeft') || this.autoSprint) && !this.crouching && !this.ads && b.onGround && !this.inWater && this.sprintLock <= 0;

    if (!this.sliding) {
      let target = P.walkSpeed;
      if (this.crouching) target = P.crouchSpeed;
      else if (this.ads) target = P.adsSpeed;
      else if (this.sprinting) target = P.sprintSpeed;
      if (this.unarmed && !this.crouching) target *= HANDS_SPEED;
      if (this.inWater) target *= 0.55;

      if (b.onGround) {
        const tx = wish.x * target, tz = wish.z * target;
        const dx = tx - v.x, dz = tz - v.z;
        const dl = Math.hypot(dx, dz);
        let rate = P.groundAccel;
        let carried = false;
        if (wish.lengthSq() === 0) rate = P.stopDecel;
        else if (hSpeed > target + 0.2) {
          // Keep slide-jump momentum briefly, but only while you keep pushing the same way:
          // turning or pulling back stops you quickly instead of skating on.
          const wl = Math.hypot(wish.x, wish.z) || 1, wx = wish.x / wl, wz = wish.z / wl;
          const par = v.x * wx + v.z * wz;
          if (par / (hSpeed || 1) > 0.7) {
            // Only the part going where you push carries on; the sideways drift dies fast,
            // so W after a slide runs straight instead of drifting diagonally.
            let px = v.x - wx * par, pz = v.z - wz * par;
            const pl = Math.hypot(px, pz), pk = pl > 0 ? Math.max(0, pl - P.groundAccel * dt) / pl : 0;
            px *= pk;
            pz *= pk;
            const np = Math.max(target * wl, par - P.momentumDecel * dt);
            v.x = wx * np + px;
            v.z = wz * np + pz;
            carried = true;
          }
        }
        const step = carried ? 0 : Math.min(dl, rate * dt);
        if (dl > 0 && step > 0) {
          v.x += (dx / dl) * step;
          v.z += (dz / dl) * step;
        }
      } else {
        // Air strafing: steer freely, and build up to near sprint speed, but never past the speed you took off with.
        const cap = Math.max(hSpeed, P.sprintSpeed * 0.9);
        v.x += wish.x * P.airAccel * dt;
        v.z += wish.z * P.airAccel * dt;
        const ns = Math.hypot(v.x, v.z);
        if (ns > cap) {
          v.x *= cap / ns;
          v.z *= cap / ns;
        }
      }
    }

    // Space near a ledge climbs it (on the ground, or in the air on the way up). Pushing forward into a
    // ledge (walking into it, or in the air after a jump) climbs it by itself.
    const autoMantle = fwdInput && !this.sliding && (b.onGround ? hSpeed < 1.2 : v.y > -8 && this.airTime > 0.05);
    const spaceMantle = input.pressed('Space') && !this.sliding && (b.onGround || v.y > -3);
    if (spaceMantle || autoMantle) {
      const f = this.forward(tmp2);
      const m = planMantle(world, b.pos, f.x, f.z, b.radius, P.standHeight);
      if (m && (spaceMantle ? m.to.y - b.pos.y > 0.7 || !b.onGround : m.to.y - b.pos.y > 0.6)) {
        this.mantle = m;
        this.crouching = false;
        b.height = P.standHeight;
        this.cues.push('mantle');
        return;
      }
    }
    let spaceUsed = false;
    if (input.pressed('Space') && b.onGround) {
      v.y = P.jumpVelocity;
      spaceUsed = true;
      if (this.sliding) {
        this.sliding = false; // slide-jump keeps all its speed, plus a little kick
        const hs = Math.hypot(v.x, v.z), ns = Math.min(hs * 1.08, P.slideMaxSpeed + 2);
        if (hs > 0.1) {
          v.x *= ns / hs;
          v.z *= ns / hs;
        }
      }
    }

    v.y -= P.gravity * dt;
    const wasAir = !b.onGround;
    const fallSpeed = -v.y;
    moveBody(world, b, dt, P.stepHeight);
    if (wasAir && b.onGround && fallSpeed > 6) {
      this.justLanded = true;
      // Fall damage (health only). A short drop is free; a big one without the glider can kill.
      const height = (fallSpeed * fallSpeed) / (2 * P.gravity);
      if (height > SAFE_FALL && !this.inWater && !this.flung) this.fallDamage = Math.round((height - SAFE_FALL) * 3.5);
    }

    this.altitude = b.pos.y - world.groundAt(b.pos.x, b.pos.z);
    if (b.onGround) {
      this.launched = this.flung = false;
      this.airTime = 0;
      this.drop = 0;
    } else {
      this.airTime += dt;
      // How far down is the first thing below us (a floor inside a building counts)?
      const r = world.raycast(tmp2.set(b.pos.x, b.pos.y + 0.1, b.pos.z), DOWN, Math.max(0.2, this.altitude + 0.2));
      this.drop = Math.min(this.altitude, r - 0.1);
    }
    if (!b.onGround && this.launched && (v.y < 0 || input.pressed('Space')) && this.drop > 5) {
      this.launched = false;
      this.mode = 'glide';
    } else if (!spaceUsed && this.canRedeploy && input.pressed('Space')) this.mode = 'glide';

    const eyeTarget = this.sliding ? P.eyeSlide : this.crouching ? P.eyeCrouch : P.eyeStand;
    this.eyeHeight = damp(this.eyeHeight, eyeTarget, 14, dt);
  }

  private updateSwim(dt: number, input: Input, world: CollisionWorld) {
    const b = this.body, v = b.vel;
    const wish = this.wishDir(input, tmp);
    const speed = input.isDown('ShiftLeft') ? 5.2 : 3.6;
    v.x = damp(v.x, wish.x * speed, 4, dt);
    v.z = damp(v.z, wish.z * speed, 4, dt);
    // Float with the head above the surface.
    v.y = damp(v.y, (WATER_Y - 1.45 - b.pos.y) * 4, 5, dt);
    this.crouching = this.sprinting = this.sliding = false;
    b.height = P.standHeight;
    moveBody(world, b, dt, P.stepHeight);
    b.onGround = false;
    // Climb out onto a bank / pier with Space.
    if (input.pressed('Space')) {
      const f = this.forward(tmp2);
      const m = planMantle(world, b.pos, f.x, f.z, b.radius, P.standHeight);
      if (m) {
        this.mantle = m;
        this.swimming = false;
        this.cues.push('mantle');
      } else v.y = 3;
    }
    if (wish.lengthSq() > 0) {
      this.strokeT -= dt;
      if (this.strokeT <= 0) {
        this.strokeT = 0.9;
        this.cues.push('stroke');
      }
    }
    this.inWater = true;
    this.altitude = 0;
    this.eyeHeight = damp(this.eyeHeight, P.eyeStand, 8, dt);
  }

  addAmmo(type: AmmoType, amount: number, max: number) {
    const before = this.ammo[type];
    this.ammo[type] = Math.min(max, before + amount);
    return this.ammo[type] - before;
  }
}

const tmp = new Vector3(), tmp2 = new Vector3(), DOWN = new Vector3(0, -1, 0);
