/**
 * Ultracraft - entity renderer.
 *
 * All entity geometry is built on the CPU into one dynamic vertex buffer and
 * drawn with a single indexed draw call (plus one for the soft ground
 * shadows).  That is dramatically cheaper than hundreds of tiny draw calls on
 * mobile drivers and lets us animate every limb for free.
 *
 * Vertex layout (32 bytes):
 *   0..11   position (3 x f32)
 *   12..14  normal (3 x i8, normalised)
 *   15      texture layer (u8, 255 = use vertex colour only)
 *   16..19  colour (4 x u8, normalised)
 *   20..21  uv (2 x u8, normalised)
 *   22..23  block light, sky light (2 x u8, normalised)
 */

import { createBuffer, bindVAO, bindTexture, setDepthTest, setDepthMask, setCull, setBlend } from './gl.js';

const STRIDE = 32;
const NO_TEX = 255;

export class EntityRenderer {
  constructor(gl, program) {
    this.gl = gl;
    this.program = program;
    this.maxBoxes = 2700;   // 2700 * 24 = 64800 < 65536 (uint16 indices)
    this.vertsPerBox = 24;
    this.parts = [];        // queued boxes {x,y,z,sx,sy,sz,yaw,pitch,color,tex,light,faces}
    this.shadowQuads = [];
    this.capacity = 2700 * 24;
    this.buf = new ArrayBuffer(this.capacity * STRIDE);
    this.f32 = new Float32Array(this.buf);
    this.u8 = new Uint8Array(this.buf);
    this.vcount = 0;
    this.vbo = createBuffer(gl.ARRAY_BUFFER, this.buf, gl.DYNAMIC_DRAW);
    this.ibo = createBuffer(gl.ELEMENT_ARRAY_BUFFER, buildIndices(this.maxBoxes), gl.STATIC_DRAW);
    this.vao = this.makeVAO();
    // shadow geometry
    this.shadowCapacity = 2048;
    this.sbuf = new ArrayBuffer(this.shadowCapacity * STRIDE);
    this.sf32 = new Float32Array(this.sbuf);
    this.su8 = new Uint8Array(this.sbuf);
    this.scount = 0;
    this.svbo = createBuffer(gl.ARRAY_BUFFER, this.sbuf, gl.DYNAMIC_DRAW);
    this.svao = this.makeVAOFor(this.svbo);
    this.stats = { boxes: 0, verts: 0 };
  }

