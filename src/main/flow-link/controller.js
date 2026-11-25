/**
 * Controlador de Flow OSS — modo "cambio de canal" (como Logi Options+ Flow).
 *
 * El mouse Logitech NUNCA viaja por la red: al tocar el borde hacia el otro equipo,
 * el equipo donde está el mouse le ordena por HID++ cambiar de canal, y avisa al
 * otro equipo (ENTER) a qué altura debe aparecer el cursor. Así el cursor siempre
 * se mueve en local, sin lag.
 *
 * El teclado USB de Windows sigue al cursor: mientras el cursor está en el Mac,
 * Windows lo bloquea y reenvía sus teclas. El teclado del Mac no se comparte nunca.
 *
 * focus: 'here' (el cursor está en este equipo) | 'there' (en el otro)
 *
 * Mensajes:
 *   ENTER {pos}   "el cursor pasa a ti, aparece a esta altura del borde"
 *   LEAVE {pos}   "el cursor volvió a mí" (p. ej. presionaste Easy-Switch a mano)
 *   KEY / RELEASE_ALL  teclado de Windows → Mac
 *   CONFIG {peerSide, at, host}  disposición + canal del mouse del emisor
 *
 * Atajos en el teclado de Windows:
 *   Ctrl+Alt+<flecha hacia el otro equipo>  pasar sin tocar el borde
 *   Ctrl+Alt+Esc                            el teclado vuelve a Windows
 */
const { EventEmitter } = require('events');
const { FlowLink } = require('./link');
const { HidppMouse } = require('./hidpp');
const { MSG, SIDE_TO_EDGE, OPPOSITE, SIDES } = require('./protocol');

const KEY_ESC = 1, KEY_LEFTCTRL = 29, KEY_RIGHTCTRL = 97, KEY_LEFTALT = 56, KEY_RIGHTALT = 100;
const SIDE_ARROW = { left: 105, right: 106, top: 103, bottom: 108 };
const ENTER_INSET = 6;        // px desde el borde donde aparece el cursor al entrar
const RECLAIM_GRACE_MS = 1500; // ignorar movimientos sueltos justo después de cambiar de canal
const SIDE_ES = { left: 'izquierda', right: 'derecha', top: 'arriba', bottom: 'abajo' };

