/**
 * Ultracraft - the world.
 *
 * Owns chunk streaming (worker pool), lighting, block updates, fluid flow,
 * random ticks, explosions and ray casting.  Meshing itself lives in the
 * renderer: the world only maintains the dirty-section queue.
 */

import { Chunk } from './chunk.js';
import { LightEngine } from './lighting.js';
import { getBlock, BLOCK, AIR, Shape, blockId } from './blocks.js';
import { WorldGenerator, SEA_LEVEL, WORLD_HEIGHT, NETHER_HEIGHT } from './generator.js';
import { makeRng } from '../core/math.js';

const CHUNK_KEY = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);

export class World {
  constructor(opts = {}) {
    this.seed = opts.seed ?? 'ultracraft';
    this.dimension = opts.dimension || 'overworld';
    this.type = opts.type || 'default';
    this.height = this.dimension === 'nether' ? NETHER_HEIGHT : WORLD_HEIGHT;
    this.renderDistance = opts.renderDistance ?? 8;
    this.simulationDistance = opts.simulationDistance ?? 6;
    this.chunks = new Map();
    this.generator = new WorldGenerator(this.seed, this.dimension, this.type);
    this.light = new LightEngine(this);
    this.time = 0;                 // ticks
    this.dayTime = 1000;           // 0..24000
    this.raining = false;
    this.thundering = false;
    this.rainLevel = 0;
    this.pendingGen = new Map();   // key -> {cx, cz, t}
    this.genQueue = [];
    this.meshQueue = [];
    this.workers = [];
    this.workerBusy = 0;
    this.blockUpdates = [];        // {x,y,z,t,id}
    this.fluidUpdates = [];
    this.randomTickTargets = [];
    this.tileEntities = new Map();
    this.chunkCounter = 0;
    this.stats = { chunks: 0, meshed: 0, genPending: 0, lightPending: 0 };
    this.onBlockChangedCb = null;
    this.save = opts.save || null;
    this._tmp = new Float32Array(3);
    this.initWorkers(opts.workerCount ?? (typeof navigator !== 'undefined' ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)) : 0));
  }

  initWorkers(n) {
    if (typeof Worker === 'undefined' || n <= 0) { this.useWorkers = false; return; }
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('./genworker.js', import.meta.url), { type: 'module' });
        w.onmessage = (e) => this.onWorkerResult(w, e.data);
        w.onerror = (e) => { console.warn('chunk worker error', e.message); this.useWorkers = false; };
        this.workers.push(w);
      }
      this.useWorkers = true;
    } catch (err) {
      this.useWorkers = false;
    }
  }

  onWorkerResult(worker, msg) {
    this.workerBusy--;
    if (!msg || msg.error) { console.warn('generation failed', msg && msg.error); return; }
    this.receiveChunk(msg);
    this.pumpWorkers();
  }

  pumpWorkers() {
    while (this.genQueue.length && this.workerBusy < this.workers.length) {
      const job = this.genQueue.shift();
      const w = this.workers.find((x) => !x.__busy);
      if (!w) break;
      w.__busy = true; this.workerBusy++;
      const id = job.id;
      w.onmessage = (e) => { w.__busy = false; this.onWorkerResult(w, e.data); };
      w.postMessage({ id, cx: job.cx, cz: job.cz, seed: this.seed, dimension: this.dimension, type: this.type });
    }
  }

  // -------------------------------------------------------------------------
  //  chunk access
  // -------------------------------------------------------------------------
  key(cx, cz) { return CHUNK_KEY(cx, cz); }

  getChunk(cx, cz) { return this.chunks.get(CHUNK_KEY(cx, cz)); }

  isChunkLoaded(cx, cz) {
    const c = this.chunks.get(CHUNK_KEY(cx, cz));
    return !!c && c.generated;
  }

  ensureChunk(cx, cz) {
    const k = CHUNK_KEY(cx, cz);
    let c = this.chunks.get(k);
    if (!c) {
      c = new Chunk(cx, cz, this.height);
      this.chunks.set(k, c);
    }
    return c;
  }

  /** Request a chunk (generates in a worker, or inline when unavailable). */
  requestChunk(cx, cz, priority = 0) {
    const k = CHUNK_KEY(cx, cz);
    if (this.chunks.has(k) || this.pendingGen.has(k)) return;
    this.pendingGen.set(k, true);
    const job = { cx, cz, id: this.chunkCounter++, priority };
    if (this.useWorkers) {
      this.genQueue.push(job);
      this.genQueue.sort((a, b) => a.priority - b.priority);
      this.pumpWorkers();
    } else {
      const res = this.generator.generateChunk(cx, cz);
      res.id = job.id;
      this.receiveChunk(res);
    }
  }

  /** Turn generator output into chunk sections. */
  receiveChunk(msg) {
    const { cx, cz, blocks, meta, heightMap, tileEntities } = msg;
    const k = CHUNK_KEY(cx, cz);
    const chunk = this.chunks.get(k) || new Chunk(cx, cz, this.height);
    if (!this.chunks.has(k)) this.chunks.set(k, chunk);
    chunk.heightMap.set(heightMap);
    const secCount = this.height >> 4;
    for (let sy = 0; sy < secCount; sy++) {
      let nonAir = 0;
      for (let y = 0; y < 16; y++) {
        const yBase = (sy * 16 + y) * 256;
        for (let i = 0; i < 256; i++) if (blocks[yBase + i] !== 0) { nonAir++; break; }
        if (nonAir) break;
      }
      if (!nonAir) continue;
      const s = chunk.ensureSection(sy);
      s.blocks.set(blocks.subarray(sy * 4096, sy * 4096 + 4096));
      s.meta.set(meta.subarray(sy * 4096, sy * 4096 + 4096));
      let count = 0;
      for (let i = 0; i < 4096; i++) if (s.blocks[i] !== 0) count++;
      s.nonAir = count;
    }
    chunk.generated = true;
    chunk.state = 1;
    chunk.needsSave = true;
    if (tileEntities && tileEntities.length) {
      for (const te of tileEntities) this.addTileEntity(cx * 16 + te.x, te.y, cz * 16 + te.z, te);
    }
    this.pendingGen.delete(k);
    this.light.initChunk(chunk);
    this.light.spreadFromChunk(chunk);
    // neighbours may now be able to mesh
    for (let d = 0; d < 4; d++) {
      const nc = this.getChunk(cx + DIR4[d][0], cz + DIR4[d][1]);
      if (nc && nc.generated) { this.light.spreadFromChunk(nc); this.markChunkDirty(nc); }
    }
    this.markChunkDirty(chunk);
    if (this.save && this.save.queueChunk) this.save.queueChunk(chunk, this.dimension);
  }

  markChunkDirty(chunk) {
    for (let sy = 0; sy < chunk.sectionCount; sy++) chunk.meshDirty.add(sy);
    chunk.dirty = true;
  }

  markLightDirty(x, y, z) {
    const cx = x >> 4, cz = z >> 4;
    const c = this.getChunk(cx, cz);
    if (c) c.meshDirty.add(y >> 4);
    // neighbours when on a border
    const lx = x & 15, lz = z & 15, ly = y & 15;
    if (lx === 0) this.markNeighbour(cx - 1, cz, y >> 4);
    if (lx === 15) this.markNeighbour(cx + 1, cz, y >> 4);
    if (lz === 0) this.markNeighbour(cx, cz - 1, y >> 4);
    if (lz === 15) this.markNeighbour(cx, cz + 1, y >> 4);
    if (ly === 0 && (y >> 4) > 0) { const c2 = this.getChunk(cx, cz); if (c2) c2.meshDirty.add((y >> 4) - 1); }
    if (ly === 15) { const c2 = this.getChunk(cx, cz); if (c2) c2.meshDirty.add((y >> 4) + 1); }
  }

  markNeighbour(cx, cz, sy) {
    const c = this.getChunk(cx, cz);
    if (c) c.meshDirty.add(sy);
  }

  // -------------------------------------------------------------------------
  //  blocks
  // -------------------------------------------------------------------------
  getBlock(x, y, z) {
    if (y < 0 || y >= this.height) return 0;
    const c = this.chunks.get(CHUNK_KEY(x >> 4, z >> 4));
    if (!c || !c.generated) return 0;
    return c.getBlock(x & 15, y, z & 15);
  }

  getBlockFast(x, y, z) { return this.getBlock(x, y, z); }

  getMeta(x, y, z) {
    if (y < 0 || y >= this.height) return 0;
    const c = this.chunks.get(CHUNK_KEY(x >> 4, z >> 4));
    if (!c || !c.generated) return 0;
    return c.getMeta(x & 15, y, z & 15);
  }
  getMetaFast(x, y, z) { return this.getMeta(x, y, z); }

  getLight(x, y, z) {
    if (y < 0) return 0;
    if (y >= this.height) return 15 | (0 << 4);
    const c = this.chunks.get(CHUNK_KEY(x >> 4, z >> 4));
    if (!c || !c.generated) return 15;
    return c.getLight(x & 15, y, z & 15);
  }
  getLightFast(x, y, z) { return this.getLight(x, y, z); }

  /** Light byte layout: high nibble = block light, low nibble = sky light. */
  getBlockLight(x, y, z) { return (this.getLight(x, y, z) >> 4) & 15; }
  getSkyLight(x, y, z) { return this.getLight(x, y, z) & 15; }
  /** Brightest of the two channels - what gameplay checks care about. */
  getLightMax(x, y, z) { const l = this.getLight(x, y, z); return Math.max(l & 15, (l >> 4) & 15); }

  setMeta(x, y, z, meta) {
    const c = this.chunks.get(CHUNK_KEY(x >> 4, z >> 4));
    if (!c || !c.generated) return false;
    c.setMeta(x & 15, y, z & 15, meta & 15);
    this.markBlockDirty(x, y, z);
    return true;
  }

  setLight(x, y, z, v) {
    const c = this.chunks.get(CHUNK_KEY(x >> 4, z >> 4));
    if (!c) return;
    c.setLight(x & 15, y, z & 15, v);
  }

  setBlock(x, y, z, id, meta = 0, flags = 0) {
    if (y < 0 || y >= this.height) return false;
    const cx = x >> 4, cz = z >> 4;
    const c = this.chunks.get(CHUNK_KEY(cx, cz));
    if (!c || !c.generated) return false;
    const lx = x & 15, lz = z & 15;
    const prevId = c.getBlock(lx, y, lz);
    const prevMeta = c.getMeta(lx, y, lz);
    if (prevId === id && prevMeta === meta) return false;
    c.setBlock(lx, y, lz, id, meta);
    this.tileEntities.delete(tileKey(x, y, z));
    const nbDef = getBlock(id);
    if (nbDef.entity) this.addTileEntity(x, y, z, { id, x, y, z });
    this.light.onBlockSet(x, y, z, prevId, id);
    this.markBlockDirty(x, y, z);
    // notify neighbours (for doors, fences, redstone, falling blocks)
    for (let d = 0; d < 6; d++) {
      this.markBlockDirty(x + DIR6[d][0], y + DIR6[d][1], z + DIR6[d][2]);
    }
    if (nbDef.gravity) this.scheduleUpdate(x, y, z, 2);
    if (nbDef.flow > 0) this.scheduleFluid(x, y, z, nbDef.flow);
    if (prevId !== AIR && getBlock(prevId).fluidTick) this.scheduleFluid(x, y, z, 1);
    for (let d = 0; d < 6; d++) {
      const nx = x + DIR6[d][0], ny = y + DIR6[d][1], nz = z + DIR6[d][2];
      const nid = this.getBlock(nx, ny, nz);
      if (nid && getBlock(nid).gravity) this.scheduleUpdate(nx, ny, nz, 2);
    }
    // water meeting lava: lava sources become obsidian, flowing lava becomes stone
    if (nbDef.flow > 0 && !nbDef.damage) {
      for (let d = 0; d < 6; d++) {
        const nx = x + DIR6[d][0], ny = y + DIR6[d][1], nz = z + DIR6[d][2];
        const nid = this.getBlock(nx, ny, nz);
        if (nid === AIR || !getBlock(nid).damage || getBlock(nid).flow === 0) continue;
        const source = this.getMeta(nx, ny, nz) === 0;
        this.setBlock(nx, ny, nz, blockId(source ? 'obsidian' : 'stone'), 0);
        this.audioCue && this.audioCue('fizz', nx, ny, nz);
      }
    }
    if (this.onBlockChangedCb) this.onBlockChangedCb(x, y, z, prevId, id, flags);
    return true;
  }

  /** Is there a log within `r` blocks? (keeps leaf blocks alive) */
  logWithin(x, y, z, r = 6) {
    const r2 = r * r;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          if (getBlock(this.getBlock(x + dx, y + dy, z + dz)).name.includes('log')) return true;
        }
      }
    }
    return false;
  }

  markBlockDirty(x, y, z) {
    const c = this.chunks.get(CHUNK_KEY(x >> 4, z >> 4));
    if (c) c.meshDirty.add(y >> 4);
    const lx = x & 15, lz = z & 15, ly = y & 15;
    if (lx === 0) this.markNeighbour((x >> 4) - 1, z >> 4, y >> 4);
    if (lx === 15) this.markNeighbour((x >> 4) + 1, z >> 4, y >> 4);
    if (lz === 0) this.markNeighbour(x >> 4, (z >> 4) - 1, y >> 4);
    if (lz === 15) this.markNeighbour(x >> 4, (z >> 4) + 1, y >> 4);
    if (ly === 0 && (y >> 4) > 0) { const c2 = this.getChunk(x >> 4, z >> 4); if (c2) c2.meshDirty.add((y >> 4) - 1); }
    if (ly === 15) { const c2 = this.getChunk(x >> 4, z >> 4); if (c2) c2.meshDirty.add((y >> 4) + 1); }
  }

  /** Bulk set used when loading (skips most bookkeeping). */
  setBlockFast(x, y, z, id, meta = 0) {
    const c = this.chunks.get(CHUNK_KEY(x >> 4, z >> 4));
    if (!c) return;
    c.setBlock(x & 15, y, z & 15, id, meta);
  }

  isSolid(x, y, z) {
    const id = this.getBlock(x, y, z);
    return id !== AIR && getBlock(id).solid;
  }

  isOpaque(x, y, z) {
    const id = this.getBlock(x, y, z);
    return id !== AIR && getBlock(id).opaque;
  }

  isAir(x, y, z) { return this.getBlock(x, y, z) === AIR; }

  /** Highest non-air Y at a column (or sea level when unknown). */
  topY(x, z) {
    const c = this.chunks.get(CHUNK_KEY(x >> 4, z >> 4));
    if (!c || !c.generated) return null;
    return c.heightMap[(z & 15) * 16 + (x & 15)];
  }

  /** Terrain height including water surface - used for spawning. */
  surfaceY(x, z) {
    const top = this.topY(x, z);
    if (top === null) return null;
    return Math.max(top, SEA_LEVEL + 1);
  }

  // -------------------------------------------------------------------------
  //  tile entities
  // -------------------------------------------------------------------------
  addTileEntity(x, y, z, data) {
    const te = Object.assign({ x, y, z }, data);
    if (te.z === undefined) te.z = z;
    this.tileEntities.set(tileKey(x, y, z), te);
    return te;
  }
  getTileEntity(x, y, z) { return this.tileEntities.get(tileKey(x, y, z)); }
  removeTileEntity(x, y, z) { this.tileEntities.delete(tileKey(x, y, z)); }

  // -------------------------------------------------------------------------
  //  updates
  // -------------------------------------------------------------------------
  scheduleUpdate(x, y, z, delay) {
    this.blockUpdates.push({ x, y, z, t: this.time + delay });
  }
  scheduleFluid(x, y, z, delay) {
    this.fluidUpdates.push({ x, y, z, t: this.time + delay });
  }

  /** Process scheduled block updates. */
  tickUpdates() {
    const now = this.time;
    for (let i = this.blockUpdates.length - 1; i >= 0; i--) {
      const u = this.blockUpdates[i];
      if (u.t > now) continue;
      this.blockUpdates.splice(i, 1);
      this.runBlockUpdate(u.x, u.y, u.z);
    }
    for (let i = this.fluidUpdates.length - 1; i >= 0; i--) {
      const u = this.fluidUpdates[i];
      if (u.t > now) continue;
      this.fluidUpdates.splice(i, 1);
      this.runFluidUpdate(u.x, u.y, u.z);
    }
  }

  runBlockUpdate(x, y, z) {
    const id = this.getBlock(x, y, z);
    if (id === AIR) return;
    const b = getBlock(id);
    if (b.gravity) {
      const below = this.getBlock(x, y - 1, z);
      if (below === AIR || getBlock(below).replaceable) {
        this.setBlock(x, y, z, AIR);
        this.setBlock(x, y - 1, z, id, this.getMeta(x, y, z));
        if (y - 2 >= 0) this.scheduleUpdate(x, y - 1, z, 2);
        return;
      }
    }
    if (b.entity === 'spawner') {
      const te = this.getTileEntity(x, y, z);
      if (te && this.onSpawnerTick) this.onSpawnerTick(te, x, y, z);
    }
    if (b.shape === Shape.CROP || b.tick) {
      if (this.onRandomTickBlock) this.onRandomTickBlock(x, y, z, id, b, true);
    }
  }

  runFluidUpdate(x, y, z) {
    const id = this.getBlock(x, y, z);
    if (id === AIR) return;
    const b = getBlock(id);
    if (b.flow <= 0) return;
    const meta = this.getMeta(x, y, z);
    let level = meta & 15;
    const isSource = level >= 8;
    const maxDrop = b.flow;

    // fall first
    const below = this.getBlock(x, y - 1, z);
    if (below === AIR || getBlock(below).replaceable) {
      this.setBlock(x, y - 1, z, id, 8);
      this.scheduleFluid(x, y - 1, z, maxDrop);
      if (!isSource) { this.setBlock(x, y, z, AIR); }
      return;
    }
    if (below === id) return;
    if (!isSource) {
      // flowing water: check we still have a source feeding us
      let fed = false;
      for (const d of DIR4) {
        const nx = x + d[0], nz = z + d[1];
        const nid = this.getBlock(nx, y, nz);
        if (nid === id && (this.getMeta(nx, y, nz) & 15) > level) { fed = true; break; }
        if (nid === id && (this.getMeta(nx, y, nz) & 15) >= 8) { fed = true; break; }
      }
      const above = this.getBlock(x, y + 1, z);
      if (!fed && above !== id) { this.setBlock(x, y, z, AIR); return; }
    }
    if (level <= 0) return;
    const next = level - 1;
    for (const d of DIR4) {
      const nx = x + d[0], nz = z + d[1];
      const nid = this.getBlock(nx, y, nz);
      if (nid === AIR || getBlock(nid).replaceable) {
        const cur = nid === id ? (this.getMeta(nx, y, nz) & 15) : -1;
        if (cur < next) {
          this.setBlock(nx, y, nz, id, next);
          this.scheduleFluid(nx, y, nz, maxDrop);
        }
      }
    }
    if (isSource) this.scheduleFluid(x, y, z, maxDrop * 2);
  }

  /** Random ticks around the player (crop growth, leaves, fire, ice...). */
  tickRandom(cx, cz, count = 24) {
    const rng = this._rng || (this._rng = makeRng(12345));
    for (let i = 0; i < count; i++) {
      const x = cx * 16 + rng.int(16), z = cz * 16 + rng.int(16);
      const top = this.topY(x, z);
      if (top === null) continue;
      const y = rng.int(Math.max(1, top + 4));
      const id = this.getBlock(x, y, z);
      if (id === AIR) continue;
      const b = getBlock(id);
      if (b.tick && this.onRandomTickBlock) this.onRandomTickBlock(x, y, z, id, b, false);
    }
  }

  // -------------------------------------------------------------------------
  //  streaming
  // -------------------------------------------------------------------------
  update(playerX, playerZ, dt) {
    this.time++;
    this.dayTime = (this.dayTime + 1) % 24000;
    const pcx = Math.floor(playerX / 16), pcz = Math.floor(playerZ / 16);
    const rd = this.renderDistance;
    if (this._lastPcx !== pcx || this._lastPcz !== pcz || this._lastRD !== rd) {
      this._lastPcx = pcx; this._lastPcz = pcz; this._lastRD = rd;
      this.refreshLoadQueue(pcx, pcz, rd);
    }
    // unload far chunks
    if ((this.time & 31) === 0) this.unloadFar(pcx, pcz, rd + 2);
    this.tickUpdates();
    this.light.update(1.5);
    // random ticks in loaded chunks near the player
    if (this.onRandomTickBlock) {
      const sd = this.simulationDistance;
      for (let dz = -sd; dz <= sd; dz++) {
        for (let dx = -sd; dx <= sd; dx++) {
          if (dx * dx + dz * dz > sd * sd) continue;
          const c = this.getChunk(pcx + dx, pcz + dz);
          if (c && c.generated && ((this.time + dx * 7 + dz * 13) % 3 === 0)) this.tickRandom(pcx + dx, pcz + dz, 8);
        }
      }
    }
    this.stats.chunks = this.chunks.size;
    this.stats.genPending = this.pendingGen.size;
    this.stats.lightPending = this.light.pending;
  }

  refreshLoadQueue(pcx, pcz, rd) {
    const jobs = [];
    const r2 = (rd + 1) * (rd + 1);
    for (let dz = -rd; dz <= rd; dz++) {
      for (let dx = -rd; dx <= rd; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const cx = pcx + dx, cz = pcz + dz;
        if (this.isChunkLoaded(cx, cz)) continue;
        jobs.push({ cx, cz, p: d2 });
      }
    }
    jobs.sort((a, b) => a.p - b.p);
    for (const j of jobs) this.requestChunk(j.cx, j.cz, j.p);
  }

  unloadFar(pcx, pcz, rd) {
    for (const [k, c] of this.chunks) {
      const dx = c.cx - pcx, dz = c.cz - pcz;
      if (dx * dx + dz * dz > rd * rd) {
        if (this.save && c.needsSave && this.save.queueChunk) this.save.queueChunk(c, this.dimension);
        this.chunks.delete(k);
        this.pendingGen.delete(k);
        if (this.onChunkUnload) this.onChunkUnload(c);
      }
    }
  }

  /** Chunks whose neighbours are all generated (safe to mesh). */
  meshableChunks() {
    const out = [];
    for (const c of this.chunks.values()) {
      if (!c.generated || c.meshDirty.size === 0) continue;
      if (!this.isChunkLoaded(c.cx - 1, c.cz) || !this.isChunkLoaded(c.cx + 1, c.cz) ||
        !this.isChunkLoaded(c.cx, c.cz - 1) || !this.isChunkLoaded(c.cx, c.cz + 1)) continue;
      out.push(c);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  //  ray casting (Amanatides & Woo)
  // -------------------------------------------------------------------------
  raycast(origin, dir, maxDist = 6, opts = {}) {
    const hitFluids = !!opts.fluids;
    let x = Math.floor(origin[0]), y = Math.floor(origin[1]), z = Math.floor(origin[2]);
    const stepX = Math.sign(dir[0]), stepY = Math.sign(dir[1]), stepZ = Math.sign(dir[2]);
    const tDeltaX = stepX !== 0 ? Math.abs(1 / dir[0]) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / dir[1]) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dir[2]) : Infinity;
    const bound = (p, s) => s > 0 ? (Math.floor(p) + 1 - p) : (p - Math.floor(p));
    let tMaxX = stepX !== 0 ? bound(origin[0], stepX) * tDeltaX : Infinity;
    let tMaxY = stepY !== 0 ? bound(origin[1], stepY) * tDeltaY : Infinity;
    let tMaxZ = stepZ !== 0 ? bound(origin[2], stepZ) * tDeltaZ : Infinity;
    let face = [0, 0, 0];
    let t = 0;
    // guard against NaN directions
    if (!isFinite(tDeltaX) && !isFinite(tDeltaY) && !isFinite(tDeltaZ)) return null;
    for (let i = 0; i < 512; i++) {
      const id = this.getBlock(x, y, z);
      if (id !== AIR) {
        const b = getBlock(id);
        if (b.opaque || (hitFluids && b.flow > 0) || !b.replaceable) {
          return { x, y, z, id, block: b, face, dist: t, normal: face.slice() };
        }
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX; face = [-stepX, 0, 0];
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; face = [0, -stepY, 0];
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; face = [0, 0, -stepZ];
      }
      if (t > maxDist) break;
    }
    return null;
  }

  /** First entity whose AABB (grown by `radius`) intersects the segment. */
  sweepEntities(from, to, radius = 0.3, exclude = null) {
    const list = this.entities || [];
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const steps = Math.max(1, Math.min(64, Math.ceil(len / 0.4)));
    for (const e of list) {
      if (e === exclude || e.removed || e.dead) continue;
      if (e.type === 'item' || e.type === 'xp') continue;
      const a = e.aabb();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const px = from[0] + dx * t, py = from[1] + dy * t, pz = from[2] + dz * t;
        if (px > a[0] - radius && px < a[3] + radius && py > a[1] - radius && py < a[4] + radius && pz > a[2] - radius && pz < a[5] + radius) return e;
      }
    }
    return null;
  }

  /** True when nothing opaque stands between (x,y,z) and the sky. */
  isSkyVisible(x, y, z) {
    for (let yy = y; yy < this.height; yy++) if (this.isOpaque(x, yy, z)) return false;
    return true;
  }

  // -------------------------------------------------------------------------
  //  explosions
  // -------------------------------------------------------------------------
  explode(x, y, z, radius, opts = {}) {
    const fire = !!opts.fire;
    const destroyBlocks = opts.blocks !== false;
    const rng = makeRng((x * 31 + y * 17 + z * 7) ^ (this.time * 13));
    const affected = [];
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const d = Math.hypot(dx, dy, dz);
          if (d > radius) continue;
          const bx = x + dx, by = y + dy, bz = z + dz;
          if (by < 0 || by >= this.height) continue;
          const id = this.getBlock(bx, by, bz);
          if (id === AIR) continue;
          const b = getBlock(id);
          if (b.blastResist > 1000) continue;
          const strength = (1 - d / radius) * (radius * 0.75);
          if (destroyBlocks && rng() < strength / Math.max(1, b.blastResist) * 0.9) {
            affected.push([bx, by, bz, id, rng() < 0.35]);
          }
        }
      }
    }
    for (const [bx, by, bz, id, drop] of affected) {
      this.setBlock(bx, by, bz, fire && id !== AIR ? BLOCK.get('fire') ? BLOCK.get('fire').id : 0 : 0);
      if (opts.onBreak) opts.onBreak(bx, by, bz, id, drop);
    }
    return affected.length;
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.chunks.clear();
  }
}

const DIR6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const DIR4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const tileKey = (x, y, z) => `${x},${y},${z}`;

export default World;
