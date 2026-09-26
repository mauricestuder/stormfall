import { Vector3 } from 'three';
import { Bot, type Mode } from '../bots/Bot';
import { NAMES, TEAMMATE_MARKER } from '../bots/BotManager';
import type { ArenaKind, BotEntry, LootLayout, Msg, Net, RosterEntry } from '../net/Net';
import type { LootItem, LootKind } from '../weapons/Loot';
import { AMMO_INFO, makeWeapon, magSize, RARITIES, WEAPON_IDS, type ThrowKind, type WeaponId } from '../weapons/Weapon';
import { applyDamage, type Combatant } from './Combat';
import type { Game } from './Game';
import { botOutfit, skinOf } from './Skins';

/**
 * Battle royale with friends online. Everyone gets the same island: the loot, the plane's flight
 * line and the storm circles all come from one shared seed. Each player simulates themselves; the
 * host also runs the bots. Whatever one machine changes in the world (an item picked up or dropped,
 * a chest or door opened, a car driven, a supply drop) is sent to everyone else.
 */

/** Movement modes on the wire. */
const MODES: Mode[] = ['ground', 'plane', 'freefall', 'glide', 'vehicle'];

/** Host: the bots for an online battle royale. `squads`: all friends in one squad, bots in squads of the same size. */
export function planBRBots(kind: ArenaKind, roster: RosterEntry[], total: number): BotEntry[] {
  const size = kind === 'brs' ? Math.min(4, Math.max(2, roster.length)) : 1;
  const names = [...NAMES].sort(() => Math.random() - 0.5);
  const bots: BotEntry[] = [];
  let id = 100, team = 1;
  while (roster.length + bots.length < total) {
    const hue = Math.random();
    for (let i = 0; i < size && roster.length + bots.length < total; i++) {
      bots.push({ id, name: names[(id - 100) % names.length], team, hue: size > 1 ? hue : Math.random() });
      id++;
    }
    team++;
  }
  return bots;
}

/** Team of a human player: one squad for everyone (\`brs\`), or alone. */
export const humanTeamOf = (kind: ArenaKind, id: number) => (kind === 'brs' ? 0 : 1000 + id);

export class OnlineBR {
  private byId = new Map<number, Combatant>();
  private items = new Map<number, LootItem>();
  private counter = 0;
  /** True while applying something that came over the network (so it isn't sent back out). */
  private fromNet = false;
  private sendT = 0;
  private botsT = 0;
  private zoneT = 0;
  private vehT = 0;

  constructor(private game: Game, readonly kind: ArenaKind, readonly net: Net) {}

  get myId() {
    return this.net.myId;
  }

  get isHost() {
    return this.net.isHost;
  }

  // ---------- setup ----------

  setup(roster: RosterEntry[], bots: BotEntry[]) {
    const g = this.game, p = g.player;
    p.team = humanTeamOf(this.kind, this.myId);
    this.byId.set(this.myId, p);
    for (const r of roster) g.humanTeams.add(humanTeamOf(this.kind, r.id));
    for (const r of roster) {
      if (r.id === this.myId) continue;
      const team = humanTeamOf(this.kind, r.id), friend = team === p.team;
      const b = new Bot(r.id, r.name, g, Math.random(), friend ? TEAMMATE_MARKER : undefined, skinOf(r.skin ?? 0));
      b.team = team;
      b.puppet = true;
      b.human = true;
      b.netMode = 'plane';
      g.bots.bots.push(b);
      if (friend) g.bots.mates.push(b);
      this.byId.set(r.id, b);
    }
    // Bots: the host flies them, everyone else just shows them.
    const squads = new Map<number, Bot[]>();
    for (const e of bots) {
      const b = new Bot(e.id, e.name, g, e.hue, undefined, botOutfit(e.id));
      b.team = e.team;
      b.puppet = !this.isHost;
      b.netMode = 'plane';
      g.bots.bots.push(b);
      this.byId.set(e.id, b);
      const sq = squads.get(e.team) ?? [];
      sq.push(b);
      squads.set(e.team, sq);
    }
    if (this.isHost) for (const sq of squads.values()) g.bots.dropSquad(g, sq);
    // Friends in one squad back each other up.
    const mine = [p, ...g.bots.bots.filter((b) => b.team === p.team)];
    for (const c of mine) if (c instanceof Bot) c.squad = mine;

    // Loot: the same ids everywhere (everyone has the host's layout, in the same order).
    g.loot.items.filter((it) => it.alive).forEach((it, i) => {
      it.nid = i + 1;
      this.items.set(it.nid, it);
    });
    g.loot.onSpawn = (it) => this.itemAppeared(it);
    g.loot.onRemove = (it) => {
      if (!this.fromNet && it.nid !== undefined) this.net.send({ t: 'take', n: it.nid });
    };
    g.loot.onChest = (c) => {
      if (!this.fromNet) this.net.send({ t: 'chest', k: g.loot.chests.indexOf(c) });
    };
  }

