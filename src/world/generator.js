/**
 * Ultracraft - world generation.
 *
 * Runs entirely inside web workers: a chunk is a pure function of
 * (cx, cz, seed, dimension, worldType), which means generation is parallel,
 * deterministic and needs no cross-chunk state.  Features that straddle chunk
 * borders are generated from their own deterministic origin position and
 * clipped, so every chunk that touches them produces identical blocks.
 */

import { Noise } from '../core/noise.js';
import { makeRng, clamp, lerp, hashString } from '../core/math.js';
import { BLOCKS, BLOCK, Shape } from './blocks.js';

export const SEA_LEVEL = 64;
export const WORLD_HEIGHT = 256;
export const NETHER_HEIGHT = 128;

// ===========================================================================
//  biomes
// ===========================================================================
const B = (o) => Object.assign({
  surface: 'grass_block', filler: 'dirt', underwater: 'gravel',
  trees: null, plants: 0.02, flowers: 0.01, grassTint: [104, 168, 72], foliageTint: [96, 160, 66],
  waterTint: [60, 110, 200], temp: 0.5, humidity: 0.5, height: 0, variation: 0.3,
  mobs: { passive: 8, hostile: 4 },
}, o);

export const BIOMES = [
  B({ id: 0, name: 'ocean', surface: 'gravel', filler: 'gravel', height: -0.45, mobs: { passive: 1, hostile: 2 } }),
  B({ id: 1, name: 'deep_ocean', surface: 'gravel', filler: 'gravel', height: -0.75, mobs: { passive: 1, hostile: 2 } }),
  B({ id: 2, name: 'beach', surface: 'sand', filler: 'sand', height: 0.02, variation: 0.06, trees: null, plants: 0.005 }),
  B({ id: 3, name: 'plains', height: 0.08, variation: 0.08, trees: { type: 'oak', density: 0.004 }, plants: 0.14, flowers: 0.03 }),
  B({ id: 4, name: 'forest', height: 0.12, variation: 0.1, trees: { type: 'oak', density: 0.09 }, plants: 0.1, flowers: 0.02 }),
  B({ id: 5, name: 'birch_forest', height: 0.12, variation: 0.09, trees: { type: 'birch', density: 0.08 }, plants: 0.08, grassTint: [130, 180, 90] }),
  B({ id: 6, name: 'taiga', height: 0.16, variation: 0.12, trees: { type: 'spruce', density: 0.09 }, plants: 0.05, temp: 0.25, grassTint: [110, 160, 100] }),
  B({ id: 7, name: 'snowy_tundra', surface: 'snow_block', filler: 'dirt', height: 0.1, variation: 0.08, trees: { type: 'spruce', density: 0.015 }, plants: 0.01, temp: 0.0, grassTint: [150, 180, 170] }),
  B({ id: 8, name: 'desert', surface: 'sand', filler: 'sandstone', height: 0.1, variation: 0.06, trees: { type: 'cactus', density: 0.01 }, plants: 0.002, temp: 0.9, humidity: 0.0, grassTint: [190, 180, 100] }),
  B({ id: 9, name: 'savanna', height: 0.1, variation: 0.06, trees: { type: 'acacia', density: 0.008 }, plants: 0.18, temp: 0.85, humidity: 0.2, grassTint: [175, 165, 90] }),
  B({ id: 10, name: 'jungle', height: 0.14, variation: 0.12, trees: { type: 'jungle', density: 0.16 }, plants: 0.25, flowers: 0.01, temp: 0.9, humidity: 1.0, grassTint: [90, 170, 60], foliageTint: [70, 150, 50] }),
  B({ id: 11, name: 'swamp', surface: 'grass_block', height: -0.02, variation: 0.04, trees: { type: 'swamp', density: 0.03 }, plants: 0.12, temp: 0.7, humidity: 0.95, grassTint: [110, 140, 90], waterTint: [70, 110, 90] }),
  B({ id: 12, name: 'mountains', height: 0.85, variation: 0.55, trees: { type: 'spruce', density: 0.02 }, plants: 0.03, temp: 0.2, mobs: { passive: 4, hostile: 6 } }),
  B({ id: 13, name: 'badlands', surface: 'red_sand', filler: 'terracotta', height: 0.35, variation: 0.25, trees: { type: 'cactus', density: 0.006 }, plants: 0.01, temp: 0.9, humidity: 0.0, grassTint: [180, 140, 80] }),
  B({ id: 14, name: 'mushroom_fields', surface: 'mycelium', filler: 'dirt', height: 0.2, variation: 0.18, trees: { type: 'mushroom', density: 0.02 }, plants: 0.02, grassTint: [140, 130, 150], mobs: { passive: 6, hostile: 0 } }),
  B({ id: 15, name: 'dark_forest', height: 0.12, variation: 0.08, trees: { type: 'dark_oak', density: 0.14 }, plants: 0.06, grassTint: [80, 130, 60] }),
];

