/**
 * Renderer — controla la UI y se comunica con el main via logiAPI.
 * Replica la experiencia de Logi Options+ para Linux.
 */

(function () {
  'use strict';

  // === State ===
  let devices = [];

  // === DOM refs ===
  const navItems = document.querySelectorAll('.nav-item');
  const tabs = document.querySelectorAll('.tab');
  const deviceListEl = document.getElementById('device-list');
  const refreshBtn = document.getElementById('refresh-devices');

  // === Tab Navigation ===
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(n => n.classList.remove('active'));
      tabs.forEach(t => t.classList.remove('active'));
      item.classList.add('active');
      const tabId = `tab-${item.dataset.tab}`;
      document.getElementById(tabId).classList.add('active');
    });
  });

  // === Device List Rendering ===
  function renderDevices(devList) {
    if (!devList || devList.length === 0) {
      deviceListEl.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" width="64" height="64"><path d="M20 6h-3.18L15 4H9L7.18 6H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM9 5h6l.5 1h-7l.5-1z"/></svg>
          <p>No hay dispositivos Logitech conectados</p>
          <small>Conecta un mouse o teclado Logitech para comenzar</small>
        </div>`;
      return;
    }

    const icons = { mouse: '🖱️', keyboard: '⌨️', receiver: '📡' };

    deviceListEl.innerHTML = devList.map(d => `
      <div class="device-card" data-key="${d.key}">
        <div class="device-card-header">
          <div class="device-icon">${icons[d.deviceType] || '🔌'}</div>
          <div>
            <div class="device-name">${d.productName}</div>
            <div class="device-type">${d.deviceType}</div>
          </div>
        </div>
        <div class="device-card-footer">
          <div class="device-status">
            <span class="status-dot"></span> Conectado
          </div>
          <small style="color: var(--text-muted)">${d.serialNumber || 'S/N desconocido'}</small>
        </div>
      </div>
    `).join('');

    // Attach click handlers to cards
    deviceListEl.querySelectorAll('.device-card').forEach(card => {
      card.addEventListener('click', () => showDeviceDetail(card.dataset.key));
    });
  }

  // === Device Detail Panel ===
  function showDeviceDetail(key) {
    const dev = devices.find(d => d.key === key);
    if (!dev) return;

    const detailEl = document.createElement('div');
    detailEl.className = 'device-detail';
    detailEl.innerHTML = `
      <button class="btn btn-close" id="close-device-detail">&times;</button>
      <h2 style="margin-bottom: 24px">${dev.productName}</h2>
      <div style="display: flex; flex-direction: column; gap: 16px">
        <div class="settings-group">
          <h3>Información del Dispositivo</h3>
          <div class="setting-item"><label>Tipo</label><span>${dev.deviceType}</span></div>
          <div class="setting-item"><label>Vendor ID</label><span>0x${(dev.vendorId || '').toString(16)}</span></div>
          <div class="setting-item"><label>Product ID</label><span>0x${(dev.productId || '').toString(16)}</span></div>
          <div class="setting-item"><label>Ruta HID</label><span>${dev.path}</span></div>
          <div class="setting-item"><label>Serial</label><span>${dev.serialNumber || 'N/A'}</span></div>
        </div>
      </div>
    `;

    detailEl.querySelector('#close-device-detail').addEventListener('click', () => {
      detailEl.remove();
    });

    document.getElementById('tab-devices').appendChild(detailEl);
  }

  // === Flow Tab Logic (Flow OSS) ===
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let linkStatus = null;
  let optionsPlusPeers = [];

  /** Tarjeta de estado de arriba */
  function updateFlowUI() {
    const dot = document.getElementById('flow-status-dot');
    const title = document.getElementById('flow-status-title');
    const desc = document.getElementById('flow-status-desc');
    const st = linkStatus;
    const opts = (st && st.options) || {};
    const set = (active, t, d) => { dot.className = 'status-indicator' + (active ? ' active' : ''); title.textContent = t; desc.textContent = d; };

    if (!st || !st.hasCode) return set(false, 'Flow sin configurar', 'Escribe el código de emparejamiento abajo, el mismo en los dos equipos');
    if (st.error) return set(false, 'Flow con error', st.error);
    if (opts.enabled === false) return set(false, 'Flow desactivado', 'Activa "Cambio de Host" para usar el mouse en los dos equipos');
    if (!st.peer) return set(false, 'Flow en espera', 'No se encuentra el otro equipo: ¿está encendido y con OpenLogiFlow abierto?');

    let d = st.state === 'local' ? `Conectado con ${st.peer.name} · el cursor está aquí`
      : `Conectado con ${st.peer.name} · el cursor está en ${st.peer.name}`;
    if (st.forwardingKeys) d += ' · teclado reenviado';
    if (st.transfer) d += ` · ${st.transfer.dir === 'in' ? 'recibiendo' : 'enviando'} ${st.transfer.files ? st.transfer.files + ' archivo(s) ' : ''}${st.transfer.pct}%`;
    else if (st.lastTransfer) d += ` · ${st.lastTransfer}`;
    set(true, 'Flow activo', d);
  }

  /** "Computadoras en la Red": equipo emparejado, equipos con otro código y equipos con Options+ */
  function renderNetwork() {
    const listEl = document.getElementById('peers-list');
    const st = linkStatus || {};
    const rows = [];
    if (st.peer) {
      const where = st.state === 'local' ? 'cursor aquí' : 'cursor allá';
      rows.push({ icon: '🖥️', name: st.peer.name, sub: `${st.peer.address} · OpenLogiFlow · canal ${(st.peerHost ?? 0) + 1}`, status: `Conectado (${where})`, ok: true });
    }
    if (st.mismatch && (!st.peer || st.mismatch.address !== st.peer.address)) {
      rows.push({ icon: '🔒', name: st.mismatch.name, sub: `${st.mismatch.address} · OpenLogiFlow`, status: 'Otro código de emparejamiento', ok: false });
    }
    for (const p of optionsPlusPeers) {
      if (st.peer && p.address === st.peer.address) continue; // es el mismo equipo
      rows.push({ icon: '💻', name: p.name || p.address, sub: `${p.address} · Logi Options+`, status: 'Options+ (no compatible)', ok: false });
    }
    if (!rows.length) {
      listEl.innerHTML = '<div class="empty-state small"><p>No se encontraron otros equipos con OpenLogiFlow</p></div>';
      return;
    }
    listEl.innerHTML = rows.map((r) => `
      <div class="peer-item">
        <div class="peer-icon">${r.icon}</div>
        <div class="peer-info">
          <div class="peer-name">${esc(r.name)}</div>
          <div class="peer-hostname">${esc(r.sub)}</div>
        </div>
        <div class="device-status" style="${r.ok ? '' : 'opacity:.7'}">
          <span class="status-dot" style="${r.ok ? '' : 'background: var(--text-muted)'}"></span> ${esc(r.status)}
        </div>
      </div>`).join('');
  }

  /** Interruptores de la pestaña Flow y de Ajustes */
  const OPTION_TOGGLES = {
    'flow-edge-toggle': 'enabled',
    'flow-enabled': 'enabled',
    'flow-clipboard-toggle': 'clipboard',
    'flow-files-toggle': 'files',
    'flow-mouse-toggle': 'keyboard',
  };
  function syncToggles(st) {
    const opts = (st && st.options) || {};
    for (const [id, key] of Object.entries(OPTION_TOGGLES)) {
      const el = document.getElementById(id);
      if (el && typeof opts[key] === 'boolean') el.checked = opts[key];
    }
  }
  for (const [id, key] of Object.entries(OPTION_TOGGLES)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('change', async (e) => {
      const st = await logiAPI.setFlowOptions({ [key]: e.target.checked });
      if (st) renderFlowLink(st);
    });
  }

  // === Ajustes generales: inicio con la sesión y bandeja ===
  function loadSettings() {
    logiAPI.getAppSettings().then((s) => {
      document.getElementById('start-on-login').checked = !!s.startOnLogin;
      document.getElementById('minimize-to-tray').checked = s.closeToTray !== false;
      document.getElementById('app-version').textContent = s.version || '';
    }).catch((err) => console.error('[Renderer] Ajustes:', err));
  }
  document.getElementById('start-on-login').addEventListener('change', async (e) => {
    const r = await logiAPI.setAppSettings({ startOnLogin: e.target.checked });
    e.target.checked = !!r.startOnLogin;
  });
  document.getElementById('minimize-to-tray').addEventListener('change', (e) => {
    logiAPI.setAppSettings({ closeToTray: e.target.checked });
  });

  // === Event Bindings ===
  refreshBtn.addEventListener('click', () => {
    logiAPI.refreshDevices()
      .then(devList => {
        devices = devList.map(d => ({ ...d, key: `${d.vendorId}-${d.productId}-${d.path}` }));
        renderDevices(devices);
      })
      .catch(err => console.error('[Renderer] Refresh failed:', err));
  });

  // Equipos con Logi Options+ (informativo)
  logiAPI.onFlowPeersUpdated((peers) => { optionsPlusPeers = peers || []; renderNetwork(); });
  logiAPI.getFlowState().then((s) => { optionsPlusPeers = s.connectedPeers || []; renderNetwork(); }).catch(() => {});

  // === Device Change Listener ===
  logiAPI.onDeviceChanged((data) => {
    console.log('[Renderer] Device changed:', data);
    logiAPI.refreshDevices()
      .then(devList => {
        devices = devList.map(d => ({ ...d, key: `${d.vendorId}-${d.productId}-${d.path}` }));
        renderDevices(devices);
      })
      .catch(err => console.error('[Renderer] Refresh after change:', err));
  });

  // === Active App Listener (for Flow context awareness) ===
  logiAPI.onActiveAppChanged((app) => {
    console.log('[Renderer] Active app changed:', app.name);
    // In Flow mode, this could trigger clipboard sync or focus handoff
  });

  // === Window Controls ===
  // Electron titlebar buttons (if using custom frame)
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'w') {
      logiAPI.closeWindow();
    }
    if (e.altKey && e.key === 'h') {
      logiAPI.minimizeWindow();
    }
  });

  // === Flow OSS (esta app en los dos equipos) ===
  function renderFlowLink(st) {
    const title = document.getElementById('flowlink-title');
    const detail = document.getElementById('flowlink-detail');
    if (!title || !st) return;
    linkStatus = st;
    updateFlowUI();
    renderNetwork();
    syncToggles(st);
    renderLayout(st);
    renderHost(st);
    if (st.error) {
      title.textContent = 'Error al iniciar';
      detail.textContent = st.error;
      return;
    }
    if (!st.hasCode) {
      title.textContent = 'Sin configurar';
      detail.textContent = 'Escribe el código de emparejamiento para empezar';
      return;
    }
    const states = { local: 'Cursor aquí', remote: 'Cursor en el otro equipo' };
    const channels = '';
    if (st.peer) {
      title.textContent = `${st.peer.name} · ${states[st.state] || st.state}`;
      detail.textContent = st.peer.address + channels;
    } else {
      title.textContent = 'Flow desactivado: el otro equipo no está disponible';
      detail.textContent = st.mismatch
        ? `${st.mismatch.name} (${st.mismatch.address}) tiene otro código`
        : 'Abre la app en el otro equipo con el mismo código';
    }
    if (st.injectError) detail.textContent += ` · No puede recibir control: ${st.injectError}`;
    if (st.permissionErrors && st.permissionErrors.length) {
      detail.textContent += ' · Faltan permisos en Linux: ejecuta "sudo sh install-permissions.sh" (ver README)';
    }
  }

  // --- Disposición de pantallas ---
  const SIDE_NAMES = { left: 'Izquierda', right: 'Derecha', top: 'Arriba', bottom: 'Abajo' };
  const EDGE_HINT = { left: 'borde izquierdo', right: 'borde derecho', top: 'borde superior', bottom: 'borde inferior' };
  function renderHost(st) {
    const sel = document.getElementById('flowlink-host');
    const info = document.getElementById('flowlink-host-info');
    if (!sel || !st) return;
    if (document.activeElement !== sel) sel.value = Number.isInteger(st.manualHost) ? String(st.manualHost) : 'auto';
    const parts = [];
    if (Number.isInteger(st.myHost)) parts.push(`usando canal ${st.myHost + 1}${Number.isInteger(st.manualHost) ? '' : ' (detectado)'}`);
    if (Number.isInteger(st.peerHost)) parts.push(`${st.peer ? st.peer.name : 'el otro equipo'}: canal ${st.peerHost + 1}`);
    info.textContent = parts.join(' · ');
  }
  document.getElementById('flowlink-host').addEventListener('change', async (e) => {
    const r = await logiAPI.setFlowLinkHost(e.target.value);
    if (r && r.status) renderFlowLink(r.status);
  });

  function renderLayout(st) {
    const side = st && st.peerSide;
    const peerName = (st && st.peer && st.peer.name) || 'Otro equipo';
    document.querySelectorAll('.layout-slot').forEach((el) => {
      const s = el.dataset.side;
      const sel = s === side;
      el.classList.toggle('selected', sel);
      el.textContent = '';
      el.append(sel ? `🖥️ ${peerName}` : SIDE_NAMES[s]);
      if (sel) {
        const hint = document.createElement('span');
        hint.className = 'edge-hint';
        hint.textContent = `por el ${EDGE_HINT[s]}`;
        el.append(hint);
      }
    });
  }
  document.querySelectorAll('.layout-slot').forEach((el) => {
    el.addEventListener('click', async () => {
      if (el.classList.contains('selected')) return;
      const r = await logiAPI.setFlowLinkSide(el.dataset.side);
      if (r && r.status) renderFlowLink(r.status);
    });
  });

  document.getElementById('flowlink-generate').addEventListener('click', async () => {
    const input = document.getElementById('flowlink-code');
    input.value = await logiAPI.generatePairCode();
    input.focus();
    document.getElementById('flowlink-detail').textContent = 'Escribe este mismo código en el otro equipo y pulsa Guardar en los dos';
  });

  document.getElementById('flowlink-save').addEventListener('click', async () => {
    const input = document.getElementById('flowlink-code');
    const r = await logiAPI.setFlowLinkCode(input.value);
    if (!r.ok) {
      document.getElementById('flowlink-detail').textContent = r.error;
      return;
    }
    input.value = '';
    renderFlowLink(r.status);
  });
  logiAPI.onFlowLinkStatus(renderFlowLink);
  logiAPI.getFlowLinkStatus().then(renderFlowLink).catch(() => {});

  // === Init ===
  loadSettings();
  // Auto-refresh devices on startup
  logiAPI.refreshDevices()
    .then(devList => {
      devices = devList.map(d => ({ ...d, key: `${d.vendorId}-${d.productId}-${d.path}` }));
      renderDevices(devices);
    })
    .catch(() => {}); // Non-fatal if no HID access yet

})();
