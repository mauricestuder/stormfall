import { Color, PerspectiveCamera, Vector3 } from 'three';
import { Bot } from '../bots/Bot';
import { Character } from '../bots/Character';
import type { Combatant } from './Combat';
import type { Game } from './Game';

const RATE = 1 / 20, KEEP = 5.5, PLAY = 4.5;

interface Frame {
  t: number;
  /** x, y, z, yaw per combatant (index = position in game.combatants). */
  data: Float32Array;
}

interface Shot {
  t: number;
  by: Combatant;
  from: Vector3;
  to: Vector3;
}

/**
 * Keeps a few seconds of everyone's movement and shots; on death, replays them from the killer's eyes.
 */
export class Killcam {
  active = false;
  killerName = '';
  private frames: Frame[] = [];
  private shots: Shot[] = [];
  private acc = 0;
  private t = 0;
  private start = 0;
  private killer: Bot | null = null;
  private killerIdx = -1;
  private playerIdx = 0;
  private body: Character;
  private shotIdx = 0;
  private onDone: (() => void) | null = null;

  constructor(private game: Game) {
    this.body = new Character(new Color(0x2f6fd1), new Color(0x1c2f55));
    this.body.root.visible = false;
    game.scene.add(this.body.root);
  }

  record(dt: number, now: number) {
    this.acc += dt;
    if (this.acc < RATE) return;
    this.acc = 0;
    const cs = this.game.combatants, data = new Float32Array(cs.length * 4);
    cs.forEach((c, i) => {
      const yaw = c.isPlayer ? this.game.player.yaw : (c as Bot).yaw;
      data.set([c.body.pos.x, c.body.pos.y, c.body.pos.z, c.alive ? yaw : NaN], i * 4);
    });
    this.frames.push({ t: now, data });
    while (this.frames.length && now - this.frames[0].t > KEEP) this.frames.shift();
    while (this.shots.length && now - this.shots[0].t > KEEP) this.shots.shift();
  }

  shot(by: Combatant, from: Vector3, to: Vector3, now: number) {
    this.shots.push({ t: now, by, from: from.clone(), to: to.clone() });
  }

  /** Starts the replay; returns false if there's nothing worth showing. */
  play(killer: Combatant | null, now: number, onDone: () => void) {
    if (!(killer instanceof Bot) || this.frames.length < 10) return false;
    this.killer = killer;
    this.killerIdx = this.game.combatants.indexOf(killer);
    this.playerIdx = this.game.combatants.indexOf(this.game.player);
    if (this.killerIdx < 0) return false;
    this.killerName = killer.name;
    this.active = true;
    this.start = Math.max(this.frames[0].t, now - PLAY);
    this.t = this.start;
    this.shotIdx = this.shots.findIndex((s) => s.t >= this.start);
    if (this.shotIdx < 0) this.shotIdx = this.shots.length;
    this.onDone = onDone;
    if (this.game.player.weapon) this.body.setGun(this.game.player.weapon);
    this.body.root.visible = true;
    return true;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.body.root.visible = false;
    const done = this.onDone;
    this.onDone = null;
    done?.();
  }

  /** Advances the replay and poses the camera; called every render frame while active. */
  update(dt: number, cam: PerspectiveCamera) {
    if (!this.active || !this.killer) return;
    this.t += dt;
    const end = this.frames[this.frames.length - 1].t;
    if (this.t >= end + 0.6) return this.stop();
    // Find the pair of frames around t.
    let i = 0;
    while (i < this.frames.length - 2 && this.frames[i + 1].t < this.t) i++;
    const a = this.frames[i], b = this.frames[Math.min(i + 1, this.frames.length - 1)];
    const k = b.t > a.t ? Math.min(1, Math.max(0, (this.t - a.t) / (b.t - a.t))) : 0;
    const at = (idx: number, out: Vector3) =>
      out.set(lerp(a.data[idx * 4], b.data[idx * 4], k), lerp(a.data[idx * 4 + 1], b.data[idx * 4 + 1], k), lerp(a.data[idx * 4 + 2], b.data[idx * 4 + 2], k));
    // Everyone moves as they did.
    this.game.combatants.forEach((c, idx) => {
      if (c.isPlayer) return;
      const yaw = a.data[idx * 4 + 3];
      const mesh = (c as Bot).mesh;
      if (Number.isNaN(yaw)) return;
      mesh.visible = true;
      at(idx, mesh.position);
      mesh.rotation.y = yaw;
    });
    const pp = at(this.playerIdx, tmpP);
    this.body.root.position.copy(pp);
    const py = a.data[this.playerIdx * 4 + 3];
    if (!Number.isNaN(py)) this.body.root.rotation.y = py;
    this.body.animate(dt, 3, true, false);
    // Over the killer's shoulder, looking at you.
    const kp = at(this.killerIdx, tmpK);
    const eye = tmpE.set(kp.x, kp.y + 1.6, kp.z);
    const look = tmpL.set(pp.x, pp.y + 1.2, pp.z);
    const dir = tmpD.subVectors(look, eye).normalize();
    const side = tmpS.set(-dir.z, 0, dir.x).normalize();
    cam.position.copy(eye).addScaledVector(dir, -2.2).addScaledVector(side, 0.7).setY(eye.y + 0.5);
    cam.lookAt(look);
    cam.updateMatrixWorld();
    // Replay their shots as tracers.
    while (this.shotIdx < this.shots.length && this.shots[this.shotIdx].t <= this.t) {
      const s = this.shots[this.shotIdx++];
      this.game.fx.tracer(s.from, s.to, s.by === this.killer ? 0xff8a5a : 0xffe08a, 0.04, 0.08);
      if (s.by === this.killer) this.game.sfx.shot(this.killer.weapon.def.id, s.from.distanceTo(cam.position));
    }
  }

  get progress() {
    const end = this.frames.length ? this.frames[this.frames.length - 1].t : 1;
    return Math.min(1, (this.t - this.start) / Math.max(0.1, end - this.start));
  }
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const tmpP = new Vector3(), tmpK = new Vector3(), tmpE = new Vector3(), tmpL = new Vector3(), tmpD = new Vector3(), tmpS = new Vector3();
