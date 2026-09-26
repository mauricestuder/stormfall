export type Quality = 'low' | 'medium' | 'high';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type TimeOfDay = 'random' | 'day' | 'sunset' | 'night';
export type Weather = 'random' | 'clear' | 'rain' | 'fog';

export interface SettingsData {
  sensitivity: number;
  adsSensitivity: number;
  /** How quickly you raise the sights (1 = the old snappy speed). */
  adsSpeed: number;
  invertY: boolean;
  fov: number;
  volume: number;
  ambientVolume: number;
  musicVolume: number;
  musicInMatch: boolean;
  quality: Quality;
  showFps: boolean;
  damageNumbers: boolean;
  /** Damage number scale (1 = the old size). */
  damageNumberSize: number;
  visualSound: boolean;
  crosshairColor: string;
  autoSprint: boolean;
  // Match setup
  botDifficulty: Difficulty;
  botCount: number;
  squadSize: number;
  timeOfDay: TimeOfDay;
  weather: Weather;
  /** How characters look: toy mini figures, round chubby people, monsters, a mix, or the classic soldiers. */
  bodyStyle: 'mix' | 'minifig' | 'chubby' | 'monster' | 'classic' | 'armyman' | 'teddy' | 'robot';
  /** Toy Box or the classic island (takes a restart: the whole world is built from it). */
  world: 'toy' | 'classic';
  // Video extras
  postFx: boolean;
  dynamicRes: boolean;
  // Controls
  binds: Record<string, string>;
  gamepadSens: number;
  gamepadSensY: number;
  gamepadDeadzone: number;
  gamepadInvertY: boolean;
  gamepadCurve: number;
  /** Button prompts: auto (from the controller), Xbox or PlayStation. */
  padGlyphs: 'auto' | 'xbox' | 'ps';
  touchControls: 'auto' | 'on' | 'off';
  toggleAim: boolean;
  toggleCrouch: boolean;
  // Camera & HUD
  brightness: number;
  screenShake: number;
  cameraTilt: boolean;
  speedFov: boolean;
  hudScale: number;
  showMinimap: boolean;
  showKillfeed: boolean;
  crosshairStyle: 'cross' | 'dot' | 'crossdot' | 'circle';
  crosshairSize: number;
}

const touchDevice = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

const DEFAULTS: SettingsData = {
  sensitivity: 1,
  adsSensitivity: 0.65,
  adsSpeed: 0.55,
  invertY: false,
  fov: 90,
  volume: 0.6,
  ambientVolume: 0.5,
  musicVolume: 0.5,
  musicInMatch: true,
  quality: touchDevice ? 'low' : 'high',
  showFps: false,
  damageNumbers: true,
  damageNumberSize: 1.5,
  visualSound: true,
  crosshairColor: '#ffffff',
  autoSprint: false,
  botDifficulty: 'normal',
  botCount: 49,
  squadSize: 1,
  timeOfDay: 'random',
  weather: 'random',
  bodyStyle: 'mix',
  world: 'toy',
  postFx: !touchDevice,
  dynamicRes: true,
  binds: {},
  gamepadSens: 1,
  gamepadSensY: 0.75,
  gamepadDeadzone: 0.15,
  gamepadInvertY: false,
  gamepadCurve: 2,
  padGlyphs: 'auto',
  touchControls: 'auto',
  toggleAim: false,
  toggleCrouch: false,
  brightness: 1,
  screenShake: 1,
  cameraTilt: true,
  speedFov: true,
  hudScale: 1,
  showMinimap: true,
  showKillfeed: true,
  crosshairStyle: 'crossdot',
  crosshairSize: 1,
};

const KEY = 'stormfall.settings';

/** Player options, persisted to localStorage when available. */
export class Settings {
  data: SettingsData;
  private listeners: ((s: SettingsData) => void)[] = [];

  constructor() {
    let saved: Partial<SettingsData> = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    } catch { /* storage unavailable or corrupt */ }
    // The old default lobby (23 bots) becomes the new one (49 bots + you = 50 players).
    if (saved.botCount === 23) saved.botCount = 49;
    this.data = { ...DEFAULTS, ...saved, binds: { ...(saved.binds ?? {}) } };
    this.data.fov = Math.min(90, this.data.fov);
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch { /* storage unavailable */ }
    for (const l of this.listeners) l(this.data);
  }

  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]) {
    this.data[key] = value;
    this.save();
  }

  reset() {
    const binds = this.data.binds;
    Object.assign(this.data, DEFAULTS, { binds });
    this.save();
  }

  resetBinds() {
    this.data.binds = {};
    this.save();
  }

  onChange(fn: (s: SettingsData) => void) {
    this.listeners.push(fn);
    fn(this.data);
  }
}
