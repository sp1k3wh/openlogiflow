/**
 * Inyección de entrada en Linux con /dev/uinput (funciona en X11 y Wayland).
 *
 * Crea dos dispositivos virtuales:
 *  - "Logi Flow OSS virtual"         mouse relativo + teclado (lo que llega del otro equipo)
 *  - "Logi Flow OSS virtual pointer" puntero absoluto, solo para colocar el cursor en el
 *                                    borde por donde entra (Wayland no deja mover el cursor).
 *
 * Requiere acceso a /dev/uinput (Ubuntu lo da con la regla de Solaar o TAG+="uaccess").
 */
const fs = require('fs');
const { BTN } = require('./protocol');

const EV_SYN = 0, EV_KEY = 1, EV_REL = 2, EV_ABS = 3;
const REL_X = 0, REL_Y = 1, REL_HWHEEL = 6, REL_WHEEL = 8, REL_WHEEL_HI_RES = 11, REL_HWHEEL_HI_RES = 12;
const ABS_X = 0, ABS_Y = 1;
const BTN_CODES = { [BTN.LEFT]: 0x110, [BTN.RIGHT]: 0x111, [BTN.MIDDLE]: 0x112, [BTN.BACK]: 0x113, [BTN.FORWARD]: 0x114 };
const ABS_MAX = 65535;

const UI_SET_EVBIT = 0x40045564, UI_SET_KEYBIT = 0x40045565, UI_SET_RELBIT = 0x40045566, UI_SET_ABSBIT = 0x40045567;
const UI_DEV_SETUP = 0x405c5503, UI_ABS_SETUP = 0x401c5504, UI_DEV_CREATE = 0x5501, UI_DEV_DESTROY = 0x5502;
const BUS_VIRTUAL = 0x06;

let ioctl = null;
function getIoctl() {
  if (!ioctl) {
    const koffi = require('koffi');
    ioctl = koffi.load('libc.so.6').func('int ioctl(int fd, unsigned long req, ...)');
  }
  return ioctl;
}

function setupStruct(name, product) {
  const b = Buffer.alloc(92);
  b.writeUInt16LE(BUS_VIRTUAL, 0);
  b.writeUInt16LE(0x1d6b, 2);   // vendor (genérico)
  b.writeUInt16LE(product, 4);
  b.writeUInt16LE(1, 6);
  b.write(name, 8, 79, 'utf8');
  return b;
}

