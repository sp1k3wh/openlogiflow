const { app, ipcMain, BrowserWindow, shell, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { DeviceManager } = require('./device-manager');
const crypto = require('crypto');
const os = require('os');

const fs = require('fs');

// Wayland no deja posicionar ventanas ni leer el cursor: el sensor de borde necesita
// XWayland. La opción debe ir en la línea de comandos (app.commandLine llega tarde),
// así que si falta, la app se relanza a sí misma con ella.
if (process.platform === 'linux'
  && (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland')
  && !process.argv.some((a) => a.startsWith('--ozone-platform'))
  && !process.env.OPENFLOW_NO_RELAUNCH) {
  app.relaunch({
    execPath: process.env.APPIMAGE || process.execPath,
    args: [...process.argv.slice(1), '--ozone-platform=x11'],
  });
  app.exit(0);
}

// Una sola instancia: el arranque automático y abrirla a mano no deben chocar (puertos UDP)
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
const START_HIDDEN = process.argv.includes('--hidden');
const APP_ID = 'io.github.openflow';
if (process.platform === 'win32') app.setAppUserModelId(APP_ID); // notificaciones de Windows
let tray = null;
let quitting = false;

// Log a archivo (en Windows no hay consola cuando arranca oculta)
{
  const logDir = path.join(app.getPath('userData'), 'logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  const logFile = path.join(logDir, 'main.log');
  try { if (fs.statSync(logFile).size > 2 * 1024 * 1024) fs.renameSync(logFile, logFile + '.1'); } catch {}
  for (const level of ['log', 'error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...a) => {
      orig(...a);
      try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : require('util').inspect(x))).join(' ')}\n`); } catch {}
    };
  }
}

// Migración: las versiones de desarrollo guardaban la configuración en "logitech-flow"
{
  const newFile = path.join(app.getPath('userData'), 'openflow.json');
  const oldFile = path.join(app.getPath('appData'), 'logitech-flow', 'logitech-flow.json');
  try {
    if (!fs.existsSync(newFile) && fs.existsSync(oldFile)) {
      fs.mkdirSync(path.dirname(newFile), { recursive: true });
      fs.copyFileSync(oldFile, newFile);
      console.log('[Config] Configuración anterior migrada a', newFile);
    }
  } catch (e) { console.error('[Config] Migración:', e.message); }
}

const store = new Store({ name: 'openflow', cwd: app.getPath('userData') });

// === Inicio con la sesión ===
/** Comando para arrancar esta misma app (instalada o desde el código fuente) */
function launchCommand() {
  const exe = process.env.APPIMAGE || process.execPath;
  const args = app.isPackaged ? [] : [app.getAppPath()];
  if (process.platform === 'linux') args.push('--ozone-platform=x11');
  // Sin el sandbox SUID (AppImage o build sin instalar) hay que conservar esta opción
  if (process.argv.includes('--no-sandbox')) args.push('--no-sandbox');
  return { exe, args };
}
const LINUX_AUTOSTART = path.join(os.homedir(), '.config', 'autostart', 'openflow.desktop');

function getStartOnLogin() {
  if (process.platform === 'win32') {
    const { exe, args } = launchCommand();
    return app.getLoginItemSettings({ path: exe, args: [...args, '--hidden'] }).openAtLogin;
  }
  return fs.existsSync(LINUX_AUTOSTART);
}

function setStartOnLogin(on) {
  const { exe, args } = launchCommand();
  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: on, path: exe, args: [...args, '--hidden'] });
    return getStartOnLogin();
  }
  if (!on) { try { fs.unlinkSync(LINUX_AUTOSTART); } catch {} return false; }
  const q = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  fs.mkdirSync(path.dirname(LINUX_AUTOSTART), { recursive: true });
  fs.writeFileSync(LINUX_AUTOSTART, [
    '[Desktop Entry]', 'Type=Application', 'Name=OpenFlow',
    'Comment=Inicia OpenFlow oculto en la bandeja',
    `Exec=${[exe, ...args, '--hidden'].map(q).join(' ')}`,
    `Icon=${app.isPackaged && !process.env.APPIMAGE && fs.existsSync('/usr/share/icons/hicolor') ? 'openflow' : path.join(__dirname, '../renderer/assets/icon.png')}`, 'Terminal=false', 'X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-Delay=5', '',
  ].join('\n'));
  return true;
}

let mainWindow = null;
let deviceManager = null;
let flowLink = null;     // FlowController (Flow OSS entre dos equipos con esta app)
let edgeSensor = null;
let flowLinkError = null;
let optionsPlusDiscovery = null; // escucha anuncios de Logi Options+ (informativo)

const FLOW_OPTION_KEYS = ['enabled', 'clipboard', 'files', 'keyboard'];
function getFlowOptions() {
  const o = { enabled: true, clipboard: true, files: true, keyboard: true, ...store.get('flowLink.options', {}) };
  o.downloadDir = path.join(app.getPath('downloads'), 'OpenFlow');
  return o;
}
function setFlowOptions(o = {}) {
  const cur = { enabled: true, clipboard: true, files: true, keyboard: true, ...store.get('flowLink.options', {}) };
  for (const k of FLOW_OPTION_KEYS) if (typeof o[k] === 'boolean') cur[k] = o[k];
  store.set('flowLink.options', cur);
  store.set('flow', cur.enabled);
  flowLink?.setOptions(cur);
  syncEdgeSensor();
  sendFlowLinkStatus();
  return flowLinkStatus();
}
/** El sensor de borde solo existe con el otro equipo presente y Flow activado */
function syncEdgeSensor() {
  if (!edgeSensor) return;
  const want = !!(flowLink?.peer) && getFlowOptions().enabled;
  if (want && !edgeSensor.win) edgeSensor.start();
  if (!want && edgeSensor.win) edgeSensor.stop();
}

// === IPC Channels (replicando los de Logi Options+) ===

function setupIPC() {
  // --- Store/Settings ---
  ipcMain.handle('GET_SETTINGS', () => store.store);
  ipcMain.handle('SET_SETTINGS', (_, settings) => {
    Object.entries(settings).forEach(([key, value]) => store.set(key, value));
  });

  // --- Window Management ---
  ipcMain.handle('GET_SIZE', () => {
    if (!mainWindow) return { appx: 0, appy: 0, wdth: 0, hght: 0 };
    const [x, y] = mainWindow.getBounds();
    const [w, h] = mainWindow.getSize();
    return { appx: x, appy: y, wdth: w, hght: h };
  });

  ipcMain.handle('GET_SIZE_CC', () => ({ appx: 0, appy: 0, wdth: 800, hght: 600 }));

  ipcMain.on('MINIMIZE', () => mainWindow?.minimize());
  ipcMain.on('CLOSE_WINDOW', () => mainWindow?.close());
  ipcMain.on('FOCUS', () => mainWindow?.focus());
  ipcMain.on('CLOSE_VIEW', () => {
    // Close any secondary view (CC, marketplace)
  });

  // --- Theme ---
  ipcMain.on('SET_THEME', (_, theme) => {
    mainWindow?.webContents.send('THEME_CHANGED', theme);
  });

  // --- Device Discovery ---
  ipcMain.handle('GET_DEVICE_RECOMMENDATIONS', async () => {
    const devices = deviceManager?.getConnectedDevices() || [];
    return devices.map(d => ({
      name: d.productName,
      type: d.deviceType,
      vendorId: d.vendorId.toString(16),
      productId: d.productId.toString(16),
      connected: true,
    }));
  });

  // Lista de dispositivos para la UI
  ipcMain.handle('REFRESH_DEVICES', async () => {
    if (!deviceManager) return [];
    return deviceManager.scanDevices();
  });
  ipcMain.handle('SEND_DEVICE_REPORT', (_, key, reportId, data) =>
    deviceManager?.sendReport(key, reportId, data));
  ipcMain.handle('GET_DEVICE_REPORT', (_, key, reportId) =>
    deviceManager?.getReport(key, reportId));

  ipcMain.handle('GET_MEDIA_DEVICE_HASH', async (_, data) => {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
  });

  // --- App Detection (base para Flow) ---
  ipcMain.handle('GET_ACTIVE_APP', async () => {
    // En Linux, detectar la app activa usando xdotool / Wayland protocols
    try {
      const { execSync } = require('child_process');
      // X11: get focused window
      const output = execSync('xdotool getwindowname 2>/dev/null || echo ""', { encoding: 'utf-8' }).trim();
      return { name: output, pid: null };
    } catch {
      return { name: '', pid: null };
    }
  });

  // --- Flow Services ---
  ipcMain.handle('GET_FEATURE_FLAGS', () => ({
    flow: getFlowOptions().enabled,
    analytics: store.get('analytics', true),
    sso: store.get('sso', true),
    update: store.get('update', true),
    backlight: store.get('backlight', true),
  }));

  // --- Deep Link ---
  ipcMain.handle('GET_INITIAL_DEEPLINK_URI', () => {
    const args = process.argv.filter(a => a.startsWith('--deeplink='));
    return args.length > 0 ? args[0].replace('--deeplink=', '') : null;
  });

  // --- External Actions ---
  ipcMain.on('OPEN_EXTERNAL', (_, url) => shell.openExternal(url));
  ipcMain.on('REVEAL_IN_FOLDER', (_, path) => shell.showItemInFolder(path));

  // --- File Dialogs ---
  ipcMain.handle('OPEN_DIALOG', async (_, options) => {
    const { dialog } = require('electron');
    return await dialog.showOpenDialog(mainWindow, options);
  });

  // --- Logging ---
  ipcMain.on('LOG_TO_FILE', (_, level, message) => {
    const fs = require('fs');
    const logDir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'app.log');
    const entry = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    fs.appendFileSync(logFile, entry);
  });

  // --- Device Events (emitidos desde DeviceManager) ---
  ipcMain.handle('CONNECT_AGENT', async () => {
    if (!deviceManager) {
      deviceManager = new DeviceManager();
      await deviceManager.start();
    }
    return { status: 'connected' };
  });

  ipcMain.on('NOTIFY_DEVICE_CHANGED', (_, data) => {
    mainWindow?.webContents.send('DEVICE_CHANGED', data);
  });

  // --- Flow Edge Detection ---
  ipcMain.handle('GET_WINDOW_SIZE', () => {
    const primary = screen.getPrimaryDisplay();
    return primary.workArea;
  });

  // Interruptor general de Flow (pestaña Ajustes / tarjeta "Cambio de Host")
  ipcMain.on('FLOW_START_EDGE', () => setFlowOptions({ enabled: true }));
  // Equipos con Logi Options+ en la red (solo informativo: su protocolo es cerrado)
  ipcMain.handle('GET_FLOW_PEERS', () => (optionsPlusDiscovery ? optionsPlusDiscovery.getPeers() : []));

  // --- Flow OSS (esta app en los dos equipos) ---
  ipcMain.handle('FLOWLINK_STATUS', () => flowLinkStatus());
  ipcMain.handle('FLOWLINK_SET_CODE', (_, code) => {
    const clean = String(code || '').replace(/\s+/g, '');
    if (!/^\d{6,}$/.test(clean)) return { ok: false, error: 'El código debe tener al menos 6 dígitos' };
    store.set('flowLink.code', clean);
    startFlowLink();
    return { ok: true, status: flowLinkStatus() };
  });

  ipcMain.handle('FLOWLINK_GENERATE_CODE', () => String(crypto.randomInt(0, 1e6)).padStart(6, '0'));

  ipcMain.handle('APP_GET_SETTINGS', () => ({
    startOnLogin: getStartOnLogin(),
    closeToTray: store.get('app.closeToTray', true),
    version: app.getVersion(),
  }));
  ipcMain.handle('APP_SET_SETTINGS', (_, s = {}) => {
    if (typeof s.closeToTray === 'boolean') store.set('app.closeToTray', s.closeToTray);
    if (typeof s.startOnLogin === 'boolean') {
      try { setStartOnLogin(s.startOnLogin); } catch (e) { console.error('[Autostart]', e.message); }
    }
    return { startOnLogin: getStartOnLogin(), closeToTray: store.get('app.closeToTray', true) };
  });

  ipcMain.handle('FLOWLINK_SET_HOST', (_, host) => {
    const h = host === 'auto' || host === null ? null : Number(host);
    if (!flowLink) { store.set('flowLink.manualHost', h); if (h !== null) store.set('flowLink.myHost', h); return { ok: true, status: flowLinkStatus() }; }
    return { ok: flowLink.setMyHost(h), status: flowLinkStatus() };
  });

  ipcMain.handle('FLOWLINK_SET_SIDE', (_, side) => {
    if (!flowLink) {
      store.set('flowLink.peerSide', side);
      store.set('flowLink.sideAt', Date.now());
      return { ok: true, status: flowLinkStatus() };
    }
    return { ok: flowLink.setPeerSide(side), status: flowLinkStatus() };
  });

  ipcMain.on('FLOW_STOP_EDGE', () => setFlowOptions({ enabled: false }));
  ipcMain.handle('FLOWLINK_SET_OPTIONS', (_, o) => setFlowOptions(o));


  // --- Device Events from DeviceManager → renderer ---
  if (deviceManager) {
    deviceManager.on('devices-changed', (data) => {
      mainWindow?.webContents.send('DEVICE_CHANGED', data);
    });
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    title: 'OpenFlow',
    icon: path.join(__dirname, '../renderer/assets/icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.once('ready-to-show', () => { if (!START_HIDDEN) mainWindow.show(); });

  // Cerrar la ventana no apaga Flow: la app sigue en la bandeja del sistema
  mainWindow.on('close', (e) => {
    if (quitting) return;
    if (!store.get('app.closeToTray', true)) { quitting = true; app.quit(); return; }
    e.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showMainWindow() {
  if (!mainWindow) createMainWindow();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '../renderer/assets/icon.png'))
    .resize({ width: process.platform === 'win32' ? 16 : 22 });
  tray = new Tray(img);
  tray.setToolTip('OpenFlow');
  const update = () => {
    const st = flowLinkStatus();
    const estado = !st.hasCode ? 'Flow sin configurar'
      : st.peer ? `Flow activo con ${st.peer.name}` : 'Flow desactivado (sin el otro equipo)';
    tray.setToolTip(`OpenFlow — ${estado}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: estado, enabled: false },
      { type: 'separator' },
      { label: 'Abrir OpenFlow', click: showMainWindow },
      { label: 'Salir', click: () => { quitting = true; app.quit(); } },
    ]));
  };
  update();
  tray.on('click', showMainWindow);
  setInterval(update, 3000);
}

