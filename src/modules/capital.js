const Capital = {
  activeTab: 'resumen',

  render() {
    const c = document.createElement('div');
    c.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;min-height:0';
    c.innerHTML = `
      <div style="padding:14px 22px 0;border-bottom:1px solid var(--border);flex-shrink:0">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:14px">
          <div>
            <h2 style="font-size:19px;font-weight:700;display:flex;align-items:center;gap:8px"><i class="ti ti-chart-pie" style="color:var(--blue)"></i> Capital & Inversiones</h2>
            <p style="font-size:12px;color:var(--text-secondary);margin-top:2px">Valor del negocio, deuda con inversores y activos fijos</p>
          </div>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap" id="cap-tabs"></div>
      </div>
      <div style="flex:1;overflow-y:auto" id="cap-body"></div>
    `;
    setTimeout(() => { this.renderTabs(); this.renderBody(); }, 0);
    return c;
  },

  renderTabs() {
    const tabs = [
      ['resumen',   'ti-layout-dashboard', 'Resumen'],
      ['inversores','ti-users',            'Inversores'],
      ['activos',   'ti-building',         'Activos fijos'],
    ];
    document.getElementById('cap-tabs').innerHTML = tabs.map(([k,ic,l]) =>
      `<button onclick="Capital.setTab('${k}')" style="display:flex;align-items:center;gap:6px;padding:8px 14px;border:none;border-bottom:2px solid ${this.activeTab===k?'var(--blue)':'transparent'};background:transparent;color:${this.activeTab===k?'var(--blue)':'var(--text-secondary)'};font-size:12.5px;font-weight:${this.activeTab===k?'600':'400'};cursor:pointer;border-radius:0;font-family:var(--font)">
        <i class="ti ${ic}"></i> ${l}
      </button>`
    ).join('');
  },

  setTab(t) { this.activeTab = t; this.renderTabs(); this.renderBody(); },

  renderBody() {
    const body = document.getElementById('cap-body');
    if (!body) return;
    if (this.activeTab === 'resumen')    body.innerHTML = this.resumenHTML();
    if (this.activeTab === 'inversores') body.innerHTML = this.inversoresHTML();
    if (this.activeTab === 'activos')    body.innerHTML = this.activosHTML();
  },

  // ── Cálculos ──────────────────────────────────────────────
  calcular() {
    // Stock disponible
    const valorStock = (State.stock || []).reduce((s, p) => {
      const qty = State.getStock(p);
      return s + (p.costoUSD || 0) * qty;
    }, 0);

    // Cajas equivalente en USD
    let cajasUSD = 0;
    Object.values(State.cajas || {}).forEach(c => {
      cajasUSD += ((c['USD cash']||0) + (c['USD transferencia']||0));
      cajasUSD += ((c['ARS cash']||0) + (c['ARS transferencia']||0)) / (State.refBlue || 1);
      cajasUSD += (c['USDT'] || 0) * (State.refUsdt || 1) / (State.refBlue || 1);
    });

    // Activos taller (herramientas + repuestos de stock)
    const valorTaller = (State.stock || []).filter(p => ['herramienta','repuesto'].includes(p.cat))
      .reduce((s, p) => s + (p.costoUSD || 0) * Math.max(State.getStock(p), 1), 0);

    // Activos fijos
    const valorActivosFijos = (State.activosFijos || []).reduce((s, a) => s + (a.valorUSD || 0), 0);

    // Capital bruto
    const capitalBruto = valorStock + cajasUSD + valorActivosFijos;

    // Inversores
    const capitalInvertido = (State.inversores || []).reduce((s, i) => s + (i.capitalInicialUSD || 0), 0);
    const totalPagadoInversores = (State.inversorPagos || []).reduce((s, p) => s + (p.montoUSD || 0), 0);

    // Capital neto
    const capitalNeto = capitalBruto - capitalInvertido - totalPagadoInversores;

    return { valorStock, cajasUSD, valorTaller, valorActivosFijos, capitalBruto, capitalInvertido, totalPagadoInversores, capitalNeto };
  },

  // ── RESUMEN ───────────────────────────────────────────────
  resumenHTML() {
    const r = this.calcular();
    const fmtUSD = v => State.fmtUSD(v);
    const signo = r.capitalNeto >= 0;

    return `<div class="body-pad">

      <!-- KPIs principales -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px" class="cajas-kpi-grid">
        <div class="card" style="margin-bottom:0">
          <div style="font-size:10px;color:var(--text-secondary);margin-bottom:3px">Capital bruto</div>
          <div style="font-size:22px;font-weight:700;color:var(--blue)">${fmtUSD(r.capitalBruto)}</div>
          <div style="font-size:10px;color:var(--text-secondary);margin-top:4px">todo lo que tiene el negocio</div>
        </div>
        <div class="card" style="margin-bottom:0">
          <div style="font-size:10px;color:var(--text-secondary);margin-bottom:3px">Deuda con inversores</div>
          <div style="font-size:22px;font-weight:700;color:var(--red)">${fmtUSD(r.capitalInvertido)}</div>
          <div style="font-size:10px;color:var(--text-secondary);margin-top:4px">capital no devuelto</div>
        </div>
        <div class="card" style="margin-bottom:0">
          <div style="font-size:10px;color:var(--text-secondary);margin-bottom:3px">Pagado a inversores</div>
          <div style="font-size:22px;font-weight:700;color:var(--amber)">${fmtUSD(r.totalPagadoInversores)}</div>
          <div style="font-size:10px;color:var(--text-secondary);margin-top:4px">histórico de pagos</div>
        </div>
        <div class="card" style="margin-bottom:0;background:${signo?'var(--green-light)':'rgba(255,69,58,.08)'};border-color:${signo?'rgba(48,209,88,.3)':'rgba(255,69,58,.3)'}">
          <div style="font-size:10px;color:${signo?'var(--green)':'var(--red)'};margin-bottom:3px">Capital neto iPhoneMood</div>
          <div style="font-size:22px;font-weight:700;color:${signo?'var(--green)':'var(--red)'}">${fmtUSD(r.capitalNeto)}</div>
          <div style="font-size:10px;color:${signo?'var(--green)':'var(--red)'};margin-top:4px">bruto − inversores − pagos</div>
        </div>
      </div>

      <!-- Desglose -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px" class="dash-grid-2">
        <div class="card" style="margin-bottom:0">
          <div class="card-title"><i class="ti ti-calculator"></i> Composición del capital bruto</div>
          ${[
            ['Stock de productos',    r.valorStock,       'var(--blue)'],
            ['Cajas (ARS+USD+USDT)',  r.cajasUSD,         'var(--green)'],
            ['Activos fijos',         r.valorActivosFijos,'var(--amber)'],
          ].map(([label, val, color]) => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
              <span style="font-size:12px;color:var(--text-secondary)">${label}</span>
              <b style="color:${color}">${fmtUSD(val)}</b>
            </div>`).join('')}
          <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0 0">
            <b style="font-size:13px">Total bruto</b>
            <b style="font-size:15px;color:var(--blue)">${fmtUSD(r.capitalBruto)}</b>
          </div>
        </div>

        <div class="card" style="margin-bottom:0">
          <div class="card-title"><i class="ti ti-users"></i> Inversores activos</div>
          ${(State.inversores || []).filter(i => i.activo).length === 0
            ? `<p style="font-size:12px;color:var(--text-secondary)">No hay inversores cargados aún.</p>`
            : (State.inversores || []).filter(i => i.activo).map(inv => {
                const pagado = (State.inversorPagos || []).filter(p => p.inversorId === inv.id).reduce((s,p) => s + p.montoUSD, 0);
                const ventasMes = (State.ventas || []).reduce((s,v) => s + v.items.reduce((a,i) => a+i.precio, 0), 0);
                const estimadoMes = inv.tipo === 'porcentaje' ? ventasMes * (inv.porcentaje / 100) : (inv.cuotaMensualUSD || 0);
                return `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                    <b style="font-size:12.5px">${inv.nombre}</b>
                    <span class="badge ${inv.tipo==='porcentaje'?'b-blue':'b-amber'}">${inv.tipo==='porcentaje'?inv.porcentaje+'% ventas':'Crédito'}</span>
                  </div>
                  <div style="display:flex;gap:14px;font-size:11px;color:var(--text-secondary)">
                    <span>Capital: <b style="color:var(--text)">${fmtUSD(inv.capitalInicialUSD)}</b></span>
                    <span>Pagado: <b style="color:var(--amber)">${fmtUSD(pagado)}</b></span>
                    <span>Est. este mes: <b style="color:var(--green)">${fmtUSD(estimadoMes)}</b></span>
                  </div>
                </div>`;
              }).join('')}
        </div>
      </div>
    </div>`;
  },

  // ── INVERSORES ────────────────────────────────────────────
  inversoresHTML() {
    const inversores = State.inversores || [];
    return `<div class="body-pad">
      <div style="display:flex;justify-content:flex-end;margin-bottom:14px">
        <button class="btn btn-primary" onclick="Capital.abrirModalInversor()"><i class="ti ti-plus"></i> Agregar inversor</button>
      </div>

      ${inversores.length === 0 ? `<div class="empty-state"><i class="ti ti-users"></i><p>No hay inversores cargados.</p></div>` : ''}

      ${inversores.map(inv => {
        const pagos = (State.inversorPagos || []).filter(p => p.inversorId === inv.id).sort((a,b) => b.fecha.localeCompare(a.fecha));
        const totalPagado = pagos.reduce((s,p) => s + p.montoUSD, 0);
        const ventasMes = (State.ventas || []).reduce((s,v) => s + v.items.reduce((a,i) => a+i.precio, 0), 0);
        const estimadoMes = inv.tipo === 'porcentaje' ? (ventasMes * inv.porcentaje / 100) : (inv.cuotaMensualUSD || 0);
        return `<div class="card" style="margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:12px">
            <div>
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                <div class="av" style="width:34px;height:34px;font-size:12px">${inv.nombre.substring(0,2).toUpperCase()}</div>
                <div>
                  <div style="font-size:14px;font-weight:700">${inv.nombre}</div>
                  ${inv.contacto ? `<div style="font-size:11px;color:var(--text-secondary)">${inv.contacto}</div>` : ''}
                </div>
              </div>
              <span class="badge ${inv.activo?'b-green':'b-gray'}">${inv.activo?'Activo':'Inactivo'}</span>
              <span class="badge ${inv.tipo==='porcentaje'?'b-blue':'b-amber'}" style="margin-left:4px">${inv.tipo==='porcentaje'?'% de ventas':'Crédito'}</span>
            </div>
            <div style="display:flex;gap:6px">
              <button class="btn btn-sm" onclick="Capital.abrirModalPago('${inv.id}')"><i class="ti ti-cash"></i> Registrar pago</button>
              <button class="btn btn-sm" onclick="Capital.abrirModalInversor('${inv.id}')"><i class="ti ti-pencil"></i></button>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px" class="cajas-kpi-grid">
            <div style="background:var(--bg-secondary);border-radius:8px;padding:10px 12px">
              <div style="font-size:10px;color:var(--text-secondary);margin-bottom:2px">Capital invertido</div>
              <div style="font-size:16px;font-weight:700">${State.fmtUSD(inv.capitalInicialUSD)}</div>
            </div>
            <div style="background:var(--bg-secondary);border-radius:8px;padding:10px 12px">
              <div style="font-size:10px;color:var(--text-secondary);margin-bottom:2px">Total pagado</div>
              <div style="font-size:16px;font-weight:700;color:var(--amber)">${State.fmtUSD(totalPagado)}</div>
            </div>
            <div style="background:var(--bg-secondary);border-radius:8px;padding:10px 12px">
              <div style="font-size:10px;color:var(--text-secondary);margin-bottom:2px">${inv.tipo==='porcentaje'?'% acordado':'Cuota mensual'}</div>
              <div style="font-size:16px;font-weight:700;color:var(--blue)">${inv.tipo==='porcentaje'?inv.porcentaje+'%':State.fmtUSD(inv.cuotaMensualUSD||0)}</div>
            </div>
            <div style="background:var(--green-light);border-radius:8px;padding:10px 12px;border:1px solid rgba(48,209,88,.2)">
              <div style="font-size:10px;color:var(--green);margin-bottom:2px">Estimado este mes</div>
              <div style="font-size:16px;font-weight:700;color:var(--green)">${State.fmtUSD(estimadoMes)}</div>
            </div>
          </div>

          ${inv.notas ? `<div style="font-size:12px;color:var(--text-secondary);background:var(--bg-secondary);border-radius:7px;padding:8px 10px;margin-bottom:10px"><i class="ti ti-note"></i> ${inv.notas}</div>` : ''}

          <!-- Historial de pagos -->
          <div>
            <div style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:6px">Historial de pagos (${pagos.length})</div>
            ${pagos.length === 0 ? `<p style="font-size:12px;color:var(--text-secondary)">Sin pagos registrados aún.</p>` :
              `<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">
                ${pagos.slice(0,5).map((p,i) => `
                  <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:${i<Math.min(pagos.length,5)-1?'1px solid var(--border)':'none'};font-size:12px">
                    <i class="ti ti-cash" style="color:var(--green);flex-shrink:0"></i>
                    <div style="flex:1">
                      <div style="font-weight:500">${p.mesReferencia || p.concepto || 'Pago'}</div>
                      <div style="font-size:10px;color:var(--text-secondary)">${p.fecha}</div>
                    </div>
                    <b style="color:var(--green)">${State.fmtUSD(p.montoUSD)}</b>
                  </div>`).join('')}
                ${pagos.length > 5 ? `<div style="padding:8px 12px;font-size:11px;color:var(--text-secondary);text-align:center">+${pagos.length-5} pagos anteriores</div>` : ''}
              </div>`}
          </div>
        </div>`;
      }).join('')}
    </div>`;
  },

  // ── ACTIVOS FIJOS ─────────────────────────────────────────
  activosHTML() {
    const activos = State.activosFijos || [];
    const total = activos.reduce((s,a) => s + (a.valorUSD||0), 0);
    const CATS = { mobiliario:'Mobiliario', equipamiento:'Equipamiento', tecnologia:'Tecnología', vehiculo:'Vehículo', otro:'Otro' };
    const CAT_BADGE = { mobiliario:'b-amber', equipamiento:'b-blue', tecnologia:'b-purple', vehiculo:'b-teal', otro:'b-gray' };

    return `<div class="body-pad">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <div class="card" style="margin-bottom:0;flex:1;min-width:200px">
          <div style="font-size:10px;color:var(--text-secondary);margin-bottom:2px">Valor total activos fijos</div>
          <div style="font-size:22px;font-weight:700;color:var(--amber)">${State.fmtUSD(total)}</div>
          <div style="font-size:10px;color:var(--text-secondary);margin-top:3px">${activos.length} ítems registrados</div>
        </div>
        <button class="btn btn-primary" onclick="Capital.abrirModalActivo()"><i class="ti ti-plus"></i> Agregar activo</button>
      </div>

      ${activos.length === 0 ? `<div class="empty-state"><i class="ti ti-building"></i><p>No hay activos fijos cargados.<br>Agregá mobiliario, equipamiento u otros bienes del negocio.</p></div>` : ''}

      ${Object.entries(CATS).map(([cat, label]) => {
        const items = activos.filter(a => a.categoria === cat);
        if (!items.length) return '';
        const subtotal = items.reduce((s,a) => s + (a.valorUSD||0), 0);
        return `<div style="margin-bottom:14px">
          <div style="font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
            <span><i class="ti ti-tag"></i> ${label}</span>
            <span style="color:var(--amber)">${State.fmtUSD(subtotal)}</span>
          </div>
          <div class="card" style="margin-bottom:0;padding:0;overflow:hidden">
            ${items.map((a,i) => `
              <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:${i<items.length-1?'1px solid var(--border)':'none'}">
                <div style="flex:1;min-width:0">
                  <div style="font-size:12.5px;font-weight:600">${a.nombre}</div>
                  ${a.fechaCompra ? `<div style="font-size:10px;color:var(--text-secondary)">Comprado: ${a.fechaCompra}</div>` : ''}
                  ${a.notas ? `<div style="font-size:10px;color:var(--text-secondary)">${a.notas}</div>` : ''}
                </div>
                <b style="font-size:14px;color:var(--amber);flex-shrink:0">${State.fmtUSD(a.valorUSD)}</b>
                <div style="display:flex;gap:4px;flex-shrink:0">
                  <button class="btn btn-sm" onclick="Capital.abrirModalActivo('${a.id}')"><i class="ti ti-pencil"></i></button>
                  <button class="btn btn-sm" style="color:var(--red)" onclick="Capital.eliminarActivo('${a.id}')"><i class="ti ti-trash"></i></button>
                </div>
              </div>`).join('')}
          </div>
        </div>`;
      }).join('')}
    </div>`;
  },

  // ── Modal inversor ────────────────────────────────────────
  abrirModalInversor(id) {
    const inv = id ? (State.inversores||[]).find(x => x.id === id) : null;
    const overlay = document.createElement('div');
    overlay.id = 'cap-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(6px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(460px,96vw);max-height:90dvh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border)">
          <div style="font-size:14px;font-weight:700">${inv ? 'Editar inversor' : 'Nuevo inversor'}</div>
        </div>
        <div style="padding:18px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:12px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div style="grid-column:1/-1">
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Nombre *</label>
              <input id="cinv-nombre" type="text" value="${inv?.nombre||''}" placeholder="Nombre completo"
                style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
            <div style="grid-column:1/-1">
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Contacto (teléfono / email)</label>
              <input id="cinv-contacto" type="text" value="${inv?.contacto||''}" placeholder="3411234567"
                style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
          </div>

          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:6px">Tipo de inversión</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <label id="cinv-tipo-porc-label" onclick="Capital._selectTipoInv('porcentaje')" style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:8px;cursor:pointer;border:1.5px solid ${(!inv||inv.tipo==='porcentaje')?'var(--blue)':'var(--border)'};background:${(!inv||inv.tipo==='porcentaje')?'var(--blue-light)':'transparent'}">
                <input type="radio" name="cinv-tipo" value="porcentaje" ${(!inv||inv.tipo==='porcentaje')?'checked':''} style="accent-color:var(--blue)">
                <div><div style="font-size:12px;font-weight:600">% de ventas</div><div style="font-size:10px;color:var(--text-secondary)">Cobra un % mensual</div></div>
              </label>
              <label id="cinv-tipo-cred-label" onclick="Capital._selectTipoInv('credito')" style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:8px;cursor:pointer;border:1.5px solid ${inv?.tipo==='credito'?'var(--amber)':'var(--border)'};background:${inv?.tipo==='credito'?'rgba(255,214,10,.1)':'transparent'}">
                <input type="radio" name="cinv-tipo" value="credito" ${inv?.tipo==='credito'?'checked':''} style="accent-color:var(--amber)">
                <div><div style="font-size:12px;font-weight:600">Crédito</div><div style="font-size:10px;color:var(--text-secondary)">Cuota fija mensual</div></div>
              </label>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Capital invertido (USD) *</label>
              <input id="cinv-capital" type="number" value="${inv?.capitalInicialUSD||''}" min="0" placeholder="0"
                style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
            <div id="cinv-porc-wrap" style="display:${(!inv||inv.tipo==='porcentaje')?'block':'none'}">
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Porcentaje de ventas (%)</label>
              <input id="cinv-porcentaje" type="number" value="${inv?.porcentaje||''}" min="0" max="100" step="0.1" placeholder="ej: 5"
                style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
            <div id="cinv-cuota-wrap" style="display:${inv?.tipo==='credito'?'block':'none'}">
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Cuota mensual (USD)</label>
              <input id="cinv-cuota" type="number" value="${inv?.cuotaMensualUSD||''}" min="0" placeholder="0"
                style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
          </div>

          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Notas</label>
            <textarea id="cinv-notas" rows="2" placeholder="Condiciones, observaciones…"
              style="width:100%;font-size:12.5px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);resize:vertical;font-family:var(--font)">${inv?.notas||''}</textarea>
          </div>

          ${inv ? `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12.5px">
            <input type="checkbox" id="cinv-activo" ${inv.activo?'checked':''} style="accent-color:var(--blue)"> Inversor activo
          </label>` : ''}
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('cap-modal-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Capital.guardarInversor('${id||''}')"><i class="ti ti-check"></i> ${inv?'Guardar':'Agregar'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    setTimeout(() => document.getElementById('cinv-nombre')?.focus(), 60);
  },

  _selectTipoInv(tipo) {
    const esPorc = tipo === 'porcentaje';
    document.getElementById('cinv-tipo-porc-label').style.borderColor = esPorc ? 'var(--blue)' : 'var(--border)';
    document.getElementById('cinv-tipo-porc-label').style.background  = esPorc ? 'var(--blue-light)' : 'transparent';
    document.getElementById('cinv-tipo-cred-label').style.borderColor = !esPorc ? 'var(--amber)' : 'var(--border)';
    document.getElementById('cinv-tipo-cred-label').style.background  = !esPorc ? 'rgba(255,214,10,.1)' : 'transparent';
    document.getElementById('cinv-porc-wrap').style.display = esPorc ? 'block' : 'none';
    document.getElementById('cinv-cuota-wrap').style.display = !esPorc ? 'block' : 'none';
  },

  async guardarInversor(id) {
    const nombre = document.getElementById('cinv-nombre')?.value.trim();
    if (!nombre) { toast('El nombre es obligatorio.'); return; }
    const tipo = document.querySelector('input[name="cinv-tipo"]:checked')?.value || 'porcentaje';
    const data = {
      nombre,
      contacto: document.getElementById('cinv-contacto')?.value.trim() || '',
      tipo,
      capitalInicialUSD: parseFloat(document.getElementById('cinv-capital')?.value) || 0,
      porcentaje: parseFloat(document.getElementById('cinv-porcentaje')?.value) || 0,
      cuotaMensualUSD: parseFloat(document.getElementById('cinv-cuota')?.value) || 0,
      notas: document.getElementById('cinv-notas')?.value.trim() || '',
      activo: id ? (document.getElementById('cinv-activo')?.checked ?? true) : true,
    };
    document.getElementById('cap-modal-overlay')?.remove();

    if (id) {
      const inv = (State.inversores||[]).find(x => x.id === id);
      if (inv) Object.assign(inv, data);
      await DB.actualizarInversor(id, data);
      toast('Inversor actualizado.');
    } else {
      const nuevo = await DB.crearInversor(data);
      if (nuevo) { data.id = nuevo.id; if (!State.inversores) State.inversores = []; State.inversores.unshift(data); }
      toast(`${nombre} agregado como inversor.`);
    }
    this.renderBody();
  },

  // ── Modal pago inversor ───────────────────────────────────
  abrirModalPago(invId) {
    const inv = (State.inversores||[]).find(x => x.id === invId);
    if (!inv) return;
    const hoy = new Date().toISOString().split('T')[0];
    const mesActual = new Date().toLocaleString('es-AR', { month: 'long', year: 'numeric' });
    const overlay = document.createElement('div');
    overlay.id = 'cap-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(6px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(380px,96vw);overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border)">
          <div style="font-size:14px;font-weight:700">Registrar pago</div>
          <div style="font-size:11px;color:var(--text-secondary)">${inv.nombre}</div>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Monto (USD) *</label>
            <input id="cpago-monto" type="number" min="0" step="0.01" placeholder="0.00"
              style="width:100%;font-size:18px;font-weight:700;padding:9px 12px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Mes de referencia</label>
            <input id="cpago-mes" type="text" value="${mesActual}"
              style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Fecha</label>
            <input id="cpago-fecha" type="date" value="${hoy}"
              style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Concepto (opcional)</label>
            <input id="cpago-concepto" type="text" placeholder="ej: Pago mensual enero"
              style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('cap-modal-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Capital.guardarPago('${invId}')"><i class="ti ti-check"></i> Registrar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    setTimeout(() => document.getElementById('cpago-monto')?.focus(), 60);
  },

  async guardarPago(invId) {
    const monto = parseFloat(document.getElementById('cpago-monto')?.value);
    if (!monto || monto <= 0) { toast('Ingresá un monto válido.'); return; }
    const pago = {
      inversorId: invId,
      montoUSD: monto,
      mesReferencia: document.getElementById('cpago-mes')?.value.trim() || '',
      fecha: document.getElementById('cpago-fecha')?.value || new Date().toISOString().split('T')[0],
      concepto: document.getElementById('cpago-concepto')?.value.trim() || '',
    };
    document.getElementById('cap-modal-overlay')?.remove();
    const nuevo = await DB.crearPagoInversor(pago);
    if (nuevo) { pago.id = nuevo.id; if (!State.inversorPagos) State.inversorPagos = []; State.inversorPagos.unshift(pago); }
    this.renderBody();
    toast(`Pago de ${State.fmtUSD(monto)} registrado.`);
  },

  // ── Modal activo fijo ─────────────────────────────────────
  abrirModalActivo(id) {
    const activo = id ? (State.activosFijos||[]).find(x => x.id === id) : null;
    const CATS = { mobiliario:'Mobiliario', equipamiento:'Equipamiento', tecnologia:'Tecnología', vehiculo:'Vehículo', otro:'Otro' };
    const overlay = document.createElement('div');
    overlay.id = 'cap-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(6px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(400px,96vw);overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border)">
          <div style="font-size:14px;font-weight:700">${activo ? 'Editar activo' : 'Nuevo activo fijo'}</div>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Nombre *</label>
            <input id="cact-nombre" type="text" value="${activo?.nombre||''}" placeholder="ej: Escritorio, silla de oficina, aire acondicionado…"
              style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Valor estimado (USD) *</label>
              <input id="cact-valor" type="number" value="${activo?.valorUSD||''}" min="0" step="0.01" placeholder="0"
                style="width:100%;font-size:14px;font-weight:700;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Fecha de compra</label>
              <input id="cact-fecha" type="date" value="${activo?.fechaCompra||''}"
                style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Categoría</label>
            <select id="cact-cat" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
              ${Object.entries(CATS).map(([k,v]) => `<option value="${k}" ${activo?.categoria===k?'selected':''}>${v}</option>`).join('')}
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Notas</label>
            <input id="cact-notas" type="text" value="${activo?.notas||''}" placeholder="Opcional"
              style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('cap-modal-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Capital.guardarActivo('${id||''}')"><i class="ti ti-check"></i> ${activo?'Guardar':'Agregar'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    setTimeout(() => document.getElementById('cact-nombre')?.focus(), 60);
  },

  async guardarActivo(id) {
    const nombre = document.getElementById('cact-nombre')?.value.trim();
    const valorUSD = parseFloat(document.getElementById('cact-valor')?.value) || 0;
    if (!nombre) { toast('El nombre es obligatorio.'); return; }
    const data = {
      nombre, valorUSD,
      categoria: document.getElementById('cact-cat')?.value || 'mobiliario',
      fechaCompra: document.getElementById('cact-fecha')?.value || '',
      notas: document.getElementById('cact-notas')?.value.trim() || '',
    };
    document.getElementById('cap-modal-overlay')?.remove();

    if (id) {
      const a = (State.activosFijos||[]).find(x => x.id === id);
      if (a) Object.assign(a, data);
      await DB.actualizarActivoFijo(id, data);
      toast('Activo actualizado.');
    } else {
      const nuevo = await DB.crearActivoFijo(data);
      if (nuevo) { data.id = nuevo.id; if (!State.activosFijos) State.activosFijos = []; State.activosFijos.push(data); }
      toast(`${nombre} agregado.`);
    }
    this.renderBody();
  },

  async eliminarActivo(id) {
    if (!confirm('¿Eliminar este activo fijo?')) return;
    await DB.eliminarActivoFijo(id);
    State.activosFijos = (State.activosFijos||[]).filter(x => x.id !== id);
    this.renderBody();
    toast('Activo eliminado.');
  },
};

window.Capital = Capital;
