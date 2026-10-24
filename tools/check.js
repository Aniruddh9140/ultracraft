#!/usr/bin/env node
/**
 * Ultracraft - static checker.
 *
 * 1. parses every JavaScript file in the repository (`node --check`)
 * 2. imports every ES module in Node to catch missing / misspelled exports
 * 3. cross-checks the registries: block -> texture names, item -> icon names,
 *    mob drops -> item names, recipe ingredients -> item names
 *
 * No browser and no dependencies required.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
let checked = 0;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

console.log('Ultracraft - static check\n');

// ---------------------------------------------------------------------------
// 1. syntax
// ---------------------------------------------------------------------------
const files = walk(ROOT);
for (const f of files) {
  const rel = path.relative(ROOT, f);
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    checked++;
  } catch (e) {
    const msg = (e.stderr ? e.stderr.toString() : e.message).split('\n').slice(0, 6).join('\n');
    problems.push(`SYNTAX ${rel}\n${msg}`);
  }
}
console.log(`  syntax: ${checked}/${files.length} files parsed`);

// ---------------------------------------------------------------------------
// 2. module imports
// ---------------------------------------------------------------------------
// entry scripts touch `window` / `self` / `location` and can only run in a
// browser or a worker, so they are syntax-checked but not imported.
const ENTRY = new Set(['src/main.js', 'src/world/genworker.js', 'sw.js']);
const importable = files.filter((f) => {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  return !rel.startsWith('tools/') && !ENTRY.has(rel);
});
const imported = [];
for (const f of importable) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  try {
    await import(pathToFileURL(f).href);
    imported.push(rel);
  } catch (e) {
    problems.push(`IMPORT ${rel}: ${(e && e.message) || e}`);
  }
}
console.log(`  imports: ${imported.length}/${importable.length} modules loaded (${files.length - importable.length} entry scripts skipped)`);

// ---------------------------------------------------------------------------
// 3. registry cross-checks
// ---------------------------------------------------------------------------
const { BLOCKS, getBlock } = await import(pathToFileURL(path.join(ROOT, 'src/world/blocks.js')).href);
const { ITEMS, getItem } = await import(pathToFileURL(path.join(ROOT, 'src/world/items.js')).href);
const { TEX_TABLE: T } = await import(pathToFileURL(path.join(ROOT, "src/render/texturegen.js")).href);
const { ICON_TABLE: I } = await import(pathToFileURL(path.join(ROOT, "src/render/itemgen.js")).href);
const { MOB_DEFS } = await import(pathToFileURL(path.join(ROOT, 'src/entity/mobs.js')).href);
const { CRAFTING, SHAPELESS, FURNACE, BLAST, SMOKER, FUELS } = await import(pathToFileURL(path.join(ROOT, 'src/game/recipes.js')).href);

const texNames = new Set(Object.keys(T));
const iconNames = new Set(Object.keys(I));
const itemNames = new Set(ITEMS.filter(Boolean).map((i) => i.name));
const blockNames = new Set(BLOCKS.map((b) => b.name));

let textureRefs = 0, missingTex = 0;
for (const b of BLOCKS) {
  if (!b.tex) continue;
  for (const v of Object.values(b.tex)) {
    textureRefs++;
    if (!texNames.has(v) && !iconNames.has(v)) { missingTex++; if (missingTex < 12) problems.push(`TEXTURE block "${b.name}" references unknown texture "${v}"`); }
  }
  if (b.stageTex) {
    for (let i = 0; i <= (b.maxAge || 7); i++) {
      textureRefs++;
      if (!texNames.has(b.stageTex + i)) { missingTex++; if (missingTex < 12) problems.push(`TEXTURE crop "${b.name}" missing stage ${b.stageTex}${i}`); }
    }
  }
}
console.log(`  textures: ${textureRefs} references, ${missingTex} missing`);

let itemTex = 0, missingItemTex = 0;
for (const it of ITEMS) {
  if (!it || !it.tex) continue;
  itemTex++;
  if (!iconNames.has(it.tex) && !texNames.has(it.tex)) {
    missingItemTex++;
    if (missingItemTex < 12) problems.push(`ICON item "${it.name}" references unknown icon "${it.tex}"`);
  }
}
console.log(`  item icons: ${itemTex} references, ${missingItemTex} missing`);

// mob drops resolve to real items
let badDrops = 0;
for (const [name, def] of Object.entries(MOB_DEFS)) {
  for (const d of (def.drops || [])) {
    if (!itemNames.has(d[0])) { badDrops++; problems.push(`MOB "${name}" drops unknown item "${d[0]}"`); }
  }
}
console.log(`  mob drops: ${Object.keys(MOB_DEFS).length} mobs, ${badDrops} bad drops`);

// recipe results/ingredients resolve
const allIds = new Set(ITEMS.filter(Boolean).map((i) => i.id));
let badRecipes = 0;
const checkRecipe = (r, kind) => {
  if (!allIds.has(r.result)) { badRecipes++; problems.push(`RECIPE ${kind} result id ${r.result} is not an item`); }
  for (const ing of (r.ing || [])) {
    if (ing && !allIds.has(ing)) { badRecipes++; problems.push(`RECIPE ${kind} ingredient id ${ing} is not an item`); }
  }
};
for (const r of CRAFTING) checkRecipe(r, 'shaped');
for (const r of SHAPELESS) checkRecipe(r, 'shapeless');
for (const [k, v] of FURNACE) if (!allIds.has(k) || !allIds.has(v.result)) badRecipes++;
console.log(`  recipes: ${CRAFTING.length + SHAPELESS.length} crafting, ${FURNACE.size} smelting, ${FUELS.size} fuels, ${badRecipes} broken`);

// block <-> item id parity
let idMismatch = 0;
for (const b of BLOCKS) {
  const it = getItem(b.id);
  if (!it || it.name !== b.name) { idMismatch++; if (idMismatch < 8) problems.push(`PARITY block ${b.id} "${b.name}" has item "${it ? it.name : 'none'}"`); }
}
console.log(`  parity: ${idMismatch} block/item id mismatches`);

// ---------------------------------------------------------------------------
// 7. GLSL sanity - structural only: real compilation lives in
//    tools/glsl.js, which builds every stage with glslang.
// ---------------------------------------------------------------------------
const { SHADERS } = await import(pathToFileURL(path.join(ROOT, 'src/render/shaders.js')).href);

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');

/** Collect global `uniform|in|out|const TYPE name` declarations. */
function globals(src) {
  const out = new Map();
  const re = /\b(uniform|in|out|const|flat|smooth)\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+(\w+)\s*(\[[^\]]*\])?\s*;/g;
  let m;
  while ((m = re.exec(src))) out.set(m[3], m[2]);
  return out;
}

