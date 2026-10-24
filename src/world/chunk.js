/**
 * Ultracraft - chunk storage.
 *
 * Blocks are stored sparsely per 16^3 section so the ~70% of the world that is
 * empty air costs nothing.  Light is stored per voxel in one byte:
 * high nibble = block light, low nibble = sky light.
 */

import { getBlock, AIR } from './blocks.js';

export const SECTION_H = 16;

export class Chunk {
  constructor(cx, cz, height) {
    this.cx = cx;
    this.cz = cz;
    this.height = height;
    this.sectionCount = height >> 4;
    this.sections = new Array(this.sectionCount).fill(null);
    this.heightMap = new Uint16Array(256);   // highest non-air block + 1
    this.state = 0;                          // 0 empty, 1 generated, 2 lit
    this.generated = false;
    this.lit = false;
    this.dirty = false;                      // needs remesh
    this.meshDirty = new Set();              // section indices needing remesh
    this.tileEntities = new Map();           // packed index -> entity data
    this.meshes = null;                      // per section: [{buf, vao, count}]
    this.lastAccess = 0;
    this.needsSave = false;
  }

  section(y) {
    const sy = y >> 4;
    if (sy < 0 || sy >= this.sectionCount) return null;
    return this.sections[sy];
  }

  ensureSection(sy) {
    let s = this.sections[sy];
    if (!s) {
      s = {
        blocks: new Uint16Array(4096),
        meta: new Uint8Array(4096),
        light: new Uint8Array(4096),
        nonAir: 0,
      };
      this.sections[sy] = s;
    }
    return s;
  }

  idx(x, y, z) { return ((y & 15) * 16 + z) * 16 + x; }

  getBlock(x, y, z) {
    const s = this.sections[y >> 4];
    return s ? s.blocks[this.idx(x, y, z)] : 0;
  }

  getMeta(x, y, z) {
    const s = this.sections[y >> 4];
    return s ? s.meta[this.idx(x, y, z)] : 0;
  }

  getLight(x, y, z) {
    const s = this.sections[y >> 4];
    if (s) return s.light[this.idx(x, y, z)];
    // empty section: sky light above the surface, darkness below
    const hm = this.heightMap[z * 16 + x];
    return y >= hm ? 15 : 0;
  }

  setMeta(x, y, z, meta) {
    const s = this.ensureSection(y >> 4);
    s.meta[this.idx(x, y, z)] = meta & 15;
    this.dirty = true;
    this.needsSave = true;
  }

  setLight(x, y, z, v) {
    const s = this.ensureSection(y >> 4);
    s.light[this.idx(x, y, z)] = v;
  }

  setBlock(x, y, z, id, meta = 0) {
    const sy = y >> 4;
    const s = this.sections[sy] || (id === AIR ? null : this.ensureSection(sy));
    if (!s) return;
    const i = this.idx(x, y, z);
    const prev = s.blocks[i];
    if (prev !== id) {
      if (prev === AIR && id !== AIR) s.nonAir++;
      else if (prev !== AIR && id === AIR) s.nonAir--;
    }
    s.blocks[i] = id;
    s.meta[i] = meta;
    // height map
    const hm = z * 16 + x;
    if (id !== AIR) {
      if (y >= this.heightMap[hm]) this.heightMap[hm] = y + 1;
    } else if (this.heightMap[hm] === y + 1) {
      // recompute lazily: walk down
      let ny = y;
      while (ny > 0 && this.getBlock(x, ny - 1, z) === AIR) ny--;
      this.heightMap[hm] = ny;
    }
    this.dirty = true;
    this.needsSave = true;
  }

  /** Highest non-air block + 1 for a local column. */
  top(x, z) { return this.heightMap[z * 16 + x]; }

  isEmpty() {
    for (const s of this.sections) if (s && s.nonAir > 0) return false;
    return true;
  }

  /** Compact representation for saving: only non-empty sections. */
  serialize() {
    const secs = [];
    for (let i = 0; i < this.sectionCount; i++) {
      const s = this.sections[i];
      if (!s || s.nonAir === 0) continue;
      secs.push({ y: i, blocks: s.blocks, meta: s.meta, light: s.light });
    }
    return { cx: this.cx, cz: this.cz, heightMap: this.heightMap, sections: secs, tileEntities: [...this.tileEntities.values()] };
  }
}

export default Chunk;
