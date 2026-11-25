/**
 * FlowLink — red de OpenLogiFlow: descubre el otro equipo y mueve los
 * mensajes de entrada cifrados entre los dos. No depende de Electron.
 *
 * Eventos:
 *   'peer'     (peer|null)    equipo emparejado encontrado / perdido
 *   'message'  ({type, payload}, peer)  mensaje autenticado recibido
 *   'mismatch' (info)         hay un equipo con la app pero otro código
 */
const dgram = require('dgram');
const crypto = require('crypto');
const os = require('os');
const { EventEmitter } = require('events');
const P = require('./protocol');

const HELLO_MS = 1000;
const PEER_TIMEOUT_MS = 4000;

function broadcastAddresses() {
  const out = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((o, i) => (o | (~mask[i] & 255))).join('.'));
    }
  }
  return [...out];
}

function localAddresses() {
  const s = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4') s.add(a.address);
  }
  return s;
}

class FlowLink extends EventEmitter {
  constructor({ code, id, name = os.hostname(), peerAddress = null, log = console.log }) {
    super();
    this.key = P.deriveKey(code);
    this.check = P.keyCheck(this.key);
    this.id = id || crypto.randomUUID();
    this.name = name;
    this.manualPeer = peerAddress;
    this.log = log;

    this.session = crypto.randomBytes(4).readUInt32BE(0);
    this.seq = 0;
    this.peer = null;          // {id, name, address, lastSeen}
    this.remoteSeq = new Map(); // sesión remota -> último seq
    this.timers = [];
  }

  start() {
    this.disc = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.disc.on('message', (m, r) => this._onDiscovery(m, r));
    this.disc.on('error', (e) => this.log(`[FlowLink] discovery: ${e.message}`));
    this.disc.bind(P.DISCOVERY_PORT, () => this.disc.setBroadcast(true));

    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (m, r) => this._onInput(m, r));
    this.sock.on('error', (e) => this.log(`[FlowLink] input: ${e.message}`));
    this.sock.bind(P.INPUT_PORT);

    this.own = localAddresses();
    this.timers.push(setInterval(() => this._announce(), 2000));
    this.timers.push(setInterval(() => this._hello(), HELLO_MS));
    this.timers.push(setInterval(() => this._checkPeer(), 1000));
    this._announce();
    this.log(`[FlowLink] Iniciado id=${this.id.slice(0, 8)} huella=${this.check.slice(0, 8)}`);
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    try { this.disc?.close(); } catch {}
    try { this.sock?.close(); } catch {}
    this._setPeer(null);
  }

  /** Envía un mensaje al equipo emparejado. Devuelve su seq, o 0 si no hay equipo. */
  send(type, payload) {
    const address = this.peer?.address || this.manualPeer;
    if (!address || !this.sock) return 0;
    const seq = ++this.seq;
    const pkt = P.seal(this.key, type, this.session, seq, P.encodePayload(type, payload));
    this.sock.send(pkt, P.INPUT_PORT, address);
    return seq;
  }

  /**
   * Envío confiable: reenvía cada 150 ms hasta recibir ACK (máx. `timeout` ms).
   * Resuelve true si se confirmó. Un envío nuevo del mismo tipo cancela el anterior.
   */
  sendReliable(type, payload, timeout = 2500) {
    this.pending ||= new Map();
    this.pending.get(type)?.cancel();
    return new Promise((resolve) => {
      const seqs = new Set();
      const started = Date.now();
      const entry = { seqs, cancel: () => finish(false) };
      const tick = () => {
        if (Date.now() - started > timeout) return finish(false);
        const s = this.send(type, payload);
        if (s) seqs.add(s);
      };
      const timer = setInterval(tick, 150);
      const finish = (ok) => {
        clearInterval(timer);
        if (this.pending.get(type) === entry) this.pending.delete(type);
        resolve(ok);
      };
      entry.finish = finish;
      this.pending.set(type, entry);
      tick();
    });
  }

  // --- descubrimiento (texto plano: solo dice "aquí estoy" y la huella del código)
  _announce() {
    if (!this.disc) return;
    const msg = Buffer.from(JSON.stringify({
      app: 'logi-flow-oss', v: P.VERSION, id: this.id, name: this.name, check: this.check,
    }));
    const targets = broadcastAddresses();
    if (this.manualPeer) targets.push(this.manualPeer);
    for (const t of targets) this.disc.send(msg, P.DISCOVERY_PORT, t, () => {});
  }

  _onDiscovery(buf, rinfo) {
    if (this.own.has(rinfo.address)) return;
    let m;
    try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (m.app !== 'logi-flow-oss' || m.id === this.id) return;
    if (m.check !== this.check) {
      this.emit('mismatch', { address: rinfo.address, name: m.name });
      return;
    }
    // Solo es candidato; el equipo queda emparejado al recibir un HELLO autenticado
    this.candidate = rinfo.address;
    if (!this.peer) this._hello(rinfo.address);
  }

  _hello(to) {
    const address = to || this.peer?.address || this.candidate || this.manualPeer;
    if (!address || !this.sock) return;
    const pkt = P.seal(this.key, P.MSG.HELLO, this.session, ++this.seq,
      P.encodePayload(P.MSG.HELLO, { id: this.id, name: this.name }));
    this.sock.send(pkt, P.INPUT_PORT, address);
  }

  // --- canal de entrada cifrado
  _onInput(buf, rinfo) {
    const m = P.open(this.key, buf);
    if (!m) return; // no autentica: se ignora

    const last = this.remoteSeq.get(m.session) ?? -1;
    if (m.seq <= last) return; // repetido o reenviado
    this.remoteSeq.set(m.session, m.seq);
    if (this.remoteSeq.size > 8) this.remoteSeq.delete(this.remoteSeq.keys().next().value);

    if (m.type === P.MSG.HELLO) {
      const isNew = !this.peer || this.peer.id !== m.payload.id || this.peer.address !== rinfo.address;
      if (isNew) {
        this._setPeer({ id: m.payload.id, name: m.payload.name, address: rinfo.address, lastSeen: Date.now() });
        this._hello(rinfo.address); // responder rápido
      } else {
        this.peer.lastSeen = Date.now();
      }
      return;
    }
    if (this.peer && this.peer.address === rinfo.address) this.peer.lastSeen = Date.now();
    if (m.type === P.MSG.ACK) {
      for (const entry of (this.pending || new Map()).values()) {
        if (entry.seqs.has(m.payload.ref)) entry.finish(true);
      }
      return;
    }
    this.emit('message', m, this.peer);
  }

  _checkPeer() {
    if (this.peer && Date.now() - this.peer.lastSeen > PEER_TIMEOUT_MS) {
      this.log(`[FlowLink] Equipo perdido: ${this.peer.name}`);
      this._setPeer(null);
    }
  }

  _setPeer(peer) {
    const changed = (this.peer?.id || null) !== (peer?.id || null);
    this.peer = peer;
    if (peer && changed) this.log(`[FlowLink] Emparejado con ${peer.name} (${peer.address})`);
    if (changed) this.emit('peer', peer ? { ...peer } : null);
  }
}

module.exports = { FlowLink };
