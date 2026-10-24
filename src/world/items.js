/**
 * Ultracraft - item registry.
 *
 * Items share the same id space as blocks: the first N item ids mirror block
 * ids (a block is placeable if `item.block != null`).  Tools, armour, food and
 * materials follow.
 */

import { BLOCKS, BLOCK } from './blocks.js';

export const items = [];
const byName = new Map();

export const ItemType = {
  BLOCK: 0, MATERIAL: 1, TOOL: 2, ARMOR: 3, FOOD: 4, POTION: 5, SPAWN_EGG: 6, MISC: 7,
};

export const ToolKind = { PICKAXE: 'pickaxe', AXE: 'axe', SHOVEL: 'shovel', HOE: 'hoe', SWORD: 'sword', SHEARS: 'shears', OTHER: 'other' };
export const ArmorSlot = { HEAD: 0, CHEST: 1, LEGS: 2, FEET: 3 };

/** Tool materials: tier, durability, mining speed, damage, enchantability. */
export const TOOL_MATS = {
  wooden: { tier: 1, durability: 59, speed: 2, damage: 0, enchant: 15, color: [150, 110, 60] },
  stone: { tier: 2, durability: 131, speed: 4, damage: 1, enchant: 5, color: [130, 130, 132] },
  iron: { tier: 3, durability: 250, speed: 6, damage: 2, enchant: 14, color: [220, 220, 224] },
  golden: { tier: 1, durability: 32, speed: 12, damage: 0, enchant: 22, color: [245, 210, 70] },
  diamond: { tier: 4, durability: 1561, speed: 8, damage: 3, enchant: 10, color: [110, 230, 225] },
  netherite: { tier: 5, durability: 2031, speed: 9, damage: 4, enchant: 15, color: [70, 62, 68] },
};

export const ARMOR_MATS = {
  leather: { defense: [1, 3, 2, 1], toughness: 0, durability: [55, 80, 75, 65], enchant: 15, color: [160, 100, 60] },
  iron: { defense: [2, 6, 5, 2], toughness: 0, durability: [165, 240, 225, 195], enchant: 9, color: [220, 220, 224] },
  golden: { defense: [1, 5, 3, 1], toughness: 0, durability: [77, 112, 105, 91], enchant: 25, color: [245, 210, 70] },
  diamond: { defense: [3, 8, 6, 3], toughness: 2, durability: [363, 528, 495, 429], enchant: 10, color: [110, 230, 225] },
  netherite: { defense: [3, 8, 6, 3], toughness: 3, durability: [407, 592, 555, 481], enchant: 15, color: [70, 62, 68] },
};

const BASE_DAMAGE = { sword: [4, 5, 6, 4, 7, 8], axe: [6, 7, 8, 6, 9, 10], pickaxe: [3, 4, 5, 3, 6, 7], shovel: [2, 3, 4, 2, 5, 6], hoe: [1, 1, 1, 1, 1, 1] };
const MAT_ORDER = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'];

function defineItem(name, opts = {}) {
  const it = Object.assign({
    name,
    label: opts.label || name.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    type: ItemType.MATERIAL,
    stack: 64,
    tex: name,
    fuel: 0,
    rarity: 'common',
    block: null,
    tool: null,
    armor: null,
    food: null,
    potion: null,
    spawnEgg: null,
    damageable: false,
    maxDamage: 0,
    tint: null,
    glint: false,
  }, opts);
  it.id = items.length;
  items.push(it);
  byName.set(name, it);
  return it;
}

// ---------------------------------------------------------------------------
// 1. Block items (id == block id for fast lookup both ways)
// ---------------------------------------------------------------------------
for (let i = 0; i < BLOCKS.length; i++) {
  const b = BLOCKS[i];
  if (b.name === 'air') { defineItem('air', { type: ItemType.MISC, stack: 0, tex: null }); continue; }
  const opts = {
    type: ItemType.BLOCK, block: i, tex: b.tex ? (b.tex.side || b.tex.all || b.tex.top) : null,
    fuel: b.burnTime || 0,
  };
  defineItem(b.name, opts);
}

