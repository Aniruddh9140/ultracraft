/**
 * Ultracraft - procedural audio.
 *
 * Zero sound files: every effect is synthesised with the WebAudio graph at
 * runtime, which keeps the download tiny and lets the pitch/timbre of a sound
 * vary per block material. A tiny drone-based music generator provides calm
 * ambient pads that react to the time of day and the dimension.
 */

const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.enabled = true;
    this.volume = 0.7;
    this.musicVolume = 0.35;
    this.listener = [0, 0, 0];
    this.listenerYaw = 0;
    this.noiseBuffer = null;
    this.lastPlay = new Map();
    this.musicTimer = 0;
    this.musicOn = false;
    this.scale = [0, 2, 3, 5, 7, 8, 10, 12];
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 1;
      this.sfxGain.connect(this.master);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = this.musicVolume;
      this.musicGain.connect(this.master);
      // shared noise buffer
      const len = this.ctx.sampleRate * 2;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buf;
    } catch (e) {
      this.enabled = false;
    }
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }
  setMusicVolume(v) { this.musicVolume = v; if (this.musicGain) this.musicGain.gain.value = v; }

  setListener(pos, yaw) { this.listener = pos; this.listenerYaw = yaw; }

  /** distance attenuation + stereo pan for a world position */
  spatial(x, y, z, maxDist = 24) {
    if (!this.ctx) return { gain: 0, pan: 0, dist: 999 };
    const dx = x - this.listener[0], dy = y - this.listener[1], dz = z - this.listener[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > maxDist) return { gain: 0, pan: 0, dist };
    const gain = Math.max(0, 1 - dist / maxDist) ** 1.6;
    // pan: project onto the camera right vector
    const rx = Math.cos(this.listenerYaw), rz = -Math.sin(this.listenerYaw);
    const pan = Math.max(-1, Math.min(1, (dx * rx + dz * rz) / Math.max(1, dist)));
    return { gain, pan, dist };
  }

  tone(freq, dur, type = 'sine', gain = 0.2, opts = {}) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (opts.slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * opts.slide), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(0.01, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = g;
    if (opts.filter) {
      const f = this.ctx.createBiquadFilter();
      f.type = opts.filter;
      f.frequency.value = opts.cutoff || 900;
      g.connect(f); node = f;
    }
    o.connect(g);
    node.connect(this.sfxGain);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  noise(dur, gain = 0.2, opts = {}) {
    if (!this.ctx || !this.enabled || !this.noiseBuffer) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuffer;
    s.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = opts.type || 'bandpass';
    f.frequency.value = opts.freq || 800;
    f.Q.value = opts.q === undefined ? 1 : opts.q;
    if (opts.slide) f.frequency.exponentialRampToValueAtTime(Math.max(40, (opts.freq || 800) * opts.slide), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.sfxGain);
    s.start(t);
    s.stop(t + dur + 0.02);
  }

  /** Play a named sound, optionally spatialised at a world position. */
  play(name, x, y, z, opts = {}) {
    if (!this.enabled) return;
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    this.resume();
    let gain = (opts.gain === undefined ? 1 : opts.gain);
    if (x !== undefined) {
      const s = this.spatial(x, y, z, opts.maxDist || 24);
      if (s.gain <= 0.001) return;
      gain *= s.gain;
    }
    if (gain < 0.004) return;
    // rate limit identical sounds in the same frame
    const now = this.ctx.currentTime;
    const key = name + (opts.pitch || '');
    if (!opts.allowSpam && now - (this.lastPlay.get(key) || 0) < 0.02) return;
    this.lastPlay.set(key, now);
    const p = opts.pitch || 1;
    switch (name) {
      case 'step_grass': this.noise(0.09, 0.16 * gain, { freq: 620 * p, type: 'bandpass', q: 0.7, slide: 0.6 }); break;
      case 'step_stone': this.noise(0.07, 0.14 * gain, { freq: 1100 * p, type: 'bandpass', q: 1.4, slide: 0.7 }); break;
      case 'step_wood': this.noise(0.08, 0.16 * gain, { freq: 420 * p, type: 'bandpass', q: 1.1, slide: 0.6 }); break;
      case 'step_sand': this.noise(0.12, 0.14 * gain, { freq: 380 * p, type: 'lowpass', slide: 0.5 }); break;
      case 'step_snow': this.noise(0.10, 0.12 * gain, { freq: 1500 * p, type: 'highpass', slide: 0.7 }); break;
      case 'step_water': this.noise(0.14, 0.16 * gain, { freq: 700 * p, type: 'lowpass', slide: 0.4 }); break;
      case 'step_wool': this.noise(0.09, 0.10 * gain, { freq: 300 * p, type: 'lowpass', slide: 0.6 }); break;
      case 'dig_stone': this.noise(0.07, 0.10 * gain, { freq: 900 * p, type: 'bandpass', q: 2, slide: 0.8 }); break;
      case 'dig_wood': this.noise(0.08, 0.11 * gain, { freq: 500 * p, type: 'bandpass', q: 1.5 }); break;
      case 'dig_grass': this.noise(0.09, 0.11 * gain, { freq: 640 * p, type: 'bandpass', q: 0.8 }); break;
      case 'dig_sand': this.noise(0.12, 0.10 * gain, { freq: 400 * p, type: 'lowpass' }); break;
      case 'dig_glass': this.tone(2400 * p, 0.09, 'triangle', 0.07 * gain); this.noise(0.05, 0.06 * gain, { freq: 3000, type: 'highpass' }); break;
      case 'break_stone': this.noise(0.22, 0.22 * gain, { freq: 700 * p, type: 'bandpass', q: 0.8, slide: 0.4 }); break;
      case 'break_wood': this.noise(0.24, 0.22 * gain, { freq: 380 * p, type: 'lowpass', slide: 0.5 }); break;
      case 'break_glass': for (let i = 0; i < 4; i++) this.tone((1800 + Math.random() * 2200) * p, 0.12, 'triangle', 0.06 * gain); break;
      case 'break_grass': this.noise(0.18, 0.16 * gain, { freq: 520 * p, type: 'bandpass', q: 0.6 }); break;
      case 'place': this.noise(0.06, 0.14 * gain, { freq: 700 * p, type: 'bandpass', q: 1.2 }); this.tone(180 * p, 0.06, 'sine', 0.06 * gain); break;
      case 'hit': this.noise(0.07, 0.14 * gain, { freq: 900, type: 'bandpass', q: 0.7, slide: 0.5 }); break;
      case 'hurt': this.tone(320, 0.16, 'sawtooth', 0.10 * gain, { slide: 0.6 }); this.noise(0.10, 0.08 * gain, { freq: 500, type: 'lowpass' }); break;
      case 'die': this.tone(260, 0.4, 'sawtooth', 0.10 * gain, { slide: 0.35 }); break;
      case 'splash': this.noise(0.4, 0.16 * gain, { freq: 900, type: 'lowpass', slide: 0.3 }); break;
      case 'swim': this.noise(0.2, 0.10 * gain, { freq: 600, type: 'lowpass', slide: 0.6 }); break;
      case 'fizz': this.noise(0.6, 0.12 * gain, { freq: 1600, type: 'highpass', slide: 0.5 }); break;
      case 'door_open': this.noise(0.25, 0.12 * gain, { freq: 300, type: 'lowpass', slide: 1.4 }); break;
      case 'door_close': this.noise(0.22, 0.12 * gain, { freq: 500, type: 'lowpass', slide: 0.5 }); this.tone(120, 0.1, 'sine', 0.07 * gain); break;
      case 'chest_open': this.noise(0.3, 0.12 * gain, { freq: 400, type: 'lowpass', slide: 1.5 }); this.tone(200, 0.2, 'sine', 0.05 * gain, { slide: 1.4 }); break;
      case 'chest_close': this.noise(0.2, 0.12 * gain, { freq: 600, type: 'lowpass', slide: 0.4 }); break;
      case 'click': this.tone(1200 * p, 0.04, 'square', 0.06 * gain); break;
      case 'pop': this.tone(600 * p, 0.09, 'sine', 0.09 * gain, { slide: 1.8 }); break;
      case 'xp': this.tone(900 * p, 0.1, 'triangle', 0.06 * gain, { slide: 1.7 }); break;
      case 'level_up': [0, 4, 7, 12].forEach((n, i) => setTimeout(() => this.tone(NOTE(72 + n), 0.3, 'triangle', 0.09 * gain), i * 90)); break;
      case 'bow': this.noise(0.14, 0.14 * gain, { freq: 1800, type: 'highpass', slide: 0.4 }); break;
      case 'arrow_hit': this.tone(220, 0.09, 'square', 0.08 * gain, { slide: 0.5 }); this.noise(0.06, 0.07 * gain, { freq: 1400, type: 'bandpass' }); break;
      case 'explode': this.noise(1.2, 0.4 * gain, { freq: 220, type: 'lowpass', slide: 0.2 }); this.tone(60, 0.8, 'sine', 0.25 * gain, { slide: 0.4 }); break;
      case 'fuse': this.noise(0.5, 0.10 * gain, { freq: 3000, type: 'highpass' }); break;
      case 'portal': this.noise(1.0, 0.12 * gain, { freq: 300, type: 'bandpass', q: 3, slide: 3 }); break;
      case 'teleport': [0, 7, 12].forEach((n, i) => setTimeout(() => this.tone(NOTE(60 + n), 0.4, 'sine', 0.08 * gain), i * 60)); break;
      case 'eat': this.noise(0.12, 0.10 * gain, { freq: 400, type: 'lowpass' }); this.noise(0.1, 0.08 * gain, { freq: 700, type: 'bandpass' }); break;
      case 'burp': this.tone(180, 0.3, 'sawtooth', 0.08 * gain, { slide: 0.6 }); break;
      case 'drink': this.noise(0.18, 0.09 * gain, { freq: 500, type: 'bandpass', q: 2, slide: 1.6 }); break;
      case 'anvil_land': this.tone(140, 0.5, 'triangle', 0.16 * gain, { slide: 0.5 }); this.noise(0.3, 0.12 * gain, { freq: 1200, type: 'bandpass' }); break;
      case 'piston_out': this.noise(0.16, 0.14 * gain, { freq: 500, type: 'lowpass', slide: 1.6 }); this.tone(90, 0.14, 'square', 0.05 * gain); break;
      case 'piston_in': this.noise(0.14, 0.12 * gain, { freq: 800, type: 'lowpass', slide: 0.5 }); break;
      case 'note': this.tone(NOTE(48 + (opts.note || 0)), 0.5, opts.instrument === 'bass' ? 'sawtooth' : 'triangle', 0.10 * gain); break;
      case 'fire': this.noise(0.3, 0.07 * gain, { freq: 900, type: 'bandpass', q: 0.6, slide: 0.7 }); break;
      case 'thunder': this.noise(2.2, 0.35 * gain, { freq: 160, type: 'lowpass', slide: 0.3 }); break;
      case 'rain': this.noise(0.5, 0.05 * gain, { freq: 2400, type: 'highpass' }); break;
      case 'mob_pig': this.tone(320 * p, 0.22, 'sawtooth', 0.09 * gain, { slide: 0.8 }); break;
      case 'mob_cow': this.tone(200 * p, 0.5, 'sawtooth', 0.10 * gain, { slide: 0.9 }); break;
      case 'mob_sheep': this.tone(420 * p, 0.4, 'square', 0.07 * gain, { slide: 0.85 }); break;
      case 'mob_chicken': this.tone(900 * p, 0.09, 'triangle', 0.07 * gain, { slide: 1.3 }); this.tone(700 * p, 0.09, 'triangle', 0.05 * gain, { slide: 0.8 }); break;
      case 'mob_zombie': this.tone(120 * p, 0.5, 'sawtooth', 0.09 * gain, { slide: 0.7 }); break;
      case 'mob_skeleton': for (let i = 0; i < 3; i++) this.noise(0.07, 0.08 * gain, { freq: 1800, type: 'bandpass', q: 3 }); break;
      case 'mob_creeper_fuse': this.noise(0.9, 0.12 * gain, { freq: 2600, type: 'highpass', slide: 1.6 }); break;
      case 'mob_spider': this.noise(0.16, 0.09 * gain, { freq: 2400, type: 'bandpass', q: 4, slide: 0.7 }); break;
      case 'mob_ghast': this.tone(700 * p, 0.8, 'sine', 0.09 * gain, { slide: 0.45 }); break;
      case 'mob_blaze': this.noise(0.4, 0.10 * gain, { freq: 1200, type: 'bandpass', q: 1.5, slide: 1.4 }); break;
      case 'mob_enderman': this.tone(90, 0.9, 'sawtooth', 0.10 * gain, { slide: 1.3 }); break;
      case 'mob_villager': this.tone(300 * p, 0.2, 'square', 0.06 * gain, { slide: 1.2 }); break;
      case 'mob_wolf_growl': this.tone(140, 0.45, 'sawtooth', 0.10 * gain, { slide: 0.8 }); break;
      case 'mob_cat': this.tone(520 * p, 0.4, 'triangle', 0.07 * gain, { slide: 1.2 }); break;
      case 'mob_dragon': this.tone(70, 1.4, 'sawtooth', 0.16 * gain, { slide: 1.5 }); this.noise(1.2, 0.14 * gain, { freq: 300, type: 'lowpass' }); break;
      default: break;
    }
  }

  /** Ambient pad: two detuned oscillators through a slow filter sweep. */
  updateMusic(dt, mood = 'day') {
    if (!this.enabled || !this.musicOn || !this.ctx) return;
    this.musicTimer -= dt;
    if (this.musicTimer > 0) return;
    this.musicTimer = 4 + Math.random() * 6;
    const roots = { day: 57, night: 53, nether: 51, end: 49 };
    const root = roots[mood] || 57;
    const deg = this.scale[(Math.random() * this.scale.length) | 0];
    const f = NOTE(root + deg);
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.10, t + 2);
    g.gain.linearRampToValueAtTime(0.0001, t + 7);
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 700;
    filt.Q.value = 0.8;
    for (const mul of [1, 1.5, 2]) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mul;
      o.detune.value = (Math.random() - 0.5) * 12;
      o.connect(g);
      o.start(t);
      o.stop(t + 7.2);
    }
    g.connect(filt);
    filt.connect(this.musicGain);
  }

  setMusic(on) { this.musicOn = on; }
  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? this.volume : 0;
  }
}

export default AudioEngine;