let shaderCount = 0, shaderProblems = 0;
const report = (msg) => { shaderProblems++; if (shaderProblems < 25) problems.push(`GLSL ${msg}`); };

for (const [name, pair] of Object.entries(SHADERS)) {
  for (const stage of ['vert', 'frag']) {
    const raw = pair[stage];
    if (!raw) { report(`${name}.${stage}: missing`); continue; }
    shaderCount++;
    const src = stripComments(raw);

    // version + precision
    if (!/^\s*#version 300 es/.test(src)) report(`${name}.${stage}: missing "#version 300 es"`);
    if (!/precision\s+(highp|mediump|lowp)\s+float/.test(src)) report(`${name}.${stage}: no float precision qualifier`);

    // balanced braces / parens
    for (const [open, close] of [['{', '}'], ['(', ')'], ['[', ']']]) {
      const a = (src.match(new RegExp('\\' + open, 'g')) || []).length;
      const b = (src.match(new RegExp('\\' + close, 'g')) || []).length;
      if (a !== b) report(`${name}.${stage}: unbalanced ${open}${close} (${a} vs ${b})`);
    }

    // duplicate global declarations
    const seen = new Map();
    for (const line of src.split('\n')) {
      const m = /^\s*uniform\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+(\w+)/.exec(line);
      if (!m) continue;
      if (seen.has(m[2])) report(`${name}.${stage}: uniform "${m[2]}" declared twice (${seen.get(m[2])} and ${m[1]})`);
      seen.set(m[2], m[1]);
    }

    // every uIdentifier used must be declared (catches renames and typos)
    const decl = globals(src);
    const used = new Set(src.match(/\bu[A-Z]\w*/g) || []);
    for (const u of used) if (!decl.has(u)) report(`${name}.${stage}: "${u}" used but never declared`);

    // vertex outputs must match fragment inputs
    if (stage === 'vert') {
      const outs = [...src.matchAll(/^\s*(?:flat\s+|smooth\s+)?out\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+(\w+)\s*;/gm)].map((m) => m[2] + ':' + m[1]);
      const fragSrc = stripComments(pair.frag || '');
      const ins = [...fragSrc.matchAll(/^\s*(?:flat\s+|smooth\s+)?in\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+(\w+)\s*;/gm)].map((m) => m[2] + ':' + m[1]);
      for (const i of ins) if (!outs.includes(i)) report(`${name}: fragment reads "${i}" that the vertex shader does not write`);
    }
  }
  // fragment outputs
  // depth-only passes legitimately write no colour attachment
  const DEPTH_ONLY = new Set(['chunkShadow']);
  const frag = stripComments(pair.frag || '');
  if (frag && !DEPTH_ONLY.has(name) && !/layout\s*\(\s*location\s*=\s*\d+\s*\)\s*out\s+vec4/.test(frag)) report(`${name}: fragment shader has no "layout(location = N) out vec4"`);
}
console.log(`  shaders: ${shaderCount} stages checked, ${shaderProblems} problem(s)`);

// ---------------------------------------------------------------------------
console.log('');
if (problems.length) {
  console.log(`${problems.length} problem(s):\n`);
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
} else {
  console.log('All checks passed.');
  console.log(`  ${BLOCKS.length} blocks · ${ITEMS.filter(Boolean).length} items · ${Object.keys(MOB_DEFS).length} mobs · ${Object.keys(T).length} textures · ${Object.keys(I).length} item icons`);
}
