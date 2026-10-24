/**
 * Ultracraft - debug / selection line renderer (block outlines, hitboxes,
 * chunk borders, path visualisation).
 */

import { createBuffer, bindVAO, setDepthTest, setDepthMask, setBlend } from './gl.js';

const STRIDE = 16;   // 3 x f32 position + 4 x u8 colour

export class LineRenderer {
  constructor(gl, program, capacity = 4096) {
    this.gl = gl;
    this.program = program;
    this.capacity = capacity;
    this.buf = new ArrayBuffer(capacity * STRIDE);
    this.f32 = new Float32Array(this.buf);
    this.u8 = new Uint8Array(this.buf);
    this.vcount = 0;
    this.vbo = createBuffer(gl.ARRAY_BUFFER, this.buf, gl.DYNAMIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, STRIDE, 12);
    gl.bindVertexArray(null);
  }

  clear() { this.vcount = 0; }

  line(x0, y0, z0, x1, y1, z1, color) {
    if (this.vcount + 2 > this.capacity) return;
    this.vertex(x0, y0, z0, color);
    this.vertex(x1, y1, z1, color);
  }

  vertex(x, y, z, color) {
    const o = this.vcount * (STRIDE / 4), b = this.vcount * STRIDE;
    this.f32[o] = x; this.f32[o + 1] = y; this.f32[o + 2] = z;
    this.u8[b + 12] = color[0]; this.u8[b + 13] = color[1];
    this.u8[b + 14] = color[2]; this.u8[b + 15] = color[3] === undefined ? 255 : color[3];
    this.vcount++;
  }

  /** Wireframe box (used for the block selection outline). */
  box(x0, y0, z0, x1, y1, z1, color) {
    const c = [
      [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
      [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
    ];
    const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (const [a, b] of E) this.line(c[a][0], c[a][1], c[a][2], c[b][0], c[b][1], c[b][2], color);
  }

  /** Axis aligned box that follows a non-cube block's collision shape. */
  aabb(a, color) { this.box(a[0], a[1], a[2], a[3], a[4], a[5], color); }

  flush(renderer) {
    if (!this.vcount) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.u8, 0, this.vcount * STRIDE);
    const prog = this.program.use();
    prog.um4('uViewProj', renderer.camera.viewProj);
    setBlend(true, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    setDepthTest(true); setDepthMask(false);
    bindVAO(this.vao);
    gl.drawArrays(gl.LINES, 0, this.vcount);
    setBlend(false); setDepthMask(true);
    renderer.stats.drawCalls++;
    this.vcount = 0;
  }
}

export default LineRenderer;