// ---------------------------------------------------------------------------
// 2. Tools & weapons
// ---------------------------------------------------------------------------
const toolKinds = [
  ['pickaxe', ToolKind.PICKAXE], ['axe', ToolKind.AXE], ['shovel', ToolKind.SHOVEL],
  ['hoe', ToolKind.HOE], ['sword', ToolKind.SWORD],
];
for (const mat of MAT_ORDER) {
  const m = TOOL_MATS[mat];
  for (const [kind, k] of toolKinds) {
    const dmg = BASE_DAMAGE[kind][MAT_ORDER.indexOf(mat)];
    defineItem(mat + '_' + kind, {
      type: ItemType.TOOL, stack: 1, damageable: true, maxDamage: m.durability,
      tool: { kind: k, tier: m.tier, speed: m.speed, damage: dmg, enchantability: m.enchant, material: mat },
      tex: mat + '_' + kind,
      tint: m.color,
    });
  }
}
defineItem('shears', { type: ItemType.TOOL, stack: 1, damageable: true, maxDamage: 238, tool: { kind: ToolKind.SHEARS, tier: 0, speed: 5, damage: 1, enchantability: 15 }, tex: 'shears' });
defineItem('flint_and_steel', { type: ItemType.TOOL, stack: 1, damageable: true, maxDamage: 64, tool: { kind: ToolKind.OTHER }, tex: 'flint_and_steel' });
defineItem('fishing_rod', { type: ItemType.TOOL, stack: 1, damageable: true, maxDamage: 64, tool: { kind: ToolKind.OTHER }, tex: 'fishing_rod' });
defineItem('carrot_on_a_stick', { type: ItemType.TOOL, stack: 1, damageable: true, maxDamage: 25, tex: 'carrot_on_a_stick' });
defineItem('shield', { type: ItemType.TOOL, stack: 1, damageable: true, maxDamage: 336, tex: 'shield' });
defineItem('bow', { type: ItemType.TOOL, stack: 1, damageable: true, maxDamage: 384, tool: { kind: ToolKind.OTHER }, tex: 'bow' });
defineItem('crossbow', { type: ItemType.TOOL, stack: 1, damageable: true, maxDamage: 465, tex: 'crossbow' });
defineItem('trident', { type: ItemType.TOOL, stack: 1, damageable: true, maxDamage: 250, tool: { kind: ToolKind.OTHER, damage: 9 }, tex: 'trident' });
defineItem('brush', { type: ItemType.TOOL, stack: 1, damageable: true, maxDamage: 64, tex: 'brush' });

// ---------------------------------------------------------------------------
// 3. Armour
// ---------------------------------------------------------------------------
const armorKinds = [['helmet', ArmorSlot.HEAD, 0], ['chestplate', ArmorSlot.CHEST, 1], ['leggings', ArmorSlot.LEGS, 2], ['boots', ArmorSlot.FEET, 3]];
for (const [mat, m] of Object.entries(ARMOR_MATS)) {
  for (const [kind, slot, idx] of armorKinds) {
    defineItem(mat + '_' + kind, {
      type: ItemType.ARMOR, stack: 1, damageable: true, maxDamage: m.durability[idx],
      armor: { slot, defense: m.defense[idx], toughness: m.toughness, material: mat, enchantability: m.enchant },
      tex: mat + '_' + kind, tint: m.color,
    });
  }
}
defineItem('elytra', { type: ItemType.ARMOR, stack: 1, damageable: true, maxDamage: 432, armor: { slot: ArmorSlot.CHEST, defense: 0, toughness: 0, material: 'elytra' }, tex: 'elytra' });
defineItem('turtle_helmet', { type: ItemType.ARMOR, stack: 1, damageable: true, maxDamage: 275, armor: { slot: ArmorSlot.HEAD, defense: 2, toughness: 0, material: 'turtle' }, tex: 'turtle_helmet' });

