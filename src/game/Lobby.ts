import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, CylinderGeometry, Group, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, PerspectiveCamera, Points, PointsMaterial, SpotLight, Vector3,
} from 'three';
import { bodyForSkin, Character } from '../bots/Character';
import { makeWeapon, RARITIES } from '../weapons/Weapon';
import { buildGlider, GLIDER_HEIGHT } from '../world/Glider';
import { BACKS, buildBackBling, EMOTES, GLIDERS, SHOWCASE, TRAILS, trailColor } from './Cosmetics';
import type { Game } from './Game';
import { skinOf } from './Skins';

const MOTES = 60;
const HERO_Y = 0.26;
/** Party pads behind the hero, left and right. */
const PADS = [new Vector3(-1.5, 0, -1.3), new Vector3(1.5, 0, -1.3)];
const Y = new Vector3(0, 1, 0);
const tmpFocus = new Vector3();

interface Pose { r: Vector3 | null; l: Vector3 | null; y?: number; x?: number; rx?: number; ry?: number; rz?: number; legs?: number; gun?: boolean }

/** Emote poses at time t (seconds since it started). Directions are in character space (+x = right hand, -z = forward). */
function emotePose(i: number, t: number): Pose {
  const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
  switch (i) {
    case 0: // Wave
      return { r: v(0.35 + Math.sin(t * 10) * 0.35, 0.95, -0.25), l: v(0.15, -1, 0.05) };
    case 1: { // Groove
      const b = Math.sin(t * 7.5);
      return { r: v(0.45, b * 0.7, -0.7), l: v(-0.45, -b * 0.7, -0.7), y: Math.abs(b) * 0.07, ry: Math.sin(t * 3.75) * 0.35, legs: b * 0.35 };
    }
    case 2: { // Floss
      const s = Math.sin(t * 9), z = Math.cos(t * 9) * 0.55;
      return { r: v(s * 0.9, -0.6, -z), l: v(s * 0.9, -0.6, z), x: -s * 0.07, rz: s * 0.08 };
    }
    case 3: { // Flex
      const p = 0.5 + 0.5 * Math.sin(t * 6);
      return { r: v(1, 0.3 + p * 0.6, 0.1), l: v(-1, 0.3 + p * 0.6, 0.1), y: -0.04 * p };
    }
    case 4: // Salute
      return { r: v(-0.2, 0.3, -0.25), l: v(0.12, -1, 0.04), rx: -0.04 };
    case 5: { // Backflip
      const p = Math.min(1, t / 1.1);
      const e = p * p * (3 - 2 * p);
      return p < 1 ? { r: v(0.3, 1, 0), l: v(-0.3, 1, 0), y: 4 * p * (1 - p) * 1.1, rx: e * Math.PI * 2 } : { r: v(0.9, 0.7, -0.1), l: v(-0.9, 0.7, -0.1) };
    }
    default: { // Tornado
      const p = Math.min(1, t / 2.6), e = p * p * (3 - 2 * p);
      return { r: v(1, 0.15, 0), l: v(-1, 0.15, 0), ry: e * Math.PI * 4, y: Math.sin(p * Math.PI) * 0.12 };
    }
  }
}
const EMOTE_TIME = [3, 3.2, 3.2, 3, 2.4, 2.2, 3];

/**
 * The front-end lobby: your soldier on a podium out on the island itself, overlooking a town, with
 * two empty party podiums behind ("invite friends"). Everything lives in one group placed in the
 * game's own scene, so the real map, sky, weather and lighting are the backdrop.
 * Drag to spin the character.
 */
export class Lobby {
  /** Podiums, hero and glider preview, positioned on the island. */
  readonly group = new Group();
  /** World position of the main podium. */
  readonly spot = new Vector3();
  private placed = false;
  private hero: Character | null = null;
  private heroKey = '';
  private motes: Points;
  private motePos: Float32Array;
  private moteMat: PointsMaterial;
  private rings: Mesh[] = [];
  private key: SpotLight;
  private t = 0;
  private spin = 0;
  private spinVel = 0;
  private slots: HTMLElement[] = [];
  private nameEl: HTMLElement | null = null;
  private dragX: number | null = null;
  private emote = -1;
  private emoteT = 0;
  private nextEmote = 9;
  private armR = new Vector3();
  private armL = new Vector3();
  private glider: Group | null = null;
  private gliderKey = '';
  private gliderK = 0;
  /** Set by the locker while the Glider tab is open. */
  showGlider = false;
  /** A side panel is open (Locker, Career, ...): the hero moves to the right to make room. */
  locker = false;
  private lockerK = 0;
  /** Friends in your room, standing on the two party podiums. */
  private mates: (Character | null)[] = [null, null];
  private matesKey = '';