  private itemAppeared(it: LootItem) {
    if (this.fromNet) return;
    it.nid = this.myId * 1_000_000 + ++this.counter;
    this.items.set(it.nid, it);
    this.net.send({ t: 'drop', n: it.nid, k: packKind(it.kind), p: v3(it.pos) });
  }

  // ---------- ownership ----------

  /** Do we simulate (and so decide damage to) this combatant? */
  owns(c: Combatant) {
    return c.isPlayer || (c instanceof Bot && !c.puppet);
  }

  idOf(c: Combatant) {
    return c.isPlayer ? this.myId : c.id;
  }

  combatant(id: number) {
    return this.byId.get(id) ?? null;
  }

  // ---------- outgoing ----------

  sendDamage(from: Combatant, to: Combatant, amt: number, head: boolean) {
    this.net.sendDamage({ t: 'dmg', to: this.idOf(to), from: this.idOf(from), amt: Math.round(amt * 10) / 10, head: head ? 1 : 0 });
  }

  sendShot(shooter: Combatant, w: string, muzzle: Vector3, end: Vector3) {
    this.net.send({ t: 'shot', id: this.idOf(shooter), w, m: v3(muzzle), e: v3(end) });
  }

  sendThrow(owner: Combatant, kind: string, from: Vector3, vel: Vector3) {
    this.net.send({ t: 'nade', id: this.idOf(owner), k: kind, p: v3(from), v: v3(vel) });
  }

  sendDoor(i: number, open: boolean, side: number) {
    this.net.send({ t: 'door', i, o: open ? 1 : 0, s: side });
  }

  /** Host: a supply drop is coming down here. */
  sendSupply(x: number, z: number) {
    this.net.send({ t: 'sup', x: r2(x), z: r2(z) });
  }

  /** Someone we own went down: tell everyone (and leave our stuff on the floor if it was us). */
  onKill(killer: Combatant | null, victim: Combatant, weapon: string | null, head: boolean, how?: string, redeploy = false) {
    if (this.fromNet || !this.owns(victim)) return;
    this.net.send({ t: 'kill', victim: this.idOf(victim), killer: killer ? this.idOf(killer) : -1, w: weapon ?? '', head: head ? 1 : 0, how, rd: redeploy ? 1 : undefined });
    if (victim.isPlayer) this.dropMine();
  }

  private dropMine() {
    const g = this.game, p = g.player, pile: LootKind[] = [];
    for (const w of p.slots) if (w) pile.push({ type: 'weapon', weapon: { ...w, att: { ...w.att } } });
    for (const w of p.slots) if (w && p.ammo[w.def.ammo] > 0) pile.push({ type: 'ammo', ammo: w.def.ammo, amount: Math.min(p.ammo[w.def.ammo], AMMO_INFO[w.def.ammo].pickup * 2) });
    if (p.plates > 0) pile.push({ type: 'plate', count: p.plates });
    if (p.medkits > 0) pile.push({ type: 'medkit', count: p.medkits });
    if (pile.length) g.loot.spawnPile(pile, g.floorBelow(p.body.pos));
  }

  update(dt: number) {
    const g = this.game, p = g.player, net = this.net;
    this.sendT -= dt;
    if (this.sendT <= 0) {
      this.sendT = 0.05;
      const w = p.weapon, md = MODES.indexOf(p.mode as Mode);
      net.send({
        t: 'st', id: net.myId, p: v3(p.body.pos), v: v3(p.body.vel), y: r2(p.yaw), a: p.alive ? 1 : 0,
        w: w ? w.def.id : '', r: w ? w.rarity.tier : 0, c: p.crouching || p.sliding ? 1 : 0, md: md < 0 ? 0 : md,
        h: Math.round(Math.max(0, p.health)), ar: Math.round(p.armor),
      });
    }
    // Cars we (or our bots) are driving.
    this.vehT -= dt;
    if (this.vehT <= 0) {
      this.vehT = 0.066;
      const s: number[][] = [];
      g.vehicles.forEach((v, i) => {
        if (!v.driver || !this.owns(v.driver) || !v.alive) return;
        const q = v.body.pos, u = v.body.vel;
        s.push([i, r2(q.x), r2(q.y), r2(q.z), r2(v.yaw), r2(u.x), r2(u.y), r2(u.z), r2(v.speed), this.idOf(v.driver)]);
      });
      if (s.length) net.send({ t: 'veh', s });
    }
    if (!net.isHost) return;
    this.botsT -= dt;
    if (this.botsT <= 0) {
      this.botsT = 0.066;
      const s: (number | string)[][] = [];
      for (const b of g.bots.bots) {
        if (b.puppet) continue;
        const q = b.body.pos, v = b.body.vel;
        s.push([b.id, r2(q.x), r2(q.y), r2(q.z), r2(v.x), r2(v.y), r2(v.z), r2(b.yaw), b.alive ? 1 : 0, b.weapon.def.id, b.weapon.rarity.tier, b.crouching ? 1 : 0, Math.max(0, MODES.indexOf(b.mode)), Math.round(Math.max(0, b.health)), Math.round(b.armor)]);
      }
      net.send({ t: 'bots', s, left: 0 });
    }
    // Keep everyone's storm clock in step with ours.
    this.zoneT -= dt;
    if (this.zoneT <= 0) {
      this.zoneT = 1;
      net.send({ t: 'zone', ph: g.zone.phase, st: g.zone.state, tm: r2(g.zone.timer) });
    }
  }

