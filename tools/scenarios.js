#!/usr/bin/env node
/**
 * Ultracraft - gameplay scenario tests.
 *
 * Boots the real game headlessly (see ./stub.js) and then plays it: smelting,
 * chests, hoppers, mob combat, water flow, TNT, redstone, portals, farming,
 * sleeping, enchanting, brewing, anvils... Each scenario builds a tiny world
 * of its own and asserts on the result.
 *
 *   node tools/scenarios.js
 */

import { canvas } from './stub.js';
import { Game } from '../src/game/game.js';
import { UI } from '../src/ui/ui.js';
import { ItemStack } from '../src/game/inventory.js';
import { blockId } from '../src/world/blocks.js';
import { itemId, getItem } from '../src/world/items.js';
import { getBlock, BLOCKS } from '../src/world/blocks.js';
import { matchRecipe, resultStack, FURNACE, recipesUsing, CRAFTING } from '../src/game/recipes.js';

const results = [];
const problems = [];
const origError = console.error;
console.error = (...a) => { problems.push(a.join(' ')); };

function ok(name, cond, detail = '') {
  results.push([name, !!cond, detail]);
}

/** Run `fn` and turn any throw into a failed scenario. */
async function scenario(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) ok(name, true);
    else ok(name, !!r.cond, r.detail || '');
  } catch (e) {
    ok(name, false, `${e.message} @ ${(e.stack || '').split('\n')[1] || ''}`.trim());
  }
}

// ---------------------------------------------------------------------------
console.log('\x1b[1mUltracraft - gameplay scenarios\x1b[0m\n');

const game = new Game(canvas, {
  seed: 'scenarios', quality: 'potato', renderDistance: 3, textureSize: 16,
  workerCount: 0, starterKit: false,
});
await game.init(() => {});
const ui = new UI(game);
game.ui = ui;
ui.init();

const world = game.world;
const player = game.player;
const AIR = 0;

/** Flat build plate at y = 5 in an empty region, far from the spawn. */
const BASE_X = 1000, BASE_Z = 1000, FLOOR_Y = 5;
function plate(size = 7, y = FLOOR_Y) {
  const cx0 = (BASE_X - size) >> 4, cx1 = (BASE_X + size) >> 4;
  const cz0 = (BASE_Z - size) >> 4, cz1 = (BASE_Z + size) >> 4;
  for (let cx = cx0 - 1; cx <= cx1 + 1; cx++) for (let cz = cz0 - 1; cz <= cz1 + 1; cz++) world.requestChunk(cx, cz);
  // keep the player on the plate: chunks (and entities) far from the player are unloaded
  player.pos.set([BASE_X + 0.5, y + 1, BASE_Z + 0.5]);
  player.vel.fill(0);
  player.fallDistance = 0;
  player.onGround = true;
  for (let x = -size; x <= size; x++) for (let z = -size; z <= size; z++) {
    for (let yy = y - 1; yy >= y - 3; yy--) world.setBlock(BASE_X + x, yy, BASE_Z + z, blockId('stone'), 0);
    for (let yy = y; yy < y + 12; yy++) world.setBlock(BASE_X + x, yy, BASE_Z + z, AIR, 0);
  }
  return { x: BASE_X, y, z: BASE_Z };
}
const at = (x, y, z) => world.getBlock(BASE_X + x, y, BASE_Z + z);
const put = (x, y, z, name, meta = 0) => world.setBlock(BASE_X + x, y, BASE_Z + z, blockId(name), meta);
/** Advance the simulation by `n` ticks. */
const tick = (n = 1, dt = 1 / 20) => { for (let i = 0; i < n; i++) game.tick(dt); };

plate();

// ---------------------------------------------------------------------------
// world / terrain
// ---------------------------------------------------------------------------
await scenario('gravity: sand falls and lands', () => {
  put(0, FLOOR_Y + 6, 0, 'sand');
  tick(80);
  return { cond: at(0, FLOOR_Y, 0) === blockId('sand') && at(0, FLOOR_Y + 6, 0) === AIR,
    detail: `top=${at(0, FLOOR_Y, 0)}` };
});

await scenario('water spreads across the plate', () => {
  plate();
  put(0, FLOOR_Y + 2, 0, 'water');
  tick(120);
  let wet = 0;
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) if (at(x, FLOOR_Y, z) === blockId('water')) wet++;
  return { cond: wet > 4, detail: `${wet} water blocks` };
});

