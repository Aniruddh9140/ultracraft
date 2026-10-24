/**
 * Ultracraft - chunk mesher.
 *
 * Builds one interleaved 12-byte-per-vertex stream per texture array:
 *
 *   byte  0..2   position  (u8, normalised, x*16 = local coordinate 0..16)
 *   byte  3..4   uv        (u8, normalised)
 *   byte  5      texture array layer
 *   byte  6      face normal index (0..5)
 *   byte  7..9   ao, block light, sky light (u8, normalised)
 *   byte 10..11  (pad for alignment)
 *
 * Features: face culling against neighbours, per-vertex ambient occlusion and
 * smooth (interpolated) light, liquid corner heights, and ~25 block shapes.
 */

import { Shape, getBlock, AIR } from '../world/blocks.js';

const S = 18;              // 16 + 1 voxel border on each side
const S2 = S * S;
const IDX = (x, y, z) => ((y + 1) * S + (z + 1)) * S + (x + 1);

// face table: direction, uv tangent axes, normal index
// 0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z
export const FACE_DIRS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
// tangent axes: u axis, v axis (unit vectors on the other two world axes)
const FACE_UV = [
  { u: [0, 0, -1], v: [0, -1, 0] }, // +X   (u = -Z, v = -Y)
  { u: [0, 0, 1], v: [0, -1, 0] },  // -X   (u = +Z, v = -Y)
  { u: [1, 0, 0], v: [0, 0, 1] },   // +Y   (u = +X, v = +Z)
  { u: [1, 0, 0], v: [0, 0, -1] },  // -Y   (u = +X, v = -Z)
  { u: [1, 0, 0], v: [0, -1, 0] },  // +Z   (u = +X, v = -Y)
  { u: [-1, 0, 0], v: [0, -1, 0] }, // -Z   (u = -X, v = -Y)
];

/**
 * The four corners of each face in (u, v) tangent space, wound counter
 * clockwise when seen from outside the block.
 */
const FACE_CORNERS = [
  [[0, 1], [1, 1], [1, 0], [0, 0]], // +X
  [[0, 1], [1, 1], [1, 0], [0, 0]], // -X
  [[0, 0], [0, 1], [1, 1], [1, 0]], // +Y
  [[0, 0], [0, 1], [1, 1], [1, 0]], // -Y
  [[0, 1], [1, 1], [1, 0], [0, 0]], // +Z
  [[0, 1], [1, 1], [1, 0], [0, 0]], // -Z
];

/** (u,v) -> box local (x,y,z) in 0..1 space. */
const FACE_CORNER_POS = [
  (u, v) => [1, 1 - v, 1 - u],
  (u, v) => [0, 1 - v, u],
  (u, v) => [u, 1, v],
  (u, v) => [u, 0, 1 - v],
  (u, v) => [u, 1 - v, 1],
  (u, v) => [1 - u, 1 - v, 0],
];

// ---------------------------------------------------------------------------
//  shape -> boxes
// ---------------------------------------------------------------------------
const boxCache = new Map();

function box(x0, y0, z0, x1, y1, z1, faces = 63, cull = true) {
  return { x0, y0, z0, x1, y1, z1, faces, cull };
}

function boxesFor(id, meta) {
  const key = id * 256 + meta;
  let v = boxCache.get(key);
  if (v) return v;
  const b = getBlock(id);
  v = computeBoxes(b, meta);
  boxCache.set(key, v);
  return v;
}

