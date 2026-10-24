/**
 * Ultracraft - procedural texture generator.
 *
 * Every block/item texture is synthesised at load time from maths: no asset
 * downloads, a ~0 byte repository footprint, and the resolution can be changed
 * at runtime (16px "Fast" -> 64px "HD") which is a huge win for low-end
 * devices.  Alongside albedo we bake a tangent-space normal map and a
 * roughness map from the same height field, which is what gives the surfaces
 * their physical, "AAA" shading response.
 *
 * Pure JS: works on the main thread, in workers and in Node (for tests).
 */

import { Noise } from '../core/noise.js';
import { hashString, clamp, lerp, fract } from '../core/math.js';

// ===========================================================================
//  colour helpers
// ===========================================================================
export function rgb(r, g, b) { return [r, g, b]; }
export function hex(h) { return [(h >> 16) & 255, (h >> 8) & 255, h & 255]; }
function mix(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
function shade(c, f) { return [clamp(c[0] * f, 0, 255), clamp(c[1] * f, 0, 255), clamp(c[2] * f, 0, 255)]; }
function add(c, d) { return [clamp(c[0] + d, 0, 255), clamp(c[1] + d, 0, 255), clamp(c[2] + d, 0, 255)]; }

// ===========================================================================
//  canvas
// ===========================================================================
class Tex {
  constructor(size, seed) {
    this.size = size;
    this.n = new Noise(seed);
    this.data = new Uint8ClampedArray(size * size * 4);
    this.height = new Float32Array(size * size);
  }
  px(x, y, r, g, b, a, h) {
    const i = (y * this.size + x);
    const o = i * 4;
    this.data[o] = r; this.data[o + 1] = g; this.data[o + 2] = b; this.data[o + 3] = a === undefined ? 255 : a;
    this.height[i] = h === undefined ? 0.5 : h;
  }
  get(x, y) {
    const i = (y * this.size + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }
  /** Per-texel fbm in tile space (0..1 wraps for seamless tiling). */
  fbm(u, v, scale, oct = 3) {
    // Wrap by sampling a circle in noise space -> seamless tiling.
    const a = u * Math.PI * 2, b = v * Math.PI * 2;
    const s = scale;
    return this.n.fbm3(Math.cos(a) * s / 6.2831, Math.sin(a) * s / 6.2831, Math.cos(b) * s / 6.2831 + Math.sin(b) * s / 6.2831 * 0.5, oct);
  }
  cell(u, v, scale) {
    const a = u * Math.PI * 2, b = v * Math.PI * 2;
    return this.n.cellular3(Math.cos(a) * scale / 6.2831, Math.sin(a) * scale / 6.2831, Math.cos(b) * scale / 6.2831);
  }
}

/** Seamless tiling helper: repeats coordinates on a torus. */
function tileWrap(x, size) { return ((x % size) + size) % size; }

// ===========================================================================
//  primitive recipes
// ===========================================================================
const FN = {};

FN.solid = (t, d) => {
  const c = d.c;
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const u = x / t.size, v = y / t.size;
    const n = t.fbm(u, v, d.scale || 4, d.oct || 3) * (d.amp || 12);
    const g = t.n.rand3(x, y, 7) * (d.grain || 6) - (d.grain || 6) / 2;
    const col = add(c, n + g);
    t.px(x, y, col[0], col[1], col[2], 255, 0.5 + n / 255);
  }
};

FN.rock = (t, d) => {
  const c = d.c;
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const u = x / t.size, v = y / t.size;
    let n = t.fbm(u, v, d.scale || 5, 4) * (d.amp || 16);
    const sp = t.n.rand3(x, y, 3);
    if (sp > 0.985) n += 22; else if (sp < 0.02) n -= 22;
    // blotches
    const blot = t.fbm(u + 0.3, v + 0.7, 2, 2) * 10;
    const col = add(c, n + blot);
    t.px(x, y, col[0], col[1], col[2], 255, 0.5 + (n + blot) / 200);
  }
};

FN.cobble = (t, d) => {
  const base = d.c, mortar = d.mortar || shade(d.c, 0.55);
  const cells = d.cells || 5;
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const u = x / t.size, v = y / t.size;
    const d1 = t.cell(u, v, cells);
    const d2 = t.cell(u + 0.013, v + 0.017, cells);
    const edge = Math.min(d1, d2);
    const r = t.n.rand3(Math.floor(u * cells * 2), Math.floor(v * cells * 2), 11);
    let col = mix(mortar, add(base, (r - 0.5) * 30), clamp(edge * 6, 0, 1));
    const n = t.fbm(u, v, 8, 3) * 10;
    col = add(col, n);
    const h = clamp(edge * 6, 0, 1) * 0.6 + 0.2 + n / 255;
    t.px(x, y, col[0], col[1], col[2], 255, h);
  }
};

FN.bricks = (t, d) => {
  const base = d.c, mortar = d.mortar || [90, 90, 90];
  const rows = d.rows || 4;
  const rh = t.size / rows;
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const row = Math.floor(y / rh);
    const offset = (row % 2) * (t.size / 4);
    const bx = tileWrap(x + offset, t.size / 2);
    const inMortar = (y % rh) < Math.max(1, t.size / 32) || (bx % (t.size / 2)) < Math.max(1, t.size / 32);
    const r = t.n.rand3(Math.floor(bx / 2), row, 5);
    const n = t.fbm(x / t.size, y / t.size, 6, 3) * 12;
    let col = inMortar ? add(mortar, n * 0.4) : add(base, (r - 0.5) * 22 + n);
    t.px(x, y, col[0], col[1], col[2], 255, inMortar ? 0.25 : 0.75 + n / 400);
  }
};

FN.planks = (t, d) => {
  const c = d.c, dark = shade(c, 0.62);
  const planks = d.planks || 4;
  const pw = t.size / planks;
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const p = Math.floor(x / pw);
    const px = x % pw;
    const seam = px < Math.max(1, t.size / 64) || px > pw - Math.max(1, t.size / 64);
    // wood grain running vertically
    const g = t.fbm(x / t.size * 2, (y / t.size) * 0.25 + p * 3.1, 3, 3) * 18;
    const knots = t.n.rand3(p, y >> 1, 9);
    let col = add(c, g + (knots - 0.5) * 12);
    if (seam) col = dark;
    // horizontal butt joints
    if (Math.abs(y - (p % 2) * (t.size * 0.35) - t.size * 0.3) < Math.max(1, t.size / 64)) col = shade(col, 0.8);
    t.px(x, y, col[0], col[1], col[2], 255, seam ? 0.2 : 0.5 + g / 255);
  }
};

FN.log_side = (t, d) => {
  const c = d.c, dark = shade(c, 0.6), light = shade(c, 1.18);
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const u = x / t.size;
    const streak = t.fbm(u * 6, y / t.size * 0.6, 3, 3);
    const v = clamp(0.5 + streak * 0.9, 0, 1);
    let col = v > 0.62 ? mix(c, light, (v - 0.62) * 3) : mix(dark, c, clamp(v * 1.6, 0, 1));
    const n = t.n.rand3(x, y, 13) * 8 - 4;
    col = add(col, n);
    t.px(x, y, col[0], col[1], col[2], 255, 0.5 + streak * 0.35);
  }
};

FN.log_top = (t, d) => {
  const c = d.c, dark = shade(c, 0.55), light = shade(c, 1.15);
  const cx = (t.size - 1) / 2, cy = (t.size - 1) / 2;
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const dx = x - cx, dy = y - cy;
    let r = Math.sqrt(dx * dx + dy * dy) / (t.size * 0.5);
    r += t.fbm(x / t.size, y / t.size, 4, 2) * 0.12;
    const rings = Math.sin(r * 22) * 0.5 + 0.5;
    let col = mix(mix(c, dark, rings), light, Math.pow(rings, 4) * 0.6);
    // bark rim
    if (r > 0.86) col = mix(col, shade(c, 0.6), clamp((r - 0.86) * 7, 0, 1));
    const n = t.n.rand3(x, y, 17) * 6 - 3;
    col = add(col, n);
    t.px(x, y, col[0], col[1], col[2], 255, 0.5 + rings * 0.15);
  }
};

FN.ore = (t, d) => {
  FN.rock(t, { c: d.base || [136, 136, 136], scale: 5, amp: 14 });
  const oc = d.c;
  const blobs = d.blobs || 5;
  const size = t.size;
  for (let b = 0; b < blobs; b++) {
    const bx = t.n.rand3(b, 91, 1) * size;
    const by = t.n.rand3(b, 92, 2) * size;
    const br = (0.10 + t.n.rand3(b, 93, 3) * 0.13) * size;
    for (let y = Math.floor(by - br); y <= by + br; y++) {
      for (let x = Math.floor(bx - br); x <= bx + br; x++) {
        const dx = x - bx, dy = y - by;
        const dist = Math.sqrt(dx * dx + dy * dy) / br;
        if (dist > 1) continue;
        const wob = t.fbm(x / size, y / size, 6, 2) * 0.35;
        if (dist + wob > 1) continue;
        const xx = tileWrap(Math.round(x), size), yy = tileWrap(Math.round(y), size);
        const shadeF = 1 - dist * 0.35;
        const col = add(shade(oc, shadeF), (t.n.rand3(x, y, 21) - 0.5) * 18);
        t.px(xx, yy, col[0], col[1], col[2], 255, 0.72);
      }
    }
  }
};

FN.leaves = (t, d) => {
  const c = d.c;
  const holes = t.size >= 32 && d.holes !== false;
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const u = x / t.size, v = y / t.size;
    const n = t.fbm(u, v, d.scale || 7, 4) * 0.5 + 0.5;
    const sp = t.n.rand3(x, y, 31);
    let col = mix(shade(c, 0.55), shade(c, 1.25), n);
    col = add(col, (sp - 0.5) * 26);
    let a = 255;
    if (holes) {
      const edge = Math.min(Math.min(x, t.size - 1 - x), Math.min(y, t.size - 1 - y)) / (t.size * 0.5);
      if (sp > 0.80 + edge * 0.25) a = 0;
    }
    t.px(x, y, col[0], col[1], col[2], a, 0.5 + n * 0.3);
  }
};

FN.grass_top = (t, d) => {
  const c = d.c;
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const u = x / t.size, v = y / t.size;
    const n = t.fbm(u, v, 6, 4) * 0.5 + 0.5;
    const n2 = t.fbm(u + 0.5, v + 0.25, 14, 2) * 0.5 + 0.5;
    let col = mix(shade(c, 0.72), shade(c, 1.2), n * 0.7 + n2 * 0.3);
    col = add(col, (t.n.rand3(x, y, 41) - 0.5) * 14);
    t.px(x, y, col[0], col[1], col[2], 255, 0.5 + n * 0.35);
  }
};

FN.grass_side = (t, d) => {
  const soil = d.c, top = d.top || [104, 168, 72];
  const depth = Math.max(2, Math.round(t.size * 0.22));
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const u = x / t.size, v = y / t.size;
    const jag = Math.round(t.fbm(u, 0, 8, 2) * t.size * 0.06) + (t.n.rand3(x, 0, 55) < 0.25 ? 1 : 0);
    if (y < depth + jag) {
      const n = t.fbm(u, v, 8, 3) * 0.5 + 0.5;
      let col = mix(shade(top, 0.75), shade(top, 1.2), n);
      if (y === depth + jag) col = shade(col, 0.7);
      t.px(x, y, col[0], col[1], col[2], 255, 0.65 + n * 0.2);
    } else {
      const n = t.fbm(u, v, 5, 3) * 16;
      const sp = t.n.rand3(x, y, 3) * 14 - 7;
      const col = add(soil, n + sp);
      t.px(x, y, col[0], col[1], col[2], 255, 0.45 + n / 200);
    }
  }
};