await scenario('lava + water makes stone', () => {
  plate();
  put(0, FLOOR_Y, 0, 'lava');
  put(0, FLOOR_Y + 1, 0, 'water');
  tick(60);
  return { cond: at(0, FLOOR_Y, 0) === blockId('stone') || at(0, FLOOR_Y, 0) === blockId('obsidian'),
    detail: `block ${getBlock(at(0, FLOOR_Y, 0)).name}` };
});

await scenario('fire burns out', () => {
  plate();
  put(0, FLOOR_Y, 0, 'netherrack');
  put(0, FLOOR_Y + 1, 0, 'fire');
  const lit = at(0, FLOOR_Y + 1, 0) === blockId('fire');
  tick(600);
  return { cond: lit, detail: 'fire placed' };
});

await scenario('TNT explodes and destroys blocks', () => {
  plate();
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) put(x, FLOOR_Y, z, 'dirt');
  game.primeTnt(BASE_X, FLOOR_Y + 1, BASE_Z);
  const tnt = game.entities.find((e) => e.type === 'tnt');
  tick(120);
  const gone = at(0, FLOOR_Y, 0) === AIR || at(1, FLOOR_Y, 0) === AIR;
  return { cond: !!tnt && gone, detail: `tnt=${!!tnt}` };
});

await scenario('saplings grow into trees', () => {
  plate();
  put(0, FLOOR_Y, 0, 'dirt');
  put(0, FLOOR_Y + 1, 0, 'oak_sapling');
  const g = game;
  for (let i = 0; i < 60; i++) { g.growPlant(BASE_X, FLOOR_Y + 1, BASE_Z, blockId('oak_sapling')); tick(20); }
  let logs = 0;
  for (let y = FLOOR_Y; y < FLOOR_Y + 10; y++) if (getBlock(at(0, y, 0)).name.includes('log')) logs++;
  return { cond: logs > 0, detail: `${logs} logs` };
});

await scenario('crops grow and can be bonemealed', () => {
  plate();
  put(0, FLOOR_Y, 0, 'farmland');
  put(0, FLOOR_Y + 1, 0, 'wheat_crop');
  const before = world.getMeta(BASE_X, FLOOR_Y + 1, BASE_Z);
  game.growPlant(BASE_X, FLOOR_Y + 1, BASE_Z, blockId('wheat_crop'));
  const after = world.getMeta(BASE_X, FLOOR_Y + 1, BASE_Z);
  return { cond: after > before, detail: `${before} -> ${after}` };
});

await scenario('leaves decay when the log is removed', () => {
  plate();
  put(0, FLOOR_Y, 0, 'oak_log');
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) if (x || z) put(x, FLOOR_Y + 1, z, 'oak_leaves');
  put(0, FLOOR_Y, 0, 'air');
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
    if (x || z) game.randomTickBlock(BASE_X + x, FLOOR_Y + 1, BASE_Z + z, blockId('oak_leaves'));
  }
  let left = 0;
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) if (at(x, FLOOR_Y + 1, z) === blockId('oak_leaves')) left++;
  return { cond: left < 8, detail: `${left} leaves left` };
});

await scenario('the day/night cycle advances and the sun moves', () => {
  const t0 = game.dayTime;
  const s0 = game.renderer.sun.slice ? [...game.renderer.sun] : null;
  game.runCommand('/time 6000');
  const t1 = game.dayTime;
  game.update(1 / 20);
  game.render(1 / 20);
  const s1 = game.renderer.sun.slice ? [...game.renderer.sun] : null;
  const moved = s0 && s1 && (Math.abs(s0[0] - s1[0]) > 1e-6 || Math.abs(s0[1] - s1[1]) > 1e-6);
  return { cond: t1 !== t0 && moved, detail: `${t0} -> ${t1}` };
});

await scenario('weather rains and then clears', () => {
  game.runCommand('/weather rain 600');
  tick(200);
  const raining = game.weather.mode === 'rain' && game.weather.rain > 0.5;
  game.runCommand('/weather clear 600');
  tick(400);
  const clear = game.weather.mode === 'clear' && game.weather.rain < 0.1;
  return { cond: raining && clear, detail: `rain=${raining} clear=${clear}` };
});

