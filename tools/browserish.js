/**
 * Ultracraft - a browser-ish environment for Node.
 *
 * tools/stub.js fakes the DOM and WebGL2, which is enough to boot the game
 * headlessly. It is not enough to catch bugs that only exist in a browser,
 * because four things a real browser has are missing entirely:
 *
 *   Worker        - without it the game silently falls back to generating
 *                   chunks on the main thread, so the worker path (message
 *                   protocol, transferables, the bundled worker source) never
 *                   runs in any test
 *   AudioContext  - without it AudioEngine disables itself, so not one line of
 *                   the synthesiser or the music generator ever executes
 *   real time     - a synchronous update() loop never yields, so messages from
 *                   workers are never delivered and the game is never observed
 *                   in the state a player actually sees
 *   input events  - keydown/mousedown/touch/gamepad handlers are attached to
 *                   window and canvas and then never fired
 *
 * This module supplies all four. Workers are real worker threads (a blob: URL
 * runs the inlined worker bundle from Ultracraft.html, a file: URL imports the
 * ES module), audio is a permissive fake graph, and frames are paced in real
 * time so asynchronous work lands between them the way it does in a browser.
 *
 * It is how the entity AABB crash was found: aabb(out) was called with no
 * argument from five places - hitting a mob, placing a block beside one,
 * sweeping for arrow hits and the F3 overlay - and every suite was green
 * because none of them do those things with a mob nearby.
 */

import { Worker as NodeWorker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// workers
// ---------------------------------------------------------------------------
const blobs = new Map();
let blobSeq = 0;

/** Browser globals the worker scripts rely on, installed before their code runs. */
const WORKER_SHIM = `
const { parentPort } = require('node:worker_threads');
globalThis.self = globalThis;
globalThis.postMessage = (m, t) => parentPort.postMessage(m, t);
let __handler = null;
Object.defineProperty(globalThis, 'onmessage', {
  get: () => __handler,
  set: (fn) => { __handler = fn; },
  configurable: true,
});
globalThis.addEventListener = (type, fn) => { if (type === 'message') __handler = fn; };
parentPort.on('message', (data) => { if (__handler) __handler({ data }); });
`;

const WORKER_ENTRY = `${WORKER_SHIM}
import(require('node:worker_threads').workerData.file)
  .catch((e) => parentPort.postMessage({ error: String((e && e.stack) || e) }));
`;

export class UCWorker {
  constructor(url) {
    const u = String(url);
    this.onmessage = null;
    this.onerror = null;
    if (u.startsWith('blob:')) {
      const src = blobs.get(u);
      if (src === undefined) throw new Error(`unknown blob url: ${u}`);
      this.worker = new NodeWorker(WORKER_SHIM + src, { eval: true });
    } else {
      const file = url instanceof URL ? fileURLToPath(url) : u;
      this.worker = new NodeWorker(WORKER_ENTRY, { eval: true, workerData: { file: pathToFileURL(file).href } });
    }
    this.worker.on('message', (data) => { if (this.onmessage) this.onmessage({ data }); });
    this.worker.on('error', (err) => { if (this.onerror) this.onerror({ message: String((err && err.message) || err) }); });
  }

  postMessage(msg, transfer) { this.worker.postMessage(msg, transfer); }
  terminate() { return this.worker.terminate(); }
}

// ---------------------------------------------------------------------------
// WebAudio
// ---------------------------------------------------------------------------
const audioParam = () => ({
  value: 0,
  setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
  setTargetAtTime() {}, cancelScheduledValues() {}, setValueCurveAtTime() {},
});

/** Any node: unknown properties become audio params, node methods are no-ops. */
const audioNode = () => new Proxy({}, {
  get(t, k) {
    if (k === 'connect' || k === 'disconnect' || k === 'start' || k === 'stop') return () => {};
    if (!(k in t)) t[k] = audioParam();
    return t[k];
  },
  set(t, k, v) { t[k] = v; return true; },
});

export class FakeAudioContext {
  constructor() {
    this.sampleRate = 44100;
    this.currentTime = 0;
    this.state = 'suspended';
    this.destination = audioNode();
    this.listener = audioNode();
  }
  createGain() { return audioNode(); }
  createOscillator() { return audioNode(); }
  createBiquadFilter() { return audioNode(); }
  createBufferSource() { return audioNode(); }
  createStereoPanner() { return audioNode(); }
  createPanner() { return audioNode(); }
  createDelay() { return audioNode(); }
  createConvolver() { return audioNode(); }
  createDynamicsCompressor() { return audioNode(); }
  createWaveShaper() { return audioNode(); }
  createPeriodicWave() { return audioNode(); }
  createChannelMerger() { return audioNode(); }
  createChannelSplitter() { return audioNode(); }
  createBuffer(channels, length) {
    const data = new Float32Array(length);
    return { length, numberOfChannels: channels, getChannelData: () => data };
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

// ---------------------------------------------------------------------------
// installation
// ---------------------------------------------------------------------------
/**
 * Install everything and return a `{ fire, listeners }` pair. `fire(target,
 * type, event)` delivers an event the way a browser would - the stub's window
 * records listeners without a way to reach them, so they are captured here.
 */
export function installBrowserEnv(global = globalThis) {
  const G = global.window || global;

  if (!G.URL) G.URL = globalThis.URL;
  G.Blob = class Blob {
    constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; }
    get source() { return this.parts.join(''); }
  };
  G.URL.createObjectURL = (blob) => {
    const id = `blob:${++blobSeq}`;
    blobs.set(id, blob && blob.source !== undefined ? blob.source : String(blob));
    return id;
  };
  G.URL.revokeObjectURL = (id) => { blobs.delete(id); };

  G.Worker = UCWorker;
  global.Worker = UCWorker;

  G.AudioContext = FakeAudioContext;
  global.AudioContext = FakeAudioContext;

  // a browser always has a gamepad list (usually empty); pretend one is plugged in
  G.navigator = G.navigator || {};
  G.navigator.getGamepads = () => [{
    index: 0, connected: true, axes: [0, 0, 0, 0],
    buttons: [{ pressed: false }, { pressed: false }],
  }];

  const captured = [];
  const previous = G.addEventListener;
  G.addEventListener = (type, fn) => { captured.push([type, fn]); if (previous) previous.call(G, type, fn); };

  const fire = (target, type, event = {}) => {
    const ev = { type, preventDefault() {}, stopPropagation() {}, target, ...event };
    if (target === G) {
      for (const [t, fn] of captured) if (t === type) fn(ev);
    } else if (target && target.dispatchEvent) {
      target.dispatchEvent(ev);
    }
  };

  return { fire, listeners: captured };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