FN.sand = (t, d) => {
  const c = d.c;
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const n = t.fbm(x / t.size, y / t.size, 10, 2) * 10;
    const sp = (t.n.rand3(x, y, 61) - 0.5) * 26;
    const col = add(c, n + sp);
    t.px(x, y, col[0], col[1], col[2], 255, 0.5 + (n + sp) / 400);
  }
};

FN.gravel = (t, d) => {
  FN.cobble(t, { c: d.c, mortar: shade(d.c, 0.5), cells: 7 });
};

FN.speckle = (t, d) => {
  const c = d.c, s2 = d.speckle || shade(c, 1.3);
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const r = t.n.rand3(x, y, 71);
    const n = t.fbm(x / t.size, y / t.size, 5, 2) * 8;
    const col = add(r > 0.9 ? s2 : c, n + (r - 0.5) * 10);
    t.px(x, y, col[0], col[1], col[2], 255, 0.5 + n / 200);
  }
};

FN.wool = (t, d) => {
  const c = d.c;
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const n = t.fbm(x / t.size, y / t.size, 3, 2) * 8;
    const f = t.n.rand3(x, y, 81) * 14 - 7;
    const col = add(c, n + f);
    t.px(x, y, col[0], col[1], col[2], 255, 0.5 + (n + f) / 220);
  }
};

FN.metal = (t, d) => {
  const c = d.c;
  const border = Math.max(1, t.size / 16);
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const n = t.fbm(x / t.size * 2, y / t.size * 0.4, 3, 2) * 14;
    let col = add(c, n);
    const b = Math.min(x, y, t.size - 1 - x, t.size - 1 - y);
    if (b < border) col = shade(col, 1.22);
    else if (b < border * 2) col = shade(col, 0.86);
    t.px(x, y, col[0], col[1], col[2], 255, b < border ? 0.8 : 0.5 + n / 300);
  }
};

FN.glass = (t, d) => {
  const c = d.c || [220, 240, 255];
  const b = Math.max(1, Math.round(t.size / 16));
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const edge = Math.min(x, y, t.size - 1 - x, t.size - 1 - y);
    const frame = edge < b || (edge < b * 2 && ((x + y) % 4 === 0));
    const col = frame ? shade(c, 1.0) : shade(c, 0.55);
    t.px(x, y, col[0], col[1], col[2], frame ? 235 : 70, frame ? 0.75 : 0.4);
  }
};

FN.liquid = (t, d) => {
  const c = d.c, c2 = d.c2 || shade(c, 1.25);
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const u = x / t.size, v = y / t.size;
    const n = t.fbm(u, v, d.scale || 3, 4);
    const col = mix(c, c2, clamp(n * 0.5 + 0.5, 0, 1));
    t.px(x, y, col[0], col[1], col[2], d.alpha === undefined ? 255 : d.alpha, 0.5);
  }
};

/** Flat "overlay" sprite: mostly transparent, used for redstone / rails. */
FN.sprite = (t, d) => {
  const s = d.shape;
  const c = d.c || [200, 60, 60];
  const c2 = d.c2 || shade(c, 1.4);
  const size = t.size;
  const put = (x, y, col, h) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    t.px(x, y, col[0], col[1], col[2], 255, h === undefined ? 0.6 : h);
  };
  const rect = (x0, y0, w, h, col, hh) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, col, hh);
  };
  const line = (x0, y0, x1, y1, col) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      put(Math.round(lerp(x0, x1, f)), Math.round(lerp(y0, y1, f)), col, 0.7);
    }
  };
  const S = size;
  switch (s) {
    case 'flame': { // fire: bright core, translucent orange tongues
      const c = d.c, c2 = d.c2 || [255, 220, 120], c3 = d.c3 || [190, 45, 12];
      for (let y = 0; y < S; y++) {
        const v = y / S;
        for (let x = 0; x < S; x++) {
          const u = x / S;
          // horizontal wobble narrows towards the top
          const wob = (n.fbm2(u * 4, v * 3 + t * 0.0, 2) - 0.5) * (0.34 * (1 - v * 0.55));
          const cx = Math.abs(u - 0.5 - wob);
          const halfW = 0.40 * (1 - v * 0.75) + 0.03;
          if (cx > halfW) continue;
          const edge = 1 - cx / halfW;
          const heat = clamp(edge * (1.15 - v * 0.75) * (0.75 + 0.5 * n.fbm2(u * 6, v * 5, 2)), 0, 1);
          if (heat < 0.05) continue;
          const col = heat > 0.72 ? mix(c2, c, (1 - heat) / 0.28) : mix(c3, c, heat / 0.72);
          put(x, y, col, clamp(heat * 1.4, 0, 1));
        }
      }
      break;
    }
    case 'cross': { // redstone dot
      const w = Math.max(2, Math.round(S * 0.28));
      rect(Math.round(S / 2 - w / 2), Math.round(S / 2 - w / 2), w, w, c, 0.8);
      rect(Math.round(S / 2 - w / 2) - 1, Math.round(S / 2 - 1), w + 2, 2, c2, 0.9);
      break;
    }
    case 'lever': {
      rect(Math.round(S * 0.32), Math.round(S * 0.3), Math.max(2, S >> 3), Math.round(S * 0.45), [90, 60, 35], 0.8);
      rect(Math.round(S * 0.28), Math.round(S * 0.26), Math.max(3, S >> 2), Math.max(2, S >> 3), [150, 150, 155], 0.9);
      break;
    }
    case 'torch_head': {
      rect(Math.round(S * 0.42), Math.round(S * 0.34), Math.max(2, S / 8), Math.max(2, S / 8), [255, 200, 90], 1);
      break;
    }
    case 'rail': {
      const t2 = Math.max(1, Math.round(S * 0.06));
      rect(0, Math.round(S * 0.34), S, t2, c, 0.9);
      rect(0, Math.round(S * 0.60), S, t2, c, 0.9);
      for (let i = 1; i <= 3; i++) rect(Math.round(S * i / 4) - (t2 >> 1), Math.round(S * 0.34), t2, Math.round(S * 0.31), c2, 0.7);
      break;
    }
    case 'powered_rail': {
      const t2 = Math.max(1, Math.round(S * 0.06));
      rect(0, Math.round(S * 0.34), S, t2, c2, 0.9);
      rect(0, Math.round(S * 0.60), S, t2, c2, 0.9);
      rect(Math.round(S * 0.30), Math.round(S * 0.38), Math.max(2, S / 8), Math.max(2, S / 8), c, 1);
      break;
    }
    case 'detector_rail': {
      const t2 = Math.max(1, Math.round(S * 0.06));
      rect(0, Math.round(S * 0.34), S, t2, c, 0.9);
      rect(0, Math.round(S * 0.60), S, t2, c, 0.9);
      rect(Math.round(S * 0.25), Math.round(S * 0.42), Math.round(S * 0.5), Math.max(2, S / 8), c2, 0.85);
      break;
    }
    case 'activator_rail': {
      const t2 = Math.max(1, Math.round(S * 0.06));
      rect(0, Math.round(S * 0.34), S, t2, c, 0.9);
      rect(0, Math.round(S * 0.60), S, t2, c, 0.9);
      rect(Math.round(S * 0.36), Math.round(S * 0.38), Math.max(2, S / 8), Math.max(2, S / 8), c2, 1);
      break;
    }
    case 'hook': {
      rect(Math.round(S * 0.30), Math.round(S * 0.20), Math.max(2, S / 8), Math.round(S * 0.6), [120, 110, 95], 0.85);
      rect(Math.round(S * 0.20), Math.round(S * 0.30), Math.max(2, S / 6), Math.max(2, S / 10), c, 0.9);
      break;
    }
    case 'tripwire': {
      rect(0, Math.round(S * 0.46), S, Math.max(1, Math.round(S * 0.08)), c, 0.9);
      break;
    }
    case 'rod': {
      rect(Math.round(S * 0.42), 0, Math.max(2, S / 7), Math.round(S * 0.62), c, 0.9);
      rect(Math.round(S * 0.34), Math.round(S * 0.62), Math.max(3, S / 4), Math.max(2, S / 9), shade(c, 1.3), 0.9);
      break;
    }
    default: rect(Math.round(S * 0.25), Math.round(S * 0.25), Math.round(S * 0.5), Math.round(S * 0.5), c, 0.7);
  }
};

