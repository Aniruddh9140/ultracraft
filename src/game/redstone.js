/**
 * Ultracraft - redstone.
 *
 * A compact but faithful signal model:
 *   * strong sources  - block, torch, lever, button, plate, repeater,
 *                       comparator, observer, daylight detector, target
 *   * wire networks   - connected `redstone_wire` blocks relaxed to a fixed
 *                       point each update (Dijkstra-ish, budgeted)
 *   * components      - lamps, doors, trapdoors, gates, pistons, note blocks,
 *                       dispensers, TNT, rails and command blocks react to
 *                       the rising / falling edge of their input.
 *
 * Everything is driven by a dirty queue so idle circuits cost nothing.
 */

import { getBlock, blockId, BLOCKS, AIR, Shape } from '../world/blocks.js';

const NB = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

const B = {};
const N = (n) => { B[n] = blockId(n); };
for (const n of [
  'redstone_wire', 'redstone_torch', 'redstone_wall_torch', 'redstone_block', 'redstone_lamp',
  'repeater', 'comparator', 'lever', 'observer', 'target', 'daylight_detector',
  'piston', 'sticky_piston', 'piston_head', 'moving_piston', 'tnt', 'note_block',
  'dispenser', 'dropper', 'hopper', 'iron_door', 'iron_trapdoor', 'oak_door', 'spruce_door',
  'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door', 'crimson_door', 'warped_door',
  'oak_trapdoor', 'spruce_trapdoor', 'birch_trapdoor', 'jungle_trapdoor', 'acacia_trapdoor',
  'dark_oak_trapdoor', 'crimson_trapdoor', 'warped_trapdoor', 'oak_fence_gate', 'spruce_fence_gate',
  'birch_fence_gate', 'jungle_fence_gate', 'acacia_fence_gate', 'dark_oak_fence_gate',
  'stone_button', 'oak_button', 'stone_pressure_plate', 'oak_pressure_plate',
  'light_weighted_pressure_plate', 'heavy_weighted_pressure_plate',
  'rail', 'powered_rail', 'detector_rail', 'activator_rail',
  'command_block', 'chain_command_block', 'repeating_command_block',
  'bedrock', 'obsidian', 'end_portal_frame', 'spawner', 'chest', 'trapped_chest', 'furnace',
]) N(n);

const DOORS = new Set([B.oak_door, B.spruce_door, B.birch_door, B.jungle_door, B.acacia_door, B.dark_oak_door, B.crimson_door, B.warped_door, B.iron_door].filter(Boolean));
const TRAPDOORS = new Set([B.oak_trapdoor, B.spruce_trapdoor, B.birch_trapdoor, B.jungle_trapdoor, B.acacia_trapdoor, B.dark_oak_trapdoor, B.crimson_trapdoor, B.warped_trapdoor, B.iron_trapdoor].filter(Boolean));
const GATES = new Set([B.oak_fence_gate, B.spruce_fence_gate, B.birch_fence_gate, B.jungle_fence_gate, B.acacia_fence_gate, B.dark_oak_fence_gate].filter(Boolean));
const PLATES = new Set([B.stone_pressure_plate, B.oak_pressure_plate, B.light_weighted_pressure_plate, B.heavy_weighted_pressure_plate].filter(Boolean));
const BUTTONS = new Set([B.stone_button, B.oak_button].filter(Boolean));
const RAILS = new Set([B.rail, B.powered_rail, B.detector_rail, B.activator_rail].filter(Boolean));
const IMMOVABLE = new Set([B.bedrock, B.obsidian, B.end_portal_frame, B.spawner, B.piston_head, B.moving_piston].filter(Boolean));

export class Redstone {
  constructor(world, game) {
    this.world = world;
    this.game = game;
    this.queue = [];
    this.queued = new Set();
    this.wire = new Map();          // "x,y,z" -> power
    this.scheduled = [];            // delayed repeater / piston events
    this.pulses = new Map();        // key -> ticks remaining (buttons, observers)
  }

  key(x, y, z) { return x + ',' + y + ',' + z; }