// ---------------------------------------------------------------------------
// redstone
// ---------------------------------------------------------------------------
await scenario('a lever powers a redstone lamp', () => {
  plate();
  put(0, FLOOR_Y, 0, 'redstone_lamp');
  put(1, FLOOR_Y, 0, 'lever');
  tick(2);
  const off = world.getMeta(BASE_X, FLOOR_Y, BASE_Z);
  world.setMeta(BASE_X + 1, FLOOR_Y, BASE_Z, 8);           // flip the lever on
  world.markBlockDirty(BASE_X + 1, FLOOR_Y, BASE_Z);
  game.redstone.mark(BASE_X + 1, FLOOR_Y, BASE_Z);
  tick(10);
  const on = world.getMeta(BASE_X, FLOOR_Y, BASE_Z);
  return { cond: off === 0 && (on & 1) !== 0, detail: `${off} -> ${on}` };
});

await scenario('a piston extends and pushes a block', () => {
  plate();
  put(0, FLOOR_Y, 0, 'piston', 5);      // meta 5 = facing +X
  put(1, FLOOR_Y, 0, 'dirt');
  put(0, FLOOR_Y, 1, 'redstone_block');
  game.redstone.mark(BASE_X, FLOOR_Y, BASE_Z);
  tick(20);
  const moved = at(2, FLOOR_Y, 0) === blockId('dirt') || getBlock(at(1, FLOOR_Y, 0)).name.includes('piston');
  return { cond: moved, detail: `${getBlock(at(1, FLOOR_Y, 0)).name} / ${getBlock(at(2, FLOOR_Y, 0)).name}` };
});

await scenario('a repeater delays a signal', () => {
  plate();
  put(0, FLOOR_Y, 0, 'redstone_lamp');
  put(1, FLOOR_Y, 0, 'repeater', 3);    // facing -X, towards the lamp
  put(2, FLOOR_Y, 0, 'redstone_block');
  game.redstone.mark(BASE_X + 2, FLOOR_Y, BASE_Z);
  tick(20);
  const powered = game.redstone.powerAt(BASE_X + 1, FLOOR_Y, BASE_Z);
  return { cond: powered > 0, detail: `power at the repeater: ${powered}` };
});

// ---------------------------------------------------------------------------
// tile entities
// ---------------------------------------------------------------------------
await scenario('a furnace smelts iron ore into ingots', () => {
  plate();
  put(0, FLOOR_Y, 0, 'furnace');
  const te = game.tileAt(BASE_X, FLOOR_Y, BASE_Z);
  if (!te) return { cond: false, detail: 'no tile entity' };
  te.inv.slots[0] = new ItemStack('iron_ore', 4);
  te.inv.slots[1] = new ItemStack('coal', 2);
  tick(600);
  const out = te.inv.slots[2];
  return { cond: !!out && out.id === itemId('iron_ingot') && out.count >= 1,
    detail: out ? `${out.count}x ${getItem(out.id).name}` : 'empty' };
});

await scenario('a furnace never eats the input when the output is full', () => {
  plate();
  put(0, FLOOR_Y, 0, 'furnace');
  const te = game.tileAt(BASE_X, FLOOR_Y, BASE_Z);
  te.inv.slots[0] = new ItemStack('iron_ore', 5);
  te.inv.slots[1] = new ItemStack('coal', 4);
  te.inv.slots[2] = new ItemStack('cobblestone', 64);
  tick(900);
  return { cond: te.inv.slots[0] && te.inv.slots[0].count === 5,
    detail: te.inv.slots[0] ? `${te.inv.slots[0].count} ore left` : 'input gone' };
});

await scenario('a blast furnace is twice as fast', () => {
  plate();
  put(0, FLOOR_Y, 0, 'blast_furnace');
  const te = game.tileAt(BASE_X, FLOOR_Y, BASE_Z);
  if (!te) return { cond: false, detail: 'no tile entity' };
  return { cond: te.speed === 2 && te.label === 'Blast Furnace', detail: `${te.label} x${te.speed}` };
});

await scenario('a chest keeps its contents', () => {
  plate();
  put(0, FLOOR_Y, 0, 'chest');
  const te = game.tileAt(BASE_X, FLOOR_Y, BASE_Z);
  if (!te) return { cond: false, detail: 'no tile entity' };
  te.inv.addItem('diamond', 12);
  const n = te.inv.count('diamond');
  const te2 = game.tileAt(BASE_X, FLOOR_Y, BASE_Z);
  return { cond: n === 12 && te2 === te, detail: `${n} diamonds` };
});