  constructor(private game: Game) {
    // The main podium and two party podiums. Deep bases so uneven ground never shows a gap.
    const stage = (x: number, z: number, r: number, ring: number, glow: number) => {
      const base = new Mesh(new CylinderGeometry(r, r + 0.14, 0.9, 40), new MeshLambertMaterial({ color: 0x1e1b1d }));
      base.position.set(x, -0.21, z);
      const top = new Mesh(new CylinderGeometry(r - 0.08, r - 0.08, 0.02, 40), new MeshLambertMaterial({ color: 0x3a3437 }));
      top.position.set(x, 0.25, z);
      const rim = new Mesh(new CylinderGeometry(r + 0.01, r + 0.03, 0.05, 40, 1, true), new MeshBasicMaterial({ color: ring, transparent: true, opacity: glow }));
      rim.position.set(x, 0.2, z);
      for (const m of [base, top]) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
      this.group.add(base, top, rim);
      this.rings.push(rim);
    };
    stage(0, 0, 1.2, 0xe8323c, 0.95);
    for (const p of PADS) stage(p.x, p.z, 0.7, 0x8a2a30, 0.6);

    // A soft key light on the hero so they read at any time of day.
    this.key = new SpotLight(0xfff2e6, 30, 14, 0.5, 0.7, 1.3);
    this.key.position.set(-1.8, 4.2, 4.2);
    this.key.target.position.set(0, 1.1, 0);
    this.group.add(this.key, this.key.target);

    // Sparkles in your trail's colour (only when a trail is equipped).
    this.motePos = new Float32Array(MOTES * 3);
    for (let i = 0; i < MOTES; i++) this.resetMote(i, true);
    const mg = new BufferGeometry();
    mg.setAttribute('position', new BufferAttribute(this.motePos, 3));
    this.moteMat = new PointsMaterial({ color: 0xffffff, size: 0.05, transparent: true, opacity: 0.8, blending: AdditiveBlending, depthWrite: false });
    this.motes = new Points(mg, this.moteMat);
    this.motes.frustumCulled = false;
    this.group.add(this.motes);
    game.scene.add(this.group);

    this.slots = [...document.querySelectorAll<HTMLElement>('#title .party-slot')];
    this.nameEl = document.getElementById('lobby-name');
    // Drag anywhere on the empty part of the screen to turn the character.
    const title = document.getElementById('title');
    title?.addEventListener('pointerdown', (e) => {
      const el = e.target as HTMLElement;
      if (el.closest('button, a, input, select, .controls-card, .mode-card, .locker-panel, .career-panel, .options-host, .arena-host')) return;
      this.dragX = e.clientX;
    });
    addEventListener('pointermove', (e) => {
      if (this.dragX === null) return;
      this.spinVel = (e.clientX - this.dragX) * 0.012;
      this.spin += this.spinVel;
      this.dragX = e.clientX;
    });
    addEventListener('pointerup', () => (this.dragX = null));
  }

  private resetMote(i: number, anywhere: boolean) {
    const a = Math.random() * Math.PI * 2, r = 0.4 + Math.random() * 1.2;
    this.motePos[i * 3] = Math.cos(a) * r;
    this.motePos[i * 3 + 1] = anywhere ? Math.random() * 2.6 : 0.3;
    this.motePos[i * 3 + 2] = Math.sin(a) * r;
  }

  /** Where the lobby camera focuses (the hero's chest). */
  get focusPoint() {
    return this.hero ? this.hero.root.getWorldPosition(tmpFocus).setY(this.spot.y + 1.2) : tmpFocus.copy(this.spot);
  }

  /** Shown while you're in the menus (before a match). */
  get active() {
    return this.game.state === 'title';
  }

  /** Play the equipped emote now. */
  playEmote() {
    this.emote = this.game.profile.data.emote;
    this.emoteT = 0;
    this.nextEmote = 14 + Math.random() * 8;
  }

