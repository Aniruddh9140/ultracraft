/**
 * Ultracraft - block registry.
 *
 * Blocks are referenced by numeric id (Uint16 in chunk storage). Every block
 * additionally carries an 8-bit "meta" nibble used for orientation / variant /
 * growth stage / redstone power, exactly like classic block states but cheap.
 *
 * This module is dependency free so it can be imported inside web workers.
 */

export const AIR = 0;

/** Collision / render shapes handled by the mesher + physics. */
export const Shape = {
  CUBE: 0,      // full 1x1x1 cube
  SLAB: 1,      // half cube (meta bit 3 = top)
  STAIRS: 2,    // stair block (meta: 0-3 facing, bit2 = top half)
  CROSS: 3,     // X-shaped plant (no collision)
  TORCH: 4,     // small centred stick
  FENCE: 5,     // post + connecting bars
  PANE: 6,      // thin connecting pane
  DOOR: 7,      // 3/16 thick door (meta bit3 = upper)
  TRAPDOOR: 8,  // 3/16 thick horizontal/vertical hatch
  LIQUID: 9,    // fluid with surface height from meta
  CACTUS: 10,   // 14/16 wide cube
  FARMLAND: 11, // 15/16 tall soil
  PATH: 12,     // grass path (15/16)
  CROP: 13,     // cross with height from meta (age)
  PLATE: 14,    // 1/16 pressure plate
  CARPET: 15,   // 1/16 carpet
  LADDER: 16,   // flat climbing surface on a wall (meta = facing)
  CHEST: 17,    // 14/16 cube with facing
  FURNACE: 18,  // full cube with directional front
  BUTTON: 19,   // tiny wall/button
  LEVER: 20,    // small lever
  BED: 21,      // 9/16 tall bed (meta bit3 = head)
  WALL: 22,     // cobblestone-style wall
  GATE: 23,     // fence gate
  ANVIL: 24,    // anvil
  SKULL: 25,    // mob head / pumpkin on a stick
  PORTAL: 26,   // nether portal (animated emissive)
  EMPTY: 27,    // no geometry at all (air, structure blocks)
};

/** Render pass a block's geometry belongs to. */
export const Pass = { OPAQUE: 0, CUTOUT: 1, TRANSLUCENT: 2, LIQUID: 3 };

const blocks = [];
const byName = new Map();

const DEFAULTS = {
  label: null,
  shape: Shape.CUBE,
  pass: Pass.OPAQUE,
  tex: null,             // { all | top,bottom,side | front,side,top,... }
  solid: true,           // entities collide with it
  opaque: true,          // full opaque cube: blocks light + neighbour face culling
  light: 0,              // emitted light level 0-15
  absorb: 15,            // light absorbed when passing through
  hardness: 1,           // seconds-ish base mining time
  tool: null,            // 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'shears' | 'sword'
  tier: 0,               // minimum tool tier required to drop anything
  drop: undefined,       // item id string | null (nothing) | {item,min,max,chance}
  drops: null,           // array form for multi-drops
  entity: null,          // 'chest' | 'furnace' | 'spawner' | 'bed' | 'jukebox'
  gravity: false,        // falling block (sand, gravel, concrete powder)
  flammable: 0,          // 0..100 catch chance
  burnTime: 0,           // furnace fuel value in ticks (200 = 1 item smelt)
  mat: null,             // {rough, metal, emis, spec}
  flow: 0,               // liquid flow speed (0 = not a liquid)
  viscosity: 0,
  slipperiness: 0.6,     // ice = 0.98
  jump: 1,               // upward velocity multiplier
  speed: 1,              // movement speed multiplier
  wet: false,            // is a water source (bucket)
  climbable: false,
  bonemeal: false,       // bonemeal target
  silk: false,           // silk-touch gives the block, otherwise `drop`
  replaceable: false,    // can be placed over (air, grass, water, snow layer)
  tick: 0,               // random tick weight
  blastResist: 3,
  sound: 'stone',
  interact: null,        // name of an interaction handler in the game layer
  hardnessFn: null,
};

export function defineBlock(name, opts = {}) {
  const b = Object.assign({}, DEFAULTS, opts);
  b.id = blocks.length;
  b.name = name;
  b.label = b.label || prettify(name);
  if (b.light > 0) b.emis = b.light / 15;
  blocks.push(b);
  byName.set(name, b);
  return b;
}