export const NETHER_BIOMES = [
  B({ id: 100, name: 'nether_wastes', surface: 'netherrack', filler: 'netherrack', height: 0, plants: 0, grassTint: [150, 80, 70], waterTint: [200, 80, 40], mobs: { passive: 0, hostile: 12 } }),
  B({ id: 101, name: 'soul_sand_valley', surface: 'soul_sand', filler: 'soul_soil', height: -0.1, plants: 0, mobs: { passive: 0, hostile: 14 } }),
  B({ id: 102, name: 'basalt_deltas', surface: 'basalt', filler: 'blackstone', height: 0.15, plants: 0, mobs: { passive: 0, hostile: 12 } }),
];

export function biomeByName(n) { return BIOMES.find((b) => b.name === n) || NETHER_BIOMES.find((b) => b.name === n) || BIOMES[3]; }

// ===========================================================================
//  generator
// ===========================================================================
export class WorldGenerator {
  constructor(seed, dimension = 'overworld', type = 'default') {
    this.seedString = String(seed);
    this.seed = typeof seed === 'number' ? seed : hashString(String(seed));
    this.dimension = dimension;
    this.type = type; // 'default' | 'flat' | 'amplified' | 'void' | 'island' | 'debug'
    const s = this.seed;
    this.nHeight = new Noise(s + 1);
    this.nMountain = new Noise(s + 2);
    this.nErode = new Noise(s + 3);
    this.nTemp = new Noise(s + 4);
    this.nHumid = new Noise(s + 5);
    this.nCave = new Noise(s + 6);
    this.nCave2 = new Noise(s + 7);
    this.nOre = new Noise(s + 8);
    this.nDetail = new Noise(s + 9);
    this.nNether = new Noise(s + 10);
    this.nNether2 = new Noise(s + 11);
    this.height = dimension === 'nether' ? NETHER_HEIGHT : WORLD_HEIGHT;
    this.biomeCache = new Map();
  }

  // -------------------------------------------------------------------------
  heightAt(x, z) {
    if (this.type === 'flat') return 4;
    const amp = this.type === 'amplified' ? 1.9 : 1.0;
    // continent shape
    let cont = this.nHeight.warp2(x * 0.0016, z * 0.0016, 0.55, 4);
    cont = clamp(cont * 1.25, -1, 1);
    // large scale erosion flattens river/valley areas
    const erode = (this.nErode.fbm2(x * 0.004, z * 0.004, 3) * 0.5 + 0.5);
    // mountains where ridged noise is high
    let mnt = this.nMountain.ridged2(x * 0.0035, z * 0.0035, 5);
    mnt = Math.max(0, mnt) * 1.15;
    const mntMask = clamp((cont - 0.05) * 3.2, 0, 1);

    let h = cont * 22 * amp;
    h += mnt * mnt * 62 * amp * mntMask;
    h *= 0.55 + erode * 0.9;
    // small detail
    h += this.nDetail.fbm2(x * 0.03, z * 0.03, 3) * 3.2;
    return SEA_LEVEL + h;
  }

  temperatureAt(x, z) { return this.nTemp.fbm2(x * 0.0011, z * 0.0011, 3) * 0.5 + 0.5; }
  humidityAt(x, z) { return this.nHumid.fbm2(x * 0.0013, z * 0.0013, 3) * 0.5 + 0.5; }

  /** Biome lookup with a cache keyed on a 4-block grid. */
  biomeAt(x, z) {
    if (this.dimension === 'nether') {
      const v = this.nTemp.fbm2(x * 0.004, z * 0.004, 2);
      if (v > 0.28) return NETHER_BIOMES[2];
      if (v < -0.3) return NETHER_BIOMES[1];
      return NETHER_BIOMES[0];
    }
    if (this.type === 'flat') return BIOMES[3];
    const key = ((x >> 2) & 0xffff) * 65536 + ((z >> 2) & 0xffff);
    let b = this.biomeCache.get(key);
    if (b) return b;
    const h = this.heightAt(x, z);
    const t = this.temperatureAt(x, z);
    const hu = this.humidityAt(x, z);
    const er = this.nErode.fbm2(x * 0.004, z * 0.004, 3);
    b = pickBiome(h, t, hu, er);
    if (this.biomeCache.size > 4096) this.biomeCache.clear();
    this.biomeCache.set(key, b);
    return b;
  }

