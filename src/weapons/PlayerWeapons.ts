import { BufferGeometry, CylinderGeometry, Line, LineDashedMaterial, Mesh, MeshLambertMaterial, PerspectiveCamera, Vector3 } from 'three';
import { CONFIG } from '../config';
import type { Input } from '../core/Input';
import { clamp, damp, lerp } from '../core/rng';
import { applySpread } from '../game/Combat';
import type { Game } from '../game/Game';
import type { Player } from '../player/Player';
import { ViewModel, type ReloadAnim } from './ViewModel';
import { adsSpreadOf, magSize, recoilKick, THROWABLES, type ThrowKind, type WeaponInstance, FISTS } from './Weapon';

const P = CONFIG.player;
const SHELL_TIME = 0.45, SHELL_START = 0.3, SHELL_END = 0.4;
/** Pause between bursts of the burst rifle. */
const BURST_GAP = 0.26;
/** Grappling hook: charges, and seconds for each one to come back. */
export const HOOK_CHARGES = 3, HOOK_RECHARGE = 30;
/** Seconds you can hold your breath on a scope. */
export const BREATH_HOLD = 4;
const THROW_ORDER: ThrowKind[] = ['frag', 'smoke', 'flash'];
/** Hold G this long and the grenade wheel opens (a quick tap just takes out the current grenade). */
const WHEEL_DELAY = 0.18;
/** Wheel slices, clockwise from the top: [kind, centre angle in radians, screen space, y down]. */
export const WHEEL_SLOTS: [ThrowKind, number][] = [['frag', -Math.PI / 2], ['smoke', Math.PI / 6], ['flash', (Math.PI * 5) / 6]];

export type Channel = { type: 'medkit' | 'plate'; time: number; total: number };
type ReloadKind = ReloadAnim['kind'];

/** Player-side weapon handling: firing, reload, swap, ADS, recoil, grenades, healing. Visuals live in ViewModel. */
export class PlayerWeapons {
  /** Options: right-click toggles aiming. */
  toggleAim = false;
  /** Aim-in speed multiplier from the settings. */
  adsSpeed = 0.55;
  private aimLatched = false;
  private rmbWas = false;
  cooldown = 0;
  reloadLeft = 0;
  switchLeft = 0;
  bloom = 0;
  adsAmount = 0;
  recoilPitch = 0;
  recoilYaw = 0;
  /** Scope sway from breathing (snipers and DMRs aimed in). Added to the camera like recoil. */
  breathPitch = 0;
  breathYaw = 0;
  /** Holding your breath (Shift while scoped): seconds held, and how winded you are afterwards. */
  breathHeld = 0;
  winded = 0;
  private breathT = 0;
  channel: Channel | null = null;
  view: ViewModel;
  /** A grenade is in your hand: the throw arc is showing (left click or G throws, right click puts it away). */
  aimingThrow = false;
  /** Grenade wheel (hold G): open, where the cursor is (pixels from the centre), and which slice it's on. */
  wheel = { open: false, x: 0, y: 0, sel: 'frag' as ThrowKind };
  private gHeld = 0;
  shotsFired = 0;
  private reloadKind: ReloadKind = 'mag';
  private reloadTotal = 1;
  private sinceShot = 99;
  private reloadWeapon: WeaponInstance | null = null;
  /** Reload foley is scheduled ahead; silence it if the reload gets interrupted. */
  private reloadSnd = false;
  /** Shot index within the current spray (drives the recoil pattern). */
  private sprayIdx = 0;
  private burstLeft = 0;
  /** Sprint-to-fire: the gun is still coming up out of a sprint. */
  private sprintOut = 0;
  /** A semi-auto shot pressed while the gun was still coming up (fires as soon as it can). */
  private queuedShot = false;
  /** Recoil the current spray pushed into your aim; it drifts back once you let go (unless you pulled it down yourself). */
  private sprayRise = 0;
  private sprayStartPitch = 0;
  private throwCd = 0;
  private arc: Line;
  private arcPts: Vector3[] = [];