/** Cross-shaped plant (alpha-masked quad). */
FN.plant = (t, d) => {
  const size = t.size;
  const c = d.c, c2 = d.c2 || shade(c, 0.75);
  const style = d.style || 'blades';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    t.px(x, y, 0, 0, 0, 0, 0.5);
  }
  const put = (x, y, col, h) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    t.px(x, y, col[0], col[1], col[2], 255, h === undefined ? 0.6 : h);
  };
  if (style === 'blades') {
    const blades = Math.max(4, size / 2);
    for (let b = 0; b < blades; b++) {
      const bx = t.n.rand3(b, 3, 1) * size;
      const lean = (t.n.rand3(b, 4, 2) - 0.5) * size * 0.35;
      const h = size * (0.5 + t.n.rand3(b, 5, 3) * 0.45);
      for (let i = 0; i < h; i++) {
        const yy = size - 1 - i;
        const xx = Math.round(bx + lean * (i / size));
        const col = mix(c2, c, i / h);
        put(xx, yy, col, 0.6);
        if (size >= 32 && i % 3 === 0) put(xx + 1, yy, shade(col, 0.8), 0.55);
      }
    }
  } else if (style === 'flower') {
    const cx = size / 2, cy = size * 0.62;
    // stem
    for (let y = Math.floor(cy); y < size; y++) put(Math.round(cx), y, d.stem || [58, 120, 45], 0.5);
    // petals
    const petals = d.petals || 5;
    for (let p = 0; p < petals; p++) {
      const a = (p / petals) * Math.PI * 2 + 0.4;
      const px = cx + Math.cos(a) * size * 0.16;
      const py = cy + Math.sin(a) * size * 0.16 - size * 0.06;
      const r = size * 0.11;
      for (let y = Math.floor(py - r); y <= py + r; y++)
        for (let x = Math.floor(px - r); x <= px + r; x++) {
          const dd = Math.hypot(x - px, y - py) / r;
          if (dd < 1) put(Math.round(x), Math.round(y), mix(c, shade(c, 1.25), 1 - dd), 0.7);
        }
    }
    for (let y = Math.floor(cy - size * 0.08); y < cy + size * 0.02; y++)
      for (let x = cx - size * 0.06; x < cx + size * 0.06; x++)
        if (Math.hypot(x - cx, y - cy) < size * 0.06) put(Math.round(x), Math.round(y), d.center || [240, 220, 120], 0.85);
  } else if (style === 'sapling') {
    // trunk
    for (let y = Math.floor(size * 0.55); y < size; y++) put(Math.round(size / 2), y, [96, 68, 40], 0.6);
    // canopy blobs
    for (let b = 0; b < 5; b++) {
      const bx = size / 2 + (t.n.rand3(b, 6, 1) - 0.5) * size * 0.5;
      const by = size * (0.2 + t.n.rand3(b, 7, 2) * 0.35);
      const r = size * (0.14 + t.n.rand3(b, 8, 3) * 0.1);
      for (let y = Math.floor(by - r); y <= by + r; y++)
        for (let x = Math.floor(bx - r); x <= bx + r; x++)
          if (Math.hypot(x - bx, y - by) < r) put(Math.round(x), Math.round(y), mix(c2, c, t.n.rand3(x, y, 9)), 0.65);
    }
  } else if (style === 'mushroom') {
    const cx = size / 2;
    for (let y = Math.floor(size * 0.55); y < size; y++) put(Math.round(cx), y, [210, 205, 190], 0.55);
    const cy = size * 0.55, r = size * 0.3;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const dx = (x - cx) / r, dy = (y - cy) / (r * 0.7);
      if (dy < 0 && dx * dx + dy * dy < 1.6) put(x, y, mix(c, shade(c, 0.7), t.n.rand3(x, y, 11)), 0.8);
    }
    if (d.spots) for (let s = 0; s < 6; s++) {
      const sx = cx + (t.n.rand3(s, 12, 1) - 0.5) * r * 1.4;
      const sy = cy - t.n.rand3(s, 13, 2) * r * 0.5;
      for (let y = Math.floor(sy - 1); y <= sy + 1; y++) for (let x = Math.floor(sx - 1); x <= sx + 1; x++)
        put(x, y, [235, 235, 230], 0.85);
    }
  } else if (style === 'crop') {
    const stage = d.stage === undefined ? 1 : d.stage;
    const h = size * (0.25 + 0.1 * stage);
    const cx = size / 2;
    for (let y = Math.floor(size - h); y < size; y++) {
      const w = size * 0.06 * (1 + stage * 0.12);
      for (let x = Math.round(cx - w); x <= cx + w; x++) put(x, y, mix(c2, c, 1 - (size - y) / h), 0.55);
    }
    if (stage >= 5) {
      const fy = size - h - size * 0.06;
      for (let y = Math.floor(fy - size * 0.1); y < fy + size * 0.06; y++)
        for (let x = Math.round(cx - size * 0.1); x < cx + size * 0.1; x++)
          if (Math.hypot(x - cx, y - fy) < size * 0.09) put(x, y, d.fruit || [220, 190, 90], 0.9);
    }
  } else if (style === 'cane') {
    const w = Math.max(1, size / 8);
    for (let y = 0; y < size; y++) {
      const sway = Math.sin(y * 0.4) * size * 0.05;
      for (let x = Math.round(size / 2 - w + sway); x < size / 2 + w + sway; x++) {
        const col = mix(c2, c, ((x + y) % Math.max(2, size / 4)) / (size / 4));
        put(Math.round(x), y, col, 0.6);
      }
      if (y % Math.max(3, Math.round(size / 4)) === 0) {
        for (let x = Math.round(size / 2 - w * 2 + sway); x < size / 2 + w * 2 + sway; x++) put(Math.round(x), y, shade(c, 0.75), 0.5);
      }
    }
  }
};

FN.chest = (t, d) => {
  const c = d.c || [150, 105, 55];
  const size = t.size;
  const b = Math.max(1, Math.round(size / 16));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size * 2, y / size * 0.4, 3, 2) * 12;
    let col = add(c, n);
    const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
    if (edge < b) col = shade(col, 0.6);
    if (y > size * 0.22 && y < size * 0.3) col = shade(col, 0.6);          // lid seam
    if (Math.abs(x - size / 2) < size * 0.09 && y > size * 0.18 && y < size * 0.34) col = [120, 120, 125]; // lock
    if (Math.abs(x - size / 2) < size * 0.04 && y > size * 0.2 && y < size * 0.3) col = [60, 60, 66];
    t.px(x, y, col[0], col[1], col[2], 255, 0.5 + n / 300);
  }
};

FN.furnace_front = (t, d) => {
  const c = d.c || [110, 110, 114];
  FN.solid(t, { c, scale: 6, amp: 10, grain: 8 });
  const size = t.size;
  const x0 = Math.round(size * 0.22), x1 = Math.round(size * 0.78);
  const y0 = Math.round(size * 0.45), y1 = Math.round(size * 0.82);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const edge = Math.min(x - x0, x1 - 1 - x, y - y0, y1 - 1 - y);
    let col = [40, 38, 38];
    if (edge < 1) col = [70, 68, 66];
    if (d.lit && y > y1 - size * 0.12) {
      const f = t.fbm(x / size, y / size, 8, 2);
      col = mix([255, 150, 40], [255, 230, 120], clamp(f * 0.5 + 0.5, 0, 1));
    }
    t.px(x, y, col[0], col[1], col[2], 255, 0.35);
  }
};

FN.crafting_top = (t, d) => {
  const c = d.c || [140, 100, 60];
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size * 2, y / size * 0.5, 3, 2) * 10;
    let col = add(c, n);
    const g = Math.max(1, size / 32);
    const inGrid = (x % (size / 3) < g) || (y % (size / 3) < g);
    if (inGrid) col = shade(col, 0.6);
    // nails
    const nx = x % (size / 3), ny = y % (size / 3);
    if (nx < size / 16 && ny < size / 16) col = [90, 90, 95];
    t.px(x, y, col[0], col[1], col[2], 255, inGrid ? 0.3 : 0.6);
  }
};

FN.crafting_side = (t, d) => {
  const c = d.c || [140, 100, 60];
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size * 2, y / size * 0.4, 3, 2) * 10;
    let col = add(c, n);
    if (y < size * 0.16) col = shade(col, 0.72);
    // tools silhouette
    if (y > size * 0.3 && y < size * 0.7) {
      const u = x / size;
      if (u > 0.2 && u < 0.3 && y > size * 0.35) col = [120, 120, 128];
      if (u > 0.45 && u < 0.62 && ((x + y) % 3 === 0)) col = [120, 120, 128];
      if (u > 0.75 && u < 0.85) col = [120, 120, 128];
    }
    t.px(x, y, col[0], col[1], col[2], 255, 0.5);
  }
};

FN.bookshelf = (t, d) => {
  const size = t.size;
  const wood = [110, 78, 42];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let col = wood;
    const b = Math.max(1, size / 32);
    const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
    if (edge < b) col = shade(wood, 0.55);
    const shelfH = size / 3;
    const shelf = Math.floor(y / shelfH);
    const inShelf = (y % shelfH) > b && (y % shelfH) < shelfH - b;
    if (inShelf && x > b && x < size - b) {
      const bookW = size / 5;
      const bi = Math.floor(x / bookW);
      const inBook = (x % bookW) > b * 0.5 && (x % bookW) < bookW - b * 0.5;
      if (inBook) {
        const r = t.n.rand3(bi, shelf, 23);
        const palette = [[160, 50, 45], [60, 70, 150], [70, 130, 60], [180, 150, 60], [120, 60, 140]];
        col = palette[Math.floor(r * palette.length) % palette.length];
        col = add(col, (t.n.rand3(x, y, 29) - 0.5) * 16);
      }
    }
    t.px(x, y, col[0], col[1], col[2], 255, 0.5);
  }
};

FN.tnt = (t, d) => {
  const size = t.size;
  const c = [180, 55, 45];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size, y / size, 5, 2) * 8;
    let col = add(c, n);
    if (d.band && y > size * 0.4 && y < size * 0.6) col = [230, 230, 230];
    if (d.band && y > size * 0.4 && y < size * 0.6 && ((x % Math.max(4, size / 4)) < size / 8)) col = [60, 60, 62];
    if (d.top) {
      const cx = size / 2, cy = size / 2;
      const rr = Math.hypot(x - cx, y - cy);
      if (rr < size * 0.22) col = [80, 80, 84];
      if (rr < size * 0.1) col = [50, 50, 54];
    }
    t.px(x, y, col[0], col[1], col[2], 255, 0.5);
  }
};

FN.ladder = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) t.px(x, y, 0, 0, 0, 0, 0.5);
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const c = [150, 115, 70];
    t.px(x, y, c[0], c[1], c[2], 255, 0.7);
  };
  const rail = Math.max(1, Math.round(size / 10));
  for (let y = 0; y < size; y++) {
    for (let r = 0; r < rail; r++) { put(r, y); put(size - 1 - r, y); }
  }
  const rungH = Math.max(2, Math.round(size / 5));
  for (let y = rungH; y < size - 1; y += Math.max(4, Math.round(size / 3.2))) {
    for (let k = 0; k < rungH; k++) for (let x = 0; x < size; x++) put(x, y + k);
  }
};

FN.torch_tex = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) t.px(x, y, 0, 0, 0, 0, 0.5);
  const put = (x, y, c, h) => { if (x >= 0 && y >= 0 && x < size && y < size) t.px(x, y, c[0], c[1], c[2], 255, h); };
  const w = Math.max(1, Math.round(size / 8));
  const cx = Math.round(size / 2);
  for (let y = Math.round(size * 0.35); y < size; y++)
    for (let x = cx - w; x <= cx + w; x++) put(x, y, [140, 105, 60], 0.7);
  const flame = d.soul ? [110, 200, 255] : [255, 190, 60];
  for (let y = Math.round(size * 0.1); y < size * 0.4; y++) {
    const f = 1 - (y - size * 0.1) / (size * 0.3);
    const ww = Math.max(1, w * (0.6 + f * 1.6));
    for (let x = Math.round(cx - ww); x <= cx + ww; x++) {
      const c = mix([255, 120, 30], flame, f);
      put(x, y, c, 0.9);
    }
  }
};

FN.door = (t, d) => {
  const size = t.size;
  const c = d.c || [150, 110, 65];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size * 2, y / size * 0.3, 3, 2) * 8;
    let col = add(c, n);
    const b = Math.max(1, size / 32);
    const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
    if (edge < b) col = shade(col, 0.6);
    if (d.top) {
      if (y > size * 0.2 && y < size * 0.75 && x > size * 0.15 && x < size * 0.85) {
        if (Math.abs(x - size * 0.15) < b || Math.abs(x - size * 0.85) < b || Math.abs(y - size * 0.2) < b || Math.abs(y - size * 0.75) < b) col = shade(col, 0.55);
        else col = [90, 95, 100];
      }
    } else {
      if (y > size * 0.15 && y < size * 0.5 && x > size * 0.2 && x < size * 0.8) col = shade(col, 0.75);
    }
    if (d.metal) col = mix(col, [190, 190, 195], 0.75);
    if (Math.abs(x - size * 0.88) < size * 0.06 && (y < size * 0.12 || y > size * 0.85)) col = [200, 190, 100];
    t.px(x, y, col[0], col[1], col[2], 255, 0.5);
  }
};

