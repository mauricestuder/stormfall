import {
  AdditiveBlending, BufferGeometry, CylinderGeometry, DynamicDrawUsage, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, Object3D, Quaternion, Scene, Vector3,
} from 'three';
import { mergeToGeometry } from '../core/merge';
import {
  AMMO_INFO, AMMO_TYPES, ATT_KINDS, attKey, ATTACHMENTS, boxMesh, buildGunModel, darken, makeWeapon, randomRarity, randomWeaponId, RARITIES, THROWABLES, WEB_ENABLED,
  type AmmoType, type AttachmentKind, type ThrowKind, type WeaponId, type WeaponInstance,
} from './Weapon';

export type LootKind =
  | { type: 'weapon'; weapon: WeaponInstance }
  | { type: 'ammo'; ammo: AmmoType; amount: number }
  | { type: 'medkit'; count: number }
  | { type: 'plate'; count: number }
  | { type: 'attachment'; att: AttachmentKind }
  | { type: 'throwable'; t: ThrowKind; count: number };

function easeOutBack(x: number) {
  const c = 1.9;
  return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
}

export interface LootItem {
  kind: LootKind;
  pos: Vector3;
  /** Which instanced batch draws this item. */
  key: string;
  beam: Mesh | null;
  alive: boolean;
  phase: number;
  /** Popping out of a chest: flies in an arc from `from` to `pos` (t 0..1). */
  fly?: { from: Vector3; t: number };
  /** Network id (online battle royale). */
  nid?: number;
}

/** Openable container: regular loot chests, and supply drops (which fall from the sky first). */
export interface Chest {
  pos: Vector3;
  mesh: Group;
  lid: Object3D;
  opened: boolean;
  openT: number;
  supply: boolean;
  /** Supply drops are only openable once they've landed. */
  landed: boolean;
}

const beamGeo = new CylinderGeometry(0.05, 0.05, 1, 6, 1, true);
beamGeo.translate(0, 0.5, 0);

const beamMats = new Map<number, MeshBasicMaterial>();
function beamMat(color: number) {
  let m = beamMats.get(color);
  if (!m) beamMats.set(color, (m = new MeshBasicMaterial({ color, transparent: true, opacity: 0.45, blending: AdditiveBlending, depthWrite: false })));
  return m;
}

export function lootLabel(k: LootKind): string {
  switch (k.type) {
    case 'weapon': return `${k.weapon.rarity.name} ${k.weapon.def.name}`;
    case 'ammo': return `${AMMO_INFO[k.ammo].name} x${k.amount}`;
    case 'medkit': return `Medkit x${k.count}`;
    case 'plate': return `Armor Plate x${k.count}`;
    case 'attachment': return ATTACHMENTS[k.att].name;
    case 'throwable': return `${THROWABLES[k.t].name} x${k.count}`;
  }
}

export function randomThrowable(count: number): LootKind {
  const r = Math.random();
  if (WEB_ENABLED && Math.random() < 0.3) return { type: 'throwable', t: 'grapple', count: 3 };
  return { type: 'throwable', t: r < 0.5 ? 'frag' : r < 0.78 ? 'smoke' : 'flash', count };
}

export function randomAttachment(): LootKind {
  return { type: 'attachment', att: ATT_KINDS[Math.floor(Math.random() * ATT_KINDS.length)] };
}

interface Batch {
  mesh: InstancedMesh;
  cap: number;
  scale: number;
}

const lootMat = new MeshLambertMaterial({ vertexColors: true });

/**
 * Ground loot. Every distinct look (gun + rarity + attachments, ammo type, medkit...) is one
 * InstancedMesh, so a thousand items cost a few dozen draw calls instead of thousands.
 */
export class LootManager {
  items: LootItem[] = [];
  chests: Chest[] = [];
  /**
   * Finds a clear spot for an item thrown from `from` toward `to` (not inside a wall or a block,
   * resting on the floor below). Set by the game once the world exists.
   */
  place: ((from: Vector3, to: Vector3) => Vector3) | null = null;
  /** A chest was opened (sparkles, sound). */
  onOpen: (c: Chest) => void = () => {};
  /** Online: told about every item that appears or goes, and every chest opened here. */
  onSpawn: ((it: LootItem) => void) | null = null;
  /** Free height straight up from a point (so beams stop at the ceiling instead of poking through floors). */
  headroom: ((p: Vector3, max: number) => number) | null = null;

