/** Loading screen tips (kept tiny: the first loading screen shows one before the game chunk arrives). */
export const TIPS = [
  'Bosses wear crowns: beat one for its Mythic gun (pink) — better than gold. Find them on the map.',
  'Bosses only chase you so far from home. Back off to heal, then come back for round two.',
  'Climb the giant toys: block towers, bricks and teddy laps often have loot on top.',
  'You spawn with a grappling hook: press X to zip up a roof. Its 3 charges come back on their own.',
  'Gun colour is its kit: grey has nothing, blue adds a compensator, purple a grip, gold is fully kitted.',
  'Slide (C while sprinting) then jump to keep your speed.',
  'Banks in the big cities have vaults full of loot.',
  'Chests glow gold. Supply drops land with blue smoke and the best guns.',
  'Armor plates work while you move: press V between fights.',
  'Lost your first life? Win the Gulag 1v1 to drop back in.',
  'The storm hurts more every circle. Watch the timer at the top.',
  'Hold G to aim a grenade, Z to switch between frag, smoke and flash.',
  'Ziplines and cars are the fastest way across the island.',
  'Tab opens your backpack without stopping: you can still walk.',
  'The Gold Mine and the Caves hide loot underground.',
  'A headshot does a lot more damage, especially with a sniper.',
];

export const randomTip = () => TIPS[Math.floor(Math.random() * TIPS.length)];
