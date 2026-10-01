/**
 * The island's visual theme, fixed at build time (`THEME=military npm run share`).
 * 'world' (the main game) is the all-in-one island: cities, towns, a prison, labs, a mine, an airport, a castle,
 * a fair and a Wild West town. 'default' is the older classic mixed island.
 */
export type ThemeId = 'default' | 'military' | 'park' | 'western' | 'world';

declare const __THEME__: string;

export const THEME: ThemeId = (['military', 'park', 'western', 'world'] as string[]).includes(__THEME__) ? (__THEME__ as ThemeId) : 'default';

/** Settings → World, read straight from storage: it has to be known before anything is built. */
function savedWorld(): string | undefined {
  try {
    return JSON.parse(localStorage.getItem('stormfall.settings') ?? '{}').world;
  } catch {
    return undefined;
  }
}

/**
 * TOY BOX (the default world): the island is a green-army-men playset. Tan and olive plastic towns,
 * moulded trees, sandbags and tank traps, clear blue water, giant toys lying around, army-men
 * enemies, foam blasters, and toy bosses guarding mythic guns. 'classic' is the old look.
 */
export const TOY = THEME === 'world' && savedWorld() !== 'classic';