  /** Puts a beam at `p`, cut off at whatever is overhead. */
  seatBeam(beam: Mesh, p: Vector3, full: number) {
    beam.position.copy(p);
    beam.scale.y = Math.max(0.3, Math.min(full, this.headroom ? this.headroom(p, full) - 0.05 : full));
    beam.userData.full = full;
  }
  onRemove: ((it: LootItem) => void) | null = null;
  onChest: ((c: Chest) => void) | null = null;
  private time = 0;
  private batches = new Map<string, Batch>();

  constructor(private scene: Scene) {}

  private keyOf(k: LootKind) {
    switch (k.type) {
      case 'weapon': return `w:${k.weapon.def.id}:${k.weapon.rarity.tier}:${attKey(k.weapon)}`;
      case 'ammo': return 'a:' + k.ammo;
      case 'attachment': return 'x:' + k.att;
      case 'throwable': return 't:' + k.t;
      default: return k.type;
    }
  }

  private batch(key: string, k: LootKind) {
    let b = this.batches.get(key);
    if (!b) {
      const geo: BufferGeometry = mergeToGeometry(this.buildMesh(k));
      b = { mesh: this.makeInstanced(geo, 16), cap: 16, scale: k.type === 'weapon' ? 1.5 : 1 };
      this.batches.set(key, b);
    }
    return b;
  }

  private makeInstanced(geo: BufferGeometry, cap: number) {
    const mesh = new InstancedMesh(geo, lootMat, cap);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    this.scene.add(mesh);
    return mesh;
  }

  private grow(b: Batch) {
    const mesh = this.makeInstanced(b.mesh.geometry, b.cap * 2);
    mesh.instanceMatrix.array.set(b.mesh.instanceMatrix.array);
    mesh.count = b.mesh.count;
    this.scene.remove(b.mesh);
    b.mesh.dispose();
    b.mesh = mesh;
    b.cap *= 2;
  }

  spawn(kind: LootKind, pos: Vector3): LootItem {
    const key = this.keyOf(kind);
    this.batch(key, kind);
    let beam: Mesh | null = null;
    const color = kind.type === 'weapon' && kind.weapon.rarity.tier >= 1 ? kind.weapon.rarity.color : kind.type === 'attachment' ? ATTACHMENTS[kind.att].color : -1;
    if (color >= 0) {
      beam = new Mesh(beamGeo, beamMat(color));
      this.seatBeam(beam, pos, kind.type === 'weapon' ? 5 + kind.weapon.rarity.tier * 2 : 6);
      this.scene.add(beam);
    }
    const item: LootItem = { kind, pos: pos.clone(), key, beam, alive: true, phase: Math.random() * 6 };
    this.items.push(item);
    this.onSpawn?.(item);
    return item;
  }

  remove(item: LootItem) {
    if (!item.alive) return;
    item.alive = false;
    if (item.beam) this.scene.remove(item.beam);
    this.onRemove?.(item);
  }

  /** Clears every item and chest (before re-dealing the loot for an online match). */
  reset() {
    for (const it of this.items) if (it.beam) this.scene.remove(it.beam);
    for (const c of this.chests) this.scene.remove(c.mesh);
    this.items = [];
    this.chests = [];
  }

  /** Someone else opened this chest: just the lid (its loot arrives over the network). */
  markOpened(c: Chest) {
    if (c.opened) return;
    c.opened = true;
    this.onOpen(c);
  }

  /** Drop a pile of items in a small ring around `pos` (death boxes, dropped weapons). */
  spawnPile(kinds: LootKind[], pos: Vector3, from?: Vector3) {
    const out: LootItem[] = [];
    kinds.forEach((k, i) => {
      const a = (i / Math.max(1, kinds.length)) * Math.PI * 2 + Math.random();
      const r = kinds.length > 1 ? 1.1 : 0;
      let at = new Vector3(pos.x + Math.cos(a) * r, pos.y, pos.z + Math.sin(a) * r);
      if (this.place) at = this.place(from ?? pos, at);
      out.push(this.spawn(k, at));
    });
    return out;
  }

