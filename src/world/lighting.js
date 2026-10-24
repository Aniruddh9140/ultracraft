/**
 * Ultracraft - voxel light engine.
 *
 * Classic flood-fill lighting: a byte per voxel, high nibble block light /
 * low nibble sky light.  Updates are queued in world space so light can cross
 * chunk borders, and every touched section is marked for remeshing.
 */

import { getBlock, AIR } from './blocks.js';

const MAX_LIGHT = 15;

export class LightEngine {
  constructor(world) {
    this.world = world;
    this.addQueue = [];    // x, y, z triples
    this.remQueue = [];    // x, y, z, oldLevel
    this.head = 0;
    this.processed = 0;
  }

  get pending() { return (this.addQueue.length / 3 - this.head) + this.remQueue.length / 4; }

  blockLight(w) { return (w >> 4) & 15; }
  skyLight(w) { return w & 15; }
  pack(block, sky) { return (block << 4) | sky; }

  /** Initial lighting for a freshly generated chunk (no neighbour dependency). */
  initChunk(chunk) {
    const w = this.world;
    const H = chunk.height;
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const wx = chunk.cx * 16 + x, wz = chunk.cz * 16 + z;
        const hm = chunk.heightMap[z * 16 + x];
        // --- sky light: straight down until we hit something opaque
        let level = MAX_LIGHT;
        for (let y = H - 1; y >= 0; y--) {
          const id = chunk.getBlock(x, y, z);
          if (id !== AIR) {
            const b = getBlock(id);
            // an opaque block (or a full absorber) ends the sky column
            if (b.opaque || b.absorb >= 15) { chunk.setLight(x, y, z, this.pack(0, 0)); break; }
            chunk.setLight(x, y, z, this.pack(0, level));
            level -= b.absorb;                 // leaves / water / ice dim it
            if (level <= 0) break;
          } else {
            chunk.setLight(x, y, z, this.pack(0, level));
          }
        }
        // --- block light emitters inside the column
        for (let y = 0; y < Math.min(H, hm + 1); y++) {
          const id = chunk.getBlock(x, y, z);
          if (id === AIR) continue;
          const b = getBlock(id);
          if (b.light > 0) this.addQueue.push(wx, y, wz);
        }
      }
    }
    chunk.lit = true;
  }

  /** Spread existing light across chunk borders (called after neighbours load). */
  spreadFromChunk(chunk) {
    const H = chunk.height;
    const bx = chunk.cx * 16, bz = chunk.cz * 16;
    for (let y = 0; y < H; y++) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const l = chunk.getLight(x, y, z);
          if (l === 0) continue;
          const onBorder = x === 0 || x === 15 || z === 0 || z === 15;
          if (!onBorder) continue;
          this.addQueue.push(bx + x, y, bz + z);
        }
      }
    }
  }

  onBlockSet(x, y, z, oldId, newId) {
    const w = this.world;
    const oldB = getBlock(oldId), newB = getBlock(newId);
    // emitter added
    if (newB.light > 0) {
      w.setLight(x, y, z, this.pack(newB.light, this.skyLight(w.getLight(x, y, z))));
      this.addQueue.push(x, y, z);
    } else if (oldB.light > 0) {
      w.setLight(x, y, z, this.pack(0, this.skyLight(w.getLight(x, y, z))));
      this.remQueue.push(x, y, z, oldB.light);
    }
    // block became (non) opaque: sky light column changes
    if (oldB.opaque !== newB.opaque) {
      this.updateSkyColumn(x, y, z);
    } else {
      this.addQueue.push(x + 1, y, z, x - 1, y, z, x, y + 1, z, x, y - 1, z, x, y, z + 1, x, y, z - 1);
    }
    w.markLightDirty(x, y, z);
  }

  updateSkyColumn(x, y, z) {
    const w = this.world;
    let level = MAX_LIGHT;
    const H = w.height;
    // walk down from the top of the world
    for (let yy = H - 1; yy >= 0; yy--) {
      const id = w.getBlock(x, yy, z);
      if (id !== AIR) {
        const b = getBlock(id);
        if (b.opaque || b.absorb >= 15) level = 0;
        else level = Math.max(0, level - b.absorb);
      }
      const cur = w.getLight(x, yy, z);
      const curSky = cur & 15;
      const blk = (cur >> 4) & 15;
      if (curSky !== level) {
        w.setLight(x, yy, z, this.pack(blk, level));
        w.markLightDirty(x, yy, z);
        if (level > 0) this.addQueue.push(x, yy, z);
        else this.remQueue.push(x, yy, z, curSky);
      }
      if (level === 0 && curSky === 0 && yy < y - 20) break;
    }
  }

  /** Process queued light updates within a time budget (ms). */
  update(budgetMs = 2) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const w = this.world;
    let guard = 0;

    // removals first
    while (this.remQueue.length && guard++ < 20000) {
      if ((guard & 63) === 0 && now() - t0 > budgetMs) break;
      const x = this.remQueue.shift(), y = this.remQueue.shift(), z = this.remQueue.shift(), old = this.remQueue.shift();
      this.removeLight(x, y, z, old, 0);
    }
    // then additions
    while (this.head * 3 < this.addQueue.length && guard++ < 20000) {
      if ((guard & 63) === 0 && now() - t0 > budgetMs) break;
      const i = this.head * 3;
      const x = this.addQueue[i], y = this.addQueue[i + 1], z = this.addQueue[i + 2];
      this.head++;
      this.propagate(x, y, z, 0);   // block light
      this.propagate(x, y, z, 1);   // sky light
    }
    if (this.head * 3 >= this.addQueue.length) { this.addQueue.length = 0; this.head = 0; }
    this.processed++;
  }

  /** BFS: spread light from (x,y,z) outwards. channel 0 = block, 1 = sky. */
  propagate(x, y, z, channel) {
    const w = this.world;
    const stack = [[x, y, z]];
    let guard = 0;
    while (stack.length && guard++ < 4096) {
      const [cx0, cy0, cz0] = stack.pop();
      const cur = w.getLight(cx0, cy0, cz0);
      let level = channel === 0 ? ((cur >> 4) & 15) : (cur & 15);
      if (level <= 0) continue;
      const id = w.getBlock(cx0, cy0, cz0);
      const b = getBlock(id);
      // air (absorb 0) passes light unchanged, leaves/water dim it, solids stop it
      const next = level - (b.opaque ? 15 : b.absorb);
      if (next <= 0) continue;

      for (let d = 0; d < 6; d++) {
        const nx = cx0 + DIRS[d][0], ny = cy0 + DIRS[d][1], nz = cz0 + DIRS[d][2];
        if (ny < 0 || ny >= w.height) continue;
        if (!w.isChunkLoaded(nx >> 4, nz >> 4)) continue;
        const ncur = w.getLight(nx, ny, nz);
        const nLevel = channel === 0 ? ((ncur >> 4) & 15) : (ncur & 15);
        if (nLevel >= next) continue;
        const nid = w.getBlock(nx, ny, nz);
        const nb = getBlock(nid);
        if (nb.opaque) continue;
        // sky light falls at full strength downwards
        let out = next;
        if (channel === 1 && d === 3 && level === MAX_LIGHT) out = MAX_LIGHT;
        w.setLight(nx, ny, nz, channel === 0 ? this.pack(out, ncur & 15) : this.pack((ncur >> 4) & 15, out));
        w.markLightDirty(nx, ny, nz);
        stack.push([nx, ny, nz]);
      }
    }
  }

  removeLight(x, y, z, oldLevel, channel) {
    const w = this.world;
    const stack = [[x, y, z, oldLevel]];
    const reAdd = [];
    let guard = 0;
    while (stack.length && guard++ < 4096) {
      const [cx0, cy0, cz0, lvl] = stack.pop();
      for (let d = 0; d < 6; d++) {
        const nx = cx0 + DIRS[d][0], ny = cy0 + DIRS[d][1], nz = cz0 + DIRS[d][2];
        if (ny < 0 || ny >= w.height) continue;
        if (!w.isChunkLoaded(nx >> 4, nz >> 4)) continue;
        const ncur = w.getLight(nx, ny, nz);
        const nLevel = channel === 0 ? ((ncur >> 4) & 15) : (ncur & 15);
        if (nLevel === 0) continue;
        const down = (channel === 1 && d === 3 && lvl === MAX_LIGHT);
        if (nLevel < lvl || down) {
          w.setLight(nx, ny, nz, channel === 0 ? this.pack(0, ncur & 15) : this.pack((ncur >> 4) & 15, 0));
          w.markLightDirty(nx, ny, nz);
          stack.push([nx, ny, nz, nLevel]);
        } else {
          reAdd.push(nx, ny, nz);
        }
      }
    }
    for (let i = 0; i < reAdd.length; i += 3) this.addQueue.push(reAdd[i], reAdd[i + 1], reAdd[i + 2]);
  }
}

const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export default LightEngine;
