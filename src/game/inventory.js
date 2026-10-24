/**
 * Ultracraft - inventories and item stacks.
 *
 * One class serves every container: the player's 36+5 slots, the 3x3 crafting
 * grid, chests, furnaces, hoppers and shulker boxes. Slots hold `ItemStack`s,
 * which are plain objects so they can be structured-cloned to workers and
 * serialised straight to JSON.
 */

import { getItem, itemId, ITEMS, ItemType } from '../world/items.js';
import { getBlock, blockId } from '../world/blocks.js';

export const ARMOR_SLOTS = 4;

export class ItemStack {
  constructor(id, count = 1, extra = null) {
    this.id = typeof id === 'string' ? itemId(id) : id;
    this.count = count;
    this.damage = 0;       // durability used
    this.name = null;      // custom name from an anvil
    this.ench = null;      // Map<string, level>
    this.tag = null;       // potion effects, book contents, etc.
    if (extra) Object.assign(this, extra);
  }
  static of(id, count = 1, extra = null) { return new ItemStack(id, count, extra); }
  get def() { return getItem(this.id) || ITEMS[0]; }
  get empty() { return !this.id || this.count <= 0; }
  get maxStack() { return this.def.stack || 64; }
  get displayName() { return this.name || this.def.label || this.def.name; }
  copy() {
    const s = new ItemStack(this.id, this.count, { damage: this.damage, tag: this.tag });
    if (this.ench) s.ench = new Map(this.ench);
    return s;
  }
  /** Can this stack merge with another? */
  canStack(o) {
    if (!o || this.id !== o.id) return false;
    if (this.def.damageable) return false;
    if ((this.name || null) !== (o.name || null)) return false;
    const a = this.ench, b = o.ench;
    if (!a !== !b) return false;
    if (a && b) {
      if (a.size !== b.size) return false;
      for (const [k, v] of a) if (b.get(k) !== v) return false;
    }
    return true;
  }
  addEnchantment(name, level) {
    if (!this.ench) this.ench = new Map();
    this.ench.set(name, level);
    return this;
  }
  getEnchantment(name) { return this.ench ? (this.ench.get(name) || 0) : 0; }
  get maxDamage() { return this.def.maxDamage || 0; }
  /** Damage the tool; returns true when it broke. */
  damageItem(n = 1) {
    if (this.maxDamage <= 0) return false;
    const unbreaking = this.getEnchantment('unbreaking');
    for (let i = 0; i < n; i++) {
      if (unbreaking && Math.random() < unbreaking / (unbreaking + 1)) continue;
      this.damage++;
    }
    return this.damage >= this.maxDamage;
  }
  repair(n) { this.damage = Math.max(0, this.damage - n); }
  serialize() {
    const o = { id: this.id, count: this.count };
    if (this.damage) o.damage = this.damage;
    if (this.name) o.name = this.name;
    if (this.ench) o.ench = [...this.ench];
    if (this.tag) o.tag = this.tag;
    return o;
  }
  static deserialize(o) {
    if (!o) return null;
    const s = new ItemStack(o.id, o.count);
    s.damage = o.damage || 0;
    s.name = o.name || null;
    s.ench = o.ench ? new Map(o.ench) : null;
    s.tag = o.tag || null;
    return s;
  }
}

/**
 * A generic slot container.
 * `slots` is a dense array; the first `hotbar` slots are the hotbar.
 */
export class Inventory {
  constructor(size = 36, hotbar = 9) {
    this.slots = new Array(size).fill(null);
    this.size = size;
    this.hotbar = hotbar;
    this.armor = new Array(ARMOR_SLOTS).fill(null);   // feet, legs, chest, head
    this.offhand = null;
    this.selected = 0;
    this.cursor = null;                                // stack held by the mouse
    this.onChange = null;
  }

  changed() { if (this.onChange) this.onChange(); }

  get(i) { return this.slots[i] || null; }
  set(i, stack) { this.slots[i] = stack && stack.count > 0 ? stack : null; this.changed(); }
  getHeld() { return this.slots[this.selected] || null; }
  setHeld(stack) { this.slots[this.selected] = stack; this.changed(); }

  /** Merge a stack into the inventory. Returns the number of items left over. */
  add(stack) {
    if (!stack || stack.count <= 0) return 0;
    let left = stack.count;
    const max = stack.maxStack;
    // 1. merge into existing stacks
    for (let i = 0; i < this.size && left > 0; i++) {
      const s = this.slots[i];
      if (s && s.canStack(stack) && s.count < Math.min(s.maxStack, max)) {
        const move = Math.min(Math.min(s.maxStack, max) - s.count, left);
        s.count += move; left -= move;
      }
    }
    // 2. empty slots
    for (let i = 0; i < this.size && left > 0; i++) {
      if (!this.slots[i]) {
        const move = Math.min(max, left);
        this.slots[i] = new ItemStack(stack.id, move, { tag: stack.tag });
        if (stack.ench) this.slots[i].ench = new Map(stack.ench);
        left -= move;
      }
    }
    this.changed();
    return left;
  }

  addItem(id, count = 1) { return this.add(new ItemStack(id, count)); }