  // -------------------------------------------------------------------------
  isCave(x, y, z, surfaceY) {
    if (y > surfaceY - 2) return false;
    // cheese caves
    const c1 = this.nCave.noise3(x * 0.026, y * 0.045, z * 0.026);
    const c2 = this.nCave2.noise3(x * 0.026, y * 0.045, z * 0.026);
    if (Math.abs(c1) < 0.085 && Math.abs(c2) < 0.085) return true;
    // worm / tunnels
    const w1 = this.nCave.noise3(x * 0.017, y * 0.017, z * 0.017);
    const w2 = this.nCave2.noise3(x * 0.017 + 100, y * 0.017, z * 0.017);
    const dist = Math.hypot(w1, w2);
    if (dist < 0.055) return true;
    // large caverns in the deep
    if (y < 40) {
      const c3 = this.nCave.noise3(x * 0.011, y * 0.022, z * 0.011);
      if (Math.abs(c3) < 0.11 && dist < 0.14) return true;
    }
    return false;
  }

  // =========================================================================
  //  chunk generation entry point
  // =========================================================================
  generateChunk(cx, cz) {
    const sizeX = 16, sizeZ = 16, sizeY = this.height;
    const blocks = new Uint16Array(sizeX * sizeY * sizeZ);
    const meta = new Uint8Array(sizeX * sizeY * sizeZ);
    const heightMap = new Uint16Array(sizeX * sizeZ);
    const out = { blocks, meta, heightMap, cx, cz, tileEntities: [], lights: [] };

    if (this.type === 'void') return out;

    if (this.dimension === 'nether') { this.genNether(out, cx, cz); return out; }
    if (this.type === 'flat') { this.genFlat(out, cx, cz); return out; }

    const idx = (x, y, z) => (y * sizeZ + z) * sizeX + x;
    const ox = cx * 16, oz = cz * 16;
    const AIR = 0;
    const stone = BLOCK.get('stone').id;
    const deepslate = BLOCK.get('deepslate').id;
    const water = BLOCK.get('water').id;
    const bedrock = BLOCK.get('bedrock').id;
    const dirt = BLOCK.get('dirt').id;
    const grass = BLOCK.get('grass_block').id;
    const sand = BLOCK.get('sand').id;
    const sandstone = BLOCK.get('sandstone').id;
    const gravel = BLOCK.get('gravel').id;
    const snowLayer = BLOCK.get('snow_layer').id;
    const lava = BLOCK.get('lava').id;

    // --- terrain columns ---------------------------------------------------
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const wx = ox + x, wz = oz + z;
        const biome = this.biomeAt(wx, wz);
        let h = Math.round(this.heightAt(wx, wz));
        // local biome height offset
        h = Math.round(SEA_LEVEL + (h - SEA_LEVEL) * (1 + biome.height) + biome.height * 24);
        h = clamp(h, 6, sizeY - 40);
        // heightMap stores the first empty y (highest non-air block + 1), which
        // is exactly what Chunk.setBlock maintains when the player edits blocks
        heightMap[z * 16 + x] = h + 1;

        let top = biome.surface === 'grass_block' ? grass : (BLOCK.get(biome.surface) || BLOCK.get('grass_block')).id;
        const fillerId = (BLOCK.get(biome.filler) || BLOCK.get('dirt')).id;
        const underwaterId = (BLOCK.get(biome.underwater) || BLOCK.get('gravel')).id;

        for (let y = 0; y <= h; y++) {
          let id = stone;
          if (y === 0 || (y < 5 && this.nDetail.rand3(wx, y, wz) < (5 - y) / 5)) id = bedrock;
          else if (y < 8 && this.nOre.noise3(wx * 0.1, y * 0.1, wz * 0.1) > 0.2) id = deepslate;
          else if (y === h) {
            if (h <= SEA_LEVEL - 1) id = underwaterId;
            else if (h <= SEA_LEVEL + 1) id = (biome.name === 'desert' || biome.name === 'beach') ? sand : underwaterId;
            else id = top;
          } else if (y > h - 4) id = fillerId;
          if (id !== AIR) blocks[idx(x, y, z)] = id;
        }
        // water / lava fill
        if (h < SEA_LEVEL) {
          for (let y = h + 1; y <= SEA_LEVEL; y++) blocks[idx(x, y, z)] = water;
          heightMap[z * 16 + x] = SEA_LEVEL + 1;
        }
        // snow layer on cold biomes
        if (biome.temp <= 0.05 && h > SEA_LEVEL && h < sizeY - 1) {
          blocks[idx(x, h + 1, z)] = snowLayer;
          heightMap[z * 16 + x] = h + 2;
        }
        // caves
        for (let y = 1; y < h; y++) {
          if (blocks[idx(x, y, z)] === 0) continue;
          if (this.isCave(wx, y, wz, h)) {
            blocks[idx(x, y, z)] = 0;
            if (y <= 9) {
              // lava lakes at the bottom of the world
              if (this.nDetail.rand3(wx, y, wz) < 0.35) blocks[idx(x, y, z)] = lava;
            }
          }
        }
      }
    }

    // --- ores --------------------------------------------------------------
    this.placeOres(out, ox, oz, idx);

    // --- features (multi-chunk aware) -------------------------------------
    this.placeFeatures(out, cx, cz, idx);

    return out;
  }

  // -------------------------------------------------------------------------
  genFlat(out, cx, cz) {
    const { blocks, heightMap } = out;
    const idx = (x, y, z) => (y * 16 + z) * 16 + x;
    const layers = [
      [0, 'bedrock'], [1, 'dirt'], [2, 'dirt'], [3, 'grass_block'],
    ];
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      for (const [y, name] of layers) blocks[idx(x, y, z)] = BLOCK.get(name).id;
      heightMap[z * 16 + x] = 4;
    }
    this.placeFeatures(out, cx, cz, idx);
  }

  // -------------------------------------------------------------------------
  genNether(out, cx, cz) {
    const { blocks, meta, heightMap } = out;
    const sizeY = NETHER_HEIGHT;
    const idx = (x, y, z) => (y * 16 + z) * 16 + x;
    const ox = cx * 16, oz = cz * 16;
    const netherrack = BLOCK.get('netherrack').id;
    const lava = BLOCK.get('lava').id;
    const air = 0;
    const LAVA_LEVEL = 31;

    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const wx = ox + x, wz = oz + z;
        const biome = this.biomeAt(wx, wz);
        const surf = BLOCK.get(biome.surface).id;
        const fill = BLOCK.get(biome.filler).id;
        // 3D noise cave system: solid where density > 0
        for (let y = 0; y < sizeY; y++) {
          let d = this.nNether.fbm3(wx * 0.017, y * 0.028, wz * 0.017, 4) * 1.4;
          // floor and ceiling are always solid
          if (y < 6) d += (6 - y) * 0.35;
          if (y > sizeY - 12) d += (y - (sizeY - 12)) * 0.35;
          d += (Math.abs(y - 64) - 40) * 0.012;
          if (d > 0.02) {
            let id = netherrack;
            if (y > 110 || y < 8) id = fill;
            else if (d < 0.06) id = surf;
            blocks[idx(x, y, z)] = id;
            heightMap[z * 16 + x] = Math.max(heightMap[z * 16 + x], y + 1);
          } else if (y <= LAVA_LEVEL) {
            blocks[idx(x, y, z)] = lava;
          }
        }
      }
    }
    // nether ores + glowstone
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const wx = ox + x, wz = oz + z;
      for (let y = 4; y < sizeY - 6; y++) {
        const i = idx(x, y, z);
        if (blocks[i] !== netherrack) continue;
        const r = this.nOre.rand3(wx, y, wz);
        if (r < 0.012 && y > 20 && y < 100) blocks[i] = BLOCK.get('nether_quartz_ore').id;
        else if (r < 0.018) blocks[i] = BLOCK.get('nether_gold_ore').id;
        else if (r < 0.021) blocks[i] = BLOCK.get('soul_sand').id;
        else if (r < 0.0235) blocks[i] = BLOCK.get('gravel').id;
        else if (r < 0.0245) blocks[i] = BLOCK.get('magma_block').id;
      }
    }
    // glowstone clusters hanging from ceilings
    for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
      const ccx = cx + gx, ccz = cz + gz;
      const r = this.nDetail.rand3(ccx, 77, ccz);
      if (r > 0.22) continue;
      const fx = ccx * 16 + Math.floor(this.nDetail.rand3(ccx, 78, ccz) * 16);
      const fz = ccz * 16 + Math.floor(this.nDetail.rand3(ccx, 79, ccz) * 16);
      const fy = 70 + Math.floor(this.nDetail.rand3(ccx, 80, ccz) * 40);
      this.glowstoneCluster(out, fx - ox, fy, fz - oz);
    }
    return out;
  }

  glowstoneCluster(out, x, y, z) {
    const { blocks } = out;
    const idx = (x, y, z) => (y * 16 + z) * 16 + x;
    const g = BLOCK.get('glowstone').id;
    const n = 12 + Math.floor(this.nDetail.rand3(x, y, z) * 20);
    for (let i = 0; i < n; i++) {
      const a = this.nDetail.rand3(x + i, y, z) * Math.PI * 2;
      const rr = this.nDetail.rand3(x, y + i, z) * 2.4;
      const px = Math.round(x + Math.cos(a) * rr);
      const py = Math.round(y - Math.abs(Math.sin(a)) * rr * 0.7);
      const pz = Math.round(z + Math.sin(a) * rr);
      if (px < 0 || px > 15 || pz < 0 || pz > 15 || py < 4 || py > NETHER_HEIGHT - 4) continue;
      const i2 = idx(px, py, pz);
      if (blocks[i2] === 0) blocks[i2] = g;
    }
  }

  // -------------------------------------------------------------------------
  placeOres(out, ox, oz, idx) {
    const { blocks } = out;
    const ORE_TABLE = [
      // name, minY, maxY, chancePerBlock, veinSize, deepslate variant
      ['coal_ore', 8, 128, 0.0100, 8],
      ['iron_ore', 4, 64, 0.0062, 6],
      ['gold_ore', 4, 32, 0.0016, 5],
      ['diamond_ore', 4, 16, 0.00075, 4],
      ['emerald_ore', 8, 40, 0.00055, 2],
      ['lapis_ore', 8, 36, 0.0018, 5],
      ['redstone_ore', 4, 24, 0.0042, 6],
      ['copper_ore', 16, 96, 0.0055, 7],
    ];
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const wx = ox + x, wz = oz + z;
        for (let y = 2; y < 130; y++) {
          const i = idx(x, y, z);
          const cur = blocks[i];
          if (cur !== BLOCK.get('stone').id && cur !== BLOCK.get('deepslate').id) continue;
          for (const [name, minY, maxY, chance, size] of ORE_TABLE) {
            if (y < minY || y > maxY) continue;
            // deterministic: only the "vein origin" rolls
            const ox2 = Math.floor(wx / 3) * 3, oy2 = Math.floor(y / 3) * 3, oz2 = Math.floor(wz / 3) * 3;
            if (this.nOre.rand3(ox2 * 31 + name.length, oy2, oz2 * 17) > chance * 9) continue;
            // walk the vein
            const deep = cur === BLOCK.get('deepslate').id;
            const oreId = BLOCK.get(deep ? 'deepslate_' + name : name).id;
            let px = x, py = y, pz = z;
            const steps = 1 + Math.floor(this.nOre.rand3(wx, y, wz) * size);
            for (let s = 0; s < steps; s++) {
              const dx = Math.round((this.nOre.rand3(px + s * 7, py, pz) - 0.5) * 2);
              const dy = Math.round((this.nOre.rand3(px, py + s * 11, pz) - 0.5) * 2);
              const dz = Math.round((this.nOre.rand3(px, py, pz + s * 13) - 0.5) * 2);
              px = clamp(px + dx, 0, 15); py = clamp(py + dy, 2, 250); pz = clamp(pz + dz, 0, 15);
              const ii = idx(px, py, pz);
              const c2 = blocks[ii];
              if (c2 === BLOCK.get('stone').id || c2 === BLOCK.get('deepslate').id) {
                blocks[ii] = c2 === BLOCK.get('deepslate').id ? BLOCK.get('deepslate_' + name).id : BLOCK.get(name).id;
              }
            }
            break;
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  /**
   * Features are placed from deterministic origins in the 3x3 chunk area and
   * clipped, so every chunk agrees on the shared parts.
   */
  placeFeatures(out, cx, cz, idx) {
    const { blocks, meta } = out;
    const ox = cx * 16, oz = cz * 16;
    const put = (x, y, z, id, m = 0) => {
      if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y >= this.height) return;
      const i = idx(x, y, z);
      if (blocks[i] === 0 || getBlockDef(blocks[i]).replaceable) { blocks[i] = id; meta[i] = m; }
    };
    const set = (x, y, z, id, m = 0) => {
      if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y >= this.height) return;
      const i = idx(x, y, z); blocks[i] = id; meta[i] = m;
    };
    const getAt = (x, y, z) => {
      if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y >= this.height) return 0;
      return blocks[idx(x, y, z)];
    };
    const heightAtLocal = (x, z) => {
      // surface height approximation for feature placement
      const hm = out.heightMap;
      if (x < 0 || x > 15 || z < 0 || z > 15) return SEA_LEVEL;
      return hm[z * 16 + x];
    };

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ccx = cx + dx, ccz = cz + dz;
        const fx0 = ccx * 16, fz0 = ccz * 16;
        const rng = makeRng((ccx * 73856093) ^ (ccz * 19349663) ^ this.seed);

        // ---- trees --------------------------------------------------------
        const biomeCenter = this.biomeAt(fx0 + 8, fz0 + 8);
        if (biomeCenter.trees) {
          const count = Math.max(1, Math.round(biomeCenter.trees.density * 256));
          for (let t = 0; t < count; t++) {
            const tx = fx0 + rng.int(16), tz = fz0 + rng.int(16);
            const lx = tx - ox, lz = tz - oz;
            if (lx < -3 || lx > 18 || lz < -3 || lz > 18) continue;
            let ty = heightAtLocal(clamp(lx, 0, 15), clamp(lz, 0, 15));
            if (ty <= SEA_LEVEL || ty > this.height - 30) continue;
            const ground = getAt(clamp(lx, 0, 15), ty, clamp(lz, 0, 15));
            const groundName = ground ? getBlockDef(ground).name : '';
            if (groundName !== 'grass_block' && groundName !== 'dirt' && groundName !== 'podzol' && groundName !== 'snow_block') continue;
            this.placeTree(out, lx, ty, lz, biomeCenter.trees.type, makeRng((tx * 374761393) ^ (tz * 668265263) ^ this.seed), put, set);
          }
        }

        // ---- plants -------------------------------------------------------
        const plantCount = Math.round(biomeCenter.plants * 220);
        for (let p = 0; p < plantCount; p++) {
          const px = fx0 + rng.int(16), pz = fz0 + rng.int(16);
          const lx = px - ox, lz = pz - oz;
          if (lx < 0 || lx > 15 || lz < 0 || lz > 15) continue;
          const py = heightAtLocal(lx, lz);
          if (py <= SEA_LEVEL) continue;
          const below = getAt(lx, py, lz);
          if (!below || getBlockDef(below).name !== 'grass_block') continue;
          const r = rng();
          if (r < biomeCenter.flowers) {
            const flowers = ['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley'];
            put(lx, py + 1, lz, BLOCK.get(rng.pick(flowers)).id);
          } else {
            put(lx, py + 1, lz, BLOCK.get(rng() < 0.18 ? 'fern' : 'short_grass').id);
          }
        }

        // ---- cactus / sugar cane ------------------------------------------
        if (biomeCenter.name === 'desert' || biomeCenter.name === 'badlands') {
          for (let p = 0; p < 3; p++) {
            const px = fx0 + rng.int(16), pz = fz0 + rng.int(16);
            const lx = px - ox, lz = pz - oz;
            if (lx < 0 || lx > 15 || lz < 0 || lz > 15) continue;
            const py = heightAtLocal(lx, lz);
            if (py <= SEA_LEVEL) continue;
            const below = getAt(lx, py, lz);
            if (!below || getBlockDef(below).name !== 'sand') continue;
            const h = 1 + rng.int(3);
            for (let i = 1; i <= h; i++) put(lx, py + i, lz, BLOCK.get('cactus').id);
          }
        }
        if (rng() < 0.35) {
          const px = fx0 + rng.int(16), pz = fz0 + rng.int(16);
          const lx = px - ox, lz = pz - oz;
          if (lx >= 0 && lx <= 15 && lz >= 0 && lz <= 15) {
            const py = heightAtLocal(lx, lz);
            if (py === SEA_LEVEL || py === SEA_LEVEL + 1) {
              const h = 1 + rng.int(3);
              for (let i = 1; i <= h; i++) put(lx, py + i, lz, BLOCK.get('sugar_cane').id);
            }
          }
        }

        // ---- dungeons -----------------------------------------------------
        if (rng() < 0.012 && dx === 0 && dz === 0) {
          const lx = 3 + rng.int(10), lz = 3 + rng.int(10);
          const ly = 12 + rng.int(50);
          this.placeDungeon(out, lx, ly, lz, makeRng((ccx * 31) ^ (ccz * 17) ^ this.seed), set);
        }

        // ---- villages -----------------------------------------------------
        if (rng() < 0.006 && dx === 0 && dz === 0 && biomeCenter.trees && biomeCenter.name !== 'mushroom_fields') {
          const lx = 2 + rng.int(12), lz = 2 + rng.int(12);
          const ly = heightAtLocal(lx, lz);
          if (ly > SEA_LEVEL + 1) {
            this.placeVillage(out, lx, ly, lz, biomeCenter, makeRng((ccx * 977) ^ (ccz * 613) ^ this.seed), set, put);
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  placeTree(out, x, y, z, type, rng, put, set) {
    const logNames = { oak: 'oak', spruce: 'spruce', birch: 'birch', jungle: 'jungle', acacia: 'acacia', dark_oak: 'dark_oak', swamp: 'oak', mushroom: 'mushroom_stem' };
    const leafNames = { oak: 'oak_leaves', spruce: 'spruce_leaves', birch: 'birch_leaves', jungle: 'jungle_leaves', acacia: 'acacia_leaves', dark_oak: 'dark_oak_leaves', swamp: 'oak_leaves' };
    if (type === 'cactus') return;
    if (type === 'mushroom') {
      const stem = BLOCK.get('mushroom_stem').id;
      const cap = BLOCK.get(rng() < 0.5 ? 'red_mushroom_block' : 'brown_mushroom_block').id;
      const h = 4 + rng.int(4);
      for (let i = 1; i <= h; i++) set(x, y + i, z, stem);
      const r = 2 + rng.int(2);
      for (let dy = -1; dy <= 1; dy++) {
        const rr = dy === 0 ? r + 1 : r;
        for (let dx = -rr; dx <= rr; dx++) for (let dz = -rr; dz <= rr; dz++) {
          if (dx * dx + dz * dz > rr * rr + 1) continue;
          put(x + dx, y + h + dy, z + dz, cap);
        }
      }
      return;
    }
    const wood = logNames[type] || 'oak';
    const log = BLOCK.get(wood + '_log').id;
    const leaves = BLOCK.get(leafNames[type] || 'oak_leaves').id;
    let h = type === 'spruce' ? 6 + rng.int(5) : type === 'birch' ? 5 + rng.int(3) : type === 'jungle' ? 8 + rng.int(8) : type === 'acacia' ? 5 + rng.int(3) : 4 + rng.int(3);
    if (type === 'dark_oak') h = 6 + rng.int(3);

    for (let i = 1; i <= h; i++) set(x, y + i, z, log);

    if (type === 'spruce') {
      let r = 0;
      for (let ly = h; ly >= 2; ly--) {
        if (ly === h) r = 1;
        else if ((h - ly) % 2 === 0) r = Math.min(2 + Math.floor((h - ly) / 3), 3);
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) === r && Math.abs(dz) === r && r > 1 && rng() < 0.6) continue;
          if (dx * dx + dz * dz > r * r + 1) continue;
          put(x + dx, y + ly, z + dz, leaves);
        }
      }
      return;
    }
    // blob canopy
    const cy = y + h;
    const r = type === 'jungle' ? 2.6 : 2.2;
    for (let dy = -2; dy <= 2; dy++) {
      const rr = r - Math.abs(dy) * 0.55;
      for (let dx = -3; dx <= 3; dx++) {
        for (let dz = -3; dz <= 3; dz++) {
          const d = Math.hypot(dx, dz);
          if (d > rr + 0.4) continue;
          if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && dy <= 0) continue;
          put(x + dx, cy + dy, z + dz, leaves);
        }
      }
    }
    if (type === 'acacia') {
      // sprawling canopy
      for (let i = 0; i < 4; i++) {
        const dx = Math.round((rng() - 0.5) * 6), dz = Math.round((rng() - 0.5) * 6);
        put(x + dx, cy + 1, z + dz, leaves);
        put(x + dx, cy + 2, z + dz, leaves);
      }
    }
  }

  // -------------------------------------------------------------------------
  placeDungeon(out, x, y, z, rng, set) {
    const { tileEntities } = out;
    const cobble = BLOCK.get('cobblestone').id;
    const mossy = BLOCK.get('mossy_cobblestone').id;
    const w = 5 + rng.int(4), d = 5 + rng.int(4), h = 4;
    for (let dy = -1; dy <= h; dy++) {
      for (let dx = -1; dx <= w; dx++) {
        for (let dz = -1; dz <= d; dz++) {
          const edge = dx === -1 || dx === w || dz === -1 || dz === d || dy === -1 || dy === h;
          if (!edge) { set(x + dx, y + dy, z + dz, 0); continue; }
          set(x + dx, y + dy, z + dz, rng() < 0.35 ? mossy : cobble);
        }
      }
    }
    // spawner + chests
    set(x + Math.floor(w / 2), y, z + Math.floor(d / 2), BLOCK.get('spawner').id);
    tileEntities.push({ x: x + Math.floor(w / 2), y, z: z + Math.floor(d / 2), type: 'spawner', mob: rng.pick(['zombie', 'skeleton', 'spider']) });
    for (let i = 0; i < 2; i++) {
      if (rng() < 0.75) {
        const cx2 = x + rng.int(w), cz2 = z + rng.int(d);
        set(cx2, y, cz2, BLOCK.get('chest').id, 2);
      }
    }
  }

  // -------------------------------------------------------------------------
  placeVillage(out, x, y, z, biome, rng, set, put) {
    const wood = biome.name === 'desert' ? 'sandstone' : biome.name === 'savanna' ? 'acacia' : biome.name === 'taiga' || biome.name === 'snowy_tundra' ? 'spruce' : 'oak';
    const planks = BLOCK.get(wood === 'sandstone' ? 'sandstone' : wood + '_planks').id;
    const log = BLOCK.get(wood === 'sandstone' ? 'sandstone' : wood + '_log').id;
    const slab = BLOCK.get(wood === 'sandstone' ? 'sandstone_slab' : wood + '_slab').id;
    const glass = BLOCK.get('glass_pane').id;
    const door = BLOCK.get(wood === 'sandstone' ? 'oak_door' : wood + '_door').id;
    const torch = BLOCK.get('torch').id;
    const path = BLOCK.get('grass_path').id;
    const cobble = BLOCK.get('cobblestone').id;

    // flatten a platform
    const R = 12;
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        if (dx * dx + dz * dz > R * R) continue;
        for (let dy = 3; dy >= -6; dy--) {
          const yy = y + dy;
          if (yy < 1) break;
          const cur = out.blocks[(yy * 16 + (z + dz)) * 16 + (x + dx)];
          if (cur === 0 || getBlockDef(cur).replaceable) set(x + dx, yy, z + dz, 0);
          else break;
        }
        set(x + dx, y, z + dz, path);
        set(x + dx, y - 1, z + dz, cobble);
      }
    }

    const house = (hx, hy, hz, w, h, d) => {
      for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < d; dz++) {
        set(hx + dx, hy - 1, hz + dz, planks);
        set(hx + dx, hy + h, hz + dz, slab);
      }
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < d; dz++) {
          const edge = dx === 0 || dx === w - 1 || dz === 0 || dz === d - 1;
          if (!edge) { set(hx + dx, hy + dy, hz + dz, 0); continue; }
          let id = planks;
          if ((dx + dz + dy) % 7 === 0) id = log;
          set(hx + dx, hy + dy, hz + dz, id);
        }
      }
      // windows
      for (let dy = 1; dy < h - 1; dy++) {
        for (let dx = 1; dx < w - 1; dx++) { set(hx + dx, hy + dy, hz, glass); set(hx + dx, hy + dy, hz + d - 1, glass); }
        for (let dz = 1; dz < d - 1; dz++) { set(hx, hy + dy, hz + dz, glass); set(hx + w - 1, hy + dy, hz + dz, glass); }
      }
      // door
      set(hx + (w >> 1), hy, hz, 0);
      set(hx + (w >> 1), hy + 1, hz, 0);
      set(hx + (w >> 1), hy, hz, door, 0);
      set(hx + (w >> 1), hy + 1, hz, door, 8);
      set(hx + (w >> 1) + 1, hy + 2, hz, torch);
    };

    const houses = 4 + rng.int(5);
    for (let i = 0; i < houses; i++) {
      const a = (i / houses) * Math.PI * 2 + rng() * 0.4;
      const r = 4 + rng() * 7;
      const hx = Math.round(x + Math.cos(a) * r) - 2;
      const hz = Math.round(z + Math.sin(a) * r) - 2;
      house(hx, y + 1, hz, 5, 4, 5 + rng.int(3));
    }
    // a well in the middle
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      if (Math.abs(dx) === 2 || Math.abs(dz) === 2) set(x + dx, y + 1, z + dz, cobble);
      else set(x + dx, y, z + dz, BLOCK.get('water').id);
    }
    // lamps
    for (let i = 0; i < 6; i++) {
      const a = rng() * Math.PI * 2, r = rng() * 11;
      const lx = Math.round(x + Math.cos(a) * r), lz = Math.round(z + Math.sin(a) * r);
      set(lx, y + 1, lz, log);
      set(lx, y + 2, lz, log);
      set(lx, y + 3, lz, torch);
    }
  }
}

