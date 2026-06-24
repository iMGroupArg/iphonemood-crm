const Panel = {
  activeTab: 'garantias',

  render() {
    const c = document.createElement('div');
    c.className = 'panel-shell';
    c.style.display = 'flex';
    c.style.flex = '1';
    c.style.overflow = 'hidden';
    c.innerHTML = `
      <div class="panel-nav-side" id="panel-nav" style="width:200px;min-width:200px;border-right:1px solid var(--border);background:var(--bg-secondary);padding:8px 0;flex-shrink:0"></div>
      <div style="flex:1;overflow-y:auto;padding:18px 22px;min-width:0;background:var(--bg-elevated)" id="panel-body"></div>
    `;
    setTimeout(() => { this.renderNav(); this.renderBody(); }, 0);
    return c;
  },

  renderNav() {
    const items = [
      ['cotizaciones', 'ti ti-currency-dollar', 'Cotizaciones'],
      ['formas-pago', 'ti ti-credit-card', 'Formas de pago'],
      ['garantias', 'ti ti-shield', 'Garantías'],
      ['personas', 'ti ti-users', 'Cajas y personas'],
      ['usuarios', 'ti ti-lock', 'Usuarios y accesos'],
      ['negocio', 'ti ti-building-store', 'Datos del negocio'],
      ['exportar', 'ti ti-file-spreadsheet', 'Exportar todo'],
    ];
    document.getElementById('panel-nav').innerHTML = items.map(([k, ic, l]) =>
      `<div class="panel-nav-item" onclick="Panel.setTab('${k}')" style="display:flex;align-items:center;gap:9px;padding:8px 16px;cursor:pointer;font-size:12.5px;white-space:nowrap;color:${this.activeTab===k?'var(--blue)':'var(--text-secondary)'};border-left:2px solid ${this.activeTab===k?'var(--blue)':'transparent'};background:${this.activeTab===k?'var(--bg)':'transparent'};font-weight:${this.activeTab===k?'600':'400'}"><i class="${ic}"></i> ${l}</div>`
    ).join('');
  },
  setTab(t) { this.activeTab = t; this.renderNav(); this.renderBody(); },

  renderBody() {
    const body = document.getElementById('panel-body');
    if (this.activeTab === 'cotizaciones') body.innerHTML = this.cotizacionesView();
    else if (this.activeTab === 'formas-pago') { body.innerHTML = this.formasPagoView(); this.renderFormasPagoList(); }
    else if (this.activeTab === 'garantias') body.innerHTML = this.garantiasView();
    else if (this.activeTab === 'personas') body.innerHTML = this.personasView();
    else if (this.activeTab === 'usuarios') { body.innerHTML = this.usuariosView(); this.cargarUsuarios(); }
    else if (this.activeTab === 'exportar') body.innerHTML = this.exportarView();
    else body.innerHTML = this.negocioView();
  },

  garantiasView() {
    return `
      <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;margin-bottom:12px;border-bottom:1px solid var(--border);padding-bottom:8px">Categorías de garantía</h3>
      <div id="garantias-list">${State.garantias.map(g => `
        <div style="display:flex;align-items:center;gap:10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:8px">
          <span style="width:12px;height:12px;border-radius:50%;background:${g.color}"></span>
          <div style="flex:1"><b style="font-size:13px">${g.nombre}</b></div>
          <div style="font-size:18px;font-weight:600;color:var(--blue)">${g.dias}<span style="font-size:10px;color:var(--text-secondary);display:block;font-weight:400">días</span></div>
          <button class="btn btn-sm" onclick="Panel.editGarantia('${g.id}')"><i class="ti ti-edit"></i></button>
          <button class="btn btn-sm" onclick="Panel.delGarantia('${g.id}')" style="color:var(--red)"><i class="ti ti-trash"></i></button>
        </div>`).join('')}</div>
      <button class="btn btn-primary" onclick="Panel.addGarantia()"><i class="ti ti-plus"></i> Nueva categoría</button>
    `;
  },
  async addGarantia() {
    const nombre = prompt('Nombre de la categoría:'); if (!nombre) return;
    const dias = parseInt(prompt('Días de garantía:', '30')); if (!dias) return;
    const nueva = await DB.agregarGarantia(nombre, dias, '#185FA5');
    State.garantias.push({ id: nueva?.id || Date.now(), nombre, dias, color: '#185FA5' });
    this.renderBody();
  },
  async editGarantia(id) {
    const g = State.garantias.find(x => x.id === id);
    const dias = parseInt(prompt(`Días de garantía para "${g.nombre}":`, g.dias));
    if (dias) { g.dias = dias; await DB.editarGarantia(id, dias); this.renderBody(); }
  },
  async delGarantia(id) {
    if (!confirm('¿Eliminar esta categoría?')) return;
    await DB.borrarGarantia(id);
    State.garantias = State.garantias.filter(x => x.id !== id);
    this.renderBody();
  },

  personasView() {
    return `
      <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;margin-bottom:12px;border-bottom:1px solid var(--border);padding-bottom:8px">Personas y sus cajas</h3>
      ${State.personas.map(p => {
        const saldoTotal = this.saldoTotalPersona(p);
        return `
        <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
            <div>
              <b style="font-size:13px">${p}</b>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">Equivalente en caja: ${State.fmtARS(saldoTotal)}</div>
            </div>
            <div style="display:flex;gap:6px">
              <button class="btn btn-sm" onclick="Panel.renombrarPersona('${p}')"><i class="ti ti-edit"></i> Renombrar</button>
              <button class="btn btn-sm" style="color:var(--red)" onclick="Panel.eliminarPersona('${p}')"><i class="ti ti-trash"></i> Eliminar</button>
            </div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:10px">
            ${Object.entries(State.cajas[p] || {}).map(([b, saldo]) => `
              <span class="badge b-blue" style="cursor:pointer" onclick="Panel.editarSaldoCaja('${p}','${b}')" title="Tocar para editar el saldo">${b}: ${b==='USDT' ? saldo.toLocaleString('es-AR') : (b.startsWith('ARS')?State.fmtARS(saldo):State.fmtUSD(saldo))}</span>
            `).join('')}
          </div>
        </div>`;
      }).join('')}
      <button class="btn btn-primary" onclick="Panel.addPersona()"><i class="ti ti-plus"></i> Agregar persona</button>
    `;
  },

  saldoTotalPersona(p) {
    const c = State.cajas[p] || {};
    return (c['ARS cash']||0) + (c['ARS transferencia']||0) + ((c['USD cash']||0)+(c['USD transferencia']||0))*State.refBlue + (c['USDT']||0)*State.refUsdt;
  },

  async renombrarPersona(nombreViejo) {
    const nombreNuevo = prompt(`Nuevo nombre para "${nombreViejo}":`, nombreViejo);
    if (!nombreNuevo || nombreNuevo.trim() === '' || nombreNuevo === nombreViejo) return;
    if (State.personas.includes(nombreNuevo)) { alert('Ya existe una persona con ese nombre.'); return; }

    const { error } = await DB.renombrarPersona(nombreViejo, nombreNuevo);
    if (error) { alert('Hubo un problema renombrando. Probá de nuevo.'); console.error(error); return; }

    // Actualizar en memoria: lista de personas y el objeto de cajas
    State.personas = State.personas.map(p => p === nombreViejo ? nombreNuevo : p);
    State.cajas[nombreNuevo] = State.cajas[nombreViejo];
    delete State.cajas[nombreViejo];

    this.renderBody();
    toast(`"${nombreViejo}" ahora se llama "${nombreNuevo}". Las cajas y el historial quedaron asociados al nuevo nombre.`);
  },

  async eliminarPersona(nombre) {
    const saldo = this.saldoTotalPersona(nombre);
    if (saldo !== 0) {
      alert(`No se puede eliminar a "${nombre}" porque todavía tiene saldo en sus cajas (equivalente a ${State.fmtARS(saldo)}). Mové ese saldo a otra persona antes de eliminarla, usando el módulo de Cueva / cambio o ajustando el saldo manualmente.`);
      return;
    }
    if (!confirm(`¿Eliminar a "${nombre}"? Sus cajas (en $0) se van a borrar. Las ventas, reparaciones y gastos donde haya participado se conservan en el historial, solo se desvincula su nombre de la persona.`)) return;

    const { error } = await DB.borrarPersona(nombre);
    if (error) { alert('Hubo un problema eliminando. Probá de nuevo.'); console.error(error); return; }

    State.personas = State.personas.filter(p => p !== nombre);
    delete State.cajas[nombre];
    this.renderBody();
  },

  async editarSaldoCaja(persona, bolsillo) {
    const actual = (State.cajas[persona] && State.cajas[persona][bolsillo]) || 0;
    const nuevoStr = prompt(`Ajustar saldo de ${persona} — ${bolsillo}:`, actual);
    if (nuevoStr === null) return;
    const nuevo = parseFloat(nuevoStr);
    if (isNaN(nuevo)) { alert('Ingresá un número válido.'); return; }
    State.cajas[persona][bolsillo] = nuevo;
    await DB.actualizarSaldoCaja(persona, bolsillo, nuevo);
    Sheets.caja(persona, bolsillo, nuevo);
    this.renderBody();
    toast(`Saldo de ${persona} — ${bolsillo} ajustado a ${nuevo.toLocaleString('es-AR')}.`);
  },
  async addPersona() {
    const nombre = prompt('Nombre de la nueva persona:'); if (!nombre) return;
    await DB.agregarPersona(nombre);
    State.personas.push(nombre);
    State.cajas[nombre] = { 'ARS cash': 0, 'ARS transferencia': 0, 'USD cash': 0, 'USD transferencia': 0, 'USDT': 0 };
    this.renderBody();
  },

  cotizacionesView() {
    return `
      <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;margin-bottom:12px;border-bottom:1px solid var(--border);padding-bottom:8px">Cotizaciones del día</h3>
      <div style="background:var(--blue-light);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:11.5px;color:var(--blue)">
        <i class="ti ti-info-circle"></i> Estos valores se usan en toda la app: precios de venta, conversiones de gastos, cierres de mes, etc. Actualizalos al empezar el día.
      </div>
      <div class="card">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <div>
            <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Dólar Blue</label>
            <input type="number" id="cf-blue" value="${State.refBlue}" style="width:100%;font-size:16px;font-weight:600;padding:9px 12px;border:1px solid var(--border-strong);border-radius:8px">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">USDT</label>
            <input type="number" id="cf-usdt" value="${State.refUsdt}" style="width:100%;font-size:16px;font-weight:600;padding:9px 12px;border:1px solid var(--border-strong);border-radius:8px">
          </div>
        </div>
        <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:14px" onclick="Panel.guardarCotizaciones()"><i class="ti ti-check"></i> Actualizar cotizaciones</button>
      </div>
    `;
  },

  guardarCotizaciones() {
    const blue = parseFloat(document.getElementById('cf-blue').value) || State.refBlue;
    const usdt = parseFloat(document.getElementById('cf-usdt').value) || State.refUsdt;
    State.refBlue = blue;
    State.refUsdt = usdt;
    const topbarBlue = document.getElementById('topbar-blue');
    const topbarUsdt = document.getElementById('topbar-usdt');
    if (topbarBlue) topbarBlue.textContent = blue;
    if (topbarUsdt) topbarUsdt.textContent = usdt;
    toast(`Cotizaciones actualizadas: Blue $${blue} · USDT $${usdt}.`);
  },

  formasPagoView() {
    if (!State.formasPago) State.formasPago = ['Efectivo', 'Transferencia', 'Tarjeta de crédito', 'Tarjeta de débito', 'USDT'];
    return `
      <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;margin-bottom:12px;border-bottom:1px solid var(--border);padding-bottom:8px">Formas de pago</h3>
      <p style="font-size:11.5px;color:var(--text-secondary);margin-bottom:14px">Lista de referencia de los medios de cobro que usás. El pago con tarjeta se carga desde Ventas marcando la opción correspondiente sobre una transferencia, e incluye el diferencial cobrado.</p>
      <div id="formas-pago-list"></div>
      <button class="btn btn-primary" style="margin-top:8px" onclick="Panel.addFormaPago()"><i class="ti ti-plus"></i> Agregar forma de pago</button>
    `;
  },
  renderFormasPagoList() {
    document.getElementById('formas-pago-list').innerHTML = State.formasPago.map((f, i) => `
      <div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border)">
        <i class="ti ti-grip-vertical" style="color:var(--text-secondary)"></i>
        <input type="text" value="${f}" onchange="Panel.editFormaPago(${i}, this.value)" style="flex:1;font-size:12.5px;padding:6px 10px;border:1px solid var(--border-strong);border-radius:8px">
        <button onclick="Panel.delFormaPago(${i})" style="background:none;border:none;cursor:pointer;color:var(--red)"><i class="ti ti-trash"></i></button>
      </div>
    `).join('');
  },
  editFormaPago(i, val) { State.formasPago[i] = val; },
  addFormaPago() {
    const nombre = prompt('Nueva forma de pago:');
    if (!nombre) return;
    State.formasPago.push(nombre);
    this.renderFormasPagoList();
  },
  delFormaPago(i) {
    if (!confirm('¿Eliminar esta forma de pago de la lista?')) return;
    State.formasPago.splice(i, 1);
    this.renderFormasPagoList();
  },

  exportarView() {
    return `
      <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;margin-bottom:12px;border-bottom:1px solid var(--border);padding-bottom:8px">Exportar todo a Excel</h3>
      <p style="font-size:11.5px;color:var(--text-secondary);margin-bottom:14px">Descargá un archivo Excel con una pestaña por cada módulo: Ventas, Stock, Reparaciones, Gastos y Cueva. Útil para análisis externos o respaldos puntuales.</p>
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)"><span style="font-size:12.5px"><i class="ti ti-receipt"></i> Ventas</span><span style="font-size:11px;color:var(--text-secondary)">${State.ventas.length} registros</span></div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)"><span style="font-size:12.5px"><i class="ti ti-box"></i> Stock</span><span style="font-size:11px;color:var(--text-secondary)">${State.stock.length} registros</span></div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)"><span style="font-size:12.5px"><i class="ti ti-tool"></i> Reparaciones</span><span style="font-size:11px;color:var(--text-secondary)">${State.reparaciones.length} registros</span></div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)"><span style="font-size:12.5px"><i class="ti ti-arrow-down-circle"></i> Gastos</span><span style="font-size:11px;color:var(--text-secondary)">${State.gastos.length} registros</span></div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0"><span style="font-size:12.5px"><i class="ti ti-arrows-exchange"></i> Cueva / cambio</span><span style="font-size:11px;color:var(--text-secondary)">${State.cambios.length} registros</span></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:14px" onclick="Panel.exportarTodoExcel()"><i class="ti ti-file-spreadsheet"></i> Descargar Excel completo</button>
      </div>
    `;
  },

  exportarTodoExcel() {
    if (typeof XLSX === 'undefined') { toast('No se pudo cargar el módulo de exportación. Revisá tu conexión a internet.'); return; }
    const wb = XLSX.utils.book_new();

    const wsVentas = XLSX.utils.json_to_sheet(State.ventas.map(v => ({
      'ID': v.id, 'Fecha': v.fecha, 'Cliente': v.cliente, 'Vendedor': v.vendedor || '',
      'Ítems': v.items.map(i=>i.nombre).join(', '), 'Total USD': v.items.reduce((s,i)=>s+i.precio,0),
      'Estado': v.estado, 'Diferencial tarjeta ARS': (v.pagos||[]).filter(p=>p.esTarjeta).reduce((s,p)=>s+(p.diferencialArs||0),0)
    })));
    XLSX.utils.book_append_sheet(wb, wsVentas, 'Ventas');

    const wsStock = XLSX.utils.json_to_sheet(State.stock.map(p => ({
      'Producto': p.nombre, 'Rubro': Stock.CAT_LABELS[p.cat]||p.cat, 'Stock': State.getStock(p),
      'Costo USD': p.costoUSD, 'Precio USD': p.cotiz ? +(p.precioARS/p.cotiz).toFixed(2) : 0,
      'Proveedor': p.proveedor||'', 'Custodio': p.custodio||'', 'Estado': p.estadoInventario||'disponible'
    })));
    XLSX.utils.book_append_sheet(wb, wsStock, 'Stock');

    const wsRep = XLSX.utils.json_to_sheet(State.reparaciones.map(r => ({
      'ID': r.id, 'Fecha': r.fechaIngreso, 'Cliente': r.cliente, 'Equipo': r.equipo,
      'Estado': Reparaciones.ESTADO_LABEL[r.estado]||r.estado, 'Técnico': r.tecnico||'',
      'Costo MO': r.costoMO||0, 'Precio final': r.precioFinal||0
    })));
    XLSX.utils.book_append_sheet(wb, wsRep, 'Reparaciones');

    const wsGastos = XLSX.utils.json_to_sheet(State.gastos.map(g => ({
      'Fecha': g.fecha, 'Motivo': g.motivo, 'Categoría': Gastos.catObj(g.cat).nombre,
      'Responsable': g.responsable, 'Moneda': g.moneda, 'Monto': g.monto, 'Estado': g.estado,
      'Mes cierre': g.mesCierre||'', 'Es sueldo socio': g.esSueldoSocio?'Sí':'No'
    })));
    XLSX.utils.book_append_sheet(wb, wsGastos, 'Gastos');

    const wsCueva = XLSX.utils.json_to_sheet(State.cambios.map(c => ({
      'Fecha': c.fecha, 'Tipo': Cueva.typeObj(c.tipo)?.label||c.tipo,
      'Origen': `${c.origenP} (${c.origenB})`, 'Entrega': c.entrega,
      'Destino': `${c.destinoP} (${c.destinoB})`, 'Recibe': c.recibe, 'Cotización': c.cotiz
    })));
    XLSX.utils.book_append_sheet(wb, wsCueva, 'Cueva');

    const fecha = new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `iPhoneMood-Completo-${fecha}.xlsx`);
    toast('Excel completo descargado.');
  },

  negocioView() {
    return `
      <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;margin-bottom:12px;border-bottom:1px solid var(--border);padding-bottom:8px">Datos del negocio</h3>
      <div class="card">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
          <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600">Nombre</label><input type="text" value="iPhoneMood" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;margin-top:4px"></div>
          <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600">Email</label><input type="text" value="iphonemood.ar@gmail.com" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;margin-top:4px"></div>
        </div>
        <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600">Dirección</label><input type="text" value="Julio Argentino Roca 700, Granadero Baigorria, Santa Fe" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;margin-top:4px"></div>
      </div>
    `;
  },

  usuariosView() {
    return `
      <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;margin-bottom:12px;border-bottom:1px solid var(--border);padding-bottom:8px">Usuarios y accesos</h3>
      <div style="background:var(--blue-light);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:11.5px;color:var(--blue)">
        <i class="ti ti-info-circle"></i> Solo las cuentas de Gmail listadas acá pueden iniciar sesión en la app. Si alguien intenta entrar con un email que no está en esta lista, va a ver un mensaje de acceso denegado.
      </div>
      <div id="usuarios-list" style="margin-bottom:14px"><div class="empty-state"><i class="ti ti-loader-2"></i>Cargando usuarios...</div></div>
      <div class="card">
        <div class="card-title" style="margin-bottom:10px"><i class="ti ti-user-plus"></i> Agregar acceso</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
          <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600">Email de Gmail</label><input type="email" id="new-user-email" placeholder="persona@gmail.com" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;margin-top:4px"></div>
          <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600">Nombre (opcional)</label><input type="text" id="new-user-nombre" placeholder="ej: Valen" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;margin-top:4px"></div>
        </div>
        <button class="btn btn-primary" onclick="Panel.agregarUsuario()"><i class="ti ti-plus"></i> Dar acceso</button>
      </div>
    `;
  },

  async cargarUsuarios() {
    const usuarios = await Auth.listarUsuariosAutorizados();
    const host = document.getElementById('usuarios-list');
    if (!host) return;
    if (!usuarios.length) { host.innerHTML = `<div class="empty-state"><i class="ti ti-user-off"></i>Todavía no hay usuarios autorizados cargados</div>`; return; }
    host.innerHTML = usuarios.map(u => `
      <div style="display:flex;align-items:center;gap:10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin-bottom:8px">
        <div class="av">${(u.nombre || u.email).substring(0,2).toUpperCase()}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12.5px;font-weight:600">${u.nombre || '(sin nombre)'}</div>
          <div style="font-size:11px;color:var(--text-secondary);word-break:break-all">${u.email}</div>
        </div>
        <span class="badge ${u.activo ? 'b-green' : 'b-gray'}" style="cursor:pointer" onclick="Panel.toggleUsuario('${u.id}', ${!u.activo})">${u.activo ? 'Activo' : 'Inactivo'}</span>
        <button class="btn btn-sm" style="color:var(--red)" onclick="Panel.quitarUsuario('${u.id}','${u.email}')"><i class="ti ti-trash"></i></button>
      </div>
    `).join('');
  },

  async agregarUsuario() {
    const emailInput = document.getElementById('new-user-email');
    const nombreInput = document.getElementById('new-user-nombre');
    const email = emailInput.value.trim().toLowerCase();
    const nombre = nombreInput.value.trim();
    if (!email || !email.includes('@')) { alert('Ingresá un email válido.'); return; }

    const { error } = await Auth.agregarUsuarioAutorizado(email, nombre);
    if (error) {
      if (error.code === '23505') alert('Ese email ya tiene acceso autorizado.');
      else { alert('Hubo un problema agregando el usuario.'); console.error(error); }
      return;
    }
    emailInput.value = '';
    nombreInput.value = '';
    this.cargarUsuarios();
    toast(`${email} ya puede iniciar sesión en la app con su cuenta de Google.`);
  },

  async toggleUsuario(id, nuevoEstado) {
    await Auth.toggleUsuarioActivo(id, nuevoEstado);
    this.cargarUsuarios();
  },

  async quitarUsuario(id, email) {
    if (!confirm(`¿Quitar el acceso de ${email}? Esa persona ya no va a poder iniciar sesión.`)) return;
    await Auth.quitarUsuarioAutorizado(id);
    this.cargarUsuarios();
  }
};


window.Panel = Panel;
