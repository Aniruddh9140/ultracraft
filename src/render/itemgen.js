/**
 * Ultracraft - procedural item icons.
 *
 * Icons are drawn with tiny raster primitives at the current texture
 * resolution, so they scale with the "Fast/Fancy/HD" texture setting just like
 * blocks do.  Tools take a material tint override so one shape serves six
 * tool tiers.
 */

import { Noise } from '../core/noise.js';
import { hashString, clamp, lerp } from '../core/math.js';

function shade(c, f) { return [clamp(c[0] * f, 0, 255), clamp(c[1] * f, 0, 255), clamp(c[2] * f, 0, 255)]; }
function mix(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }

class Canvas {
  constructor(size, seed) {
    this.size = size;
    this.n = new Noise(seed);
    this.d = new Uint8ClampedArray(size * size * 4);
  }
  px(x, y, c, a) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = (y * this.size + x) * 4;
    if (a !== undefined && a < 250) {
      const t = a / 255;
      this.d[i] = this.d[i] * (1 - t) + c[0] * t;
      this.d[i + 1] = this.d[i + 1] * (1 - t) + c[1] * t;
      this.d[i + 2] = this.d[i + 2] * (1 - t) + c[2] * t;
      this.d[i + 3] = Math.max(this.d[i + 3], a);
    } else {
      this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; this.d[i + 3] = 255;
    }
  }
  rect(x, y, w, h, c, a) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c, a); }
  line(x0, y0, x1, y1, c, w = 1) {
    const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2) + 1;
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const x = lerp(x0, x1, f), y = lerp(y0, y1, f);
      for (let a = 0; a < w; a++) for (let b = 0; b < w; b++) this.px(x + a - (w >> 1), y + b - (w >> 1), c);
    }
  }
  circle(cx, cy, r, c, a) {
    for (let y = Math.floor(cy - r); y <= cy + r; y++)
      for (let x = Math.floor(cx - r); x <= cx + r; x++)
        if (Math.hypot(x - cx, y - cy) <= r) this.px(x, y, c, a);
  }
  ellipse(cx, cy, rx, ry, c, a) {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++)
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.px(x, y, c, a);
      }
  }
  poly(pts, c) {
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
          xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2)
        for (let x = Math.round(xs[i]); x <= Math.round(xs[i + 1]); x++) this.px(x, y, c);
    }
  }
  outline(c, w = 1) {
    const s = this.size;
    for (let i = 0; i < s; i++) for (let k = 0; k < w; k++) {
      this.px(i, k, c); this.px(i, s - 1 - k, c); this.px(k, i, c); this.px(s - 1 - k, i, c);
    }
  }
}

// ===========================================================================
//  shapes
// ===========================================================================
const S = {};

S.gem = (v, d) => {
  const s = v.size, c = d.c;
  const cx = s / 2, cy = s * 0.55;
  v.poly([[cx, s * 0.1], [s * 0.9, cy], [cx, s * 0.9], [s * 0.1, cy]], c);
  v.poly([[cx, s * 0.1], [s * 0.62, cy], [cx, s * 0.9], [s * 0.38, cy]], shade(c, 1.25));
  v.poly([[cx, s * 0.1], [s * 0.62, cy], [cx, cy]], shade(c, 1.45));
};

S.ingot = (v, d) => {
  const s = v.size, c = d.c;
  const w = s * 0.62, h = s * 0.3;
  const x = (s - w) / 2, y = s * 0.55;
  v.rect(x, y, w, h, c);
  v.rect(x, y, w, Math.max(1, s * 0.06), shade(c, 1.3));
  v.rect(x, y + h - Math.max(1, s * 0.06), w, Math.max(1, s * 0.06), shade(c, 0.7));
  for (let i = 0; i < s * 0.1; i++) v.rect(x + w * 0.1, y - i * 0.2, w * 0.8, 1, shade(c, 0.9));
};

S.nugget = (v, d) => {
  const s = v.size, c = d.c;
  v.circle(s / 2, s * 0.6, s * 0.22, c);
  v.circle(s / 2 - s * 0.05, s * 0.55, s * 0.1, shade(c, 1.3));
};

S.dust = (v, d) => {
  const s = v.size, c = d.c;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const n = v.n.fbm2(x / s * 4, y / s * 4, 3) * 0.5 + 0.5;
    const r = Math.hypot(x - s / 2, y - s * 0.62) / (s * 0.32);
    if (r + n * 0.6 < 1.05) v.px(x, y, mix(shade(c, 0.7), shade(c, 1.3), n));
  }
};

S.blob = (v, d) => {
  const s = v.size, c = d.c;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const n = v.n.fbm2(x / s * 3, y / s * 3, 2) * 0.25;
    if (Math.hypot((x - s / 2) / (s * 0.34 + n * s), (y - s * 0.56) / (s * 0.3 + n * s)) < 1) {
      const shadeF = 1 - (y - s * 0.26) / s;
      v.px(x, y, mix(shade(c, 0.65), shade(c, 1.25), clamp(shadeF * 1.2, 0, 1)));
    }
  }
};

