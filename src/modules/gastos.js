const Gastos = {
  activeCat: 'all',
  currentView: 'mes', // 'mes' | 'fijos' | 'cierre'
  mesActual: new Date().toISOString().slice(0, 7), // 'YYYY-MM'

  isMobile() { return window.innerWidth <= 768; },

  render() {
    const c = document.createElement('div');
    c.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;min-height:0';
    c.innerHTML = `
      <div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;white-space:nowrap;flex-shrink:0" id="gastos-view-tabs"></div>
      <div id="gastos-view-host" style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0"></div>
      <div id="gastos-modal-host"></div>
    `;
    setTimeout(() => this.renderView(), 0);
    return c;
  },

  renderView() {
    document.getElementById('gastos-view-tabs').innerHTML = `
      <button class="btn btn-sm ${this.currentView==='mes'?'btn-primary':''}" onclick="Gastos.setView('mes')"><i class="ti ti-receipt"></i> Gastos del mes</button>
      <button class="btn btn-sm ${this.currentView==='fijos'?'btn-primary':''}" onclick="Gastos.setView('fijos')"><i class="ti ti-repeat"></i> Gastos fijos</button>
      <button class="btn btn-sm ${this.currentView==='cierre'?'btn-primary':''}" onclick="Gastos.setView('cierre')"><i class="ti ti-calculator"></i> Cierre de mes</button>
    `;
    const host = document.getElementById('gastos-view-host');
    if (this.currentView === 'mes') { host.innerHTML = this.viewGastosMes(); setTimeout(() => { this.renderChips(); this.renderKpis(); this.renderTable(); }, 0); }
    else if (this.currentView === 'fijos') { host.innerHTML = this.viewGastosFijos(); setTimeout(() => this.renderFijosList(), 0); }
    else { host.innerHTML = this.viewCierre(); setTimeout(() => this.renderCierre(), 0); }
  },
  setView(v) { this.currentView = v; this.renderView(); },

  viewGastosMes() {
    const mobile = this.isMobile();
    return `
      <div class="kpi-row" style="grid-template-columns:repeat(${mobile?'2':'4'},1fr)">
        <div class="kpi"><label>Gastos ARS</label><div class="val" id="g-kpi-ars">—</div></div>
        <div class="kpi"><label>Gastos USD</label><div class="val" id="g-kpi-usd">—</div></div>
        <div class="kpi"><label>Pendientes</label><div class="val" id="g-kpi-pend">—</div></div>
        <div class="kpi"><label>Cat. top</label><div class="val" id="g-kpi-cat" style="font-size:13px">—</div></div>
      </div>
      <div style="padding:${mobile?'8px 12px':'10px 16px'};border-bottom:1px solid var(--border)">
        <div style="display:flex;gap:6px;margin-bottom:8px;overflow-x:auto;-webkit-overflow-scrolling:touch;white-space:nowrap;padding-bottom:2px" id="gastos-chips"></div>
        <div style="display:flex;gap:6px;justify-content:flex-end">
          <button class="btn btn-sm" onclick="Gastos.manageCats()"><i class="ti ti-settings"></i>${mobile?'':' Categorías'}</button>
          <button class="btn btn-primary btn-sm" onclick="Gastos.openNew()"><i class="ti ti-plus"></i> ${mobile?'Registrar':'Registrar gasto'}</button>
        </div>
      </div>
      <div class="body-pad" style="overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1;min-height:0;padding:${mobile?'0':'0 0 12px'}">
        ${mobile ? `<div id="gastos-cards" style="padding:8px 12px;display:flex;flex-direction:column;gap:8px"></div>` : `
        <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;padding:0 16px">
          <table style="min-width:520px"><thead><tr><th>Fecha</th><th>Motivo</th><th>Categoría</th><th>Responsable</th><th>Caja</th><th>Monto</th><th>Estado</th><th></th></tr></thead>
          <tbody id="gastos-tbody"></tbody>
        </table></div>`}
      </div>
    `;
  },

  catObj(id) { return State.categoriasGasto.find(c => c.id === id) || { nombre: id, color: '#888' }; },

  renderChips() {
    const html = [`<button class="btn btn-sm ${this.activeCat==='all'?'btn-primary':''}" onclick="Gastos.setCat('all')" style="flex-shrink:0">Todos</button>`]
      .concat(State.categoriasGasto.map(c => `<button class="btn btn-sm ${this.activeCat===c.id?'btn-primary':''}" onclick="Gastos.setCat('${c.id}')" style="flex-shrink:0;${this.activeCat!==c.id?`border-color:${c.color}55`:''}">${c.nombre}</button>`));
    const el = document.getElementById('gastos-chips');
    if (el) el.innerHTML = html.join('');
  },
  setCat(c) { this.activeCat = c; this.renderChips(); this.renderTable(); },

  renderKpis() {
    const delMes = State.gastos.filter(g => !g.mesCierre || g.mesCierre === this.mesActual);
    const ars = delMes.filter(g => g.moneda === 'ARS').reduce((a, g) => a + g.monto, 0);
    const usd = delMes.filter(g => g.moneda === 'USD').reduce((a, g) => a + g.monto, 0);
    const pend = delMes.filter(g => g.estado === 'pendiente').length;
    const counts = {};
    delMes.forEach(g => counts[g.cat] = (counts[g.cat]||0)+1);
    const top = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('g-kpi-ars', State.fmtARS(ars));
    set('g-kpi-usd', State.fmtUSD(usd));
    set('g-kpi-pend', pend);
    set('g-kpi-cat', top ? this.catObj(top[0]).nombre : '—');
  },

  renderTable() {
    const rows = (this.activeCat === 'all' ? State.gastos : State.gastos.filter(g => g.cat === this.activeCat));
    if (this.isMobile()) {
      const host = document.getElementById('gastos-cards');
      if (!host) return;
      if (!rows.length) { host.innerHTML = `<div class="empty-state"><i class="ti ti-receipt"></i><p>Sin gastos este mes</p></div>`; return; }
      host.innerHTML = rows.map(g => {
        const c = this.catObj(g.cat);
        const pagado = g.estado === 'pagado';
        return `<div class="card" style="margin-bottom:0;padding:12px 14px" onclick="Gastos.openEdit('${g.id}')">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px">
            <div style="min-width:0">
              <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${g.motivo}</div>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:1px">${g.fecha} · ${g.responsable}</div>
            </div>
            <div style="font-size:15px;font-weight:700;color:var(--text);white-space:nowrap">${g.moneda==='USD'?State.fmtUSD(g.monto):State.fmtARS(g.monto)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span class="badge" style="background:${c.color}22;color:${c.color};font-size:10px">${c.nombre}</span>
            <span class="badge ${pagado?'b-green':'b-amber'}" style="font-size:10px">${pagado?'Pagado':'Pendiente'}</span>
            ${g.esFijo?'<span class="badge b-blue" style="font-size:9px">Fijo</span>':''}
            ${g.esSueldoSocio?`<span class="badge b-purple" style="font-size:9px">Sueldo</span>`:''}
            <span style="font-size:10px;color:var(--text-secondary);margin-left:auto">${g.caja||''}</span>
          </div>
        </div>`;
      }).join('');
      return;
    }
    const tbody = document.getElementById('gastos-tbody');
    if (!tbody) return;
    tbody.innerHTML = rows.map(g => {
      const c = this.catObj(g.cat);
      const pagado = g.estado === 'pagado';
      return `<tr>
        <td>${g.fecha}${g.esFijo?' <span class="badge b-blue" style="font-size:9px">Fijo</span>':''}${g.esSueldoSocio?` <span class="badge b-purple" style="font-size:9px">Sueldo ${g.socioNombre||''}</span>`:''}</td>
        <td>${g.motivo}</td>
        <td><span class="badge" style="background:${c.color}22;color:${c.color}">${c.nombre}</span></td>
        <td>${g.responsable}</td><td style="font-size:11px;color:var(--text-secondary)">${g.caja}</td>
        <td><b>${g.moneda==='USD'?State.fmtUSD(g.monto):State.fmtARS(g.monto)}</b></td>
        <td><span class="badge ${pagado?'b-gray':'b-amber'}" style="opacity:${pagado?'0.45':'1'}">Pendiente</span> <span class="badge ${pagado?'b-green':'b-gray'}" style="opacity:${pagado?'1':'0.45'}">Pagado</span></td>
        <td><button class="btn btn-sm" onclick="Gastos.openEdit('${g.id}')">✏️ Editar</button></td>
      </tr>`;
    }).join('');
  },

  _labelInp(label, inp) {
    return `<div style="margin-bottom:10px"><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">${label}</label>${inp}</div>`;
  },
  _sel(style='') { return `width:100%;font-size:13px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg-secondary);color:var(--text);${style}`; },
  _inp(style='') { return `width:100%;font-size:13px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:8px;${style}`; },

  openNew() {
    const mobile = this.isMobile();
    const host = document.getElementById('gastos-modal-host');
    const wrapStyle = mobile
      ? 'position:fixed;inset:0;background:var(--bg-elevated);z-index:200;display:flex;flex-direction:column;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:16px'
      : 'position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:200';
    const cardStyle = mobile
      ? 'width:100%'
      : 'width:380px;max-width:92vw;background:var(--bg-elevated);border-radius:14px;padding:18px';
    host.innerHTML = `
      <div style="${wrapStyle}" ${mobile?'':'onclick="if(event.target===this) Gastos.close()"'}>
        <div style="${cardStyle}" onclick="event.stopPropagation()">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <h3 style="font-size:16px;font-weight:700">Registrar gasto</h3>
            <button class="btn btn-sm" onclick="Gastos.close()">✕ ${mobile?'Cancelar':''}</button>
          </div>
          ${this._labelInp('Motivo', `<input type="text" id="gf-motivo" style="${this._inp()}" placeholder="ej: Alquiler, nafta…">`)}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">
            ${this._labelInp('Categoría', `<select id="gf-cat" style="${this._sel()}">${State.categoriasGasto.map(c=>`<option value="${c.id}">${c.nombre}</option>`).join('')}</select>`)}
            ${this._labelInp('Responsable', `<select id="gf-resp" style="${this._sel()}">${State.personas.map(p=>`<option>${p}</option>`).join('')}</select>`)}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">
            ${this._labelInp('Moneda', `<select id="gf-moneda" style="${this._sel()}"><option value="ARS">ARS</option><option value="USD">USD</option></select>`)}
            ${this._labelInp('Monto', `<input type="number" id="gf-monto" style="${this._inp()}" inputmode="decimal">`)}
          </div>
          <div style="margin-bottom:14px">
            <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Caja que paga</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <select id="gf-caja-persona" style="${this._sel()}">${State.personas.map(p=>`<option>${p}</option>`).join('')}</select>
              <select id="gf-caja-bolsillo" style="${this._sel()}"><option>ARS cash</option><option>ARS transferencia</option><option>USD cash</option><option>USD transferencia</option><option>USDT</option></select>
            </div>
          </div>
          <div style="display:flex;gap:8px;${mobile?'':'justify-content:flex-end'}">
            ${mobile?'':'<button class="btn" onclick="Gastos.close()">Cancelar</button>'}
            <button class="btn btn-primary" style="${mobile?'flex:1;justify-content:center':''}" onclick="Gastos.save()">✓ Guardar</button>
          </div>
        </div>
      </div>
    `;
    setTimeout(() => document.getElementById('gf-motivo')?.focus(), 50);
  },
  close() { document.getElementById('gastos-modal-host').innerHTML = ''; },

  async save() {
    const motivo = document.getElementById('gf-motivo').value.trim();
    const monto = parseFloat(document.getElementById('gf-monto').value) || 0;
    if (!motivo || !monto) { toast('Completá motivo y monto.'); return; }
    const persona = document.getElementById('gf-caja-persona').value;
    const bolsillo = document.getElementById('gf-caja-bolsillo').value;
    const moneda = document.getElementById('gf-moneda').value;
    const cat = document.getElementById('gf-cat').value;
    const responsable = document.getElementById('gf-resp').value;

    toast('Guardando gasto...');
    const mesCierre = this.mesActual;
    const cotizacionUsada = moneda === 'ARS' ? State.refBlue : null;
    const newId = await DB.crearGasto({ motivo, cat, responsable, persona, bolsillo, moneda, monto, estado: 'pagado', mesCierre, cotizacionUsada });

    State.gastos.unshift({ id: newId || Date.now(), fecha: 'Hoy', motivo, cat, responsable, caja: `${persona}-${bolsillo}`, moneda, monto, estado: 'pagado', mesCierre, esFijo: false, esSueldoSocio: false, cotizacionUsada });
    State.debitarCaja(persona, bolsillo, monto);
    Sheets.gasto({ fecha: 'Hoy', motivo, responsable, caja: `${persona}-${bolsillo}`, moneda, monto, estado: 'pagado' }, this.catObj(cat).nombre);
    this.close(); this.renderChips(); this.renderKpis(); this.renderTable();
    toast('Gasto registrado y debitado de la caja correspondiente.');
  },

  openEdit(id) {
    const g = State.gastos.find(x => x.id === id);
    if (!g) return;
    const c = this.catObj(g.cat);
    const host = document.getElementById('gastos-modal-host');
    host.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:200" onclick="if(event.target===this) Gastos.close()">
        <div style="width:380px;max-width:92vw;background:var(--bg-elevated);border-radius:14px;padding:18px" onclick="event.stopPropagation()">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <h3 style="font-size:15px;font-weight:600">${g.motivo}</h3>
            <span class="badge" style="background:${c.color}22;color:${c.color}">${c.nombre}</span>
          </div>
          <p style="font-size:12px;color:var(--text-secondary);margin-bottom:14px">${g.fecha} · ${g.responsable} · ${g.caja}</p>
          <div style="display:flex;justify-content:space-between;padding:8px 0;font-weight:600;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-bottom:14px">
            Monto<span>${g.moneda==='USD'?State.fmtUSD(g.monto):State.fmtARS(g.monto)}</span>
          </div>
          <div style="margin-bottom:14px">
            <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Estado</label>
            <select id="ef-estado" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
              <option value="pagado" ${g.estado==='pagado'?'selected':''}>Pagado</option>
              <option value="pendiente" ${g.estado==='pendiente'?'selected':''}>Pendiente</option>
            </select>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:6px">
            <button class="btn" style="color:var(--red)" onclick="Gastos.deleteGasto('${g.id}')">🗑️ Eliminar</button>
            <div style="display:flex;gap:8px">
              <button class="btn" onclick="Gastos.close()">Cancelar</button>
              <button class="btn btn-primary" onclick="Gastos.saveEdit('${g.id}')">✓ Guardar</button>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  async saveEdit(id) {
    const g = State.gastos.find(x => x.id === id);
    if (!g) return;
    const nuevoEstado = document.getElementById('ef-estado').value;
    g.estado = nuevoEstado;
    await DB.actualizarEstadoGasto(id, nuevoEstado);
    this.close();
    this.renderTable();
    toast('Gasto actualizado.');
  },

  async deleteGasto(id) {
    if (!confirm('¿Eliminar este gasto? Esta acción no revierte el monto en la caja automáticamente.')) return;
    await DB.eliminarGasto(id);
    State.gastos = State.gastos.filter(x => x.id !== id);
    this.close();
    this.renderChips();
    this.renderKpis();
    this.renderTable();
    toast('Gasto eliminado.');
  },

  manageCats() {
    const host = document.getElementById('gastos-modal-host');
    host.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:200" onclick="if(event.target===this) Gastos.close()">
        <div style="width:340px;max-width:92vw;background:var(--bg-elevated);border-radius:14px;padding:18px" onclick="event.stopPropagation()">
          <h3 style="font-size:15px;font-weight:600;margin-bottom:14px">Editar categorías</h3>
          <div id="cat-manage-list"></div>
          <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:8px" onclick="Gastos.addCat()"><i class="ti ti-plus"></i> Nueva categoría</button>
          <div style="text-align:right;margin-top:14px"><button class="btn" onclick="Gastos.close();Gastos.renderChips();Gastos.renderTable()">Listo</button></div>
        </div>
      </div>
    `;
    this.renderCatList();
  },
  renderCatList() {
    document.getElementById('cat-manage-list').innerHTML = State.categoriasGasto.map((c, i) => `
      <div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border)">
        <input type="color" value="${c.color}" onchange="Gastos.updateCatColor(${i}, this.value)">
        <input type="text" value="${c.nombre}" onchange="Gastos.updateCatNombre(${i}, this.value)" style="flex:1;font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:8px">
        <button onclick="Gastos.delCat(${i})" style="background:none;border:none;cursor:pointer;color:var(--red)">🗑️</button>
      </div>`).join('');
  },
  async updateCatColor(i, color) {
    State.categoriasGasto[i].color = color;
    await DB.editarCategoriaGasto(State.categoriasGasto[i].id, { color });
  },
  async updateCatNombre(i, nombre) {
    State.categoriasGasto[i].nombre = nombre;
    await DB.editarCategoriaGasto(State.categoriasGasto[i].id, { nombre });
  },
  async addCat() {
    const nombre = prompt('Nombre de la categoría:');
    if (!nombre) return;
    const nueva = await DB.agregarCategoriaGasto(nombre, '#185FA5');
    State.categoriasGasto.push({ id: nueva?.id || ('cat-' + Date.now()), nombre, color: '#185FA5' });
    this.renderCatList();
  },
  async delCat(i) {
    if (!confirm('¿Eliminar esta categoría?')) return;
    await DB.borrarCategoriaGasto(State.categoriasGasto[i].id);
    State.categoriasGasto.splice(i, 1);
    this.renderCatList();
  },

  viewGastosFijos() {
    const mobile = this.isMobile();
    return `
      <div style="padding:10px ${mobile?'12':'22'}px;background:var(--blue-light);font-size:12px;color:var(--blue);flex-shrink:0">
        <i class="ti ti-info-circle"></i> Plantilla de gastos fijos — editá una vez, cargalos cada mes desde Cierre de mes.
      </div>
      <div style="padding:10px ${mobile?'12':'22'}px;display:flex;justify-content:flex-end;flex-shrink:0">
        <button class="btn btn-primary btn-sm" onclick="Gastos.addFijo()"><i class="ti ti-plus"></i> Agregar gasto fijo</button>
      </div>
      <div class="body-pad" style="overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1;min-height:0;padding-top:0" id="fijos-list"></div>
    `;
  },

  renderFijosList() {
    const host = document.getElementById('fijos-list');
    if (!host) return;
    if (!State.gastosFijosPlantilla.length) { host.innerHTML = `<div class="empty-state"><i class="ti ti-repeat"></i>Todavía no tenés gastos fijos cargados</div>`; return; }
    if (this.isMobile()) {
      host.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px;padding:8px 12px">
        ${State.gastosFijosPlantilla.map((g,i) => `
          <div class="card" style="margin-bottom:0;padding:12px 14px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <input type="text" value="${g.motivo}" onchange="Gastos.editarFijoMotivo(${i}, this.value)" style="flex:1;font-size:13px;font-weight:600;padding:5px 8px;border:1px solid var(--border-strong);border-radius:6px;background:var(--bg-secondary);color:var(--text)">
              <button class="btn btn-sm" style="color:var(--red)" onclick="Gastos.delFijo(${i})">🗑️</button>
            </div>
            <div style="display:grid;grid-template-columns:1fr 90px 70px;gap:6px">
              <select onchange="Gastos.editarFijoCat(${i}, this.value)" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:6px;background:var(--bg-secondary);color:var(--text)">
                <option value="">Sin categoría</option>
                ${State.categoriasGasto.map(c=>`<option value="${c.id}" ${g.cat===c.id?'selected':''}>${c.nombre}</option>`).join('')}
              </select>
              <input type="number" value="${g.montoSugerido}" onchange="Gastos.editarFijoMonto(${i}, this.value)" placeholder="Monto" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:6px;background:var(--bg-secondary);color:var(--text)">
              <select onchange="Gastos.editarFijoMoneda(${i}, this.value)" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:6px;background:var(--bg-secondary);color:var(--text)">
                <option value="ARS" ${g.moneda==='ARS'?'selected':''}>ARS</option>
                <option value="USD" ${g.moneda==='USD'?'selected':''}>USD</option>
              </select>
            </div>
          </div>
        `).join('')}
      </div>`;
      return;
    }
    host.innerHTML = `
      <table><thead><tr><th>Concepto</th><th>Categoría</th><th>Monto sugerido</th><th>Moneda</th><th></th></tr></thead>
      <tbody>
        ${State.gastosFijosPlantilla.map((g,i) => `
          <tr>
            <td><input type="text" value="${g.motivo}" onchange="Gastos.editarFijoMotivo(${i}, this.value)" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:6px;width:100%"></td>
            <td>
              <select onchange="Gastos.editarFijoCat(${i}, this.value)" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:6px">
                <option value="">Sin categoría</option>
                ${State.categoriasGasto.map(c=>`<option value="${c.id}" ${g.cat===c.id?'selected':''}>${c.nombre}</option>`).join('')}
              </select>
            </td>
            <td><input type="number" value="${g.montoSugerido}" onchange="Gastos.editarFijoMonto(${i}, this.value)" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:6px;width:110px"></td>
            <td>
              <select onchange="Gastos.editarFijoMoneda(${i}, this.value)" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:6px">
                <option value="ARS" ${g.moneda==='ARS'?'selected':''}>ARS</option>
                <option value="USD" ${g.moneda==='USD'?'selected':''}>USD</option>
              </select>
            </td>
            <td><button class="btn btn-sm" style="color:var(--red)" onclick="Gastos.delFijo(${i})">🗑️</button></td>
          </tr>
        `).join('')}
      </tbody></table>
    `;
  },

  async addFijo() {
    const motivo = prompt('Nombre del gasto fijo (ej: Alquiler, Seguro, etc):');
    if (!motivo) return;
    const nuevo = await DB.agregarGastoFijo(motivo, null, 0, 'ARS');
    State.gastosFijosPlantilla.push({ id: nuevo?.id || ('fijo-'+Date.now()), motivo, cat: null, montoSugerido: 0, moneda: 'ARS', orden: State.gastosFijosPlantilla.length+1, activo: true });
    this.renderFijosList();
  },
  async editarFijoMotivo(i, val) { State.gastosFijosPlantilla[i].motivo = val; await DB.editarGastoFijo(State.gastosFijosPlantilla[i].id, { motivo: val }); },
  async editarFijoCat(i, val) { State.gastosFijosPlantilla[i].cat = val || null; },
  async editarFijoMonto(i, val) { State.gastosFijosPlantilla[i].montoSugerido = parseFloat(val)||0; await DB.editarGastoFijo(State.gastosFijosPlantilla[i].id, { montoSugerido: parseFloat(val)||0 }); },
  async editarFijoMoneda(i, val) { State.gastosFijosPlantilla[i].moneda = val; await DB.editarGastoFijo(State.gastosFijosPlantilla[i].id, { moneda: val }); },
  async delFijo(i) {
    if (!confirm(`¿Eliminar "${State.gastosFijosPlantilla[i].motivo}" de la plantilla?`)) return;
    await DB.borrarGastoFijo(State.gastosFijosPlantilla[i].id);
    State.gastosFijosPlantilla.splice(i, 1);
    this.renderFijosList();
  },

  viewCierre() {
    const meses = this.ultimosMeses(6);
    return `
      <div style="padding:14px 22px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <div style="display:flex;align-items:center;gap:8px">
          <label style="font-size:12px;color:var(--text-secondary);font-weight:600">Mes:</label>
          <select id="cierre-mes-selector" onchange="Gastos.cambiarMes(this.value)" style="font-size:12px;padding:6px 10px;border:1px solid var(--border-strong);border-radius:8px">
            ${meses.map(m => `<option value="${m.value}" ${m.value===this.mesActual?'selected':''}>${m.label}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-sm" onclick="Gastos.clonarFijos()"><i class="ti ti-copy"></i> Cargar gastos fijos del mes</button>
      </div>
      <div class="body-pad" id="cierre-body"></div>
    `;
  },

  ultimosMeses(n) {
    const arr = [];
    const hoy = new Date();
    for (let i = 0; i < n; i++) {
      const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
      const value = d.toISOString().slice(0, 7);
      const label = d.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
      arr.push({ value, label: label.charAt(0).toUpperCase() + label.slice(1) });
    }
    return arr;
  },

  cambiarMes(m) { this.mesActual = m; this.renderCierre(); },

  gastosDelMes(mes) { return State.gastos.filter(g => g.mesCierre === mes); },

  ventasDelMes(mes) {
    // En esta maqueta las ventas no tienen mes_cierre explícito; se contemplan
    // todas las ventas registradas hasta que el volumen de datos requiera
    // un filtro de fecha más granular.
    return State.ventas;
  },

  renderCierre() {
    const host = document.getElementById('cierre-body');
    if (!host) return;
    const mes = this.mesActual;
    const gastosMes = this.gastosDelMes(mes);
    // Cada gasto se convierte a USD usando SU PROPIA cotización (la del día que se pagó),
    // y de ahí pasamos a ARS con la cotización actual solo para mostrar el equivalente.
    const totalGastosUSD = gastosMes.reduce((a, g) => a + State.gastoEnUSD(g), 0);
    const totalGastosARS = totalGastosUSD * State.refBlue;
    const totalVentasARS = this.ventasDelMes(mes).reduce((a, v) => a + v.items.reduce((s, i) => s + i.precio, 0), 0) * State.refBlue;
    const spreadCueva = State.resultadoFinancieroMes();
    const diferencialTarjetaARS = State.resultadoDiferencialTarjetaMes() * State.refBlue;
    const totalIngresos = totalVentasARS + spreadCueva + diferencialTarjetaARS;
    const balance = totalIngresos - totalGastosARS;

    const cierreExistente = State.cierresMensuales.find(c => c.mes === mes);
    const yaCerrado = !!cierreExistente;
    const repartoGuardado = cierreExistente?.reparto || {};
    const socios = ['Franco', 'Angel', 'Lautaro', 'iPhoneMood'];

    host.innerHTML = `
      ${yaCerrado ? `<div style="background:var(--green-light);color:var(--green);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12.5px"><i class="ti ti-circle-check"></i> Este mes ya fue cerrado el ${new Date(cierreExistente.cerradoEn).toLocaleDateString('es-AR')}${cierreExistente.cerradoPor?` por ${cierreExistente.cerradoPor}`:''}.</div>` : ''}

      <div class="kpi-row" style="grid-template-columns:repeat(4,1fr);padding:0 0 14px 0;border:none">
        <div class="kpi"><label>Ingresos del mes</label><div class="val" style="color:var(--green)">${State.fmtARS(totalIngresos)}</div><div class="sub">ventas + spread cueva</div></div>
        <div class="kpi"><label>Gastos del mes</label><div class="val" style="color:var(--red)">${State.fmtARS(totalGastosARS)}</div><div class="sub">${gastosMes.length} gasto(s) cargados</div></div>
        <div class="kpi"><label>Balance</label><div class="val" style="color:var(--blue)">${State.fmtARS(balance)}</div><div class="sub">antes de repartir</div></div>
        <div class="kpi"><label>Balance en USD</label><div class="val">${State.fmtUSD(balance / State.refBlue)}</div><div class="sub">a cotización blue actual</div></div>
      </div>

      <div class="card">
        <div class="card-title"><i class="ti ti-chart-line"></i> Variación de gastos — últimos 6 meses (en USD)</div>
        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <select id="grafico-concepto-selector" onchange="Gastos.renderGraficoVariacion()" style="font-size:12px;padding:6px 10px;border:1px solid var(--border-strong);border-radius:8px">
            <option value="__categorias__">Ver por categoría</option>
            ${this.conceptosUnicos().map(m => `<option value="${m}">${m}</option>`).join('')}
          </select>
        </div>
        <div style="position:relative;height:240px"><canvas id="chart-gastos-variacion"></canvas></div>
      </div>

      <div class="card">
        <div class="card-title"><i class="ti ti-list"></i> Gastos cargados este mes</div>
        ${gastosMes.length ? `
          <table><thead><tr><th>Motivo</th><th>Categoría</th><th>Monto</th></tr></thead>
          <tbody>${gastosMes.map(g => `<tr><td>${g.motivo}${g.esSueldoSocio?` <span class="badge b-purple" style="font-size:9px">Sueldo</span>`:''}</td><td>${this.catObj(g.cat).nombre}</td><td>${g.moneda==='USD'?State.fmtUSD(g.monto):State.fmtARS(g.monto)}</td></tr>`).join('')}</tbody></table>
        ` : `<div class="empty-state"><i class="ti ti-receipt-off"></i>Todavía no cargaste gastos para este mes. Usá "Cargar gastos fijos del mes" o registrá uno nuevo desde la pestaña "Gastos del mes".</div>`}
      </div>

      <div class="card">
        <div class="card-title"><i class="ti ti-users"></i> Reparto del balance — sueldos de socios</div>
        <p style="font-size:11.5px;color:var(--text-secondary);margin-bottom:12px">Asigná cuánto le corresponde a cada uno este mes. Al confirmar, cada monto se carga como un gasto (categoría "Sueldo socio"), y se descuenta del balance.</p>
        <div id="reparto-inputs">
          ${socios.map(s => `
            <div style="display:flex;align-items:center;gap:10px;padding:6px 0">
              <div style="width:90px;font-size:12.5px;font-weight:600">${s}</div>
              <input type="number" id="reparto-${s}" value="${repartoGuardado[s] ?? ''}" placeholder="0" oninput="Gastos.actualizarRepartoPreview()" style="flex:1;font-size:12px;padding:6px 10px;border:1px solid var(--border-strong);border-radius:8px" ${yaCerrado?'disabled':''}>
              <span style="font-size:11px;color:var(--text-secondary)">USD</span>
            </div>
          `).join('')}
        </div>
        <div style="display:flex;justify-content:space-between;padding:10px 0;border-top:1px solid var(--border);margin-top:8px;font-size:12.5px">
          <span>Repartido</span><b id="reparto-total">USD 0.00</b>
        </div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12.5px;color:var(--text-secondary)">
          <span>Balance disponible</span><b>${State.fmtUSD(balance / State.refBlue)}</b>
        </div>
        ${!yaCerrado ? `<button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:12px" onclick="Gastos.confirmarCierre('${mes}')"><i class="ti ti-lock"></i> Confirmar y cerrar el mes</button>` : `<button class="btn" style="width:100%;justify-content:center;margin-top:12px" onclick="Gastos.reabrirMes('${mes}')"><i class="ti ti-lock-open"></i> Reabrir este mes</button>`}
      </div>

      <div class="card" id="analisis-optimizacion"></div>

      <div class="card">
        <div class="card-title"><i class="ti ti-history"></i> Historial de cierres</div>
        ${State.cierresMensuales.length ? `
          <table><thead><tr><th>Mes</th><th>Ingresos</th><th>Gastos</th><th>Balance</th><th>Franco</th><th>Angel</th><th>Lautaro</th><th>iPhoneMood</th></tr></thead>
          <tbody>${State.cierresMensuales.map(c => `<tr>
            <td>${c.mes}</td><td>${State.fmtARS(c.totalIngresos)}</td><td>${State.fmtARS(c.totalGastos)}</td><td><b>${State.fmtARS(c.balance)}</b></td>
            <td>USD ${(c.reparto?.Franco||0).toLocaleString('es-AR')}</td><td>USD ${(c.reparto?.Angel||0).toLocaleString('es-AR')}</td><td>USD ${(c.reparto?.Lautaro||0).toLocaleString('es-AR')}</td><td>USD ${(c.reparto?.iPhoneMood||0).toLocaleString('es-AR')}</td>
          </tr>`).join('')}</tbody></table>
        ` : `<div class="empty-state"><i class="ti ti-calendar-off"></i>Todavía no cerraste ningún mes</div>`}
      </div>
    `;
    this.actualizarRepartoPreview();
    this.renderGraficoVariacion();
    this.renderAnalisisOptimizacion();
  },

  actualizarRepartoPreview() {
    const socios = ['Franco', 'Angel', 'Lautaro', 'iPhoneMood'];
    let total = 0;
    socios.forEach(s => { const el = document.getElementById(`reparto-${s}`); if (el) total += parseFloat(el.value) || 0; });
    const el = document.getElementById('reparto-total');
    if (el) el.textContent = State.fmtUSD(total);
  },

  async clonarFijos() {
    if (!State.gastosFijosPlantilla.length) { toast('Todavía no tenés gastos fijos cargados en la plantilla. Andá a "Gastos fijos" para crearlos.'); return; }
    if (!confirm(`Se van a cargar ${State.gastosFijosPlantilla.length} gasto(s) fijo(s) para el mes ${this.mesActual}, usando los montos sugeridos de la plantilla. Podés editarlos después. ¿Continuar?`)) return;
    toast('Cargando gastos fijos...');
    for (const fijo of State.gastosFijosPlantilla.filter(f => f.activo !== false)) {
      const cotizacionUsada = fijo.moneda === 'ARS' ? State.refBlue : null;
      const newId = await DB.crearGasto({
        motivo: fijo.motivo, cat: fijo.cat, responsable: State.personas[0] || '', persona: State.personas[0] || '',
        bolsillo: 'ARS cash', moneda: fijo.moneda, monto: fijo.montoSugerido, estado: 'pendiente',
        esFijo: true, mesCierre: this.mesActual, cotizacionUsada
      });
      State.gastos.unshift({ id: newId || Date.now()+Math.random(), fecha: 'Hoy', motivo: fijo.motivo, cat: fijo.cat, responsable: State.personas[0]||'', caja: `${State.personas[0]||''}-ARS cash`, moneda: fijo.moneda, monto: fijo.montoSugerido, estado: 'pendiente', esFijo: true, mesCierre: this.mesActual, esSueldoSocio: false, cotizacionUsada });
    }
    this.renderCierre();
    toast('Gastos fijos cargados para este mes. Ajustá los montos y marcalos como pagados desde "Gastos del mes" a medida que los abonás.');
  },

  async confirmarCierre(mes) {
    const socios = ['Franco', 'Angel', 'Lautaro', 'iPhoneMood'];
    const reparto = {};
    socios.forEach(s => { const el = document.getElementById(`reparto-${s}`); reparto[s] = parseFloat(el?.value) || 0; });

    const gastosMes = this.gastosDelMes(mes);
    const totalGastosUSD = gastosMes.reduce((a, g) => a + State.gastoEnUSD(g), 0);
    const totalGastosARS = totalGastosUSD * State.refBlue;
    const totalVentasARS = this.ventasDelMes(mes).reduce((a, v) => a + v.items.reduce((s, i) => s + i.precio, 0), 0) * State.refBlue;
    const spreadCueva = State.resultadoFinancieroMes();
    const diferencialTarjetaARS = State.resultadoDiferencialTarjetaMes() * State.refBlue;
    const totalIngresos = totalVentasARS + spreadCueva + diferencialTarjetaARS;
    const balanceAntes = totalIngresos - totalGastosARS;

    if (!confirm(`¿Confirmar el cierre de ${mes}? Se va a registrar un gasto "Sueldo socio" por cada persona con monto asignado, y el mes va a quedar cerrado.`)) return;

    toast('Cerrando el mes...');
    const catSueldo = State.categoriasGasto.find(c => c.nombre === 'Sueldo socio');
    for (const socio of socios) {
      const monto = reparto[socio];
      if (!monto) continue;
      const newId = await DB.crearGasto({
        motivo: `Sueldo / reparto — ${socio}`, cat: catSueldo?.id || null, responsable: socio === 'iPhoneMood' ? (State.personas[0]||'') : socio,
        persona: State.personas[0] || '', bolsillo: 'USD cash', moneda: 'USD', monto, estado: 'pagado',
        esFijo: false, mesCierre: mes, esSueldoSocio: true, socioNombre: socio
      });
      State.gastos.unshift({ id: newId || Date.now()+Math.random(), fecha: 'Hoy', motivo: `Sueldo / reparto — ${socio}`, cat: catSueldo?.id||null, responsable: socio, caja: '', moneda: 'USD', monto, estado: 'pagado', esFijo: false, mesCierre: mes, esSueldoSocio: true, socioNombre: socio });
    }

    const balanceFinal = balanceAntes - (Object.values(reparto).reduce((a,v)=>a+v,0) * State.refBlue);
    const { error } = await DB.guardarCierreMensual(mes, totalIngresos, totalGastosARS, balanceFinal, reparto);
    if (error) { toast('Hubo un problema guardando el cierre.'); console.error(error); return; }

    const idx = State.cierresMensuales.findIndex(c => c.mes === mes);
    const nuevoCierre = { id: Date.now(), mes, totalIngresos, totalGastos: totalGastosARS, balance: balanceFinal, reparto, cerradoEn: new Date().toISOString(), cerradoPor: Auth.usuario?.nombre || '' };
    if (idx >= 0) State.cierresMensuales[idx] = nuevoCierre; else State.cierresMensuales.unshift(nuevoCierre);

    this.renderCierre();
    toast(`Mes ${mes} cerrado correctamente.`);
  },

  reabrirMes(mes) {
    if (!confirm('¿Reabrir este mes? Vas a poder editar el reparto de nuevo. Los gastos de sueldo ya cargados no se eliminan automáticamente — si necesitás corregirlos, hacelo desde "Gastos del mes".')) return;
    State.cierresMensuales = State.cierresMensuales.filter(c => c.mes !== mes);
    this.renderCierre();
  },

  // ============================================================
  // GRÁFICO DE VARIACIÓN — por concepto individual o por categoría
  // ============================================================
  conceptosUnicos() {
    // Conceptos que vienen de la plantilla de fijos (los más relevantes para comparar mes a mes),
    // más cualquier otro motivo que se repita en al menos 2 meses distintos.
    const motivos = new Set(State.gastosFijosPlantilla.map(f => f.motivo));
    const porMotivo = {};
    State.gastos.forEach(g => {
      if (!g.mesCierre) return;
      if (!porMotivo[g.motivo]) porMotivo[g.motivo] = new Set();
      porMotivo[g.motivo].add(g.mesCierre);
    });
    Object.entries(porMotivo).forEach(([motivo, meses]) => { if (meses.size >= 2) motivos.add(motivo); });
    return Array.from(motivos).sort();
  },

  _chartVariacion: null,

  renderGraficoVariacion() {
    const ctx = document.getElementById('chart-gastos-variacion');
    if (!ctx) return;
    if (this._chartVariacion) { this._chartVariacion.destroy(); this._chartVariacion = null; }

    const meses = this.ultimosMeses(6).reverse(); // orden cronológico para el gráfico
    const selector = document.getElementById('grafico-concepto-selector');
    const modo = selector ? selector.value : '__categorias__';

    let datasets = [];
    const colores = ['#185FA5', '#3B6D11', '#854F0B', '#3C3489', '#085041', '#791F1F'];

    if (modo === '__categorias__') {
      State.categoriasGasto.forEach((cat, i) => {
        const data = meses.map(m => {
          const gastosDelMesYCat = State.gastos.filter(g => g.mesCierre === m.value && g.cat === cat.id);
          return +gastosDelMesYCat.reduce((a, g) => a + State.gastoEnUSD(g), 0).toFixed(2);
        });
        if (data.some(v => v > 0)) datasets.push({ label: cat.nombre, data, borderColor: cat.color, backgroundColor: cat.color + '22', tension: 0.3 });
      });
    } else {
      const data = meses.map(m => {
        const gastosDelMesYConcepto = State.gastos.filter(g => g.mesCierre === m.value && g.motivo === modo);
        return +gastosDelMesYConcepto.reduce((a, g) => a + State.gastoEnUSD(g), 0).toFixed(2);
      });
      datasets.push({ label: modo, data, borderColor: colores[0], backgroundColor: colores[0] + '22', fill: true, tension: 0.3 });
    }

    if (!datasets.length) {
      ctx.parentElement.innerHTML = `<div class="empty-state"><i class="ti ti-chart-line"></i>Todavía no hay suficientes datos cargados para graficar esta serie</div>`;
      return;
    }

    this._chartVariacion = new Chart(ctx, {
      type: 'line',
      data: { labels: meses.map(m => m.label.split(' ')[0].substring(0,3)), datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10.5 }, color: '#AEAEB2' } } },
        scales: {
          y: { ticks: { callback: v => 'USD ' + v, font: { size: 10 }, color: '#AEAEB2' }, grid: { color: 'rgba(255,255,255,.08)' } },
          x: { grid: { display: false }, ticks: { font: { size: 10.5 } } }
        }
      }
    });
  },

  // ============================================================
  // ANÁLISIS DE OPTIMIZACIÓN — compara el mes actual contra el promedio histórico
  // ============================================================
  renderAnalisisOptimizacion() {
    const host = document.getElementById('analisis-optimizacion');
    if (!host) return;

    const meses = this.ultimosMeses(6);
    const mesActualData = this.gastosDelMes(this.mesActual);
    const mesesAnteriores = meses.filter(m => m.value !== this.mesActual);

    if (mesActualData.length === 0 || mesesAnteriores.length === 0) {
      host.innerHTML = `
        <div class="card-title"><i class="ti ti-bulb"></i> Análisis de optimización</div>
        <div class="empty-state"><i class="ti ti-chart-bar-off"></i>Necesitamos al menos 2 meses con gastos cargados para poder comparar tendencias.</div>
      `;
      return;
    }

    const hallazgos = [];

    // 1. Comparar cada concepto del mes actual contra su promedio en meses anteriores
    const conceptosDelMes = [...new Set(mesActualData.map(g => g.motivo))];
    conceptosDelMes.forEach(motivo => {
      const montoActual = mesActualData.filter(g => g.motivo === motivo).reduce((a, g) => a + State.gastoEnUSD(g), 0);
      const historico = [];
      mesesAnteriores.forEach(m => {
        const monto = State.gastos.filter(g => g.mesCierre === m.value && g.motivo === motivo).reduce((a, g) => a + State.gastoEnUSD(g), 0);
        if (monto > 0) historico.push(monto);
      });
      if (historico.length === 0) return;
      const promedio = historico.reduce((a, v) => a + v, 0) / historico.length;
      if (promedio === 0) return;
      const variacion = ((montoActual - promedio) / promedio) * 100;
      if (variacion >= 20) {
        hallazgos.push({ tipo: 'alerta', texto: `"${motivo}" subió ${variacion.toFixed(0)}% respecto a su promedio de los últimos meses (USD ${promedio.toFixed(0)} → USD ${montoActual.toFixed(0)}). Vale la pena revisar si hay forma de bajarlo.` });
      } else if (variacion <= -20) {
        hallazgos.push({ tipo: 'positivo', texto: `"${motivo}" bajó ${Math.abs(variacion).toFixed(0)}% respecto a su promedio (USD ${promedio.toFixed(0)} → USD ${montoActual.toFixed(0)}). Buena señal.` });
      }
    });

    // 2. Identificar el gasto más grande del mes (fuera de sueldos)
    const sinSueldos = mesActualData.filter(g => !g.esSueldoSocio);
    if (sinSueldos.length) {
      const mayor = sinSueldos.reduce((max, g) => State.gastoEnUSD(g) > State.gastoEnUSD(max) ? g : max);
      const montoMayor = State.gastoEnUSD(mayor);
      const totalSinSueldos = sinSueldos.reduce((a, g) => a + State.gastoEnUSD(g), 0);
      const pctDelTotal = totalSinSueldos ? (montoMayor / totalSinSueldos) * 100 : 0;
      if (pctDelTotal >= 30) {
        hallazgos.push({ tipo: 'info', texto: `"${mayor.motivo}" representa el ${pctDelTotal.toFixed(0)}% de los gastos operativos del mes (USD ${montoMayor.toFixed(0)} de USD ${totalSinSueldos.toFixed(0)}). Es tu gasto más concentrado — cualquier ajuste ahí tiene impacto grande.`});
      }
    }

    // 3. Gastos fijos pendientes de pago acumulados (riesgo de mora)
    const fijosPendientes = mesActualData.filter(g => g.esFijo && g.estado === 'pendiente');
    if (fijosPendientes.length > 0) {
      const totalPendiente = fijosPendientes.reduce((a, g) => a + State.gastoEnUSD(g), 0);
      hallazgos.push({ tipo: 'alerta', texto: `Tenés ${fijosPendientes.length} gasto(s) fijo(s) de este mes todavía sin marcar como pagados, por USD ${totalPendiente.toFixed(0)} en total (${fijosPendientes.map(g=>g.motivo).join(', ')}). Convendría regularizarlos antes de fin de mes.` });
    }

    // 4. Tendencia general de gastos totales (excluyendo sueldos) en los últimos meses
    const totalesPorMes = meses.map(m => {
      const total = State.gastos.filter(g => g.mesCierre === m.value && !g.esSueldoSocio).reduce((a, g) => a + State.gastoEnUSD(g), 0);
      return { mes: m.label, total };
    }).filter(x => x.total > 0).reverse();
    if (totalesPorMes.length >= 3) {
      const primero = totalesPorMes[0].total;
      const ultimo = totalesPorMes[totalesPorMes.length - 1].total;
      if (primero > 0) {
        const variacionGeneral = ((ultimo - primero) / primero) * 100;
        if (variacionGeneral >= 15) {
          hallazgos.push({ tipo: 'alerta', texto: `Los gastos operativos totales vienen en alza: subieron ${variacionGeneral.toFixed(0)}% desde ${totalesPorMes[0].mes} hasta ahora. Conviene revisar la estructura de costos general.` });
        } else if (variacionGeneral <= -15) {
          hallazgos.push({ tipo: 'positivo', texto: `Los gastos operativos totales vienen bajando: ${Math.abs(variacionGeneral).toFixed(0)}% menos desde ${totalesPorMes[0].mes}. Buen control de costos.` });
        }
      }
    }

    if (hallazgos.length === 0) {
      hallazgos.push({ tipo: 'info', texto: 'No se detectaron variaciones significativas este mes. Los gastos se mantuvieron dentro de los rangos habituales.' });
    }

    const iconPorTipo = { alerta: 'ti-alert-triangle', positivo: 'ti-trending-down', info: 'ti-info-circle' };
    const colorPorTipo = { alerta: 'var(--amber)', positivo: 'var(--green)', info: 'var(--blue)' };
    const bgPorTipo = { alerta: 'var(--amber-light)', positivo: 'var(--green-light)', info: 'var(--blue-light)' };

    host.innerHTML = `
      <div class="card-title"><i class="ti ti-bulb"></i> Análisis de optimización — a tener en cuenta para el próximo mes</div>
      ${hallazgos.map(h => `
        <div style="display:flex;gap:10px;align-items:flex-start;background:${bgPorTipo[h.tipo]};border-radius:8px;padding:10px 12px;margin-bottom:8px">
          <i class="ti ${iconPorTipo[h.tipo]}" style="color:${colorPorTipo[h.tipo]};font-size:16px;flex-shrink:0;margin-top:1px"></i>
          <span style="font-size:12px;color:${colorPorTipo[h.tipo]};line-height:1.5">${h.texto}</span>
        </div>
      `).join('')}
    `;
  }
};


window.Gastos = Gastos;
