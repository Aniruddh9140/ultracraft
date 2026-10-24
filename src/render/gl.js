/**
 * Ultracraft - tiny WebGL2 helper layer.
 *
 * Deliberately not a scene graph: it is a thin, allocation-free wrapper that
 * caches GL state (the #2 cause of CPU-side slowness on mobile drivers after
 * buffer uploads) and gives readable errors when a shader fails to compile.
 */

export class GLError extends Error {}

let gl = null;
export function setContext(ctx) { gl = ctx; }
export function getContext() { return gl; }

// ---------------------------------------------------------------------------
//  shaders
// ---------------------------------------------------------------------------
function compile(type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || '';
    const lines = src.split('\n');
    const m = /:(\d+):/.exec(log);
    let ctx2 = '';
    if (m) {
      const ln = parseInt(m[1], 10);
      for (let i = Math.max(0, ln - 4); i < Math.min(lines.length, ln + 3); i++) {
        ctx2 += (i + 1 === ln ? '>> ' : '   ') + (i + 1) + ': ' + lines[i] + '\n';
      }
    }
    gl.deleteShader(sh);
    throw new GLError(`[${label}] shader compile failed:\n${log}\n${ctx2}`);
  }
  return sh;
}

export class Program {
  constructor(vsSrc, fsSrc, label = 'program') {
    this.label = label;
    const vs = compile(gl.VERTEX_SHADER, vsSrc, label + '.vert');
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc, label + '.frag');
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new GLError(`[${label}] link failed: ${gl.getProgramInfoLog(p)}`);
    }
    gl.deleteShader(vs); gl.deleteShader(fs);
    this.prog = p;
    this.uniforms = new Map();
    // introspect uniforms
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      this.uniforms.set(name, gl.getUniformLocation(p, name));
    }
  }
  use() { if (state.program !== this) { gl.useProgram(this.prog); state.program = this; } return this; }
  loc(name) {
    const l = this.uniforms.get(name);
    if (l === undefined) { /* silently ignore unknown uniforms (drivers strip unused ones) */ }
    return l;
  }
  u1i(name, v) { const l = this.loc(name); if (l) gl.uniform1i(l, v); return this; }
  u1f(name, v) { const l = this.loc(name); if (l) gl.uniform1f(l, v); return this; }
  u2f(name, x, y) { const l = this.loc(name); if (l) gl.uniform2f(l, x, y); return this; }
  u3f(name, x, y, z) { const l = this.loc(name); if (l) gl.uniform3f(l, x, y, z); return this; }
  u4f(name, x, y, z, w) { const l = this.loc(name); if (l) gl.uniform4f(l, x, y, z, w); return this; }
  u2fv(name, v) { const l = this.loc(name); if (l) gl.uniform2fv(l, v); return this; }
  u3fv(name, v) { const l = this.loc(name); if (l) gl.uniform3fv(l, v); return this; }
  u4fv(name, v) { const l = this.loc(name); if (l) gl.uniform4fv(l, v); return this; }
  um4(name, v) { const l = this.loc(name); if (l) gl.uniformMatrix4fv(l, false, v); return this; }
  um4v(name, v) { const l = this.loc(name); if (l) gl.uniformMatrix4fv(l, false, v); return this; }
  dispose() { gl.deleteProgram(this.prog); }
}

// ---------------------------------------------------------------------------
//  state cache
// ---------------------------------------------------------------------------
const state = {
  program: null,
  depthTest: null, depthMask: null, depthFunc: null,
  cull: null, cullFace: null,
  blend: null, blendSrc: 0, blendDst: 0, blendSrcA: 0, blendDstA: 0,
  activeTex: 0,
  vao: null,
  colorMask: [true, true, true, true],
};

export function setDepthTest(on) { if (state.depthTest !== on) { on ? gl.enable(gl.DEPTH_TEST) : gl.disable(gl.DEPTH_TEST); state.depthTest = on; } }
export function setDepthMask(on) { if (state.depthMask !== on) { gl.depthMask(on); state.depthMask = on; } }
export function setDepthFunc(f) { if (state.depthFunc !== f) { gl.depthFunc(f); state.depthFunc = f; } }
export function setCull(on, face = gl.BACK) {
  if (state.cull !== on) { on ? gl.enable(gl.CULL_FACE) : gl.disable(gl.CULL_FACE); state.cull = on; }
  if (on && state.cullFace !== face) { gl.cullFace(face); state.cullFace = face; }
}
export function setBlend(on, src = gl.SRC_ALPHA, dst = gl.ONE_MINUS_SRC_ALPHA, srcA = gl.ONE, dstA = gl.ONE_MINUS_SRC_ALPHA) {
  if (state.blend !== on) { on ? gl.enable(gl.BLEND) : gl.disable(gl.BLEND); state.blend = on; }
  if (on && (state.blendSrc !== src || state.blendDst !== dst || state.blendSrcA !== srcA || state.blendDstA !== dstA)) {
    gl.blendFuncSeparate(src, dst, srcA, dstA);
    state.blendSrc = src; state.blendDst = dst; state.blendSrcA = srcA; state.blendDstA = dstA;
  }
}
export function setColorMask(r, g, b, a) {
  if (state.colorMask[0] !== r || state.colorMask[1] !== g || state.colorMask[2] !== b || state.colorMask[3] !== a) {
    gl.colorMask(r, g, b, a);
    state.colorMask[0] = r; state.colorMask[1] = g; state.colorMask[2] = b; state.colorMask[3] = a;
  }
}
export function bindVAO(v) { if (state.vao !== v) { gl.bindVertexArray(v); state.vao = v; } }
export function resetState() {
  state.program = null; state.vao = null; state.depthTest = null; state.depthMask = null;
  state.cull = null; state.blend = null; state.colorMask = [true, true, true, true];
}

