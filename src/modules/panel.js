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
      ['categorias-gasto', 'ti ti-tag', 'Categorías gasto'],
      ['personas', 'ti ti-users', 'Cajas y personas'],
      ['usuarios', 'ti ti-lock', 'Usuarios y accesos'],
      ['negocio', 'ti ti-building-store', 'Datos del negocio'],
      ['marca', 'ti ti-palette', 'Logo y tipografía'],
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
    else if (this.activeTab === 'categorias-gasto') body.innerHTML = this.categoriasGastoView();
    else if (this.activeTab === 'personas') body.innerHTML = this.personasView();
    else if (this.activeTab === 'usuarios') { body.innerHTML = this.usuariosView(); this.cargarUsuarios(); }
    else if (this.activeTab === 'marca') { body.innerHTML = this.marcaView(); this._initMarcaPreview(); }
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
          <button class="btn btn-sm" onclick="Panel.editGarantia('${g.id}')">✏️</button>
          <button class="btn btn-sm" onclick="Panel.delGarantia('${g.id}')" style="color:var(--red)">🗑️</button>
        </div>`).join('')}</div>
      <button class="btn btn-primary" onclick="Panel.addGarantia()"><i class="ti ti-plus"></i> Nueva categoría</button>

      <!-- Condiciones de garantía para el recibo -->
      <div style="margin-top:24px;border-top:1px solid var(--border);padding-top:18px">
        <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">Condiciones de garantía en el recibo</h3>
        <p style="font-size:11px;color:var(--text-secondary);margin-bottom:10px">Este texto aparece en la sección "Términos y condiciones" de cada recibo generado. Usalo para agregar tu descargo de responsabilidad como marca.</p>
        <textarea id="panel-condiciones-garantia" rows="6" style="width:100%;font-size:12.5px;padding:10px 12px;border:1px solid var(--border-strong);border-radius:10px;color:var(--text);background:var(--bg-secondary);resize:vertical;font-family:inherit">${State.condicionesGarantia}</textarea>
        <div style="display:flex;justify-content:flex-end;margin-top:8px">
          <button class="btn btn-primary" onclick="Panel.guardarCondicionesGarantia()"><i class="ti ti-device-floppy"></i> Guardar condiciones</button>
        </div>
      </div>
    `;
  },
  guardarCondicionesGarantia() {
    const txt = document.getElementById('panel-condiciones-garantia')?.value || '';
    State.condicionesGarantia = txt;
    localStorage.setItem('im_condiciones_garantia', txt);
    toast('Condiciones de garantía guardadas.');
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

  categoriasGastoView() {
    const cats = State.categoriasGasto || [];
    const COLORS = ['#FF453A','#FF9F0A','#FFD60A','#30D158','#0A84FF','#5E5CE6','#BF5AF2','#6C6C70'];
    return `
      <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;margin-bottom:12px;border-bottom:1px solid var(--border);padding-bottom:8px">Categorías de gasto</h3>
      <div id="cats-gasto-list">
        ${cats.map(c => {
          const enUso = (State.gastos||[]).some(g => g.cat === c.id);
          return `<div style="display:flex;align-items:center;gap:10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:8px">
            <span style="width:12px;height:12px;border-radius:50%;background:${c.color};flex-shrink:0"></span>
            <div style="flex:1;font-size:13px;font-weight:600">${c.nombre}</div>
            ${enUso ? `<span class="badge b-gray" style="font-size:10px">En uso (${(State.gastos||[]).filter(g=>g.cat===c.id).length})</span>` : ''}
            <button class="btn btn-sm" onclick="Panel.editCatGasto('${c.id}')">✏️</button>
            <button class="btn btn-sm" style="color:${enUso?'var(--text-secondary)':'var(--red)'}" ${enUso?'disabled title="Tiene gastos asociados, no se puede eliminar"':''} onclick="Panel.delCatGasto('${c.id}')">🗑️</button>
          </div>`;
        }).join('')}
      </div>
      <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;padding:14px;margin-top:14px">
        <div style="font-size:12px;font-weight:600;margin-bottom:10px">Nueva categoría</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
          <div style="flex:1;min-width:160px">
            <label style="font-size:10px;color:var(--text-secondary);display:block;margin-bottom:4px">Nombre *</label>
            <input id="nueva-cat-nombre" type="text" placeholder="ej: Servicios, Insumos…"
              style="width:100%;font-size:13px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;color:var(--text);background:var(--bg-secondary)">
          </div>
          <div>
            <label style="font-size:10px;color:var(--text-secondary);display:block;margin-bottom:4px">Color</label>
            <div style="display:flex;gap:5px;flex-wrap:wrap">
              ${COLORS.map((col,i) => `<span onclick="Panel._selColorCat('${col}')" id="cc-${col.replace('#','')}" style="width:22px;height:22px;border-radius:50%;background:${col};cursor:pointer;border:2px solid transparent;transition:border .12s"></span>`).join('')}
            </div>
            <input type="hidden" id="nueva-cat-color" value="${COLORS[0]}">
          </div>
          <button class="btn btn-primary" onclick="Panel.addCatGasto()"><i class="ti ti-plus"></i> Agregar</button>
        </div>
      </div>
    `;
  },
  _selColorCat(col) {
    document.querySelectorAll('[id^="cc-"]').forEach(el => el.style.borderColor = 'transparent');
    const el = document.getElementById('cc-' + col.replace('#',''));
    if (el) el.style.borderColor = '#fff';
    const inp = document.getElementById('nueva-cat-color');
    if (inp) inp.value = col;
  },
  async addCatGasto() {
    const nombre = document.getElementById('nueva-cat-nombre')?.value.trim();
    const color = document.getElementById('nueva-cat-color')?.value || '#0A84FF';
    if (!nombre) { toast('Escribí un nombre para la categoría.'); return; }
    if ((State.categoriasGasto||[]).some(c => c.nombre.toLowerCase() === nombre.toLowerCase())) {
      toast('Ya existe una categoría con ese nombre.'); return;
    }
    const nueva = await DB.agregarCategoriaGasto(nombre, color);
    if (nueva) { if (!State.categoriasGasto) State.categoriasGasto = []; State.categoriasGasto.push({ id: nueva.id, nombre, color }); }
    toast(`Categoría "${nombre}" creada.`);
    this.renderBody();
  },
  async editCatGasto(id) {
    const c = (State.categoriasGasto||[]).find(x => x.id === id);
    if (!c) return;
    const nombre = prompt(`Nuevo nombre para "${c.nombre}":`, c.nombre);
    if (!nombre || nombre === c.nombre) return;
    await DB.editarCategoriaGasto(id, { nombre });
    c.nombre = nombre;
    this.renderBody();
    toast('Categoría actualizada.');
  },
  async delCatGasto(id) {
    const enUso = (State.gastos||[]).some(g => g.cat === id);
    if (enUso) { toast('No se puede eliminar: tiene gastos asociados.'); return; }
    if (!confirm('¿Eliminar esta categoría?')) return;
    await DB.borrarCategoriaGasto(id);
    State.categoriasGasto = (State.categoriasGasto||[]).filter(x => x.id !== id);
    this.renderBody();
    toast('Categoría eliminada.');
  },

  personasView() {
    const TIPO_BADGE = { socio: 'b-blue', empleado: 'b-green', proveedor: 'b-amber' };
    const TIPO_LABEL = { socio: 'Socio', empleado: 'Empleado', proveedor: 'Proveedor' };
    return `
      <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;margin-bottom:12px;border-bottom:1px solid var(--border);padding-bottom:8px">Personas y sus cajas</h3>
      <div style="background:var(--blue-light);border-radius:8px;padding:9px 12px;margin-bottom:14px;font-size:11.5px;color:var(--blue)">
        <i class="ti ti-info-circle"></i> Cada persona tiene sus propias cajas (ARS cash, ARS transferencia, USD cash, USD transferencia, USDT). Las cajas de proveedores representan plata que te tienen temporalmente.
      </div>
      ${State.personas.map(p => {
        const saldoTotal = this.saldoTotalPersona(p);
        const tipo = (State.personasTipo && State.personasTipo[p]) || 'socio';
        return `
        <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:8px">
              <div class="av" style="width:32px;height:32px;font-size:11px">${p.substring(0,2).toUpperCase()}</div>
              <div>
                <div style="display:flex;align-items:center;gap:6px">
                  <b style="font-size:13px">${p}</b>
                  <span class="badge ${TIPO_BADGE[tipo]}">${TIPO_LABEL[tipo]}</span>
                </div>
                <div style="font-size:11px;color:var(--text-secondary);margin-top:1px">Equiv. en caja: <b>${State.fmtARS(saldoTotal)}</b></div>
              </div>
            </div>
            <div style="display:flex;gap:6px">
              <button class="btn btn-sm" onclick="Panel.renombrarPersonaModal('${p}')">✏️</button>
              <button class="btn btn-sm" style="color:var(--red)" onclick="Panel.eliminarPersona('${p}')">🗑️</button>
            </div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:10px">
            ${Object.entries(State.cajas[p] || {}).map(([b, saldo]) => `
              <span class="badge b-blue" style="cursor:pointer" onclick="Cajas.abrirModal('${p}','${b}')" title="Tocar para editar el saldo">${b}: ${b==='USDT' ? saldo.toLocaleString('es-AR')+' USDT' : (b.startsWith('ARS')?State.fmtARS(saldo):State.fmtUSD(saldo))}</span>
            `).join('')}
          </div>
        </div>`;
      }).join('')}
      <button class="btn btn-primary" onclick="Panel.abrirModalPersona()"><i class="ti ti-plus"></i> Agregar persona</button>
    `;
  },

  abrirModalPersona(editar) {
    const overlay = document.createElement('div');
    overlay.id = 'persona-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(6px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(380px,96vw);overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border)">
          <div style="font-size:14px;font-weight:700">${editar ? 'Renombrar persona' : 'Nueva persona'}</div>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
          <div>
            <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Nombre</label>
            <input type="text" id="persona-modal-nombre" value="${editar || ''}" placeholder="Ej: Franco" autofocus
              style="width:100%;font-size:15px;padding:9px 12px;border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          ${!editar ? `<div>
            <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:6px">Tipo</label>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px" id="persona-tipo-selector">
              ${[['socio','Socio','ti-user-check'],['empleado','Empleado','ti-briefcase'],['proveedor','Proveedor','ti-truck']].map(([v,l,ic]) =>
                `<label style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:9px 6px;border:1px solid var(--border-strong);border-radius:8px;cursor:pointer;font-size:11px;text-align:center;transition:all .12s" onclick="Panel._selectTipo(this,'${v}')">
                  <input type="radio" name="persona-tipo" value="${v}" ${v==='socio'?'checked':''} style="display:none">
                  <i class="ti ${ic}" style="font-size:18px;color:var(--text-secondary)"></i>${l}
                </label>`
              ).join('')}
            </div>
          </div>` : ''}
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('persona-modal-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Panel.${editar ? `confirmarRenombrar('${editar}')` : 'confirmarAddPersona()'}">✓ ${editar ? 'Renombrar' : 'Agregar'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    const input = document.getElementById('persona-modal-nombre');
    setTimeout(() => { input?.focus(); input?.select(); }, 60);
  },

  _selectTipo(el, val) {
    document.querySelectorAll('#persona-tipo-selector label').forEach(l => {
      l.style.borderColor = 'var(--border-strong)';
      l.style.background = 'transparent';
      l.querySelector('i').style.color = 'var(--text-secondary)';
    });
    el.style.borderColor = 'var(--blue)';
    el.style.background = 'var(--blue-light)';
    el.querySelector('i').style.color = 'var(--blue)';
    el.querySelector('input').checked = true;
  },

  async confirmarAddPersona() {
    const nombre = document.getElementById('persona-modal-nombre')?.value.trim();
    if (!nombre) { toast('Ingresá un nombre.'); return; }
    if (State.personas.includes(nombre)) { toast('Ya existe una persona con ese nombre.'); return; }
    const tipoInput = document.querySelector('input[name="persona-tipo"]:checked');
    const tipo = tipoInput?.value || 'socio';
    document.getElementById('persona-modal-overlay')?.remove();
    await DB.agregarPersona(nombre);
    State.personas.push(nombre);
    State.cajas[nombre] = { 'ARS cash': 0, 'ARS transferencia': 0, 'USD cash': 0, 'USD transferencia': 0, 'USDT': 0 };
    if (!State.personasTipo) State.personasTipo = {};
    State.personasTipo[nombre] = tipo;
    this.renderBody();
    toast(`${nombre} (${tipo}) agregado correctamente.`);
  },

  renombrarPersonaModal(nombreViejo) {
    this.abrirModalPersona(nombreViejo);
  },

  async confirmarRenombrar(nombreViejo) {
    const nombreNuevo = document.getElementById('persona-modal-nombre')?.value.trim();
    if (!nombreNuevo || nombreNuevo === nombreViejo) { document.getElementById('persona-modal-overlay')?.remove(); return; }
    if (State.personas.includes(nombreNuevo)) { toast('Ya existe una persona con ese nombre.'); return; }
    const { error } = await DB.renombrarPersona(nombreViejo, nombreNuevo);
    if (error) { toast('Error al renombrar. Intentá de nuevo.'); console.error(error); return; }
    document.getElementById('persona-modal-overlay')?.remove();
    State.personas = State.personas.map(p => p === nombreViejo ? nombreNuevo : p);
    State.cajas[nombreNuevo] = State.cajas[nombreViejo];
    delete State.cajas[nombreViejo];
    if (State.personasTipo) { State.personasTipo[nombreNuevo] = State.personasTipo[nombreViejo]; delete State.personasTipo[nombreViejo]; }
    this.renderBody();
    toast(`"${nombreViejo}" ahora se llama "${nombreNuevo}".`);
  },

  saldoTotalPersona(p) {
    const c = State.cajas[p] || {};
    return (c['ARS cash']||0) + (c['ARS transferencia']||0) + ((c['USD cash']||0)+(c['USD transferencia']||0))*State.refBlue + (c['USDT']||0)*State.refUsdt;
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
        <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:14px" onclick="Panel.guardarCotizaciones()">✓ Actualizar cotizaciones</button>
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
        <button onclick="Panel.delFormaPago(${i})" style="background:none;border:none;cursor:pointer;color:var(--red)">🗑️</button>
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
        <button class="btn btn-sm" style="color:var(--red)" onclick="Panel.quitarUsuario('${u.id}','${u.email}')">🗑️</button>
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
  },

  // ── LOGO Y TIPOGRAFÍA ─────────────────────────────────────────────────────

  FUENTES: [
    { id: 'system',       label: 'Sistema (SF Pro / Helvetica)', stack: '-apple-system,"SF Pro Display","Helvetica Neue",sans-serif', google: null },
    { id: 'inter',        label: 'Inter',        stack: '"Inter",sans-serif',        google: 'Inter:wght@400;500;600;700;800' },
    { id: 'poppins',      label: 'Poppins',      stack: '"Poppins",sans-serif',      google: 'Poppins:wght@400;500;600;700;800' },
    { id: 'nunito',       label: 'Nunito',       stack: '"Nunito",sans-serif',       google: 'Nunito:wght@400;500;600;700;800' },
    { id: 'montserrat',   label: 'Montserrat',   stack: '"Montserrat",sans-serif',   google: 'Montserrat:wght@400;500;600;700;800' },
    { id: 'raleway',      label: 'Raleway',      stack: '"Raleway",sans-serif',      google: 'Raleway:wght@400;500;600;700;800' },
    { id: 'dm-sans',      label: 'DM Sans',      stack: '"DM Sans",sans-serif',      google: 'DM+Sans:wght@400;500;600;700;800' },
    { id: 'plus-jakarta', label: 'Plus Jakarta Sans', stack: '"Plus Jakarta Sans",sans-serif', google: 'Plus+Jakarta+Sans:wght@400;500;600;700;800' },
    { id: 'geist',        label: 'Geist',        stack: '"Geist",sans-serif',        google: 'Geist:wght@400;500;600;700;800' },
    { id: 'lato',         label: 'Lato',         stack: '"Lato",sans-serif',         google: 'Lato:wght@400;700' },
    { id: 'roboto',       label: 'Roboto',       stack: '"Roboto",sans-serif',       google: 'Roboto:wght@400;500;700' },
  ],

  marcaView() {
    const logoActual = localStorage.getItem('im_logo_b64') || '';
    const fuenteActual = localStorage.getItem('im_fuente') || 'system';
    const fuente = this.FUENTES.find(f => f.id === fuenteActual) || this.FUENTES[0];

    return `
      <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;margin-bottom:18px;border-bottom:1px solid var(--border);padding-bottom:8px">Logo y tipografía</h3>

      <!-- LOGO -->
      <div style="margin-bottom:28px">
        <div style="font-size:13px;font-weight:700;margin-bottom:4px">Logo de la marca</div>
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:14px">Se usa en el sidebar y en todos los recibos generados. Formatos: PNG, JPG, SVG. Recomendado: fondo transparente.</div>

        <div style="display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap">
          <!-- Preview actual -->
          <div style="display:flex;flex-direction:column;align-items:center;gap:8px">
            <div style="width:80px;height:80px;border-radius:16px;background:#1a1a1a;display:flex;align-items:center;justify-content:center;overflow:hidden;border:1px solid var(--border)" id="marca-logo-preview">
              ${logoActual
                ? `<img src="${logoActual}" style="width:60px;height:60px;object-fit:contain">`
                : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 245" width="44" height="54"><path d="M100,18 C86,4 64,7 61,22 C58,37 71,48 83,43 C76,56 60,60 48,82 C33,108 34,140 50,162 C62,180 80,190 96,190 C108,190 116,184 124,184 C132,184 140,190 154,190 C171,190 189,176 199,154 C173,141 173,105 199,93 C189,65 168,55 150,59 C140,61 132,69 124,69 C116,69 108,61 96,59 C87,57 79,48 83,35 C87,22 100,18 100,18 Z" fill="#fff"/><path d="M104,4 C104,4 117,-1 128,10 C139,21 131,40 118,38 C109,36 99,20 104,4 Z" fill="#fff"/></svg>`}
            </div>
            <div style="font-size:10px;color:var(--text-secondary)">Vista previa</div>
          </div>

          <!-- Acciones -->
          <div style="display:flex;flex-direction:column;gap:8px">
            <label class="btn btn-primary" style="cursor:pointer">
              <i class="ti ti-upload"></i> Subir logo
              <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" style="display:none" onchange="Panel._subirLogo(this)">
            </label>
            ${logoActual ? `<button class="btn" style="color:var(--red)" onclick="Panel._quitarLogo()">🗑️ Quitar logo</button>` : ''}
            <div style="font-size:10px;color:var(--text-secondary);max-width:220px">Máx. 2MB. Para mejores resultados usá un logo cuadrado con fondo transparente (PNG).</div>
          </div>
        </div>

        <!-- Preview sidebar simulado -->
        <div style="margin-top:16px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:14px;display:inline-flex;align-items:center;gap:10px">
          <div style="width:36px;height:36px;border-radius:9px;background:#1a1a1a;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0" id="marca-sidebar-preview">
            ${logoActual
              ? `<img src="${logoActual}" style="width:26px;height:26px;object-fit:contain">`
              : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 245" width="22" height="26"><path d="M100,18 C86,4 64,7 61,22 C58,37 71,48 83,43 C76,56 60,60 48,82 C33,108 34,140 50,162 C62,180 80,190 96,190 C108,190 116,184 124,184 C132,184 140,190 154,190 C171,190 189,176 199,154 C173,141 173,105 199,93 C189,65 168,55 150,59 C140,61 132,69 124,69 C116,69 108,61 96,59 C87,57 79,48 83,35 C87,22 100,18 100,18 Z" fill="#fff"/><path d="M104,4 C104,4 117,-1 128,10 C139,21 131,40 118,38 C109,36 99,20 104,4 Z" fill="#fff"/></svg>`}
          </div>
          <div>
            <div style="font-size:13px;font-weight:600">iPhoneMood</div>
            <div style="font-size:11px;color:var(--text-secondary)">Rosario · CRM</div>
          </div>
          <div style="font-size:10px;color:var(--text-tertiary);margin-left:8px">← así se ve en el sidebar</div>
        </div>
      </div>

      <!-- TIPOGRAFÍA -->
      <div>
        <div style="font-size:13px;font-weight:700;margin-bottom:4px">Tipografía</div>
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:14px">Afecta toda la plataforma y los recibos generados. La fuente se carga desde Google Fonts.</div>

        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-bottom:16px">
          ${this.FUENTES.map(f => `
            <div onclick="Panel._previewFuente('${f.id}')" id="fuente-card-${f.id}"
              style="border:2px solid ${fuenteActual===f.id?'var(--blue)':'var(--border)'};background:${fuenteActual===f.id?'var(--blue-light)':'var(--bg)'};border-radius:10px;padding:12px 14px;cursor:pointer;transition:border .1s">
              <div style="font-size:15px;font-weight:700;font-family:${f.stack};color:${fuenteActual===f.id?'var(--blue)':'var(--text)'};margin-bottom:3px">${f.label}</div>
              <div style="font-size:11px;font-family:${f.stack};color:var(--text-secondary)">Aa Bb Cc 0123</div>
            </div>`).join('')}
        </div>

        <!-- Preview texto con fuente seleccionada -->
        <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:14px">
          <div style="font-size:10px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Vista previa</div>
          <div id="fuente-preview-text" style="font-family:${fuente.stack}">
            <div style="font-size:20px;font-weight:700;margin-bottom:4px">iPhoneMood CRM</div>
            <div style="font-size:13px;margin-bottom:2px">Ventas · Stock · Cajas · Reparaciones</div>
            <div style="font-size:11px;color:var(--text-secondary)">Total venta: USD 820 · Pagado · Recibo N° 9</div>
          </div>
        </div>

        <button class="btn btn-primary" onclick="Panel._guardarFuente()"><i class="ti ti-device-floppy"></i> Aplicar tipografía</button>
        <div style="font-size:10px;color:var(--text-secondary);margin-top:6px">El cambio se aplica al instante y se guarda para todas las sesiones.</div>
      </div>
    `;
  },

  _initMarcaPreview() {
    // Pre-carga las fuentes de Google para que se vean en el preview antes de aplicar
    this.FUENTES.filter(f => f.google).forEach(f => {
      const id = `gfont-preview-${f.id}`;
      if (!document.getElementById(id)) {
        const link = document.createElement('link');
        link.id = id;
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?family=${f.google}&display=swap`;
        document.head.appendChild(link);
      }
    });
  },

  _subirLogo(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('El archivo es muy grande. Máximo 2MB.'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const b64 = e.target.result;
      localStorage.setItem('im_logo_b64', b64);
      // Actualizar sidebar en vivo
      Panel._aplicarLogoSidebar(b64);
      // Refrescar el panel
      Panel.renderBody();
      toast('Logo actualizado.');
    };
    reader.readAsDataURL(file);
  },

  _quitarLogo() {
    if (!confirm('¿Quitar el logo personalizado y volver al logo por defecto?')) return;
    localStorage.removeItem('im_logo_b64');
    Panel._aplicarLogoSidebar(null);
    Panel.renderBody();
    toast('Logo eliminado. Se usa el logo por defecto.');
  },

  _aplicarLogoSidebar(b64) {
    const sbLogo = document.querySelector('.sb-logo');
    if (!sbLogo) return;
    if (b64) {
      sbLogo.innerHTML = `<img src="${b64}" style="width:26px;height:26px;object-fit:contain">`;
    } else {
      sbLogo.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 245" width="26" height="26"><path d="M100,18 C86,4 64,7 61,22 C58,37 71,48 83,43 C76,56 60,60 48,82 C33,108 34,140 50,162 C62,180 80,190 96,190 C108,190 116,184 124,184 C132,184 140,190 154,190 C171,190 189,176 199,154 C173,141 173,105 199,93 C189,65 168,55 150,59 C140,61 132,69 124,69 C116,69 108,61 96,59 C87,57 79,48 83,35 C87,22 100,18 100,18 Z" fill="#fff"/><path d="M104,4 C104,4 117,-1 128,10 C139,21 131,40 118,38 C109,36 99,20 104,4 Z" fill="#fff"/></svg>`;
    }
  },

  _previewFuente(id) {
    const fuente = this.FUENTES.find(f => f.id === id);
    if (!fuente) return;
    // Resaltar card seleccionada
    this.FUENTES.forEach(f => {
      const card = document.getElementById(`fuente-card-${f.id}`);
      if (!card) return;
      const sel = f.id === id;
      card.style.borderColor = sel ? 'var(--blue)' : 'var(--border)';
      card.style.background = sel ? 'var(--blue-light)' : 'var(--bg)';
      card.querySelector('div').style.color = sel ? 'var(--blue)' : 'var(--text)';
    });
    // Actualizar preview
    const prev = document.getElementById('fuente-preview-text');
    if (prev) prev.style.fontFamily = fuente.stack;
    // Guardar selección temporal
    this._fuenteSelTemp = id;
  },

  _guardarFuente() {
    const id = this._fuenteSelTemp || localStorage.getItem('im_fuente') || 'system';
    const fuente = this.FUENTES.find(f => f.id === id);
    if (!fuente) return;
    localStorage.setItem('im_fuente', id);
    Panel.aplicarFuente(id);
    toast(`Tipografía "${fuente.label}" aplicada.`);
  },

  aplicarFuente(id) {
    const fuente = this.FUENTES.find(f => f.id === (id || localStorage.getItem('im_fuente') || 'system'));
    if (!fuente) return;
    // Cargar Google Font si hace falta
    if (fuente.google) {
      const linkId = 'gfont-active';
      let link = document.getElementById(linkId);
      if (!link) { link = document.createElement('link'); link.id = linkId; link.rel = 'stylesheet'; document.head.appendChild(link); }
      link.href = `https://fonts.googleapis.com/css2?family=${fuente.google}&display=swap`;
    }
    // Aplicar al :root
    document.documentElement.style.setProperty('--font', fuente.stack);
  },

  cargarMarcaAlInicio() {
    // Logo
    const logo = localStorage.getItem('im_logo_b64');
    if (logo) this._aplicarLogoSidebar(logo);
    // Fuente
    this.aplicarFuente(localStorage.getItem('im_fuente') || 'system');
  },
};


window.Panel = Panel;