  addChest(pos: Vector3, supply = false): Chest {
    const mesh = new Group();
    const lid = new Group();
    if (supply) {
      mesh.add(boxMesh(1.4, 1.1, 1.4, 0x2f6fd1, 0x0a1a40).translateY(0.55));
      const band = boxMesh(1.46, 0.18, 1.46, 0xf2f2f2, 0x333333);
      band.position.y = 0.55;
      mesh.add(band);
      lid.add(boxMesh(1.46, 0.2, 1.46, 0xf2f2f2, 0x222222).translateZ(0.73));
      lid.position.set(0, 1.1, -0.73);
    } else {
      mesh.add(boxMesh(0.9, 0.5, 0.6, 0xd9a520, 0x5a3a00).translateY(0.25));
      const trim = boxMesh(0.94, 0.08, 0.64, 0x6b4a2f);
      trim.position.y = 0.42;
      mesh.add(trim);
      lid.add(boxMesh(0.92, 0.18, 0.62, 0xf0c040, 0x7a5500).translateZ(0.31));
      lid.position.set(0, 0.5, -0.31);
    }
    mesh.add(lid);
    mesh.position.copy(pos);
    mesh.rotation.y = Math.floor(Math.random() * 4) * (Math.PI / 2);
    this.scene.add(mesh);
    const c: Chest = { pos: pos.clone(), mesh, lid, opened: false, openT: 0, supply, landed: !supply };
    this.chests.push(c);
    return c;
  }

  /** Pops the chest open and sprays its loot around it. */
  openChest(c: Chest) {
    if (c.opened) return;
    c.opened = true;
    this.onChest?.(c);
    const pile: LootKind[] = [];
    const supplyPool: WeaponId[] = ['sniper', 'ar', 'lmg', 'dmr', 'rocket'];
    const pickW = (): WeaponId => (c.supply ? supplyPool[Math.floor(Math.random() * supplyPool.length)] : randomWeaponId());
    const rarity = c.supply ? RARITIES[3] : RARITIES[Math.min(3, Math.max(1, randomRarity().tier + (Math.random() < 0.15 ? 1 : 0)))];
    const w = makeWeapon(pickW(), rarity);
    pile.push({ type: 'weapon', weapon: w });
    pile.push({ type: 'ammo', ammo: w.def.ammo, amount: AMMO_INFO[w.def.ammo].pickup * (c.supply ? 2 : 1) });
    pile.push({ type: 'plate', count: c.supply ? 3 : 1 + (Math.random() < 0.5 ? 1 : 0) });
    if (c.supply || Math.random() < 0.6) pile.push({ type: 'medkit', count: c.supply ? 2 : 1 });
    if (!c.supply && Math.random() < 0.5) {
      const t = AMMO_TYPES[Math.floor(Math.random() * AMMO_TYPES.length)];
      pile.push({ type: 'ammo', ammo: t, amount: AMMO_INFO[t].pickup });
    }
    pile.push(randomThrowable(c.supply ? 2 : 1));
    if (WEB_ENABLED && (c.supply || Math.random() < 0.3)) pile.push({ type: 'throwable', t: 'grapple', count: 3 });
    const front = new Vector3(0, 0, 1.2).applyAxisAngle(new Vector3(0, 1, 0), c.mesh.rotation.y);
    // Everything pops out of the open lid and arcs onto the floor in front.
    const lip = c.pos.clone().setY(c.pos.y + (c.supply ? 1.1 : 0.5));
    for (const it of this.spawnPile(pile, c.pos.clone().add(front), c.pos)) it.fly = { from: lip.clone(), t: -Math.random() * 0.15 };
    this.onOpen(c);
  }