S.ball = (v, d) => {
  const s = v.size, c = d.c;
  v.circle(s / 2, s * 0.58, s * 0.26, c);
  v.circle(s / 2 - s * 0.07, s * 0.48, s * 0.09, shade(c, 1.35));
  v.circle(s / 2, s * 0.58 + s * 0.2, s * 0.12, shade(c, 0.75));
};

S.stick = (v, d) => {
  const s = v.size, c = d.c || [150, 115, 70];
  v.line(s * 0.32, s * 0.82, s * 0.75, s * 0.2, c, Math.max(1, s * 0.09));
  v.line(s * 0.32, s * 0.82, s * 0.75, s * 0.2, shade(c, 1.2), Math.max(1, s * 0.03));
};

S.rod = (v, d) => {
  const s = v.size, c = d.c;
  v.line(s * 0.35, s * 0.85, s * 0.72, s * 0.18, c, Math.max(1, s * 0.11));
  for (let i = 0; i < 4; i++) {
    const t = i / 4;
    v.px(s * (0.35 + 0.37 * t) - s * 0.06, s * (0.85 - 0.67 * t), shade(c, 1.4));
  }
};

S.bone = (v, d) => {
  const s = v.size, c = d.c || [235, 232, 215];
  v.line(s * 0.3, s * 0.72, s * 0.75, s * 0.28, c, Math.max(2, s * 0.11));
  v.circle(s * 0.28, s * 0.74, s * 0.1, c); v.circle(s * 0.24, s * 0.66, s * 0.08, c);
  v.circle(s * 0.77, s * 0.26, s * 0.1, c); v.circle(s * 0.73, s * 0.18, s * 0.08, c);
};

S.feather = (v, d) => {
  const s = v.size, c = d.c || [240, 240, 245];
  v.line(s * 0.3, s * 0.85, s * 0.7, s * 0.2, [200, 200, 210], Math.max(1, s * 0.05));
  for (let i = 0; i < 8; i++) {
    const t = i / 8;
    const x = lerp(s * 0.34, s * 0.68, t), y = lerp(s * 0.8, s * 0.24, t);
    const len = s * (0.12 - Math.abs(t - 0.45) * 0.1);
    v.line(x, y, x - len, y + len * 0.4, c, Math.max(1, s * 0.035));
    v.line(x, y, x + len, y + len * 0.4, shade(c, 0.85), Math.max(1, s * 0.035));
  }
};

S.sheet = (v, d) => {
  const s = v.size, c = d.c || [240, 240, 240];
  v.rect(s * 0.22, s * 0.22, s * 0.56, s * 0.56, c);
  v.rect(s * 0.22, s * 0.22, s * 0.56, Math.max(1, s * 0.05), shade(c, 0.85));
  v.rect(s * 0.22, s * 0.72, s * 0.56, Math.max(1, s * 0.05), shade(c, 0.85));
  if (d.lines) for (let i = 1; i < 5; i++) v.rect(s * 0.28, s * (0.3 + i * 0.1), s * 0.44, Math.max(1, s * 0.03), shade(c, 0.7));
};

S.book = (v, d) => {
  const s = v.size;
  v.rect(s * 0.14, s * 0.16, s * 0.72, s * 0.66, d.c || [150, 60, 55]);
  v.rect(s * 0.2, s * 0.22, s * 0.6, s * 0.54, [235, 230, 215]);
  v.rect(s * 0.14, s * 0.16, s * 0.1, s * 0.66, shade(d.c || [150, 60, 55], 0.7));
  for (let i = 0; i < 4; i++) v.rect(s * 0.26, s * (0.3 + i * 0.11), s * 0.44, Math.max(1, s * 0.03), [170, 165, 155]);
};

S.bowl = (v, d) => {
  const s = v.size, c = d.c || [190, 150, 100];
  v.ellipse(s / 2, s * 0.55, s * 0.34, s * 0.22, c);
  v.ellipse(s / 2, s * 0.5, s * 0.3, s * 0.17, d.liquid || [120, 80, 50]);
  v.ellipse(s / 2 - s * 0.08, s * 0.48, s * 0.1, s * 0.05, shade(d.liquid || [120, 80, 50], 1.3));
};

S.bucket = (v, d) => {
  const s = v.size, c = d.c || [190, 190, 195];
  v.poly([[s * 0.24, s * 0.28], [s * 0.76, s * 0.28], [s * 0.66, s * 0.82], [s * 0.34, s * 0.82]], c);
  v.poly([[s * 0.28, s * 0.32], [s * 0.72, s * 0.32], [s * 0.63, s * 0.78], [s * 0.37, s * 0.78]], d.liquid || shade(c, 0.6));
  v.rect(s * 0.22, s * 0.24, s * 0.56, Math.max(1, s * 0.06), shade(c, 1.25));
  v.line(s * 0.3, s * 0.24, s * 0.7, s * 0.24, shade(c, 0.7), Math.max(1, s * 0.04));
};

S.potion = (v, d) => {
  const s = v.size;
  v.rect(s * 0.28, s * 0.14, s * 0.1, s * 0.2, [150, 150, 155]);
  v.rect(s * 0.3, s * 0.32, s * 0.4, s * 0.12, [190, 190, 195]);
  v.poly([[s * 0.34, s * 0.42], [s * 0.66, s * 0.42], [s * 0.74, s * 0.86], [s * 0.26, s * 0.86]], [210, 215, 225]);
  v.poly([[s * 0.38, s * 0.5], [s * 0.62, s * 0.5], [s * 0.68, s * 0.82], [s * 0.32, s * 0.82]], d.c || [90, 130, 190]);
  v.px(s * 0.42, s * 0.58, shade(d.c || [90, 130, 190], 1.4));
  v.px(s * 0.44, s * 0.62, shade(d.c || [90, 130, 190], 1.3));
};

