/**
 * Ultracraft - the player.
 *
 * Fully featured movement (walk / sprint / sneak / swim / climb / elytra-less
 * creative flight), survival stats (health, hunger, saturation, air, xp),
 * status effects, mining speed calculation and reach-based interaction.
 */

import { Entity } from './entity.js';
import { getBlock, AIR, BLOCK, blockId } from '../world/blocks.js';
import { getItem, itemByName, ITEMS } from '../world/items.js';
import { clamp, lerp } from '../core/math.js';

export const GAMEMODE = { SURVIVAL: 'survival', CREATIVE: 'creative', ADVENTURE: 'adventure', SPECTATOR: 'spectator' };

export const EFFECTS = {
  speed: { color: [124, 175, 198], good: true, name: 'Speed' },
  slowness: { color: [90, 108, 129], good: false, name: 'Slowness' },
  haste: { color: [217, 192, 67], good: true, name: 'Haste' },
  mining_fatigue: { color: [74, 66, 43], good: false, name: 'Mining Fatigue' },
  strength: { color: [147, 36, 35], good: true, name: 'Strength' },
  jump_boost: { color: [34, 255, 76], good: true, name: 'Jump Boost' },
  nausea: { color: [85, 29, 74], good: false, name: 'Nausea' },
  regeneration: { color: [205, 82, 171], good: true, name: 'Regeneration' },
  resistance: { color: [153, 69, 58], good: true, name: 'Resistance' },
  fire_resistance: { color: [228, 154, 58], good: true, name: 'Fire Resistance' },
  water_breathing: { color: [46, 82, 153], good: true, name: 'Water Breathing' },
  invisibility: { color: [127, 131, 146], good: true, name: 'Invisibility' },
  blindness: { color: [31, 31, 35], good: false, name: 'Blindness' },
  night_vision: { color: [31, 63, 153], good: true, name: 'Night Vision' },
  hunger: { color: [88, 118, 83], good: false, name: 'Hunger' },
  weakness: { color: [72, 77, 72], good: false, name: 'Weakness' },
  poison: { color: [78, 147, 49], good: false, name: 'Poison' },
  wither: { color: [53, 42, 39], good: false, name: 'Wither' },
  health_boost: { color: [248, 125, 35], good: true, name: 'Health Boost' },
  absorption: { color: [37, 82, 165], good: true, name: 'Absorption' },
  saturation: { color: [248, 36, 35], good: true, name: 'Saturation' },
  glowing: { color: [148, 160, 97], good: true, name: 'Glowing' },
  levitation: { color: [206, 255, 255], good: false, name: 'Levitation' },
  luck: { color: [51, 153, 0], good: true, name: 'Luck' },
  unluck: { color: [192, 164, 77], good: false, name: 'Unluck' },
  slow_falling: { color: [246, 246, 246], good: true, name: 'Slow Falling' },
  conduit_power: { color: [29, 187, 191], good: true, name: 'Conduit Power' },
  dolphins_grace: { color: [136, 199, 255], good: true, name: "Dolphin's Grace" },
  bad_omen: { color: [11, 92, 40], good: false, name: 'Bad Omen' },
  hero_of_the_village: { color: [68, 255, 255], good: true, name: 'Hero of the Village' },
  darkness: { color: [41, 41, 48], good: false, name: 'Darkness' },
};

export class Player extends Entity {
  constructor(world, x, y, z, game) {
    super(world, x, y, z, { type: 'player', width: 0.6, height: 1.8, health: 20 });
    this.game = game;
    this.name = 'Player';
    this.gamemode = GAMEMODE.SURVIVAL;
    this.eyeHeight = 1.62;
    this.stepHeight = 0.6;
    this.hunger = 20;
    this.saturation = 5;
    this.exhaustion = 0;
    this.air = 300;
    this.maxAir = 300;
    this.xp = 0;
    this.xpLevel = 0;
    this.score = 0;
    this.effects = new Map();      // name -> {amplifier, duration, color}
    this.inventory = null;         // set by the game
    this.flying = false;
    this.canFly = false;
    this.sprinting = false;
    this.sneaking = false;
    this.swimming = false;
    this.climbing = false;
    this.onLadder = false;
    this.movementInput = [0, 0];   // forward, strafe
    this.jumpQueued = false;
    this.fovModifier = 0;
    this.bobPhase = 0;
    this.breakProgress = 0;
    this.breakTarget = null;
    this.attackCooldown = 0;
    this.reach = 5;
    this.creativeReach = 6;
    this.spawnPoint = [x, y, z];
    this.respawnTimer = 0;
    this.dimension = 'overworld';
    this.portalTime = 0;
    this.lastDamage = 0;
    this.selectedSlot = 0;
    this.sleeping = false;
    this.prevHealth = 20;
    this.healthRegenTimer = 0;
    this.foodTimer = 0;
    this.statistics = {};
  }

