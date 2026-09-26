import { Vector3 } from 'three';
import type { Combatant } from './Combat';
import type { Game } from './Game';

/** Admin tools for testing (offline only). Opened from the hidden dot in Options. */
export interface CheatFlags {
  esp: boolean;
  god: boolean;
  ghost: boolean;
}

export const CHEAT_LIST: { key: keyof CheatFlags; label: string; hint: string }[] = [
  { key: 'esp', label: 'Wallhack', hint: 'Boxes, names and health through walls; enemies on the map' },
  { key: 'god', label: 'No damage', hint: 'Bullets, falls and the storm do nothing' },
  { key: 'ghost', label: 'Ghost', hint: 'Fly through walls (Space up, Ctrl down, Shift fast); bots ignore you' },
];

export const CHEATS: CheatFlags = { esp: false, god: false, ghost: false };

/** Cheats only count offline: never in a match with friends. */
let live = true;
export function cheatOn(k: keyof CheatFlags) {
  return live && CHEATS[k];
}

const tmpE = new Vector3(), tmpT = new Vector3(), tmpV = new Vector3();

export class Cheats {
  /** Any admin tool was on this match: it won't count toward your career. */
  used = false;
  private cv = document.createElement('canvas');
  private ctx = this.cv.getContext('2d')!;

  constructor(private game: Game) {
    this.cv.id = 'esp';
    document.body.insertBefore(this.cv, document.getElementById('hud'));
  }

  get allowed() {
    return !this.game.netm;
  }

  isEnemy(c: Combatant) {
    const g = this.game;
    return c !== g.player && c.alive && c.team !== g.player.team && g.canTarget(g.player, c) && !(c as { dummy?: boolean }).dummy;
  }

  headOf(c: Combatant, out: Vector3) {
    return out.set(c.body.pos.x, c.body.pos.y + c.body.height - 0.22, c.body.pos.z);
  }

  /** Before the player moves: flying through walls. Returns true if it took over movement. */
  move(dt: number): boolean {
    live = this.allowed;
    const p = this.game.player, inp = this.game.input;
    if (!cheatOn('ghost') || p.mode !== 'ground' || !p.alive) return false;
    const f = (inp.isDown('KeyW') ? 1 : 0) - (inp.isDown('KeyS') ? 1 : 0);
    const s = (inp.isDown('KeyD') ? 1 : 0) - (inp.isDown('KeyA') ? 1 : 0);
    const u = (inp.isDown('Space') ? 1 : 0) - (inp.isDown('ControlLeft') || inp.isDown('KeyC') ? 1 : 0);
    const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw), cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
    const v = tmpV.set(-sy * cp * f + cy * s, sp * f + u, -cy * cp * f - sy * s);
    if (v.lengthSq() > 1) v.normalize();
    const speed = inp.isDown('ShiftLeft') ? 70 : 25;
    p.body.pos.addScaledVector(v, speed * dt);
    p.body.pos.y = Math.max(p.body.pos.y, this.game.map.groundAt(p.body.pos.x, p.body.pos.z) - 40);
    p.body.vel.set(0, 0, 0);
    p.body.onGround = false;
    p.fallDamage = 0;
    return true;
  }

  /** After the player moves, before the gun: god mode, and marks the match as assisted. */
  tick() {
    const p = this.game.player;
    if (live && CHEAT_LIST.some((c) => CHEATS[c.key])) this.used = true;
    if (!p.alive || !cheatOn('god')) return;
    p.health = Math.max(p.health, 100);
    p.fallDamage = 0;
  }

  /** ESP overlay, drawn after the camera is placed each frame. */
  draw() {
    const g = this.game, cv = this.cv, ctx = this.ctx;
    const on = cheatOn('esp') && (g.state === 'playing' || g.state === 'paused');
    const W = window.innerWidth, H = window.innerHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!on) {
      if (cv.width) cv.width = cv.height = 0;
      return;
    }
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const cam = g.camera, cp = cam.position;
    const eye = tmpE.copy(cp);
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const c of g.combatants) {
      if (!this.isEnemy(c)) continue;
      const pos = c.body.pos, dist = pos.distanceTo(cp);
      const seen = g.canSee(eye, c);
      const col = seen ? '#ff4a3d' : '#ffcf3a';
      const foot = tmpT.set(pos.x, pos.y, pos.z).project(cam);
      const head = tmpV.set(pos.x, pos.y + c.body.height + 0.15, pos.z).project(cam);
      const behind = foot.z > 1 || head.z > 1;
      if (behind || Math.abs(foot.x) > 1.05 || Math.abs(head.y) > 1.2) {
        // Off screen: an arrow on the edge pointing at them.
        const rel = tmpT.set(pos.x - cp.x, 0, pos.z - cp.z);
        const yaw = g.player.yaw;
        const right = rel.x * Math.cos(yaw) - rel.z * Math.sin(yaw);
        const fwd = -rel.x * Math.sin(yaw) - rel.z * Math.cos(yaw);
        const a = Math.atan2(right, fwd);
        const R = Math.min(W, H) * 0.42;
        const x = W / 2 + Math.sin(a) * R, y = H / 2 - Math.cos(a) * R;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a);
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(0, -11);
        ctx.lineTo(8, 6);
        ctx.lineTo(-8, 6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = '#fff';
        ctx.fillText(`${Math.round(dist)}m`, x, y + 20);
        continue;
      }
      const x1 = (foot.x * 0.5 + 0.5) * W, y1 = (-foot.y * 0.5 + 0.5) * H, y0 = (-head.y * 0.5 + 0.5) * H;
      const h = Math.max(6, y1 - y0), w = h * 0.45;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 3;
      ctx.strokeRect(x1 - w / 2, y0, w, h);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x1 - w / 2, y0, w, h);
      // Health (green) and armour (blue) bars down the left side.
      const hp = Math.max(0, Math.min(1, c.health / 100)), ar = Math.max(0, Math.min(1, c.armor / 150));
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x1 - w / 2 - 7, y0, 4, h);
      ctx.fillStyle = '#4be37a';
      ctx.fillRect(x1 - w / 2 - 7, y0 + h * (1 - hp), 4, h * hp);
      if (ar > 0) {
        ctx.fillStyle = '#4aa8ff';
        ctx.fillRect(x1 - w / 2 - 12, y0 + h * (1 - ar), 3, h * ar);
      }
      ctx.fillStyle = '#fff';
      ctx.fillText(c.name, x1, y0 - 5);
      ctx.fillStyle = col;
      ctx.fillText(`${Math.round(dist)}m`, x1, y1 + 13);
    }
    const n = g.combatants.filter((c) => this.isEnemy(c)).length;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffd36a';
    ctx.fillText(`ESP · ${n} enemies`, 12, H - 12);
  }

  /** Teleport next to the nearest enemy (a few metres away, on the ground). */
  teleport() {
    const g = this.game, p = g.player;
    if (!this.allowed || !p.alive || p.mode !== 'ground') return false;
    let best: Combatant | null = null, bd = Infinity;
    for (const c of g.combatants) {
      if (!this.isEnemy(c)) continue;
      const d = c.body.pos.distanceToSquared(p.body.pos);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    if (!best) return false;
    this.used = true;
    const b = best.body.pos, a = Math.random() * Math.PI * 2;
    const x = b.x + Math.cos(a) * 12, z = b.z + Math.sin(a) * 12;
    p.body.pos.set(x, Math.max(b.y, g.map.groundAt(x, z)) + 1, z);
    p.body.vel.set(0, 0, 0);
    p.yaw = Math.atan2(-(b.x - x), -(b.z - z));
    p.pitch = 0;
    return true;
  }
}