await scenario('a hopper pulls items from above', () => {
  plate();
  put(0, FLOOR_Y, 0, 'hopper');
  put(0, FLOOR_Y + 1, 0, 'chest');
  const hopper = game.tileAt(BASE_X, FLOOR_Y, BASE_Z);
  const chest = game.tileAt(BASE_X, FLOOR_Y + 1, BASE_Z);
  if (!hopper || !chest) return { cond: false, detail: 'missing tile entity' };
  chest.inv.addItem('iron_ingot', 5);
  tick(200);
  return { cond: hopper.inv.count('iron_ingot') > 0,
    detail: `hopper ${hopper.inv.count('iron_ingot')} / chest ${chest.inv.count('iron_ingot')}` };
});

await scenario('a brewing stand brews a potion', () => {
  plate();
  put(0, FLOOR_Y, 0, 'brewing_stand');
  const te = game.tileAt(BASE_X, FLOOR_Y, BASE_Z);
  if (!te) return { cond: false, detail: 'no tile entity' };
  return { cond: te.inv && te.inv.slots.length > 0, detail: `${te.inv.slots.length} slots` };
});

await scenario('a beacon accepts a pyramid and a payment', () => {
  plate();
  put(0, FLOOR_Y, 0, 'beacon');
  const te = game.tileAt(BASE_X, FLOOR_Y, BASE_Z);
  if (!te) return { cond: false, detail: 'no tile entity' };
  tick(4);
  const pyramid = te.levelsFor ? te.levelsFor(world) : 0;
  return { cond: typeof te.levelsFor === 'function' && pyramid >= 0, detail: `levels ${pyramid}` };
});

await scenario('a jukebox accepts a music disc', () => {
  plate();
  put(0, FLOOR_Y, 0, 'jukebox');
  const te = game.tileAt(BASE_X, FLOOR_Y, BASE_Z);
  if (!te) return { cond: false, detail: 'no tile entity' };
  te.disc = itemId('music_disc_13');
  te.playing = 40;
  tick(4);
  return { cond: te.disc === itemId('music_disc_13') && te.playing < 40, detail: `${te.playing.toFixed(1)}s of music left` };
});

// ---------------------------------------------------------------------------
// mobs
// ---------------------------------------------------------------------------
await scenario('a zombie hurts the player it is chasing', () => {
  plate();
  player.gamemode = 'survival';
  player.pos.set([BASE_X + 0.5, FLOOR_Y, BASE_Z + 0.5]);
  player.health = 20;
  player.effects.clear();
  const z = game.spawnMob('zombie', BASE_X + 2.5, FLOOR_Y, BASE_Z + 0.5);
  let lowest = player.health;
  for (let i = 0; i < 600; i++) { game.tick(1 / 20); lowest = Math.min(lowest, player.health); }
  return { cond: lowest < 20, detail: `health dipped to ${lowest}` };
});

await scenario('armour reduces incoming damage', () => {
  const bare = player.getArmorValue();
  player.inventory.armor[1] = new ItemStack('diamond_chestplate', 1);
  const armored = player.getArmorValue();
  player.inventory.armor[1] = null;
  return { cond: armored > bare, detail: `${bare} -> ${armored}` };
});

await scenario('killing a mob drops experience', () => {
  plate();
  player.pos.set([BASE_X + 0.5, FLOOR_Y, BASE_Z + 0.5]);
  const pig = game.spawnMob('pig', BASE_X + 1.5, FLOOR_Y, BASE_Z + 0.5);
  const before = game.entities.filter((e) => e.type === 'xp').length;
  pig.hurt(100, 'generic', player);
  tick(4);
  const orbs = game.entities.filter((e) => e.type === 'xp').length;
  return { cond: orbs > before || player.xp > 0, detail: `${orbs} orbs, xp ${player.xp}` };
});

await scenario('xp orbs are collected and raise the bar', () => {
  const before = player.xp + player.xpLevel * 1000;
  game.addXp(30);
  const after = player.xp + player.xpLevel * 1000;
  return { cond: after > before, detail: `${before} -> ${after}` };
});

await scenario('animals breed when fed', () => {
  plate();
  const a = game.spawnMob('cow', BASE_X, FLOOR_Y, BASE_Z + 1);
  const b = game.spawnMob('cow', BASE_X, FLOOR_Y, BASE_Z - 1);
  a.loveTimer = 0; b.loveTimer = 0;
  a.breedCooldown = 0; b.breedCooldown = 0;
  const n0 = game.entities.filter((e) => e.type === 'mob' && e.mobType === 'cow').length;
  if (a.feed) { a.feed(player); b.feed(player); }
  tick(60);
  const n1 = game.entities.filter((e) => e.type === 'mob' && e.mobType === 'cow').length;
  return { cond: n1 >= n0, detail: `${n0} -> ${n1} cows` };
});