  get isCreative() { return this.gamemode === GAMEMODE.CREATIVE; }
  get isSpectator() { return this.gamemode === GAMEMODE.SPECTATOR; }
  get reachDistance() { return this.isCreative ? this.creativeReach : this.reach; }

  // -------------------------------------------------------------------------
  update(dt) {
    if (this.removed) return;
    this.prevHealth = this.health;
    if (this.respawnTimer > 0) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn();
      return;
    }
    this.updateEffects(dt);
    if (this.isSpectator) {
      this.spectatorMove(dt);
      super.update(dt);
      return;
    }
    this.handleMovement(dt);
    super.update(dt);
    this.updateSurvival(dt);
    if (this.attackCooldown > 0) this.attackCooldown -= dt;
  }

  handleMovement(dt) {
    const speedEff = this.getEffectLevel('speed') - this.getEffectLevel('slowness');
    let base = 0.1;
    if (this.sprinting) base *= 1.3;
    base *= clamp(1 + speedEff * 0.2, 0.15, 2.5);
    if (this.sneaking) base *= 0.3;
    if (this.flying) base *= this.sprinting ? 4.5 : 2.2;
    const slip = this.getSlipperiness();
    let accel = (this.onGround ? 0.14 : 0.05) * slip;
    if (this.inWater) accel *= 0.5;

    const [fwd, strafe] = this.movementInput;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // forward = (-sin, -cos)
    let mx = -sin * fwd + cos * strafe;
    let mz = -cos * fwd - sin * strafe;
    const l = Math.hypot(mx, mz);
    if (l > 1) { mx /= l; mz /= l; }

    const targetVX = mx * base * 20;
    const targetVZ = mz * base * 20;
    this.vel[0] += (targetVX - this.vel[0]) * clamp(accel * dt * 60, 0, 1);
    this.vel[2] += (targetVZ - this.vel[2]) * clamp(accel * dt * 60, 0, 1);

    // jumping / swimming / flying
    this.swimUp = false;
    if (this.inWater) {
      if (this.jumpQueued) { this.vel[1] = 4.2; this.swimUp = true; }
      this.vel[1] *= 0.94;
    } else if (this.flying) {
      this.vel[1] *= 0.9;
      if (this.jumpQueued) this.vel[1] += 8;
      if (this.sneaking) this.vel[1] -= 8;
    } else if (this.jumpQueued && (this.onGround || this.onLadder)) {
      this.vel[1] = 8.4 + this.getEffectLevel('jump_boost') * 1.2;
      if (this.sprinting) this.exhaust(0.2);
      else this.exhaust(0.05);
    }
    // ladders & vines
    this.onLadder = this.isOnClimbable();
    if (this.onLadder) {
      if (this.movementInput[0] > 0 || this.jumpQueued) this.vel[1] = 3.2;
      else if (this.sneaking) this.vel[1] = Math.max(this.vel[1], -0.1);
      else this.vel[1] = Math.max(this.vel[1], -0.6);
    }
    this.jumpQueued = false;

    // sneaking off edges
    if (this.sneaking && this.onGround) {
      // keep the player from walking off a ledge
      const nx = this.pos[0] + this.vel[0] * dt, nz = this.pos[2] + this.vel[2] * dt;
      const y = this.pos[1];
      if (this.vel[0] !== 0 && !this.hasGroundBelow(nx, y, this.pos[2])) this.vel[0] = 0;
      if (this.vel[2] !== 0 && !this.hasGroundBelow(this.pos[0], y, nz)) this.vel[2] = 0;
    }

    // bobbing for the view
    const speed = Math.hypot(this.vel[0], this.vel[2]);
    this.bobPhase += speed * dt * 1.4;
    if (speed > 0.1 && this.onGround) this.exhaust(this.sprinting ? speed * dt * 0.1 : speed * dt * 0.01);
  }

  hasGroundBelow(x, y, z) {
    for (let i = 0; i < 4; i++) {
      if (this.world.isSolid(Math.floor(x), Math.floor(y - 0.1 - i * 0.25), Math.floor(z))) return true;
    }
    return false;
  }

  isOnClimbable() {
    const x = Math.floor(this.pos[0]), z = Math.floor(this.pos[2]);
    const y = Math.floor(this.pos[1] + 0.2);
    for (let dy = 0; dy < 2; dy++) {
      const id = this.world.getBlock(x, y + dy, z);
      if (id !== AIR && getBlock(id).climbable) return true;
    }
    return false;
  }

  getSlipperiness() {
    const x = Math.floor(this.pos[0]), z = Math.floor(this.pos[2]);
    const y = Math.floor(this.pos[1] - 0.1);
    const id = this.world.getBlock(x, y, z);
    if (id === AIR) return 1;
    return getBlock(id).slipperiness || 0.6;
  }

  spectatorMove(dt) {
    const [fwd, strafe] = this.movementInput;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    let mx = -sin * cp * fwd + cos * strafe;
    let my = sp * fwd;
    let mz = -cos * cp * fwd - sin * strafe;
    const s = (this.sprinting ? 30 : 12);
    this.vel[0] = mx * s; this.vel[1] = my * s; this.vel[2] = mz * s;
  }

  // -------------------------------------------------------------------------
  updateSurvival(dt) {
    if (this.isCreative) return;
    // hunger
    this.foodTimer += dt;
    if (this.foodTimer > 4) {
      this.foodTimer = 0;
      if (this.hunger > 0) {
        this.saturation = Math.max(0, this.saturation - 0.02);
      }
    }
    if (this.exhaustion >= 4) {
      this.exhaustion -= 4;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else this.hunger = Math.max(0, this.hunger - 1);
    }
    // natural regen
    this.healthRegenTimer += dt;
    if (this.healthRegenTimer > (this.hunger > 17 ? 2 : 4)) {
      this.healthRegenTimer = 0;
      if (this.health < this.maxHealth && this.hunger > 0) {
        this.heal(1);
        this.exhaust(0.6);
      }
    }
    // starvation
    if (this.hunger <= 0) {
      this.starveTimer = (this.starveTimer || 0) + dt;
      if (this.starveTimer > 4) { this.starveTimer = 0; this.hurt(1, 'starve'); }
    }
    // air
    if (this.submerged && !this.hasEffect('water_breathing')) {
      this.air -= dt * 20;
      if (this.air <= 0) { this.air = 0; this.drownTimer = (this.drownTimer || 0) + dt; if (this.drownTimer > 1) { this.drownTimer = 0; this.hurt(2, 'drown'); } }
    } else {
      this.air = Math.min(this.maxAir, this.air + dt * 60);
      this.drownTimer = 0;
    }
  }

  exhaust(amount) {
    if (this.isCreative) return;
    this.exhaustion += amount;
  }

  // -------------------------------------------------------------------------
  addEffect(name, duration = 600, amplifier = 0) {
    if (!EFFECTS[name]) return;
    const prev = this.effects.get(name);
    this.effects.set(name, { duration: Math.max(prev ? prev.duration : 0, duration), amplifier, name });
    if (this.onEffectsChanged) this.onEffectsChanged();
  }
  removeEffect(name) { this.effects.delete(name); if (this.onEffectsChanged) this.onEffectsChanged(); }
  getEffectLevel(name) {
    const e = this.effects.get(name);
    return e ? e.amplifier + 1 : 0;
  }
  hasEffect(name) { return this.effects.has(name); }

  updateEffects(dt) {
    for (const [name, e] of this.effects) {
      e.duration -= dt * 20;
      if (e.duration <= 0) { this.effects.delete(name); if (this.onEffectsChanged) this.onEffectsChanged(); continue; }
      // tick effects
      if (name === 'regeneration' && (e.duration % 50 | 0) === 0) this.heal(1);
      if (name === 'poison' && (e.duration % 25 | 0) === 0 && this.health > 1) this.hurt(1, 'poison');
      if (name === 'wither' && (e.duration % 40 | 0) === 0) this.hurt(1, 'wither');
      if (name === 'hunger') this.exhaust(0.005 * (e.amplifier + 1));
    }
  }

  // -------------------------------------------------------------------------
  addXp(amount) {
    this.xp += amount;
    this.score += amount;
    while (this.xp >= this.xpForNextLevel()) {
      this.xp -= this.xpForNextLevel();
      this.xpLevel++;
      if (this.onLevelUp) this.onLevelUp(this.xpLevel);
    }
    if (this.onXpChanged) this.onXpChanged();
  }
  xpForNextLevel() { return 7 + Math.floor(this.xpLevel * 3.5); }
  takeXpLevels(n) {
    if (this.xpLevel < n) return false;
    this.xpLevel -= n;
    if (this.onXpChanged) this.onXpChanged();
    return true;
  }

  // -------------------------------------------------------------------------
  /** Tool/mining speed multiplier for a block. */
  breakSpeed(block) {
    if (this.isCreative) return 999;
    const held = this.inventory ? this.inventory.getHeld() : null;
    const t = held ? held.def.tool : null;
    let speed = 1;
    if (t) {
      if (block.tool && t.kind === block.tool) speed = t.speed;
      else if (block.tool) speed = 1;
      else speed = Math.max(1, t.speed * 0.6);
      const eff = held.getEnchantment('efficiency');
      if (eff) speed += eff * eff + 1;
    } else if (block.tool) {
      speed = 1;
    }
    if (block.hardness <= 0) return 999;
    const haste = this.getEffectLevel('haste') * 0.2;
    const fatigue = this.getEffectLevel('mining_fatigue') * 0.3;
    speed *= 1 + haste - fatigue;
    if (this.submerged && !(held && held.getEnchantment('aqua_affinity') > 0)) speed *= 0.2;
    if (!this.onGround) speed *= 0.2;
    return Math.max(0.05, speed);
  }

  /** Seconds to break a block with the current tool. */
  breakTime(block) {
    if (this.isCreative) return 0;
    if (block.hardness < 0) return Infinity;
    const speed = this.breakSpeed(block);
    return block.hardness * 1.5 / speed;
  }

  getAttackDamage(against = null) {
    let dmg = 1;
    const held = this.inventory ? this.inventory.getHeld() : null;
    const tool = held ? held.def.tool : null;
    if (tool) dmg = (tool.damage || 0) + 1;
    if (held) {
      const sharp = held.getEnchantment('sharpness');
      if (sharp) dmg += sharp * 0.5 + 0.5;
    }
    const str = this.getEffectLevel('strength') * 3;
    const weak = this.getEffectLevel('weakness') * 4;
    return Math.max(0, dmg + str - weak);
  }

  /** 0..1 charge used by the attack indicator. */
  getAttackCooldownProgress() {
    return clamp((1 - this.attackCooldown / 0.6), 0, 1);
  }

  getArmorValue() {
    let v = 0;
    if (!this.inventory) return 0;
    for (const it of this.inventory.armor) {
      if (it && it.def.armor) v += it.def.armor.defense || 0;
    }
    return v;
  }

  getArmorToughness() {
    let v = 0;
    if (!this.inventory) return 0;
    for (const it of this.inventory.armor) {
      if (it && it.def.armor) v += it.def.armor.toughness || 0;
    }
    return v;
  }

  hurt(amount, source = 'generic', from = null) {
    if (this.isCreative || this.isSpectator) return false;
    if (this.respawnTimer > 0) return false;
    let dmg = amount;
    // armour reduction
    const armor = this.getArmorValue();
    if (source !== 'void' && source !== 'starve' && source !== 'drown' && source !== 'fall') {
      dmg *= Math.max(0.1, 1 - armor * 0.04);
      const prot = this.getEnchantmentSum('protection');
      dmg *= Math.max(0.2, 1 - prot * 0.04);
    }
    if (source === 'fall') { const ff = this.getEnchantmentSum('feather_falling'); dmg *= Math.max(0.2, 1 - ff * 0.12); }
    if (this.hasEffect('resistance')) dmg *= Math.max(0.2, 1 - this.getEffectLevel('resistance') * 0.2);
    const res = super.hurt(dmg, source, from);
    if (res) this.lastDamage = this.age;
    return res;
  }

  getEnchantmentSum(name) {
    let s = 0;
    if (!this.inventory) return 0;
    for (const it of [...this.inventory.armor, this.inventory.getHeld()]) {
      if (it) s += it.getEnchantment(name);
    }
    return s;
  }

  die(source) {
    if (this.isCreative) { this.health = this.maxHealth; return; }
    super.die(source);
    this.respawnTimer = 2;
    if (this.game && this.game.onPlayerDeath) this.game.onPlayerDeath(this, source);
  }

  respawn() {
    this.dead = false;
    this.deathTime = 0;
    this.health = this.maxHealth;
    this.hunger = 20;
    this.saturation = 5;
    this.air = this.maxAir;
    this.effects.clear();
    this.fireTicks = 0;
    this.fallDistance = 0;
    const [x, y, z] = this.spawnPoint;
    this.setPos(x, y, z);
    this.vel.fill(0);
    if (this.gamemode === GAMEMODE.SURVIVAL && this.game) this.game.applyGamemodeRules(this);
    if (this.onRespawn) this.onRespawn();
  }

  setSpawn(x, y, z) { this.spawnPoint = [x, y, z]; }

  serialize() {
    return Object.assign(super.serialize(), {
      gamemode: this.gamemode, hunger: this.hunger, saturation: this.saturation,
      xp: this.xp, xpLevel: this.xpLevel, air: this.air,
      effects: [...this.effects.values()], spawnPoint: this.spawnPoint,
      selectedSlot: this.selectedSlot, flying: this.flying,
    });
  }
}

export default Player;
