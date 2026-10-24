/**
 * Ultracraft - dropped items, xp orbs and projectiles.
 *
 * All three are plain `Entity` subclasses with a shared "pickup" behaviour so
 * the game loop only has to care about one list.
 */

import { Entity } from './entity.js';
import { ItemStack } from '../game/inventory.js';
import { getBlock, AIR } from '../world/blocks.js';
import { getItem, itemId } from '../world/items.js';
import { lerp } from '../core/math.js';

/** A dropped item stack lying on the ground. */
export class ItemEntity extends Entity {
  constructor(world, x, y, z, stack, vel = null) {
    super(world, x, y, z, { type: 'item', width: 0.28, height: 0.28, health: 5 });
    this.stack = stack;
    this.pickupDelay = 20;
    this.age = 0;
    this.life = 0;
    this.bob = Math.random() * Math.PI * 2;
    this.gravity = 26;
    this.friction = 0.86;
    this.fallDistance = 0;
    this.noClip = false;
    if (vel) { this.vel[0] = vel[0]; this.vel[1] = vel[1] || 2; this.vel[2] = vel[2]; }
  }

  update(dt) {
    if (this.removed) return;
    this.age += dt;
    this.life += dt;
    if (this.pickupDelay > 0) this.pickupDelay -= dt * 20;
    this.bob += dt * 2.4;
    super.update(dt);
    // merge with nearby identical drops
    if ((this.mergeTick = (this.mergeTick || 0) + dt) > 0.5) {
      this.mergeTick = 0;
      const list = this.world.entities || this.world.itemEntities || [];
      for (const e of list) {
        if (e === this || e.removed || e.type !== 'item') continue;
        if (Math.abs(e.pos[0] - this.pos[0]) > 0.7 || Math.abs(e.pos[1] - this.pos[1]) > 0.7 || Math.abs(e.pos[2] - this.pos[2]) > 0.7) continue;
        if (!e.stack.canStack(this.stack)) continue;
        const space = e.stack.maxStack - e.stack.count;
        if (space <= 0) continue;
        const move = Math.min(space, this.stack.count);
        e.stack.count += move;
        this.stack.count -= move;
        if (this.stack.count <= 0) { this.remove(); break; }
      }
    }
    // burn in lava / fire, float in water
    if (this.inLava) { this.hurt(4, 'lava'); }
    if (this.age > 6000) this.remove();   // 5 minute despawn
  }

  /** Try to give this stack to a player. Returns true when consumed. */
  tryPickup(player) {
    if (this.pickupDelay > 0 || this.removed) return false;
    const left = player.inventory.add(this.stack);
    if (left === this.stack.count) return false;
    this.stack.count = left;
    if (this.stack.count <= 0) { this.remove(); return true; }
    return true;
  }

  serialize() {
    return Object.assign(super.serialize(), { stack: this.stack.serialize(), age: this.age });
  }
}

/** XP orb. */
export class XpOrb extends Entity {
  constructor(world, x, y, z, amount) {
    super(world, x, y, z, { type: 'xp', width: 0.25, height: 0.25, health: 5 });
    this.amount = amount;
    this.gravity = 20;
    this.friction = 0.9;
    this.age = 0;
    this.spin = 0;
  }
  update(dt) {
    this.age += dt;
    this.spin += dt * 3;
    if (this.age > 1) {
      const p = this.world.nearestPlayer ? this.world.nearestPlayer(this.pos) : null;
      if (p && !p.dead) {
        const d = Math.hypot(p.pos[0] - this.pos[0], p.pos[1] + 0.8 - this.pos[1], p.pos[2] - this.pos[2]);
        if (d < 8) {
          const s = 12 / Math.max(1, d);
          this.vel[0] += (p.pos[0] - this.pos[0]) * s * dt;
          this.vel[1] += (p.pos[1] + 0.8 - this.pos[1]) * s * dt;
          this.vel[2] += (p.pos[2] - this.pos[2]) * s * dt;
        }
        if (d < 1.2) {
          p.addXp(this.amount);
          if (this.world.game && this.world.game.audio) this.world.game.audio.play('xp', this.pos[0], this.pos[1], this.pos[2]);
          this.remove();
          return;
        }
      }
    }
    super.update(dt);
    if (this.age > 600) this.remove();
  }
}