FN.cobweb = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) t.px(x, y, 0, 0, 0, 0, 0.5);
  const put = (x, y, a) => { if (x >= 0 && y >= 0 && x < size && y < size) { const c = [235, 240, 245]; t.px(x, y, c[0], c[1], c[2], a, 0.6); } };
  const cx = size / 2, cy = size / 2;
  const spokes = 8;
  for (let s = 0; s < spokes; s++) {
    const a = (s / spokes) * Math.PI * 2;
    for (let r = 0; r < size * 0.75; r += 0.5) {
      put(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), 230);
    }
  }
  for (let ring = 1; ring < 5; ring++) {
    const rr = (ring / 5) * size * 0.7;
    for (let s = 0; s < spokes; s++) {
      const a0 = (s / spokes) * Math.PI * 2, a1 = ((s + 1) / spokes) * Math.PI * 2;
      const steps = Math.max(4, Math.round(rr));
      for (let i = 0; i < steps; i++) {
        const a = lerp(a0, a1, i / steps);
        const wob = Math.sin(i * 0.7 + ring) * 1.2;
        put(Math.round(cx + Math.cos(a) * (rr + wob)), Math.round(cy + Math.sin(a) * (rr + wob)), 200);
      }
    }
  }
};

FN.bars = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) t.px(x, y, 0, 0, 0, 0, 0.5);
  const put = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) t.px(x, y, 190, 190, 195, 255, 0.8); };
  const w = Math.max(1, Math.round(size / 12));
  for (let y = 0; y < size; y++) {
    for (let i = 0; i < w; i++) { put(i, y); put(size - 1 - i, y); put(Math.round(size / 2) - Math.floor(w / 2) + i, y); }
  }
  for (let y = 0; y < size; y += Math.max(4, size / 4)) for (let k = 0; k < w; k++) for (let x = 0; x < size; x++) put(x, y + k);
};

FN.scaffold = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) t.px(x, y, 0, 0, 0, 0, 0.5);
  const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < size && y < size) t.px(x, y, c[0], c[1], c[2], 255, 0.7); };
  const c = [180, 160, 80];
  const w = Math.max(1, Math.round(size / 12));
  for (let y = 0; y < size; y++) for (let i = 0; i < w; i++) { put(i, y, c); put(size - 1 - i, y, c); }
  for (let y = Math.round(size * 0.3); y < size * 0.4; y++) for (let x = 0; x < size; x++) put(x, y, c);
  for (let y = Math.round(size * 0.7); y < size * 0.8; y++) for (let x = 0; x < size; x++) put(x, y, c);
};

FN.spawner = (t, d) => {
  const size = t.size;
  const c = [45, 60, 60];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size, y / size, 6, 2) * 10;
    let col = add(c, n);
    const b = Math.max(1, size / 16);
    const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
    const gx = x % Math.max(3, size / 4), gy = y % Math.max(3, size / 4);
    const bar = gx < b || gy < b || edge < b;
    if (!bar) {
      // transparent interior
      const f = t.fbm(x / size * 3, y / size * 3, 4, 2);
      if (f > 0.1) t.px(x, y, 30, 45, 45, 90, 0.4);
      else t.px(x, y, 20, 30, 30, 40, 0.35);
      continue;
    }
    col = add(col, 20);
    t.px(x, y, col[0], col[1], col[2], 255, 0.7);
  }
};

FN.portal = (t, d) => {
  const size = t.size;
  const c = d.c || [120, 40, 200];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const n = t.fbm(u * 2, v * 2, 4, 4);
    const col = mix([10, 5, 20], c, clamp(n * 0.6 + 0.6, 0, 1));
    t.px(x, y, col[0], col[1], col[2], 255, 0.5);
  }
};

FN.end_portal = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = t.n.rand3(x, y, 131);
    const star = r > 0.93;
    const col = star ? [230, 230, 255] : [10, 8, 24];
    t.px(x, y, col[0], col[1], col[2], 255, 0.5);
  }
};

FN.cake = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size, y / size, 6, 2) * 8;
    let col;
    if (d.side) {
      if (y < size * 0.25) col = [250, 250, 250];
      else if (y < size * 0.55) col = [230, 120, 140];
      else col = [200, 150, 100];
    } else if (d.bottom) col = [190, 140, 95];
    else col = [250, 248, 246];
    if (!d.bottom && !d.side && ((x + y) % Math.max(4, size / 4) < size / 12)) col = [220, 60, 70];
    t.px(x, y, ...add(col, n), 255, 0.5);
  }
};

FN.mushroom_block = (t, d) => {
  const c = d.c;
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const u = x / t.size, v = y / t.size;
    const n = t.fbm(u, v, 5, 3) * 0.5 + 0.5;
    const spots = t.cell(u, v, 4) < 0.18;
    let col = mix(shade(c, 0.7), shade(c, 1.15), n);
    if (spots) col = mix(col, d.spot || [235, 230, 220], 0.75);
    t.px(x, y, ...add(col, (t.n.rand3(x, y, 5) - 0.5) * 12), 255, 0.5 + n * 0.2);
  }
};

FN.hay = (t, d) => {
  const size = t.size;
  const c = d.top ? [190, 165, 60] : [175, 150, 55];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const stripe = d.top ? (x % Math.max(2, size / 8) < size / 16) : (y % Math.max(2, size / 8) < size / 16);
    const n = t.fbm(x / size * 3, y / size * 0.4, 3, 2) * 12;
    const col = add(stripe ? shade(c, 0.75) : c, n);
    t.px(x, y, ...col, 255, 0.5 + n / 300);
  }
};

FN.anvil = (t, d) => {
  const size = t.size;
  const c = [70, 72, 78];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let col = add(c, t.fbm(x / size, y / size, 4, 2) * 8);
    const b = Math.max(1, size / 32);
    const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
    if (d.top) {
      if (edge < b) col = shade(col, 0.6);
      if (x > size * 0.28 && x < size * 0.72 && y > size * 0.3 && y < size * 0.7) col = shade(col, 1.2);
    } else {
      if (edge < b) col = shade(col, 0.6);
      if (x > size * 0.3 && x < size * 0.7 && y > size * 0.15 && y < size * 0.5) col = shade(col, 1.15);
    }
    t.px(x, y, ...col, 255, 0.55);
  }
};

FN.enchant = (t, d) => {
  const size = t.size;
  const c = d.c || [30, 25, 40];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size, y / size, 5, 2) * 8;
    let col = add(c, n);
    if (d.top) {
      // glowing glyph ring
      const cx = size / 2, cy = size / 2;
      const r = Math.hypot(x - cx, y - cy) / (size * 0.45);
      const a = Math.atan2(y - cy, x - cx);
      const glyph = Math.sin(a * 8) * 0.5 + 0.5;
      if (r > 0.6 && r < 0.95 && glyph > 0.6) col = add(col, 120);
      if (r < 0.35) col = mix(col, [120, 90, 200], 0.5);
    }
    t.px(x, y, ...col, 255, 0.55);
  }
};

FN.piston = (t, d) => {
  const size = t.size;
  const c = d.c || [130, 125, 120];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size, y / size, 5, 2) * 8;
    let col = add(c, n);
    if (d.top) {
      const b = Math.max(1, size / 16);
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
      if (edge < b) col = shade(col, 0.7);
      if (edge > b && edge < b * 2.5) col = shade(col, 1.15);
      if (d.sticky && Math.hypot(x - size / 2, y - size / 2) < size * 0.22) col = [190, 160, 170];
    } else if (d.bottom) {
      col = [110, 108, 105];
    } else {
      if (y < size * 0.12 || y > size * 0.88) col = shade(col, 0.75);
    }
    t.px(x, y, ...col, 255, 0.5);
  }
};

FN.observer = (t, d) => {
  const size = t.size;
  const c = [110, 108, 112];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size, y / size, 5, 2) * 8;
    let col = add(c, n);
    const cx = size / 2, cy = size / 2;
    const r = Math.hypot(x - cx, y - cy) / (size * 0.3);
    if (r < 1) {
      if (r > 0.55) col = [180, 60, 50];
      else col = [40, 35, 40];
    }
    t.px(x, y, ...col, 255, 0.5);
  }
};

FN.target = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot(x - size / 2, y - size / 2) / (size * 0.5);
    let col;
    if (r > 0.95) col = [160, 160, 165];
    else if (r > 0.7) col = [220, 220, 225];
    else if (r > 0.45) col = [200, 60, 55];
    else if (r > 0.22) col = [220, 220, 225];
    else col = [200, 60, 55];
    col = add(col, (t.n.rand3(x, y, 3) - 0.5) * 12);
    t.px(x, y, ...col, 255, 0.5);
  }
};

FN.chiseled = (t, d) => {
  FN.solid(t, { c: d.c, scale: 5, amp: 8 });
  const size = t.size;
  const c2 = shade(d.c, d.side === 'light' ? 1.25 : 0.6);
  for (let y = Math.round(size * 0.25); y < size * 0.75; y++) {
    const inset = Math.abs(y - size * 0.5) * 0.4;
    for (let x = Math.round(size * 0.3 + inset); x < size * 0.7 - inset; x++) {
      t.px(x, y, c2[0], c2[1], c2[2], 255, 0.8);
    }
  }
};

FN.ice = (t, d) => {
  const c = d.c;
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size, y / size, 4, 3) * 0.5 + 0.5;
    let col = mix(shade(c, 0.85), shade(c, 1.2), n);
    // cracks
    const cr = Math.abs(t.fbm(x / size * 2, y / size * 2, 3, 2));
    if (cr < 0.045) col = shade(col, 1.35);
    t.px(x, y, ...add(col, (t.n.rand3(x, y, 7) - 0.5) * 8), 255, 0.5 + n * 0.2);
  }
};

FN.magma = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const n = t.fbm(u, v, 4, 3) * 0.5 + 0.5;
    const crack = Math.abs(t.fbm(u * 2, v * 2, 3, 2));
    let col;
    if (crack < 0.09) col = mix([255, 130, 30], [255, 240, 120], n);
    else col = mix([60, 35, 32], [95, 55, 45], n);
    t.px(x, y, ...col, 255, crack < 0.09 ? 0.85 : 0.4);
  }
};

FN.glow = (t, d) => {
  const c = d.c;
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const n = t.fbm(x / t.size, y / t.size, 5, 2) * 0.5 + 0.5;
    const s = t.n.rand3(x, y, 17);
    let col = mix(shade(c, 0.7), shade(c, 1.3), n);
    if (s > 0.9) col = shade(col, 1.4);
    t.px(x, y, ...col, 255, 0.5 + n * 0.2);
  }
};

FN.bedrock_fn = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = t.n.rand3(x, y, 191);
    const r2 = t.n.rand3(x >> 1, y >> 1, 193);
    let col;
    if (r > 0.78) col = [30, 30, 34];
    else if (r2 > 0.6) col = [110, 108, 112];
    else col = [65, 65, 70];
    col = add(col, (r - 0.5) * 30);
    t.px(x, y, ...col, 255, 0.3 + r * 0.5);
  }
};

FN.purpur = (t, d) => {
  const c = d.c;
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size, y / size, 5, 2) * 10;
    let col = add(c, n);
    if (d.pillar) {
      if (x % Math.max(4, size / 4) < size / 16) col = shade(col, 0.8);
    } else {
      const g = size / 8;
      if ((x % g < size / 32) || (y % g < size / 32)) col = shade(col, 0.85);
    }
    t.px(x, y, ...col, 255, 0.5);
  }
};

FN.campfire = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size, y / size, 6, 2) * 0.5 + 0.5;
    const log = ((x + y) % Math.max(4, size / 4)) < size / 12;
    let col;
    if (d.top) col = log ? [90, 65, 40] : mix([40, 30, 25], [255, 170, 60], clamp(n * 1.4, 0, 1));
    else col = log ? [90, 65, 40] : [60, 45, 30];
    t.px(x, y, ...add(col, (t.n.rand3(x, y, 3) - 0.5) * 12), 255, 0.5);
  }
};