// ===========================================================================
function pickBiome(h, t, hu, er) {
  const above = h - SEA_LEVEL;
  if (above < -18) return BIOMES[1]; // deep ocean
  if (above < -2) return BIOMES[0];  // ocean
  if (above < 2 && er > -0.1) return BIOMES[2]; // beach
  if (t > 0.78 && hu < 0.3) return above > 30 ? BIOMES[13] : BIOMES[8]; // badlands / desert
  if (t > 0.72 && hu > 0.6) return BIOMES[10]; // jungle
  if (t > 0.68 && hu < 0.45) return BIOMES[9]; // savanna
  if (t < 0.16) return BIOMES[7];              // snowy tundra
  if (t < 0.34) return BIOMES[6];              // taiga
  if (hu > 0.78 && above < 6) return BIOMES[11]; // swamp
  if (above > 60) return BIOMES[12];           // mountains
  if (above > 28) return BIOMES[6];
  if (hu > 0.62) return BIOMES[4];             // forest
  if (hu < 0.35) return BIOMES[3];             // plains
  if (t > 0.6 && hu > 0.55) return BIOMES[15]; // dark forest
  return BIOMES[3];
}

function getBlockDef(id) { return BLOCKS[id] || BLOCKS[0]; }

export default WorldGenerator;
