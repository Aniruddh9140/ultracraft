/**
 * Ultracraft - particle system.
 *
 * Camera-facing quads built on the CPU into one dynamic buffer, drawn in a
 * single call.  Particles cover block break debris, explosion smoke, rain,
 * bubbles, campfire sparks, crit sparks, enchantment runes and more.
 */

import { createBuffer, bindVAO, bindTexture, setDepthTest, setDepthMask, setCull, setBlend } from './gl.js';

const STRIDE = 24;
// 0..11  position (3 x f32)
// 12..13 uv (2 x u8)
// 14..17 colour (4 x u8)
// 18     texture layer (u8, 255 = solid colour)
// 19..20 block/sky light (2 x u8)

export class ParticleRenderer {
  constructor(gl, program, max = 800) {
    this.gl = gl;
    this.program = program;
    this.max = max;
    this.parts = [];
    this.capacity = Math.max(512, max) * 4;
    this.buf = new ArrayBuffer(this.capacity * STRIDE);
    this.f32 = new Float32Array(this.buf);
    this.u8 = new Uint8Array(this.buf);
    this.vcount = 0;
    this.vbo = createBuffer(gl.ARRAY_BUFFER, this.buf, gl.DYNAMIC_DRAW);
    this.ibo = createBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIndices(this.capacity / 4), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.UNSIGNED_BYTE, true, STRIDE, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, STRIDE, 14);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.UNSIGNED_BYTE, true, STRIDE, 18);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 2, gl.UNSIGNED_BYTE, true, STRIDE, 19);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bindVertexArray(null);
  }

  clear() { this.parts.length = 0; }

  /**
   * opts: {pos, vel, size, life, color, tex:{arr,layer}, gravity, drag,
   *        fade, glow, rotation, light}
   */
  spawn(opts) {
    if (this.parts.length >= this.max) this.parts.shift();
    this.parts.push(Object.assign({
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      size: 0.12, life: 1, maxLife: 1, color: [255, 255, 255, 255],
      tex: null, gravity: -9.8, drag: 0.98, glow: 0, rot: 0, rotSpeed: 0,
      light: [15, 15], collide: false, bounce: 0.2, shrink: 0,
    }, opts, { maxLife: opts.life || 1 }));
  }

  /** Explosion-ish burst of block debris. */
  burst(x, y, z, count, color, tex, speed = 4, size = 0.09) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = (Math.random() - 0.2) * Math.PI * 0.5;
      const s = speed * (0.3 + Math.random() * 0.7);
      this.spawn({
        x: x + (Math.random() - 0.5) * 0.6, y: y + (Math.random() - 0.5) * 0.6, z: z + (Math.random() - 0.5) * 0.6,
        vx: Math.cos(a) * Math.cos(e) * s, vy: Math.sin(e) * s + 1.5, vz: Math.sin(a) * Math.cos(e) * s,
        size: size * (0.6 + Math.random() * 0.8), life: 0.7 + Math.random() * 0.9,
        color, tex, gravity: -14, drag: 0.94, collide: true, bounce: 0.25,
      });
    }
  }

  update(dt, world) {
    const ps = this.parts;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) { ps.splice(i, 1); continue; }
      p.vy += p.gravity * dt;
      const dr = Math.pow(p.drag, dt * 60);
      p.vx *= dr; p.vy *= dr; p.vz *= dr;
      let nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + p.vz * dt;
      if (p.collide && world) {
        if (world.isSolid(Math.floor(nx), Math.floor(p.y), Math.floor(p.z))) { p.vx *= -p.bounce; nx = p.x; }
        if (world.isSolid(Math.floor(p.x), Math.floor(ny), Math.floor(p.z))) { p.vy *= -p.bounce; ny = p.y; p.vx *= 0.7; p.vz *= 0.7; }
        if (world.isSolid(Math.floor(p.x), Math.floor(p.y), Math.floor(nz))) { p.vz *= -p.bounce; nz = p.z; }
      }
      p.x = nx; p.y = ny; p.z = nz;
      p.rot += p.rotSpeed * dt;
    }
  }

  flush(renderer) {
    const gl = this.gl;
    const cam = renderer.camera;
    // camera basis
    const yaw = cam.yaw, pitch = cam.pitch;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const fx = -sy * cp, fy = sp, fz = -cy * cp;
    const rx = cy, ry = 0, rz = -sy;
    const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;

    let v = 0;
    const f32 = this.f32, u8 = this.u8;
    for (const p of this.parts) {
      if ((v + 4) * STRIDE > this.buf.byteLength) break;
      const s = p.size * (p.shrink ? Math.max(0.05, p.life / p.maxLife) : 1);
      let alpha = p.color[3] === undefined ? 255 : p.color[3];
      const fadeStart = Math.min(0.4, p.maxLife * 0.4);
      if (p.life < fadeStart) alpha = alpha * (p.life / fadeStart);
      const cr = Math.cos(p.rot), sr = Math.sin(p.rot);
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      const layer = p.tex ? p.tex.layer : 255;
      for (let i = 0; i < 4; i++) {
        const cxx = corners[i][0] * s, cyy = corners[i][1] * s;
        const rx2 = cxx * cr - cyy * sr, ry2 = cxx * sr + cyy * cr;
        const wx = p.x + rx * rx2 + ux * ry2;
        const wy = p.y + ry * rx2 + uy * ry2;
        const wz = p.z + rz * rx2 + uz * ry2;
        const o = v * (STRIDE / 4), b = v * STRIDE;
        f32[o] = wx; f32[o + 1] = wy; f32[o + 2] = wz;
        u8[b + 12] = corners[i][0] < 0 ? 0 : 255;
        u8[b + 13] = corners[i][1] < 0 ? 0 : 255;
        u8[b + 14] = p.color[0]; u8[b + 15] = p.color[1]; u8[b + 16] = p.color[2]; u8[b + 17] = alpha;
        u8[b + 18] = layer;
        u8[b + 19] = Math.round((p.light[0] / 15) * 255);
        u8[b + 20] = Math.round((p.light[1] / 15) * 255);
        v++;
      }
    }
    this.vcount = v;
    if (!v) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.u8, 0, v * STRIDE);
    const prog = this.program.use();
    renderer.updateSharedLightUniforms(prog);
    prog.u1i('uAlbedo', 0);
    bindTexture(0, renderer.textures.blockArrays[0]);
    setCull(false);
    setDepthTest(true); setDepthMask(false);
    setBlend(true, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    bindVAO(this.vao);
    gl.drawElements(gl.TRIANGLES, (v / 4) * 6, gl.UNSIGNED_SHORT, 0);
    setBlend(false); setDepthMask(true);
    renderer.stats.drawCalls++;
    renderer.stats.particles = this.parts.length;
  }
}

function quadIndices(quads) {
  const idx = new Uint16Array(quads * 6);
  for (let i = 0; i < quads; i++) {
    const v = i * 4, o = i * 6;
    idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
    idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
  }
  return idx;
}

export default ParticleRenderer;