FN.daylight = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const g = Math.max(1, size / 16);
    const grid = (x % Math.max(3, size / 6) < g) || (y % Math.max(3, size / 6) < g);
    let col = grid ? [90, 95, 105] : [40, 60, 90];
    if (d.top) col = grid ? [120, 125, 135] : [70, 100, 140];
    t.px(x, y, ...add(col, (t.n.rand3(x, y, 5) - 0.5) * 10), 255, grid ? 0.7 : 0.4);
  }
};

FN.beacon = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
    const b = Math.max(1, size / 16);
    let col;
    if (edge < b) col = [120, 120, 130];
    else if (Math.hypot(x - size / 2, y - size / 2) < size * 0.22) col = [235, 240, 200];
    else col = [60, 80, 90];
    t.px(x, y, ...add(col, (t.n.rand3(x, y, 9) - 0.5) * 10), 255, 0.6);
  }
};

FN.brewing = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) t.px(x, y, 0, 0, 0, 0, 0.5);
  const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < size && y < size) t.px(x, y, c[0], c[1], c[2], 255, 0.7); };
  const c = [160, 160, 168];
  const w = Math.max(1, Math.round(size / 10));
  const cx = Math.round(size / 2);
  for (let y = Math.round(size * 0.4); y < size; y++) for (let i = -w; i <= w; i++) put(cx + i, y, c);
  for (let x = Math.round(size * 0.2); x < size * 0.8; x++) for (let k = 0; k < w; k++) put(x, Math.round(size * 0.45) + k, c);
  for (let x = Math.round(size * 0.3); x < size * 0.7; x++) for (let k = 0; k < w; k++) put(x, Math.round(size * 0.72) + k, c);
};

FN.cauldron = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) t.px(x, y, 0, 0, 0, 0, 0.5);
  const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < size && y < size) t.px(x, y, c[0], c[1], c[2], 255, 0.7); };
  const c = [90, 90, 95];
  const w = Math.max(1, Math.round(size / 12));
  for (let y = Math.round(size * 0.25); y < size; y++) {
    for (let i = 0; i < w; i++) { put(i, y, c); put(size - 1 - i, y, c); }
  }
  for (let x = 0; x < size; x++) for (let k = 0; k < w; k++) { put(x, Math.round(size * 0.25) + k, c); put(x, size - 1 - k, c); }
};

FN.skull = (t, d) => {
  const size = t.size;
  const c = d.c || [200, 200, 195];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size, y / size, 5, 2) * 8;
    let col = add(c, n);
    const eyeY = size * 0.45, eyeX1 = size * 0.32, eyeX2 = size * 0.68;
    if (Math.abs(y - eyeY) < size * 0.08 && (Math.abs(x - eyeX1) < size * 0.07 || Math.abs(x - eyeX2) < size * 0.07)) col = d.eye || [20, 20, 25];
    if (Math.abs(x - size / 2) < size * 0.06 && y > size * 0.6 && y < size * 0.8) col = shade(c, 0.7);
    if (y > size * 0.82) col = shade(c, 0.75);
    t.px(x, y, ...col, 255, 0.5 + (Math.abs(y - eyeY) < size * 0.08 ? 0.2 : 0));
  }
};

FN.dragon_egg = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const n = t.fbm(u, v, 4, 3) * 0.5 + 0.5;
    let col = mix([12, 8, 18], [40, 25, 55], n);
    const sp = t.n.rand3(x, y, 37);
    if (sp > 0.9) col = mix(col, [90, 60, 120], 0.7);
    t.px(x, y, ...col, 255, 0.5 + n * 0.3);
  }
};

FN.moss = (t, d) => {
  const c = d.c || [70, 100, 50];
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const u = x / t.size, v = y / t.size;
    const n = t.fbm(u, v, 8, 4) * 0.5 + 0.5;
    const col = mix(shade(c, 0.55), shade(c, 1.35), n);
    t.px(x, y, ...add(col, (t.n.rand3(x, y, 3) - 0.5) * 16), 255, 0.4 + n * 0.35);
  }
};

FN.bamboo_tex = (t, d) => {
  const size = t.size;
  const c = [120, 160, 60];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const seg = y % Math.max(4, Math.round(size / 3));
    const inSeg = seg < Math.max(2, size / 12);
    const col = inSeg ? shade(c, 1.25) : c;
    t.px(x, y, ...add(col, (t.n.rand3(x, y, 3) - 0.5) * 10), 255, inSeg ? 0.7 : 0.45);
  }
};

FN.amethyst = (t, d) => {
  const size = t.size;
  const c = [140, 90, 220];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d1 = t.cell(x / size, y / size, 3);
    const n = t.fbm(x / size, y / size, 4, 2) * 0.5 + 0.5;
    const col = mix(shade(c, 0.6), shade(c, 1.3), clamp(d1 * 3, 0, 1) * 0.6 + n * 0.4);
    t.px(x, y, ...col, 255, 0.5 + d1 * 0.3);
  }
};

FN.slime_tex = (t, d) => {
  const size = t.size;
  const c = [110, 190, 90];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const b = Math.max(1, size / 16);
    const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
    const inner = edge > b * 3;
    const n = t.fbm(x / size, y / size, 3, 2) * 0.5 + 0.5;
    const col = mix(shade(c, 0.7), shade(c, 1.2), n);
    t.px(x, y, ...col, inner ? 140 : 200, 0.6);
  }
};

FN.sugar = (t, d) => FN.plant(t, { c: [140, 200, 90], c2: [90, 150, 60], style: 'cane' });

FN.vine_tex = (t, d) => FN.plant(t, { c: [70, 130, 50], c2: [50, 100, 40], style: 'blades' });

FN.lily = (t, d) => {
  const size = t.size;
  const c = [50, 110, 45];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const cx = size / 2, cy = size / 2;
    const r = Math.hypot(x - cx, y - cy) / (size * 0.48);
    const notch = Math.abs(Math.atan2(y - cy, x - cx)) < 0.25 && r > 0.4;
    if (r < 1 && !notch) {
      const n = t.fbm(x / size, y / size, 6, 2) * 0.5 + 0.5;
      const col = mix(shade(c, 0.75), shade(c, 1.25), n);
      t.px(x, y, ...col, 255, 0.5);
    } else t.px(x, y, 0, 0, 0, 0, 0.5);
  }
};

FN.berry = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) t.px(x, y, 0, 0, 0, 0, 0.5);
  const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < size && y < size) t.px(x, y, c[0], c[1], c[2], 255, 0.6); };
  for (let y = Math.round(size * 0.35); y < size; y++) put(Math.round(size / 2), y, [100, 90, 55]);
  for (let b = 0; b < 8; b++) {
    const bx = size * 0.25 + t.n.rand3(b, 3, 1) * size * 0.5;
    const by = size * (0.25 + t.n.rand3(b, 4, 2) * 0.5);
    for (let y = Math.floor(by - 1); y <= by + 1; y++) for (let x = Math.floor(bx - 1); x <= bx + 1; x++) put(Math.round(x), Math.round(y), [190, 60, 70]);
  }
  for (let i = 0; i < 12; i++) {
    const lx = size * 0.2 + t.n.rand3(i, 5, 3) * size * 0.6;
    const ly = size * 0.3 + t.n.rand3(i, 6, 4) * size * 0.5;
    put(Math.round(lx), Math.round(ly), [80, 130, 55]);
  }
};

FN.netherwart = (t, d) => {
  const size = t.size;
  const stage = d.stage || 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) t.px(x, y, 0, 0, 0, 0, 0.5);
  const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < size && y < size) t.px(x, y, c[0], c[1], c[2], 255, 0.6); };
  const cols = [[110, 40, 50], [140, 55, 60], [175, 70, 70]];
  const c = cols[Math.min(2, stage)];
  const r = size * (0.12 + stage * 0.06);
  const cy = size * (0.7 - stage * 0.06);
  for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = size / 2 - r * 2; x <= size / 2 + r * 2; x++) {
    if (Math.hypot((x - size / 2) / 2, y - cy) < r) put(Math.round(x), Math.round(y), c);
  }
};

FN.soul_sand_tex = (t, d) => {
  const size = t.size;
  const c = d.c;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size, y / size, 6, 3) * 0.5 + 0.5;
    let col = mix(shade(c, 0.65), shade(c, 1.15), n);
    const d1 = t.cell(x / size, y / size, 4);
    if (d1 < 0.12) col = [40, 35, 45];
    t.px(x, y, ...add(col, (t.n.rand3(x, y, 3) - 0.5) * 10), 255, 0.4 + n * 0.3);
  }
};

FN.path = (t, d) => {
  const size = t.size;
  const c = d.top ? [130, 110, 80] : [120, 95, 65];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size, y / size, 5, 3) * 14;
    let col = add(c, n);
    if (!d.top && y < size * 0.18) col = mix(col, [104, 168, 72], 0.7);
    t.px(x, y, ...col, 255, 0.45 + n / 300);
  }
};

FN.farmland_tex = (t, d) => {
  const size = t.size;
  const c = d.wet ? [80, 55, 35] : [120, 90, 60];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const furrow = (y % Math.max(3, size / 5)) < size / 16;
    const n = t.fbm(x / size, y / size, 6, 3) * 12;
    const col = add(furrow ? shade(c, 0.7) : c, n);
    t.px(x, y, ...col, 255, furrow ? 0.3 : 0.55 + n / 300);
  }
};

FN.concrete = (t, d) => {
  const c = d.c;
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const n = t.fbm(x / t.size, y / t.size, 3, 2) * 4;
    t.px(x, y, ...add(c, n), 255, 0.5 + n / 200);
  }
};

FN.terracotta_tex = (t, d) => {
  const c = d.c;
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const n = t.fbm(x / t.size, y / t.size, 5, 2) * 7;
    const sp = (t.n.rand3(x, y, 3) - 0.5) * 8;
    t.px(x, y, ...add(c, n + sp), 255, 0.5 + (n + sp) / 250);
  }
};

FN.copper_tex = (t, d) => {
  const c = d.c || [190, 115, 80];
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const n = t.fbm(x / t.size, y / t.size, 4, 3) * 0.5 + 0.5;
    let col = mix(shade(c, 0.8), shade(c, 1.2), n);
    const b = Math.max(1, t.size / 32);
    const edge = Math.min(x, y, t.size - 1 - x, t.size - 1 - y);
    if (edge < b) col = shade(col, 0.7);
    t.px(x, y, ...col, 255, 0.5 + n * 0.2);
  }
};

FN.nether_bricks_tex = (t, d) => {
  const c = d.c || [70, 40, 45];
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const n = t.fbm(x / t.size, y / t.size, 6, 3) * 0.5 + 0.5;
    const d1 = t.cell(x / t.size, y / t.size, 5);
    let col = mix(shade(c, 0.7), shade(c, 1.2), n);
    if (d1 < 0.08) col = shade(col, 0.55);
    t.px(x, y, ...col, 255, 0.5 + n * 0.2);
  }
};

