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

  _renderDetalleProveedor(host) {
    const p = (State.proveedores || []).find(x => x.id === this._proveedorId);
    if (!p) { this.back(); return; }
    const lotes = (State.lotesCompra || []).filter(l => l.proveedorId === p.id);
    const items = State.loteItems || [];
    const pagos = State.lotePagos || [];

    const totalGastado = lotes.flatMap(l => items.filter(i => i.loteId === l.id)).reduce((s, i) => s + i.precioUsd * i.cantidad, 0);
    const pendiente = lotes.filter(l => !['recibido', 'cancelado'].includes(l.estado)).reduce((s, l) => {
      const tot = items.filter(i => i.loteId === l.id).reduce((a, i) => a + i.precioUsd * i.cantidad, 0);
      const pag = pagos.filter(pg => pg.loteId === l.id && pg.tipo === 'pago_proveedor').reduce((a, pg) => a + pg.montoUsd, 0);
      return s + Math.max(0, tot - pag);
    }, 0);
    const enStock = (State.stock || []).filter(s => s.proveedor === p.nombre).length;

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
           ['Órdenes', lotes.length, '📋', 'var(--text)'],
           ['En stock', enStock, '📦', 'var(--text)'],
          ].map(([l, v, e, c]) => `<div class="card" style="padding:12px 14px;margin-bottom:0;min-width:120px;flex:1">
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">${l}</label>
            <div style="font-size:16px;font-weight:700;color:${c}">${e} ${v}</div>
          </div>`).join('')}
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
    const totalEnvio = pagos.filter(p => p.tipo === 'envio').reduce((s, p) => s + p.montoUsd, 0);
    const comisionUsd = conv?.comisionUsd || 0;
    const costoTotal = totalItems + comisionUsd + totalEnvio;
    const costoUnit = totalUds > 0 ? costoTotal / totalUds : 0;
    const isTerminal = ['recibido', 'cancelado'].includes(l.estado);

    const pagoIcons = { conversion: '💱', pago_proveedor: '💸', envio: '🚚' };
    const pagoLabels = { conversion: 'Conversión USD → USDT', pago_proveedor: 'Pago al proveedor', envio: 'Costo de envío' };

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
          <button class="btn btn-sm" onclick="Proveedores.modalEnvio(${l.id})">🚚 Agregar envío</button>
          ${pagadoProveedor > 0 && l.estado !== 'recibido' ? `<button class="btn btn-sm btn-green" onclick="Proveedores.modalRecepcion(${l.id})">📦 Confirmar recepción</button>` : ''}
        </div>` : ''}
      </div>

      <!-- Resumen financiero -->
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
        ${[['Subtotal items', State.fmtUSD(totalItems), '🛍️', 'var(--text)'],
           ['Comisión conv.', State.fmtUSD(comisionUsd), '💱', comisionUsd > 0 ? 'var(--amber)' : 'var(--text-secondary)'],
           ['Envío', State.fmtUSD(totalEnvio), '🚚', totalEnvio > 0 ? 'var(--text)' : 'var(--text-secondary)'],
           ['Costo total', State.fmtUSD(costoTotal), '💰', 'var(--blue)'],
           ['Costo / unidad', State.fmtUSD(costoUnit), '📊', 'var(--green)'],
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
            ${['Producto','Uds','Precio/u','Subtotal'].map((h,i) => `<th style="text-align:${i===0?'left':'right'};padding:5px 4px;color:var(--text-secondary);font-weight:600">${h}</th>`).join('')}
          </tr></thead>
          <tbody>
            ${items.map(i => `<tr style="border-bottom:1px solid var(--border)">
              <td style="padding:7px 4px">${i.nombre}${i.modelo&&i.modelo!==i.nombre?` · ${i.modelo}`:''}${i.storage ? ` ${i.storage}` : ''}${i.color ? ` · ${i.color}` : ''}</td>
              <td style="text-align:right;padding:7px 4px">${i.cantidad}</td>
              <td style="text-align:right;padding:7px 4px">${State.fmtUSD(i.precioUsd)}</td>
              <td style="text-align:right;padding:7px 4px;font-weight:600">${State.fmtUSD(i.precioUsd * i.cantidad)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
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
                : `${State.fmtUSD(pg.montoUsd)} ${pg.moneda} desde <b>${pg.persona}</b> (${pg.bolsillo})`;
              return `<div style="display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--border)">
                <div style="font-size:20px;flex-shrink:0;line-height:1;padding-top:2px">${pagoIcons[pg.tipo]}</div>
                <div style="flex:1">
                  <div style="font-size:12px;font-weight:600">${pagoLabels[pg.tipo]}</div>
                  <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${desc}</div>
                  <div style="font-size:10px;color:var(--text-tertiary);margin-top:2px">${pg.fecha}${pg.notas ? ' · ' + pg.notas : ''}</div>
                </div>
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
        ${w.items.map((item, idx) => `
          <div style="background:var(--bg-secondary);border-radius:8px;padding:10px;margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <div style="font-size:12px;font-weight:600">${item.nombre || `Item ${idx + 1}`}</div>
              <button onclick="Proveedores._quitarItem(${idx})" style="background:none;border:none;cursor:pointer;color:var(--red);font-size:14px">✕</button>
            </div>
            <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px">
              <div>
                <label style="font-size:10px;color:var(--text-secondary);display:block;margin-bottom:2px">Nombre / modelo *</label>
                <input type="text" value="${item.nombre}" oninput="Proveedores._editItem(${idx},'nombre',this.value)" style="width:100%;font-size:12px;padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:6px;color:var(--text)">
              </div>
              <div>
                <label style="font-size:10px;color:var(--text-secondary);display:block;margin-bottom:2px">Cantidad</label>
                <input type="number" min="1" value="${item.cantidad}" oninput="Proveedores._editItem(${idx},'cantidad',+this.value);Proveedores._refrescarTotal()" style="width:100%;font-size:12px;padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:6px;color:var(--text)">
              </div>
              <div>
                <label style="font-size:10px;color:var(--text-secondary);display:block;margin-bottom:2px">Precio USD/u</label>
                <input type="number" min="0" step="0.01" value="${item.precioUsd}" oninput="Proveedores._editItem(${idx},'precioUsd',+this.value);Proveedores._refrescarTotal()" style="width:100%;font-size:12px;padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:6px;color:var(--text)">
              </div>
            </div>
            <div style="text-align:right;font-size:11px;color:var(--text-secondary);margin-top:4px">Subtotal: <b>${State.fmtUSD(item.precioUsd * item.cantidad)}</b></div>
          </div>
        `).join('')}
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
            ${w.items.filter(i => i.nombre).map(i => `<div style="display:flex;justify-content:space-between;margin-bottom:3px"><span>${i.nombre} × ${i.cantidad}</span><b>${State.fmtUSD(i.precioUsd * i.cantidad)}</b></div>`).join('')}
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

  _agregarItem() { this._loteWizard.items.push({ nombre: '', cantidad: 1, precioUsd: 0 }); this._renderWizard(); },
  _quitarItem(idx) { this._loteWizard.items.splice(idx, 1); this._renderWizard(); },
  _editItem(idx, campo, val) { if (this._loteWizard.items[idx]) this._loteWizard.items[idx][campo] = val; },
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
      const validos = w.items.filter(i => i.nombre.trim());
      if (!validos.length) { toast('Agregá al menos un item', 'error'); return; }
    }
    w.paso++;
    this._renderWizard();
  },

  _wizardAnterior() { this._loteWizard.paso--; this._renderWizard(); },

  async _crearLote() {
    const w = this._loteWizard;
    const items = w.items.filter(i => i.nombre.trim());
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

    // Impactar cajas
    const saldoOrigen = (State.cajas[persona]?.[bolsillo]) || 0;
    const saldoDest = (State.cajas[personaDest]?.[bolsilloDestino]) || 0;
    State.cajas[persona] = State.cajas[persona] || {};
    State.cajas[personaDest] = State.cajas[personaDest] || {};
    State.cajas[persona][bolsillo] = saldoOrigen - montoUsd;
    State.cajas[personaDest][bolsilloDestino] = saldoDest + montoUsdt;
    await DB.actualizarSaldoCaja(persona, bolsillo, saldoOrigen - montoUsd);
    await DB.actualizarSaldoCaja(personaDest, bolsilloDestino, saldoDest + montoUsdt);

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

    const saldo = (State.cajas[persona]?.[bolsillo]) || 0;
    State.cajas[persona] = State.cajas[persona] || {};
    State.cajas[persona][bolsillo] = saldo - monto;
    await DB.actualizarSaldoCaja(persona, bolsillo, saldo - monto);
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

  modalEnvio(loteId) {
    const personas = State.personas || [];
    const BOLSILLOS = ['ARS cash', 'ARS transferencia', 'USD cash', 'USD transferencia', 'USDT'];
    const overlay = document.createElement('div');
    overlay.id = 'prov-envio-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(400px,96vw);overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:15px;font-weight:700">🚚 Costo de envío</div>
          <button onclick="document.getElementById('prov-envio-overlay').remove()" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:18px">✕</button>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Monto</label>
              <input id="envio-monto" type="number" min="0" step="0.01" placeholder="0" style="width:100%;font-size:14px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Moneda</label>
              <select id="envio-moneda" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                <option>USD</option><option>ARS</option><option>USDT</option>
              </select>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Desde (persona)</label>
              <select id="envio-persona" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                ${personas.map(p => `<option>${p}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Bolsillo</label>
              <select id="envio-bolsillo" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                ${BOLSILLOS.map(b => `<option>${b}</option>`).join('')}
              </select>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Fecha</label>
              <input id="envio-fecha" type="date" value="${new Date().toISOString().slice(0, 10)}" style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Notas</label>
              <input id="envio-notas" type="text" placeholder="Ej: Andreani, retiro en sucursal..." style="width:100%;font-size:13px;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('prov-envio-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Proveedores._confirmarEnvio(${loteId})">🚚 Registrar envío</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  },

  async _confirmarEnvio(loteId) {
    const monto = parseFloat(document.getElementById('envio-monto')?.value) || 0;
    const moneda = document.getElementById('envio-moneda')?.value;
    const persona = document.getElementById('envio-persona')?.value;
    const bolsillo = document.getElementById('envio-bolsillo')?.value;
    const fecha = document.getElementById('envio-fecha')?.value;
    const notas = document.getElementById('envio-notas')?.value.trim();
    if (!monto || monto <= 0) { toast('Ingresá un monto válido', 'error'); return; }

    const montoUsd = moneda === 'ARS' ? monto / (State.refBlue || 1) : monto;
    const saldo = (State.cajas[persona]?.[bolsillo]) || 0;
    State.cajas[persona] = State.cajas[persona] || {};
    State.cajas[persona][bolsillo] = saldo - monto;
    await DB.actualizarSaldoCaja(persona, bolsillo, saldo - monto);
    await DB.guardarLotePago(loteId, { tipo: 'envio', montoUsd, montoUsdt: 0, comisionPct: 0, comisionUsd: 0, moneda, persona, bolsillo, personaDest: '', bolsilloDestino: '', fecha, notas });

    document.getElementById('prov-envio-overlay')?.remove();
    toast('Costo de envío registrado', 'success');
    this.renderKpis();
    this.renderContent();
  },

  // ── MODAL RECEPCIÓN ──────────────────────────────────────────────

  modalRecepcion(loteId) {
    const l = (State.lotesCompra || []).find(x => x.id === loteId);
    const items = (State.loteItems || []).filter(i => i.loteId === loteId);
    const pagos = (State.lotePagos || []).filter(p => p.loteId === loteId);
    const totalItems = items.reduce((s, i) => s + i.precioUsd * i.cantidad, 0);
    const totalUds = items.reduce((s, i) => s + i.cantidad, 0);
    const comision = pagos.find(p => p.tipo === 'conversion')?.comisionUsd || 0;
    const envio = pagos.filter(p => p.tipo === 'envio').reduce((s, p) => s + p.montoUsd, 0);
    const costoUnit = totalUds > 0 ? (totalItems + comision + envio) / totalUds : 0;

    const overlay = document.createElement('div');
    overlay.id = 'prov-recep-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(500px,96vw);max-height:90dvh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
          <div style="font-size:15px;font-weight:700">📦 Confirmar recepción</div>
          <button onclick="document.getElementById('prov-recep-overlay').remove()" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:18px">✕</button>
        </div>
        <div style="padding:18px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:12px">
          <div style="background:var(--green-light);border-radius:8px;padding:10px;font-size:12px;color:var(--green)">
            Al confirmar, los items se agregarán al inventario con costo unitario: <b>${State.fmtUSD(costoUnit)}/u</b>
            <div style="font-size:10px;margin-top:4px;opacity:.8">= (items ${State.fmtUSD(totalItems)} + comisión ${State.fmtUSD(comision)} + envío ${State.fmtUSD(envio)}) ÷ ${totalUds} uds</div>
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
          <div style="font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.04em">Items que entran al stock:</div>
          ${items.map(i => `<div style="background:var(--bg-secondary);border-radius:8px;padding:10px;font-size:12px">
            <div style="font-weight:600">${i.nombre}${i.storage ? ` ${i.storage}` : ''}${i.color ? ` · ${i.color}` : ''} × ${i.cantidad} uds</div>
            <div style="color:var(--text-secondary);margin-top:2px">Costo unitario final: <b style="color:var(--blue)">${State.fmtUSD(costoUnit)}</b></div>
          </div>`).join('')}
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;flex-shrink:0">
          <button class="btn" onclick="document.getElementById('prov-recep-overlay').remove()">Cancelar</button>
          <button class="btn btn-green" onclick="Proveedores._confirmarRecepcion(${loteId},${costoUnit.toFixed(4)})">📦 Confirmar e ingresar al stock</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  },

  async _confirmarRecepcion(loteId, costoUnit) {
    const fecha = document.getElementById('recep-fecha')?.value || new Date().toISOString().slice(0, 10);
    const custodio = document.getElementById('recep-custodio')?.value || '';
    const items = (State.loteItems || []).filter(i => i.loteId === loteId);
    const l = (State.lotesCompra || []).find(x => x.id === loteId);
    const prov = (State.proveedores || []).find(p => p.id === l?.proveedorId);

    for (const item of items) {
      await DB.guardarProductoStock({
        cat: item.cat || 'iphone',
        nombre: [item.nombre, item.storage, item.color].filter(Boolean).join(' '),
        costoUSD: parseFloat(costoUnit),
        precioARS: Math.round(parseFloat(costoUnit) * (State.refBlue || 1)),
        cantidad: item.cantidad,
        imeis: [],
        cotiz: State.refBlue,
        proveedor: prov?.nombre || '',
        custodio,
        notas: `Lote #${loteId}${l?.nombre ? ' — ' + l.nombre : ''}`,
        estadoInventario: 'disponible',
        grado: item.grado || 'Sin grado',
        modelo: item.nombre,
        storage: item.storage || '',
        color: item.color || '',
        bateriaPct: null,
        estadoProducto: '',
      });
    }

    await DB.actualizarEstadoLote(loteId, 'recibido', fecha);
    document.getElementById('prov-recep-overlay')?.remove();
    toast('Lote recibido e ingresado al inventario ✅', 'success');
    this.renderKpis();
    this.renderContent();
  },

  async cancelarLote(loteId) {
    if (!confirm('¿Cancelar esta orden? Los movimientos de caja ya registrados no se revierten.')) return;
    await DB.actualizarEstadoLote(loteId, 'cancelado');
    toast('Orden cancelada', 'info');
    this.renderKpis();
    this.renderContent();
  },

  async eliminarLote(loteId) {
    if (!confirm('¿Eliminar esta orden definitivamente? Esta acción no se puede deshacer.')) return;
    const ok = await DB.eliminarLote(loteId);
    if (ok) {
      toast('Orden eliminada');
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
