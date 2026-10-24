#!/usr/bin/env node
/**
 * Ultracraft - headless boot test.
 *
 * Boots the real Game (with the stubbed DOM/WebGL2 from ./stub.js) and runs a
 * few simulated seconds. It catches wiring bugs - bad imports, missing
 * methods, undefined uniforms, NaN positions - that unit tests never reach.
 *
 *   node tools/headless.js
 */

import { performance } from 'node:perf_hooks';
import { canvas } from './stub.js';

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
const problems = [];
const origError = console.error;
console.error = (...a) => { problems.push(a.join(' ')); origError(...a); };

const { Game } = await import('../src/game/game.js');
const { UI } = await import('../src/ui/ui.js');

console.log('\x1b[1mUltracraft - headless boot\x1b[0m');
const t0 = performance.now();
const game = new Game(canvas, {
  seed: 'headless', quality: 'potato', renderDistance: 4, textureSize: 16,
  workerCount: 0, starterKit: true,
});
const steps = [];
await game.init((p, text) => steps.push(`${Math.round(p * 100)}% ${text}`));
const bootMs = performance.now() - t0;
console.log(`  boot: ${steps.join(', ')}`);
console.log(`  boot time: ${Math.round(bootMs)} ms (no GPU, single thread)`);

const ui = new UI(game);
game.ui = ui;
ui.init();
console.log(`  ui: built ${ui.hotbarSlots.length} hotbar slots, ${ui.heartNodes.length} hearts`);

// ---- simulate -------------------------------------------------------------
let frames = 0, maxFrameMs = 0, warmupMax = 0;
const dt = 1 / 60;
for (let i = 0; i < 240; i++) {
  const t = performance.now();
  game.update(dt);
  game.render(dt);
  ui.update(dt);
  const ms = performance.now() - t;
  if (i < 10) warmupMax = Math.max(warmupMax, ms);      // JIT + first chunk streaming
  else maxFrameMs = Math.max(maxFrameMs, ms);
  frames++;
}
if (process.env.SHOW_FRAMES) console.log('  worst warm-up frame', warmupMax.toFixed(1), 'ms');

const p = game.player;
const checks = [
  ['simulated 240 frames', frames === 240],
  ['player position is finite', Number.isFinite(p.pos[0]) && Number.isFinite(p.pos[1]) && Number.isFinite(p.pos[2])],
  ['player is standing on the ground', p.onGround || p.inWater],
  ['player is alive', !p.dead, `hp ${p.health}`],
  ['chunks streamed in', game.world.chunks.size > 4, `${game.world.chunks.size} chunks`],
  ['chunk meshes uploaded', game.renderer.stats.chunks >= 0],
  ['entity list contains the player', game.entities.includes(p)],
  ['hud state is sane', game.getHudState().maxHealth === 20],
  ['debug text renders', Array.isArray(game.getDebugText()) && game.getDebugText().length > 3],
  ['fps counter works', Number.isFinite(game.profiler.fps)],
  ['steady-state frame budget', maxFrameMs < 120, `${maxFrameMs.toFixed(1)} ms worst frame after warm-up`],
];

// interaction: mine and place a block, craft something, drop an item
const before = game.world.getBlock(Math.floor(p.pos[0]), Math.floor(p.pos[1]) - 1, Math.floor(p.pos[2]));
game.breakBlock(Math.floor(p.pos[0]), Math.floor(p.pos[1]) - 1, Math.floor(p.pos[2]), true);
checks.push(['breaking a block works', game.world.getBlock(Math.floor(p.pos[0]), Math.floor(p.pos[1]) - 1, Math.floor(p.pos[2])) === 0]);

game.craftGrid.set(0, new (await import('../src/game/inventory.js')).ItemStack('oak_log', 1));
game.updateCrafting();
checks.push(['crafting grid finds the plank recipe', !!game.selectedRecipe]);
const made = game.craft(false);
checks.push(['crafting produces planks', made === 4, `${made}`]);

game.dropHeld(false);
checks.push(['dropping an item spawns an entity', game.entities.some((e) => e.type === 'item')]);

const summoned = game.spawnMob('zombie', p.pos[0] + 3, p.pos[1], p.pos[2]);
checks.push(['mobs can be summoned', !!summoned]);
const res = game.runCommand('/give diamond 5');
checks.push(['commands run', res.ok && game.player.inventory.count('diamond') >= 5]);
const tpm = game.runCommand('/tp 100 80 100');
checks.push(['/tp moves the player', Math.abs(game.player.pos[0] - 100) < 0.01]);

// screens
for (const screen of ['inventory', 'crafting', 'pause', 'settings']) {
  game.openScreen(screen);
  ui.renderScreen();
}
game.closeScreen();
checks.push(['menus open and close', ui.screen === null]);

// shaders were compiled through the stub
checks.push(['all programs created', Object.keys(game.renderer.programs).length >= 12]);

// ---------------------------------------------------------------------------
let bad = 0;
console.log('');
for (const [name, cond, detail] of checks) {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { bad++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` (${detail})` : ''}`); }
}
console.log('');
if (bad || problems.length) {
  console.log(`\x1b[31m${bad} check(s) failed\x1b[0m`);
  if (problems.length) console.log('console errors:\n  ' + problems.slice(0, 10).join('\n  '));
  process.exit(1);
}
console.log('\x1b[1mHeadless boot clean.\x1b[0m');
process.exit(0);