// ---------------------------------------------------------------------------
// 4. Materials
// ---------------------------------------------------------------------------
const materials = [
  ['stick', 0, 100, 'stick'], ['coal', 0, 1600, 'coal'], ['charcoal', 0, 1600, 'charcoal'],
  ['iron_ingot', 0, 0, 'iron_ingot'], ['gold_ingot', 0, 0, 'gold_ingot'], ['netherite_ingot', 0, 0, 'netherite_ingot'],
  ['netherite_scrap', 0, 0, 'netherite_scrap'], ['copper_ingot', 0, 0, 'copper_ingot'], ['iron_nugget', 0, 0, 'iron_nugget'],
  ['gold_nugget', 0, 0, 'gold_nugget'], ['diamond', 0, 0, 'diamond'], ['emerald', 0, 0, 'emerald'],
  ['lapis_lazuli', 0, 0, 'lapis_lazuli'], ['redstone', 0, 0, 'redstone_dust'], ['quartz', 0, 0, 'quartz'],
  ['clay_ball', 0, 0, 'clay_ball'], ['brick', 0, 0, 'brick'], ['nether_brick', 0, 0, 'nether_brick'],
  ['flint', 0, 0, 'flint'], ['leather', 0, 0, 'leather'], ['string', 0, 0, 'string'],
  ['feather', 0, 0, 'feather'], ['bone', 0, 0, 'bone'], ['bone_meal', 0, 0, 'bone_meal'],
  ['gunpowder', 0, 0, 'gunpowder'], ['slime_ball', 0, 0, 'slime_ball'], ['magma_cream', 0, 0, 'magma_cream'],
  ['blaze_rod', 0, 2400, 'blaze_rod'], ['blaze_powder', 0, 1200, 'blaze_powder'],
  ['ghast_tear', 0, 0, 'ghast_tear'], ['spider_eye', 0, 0, 'spider_eye'], ['rotten_flesh', 0, 0, 'rotten_flesh'],
  ['ender_pearl', 0, 0, 'ender_pearl'], ['eye_of_ender', 0, 0, 'eye_of_ender'], ['sugar', 0, 0, 'sugar'],
  ['paper', 0, 0, 'paper'], ['book', 0, 0, 'book'], ['ink_sac', 0, 0, 'ink_sac'],
  ['glowstone_dust', 0, 0, 'glowstone_dust'], ['sugar_cane_item', 0, 0, 'sugar_cane'], ['wheat', 0, 0, 'wheat'],
  ['apple', 0, 0, 'apple'], ['golden_apple', 0, 0, 'golden_apple'], ['enchanted_golden_apple', 0, 0, 'enchanted_golden_apple'],
  ['nether_star', 0, 0, 'nether_star'], ['totem_of_undying', 0, 0, 'totem'], ['heart_of_the_sea', 0, 0, 'heart_of_the_sea'],
  ['nautilus_shell', 0, 0, 'nautilus_shell'], ['phantom_membrane', 0, 0, 'phantom_membrane'],
  ['shulker_shell', 0, 0, 'shulker_shell'], ['scute', 0, 0, 'scute'], ['rabbit_hide', 0, 0, 'rabbit_hide'],
  ['rabbit_foot', 0, 0, 'rabbit_foot'], ['name_tag', 0, 0, 'name_tag'], ['saddle', 0, 0, 'saddle'],
  ['lead', 0, 0, 'lead'], ['iron_horse_armor', 0, 0, 'iron_horse_armor'], ['golden_horse_armor', 0, 0, 'golden_horse_armor'],
  ['diamond_horse_armor', 0, 0, 'diamond_horse_armor'], ['music_disc_cat', 0, 0, 'music_disc'],
  ['music_disc_blocks', 0, 0, 'music_disc'], ['compass', 0, 0, 'compass'], ['clock', 0, 0, 'clock'],
  ['map', 0, 0, 'map'], ['spyglass', 0, 0, 'spyglass'], ['arrow', 0, 0, 'arrow'],
  ['spectral_arrow', 0, 0, 'spectral_arrow'], ['firework_rocket', 0, 0, 'firework'],
  ['boat', 0, 0, 'boat'], ['minecart', 0, 0, 'minecart'], ['chest_minecart', 0, 0, 'chest_minecart'],
  ['hopper_minecart', 0, 0, 'hopper_minecart'], ['tnt_minecart', 0, 0, 'tnt_minecart'],
  ['bucket', 0, 0, 'bucket'], ['water_bucket', 0, 0, 'water_bucket'], ['lava_bucket', 0, 0, 'lava_bucket'],
  ['milk_bucket', 0, 0, 'milk_bucket'], ['glass_bottle', 0, 0, 'glass_bottle'],
  ['ender_chest_item', 0, 0, 'ender_chest_icon'], ['snowball', 16, 0, 'snowball'], ['egg', 16, 0, 'egg'],
  ['experience_bottle', 0, 0, 'xp_bottle'], ['leather_horse_armor', 0, 0, 'leather_horse_armor'],
  ['nether_wart_item', 0, 0, 'nether_wart'], ['disc_fragment', 0, 0, 'disc_fragment'],
];
for (const [name, stack, fuel, tex] of materials) {
  defineItem(name, { type: ItemType.MATERIAL, stack: stack || 64, fuel, tex });
}