// ---------------------------------------------------------------------------
//  textures
// ---------------------------------------------------------------------------
export function createTexture2D(w, h, opts = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  const internal = opts.internal || gl.RGBA8;
  const format = opts.format || gl.RGBA;
  const type = opts.type || gl.UNSIGNED_BYTE;
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, opts.data || null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.min || gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, opts.mag || gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, opts.wrap || gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, opts.wrap || gl.CLAMP_TO_EDGE);
  if (opts.maxAniso) gl.texParameterf(gl.TEXTURE_2D, 0x84FE, opts.maxAniso);
  return { tex: t, w, h, target: gl.TEXTURE_2D };
}

/** Array texture built from equally sized layers. */
export function createTextureArray(size, layers, opts = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
  const internal = opts.internal || gl.RGBA8;
  const format = opts.format || gl.RGBA;
  const type = opts.type || gl.UNSIGNED_BYTE;
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, internal, size, size, layers, 0, format, type, null);
  const wrap = opts.wrap || (opts.tile ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, wrap);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, opts.min || gl.NEAREST_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, opts.mag || gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_BASE_LEVEL, 0);
  if (opts.aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, 0x84FE, opts.aniso);
  return { tex: t, size, layers, target: gl.TEXTURE_2D_ARRAY };
}

export function uploadLayer(ta, index, data) {
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, ta.tex);
  gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, index, ta.size, ta.size, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
}

export function generateArrayMips(ta) {
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, ta.tex);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
}

export function bindTexture(unit, texObj) {
  if (state.activeTex !== unit) { gl.activeTexture(gl.TEXTURE0 + unit); state.activeTex = unit; }
  gl.bindTexture(texObj.target, texObj.tex);
}

// ---------------------------------------------------------------------------
//  framebuffers
// ---------------------------------------------------------------------------
export class Framebuffer {
  constructor(w, h, opts = {}) {
    this.w = w; this.h = h;
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    this.targets = [];
    const count = opts.colorCount || 1;
    for (let i = 0; i < count; i++) {
      const t = createTexture2D(w, h, {
        internal: opts.internal || gl.RGBA8,
        format: opts.format || gl.RGBA,
        type: opts.type || gl.UNSIGNED_BYTE,
        min: opts.min || gl.LINEAR, mag: opts.mag || gl.LINEAR,
      });
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t.tex, 0);
      this.targets.push(t);
    }
    this.depth = null;
    if (opts.depth !== false) {
      const dt = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, dt);
      gl.texImage2D(gl.TEXTURE_2D, 0, opts.depthInternal || gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, dt, 0);
      this.depth = { tex: dt, w, h, target: gl.TEXTURE_2D };
    }
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new GLError('Framebuffer incomplete: 0x' + status.toString(16) + ' (' + w + 'x' + h + ')');
    }
  }
  bind() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.w, this.h);
  }
  resize(w, h) {
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    for (const t of this.targets) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      t.w = w; t.h = h;
    }
    if (this.depth) {
      gl.bindTexture(gl.TEXTURE_2D, this.depth.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      this.depth.w = w; this.depth.h = h;
    }
  }
  dispose() {
    gl.deleteFramebuffer(this.fbo);
    for (const t of this.targets) gl.deleteTexture(t.tex);
    if (this.depth) gl.deleteTexture(this.depth.tex);
  }
}

// ---------------------------------------------------------------------------
//  buffers
// ---------------------------------------------------------------------------
export function createBuffer(target, data, usage = gl.STATIC_DRAW) {
  const b = gl.createBuffer();
  gl.bindBuffer(target, b);
  if (data) gl.bufferData(target, data, usage);
  return b;
}

export function createVAO(spec) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  for (const a of spec) {
    gl.bindBuffer(gl.ARRAY_BUFFER, a.buffer);
    gl.enableVertexAttribArray(a.location);
    if (a.integer) gl.vertexAttribIPointer(a.location, a.size, a.type, a.stride, a.offset);
    else gl.vertexAttribPointer(a.location, a.size, a.type, a.normalized || false, a.stride, a.offset);
    if (a.divisor) gl.vertexAttribDivisor(a.location, a.divisor);
  }
  gl.bindVertexArray(null);
  return vao;
}

// ---------------------------------------------------------------------------
//  misc
// ---------------------------------------------------------------------------
export function checkError(label) {
  const e = gl.getError();
  if (e !== gl.NO_ERROR) console.warn('GL error', e.toString(16), 'at', label);
  return e;
}

export function supports(name) {
  switch (name) {
    case 'float_render': return !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    case 'aniso': return !!gl.getExtension('EXT_texture_filter_anisotropic');
    default: return !!gl.getExtension(name);
  }
}

export function maxAnisotropy() {
  const ext = gl.getExtension('EXT_texture_filter_anisotropic');
  return ext ? gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
}

export function maxArrayLayers() { return gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS); }
export function maxTextureSize() { return gl.getParameter(gl.MAX_TEXTURE_SIZE); }

/** Fullscreen triangle VAO (no vertex buffer needed). */
export function createFullscreenVAO(location = 0) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

export function drawFullscreen(vao) {
  bindVAO(vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
