/**
 * Ultracraft - the game.
 *
 * Owns the simulation: player, entities, mob spawning, block interaction,
 * crafting, tile entities, redstone, the day/night cycle, weather, commands
 * and saving. Rendering is delegated to `Renderer`; everything here runs at a
 * fixed 20 ticks per second with interpolated rendering.
 */

import { World } from '../world/world.js';
import { getBlock, blockId, BLOCKS, AIR, Shape, Pass } from '../world/blocks.js';
import { getItem, itemId, ITEMS, ItemType, registerSpawnEgg } from '../world/items.js';
import { Player, GAMEMODE } from '../entity/player.js';
import { Mob, MOB_DEFS, PASSIVE_MOBS, HOSTILE_MOBS } from '../entity/mobs.js';
import { ItemEntity, XpOrb, Projectile, FallingBlock, PrimedTnt } from '../entity/drops.js';
import { Inventory, ItemStack, ContainerInventory } from './inventory.js';
import { matchRecipe, consumeIngredients, FUELS, fuelValue, FURNACE, recipeCount } from './recipes.js';
import { createTileEntity, restoreTileEntity, isContainerBlock } from './tileentities.js';
import { Redstone } from './redstone.js';
import { CommandSystem } from './commands.js';
import { SaveSystem } from './save.js';
import { AudioEngine } from './audio.js';
import { Input } from './input.js';
import { Renderer, QUALITY_PRESETS } from '../render/renderer.js';
import { clamp, lerp, makeRng } from '../core/math.js';

const TICK = 1 / 20;
const SEA_LEVEL = 64;

export class Game {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.seed = opts.seed ?? ('uc-' + Math.floor(Math.random() * 1e9).toString(36));
    this.worldId = opts.worldId || 'world';
    this.type = opts.type || 'default';         // default | flat | amplified | islands
    this.dimension = 'overworld';
    this.worlds = new Map();
    this.entities = [];
    this.particles = null;
    this.renderer = null;
    this.world = null;
    this.player = null;
    this.ui = opts.ui || null;

    // time
    this.dayTime = 1000;
    this.totalTime = 0;
    this.tickTimer = 0;
    this.ticks = 0;
    this.timeOfDay01 = 1000 / 24000;

    // weather
    this.weather = { mode: 'clear', rain: 0, thunder: 0, timer: 4000 + Math.random() * 8000, lightning: 0 };

    // rules
    this.gamerules = {
      doDaylightCycle: true, doWeatherCycle: true, doMobSpawning: true,
      doFireTick: true, doTileDrops: true, mobGriefing: true,
      keepInventory: false, naturalRegeneration: true, pvp: true,
      randomTickSpeed: 3, fallDamage: true, drowningDamage: true, fireDamage: true,
    };
    this.difficulty = opts.difficulty || 'normal';