function computeBoxes(b, meta) {
  switch (b.shape) {
    case Shape.CUBE:
    case Shape.LEAVES:
      return [box(0, 0, 0, 1, 1, 1, 63, b.opaque)];
    case Shape.EMPTY:
      return [];
    case Shape.SLAB: {
      const top = (meta & 8) !== 0;
      return [top ? box(0, 0.5, 0, 1, 1, 1) : box(0, 0, 0, 1, 0.5, 1)];
    }
    case Shape.PATH:
      return [box(0, 0, 0, 1, 0.9375, 1)];
    case Shape.FARMLAND:
      return [box(0, 0, 0, 1, 0.9375, 1)];
    case Shape.STAIRS: {
      const facing = meta & 3; // 0 north(-Z) 1 east(+X) 2 south(+Z) 3 west(-X)
      const top = (meta & 4) !== 0;
      const base = top ? box(0, 0.5, 0, 1, 1, 1) : box(0, 0, 0, 1, 0.5, 1);
      const yb = top ? 0 : 0.5, yt = top ? 1 : 0.5;
      let step;
      switch (facing) {
        case 0: step = box(0, yb, 0, 1, yt, 0.5); break;
        case 1: step = box(0.5, yb, 0, 1, yt, 1); break;
        case 2: step = box(0, yb, 0.5, 1, yt, 1); break;
        default: step = box(0, yb, 0, 0.5, yt, 1); break;
      }
      return [base, step];
    }
    case Shape.CACTUS:
      return [box(0.0625, 0, 0.0625, 0.9375, 1, 0.9375, 63, false)];
    case Shape.CHEST:
    case Shape.FURNACE:
      return [box(0.0, 0.0, 0.0, 1, 1, 1, 63, b.opaque)];
    case Shape.TORCH: {
      const w = 0.4375, w2 = 0.5625;
      return [box(w, 0, w, w2, 0.625, w2, 63, false)];
    }
    case Shape.FENCE:
    case Shape.WALL: {
      const p = 0.375, p2 = 0.625;
      const h = b.height || 1.5;
      return [box(p, 0, p, p2, Math.min(h, 1), p2, 63, false)];
    }
    case Shape.PANE: {
      const t = 0.4375, t2 = 0.5625;
      return [box(t, 0, t, t2, 1, t2, 63, false)];
    }
    case Shape.DOOR: {
      const upper = (meta & 8) !== 0;
      const facing = meta & 3;
      const open = (meta & 4) !== 0;
      const t = 0.1875;
      if (!open) {
        switch (facing) {
          case 0: return [box(0, 0, 0.5 - t / 2, 1, 1, 0.5 + t / 2, 63, false)];
          case 1: return [box(0.5 - t / 2, 0, 0, 0.5 + t / 2, 1, 1, 63, false)];
          case 2: return [box(0, 0, 0.5 - t / 2, 1, 1, 0.5 + t / 2, 63, false)];
          default: return [box(0.5 - t / 2, 0, 0, 0.5 + t / 2, 1, 1, 63, false)];
        }
      }
      switch (facing) {
        case 0: return [box(0, 0, 1 - t, 1, 1, 1, 63, false)];
        case 1: return [box(1 - t, 0, 0, 1, 1, 1, 63, false)];
        case 2: return [box(0, 0, 0, 1, 1, t, 63, false)];
        default: return [box(0, 0, 0, t, 1, 1, 63, false)];
      }
    }
    case Shape.TRAPDOOR: {
      const open = (meta & 4) !== 0;
      const top = (meta & 8) !== 0;
      if (open) {
        const facing = meta & 3;
        switch (facing) {
          case 0: return [box(0, 0, 0, 1, 1, 0.1875, 63, false)];
          case 1: return [box(0.8125, 0, 0, 1, 1, 1, 63, false)];
          case 2: return [box(0, 0, 0.8125, 1, 1, 1, 63, false)];
          default: return [box(0, 0, 0, 0.1875, 1, 1, 63, false)];
        }
      }
      return [top ? box(0, 0.8125, 0, 1, 1, 1, 63, false) : box(0, 0, 0, 1, 0.1875, 1, 63, false)];
    }
    case Shape.PLATE:
      return [box(0.0625, 0, 0.0625, 0.9375, 0.0625, 0.9375, 63, false)];
    case Shape.CARPET:
      return [box(0, 0, 0, 1, 0.0625, 1, 63, false)];
    case Shape.BUTTON: {
      const facing = meta & 3;
      const pressed = (meta & 8) !== 0;
      const d = pressed ? 0.0625 : 0.125;
      switch (facing) {
        case 0: return [box(0.3125, 0.375, 0, 0.6875, 0.625, d, 63, false)];
        case 1: return [box(1 - d, 0.375, 0.3125, 1, 0.625, 0.6875, 63, false)];
        case 2: return [box(0.3125, 0.375, 1 - d, 0.6875, 0.625, 1, 63, false)];
        default: return [box(0, 0.375, 0.3125, d, 0.625, 0.6875, 63, false)];
      }
    }
    case Shape.LEVER:
      return [box(0.3125, 0.125, 0.3125, 0.6875, 0.375, 0.6875, 63, false)];
    case Shape.BED:
      return [box(0, 0.125, 0, 1, 0.5625, 1, 63, false)];
    case Shape.ANVIL:
      return [box(0.125, 0, 0.125, 0.875, 0.75, 0.875, 63, false), box(0.0, 0.75, 0.0, 1, 1, 1, 63, false)];
    case Shape.SKULL:
      return [box(0.25, 0, 0.25, 0.75, 0.5, 0.75, 63, false)];
    case Shape.GATE: {
      const facing = meta & 3;
      const open = (meta & 4) !== 0;
      if (facing === 0 || facing === 2) {
        return open
          ? [box(0, 0.375, 0, 0.1875, 1, 1, 63, false), box(0.8125, 0.375, 0, 1, 1, 1, 63, false)]
          : [box(0, 0.375, 0.4375, 1, 1, 0.5625, 63, false), box(0, 0, 0, 0.1875, 1, 1, 63, false), box(0.8125, 0, 0, 1, 1, 1, 63, false)];
      }
      return open
        ? [box(0, 0.375, 0, 1, 1, 0.1875, 63, false), box(0, 0.375, 0.8125, 1, 1, 1, 63, false)]
        : [box(0.4375, 0.375, 0, 0.5625, 1, 1, 63, false), box(0, 0, 0, 1, 1, 0.1875, 63, false), box(0, 0, 0.8125, 1, 1, 1, 63, false)];
    }
    case Shape.LIQUID: {
      const level = Math.min(8, meta & 15);
      const h = level === 8 ? 0.875 : (level / 9) * 0.875;
      return [{ liquid: true, level, height: h, x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1, faces: 63, cull: false }];
    }
    default:
      return [box(0, 0, 0, 1, 1, 1, 63, b.opaque)];
  }
}

