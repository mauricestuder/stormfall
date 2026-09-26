import { AdditiveBlending, Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from 'three';
import { Bot } from '../bots/Bot';
import { TEAMMATE_MARKER } from '../bots/BotManager';
import { CONFIG } from '../config';
import type { DMKind as ArenaKind, BotEntry, Msg, Net, RosterEntry } from '../net/Net';
import { AMMO_INFO, makeWeapon, magSize, RARITIES, WEAPON_IDS, type WeaponId } from '../weapons/Weapon';
import type { ThrowKind } from '../weapons/Weapon';
import type { LootItem } from '../weapons/Loot';
import { applyDamage, type Combatant } from './Combat';
import type { Game } from './Game';
import { skinOf, THEMED_SKINS } from './Skins';

/**
 * Arena modes on the Foundry map: Team Deathmatch (blue vs red, first to 40) and Free-for-all
 * (first to 20). Everyone respawns with a fresh loadout; power weapons lie in the contested spots.
 *
 * Online, every peer simulates its own player; the host also runs the bots. Whoever fires decides
 * what they hit and sends the damage to whoever owns the target, who applies it and announces the
 * kill. Everyone keeps score from the kill messages; the host calls the end of the match.
 */

export const ARENA_RULES = {
  tdm: { name: 'TEAM DEATHMATCH', scoreTo: 40, time: 8 * 60, size: 10 },
  ffa: { name: 'FREE-FOR-ALL', scoreTo: 20, time: 8 * 60, size: 8 },
} as const;

export const TEAM_NAMES = ['BLUE', 'RED'];
export const TEAM_CSS = ['#4b9bff', '#ff5a4d'];
const TEAM_HUES = [0.6, 0.0];
const RESPAWN = 3.5;
const PICKUP_RESPAWN = 35;
/** Seconds of spawn protection. */
const SHIELD = 4;
const bubbleGeo = new SphereGeometry(1, 20, 14);
const TEAM_HEX = [0x4aa8ff, 0xff5a4a];
const PRIMARY: WeaponId[] = ['ar', 'smg', 'burst', 'lmg', 'shotgun', 'dmr'];
const SECONDARY: WeaponId[] = ['pistol', 'revolver', 'smg', 'shotgun'];
const BOT_NAMES = ['Viper', 'Nova', 'Ghost', 'Blaze', 'Rook', 'Echo', 'Talon', 'Havoc', 'Onyx', 'Specter', 'Bolt', 'Rift', 'Cinder', 'Wraith', 'Jolt', 'Kestrel'];

/** Host / offline: which bots fill the match (TDM: up to 5 a side; FFA: up to 8 players). */
export function planArenaBots(kind: ArenaKind, roster: RosterEntry[], fill: boolean): BotEntry[] {
  const bots: BotEntry[] = [], rules = ARENA_RULES[kind];
  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  let id = 100;
  const add = (team: number) => {
    bots.push({ id, name: names[(id - 100) % names.length], team: team < 0 ? 10 + id : team, hue: Math.random() });
    id++;
  };
  if (fill && kind === 'tdm') {
    for (const t of [0, 1]) for (let n = roster.filter((r) => r.team === t).length; n < rules.size / 2; n++) add(t);
  } else if (fill) {
    for (let n = roster.length; n < rules.size; n++) add(-1);
  }
  return bots;
}

export interface ScoreRow {
  c: Combatant;
  name: string;
  team: number;
  kills: number;
  deaths: number;
  me: boolean;
}

export class Arena {
  readonly rules: (typeof ARENA_RULES)[ArenaKind];
  timeLeft: number;
  teamScore = [0, 0];
  deaths = new Map<Combatant, number>();
  over = false;
  /** Who killed you last (for the respawn banner) and how long until you're back. */
  killedBy = '';
  respawnIn = 0;
  private respawns: { c: Combatant; t: number }[] = [];
  private byId = new Map<number, Combatant>();
  private pickups: { at: Vector3; weapon: WeaponId; t: number; item: LootItem | null }[] = [];
  private sendT = 0;
  private botsT = 0;
  /** True while applying a kill that came over the network (so it isn't sent back out). */
  private fromNet = false;
  /** Spawn protection: a moment of invulnerability after respawning. */
  shield = new Map<Combatant, number>();
  private bubbles = new Map<Combatant, Mesh>();
  private shieldEl: HTMLDivElement | null = null;

  constructor(private game: Game, readonly kind: ArenaKind, readonly net: Net | null) {
    this.rules = ARENA_RULES[kind];
    this.timeLeft = this.rules.time;
  }

  get online() {
    return !!this.net;
  }

  get authority() {
    return !this.net || this.net.isHost;
  }

  get myId() {
    return this.net ? this.net.myId : 1;
  }

  // ---------- setup ----------

  setup(roster: RosterEntry[], bots: BotEntry[]) {
    const g = this.game, p = g.player;
    const me = roster.find((r) => r.id === this.myId);
    p.team = this.kind === 'tdm' ? me?.team ?? 0 : 10 + this.myId;
    this.byId.set(this.myId, p);
    const make = (id: number, name: string, team: number, hue: number, puppet: boolean, skin = 0) => {
      const friend = this.kind === 'tdm' && team === p.team;
      const b = new Bot(id, name, g, this.kind === 'tdm' ? TEAM_HUES[team] + (hue - 0.5) * 0.06 : hue, friend ? TEAMMATE_MARKER : undefined, skin || THEMED_SKINS.length ? skinOf(skin) : undefined);
      b.team = team;
      b.puppet = puppet;
      b.alive = false;
      b.armor = 0;
      g.bots.bots.push(b);
      if (friend) g.bots.mates.push(b);
      this.byId.set(id, b);
      return b;
    };
    for (const r of roster) if (r.id !== this.myId) make(r.id, r.name, this.kind === 'tdm' ? r.team : 10 + r.id, Math.random(), true, r.skin);
    for (const e of bots) make(e.id, e.name, e.team, e.hue, !this.authority);
    // Teammates alert each other.
    for (const t of [0, 1]) {
      const squad = [p, ...g.bots.bots].filter((c) => c.team === t);
      for (const c of squad) if (c instanceof Bot) c.squad = squad;
    }
    // Power weapons.
    for (const s of g.map.arenaPickups) this.pickups.push({ at: s.at, weapon: s.weapon, t: 0, item: null });
    // Everyone we own starts at a spawn point.
    this.respawn(p);
    for (const b of g.bots.bots) if (!b.puppet) this.respawn(b);
  }

  // ---------- spawning ----------

  /** A spawn point on your side (any side in free-for-all) as far as possible from living enemies. */
  private spawnPoint(c: Combatant) {
    const g = this.game, sets = g.map.arenaSpawns;
    const cands = this.kind === 'tdm' ? sets[c.team === 1 ? 1 : 0] : [...sets[0], ...sets[1]];
    let best = cands[0], bestScore = -Infinity;
    for (const s of cands) {
      let near = 200;
      for (const o of g.combatants) {
        if (o === c || !o.alive || o.team === c.team) continue;
        near = Math.min(near, Math.hypot(o.body.pos.x - s.x, o.body.pos.z - s.z));
      }
      const score = Math.min(near, 45) + Math.random() * 8;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  private respawn(c: Combatant) {
    const g = this.game, at = this.spawnPoint(c);
    const face = Math.atan2(-(g.map.arena.x - at.x), -(g.map.arena.z - at.z));
    const prim = PRIMARY[Math.floor(Math.random() * PRIMARY.length)];
    let sec = SECONDARY[Math.floor(Math.random() * SECONDARY.length)];
    if (sec === prim) sec = 'pistol';
    if (c === g.player) {
      const p = g.player;
      p.alive = true;
      p.health = CONFIG.player.maxHealth;
      p.armor = 50;
      p.killHeal = 0;
      p.sprintLock = 0;
      p.mode = 'ground';
      p.mantle = null;
      p.zip = null;
      p.frozen = false;
      p.body.pos.copy(at);
      p.body.vel.set(0, 0, 0);
      p.yaw = face;
      p.pitch = 0;
      p.slots = [makeWeapon(prim, RARITIES[2]), makeWeapon(sec, RARITIES[1])];
      p.active = 0;
      p.unarmed = false;
      p.plates = 2;
      p.medkits = 1;
      p.throwables = { frag: 1, smoke: 1, flash: 1, grapple: 2 };
      for (const k of Object.keys(p.ammo) as (keyof typeof p.ammo)[]) p.ammo[k] = AMMO_INFO[k].max;
      g.weapons.reset();
      g.weapons.switchLeft = 0.4;
      g.hud.fadeFromBlack(0.15, 0.45);
    } else if (c instanceof Bot) {
      c.revive(g, at);
      c.yaw = face;
      c.armor = 50;
      c.frags = Math.random() < 0.5 ? 1 : 0;
      c.smokes = 0;
      c.setWeapon(makeWeapon(prim, RARITIES[2]));
    }
    this.shield.set(c, SHIELD);
  }

  /** Shooting gives up your spawn protection. */
  dropShield(c: Combatant) {
    const t = this.shield.get(c);
    if (t !== undefined && t < SHIELD - 0.3) this.shield.delete(c);
  }

  /** A see-through bubble around everyone protected, and a countdown for yourself. */
  private drawShields() {
    const g = this.game;
    for (const [c, m] of this.bubbles) {
      if (!this.shield.has(c) || !c.alive || this.over) {
        m.visible = false;
        continue;
      }
    }
    for (const [c, t] of this.shield) {
      if (!c.alive || this.over) continue;
      let m = this.bubbles.get(c);
      if (!m) {
        m = new Mesh(bubbleGeo, new MeshBasicMaterial({ color: TEAM_HEX[c.team === 1 ? 1 : 0], transparent: true, opacity: 0.25, blending: AdditiveBlending, depthWrite: false }));
        g.scene.add(m);
        this.bubbles.set(c, m);
      }
      m.visible = !c.isPlayer;
      m.position.set(c.body.pos.x, c.body.pos.y + c.body.height / 2, c.body.pos.z);
      m.scale.set(0.95, c.body.height * 0.62, 0.95);
      (m.material as MeshBasicMaterial).opacity = (t < 1 ? 0.12 + 0.12 * Math.abs(Math.sin(t * 12)) : 0.22);
    }
    const mine = this.shield.get(g.player);
    if (!this.shieldEl) {
      this.shieldEl = document.createElement('div');
      this.shieldEl.style.cssText = 'position:fixed;left:50%;top:62%;transform:translateX(-50%);padding:4px 12px;border-radius:4px;background:rgba(20,40,70,.55);border:1px solid #6cc6ff;color:#bfe6ff;font:700 13px/1.4 system-ui,sans-serif;letter-spacing:.08em;pointer-events:none;z-index:5;';
      document.body.appendChild(this.shieldEl);
    }
    const show = mine !== undefined && g.player.alive && !this.over;
    this.shieldEl.style.display = show ? '' : 'none';
    if (show) this.shieldEl.textContent = `SPAWN SHIELD ${mine!.toFixed(1)}s · shooting ends it`;
  }

  // ---------- per step ----------

  update(dt: number) {
    const g = this.game, p = g.player;
    if (this.over) return;
    if (this.authority) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) this.finish();
    }
    for (let i = this.respawns.length - 1; i >= 0; i--) {
      const r = this.respawns[i];
      r.t -= dt;
      if (r.t <= 0) {
        this.respawns.splice(i, 1);
        this.respawn(r.c);
      }
    }
    for (const [c, t] of this.shield) {
      if (t - dt <= 0) this.shield.delete(c);
      else this.shield.set(c, t - dt);
    }
    this.respawnIn = Math.max(0, this.respawns.find((r) => r.c === p)?.t ?? 0);
    this.drawShields();
    // Endless reserve ammo: the arena is about fighting, not scavenging.
    for (const k of Object.keys(p.ammo) as (keyof typeof p.ammo)[]) p.ammo[k] = Math.max(p.ammo[k], AMMO_INFO[k].max / 2);
    // Power weapons come back a while after someone takes them.
    for (const s of this.pickups) {
      if (s.item && !s.item.alive) {
        s.item = null;
        s.t = PICKUP_RESPAWN;
      }
      if (!s.item) {
        s.t -= dt;
        if (s.t <= 0) s.item = g.loot.spawn({ type: 'weapon', weapon: makeWeapon(s.weapon, RARITIES[3]) }, s.at.clone());
      }
    }
    if (this.net) this.sendState(dt);
  }

  /** Can this combatant be hurt right now (spawn protection)? */
  protected(c: Combatant) {
    return this.shield.has(c);
  }

  // ---------- kills and score ----------

  onKill(killer: Combatant | null, victim: Combatant, weapon: string | null, head: boolean, how?: string) {
    const g = this.game;
    this.deaths.set(victim, (this.deaths.get(victim) ?? 0) + 1);
    if (killer && killer !== victim && killer.team !== victim.team && this.kind === 'tdm') this.teamScore[killer.team === 1 ? 1 : 0]++;
    if (victim === g.player) this.killedBy = killer && killer !== victim ? killer.name : how ?? 'The Arena';
    // Whoever owns the victim respawns them and tells everyone else.
    if (this.owns(victim)) {
      this.respawns.push({ c: victim, t: RESPAWN + (victim.isPlayer ? 0 : Math.random()) });
      if (this.net && !this.fromNet) {
        this.net.send({ t: 'kill', victim: this.idOf(victim), killer: killer ? this.idOf(killer) : -1, w: weapon ?? '', head: head ? 1 : 0, how });
      }
    }
    if (this.authority) this.checkWin();
  }

  private checkWin() {
    if (this.over) return;
    if (this.kind === 'tdm') {
      if (this.teamScore[0] >= this.rules.scoreTo || this.teamScore[1] >= this.rules.scoreTo) this.finish();
    } else if (this.game.combatants.some((c) => c.kills >= this.rules.scoreTo)) this.finish();
  }

  private finish() {
    if (this.over) return;
    this.net?.send({ t: 'end' });
    this.end();
  }

  /** The match is over: freeze and show the results. */
  private end() {
    this.over = true;
    this.drawShields();
    this.game.endArena();
  }

  /** Everyone in the match, best first (grouped by team in team deathmatch). */
  scoreboard(): ScoreRow[] {
    const g = this.game;
    const rows: ScoreRow[] = g.combatants
      .filter((c) => !(c instanceof Bot && c.dummy))
      .map((c) => ({ c, name: c.name, team: c.team, kills: c.kills, deaths: this.deaths.get(c) ?? 0, me: c === g.player }));
    rows.sort((a, b) => (this.kind === 'tdm' ? a.team - b.team : 0) || b.kills - a.kills || a.deaths - b.deaths);
    return rows;
  }

  /** Did we win? 1 = win, 0 = draw, -1 = loss. */
  result(): number {
    const g = this.game;
    if (this.kind === 'tdm') {
      const mine = g.player.team === 1 ? 1 : 0, [a, b] = [this.teamScore[mine], this.teamScore[1 - mine]];
      return a > b ? 1 : a < b ? -1 : 0;
    }
    const best = Math.max(...g.combatants.map((c) => c.kills));
    const top = g.combatants.filter((c) => c.kills === best);
    return g.player.kills < best ? -1 : top.length > 1 ? 0 : 1;
  }

  placement() {
    const rows = this.scoreboard();
    if (this.kind === 'tdm') return this.result() >= 0 ? 1 : 2;
    return rows.findIndex((r) => r.me) + 1;
  }

  leader() {
    let best: Combatant | null = null;
    for (const c of this.game.combatants) if (!best || c.kills > best.kills) best = c;
    return best;
  }

  // ---------- networking ----------

  /** Do we simulate (and so decide damage to) this combatant? */
  owns(c: Combatant) {
    return !this.net || c.isPlayer || (c instanceof Bot && !c.puppet);
  }

  idOf(c: Combatant) {
    return c.isPlayer ? this.myId : c.id;
  }

  combatant(id: number) {
    return this.byId.get(id) ?? null;
  }

  /** We shot someone we don't own: their owner applies it. */
  sendDamage(from: Combatant, to: Combatant, amt: number, head: boolean) {
    this.net?.sendDamage({ t: 'dmg', to: this.idOf(to), from: this.idOf(from), amt: Math.round(amt * 10) / 10, head: head ? 1 : 0 });
  }

  sendShot(shooter: Combatant, w: string, muzzle: Vector3, end: Vector3) {
    this.net?.send({ t: 'shot', id: this.idOf(shooter), w, m: v3(muzzle), e: v3(end) });
  }

  sendThrow(owner: Combatant, kind: string, from: Vector3, vel: Vector3) {
    this.net?.send({ t: 'nade', id: this.idOf(owner), k: kind, p: v3(from), v: v3(vel) });
  }

  private sendState(dt: number) {
    const g = this.game, p = g.player, net = this.net!;
    this.sendT -= dt;
    if (this.sendT <= 0) {
      this.sendT = 0.05;
      const w = p.weapon;
      net.send({
        t: 'st', id: net.myId, p: v3(p.body.pos), v: v3(p.body.vel), y: r2(p.yaw), a: p.alive ? 1 : 0,
        w: w ? w.def.id : '', r: w ? w.rarity.tier : 0, c: p.crouching || p.sliding ? 1 : 0,
      });
    }
    if (!net.isHost) return;
    this.botsT -= dt;
    if (this.botsT > 0) return;
    this.botsT = 0.066;
    const s: (number | string)[][] = [];
    for (const b of g.bots.bots) {
      if (b.puppet) continue;
      const q = b.body.pos, v = b.body.vel;
      s.push([b.id, r2(q.x), r2(q.y), r2(q.z), r2(v.x), r2(v.y), r2(v.z), r2(b.yaw), b.alive ? 1 : 0, b.weapon.def.id, b.weapon.rarity.tier, b.crouching ? 1 : 0]);
    }
    net.send({ t: 'bots', s, left: Math.round(this.timeLeft * 10) / 10 });
  }

  /** A message from another peer. */
  handle(m: Msg) {
    const g = this.game;
    switch (m.t) {
      case 'st': {
        const b = this.combatant(m.id);
        if (b instanceof Bot) this.syncPuppet(b, m.p, m.v, m.y, m.a === 1, m.w, m.r, m.c === 1);
        break;
      }
      case 'bots': {
        this.timeLeft = m.left;
        for (const e of m.s) {
          const b = this.combatant(e[0] as number);
          if (b instanceof Bot && b.puppet) {
            this.syncPuppet(b, [e[1], e[2], e[3]] as number[], [e[4], e[5], e[6]] as number[], e[7] as number, e[8] === 1, e[9] as string, e[10] as number, e[11] === 1);
          }
        }
        break;
      }
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
        if (!to || !to.alive || !this.owns(to) || this.protected(to) || this.over) break;
        const res = applyDamage(to, m.amt);
        to.onDamaged(from, m.amt);
        if (to.isPlayer) g.onHurtByNet(m.head === 1);
        if (res.killed) {
          const w = from instanceof Bot ? from.weapon.def.id : from?.isPlayer ? g.player.weapon?.def.id ?? '' : '';
          g.onKill(from, to, w ? makeWeapon(w as WeaponId) : null, undefined, m.head === 1);
        }
        break;
      }
      case 'kill': {
        const victim = this.combatant(m.victim), killer = m.killer >= 0 ? this.combatant(m.killer) : null;
        if (!victim || this.owns(victim)) break;
        this.fromNet = true;
        try {
          g.onKill(killer, victim, WEAPON_IDS.includes(m.w as WeaponId) ? makeWeapon(m.w as WeaponId) : null, m.how, m.head === 1);
        } finally {
          this.fromNet = false;
        }
        break;
      }
      case 'end':
        this.end();
        break;
      case 'bye': {
        const b = this.combatant(m.id);
        if (b instanceof Bot && b.alive) {
          b.die(g);
          g.hud.pickupToast(`${b.name} left the game`, '#ff6b6b');
        }
        break;
      }
    }
  }

  private syncPuppet(b: Bot, p: number[], v: number[], yaw: number, alive: boolean, w: string, r: number, crouch: boolean) {
    const g = this.game;
    if (alive && !b.alive) {
      b.revive(g, new Vector3(p[0], p[1], p[2]));
      this.shield.set(b, SHIELD);
    }
    if (w && (b.weapon.def.id !== w || b.weapon.rarity.tier !== r) && WEAPON_IDS.includes(w as WeaponId)) {
      const nw = makeWeapon(w as WeaponId, RARITIES[r] ?? RARITIES[0]);
      nw.mag = magSize(nw);
      b.setWeapon(nw);
    }
    b.applyNet(p, v, yaw, crouch);
  }
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const v3 = (v: Vector3) => [r2(v.x), r2(v.y), r2(v.z)];
const vec = (a: number[]) => new Vector3(a[0], a[1], a[2]);
