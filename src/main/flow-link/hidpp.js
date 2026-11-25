/**
 * HID++ 2.0 mínimo para cambiar de canal el mouse (como hace Logi Options+ Flow).
 *
 * Usa la función CHANGE_HOST (0x1814):
 *   fn 0 getHostInfo          → [nHosts, hostActual, ...]
 *   fn 1 setCurrentHost(host) → el mouse se desconecta y se conecta al canal `host`
 * Los canales van de 0 a 2 (en el mouse se ven como 1, 2 y 3).
 *
 * Funciona por receptor Unifying/Bolt o por Bluetooth. Todo es asíncrono para no
 * bloquear la app: por Bluetooth el mouse puede tardar ~0.5 s en contestar.
 */
const HID = require('node-hid');

const LONG = 0x11;
// Solaar (Linux) y Options+ (Windows) hablan con el mouse al mismo tiempo: usar un
// identificador poco común y además VERIFICAR cada dato (ver _find y hostInfo).
const SW_ID = 0x02 + Math.floor(Math.random() * 13);
const FEAT_CHANGE_HOST = 0x1814;
const FEAT_FEATURE_SET = 0x0001;
const RECEIVER_PIDS = new Set([0xc52b, 0xc532, 0xc534, 0xc539, 0xc53f, 0xc547, 0xc548]);

function pad(msg) { while (msg.length < 20) msg.push(0); return msg; }

class HidppMouse {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this.handle = null;
    this.dev = null;     // índice en el receptor (1..6) o 0xff (Bluetooth/USB directo)
    this.feat = null;    // índice de la función CHANGE_HOST
    this.path = null;
    this.waiters = new Set();
    this.finding = null;
  }

  /**
   * Candidatos: colección de reportes largos HID++.
   *   receptor Unifying/Bolt/USB: usage page 0xFF00, usage 2
   *   Bluetooth:                  usage page 0xFF43, usage 0x0202
   */
  _candidates() {
    const list = HID.devices().filter((d) => d.vendorId === 0x046d
      && ((d.usagePage === 0xff00 && d.usage === 2) || (d.usagePage === 0xff43 && (d.usage & 0xff) === 2)));
    list.sort((a, b) => (RECEIVER_PIDS.has(b.productId) ? 1 : 0) - (RECEIVER_PIDS.has(a.productId) ? 1 : 0));
    const seen = new Set();
    return list.filter((d) => !seen.has(d.path) && seen.add(d.path));
  }

  async _open(path) {
    const h = await HID.HIDAsync.open(path);
    h.on('data', (r) => { for (const w of [...this.waiters]) if (w.h === h) w.onData(r); });
    h.on('error', () => {});
    return h;
  }

  _request(h, dev, feat, fn, params = [], timeout = 1000) {
    return new Promise((resolve) => {
      const w = {
        h,
        onData: (r) => {
          if (dev !== 0xff && r[1] !== dev) return;
          if ((r[2] === 0xff && r[3] === feat) || r[2] === 0x8f) return done(null); // error / no conectado
          if (r[2] === feat && (r[3] & 0x0f) === SW_ID) done(Buffer.from(r).subarray(4));
        },
      };
      const timer = setTimeout(() => done(null), timeout);
      const done = (v) => { clearTimeout(timer); this.waiters.delete(w); resolve(v); };
      this.waiters.add(w);
      h.write(pad([LONG, dev, feat, (fn << 4) | SW_ID, ...params])).catch(() => done(null));
    });
  }

  /** Confirma con IFeatureSet que en el índice `idx` está realmente `featureId` */
  async _verifyFeature(h, dev, idx, featureId, timeout) {
    const fs = await this._request(h, dev, 0x00, 0, [FEAT_FEATURE_SET >> 8, FEAT_FEATURE_SET & 0xff], timeout);
    if (!fs || !fs[0]) return false;
    const r = await this._request(h, dev, fs[0], 1, [idx], timeout); // getFeatureID(index)
    const ok = !!r && ((r[0] << 8) | r[1]) === featureId;
    if (!ok) this.log(`[HID++] Respuesta ajena descartada (índice ${idx} no es 0x${featureId.toString(16)})`);
    return ok;
  }

  /** Busca el mouse con CHANGE_HOST. true si está conectado a este equipo. */
  find() {
    if (!this.finding) this.finding = this._find().finally(() => { this.finding = null; });
    return this.finding;
  }

  async _find() {
    if (this.handle && await this._request(this.handle, this.dev, this.feat, 0)) return true;
    await this.close();
    this.denied = [];
    for (const d of this._candidates()) {
      let h;
      if (process.platform === 'linux') {
        try { require('fs').accessSync(d.path, require('fs').constants.R_OK | require('fs').constants.W_OK); }
        catch { this.denied.push(d.path); continue; } // falta la regla udev
      }
      try { h = await this._open(d.path); } catch { continue; }
      const receiver = RECEIVER_PIDS.has(d.productId);
      const devs = receiver ? [1, 2, 3, 4, 5, 6] : [0xff];
      for (const dev of devs) {
        // Receptor: si el mouse no está, responde enseguida con error. Bluetooth: puede tardar.
        const t = receiver ? 400 : 1500;
        const r = await this._request(h, dev, 0x00, 0, [FEAT_CHANGE_HOST >> 8, FEAT_CHANGE_HOST & 0xff], t);
        if (r && r[0] && await this._verifyFeature(h, dev, r[0], FEAT_CHANGE_HOST, t)) {
          Object.assign(this, { handle: h, dev, feat: r[0], path: d.path, receiver });
          this.log(`[HID++] Mouse encontrado (${receiver ? `receptor, dispositivo ${dev}` : 'Bluetooth'}, CHANGE_HOST en índice ${r[0]})`);
          return true;
        }
      }
      try { await h.close(); } catch {}
    }
    return false;
  }

  /** {count, current} o null si el mouse no está conectado a este equipo */
  async hostInfo() {
    if (!(await this.find())) return null;
    // Leer dos veces y exigir que coincida y tenga sentido (descarta respuestas ajenas)
    const a = await this._request(this.handle, this.dev, this.feat, 0);
    const b = a && await this._request(this.handle, this.dev, this.feat, 0);
    if (!a || !b || a[0] !== b[0] || a[1] !== b[1]) return null;
    if (a[0] < 1 || a[0] > 6 || a[1] >= a[0]) return null;
    return { count: a[0], current: a[1] };
  }

  /** Cambia el mouse al canal `host` (0..2). true si se envió la orden. */
  async setHost(host) {
    const send = async () => {
      await this.handle.write(pad([LONG, this.dev, this.feat, (1 << 4) | SW_ID, host]));
      this.log(`[HID++] Mouse → canal ${host + 1}`);
      return true;
    };
    if (!this.handle && !(await this.find())) return false;
    // Por receptor la escritura "funciona" aunque el mouse no esté: confirmarlo antes
    // (el receptor contesta enseguida). Por Bluetooth, si no está, el nodo ni existe.
    if (this.receiver && !(await this._request(this.handle, this.dev, this.feat, 0, [], 300))) {
      if (!(await this.find())) return false;
    }
    try {
      return await send();
    } catch (e) {
      // El handle quedó viejo (p. ej. el Bluetooth se reconectó): buscar otra vez
      await this.close();
      if (await this.find()) { try { return await send(); } catch {} }
      this.log(`[HID++] No se pudo cambiar de canal: ${e.message}`);
      return false;
    }
  }

  async close() {
    const h = this.handle;
    this.handle = null;
    try { await h?.close(); } catch {}
  }
}

module.exports = { HidppMouse };
