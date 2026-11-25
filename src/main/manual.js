/**
 * Ventana con el manual de uso (docs/MANUAL.md), sin depender de internet.
 * Incluye un conversor Markdown → HTML mínimo (títulos, párrafos, listas, tablas,
 * bloques de código, citas, negritas, cursivas, código y enlaces).
 */
const { BrowserWindow, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const MANUAL = path.join(__dirname, '../../docs/MANUAL.md');
let win = null;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  const codes = [];
  s = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u.replace(/"/g, '%22')}">${t}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

function slug(t) {
  return t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function markdownToHtml(md) {
  const lines = md.replace(/\r/g, '').split('\n');
  const out = [];
  const toc = [];
  let i = 0;
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}/.test(l) && l.includes('-');
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) {
      const level = h[1].length, text = h[2], id = slug(text);
      if (level === 2) toc.push({ id, text });
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i++; continue;
    }
    if (/^---+\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (l.startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^>\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (!l.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\||---+\s*$|\s*([-*]|\d+\.)\s+)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return { html: out.join('\n'), toc };
}

const CSS = `
:root{--bg:#1a1a2e;--card:#1c1c3a;--fg:#e8e8e8;--muted:#a0a0b0;--accent:#7986cb;--border:rgba(255,255,255,.1)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Ubuntu,sans-serif}
nav{position:fixed;top:0;left:0;bottom:0;width:230px;overflow:auto;padding:20px 14px;background:var(--card);border-right:1px solid var(--border)}
nav b{display:block;margin-bottom:10px;color:var(--accent)}
nav a{display:block;padding:4px 6px;color:var(--muted);text-decoration:none;border-radius:6px;font-size:13.5px}
nav a:hover{background:rgba(255,255,255,.06);color:var(--fg)}
main{margin-left:230px;padding:24px 40px 60px;max-width:900px}
h1{color:var(--accent);margin-top:0}
h2{margin-top:36px;padding-bottom:6px;border-bottom:1px solid var(--border)}
h3{margin-top:24px}
a{color:var(--accent)}
code{background:rgba(255,255,255,.08);padding:1px 5px;border-radius:4px;font-size:.92em}
pre{background:#11112a;padding:12px 14px;border-radius:8px;overflow:auto;border:1px solid var(--border)}
pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;margin:12px 0}
th,td{border:1px solid var(--border);padding:7px 10px;text-align:left;vertical-align:top}
th{background:rgba(255,255,255,.05)}
blockquote{margin:12px 0;padding:8px 14px;border-left:3px solid var(--accent);background:rgba(121,134,203,.08);color:var(--muted)}
hr{border:none;border-top:1px solid var(--border);margin:28px 0}
@media (max-width:760px){nav{display:none}main{margin-left:0;padding:16px}}
`;

function buildPage() {
  let md;
  try { md = fs.readFileSync(MANUAL, 'utf8'); } catch { md = '# Manual\n\nNo se encontró docs/MANUAL.md.'; }
  const { html, toc } = markdownToHtml(md);
  const nav = toc.map((t) => `<a href="#${t.id}">${esc(t.text)}</a>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Manual de OpenLogiFlow</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>${CSS}</style></head><body><nav><b>Contenido</b>${nav}</nav><main>${html}</main></body></html>`;
}

function openManual(iconPath) {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 980, height: 760, title: 'Manual de OpenLogiFlow', icon: iconPath, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false },
  });
  // Enlaces externos en el navegador; los anclas internas se quedan en la ventana
  win.webContents.on('will-navigate', (e, url) => {
    if (/^https?:/.test(url)) { e.preventDefault(); shell.openExternal(url); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(buildPage()).toString('base64'));
  win.on('closed', () => { win = null; });
}

module.exports = { openManual, markdownToHtml, buildPage };
