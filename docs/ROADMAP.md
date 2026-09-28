# Stormfall → "Warzone × Blood Strike, but better": graphics and gunplay roadmap

## Context
Stormfall (Three.js + TS, single-file `Stormfall.html`) already has the Warzone core: plane drop, plates, Gulag, vehicles, redeploy, rarities, bosses and Mythics, online BR and Arena. It also has Blood Strike-style fast movement (slide, slide-jump, grapple, ziplines).
The user chose **graphics and gunplay** as the priority (PC, mouse and keyboard). **More content** and **progression** come after that.
The audit shows good foundations with clear gaps:
- **Gunplay:** all guns are hitscan, with no bullet drop and no penetration. There are no limb multipliers and no per-gun ADS or handling stats. The crosshair ignores spread. Audio positioning is stereo only.
- **Graphics:** a single shadow frustum, no AO, and MSAA is lost once post-processing is on. The sky is a flat color, IBL exists only in Toy Box, and materials are flat Lambert.

Each phase below ships separately: build, test in Practice Range, commit, push to `claude/funny-newton-bu6iww`.

---

## Phase 1: Gunplay feel ✅ done (HRTF audio deferred; bots stay hitscan)
**Files:**
- `src/weapons/Weapon.ts`
- `src/weapons/PlayerWeapons.ts`
- `src/game/Combat.ts`
- `src/game/Game.ts` (fire and hit path ~`:1682`, impacts ~`:1783`)
- `src/ui/Hud.ts`
- `src/game/Sfx.ts`
- `src/game/Particles.ts`
- `src/weapons/ViewModel.ts`

1. **Handling stats.** Add these fields to the weapon def in `Weapon.ts:29-61`: `adsTime`, `sprintToFire`, `moveMult`, `bulletVel`.
   - Per-gun ADS time replaces the global damp at `PlayerWeapons.ts:181`.
   - Sprint-to-fire delay: SMGs are snappy, LMGs and snipers are slow.
   - Movement speed penalty per gun.
2. **Ballistics.** Rifles, DMR and sniper get bullet travel time and drop. Reuse the projectile stepping in `src/game/Projectiles.ts`: a cheap per-bullet ray march each frame, with no mesh.
   - SMG, pistol and shotgun stay hitscan so close-range fights feel instant.
   - Bots get the same lead and drop, so fights stay fair.
3. **Penetration.** A shot can pass through thin props and walls: a 2nd raycast from the exit point with reduced damage.
4. **Limb damage.** Split the hitbox in `Combat.ts:28-57` into head, chest, stomach, arms and legs, with per-gun multipliers (e.g. legs ×0.8).
5. **Recoil 2.0.** Give each gun its own learnable pattern (the table already exists at `Weapon.ts:264`).
   - Add first-shot recoil, plus a small camera shake on heavy guns.
   - Add recoil recovery toward the start point when you stop firing.
6. **Feedback juice:**
   - A dynamic crosshair that widens with spread and bloom (`Hud.ts:618`).
   - Distinct headshot "dink" and armor-break sounds, a kill-confirm sound, and a bigger hitmarker on kill.
   - Elimination "badge" pop-ups (double kill, headshot, longshot).
7. **Impacts:** decals per material (canvas-generated metal, wood, dirt and concrete bullet holes; replace the dark squares at `Particles.ts:155`), blood splat decals, and better tracers (glow and velocity-stretched).
8. **Audio:**
   - Move gun and footstep positioning from stereo pan to `PannerNode` with HRTF (`Sfx.ts:185`).
   - Add a simple occlusion raycast (muffled low-pass when behind walls).
   - Give each gun its own tail (indoor vs outdoor already exists).
9. **Viewmodel:** a weapon inspect for every gun (currently knife only, `ViewModel.ts:597`), a stronger ADS sway and breathing, and an optional hold-breath on the sniper.

## Phase 2: Graphics
**Files:**
- `src/game/Game.ts:204-231, 382-419`
- `src/game/PostFx.ts`
- `src/game/Environment.ts`
- `src/core/Settings.ts`
- `src/world/Map.ts` (terrain material ~`:4713`)
- `src/game/Look.ts`

1. **Anti-aliasing fix.** Give the composer a multisampled render target (`samples: 4`) on high. Add an SMAA pass on medium, from `three/addons`.
2. **Cascaded shadows.** Use `three/addons/csm/CSM.js`: 3 cascades on high, 2 on medium. Replaces the single ±70 m frustum.
3. **Sky and lighting.**
   - Use the `three/addons/objects/Sky.js` physical sky and generate a PMREM env map from it, so the classic world gets real image-based lighting too.
   - The sun can drift slowly during a match.
4. **Ambient occlusion.** Use `GTAOPass` (three/addons) on high only.
5. **Materials.** Upgrade world materials to `MeshStandardMaterial` on high.
   - Add procedural canvas normal and roughness maps for terrain, rock, concrete and metal.
   - Keep Lambert on low for performance.
6. **Atmosphere.**
   - Height fog / sun-scattered fog in place of the linear `Fog(200,800)`.
   - Volumetric-looking light shafts via a cheap god-ray pass.
   - Rain wetness (lower roughness) and puddle reflections on high.
7. **Grass:** GPU wind sway (vertex shader on the instanced grass).
8. **Settings UI:** a new "Ultra" preset, plus individual toggles for Shadows, AO, AA and bloom in `Settings.ts` and the options tab.
   - Dynamic resolution stays as the safety net.

## Phase 3: Content (later)
- **New guns:** battle rifle, bolt-action, marksman lever-action, crossbow, akimbo pistols, and a heavy "Blood Strike" style launcher.
- **Gunsmith:** pick optic, muzzle (suppressor hides you from the minimap), mag, grip and stock. This extends `ATTACHMENTS` in `Weapon.ts:208`.
- **Throwables and tactical gear:** stun, smoke, semtex and claymore. The grenade wheel already exists.

## Phase 4: Progression (later)
- Player level and XP from kills, placement and challenges. Extend `src/game/Profile.ts` and the Career tab.
- Weapon levels that unlock gunsmith attachments, plus camo challenges up to animated "Mythic" camos (reusing `Skins.ts` and `Cosmetics.ts`).
- Daily and weekly challenges, and a free "season pass" track of cosmetic unlocks.

---

## Verification (each phase)
- `npm run build` must pass tsc and vite with no errors.
- `npm run dev`, then use Playwright with the pre-installed Chromium to open the Practice Range. Screenshot before and after (graphics) and test-fire every gun: drop, penetration, limb damage and crosshair.
- Check FPS on the low, medium and high presets, so there is no regression on low.
- `npm run share` rebuilds `Stormfall.html`. Then commit and push.

**Suggested order:** Phase 1 (~45–60 min of work) → Phase 2 (~60+ min) → 3 → 4, one phase per session.