// ---------------------------------------------------------------------------
//  mesher
// ---------------------------------------------------------------------------
export class ChunkMesher {
  constructor(world, texResolver) {
    this.world = world;
    this.tex = texResolver;
    this.blocks = new Uint16Array(S * S * S);
    this.metas = new Uint8Array(S * S * S);
    this.lights = new Uint8Array(S * S * S);
    this.opaque = new Uint8Array(S * S * S);
    this.heights = new Float32Array(S * S * S);
    // growable output, split by render pass then texture array
    this.out = [[], [], [], []];
    this.counts = [[], [], [], []];
    this.pass = 0;
    this.stats = { faces: 0, quads: 0 };
  }

  ensureArray(pass, i) {
    while (this.out[pass].length <= i) { this.out[pass].push(new Uint8Array(6144 * 12)); this.counts[pass].push(0); }
  }

  push(pass, arrIdx, n) {
    let buf = this.out[pass][arrIdx];
    let c = this.counts[pass][arrIdx];
    if ((c + 1) * 12 > buf.length) {
      const bigger = new Uint8Array(buf.length * 2);
      bigger.set(buf);
      this.out[pass][arrIdx] = bigger;
      buf = bigger;
    }
    this.counts[pass][arrIdx] = c + 1;
    return c * 12;
  }