S.food = (v, d) => {
  const s = v.size, c = d.c;
  const shape = d.shape || 'generic';
  if (shape === 'bread') {
    v.ellipse(s / 2, s * 0.58, s * 0.36, s * 0.24, c);
    v.ellipse(s / 2, s * 0.52, s * 0.32, s * 0.18, shade(c, 1.15));
    for (let i = 0; i < 4; i++) v.line(s * (0.3 + i * 0.14), s * 0.42, s * (0.26 + i * 0.14), s * 0.5, shade(c, 1.35), 1);
  } else if (shape === 'meat') {
    v.ellipse(s / 2, s * 0.58, s * 0.32, s * 0.24, c);
    v.ellipse(s * 0.44, s * 0.52, s * 0.16, s * 0.1, shade(c, 1.25));
    if (d.cooked) v.ellipse(s / 2, s * 0.58, s * 0.22, s * 0.15, shade(c, 0.8));
  } else if (shape === 'fish') {
    v.ellipse(s * 0.55, s * 0.56, s * 0.28, s * 0.15, c);
    v.poly([[s * 0.82, s * 0.56], [s * 0.95, s * 0.42], [s * 0.95, s * 0.7]], c);
    v.px(s * 0.36, s * 0.52, [20, 20, 25]);
  } else if (shape === 'veg') {
    v.ellipse(s / 2, s * 0.6, s * 0.16, s * 0.3, c);
    v.rect(s * 0.46, s * 0.12, s * 0.08, s * 0.16, [90, 150, 60]);
    v.ellipse(s * 0.44, s * 0.55, s * 0.05, s * 0.12, shade(c, 1.2));
  } else if (shape === 'round') {
    v.circle(s / 2, s * 0.55, s * 0.26, c);
    v.circle(s * 0.42, s * 0.46, s * 0.08, shade(c, 1.3));
    v.rect(s * 0.48, s * 0.22, s * 0.05, s * 0.14, [90, 150, 60]);
  } else if (shape === 'cookie') {
    v.circle(s / 2, s * 0.55, s * 0.28, c);
    for (let i = 0; i < 5; i++) {
      const a = i * 1.9;
      v.circle(s / 2 + Math.cos(a) * s * 0.15, s * 0.55 + Math.sin(a) * s * 0.15, s * 0.055, [50, 30, 20]);
    }
  } else if (shape === 'pie') {
    v.ellipse(s / 2, s * 0.6, s * 0.34, s * 0.2, [220, 180, 110]);
    v.ellipse(s / 2, s * 0.55, s * 0.3, s * 0.15, [230, 150, 70]);
  } else if (shape === 'slice') {
    v.poly([[s * 0.2, s * 0.75], [s * 0.8, s * 0.75], [s * 0.62, s * 0.3], [s * 0.38, s * 0.3]], c);
    v.poly([[s * 0.28, s * 0.7], [s * 0.72, s * 0.7], [s * 0.6, s * 0.36], [s * 0.4, s * 0.36]], shade(c, 1.2));
  } else {
    v.ellipse(s / 2, s * 0.56, s * 0.3, s * 0.22, c);
    v.ellipse(s * 0.44, s * 0.5, s * 0.12, s * 0.08, shade(c, 1.25));
  }
};