  // ---------- incoming ----------

  handle(m: Msg) {
    const g = this.game;
    switch (m.t) {
      case 'st': {
        const b = this.combatant(m.id);
        // Back from their one redeploy.
        if (b instanceof Bot && b.puppet && !b.alive && m.a === 1 && g.redeploying.delete(b)) b.revive(g, vec(m.p));
        if (b instanceof Bot && b.puppet && b.alive) {
          this.syncPuppet(b, m.p, m.v, m.y, m.w, m.r, m.c === 1, m.md ?? 0);
          if (m.h !== undefined) b.health = Math.max(1, m.h);
          if (m.ar !== undefined) b.armor = m.ar;
        }
        break;
      }
      case 'bots':
        for (const e of m.s) {
          const b = this.combatant(e[0] as number);
          if (b instanceof Bot && b.puppet && b.alive) {
            this.syncPuppet(b, [e[1], e[2], e[3]] as number[], [e[4], e[5], e[6]] as number[], e[7] as number, e[9] as string, e[10] as number, e[11] === 1, (e[12] as number) ?? 0);
            if (typeof e[13] === 'number') b.health = Math.max(1, e[13]);
            if (typeof e[14] === 'number') b.armor = e[14];
          }
        }
        break;
      case 'shot': {
        const b = this.combatant(m.id);
        if (b && !this.owns(b)) g.remoteShot(b, m.w as WeaponId, vec(m.m), vec(m.e));
        break;
      }
      case 'nade': {
        const b = this.combatant(m.id);
        if (!b || this.owns(b)) break;
        if (m.k === 'rocket') g.projectiles.fireRocket(vec(m.p), vec(m.v).normalize(), b, makeWeapon('rocket', RARITIES[3]), true);
        else g.projectiles.throw(m.k as ThrowKind, vec(m.p), vec(m.v), b, true);
        break;
      }
      case 'dmg': {
        const to = this.combatant(m.to), from = this.combatant(m.from);
        if (!to || !to.alive || !this.owns(to)) break;
        const res = applyDamage(to, m.amt);
        to.onDamaged(from, m.amt);
        if (to instanceof Bot && from) to.lastHitDir.set(to.body.pos.x - from.body.pos.x, 0, to.body.pos.z - from.body.pos.z).normalize();
        if (to.isPlayer) g.onHurtByNet(m.head === 1, from);
        if (res.killed) {
          const w = from instanceof Bot ? from.weapon.def.id : '';
          g.onKill(from, to, w ? makeWeapon(w as WeaponId) : null, undefined, m.head === 1);
        }
        break;
      }
      case 'kill': {
        const victim = this.combatant(m.victim), killer = m.killer >= 0 ? this.combatant(m.killer) : null;
        if (!victim || this.owns(victim) || !victim.alive) break;
        if (m.rd) g.redeploying.add(victim);
        this.net$(() => g.onKill(killer, victim, WEAPON_IDS.includes(m.w as WeaponId) ? makeWeapon(m.w as WeaponId) : null, m.how, m.head === 1));
        break;
      }
      case 'drop': {
        if (this.items.has(m.n)) break;
        const kind = unpackKind(m.k);
        if (!kind) break;
        this.net$(() => {
          const it = g.loot.spawn(kind, vec(m.p));
          it.nid = m.n;
          this.items.set(m.n, it);
        });
        break;
      }
      case 'take': {
        const it = this.items.get(m.n);
        if (it?.alive) this.net$(() => g.loot.remove(it));
        break;
      }
      case 'chest': {
        const c = g.loot.chests[m.k];
        if (c) this.net$(() => g.loot.markOpened(c));
        break;
      }
      case 'door': {
        const d = g.doors.list[m.i];
        if (!d) break;
        if (m.o) {
          d.side = m.s;
          d.openUntil = Infinity;
        } else d.openUntil = 0;
        break;
      }
      case 'veh':
        for (const e of m.s) {
          const v = g.vehicles[e[0]];
          if (!v || v === g.driving || !v.alive) continue;
          v.netPos.set(e[1], e[2], e[3]);
          v.netYaw = e[4];
          v.netVel.set(e[5], e[6], e[7]);
          v.speed = e[8];
          if (v.netHold <= 0) v.body.pos.copy(v.netPos);
          v.netHold = 0.6;
          v.hasDriver = true;
          v.driver = this.combatant(e[9]);
        }
        break;
      case 'sup':
        if (!this.isHost) g.supplyDrop(m.x, m.z);
        break;
      case 'zone': {
        const z = g.zone;
        if (!this.isHost && z.phase === m.ph && z.state === m.st && Math.abs(z.timer - m.tm) > 0.25) z.timer = m.tm;
        break;
      }
      case 'bye': {
        const b = this.combatant(m.id);
        if (b instanceof Bot && b.alive) this.net$(() => g.onKill(null, b, null, 'Disconnected'));
        break;
      }
    }
  }

