/**
 * Ultracraft - chunk generation worker.
 *
 * Stateless: generation is a pure function of (cx, cz, seed, dimension, type)
 * so workers never need to talk to each other.
 */

import { WorldGenerator } from './generator.js';

const generators = new Map();

self.onmessage = (e) => {
  const d = e.data;
  try {
    const key = d.seed + '|' + d.dimension + '|' + d.type;
    let g = generators.get(key);
    if (!g) { g = new WorldGenerator(d.seed, d.dimension, d.type); generators.set(key, g); }
    const res = g.generateChunk(d.cx, d.cz);
    res.id = d.id;
    const transfer = [res.blocks.buffer, res.meta.buffer, res.heightMap.buffer];
    self.postMessage(res, transfer);
  } catch (err) {
    self.postMessage({ id: d.id, error: String(err && err.stack || err) });
  }
};
