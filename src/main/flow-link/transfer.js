/**
 * Canal TCP cifrado para portapapeles y archivos (Flow OSS).
 *
 * Cada transferencia es una conexión nueva al puerto 59882. Todo va en frames:
 *   u32 BE largo | nonce(12) | AES-256-GCM(contenido) | tag(16)    AAD = "LFC1"
 * Frame 1: JSON {v, ts, rnd, kind:'clipboard', text?, html?, image?, files:[{rel,size}]}
 * Luego:   la imagen (PNG) en un frame, y cada archivo en frames de hasta 1 MiB, en orden.
 * Último:  JSON {done:true}
 *
 * Un frame que no autentica corta la conexión. Se rechazan cabeceras con más de
 * 2 minutos de antigüedad o repetidas (evita reenvíos de una captura).
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const PORT = 59882;
const AAD = Buffer.from('LFC1');
const CHUNK = 1 << 20;
const MAX_FRAME = CHUNK + 1024;

function seal(key, buf) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  const body = Buffer.concat([nonce, ct, c.getAuthTag()]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}

function unseal(key, body) {
  const nonce = body.subarray(0, 12);
  const tag = body.subarray(body.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(AAD);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body.subarray(12, body.length - 16)), d.final()]);
}

/** Lee frames de un socket y los entrega descifrados, uno a uno (con backpressure) */
function frameReader(sock, key, onFrame, onError) {
  let buf = Buffer.alloc(0);
  let busy = Promise.resolve();
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len > MAX_FRAME || len < 28) return onError(new Error('frame inválido'));
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let plain;
      try { plain = unseal(key, body); } catch { return onError(new Error('frame no autentica')); }
      sock.pause();
      busy = busy.then(() => onFrame(plain)).then(() => sock.resume(), onError);
    }
  });
}