  /** Runs \`fn\` as something that came from the network (nothing is echoed back). */
  private net$(fn: () => void) {
    this.fromNet = true;
    try {
      fn();
    } finally {
      this.fromNet = false;
    }
  }

  private syncPuppet(b: Bot, p: number[], v: number[], yaw: number, w: string, r: number, crouch: boolean, md: number) {
    if (w && (b.weapon.def.id !== w || b.weapon.rarity.tier !== r) && WEAPON_IDS.includes(w as WeaponId)) {
      const nw = makeWeapon(w as WeaponId, RARITIES[r] ?? RARITIES[0]);
      nw.mag = magSize(nw);
      b.setWeapon(nw);
    }
    b.applyNet(p, v, yaw, crouch, MODES[md] ?? 'ground');
  }

  /** The connection to the host dropped. */
  lost(why: string) {
    this.game.onlineLost(why);
  }
}

// ---------- loot on the wire ----------

/** Host: the island's loot as it lies now, to hand to everyone at the start. */
export function packLoot(g: Game): LootLayout {
  return {
    i: g.loot.items.filter((it) => it.alive).map((it) => [packKind(it.kind), r2(it.pos.x), r2(it.pos.y), r2(it.pos.z)]),
    c: g.loot.chests.map((c) => [r2(c.pos.x), r2(c.pos.y), r2(c.pos.z)]),
  };
}

/** Guest: lay the host's loot out here instead of ours. */
export function unpackLoot(g: Game, l: LootLayout) {
  g.loot.reset();
  for (const [k, x, y, z] of l.i) {
    const kind = unpackKind(k);
    // (Something unreadable still takes its slot, so the ids stay in step.)
    g.loot.spawn(kind ?? { type: 'medkit', count: 1 }, new Vector3(x, y, z));
  }
  for (const c of l.c) g.loot.addChest(new Vector3(c[0], c[1], c[2]));
}

type PackedWeapon = { type: 'weapon'; id: WeaponId; r: number; mag: number; att: Record<string, boolean> };

function packKind(k: LootKind): unknown {
  if (k.type !== 'weapon') return k;
  return { type: 'weapon', id: k.weapon.def.id, r: k.weapon.rarity.tier, mag: k.weapon.mag, att: { ...k.weapon.att } } satisfies PackedWeapon;
}

function unpackKind(k: unknown): LootKind | null {
  const o = k as { type?: string } | null;
  if (!o || typeof o !== 'object') return null;
  if (o.type === 'weapon') {
    const p = o as PackedWeapon;
    if (!WEAPON_IDS.includes(p.id)) return null;
    const w = makeWeapon(p.id, RARITIES[p.r] ?? RARITIES[0]);
    w.mag = Math.max(0, Math.min(magSize(w), Number(p.mag) || 0));
    for (const a of Object.keys(w.att) as (keyof typeof w.att)[]) w.att[a] = !!p.att?.[a];
    return { type: 'weapon', weapon: w };
  }
  if (['ammo', 'medkit', 'plate', 'attachment', 'throwable'].includes(String(o.type))) return o as LootKind;
  return null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const v3 = (v: Vector3) => [r2(v.x), r2(v.y), r2(v.z)];
const vec = (a: number[]) => new Vector3(a[0], a[1], a[2]);
