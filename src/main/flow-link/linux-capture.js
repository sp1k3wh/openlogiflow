/**
 * Captura de entrada en Linux vía evdev (/dev/input/event*).
 * Funciona igual en X11 y Wayland porque lee del kernel, no del servidor gráfico.
 *
 * - Siempre escucha (sin agarrar) para no gastar nada mientras el control es local.
 * - grab(true): EVIOCGRAB — el escritorio deja de recibir los eventos y los
 *   reenviamos al otro equipo. Si el proceso muere, el kernel suelta el grab solo.
 *
 * Requiere permiso de lectura en /dev/input/event* (ver docs/PROTOCOL.md → Permisos).
 */
const fs = require('fs');
const { EventEmitter } = require('events');
const { BTN } = require('./protocol');

const EV_SYN = 0, EV_KEY = 1, EV_REL = 2;
const REL_X = 0, REL_Y = 1, REL_HWHEEL = 6, REL_WHEEL = 8, REL_WHEEL_HI_RES = 11, REL_HWHEEL_HI_RES = 12;
const EVIOCGRAB = 0x40044590; // _IOW('E', 0x90, int)
const EVENT_SIZE = 24;        // struct input_event en 64 bits

const BUTTONS = { 0x110: BTN.LEFT, 0x111: BTN.RIGHT, 0x112: BTN.MIDDLE, 0x113: BTN.BACK, 0x114: BTN.FORWARD };

let ioctl = null;
function getIoctl() {
  if (!ioctl) {
    const koffi = require('koffi');
    const libc = koffi.load('libc.so.6');
    ioctl = libc.func('int ioctl(int fd, unsigned long req, ...)');
  }
  return ioctl;
}

/** ¿El bitmap KEY de /proc tiene ese código? (palabras hex, la menos significativa al final) */
function hasKey(block, code) {
  const words = (/^B: KEY=(.*)$/m.exec(block)?.[1] || '').trim().split(/\s+/).reverse();
  const bitsPerWord = 64;
  const w = words[Math.floor(code / bitsPerWord)];
  if (!w) return false;
  return (BigInt('0x' + w) >> BigInt(code % bitsPerWord)) & 1n ? true : false;
}

/** Lee /proc/bus/input/devices y devuelve los teclados y mouse */
function listInputDevices() {
  const text = fs.readFileSync('/proc/bus/input/devices', 'utf8');
  const out = [];
  for (const block of text.split(/\n\n+/)) {
    const name = /^N: Name="(.*)"$/m.exec(block)?.[1];
    const vendor = parseInt(/^I: .*Vendor=(\w+)/m.exec(block)?.[1] || '0', 16);
    const handlers = /^H: Handlers=(.*)$/m.exec(block)?.[1] || '';
    const event = /\b(event\d+)\b/.exec(handlers)?.[1];
    const ev = parseInt(/^B: EV=(\w+)$/m.exec(block)?.[1] || '0', 16);
    const rel = parseInt(/^B: REL=(\w+)$/m.exec(block)?.[1] || '0', 16);
    if (!event || !name) continue;
    if (/flow-oss|virtual/i.test(name)) continue;
    const isMouse = (ev & (1 << EV_REL)) && (rel & 0b11) === 0b11; // REL_X y REL_Y
    const isKeyboard = /\bkbd\b/.test(handlers) && hasKey(block, 30) && hasKey(block, 57); // KEY_A y KEY_SPACE
    if (isMouse || isKeyboard) out.push({ name, vendor, path: `/dev/input/${event}`, isMouse: !!isMouse, isKeyboard: !!isKeyboard });
  }
  return out;
}

class LinuxCapture extends EventEmitter {
  /** @param {function} [only] filtro de dispositivos, p. ej. solo el mouse Logitech */
  constructor({ log = console.log, only = null } = {}) {
    super();
    this.log = log;
    this.only = only;
    this.devices = [];   // {name, path, fd, stream}
    this.grabbed = false;
    this.hiRes = { v: false, h: false };
  }

  start() {
    this._scan();
    // Los dispositivos Bluetooth cambian de /dev/input/eventN al reconectarse:
    // revisar cada 2 s (leer /proc es muy barato) y abrir los nuevos.
    this.rescan = setInterval(() => this._scan(), 2000);
    return this.devices.length;
  }

