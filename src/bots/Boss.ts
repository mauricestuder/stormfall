import { Color, Vector3 } from 'three';
import { CONFIG } from '../config';
import { makeMythic, type MythicId } from '../weapons/Weapon';
import { Bot } from './Bot';
import { Character, type BodyKind } from './Character';
import type { Game } from '../game/Game';

/**
 * Bosses: giant toys that guard a spot on the island. Each carries a Mythic gun (better than gold)
 * that it drops when it's beaten. They don't count as players: the match is won without them.
 */
export interface BossDef {
  id: string;
  name: string;
  /** Shown on the boss bar and the map. */
  title: string;
  kind: BodyKind;
  suit: number;
  trim: number;
  size: number;
  health: number;
  gun: MythicId;
  /** Their damage is scaled by this (the mythic guns would shred you at full power). */
  dmgMul: number;
  /** Colour of their map icon and boss bar. */
  color: string;
}

export const BOSSES: BossDef[] = [
  { id: 'ted', name: 'Big Ted', title: 'THE HUGGIEST BEAR', kind: 'teddy', suit: 0x9a6232, trim: 0xe3342f, size: 2.3, health: 1500, gun: 'stuffing', dmgMul: 0.25, color: '#c07a3a' },
  { id: 'max', name: 'Mecha-Max', title: 'WIND-UP WAR MACHINE', kind: 'robot', suit: 0xb8c0ca, trim: 0xe3342f, size: 2.4, health: 1700, gun: 'windup', dmgMul: 0.38, color: '#9fb4c8' },
  { id: 'sarge', name: 'Sergeant Plastic', title: 'LEADER OF THE GREEN ARMY', kind: 'armyman', suit: 0x3f8a2a, trim: 0x2a5a1a, size: 2.5, health: 1400, gun: 'marble', dmgMul: 0.45, color: '#5aa83a' },
  { id: 'jack', name: 'Jack the Clown', title: 'POPS OUT OF NOWHERE', kind: 'minifig', suit: 0xff3fd0, trim: 0xffc21a, size: 2.2, health: 1200, gun: 'cork', dmgMul: 0.4, color: '#ff5ad8' },
];

/** How far from home a boss chases you before giving up. */
export const BOSS_LEASH = 55;

/** Boss-only state, hung off the Bot. */
export interface BossState {
  def: BossDef;
  home: Vector3;
  maxHealth: number;
  /** Seconds since it last had someone to fight (it heals up when left alone). */
  calm: number;
  /** Seconds since the player last hurt it (the boss bar shows while you're fighting). */
  hurtByYou: number;
}

/** Places the bosses at big named locations, spread out, each in an open spot. */
export function spawnBosses(game: Game, firstId: number) {
  const map = game.map, nav = game.nav;
  const pois = [...map.pois].filter((p) => Math.abs(p.x) < map.half - 60 && Math.abs(p.z) < map.half - 60).sort(() => Math.random() - 0.5);
  const homes: Vector3[] = [];
  const bosses: Bot[] = [];
  let id = firstId;
  for (const def of BOSSES) {
    let home: Vector3 | null = null;
    for (const poi of pois) {
      if (homes.some((h) => Math.hypot(h.x - poi.x, h.z - poi.z) < 260)) continue;
      // An open spot near the middle of town: nothing solid within a few metres, on dry land.
      for (let k = 0; k < 40 && !home; k++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * poi.radius * 0.8;
        const x = poi.x + Math.cos(a) * r, z = poi.z + Math.sin(a) * r;
        if (map.isWater(x, z)) continue;
        let open = true;
        for (let dx = -6; dx <= 6 && open; dx += 3) for (let dz = -6; dz <= 6 && open; dz += 3) if (!nav.walkableAt(x + dx, z + dz)) open = false;
        if (open) home = new Vector3(x, game.world.groundAt(x, z) + 0.1, z);
      }
      if (home) break;
    }
    if (!home) continue;
    homes.push(home);
    bosses.push(makeBoss(game, def, id++, home));
  }
  return bosses;
}

function makeBoss(game: Game, def: BossDef, id: number, home: Vector3) {
  const bot = new Bot(id, def.name, game);
  // Swap the random body for the boss's: a giant with a crown.
  game.scene.remove(bot.character.root);
  bot.character = new Character(new Color(def.suit), new Color(def.trim), undefined, undefined, false, def.kind, true);
  bot.character.size = def.size;
  game.scene.add(bot.character.root);
  bot.team = 1000 + id;
  bot.squad = [bot];
  bot.boss = { def, home: home.clone(), maxHealth: def.health, calm: 0, hurtByYou: 99 };
  bot.body.radius = 0.85;
  bot.frags = bot.smokes = 0;
  bot.heals = 0;
  bot.plates = 0;
  bot.weapon = makeMythic(def.gun);
  bot.revive(game, home);
  bot.health = def.health;
  bot.armor = 0;
  bot.heals = 0;
  bot.body.height = CONFIG.player.standHeight * def.size;
  bot.headR = 0.24 * def.size;
  bot.yaw = Math.random() * Math.PI * 2;
  return bot;
}
