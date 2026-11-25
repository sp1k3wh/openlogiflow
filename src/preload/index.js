const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script — expone la API IPC al renderer.
 * Expone al renderer (contextIsolation) solo las funciones que la UI necesita.
 */
contextBridge.exposeInMainWorld('logiAPI', {
  // === Store/Settings ===
  getSettings: () => ipcRenderer.invoke('GET_SETTINGS'),
  setSettings: (settings) => ipcRenderer.invoke('SET_SETTINGS', settings),

  // === Window Management ===
  getWindowSize: () => ipcRenderer.invoke('GET_SIZE'),
  minimizeWindow: () => ipcRenderer.send('MINIMIZE'),
  closeWindow: () => ipcRenderer.send('CLOSE_WINDOW'),
  focusWindow: () => ipcRenderer.send('FOCUS'),

  // === Theme ===
  setTheme: (theme) => ipcRenderer.send('SET_THEME', theme),
  onThemeChanged: (cb) => ipcRenderer.on('THEME_CHANGED', (_, data) => cb(data)),

  // === Device Management ===
  connectAgent: () => ipcRenderer.invoke('CONNECT_AGENT'),
  getDeviceRecommendations: () => ipcRenderer.invoke('GET_DEVICE_RECOMMENDATIONS'),
  getMediaDeviceHash: (data) => ipcRenderer.invoke('GET_MEDIA_DEVICE_HASH', data),
  onDeviceChanged: (cb) => ipcRenderer.on('DEVICE_CHANGED', (_, data) => cb(data)),

  // === App Detection ===
  getActiveApp: () => ipcRenderer.invoke('GET_ACTIVE_APP'),
  onActiveAppChanged: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('ACTIVE_APP_CHANGED', handler);
    return () => ipcRenderer.removeListener('ACTIVE_APP_CHANGED', handler);
  },

  // === Feature Flags ===
  getFeatureFlags: () => ipcRenderer.invoke('GET_FEATURE_FLAGS'),

  // === Flow Services ===
  getFlowState: async () => {
    const flags = await ipcRenderer.invoke('GET_FEATURE_FLAGS');
    const connectedPeers = await ipcRenderer.invoke('GET_FLOW_PEERS');
    return { enabled: flags.flow, connectedPeers };
  },
  onFlowPeersUpdated: (cb) => {
    const handler = (_, peers) => cb(peers);
    ipcRenderer.on('FLOW_PEERS_UPDATED', handler);
    return () => ipcRenderer.removeListener('FLOW_PEERS_UPDATED', handler);
  },
  // Flow OSS (esta app en los dos equipos)
  getFlowLinkStatus: () => ipcRenderer.invoke('FLOWLINK_STATUS'),
  setFlowLinkCode: (code) => ipcRenderer.invoke('FLOWLINK_SET_CODE', code),
  setFlowLinkSide: (side) => ipcRenderer.invoke('FLOWLINK_SET_SIDE', side),
  setFlowLinkHost: (host) => ipcRenderer.invoke('FLOWLINK_SET_HOST', host),
  setFlowOptions: (o) => ipcRenderer.invoke('FLOWLINK_SET_OPTIONS', o),
  generatePairCode: () => ipcRenderer.invoke('FLOWLINK_GENERATE_CODE'),
  getAppSettings: () => ipcRenderer.invoke('APP_GET_SETTINGS'),
  setAppSettings: (s) => ipcRenderer.invoke('APP_SET_SETTINGS', s),
  onFlowLinkStatus: (cb) => {
    const handler = (_, s) => cb(s);
    ipcRenderer.on('FLOWLINK_STATUS', handler);
    return () => ipcRenderer.removeListener('FLOWLINK_STATUS', handler);
  },
  startFlowEdge: () => {
    // Iniciar detección de borde (para Flow)
    ipcRenderer.send('FLOW_START_EDGE');
  },
  stopFlowEdge: () => {
    ipcRenderer.send('FLOW_STOP_EDGE');
  },

  // === External Actions ===
  openExternal: (url) => ipcRenderer.send('OPEN_EXTERNAL', url),
  revealInFolder: (path) => ipcRenderer.send('REVEAL_IN_FOLDER', path),

  // === File Dialogs ===
  openDialog: (options) => ipcRenderer.invoke('OPEN_DIALOG', options),

  // === Logging ===
  logToFile: (level, message) => ipcRenderer.send('LOG_TO_FILE', level, message),

  // === Platform Info ===
  getPlatformInfo: () => ({
    isLinux: process.platform === 'linux',
    isMac: process.platform === 'darwin',
    isWindows: process.platform === 'win32',
  }),

  // === Device Control (backlight, DPI, etc.) ===
  sendDeviceReport: (deviceKey, reportId, data) => {
    return ipcRenderer.invoke('SEND_DEVICE_REPORT', deviceKey, reportId, data);
  },
  getDeviceReport: (deviceKey, reportId) => {
    return ipcRenderer.invoke('GET_DEVICE_REPORT', deviceKey, reportId);
  },

  // === Device List (polling) ===
  refreshDevices: () => ipcRenderer.invoke('REFRESH_DEVICES'),
});
