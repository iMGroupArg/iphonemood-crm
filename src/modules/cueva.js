const Cueva = {
  opType: 'ars-usd',
  OP_TYPES: [
    { id: 'ars-usd', label: 'ARS → USD', monedaO: 'ARS', monedaD: 'USD' },
    { id: 'usd-usdt', label: 'USD → USDT', monedaO: 'USD', monedaD: 'USDT' },
    { id: 'usdt-ars', label: 'USDT → ARS', monedaO: 'USDT', monedaD: 'ARS' },
    { id: 'usd-ars', label: 'USD → ARS', monedaO: 'USD', monedaD: 'ARS' },
  ],
  BOLSILLOS: { ARS: ['ARS cash', 'ARS transferencia'], USD: ['USD cash', 'USD transferencia'], USDT: ['USDT'] },

  render() {
    const c = document.createElement('div');
    c.innerHTML = `
      <div style="padding:10px 22px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:12px;color:var(--text-secondary)">${State.cambios.length} operaciones registradas</div>
        <button class="btn btn-primary" onclick="Cueva.openNew()"><i class="ti ti-plus"></i> Nueva operación</button>
      </div>
      <div style="background:var(--purple-light);padding:10px 22px;font-size:12px;color:var(--purple);display:flex;gap:16px;align-items:center;flex-wrap:wrap">
        <i class="ti ti-info-circle"></i>
        <div><b id="cueva-resultado-financiero">—</b> resultado financiero del mes (spread de cambios — separado de las ventas)</div>
      </div>
      <div class="body-pad">
        <table><thead><tr><th>Fecha</th><th>Operación</th><th>Sale (origen)</th><th>Entra (destino)</th><th>Cotización</th><th>Spread</th><th></th></tr></thead>
        <tbody id="cueva-tbody"></tbody></table>
      </div>
      <div id="cueva-modal-host"></div>
    `;
    setTimeout(() => this.renderTable(), 0);
    return c;
  },

  typeObj(id) { return this.OP_TYPES.find(t => t.id === id); },
  fmtByMoneda(v, m) { return m === 'ARS' ? State.fmtARS(v) : m === 'USDT' ? v.toLocaleString('es-AR') + ' USDT' : State.fmtUSD(v); },

  renderTable() {
    const spreadTotal = State.resultadoFinancieroMes();
    document.getElementById('cueva-resultado-financiero').textContent = (spreadTotal>=0?'+':'') + State.fmtARS(spreadTotal);
    document.getElementById('cueva-tbody').innerHTML = State.cambios.map(o => {
      const t = this.typeObj(o.tipo);
      const spread = State.calcSpreadARS(o);
      return `<tr>
        <td>${o.fecha}</td><td><span class="badge b-purple">${t.label}</span></td>
        <td>${o.origenP} (${o.origenB})<br><b>${this.fmtByMoneda(o.entrega, t.monedaO)}</b></td>
        <td>${o.destinoP} (${o.destinoB})<br><b>${this.fmtByMoneda(o.recibe, t.monedaD)}</b></td>
        <td>$${o.cotiz.toLocaleString('es-AR')}</td>
        <td style="color:${spread>=0?'var(--green)':'var(--red)'};font-weight:600">${spread>=0?'+':''}${State.fmtARS(spread)}</td>
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
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:12.5px"><span>Spread</span><b style="color:${spread>=0?'var(--green)':'var(--red)'}">${spread>=0?'+':''}${State.fmtARS(spread)}</b></div>
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
    State.acreditarCaja(o.origenP, o.origenB, o.entrega);
    State.debitarCaja(o.destinoP, o.destinoB, o.recibe);
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

          <div style="text-align:center;font-size:11px;color:var(--text-secondary);margin:4px 0">cotización <input type="number" id="cf-cotiz" value="1075" oninput="Cueva.calcPreview()" style="width:65px;text-align:center;border:1px solid var(--border-strong);border-radius:6px;padding:3px"></div>

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
    document.getElementById('cf-cotiz').value = t.id === 'usd-usdt' ? State.refUsdt : State.refBlue;
  },
  setType(id) { this.opType = id; this.renderTypeGrid(); this.calcPreview(); },

  calcPreview() {
    const entrega = parseFloat(document.getElementById('cf-entrega').value) || 0;
    const cotiz = parseFloat(document.getElementById('cf-cotiz').value) || 0;
    let recibe = 0;
    if (this.opType === 'ars-usd') recibe = cotiz ? entrega / cotiz : 0;
    if (this.opType === 'usd-ars') recibe = entrega * cotiz;
    if (this.opType === 'usdt-ars') recibe = entrega * cotiz;
    if (this.opType === 'usd-usdt') recibe = entrega;
    document.getElementById('cf-recibe').value = recibe.toFixed(2);
    const spread = State.calcSpreadARS({ tipo: this.opType, entrega, recibe, cotiz });
    const prev = document.getElementById('cueva-preview');
    if (entrega > 0) {
      prev.style.display = 'block';
      document.getElementById('cueva-preview-val').textContent = (spread>=0?'+':'') + State.fmtARS(spread);
      document.getElementById('cueva-preview-val').style.color = spread >= 0 ? 'var(--green)' : 'var(--red)';
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
    State.debitarCaja(origenP, origenB, entrega);
    State.acreditarCaja(destinoP, destinoB, recibe);

    const nuevoOp = { tipo: this.opType, entrega, recibe, cotiz, origenP, origenB, destinoP, destinoB };
    const cambioId = await DB.crearCambio(nuevoOp);
    Sheets.cambio(nuevoOp);

    State.cambios.unshift({ id: cambioId || Date.now(), fecha: 'Hoy', ...nuevoOp });
    this.close();
    this.renderTable();
    toast(`Operación guardada. Se debitó de la caja de ${origenP} y se acreditó en la de ${destinoP}. El spread quedó reflejado en el resultado financiero del mes.`);
  }
};


window.Cueva = Cueva;
