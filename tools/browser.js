#!/usr/bin/env node
/**
 * Ultracraft - browser-like boot test.
 *
 * tools/headless.js boots the game against a stubbed WebGL2 context and ticks
 * it in a tight synchronous loop. That covers wiring, but a browser does three
 * things the loop does not: it generates chunks on worker threads, it has a
 * WebAudio graph, and it fires real input events. Those paths simply do not
 * execute in the other suites.
 *
 * This test runs the game the way a browser does - with tools/browserish.js -
 * and then plays it: walk, look, break, place, fight mobs, throw things, open
 * the inventory, switch to the debug overlay, and use touch controls.
 *
 * It is the suite that caught `aabb(out)` being called with no argument from
 * five call sites: hitting a mob, placing a block beside one, sweeping for
 * arrow hits and the F3 overlay all crashed the game with
 * "Cannot set properties of undefined (setting '0')" - in a browser only.
 *
 *   node tools/browser.js         (~15 s, real worker threads and real time)
 */

import { canvas } from './stub.js';
import { installBrowserEnv, sleep } from './browserish.js';

const { fire } = installBrowserEnv(globalThis);
const G = globalThis.window || globalThis;

console.log('\x1b[1mUltracraft - browser-like boot\x1b[0m');

const { Game } = await import('../src/game/game.js');
const { UI } = await import('../src/ui/ui.js');
const { ItemStack } = await import('../src/game/inventory.js');

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
const errors = [];
const record = (label, err) => {
  const text = `${label}: ${err && err.message}`;
  if (errors.some((e) => e.startsWith(text))) return;
  errors.push(`${text}\n${(err && err.stack || '').split('\n').slice(1, 5).join('\n')}`);
};
// async-aware: a frame that rejects must be reported, not crash the suite
const guard = async (label, fn) => {
  try { return await fn(); } catch (err) { record(label, err); return null; }
};
process.on('unhandledRejection', (err) => record('unhandled rejection', err));

const game = new Game(canvas, {
  seed: 'browserboot', quality: 'medium', renderDistance: 5, textureSize: 16,
  workerCount: 3, starterKit: true,
});
await game.init(() => {});
const ui = new UI(game);
game.ui = ui;
ui.init();

const world = game.world;
console.log(`  workers: ${world.workers.length} chunk worker(s), useWorkers=${world.useWorkers}`);

if (!world.useWorkers) {
  console.log('\x1b[31m  the worker path did not start - this test would prove nothing\x1b[0m');
  process.exit(1);
}

const frame = async (dt = 1 / 60) => {
  game.update(dt); game.render(dt); ui.update(dt);
  await sleep(8);            // let worker replies land, as they do in a browser
};

// wait for terrain the way a player does - with the clock running
let waited = 0;
while (world.chunks.size < 40 && waited < 400) { await frame(); waited++; }
console.log(`  terrain: ${world.chunks.size} chunks after ${(waited / 60).toFixed(1)} s, player at y=${game.player.pos[1].toFixed(1)}`);

// ---------------------------------------------------------------------------
// play: keyboard, mouse, wheel, hotbar, menus, debug, touch
// ---------------------------------------------------------------------------
const player = game.player;
guard('pointer lock', () => { document.pointerLockElement = canvas; fire(G, 'pointerlockchange'); });
guard('walk', () => { for (const code of ['KeyW', 'Space', 'ControlLeft']) fire(G, 'keydown', { code, repeat: false }); });
for (let i = 0; i < 40; i++) await guard('walk frames', frame);
guard('look', () => fire(G, 'mousemove', { movementX: 24, movementY: -6 }));
guard('break block', () => { fire(canvas, 'mousedown', { button: 0 }); });
for (let i = 0; i < 25; i++) await guard('breaking', frame);
guard('release attack', () => fire(G, 'mouseup', { button: 0 }));

guard('hold stone', () => { player.inventory.setHeld(new ItemStack('stone', 64)); });
guard('place block', () => fire(canvas, 'mousedown', { button: 2 }));
for (let i = 0; i < 25; i++) await guard('placing', frame);
guard('release use', () => fire(G, 'mouseup', { button: 2 }));

guard('hotbar + wheel', () => {
  for (let d = 1; d <= 9; d++) fire(G, 'keydown', { code: `Digit${d}` });
  fire(canvas, 'wheel', { deltaY: 120 });
  fire(canvas, 'wheel', { deltaY: -120 });
});
guard('inventory', () => fire(G, 'keydown', { code: 'KeyE' }));
for (let i = 0; i < 8; i++) await guard('inventory open', frame);
guard('close inventory', () => fire(G, 'keydown', { code: 'Escape' }));
for (let i = 0; i < 8; i++) await guard('inventory closed', frame);

// mobs: every aabb() call site runs with a live mob in range
const mobs = await guard('spawn mobs', () => ['zombie', 'skeleton', 'pig', 'creeper']
  .map((kind, i) => game.spawnMob(kind, player.pos[0] + 2 + i * 0.6, player.pos[1] + 1, player.pos[2]))
  .filter(Boolean));
