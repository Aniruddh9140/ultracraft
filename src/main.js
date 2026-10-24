/**
 * Ultracraft - entry point.
 *
 * Boots the renderer, generates the texture atlas, builds the world, wires the
 * UI and hands control to the game loop. Everything is ES modules so there is
 * no build step: open index.html through any static server and it runs.
 */

import { Game } from './game/game.js';
import { UI } from './ui/ui.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('glcanvas');

const state = { game: null, ui: null };

function fail(message, detail) {
  const loading = document.getElementById('loading');
  if (loading) {
    loading.classList.remove('done');
    loading.style.display = 'flex';
    const t = document.getElementById('loading-text');
    const l = document.getElementById('loading-logo');
    if (l) l.textContent = 'ULTRACRAFT';
    if (t) {
      t.innerHTML = `<span class="error">${message}</span>`;
      if (detail) t.innerHTML += `<br><small>${String(detail).slice(0, 400)}</small>`;
    }
    const fill = document.getElementById('loading-fill');
    if (fill) fill.style.width = '100%';
  }
  console.error(message, detail);
}

async function boot() {
  // --- first paint of the loading screen -----------------------------------
  const setProgress = (p, text) => {
    const fill = document.getElementById('loading-fill');
    const label = document.getElementById('loading-text');
    if (fill) fill.style.width = Math.round(p * 100) + '%';
    if (label) label.textContent = text || '';
    // let the browser paint between steps
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  };

  const seed = params.get('seed') || undefined;
  const quality = params.get('quality') || undefined;
  const renderDistance = params.has('rd') ? parseInt(params.get('rd'), 10) : undefined;
  const worldId = params.get('world') || 'world';
  const type = params.get('type') || 'default';

  const game = new Game(canvas, {
    seed, quality, renderDistance, worldId, type,
    textureSize: params.has('tex') ? parseInt(params.get('tex'), 10) : undefined,
  });
  state.game = game;

  await game.init(async (p, text) => { await setProgress(p, text); });

  const ui = new UI(game);
  game.ui = ui;
  state.ui = ui;
  ui.init();

  // canvas clicks grab the pointer (unless a menu is open)
  canvas.addEventListener('mousedown', () => {
    if (!game.screen && game.input && !game.input.locked) game.input.requestLock();
  });
  // keep rendering while the tab is hidden-but-visible
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.input) game.input.releaseAll();
  });

  ui.setLoading(1, 'Ready');
  await new Promise((r) => setTimeout(r, 120));
  ui.hideLoading();
  game.start();

  // expose a small console API for tinkering
  window.Ultracraft = {
    game, ui,
    get world() { return game.world; },
    get player() { return game.player; },
    get renderer() { return game.renderer; },
    command(cmd) { return game.runCommand(cmd); },
    save() { return game.save(); },
  };
  console.log('%cUltracraft', 'font:700 28px sans-serif;color:#7ce38b',
    `\nready in ${Math.round(game.bootMs)} ms · ${game.world.chunks.size} chunks · seed ${game.seed}`);

  // register the offline service worker (progressive enhancement)
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

window.addEventListener('error', (e) => fail('Something went wrong', e.message));
window.addEventListener('unhandledrejection', (e) => fail('Something went wrong', e.reason && e.reason.message));

if (!window.WebGL2RenderingContext) {
  fail('WebGL2 is required', 'Try a recent Chrome, Edge, Firefox or Safari 15+.');
} else {
  boot().catch((e) => fail('Failed to start', e && (e.stack || e.message)));
}

export default state;
