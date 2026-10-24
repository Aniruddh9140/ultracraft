/**
 * Ultracraft - world persistence.
 *
 * Chunks (typed arrays), the player, tile entities and world settings are
 * written to IndexedDB without any serialisation cost - structured clone
 * handles Uint16Array/Uint8Array natively. A tiny localStorage fallback stores
 * the metadata only, so the game still works in private-browsing modes.
 */

const DB_NAME = 'ultracraft';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('worlds')) db.createObjectStore('worlds', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class SaveSystem {
  constructor() {
    this.db = null;
    this.worldId = 'world';
    this.ready = false;
    this.pending = new Map();    // chunkKey -> data (batched writes)
    this.flushTimer = 0;
  }

  async init(worldId = 'world') {
    this.worldId = worldId;
    this.db = await openDB();
    this.ready = true;
    return !!this.db;
  }

  key(cx, cz, dim) { return `${dim}:${cx}:${cz}`; }

  /** Queue a chunk for writing. */
  queueChunk(chunk, dim) {
    if (!this.db) return;
    this.pending.set(this.key(chunk.cx, chunk.cz, dim), { dim, cx: chunk.cx, cz: chunk.cz, data: chunk.serialize() });
  }

  /** Write all queued chunks (called every few seconds / on unload). */
  async flush() {
    if (!this.db || !this.pending.size) return;
    const items = [...this.pending.values()];
    this.pending.clear();
    const store = tx(this.db, 'chunks', 'readwrite');
    for (const it of items) {
      try { store.put(it, `${this.worldId}:${it.dim}:${it.cx}:${it.cz}`); } catch (e) { /* quota */ }
    }
  }

  async loadChunk(cx, cz, dim) {
    if (!this.db) return null;
    try {
      const r = await wrap(tx(this.db, 'chunks', 'readonly').get(`${this.worldId}:${dim}:${cx}:${cz}`));
      return r || null;
    } catch (e) { return null; }
  }

  async saveMeta(key, value) {
    if (!this.db) {
      try { localStorage.setItem('ultracraft:' + this.worldId + ':' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
      return;
    }
    try { await wrap(tx(this.db, 'meta', 'readwrite').put(value, `${this.worldId}:${key}`)); } catch (e) { /* ignore */ }
  }

  async loadMeta(key) {
    if (!this.db) {
      try {
        const s = localStorage.getItem('ultracraft:' + this.worldId + ':' + key);
        return s ? JSON.parse(s) : null;
      } catch (e) { return null; }
    }
    try {
      return await wrap(tx(this.db, 'meta', 'readonly').get(`${this.worldId}:${key}`));
    } catch (e) { return null; }
  }

  /** List every saved world for the world-selection screen. */
  async listWorlds() {
    const local = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith('ultracraft:')) local.push({ id: k.split(':')[1], source: 'local' });
      }
    } catch (e) { /* ignore */ }
    if (!this.db) return local;
    try {
      const all = await wrap(tx(this.db, 'worlds', 'readonly').getAll());
      return [...all, ...local];
    } catch (e) { return local; }
  }

  async saveWorldInfo(info) {
    if (!this.db) {
      try { localStorage.setItem('ultracraft:' + this.worldId + ':info', JSON.stringify(info)); } catch (e) { /* ignore */ }
      return;
    }
    try { await wrap(tx(this.db, 'worlds', 'readwrite').put(Object.assign({ id: this.worldId }, info))); } catch (e) { /* ignore */ }
  }

  /** Delete everything for the current world. */
  async wipe() {
    this.pending.clear();
    if (!this.db) {
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k.startsWith('ultracraft:' + this.worldId)) keys.push(k);
        }
        keys.forEach((k) => localStorage.removeItem(k));
      } catch (e) { /* ignore */ }
      return;
    }
    try { await wrap(tx(this.db, 'chunks', 'readwrite').clear()); } catch (e) { /* ignore */ }
    try { await wrap(tx(this.db, 'meta', 'readwrite').clear()); } catch (e) { /* ignore */ }
  }

  update(dt) {
    this.flushTimer -= dt;
    if (this.flushTimer <= 0) { this.flushTimer = 6; this.flush(); }
  }
}

export default SaveSystem;
