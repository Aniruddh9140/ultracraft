/**
 * Ultracraft - crafting, smelting and every other recipe table.
 *
 * Recipes are generated programmatically from material groups so the table
 * stays short in source while covering thousands of combinations. Every
 * ingredient is resolved by name at boot; unknown names are skipped so the
 * game never crashes on a missing registry entry.
 */

import { itemId, getItem, ITEMS } from '../world/items.js';
import { blockId, BLOCKS } from '../world/blocks.js';
import { ItemStack } from './inventory.js';

// ---------------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------------
export const CRAFTING = [];   // shaped:  { w, h, ing:[9 ids], result, count, mirrored }
export const SHAPELESS = [];  // shapeless:{ ing:[ids], result, count }
export const FURNACE = new Map();   // itemId -> { result, count, xp }
export const BLAST = new Map();
export const SMOKER = new Map();
export const CAMPFIRE = new Map();
export const STONECUTTER = new Map(); // itemId -> [{result,count}]
export const SMITHING = [];  // { template, base, addition, result }
export const BREWING = [];   // { ingredient, input, result }

const known = (n) => (itemId(n) || blockId(n)) ? true : false;
const id = (n) => (itemId(n) || blockId(n) || 0);

function shaped(result, count, rows, key, mirrored = true) {
  // rows: array of strings; key: char -> item name
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const ing = new Array(9).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const c = rows[y][x];
      if (c === ' ') continue;
      const name = key[c];
      if (!name) continue;
      if (!known(name)) return;
      ing[y * 3 + x] = id(name);
    }
  }
  if (!known(result)) return;
  CRAFTING.push({ w, h, ing, result: id(result), count, mirrored });
}

function shapeless(result, count, names) {
  const ing = [];
  for (const n of names) {
    if (!known(n)) return;
    ing.push(id(n));
  }
  if (!known(result)) return;
  SHAPELESS.push({ ing, result: id(result), count });
}

function smelt(from, to, count = 1, xp = 0.1) {
  if (!known(from) || !known(to)) return;
  const e = { result: id(to), count, xp };
  FURNACE.set(id(from), e);
  return e;
}
function blast(from, to, count = 1, xp = 0.1) { if (!known(from) || !known(to)) return; BLAST.set(id(from), { result: id(to), count, xp }); }
function smoke(from, to, count = 1, xp = 0.1) { if (!known(from) || !known(to)) return; SMOKER.set(id(from), { result: id(to), count, xp }); }
function campfire(from, to, count = 1) { if (!known(from) || !known(to)) return; CAMPFIRE.set(id(from), { result: id(to), count }); }
function stonecut(from, to, count = 1) {
  if (!known(from) || !known(to)) return;
  if (!STONECUTTER.has(id(from))) STONECUTTER.set(id(from), []);
  STONECUTTER.get(id(from)).push({ result: id(to), count });
}

// ---------------------------------------------------------------------------
// material groups
// ---------------------------------------------------------------------------
export const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'crimson', 'warped'];
export const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
export const TOOL_MATS = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'];
export const TOOL_MAT_ITEM = { wooden: 'oak_planks', stone: 'cobblestone', iron: 'iron_ingot', golden: 'gold_ingot', diamond: 'diamond', netherite: 'netherite_ingot' };
export const ARMOR_MATS = ['leather', 'iron', 'golden', 'diamond', 'netherite'];
export const ARMOR_MAT_ITEM = { leather: 'leather', iron: 'iron_ingot', golden: 'gold_ingot', diamond: 'diamond', netherite: 'netherite_ingot' };
export const TOOLS = [
  ['pickaxe', ['MMM', ' S ', ' S ']],
  ['axe', ['MM', 'MS', ' S']],
  ['shovel', ['M', 'S', 'S']],
  ['hoe', ['MM', ' S', ' S']],
  ['sword', ['M', 'M', 'S']],
];
export const ARMOR_PARTS = [
  ['helmet', ['MMM', 'M M']],
  ['chestplate', ['M M', 'MMM', 'MMM']],
  ['leggings', ['MMM', 'M M', 'M M']],
  ['boots', ['M M', 'M M']],
];
/** stone-like families that get slab / stairs / wall variants */
export const STONE_FAMILIES = [
  'stone', 'cobblestone', 'stone_bricks', 'mossy_cobblestone', 'smooth_stone', 'granite', 'polished_granite',
  'diorite', 'polished_diorite', 'andesite', 'polished_andesite', 'deepslate', 'cobbled_deepslate', 'tuff',
  'bricks', 'sandstone', 'red_sandstone', 'nether_bricks', 'red_nether_bricks', 'quartz_block', 'purpur_block',
  'end_stone', 'end_stone_bricks', 'blackstone', 'cut_copper', 'mud_bricks', 'prismarine', 'dark_prismarine',
];

