const dgram = require('dgram');
const crypto = require('crypto');
const os = require('os');
const { EventEmitter } = require('events');

/**
 * FlowDiscovery — escucha los anuncios de Logi Options+ Flow en la LAN.
 *
 * Options+ (logioptionsplus_agent.exe) anuncia su presencia con un broadcast
 * UDP a <red>.255:59870 cada ~5 s. Formato observado (2026-11-24):
 *
 *   [0:32]   ID de grupo (fijo para un mismo equipo/cuenta)
 *   [32:36]  u32 BE  largo del resto
 *   [36:38]  u16 BE  largo del nonce  (12)
 *   [38:42]  u32 BE  largo de los datos cifrados
 *   [42:44]  u16 BE  largo del tag    (16)
 *   luego    nonce | datos cifrados | tag        → AES-GCM
 *
 * Sin la llave solo sabemos QUIÉN anuncia (IP + ID de grupo). Si se pasa
 * `key` (Buffer de 16/24/32 bytes) se intenta descifrar el contenido.
 *
 * El agente de Options+ además escucha en TCP 59869 y UDP 59871; todavía no
 * conocemos ese protocolo, por eso los equipos encontrados se marcan con
 * `handoffSupported: false`.
 */
const DISCOVERY_PORT = 59870;
const SESSION_TCP_PORT = 59869;
const HEADER_LEN = 44;
const PEER_TTL_MS = 20000; // se considera perdido tras 4 anuncios sin oír

function parseAnnouncement(buf) {
  if (buf.length < HEADER_LEN) return null;
  const restLen = buf.readUInt32BE(32);
  const nonceLen = buf.readUInt16BE(36);
  const ctLen = buf.readUInt32BE(38);
  const tagLen = buf.readUInt16BE(42);
  const total = HEADER_LEN + nonceLen + ctLen + tagLen;
  if (restLen !== buf.length - 36 || total !== buf.length) return null;
  if (nonceLen !== 12 || tagLen !== 16) return null;

  let off = HEADER_LEN;
  const nonce = buf.subarray(off, (off += nonceLen));
  const ciphertext = buf.subarray(off, (off += ctLen));
  const tag = buf.subarray(off, (off += tagLen));
  return { groupId: buf.subarray(0, 32), nonce, ciphertext, tag, raw: buf };
}

/** Prueba AES-GCM con distintas opciones de AAD. Devuelve {plaintext, aad} o null. */
function tryDecrypt(pkt, key) {
  const algo = { 16: 'aes-128-gcm', 24: 'aes-192-gcm', 32: 'aes-256-gcm' }[key.length];
  if (!algo) return null;
  const aads = [
    ['none', null],
    ['groupId', pkt.raw.subarray(0, 32)],
    ['groupId+len', pkt.raw.subarray(0, 36)],
    ['header', pkt.raw.subarray(0, HEADER_LEN)],
    ['lengths', pkt.raw.subarray(36, HEADER_LEN)],
  ];
  for (const [name, aad] of aads) {
    try {
      const d = crypto.createDecipheriv(algo, key, pkt.nonce);
      if (aad) d.setAAD(aad);
      d.setAuthTag(pkt.tag);
      const plaintext = Buffer.concat([d.update(pkt.ciphertext), d.final()]);
      return { plaintext, aad: name };
    } catch {
      /* siguiente opción */
    }
  }
  return null;
}

function localAddresses() {
  const set = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4') set.add(a.address);
  }
  return set;
}

class FlowDiscovery extends EventEmitter {
  constructor({ key = null, port = DISCOVERY_PORT } = {}) {
    super();
    this.key = key;
    this.port = port;
    this.socket = null;
    this.peers = new Map(); // address -> peer
    this.sweepTimer = null;
    this.ownAddresses = localAddresses();
  }

  start() {
    if (this.socket) return;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
    this.socket.on('error', (err) => {
      console.error(`[FlowDiscovery] Error en UDP ${this.port}:`, err.message);
      this.emit('error', err);
    });
    this.socket.bind(this.port, '0.0.0.0', () => {
      console.log(`[FlowDiscovery] Escuchando anuncios de Options+ en UDP ${this.port}`);
    });

    this.sweepTimer = setInterval(() => this._sweep(), 5000);
  }

  stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    if (this.socket) {
      try { this.socket.close(); } catch { /* ya cerrado */ }
      this.socket = null;
    }
    this.peers.clear();
  }

  getPeers() {
    return Array.from(this.peers.values()).map((p) => ({ ...p }));
  }

  _onMessage(msg, rinfo) {
    if (this.ownAddresses.has(rinfo.address)) return;
    const pkt = parseAnnouncement(msg);
    if (!pkt) return; // no es un anuncio de Flow

    const now = Date.now();
    const groupId = pkt.groupId.toString('hex');
    const existing = this.peers.get(rinfo.address);
    const peer = existing || {
      hostname: rinfo.address,
      address: rinfo.address,
      name: `Options+ (${rinfo.address})`,
      protocol: 'logi-optionsplus',
      port: SESSION_TCP_PORT,
      groupId,
      firstSeen: now,
      announcements: 0,
      encrypted: true,
      decrypted: false,
      handoffSupported: false,
    };

    peer.lastSeen = now;
    peer.announcements += 1;
    peer.groupId = groupId;
    peer.lastPayloadBytes = pkt.ciphertext.length;

    if (this.key) {
      const r = tryDecrypt(pkt, this.key);
      if (r) {
        peer.decrypted = true;
        peer.aad = r.aad;
        this.emit('announcement-decrypted', { address: rinfo.address, ...r });
        console.log(`[FlowDiscovery] Descifrado de ${rinfo.address} (aad=${r.aad}):`,
          r.plaintext.toString('utf8'));
      }
    }

    this.peers.set(rinfo.address, peer);
    if (!existing) {
      console.log(`[FlowDiscovery] Nuevo equipo Options+: ${rinfo.address} grupo=${groupId.slice(0, 16)}…`);
      this.emit('peers-changed', this.getPeers());
    }
  }

  _sweep() {
    const now = Date.now();
    let changed = false;
    for (const [addr, p] of this.peers) {
      if (now - p.lastSeen > PEER_TTL_MS) {
        this.peers.delete(addr);
        console.log(`[FlowDiscovery] Equipo perdido: ${addr}`);
        changed = true;
      }
    }
    if (changed) this.emit('peers-changed', this.getPeers());
  }
}

module.exports = { FlowDiscovery, parseAnnouncement, tryDecrypt, DISCOVERY_PORT, SESSION_TCP_PORT };
