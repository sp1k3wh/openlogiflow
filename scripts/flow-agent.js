#!/usr/bin/env node
/**
 * Agente de OpenFlow sin interfaz (Windows, o Linux para pruebas).
 *   node scripts/flow-agent.js --code 123456 [--side left|right|top|bottom] [--peer <ip-del-otro-equipo>]
 * --side = dónde está el otro equipo visto desde este. Se guarda y se sincroniza con
 * el otro equipo (si lo cambias en la app de Linux, este agente lo adopta).
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FlowController } = require('../src/main/flow-link/controller');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
  return acc;
}, []));

const code = args.code || process.env.FLOW_CODE;
if (!code) { console.error('Falta --code <6+ dígitos>'); process.exit(1); }

const cfgFile = path.join(os.homedir(), '.logi-flow-oss.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch {}
if (!cfg.id) cfg.id = crypto.randomUUID();
if (args.side) { cfg.peerSide = args.side; cfg.sideAt = Date.now(); }
const save = () => { try { fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2)); } catch {} };
save();

const log = (m) => console.log(`${new Date().toISOString().slice(11, 23)} ${m}`);
const ctl = new FlowController({
  code, id: cfg.id, name: os.hostname(), peerAddress: args.peer || null,
  peerSide: cfg.peerSide, sideAt: cfg.sideAt || 0, myHost: cfg.myHost, peerHost: cfg.peerHost, log,
});
ctl.on('config', (c) => { Object.assign(cfg, c); save(); });
ctl.on('status', (s) => log(`[estado] cursor ${s.state === 'local' ? 'aqui' : 'alla'}${s.forwardingKeys ? ' (teclado reenviado)' : ''} - ${s.peer ? 'con ' + s.peer.name : 'sin equipo'} - otro equipo: ${s.peerSide} - canales ${s.myHost + 1}/${s.peerHost + 1}`));
ctl.start();
log(`Iniciado. Otro equipo: ${ctl.peerSide}. Ctrl+C para salir.`);

const bye = () => { ctl.stop(); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
