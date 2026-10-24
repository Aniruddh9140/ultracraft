/**
 * Ultracraft - texture atlas manager.
 *
 * Generates every block and item texture procedurally at boot, packs them into
 * TEXTURE_2D_ARRAYs (splitting across arrays when the device's
 * MAX_ARRAY_TEXTURE_LAYERS limit is low), bakes a per-layer material table
 * (tint / emissive / roughness / metalness / specular) and renders one big
 * item-icon atlas for the DOM based UI.
 */

import { generateBlockTextures, bakeTexture, buildNormal, COLORS } from './texturegen.js';
import { generateItemTextures } from './itemgen.js';
import { BLOCKS, BLOCK, Shape } from '../world/blocks.js';
import { ITEMS } from '../world/items.js';
import { Noise } from '../core/noise.js';
import { createTextureArray, uploadLayer, generateArrayMips, createTexture2D, maxArrayLayers, maxAnisotropy } from './gl.js';

export class TextureManager {
  constructor(gl) {
    this.gl = gl;
    this.maxLayers = Math.min(256, maxArrayLayers());
    this.blockArrays = [];
    this.blockMap = new Map();     // texture name -> {arr, layer}
    this.itemArrays = [];
    this.itemMap = new Map();
    this.blockCount = 0;
    this.size = 16;
    this.iconAtlas = null;
    this.iconIndex = new Map();    // item name -> {col, row}
    this.iconAtlasURL = null;
  }

  // -------------------------------------------------------------------------
  build(size = 16, quality = 'fancy') {
    this.size = size;
    this.quality = quality;
    const t0 = performance.now();
    // 1. collect every texture name referenced by a block
    const names = new Set();
    for (const b of BLOCKS) {
      if (!b.tex) continue;
      for (const v of Object.values(b.tex)) names.add(v);
    }
    for (const b of BLOCKS) {
      if (b.stageTex) for (let i = 0; i <= (b.maxAge || 7); i++) names.add(b.stageTex + i);
    }
    const blockNames = [...names];
    const baked = generateBlockTextures(blockNames, size);

    // 2. dispose old GL textures
    for (const a of this.blockArrays) this.gl.deleteTexture(a.tex);
    if (this.blockNormalArrays) for (const a of this.blockNormalArrays) this.gl.deleteTexture(a.tex);
    this.blockArrays = [];
    this.blockNormalArrays = [];
    this.blockMap.clear();
    const perArray = Math.max(1, Math.min(this.maxLayers, blockNames.length));
    const arrayCount = Math.ceil(blockNames.length / this.maxLayers);
    const mips = Math.log2(size) | 0;
    const aniso = quality === 'fast' ? 1 : Math.min(4, maxAnisotropy());

    for (let a = 0; a < arrayCount; a++) {
      const ta = createTextureArray(size, Math.min(this.maxLayers, blockNames.length - a * this.maxLayers), {
        min: quality === 'fast' ? this.gl.NEAREST_MIPMAP_LINEAR : this.gl.NEAREST_MIPMAP_LINEAR,
        mag: quality === 'smooth' ? this.gl.LINEAR : this.gl.NEAREST,
        aniso,
      });
      this.blockArrays.push(ta);
    }
    // second array: normal + roughness
    for (let a = 0; a < arrayCount; a++) {
      const ta = createTextureArray(size, Math.min(this.maxLayers, blockNames.length - a * this.maxLayers), {
        min: this.gl.LINEAR_MIPMAP_LINEAR, mag: this.gl.LINEAR,
      });
      this.blockNormalArrays = this.blockNormalArrays || [];
      this.blockNormalArrays.push(ta);
    }

    for (let i = 0; i < baked.length; i++) {
      const arrIdx = Math.floor(i / this.maxLayers);
      const layer = i % this.maxLayers;
      uploadLayer(this.blockArrays[arrIdx], layer, baked[i].albedo);
      uploadLayer(this.blockNormalArrays[arrIdx], layer, baked[i].normal);
      this.blockMap.set(blockNames[i], { arr: arrIdx, layer });
    }
    for (let a = 0; a < arrayCount; a++) {
      generateArrayMips(this.blockArrays[a]);
      generateArrayMips(this.blockNormalArrays[a]);
    }
    this.blockCount = blockNames.length;

    // 3. per-layer material table
    this.buildMaterialTable(baked, arrayCount);

    // 4. item icons
    this.buildItemIcons(size);

    // 5. resolve block texture lookups
    this.resolveBlockTextures();

    // 6. water normal map
    this.buildWaterNormal(size);

    this.buildTime = performance.now() - t0;
    return this;
  }