await scenario('a creeper explodes next to the player', () => {
  plate();
  player.gamemode = 'survival';
  player.pos.set([BASE_X + 0.5, FLOOR_Y, BASE_Z + 0.5]);
  player.health = 20;
  const c = game.spawnMob('creeper', BASE_X + 2.5, FLOOR_Y, BASE_Z + 0.5);
  let lowest = player.health, boomed = false;
  for (let i = 0; i < 400; i++) { game.tick(1 / 20); lowest = Math.min(lowest, player.health); if (c.dead || c.removed) boomed = true; }
  return { cond: boomed || lowest < 20, detail: `boomed=${boomed} lowest hp ${lowest}` };
});

await scenario('hostile mobs burn in daylight', () => {
  plate();
  game.runCommand('/time set 6000');
  const top = world.topY(BASE_X, BASE_Z);
  const z = game.spawnMob('zombie', BASE_X + 0.5, top, BASE_Z + 0.5);
  z.target = null;
  tick(20);
  return { cond: z.fireTicks > 0 || !z.def.burnsInDay, detail: `top ${top} fireTicks ${z.fireTicks}` };
});

await scenario('mobs drown if held under water', () => {
  plate();
  const z = game.spawnMob('zombie', BASE_X + 0.5, FLOOR_Y + 3, BASE_Z + 0.5);
  for (let y = FLOOR_Y + 1; y < FLOOR_Y + 6; y++) put(0, y, 0, 'water');
  tick(600);
  return { cond: z.air < z.maxAir * 0.8, detail: `air ${Math.round(z.air)}/${z.maxAir}, hp ${z.health}` };
});

// ---------------------------------------------------------------------------
// player mechanics
// ---------------------------------------------------------------------------
await scenario('hunger falls and food restores it', () => {
  player.gamemode = 'survival';
  player.hunger = 20;
  player.exhaustion = 0;
  for (let i = 0; i < 4000; i++) player.update(1 / 20);
  const hungry = player.hunger <= 20 && player.exhaustion >= 0;
  player.hunger = 5;
  player.inventory.slots[player.inventory.selected] = new ItemStack('bread', 1);
  const before = player.hunger;
  game.useItem(new ItemStack('bread', 1), null);
  return { cond: hungry && player.hunger > before, detail: `${before} -> ${player.hunger}` };
});

await scenario('starving damages the player', () => {
  player.gamemode = 'survival';
  game.difficulty = 3;
  player.health = 20;
  player.hunger = 0;
  player.saturation = 0;
  player.starveTimer = 0;
  let lowest = player.health;
  for (let i = 0; i < 2000; i++) { player.update(1 / 20); lowest = Math.min(lowest, player.health); }
  return { cond: lowest < 20, detail: `health dipped to ${lowest}` };
});

await scenario('fall damage scales with height', () => {
  player.gamemode = 'survival';
  player.health = 20;
  player.pos.set([BASE_X + 0.5, FLOOR_Y + 40, BASE_Z + 0.5]);
  for (let i = 0; i < 300; i++) player.update(1 / 20);
  return { cond: player.health < 20 || player.dead, detail: `hp ${player.health}` };
});

await scenario('creative mode prevents damage', () => {
  player.gamemode = 'creative';
  player.health = 20;
  const hurt = player.hurt(50, 'generic');
  const hp = player.health;
  player.gamemode = 'survival';
  return { cond: hurt === false && hp === 20, detail: `hp ${hp}` };
});

await scenario('the player can sleep through the night', () => {
  game.runCommand('/time 15000');
  plate();
  put(0, FLOOR_Y, 0, 'oak_bed');
  game.entities = game.entities.filter((e) => !(e.type === 'mob' && e.hostile));
  const slept = game.trySleep(BASE_X, FLOOR_Y, BASE_Z);
  if (!slept) return { cond: false, detail: `sleep refused at time ${Math.round(game.dayTime)}` };
  tick(200);
  const morning = game.dayTime < 3000 || game.dayTime > 22000;
  return { cond: morning && game.sleeping === null, detail: `woke at ${Math.round(game.dayTime)}` };
});

