/**
 * Captura de entrada en Windows: lanza win-capture-helper.exe (hooks de bajo nivel
 * + Raw Input) y traduce sus eventos al mismo formato que LinuxCapture.
 * El .exe se compila la primera vez con el compilador de C# incluido en Windows.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { EventEmitter } = require('events');
const { scanToEvdev } = require('./keymap');

// En la app instalada el código va dentro de app.asar; PowerShell no puede leer de ahí,
// por eso el .cs se desempaqueta (asarUnpack en package.json).
const SRC = path.join(__dirname, 'win-capture-helper.cs')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function helperPath() {
  const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'logi-flow-oss');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = fs.statSync(SRC).mtimeMs.toFixed(0);
  return path.join(dir, `win-capture-helper-${stamp}.exe`);
}

function compile(exe, log) {
  log('[WinCapture] Compilando ayudante de captura…');
  const ps = `Add-Type -Path '${SRC.replace(/'/g, "''")}' -OutputAssembly '${exe.replace(/'/g, "''")}' ` +
    `-OutputType ConsoleApplication -ReferencedAssemblies System.Windows.Forms`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'pipe', windowsHide: true });
}

class WinCapture extends EventEmitter {
  constructor({ log = console.log } = {}) {
    super();
    this.log = log;
    this.grabbed = false;
    this.edge = null;
    this.devices = [{ name: 'Windows (hooks)' }]; // para status()
  }

  start() {
    this.stopped = false;
    this._spawn();
    // Si el ayudante deja de dar señales (latido "H" cada 15 s), reiniciarlo
    this.watchdog = setInterval(() => {
      if (this.proc && Date.now() - this.lastBeat > 40000) {
        this.log('[WinCapture] El ayudante no responde: lo reinicio');
        try { this.proc.kill(); } catch {}
      }
    }, 10000);
    return 1;
  }

  _spawn() {
    const exe = helperPath();
    if (!fs.existsSync(exe)) compile(exe, this.log);
    this.lastBeat = Date.now();
    this.proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc.on('exit', (c) => {
      this.log(`[WinCapture] Ayudante terminó (${c})`);
      this.proc = null;
      if (!this.stopped) setTimeout(() => { if (!this.stopped) this._spawn(); }, 1000);
    });
    this.proc.stderr.on('data', (d) => this.log(`[WinCapture] ${d.toString().trim()}`));
    readline.createInterface({ input: this.proc.stdout }).on('line', (l) => this._onLine(l));
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    try { this.proc?.stdin.write('quit\n'); this.proc?.kill(); } catch {}
    this.proc = null;
  }

  _cmd(c) { try { this.proc?.stdin.write(c + '\n'); } catch {} }

  /** Qué borde vigilar mientras el control es local */
  watchEdge(side) {
    this.edge = side;
    if (!this.grabbed) this._cmd(side ? `watch ${side}` : 'off');
  }

  grab(on) {
    if (this.grabbed === on) return;
    this.grabbed = on;
    this._cmd(on ? 'capture' : (this.edge ? `watch ${this.edge}` : 'off'));
  }

  /** Solo teclado: bloquear y reenviar el teclado (el mouse cambió al otro equipo) */
  keysOnly(on) {
    this.grabbed = on;
    this._cmd(on ? 'keys' : (this.edge ? `watch ${this.edge}` : 'off'));
  }

  _onLine(line) {
    this.lastBeat = Date.now();
    const p = line.trim().split(' ');
    switch (p[0]) {
      case 'READY':
        this.log('[WinCapture] Hooks instalados');
        // Al (re)iniciar, recuperar el modo en que estábamos
        if (this.grabbed) this._cmd('keys');
        else if (this.edge) this._cmd(`watch ${this.edge}`);
        break;
      case 'H': break;
      case 'E': this.emit('edge', parseFloat(p[1])); break;
      case 'R': this.emit('reclaim'); break;
      case 'M': this.emit('move', { dx: +p[1], dy: +p[2] }); break;
      case 'B': this.emit('button', { btn: +p[1], down: p[2] === '1' }); break;
      case 'W': this.emit('wheel', { v: +p[1], h: +p[2] }); break;
      case 'K': {
        const code = scanToEvdev(+p[1], p[2] === '1');
        if (code) this.emit('key', { code, down: p[3] === '1', repeat: false });
        break;
      }
    }
  }
}

module.exports = { WinCapture };
