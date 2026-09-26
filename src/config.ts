// All gameplay tuning lives here. Tweak freely.
export const CONFIG = {
  mapSize: 1000,
  mapSeed: 1337,

  player: {
    radius: 0.4,
    standHeight: 1.8,
    crouchHeight: 1.15,
    eyeStand: 1.62,
    eyeCrouch: 1.0,
    eyeSlide: 0.8,

    walkSpeed: 6.2,
    sprintSpeed: 9.8,
    crouchSpeed: 3.4,
    adsSpeed: 4.6,
    groundAccel: 110,
    stopDecel: 170,
    momentumDecel: 4.5, // how fast extra speed (from slides / slide-jumps) bleeds off on the ground
    airAccel: 34,
    jumpVelocity: 7.8,
    gravity: 21,
    stepHeight: 0.55,

    slideBoost: 4.6,
    slideMaxSpeed: 16,
    slideFriction: 3.8,
    slideEndSpeed: 4.0,
    slideCooldown: 0.7, // boost cooldown; you can still slide without the boost
    slideDownhillMax: 28, // sliding down a slope can build speed up to this
    slideSteer: 2.0, // rad/s of steering while sliding

    maxHealth: 100,
    maxArmor: 100,
    plateArmor: 50,
    maxPlates: 5,
    maxMedkits: 4,
    medkitHeal: 60,
    medkitTime: 2.2,
    plateTime: 1.0,
    pickupRange: 3.0,
    autoPickupRange: 2.6, // ammo, plates and medkits are grabbed automatically within this radius

    baseFov: 90,
    sprintFov: 8,
    slideFov: 14,
  },

  drop: {
    planeAltitude: 420,
    planeSpeed: 75,
    freefallSpeed: 55,
    diveSpeed: 80,
    freefallHorizontal: 38,
    deployAltitude: 90,
    minManualDeploy: 25,
    glideFall: 9,
    glideHorizontal: 22,
  },

  zone: {
    initialRadius: 720,
    preDps: 1,
    // Each phase: circle waits, then shrinks to `radius`. `dps` is gas damage during that phase.
    phases: [
      { wait: 80, shrink: 45, radius: 400, dps: 0.5 },
      { wait: 50, shrink: 40, radius: 230, dps: 1 },
      { wait: 40, shrink: 35, radius: 120, dps: 2 },
      { wait: 35, shrink: 30, radius: 55, dps: 4 },
      { wait: 30, shrink: 25, radius: 15, dps: 7 },
      { wait: 25, shrink: 25, radius: 8, dps: 12 },
    ],
  },

  bots: {
    count: 23,
    visionRange: 140,
    fovHalfAngle: 1.2, // radians
    // Bots fight each other as well as you: whoever is closest and in sight.
    botVsBotRange: 95, // how close another bot must be before a bot considers fighting it
    botEngageChance: 0.8, // chance a bot picks a fight when it spots another bot (otherwise ignores it for a while)
    botVsBotDamage: 0.8, // damage multiplier for bot-on-bot hits
    botLootTime: 12, // seconds after landing a bot spends looting before it will start fights with other bots
    playerPreference: 0.9, // < 1 = bots prefer targeting you over an equally close bot
  },

  mouseSensitivity: 0.0022,
  adsSensitivityMult: 0.65,
};