// ---------------------------------------------------------------------------
// 1. wood
// ---------------------------------------------------------------------------
for (const w of WOODS) {
  shapeless(w + '_planks', 4, [w + '_log']);
  shapeless(w + '_planks', 4, [w + '_wood']);
  shaped('stick', 4, ['P', 'P'], { P: w + '_planks' });
  shaped(w + '_stairs', 4, ['P  ', 'PP ', 'PPP'], { P: w + '_planks' });
  shaped(w + '_slab', 6, ['PPP'], { P: w + '_planks' });
  shaped(w + '_fence', 3, ['PSP', 'PSP'], { P: w + '_planks', S: 'stick' });
  shaped(w + '_fence_gate', 1, ['SPS', 'SPS'], { P: w + '_planks', S: 'stick' });
  shaped(w + '_door', 3, ['PP', 'PP', 'PP'], { P: w + '_planks' });
  shaped(w + '_trapdoor', 2, ['PPP', 'PPP'], { P: w + '_planks' });
  shaped(w + '_sign', 3, ['PPP', 'PPP', ' S '], { P: w + '_planks', S: 'stick' });
  shaped(w + '_pressure_plate', 1, ['PP'], { P: w + '_planks' });
  shaped(w + '_button', 1, ['P'], { P: w + '_planks' });
  shaped(w + '_wood', 3, ['LL', 'LL'], { L: w + '_log' });
  shapeless('boat', 1, [w + '_planks']);
  smelt(w + '_log', 'charcoal', 1, 0.15);
  // beds: 3 wool + 3 planks
  for (const c of COLORS) shaped(c + '_bed', 1, ['WWW', 'PPP'], { W: c + '_wool', P: w + '_planks' });
}
shapeless('crafting_table', 1, ['oak_planks', 'oak_planks', 'oak_planks', 'oak_planks']);
shapeless('chest', 1, ['oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks']);
shaped('barrel', 1, ['PSP', 'P P', 'PSP'], { P: 'oak_planks', S: 'oak_slab' });
shaped('bookshelf', 1, ['PPP', 'BBB', 'PPP'], { P: 'oak_planks', B: 'book' });
shaped('jukebox', 1, ['PPP', 'PDP', 'PPP'], { P: 'oak_planks', D: 'diamond' });
shaped('note_block', 1, ['PPP', 'PRP', 'PPP'], { P: 'oak_planks', R: 'redstone' });
shaped('ladder', 3, ['S S', 'SSS', 'S S'], { S: 'stick' });
shaped('torch', 4, ['C', 'S'], { C: 'coal', S: 'stick' });
shaped('soul_torch', 4, ['C', 'S', 'S'], { C: 'soul_sand', S: 'stick' });
shapeless('soul_torch', 4, ['torch', 'soul_sand']);
shaped('bowl', 4, ['P P', ' P '], { P: 'oak_planks' });
shapeless('crafting_table', 1, ['oak_planks', 'oak_planks', 'oak_planks', 'oak_planks']);

