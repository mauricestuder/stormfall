import type { Particles } from '../game/Particles';
import {
  AdditiveBlending, BoxGeometry, ConeGeometry, CylinderGeometry, DoubleSide, Group, IcosahedronGeometry, InstancedMesh,
  Color, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, PointLight, Scene, ShaderMaterial, Vector3,
} from 'three';
import { CollisionWorld, rayBox, type Box } from '../core/Collision';
import type { Chest, LootManager } from '../weapons/Loot';
import { boxMesh } from '../weapons/Weapon';
import type { GameMap } from './Map';

interface Pad {
  pos: Vector3;
  arrows: Group;
  ring: Mesh;
  cooldown: number;
}

interface Barrel {
  pos: Vector3;
  box: Box;
  hp: number;
  alive: boolean;
  fuse: number;
}

interface Fire {
  pos: Vector3;
  flames: Mesh[];
  big: boolean;
}


interface SupplyDrop {
  chest: Chest;
  chute: Group;
  beam: Mesh;
  smokeLeft: number;
}

const PAD_RADIUS = 1.7;

/**
 * Living parts of the map: launch pads, wind turbines, lighthouse beams, campfires,
 * explosive barrels, supply drops, and the bush occluders that hide you from bots.
 */
export class Features {
  pads: Pad[] = [];
  barrels: Barrel[] = [];
  drops: SupplyDrop[] = [];
  /** Bush volumes; only used for bot line-of-sight. */
  bushWorld: CollisionWorld;
  /** Explosions requested this step (barrels chain-reacting); the game applies damage. */
  pendingExplosions: { pos: Vector3; radius: number; damage: number; src: object }[] = [];

  private rotors: Group[] = [];
  private beams: Group[] = [];
  private fires: Fire[] = [];
  private fireLight = new PointLight(0xff8a3a, 0, 12, 1.6);
  private barrelMesh: InstancedMesh;
  private blasts: { mesh: Mesh; life: number; radius: number }[] = [];
  private blastLight = new PointLight(0xffa040, 0, 32, 1.6);
  private time = 0;

  constructor(private scene: Scene, private map: GameMap, private world: CollisionWorld, private loot: LootManager, private fx: Particles) {
    this.bushWorld = new CollisionWorld(map.size + 64, false);
    for (const b of map.bushes) {
      const r = b.r * 0.95;
      this.bushWorld.add({ minX: b.x - r, minY: b.y - 0.3, minZ: b.z - r, maxX: b.x + r, maxY: b.y + b.r * 1.15, maxZ: b.z + r });
    }
    this.buildPads();
    this.buildTurbines();
    this.buildLighthouses();
    this.buildFires();
    this.barrelMesh = this.buildBarrels();
    scene.add(this.fireLight, this.blastLight);
  }

  // ---------- construction ----------

  private buildPads() {
    const baseGeo = new CylinderGeometry(PAD_RADIUS, PAD_RADIUS + 0.2, 0.3, 20);
    const ringGeo = new CylinderGeometry(PAD_RADIUS * 0.85, PAD_RADIUS * 0.85, 0.06, 24, 1, true);
    const arrowGeo = new ConeGeometry(0.45, 0.6, 4);
    for (const pos of this.map.padSpots) {
      const g = new Group();
      g.position.copy(pos);
      const base = new Mesh(baseGeo, new MeshLambertMaterial({ color: 0x2b3440 }));
      base.position.y = 0.15;
      const ring = new Mesh(ringGeo, new MeshBasicMaterial({ color: 0x3ff0ff, transparent: true, opacity: 0.9, side: DoubleSide }));
      ring.position.y = 0.33;
      const top = new Mesh(new CylinderGeometry(PAD_RADIUS * 0.7, PAD_RADIUS * 0.7, 0.02, 20), new MeshBasicMaterial({ color: 0x1ab6d6 }));
      top.position.y = 0.31;
      const arrows = new Group();
      for (let i = 0; i < 3; i++) {
        const a = new Mesh(arrowGeo, new MeshBasicMaterial({ color: 0x9ffcff, transparent: true, opacity: 0.8, blending: AdditiveBlending, depthWrite: false }));
        a.position.y = 0.8 + i * 0.8;
        arrows.add(a);
      }
      g.add(base, ring, top, arrows);
      this.scene.add(g);
      this.pads.push({ pos: pos.clone(), arrows, ring, cooldown: 0 });
    }
  }

