// Genera src/renderer/assets/icon.png (256) desde logo.svg usando Electron.
//   npx electron scripts/make-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const assets = path.join(__dirname, '../src/renderer/assets');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(assets, 'logo.svg'), 'utf8');
  for (const [name, size] of [['icon.png', 256]]) {
    const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true,
      webPreferences: { offscreen: true } });
    const html = `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}"></body></html>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 300));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    fs.writeFileSync(path.join(assets, name), img.resize({ width: size, height: size }).toPNG());
    console.log('ok', name, size);
    win.destroy();
  }
  app.quit();
});
