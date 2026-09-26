/**
 * The island's visual theme, fixed at build time (`THEME=military npm run share`).
 * 'world' (the main game) is the all-in-one island: cities, towns, a prison, labs, a mine, an airport, a castle,
 * a fair and a Wild West town. 'default' is the older classic mixed island.
 */
export type ThemeId = 'default' | 'military' | 'park' | 'western' | 'world';

declare const __THEME__: string;

export const THEME: ThemeId = (['military', 'park', 'western', 'world'] as string[]).includes(__THEME__) ? (__THEME__ as ThemeId) : 'default';
