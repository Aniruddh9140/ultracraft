/**
 * Ultracraft - deferred-ish forward renderer.
 *
 * Frame graph
 *   1. shadow pass          cascaded sun shadow map (chunk geometry only)
 *   2. sky                  analytic atmosphere + sun/moon/stars + clouds
 *   3. opaque / cutout      voxel geometry, front to back
 *   4. entities + particles dynamic CPU-built geometry, one draw call each
 *   5. refraction copy      half res copy of the framebuffer for water
 *   6. reflection           optional planar reflection (mirrored camera)
 *   7. water                fresnel + normal mapped + specular + foam
 *   8. translucent          glass & stained glass
 *   9. post                 bloom -> god rays -> ACES tonemap -> FXAA
 *
 * Every stage is optional and scales with the graphics preset so the same code
 * path runs at 15 fps on a phone and 200 fps on a desktop GPU.
 */

import {
  setContext, Program, Framebuffer, createVAO, createBuffer, createFullscreenVAO, drawFullscreen,
  bindTexture, setDepthTest, setDepthMask, setDepthFunc, setCull, setBlend, setColorMask, bindVAO,
  supports, checkError, resetState,
} from './gl.js';
import { SHADERS } from './shaders.js';
import { ChunkMesher } from './chunkmesher.js';
import { TextureManager } from './textures.js';
import { EntityRenderer } from './entityrenderer.js';
import { ParticleRenderer } from './particles.js';
import { LineRenderer } from './linerenderer.js';
import { Shape, Pass, getBlock, AIR } from '../world/blocks.js';
import { m4, m4identity, m4perspective, m4ortho, m4lookAt, m4mul, m4invert, v3, clamp, lerp, extractFrustum, aabbInFrustum } from '../core/math.js';

const CHUNK_STRIDE = 12;

export const QUALITY_PRESETS = {
  potato: {
    renderScale: 0.55, renderDistance: 6, shadows: 0, shadowRes: 512, shadowQuality: 0,
    bloom: 0, godrays: 0, clouds: 0, reflections: 0, refractions: 0, fxaa: 0,
    normalMaps: 0, mipBias: 0, textureSize: 16, smoothLighting: 1, entityShadows: 0, particles: 120,
  },
  fast: {
    renderScale: 0.75, renderDistance: 8, shadows: 1, shadowRes: 1024, shadowQuality: 1,
    bloom: 0, godrays: 0, clouds: 1, reflections: 0, refractions: 1, fxaa: 0,
    normalMaps: 1, mipBias: 0, textureSize: 16, smoothLighting: 1, entityShadows: 1, particles: 300,
  },
  fancy: {
    renderScale: 1.0, renderDistance: 12, shadows: 3, shadowRes: 2048, shadowQuality: 2,
    bloom: 1, godrays: 1, clouds: 1, reflections: 1, refractions: 1, fxaa: 1,
    normalMaps: 1, mipBias: 0, textureSize: 32, smoothLighting: 1, entityShadows: 1, particles: 800,
  },
  ultra: {
    renderScale: 1.0, renderDistance: 20, shadows: 3, shadowRes: 4096, shadowQuality: 2,
    bloom: 1, godrays: 1, clouds: 1, reflections: 1, refractions: 1, fxaa: 1,
    normalMaps: 1, mipBias: -0.4, textureSize: 64, smoothLighting: 1, entityShadows: 1, particles: 2000,
  },
};

