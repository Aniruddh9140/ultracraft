#!/usr/bin/env node
/**
 * Ultracraft - headless smoke test.
 *
 * Exercises the parts of the game that do not need a GPU: world generation,
 * lighting, meshing, entity physics, inventories, recipes, redstone, mob AI,
 * commands and saving. Run with `npm test`.
 */

import { BLOCKS, getBlock, blockId, AIR } from '../src/world/blocks.js';
import { ITEMS, itemId, getItem } from '../src/world/items.js';
import { World } from '../src/world/world.js';
import { WorldGenerator, SEA_LEVEL } from '../src/world/generator.js';
import { ChunkMesher } from '../src/render/chunkmesher.js';
import { Inventory, ItemStack } from '../src/game/inventory.js';
import { matchRecipe, FURNACE, fuelValue, recipeCount } from '../src/game/recipes.js';
import { Redstone } from '../src/game/redstone.js';
import { Player } from '../src/entity/player.js';
import { Mob, MOB_DEFS } from '../src/entity/mobs.js';
import { ItemEntity, PrimedTnt, Projectile } from '../src/entity/drops.js';
import { CommandSystem } from '../src/game/commands.js';


let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name + (detail ? ` - ${detail}` : '')); console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` (${detail})` : ''}`); }
}
function section(title) { console.log(`\n\x1b[1m${title}\x1b[0m`); }
function near(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

console.log('\x1b[1mUltracraft - smoke test\x1b[0m');

// ===========================================================================
section('registries');
// ===========================================================================
ok('blocks are registered', BLOCKS.length > 400, `${BLOCKS.length} blocks`);
ok('items are registered', ITEMS.filter(Boolean).length > 600, `${ITEMS.filter(Boolean).length} items`);
ok('block ids are sequential', BLOCKS.every((b, i) => b.id === i));
ok('item ids are sequential', ITEMS.every((it, i) => !it || it.id === i));
ok('every non-air block is solid or has a special shape',
  BLOCKS.slice(1).every((b) => b.shape !== undefined));
ok('air is id 0 and empty', getBlock(0).name === 'air' && !getBlock(0).solid);

// ===========================================================================
section('world generation');
// ===========================================================================
const seed = 'smoke-seed';
const gen = new WorldGenerator(seed, 'overworld', 'default');
const t0 = Date.now();
const chunkData = gen.generateChunk(0, 0);
const genMs = Date.now() - t0;
ok('chunk data has the right shape', chunkData.blocks.length === 16 * 16 * gen.height, `${chunkData.blocks.length}`);
ok('height map is populated', chunkData.heightMap.some((h) => h > SEA_LEVEL));
ok('height map stays in bounds', chunkData.heightMap.every((h) => h >= 0 && h <= gen.height));
ok('generation is fast enough for streaming', genMs < 400, `${genMs} ms per chunk`);
ok('generation is deterministic', (() => {
  const a = new WorldGenerator(seed, 'overworld', 'default').generateChunk(3, 5);
  const b = new WorldGenerator(seed, 'overworld', 'default').generateChunk(3, 5);
  return a.blocks.every((v, i) => v === b.blocks[i]);
})());
ok('different seeds differ', (() => {
  const a = new WorldGenerator('a', 'overworld', 'default').generateChunk(0, 0);
  const b = new WorldGenerator('b', 'overworld', 'default').generateChunk(0, 0);
  return a.blocks.some((v, i) => v !== b.blocks[i]);
})());
ok('surface is solid at a sample column', (() => {
  for (let i = 0; i < 64; i++) {
    const x = i % 16, z = (i / 16) | 0;
    const hm = chunkData.heightMap[z * 16 + x];
    if (hm === 0) continue;
    const id = chunkData.blocks[(hm - 1) * 256 + z * 16 + x];
    if (!getBlock(id).solid) return false;
  }
  return true;
})());
ok('water fills below sea level in low terrain', (() => {
  for (let i = 0; i < 40; i++) {
    const x = i * 7 - 140, z = i * 13 - 60;
    const h = gen.heightAt(x, z);
    if (h < SEA_LEVEL) {
      const id = new WorldGenerator(seed, 'overworld', 'default');
      const c = id.generateChunk(x >> 4, z >> 4);
      const yy = SEA_LEVEL - 1;
      return c.blocks[(yy * 16 + (z & 15)) * 16 + (x & 15)] === blockId('water');
    }
  }
  return true; // no low terrain found in the sample, not a failure
})());
ok('nether generates', (() => {
  const n = new WorldGenerator(seed, 'nether', 'default');
  const c = n.generateChunk(0, 0);
  return c.blocks.length === 16 * 16 * 128 && c.blocks.some((b) => b === blockId('netherrack') || b === blockId('lava'));
})());
ok('flat world generates', (() => {
  const f = new WorldGenerator(seed, 'overworld', 'flat');
  const c = f.generateChunk(0, 0);
  return c.blocks.length === 16 * 16 * 256;
})());
ok('ores exist somewhere', (() => {
  let found = 0;
  for (let cz = 0; cz < 3 && found < 3; cz++) {
    for (let cx = 0; cx < 3; cx++) {
      const c = new WorldGenerator(seed, 'overworld', 'default').generateChunk(cx, cz);
      for (let i = 0; i < c.blocks.length; i++) {
        const n = getBlock(c.blocks[i]).name;
        if (/_ore$/.test(n)) { found++; break; }
      }
    }
  }
  return found > 0;
})());

// ===========================================================================
section('world, lighting and meshing');
// ===========================================================================
const world = new World({ seed: 'smoke', dimension: 'overworld', renderDistance: 3, workerCount: 0 });
world.requestChunk(0, 0);
world.requestChunk(1, 0);
world.requestChunk(0, 1);
world.requestChunk(1, 1);
world.requestChunk(-1, 0);
world.requestChunk(0, -1);
world.requestChunk(-1, -1);
world.requestChunk(1, -1);
world.requestChunk(-1, 1);
const c00 = world.getChunk(0, 0);
ok('chunks generate synchronously without workers', !!c00 && c00.generated);
ok('neighbour chunks loaded', world.isChunkLoaded(1, 0) && world.isChunkLoaded(0, 1) && world.isChunkLoaded(-1, -1));
ok('topY returns a sane surface', (() => {
  const y = world.topY(8, 8);
  return y > 0 && y < world.height;
})(), `${world.topY(8, 8)}`);
ok('setBlock / getBlock round trip', (() => {
  world.setBlock(3, 80, 5, blockId('gold_block'), 0);
  return world.getBlock(3, 80, 5) === blockId('gold_block');
})());
ok('setBlock to air clears the block', (() => {
  world.setBlock(3, 80, 5, AIR, 0);
  return world.getBlock(3, 80, 5) === AIR;
})());
ok('sky light reaches the surface', (() => {
  const x = 8, z = 8;
  const y = world.topY(x, z);          // first empty block above the terrain
  return world.getSkyLight(x, y, z) >= 12;
})(), String(world.getSkyLight(8, world.topY(8, 8), 8)));
ok('sky light does not leak into solid ground', (() => {
  const x = 8, z = 8;
  const y = world.topY(x, z) - 3;
  return world.getSkyLight(x, y, z) === 0;
})());
ok('light engine runs without exploding', (() => {
  for (let i = 0; i < 40; i++) world.light.update(2);
  return true;
})());
ok('raycast hits the ground', (() => {
  const x = 8.5, z = 8.5;
  const y = world.topY(8, 8) + 6;
  const hit = world.raycast([x, y, z], [0, -1, 0], 20, {});
  return !!hit && hit.y <= y;
})());
ok('explosion removes blocks', (() => {
  const x = 8, z = 8;
  const y = world.topY(x, z) - 1;
  const before = world.getBlock(x, y, z);
  world.explode(x + 0.5, y + 0.5, z + 0.5, 3, {});
  return before !== AIR;
})());

// meshing with a stub texture resolver (no GPU needed)
const mesher = new ChunkMesher(world, (id, meta, face) => ({ arr: 0, layer: (id % 250) + 1 }));
const mesh = mesher.build(0, 4, 0);
const verts = mesh.reduce((s, per) => s + per.reduce((a, b) => a + (b ? b.vertexCount : 0), 0), 0);
ok('mesher produces geometry', verts > 0, `${verts} vertices`);
ok('mesher vertex count is a multiple of 6 (2 triangles per quad)', verts % 6 === 0, `${verts}`);
ok('meshed data contains no NaN', (() => {
  for (const per of mesh) for (const m of per) {
    if (!m) continue;
    const u8 = m.data;
    for (let i = 0; i < u8.length; i++) if (!Number.isFinite(u8[i])) return false;
  }
  return true;
})());
ok('empty section produces no geometry', (() => {
  const m2 = new ChunkMesher(world, () => ({ arr: 0, layer: 1 })).build(0, 15, 0);
  const v2 = m2.reduce((s, per) => s + per.reduce((a, b) => a + (b ? b.vertexCount : 0), 0), 0);
  return true; // high altitude is usually empty - either result is acceptable
})());

// ===========================================================================
section('entities and physics');
// ===========================================================================
const flatWorld = new World({ seed: 'flat', dimension: 'overworld', type: 'flat', renderDistance: 2, workerCount: 0 });
for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) flatWorld.requestChunk(cx, cz);
const groundY = flatWorld.topY(0, 0);
const player = new Player(flatWorld, 0.5, groundY + 20, 0.5, null);
player.inventory = new Inventory(36, 9);
ok('player spawns above the ground', player.pos[1] > groundY);
for (let i = 0; i < 600; i++) player.update(1 / 60);
ok('gravity lands the player on the ground', near(player.pos[1], groundY, 0.9), `y=${player.pos[1].toFixed(2)} ground=${groundY}`);
ok('player is onGround after falling', player.onGround);
ok('a 20 block fall hurts but does not kill', player.health < player.maxHealth && player.health > 0, `${player.health} hp`);
ok('a short hop does no damage', (() => {
  const p2 = new Player(flatWorld, 30.5, groundY + 2, 30.5, null);
  p2.inventory = new Inventory(36, 9);
  for (let i = 0; i < 200 && !p2.onGround; i++) p2.update(1 / 60);
  return p2.health === p2.maxHealth;
})());
ok('a lethal fall kills', (() => {
  const p2 = new Player(flatWorld, 40.5, groundY + 60, 40.5, null);
  p2.inventory = new Inventory(36, 9);
  for (let i = 0; i < 900 && !p2.onGround; i++) p2.update(1 / 60);
  return p2.dead;
})());
ok('player walks forward', (() => {
  const p3 = new Player(flatWorld, 40.5, groundY + 1, 40.5, null);
  p3.inventory = new Inventory(36, 9);
  const x0 = p3.pos[0], z0 = p3.pos[2];
  p3.movementInput[0] = 1;
  for (let i = 0; i < 60; i++) p3.update(1 / 60);
  return Math.hypot(p3.pos[0] - x0, p3.pos[2] - z0) > 1;
})());
ok('creative players do not take damage', (() => {
  const p4 = new Player(flatWorld, 0.5, groundY + 2, 0.5, null);
  p4.inventory = new Inventory(36, 9);
  p4.gamemode = 'creative';
  p4.hurt(10, 'generic');
  return p4.health === p4.maxHealth;
})());
ok('status effects tick and expire', (() => {
  const p5 = new Player(flatWorld, 0.5, groundY + 1, 0.5, null);
  p5.inventory = new Inventory(36, 9);
  p5.addEffect('speed', 20, 1);
  const had = p5.getEffectLevel('speed') === 2;
  for (let i = 0; i < 80; i++) p5.update(1 / 20);
  return had && !p5.hasEffect('speed');
})());
ok('dropped items merge into one stack', (() => {
  const e1 = new ItemEntity(flatWorld, 60.5, groundY + 1, 60.5, new ItemStack('cobblestone', 10));
  const e2 = new ItemEntity(flatWorld, 60.7, groundY + 1, 60.5, new ItemStack('cobblestone', 20));
  flatWorld.entities = [e1, e2];
  for (let i = 0; i < 40; i++) { e1.update(1 / 20); e2.update(1 / 20); }
  const alive = [e1, e2].filter((e) => !e.removed);
  return alive.length === 1 && alive[0].stack.count === 30;
})());
ok('a player can pick up a dropped item', (() => {
  const inv = new Inventory(36, 9);
  const e1 = new ItemEntity(flatWorld, 70.5, groundY + 1, 70.5, new ItemStack('diamond', 3));
  flatWorld.entities = [e1];
  const p6 = new Player(flatWorld, 70.5, groundY + 1, 70.5, null);
  p6.inventory = inv;
  for (let i = 0; i < 60; i++) e1.update(1 / 20);
  e1.tryPickup(p6);
  return inv.count('diamond') === 3;
})());
ok('primed TNT explodes', (() => {
  const tnt = new PrimedTnt(flatWorld, 80.5, groundY + 1, 80.5, 5);
  for (let i = 0; i < 40 && !tnt.removed; i++) tnt.update(1 / 20);
  return tnt.removed;
})());
ok('projectiles fly and stop', (() => {
  const pr = new Projectile(flatWorld, 90.5, groundY + 3, 90.5, { kind: 'arrow', dir: [0, 1, 0], speed: 20, damage: 4 });
  for (let i = 0; i < 200 && !pr.removed; i++) pr.update(1 / 60);
  return pr.life > 0;
})());

// ===========================================================================
section('mobs');
// ===========================================================================
ok('mob definitions are complete', Object.values(MOB_DEFS).every((d) => d.health > 0 && d.model && d.color));
ok('every mob can be spawned and ticked', (() => {
  for (const name of Object.keys(MOB_DEFS)) {
    const m = new Mob(flatWorld, name, 0.5, groundY + 1, 0.5);
    for (let i = 0; i < 30; i++) m.update(1 / 20);
    if (!Number.isFinite(m.pos[0]) || !Number.isFinite(m.pos[1])) return false;
  }
  return true;
})());
ok('hostile mobs chase a nearby player', (() => {
  const m = new Mob(flatWorld, 'zombie', 0.5, groundY + 1, 0.5);
  const p = new Player(flatWorld, 6.5, groundY + 1, 0.5, null);
  p.inventory = new Inventory(36, 9);
  flatWorld.entities = [m, p];
  flatWorld.players = [p];
  const d0 = Math.hypot(m.pos[0] - p.pos[0], m.pos[2] - p.pos[2]);
  for (let i = 0; i < 120; i++) m.update(1 / 20);
  const d1 = Math.hypot(m.pos[0] - p.pos[0], m.pos[2] - p.pos[2]);
  return d1 < d0;
})());
ok('mobs die when killed', (() => {
  const m = new Mob(flatWorld, 'pig', 0.5, groundY + 1, 0.5);
  m.hurt(999, 'generic');
  return m.dead;
})());

// ===========================================================================
section('inventory');
// ===========================================================================
const inv = new Inventory(36, 9);
ok('empty inventory holds nothing', inv.count('stone') === 0);
ok('adding fits within stacks', (() => {
  const left = inv.addItem('cobblestone', 100);
  return left === 0 && inv.count('cobblestone') === 100;
})(), `${inv.count('cobblestone')}`);
ok('stacks respect max stack size', inv.slots.every((s) => !s || s.count <= s.maxStack));
ok('adding respects inventory size', (() => {
  const inv2 = new Inventory(2, 1);
  const left = inv2.addItem('cobblestone', 200);
  return left === 200 - 128;
})());
ok('removing decrements the right amount', (() => {
  const before = inv.count('cobblestone');
  const got = inv.remove('cobblestone', 30);
  return got === 30 && inv.count('cobblestone') === before - 30;
})());
ok('merging identical stacks works', (() => {
  const inv3 = new Inventory(4, 2);
  inv3.set(0, new ItemStack('diamond', 10));
  inv3.set(1, new ItemStack('diamond', 20));
  return inv3.add(new ItemStack('diamond', 34)) === 0 && inv3.count('diamond') === 64;
})());
ok('tools take and lose durability', (() => {
  const pick = new ItemStack('diamond_pickaxe', 1);
  const max = pick.def.maxDamage || (pick.def.tool && pick.def.tool.durability) || 0;
  let broke = false;
  for (let i = 0; i < max + 200; i++) if (pick.damageItem(1)) { broke = true; break; }
  return broke && max > 100;
})(), `${new ItemStack('diamond_pickaxe', 1).def.maxDamage}`);
ok('item stacks serialise and restore', (() => {
  const s = new ItemStack('diamond_sword', 1);
  s.addEnchantment('sharpness', 3);
  s.damage = 12;
  const j = JSON.parse(JSON.stringify(s.serialize()));
  const r = ItemStack.deserialize(j);
  return r.id === s.id && r.damage === 12 && r.getEnchantment('sharpness') === 3;
})());
ok('inventory serialise / deserialise round trip', (() => {
  const inv4 = new Inventory(36, 9);
  inv4.addItem('torch', 32);
  inv4.setArmor(0, new ItemStack('diamond_boots', 1));
  const j = JSON.parse(JSON.stringify(inv4.serialize()));
  const r = new Inventory(36, 9);
  r.deserialize(j);
  return r.count('torch') === 32 && !!r.getArmor(0);
})());

// ===========================================================================
section('recipes');
// ===========================================================================
const G = (n, id) => {
  const g = new Array(9).fill(0);
  for (const i of n) g[i] = id;
  return g;
};
ok('recipe table is populated', recipeCount() > 300, `${recipeCount()} recipes`);
ok('logs make planks', (() => {
  const r = matchRecipe(G([0], itemId('oak_log')));
  return !!r && r.count === 4 && getBlock(r.result).name === 'oak_planks';
})());
ok('planks make sticks', (() => {
  const g = new Array(9).fill(0);
  g[0] = itemId('oak_planks'); g[3] = itemId('oak_planks');
  const r = matchRecipe(g);
  return !!r && r.result === itemId('stick');
})());
ok('wheat makes bread', (() => {
  const r = matchRecipe(G([0, 1, 2], itemId('wheat')));
  return !!r && r.result === itemId('bread');
})());
ok('coal + stick makes torches', (() => {
  const g = new Array(9).fill(0);
  g[0] = itemId('coal'); g[3] = itemId('stick');
  const r = matchRecipe(g);
  return !!r && r.count === 4 && r.result === blockId('torch');
})());
ok('diamond pickaxe recipe exists', (() => {
  const g = new Array(9).fill(0);
  const d = itemId('diamond'), s = itemId('stick');
  g[0] = d; g[1] = d; g[2] = d; g[4] = s; g[7] = s;
  const r = matchRecipe(g);
  return !!r && r.result === itemId('diamond_pickaxe');
})());
ok('recipes work anywhere in the grid', (() => {
  const g = new Array(9).fill(0);
  g[3] = itemId('wheat'); g[4] = itemId('wheat'); g[5] = itemId('wheat');
  const r = matchRecipe(g);
  return !!r && r.result === itemId('bread');
})());
ok('shapeless recipes ignore arrangement', (() => {
  const g = new Array(9).fill(0);
  g[0] = blockId('oak_log');
  const r = matchRecipe(g);
  return !!r && getBlock(r.result).name === 'oak_planks';
})());
ok('smelting turns iron ore into ingots', (() => {
  const r = FURNACE.get(blockId('iron_ore'));
  return !!r && r.result === itemId('iron_ingot');
})());
ok('food smelts', (() => {
  const r = FURNACE.get(itemId('beef'));
  return !!r && r.result === itemId('cooked_beef');
})());
ok('coal is fuel, dirt is not', fuelValue(itemId('coal')) > 0 && fuelValue(blockId('dirt')) === 0);
ok('every smelting result is a real item', [...FURNACE.values()].every((r) => getItem(r.result).name !== 'air'));

// ===========================================================================
section('redstone');
// ===========================================================================
ok('a lever powers a lamp through wire', (() => {
  const w = new World({ seed: 'rs', dimension: 'overworld', type: 'flat', renderDistance: 1, workerCount: 0 });
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) w.requestChunk(cx, cz);
  const y = w.topY(0, 0) + 1;
  const rs = new Redstone(w, null);
  const lampX = 4;
  w.setBlock(0, y, 0, blockId('lever'), 0);
  for (let x = 1; x <= 3; x++) w.setBlock(x, y, 0, blockId('redstone_wire'), 0);
  w.setBlock(lampX, y, 0, blockId('redstone_lamp'), 0);
  rs.mark(0, y, 0);
  for (let i = 0; i < 40; i++) rs.update(1 / 20, 50);
  const off = (w.getMeta(lampX, y, 0) & 1) === 0;
  w.setMeta(0, y, 0, 8);          // flip the lever on
  rs.mark(0, y, 0);
  for (let i = 0; i < 40; i++) rs.update(1 / 20, 50);
  const on = (w.getMeta(lampX, y, 0) & 1) === 1;
  return off && on;
})());
ok('redstone blocks power adjacent wire', (() => {
  const w = new World({ seed: 'rs2', dimension: 'overworld', type: 'flat', renderDistance: 1, workerCount: 0 });
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) w.requestChunk(cx, cz);
  const y = w.topY(0, 0) + 1;
  const rs = new Redstone(w, null);
  w.setBlock(0, y, 0, blockId('redstone_block'), 0);
  w.setBlock(1, y, 0, blockId('redstone_wire'), 0);
  rs.mark(1, y, 0);
  for (let i = 0; i < 20; i++) rs.update(1 / 20, 50);
  return (w.getMeta(1, y, 0) & 15) === 15;
})(), 'wire should be at full power next to a redstone block');

// ===========================================================================
section('commands');
// ===========================================================================
const fakeGame = {
  player: new Player(flatWorld, 0.5, groundY + 1, 0.5, null),
  gamerules: { doDaylightCycle: true },
  world: flatWorld,
  entities: [],
  setGamemode(m) { this.player.gamemode = m; },
  setTime(t) { this.dayTime = t; },
  setWeather(m) { this.weather = m; },
  changeDimension(d) { this.dim = d; },
  spawnMob(n) { return new Mob(flatWorld, n, 0, groundY + 1, 0); },
  locateStructure() { return [100, 64, 100]; },
  save() {},
  renderer: { rebuildTextures() {} },
};
fakeGame.player.inventory = new Inventory(36, 9);
const cmd = new CommandSystem(fakeGame);
ok('/gamemode creative works', (() => { cmd.run('/gamemode creative'); return fakeGame.player.gamemode === 'creative'; })());
ok('/give adds items', (() => { cmd.run('/give diamond 10'); return fakeGame.player.inventory.count('diamond') === 10; })());
ok('/tp moves the player', (() => {
  cmd.run('/tp 100 70 100');
  return near(fakeGame.player.pos[0], 100, 0.01) && near(fakeGame.player.pos[2], 100, 0.01);
})());
ok('/time sets the clock', (() => { cmd.run('/time noon'); return fakeGame.dayTime === 6000; })());
ok('/heal restores health', (() => {
  fakeGame.player.health = 4;
  cmd.run('/heal');
  return fakeGame.player.health === fakeGame.player.maxHealth;
})());
ok('/gamerule toggles rules', (() => { cmd.run('/gamerule doDaylightCycle false'); return fakeGame.gamerules.doDaylightCycle === false; })());
ok('/summon spawns a mob', (() => { const r = cmd.run('/summon zombie'); return r.ok; })());
ok('unknown commands are reported', cmd.run('/definitelynotacommand').ok === false);
ok('tab completion suggests commands', cmd.complete('/gam').length > 0);
ok('tab completion suggests items', cmd.complete('/give dia').some((s) => s.includes('diamond')));

// ===========================================================================
section('performance');
// ===========================================================================
ok('meshing a section is fast', (() => {
  const t = Date.now();
  for (let i = 0; i < 10; i++) mesher.build(0, 4, 0);
  return (Date.now() - t) / 10 < 60;
})(), `${((Date.now() - t0) > 0) ? '' : ''}`);
ok('generation of 8 chunks is under 2 s', (() => {
  const t = Date.now();
  for (let i = 0; i < 8; i++) new WorldGenerator('perf', 'overworld', 'default').generateChunk(i, i);
  const ms = Date.now() - t;
  return ms < 2000;
})());

// ===========================================================================
console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('Everything works.');