  /**
   * Find a flat, open spot on a rise just outside a town, facing into it, so the town fills the
   * background. The camera side must be clear too (no walls or trees in the shot).
   */
  private place() {
    const map = this.game.map, world = this.game.world;
    const pois = [...map.pois].sort((a, b) => b.radius - a.radius);
    let best = -Infinity, bx = 0, bz = 0, by = 0, bdx = 0, bdz = -1;
    const clearOfTrees = (x: number, z: number, r: number) => !map.trees.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < (r + t.r * 0.5) ** 2);
    for (const [pi, poi] of pois.slice(0, 4).entries()) {
      for (let ring = 0; ring < 6; ring++) {
        const dist = poi.radius + 18 + ring * 14;
        for (let k = 0; k < 28; k++) {
          const a = (k / 28) * Math.PI * 2;
          const x = poi.x + Math.cos(a) * dist, z = poi.z + Math.sin(a) * dist;
          if (Math.hypot(x, z) > map.half - 60 || map.isWater(x, z)) continue;
          const dx = (poi.x - x) / dist, dz = (poi.z - z) / dist;
          // Flat podium ground.
          let lo = Infinity, hi = -Infinity;
          for (const [ox, oz] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3], [2.2, 2.2], [-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2]]) {
            const h = map.groundAt(x + ox, z + oz);
            lo = Math.min(lo, h);
            hi = Math.max(hi, h);
          }
          if (hi - lo > 0.8) continue;
          const g = hi;
          if (world.anyOverlap(x - 3.5, g + 0.3, z - 3.5, x + 3.5, g + 4, z + 3.5)) continue;
          // Camera behind the podium, looking at the town: ground below eye level and nothing in the way.
          let blocked = false;
          for (let s = 2; s <= 11 && !blocked; s += 3) {
            const cx = x - dx * s, cz = z - dz * s;
            if (map.groundAt(cx, cz) > g + 1.2 || world.anyOverlap(cx - 1.2, g + 0.5, cz - 1.2, cx + 1.2, g + 3.5, cz + 1.2) || !clearOfTrees(cx, cz, 3)) blocked = true;
          }
          if (blocked || !clearOfTrees(x, z, 4.5)) continue;
          // The view: how far the town sits below us (hills in between cost a lot).
          let view = 0;
          for (let s = 8; s < dist; s += 8) view = Math.min(view, g + 1.5 - map.groundAt(x + dx * s, z + dz * s));
          const score = view * 2 + Math.min(12, g - poi.y) * 0.3 - pi * 2 - ring * 0.4;
          if (score > best) {
            best = score;
            [bx, bz, by, bdx, bdz] = [x, z, g, dx, dz];
          }
        }
      }
    }
    if (best === -Infinity && pois[0]) {
      bx = pois[0].x;
      bz = pois[0].z;
      by = map.groundAt(bx, bz);
    }
    this.spot.set(bx, by, bz);
    this.group.position.copy(this.spot);
    // Local -z (behind the hero) points at the town.
    this.group.rotation.y = Math.atan2(-bdx, -bdz);
    this.group.updateMatrixWorld(true);
    this.placed = true;
  }

  /** Rebuild the hero when the outfit, back bling, showcase gun or camo changes. */
  private syncHero() {
    const d = this.game.profile.data;
    const camo = this.game.profile.camoColor;
    const key = `${d.skin}|${d.back}|${d.showcase}|${camo}|${bodyForSkin(skinOf(d.skin))}`;
    if (key === this.heroKey && this.hero) return;
    this.heroKey = key;
    if (this.hero) this.group.remove(this.hero.root);
    const s = skinOf(d.skin);
    this.hero = new Character(new Color(s.suit), new Color(s.trim), undefined, s, true, bodyForSkin(s));
    const w = makeWeapon(SHOWCASE[d.showcase] ?? 'ar', RARITIES[3]);
    w.att = { scope: false, extmag: false, grip: false, muzzle: false };
    if (camo !== null) w.def = { ...w.def, bodyColor: camo };
    this.hero.setGun(w);
    this.hero.setBack(BACKS[d.back] ? buildBackBling(d.back) : null);
    this.hero.root.rotation.order = 'YXZ';
    this.hero.root.position.y = HERO_Y;
    this.group.add(this.hero.root);
    [this.armR, this.armL] = Character.holdDirs;
  }

  /** Your party (online room) on the side podiums, in their own outfits. */
  private syncParty(dt: number) {
    const net = this.game.menus?.arena?.net;
    const others = net && !net.closed ? net.roster.filter((r) => r.id !== net.myId).slice(0, PADS.length) : [];
    const key = others.map((r) => `${r.id}:${r.skin ?? 0}:${r.name}`).join(',');
    if (key !== this.matesKey) {
      this.matesKey = key;
      for (const m of this.mates) if (m) this.group.remove(m.root);
      this.mates = PADS.map((pad, i) => {
        const r = others[i];
        if (!r) return null;
        const s = skinOf(r.skin ?? 0);
        const c = new Character(new Color(s.suit), new Color(s.trim), undefined, s, true, bodyForSkin(s));
        c.setGun(makeWeapon('ar', RARITIES[1]));
        c.root.rotation.order = 'YXZ';
        c.root.position.set(pad.x, HERO_Y, pad.z);
        c.root.scale.setScalar(0.92);
        this.group.add(c.root);
        return c;
      });
      this.slots.forEach((el, i) => {
        const r = others[i];
        el.classList.toggle('filled', !!r);
        if (r) {
          el.innerHTML = '<span class="mate-name"></span>';
          el.firstElementChild!.textContent = r.name;
        } else el.innerHTML = '<b>+</b><span>INVITE<br>FRIENDS</span>';
      });
    }
    const [hr, hl] = Character.holdDirs;
    this.mates.forEach((c, i) => {
      if (!c) return;
      c.pose(hr, hl);
      c.animate(dt, 0, true, false);
      c.root.rotation.set(0, Math.PI + (i ? -0.35 : 0.35) + Math.sin(this.t * 0.5 + i * 2) * 0.08, 0);
    });
  }

  private syncGlider() {
    const d = this.game.profile.data, s = skinOf(d.skin), gi = d.glider, gd = GLIDERS[gi] ?? GLIDERS[0];
    const key = gi > 0 ? `d${gi}` : `o${s.glider}`;
    if (key === this.gliderKey && this.glider) return;
    this.gliderKey = key;
    if (this.glider) this.group.remove(this.glider);
    this.glider = gi > 0 ? buildGlider(gd.color, gd.accent, gd.pattern) : buildGlider(s.glider);
    this.group.add(this.glider);
  }

  /** Animate the hero and aim the game camera at the podium. Called each frame while in the menus. */
  update(dt: number, cam: PerspectiveCamera) {
    if (!this.placed) this.place();
    this.t += dt;
    this.syncHero();
    this.syncGlider();
    this.syncParty(dt);
    this.group.visible = true;
    const w = innerWidth, h = innerHeight;
    const aspect = w / Math.max(1, h);
    // With a side panel open the hero stands about two thirds of the way across; the camera turns
    // left to put them there. Pull back a little to fit the glider in.
    this.gliderK += ((this.showGlider ? 1 : 0) - this.gliderK) * Math.min(1, dt * 5);
    this.lockerK += ((this.locker ? 1 : 0) - this.lockerK) * Math.min(1, dt * 6);
    const dist = (aspect < 1.2 ? 7.6 : 6.4) * (1 + this.gliderK * 0.3);
    const f = 0.5 + ((aspect < 1.2 ? 0.63 : 0.65) - 0.5) * this.lockerK;
    const tanX = Math.tan((18 * Math.PI) / 180) * aspect;
    const lookY = 1.05 + this.gliderK * 0.75;
    cam.fov = 36;
    cam.near = 0.1;
    cam.aspect = aspect;
    cam.position.copy(this.group.localToWorld(tmp.set(0, 1.5 + this.gliderK * 0.5, dist)));
    cam.lookAt(this.group.localToWorld(tmp.set(-(f - 0.5) * 2 * tanX * dist, lookY, 0)));
    cam.updateProjectionMatrix();
    this.key.intensity = this.game.env.isNight ? 12 : 9;

    const hero = this.hero!;
    if (this.dragX === null) {
      this.spinVel *= Math.exp(-3 * dt);
      this.spin += this.spinVel;
      this.spin *= Math.exp(-0.6 * dt); // drift back to facing you
    }
    // Every so often, do the equipped emote.
    this.nextEmote -= dt;
    if (this.nextEmote <= 0 && this.emote < 0 && !this.showGlider) this.playEmote();
    let pose: Pose = { r: null, l: null };
    if (this.emote >= 0) {
      this.emoteT += dt;
      if (this.emoteT > EMOTE_TIME[this.emote % EMOTES.length]) this.emote = -1;
      else pose = emotePose(this.emote, this.emoteT);
    }
    const [hr, hl] = Character.holdDirs;
    if (this.showGlider) pose = { r: new Vector3(0.25, 1, -0.1), l: new Vector3(-0.25, 1, -0.1), gun: false };
    const k = 1 - Math.exp(-14 * dt);
    this.armR.lerp(pose.r ? pose.r.normalize() : hr, k).normalize();
    this.armL.lerp(pose.l ? pose.l.normalize() : hl, k).normalize();
    hero.pose(this.armR, this.armL);
    hero.gunMount.visible = pose.gun ?? (pose.r === null);

    hero.animate(dt, 0, true, false);
    const legs = pose.legs ?? 0;
    hero.legsList[0].rotation.x = legs;
    hero.legsList[1].rotation.x = -legs;
    const yaw = Math.PI - 0.3 * this.lockerK + Math.sin(this.t * 0.45) * 0.1 + this.spin + (pose.ry ?? 0);
    const rx = pose.rx ?? 0;
    hero.root.rotation.set(rx, yaw, pose.rz ?? 0);
    hero.root.scale.y *= 1 + Math.sin(this.t * 1.8) * 0.008;
    // Flip around the hips, not the feet.
    const hip = 0.95;
    tmp.set(pose.x ?? 0, hip - hip * Math.cos(rx), -hip * Math.sin(rx)).applyAxisAngle(Y, yaw);
    hero.root.position.set(tmp.x, HERO_Y + (pose.y ?? 0) + tmp.y, tmp.z);

    // Glider preview over the hero's head while the Glider tab is open.
    const g = this.glider!;
    g.visible = this.gliderK > 0.02;
    if (g.visible) {
      const s = 0.62 * Math.max(0.05, this.gliderK);
      g.scale.setScalar(s);
      g.position.set(0, HERO_Y + 1.5 + (GLIDER_HEIGHT - 1.5) * s + Math.sin(this.t * 1.3) * 0.05, 0);
      g.rotation.set(0.05, yaw - Math.PI, Math.sin(this.t * 0.9) * 0.05);
    }

    for (const r of this.rings) (r.material as MeshBasicMaterial).opacity = (r === this.rings[0] ? 0.8 : 0.45) + Math.sin(this.t * 2.2) * 0.12;
    const tc = trailColor(TRAILS[this.game.profile.data.trail] ?? TRAILS[0], this.t);
    this.motes.visible = tc !== null;
    if (tc !== null) {
      this.moteMat.color.setHex(tc);
      for (let i = 0; i < MOTES; i++) {
        this.motePos[i * 3 + 1] += dt * (0.25 + (i % 7) * 0.05);
        this.motePos[i * 3] += Math.sin(this.t * 2 + i) * dt * 0.1;
        if (this.motePos[i * 3 + 1] > 2.8) this.resetMote(i, false);
      }
      this.motes.geometry.attributes.position.needsUpdate = true;
    }

    // Pin the "invite friends" buttons over the pads and the name plate under the hero.
    this.slots.forEach((el, i) => {
      const v = this.group.localToWorld(tmp.set(PADS[i].x, this.mates[i] ? 0.05 : 1.1, PADS[i].z + (this.mates[i] ? 0.75 : 0))).project(cam);
      el.style.left = `${((v.x + 1) / 2) * 100}%`;
      el.style.top = `${((1 - v.y) / 2) * 100}%`;
    });
    if (this.nameEl) {
      const v = this.group.localToWorld(tmp.set(0, 0.02, 1)).project(cam);
      this.nameEl.style.left = `${((v.x + 1) / 2) * 100}%`;
      this.nameEl.style.top = `${((1 - v.y) / 2) * 100}%`;
    }
  }
}

const tmp = new Vector3();
