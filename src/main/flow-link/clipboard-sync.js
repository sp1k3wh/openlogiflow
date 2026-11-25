/**
 * Lectura/escritura del portapapeles para Flow OSS (proceso main de Electron ≥ 45,
 * API asíncrona clipboard.read()/write() con ClipboardItem).
 *
 * Texto, HTML, imagen (PNG) y archivos copiados:
 *  - Archivos se leen de text/uri-list (Linux: Nautilus; Windows: Explorador).
 *  - Linux: se escriben como x-special/gnome-copied-files + text/uri-list (Nautilus pega).
 *  - Windows: se escriben con PowerShell Set-Clipboard (lista de archivos CF_HDROP).
 */
const { clipboard, ClipboardItem } = require('electron');
const { execFile } = require('child_process');
const crypto = require('crypto');
const { fileURLToPath, pathToFileURL } = require('url');

const isWin = process.platform === 'win32';
const OS_FMT = (f) => `electron application/osclipboard;format="${f}"`;

function ps(script) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { windowsHide: true, timeout: 15000, maxBuffer: 8 << 20 },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

function parseUriList(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l.startsWith('file:'))
    .map((l) => { try { return fileURLToPath(l); } catch { return null; } })
    .filter(Boolean);
}

async function getText(item, type) {
  if (!item.types.includes(type)) return null;
  try {
    const v = await item.getType(type);
    return typeof v === 'string' ? v : await v.text();
  } catch { return null; }
}

async function getBytes(item, type) {
  if (!item.types.includes(type)) return null;
  try {
    const v = await item.getType(type);
    return Buffer.from(typeof v === 'string' ? v : await v.arrayBuffer());
  } catch { return null; }
}

/** Foto del portapapeles actual. hash identifica el contenido para no reenviarlo. */
async function snapshot() {
  let items = [];
  try { items = await clipboard.read(); } catch {}
  const item = items[0];
  let text = '', html = '', image = null, files = [];
  if (item) {
    const uris = (await getText(item, 'text/uri-list')) || (await getText(item, OS_FMT('x-special/gnome-copied-files')));
    files = parseUriList(uris);
    if (!files.length) {
      text = (await getText(item, 'text/plain')) || '';
      html = (await getText(item, 'text/html')) || '';
      if (!text) image = await getBytes(item, 'image/png');
    }
  }
  const h = crypto.createHash('sha256');
  h.update(text); h.update('\0'); h.update(html); h.update('\0');
  if (image) h.update(image);
  for (const f of files) h.update(`\0${f}`);
  return { text, html, image, files, hash: h.digest('hex'), empty: !text && !html && !image && !files.length };
}

/** Pone en el portapapeles lo recibido del otro equipo */
async function apply({ text, html, image, files }) {
  if (files && files.length) {
    if (isWin) {
      const list = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(',');
      await ps(`Set-Clipboard -LiteralPath ${list}`);
      return;
    }
    const uris = files.map((f) => pathToFileURL(f).href);
    await clipboard.write([new ClipboardItem({
      'x-special/gnome-copied-files': new Blob([['copy', ...uris].join('\n')], { type: 'x-special/gnome-copied-files' }),
      'text/uri-list': new Blob([uris.join('\r\n')], { type: 'text/uri-list' }),
    })]);
    return;
  }
  if (image) {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([image], { type: 'image/png' }) })]);
    return;
  }
  if (text || html) {
    const data = { 'text/plain': text || '' };
    if (html) data['text/html'] = html;
    await clipboard.write([new ClipboardItem(data)]);
  }
}

/** Hash de lo que hay ahora (para no devolver lo recibido como "nuevo") */
async function currentHash() {
  return (await snapshot()).hash;
}

module.exports = { snapshot, apply, currentHash, parseUriList };
