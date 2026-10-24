/**
 * Ultracraft - mobs: definitions, procedural box models and AI.
 *
 * Every mob is built from animated cuboids (like the real game) with a
 * procedurally generated face sprite, so the whole bestiary costs a few
 * hundred bytes of code instead of megabytes of textures.
 */

import { Entity } from './entity.js';
import { getBlock, AIR, BLOCK, blockId } from '../world/blocks.js';
import { itemId } from '../world/items.js';
import { clamp, lerp, makeRng } from '../core/math.js';

// ---------------------------------------------------------------------------
//  definitions
// ---------------------------------------------------------------------------
export const MOB_DEFS = {
  pig: { model: 'quadruped', width: 0.9, height: 0.9, health: 10, speed: 1.1, color: [242, 186, 190], face: 'pig_face', follow: 'carrot', drops: [['porkchop', 1, 3]], xp: 3, passive: true, stepHeight: 1.0 },
  cow: { model: 'quadruped', width: 0.9, height: 1.4, health: 10, speed: 1.0, color: [70, 52, 40], face: 'cow_face', follow: 'wheat', drops: [['beef', 1, 3], ['leather', 0, 2]], xp: 3, passive: true, stepHeight: 1.0 },
  sheep: { model: 'quadruped_wool', width: 0.9, height: 1.3, health: 8, speed: 1.0, color: [235, 235, 235], face: 'sheep_face', follow: 'wheat', drops: [['mutton', 1, 2], ['white_wool', 1, 1]], xp: 3, passive: true, stepHeight: 1.0, shearable: true },
  chicken: { model: 'bird', width: 0.5, height: 0.7, health: 4, speed: 1.0, color: [240, 240, 235], face: 'chicken_face', follow: 'wheat_seeds', drops: [['chicken', 1, 1], ['feather', 0, 2]], xp: 3, passive: true, stepHeight: 1.0, eggLay: true },
  rabbit: { model: 'quadruped', width: 0.5, height: 0.5, health: 3, speed: 1.4, color: [190, 170, 150], face: 'rabbit_face', follow: 'carrot', drops: [['rabbit', 0, 1], ['rabbit_hide', 0, 1]], xp: 1, passive: true, stepHeight: 1.0 },
  wolf: { model: 'quadruped', width: 0.7, height: 0.85, health: 8, speed: 1.6, color: [160, 160, 165], face: 'wolf_face', drops: [], xp: 1, passive: true, tameable: 'bone', stepHeight: 1.0, hostileWhenAttacked: true, damage: 3 },
  cat: { model: 'quadruped', width: 0.6, height: 0.7, health: 10, speed: 1.4, color: [225, 170, 90], face: 'cat_face', drops: [], xp: 1, passive: true, tameable: 'cod', stepHeight: 1.0 },
  villager: { model: 'biped', width: 0.6, height: 1.95, health: 20, speed: 1.0, color: [150, 120, 90], face: 'villager_face', drops: [], xp: 0, passive: true, stepHeight: 1.0, villager: true },
  iron_golem: { model: 'golem', width: 1.4, height: 2.7, health: 100, speed: 0.9, color: [200, 195, 185], face: 'golem_face', drops: [['iron_ingot', 3, 5]], xp: 0, passive: true, stepHeight: 1.0, damage: 12, protective: true },
  zombie: { model: 'biped', width: 0.6, height: 1.95, health: 20, speed: 1.0, color: [90, 140, 80], face: 'zombie_head', drops: [['rotten_flesh', 0, 2]], xp: 5, hostile: true, damage: 3, burnsInDay: true, stepHeight: 1.0, armor: true },
  husk: { model: 'biped', width: 0.6, height: 1.95, health: 20, speed: 1.0, color: [150, 140, 80], face: 'zombie_head', drops: [['rotten_flesh', 0, 2]], xp: 5, hostile: true, damage: 3, stepHeight: 1.0 },
  drowned: { model: 'biped', width: 0.6, height: 1.95, health: 20, speed: 1.0, color: [70, 120, 120], face: 'zombie_head', drops: [['rotten_flesh', 0, 2]], xp: 5, hostile: true, damage: 3, stepHeight: 1.0, waterMob: true },
  skeleton: { model: 'biped', width: 0.6, height: 1.99, health: 20, speed: 1.1, color: [220, 220, 215], face: 'skeleton_skull', drops: [['bone', 0, 2], ['arrow', 0, 2]], xp: 5, hostile: true, damage: 2, ranged: 'arrow', burnsInDay: true, stepHeight: 1.0 },
  stray: { model: 'biped', width: 0.6, height: 1.99, health: 20, speed: 1.1, color: [200, 210, 225], face: 'skeleton_skull', drops: [['bone', 0, 2], ['arrow', 0, 2]], xp: 5, hostile: true, damage: 2, ranged: 'arrow', stepHeight: 1.0 },
  wither_skeleton: { model: 'biped', width: 0.7, height: 2.4, health: 20, speed: 1.1, color: [45, 45, 48], face: 'wither_skull', drops: [['coal', 0, 1], ['bone', 0, 2]], xp: 5, hostile: true, damage: 4, netherMob: true, stepHeight: 1.0 },
  creeper: { model: 'creeper', width: 0.6, height: 1.7, health: 20, speed: 1.0, color: [110, 190, 100], face: 'creeper_head', drops: [['gunpowder', 0, 2]], xp: 5, hostile: true, damage: 0, explosive: 3, stepHeight: 1.0 },
  spider: { model: 'spider', width: 1.4, height: 0.9, health: 16, speed: 1.5, color: [60, 45, 45], face: 'spider_face', drops: [['string', 0, 2], ['spider_eye', 0, 1]], xp: 5, hostile: true, damage: 3, climber: true, stepHeight: 1.0 },
  cave_spider: { model: 'spider', width: 0.7, height: 0.5, health: 12, speed: 1.5, color: [80, 60, 90], face: 'spider_face', drops: [['string', 0, 2]], xp: 5, hostile: true, damage: 2, poisonous: true, stepHeight: 1.0 },
  silverfish: { model: 'quadruped', width: 0.4, height: 0.3, health: 8, speed: 1.6, color: [150, 150, 160], face: null, drops: [], xp: 5, hostile: true, damage: 1, stepHeight: 1.0 },
  enderman: { model: 'biped', width: 0.6, height: 2.9, health: 40, speed: 1.3, color: [30, 25, 35], face: 'enderman_face', drops: [['ender_pearl', 0, 1]], xp: 5, hostile: true, damage: 7, neutral: true, tall: true, stepHeight: 1.0, teleport: true },
  piglin: { model: 'biped', width: 0.6, height: 1.95, health: 16, speed: 1.1, color: [200, 120, 110], face: 'piglin_face', drops: [['gold_nugget', 0, 1]], xp: 5, hostile: true, damage: 4, netherMob: true, neutral: true, stepHeight: 1.0 },
  blaze: { model: 'blaze', width: 0.6, height: 1.8, health: 20, speed: 1.0, color: [240, 200, 60], face: 'blaze_face', drops: [['blaze_rod', 0, 1]], xp: 10, hostile: true, damage: 4, ranged: 'fireball', flying: true, netherMob: true },
  ghast: { model: 'ghast', width: 4, height: 4, health: 10, speed: 0.6, color: [235, 230, 230], face: 'ghast_face', drops: [['ghast_tear', 0, 1]], xp: 5, hostile: true, damage: 6, ranged: 'fireball', flying: true, netherMob: true },
  magma_cube: { model: 'slime', width: 0.8, height: 0.8, health: 8, speed: 1.0, color: [200, 90, 40], face: 'magma_face', drops: [['magma_cream', 0, 1]], xp: 3, hostile: true, damage: 3, netherMob: true, sizeVar: 3 },
  slime: { model: 'slime', width: 0.8, height: 0.8, health: 8, speed: 1.0, color: [110, 190, 90], face: 'slime_face', drops: [['slime_ball', 0, 2]], xp: 3, hostile: true, damage: 2, sizeVar: 3 },
  squid: { model: 'squid', width: 0.8, height: 0.8, health: 10, speed: 0.8, color: [60, 70, 130], face: null, drops: [['ink_sac', 1, 3]], xp: 3, passive: true, waterMob: true, swimming: true },
  bat: { model: 'bird', width: 0.5, height: 0.9, health: 6, speed: 1.2, color: [80, 60, 50], face: 'bat_face', drops: [], xp: 1, passive: true, flying: true },
  phantom: { model: 'bird', width: 1.0, height: 0.6, health: 20, speed: 1.6, color: [70, 80, 110], face: 'phantom_face', drops: [['phantom_membrane', 0, 1]], xp: 5, hostile: true, damage: 4, flying: true },
  ender_dragon: { model: 'dragon', width: 8, height: 4, health: 200, speed: 3.0, color: [40, 25, 55], face: 'dragon_face', drops: [], xp: 12000, hostile: true, damage: 10, flying: true, boss: true },
};