S.tool = (v, d) => {
  const s = v.size;
  const head = d.c, handle = [150, 112, 62];
  const w = Math.max(1, s * 0.08);
  const kind = d.kind;
  // handle always bottom-left to top-right
  v.line(s * 0.3, s * 0.86, s * 0.72, s * 0.24, handle, w);
  v.line(s * 0.3, s * 0.86, s * 0.72, s * 0.24, shade(handle, 0.8), Math.max(1, w * 0.35));
  const hx = s * 0.74, hy = s * 0.22;
  switch (kind) {
    case 'pickaxe':
      v.line(hx - s * 0.26, hy + s * 0.08, hx + s * 0.2, hy - s * 0.13, head, Math.max(2, s * 0.1));
      v.line(hx - s * 0.22, hy - s * 0.02, hx + s * 0.16, hy - s * 0.22, head, Math.max(1, s * 0.06));
      break;
    case 'axe':
      v.poly([[hx - s * 0.16, hy - s * 0.06], [hx + s * 0.16, hy - s * 0.24], [hx + s * 0.26, hy - s * 0.06], [hx + s * 0.06, hy + s * 0.1]], head);
      v.poly([[hx + s * 0.06, hy - s * 0.1], [hx + s * 0.18, hy - s * 0.18], [hx + s * 0.22, hy - s * 0.08]], shade(head, 1.25));
      break;
    case 'shovel':
      v.poly([[hx - s * 0.12, hy + s * 0.02], [hx + s * 0.12, hy - s * 0.16], [hx + s * 0.22, hy - s * 0.06], [hx + s * 0.02, hy + s * 0.12]], head);
      break;
    case 'hoe':
      v.line(hx - s * 0.2, hy + s * 0.1, hx + s * 0.2, hy - s * 0.1, head, Math.max(2, s * 0.08));
      v.line(hx - s * 0.1, hy - s * 0.06, hx + s * 0.06, hy - s * 0.14, head, Math.max(1, s * 0.06));
      break;
    case 'sword':
      v.line(s * 0.3, s * 0.84, s * 0.62, s * 0.36, handle, w);
      v.line(s * 0.28, s * 0.72, s * 0.78, s * 0.06, head, Math.max(2, s * 0.09));
      v.line(s * 0.24, s * 0.68, s * 0.58, s * 0.3, head, Math.max(1, s * 0.05));
      v.line(s * 0.5, s * 0.44, s * 0.72, s * 0.5, shade(head, 0.6), Math.max(2, s * 0.1));
      break;
    case 'shears':
      v.line(s * 0.24, s * 0.2, s * 0.76, s * 0.7, [190, 190, 195], Math.max(2, s * 0.07));
      v.line(s * 0.76, s * 0.2, s * 0.24, s * 0.7, [190, 190, 195], Math.max(2, s * 0.07));
      v.circle(s * 0.24, s * 0.8, s * 0.08, [180, 150, 60]);
      v.circle(s * 0.76, s * 0.8, s * 0.08, [180, 150, 60]);
      break;
    case 'bow':
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        const a = -1.1 + t * 2.2;
        v.px(s * (0.5 + Math.sin(a) * 0.34), s * (0.5 - Math.cos(a) * 0.36), [150, 112, 62]);
      }
      v.line(s * 0.5 + Math.sin(-1.1) * s * 0.34, s * 0.5 - Math.cos(-1.1) * s * 0.36,
        s * 0.5 + Math.sin(1.1) * s * 0.34, s * 0.5 - Math.cos(1.1) * s * 0.36, [230, 230, 235], 1);
      break;
    case 'shield':
      v.poly([[s * 0.28, s * 0.16], [s * 0.72, s * 0.16], [s * 0.72, s * 0.55], [s * 0.5, s * 0.84], [s * 0.28, s * 0.55]], d.c || [170, 130, 80]);
      v.rect(s * 0.44, s * 0.2, s * 0.12, s * 0.5, [200, 200, 205]);
      v.rect(s * 0.32, s * 0.36, s * 0.36, s * 0.08, [200, 200, 205]);
      break;
    case 'fishing_rod':
      v.line(s * 0.24, s * 0.9, s * 0.78, s * 0.14, [130, 100, 60], Math.max(1, s * 0.06));
      v.line(s * 0.78, s * 0.14, s * 0.86, s * 0.5, [220, 220, 225], 1);
      v.circle(s * 0.86, s * 0.56, s * 0.05, [220, 100, 100]);
      break;
    case 'flint_and_steel':
      v.rect(s * 0.2, s * 0.4, s * 0.32, s * 0.28, [120, 120, 128]);
      v.circle(s * 0.68, s * 0.55, s * 0.16, [90, 90, 95]);
      v.circle(s * 0.62, s * 0.48, s * 0.06, [255, 200, 90]);
      break;
    case 'trident':
      v.line(s * 0.5, s * 0.86, s * 0.5, s * 0.18, [150, 112, 62], Math.max(2, s * 0.07));
      v.line(s * 0.5, s * 0.24, s * 0.5, s * 0.08, d.c, Math.max(2, s * 0.08));
      v.line(s * 0.36, s * 0.3, s * 0.36, s * 0.14, d.c, Math.max(1, s * 0.05));
      v.line(s * 0.64, s * 0.3, s * 0.64, s * 0.14, d.c, Math.max(1, s * 0.05));
      v.line(s * 0.36, s * 0.32, s * 0.64, s * 0.32, d.c, Math.max(1, s * 0.05));
      break;
    case 'carrot_on_a_stick':
      v.line(s * 0.3, s * 0.88, s * 0.6, s * 0.45, [150, 112, 62], Math.max(1, s * 0.05));
      v.ellipse(s * 0.68, s * 0.32, s * 0.14, s * 0.18, [230, 140, 50]);
      v.line(s * 0.68, s * 0.16, s * 0.68, s * 0.08, [90, 150, 60], Math.max(1, s * 0.05));
      break;
    default:
      v.circle(s / 2, s / 2, s * 0.25, head);
  }
};

