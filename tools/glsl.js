/**
 * Ultracraft - real shader compilation.
 *
 * tools/check.js inspects the GLSL structurally (varyings match, an out
 * variable exists, braces balance). That is not enough: the game shipped with
 * `vec2 o = uShadowTexel * 0.75;` where uShadowTexel is a float, and no amount
 * of structural checking notices a dimension mismatch. The headless suite
 * cannot either, because tools/stub.js is a WebGL2 stub that never compiles
 * anything - the bug only showed up on a real driver, as "Failed to start".
 *
 * So this compiles every shader for real, with glslang (the reference Khronos
 * front end, the same one ANGLE and Chrome are built on) built to WebAssembly
 * and vendored under tools/vendor/glslang. It needs no network, no npm
 * install and no GPU: `node tools/glsl.js`.
 *
 * Vendored: glslang 15.4.0, WASM build (emscripten 4.0.9, wasm-opt -Oz),
 * pinned by sha256 in tools/vendor/glslang/manifest.json and verified on every
 * load. Licenses are next to the binary.
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };

console.log(`${C.b}Ultracraft - shader compilation${C.x}`);

const { SHADERS } = await import(pathToFileURL(path.join(ROOT, 'src/render/shaders.js')).href);

let validator;
try {
  const mod = await import(pathToFileURL(path.join(ROOT, 'tools/vendor/glslang/index.mjs')).href);
  validator = await mod.createValidator();
} catch (err) {
  console.log(`${C.r}  cannot load the vendored glslang WASM:${C.x} ${err.message}`);
  process.exit(1);
}
console.log(`  ${C.d}glslang ${validator.version.glslang}, ESSL ${validator.version ? '300 es' : ''}${C.x}`);

/** Pull the offending line out of a shader so the error is actionable. */
function sourceLine(src, n) {
  if (!n) return '';
  const line = src.split('\n')[n - 1] ?? '';
  return line.trim().replace(/\s+/g, ' ').slice(0, 120);
}

let failed = 0;
const programs = Object.entries(SHADERS);

for (const [name, pair] of programs) {
  let result;
  try {
    result = validator.checkPass({ vertex: pair.vert, fragment: pair.frag });
  } catch (err) {
    console.log(`  ${C.r}✗${C.x} ${name}: ${err.message}`);
    failed++;
    continue;
  }

  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  if (!errors.length) {
    console.log(`  ${C.g}✓${C.x} ${name}`);
    continue;
  }

  failed++;
  console.log(`  ${C.r}✗${C.x} ${name} ${C.d}(${errors.length} error${errors.length > 1 ? 's' : ''})${C.x}`);
  for (const d of errors) {
    const src = d.stage === 'vertex' ? pair.vert : pair.frag;
    console.log(`      ${C.d}${d.stage}:${d.line ?? '?'}${C.x} ${d.message.replace(/\s*\n\s*/g, ' ')}`);
    const line = sourceLine(src, d.line);
    if (line) console.log(`      ${C.d}> ${line}${C.x}`);
  }
}

validator.dispose();

console.log('');
if (failed) {
  console.log(`${C.r}${C.b}  ${failed} of ${programs.length} programs do not compile.${C.x}`);
  console.log(`${C.d}  A shader that fails to compile here fails on every real GPU too - the game shows "Failed to start".${C.x}`);
  process.exit(1);
}
console.log(`${C.g}${C.b}  all ${programs.length} programs compile.${C.x}`);
console.log(`${C.d}  every stage compiled by glslang as ESSL 300 - the same spec WebGL2 drivers implement.${C.x}`);