// ---------------------------------------------------------------------------
// 2. stone families
// ---------------------------------------------------------------------------
for (const f of STONE_FAMILIES) {
  shaped(f + '_stairs', 4, ['S  ', 'SS ', 'SSS'], { S: f });
  shaped(f + '_slab', 6, ['SSS'], { S: f });
  shaped(f + '_wall', 6, ['SSS', 'SSS'], { S: f });
  stonecut(f, f + '_slab', 2);
  stonecut(f, f + '_stairs', 1);
  stonecut(f, f + '_wall', 1);
}
shaped('furnace', 1, ['CCC', 'C C', 'CCC'], { C: 'cobblestone' });
shaped('blast_furnace', 1, ['III', 'IFI', 'SSS'], { I: 'iron_ingot', F: 'furnace', S: 'smooth_stone' });
shaped('smoker', 1, [' L ', 'LFL', ' L '], { L: 'oak_log', F: 'furnace' });
shaped('crafting_table', 1, ['PP', 'PP'], { P: 'oak_planks' });
shaped('stonecutter', 1, [' I ', 'SSS'], { I: 'iron_ingot', S: 'stone' });
shaped('grindstone', 1, ['SPS', 'P P'], { S: 'stick', P: 'oak_planks' });
shaped('loom', 1, ['SS', 'PP'], { S: 'string', P: 'oak_planks' });
shaped('smithing_table', 1, ['II', 'PP', 'PP'], { I: 'iron_ingot', P: 'oak_planks' });
shaped('cartography_table', 1, ['AA', 'PP', 'PP'], { A: 'paper', P: 'oak_planks' });
shaped('fletching_table', 1, ['FF', 'PP', 'PP'], { F: 'flint', P: 'oak_planks' });
shaped('composter', 1, ['S S', 'S S', 'SSS'], { S: 'oak_slab' });
shaped('cauldron', 1, ['I I', 'I I', 'III'], { I: 'iron_ingot' });
shaped('brewing_stand', 1, [' R ', 'CCC'], { R: 'blaze_rod', C: 'cobblestone' });
shaped('enchanting_table', 1, [' B ', 'DOD', 'OOO'], { B: 'book', D: 'diamond', O: 'obsidian' });
shaped('anvil', 1, ['III', ' N ', 'NNN'], { I: 'iron_block', N: 'iron_ingot' });
shaped('beacon', 1, ['GGG', 'GSG', 'OOO'], { G: 'glass', S: 'nether_star', O: 'obsidian' });
shaped('hopper', 1, ['I I', 'ICI', ' I '], { I: 'iron_ingot', C: 'chest' });
shaped('tnt', 1, ['GSG', 'SGS', 'GSG'], { G: 'gunpowder', S: 'sand' });
shaped('piston', 1, ['PPP', 'CIC', 'CRC'], { P: 'oak_planks', C: 'cobblestone', I: 'iron_ingot', R: 'redstone' });
shaped('observer', 1, ['CCC', 'RRQ', 'CCC'], { C: 'cobblestone', R: 'redstone', Q: 'quartz' });
shaped('dispenser', 1, ['CCC', 'CBC', 'CRC'], { C: 'cobblestone', B: 'bow', R: 'redstone' });
shaped('dropper', 1, ['CCC', 'C C', 'CRC'], { C: 'cobblestone', R: 'redstone' });
shaped('lever', 1, ['S', 'C'], { S: 'stick', C: 'cobblestone' });
shaped('redstone_torch', 1, ['R', 'S'], { R: 'redstone', S: 'stick' });
shaped('repeater', 1, ['TRT', 'SSS'], { T: 'redstone_torch', R: 'redstone', S: 'stone' });
shaped('comparator', 1, [' T ', 'TQT', 'SSS'], { T: 'redstone_torch', Q: 'quartz', S: 'stone' });
shaped('target', 1, [' R ', 'RHR', ' R '], { R: 'redstone', H: 'hay_block' });
shaped('daylight_detector', 1, ['GGG', 'QQQ', 'SSS'], { G: 'glass', Q: 'quartz', S: 'oak_slab' });
shaped('lantern', 1, ['NNN', 'NTN', 'NNN'], { N: 'iron_nugget', T: 'torch' });
shaped('campfire', 1, ' S ,SCS,CCC'.split(','), { S: 'stick', C: 'oak_log' });
shapeless('flint_and_steel', 1, ['iron_ingot', 'flint']);
shaped('bucket', 1, ['I I', ' I '], { I: 'iron_ingot' });
shaped('shears', 1, [' I', 'I '], { I: 'iron_ingot' });
shaped('compass', 1, [' I ', 'IRI', ' I '], { I: 'iron_ingot', R: 'redstone' });
shaped('clock', 1, [' G ', 'GRG', ' G '], { G: 'gold_ingot', R: 'redstone' });
shaped('spyglass', 1, ['A', 'C', 'C'], { A: 'amethyst_shard', C: 'copper_ingot' });
shaped('map', 1, ['PPP', 'PCP', 'PPP'], { P: 'paper', C: 'compass' });
shapeless('paper', 3, ['sugar_cane_item', 'sugar_cane_item', 'sugar_cane_item']);
shapeless('book', 1, ['paper', 'paper', 'paper', 'leather']);
shaped('shield', 1, ['PIP', 'PPP', ' P '], { P: 'oak_planks', I: 'iron_ingot' });
shaped('bow', 1, ' SL,S L, SL'.split(','), { S: 'stick', L: 'string' });
shaped('crossbow', 1, ['SIS', 'LTL', ' S '], { S: 'stick', I: 'iron_ingot', L: 'string', T: 'tripwire_hook' });
shaped('arrow', 4, ['F', 'S', 'E'], { F: 'flint', S: 'stick', E: 'feather' });
shaped('fishing_rod', 1, ['  S', ' SL', 'S L'], { S: 'stick', L: 'string' });
shaped('iron_bars', 16, ['III', 'III'], { I: 'iron_ingot' });
shaped('glass_pane', 16, ['GGG', 'GGG'], { G: 'glass' });
shaped('chain', 1, ['N', 'I', 'N'], { N: 'iron_nugget', I: 'iron_ingot' });
shaped('scaffolding', 6, ['BSB', 'B B', 'B B'], { B: 'bamboo', S: 'string' });
shaped('jack_o_lantern', 1, ['P', 'T'], { P: 'carved_pumpkin', T: 'torch' });
shapeless('glowstone', 1, ['glowstone_dust', 'glowstone_dust', 'glowstone_dust', 'glowstone_dust']);
shapeless('sea_lantern', 1, ['prismarine_crystals', 'prismarine_shard', 'prismarine_shard', 'prismarine_shard', 'prismarine_shard']);
shaped('minecart', 1, ['I I', 'III'], { I: 'iron_ingot' });
shaped('chest_minecart', 1, ['C', 'M'], { C: 'chest', M: 'minecart' });
shaped('hopper_minecart', 1, ['H', 'M'], { H: 'hopper', M: 'minecart' });
shaped('tnt_minecart', 1, ['T', 'M'], { T: 'tnt', M: 'minecart' });
shaped('rail', 16, ['I I', 'ISI', 'I I'], { I: 'iron_ingot', S: 'stick' });
shaped('powered_rail', 6, ['G G', 'GSG', 'GRG'], { G: 'gold_ingot', S: 'stick', R: 'redstone' });
shaped('detector_rail', 6, ['I I', 'IPI', 'IRI'], { I: 'iron_ingot', P: 'stone_pressure_plate', R: 'redstone' });
shaped('activator_rail', 6, ['ISI', 'IRI', 'ISI'], { I: 'iron_ingot', S: 'stick', R: 'redstone_torch' });
shaped('iron_block', 1, ['III', 'III', 'III'], { I: 'iron_ingot' });
shapeless('iron_ingot', 9, ['iron_block']);
shaped('gold_block', 1, ['III', 'III', 'III'], { I: 'gold_ingot' });
shapeless('gold_ingot', 9, ['gold_block']);
shaped('diamond_block', 1, ['III', 'III', 'III'], { I: 'diamond' });
shapeless('diamond', 9, ['diamond_block']);
shaped('emerald_block', 1, ['III', 'III', 'III'], { I: 'emerald' });
shapeless('emerald', 9, ['emerald_block']);
shaped('lapis_block', 1, ['III', 'III', 'III'], { I: 'lapis_lazuli' });
shapeless('lapis_lazuli', 9, ['lapis_block']);
shaped('redstone_block', 1, ['III', 'III', 'III'], { I: 'redstone' });
shapeless('redstone', 9, ['redstone_block']);
shaped('coal_block', 1, ['III', 'III', 'III'], { I: 'coal' });
shapeless('coal', 9, ['coal_block']);
shaped('copper_block', 1, ['III', 'III', 'III'], { I: 'copper_ingot' });
shapeless('copper_ingot', 9, ['copper_block']);
shaped('netherite_block', 1, ['III', 'III', 'III'], { I: 'netherite_ingot' });
shapeless('netherite_ingot', 9, ['netherite_block']);
shaped('slime_block', 1, ['SSS', 'SSS', 'SSS'], { S: 'slime_ball' });
shapeless('slime_ball', 9, ['slime_block']);
shaped('hay_block', 1, ['WWW', 'WWW', 'WWW'], { W: 'wheat' });
shapeless('wheat', 9, ['hay_block']);
shaped('melon', 1, ['MMM', 'MMM', 'MMM'], { M: 'melon_slice' });
shapeless('melon_slice', 9, ['melon']);
shapeless('bone_meal', 3, ['bone']);
shapeless('clay', 1, ['clay_ball', 'clay_ball', 'clay_ball', 'clay_ball']);
shapeless('nether_wart_block', 1, ['nether_wart_item', 'nether_wart_item', 'nether_wart_item', 'nether_wart_item', 'nether_wart_item', 'nether_wart_item', 'nether_wart_item', 'nether_wart_item', 'nether_wart_item']);
shapeless('quartz_block', 4, ['quartz', 'quartz', 'quartz', 'quartz']);
shaped('nether_bricks', 1, ['BB', 'BB'], { B: 'nether_brick' });

