/**
 * Ultracraft - tile entities.
 *
 * Everything a block needs beyond its 16 bits: container contents, furnace
 * progress, hopper transfer, spawner timers, beacon beams, brewing.
 * Instances live in `world.tileEntities` keyed by `x,y,z` and are ticked by
 * the game loop (only while their chunk is loaded).
 */

import { ItemStack, Inventory } from './inventory.js';
import { FURNACE, BLAST, SMOKER, CAMPFIRE, STONECUTTER, fuelValue, findBrewing, recipeCount } from './recipes.js';
import { getBlock, blockId, BLOCKS, AIR } from '../world/blocks.js';
import { getItem, itemId } from '../world/items.js';
import { lerp } from '../core/math.js';

export class TileEntity {
  constructor(x, y, z, id) {
    this.x = x; this.y = y; this.z = z; this.id = id;
    this.invalid = false;
  }
  get key() { return `${this.x},${this.y},${this.z}`; }
  tick() {}
  serialize() { return { id: this.id }; }
  deserialize(d) { Object.assign(this, d || {}); }
}

// ---------------------------------------------------------------------------
// containers
// ---------------------------------------------------------------------------
export class ContainerTile extends TileEntity {
  constructor(x, y, z, id, rows = 3) {
    super(x, y, z, id);
    this.inv = new Inventory(rows * 9, 0);
    this.rows = rows;
    this.label = 'Container';
    this.openCount = 0;
  }
  serialize() { return { ...super.serialize(), inv: this.inv.serialize(), rows: this.rows }; }
  deserialize(d) {
    super.deserialize(d);
    if (d.inv) this.inv.deserialize(d.inv);
    if (d.rows) this.rows = d.rows;
  }
}

export class ChestTile extends ContainerTile {
  constructor(x, y, z, id) {
    super(x, y, z, id, 3);
    this.label = getBlock(id).name.includes('trapped') ? 'Trapped Chest' : 'Chest';
  }
}

export class EnderChestTile extends TileEntity {
  constructor(x, y, z, id) { super(x, y, z, id); this.label = 'Ender Chest'; }
}

// ---------------------------------------------------------------------------
// furnace family
// ---------------------------------------------------------------------------
export class FurnaceTile extends ContainerTile {
  constructor(x, y, z, id) {
    super(x, y, z, id, 1);
    this.burnTime = 0;
    this.burnTotal = 0;
    this.cookTime = 0;
    this.cookTotal = 200;
    this.label = 'Furnace';
    this.speed = 1;
    this.table = FURNACE;
    const n = getBlock(id).name;
    if (n === 'blast_furnace') { this.label = 'Blast Furnace'; this.speed = 2; this.table = BLAST; }
    if (n === 'smoker') { this.label = 'Smoker'; this.speed = 2; this.table = SMOKER; }
  }

  tick(world, game, dt) {
    const inv = this.inv;
    const input = inv.slots[0];
    const recipe = input ? this.table.get(input.id) : null;
    const canOutput = (r) => {
      const out = inv.slots[2];
      if (!out) return true;
      return out.id === r.result && out.count + (r.count || 1) <= out.maxStack;
    };
    // burn down
    if (this.burnTime > 0) this.burnTime -= dt * 20;
    let lit = this.burnTime > 0;
    if (this.burnTime < 0) this.burnTime = 0;
    // cook
    if (recipe && canOutput(recipe)) {
      if (lit) {
        this.cookTime += dt * 20 * this.speed;
        if (this.cookTime >= this.cookTotal) {
          const count = recipe.count || 1;
          const out = inv.slots[2];
          let stored = false;
          if (!out) { inv.slots[2] = new ItemStack(recipe.result, count); stored = true; }
          else if (out.id === recipe.result && out.count + count <= out.maxStack) { out.count += count; stored = true; }
          if (stored) {
            // only consume the input once the output has somewhere to go
            this.cookTime = 0;
            input.count--;
            if (input.count <= 0) inv.slots[0] = null;
            if (game && game.player && game.player.inventory === game.openInventory) game.addXp(recipe.xp || 0);
          } else {
            this.cookTime = this.cookTotal;   // hold the finished item until there is room
          }
        }
      } else {
        this.cookTime = Math.max(0, this.cookTime - dt * 40);
      }
    } else if (!recipe) {
      this.cookTime = 0;
    }
    // refuel
    if (!lit && recipe && canOutput(recipe)) {
      const f = inv.slots[1];
      if (f) {
        const v = fuelValue(f.id);
        if (v > 0) {
          this.burnTotal = v;
          this.burnTime = v;
          lit = true;
          f.count--;
          if (f.count <= 0) inv.slots[1] = null;
          if (f.id === itemId('lava_bucket')) inv.slots[1] = new ItemStack('bucket', 1);
        }
      }
    }
    // light level
    const want = lit ? 13 : 0;
    if (this.lastLit !== lit) {
      this.lastLit = lit;
      world.setLight(this.x, this.y, this.z, want);
    }
  }

