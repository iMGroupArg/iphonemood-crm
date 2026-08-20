const Proveedores = {
  _view: 'list', // list | proveedor | lote
  _proveedorId: null,
  _loteId: null,
  _loteWizard: null,

  render() {
    const el = document.createElement('div');
    el.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden';
    el.innerHTML = `
      <div style="padding:16px 22px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;flex-wrap:wrap;gap:10px">
        <div>
          <h2 style="font-size:20px;font-weight:700;margin:0">Proveedores</h2>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">Gestión de compras y órdenes de lote</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-sm" onclick="Proveedores.openNuevoLote()">🛒 Nueva Orden</button>
          <button class="btn btn-sm btn-primary" onclick="Proveedores.openNuevoProveedor()">➕ Nuevo Proveedor</button>
        </div>
      </div>
      <div id="prov-kpis" style="padding:12px 22px;display:flex;gap:10px;flex-wrap:wrap;flex-shrink:0;border-bottom:1px solid var(--border)"></div>
      <div id="prov-content" style="flex:1;overflow-y:auto;padding:18px 22px"></div>
    `;
    setTimeout(() => { this.renderKpis(); this.renderContent(); }, 0);
    return el;
  },

  renderKpis() {
    const lotes = State.lotesCompra || [];
    const provs = (State.proveedores || []).filter(p => p.activo);
    const items = State.loteItems || [];
    const pagos = State.lotePagos || [];

    const activas = lotes.filter(l => !['recibido', 'cancelado'].includes(l.estado)).length;
    const pendienteTotal = lotes
      .filter(l => !['recibido', 'cancelado'].includes(l.estado))
      .reduce((s, l) => {
        const tot = items.filter(i => i.loteId === l.id).reduce((a, i) => a + i.precioUsd * i.cantidad, 0);
        const pag = pagos.filter(p => p.loteId === l.id && p.tipo === 'pago_proveedor').reduce((a, p) => a + p.montoUsd, 0);
        return s + Math.max(0, tot - pag);
      }, 0);
    const retrasadas = lotes.filter(l =>
      !['recibido', 'cancelado'].includes(l.estado) &&
      l.fechaLlegadaEsperada && new Date(l.fechaLlegadaEsperada) < new Date()
    ).length;

    const kpis = [
      ['Proveedores', provs.length, '🏭', 'var(--blue)', 'var(--blue-light)'],
      ['Lotes activos', activas, '📦', 'var(--amber)', 'rgba(255,214,10,.12)'],
      ['Pago pendiente', State.fmtUSD(pendienteTotal), '💸', pendienteTotal > 0 ? 'var(--red)' : 'var(--text)', pendienteTotal > 0 ? 'var(--red-light)' : 'var(--bg-secondary)'],
      ['Retrasados', retrasadas, retrasadas > 0 ? '⚠️' : '✅', retrasadas > 0 ? 'var(--red)' : 'var(--green)', retrasadas > 0 ? 'var(--red-light)' : 'var(--green-light)'],
    ];
    document.getElementById('prov-kpis').innerHTML = kpis.map(([label, val, emoji, color, bg]) => `
      <div class="card" style="padding:12px 14px;margin-bottom:0;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;min-width:130px;flex:1">
        <div><label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">${label}</label>
          <div style="font-size:18px;font-weight:700;color:${color}">${val}</div></div>
        <div style="width:34px;height:34px;border-radius:8px;background:${bg};display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">${emoji}</div>
      </div>`).join('');
  },

  renderContent() {
    const host = document.getElementById('prov-content');
    if (!host) return;
    if (this._view === 'lote') { this._renderDetalleLote(host); return; }
    if (this._view === 'proveedor') { this._renderDetalleProveedor(host); return; }
    this._renderLista(host);
  },

  // ── LISTA PRINCIPAL ──────────────────────────────────────────────

  _renderLista(host) {
    const provs = (State.proveedores || []).filter(p => p.activo);
    const lotes = State.lotesCompra || [];
    const items = State.loteItems || [];
    const pagos = State.lotePagos || [];

    const provRows = provs.map(p => {
      const lotesP = lotes.filter(l => l.proveedorId === p.id);
      const activos = lotesP.filter(l => !['recibido', 'cancelado'].includes(l.estado));
      const totalGastado = lotesP.flatMap(l => items.filter(i => i.loteId === l.id)).reduce((s, i) => s + i.precioUsd * i.cantidad, 0);
      const pendiente = activos.reduce((s, l) => {
        const tot = items.filter(i => i.loteId === l.id).reduce((a, i) => a + i.precioUsd * i.cantidad, 0);
        const pag = pagos.filter(pg => pg.loteId === l.id && pg.tipo === 'pago_proveedor').reduce((a, pg) => a + pg.montoUsd, 0);
        return s + Math.max(0, tot - pag);
      }, 0);
      const enStock = (State.stock || []).filter(s => s.proveedor === p.nombre).length;
      const retrasado = activos.some(l => l.fechaLlegadaEsperada && new Date(l.fechaLlegadaEsperada) < new Date());
      return `<tr style="border-bottom:1px solid var(--border);cursor:pointer" onclick="Proveedores.verProveedor('${p.id}')" onmouseenter="this.style.background='var(--bg-secondary)'" onmouseleave="this.style.background=''">
        <td style="padding:10px 6px">
          <span style="color:var(--blue);font-weight:600">${p.nombre}</span>
          ${retrasado ? ' <span style="color:var(--red);font-size:10px;font-weight:600">⚠️ retrasado</span>' : ''}
        </td>
        <td style="padding:10px 6px;font-size:12px;color:var(--text-secondary)">${p.contacto || '—'}${p.telefono ? `<br>${p.telefono}` : ''}</td>
        <td style="padding:10px 6px;text-align:center">${activos.length > 0 ? `<span style="background:rgba(255,214,10,.15);color:var(--amber-dark,#92400e);border-radius:12px;padding:2px 8px;font-size:11px;font-weight:600">${activos.length}</span>` : '—'}</td>
        <td style="padding:10px 6px;font-weight:600">${State.fmtUSD(totalGastado)}</td>
        <td style="padding:10px 6px;font-weight:600">${pendiente > 0 ? `<span style="color:var(--red)">${State.fmtUSD(pendiente)}</span>` : '<span style="color:var(--green)">Al día</span>'}</td>
        <td style="padding:10px 6px">${enStock > 0 ? `<span style="background:var(--blue-light);color:var(--blue);border-radius:12px;padding:2px 8px;font-size:11px;font-weight:600">📦 ${enStock}</span>` : '—'}</td>
        <td style="padding:10px 6px" onclick="event.stopPropagation()">
          <button class="btn btn-sm" onclick="Proveedores.openNuevoLote('${p.id}')" title="Nueva orden">🛒</button>
          <button class="btn btn-sm" onclick="Proveedores.openEditarProveedor('${p.id}')" title="Editar">✏️</button>
          <button class="btn btn-sm" onclick="Proveedores.borrarProveedor('${p.id}')" title="Eliminar" style="color:var(--red)">🗑️</button>
        </td>
      </tr>`;
    }).join('');

    const lotesRecientes = [...lotes].slice(0, 8);

    host.innerHTML = `
      ${provs.length === 0 ? `<div class="empty-state" style="margin-top:60px">🏭<div>Sin proveedores aún</div><div style="font-size:12px;margin-top:6px">Creá tu primer proveedor con el botón <b>Nuevo Proveedor</b></div></div>` : `
      <div style="margin-bottom:14px">
        <input type="text" id="prov-search" placeholder="Buscar proveedor..." oninput="Proveedores._filtrarTabla()" style="font-size:12px;padding:7px 12px;border:1px solid var(--border-strong);border-radius:8px;width:100%;max-width:360px;background:var(--bg-secondary);color:var(--text)">
      </div>
      <div style="overflow-x:auto;margin-bottom:28px">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="border-bottom:2px solid var(--border)">
            ${['Proveedor','Contacto','Activos','Total comprado','Pendiente','En stock',''].map(h => `<th style="text-align:left;padding:7px 6px;font-size:10px;color:var(--text-secondary);font-weight:700;text-transform:uppercase;letter-spacing:.04em">${h}</th>`).join('')}
          </tr></thead>
          <tbody id="prov-tbody">${provRows}</tbody>
        </table>
      </div>`}
      <div style="font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Órdenes recientes</div>
      ${lotesRecientes.length ? lotesRecientes.map(l => this._loteCard(l)).join('') : '<div style="color:var(--text-secondary);font-size:12px">Sin órdenes aún.</div>'}
    `;
  },

  _filtrarTabla() {
    const q = (document.getElementById('prov-search')?.value || '').toLowerCase();
    document.querySelectorAll('#prov-tbody tr').forEach(tr => {
      tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  },

  _loteCard(l) {
    const prov = (State.proveedores || []).find(p => p.id === l.proveedorId);
    const items = (State.loteItems || []).filter(i => i.loteId === l.id);
    const pagos = (State.lotePagos || []).filter(p => p.loteId === l.id);
    const totalUsd = items.reduce((s, i) => s + i.precioUsd * i.cantidad, 0);
    const totalUds = items.reduce((s, i) => s + i.cantidad, 0);
    const conv = pagos.find(p => p.tipo === 'conversion');
    const isRetrasado = !['recibido', 'cancelado'].includes(l.estado) && l.fechaLlegadaEsperada && new Date(l.fechaLlegadaEsperada) < new Date();
    const estadoStyle = {
      programado: ['🗓️', 'var(--text-secondary)', 'var(--bg-secondary)'],
      pagado:     ['💸', 'var(--amber-dark,#92400e)', 'rgba(255,214,10,.12)'],
      recibido:   ['✅', 'var(--green)', 'var(--green-light)'],
      cancelado:  ['❌', 'var(--red)', 'var(--red-light)'],
    }[l.estado] || ['🗓️', 'var(--text-secondary)', 'var(--bg-secondary)'];

    return `<div class="card" style="padding:14px;margin-bottom:8px;cursor:pointer;transition:box-shadow .15s" onclick="Proveedores.verLote(${l.id})" onmouseenter="this.style.boxShadow='0 4px 16px rgba(0,0,0,.12)'" onmouseleave="this.style.boxShadow=''">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span style="font-weight:700;font-size:14px">${l.nombre || `Lote #${l.id}`}</span>
            <span style="background:${estadoStyle[2]};color:${estadoStyle[1]};border-radius:10px;padding:2px 8px;font-size:11px;font-weight:600">${estadoStyle[0]} ${l.estado}</span>
            ${isRetrasado ? '<span style="background:var(--red-light);color:var(--red);border-radius:10px;padding:2px 8px;font-size:11px;font-weight:600">⚠️ retrasado</span>' : ''}
          </div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:3px">${prov?.nombre || '—'} · ${items.length} ítem(s) · ${totalUds} uds · ${l.fechaOrden}</div>
          ${conv ? `<div style="font-size:11px;color:var(--text-tertiary);margin-top:2px">💱 Conversión: ${State.fmtUSD(conv.montoUsd)} → ${conv.montoUsdt.toFixed(2)} USDT (comisión ${conv.comisionPct}%)</div>` : ''}
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-size:16px;font-weight:700">${State.fmtUSD(totalUsd)}</div>
          <div style="font-size:11px;color:var(--text-secondary)">${totalUds} unidad(es)</div>
        </div>
      </div>
    </div>`;
  },

  verProveedor(id) { this._view = 'proveedor'; this._proveedorId = id; this.renderContent(); },
  verLote(id) { this._view = 'lote'; this._loteId = id; this.renderContent(); },

  back() {
    if (this._view === 'lote' && this._proveedorId) { this._view = 'proveedor'; }
    else { this._view = 'list'; this._proveedorId = null; }
    this._loteId = null;
    this.renderContent();
  },

  // ── DETALLE PROVEEDOR ────────────────────────────────────────────

  // Saldo a favor CON el proveedor (plata que nos debe, no al revés).
  // Cuenta corriente propia: 'generado' suma, 'aplicado' resta. No usa cajas,
  // así que no se mezcla con el efectivo real del negocio.
  saldoCredito(proveedorId) {
    return (State.proveedorCreditos || [])
      .filter(c => c.proveedorId === proveedorId)
      .reduce((s, c) => s + (c.tipo === 'generado' ? c.montoUsd : -c.montoUsd), 0);
  },

  _renderDetalleProveedor(host) {
    const p = (State.proveedores || []).find(x => x.id === this._proveedorId);
    if (!p) { this.back(); return; }
    const lotes = (State.lotesCompra || []).filter(l => l.proveedorId === p.id);
    const items = State.loteItems || [];
    const pagos = State.lotePagos || [];

    const totalGastado = lotes.flatMap(l => items.filter(i => i.loteId === l.id)).reduce((s, i) => s + i.precioUsd * i.cantidad, 0);
    const pendiente = lotes.filter(l => !['recibido', 'cancelado'].includes(l.estado)).reduce((s, l) => {
      const tot = items.filter(i => i.loteId === l.id).reduce((a, i) => a + i.precioUsd * i.cantidad, 0);
      const pag = pagos.filter(pg => pg.loteId === l.id && ['pago_proveedor', 'credito_aplicado'].includes(pg.tipo)).reduce((a, pg) => a + pg.montoUsd, 0);
      return s + Math.max(0, tot - pag);
    }, 0);
    const enStock = (State.stock || []).filter(s => s.proveedor === p.nombre).length;
    const saldoCredito = this.saldoCredito(p.id);
    const creditos = (State.proveedorCreditos || []).filter(c => c.proveedorId === p.id).slice().reverse();

    host.innerHTML = `
      <button class="btn btn-sm" onclick="Proveedores.back()" style="margin-bottom:16px">← Proveedores</button>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;margin-bottom:18px">
        <div>
          <h3 style="font-size:18px;font-weight:700;margin:0">🏭 ${p.nombre}</h3>
          ${p.contacto ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:3px">👤 ${p.contacto}${p.telefono ? ' · 📞 ' + p.telefono : ''}${p.email ? ' · ' + p.email : ''}</div>` : ''}
          ${p.notas ? `<div style="font-size:11px;color:var(--text-tertiary);margin-top:2px">📝 ${p.notas}</div>` : ''}
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm" onclick="Proveedores.openNuevoLote('${p.id}')">🛒 Nueva orden</button>
          <button class="btn btn-sm" onclick="Proveedores.openEditarProveedor('${p.id}')">✏️ Editar</button>
        </div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px">
        ${[['Total comprado', State.fmtUSD(totalGastado), '💰', 'var(--blue)'],
           ['Pendiente', State.fmtUSD(pendiente), '💸', pendiente > 0 ? 'var(--red)' : 'var(--green)'],
           ['Saldo a favor', State.fmtUSD(saldoCredito), '💳', saldoCredito > 0 ? 'var(--green)' : 'var(--text)'],
           ['Órdenes', lotes.length, '📋', 'var(--text)'],
           ['En stock', enStock, '📦', 'var(--text)'],
          ].map(([l, v, e, c]) => `<div class="card" style="padding:12px 14px;margin-bottom:0;min-width:120px;flex:1">
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">${l}</label>
            <div style="font-size:16px;font-weight:700;color:${c}">${e} ${v}</div>
          </div>`).join('')}
      </div>

      <div class="card" style="padding:14px;margin-bottom:20px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:${creditos.length ? '10px' : '0'}">
          <div style="font-size:13px;font-weight:700">💳 Saldo a favor — cuenta corriente con ${p.nombre}</div>
          <button class="btn btn-sm" onclick="Proveedores.modalAjusteCredito('${p.id}')">✏️ Ajuste manual</button>
        </div>
        <p style="font-size:11px;color:var(--text-secondary);margin:0 0 ${creditos.length ? '10px' : '0'} 0">
          Plata que <b>${p.nombre}</b> nos debe (sobrepagos o anticipos), usable como pago en una próxima orden. No es efectivo del negocio, por eso no aparece en las cajas ni en el total del Dashboard.
        </p>
        ${creditos.length ? `
          <table style="width:100%;font-size:12px">
            <thead><tr style="border-bottom:1px solid var(--border)"><th style="text-align:left;padding:5px 4px;color:var(--text-secondary);font-weight:600">Movimiento</th><th style="text-align:right;padding:5px 4px;color:var(--text-secondary);font-weight:600">Monto</th><th></th></tr></thead>
            <tbody>
              ${creditos.map(c => `
                <tr style="border-bottom:1px solid var(--border)">
                  <td style="padding:7px 4px">
                    <div>${c.tipo === 'generado' ? '⬆️ Crédito generado' : '⬇️ Crédito aplicado'}${c.loteId ? ` · <a href="#" onclick="Proveedores.verLote(${c.loteId});return false" style="color:var(--blue)">lote #${c.loteId}</a>` : ''}</div>
                    <div style="font-size:10px;color:var(--text-tertiary);margin-top:1px">${c.fecha}${c.notas ? ' · ' + c.notas : ''}</div>
                  </td>
                  <td style="text-align:right;padding:7px 4px;font-weight:600;color:${c.tipo === 'generado' ? 'var(--green)' : 'var(--red)'}">${c.tipo === 'generado' ? '+' : '−'}${State.fmtUSD(c.montoUsd)}</td>
                  <td style="text-align:right;padding:7px 4px">${!c.loteId ? `<button onclick="Proveedores.eliminarCreditoManual(${c.id})" style="background:none;border:none;cursor:pointer;color:var(--red);font-size:13px" title="Quitar este ajuste">🗑️</button>` : ''}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        ` : ''}
      </div>

      <div style="font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Órdenes / Lotes</div>
      ${lotes.length ? lotes.map(l => this._loteCard(l)).join('') : '<div class="empty-state" style="margin-top:30px">📋<div>Sin órdenes para este proveedor</div></div>'}
    `;
  },

  // ── DETALLE LOTE ─────────────────────────────────────────────────

  _renderDetalleLote(host) {
    const l = (State.lotesCompra || []).find(x => x.id === this._loteId);
    if (!l) { this.back(); return; }
    const prov = (State.proveedores || []).find(p => p.id === l.proveedorId);
    const items = (State.loteItems || []).filter(i => i.loteId === l.id);
    const pagos = (State.lotePagos || []).filter(p => p.loteId === l.id).sort((a, b) => a.id - b.id);

    const totalItems = items.reduce((s, i) => s + i.precioUsd * i.cantidad, 0);
    const totalUds = items.reduce((s, i) => s + i.cantidad, 0);
    const conv = pagos.find(p => p.tipo === 'conversion');
    const pagadoProveedor = pagos.filter(p => p.tipo === 'pago_proveedor').reduce((s, p) => s + p.montoUsd, 0);
    const creditoAplicadoLote = pagos.filter(p => p.tipo === 'credito_aplicado').reduce((s, p) => s + p.montoUsd, 0);
    const totalEnvio = pagos.filter(p => ['envio','costo','diferencial'].includes(p.tipo)).reduce((s, p) => s + p.montoUsd, 0);
    const comisionUsd = conv?.comisionUsd || 0;
    const costoTotal = totalItems + comisionUsd + totalEnvio;
    const costoUnit = totalUds > 0 ? costoTotal / totalUds : 0;
    const isTerminal = ['recibido', 'cancelado'].includes(l.estado);

    // Pagado = efectivo + saldo a favor aplicado. Si supera el costo, esa
    // diferencia es plata pagada de más que hay que guardar como crédito con
    // el proveedor — si no, queda flotando sin registrar en ningún lado.
    const pagadoTotal = pagadoProveedor + creditoAplicadoLote;
    const restante = Math.max(0, costoTotal - pagadoTotal);
    const excedenteBruto = Math.max(0, pagadoTotal - costoTotal);
    const creditoYaGeneradoDeLote = (State.proveedorCreditos || [])
      .filter(c => c.loteId === l.id && c.tipo === 'generado').reduce((s, c) => s + c.montoUsd, 0);
    const excedenteSinConvertir = +Math.max(0, excedenteBruto - creditoYaGeneradoDeLote).toFixed(2);
    const saldoCreditoProv = l.proveedorId ? this.saldoCredito(l.proveedorId) : 0;

    const pagoIcons = { conversion: '💱', pago_proveedor: '💸', envio: '🚚', costo: '💰', devolucion: '↩️', credito_aplicado: '💳' };
    const pagoLabels = { conversion: 'Conversión USD → USDT', pago_proveedor: 'Pago al proveedor', envio: 'Costo de envío', costo: 'Costo adicional', devolucion: 'Devolución del proveedor', credito_aplicado: 'Saldo a favor aplicado' };

    host.innerHTML = `
      <button class="btn btn-sm" onclick="Proveedores.back()" style="margin-bottom:16px">← ${prov?.nombre || 'Proveedores'}</button>

      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:16px">
        <div>
          <h3 style="font-size:18px;font-weight:700;margin:0">${l.nombre || `Lote #${l.id}`}</h3>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:3px">
            ${prov?.nombre || '—'} · Orden: ${l.fechaOrden}${l.fechaLlegadaEsperada ? ' · Llegada esperada: ' + l.fechaLlegadaEsperada : ''}
            ${l.fechaRecepcion ? ' · Recibido: ' + l.fechaRecepcion : ''}
          </div>
        </div>
        ${!isTerminal ? `<div style="display:flex;gap:6px;flex-wrap:wrap">
          ${!conv ? `<button class="btn btn-sm" onclick="Proveedores.modalConversion(${l.id})">💱 Conversión USD→USDT</button>` : ''}
          <button class="btn btn-sm btn-primary" onclick="Proveedores.modalPago(${l.id})">💸 Registrar pago</button>
          ${saldoCreditoProv > 0 ? `<button class="btn btn-sm" onclick="Proveedores.modalUsarCredito(${l.id})">💳 Usar saldo a favor (${State.fmtUSD(saldoCreditoProv)})</button>` : ''}
          <button class="btn btn-sm" onclick="Proveedores.modalCostoAdicional(${l.id})">💰 Agregar costo</button>
          <button class="btn btn-sm" onclick="Proveedores.modalEditarItems(${l.id})">✏️ Editar orden</button>
          ${pagadoTotal > 0 && l.estado !== 'recibido' ? `<button class="btn btn-sm btn-green" onclick="Proveedores.modalRecepcion(${l.id})">📦 Confirmar recepción</button>` : ''}
        </div>` : ''}
      </div>

      ${excedenteSinConvertir > 0 ? `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:var(--amber-light,#fff8e1);border-radius:8px;padding:10px 14px;margin-bottom:16px">
          <div style="font-size:12.5px;color:#b45309"><i class="ti ti-alert-triangle"></i> Se pagó <b>${State.fmtUSD(excedenteSinConvertir)}</b> de más en este lote — ¿lo guardamos como saldo a favor con ${prov?.nombre || 'el proveedor'} para usarlo en otra orden?</div>
          <button class="btn btn-sm btn-primary" onclick="Proveedores.convertirExcedenteACredito(${l.id})">💳 Guardar como saldo a favor</button>
        </div>
      ` : ''}

      <!-- Resumen financiero -->
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
        ${[['Subtotal items', State.fmtUSD(totalItems), '🛍️', 'var(--text)'],
           ['Comisión conv.', State.fmtUSD(comisionUsd), '💱', comisionUsd > 0 ? 'var(--amber)' : 'var(--text-secondary)'],
           ['Envío', State.fmtUSD(totalEnvio), '🚚', totalEnvio > 0 ? 'var(--text)' : 'var(--text-secondary)'],
           ['Costo total', State.fmtUSD(costoTotal), '💰', 'var(--blue)'],
           ['Costo / unidad', State.fmtUSD(costoUnit), '📊', 'var(--green)'],
           ['Pagado' + (creditoAplicadoLote > 0 ? ` (${State.fmtUSD(creditoAplicadoLote)} en crédito)` : ''), State.fmtUSD(pagadoTotal), '✅', restante > 0 ? 'var(--amber)' : 'var(--green)'],
          ].map(([label, val, e, c]) => `<div class="card" style="padding:10px 12px;margin-bottom:0;min-width:110px;flex:1">
            <label style="font-size:10px;color:var(--text-secondary);display:block;margin-bottom:3px">${label}</label>
            <div style="font-size:14px;font-weight:700;color:${c}">${e} ${val}</div>
          </div>`).join('')}
      </div>

      <!-- Items -->
      <div class="card" style="padding:14px;margin-bottom:14px">
        <div style="font-size:13px;font-weight:700;margin-bottom:10px">Items del lote (${totalUds} unidades)</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="border-bottom:1px solid var(--border)">
            ${['Producto','Uds','Precio/u','Logística/u','Costo final/u','Subtotal',''].map((h,i) => `<th style="text-align:${i===0?'left':'right'};padding:5px 4px;color:var(--text-secondary);font-weight:600">${h}</th>`).join('')}
          </tr></thead>
          <tbody>
            ${items.map(i => {
              const logAuto = totalUds > 0 ? (totalEnvio + comisionUsd) / totalUds : 0;
              const logUsada = i.logisticaManual != null ? i.logisticaManual : logAuto;
              const costoFinalU = i.precioUsd + logUsada;
              const esManual = i.logisticaManual != null;
              return `<tr style="border-bottom:1px solid var(--border)">
                <td style="padding:7px 4px">${State.esc(i.nombre)}${i.storage ? ` ${State.esc(i.storage)}` : ''}${i.color ? ` · ${State.esc(i.color)}` : ''}${i.grado && i.grado !== 'Sin grado' ? ` <span style="font-size:10px;color:var(--text-secondary)">(${State.esc(i.grado)})</span>` : ''}</td>
                <td style="text-align:right;padding:7px 4px">${i.cantidad}</td>
                <td style="text-align:right;padding:7px 4px">${State.fmtUSD(i.precioUsd)}</td>
                <td style="text-align:right;padding:7px 4px">
                  <div style="display:flex;align-items:center;justify-content:flex-end;gap:6px">
                    <span style="color:${esManual?'var(--blue)':'var(--amber)'};font-weight:${esManual?'600':'400'}">+${State.fmtUSD(logUsada)}</span>
                    <button onclick="Proveedores.editarLogistica(${i.id}, ${logAuto})" style="background:none;border:none;cursor:pointer;font-size:13px;line-height:1;padding:2px;opacity:.7" title="Editar logística de este ítem">✏️</button>
                    ${esManual ? `<button onclick="Proveedores.resetLogistica(${i.id})" style="background:none;border:none;cursor:pointer;font-size:12px;line-height:1;padding:2px;opacity:.7" title="Restaurar auto">↩️</button>` : ''}
                  </div>
                  ${esManual ? `<div style="font-size:9px;color:var(--text-secondary);text-align:right;margin-top:1px">auto: ${State.fmtUSD(logAuto)}</div>` : ''}
                </td>
                <td style="text-align:right;padding:7px 4px;font-weight:700;color:var(--blue)">${State.fmtUSD(costoFinalU)}</td>
                <td style="text-align:right;padding:7px 4px;font-weight:600">${State.fmtUSD(costoFinalU * i.cantidad)}</td>
                <td style="text-align:center;padding:7px 4px">
                  <button onclick="Proveedores.modalUnidades(${i.id})" style="background:none;border:1px solid var(--border-strong);border-radius:6px;padding:3px 7px;cursor:pointer;font-size:11px;white-space:nowrap;color:${(i.unidades||[]).length > 0 ? 'var(--blue)' : 'var(--text-secondary)'}" title="Datos por unidad (IMEI, color, almacenamiento)">${(i.unidades||[]).length > 0 ? `📋 ${i.unidades.length}/${i.cantidad}` : '📋 Datos'}</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>


      <!-- Costos adicionales -->
      <div class="card" style="padding:14px;margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-size:13px;font-weight:700">💰 Costos adicionales</div>
          ${!isTerminal ? `<button class="btn btn-sm" onclick="Proveedores.modalCostoAdicional(${l.id})">➕ Agregar</button>` : ''}
        </div>
        ${pagos.filter(p => ['envio','costo','diferencial'].includes(p.tipo)).length === 0
          ? '<div style="color:var(--text-secondary);font-size:12px">Sin costos registrados. Podés agregar envío, aduana, flete nacional, etc.</div>'
          : pagos.filter(p => ['envio','costo','diferencial'].includes(p.tipo)).map(pg => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
              <div>
                <div style="font-size:12px;font-weight:600">💰 ${pg.notas || 'Costo adicional'}</div>
                <div style="font-size:11px;color:var(--text-secondary)">${pg.fecha}${pg.persona ? ' · ' + pg.persona + ' (' + pg.bolsillo + ')' : ''}</div>
              </div>
              <div style="display:flex;align-items:center;gap:10px">
                <b style="font-size:13px">${State.fmtUSD(pg.montoUsd)}</b>
                ${!isTerminal ? `<button onclick="Proveedores.eliminarCosto(${l.id},${pg.id})" style="background:none;border:none;cursor:pointer;color:var(--red);font-size:14px" title="Eliminar costo">🗑️</button>` : ''}
              </div>
            </div>`).join('')}
        ${pagos.filter(p => ['envio','costo','diferencial'].includes(p.tipo)).length > 0 ? `<div style="text-align:right;font-size:12px;color:var(--text-secondary);margin-top:8px">Total costos: <b style="color:var(--text)">${State.fmtUSD(totalEnvio)}</b> · Prorrateo: <b style="color:var(--green)">${State.fmtUSD(totalUds > 0 ? totalEnvio / totalUds : 0)}/u</b></div>` : ''}
      </div>

      <!-- Línea de tiempo -->
      <div class="card" style="padding:14px;margin-bottom:14px">
        <div style="font-size:13px;font-weight:700;margin-bottom:12px">📋 Movimientos registrados</div>
        ${pagos.length === 0
          ? '<div style="color:var(--text-secondary);font-size:12px">Sin movimientos aún. Registrá la conversión o el pago al proveedor.</div>'
          : pagos.map(pg => {
              const desc = pg.tipo === 'conversion'
                ? `${State.fmtUSD(pg.montoUsd)} USD desde <b>${pg.persona}</b> (${pg.bolsillo}) → <b>${pg.montoUsdt.toFixed(2)} USDT</b> en ${pg.personaDest || pg.persona} · Comisión ${pg.comisionPct}% = ${State.fmtUSD(pg.comisionUsd)}`
                : pg.tipo === 'pago_proveedor'
                ? `${pg.moneda === 'ARS' ? State.fmtARS(pg.montoUsd * (State.refBlue||1)) : (pg.moneda === 'USDT' ? pg.montoUsdt?.toFixed(2) : pg.montoUsd.toFixed(2))} ${pg.moneda} desde <b>${pg.persona}</b> (${pg.bolsillo})${pg.moneda === 'ARS' ? ` ≈ ${State.fmtUSD(pg.montoUsd)}` : ''}`
                : pg.tipo === 'devolucion'
                ? `${State.fmtUSD(pg.montoUsd)} acreditado en <b>${pg.persona}</b> (${pg.bolsillo})`
                : pg.tipo === 'credito_aplicado'
                ? `${State.fmtUSD(pg.montoUsd)} del saldo a favor con ${prov?.nombre || 'el proveedor'} — no salió de ninguna caja`
                : `${State.fmtUSD(pg.montoUsd)} ${pg.moneda} desde <b>${pg.persona}</b> (${pg.bolsillo})`;
              // Qué hace revertir cada tipo
              const revertInfo = {
                devolucion:       { label: 'Revertir devolución',   accion: 'debitar',   quien: pg.persona, bolsillo: pg.bolsillo, monto: pg.montoUsd },
                costo:            { label: 'Eliminar costo',         accion: 'acreditar', quien: pg.persona, bolsillo: pg.bolsillo, monto: pg.montoUsd },
                envio:            { label: 'Eliminar costo envío',   accion: 'acreditar', quien: pg.persona, bolsillo: pg.bolsillo, monto: pg.montoUsd },
                pago_proveedor:   { label: 'Revertir pago',          accion: 'acreditar', quien: pg.persona, bolsillo: pg.bolsillo, monto: pg.montoUsd },
                conversion:       { label: 'Revertir conversión',    accion: null },
                credito_aplicado: { label: 'Devolver al saldo a favor', accion: null },
              }[pg.tipo];
              const btnRevertir = !isTerminal && revertInfo ? `<button onclick="Proveedores.revertirMovimientoLote(${l.id}, ${pg.id})" style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;cursor:pointer;color:var(--text-secondary);font-size:11px;white-space:nowrap" title="${revertInfo.label}">↩ Revertir</button>` : '';
              return `<div style="display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--border)">
                <div style="font-size:20px;flex-shrink:0;line-height:1;padding-top:2px">${pagoIcons[pg.tipo] || '📋'}</div>
                <div style="flex:1">
                  <div style="font-size:12px;font-weight:600">${pagoLabels[pg.tipo] || pg.tipo}</div>
                  <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${desc}</div>
                  <div style="font-size:10px;color:var(--text-tertiary);margin-top:2px">${pg.fecha}${pg.notas ? ' · ' + pg.notas : ''}</div>
                </div>
                <div style="flex-shrink:0;padding-top:2px">${btnRevertir}</div>
              </div>`;
            }).join('')}
      </div>

      <!-- Acciones footer -->
      ${isTerminal
        ? `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:${l.estado === 'recibido' ? 'var(--green-light)' : 'var(--red-light)'};border-radius:8px;font-size:13px;color:${l.estado === 'recibido' ? 'var(--green)' : 'var(--red)'};font-weight:600">
            <span>${l.estado === 'recibido' ? `✅ Recibido el ${l.fechaRecepcion}` : '❌ Orden cancelada'}</span>
            ${l.estado === 'cancelado' ? `<button class="btn btn-sm" onclick="Proveedores.eliminarLote(${l.id})" style="color:var(--red);border-color:var(--red);font-size:12px">🗑️ Eliminar orden</button>` : ''}
          </div>`
        : `<div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:20px">
            <button class="btn btn-red btn-sm" onclick="Proveedores.cancelarLote(${l.id})">🗑️ Cancelar orden</button>
            ${l.notas ? `<div style="font-size:11px;color:var(--text-secondary)">📝 ${l.notas}</div>` : ''}
          </div>`}
    `;
  },

  // ── MODAL PROVEEDOR ──────────────────────────────────────────────

  openNuevoProveedor() { this._modalProveedor(null); },
  openEditarProveedor(id) { this._modalProveedor(id); },

  _modalProveedor(id) {
    const p = id ? (State.proveedores || []).find(x => x.id === id) : null;
    const overlay = document.createElement('div');
    overlay.id = 'prov-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:800;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(480px,96vw);max-height:90dvh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
          <div style="font-size:16px;font-weight:700">${p ? 'Editar proveedor' : 'Nuevo Proveedor'}</div>
          <button onclick="document.getElementById('prov-modal-overlay').remove()" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:20px">✕</button>
        </div>
        <div style="padding:20px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:12px">
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Nombre del Proveedor *</label>
            <input id="pm-nombre" type="text" value="${p?.nombre || ''}" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Persona de contacto</label>
              <input id="pm-contacto" type="text" value="${p?.contacto || ''}" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Teléfono</label>
              <input id="pm-telefono" type="text" value="${p?.telefono || ''}" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Email</label>
            <input id="pm-email" type="email" value="${p?.email || ''}" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Notas</label>
            <textarea id="pm-notas" rows="2" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);resize:vertical;font-family:var(--font)">${p?.notas || ''}</textarea>
          </div>
        </div>
        <div style="padding:14px 20px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;flex-shrink:0">
          <button class="btn" onclick="document.getElementById('prov-modal-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Proveedores._guardarProveedor('${id || ''}')">✅ ${p ? 'Guardar' : 'Crear proveedor'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById('pm-nombre')?.focus(), 60);
  },

  async _guardarProveedor(id) {
    const nombre = document.getElementById('pm-nombre')?.value.trim();
    if (!nombre) { toast('Ingresá el nombre del proveedor', 'error'); return; }
    const data = {
      nombre,
      contacto: document.getElementById('pm-contacto')?.value.trim() || '',
      telefono: document.getElementById('pm-telefono')?.value.trim() || '',
      email: document.getElementById('pm-email')?.value.trim() || '',
      notas: document.getElementById('pm-notas')?.value.trim() || '',
    };
    await DB.guardarProveedor(id || null, data);
    document.getElementById('prov-modal-overlay')?.remove();
    toast(id ? 'Proveedor actualizado' : 'Proveedor creado', 'success');
    this.renderKpis();
    this.renderContent();
  },

  // ── WIZARD NUEVO LOTE ────────────────────────────────────────────

  openNuevoLote(proveedorId) {
    this._loteWizard = { paso: 1, proveedorId: proveedorId || '', nombre: '', fechaOrden: new Date().toISOString().slice(0, 10), fechaLlegadaEsperada: '', notas: '', items: [] };
    this._renderWizard();
  },

  _renderWizard() {
    const w = this._loteWizard;
    const provs = (State.proveedores || []).filter(p => p.activo);
    const stepsHtml = ['Información básica', 'Items del pedido', 'Confirmar'].map((t, i) => `
      <div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1">
        <div style="width:26px;height:26px;border-radius:50%;background:${w.paso > i+1 ? 'var(--green)' : w.paso === i+1 ? 'var(--blue)' : 'var(--bg-secondary)'};color:${w.paso >= i+1 ? '#fff' : 'var(--text-secondary)'};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border:2px solid ${w.paso >= i+1 ? (w.paso > i+1 ? 'var(--green)' : 'var(--blue)') : 'var(--border-strong)'}">${w.paso > i+1 ? '✓' : i+1}</div>
        <div style="font-size:10px;color:${w.paso === i+1 ? 'var(--blue)' : 'var(--text-secondary)'};font-weight:${w.paso === i+1 ? '600' : '400'};text-align:center;white-space:nowrap">${t}</div>
      </div>
      ${i < 2 ? `<div style="flex:1;height:2px;background:${w.paso > i+1 ? 'var(--green)' : 'var(--border-strong)'};margin-top:13px;max-width:50px"></div>` : ''}
    `).join('');

    let body = '';
    if (w.paso === 1) {
      body = `<div style="display:flex;flex-direction:column;gap:12px">
        <div>
          <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Proveedor *</label>
          <select id="lw-prov" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            <option value="">Seleccionar proveedor</option>
            ${provs.map(p => `<option value="${p.id}" ${w.proveedorId === p.id ? 'selected' : ''}>${p.nombre}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Nombre del lote (opcional)</label>
          <input id="lw-nombre" type="text" value="${w.nombre}" placeholder="Ej: iPhone 17 Pro — Julio 2026" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Fecha de orden *</label>
            <input id="lw-fecha" type="date" value="${w.fechaOrden}" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Llegada esperada</label>
            <input id="lw-llegada" type="date" value="${w.fechaLlegadaEsperada}" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Notas</label>
          <textarea id="lw-notas" rows="2" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);resize:vertical;font-family:var(--font)">${w.notas}</textarea>
        </div>
      </div>`;
    } else if (w.paso === 2) {
      const total = w.items.reduce((s, i) => s + i.precioUsd * i.cantidad, 0);
      body = `
        ${w.items.map((item, idx) => this._itemCard(item, idx)).join('')}
        <button onclick="Proveedores._agregarItem()" style="width:100%;padding:10px;border:2px dashed var(--border-strong);border-radius:8px;background:none;color:var(--blue);cursor:pointer;font-size:13px;font-weight:600;margin-bottom:8px">➕ Agregar item</button>
        <div id="lw-total" style="text-align:right;font-size:14px;font-weight:700;color:var(--blue)">Total: ${State.fmtUSD(total)}</div>
      `;
    } else {
      const prov = provs.find(p => p.id === w.proveedorId);
      const total = w.items.reduce((s, i) => s + i.precioUsd * i.cantidad, 0);
      const uds = w.items.reduce((s, i) => s + i.cantidad, 0);
      body = `
        <div style="background:var(--bg-secondary);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:8px;font-size:13px;margin-bottom:12px">
          ${[['Proveedor', prov?.nombre || '—'], ['Lote', w.nombre || 'Sin nombre'], ['Fecha', w.fechaOrden], ['Llegada esperada', w.fechaLlegadaEsperada || 'Sin definir']].map(([k, v]) => `<div style="display:flex;justify-content:space-between"><span style="color:var(--text-secondary)">${k}</span><b>${v}</b></div>`).join('')}
          <div style="border-top:1px solid var(--border);padding-top:8px">
            ${w.items.filter(i => i.nombre || i.modelo).map(i => `<div style="display:flex;justify-content:space-between;margin-bottom:3px"><span>${State.esc(this.tituloItem(i))} × ${i.cantidad}</span><b>${State.fmtUSD(i.precioUsd * i.cantidad)}</b></div>`).join('')}
          </div>
          <div style="display:flex;justify-content:space-between;border-top:1px solid var(--border);padding-top:8px;font-size:15px"><span style="color:var(--text-secondary)">Total</span><b style="color:var(--blue)">${State.fmtUSD(total)}</b></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-secondary)">Unidades</span><b>${uds}</b></div>
        </div>
        <div style="padding:10px 12px;background:var(--blue-light);border-radius:8px;font-size:12px;color:var(--blue)">
          💡 Una vez creada, podrás registrar la conversión USD→USDT, el pago al proveedor y el costo de envío desde el detalle del lote. Cada movimiento impacta las cajas al instante.
        </div>
      `;
    }

    let overlay = document.getElementById('lote-modal-overlay');
    if (!overlay) { overlay = document.createElement('div'); overlay.id = 'lote-modal-overlay'; document.body.appendChild(overlay); }
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:800;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(560px,96vw);max-height:92dvh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
          <div style="font-size:16px;font-weight:700">Nueva Orden de Compra</div>
          <button onclick="document.getElementById('lote-modal-overlay').remove()" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:20px">✕</button>
        </div>
        <div style="padding:12px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;flex-shrink:0">${stepsHtml}</div>
        <div style="padding:20px;overflow-y:auto;flex:1">${body}</div>
        <div style="padding:14px 20px;border-top:1px solid var(--border);display:flex;justify-content:space-between;gap:8px;flex-shrink:0">
          <button class="btn" onclick="${w.paso > 1 ? 'Proveedores._wizardAnterior()' : "document.getElementById('lote-modal-overlay').remove()"}">${w.paso > 1 ? '← Anterior' : 'Cancelar'}</button>
          <button class="btn btn-primary" onclick="${w.paso < 3 ? 'Proveedores._wizardSiguiente()' : 'Proveedores._crearLote()'}">${w.paso < 3 ? 'Siguiente →' : '✅ Crear orden'}</button>
        </div>
      </div>
    `;
  },

  // Categorías que se pueden comprar a un proveedor. Son las mismas de Stock,
  // así lo que entra por acá cae en el rubro correcto sin tocarlo a mano.
  CATS_COMPRA: ['iphone','android','mac','ipad','watch','audio','gaming','accesorio','repuesto','perfumeria','decant','herramienta','otro'],

  // Rubros donde el producto se identifica por su NOMBRE y no por un modelo de
  // catálogo. Importa porque ahí los campos están reutilizados a propósito:
  //   perfumería → modelo = marca · color = categoría · storage = concentración
  //   repuesto   → modelo = modelo compatible
  // Si acá se tratan como modelo/color/almacenamiento, entran datos sin sentido
  // (un perfume con storage '128GB') y se rompe el filtro de Perfumería del panel.
  //
  // NO se duplica la lista: la fuente única es Stock.CATS_NOMBRE_LIBRE. Tenerla
  // dos veces ya salió caro — una copia quedó sin 'decant' y dejaba un formulario
  // imposible de guardar.
  get CATS_NOMBRE_LIBRE() { return window.Stock?.CATS_NOMBRE_LIBRE || []; },
  esNombreLibre(cat) { return !!window.Stock?.esNombreLibre(cat); },
  esPerfume(cat) { return !!window.Stock?.esPerfume(cat); },

  _agregarItem() {
    this._loteWizard.items.push({
      cat: 'iphone', nombre: '', modelo: '', cantidad: 1, precioUsd: 0,
      storage: '', color: '', grado: 'Sin grado', estadoProducto: 'Nuevo / Sellado',
    });
    this._renderWizard();
  },
  _quitarItem(idx) { this._loteWizard.items.splice(idx, 1); this._renderWizard(); },
  _editItem(idx, campo, val) {
    const it = this._loteWizard.items[idx];
    if (!it) return;
    it[campo] = val;
    // En los rubros con modelo de catálogo, el nombre ES el modelo. En los de
    // nombre libre no: ahí el nombre lo escribe el usuario y `modelo` guarda
    // otra cosa (la marca del perfume, el modelo compatible del repuesto).
    if (campo === 'modelo' && !this.esNombreLibre(it.cat)) it.nombre = val;
  },

  // Un desplegable con la lista oficial + una opción "Otro (escribir)" que abre
  // un campo libre. Lo que se escriba entra igual al stock y desde ahí aparece
  // solo en los filtros, sin tener que tocar ninguna lista en el código.
  _selectConOtro(idx, campo, opciones, placeholder) {
    const it = this._loteWizard.items[idx];
    const valor = it[campo] || '';
    const esc = v => State.esc(v);
    const libre = !!it['_libre_' + campo] || (!!valor && !opciones.includes(valor));
    const est = 'width:100%;font-size:12px;padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:6px;color:var(--text)';
    return `
      <select onchange="Proveedores._editItemSelect(${idx},'${campo}',this.value)" style="${est}">
        <option value="">— Elegir —</option>
        ${opciones.map(o => `<option value="${esc(o)}" ${valor === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
        <option value="__otro__" ${libre ? 'selected' : ''}>Otro (escribir)</option>
      </select>
      <input type="text" placeholder="${esc(placeholder)}" value="${libre ? esc(valor) : ''}"
        oninput="Proveedores._editItem(${idx},'${campo}',this.value)"
        style="${est};margin-top:4px;display:${libre ? 'block' : 'none'}">`;
  },

  _editItemSelect(idx, campo, val) {
    const it = this._loteWizard.items[idx];
    if (!it) return;
    if (val === '__otro__') { it['_libre_' + campo] = true; it[campo] = ''; }
    else { it['_libre_' + campo] = false; it[campo] = val; }
    // Cambiar de rubro o de modelo invalida el almacenamiento y el color: cada
    // modelo tiene los suyos.
    if (campo === 'cat') { it.modelo = ''; it.nombre = ''; it.storage = ''; it.color = ''; it._libre_modelo = false; it._libre_storage = false; it._libre_color = false; }
    if (campo === 'modelo' && !this.esNombreLibre(it.cat)) { it.nombre = it.modelo; it.storage = ''; it.color = ''; it._libre_storage = false; it._libre_color = false; }
    this._renderWizard();
  },

  // Texto visible de un item. En los rubros de nombre libre el nombre ya lo dice
  // todo; en los de modelo se arma con modelo + almacenamiento + color.
  tituloItem(item) {
    if (this.esNombreLibre(item.cat)) {
      const extra = this.esPerfume(item.cat) ? [item.modelo, item.storage].filter(Boolean).join(' · ') : '';
      return [item.nombre, extra ? `(${extra})` : ''].filter(Boolean).join(' ');
    }
    return [item.modelo || item.nombre, item.storage, item.color].filter(Boolean).join(' ');
  },

  _placeholderNombre(cat) { return window.Stock?.placeholderNombre(cat) || ''; },

  _itemCard(item, idx) {
    const esc = v => State.esc(v);
    const cat = item.cat || 'iphone';
    const S = window.Stock;
    // Lista de modelos = catálogo fijo + lo que ya exista en el stock real.
    const modelos = S?.modelosParaCat(cat) || [];
    const specs = S?.specsParaModelo(item.modelo || '') || { s: [], c: [] };
    const tieneModelo = modelos.length > 0 && !this.esNombreLibre(cat);
    const esPerfume = this.esPerfume(cat);
    const marcasPf = Object.values(S?.marcasPerfumeria() || {}).flat();
    const est = 'width:100%;font-size:12px;padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:6px;color:var(--text)';
    const lbl = 'font-size:10px;color:var(--text-secondary);display:block;margin-bottom:2px';
    const titulo = this.tituloItem(item);
    return `
      <div style="background:var(--bg-secondary);border-radius:8px;padding:10px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div style="font-size:12px;font-weight:600">${esc(titulo) || `Item ${idx + 1}`}</div>
          <button onclick="Proveedores._quitarItem(${idx})" style="background:none;border:none;cursor:pointer;color:var(--red);font-size:14px">✕</button>
        </div>
        <div style="display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:8px">
          <div>
            <label style="${lbl}">Rubro</label>
            <select onchange="Proveedores._editItemSelect(${idx},'cat',this.value)" style="${est}">
              ${this.CATS_COMPRA.map(c => `<option value="${c}" ${cat === c ? 'selected' : ''}>${esc(S?.CAT_LABELS[c] || c)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label style="${lbl}">Cantidad</label>
            <input type="number" min="1" value="${item.cantidad}" oninput="Proveedores._editItem(${idx},'cantidad',+this.value);Proveedores._refrescarTotal()" style="${est}">
          </div>
          <div>
            <label style="${lbl}">Precio USD/u</label>
            <input type="number" min="0" step="0.01" value="${item.precioUsd}" oninput="Proveedores._editItem(${idx},'precioUsd',+this.value);Proveedores._refrescarTotal()" style="${est}">
          </div>
        </div>
        <div style="margin-top:6px">
          <label style="${lbl}">${tieneModelo ? 'Modelo *' : 'Nombre del producto *'}</label>
          ${tieneModelo
            ? this._selectConOtro(idx, 'modelo', modelos, 'Escribí el modelo')
            : `<input type="text" value="${esc(item.nombre || '')}" placeholder="${esc(this._placeholderNombre(cat))}" oninput="Proveedores._editItem(${idx},'nombre',this.value)" style="${est}">`}
        </div>
        ${esPerfume ? `
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:6px">
          <div>
            <label style="${lbl}">Marca</label>
            ${this._selectConOtro(idx, 'modelo', marcasPf, 'ej: Armaf')}
          </div>
          <div>
            <label style="${lbl}">Categoría</label>
            ${this._selectConOtro(idx, 'color', S?.PERFUME_CATEGORIAS || [], 'ej: Árabe')}
          </div>
          <div>
            <label style="${lbl}">Concentración</label>
            ${this._selectConOtro(idx, 'storage', S?.PERFUME_CONCENTRACIONES || [], 'ej: EDP')}
          </div>
        </div>` : cat === 'repuesto' ? `
        <div style="margin-top:6px">
          <label style="${lbl}">Modelo compatible <span style="font-weight:400">(opcional)</span></label>
          ${this._selectConOtro(idx, 'modelo', S?.todosLosModelos() || [], 'ej: Motorola G84')}
        </div>` : `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px">
          <div>
            <label style="${lbl}">Almacenamiento</label>
            ${this._selectConOtro(idx, 'storage', specs.s || [], 'ej: 256GB')}
          </div>
          <div>
            <label style="${lbl}">Color</label>
            ${this._selectConOtro(idx, 'color', specs.c || [], 'ej: Lavanda')}
          </div>
        </div>`}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px">
          <div>
            <label style="${lbl}">Grado</label>
            <select onchange="Proveedores._editItem(${idx},'grado',this.value)" style="${est}">
              ${(S?.GRADO_OPCIONES || ['Sin grado']).map(g => `<option ${(item.grado||'Sin grado') === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label style="${lbl}">Estado del producto</label>
            <select onchange="Proveedores._editItem(${idx},'estadoProducto',this.value)" style="${est}">
              ${(S?.ESTADO_OPCIONES || []).map(e => `<option ${(item.estadoProducto||'Nuevo / Sellado') === e ? 'selected' : ''}>${esc(e)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div style="text-align:right;font-size:11px;color:var(--text-secondary);margin-top:6px">Subtotal: <b>${State.fmtUSD(item.precioUsd * item.cantidad)}</b></div>
      </div>`;
  },
  _refrescarTotal() {
    const total = this._loteWizard.items.reduce((s, i) => s + i.precioUsd * i.cantidad, 0);
    const el = document.getElementById('lw-total');
    if (el) el.textContent = 'Total: ' + State.fmtUSD(total);
  },

  _wizardSiguiente() {
    const w = this._loteWizard;
    if (w.paso === 1) {
      w.proveedorId = document.getElementById('lw-prov')?.value;
      w.nombre = document.getElementById('lw-nombre')?.value.trim() || '';
      w.fechaOrden = document.getElementById('lw-fecha')?.value || '';
      w.fechaLlegadaEsperada = document.getElementById('lw-llegada')?.value || '';
      w.notas = document.getElementById('lw-notas')?.value.trim() || '';
      if (!w.proveedorId) { toast('Seleccioná un proveedor', 'error'); return; }
      if (!w.fechaOrden) { toast('Ingresá la fecha de orden', 'error'); return; }
      if (!w.items.length) w.items.push({ nombre: '', cantidad: 1, precioUsd: 0 });
    } else if (w.paso === 2) {
      const validos = w.items.filter(i => (i.nombre || i.modelo || '').trim());
      if (!validos.length) { toast('Agregá al menos un item', 'error'); return; }
    }
    w.paso++;
    this._renderWizard();
  },

  _wizardAnterior() { this._loteWizard.paso--; this._renderWizard(); },

  async _crearLote() {
    const w = this._loteWizard;
    const items = w.items
      .filter(i => (i.nombre || i.modelo || '').trim())
      // En los rubros con modelo de catálogo el nombre es el modelo; en los de
      // nombre libre se respeta lo que se escribió tal cual.
      .map(i => ({ ...i, nombre: (i.nombre || i.modelo || '').trim() }));
    if (!items.length) { toast('Agregá al menos un item', 'error'); return; }
    const lote = await DB.crearLote({ proveedorId: w.proveedorId, nombre: w.nombre, fechaOrden: w.fechaOrden, fechaLlegadaEsperada: w.fechaLlegadaEsperada || null, notas: w.notas }, items);
    document.getElementById('lote-modal-overlay')?.remove();
    toast('Orden creada correctamente', 'success');
    this._view = 'lote';
    this._loteId = lote.id;
    this.renderKpis();
    this.renderContent();
  },

  // ── MODAL CONVERSIÓN ─────────────────────────────────────────────

  modalConversion(loteId) {
    const items = (State.loteItems || []).filter(i => i.loteId === loteId);
    const totalUsd = items.reduce((s, i) => s + i.precioUsd * i.cantidad, 0);
    const personas = State.personas || [];

    const overlay = document.createElement('div');
    overlay.id = 'prov-conv-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(480px,96vw);overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:15px;font-weight:700">💱 Conversión USD → USDT</div>
          <button onclick="document.getElementById('prov-conv-overlay').remove()" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:18px">✕</button>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
          <div style="background:var(--blue-light);border-radius:8px;padding:10px;font-size:12px;color:var(--blue)">
            Total del lote: <b>${State.fmtUSD(totalUsd)}</b>. Ingresá el monto en USD que vas a convertir.
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Monto a convertir (USD)</label>
              <input id="conv-monto" type="number" min="0" step="0.01" value="${totalUsd.toFixed(2)}" oninput="Proveedores._calcConv()" style="width:100%;font-size:14px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Comisión (%)</label>
              <input id="conv-pct" type="number" min="0" max="20" step="0.1" value="3" oninput="Proveedores._calcConv()" style="width:100%;font-size:14px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
          </div>
          <div id="conv-resumen" style="background:var(--bg-secondary);border-radius:8px;padding:10px;font-size:12px"></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Desde (persona)</label>
              <select id="conv-p-origen" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                ${personas.map(p => `<option>${p}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Bolsillo USD origen</label>
              <select id="conv-b-origen" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                <option>USD cash</option><option>USD transferencia</option>
              </select>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Hacia (persona)</label>
              <select id="conv-p-dest" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                ${personas.map(p => `<option>${p}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Bolsillo destino</label>
              <select id="conv-b-dest" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                <option>USDT</option>
              </select>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Fecha</label>
              <input id="conv-fecha" type="date" value="${new Date().toISOString().slice(0, 10)}" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Notas</label>
              <input id="conv-notas" type="text" placeholder="Opcional..." style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('prov-conv-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Proveedores._confirmarConversion(${loteId})">💱 Confirmar conversión</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this._calcConv();
  },

  _calcConv() {
    const monto = parseFloat(document.getElementById('conv-monto')?.value) || 0;
    const pct = parseFloat(document.getElementById('conv-pct')?.value) || 0;
    const comision = monto * pct / 100;
    const usdt = monto - comision;
    const el = document.getElementById('conv-resumen');
    if (el) el.innerHTML = `
      <div style="display:flex;justify-content:space-between;margin-bottom:3px"><span style="color:var(--text-secondary)">USD a convertir:</span><b>${State.fmtUSD(monto)}</b></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:3px"><span style="color:var(--red)">Comisión (${pct}%):</span><b style="color:var(--red)">− ${State.fmtUSD(comision)}</b></div>
      <div style="display:flex;justify-content:space-between;border-top:1px solid var(--border);padding-top:5px;margin-top:2px"><span style="color:var(--text-secondary)">USDT a recibir:</span><b style="color:var(--green)">${usdt.toFixed(2)} USDT</b></div>
    `;
  },

  async _confirmarConversion(loteId) {
    const montoUsd = parseFloat(document.getElementById('conv-monto')?.value) || 0;
    const comisionPct = parseFloat(document.getElementById('conv-pct')?.value) || 0;
    const comisionUsd = Math.round(montoUsd * comisionPct) / 100;
    const montoUsdt = montoUsd - comisionUsd;
    const persona = document.getElementById('conv-p-origen')?.value;
    const bolsillo = document.getElementById('conv-b-origen')?.value;
    const personaDest = document.getElementById('conv-p-dest')?.value;
    const bolsilloDestino = document.getElementById('conv-b-dest')?.value;
    const fecha = document.getElementById('conv-fecha')?.value;
    const notas = document.getElementById('conv-notas')?.value.trim();

    if (!montoUsd || montoUsd <= 0) { toast('Ingresá un monto válido', 'error'); return; }

    // Impactar cajas por el motor central, para que queden en el libro
    await State.debitarCaja(persona, bolsillo, montoUsd,
      { tipo: 'proveedor', referencia: loteId, descripcion: `Conversión a USDT — pasa a ${personaDest} · ${bolsilloDestino}` });
    await State.acreditarCaja(personaDest, bolsilloDestino, montoUsdt,
      { tipo: 'proveedor', referencia: loteId, descripcion: `Conversión desde ${persona} · ${bolsillo} (comisión ${comisionPct}%)` });

    await DB.guardarLotePago(loteId, { tipo: 'conversion', montoUsd, montoUsdt, comisionPct, comisionUsd, moneda: 'USD', persona, bolsillo, personaDest, bolsilloDestino, fecha, notas });

    document.getElementById('prov-conv-overlay')?.remove();
    toast(`Conversión registrada: ${montoUsdt.toFixed(2)} USDT`, 'success');
    this.renderKpis();
    this.renderContent();
  },

  // ── MODAL PAGO PROVEEDOR ─────────────────────────────────────────

  modalPago(loteId) {
    const conv = (State.lotePagos || []).find(p => p.loteId === loteId && p.tipo === 'conversion');
    const personas = State.personas || [];
    const BOLSILLOS_POR_MONEDA = {
      'USDT':  ['USDT'],
      'USD':   ['USD cash', 'USD transferencia'],
      'ARS':   ['ARS cash', 'ARS transferencia'],
    };
    const overlay = document.createElement('div');
    overlay.id = 'prov-pago-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto';
    const monedaDefault = conv ? 'USDT' : 'USDT';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(420px,96vw);overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:15px;font-weight:700">💸 Pago al proveedor</div>
          <button onclick="document.getElementById('prov-pago-overlay').remove()" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:18px">✕</button>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:12px">

          ${conv ? `
            <div style="background:rgba(52,199,89,.1);border:1px solid rgba(52,199,89,.3);border-radius:8px;padding:10px 14px;font-size:13px;color:var(--green)">
              ✅ Conversión registrada: <b>${conv.montoUsdt.toFixed(2)} USDT</b> disponibles
            </div>` : `
            <div style="background:rgba(255,179,0,.1);border:1px solid rgba(255,179,0,.3);border-radius:8px;padding:10px 14px;font-size:13px;color:var(--amber)">
              ℹ️ Pago directo — sin conversión previa. El monto en USD se usa para el cálculo de costo.
            </div>`}

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">MONEDA</label>
              <select id="pago-moneda" onchange="Proveedores._onPagoMonedaChange()" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                <option value="USDT" ${monedaDefault==='USDT'?'selected':''}>USDT</option>
                <option value="USD">USD</option>
                <option value="ARS">ARS</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">MONTO</label>
              <input id="pago-monto" type="number" min="0" step="0.01"
                value="${conv ? conv.montoUsdt.toFixed(2) : ''}"
                oninput="Proveedores._calcPagoEquiv()"
                style="width:100%;font-size:14px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
          </div>

          <div id="pago-equiv-row" style="display:none;background:var(--bg-secondary);border-radius:8px;padding:8px 12px;font-size:13px;color:var(--text-secondary)">
            Equivalente: <span id="pago-equiv-val" style="font-weight:700;color:var(--text)">—</span>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">DESDE (persona)</label>
              <select id="pago-persona" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                ${personas.map(p => `<option>${p}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">BOLSILLO</label>
              <select id="pago-bolsillo" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                <option>USDT</option>
              </select>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">FECHA</label>
              <input id="pago-fecha" type="date" value="${new Date().toISOString().slice(0, 10)}" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">NOTAS</label>
              <input id="pago-notas" type="text" placeholder="Opcional..." style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('prov-pago-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Proveedores._confirmarPago(${loteId})">💸 Registrar pago</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    // Inicializar bolsillos según moneda default
    this._onPagoMonedaChange();
  },

  _onPagoMonedaChange() {
    const moneda = document.getElementById('pago-moneda')?.value || 'USDT';
    const bolsilloSel = document.getElementById('pago-bolsillo');
    const equivRow = document.getElementById('pago-equiv-row');
    if (!bolsilloSel) return;
    const BOLSILLOS = {
      USDT: ['USDT'],
      USD: ['USD cash', 'USD transferencia'],
      ARS: ['ARS cash', 'ARS transferencia'],
    };
    bolsilloSel.innerHTML = (BOLSILLOS[moneda] || ['USDT']).map(b => `<option>${b}</option>`).join('');
    if (equivRow) equivRow.style.display = moneda === 'ARS' ? 'block' : 'none';
    this._calcPagoEquiv();
  },

  _calcPagoEquiv() {
    const moneda = document.getElementById('pago-moneda')?.value || 'USDT';
    const monto = parseFloat(document.getElementById('pago-monto')?.value) || 0;
    const equivRow = document.getElementById('pago-equiv-row');
    const equivVal = document.getElementById('pago-equiv-val');
    if (!equivRow || !equivVal) return;
    if (moneda === 'ARS' && monto > 0) {
      const usd = monto / (State.refBlue || 1);
      equivVal.textContent = `≈ USD ${usd.toFixed(2)} al blue actual`;
      equivRow.style.display = 'block';
    } else {
      equivRow.style.display = 'none';
    }
  },

  async _confirmarPago(loteId) {
    const moneda = document.getElementById('pago-moneda')?.value || 'USDT';
    const monto = parseFloat(document.getElementById('pago-monto')?.value) || 0;
    const persona = document.getElementById('pago-persona')?.value;
    const bolsillo = document.getElementById('pago-bolsillo')?.value;
    const fecha = document.getElementById('pago-fecha')?.value;
    const notas = document.getElementById('pago-notas')?.value.trim();
    if (!monto || monto <= 0) { toast('Ingresá un monto válido'); return; }

    // Calcular equivalente en USD para el costo del lote
    let montoUsd = monto;
    if (moneda === 'ARS') montoUsd = monto / (State.refBlue || 1);

    await State.debitarCaja(persona, bolsillo, monto,
      { tipo: 'proveedor', referencia: loteId, descripcion: `Pago a proveedor del lote ${loteId}` });
    await DB.guardarLotePago(loteId, {
      tipo: 'pago_proveedor', montoUsd, montoUsdt: moneda === 'USDT' ? monto : montoUsd,
      moneda, persona, bolsillo, personaDest: '', bolsilloDestino: '', fecha, notas
    });
    await DB.actualizarEstadoLote(loteId, 'pagado');

    document.getElementById('prov-pago-overlay')?.remove();
    toast('✅ Pago al proveedor registrado');
    this.renderKpis();
    this.renderContent();
  },

  // ── MODAL ENVÍO ──────────────────────────────────────────────────

  modalCostoAdicional(loteId) {
    const personas = State.personas || [];
    const BOLSILLOS = ['ARS cash', 'ARS transferencia', 'USD cash', 'USD transferencia', 'USDT'];
    const overlay = document.createElement('div');
    overlay.id = 'prov-costo-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(420px,96vw);overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:15px;font-weight:700">💰 Agregar costo adicional</div>
          <button onclick="document.getElementById('prov-costo-overlay').remove()" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:18px">✕</button>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
          <div style="background:var(--blue-light);border-radius:8px;padding:10px;font-size:12px;color:var(--blue)">
            Los costos adicionales se prorratean entre todas las unidades del lote para calcular el costo real por dispositivo.
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Tipo de costo</label>
            <select id="costo-tipo-sel" onchange="Proveedores._toggleCostoTipo()" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
              <option value="costo">Costo general (envío, aduana, flete…)</option>
              <option value="diferencial">Diferencial de tipo de cambio ARS→USDT</option>
            </select>
          </div>
          <div id="costo-tipo-general">
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Descripción *</label>
            <input id="costo-desc" type="text" placeholder="Ej: Envío USA, Envío nacional, Aduana, Flete..." style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Monto *</label>
              <input id="costo-monto" type="number" min="0" step="0.01" placeholder="0" style="width:100%;font-size:14px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Moneda</label>
              <select id="costo-moneda" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                <option>USD</option><option>ARS</option><option>USDT</option>
              </select>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Pagado por (opcional)</label>
              <select id="costo-persona" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                <option value="">Sin registrar en caja</option>
                ${personas.map(p => `<option>${p}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Bolsillo</label>
              <select id="costo-bolsillo" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                ${BOLSILLOS.map(b => `<option>${b}</option>`).join('')}
              </select>
            </div>
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Fecha</label>
            <input id="costo-fecha" type="date" value="${new Date().toISOString().slice(0, 10)}" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          </div><!-- fin costo-tipo-general -->
          <div id="costo-tipo-diferencial" style="display:none;flex-direction:column;gap:10px">
            <div style="background:var(--amber-light,#fff8e1);border-radius:8px;padding:10px;font-size:12px;color:var(--amber)">
              Ingresá los datos de la compra de USDT. El diferencial (cotiz compra − cotiz venta) × USDT se agrega al costo del lote y se prorratea por unidad.
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">USDT comprados</label>
                <input id="dif-usdt" type="number" min="0" step="0.01" placeholder="0" oninput="Proveedores._calcDiferencial()" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
              </div>
              <div>
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Cotiz. compra (ARS/USDT)</label>
                <input id="dif-cotiz-compra" type="number" min="0" step="0.1" placeholder="${State.refBlue}" oninput="Proveedores._calcDiferencial()" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Cotiz. referencia (venta)</label>
                <input id="dif-cotiz-ref" type="number" min="0" step="0.1" placeholder="${State.refBlue}" oninput="Proveedores._calcDiferencial()" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
              </div>
              <div style="display:flex;align-items:flex-end;padding-bottom:2px">
                <div id="dif-preview" style="font-size:13px;font-weight:600;color:var(--red)"></div>
              </div>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Fecha</label>
              <input id="dif-fecha" type="date" value="${new Date().toISOString().slice(0, 10)}" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('prov-costo-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Proveedores._confirmarCosto(${loteId})">💰 Registrar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  },

  _toggleCostoTipo() {
    const tipo = document.getElementById('costo-tipo-sel')?.value;
    document.getElementById('costo-tipo-general').style.display = tipo === 'costo' ? 'flex' : 'none';
    document.getElementById('costo-tipo-general').style.flexDirection = 'column';
    document.getElementById('costo-tipo-diferencial').style.display = tipo === 'diferencial' ? 'flex' : 'none';
  },

  _calcDiferencial() {
    const usdt = parseFloat(document.getElementById('dif-usdt')?.value) || 0;
    const compra = parseFloat(document.getElementById('dif-cotiz-compra')?.value) || 0;
    const ref = parseFloat(document.getElementById('dif-cotiz-ref')?.value) || 0;
    const preview = document.getElementById('dif-preview');
    if (!preview) return;
    if (usdt > 0 && compra > 0 && ref > 0) {
      const diferencialARS = (compra - ref) * usdt;
      const diferencialUSD = diferencialARS / ref;
      preview.textContent = `${diferencialARS >= 0 ? '+' : ''}${State.fmtARS(diferencialARS)} (${diferencialUSD >= 0 ? '+' : ''}${State.fmtUSD(diferencialUSD)})`;
      preview.style.color = diferencialARS >= 0 ? 'var(--red)' : 'var(--green)';
    } else {
      preview.textContent = '';
    }
  },

  async _confirmarCosto(loteId) {
    const tipoSel = document.getElementById('costo-tipo-sel')?.value || 'costo';

    if (tipoSel === 'diferencial') {
      const usdt = parseFloat(document.getElementById('dif-usdt')?.value) || 0;
      const cotizCompra = parseFloat(document.getElementById('dif-cotiz-compra')?.value) || 0;
      const cotizRef = parseFloat(document.getElementById('dif-cotiz-ref')?.value) || 0;
      const fecha = document.getElementById('dif-fecha')?.value;
      if (!usdt || !cotizCompra || !cotizRef) { toast('Completá todos los campos del diferencial', 'error'); return; }
      const diferencialARS = (cotizCompra - cotizRef) * usdt;
      const montoUsd = diferencialARS / cotizRef;
      await DB.guardarLotePago(loteId, {
        tipo: 'diferencial', montoUsd, montoUsdt: 0, comisionPct: 0, comisionUsd: 0,
        moneda: 'USD', persona: '', bolsillo: '', personaDest: '', bolsilloDestino: '', fecha,
        notas: `Dif. cambio: ${usdt} USDT × (${cotizCompra} - ${cotizRef}) ARS/USDT`
      });
      document.getElementById('prov-costo-overlay')?.remove();
      toast('Diferencial de cambio registrado');
      this.renderKpis();
      this.renderContent();
      return;
    }

    const desc = document.getElementById('costo-desc')?.value.trim();
    const monto = parseFloat(document.getElementById('costo-monto')?.value) || 0;
    const moneda = document.getElementById('costo-moneda')?.value;
    const persona = document.getElementById('costo-persona')?.value;
    const bolsillo = document.getElementById('costo-bolsillo')?.value;
    const fecha = document.getElementById('costo-fecha')?.value;
    if (!desc) { toast('Ingresá una descripción', 'error'); return; }
    if (!monto || monto <= 0) { toast('Ingresá un monto válido', 'error'); return; }

    const montoUsd = moneda === 'ARS' ? monto / (State.refBlue || 1) : moneda === 'USDT' ? monto : monto;

    if (persona) {
      // Convertir monto a la moneda nativa del bolsillo para deducir correctamente
      const esARS = bolsillo.startsWith('ARS');
      const esUSDT = bolsillo === 'USDT';
      let montoParaCaja;
      if (esARS)       montoParaCaja = moneda === 'ARS' ? monto : montoUsd * (State.refBlue || 1);
      else if (esUSDT) montoParaCaja = moneda === 'USDT' ? monto : montoUsd;
      else             montoParaCaja = montoUsd; // bolsillo USD
      await State.debitarCaja(persona, bolsillo, montoParaCaja,
        { tipo: 'proveedor', referencia: loteId, descripcion: `Costo del lote: ${desc}` });
    }

    await DB.guardarLotePago(loteId, {
      tipo: 'costo', montoUsd, montoUsdt: 0, comisionPct: 0, comisionUsd: 0,
      moneda, persona: persona || '', bolsillo: persona ? bolsillo : '', personaDest: '', bolsilloDestino: '', fecha, notas: desc
    });

    document.getElementById('prov-costo-overlay')?.remove();
    toast('Costo registrado');
    this.renderKpis();
    this.renderContent();
  },

  async eliminarCosto(loteId, pagoId) {
    if (!confirm('¿Eliminar este costo?')) return;
    await DB.eliminarLotePago(pagoId);
    toast('Costo eliminado');
    this.renderContent();
  },

  editarLogistica(itemId, logAuto) {
    const nuevo = prompt(`Logística por unidad (USD)\nAuto-prorrateado: ${logAuto.toFixed(2)}\n\nIngresá el valor manual o dejá vacío para restaurar auto:`, logAuto.toFixed(2));
    if (nuevo === null) return; // canceló
    const val = nuevo.trim() === '' ? null : parseFloat(nuevo.replace(',', '.'));
    if (nuevo.trim() !== '' && (isNaN(val) || val < 0)) { toast('Valor inválido', 'error'); return; }
    DB.actualizarLogisticaItem(itemId, val).then(() => {
      this.renderContent();
    });
  },
  resetLogistica(itemId) {
    DB.actualizarLogisticaItem(itemId, null).then(() => { this.renderContent(); });
  },

  modalUnidades(itemId) {
    const item = (State.loteItems || []).find(i => i.id === itemId);
    if (!item) return;
    const unids = Array.isArray(item.unidades) ? item.unidades : [];
    const esSerie = ['cargador','cable','accesorio'].includes(item.cat);
    const label1 = esSerie ? 'N° de serie' : 'IMEI';
    const esc = v => State.esc(v);
    // Sugerencias del mismo catálogo que usa Stock (lista oficial + lo que ya
    // exista en el inventario). Se pueden escribir igual: lo que se cargue acá
    // entra al stock y desde ahí aparece solo en los filtros.
    const specs = window.Stock?.specsParaModelo(item.modelo || item.nombre || '') || { s: [], c: [] };
    const opts = arr => (arr || []).map(v => `<option value="${esc(v)}"></option>`).join('');
    const listas = `
      <datalist id="ud-lista-colores">${opts(specs.c)}</datalist>
      <datalist id="ud-lista-storages">${opts(specs.s)}</datalist>`;
    const inputEst = 'width:100%;font-size:12px;padding:6px 8px;background:var(--bg);border:1px solid var(--border-strong);border-radius:6px;color:var(--text)';
    const rows = listas + Array.from({ length: item.cantidad }, (_, k) => {
      const u = unids[k] || {};
      return `<div style="background:var(--bg-secondary);border-radius:8px;padding:10px;margin-bottom:8px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;align-items:end">
        <div style="grid-column:1/-1;font-size:11px;font-weight:700;color:var(--text-secondary)">Unidad ${k+1}</div>
        <div style="grid-column:1/-1">
          <label style="font-size:10px;color:var(--text-secondary);display:block;margin-bottom:3px">${label1}</label>
          <input class="ud-imei" data-idx="${k}" type="text" value="${esc(u.imei||'')}" placeholder="${label1}…" style="${inputEst};font-family:monospace">
        </div>
        <div>
          <label style="font-size:10px;color:var(--text-secondary);display:block;margin-bottom:3px">Color</label>
          <input class="ud-color" list="ud-lista-colores" data-idx="${k}" type="text" value="${esc(u.color||item.color||'')}" placeholder="Color…" style="${inputEst}">
        </div>
        <div>
          <label style="font-size:10px;color:var(--text-secondary);display:block;margin-bottom:3px">Almacenamiento</label>
          <input class="ud-storage" list="ud-lista-storages" data-idx="${k}" type="text" value="${esc(u.storage||item.storage||'')}" placeholder="128GB…" style="${inputEst}">
        </div>
        <div>
          <label style="font-size:10px;color:var(--text-secondary);display:block;margin-bottom:3px">Batería %</label>
          <input class="ud-bateria" data-idx="${k}" type="number" min="0" max="100" value="${u.bateriaPct ?? ''}" placeholder="—" style="${inputEst}">
        </div>
      </div>`;
    }).join('');

    const overlay = document.createElement('div');
    overlay.id = 'prov-unid-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(560px,96vw);max-height:90dvh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
          <div style="font-size:15px;font-weight:700">📋 Datos por unidad — ${State.esc(item.nombre)}${item.storage?' '+State.esc(item.storage):''}${item.color?' · '+State.esc(item.color):''}</div>
          <button onclick="document.getElementById('prov-unid-overlay').remove()" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:18px">✕</button>
        </div>
        <div id="prov-unid-body" style="padding:14px 18px;overflow-y:auto;flex:1">${rows}</div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;flex-shrink:0">
          <button class="btn" onclick="document.getElementById('prov-unid-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Proveedores._guardarUnidades(${itemId})">💾 Guardar datos</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
  },

  async _guardarUnidades(itemId) {
    const imeis = [...document.querySelectorAll('.ud-imei')];
    const colors = [...document.querySelectorAll('.ud-color')];
    const storages = [...document.querySelectorAll('.ud-storage')];
    const baterias = [...document.querySelectorAll('.ud-bateria')];
    const unidades = imeis.map((el, k) => ({
      imei: el.value.trim(),
      color: colors[k]?.value.trim() || '',
      storage: storages[k]?.value.trim() || '',
      bateriaPct: baterias[k]?.value ? parseInt(baterias[k].value, 10) : null,
    }));
    await DB.actualizarUnidadesItem(itemId, unidades);
    document.getElementById('prov-unid-overlay')?.remove();
    toast('Datos guardados', 'success');
    this.renderContent();
  },

  // Mantener alias para compatibilidad
  modalEnvio(loteId) { this.modalCostoAdicional(loteId); },

  // ── MODAL RECEPCIÓN ──────────────────────────────────────────────

  modalRecepcion(loteId) {
    const l = (State.lotesCompra || []).find(x => x.id === loteId);
    const items = (State.loteItems || []).filter(i => i.loteId === loteId);
    const pagos = (State.lotePagos || []).filter(p => p.loteId === loteId);
    const totalItems = items.reduce((s, i) => s + i.precioUsd * i.cantidad, 0);
    const totalUds = items.reduce((s, i) => s + i.cantidad, 0);
    const comision = pagos.find(p => p.tipo === 'conversion')?.comisionUsd || 0;
    const envio = pagos.filter(p => ['envio','costo','diferencial'].includes(p.tipo)).reduce((s, p) => s + p.montoUsd, 0);
    const logistica = comision + envio;
    const logPorUnidad = totalUds > 0 ? logistica / totalUds : 0;

    const overlay = document.createElement('div');
    overlay.id = 'prov-recep-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(520px,96vw);max-height:90dvh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
          <div style="font-size:15px;font-weight:700">📦 Confirmar recepción</div>
          <button onclick="document.getElementById('prov-recep-overlay').remove()" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:18px">✕</button>
        </div>
        <div style="padding:18px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:12px">
          <div style="background:var(--blue-light);border-radius:8px;padding:10px;font-size:12px;color:var(--blue)">
            Logística prorrateada: <b>${State.fmtUSD(logistica)}</b> ÷ ${totalUds} uds = <b>${State.fmtUSD(logPorUnidad)}/u</b>
            <div style="font-size:10px;margin-top:3px;opacity:.8">comisión ${State.fmtUSD(comision)} + costos adicionales ${State.fmtUSD(envio)}</div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Fecha de recepción</label>
              <input id="recep-fecha" type="date" value="${new Date().toISOString().slice(0, 10)}" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Depósito (custodio)</label>
              <select id="recep-custodio" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                <option value="">Sin asignar</option>
                ${(State.personas || []).map(p => `<option>${p}</option>`).join('')}
              </select>
            </div>
          </div>
          <div style="font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.04em">Costo final por producto:</div>
          ${items.map(i => {
            const logUsada = i.logisticaManual != null ? i.logisticaManual : logPorUnidad;
            const costoFinalU = i.precioUsd + logUsada;
            const esManual = i.logisticaManual != null;
            return `<div style="background:var(--bg-secondary);border-radius:8px;padding:10px;font-size:12px;display:flex;justify-content:space-between;align-items:center">
              <div>
                <div style="font-weight:600">${i.nombre}${i.storage ? ` ${i.storage}` : ''}${i.color ? ` · ${i.color}` : ''} × ${i.cantidad} uds</div>
                <div style="color:var(--text-secondary);margin-top:2px;font-size:11px">${State.fmtUSD(i.precioUsd)} producto + <span style="color:${esManual?'var(--blue)':'inherit'}">${State.fmtUSD(logUsada)} logística${esManual?' ✎':''}</span></div>
              </div>
              <b style="color:var(--blue);font-size:13px">${State.fmtUSD(costoFinalU)}/u</b>
            </div>`;
          }).join('')}
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;flex-shrink:0">
          <button class="btn" onclick="document.getElementById('prov-recep-overlay').remove()">Cancelar</button>
          <button class="btn btn-green" onclick="Proveedores._confirmarRecepcion(${loteId})">📦 Confirmar e ingresar al stock</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  },

  async _confirmarRecepcion(loteId) {
    const btn = document.querySelector('#prov-recep-overlay .btn-green');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Procesando…'; }
    try { await this.__confirmarRecepcionInterno(loteId); }
    catch(e) { toast('Error al confirmar: ' + e.message, 'error'); console.error(e); if (btn) { btn.disabled = false; btn.innerHTML = '📦 Confirmar e ingresar al stock'; } }
  },

  async __confirmarRecepcionInterno(loteId) {
    const fecha = document.getElementById('recep-fecha')?.value || new Date().toISOString().slice(0, 10);
    const custodio = document.getElementById('recep-custodio')?.value || '';
    const items = (State.loteItems || []).filter(i => i.loteId === loteId);
    const l = (State.lotesCompra || []).find(x => x.id === loteId);
    const prov = (State.proveedores || []).find(p => p.id === l?.proveedorId);
    const pagos = (State.lotePagos || []).filter(p => p.loteId === loteId);
    const comision = pagos.find(p => p.tipo === 'conversion')?.comisionUsd || 0;
    const envio = pagos.filter(p => ['envio','costo','diferencial'].includes(p.tipo)).reduce((s, p) => s + p.montoUsd, 0);
    const totalUds = items.reduce((s, i) => s + i.cantidad, 0);
    const logPorUnidad = totalUds > 0 ? (comision + envio) / totalUds : 0;

    let errores = 0;
    const CATS_IMEI = ['iphone','android','mac','ipad'];
    for (const item of items) {
      const logUsada = item.logisticaManual != null ? item.logisticaManual : logPorUnidad;
      const costoFinalU = item.precioUsd + logUsada;
      const unidades = Array.isArray(item.unidades) ? item.unidades : [];
      const notasBase = `Lote #${loteId}${l?.nombre ? ' — ' + l.nombre : ''}`;
      const esIMEI = CATS_IMEI.includes(item.cat || 'iphone');

      // Si hay datos por unidad, crear una entrada de stock por unidad
      if (unidades.length > 0) {
        for (let k = 0; k < item.cantidad; k++) {
          const ud = unidades[k] || {};
          const colorU = ud.color || item.color || '';
          const storageU = ud.storage || item.storage || '';
          // En perfumería, repuestos y accesorios el nombre ya viene completo:
          // pegarle el "storage" y el "color" produciría cosas como
          // "Club de nuit intense man EDP 100ml EDP Árabe".
          const nombreU = this.esNombreLibre(item.cat || 'iphone')
            ? item.nombre
            : [item.nombre, storageU, colorU].filter(Boolean).join(' ');
          const obj = {
            cat: item.cat || 'iphone',
            nombre: nombreU,
            costoUSD: costoFinalU,
            precioARS: Math.round(costoFinalU * (State.refBlue || 1)),
            cantidad: 1,
            imeis: ud.imei ? [ud.imei] : [],
            cotiz: State.refBlue,
            proveedor: prov?.nombre || '',
            custodio,
            notas: notasBase,
            estadoInventario: 'disponible',
            grado: item.grado || 'Sin grado',
            modelo: this.esNombreLibre(item.cat || 'iphone') ? (item.modelo || '') : (item.modelo || item.nombre),
            storage: storageU,
            color: colorU,
            bateriaPct: ud.bateriaPct ?? null,
            // El estado sale de lo que se cargó en la orden: no todo lo que se le
            // compra a un proveedor entra nuevo/sellado.
            estadoProducto: item.estadoProducto || 'Nuevo / Sellado',
          };
          const { id: newId, error } = await DB.guardarProductoStock(obj, null);
          if (error || !newId) { errores++; } else {
            State.stock.push({ id: newId, cat: obj.cat, nombre: obj.nombre, modelo: obj.modelo,
              storage: obj.storage, color: obj.color, costoUSD: obj.costoUSD, precioARS: obj.precioARS,
              cotiz: obj.cotiz, proveedor: obj.proveedor, custodio, notas: obj.notas,
              estadoInventario: 'disponible', grado: obj.grado, estadoProducto: obj.estadoProducto,
              cantidad: 1, cantidadDeclarada: 1, imeis: esIMEI ? (ud.imei ? [ud.imei] : []) : undefined,
              bateriaPct: ud.bateriaPct ?? null, ciclosBateria: null });
            // Registrar el alta deja el ingreso del lote en el historial de stock,
            // igual que cuando se carga un producto a mano.
            await DB.registrarMovimientoStock(newId, 'alta',
              `Alta por recepción de ${notasBase}${ud.imei ? ` — IMEI ${ud.imei}` : ''}`, 0, 1);
          }
        }
      } else {
        // Sin datos por unidad: entrada grupal como antes
        const nombre = this.esNombreLibre(item.cat || 'iphone')
          ? item.nombre
          : [item.nombre, item.storage, item.color].filter(Boolean).join(' ');
        const obj = {
          cat: item.cat || 'iphone',
          nombre,
          costoUSD: costoFinalU,
          precioARS: Math.round(costoFinalU * (State.refBlue || 1)),
          cantidad: Number(item.cantidad) || 1,
          imeis: [],
          cotiz: State.refBlue,
          proveedor: prov?.nombre || '',
          custodio,
          notas: notasBase,
          estadoInventario: 'disponible',
          grado: item.grado || 'Sin grado',
          modelo: this.esNombreLibre(item.cat || 'iphone')
            ? (item.modelo || '')
            : (window.Stock?._normalizarModelo(item.modelo || item.nombre) || item.modelo || item.nombre),
          storage: item.storage || '',
          color: item.color || '',
          bateriaPct: null,
          estadoProducto: item.estadoProducto || 'Nuevo / Sellado',
        };
        const { id: newId, error } = await DB.guardarProductoStock(obj, null);
        if (error || !newId) { errores++; } else {
          State.stock.push({ id: newId, cat: obj.cat, nombre: obj.nombre, modelo: obj.modelo,
            storage: obj.storage, color: obj.color, costoUSD: obj.costoUSD, precioARS: obj.precioARS,
            cotiz: obj.cotiz, proveedor: obj.proveedor, custodio, notas: obj.notas,
            estadoInventario: 'disponible', grado: obj.grado, estadoProducto: obj.estadoProducto,
            cantidad: obj.cantidad, cantidadDeclarada: obj.cantidad,
            imeis: esIMEI ? [] : undefined, bateriaPct: null, ciclosBateria: null });
          await DB.registrarMovimientoStock(newId, 'alta',
            `Alta por recepción de ${notasBase} (${obj.cantidad} unidad/es)`, 0, obj.cantidad);
        }
      }
    }

    await DB.actualizarEstadoLote(loteId, 'recibido', fecha);
    document.getElementById('prov-recep-overlay')?.remove();
    if (errores > 0) {
      toast(`⚠️ ${errores} item(s) no se pudieron agregar al stock. Revisá el historial.`, 'error');
    } else {
      toast('Lote recibido e ingresado al inventario ✅', 'success');
    }
    this.renderKpis();
    this.renderContent();
  },

  async _revertirPagosCaja(loteId) {
    const pagos = (State.lotePagos || []).filter(p => p.loteId === loteId);
    for (const pg of pagos) {
      // Todo por el motor central, para que el reverso quede en el libro.
      const ref = { tipo: 'proveedor', referencia: loteId };
      if (pg.tipo === 'conversion') {
        // Devolver USD al origen, quitar USDT al destino
        if (pg.persona && pg.bolsillo) {
          await State.acreditarCaja(pg.persona, pg.bolsillo, pg.montoUsd,
            { ...ref, descripcion: 'Se revirtió una conversión a USDT' });
        }
        if (pg.personaDest && pg.bolsilloDestino) {
          await State.debitarCaja(pg.personaDest, pg.bolsilloDestino, pg.montoUsdt,
            { ...ref, descripcion: 'Se revirtió una conversión a USDT' });
        }
      } else if (['pago_proveedor', 'costo', 'envio'].includes(pg.tipo) && pg.persona && pg.bolsillo) {
        // Devolver el monto en la moneda original al bolsillo
        const montoOriginal = pg.moneda === 'ARS'
          ? pg.montoUsd * (State.refBlue || 1)
          : pg.moneda === 'USDT' ? pg.montoUsdt : pg.montoUsd;
        await State.acreditarCaja(pg.persona, pg.bolsillo, montoOriginal,
          { ...ref, descripcion: 'Se revirtió un pago del lote' });
      }
      // credito_aplicado no toca cajas — se restaura aparte más abajo.
    }

    // Restaurar el saldo a favor que se haya usado en este lote: al cancelar
    // o eliminar la orden, ese crédito con el proveedor vuelve a estar
    // disponible para otra compra (el saldo generado por sobrepago, en
    // cambio, NO se toca acá: esa plata de verdad salió de la caja).
    const creditosAplicados = (State.proveedorCreditos || []).filter(c => c.loteId === loteId && c.tipo === 'aplicado');
    for (const c of creditosAplicados) {
      await DB.eliminarProveedorCredito(c.id);
    }
  },

  modalEditarItems(loteId) {
    const l = (State.lotesCompra || []).find(x => x.id === loteId);
    const items = (State.loteItems || []).filter(i => i.loteId === loteId);
    const overlay = document.createElement('div');
    overlay.id = 'prov-edit-items-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:800;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(560px,96vw);max-height:90dvh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
          <div style="font-size:16px;font-weight:700">✏️ Editar ítems — ${l?.nombre || 'Orden'}</div>
          <button onclick="document.getElementById('prov-edit-items-overlay').remove()" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:20px">✕</button>
        </div>
        <div style="padding:16px 20px;overflow-y:auto;flex:1">
          <p style="font-size:12px;color:var(--text-secondary);margin-bottom:14px">Modificá cantidad o precio por unidad. Si un equipo no pudo conseguirse, poné cantidad 0 o eliminá el ítem. Los pagos ya registrados <b>no se modifican automáticamente</b> — ajustá la caja manualmente si corresponde.</p>
          <table style="width:100%;font-size:13px">
            <thead><tr style="border-bottom:1px solid var(--border)">
              <th style="text-align:left;padding:6px 4px;color:var(--text-secondary);font-weight:600">Producto</th>
              <th style="text-align:center;padding:6px 4px;color:var(--text-secondary);font-weight:600">Cant.</th>
              <th style="text-align:center;padding:6px 4px;color:var(--text-secondary);font-weight:600">Precio/u (USD)</th>
              <th style="text-align:right;padding:6px 4px;color:var(--text-secondary);font-weight:600">Subtotal</th>
              <th></th>
            </tr></thead>
            <tbody id="edit-items-tbody">
              ${items.map(i => `
                <tr id="edit-item-row-${i.id}" style="border-bottom:1px solid var(--border)">
                  <td style="padding:8px 4px">${i.nombre}${i.storage ? ' ' + i.storage : ''}${i.color ? ' · ' + i.color : ''}</td>
                  <td style="padding:8px 4px;text-align:center">
                    <input type="number" min="0" step="1" value="${i.cantidad}" id="edit-cant-${i.id}" oninput="Proveedores._editItemPreview('${i.id}')" style="width:60px;text-align:center;font-size:12px;padding:4px 6px;border:1px solid var(--border-strong);border-radius:6px">
                  </td>
                  <td style="padding:8px 4px;text-align:center">
                    <input type="number" min="0" step="0.01" value="${i.precioUsd}" id="edit-precio-${i.id}" oninput="Proveedores._editItemPreview('${i.id}')" style="width:90px;text-align:center;font-size:12px;padding:4px 6px;border:1px solid var(--border-strong);border-radius:6px">
                  </td>
                  <td style="padding:8px 4px;text-align:right;font-weight:600" id="edit-sub-${i.id}">${State.fmtUSD(i.precioUsd * i.cantidad)}</td>
                  <td style="padding:8px 4px;text-align:right">
                    <button onclick="Proveedores._confirmarEliminarItem(${loteId}, '${i.id}')" style="background:none;border:none;cursor:pointer;color:var(--red);font-size:15px" title="Eliminar ítem">🗑️</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
          <div style="text-align:right;font-size:13px;margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
            Nuevo total: <b id="edit-items-total" style="color:var(--blue)">${State.fmtUSD(items.reduce((s,i) => s + i.precioUsd * i.cantidad, 0))}</b>
          </div>
        </div>
        <div style="padding:14px 20px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;flex-shrink:0">
          <button class="btn" onclick="document.getElementById('prov-edit-items-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Proveedores.guardarEdicionItems(${loteId})">✓ Guardar cambios</button>
        </div>
      </div>`;
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
  },

  _editItemPreview(itemId) {
    const cant = parseFloat(document.getElementById(`edit-cant-${itemId}`)?.value) || 0;
    const precio = parseFloat(document.getElementById(`edit-precio-${itemId}`)?.value) || 0;
    const sub = document.getElementById(`edit-sub-${itemId}`);
    if (sub) sub.textContent = State.fmtUSD(cant * precio);
    // Recalcular total
    const items = (State.loteItems || []).filter(i => i.loteId === (State.loteItems.find(x => x.id == itemId)?.loteId));
    let total = 0;
    items.forEach(i => {
      const c = parseFloat(document.getElementById(`edit-cant-${i.id}`)?.value) || 0;
      const p = parseFloat(document.getElementById(`edit-precio-${i.id}`)?.value) || 0;
      total += c * p;
    });
    const el = document.getElementById('edit-items-total');
    if (el) el.textContent = State.fmtUSD(total);
  },

  async _confirmarEliminarItem(loteId, itemId) {
    const item = State.loteItems.find(i => i.id == itemId);
    if (!item) return;
    if (!confirm(`¿Eliminar "${item.nombre}" del lote? Esto reduce el total de la orden.`)) return;
    const ok = await DB.eliminarLoteItem(itemId);
    if (ok) {
      document.getElementById(`edit-item-row-${itemId}`)?.remove();
      this._editItemPreview(itemId);
      toast('Ítem eliminado del lote.');
      // Refrescar total
      const items = (State.loteItems || []).filter(i => i.loteId === loteId);
      const el = document.getElementById('edit-items-total');
      if (el) el.textContent = State.fmtUSD(items.reduce((s, i) => s + i.precioUsd * i.cantidad, 0));
    }
  },

  async guardarEdicionItems(loteId) {
    const items = (State.loteItems || []).filter(i => i.loteId === loteId);
    const totalAntes = items.reduce((s, i) => s + i.precioUsd * i.cantidad, 0);

    let ok = true;
    for (const i of items) {
      const cant = parseFloat(document.getElementById(`edit-cant-${i.id}`)?.value);
      const precio = parseFloat(document.getElementById(`edit-precio-${i.id}`)?.value);
      if (isNaN(cant) || isNaN(precio)) continue;
      if (cant !== i.cantidad || precio !== i.precioUsd) {
        const res = await DB.actualizarLoteItem(i.id, cant, precio);
        if (!res) ok = false;
      }
    }

    // Calcular nuevo total con los valores guardados
    const totalDespues = (State.loteItems || []).filter(i => i.loteId === loteId)
      .reduce((s, i) => s + i.precioUsd * i.cantidad, 0);
    const diferencia = +(totalAntes - totalDespues).toFixed(2);

    document.getElementById('prov-edit-items-overlay')?.remove();

    if (diferencia > 0) {
      // Hay devolución — abrir modal para elegir caja destino
      this._modalDevolucion(loteId, diferencia);
    } else {
      if (ok) toast('Orden actualizada correctamente.');
      this.renderContent();
    }
  },

  _modalDevolucion(loteId, diferencia) {
    const personaOpts = State.personas.map(p => `<option value="${p}">${p}</option>`).join('');
    const bolsilloOpts = (p) => ['USD cash', 'USD transferencia', 'USDT', 'ARS cash', 'ARS transferencia']
      .map(b => `<option value="${b}">${b}</option>`).join('');

    const overlay = document.createElement('div');
    overlay.id = 'prov-devolucion-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:800;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(440px,96vw);display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:16px;font-weight:700">💰 Devolución del proveedor</div>
          <button onclick="document.getElementById('prov-devolucion-overlay').remove()" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:20px">✕</button>
        </div>
        <div style="padding:18px 20px">
          <div style="background:var(--green-light);color:var(--green);border-radius:8px;padding:10px 14px;font-size:13px;font-weight:600;margin-bottom:16px">
            El proveedor te devuelve <b>${State.fmtUSD(diferencia)}</b> por la diferencia en la orden.
          </div>
          <div style="margin-bottom:12px">
            <label style="font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:5px">¿A qué caja ingresa la devolución?</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <select id="dev-persona" onchange="document.getElementById('dev-bolsillo').innerHTML=Proveedores._bolsillosOpts(this.value)" style="font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                ${personaOpts}
              </select>
              <select id="dev-bolsillo" style="font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                ${bolsilloOpts(State.personas[0])}
              </select>
            </div>
          </div>
          <div style="margin-bottom:16px">
            <label style="font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:5px">Monto a acreditar (USD)</label>
            <input type="number" id="dev-monto" value="${diferencia}" step="0.01" style="width:100%;font-size:13px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:8px">
            <div style="font-size:10px;color:var(--text-secondary);margin-top:4px">Podés ajustar si la devolución fue parcial o en otra moneda.</div>
          </div>
          <div style="margin-bottom:4px">
            <label style="font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:5px">Notas (opcional)</label>
            <input type="text" id="dev-notas" placeholder="Ej: iPhone 17 Pro Max azul no disponible" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
          </div>
        </div>
        <div style="padding:14px 20px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('prov-devolucion-overlay').remove();Proveedores.renderContent()">Sin devolución</button>
          <button class="btn btn-primary" onclick="Proveedores.confirmarDevolucion(${loteId})">✓ Acreditar en caja</button>
        </div>
      </div>`;
    overlay.onclick = e => { if (e.target === overlay) { overlay.remove(); this.renderContent(); } };
    document.body.appendChild(overlay);
  },

  _bolsillosOpts(persona) {
    const cajas = State.cajas[persona] || {};
    const bolsillos = Object.keys(cajas).length
      ? Object.keys(cajas)
      : ['USD cash', 'USD transferencia', 'USDT', 'ARS cash', 'ARS transferencia'];
    return bolsillos.map(b => `<option value="${b}">${b}</option>`).join('');
  },

  async confirmarDevolucion(loteId) {
    const persona = document.getElementById('dev-persona')?.value;
    const bolsillo = document.getElementById('dev-bolsillo')?.value;
    const monto = parseFloat(document.getElementById('dev-monto')?.value) || 0;
    const notas = document.getElementById('dev-notas')?.value || '';
    if (!persona || !bolsillo || !monto) { toast('Completá todos los campos.'); return; }

    // Acreditar en la caja
    State.acreditarCaja(persona, bolsillo, monto, { tipo: 'proveedor', descripcion: 'Movimiento con proveedor' });

    // Registrar como movimiento en el lote (tipo 'devolucion')
    await DB.guardarLotePago(loteId, {
      tipo: 'devolucion', montoUsd: monto, moneda: 'USD',
      persona, bolsillo, notas: notas || 'Devolución parcial del proveedor', fecha: new Date().toISOString().slice(0,10)
    });

    document.getElementById('prov-devolucion-overlay')?.remove();
    toast(`${State.fmtUSD(monto)} acreditados en ${persona} — ${bolsillo}.`);
    this.renderContent();
  },

  async revertirMovimientoLote(loteId, pagoId) {
    const pg = (State.lotePagos || []).find(p => p.id === pagoId);
    if (!pg) return;

    const mensajes = {
      devolucion:       `¿Revertir la devolución de ${State.fmtUSD(pg.montoUsd)}?\nSe debitará de ${pg.persona} (${pg.bolsillo}) y se eliminará el registro.`,
      costo:            `¿Eliminar este costo adicional de ${State.fmtUSD(pg.montoUsd)}?\nSe acreditará en ${pg.persona} (${pg.bolsillo}).`,
      envio:            `¿Eliminar este costo de envío de ${State.fmtUSD(pg.montoUsd)}?\nSe acreditará en ${pg.persona} (${pg.bolsillo}).`,
      pago_proveedor:   `¿Revertir este pago al proveedor de ${State.fmtUSD(pg.montoUsd)}?\nSe acreditará en ${pg.persona} (${pg.bolsillo}).`,
      conversion:       `¿Revertir esta conversión? Se restaurarán los saldos de USD y USDT de ${pg.persona}.`,
      credito_aplicado: `¿Deshacer el uso de ${State.fmtUSD(pg.montoUsd)} de saldo a favor en este lote?\nEsa plata vuelve a estar disponible como crédito con el proveedor. No se mueve ninguna caja.`,
    };

    if (!confirm(mensajes[pg.tipo] || '¿Revertir este movimiento?')) return;

    // montoReal = monto en la moneda original que se movió en la caja
    const montoReal = (pg.moneda === 'USDT' && pg.montoUsdt) ? pg.montoUsdt : pg.montoUsd;

    if (pg.tipo === 'devolucion') {
      // La devolución acreditó la caja en USD → debitamos de vuelta
      if (pg.persona) State.debitarCaja(pg.persona, pg.bolsillo, montoReal, { tipo: 'proveedor', descripcion: 'Pago a proveedor' });
    } else if (pg.tipo === 'costo' || pg.tipo === 'envio') {
      // El costo debitó la caja en la moneda original → acreditamos de vuelta
      if (pg.persona) State.acreditarCaja(pg.persona, pg.bolsillo, montoReal, { tipo: 'proveedor', descripcion: 'Reverso de pago a proveedor' });
    } else if (pg.tipo === 'pago_proveedor') {
      // El pago debitó la caja en la moneda original → acreditamos de vuelta
      if (pg.persona) State.acreditarCaja(pg.persona, pg.bolsillo, montoReal, { tipo: 'proveedor', descripcion: 'Reverso de pago a proveedor' });
    } else if (pg.tipo === 'conversion') {
      // Devolver USD al origen, quitar USDT del destino
      if (pg.persona) await State.acreditarCaja(pg.persona, pg.bolsillo, pg.montoUsd, { tipo: 'proveedor', descripcion: 'Reverso de pago a proveedor' });
      if (pg.personaDest || pg.persona) await State.debitarCaja(pg.personaDest || pg.persona, pg.bolsilloDestino || 'USDT', pg.montoUsdt, { tipo: 'proveedor', descripcion: 'Reverso de pago a proveedor (USDT)' });
    } else if (pg.tipo === 'credito_aplicado') {
      // No hay caja que tocar: se elimina el consumo de crédito, así el
      // saldo a favor con el proveedor vuelve a subir en el mismo monto.
      const aplicado = (State.proveedorCreditos || [])
        .find(c => c.loteId === loteId && c.tipo === 'aplicado' && Math.abs(c.montoUsd - pg.montoUsd) < 0.01);
      if (aplicado) await DB.eliminarProveedorCredito(aplicado.id);
    }

    await DB.eliminarLotePago(pagoId);
    toast('Movimiento revertido y saldo restaurado.');
    this.renderContent();
  },

  // ── SALDO A FAVOR CON EL PROVEEDOR ────────────────────────────────

  // Convierte lo pagado de más en este lote en saldo a favor con el
  // proveedor. No mueve ninguna caja: la plata ya salió de verdad cuando se
  // registró el pago, esto solo evita que quede flotando sin registrar.
  async convertirExcedenteACredito(loteId) {
    const l = (State.lotesCompra || []).find(x => x.id === loteId);
    if (!l) return;
    const items = (State.loteItems || []).filter(i => i.loteId === loteId);
    const pagos = (State.lotePagos || []).filter(p => p.loteId === loteId);
    const conv = pagos.find(p => p.tipo === 'conversion');
    const totalItems = items.reduce((s, i) => s + i.precioUsd * i.cantidad, 0);
    const totalEnvio = pagos.filter(p => ['envio','costo','diferencial'].includes(p.tipo)).reduce((s, p) => s + p.montoUsd, 0);
    const costoTotal = totalItems + (conv?.comisionUsd || 0) + totalEnvio;
    const pagadoTotal = pagos.filter(p => ['pago_proveedor','credito_aplicado'].includes(p.tipo)).reduce((s, p) => s + p.montoUsd, 0);
    const creditoYaGenerado = (State.proveedorCreditos || []).filter(c => c.loteId === loteId && c.tipo === 'generado').reduce((s, c) => s + c.montoUsd, 0);
    const excedente = +Math.max(0, (pagadoTotal - costoTotal) - creditoYaGenerado).toFixed(2);
    if (excedente <= 0) { toast('No hay excedente sin convertir en este lote.'); return; }
    if (!confirm(`¿Guardar ${State.fmtUSD(excedente)} como saldo a favor con este proveedor? Vas a poder usarlo como pago en otra orden.`)) return;

    const ok = await DB.crearProveedorCredito({ proveedorId: l.proveedorId, tipo: 'generado', montoUsd: excedente, loteId, notas: `Excedente del lote #${loteId}` });
    if (!ok) { toast('No se pudo guardar el saldo a favor.'); return; }
    toast(`${State.fmtUSD(excedente)} guardados como saldo a favor.`);
    this.renderContent();
  },

  modalUsarCredito(loteId) {
    const l = (State.lotesCompra || []).find(x => x.id === loteId);
    if (!l) return;
    const disponible = this.saldoCredito(l.proveedorId);
    if (disponible <= 0) { toast('Este proveedor no tiene saldo a favor.'); return; }

    const items = (State.loteItems || []).filter(i => i.loteId === loteId);
    const pagos = (State.lotePagos || []).filter(p => p.loteId === loteId);
    const conv = pagos.find(p => p.tipo === 'conversion');
    const totalItems = items.reduce((s, i) => s + i.precioUsd * i.cantidad, 0);
    const totalEnvio = pagos.filter(p => ['envio','costo','diferencial'].includes(p.tipo)).reduce((s, p) => s + p.montoUsd, 0);
    const costoTotal = totalItems + (conv?.comisionUsd || 0) + totalEnvio;
    const yaAplicado = pagos.filter(p => ['pago_proveedor','credito_aplicado'].includes(p.tipo)).reduce((s, p) => s + p.montoUsd, 0);
    const restante = Math.max(0, costoTotal - yaAplicado);
    const sugerido = +Math.min(disponible, restante).toFixed(2);

    const overlay = document.createElement('div');
    overlay.id = 'prov-credito-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:800;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(400px,96vw);overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:15px;font-weight:700">💳 Usar saldo a favor</div>
          <button onclick="document.getElementById('prov-credito-overlay').remove()" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:18px">✕</button>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:10px">
          <div style="background:var(--green-light);color:var(--green);border-radius:8px;padding:9px 12px;font-size:12.5px">
            Disponible: <b>${State.fmtUSD(disponible)}</b>${restante > 0 ? ` · Resta pagar de este lote: <b>${State.fmtUSD(restante)}</b>` : ''}
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">MONTO A APLICAR (USD)</label>
            <input id="credito-monto" type="number" min="0" max="${Math.max(disponible, sugerido)}" step="0.01" value="${sugerido}"
              style="width:100%;font-size:14px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          <div style="font-size:10px;color:var(--text-secondary)">No mueve ninguna caja: solo descuenta del crédito con el proveedor.</div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('prov-credito-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Proveedores._confirmarUsarCredito(${loteId})">💳 Aplicar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  },

  async _confirmarUsarCredito(loteId) {
    const l = (State.lotesCompra || []).find(x => x.id === loteId);
    if (!l) return;
    const monto = +(parseFloat(document.getElementById('credito-monto')?.value) || 0).toFixed(2);
    const disponible = this.saldoCredito(l.proveedorId);
    if (!monto || monto <= 0) { toast('Ingresá un monto válido.'); return; }
    if (monto > disponible + 0.01) { toast(`Ese proveedor solo tiene ${State.fmtUSD(disponible)} de saldo a favor.`); return; }

    const credito = await DB.crearProveedorCredito({ proveedorId: l.proveedorId, tipo: 'aplicado', montoUsd: monto, loteId, notas: `Aplicado al lote #${loteId}` });
    if (!credito) { toast('No se pudo aplicar el saldo a favor.'); return; }
    await DB.guardarLotePago(loteId, {
      tipo: 'credito_aplicado', montoUsd: monto, montoUsdt: 0, moneda: 'USD',
      persona: '', bolsillo: '', notas: 'Saldo a favor aplicado', fecha: new Date().toISOString().slice(0, 10),
    });
    await DB.actualizarEstadoLote(loteId, 'pagado');

    document.getElementById('prov-credito-overlay')?.remove();
    toast(`${State.fmtUSD(monto)} de saldo a favor aplicados a este lote.`);
    this.renderKpis();
    this.renderContent();
  },

  // Ajuste manual del saldo a favor — para corregir un error o migrar un
  // saldo que hoy vive en otro lado (ej. una "caja" de proveedor creada como
  // persona, que hay que dejar de usar así).
  modalAjusteCredito(proveedorId) {
    const p = (State.proveedores || []).find(x => x.id === proveedorId);
    if (!p) return;
    const overlay = document.createElement('div');
    overlay.id = 'prov-ajuste-credito-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:800;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(420px,96vw);overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:15px;font-weight:700">✏️ Ajuste manual — ${p.nombre}</div>
          <button onclick="document.getElementById('prov-ajuste-credito-overlay').remove()" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:18px">✕</button>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
          <div style="font-size:12px;color:var(--text-secondary)">Saldo actual: <b style="color:var(--text)">${State.fmtUSD(this.saldoCredito(proveedorId))}</b></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">TIPO</label>
              <select id="ajc-tipo" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                <option value="generado">Sumar crédito</option>
                <option value="aplicado">Restar crédito</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">MONTO (USD)</label>
              <input id="ajc-monto" type="number" min="0" step="0.01" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">NOTAS</label>
            <input id="ajc-notas" type="text" placeholder="Ej: migración desde la caja de Tincho" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('prov-ajuste-credito-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Proveedores._confirmarAjusteCredito('${proveedorId}')">✓ Guardar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  },

  async _confirmarAjusteCredito(proveedorId) {
    const tipo = document.getElementById('ajc-tipo')?.value;
    const monto = parseFloat(document.getElementById('ajc-monto')?.value);
    const notas = document.getElementById('ajc-notas')?.value.trim();
    if (!monto || monto <= 0) { toast('Ingresá un monto válido.'); return; }

    const ok = await DB.crearProveedorCredito({ proveedorId, tipo, montoUsd: monto, loteId: null, notas: notas || 'Ajuste manual' });
    if (!ok) { toast('No se pudo guardar el ajuste.'); return; }
    document.getElementById('prov-ajuste-credito-overlay')?.remove();
    toast('Ajuste guardado.');
    this.renderContent();
  },

  async eliminarCreditoManual(creditoId) {
    const c = (State.proveedorCreditos || []).find(x => x.id === creditoId);
    if (!c || c.loteId) return; // solo se borran ajustes manuales; lo ligado a un lote se revierte desde el lote
    if (!confirm(`¿Quitar este ajuste de ${State.fmtUSD(c.montoUsd)}?`)) return;
    const ok = await DB.eliminarProveedorCredito(creditoId);
    if (ok) { toast('Ajuste eliminado.'); this.renderContent(); }
  },

  async cancelarLote(loteId) {
    if (!confirm('¿Cancelar esta orden? Se revertirán todos los movimientos de caja registrados.')) return;
    await this._revertirPagosCaja(loteId);
    await DB.actualizarEstadoLote(loteId, 'cancelado');
    toast('Orden cancelada y movimientos de caja revertidos');
    this.renderKpis();
    this.renderContent();
  },

  async eliminarLote(loteId) {
    if (!confirm('¿Eliminar esta orden definitivamente? Se revertirán los movimientos de caja. Esta acción no se puede deshacer.')) return;
    await this._revertirPagosCaja(loteId);
    const ok = await DB.eliminarLote(loteId);
    if (ok) {
      toast('Orden eliminada y movimientos de caja revertidos');
      this._loteId = null;
      this.renderKpis();
      this.renderContent();
    } else {
      toast('No se pudo eliminar la orden', 'error');
    }
  },

  async borrarProveedor(id) {
    const activos = (State.lotesCompra || []).filter(l => l.proveedorId === id && !['cancelado', 'recibido'].includes(l.estado));
    if (activos.length) { toast('Este proveedor tiene órdenes activas. Cancelalas o esperá la recepción primero.', 'error'); return; }
    if (!confirm('¿Eliminar este proveedor? Esta acción no se puede deshacer.')) return;
    await DB.borrarProveedorDB(id);
    toast('Proveedor eliminado', 'info');
    if (this._proveedorId === id) { this._view = 'list'; this._proveedorId = null; }
    this.renderKpis();
    this.renderContent();
  },
};

window.Proveedores = Proveedores;
