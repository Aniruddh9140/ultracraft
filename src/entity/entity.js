/**
 * Ultracraft - entity base class with voxel AABB physics.
 *
 * Movement is resolved one axis at a time against the block grid (fast, stable
 * and exactly what a voxel game needs), with automatic step-up, liquid
 * buoyancy, knockback, fire and fall damage.
 */

import { getBlock, AIR, BLOCK } from '../world/blocks.js';
import { clamp } from '../core/math.js';

let nextEntityId = 1;

export class Entity {
  constructor(world, x, y, z, def = {}) {
    this.id = nextEntityId++;
    this.world = world;
    this.type = def.type || 'entity';
    this.name = def.name || this.type;
    this.pos = new Float32Array([x, y, z]);
    this.prevPos = new Float32Array([x, y, z]);
    this.vel = new Float32Array(3);
    this.yaw = 0;
    this.pitch = 0;
    this.bodyYaw = 0;
    this.width = def.width ?? 0.6;
    this.height = def.height ?? 1.8;
    this.eyeHeight = def.eyeHeight ?? this.height * 0.85;
    this.health = def.health ?? 20;
    this.maxHealth = def.maxHealth ?? this.health;
    this.maxAir = def.maxAir ?? 300;         // 15 s of air, in ticks
    this.air = this.maxAir;
    this.waterMob = !!def.waterMob;          // fish, drowned, ... never drown
    this.noAir = !!def.noAir;                // undead, golems, ... never drown
    this.onGround = false;
    this.inWater = false;
    this.inLava = false;
    this.submerged = false;
    this.dead = false;
    this.removed = false;
    this.age = 0;
    this.hurtTime = 0;
    this.deathTime = 0;
    this.fireTicks = 0;
    this.fallDistance = 0;
    this.stepHeight = def.stepHeight ?? 0.6;
    this.gravity = def.gravity ?? 32;
    this.drag = def.drag ?? 0.98;
    this.knockbackResist = def.knockbackResist ?? 0;
    this.gravity2 = 0;
    this.noClip = false;
    this.burning = false;
    this.portalTimer = 0;
    this.portalCooldown = 0;
    this.riderEntity = null;
    this.vehicle = null;
    this.nbt = {};
    this.lastDamageSource = null;
  }

  get eyeY() { return this.pos[1] + this.eyeHeight; }

  /**
   * Axis-aligned box as [minX, minY, minZ, maxX, maxY, maxZ].
   *
   * `out` is optional on purpose: half the callers (hit-testing, entity
   * picking, the F3 overlay) just want the box for one expression, and
   * allocating there would put a garbage-collection pause into every swing of
   * the fist. They get a per-entity scratch array instead; callers that need
   * to keep the box around pass their own.
   */
  aabb(out) {
    const o = out || (this._aabb || (this._aabb = new Float32Array(6)));
    const w = this.width / 2;
    o[0] = this.pos[0] - w; o[1] = this.pos[1]; o[2] = this.pos[2] - w;
    o[3] = this.pos[0] + w; o[4] = this.pos[1] + this.height; o[5] = this.pos[2] + w;
    return o;
  }

  // -------------------------------------------------------------------------
  update(dt) {
    if (this.removed) return;
    this.age += dt;
    this.prevPos.set(this.pos);
    if (this.hurtTime > 0) this.hurtTime -= dt;
    if (this.portalCooldown > 0) this.portalCooldown -= dt;

    this.updateLiquids();
    this.applyPhysics(dt);
    this.updateFire(dt);
    this.updateAir(dt);
    if (this.dead) {
      this.deathTime += dt;
      if (this.deathTime > 1.2) this.remove();
    }
  }

  /** Air supply: submerged creatures (that are not fish) drown. */
  updateAir(dt) {
    if (this.dead || this.removed) return;
    if (this.waterMob || this.noAir) { this.air = this.maxAir; return; }
    if (this.air === undefined) this.air = this.maxAir;
    if (this.submerged) {
      this.air -= dt * 20;
      if (this.air <= 0) {
        this.air = 0;
        this.drownTimer = (this.drownTimer || 0) + dt;
        if (this.drownTimer >= 1) { this.drownTimer = 0; this.hurt(2, 'drown'); }
      }
    } else {
      this.drownTimer = 0;
      if (this.air < this.maxAir) this.air = Math.min(this.maxAir, this.air + dt * 60);
    }
  }

