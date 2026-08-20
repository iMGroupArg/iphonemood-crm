const Cueva = {
  opType: 'ars-usd',
  OP_TYPES: [
    { id: 'ars-usd', label: 'ARS → USD', monedaO: 'ARS', monedaD: 'USD' },
    { id: 'ars-usdt', label: 'ARS → USDT', monedaO: 'ARS', monedaD: 'USDT' },
    { id: 'usd-usdt', label: 'USD → USDT', monedaO: 'USD', monedaD: 'USDT' },
    { id: 'usdt-ars', label: 'USDT → ARS', monedaO: 'USDT', monedaD: 'ARS' },
    { id: 'usd-ars', label: 'USD → ARS', monedaO: 'USD', monedaD: 'ARS' },
  ],
  BOLSILLOS: { ARS: ['ARS cash', 'ARS transferencia'], USD: ['USD cash', 'USD transferencia'], USDT: ['USDT'] },

  // Mismo selector de período que Ventas/Dashboard, y mismo filtro
  // subyacente (State.cambiosEnPeriodo). Antes esta pantalla llamaba a
  // State.resultadoFinancieroMes() sin mes, que pese al nombre suma TODA
  // la historia — el cartel decía "del mes" pero no filtraba nada.
  periodo: 'mes',
  periodoMes: '', periodoDesde: '', periodoHasta: '',

  _periodoDescriptor() {
    return { tipo: this.periodo, mes: this.periodoMes, desde: this.periodoDesde, hasta: this.periodoHasta };
  },

  render() {
    const c = document.createElement('div');
    // Mismo caso que Adelantos: la página es flex en columna, y sin esto el
    // contenido se recorta abajo en vez de generar scroll.
    c.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden';
    c.innerHTML = `
      <div style="padding:10px 22px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <div style="display:flex;gap:4px;overflow-x:auto;-webkit-overflow-scrolling:touch" id="cueva-periodo-tabs"></div>
        <button class="btn btn-primary" onclick="Cueva.openNew()"><i class="ti ti-plus"></i> Nueva operación</button>
      </div>
      <div id="cueva-rango-libre" style="display:none;padding:8px 22px;border-bottom:1px solid var(--border);gap:8px;align-items:center;flex-wrap:wrap">
        <input type="date" id="cueva-desde" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:8px;flex:1">
        <span style="font-size:12px;color:var(--text-secondary)">hasta</span>
        <input type="date" id="cueva-hasta" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:8px;flex:1">
        <button class="btn btn-sm btn-primary" onclick="Cueva.aplicarRangoLibre()">Aplicar</button>
      </div>
      <div style="background:var(--purple-light);padding:10px 22px;font-size:12px;color:var(--purple);display:flex;gap:16px;align-items:center;flex-wrap:wrap">
        <i class="ti ti-info-circle"></i>
        <div><b id="cueva-resultado-financiero">—</b> <span id="cueva-resultado-label">resultado financiero (spread de cambios — separado de las ventas)</span></div>
      </div>
      <div class="body-pad">
        <table><thead><tr><th>Fecha</th><th>Operación</th><th>Sale (origen)</th><th>Entra (destino)</th><th>Cotización</th><th>Spread</th><th></th></tr></thead>
        <tbody id="cueva-tbody"></tbody></table>
      </div>
      <div id="cueva-modal-host"></div>
    `;
    setTimeout(() => { this.renderPeriodoTabs(); this.renderTable(); }, 0);
    return c;
  },

  typeObj(id) { return this.OP_TYPES.find(t => t.id === id); },
  fmtByMoneda(v, m) { return m === 'ARS' ? State.fmtARS(v) : m === 'USDT' ? v.toLocaleString('es-AR') + ' USDT' : State.fmtUSD(v); },

  renderPeriodoTabs() {
    const el = document.getElementById('cueva-periodo-tabs');
    if (!el) return;
    const tabs = [['hoy','Hoy'],['semana','Esta semana'],['mes','Este mes'],['libre','Rango libre'],['todo','Todo']];
    // Misma lista de meses que usan Ventas/Dashboard, para que elegir el
    // mismo mes en cualquier pantalla dé exactamente el mismo filtro.
    const mesesOpts = Ventas._mesesDisponibles().map(m => {
      const [y, mo] = m.split('-');
      const label = new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('es-AR', { month: 'short', year: '2-digit' });
      return `<option value="${m}" ${this.periodoMes === m ? 'selected' : ''}>${label}</option>`;
    }).join('');
    el.innerHTML = tabs.map(([k, l]) =>
      `<button class="btn btn-sm ${this.periodo === k ? 'btn-primary' : ''}" onclick="Cueva.setPeriodo('${k}')">${l}</button>`
    ).join('')
    + `<select id="cueva-mes-selector" onchange="Cueva.setPeriodoMes(this.value)" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:8px;margin-left:4px;background:var(--bg-secondary);color:var(--text);${this.periodo === 'mes-especifico' ? 'border-color:var(--blue);outline:none' : ''}">
        <option value="">Mes específico…</option>
        ${mesesOpts}
      </select>`;
    const rangoEl = document.getElementById('cueva-rango-libre');
    if (rangoEl) rangoEl.style.display = this.periodo === 'libre' ? 'flex' : 'none';
  },

  setPeriodo(p) { this.periodo = p; this.periodoMes = ''; this.renderPeriodoTabs(); this.renderTable(); },
  setPeriodoMes(mes) {
    if (!mes) return;
    this.periodo = 'mes-especifico'; this.periodoMes = mes;
    this.renderPeriodoTabs(); this.renderTable();
  },
  aplicarRangoLibre() {
    this.periodoDesde = document.getElementById('cueva-desde')?.value || '';
    this.periodoHasta = document.getElementById('cueva-hasta')?.value || '';
    if (!this.periodoDesde || !this.periodoHasta) { toast('Elegí las dos fechas antes de aplicar.'); return; }
    this.periodo = 'libre';
    this.renderTable();
  },

  _labelPeriodo() {
    if (this.periodo === 'hoy') return 'resultado financiero de hoy';
    if (this.periodo === 'semana') return 'resultado financiero de esta semana';
    if (this.periodo === 'mes') return 'resultado financiero del mes';
    if (this.periodo === 'mes-especifico') return `resultado financiero de ${this.periodoMes || 'ese mes'}`;
    if (this.periodo === 'libre') return `resultado financiero del ${this.periodoDesde || '…'} al ${this.periodoHasta || '…'}`;
    return 'resultado financiero histórico (todo)';
  },

  renderTable() {
    const periodo = this._periodoDescriptor();
    const cambiosFiltrados = State.cambiosEnPeriodo(periodo);
    const spreadTotal = State.spreadCuevaDelPeriodo(periodo);
    const spreadTotalUSD = spreadTotal / State.refBlue;
    document.getElementById('cueva-resultado-financiero').innerHTML =
      `${spreadTotal>=0?'+':''}${State.fmtARS(spreadTotal)} <span style="opacity:.7;font-size:11px">≈ ${spreadTotalUSD>=0?'+':''}${State.fmtUSD(spreadTotalUSD)}</span>`;
    document.getElementById('cueva-resultado-label').textContent =
      `${this._labelPeriodo()} — ${cambiosFiltrados.length} operación(es) (spread de cambios, separado de las ventas)`;
    document.getElementById('cueva-tbody').innerHTML = cambiosFiltrados.map(o => {
      const t = this.typeObj(o.tipo);
      const spread = State.calcSpreadARS(o);
      const spreadUSD = spread / State.refBlue;
      return `<tr>
        <td>${o.fecha}</td><td><span class="badge b-purple">${t.label}</span></td>
        <td>${o.origenP} (${o.origenB})<br><b>${this.fmtByMoneda(o.entrega, t.monedaO)}</b></td>
        <td>${o.destinoP} (${o.destinoB})<br><b>${this.fmtByMoneda(o.recibe, t.monedaD)}</b></td>
        <td>$${o.cotiz.toLocaleString('es-AR')}</td>
        <td style="color:${spread>=0?'var(--green)':'var(--red)'};font-weight:600">
          ${spread>=0?'+':''}${State.fmtARS(spread)}<br>
          <span style="font-size:11px;font-weight:500;opacity:.8">${spreadUSD>=0?'+':''}${State.fmtUSD(spreadUSD)}</span>
        </td>
        <td><button class="btn btn-sm" onclick="Cueva.openView('${o.id}')">✏️ Ver</button></td>
      </tr>`;
    }).join('');
  },

  openView(id) {
    const o = State.cambios.find(x => x.id == id);
    if (!o) return;
    const t = this.typeObj(o.tipo);
    const spread = State.calcSpreadARS(o);
    const host = document.getElementById('cueva-modal-host');
    host.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:200" onclick="if(event.target===this) Cueva.close()">
        <div style="width:380px;max-width:92vw;background:var(--bg-elevated);border-radius:14px;padding:18px" onclick="event.stopPropagation()">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <h3 style="font-size:15px;font-weight:600">${t.label}</h3>
            <span class="badge b-purple">${o.fecha}</span>
          </div>
          <div style="background:var(--red-light);border-radius:8px;padding:10px 12px;margin-bottom:8px">
            <div style="font-size:11px;color:var(--red);font-weight:600;margin-bottom:2px">Sale de</div>
            <div style="font-size:13px">${o.origenP} — ${o.origenB}: <b>${this.fmtByMoneda(o.entrega, t.monedaO)}</b></div>
          </div>
          <div style="background:var(--green-light);border-radius:8px;padding:10px 12px;margin-bottom:12px">
            <div style="font-size:11px;color:var(--green);font-weight:600;margin-bottom:2px">Entra a</div>
            <div style="font-size:13px">${o.destinoP} — ${o.destinoB}: <b>${this.fmtByMoneda(o.recibe, t.monedaD)}</b></div>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid var(--border);font-size:12.5px"><span>Cotización usada</span><b>$${o.cotiz.toLocaleString('es-AR')}</b></div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:12.5px">
            <span>Spread</span>
            <div style="text-align:right">
              <b style="color:${spread>=0?'var(--green)':'var(--red)'}">${spread>=0?'+':''}${State.fmtARS(spread)}</b><br>
              <span style="font-size:11px;color:${spread>=0?'var(--green)':'var(--red)'};">${(spread/State.refBlue)>=0?'+':''}${State.fmtUSD(spread/State.refBlue)}</span>
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:14px">
            <button class="btn" style="color:var(--red)" onclick="Cueva.deleteOp('${o.id}')">🗑️ Eliminar</button>
            <button class="btn" onclick="Cueva.close()">Cerrar</button>
          </div>
        </div>
      </div>
    `;
  },

  async deleteOp(id) {
    const o = State.cambios.find(x => x.id == id);
    if (!o) return;
    if (!confirm('¿Eliminar esta operación de cambio? Esto revertirá el movimiento en las cajas de origen y destino.')) return;
    // Revertir el movimiento de plata entre cajas
    // Esperar la reversión antes de borrar la operación
    await Promise.all([
      State.acreditarCaja(o.origenP, o.origenB, o.entrega,
        { tipo: 'cueva_anulada', descripcion: 'Se deshizo un cambio de cueva' }),
      State.debitarCaja(o.destinoP, o.destinoB, o.recibe,
        { tipo: 'cueva_anulada', descripcion: 'Se deshizo un cambio de cueva' }),
    ]);
    await DB.eliminarCambio(id);
    State.cambios = State.cambios.filter(x => x.id != id);
    this.close();
    this.renderTable();
    toast('Operación eliminada. El movimiento se revirtió en ambas cajas.');
  },

  openNew() {
    const host = document.getElementById('cueva-modal-host');
    host.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:200" onclick="if(event.target===this) Cueva.close()">
        <div style="width:400px;max-width:92vw;max-height:88vh;overflow-y:auto;background:var(--bg-elevated);border-radius:14px;padding:18px" onclick="event.stopPropagation()">
          <h3 style="font-size:15px;font-weight:600;margin-bottom:14px">Nueva operación de cambio</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:12px" id="cueva-type-grid"></div>

          <div style="background:var(--red-light);border-radius:8px;padding:10px 12px;margin-bottom:8px">
            <b style="font-size:11px;color:var(--red)">Sale de (origen)</b>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px">
              <select id="cf-origen-p" style="font-size:12px;padding:6px 8px;border:1px solid var(--border-strong);border-radius:8px">${State.personas.map(p=>`<option>${p}</option>`).join('')}</select>
              <select id="cf-origen-b" style="font-size:12px;padding:6px 8px;border:1px solid var(--border-strong);border-radius:8px"></select>
            </div>
            <input type="number" id="cf-entrega" placeholder="Monto que sale" oninput="Cueva.calcPreview()" style="width:100%;font-size:12px;padding:7px 9px;border:1px solid var(--border-strong);border-radius:8px;margin-top:6px">
          </div>

          <div style="text-align:center;font-size:11px;color:var(--text-secondary);margin:4px 0">
            cotización compra <input type="number" id="cf-cotiz" value="1075" oninput="Cueva.calcPreview()" style="width:70px;text-align:center;border:1px solid var(--border-strong);border-radius:6px;padding:3px">
          </div>
          <div id="cf-venta-row" style="display:none;background:var(--bg-secondary);border-radius:8px;padding:8px 10px;margin:4px 0">
            <label style="display:flex;align-items:flex-start;gap:7px;font-size:11.5px;cursor:pointer">
              <input type="checkbox" id="cf-viene-venta" onchange="Cueva.updateBolsillos();Cueva.calcPreview()" style="margin-top:2px">
              <span>Esta plata <b>viene de una venta ya cargada</b>
                <span style="display:block;color:var(--text-secondary);font-size:10.5px;margin-top:2px">Marcalo si estos pesos los cobraste en una venta y ahora los estás pasando a dólares. Así el spread no vuelve a medir plata que la venta ya valuó.</span>
              </span>
            </label>
          </div>
          <div id="cf-cotizref-row" style="display:none;text-align:center;font-size:11px;color:var(--text-secondary);margin:2px 0">
            <span id="cf-cotizref-label">cotización referencia (venta)</span> <input type="number" id="cf-cotizref" value="1075" oninput="this._tocado=true;Cueva.calcPreview()" style="width:70px;text-align:center;border:1px solid var(--border-strong);border-radius:6px;padding:3px">
          </div>

          <div style="background:var(--green-light);border-radius:8px;padding:10px 12px;margin-bottom:8px">
            <b style="font-size:11px;color:var(--green)">Entra a (destino)</b>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px">
              <select id="cf-destino-p" style="font-size:12px;padding:6px 8px;border:1px solid var(--border-strong);border-radius:8px">${State.personas.map(p=>`<option>${p}</option>`).join('')}</select>
              <select id="cf-destino-b" style="font-size:12px;padding:6px 8px;border:1px solid var(--border-strong);border-radius:8px"></select>
            </div>
            <input type="number" id="cf-recibe" readonly placeholder="Monto que entra (calculado)" style="width:100%;font-size:12px;padding:7px 9px;border:1px solid var(--border-strong);border-radius:8px;margin-top:6px;opacity:.8">
          </div>

          <div id="cueva-preview" style="display:none;background:var(--purple-light);border-radius:8px;padding:10px 12px;margin-bottom:12px">
            <p style="font-size:11px;color:var(--purple)">Spread vs. referencia (va al resultado financiero)</p>
            <div id="cueva-preview-val" style="font-size:16px;font-weight:600"></div>
            <div id="cueva-preview-nota" style="display:none;font-size:10.5px;color:var(--text-secondary);margin-top:5px"></div>
          </div>

          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn" onclick="Cueva.close()">Cancelar</button>
            <button class="btn btn-primary" onclick="Cueva.save()">✓ Guardar</button>
          </div>
        </div>
      </div>
    `;
    this.renderTypeGrid();
  },
  close() { document.getElementById('cueva-modal-host').innerHTML = ''; },

  renderTypeGrid() {
    document.getElementById('cueva-type-grid').innerHTML = this.OP_TYPES.map(t =>
      `<button class="btn btn-sm ${this.opType===t.id?'btn-primary':''}" onclick="Cueva.setType('${t.id}')">${t.label}</button>`
    ).join('');
    this.updateBolsillos();
  },
  updateBolsillos() {
    const t = this.typeObj(this.opType);
    document.getElementById('cf-origen-b').innerHTML = this.BOLSILLOS[t.monedaO].map(b => `<option>${b}</option>`).join('');
    document.getElementById('cf-destino-b').innerHTML = this.BOLSILLOS[t.monedaD].map(b => `<option>${b}</option>`).join('');
    document.getElementById('cf-cotiz').value = t.id === 'ars-usdt' ? State.refUsdt : (t.id === 'usd-usdt' ? State.refUsdt : State.refBlue);

    // La casilla "viene de una venta" solo aplica a ARS→USD: es el caso donde
    // la plata cobrada en pesos se pasa a dólares y quedaba contada dos veces.
    const ventaRow = document.getElementById('cf-venta-row');
    const chk = document.getElementById('cf-viene-venta');
    if (ventaRow) {
      const aplica = t.id === 'ars-usd';
      ventaRow.style.display = aplica ? 'block' : 'none';
      if (!aplica && chk) chk.checked = false;
    }

    const refRow = document.getElementById('cf-cotizref-row');
    if (refRow) {
      const porVenta = t.id === 'ars-usd' && chk?.checked;
      refRow.style.display = (t.id === 'ars-usdt' || porVenta) ? 'block' : 'none';
      const lbl = document.getElementById('cf-cotizref-label');
      if (lbl) lbl.textContent = porVenta ? 'cotización usada en esa venta' : 'cotización referencia (venta)';
      const ref = document.getElementById('cf-cotizref');
      // Al marcar la casilla arranca en la cotización de esta misma operación:
      // si la plata se cambia a la misma cotización con la que se cobró, el
      // spread da cero, que es el caso más común.
      if (ref && !ref._tocado) ref.value = porVenta ? (document.getElementById('cf-cotiz').value || State.refBlue) : State.refBlue;
    }
  },
  setType(id) { this.opType = id; this.renderTypeGrid(); this.calcPreview(); },

  calcPreview() {
    const entrega = parseFloat(document.getElementById('cf-entrega').value) || 0;
    const cotiz = parseFloat(document.getElementById('cf-cotiz').value) || 0;
    let recibe = 0;
    if (this.opType === 'ars-usd') recibe = cotiz ? entrega / cotiz : 0;
    if (this.opType === 'ars-usdt') recibe = cotiz ? entrega / cotiz : 0;
    if (this.opType === 'usd-ars') recibe = entrega * cotiz;
    if (this.opType === 'usdt-ars') recibe = entrega * cotiz;
    if (this.opType === 'usd-usdt') recibe = entrega;
    document.getElementById('cf-recibe').value = recibe.toFixed(2);
    const cotizRef = parseFloat(document.getElementById('cf-cotizref')?.value) || null;
    const vieneDeVenta = !!document.getElementById('cf-viene-venta')?.checked;
    const spread = State.calcSpreadARS({ tipo: this.opType, entrega, recibe, cotiz, cotizRef, vieneDeVenta });
    const prev = document.getElementById('cueva-preview');
    if (entrega > 0) {
      prev.style.display = 'block';
      document.getElementById('cueva-preview-val').innerHTML = `${spread>=0?'+':''}${State.fmtARS(spread)} <span style="font-size:12px;opacity:.75">≈ ${spread>=0?'+':''}${State.fmtUSD(spread/State.refBlue)}</span>`;
      document.getElementById('cueva-preview-val').style.color = spread >= 0 ? 'var(--green)' : 'var(--red)';
      const nota = document.getElementById('cueva-preview-nota');
      if (nota) {
        nota.style.display = vieneDeVenta ? 'block' : 'none';
        nota.textContent = Math.abs(spread) < 0.5
          ? 'Da cero porque se cambia a la misma cotización con la que se cobró la venta: la ganancia ya la registró esa venta.'
          : 'Se mide contra la cotización de la venta, no contra el blue.';
      }
    } else prev.style.display = 'none';
  },

  async save() {
    const entrega = parseFloat(document.getElementById('cf-entrega').value) || 0;
    const recibe = parseFloat(document.getElementById('cf-recibe').value) || 0;
    const cotiz = parseFloat(document.getElementById('cf-cotiz').value) || 0;
    if (!entrega || !recibe) { toast('Completá los montos.'); return; }
    const origenP = document.getElementById('cf-origen-p').value, origenB = document.getElementById('cf-origen-b').value;
    const destinoP = document.getElementById('cf-destino-p').value, destinoB = document.getElementById('cf-destino-b').value;

    toast('Guardando operación...');

    // Mover la plata de verdad entre cajas (memoria + base de datos)
    State.debitarCaja(origenP, origenB, entrega,
      { tipo: 'cueva', descripcion: 'Cambio de moneda (cueva) — entrega' });
    State.acreditarCaja(destinoP, destinoB, recibe,
      { tipo: 'cueva', descripcion: 'Cambio de moneda (cueva) — recibe' });

    const cotizRef = parseFloat(document.getElementById('cf-cotizref')?.value) || null;
    const vieneDeVenta = this.opType === 'ars-usd' && !!document.getElementById('cf-viene-venta')?.checked;
    const nuevoOp = { tipo: this.opType, entrega, recibe, cotiz, cotizRef, vieneDeVenta, origenP, origenB, destinoP, destinoB };
    const cambioId = await DB.crearCambio(nuevoOp);
    Sheets.cambio(nuevoOp);

    // fechaISO en el momento de crear: sin esto, la operación no entraba en
    // ningún filtro por período (Hoy/Este mes) hasta recargar la página,
    // porque State.cambiosEnPeriodo() solo cuenta sin fecha en "Todo".
    State.cambios.unshift({ id: cambioId || Date.now(), fecha: 'Hoy', fechaISO: new Date().toISOString(), ...nuevoOp });
    this.close();
    this.renderTable();
    toast(`Operación guardada. Se debitó de la caja de ${origenP} y se acreditó en la de ${destinoP}. El spread quedó reflejado en el resultado financiero del mes.`);
  }
};


window.Cueva = Cueva;