  nearestChest(pos: Vector3, maxDist: number): Chest | null {
    let best: Chest | null = null, bd = maxDist * maxDist;
    for (const c of this.chests) {
      if (c.opened || !c.landed || Math.abs(c.pos.y - pos.y) > 2.2) continue;
      const d = (c.pos.x - pos.x) ** 2 + (c.pos.z - pos.z) ** 2;
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  /**
   * Scatters loot over the given spots; about one in six spots holds a chest instead. `chestAt` finds
   * a clear place for a chest near the spot (or null when a chest doesn't belong there).
   */
  populate(spots: Vector3[], chestAt: (s: Vector3) => Vector3 | null = (s) => s) {
    for (const s of spots) {
      if (Math.random() < 0.16) {
        const at = chestAt(s);
        if (at) {
          this.addChest(at);
          continue;
        }
      }
      if (Math.random() < 0.3) continue;
      const pile: LootKind[] = [];
      const w = makeWeapon(randomWeaponId(), randomRarity());
      pile.push({ type: 'weapon', weapon: w });
      pile.push({ type: 'ammo', ammo: w.def.ammo, amount: AMMO_INFO[w.def.ammo].pickup });
      const r = Math.random();
      if (r < 0.35) pile.push({ type: 'plate', count: 1 + (Math.random() < 0.3 ? 1 : 0) });
      else if (r < 0.55) pile.push({ type: 'medkit', count: 1 });
      else if (r < 0.7) {
        const t = AMMO_TYPES[Math.floor(Math.random() * AMMO_TYPES.length)];
        pile.push({ type: 'ammo', ammo: t, amount: AMMO_INFO[t].pickup });
      } else if (r < 0.85) pile.push(randomThrowable(1));
      else if (r < 0.9) pile.push({ type: 'plate', count: 1 });
      else pile.push(WEB_ENABLED ? { type: 'throwable', t: 'grapple', count: 3 } : { type: 'medkit', count: 1 });
      this.spawnPile(pile, s);
    }
  }

  update(dt: number, viewer: Vector3) {
    this.time += dt;
    for (const b of this.batches.values()) b.mesh.count = 0;
    for (const it of this.items) {
      if (!it.alive) continue;
      const d2 = it.pos.distanceToSquared(viewer);
      if (it.beam) it.beam.visible = d2 < 260 * 260 && d2 > 4;
      if (d2 > 150 * 150) continue;
      it.phase += dt;
      const b = this.batches.get(it.key)!;
      if (b.mesh.count >= b.cap) this.grow(b);
      tmpQ.setFromAxisAngle(UP, it.phase * 1.2);
      tmpP.set(it.pos.x, it.pos.y + 0.45 + Math.sin(it.phase * 2.2) * 0.08, it.pos.z);
      if (it.fly) {
        // Arc out of the chest: up and over, spinning, then settle into the usual hover.
        const f = it.fly;
        f.t += dt / 0.55;
        const k = Math.max(0, Math.min(1, f.t));
        const e = 1 - (1 - k) * (1 - k);
        tmpP.lerpVectors(f.from, tmpP, e);
        tmpP.y += Math.sin(k * Math.PI) * 1.3;
        tmpQ.setFromAxisAngle(UP, it.phase * 1.2 + (1 - k) * 9);
        if (it.beam) it.beam.visible = k >= 1 && it.beam.visible;
        if (f.t >= 1) it.fly = undefined;
      }
      tmpS.setScalar(b.scale);
      b.mesh.setMatrixAt(b.mesh.count++, tmpM.compose(tmpP, tmpQ, tmpS));
    }
    for (const b of this.batches.values()) if (b.mesh.count) b.mesh.instanceMatrix.needsUpdate = true;
    for (const c of this.chests) {
      const d2 = c.pos.distanceToSquared(viewer);
      c.mesh.visible = d2 < 200 * 200;
      if (c.opened && c.openT < 1) {
        // Lid kicks open past its stop and settles back; the box gives a little hop.
        c.openT = Math.min(1, c.openT + dt * 2.4);
        c.lid.rotation.x = -easeOutBack(c.openT) * 1.9;
        c.mesh.scale.setScalar(1 + Math.sin(Math.min(1, c.openT * 2) * Math.PI) * 0.08);
      } else if (!c.opened && c.landed && d2 < 40 * 40) {
        // Unopened chests rattle now and then, as if something inside wants out.
        const w = (this.time + c.pos.x * 0.37) % 3.2;
        c.lid.rotation.x = w < 0.4 ? -Math.abs(Math.sin(w * 24)) * 0.06 : 0;
      }
    }
    // Compact dead entries occasionally.
    if (this.items.length > 64 && Math.random() < 0.02) this.items = this.items.filter((i) => i.alive);
  }

  /** Is there already an item within `dist` of this spot? */
  crowded(pos: Vector3, dist: number) {
    for (const it of this.items) {
      if (it.alive && Math.abs(it.pos.y - pos.y) < 1.2 && (it.pos.x - pos.x) ** 2 + (it.pos.z - pos.z) ** 2 < dist * dist) return true;
    }
    return false;
  }

  nearest(pos: Vector3, maxDist: number, filter?: (i: LootItem) => boolean): LootItem | null {
    let best: LootItem | null = null, bd = maxDist * maxDist;
    for (const it of this.items) {
      if (!it.alive) continue;
      const dy = Math.abs(it.pos.y - pos.y);
      if (dy > 2.5) continue;
      const d = (it.pos.x - pos.x) ** 2 + (it.pos.z - pos.z) ** 2;
      // The filter can be costly (line of sight), so only for items already in range.
      if (d < bd && (!filter || filter(it))) {
        bd = d;
        best = it;
      }
    }
    return best;
  }

  private buildMesh(k: LootKind): Object3D {
    switch (k.type) {
      case 'weapon':
        return buildGunModel(k.weapon);
      case 'ammo': {
        const c = AMMO_INFO[k.ammo].color;
        return boxMesh(0.32, 0.22, 0.22, c, darken(c));
      }
      case 'medkit': {
        const g = new Group();
        g.add(boxMesh(0.45, 0.28, 0.32, 0xf5f5f5, 0x333333));
        g.add(boxMesh(0.2, 0.3, 0.06, 0xe53935, 0x551111).translateZ(0.14));
        g.add(boxMesh(0.06, 0.3, 0.2, 0xe53935, 0x551111).translateZ(0.14).rotateZ(Math.PI / 2));
        return g;
      }
      case 'plate':
        return boxMesh(0.42, 0.08, 0.34, 0x39a0ff, 0x0d3a66);
      case 'attachment': {
        const g = new Group(), c = ATTACHMENTS[k.att].color;
        if (k.att === 'scope') {
          g.add(boxMesh(0.12, 0.12, 0.42, 0x2a2d31));
          g.add(boxMesh(0.16, 0.16, 0.06, c).translateZ(-0.2));
        } else if (k.att === 'extmag') {
          g.add(boxMesh(0.1, 0.42, 0.16, 0x2a2d31));
          g.add(boxMesh(0.11, 0.08, 0.17, c).translateY(-0.2));
        } else if (k.att === 'muzzle') {
          g.add(boxMesh(0.14, 0.14, 0.34, 0x2a2d31));
          for (let i = 0; i < 3; i++) g.add(boxMesh(0.16, 0.03, 0.04, c).translateZ(-0.1 + i * 0.1).translateY(0.08));
        } else {
          g.add(boxMesh(0.08, 0.3, 0.1, 0x2a2d31));
          g.add(boxMesh(0.14, 0.05, 0.14, c).translateY(0.15));
        }
        g.add(boxMesh(0.36, 0.03, 0.36, c, darken(c)).translateY(-0.24));
        return g;
      }
      case 'throwable': {
        const c = THROWABLES[k.t].color;
        const g = new Group();
        g.add(k.t === 'frag' ? boxMesh(0.2, 0.22, 0.2, c, darken(c)) : boxMesh(0.14, 0.26, 0.14, c, darken(c)));
        g.add(boxMesh(0.06, 0.06, 0.06, 0xb0b4b8).translateY(0.15));
        return g;
      }
    }
  }
}

const UP = new Vector3(0, 1, 0);
const tmpM = new Matrix4(), tmpQ = new Quaternion(), tmpP = new Vector3(), tmpS = new Vector3();
