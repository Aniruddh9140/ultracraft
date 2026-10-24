/**
 * Ultracraft - the interface layer.
 *
 * Everything DOM: HUD (hearts, hunger, air, xp, hotbar, effects, boss bar,
 * chat, debug overlay), the container/crafting screens with full mouse and
 * touch drag-and-drop, settings, the pause and death screens and the mobile
 * control overlay.
 *
 * The UI never touches WebGL directly - it reads `game` state and calls
 * `game` methods, and uses `textures.iconCSS()` for item icons.
 */

import { ITEMS, getItem, itemId } from '../world/items.js';
import { BLOCKS, getBlock } from '../world/blocks.js';
import { ItemStack } from '../game/inventory.js';
import { QUALITY_PRESETS } from '../render/renderer.js';
import { EFFECTS, GAMEMODE } from '../entity/player.js';
import { matchRecipe, STONECUTTER, recipeCount } from '../game/recipes.js';
import { MOB_DEFS } from '../entity/mobs.js';
import { clamp } from '../core/math.js';

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, parent) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
};

export class UI {
  constructor(game) {
    this.game = game;
    this.root = $('#app');
    this.dirty = new Set(['all']);
    this.messages = [];
    this.cursor = null;            // ItemStack held by the mouse
    this.slots = [];               // {node, inv, index}
    this.screen = null;
    this.screenData = null;
    this.chatOpen = false;
    this.hudVisible = true;
    this.toastTimer = 0;
    this.invId = 0;
    this.enchantOffer = null;
    this.anvilName = '';
    this.commandTarget = null;
  }

  // ==========================================================================
  init() {
    this.hud = $('#hud');
    this.hotbarEl = $('#hotbar');
    this.heldNameEl = $('#held-name');
    this.heartsEl = $('#hearts');
    this.armorEl = $('#armor');
    this.hungerEl = $('#hunger');
    this.airEl = $('#air');
    this.xpFill = $('#xp-fill');
    this.xpLevelEl = $('#xp-level');
    this.effectsEl = $('#effect-list');
    this.chatLog = $('#chat-log');
    this.chatInput = $('#chat-input');
    this.toastEl = $('#toast');
    this.subtitleEl = $('#subtitle');
    this.menuRoot = $('#menu-root');
    this.bossBar = $('#boss-bar');
    this.touchEl = $('#touch');
    this.loadingEl = $('#loading');
    this.debugEl = el('div', 'debug-overlay hidden', this.hud);

    this.buildHotbar();
    this.buildStatusIcons();
    this.bindGlobalEvents();
    if (this.isTouch()) this.setupTouch();
    this.hud.classList.remove('hidden');
    return this;
  }