class FlowController extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.peerSide  dónde está el otro equipo visto desde este
   * @param {number} o.myHost    canal del mouse (0..2) que corresponde a este equipo
   * @param {number} o.peerHost  canal del mouse que corresponde al otro equipo
   * @param {function} o.screen  () => {x,y,w,h} escritorio en px (Linux)
   */
  /**
   * @param {object} o.clipboard  proveedor {snapshot, apply, currentHash} (solo en Electron)
   * @param {object} o.options    {enabled, clipboard, files, keyboard, maxFileBytes, downloadDir}
   */
  constructor({ code, id, name, peerAddress, peerSide, sideAt = 0, myHost, peerHost, manualHost = null, screen,
    clipboard = null, options = {}, log = console.log }) {
    super();
    this.log = log;
    this.link = new FlowLink({ code, id, name, peerAddress, log });
    this.isWin = process.platform === 'win32';
    this.peerSide = SIDES.includes(peerSide) ? peerSide : (this.isWin ? 'right' : 'left');
    this.sideAt = sideAt;
    // Por defecto: Mac en el canal 3, Windows en el canal 2 (se corrige solo al detectarlo)
    this.myHost = Number.isInteger(myHost) ? myHost : (this.isWin ? 1 : 2);
    this.peerHost = Number.isInteger(peerHost) ? peerHost : (this.isWin ? 2 : 1);
    // Canal fijado a mano en la UI (null = detectar solo)
    this.manualHost = Number.isInteger(manualHost) ? manualHost : null;
    if (this.manualHost !== null) this.myHost = this.manualHost;
    this.screenFn = screen;
    this.focus = 'here';
    this.focusAt = 0;
    this.peer = null;
    this.held = new Map();      // tecla presionada en este teclado (Windows) → último evento (ms)
    this.lastKeyMsgAt = 0;      // último KEY/KEYSTATE recibido (Linux)
    this.forwarding = false;    // reenviando el teclado de Windows al otro equipo
    this.pendingForward = false;
    this.mouse = new HidppMouse({ log });
    this.clipboard = clipboard;
    this.options = { enabled: true, clipboard: true, files: true, keyboard: true, maxFileBytes: 2e9, downloadDir: null, ...options };
    this.lastClipHash = null;  // lo último enviado/recibido (no reenviarlo)
    this.transfer = null;      // {dir: 'in'|'out', pct, files} mientras hay una transferencia
    this.lastTransfer = null;  // texto del último resultado
  }

  /** Cambiar opciones desde la UI */
  setOptions(o) {
    Object.assign(this.options, o);
    this.capture?.watchEdge?.(this.peer && this.options.enabled ? this.peerSide : null);
    if (!this.options.keyboard) this._stopForwarding();
    this._changed();
  }

  status() {
    return {
      state: this.focus === 'here' ? 'local' : 'remote',
      peerSide: this.peerSide,
      myHost: this.myHost,
      peerHost: this.peerHost,
      manualHost: this.manualHost,
      forwardingKeys: this.forwarding,
      active: !!this.peer && this.options.enabled,
      options: { ...this.options },
      transfer: this.transfer,
      lastTransfer: this.lastTransfer,
      peer: this.peer ? { name: this.peer.name, address: this.peer.address } : null,
      mismatch: this.mismatch || null,
      permissionErrors: [...(this.permissionErrors || []), ...(this.mouse.denied || [])],
      injectError: this.injectError || null,
    };
  }

  start() {
    this.link.on('peer', (peer) => {
      const isNew = peer && (!this.peer || this.peer.id !== peer.id);
      this.peer = peer;
      if (!peer) this._peerLost();
      if (isNew) this._sendConfig();
      // Flow solo está activo con el otro equipo presente: sin él no se vigila ningún borde
      this.capture?.watchEdge?.(peer && this.options.enabled ? this.peerSide : null);
      this._changed();
    });
    this.link.on('mismatch', (m) => {
      if (!this.mismatch) this.log(`[Flow] ${m.name} (${m.address}) usa otro código de emparejamiento`);
      this.mismatch = m;
      this._changed();
    });
    this.link.on('message', (m) => this._onMessage(m));
    this.link.start();
    this._startCapture();
    this._startInject();
    this._startTransfer();
    if (!this.isWin) {
      this.keyWatchdog = setInterval(() => {
        if (this.inject?.pressedKeys?.size && Date.now() - this.lastKeyMsgAt > 1500) {
          this.log('[Flow] Sin noticias del teclado remoto: suelto las teclas');
          this.inject.releaseAll();
        }
      }, 500);
    }
    // Precalentar HID++ (por Bluetooth la primera consulta tarda ~1 s) y confirmar el canal
    setTimeout(() => this._learnMyHost(), 1500);
  }

  stop() {
    clearInterval(this.keyWatchdog);
    this._stopForwarding();
    this.transferServer?.stop();
    try { this.capture?.stop(); } catch {}
    try { this.inject?.releaseAll(); this.inject?.close?.(); } catch {}
    this.mouse.close().catch(() => {});
    this.link.stop();
  }

  _changed() { this.emit('status', this.status()); }

  /** ¿El otro equipo respondió hace poco? Evita mandar el mouse a un equipo que se apagó */
  peerAlive() {
    return !!this.peer && Date.now() - (this.link.peer?.lastSeen || 0) < 2500;
  }

  // ================= configuración =================
  setPeerSide(side) {
    if (!SIDES.includes(side)) return false;
    this._applySide(side, Date.now());
    this._sendConfig();
    return true;
  }

  _applySide(side, at) {
    this.peerSide = side;
    this.sideAt = at;
    if (this.peer && this.options.enabled) this.capture?.watchEdge?.(side);
    this.log(`[Flow] El otro equipo está a la ${SIDE_ES[side]}`);
    this._saveConfig();
    this._changed();
  }

  _saveConfig() {
    this.emit('config', { peerSide: this.peerSide, sideAt: this.sideAt, myHost: this.myHost, peerHost: this.peerHost, manualHost: this.manualHost });
  }

  /** Fijar a mano el canal de este equipo (0..2) o volver a automático (null) */
  setMyHost(host) {
    if (host !== null && ![0, 1, 2].includes(host)) return false;
    this.manualHost = host;
    if (host === null) {
      this.log('[Flow] Canal de este equipo: automático');
      this._learnMyHost();
    } else {
      this.myHost = host;
      this.log(`[Flow] Canal de este equipo fijado a mano: ${host + 1}`);
    }
    this._saveConfig();
    this._sendConfig();
    this._changed();
    return true;
  }

  _sendConfig() {
    this.link.send(MSG.CONFIG, { peerSide: OPPOSITE[this.peerSide], at: this.sideAt, host: this.myHost });
  }

  /** Lee del mouse en qué canal está (solo cuando está conectado aquí) */
  async _learnMyHost() {
    if (this.manualHost !== null) {
      this.mouse.find().catch(() => {}); // solo precalentar HID++
      return;
    }
    const info = await this.mouse.hostInfo().catch(() => null);
    if (!info) return;
    if (info.current !== this.myHost) {
      this.log(`[Flow] Este equipo es el canal ${info.current + 1} del mouse`);
      this.myHost = info.current;
      if (this.peerHost === this.myHost) this.peerHost = [0, 1, 2].find((h) => h !== this.myHost);
      this._saveConfig();
      this._sendConfig();
      this._changed();
    }
  }

  // ================= entrada local =================
  _startCapture() {
    if (this.isWin) {
      const { WinCapture } = require('./win-capture');
      this.capture = new WinCapture({ log: this.log });
      this.capture.on('edge', (pos) => this.edgeHit(pos, 'borde'));
      this.capture.on('reclaim', () => this._reclaim('el mouse volvió a moverse en Windows'));
      this.capture.on('key', (e) => this._onWinKey(e));
      this.capture.start(); // el borde se vigila cuando aparezca el otro equipo
    } else {
      // Linux: solo se escucha (sin agarrar) el mouse Logitech, para notar si vuelve
      // a este equipo con el botón Easy-Switch. El teclado del Mac no se toca.
      const { LinuxCapture } = require('./linux-capture');
      this.capture = new LinuxCapture({ log: this.log, only: (d) => d.isMouse && d.vendor === 0x046d });
      this.permissionErrors = [];
      this.capture.on('permission-error', (d) => this.permissionErrors.push(d.path));
      this.capture.start();
      let moves = 0;
      this.capture.on('move', () => {
        if (this.focus !== 'there' || Date.now() - this.focusAt < RECLAIM_GRACE_MS) { moves = 0; return; }
        if (++moves >= 5) { moves = 0; this._reclaim('el mouse volvió a moverse en Linux'); }
      });
    }
  }

  _startInject() {
    try {
      if (this.isWin) {
        const { WinInject } = require('./win-inject');
        this.inject = new WinInject({ log: this.log });
      } else {
        const { LinuxInject } = require('./linux-inject');
        this.inject = new LinuxInject({ log: this.log, screen: () => this._screen() });
      }
    } catch (e) {
      this.injectError = e.message;
      this.log(`[Flow] No se puede colocar el cursor ni recibir teclas: ${e.message}`);
    }
  }

  _screen() {
    if (this.isWin) return this.inject.screen();
    return this.screenFn ? this.screenFn() : { x: 0, y: 0, w: 1920, h: 1080 };
  }

  /**
   * El cursor tocó el borde hacia el otro equipo (sensor en Linux, hook en Windows):
   * el mouse cambia de canal y el otro equipo coloca el cursor.
   */
  async edgeHit(pos, why = 'borde') {
    const refuse = (reason) => { this.log(`[Flow] Borde ignorado: ${reason}`); return false; };
    if (!this.options.enabled) return refuse('Flow está desactivado');
    if (!this.peer) return refuse('no hay otro equipo');
    if (!this.peerAlive()) return refuse(`${this.peer.name} no responde (red lenta o equipo apagado)`);
    if (this.switching) return false;
    this.switching = true;
    let ok = false;
    try {
      if (this.focus !== 'here') {
        // Creíamos que el cursor estaba allá (se perdió un aviso). Si el mouse está
        // conectado aquí, el cursor está aquí: corregir y seguir.
        if (!(await this.mouse.find())) return refuse('el mouse no está conectado a este equipo');
        this._stopForwarding();
        this._setFocus('here', 'el mouse está aquí');
        this.link.sendReliable(MSG.LEAVE, { edge: 0, pos: 0.5 });
      }
      ok = await this.mouse.setHost(this.peerHost);
    } finally { this.switching = false; }
    if (!ok) {
      this.log('[Flow] El mouse no está conectado a este equipo: no lo puedo cambiar de canal');
      return false;
    }
    if (this.focus !== 'here') return false;
    // Se reenvía hasta que el otro equipo confirme (la Wi-Fi puede perder paquetes)
    this.link.sendReliable(MSG.ENTER, { edge: SIDE_TO_EDGE[OPPOSITE[this.peerSide]], pos })
      .then((ok) => { if (!ok) this.log(`[Flow] ${this.peer?.name || 'El otro equipo'} no confirmó el cambio`); });
    this._setFocus('there', why);
    if (this.isWin) this._startForwarding();
    this._pushClipboard(); // el portapapeles viaja con el cursor
    return true;
  }

  _setFocus(focus, why) {
    if (this.focus === focus) return;
    this.focus = focus;
    this.focusAt = Date.now();
    this.log(focus === 'there' ? `[Flow] → cursor en ${this.peer?.name || 'el otro equipo'} (${why})` : `[Flow] ← cursor aquí (${why})`);
    this._changed();
  }

  /** El mouse apareció aquí sin pasar por el borde (botón Easy-Switch) */
  _reclaim(why) {
    if (this.focus !== 'there') return;
    this._stopForwarding();
    this._setFocus('here', why);
    this.link.sendReliable(MSG.LEAVE, { edge: 0, pos: 0.5 });
    setTimeout(() => this._learnMyHost(), 300);
  }

  // ================= teclado de Windows =================
  _onWinKey(e) {
    if (e.down) this.held.set(e.code, Date.now()); else this.held.delete(e.code);
    if (this.pendingForward) {
      if (this.held.size === 0) { this.pendingForward = false; this._beginForwarding(); }
      return;
    }
    const ctrl = this.held.has(KEY_LEFTCTRL) || this.held.has(KEY_RIGHTCTRL);
    const alt = this.held.has(KEY_LEFTALT) || this.held.has(KEY_RIGHTALT);

    if (this.forwarding) {
      if (ctrl && alt && e.code === KEY_ESC && e.down) {
        this.log('[Flow] Ctrl+Alt+Esc: el teclado vuelve a Windows');
        this._stopForwarding();
        this._setFocus('here', 'atajo');
        this.link.sendReliable(MSG.LEAVE, { edge: 0, pos: 0.5 });
        return;
      }
      this.link.send(MSG.KEY, { code: e.code, down: e.down });
      if (!e.down) this.link.send(MSG.KEY, { code: e.code, down: false }); // soltar va duplicado
      return;
    }
    if (ctrl && alt && e.down && e.code === SIDE_ARROW[this.peerSide]) this.edgeHit(0.5, 'atajo');
  }

  _startForwarding() {
    if (!this.capture?.keysOnly || !this.options.keyboard) return;
    // Si hay teclas presionadas, bloquear ahora dejaría su "soltar" sin llegar a Windows
    this._liveKeys();
    if (this.held.size > 0) { this.pendingForward = true; this._startKeyState(); }
    else this._beginForwarding();
  }

  _beginForwarding() {
    if (this.focus !== 'there') return;
    this.forwarding = true;
    this.capture.keysOnly(true);
    this._startKeyState();
    this._changed();
  }

  /** Teclas presionadas de verdad: un "soltar" perdido no puede dejar una tecla pegada */
  _liveKeys() {
    const now = Date.now();
    for (const [code, t] of this.held) {
      // Una tecla sostenida genera autorepetición; si lleva >1.2 s sin eventos, se soltó
      // (el "soltar" se perdió). Se avisa al otro equipo.
      if (now - t > 1200) {
        this.held.delete(code);
        if (this.forwarding) this.link.send(MSG.KEY, { code, down: false });
      }
    }
    return [...this.held.keys()];
  }

  _startKeyState() {
    clearInterval(this.keyStateTimer);
    this.keyStateTimer = setInterval(() => {
      const codes = this._liveKeys();
      if (this.pendingForward && this.held.size === 0) { this.pendingForward = false; this._beginForwarding(); }
      if (this.forwarding) this.link.send(MSG.KEYSTATE, { codes });
    }, 300);
  }

  _stopForwarding() {
    this.pendingForward = false;
    clearInterval(this.keyStateTimer);
    if (!this.forwarding) return;
    this.forwarding = false;
    this.capture?.keysOnly?.(false);
    this.link.send(MSG.RELEASE_ALL, {});
    this.link.send(MSG.RELEASE_ALL, {});
    this._changed();
  }

  // ================= mensajes =================
  _entryPoint(pos) {
    const s = this._screen();
    const p = Math.min(Math.max(pos, 0), 1);
    switch (this.peerSide) {
      case 'left': return [s.x + ENTER_INSET, s.y + p * (s.h - 1)];
      case 'right': return [s.x + s.w - 1 - ENTER_INSET, s.y + p * (s.h - 1)];
      case 'top': return [s.x + p * (s.w - 1), s.y + ENTER_INSET];
      default: return [s.x + p * (s.w - 1), s.y + s.h - 1 - ENTER_INSET];
    }
  }

  _onMessage({ type, payload, seq }) {
    if (type === MSG.ENTER || type === MSG.LEAVE) this.link.send(MSG.ACK, { ref: seq }); // confirmar siempre
    switch (type) {
      case MSG.CONFIG:
        if (Number.isInteger(payload.host) && payload.host !== this.peerHost) {
          this.peerHost = payload.host;
          this.log(`[Flow] ${this.peer?.name || 'El otro equipo'} es el canal ${payload.host + 1} del mouse`);
          this._saveConfig();
        }
        if (SIDES.includes(payload.peerSide) && payload.at > this.sideAt) this._applySide(payload.peerSide, payload.at);
        else if (payload.at < this.sideAt) this._sendConfig(); // el mío es más nuevo
        this._changed();
        return;

      case MSG.ENTER: { // el mouse viene hacia aquí
        if (Date.now() - (this.lastEnterRx || 0) < 3000 && this.focus === 'here') return; // reenvío del mismo
        this.lastEnterRx = Date.now();
        this._stopForwarding();
        if (this.inject) {
          const [x, y] = this._entryPoint(payload.pos);
          this.inject.warp(x, y);
        }
        this._setFocus('here', `desde ${this.peer?.name || 'el otro equipo'}`);
        setTimeout(() => this._learnMyHost(), 1500); // confirmar el canal cuando el mouse llegue
        return;
      }

      case MSG.LEAVE: // el otro equipo recuperó el mouse
        if (this.focus !== 'here') return;
        this.inject?.releaseAll();
        this._setFocus('there', `${this.peer?.name || 'el otro equipo'} recuperó el mouse`);
        if (this.isWin) this._startForwarding();
        this._pushClipboard();
        return;

      case MSG.KEY:
        this.lastKeyMsgAt = Date.now();
        if (!this.isWin && this.focus === 'here') this.inject?.key(payload.code, payload.down);
        return;

      case MSG.KEYSTATE: {
        this.lastKeyMsgAt = Date.now();
        if (this.isWin || !this.inject) return;
        const live = new Set(payload.codes);
        for (const code of [...this.inject.pressedKeys]) if (!live.has(code)) this.inject.key(code, false);
        return;
      }

      case MSG.RELEASE_ALL:
        this.inject?.releaseAll();
    }
  }

  // ================= portapapeles y archivos =================
  _startTransfer() {
    if (!this.clipboard) return;
    const { TransferServer } = require('./transfer');
    const os = require('os');
    const path = require('path');
    this.transferServer = new TransferServer({
      key: this.link.key,
      destDir: () => this.options.downloadDir || path.join(os.homedir(), 'Downloads', 'OpenFlow'),
      isPeer: (addr) => !!this.peer && this.peer.address === addr,
      maxBytes: this.options.maxFileBytes,
      log: this.log,
    });
    this.transferServer.on('progress', ({ received, total, files }) => {
      this._setTransfer({ dir: 'in', files, pct: total ? Math.round((received / total) * 100) : 100 });
    });
    this.transferServer.on('clipboard', async (data) => {
      const accept = this.options.clipboard && (!data.files.length || this.options.files);
      if (accept) {
        try {
          await this.clipboard.apply(data);
          this.lastClipHash = await this.clipboard.currentHash();
        } catch (e) { this.log(`[Flow] No se pudo escribir el portapapeles: ${e.message}`); }
      }
      const what = data.files.length ? `${data.files.length} elemento(s) en ${data.dir}`
        : data.image ? 'una imagen' : 'texto';
      this.lastTransfer = `Recibido de ${this.peer?.name || 'el otro equipo'}: ${what}`;
      this.log(`[Flow] Portapapeles recibido: ${what}`);
      if (data.files.length) this.emit('files-received', { count: data.files.length, dir: data.dir, from: this.peer?.name });
      this._setTransfer(null);
    });
    this.transferServer.start();
  }

  _setTransfer(t) {
    this.transfer = t;
    const now = Date.now();
    // Avisar a la UI como mucho 4 veces por segundo
    if (!t || now - (this._lastTransferEmit || 0) > 250) { this._lastTransferEmit = now; this._changed(); }
  }

  /** Manda el portapapeles de este equipo al otro, si cambió desde la última vez */
  async _pushClipboard() {
    if (!this.clipboard || !this.options.clipboard || !this.peer || this.pushing) return;
    this.pushing = true;
    try {
      const snap = await this.clipboard.snapshot();
      if (snap.empty || snap.hash === this.lastClipHash) return;
      const { sendClipboard, collectFiles } = require('./transfer');
      let files = [];
      if (snap.files.length) {
        if (!this.options.files) return;
        files = collectFiles(snap.files);
        const total = files.reduce((a, f) => a + f.size, 0);
        if (total > this.options.maxFileBytes) {
          this.lastTransfer = `No se enviaron los archivos: ${(total / 1e9).toFixed(1)} GB supera el límite`;
          this.log(`[Flow] ${this.lastTransfer}`);
          this._changed();
          return;
        }
      }
      const total = files.reduce((a, f) => a + f.size, 0);
      if (files.length) this._setTransfer({ dir: 'out', files: files.length, pct: 0 });
      await sendClipboard({
        key: this.link.key, address: this.peer.address,
        text: snap.text, html: snap.html, image: snap.image, files, log: this.log,
        onProgress: ({ sent }) => this._setTransfer({ dir: 'out', files: files.length, pct: total ? Math.round((sent / total) * 100) : 100 }),
      });
      this.lastClipHash = snap.hash;
      const what = files.length ? `${files.length} archivo(s)` : snap.image ? 'una imagen' : 'texto';
      this.lastTransfer = `Enviado a ${this.peer?.name || 'el otro equipo'}: ${what}`;
      this.log(`[Flow] Portapapeles enviado: ${what}`);
    } catch (e) {
      this.lastTransfer = `Error al enviar el portapapeles: ${e.message}`;
      this.log(`[Flow] ${this.lastTransfer}`);
    } finally {
      this.pushing = false;
      this._setTransfer(null);
    }
  }

  _peerLost() {
    if (this.forwarding || this.pendingForward) {
      this.log('[Flow] Conexión perdida: el teclado vuelve a Windows');
      this._stopForwarding();
    }
    this.inject?.releaseAll();
  }
}

module.exports = { FlowController };