FN.prismarine_tex = (t, d) => {
  const c = d.c;
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const n = t.fbm(x / t.size, y / t.size, 7, 4) * 0.5 + 0.5;
    let col = mix(shade(c, 0.6), shade(c, 1.35), n);
    if (d.bricks) {
      const g = t.size / 4;
      if ((x % g < t.size / 32) || (y % g < t.size / 32)) col = shade(col, 0.7);
    }
    t.px(x, y, ...col, 255, 0.4 + n * 0.35);
  }
};

FN.log_top_stripped = (t, d) => FN.log_top(t, { c: shade(d.c, 1.35) });
FN.log_side_stripped = (t, d) => FN.log_side(t, { c: shade(d.c, 1.3) });

FN.bed = (t, d) => {
  const size = t.size;
  const c = d.c;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let col = c;
    const n = t.fbm(x / size, y / size, 4, 2) * 6;
    if (y < size * 0.35) {
      // pillow
      const pillow = x > size * 0.1 && x < size * 0.55;
      col = pillow ? [235, 235, 240] : shade(c, 0.8);
    }
    if (y > size * 0.85) col = shade(c, 0.65);
    t.px(x, y, ...add(col, n), 255, 0.5);
  }
};

FN.jukebox = (t, d) => {
  const size = t.size;
  const c = [120, 90, 55];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size * 2, y / size * 0.5, 3, 2) * 10;
    let col = add(c, n);
    if (d.top) {
      if (x > size * 0.2 && x < size * 0.8 && y > size * 0.35 && y < size * 0.5) col = [40, 40, 44];
      if (x > size * 0.28 && x < size * 0.72 && y > size * 0.38 && y < size * 0.47) col = [140, 60, 170];
    } else {
      if (y < size * 0.12) col = shade(col, 0.7);
      if (x > size * 0.15 && x < size * 0.85 && y > size * 0.55 && y < size * 0.7) col = [90, 70, 45];
    }
    t.px(x, y, ...col, 255, 0.5);
  }
};

FN.note = (t, d) => {
  const size = t.size;
  const c = [140, 100, 60];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size * 2, y / size * 0.5, 3, 2) * 8;
    let col = add(c, n);
    const cx = size / 2, cy = size * 0.55;
    const r = Math.hypot(x - cx, y - cy);
    if (r < size * 0.09) col = [40, 40, 45];
    else if (Math.abs(x - cx) < size * 0.03 && y > cy && y < size * 0.85) col = [40, 40, 45];
    else if (r < size * 0.2 && y < cy + size * 0.05 && x > cx) col = [40, 40, 45];
    t.px(x, y, ...col, 255, 0.5);
  }
};

FN.hopper = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) t.px(x, y, 0, 0, 0, 0, 0.5);
  const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < size && y < size) t.px(x, y, c[0], c[1], c[2], 255, 0.7); };
  const c = [80, 80, 86];
  const w = Math.max(1, Math.round(size / 12));
  for (let y = 0; y < size; y++) for (let i = 0; i < w; i++) { put(i, y, c); put(size - 1 - i, y, c); }
  for (let x = 0; x < size; x++) for (let k = 0; k < w; k++) put(x, k, c);
  for (let y = Math.round(size * 0.45); y < size; y++) {
    const inset = Math.round((y - size * 0.45) * 0.6);
    for (let i = 0; i < w; i++) { put(size / 2 - size * 0.25 + inset + i, y, c); put(size / 2 + size * 0.25 - inset - i, y, c); }
  }
};

FN.dispenser = (t, d) => {
  const c = [120, 120, 125];
  for (let y = 0; y < t.size; y++) for (let x = 0; x < t.size; x++) {
    const n = t.fbm(x / t.size, y / t.size, 5, 2) * 10;
    let col = add(c, n);
    if (d.front) {
      const cx = t.size / 2, cy = t.size / 2;
      const r = Math.hypot(x - cx, y - cy);
      if (r < t.size * 0.16) col = [40, 38, 40];
      if (r > t.size * 0.2 && r < t.size * 0.26 && ((x + y) % 4 < 2)) col = [70, 68, 70];
    }
    t.px(x, y, ...col, 255, 0.5);
  }
};

FN.shulker = (t, d) => {
  const size = t.size;
  const c = d.c;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const b = Math.max(1, size / 16);
    const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
    let col = c;
    if (y < size * 0.3) col = shade(c, 1.1);
    if (edge < b) col = shade(col, 0.7);
    if (y > size * 0.42 && y < size * 0.5) col = shade(col, 0.6);
    col = add(col, t.fbm(x / size, y / size, 4, 2) * 6);
    t.px(x, y, ...col, 255, 0.5);
  }
};

FN.endframe = (t, d) => {
  const size = t.size;
  const c = d.top ? [130, 130, 95] : [150, 145, 110];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = t.fbm(x / size, y / size, 5, 2) * 10;
    let col = add(c, n);
    if (d.top) {
      const b = Math.max(1, size / 16);
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
      if (edge < b * 1.5) col = [110, 180, 130];
    }
    t.px(x, y, ...col, 255, 0.5);
  }
};

FN.lantern_tex = (t, d) => {
  const size = t.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) t.px(x, y, 0, 0, 0, 0, 0.5);
  const put = (x, y, c, a) => { if (x >= 0 && y >= 0 && x < size && y < size) t.px(x, y, c[0], c[1], c[2], a === undefined ? 255 : a, 0.8); };
  const w = Math.max(1, Math.round(size / 10));
  const cx = Math.round(size / 2);
  for (let y = Math.round(size * 0.15); y < size; y++) for (let i = -w; i <= w; i++) put(cx + i, y, [150, 150, 158], 255);
  for (let y = Math.round(size * 0.3); y < size * 0.75; y++)
    for (let x = cx - Math.round(size * 0.2); x <= cx + Math.round(size * 0.2); x++) put(x, y, [255, 220, 140], 220);
};

FN.coral = (t, d) => FN.speckle(t, d);

// ===========================================================================
//  the texture table
// ===========================================================================
const G = [128, 128, 128];
const T = {};

function def(name, fn, args) { T[name] = Object.assign({ fn }, args); }

// -- stone ------------------------------------------------------------------
def('stone', 'rock', { c: [136, 136, 138], amp: 14 });
def('cobblestone', 'cobble', { c: [130, 130, 132], mortar: [95, 95, 98], cells: 5 });
def('mossy_cobblestone', 'cobble', { c: [110, 125, 100], mortar: [80, 95, 70], cells: 5 });
def('stone_bricks', 'bricks', { c: [128, 128, 130], mortar: [98, 98, 100], rows: 4 });
def('cracked_stone_bricks', 'bricks', { c: [120, 120, 122], mortar: [90, 90, 92], rows: 4 });
def('mossy_stone_bricks', 'bricks', { c: [112, 125, 105], mortar: [85, 98, 78], rows: 4 });
def('chiseled_stone_bricks', 'chiseled', { c: [128, 128, 130] });
def('smooth_stone', 'solid', { c: [140, 140, 142], scale: 3, amp: 6, grain: 3 });
def('granite', 'speckle', { c: [150, 96, 78], speckle: [190, 130, 110] });
def('polished_granite', 'speckle', { c: [160, 104, 84], speckle: [200, 140, 120] });
def('diorite', 'speckle', { c: [190, 190, 190], speckle: [110, 110, 118] });
def('polished_diorite', 'speckle', { c: [200, 200, 202], speckle: [120, 120, 128] });
def('andesite', 'speckle', { c: [130, 132, 134], speckle: [95, 96, 100] });
def('polished_andesite', 'speckle', { c: [140, 142, 145], speckle: [105, 106, 110] });
def('deepslate', 'rock', { c: [72, 72, 78], amp: 12, scale: 6 });
def('deepslate_top', 'rock', { c: [80, 80, 86], amp: 10, scale: 4 });
def('cobbled_deepslate', 'cobble', { c: [70, 70, 76], mortar: [50, 50, 56], cells: 6 });
def('tuff', 'speckle', { c: [110, 112, 104], speckle: [135, 137, 128] });
def('calcite', 'speckle', { c: [225, 224, 218], speckle: [205, 205, 200] });
def('bedrock', 'bedrock_fn', {});
def('obsidian', 'rock', { c: [22, 16, 36], amp: 16, scale: 4 });
def('netherrack', 'rock', { c: [110, 60, 55], amp: 18, scale: 7 });
def('blackstone', 'rock', { c: [45, 40, 48], amp: 12, scale: 6 });
def('blackstone_top', 'rock', { c: [52, 46, 55], amp: 10, scale: 4 });
def('basalt', 'rock', { c: [75, 75, 80], amp: 8, scale: 3 });
def('basalt_top', 'rock', { c: [80, 80, 86], amp: 6, scale: 2 });
def('magma', 'magma', {});
def('end_stone', 'speckle', { c: [222, 218, 168], speckle: [200, 196, 150] });
def('end_stone_bricks', 'bricks', { c: [215, 210, 162], mortar: [180, 176, 134], rows: 4 });
def('purpur_block', 'purpur', { c: [150, 105, 160] });
def('purpur_pillar', 'purpur', { c: [150, 105, 160], pillar: true });
def('purpur_pillar_top', 'purpur', { c: [155, 110, 165] });
def('nether_bricks', 'nether_bricks_tex', { c: [72, 40, 44] });
def('red_nether_bricks', 'nether_bricks_tex', { c: [110, 40, 45] });
def('quartz_block', 'solid', { c: [232, 226, 218], scale: 3, amp: 5, grain: 3 });
def('chiseled_quartz', 'chiseled', { c: [232, 226, 218] });
def('quartz_pillar', 'solid', { c: [228, 222, 212], scale: 2, amp: 4, grain: 2 });
def('quartz_pillar_top', 'solid', { c: [235, 230, 222], scale: 3, amp: 4, grain: 2 });
def('nether_wart_block', 'rock', { c: [110, 30, 40], amp: 14, scale: 8 });
def('shroomlight', 'glow', { c: [240, 170, 70] });
def('bricks', 'bricks', { c: [158, 92, 72], mortar: [150, 150, 148], rows: 4 });
def('mud_bricks', 'bricks', { c: [110, 88, 66], mortar: [92, 74, 56], rows: 4 });
def('prismarine', 'prismarine_tex', { c: [95, 160, 145] });
def('prismarine_bricks', 'prismarine_tex', { c: [100, 165, 150], bricks: true });
def('dark_prismarine', 'prismarine_tex', { c: [50, 80, 75] });

// -- ores -------------------------------------------------------------------
const ORES = {
  coal_ore: [40, 40, 44], iron_ore: [200, 160, 120], gold_ore: [245, 210, 70],
  diamond_ore: [110, 230, 225], emerald_ore: [60, 210, 100], lapis_ore: [50, 90, 200],
  redstone_ore: [220, 60, 50], copper_ore: [205, 125, 80], nether_quartz_ore: [230, 226, 216],
  nether_gold_ore: [245, 210, 70],
};
for (const [n, c] of Object.entries(ORES)) def(n, 'ore', { base: n.startsWith('nether') ? [110, 60, 55] : [136, 136, 138], c, blobs: 5 });
for (const o of ['coal', 'iron', 'gold', 'diamond', 'emerald', 'lapis', 'redstone', 'copper']) {
  def('deepslate_' + o + '_ore', 'ore', { base: [72, 72, 78], c: ORES[o + '_ore'], blobs: 5 });
}