  buildMaterialTable(baked, arrayCount) {
    const W = 256, H = Math.max(1, arrayCount * 2);
    const data = new Uint8Array(W * H * 4);
    // default row: neutral
    for (let a = 0; a < arrayCount; a++) {
      for (let x = 0; x < W; x++) {
        const o = ((a * 2) * W + x) * 4;
        data[o] = 255; data[o + 1] = 255; data[o + 2] = 255; data[o + 3] = 0;   // tint + emissive
        const o2 = ((a * 2 + 1) * W + x) * 4;
        data[o2] = 217; data[o2 + 1] = 0; data[o2 + 2] = 30; data[o2 + 3] = 0;  // rough, metal, spec
      }
    }
    // assign from the first block that uses a texture
    const assigned = new Set();
    for (const b of BLOCKS) {
      if (!b.tex) continue;
      const keys = Object.values(b.tex);
      for (const key of keys) {
        const e = this.blockMap.get(key);
        if (!e) continue;
        const id = e.arr * 1000 + e.layer;
        if (assigned.has(id)) continue;
        assigned.add(id);
        const o = ((e.arr * 2) * W + e.layer) * 4;
        data[o] = 255; data[o + 1] = 255; data[o + 2] = 255;
        data[o + 3] = Math.round(clamp01((b.light || 0) / 15) * 255);
        const o2 = ((e.arr * 2 + 1) * W + e.layer) * 4;
        const m = b.mat || {};
        data[o2] = Math.round(clamp01(m.rough !== undefined ? m.rough : 0.85) * 255);
        data[o2 + 1] = Math.round(clamp01(m.metal || 0) * 255);
        data[o2 + 2] = Math.round(clamp01(m.spec !== undefined ? m.spec : 0.12) * 255);
        data[o2 + 3] = 255;
      }
    }
    // texture-specific roughness overrides (bakeTexture knows better)
    for (let i = 0; i < baked.length; i++) {
      const e = this.blockMap.get(baked[i].name);
      if (!e) continue;
      const o2 = ((e.arr * 2 + 1) * W + e.layer) * 4;
      if (data[o2 + 3] !== 255) data[o2] = Math.round(clamp01(baked[i].rough) * 255);
    }
    if (this.materialTex) this.gl.deleteTexture(this.materialTex.tex);
    this.materialTex = createTexture2D(W, H, {
      data, min: this.gl.NEAREST, mag: this.gl.NEAREST, wrap: this.gl.CLAMP_TO_EDGE,
    });
    this.materialRows = H;
  }

  buildItemIcons(size) {
    // icons are drawn bigger then displayed with nearest filtering for crispness
    const iconSize = Math.max(16, Math.min(64, size * 2));
    const names = new Set();
    for (const it of ITEMS) {
      if (!it.tex) continue;
      if (this.blockMap.has(it.tex)) continue;   // reuse the block texture
      names.add(it.tex);
    }
    for (const b of BLOCKS) if (b.tex) for (const v of Object.values(b.tex)) names.delete(v);
    const list = [...names];
    const tinted = (name) => {
      const it = ITEMS.find((i) => i.tex === name && i.tint);
      return it ? it.tint : null;
    };
    const baked = generateItemTextures(list, iconSize, tinted);
    for (const a of this.itemArrays) this.gl.deleteTexture(a.tex);
    this.itemArrays = [];
    this.itemMap.clear();
    const arrayCount = Math.max(1, Math.ceil(list.length / this.maxLayers));
    for (let a = 0; a < arrayCount; a++) {
      this.itemArrays.push(createTextureArray(iconSize, Math.min(this.maxLayers, list.length - a * this.maxLayers), {
        min: this.gl.LINEAR_MIPMAP_LINEAR, mag: this.gl.NEAREST,
      }));
    }
    for (let i = 0; i < list.length; i++) {
      const arrIdx = Math.floor(i / this.maxLayers);
      const layer = i % this.maxLayers;
      uploadLayer(this.itemArrays[arrIdx], layer, baked[i].albedo);
      this.itemMap.set(list[i], { arr: arrIdx, layer });
    }
    for (const a of this.itemArrays) generateArrayMips(a);
    this.buildIconAtlas(iconSize);
  }

