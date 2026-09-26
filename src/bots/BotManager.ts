import { Vector3 } from 'three';
import type { Combatant } from '../game/Combat';
import type { Game } from '../game/Game';
import { Bot } from './Bot';
import { botOutfit } from '../game/Skins';

export const NAMES = [
  'Viper', 'Nova', 'Ghost', 'Blaze', 'Rook', 'Echo', 'Talon', 'Havoc', 'Onyx', 'Specter', 'Bolt', 'Rift',
  'Cinder', 'Wraith', 'Jolt', 'Kestrel', 'Mako', 'Pyre', 'Quill', 'Saber', 'Tundra', 'Vandal', 'Zephyr', 'Ember',
  'Frost', 'Grit', 'Hex', 'Ion', 'Jinx', 'Lynx', 'Moss', 'Nyx', 'Orca', 'Pike', 'Raze', 'Shade', 'Thorn', 'Umbra',
  'Vex', 'Wisp', 'Yeti', 'Zinc', 'Axle', 'Brine', 'Crux', 'Dusk', 'Flint', 'Gale', 'Hawk', 'Iris',
];

/** Squadmates of the player wear a green marker. */
export const TEAMMATE_MARKER = 0x4cff6a;

export class BotManager {
  bots: Bot[] = [];
  /** The player's AI squadmates. */
  mates: Bot[] = [];

  /**
   * Creates the lobby: `count` bots in squads of `squadSize`. The player's squad (team 0) is
   * filled with AI teammates who follow the player out of the plane.
   */
  spawnAll(game: Game, count: number, squadSize: number) {
    const names = [...NAMES].sort(() => Math.random() - 0.5);
    const size = Math.max(1, Math.min(4, squadSize));
    let id = 1;
    const make = (team: number, hue: number, marker?: number) => {
      const n = id - 1;
      const name = names[n % names.length] + (n >= names.length ? ` ${Math.floor(n / names.length) + 1}` : '');
      const bot = new Bot(id, name, game, hue, marker, botOutfit(id));
      id++;
      bot.team = team;
      this.bots.push(bot);
      return bot;
    };
    // Your squad.
    const mySquad: Combatant[] = [game.player];
    for (let i = 1; i < size && this.bots.length < count; i++) {
      const b = make(0, 0.33 + i * 0.05, TEAMMATE_MARKER);
      b.followPlayer = true;
      this.mates.push(b);
      mySquad.push(b);
    }
    for (const b of this.mates) b.squad = mySquad;
    // Everyone else, squad by squad, each squad dropping together on one spot.
    let team = 1;
    while (this.bots.length < count) {
      const hue = Math.random(), jumpAt = 0.12 + Math.random() * 0.76;
      const land = this.pickLanding(game);
      const squad: Bot[] = [];
      for (let i = 0; i < size && this.bots.length < count; i++) {
        const b = make(team, size > 1 ? hue : Math.random());
        b.jumpAt = Math.min(0.95, jumpAt + i * 0.004);
        const a = Math.random() * Math.PI * 2, r = size > 1 ? 4 + Math.random() * 8 : 0;
        b.landTarget.set(land.x + Math.cos(a) * r, land.y, land.z + Math.sin(a) * r);
        squad.push(b);
      }
      for (const b of squad) b.squad = squad;
      team++;
    }
  }

  /** A squad picks one landing spot and jumps out of the plane together. */
  dropSquad(game: Game, squad: Bot[]) {
    const jumpAt = 0.12 + Math.random() * 0.76, land = this.pickLanding(game);
    squad.forEach((b, i) => {
      b.jumpAt = Math.min(0.95, jumpAt + i * 0.004);
      const a = Math.random() * Math.PI * 2, r = squad.length > 1 ? 4 + Math.random() * 8 : 0;
      b.landTarget.set(land.x + Math.cos(a) * r, land.y, land.z + Math.sin(a) * r);
      b.squad = squad;
    });
  }

  private pickLanding(game: Game) {
    // Most squads head for a named location (big towns draw far more than small spots), a few go off the beaten path.
    if (Math.random() < 0.85) {
      const pois = game.map.pois, w = pois.map((p) => Math.pow(p.radius, 2));
      let pick = Math.random() * w.reduce((a, b) => a + b, 0), i = 0;
      while (i < pois.length - 1 && (pick -= w[i]) > 0) i++;
      const poi = pois[i];
      const a = Math.random() * Math.PI * 2, r = Math.random() * poi.radius;
      const x = poi.x + Math.cos(a) * r, z = poi.z + Math.sin(a) * r;
      return new Vector3(x, game.map.groundAt(x, z), z);
    }
    const s = game.map.lootSpots[Math.floor(Math.random() * game.map.lootSpots.length)];
    return (s ?? new Vector3()).clone();
  }

  update(dt: number, game: Game) {
    for (const b of this.bots) b.update(dt, game);
  }

  get aliveCount() {
    let n = 0;
    for (const b of this.bots) if (b.alive) n++;
    return n;
  }
}