  serialize() { return { ...super.serialize(), burnTime: this.burnTime, burnTotal: this.burnTotal, cookTime: this.cookTime }; }
  deserialize(d) { super.deserialize(d); this.burnTime = d.burnTime || 0; this.burnTotal = d.burnTotal || 0; this.cookTime = d.cookTime || 0; }
}

// ---------------------------------------------------------------------------
// hopper
// ---------------------------------------------------------------------------
export class HopperTile extends ContainerTile {
  constructor(x, y, z, id) {
    super(x, y, z, id, 1);
    this.cooldown = 0;
    this.label = 'Hopper';
  }
  tick(world, game, dt) {
    this.cooldown -= dt * 20;
    if (this.cooldown > 0) return;
    this.cooldown = 8;
    // pull from above
    const above = world.tileEntityAt(this.x, this.y + 1, this.z);
    if (above && above.inv && !(above instanceof HopperTile)) this.suck(above.inv, 1);
    if (this.inv.firstEmpty() >= 0 || this.canMergeAny(this.inv)) {
      // push to container we point at
      const target = this.outputTarget(world);
      if (target) this.push(target, 1);
    }
  }
  outputTarget(world) {
    const meta = world.getMeta(this.x, this.y, this.z) & 7;
    const dirs = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
    const d = dirs[Math.min(dirs.length - 1, meta)] || dirs[0];
    const te = world.tileEntityAt(this.x + d[0], this.y + d[1], this.z + d[2]);
    return te && te.inv ? te.inv : null;
  }
  canMergeAny(inv) { return inv.slots.some((s) => s); }
  suck(from, n) {
    for (let i = 0; i < from.size && n > 0; i++) {
      const s = from.slots[i];
      if (!s) continue;
      const take = new ItemStack(s.id, Math.min(n, s.count));
      const left = this.inv.add(take);
      const moved = take.count - left;
      s.count -= moved;
      if (s.count <= 0) from.slots[i] = null;
      n -= moved;
      if (moved) return true;
    }
    return false;
  }
  push(to, n) {
    for (let i = 0; i < this.inv.size && n > 0; i++) {
      const s = this.inv.slots[i];
      if (!s) continue;
      const take = new ItemStack(s.id, Math.min(n, s.count));
      const left = to.add(take);
      const moved = take.count - left;
      s.count -= moved;
      if (s.count <= 0) this.inv.slots[i] = null;
      n -= moved;
    }
  }
}

// ---------------------------------------------------------------------------
// dispenser / dropper
// ---------------------------------------------------------------------------
export class DispenserTile extends ContainerTile {
  constructor(x, y, z, id) {
    super(x, y, z, id, 1);
    this.cooldown = 0;
    this.label = getBlock(id).name === 'dropper' ? 'Dropper' : 'Dispenser';
  }
  tick(world, game, dt) {
    if (this.cooldown > 0) this.cooldown -= dt * 20;
  }
  /** Fire one item (triggered by redstone). */
  trigger(world, game) {
    if (this.cooldown > 0) return;
    this.cooldown = 4;
    const slots = [];
    for (let i = 0; i < this.inv.size; i++) if (this.inv.slots[i]) slots.push(i);
    if (!slots.length) return;
    const i = slots[(Math.random() * slots.length) | 0];
    const stack = this.inv.slots[i];
    const meta = world.getMeta(this.x, this.y, this.z) & 7;
    const dirs = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
    const d = dirs[Math.min(dirs.length - 1, meta)] || dirs[0];
    const isDropper = this.label === 'Dropper';
    const shot = new ItemStack(stack.id, 1);
    if (!isDropper && game) game.dispenseItem(this, shot, d);
    else if (game) game.dropItem(this.x + 0.5 + d[0] * 0.7, this.y + 0.5 + d[1] * 0.7, this.z + 0.5 + d[2] * 0.7, shot, d);
    stack.count--;
    if (stack.count <= 0) this.inv.slots[i] = null;
  }
}