  updateLiquids() {
    const w = this.world;
    const feet = w.getBlock(Math.floor(this.pos[0]), Math.floor(this.pos[1] + 0.1), Math.floor(this.pos[2]));
    const head = w.getBlock(Math.floor(this.pos[0]), Math.floor(this.pos[1] + this.eyeHeight), Math.floor(this.pos[2]));
    this.inWater = feet !== AIR && getBlock(feet).flow > 0 && !getBlock(feet).damage;
    this.inLava = feet !== AIR && getBlock(feet).flow > 0 && getBlock(feet).damage > 0;
    this.submerged = head !== AIR && getBlock(head).flow > 0;
    if (this.inLava) { this.fireTicks = Math.max(this.fireTicks, 300); this.hurt(4, 'lava'); }
  }

  applyPhysics(dt) {
    if (this.noClip) {
      this.pos[0] += this.vel[0] * dt;
      this.pos[1] += this.vel[1] * dt;
      this.pos[2] += this.vel[2] * dt;
      return;
    }
    const w = this.world;
    const inLiquid = this.inWater || this.inLava;
    // gravity / buoyancy
    if (inLiquid) {
      this.vel[1] -= this.gravity * 0.28 * dt;
      this.vel[1] *= 0.82;
      this.vel[0] *= 0.86; this.vel[2] *= 0.86;
      if (this.swimUp) this.vel[1] += this.gravity * 0.55 * dt;
    } else {
      this.vel[1] -= this.gravity * dt;
      if (this.vel[1] < -78) this.vel[1] = -78;
    }
    // drag
    const d = Math.pow(this.drag, dt * 60);
    this.vel[0] *= d; this.vel[2] *= d;

    const wasOnGround = this.onGround;
    this.moveWithCollision(dt);

    // fall damage + landing
    if (this.onGround) {
      if (!wasOnGround && this.fallDistance > 3) {
        const dmg = Math.floor(this.fallDistance - 3);
        if (dmg > 0) this.hurt(dmg, 'fall');
      }
      this.fallDistance = 0;
    } else if (this.vel[1] < 0) {
      this.fallDistance -= this.vel[1] * dt;
    }
    // world bounds
    if (this.pos[1] < -64) { this.hurt(1000, 'void'); }
    if (this.pos[1] > this.world.height + 64) this.pos[1] = this.world.height + 64;
  }

  /** Axis-separated swept movement against the voxel grid. */
  moveWithCollision(dt) {
    let dx = this.vel[0] * dt, dy = this.vel[1] * dt, dz = this.vel[2] * dt;
    this.onWall = false;

    // --- Y
    if (dy !== 0) {
      const ny = this.pos[1] + dy;
      if (this.collidesAt(this.pos[0], ny, this.pos[2])) {
        if (dy < 0) {
          this.pos[1] = Math.floor(ny) + 1;      // land on top of the block
          this.onGround = true;
        } else {
          this.pos[1] = Math.ceil(ny + this.height) - this.height - 0.001;
        }
        this.vel[1] = 0;
      } else {
        this.pos[1] = ny;
        this.onGround = false;
      }
    }

    // --- X (with step up)
    if (dx !== 0) {
      const nx = this.pos[0] + dx;
      if (this.collidesAt(nx, this.pos[1], this.pos[2])) {
        if (this.onGround && this.tryStepUp(nx, this.pos[2], this.pos[1])) {
          this.pos[0] = nx;
        } else {
          this.vel[0] = 0;
          this.onWall = true;
        }
      } else this.pos[0] = nx;
    }
    // --- Z
    if (dz !== 0) {
      const nz = this.pos[2] + dz;
      if (this.collidesAt(this.pos[0], this.pos[1], nz)) {
        if (this.onGround && this.tryStepUp(this.pos[0], nz, this.pos[1])) {
          this.pos[2] = nz;
        } else {
          this.vel[2] = 0;
          this.onWall = true;
        }
      } else this.pos[2] = nz;
    }

    // ground check when barely moving
    if (!this.onGround && Math.abs(this.vel[1]) < 0.001) {
      this.onGround = this.collidesAt(this.pos[0], this.pos[1] - 0.02, this.pos[2]);
    }
  }

  tryStepUp(nx, nz, y) {
    // can we rise by up to stepHeight and fit?
    for (let s = 0.05; s <= this.stepHeight + 0.001; s += 0.05) {
      if (!this.collidesAt(nx, y + s, nz)) {
        this.pos[1] = y + s;
        return true;
      }
    }
    return false;
  }