function prettify(s) {
  return s.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ---------------------------------------------------------------------------
// Air (must be id 0)
// ---------------------------------------------------------------------------
defineBlock('air', { shape: Shape.EMPTY, solid: false, opaque: false, absorb: 0, hardness: 0, replaceable: true, sound: 'none' });

// ---------------------------------------------------------------------------
// Stone family
// ---------------------------------------------------------------------------
defineBlock('stone', { tex: { all: 'stone' }, hardness: 1.5, tool: 'pickaxe', drop: 'cobblestone', blastResist: 6, mat: { rough: 0.95, metal: 0, spec: 0.06 } });
defineBlock('cobblestone', { tex: { all: 'cobblestone' }, hardness: 2, tool: 'pickaxe', blastResist: 6 });
defineBlock('mossy_cobblestone', { tex: { all: 'mossy_cobblestone' }, hardness: 2, tool: 'pickaxe', blastResist: 6 });
defineBlock('stone_bricks', { tex: { all: 'stone_bricks' }, hardness: 1.5, tool: 'pickaxe', blastResist: 6 });
defineBlock('cracked_stone_bricks', { tex: { all: 'cracked_stone_bricks' }, hardness: 1.5, tool: 'pickaxe' });
defineBlock('mossy_stone_bricks', { tex: { all: 'mossy_stone_bricks' }, hardness: 1.5, tool: 'pickaxe' });
defineBlock('chiseled_stone_bricks', { tex: { all: 'chiseled_stone_bricks' }, hardness: 1.5, tool: 'pickaxe' });
defineBlock('smooth_stone', { tex: { all: 'smooth_stone' }, hardness: 1.5, tool: 'pickaxe' });
defineBlock('granite', { tex: { all: 'granite' }, hardness: 1.5, tool: 'pickaxe' });
defineBlock('polished_granite', { tex: { all: 'polished_granite' }, hardness: 1.5, tool: 'pickaxe' });
defineBlock('diorite', { tex: { all: 'diorite' }, hardness: 1.5, tool: 'pickaxe' });
defineBlock('polished_diorite', { tex: { all: 'polished_diorite' }, hardness: 1.5, tool: 'pickaxe' });
defineBlock('andesite', { tex: { all: 'andesite' }, hardness: 1.5, tool: 'pickaxe' });
defineBlock('polished_andesite', { tex: { all: 'polished_andesite' }, hardness: 1.5, tool: 'pickaxe' });
defineBlock('deepslate', { tex: { all: 'deepslate', top: 'deepslate_top' }, hardness: 3, tool: 'pickaxe', tier: 1, drop: 'cobbled_deepslate' });
defineBlock('cobbled_deepslate', { tex: { all: 'cobbled_deepslate' }, hardness: 3.5, tool: 'pickaxe', tier: 1 });
defineBlock('tuff', { tex: { all: 'tuff' }, hardness: 1.5, tool: 'pickaxe' });
defineBlock('calcite', { tex: { all: 'calcite' }, hardness: 0.75, tool: 'pickaxe' });
defineBlock('bedrock', { tex: { all: 'bedrock' }, hardness: -1, blastResist: 3600000 });
defineBlock('obsidian', { tex: { all: 'obsidian' }, hardness: 50, tool: 'pickaxe', tier: 3, blastResist: 1200, mat: { rough: 0.25, metal: 0.1, spec: 0.6 } });
defineBlock('netherrack', { tex: { all: 'netherrack' }, hardness: 0.4, tool: 'pickaxe', flammable: 0 });
defineBlock('blackstone', { tex: { all: 'blackstone', top: 'blackstone_top' }, hardness: 1.5, tool: 'pickaxe' });
defineBlock('basalt', { tex: { all: 'basalt', top: 'basalt_top' }, hardness: 1.25, tool: 'pickaxe' });
defineBlock('magma_block', { tex: { all: 'magma' }, hardness: 0.5, tool: 'pickaxe', light: 3 });
defineBlock('end_stone', { tex: { all: 'end_stone' }, hardness: 3, tool: 'pickaxe', tier: 1, blastResist: 9 });
defineBlock('end_stone_bricks', { tex: { all: 'end_stone_bricks' }, hardness: 3, tool: 'pickaxe', tier: 1 });
defineBlock('purpur_block', { tex: { all: 'purpur_block' }, hardness: 1.5, tool: 'pickaxe' });
defineBlock('purpur_pillar', { tex: { all: 'purpur_pillar', top: 'purpur_pillar_top' }, hardness: 1.5, tool: 'pickaxe' });
defineBlock('nether_bricks', { tex: { all: 'nether_bricks' }, hardness: 2, tool: 'pickaxe', blastResist: 6 });
defineBlock('red_nether_bricks', { tex: { all: 'red_nether_bricks' }, hardness: 2, tool: 'pickaxe' });
defineBlock('quartz_block', { tex: { all: 'quartz_block' }, hardness: 0.8, tool: 'pickaxe' });
defineBlock('chiseled_quartz_block', { tex: { all: 'chiseled_quartz' }, hardness: 0.8, tool: 'pickaxe' });
defineBlock('quartz_pillar', { tex: { all: 'quartz_pillar', top: 'quartz_pillar_top' }, hardness: 0.8, tool: 'pickaxe' });
defineBlock('nether_wart_block', { tex: { all: 'nether_wart_block' }, hardness: 1, tool: 'hoe' });
defineBlock('shroomlight', { tex: { all: 'shroomlight' }, hardness: 1, tool: 'hoe', light: 15 });

// ---------------------------------------------------------------------------
// Ores & mineral blocks
// ---------------------------------------------------------------------------
const oreList = [
  ['coal_ore', 'coal', 3, 0, 1],
  ['iron_ore', null, 3, 1, 1],
  ['gold_ore', null, 3, 2, 1],
  ['diamond_ore', 'diamond', 3, 2, 1],
  ['emerald_ore', 'emerald', 3, 2, 1],
  ['lapis_ore', null, 3, 1, 1],
  ['redstone_ore', null, 3, 2, 1],
  ['copper_ore', null, 3, 1, 1],
  ['nether_quartz_ore', 'quartz', 3, 0, 1],
  ['nether_gold_ore', null, 3, 0, 1],
];
for (const [name, drop, hard, tier, xp] of oreList) {
  const deep = !name.startsWith('nether');
  defineBlock(name, {
    tex: { all: name }, hardness: hard, tool: 'pickaxe', tier,
    drop: drop ? { item: drop, min: 1, max: 1 } : null,
    dropSelf: !drop, xp,
  });
  if (deep) {
    defineBlock('deepslate_' + name.replace('nether_', ''), {
      tex: { all: 'deepslate_' + name.replace('nether_', '') }, hardness: hard + 1.5, tool: 'pickaxe', tier,
      drop: drop ? { item: drop, min: 1, max: 1 } : null,
      dropSelf: !drop, xp,
    });
  }
}
// Simplify: deepslate variants for overworld ores only
['coal', 'iron', 'gold', 'diamond', 'emerald', 'lapis', 'redstone', 'copper'].forEach((o) => {
  defineBlock('deepslate_' + o + '_ore', {
    tex: { all: 'deepslate_' + o + '_ore' }, hardness: 4.5, tool: 'pickaxe', tier: 1, drop: null, dropSelf: true, xp: 1,
  });
});

const mineralBlocks = [
  ['coal_block', 5, 8000], ['iron_block', 5, 6], ['gold_block', 3, 6], ['diamond_block', 5, 6],
  ['emerald_block', 5, 6], ['lapis_block', 3, 6], ['redstone_block', 5, 6], ['copper_block', 5, 6],
  ['netherite_block', 5, 6], ['slime_block', 0, 0], ['amethyst_block', 5, 6],
];
for (const [name, hard, resist] of mineralBlocks) {
  defineBlock(name, {
    tex: { all: name }, hardness: hard, tool: 'pickaxe', tier: name === 'gold_block' ? 1 : 2,
    blastResist: resist || 6,
    mat: /block$/.test(name) && !/coal|lapis|redstone|slime|amethyst/.test(name)
      ? { rough: 0.15, metal: 1, spec: 0.9 } : { rough: 0.6, metal: 0.2, spec: 0.3 },
  });
}
defineBlock('redstone_block', { tex: { all: 'redstone_block' }, hardness: 5, tool: 'pickaxe', tier: 2, mat: { rough: 0.4, metal: 0.3, spec: 0.4 } });
defineBlock('slime_block', { tex: { all: 'slime_block' }, hardness: 0, mat: { rough: 0.1, metal: 0, spec: 0.7 }, slipperiness: 0.8, jump: 0.6, pass: Pass.TRANSLUCENT, opaque: false, absorb: 1 });

// ---------------------------------------------------------------------------
// Dirt / grass / sand / gravel
// ---------------------------------------------------------------------------
defineBlock('dirt', { tex: { all: 'dirt' }, hardness: 0.5, tool: 'shovel', sound: 'grass' });
defineBlock('coarse_dirt', { tex: { all: 'coarse_dirt' }, hardness: 0.5, tool: 'shovel', sound: 'grass' });
defineBlock('rooted_dirt', { tex: { all: 'rooted_dirt' }, hardness: 0.5, tool: 'shovel', sound: 'grass' });
defineBlock('podzol', { tex: { top: 'podzol_top', side: 'podzol_side', bottom: 'dirt' }, hardness: 0.5, tool: 'shovel', sound: 'grass' });
defineBlock('mycelium', { tex: { top: 'mycelium_top', side: 'mycelium_side', bottom: 'dirt' }, hardness: 0.6, tool: 'shovel', sound: 'grass' });
defineBlock('grass_block', { tex: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' }, hardness: 0.6, tool: 'shovel', drop: 'dirt', sound: 'grass', tick: 8, bonemeal: true });
defineBlock('snow_block', { tex: { all: 'snow' }, hardness: 0.2, tool: 'shovel', drop: 'snowball', dropMin: 4, dropMax: 4, mat: { rough: 0.7, metal: 0, spec: 0.35 } });
defineBlock('snow_layer', { tex: { all: 'snow' }, shape: Shape.CARPET, solid: false, opaque: false, absorb: 0, hardness: 0.05, tool: 'shovel', drop: 'snowball', replaceable: true, mat: { rough: 0.7, spec: 0.35 } });
defineBlock('sand', { tex: { all: 'sand' }, hardness: 0.5, tool: 'shovel', gravity: true, sound: 'sand' });
defineBlock('red_sand', { tex: { all: 'red_sand' }, hardness: 0.5, tool: 'shovel', gravity: true, sound: 'sand' });
defineBlock('gravel', { tex: { all: 'gravel' }, hardness: 0.6, tool: 'shovel', gravity: true, drop: { item: 'flint', min: 1, max: 1, chance: 0.1, fallback: 'gravel' }, sound: 'gravel' });
defineBlock('clay', { tex: { all: 'clay' }, hardness: 0.6, tool: 'shovel', drop: { item: 'clay_ball', min: 4, max: 4 } });
defineBlock('sandstone', { tex: { top: 'sandstone_top', bottom: 'sandstone_top', side: 'sandstone' }, hardness: 0.8, tool: 'pickaxe' });
defineBlock('red_sandstone', { tex: { top: 'red_sandstone_top', bottom: 'red_sandstone_top', side: 'red_sandstone' }, hardness: 0.8, tool: 'pickaxe' });
defineBlock('ice', { tex: { all: 'ice' }, hardness: 0.5, tool: 'pickaxe', slipperiness: 0.98, pass: Pass.TRANSLUCENT, opaque: false, absorb: 2, mat: { rough: 0.08, metal: 0, spec: 1 } });
defineBlock('packed_ice', { tex: { all: 'packed_ice' }, hardness: 0.5, tool: 'pickaxe', slipperiness: 0.98, mat: { rough: 0.1, spec: 0.8 } });
defineBlock('blue_ice', { tex: { all: 'blue_ice' }, hardness: 2.8, tool: 'pickaxe', slipperiness: 0.989, mat: { rough: 0.1, spec: 0.8 } });
defineBlock('soul_sand', { tex: { all: 'soul_sand' }, hardness: 0.5, tool: 'shovel', speed: 0.4, mat: { rough: 1 } });
defineBlock('soul_soil', { tex: { all: 'soul_soil' }, hardness: 0.5, tool: 'shovel' });
defineBlock('moss_block', { tex: { all: 'moss_block' }, hardness: 0.1, tool: 'hoe' });
defineBlock('grass_path', { tex: { top: 'grass_path_top', side: 'grass_path_side', bottom: 'dirt' }, shape: Shape.PATH, hardness: 0.6, tool: 'shovel', drop: 'dirt' });
defineBlock('farmland', { tex: { top: 'farmland', side: 'dirt', bottom: 'dirt' }, shape: Shape.FARMLAND, hardness: 0.6, tool: 'shovel', drop: 'dirt', absorb: 15, tick: 4 });
defineBlock('sponge', { tex: { all: 'sponge' }, hardness: 0.6 });
defineBlock('wet_sponge', { tex: { all: 'wet_sponge' }, hardness: 0.6 });
defineBlock('cobweb', { tex: { all: 'cobweb' }, shape: Shape.CROSS, solid: false, opaque: false, absorb: 1, hardness: 4, tool: 'sword', drop: 'string', pass: Pass.CUTOUT, speed: 0.25 });

// ---------------------------------------------------------------------------
// Wood: logs, planks, leaves, saplings
// ---------------------------------------------------------------------------
const woods = [
  ['oak', 0x6b4f2a], ['spruce', 0x4a3018], ['birch', 0xc8b18a], ['jungle', 0x5a4322],
  ['acacia', 0x9c5a35], ['dark_oak', 0x3d2a17], ['crimson', 0x6a3a52], ['warped', 0x2b6b66],
];
for (const [w] of woods) {
  defineBlock(w + '_log', { tex: { all: w + '_log', top: w + '_log_top' }, hardness: 2, tool: 'axe', flammable: 5, burnTime: 300, mat: { rough: 0.9 } });
  defineBlock(w + '_wood', { tex: { all: w + '_log' }, hardness: 2, tool: 'axe', flammable: 5, burnTime: 300 });
  defineBlock('stripped_' + w + '_log', { tex: { all: 'stripped_' + w + '_log', top: 'stripped_' + w + '_log_top' }, hardness: 2, tool: 'axe', flammable: 5, burnTime: 300 });
  defineBlock(w + '_planks', { tex: { all: w + '_planks' }, hardness: 2, tool: 'axe', flammable: 20, burnTime: 300, mat: { rough: 0.85 } });
  defineBlock(w + '_leaves', {
    tex: { all: w + '_leaves' }, hardness: 0.2, pass: Pass.CUTOUT, opaque: false, absorb: 1,
    flammable: 60, drop: null, drops: [
      { item: w + '_sapling', min: 1, max: 1, chance: 0.05, tool: null },
      { item: 'stick', min: 1, max: 2, chance: 0.02, tool: null },
      { item: 'apple', min: 1, max: 1, chance: 0.005, tool: null },
    ], mat: { rough: 1 },
  });
  defineBlock(w + '_sapling', {
    tex: { all: w + '_sapling' }, shape: Shape.CROSS, solid: false, opaque: false, absorb: 0,
    hardness: 0, replaceable: true, pass: Pass.CUTOUT, tick: 12, bonemeal: true, drop: w + '_sapling',
  });
  defineBlock(w + '_slab', { tex: { all: w + '_planks' }, shape: Shape.SLAB, hardness: 2, tool: 'axe', flammable: 20, burnTime: 150, opaque: false, absorb: 0 });
  defineBlock(w + '_stairs', { tex: { all: w + '_planks' }, shape: Shape.STAIRS, hardness: 2, tool: 'axe', flammable: 20, burnTime: 150, opaque: false, absorb: 0 });
  defineBlock(w + '_fence', { tex: { all: w + '_planks' }, shape: Shape.FENCE, hardness: 2, tool: 'axe', flammable: 20, burnTime: 300, opaque: false, absorb: 0, height: 1.5 });
  defineBlock(w + '_fence_gate', { tex: { all: w + '_planks' }, shape: Shape.GATE, hardness: 2, tool: 'axe', flammable: 20, burnTime: 300, opaque: false, absorb: 0, height: 1.5, interact: 'fence_gate' });
  defineBlock(w + '_door', { tex: { all: w + '_door' }, shape: Shape.DOOR, hardness: 3, tool: 'axe', opaque: false, absorb: 0, pass: Pass.CUTOUT, interact: 'door', drop: w + '_door' });
  defineBlock(w + '_trapdoor', { tex: { all: w + '_trapdoor' }, shape: Shape.TRAPDOOR, hardness: 3, tool: 'axe', opaque: false, absorb: 0, pass: Pass.CUTOUT, interact: 'trapdoor' });
  defineBlock(w + '_button', { tex: { all: w + '_planks' }, shape: Shape.BUTTON, hardness: 0.5, solid: false, opaque: false, absorb: 0, interact: 'button', drop: w + '_button' });
  defineBlock(w + '_pressure_plate', { tex: { all: w + '_planks' }, shape: Shape.PLATE, hardness: 0.5, solid: false, opaque: false, absorb: 0, interact: 'pressure_plate', drop: w + '_pressure_plate' });
  defineBlock(w + '_sign', { tex: { all: w + '_planks' }, shape: Shape.EMPTY, hardness: 1, tool: 'axe', solid: false, opaque: false, absorb: 0, entity: 'sign', interact: 'sign' });
  defineBlock(w + '_bed', { tex: { all: w + '_bed' }, shape: Shape.BED, hardness: 0.2, solid: false, opaque: false, absorb: 0, entity: 'bed', interact: 'bed', drop: w + '_bed' });
}
// Beds share one texture family; keep the first 6 colours distinct
const bedTex = { oak: 'bed_red', spruce: 'bed_blue', birch: 'bed_white', jungle: 'bed_green', acacia: 'bed_yellow', dark_oak: 'bed_black', crimson: 'bed_purple', warped: 'bed_cyan' };
for (const [w, t] of Object.entries(bedTex)) byName.get(w + '_bed').tex = { all: t };

// ---------------------------------------------------------------------------
// Plants
// ---------------------------------------------------------------------------
defineBlock('short_grass', { tex: { all: 'short_grass' }, shape: Shape.CROSS, solid: false, opaque: false, absorb: 0, hardness: 0, replaceable: true, pass: Pass.CUTOUT, flammable: 60, drop: null, bonemeal: true });
defineBlock('fern', { tex: { all: 'fern' }, shape: Shape.CROSS, solid: false, opaque: false, absorb: 0, hardness: 0, replaceable: true, pass: Pass.CUTOUT, flammable: 60, drop: null });
defineBlock('dead_bush', { tex: { all: 'dead_bush' }, shape: Shape.CROSS, solid: false, opaque: false, absorb: 0, hardness: 0, replaceable: true, pass: Pass.CUTOUT, flammable: 60, drop: 'stick' });
defineBlock('seagrass', { tex: { all: 'seagrass' }, shape: Shape.CROSS, solid: false, opaque: false, absorb: 0, hardness: 0, replaceable: true, pass: Pass.CUTOUT, drop: null });
const flowers = ['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose'];
for (const f of flowers) {
  defineBlock(f, { tex: { all: f }, shape: Shape.CROSS, solid: false, opaque: false, absorb: 0, hardness: 0, replaceable: true, pass: Pass.CUTOUT, drop: f, flammable: 60, bonemeal: true });
}
defineBlock('sunflower', { tex: { all: 'sunflower' }, shape: Shape.CROSS, solid: false, opaque: false, absorb: 0, hardness: 0, replaceable: true, pass: Pass.CUTOUT, drop: 'sunflower' });
defineBlock('brown_mushroom', { tex: { all: 'brown_mushroom' }, shape: Shape.CROSS, solid: false, opaque: false, absorb: 0, hardness: 0, replaceable: true, pass: Pass.CUTOUT, drop: 'brown_mushroom', light: 1 });
defineBlock('red_mushroom', { tex: { all: 'red_mushroom' }, shape: Shape.CROSS, solid: false, opaque: false, absorb: 0, hardness: 0, replaceable: true, pass: Pass.CUTOUT, drop: 'red_mushroom' });
defineBlock('mushroom_stem', { tex: { all: 'mushroom_stem' }, hardness: 0.2, tool: 'axe' });
defineBlock('brown_mushroom_block', { tex: { all: 'brown_mushroom_block' }, hardness: 0.2, tool: 'axe' });
defineBlock('red_mushroom_block', { tex: { all: 'red_mushroom_block' }, hardness: 0.2, tool: 'axe' });
defineBlock('sugar_cane', { tex: { all: 'sugar_cane' }, shape: Shape.CROSS, solid: false, opaque: false, absorb: 0, hardness: 0, replaceable: true, pass: Pass.CUTOUT, tick: 8, drop: 'sugar_cane' });
defineBlock('cactus', { tex: { all: 'cactus_side', top: 'cactus_top' }, shape: Shape.CACTUS, hardness: 0.4, pass: Pass.CUTOUT, opaque: false, absorb: 0, damage: 1, drop: 'cactus' });
defineBlock('vine', { tex: { all: 'vine' }, shape: Shape.CROSS, solid: false, opaque: false, absorb: 0, hardness: 0.2, replaceable: true, pass: Pass.CUTOUT, climbable: true, flammable: 15, drop: 'vine' });
defineBlock('lily_pad', { tex: { all: 'lily_pad' }, shape: Shape.CARPET, solid: false, opaque: false, absorb: 0, hardness: 0, pass: Pass.CUTOUT, drop: 'lily_pad' });
defineBlock('sweet_berry_bush', { tex: { all: 'sweet_berry_bush' }, shape: Shape.CROSS, solid: false, opaque: false, absorb: 0, hardness: 0, pass: Pass.CUTOUT, damage: 0.5, drop: 'sweet_berries' });
defineBlock('bamboo', { tex: { all: 'bamboo' }, shape: Shape.CROSS, solid: false, opaque: false, absorb: 0, hardness: 1, pass: Pass.CUTOUT, tick: 4, drop: 'bamboo' });
defineBlock('nether_wart', { tex: { all: 'nether_wart0' }, stageTex: 'nether_wart', maxAge: 2, shape: Shape.CROP, solid: false, opaque: false, absorb: 0, hardness: 0, pass: Pass.CUTOUT, drop: 'nether_wart' });

// ---------------------------------------------------------------------------
// Crops (meta = age 0..7)
// ---------------------------------------------------------------------------
defineBlock('wheat_crop', { tex: { all: 'wheat0' }, stageTex: 'wheat', maxAge: 7, shape: Shape.CROP, solid: false, opaque: false, absorb: 0, hardness: 0, replaceable: true, pass: Pass.CUTOUT, tick: 6, drop: null, mature: 'wheat' });
defineBlock('carrot_crop', { tex: { all: 'carrot0' }, stageTex: 'carrot', maxAge: 3, shape: Shape.CROP, solid: false, opaque: false, absorb: 0, hardness: 0, replaceable: true, pass: Pass.CUTOUT, tick: 6, drop: null, mature: 'carrot' });
defineBlock('potato_crop', { tex: { all: 'potato0' }, stageTex: 'potato', maxAge: 3, shape: Shape.CROP, solid: false, opaque: false, absorb: 0, hardness: 0, replaceable: true, pass: Pass.CUTOUT, tick: 6, drop: null, mature: 'potato' });
defineBlock('beetroot_crop', { tex: { all: 'beetroot0' }, stageTex: 'beetroot', maxAge: 3, shape: Shape.CROP, solid: false, opaque: false, absorb: 0, hardness: 0, replaceable: true, pass: Pass.CUTOUT, tick: 6, drop: null, mature: 'beetroot' });
defineBlock('melon_stem', { tex: { all: 'melon_stem' }, shape: Shape.CROP, solid: false, opaque: false, absorb: 0, hardness: 0, pass: Pass.CUTOUT, tick: 6, drop: 'melon_seeds' });
defineBlock('pumpkin_stem', { tex: { all: 'pumpkin_stem' }, shape: Shape.CROP, solid: false, opaque: false, absorb: 0, hardness: 0, pass: Pass.CUTOUT, tick: 6, drop: 'pumpkin_seeds' });

// ---------------------------------------------------------------------------
// Gourds, food blocks
// ---------------------------------------------------------------------------
defineBlock('pumpkin', { tex: { top: 'pumpkin_top', side: 'pumpkin_side' }, hardness: 1, tool: 'axe' });
defineBlock('carved_pumpkin', { tex: { top: 'pumpkin_top', side: 'carved_pumpkin_side', front: 'pumpkin_face' }, hardness: 1, tool: 'axe' });
defineBlock('jack_o_lantern', { tex: { top: 'pumpkin_top', side: 'jack_o_lantern_side', front: 'pumpkin_face' }, hardness: 1, tool: 'axe', light: 15 });
defineBlock('melon', { tex: { top: 'melon_top', side: 'melon_side' }, hardness: 1, tool: 'axe', drop: { item: 'melon_slice', min: 3, max: 7 } });
defineBlock('hay_block', { tex: { all: 'hay_block', top: 'hay_block_top' }, hardness: 0.5, flammable: 60 });
defineBlock('cake', { tex: { all: 'cake_top', side: 'cake_side', bottom: 'cake_bottom' }, shape: Shape.SLAB, hardness: 0.5, opaque: false, absorb: 0, interact: 'cake' });

// ---------------------------------------------------------------------------
// Wool / carpet / concrete / terracotta / glass
// ---------------------------------------------------------------------------
const colors = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
for (const c of colors) {
  defineBlock(c + '_wool', { tex: { all: 'wool_' + c }, hardness: 0.8, flammable: 30, mat: { rough: 1 } });
  defineBlock(c + '_carpet', { tex: { all: 'wool_' + c }, shape: Shape.CARPET, solid: false, opaque: false, absorb: 0, hardness: 0.1, flammable: 60, mat: { rough: 1 } });
  defineBlock(c + '_concrete', { tex: { all: 'concrete_' + c }, hardness: 1.8, tool: 'pickaxe', mat: { rough: 0.5, spec: 0.2 } });
  defineBlock(c + '_concrete_powder', { tex: { all: 'concrete_powder_' + c }, hardness: 0.5, tool: 'shovel', gravity: true });
  defineBlock(c + '_terracotta', { tex: { all: 'terracotta_' + c }, hardness: 1.25, tool: 'pickaxe' });
  defineBlock(c + '_glazed_terracotta', { tex: { all: 'glazed_terracotta_' + c }, hardness: 1.4, tool: 'pickaxe', mat: { rough: 0.2, spec: 0.7 } });
  defineBlock(c + '_stained_glass', { tex: { all: 'glass_' + c }, hardness: 0.3, pass: Pass.TRANSLUCENT, opaque: false, absorb: 0, mat: { rough: 0.05, spec: 0.9 } });
  defineBlock(c + '_stained_glass_pane', { tex: { all: 'glass_' + c }, shape: Shape.PANE, hardness: 0.3, pass: Pass.TRANSLUCENT, opaque: false, absorb: 0, mat: { rough: 0.05, spec: 0.9 } });
  defineBlock(c + '_shulker_box', { tex: { all: 'shulker_' + c }, hardness: 2, tool: 'pickaxe', entity: 'chest', interact: 'container' });
}
defineBlock('terracotta', { tex: { all: 'terracotta' }, hardness: 1.25, tool: 'pickaxe' });
defineBlock('glass', { tex: { all: 'glass' }, hardness: 0.3, pass: Pass.TRANSLUCENT, opaque: false, absorb: 0, mat: { rough: 0.03, spec: 1 }, silk: true, drop: null });
defineBlock('glass_pane', { tex: { all: 'glass' }, shape: Shape.PANE, hardness: 0.3, pass: Pass.TRANSLUCENT, opaque: false, absorb: 0, mat: { rough: 0.03, spec: 1 }, silk: true, drop: null });
defineBlock('tinted_glass', { tex: { all: 'tinted_glass' }, hardness: 0.3, pass: Pass.TRANSLUCENT, opaque: false, absorb: 15 });
defineBlock('sea_lantern', { tex: { all: 'sea_lantern' }, hardness: 0.3, light: 15, mat: { rough: 0.2, spec: 0.7 } });
defineBlock('glowstone', { tex: { all: 'glowstone' }, hardness: 0.3, light: 15, drop: { item: 'glowstone_dust', min: 2, max: 4 } });
defineBlock('lantern', { tex: { all: 'lantern' }, shape: Shape.TORCH, hardness: 3.5, tool: 'pickaxe', light: 15, solid: false, opaque: false, absorb: 0, mat: { rough: 0.3, metal: 0.6, spec: 0.7 } });
defineBlock('campfire', { tex: { all: 'campfire' }, shape: Shape.SLAB, hardness: 2, tool: 'axe', light: 15, opaque: false, absorb: 0, damage: 1, interact: 'campfire' });
defineBlock('bookshelf', { tex: { all: 'bookshelf', top: 'oak_planks' }, hardness: 1.5, tool: 'axe', flammable: 30, burnTime: 300, drop: { item: 'book', min: 3, max: 3 } });

// ---------------------------------------------------------------------------
// Utility blocks
// ---------------------------------------------------------------------------
defineBlock('crafting_table', { tex: { top: 'crafting_table_top', side: 'crafting_table_side', front: 'crafting_table_front' }, shape: Shape.FURNACE, hardness: 2.5, tool: 'axe', flammable: 20, burnTime: 300, interact: 'crafting_table' });
defineBlock('furnace', { tex: { top: 'furnace_top', side: 'furnace_side', front: 'furnace_front' }, shape: Shape.FURNACE, hardness: 3.5, tool: 'pickaxe', interact: 'furnace', entity: 'furnace' });
defineBlock('blast_furnace', { tex: { top: 'blast_furnace_top', side: 'blast_furnace_side', front: 'blast_furnace_front' }, shape: Shape.FURNACE, hardness: 3.5, tool: 'pickaxe', interact: 'furnace', entity: 'furnace', light: 0 });
defineBlock('smoker', { tex: { top: 'smoker_top', side: 'smoker_side', front: 'smoker_front' }, shape: Shape.FURNACE, hardness: 3.5, tool: 'pickaxe', interact: 'furnace', entity: 'furnace' });
defineBlock('chest', { tex: { all: 'chest' }, shape: Shape.CHEST, hardness: 2.5, tool: 'axe', opaque: false, absorb: 0, entity: 'chest', interact: 'container', flammable: 20, burnTime: 300 });
defineBlock('trapped_chest', { tex: { all: 'trapped_chest' }, shape: Shape.CHEST, hardness: 2.5, tool: 'axe', opaque: false, absorb: 0, entity: 'chest', interact: 'container' });
defineBlock('ender_chest', { tex: { all: 'ender_chest' }, shape: Shape.CHEST, hardness: 22.5, tool: 'pickaxe', tier: 2, opaque: false, absorb: 0, entity: 'ender_chest', interact: 'ender_chest', light: 7 });
defineBlock('barrel', { tex: { all: 'barrel' }, hardness: 2.5, tool: 'axe', entity: 'chest', interact: 'container' });
defineBlock('jukebox', { tex: { all: 'jukebox_side', top: 'jukebox_top' }, hardness: 2, tool: 'axe', entity: 'jukebox', interact: 'jukebox' });
defineBlock('note_block', { tex: { all: 'note_block' }, hardness: 0.8, tool: 'axe', interact: 'note_block' });
defineBlock('enchanting_table', { tex: { top: 'enchanting_table_top', side: 'enchanting_table_side', bottom: 'enchanting_table_bottom' }, shape: Shape.FARMLAND, hardness: 5, tool: 'pickaxe', tier: 2, interact: 'enchanting_table', light: 7, mat: { rough: 0.2, spec: 0.8 } });
defineBlock('anvil', { tex: { all: 'anvil', top: 'anvil_top' }, shape: Shape.ANVIL, hardness: 5, tool: 'pickaxe', tier: 2, gravity: false, opaque: false, absorb: 0, interact: 'anvil', mat: { rough: 0.3, metal: 1, spec: 0.7 } });
defineBlock('brewing_stand', { tex: { all: 'brewing_stand' }, shape: Shape.TORCH, hardness: 0.5, tool: 'pickaxe', solid: false, opaque: false, absorb: 0, entity: 'brewing', interact: 'brewing_stand', light: 1 });
defineBlock('cauldron', { tex: { all: 'cauldron' }, shape: Shape.EMPTY, hardness: 2, tool: 'pickaxe', solid: false, opaque: false, absorb: 0, entity: 'cauldron', interact: 'cauldron' });
defineBlock('beacon', { tex: { all: 'beacon' }, hardness: 3, pass: Pass.TRANSLUCENT, opaque: false, absorb: 0, light: 15, entity: 'beacon', interact: 'beacon', mat: { rough: 0.1, spec: 1 } });
defineBlock('tnt', { tex: { top: 'tnt_top', side: 'tnt_side', bottom: 'tnt_bottom' }, hardness: 0, interact: 'tnt', blastResist: 0, flammable: 100 });
defineBlock('ladder', { tex: { all: 'ladder' }, shape: Shape.LADDER, hardness: 0.4, tool: 'axe', solid: false, opaque: false, absorb: 0, climbable: true, pass: Pass.CUTOUT, flammable: 20, burnTime: 300 });
defineBlock('torch', { tex: { all: 'torch' }, shape: Shape.TORCH, hardness: 0, solid: false, opaque: false, absorb: 0, light: 14, pass: Pass.CUTOUT, drop: 'torch' });
defineBlock('wall_torch', { tex: { all: 'torch' }, shape: Shape.TORCH, hardness: 0, solid: false, opaque: false, absorb: 0, light: 14, pass: Pass.CUTOUT, drop: 'torch' });
defineBlock('soul_torch', { tex: { all: 'soul_torch' }, shape: Shape.TORCH, hardness: 0, solid: false, opaque: false, absorb: 0, light: 10, pass: Pass.CUTOUT, drop: 'soul_torch' });
defineBlock('redstone_torch', { tex: { all: 'redstone_torch' }, shape: Shape.TORCH, hardness: 0, solid: false, opaque: false, absorb: 0, light: 7, pass: Pass.CUTOUT, interact: 'redstone_torch' });
defineBlock('redstone_wall_torch', { tex: { all: 'redstone_torch' }, shape: Shape.TORCH, hardness: 0, solid: false, opaque: false, absorb: 0, light: 7, pass: Pass.CUTOUT });
defineBlock('redstone_lamp', { tex: { all: 'redstone_lamp' }, hardness: 0.3, interact: 'redstone_lamp' });
defineBlock('redstone_wire', { tex: { all: 'redstone_dust' }, shape: Shape.EMPTY, hardness: 0, solid: false, opaque: false, absorb: 0, pass: Pass.CUTOUT, drop: 'redstone', interact: 'redstone_wire' });
defineBlock('repeater', { tex: { all: 'repeater' }, shape: Shape.EMPTY, hardness: 0, solid: false, opaque: false, absorb: 0, pass: Pass.CUTOUT, drop: 'repeater', interact: 'repeater' });
defineBlock('comparator', { tex: { all: 'comparator' }, shape: Shape.EMPTY, hardness: 0, solid: false, opaque: false, absorb: 0, pass: Pass.CUTOUT, drop: 'comparator', interact: 'comparator' });
defineBlock('lever', { tex: { all: 'lever' }, shape: Shape.EMPTY, hardness: 0.5, solid: false, opaque: false, absorb: 0, pass: Pass.CUTOUT, drop: 'lever', interact: 'lever' });
defineBlock('stone_button', { tex: { all: 'stone' }, shape: Shape.EMPTY, hardness: 0.5, solid: false, opaque: false, absorb: 0, pass: Pass.CUTOUT, interact: 'button', drop: 'stone_button' });
defineBlock('stone_pressure_plate', { tex: { all: 'stone' }, shape: Shape.PLATE, hardness: 0.5, solid: false, opaque: false, absorb: 0, interact: 'pressure_plate', drop: 'stone_pressure_plate' });
defineBlock('light_weighted_pressure_plate', { tex: { all: 'gold_block' }, shape: Shape.PLATE, hardness: 0.5, solid: false, opaque: false, absorb: 0, interact: 'pressure_plate' });
defineBlock('heavy_weighted_pressure_plate', { tex: { all: 'iron_block' }, shape: Shape.PLATE, hardness: 0.5, solid: false, opaque: false, absorb: 0, interact: 'pressure_plate' });
defineBlock('observer', { tex: { all: 'observer' }, hardness: 3, tool: 'pickaxe', interact: 'observer' });
defineBlock('target', { tex: { all: 'target' }, hardness: 0.5, interact: 'target' });
defineBlock('daylight_detector', { tex: { all: 'daylight_detector', top: 'daylight_detector_top' }, hardness: 0.2, tool: 'axe', opaque: false, absorb: 0, interact: 'daylight_detector' });
defineBlock('rail', { tex: { all: 'rail' }, shape: Shape.PLATE, hardness: 0.7, tool: 'pickaxe', solid: false, opaque: false, absorb: 0, pass: Pass.CUTOUT, interact: 'rail', drop: 'rail' });
defineBlock('powered_rail', { tex: { all: 'powered_rail' }, shape: Shape.PLATE, hardness: 0.7, tool: 'pickaxe', solid: false, opaque: false, absorb: 0, pass: Pass.CUTOUT, interact: 'rail', drop: 'powered_rail' });
defineBlock('detector_rail', { tex: { all: 'detector_rail' }, shape: Shape.PLATE, hardness: 0.7, tool: 'pickaxe', solid: false, opaque: false, absorb: 0, pass: Pass.CUTOUT, interact: 'rail', drop: 'detector_rail' });
defineBlock('activator_rail', { tex: { all: 'activator_rail' }, shape: Shape.PLATE, hardness: 0.7, tool: 'pickaxe', solid: false, opaque: false, absorb: 0, pass: Pass.CUTOUT, interact: 'rail', drop: 'activator_rail' });
defineBlock('command_block', { tex: { all: 'command_block' }, hardness: -1, interact: 'command_block', opaque: true });
defineBlock('chain_command_block', { tex: { all: 'chain_command_block' }, hardness: -1, interact: 'command_block' });
defineBlock('repeating_command_block', { tex: { all: 'repeating_command_block' }, hardness: -1, interact: 'command_block' });
defineBlock('tripwire_hook', { tex: { all: 'tripwire_hook' }, shape: Shape.EMPTY, hardness: 0, solid: false, opaque: false, absorb: 0, pass: Pass.CUTOUT, interact: 'tripwire_hook' });
defineBlock('tripwire', { tex: { all: 'tripwire' }, shape: Shape.EMPTY, hardness: 0, solid: false, opaque: false, absorb: 0, pass: Pass.CUTOUT, drop: 'string' });
defineBlock('lightning_rod', { tex: { all: 'lightning_rod' }, shape: Shape.TORCH, hardness: 3, tool: 'pickaxe', solid: false, opaque: false, absorb: 0, pass: Pass.CUTOUT, interact: 'lightning_rod', mat: { rough: 0.2, metal: 1 } });
defineBlock('sculk_sensor', { tex: { all: 'sculk_sensor' }, shape: Shape.PLATE, hardness: 1.5, solid: false, opaque: false, absorb: 0, interact: 'sculk_sensor' });
defineBlock('piston', { tex: { all: 'piston_side', top: 'piston_top', bottom: 'piston_bottom' }, hardness: 1.5, opaque: false, absorb: 0, interact: 'piston' });
defineBlock('sticky_piston', { tex: { all: 'piston_side', top: 'piston_top_sticky', bottom: 'piston_bottom' }, hardness: 1.5, opaque: false, absorb: 0, interact: 'piston' });
defineBlock('piston_head', { tex: { all: 'piston_top' }, hardness: 1.5, opaque: false, absorb: 0, shape: Shape.EMPTY });
defineBlock('moving_piston', { shape: Shape.EMPTY, hardness: -1, solid: false, opaque: false, absorb: 0 });
defineBlock('hopper', { tex: { all: 'hopper' }, hardness: 3, tool: 'pickaxe', opaque: false, absorb: 0, entity: 'hopper', interact: 'container' });
defineBlock('dispenser', { tex: { all: 'dispenser', front: 'dispenser_front' }, hardness: 3.5, tool: 'pickaxe', shape: Shape.FURNACE, entity: 'chest', interact: 'container' });
defineBlock('dropper', { tex: { all: 'dropper', front: 'dropper_front' }, hardness: 3.5, tool: 'pickaxe', shape: Shape.FURNACE, entity: 'chest', interact: 'container' });
defineBlock('iron_bars', { tex: { all: 'iron_bars' }, shape: Shape.PANE, hardness: 5, tool: 'pickaxe', pass: Pass.CUTOUT, opaque: false, absorb: 0 });
defineBlock('iron_door', { tex: { all: 'iron_door' }, shape: Shape.DOOR, hardness: 5, tool: 'pickaxe', opaque: false, absorb: 0, pass: Pass.CUTOUT, interact: 'iron_door', drop: 'iron_door' });
defineBlock('iron_trapdoor', { tex: { all: 'iron_trapdoor' }, shape: Shape.TRAPDOOR, hardness: 5, tool: 'pickaxe', opaque: false, absorb: 0, interact: 'iron_trapdoor' });
defineBlock('chain', { tex: { all: 'chain' }, shape: Shape.CROSS, hardness: 5, tool: 'pickaxe', solid: false, opaque: false, absorb: 0, pass: Pass.CUTOUT });
defineBlock('scaffolding', { tex: { all: 'scaffolding' }, hardness: 0, solid: true, opaque: false, absorb: 0, climbable: true });
defineBlock('spawner', { tex: { all: 'spawner' }, hardness: 5, tool: 'pickaxe', pass: Pass.CUTOUT, opaque: false, absorb: 0, entity: 'spawner', drop: null });
defineBlock('end_portal_frame', { tex: { all: 'end_portal_frame', top: 'end_portal_frame_top' }, hardness: -1, light: 1, opaque: false, absorb: 0 });
defineBlock('dragon_egg', { tex: { all: 'dragon_egg' }, shape: Shape.SKULL, hardness: 3, tool: 'pickaxe', light: 1, opaque: false, absorb: 0 });
defineBlock('skeleton_skull', { tex: { all: 'skeleton_skull' }, shape: Shape.SKULL, hardness: 1, solid: false, opaque: false, absorb: 0 });
defineBlock('wither_skeleton_skull', { tex: { all: 'wither_skull' }, shape: Shape.SKULL, hardness: 1, solid: false, opaque: false, absorb: 0 });
defineBlock('zombie_head', { tex: { all: 'zombie_head' }, shape: Shape.SKULL, hardness: 1, solid: false, opaque: false, absorb: 0 });
defineBlock('player_head', { tex: { all: 'player_head' }, shape: Shape.SKULL, hardness: 1, solid: false, opaque: false, absorb: 0 });
defineBlock('creeper_head', { tex: { all: 'creeper_head' }, shape: Shape.SKULL, hardness: 1, solid: false, opaque: false, absorb: 0 });

// ---------------------------------------------------------------------------
// Liquids
// ---------------------------------------------------------------------------
defineBlock('water', {
  tex: { all: 'water' }, shape: Shape.LIQUID, pass: Pass.LIQUID, solid: false, opaque: false, absorb: 1,
  hardness: -1, flow: 4, wet: true, mat: { rough: 0.02, metal: 0.0, spec: 1 }, replaceable: true, sound: 'water',
});
defineBlock('lava', {
  tex: { all: 'lava' }, shape: Shape.LIQUID, pass: Pass.LIQUID, solid: false, opaque: false, absorb: 0,
  hardness: -1, flow: 8, light: 15, damage: 4, flammable: 100, mat: { rough: 0.6, emis: 1 }, replaceable: true, sound: 'lava',
});
defineBlock('fire', {
  tex: { all: 'fire' }, shape: Shape.CROSS, pass: Pass.CUTOUT,
  solid: false, opaque: false, absorb: 0, hardness: 0, replaceable: true,
  light: 15, damage: 1, tick: 2, mat: { emis: 1, rough: 1 }, sound: 'fire',
});

defineBlock('nether_portal', {
  tex: { all: 'nether_portal' }, shape: Shape.PORTAL, pass: Pass.TRANSLUCENT, solid: false, opaque: false, absorb: 0,
  hardness: -1, light: 11, mat: { emis: 1 }, interact: 'portal',
});
defineBlock('end_portal', {
  tex: { all: 'end_portal' }, shape: Shape.PORTAL, pass: Pass.TRANSLUCENT, solid: false, opaque: false, absorb: 0,
  hardness: -1, light: 15, mat: { emis: 1 }, interact: 'end_portal',
});

// ---------------------------------------------------------------------------
// Slabs / stairs / walls for stone family
// ---------------------------------------------------------------------------
const stoneTypes = [
  ['stone', 'stone'], ['cobblestone', 'cobblestone'], ['stone_bricks', 'stone_bricks'], ['mossy_cobblestone', 'mossy_cobblestone'],
  ['sandstone', 'sandstone'], ['red_sandstone', 'red_sandstone'], ['nether_bricks', 'nether_bricks'], ['quartz', 'quartz_block'],
  ['bricks', 'bricks'], ['polished_granite', 'polished_granite'], ['polished_andesite', 'polished_andesite'], ['polished_diorite', 'polished_diorite'],
  ['deepslate', 'deepslate'], ['cobbled_deepslate', 'cobbled_deepslate'], ['end_stone', 'end_stone'], ['blackstone', 'blackstone'],
  ['cut_copper', 'cut_copper'], ['mud_bricks', 'mud_bricks'], ['prismarine', 'prismarine'], ['dark_prismarine', 'dark_prismarine'],
];
for (const [n, t] of stoneTypes) {
  defineBlock(n + '_slab', { tex: { all: t }, shape: Shape.SLAB, hardness: 2, tool: 'pickaxe', opaque: false, absorb: 0, drop: n + '_slab' });
  defineBlock(n + '_stairs', { tex: { all: t }, shape: Shape.STAIRS, hardness: 2, tool: 'pickaxe', opaque: false, absorb: 0, drop: n + '_stairs' });
  defineBlock(n + '_wall', { tex: { all: t }, shape: Shape.WALL, hardness: 2, tool: 'pickaxe', opaque: false, absorb: 0, height: 1.5, drop: n + '_wall' });
}
defineBlock('bricks', { tex: { all: 'bricks' }, hardness: 2, tool: 'pickaxe' });
defineBlock('mud_bricks', { tex: { all: 'mud_bricks' }, hardness: 1.5, tool: 'pickaxe' });
defineBlock('prismarine', { tex: { all: 'prismarine' }, hardness: 1.5, tool: 'pickaxe' });
defineBlock('prismarine_bricks', { tex: { all: 'prismarine_bricks' }, hardness: 1.5, tool: 'pickaxe' });
defineBlock('dark_prismarine', { tex: { all: 'dark_prismarine' }, hardness: 1.5, tool: 'pickaxe' });
defineBlock('sea_lantern_bricks', { tex: { all: 'sea_lantern' }, hardness: 0.3, light: 15 });
defineBlock('cut_copper', { tex: { all: 'cut_copper' }, hardness: 3, tool: 'pickaxe', mat: { rough: 0.3, metal: 1, spec: 0.8 } });

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------
export const BLOCKS = blocks;
export const BLOCK_COUNT = blocks.length;
export const BLOCK = byName;
export const blockId = (name) => {
  const b = byName.get(name);
  return b ? b.id : 0;
};
export const getBlock = (id) => blocks[id] || blocks[0];
export const blockByName = (name) => byName.get(name) || blocks[0];
export const isAir = (id) => id === 0;
export const isOpaque = (id) => blocks[id].opaque;
export const isSolid = (id) => blocks[id].solid;
export const isLiquid = (id) => blocks[id].flow > 0;
export const isReplaceable = (id) => blocks[id].replaceable;

/** Total light a block lets through (15 = fully transparent). */
export function lightOpacity(id) { return blocks[id].absorb; }

export default blocks;
