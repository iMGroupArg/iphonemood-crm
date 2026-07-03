const CONDICION_ITEMS = [
  // Estética
  { id:'rayones_pantalla',  grupo:'estetica',  label:'Rayones en pantalla' },
  { id:'rayones_marco',     grupo:'estetica',  label:'Rayones en marco' },
  { id:'rayones_tapa',      grupo:'estetica',  label:'Rayones en tapa trasera' },
  { id:'vidrio_pantalla',   grupo:'estetica',  label:'Vidrio roto (pantalla)' },
  { id:'vidrio_trasero',    grupo:'estetica',  label:'Vidrio roto (trasero)' },
  { id:'carcasa_doblada',   grupo:'estetica',  label:'Carcasa doblada' },
  // Funcional
  { id:'face_id',           grupo:'funcional', label:'Face ID / Touch ID' },
  { id:'camara_frontal',    grupo:'funcional', label:'Cámara frontal' },
  { id:'camara_trasera',    grupo:'funcional', label:'Cámara trasera' },
  { id:'altavoz',           grupo:'funcional', label:'Altavoz / auricular' },
  { id:'microfono',         grupo:'funcional', label:'Micrófono' },
  { id:'carga',             grupo:'funcional', label:'Puerto de carga' },
  { id:'boton_volumen',     grupo:'funcional', label:'Botón de volumen' },
  { id:'boton_encendido',   grupo:'funcional', label:'Botón de encendido' },
  { id:'vibrador',          grupo:'funcional', label:'Vibrador' },
  { id:'bateria',           grupo:'funcional', label:'Condición de batería' },
  { id:'wifi_bt',           grupo:'funcional', label:'WiFi / Bluetooth' },
  { id:'señal_sim',         grupo:'funcional', label:'Señal / SIM' },
];