  /** Mark a block (and its neighbourhood) for a redstone update. */
  /**
   * Queue a block and its neighbours for re-evaluation.
   * Only direct neighbours matter - a 5x5x5 flood filled the queue with
   * thousands of duplicate entries and it never drained.
   */
  mark(x, y, z) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const k = this.key(x + dx, y + dy, z + dz);
          if (this.queued.has(k)) continue;
          this.queued.add(k);
          this.queue.push([x + dx, y + dy, z + dz]);
        }
      }
    }
    if (this.queue.length > 4096) {
      // pathological circuit (or a clock): drop the backlog rather than stall
      this.queue.splice(0, this.queue.length - 2048);
      this.queued = new Set(this.queue.map((q) => this.key(q[0], q[1], q[2])));
    }
  }

  schedule(delayTicks, fn) { this.scheduled.push({ t: delayTicks, fn }); }

  // -------------------------------------------------------------------------
  // source strengths
  // -------------------------------------------------------------------------
  /** Strong power delivered into position (x,y,z) by the block at (sx,sy,sz). */
  sourcePower(sx, sy, sz, x, y, z) {
    const id = this.world.getBlock(sx, sy, sz);
    if (id === AIR) return 0;
    const meta = this.world.getMeta(sx, sy, sz);
    if (id === B.redstone_block) return 15;
    if (id === B.redstone_torch || id === B.redstone_wall_torch) {
      // a torch powers the block it stands on / is attached to and everything adjacent
      return 15;
    }
    if (id === B.lever) return (meta & 8) ? 15 : 0;
    if (BUTTONS.has(id)) return this.pulses.get(this.key(sx, sy, sz)) ? 15 : 0;
    if (PLATES.has(id)) return (meta & 1) ? 15 : 0;
    if (id === B.daylight_detector) return this.daylightPower(sx, sy, sz);
    if (id === B.target) return (meta & 15);
    if (id === B.observer) return this.pulses.get(this.key(sx, sy, sz)) ? 15 : 0;
    if (id === B.repeater || id === B.comparator) {
      // output side: the repeater powers the block in front of it
      const facing = meta & 3;
      const dirs = [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
      const d = dirs[facing];
      if (sx + d[0] === x && sy + d[1] === y && sz + d[2] === z) return (meta & 8) ? 15 : 0;
      return 0;
    }
    if (id === B.redstone_wire) {
      const p = this.wire.get(this.key(sx, sy, sz));
      return p ? Math.max(0, p - 1) : 0;
    }
    return 0;
  }

  daylightPower(x, y, z) {
    if (!this.game) return 0;
    const open = this.world.isSkyVisible ? this.world.isSkyVisible(x, y + 1, z) : true;
    if (!open) return 0;
    const t = this.game.timeOfDay01;
    const day = t > 0.24 && t < 0.76;
    if (!day) return 0;
    if (this.game.weather && this.game.weather.rain > 0.2) return Math.max(0, 15 - Math.round(this.game.weather.rain * 8));
    const noon = 1 - Math.abs(t - 0.5) * 2;
    return Math.round(clamp(Math.sin(noon * Math.PI * 0.5), 0, 1) * 15);
  }

  /** Total power available to a component at (x,y,z). */
  powerAt(x, y, z) {
    let p = 0;
    for (const d of NB) {
      p = Math.max(p, this.sourcePower(x + d[0], y + d[1], z + d[2], x, y, z));
    }
    // wires can climb a block
    for (const d of NB) {
      if (Math.abs(d[1]) === 1) continue;
      const up = this.world.getBlock(x + d[0], y + 1, z + d[2]);
      const dn = this.world.getBlock(x + d[0], y - 1, z + d[2]);
      if (up === B.redstone_wire) p = Math.max(p, (this.wire.get(this.key(x + d[0], y + 1, z + d[2])) || 0) - 1);
      if (dn === B.redstone_wire) p = Math.max(p, (this.wire.get(this.key(x + d[0], y - 1, z + d[2])) || 0) - 1);
    }
    return clamp(p, 0, 15);
  }

  // -------------------------------------------------------------------------
  // wire network solving
  // -------------------------------------------------------------------------
  /** Recompute the connected wire network containing (x,y,z). */
  solveNetwork(sx, sy, sz) {
    const w = this.world;
    // 1. collect the blob
    const seen = new Set();
    const blob = [];
    const stack = [[sx, sy, sz]];
    seen.add(this.key(sx, sy, sz));
    while (stack.length) {
      const [x, y, z] = stack.pop();
      if (w.getBlock(x, y, z) !== B.redstone_wire) continue;
      blob.push([x, y, z]);
      const grow = (nx, ny, nz) => {
        const k = this.key(nx, ny, nz);
        if (seen.has(k)) return;
        seen.add(k);
        stack.push([nx, ny, nz]);
      };
      for (const d of NB) {
        if (Math.abs(d[1]) === 1) {
          // wires only climb when they can sit on a solid top / hang under air
          if (d[1] > 0 && w.getBlock(x, y + 1, z) === B.redstone_wire) grow(x, y + 1, z);
          if (d[1] < 0 && w.getBlock(x, y - 1, z) === B.redstone_wire) grow(x, y - 1, z);
          continue;
        }
        grow(x + d[0], y, z + d[2]);
        if (w.getBlock(x + d[0], y + 1, z + d[2]) === B.redstone_wire && !w.isSolid(x + d[0], y, z + d[2])) grow(x + d[0], y + 1, z + d[2]);
        if (w.getBlock(x + d[0], y - 1, z + d[2]) === B.redstone_wire && !w.isSolid(x + d[0], y, z + d[2])) grow(x + d[0], y - 1, z + d[2]);
      }
    }
    if (!blob.length) return;
    // 2. seed from strong sources
    const power = new Map();
    const check = (x, y, z, k) => {
      let p = 0;
      for (const d of NB) {
        const s = this.sourcePower(x + d[0], y + d[1], z + d[2], x, y, z);
        if (s > p) p = s;
      }
      // torches / blocks also power the wire directly from below / above
      if (w.getBlock(x, y + 1, z) === B.redstone_torch) p = 15;
      return p;
    };
    for (const [x, y, z] of blob) power.set(this.key(x, y, z), check(x, y, z));
    // 3. relax
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 64) {
      changed = false;
      for (const [x, y, z] of blob) {
        const k = this.key(x, y, z);
        let p = power.get(k);
        for (const d of NB) {
          if (Math.abs(d[1]) === 1) {
            const nk = this.key(x, y + d[1], z);
            if (power.has(nk)) p = Math.max(p, power.get(nk) - 1);
            continue;
          }
          const nk = this.key(x + d[0], y, z + d[2]);
          if (power.has(nk)) p = Math.max(p, power.get(nk) - 1);
          const uk = this.key(x + d[0], y + 1, z + d[2]);
          if (power.has(uk) && !w.isSolid(x + d[0], y, z + d[2])) p = Math.max(p, power.get(uk) - 1);
          const dk = this.key(x + d[0], y - 1, z + d[2]);
          if (power.has(dk) && !w.isSolid(x + d[0], y, z + d[2])) p = Math.max(p, power.get(dk) - 1);
        }
        p = clamp(p, 0, 15);
        if (p !== power.get(k)) { power.set(k, p); changed = true; }
      }
    }
    // 4. write back + notify components around the network
    const notify = new Set();
    for (const [x, y, z] of blob) {
      const k = this.key(x, y, z);
      const p = power.get(k) || 0;
      if (this.wire.get(k) !== p) {
        this.wire.set(k, p);
        this.world.setMeta(x, y, z, p & 15);
        for (const d of NB) notify.add(this.key(x + d[0], y + d[1], z + d[2]));
      }
      for (const d of NB) notify.add(this.key(x + d[0], y + d[1], z + d[2]));
    }
    for (const k of notify) {
      const [x, y, z] = k.split(',').map(Number);
      this.updateComponent(x, y, z, true);
    }
  }

  // -------------------------------------------------------------------------
  // components
  // -------------------------------------------------------------------------
  updateComponent(x, y, z, fromWire = false) {
    const w = this.world;
    const id = w.getBlock(x, y, z);
    if (id === AIR) return;
    const meta = w.getMeta(x, y, z);
    const power = fromWire ? this.powerAt(x, y, z) : this.powerAt(x, y, z);

    if (id === B.redstone_lamp) {
      const lit = power > 0;
      if (!!(meta & 1) !== lit) {
        w.setMeta(x, y, z, lit ? (meta | 1) : (meta & ~1));
        w.setLight(x, y, z, lit ? 15 : 0);
        w.markBlockDirty(x, y, z);
      }
      return;
    }
    if (DOORS.has(id) || TRAPDOORS.has(id) || GATES.has(id)) {
      const open = power > 0;
      if (!!(meta & 4) !== open) {
        w.setMeta(x, y, z, open ? (meta | 4) : (meta & ~4));
        w.markBlockDirty(x, y, z);
        // doors are two blocks tall
        if (DOORS.has(id)) {
          const up = (meta & 8) ? -1 : 1;
          const m2 = w.getMeta(x, y + up, z);
          w.setMeta(x, y + up, z, open ? (m2 | 4) : (m2 & ~4));
          w.markBlockDirty(x, y + up, z);
        }
        if (this.game && this.game.audio) this.game.audio.play(open ? 'door_open' : 'door_close', x, y, z);
      }
      return;
    }
    if (id === B.piston || id === B.sticky_piston) {
      const extended = !!(meta & 8);
      if (power > 0 && !extended) this.extendPiston(x, y, z, meta & 7, id === B.sticky_piston);
      else if (power === 0 && extended) this.retractPiston(x, y, z, meta & 7, id === B.sticky_piston);
      return;
    }
    if (id === B.note_block) {
      if (power > 0 && !(meta & 8)) {
        w.setMeta(x, y, z, meta | 8);
        if (this.game && this.game.onNotePlayed) this.game.onNotePlayed(x, y, z);
      } else if (power === 0 && (meta & 8)) w.setMeta(x, y, z, meta & ~8);
      return;
    }
    if (id === B.tnt) {
      if (power > 0) this.igniteTnt(x, y, z);
      return;
    }
    if (id === B.dispenser || id === B.dropper) {
      if (power > 0 && !(meta & 8)) {
        w.setMeta(x, y, z, meta | 8);
        const te = w.tileEntityAt(x, y, z);
        if (te && te.trigger) te.trigger(w, this.game);
      } else if (power === 0 && (meta & 8)) w.setMeta(x, y, z, meta & ~8);
      return;
    }
    if (RAILS.has(id)) {
      const on = power > 0;
      if (!!(meta & 8) !== on) {
        w.setMeta(x, y, z, on ? (meta | 8) : (meta & ~8));
        w.markBlockDirty(x, y, z);
        // power propagates along powered rails for 8 blocks
        if (id === B.powered_rail && on) {
          for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            for (let i = 1; i <= 8; i++) {
              const nx = x + d[0] * i, nz = z + d[1] * i;
              if (w.getBlock(nx, y, nz) !== B.powered_rail) break;
              const m = w.getMeta(nx, y, nz);
              if (!(m & 8)) { w.setMeta(nx, y, nz, m | 8); w.markBlockDirty(nx, y, nz); }
            }
          }
        }
      }
      return;
    }
    if (id === B.command_block || id === B.chain_command_block || id === B.repeating_command_block) {
      if (power > 0 && !(meta & 8)) {
        w.setMeta(x, y, z, meta | 8);
        if (this.game && this.game.runCommandBlock) this.game.runCommandBlock(x, y, z);
      } else if (power === 0 && (meta & 8)) w.setMeta(x, y, z, meta & ~8);
      return;
    }
    if (id === B.repeater) {
      const locked = this.repeaterLocked(x, y, z, meta);
      const want = power > 0;
      const delay = (2 + (meta >> 4) * 2);
      if (locked) return;
      if (want !== !!(meta & 8)) {
        this.schedule(delay, () => {
          const m = w.getMeta(x, y, z);
          w.setMeta(x, y, z, want ? (m | 8) : (m & ~8));
          w.markBlockDirty(x, y, z);
          this.mark(x, y, z);
        });
      }
      return;
    }
    if (id === B.comparator) {
      const rear = this.comparatorRear(x, y, z, meta);
      const side = this.comparatorSide(x, y, z, meta);
      let out = (meta & 1) ? Math.max(0, rear - side) : (side > rear ? 0 : rear);
      const want = out > 0;
      if (want !== !!(meta & 8)) {
        this.schedule(2, () => {
          const m = w.getMeta(x, y, z);
          w.setMeta(x, y, z, (m & ~8) | (want ? 8 : 0));
          w.markBlockDirty(x, y, z);
          this.mark(x, y, z);
        });
      } else if ((meta & 15) !== out) {
        w.setMeta(x, y, z, (meta & ~15) | (out & 15) | (want ? 8 : 0));
        w.markBlockDirty(x, y, z);
      }
      return;
    }
    if (id === B.redstone_torch || id === B.redstone_wall_torch) {
      // torches turn off when the block they are attached to is powered
      const below = w.getBlock(x, y - 1, z);
      if (below !== AIR && this.powerAt(x, y - 1, z) > 0) {
        this.schedule(2, () => { if (this.powerAt(x, y - 1, z) > 0) this.burnOut(x, y, z); });
      }
      return;
    }
  }

  burnOut(x, y, z) {
    // a torch that toggles too often burns out for a second
    const k = this.key(x, y, z);
    this.pulses.set(k, -40);
    if (this.game && this.game.audio) this.game.audio.play('fizz', x, y, z);
  }

  repeaterLocked(x, y, z, meta) {
    const dirs = [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
    const d = dirs[meta & 3];
    const perp = [d[2], 0, -d[0]];
    for (const s of [1, -1]) {
      const id = this.world.getBlock(x + perp[0] * s, y, z + perp[2] * s);
      if (id === B.repeater) {
        const m = this.world.getMeta(x + perp[0] * s, y, z + perp[2] * s);
        if ((m & 8) && ((m & 3) === ((meta & 3) ^ 1))) return true;
      }
    }
    return false;
  }

  comparatorRear(x, y, z, meta) {
    const dirs = [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
    const d = dirs[meta & 3];
    const bx = x - d[0], bz = z - d[2];
    const te = this.world.tileEntityAt(bx, y, bz) || this.world.tileEntityAt(bx, y - 1, bz);
    if (te && te.inv) return containerSignal(te.inv);
    return this.powerAt(bx, y, bz);
  }

  comparatorSide(x, y, z, meta) {
    const dirs = [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
    const d = dirs[meta & 3];
    const perp = [d[2], 0, -d[0]];
    let best = 0;
    for (const s of [1, -1]) {
      best = Math.max(best, this.powerAt(x + perp[0] * s, y, z + perp[2] * s));
    }
    return best;
  }

  igniteTnt(x, y, z) {
    if (this.game) this.game.primeTnt(x, y, z);
  }

  // -------------------------------------------------------------------------
  // pistons
  // -------------------------------------------------------------------------
  pistonDir(meta) {
    return [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][meta & 7];
  }

  extendPiston(x, y, z, meta, sticky) {
    const w = this.world;
    const d = this.pistonDir(meta);
    const move = [];
    let ok = true;
    for (let i = 1; i <= 12; i++) {
      const bx = x + d[0] * i, by = y + d[1] * i, bz = z + d[2] * i;
      const id = w.getBlock(bx, by, bz);
      if (id === AIR || getBlock(id).replaceable) break;
      if (IMMOVABLE.has(id) || w.tileEntityAt(bx, by, bz)) { ok = false; break; }
      move.push([bx, by, bz, id, w.getMeta(bx, by, bz)]);
      if (move.length > 12) { ok = false; break; }
    }
    if (!ok || !move.length) {
      // nothing to push: just show the head if the front is free
      const fx = x + d[0], fy = y + d[1], fz = z + d[2];
      const fid = w.getBlock(fx, fy, fz);
      if (fid === AIR || getBlock(fid).replaceable) {
        w.setBlock(fx, fy, fz, B.piston_head, (meta & 7) | (sticky ? 8 : 0));
        w.setMeta(x, y, z, (meta & ~8) | 8);
      }
      return;
    }
    // shift from the far end backwards
    for (let i = move.length - 1; i >= 0; i--) {
      const [bx, by, bz, id, m] = move[i];
      w.setBlock(bx + d[0], by + d[1], bz + d[2], id, m);
    }
    w.setBlock(x + d[0], y + d[1], z + d[2], B.piston_head, (meta & 7) | (sticky ? 8 : 0));
    w.setMeta(x, y, z, (meta & ~8) | 8);
    if (this.game && this.game.audio) this.game.audio.play('piston_out', x, y, z);
    this.mark(x + d[0] * move.length, y + d[1] * move.length, z + d[2] * move.length);
  }

  retractPiston(x, y, z, meta, sticky) {
    const w = this.world;
    const d = this.pistonDir(meta);
    let pulled = null;
    if (sticky) {
      const bx = x + d[0] * 2, by = y + d[1] * 2, bz = z + d[2] * 2;
      const id = w.getBlock(bx, by, bz);
      if (id !== AIR && !IMMOVABLE.has(id) && !w.tileEntityAt(bx, by, bz)) {
        pulled = [id, w.getMeta(bx, by, bz)];
        w.setBlock(bx, by, bz, AIR, 0);
      }
    }
    // remove the head
    const hx = x + d[0], hy = y + d[1], hz = z + d[2];
    if (w.getBlock(hx, hy, hz) === B.piston_head) w.setBlock(hx, hy, hz, AIR, 0);
    // pull the row back by one
    for (let i = 2; i <= 13; i++) {
      const bx = x + d[0] * i, by = y + d[1] * i, bz = z + d[2] * i;
      const id = w.getBlock(bx, by, bz);
      if (id === AIR || id === B.piston_head) break;
      const m = w.getMeta(bx, by, bz);
      w.setBlock(bx, by, bz, AIR, 0);
      w.setBlock(bx - d[0], by - d[1], bz - d[2], id, m);
    }
    if (pulled) w.setBlock(x + d[0], y + d[1], z + d[2], pulled[0], pulled[1]);
    w.setMeta(x, y, z, meta & ~8);
    if (this.game && this.game.audio) this.game.audio.play('piston_in', x, y, z);
    this.mark(x + d[0], y + d[1], z + d[2]);
  }

  // -------------------------------------------------------------------------
  // frame update
  // -------------------------------------------------------------------------
  update(dt, budgetMs = 2) {
    const t0 = now();
    // pulses
    if (this.pulses.size) {
      for (const [k, t] of this.pulses) {
        const nt = t - dt * 20;
        if (nt <= 0) { this.pulses.delete(k); const [x, y, z] = k.split(',').map(Number); this.mark(x, y, z); }
        else this.pulses.set(k, nt);
      }
    }
    // scheduled events
    if (this.scheduled.length) {
      const keep = [];
      for (const s of this.scheduled) {
        s.t -= dt * 20;
        if (s.t <= 0) s.fn(); else keep.push(s);
      }
      this.scheduled = keep;
    }
    while (this.queue.length) {
      const [x, y, z] = this.queue.shift();
      this.queued.delete(this.key(x, y, z));
      if (this.world.getBlock(x, y, z) === B.redstone_wire) this.solveNetwork(x, y, z);
      else this.updateComponent(x, y, z);
      if (now() - t0 > budgetMs) break;
    }
  }

  /** Press a button for `ticks`. */
  press(x, y, z, ticks = 20) {
    this.pulses.set(this.key(x, y, z), ticks);
    this.mark(x, y, z);
  }

  /** Observer emits a pulse out of its face. */
  pulse(x, y, z) {
    this.pulses.set(this.key(x, y, z), 2);
    this.mark(x, y, z);
  }

  /** A block changed: refresh everything nearby. */
  onBlockChanged(x, y, z) { this.mark(x, y, z); }
}

/** Redstone signal produced by a container (comparator). */
export function containerSignal(inv) {
  if (!inv || !inv.slots) return 0;
  let total = 0;
  for (const s of inv.slots) if (s) total += s.count / Math.min(s.maxStack, 64);
  if (!total) return 0;
  return Math.max(1, Math.floor(1 + (total / inv.slots.length) * 14));
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

export default Redstone;