  collidesAt(x, y, z) {
    if (this.noClip) return false;
    const w = this.world;
    const hw = this.width / 2;
    const x0 = Math.floor(x - hw), x1 = Math.floor(x + hw);
    const y0 = Math.floor(y + 0.001), y1 = Math.floor(y + this.height - 0.001);
    const z0 = Math.floor(z - hw), z1 = Math.floor(z + hw);
    for (let yy = y0; yy <= y1; yy++) {
      for (let zz = z0; zz <= z1; zz++) {
        for (let xx = x0; xx <= x1; xx++) {
          const id = w.getBlock(xx, yy, zz);
          if (id === AIR) continue;
          const b = getBlock(id);
          if (!b.solid) continue;
          if (b.shape === 1 /* SLAB */) {
            const meta = w.getMeta(xx, yy, zz);
            const top = (meta & 8) !== 0;
            const slabTop = yy + (top ? 1 : 0.5);
            const slabBottom = yy + (top ? 0.5 : 0);
            if (y + this.height <= slabBottom + 0.0001 || y >= slabTop - 0.0001) continue;
          }
          if (b.shape === 11 || b.shape === 12) { // farmland / path (15/16)
            if (y >= yy + 0.9375 - 0.0001) continue;
          }
          return true;
        }
      }
    }
    return false;
  }

  updateFire(dt) {
    if (this.fireTicks > 0) {
      this.fireTicks -= dt * 20;
      if (this.inWater) this.fireTicks = 0;
      if (this.fireTicks > 0 && (this.age * 20 | 0) % 20 === 0) this.hurt(1, 'fire');
      this.burning = this.fireTicks > 0;
    } else this.burning = false;
  }

  // -------------------------------------------------------------------------
  hurt(amount, source = 'generic', fromEntity = null) {
    if (this.dead || this.removed || amount <= 0) return false;
    if (this.hurtTime > 0 && source !== 'void') return false;
    if (this.invulnerable) return false;
    let dmg = amount;
    if (source === 'fall' && this.hasEffect('slow_falling')) dmg *= 0.2;
    if (source === 'fire' && this.hasEffect('fire_resistance')) return false;
    if (source === 'lava' && this.hasEffect('fire_resistance')) return false;
    this.health -= dmg;
    this.hurtTime = 0.5;
    this.lastDamageSource = source;
    if (fromEntity) {
      const dx = this.pos[0] - fromEntity.pos[0], dz = this.pos[2] - fromEntity.pos[2];
      const l = Math.hypot(dx, dz) || 1;
      const kb = 0.4 * (1 - this.knockbackResist);
      this.vel[0] += (dx / l) * kb * 6;
      this.vel[2] += (dz / l) * kb * 6;
      this.vel[1] = Math.max(this.vel[1], 0.36 * (1 - this.knockbackResist) * 6);
    }
    if (this.health <= 0) { this.health = 0; this.die(source, fromEntity); }
    return true;
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  die(source, fromEntity) {
    if (this.dead) return;
    this.dead = true;
    this.deathTime = 0;
    if (this.onDeath) this.onDeath(source, fromEntity);
  }

  remove() { this.removed = true; }

  /** Direct knockback (impulse) - used by projectiles, explosions and punching. */
  knockback(dx, dy, dz) {
    const k = 1 - this.knockbackResist;
    this.vel[0] += dx * k;
    this.vel[1] = Math.max(this.vel[1], dy * k);
    this.vel[2] += dz * k;
  }

  /** Set the entity on fire for `ticks`. */
  setFire(ticks) {
    if (this.hasEffect && this.hasEffect('fire_resistance')) return;
    this.fireTicks = Math.max(this.fireTicks, ticks);
  }

  hasEffect(name) { return this.effects ? this.effects.has(name) : false; }

  distanceTo(e) {
    return Math.hypot(this.pos[0] - e.pos[0], this.pos[1] - e.pos[1], this.pos[2] - e.pos[2]);
  }

  lookAt(x, y, z) {
    const dx = x - this.pos[0], dy = y - (this.pos[1] + this.eyeHeight), dz = z - this.pos[2];
    const hd = Math.hypot(dx, dz);
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = Math.atan2(dy, hd);
  }

  /** Direction vector the entity is facing. */
  forward(out) {
    out[0] = -Math.sin(this.yaw); out[1] = 0; out[2] = -Math.cos(this.yaw);
    return out;
  }

  setPos(x, y, z) { this.pos[0] = x; this.pos[1] = y; this.pos[2] = z; this.prevPos.set(this.pos); }

  serialize() {
    return {
      type: this.type, pos: [this.pos[0], this.pos[1], this.pos[2]],
      vel: [this.vel[0], this.vel[1], this.vel[2]],
      yaw: this.yaw, health: this.health, fire: this.fireTicks,
    };
  }
}

export default Entity;
