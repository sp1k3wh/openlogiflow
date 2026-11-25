/**
 * Protocolo propio de OpenFlow (v1). Ver docs/PROTOCOL.md.
 *
 * Paquete UDP de entrada:
 *   'L' 'F' ver(u8) | nonce(12) | AES-256-GCM(cuerpo) | tag(16)
 *   AAD = los 3 bytes de cabecera.
 *   cuerpo = tipo(u8) | sesión(u32) | seq(u32) | payload
 *
 * La llave sale del código de emparejamiento que el usuario escribe en los dos equipos.
 */
const crypto = require('crypto');

const VERSION = 1;
const DISCOVERY_PORT = 59880;
const INPUT_PORT = 59881;
const MAGIC = Buffer.from('LF');
const HEADER = Buffer.concat([MAGIC, Buffer.from([VERSION])]);

const MSG = {
  HELLO: 1,      // {id, name} — "sigo vivo" + identidad
  ENTER: 2,      // el cursor entra al receptor: {edge, pos}
  LEAVE: 3,      // el cursor sale del receptor: {edge, pos}
  MOVE: 4,       // {dx, dy}
  BUTTON: 5,     // {btn, down}
  WHEEL: 6,      // {v, h} en unidades de 1/120 de "muesca"
  KEY: 7,        // {code (evdev), down}
  RELEASE_ALL: 8,
  ACK: 10,       // {ref}: confirma el mensaje con ese seq (ENTER/LEAVE se reenvían hasta el ACK)
  KEYSTATE: 11,  // {codes}: teclas realmente presionadas ahora (el receptor suelta las demás)
  CONFIG: 9,     // JSON {peerSide, at, host}: dónde está el EMISOR visto desde el receptor
                 // y en qué canal del mouse (0..2) está el emisor
};

const EDGE = { LEFT: 0, RIGHT: 1, TOP: 2, BOTTOM: 3 };
const BTN = { LEFT: 1, RIGHT: 2, MIDDLE: 3, BACK: 4, FORWARD: 5 };

/** Lados de la pantalla por nombre (para la configuración y la UI) */
const SIDES = ['left', 'right', 'top', 'bottom'];
const SIDE_TO_EDGE = { left: EDGE.LEFT, right: EDGE.RIGHT, top: EDGE.TOP, bottom: EDGE.BOTTOM };
const OPPOSITE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

function deriveKey(code) {
  const clean = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6,}$/.test(clean)) throw new Error('El código debe tener al menos 6 dígitos');
  return crypto.scryptSync(clean, 'logi-flow-oss/v1', 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 << 20 });
}

/** Huella corta de la llave para saber, sin revelarla, si dos equipos usan el mismo código */
function keyCheck(key) {
  return crypto.createHmac('sha256', key).update('key-check').digest('hex').slice(0, 16);
}

function encodePayload(type, p = {}) {
  switch (type) {
    case MSG.HELLO: return Buffer.from(JSON.stringify({ id: p.id, name: p.name }));
    case MSG.CONFIG: return Buffer.from(JSON.stringify({ peerSide: p.peerSide, at: p.at, host: p.host }));
    case MSG.ACK: { const b = Buffer.alloc(4); b.writeUInt32BE(p.ref >>> 0, 0); return b; }
    case MSG.KEYSTATE: {
      const codes = (p.codes || []).slice(0, 32);
      const b = Buffer.alloc(1 + codes.length * 2);
      b.writeUInt8(codes.length, 0);
      codes.forEach((c, i) => b.writeUInt16BE(c, 1 + i * 2));
      return b;
    }
    case MSG.ENTER:
    case MSG.LEAVE: {
      const b = Buffer.alloc(5);
      b.writeUInt8(p.edge, 0);
      b.writeFloatBE(p.pos, 1);
      return b;
    }
    case MSG.MOVE: {
      const b = Buffer.alloc(4);
      b.writeInt16BE(clamp16(p.dx), 0);
      b.writeInt16BE(clamp16(p.dy), 2);
      return b;
    }
    case MSG.BUTTON: return Buffer.from([p.btn, p.down ? 1 : 0]);
    case MSG.WHEEL: {
      const b = Buffer.alloc(4);
      b.writeInt16BE(clamp16(p.v), 0);
      b.writeInt16BE(clamp16(p.h), 2);
      return b;
    }
    case MSG.KEY: {
      const b = Buffer.alloc(3);
      b.writeUInt16BE(p.code, 0);
      b.writeUInt8(p.down ? 1 : 0, 2);
      return b;
    }
    default: return Buffer.alloc(0);
  }
}

function decodePayload(type, b) {
  switch (type) {
    case MSG.HELLO:
    case MSG.CONFIG: return JSON.parse(b.toString('utf8'));
    case MSG.ENTER:
    case MSG.LEAVE: return { edge: b.readUInt8(0), pos: b.readFloatBE(1) };
    case MSG.MOVE: return { dx: b.readInt16BE(0), dy: b.readInt16BE(2) };
    case MSG.BUTTON: return { btn: b[0], down: b[1] === 1 };
    case MSG.WHEEL: return { v: b.readInt16BE(0), h: b.readInt16BE(2) };
    case MSG.KEY: return { code: b.readUInt16BE(0), down: b[2] === 1 };
    case MSG.ACK: return { ref: b.readUInt32BE(0) };
    case MSG.KEYSTATE: {
      const n = b.readUInt8(0);
      const codes = [];
      for (let i = 0; i < n && 1 + i * 2 + 1 < b.length; i++) codes.push(b.readUInt16BE(1 + i * 2));
      return { codes };
    }
    default: return {};
  }
}

function clamp16(n) {
  return Math.max(-32768, Math.min(32767, Math.round(n || 0)));
}

function seal(key, type, session, seq, payload) {
  const body = Buffer.alloc(9 + payload.length);
  body.writeUInt8(type, 0);
  body.writeUInt32BE(session >>> 0, 1);
  body.writeUInt32BE(seq >>> 0, 5);
  payload.copy(body, 9);

  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(HEADER);
  const ct = Buffer.concat([c.update(body), c.final()]);
  return Buffer.concat([HEADER, nonce, ct, c.getAuthTag()]);
}

/** Devuelve {type, session, seq, payload} o null si no es nuestro o no autentica */
function open(key, pkt) {
  if (pkt.length < 3 + 12 + 9 + 16) return null;
  if (!pkt.subarray(0, 3).equals(HEADER)) return null;
  const nonce = pkt.subarray(3, 15);
  const ct = pkt.subarray(15, pkt.length - 16);
  const tag = pkt.subarray(pkt.length - 16);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(HEADER);
    d.setAuthTag(tag);
    const body = Buffer.concat([d.update(ct), d.final()]);
    const type = body.readUInt8(0);
    return {
      type,
      session: body.readUInt32BE(1),
      seq: body.readUInt32BE(5),
      payload: decodePayload(type, body.subarray(9)),
    };
  } catch {
    return null;
  }
}

module.exports = {
  VERSION, DISCOVERY_PORT, INPUT_PORT, MSG, EDGE, BTN, SIDES, SIDE_TO_EDGE, OPPOSITE,
  deriveKey, keyCheck, encodePayload, seal, open,
};