    // state
    this.paused = false;
    this.screen = null;
    this.messages = [];
    this.debug = false;
    this.hudVisible = true;
    this.perspective = 0;
    this.profiler = { fps: 0, frames: 0, acc: 0, tickMs: 0, renderMs: 0 };
    this.breaking = null;
    this.breakingTime = 0;
    this.placeCooldown = 0;
    this.attackCooldown = 0;
    this.swimTimer = 0;
    this.stepTimer = 0;
    this.lastStepPos = [0, 0, 0];
    this.spawnTimer = 0;
    this.saveTimer = 0;
    this.autosaveTimer = 60;
    this.openInventory = null;
    this.openTile = null;
    this.craftGrid = new Inventory(9, 0);
    this.selectedRecipe = null;
    this.bossBar = null;
    this.statistics = { blocksBroken: 0, blocksPlaced: 0, mobsKilled: 0, deaths: 0, playTime: 0, distance: 0 };
    this.advancements = new Set();
    this.portalCooldown = 0;
    this.deathMessage = null;
    this.onLog = opts.onLog || (() => {});
    this.hitMarker = 0;
    this.damageFlash = 0;
    this.cameraShake = 0;
    this.timeScale = 1;
    this.rng = makeRng(12345);
  }

  // ==========================================================================
  //  boot
  // ==========================================================================
  async init(onProgress = () => {}) {
    const t0 = (performance || Date).now();
    onProgress(0.02, 'Creating renderer');
    this.renderer = new Renderer(this.canvas, { quality: QUALITY_PRESETS[this.opts.quality || 'fancy'] });
    this.renderer.quality.renderDistance = this.opts.renderDistance || this.renderer.quality.renderDistance;

    onProgress(0.15, 'Generating textures');
    const size = this.opts.textureSize || this.renderer.quality.textureSize || 16;
    this.renderer.textures.build(size, this.opts.textureQuality || 'fancy');
    this.registerSpawnEggs();

    onProgress(0.45, 'Building world');
    this.audio = new AudioEngine();
    this.commands = new CommandSystem(this);
    this.saveSystem = new SaveSystem();
    await this.saveSystem.init(this.worldId);

    this.world = this.getWorld('overworld');
    this.renderer.setWorld(this.world);
    this.particles = this.renderer.particles;
    this.redstone = new Redstone(this.world, this);

    onProgress(0.6, 'Finding a spawn point');
    const spawn = await this.findSpawn(this.world);
    this.player = new Player(this.world, spawn[0], spawn[1], spawn[2], this);
    this.player.inventory = new Inventory(36, 9);
    this.player.setSpawn(spawn[0], spawn[1], spawn[2]);
    this.player.onXpChanged = () => { if (this.ui) this.ui.markDirty('xp'); };
    this.player.onEffectsChanged = () => { if (this.ui) this.ui.markDirty('effects'); };
    this.entities.push(this.player);

    this.attachWorldHooks(this.world);

    onProgress(0.75, 'Loading save');
    await this.load();

    onProgress(0.85, 'Starting systems');
    this.input = new Input(this.canvas, { game: this, onAction: (a, v, e) => this.onAction(a, v, e) });
    this.input.setSensitivity(this.opts.sensitivity || 0.0022);
    this.lastTime = (performance || Date).now();
    this.running = true;

    // give a small starting kit in creative-ish sandbox worlds
    if (this.opts.starterKit !== false && this.player.gamemode === GAMEMODE.CREATIVE) this.giveStarterKit();

    onProgress(1, 'Ready');
    this.bootMs = (performance || Date).now() - t0;
    return this;
  }

  registerSpawnEggs() {
    for (const [name, def] of Object.entries(MOB_DEFS)) {
      if (def.egg === false) continue;
      registerSpawnEgg(name, def.color || [200, 200, 200]);
    }
  }

  giveStarterKit() {
    const inv = this.player.inventory;
    inv.addItem('crafting_table', 1);
    inv.addItem('oak_planks', 64);
    inv.addItem('torch', 32);
    inv.addItem('bread', 8);
    inv.addItem('diamond_pickaxe', 1);
    inv.addItem('diamond_axe', 1);
    inv.addItem('diamond_shovel', 1);
    inv.addItem('diamond_sword', 1);
  }

  attachWorldHooks(world) {
    world.game = this;
    world.entities = this.entities;
    world.players = [this.player];
    world.tileEntityAt = (x, y, z) => this.tileAt(x, y, z);
    world.nearestPlayer = (pos) => this.player;
    world.sweepEntities = (from, to, radius, exclude) => this.sweepEntities(from, to, radius, exclude);
    world.isSkyVisible = (x, y, z) => this.isSkyVisible(x, y, z);
    world.blockIds = {
      fire: blockId('fire'), water: blockId('water'), lava: blockId('lava'),
      nether_portal: blockId('nether_portal'), end_portal: blockId('end_portal'),
    };
    world.onBlockChangedCb = (x, y, z, prev, next) => this.onBlockChanged(x, y, z, prev, next);
    world.onRandomTickBlock = (x, y, z, id) => this.randomTickBlock(x, y, z, id);
    world.onSpawnerTick = null;
    world.onChunkUnload = (c) => {
      if (this.renderer) this.renderer.releaseChunkMeshes(c);
      if (c.needsSave) this.saveSystem.queueChunk(c, world.dimension);
      for (const [key, te] of world.tileEntities) {
        const [tx, ty, tz] = key.split(',').map(Number);
        if ((tx >> 4) === c.cx && (tz >> 4) === c.cz) world.tileEntities.delete(key);
      }
    };
    world.save = this.saveSystem;
  }

  getWorld(dimension) {
    if (this.worlds.has(dimension)) return this.worlds.get(dimension);
    const w = new World({
      seed: this.seed, dimension, type: this.type,
      renderDistance: this.opts.renderDistance || 8,
      workerCount: this.opts.workerCount,
      save: this.saveSystem,
    });
    w.dayTime = this.dayTime;
    this.worlds.set(dimension, w);
    return w;
  }

  /** Find a safe spawn column near the origin. */
  async findSpawn(world) {
    const rd = 48;
    for (let r = 0; r < rd; r += 4) {
      for (let i = 0; i < 12; i++) {
        const x = Math.round((Math.random() - 0.5) * r);
        const z = Math.round((Math.random() - 0.5) * r);
        const y = world.generator.heightAt(x, z);
        const top = world.generator.blockAt ? world.generator.blockAt(x, y - 1, z) : 0;
        if (y > SEA_LEVEL && y < world.height - 40) {
          return [x + 0.5, y + 1.2, z + 0.5];
        }
      }
    }
    return [0.5, SEA_LEVEL + 20, 0.5];
  }

  // ==========================================================================
  //  main loop
  // ==========================================================================
  start() {
    this.running = true;
    this.lastTime = (performance || Date).now();
    const loop = (now) => {
      if (!this.running) return;
      this.frame(now);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop() { this.running = false; if (this.rafId) cancelAnimationFrame(this.rafId); }

  frame(now) {
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (!isFinite(dt)) dt = 0;
    dt = Math.min(dt, 0.25);            // never simulate more than 250 ms at once
    this.profiler.acc += dt;
    this.profiler.frames++;
    if (this.profiler.acc >= 0.5) {
      this.profiler.fps = this.profiler.frames / this.profiler.acc;
      this.profiler.frames = 0; this.profiler.acc = 0;
    }
    if (!this.paused) {
      const t0 = performance.now();
      this.update(dt);
      this.profiler.tickMs = performance.now() - t0;
    }
    const t1 = performance.now();
    this.render(dt);
    this.profiler.renderMs = performance.now() - t1;
    if (this.ui) this.ui.update(dt);
  }

  update(dt) {
    this.statistics.playTime += dt;
    // fixed-step simulation
    this.tickTimer += dt * this.timeScale;
    let steps = 0;
    while (this.tickTimer >= TICK && steps < 6) {
      this.tickTimer -= TICK;
      this.tick(TICK);
      steps++;
    }
    if (steps === 6) this.tickTimer = 0;
    // continuous bits
    this.applyLook(dt);
    this.updateCamera(dt);
    this.updateParticles(dt);
    this.updateAudio(dt);
    this.renderer.updateMeshes(dt > 0.033 ? 2 : 4);
    this.saveSystem.update(dt);
    this.autosaveTimer -= dt;
    if (this.autosaveTimer <= 0) { this.autosaveTimer = 120; this.saveSystem.flush(); }
    if (this.damageFlash > 0) this.damageFlash -= dt * 2;
    if (this.hitMarker > 0) this.hitMarker -= dt * 4;
    if (this.cameraShake > 0) this.cameraShake = Math.max(0, this.cameraShake - dt * 3);
    if (this.portalCooldown > 0) this.portalCooldown -= dt;
  }

  /** One 50 ms simulation tick. */
  tick(dt) {
    this.ticks++;
    // world time
    if (this.gamerules.doDaylightCycle) {
      this.dayTime = (this.dayTime + 1) % 24000;
      this.world.dayTime = this.dayTime;
    }
    this.totalTime += 1;
    this.timeOfDay01 = this.dayTime / 24000;
    this.updateWeather(dt);

    // player
    if (!this.player.dead) this.applyMovement();
    this.player.update(dt);
    if (this.player.fallDistance > 0 && this.player.onGround && this.gamerules.fallDamage) {
      const d = this.player.fallDistance - 3;
      if (d > 0) this.player.hurt(d, 'fall');
      this.player.fallDistance = 0;
    }

    // entities
    const list = this.entities;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.removed) { list.splice(i, 1); continue; }
      if (e === this.player) continue;
      if (e.dead) {
        e.deathTime += dt;
        if (e.deathTime > 1.2) { list.splice(i, 1); this.onEntityRemoved(e); }
        continue;
      }
      // only simulate near the player
      const d2 = (e.pos[0] - this.player.pos[0]) ** 2 + (e.pos[2] - this.player.pos[2]) ** 2;
      const active = d2 < (this.world.simulationDistance * 16) ** 2;
      if (!active && e.type !== 'player') { if (e.type === 'item') { e.age += dt; continue; } continue; }
      e.update(dt);
      if (e.type === 'item' && e.tryPickup) e.tryPickup(this.player);
    }

    // world ticks
    this.world.update(this.player.pos[0], this.player.pos[2], dt);
    this.world.light.update(2);
    this.tickTileEntities(dt);
    this.redstone.update(dt, 1.5);
    this.tickMobSpawning(dt);
    this.tickBreaking(dt);
    this.tickPortals(dt);
    if (this.attackCooldown > 0) this.attackCooldown -= dt;
    if (this.placeCooldown > 0) this.placeCooldown -= dt;
  }

  // ==========================================================================
  //  camera & look
  // ==========================================================================
  applyLook(dt) {
    if (this.screen && this.screen !== 'hud') return;
    const d = this.input ? this.input.consume() : [0, 0];
    if (!d[0] && !d[1]) return;
    const p = this.player;
    p.yaw -= d[0];
    p.pitch -= d[1];
    const lim = Math.PI / 2 - 0.001;
    p.pitch = clamp(p.pitch, -lim, lim);
    if (p.yaw > Math.PI) p.yaw -= Math.PI * 2;
    if (p.yaw < -Math.PI) p.yaw += Math.PI * 2;
  }

  updateCamera(dt) {
    const p = this.player;
    const cam = this.renderer.camera;
    let eye = p.eyeHeight;
    if (p.sneaking) eye -= 0.14;
    if (p.isSpectator || this.perspective !== 0) {
      // third person: pull the camera back along the view vector
      const back = this.perspective === 2 ? -4.2 : 4.2;
      const cp = Math.cos(p.pitch);
      const fx = -Math.sin(p.yaw) * cp, fy = Math.sin(p.pitch), fz = -Math.cos(p.yaw) * cp;
      const start = [p.pos[0], p.pos[1] + eye, p.pos[2]];
      const target = [start[0] - fx * back, start[1] - fy * back, start[2] - fz * back];
      const hit = this.world.raycast(start, [-fx * Math.sign(back), -fy, -fz * Math.sign(back)], Math.abs(back), {});
      if (hit) {
        const d = Math.max(0.4, hit.dist - 0.2);
        target[0] = start[0] - fx * d * Math.sign(back);
        target[1] = start[1] - fy * d * Math.sign(back);
        target[2] = start[2] - fz * d * Math.sign(back);
      }
      cam.pos[0] = target[0]; cam.pos[1] = target[1]; cam.pos[2] = target[2];
      cam.yaw = p.yaw + (this.perspective === 2 ? Math.PI : 0);
      cam.pitch = -p.pitch * (this.perspective === 2 ? 1 : -1) * (this.perspective === 2 ? -1 : 1);
      cam.pitch = this.perspective === 2 ? -p.pitch : p.pitch;
    } else {
      cam.pos[0] = p.pos[0]; cam.pos[1] = p.pos[1] + eye; cam.pos[2] = p.pos[2];
      cam.yaw = p.yaw; cam.pitch = p.pitch;
    }
    // view bobbing + hurt shake
    if (this.opts.viewBobbing !== false && this.perspective === 0 && p.onGround) {
      const speed = Math.hypot(p.vel[0], p.vel[2]);
      const amp = Math.min(0.06, speed * 0.012);
      cam.pos[0] += Math.cos(p.bobPhase) * amp * 0.5;
      cam.pos[1] += Math.abs(Math.sin(p.bobPhase)) * amp;
    }
    if (this.cameraShake > 0) {
      cam.pos[0] += (Math.random() - 0.5) * this.cameraShake * 0.4;
      cam.pos[1] += (Math.random() - 0.5) * this.cameraShake * 0.4;
    }
    let fov = this.renderer.quality.fov || 70;
    if (p.sprinting) fov += 8;
    if (this.input.state.zoom) fov *= 0.35;
    if (p.isSpectator) fov += 0;
    cam.fov = fov;
    cam.near = 0.06;
    cam.far = Math.max(96, this.world.renderDistance * 16 + 64);
    this.renderer.updateCamera(cam);
  }

  applyMovement() {
    const p = this.player;
    const s = this.input ? this.input.state : null;
    if (!s || (this.screen && this.screen !== 'hud')) { p.movementInput[0] = 0; p.movementInput[1] = 0; return; }
    p.movementInput[0] = (s.forward ? 1 : 0) - (s.back ? 1 : 0);
    p.movementInput[1] = (s.right ? 1 : 0) - (s.left ? 1 : 0);
    p.sneaking = !!s.sneak;
    // sprint needs forward motion and hunger
    p.sprinting = !!s.sprint && p.movementInput[0] > 0 && (p.isCreative || p.hunger > 6);
    p.jumpQueued = !!s.jump;
    if (p.canFly) {
      p.flying = s.jump && (p.flying || (this.flyToggle = (this.flyToggle || 0) + 1) && false) ? true : p.flying;
    }
    if (p.isCreative && s.jump && !p.onGround && !p.flying && (this.doubleJumpTimer = (this.doubleJumpTimer || 0)) !== undefined) {
      // double-tap jump = creative flight
      const now = performance.now();
      if (now - (this.lastJumpTap || 0) < 300) { p.flying = true; this.lastJumpTap = 0; }
      else this.lastJumpTap = now;
    }
    if (p.flying && p.isCreative) {
      if (s.jump) p.vel[1] = Math.max(p.vel[1], 6);
      if (s.sneak) p.vel[1] = Math.min(p.vel[1], -6);
    }
  }

  // ==========================================================================
  //  rendering
  // ==========================================================================
  render(dt) {
    const r = this.renderer;
    if (!r) return;
    r.entityRenderer.begin();
    this.buildEntityGeometry(dt);
    if (this.debug) this.buildDebugGeometry();
    if (this.breaking) this.buildBreakOverlay();
    this.buildSelectionBox();
    r.render(this.world, dt);
  }

  buildEntityGeometry(dt) {
    const er = this.renderer.entityRenderer;
    const shadows = this.renderer.quality.entityShadows;
    const cam = this.renderer.camera;
    for (const e of this.entities) {
      if (e === this.player && this.perspective === 0 && !this.showSelf) continue;
      if (e.removed) continue;
      const dx = e.pos[0] - cam.pos[0], dz = e.pos[2] - cam.pos[2];
      if (dx * dx + dz * dz > 96 * 96) continue;
      if (e.type === 'item') this.buildItemGeometry(e, er, shadows);
      else if (e.type === 'xp') this.buildXpGeometry(e, er);
      else if (e.type === 'mob' && e.def) e.buildParts(this.renderer, dt);
      else if (e.type === 'player') this.buildPlayerGeometry(e, er, shadows);
      else if (e.type === 'tnt' || e.type === 'falling') this.buildSimpleGeometry(e, er);
    }
  }

  buildItemGeometry(e, er, shadows) {
    const tex = this.renderer.textures.iconFor(e.stack.def);
    const bob = Math.sin(e.bob) * 0.06 + 0.14;
    const spin = e.age * 0.8;
    const s = 0.26;
    const l = this.world.getLight(Math.floor(e.pos[0]), Math.floor(e.pos[1] + 0.2), Math.floor(e.pos[2]));
    const light = [(l >> 4) & 15, l & 15];   // [block, sky]
    const col = e.stack.def.tint || [255, 255, 255];
    er.box({
      pos: [e.pos[0], e.pos[1] + bob, e.pos[2]],
      size: [s, s, 0.04],
      rot: [spin, 0, 0], pivot: [0, s / 2, 0],
      color: col, tex,
      light,
    });
    er.box({
      pos: [e.pos[0], e.pos[1] + bob, e.pos[2]],
      size: [s, s, 0.04],
      rot: [spin + Math.PI / 2, 0, 0], pivot: [0, s / 2, 0],
      color: col, tex,
      light,
    });
    if (shadows) er.blobShadow(e.pos[0], e.pos[1], e.pos[2], 0.22, 0.22);
  }

  buildXpGeometry(e, er) {
    const s = 0.12;
    er.box({ pos: [e.pos[0], e.pos[1] + 0.12 + Math.sin(e.spin) * 0.04, e.pos[2]], size: [s, s, s], rot: [e.spin, 0, 0], pivot: [0, s / 2, 0], color: [128, 255, 32], tex: null, light: [15, 15] });
  }

  buildPlayerGeometry(e, er, shadows) {
    const skin = [236, 188, 156], shirt = [70, 100, 190], pants = [60, 60, 90], shoe = [90, 70, 50];
    const yaw = e.yaw, walk = Math.sin(e.bobPhase * 1.0) * (e.sprinting ? 0.9 : 0.55) * Math.min(1, Math.hypot(e.vel[0], e.vel[2]) * 0.6);
    const swing = e.swingTime > 0 ? Math.sin((1 - e.swingTime) * Math.PI) : 0;
    const l = this.world.getLight(Math.floor(e.pos[0]), Math.floor(e.pos[1] + 1), Math.floor(e.pos[2]));
    const L = [(l >> 4) & 15, l & 15];
    const P = (ox, oy, oz, w, h, d, col, opts = {}) => er.box(Object.assign({
      pos: [e.pos[0] + Math.cos(yaw) * ox + Math.sin(yaw) * oz, e.pos[1] + oy, e.pos[2] - Math.sin(yaw) * ox + Math.cos(yaw) * oz],
      size: [w, h, d], rot: [yaw, 0, 0], pivot: [0, 0, 0], color: col, tex: null, light: L,
    }, opts));
    const sneaky = e.sneaking ? -0.14 : 0;
    // legs
    P(-0.12, 0 + sneaky, 0, 0.24, 0.75, 0.24, pants, { rot: [yaw, walk, 0], pivot: [0, 0.75, 0] });
    P(0.12, 0 + sneaky, 0, 0.24, 0.75, 0.24, pants, { rot: [yaw, -walk, 0], pivot: [0, 0.75, 0] });
    // body
    P(0, 0.75 + sneaky, 0, 0.5, 0.72, 0.26, shirt);
    // arms
    P(-0.36, 0.75 + sneaky, 0, 0.22, 0.72, 0.22, shirt, { rot: [yaw, -walk + swing * 1.2, 0], pivot: [0, 0.72, 0] });
    P(0.36, 0.75 + sneaky, 0, 0.22, 0.72, 0.22, shirt, { rot: [yaw, walk - swing * 1.2, 0], pivot: [0, 0.72, 0] });
    // head
    P(0, 1.47 + sneaky, 0, 0.48, 0.48, 0.48, skin, { rot: [yaw, e.pitch * 0.4, 0], pivot: [0, 0.24, 0] });
    if (shadows) er.blobShadow(e.pos[0], e.pos[1], e.pos[2], 0.3, 0.3);
  }

  buildSimpleGeometry(e, er) {
    const l = this.world.getLight(Math.floor(e.pos[0]), Math.floor(e.pos[1]), Math.floor(e.pos[2]));
    const L = [(l >> 4) & 15, l & 15];
    const tex = e.blockId ? this.renderer.textures.resolver()(e.blockId, e.meta, 2) : null;
    er.box({ pos: [e.pos[0], e.pos[1], e.pos[2]], size: [0.98, 0.98, 0.98], rot: [0, 0, 0], pivot: [0.49, 0.49, 0.49], color: [255, 255, 255], tex, light: L });
  }

  buildSelectionBox() {
    if (this.screen && this.screen !== 'hud') return;
    const hit = this.raycast();
    if (!hit) return;
    const b = getBlock(hit.id);
    let a = [hit.x, hit.y, hit.z, hit.x + 1, hit.y + 1, hit.z + 1];
    if (b.shape === Shape.SLAB) a = [hit.x, hit.y, hit.z, hit.x + 1, hit.y + 0.5 + (hit.meta & 8 ? 0.5 : 0), hit.z + 1];
    this.renderer.lines.box(a[0] - 0.002, a[1] - 0.002, a[2] - 0.002, a[3] + 0.002, a[4] + 0.002, a[5] + 0.002, [0, 0, 0, 0.55]);
  }

  buildBreakOverlay() {
    if (!this.breaking) return;
    const b = this.breaking;
    const stage = Math.floor(this.breaking.progress * 10);
    if (stage <= 0) return;
    // draw a simple cracking grid: 3 lines scaled with progress
    const p = this.renderer.particles;
    if (Math.random() < 0.4) {
      p.spawn({
        x: b.x + Math.random(), y: b.y + Math.random(), z: b.z + Math.random(),
        vx: 0, vy: 0, vz: 0, life: 0.2, size: 0.06,
        color: [160, 160, 160], tex: null,
      });
    }
  }

  buildDebugGeometry() {
    const lines = this.renderer.lines;
    for (const e of this.entities) {
      if (e === this.player) continue;
      const a = e.aabb();
      lines.aabb(a, [255, 80, 80, 0.8]);
    }
    // chunk borders
    const cx = Math.floor(this.player.pos[0] / 16), cz = Math.floor(this.player.pos[2] / 16);
    const y = Math.floor(this.player.pos[1]) - 4;
    lines.box(cx * 16, y, cz * 16, cx * 16 + 16, y, cz * 16 + 16, [255, 255, 0, 0.5]);
  }

  // ==========================================================================
  //  interaction
  // ==========================================================================
  raycast(maxDist = null) {
    const p = this.player;
    const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
    const dir = [-Math.sin(p.yaw) * cp, sp, -Math.cos(p.yaw) * cp];
    const origin = [p.pos[0], p.pos[1] + p.eyeHeight, p.pos[2]];
    const hit = this.world.raycast(origin, dir, maxDist || p.reachDistance, {});
    if (hit) hit.meta = this.world.getMeta(hit.x, hit.y, hit.z);
    return hit;
  }

  /** Left click: attack entities or start breaking a block. */
  attack(down) {
    if (down) {
      // prefer entities in the crosshair
      const target = this.pickEntity();
      if (target && (!target.type || target.type === 'mob') && this.attackCooldown <= 0) {
        const dmg = this.player.getAttackDamage(target);
        if (target.hurt(dmg, 'player', this.player)) {
          this.hitMarker = 1;
          this.player.attackCooldown = 0.6;
          this.attackCooldown = 0.6;
          this.player.exhaust(0.1);
          const held = this.player.inventory.getHeld();
          if (held && held.def.type === 'tool') {
            if (held.damageItem(1)) this.player.inventory.setHeld(null);
            this.player.inventory.changed();
          }
          this.audio.play('hit', target.pos[0], target.pos[1], target.pos[2]);
          const f = this.player.forward([0, 0, 0]);
          target.knockback(f[0] * 6, 4, f[2] * 6);
          if (target.health <= 0) this.statistics.mobsKilled++;
          if (this.ui) this.ui.markDirty('hotbar');
        }
        return;
      }
      const hit = this.raycast();
      if (hit) this.startBreaking(hit);
    } else {
      this.stopBreaking();
    }
  }

  pickEntity(maxDist = 4.5) {
    const p = this.player;
    const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
    const dir = [-Math.sin(p.yaw) * cp, sp, -Math.cos(p.yaw) * cp];
    const origin = [p.pos[0], p.pos[1] + p.eyeHeight, p.pos[2]];
    let best = null, bestT = maxDist;
    for (const e of this.entities) {
      if (e === this.player || e.removed || e.dead) continue;
      if (e.type !== 'mob' && e.type !== 'player') continue;
      const a = e.aabb();
      const t = rayAabb(origin, dir, a, maxDist);
      if (t !== null && t < bestT) { bestT = t; best = e; }
    }
    return best;
  }

  startBreaking(hit) {
    const b = getBlock(hit.id);
    if (this.player.isCreative) {
      // instant break, but rate limited
      if (this.placeCooldown > 0) return;
      this.placeCooldown = 0.2;
      this.breakBlock(hit.x, hit.y, hit.z, true);
      return;
    }
    if (b.hardness < 0) return;
    this.breaking = { x: hit.x, y: hit.y, z: hit.z, id: hit.id, progress: 0 };
    this.breakingTime = 0;
  }

  stopBreaking() { this.breaking = null; this.breakingTime = 0; }

  tickBreaking(dt) {
    const b = this.breaking;
    if (!b) return;
    if (this.player.isCreative) { this.breakBlock(b.x, b.y, b.z, true); this.breaking = null; return; }
    const id = this.world.getBlock(b.x, b.y, b.z);
    if (id !== b.id) { this.breaking = null; return; }
    const total = this.player.breakTime(getBlock(id));
    if (!isFinite(total)) { this.breaking = null; return; }
    this.breakingTime += dt;
    b.progress = clamp(this.breakingTime / total, 0, 1);
    if (Math.random() < dt * 8) {
      const def = getBlock(id);
      this.spawnDigParticles(b.x, b.y, b.z, def);
      this.audio.play('dig_' + (def.sound || 'stone'), b.x + 0.5, b.y + 0.5, b.z + 0.5, { pitch: 0.9 + Math.random() * 0.2 });
    }
    if (b.progress >= 1) {
      this.breakBlock(b.x, b.y, b.z, false);
      this.breaking = null;
    }
  }

  /** Break a block: drops, xp, sound, particles, statistics. */
  breakBlock(x, y, z, instant = false) {
    const id = this.world.getBlock(x, y, z);
    if (id === AIR) return false;
    const b = getBlock(id);
    if (b.hardness < 0 && !this.player.isCreative) return false;
    const meta = this.world.getMeta(x, y, z);
    const held = this.player.inventory.getHeld();
    const canHarvest = this.canHarvest(b, held);
    // drops
    if (this.player.isCreative) {
      // creative still removes the block but drops nothing
    } else if (this.gamerules.doTileDrops && b.drop !== null) {
      const drops = typeof b.drops === 'function' ? b.drops(meta, this.rng) : this.defaultDrops(b, meta);
      if (canHarvest) {
        for (const d of drops) this.dropItem(x + 0.5, y + 0.5, z + 0.5, Array.isArray(d) ? new ItemStack(d[0], d[1]) : d);
      }
      if (b.xp) this.spawnXp(x + 0.5, y + 0.5, z + 0.5, b.xp(this.rng) || 1);
    }
    // tool damage
    if (held && !this.player.isCreative) {
      if (held.damageItem(b.hardness > 0 ? 1 : 0)) this.player.inventory.setHeld(null);
      this.player.inventory.changed();
      this.player.exhaust(0.005);
    }
    // remove tile entity and container contents
    const te = this.world.getTileEntity(x, y, z);
    if (te && te.inv && this.gamerules.doTileDrops) {
      for (const s of te.inv.slots) if (s) this.dropItem(x + 0.5, y + 0.5, z + 0.5, s);
    }
    this.world.setBlock(x, y, z, AIR, 0);
    this.audio.play('break_' + (b.sound || 'stone'), x + 0.5, y + 0.5, z + 0.5);
    this.spawnBreakParticles(x, y, z, b);
    this.statistics.blocksBroken++;
    this.redstone.mark(x, y, z);
    if (this.ui) this.ui.markDirty('hotbar');
    this.checkAdvancement('mine_stone', id === blockId('stone') || id === blockId('cobblestone'));
    return true;
  }

  defaultDrops(b, meta) {
    if (b.drop === null) return [];
    const name = typeof b.drop === 'string' ? b.drop : b.name;
    const id = itemId(name) || blockId(name) || b.id;
    if (!id) return [];
    const fortune = this.player.inventory.getHeld() ? (this.player.inventory.getHeld().ench ? this.player.inventory.getHeld().getEnchantment('fortune') : 0) : 0;
    let count = 1;
    if (/ore$/.test(b.name) && fortune) count = 1 + Math.floor(this.rng() * (fortune + 1));
    if (b.shape === Shape.SLAB && (meta & 8) !== 0) count = 2;   // double slab
    return [[id, count]];
  }

  canHarvest(b, held) {
    if (!b.tool) return true;
    const tool = held && held.def.tool;
    if (!tool) return false;
    // tiers: 0 wood/gold, 1 stone, 2 iron, 3 diamond, 4 netherite
    const tierOf = (t) => ({ wooden: 1, gold: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }[t] || 0);
    return tierOf(tool.kind) >= (b.tier || 0);
  }

  /** Right click: use the held item or place a block. */
  use(down) {
    if (!down) return;
    if (this.placeCooldown > 0) return;
    const held = this.player.inventory.getHeld();
    const hit = this.raycast();
    // use the item first (food, buckets, tools, spawn eggs)
    if (held && this.useItem(held, hit)) { this.placeCooldown = 0.25; return; }
    // interact with the block we're looking at
    if (hit && this.interactBlock(hit)) { this.placeCooldown = 0.25; return; }
    // otherwise place a block
    if (hit && held && blockId(held.def.name) !== 0) {
      this.placeBlock(hit, held);
      this.placeCooldown = 0.2;
    }
  }

  placeBlock(hit, held) {
    const name = held.def.name;
    const id = blockId(name);
    if (!id) return false;
    const nx = hit.x + hit.face[0], ny = hit.y + hit.face[1], nz = hit.z + hit.face[2];
    const target = this.world.getBlock(nx, ny, nz);
    if (target !== AIR && !getBlock(target).replaceable) return false;
    // don't place inside an entity
    const box = [nx, ny, nz, nx + 1, ny + 1, nz + 1];
    for (const e of this.entities) {
      if (e === this.player || e.removed) continue;
      if (e.type === 'item' || e.type === 'xp') continue;
      const a = e.aabb();
      if (a[0] < box[3] && a[3] > box[0] && a[1] < box[4] && a[4] > box[1] && a[2] < box[5] && a[5] > box[2]) return false;
    }
    const meta = this.metaForPlacement(id, hit, nx, ny, nz);
    this.world.setBlock(nx, ny, nz, id, meta);
    const def = getBlock(id);
    if (def.entity) this.world.addTileEntity(nx, ny, nz, { id, x: nx, y: ny, z: nz });
    if (!this.player.isCreative) this.player.inventory.consumeHeld(1);
    this.audio.play('place', nx + 0.5, ny + 0.5, nz + 0.5);
    this.statistics.blocksPlaced++;
    this.redstone.mark(nx, ny, nz);
    if (def.light) this.world.setLight(nx, ny, nz, def.light * 16 + def.light);
    if (this.ui) this.ui.markDirty('hotbar');
    return true;
  }

  metaForPlacement(id, hit, x, y, z) {
    const def = getBlock(id);
    const face = hit.face;
    // facing for directional blocks: 0 north(-Z) 1 east(+X) 2 south(+Z) 3 west(-X)
    if (def.shape === Shape.FURNACE || def.shape === Shape.CHEST || def.interact === 'piston' || def.interact === 'dispenser') {
      const yaw = this.player.yaw;
      const a = ((yaw + Math.PI * 2) % (Math.PI * 2));
      // player faces -Z at yaw 0
      if (a < Math.PI * 0.25 || a > Math.PI * 1.75) return 0;
      if (a < Math.PI * 0.75) return 3;
      if (a < Math.PI * 1.25) return 2;
      return 1;
    }
    if (def.shape === Shape.STAIRS || def.shape === Shape.TRAPDOOR) {
      let m = 0;
      if (face[1] < 0) m |= 4;    // top half
      return m;
    }
    if (def.shape === Shape.SLAB) {
      return (face[1] > 0 || (hit.face[1] === 0 && this.player.pitch < 0)) ? 8 : 0;
    }
    if (def.shape === Shape.LADDER) {
      for (let f = 0; f < 4; f++) if (face[0] === [0, 0, -1, 1][f] && face[2] === [-1, 1, 0, 0][f]) return f + 2;
      return 2;
    }
    if (def.interact === 'rail') {
      // straight rail along the drag direction
      const dx = Math.abs(face[0]), dz = Math.abs(face[2]);
      return dx > dz ? 0 : 1;
    }
    if (def.shape === Shape.DOOR) return 0;
    if (def.shape === Shape.CROSS || def.shape === Shape.TORCH) return 0;
    return 0;
  }

  interactBlock(hit) {
    const id = this.world.getBlock(hit.x, hit.y, hit.z);
    const def = getBlock(id);
    const name = def.name;
    const p = this.player;
    if (def.interact === 'crafting_table') { this.openScreen('crafting'); return true; }
    if (def.interact === 'furnace') { this.openContainerAt(hit.x, hit.y, hit.z, 'furnace'); return true; }
    if (def.interact === 'container') { this.openContainerAt(hit.x, hit.y, hit.z, name); return true; }
    if (def.interact === 'ender_chest') { this.openScreen('ender_chest'); return true; }
    if (def.interact === 'chest') { this.openContainerAt(hit.x, hit.y, hit.z, 'chest'); return true; }
    if (def.interact === 'enchanting_table') { this.openScreen('enchanting'); return true; }
    if (def.interact === 'anvil') { this.openScreen('anvil'); return true; }
    if (def.interact === 'brewing_stand') { this.openContainerAt(hit.x, hit.y, hit.z, 'brewing'); return true; }
    if (def.interact === 'beacon') { this.openScreen('beacon'); return true; }
    if (def.interact === 'jukebox') { this.openContainerAt(hit.x, hit.y, hit.z, 'jukebox'); return true; }
    if (def.interact === 'note_block') {
      const te = this.world.getTileEntity(hit.x, hit.y, hit.z) || { note: 0 };
      te.note = ((te.note || 0) + 1) % 25;
      this.world.addTileEntity(hit.x, hit.y, hit.z, { id, x: hit.x, y: hit.y, z: hit.z, note: te.note });
      const info = this.world.getTileEntity(hit.x, hit.y, hit.z).play ? this.world.getTileEntity(hit.x, hit.y, hit.z).play(this.world) : { note: te.note, instrument: 'harp' };
      this.audio.play('note', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, { note: info.note, instrument: info.instrument });
      this.spawnNoteParticle(hit.x, hit.y + 1, hit.z);
      return true;
    }
    if (def.interact === 'lever') {
      const m = this.world.getMeta(hit.x, hit.y, hit.z);
      this.world.setMeta(hit.x, hit.y, hit.z, m ^ 8);
      this.world.markBlockDirty(hit.x, hit.y, hit.z);
      this.redstone.mark(hit.x, hit.y, hit.z);
      this.audio.play('click', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      return true;
    }
    if (def.interact === 'button') {
      const id2 = this.world.getBlock(hit.x, hit.y, hit.z);
      this.world.setMeta(hit.x, hit.y, hit.z, 1);
      this.redstone.press(hit.x, hit.y, hit.z, name.startsWith('stone') ? 20 : 30);
      this.audio.play('click', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      return true;
    }
    if (def.interact === 'door' || def.interact === 'iron_door' || def.interact === 'trapdoor' || def.interact === 'iron_trapdoor' || def.name.includes('fence_gate')) {
      this.toggleDoor(hit.x, hit.y, hit.z);
      return true;
    }
    if (def.interact === 'repeater') {
      const m = this.world.getMeta(hit.x, hit.y, hit.z);
      this.world.setMeta(hit.x, hit.y, hit.z, (m & 15) | ((((m >> 4) + 1) % 4) << 4));
      this.world.markBlockDirty(hit.x, hit.y, hit.z);
      this.audio.play('click', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      return true;
    }
    if (def.interact === 'comparator') {
      const m = this.world.getMeta(hit.x, hit.y, hit.z);
      this.world.setMeta(hit.x, hit.y, hit.z, m ^ 1);
      this.world.markBlockDirty(hit.x, hit.y, hit.z);
      this.audio.play('click', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      return true;
    }
    if (def.interact === 'daylight_detector') {
      const m = this.world.getMeta(hit.x, hit.y, hit.z);
      this.world.setMeta(hit.x, hit.y, hit.z, m ^ 4);
      this.redstone.mark(hit.x, hit.y, hit.z);
      return true;
    }
    if (def.interact === 'tnt') { this.primeTnt(hit.x, hit.y, hit.z); return true; }
    if (def.interact === 'command_block') { if (this.ui) this.ui.openCommandBlock(hit.x, hit.y, hit.z); return true; }
    if (name === 'end_portal_frame') {
      const held = p.inventory.getHeld();
      if (held && held.def.name === 'eye_of_ender') {
        const m = this.world.getMeta(hit.x, hit.y, hit.z);
        if ((m & 4) === 0) {
          this.world.setMeta(hit.x, hit.y, hit.z, m | 4);
          this.world.markBlockDirty(hit.x, hit.y, hit.z);
          if (!p.isCreative) p.inventory.consumeHeld(1);
          this.audio.play('click', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
          this.tryActivateEndPortal(hit.x, hit.y, hit.z);
          return true;
        }
      }
      return false;
    }
    if (def.interact === 'bed') { this.trySleep(hit.x, hit.y, hit.z); return true; }
    if (def.interact === 'cauldron') { this.useCauldron(hit.x, hit.y, hit.z); return true; }
    if (def.interact === 'note_block') return false;
    return false;
  }

  toggleDoor(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    const m = this.world.getMeta(x, y, z);
    const open = !(m & 4);
    this.world.setMeta(x, y, z, open ? (m | 4) : (m & ~4));
    // doors are two blocks: update the other half
    const up = this.world.getBlock(x, y + 1, z) === id ? 1 : -1;
    const m2 = this.world.getMeta(x, y + up, z);
    if (this.world.getBlock(x, y + up, z) === id) {
      this.world.setMeta(x, y + up, z, open ? (m2 | 4) : (m2 & ~4));
      this.world.markBlockDirty(x, y + up, z);
    }
    this.world.markBlockDirty(x, y, z);
    this.audio.play(open ? 'door_open' : 'door_close', x + 0.5, y + 0.5, z + 0.5);
  }

  /** Right-click with an item: food, buckets, tools, eggs, spawn eggs, ... */
  useItem(stack, hit) {
    const def = stack.def;
    if (!def) return false;
    const p = this.player;

    // ---- food ---------------------------------------------------------------
    if (def.food) {
      const f = def.food;
      if (p.hunger >= 20 && !f.alwaysEat && !p.isCreative) return false;
      p.hunger = Math.min(20, p.hunger + (f.hunger || 2));
      p.saturation = Math.min(20, p.saturation + (f.saturation || 0.4));
      if (f.effects) for (const e of f.effects) {
        if (Math.random() < (e.chance === undefined ? 1 : e.chance)) p.addEffect(e.effect, e.duration || 200, e.level || 0);
      }
      this.audio.play('eat', p.pos[0], p.pos[1], p.pos[2]);
      if (!p.isCreative) p.inventory.consumeHeld(1);
      if (f.returnItem) p.inventory.addItem(f.returnItem, 1);
      if (def.name === 'milk_bucket') p.effects.clear();
      if (this.ui) this.ui.markDirty('hotbar');
      return true;
    }

    // ---- spawn eggs ---------------------------------------------------------
    if (def.spawnEgg) {
      if (!hit) return false;
      const nx = hit.x + hit.face[0] + 0.5, ny = hit.y + hit.face[1], nz = hit.z + hit.face[2] + 0.5;
      this.spawnMob(def.spawnEgg, nx, ny, nz);
      if (!p.isCreative) p.inventory.consumeHeld(1);
      return true;
    }

    // ---- buckets ------------------------------------------------------------
    if (/_bucket$/.test(def.name)) {
      if (!hit) return false;
      const t = this.world.getBlock(hit.x, hit.y, hit.z);
      const tb = getBlock(t);
      if (def.name === 'bucket' && tb.flow > 0) {
        this.world.setBlock(hit.x, hit.y, hit.z, AIR, 0);
        p.inventory.consumeHeld(1);
        p.inventory.addItem(tb.name === 'lava' ? 'lava_bucket' : 'water_bucket', 1);
        this.audio.play('splash', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
        return true;
      }
      if (def.name === 'water_bucket' || def.name === 'lava_bucket') {
        const nx = hit.x + hit.face[0], ny = hit.y + hit.face[1], nz = hit.z + hit.face[2];
        const id = def.name === 'water_bucket' ? blockId('water') : blockId('lava');
        if (id) this.world.setBlock(nx, ny, nz, id, 7);
        if (!p.isCreative) { p.inventory.consumeHeld(1); p.inventory.addItem('bucket', 1); }
        this.audio.play('splash', nx + 0.5, ny + 0.5, nz + 0.5);
        return true;
      }
      if (def.name === 'milk_bucket') { p.effects.clear(); if (!p.isCreative) { p.inventory.consumeHeld(1); p.inventory.addItem('bucket', 1); } return true; }
      return false;
    }

    // ---- potions ------------------------------------------------------------
    if (def.potion && def.potion.effects) {
      for (const e of def.potion.effects) {
        if (e.effect === 'instant_health') p.heal(4);
        else if (e.effect === 'instant_damage') p.hurt(6, 'magic');
        else p.addEffect(e.effect, e.duration, 0);
      }
      this.audio.play('drink', p.pos[0], p.pos[1], p.pos[2]);
      if (!p.isCreative) p.inventory.consumeHeld(1);
      return true;
    }

    // ---- blocks are placed instead of used ----------------------------------
    if (def.type === ItemType.BLOCK) return false;

    // ---- throwables and tools ----------------------------------------------
    if (def.name === 'snowball' || def.name === 'egg' || def.name === 'ender_pearl' || def.name === 'experience_bottle') {
      const kind = def.name === 'ender_pearl' ? 'pearl' : def.name === 'experience_bottle' ? 'xp' : def.name;
      this.throwProjectile(kind, stack);
      if (!p.isCreative) p.inventory.consumeHeld(1);
      return true;
    }
    if (def.name === 'flint_and_steel') {
      if (!hit) return false;
      const nx = hit.x + hit.face[0], ny = hit.y + hit.face[1], nz = hit.z + hit.face[2];
      if (this.world.getBlock(nx, ny, nz) === AIR) {
        this.world.setBlock(nx, ny, nz, blockId('fire'), 0);
        this.audio.play('fire', nx + 0.5, ny + 0.5, nz + 0.5);
        p.inventory.damageHeld(1);
        this.tryLightPortal(nx, ny, nz);
        return true;
      }
      return false;
    }
    if (def.name === 'bone_meal' && hit) {
      const id = this.world.getBlock(hit.x, hit.y, hit.z);
      if (getBlock(id).bonemeal) {
        this.growPlant(hit.x, hit.y, hit.z, id);
        if (!p.isCreative) p.inventory.consumeHeld(1);
        this.spawnBonemealParticles(hit.x, hit.y, hit.z);
        return true;
      }
      return false;
    }
    if (def.name === 'bow' || def.name === 'crossbow') { this.startBowCharge(); return true; }
    if (def.name === 'shears' && hit) {
      const id = this.world.getBlock(hit.x, hit.y, hit.z);
      if (id === blockId('sheep_wool') || getBlock(id).name === 'pumpkin') this.breakBlock(hit.x, hit.y, hit.z, false);
      p.inventory.damageHeld(1);
      return true;
    }
    return false;
  }

  /** Roll an enchantment for `stack` at table level `level` (1..3 offer tier). */
  applyEnchant(stack, level = 1, seedRng = Math.random) {
    if (!stack) return null;
    const POOLS = {
      weapon: ['sharpness', 'smite', 'bane_of_arthropods', 'knockback', 'fire_aspect', 'looting', 'sweeping'],
      tool: ['efficiency', 'silk_touch', 'unbreaking', 'fortune'],
      armor: ['protection', 'fire_protection', 'blast_protection', 'projectile_protection', 'thorns', 'unbreaking'],
      bow: ['power', 'punch', 'infinity', 'flame', 'unbreaking'],
      fishing_rod: ['luck_of_the_sea', 'lure', 'unbreaking'],
      any: ['unbreaking'],
    };
    const n = stack.def.name;
    let pool = POOLS.any;
    if (n.includes('sword') || n.includes('axe')) pool = POOLS.weapon;
    else if (n.includes('pickaxe') || n.includes('shovel') || n.includes('hoe') || n === 'shears') pool = POOLS.tool;
    else if (n.includes('helmet') || n.includes('chestplate') || n.includes('leggings') || n.includes('boots')) pool = POOLS.armor;
    else if (n === 'bow' || n === 'crossbow') pool = POOLS.bow;
    else if (n === 'fishing_rod') pool = POOLS.fishing_rod;
    const name = pool[Math.floor(seedRng() * pool.length)];
    const maxLevel = Math.min(3, Math.ceil(level / 8) + 1);
    const lvl = 1 + Math.floor(seedRng() * maxLevel);
    stack.addEnchantment(name, Math.max(lvl, stack.getEnchantment(name)));
    return { name, level: stack.getEnchantment(name) };
  }

  /** Every item a creative-mode player can take, sorted for the menu. */
  creativeItems() {
    const out = [];
    for (const it of ITEMS) {
      if (!it || !it.id || !it.name || it.name === 'air') continue;
      out.push(it);
    }
    return out;
  }

  /** Is this block a growable crop? (crops carry their own stage textures) */
  isCrop(b) { return b.shape === Shape.CROP || (b.maxAge !== undefined && !!b.stageTex); }

  growPlant(x, y, z, id) {
    const b = getBlock(id);
    if (this.isCrop(b)) {
      const m = this.world.getMeta(x, y, z);
      const max = b.maxAge || 7;
      if (m < max) {
        this.world.setMeta(x, y, z, Math.min(max, m + 2 + (this.rng() < 0.4 ? 1 : 0)));
        this.world.markBlockDirty(x, y, z);
      }
      return;
    }
    if (b.name.includes('sapling')) {
      this.growTree(x, y, z, id);
      this.world.markBlockDirty(x, y, z);
      return;
    }
    if (b.name === 'grass_block' || b.name === 'dirt') {
      // sprinkle flowers / grass around
      for (let i = 0; i < 12; i++) {
        const nx = x + Math.round((Math.random() - 0.5) * 6);
        const nz = z + Math.round((Math.random() - 0.5) * 6);
        const ny = this.world.topY(nx, nz);
        if (this.world.getBlock(nx, ny - 1, nz) === id && this.world.getBlock(nx, ny, nz) === AIR) {
          const flower = this.rng() < 0.5 ? blockId('short_grass') : blockId('dandelion');
          if (flower) this.world.setBlock(nx, ny, nz, flower, 0);
        }
      }
    }
  }

  /**
   * Grow a sapling into a tree in the live world. The generator's `placeTree`
   * works through callbacks, so it is reused here with world-writing ones.
   */
  growTree(x, y, z, id) {
    const g = this.world.generator;
    if (!g || !g.placeTree) return false;
    const w = this.world;
    const name = getBlock(id).name;
    const type = name.replace(/_sapling$/, '').replace('_propagule', '');
    const rng = makeRng((x * 374761393) ^ (z * 668265263) ^ (w.seed | 0) ^ (w.time | 0));
    const isAir = (bx, by, bz) => w.getBlock(bx, by, bz) === AIR;
    const isLeaf = (bx, by, bz) => { const b = w.getBlock(bx, by, bz); return b !== AIR && getBlock(b).name.includes('leaves'); };
    // trunks overwrite air and leaves only; canopies never overwrite anything solid
    const set = (bx, by, bz, bid) => { if (isAir(bx, by, bz) || isLeaf(bx, by, bz)) w.setBlock(bx, by, bz, bid, 0); };
    const put = (bx, by, bz, bid) => { if (isAir(bx, by, bz)) w.setBlock(bx, by, bz, bid, 0); };
    w.setBlock(x, y, z, AIR, 0);
    g.placeTree(null, x, y - 1, z, type, rng, put, set);
    for (let d = 0; d < 6; d++) w.markBlockDirty(x, y, z);
    return true;
  }

  throwProjectile(kind, stack) {
    const p = this.player;
    const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
    const dir = [-Math.sin(p.yaw) * cp, sp, -Math.cos(p.yaw) * cp];
    const opts = {
      kind, owner: p, stack: stack.id,
      dir, speed: kind === 'xp' ? 18 : 26, gravity: kind === 'snowball' ? 10 : 8,
      damage: kind === 'egg' ? 0 : kind === 'snowball' ? 0 : 0,
    };
    const e = new Projectile(this.world, p.pos[0] + dir[0] * 0.6, p.pos[1] + p.eyeHeight + dir[1] * 0.6, p.pos[2] + dir[2] * 0.6, opts);
    this.entities.push(e);
    if (kind === 'pearl') { e.onImpact = () => { p.setPos(e.pos[0], e.pos[1], e.pos[2]); p.vel.fill(0); p.hurt(1, 'fall'); this.audio.play('teleport', e.pos[0], e.pos[1], e.pos[2]); e.remove(); }; }
    if (kind === 'xp') { e.onImpact = () => { this.spawnXp(e.pos[0], e.pos[1], e.pos[2], 3 + Math.floor(Math.random() * 8)); e.remove(); }; }
    this.audio.play(kind === 'snowball' ? 'bow' : 'bow', p.pos[0], p.pos[1], p.pos[2]);
  }

  startBowCharge() { this.bowCharge = performance.now(); }

  releaseBow() {
    if (!this.bowCharge) return;
    const held = this.player.inventory.getHeld();
    if (!held || !/bow/.test(held.def.name)) { this.bowCharge = 0; return; }
    const t = Math.min(1, (performance.now() - this.bowCharge) / 1000);
    this.bowCharge = 0;
    const p = this.player;
    const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
    const dir = [-Math.sin(p.yaw) * cp, sp, -Math.cos(p.yaw) * cp];
    const speed = 20 + t * 30;
    const dmg = 2 + t * 7;
    const arrow = new Projectile(this.world, p.pos[0] + dir[0] * 0.7, p.pos[1] + p.eyeHeight + dir[1] * 0.7, p.pos[2] + dir[2] * 0.7, {
      kind: 'arrow', owner: p, damage: dmg, dir, speed, gravity: 9, punch: held.getEnchantment('punch'), critical: t > 0.95,
    });
    this.entities.push(arrow);
    this.audio.play('bow', p.pos[0], p.pos[1], p.pos[2]);
    if (!p.isCreative) {
      const arrows = p.inventory.count('arrow');
      if (arrows > 0) p.inventory.remove('arrow', 1);
      p.inventory.damageHeld(1);
    }
  }

  primeTnt(x, y, z) {
    this.world.setBlock(x, y, z, AIR, 0);
    const e = new PrimedTnt(this.world, x + 0.5, y + 0.5, z + 0.5, 80);
    this.entities.push(e);
    this.audio.play('fuse', x + 0.5, y + 0.5, z + 0.5);
  }

  useCauldron(x, y, z) {
    const held = this.player.inventory.getHeld();
    const te = this.world.getTileEntity(x, y, z) || {};
    let level = te.level || 0;
    if (held && held.def.name === 'water_bucket' && level < 3) {
      level = 3;
      if (!this.player.isCreative) { this.player.inventory.consumeHeld(1); this.player.inventory.addItem('bucket', 1); }
      this.audio.play('splash', x + 0.5, y + 0.5, z + 0.5);
    } else if (held && held.def.name === 'glass_bottle' && level > 0) {
      level--;
      this.player.inventory.consumeHeld(1);
      this.player.inventory.addItem('water_bottle', 1);
    } else if (this.player.burning) {
      this.player.fireTicks = 0;
      level = Math.max(0, level - 1);
      this.audio.play('fizz', x + 0.5, y + 0.5, z + 0.5);
    }
    this.world.addTileEntity(x, y, z, { id: this.world.getBlock(x, y, z), x, y, z, level });
  }

  trySleep(x, y, z) {
    const isNight = this.dayTime > 12500 || this.dayTime < 500;
    if (!isNight) { this.message('You can only sleep at night'); return false; }
    const mobs = this.entities.some((e) => e.type === 'mob' && e.hostile && Math.hypot(e.pos[0] - x, e.pos[2] - z) < 10);
    if (mobs) { this.message('You may not rest now, there are monsters nearby'); return false; }
    this.player.setSpawn(x + 0.5, y + 1, z + 0.5);
    this.message('Spawn point set');
    // fast-forward to morning
    this.sleeping = { target: 500, speed: 120 };
    if (this.ui) this.ui.showSleepOverlay(true);
    return true;
  }

  // ==========================================================================
  //  entities
  // ==========================================================================
  addEntity(e) { this.entities.push(e); return e; }

  spawnMob(name, x, y, z) {
    const def = MOB_DEFS[name];
    if (!def) return null;
    if (this.difficulty === 'peaceful' && def.hostile) return null;
    const m = new Mob(this.world, name, x, y, z);
    m.game = this;
    // killing a mob pays out experience (more if the player did the killing)
    m.onMobDeath = (mob, source, from) => {
      const xp = mob.def.xp || 0;
      if (!xp || this.difficulty === 'peaceful') return;
      if (from && from !== this.player) return;
      const n = Math.max(1, Math.round(xp * (mob.baby ? 0.4 : 1)));
      this.spawnXp(mob.pos[0], mob.pos[1] + 0.5, mob.pos[2], n);
    };
    this.entities.push(m);
    return m;
  }

  dropItem(x, y, z, stack) {
    if (!stack || stack.count <= 0) return null;
    const e = new ItemEntity(this.world, x, y, z, stack, [(Math.random() - 0.5) * 2, 2.2, (Math.random() - 0.5) * 2]);
    this.entities.push(e);
    return e;
  }

  spawnXp(x, y, z, amount) {
    const e = new XpOrb(this.world, x, y, z, amount);
    this.entities.push(e);
    return e;
  }

  addXp(n) { this.player.addXp(n); }

  tickMobSpawning(dt) {
    if (!this.gamerules.doMobSpawning || this.difficulty === 'peaceful') return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = 2;
    const p = this.player;
    const cap = this.dimension === 'nether' ? 40 : 60;
    const mobs = this.entities.filter((e) => e.type === 'mob').length;
    if (mobs >= cap) return;
    const night = this.dayTime > 13300 || this.dayTime < 23000 ? 1 : 0;
    const wantsHostile = this.dimension === 'nether' || night || this.rng() < 0.25;
    const pool = this.dimension === 'nether'
      ? ['piglin', 'blaze', 'ghast', 'magma_cube']
      : (wantsHostile ? HOSTILE_MOBS : PASSIVE_MOBS);
    if (!pool.length) return;
    for (let attempt = 0; attempt < 6; attempt++) {
      const a = this.rng() * Math.PI * 2;
      const r = 24 + this.rng() * 40;
      const x = Math.floor(p.pos[0] + Math.cos(a) * r);
      const z = Math.floor(p.pos[2] + Math.sin(a) * r);
      const y = this.world.topY(x, z);
      if (y <= 0 || y >= this.world.height - 2) continue;
      const ground = this.world.getBlock(x, y - 1, z);
      if (ground === AIR) continue;
      const blockLight = this.world.getBlockLight(x, y, z);
      const sky = this.world.getSkyLight(x, y, z);
      const isHostile = wantsHostile;
      if (isHostile && blockLight > 7) continue;
      if (isHostile && this.dimension === 'overworld' && !night && sky > 7) continue;
      if (!isHostile && this.dimension === 'overworld' && getBlock(ground).name !== 'grass_block' && this.rng() < 0.6) continue;
      if (!this.world.isSolid(x, y - 1, z) || this.world.getBlock(x, y, z) !== AIR || this.world.getBlock(x, y + 1, z) !== AIR) continue;
      // passive mobs need grass, hostile need darkness; pack spawning
      const name = pool[(this.rng() * pool.length) | 0];
      const group = MOB_DEFS[name] && MOB_DEFS[name].group ? 1 + ((this.rng() * 3) | 0) : 1;
      for (let i = 0; i < group; i++) {
        this.spawnMob(name, x + 0.5 + (this.rng() - 0.5) * 2, y + 0.2, z + 0.5 + (this.rng() - 0.5) * 2);
      }
      return;
    }
  }

  onEntityRemoved(e) {
    if (e === this.player) return;
    if (e.type === 'mob' && e.def && e.def.drops && this.gamerules.doTileDrops) {
      for (const d of e.def.drops) {
        if (this.rng() < (d[2] === undefined ? 1 : d[2])) this.dropItem(e.pos[0], e.pos[1], e.pos[2], new ItemStack(itemId(d[0]), d[1] + (this.rng() < 0.3 ? 1 : 0)));
      }
    }
  }

  /** Nearest entity along a swept sphere (used by projectiles). */
  sweepEntities(from, to, radius, exclude) {
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const steps = Math.max(1, Math.ceil(len / 0.4));
    for (const e of this.entities) {
      if (e === exclude || e.removed || e.dead) continue;
      if (e.type === 'item' || e.type === 'xp') continue;
      const a = e.aabb();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const px = from[0] + dx * t, py = from[1] + dy * t, pz = from[2] + dz * t;
        if (px > a[0] - radius && px < a[3] + radius && py > a[1] - radius && py < a[4] + radius && pz > a[2] - radius && pz < a[5] + radius) return e;
      }
    }
    return null;
  }

  isSkyVisible(x, y, z) {
    for (let yy = y; yy < this.world.height; yy++) if (this.world.isOpaque(x, yy, z)) return false;
    return true;
  }

  // ==========================================================================
  //  tile entities & redstone
  // ==========================================================================
  tickTileEntities(dt) {
    const world = this.world;
    // lazily create tile entities for blocks that need them but have none yet
    for (const [key, data] of world.tileEntities) {
      let te = data.__te;
      if (!te || te.invalid) {
        te = createTileEntity(data.id, data.x, data.y, data.z);
        if (te) te.deserialize(data);
        data.__te = te;
      }
      if (!te) continue;
      try { te.tick(world, this, dt); } catch (e) { te.invalid = true; }
      // write changed state back
      if (te.serialize) Object.assign(data, te.serialize());
    }
  }

  tileAt(x, y, z) {
    const data = this.world.getTileEntity(x, y, z);
    if (!data) return null;
    if (!data.__te) {
      const te = createTileEntity(data.id, x, y, z);
      if (!te) return null;
      te.deserialize(data);
      data.__te = te;
    }
    return data.__te;
  }

  runCommandBlock(x, y, z) {
    const data = this.world.getTileEntity(x, y, z);
    if (!data || !data.command) return;
    const res = this.commands.run(data.command);
    this.log(res.messages.join('\n'));
  }

  // ==========================================================================
  //  blocks & world events
  // ==========================================================================
  onBlockChanged(x, y, z, prev, next) {
    this.redstone.onBlockChanged(x, y, z);
    // observers watch their neighbour
    for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const nx = x + d[0], ny = y + d[1], nz = z + d[2];
      if (this.world.getBlock(nx, ny, nz) === blockId('observer')) {
        const m = this.world.getMeta(nx, ny, nz);
        const facing = [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][m & 3];
        if (nx - facing[0] === x && nz - facing[2] === z) this.redstone.pulse(nx, ny, nz);
      }
      if (this.world.getBlock(nx, ny, nz) === blockId('sculk_sensor')) this.redstone.press(nx, ny, nz, 10);
    }
    // falling blocks
    if (next !== AIR && getBlock(next).gravity) {
      // handled by world.setBlock -> scheduleUpdate
    }
  }

  randomTickBlock(x, y, z, id) {
    const b = getBlock(id);
    // leaves without a nearby trunk die back
    if (b.name.includes('leaves') && !b.persistent) {
      if (!this.world.logWithin(x, y, z, 6)) this.world.setBlock(x, y, z, AIR, 0);
      return;
    }
    // crops
    if (b.shape === Shape.CROP) {
      const m = this.world.getMeta(x, y, z);
      const max = b.maxAge || 7;
      if (m < max && this.rng() < 0.25) {
        // needs light and farmland below
        const light = this.world.getLightMax(x, y, z);
        if (light > 8 || this.rng() < 0.1) { this.world.setMeta(x, y, z, m + 1); this.world.markBlockDirty(x, y, z); }
      }
      return;
    }
    if (b.name === 'grass_block') {
      if (this.world.getLightMax(x, y + 1, z) < 4) this.world.setBlock(x, y, z, blockId('dirt'), 0);
      return;
    }
    if (b.name === 'fire') {
      if (this.gamerules.doFireTick) {
        if (this.rng() < 0.4) this.world.setBlock(x, y, z, AIR, 0);
      }
      return;
    }
    if (b.name === 'ice' || b.name === 'snow') {
      const light = this.world.getSkyLight(x, y + 1, z);
      if (light > 11 && this.rng() < 0.02) this.world.setBlock(x, y, z, blockId('water'), 7);
    }
  }

  // ==========================================================================
  //  portals & dimensions
  // ==========================================================================
  tickPortals(dt) {
    const p = this.player;
    const id = this.world.getBlock(Math.floor(p.pos[0]), Math.floor(p.pos[1]), Math.floor(p.pos[2]));
    const name = getBlock(id).name;
    if ((name === 'nether_portal' || name === 'end_portal') && this.portalCooldown <= 0) {
      this.portalTime = (this.portalTime || 0) + dt;
      if (this.portalTime > (p.isCreative ? 0.2 : 4)) {
        this.portalTime = 0;
        this.portalCooldown = 5;
        if (name === 'end_portal') this.changeDimension(p.dimension === 'end' ? 'overworld' : 'end');
        else this.changeDimension(p.dimension === 'nether' ? 'overworld' : 'nether');
      }
    } else {
      this.portalTime = 0;
    }
    if (this.sleeping) {
      this.dayTime += this.sleeping.speed * dt * 60;
      if (this.dayTime >= 24000) this.dayTime -= 24000;
      if (this.dayTime >= this.sleeping.target && this.dayTime < this.sleeping.target + 2000) {
        this.sleeping = null;
        this.world.raining = false;
        this.weather.mode = 'clear';
        if (this.ui) this.ui.showSleepOverlay(false);
      }
    }
  }

  /**
   * Nether portal: find an obsidian frame touching (x, y, z) - the block that
   * was just set on fire - and fill its interior with portal blocks.
   * Frames are vertical rectangles 2..21 wide and 3..21 tall.
   */
  tryLightPortal(x, y, z) {
    const w = this.world;
    const OBS = blockId('obsidian'), PORTAL = blockId('nether_portal'), FIRE = blockId('fire');
    if (!OBS || !PORTAL) return false;
    const at2 = (bx, by, bz) => w.getBlock(bx, by, bz);
    const open = (bx, by, bz) => { const id = at2(bx, by, bz); return id === AIR || id === PORTAL || id === FIRE; };
    for (const [sx, sz] of [[1, 0], [0, 1]]) {
      let a = 0, b = 0;
      while (a > -21 && open(x + sx * (a - 1), y, z + sz * (a - 1))) a--;
      while (b < 21 && open(x + sx * (b + 1), y, z + sz * (b + 1))) b++;
      const width = b - a + 1;
      if (width < 2 || width > 21) continue;
      // the frame blocks sit just outside the opening
      const lx = x + sx * (a - 1), lz = z + sz * (a - 1);
      const rx = x + sx * (b + 1), rz = z + sz * (b + 1);
      // walk down / up for the sill and lintel
      let d = 0, u = 0;
      while (d > -21 && open(x, y + d - 1, z)) d--;
      while (u < 21 && open(x, y + u + 1, z)) u++;
      const height = u - d + 1;
      if (height < 3 || height > 21) continue;
      const by = y + d, ty = y + u;
      let frameOk = true;
      for (let i = a; i <= b && frameOk; i++) {
        const px = x + sx * i, pz = z + sz * i;
        if (at2(px, by - 1, pz) !== OBS || at2(px, ty + 1, pz) !== OBS) frameOk = false;
      }
      for (let yy = d; yy <= u && frameOk; yy++) {
        const py = y + yy;
        if (at2(lx, py, lz) !== OBS || at2(rx, py, rz) !== OBS) frameOk = false;
      }
      if (!frameOk) continue;
      const meta = sx ? 1 : 2;
      for (let i = a; i <= b; i++) for (let yy = d; yy <= u; yy++) {
        const px = x + sx * i, py = y + yy, pz = z + sz * i;
        if (at2(px, py, pz) !== PORTAL) w.setBlock(px, py, pz, PORTAL, meta);
      }
      this.audio.play('portal', x + 0.5, y + 0.5, z + 0.5);
      return true;
    }
    return false;
  }

  /**
   * End portal: 12 end portal frames (a 5x5 ring with the four corners empty)
   * around a 3x3 opening, every one holding an eye of ender.
   */
  tryActivateEndPortal(x, y, z) {
    const w = this.world;
    const FRAME = blockId('end_portal_frame'), PORTAL = blockId('end_portal');
    if (!FRAME || !PORTAL) return false;
    const hasEye = (bx, bz) => {
      if (w.getBlock(bx, y, bz) !== FRAME) return false;
      return (w.getMeta(bx, y, bz) & 4) !== 0;
    };
    for (let ox = -2; ox <= 2; ox++) for (let oz = -2; oz <= 2; oz++) {
      const cx = x + ox, cz = z + oz;
      let frames = 0;
      // ring positions: 5x5 border minus the four empty corners
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
        const border = Math.abs(i) === 2 || Math.abs(j) === 2;
        const corner = Math.abs(i) === 2 && Math.abs(j) === 2;
        if (!border || corner) continue;
        if (!hasEye(cx + i, cz + j)) { frames = -1; break; }
        frames++;
      }
      if (frames !== 12) continue;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        if (w.getBlock(cx + i, y, cz + j) === AIR) w.setBlock(cx + i, y, cz + j, PORTAL, 0);
      }
      this.audio.play('portal', cx + 0.5, y + 0.5, cz + 0.5);
      return true;
    }
    return false;
  }

  async changeDimension(dim) {
    if (dim === this.dimension) return;
    const p = this.player;
    this.entities = this.entities.filter((e) => e === p);
    const old = this.world;
    old.entities = this.entities;
    this.dimension = dim;
    p.dimension = dim;
    const world = this.getWorld(dim);
    if (!world.entities) this.attachWorldHooks(world);
    world.entities = this.entities;
    this.world = world;
    this.renderer.setWorld(world);
    this.redstone = new Redstone(world, this);
    // scale coordinates: nether is 1:8
    const scale = dim === 'nether' ? 1 / 8 : dim === 'overworld' && p.dimension !== 'overworld' ? 8 : 1;
    const spawn = await this.findSpawn(world);
    p.setPos(spawn[0], spawn[1], spawn[2]);
    p.vel.fill(0);
    p.fallDistance = 0;
    this.message('Entered the ' + dim);
    this.audio.play('portal', p.pos[0], p.pos[1], p.pos[2]);
  }

  locateStructure(kind) {
    const g = this.world.generator;
    if (!g.findStructure) return null;
    return g.findStructure(kind, Math.floor(this.player.pos[0] / 16), Math.floor(this.player.pos[2] / 16));
  }

  // ==========================================================================
  //  weather & time
  // ==========================================================================
  updateWeather(dt) {
    const w = this.weather;
    if (this.gamerules.doWeatherCycle) {
      w.timer -= dt * 20;
      if (w.timer <= 0) {
        const rainy = this.rng() < 0.35;
        w.mode = rainy ? (this.rng() < 0.3 ? 'thunder' : 'rain') : 'clear';
        w.timer = 3000 + this.rng() * 12000;
      }
    }
    const target = w.mode === 'clear' ? 0 : 1;
    w.rain += (target - w.rain) * Math.min(1, dt * 0.6);
    if (w.mode === 'thunder' && w.rain > 0.8) {
      w.lightning -= dt;
      if (w.lightning <= 0) {
        w.lightning = 200 + this.rng() * 800;
        // strike somewhere near the player
        const x = this.player.pos[0] + (this.rng() - 0.5) * 64;
        const z = this.player.pos[2] + (this.rng() - 0.5) * 64;
        const y = this.world.topY(Math.floor(x), Math.floor(z));
        this.audio.play('thunder', x, y, z, { maxDist: 128, gain: 0.6 });
        this.renderer.flash = 1;
        if (this.gamerules.mobGriefing) this.world.setBlock(Math.floor(x), y, Math.floor(z), blockId('fire'), 0);
      }
    }
    this.world.raining = w.rain > 0.3;
    this.world.thundering = w.mode === 'thunder' && w.rain > 0.6;
    this.world.rainLevel = w.rain;
    // rain particles
    if (w.rain > 0.2 && this.particles) {
      const n = Math.floor(w.rain * 6);
      const p = this.player;
      for (let i = 0; i < n; i++) {
        const x = p.pos[0] + (Math.random() - 0.5) * 24;
        const z = p.pos[2] + (Math.random() - 0.5) * 24;
        const y = this.world.topY(Math.floor(x), Math.floor(z));
        this.particles.spawn({
          x, y: y + 6 + Math.random() * 4, z,
          vx: 0, vy: -18, vz: 0, life: 1.2, size: 0.04,
          color: [150, 190, 255], tex: null, gravity: 0,
        });
      }
    }
  }

  setWeather(mode, ticks = 6000) {
    this.weather.mode = mode;
    this.weather.timer = ticks;
  }

  setTime(t) {
    this.dayTime = ((t % 24000) + 24000) % 24000;
    this.world.dayTime = this.dayTime;
  }

  // ==========================================================================
  //  particles
  // ==========================================================================
  updateParticles(dt) {
    if (!this.particles) return;
    this.particles.update(dt, this.world);
  }

  spawnBreakParticles(x, y, z, def) {
    if (!this.particles) return;
    const tex = def.tex ? this.renderer.textures.blockMap.get(def.tex.all || def.tex.side || def.tex.top) : null;
    const color = def.particleColor || [150, 150, 150];
    for (let i = 0; i < 14; i++) {
      this.particles.spawn({
        x: x + Math.random(), y: y + Math.random(), z: z + Math.random(),
        vx: (Math.random() - 0.5) * 3, vy: Math.random() * 3, vz: (Math.random() - 0.5) * 3,
        life: 0.6 + Math.random() * 0.6, size: 0.07, color, tex,
      });
    }
  }

  spawnDigParticles(x, y, z, def) {
    if (!this.particles) return;
    this.particles.spawn({
      x: x + Math.random(), y: y + Math.random() * 0.6, z: z + Math.random(),
      vx: 0, vy: 0.4, vz: 0, life: 0.35, size: 0.05,
      color: def.particleColor || [140, 140, 140], tex: null,
    });
  }

  spawnBonemealParticles(x, y, z) {
    if (!this.particles) return;
    for (let i = 0; i < 12; i++) {
      this.particles.spawn({
        x: x + Math.random(), y: y + Math.random(), z: z + Math.random(),
        vx: 0, vy: 0.6 + Math.random(), vz: 0, life: 0.8, size: 0.05,
        color: [120, 240, 120], tex: null, gravity: -1,
      });
    }
  }

  spawnNoteParticle(x, y, z) {
    if (!this.particles) return;
    this.particles.spawn({ x: x + 0.5, y, z: z + 0.5, vx: 0, vy: 1.2, vz: 0, life: 1.0, size: 0.08, color: [255, 240, 120], tex: null, gravity: 0 });
  }

  // ==========================================================================
  //  audio
  // ==========================================================================
  updateAudio(dt) {
    if (!this.audio) return;
    const cam = this.renderer.camera;
    this.audio.setListener(cam.pos, cam.yaw);
    const mood = this.dimension === 'nether' ? 'nether' : this.dimension === 'end' ? 'end' : (this.timeOfDay01 > 0.25 && this.timeOfDay01 < 0.75 ? 'day' : 'night');
    this.audio.updateMusic(dt, mood);
    // footstep sounds
    const p = this.player;
    if (p.onGround) {
      const moved = Math.hypot(p.pos[0] - this.lastStepPos[0], p.pos[2] - this.lastStepPos[2]);
      if (moved > 0.05) {
        this.stepTimer += moved;
        if (this.stepTimer > (p.sprinting ? 1.8 : 2.4)) {
          this.stepTimer = 0;
          const bx = Math.floor(p.pos[0]), bz = Math.floor(p.pos[2]);
          const by = Math.floor(p.pos[1] - 0.2);
          const id = this.world.getBlock(bx, by, bz);
          const snd = getBlock(id).sound || 'stone';
          if (snd !== 'water') this.audio.play('step_' + snd, p.pos[0], p.pos[1] - 1.2, p.pos[2], { pitch: 0.9 + Math.random() * 0.2 });
        }
      }
      this.lastStepPos[0] = p.pos[0]; this.lastStepPos[1] = p.pos[1]; this.lastStepPos[2] = p.pos[2];
    }
    // ambient rain
    if (this.weather.rain > 0.3 && Math.random() < dt * 2) this.audio.play('rain', this.player.pos[0], this.player.pos[1] + 6, this.player.pos[2], { gain: 0.4, allowSpam: true });
  }

  // ==========================================================================
  //  inventory / crafting
  // ==========================================================================
  openScreen(name, data = null) {
    this.screen = name;
    if (this.input) { this.input.exitLock(); this.input.setEnabled(false); }
    if (this.ui) this.ui.openScreen(name, data);
  }

  closeScreen() {
    const wasCrafting = this.screen === 'crafting' || this.screen === 'inventory';
    if (wasCrafting) this.returnCraftingItems();
    this.screen = null;
    this.openInventory = null;
    this.openTile = null;
    if (this.input) this.input.setEnabled(true);
    if (this.ui) this.ui.closeScreen();
  }

  returnCraftingItems() {
    const inv = this.player.inventory;
    for (let i = 0; i < this.craftGrid.size; i++) {
      const s = this.craftGrid.get(i);
      if (!s) continue;
      const left = inv.add(s);
      if (left > 0) this.dropItem(this.player.pos[0], this.player.pos[1] + 1, this.player.pos[2], new ItemStack(s.id, left));
      this.craftGrid.set(i, null);
    }
  }

  openContainerAt(x, y, z, name) {
    const data = this.world.getTileEntity(x, y, z);
    if (!data) this.world.addTileEntity(x, y, z, { id: this.world.getBlock(x, y, z), x, y, z });
    const te = this.tileAt(x, y, z);
    if (!te) return;
    this.openTile = te;
    this.openInventory = te.inv || null;
    this.openScreen(name, te);
    this.audio.play('chest_open', x + 0.5, y + 0.5, z + 0.5);
  }

  /** Run the 3x3 crafting grid against the recipe table. */
  updateCrafting() {
    const grid = new Array(9).fill(0);
    for (let i = 0; i < 9; i++) {
      const s = this.craftGrid.get(i);
      grid[i] = s ? s.id : 0;
    }
    const r = matchRecipe(grid);
    this.selectedRecipe = r;
    if (this.ui) this.ui.markDirty('crafting');
    return r;
  }

  craft(shift = false) {
    const r = this.selectedRecipe || this.updateCrafting();
    if (!r) return 0;
    let made = 0;
    const maxMake = shift ? 64 : 1;
    for (let n = 0; n < maxMake; n++) {
      const grid = new Array(9).fill(0);
      for (let i = 0; i < 9; i++) { const s = this.craftGrid.get(i); grid[i] = s ? s.id : 0; }
      const rec = matchRecipe(grid);
      if (!rec) break;
      const out = new ItemStack(rec.result, rec.count);
      if (out.count <= 0) break;
      // shift-click: keep going while the grid still matches and there is room
      consumeIngredients(this.craftGrid, grid);
      const left = this.player.inventory.add(out);
      if (left > 0) this.dropItem(this.player.pos[0], this.player.pos[1] + 1, this.player.pos[2], new ItemStack(out.id, left));
      made += rec.count;
      if (!shift) break;
      // stop if a slot ran dry
      let any = false;
      for (let i = 0; i < 9; i++) if (this.craftGrid.get(i)) any = true;
      if (!any) break;
    }
    this.updateCrafting();
    if (this.ui) this.ui.markDirty('hotbar');
    return made;
  }

  /** Move an item between the player inventory and an open container. */
  transferSlot(fromInv, fromSlot, toInv) {
    const s = fromInv.get(fromSlot);
    if (!s) return;
    const left = toInv.add(s);
    if (left === 0) fromInv.set(fromSlot, null);
    else s.count = left;
    fromInv.changed();
    toInv.changed();
  }

  dropHeld(all = false) {
    const held = this.player.inventory.getHeld();
    if (!held) return;
    const p = this.player;
    const dir = p.forward([0, 0, 0]);
    const stack = new ItemStack(held.id, all ? held.count : 1);
    if (!all) held.count--;
    else this.player.inventory.setHeld(null);
    if (!all && held.count <= 0) this.player.inventory.setHeld(null);
    const e = this.dropItem(p.pos[0] + dir[0] * 0.6, p.pos[1] + p.eyeHeight - 0.3, p.pos[2] + dir[2] * 0.6, stack);
    if (e) { e.vel[0] = dir[0] * 6 + p.vel[0]; e.vel[1] = 2 + p.vel[1]; e.vel[2] = dir[2] * 6 + p.vel[2]; e.pickupDelay = 40; }
    if (this.ui) this.ui.markDirty('hotbar');
  }

  selectHotbar(i) {
    this.player.selectedSlot = clamp(i, 0, 8);
    this.player.inventory.selected = this.player.selectedSlot;
    if (this.ui) this.ui.markDirty('hotbar');
  }

  cycleHotbar(dir) {
    this.selectHotbar((this.player.inventory.selected + dir + 9) % 9);
  }

  pickBlock() {
    const hit = this.raycast();
    const inv = this.player.inventory;
    if (!hit) return;
    const id = hit.id;
    for (let i = 0; i < 9; i++) {
      const s = inv.get(i);
      if (s && s.id === id) { this.selectHotbar(i); return; }
    }
    if (this.player.isCreative) {
      inv.set(this.player.inventory.selected, new ItemStack(id, 1));
      this.selectHotbar(this.player.inventory.selected);
    }
  }

  swapHands() {
    const inv = this.player.inventory;
    const held = inv.getHeld();
    inv.setHeld(inv.offhand);
    inv.offhand = held;
    if (this.ui) this.ui.markDirty('hotbar');
  }

  // ==========================================================================
  //  gamemode, death, respawn
  // ==========================================================================
  setGamemode(mode) {
    this.player.gamemode = mode;
    this.applyGamemodeRules(this.player);
    if (this.ui) this.ui.markDirty('all');
  }

  applyGamemodeRules(p) {
    if (p.gamemode === GAMEMODE.CREATIVE) {
      p.canFly = true;
      p.invulnerable = true;
    } else if (p.gamemode === GAMEMODE.SPECTATOR) {
      p.canFly = true;
      p.flying = true;
      p.invulnerable = true;
    } else {
      p.canFly = false;
      p.flying = false;
      p.invulnerable = false;
    }
  }

  onPlayerDeath(player, source) {
    this.statistics.deaths++;
    this.deathMessage = deathMessage(source);
    if (this.ui) this.ui.showDeathScreen(this.deathMessage);
    this.audio.play('die', player.pos[0], player.pos[1], player.pos[2]);
    if (!this.gamerules.keepInventory) {
      const inv = player.inventory;
      for (const s of inv.slots) if (s) this.dropItem(player.pos[0], player.pos[1] + 0.5, player.pos[2], s);
      for (const s of inv.armor) if (s) this.dropItem(player.pos[0], player.pos[1] + 0.5, player.pos[2], s);
      inv.clear();
      player.xp = 0;
      player.xpLevel = Math.max(0, player.xpLevel - 5);
    }
  }

  respawnPlayer() {
    this.player.respawn();
    if (this.ui) this.ui.hideDeathScreen();
  }

  // ==========================================================================
  //  chat, commands, messages
  // ==========================================================================
  message(text) {
    this.messages.push({ text, t: performance.now() });
    if (this.messages.length > 100) this.messages.shift();
    if (this.ui) this.ui.pushMessage(text);
    this.log(text);
  }

  log(text) { this.onLog(String(text)); }

  runCommand(text) {
    const res = this.commands.run(text);
    for (const m of res.messages) this.message(m);
    return res;
  }

  // ==========================================================================
  //  save / load
  // ==========================================================================
  async save() {
    if (!this.saveSystem) return;
    for (const c of this.world.chunks.values()) if (c.needsSave) this.saveSystem.queueChunk(c, this.dimension);
    await this.saveSystem.flush();
    await this.saveSystem.saveMeta('player', this.player.serialize());
    await this.saveSystem.saveMeta('world', {
      seed: this.seed, dayTime: this.dayTime, totalTime: this.totalTime,
      weather: this.weather, gamerules: this.gamerules, difficulty: this.difficulty,
      dimension: this.dimension, statistics: this.statistics,
      advancements: [...this.advancements],
    });
    await this.saveSystem.saveWorldInfo({
      seed: this.seed, name: this.worldId, time: Date.now(), dayTime: this.dayTime,
      gamemode: this.player.gamemode, difficulty: this.difficulty,
    });
    this.message('World saved');
  }

  async load() {
    if (!this.saveSystem) return;
    const world = await this.saveSystem.loadMeta('world');
    if (world) {
      this.dayTime = world.dayTime ?? this.dayTime;
      this.totalTime = world.totalTime ?? 0;
      this.weather = Object.assign(this.weather, world.weather || {});
      this.gamerules = Object.assign(this.gamerules, world.gamerules || {});
      this.difficulty = world.difficulty || this.difficulty;
      if (world.statistics) this.statistics = Object.assign(this.statistics, world.statistics);
      if (world.advancements) this.advancements = new Set(world.advancements);
    }
    const p = await this.saveSystem.loadMeta('player');
    if (p) {
      this.player.setPos(p.pos[0], p.pos[1], p.pos[2]);
      this.player.health = p.health ?? this.player.health;
      this.player.hunger = p.hunger ?? 20;
      this.player.xp = p.xp || 0;
      this.player.xpLevel = p.xpLevel || 0;
      this.player.gamemode = p.gamemode || this.player.gamemode;
      if (p.selectedSlot !== undefined) this.player.selectedSlot = p.selectedSlot;
      this.player.inventory.selected = this.player.selectedSlot;
      if (p.spawnPoint) this.player.spawnPoint = p.spawnPoint;
      if (p.effects) for (const e of p.effects) this.player.addEffect(e.name, e.duration, e.amplifier);
      this.applyGamemodeRules(this.player);
      const inv = await this.saveSystem.loadMeta('inventory');
      if (inv) this.player.inventory.deserialize(inv);
    }
  }

  async saveInventory() {
    if (this.saveSystem) await this.saveSystem.saveMeta('inventory', this.player.inventory.serialize());
  }

  // ==========================================================================
  //  input actions
  // ==========================================================================
  onAction(action, down, event) {
    switch (action) {
      case 'attack': this.attack(down); break;
      case 'attackTap': this.attack(true); setTimeout(() => this.attack(false), 120); break;
      case 'use': this.use(down); break;
      case 'useTap': this.use(true); break;
      case 'jump': break;
      case 'drop': if (down) this.dropHeld(event && event.shiftKey); break;
      case 'inventory': if (down) this.toggleInventory(); break;
      case 'swapHands': if (down) this.swapHands(); break;
      case 'pickBlock': if (down) this.pickBlock(); break;
      case 'menu': if (down) this.togglePause(); break;
      case 'chat': if (down && this.ui) this.ui.openChat(''); break;
      case 'chatCmd': if (down && this.ui) this.ui.openChat('/'); break;
      case 'debug': if (down) { this.debug = !this.debug; } break;
      case 'hideHud': if (down) { this.hudVisible = !this.hudVisible; if (this.ui) this.ui.setHudVisible(this.hudVisible); } break;
      case 'togglePerspective': if (down) this.perspective = (this.perspective + 1) % 3; break;
      case 'hotbar': if (down) this.selectHotbar(action.index !== undefined ? action.index : (event ? 0 : 0)); break;
      case 'pointerlock': if (!down && !this.screen && this.opts.autoPause !== false) this.togglePause(true); break;
      default: break;
    }
    // hotbar is delivered with the index as the value
    if (action === 'hotbar' && typeof down === 'number') this.selectHotbar(down);
  }

  toggleInventory() {
    if (this.screen === 'inventory' || this.screen === 'crafting') this.closeScreen();
    else this.openScreen('inventory');
  }

  togglePause(force = false) {
    if (this.screen === 'pause') { this.closeScreen(); this.paused = false; }
    else if (!this.screen || force) { this.openScreen('pause'); this.paused = true; }
    else this.closeScreen();
  }

  // ==========================================================================
  //  misc
  // ==========================================================================
  checkAdvancement(id, condition) {
    if (condition && !this.advancements.has(id)) {
      this.advancements.add(id);
      if (this.ui) this.ui.toast('Advancement: ' + id.replace(/_/g, ' '));
    }
  }

  getDebugText() {
    const p = this.player;
    const w = this.world;
    const st = this.renderer.stats;
    const chunk = w.getChunk(p.pos[0] >> 4, p.pos[2] >> 4);
    const light = w.getLight(Math.floor(p.pos[0]), Math.floor(p.pos[1] + 1), Math.floor(p.pos[2]));
    return [
      `Ultracraft  fps ${this.profiler.fps.toFixed(0)}  tick ${this.profiler.tickMs.toFixed(1)}ms  render ${this.profiler.renderMs.toFixed(1)}ms`,
      `xyz ${p.pos[0].toFixed(2)} ${p.pos[1].toFixed(2)} ${p.pos[2].toFixed(2)}  chunk ${p.pos[0] >> 4} ${p.pos[2] >> 4}`,
      `facing ${facingName(p.yaw)} (${p.yaw.toFixed(2)}) pitch ${(p.pitch * 180 / Math.PI).toFixed(1)}`,
      `biome ${w.generator.biomeAt ? w.generator.biomeAt(Math.floor(p.pos[0]), Math.floor(p.pos[2])).name : '-'}  light block ${(light >> 4) & 15} sky ${light & 15}`,
      `chunks ${st.chunks} drawn / ${w.chunks.size} loaded  gen ${w.stats.genPending}  tri ${Math.round(st.triangles)}  draws ${st.drawCalls}`,
      `entities ${this.entities.length}  particles ${this.particles ? this.particles.parts.length : 0}  time ${Math.floor(this.dayTime)} (${Math.floor(this.dayTime / 1000)}:00)`,
      `mem ${(performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) : '?')} MB  seed ${this.seed}  dim ${this.dimension}`,
      `quality ${this.renderer.quality.name || this.opts.quality || 'fancy'}  scale ${this.renderer.renderScale.toFixed(2)}  recipes ${recipeCount()}`,
      chunk && chunk.generated ? '' : 'waiting for chunks…',
    ].filter(Boolean);
  }

  /** Data snapshot for the HUD. */
  getHudState() {
    const p = this.player;
    return {
      health: p.health, maxHealth: p.maxHealth, hunger: p.hunger, saturation: p.saturation,
      air: p.air, maxAir: p.maxAir, xp: p.xp, xpLevel: p.xpLevel, xpNext: p.xpForNextLevel(),
      armor: p.getArmorValue(), effects: [...p.effects.values()],
      gamemode: p.gamemode, hotbar: p.inventory.selected,
      inventory: p.inventory, boss: this.bossBar,
      debug: this.debug ? this.getDebugText() : null,
    };
  }
}

function deathMessage(source) {
  const map = {
    fall: 'hit the ground too hard', lava: 'tried to swim in lava', fire: 'went up in flames',
    drown: 'drowned', starve: 'starved to death', void: 'fell out of the world',
    explosion: 'was blown up', magic: 'was killed by magic', poison: 'died from poison',
    wither: 'withered away', cactus: 'was pricked to death', suffocation: 'suffocated in a wall',
    generic: 'died',
  };
  return map[source] || 'died';
}

function facingName(yaw) {
  const a = ((yaw + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 2);
  return ['north (-Z)', 'west (-X)', 'south (+Z)', 'east (+X)'][Math.round(a) % 4];
}

function rayAabb(o, d, box, maxDist) {
  let tmin = 0, tmax = maxDist;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) {
      if (o[i] < box[i] || o[i] > box[i + 3]) return null;
    } else {
      const inv = 1 / d[i];
      let t1 = (box[i] - o[i]) * inv;
      let t2 = (box[i + 3] - o[i]) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

export default Game;