  constructor(camera: PerspectiveCamera, private game: Game) {
    this.view = new ViewModel(camera, game.scene);
    this.arc = new Line(new BufferGeometry(), new LineDashedMaterial({ color: 0xffffff, dashSize: 0.35, gapSize: 0.2, transparent: true, opacity: 0.85, depthTest: false }));
    this.arc.renderOrder = 5;
    this.arc.frustumCulled = false;
    this.arc.visible = false;
    game.scene.add(this.arc);
  }

  get reloading() {
    return this.reloadLeft > 0;
  }

  currentSpread(player: Player) {
    const w = player.weapon;
    if (!w) return 0;
    // Movement never costs accuracy (jumping, sliding, ziplines): only aiming down sights tightens it.
    return lerp(w.def.hipSpread, adsSpreadOf(w), this.adsAmount) + this.bloom;
  }

  /** Can the player use weapons right now? (on foot or hanging from a zipline, not swimming or climbing) */
  private armed(player: Player) {
    if (player.frozen) return false;
    return (player.mode === 'ground' && !player.swimming && !player.mantle) || player.mode === 'zipline';
  }

  update(dt: number, input: Input, player: Player) {
    if (this.reloadSnd && this.reloadLeft <= 0) {
      this.game.sfx.cancelReload();
      this.reloadSnd = false;
    }
    this.cooldown -= dt;
    this.sinceShot += dt;
    this.throwCd -= dt;
    this.updateGrapple(dt, input, player);
    this.bloom = Math.max(0, this.bloom - dt * 0.12);
    this.recoilPitch = damp(this.recoilPitch, 0, 7, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, 7, dt);
    if (this.sinceShot > 0.35) this.sprayIdx = 0;
    if (this.sinceShot > 0.1 && this.sprayRise > 0) {
      // Only give back what you didn't already fight down yourself.
      const left = Math.min(this.sprayRise, player.pitch - this.sprayStartPitch);
      if (left <= 0) this.sprayRise = 0;
      else {
        const r = left * (1 - Math.exp(-9 * dt));
        player.pitch -= r;
        this.sprayRise = left - r < 0.0004 ? 0 : left - r;
      }
    }

    if (!this.armed(player)) {
      player.ads = false;
      this.aimingThrow = false;
      this.wheel.open = false;
      this.gHeld = 0;
      this.arc.visible = false;
      this.burstLeft = 0;
      return;
    }

    // Slot swapping
    let want = -1;
    if (input.pressed('Digit1')) want = 0;
    if (input.pressed('Digit2')) want = 1;
    if (input.wheel !== 0 || input.pressed('KeyQ')) want = player.unarmed ? player.active : 1 - player.active;
    if (input.pressed('Digit3') && !player.unarmed) {
      player.unarmed = true;
      player.ads = false;
      this.reloadLeft = 0;
      this.burstLeft = 0;
      this.channel = null;
      this.game.sfx.swap();
    } else if (want >= 0 && player.slots[want] && (want !== player.active || player.unarmed)) {
      player.unarmed = false;
      player.active = want;
      this.switchLeft = 0.4;
      this.reloadLeft = 0;
      this.burstLeft = 0;
      this.channel = null;
      this.game.sfx.swap();
    }
    this.switchLeft -= dt;

    const w = player.weapon;
    if (w !== this.reloadWeapon) this.reloadLeft = 0;
    // Coming out of a sprint the gun needs a moment to come up (snappy SMGs, slow LMGs and snipers).
    if (player.sprinting) this.sprintOut = w ? w.def.sprintToFire : 0;
    else this.sprintOut = Math.max(0, this.sprintOut - dt);
    this.view.setWeapon(w);

    this.updateThrow(dt, input, player);

    // Healing / plating
    if (!this.channel) {
      if (input.pressed('KeyH') && player.medkits > 0 && player.health < P.maxHealth) {
        this.channel = { type: 'medkit', time: 0, total: P.medkitTime };
        this.reloadLeft = 0;
      } else if (input.pressed('KeyV') && player.plates > 0 && player.armor < P.maxArmor) {
        this.channel = { type: 'plate', time: 0, total: P.plateTime };
        this.reloadLeft = 0;
      }
    }
    if (this.channel) {
      this.channel.time += dt;
      if (this.channel.time >= this.channel.total) {
        if (this.channel.type === 'medkit') {
          player.medkits--;
          player.health = Math.min(P.maxHealth, player.health + P.medkitHeal);
          this.channel = null;
          this.game.sfx.heal();
        } else {
          player.plates--;
          player.armor = Math.min(P.maxArmor, player.armor + P.plateArmor);
          this.game.sfx.plate();
          // Plates chain one after another until you're full (shooting or switching cancels).
          this.channel = player.plates > 0 && player.armor < P.maxArmor
            ? { type: 'plate', time: 0, total: P.plateTime } : null;
        }
      }
    }

    // Hands out: punch.
    this.punchCd -= dt;
    if (player.unarmed && input.mouseDown[0] && this.punchCd <= 0 && !this.channel && !this.aimingThrow) this.punch(player);
    if (input.pressed('KeyY') && !this.channel && !this.aimingThrow) this.view.inspect();
    this.updateBreath(dt, input, player);

    // Toggle aim: right-click flips aiming on and off instead of holding.
    const rmb = input.mouseDown[2];
    if (this.toggleAim && rmb && !this.rmbWas) this.aimLatched = !this.aimLatched;
    this.rmbWas = rmb;
    if (!w || this.switchLeft > 0) this.aimLatched = false;
    player.ads = !!w && (this.toggleAim ? this.aimLatched : rmb) && this.switchLeft <= 0 && !this.channel && !this.aimingThrow;
    // Each gun has its own aim-in time (the settings slider scales it); dropping out of sights is quicker.
    const adsRate = w ? (3 / w.def.adsTime) * (this.adsSpeed / 0.55) * (player.ads ? 1 : 1.4) : 16 * this.adsSpeed;
    this.adsAmount = damp(this.adsAmount, player.ads ? 1 : 0, adsRate, dt);
    if (!w) return;

    // Reload (shotguns load shell by shell and can be interrupted by firing)
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) this.advanceReload(w, player);
    } else if (input.pressed('KeyR') && w.mag < magSize(w) && player.ammo[w.def.ammo] > 0 && !this.channel) {
      this.startReload(w);
    }

    // Fire (burst rifles keep going until the burst is done)
    let trigger = w.def.auto ? input.mouseDown[0] : input.mousePressed[0];
    if (trigger && player.sprinting) {
      // Pulling the trigger ends the sprint; the shot comes once the gun is up.
      player.sprintLock = Math.max(player.sprintLock, w.def.sprintToFire + 0.15);
      player.sprinting = false;
    }
    if (!w.def.auto && input.mousePressed[0] && this.sprintOut > 0) this.queuedShot = true;
    if (this.queuedShot && this.sprintOut <= 0) {
      trigger = true;
      this.queuedShot = false;
    }
    if (trigger && this.reloadLeft > 0 && this.reloadKind !== 'mag' && w.mag > 0) this.reloadLeft = 0;
    const ready = this.cooldown <= 0 && this.reloadLeft <= 0 && this.switchLeft <= 0 && !this.channel && !this.aimingThrow && this.sprintOut <= 0;
    if (this.burstLeft > 0) {
      if (ready && w.mag > 0) {
        this.fire(w, player);
        if (--this.burstLeft === 0) this.cooldown = BURST_GAP;
      } else if (w.mag <= 0) this.burstLeft = 0;
      return;
    }
    if (trigger && this.channel?.type === 'plate' && this.channel.time < 0.2) this.channel = null;
    if (trigger && ready) {
      if (w.mag <= 0) {
        if (player.ammo[w.def.ammo] > 0) this.startReload(w);
        else if (input.mousePressed[0]) this.game.sfx.dry();
      } else if (w.def.burst) {
        this.burstLeft = w.def.burst - 1;
        this.fire(w, player);
        if (this.burstLeft === 0) this.cooldown = BURST_GAP;
      } else {
        this.fire(w, player);
      }
    }
  }

  /** Long scopes drift with your breathing; hold Shift to steady the shot for a few seconds. */
  private updateBreath(dt: number, input: Input, player: Player) {
    const w = player.weapon, id = w?.def.id;
    const amp = (id === 'sniper' ? 0.0032 : id === 'dmr' ? 0.0016 : 0) * this.adsAmount;
    const hold = amp > 0 && this.adsAmount > 0.8 && input.isDown('ShiftLeft') && this.winded <= 0 && this.breathHeld < BREATH_HOLD;
    if (hold) {
      if (this.breathHeld === 0) this.game.sfx.breath(true);
      this.breathHeld += dt;
      if (this.breathHeld >= BREATH_HOLD) {
        this.winded = 2;
        this.game.sfx.breath(false);
      }
    } else {
      if (this.breathHeld > 0 && this.winded <= 0) this.game.sfx.breath(false);
      if (this.breathHeld > 0 && this.winded <= 0 && this.breathHeld < BREATH_HOLD) this.winded = Math.min(1, this.breathHeld * 0.25);
      this.breathHeld = 0;
      this.winded = Math.max(0, this.winded - dt);
    }
    const k = hold ? 0.08 : 1 + this.winded * 0.8;
    this.breathT += dt * (1 + this.winded * 0.6);
    this.breathPitch = damp(this.breathPitch, Math.sin(this.breathT * 1.1) * amp * k, 10, dt);
    this.breathYaw = damp(this.breathYaw, Math.sin(this.breathT * 0.55 + 1.3) * amp * 0.8 * k, 10, dt);
  }

  // ---------- grenades ----------

  /** Mouse (or right stick) movement while the wheel is open steers its cursor instead of the camera. */
  wheelLook(dx: number, dy: number) {
    const w = this.wheel;
    w.x += dx * 0.6;
    w.y += dy * 0.6;
    const r = Math.hypot(w.x, w.y);
    if (r > 120) {
      w.x *= 120 / r;
      w.y *= 120 / r;
    }
    if (r > 30) {
      const a = Math.atan2(w.y, w.x);
      let best = w.sel, bd = Infinity;
      for (const [k, c] of WHEEL_SLOTS) {
        const d = Math.abs(((a - c + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      if (best !== w.sel) this.game.sfx.click();
      w.sel = best;
    }
  }

  private startThrowAim(player: Player) {
    if (player.throwables[player.throwSel] <= 0 || this.throwCd > 0 || this.channel) return;
    this.aimingThrow = true;
    this.reloadLeft = 0;
    this.burstLeft = 0;
    this.game.sfx.pin();
  }

  private updateThrow(dt: number, input: Input, player: Player) {
    // G: tap to take out your grenade, hold for the wheel; letting go picks the slice under the cursor.
    const w = this.wheel;
    if (input.isDown('KeyG') && !this.channel) {
      this.gHeld += dt;
      if (this.gHeld >= WHEEL_DELAY && !w.open) {
        w.open = true;
        w.x = w.y = 0;
        w.sel = player.throwSel;
        this.game.sfx.swap();
      }
    } else if (this.gHeld > 0) {
      this.gHeld = 0;
      if (w.open) {
        w.open = false;
        if (player.throwables[w.sel] > 0) {
          player.throwSel = w.sel;
          this.startThrowAim(player);
        } else this.game.hud.pickupToast(`No ${THROWABLES[w.sel].name}s`, '#ff8a6b');
      } else if (this.aimingThrow) this.throwNow(player);
      else this.startThrowAim(player);
    }
    if (input.pressed('KeyZ')) {
      // Cycle to the next type you actually carry.
      const start = THROW_ORDER.indexOf(player.throwSel);
      for (let k = 1; k <= 3; k++) {
        const t = THROW_ORDER[(start + k) % 3];
        if (player.throwables[t] > 0) {
          player.throwSel = t;
          break;
        }
      }
      this.game.sfx.swap();
    }
    if (player.throwables[player.throwSel] <= 0) {
      const any = THROW_ORDER.find((t) => player.throwables[t] > 0);
      if (any) player.throwSel = any;
    }
    const have = player.throwables[player.throwSel] > 0;
    if (this.aimingThrow && (!have || this.channel)) this.aimingThrow = false;
    if (this.aimingThrow && !w.open) {
      if (input.mousePressed[0]) return this.throwNow(player);
      if (input.mousePressed[2]) {
        this.aimingThrow = false;
        this.arc.visible = false;
        return;
      }
      const { from, vel } = this.throwParams(player);
      this.game.projectiles.predict(from, vel, this.arcPts);
      this.arc.geometry.setFromPoints(this.arcPts);
      this.arc.computeLineDistances();
      this.arc.visible = true;
      (this.arc.material as LineDashedMaterial).color.setHex(THROWABLES[player.throwSel].color | 0x404040);
    } else this.arc.visible = false;
  }

  private throwNow(player: Player) {
    this.aimingThrow = false;
    this.arc.visible = false;
    if (player.throwables[player.throwSel] <= 0) return;
    const { from, vel } = this.throwParams(player);
    this.game.projectiles.throw(player.throwSel, from, vel, player);
    player.throwables[player.throwSel]--;
    this.throwCd = 0.7;
    this.switchLeft = 0.35;
    this.game.sfx.throwWhoosh();
  }

  private rope: Mesh | null = null;

  /** Grappling hook (X): hooks whatever you're looking at within 70 m and reels you in. */
  private updateGrapple(dt: number, input: Input, player: Player) {
    // Once you own a hook it has 3 charges, and they come back one at a time.
    if (player.throwables.grapple > 0) player.hookOwned = true;
    if (player.hookOwned && player.throwables.grapple < HOOK_CHARGES) {
      player.hookCharge += dt;
      if (player.hookCharge >= HOOK_RECHARGE) {
        player.hookCharge = 0;
        player.throwables.grapple++;
      }
    } else player.hookCharge = 0;
    if (input.pressed('KeyX') && !player.throwables.grapple && player.mode === 'ground') {
      if (player.hookOwned) this.game.hud.pickupToast(`Hook recharging: next charge in ${Math.ceil(HOOK_RECHARGE - player.hookCharge)} s`, '#ff8a6b');
      else this.game.hud.pickupToast('No grappling hook: find a blue hook on the ground (3 charges, they recharge)', '#ff8a6b');
    }
    if (input.pressed('KeyX') && player.throwables.grapple > 0 && player.mode === 'ground' && !player.grapple && !player.swimming && !player.mantle && !player.frozen) {
      const cam = this.game.camera, o = cam.getWorldPosition(tmpO), dir = cam.getWorldDirection(tmpF);
      const d = this.game.world.raycast(o, dir, 70);
      if (d < 70 && d > 2.5) {
        player.startGrapple(o.clone().addScaledVector(dir, d - 0.3));
        player.throwables.grapple--;
        this.game.sfx.throwWhoosh();
      } else this.game.hud.pickupToast('Nothing in reach to hook', '#ff8a6b');
    }
    if (player.grapple) {
      if (!this.rope) {
        this.rope = new Mesh(new CylinderGeometry(0.025, 0.025, 1, 5).rotateX(Math.PI / 2), new MeshLambertMaterial({ color: 0x2a2a2a }));
        this.game.scene.add(this.rope);
      }
      const from = this.game.camera.getWorldPosition(tmpO);
      from.y -= 0.35;
      const at = player.grapple.at;
      this.rope.visible = true;
      this.rope.position.lerpVectors(from, at, 0.5);
      this.rope.lookAt(at);
      this.rope.scale.set(1, 1, from.distanceTo(at));
    } else if (this.rope) this.rope.visible = false;
  }

  private throwParams(player: Player) {
    const cam = this.game.camera;
    const dir = cam.getWorldDirection(tmpF);
    const from = cam.getWorldPosition(tmpO).addScaledVector(dir, 0.5);
    from.y -= 0.15;
    const vel = tmpV.copy(dir).multiplyScalar(19).add(tmpD.set(0, 3.5, 0)).addScaledVector(player.body.vel, 0.6);
    return { from, vel };
  }

  // ---------- reload ----------

  private startReload(w: WeaponInstance) {
    this.reloadWeapon = w;
    this.burstLeft = 0;
    if (w.def.id === 'shotgun') this.setReload('shell-start', SHELL_START);
    else this.setReload('mag', w.def.reload);
    this.game.sfx.reloadStart(w.def.id, w.def.reload);
    this.reloadSnd = w.def.id !== 'shotgun';
  }

  private setReload(kind: ReloadKind, time: number) {
    this.reloadKind = kind;
    this.reloadLeft = this.reloadTotal = time;
  }

  private advanceReload(w: WeaponInstance, player: Player) {
    const ammo = w.def.ammo, cap = magSize(w);
    if (this.reloadKind === 'mag') {
      const take = Math.min(cap - w.mag, player.ammo[ammo]);
      w.mag += take;
      player.ammo[ammo] -= take;
      this.reloadLeft = 0;
      this.reloadSnd = false;
    } else if (this.reloadKind === 'shell-start') {
      this.setReload('shell', SHELL_TIME);
    } else if (this.reloadKind === 'shell') {
      w.mag++;
      player.ammo[ammo]--;
      this.game.sfx.shellIn();
      if (w.mag < cap && player.ammo[ammo] > 0) this.setReload('shell', SHELL_TIME);
      else {
        this.setReload('shell-end', SHELL_END);
        this.game.sfx.shotgunClose();
      }
    } else {
      this.reloadLeft = 0;
    }
  }

  // ---------- firing ----------

  private fire(w: WeaponInstance, player: Player) {
    const cam = this.game.camera;
    // Shooting drops you out of a sprint: you walk while firing.
    player.sprintLock = 0.55;
    player.sprinting = false;
    w.mag--;
    this.cooldown = 60 / w.def.rpm;
    this.sinceShot = 0;
    this.shotsFired++;
    const origin = cam.getWorldPosition(tmpO);
    const fwd = cam.getWorldDirection(tmpF);
    const spread = this.currentSpread(player);
    const muzzle = this.view.muzzleWorld(tmpM);
    if (w.def.projectile) {
      const dir = applySpread(tmpD.copy(fwd), spread * 0.5);
      // Launch from just in front of the eye so it doesn't clip the wall you're hugging.
      this.game.projectiles.fireRocket(tmpV.copy(origin).addScaledVector(dir, 0.6), dir, player, w);
    } else {
      for (let i = 0; i < w.def.pellets; i++) {
        const dir = applySpread(tmpD.copy(fwd), spread);
        // Rifles fire real bullets (travel time and drop); close-range guns stay hitscan.
        if (w.def.bulletVel > 0) this.game.bullets.fire(player, origin, dir, w, muzzle);
        else this.game.fireShot(player, origin, dir, w, muzzle);
      }
    }
    this.bloom = Math.min(w.def.maxBloom, this.bloom + w.def.bloomPerShot);
    // Learnable recoil pattern: part of the climb recovers, part stays (you pull down to control it).
    const adsMul = lerp(1, 0.65, this.adsAmount);
    if (this.sprayIdx === 0) {
      this.sprayRise = 0;
      this.sprayStartPitch = player.pitch;
    }
    const [kp, ky] = recoilKick(w, this.sprayIdx++);
    this.sprayRise += kp * adsMul * 0.45 * 0.75;
    this.recoilPitch += kp * adsMul * 0.55;
    this.recoilYaw -= ky * adsMul * 0.55;
    player.pitch = clamp(player.pitch + kp * adsMul * 0.45, -1.55, 1.55);
    player.yaw -= ky * adsMul * 0.45;
    this.view.onFire(w, this.adsAmount);
    const cap = magSize(w);
    this.game.sfx.shot(w.def.id, 0, undefined, cap >= 8 && w.mag > 0 && w.mag <= Math.max(3, Math.floor(cap * 0.15)));
    if (w.mag === 0 && player.ammo[w.def.ammo] > 0) {
      // Auto-reload after the last round leaves.
      setTimeout(() => {
        if (player.weapon === w && w.mag === 0 && this.reloadLeft <= 0) this.startReload(w);
      }, 250);
    }
  }

  private punchCd = 0;

  private punch(player: Player) {
    this.punchCd = 0.42;
    const cam = this.game.camera;
    const origin = cam.getWorldPosition(new Vector3()), fwd = cam.getWorldDirection(new Vector3());
    this.view.punch();
    this.game.sfx.punch();
    // Land it a moment into the swing.
    setTimeout(() => {
      if (!player.alive || !player.unarmed) return;
      this.game.fireShot(player, origin, fwd, FISTS, origin);
    }, 90);
  }

  private reloadAnim(): ReloadAnim | null {
    if (this.reloadLeft <= 0) return null;
    return { kind: this.reloadKind, t: clamp(1 - this.reloadLeft / this.reloadTotal, 0, 1) };
  }

  /** Viewmodel animation; runs every render frame. */
  animate(dt: number, player: Player) {
    const w = player.weapon;
    const sniperScoped = w?.def.id === 'sniper' && this.adsAmount > 0.85;
    const glide = player.mode === 'glide' && player.alive;
    this.view.setVisible((this.armed(player) && !sniperScoped && player.alive) || glide);
    this.view.update(dt, {
      player,
      ads: this.adsAmount,
      equip: Math.max(0, this.switchLeft) / 0.4,
      busy: !!this.channel || this.aimingThrow,
      heal: this.channel ? { type: this.channel.type, t: clamp(this.channel.time / this.channel.total, 0, 1) } : null,
      reload: this.reloadAnim(),
      sinceShot: this.sinceShot,
      cycle: w ? 60 / w.def.rpm : 1,
      glide,
    });
  }

  reloadProgress(player: Player) {
    const w = player.weapon;
    if (!w || this.reloadLeft <= 0) return 0;
    if (this.reloadKind !== 'mag') return clamp(w.mag / magSize(w), 0, 1);
    return clamp(1 - this.reloadLeft / this.reloadTotal, 0, 1);
  }

  /** Cancel everything (death, entering a vehicle, gulag). */
  reset() {
    if (this.reloadSnd) this.game.sfx.cancelReload();
    this.reloadSnd = false;
    this.channel = null;
    this.reloadLeft = 0;
    this.burstLeft = 0;
    this.sprayRise = 0;
    this.queuedShot = false;
    this.breathPitch = this.breathYaw = this.breathHeld = 0;
    this.aimingThrow = false;
    this.wheel.open = false;
    this.gHeld = 0;
    this.arc.visible = false;
  }
}

const tmpO = new Vector3(), tmpF = new Vector3(), tmpD = new Vector3(), tmpM = new Vector3(), tmpV = new Vector3();