S.armor = (v, d) => {
  const s = v.size, c = d.c;
  const hi = shade(c, 1.3), lo = shade(c, 0.7);
  switch (d.slot) {
    case 'helmet':
      v.poly([[s * 0.24, s * 0.62], [s * 0.24, s * 0.32], [s * 0.5, s * 0.18], [s * 0.76, s * 0.32], [s * 0.76, s * 0.62]], c);
      v.rect(s * 0.24, s * 0.5, s * 0.52, s * 0.14, lo);
      v.rect(s * 0.38, s * 0.54, s * 0.24, s * 0.06, [40, 40, 45]);
      v.line(s * 0.24, s * 0.34, s * 0.76, s * 0.34, hi, 1);
      break;
    case 'chestplate':
      v.poly([[s * 0.2, s * 0.28], [s * 0.5, s * 0.2], [s * 0.8, s * 0.28], [s * 0.74, s * 0.78], [s * 0.5, s * 0.84], [s * 0.26, s * 0.78]], c);
      v.rect(s * 0.44, s * 0.28, s * 0.12, s * 0.5, hi);
      v.rect(s * 0.26, s * 0.42, s * 0.48, s * 0.06, lo);
      break;
    case 'leggings':
      v.poly([[s * 0.26, s * 0.2], [s * 0.5, s * 0.24], [s * 0.74, s * 0.2], [s * 0.76, s * 0.5], [s * 0.56, s * 0.82], [s * 0.44, s * 0.82], [s * 0.24, s * 0.5]], c);
      v.rect(s * 0.44, s * 0.24, s * 0.12, s * 0.3, hi);
      v.rect(s * 0.3, s * 0.55, s * 0.4, s * 0.05, lo);
      break;
    case 'boots':
      v.poly([[s * 0.3, s * 0.28], [s * 0.56, s * 0.28], [s * 0.56, s * 0.62], [s * 0.78, s * 0.68], [s * 0.78, s * 0.8], [s * 0.3, s * 0.8]], c);
      v.poly([[s * 0.6, s * 0.28], [s * 0.74, s * 0.28], [s * 0.74, s * 0.62], [s * 0.78, s * 0.68], [s * 0.78, s * 0.8], [s * 0.6, s * 0.8]], shade(c, 0.9));
      v.rect(s * 0.3, s * 0.44, s * 0.44, s * 0.06, lo);
      break;
    default:
      v.rect(s * 0.25, s * 0.25, s * 0.5, s * 0.5, c);
  }
};

S.egg = (v, d) => {
  const s = v.size;
  v.ellipse(s / 2, s * 0.6, s * 0.22, s * 0.3, d.c || [220, 220, 225]);
  v.ellipse(s * 0.44, s * 0.5, s * 0.08, s * 0.1, shade(d.c || [220, 220, 225], 1.15));
  for (let i = 0; i < 6; i++) {
    const x = s * (0.36 + (i % 3) * 0.14), y = s * (0.58 + Math.floor(i / 3) * 0.14);
    v.circle(x, y, s * 0.045, shade(d.c || [220, 220, 225], 0.75));
  }
};

S.boat = (v, d) => {
  const s = v.size, c = [150, 110, 60];
  v.poly([[s * 0.12, s * 0.5], [s * 0.88, s * 0.5], [s * 0.76, s * 0.78], [s * 0.24, s * 0.78]], c);
  v.rect(s * 0.12, s * 0.46, s * 0.76, s * 0.06, shade(c, 1.2));
  v.rect(s * 0.24, s * 0.6, s * 0.52, s * 0.1, shade(c, 0.7));
};

S.minecart = (v, d) => {
  const s = v.size, c = [150, 150, 158];
  v.rect(s * 0.2, s * 0.34, s * 0.6, s * 0.26, c);
  v.rect(s * 0.2, s * 0.34, s * 0.6, s * 0.05, shade(c, 1.25));
  v.circle(s * 0.32, s * 0.72, s * 0.1, [80, 80, 86]);
  v.circle(s * 0.68, s * 0.72, s * 0.1, [80, 80, 86]);
  v.rect(s * 0.24, s * 0.6, s * 0.52, s * 0.06, shade(c, 0.7));
};

S.arrow = (v, d) => {
  const s = v.size;
  v.line(s * 0.24, s * 0.8, s * 0.74, s * 0.24, [160, 120, 70], Math.max(1, s * 0.06));
  v.poly([[s * 0.74, s * 0.14], [s * 0.86, s * 0.26], [s * 0.72, s * 0.34]], d.c || [200, 200, 205]);
  v.line(s * 0.24, s * 0.8, s * 0.36, s * 0.66, [240, 240, 245], Math.max(1, s * 0.05));
  v.line(s * 0.24, s * 0.8, s * 0.14, s * 0.7, [240, 240, 245], Math.max(1, s * 0.05));
};

S.pearl = (v, d) => {
  const s = v.size, c = d.c || [40, 90, 80];
  v.circle(s / 2, s * 0.54, s * 0.26, c);
  v.circle(s * 0.42, s * 0.44, s * 0.08, shade(c, 1.5));
  for (let i = 0; i < 6; i++) {
    const a = i * 1.4;
    v.circle(s / 2 + Math.cos(a) * s * 0.18, s * 0.54 + Math.sin(a) * s * 0.18, s * 0.03, shade(c, 0.7));
  }
};

S.star = (v, d) => {
  const s = v.size, c = d.c || [245, 245, 250];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    v.line(s / 2, s / 2, s / 2 + Math.cos(a) * s * 0.4, s / 2 + Math.sin(a) * s * 0.4, c, Math.max(1, s * 0.06));
    v.line(s / 2, s / 2, s / 2 + Math.cos(a + 0.39) * s * 0.2, s / 2 + Math.sin(a + 0.39) * s * 0.2, shade(c, 0.8), Math.max(1, s * 0.05));
  }
  v.circle(s / 2, s / 2, s * 0.1, shade(c, 1.1));
};

