/**
 * Ultracraft - input.
 *
 * One state object drives keyboard + mouse (pointer lock), touch
 * (virtual stick, tap-to-break, drag-to-look) and gamepads. Discrete actions
 * are delivered through callbacks so the game never has to poll edge events.
 */

const DEFAULT_BINDS = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'sneak', ShiftRight: 'sneak',
  ControlLeft: 'sprint', ControlRight: 'sprint',
  KeyE: 'inventory',
  KeyQ: 'drop',
  KeyF: 'swapHands',
  KeyR: 'pickBlock',
  KeyT: 'chat', Slash: 'chatCmd',
  Escape: 'menu',
  F3: 'debug',
  F5: 'togglePerspective',
  F1: 'hideHud',
  KeyZ: 'zoom',
};

export class Input {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.game = opts.game || null;
    this.state = {
      forward: 0, back: 0, left: 0, right: 0,
      jump: false, sneak: false, sprint: false,
      attack: false, use: false, drop: false,
      zoom: false, flyUp: false, flyDown: false,
    };
    this.pressed = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.locked = false;
    this.enabled = true;
    this.sensitivity = 0.0022;
    this.invertY = false;
    this.touch = { active: false, lookId: -1, stickId: -1, x: 0, y: 0, lx: 0, ly: 0, tapTime: 0, moved: 0 };
    this.gamepadIndex = -1;
    this.onAction = opts.onAction || (() => {});
    this.onScroll = opts.onScroll || (() => {});
    this.binds = Object.assign({}, DEFAULT_BINDS, opts.binds || {});
    this.attach();
  }

  attach() {
    const c = this.canvas;
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => this.releaseAll());
    c.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    c.addEventListener('wheel', (e) => { if (this.locked) { e.preventDefault(); this.wheel += Math.sign(e.deltaY); this.onScroll(Math.sign(e.deltaY)); } }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === c;
      if (this.onAction) this.onAction('pointerlock', this.locked);
    });
    // touch
    c.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    c.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    c.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
    c.addEventListener('touchcancel', (e) => this.onTouchEnd(e), { passive: false });
    window.addEventListener('gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.gamepadIndex = -1; });
  }

  requestLock() {
    if (document.pointerLockElement !== this.canvas) {
      const p = this.canvas.requestPointerLock?.();
      if (p && p.catch) p.catch(() => {});
    }
  }
  exitLock() { if (document.pointerLockElement === this.canvas) document.exitPointerLock(); }

  releaseAll() {
    this.state.jump = this.state.sneak = this.state.sprint = false;
    this.state.attack = this.state.use = false;
    this.state.forward = this.state.back = this.state.left = this.state.right = 0;
    this.pressed.clear();
  }

  onKeyDown(e) {
    if (e.repeat) return;
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    const action = this.binds[e.code];
    if (action) {
      if (action === 'menu' || action === 'debug' || action === 'inventory') e.preventDefault();
      this.onAction(action, true, e);
    }
    if (/^Digit[1-9]$/.test(e.code)) this.onAction('hotbar', parseInt(e.code.slice(5), 10) - 1, e);
    this.pressed.add(e.code);
    if (action === 'forward') this.state.forward = 1;
    if (action === 'back') this.state.back = 1;
    if (action === 'left') this.state.left = 1;
    if (action === 'right') this.state.right = 1;
    if (action === 'jump') this.state.jump = true;
    if (action === 'sneak') this.state.sneak = true;
    if (action === 'sprint') this.state.sprint = true;
    if (action === 'zoom') this.state.zoom = true;
  }

  onKeyUp(e) {
    const action = this.binds[e.code];
    this.pressed.delete(e.code);
    if (action === 'forward') this.state.forward = 0;
    if (action === 'back') this.state.back = 0;
    if (action === 'left') this.state.left = 0;
    if (action === 'right') this.state.right = 0;
    if (action === 'jump') this.state.jump = false;
    if (action === 'sneak') this.state.sneak = false;
    if (action === 'sprint') this.state.sprint = false;
    if (action === 'zoom') this.state.zoom = false;
    if (action) this.onAction(action, false, e);
  }

  onMouseDown(e) {
    if (!this.locked) { this.requestLock(); return; }
    if (e.button === 0) { this.state.attack = true; this.onAction('attack', true, e); }
    if (e.button === 2) { this.state.use = true; this.onAction('use', true, e); }
    if (e.button === 1) this.onAction('pickBlock', true, e);
  }

  onMouseUp(e) {
    if (e.button === 0) { this.state.attack = false; this.onAction('attack', false, e); }
    if (e.button === 2) { this.state.use = false; this.onAction('use', false, e); }
  }

  onMouseMove(e) {
    if (!this.locked) return;
    this.mouseDX += e.movementX || 0;
    this.mouseDY += e.movementY || 0;
  }

  // -------------------------------------------------------------------------
  // touch controls: left half = virtual stick, right half = look + tap actions
  // -------------------------------------------------------------------------
  onTouchStart(e) {
    const r = this.canvas.getBoundingClientRect();
    for (const t of e.changedTouches) {
      const x = (t.clientX - r.left) / r.width;
      const y = (t.clientY - r.top) / r.height;
      if (x < 0.45) {
        this.touch.stickId = t.identifier;
        this.touch.x = x; this.touch.y = y;
        this.touch.active = true;
      } else {
        this.touch.lookId = t.identifier;
        this.touch.lx = t.clientX; this.touch.ly = t.clientY;
        this.touch.tapTime = performance.now();
        this.touch.moved = 0;
      }
    }
    e.preventDefault();
  }

  onTouchMove(e) {
    const r = this.canvas.getBoundingClientRect();
    for (const t of e.changedTouches) {
      if (t.identifier === this.touch.stickId) {
        const x = (t.clientX - r.left) / r.width;
        const y = (t.clientY - r.top) / r.height;
        const dx = x - this.touch.x, dy = y - this.touch.y;
        this.state.forward = Math.max(0, Math.min(1, -dy * 4));
        this.state.back = Math.max(0, Math.min(1, dy * 4));
        this.state.left = Math.max(0, Math.min(1, -dx * 4));
        this.state.right = Math.max(0, Math.min(1, dx * 4));
      } else if (t.identifier === this.touch.lookId) {
        const dx = t.clientX - this.touch.lx, dy = t.clientY - this.touch.ly;
        this.touch.lx = t.clientX; this.touch.ly = t.clientY;
        this.touch.moved += Math.abs(dx) + Math.abs(dy);
        this.mouseDX += dx * 1.4;
        this.mouseDY += dy * 1.4;
      }
    }
    e.preventDefault();
  }

  onTouchEnd(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === this.touch.stickId) {
        this.touch.stickId = -1;
        this.state.forward = this.state.back = this.state.left = this.state.right = 0;
      } else if (t.identifier === this.touch.lookId) {
        this.touch.lookId = -1;
        if (this.touch.moved < 22 && performance.now() - this.touch.tapTime < 350) {
          // a tap = attack (break), a long press = place
          this.onAction(this.touch.moved < 10 ? 'attackTap' : 'useTap', true, t);
        }
      }
    }
    e.preventDefault();
  }

  // -------------------------------------------------------------------------
  pollGamepad() {
    if (this.gamepadIndex < 0 || !navigator.getGamepads) return;
    const gp = navigator.getGamepads()[this.gamepadIndex];
    if (!gp) return;
    const dz = (v) => (Math.abs(v) > 0.18 ? v : 0);
    const [lx, ly] = [dz(gp.axes[0] || 0), dz(gp.axes[1] || 0)];
    this.state.right = Math.max(0, lx); this.state.left = Math.max(0, -lx);
    this.state.back = Math.max(0, ly); this.state.forward = Math.max(0, -ly);
    this.mouseDX += dz(gp.axes[2] || 0) * 14;
    this.mouseDY += dz(gp.axes[3] || 0) * 14;
    this.state.jump = !!(gp.buttons[0] && gp.buttons[0].pressed);
    this.state.sneak = !!(gp.buttons[1] && gp.buttons[1].pressed);
    this.state.sprint = !!(gp.buttons[10] && gp.buttons[10].pressed);
    const rt = gp.buttons[7] ? gp.buttons[7].value : 0;
    const lt = gp.buttons[6] ? gp.buttons[6].value : 0;
    if (rt > 0.4 && !this.state.attack) { this.state.attack = true; this.onAction('attack', true); }
    if (rt < 0.3 && this.state.attack) { this.state.attack = false; this.onAction('attack', false); }
    if (lt > 0.4 && !this.state.use) { this.state.use = true; this.onAction('use', true); }
    if (lt < 0.3 && this.state.use) { this.state.use = false; this.onAction('use', false); }
  }

  /** Consume the accumulated look delta and the scroll wheel. */
  consume() {
    this.pollGamepad();
    const d = [this.mouseDX * this.sensitivity, this.mouseDY * this.sensitivity * (this.invertY ? -1 : 1)];
    this.mouseDX = 0; this.mouseDY = 0;
    return d;
  }

  consumeWheel() { const w = this.wheel; this.wheel = 0; return w; }

  setSensitivity(s) { this.sensitivity = s; }
  setEnabled(on) { this.enabled = on; if (!on) this.releaseAll(); }
}

export default Input;