/** Nombre/ruta relativa seguros: sin "..", sin absolutas, sin caracteres raros de Windows */
function safeRel(rel) {
  const parts = String(rel).split(/[\\/]+/).filter((p) => p && p !== '.' && p !== '..');
  if (!parts.length) return null;
  return parts.map((p) => p.replace(/[<>:"|?*\x00-\x1f]/g, '_').slice(0, 200)).join(path.sep);
}

class TransferServer extends EventEmitter {
  /**
   * @param {Buffer} key
   * @param {function} destDir      () => carpeta donde guardar archivos recibidos
   * @param {function} isPeer       (address) => true si es el equipo emparejado
   * @param {number} maxBytes       tamaño máximo aceptado de archivos por transferencia
   */
  constructor({ key, destDir, isPeer, maxBytes, log = console.log }) {
    super();
    Object.assign(this, { key, destDir, isPeer, maxBytes, log });
    this.seen = new Map();
  }

  start() {
    this.server = net.createServer((sock) => this._handle(sock));
    this.server.on('error', (e) => this.log(`[Transfer] servidor: ${e.message}`));
    this.server.listen(PORT, '0.0.0.0');
  }

  stop() { try { this.server?.close(); } catch {} }

  _handle(sock) {
    const addr = (sock.remoteAddress || '').replace(/^::ffff:/, '');
    if (!this.isPeer(addr)) { sock.destroy(); return; }
    sock.setTimeout(60000, () => sock.destroy());

    let header = null;
    let image = null;
    let fileIdx = 0, fileLeft = 0, out = null, dir = null, received = 0, total = 0;
    const saved = [];

    const fail = (e) => {
      try { out?.close(); } catch {}
      if (dir && e) fs.rm(dir, { recursive: true, force: true }, () => {});
      if (e) this.log(`[Transfer] Recepción cancelada: ${e.message}`);
      sock.destroy();
    };
    const openNext = () => {
      while (fileIdx < header.files.length && header.files[fileIdx].size === 0) {
        fs.writeFileSync(path.join(dir, header.files[fileIdx].safe), '');
        fileIdx++;
      }
      if (fileIdx >= header.files.length) return;
      const f = header.files[fileIdx];
      fs.mkdirSync(path.dirname(path.join(dir, f.safe)), { recursive: true });
      out = fs.openSync(path.join(dir, f.safe), 'w');
      fileLeft = f.size;
    };

    frameReader(sock, this.key, async (plain) => {
      if (!header) {
        const h = JSON.parse(plain.toString('utf8'));
        const age = Math.abs(Date.now() - h.ts);
        if (h.v !== 1 || age > 120000 || this.seen.has(h.rnd)) throw new Error('cabecera vieja o repetida');
        this.seen.set(h.rnd, Date.now());
        for (const [k, t] of this.seen) if (Date.now() - t > 300000) this.seen.delete(k);
        header = h;
        header.files = (h.files || []).map((f) => ({ ...f, safe: safeRel(f.rel) })).filter((f) => f.safe);
        total = header.files.reduce((a, f) => a + f.size, 0);
        if (total > this.maxBytes) throw new Error(`archivos demasiado grandes (${(total / 1e6).toFixed(0)} MB)`);
        if (header.files.length) {
          const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
          dir = path.join(this.destDir(), stamp);
          for (let n = 2; fs.existsSync(dir); n++) dir = path.join(this.destDir(), `${stamp}-${n}`);
          fs.mkdirSync(dir, { recursive: true });
          this.emit('progress', { received: 0, total, files: header.files.length });
          openNext();
        }
        return;
      }
      if (header.image && !image) { image = plain; return; }
      if (fileIdx < header.files.length) {
        fs.writeSync(out, plain);
        fileLeft -= plain.length;
        received += plain.length;
        if (fileLeft <= 0) {
          fs.closeSync(out); out = null;
          saved.push(path.join(dir, header.files[fileIdx].safe));
          fileIdx++;
          openNext();
        }
        this.emit('progress', { received, total, files: header.files.length });
        return;
      }
      const end = JSON.parse(plain.toString('utf8'));
      if (end.done) {
        // Lo que se pega: los elementos de primer nivel (carpetas o archivos sueltos)
        const top = [...new Set(header.files.map((f) => f.safe.split(path.sep)[0]))].map((t) => path.join(dir, t));
        this.emit('clipboard', { text: header.text, html: header.html, image, files: top, dir, bytes: total });
        sock.end();
      }
    }, fail);
    sock.on('error', () => fail());
  }
}

/** Recorre archivos y carpetas → [{abs, rel, size}] */
function collectFiles(paths, limitCount = 5000) {
  const out = [];
  const walk = (abs, rel) => {
    if (out.length >= limitCount) return;
    let st;
    try { st = fs.statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) walk(path.join(abs, name), path.join(rel, name));
    } else if (st.isFile()) {
      out.push({ abs, rel, size: st.size });
    }
  };
  for (const p of paths) walk(p, path.basename(p));
  return out;
}

/** Envía portapapeles (+ archivos) al otro equipo. Devuelve una promesa. */
function sendClipboard({ key, address, text, html, image, files = [], log = console.log, onProgress }) {
  return new Promise((resolve, reject) => {
    const header = {
      v: 1, ts: Date.now(), rnd: crypto.randomBytes(12).toString('hex'), kind: 'clipboard',
      text: text || undefined, html: html || undefined, image: !!image,
      files: files.map((f) => ({ rel: f.rel, size: f.size })),
    };
    const total = files.reduce((a, f) => a + f.size, 0);
    const sock = net.connect(PORT, address);
    sock.setTimeout(60000, () => sock.destroy(new Error('tiempo agotado')));
    sock.on('error', reject);
    sock.on('close', () => resolve());
    sock.on('connect', async () => {
      try {
        const write = (buf) => (sock.write(seal(key, buf)) ? null : new Promise((r) => sock.once('drain', r)));
        await write(Buffer.from(JSON.stringify(header)));
        if (image) await write(image);
        let sent = 0;
        for (const f of files) {
          if (f.size === 0) continue;
          const fd = fs.openSync(f.abs, 'r');
          try {
            const chunk = Buffer.alloc(Math.min(CHUNK, f.size));
            let left = f.size;
            while (left > 0) {
              const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, left), null);
              if (n <= 0) throw new Error(`no se pudo leer ${f.rel}`);
              await write(Buffer.from(chunk.subarray(0, n)));
              left -= n; sent += n;
              onProgress?.({ sent, total });
            }
          } finally { fs.closeSync(fd); }
        }
        await write(Buffer.from(JSON.stringify({ done: true })));
        sock.end();
      } catch (e) {
        log(`[Transfer] Envío cancelado: ${e.message}`);
        sock.destroy();
        reject(e);
      }
    });
  });
}

module.exports = { TransferServer, sendClipboard, collectFiles, safeRel, PORT };