  isTouch() { return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0); }

  icon(name) {
    const t = this.game.renderer.textures;
    return t.iconCSS(name);
  }

  // -------------------------------------------------------------------------
  buildHotbar() {
    this.hotbarEl.innerHTML = '';
    this.hotbarSlots = [];
    for (let i = 0; i < 9; i++) {
      const s = el('div', 'slot hotbar-slot', this.hotbarEl);
      const icon = el('div', 'icon', s);
      const count = el('span', 'count', s);
      const num = el('span', 'key', s);
      num.textContent = String(i + 1);
      s.addEventListener('mousedown', (e) => this.onSlotClick(e, 'player', i));
      s.addEventListener('contextmenu', (e) => e.preventDefault());
      s.addEventListener('mouseenter', () => this.showTooltip(this.game.player.inventory.get(i)));
      s.addEventListener('mouseleave', () => this.hideTooltip());
      this.hotbarSlots.push({ node: s, icon, count });
    }
  }

  buildStatusIcons() {
    this.heartNodes = [];
    this.hungerNodes = [];
    this.armorNodes = [];
    for (let i = 0; i < 10; i++) {
      const h = el('div', 'heart full', this.heartsEl); this.heartNodes.push(h);
      const f = el('div', 'hunger full', this.hungerEl); this.hungerNodes.push(f);
    }
    for (let i = 0; i < 10; i++) this.armorNodes.push(el('div', 'shield empty', this.armorEl));
  }

  bindGlobalEvents() {
    window.addEventListener('resize', () => this.markDirty('all'));
    document.addEventListener('keydown', (e) => {
      if (this.chatOpen) {
        if (e.key === 'Enter') this.submitChat();
        else if (e.key === 'Escape') this.closeChat();
        else if (e.key === 'Tab') { e.preventDefault(); this.completeChat(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); this.chatInput.value = this.game.commands.historyUp(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); this.chatInput.value = this.game.commands.historyDown(); }
        return;
      }
      if (this.screen === 'command_block' && e.key === 'Escape') this.closeScreen();
    });
    // mouse cursor stack follows the pointer
    window.addEventListener('mousemove', (e) => {
      if (!this.cursorNode) return;
      this.cursorNode.style.left = e.clientX + 'px';
      this.cursorNode.style.top = e.clientY + 'px';
    });
  }

  // ==========================================================================
  //  HUD
  // ==========================================================================
  update(dt) {
    if (this.dirty.has('all') || this.dirty.has('health')) this.renderHealth();
    if (this.dirty.has('all') || this.dirty.has('hunger')) this.renderHunger();
    if (this.dirty.has('all') || this.dirty.has('armor')) this.renderArmor();
    if (this.dirty.has('all') || this.dirty.has('hotbar')) this.renderHotbar();
    if (this.dirty.has('all') || this.dirty.has('xp')) this.renderXp();
    if (this.dirty.has('all') || this.dirty.has('effects')) this.renderEffects();
    if (this.dirty.has('all') || this.dirty.has('screen')) this.renderScreen();
    this.updateMessages(dt);
    this.updateDebug();
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.remove('show');
    }
    if (this.dirty.has('all')) this.dirty.clear();
    this.dirty.clear();
  }

  markDirty(what) { this.dirty.add(what); }

  renderHealth() {
    const p = this.game.player;
    const hp = p.health;
    for (let i = 0; i < 10; i++) {
      const v = hp - i * 2;
      const n = this.heartNodes[i];
      n.className = 'heart ' + (v >= 2 ? 'full' : v === 1 ? 'half' : 'empty');
    }
    // absorption hearts
    const absorb = p.effects.has('absorption') ? p.effects.get('absorption').amplifier + 1 : 0;
    this.heartsEl.title = `${Math.ceil(hp)} / ${p.maxHealth}`;
  }

  renderHunger() {
    const p = this.game.player;
    for (let i = 0; i < 10; i++) {
      const v = p.hunger - i * 2;
      this.hungerNodes[i].className = 'hunger ' + (v >= 2 ? 'full' : v === 1 ? 'half' : 'empty');
    }
  }

  renderArmor() {
    const p = this.game.player;
    const v = p.getArmorValue();
    for (let i = 0; i < 10; i++) {
      const s = v - i * 2;
      this.armorNodes[i].className = 'shield ' + (s >= 2 ? 'full' : s === 1 ? 'half' : 'empty');
    }
  }

  renderHotbar() {
    const inv = this.game.player.inventory;
    for (let i = 0; i < 9; i++) {
      const s = inv.get(i);
      const node = this.hotbarSlots[i];
      node.node.classList.toggle('selected', i === inv.selected);
      this.paintSlot(node, s);
    }
    const held = inv.getHeld();
    this.heldNameEl.textContent = held ? held.displayName : '';
    this.heldNameEl.classList.remove('fade');
    if (held) {
      clearTimeout(this._heldTimer);
      this.heldNameEl.classList.add('show');
      this._heldTimer = setTimeout(() => this.heldNameEl.classList.remove('show'), 1600);
    }
  }

  renderXp() {
    const p = this.game.player;
    const frac = clamp(p.xp / p.xpForNextLevel(), 0, 1);
    this.xpFill.style.width = (frac * 100) + '%';
    this.xpLevelEl.textContent = String(p.xpLevel);
  }

  renderEffects() {
    const p = this.game.player;
    this.effectsEl.innerHTML = '';
    for (const [name, e] of p.effects) {
      const def = EFFECTS[name];
      if (!def) continue;
      const node = el('div', 'effect', this.effectsEl);
      const swatch = el('span', 'effect-dot', node);
      swatch.style.background = `rgb(${def.color.join(',')})`;
      el('span', 'effect-name', node).textContent = def.name + (e.amplifier ? ' ' + (e.amplifier + 1) : '');
      el('span', 'effect-time', node).textContent = formatTime(e.duration / 20);
    }
  }

  updateMessages(dt) {
    if (!this.messageNodes) this.messageNodes = [];
    const now = performance.now();
    for (let i = this.messageNodes.length - 1; i >= 0; i--) {
      const m = this.messageNodes[i];
      if (now - m.t > 8000) { m.node.remove(); this.messageNodes.splice(i, 1); }
    }
  }

  updateDebug() {
    const g = this.game;
    if (!g.debug || !this.hudVisible) { this.debugEl.classList.add('hidden'); return; }
    this.debugEl.classList.remove('hidden');
    const lines = g.getDebugText();
    if (this._dbgLines !== lines.join('\n')) {
      this._dbgLines = lines.join('\n');
      this.debugEl.innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
    }
  }

  setHudVisible(v) {
    this.hudVisible = v;
    this.hud.classList.toggle('no-hud', !v);
  }

  pushMessage(text) {
    const node = el('div', 'chat-msg', this.chatLog);
    node.innerHTML = escapeHtml(text);
    this.messageNodes = this.messageNodes || [];
    this.messageNodes.push({ node, t: performance.now() });
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  toast(text) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    this.toastTimer = 3;
  }

  // ==========================================================================
  //  chat
  // ==========================================================================
  openChat(prefix = '') {
    this.chatOpen = true;
    this.chatInput.value = prefix;
    this.chatInput.classList.add('active');
    this.chatInput.focus();
    this.chatInput.select();
    if (this.game.input) this.game.input.setEnabled(false);
  }

  closeChat() {
    this.chatOpen = false;
    this.chatInput.value = '';
    this.chatInput.classList.remove('active');
    this.chatInput.blur();
    if (this.game.input && !this.screen) this.game.input.setEnabled(true);
  }

  completeChat() {
    const v = this.chatInput.value;
    const opts = this.game.commands.complete(v);
    if (opts.length === 1) this.chatInput.value = opts[0] + ' ';
    else if (opts.length > 1) this.pushMessage(opts.slice(0, 12).join('  '));
  }

  submitChat() {
    const text = this.chatInput.value.trim();
    this.closeChat();
    if (!text) return;
    if (text.startsWith('/')) this.game.runCommand(text);
    else this.pushMessage('<Player> ' + escapeHtml(text));
  }

  // ==========================================================================
  //  screens
  // ==========================================================================
  openScreen(name, data = null) {
    this.screen = name;
    this.screenData = data;
    this.markDirty('screen');
    document.body.classList.add('in-menu');
  }

  closeScreen() {
    this.screen = null;
    this.screenData = null;
    this.menuRoot.innerHTML = '';
    this.slots = [];
    if (this.cursor) { this.game.player.inventory.add(this.cursor); this.cursor = null; }
    if (this.cursorNode) { this.cursorNode.remove(); this.cursorNode = null; }
    document.body.classList.remove('in-menu');
    if (this.game.input) this.game.input.setEnabled(true);
    this.markDirty('all');
  }

  renderScreen() {
    const g = this.game;
    this.menuRoot.innerHTML = '';
    this.slots = [];
    if (!this.screen) return;
    const wrap = el('div', 'screen ' + this.screen, this.menuRoot);
    switch (this.screen) {
      case 'inventory': this.buildInventoryScreen(wrap); break;
      case 'crafting': this.buildCraftingScreen(wrap); break;
      case 'chest': case 'trapped_chest': case 'barrel': case 'hopper': case 'dispenser': case 'dropper':
        this.buildContainerScreen(wrap, this.screenData); break;
      case 'furnace': case 'blast_furnace': case 'smoker': this.buildFurnaceScreen(wrap, this.screenData); break;
      case 'brewing': this.buildBrewingScreen(wrap, this.screenData); break;
      case 'enchanting': this.buildEnchantingScreen(wrap); break;
      case 'anvil': this.buildAnvilScreen(wrap); break;
      case 'beacon': this.buildBeaconScreen(wrap, this.screenData); break;
      case 'jukebox': this.buildJukeboxScreen(wrap, this.screenData); break;
      case 'ender_chest': this.buildEnderChestScreen(wrap); break;
      case 'pause': this.buildPauseScreen(wrap); break;
      case 'settings': this.buildSettingsScreen(wrap); break;
      case 'command_block': this.buildCommandBlockScreen(wrap); break;
      default: this.buildInventoryScreen(wrap);
    }
  }

  /** Create a slot grid bound to an inventory. */
  makeGrid(parent, inv, id, count, cols, cls = '') {
    const grid = el('div', 'grid ' + cls, parent);
    for (let i = 0; i < count; i++) {
      const s = el('div', 'slot', grid);
      const icon = el('div', 'icon', s);
      const countEl = el('span', 'count', s);
      s.addEventListener('mousedown', (e) => this.onSlotClick(e, id, i));
      s.addEventListener('contextmenu', (e) => e.preventDefault());
      s.addEventListener('mouseenter', () => this.showTooltip(inv.get(i)));
      s.addEventListener('mouseleave', () => this.hideTooltip());
      this.slots.push({ node: s, icon, count: countEl, inv, index: i, id });
    }
    return grid;
  }

  refreshGrids() {
    for (const s of this.slots) this.paintSlot(s, s.inv.get(s.index));
    if (this.screen === 'inventory' || this.screen === 'crafting') this.refreshCrafting();
    if (this.screen === 'furnace' || this.screen === 'blast_furnace' || this.screen === 'smoker') this.refreshFurnace();
    if (this.screen === 'enchanting') this.refreshEnchanting();
  }

  paintSlot(slot, stack) {
    if (!stack || stack.count <= 0) {
      slot.icon.style.background = 'none';
      slot.count.textContent = '';
      slot.node.classList.remove('has-item');
      return;
    }
    const def = stack.def;
    const css = this.icon(def.name);
    slot.icon.style.background = css || 'none';
    slot.icon.style.backgroundSize = 'auto';
    slot.count.textContent = stack.count > 1 ? String(stack.count) : '';
    slot.node.classList.add('has-item');
    if (stack.damage > 0 && stack.maxDamage) {
      const f = 1 - stack.damage / stack.maxDamage;
      slot.node.style.setProperty('--durability', f.toFixed(2));
      slot.node.classList.add('damaged');
    } else slot.node.classList.remove('damaged');
  }

  onSlotClick(e, invId, index) {
    e.preventDefault();
    e.stopPropagation();
    const g = this.game;
    const inv = this.inventoryById(invId);
    if (!inv) return;
    const right = e.button === 2;
    const shift = e.shiftKey;
    const slot = inv.get(index);
    if (shift && slot) {
      // quick transfer
      const target = invId === 'player' ? (this.containerInventory() || g.craftGrid) : g.player.inventory;
      const left = target.add(slot);
      if (left === 0) inv.set(index, null); else slot.count = left;
      inv.changed();
      this.refreshGrids();
      this.markDirty('hotbar');
      return;
    }
    if (this.cursor) {
      if (slot) {
        if (right && slot.canStack(this.cursor) && slot.count < slot.maxStack) {
          slot.count++; this.cursor.count--;
          if (this.cursor.count <= 0) this.cursor = null;
        } else if (slot.canStack(this.cursor)) {
          const space = Math.min(slot.maxStack, this.cursor.maxStack) - slot.count;
          const move = Math.min(space, this.cursor.count);
          slot.count += move; this.cursor.count -= move;
          if (this.cursor.count <= 0) this.cursor = null;
        } else {
          inv.set(index, this.cursor);
          this.cursor = slot;
        }
      } else {
        if (right) {
          const one = new ItemStack(this.cursor.id, 1);
          if (this.cursor.ench) one.ench = new Map(this.cursor.ench);
          inv.set(index, one);
          this.cursor.count--;
          if (this.cursor.count <= 0) this.cursor = null;
        } else {
          inv.set(index, this.cursor);
          this.cursor = null;
        }
      }
    } else if (slot) {
      if (right) {
        const half = Math.ceil(slot.count / 2);
        this.cursor = new ItemStack(slot.id, half);
        if (slot.ench) this.cursor.ench = new Map(slot.ench);
        slot.count -= half;
        if (slot.count <= 0) inv.set(index, null);
      } else {
        this.cursor = slot;
        inv.set(index, null);
      }
    }
    inv.changed();
    this.updateCursorNode();
    this.refreshGrids();
    this.markDirty('hotbar');
    if (this.screen === 'inventory' || this.screen === 'crafting') this.game.updateCrafting();
  }

  inventoryById(id) {
    const g = this.game;
    if (id === 'player') return g.player.inventory;
    if (id === 'craft') return g.craftGrid;
    if (id === 'container') return this.containerInventory();
    if (id === 'armor') return null;
    return null;
  }

  containerInventory() {
    const te = this.game.openTile || this.screenData;
    return te && te.inv ? te.inv : null;
  }

  updateCursorNode() {
    if (!this.cursorNode) {
      this.cursorNode = el('div', 'cursor-stack', document.body);
    }
    if (!this.cursor || this.cursor.count <= 0) {
      this.cursorNode.classList.remove('active');
      this.cursor = null;
      return;
    }
    this.cursorNode.classList.add('active');
    this.cursorNode.style.background = this.icon(this.cursor.def.name) || 'none';
    this.cursorNode.textContent = this.cursor.count > 1 ? this.cursor.count : '';
  }

  showTooltip(stack) {
    if (!stack) return;
    let tip = this.tooltipEl;
    if (!tip) { tip = this.tooltipEl = el('div', 'tooltip', document.body); }
    tip.innerHTML = `<b>${escapeHtml(stack.displayName)}</b>` +
      (stack.ench ? '<br>' + [...stack.ench].map(([k, v]) => `<i>${escapeHtml(k)} ${v}</i>`).join(', ') : '') +
      (stack.maxDamage ? `<br><span class="dur">Durability ${stack.maxDamage - stack.damage} / ${stack.maxDamage}</span>` : '');
    tip.classList.add('show');
  }

  hideTooltip() { if (this.tooltipEl) this.tooltipEl.classList.remove('show'); }

  slotGrid(node) { return node; }

  // -------------------------------------------------------------------------
  buildInventoryScreen(wrap) {
    const g = this.game;
    el('div', 'screen-title', wrap).textContent = 'Inventory';
    const body = el('div', 'screen-body', wrap);
    const left = el('div', 'screen-col', body);
    const right = el('div', 'screen-col', body);

    // 2x2 crafting
    el('div', 'section-title', left).textContent = 'Crafting';
    this.makeGrid(left, g.craftGrid, 'craft', 9, 3, 'grid-2x2');
    const arrow = el('div', 'craft-arrow', left);
    arrow.textContent = '→';
    const out = el('div', 'grid grid-out', left);
    this.craftOut = el('div', 'slot', out);
    this.craftOutIcon = el('div', 'icon', this.craftOut);
    this.craftOut.addEventListener('mousedown', (e) => this.takeCraftResult(e));
    el('div', 'section-title', left).textContent = 'Recipe book';
    this.recipeList = el('div', 'recipe-list', left);
    this.buildRecipeBook(this.recipeList);

    // player inventory
    el('div', 'section-title', right).textContent = 'Inventory';
    this.makeGrid(right, g.player.inventory, 'player', 36, 9, 'grid-player');
    this.refreshCrafting();
  }

  buildCraftingScreen(wrap) {
    const g = this.game;
    el('div', 'screen-title', wrap).textContent = 'Crafting Table';
    const body = el('div', 'screen-body', wrap);
    const left = el('div', 'screen-col', body);
    const right = el('div', 'screen-col', body);
    el('div', 'section-title', left).textContent = 'Crafting';
    this.makeGrid(left, g.craftGrid, 'craft', 9, 3, 'grid-3x3');
    const arrow = el('div', 'craft-arrow', left);
    arrow.textContent = '→';
    const out = el('div', 'grid grid-out', left);
    this.craftOut = el('div', 'slot', out);
    this.craftOutIcon = el('div', 'icon', this.craftOut);
    this.craftOut.addEventListener('mousedown', (e) => this.takeCraftResult(e));
    this.recipeList = el('div', 'recipe-list', left);
    this.buildRecipeBook(this.recipeList);
    el('div', 'section-title', right).textContent = 'Inventory';
    this.makeGrid(right, g.player.inventory, 'player', 36, 9, 'grid-player');
    this.refreshCrafting();
  }

  buildContainerScreen(wrap, te) {
    const g = this.game;
    const title = (te && te.label) || 'Container';
    el('div', 'screen-title', wrap).textContent = title;
    const body = el('div', 'screen-body column', wrap);
    if (te && te.inv) this.makeGrid(body, te.inv, 'container', te.inv.size, 9, 'grid-container');
    el('div', 'section-title', body).textContent = 'Inventory';
    this.makeGrid(body, g.player.inventory, 'player', 36, 9, 'grid-player');
    this.refreshGrids();
  }

  buildFurnaceScreen(wrap, te) {
    const g = this.game;
    el('div', 'screen-title', wrap).textContent = (te && te.label) || 'Furnace';
    const body = el('div', 'screen-body column', wrap);
    const top = el('div', 'furnace-row', body);
    if (te && te.inv) {
      this.makeGrid(top, te.inv, 'container', 1, 1, 'grid-single slot-input');
      this.fireNode = el('div', 'fire', top);
      this.makeGrid(top, te.inv, 'container', 1, 1, 'grid-single slot-fuel');
    }
    const arrowBox = el('div', 'furnace-arrow', top);
    this.progressNode = el('div', 'furnace-progress', arrowBox);
    el('div', 'section-title', body).textContent = 'Inventory';
    this.makeGrid(body, g.player.inventory, 'player', 36, 9, 'grid-player');
    this.refreshFurnace();
  }

  refreshFurnace() {
    const te = this.game.openTile || this.screenData;
    if (!te) return;
    // remap the two single grids to slots 0 and 1
    const grids = this.slots.filter((s) => s.id === 'container');
    if (grids[0]) { grids[0].index = 0; this.paintSlot(grids[0], te.inv.get(0)); }
    if (grids[1]) { grids[1].index = 1; this.paintSlot(grids[1], te.inv.get(1)); }
    // output (slot 2) rendered separately
    if (!this.outSlot) {
      const out = el('div', 'slot slot-output', this.menuRoot.querySelector('.furnace-row'));
      this.outSlot = { node: out, icon: el('div', 'icon', out), count: el('span', 'count', out), inv: te.inv, index: 2, id: 'container' };
      out.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const s = te.inv.get(2);
        if (!s) return;
        const left = this.cursor ? this.cursor.count : 0;
        if (this.cursor && this.cursor.id !== s.id) return;
        const add = this.cursor || new ItemStack(s.id, 0);
        add.id = s.id;
        const space = s.maxStack - add.count;
        const move = Math.min(space, s.count);
        add.count += move; s.count -= move;
        if (s.count <= 0) te.inv.set(2, null);
        if (!this.cursor) this.cursor = add.count > 0 ? add : null;
        this.updateCursorNode();
        te.inv.changed();
        this.refreshFurnace();
      });
    }
    this.paintSlot(this.outSlot, te.inv.get(2));
    if (this.progressNode) this.progressNode.style.width = ((te.cookTime / te.cookTotal) * 100) + '%';
    if (this.fireNode) this.fireNode.style.height = ((te.burnTime / Math.max(1, te.burnTotal)) * 100) + '%';
  }

  buildBrewingScreen(wrap, te) {
    const g = this.game;
    el('div', 'screen-title', wrap).textContent = 'Brewing Stand';
    const body = el('div', 'screen-body column', wrap);
    if (te && te.inv) this.makeGrid(body, te.inv, 'container', 5, 3, 'grid-brewing');
    el('div', 'section-title', body).textContent = 'Inventory';
    this.makeGrid(body, g.player.inventory, 'player', 36, 9, 'grid-player');
    this.refreshGrids();
  }

  buildEnderChestScreen(wrap) {
    const g = this.game;
    el('div', 'screen-title', wrap).textContent = 'Ender Chest';
    const body = el('div', 'screen-body column', wrap);
    if (!this.enderInv) this.enderInv = new (g.player.inventory.constructor)(27, 0);
    this.makeGrid(body, this.enderInv, 'container', 27, 9, 'grid-container');
    el('div', 'section-title', body).textContent = 'Inventory';
    this.makeGrid(body, g.player.inventory, 'player', 36, 9, 'grid-player');
    this.refreshGrids();
  }

  buildJukeboxScreen(wrap, te) {
    const g = this.game;
    el('div', 'screen-title', wrap).textContent = 'Jukebox';
    const body = el('div', 'screen-body column', wrap);
    const list = el('div', 'recipe-list', body);
    for (const it of ITEMS) {
      if (!/^music_disc/.test(it.name)) continue;
      const row = el('div', 'recipe-row', list);
      row.innerHTML = `<span class="recipe-name">${escapeHtml(it.label || it.name)}</span>`;
      row.addEventListener('click', () => {
        if (te) { te.disc = it.id; te.playing = 180; if (te.inv) { te.inv.set(0, new ItemStack(it.id, 1)); } }
        this.game.audio.play('note', this.game.player.pos[0], this.game.player.pos[1], this.game.player.pos[2], { note: 12 });
        this.closeScreen();
      });
    }
    this.refreshGrids();
  }

  // -------------------------------------------------------------------------
  refreshCrafting() {
    const g = this.game;
    const r = g.updateCrafting();
    if (!this.craftOutIcon) return;
    if (r) {
      this.craftOutIcon.style.background = this.icon(getItem(r.result).name) || 'none';
      this.craftOut.classList.add('has-item');
    } else {
      this.craftOutIcon.style.background = 'none';
      this.craftOut.classList.remove('has-item');
    }
  }

  takeCraftResult(e) {
    e.preventDefault();
    const g = this.game;
    if (!g.selectedRecipe) return;
    if (this.cursor && (this.cursor.id !== g.selectedRecipe.result || this.cursor.count + g.selectedRecipe.count > this.cursor.maxStack)) return;
    const made = g.craft(!!e.shiftKey);
    if (made > 0) {
      if (!this.cursor) this.cursor = new ItemStack(g.selectedRecipe.result, made);
      else this.cursor.count += made;
      this.updateCursorNode();
      this.refreshGrids();
      this.markDirty('hotbar');
      g.audio.play('click');
    }
  }

  buildRecipeBook(parent) {
    const g = this.game;
    const inv = g.player.inventory;
    // browsable list of every item; click to grab it in creative mode
    const search = el('input', 'search', parent);
    search.placeholder = 'Search items…';
    const listEl = el('div', 'recipe-rows', parent);
    const render = (filter = '') => {
      listEl.innerHTML = '';
      let n = 0;
      for (const it of ITEMS) {
        if (!it || !it.id || !it.name) continue;
        if (filter && !it.name.includes(filter.toLowerCase())) continue;
        if (n++ > 300) break;
        const row = el('div', 'recipe-row', listEl);
        const ic = el('span', 'row-icon', row);
        ic.style.background = this.icon(it.name) || 'none';
        el('span', 'recipe-name', row).textContent = it.label || it.name;
        row.addEventListener('click', () => {
          if (g.player.gamemode === GAMEMODE.CREATIVE) {
            const left = inv.add(new ItemStack(it.id, it.stack || 64));
            if (left) g.dropItem(g.player.pos[0], g.player.pos[1] + 1, g.player.pos[2], new ItemStack(it.id, left));
            this.refreshGrids();
            this.markDirty('hotbar');
          } else {
            this.toast('Creative only');
          }
        });
      }
    };
    search.addEventListener('input', () => render(search.value));
    render();
  }

  // -------------------------------------------------------------------------
  buildEnchantingScreen(wrap) {
    const g = this.game;
    el('div', 'screen-title', wrap).textContent = 'Enchanting Table';
    const body = el('div', 'screen-body column', wrap);
    const slotRow = el('div', 'enchant-row', body);
    const s = el('div', 'slot slot-input', slotRow);
    this.enchantSlot = { node: s, icon: el('div', 'icon', s), count: el('span', 'count', s) };
    s.addEventListener('mousedown', (e) => this.onSlotClick(e, 'player', g.player.inventory.selected));
    this.enchantOptions = el('div', 'enchant-options', body);
    el('div', 'section-title', body).textContent = 'Inventory';
    this.makeGrid(body, g.player.inventory, 'player', 36, 9, 'grid-player');
    this.refreshEnchanting();
  }

  refreshEnchanting() {
    const g = this.game;
    const held = g.player.inventory.getHeld();
    this.paintSlot(this.enchantSlot, held);
    this.enchantOptions.innerHTML = '';
    if (!held) { this.enchantOptions.textContent = 'Hold an item to enchant'; return; }
    if (!this.enchantSeed) this.enchantSeed = Math.floor(Math.random() * 1e9);
    const levels = g.player.xpLevel;
    const opts = [
      { level: Math.max(1, Math.min(30, Math.floor(levels * 0.4))), cost: 1 },
      { level: Math.max(1, Math.min(30, Math.floor(levels * 0.7))), cost: 2 },
      { level: Math.max(1, Math.min(30, levels)), cost: 3 },
    ];
    opts.forEach((o, i) => {
      const btn = el('div', 'enchant-option', this.enchantOptions);
      btn.innerHTML = `<span class="lvl">${o.level}</span><span class="cost">${o.cost} <i class="xpdot"></i></span>`;
      btn.title = 'Enchant';
      btn.addEventListener('click', () => {
        if (g.player.xpLevel < o.cost) { this.toast('Not enough levels'); return; }
        g.player.takeXpLevels(o.cost);
        const got = g.applyEnchant(held, o.level);
        if (got) this.toast(`${got.name.replace(/_/g, ' ')} ${romanNumeral(got.level)}`);
        g.player.inventory.changed();
        g.audio.play('level_up');
        this.enchantSeed = Math.floor(Math.random() * 1e9);
        this.refreshEnchanting();
        this.markDirty('all');
      });
    });
  }

  // -------------------------------------------------------------------------
  buildAnvilScreen(wrap) {
    const g = this.game;
    el('div', 'screen-title', wrap).textContent = 'Anvil';
    const body = el('div', 'screen-body column', wrap);
    const row = el('div', 'anvil-row', body);
    const left = el('div', 'slot', row);
    this.anvilLeft = { node: left, icon: el('div', 'icon', left), count: el('span', 'count', left) };
    left.addEventListener('mousedown', (e) => this.onSlotClick(e, 'player', g.player.inventory.selected));
    const plus = el('div', 'anvil-plus', row); plus.textContent = '+';
    const right = el('div', 'slot', row);
    this.anvilRight = { node: right, icon: el('div', 'icon', right), count: el('span', 'count', right) };
    right.addEventListener('mousedown', (e) => this.onSlotClick(e, 'player', (g.player.inventory.selected + 1) % 9));
    const nameInput = el('input', 'anvil-name', body);
    nameInput.placeholder = 'Rename item';
    nameInput.maxLength = 30;
    const btn = el('button', 'btn primary', body);
    btn.textContent = 'Repair / Combine';
    btn.addEventListener('click', () => this.doAnvil(nameInput.value));
    el('div', 'section-title', body).textContent = 'Inventory';
    this.makeGrid(body, g.player.inventory, 'player', 36, 9, 'grid-player');
    this.paintSlot(this.anvilLeft, g.player.inventory.getHeld());
    this.paintSlot(this.anvilRight, g.player.inventory.get((g.player.inventory.selected + 1) % 9));
  }

  doAnvil(name) {
    const g = this.game;
    const a = g.player.inventory.getHeld();
    if (!a) return;
    const cost = 1;
    if (g.player.xpLevel < cost) { this.toast('Not enough levels'); return; }
    g.player.takeXpLevels(cost);
    if (name) a.name = name;
    g.player.inventory.changed();
    g.audio.play('anvil_land');
    this.closeScreen();
    this.markDirty('all');
  }

  // -------------------------------------------------------------------------
  buildBeaconScreen(wrap, te) {
    const g = this.game;
    el('div', 'screen-title', wrap).textContent = 'Beacon';
    const body = el('div', 'screen-body column', wrap);
    const info = el('div', 'beacon-info', body);
    info.textContent = `Pyramid level ${te ? te.levels : 0}`;
    const list = el('div', 'beacon-effects', body);
    const effects = ['speed', 'haste', 'resistance', 'jump_boost', 'strength', 'regeneration'];
    effects.forEach((name, i) => {
      const btn = el('div', 'beacon-effect', list);
      btn.textContent = EFFECTS[name] ? EFFECTS[name].name : name;
      btn.addEventListener('click', () => {
        if (!te || te.levels <= 0) { this.toast('Build a pyramid first'); return; }
        te.primary = i;
        this.closeScreen();
        g.message('Beacon effect set to ' + btn.textContent);
      });
    });
  }

  // -------------------------------------------------------------------------
  buildPauseScreen(wrap) {
    const g = this.game;
    el('div', 'screen-title', wrap).textContent = 'Paused';
    const menu = el('div', 'menu-buttons', wrap);
    const btn = (label, fn, cls = 'btn') => {
      const b = el('button', cls, menu);
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    };
    btn('Back to Game', () => { g.paused = false; this.closeScreen(); g.input.requestLock(); }, 'btn primary');
    btn('Settings', () => this.openScreen('settings'));
    btn('Change Game Mode', () => {
      const modes = Object.values(GAMEMODE);
      const i = modes.indexOf(g.player.gamemode);
      g.setGamemode(modes[(i + 1) % modes.length]);
      this.toast('Game mode: ' + g.player.gamemode);
    });
    btn('Save & Quit', async () => {
      await g.save();
      g.stop();
      location.reload();
    });
    btn('Save World', () => g.save());
    el('div', 'menu-hint', wrap).innerHTML = 'Controls: WASD move &middot; Space jump &middot; Shift sneak &middot; Ctrl sprint &middot; E inventory &middot; T chat &middot; F3 debug &middot; F5 camera';
  }

  buildSettingsScreen(wrap) {
    const g = this.game;
    el('div', 'screen-title', wrap).textContent = 'Settings';
    const body = el('div', 'settings', wrap);
    const row = (label, node) => {
      const r = el('div', 'setting', body);
      el('span', 'setting-label', r).textContent = label;
      r.appendChild(node);
      return r;
    };
    const slider = (min, max, step, value, onInput) => {
      const i = el('input', 'slider', null);
      i.type = 'range'; i.min = min; i.max = max; i.step = step; i.value = value;
      i.addEventListener('input', () => onInput(parseFloat(i.value)));
      return i;
    };
    const select = (options, value, onChange) => {
      const s = el('select', null);
      for (const o of options) {
        const op = el('option', null, s);
        op.value = o; op.textContent = o;
      }
      s.value = value;
      s.addEventListener('change', () => onChange(s.value));
      return s;
    };
    const check = (value, onChange) => {
      const c = el('input', null);
      c.type = 'checkbox'; c.checked = !!value;
      c.addEventListener('change', () => onChange(c.checked));
      return c;
    };

    row('Graphics', select(Object.keys(QUALITY_PRESETS), g.opts.quality || 'fancy', (v) => {
      g.opts.quality = v;
      g.renderer.setQuality(v);
      g.renderer.markAllDirty();
    }));
    row('Render distance', slider(2, 24, 1, g.world.renderDistance, (v) => {
      g.world.renderDistance = v;
      g.renderer.quality.renderDistance = v;
      for (const w of g.worlds.values()) w.renderDistance = v;
    }));
    row('Texture size', slider(16, 64, 16, g.renderer.textures.size, (v) => {
      g.renderer.textures.build(v, 'fancy');
      g.renderer.markAllDirty();
    }));
    row('FOV', slider(50, 110, 1, g.renderer.quality.fov || 70, (v) => { g.renderer.quality.fov = v; }));
    row('Mouse sensitivity', slider(0.0005, 0.006, 0.0001, g.input.sensitivity, (v) => g.input.setSensitivity(v)));
    row('Master volume', slider(0, 1, 0.05, g.audio.volume, (v) => g.audio.setVolume(v)));
    row('Music volume', slider(0, 1, 0.05, g.audio.musicVolume, (v) => g.audio.setMusicVolume(v)));
    row('Music', check(g.audio.musicOn, (v) => g.audio.setMusic(v)));
    row('View bobbing', check(g.opts.viewBobbing !== false, (v) => { g.opts.viewBobbing = v; }));
    row('Show FPS', check(g.debug, (v) => { g.debug = v; }));
    row('Difficulty', select(['peaceful', 'easy', 'normal', 'hard'], g.difficulty, (v) => { g.difficulty = v; }));
    row('Random tick speed', slider(0, 10, 1, g.gamerules.randomTickSpeed, (v) => { g.gamerules.randomTickSpeed = v; }));

    const back = el('button', 'btn primary', wrap);
    back.textContent = 'Back';
    back.addEventListener('click', () => this.openScreen('pause'));
  }

  buildCommandBlockScreen(wrap) {
    const g = this.game;
    el('div', 'screen-title', wrap).textContent = 'Command Block';
    const ta = el('textarea', 'command-input', wrap);
    const data = g.world.getTileEntity(this.commandTarget[0], this.commandTarget[1], this.commandTarget[2]) || {};
    ta.value = data.command || '';
    const save = el('button', 'btn primary', wrap);
    save.textContent = 'Save Command';
    save.addEventListener('click', () => {
      g.world.addTileEntity(this.commandTarget[0], this.commandTarget[1], this.commandTarget[2], {
        id: g.world.getBlock(this.commandTarget[0], this.commandTarget[1], this.commandTarget[2]),
        x: this.commandTarget[0], y: this.commandTarget[1], z: this.commandTarget[2], command: ta.value,
      });
      this.closeScreen();
    });
  }

  openCommandBlock(x, y, z) {
    this.commandTarget = [x, y, z];
    this.openScreen('command_block');
  }

  // -------------------------------------------------------------------------
  showDeathScreen(message) {
    const g = this.game;
    this.deathEl = el('div', 'death-screen', this.menuRoot);
    this.deathEl.innerHTML = `<div class="death-title">You Died!</div><div class="death-msg">${escapeHtml(message || '')}</div>`;
    const row = el('div', 'death-buttons', this.deathEl);
    const respawn = el('button', 'btn primary', row);
    respawn.textContent = 'Respawn';
    respawn.addEventListener('click', () => { g.respawnPlayer(); });
    const menu = el('button', 'btn', row);
    menu.textContent = 'Title Screen';
    menu.addEventListener('click', () => location.reload());
    document.body.classList.add('in-menu');
    if (g.input) g.input.setEnabled(false);
  }

  hideDeathScreen() {
    if (this.deathEl) { this.deathEl.remove(); this.deathEl = null; }
    document.body.classList.remove('in-menu');
    if (this.game.input) this.game.input.setEnabled(true);
  }

  showSleepOverlay(on) {
    if (on) {
      this.sleepEl = el('div', 'sleep-overlay', this.root);
      this.sleepEl.innerHTML = '<div>Leave bed</div>';
      this.sleepEl.addEventListener('click', () => { this.game.sleeping = null; this.showSleepOverlay(false); });
    } else if (this.sleepEl) { this.sleepEl.remove(); this.sleepEl = null; }
  }

  // ==========================================================================
  //  loading & title
  // ==========================================================================
  setLoading(progress, text) {
    if (!this.loadingEl) return;
    const fill = $('#loading-fill', this.loadingEl);
    const label = $('#loading-text', this.loadingEl);
    if (fill) fill.style.width = Math.round(progress * 100) + '%';
    if (label) label.textContent = text || '';
  }

  hideLoading() {
    if (this.loadingEl) this.loadingEl.classList.add('done');
    setTimeout(() => { if (this.loadingEl) this.loadingEl.style.display = 'none'; }, 600);
  }

  // ==========================================================================
  //  touch controls
  // ==========================================================================
  setupTouch() {
    this.touchEl.classList.remove('hidden');
    const btns = this.touchEl.querySelectorAll('.tbtn');
    btns.forEach((b) => {
      const act = b.dataset.act;
      const set = (v) => {
        if (act === 'jump') this.game.input.state.jump = v;
        if (act === 'sneak') this.game.input.state.sneak = v;
        if (act === 'fly') { if (v) { this.game.player.flying = !this.game.player.flying; this.game.player.canFly = true; } }
        if (act === 'inv') { if (v) this.game.toggleInventory(); }
      };
      b.addEventListener('touchstart', (e) => { e.preventDefault(); set(true); b.classList.add('down'); });
      b.addEventListener('touchend', (e) => { e.preventDefault(); set(false); b.classList.remove('down'); });
    });
    document.body.classList.add('touch-device');
  }
}

function romanNumeral(n) {
  return ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n] || String(n);
}

function formatTime(sec) {
  if (sec < 0) return '∞';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default UI;
