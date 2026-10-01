import {
  ACESFilmicToneMapping, DirectionalLight, Fog, HemisphereLight, MeshLambertMaterial, PCFShadowMap, PCFSoftShadowMap, PerspectiveCamera,
  Scene, SRGBColorSpace, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { adaptTuning, Bot, DIFFICULTY, type BotTuning } from '../bots/Bot';
import { BotManager } from '../bots/BotManager';
import { CONFIG } from '../config';
import { boxNormal, rayBox, type Box } from '../core/Collision';
import { Input } from '../core/Input';
import { NavGrid, SpatialGrid } from '../core/NavGrid';
import { clamp, damp, lerp, mulberry32 } from '../core/rng';
import { Settings, type SettingsData } from '../core/Settings';
import { Player } from '../player/Player';
import { Hud } from '../ui/Hud';
import { Menus } from '../ui/Menus';
import { Prompts } from '../ui/Prompts';
import { Touch } from '../ui/Touch';
import { Vehicle, VEHICLE_SPECS, type VehicleKind } from '../vehicles/Vehicle';
import { LootManager, lootLabel, type LootKind } from '../weapons/Loot';
import { PlayerWeapons } from '../weapons/PlayerWeapons';
import { setViewCamo } from '../weapons/ViewModel';
import {
  AMMO_INFO, ATT_KINDS, ATTACHMENTS, canAttach, damageFalloff, FISTS, makeWeapon, magSize, RARITIES, THROWABLES, WEAPON_IDS,
  type AmmoType, type WeaponId, type WeaponInstance,
} from '../weapons/Weapon';
import { Features } from '../world/Features';
import { Tumbleweeds } from '../world/Tumbleweeds';
import { Ambient } from '../world/Ambient';
import { Fires } from '../world/Fires';
import { Train, type Cargo } from '../world/Train';
import { THEME, TOY } from '../theme';
import { spawnBosses } from '../bots/Boss';

/** Hit effects: blood, or (Toy Box) a puff of stuffing. */
const BLOOD = TOY ? 0xf6f0e2 : 0xa01010;
import { Destructibles, Doors, Glass, Ziplines } from '../world/Interactive';
import { buildGlider, GLIDER_HEIGHT } from '../world/Glider';
import { handColor, skinOf } from './Skins';
import { applyEnvironment } from './Look';
import { GLIDERS, TRAILS, trailColor } from './Cosmetics';
import { Lobby } from './Lobby';
import { GameMap, type POI } from '../world/Map';
import { applyDamage, rayHitCombatant, type Combatant } from './Combat';
import { Arena, planArenaBots } from './Arena';
import { Cheats, cheatOn } from './Cheats';
import { OnlineBR, unpackLoot } from './OnlineBR';
import type { ArenaKind, BotEntry, DMKind, LootLayout, Net, RosterEntry } from '../net/Net';
import { Plane } from './DropPhase';
import { Environment } from './Environment';
import { Killcam } from './Killcam';
import { DEATH_CAM_MS, DeathCam } from './DeathCam';
import { SelfBody } from '../player/SelfBody';
import { LoadScreen, type LoadInfo } from '../ui/LoadScreen';
import { setBodyStyle } from '../bots/Character';
import { Music, type SongName } from './Music';
import { Particles } from './Particles';
import { PostFx } from './PostFx';
import { INK, InkSky, outlineHulls, stylize, TOON } from './Style';
import { Profile } from './Profile';
import { PadCursor } from '../ui/PadCursor';
import { Projectiles } from './Projectiles';
import { Sfx } from './Sfx';
import { Zone } from './Zone';

const STEP = 1 / 60;
type State = 'loading' | 'title' | 'playing' | 'paused' | 'killcam' | 'over';

const STREAK_NAMES = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'QUAD KILL', 'RAMPAGE'];
const GULAG_TIME = 45;
/** Countdown in the Gulag before the fight starts. */
const GULAG_PREP = 7;
/** Health a kill gives back, and how fast (per second) it comes in. */
const KILL_HEAL = 30;
const KILL_HEAL_RATE = 6;
const GULAG_LOADOUTS: WeaponId[] = ['pistol', 'revolver', 'shotgun', 'smg'];

/** Flashbang reach in metres. */
const FLASH_R = 32;

export class Game {
  renderer: WebGLRenderer;
  scene = new Scene();
  camera: PerspectiveCamera;
  input: Input;
  map: GameMap;
  get world() {
    return this.map.world;
  }
  settings = new Settings();
  profile = new Profile();
  padCursor!: PadCursor;
  player = new Player();
  weapons!: PlayerWeapons;
  bots = new BotManager();
  loot!: LootManager;
  zone!: Zone;
  plane!: Plane;
  fx!: Particles;
  features!: Features;
  /** Western: tumbleweeds blowing across the desert. */
  tumbleweeds: Tumbleweeds | null = null;
  /** Birds and butterflies. */
  ambient!: Ambient;
  fires: Fires | null = null;
  private artilleryT = 12;
  /** Western: the train on its loop. */
  train: Train | null = null;
  doors!: Doors;
  glass!: Glass;
  props!: Destructibles;
  ziplines!: Ziplines;
  projectiles!: Projectiles;
  nav!: NavGrid;
  grid = new SpatialGrid<Combatant>();
  /** Pathfinding searches bots may still start this step (spreads the cost out). */
  pathBudget = 0;
  tuning: BotTuning = DIFFICULTY.normal;
  env!: Environment;
  postFx: PostFx | null = null;
  private inkSky: InkSky | null = null;
  killcam!: Killcam;
  deathCam!: DeathCam;
  private selfBody!: SelfBody;
  loadScreen = new LoadScreen();
  touch: Touch | null = null;
  vehicles: Vehicle[] = [];
  /** The vehicle the player is driving, if any. */
  driving: Vehicle | null = null;
  sfx = new Sfx();
  music = new Music();
  /** The player's paraglider, seen overhead when you look up. */
  private glider = buildGlider(0xffb020);
  private musicInMatch = true;
  private overAt = 0;
  hud!: Hud;
  menus!: Menus;
  combatants: Combatant[] = [];

  state: State = 'loading';
  matchTime = 0;
  pickupPrompt = '';
  sensitivity = 1;
  practiceMode = false;
  /** Keyboard or controller button prompts, whichever you used last. */
  prompts!: Prompts;
  /** Admin tools (hidden in Options; offline only). */
  cheats!: Cheats;
  /** Arena / team deathmatch rules, when playing those. */
  arena: Arena | null = null;
  /** Online battle royale with friends. */
  obr: OnlineBR | null = null;
  /** Teams with a human on them (you, and friends online): bots treat them as "the player". */
  humanTeams = new Set<number>();
  private arenaNav: NavGrid | null = null;
  /** Gulag: one second chance per match while the zone is young. */
  gulagFight = false;
  gulagUsed = false;
  /** Online: your one redeploy has been used. */
  redeployUsed = false;
  /** Online: people who went down but are coming back (their squad still counts as alive). */
  redeploying = new Set<Combatant>();
  gulagTimer = 0;
  gulagPrep = 0;
  private gulagFoe: Bot | null = null;
  private gulagName = '';
  /** Your match stats for XP. */
  stats = { damage: 0, hits: 0, headshots: 0, headshotKills: 0 };
  private acc = 0;
  private last = performance.now();
  private sun: DirectionalLight;
  private hemi: HemisphereLight;
  private fog: Fog;
  private viewDist = 1;
  private detailMul = 1;
  private shadowEvery = 1;
  frameNo = 0;
  private cursorHidden = false;
  private lockHintShown = false;
  /** Give a lock request a moment to succeed before asking for a click. */
  private lockAskFrame = 0;
  private dynScale = 1;
  private dynAcc = 0;
  private dynFrames = 0;
  private basePixelRatio = 1;
  private wasSliding = false;
  private lastMode = '';
  private lastZoneState = '';
  private lastPhase = 0;
  private planeGone = false;
  private shake = 0;
  lobby: Lobby | null = null;
  /** Squads in this battle royale when it started (for adaptive bot strength). */
  private teamsAtStart = 0;
  /** Paraglider: 0..1 while it unfolds, and how far it banks into a turn. */
  private gliderT = 0;
  private gliderBank = 0;
  private gliderYaw = 0;
  private stepDist = 0;
  private botSteps = new Map<number, number>();
  private birdTimer = 5;
  private humTimer = 0;
  private whizCd = 0;
  private mouseIdle = 0;
  private recentKills: number[] = [];
  private runOverCd = new Map<Combatant, number>();
  private barrelBy = new Map<object, Combatant>();
  private gridTimer = 0;
  private dummyRespawn: { bot: Bot; at: Vector3; t: number }[] = [];
  private occupiedScratch: Combatant[] = [];

  constructor(container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.basePixelRatio = Math.min(devicePixelRatio, 1.5);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.camera = new PerspectiveCamera(CONFIG.player.baseFov, innerWidth / innerHeight, 0.05, 3000);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.fog = new Fog(0x9fd4ff, 200, 800);
    this.scene.fog = this.fog;
    this.hemi = new HemisphereLight(0xdff1ff, 0x5a7a3a, 1.4);
    this.scene.add(this.hemi);
    this.sun = new DirectionalLight(0xfff1d6, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -70;
    sc.right = sc.top = 70;
    sc.near = 1;
    sc.far = 400;
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);

    this.input = new Input(this.renderer.domElement);
    this.prompts = new Prompts(this.input);
    this.map = new GameMap(this.scene);
  }