// ---------------------------------------------------------------------------
// mob spawner
// ---------------------------------------------------------------------------
export class SpawnerTile extends TileEntity {
  constructor(x, y, z, id) {
    super(x, y, z, id);
    this.mob = 'zombie';
    this.delay = 200;
    this.minDelay = 200;
    this.maxDelay = 800;
    this.count = 4;
    this.range = 16;
    this.spin = 0;
  }
  tick(world, game, dt) {
    this.spin += dt * 1.5;
    if (!game || !game.player) return;
    const p = game.player;
    const d = Math.hypot(p.pos[0] - this.x - 0.5, p.pos[1] - this.y - 0.5, p.pos[2] - this.z - 0.5);
    if (d > this.range) return;
    this.delay -= dt * 20;
    if (this.delay > 0) return;
    this.delay = this.minDelay + Math.random() * (this.maxDelay - this.minDelay);
    const nearby = game.entities.filter((e) => e.type === 'mob' && e.def && e.def.name === this.mob && Math.hypot(e.pos[0] - this.x, e.pos[2] - this.z) < this.range).length;
    if (nearby >= this.count) return;
    for (let i = 0; i < 4; i++) {
      game.spawnMob(this.mob, this.x + 0.5 + (Math.random() - 0.5) * 3, this.y, this.z + 0.5 + (Math.random() - 0.5) * 3);
    }
  }
  serialize() { return { ...super.serialize(), mob: this.mob, delay: this.delay }; }
}

// ---------------------------------------------------------------------------
// beacon
// ---------------------------------------------------------------------------
export class BeaconTile extends TileEntity {
  constructor(x, y, z, id) {
    super(x, y, z, id);
    this.levels = 0;
    this.primary = 0;    // effect id
    this.secondary = 0;
    this.beamY = 0;
  }
  levelsFor(world) {
    let best = 0;
    for (let l = 1; l <= 4; l++) {
      let ok = true;
      for (let dx = -l; dx <= l && ok; dx++) {
        for (let dz = -l; dz <= l && ok; dz++) {
          const id = world.getBlock(this.x + dx, this.y - l, this.z + dz);
          const n = getBlock(id).name;
          if (!/block$/.test(n) || n === 'netherite_block') ok = false;
        }
      }
      if (ok) best = l; else break;
    }
    return best;
  }
  tick(world, game, dt) {
    // recount the pyramid once a second
    this.retimer = (this.retimer || 0) - dt;
    if (this.retimer <= 0) { this.retimer = 1; const lv = this.levelsFor(world); if (lv !== this.levels) { this.levels = lv; world.markBlockDirty(this.x, this.y, this.z); } }
    this.beamY = Math.min(this.beamY + dt * 40, 256);
    if (!game || !game.player || !this.levels || !this.primary) return;
    const p = game.player;
    const r = this.levels * 10 + 10;
    if (Math.hypot(p.pos[0] - this.x, p.pos[1] - this.y, p.pos[2] - this.z) > r) return;
    this.t = (this.t || 0) - dt;
    if (this.t <= 0) { this.t = 4; p.addEffect(effectName(this.primary), 9 * 20, this.secondary === this.primary ? 1 : 0); }
  }
  serialize() { return { ...super.serialize(), levels: this.levels, primary: this.primary, secondary: this.secondary }; }
}

const BEACON_EFFECTS = ['speed', 'haste', 'resistance', 'jump_boost', 'strength', 'regeneration'];
function effectName(i) { return BEACON_EFFECTS[i] || 'speed'; }
export { BEACON_EFFECTS };

// ---------------------------------------------------------------------------
// brewing stand
// ---------------------------------------------------------------------------
export class BrewingTile extends ContainerTile {
  constructor(x, y, z, id) {
    super(x, y, z, id, 1);
    this.inv = new Inventory(5, 0);   // 0-2 potions, 3 ingredient, 4 blaze powder
    this.brewTime = 0;
    this.fuel = 0;
    this.label = 'Brewing Stand';
  }
  tick(world, game, dt) {
    const ing = this.inv.slots[3];
    const anyPotion = this.inv.slots[0] || this.inv.slots[1] || this.inv.slots[2];
    if (!ing || !anyPotion) { this.brewTime = 0; return; }
    if (this.fuel <= 0) {
      const powder = this.inv.slots[4];
      if (powder && powder.id === itemId('blaze_powder')) { powder.count--; if (powder.count <= 0) this.inv.slots[4] = null; this.fuel = 20; }
      else return;
    }
    this.brewTime += dt * 20;
    if (this.brewTime >= 400) {
      this.brewTime = 0;
      this.fuel--;
      for (let i = 0; i < 3; i++) {
        const s = this.inv.slots[i];
        if (!s) continue;
        const out = findBrewing(s.id, ing.id);
        if (out) { s.id = out; s.count = 1; }
      }
      ing.count--;
      if (ing.count <= 0) this.inv.slots[3] = null;
    }
  }
  serialize() { return { ...super.serialize(), brewTime: this.brewTime, fuel: this.fuel }; }
}