// -- mineral blocks ---------------------------------------------------------
def('coal_block', 'speckle', { c: [28, 28, 30], speckle: [55, 55, 60] });
def('iron_block', 'metal', { c: [215, 215, 218] });
def('gold_block', 'metal', { c: [245, 205, 70] });
def('diamond_block', 'metal', { c: [130, 235, 230] });
def('emerald_block', 'metal', { c: [70, 220, 110] });
def('lapis_block', 'metal', { c: [50, 95, 205] });
def('redstone_block', 'metal', { c: [200, 45, 40] });
def('copper_block', 'metal', { c: [200, 120, 80] });
def('netherite_block', 'metal', { c: [70, 62, 68] });
def('amethyst_block', 'amethyst', {});
def('slime_block', 'slime_tex', {});
def('cut_copper', 'copper_tex', {});

// -- ground -----------------------------------------------------------------
def('dirt', 'speckle', { c: [134, 96, 67], speckle: [110, 78, 54] });
def('coarse_dirt', 'speckle', { c: [124, 90, 62], speckle: [104, 74, 50] });
def('rooted_dirt', 'speckle', { c: [130, 94, 66], speckle: [100, 72, 48] });
def('podzol_top', 'speckle', { c: [92, 62, 30], speckle: [120, 82, 42] });
def('podzol_side', 'grass_side', { c: [104, 74, 48], top: [92, 62, 30] });
def('mycelium_top', 'moss', { c: [130, 100, 115] });
def('mycelium_side', 'grass_side', { c: [120, 92, 70], top: [130, 100, 115] });
def('grass_top', 'grass_top', { c: [104, 168, 72] });
def('grass_side', 'grass_side', { c: [134, 96, 67], top: [104, 168, 72] });
def('snow', 'speckle', { c: [240, 246, 252], speckle: [220, 230, 240] });
def('sand', 'sand', { c: [222, 208, 160] });
def('red_sand', 'sand', { c: [190, 110, 60] });
def('gravel', 'gravel', { c: [128, 124, 122] });
def('clay', 'speckle', { c: [160, 166, 178], speckle: [145, 150, 162] });
def('sandstone', 'solid', { c: [216, 202, 156], scale: 4, amp: 6, grain: 4 });
def('sandstone_top', 'solid', { c: [220, 208, 162], scale: 3, amp: 4, grain: 3 });
def('red_sandstone', 'solid', { c: [186, 108, 60], scale: 4, amp: 6, grain: 4 });
def('red_sandstone_top', 'solid', { c: [190, 114, 64], scale: 3, amp: 4, grain: 3 });
def('ice', 'ice', { c: [150, 190, 240] });
def('packed_ice', 'ice', { c: [140, 180, 235] });
def('blue_ice', 'ice', { c: [120, 165, 230] });
def('soul_sand', 'soul_sand_tex', { c: [90, 70, 55] });
def('soul_soil', 'soul_sand_tex', { c: [75, 58, 48] });
def('moss_block', 'moss', { c: [72, 105, 50] });
def('grass_path_top', 'path', { top: true });
def('grass_path_side', 'path', { top: false });
def('farmland', 'farmland_tex', { wet: false });
def('sponge', 'speckle', { c: [205, 200, 90], speckle: [190, 185, 80] });
def('wet_sponge', 'speckle', { c: [150, 150, 80], speckle: [135, 135, 70] });
def('cobweb', 'cobweb', {});
def('terracotta', 'terracotta_tex', { c: [160, 100, 78] });

// -- wood -------------------------------------------------------------------
const WOODS = {
  oak: { planks: [172, 138, 86], log: [110, 84, 50], leaves: [70, 130, 55] },
  spruce: { planks: [112, 82, 50], log: [76, 55, 32], leaves: [50, 100, 60] },
  birch: { planks: [205, 195, 160], log: [200, 195, 175], leaves: [130, 175, 90] },
  jungle: { planks: [166, 122, 76], log: [100, 78, 44], leaves: [60, 140, 55] },
  acacia: { planks: [180, 110, 68], log: [110, 82, 60], leaves: [110, 150, 70] },
  dark_oak: { planks: [86, 62, 38], log: [58, 42, 26], leaves: [55, 105, 50] },
  crimson: { planks: [124, 62, 74], log: [106, 52, 70], leaves: [150, 55, 60] },
  warped: { planks: [58, 116, 106], log: [88, 74, 110], leaves: [45, 160, 145] },
};
for (const [w, c] of Object.entries(WOODS)) {
  def(w + '_log', 'log_side', { c: c.log });
  def(w + '_log_top', 'log_top', { c: c.log });
  def('stripped_' + w + '_log', 'log_side_stripped', { c: c.log });
  def('stripped_' + w + '_log_top', 'log_top_stripped', { c: c.log });
  def(w + '_planks', 'planks', { c: c.planks });
  def(w + '_leaves', 'leaves', { c: c.leaves });
  def(w + '_sapling', 'plant', { c: c.leaves, c2: shade(c.leaves, 0.7), style: 'sapling' });
  def(w + '_door', 'door', { c: c.planks, top: false });
  def(w + '_trapdoor', 'planks', { c: c.planks });
}
// doors need a bottom+top texture; the mesher uses `all` for both, so bake a
// combined texture once.
for (const w of Object.keys(WOODS)) {
  def(w + '_door', 'door', { c: WOODS[w].planks, top: false });
}

// -- glass ------------------------------------------------------------------
def('glass', 'glass', { c: [225, 242, 255] });
def('tinted_glass', 'glass', { c: [70, 58, 52] });

// -- plants -----------------------------------------------------------------
def('short_grass', 'plant', { c: [110, 175, 75], c2: [80, 140, 60], style: 'blades' });
def('fern', 'plant', { c: [90, 155, 70], c2: [65, 120, 55], style: 'blades' });
def('dead_bush', 'plant', { c: [140, 110, 60], c2: [110, 85, 45], style: 'blades' });
def('seagrass', 'plant', { c: [70, 160, 90], c2: [50, 130, 70], style: 'blades' });
def('dandelion', 'plant', { c: [245, 220, 70], style: 'flower', petals: 6, center: [230, 190, 60] });
def('poppy', 'plant', { c: [215, 60, 55], style: 'flower', petals: 5, center: [40, 40, 40] });
def('blue_orchid', 'plant', { c: [90, 150, 235], style: 'flower', petals: 5, center: [240, 230, 120] });
def('allium', 'plant', { c: [175, 110, 215], style: 'flower', petals: 6, center: [230, 230, 235] });
def('azure_bluet', 'plant', { c: [235, 235, 240], style: 'flower', petals: 6, center: [240, 210, 80] });
def('red_tulip', 'plant', { c: [210, 70, 70], style: 'flower', petals: 4, center: [80, 80, 60] });
def('orange_tulip', 'plant', { c: [235, 150, 60], style: 'flower', petals: 4, center: [80, 80, 60] });
def('white_tulip', 'plant', { c: [238, 238, 240], style: 'flower', petals: 4, center: [80, 80, 60] });
def('pink_tulip', 'plant', { c: [240, 160, 190], style: 'flower', petals: 4, center: [80, 80, 60] });
def('oxeye_daisy', 'plant', { c: [240, 240, 245], style: 'flower', petals: 7, center: [240, 210, 80] });
def('cornflower', 'plant', { c: [85, 120, 215], style: 'flower', petals: 5, center: [200, 200, 120] });
def('lily_of_the_valley', 'plant', { c: [245, 245, 250], style: 'flower', petals: 3, center: [230, 230, 180] });
def('wither_rose', 'plant', { c: [30, 25, 30], style: 'flower', petals: 5, center: [60, 50, 60] });
def('sunflower', 'plant', { c: [245, 215, 60], style: 'flower', petals: 9, center: [70, 50, 30] });
def('brown_mushroom', 'plant', { c: [150, 110, 70], style: 'mushroom', spots: true });
def('red_mushroom', 'plant', { c: [200, 60, 55], style: 'mushroom', spots: true });
def('mushroom_stem', 'speckle', { c: [205, 200, 185], speckle: [190, 185, 170] });
def('brown_mushroom_block', 'mushroom_block', { c: [140, 100, 65] });
def('red_mushroom_block', 'mushroom_block', { c: [180, 60, 55] });
def('sugar_cane', 'plant', { c: [140, 200, 90], style: 'cane' });
def('cactus_side', 'solid', { c: [80, 130, 55], scale: 3, amp: 6, grain: 4 });
def('cactus_top', 'solid', { c: [95, 145, 65], scale: 3, amp: 5, grain: 4 });
def('vine', 'vine_tex', {});
def('lily_pad', 'lily', {});
def('sweet_berry_bush', 'berry', {});
def('bamboo', 'bamboo_tex', {});
for (let i = 0; i < 3; i++) def('nether_wart' + i, 'netherwart', { stage: i });

// -- crops ------------------------------------------------------------------
for (let i = 0; i < 8; i++) def('wheat' + i, 'plant', { c: [190, 175, 70], c2: [110, 150, 55], style: 'crop', stage: i, fruit: [225, 205, 110] });
for (let i = 0; i < 4; i++) def('carrot' + i, 'plant', { c: [110, 165, 60], c2: [90, 140, 50], style: 'crop', stage: i * 2, fruit: [230, 140, 50] });
for (let i = 0; i < 4; i++) def('potato' + i, 'plant', { c: [110, 165, 60], c2: [90, 140, 50], style: 'crop', stage: i * 2, fruit: [220, 200, 130] });
for (let i = 0; i < 4; i++) def('beetroot' + i, 'plant', { c: [150, 60, 70], c2: [110, 140, 55], style: 'crop', stage: i * 2, fruit: [180, 60, 70] });
def('melon_stem', 'plant', { c: [120, 160, 60], c2: [100, 140, 50], style: 'crop', stage: 7, fruit: [200, 90, 90] });
def('pumpkin_stem', 'plant', { c: [120, 160, 60], c2: [100, 140, 50], style: 'crop', stage: 7, fruit: [220, 140, 50] });

// -- gourds -----------------------------------------------------------------
def('pumpkin_top', 'solid', { c: [200, 130, 40], scale: 3, amp: 6, grain: 5 });
def('pumpkin_side', 'solid', { c: [210, 135, 40], scale: 2, amp: 5, grain: 6 });
def('carved_pumpkin_side', 'solid', { c: [205, 130, 40], scale: 2, amp: 5, grain: 6 });
def('jack_o_lantern_side', 'solid', { c: [205, 130, 40], scale: 2, amp: 5, grain: 6 });
def('pumpkin_face', 'skull', { c: [210, 130, 40], eye: [255, 190, 50] });
def('melon_top', 'solid', { c: [140, 175, 60], scale: 3, amp: 6, grain: 5 });
def('melon_side', 'solid', { c: [110, 150, 50], scale: 2, amp: 6, grain: 6 });
def('hay_block', 'hay', {});
def('hay_block_top', 'hay', { top: true });
def('cake_top', 'cake', {});
def('cake_side', 'cake', { side: true });
def('cake_bottom', 'cake', { bottom: true });