  _scan() {
    let found;
    try { found = listInputDevices().filter((d) => !this.only || this.only(d)); } catch { return; }
    for (const d of found) {
      if (this.devices.some((x) => x.path === d.path)) continue;
      // Al reconectarse, udev da el permiso un instante después de crear el nodo: reintentar
      const deniedAt = this.denied?.get(d.path);
      if (deniedAt && Date.now() - deniedAt < 3000) continue;
      try {
        const fd = fs.openSync(d.path, 'r');
        const stream = fs.createReadStream(null, { fd, highWaterMark: EVENT_SIZE * 64, autoClose: true });
        const dev = { ...d, fd, stream, pending: Buffer.alloc(0), dx: 0, dy: 0, wv: 0, wh: 0 };
        stream.on('data', (chunk) => this._onData(dev, chunk));
        const drop = () => { this.devices = this.devices.filter((x) => x !== dev); };
        stream.on('error', (e) => { if (e.code !== 'ENODEV') this.log(`[Capture] ${d.name}: ${e.message}`); drop(); });
        stream.on('close', drop);
        this.devices.push(dev);
        this.denied?.delete(d.path);
        if (this.grabbed) getIoctl()(fd, EVIOCGRAB, 'int', 1);
        this.log(`[Capture] Escuchando ${d.name} (${d.path})`);
      } catch (e) {
        const first = !(this.denied ||= new Map()).has(d.path);
        this.denied.set(d.path, Date.now());
        if (first) {
          this.log(`[Capture] Sin permiso para ${d.path} (${d.name}): ${e.code} — reintentando`);
          this.emit('permission-error', d);
        }
      }
    }
  }

  stop() {
    clearInterval(this.rescan);
    this.grab(false);
    for (const d of this.devices) { try { d.stream.destroy(); } catch {} }
    this.devices = [];
  }

  /** Agarrar (true) o soltar (false) todos los dispositivos */
  grab(on) {
    if (this.grabbed === on) return;
    const io = getIoctl();
    for (const d of this.devices) {
      const r = io(d.fd, EVIOCGRAB, 'int', on ? 1 : 0);
      if (r !== 0 && on) this.log(`[Capture] No se pudo agarrar ${d.name}`);
    }
    this.grabbed = on;
  }

  _onData(dev, chunk) {
    let buf = dev.pending.length ? Buffer.concat([dev.pending, chunk]) : chunk;
    let off = 0;
    for (; off + EVENT_SIZE <= buf.length; off += EVENT_SIZE) {
      const type = buf.readUInt16LE(off + 16);
      const code = buf.readUInt16LE(off + 18);
      const value = buf.readInt32LE(off + 20);
      this._onEvent(dev, type, code, value);
    }
    dev.pending = buf.subarray(off);
  }

  _onEvent(dev, type, code, value) {
    if (type === EV_REL) {
      if (code === REL_X) dev.dx += value;
      else if (code === REL_Y) dev.dy += value;
      else if (code === REL_WHEEL_HI_RES) { this.hiRes.v = true; dev.wv += value; }
      else if (code === REL_HWHEEL_HI_RES) { this.hiRes.h = true; dev.wh += value; }
      else if (code === REL_WHEEL && !this.hiRes.v) dev.wv += value * 120;
      else if (code === REL_HWHEEL && !this.hiRes.h) dev.wh += value * 120;
      return;
    }
    if (type === EV_KEY) {
      if (BUTTONS[code]) {
        if (value !== 2) this.emit('button', { btn: BUTTONS[code], down: value === 1 });
      } else {
        // 1 = presionar, 2 = autorepetición (también se manda como presionar), 0 = soltar
        this.emit('key', { code, down: value !== 0, repeat: value === 2 });
      }
      return;
    }
    if (type === EV_SYN && code === 0) {
      if (dev.dx || dev.dy) this.emit('move', { dx: dev.dx, dy: dev.dy });
      if (dev.wv || dev.wh) this.emit('wheel', { v: dev.wv, h: dev.wh }); // mismo signo que Windows
      dev.dx = dev.dy = dev.wv = dev.wh = 0;
    }
  }
}

module.exports = { LinuxCapture, listInputDevices };