// ---------------------------------------------------------------------------
// 5. Food
// ---------------------------------------------------------------------------
const foods = [
  ['bread', 5, 0.6, 'bread', 16], ['cookie', 2, 0.1, 'cookie', 64],
  ['beef', 3, 0.3, 'beef', 64], ['cooked_beef', 8, 0.8, 'cooked_beef', 64],
  ['porkchop', 3, 0.3, 'porkchop', 64], ['cooked_porkchop', 8, 0.8, 'cooked_porkchop', 64],
  ['chicken', 2, 0.3, 'chicken', 64], ['cooked_chicken', 6, 0.6, 'cooked_chicken', 64],
  ['mutton', 2, 0.3, 'mutton', 64], ['cooked_mutton', 6, 0.8, 'cooked_mutton', 64],
  ['rabbit', 3, 0.3, 'rabbit', 64], ['cooked_rabbit', 5, 0.6, 'cooked_rabbit', 64],
  ['cod', 2, 0.1, 'cod', 64], ['cooked_cod', 5, 0.6, 'cooked_cod', 64],
  ['salmon', 2, 0.1, 'salmon', 64], ['cooked_salmon', 6, 0.8, 'cooked_salmon', 64],
  ['tropical_fish', 1, 0.1, 'tropical_fish', 64], ['carrot', 3, 0.6, 'carrot_item', 64],
  ['golden_carrot', 6, 1.2, 'golden_carrot', 64], ['potato', 1, 0.3, 'potato_item', 64],
  ['baked_potato', 5, 0.6, 'baked_potato', 64], ['poisonous_potato', 2, 0.3, 'poisonous_potato', 64],
  ['beetroot', 1, 0.6, 'beetroot_item', 64], ['beetroot_soup', 6, 0.6, 'beetroot_soup', 1],
  ['mushroom_stew', 6, 0.6, 'mushroom_stew', 1], ['rabbit_stew', 10, 0.6, 'rabbit_stew', 1],
  ['suspicious_stew', 6, 0.6, 'suspicious_stew', 1], ['melon_slice', 2, 0.3, 'melon_slice', 64],
  ['sweet_berries', 2, 0.1, 'sweet_berries', 64], ['glow_berries', 2, 0.1, 'glow_berries', 64],
  ['dried_kelp', 1, 0.3, 'dried_kelp', 64], ['cake_item', 14, 0.1, 'cake_item', 1],
  ['pumpkin_pie', 8, 0.3, 'pumpkin_pie', 64], ['spider_eye', 2, 0.8, 'spider_eye', 64],
  ['rotten_flesh', 4, 0.8, 'rotten_flesh', 64],
];
for (const [name, hunger, sat, tex, stack] of foods) {
  const existing = byName.get(name);
  const fx = [];
  if (name === 'rotten_flesh') fx.push({ effect: 'hunger', duration: 600, chance: 0.8 });
  if (name === 'spider_eye') fx.push({ effect: 'poison', duration: 100, chance: 1 });
  if (name === 'poisonous_potato') fx.push({ effect: 'poison', duration: 100, chance: 0.6 });
  if (name === 'golden_apple') fx.push({ effect: 'regeneration', duration: 100, amp: 1, chance: 1 }, { effect: 'absorption', duration: 2400, chance: 1 });
  if (name === 'enchanted_golden_apple') fx.push({ effect: 'regeneration', duration: 400, amp: 1, chance: 1 }, { effect: 'resistance', duration: 6000, chance: 1 }, { effect: 'fire_resistance', duration: 6000, chance: 1 }, { effect: 'absorption', duration: 2400, amp: 3, chance: 1 });
  if (existing) {
    existing.food = { hunger, saturation: sat, effects: fx, eatTime: 32 };
    existing.type = ItemType.FOOD;
  } else {
    defineItem(name, { type: ItemType.FOOD, stack, food: { hunger, saturation: sat, effects: fx, eatTime: 32 }, tex });
  }
}