  makeVAOFor(vbo) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.BYTE, true, STRIDE, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, STRIDE, 16);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.UNSIGNED_BYTE, true, STRIDE, 20);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.UNSIGNED_BYTE, true, STRIDE, 15);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 2, gl.UNSIGNED_BYTE, true, STRIDE, 22);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bindVertexArray(null);
    return vao;
  }
  makeVAO() { return this.makeVAOFor(this.vbo); }

  begin() { this.parts.length = 0; this.shadowQuads.length = 0; }

  /**
   * Queue a rotated box.
   * part = {pos:[x,y,z], size:[w,h,d], rot:[yaw,pitch,roll], pivot:[x,y,z],
   *         color:[r,g,b,a], tex:{arr,layer}|null, uv:[u0,v0,u1,v1], light:[block,sky],
   *         tint:[r,g,b]}
   */
  box(part) {
    if (this.parts.length >= this.maxBoxes) return;
    this.parts.push(part);
  }

  /** Ground blob shadow (a flat quad). */
  blobShadow(x, y, z, r, strength = 0.32) {
    if (this.shadowQuads.length > 400) return;
    this.shadowQuads.push({ x, y, z, r, strength });
  }

  /** Build the GPU buffers for everything queued this frame. */
  flush(renderer, world) {
    const gl = this.gl;
    this.buildVertices(world);
    if (!this.vcount) return;
    const prog = this.program.use();
    renderer.updateSharedLightUniforms(prog);
    prog.u1i('uAlbedo', 0);
    prog.u1i('uMaterial', 2);
    prog.u1i('uAlphaTest', 1);
    prog.u4f('uTint', 1, 1, 1, 1);
    prog.u1f('uFlash', 0);
    bindTexture(0, renderer.textures.blockArrays[0]);
    bindTexture(2, renderer.textures.materialTex);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.u8, 0, this.vcount * STRIDE);
    setCull(true, gl.BACK);
    setDepthTest(true); setDepthMask(true); setBlend(false);
    bindVAO(this.vao);
    gl.drawElements(gl.TRIANGLES, (this.vcount / this.vertsPerBox) * 36, gl.UNSIGNED_SHORT, 0);
    renderer.stats.drawCalls++;

    // ground shadows
    if (this.scount && renderer.quality.entityShadows) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.svbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.su8, 0, this.scount * STRIDE);
      setBlend(true, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      setDepthMask(false);
      bindVAO(this.svao);
      gl.drawElements(gl.TRIANGLES, (this.scount / 4) * 6, gl.UNSIGNED_SHORT, 0);
      setDepthMask(true);
      setBlend(false);
      renderer.stats.drawCalls++;
    }
  }

  buildVertices(world) {
    let v = 0;
    const f32 = this.f32, u8 = this.u8;
    for (const p of this.parts) v = this.emitBox(f32, u8, v, p, false);
    this.vcount = v;
    // shadows
    let s = 0;
    const sf = this.sf32, su = this.su8;
    for (const q of this.shadowQuads) s = this.emitBlob(sf, su, s, q);
    this.scount = s;
    this.stats.boxes = this.parts.length;
    this.stats.verts = v;
  }

  emitBox(f32, u8, v, p, isShadow) {
    const [px, py, pz] = p.pos;
    const [w, h, d] = p.size;
    const rot = p.rot || [0, 0, 0];
    const pivot = p.pivot || [0, 0, 0];
    const col = p.color || [255, 255, 255, 255];
    const uvRect = p.uv || [0, 0, 1, 1];
    const light = p.light || [15, 15];
    const tex = p.tex ? (p.tex.layer | 0) : NO_TEX;
    const x0 = -w / 2 - pivot[0], x1 = w / 2 - pivot[0];
    const y0 = -pivot[1], y1 = h - pivot[1];
    const z0 = -d / 2 - pivot[2], z1 = d / 2 - pivot[2];
    const cy = Math.cos(rot[0]), sy = Math.sin(rot[0]);
    const cp = Math.cos(rot[1] || 0), sp = Math.sin(rot[1] || 0);
    const cr = Math.cos(rot[2] || 0), sr = Math.sin(rot[2] || 0);

    // 24 verts (4 per face), 6 faces
    for (let f = 0; f < 6; f++) {
      const fd = FACES[f];
      for (let c = 0; c < 4; c++) {
        let lx = fd.corners[c][0] === 0 ? x0 : x1;
        let ly = fd.corners[c][1] === 0 ? y0 : y1;
        let lz = fd.corners[c][2] === 0 ? z0 : z1;
        // rotate R = Ry * Rx * Rz
        let ax = cr * lx - sr * ly, ay = sr * lx + cr * ly, az = lz;
        let bx = ax, by = cp * ay - sp * az, bz = sp * ay + cp * az;
        let cx2 = cy * bx + sy * bz, cz2 = -sy * bx + cy * bz;
        const wx = px + cx2, wy = py + by, wz = pz + cz2;
        // normal
        let nx = fd.n[0], ny = fd.n[1], nz = fd.n[2];
        let n1x = cr * nx - sr * ny, n1y = sr * nx + cr * ny, n1z = nz;
        let n2x = n1x, n2y = cp * n1y - sp * n1z, n2z = sp * n1y + cp * n1z;
        let n3x = cy * n2x + sy * n2z, n3z = -sy * n2x + cy * n2z;

        if ((v + 1) * STRIDE > this.buf.byteLength) return v;
        const o = v * (STRIDE / 4);
        f32[o] = wx; f32[o + 1] = wy; f32[o + 2] = wz;
        const b = v * STRIDE;
        u8[b + 12] = Math.round(n3x * 127);
        u8[b + 13] = Math.round(n2y * 127);
        u8[b + 14] = Math.round(n3z * 127);
        u8[b + 15] = tex;
        const cc = p.faceColor ? (p.faceColor[f] || col) : col;
        u8[b + 16] = cc[0]; u8[b + 17] = cc[1]; u8[b + 18] = cc[2]; u8[b + 19] = cc[3] === undefined ? 255 : cc[3];
        const u = fd.uv[c][0] ? uvRect[2] : uvRect[0];
        const vv = fd.uv[c][1] ? uvRect[3] : uvRect[1];
        u8[b + 20] = Math.round(u * 255);
        u8[b + 21] = Math.round(vv * 255);
        u8[b + 22] = Math.round((light[0] / 15) * 255);
        u8[b + 23] = Math.round((light[1] / 15) * 255);
        v++;
        if (v * STRIDE > this.buf.byteLength) return v;
      }
    }
    return v;
  }

  emitBlob(f32, u8, v, q) {
    const col = [0, 0, 0, Math.round(q.strength * 255)];
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let i = 0; i < 4; i++) {
      const c = corners[i];
      if ((v + 1) * STRIDE > this.sbuf.byteLength) return v;
      const o = v * (STRIDE / 4), b = v * STRIDE;
      f32[o] = q.x + c[0] * q.r; f32[o + 1] = q.y + 0.02; f32[o + 2] = q.z + c[1] * q.r;
      u8[b + 12] = 0; u8[b + 13] = 127; u8[b + 14] = 0;
      u8[b + 15] = NO_TEX;
      u8[b + 16] = col[0]; u8[b + 17] = col[1]; u8[b + 18] = col[2]; u8[b + 19] = col[3];
      u8[b + 20] = 0; u8[b + 21] = 0;
      u8[b + 22] = 255; u8[b + 23] = 255;
      v++;
    }
    return v;
  }
}

const FACES = [
  { n: [1, 0, 0], corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], uv: [[0, 1], [1, 1], [1, 0], [0, 0]] },
  { n: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], uv: [[0, 1], [1, 1], [1, 0], [0, 0]] },
  { n: [0, 1, 0], corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], uv: [[0, 0], [0, 1], [1, 1], [1, 0]] },
  { n: [0, -1, 0], corners: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]], uv: [[0, 0], [0, 1], [1, 1], [1, 0]] },
  { n: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], uv: [[0, 1], [1, 1], [1, 0], [0, 0]] },
  { n: [0, 0, -1], corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], uv: [[0, 1], [1, 1], [1, 0], [0, 0]] },
];

function buildIndices(maxBoxes) {
  const idx = new Uint16Array(maxBoxes * 36);
  let o = 0;
  for (let b = 0; b < maxBoxes; b++) {
    const base = b * 24;
    for (let f = 0; f < 6; f++) {
      const v0 = base + f * 4;
      idx[o++] = v0; idx[o++] = v0 + 1; idx[o++] = v0 + 2;
      idx[o++] = v0; idx[o++] = v0 + 2; idx[o++] = v0 + 3;
    }
  }
  return idx;
}

export default EntityRenderer;
