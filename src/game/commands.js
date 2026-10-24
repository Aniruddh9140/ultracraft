/**
 * Ultracraft - the command system.
 *
 * A compact dispatcher used by the chat window, command blocks, datapack-style
 * functions and the server console. Every command returns a list of messages
 * so the caller can render them however it likes.
 */

import { GAMEMODE } from '../entity/player.js';
import { ItemStack } from './inventory.js';
import { itemId, getItem, ITEMS } from '../world/items.js';
import { blockId, BLOCKS, getBlock, AIR } from '../world/blocks.js';
import { MOB_DEFS } from '../entity/mobs.js';
import { EFFECTS } from '../entity/player.js';

function num(v, d = 0) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
function coord(v, base) {
  if (typeof v !== 'string' || !v.length) return base;
  if (v.startsWith('~')) return base + num(v.slice(1), 0);
  if (v.startsWith('^')) return base; // local axes, unused
  return num(v, base);
}

export class CommandSystem {
  constructor(game) {
    this.game = game;
    this.history = [];
    this.historyIndex = 0;
    this.commands = new Map();
    this.registerAll();
  }

  register(name, def) { this.commands.set(name, def); this.commands.set(name[0] ? name : name, def); }

  registerAll() {
    const g = () => this.game;

    this.register('help', {
      desc: 'List commands', usage: '/help [page]',
      exec: (a) => {
        const page = Math.max(1, num(a[0], 1));
        const names = [...this.commands.keys()].sort();
        const per = 8;
        const slice = names.slice((page - 1) * per, page * per);
        return [`--- Commands (${page}/${Math.ceil(names.length / per)}) ---`,
          ...slice.map((n) => `/${n} - ${this.commands.get(n).desc}`)];
      },
    });

    this.register('gamemode', {
      desc: 'Change game mode', usage: '/gamemode <survival|creative|adventure|spectator> [player]',
      exec: (a) => {
        const m = a[0];
        const map = { 0: 'survival', 1: 'creative', 2: 'adventure', 3: 'spectator', s: 'survival', c: 'creative', a: 'adventure', sp: 'spectator' };
        const mode = map[m] || (Object.values(GAMEMODE).includes(m) ? m : null);
        if (!mode) return ['Unknown game mode: ' + m];
        g().setGamemode(mode);
        return [`Set game mode to ${mode}`];
      },
    });
    this.register('gmc', { desc: 'Creative mode', exec: () => { g().setGamemode('creative'); return ['Creative mode']; } });
    this.register('gms', { desc: 'Survival mode', exec: () => { g().setGamemode('survival'); return ['Survival mode']; } });
    this.register('gma', { desc: 'Adventure mode', exec: () => { g().setGamemode('adventure'); return ['Adventure mode']; } });
    this.register('gmsp', { desc: 'Spectator mode', exec: () => { g().setGamemode('spectator'); return ['Spectator mode']; } });

    this.register('give', {
      desc: 'Give an item', usage: '/give <item> [count] [nbtless]',
      exec: (a) => {
        const name = a[0];
        const id = itemId(name) || blockId(name);
        if (!id) return ['Unknown item: ' + name];
        const count = Math.max(1, Math.min(6400, num(a[1], 1)));
        const stack = new ItemStack(id, count);
        const left = g().player.inventory.add(stack);
        return [`Given ${count} ${getItem(id).name}${left ? ` (${left} did not fit)` : ''}`];
      },
    });

    this.register('tp', {
      desc: 'Teleport', usage: '/tp [x y z] | /tp <player>',
      exec: (a) => {
        const p = g().player;
        if (a.length >= 3) {
          const x = coord(a[0], p.pos[0]), y = coord(a[1], p.pos[1]), z = coord(a[2], p.pos[2]);
          p.setPos(x, y, z);
          p.vel.fill(0);
          return [`Teleported to ${x.toFixed(1)} ${y.toFixed(1)} ${z.toFixed(1)}`];
        }
        if (a.length === 1 && a[0] !== '~') {
          const t = g().entities.find((e) => e.name === a[0] || e.type === a[0]);
          if (!t) return ['No such entity'];
          p.setPos(t.pos[0], t.pos[1], t.pos[2]);
          return ['Teleported to ' + a[0]];
        }
        return ['Usage: /tp <x> <y> <z>'];
      },
    });

    this.register('spawnpoint', {
      desc: 'Set your spawn', usage: '/spawnpoint [x y z]',
      exec: (a) => {
        const p = g().player;
        if (a.length >= 3) p.setSpawn(coord(a[0], p.pos[0]), coord(a[1], p.pos[1]), coord(a[2], p.pos[2]));
        else p.setSpawn(p.pos[0], p.pos[1], p.pos[2]);
        return ['Spawn point set'];
      },
    });

    this.register('time', {
      desc: 'Set the time', usage: '/time <day|night|noon|midnight|number>',
      exec: (a) => {
        const map = { day: 1000, night: 13000, noon: 6000, midnight: 18000, sunrise: 23000, sunset: 12000 };
        const v = a[0];
        const t = map[v] !== undefined ? map[v] : num(v, NaN);
        if (!Number.isFinite(t)) return ['Usage: /time <day|night|noon|midnight|number>'];
        g().setTime(t);
        return [`Time set to ${Math.round(t)}`];
      },
    });

    this.register('weather', {
      desc: 'Set the weather', usage: '/weather <clear|rain|thunder> [seconds]',
      exec: (a) => {
        const dur = num(a[1], 600) * 20;
        if (a[0] === 'clear') g().setWeather('clear', dur);
        else if (a[0] === 'rain') g().setWeather('rain', dur);
        else if (a[0] === 'thunder') g().setWeather('thunder', dur);
        else return ['Usage: /weather <clear|rain|thunder>'];
        return ['Weather set to ' + a[0]];
      },
    });

    this.register('difficulty', {
      desc: 'Set difficulty', usage: '/difficulty <peaceful|easy|normal|hard>',
      exec: (a) => {
        const d = ['peaceful', 'easy', 'normal', 'hard'];
        if (!d.includes(a[0])) return ['Usage: /difficulty <peaceful|easy|normal|hard>'];
        g().difficulty = a[0];
        return ['Difficulty set to ' + a[0]];
      },
    });

    this.register('gamerule', {
      desc: 'Change a game rule', usage: '/gamerule <rule> [value]',
      exec: (a) => {
        const rules = g().gamerules;
        if (!a[0]) return ['Rules: ' + Object.keys(rules).join(', ')];
        if (!(a[0] in rules)) return ['Unknown rule: ' + a[0]];
        if (a[1] === undefined) return [`${a[0]} = ${rules[a[0]]}`];
        const v = a[1] === 'true' ? true : a[1] === 'false' ? false : num(a[1], a[1]);
        rules[a[0]] = v;
        return [`${a[0]} set to ${v}`];
      },
    });

    this.register('kill', {
      desc: 'Kill entities', usage: '/kill [all|mobs]',
      exec: (a) => {
        const target = a[0] || 'self';
        if (target === 'self') { g().player.hurt(9999, 'command'); return ['Killed yourself']; }
        let n = 0;
        for (const e of [...g().entities]) {
          if (e === g().player) continue;
          if (target === 'mobs' && e.type !== 'mob') continue;
          e.hurt(9999, 'command'); n++;
        }
        return [`Killed ${n} entities`];
      },
    });

    this.register('summon', {
      desc: 'Summon an entity', usage: '/summon <mob> [x y z]',
      exec: (a) => {
        const name = a[0];
        if (!MOB_DEFS[name]) return ['Unknown mob: ' + name];
        const p = g().player;
        const x = a[1] !== undefined ? coord(a[1], p.pos[0]) : p.pos[0] + Math.sin(p.yaw) * 3;
        const y = a[2] !== undefined ? coord(a[2], p.pos[1]) : p.pos[1];
        const z = a[3] !== undefined ? coord(a[3], p.pos[2]) : p.pos[2] + Math.cos(p.yaw) * 3;
        const e = g().spawnMob(name, x, y, z);
        return e ? [`Summoned ${name}`] : ['Failed to summon'];
      },
    });

    this.register('setblock', {
      desc: 'Place a block', usage: '/setblock <x> <y> <z> <block>',
      exec: (a) => {
        const p = g().player;
        const x = Math.round(coord(a[0], p.pos[0])), y = Math.round(coord(a[1], p.pos[1])), z = Math.round(coord(a[2], p.pos[2]));
        const id = blockId(a[3]);
        if (!id) return ['Unknown block: ' + a[3]];
        g().world.setBlock(x, y, z, id, num(a[4], 0));
        return [`Placed ${a[3]} at ${x} ${y} ${z}`];
      },
    });

    this.register('fill', {
      desc: 'Fill a region', usage: '/fill <x1> <y1> <z1> <x2> <y2> <z2> <block>',
      exec: (a) => {
        if (a.length < 7) return ['Usage: /fill <x1> <y1> <z1> <x2> <y2> <z2> <block>'];
        const p = g().player;
        const x1 = Math.round(coord(a[0], p.pos[0])), y1 = Math.round(coord(a[1], p.pos[1])), z1 = Math.round(coord(a[2], p.pos[2]));
        const x2 = Math.round(coord(a[3], p.pos[0])), y2 = Math.round(coord(a[4], p.pos[1])), z2 = Math.round(coord(a[5], p.pos[2]));
        const id = blockId(a[6]);
        if (!id) return ['Unknown block: ' + a[6]];
        let n = 0;
        for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++)
          for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++)
            for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) { g().world.setBlock(x, y, z, id, 0); n++; }
        return [`Filled ${n} blocks`];
      },
    });

    this.register('effect', {
      desc: 'Apply a status effect', usage: '/effect <give|clear> <effect> [seconds] [level]',
      exec: (a) => {
        const sub = a[0];
        if (sub === 'clear') { g().player.effects.clear(); return ['Effects cleared']; }
        const name = a[1];
        if (!EFFECTS[name]) return ['Unknown effect: ' + name];
        const secs = num(a[2], 30), lvl = Math.max(0, num(a[3], 1) - 1);
        g().player.addEffect(name, secs * 20, lvl);
        return [`Gave ${EFFECTS[name].name} for ${secs}s`];
      },
    });

    this.register('xp', {
      desc: 'Give experience', usage: '/xp <amount> [levels]',
      exec: (a) => {
        const n = num(a[0], 0);
        if (a[1] === 'levels' || a[1] === 'l') { g().player.xpLevel += Math.round(n); return ['Added ' + Math.round(n) + ' levels']; }
        g().player.addXp(n);
        return ['Added ' + n + ' xp'];
      },
    });

    this.register('heal', {
      desc: 'Restore health and hunger', exec: () => {
        const p = g().player;
        p.health = p.maxHealth; p.hunger = 20; p.saturation = 5; p.air = p.maxAir; p.effects.clear();
        return ['Healed'];
      },
    });

    this.register('fly', {
      desc: 'Toggle creative flight', exec: () => {
        const p = g().player;
        p.canFly = !p.canFly;
        if (!p.canFly) p.flying = false;
        return ['Flight ' + (p.canFly ? 'enabled' : 'disabled')];
      },
    });

    this.register('seed', { desc: 'Show the world seed', exec: () => ['Seed: ' + g().world.seed] });

    this.register('clear', {
      desc: 'Clear your inventory', exec: () => { g().player.inventory.clear(); return ['Inventory cleared']; },
    });

    this.register('enchant', {
      desc: 'Enchant the held item', usage: '/enchant <enchantment> [level]',
      exec: (a) => {
        const held = g().player.inventory.getHeld();
        if (!held) return ['Hold an item first'];
        const lvl = Math.max(1, num(a[1], 1));
        if (!held.ench) held.ench = new Map();
        held.ench.set(a[0], lvl);
        g().player.inventory.changed();
        return [`Enchanted with ${a[0]} ${lvl}`];
      },
    });

    this.register('dimension', {
      desc: 'Travel to another dimension', usage: '/dimension <overworld|nether|end>',
      exec: (a) => {
        const d = a[0];
        if (!['overworld', 'nether', 'end'].includes(d)) return ['Usage: /dimension <overworld|nether|end>'];
        g().changeDimension(d);
        return ['Travelled to the ' + d];
      },
    });

    this.register('locate', {
      desc: 'Find a structure', usage: '/locate <village|stronghold|fortress|temple>',
      exec: (a) => {
        const r = g().locateStructure(a[0]);
        return r ? [`Found ${a[0]} at ${r[0]} ${r[1]} ${r[2]} (${Math.round(Math.hypot(r[0] - g().player.pos[0], r[2] - g().player.pos[2]))} blocks away)`]
          : [`Could not find ${a[0]} nearby`];
      },
    });

    this.register('list', {
      desc: 'List loaded entities', exec: () => {
        const counts = {};
        for (const e of g().entities) counts[e.type] = (counts[e.type] || 0) + 1;
        return ['Entities: ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')];
      },
    });

    this.register('day', { desc: 'Set time to day', exec: () => { g().setTime(1000); return ['Time set to day']; } });
    this.register('night', { desc: 'Set time to night', exec: () => { g().setTime(13000); return ['Time set to night']; } });
    this.register('killall', { desc: 'Remove all mobs', exec: (a) => this.commands.get('kill').exec(['mobs']) });
    this.register('save', { desc: 'Save the world now', exec: () => { g().save(); return ['World saved']; } });
    this.register('seedreload', { desc: 'Reload the texture pack', exec: () => { g().renderer.rebuildTextures(); return ['Textures rebuilt']; } });
  }

  /** Run a raw string (with or without the leading slash). */
  run(input) {
    const raw = String(input || '').trim();
    if (!raw) return { ok: false, messages: [] };
    const text = raw.startsWith('/') ? raw.slice(1) : raw;
    const parts = text.split(/\s+/);
    const name = parts[0].toLowerCase();
    const args = parts.slice(1);
    this.history.push(raw);
    if (this.history.length > 100) this.history.shift();
    this.historyIndex = this.history.length;
    const cmd = this.commands.get(name);
    if (!cmd) return { ok: false, messages: [`Unknown command: ${name}. Try /help`] };
    try {
      const messages = cmd.exec(args, { game: this.game, raw }) || [];
      return { ok: true, messages };
    } catch (e) {
      return { ok: false, messages: ['Error: ' + (e && e.message ? e.message : e)] };
    }
  }

  /** Tab completion for the chat input. */
  complete(text) {
    const t = text.startsWith('/') ? text.slice(1) : text;
    const parts = t.split(/\s+/);
    if (parts.length <= 1) {
      const p = (parts[0] || '').toLowerCase();
      return [...this.commands.keys()].filter((n) => n.startsWith(p)).map((n) => '/' + n);
    }
    const name = parts[0].toLowerCase();
    const last = parts[parts.length - 1].toLowerCase();
    let pool = [];
    if (name === 'give') pool = ITEMS.map((i) => i.name);
    else if (name === 'setblock' || name === 'fill') pool = BLOCKS.map((b) => b.name);
    else if (name === 'summon') pool = Object.keys(MOB_DEFS);
    else if (name === 'effect' && parts.length <= 2) pool = ['give', 'clear'];
    else if (name === 'effect' && parts.length === 3) pool = Object.keys(EFFECTS);
    else if (name === 'gamemode') pool = Object.values(GAMEMODE);
    else if (name === 'weather') pool = ['clear', 'rain', 'thunder'];
    else if (name === 'difficulty') pool = ['peaceful', 'easy', 'normal', 'hard'];
    else if (name === 'gamerule' && parts.length === 2) pool = Object.keys(this.game.gamerules);
    else if (name === 'dimension') pool = ['overworld', 'nether', 'end'];
    const head = parts.slice(0, -1).join(' ');
    return pool.filter((n) => n.startsWith(last)).slice(0, 40).map((n) => '/' + head + ' ' + n);
  }

  historyUp() { if (!this.history.length) return ''; this.historyIndex = Math.max(0, this.historyIndex - 1); return this.history[this.historyIndex] || ''; }
  historyDown() { if (!this.history.length) return ''; this.historyIndex = Math.min(this.history.length, this.historyIndex + 1); return this.history[this.historyIndex] || ''; }
}

export default CommandSystem;
