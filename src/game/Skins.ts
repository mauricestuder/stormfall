import { THEME, TOY, type ThemeId } from '../theme';
import type { BodyKind } from '../bots/Character';

/** An extra box on the body: size, centre and colour (character space, the face looks down -z). */
export type Part = [w: number, h: number, d: number, x: number, y: number, z: number, color: number];

/** Player outfits, picked in the Locker. Everyone in an online arena sees yours. */
export interface Skin {
  name: string;
  desc: string;
  suit: number;
  trim: number;
  /** Colour of the glowing seams, visor and crest (0 = nothing glows). */
  glow: number;
  visor: number;
  /** First-person sleeves and cuffs. */
  sleeve: number;
  cuff: number;
  glider: number;
  crest: 'none' | 'fin' | 'horns' | 'crown' | 'mohawk' | 'halo' | 'corona';
  /** Locked until this career level. */
  level?: number;
  /** Head and hand colour (default: skin tone). */
  face?: number;
  /** Visor strip (default), two dot eyes, or nothing (the parts draw the face). */
  eyes?: 'visor' | 'dots' | 'none';
  /** Hats, badges, masks and the like. */
  parts?: Part[];
  /** Toy Box: the body this outfit always uses (otherwise the Settings → Characters choice). */
  body?: BodyKind;
}

/** Toy Box outfits: whole toys. The little green army man is the default. */
const toy = (name: string, desc: string, body: BodyKind, suit: number, trim: number, level?: number): Skin => ({
  name, desc, body, suit, trim, glow: 0, visor: 0, sleeve: body === 'armyman' ? suit : body === 'teddy' ? suit : trim, cuff: body === 'robot' ? 0x9aa0a8 : suit,
  glider: suit, crest: 'none', level,
});
const TOY_SKINS: Skin[] = TOY ? [
  toy('Green Army Man', 'The classic little green plastic soldier, base and all.', 'armyman', 0x3f8a2a, 0x2a5a1a),
  toy('Tan Army Man', 'The other side of the playroom war.', 'armyman', 0xb8965a, 0x7a6038, 3),
  toy('Blue Army Man', 'Navy plastic, same old bedroll.', 'armyman', 0x3a62c0, 0x243f80, 6),
  toy('Teddy', 'A well-loved bear with a bow tie.', 'teddy', 0x9a6232, 0xe3342f, 9),
  toy('Wind-Up Robot', 'Tin plate, rivets and a big key in the back.', 'robot', 0xb8c0ca, 0xe3342f, 12),
  toy('Mini Figure', 'Yellow head, claw hands, clicks together.', 'minifig', 0xe3342f, 0x2a4ab8, 15),
] : [];

const hat = (brim: number, crown: number, color: number, band = color): Part[] => [
  [brim, 0.04, brim, 0, 1.8, 0, color],
  [0.34, crown, 0.34, 0, 1.82 + crown / 2, 0, color],
  [0.35, 0.04, 0.35, 0, 1.84, 0, band],
];
const skirt = (color: number, h: number): Part[] => [[0.68, h, 0.42, 0, 0.8 - h / 2 + 0.02, 0, color]];