  /** Gather the 18^3 neighbourhood for one section. */
  gather(cx, cy, cz) {
    const w = this.world;
    const bx = cx * 16, by = cy * 16, bz = cz * 16;
    const blocks = this.blocks, metas = this.metas, lights = this.lights, opaque = this.opaque, heights = this.heights;
    for (let y = -1; y <= 16; y++) {
      const wy = by + y;
      for (let z = -1; z <= 16; z++) {
        const wz = bz + z;
        const rowBase = ((y + 1) * S + (z + 1)) * S;
        for (let x = -1; x <= 16; x++) {
          const i = rowBase + (x + 1);
          const id = w.getBlockFast(bx + x, wy, wz);
          blocks[i] = id;
          metas[i] = w.getMetaFast(bx + x, wy, wz);
          lights[i] = w.getLightFast(bx + x, wy, wz);
          const bd = getBlock(id);
          opaque[i] = bd.opaque ? 1 : 0;
          heights[i] = bd.flow > 0 ? (Math.min(8, metas[i] & 15) === 8 ? 1.0 : ((metas[i] & 15) / 9)) : 0;
        }
      }
    }
  }

  /** Build the mesh for one 16^3 section. Returns array of {data, count}. */
  build(cx, cy, cz) {
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    for (let p = 0; p < 4; p++) for (let i = 0; i < this.counts[p].length; i++) this.counts[p][i] = 0;
    this.ensureArray(0, 0);
    this.gather(cx, cy, cz);
    this.stats.faces = 0;

    const blocks = this.blocks, metas = this.metas, lights = this.lights, opaque = this.opaque;
    for (let y = 0; y < 16; y++) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const i = IDX(x, y, z);
          const id = blocks[i];
          if (id === AIR) continue;
          const meta = metas[i];
          const b = getBlock(id);
          this.pass = b.pass | 0;
          if (b.shape === Shape.CROSS || b.shape === Shape.CROP) {
            this.emitCross(x, y, z, id, meta, b, i);
            continue;
          }
          if (b.shape === Shape.LADDER) { this.emitLadder(x, y, z, id, meta, b, i); continue; }
          const boxes = boxesFor(id, meta);
          for (let bi = 0; bi < boxes.length; bi++) {
            const bx = boxes[bi];
            if (bx.liquid) this.emitLiquid(x, y, z, bx, id, meta, b, i);
            else this.emitBox(x, y, z, bx, id, meta, b, i);
          }
        }
      }
    }

    const result = [];
    for (let p = 0; p < 4; p++) {
      const perArr = [];
      for (let a = 0; a < this.out[p].length; a++) {
        const c = this.counts[p][a];
        perArr.push(c ? { data: this.out[p][a].subarray(0, c * 12), vertexCount: c } : null);
      }
      result.push(perArr);
    }
    this.stats.time = ((typeof performance !== 'undefined') ? performance.now() : 0) - t0;
    return result;
  }

  // -------------------------------------------------------------------------
  emitBox(x, y, z, bx, id, meta, b, i) {
    const blocks = this.blocks, opaque = this.opaque;
    const { x0, y0, z0, x1, y1, z1, faces } = bx;
    for (let f = 0; f < 6; f++) {
      if (!(faces & (1 << f))) continue;
      const d = FACE_DIRS[f];
      // neighbour culling: only when the box face sits on the block boundary
      if (bx.cull) {
        const onFace = (f === 0 && x1 >= 1) || (f === 1 && x0 <= 0) || (f === 2 && y1 >= 1) ||
          (f === 3 && y0 <= 0) || (f === 4 && z1 >= 1) || (f === 5 && z0 <= 0);
        if (onFace) {
          const ni = IDX(x + d[0], y + d[1], z + d[2]);
          const nb = blocks[ni];
          if (opaque[ni]) continue;
          // don't draw interior faces between two of the same translucent block
          if (nb === id && !opaque[ni]) continue;
          if (nb === 0) { /* air -> always draw */ }
        }
      }
      const tex = this.tex(id, meta, f, b);
      if (!tex) continue;
      this.emitQuad(x, y, z, f, bx, tex, id, meta, b, i, null);
    }
  }

  // -------------------------------------------------------------------------
  emitQuad(x, y, z, f, bx, tex, id, meta, b, i, liquidHeights) {
    const arrIdx = tex.arr | 0;
    const pass = this.pass;
    this.ensureArray(pass, arrIdx);
    const uvAxis = FACE_UV[f];
    const d = FACE_DIRS[f];
    const cornerPos = FACE_CORNER_POS[f];
    const blocks = this.blocks, lights = this.lights, opaque = this.opaque;

    // gather per-corner ao + light
    const ao = [0, 0, 0, 0], bl = [0, 0, 0, 0], sl = [0, 0, 0, 0];
    const cx = [0, 0, 0, 0], cy = [0, 0, 0, 0], cz = [0, 0, 0, 0];

    const corners = FACE_CORNERS[f];
    for (let c = 0; c < 4; c++) {
      const [ou, ov] = corners[c];
      const su = ou === 0 ? -1 : 1;
      const sv = ov === 0 ? -1 : 1;
      // neighbour cell indices (relative to the "above" cell)
      const ax = x + d[0], ay = y + d[1], az = z + d[2];
      const s1x = ax + uvAxis.u[0] * su, s1y = ay + uvAxis.u[1] * su, s1z = az + uvAxis.u[2] * su;
      const s2x = ax + uvAxis.v[0] * sv, s2y = ay + uvAxis.v[1] * sv, s2z = az + uvAxis.v[2] * sv;
      const cnx = s1x + uvAxis.v[0] * sv, cny = s1y + uvAxis.v[1] * sv, cnz = s1z + uvAxis.v[2] * sv;

      const iA = IDX(ax, ay, az), i1 = IDX(s1x, s1y, s1z), i2 = IDX(s2x, s2y, s2z), iC = IDX(cnx, cny, cnz);
      const oA = opaque[iA], o1 = opaque[i1], o2 = opaque[i2], oC = opaque[iC];

      let aov = 3 - (o1 + o2 + oC);
      if (o1 && o2) aov = 0;
      ao[c] = aov / 3;

      let sum = 0, n = 0;
      if (!oA) { sum += lights[iA] & 15; n++; }
      if (oA) { sum += (lights[iA] >> 4) & 15; n++; } // opaque: only block light leaks
      if (!o1) { sum += lights[i1] & 15; n++; } else { sum += (lights[i1] >> 4) & 15; n++; }
      if (!o2) { sum += lights[i2] & 15; n++; }
      if (!oC) { sum += lights[iC] & 15; n++; }
      sl[c] = n ? (sum / n) / 15 : 0;

      let bs = 0, bn = 0;
      bs += (lights[iA] >> 4) & 15; bn++;
      bs += (lights[i1] >> 4) & 15; bn++;
      bs += (lights[i2] >> 4) & 15; bn++;
      bs += (lights[iC] >> 4) & 15; bn++;
      bl[c] = (bs / bn) / 15;

      // corner position in box-local space (0..1)
      const p = cornerPos(ou, ov);
      let lx = bx.x0 + (bx.x1 - bx.x0) * p[0];
      let ly = bx.y0 + (bx.y1 - bx.y0) * p[1];
      let lz = bx.z0 + (bx.z1 - bx.z0) * p[2];
      if (liquidHeights) ly = liquidHeights[c];
      cx[c] = lx; cy[c] = ly; cz[c] = lz;
    }

    // uv per corner == the tangent-space corner coordinate
    const u = [0, 0, 0, 0], v = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) { u[c] = corners[c][0]; v[c] = corners[c][1]; }

    const order = [0, 1, 2, 0, 2, 3];
    for (let k = 0; k < 6; k++) {
      const c = order[k];
      const o = this.push(pass, arrIdx, 1);
      const buf = this.out[pass][arrIdx];
      buf[o] = Math.round((x + cx[c]) * 255 / 16);
      buf[o + 1] = Math.round((y + cy[c]) * 255 / 16);
      buf[o + 2] = Math.round((z + cz[c]) * 255 / 16);
      buf[o + 3] = Math.round(u[c] * 255);
      buf[o + 4] = Math.round(v[c] * 255);
      buf[o + 5] = tex.layer;
      buf[o + 6] = f;
      buf[o + 7] = Math.round(ao[c] * 255);
      buf[o + 8] = Math.round(bl[c] * 255);
      buf[o + 9] = Math.round(sl[c] * 255);
      buf[o + 10] = 0; buf[o + 11] = 0;
    }
    this.stats.faces++;
  }

  // -------------------------------------------------------------------------
  emitLiquid(x, y, z, bx, id, meta, b, i) {
    const blocks = this.blocks, lights = this.lights, opaque = this.opaque, heights = this.heights;
    const ownH = bx.height;
    const isTopWater = (xx, yy, zz) => {
      const ii = IDX(xx, yy, zz);
      return blocks[ii] === id;
    };
    // corner heights for the surface
    const ch = [0, 0, 0, 0];
    const topCorners = FACE_CORNERS[2];
    for (let c = 0; c < 4; c++) {
      const [ou, ov] = topCorners[c];
      const su = ou === 0 ? -1 : 1, sv = ov === 0 ? -1 : 1;
      let h = ownH;
      for (let du = 0; du <= 1; du++) {
        for (let dv = 0; dv <= 1; dv++) {
          const ox = du === 0 ? 0 : (su > 0 ? 1 : -1);
          const oz = dv === 0 ? 0 : (sv > 0 ? 1 : -1);
          const ii = IDX(x + ox, y, z + oz);
          if (blocks[ii] === id) h = Math.max(h, heights[ii]);
          const iu = IDX(x + ox, y + 1, z + oz);
          if (blocks[iu] === id) h = 1.0;
        }
      }
      ch[c] = h;
    }
    // top face
    const above = IDX(x, y + 1, z);
    if (!isTopWater(x, y + 1, z)) {
      const tex = this.tex(id, meta, 2, b);
      if (tex) this.emitQuad(x, y, z, 2, { x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 }, tex, id, meta, b, i, ch);
    }
    // bottom
    const below = IDX(x, y - 1, z);
    if (blocks[below] !== id && !opaque[below] && blocks[below] !== 0) {
      const tex = this.tex(id, meta, 3, b);
      if (tex) this.emitQuad(x, y, z, 3, { x0: 0, y0: 0, z0: 0, x1: 1, y1: 0, z1: 1 }, tex, id, meta, b, i, [0, 0, 0, 0]);
    }
    // sides: only where the neighbour is not the same liquid and not opaque
    for (let f = 0; f < 6; f++) {
      if (f === 2 || f === 3) continue;
      const d = FACE_DIRS[f];
      const ni = IDX(x + d[0], y + d[1], z + d[2]);
      if (blocks[ni] === id || opaque[ni]) continue;
      const tex = this.tex(id, meta, f, b);
      if (!tex) continue;
      // side quads only reach up to the fluid level
      this.emitQuad(x, y, z, f, { x0: 0, y0: 0, z0: 0, x1: 1, y1: ownH, z1: 1 }, tex, id, meta, b, i, null);
    }
  }

  // -------------------------------------------------------------------------
  emitCross(x, y, z, id, meta, b, i) {
    const tex = this.tex(id, meta, 0, b);
    if (!tex) return;
    this.ensureArray(this.pass, tex.arr | 0);
    const light = this.lights[i];
    const sl = (light & 15) / 15, bl = ((light >> 4) & 15) / 15;
    const h = b.shape === Shape.CROP ? 0.25 + (meta / (b.maxAge || 7)) * 0.75 : 1;
    const quads = [
      [0.146, 0, 0.146, 0.854, h, 0.854],
      [0.146, 0, 0.854, 0.854, h, 0.146],
    ];
    for (const q of quads) {
      const verts = [
        [q[0], q[1], q[2], 0, 1],
        [q[3], q[1], q[5], 1, 1],
        [q[3], q[4], q[5], 1, 0],
        [q[0], q[4], q[2], 0, 0],
      ];
      // emit both windings so the quad survives back-face culling
      for (const order of [[0, 1, 2, 0, 2, 3], [2, 1, 0, 3, 2, 0]]) {
        for (let k = 0; k < 6; k++) {
          const vt = verts[order[k]];
          const o = this.push(this.pass, tex.arr | 0, 1);
          const buf = this.out[this.pass][tex.arr | 0];
          buf[o] = Math.round((x + vt[0]) * 255 / 16);
          buf[o + 1] = Math.round((y + vt[1]) * 255 / 16);
          buf[o + 2] = Math.round((z + vt[2]) * 255 / 16);
          buf[o + 3] = Math.round(vt[3] * 255);
          buf[o + 4] = Math.round(vt[4] * 255);
          buf[o + 5] = tex.layer;
          buf[o + 6] = 2; // lit as if facing up
          buf[o + 7] = 255;
          buf[o + 8] = Math.round(bl * 255);
          buf[o + 9] = Math.round(sl * 255);
          buf[o + 10] = 0; buf[o + 11] = 0;
        }
        this.stats.faces++;
      }
    }
  }

  emitLadder(x, y, z, id, meta, b, i) {
    const tex = this.tex(id, meta, 0, b);
    if (!tex) return;
    this.ensureArray(this.pass, tex.arr | 0);
    const light = this.lights[i];
    const sl = (light & 15) / 15, bl = ((light >> 4) & 15) / 15;
    const facing = meta & 3; // 0 north 1 east 2 south 3 west
    const t = 0.125;
    let verts;
    switch (facing) {
      case 0: verts = [[0, 0, t, 0, 1], [1, 0, t, 1, 1], [1, 1, t, 1, 0], [0, 1, t, 0, 0]]; break;
      case 1: verts = [[1 - t, 0, 0, 0, 1], [1 - t, 0, 1, 1, 1], [1 - t, 1, 1, 1, 0], [1 - t, 1, 0, 0, 0]]; break;
      case 2: verts = [[0, 0, 1 - t, 0, 1], [1, 0, 1 - t, 1, 1], [1, 1, 1 - t, 1, 0], [0, 1, 1 - t, 0, 0]]; break;
      default: verts = [[t, 0, 0, 0, 1], [t, 0, 1, 1, 1], [t, 1, 1, 1, 0], [t, 1, 0, 0, 0]]; break;
    }
    const order = [0, 1, 2, 0, 2, 3];
    for (let k = 0; k < 6; k++) {
      const vt = verts[order[k]];
      const o = this.push(this.pass, tex.arr | 0, 1);
      const buf = this.out[this.pass][tex.arr | 0];
      buf[o] = Math.round((x + vt[0]) * 255 / 16);
      buf[o + 1] = Math.round((y + vt[1]) * 255 / 16);
      buf[o + 2] = Math.round((z + vt[2]) * 255 / 16);
      buf[o + 3] = Math.round(vt[3] * 255);
      buf[o + 4] = Math.round(vt[4] * 255);
      buf[o + 5] = tex.layer;
      buf[o + 6] = 2;
      buf[o + 7] = 255;
      buf[o + 8] = Math.round(bl * 255);
      buf[o + 9] = Math.round(sl * 255);
      buf[o + 10] = 0; buf[o + 11] = 0;
    }
    this.stats.faces++;
  }
}

export default ChunkMesher;