export class Renderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: true, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
      desynchronized: true, failIfMajorPerformanceCaveat: false,
    });
    if (!gl) throw new Error('WebGL2 is required to run Ultracraft.');
    this.gl = gl;
    setContext(gl);
    this.hdr = supports('float_render');
    this.quality = Object.assign({}, QUALITY_PRESETS.fancy, opts.quality || {});
    this.width = canvas.width || 1;
    this.height = canvas.height || 1;
    this.renderScale = this.quality.renderScale;

    this.textures = new TextureManager(gl);
    this.mesher = null;
    this.world = null;
    this.camera = {
      pos: v3(0, 80, 0), yaw: 0, pitch: 0, fov: 70, near: 0.08, far: 1000,
      view: m4(), proj: m4(), viewProj: m4(), invViewProj: m4(),
    };

    this.shadow = {
      fbo: gl.createFramebuffer(), tex: null, size: 0, layers: 0,
      mats: [m4(), m4(), m4(), m4()], dists: [0, 0, 0, 0], biases: [0, 0, 0, 0],
    };
    this.stats = { drawCalls: 0, triangles: 0, chunks: 0, sections: 0, meshTime: 0, meshCount: 0, frameMs: 0 };
    this.time = 0;
    this.frustum = new Float32Array(24);
    this.tmpM = m4();
    this.sun = v3(0, 1, 0);
    this.moon = v3(0, -1, 0);
    this.colors = {
      sun: new Float32Array(3), moon: new Float32Array(3),
      zenith: new Float32Array(3), horizon: new Float32Array(3),
      ground: new Float32Array(3), fog: new Float32Array(3), torch: new Float32Array([1.0, 0.62, 0.30]),
    };
    this.chunkDrawList = [];
    this.sortTimer = 0;
    this.init();
  }

  // =========================================================================
  init() {
    const gl = this.gl;
    this.programs = {
      chunk: new Program(SHADERS.chunk.vert, SHADERS.chunk.frag, 'chunk'),
      chunkCutout: new Program(SHADERS.chunk.vert, SHADERS.chunkCutout.frag, 'chunkCutout'),
      chunkShadow: new Program(SHADERS.chunk.vert, SHADERS.chunkShadow.frag, 'chunkShadow'),
      water: new Program(SHADERS.water.vert, SHADERS.water.frag, 'water'),
      sky: new Program(SHADERS.sky.vert, SHADERS.sky.frag, 'sky'),
      entity: new Program(SHADERS.entity.vert, SHADERS.entity.frag, 'entity'),
      particle: new Program(SHADERS.particle.vert, SHADERS.particle.frag, 'particle'),
      line: new Program(SHADERS.line.vert, SHADERS.line.frag, 'line'),
      bright: new Program(SHADERS.bright.vert, SHADERS.bright.frag, 'bright'),
      blur: new Program(SHADERS.blur.vert, SHADERS.blur.frag, 'blur'),
      godray: new Program(SHADERS.godray.vert, SHADERS.godray.frag, 'godray'),
      composite: new Program(SHADERS.composite.vert, SHADERS.composite.frag, 'composite'),
      copy: new Program(SHADERS.post.vert, SHADERS.post.frag, 'copy'),
    };
    this.fsVAO = createFullscreenVAO(0);
    this.entityRenderer = new EntityRenderer(gl, this.programs.entity);
    this.particles = new ParticleRenderer(gl, this.programs.particle, this.quality.particles || 500);
    this.lines = new LineRenderer(gl, this.programs.line);
    this.createShadowMap(this.quality.shadowRes, Math.max(1, this.quality.shadows));
    this.allocTargets(this.width, this.height);
    resetState();
  }

  setWorld(world) {
    this.world = world;
    this.mesher = new ChunkMesher(world, this.textures.resolver());
    world.onChunkUnload = (c) => this.releaseChunkMeshes(c);
  }

  // -------------------------------------------------------------------------
  allocTargets(w, h) {
    const gl = this.gl;
    const rw = Math.max(1, Math.floor(w * this.renderScale));
    const rh = Math.max(1, Math.floor(h * this.renderScale));
    if (this.sceneFBO) { this.sceneFBO.dispose(); this.bloomA.dispose(); this.bloomB.dispose(); this.refractFBO.dispose(); this.godrayFBO.dispose(); if (this.reflFBO) this.reflFBO.dispose(); }
    const internal = this.hdr ? gl.RGBA16F : gl.RGBA8;
    const type = this.hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    this.sceneFBO = new Framebuffer(rw, rh, { internal, type, min: gl.LINEAR, mag: gl.LINEAR });
    this.refractFBO = new Framebuffer(Math.max(1, rw >> 1), Math.max(1, rh >> 1), { internal, type });
    this.godrayFBO = new Framebuffer(Math.max(1, rw >> 2), Math.max(1, rh >> 2), { internal, type });
    const bw = Math.max(1, rw >> 2), bh = Math.max(1, rh >> 2);
    this.bloomA = new Framebuffer(bw, bh, { internal, type, depth: false });
    this.bloomB = new Framebuffer(bw, bh, { internal, type, depth: false });
    if (this.quality.reflections) {
      this.reflFBO = new Framebuffer(Math.max(1, rw >> 1), Math.max(1, rh >> 1), { internal, type });
    }
    this.renderW = rw; this.renderH = rh;
  }

  resize(w, h, dpr = 1) {
    this.width = Math.max(1, Math.floor(w * dpr));
    this.height = Math.max(1, Math.floor(h * dpr));
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.allocTargets(this.width, this.height);
  }

  setQuality(name) {
    const preset = QUALITY_PRESETS[name];
    if (!preset) return;
    this.quality = Object.assign({}, preset);
    this.createShadowMap(this.quality.shadowRes, Math.max(1, this.quality.shadows));
    this.allocTargets(this.width, this.height);
    if (this.particles) this.particles.maxParticles = this.quality.particles;
  }

  rebuildTextures(size, quality) {
    this.textures.build(size, quality);
    if (this.world) this.mesher = new ChunkMesher(this.world, this.textures.resolver());
    if (this.world) for (const c of this.world.chunks.values()) { this.releaseChunkMeshes(c); this.markAllDirty(c); }
  }

  markAllDirty(chunk) {
    for (let i = 0; i < chunk.sectionCount; i++) chunk.meshDirty.add(i);
  }

  // =========================================================================
  //  shadow map
  // =========================================================================
  createShadowMap(size, layers) {
    const gl = this.gl;
    if (this.shadow.tex) gl.deleteTexture(this.shadow.tex);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.DEPTH_COMPONENT24, size, size, layers, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    this.shadow.tex = t;
    this.shadow.size = size;
    this.shadow.layers = layers;
    this.shadowTex = { tex: t, target: gl.TEXTURE_2D_ARRAY, w: size, h: size };
  }

  updateShadowMatrices() {
    const q = this.quality;
    const n = Math.max(1, Math.min(4, q.shadows | 0));
    const base = Math.max(24, (this.world ? this.world.renderDistance * 16 : 128) * 0.55);
    const radii = [base * 0.28, base * 0.6, base * 1.25, base * 2.2];
    const dists = [base * 0.3, base * 0.62, base * 1.3, base * 2.3];
    const p = this.camera.pos;
    const s = this.sun;
    for (let i = 0; i < n; i++) {
      const r = radii[i];
      // texel snapping kills shimmer
      const texel = (2 * r) / this.shadow.size;
      const eye = [p[0] + s[0] * (r + 60), p[1] + s[1] * (r + 60), p[2] + s[2] * (r + 60)];
      const snap = (v) => Math.floor(v / texel) * texel;
      const cx = snap(p[0]), cy = snap(p[1]), cz = snap(p[2]);
      const center = [cx, cy, cz];
      const view = m4lookAt(m4(), eye, center, Math.abs(s[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0]);
      const proj = m4ortho(m4(), -r, r, -r, r, 0.5, r * 2 + 140);
      m4mul(this.shadow.mats[i], proj, view);
      this.shadow.dists[i] = dists[i];
      this.shadow.biases[i] = 0.06 + r * 0.006;
    }
    this.shadow.count = n;
  }

  renderShadows() {
    const gl = this.gl;
    const q = this.quality;
    if (!q.shadows || !this.world) return;
    this.updateShadowMatrices();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadow.fbo);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.viewport(0, 0, this.shadow.size, this.shadow.size);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    setDepthTest(true); setDepthMask(true); setCull(false);
    const prog = this.programs.chunkShadow.use();
    prog.u1i('uAlbedo', 0);
    bindTexture(0, this.textures.blockArrays[0]);
    this.updateSharedLightUniforms(prog);
    let draws = 0;
    for (let i = 0; i < this.shadow.count; i++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, this.shadow.tex, 0, i);
      prog.um4('uViewProj', this.shadow.mats[i]);
      const r = this.shadow.dists[i];
      for (const c of this.world.chunks.values()) {
        if (!c.gpu) continue;
        const dx = c.cx * 16 + 8 - this.camera.pos[0], dz = c.cz * 16 + 8 - this.camera.pos[2];
        if (dx * dx + dz * dz > (r + 24) * (r + 24)) continue;
        this.drawChunkMeshes(c, prog, Pass.OPAQUE, true);
        this.drawChunkMeshes(c, prog, Pass.CUTOUT, true);
        draws++;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.drawBuffers([gl.BACK]);
    gl.readBuffer(gl.BACK);
    this.stats.shadowDraws = draws;
  }

  // =========================================================================
  //  chunk meshes
  // =========================================================================
  makeMeshVAO(buf) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.UNSIGNED_BYTE, true, CHUNK_STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.UNSIGNED_BYTE, true, CHUNK_STRIDE, 3);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_BYTE, CHUNK_STRIDE, 5);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_BYTE, CHUNK_STRIDE, 6);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 3, gl.UNSIGNED_BYTE, true, CHUNK_STRIDE, 7);
    gl.bindVertexArray(null);
    return vao;
  }

  /** Upload freshly meshed data for one chunk: result[pass][arrayIndex]. */
  uploadChunk(chunk, result) {
    const gl = this.gl;
    if (!chunk.gpu) chunk.gpu = { buffers: [], vaos: [], ranges: [] };
    const gpu = chunk.gpu;
    for (let p = 0; p < 4; p++) {
      const perArr = result[p] || [];
      for (let a = 0; a < 8; a++) {
        const slot = p * 8 + a;
        const data = perArr[a];
        if (!data || !data.data || data.vertexCount === 0) {
          if (gpu.buffers[slot]) {
            gl.deleteBuffer(gpu.buffers[slot]);
            if (gpu.vaos[slot]) gl.deleteVertexArray(gpu.vaos[slot]);
            gpu.buffers[slot] = null; gpu.vaos[slot] = null; gpu.ranges[slot] = null;
          }
          continue;
        }
        let buf = gpu.buffers[slot];
        if (!buf) {
          buf = gl.createBuffer();
          gpu.buffers[slot] = buf;
          gpu.vaos[slot] = this.makeMeshVAO(buf);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data.data, gl.STATIC_DRAW);
        gpu.ranges[slot] = data.ranges;
      }
    }
    chunk.meshDirty.clear();
    chunk.meshed = true;
  }

  releaseChunkMeshes(chunk) {
    const gl = this.gl;
    const gpu = chunk.gpu;
    if (!gpu) return;
    for (const b of gpu.buffers) if (b) gl.deleteBuffer(b);
    for (const v of gpu.vaos) if (v) gl.deleteVertexArray(v);
    chunk.gpu = null;
  }

  /** Mesh dirty sections within a millisecond budget. */
  updateMeshes(budgetMs = 4) {
    if (!this.world || !this.mesher) return;
    const t0 = performance.now();
    const chunks = this.world.meshableChunks();
    // nearest first
    const px = this.camera.pos[0], pz = this.camera.pos[2];
    chunks.sort((a, b) => {
      const da = (a.cx * 16 + 8 - px) ** 2 + (a.cz * 16 + 8 - pz) ** 2;
      const db = (b.cx * 16 + 8 - px) ** 2 + (b.cz * 16 + 8 - pz) ** 2;
      return da - db;
    });
    let meshed = 0;
    for (const c of chunks) {
      if (performance.now() - t0 > budgetMs) break;
      const result = this.meshChunk(c);
      this.uploadChunk(c, result);
      meshed++;
    }
    this.stats.meshTime = performance.now() - t0;
    this.stats.meshCount = meshed;
  }

  /**
   * Build all four render passes for a chunk.  The whole column is rebuilt
   * whenever any section is dirty: chunk meshes are small (a few hundred
   * quads) and this keeps both the buffer layout and the draw-call batching
   * trivial.
   */
  meshChunk(chunk) {
    const collected = [[], [], [], []];
    for (let sy = 0; sy < chunk.sectionCount; sy++) {
      const section = chunk.sections[sy];
      if (!section || section.nonAir === 0) continue;
      const res = this.mesher.build(chunk.cx, sy, chunk.cz);
      for (let p = 0; p < 4; p++) {
        const perArr = res[p];
        for (let a = 0; a < perArr.length; a++) {
          const d = perArr[a];
          if (!d || !d.vertexCount) continue;
          collected[p].push({ arr: a, data: d.data.slice(), count: d.vertexCount, sy });
        }
      }
    }
    const out = [];
    for (let p = 0; p < 4; p++) out.push(this.packPass(collected[p]));
    return out;
  }

  /** Merge per-section vertex runs into one buffer per texture array. */
  packPass(list) {
    if (!list.length) return [];
    const byArr = new Map();
    for (const item of list) {
      let e = byArr.get(item.arr);
      if (!e) { e = { arr: item.arr, runs: [], total: 0 }; byArr.set(item.arr, e); }
      e.runs.push(item);
      e.total += item.count;
    }
    const out = [];
    for (const e of byArr.values()) {
      const data = new Uint8Array(e.total * CHUNK_STRIDE);
      const ranges = [];
      let off = 0;
      e.runs.sort((a, b) => a.sy - b.sy);
      for (const r of e.runs) {
        data.set(r.data, off);
        ranges.push({ start: off / CHUNK_STRIDE, count: r.count, sy: r.sy });
        off += r.count * CHUNK_STRIDE;
      }
      out[e.arr] = { data, vertexCount: e.total, ranges };
    }
    return out;
  }

  // =========================================================================
  //  drawing
  // =========================================================================
  updateCamera(cam) {
    const c = this.camera;
    c.pos.set(cam.pos);
    c.yaw = cam.yaw; c.pitch = cam.pitch;
    c.fov = cam.fov ?? c.fov;
    c.near = cam.near ?? c.near;
    c.far = cam.far ?? c.far;
    const aspect = this.width / this.height;
    m4perspective(c.proj, c.fov * Math.PI / 180, aspect, c.near, c.far);
    // FPS view matrix
    const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
    const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    const fx = -sy * cp, fy = sp, fz = -cy * cp;
    const rx = cy, ry = 0, rz = -sy;
    const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
    const v = c.view;
    v[0] = rx; v[1] = ux; v[2] = -fx; v[3] = 0;
    v[4] = ry; v[5] = uy; v[6] = -fy; v[7] = 0;
    v[8] = rz; v[9] = uz; v[10] = -fz; v[11] = 0;
    v[12] = -(rx * c.pos[0] + ry * c.pos[1] + rz * c.pos[2]);
    v[13] = -(ux * c.pos[0] + uy * c.pos[1] + uz * c.pos[2]);
    v[14] = fx * c.pos[0] + fy * c.pos[1] + fz * c.pos[2];
    v[15] = 1;
    m4mul(c.viewProj, c.proj, c.view);
    m4invert(c.invViewProj, c.viewProj);
    extractFrustum(this.frustum, c.viewProj);
  }

  updateSkyAndTime(world, dt) {
    // sky colours driven by the time of day
    const t = (world.dayTime % 24000) / 24000;
    const theta = t * Math.PI * 2;                 // 0 = sunrise
    const sy = Math.sin(theta);
    const sun = this.sun, moon = this.moon;
    sun[0] = Math.cos(theta); sun[1] = sy; sun[2] = 0.18;
    const l = Math.hypot(sun[0], sun[1], sun[2]) || 1;
    sun[0] /= l; sun[1] /= l; sun[2] /= l;
    moon[0] = -sun[0]; moon[1] = -sun[1]; moon[2] = -sun[2];
    const day = clamp((sun[1] + 0.12) * 6, 0, 1);
    const dusk = clamp(1 - Math.abs(sun[1]) * 5, 0, 1);
    const night = 1 - day;
    this.nightFactor = night;
    const c = this.colors;
    // zenith
    setLerp(c.zenith, [0.015, 0.02, 0.05], [0.16, 0.36, 0.78], day);
    mixInto(c.zenith, [0.36, 0.24, 0.34], dusk * 0.65);
    setLerp(c.horizon, [0.03, 0.04, 0.09], [0.62, 0.76, 0.98], day);
    mixInto(c.horizon, [0.98, 0.48, 0.26], dusk * 0.8);
    setLerp(c.ground, [0.01, 0.012, 0.02], [0.28, 0.32, 0.36], day);
    setLerp(c.sun, [0.10, 0.14, 0.30], [1.25, 1.14, 0.95], day);
    mixInto(c.sun, [1.35, 0.65, 0.32], dusk * 0.85);
    c.fog.set(c.horizon);
    this.sunIntensity = 0.35 + day * 1.05;
    this.ambient = 0.09 + day * 0.12;
    this.fogDensity = 1.35 / (this.world.renderDistance * 16);
    this.underwater = this.isUnderwater(world) ? 1 : 0;
    this.waterColor = this.waterColor || new Float32Array([0.16, 0.38, 0.58]);
    this.deepColor = this.deepColor || new Float32Array([0.03, 0.12, 0.24]);
  }

  isUnderwater(world) {
    const p = this.camera.pos;
    const id = world.getBlock(Math.floor(p[0]), Math.floor(p[1] + 0.4), Math.floor(p[2]));
    return id !== AIR && getBlock(id).flow > 0;
  }

  updateSharedLightUniforms(prog) {
    const c = this.colors;
    prog.u3f('uSunDir', this.sun[0], this.sun[1], this.sun[2]);
    prog.u3f('uSunColor', c.sun[0], c.sun[1], c.sun[2]);
    prog.u3f('uSkyTop', c.zenith[0], c.zenith[1], c.zenith[2]);
    prog.u3f('uSkyHorizon', c.horizon[0], c.horizon[1], c.horizon[2]);
    prog.u3f('uTorchColor', c.torch[0], c.torch[1], c.torch[2]);
    prog.u3f('uFogColor', c.fog[0], c.fog[1], c.fog[2]);
    prog.u1f('uFogDensity', this.fogDensity);
    prog.u1f('uFogHeightFalloff', this.world ? (this.dimensionSeaLevel || 64) : 64);
    prog.u1f('uFogSunAmount', 1.0);
    prog.u1f('uAmbient', this.ambient);
    prog.u1f('uSunIntensity', this.sunIntensity);
    prog.u1f('uNightFactor', this.nightFactor);
    prog.u1f('uTime', this.time);
    prog.u3f('uCameraPos', this.camera.pos[0], this.camera.pos[1], this.camera.pos[2]);
    // shadows
    if (prog.loc('uShadowMap')) {
      prog.u1i('uShadowMap', 6);
      prog.u1i('uCascadeCount', this.quality.shadows ? this.shadow.count : 0);
      for (let i = 0; i < 4; i++) prog.um4(`uCascadeMat[${i}]`, this.shadow.mats[i]);
      this.shadow.distsF = this.shadow.distsF || new Float32Array(4);
      this.shadow.biasF = this.shadow.biasF || new Float32Array(4);
      for (let i = 0; i < 4; i++) { this.shadow.distsF[i] = this.shadow.dists[i]; this.shadow.biasF[i] = this.shadow.biases[i]; }
      if (prog.loc('uCascadeDist[0]')) prog.u4fv('uCascadeDist[0]', this.shadow.distsF);
      if (prog.loc('uCascadeBias[0]')) prog.u4fv('uCascadeBias[0]', this.shadow.biasF);
      prog.u1f('uShadowTexel', 1 / this.shadow.size);
      prog.u1i('uShadowQuality', this.quality.shadowQuality);
      prog.u1f('uShadowStrength', this.quality.shadows ? 0.82 : 0);
    }
  }

  bindArrayTextures(arrIdx) {
    bindTexture(0, this.textures.blockArrays[arrIdx] || this.textures.blockArrays[0]);
    bindTexture(1, this.textures.blockNormalArrays[arrIdx] || this.textures.blockNormalArrays[0]);
    bindTexture(2, this.textures.materialTex);
    bindTexture(6, this.shadowTex);
  }

  drawChunkMeshes(chunk, prog, pass, shadowPass = false) {
    const gpu = chunk.gpu;
    if (!gpu) return 0;
    const gl = this.gl;
    let verts = 0;
    for (let a = 0; a < 8; a++) {
      const slot = pass * 8 + a;
      const vao = gpu.vaos[slot];
      if (!vao) continue;
      const ranges = gpu.ranges[slot];
      if (!ranges || !ranges.length) continue;
      if (!shadowPass) bindVAO(vao);
      else bindVAO(vao);
      const bx = chunk.cx * 16, bz = chunk.cz * 16;
      let start = -1, count = 0, prevSy = -99;
      for (let r = 0; r < ranges.length; r++) {
        const rg = ranges[r];
        const y0 = rg.sy * 16, y1 = y0 + 16;
        const visible = shadowPass || aabbInFrustum(this.frustum, bx, y0, bz, bx + 16, y1, bz + 16);
        if (visible && rg.count > 0) {
          if (start < 0) { start = rg.start; count = 0; }
          count += rg.count;
          const isLast = r === ranges.length - 1;
          const nextVisible = !isLast && aabbInFrustum(this.frustum, bx, ranges[r + 1].sy * 16, bz, bx + 16, ranges[r + 1].sy * 16 + 16, bz + 16);
          if (!nextVisible) {
            gl.drawArrays(gl.TRIANGLES, start, count);
            this.stats.drawCalls++;
            verts += count;
            start = -1; count = 0;
          }
        } else if (start >= 0) {
          gl.drawArrays(gl.TRIANGLES, start, count);
          this.stats.drawCalls++;
          verts += count;
          start = -1; count = 0;
        }
      }
    }
    return verts;
  }

  buildDrawList() {
    const list = this.chunkDrawList;
    list.length = 0;
    if (!this.world) return list;
    const px = this.camera.pos[0], pz = this.camera.pos[2];
    for (const c of this.world.chunks.values()) {
      if (!c.generated || !c.gpu) continue;
      const dx = c.cx * 16 + 8 - px, dz = c.cz * 16 + 8 - pz;
      c._dist2 = dx * dx + dz * dz;
      if (c._dist2 > (this.world.renderDistance * 16 + 24) ** 2) continue;
      list.push(c);
    }
    list.sort((a, b) => a._dist2 - b._dist2);
    return list;
  }

  // =========================================================================
  //  frame
  // =========================================================================
  render(world, dt) {
    const gl = this.gl;
    const t0 = performance.now();
    this.time += dt;
    this.stats.drawCalls = 0; this.stats.triangles = 0;
    this.updateSkyAndTime(world, dt);

    this.renderShadows();

    // ---- main scene --------------------------------------------------------
    this.sceneFBO.bind();
    gl.viewport(0, 0, this.renderW, this.renderH);
    setDepthTest(false); setDepthMask(true); setCull(false); setBlend(false);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this.drawSky();

    setDepthTest(true); setDepthMask(true); setDepthFunc(gl.LEQUAL); setCull(true, gl.BACK);

    // opaque
    let prog = this.programs.chunk.use();
    this.updateSharedLightUniforms(prog);
    prog.u1i('uAlbedo', 0); prog.u1i('uNormalMap', 1); prog.u1i('uMaterial', 2);
    prog.u1i('uAlphaTest', 0);
    prog.u1i('uNormalMaps', this.quality.normalMaps);
    prog.u1f('uNormalStrength', 0.85);
    prog.u1f('uMipBias', this.quality.mipBias || 0);
    const list = this.buildDrawList();
    this.stats.chunks = list.length;
    for (let a = 0; a < this.textures.blockArrays.length; a++) {
      this.bindArrayTextures(a);
      const rows = this.textures.materialRows || 2;
      prog.u1f('uMatRow0', (a * 2 + 0.5) / rows);
      prog.u1f('uMatRow1', (a * 2 + 1.5) / rows);
      for (const c of list) {
        prog.u3f('uChunkOrigin', c.cx * 16, 0, c.cz * 16);
        this.stats.triangles += this.drawChunkMeshes(c, prog, Pass.OPAQUE) / 3;
      }
    }
    // cutout (alpha tested plants / leaves)
    prog = this.programs.chunkCutout.use();
    this.updateSharedLightUniforms(prog);
    prog.u1i('uAlbedo', 0); prog.u1i('uNormalMap', 1); prog.u1i('uMaterial', 2);
    prog.u1i('uAlphaTest', 1);
    prog.u1i('uNormalMaps', this.quality.normalMaps);
    prog.u1f('uNormalStrength', 0.85);
    prog.u1f('uMipBias', this.quality.mipBias || 0);
    for (let a = 0; a < this.textures.blockArrays.length; a++) {
      this.bindArrayTextures(a);
      const rows = this.textures.materialRows || 2;
      prog.u1f('uMatRow0', (a * 2 + 0.5) / rows);
      prog.u1f('uMatRow1', (a * 2 + 1.5) / rows);
      for (const c of list) {
        prog.u3f('uChunkOrigin', c.cx * 16, 0, c.cz * 16);
        this.stats.triangles += this.drawChunkMeshes(c, prog, Pass.CUTOUT) / 3;
      }
    }

    // entities
    if (this.entityRenderer) this.entityRenderer.flush(this, world);

    // ---- water -------------------------------------------------------------
    const waterVisible = this.waterInView(list);
    if (waterVisible) {
      // refraction copy (half res)
      this.refractFBO.bind();
      setDepthTest(false); setDepthMask(false); setCull(false);
      const cp = this.programs.copy.use();
      cp.u1i('uScene', 0);
      bindTexture(0, this.sceneFBO.targets[0]);
      drawFullscreen(this.fsVAO);

      if (this.quality.reflections && this.reflFBO) this.renderReflection(world, list);

      this.sceneFBO.bind();
      setDepthTest(true); setDepthMask(false); setCull(false);
      setBlend(true, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const wp = this.programs.water.use();
      this.updateSharedLightUniforms(wp);
      wp.u1i('uAlbedo', 0); wp.u1i('uWaterNormal', 3);
      wp.u1i('uReflection', 4); wp.u1i('uRefraction', 5); wp.u1i('uDepthTex', 7);
      wp.u2f('uScreenSize', this.renderW, this.renderH);
      wp.u3f('uWaterColor', this.waterColor[0], this.waterColor[1], this.waterColor[2]);
      wp.u3f('uDeepColor', this.deepColor[0], this.deepColor[1], this.deepColor[2]);
      wp.u1i('uReflections', this.quality.reflections && this.reflFBO ? 1 : 0);
      wp.u1i('uRefractions', this.quality.refractions);
      wp.u1f('uWaveStrength', 0.045);
      wp.u1f('uNear', this.camera.near); wp.u1f('uFar', this.camera.far);
      bindTexture(0, this.textures.blockArrays[0]);
      bindTexture(3, this.textures.waterNormal);
      bindTexture(4, this.reflFBO ? this.reflFBO.targets[0] : this.sceneFBO.targets[0]);
      bindTexture(5, this.refractFBO.targets[0]);
      bindTexture(7, this.sceneFBO.depth);
      for (let a = 0; a < this.textures.blockArrays.length; a++) {
        if (a > 0) bindTexture(0, this.textures.blockArrays[a]);
        for (const c of list) {
          wp.u3f('uChunkOrigin', c.cx * 16, 0, c.cz * 16);
          this.stats.triangles += this.drawChunkMeshes(c, wp, Pass.LIQUID) / 3;
        }
      }
      setDepthMask(true);
    }

    // translucent (glass)
    setBlend(true, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    setDepthMask(false);
    setCull(true, gl.BACK);
    prog = this.programs.chunk.use();
    this.updateSharedLightUniforms(prog);
    prog.u1i('uAlbedo', 0); prog.u1i('uNormalMap', 1); prog.u1i('uMaterial', 2);
    prog.u1i('uAlphaTest', 0);
    prog.u1i('uNormalMaps', this.quality.normalMaps);
    prog.u1f('uNormalStrength', 0.5);
    prog.u1f('uMipBias', this.quality.mipBias || 0);
    for (let a = 0; a < this.textures.blockArrays.length; a++) {
      this.bindArrayTextures(a);
      const rows = this.textures.materialRows || 2;
      prog.u1f('uMatRow0', (a * 2 + 0.5) / rows);
      prog.u1f('uMatRow1', (a * 2 + 1.5) / rows);
      for (const c of list) {
        prog.u3f('uChunkOrigin', c.cx * 16, 0, c.cz * 16);
        this.stats.triangles += this.drawChunkMeshes(c, prog, Pass.TRANSLUCENT) / 3;
      }
    }

    // particles & lines
    this.particles.flush(this);
    setDepthTest(false);
    this.lines.flush(this);
    setDepthTest(true);
    setBlend(false);
    setDepthMask(true);

    // ---- post --------------------------------------------------------------
    this.postProcess();

    this.stats.frameMs = performance.now() - t0;
  }

  waterInView(list) {
    for (const c of list) {
      if (!c.gpu) continue;
      for (let a = 0; a < 8; a++) if (c.gpu.vaos[Pass.LIQUID * 8 + a]) return true;
    }
    return false;
  }

  drawSky() {
    const gl = this.gl;
    const p = this.programs.sky.use();
    p.um4('uInvViewProj', this.camera.invViewProj);
    p.u3f('uCameraPos', this.camera.pos[0], this.camera.pos[1], this.camera.pos[2]);
    p.u3f('uSunDir', this.sun[0], this.sun[1], this.sun[2]);
    p.u3f('uMoonDir', this.moon[0], this.moon[1], this.moon[2]);
    p.u3f('uZenithColor', this.colors.zenith[0], this.colors.zenith[1], this.colors.zenith[2]);
    p.u3f('uHorizonColor', this.colors.horizon[0], this.colors.horizon[1], this.colors.horizon[2]);
    p.u3f('uGroundColor', this.colors.ground[0], this.colors.ground[1], this.colors.ground[2]);
    p.u3f('uSunColor', this.colors.sun[0], this.colors.sun[1], this.colors.sun[2]);
    p.u1f('uTime', this.time);
    p.u1f('uNightFactor', this.nightFactor);
    p.u1i('uClouds', this.quality.clouds);
    p.u1f('uCloudCoverage', 0.42);
    p.u1f('uCloudHeight', 192);
    p.u1f('uRain', this.rainLevel || 0);
    p.u2f('uResolution', this.renderW, this.renderH);
    drawFullscreen(this.fsVAO);
    this.stats.drawCalls++;
  }

  /** Mirrored-camera planar reflection for water. */
  renderReflection(world, list) {
    const gl = this.gl;
    const cam = this.camera;
    const level = 63;
    const reflY = 2 * level - cam.pos[1];
    const saved = [cam.pos[1], cam.pitch];
    cam.pos[1] = reflY;
    cam.pitch = -cam.pitch;
    this.updateCamera(cam);
    this.reflFBO.bind();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    setCull(true, gl.FRONT);     // mirrored winding
    setDepthTest(true); setDepthMask(true);
    this.drawSky();
    const prog = this.programs.chunk.use();
    this.updateSharedLightUniforms(prog);
    prog.u1i('uAlbedo', 0); prog.u1i('uNormalMap', 1); prog.u1i('uMaterial', 2);
    prog.u1i('uAlphaTest', 0);
    prog.u1i('uNormalMaps', 0);
    prog.u1f('uMipBias', 0);
    for (let a = 0; a < this.textures.blockArrays.length; a++) {
      this.bindArrayTextures(a);
      const rows = this.textures.materialRows || 2;
      prog.u1f('uMatRow0', (a * 2 + 0.5) / rows);
      prog.u1f('uMatRow1', (a * 2 + 1.5) / rows);
      for (const c of list) {
        prog.u3f('uChunkOrigin', c.cx * 16, 0, c.cz * 16);
        this.drawChunkMeshes(c, prog, Pass.OPAQUE);
      }
    }
    cam.pos[1] = saved[0]; cam.pitch = saved[1];
    this.updateCamera(cam);
    setCull(true, gl.BACK);
  }

  // -------------------------------------------------------------------------
  postProcess() {
    const gl = this.gl;
    const q = this.quality;
    setDepthTest(false); setDepthMask(false); setCull(false); setBlend(false);

    let bloomTex = null;
    if (q.bloom) {
      this.bloomA.bind();
      const bp = this.programs.bright.use();
      bp.u1i('uScene', 0); bp.u1f('uThreshold', 0.85); bp.u1f('uSoftKnee', 0.6);
      bindTexture(0, this.sceneFBO.targets[0]);
      drawFullscreen(this.fsVAO);
      // two blur iterations
      const blur = this.programs.blur.use();
      blur.u1i('uScene', 0);
      for (let i = 0; i < 2; i++) {
        this.bloomB.bind();
        blur.u2f('uTexelDir', 1 / this.bloomA.w, 0);
        bindTexture(0, this.bloomA.targets[0]);
        drawFullscreen(this.fsVAO);
        this.bloomA.bind();
        blur.u2f('uTexelDir', 0, 1 / this.bloomB.h);
        bindTexture(0, this.bloomB.targets[0]);
        drawFullscreen(this.fsVAO);
      }
      bloomTex = this.bloomA.targets[0];
    }

    let godTex = null;
    if (q.godrays && this.sun[1] > -0.15) {
      // project the sun into screen space
      const sunWorld = [this.camera.pos[0] + this.sun[0] * 500, this.camera.pos[1] + this.sun[1] * 500, this.camera.pos[2] + this.sun[2] * 500];
      const vp = this.camera.viewProj;
      const w = vp[3] * sunWorld[0] + vp[7] * sunWorld[1] + vp[11] * sunWorld[2] + vp[15];
      if (w > 0) {
        const x = (vp[0] * sunWorld[0] + vp[4] * sunWorld[1] + vp[8] * sunWorld[2] + vp[12]) / w;
        const y = (vp[1] * sunWorld[0] + vp[5] * sunWorld[1] + vp[9] * sunWorld[2] + vp[13]) / w;
        this.godrayFBO.bind();
        const gp = this.programs.godray.use();
        gp.u1i('uScene', 0);
        gp.u2f('uSunScreen', x * 0.5 + 0.5, y * 0.5 + 0.5);
        gp.u1f('uIntensity', 0.55 * clamp(this.sun[1] * 2 + 0.4, 0, 1));
        gp.u3f('uColor', this.colors.sun[0], this.colors.sun[1], this.colors.sun[2]);
        gp.u1f('uDecay', 0.96);
        bindTexture(0, bloomTex || this.sceneFBO.targets[0]);
        drawFullscreen(this.fsVAO);
        godTex = this.godrayFBO.targets[0];
      }
    }

    // composite to the default framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    const cp = this.programs.composite.use();
    cp.u1i('uScene', 0); cp.u1i('uBloom', 1); cp.u1i('uGodrays', 2);
    bindTexture(0, this.sceneFBO.targets[0]);
    bindTexture(1, bloomTex || this.sceneFBO.targets[0]);
    bindTexture(2, godTex || this.sceneFBO.targets[0]);
    cp.u2f('uResolution', this.width, this.height);
    cp.u1f('uBloomAmount', q.bloom ? 0.55 : 0);
    cp.u1f('uGodrayAmount', godTex ? 0.6 : 0);
    cp.u1f('uExposure', 1.05);
    cp.u1f('uSaturation', 1.12);
    cp.u1f('uContrast', 1.06);
    cp.u1f('uVignette', 0.35);
    cp.u1f('uUnderwater', this.underwater);
    cp.u3f('uUnderwaterColor', 0.06, 0.22, 0.36);
    cp.u1i('uFxaa', q.fxaa);
    cp.u1f('uDamageFlash', this.damageFlash || 0);
    cp.u1f('uFade', this.fade === undefined ? 1 : this.fade);
    drawFullscreen(this.fsVAO);
    this.stats.drawCalls += 6;
    setDepthTest(true); setDepthMask(true);
  }

  dispose() {
    for (const p of Object.values(this.programs)) p.dispose();
  }
}

// ---------------------------------------------------------------------------
function setLerp(out, a, b, t) { for (let i = 0; i < 3; i++) out[i] = a[i] + (b[i] - a[i]) * t; }
function mixInto(out, c, t) { for (let i = 0; i < 3; i++) out[i] = out[i] * (1 - t) + c[i] * t; }

export default Renderer;