const THEME_SKINS: Partial<Record<ThemeId, Skin[]>> = {
  western: [
    {
      name: 'Cowboy', desc: 'Red shirt, leather vest, bandana and a ten-gallon hat.',
      suit: 0xb03a2e, trim: 0x3a4f78, glow: 0, visor: 0, sleeve: 0xb03a2e, cuff: 0xe0b48f, glider: 0xc08040, crest: 'none', eyes: 'dots',
      parts: [
        [0.2, 0.64, 0.04, -0.17, 1.14, -0.19, 0x6a4428], [0.2, 0.64, 0.04, 0.17, 1.14, -0.19, 0x6a4428],
        [0.38, 0.08, 0.38, 0, 1.45, 0, 0xc03030], [0.16, 0.1, 0.04, 0, 1.37, -0.2, 0xc03030],
        [0.1, 0.08, 0.03, 0, 0.8, -0.2, 0xd0b040],
        ...hat(0.64, 0.18, 0x8a5a30, 0x3a2414),
      ],
    },
    {
      name: 'Sheriff', desc: 'Long brown coat, black hat and a gold star.',
      suit: 0x7a5230, trim: 0x3a2e24, glow: 0, visor: 0, sleeve: 0x7a5230, cuff: 0xd8cfb8, glider: 0xd0a030, crest: 'none', eyes: 'dots',
      parts: [
        [0.16, 0.66, 0.03, 0, 1.13, -0.185, 0xd8cfb8], [0.06, 0.3, 0.03, 0, 1.25, -0.2, 0x202020],
        [0.04, 0.14, 0.03, -0.16, 1.28, -0.2, 0xf0c840], [0.14, 0.04, 0.03, -0.16, 1.28, -0.2, 0xf0c840], [0.09, 0.09, 0.03, -0.16, 1.28, -0.2, 0xf0c840],
        [0.2, 0.04, 0.03, 0, 1.55, -0.18, 0x4a3020],
        ...skirt(0x7a5230, 0.34),
        ...hat(0.6, 0.2, 0x222222, 0x6a5030),
      ],
    },
    {
      name: 'Outlaw', desc: 'Black duster, masked face and a bandolier.',
      suit: 0x1e1e22, trim: 0x2a2420, glow: 0, visor: 0, sleeve: 0x1e1e22, cuff: 0x2a2420, glider: 0x3a2a2a, crest: 'none', eyes: 'dots',
      parts: [
        [0.36, 0.15, 0.36, 0, 1.5, 0, 0x3a3a44], [0.14, 0.1, 0.04, 0, 1.42, -0.19, 0x3a3a44],
        ...[0, 1, 2, 3, 4, 5].map((i): Part => [0.1, 0.06, 0.03, -0.25 + i * 0.1, 1.42 - i * 0.11, -0.19, 0xb09040]),
        ...[0, 1, 2, 3, 4, 5].map((i): Part => [0.1, 0.06, 0.03, -0.25 + i * 0.1, 1.42 - i * 0.11, 0.19, 0xb09040]),
        ...skirt(0x1e1e22, 0.4),
        ...hat(0.68, 0.18, 0x111111, 0x6a6a70),
      ],
    },
    {
      name: 'Gold Prospector', desc: 'Patched work clothes, a grey beard and a pickaxe on the back.',
      suit: 0x8a7a5a, trim: 0x5a4a32, glow: 0, visor: 0, sleeve: 0x8a7a5a, cuff: 0x6a5a3a, glider: 0xd8b040, crest: 'none', eyes: 'dots',
      parts: [
        [0.05, 0.7, 0.03, -0.14, 1.12, -0.19, 0x4a3020], [0.05, 0.7, 0.03, 0.14, 1.12, -0.19, 0x4a3020],
        [0.1, 0.1, 0.03, 0.2, 0.95, -0.19, 0x6a5a3a], [0.1, 0.08, 0.03, -0.2, 1.3, -0.19, 0x9a8a6a],
        [0.32, 0.14, 0.06, 0, 1.5, -0.17, 0x9a9a9a], [0.2, 0.1, 0.05, 0, 1.4, -0.18, 0x9a9a9a],
        [0.05, 0.8, 0.05, 0.08, 1.2, 0.39, 0x7a5a36], [0.5, 0.07, 0.07, 0.08, 1.58, 0.39, 0x8a8a8a],
        [0.5, 0.05, 0.5, 0, 1.79, 0, 0x6a5a40], [0.34, 0.14, 0.34, 0, 1.88, 0, 0x6a5a40],
      ],
    },
    {
      name: 'Lizard Sheriff', desc: 'A lanky green desert lizard in a loud red shirt: bulging eyes, a long snout, a tail and a tin star.',
      suit: 0xc8342e, trim: 0xb8a070, glow: 0, visor: 0, sleeve: 0xc8342e, cuff: 0x7aa84a, glider: 0x7aa84a, crest: 'none', eyes: 'none', face: 0x7aa84a,
      parts: [
        // Bulging eyes on the sides of the head, pupils looking forward.
        [0.1, 0.14, 0.14, -0.2, 1.68, -0.07, 0xe8d860], [0.1, 0.14, 0.14, 0.2, 1.68, -0.07, 0xe8d860],
        [0.04, 0.07, 0.05, -0.25, 1.68, -0.12, 0x141414], [0.04, 0.07, 0.05, 0.25, 1.68, -0.12, 0x141414],
        [0.12, 0.03, 0.16, -0.2, 1.76, -0.07, 0x6a9a3e], [0.12, 0.03, 0.16, 0.2, 1.76, -0.07, 0x6a9a3e],
        // Long snout and a wide grin.
        [0.26, 0.13, 0.18, 0, 1.54, -0.26, 0x7aa84a], [0.2, 0.08, 0.1, 0, 1.52, -0.38, 0x86b454],
        [0.3, 0.02, 0.2, 0, 1.48, -0.28, 0x3a5a22], [0.03, 0.03, 0.02, -0.05, 1.58, -0.43, 0x2a3a1a], [0.03, 0.03, 0.02, 0.05, 1.58, -0.43, 0x2a3a1a],
        // Orange spines down the back of the head and neck.
        ...[0, 1, 2, 3].map((i): Part => [0.05, 0.08 - i * 0.01, 0.06, 0, 1.78 - i * 0.1, 0.12 + i * 0.05, 0xe07a30]),
        // Yellow flowers on the shirt, and the star.
        ...[[-0.2, 1.3], [0.1, 1.05], [-0.05, 0.88], [0.22, 1.25]].map(([x, y]): Part => [0.08, 0.08, 0.02, x, y, -0.195, 0xf0d040]),
        [0.1, 0.1, 0.03, 0.15, 1.3, -0.2, 0xd0d0d8], [0.04, 0.14, 0.03, 0.15, 1.3, -0.205, 0xd0d0d8], [0.14, 0.04, 0.03, 0.15, 1.3, -0.205, 0xd0d0d8],
        // Tail: thick at the hips, thin at the tip, curling up.
        [0.18, 0.16, 0.34, 0, 0.78, 0.33, 0x7aa84a], [0.12, 0.11, 0.3, 0, 0.66, 0.62, 0x6a9a3e], [0.08, 0.2, 0.08, 0, 0.72, 0.8, 0x6a9a3e],
        // Pale hat, tipped back.
        [0.56, 0.04, 0.56, 0, 1.83, 0.02, 0xd8c8a0], [0.32, 0.17, 0.32, 0, 1.935, 0.03, 0xd8c8a0], [0.33, 0.04, 0.33, 0, 1.87, 0.03, 0x6a4a30],
      ],
    },
  ],
  military: [
    {
      name: 'Soldier', desc: 'Woodland camo, a helmet and ammo pouches.',
      suit: 0x5a6a40, trim: 0x3e4a2c, glow: 0, visor: 0, sleeve: 0x5a6a40, cuff: 0x3e4a2c, glider: 0x5a6a40, crest: 'none', eyes: 'dots',
      parts: [
        [0.14, 0.1, 0.02, -0.12, 1.32, -0.19, 0x2e3622], [0.12, 0.14, 0.02, 0.15, 1.02, -0.19, 0x7a6a48], [0.16, 0.08, 0.02, 0.06, 1.2, -0.19, 0x3a4428],
        [0.14, 0.1, 0.02, 0.12, 1.1, 0.19, 0x2e3622], [0.12, 0.14, 0.02, -0.15, 0.95, 0.19, 0x7a6a48],
        [0.4, 0.14, 0.4, 0, 1.84, 0, 0x4a5634], [0.44, 0.04, 0.44, 0, 1.77, 0, 0x4a5634],
        [0.12, 0.12, 0.06, -0.17, 0.94, -0.21, 0x4a5634], [0.12, 0.12, 0.06, 0, 0.94, -0.21, 0x4a5634], [0.12, 0.12, 0.06, 0.17, 0.94, -0.21, 0x4a5634],
      ],
    },
    {
      name: 'Special Forces', desc: 'Black plate carrier, balaclava and night-vision mount.',
      suit: 0x1c1e22, trim: 0x121316, glow: 0, visor: 0, sleeve: 0x1c1e22, cuff: 0x121316, glider: 0x2b2f38, crest: 'none', eyes: 'dots', face: 0x1a1a1c,
      parts: [
        [0.35, 0.08, 0.35, 0, 1.64, 0, 0xe0b48f],
        [0.4, 0.13, 0.4, 0, 1.84, 0, 0x2a2c30], [0.12, 0.08, 0.1, 0, 1.84, -0.23, 0x3a3c40],
        [0.66, 0.46, 0.44, 0, 1.2, 0, 0x2a2c30],
        [0.1, 0.14, 0.05, -0.16, 1.08, -0.24, 0x3a3c40], [0.1, 0.14, 0.05, 0, 1.08, -0.24, 0x3a3c40], [0.1, 0.14, 0.05, 0.16, 1.08, -0.24, 0x3a3c40],
      ],
    },
    {
      name: 'Pilot', desc: 'Olive flight suit, white helmet, tinted visor and oxygen mask.',
      suit: 0x5a6448, trim: 0x4a5238, glow: 0, visor: 0, sleeve: 0x5a6448, cuff: 0x2a2a2a, glider: 0xe8e8e8, crest: 'none', eyes: 'none',
      parts: [
        [0.4, 0.22, 0.4, 0, 1.74, 0.02, 0xe8e8e8], [0.36, 0.14, 0.05, 0, 1.64, -0.2, 0x202838],
        [0.14, 0.12, 0.1, 0, 1.5, -0.21, 0x3a3a3a], [0.04, 0.3, 0.04, 0.06, 1.33, -0.22, 0x3a3a3a],
        [0.1, 0.06, 0.02, -0.17, 1.32, -0.19, 0xc03030], [0.12, 0.05, 0.02, 0.15, 1.32, -0.19, 0x303030],
        [0.03, 0.62, 0.02, 0, 1.12, -0.185, 0x9a9a9a],
      ],
    },
    {
      name: 'Prisoner', desc: 'Orange jumpsuit and an inmate number.',
      suit: 0xe8741e, trim: 0xd8661a, glow: 0, visor: 0, sleeve: 0xe8741e, cuff: 0xd8661a, glider: 0xe8741e, crest: 'none', eyes: 'dots',
      parts: [
        [0.24, 0.1, 0.02, 0.12, 1.3, -0.19, 0xf0f0f0], [0.18, 0.04, 0.02, 0.12, 1.3, -0.2, 0x222222],
        [0.35, 0.04, 0.35, 0, 1.79, 0, 0x3a2a1a],
        [0.02, 0.62, 0.02, -0.02, 1.12, -0.185, 0xb05a14],
      ],
    },
  ],
  park: [
    {
      name: 'Mascot Bear', desc: 'A fuzzy bear costume with a bow tie.',
      suit: 0x7a4a28, trim: 0x6a3e20, glow: 0, visor: 0, sleeve: 0x7a4a28, cuff: 0x6a3e20, glider: 0xd8a878, crest: 'none', eyes: 'dots', face: 0x7a4a28,
      parts: [
        [0.1, 0.1, 0.06, -0.13, 1.82, 0, 0x7a4a28], [0.1, 0.1, 0.06, 0.13, 1.82, 0, 0x7a4a28],
        [0.05, 0.05, 0.02, -0.13, 1.82, -0.035, 0xd8a878], [0.05, 0.05, 0.02, 0.13, 1.82, -0.035, 0xd8a878],
        [0.16, 0.1, 0.06, 0, 1.54, -0.19, 0xd8a878], [0.06, 0.04, 0.03, 0, 1.57, -0.225, 0x1a1a1a],
        [0.36, 0.42, 0.02, 0, 1.08, -0.185, 0xd8a878],
        [0.14, 0.06, 0.03, 0, 1.42, -0.2, 0xc03040],
      ],
    },
    {
      name: 'Clown', desc: 'White face, red nose, frizzy hair and a ruffle collar.',
      suit: 0x3a8ad0, trim: 0xe8c040, glow: 0, visor: 0, sleeve: 0x3a8ad0, cuff: 0xf0f0f0, glider: 0xe02020, crest: 'none', eyes: 'dots', face: 0xf4f0ea,
      parts: [
        [0.07, 0.07, 0.05, 0, 1.58, -0.2, 0xe02020],
        [0.14, 0.03, 0.02, 0, 1.5, -0.175, 0xc02020], [0.03, 0.04, 0.02, -0.07, 1.52, -0.175, 0xc02020], [0.03, 0.04, 0.02, 0.07, 1.52, -0.175, 0xc02020],
        [0.1, 0.16, 0.22, -0.19, 1.68, 0.02, 0xff5a1a], [0.1, 0.16, 0.22, 0.19, 1.68, 0.02, 0xff5a1a],
        [0.14, 0.14, 0.14, 0, 1.85, 0, 0x40c060], [0.06, 0.1, 0.06, 0, 1.97, 0, 0x40c060],
        [0.5, 0.08, 0.5, 0, 1.46, 0, 0xf0f0f0],
        [0.08, 0.08, 0.04, 0, 1.3, -0.2, 0xe02020], [0.08, 0.08, 0.04, 0, 1.12, -0.2, 0x40c060], [0.08, 0.08, 0.04, 0, 0.94, -0.2, 0xe8c040],
      ],
    },
    {
      name: 'Ride Operator', desc: 'Striped uniform, cap and name badge.',
      suit: 0xf0f0f0, trim: 0x223050, glow: 0, visor: 0, sleeve: 0xf0f0f0, cuff: 0xd03030, glider: 0xd03030, crest: 'none', eyes: 'dots',
      parts: [
        ...[0, 1, 2, 3].map((i): Part => [0.63, 0.06, 0.37, 0, 0.9 + i * 0.16, 0, 0xd03030]),
        [0.1, 0.05, 0.02, -0.15, 1.3, -0.19, 0xf0d040],
        [0.36, 0.1, 0.36, 0, 1.82, 0, 0xd03030], [0.3, 0.03, 0.16, 0, 1.78, -0.24, 0xd03030],
      ],
    },
    {
      name: 'Ghost', desc: 'Just a bedsheet with two eye holes. Spooky.',
      suit: 0xf2f2f4, trim: 0xe8e8ec, glow: 0, visor: 0, sleeve: 0xf2f2f4, cuff: 0xe8e8ec, glider: 0xf2f2f4, crest: 'none', eyes: 'none', face: 0xf2f2f4,
      parts: [
        [0.42, 0.46, 0.42, 0, 1.62, 0, 0xf2f2f4],
        [0.08, 0.1, 0.02, -0.08, 1.66, -0.215, 0x111111], [0.08, 0.1, 0.02, 0.08, 1.66, -0.215, 0x111111], [0.1, 0.07, 0.02, 0, 1.52, -0.215, 0x111111],
        [0.72, 0.5, 0.46, 0, 0.56, 0, 0xf2f2f4],
        [0.14, 0.12, 0.1, -0.28, 0.26, -0.18, 0xe8e8ec], [0.14, 0.12, 0.1, 0.05, 0.26, -0.18, 0xe8e8ec], [0.14, 0.12, 0.1, 0.25, 0.26, 0.16, 0xe8e8ec], [0.14, 0.12, 0.1, -0.1, 0.26, 0.16, 0xe8e8ec],
      ],
    },
  ],
};

