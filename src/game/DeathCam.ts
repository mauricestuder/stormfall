import { Color, PerspectiveCamera, Vector3 } from 'three';
import { bodyForSkin, Character } from '../bots/Character';
import { skinOf } from './Skins';
import type { Game } from './Game';

/** How long the camera takes to float out of your head (s). */
const RISE = 0.8;
/** How long you watch your body before the Gulag, killcam or results (ms). */
export const DEATH_CAM_MS = 900;

/**
 * Valorant-style death: instead of cutting away, the camera slips up and back out of your head
 * and looks down at your own body toppling over, for a moment.
 */
export class DeathCam {
  active = false;
  private body: Character | null = null;
  private t = 0;
  private eye = new Vector3();
  private look = new Vector3();
  private at = new Vector3();
  private end = new Vector3();
  private center = new Vector3();
  private yaw = 0;
  private fallX = 0;
  private fallZ = 0;

  constructor(private game: Game) {}

  /** `from`: where the killing shot came from (you fall away from it), or null to fall backwards. */
  start(eye: Vector3, yaw: number, pitch: number, ground: Vector3, from: Vector3 | null) {
    this.stop();
    const g = this.game, s = skinOf(g.profile.data.skin);
    const c = new Character(new Color(s.suit), new Color(s.trim), undefined, s, false, bodyForSkin(s));
    c.root.rotation.order = 'YXZ';
    c.root.position.copy(ground);
    c.root.rotation.set(0, yaw, 0);
    g.scene.add(c.root);
    c.die();
    this.body = c;
    this.active = true;
    this.t = 0;
    this.eye.copy(eye);
    this.at.copy(ground);
    this.yaw = yaw;
    const cp = Math.cos(pitch);
    this.look.set(eye.x - Math.sin(yaw) * cp * 4, eye.y + Math.sin(pitch) * 4, eye.z - Math.cos(yaw) * cp * 4);

    // Pushed away from the shooter (same maths as a bot's death), backwards if we don't know.
    let hx = Math.sin(yaw), hz = Math.cos(yaw);
    if (from) {
      const dx = ground.x - from.x, dz = ground.z - from.z, n = Math.hypot(dx, dz);
      if (n > 0.1) [hx, hz] = [dx / n, dz / n];
    }
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const along = hx * fx + hz * fz, side = hx * rx + hz * rz, n = Math.hypot(along, side) || 1;
    this.fallX = (-along / n) * 1.5;
    this.fallZ = (-side / n) * 1.5;
    // The body ends up lying along the push; the camera rises off to its side and looks down across it.
    this.center.set(ground.x + hx * 0.7, ground.y + 0.35, ground.z + hz * 0.7);
    const dir = new Vector3(-hz * 2.6 + hx * 0.6, 2.1, hx * 2.6 + hz * 0.6), len = dir.length();
    dir.divideScalar(len);
    const from0 = tmp.set(ground.x, ground.y + 1.2, ground.z);
    const free = Math.min(len, g.world.raycast(from0, dir, len) - 0.35);
    this.end.copy(from0).addScaledVector(dir, Math.max(0.8, free));
  }

  stop() {
    if (this.body) this.game.scene.remove(this.body.root);
    this.body = null;
    this.active = false;
  }

  update(dt: number, cam: PerspectiveCamera) {
    const c = this.body;
    if (!c) return;
    this.t += dt;
    // The body topples (easing in like a real fall, with a small bounce), legs go limp.
    const kf = Math.min(1, this.t / 0.55), fall = kf * kf + (kf >= 1 ? Math.sin(Math.min(1, (this.t - 0.55) / 0.25) * Math.PI) * -0.06 : 0);
    if (c.animatedDeath) {
      c.tick(dt);
    } else {
      c.tick(dt);
      c.root.rotation.set(this.fallX * fall, this.yaw, this.fallZ * fall);
      c.root.position.set(this.at.x, this.at.y + Math.min(1, fall) * 0.12, this.at.z);
      const legs = c.legsList;
      legs[0].rotation.x += (0.35 - legs[0].rotation.x) * Math.min(1, dt * 6);
      legs[1].rotation.x += (-0.15 - legs[1].rotation.x) * Math.min(1, dt * 6);
    }
    // Camera: out of the eyes, up and back, turning to look down at the body.
    const k = 1 - (1 - Math.min(1, this.t / RISE)) ** 3;
    cam.position.lerpVectors(this.eye, this.end, k);
    cam.lookAt(tmp.lerpVectors(this.look, this.center, Math.min(1, k * 1.3)));
  }
}

const tmp = new Vector3();
