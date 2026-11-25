/**
 * Sensor de borde (solo Electron, Linux).
 * Wayland no deja preguntar la posición global del cursor, así que ponemos una
 * ventana transparente de 1 px pegada al borde donde está el otro equipo
 * (izquierda/derecha/arriba/abajo). Cuando el cursor la toca, avisa con la
 * posición relativa a lo largo de ese borde (0..1).
 *
 * Requiere que Electron corra con --ozone-platform=x11 (XWayland) para poder
 * posicionar la ventana; el proceso main relanza Electron con esa opción.
 */
const { BrowserWindow, screen } = require('electron');

const HTML = `<!doctype html><html><head><style>
html,body{margin:0;width:100%;height:100%;background:rgba(0,0,0,0.01);cursor:default}
</style></head><body><script>
let inside=false;
const horizontal = innerWidth > innerHeight;
function report(e){
  const p = horizontal ? e.clientX/Math.max(innerWidth,1) : e.clientY/Math.max(innerHeight,1);
  document.title='edge:'+p.toFixed(4)+':'+Date.now();
}
document.addEventListener('mouseenter',e=>{inside=true;report(e)});
document.addEventListener('mousemove',e=>{ if(!inside){inside=true;report(e)} });
document.addEventListener('mouseleave',()=>{inside=false;document.title='out:'+Date.now()});
</script></body></html>`;

class EdgeSensor {
  constructor({ onHit, side = 'right', log = console.log }) {
    this.onHit = onHit;
    this.log = log;
    this.win = null;
    this.armed = true;
    this.side = side;
  }

  setSide(side) {
    if (side === this.side) return;
    this.side = side;
    if (this.win) { this.stop(); this._create(); }
  }

  start() {
    if (this.win) return;
    this._create();
    if (this._rebuild) return;
    this._rebuild = () => { if (this.win) { this.stop(); this._create(); } };
    screen.on('display-metrics-changed', this._rebuild);
    screen.on('display-added', this._rebuild);
    screen.on('display-removed', this._rebuild);
  }

  /** Rectángulo de 1 px sobre el borde exterior del escritorio en el lado configurado */
  _rect() {
    const ds = screen.getAllDisplays().map((d) => d.bounds);
    const pick = {
      right: (a, d) => (d.x + d.width > a.x + a.width ? d : a),
      left: (a, d) => (d.x < a.x ? d : a),
      bottom: (a, d) => (d.y + d.height > a.y + a.height ? d : a),
      top: (a, d) => (d.y < a.y ? d : a),
    }[this.side];
    const b = ds.reduce(pick);
    switch (this.side) {
      case 'left': return { x: b.x, y: b.y, width: 1, height: b.height };
      case 'top': return { x: b.x, y: b.y, width: b.width, height: 1 };
      case 'bottom': return { x: b.x, y: b.y + b.height - 1, width: b.width, height: 1 };
      default: return { x: b.x + b.width - 1, y: b.y, width: 1, height: b.height };
    }
  }

  _create() {
    const r = this._rect();
    this.win = new BrowserWindow({
      ...r,
      frame: false, transparent: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: false, hasShadow: false, show: false,
      alwaysOnTop: true, type: 'dock',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true);
    this.win.on('page-title-updated', (ev, title) => {
      ev.preventDefault();
      if (title.startsWith('out:')) { this.armed = true; return; }
      if (title.startsWith('edge:') && this.armed) {
        this.armed = false; // no repetir hasta que el cursor salga del sensor
        const pos = parseFloat(title.split(':')[1]);
        this.onHit(Number.isFinite(pos) ? pos : 0.5);
      }
    });
    this.win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
    this.win.once('ready-to-show', () => {
      this.win.showInactive();
      this.win.setBounds(r);
      const real = this.win.getBounds();
      this.log(`[EdgeSensor] Borde ${this.side} en x=${real.x} y=${real.y} ${real.width}x${real.height}`);
    });
  }

  /** Tras volver de Windows el cursor está sobre el sensor: esperar a que salga */
  disarm() { this.armed = false; }

  stop() {
    try { this.win?.destroy(); } catch {}
    this.win = null;
  }
}

module.exports = { EdgeSensor };