/** Arrow / snowball / egg / fireball / trident. */
export class Projectile extends Entity {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, { type: 'projectile', width: 0.3, height: 0.3, health: 1 });
    this.kind = opts.kind || 'arrow';
    this.damage = opts.damage || 4;
    this.owner = opts.owner || null;
    this.gravity = opts.gravity === undefined ? 10 : opts.gravity;
    this.friction = 0.99;
    this.life = 0;
    this.bounce = opts.bounce || false;
    this.punch = opts.punch || 0;
    this.fire = opts.fire || 0;
    this.stack = opts.stack || null;
    this.stuck = false;
    this.critical = opts.critical || false;
    this.prevPos = new Float32Array([x, y, z]);
    const dir = opts.dir || [0, 0, 1];
    const speed = opts.speed || 30;
    this.vel[0] = dir[0] * speed; this.vel[1] = dir[1] * speed; this.vel[2] = dir[2] * speed;
    this.spread = opts.spread || 0;
    if (this.spread) {
      this.vel[0] += (Math.random() - 0.5) * this.spread;
      this.vel[1] += (Math.random() - 0.5) * this.spread;
      this.vel[2] += (Math.random() - 0.5) * this.spread;
    }
  }

  update(dt) {
    if (this.removed) return;
    this.life += dt;
    if (this.stuck) {
      this.vel.fill(0);
      if (this.life > 60) this.remove();
      return;
    }
    this.prevPos[0] = this.pos[0]; this.prevPos[1] = this.pos[1]; this.prevPos[2] = this.pos[2];
    this.yaw = Math.atan2(-this.vel[0], -this.vel[2]);
    this.pitch = Math.atan2(-this.vel[1], Math.hypot(this.vel[0], this.vel[2]));
    // hit entities along the swept segment
    const hit = this.world.sweepEntities(this.prevPos, this.pos, 0.35, this);
    if (hit) { this.onHitEntity(hit); return; }
    super.update(dt);
    if (this.inWater) { this.vel[0] *= 0.8; this.vel[1] *= 0.8; this.vel[2] *= 0.8; }
    if (this.onGround || this.onWall) {
      if (this.kind === 'arrow') { this.stuck = true; if (this.fire) this.world.setBlock(Math.floor(this.pos[0]), Math.floor(this.pos[1]), Math.floor(this.pos[2]), this.world.blockIds.fire || AIR, 0); }
      else if (this.kind === 'snowball' || this.kind === 'egg') this.onImpact();
      else this.onImpact();
    }
    if (this.life > 60) this.remove();
  }

  onHitEntity(e) {
    if (e === this.owner) return;
    let dmg = this.damage;
    if (this.critical) dmg *= 1.5;
    if (this.owner && this.owner.type === 'player') {
      dmg = this.owner.getAttackDamage(e) * 0.6 + this.damage * 0.2;
    }
    e.hurt(dmg, 'projectile', this.owner);
    if (this.punch) {
      const dx = this.vel[0], dz = this.vel[2];
      const l = Math.hypot(dx, dz) || 1;
      e.knockback(dx / l * this.punch * 0.4, 0.4, dz / l * this.punch * 0.4);
    }
    if (this.fire) e.setFire(100);
    if (this.kind === 'snowball') e.addEffect && e.addEffect('slowness', 100, 0);
    this.onImpact();
  }

  onImpact() {
    if (this.removed) return;
    if (this.kind === 'egg' && Math.random() < 0.125) {
      // spawn a chick
      if (this.world.game && this.world.game.spawnMob) this.world.game.spawnMob('chicken', this.pos[0], this.pos[1], this.pos[2]);
    }
    if (this.kind === 'fireball' || this.kind === 'tnt') {
      if (this.world.explode) this.world.explode(this.pos[0], this.pos[1], this.pos[2], this.kind === 'tnt' ? 4 : 3, true);
    }
    if (this.stack && this.world.game) this.world.game.dropItem(this.pos[0], this.pos[1], this.pos[2], new ItemStack(this.stack, 1));
    this.remove();
  }
}

/** Falling block entity (sand, gravel, anvils, dragon egg). */
export class FallingBlock extends Entity {
  constructor(world, x, y, z, blockId, meta) {
    super(world, x, y, z, { type: 'falling', width: 0.98, height: 0.98, health: 1 });
    this.blockId = blockId;
    this.meta = meta || 0;
    this.gravity = 24;
    this.friction = 0.98;
    this.age = 0;
  }
  update(dt) {
    this.age += dt;
    super.update(dt);
    if (this.onGround || this.age > 60) {
      const x = Math.round(this.pos[0] - 0.5), y = Math.round(this.pos[1] - 0.5), z = Math.round(this.pos[2] - 0.5);
      const cur = this.world.getBlock(x, y, z);
      if (cur === AIR || getBlock(cur).replaceable) this.world.setBlock(x, y, z, this.blockId, this.meta);
      else if (this.world.game) this.world.game.dropItem(x + 0.5, y + 0.5, z + 0.5, new ItemStack(this.blockId, 1));
      this.remove();
    }
  }
}

/** TNT entity. */
export class PrimedTnt extends Entity {
  constructor(world, x, y, z, fuse = 80) {
    super(world, x, y, z, { type: 'tnt', width: 0.98, height: 0.98, health: 1 });
    this.fuse = fuse;
    this.gravity = 22;
    this.friction = 0.98;
  }
  update(dt) {
    this.fuse -= dt * 20;
    super.update(dt);
    if (this.fuse <= 0) {
      if (this.world.explode) this.world.explode(this.pos[0], this.pos[1] + 0.5, this.pos[2], 4, true);
      this.remove();
    }
  }
}

export default ItemEntity;