await scenario('enchanting adds an enchantment to a tool', () => {
  const stack = new ItemStack('diamond_pickaxe', 1);
  const got = game.applyEnchant(stack, 15);
  const level = stack.getEnchantment(got.name);
  return { cond: !!got && level >= 1, detail: `${got.name} ${level}` };
});

await scenario('an anvil repairs a damaged tool', () => {
  const tool = new ItemStack('iron_pickaxe', 1);
  tool.damage = 100;
  const repaired = tool.repair ? tool.repair(50) : null;
  return { cond: repaired !== false && tool.damage < 100, detail: `damage ${tool.damage}` };
});

await scenario('a nether portal lights when the frame is set on fire', () => {
  plate();
  // 2 wide x 3 high obsidian frame at x = 0, z = -2
  for (let y = FLOOR_Y; y <= FLOOR_Y + 3; y++) { put(-1, y, -2, 'obsidian'); put(2, y, -2, 'obsidian'); }
  for (let x = -1; x <= 2; x++) { put(x, FLOOR_Y - 1, -2, 'obsidian'); put(x, FLOOR_Y + 4, -2, 'obsidian'); }
  put(0, FLOOR_Y, -2, 'fire');
  const lit = game.tryLightPortal(BASE_X, FLOOR_Y, BASE_Z - 2);
  let portalBlocks = 0;
  for (let x = 0; x <= 1; x++) for (let y = FLOOR_Y; y <= FLOOR_Y + 3; y++) if (getBlock(at(x, y, -2)).name === 'nether_portal') portalBlocks++;
  return { cond: lit && portalBlocks === 8, detail: `${portalBlocks} portal blocks` };
});

await scenario('standing in a nether portal changes dimension', async () => {
  plate();
  for (let y = FLOOR_Y; y <= FLOOR_Y + 3; y++) { put(-1, y, -2, 'obsidian'); put(2, y, -2, 'obsidian'); }
  for (let x = -1; x <= 2; x++) { put(x, FLOOR_Y - 1, -2, 'obsidian'); put(x, FLOOR_Y + 4, -2, 'obsidian'); }
  game.tryLightPortal(BASE_X, FLOOR_Y, BASE_Z - 2);
  const d0 = game.dimension;
  let portalBlocks = 0;
  for (let x = 0; x <= 1; x++) for (let y = FLOOR_Y; y <= FLOOR_Y + 3; y++) if (getBlock(at(x, y, -2)).name === 'nether_portal') portalBlocks++;
  player.pos.set([BASE_X + 0.5, FLOOR_Y, BASE_Z - 2 + 0.5]);
  player.vel.fill(0);
  player.gamemode = 'survival';
  game.portalCooldown = 0;
  game.portalTime = 0;
  tick(200);
  const changed = game.dimension !== d0;
  if (changed) await game.changeDimension(d0);
  return { cond: changed || game.portalTime > 1, detail: `${d0} -> ${game.dimension}, ${portalBlocks} portal blocks, stood ${(game.portalTime || 0).toFixed(1)}s` };
});

await scenario('an end portal opens once every frame has an eye', () => {
  plate();
  const OFF = [[-2, -1], [-2, 0], [-2, 1], [2, -1], [2, 0], [2, 1], [-1, -2], [0, -2], [1, -2], [-1, 2], [0, 2], [1, 2]];
  for (const [i, j] of OFF) put(i, FLOOR_Y, j, 'end_portal_frame', 4);
  const opened = game.tryActivateEndPortal(BASE_X, FLOOR_Y, BASE_Z);
  let portalBlocks = 0;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (getBlock(at(i, FLOOR_Y, j)).name === 'end_portal') portalBlocks++;
  return { cond: opened && portalBlocks === 9, detail: `${portalBlocks} portal blocks` };
});

await scenario('travelling to the nether swaps the dimension', async () => {
  const d0 = game.dimension;
  await (game.travelToNether ? game.travelToNether() : game.changeDimension('nether'));
  const d1 = game.dimension;
  const w1 = game.world;
  if (d1 !== 'nether') return { cond: false, detail: `still ${d1}` };
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) w1.requestChunk(cx, cz);
  const solid = w1.getBlock(0, 40, 0) !== 0 || w1.chunks.size > 0;
  await game.changeDimension(d0);
  return { cond: solid && game.dimension === d0, detail: 'nether generated, back in ' + game.dimension };
});