app.on('second-instance', showMainWindow);
app.on('before-quit', () => { quitting = true; });

// Handle deep links (Linux)
app.on('open-url', (_, url) => {
  console.log('Deep link:', url);
});

app.whenReady().then(async () => {
  setupIPC();
  createMainWindow();
  try { createTray(); } catch (e) { console.error('[Tray]', e.message); }

  // Auto-start device manager
  deviceManager = new DeviceManager();
  deviceManager.on('devices-changed', (data) => {
    mainWindow?.webContents.send('DEVICE_CHANGED', data);
  });
  await deviceManager.start();

  startFlowLink();

  try {
    const { FlowDiscovery } = require('./flow-discovery');
    optionsPlusDiscovery = new FlowDiscovery();
    optionsPlusDiscovery.on('peers-changed', (peers) => mainWindow?.webContents.send('FLOW_PEERS_UPDATED', peers));
    optionsPlusDiscovery.on('error', () => {});
    optionsPlusDiscovery.start();
  } catch (e) { console.error('[Options+]', e.message); }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

/** Rectángulo que cubre todas las pantallas (para colocar el cursor al recibir control) */
function desktopBounds() {
  const ds = screen.getAllDisplays().map((d) => d.bounds);
  const x = Math.min(...ds.map((d) => d.x)), y = Math.min(...ds.map((d) => d.y));
  const r = Math.max(...ds.map((d) => d.x + d.width)), b = Math.max(...ds.map((d) => d.y + d.height));
  return { x, y, w: r - x, h: b - y };
}

function flowLinkStatus() {
  const base = { hasCode: !!store.get('flowLink.code'), peerSide: store.get('flowLink.peerSide', 'left') };
  if (flowLinkError) return { running: false, error: flowLinkError, ...base };
  if (!flowLink) return { running: false, ...base };
  return { running: true, hasCode: true, ...flowLink.status() };
}

function sendFlowLinkStatus() {
  mainWindow?.webContents.send('FLOWLINK_STATUS', flowLinkStatus());
}

function startFlowLink() {
  stopFlowLink();
  flowLinkError = null;
  const code = store.get('flowLink.code');
  if (!code) return sendFlowLinkStatus();

  let id = store.get('flowLink.id');
  if (!id) { id = crypto.randomUUID(); store.set('flowLink.id', id); }

  try {
    const { FlowController } = require('./flow-link/controller');
    flowLink = new FlowController({
      code, id, name: os.hostname(),
      peerAddress: store.get('flowLink.peerAddress', null),
      peerSide: store.get('flowLink.peerSide'),
      sideAt: store.get('flowLink.sideAt', 0),
      myHost: store.get('flowLink.myHost'),
      peerHost: store.get('flowLink.peerHost'),
      manualHost: store.get('flowLink.manualHost', null),
      screen: desktopBounds,
      clipboard: require('./flow-link/clipboard-sync'),
      options: getFlowOptions(),
    });
    flowLink.on('status', () => {
      sendFlowLinkStatus();
      syncEdgeSensor(); // sin el otro equipo (o con Flow apagado) se quita el sensor del borde
    });
    flowLink.on('files-received', ({ count, dir, from }) => {
      const { Notification } = require('electron');
      if (!Notification.isSupported()) return;
      const n = new Notification({
        title: 'OpenFlow',
        body: `${count} elemento(s) recibido(s) de ${from || 'el otro equipo'}. Ya están en el portapapeles: pega con Ctrl+V.`,
        icon: path.join(__dirname, '../renderer/assets/icon.png'),
      });
      n.on('click', () => shell.openPath(dir));
      n.show();
    });
    flowLink.on('config', ({ peerSide, sideAt, myHost, peerHost, manualHost }) => {
      store.set('flowLink.manualHost', manualHost);
      store.set('flowLink.peerSide', peerSide);
      store.set('flowLink.sideAt', sideAt);
      store.set('flowLink.myHost', myHost);
      store.set('flowLink.peerHost', peerHost);
      edgeSensor?.setSide(peerSide);
    });
    flowLink.start();

    if (process.platform === 'linux') {
      const { EdgeSensor } = require('./flow-link/edge-sensor');
      edgeSensor = new EdgeSensor({ side: flowLink.peerSide, onHit: (pos) => flowLink?.edgeHit(pos, 'borde') });
      syncEdgeSensor(); // se crea cuando aparezca el otro equipo
    }
  } catch (err) {
    console.error('[FlowLink] No se pudo iniciar:', err);
    flowLinkError = err.message;
    flowLink = null;
  }
  sendFlowLinkStatus();
}

function stopFlowLink() {
  try { edgeSensor?.stop(); } catch {}
  edgeSensor = null;
  try { flowLink?.stop(); } catch {}
  flowLink = null;
}

app.on('before-quit', () => { stopFlowLink(); optionsPlusDiscovery?.stop(); });

// Flow sigue corriendo en la bandeja aunque no haya ventanas
app.on('window-all-closed', () => {});

module.exports = { app, ipcMain, BrowserWindow, shell, screen, store, deviceManager };
