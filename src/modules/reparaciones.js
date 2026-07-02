const Reparaciones = {
  currentId: null,
  ESTADOS: ['ingresado','diagnosticado','en_reparacion','listo','entregado'],
  ESTADO_LABEL: { ingresado:'Ingresado', diagnosticado:'Diagnosticado', en_reparacion:'En reparación', listo:'Listo', entregado:'Entregado', rechazado:'Rechazado', no_reparable:'No reparable' },
  ESTADO_CLASS: { ingresado:'b-gray', diagnosticado:'b-purple', en_reparacion:'b-blue', listo:'b-green', entregado:'b-teal', rechazado:'b-red', no_reparable:'b-red' },

  render() {
    const c = document.createElement('div');
    c.className = 'rep-shell';
    c.style.display = 'flex';
    c.style.flex = '1';
    c.style.overflow = 'hidden';
    c.innerHTML = `
      <div class="rep-list-panel" style="width:260px;min-width:260px;border-right:1px solid var(--border);display:flex;flex-direction:column;background:var(--bg-secondary)">
        <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <b style="font-size:13px">Órdenes (${State.reparaciones.length})</b>
          <button class="btn btn-sm btn-primary" onclick="Reparaciones.newOrder()"><i class="ti ti-plus"></i></button>
        </div>
        <div style="padding:8px 10px;border-bottom:1px solid var(--border)"><input type="text" id="rep-search" placeholder="Buscar..." oninput="Reparaciones.renderList()" style="width:100%;font-size:12px;padding:5px 9px;border:1px solid var(--border-strong);border-radius:8px"></div>
        <div style="flex:1;overflow-y:auto" id="rep-list"></div>
      </div>
      <div class="rep-detail-panel" style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;background:var(--bg-elevated)">
        <button class="btn btn-sm rep-back-btn" onclick="Reparaciones.backToList()" style="display:none;margin:10px 14px 0"><i class="ti ti-arrow-left"></i> Ver órdenes</button>
        <div id="rep-detail" style="flex:1;overflow-y:auto;padding:18px 20px"></div>
      </div>
    `;
    setTimeout(() => {
      if (!this.currentId && State.reparaciones.length) this.currentId = State.reparaciones[0].id;
      this.renderList();
      this.renderDetail();
      this.syncMobileView(false);
      this.bindResizeListener();
    }, 0);
    return c;
  },

  hasMovimientos(o) { return (o.pagos && o.pagos.length > 0) || (o.repuestos && o.repuestos.length > 0); },

  renderList() {
    const q = (document.getElementById('rep-search')?.value || '').toLowerCase();
    const filtered = State.reparaciones.filter(o => !q || o.cliente.toLowerCase().includes(q) || o.equipo.toLowerCase().includes(q) || o.id.toLowerCase().includes(q));
    document.getElementById('rep-list').innerHTML = filtered.map(o => {
      const flags = [];
      if (o.pagos?.length) flags.push(`<span class="badge b-green" style="font-size:9px">$ pago</span>`);
      if (o.repuestos?.length) flags.push(`<span class="badge b-amber" style="font-size:9px">repuesto</span>`);
      return `<div onclick="Reparaciones.select('${o.id}')" style="padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;${this.currentId===o.id?'background:var(--bg-secondary);border-left:2px solid var(--blue)':''}">
        <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:600">${o.id} — ${o.equipo}<span style="font-size:10px;color:var(--text-secondary);font-weight:400">${o.fechaIngreso}</span></div>
        <div style="font-size:11px;color:var(--text-secondary)">${o.cliente}</div>
        <div style="margin-top:5px;display:flex;gap:4px"><span class="badge ${this.ESTADO_CLASS[o.estado]}" style="font-size:9.5px">${this.ESTADO_LABEL[o.estado]}</span>${flags.join('')}</div>
      </div>`;
    }).join('');
  },
  select(id) { this.currentId = id; this.renderList(); this.renderDetail(); this.syncMobileView(true); },

  isMobile() { return window.innerWidth <= 900; },

  syncMobileView(showDetail) {
    const listPanel = document.querySelector('.rep-list-panel');
    const detailPanel = document.querySelector('.rep-detail-panel');
    const backBtn = document.querySelector('.rep-back-btn');
    if (!listPanel || !detailPanel) return;

    if (!this.isMobile()) {
      // Desktop: siempre las dos columnas visibles, sin botón de volver
      listPanel.style.display = 'flex';
      detailPanel.style.display = 'flex';
      if (backBtn) backBtn.style.display = 'none';
      return;
    }

    // Mobile: una sola columna visible por vez
    if (showDetail) {
      listPanel.style.display = 'none';
      listPanel.style.width = '';
      detailPanel.style.display = 'flex';
      if (backBtn) backBtn.style.display = 'inline-flex';
    } else {
      listPanel.style.display = 'flex';
      listPanel.style.width = '100%';
      detailPanel.style.display = 'none';
      if (backBtn) backBtn.style.display = 'none';
    }
  },

  backToList() {
    this.syncMobileView(false);
  },

  _resizeBound: false,
  bindResizeListener() {
    if (this._resizeBound) return;
    this._resizeBound = true;
    window.addEventListener('resize', () => {
      if (document.querySelector('.rep-list-panel')) this.syncMobileView(this.isMobile() && !!this.currentId && document.querySelector('.rep-detail-panel')?.style.display === 'flex');
    });
  },

  renderDetail() {
    const o = State.reparaciones.find(x => x.id === this.currentId);
    const detail = document.getElementById('rep-detail');
    if (!o) { detail.innerHTML = `<div class="empty-state"><i class="ti ti-tool"></i>Seleccioná una orden</div>`; return; }

    const totalCosto = o.costoMO + o.repuestos.reduce((a, r) => a + r.costo, 0);
    const margen = o.precioFinal - totalCosto;
    const tieneMov = this.hasMovimientos(o);
    const isTerminal = ['rechazado', 'no_reparable'].includes(o.estado);

    let movInfo = '';
    if (isTerminal) {
      movInfo = tieneMov
        ? `<div style="background:var(--red-light);border:1px solid #F09595;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:11.5px;color:var(--red)"><b style="display:block;margin-bottom:3px">⚠ Esta orden tiene movimientos asociados</b>Usá "Cancelar orden" para revertir pagos y repuestos de stock.</div>`
        : `<div style="background:var(--green-light);border:1px solid #97C459;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:11.5px;color:var(--green)"><b style="display:block;margin-bottom:3px">✓ Sin movimientos asociados</b>Equipo marcado automáticamente como devuelto al cliente.</div>`;
    }

    detail.innerHTML = `
      <div class="rep-detail-header" style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <h2 style="font-size:15px;font-weight:600;flex:1;min-width:0">${o.id} — ${o.equipo}<br><span style="font-size:12px;color:var(--text-secondary);font-weight:400">${o.cliente}</span></h2>
        <span class="badge ${this.ESTADO_CLASS[o.estado]}" style="flex-shrink:0">${this.ESTADO_LABEL[o.estado]}</span>
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:14px">
        ${this.ESTADOS.map(s => `<span onclick="Reparaciones.setEstado('${s}')" style="font-size:11px;padding:5px 11px;border-radius:20px;border:1.5px solid ${o.estado===s?'var(--blue)':'var(--border-strong)'};background:${o.estado===s?'var(--blue-light)':'var(--bg)'};color:${o.estado===s?'var(--blue)':'var(--text-secondary)'};cursor:pointer">${this.ESTADO_LABEL[s]}</span>`).join('')}
        <span onclick="Reparaciones.setEstado('rechazado')" style="font-size:11px;padding:5px 11px;border-radius:20px;border:1.5px solid #F09595;background:${o.estado==='rechazado'?'var(--red-light)':'var(--bg)'};color:${o.estado==='rechazado'?'var(--red)':'var(--text-secondary)'};cursor:pointer">Rechazado</span>
        <span onclick="Reparaciones.setEstado('no_reparable')" style="font-size:11px;padding:5px 11px;border-radius:20px;border:1.5px solid #F09595;background:${o.estado==='no_reparable'?'var(--red-light)':'var(--bg)'};color:${o.estado==='no_reparable'?'var(--red)':'var(--text-secondary)'};cursor:pointer">No reparable</span>
      </div>
      ${movInfo}
      <div style="background:var(--red-light);border:1px solid #F09595;border-radius:8px;padding:10px 12px;margin-bottom:14px;display:flex;align-items:center;gap:10px">
        <i class="ti ti-lock" style="font-size:18px;color:var(--red)"></i>
        <div style="flex:1"><div style="font-size:12px;font-weight:600;color:var(--red)">Clave de desbloqueo</div></div>
        <div style="font-family:monospace;font-size:14px;font-weight:600;background:#fff;padding:4px 10px;border-radius:6px;color:var(--red)">${o.clave||'—'}</div>
      </div>
      <div class="card"><div class="card-title"><i class="ti ti-stethoscope"></i> Diagnóstico</div>
        <p style="font-size:12.5px;background:var(--purple-light);padding:10px;border-radius:8px;color:var(--purple)">${o.diagnostico || 'Pendiente de diagnóstico'}</p>
      </div>
      <div class="card"><div class="card-title"><i class="ti ti-tool"></i> Repuestos utilizados</div>
        ${o.repuestos.length ? o.repuestos.map(r => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px"><span>${r.nombre} ${r.fromStock?'<span style="color:var(--text-secondary);font-size:10px">(de stock)</span>':'<span style="color:var(--text-secondary);font-size:10px">(compra externa)</span>'}</span><b>USD ${r.costo}</b></div>`).join('') : '<p style="font-size:12px;color:var(--text-secondary)">Sin repuestos cargados</p>'}
        <button class="btn btn-sm" style="margin-top:8px" onclick="Reparaciones.addRepuesto()"><i class="ti ti-plus"></i> Agregar repuesto</button>
      </div>
      <div class="card"><div class="card-title"><i class="ti ti-credit-card"></i> Pagos / señas</div>
        ${o.pagos.length ? o.pagos.map(p => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">${p.caja}<b>${State.fmtARS(p.monto)}</b></div>`).join('') : '<p style="font-size:12px;color:var(--text-secondary)">Sin pagos registrados</p>'}
        <button class="btn btn-sm" style="margin-top:8px" onclick="Reparaciones.addPago()"><i class="ti ti-plus"></i> Registrar seña</button>
      </div>
      <div class="card"><div class="card-title"><i class="ti ti-currency-dollar"></i> Costos y precio</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
          <div><label style="font-size:11px;color:var(--text-secondary)">Mano de obra</label><input type="number" id="rep-f-mo" value="${o.costoMO}" style="width:100%;font-size:12px;padding:6px 9px;border:1px solid var(--border-strong);border-radius:8px"></div>
          <div><label style="font-size:11px;color:var(--text-secondary)">Precio cobrado</label><input type="number" id="rep-f-precio" value="${o.precioFinal}" style="width:100%;font-size:12px;padding:6px 9px;border:1px solid var(--border-strong);border-radius:8px"></div>
        </div>
        <div style="background:var(--blue-light);border-radius:8px;padding:10px;display:flex;justify-content:space-around;text-align:center">
          <div><label style="font-size:10px;color:var(--blue)">Costo</label><div style="font-weight:600;color:var(--blue)">${State.fmtARS(totalCosto)}</div></div>
          <div><label style="font-size:10px;color:var(--blue)">Precio</label><div style="font-weight:600;color:var(--blue)">${State.fmtARS(o.precioFinal)}</div></div>
          <div><label style="font-size:10px;color:var(--blue)">Margen</label><div style="font-weight:600;color:${margen>=0?'var(--green)':'var(--red)'}">${margen>=0?'+':''}${State.fmtARS(margen)}</div></div>
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
        ${isTerminal && tieneMov ? `<button class="btn btn-red" onclick="Reparaciones.cancelarConReversion()"><i class="ti ti-arrow-back-up"></i> Cancelar orden (revertir)</button>` : ''}
        ${o.estado === 'listo' ? `<button class="btn btn-green" onclick="Reparaciones.entregarYCobrar()"><i class="ti ti-check"></i> Entregar y cobrar</button>` : `<button class="btn btn-primary" onclick="Reparaciones.saveOrder()"><i class="ti ti-check"></i> Guardar cambios</button>`}
      </div>
    `;
  },

  async setEstado(estado) {
    const o = State.reparaciones.find(x => x.id === this.currentId);
    if (!o) return;
    o.estado = estado;
    if (['rechazado', 'no_reparable'].includes(estado) && !this.hasMovimientos(o)) {
      o.equipoDevuelto = true; o.custodio = '';
      toast('Equipo marcado como devuelto al cliente automáticamente (sin movimientos que revertir).');
    }
    await DB.actualizarReparacion(o);
    Sheets.reparacion(o);
    this.renderList(); this.renderDetail();
  },

  async addRepuesto() {
    const fromStockChoice = confirm('¿Es un repuesto que sale de tu stock? Aceptar = sí, de stock. Cancelar = compra externa.');
    const nombre = prompt('Nombre del repuesto:');
    if (!nombre) return;
    const costo = parseFloat(prompt('Costo en USD:', '0')) || 0;
    const o = State.reparaciones.find(x => x.id === this.currentId);
    const repuesto = { nombre, costo, fromStock: fromStockChoice };
    o.repuestos.push(repuesto);
    await DB.agregarRepuestoReparacion(o.id, repuesto);
    this.renderList(); this.renderDetail();
  },

  async addPago() {
    const monto = parseFloat(prompt('Monto de la seña (ARS):', '0')) || 0;
    if (!monto) return;
    const persona = prompt('¿Qué persona recibe el pago?', 'Valen') || 'Valen';
    const o = State.reparaciones.find(x => x.id === this.currentId);
    const pago = { caja: `${persona}-ARS cash`, monto, persona, bolsillo: 'ARS cash' };
    o.pagos.push(pago);
    State.acreditarCaja(persona, 'ARS cash', monto);
    await DB.agregarPagoReparacion(o.id, pago);
    this.renderList(); this.renderDetail();
    toast(`Seña de ${State.fmtARS(monto)} acreditada en la caja de ${persona}.`);
  },

  async cancelarConReversion() {
    const o = State.reparaciones.find(x => x.id === this.currentId);
    if (!confirm('¿Cancelar esta orden? Se revertirán los pagos en sus cajas y los repuestos de stock volverán al inventario.')) return;

    toast('Revirtiendo movimientos...');
    // Revertir pagos
    o.pagos.forEach(p => State.debitarCaja(p.persona, p.bolsillo, p.monto));
    // Revertir repuestos que salieron de stock (sumarlos de nuevo al inventario)
    for (const r of o.repuestos.filter(r => r.fromStock && r.stockId)) {
      const item = State.stock.find(s => s.id === r.stockId);
      if (item) {
        if (item.imeis) { /* repuestos no manejan IMEI individual en esta maqueta */ }
        else { item.cantidad = (item.cantidad || 0) + 1; await DB.actualizarCantidadStock(r.stockId, item.cantidad); }
      }
    }
    await DB.limpiarMovimientosReparacion(o.id);
    o.pagos = [];
    o.repuestos = o.repuestos.filter(r => !r.fromStock);
    o.equipoDevuelto = true; o.custodio = '';
    await DB.actualizarReparacion(o);
    this.renderList(); this.renderDetail();
    toast('Orden cancelada. Pagos revertidos a sus cajas de origen y repuestos de stock restaurados.');
  },

  async entregarYCobrar() {
    const o = State.reparaciones.find(x => x.id === this.currentId);
    const persona = o.custodio || prompt('¿En qué caja se acredita el cobro?', 'Valen') || 'Valen';
    State.acreditarCaja(persona, 'ARS cash', o.precioFinal);
    o.estado = 'entregado';
    await DB.actualizarReparacion(o);
    this.renderList(); this.renderDetail();
    toast(`Equipo entregado. ${State.fmtARS(o.precioFinal)} acreditado en la caja de ${persona}.`);
  },

  async saveOrder() {
    const o = State.reparaciones.find(x => x.id === this.currentId);
    o.costoMO = parseFloat(document.getElementById('rep-f-mo').value) || 0;
    o.precioFinal = parseFloat(document.getElementById('rep-f-precio').value) || 0;
    await DB.actualizarReparacion(o);
    Sheets.reparacion(o);
    this.renderDetail();
    toast('Cambios guardados.');
  },

  async newOrder() {
    const id = 'R0' + (20 + State.reparaciones.length);
    const o = { id, cliente: 'Nuevo cliente', tel: '', equipo: 'Sin especificar', falla: '', clave: '', estado: 'ingresado', fechaIngreso: 'Hoy', diagnostico: '', presupuestoAprobado: false, repuestos: [], pagos: [], costoMO: 0, precioFinal: 0, tecnico: 'Técnico ext.', custodio: '', notas: '', equipoDevuelto: false };
    await DB.crearReparacion(o);
    Sheets.reparacion(o);
    State.reparaciones.unshift(o);
    this.currentId = id;
    this.renderList(); this.renderDetail();
    this.syncMobileView(true);
  }
};


window.Reparaciones = Reparaciones;