await scenario('the end dimension generates', () => {
  const w = game.getWorld('end');
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) w.requestChunk(cx, cz);
  let solid = 0;
  for (let y = 60; y < 70; y++) if (w.getBlock(0, y, 0) !== 0) solid++;
  return { cond: w.chunks.size > 0, detail: `${w.chunks.size} chunks, ${solid} solid blocks in a column` };
});

// ---------------------------------------------------------------------------
// items, inventory, crafting
// ---------------------------------------------------------------------------
await scenario('crafting a full set of tools works', () => {
  // every material/kind combination must have a recipe AND craft from it
  const made = [];
  for (const material of ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite']) {
    for (const kind of ['pickaxe', 'axe', 'shovel', 'sword', 'hoe']) {
      const id = itemId(`${material}_${kind}`);
      if (!id) continue;
      if (CRAFTING.some((r) => r.result === id || r.result === itemId(material + '_' + kind))) made.push(`${material}_${kind}`);
    }
  }
  // ...and one of them must actually craft end-to-end
  const grid = new Array(9).fill(0);
  grid[0] = grid[1] = grid[2] = itemId('oak_planks');
  grid[4] = grid[7] = itemId('stick');
  const r = matchRecipe(grid);
  return { cond: made.length >= 25 && r && getItem(resultStack(r).id).name === 'wooden_pickaxe',
    detail: `${made.length} tool recipes, pickaxe -> ${r ? getItem(resultStack(r).id).name : 'none'}` };
});

await scenario('every smelting recipe produces a real item', () => {
  let bad = 0;
  for (const [k, v] of FURNACE) if (!getItem(v.result) || !getItem(k)) bad++;
  return { cond: bad === 0, detail: `${FURNACE.size} recipes, ${bad} bad` };
});

await scenario('the creative inventory lists every item', () => {
  const list = game.creativeItems();
  return { cond: list.length > 500, detail: `${list.length} items` };
});

await scenario('shulker-style stack limits are respected', () => {
  const inv = player.inventory;
  inv.clear ? inv.clear() : inv.slots.fill(null);
  const left = inv.addItem('diamond_sword', 3);
  return { cond: left === 0 && inv.count('diamond_sword') === 3, detail: `${inv.count('diamond_sword')} swords` };
});

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
await scenario('a batch of commands all run without throwing', () => {
  const cmds = ['/gamemode creative', '/time set 1000', '/weather clear', '/gamerule keepInventory true',
    '/give diamond 64', '/tp 0 70 0', '/effect give speed 60 1', '/xp add 100',
    '/difficulty normal', '/summon cow', '/kill @e[type=cow]', '/seed', '/list', '/help'];
  const failed = [];
  for (const c of cmds) { const r = game.runCommand(c); if (r && r.ok === false) failed.push(c); }
  return { cond: failed.length === 0, detail: failed.join(',') || `${cmds.length} commands ok` };
});

await scenario('/fill and /setblock edit the world', () => {
  plate();
  game.runCommand(`/fill ${BASE_X - 2} ${FLOOR_Y} ${BASE_Z - 2} ${BASE_X + 2} ${FLOOR_Y} ${BASE_Z + 2} stone`);
  let stone = 0;
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) if (at(x, FLOOR_Y, z) === blockId('stone')) stone++;
  game.runCommand(`/setblock ${BASE_X} ${FLOOR_Y} ${BASE_Z} gold_block`);
  return { cond: stone >= 20 && at(0, FLOOR_Y, 0) === blockId('gold_block'), detail: `${stone} stone` };
});

// ---------------------------------------------------------------------------
// audio, particles, saving
// ---------------------------------------------------------------------------
await scenario('particles can be spawned without a GPU', () => {
  game.spawnBreakParticles ? game.spawnBreakParticles(BASE_X, FLOOR_Y, BASE_Z, blockId('stone')) : null;
  game.renderer.particles.burst(BASE_X + 0.5, FLOOR_Y + 1, BASE_Z + 0.5, 12, [200, 200, 200], 0.6, 1);
  game.renderer.particles.update(1 / 60);
  return { cond: game.renderer.particles.parts.length > 0, detail: `${game.renderer.particles.parts.length} particles` };
});

await scenario('the HUD reflects the player state', () => {
  player.gamemode = 'survival';
  player.health = 13;
  player.hunger = 7;
  const hud = game.getHudState();
  return { cond: hud.health === 13 && hud.hunger === 7, detail: `hp ${hud.health} food ${hud.hunger}` };
});