  /** Builds the world in stages so the loading bar can move. */
  async init(progress: (frac: number, label: string) => void) {
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));
    const stages = 12;
    let n = 0;
    for (const label of this.map.build()) {
      progress(n++ / stages, label);
      await tick();
    }
    progress(n++ / stages, 'Spawning loot');
    await tick();
    this.fx = new Particles(this.scene);
    this.loot = new LootManager(this.scene);
    this.loot.place = (from, to) => this.clearLootSpot(from, to);
    this.loot.headroom = (p, max) => this.world.raycast(tmpEnd.set(p.x, p.y + 0.2, p.z), UP, max) + 0.2;
    this.loot.onOpen = (c) => {
      const at = c.pos.clone().setY(c.pos.y + (c.supply ? 1.2 : 0.6));
      if (at.distanceToSquared(this.camera.position) < 60 * 60) this.fx.burst(at, 0xffd24a, 22, { speed: 3.5, size: 0.06, life: 0.8, gravity: 3, up: 1.4, alpha: 0.9 });
    };
    this.loot.populate(this.map.lootSpots, (s) => this.chestSpot(s));
    // Vaults and armouries: a golden chest every match.
    const vaults = this.map.vaultSpots.map((v) => {
      this.loot.addChest(v, true).landed = true;
      return v;
    });
    this.features = new Features(this.scene, this.map, this.world, this.loot, this.fx);
    if (this.map.track.length) {
      this.train = new Train(this.scene, this.world, this.map.track, this.map.trainStops);
      this.stockTrain();
    }
    if (THEME === 'western') this.tumbleweeds = new Tumbleweeds(this.scene, (x, z) => this.map.groundAt(x, z), this.world, (x, z) => this.map.isWater(x, z));
    this.ambient = new Ambient(this.scene, (x, z) => this.map.groundAt(x, z), (x, z) => this.map.isWater(x, z));
    if (this.map.fires.length) this.fires = new Fires(this.scene, this.map.fires);
    for (const v of vaults) this.features.solidCrate(v);
    progress(n++ / stages, 'Hanging doors and windows');
    await tick();
    this.doors = new Doors(this.scene, this.map.doors, this.world);
    this.glass = new Glass(this.scene, this.map.glass, 2400, this.fx, this.sfx);
    this.props = new Destructibles(this.scene, this.map.props, this.world, this.fx, this.sfx);
    this.ziplines = new Ziplines(this.map);
    this.player.zips = this.ziplines;
    this.nav = new NavGrid(this.world, CONFIG.mapSize);
    this.props.onBreak = (b) => this.nav.invalidate(b);
    this.projectiles = new Projectiles(this.scene, this);
    progress(n++ / stages, 'Fuelling vehicles');
    await tick();
    this.spawnVehicles();
    this.zone = new Zone(this.scene);
    this.zone.groundAt = (x, z) => this.map.groundAt(x, z);
    this.plane = new Plane(this.scene);
    this.weapons = new PlayerWeapons(this.camera, this);
    applyEnvironment(this.renderer, [this.scene, this.weapons.view.vmScene]);
    this.cheats = new Cheats(this);
    this.env = new Environment(this.scene, this.camera, this.sun, this.hemi, this.fog, this.sfx);
    this.killcam = new Killcam(this);
    this.deathCam = new DeathCam(this);
    this.selfBody = new SelfBody(this.scene);
    this.hud = new Hud(this);
    this.lobby = new Lobby(this);
    // Cars and doors went in after the loot: move anything they landed on.
    this.reseatLoot();
    progress(n++ / stages, 'Warming up shaders');
    await tick();

    this.combatants = [this.player];
    this.player.yaw = Math.atan2(-this.plane.dir.x, -this.plane.dir.z);
    this.plane.position(this.player.body.pos);
    this.zone.start();
    this.zone.update(0);
    this.env.setup(this.settings.data.timeOfDay, this.settings.data.weather);
    this.zone.setDark(this.env.isNight);

    this.touch = new Touch(this.input, () => this.pause(), () => this.hud.toggleBigMap(), () => this.toggleInventory());
    this.menus = new Menus(this);
    this.padCursor = new PadCursor(this);
    this.settings.onChange((s) => this.applySettings(s));
    this.applySettings(this.settings.data);
    // Pointer lock can be refused (match started by a network message, or re-locking too soon
    // after Esc). Any click on the game while playing grabs the mouse again.
    window.addEventListener('mousedown', (e) => {
      if (this.state !== 'playing' || this.input.locked || this.touchActive || this.hud.invOpen) return;
      if ((e.target as HTMLElement).closest?.('button, input, select, .overlay:not(.hidden)')) return;
      this.input.lock();
    });
    this.input.onLockChange = (locked) => {
      if (!locked && this.state === 'playing' && !this.touchActive && !this.hud.invOpen) this.pause();
    };
    this.hud.onSwapSlots = () => this.swapSlots();
    this.hud.onInventoryClose = () => this.toggleInventory(false);
    addEventListener('keydown', (e) => {
      // The cursor is free while the inventory is open, so Escape goes to the pause menu.
      if (e.code === 'Escape' && this.hud.invOpen) {
        this.toggleInventory(false, false);
        this.pause();
      }
    });
    this.input.onPadPause = () => (this.state === 'playing' ? this.pause() : this.state === 'paused' ? this.resume() : undefined);
    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.postFx?.setSize(innerWidth, innerHeight, this.renderer.getPixelRatio());
    });
    // Compile everything once so the first seconds of play don't stutter.
    this.renderer.compile(this.scene, this.camera);
    this.state = 'title';
    progress(1, 'Ready');
  }

  get touchActive() {
    const t = this.settings.data.touchControls;
    return t === 'on' || (t === 'auto' && matchMedia('(pointer: coarse)').matches);
  }

  private spawnVehicles() {
    const spots = [...this.map.vehicleSpots].sort(() => Math.random() - 0.5).slice(0, 28);
    for (const s of spots) {
      const r = Math.random();
      const kind: VehicleKind = r < 0.5 ? 'car' : r < 0.8 ? 'buggy' : 'truck';
      this.vehicles.push(new Vehicle(kind, s.x, s.y, s.z, s.yaw, this.scene));
    }
  }

  applySettings(s: SettingsData) {
    if (THEME === 'world' && (s.world === 'classic') === TOY) {
      // The world is built at startup: switching it means starting over (only from the menus).
      if (this.state === 'title') setTimeout(() => location.reload(), 150);
      else this.hud.pickupToast('The new world loads next time you start the game', '#ffd24a');
    }
    setBodyStyle(s.bodyStyle);
    this.sensitivity = s.sensitivity;
    this.player.autoSprint = s.autoSprint;
    this.player.toggleCrouch = s.toggleCrouch;
    this.weapons.toggleAim = s.toggleAim;
    this.weapons.adsSpeed = s.adsSpeed;
    this.sfx.setVolume(s.volume, s.ambientVolume);
    this.music.setVolume(s.musicVolume);
    this.musicInMatch = s.musicInMatch;
    this.input.setBinds(s.binds);
    this.input.padSens = s.gamepadSens;
    this.input.padSensY = s.gamepadSensY;
    this.input.padDeadzone = s.gamepadDeadzone;
    this.input.padInvertY = s.gamepadInvertY;
    this.input.padCurve = s.gamepadCurve;
    this.prompts.pref = s.padGlyphs;
    this.prompts.refresh();
    if (this.touch) this.touch.sens = s.sensitivity;
    const q = s.quality;
    // Epic renders above screen resolution on ordinary monitors (super-sampling: crisp edges, no shimmer).
    this.basePixelRatio = q === 'epic' ? Math.min(Math.max(devicePixelRatio, 1.5), 2) : Math.min(devicePixelRatio, q === 'low' ? 0.85 : q === 'medium' ? 1.15 : 1.5);
    this.applyPixelRatio();
    this.sun.castShadow = q !== 'low';
    const size = q === 'epic' ? 4096 : q === 'high' ? 2048 : 1024;
    const ext = q === 'epic' ? 110 : 70, sc = this.sun.shadow.camera;
    if (sc.right !== ext) {
      sc.left = sc.bottom = -ext;
      sc.right = sc.top = ext;
      sc.updateProjectionMatrix();
    }
    this.renderer.shadowMap.type = q === 'epic' ? PCFSoftShadowMap : PCFShadowMap;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    // Shadows only need refreshing every few frames on lower settings.
    this.shadowEvery = q === 'high' || q === 'epic' ? 1 : q === 'medium' ? 2 : 3;
    this.renderer.shadowMap.autoUpdate = this.shadowEvery === 1;
    this.viewDist = q === 'low' ? 0.7 : q === 'medium' ? 0.85 : q === 'epic' ? 1.3 : 1;
    this.detailMul = q === 'low' ? 0.6 : q === 'medium' ? 0.8 : q === 'epic' ? 1.6 : 1;
    this.map.setDetail(q !== 'low');
    if (INK) s.postFx = true;
    if (s.postFx && !this.postFx) {
      this.postFx = new PostFx(this.renderer, this.scene, this.camera);
      this.postFx.setSize(innerWidth, innerHeight, this.renderer.getPixelRatio());
      this.postFx.setLook(this.env.tod, this.env.wx);
    }
    this.hud.applySettings(s);
    this.touch?.show(this.touchActive && (this.state === 'playing' || this.state === 'paused'));
  }

  private applyPixelRatio() {
    const pr = this.basePixelRatio * this.dynScale;
    this.renderer.setPixelRatio(pr);
    this.postFx?.setSize(innerWidth, innerHeight, pr);
  }

  /** Dynamic resolution: drop render scale when frames are slow, raise it back when there's headroom. */
  private updateDynRes(dt: number) {
    if (!this.settings.data.dynamicRes) {
      if (this.dynScale !== 1) {
        this.dynScale = 1;
        this.applyPixelRatio();
      }
      return;
    }
    this.dynAcc += dt;
    this.dynFrames++;
    if (this.dynAcc < 1) return;
    const avg = this.dynAcc / this.dynFrames;
    this.dynAcc = this.dynFrames = 0;
    const before = this.dynScale;
    if (avg > 1 / 48) this.dynScale = Math.max(0.55, this.dynScale - 0.1);
    else if (avg < 1 / 57) this.dynScale = Math.min(1, this.dynScale + 0.05);
    if (this.dynScale !== before) this.applyPixelRatio();
  }

  // ---------- match flow ----------

  private setupMatch() {
    const s = this.settings.data;
    this.tuning = adaptTuning(DIFFICULTY[s.botDifficulty], this.profile.data.adapt);
    this.bots.spawnAll(this, Math.max(1, Math.round(s.botCount)), s.squadSize);
    // Bosses wait at a few big towns, each guarding a Mythic gun.
    this.bots.bots.push(...spawnBosses(this, 5000));
    this.combatants = [this.player, ...this.bots.bots];
    this.teamsAtStart = this.aliveTeams(-1).size;
    setViewCamo(this.profile.camoColor);
    this.weapons.view.refresh();
    this.applySkin();
    this.env.setup(s.timeOfDay, s.weather);
    this.applyLook();
  }

  /** Night dims the sea (it's lit by the same sky light as the land) and softens the storm wall. */
  private applyLook() {
    this.zone.setDark(this.env.isNight);
    this.map.setNight(this.env.isNight);
    this.postFx?.setLook(this.env.tod, this.env.wx);
    (this.map.sea.material as MeshLambertMaterial).color.setHex(TOY ? (this.env.isNight ? 0x163a6a : 0x2aa6ee) : this.env.isNight ? 0x163a5c : 0x2f8fcf);
  }

  private gliderKey = '';

  /** The outfit from the Locker: first-person sleeves and your glider. */
  applySkin() {
    const on = this.profile.data.knife === 1;
    this.weapons.view.knifeOn = on;
    FISTS.def.name = on ? 'Butterfly Knife' : 'Fists';
    const s = skinOf(this.profile.data.skin);
    this.weapons.view.setSkin(s.sleeve, s.cuff, s.glow, handColor(s));
    const gi = this.profile.data.glider, d = GLIDERS[gi] ?? GLIDERS[0];
    const key = gi > 0 ? `d${gi}` : `o${s.glider}`;
    if (key !== this.gliderKey) {
      this.scene.remove(this.glider);
      this.glider = gi > 0 ? buildGlider(d.color, d.accent, d.pattern) : buildGlider(s.glider);
      this.gliderKey = key;
    }
  }

  /** Rendered shots of the island's towns for the loading card (taken in the menus, once per island). */
  private shots: { map: GameMap; list: { url: string; name: string; u: number; v: number }[]; order: POI[]; at: number } | null = null;

  /**
   * One wide shot of a town, drawn straight to the screen canvas and grabbed as a JPEG. The normal
   * frame is drawn over it right after, before the browser shows anything, so it never flashes.
   */
  private captureShot() {
    if (this.arena || !this.map.pois.length) return;
    if (this.shots?.map !== this.map) {
      // Ten views: the cities and towns first (the big ones twice, from different sides), then the rest.
      const rank = (p: POI) => (p.size === 'city' ? 0 : p.size === 'town' ? 1 : 2);
      const pois = [...this.map.pois].sort(() => Math.random() - 0.5).sort((a, b) => rank(a) - rank(b));
      const order = [...pois.filter((p) => rank(p) === 0), ...pois];
      this.shots = { map: this.map, list: [], order: order.slice(0, 10), at: 0 };
    }
    const s = this.shots, p = s.order[s.list.length];
    if (!p) return;
    if (this.renderer.domElement.width < 64) return; // hidden window: nothing worth keeping
    // Drawn big (1.75x of 1920x1080), then scaled down onto a 2D canvas: smooth edges, crisp detail.
    const W = 1920, H = 1080, SS = 1.75, prevPR = this.renderer.getPixelRatio(), prevSize = this.renderer.getSize(new Vector2());
    const cam = new PerspectiveCamera(50, W / H, 0.5, 4000);
    const [sx, sy, sz] = this.env.sunOffset;
    // Stand on the sunny side (the light behind the camera) and look in over the town, from a spot
    // that isn't inside anything and can actually see the middle.
    const sunA = Math.atan2(sz, sx), d = Math.max(50, p.radius * 0.95 + 25);
    const seen = s.list.filter((l) => l.name === p.name).length;
    let best: Vector3 | null = null, bestScore = -Infinity;
    const eye = new Vector3(), mid = new Vector3(p.x, p.y + 4, p.z), dir = new Vector3();
    for (let k = 0; k < 14; k++) {
      const a = sunA + (seen ? Math.PI * 0.55 : 0) + (Math.random() - 0.5) * 1.8;
      const cx = p.x + Math.cos(a) * d, cz = p.z + Math.sin(a) * d;
      eye.set(cx, Math.max(p.y, this.map.groundAt(cx, cz), 0.5) + 9 + p.radius * 0.16 + Math.random() * 6, cz);
      if (this.world.anyOverlap(eye.x - 1, eye.y - 1, eye.z - 1, eye.x + 1, eye.y + 1, eye.z + 1)) continue;
      const len = dir.subVectors(mid, eye).length();
      const clear = Math.min(1, this.world.raycast(eye, dir.normalize(), len) / len);
      // Nothing big right in front of the lens (a wall filling half the picture).
      let near = 0;
      for (const yo of [-0.35, -0.12, 0.12, 0.35]) {
        const c = Math.cos(yo), sn = Math.sin(yo), rd = tmpEnd.set(dir.x * c - dir.z * sn, dir.y - 0.08, dir.x * sn + dir.z * c).normalize();
        near += Math.max(0, 1 - this.world.raycast(eye, rd, 35) / 35);
      }
      const score = clear * 2 - near * 1.2 + Math.cos(a - sunA) * 0.6 + (this.map.isWater(cx, cz) ? -0.3 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = eye.clone();
      }
    }
    if (!best) {
      s.order.splice(s.list.length, 1);
      return;
    }
    cam.position.copy(best);
    // Aim a little past the middle and off to one side, so the town fills the frame at an angle.
    const side = Math.random() < 0.5 ? -1 : 1, fx = p.x - best.x, fz = p.z - best.z, fl = Math.hypot(fx, fz) || 1;
    cam.lookAt(p.x - (fz / fl) * side * p.radius * 0.15, p.y + 1, p.z + (fx / fl) * side * p.radius * 0.15);
    cam.updateMatrixWorld();
    const sunPos = this.sun.position.clone(), sunAt = this.sun.target.position.clone();
    const lobbyVis = this.lobby?.group.visible ?? false, zoneShown = this.zone.shown, fogFar = this.fog.far, fogNear = this.fog.near;
    this.sun.target.position.set(p.x, p.y, p.z);
    this.sun.position.set(p.x + sx, p.y + sy, p.z + sz);
    this.sun.target.updateMatrixWorld();
    this.renderer.shadowMap.needsUpdate = true;
    if (this.lobby) this.lobby.group.visible = false;
    this.zone.shown = false;
    this.fog.far = 1400;
    this.fog.near = 500;
    this.map.cull(cam.position, 1400, 3, true);
    try {
      this.renderer.setRenderTarget(null);
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(Math.round(W * SS), Math.round(H * SS), false);
      this.renderer.render(this.scene, cam);
      // Scale down with a light grade (the game's own look: a touch more saturation and contrast).
      const out = document.createElement('canvas');
      out.width = W;
      out.height = H;
      const ctx = out.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.filter = 'saturate(1.14) contrast(1.07)';
      ctx.drawImage(this.renderer.domElement, 0, 0, W, H);
      const url = out.toDataURL('image/jpeg', 0.9);
      if (url.length < 2000) throw new Error('blank');
      s.list.push({ url, name: p.name, u: p.x / this.map.size + 0.5, v: p.z / this.map.size + 0.5 });
    } catch {
      s.order.splice(s.list.length, 1);
    }
    this.renderer.setPixelRatio(prevPR);
    this.renderer.setSize(prevSize.x, prevSize.y, false);
    this.sun.position.copy(sunPos);
    this.sun.target.position.copy(sunAt);
    this.sun.target.updateMatrixWorld();
    this.renderer.shadowMap.needsUpdate = true;
    if (this.lobby) this.lobby.group.visible = lobbyVis;
    this.zone.shown = zoneShown;
    this.fog.far = fogFar;
    this.fog.near = fogNear;
  }

  /** The loading card's text for a match. */
  private loadInfo(mode: string, sub: string): LoadInfo {
    for (let i = 0; i < 4 && !this.arena && (this.shots?.map !== this.map || this.shots.list.length < Math.min(3, this.shots.order.length)); i++) this.captureShot();
    const shots = this.shots?.map === this.map ? [...this.shots.list].sort(() => Math.random() - 0.5) : [];
    return { mode, sub, map: this.map.mapCanvas, shots };
  }

  /** Shows the loading screen, grabbing the mouse while we still have the click, then runs `work`. */
  private withLoading(info: LoadInfo, work: () => void, now = false) {
    if (this.loadScreen.busy) return;
    this.sfx.unlock();
    if (!this.touchActive) this.input.lock();
    this.loadScreen.run(info, () => {
      work();
      // Compile the scene's shaders now, behind the card, not on the first frame of the match.
      try {
        this.renderer.compile(this.scene, this.camera);
        this.prerenderIsland();
      } catch { /* not essential */ }
    }, { now, minMs: now ? 1300 : 3300 });
  }

  /**
   * Draws the whole island once, from high above, behind the loading card: every chunk's mesh gets
   * uploaded to the GPU now, so flying over the map in the plane doesn't hitch or pop.
   */
  private prerenderIsland() {
    if (this.arena) return;
    const cam = new PerspectiveCamera(90, 1, 5, 8000);
    cam.position.set(0, 1800, 0.01);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    this.map.cull(cam.position, 99999, 1, true);
    const fogFar = this.fog.far;
    this.fog.far = 99999;
    this.renderer.render(this.scene, cam);
    this.fog.far = fogFar;
  }

  /** PLAY button. */
  play() {
    const s = this.settings.data, squad = ['SOLOS', 'DUOS', 'TRIOS', 'QUADS'][s.squadSize - 1] ?? 'SOLOS';
    this.withLoading(this.loadInfo('BATTLE ROYALE', `${squad} · ${Math.round(s.botCount) + 1} PLAYERS · ${s.botDifficulty.toUpperCase()} BOTS`), () => this.playNow());
  }

  private playNow() {
    this.setupMatch();
    this.begin();
    this.hud.announce('GET READY TO DROP', 3);
    const bosses = this.bots.bots.filter((b) => b.boss).length;
    if (bosses) setTimeout(() => this.hud.pickupToast(`${bosses} bosses guard Mythic guns — look for the crowns on the map`, '#ff5ad8'), 5000);
    if (this.env.isNight) setTimeout(() => this.hud.pickupToast('Night drop — press L for your flashlight', '#ffd24a'), 3500);
  }

  /** PRACTICE button: the airport runway with target dummies and every gun. */
  practice() {
    this.withLoading(this.loadInfo('PRACTICE RANGE', 'EVERY GUN · TARGET DUMMIES'), () => this.practiceNow());
  }

  private practiceNow() {
    this.practiceMode = true;
    this.applySkin();
    this.setupPractice();
    this.begin();
    this.hud.announce('PRACTICE RANGE', 3);
  }

  /**
   * ARENA: team deathmatch or free-for-all on the Foundry, against bots or with friends online.
   * `roster` is the human players (just you offline); `bots` fill the rest.
   */
  startArena(kind: DMKind, net: Net | null, roster: RosterEntry[], bots: BotEntry[] | null, look?: { tod: string; wx: string }) {
    const info: LoadInfo = { mode: kind === 'tdm' ? 'TEAM DEATHMATCH' : 'FREE-FOR-ALL', sub: net ? 'ONLINE · THE FOUNDRY' : 'VS BOTS · THE FOUNDRY' };
    this.withLoading(info, () => this.startArenaNow(kind, net, roster, bots, look), !!net);
  }

  private startArenaNow(kind: DMKind, net: Net | null, roster: RosterEntry[], bots: BotEntry[] | null, look?: { tod: string; wx: string }) {
    const s = this.settings.data;
    this.tuning = DIFFICULTY[s.botDifficulty];
    this.arena = new Arena(this, kind, net);
    setViewCamo(this.profile.camoColor);
    this.weapons.view.refresh();
    this.applySkin();
    this.plane.active = false;
    this.planeGone = true;
    this.plane.dispose(this.scene);
    this.zone.radius = 5000;
    this.zone.state = 'closed';
    this.zone.update(0);
    this.arenaNav ??= new NavGrid(this.world, 104, this.map.arena.x, this.map.arena.z, 0.1);
    this.nav = this.arenaNav;
    if (look) this.env.setup(look.tod as never, look.wx as never);
    else this.env.setup(s.timeOfDay, s.weather);
    this.env.boostAmbient(this.env.tod === 'day' ? 1.25 : 1.6);
    this.applyLook();
    this.player.mode = 'ground';
    const planned = bots ?? planArenaBots(kind, roster, true);
    this.arena.setup(roster, planned);
    this.combatants = [this.player, ...this.bots.bots];
    if (net) {
      net.onMsg = (m) => this.arena?.handle(m);
      net.onClose = (why) => {
        if (this.state === 'over') return;
        this.hud.pickupToast(why, '#ff6b6b');
        this.arena?.handle({ t: 'end' });
      };
    }
    this.begin();
    this.hud.announce(this.arena.rules.name, 3);
    const quit = document.getElementById('quit-btn');
    if (quit) quit.textContent = 'LEAVE MATCH';
  }

  /** Arena over: results screen with the scoreboard. */
  endArena() {
    const a = this.arena!;
    if (this.state === 'over') return;
    this.state = 'over';
    this.overAt = performance.now();
    if (document.pointerLockElement) document.exitPointerLock();
    this.touch?.show(false);
    this.hud.setInventory(false);
    const res = a.result();
    if (res > 0) this.sfx.victory();
    else this.sfx.defeat();
    const xp = this.cheats.used ? undefined : this.profile.finishMatch({
      won: res > 0, placement: a.placement(), kills: this.player.kills, headshotKills: this.stats.headshotKills, damage: this.stats.damage,
      shots: this.weapons.shotsFired, hits: this.stats.hits, headshots: this.stats.headshots, time: this.matchTime,
    });
    setTimeout(() => {
      this.hud.showArenaEnd(a, xp);
      if (xp && xp.after > xp.before) this.sfx.levelUp();
    }, 1400);
  }

  /** Someone else's gun going off (online): tracer, flash, sound and a sound ping. */
  remoteShot(b: Combatant, w: WeaponId, muzzle: Vector3, end: Vector3) {
    const cam = this.camera.position;
    this.fx.tracer(muzzle, end, 0xff8a5a, 0.035);
    const big = w === 'shotgun' || w === 'sniper' || w === 'revolver';
    this.fx.flash(muzzle, 0xffc860, big ? 0.32 : 0.2);
    this.fx.flash(muzzle, 0xffffff, 0.08, 0.035);
    const d = muzzle.distanceTo(cam);
    this.sfx.shot(w, d, muzzle);
    if (d < 90 && b.team !== this.player.team) this.hud.soundPing(muzzle, 'shot', b);
    if (end.distanceToSquared(cam) < 120 * 120) this.fx.burst(end, 0xffd890, 3, { speed: 6, size: 0.025, life: 0.16, gravity: 18, glow: true });
  }

  /** We were shot by someone on another machine. */
  onHurtByNet(head: boolean, from: Combatant | null = null) {
    this.sfx.hurt();
    if (from) this.hud.hurt(from.body.pos);
    this.music.duck(0.4);
    if (head) this.shake = Math.min(1, this.shake + 0.15);
  }

  /** Do we decide damage to this combatant (always, unless it's someone else's online)? */
  owns(c: Combatant) {
    if (this.obr) return this.obr.owns(c);
    return !this.arena || this.arena.owns(c);
  }

  /** The online session that sends our shots, throws and damage (null offline). */
  get netm() {
    return this.arena?.online ? this.arena : this.obr;
  }

  /** Is this your team, or a friend's online? */
  humanTeam(t: number) {
    return t === this.player.team || this.humanTeams.has(t);
  }

  /**
   * Online battle royale: same island, loot, plane and storm for everyone (the loot is the host's
   * layout, the plane and circles come from `seed`); each player flies themselves, the host flies the bots.
   */
  startOnlineBR(kind: ArenaKind, net: Net, roster: RosterEntry[], bots: BotEntry[], look: { tod: string; wx: string }, seed: number, loot: LootLayout | null) {
    const info = this.loadInfo('BATTLE ROYALE', `ONLINE · ${kind === 'brs' ? 'SQUADS' : 'SOLO'} · ${roster.length + bots.length} PLAYERS`);
    this.withLoading(info, () => this.startOnlineBRNow(kind, net, roster, bots, look, seed, loot), true);
  }

  private startOnlineBRNow(kind: ArenaKind, net: Net, roster: RosterEntry[], bots: BotEntry[], look: { tod: string; wx: string }, seed: number, loot: LootLayout | null) {
    const s = this.settings.data;
    this.tuning = DIFFICULTY[s.botDifficulty];
    if (loot) unpackLoot(this, loot);
    this.plane.route(mulberry32(seed + 1));
    this.zone.rnd = mulberry32(seed + 2);
    this.zone.start();
    this.zone.update(0);
    this.lastPhase = this.zone.phase;
    this.gulagUsed = true; // no Gulag online: it's a 1v1 against a bot
    this.redeployUsed = false;
    this.redeploying.clear();
    const o = (this.obr = new OnlineBR(this, kind, net));
    o.setup(roster, bots);
    this.combatants = [this.player, ...this.bots.bots];
    this.teamsAtStart = this.aliveTeams(-1).size;
    setViewCamo(this.profile.camoColor);
    this.weapons.view.refresh();
    this.applySkin();
    this.env.setup(look.tod as never, look.wx as never);
    this.applyLook();
    this.player.yaw = Math.atan2(-this.plane.dir.x, -this.plane.dir.z);
    this.plane.position(this.player.body.pos);
    net.onMsg = (m) => this.obr?.handle(m);
    net.onClose = (why) => this.obr?.lost(why);
    this.begin();
    this.hud.announce('GET READY TO DROP', 3);
    const quit = document.getElementById('quit-btn');
    if (quit) quit.textContent = 'LEAVE MATCH';
  }

  /** Online: lost the host (or they left). The match can't go on without them. */
  onlineLost(why: string) {
    if (this.state === 'over') return;
    this.hud.pickupToast(why, '#ff6b6b');
    if (!this.player.alive) return;
    this.endMatch(this.aliveTeams(this.player.team).size === 0, this.aliveTeams(this.player.team).size + 1, null);
  }

  /** A supply drop at (x, z); online the host decides where and tells everyone. */
  supplyDrop(x: number, z: number) {
    this.features.spawnSupplyDrop(x, z);
    this.hud.announce('SUPPLY DROP INBOUND', 3);
    this.sfx.supplyIncoming();
  }

  private begin() {
    this.deathCam.stop();
    this.sfx.unlock();
    this.input.lock();
    this.lockAskFrame = this.frameNo + 20;
    this.state = 'playing';
    this.last = performance.now();
    this.hud.showOverlay(null);
    this.hud.show(true);
    this.touch?.show(this.touchActive);
  }

  /** Tab: open the backpack with a free cursor (the match keeps running), Tab again to go back. */
  toggleInventory(open = !this.hud.invOpen, relock = true) {
    if (open === this.hud.invOpen) return;
    this.hud.setInventory(open);
    if (open) {
      this.player.ads = false;
      if (document.pointerLockElement) document.exitPointerLock();
    } else if (relock && this.state === 'playing' && !this.touchActive) this.input.lock();
  }

  /** Swaps which gun is on 1 and which is on 2; you keep holding the same gun. */
  private swapSlots() {
    const p = this.player;
    p.slots = [p.slots[1], p.slots[0]];
    p.active = 1 - p.active;
    this.sfx.swap();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    if (!this.netm) this.sfx.setPaused(true);
    this.sfx.setEngine(null);
    this.sfx.setAir(null);
    this.music.setMuffled(true);
    this.sfx.setZip(null);
    this.hud.showOverlay('pause');
    if (document.pointerLockElement) document.exitPointerLock();
  }

  resume() {
    this.sfx.unlock();
    this.sfx.setPaused(false);
    this.music.setMuffled(false);
    this.input.lock();
    this.lockAskFrame = this.frameNo + 20;
    this.state = 'playing';
    this.hud.showOverlay(null);
    this.last = performance.now();
  }

  start() {
    // Browsers only allow sound after the first click or key press.
    const unlock = () => this.sfx.unlock();
    addEventListener('pointerdown', unlock, { once: true });
    addEventListener('keydown', unlock, { once: true });
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      this.frame(now);
    };
    requestAnimationFrame(loop);
  }

  frame(now: number) {
    if (this.state === 'loading') return;
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    this.frameNo++;
    this.input.pollGamepad(dt);
    this.padCursor.update(dt);
    this.updateMusic(dt);
    // Online the world never stops: not in the menu, and not for a host who's out of the match
    // (their machine still runs the bots for everyone else).
    const hostOut = !!this.obr?.isHost && (this.state === 'over' || this.state === 'killcam') && this.obr.net.guests > 0;
    const liveMenu = (this.state === 'paused' && !!this.netm) || hostOut;
    if (liveMenu) {
      this.input.consumeMouse();
      this.input.releaseAll();
      this.acc += dt;
      let steps = 0;
      while (this.acc >= STEP && steps < 5) {
        this.step(STEP);
        this.acc -= STEP;
        steps++;
      }
      if (steps >= 5) this.acc = 0;
    } else if (this.state === 'playing') {
      const m = this.input.consumeMouse();
      const s = this.settings.data;
      const w = this.player.weapon;
      const scoped = w && (w.def.id === 'sniper' || w.def.id === 'dmr' || w.att.scope);
      const adsMul = lerp(1, s.adsSensitivity * (scoped ? 0.6 : 1), this.weapons.adsAmount);
      if (this.weapons.wheel.open) {
        this.weapons.wheelLook(m.x, m.y);
        m.x = m.y = 0;
      }
      this.player.look(m.x, s.invertY ? -m.y : m.y, this.sensitivity * adsMul);
      this.mouseIdle = m.x !== 0 || m.y !== 0 ? 0 : this.mouseIdle + dt;
      this.weapons.view.addLook(m.x, s.invertY ? -m.y : m.y);
      this.acc += dt;
      let steps = 0;
      while (this.acc >= STEP && steps < 5) {
        this.step(STEP);
        this.acc -= STEP;
        steps++;
      }
      if (steps >= 5) this.acc = 0;
      if (steps > 0) this.input.endStep();
    } else if (this.state === 'title') {
      // Slow cinematic orbit behind the menu
      this.player.yaw += dt * 0.05;
      this.plane.update(0);
    } else if (this.state === 'killcam') {
      this.input.consumeMouse();
      if (this.input.isDown('Space')) this.killcam.stop();
    }
    // Paused offline: the whole world freezes (hands, water, clouds, particles, vehicles); only the music plays on.
    const frozen = this.state === 'paused' && !liveMenu;
    const rdt = dt;
    {
    const dt = frozen ? 0 : rdt;
    this.weapons.animate(dt, this.player);
    const cam = this.camera.position;
    for (const v of this.vehicles) {
      // Parked cars far away don't need their wheels and tilt updated.
      const moving = v.body.vel.lengthSq() > 0.01 || v.hasDriver;
      if (moving || v.body.pos.distanceToSquared(cam) < 200 * 200) v.syncMesh(dt, (x, z) => this.map.groundAt(x, z));
    }
    if (this.state === 'killcam') this.killcam.update(dt, this.camera);
    else this.syncCamera(dt);
    {
      const p = this.player;
      const fp = this.state === 'playing' && !this.lobby?.active && p.alive && !this.driving && !this.deathCam.active
        && (p.mode === 'ground' || p.mode === 'zipline' || p.mode === 'glide') && !p.swimming;
      this.selfBody.update(dt, p, this.profile.data.skin, fp);
    }
    this.cheats.draw();
    this.fx.update(dt);
    this.env.update(dt, cam);
    if (this.env.flashlightOn) this.env.flashlightRange(this.world.raycast(cam, this.camera.getWorldDirection(tmpN), 16));
    this.features.update(dt, cam);
    this.ambient.day = !this.env.isNight;
    this.ambient.war = false;
    this.ambient.update(dt, cam, !this.arena);
    if (this.fires) {
      this.fires.visible = !this.arena;
      if (!this.arena) this.fires.update(dt, this.camera, this.renderer.getDrawingBufferSize(fireBuf).y, this.env.isNight);
    }
    if (this.tumbleweeds) {
      this.tumbleweeds.visible = this.state !== 'title' && !this.arena;
      this.tumbleweeds.update(dt, cam);
    }
    const pm = this.player.mode;
    this.map.cull(cam, this.fog.far, this.detailMul, this.state !== 'title' && !this.arena && (pm === 'plane' || pm === 'freefall' || pm === 'glide'));
    if (this.state !== 'title') this.hud.update(dt);
    this.updateDynRes(dt);
    this.renderer.toneMappingExposure = this.env.exposure * this.settings.data.brightness;
    // Plastic reflections follow the daylight (dim at night).
    if (TOY) this.scene.environmentIntensity = this.weapons.view.vmScene.environmentIntensity = this.hemi.intensity * (this.env.tod === 'night' ? 0.012 : 0.035);
    const needClick = this.state === 'playing' && !this.input.locked && !this.touchActive && !this.hud.invOpen && this.frameNo > this.lockAskFrame;
    if (needClick !== this.lockHintShown) {
      this.lockHintShown = needClick;
      document.getElementById('lock-hint')?.classList.toggle('show', needClick);
    }
    const hideCursor = (this.state === 'playing' || this.state === 'killcam') && !this.hud.invOpen && (this.input.locked || this.touchActive);
    if (hideCursor !== this.cursorHidden) {
      this.cursorHidden = hideCursor;
      document.body.classList.toggle('no-cursor', hideCursor);
    }
    if (this.shadowEvery > 1 && this.frameNo % this.shadowEvery === 0) this.renderer.shadowMap.needsUpdate = true;
    if (this.lobby) this.lobby.group.visible = this.lobby.active;
    // No storm in the menus (it tints the whole backdrop purple).
    this.zone.shown = !this.lobby?.active;
    if (INK) {
      if (this.frameNo % 30 === 1) {
        stylize(this.scene);
        stylize(this.weapons.view.vmScene);
        if (TOON) outlineHulls(this.weapons.view.vmScene);
      }
      this.inkSky ??= new InkSky(this.scene);
      this.inkSky.update(this.camera, this.scene.background, this.fog.color, tmpInkSun.copy(this.sun.position).sub(this.sun.target.position).normalize(), this.sun.color);
    }
    // In the menus, now and then take a shot of a town for the next loading screen.
    if (this.lobby?.active && !this.loadScreen.busy && !this.arena && this.frameNo > 90 && (this.shots?.map !== this.map || (this.shots.list.length < this.shots.order.length && performance.now() - this.shots.at > 1500))) {
      this.captureShot();
      if (this.shots) this.shots.at = performance.now();
      this.map.cull(cam, this.fog.far, this.detailMul, false);
    }
    if (this.postFx && this.settings.data.postFx) {
      this.postFx.hurt = this.player.alive ? clamp((35 - this.player.health) / 35, 0, 1) * 0.8 : 0;
      this.postFx.focus = this.lobby?.active ? this.camera.position.distanceTo(this.lobby.focusPoint) : null;
      this.postFx.render(dt);
    } else this.renderer.render(this.scene, this.camera);
    if (this.state !== 'killcam' && !this.lobby?.active) this.weapons.view.render(this.renderer, this.camera.aspect);
    }
  }

  private step(dt: number) {
    const p = this.player;
    this.matchTime += dt;
    this.pathBudget = 6;
    this.train?.update(this.matchTime, dt, this.combatants, (c) => this.trainHit(c), this.trainCargo());
    this.plane.update(dt);
    this.gridTimer -= dt;
    if (this.gridTimer <= 0) {
      this.gridTimer = 0.1;
      this.grid.rebuild(this.combatants, (c) => c.alive && this.inWorld(c));
    }
    this.killcam.record(dt, this.matchTime);

    if (p.mode === 'plane') {
      this.plane.position(p.body.pos);
      const over = this.plane.overIsland();
      if ((over && (this.input.pressed('Space') || this.input.pressed('KeyE'))) || this.plane.shouldJump(2)) {
        p.jumpFromPlane(this.plane.velocity);
        this.sfx.jumpOut();
        p.body.pos.y -= 6;
        this.hud.announce('');
      }
    }

    // Vehicles / ziplines with E
    if (this.input.pressed('KeyE') && p.alive) {
      if (this.driving) this.exitVehicle();
      else if (p.mode === 'ground') {
        const v = this.nearestVehicle(p.body.pos, 3.8);
        if (v) this.enterVehicle(v);
        else p.tryZip();
      }
    }
    if (this.input.pressed('KeyL')) {
      this.env.toggleFlashlight();
      this.sfx.click();
    }
    if (this.driving) {
      const v = this.driving;
      v.drive(dt, this.input, this.world);
      p.body.pos.copy(v.body.pos).y += 0.35;
      p.body.vel.copy(v.body.vel);
      p.body.onGround = v.body.onGround;
      p.altitude = 0;
    } else if (!this.cheats.move(dt)) {
      p.update(dt, this.input, this.world);
    }
    // Health from a kill trickles back in rather than all at once.
    if (p.killHeal > 0 && p.alive) {
      const h = Math.min(p.killHeal, KILL_HEAL_RATE * dt);
      p.killHeal -= h;
      p.health = Math.min(CONFIG.player.maxHealth, p.health + h);
    }
    if (p.fallDamage > 0) {
      const res = applyDamage(p, p.fallDamage, true);
      p.fallDamage = 0;
      this.hud.hurt(null);
      this.sfx.hurt();
      if (res.killed && p.alive) this.onKill(null, p, null, 'Fall damage');
    }
    for (const c of p.cues.splice(0)) {
      if (c === 'mantle') {
        this.sfx.mantle();
        // Vaulting through a window takes the glass with you.
        const m = p.mantle;
        if (m) this.glass.smash(Math.min(m.from.x, m.to.x) - 0.3, m.mid.y, Math.min(m.from.z, m.to.z) - 0.3, Math.max(m.from.x, m.to.x) + 0.3, m.mid.y + 1.2, Math.max(m.from.z, m.to.z) + 0.3);
      } else if (c === 'zip') this.sfx.zipAttach();
      else if (c === 'splash') this.sfx.splash(true);
      else this.sfx.swimStroke();
    }
    this.sfx.setZip(p.mode === 'zipline' ? 17 : null);
    for (const v of this.vehicles) {
      if (v === this.driving) continue;
      if (v.netHold > 0) {
        // Driven by someone on another machine: follow their updates.
        v.netHold -= dt;
        v.body.pos.lerp(v.netPos.addScaledVector(v.netVel, dt), 1 - Math.exp(-12 * dt));
        v.body.vel.copy(v.netVel);
        let dy = v.netYaw - v.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        v.yaw += dy * (1 - Math.exp(-14 * dt));
        if (v.netHold <= 0) {
          v.hasDriver = false;
          v.driver = null;
        }
        continue;
      }
      if (v.driver && !v.driver.isPlayer) {
        v.drive(dt, (v.driver as Bot).keys, this.world);
        continue;
      }
      // Idle cars at rest cost nothing.
      const still = v.body.onGround && Math.abs(v.speed) < 0.05 && v.body.vel.lengthSq() < 0.01;
      if (!still) v.drive(dt, null, this.world);
    }
    this.vehicleInteractions(dt);

    // Launch pads fling players, bots and vehicles into the air.
    if (p.mode === 'ground' && !this.driving) {
      const pad = this.features.padAt(p.body.pos);
      if (pad) {
        p.launch();
        this.features.firePad(pad);
        this.sfx.launch();
      }
    }
    for (const b of this.bots.bots) {
      if (!b.alive || b.mode !== 'ground') continue;
      const pad = this.features.padAt(b.body.pos);
      if (pad) {
        b.body.vel.y = 22;
        b.body.onGround = false;
        this.features.firePad(pad);
      }
    }
    for (const v of this.vehicles) {
      if (!v.alive) continue;
      const pad = this.features.padAt(v.body.pos);
      if (pad) {
        v.body.vel.y = 20;
        v.body.onGround = false;
        this.features.firePad(pad);
        if (v === this.driving) this.sfx.launch();
      }
    }

    if (p.justLanded) {
      this.sfx.land();
      this.weapons.view.land(10);
    }
    if (p.sliding && !this.wasSliding) this.sfx.slide();
    this.wasSliding = p.sliding;
    if (p.mode !== this.lastMode) {
      if (p.mode === 'glide') this.sfx.glider();
      this.lastMode = p.mode;
    }
    const air = p.mode === 'plane' || p.mode === 'freefall' || p.mode === 'glide' ? p.mode : null;
    this.sfx.setAir(air, p.body.vel.length());
    // Skydive contrail from both hands (Locker > Trail).
    const trail = trailColor(TRAILS[this.profile.data.trail] ?? TRAILS[0], this.matchTime);
    if (trail !== null && p.mode === 'freefall') {
      for (const x of [-0.55, 0.55]) {
        trailTmp.set(x, -0.45, -1.1).applyMatrix4(this.camera.matrixWorld);
        this.fx.burst(trailTmp, trail, 1, { speed: 0.25, size: 0.11, life: 0.8, gravity: 0, up: 0, glow: true });
      }
    }
    if (this.input.pressed('KeyM')) this.hud.toggleBigMap();
    if (this.arena) this.hud.scoreboardHeld = this.input.isDown('Tab');
    else if (this.input.pressed('Tab') && p.alive) this.toggleInventory();
    if (this.hud.invOpen && (!p.alive || this.state !== 'playing')) this.toggleInventory(false, false);

    // Windows break when you run through them (doors you open yourself with F).
    if (p.mode === 'ground' || p.mode === 'zipline') this.smashGlassAround(p);
    for (const b of this.bots.bots) if (b.alive && b.mode === 'ground' && b.body.vel.lengthSq() > 4) this.smashGlassAround(b);
    this.doors.update(dt, this.sfx, (box) => this.occupied(box));

    this.syncCamera(0);
    if (!this.glider.parent) this.scene.add(this.glider);
    this.glider.visible = p.mode === 'glide';
    if (this.glider.visible) {
      // Unfolds with a snap when it opens, banks into turns and pitches forward as you push on.
      if (this.gliderT === 0) this.gliderYaw = p.yaw;
      this.gliderT = Math.min(1, this.gliderT + dt / 0.5);
      let turn = p.yaw - this.gliderYaw;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;
      this.gliderYaw = p.yaw;
      this.gliderBank = damp(this.gliderBank, clamp((turn / Math.max(dt, 1e-3)) * 0.18, -0.45, 0.45), 4, dt);
      const k = this.gliderT, open = k < 1 ? 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2) : 1;
      const g = this.glider;
      g.rotation.order = 'YXZ';
      g.rotation.set(-0.12 * Math.min(1, Math.hypot(p.body.vel.x, p.body.vel.z) / 18) + Math.sin(this.matchTime * 1.3) * 0.02, p.yaw, this.gliderBank);
      g.scale.set(Math.max(0.05, open), Math.max(0.05, 0.3 + 0.7 * open), Math.max(0.05, 0.6 + 0.4 * open));
      g.position.set(p.body.pos.x, p.body.pos.y + GLIDER_HEIGHT * (0.55 + 0.45 * Math.min(1, k * 1.4)), p.body.pos.z);
    } else this.gliderT = this.gliderBank = 0;
    this.cheats.tick();
    this.weapons.update(dt, this.input, p);
    this.handlePickups();
    this.sfx.listener = { pos: this.camera.position, yaw: p.yaw };

    this.bots.update(dt, this);
    this.projectiles.update(dt);
    let veil = 0;
    const cp = this.camera.position;
    for (const s of this.projectiles.smokes) {
      const d = s.pos.distanceTo(cp);
      veil = Math.max(veil, clamp((s.r * 1.15 - d) / (s.r * 0.5), 0, 1) * clamp(s.life / 2, 0, 1) * 0.92);
    }
    this.hud.smokeVeil(veil);
    if (!this.plane.active && !this.planeGone && this.plane.progress >= 1) {
      this.planeGone = true;
      this.plane.dispose(this.scene);
    }

    // Explosions queued by barrels (they can chain)
    const exps = this.features.pendingExplosions.splice(0);
    for (const e of exps) this.explode(e.pos, e.radius, e.damage, this.barrelBy.get(e.src) ?? null, 'Explosion');

    if (this.practiceMode) this.updatePractice(dt);
    else if (this.arena) this.arena.update(dt);
    else this.updateZone(dt);
    this.obr?.update(dt);
    if (this.gulagFight) this.updateGulag(dt);

    // Damage events for the player (indicators)
    for (const e of p.damageEvents) this.hud.hurt(e.from, e.amount);
    p.damageEvents.length = 0;

    this.loot.update(dt, p.body.pos);
    this.ambientAudio(dt);
  }

  /** Storm damage lands once a second. */
  private zoneTick = 0;

  private updateZone(dt: number) {
    this.zone.update(dt);
    this.zone.updateDust(this.camera.position, dt);
    if (this.zone.state !== this.lastZoneState) {
      if (this.zone.state === 'shrinking') {
        this.hud.announce('THE ZONE IS CLOSING');
        this.sfx.zoneWarning();
      }
      this.lastZoneState = this.zone.state;
    }
    if (this.zone.phase !== this.lastPhase) {
      this.lastPhase = this.zone.phase;
      if (this.zone.phase <= 4 && this.zone.state !== 'closed' && (!this.obr || this.obr.isHost)) {
        const s = this.zone.randomSafePoint(0.6);
        s.x = Math.round(s.x * 100) / 100;
        s.z = Math.round(s.z * 100) / 100;
        this.supplyDrop(s.x, s.z);
        this.obr?.sendSupply(s.x, s.z);
      }
      if (this.zone.phase === 3 && !this.gulagUsed) this.hud.pickupToast('The Gulag is now closed', '#ff6b6b');
    }
    this.zoneTick += dt;
    if (this.zoneTick < 1) return;
    this.zoneTick -= 1;
    for (const c of this.combatants) {
      if (!c.alive || !this.inWorld(c) || this.inArena(c) || (c as Bot).boss) continue;
      if (this.zone.isOutside(c.body.pos.x, c.body.pos.z)) {
        if (!this.owns(c) || (c.isPlayer && cheatOn('god'))) continue;
        const res = applyDamage(c, this.zone.dps, true);
        if (c.isPlayer) this.hud.hurt(null, this.zone.dps);
        if (res.killed) this.onKill(null, c, null, 'The Storm');
      }
    }
  }

  /** Something (a person or a vehicle) is standing where a door wants to swing. */
  private occupied(b: Box) {
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    for (const c of this.grid.query(cx, cz, 3, this.occupiedScratch)) {
      const p = c.body.pos, r = c.body.radius;
      if (p.x + r > b.minX && p.x - r < b.maxX && p.z + r > b.minZ && p.z - r < b.maxZ && p.y < b.maxY && p.y + c.body.height > b.minY) return true;
    }
    return false;
  }

  private smashGlassAround(c: Combatant) {
    const p = c.body.pos, r = c.body.radius + 0.15;
    const hs = Math.hypot(c.body.vel.x, c.body.vel.z);
    if (hs < 2 && c.body.vel.y > -4) return;
    this.glass.smash(p.x - r, p.y + 0.2, p.z - r, p.x + r, p.y + c.body.height, p.z + r);
  }

  // ---------- practice range ----------

  private setupPractice() {
    const p = this.player, at = this.map.rangeSpot;
    this.tuning = DIFFICULTY.normal;
    setViewCamo(this.profile.camoColor);
    this.weapons.view.refresh();
    this.plane.active = false;
    this.planeGone = true;
    this.plane.dispose(this.scene);
    this.zone.radius = 5000;
    this.zone.state = 'closed';
    this.zone.update(0);
    p.mode = 'ground';
    p.body.pos.set(at.x, this.map.groundAt(at.x, at.z) + 0.5, at.z);
    p.yaw = 0;
    p.pitch = 0;
    p.armor = 100;
    p.plates = 5;
    p.medkits = 4;
    p.slots = [makeWeapon('ar', RARITIES[2]), makeWeapon('shotgun', RARITIES[1])];
    for (const k of Object.keys(p.ammo) as (keyof typeof p.ammo)[]) p.ammo[k] = AMMO_INFO[k].max;
    p.throwables = { frag: 3, smoke: 3, flash: 3, grapple: 0 };
    // A weapon rack of everything, in every rarity.
    const rack: LootKind[] = WEAPON_IDS.map((id) => ({ type: 'weapon', weapon: makeWeapon(id, RARITIES[Math.min(3, 1 + (WEAPON_IDS.indexOf(id) % 3))]) }));
    rack.forEach((k, i) => this.loot.spawn(k, new Vector3(at.x - 9 + i * 2, this.map.groundAt(at.x - 9 + i * 2, at.z + 4) + 0.1, at.z + 4)));
    // Dummies at 10–80 m, some strafing.
    let id = 1;
    for (const [dist, strafe] of [[10, 0], [18, 0], [25, 3], [35, 0], [45, 4], [60, 0], [80, 3], [30, 6]] as [number, number][]) {
      const x = at.x + (id % 2 ? -1 : 1) * (id * 1.7), z = at.z - dist;
      const bot = new Bot(id++, `Dummy ${dist}m`, this, 0.08, 0xffd24a);
      bot.team = 100 + id;
      bot.dummy = true;
      bot.dummyStrafe = strafe;
      bot.revive(this, new Vector3(x, this.map.groundAt(x, z) + 0.2, z));
      bot.armor = id % 3 === 0 ? 100 : 0;
      bot.yaw = Math.PI;
      this.bots.bots.push(bot);
    }
    this.combatants = [p, ...this.bots.bots];
    this.env.setup('day', 'clear');
  }

  private updatePractice(dt: number) {
    for (let i = this.dummyRespawn.length - 1; i >= 0; i--) {
      const r = this.dummyRespawn[i];
      r.t -= dt;
      if (r.t <= 0) {
        r.bot.revive(this, r.at);
        r.bot.armor = r.bot.id % 3 === 0 ? 100 : 0;
        this.dummyRespawn.splice(i, 1);
      }
    }
    // Endless supplies on the range.
    const p = this.player;
    for (const k of Object.keys(p.ammo) as (keyof typeof p.ammo)[]) p.ammo[k] = Math.max(p.ammo[k], AMMO_INFO[k].max / 2);
    for (const t of ['frag', 'smoke', 'flash'] as const) p.throwables[t] = Math.max(p.throwables[t], 1);
  }

  // ---------- gulag ----------

  /** In the arena (and so only able to fight the other arena fighter). */
  inArena(c: Combatant) {
    return c.isPlayer ? this.gulagFight : (c as Bot).inGulag;
  }

  /** Can `a` damage / target `b`? Keeps the gulag fight separate from the match. */
  canTarget(a: Combatant, b: Combatant) {
    if (this.arena?.protected(b)) return false;
    if (b.isPlayer && cheatOn('ghost')) return false;
    return this.inArena(a) === this.inArena(b);
  }

  private tryGulag(): boolean {
    if (this.practiceMode || this.gulagUsed || this.zone.phase > 2) return false;
    // Fight someone who's already dead; if nobody is yet, the Warden steps in.
    let foe = this.bots.bots.find((b) => !b.alive && !b.followPlayer && !b.dummy && !b.boss);
    if (!foe) {
      foe = new Bot(900 + this.bots.bots.length, 'The Warden', this, 0.02, 0xff3b30);
      foe.team = 999;
      foe.alive = false;
      this.bots.bots.push(foe);
      this.combatants.push(foe);
    }
    this.gulagUsed = true;
    this.gulagFight = true;
    this.gulagTimer = GULAG_TIME;
    this.gulagPrep = GULAG_PREP;
    // Two arenas; you get one of them at random.
    const arena = Math.floor(Math.random() * this.map.gulags.length);
    this.map.gulag = this.map.gulags[arena];
    this.gulagName = this.map.gulagNames[arena];
    const p = this.player, g = this.map.gulag;
    p.frozen = true;
    this.hud.fadeFromBlack(0.35, 0.7);
    if (this.driving) this.exitVehicle();
    p.alive = true;
    p.health = 100;
    p.armor = 0;
    p.killHeal = 0;
    p.sprintLock = 0;
    p.mode = 'ground';
    p.mantle = null;
    p.zip = null;
    p.body.vel.set(0, 0, 0);
    p.body.pos.set(g.x - 20, 0.3, g.z);
    p.yaw = -Math.PI / 2;
    p.pitch = 0;
    const id = GULAG_LOADOUTS[Math.floor(Math.random() * GULAG_LOADOUTS.length)];
    p.slots = [makeWeapon(id, RARITIES[1]), null];
    p.active = 0;
    p.unarmed = false;
    p.ammo[makeWeapon(id).def.ammo] += 60;
    this.weapons.reset();
    foe.inGulag = true;
    foe.revive(this, new Vector3(g.x + 20, 0.3, g.z));
    foe.setWeapon(makeWeapon(id, RARITIES[1]));
    foe.yaw = Math.PI / 2;
    foe.armor = 0;
    this.gulagFoe = foe;
    this.hud.announce('', 0);
    return true;
  }

  private updateGulag(dt: number) {
    const foe = this.gulagFoe, p = this.player;
    if (this.gulagPrep > 0) {
      // Both fighters wait at their gates; you can look around and swap weapons.
      const g = this.map.gulag, before = Math.ceil(this.gulagPrep);
      this.gulagPrep -= dt;
      p.body.pos.x = g.x - 20;
      p.body.pos.z = g.z;
      p.body.vel.x = p.body.vel.z = 0;
      if (foe) {
        foe.body.pos.x = g.x + 20;
        foe.body.pos.z = g.z;
        foe.body.vel.x = foe.body.vel.z = 0;
      }
      const left = Math.ceil(this.gulagPrep);
      // Once the screen has faded in.
      if (this.gulagPrep <= GULAG_PREP - 1.2 && this.gulagPrep + dt > GULAG_PREP - 1.2) {
        this.hud.announce(`GULAG: ${this.gulagName} — WIN TO REDEPLOY`, 3);
        this.sfx.gulagBell();
      }
      if (this.gulagPrep <= 0) {
        p.frozen = false;
        this.hud.announce('FIGHT!', 1.5);
        this.sfx.countdown(true);
      } else if (left !== before && left <= 3) {
        this.hud.announce(String(left), 1);
        this.sfx.countdown(false);
      }
      return;
    }
    this.gulagTimer -= dt;
    if (this.gulagTimer <= 0 && foe) {
      // Overtime: whoever is healthier wins.
      if (this.player.health >= foe.health) this.onKill(this.player, foe, null, 'Overtime');
      else this.onKill(foe, this.player, null, 'Overtime');
    }
  }

  private winGulag() {
    const foe = this.gulagFoe;
    this.player.frozen = false;
    if (foe) foe.inGulag = false;
    this.gulagFoe = null;
    this.hud.announce('YOU WON THE GULAG — REDEPLOYING', 3);
    this.sfx.gulagBell();
    setTimeout(() => {
      if (!this.player.alive) return;
      this.gulagFight = false;
      const p = this.player, s = this.zone.randomSafePoint(0.5);
      // Back in fresh: full health and loaded guns.
      p.health = 100;
      for (const w of p.slots) if (w) w.mag = magSize(w);
      this.weapons.reloadLeft = 0;
      p.body.pos.set(s.x, 320, s.z);
      p.body.vel.set(0, 0, 0);
      p.jumpFromPlane(p.body.vel);
      p.slots[1] = null;
    }, 2000);
  }

  // ---------- vehicles ----------

  private nearestVehicle(pos: Vector3, maxDist: number) {
    let best: Vehicle | null = null, bd = maxDist;
    for (const v of this.vehicles) {
      if (!v.alive || v.hasDriver) continue;
      const d = Math.hypot(v.body.pos.x - pos.x, v.body.pos.z - pos.z);
      if (d < bd && Math.abs(v.body.pos.y - pos.y) < 2.5) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  private enterVehicle(v: Vehicle) {
    const p = this.player;
    this.driving = v;
    v.hasDriver = true;
    v.driver = p;
    p.mode = 'vehicle';
    p.sliding = p.crouching = p.sprinting = p.ads = false;
    p.body.height = 1.2;
    p.yaw = v.yaw;
    p.pitch = -0.25;
    this.weapons.reset();
    this.sfx.carDoor();
  }

  private exitVehicle() {
    const p = this.player, v = this.driving!;
    this.driving = null;
    v.hasDriver = false;
    v.driver = null;
    p.mode = 'ground';
    p.body.height = CONFIG.player.standHeight;
    const r = v.right(new Vector3()), off = v.spec.width / 2 + 0.9;
    const tryAt = (sx: number, dy: number) => {
      const x = v.body.pos.x + r.x * off * sx, z = v.body.pos.z + r.z * off * sx;
      const y = Math.max(v.body.pos.y, this.map.groundAt(x, z)) + dy;
      if (this.world.anyOverlap(x - 0.4, y + 0.05, z - 0.4, x + 0.4, y + 1.8, z + 0.4)) return false;
      p.body.pos.set(x, y, z);
      return true;
    };
    if (!tryAt(-1, 0) && !tryAt(1, 0)) p.body.pos.set(v.body.pos.x, v.body.pos.y + 2.2, v.body.pos.z);
    p.body.vel.copy(v.body.vel).multiplyScalar(0.4);
    p.pitch = 0;
    this.sfx.carDoor();
    this.sfx.setEngine(null);
  }

  /** Crashes, running people over, smashing cover, and keeping bodies from overlapping cars. */
  private vehicleInteractions(dt: number) {
    for (const [c, t] of this.runOverCd) {
      if (t - dt <= 0) this.runOverCd.delete(c);
      else this.runOverCd.set(c, t - dt);
    }
    for (const v of this.vehicles) {
      if (v.lastImpact > 5 && v.canCrashSound() && v.body.pos.distanceTo(this.camera.position) < 60) {
        this.sfx.crash(v.lastImpact);
        if (v === this.driving) this.shake = Math.min(1, this.shake + v.lastImpact * 0.04);
      }
      if (!v.alive && !v.exploded) {
        v.exploded = true;
        if (v === this.driving) this.exitVehicle();
        else if (v.driver instanceof Bot) v.driver.exitVehicle(this);
        this.explode(v.body.pos.clone().setY(v.body.pos.y + 1), 8, 90, this.barrelBy.get(v) ?? null, 'Explosion');
      }
      const hs = Math.hypot(v.body.vel.x, v.body.vel.z);
      const vr = v.body.radius, bp = v.body.pos;
      // Plough through crates, fences and windows.
      if (hs > 5) {
        for (const b of [...this.world.queryAABB(bp.x - vr - 0.3, bp.y + 0.2, bp.z - vr - 0.3, bp.x + vr + 0.3, bp.y + 1.6, bp.z + vr + 0.3)]) {
          if (this.props.byBox.has(b)) {
            this.props.damage(b, Infinity);
            v.speed *= 0.93;
          }
        }
        this.glass.smash(bp.x - vr, bp.y + 0.3, bp.z - vr, bp.x + vr, bp.y + 1.8, bp.z + vr);
      }
      if (hs < 0.5 && !v.hasDriver) continue;
      const attacker = v.driver;
      for (const c of this.grid.query(bp.x, bp.z, vr + 1.5, this.occupiedScratch)) {
        if (!c.alive || (c.isPlayer && this.driving) || c === attacker || !this.owns(c)) continue;
        const dx = c.body.pos.x - bp.x, dz = c.body.pos.z - bp.z;
        const d = Math.hypot(dx, dz), minD = vr + c.body.radius;
        if (d >= minD || c.body.pos.y > bp.y + 1.7 || c.body.pos.y + c.body.height < bp.y) continue;
        const nx = d > 0.01 ? dx / d : 1, nz = d > 0.01 ? dz / d : 0;
        const approach = v.body.vel.x * nx + v.body.vel.z * nz;
        const friendly = !!attacker && attacker.team === c.team;
        if (hs > 7 && approach > 4 && !this.runOverCd.has(c) && v.alive && !friendly) {
          // Hit by a car: it hurts, but mostly it sends you flying.
          const dmg = Math.min(40, 6 + hs * 1.1);
          const res = applyDamage(c, dmg);
          c.onDamaged(attacker, dmg);
          this.runOverCd.set(c, 1.2);
          const fx = v.body.vel.x / (hs || 1), fz = v.body.vel.z / (hs || 1);
          c.body.vel.set((nx * 0.5 + fx) * hs * 0.75, 9 + hs * 0.45, (nz * 0.5 + fz) * hs * 0.75);
          c.body.pos.y += 0.15;
          c.body.onGround = false;
          if (c === this.player) this.player.flung = true;
          else if (c instanceof Bot) c.knock = 1.5;
          v.speed *= 0.85;
          this.sfx.thud(c.body.pos);
          if (attacker?.isPlayer) {
            this.stats.damage += dmg;
            this.hud.hit(res.killed, false);
            this.hud.damageNumber(c.body.pos.clone().setY(c.body.pos.y + 1.5), dmg, res.toArmor > 0 ? 'armor' : 'health', c);
          }
          if (res.killed) this.onKill(attacker, c, null, 'Roadkill');
        } else {
          // Nudge them out of the car's footprint.
          const push = minD - d;
          c.body.pos.x += nx * push;
          c.body.pos.z += nz * push;
        }
      }
    }
    // Vehicles bump into each other.
    for (let i = 0; i < this.vehicles.length; i++) {
      for (let j = i + 1; j < this.vehicles.length; j++) {
        const a = this.vehicles[i], b = this.vehicles[j];
        const dx = b.body.pos.x - a.body.pos.x, dz = b.body.pos.z - a.body.pos.z;
        if (Math.abs(dx) > 8 || Math.abs(dz) > 8) continue;
        const d = Math.hypot(dx, dz), minD = a.body.radius + b.body.radius;
        if (d >= minD || d < 0.001 || Math.abs(a.body.pos.y - b.body.pos.y) > 1.6) continue;
        const nx = dx / d, nz = dz / d, push = (minD - d) / 2;
        a.body.pos.x -= nx * push;
        a.body.pos.z -= nz * push;
        b.body.pos.x += nx * push;
        b.body.pos.z += nz * push;
        const rel = (a.body.vel.x - b.body.vel.x) * nx + (a.body.vel.z - b.body.vel.z) * nz;
        if (rel > 0) {
          const imp = rel * 0.6;
          a.body.vel.x -= nx * imp;
          a.body.vel.z -= nz * imp;
          b.body.vel.x += nx * imp;
          b.body.vel.z += nz * imp;
          a.speed *= 0.7;
          b.speed = Math.max(b.speed, 2);
          b.body.onGround = b.body.onGround && rel < 20;
          if (rel > 6 && a.canCrashSound()) this.sfx.crash(rel);
          if (rel > 12) {
            a.damage(rel * 2);
            b.damage(rel * 2);
          }
        }
      }
    }
  }

  // ---------- explosions & grenades ----------

  explode(pos: Vector3, radius: number, damage: number, by: Combatant | null, how: string) {
    this.features.explosionFx(pos, radius);
    this.sfx.explosion(pos);
    const camD = pos.distanceTo(this.camera.position);
    if (camD < 45) this.shake = Math.min(1.2, this.shake + (1 - camD / 45) * 1.2);
    for (const c of this.combatants) {
      if (!c.alive || !this.inWorld(c) || !this.owns(c) || this.arena?.protected(c)) continue;
      if (by && c !== by && (c.team === by.team || !this.canTarget(by, c))) continue;
      const d = tmpEnd.set(c.body.pos.x, c.body.pos.y + 1, c.body.pos.z).distanceTo(pos);
      if (d > radius) continue;
      // Solid walls between you and the blast soak most of it.
      const dir = tmpDir.subVectors(tmpEnd, pos).divideScalar(Math.max(d, 0.01));
      const cover = d > 1 && this.world.raycast(pos, dir, d) < d - 0.3 ? 0.25 : 1;
      const dmg = damage * (1 - d / radius) * cover * (c.isPlayer && this.driving ? 0.5 : 1) * (by instanceof Bot && by.boss ? by.boss.def.dmgMul : 1);
      if (dmg < 1) continue;
      const res = applyDamage(c, dmg);
      c.onDamaged(by, dmg);
      if (by?.isPlayer && !c.isPlayer) {
        this.stats.damage += dmg;
        this.hud.hit(res.killed, false);
      }
      if (res.killed) this.onKill(by, c, null, how);
    }
    for (const v of this.vehicles) {
      const d = v.body.pos.distanceTo(pos);
      if (d > radius * 1.3 || d < 0.01) continue;
      const k = 1 - d / (radius * 1.3);
      v.damage(damage * 1.6 * k);
      if (!v.alive && by) this.barrelBy.set(v, by);
      v.body.vel.x += ((v.body.pos.x - pos.x) / d) * 10 * k;
      v.body.vel.z += ((v.body.pos.z - pos.z) / d) * 10 * k;
      v.body.vel.y += 8 * k;
      v.body.onGround = false;
    }
    this.props.hitSphere(pos, radius * 0.8, damage * 2);
    const g = radius * 0.7;
    this.glass.smash(pos.x - g, pos.y - g, pos.z - g, pos.x + g, pos.y + g, pos.z + g);
    // Chain reactions keep the credit with whoever started them.
    for (const b of this.features.igniteNear(pos, radius * 0.9)) if (by) this.barrelBy.set(b, by);
  }

  /** Blinds anyone within FLASH_R who can see the flash, more so the closer and more directly they're looking. */
  flashbang(pos: Vector3, owner: Combatant) {
    this.fx.burst(pos, 0xffffff, 30, { speed: 10, size: 0.1, life: 0.3, gravity: 0 });
    this.sfx.flashbang(pos);
    const seen = (eye: Vector3) => {
      const d = eye.distanceTo(pos);
      if (d > FLASH_R) return -1;
      const dir = tmpDir.subVectors(pos, eye).divideScalar(Math.max(d, 0.01));
      if (this.world.raycast(eye, dir, d) < d - 0.3) return -1;
      return d;
    };
    const p = this.player;
    if (p.alive && this.inWorld(p) && !(owner.team === p.team && owner !== p)) {
      const eye = this.camera.position, d = seen(eye);
      if (d >= 0) {
        const facing = this.camera.getWorldDirection(tmpEnd).dot(tmpDir);
        const s = (1 - d / FLASH_R) * (0.45 + 0.55 * Math.max(0, facing));
        this.hud.flash(s);
        this.sfx.tinnitus(s);
      }
    }
    for (const b of this.bots.bots) {
      if (!b.alive || b.mode !== 'ground' || b.team === owner.team) continue;
      const d = seen(b.eye(tmpEye));
      if (d >= 0) b.blind = Math.max(b.blind, 2 + 5 * (1 - d / FLASH_R));
    }
  }

  // ---------- camera ----------

  private syncCamera(dt: number) {
    const p = this.player, cam = this.camera;
    if (this.deathCam.active && p.alive) this.deathCam.stop();
    if (this.lobby?.active) {
      // Menus: the camera frames your character on their podium out on the island.
      this.lobby.update(dt, cam);
      const at = this.lobby.spot, [sx, sy, sz] = this.env.sunOffset;
      this.sun.position.set(at.x + sx, at.y + sy, at.z + sz);
      this.sun.target.position.copy(at);
      // Clear air: the town below should be sharp, only the far hills fade.
      this.fog.far = 1600 * this.viewDist;
      this.fog.near = this.fog.far * 0.4;
      return;
    }
    if (p.mode === 'plane' || this.state === 'title') {
      const target = this.plane.mesh.position;
      const dist = 55;
      const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
      cam.position.set(
        target.x + Math.sin(p.yaw) * cp * dist,
        target.y - sp * dist + 10,
        target.z + Math.cos(p.yaw) * cp * dist,
      );
      cam.lookAt(target);
    } else if (this.deathCam.active && !p.alive) {
      this.deathCam.update(dt, cam);
    } else if (this.driving) {
      // Chase camera: free-look with the mouse, drifts back behind the car when you let go.
      const v = this.driving;
      if (dt > 0 && this.mouseIdle > 1.2) {
        let d = v.yaw - p.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        p.yaw += d * (1 - Math.exp(-2.5 * dt));
        p.pitch = damp(p.pitch, -0.22, 2, dt);
      }
      p.pitch = clamp(p.pitch, -1.2, 0.35);
      const target = tmpEnd.copy(v.body.pos).setY(v.body.pos.y + 2.1);
      const hs = Math.hypot(v.body.vel.x, v.body.vel.z);
      let dist = 7.5 + v.spec.length * 0.6 + hs * 0.06;
      const dir = tmpDir.set(Math.sin(p.yaw) * Math.cos(p.pitch), -Math.sin(p.pitch), Math.cos(p.yaw) * Math.cos(p.pitch));
      dist = Math.min(dist, this.world.raycast(target, dir, dist) - 0.3);
      cam.position.copy(target).addScaledVector(dir, Math.max(1.5, dist));
      cam.position.y = Math.max(cam.position.y, this.map.groundAt(cam.position.x, cam.position.z) + 0.6);
      cam.lookAt(target);
    } else {
      cam.position.set(p.body.pos.x, p.body.pos.y + p.eyeHeight, p.body.pos.z);
      // Tilt while sliding (not when aiming: the sight must stay level), lean with the glider.
      const roll = this.settings.data.cameraTilt ? (p.sliding ? 0.05 * (1 - this.weapons.adsAmount) : p.mode === 'zipline' ? 0.04 : 0) + (p.mode === 'glide' ? this.gliderBank * 0.35 : 0) : 0;
      cam.rotation.set(p.pitch + this.weapons.recoilPitch, p.yaw + this.weapons.recoilYaw, roll);
    }
    if (this.shake > 0 && dt > 0) {
      const s = this.shake * 0.35 * this.settings.data.screenShake;
      cam.position.x += (Math.random() - 0.5) * s;
      cam.position.y += (Math.random() - 0.5) * s;
      this.shake = Math.max(0, this.shake - dt * 2.2);
    }
    if (dt > 0) {
      let fov = this.settings.data.fov;
      const hs = Math.hypot(p.body.vel.x, p.body.vel.z);
      if (!this.settings.data.speedFov) { /* no speed kick */ } else if (p.mode === 'freefall') fov += 12;
      else if (this.driving) fov += Math.min(14, hs * 0.35);
      else if (p.mode === 'zipline') fov += 8;
      else if (p.sliding) fov += CONFIG.player.slideFov * Math.min(1, hs / 12);
      else if (p.sprinting) fov += CONFIG.player.sprintFov;
      const w = p.weapon;
      if (w && (p.mode === 'ground' || p.mode === 'zipline')) {
        const adsFov = w.def.adsFov;
        fov = lerp(fov, adsFov * (this.settings.data.fov / 90), this.weapons.adsAmount);
      }
      cam.fov = damp(cam.fov, fov, 12, dt);
      // High up, push the near plane out: depth precision is what stops distant ground/roads flickering.
      const above = cam.position.y - this.map.groundAt(cam.position.x, cam.position.z);
      cam.near = (p.mode === 'ground' || p.mode === 'zipline') && this.state !== 'title' ? 0.1 : clamp(above / 60, 0.1, 3);
      cam.updateProjectionMatrix();

      // Sun + shadow camera follow the player; fog opens up with altitude.
      const at = p.mode === 'plane' ? this.plane.mesh.position : p.body.pos;
      const [sx, sy, sz] = this.env.sunOffset;
      this.sun.position.set(at.x + sx, at.y + sy, at.z + sz);
      this.sun.target.position.copy(at);
      const alt = clamp(cam.position.y / 350, 0, 1);
      this.fog.far = lerp(750, 2400, alt) * this.viewDist * lerp(this.env.fogMul, 1, alt * 0.7);
      this.fog.near = this.fog.far * (this.env.wx === 'fog' ? 0.05 : 0.25);
    }
    cam.updateMatrixWorld();
  }

  // ---------- combat ----------

  inWorld(c: Combatant) {
    return c.isPlayer ? this.player.mode !== 'plane' : (c as Bot).mode !== 'plane';
  }

  /** On the ground (or driving) — i.e. something bots can fight. */
  onFoot(c: Combatant) {
    if (c.isPlayer) return this.player.mode === 'ground' || this.player.mode === 'vehicle' || this.player.mode === 'zipline';
    return (c as Bot).mode === 'ground' || (c as Bot).mode === 'vehicle';
  }

  /** Everyone still in the match (the gulag opponent doesn't count). */
  get aliveCount() {
    let n = 0;
    for (const c of this.combatants) if (c.alive && !(c instanceof Bot && (c.inGulag || c.dummy || c.boss))) n++;
    return n;
  }

  /** Teams with someone alive, not counting `except`. */
  private aliveTeams(except = -1) {
    const teams = new Set<number>();
    for (const c of this.combatants) if ((c.alive || this.redeploying.has(c)) && c.team !== except && !(c instanceof Bot && (c.inGulag || c.dummy || c.boss))) teams.add(c.team);
    return teams;
  }

  get visionMul() {
    return this.env.visionMul;
  }

  /** Bot line of sight: walls, hills, bushes and smoke all block it. */
  canSee(eye: Vector3, c: Combatant) {
    const tx = c.body.pos.x, ty = c.body.pos.y + c.body.height * 0.75, tz = c.body.pos.z;
    const d = tmpDir.set(tx - eye.x, ty - eye.y, tz - eye.z);
    const dist = d.length();
    d.divideScalar(dist);
    if (this.world.raycast(eye, d, dist) < dist - 0.3) return false;
    if (this.projectiles.smokeBlocks(eye, tmpEnd.set(tx, ty, tz))) return false;
    return dist < 6 || !this.features.bushBlocks(eye, d, dist);
  }

  private heardAt = new Map<Combatant, number>();

  /** Gunfire carries: bots nearby that aren't busy come to look (checked twice a second per shooter). */
  private hearShot(shooter: Combatant) {
    if (this.arena || !this.humanTeam(shooter.team)) return;
    const last = this.heardAt.get(shooter) ?? -9;
    if (this.matchTime - last < 0.5) return;
    this.heardAt.set(shooter, this.matchTime);
    for (const c of this.grid.query(shooter.body.pos.x, shooter.body.pos.z, 75, [])) {
      if (!(c instanceof Bot) || !c.alive || c.team === shooter.team || c.boss || c.dummy || !this.onFoot(c)) continue;
      if (Math.random() < 0.55) c.heard(shooter);
    }
  }

  fireShot(shooter: Combatant, origin: Vector3, dir: Vector3, w: WeaponInstance, muzzle: Vector3) {
    const def = w.def;
    if (this.gulagPrep > 0 && this.inArena(shooter)) return;
    this.hearShot(shooter);
    this.arena?.dropShield(shooter);
    if (shooter.isPlayer) this.music.duck(0.55);
    let t = this.world.raycast(origin, dir, def.range);
    let hitBox = this.world.lastHit;
    const barrel = this.features.rayBarrel(origin, dir, t + 0.05);
    // Vehicles shield whoever is inside them.
    let hitV: Vehicle | null = null;
    const ix = 1 / dir.x, iy = 1 / dir.y, iz = 1 / dir.z;
    for (const v of this.vehicles) {
      if (v.driver === shooter) continue;
      const r = v.body.radius, bp = v.body.pos;
      if (Math.abs(bp.x - origin.x) > t + r && Math.abs(bp.z - origin.z) > t + r) continue;
      const vt = rayBox(origin, ix, iy, iz, { minX: bp.x - r, minY: bp.y, minZ: bp.z - r, maxX: bp.x + r, maxY: bp.y + 1.75, maxZ: bp.z + r });
      if (vt < t) {
        t = vt;
        hitV = v;
        hitBox = null;
      }
    }
    let hitC: Combatant | null = null, head = false;
    for (const c of this.combatants) {
      if (c === shooter || !c.alive || !this.inWorld(c) || c.team === shooter.team || !this.canTarget(shooter, c)) continue;
      const px = c.body.pos.x - origin.x, py = c.body.pos.y + 1 - origin.y, pz = c.body.pos.z - origin.z;
      const along = px * dir.x + py * dir.y + pz * dir.z;
      if (along < 0 || along > t + 2) continue;
      const h = rayHitCombatant(origin, dir, t, c);
      if (h && h.t < t) {
        t = h.t;
        hitC = c;
        head = h.head;
        hitBox = null;
      }
    }
    // Windows between the gun and whatever it hit shatter.
    this.glass.shoot(origin, dir, t);
    const end = tmpEnd.copy(origin).addScaledVector(dir, t);
    const byPlayer = shooter.isPlayer;
    const cam = this.camera.position;
    const near = byPlayer || end.distanceToSquared(cam) < 300 * 300 || muzzle.distanceToSquared(cam) < 300 * 300;
    const melee = def.range < 3;
    const first = this.firstPellet(shooter, dir) === dir;
    const nm = this.netm;
    if (first && !melee && nm && nm.owns(shooter)) nm.sendShot(shooter, def.id, muzzle, end);
    if (near && !melee) {
      // Toy Box: chunky foam darts instead of thin tracers.
      if (TOY) this.fx.tracer(muzzle, end, byPlayer ? 0xff8a1a : 0x5ad1ff, byPlayer ? 0.035 : 0.05, 0.09);
      else this.fx.tracer(muzzle, end, byPlayer ? 0xffe08a : 0xff8a5a, byPlayer ? 0.02 : 0.035);
      // Everyone else's guns flash too, so you can see who's shooting (the first pellet is enough).
      if (!byPlayer && first) {
        this.fx.flash(muzzle, 0xffc860, def.pellets > 1 || def.id === 'sniper' ? 0.32 : 0.2);
        this.fx.flash(muzzle, 0xffffff, 0.08, 0.035);
      }
    }
    this.killcam.shot(shooter, muzzle, end, this.matchTime);
    // Near misses whiz past your head, and shots at you (or landing close) show where they came from.
    if (!byPlayer && !melee && hitC !== this.player && this.player.alive) {
      const eye = cam;
      const ex = eye.x - origin.x, ey = eye.y - origin.y, ez = eye.z - origin.z;
      const proj = ex * dir.x + ey * dir.y + ez * dir.z;
      if (proj > 3 && first && shooter.team !== this.player.team) {
        const pc = Math.min(proj, t);
        const close = Math.hypot(ex - dir.x * pc, ey - dir.y * pc, ez - dir.z * pc);
        if (close < 5) this.hud.nearShot(shooter.body.pos, shooter, 1 - close / 5);
      }
      if (proj > 3 && proj < t && this.whizCd <= 0) {
        const miss = Math.hypot(ex - dir.x * proj, ey - dir.y * proj, ez - dir.z * proj);
        if (miss < 2.2) {
          const rx = Math.cos(this.player.yaw), rz = -Math.sin(this.player.yaw);
          this.sfx.whiz(clamp(-(dir.x * rx + dir.z * rz), -1, 1));
          this.whizCd = 0.12;
        }
      }
    }
    const dmg0 = def.damage * w.rarity.mult * damageFalloff(def, t);
    if (hitC && ((this.arena && this.arena.protected(hitC)) || !this.owns(hitC))) {
      // Spawn-protected, or someone simulated on another machine: their owner applies the damage.
      const protectedNow = !!this.arena?.protected(hitC);
      let dmg = dmg0 * (head ? def.headMult : 1);
      if (this.obr && !shooter.isPlayer && hitC instanceof Bot && hitC.human) dmg *= this.tuning.damage;
      if (!protectedNow) this.netm?.sendDamage(shooter, hitC, dmg, head);
      if (near) this.fx.burst(end, protectedNow ? 0xffffff : BLOOD, 6, { speed: 3, size: 0.08, life: 0.35, gravity: 14, dir: tmpDir.copy(dir) });
      if (byPlayer && !protectedNow) {
        this.stats.hits++;
        this.stats.damage += dmg;
        if (head) this.stats.headshots++;
        this.hud.hit(false, head);
        this.hud.damageNumber(end, dmg, head ? 'head' : hitC.armor > 0 ? 'armor' : 'health', hitC);
        this.sfx.hit(head, hitC.armor > 0);
      }
    } else if (hitC) {
      const botOnBot = !this.arena && !shooter.isPlayer && !hitC.isPlayer && shooter.team !== this.player.team && hitC.team !== this.player.team;
      let dmg = dmg0 * (head ? def.headMult : 1) * (botOnBot ? CONFIG.bots.botVsBotDamage : 1);
      if (!shooter.isPlayer && hitC.team === this.player.team) dmg *= this.tuning.damage;
      if (shooter instanceof Bot && shooter.boss) dmg *= shooter.boss.def.dmgMul;
      const res = applyDamage(hitC, dmg);
      hitC.onDamaged(shooter, dmg);
      if (hitC instanceof Bot) hitC.lastHitDir.copy(dir);
      // Blood for flesh, blue sparks off armor.
      if (near) {
        if (res.toArmor > 0) this.fx.burst(end, 0x5ab4ff, 8, { speed: 5, size: 0.06, life: 0.25, dir: tmpDir.copy(dir).negate() });
        if (res.toHealth > 0) this.fx.burst(end, BLOOD, 7, { speed: 3, size: 0.09, life: 0.4, gravity: 14, dir: tmpDir.copy(dir) });
      }
      if (byPlayer) {
        this.stats.hits++;
        this.stats.damage += dmg;
        if (head) this.stats.headshots++;
        this.hud.hit(res.killed, head);
        this.hud.damageNumber(end, dmg, head ? 'head' : res.toArmor > 0 ? 'armor' : 'health', hitC);
        this.sfx.hit(head, res.toArmor > 0 && res.toHealth <= 0);
        if (res.armorBroken) {
          this.sfx.armorBreak();
          this.hud.armorCrack();
        }
      }
      if (hitC.isPlayer) {
        this.sfx.hurt();
        this.music.duck(0.4);
      }
      if (res.killed) this.onKill(shooter, hitC, w, undefined, head);
    } else if (hitV) {
      hitV.damage(dmg0 * 0.7);
      if (near) this.fx.burst(end, 0xffd080, 6, { speed: 5, size: 0.05, life: 0.2 });
      if (byPlayer) this.hud.hit(false, false);
      if (!hitV.alive) this.barrelBy.set(hitV, shooter);
    } else if (barrel && barrel.t <= t + 0.05) {
      this.features.damageBarrel(barrel.barrel, dmg0);
      this.barrelBy.set(barrel.barrel, shooter);
      if (near) this.fx.burst(end, 0xff6a3a, 6, { speed: 5, size: 0.05, life: 0.2 });
    } else if (t < def.range) {
      const n = hitBox ? boxNormal(hitBox, end, tmpN) : this.groundNormal(end.x, end.z, tmpN);
      const closeToMe = end.distanceToSquared(cam) < 120 * 120;
      if (hitBox && this.props.byBox.has(hitBox)) {
        this.props.damage(hitBox, dmg0);
        if (near) this.fx.burst(end, 0xb89a6a, 5, { speed: 3, size: 0.07, life: 0.4, gravity: 12, dir: n });
      } else if (near) {
        // Hot sparks off hard surfaces, a kick of dust off the ground, and a hole left behind.
        const hard = !!hitBox;
        if (hard) this.fx.burst(end, 0xffd890, 4, { speed: 7, size: 0.025, life: 0.18, gravity: 18, dir: n, glow: true });
        this.fx.burst(end, hard ? 0x9a948a : 0x7a6a4e, hard ? 3 : 5, { speed: hard ? 3 : 4, size: 0.05, life: 0.45, gravity: 14, dir: n, up: 1.2 });
        if (end.distanceToSquared(cam) > 4 * 4) this.fx.puff(end, hard ? 0xb8b0a0 : 0xa08a68, 1, 0.4, hard ? 0.06 : 0.09, 0.4, 0.6, { alpha: 0.35, grow: 1.6 });
        if (closeToMe && !(hitBox && this.doors.byBox.has(hitBox))) this.fx.decal(end, n, def.pellets > 1 ? 0.06 : 0.085);
      }
      if (closeToMe && (byPlayer || end.distanceToSquared(cam) < 30 * 30)) this.sfx.impact(end, !!hitBox);
    }
  }

  private lastPelletShooter: Combatant | null = null;
  private lastPelletTime = -1;
  /** Shotguns call fireShot once per pellet; only the first pellet of a blast counts for effects. */
  private firstPellet(shooter: Combatant, dir: Vector3) {
    if (this.lastPelletShooter === shooter && this.lastPelletTime === this.matchTime) return null;
    this.lastPelletShooter = shooter;
    this.lastPelletTime = this.matchTime;
    return dir;
  }

  private groundNormal(x: number, z: number, out: Vector3) {
    const h = (a: number, b: number) => this.map.groundAt(a, b);
    return out.set(h(x - 1, z) - h(x + 1, z), 2, h(x, z - 1) - h(x, z + 1)).normalize();
  }

  onKill(killer: Combatant | null, victim: Combatant, w: WeaponInstance | null, how?: string, head = false) {
    if (!victim.alive) return;
    victim.alive = false;
    victim.health = 0;
    if (killer && killer !== victim) killer.kills++;
    const involvesMe = victim.isPlayer || !!killer?.isPlayer;
    const kname = killer?.name ?? how ?? 'The Storm';
    this.hud.killfeed(kname, victim.name, w ? w.def.name : killer ? how ?? null : null, involvesMe);
    if (killer?.isPlayer && head) this.stats.headshotKills++;
    if (victim.isPlayer) this.startDeathCam(killer);
    if (this.arena) return this.arenaKill(killer, victim, w, how, head);
    const redeploy = victim.isPlayer && !!this.obr && !this.redeployUsed;
    this.obr?.onKill(killer, victim, w ? w.def.id : null, head, how, redeploy);

    if (victim instanceof Bot) {
      const arena = victim.inGulag;
      victim.die(this);
      if (victim.dummy) {
        this.dummyRespawn.push({ bot: victim, at: victim.body.pos.clone(), t: 2.5 });
        if (killer?.isPlayer) this.sfx.kill();
        return;
      }
      if (arena) {
        victim.inGulag = false;
        if (killer?.isPlayer) this.winGulag();
        return;
      }
      if (this.owns(victim)) this.dropLoot(victim, killer?.isPlayer ? w : null);
      if (victim.boss) {
        this.hud.killBanner(victim.name, 5, head, 'BOSS DEFEATED');
        this.hud.pickupToast(`Mythic ${victim.weapon.def.name} dropped!`, '#ff5ad8');
        if (killer?.isPlayer) {
          this.sfx.kill();
          this.sfx.streak(3);
        }
        return;
      }
      if (killer?.isPlayer) {
        this.sfx.kill();
        if (this.player.alive && !this.gulagFight) {
          this.player.killHeal = Math.min(60, this.player.killHeal + KILL_HEAL);
          if (this.player.health < CONFIG.player.maxHealth) this.hud.pickupToast(`+${KILL_HEAL} HP`, '#6bff9a');
        }
        this.recentKills = this.recentKills.filter((t) => this.matchTime - t < 7);
        this.recentKills.push(this.matchTime);
        const n = this.recentKills.length;
        this.hud.killBanner(victim.name, n, head, n >= 2 ? STREAK_NAMES[Math.min(n, 5)] : 'ELIMINATED');
        this.sfx.killChime(n);
      } else if (victim.team === this.player.team) this.hud.pickupToast(`${victim.name} is down`, '#ff6b6b');
    }

    if (victim.isPlayer) {
      this.player.killHeal = 0;
      if (this.driving) this.exitVehicle();
      this.weapons.reset();
      if (this.practiceMode) return this.respawnPractice();
      if (redeploy) return this.redeployOnline();
      const lostGulag = this.gulagFight;
      if (lostGulag) {
        // Lost the gulag: that's it.
        this.gulagFight = false;
        const foe = this.gulagFoe;
        if (foe) {
          foe.inGulag = false;
          foe.alive = false;
          this.scene.remove(foe.mesh);
          this.gulagFoe = null;
        }
      }
      const placement = this.aliveTeams(this.player.team).size + 1;
      // A moment looking at your body first, then the Gulag or the killcam.
      const next = () => {
        if (this.state === 'paused') return void setTimeout(next, 200);
        if (this.state !== 'playing' || this.player.alive) return;
        if (!lostGulag && this.tryGulag()) return;
        this.finalDeath(killer, placement);
      };
      setTimeout(next, DEATH_CAM_MS);
    } else if (this.player.alive && !this.practiceMode) {
      const others = this.aliveTeams(this.player.team);
      if (others.size === 0) this.endMatch(true, 1, null);
    }
  }

  private arenaKill(killer: Combatant | null, victim: Combatant, w: WeaponInstance | null, how: string | undefined, head: boolean) {
    const p = this.player;
    if (victim instanceof Bot) victim.die(this);
    if (killer?.isPlayer && victim !== p) {
      this.sfx.kill();
      this.hud.hit(true, head);
      if (p.alive) {
        p.killHeal = Math.min(60, p.killHeal + KILL_HEAL);
        if (p.health < CONFIG.player.maxHealth) this.hud.pickupToast(`+${KILL_HEAL} HP`, '#6bff9a');
      }
      this.recentKills = this.recentKills.filter((t) => this.matchTime - t < 7);
      this.recentKills.push(this.matchTime);
      const n = this.recentKills.length;
      this.hud.killBanner(victim.name, n, head, n >= 2 ? STREAK_NAMES[Math.min(n, 5)] : 'ELIMINATED');
      this.sfx.killChime(n);
    }
    if (victim === p) {
      p.killHeal = 0;
      p.frozen = true;
      p.ads = false;
      this.weapons.reset();
      this.sfx.defeat();
      this.recentKills.length = 0;
      if (this.hud.invOpen) this.toggleInventory(false, false);
    }
    this.arena!.onKill(killer, victim, w ? w.def.id : null, head, how);
  }

  private dropLoot(victim: Bot, killedWith: WeaponInstance | null = null) {
    const vw = victim.weapon;
    // Their gun with a mag or so for it, and a mag for whatever you killed them with.
    const ammo = new Map<AmmoType, number>([[vw.def.ammo, Math.max(AMMO_INFO[vw.def.ammo].pickup, magSize(vw))]]);
    if (killedWith && killedWith.def.range >= 3) {
      const t = killedWith.def.ammo, mag = t === 'rocket' ? 2 : magSize(killedWith);
      ammo.set(t, Math.max(ammo.get(t) ?? 0, mag));
    }
    const pile: LootKind[] = [
      { type: 'weapon', weapon: { ...vw, att: { ...vw.att }, mag: magSize(vw) } },
      ...[...ammo].map(([t, amount]): LootKind => ({ type: 'ammo', ammo: t, amount })),
      { type: 'plate', count: Math.max(1, 1 + victim.plates) },
    ];
    const bw = victim.backup;
    if (bw) pile.push({ type: 'weapon', weapon: { ...bw, att: { ...bw.att }, mag: magSize(bw) } });
    if (Math.random() < 0.5) pile.push({ type: 'medkit', count: 1 });
    if (victim.frags > 0) pile.push({ type: 'throwable', t: 'frag', count: victim.frags });
    if (victim.smokes > 0) pile.push({ type: 'throwable', t: 'smoke', count: victim.smokes });
    if (victim.boss) {
      // A boss's hoard: its Mythic gun plus a full refit.
      const t = vw.def.ammo;
      pile.push({ type: 'ammo', ammo: t, amount: AMMO_INFO[t].max }, { type: 'plate', count: 3 }, { type: 'medkit', count: 2 }, { type: 'throwable', t: 'frag', count: 2 });
    }
    this.loot.spawnPile(pile, this.floorBelow(victim.body.pos));
  }

  /**
   * Where an item thrown from `from` toward `to` comes to rest: stopped short of any wall in the way,
   * dropped onto the floor below, and never inside a block (then it stays at `from`).
   */
  private clearLootSpot(from: Vector3, to: Vector3) {
    // Try the spot asked for, then rings of spots around `from`, until one is clear of walls and
    // props (with room for the spinning gun) and not on top of another item.
    const r0 = Math.hypot(to.x - from.x, to.z - from.z), a0 = Math.atan2(to.z - from.z, to.x - from.x);
    const aim = new Vector3();
    let fallback: Vector3 | null = null;
    for (let ring = 0; ring < 5; ring++) {
      const r = ring === 0 ? r0 : Math.max(r0, 0.5) + ring * 0.6, n = ring === 0 ? 1 : 10;
      for (let k = 0; k < n; k++) {
        const a = a0 + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * ((Math.PI * 2) / n);
        const s = this.lootSpotToward(from, aim.set(from.x + Math.cos(a) * r, to.y, from.z + Math.sin(a) * r));
        if (!s) continue;
        fallback ??= s;
        if (!this.loot.crowded(s, 1.0)) return s;
      }
    }
    return fallback ?? from.clone();
  }

  private reseatLoot() {
    for (const it of this.loot.items) {
      const p = it.pos;
      if (!it.alive || !this.world.anyOverlap(p.x - 0.3, p.y + 0.15, p.z - 0.3, p.x + 0.3, p.y + 0.8, p.z + 0.3)) continue;
      it.alive = false;
      const s = this.clearLootSpot(p, p);
      it.alive = true;
      p.copy(s);
      if (it.beam) this.loot.seatBeam(it.beam, s, it.beam.userData.full);
    }
  }

  /** Slide from `from` toward `to`, stopping short of walls, and drop to the floor; null if that spot is inside something. */
  private lootSpotToward(from: Vector3, to: Vector3) {
    const o = new Vector3(from.x, from.y + 0.6, from.z);
    const d = new Vector3(to.x - from.x, 0, to.z - from.z);
    const len = d.length();
    let dist = len;
    const blocked = (s: Vector3) => this.world.anyOverlap(s.x - 0.42, s.y + 0.12, s.z - 0.42, s.x + 0.42, s.y + 0.85, s.z + 0.42);
    if (len > 0.01) {
      d.divideScalar(len);
      // (Starting inside a block, the ray is useless: just test the spot.)
      if (!blocked(this.floorBelow(from))) {
        const t = this.world.raycast(o, d, len + 0.6);
        dist = Math.max(0, Math.min(len, t - 0.6));
      }
    }
    const spot = this.floorBelow(o.addScaledVector(d, dist));
    return blocked(spot) ? null : spot;
  }

  /** The first floor, roof or bit of ground straight below a point (loot dropped mid-air lands on it). */
  floorBelow(pos: Vector3) {
    const ground = this.map.groundAt(pos.x, pos.z);
    if (pos.y <= ground + 0.05) return pos.clone().setY(ground);
    const from = tmpEye.set(pos.x, pos.y + 0.5, pos.z), drop = from.y - ground;
    const t = this.world.raycast(from, DOWN, drop);
    return new Vector3(pos.x, t < drop ? from.y - t : ground, pos.z);
  }

  /** Online: you get one second life, dropped from the sky over the safe zone with a pistol. */
  private redeployOnline() {
    const p = this.player;
    this.redeployUsed = true;
    this.redeploying.add(p);
    p.frozen = true;
    p.ads = false;
    if (this.hud.invOpen) this.toggleInventory(false, false);
    this.hud.announce('DOWN · REDEPLOYING IN 5 S', 4.5);
    setTimeout(() => {
      this.redeploying.delete(p);
      if (this.state !== 'playing' && this.state !== 'paused') return;
      const at = this.zone.randomSafePoint(0.6);
      p.alive = true;
      p.health = 100;
      p.armor = 0;
      p.plates = 0;
      p.medkits = 0;
      p.killHeal = 0;
      p.sprintLock = 0;
      p.mantle = null;
      p.zip = null;
      p.frozen = false;
      p.body.pos.set(at.x, this.map.groundAt(at.x, at.z) + 220, at.z);
      p.body.vel.set(0, 0, 0);
      p.mode = 'freefall';
      p.slots = [makeWeapon('pistol', RARITIES[0]), null];
      p.active = 0;
      p.unarmed = false;
      p.ammo[p.slots[0]!.def.ammo] += 36;
      this.weapons.reset();
      this.hud.fadeFromBlack(0.6, 0.4);
      this.hud.announce('REDEPLOYED · LAST LIFE', 2.5);
    }, 5000);
  }

  /** Standing on the track when the train comes through. */
  /** The train's loot: golden chests in the express car, good piles in the coaches. */
  private stockTrain() {
    const t = this.train!;
    t.lootSpots.forEach((s, i) => {
      const at = t.spotAt(i, new Vector3());
      if (s.chest) {
        const c = this.loot.addChest(at, true);
        c.landed = true;
        c.mesh.rotation.y = t.spotYaw(i) + Math.PI / 2;
        return;
      }
      const express = t.lootSpots.some((q) => q.chest && q.car === s.car);
      const w = makeWeapon(WEAPON_IDS[Math.floor(Math.random() * WEAPON_IDS.length)], RARITIES[express ? 3 : 1 + Math.floor(Math.random() * 2)]);
      const pile: LootKind[] = [
        { type: 'weapon', weapon: w },
        { type: 'ammo', ammo: w.def.ammo, amount: AMMO_INFO[w.def.ammo].pickup * 2 },
        { type: 'plate', count: express ? 3 : 2 },
      ];
      if (express) pile.push({ type: 'medkit', count: 2 });
      for (const it of this.loot.spawnPile(pile, at)) it.pos.y = at.y;
    });
  }

  /** Loot and chests (the train carries whichever are on board). */
  private cargoList: Cargo[] = [];
  private trainCargo() {
    const out = this.cargoList;
    out.length = 0;
    for (const it of this.loot.items) if (it.alive) out.push(it);
    for (const c of this.loot.chests) out.push(c);
    return out;
  }

  private trainHit(c: Combatant) {
    if (!this.owns(c) || this.inArena(c) || (c.isPlayer && this.driving)) return;
    const res = applyDamage(c, 400, true);
    const t = this.train!, yaw = t.cars[0].yaw;
    c.body.vel.set(Math.cos(yaw) * 18, 7, -Math.sin(yaw) * 18);
    if (c instanceof Bot) c.knock = 1.5;
    if (c.isPlayer) {
      this.hud.hurt(null, 400);
      this.shake = 1;
    }
    if (res.killed) this.onKill(null, c, null, 'The Express');
  }

  private respawnPractice() {
    const p = this.player, at = this.map.rangeSpot;
    setTimeout(() => {
      p.alive = true;
      p.health = 100;
      p.armor = 100;
      p.mode = 'ground';
      p.body.pos.set(at.x, this.map.groundAt(at.x, at.z) + 0.5, at.z);
      p.body.vel.set(0, 0, 0);
    }, 1500);
  }

  /** Starts the death cam over your body (skipped if you died high in the air). */
  private startDeathCam(killer: Combatant | null) {
    const p = this.player;
    if (p.mode === 'plane' || p.mode === 'freefall' || p.mode === 'glide') return;
    const ground = this.floorBelow(p.body.pos);
    if (p.body.pos.y - ground.y > 8) return;
    this.deathCam.start(this.camera.position, p.yaw, p.pitch, ground, killer && killer !== p ? killer.body.pos : null);
  }

  private finalDeath(killer: Combatant | null, placement: number) {
    this.sfx.setEngine(null);
    this.sfx.setAir(null);
    this.sfx.setZip(null);
    this.sfx.setStorm(0);
    this.sfx.defeat();
    const show = () => this.endMatch(false, placement, killer?.name ?? null);
    this.state = 'killcam';
    this.touch?.show(false);
    // Watch the kill from their side first.
    setTimeout(() => {
      if (this.killcam.play(killer, this.matchTime, () => show())) {
        this.deathCam.stop();
        this.hud.killcamBanner(this.killcam.killerName);
      } else show();
    }, 150);
  }

  private endMatch(won: boolean, placement: number, killer: string | null) {
    this.hud.killcamBanner(null);
    if (this.obr?.isHost && this.obr.net.guests > 0 && this.aliveTeams(-1).size > 1) {
      this.hud.pickupToast('You are the host: keep this page open until your friends finish', '#ffd24a');
    }
    this.state = 'over';
    this.overAt = performance.now();
    this.sfx.setAir(null);
    if (document.pointerLockElement) document.exitPointerLock();
    this.touch?.show(false);
    this.sfx.setEngine(null);
    this.sfx.setZip(null);
    this.sfx.setStorm(0);
    if (won) this.sfx.victory();
    const xp = this.cheats.used ? undefined : this.profile.finishMatch({
      won, placement, kills: this.player.kills, headshotKills: this.stats.headshotKills, damage: this.stats.damage,
      shots: this.weapons.shotsFired, hits: this.stats.hits, headshots: this.stats.headshots, time: this.matchTime,
    }, this.teamsAtStart);
    // Let the final moment register before the results screen.
    setTimeout(() => {
      this.hud.showEnd(won, placement, this.player.kills, killer, this.matchTime, xp);
      if (xp && xp.after > xp.before) this.sfx.levelUp();
    }, won ? 1200 : 300);
  }

  // ---------- audio ----------

  /** Picks the soundtrack for what's happening: lobby, the drop, a calm groove, then the final circles. */
  private updateMusic(dt: number) {
    this.updateAliveCue();
    const a = this.sfx.audio;
    if (!a) return;
    this.music.attach(a);
    let want: SongName | null = null;
    const p = this.player;
    if (this.state === 'title') want = 'lobby';
    else if (this.state === 'over') want = performance.now() - this.overAt > 3500 ? 'lobby' : null;
    else if (this.state === 'killcam') want = null;
    else if (this.state === 'paused') want = this.music.playing;
    else if (this.arena) want = this.arena.timeLeft < 60 ? 'final' : this.musicInMatch ? 'match' : null;
    else if (this.practiceMode) want = this.musicInMatch ? 'match' : null;
    else if (p.mode === 'plane' || p.mode === 'freefall' || p.mode === 'glide') want = 'drop';
    else if (this.gulagFight || this.bots.aliveCount + (p.alive ? 1 : 0) <= 6 || this.zone.phase >= 4) want = 'final';
    else if (this.musicInMatch) want = 'match';
    // Landing: the drop track fades out, then a quiet background groove comes in after a while.
    if (p.mode === 'plane' || p.mode === 'freefall' || p.mode === 'glide') this.landedFor = 0;
    else if (this.state === 'playing') this.landedFor += dt;
    if (want === 'match' && !this.practiceMode && !this.arena && this.landedFor < 15) want = null;
    this.music.play(want, want === 'final' ? 2.5 : want === 'match' ? 8 : want === null && this.music.playing === 'drop' ? 1.8 : 3);
    this.music.update(dt);
  }

  private landedFor = 0;
  /** Lowest "players left" cue played this match. */
  private aliveCue = 99;

  /** 10, 5, 3 and 2 players left: a sting and a banner, so the endgame feels like it's closing in. */
  private updateAliveCue() {
    if (this.arena || this.practiceMode || this.state !== 'playing') return;
    const n = this.aliveCount;
    if (n < 2) return;
    if (n > this.aliveCue + 2) this.aliveCue = 99; // a new match
    // The closest mark at or above the count (several dying at once plays one cue, not a burst).
    for (const t of [2, 3, 5, 10]) {
      if (n <= t && t < this.aliveCue) {
        this.aliveCue = t;
        this.sfx.playersLeft(n);
        this.hud.announce(n <= 2 ? 'FINAL 2' : `${n} PLAYERS LEFT`, 2.5);
        break;
      }
    }
  }

  /**
   * Chests belong indoors or in named places, fully clear of walls and furniture and sitting on a
   * floor. Nudges the spot a little if needed; null if there's no good place for one.
   */
  private chestSpot(s: Vector3): Vector3 | null {
    const sheltered = this.world.raycast(tmpEnd.set(s.x, s.y + 1.2, s.z), UP, 30) < 30;
    if (!sheltered && !this.map.poiAt(s.x, s.z)) return null;
    for (const [dx, dz] of CHEST_NUDGES) {
      const x = s.x + dx, z = s.z + dz;
      if (this.world.anyOverlap(x - 0.75, s.y + 0.08, z - 0.6, x + 0.75, s.y + 1.1, z + 0.6)) continue;
      if (this.world.raycast(tmpEnd.set(x, s.y + 0.4, z), DOWN, 1.2) >= 1.2) continue;
      return new Vector3(x, s.y, z);
    }
    return null;
  }

  /** Is there something solid overhead (a roof)? */
  private underRoof(pos: Vector3) {
    return this.world.raycast(tmpEnd.set(pos.x, pos.y + 1.7, pos.z), UP, 25) < 25;
  }

  private indoorT = 0;

  private ambientAudio(dt: number) {
    const p = this.player, s = this.sfx;
    this.whizCd -= dt;
    this.indoorT -= dt;
    if (this.indoorT <= 0) {
      this.indoorT = 0.3;
      s.indoor = p.mode === 'ground' && !this.driving && this.underRoof(p.body.pos);
    }
    // The war goes on somewhere else: artillery thumping away beyond the hills now and then.
    if (TOY && !this.arena && this.state === 'playing') {
      this.artilleryT -= dt;
      if (this.artilleryT <= 0) {
        this.artilleryT = 35 + Math.random() * 45;
        const n = Math.random() < 0.35 ? 3 : 1;
        for (let i = 0; i < n; i++) s.distantBoom((Math.random() - 0.5) * 1.6, i * (0.5 + Math.random() * 0.6));
      }
    }
    // Storm rumble grows as you approach the wall.
    if (p.mode !== 'plane' && !this.practiceMode && !this.gulagFight && !this.arena) {
      const dEdge = this.zone.radius - Math.hypot(p.body.pos.x - this.zone.center.x, p.body.pos.z - this.zone.center.y);
      s.setStorm(dEdge < 0 ? 1 : clamp(1 - dEdge / 70, 0, 0.6));
    } else s.setStorm(0);
    // Engine
    if (this.driving) s.setEngine(Math.hypot(this.driving.body.vel.x, this.driving.body.vel.z), this.driving.throttle);
    else s.setEngine(null);

    // Footsteps: yours and nearby bots'.
    if (p.mode === 'ground' && p.body.onGround && !p.sliding && !p.swimming) {
      const hs = Math.hypot(p.body.vel.x, p.body.vel.z);
      this.stepDist += hs * dt;
      const stride = p.sprinting ? 2.9 : p.crouching ? 1.6 : 2.3;
      if (this.stepDist > stride) {
        this.stepDist = 0;
        s.footstep(undefined, 0, p.crouching ? 0.25 : p.sprinting ? 0.8 : 0.55, this.map.isWater(p.body.pos.x, p.body.pos.z));
      }
    }
    for (const b of this.grid.query(p.body.pos.x, p.body.pos.z, 40, this.occupiedScratch)) {
      if (!(b instanceof Bot) || !b.alive || b.mode !== 'ground' || !b.body.onGround) continue;
      const d = b.body.pos.distanceTo(this.camera.position);
      if (d > 40) continue;
      const acc = (this.botSteps.get(b.id) ?? 0) + Math.hypot(b.body.vel.x, b.body.vel.z) * dt;
      if (acc > 2.6) {
        s.footstep(b.body.pos, d, 1.1, this.map.isWater(b.body.pos.x, b.body.pos.z));
        if (d < 28 && b.team !== p.team) this.hud.soundPing(b.body.pos, 'step', b);
        this.botSteps.set(b.id, 0);
      } else this.botSteps.set(b.id, acc);
    }

    if (this.env.wx === 'rain') s.rainTick(dt, !!this.driving || this.underRoof(p.body.pos));

    // Birds when it's calm; chest shimmer and campfires nearby.
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      this.birdTimer = 4 + Math.random() * 9;
      if (p.mode === 'ground' && !this.zone.isOutside(p.body.pos.x, p.body.pos.z) && this.env.wx !== 'rain' && !this.env.isNight) s.bird();
    }
    this.humTimer -= dt;
    if (this.humTimer <= 0) {
      this.humTimer = 0.45;
      let best = null, bd = 14 * 14;
      for (const c of this.loot.chests) {
        if (c.opened) continue;
        const d2 = c.pos.distanceToSquared(p.body.pos);
        if (d2 < bd) {
          bd = d2;
          best = c;
        }
      }
      if (best) {
        s.chestHum(best.pos);
        this.hud.soundPing(best.pos, 'chest', best);
      }
    }
    for (const f of this.map.fireSpots) if (Math.abs(f.x - p.body.pos.x) < 20 && Math.abs(f.z - p.body.pos.z) < 20) s.campfire(f);
  }

  // ---------- pickups ----------

  /** Nothing solid between your chest and the thing on the floor (no grabbing loot through walls). */
  private reachable(pos: Vector3, lift = 0.35) {
    const p = this.player.body.pos;
    const o = tmpReach.set(p.x, p.y + 1.1, p.z), dir = tmpReachD.set(pos.x - o.x, pos.y + lift - o.y, pos.z - o.z);
    const len = dir.length();
    if (len < 0.3) return true;
    dir.divideScalar(len);
    return this.world.raycast(o, dir, len) >= len - 0.12;
  }

  private handlePickups() {
    const p = this.player;
    this.pickupPrompt = '';
    if (this.driving || !p.alive) return;
    if (p.mode === 'zipline') {
      this.pickupPrompt = `<kbd>SPACE</kbd> Jump off &nbsp; <kbd>E</kbd> Let go`;
      return;
    }
    if (p.mode !== 'ground') return;
    const P = CONFIG.player;

    // Auto-pickup ammo, heals and grenades you run past (keeps the pace up).
    const R = P.autoPickupRange;
    for (const it of this.loot.items) {
      if (!it.alive) continue;
      const dx = it.pos.x - p.body.pos.x, dz = it.pos.z - p.body.pos.z, dy = it.pos.y - p.body.pos.y;
      if (dx * dx + dz * dz > R * R || dy > 2.0 || dy < -1.5) continue;
      if (!this.reachable(it.pos)) continue;
      const k = it.kind;
      let got = 0;
      if (k.type === 'ammo') {
        got = p.addAmmo(k.ammo, k.amount, AMMO_INFO[k.ammo].max);
        k.amount -= got;
        if (got > 0) this.hud.pickupToast(`+${got} ${AMMO_INFO[k.ammo].name}`, '#' + AMMO_INFO[k.ammo].color.toString(16).padStart(6, '0'));
        if (k.amount <= 0) this.loot.remove(it);
      } else if (k.type === 'plate' && p.plates < P.maxPlates) {
        got = Math.min(k.count, P.maxPlates - p.plates);
        p.plates += got;
        k.count -= got;
        this.hud.pickupToast(`+${got} Armor Plate${got > 1 ? 's' : ''}`, '#3aa0ff');
        if (k.count <= 0) this.loot.remove(it);
      } else if (k.type === 'medkit' && p.medkits < P.maxMedkits) {
        got = Math.min(k.count, P.maxMedkits - p.medkits);
        p.medkits += got;
        k.count -= got;
        this.hud.pickupToast(`+${got} Medkit${got > 1 ? 's' : ''}`, '#ff6b6b');
        if (k.count <= 0) this.loot.remove(it);
      } else if (k.type === 'attachment' && k.att !== 'scope') {
        const att = k.att, info = ATTACHMENTS[att];
        const target = [p.weapon, p.slots[1 - p.active]].find((w) => w && canAttach(w.def, att) && !w.att[att]) ?? null;
        if (target) {
          target.att[att] = true;
          this.loot.remove(it);
          got = 1;
          this.hud.pickupToast(`${info.name} fitted to ${target.def.name}`, '#' + info.color.toString(16).padStart(6, '0'));
        }
      } else if (k.type === 'throwable') {
        const max = THROWABLES[k.t].max;
        got = Math.min(k.count, max - p.throwables[k.t]);
        if (got > 0) {
          p.throwables[k.t] += got;
          k.count -= got;
          if (p.throwables[p.throwSel] === got && k.t !== 'grapple') p.throwSel = k.t;
          this.hud.pickupToast(`+${got} ${THROWABLES[k.t].name}`, '#c8d06a');
          if (k.count <= 0) this.loot.remove(it);
        }
      }
      if (got > 0) this.sfx.pickup();
    }

    // Chests open with F.
    const chest = this.loot.nearestChest(p.body.pos, 2.4);
    if (chest && this.reachable(chest.pos, chest.supply ? 0.7 : 0.4)) {
      this.pickupPrompt = `<kbd>F</kbd> Open ${chest.supply ? '<span style="color:#5ab4ff">Supply Drop</span>' : '<span style="color:#ffc043">Chest</span>'}`;
      if (this.input.pressed('KeyF')) {
        this.loot.openChest(chest);
        this.sfx.chestOpen();
      }
      return;
    }

    // Doors open with F.
    const facing = p.forward(tmpDir), door = this.doors.facing(p.body.pos, facing.x, facing.z);
    if (door) {
      this.pickupPrompt = `<kbd>F</kbd> ${this.doors.isOpen(door) ? 'Close' : 'Open'} door`;
      if (this.input.pressed('KeyF')) {
        this.doors.toggle(door, p.body.pos, this.sfx);
        this.obr?.sendDoor(this.doors.list.indexOf(door), this.doors.isOpen(door), door.side);
      }
      return;
    }

    // Vehicles and ziplines
    const v = this.nearestVehicle(p.body.pos, 3.8);
    if (v) this.pickupPrompt = `<kbd>E</kbd> Drive ${VEHICLE_SPECS[v.kind].name}`;
    else if (this.ziplines.nearest(tmpEye.set(p.body.pos.x, p.body.pos.y + 1.9, p.body.pos.z), 2.4)) this.pickupPrompt = `<kbd>E</kbd> Ride zipline`;

    // Weapons and attachments need an explicit F press.
    const it = this.loot.nearest(p.body.pos, P.pickupRange, (i) => (i.kind.type === 'weapon' || i.kind.type === 'attachment') && this.reachable(i.pos));
    if (!it) return;
    if (it.kind.type === 'attachment') {
      const att = it.kind.att, info = ATTACHMENTS[att];
      const target = [p.weapon, p.slots[1 - p.active]].find((w) => w && canAttach(w.def, att) && !w.att[att]) ?? null;
      const color = '#' + info.color.toString(16).padStart(6, '0');
      this.pickupPrompt = target
        ? `<kbd>F</kbd> <span style="color:${color}">${info.name}</span> → ${target.def.name} <small>(${info.desc})</small>`
        : `<span style="color:${color}">${info.name}</span> <small>— no gun can take it</small>`;
      if (target && this.input.pressed('KeyF')) {
        target.att[att] = true;
        if (att === 'extmag') target.mag = Math.min(magSize(target), target.mag);
        this.loot.remove(it);
        this.sfx.pickup();
        this.hud.pickupToast(`${info.name} fitted to ${target.def.name}`, color);
      }
      return;
    }
    if (it.kind.type !== 'weapon') return;
    const w = it.kind.weapon;
    const extras = ATT_KINDS.filter((a) => a !== 'scope' && w.att[a]).map((a) => ATTACHMENTS[a].name).join(', ');
    this.pickupPrompt = `<kbd>F</kbd> <span style="color:${w.rarity.css}">${lootLabel(it.kind)}</span>${extras ? ` <small>+ ${extras}</small>` : ''}`;
    if (!this.input.pressed('KeyF')) return;
    const empty = p.slots.findIndex((s) => s === null);
    this.loot.remove(it);
    if (empty >= 0) {
      p.slots[empty] = w;
      p.active = empty;
    } else {
      const old = p.slots[p.active]!;
      p.slots[p.active] = w;
      this.loot.spawn({ type: 'weapon', weapon: old }, p.body.pos.clone());
    }
    p.unarmed = false;
    this.weapons.reloadLeft = 0;
    this.weapons.switchLeft = 0.4;
    this.sfx.pickup();
  }
}

const tmpReach = new Vector3(), tmpReachD = new Vector3();
const tmpDir = new Vector3(), tmpEnd = new Vector3(), tmpEye = new Vector3(), tmpN = new Vector3(), trailTmp = new Vector3();
const UP = new Vector3(0, 1, 0), DOWN = new Vector3(0, -1, 0);
const CHEST_NUDGES = [[0, 0], [0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]];
const tmpInkSun = new Vector3();
const fireBuf = new Vector2();