  /** Count how many of `id` the inventory holds. */
  count(id) {
    const want = typeof id === 'string' ? itemId(id) : id;
    let n = 0;
    for (const s of this.slots) if (s && s.id === want) n += s.count;
    return n;
  }

  /** Remove up to `count` of `id` from anywhere in the inventory. */
  remove(id, count = 1) {
    const want = typeof id === 'string' ? itemId(id) : id;
    let left = count;
    for (let i = 0; i < this.size && left > 0; i++) {
      const s = this.slots[i];
      if (s && s.id === want) {
        const take = Math.min(s.count, left);
        s.count -= take; left -= take;
        if (s.count <= 0) this.slots[i] = null;
      }
    }
    this.changed();
    return count - left;
  }

  /** Remove one item from the held stack (used when placing / consuming). */
  consumeHeld(n = 1) {
    const s = this.getHeld();
    if (!s) return false;
    s.count -= n;
    if (s.count <= 0) this.slots[this.selected] = null;
    this.changed();
    return true;
  }

  /** True when a full stack of `id` would fit somewhere. */
  canAccept(stack) {
    if (!stack) return true;
    for (let i = 0; i < this.size; i++) {
      const s = this.slots[i];
      if (!s) return true;
      if (s.canStack(stack) && s.count < Math.min(s.maxStack, stack.maxStack)) return true;
    }
    return false;
  }

  /** Free slot index or -1 */
  firstEmpty() {
    for (let i = 0; i < this.size; i++) if (!this.slots[i]) return i;
    return -1;
  }

  /** Pick the best slot for an item (existing stack, then hotbar, then main). */
  pickSlotFor(stack) {
    const max = stack.maxStack;
    for (let i = 0; i < this.size; i++) {
      const s = this.slots[i];
      if (s && s.canStack(stack) && s.count < Math.min(s.maxStack, max)) return i;
    }
    for (let i = 0; i < this.hotbar; i++) if (!this.slots[i]) return i;
    return this.firstEmpty();
  }

  /** Move `stack` into a specific slot, swapping whatever is there. */
  put(i, stack) {
    const prev = this.slots[i];
    this.slots[i] = stack;
    this.changed();
    return prev || null;
  }

  swap(a, b) {
    const t = this.slots[a];
    this.slots[a] = this.slots[b];
    this.slots[b] = t;
    this.changed();
  }

  /** Damage the held item and break it when durability runs out. */
  damageHeld(n = 1) {
    const s = this.getHeld();
    if (!s) return;
    if (s.damageItem(n)) this.slots[this.selected] = null;
    this.changed();
  }

  /** Total armour value + which slots are filled (for the HUD). */
  armorInfo() {
    let defense = 0, toughness = 0;
    for (const s of this.armor) {
      if (s && s.def && s.def.armor) {
        const a = s.def.armor;
        defense += a.defense;
        toughness += a.toughness || 0;
      }
    }
    return { defense, toughness };
  }

  getArmor(slot) { return this.armor[slot] || null; }
  setArmor(slot, stack) { this.armor[slot] = stack && stack.count > 0 ? stack : null; this.changed(); }

  clear() {
    this.slots.fill(null);
    this.armor.fill(null);
    this.offhand = null;
    this.cursor = null;
    this.changed();
  }

  serialize() {
    const s = (x) => (x ? x.serialize() : null);
    return {
      slots: this.slots.map(s),
      armor: this.armor.map(s),
      offhand: s(this.offhand),
      selected: this.selected,
    };
  }
  deserialize(data) {
    if (!data) return;
    const l = (x) => (x ? ItemStack.deserialize(x) : null);
    this.slots = new Array(this.size).fill(null);
    if (data.slots) for (let i = 0; i < Math.min(this.size, data.slots.length); i++) this.slots[i] = l(data.slots[i]);
    this.armor = new Array(ARMOR_SLOTS).fill(null);
    if (data.armor) for (let i = 0; i < Math.min(ARMOR_SLOTS, data.armor.length); i++) this.armor[i] = l(data.armor[i]);
    this.offhand = l(data.offhand);
    this.selected = data.selected || 0;
    this.changed();
  }
}

/** 27-slot chest / shulker box / storage container inventory. */
export class ContainerInventory extends Inventory {
  constructor(rows = 3) { super(rows * 9, 0); this.rows = rows; }
}

/** Furnace: 1 input, 1 fuel, 1 output plus progress timers. */
export class FurnaceInventory extends Inventory {
  constructor() {
    super(3, 0);
    this.burnTime = 0;
    this.burnTotal = 0;
    this.cookTime = 0;
    this.cookTotal = 200;
  }
  get input() { return this.slots[0]; }
  get fuel() { return this.slots[1]; }
  get output() { return this.slots[2]; }
}

export function itemStack(id, count = 1, extra = null) { return new ItemStack(id, count, extra); }

/** Resolve either a block or an item name to an item id (0 if unknown). */
export function anyId(name) {
  if (typeof name === 'number') return name;
  const i = itemId(name);
  if (i) return i;
  const b = blockId(name);
  return b || 0;
}

/** Human readable label for an item id. */
export function labelOf(id) {
  const def = getItem(id);
  if (def) return def.label || def.name;
  const b = getBlock(id);
  return b ? (b.label || b.name) : 'Unknown';
}

export default Inventory;
