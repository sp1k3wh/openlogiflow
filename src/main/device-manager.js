const fs = require('fs');
const HID = require('node-hid');
const { EventEmitter } = require('events');

/**
 * DeviceManager — escanea y gestiona dispositivos Logitech conectados.
 * Reemplaza el backend C++ de Logi Options+ (logioptionsplus_agent.exe).
 *
 * En Linux usa node-hid que accede a /dev/hidraw* vía libusb.
 */
class DeviceManager extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map();
    this.scanInterval = null;
    this.vendorId = 0x046D; // Logitech vendor ID principal
    this.supportedPids = this.getSupportedPIDs();
  }

  /** Dispositivos conocidos (PID en minúsculas) */
  getSupportedPIDs() {
    return {
      '0x1701': { name: 'MX Master', type: 'mouse' },
      '0x1982': { name: 'MX Anywhere 2', type: 'mouse' },
      '0x1983': { name: 'MX Master 3', type: 'mouse' },
      '0x2150': { name: 'MX Master 3S', type: 'mouse' },
      '0x2201': { name: 'MX Anywhere 3', type: 'mouse' },
      '0x23bd': { name: 'MX Vertical', type: 'mouse' },
      // Dispositivos detrás de un receptor Unifying (PID inalámbrico)
      '0x4041': { name: 'MX Master', type: 'mouse' },
      '0x4060': { name: 'MX Master 2S', type: 'mouse' },
      '0x4069': { name: 'MX Master 2S', type: 'mouse' },
      '0x406a': { name: 'MX Anywhere 2S', type: 'mouse' },
      '0x4063': { name: 'MX Anywhere 2', type: 'mouse' },
      '0x4072': { name: 'MX Anywhere 2', type: 'mouse' },
      '0x4082': { name: 'MX Master 3', type: 'mouse' },
      '0x408a': { name: 'MX Vertical', type: 'mouse' },
      '0x1990': { name: 'MX Keys', type: 'keyboard' },
      '0x2205': { name: 'MX Keys S', type: 'keyboard' },
      '0x1b10': { name: 'MX Mechanical', type: 'keyboard' },
      '0x4089': { name: 'MX Keys', type: 'keyboard' },
      '0x408b': { name: 'MX Keys', type: 'keyboard' },
      // Receptores
      '0x106c': { name: 'Bluetooth Receiver', type: 'receiver' },
      '0xc52b': { name: 'Unifying Receiver', type: 'receiver' },
      '0xc532': { name: 'Unifying Receiver', type: 'receiver' },
      '0xc548': { name: 'Logi Bolt Receiver', type: 'receiver' },
      '0x1b04': { name: 'Logi Bolt USB Receiver', type: 'receiver' },
      '0x1b06': { name: 'Wireless Receiver', type: 'receiver' },
      '0x1b07': { name: 'Logi Bolt', type: 'receiver' },
      '0x40a2': { name: 'Universal Receiver', type: 'receiver' },
    };
  }

  /** Nombre real según el kernel (HID_NAME en sysfs); node-hid dice "USB Receiver" para todo */
  readSysfsName(hidPath) {
    const m = /\/dev\/(hidraw\d+)$/.exec(hidPath || '');
    if (!m) return null;
    try {
      const uevent = fs.readFileSync(`/sys/class/hidraw/${m[1]}/device/uevent`, 'utf8');
      const name = /^HID_NAME=(.*)$/m.exec(uevent);
      return name ? name[1].trim() : null;
    } catch {
      return null;
    }
  }

  guessType(entries, name) {
    if (/receiver/i.test(name)) return 'receiver';
    if (/keyboard|keys/i.test(name)) return 'keyboard';
    if (/mouse|master|anywhere|vertical|trackball|lift/i.test(name)) return 'mouse';
    const usages = entries.filter((e) => e.usagePage === 1).map((e) => e.usage);
    if (usages.includes(2)) return 'mouse';
    if (usages.includes(6)) return 'keyboard';
    return 'device';
  }

  /** Versión serializable para IPC (sin handles nativos) */
  toPublic(dev) {
    const { hidHandle, pollInterval, ...rest } = dev;
    return {
      ...rest,
      productName: rest.name,
      deviceType: rest.type,
      connectedAt: rest.connectedAt?.toISOString?.() ?? rest.connectedAt,
      lastSeen: rest.lastSeen?.toISOString?.() ?? rest.lastSeen,
    };
  }

  /** Escanea todos los dispositivos HID conectados */
  async scanDevices() {
    try {
      // node-hid da una entrada por usage (Linux) o por colección HID (Windows, con
      // rutas distintas para el mismo aparato): agrupar por dispositivo físico
      const byPath = new Map();
      for (const d of HID.devices()) {
        if (d.vendorId !== this.vendorId) continue;
        const group = process.platform === 'win32' ? `${d.productId}-${d.serialNumber || ''}` : d.path;
        if (!byPath.has(group)) byPath.set(group, []);
        byPath.get(group).push(d);
      }

      const seen = new Set();
      const added = [];
      const removed = [];

      for (const [, entries] of byPath) {
        const device = entries[0];
        const hidPath = device.path;
        const key = `${device.vendorId}-${device.productId}-${hidPath}`;
        seen.add(key);
        if (this.devices.has(key)) {
          this.devices.get(key).lastSeen = new Date();
          continue;
        }

        const pidHex = `0x${device.productId.toString(16).padStart(4, '0')}`;
        const known = this.supportedPids[pidHex];
        const cleanSys = this.readSysfsName(hidPath)?.replace(/^Logitech\s+/i, '');
        const generic = !cleanSys || /^USB Receiver$/i.test(cleanSys);
        const name = (generic ? known?.name : cleanSys) || cleanSys
          || device.product || `Logitech ${pidHex}`;
        const type = known?.type || this.guessType(entries, name);

        this.devices.set(key, {
          key, name, type,
          known: Boolean(known),
          vendorId: device.vendorId,
          productId: device.productId,
          path: hidPath,
          serialNumber: device.serialNumber,
          interface: device.interface,
          hidHandle: null, // se abre bajo demanda
          connectedAt: new Date(),
        });
        added.push(key);
        console.log(`[DeviceManager] Detectado: ${name} (${pidHex}, ${type}) en ${hidPath}`);
      }

      for (const [key, dev] of this.devices) {
        if (seen.has(key)) continue;
        this.closeHandle(dev);
        this.devices.delete(key);
        removed.push(key);
      }

      if (added.length > 0 || removed.length > 0) {
        this.emit('devices-changed', { connected: added, disconnected: removed });
      }
    } catch (err) {
      console.error('[DeviceManager] Scan error:', err.message);
    }
    return this.getConnectedDevices();
  }

  openHandle(dev) {
    if (!dev.hidHandle) dev.hidHandle = new HID.HID(dev.path);
    return dev.hidHandle;
  }

  closeHandle(dev) {
    if (dev.pollInterval) clearInterval(dev.pollInterval);
    dev.pollInterval = null;
    try { dev.hidHandle?.close(); } catch {}
    dev.hidHandle = null;
  }

  /** Iniciar escaneo periódico */
  async start() {
    await this.scanDevices(); // Escaneo inicial
    this.scanInterval = setInterval(() => this.scanDevices(), 5000); // Cada 5s
    console.log('[DeviceManager] Started — scanning every 5s');
  }

  /** Detener escaneo */
  stop() {
    if (this.scanInterval) clearInterval(this.scanInterval);
    for (const [, dev] of this.devices) this.closeHandle(dev);
    this.devices.clear();
  }

  /** Obtener dispositivos conectados */
  getConnectedDevices() {
    return Array.from(this.devices.values()).map((d) => this.toPublic(d));
  }

  /** Enviar reporte HID a un dispositivo (para backlight, etc.) */
  async sendReport(deviceKey, reportId, data) {
    const dev = this.devices.get(deviceKey);
    if (!dev) throw new Error(`Device ${deviceKey} not found`);
    try {
      this.openHandle(dev).sendFeatureReport([reportId, ...data]);
    } catch (err) {
      console.error('[DeviceManager] Send report error:', err.message);
    }
  }

  /** Leer reporte de un dispositivo */
  async getReport(deviceKey, reportId) {
    const dev = this.devices.get(deviceKey);
    if (!dev) throw new Error(`Device ${deviceKey} not found`);
    try {
      return this.openHandle(dev).getFeatureReport(reportId, 64);
    } catch (err) {
      console.error('[DeviceManager] Get report error:', err.message);
      return null;
    }
  }

  /** Leer teclado — key events */
  readKeyboard(deviceKey, callback) {
    const dev = this.devices.get(deviceKey);
    if (!dev) return;

    // node-hid no es stream-based, usamos polling
    const pollInterval = setInterval(async () => {
      try {
        const report = this.openHandle(dev).readTimeout(0);
        if (report && callback) callback(report, dev);
      } catch {}
    }, 50);

    // Guardar interval para cleanup
    dev.pollInterval = pollInterval;
  }

  /** Leer mouse — movement/events */
  readMouse(deviceKey, callback) {
    const dev = this.devices.get(deviceKey);
    if (!dev) return;

    const pollInterval = setInterval(async () => {
      try {
        const report = this.openHandle(dev).readTimeout(0);
        if (report && callback) callback(report, dev);
      } catch {}
    }, 30); // Mouse polling más frecuente

    dev.pollInterval = pollInterval;
  }

  /** Leer eventos de botón extra (MX series tienen botones dedicados) */
  readExtraButtons(deviceKey, callback) {
    const dev = this.devices.get(deviceKey);
    if (!dev || dev.type !== 'mouse') return;

    // MX Master tiene report ID 1 para botones extra
    const pollInterval = setInterval(async () => {
      try {
        const report = this.openHandle(dev).readTimeout(0);
        if (report && report.length > 0 && callback) {
          callback(report, dev);
        }
      } catch {}
    }, 20);

    dev.pollInterval = pollInterval;
  }
}

module.exports = { DeviceManager };
