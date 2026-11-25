/**
 * Códigos de tecla evdev (Linux, usados en el protocolo) ↔ scan codes set 1 (Windows).
 * Del 1 al 88 coinciden; el resto se mapea aquí como [scan, extendido].
 */
const EXTRA_KEYS = {
  86: [0x56, false],  // tecla <> (ISO, junto a la Z)
  87: [0x57, false], 88: [0x58, false],     // F11, F12
  89: [0x73, false],  // RO
  96: [0x1c, true],   // KP Enter
  97: [0x1d, true],   // Ctrl derecho
  98: [0x35, true],   // KP /
  99: [0x37, true],   // Impr Pant
  100: [0x38, true],  // AltGr
  102: [0x47, true], 103: [0x48, true], 104: [0x49, true], // Inicio, ↑, RePág
  105: [0x4b, true], 106: [0x4d, true],                    // ←, →
  107: [0x4f, true], 108: [0x50, true], 109: [0x51, true], // Fin, ↓, AvPág
  110: [0x52, true], 111: [0x53, true],                    // Insert, Supr
  113: [0x20, true], 114: [0x2e, true], 115: [0x30, true], // Silencio, Vol-, Vol+
  124: [0x7d, false], // Yen
  125: [0x5b, true], 126: [0x5c, true], 127: [0x5d, true], // Win izq/der, Menú
  163: [0x19, true], 164: [0x22, true], 165: [0x10, true], // Siguiente, Play/Pausa, Anterior
  183: [0x64, false], 184: [0x65, false], 185: [0x66, false], 186: [0x67, false], // F13-F16
};

function evdevToScan(code) {
  if (EXTRA_KEYS[code]) return EXTRA_KEYS[code];
  if (code >= 1 && code <= 88) return [code, false];
  return null;
}

const SCAN_TO_EVDEV = new Map();
for (let c = 1; c < 256; c++) {
  const sc = evdevToScan(c);
  if (sc) SCAN_TO_EVDEV.set(`${sc[0]}:${sc[1] ? 1 : 0}`, c);
}
// Bloq Num en Windows llega como 0x45 extendido; evdev KEY_NUMLOCK = 69
SCAN_TO_EVDEV.set('69:1', 69);

function scanToEvdev(scan, ext) {
  return SCAN_TO_EVDEV.get(`${scan}:${ext ? 1 : 0}`) || null;
}

module.exports = { evdevToScan, scanToEvdev };