function openDevice(name, product, configure) {
  const io = getIoctl();
  const fd = fs.openSync('/dev/uinput', fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  const set = (req, v) => {
    if (io(fd, req, 'int', v) < 0) throw new Error(`ioctl 0x${req.toString(16)} falló`);
  };
  configure(set, io, fd);
  if (io(fd, UI_DEV_SETUP, 'uint8_t *', setupStruct(name, product)) < 0) throw new Error('UI_DEV_SETUP falló');
  if (io(fd, UI_DEV_CREATE) < 0) throw new Error('UI_DEV_CREATE falló');
  return fd;
}

class LinuxInject {
  constructor({ log = console.log, screen = () => ({ x: 0, y: 0, w: 1920, h: 1080 }) } = {}) {
    this.log = log;
    this.screen = screen; // función: área total del escritorio en píxeles
    this.pressedKeys = new Set();
    this.pressedButtons = new Set();
    this.wheelRest = { v: 0, h: 0 };

    this.relFd = openDevice('Logi Flow OSS virtual', 0x0f10, (set) => {
      set(UI_SET_EVBIT, EV_KEY);
      set(UI_SET_EVBIT, EV_REL);
      for (let k = 1; k < 256; k++) set(UI_SET_KEYBIT, k);
      for (const c of Object.values(BTN_CODES)) set(UI_SET_KEYBIT, c);
      for (const r of [REL_X, REL_Y, REL_WHEEL, REL_HWHEEL, REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES]) set(UI_SET_RELBIT, r);
    });

    this.absFd = openDevice('Logi Flow OSS virtual pointer', 0x0f11, (set, io, fd) => {
      set(UI_SET_EVBIT, EV_KEY);
      set(UI_SET_EVBIT, EV_ABS);
      set(UI_SET_KEYBIT, BTN_CODES[BTN.LEFT]); // libinput lo trata como puntero absoluto
      for (const axis of [ABS_X, ABS_Y]) {
        set(UI_SET_ABSBIT, axis);
        const a = Buffer.alloc(28);
        a.writeUInt16LE(axis, 0);
        a.writeInt32LE(0, 4);        // value
        a.writeInt32LE(0, 8);        // minimum
        a.writeInt32LE(ABS_MAX, 12); // maximum
        if (io(fd, UI_ABS_SETUP, 'uint8_t *', a) < 0) throw new Error('UI_ABS_SETUP falló');
      }
    });
    this.log('[LinuxInject] Dispositivos virtuales creados');
  }

  _emit(fd, events) {
    const buf = Buffer.alloc(24 * (events.length + 1));
    events.forEach(([type, code, value], i) => {
      buf.writeUInt16LE(type, i * 24 + 16);
      buf.writeUInt16LE(code, i * 24 + 18);
      buf.writeInt32LE(value, i * 24 + 20);
    });
    // SYN_REPORT final ya está en ceros
    try { fs.writeSync(fd, buf); } catch (e) { this.log(`[LinuxInject] write: ${e.message}`); }
  }

  /** Coloca el cursor en píxeles absolutos del escritorio */
  warp(x, y) {
    const s = this.screen();
    const ax = Math.round(((x - s.x) / Math.max(s.w - 1, 1)) * ABS_MAX);
    const ay = Math.round(((y - s.y) / Math.max(s.h - 1, 1)) * ABS_MAX);
    this._emit(this.absFd, [[EV_ABS, ABS_X, clamp(ax)], [EV_ABS, ABS_Y, clamp(ay)]]);
  }

  move(dx, dy) {
    const ev = [];
    if (dx) ev.push([EV_REL, REL_X, dx]);
    if (dy) ev.push([EV_REL, REL_Y, dy]);
    if (ev.length) this._emit(this.relFd, ev);
  }

  button(btn, down) {
    if (down === this.pressedButtons.has(btn)) return; // llega duplicado a propósito
    if (down) this.pressedButtons.add(btn); else this.pressedButtons.delete(btn);
    const code = BTN_CODES[btn];
    if (code) this._emit(this.relFd, [[EV_KEY, code, down ? 1 : 0]]);
  }

  wheel(v, h) {
    const ev = [];
    for (const [axis, hi, lo] of [['v', REL_WHEEL_HI_RES, REL_WHEEL], ['h', REL_HWHEEL_HI_RES, REL_HWHEEL]]) {
      const val = axis === 'v' ? v : h;
      if (!val) continue;
      ev.push([EV_REL, hi, val]);
      this.wheelRest[axis] += val;
      const notches = Math.trunc(this.wheelRest[axis] / 120);
      if (notches) { ev.push([EV_REL, lo, notches]); this.wheelRest[axis] -= notches * 120; }
    }
    if (ev.length) this._emit(this.relFd, ev);
  }

  key(code, down) {
    if (code <= 0 || code > 255) return;
    if (!down && !this.pressedKeys.has(code)) return;
    const repeat = down && this.pressedKeys.has(code);
    if (down) this.pressedKeys.add(code); else this.pressedKeys.delete(code);
    this._emit(this.relFd, [[EV_KEY, code, repeat ? 2 : down ? 1 : 0]]);
  }

  releaseAll() {
    for (const c of [...this.pressedKeys]) this.key(c, false);
    for (const b of [...this.pressedButtons]) this.button(b, false);
  }

  close() {
    this.releaseAll();
    const io = getIoctl();
    for (const fd of [this.relFd, this.absFd]) {
      try { io(fd, UI_DEV_DESTROY); fs.closeSync(fd); } catch {}
    }
  }
}

function clamp(v) { return Math.max(0, Math.min(ABS_MAX, v)); }

module.exports = { LinuxInject };
