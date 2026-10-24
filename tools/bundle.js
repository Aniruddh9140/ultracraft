#!/usr/bin/env node
/**
 * Ultracraft - single-file bundler.
 *
 * Walks the ES module graph from an entry point, rewrites every module into a
 * tiny CommonJS-style runtime and inlines the lot (plus the CSS) into one
 * self-contained HTML file. The result has no imports, no fetches and no
 * server requirement: double-click it and it plays.
 *
 *   node tools/bundle.js                  -> Ultracraft.html
 *   node tools/bundle.js --out /tmp/x.html
 *   node tools/bundle.js --verify         -> boot the bundle headlessly too
 *
 * The only transformation that is not mechanical is the chunk worker: a
 * `file://` page cannot load a module worker by URL, so the worker gets its
 * own self-contained bundle which is handed over as a Blob URL at runtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const OUT = path.resolve(ROOT, argOf('--out', 'Ultracraft.html'));
const VERIFY = argv.includes('--verify');
const APP_ENTRY = 'src/main.js';
const WORKER_ENTRIES = ['src/world/genworker.js'];

// ---------------------------------------------------------------------------
// module resolution
// ---------------------------------------------------------------------------
const cache = new Map();

function readModule(id) {
  if (cache.has(id)) return cache.get(id);
  const file = path.join(ROOT, id);
  if (!fs.existsSync(file)) throw new Error(`cannot resolve ${id}`);
  const mod = { id, file, src: fs.readFileSync(file, 'utf8'), deps: [] };
  cache.set(id, mod);
  return mod;
}

function resolve(spec, fromId) {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const base = spec.startsWith('/') ? ROOT : path.dirname(path.join(ROOT, fromId));
    let p = path.resolve(base, spec);
    if (!path.extname(p)) p += '.js';
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.js');
    return path.relative(ROOT, p).split(path.sep).join('/');
  }
  throw new Error(`bare specifier "${spec}" in ${fromId} (Ultracraft has no dependencies)`);
}

/** Split "A, { b, c as d }, * as ns" into its parts. */
function parseImportClause(clause) {
  const out = { default: null, named: [], namespace: null };
  let rest = clause.trim();
  const ns = rest.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (ns) {
    out.namespace = ns[1];
    rest = rest.replace(ns[0], ' ');
  }
  const braces = rest.match(/\{([\s\S]*?)\}/);
  if (braces) {
    rest = rest.replace(braces[0], ' ');
    for (const part of braces[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      out.named.push(as.length === 2 ? [as[0].trim(), as[1].trim()] : [t, t]);
    }
  }
  const def = rest.replace(/,/g, ' ').trim();
  if (def && /^[A-Za-z_$][\w$]*$/.test(def)) out.default = def;
  return out;
}

/**
 * Names bound by a declaration head: "a = 1, b = 2" -> ["a", "b"];
 * "foo(a, b) {" -> ["foo"]. Commas inside brackets, braces or quotes are
 * ignored, so object/array literals and strings cannot split a name.
 */
function declaredNames(decl) {
  const parts = [];
  let depth = 0, cur = '', quote = null;
  for (let i = 0; i < decl.length; i++) {
    const ch = decl[i];
    if (quote) {
      if (ch === '\\') { cur += ch + (decl[i + 1] || ''); i++; continue; }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);

  const names = [];
  for (const p of parts) {
    const head = p.split('=')[0].trim();
    const m = head.match(/^([A-Za-z_$][\w$]*)/);
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

// ---------------------------------------------------------------------------
// ESM -> runtime module
// ---------------------------------------------------------------------------
const importRe = /(^|\n)[ \t]*import\s+(?:([\w*\s{},$]+?)\s+from\s+)?(['"])([^'"]+)\3\s*;?/g;

function transform(mod) {
  let src = mod.src;

  // ---- worker construction: module worker by URL -> bundled blob worker ----
  src = src.replace(
    /new\s+Worker\(\s*new\s+URL\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)\s*(?:,\s*\{[^}]*\}\s*)?\)/g,
    (_m, _q, spec) => `__uc.worker(${JSON.stringify(resolve(spec, mod.id))})`,
  );

  // ---- imports -------------------------------------------------------------
  const requireLines = [];
  src = src.replace(importRe, (_all, lead, clause, _q, spec) => {
    const id = resolve(spec, mod.id);
    if (!mod.deps.includes(id)) mod.deps.push(id);
    if (!clause) { requireLines.push(`__req(${JSON.stringify(id)});`); return lead; }
    const c = parseImportClause(clause);
    const lines = [];
    if (c.namespace) lines.push(`const ${c.namespace} = __req(${JSON.stringify(id)});`);
    else if (c.default || c.named.length) {
      const tmp = `__m${requireLines.length}`;
      lines.push(`const ${tmp} = __req(${JSON.stringify(id)});`);
      if (c.default) lines.push(`const ${c.default} = ${tmp}.default !== undefined ? ${tmp}.default : ${tmp};`);
      if (c.named.length) {
        lines.push(`const { ${c.named.map(([a, b]) => (a === b ? a : `${a}: ${b}`)).join(', ')} } = ${tmp};`);
      }
    }
    requireLines.push(...lines);
    return lead;
  });

  // ---- exports -------------------------------------------------------------
  // Each form gets its own pass: the interesting part of a declaration lives
  // *after* the keyword, so every pass captures the rest of the line.
  const exportLines = [];

  // export default <expr>;   (also `export default function f` / `class C`)
  src = src.replace(/(^|\n)([ \t]*)export\s+default\s+([^\n]+)/g, (_all, lead, indent, expr) => {
    const fn = expr.match(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/);
    const cl = expr.match(/^class\s+([A-Za-z_$][\w$]*)/);
    if (fn) { exportLines.push(`exports.default = ${fn[1]};`); return `${lead}${indent}${expr}`; }
    if (cl) { exportLines.push(`exports.default = ${cl[1]};`); return `${lead}${indent}${expr}`; }
    exportLines.push(`exports.default = ${expr.replace(/;\s*$/, '')};`);
    return lead;
  });

  // export { a, b as c };     and     export { a, b as c } from './x.js';
  src = src.replace(/(^|\n)[ \t]*export\s*\{([\s\S]*?)\}\s*(?:from\s*(['"])([^'"]+)\3\s*)?;?/g,
    (_all, lead, names, _q, spec) => {
      if (spec) {
        const id = resolve(spec, mod.id);
        if (!mod.deps.includes(id)) mod.deps.push(id);
        const tmp = `__re${exportLines.length}`;
        requireLines.push(`const ${tmp} = __req(${JSON.stringify(id)});`);
        for (const part of names.split(',')) {
          const t = part.trim();
          if (!t) continue;
          const as = t.split(/\s+as\s+/);
          exportLines.push(`exports.${(as[1] || as[0]).trim()} = ${tmp}.${as[0].trim()};`);
        }
        return lead;
      }
      for (const part of names.split(',')) {
        const t = part.trim();
        if (!t) continue;
        const as = t.split(/\s+as\s+/);
        exportLines.push(`exports.${(as[1] || as[0]).trim()} = ${as[0].trim()};`);
      }
      return lead;
    });

  // export const / let / var / class / function ...
  src = src.replace(/(^|\n)([ \t]*)export\s+(const|let|var|class|function\s*\*?|async\s+function)\s+([^\n]+)/g,
    (_all, lead, indent, kind, rest) => {
      for (const n of declaredNames(rest)) exportLines.push(`exports.${n} = ${n};`);
      return `${lead}${indent}${kind} ${rest}`;
    });

  // anything left (export * from, exotic syntax) must not slip through silently
  if (/(^|\n)[ \t]*export[\s{*]/.test(src)) {
    throw new Error(`unhandled export statement in ${mod.id}`);
  }

  const body = [...requireLines, '', src.trim(), '', ...exportLines].join('\n');
  mod.code = body;
  return mod;
}

// ---------------------------------------------------------------------------
// graph
// ---------------------------------------------------------------------------
function buildGraph(entryId) {
  const seen = new Set();
  const order = [];
  const stack = [];
  const cycles = [];

  const visit = (id) => {
    if (seen.has(id)) return;
    const mod = transform(readModule(id));
    seen.add(id);
    stack.push(id);
    for (const dep of mod.deps) {
      if (stack.includes(dep)) cycles.push(`${dep} <-> ${id}`);
      visit(dep);
    }
    stack.pop();
    order.push(id);
  };
  visit(entryId);
  return { order, cycles };
}

const RUNTIME = `
var __uc = (function () {
  var moduleSources = {};
  var moduleCache = {};
  var workerSources = {};

  function req(id) {
    var hit = moduleCache[id];
    if (hit) return hit.exports;
    var m = (moduleCache[id] = { exports: {} });
    var fn = moduleSources[id];
    if (!fn) throw new Error('module not found: ' + id);
    fn(m, m.exports, req);
    return m.exports;
  }

  function workerUrl(id) {
    var src = workerSources[id];
    if (!src || typeof Worker === 'undefined' || typeof Blob === 'undefined') return null;
    return URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  }

  function worker(id) {
    var url = workerUrl(id);
    if (!url) throw new Error('workers unavailable');
    var w = new Worker(url);
    w.__ucBlob = url;
    return w;
  }

  function define(id, fn) { moduleSources[id] = fn; }
  function defineWorker(id, src) { workerSources[id] = src; }

  return { req: req, define: define, defineWorker: defineWorker, worker: worker, workerUrl: workerUrl };
})();
var __req = __uc.req;
`;

/** Escape a script so it cannot break out of an inline <script> block. */
const forInlineScript = (s) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

function bundleScript(entryId, extraWorkers = []) {
  const { order, cycles } = buildGraph(entryId);
  if (cycles.length) console.log(`  ! import cycle(s): ${[...new Set(cycles)].join(', ')}`);
  const parts = [RUNTIME];
  for (const id of order) {
    const mod = cache.get(id);
    parts.push(`__uc.define(${JSON.stringify(id)}, function (module, exports, __req) {\n${mod.code}\n});`);
  }
  for (const id of extraWorkers) {
    const src = bundleWorker(id);
    parts.push(`__uc.defineWorker(${JSON.stringify(id)}, ${JSON.stringify(src)});`);
  }
  parts.push(`__req(${JSON.stringify(entryId)});`);
  return { script: parts.join('\n'), order };
}

function bundleWorker(entryId) {
  const savedCache = new Map(cache);
  const savedOut = [];
  // a fresh graph so the worker gets its own copy of shared modules
  const { order } = (() => {
    cache.clear();
    return buildGraph(entryId);
  })();
  const parts = [RUNTIME];
  for (const id of order) parts.push(`__uc.define(${JSON.stringify(id)}, function (module, exports, __req) {\n${cache.get(id).code}\n});`);
  parts.push(`__req(${JSON.stringify(entryId)});`);
  savedOut.push(parts.join('\n'));
  cache.clear();
  for (const [k, v] of savedCache) cache.set(k, v);
  return savedOut[0];
}

// ---------------------------------------------------------------------------
// html
// ---------------------------------------------------------------------------
function buildHtml() {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'styles', 'main.css'), 'utf8');

  console.log('  bundling src/main.js ...');
  const { script, order } = bundleScript(APP_ENTRY, WORKER_ENTRIES);

  // stylesheet: inline, drop the <link>
  html = html.replace(/[ \t]*<link rel="stylesheet"[^>]*>\n?/, `<style>\n${css}\n</style>\n`);
  // the web app manifest needs a real URL, which a file:// page does not have
  html = html.replace(/[ \t]*<link rel="manifest"[^>]*>\n?/, '');
  // entry script: swap the module tag for the self-contained bundle
  html = html.replace(
    /[ \t]*<script type="module"[^>]*><\/script>/,
    `<script>\n${forInlineScript(script)}\n</script>`,
  );
  if (html.includes('type="module"')) throw new Error('failed to replace the module script tag');

  const banner = `<!--
  Ultracraft - single-file build.

  Generated by tools/bundle.js from ${order.length} ES modules.
  Everything (game, renderer, texture generators, worker) is inlined below:
  no imports, no network, no server. Double-click this file to play.

  Source: https://github.com/Aniruddh9140/ultracraft
-->
`;
  html = html.replace('<head>', `<head>\n${banner}`);
  return { html, modules: order.length };
}

// ---------------------------------------------------------------------------
// verify: boot the generated bundle against the headless DOM/WebGL2 stub
// ---------------------------------------------------------------------------
async function verify(html) {
  console.log('  verifying the bundle headlessly ...');
  await import(pathToFileURL(path.join(ROOT, 'tools/stub.js')).href);
  const stubWindow = globalThis.window;
  stubWindow.WebGL2RenderingContext = globalThis.WebGL2RenderingContext;

  const m = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
  if (!m) throw new Error('no inline script found in the bundle');
  // eslint-disable-next-line no-new-func
  new Function(m[1])();

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const g = stubWindow.Ultracraft && stubWindow.Ultracraft.game;
    if (g && g.started !== false && g.world && g.world.chunks.size > 0 && g.player) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // every inlined worker must be valid JavaScript on its own
  let workers = 0;
  for (const m of html.matchAll(/\n__uc\.defineWorker\("([^"]+)", ("(?:[^"\\]|\\.)*")\);/g)) {
    const src = JSON.parse(m[2]);
    try { new Function(src); } catch (e) { throw new Error(`worker ${m[1]} does not parse: ${e.message}`); }
    workers++;
  }
  if (!workers) throw new Error('no worker was inlined');
  console.log(`  inlined workers: ${workers}, all parse`);

  const g = stubWindow.Ultracraft && stubWindow.Ultracraft.game;
  if (!g) throw new Error('the bundle never exposed window.Ultracraft');
  for (let i = 0; i < 30; i++) g.tick(1 / 20);
  const finite = Number.isFinite(g.player.pos[0]) && Number.isFinite(g.player.pos[1]);
  if (!finite) throw new Error('player position is not finite after 30 ticks');
  console.log(`  bundle boots: ${g.world.chunks.size} chunks, player at ` +
    `${g.player.pos.map((n) => n.toFixed(1)).join(', ')}, ${Object.keys(g.renderer.programs).length} programs`);
  // the game loop keeps scheduling animation frames, so stop before returning
  if (g.stop) { try { g.stop(); } catch (e) { /* ignore */ } }
  return true;
}

// ---------------------------------------------------------------------------
console.log('\x1b[1mUltracraft - single-file build\x1b[0m');
const t0 = Date.now();
const { html, modules } = buildHtml();
fs.writeFileSync(OUT, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`  wrote ${path.relative(ROOT, OUT)} (${modules} modules, ${kb} kB) in ${Date.now() - t0} ms`);
console.log('  open it directly from disk - no server required');

if (VERIFY) {
  const okVerify = await verify(html);
  console.log('');
  process.exit(okVerify ? 0 : 1);
}
console.log('');