  /** One canvas with every icon, used by the HTML/CSS inventory UI. */
  buildIconAtlas(iconSize) {
    const cols = 16;
    const cell = 32;                       // display size in CSS pixels
    const rows = Math.ceil(ITEMS.length / cols) || 1;
    const cv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (!cv) return;
    cv.width = cols * cell; cv.height = rows * cell;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    this.iconAtlas = cv;
    this.iconIndex.clear();
    for (let i = 0; i < ITEMS.length; i++) {
      const it = ITEMS[i];
      const src = this.iconPixels(it, iconSize);
      if (!src) continue;
      const tmp = document.createElement('canvas');
      tmp.width = iconSize; tmp.height = iconSize;
      const tctx = tmp.getContext('2d');
      const img = tctx.createImageData(iconSize, iconSize);
      img.data.set(src);
      tctx.putImageData(img, 0, 0);
      const col = i % cols, row = (i / cols) | 0;
      ctx.drawImage(tmp, col * cell, row * cell, cell, cell);
      this.iconIndex.set(it.name, { col, row, cell });
    }
    try { this.iconAtlasURL = cv.toDataURL('image/png'); } catch (e) { this.iconAtlasURL = null; }
  }

  iconPixels(item, size) {
    const name = item.tex;
    if (!name) return null;
    if (this.itemMap.has(name)) {
      // re-bake on demand (cheap) for the DOM atlas
      const c = this._iconCache || (this._iconCache = new Map());
      let v = c.get(name);
      if (!v) { v = generateItemTextures([name], size, () => item.tint)[0].albedo; c.set(name, v); }
      return v;
    }
    if (this.blockMap.has(name)) {
      const c = this._blockIconCache || (this._blockIconCache = new Map());
      let v = c.get(name);
      if (!v) { v = bakeTexture(name, size).tex.data; c.set(name, v); }
      return v;
    }
    return null;
  }

  buildWaterNormal(size) {
    const S = 128;
    const n = new Noise(1337);
    const h = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S * 2 * Math.PI, v = y / S * 2 * Math.PI;
      // seamless: sample on a torus
      h[y * S + x] = n.fbm3(Math.cos(u) * 1.6, Math.sin(u) * 1.6, Math.cos(v) * 1.6 + Math.sin(v) * 0.8, 4);
    }
    const data = buildNormal(h, S, 2.2);
    if (this.waterNormal) this.gl.deleteTexture(this.waterNormal.tex);
    this.waterNormal = createTexture2D(S, S, {
      data, min: this.gl.LINEAR_MIPMAP_LINEAR, mag: this.gl.LINEAR, wrap: this.gl.REPEAT,
    });
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.waterNormal.tex);
    this.gl.generateMipmap(this.gl.TEXTURE_2D);
  }

  // -------------------------------------------------------------------------
  resolveBlockTextures() {
    for (const b of BLOCKS) {
      if (!b.tex) { b._tex = null; continue; }
      const t = b.tex;
      const all = t.all ? this.blockMap.get(t.all) : null;
      const arr = new Array(6);
      for (let f = 0; f < 6; f++) {
        let key = null;
        if (f === 2) key = t.top || t.all;
        else if (f === 3) key = t.bottom || t.all;
        else key = t.side || t.all;
        arr[f] = this.blockMap.get(key) || all || { arr: 0, layer: 0 };
      }
      b._tex = arr;
      // directional faces
      b._front = t.front ? this.blockMap.get(t.front) : null;
      b._back = t.back ? this.blockMap.get(t.back) : null;
      // growth stages
      if (b.stageTex) {
        b._stages = [];
        const max = b.maxAge || 7;
        for (let m = 0; m <= 15; m++) {
          const idx = Math.min(m, max);
          const e = this.blockMap.get(b.stageTex + idx) || this.blockMap.get(b.stageTex + '0');
          b._stages.push(e || { arr: 0, layer: 0 });
        }
      }
    }
  }

  /** Mesher callback: block id + meta + face -> {arr, layer}. */
  resolver() {
    const self = this;
    return function resolve(id, meta, face, b) {
      const block = b || BLOCKS[id];
      if (block._stages && block.shape === Shape.CROP) return block._stages[meta & 15];
      if (!block._tex) return null;
      // directional textures (furnace / chest / pumpkin ...)
      if (block._front) {
        const facing = meta & 3;               // 0 north 1 east 2 south 3 west
        const frontFace = [5, 0, 4, 1][facing]; // -Z, +X, +Z, -X
        if (face === frontFace) return block._front;
        if (block._back && face === [4, 1, 5, 0][facing]) return block._back;
      }
      return block._tex[face];
    };
  }

  iconFor(item) {
    if (item.tex && this.itemMap.has(item.tex)) return this.itemMap.get(item.tex);
    if (item.tex && this.blockMap.has(item.tex)) return this.blockMap.get(item.tex);
    return { arr: 0, layer: 0 };
  }

  iconCSS(itemName) {
    const e = this.iconIndex.get(itemName);
    if (!e || !this.iconAtlasURL) return null;
    return `url(${this.iconAtlasURL}) -${e.col * e.cell}px -${e.row * e.cell}px`;
  }
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

export default TextureManager;