// ---------------------------------------------------------------------------
// 3. tools & armour
// ---------------------------------------------------------------------------
for (const mat of TOOL_MATS) {
  const M = TOOL_MAT_ITEM[mat];
  for (const [tool, rows] of TOOLS) {
    if (tool === 'sword') shaped(mat + '_' + tool, 1, ['M', 'M', 'S'], { M, S: 'stick' });
    else if (tool === 'axe') shaped(mat + '_' + tool, 1, ['MM', 'MS', ' S'], { M, S: 'stick' });
    else if (tool === 'hoe') shaped(mat + '_' + tool, 1, ['MM', ' S', ' S'], { M, S: 'stick' });
    else if (tool === 'shovel') shaped(mat + '_' + tool, 1, ['M', 'S', 'S'], { M, S: 'stick' });
    else shaped(mat + '_' + tool, 1, rows, { M, S: 'stick' });
  }
}
for (const mat of ARMOR_MATS) {
  const M = ARMOR_MAT_ITEM[mat];
  for (const [part, rows] of ARMOR_PARTS) shaped(mat + '_' + part, 1, rows, { M });
}
// netherite upgrades
for (const part of ['helmet', 'chestplate', 'leggings', 'boots', 'pickaxe', 'axe', 'shovel', 'hoe', 'sword']) {
  SMITHING.push({ base: id('diamond_' + part), addition: id('netherite_ingot'), template: id('netherite_upgrade_smithing_template'), result: id('netherite_' + part) });
}