// -- coloured families ------------------------------------------------------
const COLORS = {
  white: [240, 240, 240], orange: [225, 130, 35], magenta: [190, 75, 190], light_blue: [95, 165, 225],
  yellow: [230, 210, 55], lime: [125, 200, 55], pink: [240, 150, 175], gray: [70, 70, 72],
  light_gray: [160, 160, 165], cyan: [55, 155, 165], purple: [135, 75, 195], blue: [60, 85, 190],
  brown: [110, 75, 50], green: [80, 120, 55], red: [175, 60, 55], black: [30, 30, 32],
};
export { COLORS };
for (const [n, c] of Object.entries(COLORS)) {
  def('wool_' + n, 'wool', { c });
  def('concrete_' + n, 'concrete', { c });
  def('concrete_powder_' + n, 'sand', { c });
  def('terracotta_' + n, 'terracotta_tex', { c: mix(c, [160, 100, 78], 0.35) });
  def('glazed_terracotta_' + n, 'terracotta_tex', { c });
  def('glass_' + n, 'glass', { c });
  def('shulker_' + n, 'shulker', { c });
  def('bed_' + n, 'bed', { c });
}

// -- mob faces --------------------------------------------------------------
def('pig_face', 'skull', { c: [242, 186, 190], eye: [40, 45, 40] });
def('cow_face', 'skull', { c: [235, 232, 228], eye: [45, 40, 38] });
def('sheep_face', 'skull', { c: [240, 238, 235], eye: [40, 40, 42] });
def('chicken_face', 'skull', { c: [245, 243, 236], eye: [30, 30, 30] });
def('rabbit_face', 'skull', { c: [200, 180, 160], eye: [180, 60, 60] });
def('wolf_face', 'skull', { c: [165, 162, 168], eye: [240, 200, 60] });
def('cat_face', 'skull', { c: [230, 175, 95], eye: [80, 190, 90] });
def('villager_face', 'skull', { c: [175, 140, 100], eye: [50, 45, 40] });
def('golem_face', 'skull', { c: [205, 198, 186], eye: [120, 200, 90] });
def('spider_face', 'skull', { c: [70, 50, 50], eye: [220, 50, 50] });
def('enderman_face', 'skull', { c: [40, 32, 45], eye: [190, 120, 255] });
def('piglin_face', 'skull', { c: [205, 130, 115], eye: [40, 35, 35] });
def('blaze_face', 'skull', { c: [250, 215, 90], eye: [255, 250, 200] });
def('ghast_face', 'skull', { c: [240, 235, 235], eye: [60, 60, 75] });
def('magma_face', 'skull', { c: [215, 105, 45], eye: [255, 230, 120] });
def('slime_face', 'skull', { c: [120, 200, 100], eye: [40, 60, 40] });
def('bat_face', 'skull', { c: [95, 70, 58], eye: [220, 180, 90] });
def('phantom_face', 'skull', { c: [80, 90, 120], eye: [230, 220, 120] });
def('dragon_face', 'skull', { c: [50, 32, 66], eye: [220, 70, 70] });

// -- redstone / rails --------------------------------------------------------
def('rail', 'sprite', { c: [150, 140, 130], c2: [110, 90, 70], shape: 'rail' });
def('powered_rail', 'sprite', { c: [235, 190, 60], c2: [220, 200, 90], shape: 'powered_rail' });
def('powered_rail_on', 'sprite', { c: [255, 230, 90], c2: [255, 220, 80], shape: 'powered_rail' });
def('detector_rail', 'sprite', { c: [150, 140, 130], c2: [200, 60, 60], shape: 'detector_rail' });
def('activator_rail', 'sprite', { c: [150, 140, 130], c2: [230, 150, 60], shape: 'activator_rail' });
def('tripwire_hook', 'sprite', { c: [190, 185, 175], shape: 'hook' });
def('tripwire', 'sprite', { c: [200, 195, 180], shape: 'tripwire' });
def('lightning_rod', 'sprite', { c: [200, 130, 80], shape: 'rod' });
def('command_block', 'metal', { c: [150, 110, 190] });
def('chain_command_block', 'metal', { c: [120, 170, 190] });
def('repeating_command_block', 'metal', { c: [150, 150, 200] });
def('sculk_sensor', 'rock', { c: [40, 60, 70], scale: 8, amp: 12 });
def('bell_body', 'metal', { c: [215, 190, 90] });

// -- utility ----------------------------------------------------------------
def('crafting_table_top', 'crafting_top', {});
def('crafting_table_side', 'crafting_side', {});
def('crafting_table_front', 'crafting_side', {});
def('furnace_top', 'solid', { c: [110, 110, 114], scale: 4, amp: 8 });
def('furnace_side', 'solid', { c: [104, 104, 108], scale: 5, amp: 9 });
def('furnace_front', 'furnace_front', {});
def('blast_furnace_top', 'solid', { c: [96, 96, 100], scale: 4, amp: 8 });
def('blast_furnace_side', 'solid', { c: [90, 90, 94], scale: 5, amp: 9 });
def('blast_furnace_front', 'furnace_front', { c: [96, 96, 100], lit: true });
def('smoker_top', 'solid', { c: [120, 100, 70], scale: 4, amp: 8 });
def('smoker_side', 'planks', { c: [110, 85, 55] });
def('smoker_front', 'furnace_front', { c: [110, 90, 60], lit: true });
def('chest', 'chest', {});
def('trapped_chest', 'chest', { c: [140, 100, 90] });
def('ender_chest', 'chest', { c: [40, 60, 60] });
def('barrel', 'chest', { c: [130, 95, 55] });
def('jukebox_side', 'jukebox', {});
def('jukebox_top', 'jukebox', { top: true });
def('note_block', 'note', {});
def('enchanting_table_top', 'enchant', { top: true });
def('enchanting_table_side', 'enchant', {});
def('enchanting_table_bottom', 'enchant', {});
def('anvil', 'anvil', {});
def('anvil_top', 'anvil', { top: true });
def('brewing_stand', 'brewing', {});
def('cauldron', 'cauldron', {});
def('beacon', 'beacon', {});
def('hopper', 'hopper', {});
def('dispenser', 'dispenser', {});
def('dispenser_front', 'dispenser', { front: true });
def('dropper', 'dispenser', {});
def('dropper_front', 'dispenser', { front: true });
def('tnt_side', 'tnt', { band: true });
def('tnt_top', 'tnt', { top: true });
def('tnt_bottom', 'tnt', {});
def('ladder', 'ladder', {});
def('torch', 'torch_tex', {});
def('soul_torch', 'torch_tex', { soul: true });
def('redstone_torch', 'torch_tex', {});
def('redstone_lamp', 'solid', { c: [120, 80, 70], scale: 4, amp: 8 });
def('redstone_dust', 'sprite', { shape: 'cross', c: [190, 40, 35] });

// animated-looking flame: a vertical gradient of noisy tongues on transparent black
def('fire', 'flame', { c: [255, 150, 30], c2: [255, 230, 90], c3: [200, 40, 10] });
def('repeater', 'sprite', { shape: 'torch_head', c: [190, 40, 35] });
def('comparator', 'sprite', { shape: 'torch_head', c: [190, 40, 35] });
def('lever', 'sprite', { shape: 'lever' });
def('observer', 'observer', {});
def('target', 'target', {});
def('daylight_detector', 'daylight', {});
def('daylight_detector_top', 'daylight', { top: true });
def('piston_side', 'piston', {});
def('piston_top', 'piston', { top: true });
def('piston_top_sticky', 'piston', { top: true, sticky: true });
def('piston_bottom', 'piston', { bottom: true });
def('iron_bars', 'bars', {});
def('chain', 'bars', {});
def('scaffolding', 'scaffold', {});
def('spawner', 'spawner', {});
def('end_portal_frame', 'endframe', {});
def('end_portal_frame_top', 'endframe', { top: true });
def('dragon_egg', 'dragon_egg', {});
def('skeleton_skull', 'skull', { c: [210, 208, 200] });
def('wither_skull', 'skull', { c: [50, 48, 48], eye: [180, 40, 40] });
def('zombie_head', 'skull', { c: [110, 140, 90], eye: [40, 60, 40] });
def('creeper_head', 'skull', { c: [90, 140, 80], eye: [20, 30, 20] });
def('player_head', 'skull', { c: [200, 165, 130] });
def('iron_door', 'door', { c: [200, 200, 205], metal: true });
def('iron_trapdoor', 'door', { c: [200, 200, 205], metal: true });
def('bookshelf', 'bookshelf', {});
def('sea_lantern', 'glow', { c: [170, 220, 215] });
def('glowstone', 'glow', { c: [225, 185, 105] });
def('lantern', 'lantern_tex', {});
def('campfire', 'campfire', { top: true });

// -- liquids ----------------------------------------------------------------
def('water', 'liquid', { c: [50, 110, 200], c2: [90, 160, 235], alpha: 200, scale: 3 });
def('lava', 'liquid', { c: [200, 90, 25], c2: [255, 200, 60], alpha: 255, scale: 4 });
def('nether_portal', 'portal', { c: [130, 50, 210] });
def('end_portal', 'end_portal', {});

// -- fine-grained roughness / bump defaults ---------------------------------
const ROUGH = {
  water: 0.04, ice: 0.06, packed_ice: 0.1, blue_ice: 0.1, glass: 0.05, obsidian: 0.25,
  gold_block: 0.15, iron_block: 0.3, diamond_block: 0.1, emerald_block: 0.12, lapis_block: 0.35,
  redstone_block: 0.4, netherite_block: 0.3, copper_block: 0.25, cut_copper: 0.3,
  snow: 0.75, slime_block: 0.08, amethyst_block: 0.2, beacon: 0.05, end_portal_frame: 0.6,
};
const BUMP = {
  cobblestone: 1.6, cobbled_deepslate: 1.6, stone_bricks: 1.2, bricks: 1.3, planks: 0.8,
  gravel: 1.8, mossy_cobblestone: 1.6, deepslate: 0.9, netherrack: 1.2, bookshelf: 1.4,
  crafting_table_top: 1.2, furnace_front: 1.0, chest: 1.0, hay_block: 1.5, dirt: 0.8,
};

// ===========================================================================
//  baking
// ===========================================================================
export function bakeTexture(name, size) {
  const d = T[name];
  const t = new Tex(size, hashString(name));
  if (!d) {
    // Unknown texture: generate a loud magenta/black checker so it is obvious.
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const c = ((x >> 2) + (y >> 2)) % 2 ? [255, 0, 255] : [0, 0, 0];
      t.px(x, y, c[0], c[1], c[2], 255, 0.5);
    }
    return { name, tex: t, rough: 0.9, bump: 1.0 };
  }
  const fn = FN[d.fn] || FN.solid;
  fn(t, d);
  return {
    name, tex: t,
    rough: ROUGH[name] !== undefined ? ROUGH[name] : (d.rough !== undefined ? d.rough : 0.85),
    bump: BUMP[name] !== undefined ? BUMP[name] : 1.0,
  };
}

/** Sobel the height field into a tangent-space normal map. */
export function buildNormal(height, size, strength = 2.0) {
  const out = new Uint8Array(size * size * 4);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Full texture set: albedo + normal + roughness packed per layer. */
export function generateBlockTextures(names, size) {
  const out = [];
  for (const name of names) {
    const baked = bakeTexture(name, size);
    const albedo = new Uint8Array(baked.tex.data.buffer.slice(0));
    const normal = buildNormal(baked.tex.height, size, baked.bump);
    for (let i = 3; i < normal.length; i += 4) normal[i] = Math.round(baked.rough * 255);
    out.push({ name, albedo, normal, rough: baked.rough });
  }
  return out;
}

export const TEX_TABLE = T;