/** This build's theme outfits: they come first, so a new player starts in one. */
export const THEMED_SKINS: Skin[] = THEME_SKINS[THEME] ?? [];
/** A bot's outfit in a themed build (by id, so every peer sees the same one). */
export const botOutfit = (id: number) => (THEMED_SKINS.length ? THEMED_SKINS[id % THEMED_SKINS.length] : undefined);

export const SKINS: Skin[] = [
  ...TOY_SKINS,
  ...THEMED_SKINS,
  {
    name: 'Recruit', desc: 'Standard issue fatigues.',
    suit: 0x55687a, trim: 0x2f3b47, glow: 0, visor: 0x222831, sleeve: 0x55687a, cuff: 0x3d4c5a, glider: 0xffb020, crest: 'none',
  },
  {
    name: 'Neon Viper', desc: 'Black stealth suit with glowing green seams and a crest fin.',
    suit: 0x17191e, trim: 0x23272e, glow: 0x39ff88, visor: 0x39ff88, sleeve: 0x1b1e24, cuff: 0x2a2f36, glider: 0x1fdc6a, crest: 'fin',
  },
  {
    name: 'Inferno', desc: 'Scorched armour, molten seams and a pair of horns.',
    suit: 0x6e1a10, trim: 0x2a0d08, glow: 0xff6a10, visor: 0xffb020, sleeve: 0x5a160c, cuff: 0x2a0d08, glider: 0xff4a1a, crest: 'horns',
  },
  {
    name: 'Frost Warden', desc: 'Ice-white plate, blue light and a crystal crown.',
    suit: 0xe4ecf4, trim: 0x9fb4c8, glow: 0x49b8ff, visor: 0x49b8ff, sleeve: 0xdde6ef, cuff: 0x9fb4c8, glider: 0x8ad8ff, crest: 'crown',
  },
  {
    name: 'Shadow Ops', desc: 'Matte black tactical gear with red optics.',
    suit: 0x1f2227, trim: 0x101216, glow: 0xff2a3a, visor: 0xff2a3a, sleeve: 0x202329, cuff: 0x111317, glider: 0x2b2f38, crest: 'none',
  },
  {
    name: 'Jungle Ranger', desc: 'Leaf-green camo and a lime visor.',
    suit: 0x4d6b3a, trim: 0x2f4526, glow: 0xb6e04a, visor: 0xb6e04a, sleeve: 0x4d6b3a, cuff: 0x2f4526, glider: 0x5d8a3a, crest: 'none',
  },
  {
    name: 'Royal Knight', desc: 'Blue plate trimmed in gold, crowned.',
    suit: 0x2a3f9a, trim: 0x18245c, glow: 0xffc043, visor: 0xffc043, sleeve: 0x2a3f9a, cuff: 0xc9a246, glider: 0xffc043, crest: 'crown',
  },
  {
    name: 'Cyber Punk', desc: 'Neon pink seams and a light-up mohawk.',
    suit: 0x2b1440, trim: 0x160a22, glow: 0xff3fd0, visor: 0x3ff0ff, sleeve: 0x2b1440, cuff: 0x3ff0ff, glider: 0xff3fd0, crest: 'mohawk',
  },
  {
    name: 'Desert Nomad', desc: 'Sand-coloured wraps and an amber visor.',
    suit: 0xc9a46a, trim: 0x7a5a36, glow: 0xffb04a, visor: 0xffb04a, sleeve: 0xc9a46a, cuff: 0x7a5a36, glider: 0xe0b060, crest: 'none',
  },
  {
    name: 'Solar Saint', desc: 'White and gold, with a glowing halo.',
    suit: 0xf1ece0, trim: 0xc9a246, glow: 0xffd24a, visor: 0xffd24a, sleeve: 0xf1ece0, cuff: 0xc9a246, glider: 0xfff0b0, crest: 'halo',
  },
  {
    name: 'Eclipse', desc: 'Level 100. Void black, traced in white gold, with a corona behind the head.',
    suit: 0x0b0b0f, trim: 0x141419, glow: 0xffe9b8, visor: 0xffe9b8, sleeve: 0x0b0b0f, cuff: 0x141419, glider: 0x0b0b0f, crest: 'corona', level: 100,
  },
];

/** First-person hand colour: plastic for the toys, skin tone otherwise. */
export const handColor = (s: Skin) => (!TOY || !s.body ? 0xd39a76 : s.body === 'armyman' ? s.suit : s.body === 'robot' ? 0x9aa0a8 : s.body === 'teddy' ? 0xd9b48a : 0xffd23a);
export const skinOf = (i: number | undefined) => SKINS[i ?? 0] ?? SKINS[0];