export const PASSIVE_MOBS = Object.keys(MOB_DEFS).filter((k) => MOB_DEFS[k].passive);
export const HOSTILE_MOBS = Object.keys(MOB_DEFS).filter((k) => MOB_DEFS[k].hostile);

// ---------------------------------------------------------------------------
//  mob
// ---------------------------------------------------------------------------
export class Mob extends Entity {
  constructor(world, type, x, y, z) {
    const def = MOB_DEFS[type] || MOB_DEFS.pig;
    super(world, x, y, z, {
      type: 'mob', width: def.width, height: def.height, health: def.health,
      waterMob: def.waterMob, noAir: def.noAir,
    });
    this.mobType = type;
    this.def = def;
    this.name = type;
    this.stepHeight = def.stepHeight ?? 1.0;
    this.gravity = def.flying ? 0 : 32;
    this.speed = def.speed;
    this.hostile = !!def.hostile;
    this.neutral = !!def.neutral;
    this.state = 'idle';
    this.target = null;         // entity being chased / fled
    this.wanderTarget = null;
    this.wanderTimer = 0;
    this.attackCooldown = 0;
    this.loveTimer = 0;
    this.angryTimer = 0;
    this.panicTimer = 0;
    this.baby = false;
    this.babyAge = 0;
    this.walkPhase = Math.random() * 6.28;
    this.headYaw = 0;
    this.headPitch = 0;
    this.attackAnim = 0;
    this.jumpTimer = 0;
    this.lifeTime = 0;
    this.persistent = false;
    this.breedCooldown = 0;
    this.size = def.sizeVar ? 1 + Math.floor(Math.random() * def.sizeVar) : 1;
    this.width *= this.size > 1 ? this.size * 0.8 : 1;
    this.height *= this.size > 1 ? this.size * 0.8 : 1;
    this.tamed = false;
    this.owner = null;
    this.sheared = false;
    this.fuse = -1;
    this.rng = makeRng((x * 31 + z * 17 + (world.time | 0)) | 0);
    if (def.boss) { this.persistent = true; this.boss = true; }
  }

