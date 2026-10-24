#!/usr/bin/env node
/**
 * Ultracraft - headless DOM + WebGL2 stub.
 *
 * Node has neither a document nor a GPU, so `tools/headless.js` and
 * `tools/scenarios.js` install this before importing the game. Everything the
 * engine touches is faked: GL entry points are no-ops, DOM nodes are plain
 * objects. That is enough to boot the real renderer, build the real texture
 * arrays and run the real game loop.
 */

import { performance } from 'node:perf_hooks';

// ---------------------------------------------------------------------------
// WebGL2 stub
// ---------------------------------------------------------------------------
// real values for the constants the engine compares against
const CONSTANTS = new Map(Object.entries({
  FRAMEBUFFER_COMPLETE: 0x8CD5, FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8CD6,
  FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT: 0x8CD7, FRAMEBUFFER_UNSUPPORTED: 0x8CDD,
  NO_ERROR: 0, INVALID_ENUM: 0x0500, INVALID_VALUE: 0x0501, INVALID_OPERATION: 0x0502,
  TEXTURE_2D: 0x0DE1, TEXTURE_2D_ARRAY: 0x8C1A, TEXTURE0: 0x84C0,
  RGBA: 0x1908, RGBA8: 0x8058, RGBA16F: 0x881A, RGBA32F: 0x8814, DEPTH_COMPONENT24: 0x81A6,
  DEPTH_STENCIL: 0x84F9, DEPTH24_STENCIL8: 0x88F0, UNSIGNED_BYTE: 0x1401, FLOAT: 0x1406,
  HALF_FLOAT: 0x140B, TRIANGLES: 0x0004, LINES: 0x0001, ARRAY_BUFFER: 0x8892,
  ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88E4, DYNAMIC_DRAW: 0x88E8,
  VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30, COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82,
  ACTIVE_UNIFORMS: 0x8B86, ACTIVE_ATTRIBUTES: 0x8B89, FRAMEBUFFER: 0x8D40, RENDERBUFFER: 0x8D41,
  COLOR_ATTACHMENT0: 0x8CE0, DEPTH_ATTACHMENT: 0x8D00, DEPTH_STENCIL_ATTACHMENT: 0x821A,
  NEAREST: 0x2600, LINEAR: 0x2601, LINEAR_MIPMAP_LINEAR: 0x2703, NEAREST_MIPMAP_LINEAR: 0x2702,
  CLAMP_TO_EDGE: 0x812F, REPEAT: 0x2901, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, TEXTURE_BASE_LEVEL: 0x813C, TEXTURE_MAX_LEVEL: 0x813D,
  DEPTH_TEST: 0x0B71, CULL_FACE: 0x0B44, BLEND: 0x0BE2, LEQUAL: 0x0203, LESS: 0x0201,
  BACK: 0x0405, FRONT: 0x0404, SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303, ONE: 1, ZERO: 0,
  COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x0100, MAX_ARRAY_TEXTURE_LAYERS: 0x88FF,
  MAX_TEXTURE_SIZE: 0x0D33, MAX_TEXTURE_IMAGE_UNITS: 0x8872, MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_CUBE_MAP_TEXTURE_SIZE: 0x851C, MAX_3D_TEXTURE_SIZE: 0x8073, MAX_SAMPLES: 0x8D57,
  VERSION: 0x1F02, RENDERER: 0x1F01, VENDOR: 0x1F00, VIEWPORT: 0x0BA2,
  UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, TEXTURE_COMPARE_MODE: 0x884C,
  TEXTURE_CUBE_MAP: 0x8513, TEXTURE_MAX_LOD: 0x813B, TEXTURE_MIN_LOD: 0x813A,
}));
let nextConst = 0x9000;

function glConstant(name) {
  if (!CONSTANTS.has(name)) CONSTANTS.set(name, nextConst++);
  return CONSTANTS.get(name);
}

const FNS = {
  getParameter: (p) => {
    if (p === glConstant('MAX_ARRAY_TEXTURE_LAYERS')) return 256;
    if (p === glConstant('MAX_TEXTURE_SIZE')) return 8192;
    if (p === glConstant('MAX_TEXTURE_IMAGE_UNITS')) return 32;
    if (p === glConstant('MAX_VERTEX_ATTRIBS')) return 16;
    if (p === glConstant('VERSION')) return 'WebGL 2.0 (stub)';
    if (p === glConstant('MAX_CUBE_MAP_TEXTURE_SIZE')) return 8192;
    if (p === glConstant('MAX_3D_TEXTURE_SIZE')) return 2048;
    if (p === glConstant('MAX_SAMPLES')) return 4;
    return 8192;
  },
  getExtension: (name) => {
    if (name === 'EXT_color_buffer_float' || name === 'OES_texture_float_linear') return {};
    if (name === 'WEBGL_debug_renderer_info') return { UNMASKED_RENDERER_WEBGL: 1 };
    return null;
  },
  getSupportedExtensions: () => ['EXT_color_buffer_float', 'OES_texture_float_linear'],
  createShader: () => ({ __shader: true }),
  createProgram: () => ({ __program: true }),
  getShaderParameter: () => true,
  getProgramParameter: (p, pname) => (pname === glConstant('ACTIVE_UNIFORMS') ? 0 : true),
  getShaderInfoLog: () => '',
  getProgramInfoLog: () => '',
  getUniformLocation: () => ({ __loc: true }),
  getAttribLocation: (p, name) => {
    const map = { aPos: 0, aUV: 1, aTex: 2, aNorm: 3, aLight: 4, aNormal: 3, aColor: 4 };
    return map[name] !== undefined ? map[name] : 0;
  },
  createTexture: () => ({ __tex: true }),
  createBuffer: () => ({ __buf: true }),
  createVertexArray: () => ({ __vao: true }),
  createFramebuffer: () => ({ __fbo: true }),
  createRenderbuffer: () => ({ __rbo: true }),
  checkFramebufferStatus: () => 36053,                 // FRAMEBUFFER_COMPLETE
  getError: () => 0,
  isContextLost: () => false,
  getActiveUniform: () => null,
  fenceSync: () => ({}),
  clientWaitSync: () => 0,
};