  private buildTurbines() {
    const bladeGeo = new BoxGeometry(0.7, 12, 0.18);
    bladeGeo.translate(0, 6.3, 0);
    const mat = new MeshLambertMaterial({ color: 0xf4f4f2 });
    for (const t of this.map.turbineSpots) {
      const head = new Group();
      head.position.set(t.x, t.y, t.z);
      head.rotation.y = t.yaw;
      const nacelle = new Mesh(new BoxGeometry(1.4, 1.4, 4), mat);
      nacelle.position.z = 0.8;
      const rotor = new Group();
      rotor.position.z = -1.4;
      rotor.add(new Mesh(new ConeGeometry(0.7, 1.2, 8).rotateX(-Math.PI / 2), mat));
      for (let i = 0; i < 3; i++) {
        const blade = new Mesh(bladeGeo, mat);
        blade.rotation.z = (i / 3) * Math.PI * 2;
        blade.castShadow = true;
        rotor.add(blade);
      }
      rotor.rotation.z = Math.random() * 6;
      head.add(nacelle, rotor);
      nacelle.castShadow = true;
      this.scene.add(head);
      this.rotors.push(rotor);
    }
  }

  private buildLighthouses() {
    const coneGeo = new ConeGeometry(6, 90, 16, 1, true);
    coneGeo.translate(0, -45, 0);
    coneGeo.rotateX(-Math.PI / 2); // tip at the lamp, widening outward along +Z
    const mat = new ShaderMaterial({
      transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide,
      uniforms: { color: { value: new Color(0xfff2a0) }, opacity: { value: 0.16 } },
      vertexShader: `
        varying float vNear;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vNear = distance(w.xyz, cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: `
        uniform vec3 color; uniform float opacity; varying float vNear;
        void main() { gl_FragColor = vec4(color * opacity * smoothstep(8.0, 45.0, vNear), 1.0); }`,
    });
    for (const pos of this.map.lighthouseSpots) {
      const g = new Group();
      g.position.copy(pos);
      for (const s of [1, -1]) {
        const beam = new Mesh(coneGeo, mat);
        beam.rotation.y = s > 0 ? 0 : Math.PI;
        beam.rotation.x = 0.05;
        g.add(beam);
      }
      this.scene.add(g);
      this.beams.push(g);
    }
  }

  private buildFires() {
    const flameGeo = new ConeGeometry(0.28, 0.9, 5);
    flameGeo.translate(0, 0.45, 0);
    for (const pos of this.map.fireSpots) {
      const big = pos.y - this.map.groundAt(pos.x, pos.z) > 0.5; // wreck fires sit up on the debris
      const flames: Mesh[] = [];
      for (let i = 0; i < 4; i++) {
        const f = new Mesh(flameGeo, new MeshBasicMaterial({ color: i % 2 ? 0xffc040 : 0xff6a1a, transparent: true, opacity: 0.9 }));
        f.position.set(pos.x + (Math.random() - 0.5) * 0.4, pos.y, pos.z + (Math.random() - 0.5) * 0.4);
        if (big) f.scale.setScalar(1.8);
        this.scene.add(f);
        flames.push(f);
      }
      this.fires.push({ pos: pos.clone(), flames, big });
    }
  }

  private buildBarrels() {
    const geo = new CylinderGeometry(0.4, 0.4, 1.1, 12);
    geo.translate(0, 0.55, 0);
    const mesh = new InstancedMesh(geo, new MeshLambertMaterial({ color: 0xc8281e, emissive: 0x220000 }), Math.max(1, this.map.barrelSpots.length));
    const m = new Matrix4();
    this.map.barrelSpots.forEach((p, i) => {
      const y = Math.max(p.y, this.map.groundAt(p.x, p.z));
      const box: Box = { minX: p.x - 0.4, minY: y, minZ: p.z - 0.4, maxX: p.x + 0.4, maxY: y + 1.1, maxZ: p.z + 0.4 };
      this.world.add(box);
      this.barrels.push({ pos: new Vector3(p.x, y, p.z), box, hp: 30, alive: true, fuse: -1 });
      mesh.setMatrixAt(i, m.makeTranslation(p.x, y, p.z));
    });
    mesh.count = this.map.barrelSpots.length;
    mesh.castShadow = true;
    this.scene.add(mesh);
    return mesh;
  }

  // ---------- queries ----------

  /** Pad the given feet position is standing on, if it's ready to fire. */
  padAt(pos: Vector3): Pad | null {
    for (const p of this.pads) {
      if (p.cooldown > 0) continue;
      const dx = p.pos.x - pos.x, dz = p.pos.z - pos.z, dy = pos.y - p.pos.y;
      if (dx * dx + dz * dz < PAD_RADIUS * PAD_RADIUS && dy > -0.5 && dy < 1.2) return p;
    }
    return null;
  }

  firePad(p: Pad) {
    p.cooldown = 0.6;
    this.puff(p.pos.clone().setY(p.pos.y + 0.5), 0xc8faff, 8, 3, 0.8);
  }

  /** True if a bush blocks the view between two points. */
  bushBlocks(from: Vector3, dir: Vector3, dist: number) {
    return this.bushWorld.raycast(from, dir, dist) < dist - 0.5;
  }

  rayBarrel(o: Vector3, dir: Vector3, maxT: number): { barrel: Barrel; t: number } | null {
    const ix = 1 / dir.x, iy = 1 / dir.y, iz = 1 / dir.z;
    let best: { barrel: Barrel; t: number } | null = null;
    for (const b of this.barrels) {
      if (!b.alive) continue;
      const t = rayBox(o, ix, iy, iz, b.box);
      if (t < maxT && (!best || t < best.t)) best = { barrel: b, t };
    }
    return best;
  }

  damageBarrel(b: Barrel, amount: number) {
    if (!b.alive || b.fuse >= 0) return;
    b.hp -= amount;
    if (b.hp <= 0) b.fuse = 0.05;
  }

  /** Called by the game for explosions near barrels so they chain. */
  igniteNear(pos: Vector3, radius: number): object[] {
    const lit: object[] = [];
    for (const b of this.barrels) {
      if (b.alive && b.fuse < 0 && b.pos.distanceTo(pos) < radius) {
        b.fuse = 0.15 + Math.random() * 0.2;
        lit.push(b);
      }
    }
    return lit;
  }

  // ---------- supply drops ----------

  /** A landed supply crate blocks movement and bullets like any other crate. */
  solidCrate(p: Vector3) {
    this.world.add({ minX: p.x - 0.7, minY: p.y, minZ: p.z - 0.7, maxX: p.x + 0.7, maxY: p.y + 1.1, maxZ: p.z + 0.7 });
  }

  spawnSupplyDrop(x: number, z: number) {
    const ground = this.map.groundAt(x, z);
    const chest = this.loot.addChest(new Vector3(x, ground + 220, z), true);
    const chute = new Group();
    const canopy = new Mesh(new CylinderGeometry(3.2, 0.6, 1.6, 10, 1, true), new MeshLambertMaterial({ color: 0xe8472c, side: DoubleSide }));
    canopy.position.y = 6;
    chute.add(canopy);
    for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const line = boxMesh(0.04, 5.5, 0.04, 0xeeeeee);
      line.position.set(cx * 1.4, 3.3, cz * 1.4);
      line.rotation.set(cz * 0.25, 0, -cx * 0.25);
      chute.add(line);
    }
    this.scene.add(chute);
    const beam = new Mesh(new CylinderGeometry(0.35, 0.35, 400, 8, 1, true), new MeshBasicMaterial({
      color: 0x55b0ff, transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false,
    }));
    beam.position.set(x, ground + 200, z);
    this.scene.add(beam);
    this.drops.push({ chest, chute, beam, smokeLeft: 40 });
  }

  // ---------- effects ----------

  private puff(at: Vector3, color: number, count: number, speed: number, size: number, rise = 1.5, life = 1.2) {
    this.fx.puff(at, color, count, speed, size, rise, life);
  }

  /** Fireball + smoke. Damage is handled by the game. */
  explosionFx(at: Vector3, radius: number) {
    const mesh = new Mesh(blastGeo, new MeshBasicMaterial({ color: 0xffa040, transparent: true, blending: AdditiveBlending, depthWrite: false }));
    mesh.position.copy(at);
    this.scene.add(mesh);
    this.blasts.push({ mesh, life: 0.45, radius });
    this.blastLight.position.copy(at).y += 2;
    this.blastLight.intensity = 24;
    this.puff(at, 0x3a3634, 14, 5, 1.4, 2.5, 2.2);
    this.puff(at, 0xff7a2a, 8, 9, 0.6, 3, 0.4);
    this.fx.burst(at, 0xffb050, 24, { speed: 14, size: 0.12, life: 0.5, gravity: 14, up: 1 });
  }

  update(dt: number, viewer: Vector3) {
    this.time += dt;
    for (const r of this.rotors) r.rotation.z += dt * 0.7;
    for (const b of this.beams) b.rotation.y += dt * 0.6;

    for (const p of this.pads) {
      p.cooldown -= dt;
      const near = p.pos.distanceToSquared(viewer) < 220 * 220;
      p.arrows.visible = near;
      if (!near) continue;
      p.arrows.children.forEach((a, i) => {
        const t = (this.time * 1.3 + i / 3) % 1;
        a.position.y = 0.5 + t * 2.4;
        ((a as Mesh).material as MeshBasicMaterial).opacity = Math.sin(t * Math.PI) * 0.9;
      });
      (p.ring.material as MeshBasicMaterial).opacity = 0.6 + Math.sin(this.time * 5) * 0.3;
    }

    // Fires flicker; one shared light follows the closest fire.
    let closest: Fire | null = null, cd = 45 * 45;
    for (const f of this.fires) {
      const d2 = f.pos.distanceToSquared(viewer);
      const vis = d2 < 300 * 300;
      f.flames.forEach((m, i) => {
        m.visible = vis;
        if (!vis) return;
        const s = (f.big ? 1.8 : 1) * (0.7 + Math.sin(this.time * (9 + i * 3) + i) * 0.2 + Math.random() * 0.12);
        m.scale.set(s, s * (1 + Math.random() * 0.3), s);
      });
      if (vis && Math.random() < (f.big ? dt * 10 : dt * 3)) this.puff(f.pos.clone().setY(f.pos.y + (f.big ? 1.6 : 0.9)), f.big ? 0x2e2b29 : 0x8a8580, 1, 0.6, f.big ? 1.2 : 0.5, f.big ? 3 : 1.6, f.big ? 4 : 2.5);
      if (d2 < cd) {
        cd = d2;
        closest = f;
      }
    }
    if (closest) {
      this.fireLight.position.copy(closest.pos).y += 1;
      this.fireLight.intensity = (closest.big ? 5 : 3) * (0.8 + Math.random() * 0.3);
    } else this.fireLight.intensity = 0;

    // Barrels: fuses and removal
    const m = new Matrix4();
    for (let i = 0; i < this.barrels.length; i++) {
      const b = this.barrels[i];
      if (!b.alive || b.fuse < 0) continue;
      b.fuse -= dt;
      if (b.fuse <= 0) {
        b.alive = false;
        b.box.minY = b.box.maxY = -9999; // drop out of the collision world
        this.barrelMesh.setMatrixAt(i, m.makeScale(0, 0, 0));
        this.barrelMesh.instanceMatrix.needsUpdate = true;
        this.pendingExplosions.push({ pos: b.pos.clone().setY(b.pos.y + 0.6), radius: 7, damage: 95, src: b });
      }
    }

    // Supply drops drift down under their chute, then smoke.
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i], c = d.chest;
      if (!c.landed) {
        const ground = this.map.groundAt(c.pos.x, c.pos.z);
        c.pos.y = Math.max(ground, c.pos.y - 9 * dt);
        c.mesh.position.copy(c.pos);
        d.chute.position.copy(c.pos).y += 1;
        d.chute.rotation.y += dt * 0.4;
        if (c.pos.y <= ground + 0.01) {
          c.landed = true;
          this.solidCrate(c.pos);
          this.scene.remove(d.chute);
          this.puff(c.pos, 0xb09a80, 10, 5, 0.9, 0.6, 1);
        }
      } else if (d.smokeLeft > 0 && !c.opened) {
        d.smokeLeft -= dt;
        if (Math.random() < dt * 12) this.puff(c.pos.clone().setY(c.pos.y + 1.2), 0xff4a3a, 1, 0.8, 0.9, 3.5, 3);
      }
      if (c.opened) {
        this.scene.remove(d.beam);
        this.drops.splice(i, 1);
      }
    }


    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      b.life -= dt;
      const k = 1 - b.life / 0.45;
      b.mesh.scale.setScalar(b.radius * (0.3 + k * 0.8));
      (b.mesh.material as MeshBasicMaterial).opacity = Math.max(0, 1 - k);
      if (b.life <= 0) {
        this.scene.remove(b.mesh);
        (b.mesh.material as MeshBasicMaterial).dispose();
        this.blasts.splice(i, 1);
      }
    }
    this.blastLight.intensity = Math.max(0, this.blastLight.intensity - dt * 60);
  }
}

const blastGeo = new IcosahedronGeometry(1, 1);