S.disc = (v, d) => {
  const s = v.size;
  v.circle(s / 2, s / 2, s * 0.36, d.c || [40, 40, 45]);
  v.circle(s / 2, s / 2, s * 0.3, [60, 60, 66]);
  v.circle(s / 2, s / 2, s * 0.1, d.c2 || [200, 200, 210]);
  v.circle(s / 2, s / 2, s * 0.04, [20, 20, 24]);
};

S.compass = (v, d) => {
  const s = v.size;
  v.circle(s / 2, s / 2, s * 0.34, [180, 180, 188]);
  v.circle(s / 2, s / 2, s * 0.28, [235, 235, 240]);
  v.poly([[s / 2, s * 0.24], [s * 0.58, s * 0.5], [s / 2, s * 0.76], [s * 0.42, s * 0.5]], [220, 60, 55]);
  v.poly([[s / 2, s * 0.24], [s / 2, s * 0.76], [s * 0.42, s * 0.5]], [150, 40, 38]);
};

S.clock = (v, d) => {
  const s = v.size;
  v.circle(s / 2, s / 2, s * 0.34, [200, 170, 60]);
  v.circle(s / 2, s / 2, s * 0.28, [235, 235, 225]);
  v.line(s / 2, s / 2, s / 2 + s * 0.16, s / 2 - s * 0.12, [50, 50, 55], Math.max(1, s * 0.05));
  v.line(s / 2, s / 2, s / 2 - s * 0.06, s / 2 - s * 0.2, [50, 50, 55], Math.max(1, s * 0.05));
};

S.map = (v, d) => {
  const s = v.size;
  v.rect(s * 0.16, s * 0.2, s * 0.68, s * 0.6, [225, 210, 170]);
  v.rect(s * 0.16, s * 0.2, s * 0.68, s * 0.06, [190, 170, 130]);
  for (let i = 0; i < 5; i++) v.line(s * 0.22, s * (0.34 + i * 0.09), s * 0.78, s * (0.36 + i * 0.08), [190, 170, 130], 1);
  v.circle(s * 0.6, s * 0.5, s * 0.05, [200, 90, 80]);
};

S.saddle = (v, d) => {
  const s = v.size, c = [140, 90, 55];
  v.ellipse(s / 2, s * 0.58, s * 0.34, s * 0.2, c);
  v.ellipse(s / 2, s * 0.52, s * 0.26, s * 0.13, shade(c, 1.2));
  v.rect(s * 0.42, s * 0.36, s * 0.16, s * 0.1, shade(c, 0.7));
};

S.shears2 = (v, d) => S.tool(v, { kind: 'shears', c: d.c });

S.brush = (v, d) => {
  const s = v.size;
  v.line(s * 0.3, s * 0.86, s * 0.62, s * 0.4, [150, 112, 62], Math.max(1, s * 0.08));
  v.rect(s * 0.56, s * 0.24, s * 0.2, s * 0.16, [200, 200, 205]);
  v.line(s * 0.6, s * 0.4, s * 0.56, s * 0.2, [230, 220, 190], Math.max(1, s * 0.04));
};

S.spyglass = (v, d) => {
  const s = v.size;
  v.line(s * 0.24, s * 0.74, s * 0.6, s * 0.3, [200, 150, 70], Math.max(2, s * 0.12));
  v.line(s * 0.56, s * 0.34, s * 0.82, s * 0.16, [180, 180, 188], Math.max(2, s * 0.11));
};

S.totem = (v, d) => {
  const s = v.size;
  v.rect(s * 0.36, s * 0.2, s * 0.28, s * 0.6, [190, 170, 90]);
  v.rect(s * 0.36, s * 0.2, s * 0.28, s * 0.1, [220, 200, 120]);
  v.px(s * 0.44, s * 0.36, [40, 60, 40]); v.px(s * 0.56, s * 0.36, [40, 60, 40]);
  v.rect(s * 0.44, s * 0.52, s * 0.12, s * 0.16, [40, 60, 40]);
};

S.shell = (v, d) => {
  const s = v.size, c = d.c || [230, 220, 200];
  v.ellipse(s / 2, s * 0.58, s * 0.3, s * 0.26, c);
  for (let i = 0; i < 5; i++) v.line(s / 2, s * 0.36, s * (0.28 + i * 0.11), s * 0.8, shade(c, 0.8), 1);
};

// ===========================================================================
//  icon table
// ===========================================================================
const I = {};
// `kind` selects the painter, `shape` (when given) selects a sub-shape inside
// it - e.g. kind "food" with shape "bread".
const icon = (name, kind, args) => { I[name] = Object.assign({ kind, shape: kind }, args); };