// ---------------------------------------------------------------------------
// jukebox / note block / sign / bed / campfire
// ---------------------------------------------------------------------------
export class JukeboxTile extends TileEntity {
  constructor(x, y, z, id) { super(x, y, z, id); this.disc = 0; this.playing = 0; }
  tick(world, game, dt) {
    if (this.playing > 0) {
      this.playing -= dt;
      if (this.playing <= 0 && game && game.onSongEnd) game.onSongEnd(this);
    }
  }
  serialize() { return { ...super.serialize(), disc: this.disc }; }
}

export class NoteTile extends TileEntity {
  constructor(x, y, z, id) {
    super(x, y, z, id);
    this.note = 0;
    this.instrument = 'harp';
  }
  tick() {}
  play(world) {
    // determine the instrument from the block below
    const below = getBlock(world.getBlock(this.x, this.y - 1, this.z)).name;
    const map = {
      'basedrum': /stone|netherrack|obsidian|bedrock|bricks|sandstone/,
      'snare': /sand|gravel|concrete_powder/,
      'hat': /glass|sea_lantern|glowstone|beacon/,
      'bass': /planks|log|wood|bookshelf/,
      'flute': /clay/,
      'bell': /gold_block/,
      'guitar': /wool/,
      'chime': /packed_ice/,
      'xylophone': /bone_block/,
      'iron_xylophone': /iron_block/,
      'cow_bell': /soul_sand/,
      'didgeridoo': /pumpkin/,
      'bit': /emerald_block/,
      'banjo': /hay_block/,
      'pling': /glowstone/,
    };
    let inst = 'harp';
    for (const [k, re] of Object.entries(map)) if (re.test(below)) { inst = k; break; }
    this.instrument = inst;
    return { note: this.note, instrument: inst };
  }
  serialize() { return { ...super.serialize(), note: this.note }; }
}

export class SignTile extends TileEntity {
  constructor(x, y, z, id) {
    super(x, y, z, id);
    this.lines = ['', '', '', ''];
    this.color = 'black';
    this.glowing = false;
  }
  serialize() { return { ...super.serialize(), lines: this.lines, color: this.color }; }
}

export class BedTile extends TileEntity {
  constructor(x, y, z, id) { super(x, y, z, id); this.occupied = false; }
  serialize() { return { ...super.serialize(), occupied: this.occupied }; }
}

export class CampfireTile extends ContainerTile {
  constructor(x, y, z, id) {
    super(x, y, z, id, 1);
    this.inv = new Inventory(4, 0);
    this.times = [0, 0, 0, 0];
    this.label = 'Campfire';
  }
  tick(world, game, dt) {
    for (let i = 0; i < 4; i++) {
      const s = this.inv.slots[i];
      if (!s) { this.times[i] = 0; continue; }
      const r = CAMPFIRE.get(s.id);
      if (!r) { this.times[i] = 0; continue; }
      this.times[i] += dt * 20;
      if (this.times[i] >= 600) {
        this.times[i] = 0;
        if (game) game.dropItem(this.x + 0.5, this.y + 0.6, this.z + 0.5, new ItemStack(r.result, r.count));
        s.count--;
        if (s.count <= 0) this.inv.slots[i] = null;
      }
    }
  }
  serialize() { return { ...super.serialize(), times: this.times }; }
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------
const FACTORIES = new Map();
const register = (name, cls) => { const b = blockId(name); if (b) FACTORIES.set(b, cls); };

register('chest', ChestTile);
register('trapped_chest', ChestTile);
register('barrel', ChestTile);
register('furnace', FurnaceTile);
register('blast_furnace', FurnaceTile);
register('smoker', FurnaceTile);
register('hopper', HopperTile);
register('dispenser', DispenserTile);
register('dropper', DispenserTile);
register('spawner', SpawnerTile);
register('beacon', BeaconTile);
register('brewing_stand', BrewingTile);
register('jukebox', JukeboxTile);
register('note_block', NoteTile);
register('campfire', CampfireTile);
for (const w of ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'crimson', 'warped']) {
  register(w + '_sign', SignTile);
  register(w + '_bed', BedTile);
}

export function isContainerBlock(id) { return FACTORIES.has(id); }

export function createTileEntity(id, x, y, z) {
  const C = FACTORIES.get(id);
  if (!C) return null;
  return new C(x, y, z, id);
}

/** Deserialise a tile entity saved by `world.serialize()`. */
export function restoreTileEntity(data) {
  const C = FACTORIES.get(data.id);
  if (!C) return null;
  const te = new C(data.x, data.y, data.z, data.id);
  te.deserialize(data);
  return te;
}

export function tileEntityLabel(te) {
  return te && te.label ? te.label : 'Block';
}

export default TileEntity;