const glStub = new Proxy({}, {
  get(target, prop) {
    if (typeof prop !== 'string') return undefined;
    if (prop in FNS) return FNS[prop];
    // GL constants are SCREAMING_SNAKE_CASE
    if (/^[A-Z0-9_]+$/.test(prop)) return glConstant(prop);
    if (prop === 'canvas') return target.__canvas;
    if (prop === 'drawingBufferWidth') return 1280;
    if (prop === 'drawingBufferHeight') return 720;
    return () => undefined;   // every other entry point is a no-op
  },
  set() { return true; },
});

// ---------------------------------------------------------------------------
// DOM stub
// ---------------------------------------------------------------------------
class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  toggle(c, on) { if (on === undefined) { this.set.has(c) ? this.set.delete(c) : this.set.add(c); } else if (on) this.set.add(c); else this.set.delete(c); }
  contains(c) { return this.set.has(c); }
}

class El {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classList = new ClassList();
    this.textContent = '';
    this._html = '';
    this.value = '';
    this.width = 1280; this.height = 720;
    this.clientWidth = 1280; this.clientHeight = 720;
    this._listeners = new Map();
  }
  get className() { return [...this.classList.set].join(' '); }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; this.children.length = 0; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(t, fn) { if (!this._listeners.has(t)) this._listeners.set(t, []); this._listeners.get(t).push(fn); }
  removeEventListener() {}
  dispatchEvent(e) { (this._listeners.get(e.type) || []).forEach((f) => f(e)); return true; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 }; }
  getContext(type) {
    if (type === 'webgl2') { glStub.__canvas = this; return glStub; }
    if (type === '2d') {
      return {
        canvas: this, imageSmoothingEnabled: false,
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData: () => {}, drawImage: () => {}, fillRect: () => {}, clearRect: () => {},
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        beginPath: () => {}, arc: () => {}, fill: () => {}, stroke: () => {}, moveTo: () => {}, lineTo: () => {},
        save: () => {}, restore: () => {}, translate: () => {}, rotate: () => {}, scale: () => {},
        set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set globalAlpha(v) {},
      };
    }
    return null;
  }
  toDataURL() { return 'data:image/png;base64,'; }
  focus() {} blur() {} select() {} click() {}
  setAttribute() {} getAttribute() { return null; }
  requestPointerLock() { return Promise.resolve(); }
}

const elements = new Map();
function makeEl(id, tag = 'div') {
  const e = new El(tag);
  e.id = id;
  elements.set(id, e);
  return e;
}

const documentStub = {
  body: new El('body'),
  documentElement: new El('html'),
  pointerLockElement: null,
  hidden: false,
  createElement: (tag) => new El(tag),
  getElementById: (id) => elements.get(id) || null,
  querySelector: (sel) => {
    if (sel.startsWith('#')) return elements.get(sel.slice(1)) || null;
    return null;
  },
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  exitPointerLock: () => {},
};

const listeners = new Map();
const windowStub = {
  innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
  addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
  removeEventListener: () => {},
  requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  performance,
  AudioContext: undefined,          // disable audio in headless mode
  navigator: { hardwareConcurrency: 2, maxTouchPoints: 0, userAgent: 'node' },
  location: { search: '', protocol: 'http:', href: 'http://localhost/' },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  setTimeout, clearTimeout, setInterval, clearInterval,
};

globalThis.window = windowStub;
globalThis.document = documentStub;
try { Object.defineProperty(globalThis, 'navigator', { value: windowStub.navigator, configurable: true }); } catch (e) { /* Node 22 defines navigator as a getter */ }
try { Object.defineProperty(globalThis, 'location', { value: windowStub.location, configurable: true }); } catch (e) { /* ignore */ }
globalThis.HTMLCanvasElement = El;
globalThis.requestAnimationFrame = windowStub.requestAnimationFrame;
globalThis.cancelAnimationFrame = windowStub.cancelAnimationFrame;
globalThis.WebGL2RenderingContext = function () {};
globalThis.URLSearchParams = URLSearchParams;
globalThis.localStorage = {
  _d: new Map(),
  getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, String(v)); },
  removeItem(k) { this._d.delete(k); },
  key(i) { return [...this._d.keys()][i] ?? null; },
  get length() { return this._d.size; },
};
globalThis.devicePixelRatio = 1;
globalThis.self = globalThis;

// the elements index.html declares
for (const id of ['app', 'glcanvas', 'hud', 'crosshair', 'hotbar-wrap', 'hotbar', 'held-name',
  'status-left', 'hearts', 'armor', 'hunger', 'air', 'xp-wrap', 'xp-bar', 'xp-fill', 'xp-level',
  'status-right', 'effect-list', 'boss-bar', 'boss-name', 'boss-track', 'boss-fill',
  'chat-wrap', 'chat-log', 'chat-input', 'subtitle', 'toast', 'touch', 'tstick', 'tstick-knob',
  'tbtns', 'tlook', 'menu-root', 'loading', 'loading-logo', 'loading-bar', 'loading-fill',
  'loading-text']) {
  makeEl(id);
}
export const canvas = elements.get('glcanvas');
canvas.width = 1280; canvas.height = 720;
export { elements as elements };