icon('stick', 'stick');
icon('coal', 'blob', { c: [35, 35, 38] });
icon('charcoal', 'blob', { c: [55, 45, 42] });
for (const [m, c] of Object.entries({
  iron_ingot: [220, 220, 224], gold_ingot: [245, 210, 70], copper_ingot: [200, 120, 80],
  netherite_ingot: [70, 62, 68], netherite_scrap: [130, 110, 100],
})) icon(m, 'ingot', { c });
for (const [m, c] of Object.entries({ iron_nugget: [220, 220, 224], gold_nugget: [245, 210, 70] })) icon(m, 'nugget', { c });
icon('diamond', 'gem', { c: [110, 230, 225] });
icon('emerald', 'gem', { c: [70, 220, 110] });
icon('quartz', 'gem', { c: [235, 230, 222] });
icon('lapis_lazuli', 'dust', { c: [50, 90, 200] });
icon('redstone_dust', 'dust', { c: [220, 50, 45] });
icon('glowstone_dust', 'dust', { c: [235, 200, 110] });
icon('sugar', 'dust', { c: [245, 245, 248] });
icon('bone_meal', 'dust', { c: [235, 232, 215] });
icon('gunpowder', 'dust', { c: [70, 70, 74] });
icon('clay_ball', 'ball', { c: [160, 166, 178] });
icon('slime_ball', 'ball', { c: [110, 190, 90] });
icon('magma_cream', 'ball', { c: [230, 130, 60] });
icon('snowball', 'ball', { c: [240, 246, 252] });
icon('egg', 'ball', { c: [235, 230, 210] });
icon('ender_pearl', 'pearl', {});
icon('eye_of_ender', 'pearl', { c: [180, 190, 90] });
icon('leather', 'sheet', { c: [160, 100, 60] });
icon('rabbit_hide', 'sheet', { c: [190, 170, 140] });
icon('paper', 'sheet', { c: [240, 240, 240], lines: true });
icon('book', 'book', {});
icon('name_tag', 'sheet', { c: [200, 180, 100] });
icon('ink_sac', 'blob', { c: [30, 30, 40] });
icon('brick', 'blob', { c: [158, 92, 72] });
icon('nether_brick', 'blob', { c: [110, 60, 60] });
icon('flint', 'gem', { c: [80, 80, 88] });
icon('string', 'stick', { c: [220, 220, 220] });
icon('feather', 'feather', {});
icon('bone', 'bone', {});
icon('blaze_rod', 'rod', { c: [240, 190, 60] });
icon('blaze_powder', 'dust', { c: [240, 180, 60] });
icon('ghast_tear', 'pearl', { c: [200, 230, 240] });
icon('spider_eye', 'ball', { c: [180, 60, 55] });
icon('rotten_flesh', 'blob', { c: [150, 110, 90] });
icon('sugar_cane', 'rod', { c: [150, 200, 90] });
icon('wheat', 'food', { c: [220, 200, 90], shape: 'veg' });
icon('apple', 'food', { c: [200, 60, 55], shape: 'round' });
icon('golden_apple', 'food', { c: [240, 200, 70], shape: 'round' });
icon('enchanted_golden_apple', 'food', { c: [250, 220, 110], shape: 'round' });
icon('nether_star', 'star', {});
icon('heart_of_the_sea', 'gem', { c: [80, 190, 200] });
icon('nautilus_shell', 'shell', {});
icon('shulker_shell', 'shell', { c: [180, 150, 190] });
icon('phantom_membrane', 'sheet', { c: [190, 190, 220] });
icon('scute', 'shell', { c: [120, 180, 120] });
icon('rabbit_foot', 'blob', { c: [200, 170, 160] });
icon('disc_fragment', 'blob', { c: [90, 90, 95] });
icon('totem', 'totem', {});
icon('saddle', 'saddle', {});
icon('lead', 'stick', { c: [140, 120, 80] });
icon('music_disc', 'disc', {});
icon('compass', 'compass', {});
icon('clock', 'clock', {});
icon('map', 'map', {});
icon('spyglass', 'spyglass', {});
icon('brush', 'brush', {});
icon('arrow', 'arrow', {});
icon('spectral_arrow', 'arrow', { c: [220, 220, 140] });
icon('firework', 'rod', { c: [200, 80, 120] });
icon('boat', 'boat', {});
icon('minecart', 'minecart', {});
icon('chest_minecart', 'minecart', {});
icon('hopper_minecart', 'minecart', {});
icon('tnt_minecart', 'minecart', {});
icon('bucket', 'bucket', { liquid: [60, 60, 66] });
icon('water_bucket', 'bucket', { liquid: [70, 130, 220] });
icon('lava_bucket', 'bucket', { liquid: [230, 120, 40] });
icon('milk_bucket', 'bucket', { liquid: [245, 245, 245] });
icon('glass_bottle', 'potion', { c: [200, 210, 220] });
icon('xp_bottle', 'potion', { c: [140, 230, 90] });
icon('potion', 'potion', {});
icon('spawn_egg', 'egg', {});
icon('ender_chest_icon', 'sheet', { c: [40, 70, 70] });
icon('nether_wart', 'blob', { c: [160, 60, 60] });

// tools
for (const [mat, c] of Object.entries({
  wooden: [150, 110, 60], stone: [130, 130, 132], iron: [220, 220, 224],
  golden: [245, 210, 70], diamond: [110, 230, 225], netherite: [70, 62, 68],
})) {
  for (const k of ['pickaxe', 'axe', 'shovel', 'hoe', 'sword']) icon(mat + '_' + k, 'tool', { kind: k, c });
}
icon('shears', 'tool', { kind: 'shears' });
icon('bow', 'tool', { kind: 'bow' });
icon('crossbow', 'tool', { kind: 'bow' });
icon('trident', 'tool', { kind: 'trident', c: [130, 230, 220] });
icon('shield', 'tool', { kind: 'shield' });
icon('fishing_rod', 'tool', { kind: 'fishing_rod' });
icon('flint_and_steel', 'tool', { kind: 'flint_and_steel' });
icon('carrot_on_a_stick', 'tool', { kind: 'carrot_on_a_stick' });