  get displayName() { return this.def.label || this.mobType.replace('_', ' '); }

  // -------------------------------------------------------------------------
  update(dt) {
    if (this.removed) return;
    this.lifeTime += dt;
    if (this.def.flying) {
      // flyers are not affected by gravity; keep them aloft
      this.vel[1] *= 0.92;
      if (this.pos[1] < this.targetY) this.vel[1] += 12 * dt;
    }
    this.ai(dt);
    super.update(dt);
    this.walkPhase += Math.hypot(this.vel[0], this.vel[2]) * dt * 6;
    if (this.attackCooldown > 0) this.attackCooldown -= dt;
    if (this.attackAnim > 0) this.attackAnim -= dt;
    if (this.loveTimer > 0) this.loveTimer -= dt;
    if (this.panicTimer > 0) this.panicTimer -= dt;
    if (this.breedCooldown > 0) this.breedCooldown -= dt;
    if (this.baby) { this.babyAge += dt; if (this.babyAge > 1200) { this.baby = false; } }
    if (this.fuse > 0) {
      this.fuse -= dt;
      if (this.fuse <= 0) this.explode();
    }
    // burning in daylight
    if (this.def.burnsInDay && !this.world.dimensionIsNether && this.isInDaylight()) {
      this.fireTicks = Math.max(this.fireTicks, 40);
    }
    // suffocation check
    if (this.age > 1 && this.world.isOpaque(Math.floor(this.pos[0]), Math.floor(this.pos[1] + this.height * 0.5), Math.floor(this.pos[2]))) {
      this.hurt(1, 'suffocate');
    }
    // despawn
    if (!this.persistent && this.lifeTime > 30 && this.nearestPlayerDist() > 96) {
      if (Math.random() < dt * 0.02) this.remove();
    }
  }

  isInDaylight() {
    const w = this.world;
    if (w.dimension === 'nether') return false;
    const x = Math.floor(this.pos[0]), z = Math.floor(this.pos[2]);
    const top = w.topY(x, z);
    if (top === null || this.pos[1] + this.height < top - 1) return false;
    const t = w.dayTime % 24000;
    return t > 1000 && t < 11500;
  }