// ---------------------------------------------------------------------------
// 4. colours: wool, carpet, beds, concrete, glass, terracotta
// ---------------------------------------------------------------------------
export const DYE_SOURCES = {
  white: ['bone_meal'], orange: ['orange_tulip'], magenta: ['allium'], light_blue: ['blue_orchid'],
  yellow: ['dandelion'], lime: [], pink: ['pink_tulip'], gray: [], light_gray: ['azure_bluet', 'oxeye_daisy'],
  cyan: [], purple: [], blue: ['lapis_lazuli', 'cornflower'], brown: ['cocoa_beans'], green: [],
  red: ['poppy', 'red_tulip', 'rose_bush', 'beetroot'], black: ['ink_sac'],
};
for (const c of COLORS) {
  const dye = c + '_dye';
  for (const src of (DYE_SOURCES[c] || [])) shapeless(dye, 1, [src]);
  shapeless(c + '_wool', 1, ['white_wool', dye]);
  for (const w of WOODS) shapeless(c + '_bed', 1, ['white_bed', dye]);
  shaped(c + '_carpet', 3, ['WW'], { W: c + '_wool' });
  shaped(c + '_stained_glass', 8, ['GGG', 'GDG', 'GGG'], { G: 'glass', D: dye });
  shaped(c + '_stained_glass_pane', 16, ['GGG', 'GGG'], { G: c + '_stained_glass' });
  shaped(c + '_terracotta', 8, ['TTT', 'TDT', 'TTT'], { T: 'terracotta', D: dye });
  shapeless(c + '_concrete_powder', 8, ['sand', 'sand', 'sand', 'sand', 'gravel', 'gravel', 'gravel', 'gravel', dye]);
  shapeless(c + '_glazed_terracotta', 1, [c + '_terracotta']);
}
shapeless('wool', 1, ['string', 'string', 'string', 'string']);
shapeless('white_wool', 1, ['string', 'string', 'string', 'string']);