// armour
for (const [mat, c] of Object.entries({
  leather: [160, 100, 60], iron: [220, 220, 224], golden: [245, 210, 70],
  diamond: [110, 230, 225], netherite: [70, 62, 68],
})) {
  for (const [slot, shape] of [['helmet', 'helmet'], ['chestplate', 'chestplate'], ['leggings', 'leggings'], ['boots', 'boots']]) {
    icon(mat + '_' + slot, 'armor', { slot: shape, c });
  }
}
icon('elytra', 'armor', { slot: 'chestplate', c: [90, 70, 110] });
icon('turtle_helmet', 'armor', { slot: 'helmet', c: [90, 160, 110] });
icon('leather_horse_armor', 'armor', { slot: 'chestplate', c: [160, 100, 60] });
icon('iron_horse_armor', 'armor', { slot: 'chestplate', c: [220, 220, 224] });
icon('golden_horse_armor', 'armor', { slot: 'chestplate', c: [245, 210, 70] });
icon('diamond_horse_armor', 'armor', { slot: 'chestplate', c: [110, 230, 225] });

// food
icon('bread', 'food', { c: [200, 150, 80], shape: 'bread' });
icon('cookie', 'food', { c: [180, 130, 70], shape: 'cookie' });
icon('beef', 'food', { c: [200, 90, 90], shape: 'meat' });
icon('cooked_beef', 'food', { c: [140, 80, 50], shape: 'meat', cooked: true });
icon('porkchop', 'food', { c: [230, 150, 150], shape: 'meat' });
icon('cooked_porkchop', 'food', { c: [160, 100, 60], shape: 'meat', cooked: true });
icon('chicken', 'food', { c: [230, 190, 150], shape: 'meat' });
icon('cooked_chicken', 'food', { c: [180, 130, 70], shape: 'meat', cooked: true });
icon('mutton', 'food', { c: [210, 120, 120], shape: 'meat' });
icon('cooked_mutton', 'food', { c: [150, 90, 60], shape: 'meat', cooked: true });
icon('rabbit', 'food', { c: [210, 160, 140], shape: 'meat' });
icon('cooked_rabbit', 'food', { c: [160, 110, 80], shape: 'meat', cooked: true });
icon('cod', 'food', { c: [170, 170, 150], shape: 'fish' });
icon('cooked_cod', 'food', { c: [200, 160, 100], shape: 'fish' });
icon('salmon', 'food', { c: [220, 120, 90], shape: 'fish' });
icon('cooked_salmon', 'food', { c: [230, 160, 110], shape: 'fish' });
icon('tropical_fish', 'food', { c: [240, 170, 60], shape: 'fish' });
icon('carrot_item', 'food', { c: [230, 140, 50], shape: 'veg' });
icon('golden_carrot', 'food', { c: [245, 210, 70], shape: 'veg' });
icon('potato_item', 'food', { c: [210, 190, 120], shape: 'veg' });
icon('baked_potato', 'food', { c: [200, 160, 90], shape: 'veg' });
icon('poisonous_potato', 'food', { c: [140, 170, 90], shape: 'veg' });
icon('beetroot_item', 'food', { c: [180, 60, 70], shape: 'veg' });
icon('melon_slice', 'food', { c: [220, 90, 90], shape: 'slice' });
icon('sweet_berries', 'food', { c: [200, 60, 70], shape: 'round' });
icon('glow_berries', 'food', { c: [220, 170, 70], shape: 'round' });
icon('dried_kelp', 'food', { c: [80, 120, 60], shape: 'veg' });
icon('pumpkin_pie', 'food', { shape: 'pie' });
icon('cake_item', 'food', { c: [245, 240, 235], shape: 'pie' });
icon('beetroot_soup', 'bowl', { liquid: [190, 60, 70] });
icon('mushroom_stew', 'bowl', { liquid: [160, 120, 90] });
icon('rabbit_stew', 'bowl', { liquid: [180, 130, 80] });
icon('suspicious_stew', 'bowl', { liquid: [140, 170, 90] });

// ===========================================================================
//  bake
// ===========================================================================
export function bakeIcon(name, size, tint) {
  const d = I[name];
  const v = new Canvas(size, hashString(name));
  if (!d) {
    v.rect(size * 0.25, size * 0.25, size * 0.5, size * 0.5, [255, 0, 255]);
    return v;
  }
  const args = Object.assign({}, d);
  if (tint) args.c = tint;
  if (!args.c) args.c = [190, 190, 195];
  const fn = S[args.shape] || S[args.kind] || S.blob;
  fn(v, args);
  return v;
}

export function generateItemTextures(names, size, tintLookup) {
  const out = [];
  for (const name of names) {
    const c = bakeIcon(name, size, tintLookup ? tintLookup(name) : null);
    out.push({ name, albedo: new Uint8Array(c.d.buffer.slice(0)) });
  }
  return out;
}

export const ICON_TABLE = I;