const Reparaciones = {
  currentId: null,
  ESTADOS: ['ingresado','diagnosticado','en_reparacion','listo','entregado'],
  ESTADO_LABEL: {
    ingresado:'Ingresado', diagnosticado:'Diagnosticado', en_reparacion:'En reparación',
    listo:'Listo', entregado:'Entregado', rechazado:'Rechazado', no_reparable:'No reparable'
  },
  ESTADO_CLASS: {
    ingresado:'b-gray', diagnosticado:'b-purple', en_reparacion:'b-blue',
    listo:'b-green', entregado:'b-teal', rechazado:'b-red', no_reparable:'b-red'
  },
  ESTADO_COLOR: {
    ingresado:'var(--gray)', diagnosticado:'var(--purple)', en_reparacion:'var(--blue)',
    listo:'var(--green)', entregado:'var(--teal)', rechazado:'var(--red)', no_reparable:'var(--red)'
  },
  BOLSILLOS: ['ARS cash','ARS transferencia','USD cash','USD transferencia','USDT'],

  // ── Shell ─────────────────────────────────────────────
  render() {
    const c = document.createElement('div');
    c.className = 'rep-shell';
    c.style.cssText = 'display:flex;flex:1;overflow:hidden;';
    c.innerHTML = `
      <div class="rep-list-panel" style="width:300px;min-width:300px;border-right:1px solid var(--border);display:flex;flex-direction:column;background:var(--bg-secondary)">
        <div style="padding:14px 14px 10px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div>
            <div style="font-size:13px;font-weight:700">Órdenes</div>
            <div id="rep-list-count" style="font-size:11px;color:var(--text-secondary)"></div>
          </div>
          <button class="btn btn-sm btn-primary" onclick="Reparaciones.openNewForm()">➕ Nueva</button>
        </div>
        <div style="padding:8px 10px;border-bottom:1px solid var(--border)">
          <input type="text" id="rep-search" placeholder="Buscar por cliente, equipo, ID…" oninput="Reparaciones.renderList()"
            style="width:100%;font-size:12px;padding:6px 10px;background:var(--bg-tertiary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
        </div>
        <div style="padding:6px 10px;border-bottom:1px solid var(--border);display:flex;gap:4px;overflow-x:auto;-webkit-overflow-scrolling:touch">
          <button class="rep-filter-btn rep-filter-active" data-filter="all" onclick="Reparaciones.setFilter('all',this)" style="font-size:10px;padding:3px 9px;border-radius:14px;border:1px solid var(--blue);background:var(--blue-light);color:var(--blue);cursor:pointer;white-space:nowrap;font-weight:600">Todas</button>
          <button class="rep-filter-btn" data-filter="activas" onclick="Reparaciones.setFilter('activas',this)" style="font-size:10px;padding:3px 9px;border-radius:14px;border:1px solid var(--border-strong);background:var(--bg-tertiary);color:var(--text-secondary);cursor:pointer;white-space:nowrap">Activas</button>
          <button class="rep-filter-btn" data-filter="listo" onclick="Reparaciones.setFilter('listo',this)" style="font-size:10px;padding:3px 9px;border-radius:14px;border:1px solid var(--border-strong);background:var(--bg-tertiary);color:var(--text-secondary);cursor:pointer;white-space:nowrap">Listas</button>
          <button class="rep-filter-btn" data-filter="entregado" onclick="Reparaciones.setFilter('entregado',this)" style="font-size:10px;padding:3px 9px;border-radius:14px;border:1px solid var(--border-strong);background:var(--bg-tertiary);color:var(--text-secondary);cursor:pointer;white-space:nowrap">Entregadas</button>
        </div>
        <div style="flex:1;overflow-y:auto" id="rep-list"></div>
      </div>
      <div class="rep-detail-panel" style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;background:var(--bg-elevated)">
        <button class="btn btn-sm rep-back-btn" onclick="Reparaciones.backToList()" style="display:none;margin:10px 14px 0;align-self:flex-start">← Órdenes</button>
        <div id="rep-detail" style="flex:1;overflow-y:auto;padding:18px 20px"></div>
      </div>
    `;
    this._filter = 'all';
    setTimeout(() => {
      if (!this.currentId && State.reparaciones.length) this.currentId = State.reparaciones[0].id;
      this.renderList();
      this.renderDetail();
      this.syncMobileView(false);
      this.bindResizeListener();
    }, 0);
    return c;
  },

  _filter: 'all',
  setFilter(f, btn) {
    this._filter = f;
    document.querySelectorAll('.rep-filter-btn').forEach(b => {
      const active = b === btn;
      b.style.borderColor = active ? 'var(--blue)' : 'var(--border-strong)';
      b.style.background  = active ? 'var(--blue-light)' : 'var(--bg-tertiary)';
      b.style.color       = active ? 'var(--blue)' : 'var(--text-secondary)';
      b.style.fontWeight  = active ? '600' : '400';
    });
    this.renderList();
  },

  _diasDesde(fechaStr) {
    if (!fechaStr || fechaStr === 'Hoy') return 0;
    const parts = fechaStr.split('/');
    if (parts.length < 2) return 0;
    const now = new Date();
    const d = new Date(now.getFullYear(), parseInt(parts[1])-1, parseInt(parts[0]));
    return Math.max(0, Math.floor((now - d) / 86400000));
  },

  // ── Lista ─────────────────────────────────────────────
  renderList() {
    const q = (document.getElementById('rep-search')?.value || '').toLowerCase();
    let items = State.reparaciones.filter(o => {
      if (q && !o.cliente.toLowerCase().includes(q) && !o.equipo.toLowerCase().includes(q) && !String(o.id).toLowerCase().includes(q)) return false;
      if (this._filter === 'activas') return !['entregado','rechazado','no_reparable'].includes(o.estado);
      if (this._filter === 'listo') return o.estado === 'listo';
      if (this._filter === 'entregado') return ['entregado','rechazado','no_reparable'].includes(o.estado);
      return true;
    });

    const countEl = document.getElementById('rep-list-count');
    if (countEl) countEl.textContent = `${items.length} orden${items.length !== 1 ? 'es' : ''}`;

    document.getElementById('rep-list').innerHTML = items.map(o => {
      const dias = this._diasDesde(o.fechaIngreso);
      const diasStr = dias === 0 ? 'Hoy' : dias === 1 ? '1 día' : `${dias} días`;
      const diasColor = dias >= 7 ? 'var(--red)' : dias >= 3 ? 'var(--amber)' : 'var(--text-secondary)';
      const isActive = this.currentId === o.id;
      const totalPagado = (o.pagos || []).reduce((s, p) => s + p.monto, 0);
      return `<div onclick="Reparaciones.select('${o.id}')"
        style="padding:11px 14px;border-bottom:1px solid var(--border);cursor:pointer;
               border-left:3px solid ${isActive ? 'var(--blue)' : 'transparent'};
               background:${isActive ? 'rgba(10,132,255,.08)' : 'transparent'};
               transition:background .12s">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:3px">
          <div style="font-size:12px;font-weight:700;color:${isActive?'var(--blue)':'var(--text)'}">${o.id}</div>
          <span class="badge ${this.ESTADO_CLASS[o.estado]}" style="font-size:9px;padding:2px 7px;flex-shrink:0">${this.ESTADO_LABEL[o.estado]}</span>
        </div>
        <div style="font-size:13px;font-weight:600;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${o.cliente}</div>
        <div style="font-size:11px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:5px">${o.equipo}</div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:10px;color:${diasColor}"><i class="ti ti-clock" style="font-size:9px"></i> ${diasStr}</span>
          ${totalPagado ? `<span style="font-size:10px;color:var(--green)"><i class="ti ti-cash" style="font-size:9px"></i> ${State.fmtARS(totalPagado)}</span>` : ''}
          ${o.estado === 'listo' ? '<span style="font-size:10px;color:var(--green);font-weight:700">✓ Lista para entregar</span>' : ''}
        </div>
      </div>`;
    }).join('') || `<div style="padding:30px 16px;text-align:center;color:var(--text-secondary);font-size:12px">Sin órdenes</div>`;
  },

  select(id) { this.currentId = id; this.renderList(); this.renderDetail(); this.syncMobileView(true); },

  // ── Mobile / resize ───────────────────────────────────
  isMobile() { return window.innerWidth < 1024; },

  syncMobileView(showDetail) {
    const listPanel = document.querySelector('.rep-list-panel');
    const detailPanel = document.querySelector('.rep-detail-panel');
    const backBtn = document.querySelector('.rep-back-btn');
    if (!listPanel || !detailPanel) return;
    if (!this.isMobile()) {
      listPanel.style.display = 'flex'; detailPanel.style.display = 'flex';
      if (backBtn) backBtn.style.display = 'none';
      return;
    }
    if (showDetail) {
      listPanel.style.display = 'none'; listPanel.style.width = '';
      detailPanel.style.display = 'flex';
      if (backBtn) backBtn.style.display = 'inline-flex';
    } else {
      listPanel.style.display = 'flex'; listPanel.style.width = '100%';
      detailPanel.style.display = 'none';
      if (backBtn) backBtn.style.display = 'none';
    }
  },

  backToList() { this.syncMobileView(false); },

  _resizeBound: false,
  bindResizeListener() {
    if (this._resizeBound) return;
    this._resizeBound = true;
    window.addEventListener('resize', () => {
      if (document.querySelector('.rep-list-panel'))
        this.syncMobileView(this.isMobile() && !!this.currentId && document.querySelector('.rep-detail-panel')?.style.display === 'flex');
    });
  },

  // ── Detalle ───────────────────────────────────────────
  renderDetail() {
    const o = State.reparaciones.find(x => x.id === this.currentId);
    const el = document.getElementById('rep-detail');
    if (!el) return;
    if (!o) {
      el.innerHTML = `<div class="empty-state" style="margin-top:60px"><i class="ti ti-tool"></i><div>Seleccioná una orden de la lista</div><div style="font-size:12px;margin-top:6px">o creá una nueva con el botón <b>+ Nueva</b></div></div>`;
      return;
    }

    const totalRepuestos = (o.repuestos || []).reduce((a, r) => a + r.costo, 0);
    const totalPagado = (o.pagos || []).reduce((a, p) => a + p.monto, 0);
    const totalCosto = (o.costoMO || 0) + totalRepuestos;
    const margen = (o.precioFinal || 0) - totalCosto;
    const isTerminal = ['rechazado','no_reparable','entregado'].includes(o.estado);
    const dias = this._diasDesde(o.fechaIngreso);

    // Flujo de estados visual
    const estadoFlow = this.ESTADOS.map((s, i) => {
      const done = this.ESTADOS.indexOf(o.estado) > i;
      const current = o.estado === s;
      const color = current ? this.ESTADO_COLOR[s] : done ? 'var(--green)' : 'var(--border-strong)';
      const bg = current ? `rgba(${this._hexToRgb(this.ESTADO_COLOR[s])}, .12)` : done ? 'var(--green-light)' : 'var(--bg-tertiary)';
      return `<div onclick="Reparaciones.setEstado('${s}')" style="flex:1;min-width:0;text-align:center;padding:8px 4px;border-radius:8px;border:1.5px solid ${color};background:${bg};cursor:pointer;transition:all .15s">
        <div style="font-size:${current?'13':'11'}px;font-weight:${current?'700':'500'};color:${color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${this.ESTADO_LABEL[s]}</div>
      </div>
      ${i < this.ESTADOS.length - 1 ? `<div style="width:10px;flex-shrink:0;color:var(--text-tertiary);font-size:10px;align-self:center;text-align:center">›</div>` : ''}`;
    }).join('');

    el.innerHTML = `
      <!-- Encabezado -->
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:16px;flex-wrap:wrap">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
            <span style="font-size:18px;font-weight:800;letter-spacing:-.4px">${o.id}</span>
            <span class="badge ${this.ESTADO_CLASS[o.estado]}">${this.ESTADO_LABEL[o.estado]}</span>
          </div>
          <div style="font-size:15px;font-weight:600;margin-bottom:2px">${o.equipo}</div>
          <div style="font-size:13px;color:var(--text-secondary)">${o.cliente}${o.tel ? ` · <a href="tel:${o.tel}" style="color:var(--blue)">${o.tel}</a>` : ''}</div>
          <div style="font-size:11px;color:var(--text-secondary);margin-top:3px">Ingreso: ${o.fechaIngreso} · ${dias === 0 ? 'hoy' : dias + ' día' + (dias !== 1 ? 's' : '')} en taller${o.tecnico ? ` · Técnico: ${o.tecnico}` : ''}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap">
          <button class="btn btn-sm" onclick="Reparaciones.imprimirOrden()" title="Imprimir orden">🖨️</button>
          ${o.tokenSeguimiento ? `<button class="btn btn-sm" onclick="Reparaciones.copiarLinkSeguimiento()" title="Copiar link de seguimiento para el cliente">🔗</button>` : ''}
          ${o.tel ? `<button class="btn btn-sm" onclick="Reparaciones.whatsappRecordatorio()" title="WhatsApp recordatorio" style="color:#25D366;border-color:#25D366">💬</button>` : ''}
          <button class="btn btn-sm" onclick="Reparaciones.openEditForm()" title="Editar datos">✏️</button>
          ${o.estado === 'listo' ? `<button class="btn btn-sm" onclick="Reparaciones.whatsappListo()" style="background:#25D366;color:#fff;border-color:#25D366">💬 Avisar</button><button class="btn btn-sm btn-green" onclick="Reparaciones.entregarYCobrar()">✅ Entregar</button>` : ''}
        </div>
      </div>

      <!-- Flujo de estado -->
      <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:12px;margin-bottom:14px">
        <div style="font-size:10px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Estado de la orden</div>
        <div style="display:flex;gap:4px;align-items:center">${estadoFlow}</div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <button onclick="Reparaciones.setEstado('rechazado')" style="font-size:11px;padding:4px 10px;border-radius:8px;border:1px solid var(--red);background:${o.estado==='rechazado'?'var(--red-light)':'transparent'};color:var(--red);cursor:pointer">Rechazado</button>
          <button onclick="Reparaciones.setEstado('no_reparable')" style="font-size:11px;padding:4px 10px;border-radius:8px;border:1px solid var(--red);background:${o.estado==='no_reparable'?'var(--red-light)':'transparent'};color:var(--red);cursor:pointer">No reparable</button>
        </div>
      </div>

      <!-- Info equipo -->
      <div class="card" style="margin-bottom:10px">
        <div class="card-title"><i class="ti ti-device-mobile"></i> Equipo</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px">
          <div><span style="color:var(--text-secondary)">Modelo:</span> <b>${o.equipo}</b></div>
          <div><span style="color:var(--text-secondary)">Clave:</span> <b style="font-family:monospace;background:var(--bg-tertiary);padding:2px 6px;border-radius:5px">${o.clave || '—'}</b></div>
          <div style="grid-column:1/-1"><span style="color:var(--text-secondary)">Falla reportada:</span> ${o.falla || '—'}</div>
          ${o.diagnostico ? `<div style="grid-column:1/-1;background:var(--purple-light);padding:8px 10px;border-radius:8px;color:var(--purple)"><b>Diagnóstico:</b> ${o.diagnostico}</div>` : ''}
        </div>
      </div>

      <!-- Condición al ingreso -->
      ${(() => {
        const c = o.condicionIngreso || {};
        const problemas = CONDICION_ITEMS.filter(i => c[i.id]);
        if (!problemas.length && !c.nota) return '';
        const esteticos  = problemas.filter(i => i.grupo === 'estetica');
        const funcionales = problemas.filter(i => i.grupo === 'funcional');
        return `<div class="card" style="margin-bottom:10px">
          <div class="card-title"><i class="ti ti-clipboard-list" style="color:var(--amber)"></i> Condición al ingreso</div>
          ${esteticos.length ? `<div style="margin-bottom:6px">
            <div style="font-size:10px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px">Estética</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px">${esteticos.map(i=>`<span class="badge b-amber">${i.label}</span>`).join('')}</div>
          </div>` : ''}
          ${funcionales.length ? `<div style="margin-bottom:6px">
            <div style="font-size:10px;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px">Funcional</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px">${funcionales.map(i=>`<span class="badge b-red">${i.label}</span>`).join('')}</div>
          </div>` : ''}
          ${c.nota ? `<div style="font-size:12px;color:var(--text-secondary);background:var(--bg-secondary);border-radius:7px;padding:7px 10px;margin-top:4px"><i class="ti ti-note"></i> ${c.nota}</div>` : ''}
          <div style="font-size:11px;color:var(--text-secondary);margin-top:8px;padding-top:8px;border-top:1px solid var(--border)"><i class="ti ti-circle-check" style="color:var(--green)"></i> Las demás funciones se verificaron con normalidad al momento del ingreso.</div>
        </div>`;
      })()}

      <!-- Repuestos -->
      <div class="card" style="margin-bottom:10px">
        <div class="card-title" style="justify-content:space-between">
          <span><i class="ti ti-tool"></i> Repuestos utilizados</span>
          <button class="btn btn-sm" onclick="Reparaciones.openAddRepuestoModal()">➕ Agregar</button>
        </div>
        ${(o.repuestos || []).length ? `
          <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:4px">
            ${o.repuestos.map((r, i) => `
              <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);font-size:12px;${i===o.repuestos.length-1?'border-bottom:none':''}">
                <div style="flex:1;min-width:0">
                  <div style="font-weight:500">${r.nombre}</div>
                  <div style="font-size:10px;color:var(--text-secondary)">${r.fromStock ? '📦 De stock' : '🛒 Compra externa'}</div>
                </div>
                <b style="color:var(--text)">USD ${r.costo}</b>
              </div>`).join('')}
          </div>
          <div style="text-align:right;font-size:11px;color:var(--text-secondary)">Total repuestos: <b>USD ${totalRepuestos.toFixed(2)}</b></div>
        ` : `<p style="font-size:12px;color:var(--text-secondary)">Sin repuestos cargados</p>`}
      </div>

      <!-- Pagos -->
      <div class="card" style="margin-bottom:10px">
        <div class="card-title" style="justify-content:space-between">
          <span><i class="ti ti-credit-card"></i> Pagos / señas</span>
          <button class="btn btn-sm" onclick="Reparaciones.openAddPagoModal()">➕ Registrar</button>
        </div>
        ${(o.pagos || []).length ? `
          <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:4px">
            ${o.pagos.map((p, i) => `
              <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);font-size:12px;${i===o.pagos.length-1?'border-bottom:none':''}">
                <i class="ti ti-cash" style="color:var(--green);font-size:14px;flex-shrink:0"></i>
                <div style="flex:1">${p.persona} · <span style="color:var(--text-secondary)">${p.bolsillo}</span></div>
                <b style="color:var(--green)">${State.fmtARS(p.monto)}</b>
              </div>`).join('')}
          </div>
          <div style="text-align:right;font-size:11px;color:var(--text-secondary)">Total cobrado: <b style="color:var(--green)">${State.fmtARS(totalPagado)}</b></div>
        ` : `<p style="font-size:12px;color:var(--text-secondary)">Sin pagos registrados</p>`}
      </div>

      <!-- Costos y margen -->
      <div class="card" style="margin-bottom:10px">
        <div class="card-title"><i class="ti ti-currency-dollar"></i> Costos y precio</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Mano de obra (USD)</label>
            <input type="number" id="rep-f-mo" value="${o.costoMO || 0}" min="0"
              style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Precio final (USD)</label>
            <input type="number" id="rep-f-precio" value="${o.precioFinal || 0}" min="0"
              style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;background:var(--bg-secondary);border-radius:8px;padding:10px">
          <div style="text-align:center"><div style="font-size:10px;color:var(--text-secondary);margin-bottom:2px">Costo total</div><div style="font-size:14px;font-weight:700">USD ${totalCosto.toFixed(2)}</div></div>
          <div style="text-align:center"><div style="font-size:10px;color:var(--text-secondary);margin-bottom:2px">Precio cobrado</div><div style="font-size:14px;font-weight:700;color:var(--blue)">USD ${(o.precioFinal||0).toFixed(2)}</div></div>
          <div style="text-align:center"><div style="font-size:10px;color:var(--text-secondary);margin-bottom:2px">Margen</div><div style="font-size:14px;font-weight:700;color:${margen>=0?'var(--green)':'var(--red)'}">${margen>=0?'+':''}USD ${margen.toFixed(2)}</div></div>
        </div>
      </div>

      <!-- Diagnóstico / notas internas -->
      <div class="card" style="margin-bottom:10px">
        <div class="card-title"><i class="ti ti-notes"></i> Diagnóstico y notas internas</div>
        <div style="margin-bottom:8px">
          <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Diagnóstico técnico</label>
          <textarea id="rep-f-diagnostico" rows="2"
            style="width:100%;font-size:12.5px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);resize:vertical;font-family:var(--font)"
            placeholder="Diagnóstico y descripción del trabajo realizado…">${o.diagnostico || ''}</textarea>
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Notas internas</label>
          <textarea id="rep-f-notas" rows="2"
            style="width:100%;font-size:12.5px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);resize:vertical;font-family:var(--font)"
            placeholder="Notas internas del equipo…">${o.notas || ''}</textarea>
        </div>
      </div>

      <!-- Mensajes del cliente (seguimiento) -->
      <div class="card" style="margin-bottom:10px" id="seguimiento-msgs-card">
        <div class="card-title" style="justify-content:space-between">
          <span><i class="ti ti-messages" style="color:var(--blue)"></i> Mensajes del cliente</span>
          ${o.tokenSeguimiento ? `<button class="btn btn-sm" onclick="Reparaciones.copiarLinkSeguimiento()" style="font-size:11px">🔗 Copiar link</button>` : ''}
        </div>
        ${!o.tokenSeguimiento ? `
          <div style="font-size:12px;color:var(--text-secondary);background:var(--bg-secondary);border-radius:8px;padding:10px 12px">
            <i class="ti ti-info-circle"></i> Esta reparación aún no tiene link de seguimiento. Ejecutá la migración SQL en Supabase para habilitarlo.
          </div>` : `
          <div id="seguimiento-msgs-list" style="display:flex;flex-direction:column;gap:8px;min-height:40px;margin-bottom:10px">
            <div style="font-size:12px;color:var(--text-tertiary)"><i class="ti ti-loader-2"></i> Cargando mensajes…</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px">
            <textarea id="msg-tecnico-texto" rows="2" placeholder="Escribí una nota para el cliente (la va a ver en su página de seguimiento)…"
              style="width:100%;font-size:12.5px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);resize:vertical;font-family:var(--font)"></textarea>
            <button class="btn btn-primary btn-sm" onclick="Reparaciones.enviarMsgTecnico()">📤 Enviar nota al cliente</button>
          </div>
        `}
      </div>

      <!-- Acciones -->
      <div style="display:flex;gap:8px;justify-content:space-between;align-items:center;flex-wrap:wrap;margin-top:4px;padding-bottom:20px">
        <div>
          ${!isTerminal || this.hasMovimientos(o) ? `<button class="btn btn-red btn-sm" onclick="Reparaciones.cancelarConReversion()">🗑️ Cancelar orden</button>` : ''}
        </div>
        <button class="btn btn-primary" onclick="Reparaciones.saveOrder()">✅ Guardar cambios</button>
      </div>
    `;
    setTimeout(() => this._cargarMsgsSeguimiento(), 0);
  },

  _hexToRgb(cssVar) {
    const map = {
      'var(--gray)':'142,142,147','var(--purple)':'191,90,242','var(--blue)':'10,132,255',
      'var(--green)':'48,209,88','var(--teal)':'90,200,250','var(--red)':'255,69,58'
    };
    return map[cssVar] || '10,132,255';
  },

  hasMovimientos(o) { return (o.pagos && o.pagos.length > 0) || (o.repuestos && o.repuestos.length > 0); },

  // ── Cambio de estado ──────────────────────────────────
  async setEstado(estado) {
    const o = State.reparaciones.find(x => x.id === this.currentId);
    if (!o) return;
    if (o.estado === estado) return;
    o.estado = estado;
    if (['rechazado','no_reparable'].includes(estado) && !this.hasMovimientos(o)) {
      o.equipoDevuelto = true; o.custodio = '';
      toast('Equipo marcado como devuelto automáticamente.');
    }
    await DB.actualizarReparacion(o);
    Sheets.reparacion(o);
    this.renderList(); this.renderDetail();
    toast(`Estado actualizado a ${this.ESTADO_LABEL[estado]}.`);
    if (estado === 'listo' && o.tel) this._sugerirWhatsapp(o);
  },

  // ── WhatsApp ──────────────────────────────────────────
  _sugerirWhatsapp(o) {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;bottom:80px;right:20px;background:var(--bg-elevated);border:1px solid #25D366;border-radius:var(--radius-lg);padding:12px 16px;z-index:9000;box-shadow:var(--shadow-md);max-width:300px';
    banner.innerHTML = `
      <div style="font-size:12px;font-weight:600;color:#25D366;margin-bottom:6px">💬 ¿Avisar al cliente?</div>
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px">El equipo de <b>${o.cliente}</b> está listo. Enviá el aviso por WhatsApp.</div>
      <div style="display:flex;gap:6px">
        <button onclick="this.closest('div[style]').remove()" style="flex:1;font-size:11px;padding:5px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text-secondary);cursor:pointer">Ahora no</button>
        <button onclick="Reparaciones.whatsappListo('${o.id}');this.closest('div[style]').remove()" style="flex:2;font-size:11px;padding:5px;border:none;border-radius:6px;background:#25D366;color:#fff;cursor:pointer;font-weight:600">💬 Enviar aviso</button>
      </div>`;
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 12000);
  },

  whatsappListo(id) {
    const o = State.reparaciones.find(x => x.id === (id || this.currentId));
    if (!o) return;
    const trabajo = o.diagnostico || o.falla || 'Reparación completada';
    const precio = o.precioFinal ? `USD ${o.precioFinal}` : 'a confirmar en el local';
    const msg = `¡Hola ${o.cliente}! 👋\n\nTe avisamos que tu equipo *${o.equipo}* ya está listo para retirar en *iPhoneMood*.\n\n🔧 Trabajo realizado: ${trabajo}\n💰 Total: ${precio}\n\n¡Te esperamos! 🙌\n_iPhoneMood — Rosario_`;
    const tel = (o.tel || '').replace(/\D/g, '');
    const url = `https://wa.me/${tel ? '549' + tel : ''}?text=${encodeURIComponent(msg)}`;
    window.open(url, '_blank');
  },

  whatsappRecordatorio(id) {
    const o = State.reparaciones.find(x => x.id === (id || this.currentId));
    if (!o) return;
    const msg = `¡Hola ${o.cliente}! 👋\n\nQueremos recordarte que tu equipo *${o.equipo}* sigue en nuestro taller.\n\n📍 Estado actual: *${this.ESTADO_LABEL[o.estado]}*\n\nCualquier novedad te avisamos. ¡Gracias por tu paciencia! 🙏\n_iPhoneMood — Rosario_`;
    const tel = (o.tel || '').replace(/\D/g, '');
    const url = `https://wa.me/${tel ? '549' + tel : ''}?text=${encodeURIComponent(msg)}`;
    window.open(url, '_blank');
  },

  // ── PDF Orden de trabajo ──────────────────────────────
  imprimirOrden() {
    const o = State.reparaciones.find(x => x.id === this.currentId);
    if (!o) return;
    const fecha = new Date().toLocaleDateString('es-AR');
    const hora  = new Date().toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' });
    const totalRep = (o.repuestos||[]).reduce((s,r) => s+r.costo, 0);
    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Orden ${o.id}</title>
    <style>
      *{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;font-size:12px;color:#1a1a1a;padding:24px}
      .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;border-bottom:2px solid #1a1a1a;padding-bottom:14px}
      .logo{font-size:22px;font-weight:800;letter-spacing:-.5px}.sub{font-size:10px;color:#666;margin-top:3px}
      .orden-num{font-size:28px;font-weight:800;color:#888;letter-spacing:-.5px}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px}
      .box{border:1px solid #e0e0e0;border-radius:6px;padding:12px}
      .box h3{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#888;margin-bottom:8px}
      .row{display:flex;justify-content:space-between;padding:3px 0;font-size:11px;border-bottom:1px solid #f0f0f0}
      .row:last-child{border-bottom:none}.row span{color:#666}
      table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:12px}
      th{background:#1a1a1a;color:#fff;padding:5px 8px;text-align:left}
      td{padding:5px 8px;border-bottom:1px solid #e0e0e0}
      .badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700;background:#f0f0f0}
      .firma{display:flex;gap:30px;margin-top:24px}
      .firma-box{flex:1;border-top:1px solid #1a1a1a;padding-top:4px;font-size:10px;color:#888;text-align:center}
      .footer{text-align:center;font-size:9px;color:#aaa;margin-top:20px;border-top:1px solid #e0e0e0;padding-top:8px}
      .falla-box{background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:10px;margin-bottom:14px;font-size:11.5px}
      @media print{body{padding:10px}}
    </style></head><body>
    <div class="header">
      <div><div class="logo">iPhoneMood</div><div class="sub">Julio Argentino Roca 700, Gral. Baigorria, Santa Fe<br>Tel: +54 9 3413 66-2150 · iphonemood.ar@gmail.com</div></div>
      <div style="text-align:right"><div class="orden-num">ORDEN ${o.id}</div><div style="font-size:10px;color:#888">Fecha: ${fecha} ${hora}</div><div class="badge">${this.ESTADO_LABEL[o.estado]}</div></div>
    </div>

    <div class="grid">
      <div class="box"><h3>Datos del cliente</h3>
        <div class="row"><span>Nombre</span><b>${o.cliente}</b></div>
        ${o.tel ? `<div class="row"><span>Teléfono</span><b>${o.tel}</b></div>` : ''}
        <div class="row"><span>Fecha ingreso</span><b>${o.fechaIngreso}</b></div>
        ${o.tecnico ? `<div class="row"><span>Técnico</span><b>${o.tecnico}</b></div>` : ''}
      </div>
      <div class="box"><h3>Datos del equipo</h3>
        <div class="row"><span>Equipo</span><b>${o.equipo}</b></div>
        ${o.clave ? `<div class="row"><span>Clave/PIN</span><b style="font-family:monospace">${o.clave}</b></div>` : ''}
        <div class="row"><span>Precio estimado</span><b>${o.precioFinal ? 'USD ' + o.precioFinal : 'A presupuestar'}</b></div>
        ${o.fechaEntrega ? `<div class="row"><span>Entrega estimada</span><b>${o.fechaEntrega}</b></div>` : ''}
      </div>
    </div>

    <div class="falla-box"><b>⚠ Problema reportado:</b><br>${o.falla || 'Sin descripción'}</div>

    ${(o.repuestos||[]).length ? `
    <table><thead><tr><th>Repuesto</th><th>Origen</th><th>Costo USD</th></tr></thead>
    <tbody>${o.repuestos.map(r => `<tr><td>${r.nombre}</td><td>${r.fromStock?'De stock':'Compra externa'}</td><td>USD ${r.costo}</td></tr>`).join('')}
    <tr style="font-weight:700"><td colspan="2">Total repuestos</td><td>USD ${totalRep.toFixed(2)}</td></tr>
    </tbody></table>` : ''}

    ${(o.pagos||[]).length ? `
    <table><thead><tr><th>Pagos registrados</th><th>Forma</th><th>Monto</th></tr></thead>
    <tbody>${o.pagos.map(p => `<tr><td>${p.persona}</td><td>${p.bolsillo}</td><td>${p.bolsillo.startsWith('USD')?'USD '+p.monto:State.fmtARS(p.monto)}</td></tr>`).join('')}
    </tbody></table>` : ''}

    <table style="margin-top:4px"><thead><tr><th>Concepto</th><th>Monto</th></tr></thead>
    <tbody>
      ${o.costoMO ? `<tr><td>Mano de obra</td><td>USD ${o.costoMO}</td></tr>` : ''}
      ${totalRep ? `<tr><td>Repuestos</td><td>USD ${totalRep.toFixed(2)}</td></tr>` : ''}
      <tr style="font-weight:700"><td>TOTAL A ABONAR</td><td>USD ${o.precioFinal||0}</td></tr>
    </tbody></table>

    <div style="margin-top:14px;font-size:10px;color:#555;border:1px solid #e0e0e0;border-radius:6px;padding:10px">
      <b>Condiciones:</b> El cliente declara haber entregado el equipo en las condiciones descritas. iPhoneMood no se responsabiliza por datos almacenados en el dispositivo. El presupuesto tiene validez de 7 días hábiles.
    </div>

    <div class="firma">
      <div class="firma-box">Firma del cliente</div>
      <div class="firma-box">Aclaración</div>
      <div class="firma-box">DNI</div>
      <div class="firma-box">Técnico iPhoneMood</div>
    </div>

    <div class="footer">DOCUMENTO NO VÁLIDO COMO FACTURA · iPhoneMood · Orden N° ${o.id} · ${fecha}</div>
    </body></html>`;
    const win = window.open('', '_blank', 'width=860,height=680');
    win.document.write(html);
    win.document.close();
    setTimeout(() => { win.focus(); win.print(); }, 500);
  },

  // ── Seguimiento público ───────────────────────────────────
  copiarLinkSeguimiento() {
    const o = State.reparaciones.find(x => x.id === this.currentId);
    if (!o?.tokenSeguimiento) { toast('Esta reparación no tiene link de seguimiento aún.'); return; }
    const base = location.origin + location.pathname.replace('index.html', '').replace(/\/$/, '');
    const link = `${base}/seguimiento.html?t=${o.tokenSeguimiento}`;
    navigator.clipboard.writeText(link).then(() => {
      toast('Link copiado al portapapeles. Ya podés enviárselo al cliente.');
    }).catch(() => {
      prompt('Copiá este link y enviáselo al cliente:', link);
    });
  },

  async _cargarMsgsSeguimiento() {
    const o = State.reparaciones.find(x => x.id === this.currentId);
    if (!o?.tokenSeguimiento) return;
    const msgs = await DB.getSeguimientoComentarios(o.id);
    const list = document.getElementById('seguimiento-msgs-list');
    if (!list) return;
    if (!msgs.length) {
      list.innerHTML = `<div style="font-size:12px;color:var(--text-tertiary)">Sin mensajes aún. Cuando el cliente escriba desde su link de seguimiento, aparecerá acá.</div>`;
      return;
    }
    list.innerHTML = msgs.map(m => {
      const esTec = m.es_tecnico;
      const d = new Date(m.creado_en);
      const hora = d.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit' }) + ' ' + d.toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' });
      return `<div style="display:flex;flex-direction:column;gap:2px;align-self:${esTec ? 'flex-end' : 'flex-start'};max-width:90%">
        <div style="padding:8px 11px;border-radius:${esTec ? '12px 12px 4px 12px' : '12px 12px 12px 4px'};font-size:12.5px;line-height:1.45;background:${esTec ? 'var(--blue)' : 'var(--bg-secondary)'};color:${esTec ? '#fff' : 'var(--text)'}">
          ${m.texto.replace(/\n/g,'<br>')}
        </div>
        <div style="font-size:10px;color:var(--text-tertiary);padding:0 3px;text-align:${esTec ? 'right' : 'left'}">${esTec ? 'iPhoneMood' : (m.autor || 'Cliente')} · ${hora}</div>
      </div>`;
    }).join('');
    list.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  async enviarMsgTecnico() {
    const o = State.reparaciones.find(x => x.id === this.currentId);
    if (!o) return;
    const texto = document.getElementById('msg-tecnico-texto')?.value.trim();
    if (!texto) { toast('Escribí el mensaje antes de enviarlo.'); return; }
    await DB.addSeguimientoComentario(o.id, texto, Auth.usuario?.nombre || 'iPhoneMood', true);
    document.getElementById('msg-tecnico-texto').value = '';
    await this._cargarMsgsSeguimiento();
    toast('Nota enviada. El cliente la verá en su página de seguimiento.');
  },

  // ── Guardar cambios ───────────────────────────────────
  async saveOrder() {
    const o = State.reparaciones.find(x => x.id === this.currentId);
    if (!o) return;
    o.costoMO    = parseFloat(document.getElementById('rep-f-mo')?.value) || 0;
    o.precioFinal= parseFloat(document.getElementById('rep-f-precio')?.value) || 0;
    o.diagnostico= document.getElementById('rep-f-diagnostico')?.value || '';
    o.notas      = document.getElementById('rep-f-notas')?.value || '';
    await DB.actualizarReparacion(o);
    Sheets.reparacion(o);
    this.renderDetail();
    toast('Cambios guardados.');
  },

  // ── Formulario nueva orden ────────────────────────────
  openNewForm() { this._openOrderModal(null); },
  openEditForm() {
    const o = State.reparaciones.find(x => x.id === this.currentId);
    if (o) this._openOrderModal(o);
  },

  _openOrderModal(o) {
    const isEdit = !!o;
    const personas = State.personas || [];
    const personaOpts = personas.map(p => `<option value="${p}" ${o?.tecnico===p?'selected':''}>${p}</option>`).join('');
    const overlay = document.createElement('div');
    overlay.id = 'rep-form-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(6px);z-index:800;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(560px,96vw);max-height:90dvh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
          <div>
            <div style="font-size:16px;font-weight:700">${isEdit ? 'Editar orden' : 'Nueva orden de reparación'}</div>
            ${isEdit ? `<div style="font-size:12px;color:var(--text-secondary)">${o.id}</div>` : ''}
          </div>
          <button onclick="Reparaciones._closeOrderModal()" style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;width:30px;height:30px;cursor:pointer;color:var(--text);display:flex;align-items:center;justify-content:center;font-size:16px">✕</button>
        </div>
        <div style="padding:20px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:14px">

          <!-- Cliente -->
          <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:14px">
            <div style="font-size:11px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Datos del cliente</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div style="grid-column:1/-1">
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Nombre del cliente *</label>
                <input type="text" id="rof-cliente" value="${o?.cliente||''}" placeholder="Ej: Juan Pérez"
                  style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-tertiary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
              </div>
              <div style="grid-column:1/-1">
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Teléfono</label>
                <input type="tel" id="rof-tel" value="${o?.tel||''}" placeholder="Ej: 3412345678"
                  style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-tertiary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
              </div>
            </div>
          </div>

          <!-- Equipo -->
          <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:14px">
            <div style="font-size:11px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Datos del equipo</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div style="grid-column:1/-1">
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Equipo / modelo *</label>
                <input type="text" id="rof-equipo" value="${o?.equipo||''}" placeholder="Ej: iPhone 13 Pro Max 256GB"
                  style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-tertiary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
              </div>
              <div>
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">IMEI (opcional)</label>
                <input type="text" id="rof-clave" value="${o?.clave||''}" placeholder="15 dígitos o código"
                  style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-tertiary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);font-family:monospace">
              </div>
              <div>
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Clave de desbloqueo</label>
                <input type="text" id="rof-pin" value="${o?.clave||''}" placeholder="PIN / patrón"
                  style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-tertiary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);font-family:monospace">
              </div>
              <div style="grid-column:1/-1">
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Descripción del problema *</label>
                <textarea id="rof-falla" rows="2"
                  style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-tertiary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);resize:vertical;font-family:var(--font)"
                  placeholder="Describir el problema reportado por el cliente…">${o?.falla||''}</textarea>
              </div>
            </div>
          </div>

          <!-- Condición al ingreso -->
          <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:14px">
            <div style="font-size:11px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Condición al ingreso</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px">Marcá lo que <b>NO anda o tiene problemas</b>. Lo demás se asume en orden.</div>

            <div style="font-size:10px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Estética</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:5px;margin-bottom:12px">
              ${CONDICION_ITEMS.filter(i=>i.grupo==='estetica').map(item => {
                const checked = o?.condicionIngreso?.[item.id] ? 'checked' : '';
                return `<label style="display:flex;align-items:center;gap:7px;padding:7px 9px;border-radius:7px;cursor:pointer;border:1px solid var(--border);font-size:12px;transition:all .12s" onclick="Reparaciones._toggleCondicion(this)">
                  <input type="checkbox" data-cid="${item.id}" ${checked} style="accent-color:var(--red);width:14px;height:14px;flex-shrink:0">
                  <span>${item.label}</span>
                </label>`;
              }).join('')}
            </div>

            <div style="font-size:10px;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Funcional</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:5px;margin-bottom:10px">
              ${CONDICION_ITEMS.filter(i=>i.grupo==='funcional').map(item => {
                const checked = o?.condicionIngreso?.[item.id] ? 'checked' : '';
                return `<label style="display:flex;align-items:center;gap:7px;padding:7px 9px;border-radius:7px;cursor:pointer;border:1px solid var(--border);font-size:12px;transition:all .12s" onclick="Reparaciones._toggleCondicion(this)">
                  <input type="checkbox" data-cid="${item.id}" ${checked} style="accent-color:var(--red);width:14px;height:14px;flex-shrink:0">
                  <span>${item.label}</span>
                </label>`;
              }).join('')}
            </div>

            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Aclaraciones estéticas (opcional)</label>
              <input type="text" id="rof-condicion-nota" value="${o?.condicionIngreso?.nota||''}" placeholder="Ej: rayón leve en esquina superior derecha, tapa trasera con marca…"
                style="width:100%;font-size:12.5px;padding:7px 10px;background:var(--bg-tertiary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
          </div>

          <!-- Técnico y precio -->
          <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:14px">
            <div style="font-size:11px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Asignación y precio</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div style="grid-column:1/-1">
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Técnico asignado</label>
                <select id="rof-tecnico" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-tertiary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                  <option value="">Sin asignar</option>
                  ${personaOpts}
                </select>
              </div>
              <div>
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Precio estimado (USD)</label>
                <input type="number" id="rof-precio" value="${o?.precioFinal||''}" placeholder="0" min="0"
                  style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-tertiary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
              </div>
              <div>
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Fecha est. de entrega</label>
                <input type="date" id="rof-fecha-entrega" value="${o?.fechaEntrega||''}"
                  style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-tertiary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
              </div>
            </div>
          </div>

        </div>
        <div style="padding:14px 20px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;flex-shrink:0">
          <button class="btn" onclick="Reparaciones._closeOrderModal()">Cancelar</button>
          <button class="btn btn-primary" onclick="Reparaciones._submitOrderForm(${isEdit})">
            ${isEdit ? '✅' : '➕'} ${isEdit ? 'Guardar cambios' : 'Crear orden'}
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) this._closeOrderModal(); });
    document.addEventListener('keydown', this._escOrderModal);
    setTimeout(() => document.getElementById('rof-cliente')?.focus(), 80);
  },

  _toggleCondicion(label) {
    const cb = label.querySelector('input[type="checkbox"]');
    const checked = cb.checked;
    label.style.borderColor = checked ? 'var(--red)' : 'var(--border)';
    label.style.background   = checked ? 'rgba(255,69,58,.08)' : 'transparent';
  },

  _leerCondicion() {
    const result = {};
    document.querySelectorAll('input[data-cid]').forEach(cb => {
      result[cb.dataset.cid] = cb.checked;
    });
    result.nota = document.getElementById('rof-condicion-nota')?.value.trim() || '';
    return result;
  },

  _escOrderModal(e) { if (e.key === 'Escape') Reparaciones._closeOrderModal(); },
  _closeOrderModal() {
    document.getElementById('rep-form-overlay')?.remove();
    document.removeEventListener('keydown', Reparaciones._escOrderModal);
  },

  async _submitOrderForm(isEdit) {
    const cliente = document.getElementById('rof-cliente')?.value.trim();
    const equipo  = document.getElementById('rof-equipo')?.value.trim();
    if (!cliente || !equipo) { toast('Completá al menos cliente y equipo.'); return; }

    const data = {
      cliente,
      tel:              document.getElementById('rof-tel')?.value.trim() || '',
      equipo,
      clave:            document.getElementById('rof-pin')?.value.trim() || '',
      falla:            document.getElementById('rof-falla')?.value.trim() || '',
      tecnico:          document.getElementById('rof-tecnico')?.value || '',
      precioFinal:      parseFloat(document.getElementById('rof-precio')?.value) || 0,
      fechaEntrega:     document.getElementById('rof-fecha-entrega')?.value || '',
      condicionIngreso: this._leerCondicion(),
    };

    this._closeOrderModal();

    if (isEdit) {
      const o = State.reparaciones.find(x => x.id === this.currentId);
      if (!o) return;
      Object.assign(o, data);
      await DB.actualizarReparacion(o);
      Sheets.reparacion(o);
      this.renderList(); this.renderDetail();
      toast('Orden actualizada.');
    } else {
      await this.newOrder(data);
    }
  },

  async newOrder(data = {}) {
    const maxNum = State.reparaciones.reduce((max, r) => {
      const n = parseInt(String(r.id).replace(/\D/g, ''), 10);
      return isNaN(n) ? max : Math.max(max, n);
    }, 19);
    const id = 'R' + String(maxNum + 1).padStart(3, '0');
    const o = {
      id,
      cliente: data.cliente || 'Nuevo cliente',
      tel: data.tel || '',
      equipo: data.equipo || 'Sin especificar',
      falla: data.falla || '',
      clave: data.clave || '',
      estado: 'ingresado',
      fechaIngreso: new Date().toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit' }),
      fechaEntrega: data.fechaEntrega || '',
      diagnostico: '',
      presupuestoAprobado: false,
      repuestos: [], pagos: [],
      costoMO: 0,
      precioFinal: data.precioFinal || 0,
      tecnico: data.tecnico || '',
      custodio: '',
      notas: '',
      equipoDevuelto: false
    };
    await DB.crearReparacion(o);
    Sheets.reparacion(o);
    State.reparaciones.unshift(o);
    this.currentId = id;
    this.renderList(); this.renderDetail();
    this.syncMobileView(true);
    toast(`Orden ${id} creada.`);
  },

  // ── Modal agregar repuesto ────────────────────────────
  openAddRepuestoModal() {
    const overlay = document.createElement('div');
    overlay.id = 'rep-repuesto-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(6px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(400px,96vw);overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:14px;font-weight:700">Agregar repuesto</div>
          <button onclick="document.getElementById('rep-repuesto-overlay').remove()" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:18px">✕</button>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Nombre del repuesto</label>
            <input type="text" id="rep-r-nombre" placeholder="Ej: Pantalla OLED, Batería 3000mAh…"
              style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Costo en USD</label>
            <input type="number" id="rep-r-costo" value="0" min="0"
              style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          <div style="display:flex;gap:8px">
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;flex:1;padding:8px 10px;border:1.5px solid var(--border-strong);border-radius:8px">
              <input type="radio" name="rep-r-origen" value="externo" checked> Compra externa
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;flex:1;padding:8px 10px;border:1.5px solid var(--border-strong);border-radius:8px">
              <input type="radio" name="rep-r-origen" value="stock"> De mi stock
            </label>
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('rep-repuesto-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Reparaciones.submitAddRepuesto()">➕ Agregar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById('rep-r-nombre')?.focus(), 60);
  },

  async submitAddRepuesto() {
    const nombre = document.getElementById('rep-r-nombre')?.value.trim();
    if (!nombre) { toast('Ingresá el nombre del repuesto.'); return; }
    const costo = parseFloat(document.getElementById('rep-r-costo')?.value) || 0;
    const fromStock = document.querySelector('input[name="rep-r-origen"]:checked')?.value === 'stock';
    document.getElementById('rep-repuesto-overlay')?.remove();
    const o = State.reparaciones.find(x => x.id === this.currentId);
    if (!o) return;
    const repuesto = { nombre, costo, fromStock };
    o.repuestos.push(repuesto);
    await DB.agregarRepuestoReparacion(o.id, repuesto);
    this.renderDetail();
    toast('Repuesto agregado.');
  },

  // ── Modal registrar pago ──────────────────────────────
  openAddPagoModal() {
    const personas = State.personas || [];
    const personaOpts = personas.map(p => `<option value="${p}">${p}</option>`).join('');
    const bolsilloOpts = this.BOLSILLOS.map(b => `<option value="${b}">${b}</option>`).join('');
    const overlay = document.createElement('div');
    overlay.id = 'rep-pago-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(6px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(400px,96vw);overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:14px;font-weight:700">Registrar pago / seña</div>
          <button onclick="document.getElementById('rep-pago-overlay').remove()" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:18px">✕</button>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Monto (ARS)</label>
            <input type="number" id="rep-p-monto" value="" placeholder="0" min="0"
              style="width:100%;font-size:15px;padding:9px 12px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Caja (persona)</label>
              <select id="rep-p-persona" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                ${personaOpts}
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Forma de pago</label>
              <select id="rep-p-bolsillo" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                ${bolsilloOpts}
              </select>
            </div>
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('rep-pago-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Reparaciones.submitAddPago()">💵 Registrar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById('rep-p-monto')?.focus(), 60);
  },

  async submitAddPago() {
    const monto = parseFloat(document.getElementById('rep-p-monto')?.value) || 0;
    if (!monto) { toast('Ingresá un monto válido.'); return; }
    const persona  = document.getElementById('rep-p-persona')?.value;
    const bolsillo = document.getElementById('rep-p-bolsillo')?.value;
    document.getElementById('rep-pago-overlay')?.remove();
    const o = State.reparaciones.find(x => x.id === this.currentId);
    if (!o) return;
    const pago = { caja: `${persona}-${bolsillo}`, monto, persona, bolsillo };
    o.pagos.push(pago);
    State.acreditarCaja(persona, bolsillo, monto);
    await DB.agregarPagoReparacion(o.id, pago);
    this.renderDetail();
    toast(`${State.fmtARS(monto)} acreditado en caja de ${persona}.`);
  },

  // ── Entregar ──────────────────────────────────────────
  async entregarYCobrar() {
    const o = State.reparaciones.find(x => x.id === this.currentId);
    if (!o) return;
    const personas = State.personas || [];
    const overlay = document.createElement('div');
    overlay.id = 'rep-entrega-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(6px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    const totalPagado = (o.pagos || []).reduce((s, p) => s + p.monto, 0);
    const saldo = (o.precioFinal || 0) * (State.refBlue || 1) - totalPagado;
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(380px,96vw);overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border)">
          <div style="font-size:15px;font-weight:700;color:var(--green)">✅ Entregar equipo</div>
          <div style="font-size:12px;color:var(--text-secondary)">${o.id} — ${o.equipo} — ${o.cliente}</div>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:10px">
          <div style="background:var(--green-light);border-radius:8px;padding:12px;display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px">
            <div><span style="color:var(--text-secondary)">Precio final</span><div style="font-size:15px;font-weight:700">USD ${(o.precioFinal||0).toFixed(2)}</div></div>
            <div><span style="color:var(--text-secondary)">Ya pagado</span><div style="font-size:15px;font-weight:700;color:var(--green)">${State.fmtARS(totalPagado)}</div></div>
            ${saldo > 0 ? `<div style="grid-column:1/-1;border-top:1px solid rgba(48,209,88,.3);padding-top:6px"><span style="color:var(--text-secondary)">Saldo a cobrar</span><div style="font-size:16px;font-weight:800;color:var(--amber)">${State.fmtARS(saldo)}</div></div>` : '<div style="grid-column:1/-1;color:var(--green);font-weight:600;text-align:center">✓ Pagado en su totalidad</div>'}
          </div>
          ${saldo > 0 ? `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Caja</label>
              <select id="rep-e-persona" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                ${personas.map(p => `<option value="${p}">${p}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Forma de pago</label>
              <select id="rep-e-bolsillo" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                ${this.BOLSILLOS.map(b => `<option value="${b}">${b}</option>`).join('')}
              </select>
            </div>
          </div>` : ''}
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('rep-entrega-overlay').remove()">Cancelar</button>
          <button class="btn btn-green" onclick="Reparaciones._confirmarEntrega(${saldo})">✅ Confirmar entrega</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  },

  async _confirmarEntrega(saldo) {
    const o = State.reparaciones.find(x => x.id === this.currentId);
    if (!o) return;
    if (saldo > 0) {
      const persona  = document.getElementById('rep-e-persona')?.value;
      const bolsillo = document.getElementById('rep-e-bolsillo')?.value;
      const pago = { caja: `${persona}-${bolsillo}`, monto: saldo, persona, bolsillo };
      o.pagos.push(pago);
      State.acreditarCaja(persona, bolsillo, saldo);
      await DB.agregarPagoReparacion(o.id, pago);
    }
    o.estado = 'entregado'; o.equipoDevuelto = true;
    await DB.actualizarReparacion(o);
    Sheets.reparacion(o);
    document.getElementById('rep-entrega-overlay')?.remove();
    this.renderList(); this.renderDetail();
    toast(`Equipo entregado correctamente.`);
  },

  // ── Cancelar con reversión ────────────────────────────
  async cancelarConReversion() {
    const o = State.reparaciones.find(x => x.id === this.currentId);
    if (!o) return;
    if (!confirm(`¿Cancelar la orden ${o.id}? Los pagos se revertirán en sus cajas y los repuestos de stock volverán al inventario.`)) return;
    o.pagos.forEach(p => State.debitarCaja(p.persona, p.bolsillo, p.monto));
    for (const r of (o.repuestos || []).filter(r => r.fromStock && r.stockId)) {
      const item = State.stock.find(s => s.id === r.stockId);
      if (item && !item.imeis) { item.cantidad = (item.cantidad || 0) + 1; await DB.actualizarCantidadStock(r.stockId, item.cantidad); }
    }
    await DB.limpiarMovimientosReparacion(o.id);
    o.pagos = []; o.repuestos = o.repuestos.filter(r => !r.fromStock);
    o.estado = 'rechazado'; o.equipoDevuelto = true; o.custodio = '';
    await DB.actualizarReparacion(o);
    this.renderList(); this.renderDetail();
    toast('Orden cancelada y movimientos revertidos.');
  },
};

window.Reparaciones = Reparaciones;