// ---------------------------------------------------------------------------
// 5. food
// ---------------------------------------------------------------------------
shaped('bread', 1, ['WWW'], { W: 'wheat' });
shaped('cake', 1, ['MMM', 'SES', 'WWW'], { M: 'milk_bucket', S: 'sugar', E: 'egg', W: 'wheat' });
shaped('cookie', 8, ['WCW'], { W: 'wheat', C: 'cocoa_beans' });
shapeless('pumpkin_pie', 1, ['pumpkin', 'sugar', 'egg']);
shaped('golden_apple', 1, ['GGG', 'GAG', 'GGG'], { G: 'gold_ingot', A: 'apple' });
shaped('enchanted_golden_apple', 1, ['GGG', 'GAG', 'GGG'], { G: 'gold_block', A: 'apple' });
shapeless('mushroom_stew', 1, ['bowl', 'brown_mushroom', 'red_mushroom']);
shapeless('rabbit_stew', 1, ['bowl', 'cooked_rabbit', 'carrot', 'baked_potato', 'brown_mushroom']);
shapeless('beetroot_soup', 1, ['bowl', 'beetroot', 'beetroot', 'beetroot', 'beetroot', 'beetroot', 'beetroot']);
shapeless('golden_carrot', 1, ['carrot', 'gold_nugget', 'gold_nugget', 'gold_nugget', 'gold_nugget', 'gold_nugget', 'gold_nugget', 'gold_nugget', 'gold_nugget']);

// ---------------------------------------------------------------------------
// 6. smelting
// ---------------------------------------------------------------------------
smelt('iron_ore', 'iron_ingot', 1, 0.7);
smelt('deepslate_iron_ore', 'iron_ingot', 1, 0.7);
smelt('gold_ore', 'gold_ingot', 1, 1.0);
smelt('deepslate_gold_ore', 'gold_ingot', 1, 1.0);
smelt('nether_gold_ore', 'gold_ingot', 1, 1.0);
smelt('copper_ore', 'copper_ingot', 1, 0.7);
smelt('deepslate_copper_ore', 'copper_ingot', 1, 0.7);
smelt('ancient_debris', 'netherite_scrap', 1, 2.0);
smelt('sand', 'glass', 1, 0.1);
smelt('red_sand', 'glass', 1, 0.1);
smelt('cobblestone', 'stone', 1, 0.1);
smelt('stone', 'smooth_stone', 1, 0.1);
smelt('clay_ball', 'brick', 1, 0.3);
smelt('clay', 'terracotta', 1, 0.35);
smelt('netherrack', 'nether_brick', 1, 0.1);
smelt('quartz_ore', 'quartz', 1, 0.2);
smelt('nether_quartz_ore', 'quartz', 1, 0.2);
smelt('wet_sponge', 'sponge', 1, 0.15);
smelt('kelp', 'dried_kelp', 1, 0.1);
smelt('chorus_fruit', 'popped_chorus_fruit', 1, 0.1);
smelt('sea_pickle', 'lime_dye', 1, 0.1);
smelt('cactus', 'green_dye', 1, 0.2);
smelt('redstone_ore', 'redstone', 1, 0.7);
smelt('deepslate_redstone_ore', 'redstone', 1, 0.7);
smelt('coal_ore', 'coal', 1, 0.1);
smelt('deepslate_coal_ore', 'coal', 1, 0.1);
smelt('diamond_ore', 'diamond', 1, 1.0);
smelt('deepslate_diamond_ore', 'diamond', 1, 1.0);
smelt('emerald_ore', 'emerald', 1, 1.0);
smelt('deepslate_emerald_ore', 'emerald', 1, 1.0);
smelt('lapis_ore', 'lapis_lazuli', 1, 0.2);
smelt('deepslate_lapis_ore', 'lapis_lazuli', 1, 0.2);
smelt('iron_ingot', 'iron_nugget', 1, 0);
smelt('gold_ingot', 'gold_nugget', 1, 0);
smelt('sandstone', 'smooth_sandstone', 1, 0.1);
smelt('red_sandstone', 'smooth_red_sandstone', 1, 0.1);
smelt('quartz_block', 'smooth_quartz', 1, 0.1);
smelt('basalt', 'smooth_basalt', 1, 0.1);
smelt('blackstone', 'polished_blackstone', 1, 0.1);
smelt('nether_bricks', 'cracked_nether_bricks', 1, 0.1);
smelt('stone_bricks', 'cracked_stone_bricks', 1, 0.1);