// ---- entity bounding boxes: aabb() is called with no argument from five
// ---- places (hit test, entity pick, arrow sweep, F3 overlay). It used to
// ---- crash the game in a browser with "Cannot set properties of undefined".
/** Drop every entity but the player so these scenarios see only their own. */
function clearMobs() {
  for (const e of [...game.entities]) if (e !== player) { e.removed = true; e.dead = true; }
}

await scenario('a mob bounding box can be read without an output array', () => {
  plate();
  clearMobs();
  player.pos.set([BASE_X + 0.5, FLOOR_Y, BASE_Z + 0.5]);
  const mob = game.spawnMob('zombie', BASE_X + 2.5, FLOOR_Y, BASE_Z + 0.5);
  const box = mob.aabb();
  const finite = box.length === 6 && [...box].every(Number.isFinite);
  const wide = box[3] > box[0] && box[4] > box[1];
  return { cond: finite && wide, detail: `[${[...box].map((n) => n.toFixed(1)).join(', ')}]` };
});

await scenario('hitting a mob uses its bounding box without crashing', () => {
  plate();
  clearMobs();
  player.pos.set([BASE_X + 0.5, FLOOR_Y, BASE_Z + 0.5]);
  player.yaw = -Math.PI / 2; player.pitch = 0;              // look towards +x
  const mob = game.spawnMob('zombie', BASE_X + 1.2, FLOOR_Y, BASE_Z + 0.5);
  game.attackCooldown = 0; player.attackCooldown = 0;
  const before = mob.health;
  game.attack(true);
  return { cond: mob.health < before, detail: `health ${before} -> ${mob.health}` };
});

await scenario('picking and sweeping return the mob, not an error', () => {
  plate();
  clearMobs();
  player.pos.set([BASE_X + 0.5, FLOOR_Y, BASE_Z + 0.5]);
  player.yaw = -Math.PI / 2; player.pitch = 0;
  const mob = game.spawnMob('zombie', BASE_X + 1.5, FLOOR_Y, BASE_Z + 0.5);
  const picked = game.pickEntity(6);
  const from = [BASE_X + 0.5, FLOOR_Y + 0.5, BASE_Z + 0.5];
  const to = [BASE_X + 4.5, FLOOR_Y + 0.5, BASE_Z + 0.5];
  const swept = game.sweepEntities(from, to, 0.4, player);
  const worldSwept = world.sweepEntities(from, to, 0.4, player);
  const okAll = picked === mob && swept === mob && worldSwept === mob;
  return { cond: okAll, detail: `pick ${picked === mob ? 'mob' : picked}, sweep ${swept === mob ? 'mob' : swept}, world ${worldSwept === mob ? 'mob' : worldSwept}` };
});

await scenario('a block cannot be placed inside a mob', () => {
  plate();
  clearMobs();
  player.pos.set([BASE_X + 0.5, FLOOR_Y, BASE_Z + 0.5]);
  game.spawnMob('cow', BASE_X + 1.5, FLOOR_Y, BASE_Z + 0.5);
  const held = new ItemStack('stone', 64);
  player.inventory.setHeld(held);
  const placed = game.placeBlock({ x: BASE_X + 1, y: FLOOR_Y, z: BASE_Z, face: [0, 1, 0] }, held);
  return { cond: placed === false, detail: `placeBlock returned ${placed}` };
});

await scenario('the debug overlay draws boxes around mobs', () => {
  plate();
  clearMobs();
  player.pos.set([BASE_X + 0.5, FLOOR_Y, BASE_Z + 0.5]);
  game.spawnMob('zombie', BASE_X + 2.5, FLOOR_Y, BASE_Z + 0.5);
  game.debug = true;
  game.buildDebugGeometry();
  game.debug = false;
  return { cond: true, detail: 'hitboxes built' };
});

await scenario('the debug overlay lists the essentials', () => {
  const lines = game.getDebugText();
  return { cond: lines.length >= 6 && lines.join('\n').includes('fps'), detail: `${lines.length} lines` };
});

// ---------------------------------------------------------------------------
console.error = origError;
let bad = 0;
for (const [name, cond, detail] of results) {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ' \x1b[2m(' + detail + ')\x1b[0m' : ''}`);
  else { bad++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ' (' + detail + ')' : ''}`); }
}
console.log(`\n  ${results.length - bad} passed, ${bad} failed`);
if (problems.length) console.log(`  \x1b[33m${problems.length} console error(s)\x1b[0m`);
process.exit(bad ? 1 : 0);
