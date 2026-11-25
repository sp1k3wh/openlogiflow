/**
 * Inyección de entrada en Windows con user32!SendInput (vía koffi, sin compilar).
 * Debe correr en la sesión interactiva del usuario (no desde un servicio ni SSH).
 *
 * Limitación de Windows: no puede escribir en ventanas que corren como
 * administrador (p. ej. el Administrador de tareas) si esta app no lo es.
 */
const koffi = require('koffi');
const { BTN } = require('./protocol');

const user32 = koffi.load('user32.dll');

const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
const INPUT_UNION = koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });

const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)');
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *pt)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)');
const SetProcessDPIAware = user32.func('bool __stdcall SetProcessDPIAware()');

const INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
const MF = { MOVE: 0x1, LDOWN: 0x2, LUP: 0x4, RDOWN: 0x8, RUP: 0x10, MDOWN: 0x20, MUP: 0x40, XDOWN: 0x80, XUP: 0x100, WHEEL: 0x800, HWHEEL: 0x1000 };
const KF = { EXTENDED: 0x1, KEYUP: 0x2, SCANCODE: 0x8 };
const SIZE = koffi.sizeof(INPUT);

const { evdevToScan } = require('./keymap');

class WinInject {
  constructor({ log = console.log } = {}) {
    this.log = log;
    try { SetProcessDPIAware(); } catch {}
    this.pressedKeys = new Set();
    this.pressedButtons = new Set();
  }

  screen() {
    return {
      x: GetSystemMetrics(76), y: GetSystemMetrics(77),   // SM_X/YVIRTUALSCREEN
      w: GetSystemMetrics(78), h: GetSystemMetrics(79),   // SM_CX/CYVIRTUALSCREEN
    };
  }

  cursor() {
    const pt = {};
    GetCursorPos(pt);
    return pt;
  }

  warp(x, y) { SetCursorPos(Math.round(x), Math.round(y)); }

  _mouse(dwFlags, dx = 0, dy = 0, mouseData = 0) {
    const sent = SendInput(1, { type: INPUT_MOUSE, u: { mi: { dx, dy, mouseData, dwFlags, time: 0, dwExtraInfo: 0 } } }, SIZE);
    if (sent !== 1 && !this.warned) {
      this.warned = true;
      this.log('[WinInject] SendInput falló: ¿la app corre fuera de la sesión del escritorio?');
    }
  }

  move(dx, dy) { this._mouse(MF.MOVE, dx, dy); }

  button(btn, down) {
    // Idempotente: los botones llegan repetidos por si se pierde un paquete UDP
    if (down === this.pressedButtons.has(btn)) return;
    if (down) this.pressedButtons.add(btn); else this.pressedButtons.delete(btn);
    switch (btn) {
      case BTN.LEFT: return this._mouse(down ? MF.LDOWN : MF.LUP);
      case BTN.RIGHT: return this._mouse(down ? MF.RDOWN : MF.RUP);
      case BTN.MIDDLE: return this._mouse(down ? MF.MDOWN : MF.MUP);
      case BTN.BACK: return this._mouse(down ? MF.XDOWN : MF.XUP, 0, 0, 1);
      case BTN.FORWARD: return this._mouse(down ? MF.XDOWN : MF.XUP, 0, 0, 2);
    }
  }

  wheel(v, h) {
    if (v) this._mouse(MF.WHEEL, 0, 0, v >>> 0);
    if (h) this._mouse(MF.HWHEEL, 0, 0, h >>> 0);
  }

  key(code, down) {
    const sc = evdevToScan(code);
    if (!sc) return;
    // "Soltar" llega duplicado: ignorar si ya está suelta. "Presionar" repetido = autorepetición.
    if (!down && !this.pressedKeys.has(code)) return;
    if (down) this.pressedKeys.add(code); else this.pressedKeys.delete(code);
    const [scan, ext] = sc;
    const dwFlags = KF.SCANCODE | (ext ? KF.EXTENDED : 0) | (down ? 0 : KF.KEYUP);
    SendInput(1, { type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: scan, dwFlags, time: 0, dwExtraInfo: 0 } } }, SIZE);
  }

  /** Suelta todo lo que haya quedado presionado (al salir o si se corta la red) */
  releaseAll() {
    for (const code of [...this.pressedKeys]) this.key(code, false);
    for (const btn of [...this.pressedButtons]) this.button(btn, false);
  }
}

module.exports = { WinInject, evdevToScan };
