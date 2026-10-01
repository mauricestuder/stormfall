import { Color, type Scene } from 'three';
import { bodyForSkin, Character } from '../bots/Character';
import { skinOf } from '../game/Skins';
import type { Player } from './Player';

/**
 * Your own legs in first person: look down and you see them walk, crouch and kick out in a slide.
 * Built from your skin, so they match what everyone else sees.
 */
export class SelfBody {
  private ch: Character | null = null;
  private skinId = -1;

  constructor(private scene: Scene) {}

  update(dt: number, p: Player, skin: number, show: boolean) {
    if (skin !== this.skinId) {
      if (this.ch) this.scene.remove(this.ch.root);
      const s = skinOf(skin);
      this.ch = new Character(new Color(s.suit), new Color(s.trim), undefined, s, false, bodyForSkin(s));
      this.ch.legsOnly();
      this.scene.add(this.ch.root);
      this.skinId = skin;
    }
    const ch = this.ch!, r = ch.root;
    r.visible = show;
    if (!show) return;
    // A little behind the eye so the knees don't poke into the camera.
    const back = p.sliding ? 0.3 : 0.1;
    r.position.set(p.body.pos.x + Math.sin(p.yaw) * back, p.body.pos.y, p.body.pos.z + Math.cos(p.yaw) * back);
    r.rotation.set(0, p.yaw, 0);
    const hs = Math.hypot(p.body.vel.x, p.body.vel.z);
    ch.animate(dt, p.sliding ? 0 : hs, p.body.onGround || p.mode === 'zipline', p.crouching, p.sliding || p.mode === 'glide');
  }
}