const COOKED = {
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato',
};
for (const [raw, done] of Object.entries(COOKED)) {
  smelt(raw, done, 1, 0.35);
  smoke(raw, done, 1, 0.35);
  campfire(raw, done, 1);
}
blast('iron_ore', 'iron_ingot', 1, 0.7);
blast('gold_ore', 'gold_ingot', 1, 1.0);
blast('copper_ore', 'copper_ingot', 1, 0.7);
blast('ancient_debris', 'netherite_scrap', 1, 2.0);
blast('sand', 'glass', 1, 0.1);
blast('red_sand', 'glass', 1, 0.1);
blast('cobblestone', 'stone', 1, 0.1);
blast('stone', 'smooth_stone', 1, 0.1);
blast('netherrack', 'nether_brick', 1, 0.1);

/** Fuel values in ticks (20 ticks = 1 second). */
export const FUELS = new Map();
function fuel(name, ticks) { if (known(name)) FUELS.set(id(name), ticks); }
fuel('coal', 1600); fuel('charcoal', 1600); fuel('coal_block', 16000);
fuel('stick', 100); fuel('oak_planks', 300); fuel('spruce_planks', 300); fuel('birch_planks', 300);
fuel('jungle_planks', 300); fuel('acacia_planks', 300); fuel('dark_oak_planks', 300);
fuel('oak_log', 300); fuel('spruce_log', 300); fuel('birch_log', 300); fuel('jungle_log', 300);
fuel('acacia_log', 300); fuel('dark_oak_log', 300); fuel('oak_wood', 300); fuel('spruce_wood', 300);
fuel('birch_wood', 300); fuel('jungle_wood', 300); fuel('acacia_wood', 300); fuel('dark_oak_wood', 300);
fuel('oak_sapling', 100); fuel('spruce_sapling', 100); fuel('birch_sapling', 100);
fuel('jungle_sapling', 100); fuel('acacia_sapling', 100); fuel('dark_oak_sapling', 100);
fuel('crafting_table', 300); fuel('bookshelf', 300); fuel('chest', 300); fuel('trapped_chest', 300);
fuel('barrel', 300); fuel('oak_door', 200); fuel('oak_stairs', 300); fuel('oak_slab', 150);
fuel('oak_fence', 300); fuel('oak_fence_gate', 300); fuel('oak_trapdoor', 300); fuel('oak_pressure_plate', 300);
fuel('ladder', 300); fuel('bowl', 100); fuel('lava_bucket', 20000); fuel('blaze_rod', 2400);
fuel('dried_kelp_block', 4000); fuel('bamboo', 50); fuel('scaffolding', 50); fuel('hay_block', 4000);

export function fuelValue(itemIdNum) { return FUELS.get(itemIdNum) || 0; }