  nearestPlayerDist() {
    let best = Infinity;
    for (const p of this.world.players || []) best = Math.min(best, this.distanceTo(p));
    return best;
  }

  nearestPlayer(range = 16) {
    let best = null, bd = range;
    for (const p of this.world.players || []) {
      if (p.dead || p.gamemode === 'spectator') continue;
      const d = this.distanceTo(p);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  ai(dt) {
    const def = this.def;
    this.jumpTimer -= dt;
    // panic overrides everything
    if (this.panicTimer > 0) { this.flee(this.lastAttacker || this.nearestPlayer(24), dt); return; }
    if (this.loveTimer > 0) { this.findMate(dt); return; }

    if (this.hostile || (this.neutral && this.angryTimer > 0)) {
      const p = this.target && !this.target.dead ? this.target : this.nearestPlayer(this.neutral ? 24 : 20);
      if (this.neutral && !this.target) {
        // neutral mobs only aggro when attacked or looked at (enderman)
      } else this.target = p;
      if (this.target) {
        const d = this.distanceTo(this.target);
        if (this.def.ranged && d > 4 && d < 24) {
          this.moveTo(this.target.pos, dt, this.speed * 0.7);
          this.rangedAttack(this.target, dt);
        } else if (d < 2.6 && this.attackCooldown <= 0) {
          this.meleeAttack(this.target);
        } else if (d < 32) {
          this.moveTo(this.target.pos, dt, this.speed * (this.hostile ? 1.25 : 1.0));
        }
        if (this.def.explosive && d < 3.2 && this.fuse < 0) this.fuse = 1.5;
        else if (this.def.explosive && d > 6 && this.fuse > 0) this.fuse = -1;
        return;
      }
    }
    if (this.def.protective) {
      // iron golem attacks nearby hostiles
      let best = null, bd = 12;
      for (const e of this.world.entities || []) {
        if (e === this || e.dead || !e.hostile) continue;
        const d = this.distanceTo(e);
        if (d < bd) { bd = d; best = e; }
      }
      if (best) {
        if (bd < 2.8 && this.attackCooldown <= 0) this.meleeAttack(best);
        else this.moveTo(best.pos, dt, this.speed * 1.2);
        return;
      }
    }
    // tamed wolves follow & defend
    if (this.tamed && this.owner) {
      const d = this.distanceTo(this.owner);
      if (d > 6) { this.moveTo(this.owner.pos, dt, this.speed * 1.3); return; }
    }
    // follow a player holding a tempting item
    if (def.follow) {
      const p = this.nearestPlayer(12);
      if (p && this.holdsTemptation(p)) {
        this.moveTo(p.pos, dt, this.speed * 0.9);
        this.lookAt(p.pos[0], p.pos[1], p.pos[2]);
        return;
      }
    }
    this.wander(dt);
  }

  holdsTemptation(player) {
    const want = this.def.follow;
    const held = player.inventory ? player.inventory.getHeld() : null;
    return held && held.name === want;
  }

  wander(dt) {
    this.wanderTimer -= dt;
    if (this.wanderTimer <= 0 || !this.wanderTarget) {
      this.wanderTimer = 2 + this.rng() * 5;
      const a = this.rng() * Math.PI * 2;
      const r = 3 + this.rng() * 8;
      this.wanderTarget = [this.pos[0] + Math.cos(a) * r, this.pos[1], this.pos[2] + Math.sin(a) * r];
    }
    if (this.rng() < dt * 0.15) {
      this.moveTo(this.wanderTarget, dt, this.speed * 0.45);
    } else {
      this.vel[0] *= 0.85; this.vel[2] *= 0.85;
    }
  }

  flee(from, dt) {
    if (!from) { this.wander(dt); return; }
    const dx = this.pos[0] - from.pos[0], dz = this.pos[2] - from.pos[2];
    const l = Math.hypot(dx, dz) || 1;
    this.moveTowards(dx / l, dz / l, dt, this.speed * 1.6);
  }

  findMate(dt) {
    let best = null, bd = 12;
    for (const e of this.world.entities || []) {
      if (e === this || e.removed || e.mobType !== this.mobType || e.loveTimer <= 0) continue;
      const d = this.distanceTo(e);
      if (d < bd) { bd = d; best = e; }
    }
    if (best) {
      if (bd < 1.6) {
        if (this.breedCooldown <= 0 && best.breedCooldown <= 0) {
          this.breedCooldown = 60; best.breedCooldown = 60;
          this.loveTimer = 0; best.loveTimer = 0;
          if (this.onBreed) this.onBreed(this, best);
        }
      } else this.moveTo(best.pos, dt, this.speed);
    } else this.wander(dt);
  }

  /** Steer towards a point with simple obstacle handling. */
  moveTo(target, dt, speed) {
    const dx = target[0] - this.pos[0], dz = target[2] - this.pos[2];
    const l = Math.hypot(dx, dz);
    if (l < 0.6) { this.vel[0] *= 0.7; this.vel[2] *= 0.7; return; }
    this.moveTowards(dx / l, dz / l, dt, speed);
    this.headYaw = Math.atan2(-dx, -dz);
  }

  moveTowards(dirX, dirZ, dt, speed) {
    const s = speed * (this.baby ? 1.3 : 1) * (this.inWater ? 0.6 : 1);
    this.vel[0] += (dirX * s - this.vel[0]) * Math.min(1, dt * 8);
    this.vel[2] += (dirZ * s - this.vel[2]) * Math.min(1, dt * 8);
    this.yaw = Math.atan2(-dirX, -dirZ);
    // hop over obstacles
    if ((this.onGround || this.inWater) && (this.onWall || this.blockedAhead(dirX, dirZ)) && this.jumpTimer <= 0) {
      if (this.inWater) this.vel[1] = 4.5;
      else this.vel[1] = 8.4;
      this.jumpTimer = 0.45;
    }
    if (this.def.flying) {
      const ty = (this.targetY || (this.target ? this.target.pos[1] + 3 : this.pos[1] + 2));
      this.vel[1] += ((ty > this.pos[1] ? 4 : -2) - this.vel[1]) * dt * 2;
    }
  }

  blockedAhead(dx, dz) {
    const x = this.pos[0] + dx * (this.width / 2 + 0.3);
    const z = this.pos[2] + dz * (this.width / 2 + 0.3);
    const y = this.pos[1] + 0.1;
    return this.world.isSolid(Math.floor(x), Math.floor(y), Math.floor(z));
  }

  meleeAttack(target) {
    this.attackCooldown = 1.0;
    this.attackAnim = 0.35;
    const dmg = (this.def.damage || 2) * (this.baby ? 0.5 : 1);
    if (target.hurt(dmg, 'mob', this)) {
      if (this.def.poisonous && target.addEffect) target.addEffect('poison', 140, 0);
    }
    if (this.onAttack) this.onAttack(this, target);
  }

  rangedAttack(target, dt) {
    this.attackCooldown -= dt;
    if (this.attackCooldown > 0) return;
    this.attackCooldown = this.def.ranged === 'arrow' ? 1.6 : 2.5;
    this.attackAnim = 0.3;
    if (this.onRangedAttack) this.onRangedAttack(this, target);
  }

  explode() {
    const r = this.def.explosive || 3;
    if (this.onExplode) this.onExplode(this, r);
    this.remove();
  }

  hurt(amount, source, from) {
    const res = super.hurt(amount, source, from);
    if (res && amount > 0) {
      this.panicTimer = this.hostile ? 0 : 5;
      this.lastAttacker = from;
      if (this.neutral) { this.angryTimer = 30; this.target = from; }
      if (this.tamed && this.owner && from !== this.owner) this.target = from;
      if (this.def.hostileWhenAttacked) { this.target = from; this.angryTimer = 20; }
    }
    return res;
  }

  die(source, from) {
    super.die(source, from);
    if (this.onMobDeath) this.onMobDeath(this, source, from);
  }

  // -------------------------------------------------------------------------
  /** Build the animated cuboid list for the entity renderer. */
  buildParts(renderer, dt) {
    const def = this.def;
    const parts = [];
    const scale = this.baby ? 0.55 : 1;
    const light = this.world.getLight(Math.floor(this.pos[0]), Math.floor(this.pos[1] + 1), Math.floor(this.pos[2]));
    const bl = (light >> 4) & 15, sl = light & 15;
    const walk = Math.sin(this.walkPhase * 2) * Math.min(1, Math.hypot(this.vel[0], this.vel[2]) / 2);
    const idle = Math.sin(this.age * 1.6) * 0.03;
    const col = def.color;
    const shade = (f) => [Math.min(255, col[0] * f) | 0, Math.min(255, col[1] * f) | 0, Math.min(255, col[2] * f) | 0, 255];
    const faceTex = def.face ? renderer.textures.blockMap.get(def.face) : null;
    const pos = this.pos;
    const yaw = this.bodyYaw || this.yaw;
    const P = (px, py, pz, size, color, opt = {}) => parts.push(Object.assign({
      pos: [pos[0] + px, pos[1] + py, pos[2] + pz], size, rot: [yaw, 0, 0], pivot: [0, 0, 0],
      color, light: [bl, sl], tex: null,
    }, opt));

    switch (def.model) {
      case 'quadruped':
      case 'quadruped_wool': {
        const bodyH = 0.55 * scale, bodyW = 0.62 * scale, bodyL = 0.9 * scale;
        const legH = (this.height * 0.45) * scale;
        P(0, legH, 0, [bodyW, bodyH, bodyL], shade(1));
        // head
        const hy = legH + bodyH * 0.9;
        P(0, hy, -bodyL / 2 - 0.12 * scale, [0.45 * scale, 0.45 * scale, 0.42 * scale], shade(1.05), {
          rot: [yaw + this.headYaw * 0.5, this.headPitch, 0], pivot: [0, 0, 0.2 * scale],
        });
        if (faceTex) {
          const fx = Math.sin(yaw + this.headYaw * 0.5), fz = Math.cos(yaw + this.headYaw * 0.5);
          P(fx * 0.24 * scale, hy + 0.05 * scale, -bodyL / 2 - 0.12 * scale - fz * 0.24 * scale,
            [0.34 * scale, 0.32 * scale, 0.02], [255, 255, 255, 255],
            { rot: [yaw + this.headYaw * 0.5, 0, 0], tex: faceTex });
        }
        // legs
        const lp = [[0.22, 0.3], [-0.22, 0.3], [0.22, -0.3], [-0.22, -0.3]];
        for (let i = 0; i < 4; i++) {
          const [ox, oz] = lp[i];
          const ph = (i === 0 || i === 3) ? walk : -walk;
          P(ox * scale, legH, oz * scale, [0.2 * scale, legH, 0.2 * scale], shade(0.8), {
            rot: [yaw, ph, 0], pivot: [0, legH, 0],
          });
        }
        break;
      }
      case 'bird': {
        const bodyH = this.height * 0.55, legH = this.height * 0.3;
        P(0, legH, 0, [0.4 * scale, bodyH * scale, 0.5 * scale], shade(1));
        const hy = legH + bodyH * 0.85;
        P(0, hy, -0.2 * scale, [0.28 * scale, 0.3 * scale, 0.28 * scale], shade(1.1), { rot: [yaw + this.headYaw * 0.6, this.headPitch, 0] });
        if (faceTex) {
          const fx = Math.sin(yaw), fz = Math.cos(yaw);
          P(fx * 0.16 * scale, hy, -0.2 * scale - fz * 0.16 * scale, [0.22 * scale, 0.22 * scale, 0.02], [255, 255, 255, 255], { rot: [yaw, 0, 0], tex: faceTex });
        }
        // wings
        for (const s2 of [1, -1]) {
          P(s2 * 0.24 * scale, legH + bodyH * 0.55, 0, [0.06, bodyH * 0.8 * scale, 0.45 * scale], shade(0.9), {
            rot: [yaw, 0, s2 * (0.2 + (this.def.flying ? Math.sin(this.age * 12) * 0.7 : 0))], pivot: [0, bodyH * 0.4, 0],
          });
        }
        for (const s2 of [1, -1]) {
          P(s2 * 0.1 * scale, legH, 0, [0.08, legH, 0.08], [230, 190, 90], { rot: [yaw, walk * s2, 0], pivot: [0, legH, 0] });
        }
        break;
      }
      case 'biped': {
        const legH = this.height * 0.42, bodyH = this.height * 0.34, headS = 0.5 * scale;
        const armW = 0.16 * scale;
        // legs
        for (const s2 of [1, -1]) {
          P(s2 * 0.14 * scale, legH, 0, [0.24 * scale, legH, 0.24 * scale], shade(0.7), { rot: [yaw, walk * s2 * 0.9, 0], pivot: [0, legH, 0] });
        }
        P(0, legH, 0, [0.5 * scale, bodyH, 0.28 * scale], shade(1));
        // arms
        const swing = this.attackAnim > 0 ? -1.4 : walk * 0.8;
        for (const s2 of [1, -1]) {
          P(s2 * (0.32 * scale), legH + bodyH * 0.9, 0, [armW, bodyH * 0.95, armW], shade(0.95), { rot: [yaw, swing * s2, 0], pivot: [0, bodyH * 0.95, 0] });
        }
        // head
        const hy = legH + bodyH + 0.02;
        P(0, hy, 0, [headS, headS, headS], shade(1.05), { rot: [yaw + this.headYaw * 0.4, this.headPitch, 0], pivot: [0, headS * 0.45, 0] });
        if (faceTex) {
          const fx = Math.sin(yaw + this.headYaw * 0.4), fz = Math.cos(yaw + this.headYaw * 0.4);
          P(fx * (headS * 0.52), hy + headS * 0.1, fz * (headS * 0.52), [headS * 0.8, headS * 0.8, 0.02], [255, 255, 255, 255], { rot: [yaw + this.headYaw * 0.4, 0, 0], tex: faceTex });
        }
        break;
      }
      case 'creeper': {
        const legH = this.height * 0.42, bodyH = this.height * 0.4;
        for (let i = 0; i < 4; i++) {
          const ox = (i % 2 ? 1 : -1) * 0.2 * scale, oz = (i < 2 ? 1 : -1) * 0.16 * scale;
          P(ox, legH, oz, [0.22 * scale, legH, 0.22 * scale], shade(0.75), { rot: [yaw, (i % 2 ? walk : -walk) * 0.8, 0], pivot: [0, legH, 0] });
        }
        P(0, legH, 0, [0.6 * scale, bodyH, 0.34 * scale], shade(1));
        const hy = legH + bodyH;
        P(0, hy, 0, [0.5 * scale, 0.5 * scale, 0.5 * scale], shade(1.08), { rot: [yaw + this.headYaw * 0.4, this.headPitch, 0], pivot: [0, 0.25 * scale, 0] });
        if (faceTex) {
          const fx = Math.sin(yaw), fz = Math.cos(yaw);
          P(fx * 0.26 * scale, hy + 0.08, fz * 0.26 * scale, [0.42 * scale, 0.4 * scale, 0.02], [255, 255, 255, 255], { rot: [yaw, 0, 0], tex: faceTex });
        }
        break;
      }
      case 'spider': {
        const bodyH = 0.4 * scale, bodyL = 0.7 * scale;
        const y = this.height * 0.55;
        P(0, y, 0.1 * scale, [0.7 * scale, bodyH, bodyL], shade(1));
        P(0, y + 0.02, -bodyL * 0.6, [0.5 * scale, 0.42 * scale, 0.5 * scale], shade(1.1), { rot: [yaw + this.headYaw * 0.5, this.headPitch, 0] });
        if (faceTex) {
          const fx = Math.sin(yaw), fz = Math.cos(yaw);
          P(fx * 0.26 * scale, y + 0.06, -bodyL * 0.6 - fz * 0.26 * scale, [0.4 * scale, 0.36 * scale, 0.02], [255, 255, 255, 255], { rot: [yaw, 0, 0], tex: faceTex });
        }
        for (let i = 0; i < 8; i++) {
          const side = i < 4 ? 1 : -1;
          const k = i % 4;
          const ang = (-0.5 + k * 0.35) * side;
          const swingA = Math.sin(this.walkPhase * 2 + i) * 0.4;
          P(side * 0.35 * scale, y - 0.05, (k - 1.5) * 0.22 * scale, [0.9 * scale, 0.08, 0.08], shade(0.7), {
            rot: [yaw + ang + swingA * 0.2, 0, 0.5 + swingA], pivot: [0, 0, 0],
          });
        }
        break;
      }
      case 'slime': {
        const s2 = this.size;
        const sq = 0.6 + Math.sin(this.walkPhase * 2) * 0.08;
        P(0, 0, 0, [0.9 * s2 * scale * sq, 0.85 * s2 * scale / sq, 0.9 * s2 * scale * sq], [col[0], col[1], col[2], 210]);
        if (faceTex) {
          const fx = Math.sin(yaw), fz = Math.cos(yaw);
          P(fx * 0.48 * s2, 0.3 * s2, fz * 0.48 * s2, [0.5 * s2, 0.4 * s2, 0.02], [255, 255, 255, 255], { rot: [yaw, 0, 0], tex: faceTex });
        }
        break;
      }
      case 'golem': {
        const legH = 1.0, bodyH = 1.1;
        for (const s2 of [1, -1]) P(s2 * 0.3, legH, 0, [0.34, legH, 0.34], shade(0.8), { rot: [yaw, walk * s2 * 0.5, 0], pivot: [0, legH, 0] });
        P(0, legH, 0, [0.9, bodyH, 0.5], shade(1));
        const swing = this.attackAnim > 0 ? -1.6 : walk * 0.4;
        for (const s2 of [1, -1]) P(s2 * 0.62, legH + bodyH * 0.8, 0, [0.32, 1.0, 0.32], shade(0.95), { rot: [yaw, swing * s2, 0], pivot: [0, 1.0, 0] });
        const hy = legH + bodyH;
        P(0, hy, 0, [0.5, 0.5, 0.5], shade(1.05), { rot: [yaw + this.headYaw * 0.4, this.headPitch, 0], pivot: [0, 0.25, 0] });
        if (faceTex) {
          const fx = Math.sin(yaw), fz = Math.cos(yaw);
          P(fx * 0.27, hy + 0.06, fz * 0.27, [0.4, 0.36, 0.02], [255, 255, 255, 255], { rot: [yaw, 0, 0], tex: faceTex });
        }
        break;
      }
      case 'blaze': {
        for (let i = 0; i < 3; i++) {
          const a = this.age * 4 + i * 2.1;
          for (let j = 0; j < 3; j++) {
            const r = 0.45 + Math.sin(a + j) * 0.1;
            P(Math.cos(a + j * 2.1) * r, 0.6 + i * 0.42 + Math.sin(a * 1.4 + j) * 0.12, Math.sin(a + j * 2.1) * r,
              [0.22, 0.22, 0.22], [255, 230, 120, 255]);
          }
        }
        P(0, 0.5, 0, [0.5, 0.7, 0.5], [255, 210, 80, 255]);
        if (faceTex) {
          const fx = Math.sin(yaw), fz = Math.cos(yaw);
          P(fx * 0.27, 0.62, fz * 0.27, [0.42, 0.4, 0.02], [255, 255, 255, 255], { rot: [yaw, 0, 0], tex: faceTex });
        }
        break;
      }
      case 'ghast': {
        const s2 = 2.0;
        P(0, 1.0, 0, [s2 * 2, s2 * 1.6, s2 * 2], [col[0], col[1], col[2], 235]);
        if (faceTex) {
          const fx = Math.sin(yaw), fz = Math.cos(yaw);
          P(fx * s2 * 1.02, 1.2, fz * s2 * 1.02, [1.4, 1.1, 0.05], [255, 255, 255, 255], { rot: [yaw, 0, 0], tex: faceTex });
        }
        for (let i = 0; i < 9; i++) {
          const a = i * 0.7;
          P(Math.cos(a) * 1.2, -0.4 - Math.sin(this.age * 2 + i) * 0.4, Math.sin(a) * 1.2, [0.16, 1.2, 0.16], [225, 220, 220, 220]);
        }
        break;
      }
      case 'squid': {
        P(0, 0.2, 0, [0.7, 0.8, 0.9], shade(1));
        for (let i = 0; i < 8; i++) {
          const a = i * 0.785;
          P(Math.cos(a) * 0.35, -0.3, Math.sin(a) * 0.35, [0.12, 0.6 + Math.sin(this.age * 6 + i) * 0.15, 0.12], shade(0.85));
        }
        break;
      }
      case 'dragon': {
        P(0, 1.4, 0, [2.2, 1.8, 3.4], shade(1));
        P(0, 1.9, -2.2, [1.2, 1.0, 1.6], shade(1.1), { rot: [yaw + this.headYaw, this.headPitch, 0], pivot: [0, 0, 1.4] });
        for (const s2 of [1, -1]) {
          const flap = Math.sin(this.age * 3) * 0.5;
          P(s2 * 2.6, 2.0, 0, [5.0, 0.15, 2.4], shade(0.85), { rot: [yaw, 0, s2 * flap], pivot: [0, 0, 0] });
        }
        P(0, 1.2, 2.4, [0.5, 0.5, 3.0], shade(0.9), { rot: [yaw, Math.sin(this.age * 2) * 0.2, 0], pivot: [0, 0, -1.4] });
        break;
      }
      default:
        P(0, 0, 0, [this.width, this.height, this.width], shade(1));
    }
    return parts;
  }
}

export default Mob;