console.log(`  mobs: ${mobs ? mobs.length : 0} spawned`);
for (let i = 0; i < 20; i++) await guard('mobs alive', frame);

guard('pick entity (attack path)', () => game.pickEntity(6));
guard('sweep entities', () => {
  game.sweepEntities([player.pos[0], player.pos[1], player.pos[2]], [player.pos[0] + 4, player.pos[1] + 1, player.pos[2]], 0.4, player);
  world.sweepEntities([player.pos[0], player.pos[1], player.pos[2]], [player.pos[0] + 4, player.pos[1] + 1, player.pos[2]], 0.4, player);
});
guard('attack mobs', () => { for (let i = 0; i < 12; i++) game.attack(); });
for (let i = 0; i < 20; i++) await guard('fighting', frame);
// placeBlock(hit, held): the entity-overlap check inside it runs with mobs in range
guard('place beside a mob', () => {
  const held = new ItemStack('stone', 64);
  player.inventory.setHeld(held);
  for (let i = 0; i < 8; i++) {
    const hit = game.raycast();
    if (hit) game.placeBlock(hit, held);
    game.placeCooldown = 0;
  }
});
guard('throw a snowball', () => {
  player.inventory.setHeld(new ItemStack('snowball', 16));
  game.throwProjectile('snowball', new ItemStack('snowball', 16));
});
for (let i = 0; i < 25; i++) await guard('projectile', frame);

guard('debug overlay', () => { fire(G, 'keydown', { code: 'F3' }); fire(G, 'keydown', { code: 'F5' }); });
for (let i = 0; i < 20; i++) await guard('debug frames', frame);

guard('touch controls', () => {
  const stick = (x, y, id) => ({ identifier: id, clientX: x, clientY: y });
  fire(canvas, 'touchstart', { changedTouches: [stick(120, 300, 1)] });
  fire(canvas, 'touchmove', { changedTouches: [stick(120, 240, 1)] });
  fire(canvas, 'touchend', { changedTouches: [stick(120, 240, 1)] });
  fire(canvas, 'touchstart', { changedTouches: [stick(700, 200, 2)] });
  fire(canvas, 'touchend', { changedTouches: [stick(700, 200, 2)] });
});
for (let i = 0; i < 15; i++) await guard('touch frames', frame);

// audio: the engine only builds a graph once a browser gives it a context
const sounds = await guard('audio', () => {
  const names = ['step_grass', 'step_stone', 'place', 'hit', 'hurt', 'splash', 'click', 'pop', 'xp',
    'level_up', 'bow', 'explode', 'portal', 'teleport', 'eat', 'anvil_land', 'piston_out', 'note',
    'fire', 'thunder', 'rain', 'mob_pig', 'mob_zombie', 'mob_creeper_fuse', 'mob_dragon'];
  for (const n of names) game.audio.play(n, player.pos[0], player.pos[1], player.pos[2]);
  game.audio.musicOn = true;
  for (const mood of ['day', 'night', 'nether', 'end']) game.audio.updateMusic(9, mood);
  return names.length;
});
console.log(`  audio: ${sounds} sounds + music graph, ctx=${!!(game.audio && game.audio.ctx)}`);

for (let i = 0; i < 30; i++) await guard('final frames', frame);
guard('blur', () => fire(G, 'blur'));

// ---------------------------------------------------------------------------
await Promise.all((world.workers || []).map((w) => (w.terminate ? w.terminate() : null)));

const aabbOk = await guard('aabb()', () => Number.isFinite(game.entities[0].aabb()[0]));
const checks = [
  ['chunks streamed from workers', world.chunks.size > 40, `${world.chunks.size} chunks`],
  ['player is alive and on the ground', !player.dead && (player.onGround || player.inWater), `y=${player.pos[1].toFixed(1)} onGround=${player.onGround}`],
  ['entity boxes are finite', aabbOk === true, 'aabb() with no argument'],
  ['audio graph is live', !!(game.audio && game.audio.ctx)],
  ['no runtime errors', errors.length === 0, `${errors.length} error(s)`],
];

let bad = 0;
console.log('');
for (const [name, ok, detail] of checks) {
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` \x1b[2m(${detail})\x1b[0m` : ''}`);
  else { bad++; console.log(`  \x1b[31m✗\x1b[0m ${name} \x1b[2m(${detail})\x1b[0m`); }
}

if (errors.length) {
  console.log('\n\x1b[31merrors:\x1b[0m');
  for (const e of errors) console.log(`\n${e}`);
}

console.log('');
if (bad) {
  console.log('\x1b[31m\x1b[1m  browser-like boot failed.\x1b[0m');
  process.exit(1);
}
console.log('\x1b[1mBrowser-like boot clean.\x1b[0m');
process.exit(0);