// ---------------------------------------------------------------------------
// 7. brewing
// ---------------------------------------------------------------------------
function brew(input, ingredient, result) {
  if (!known(input) || !known(ingredient) || !known(result)) return;
  BREWING.push({ input: id(input), ingredient: id(ingredient), result: id(result) });
}
brew('water_bottle', 'nether_wart_item', 'awkward_potion');
brew('awkward_potion', 'sugar', 'potion_speed');
brew('awkward_potion', 'rabbit_foot', 'potion_jump_boost');
brew('awkward_potion', 'blaze_powder', 'potion_strength');
brew('awkward_potion', 'ghast_tear', 'potion_regeneration');
brew('awkward_potion', 'golden_carrot', 'potion_night_vision');
brew('awkward_potion', 'pufferfish', 'potion_water_breathing');
brew('awkward_potion', 'spider_eye', 'potion_poison');
brew('awkward_potion', 'glistering_melon_slice', 'potion_healing');
brew('awkward_potion', 'magma_cream', 'potion_fire_resistance');
brew('awkward_potion', 'phantom_membrane', 'potion_slow_falling');
brew('awkward_potion', 'fermented_spider_eye', 'potion_weakness');
brew('potion_night_vision', 'fermented_spider_eye', 'potion_invisibility');
brew('potion_speed', 'fermented_spider_eye', 'potion_slowness');
brew('potion_healing', 'fermented_spider_eye', 'potion_harming');
brew('potion_poison', 'fermented_spider_eye', 'potion_harming');
brew('water_bottle', 'fermented_spider_eye', 'potion_weakness');

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------
/**
 * Match a 3x3 grid (array of 9 item ids, 0 = empty) against the shaped table.
 * The grid is trimmed to its bounding box so a recipe can be crafted anywhere
 * inside the grid, and mirrored horizontally when the recipe allows it.
 */
function trim(grid, w = 3, h = 3) {
  let minX = 3, maxX = -1, minY = 3, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y * 3 + x]) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const out = [];
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) out.push(grid[y * 3 + x]);
  return { cells: out, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function cellsMatch(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function mirror(cells, w, h) {
  const out = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push(cells[y * w + (w - 1 - x)]);
  return out;
}

export function matchShaped(grid) {
  const t = trim(grid);
  if (!t) return null;
  for (const r of CRAFTING) {
    if (r.w !== t.w || r.h !== t.h) continue;
    const want = [];
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) want.push(r.ing[y * 3 + x]);
    if (cellsMatch(t.cells, want)) return r;
    if (r.mirrored && cellsMatch(t.cells, mirror(want, r.w, r.h))) return r;
  }
  return null;
}

export function matchShapeless(grid) {
  const have = [];
  for (let i = 0; i < 9; i++) if (grid[i]) have.push(grid[i]);
  if (!have.length) return null;
  have.sort((a, b) => a - b);
  for (const r of SHAPELESS) {
    if (r.ing.length !== have.length) continue;
    const want = [...r.ing].sort((a, b) => a - b);
    let ok = true;
    for (let i = 0; i < want.length; i++) if (want[i] !== have[i]) { ok = false; break; }
    if (ok) return r;
  }
  return null;
}

/** Try both shaped and shapeless tables. */
export function matchRecipe(grid) {
  return matchShaped(grid) || matchShapeless(grid);
}

/** Consume one craft's worth of ingredients from a 3x3 container. */
export function consumeIngredients(container, grid) {
  for (let i = 0; i < 9; i++) {
    if (!grid[i]) continue;
    const s = container.get(i);
    if (s) {
      s.count--;
      if (s.count <= 0) container.set(i, null);
    }
  }
}

export function stonecutterRecipes(itemIdNum) { return STONECUTTER.get(itemIdNum) || []; }

export function findBrewing(input, ingredient) {
  for (const b of BREWING) if (b.input === input && b.ingredient === ingredient) return b.result;
  return 0;
}

/** Total number of recipes, for the debug screen. */
export function recipeCount() {
  return CRAFTING.length + SHAPELESS.length + FURNACE.size + BLAST.size + SMOKER.size + CAMPFIRE.size + STONECUTTER.size + SMITHING.length + BREWING.length;
}

/** Build a display stack for a recipe result. */
export function resultStack(recipe) {
  return new ItemStack(recipe.result, recipe.count || 1);
}

/** Everything craftable from one ingredient (used by the recipe book). */
export function recipesUsing(itemIdNum) {
  const out = [];
  for (const r of CRAFTING) if (r.ing.includes(itemIdNum)) out.push(r);
  for (const r of SHAPELESS) if (r.ing.includes(itemIdNum)) out.push(r);
  return out;
}

export default CRAFTING;