// ---------------------------------------------------------------------------
// 6. Seeds / plantables
// ---------------------------------------------------------------------------
for (const [name, block] of [['wheat_seeds', 'wheat_crop'], ['pumpkin_seeds', 'pumpkin_stem'], ['melon_seeds', 'melon_stem'], ['beetroot_seeds', 'beetroot_crop'], ['carrot', 'carrot_crop'], ['potato', 'potato_crop'], ['nether_wart_item', 'nether_wart']]) {
  const it = byName.get(name);
  if (it) it.plantBlock = block;
}

// ---------------------------------------------------------------------------
// 7. Potions
// ---------------------------------------------------------------------------
export const POTIONS = [
  ['water_bottle', []], ['awkward_potion', []], ['thick_potion', []], ['mundane_potion', []],
  ['potion_night_vision', [{ effect: 'night_vision', duration: 3600 }]],
  ['potion_invisibility', [{ effect: 'invisibility', duration: 3600 }]],
  ['potion_fire_resistance', [{ effect: 'fire_resistance', duration: 3600 }]],
  ['potion_speed', [{ effect: 'speed', duration: 3600 }]],
  ['potion_slowness', [{ effect: 'slowness', duration: 1800 }]],
  ['potion_water_breathing', [{ effect: 'water_breathing', duration: 3600 }]],
  ['potion_healing', [{ effect: 'instant_health', duration: 1 }]],
  ['potion_harming', [{ effect: 'instant_damage', duration: 1 }]],
  ['potion_poison', [{ effect: 'poison', duration: 900 }]],
  ['potion_regeneration', [{ effect: 'regeneration', duration: 900 }]],
  ['potion_strength', [{ effect: 'strength', duration: 3600 }]],
  ['potion_weakness', [{ effect: 'weakness', duration: 1800 }]],
  ['potion_jump_boost', [{ effect: 'jump_boost', duration: 3600 }]],
  ['potion_slow_falling', [{ effect: 'slow_falling', duration: 1800 }]],
  ['potion_leaping_lingering', [{ effect: 'jump_boost', duration: 3600 }]],
];
for (const [name, effects] of POTIONS) {
  defineItem(name, { type: ItemType.POTION, stack: 1, potion: { effects }, tex: 'potion', tint: potionColor(effects) });
}
function potionColor(effects) {
  if (!effects.length) return [90, 130, 190];
  const map = {
    night_vision: [130, 200, 90], invisibility: [190, 210, 220], fire_resistance: [230, 150, 60],
    speed: [140, 200, 220], slowness: [110, 120, 170], water_breathing: [110, 140, 220],
    instant_health: [240, 80, 80], instant_damage: [70, 40, 90], poison: [110, 170, 60],
    regeneration: [240, 120, 160], strength: [180, 80, 60], weakness: [110, 110, 130],
    jump_boost: [130, 220, 120], slow_falling: [230, 230, 200],
  };
  return (map[effects[0].effect] || [120, 140, 180]);
}

// ---------------------------------------------------------------------------
// 8. Spawn eggs (filled in by the mob registry at boot)
// ---------------------------------------------------------------------------
export function registerSpawnEgg(mobName, color) {
  const name = mobName + '_spawn_egg';
  if (byName.has(name)) return byName.get(name);
  return defineItem(name, { type: ItemType.SPAWN_EGG, spawnEgg: mobName, tex: 'spawn_egg', tint: color, stack: 64 });
}

// ---------------------------------------------------------------------------
// Access helpers
// ---------------------------------------------------------------------------
export const ITEMS = items;
export const ITEM = byName;
export const itemId = (name) => {
  const it = byName.get(name);
  return it ? it.id : 0;
};
export const getItem = (id) => items[id] || items[0];
export const itemByName = (n) => byName.get(n) || null;
export const blockOfItem = (itemIdNum) => {
  const it = items[itemIdNum];
  return it && it.block != null ? it.block : null;
};
export const itemOfBlock = (blockIdNum) => blockIdNum; // block ids == item ids

export default items;
