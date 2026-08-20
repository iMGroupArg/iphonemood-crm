const Cajas = {
  _tab: 'cajas',   // 'cajas' | 'movimientos' | 'libro'
  _movimientos: [],

  render() {
    const c = document.createElement('div');
    c.className = 'body-pad';
    let totalARS = 0, totalUSD = 0, totalUSDT = 0;
    Object.values(State.cajas).forEach(caja => {
      totalARS  += (caja['ARS cash']||0) + (caja['ARS transferencia']||0);
      totalUSD  += (caja['USD cash']||0) + (caja['USD transferencia']||0);
      totalUSDT += caja['USDT'] || 0;
    });
    const equivalenteTotal = totalARS + totalUSD * State.refBlue + totalUSDT * State.refBlue;

    const BOLSILLO_ICON = {
      'ARS cash': 'ti-cash', 'ARS transferencia': 'ti-building-bank',
      'USD cash': 'ti-currency-dollar', 'USD transferencia': 'ti-transfer',
      'USDT': 'ti-currency-bitcoin'
    };

    c.innerHTML = `
      <!-- Control de cuadre del libro de movimientos -->
      <div id="cajas-cuadre" style="margin-bottom:14px"></div>

      <!-- KPIs consolidados -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px" class="cajas-kpi-grid">
        <div class="card" style="margin-bottom:0">
          <div style="font-size:10px;color:var(--text-secondary);margin-bottom:3px">ARS total</div>
          <div style="font-size:20px;font-weight:700">${State.fmtARS(totalARS)}</div>
        </div>
        <div class="card" style="margin-bottom:0">
          <div style="font-size:10px;color:var(--text-secondary);margin-bottom:3px">USD total</div>
          <div style="font-size:20px;font-weight:700">${State.fmtUSD(totalUSD)}</div>
        </div>
        <div class="card" style="margin-bottom:0">
          <div style="font-size:10px;color:var(--text-secondary);margin-bottom:3px">USDT total</div>
          <div style="font-size:20px;font-weight:700">${totalUSDT.toLocaleString('es-AR')} <span style="font-size:12px;color:var(--text-secondary)">USDT</span></div>
        </div>
        <div class="card" style="margin-bottom:0;background:var(--blue-light);border-color:rgba(10,132,255,.3)">
          <div style="font-size:10px;color:var(--blue);margin-bottom:3px">Equivalente ARS (blue)</div>
          <div style="font-size:20px;font-weight:700;color:var(--blue)">${State.fmtARS(equivalenteTotal)}</div>
        </div>
      </div>

      <!-- Tabs + botón Nuevo movimiento -->
      <div style="display:flex;align-items:center;gap:0;margin-bottom:16px;border-bottom:1px solid var(--border)">
        <button onclick="Cajas.setTab('cajas')" style="padding:8px 16px;font-size:13px;font-weight:600;background:none;border:none;border-bottom:2px solid ${this._tab==='cajas'?'var(--blue)':'transparent'};color:${this._tab==='cajas'?'var(--blue)':'var(--text-secondary)'};cursor:pointer">
          <i class="ti ti-wallet"></i> Cajas
        </button>
        <button onclick="Cajas.setTab('movimientos')" style="padding:8px 16px;font-size:13px;font-weight:600;background:none;border:none;border-bottom:2px solid ${this._tab==='movimientos'?'var(--blue)':'transparent'};color:${this._tab==='movimientos'?'var(--blue)':'var(--text-secondary)'};cursor:pointer">
          <i class="ti ti-arrows-exchange"></i> Movimientos
        </button>
        <button onclick="Cajas.setTab('libro')" style="padding:8px 16px;font-size:13px;font-weight:600;background:none;border:none;border-bottom:2px solid ${this._tab==='libro'?'var(--blue)':'transparent'};color:${this._tab==='libro'?'var(--blue)':'var(--text-secondary)'};cursor:pointer">
          <i class="ti ti-book"></i> Libro
        </button>
        <div style="flex:1"></div>
        <button class="btn btn-primary btn-sm" onclick="Cajas.abrirModalMovimiento()" style="margin-bottom:6px">
          <i class="ti ti-plus"></i> Nuevo movimiento
        </button>
      </div>

      <!-- Contenido de la pestaña activa -->
      <div id="cajas-tab-content">
        ${this._tab === 'cajas' ? this._cajasHTML(BOLSILLO_ICON)
          : this._tab === 'libro' ? this._libroHTML()
          : this._movimientosHTML()}
      </div>

      <div style="font-size:11px;color:var(--text-secondary);margin-top:12px"><i class="ti ti-info-circle"></i> Tocá cualquier saldo para ajustarlo. Para agregar o renombrar personas, andá a Panel de control → Cajas y personas.</div>
    `;

    this.pintarCuadre();
    return c;
  },

  // Compara cada saldo contra la suma de sus movimientos y lo muestra arriba.
  // Es la red de seguridad: si un guardado falla, acá se ve enseguida.
  async pintarCuadre() {
    let r;
    try { r = await DB.cuadreCajas(); } catch (e) { console.error(e); return; }
    const el = document.getElementById('cajas-cuadre');
    if (!el) return;

    if (r.sinLibro) {
      el.innerHTML = `<div style="background:var(--amber-light);border:1px solid var(--amber);border-radius:10px;padding:10px 14px;font-size:12.5px;color:var(--amber)">
        <b>Libro de movimientos sin iniciar.</b> Los saldos funcionan, pero todavía no se puede verificar si cuadran.
      </div>`;
      return;
    }

    if (r.ok) {
      el.innerHTML = `<div style="background:var(--green-light);border:1px solid var(--green);border-radius:10px;padding:10px 14px;font-size:12.5px;color:var(--green)">
        <i class="ti ti-circle-check"></i> <b>Cajas cuadradas.</b> Cada saldo coincide con la suma de sus movimientos.
      </div>`;
      return;
    }

    const filas = r.diferencias.map(d => `
      <div style="display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-top:1px solid rgba(0,0,0,.06)">
        <span>${d.persona} · ${d.bolsillo}</span>
        <span>saldo <b>${Math.round(d.saldo).toLocaleString('es-AR')}</b> · libro <b>${Math.round(d.suma).toLocaleString('es-AR')}</b>
          · <span style="color:var(--red);font-weight:700">${d.dif > 0 ? '+' : ''}${Math.round(d.dif).toLocaleString('es-AR')}</span></span>
      </div>`).join('');

    el.innerHTML = `<div style="background:var(--red-light);border:1px solid var(--red);border-radius:10px;padding:10px 14px;font-size:12.5px;color:var(--red)">
      <div style="margin-bottom:4px"><i class="ti ti-alert-triangle"></i> <b>${r.diferencias.length} caja(s) no cuadran</b> con el libro de movimientos.</div>
      ${filas}
      <div style="margin-top:6px;font-size:11px;opacity:.85">La diferencia es plata que entró o salió sin quedar registrada. Revisá esas cajas.</div>
    </div>`;
  },

  async setTab(t) {
    this._tab = t;
    if (t === 'movimientos') {
      this._movimientos = await DB.listarMovimientosCaja(200);
    }
    if (t === 'libro') {
      if (!this._libroFiltro) this._libroFiltro = this._rangoMes();
      this._libro = await DB.movimientosCaja(this._libroFiltro);
    }
    App.goTo('cajas');
  },

  // ── Filtros de tiempo del Libro ──────────────────────────────────
  _hoyISO(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  },
  _rangoMes() {
    const h = new Date();
    return { desde: this._hoyISO(new Date(h.getFullYear(), h.getMonth(), 1)), hasta: this._hoyISO(h) };
  },
  _rangoRapido(clave) {
    const h = new Date();
    if (clave === 'hoy')  return { desde: this._hoyISO(h), hasta: this._hoyISO(h) };
    if (clave === '7d')   return { desde: this._hoyISO(new Date(h.getFullYear(), h.getMonth(), h.getDate()-6)), hasta: this._hoyISO(h) };
    if (clave === 'mes')  return this._rangoMes();
    if (clave === 'mesAnterior') {
      const ini = new Date(h.getFullYear(), h.getMonth()-1, 1);
      const fin = new Date(h.getFullYear(), h.getMonth(), 0);
      return { desde: this._hoyISO(ini), hasta: this._hoyISO(fin) };
    }
    return { desde: '', hasta: '' };  // todo
  },
  async setRangoLibro(clave) {
    this._libroFiltro = { ...(this._libroFiltro || {}), ...this._rangoRapido(clave) };
    this._libro = await DB.movimientosCaja(this._libroFiltro);
    App.goTo('cajas');
  },
  async aplicarFiltroLibro() {
    this._libroFiltro = {
      desde:    document.getElementById('lib-desde')?.value || '',
      hasta:    document.getElementById('lib-hasta')?.value || '',
      persona:  document.getElementById('lib-persona')?.value || '',
      bolsillo: document.getElementById('lib-bolsillo')?.value || '',
      tipo:     document.getElementById('lib-tipo')?.value || '',
    };
    this._libro = await DB.movimientosCaja(this._libroFiltro);
    App.goTo('cajas');
  },

  TIPOS_LIBRO: {
    saldo_inicial:'Saldo inicial', venta:'Venta', venta_anulada:'Venta anulada',
    venta_fallida:'Venta no guardada', pago_eliminado:'Pago eliminado',
    gasto:'Gasto', reparacion:'Reparación', reparacion_cancelada:'Reparación cancelada',
    cueva:'Cueva', cueva_anulada:'Cueva anulada', proveedor:'Proveedor',
    cuenta_corriente:'Cuenta corriente', movimiento:'Movimiento entre cajas',
    activo_fijo:'Activo fijo', ajuste:'Ajuste manual', otro:'Otro'
  },

  exportarLibroExcel() {
    if (typeof XLSX === 'undefined') { toast('No se pudo cargar el módulo de exportación. Revisá tu conexión.'); return; }
    const filas = this._libro || [];
    if (!filas.length) { toast('No hay movimientos para exportar con estos filtros.'); return; }

    const datos = filas.map(m => {
      const d = new Date(m.creado_en);
      return {
        'Fecha':      d.toLocaleDateString('es-AR'),
        'Hora':       d.toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' }),
        'Persona':    m.persona,
        'Bolsillo':   m.bolsillo,
        'Concepto':   this.TIPOS_LIBRO[m.tipo] || m.tipo,
        'Referencia': m.referencia || '',
        'Detalle':    m.descripcion || '',
        'Entrada':    Number(m.delta) > 0 ? Number(m.delta) : '',
        'Salida':     Number(m.delta) < 0 ? Math.abs(Number(m.delta)) : '',
        'Movimiento': Number(m.delta),
        'Saldo':      m.saldo_post != null ? Number(m.saldo_post) : '',
        'Quién':      m.creado_por || '',
      };
    });

    const ws = XLSX.utils.json_to_sheet(datos);
    ws['!cols'] = [{wch:11},{wch:7},{wch:22},{wch:18},{wch:20},{wch:11},{wch:40},{wch:14},{wch:14},{wch:14},{wch:14},{wch:20}];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Libro de caja');
    const f = this._libroFiltro || {};
    const sufijo = f.desde || f.hasta ? `${f.desde || 'inicio'}_a_${f.hasta || 'hoy'}` : 'todo';
    XLSX.writeFile(wb, `iPhoneMood-LibroCaja-${sufijo}.xlsx`);
    toast(`${datos.length} movimientos exportados.`);
  },

  // Libro mayor real: lo que quedó grabado en la base, movimiento por
  // movimiento, con el saldo resultante y quién lo hizo.
  _libroHTML() {
    const filas = this._libro || [];
    const f = this._libroFiltro || {};
    const TIPO = this.TIPOS_LIBRO;
    const fmt = n => Math.round(Number(n)).toLocaleString('es-AR');

    const bolsillos = ['ARS cash','ARS transferencia','USD cash','USD transferencia','USDT'];
    const sel = 'font-size:12px;padding:6px 8px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg);color:var(--text)';
    const btnR = (clave, txt) => `<button class="btn btn-sm" onclick="Cajas.setRangoLibro('${clave}')">${txt}</button>`;

    const entradas = filas.filter(m => Number(m.delta) > 0).reduce((a,m)=>a+Number(m.delta),0);
    const salidas  = filas.filter(m => Number(m.delta) < 0).reduce((a,m)=>a+Math.abs(Number(m.delta)),0);

    const barra = `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
          ${btnR('hoy','Hoy')} ${btnR('7d','Últimos 7 días')} ${btnR('mes','Este mes')}
          ${btnR('mesAnterior','Mes anterior')} ${btnR('todo','Todo')}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
          <div><label style="font-size:10px;color:var(--text-secondary);display:block;margin-bottom:3px">Desde</label>
            <input type="date" id="lib-desde" value="${f.desde || ''}" style="${sel}"></div>
          <div><label style="font-size:10px;color:var(--text-secondary);display:block;margin-bottom:3px">Hasta</label>
            <input type="date" id="lib-hasta" value="${f.hasta || ''}" style="${sel}"></div>
          <div><label style="font-size:10px;color:var(--text-secondary);display:block;margin-bottom:3px">Persona</label>
            <select id="lib-persona" style="${sel}"><option value="">Todas</option>
              ${(State.personas||[]).map(p=>`<option ${f.persona===p?'selected':''}>${p}</option>`).join('')}</select></div>
          <div><label style="font-size:10px;color:var(--text-secondary);display:block;margin-bottom:3px">Bolsillo</label>
            <select id="lib-bolsillo" style="${sel}"><option value="">Todos</option>
              ${bolsillos.map(b=>`<option ${f.bolsillo===b?'selected':''}>${b}</option>`).join('')}</select></div>
          <div><label style="font-size:10px;color:var(--text-secondary);display:block;margin-bottom:3px">Concepto</label>
            <select id="lib-tipo" style="${sel}"><option value="">Todos</option>
              ${Object.entries(TIPO).map(([k,v])=>`<option value="${k}" ${f.tipo===k?'selected':''}>${v}</option>`).join('')}</select></div>
          <button class="btn btn-primary btn-sm" onclick="Cajas.aplicarFiltroLibro()"><i class="ti ti-filter"></i> Aplicar</button>
          <button class="btn btn-sm" onclick="Cajas.exportarLibroExcel()"><i class="ti ti-file-spreadsheet"></i> Exportar Excel</button>
        </div>
        ${filas.length ? `<div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid var(--border);font-size:12px">
          <span style="color:var(--text-secondary)">Movimientos: <b style="color:var(--text)">${filas.length}</b></span>
          <span style="color:var(--text-secondary)">Entradas: <b style="color:var(--green)">+${fmt(entradas)}</b></span>
          <span style="color:var(--text-secondary)">Salidas: <b style="color:var(--red)">−${fmt(salidas)}</b></span>
          <span style="color:var(--text-secondary)">Neto: <b style="color:${entradas-salidas>=0?'var(--green)':'var(--red)'}">${entradas-salidas>=0?'+':'−'}${fmt(Math.abs(entradas-salidas))}</b></span>
        </div>` : ''}
      </div>`;

    if (!filas.length) {
      return barra + `<div class="card" style="text-align:center;padding:28px;color:var(--text-secondary);font-size:13px">
        No hay movimientos en este período. Probá ampliando el rango o tocando “Todo”.
      </div>`;
    }

    return barra + `<div class="card" style="padding:0;overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:760px">
        <thead>
          <tr style="background:var(--bg-secondary);text-align:left">
            <th style="padding:9px 12px;font-weight:600">Fecha</th>
            <th style="padding:9px 12px;font-weight:600">Caja</th>
            <th style="padding:9px 12px;font-weight:600">Concepto</th>
            <th style="padding:9px 12px;font-weight:600;text-align:right">Movimiento</th>
            <th style="padding:9px 12px;font-weight:600;text-align:right">Saldo</th>
            <th style="padding:9px 12px;font-weight:600">Quién</th>
          </tr>
        </thead>
        <tbody>
          ${filas.map(m => {
            const d = new Date(m.creado_en);
            const fecha = d.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'}) + ' ' +
                          d.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'});
            const pos = Number(m.delta) >= 0;
            const ref = m.referencia ? ` #${m.referencia}` : '';
            return `<tr style="border-top:1px solid var(--border)">
              <td style="padding:8px 12px;white-space:nowrap;color:var(--text-secondary)">${fecha}</td>
              <td style="padding:8px 12px;white-space:nowrap"><b>${m.persona}</b><br><span style="font-size:11px;color:var(--text-secondary)">${m.bolsillo}</span></td>
              <td style="padding:8px 12px">${TIPO[m.tipo] || m.tipo}${ref}
                ${m.descripcion ? `<br><span style="font-size:11px;color:var(--text-secondary)">${m.descripcion}</span>` : ''}</td>
              <td style="padding:8px 12px;text-align:right;white-space:nowrap;font-weight:700;color:${pos?'var(--green)':'var(--red)'}">${pos?'+':'−'}${fmt(Math.abs(m.delta))}</td>
              <td style="padding:8px 12px;text-align:right;white-space:nowrap;color:var(--text-secondary)">${m.saldo_post != null ? fmt(m.saldo_post) : '—'}</td>
              <td style="padding:8px 12px;white-space:nowrap">${m.creado_por || '—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div style="font-size:11px;color:var(--text-secondary);margin-top:8px">Últimos ${filas.length} movimientos.</div>`;
  },

  _cajasHTML(BOLSILLO_ICON) {
    return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">
        ${State.personas.map(p => {
          const caja = State.cajas[p] || {};
          const arsEquiv = (caja['ARS cash']||0) + (caja['ARS transferencia']||0)
                         + ((caja['USD cash']||0)+(caja['USD transferencia']||0)) * State.refBlue
                         + (caja['USDT']||0) * State.refBlue;
          const usdEquiv = ((caja['ARS cash']||0) + (caja['ARS transferencia']||0)) / State.refBlueCompra
                         + (caja['USD cash']||0) + (caja['USD transferencia']||0)
                         + (caja['USDT']||0);
          return `<div class="card" style="margin-bottom:0">
            <div class="card-title" style="margin-bottom:14px">
              <div class="av" style="width:30px;height:30px;font-size:11px">${p.substring(0,2).toUpperCase()}</div>
              <span style="font-size:14px;font-weight:700">${p}</span>
            </div>
            ${['ARS cash','ARS transferencia','USD cash','USD transferencia','USDT'].map(b => {
              const val = caja[b] || 0;
              const fmt = b === 'USDT' ? val.toLocaleString('es-AR') + ' USDT'
                        : b.startsWith('ARS') ? State.fmtARS(val)
                        : State.fmtUSD(val);
              return `<div onclick="Cajas.abrirModal('${p}','${b}')"
                style="display:flex;align-items:center;gap:10px;padding:9px 8px;border-radius:8px;cursor:pointer;transition:background .12s"
                onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background='transparent'">
                <i class="ti ${BOLSILLO_ICON[b]}" style="font-size:16px;color:var(--text-secondary);width:18px;text-align:center;flex-shrink:0"></i>
                <span style="flex:1;font-size:12px;color:var(--text-secondary)">${b}</span>
                <b style="font-size:13px">${fmt}</b>
                ✏️
              </div>`;
            }).join('')}
            <div style="border-top:1px solid var(--border);margin-top:8px;padding-top:8px;display:flex;justify-content:space-between;align-items:center">
              <span style="font-size:11px;color:var(--text-secondary)">Equiv. ARS</span>
              <b style="color:var(--blue)">${State.fmtARS(arsEquiv)}</b>
            </div>
            <div style="margin-top:6px;display:flex;justify-content:space-between;align-items:center">
              <span style="font-size:11px;color:var(--text-secondary)">Equiv. USD</span>
              <b style="color:var(--text-secondary);font-size:12px">${State.fmtUSD(usdEquiv)}</b>
            </div>
          </div>`;
        }).join('')}
      </div>`;
  },

  _buildLedger() {
    const entries = [];

    // 1. Ventas — cada pago de venta entra a una caja
    (State.ventas || []).forEach(v => {
      (v.pagos || []).forEach(p => {
        if (!p.monto) return;
        entries.push({
          _ts: v.fechaISO || v.fecha,
          tipo: 'venta', icon: 'ti-receipt', color: 'var(--green)',
          titulo: `Venta${v.cliente ? ' · ' + v.cliente : ''}`,
          sub: `${p.caja}${v.items?.length ? ' · ' + v.items.map(i=>i.nombre).join(', ').substring(0,40) : ''}`,
          montoFmt: State.fmtUSD(p.monto),
          dir: '+', dirColor: 'var(--green)',
          _revertKey: `venta:${v.id}:${p.id}:${p.persona}:${p.bolsillo}:${p.monto}`,
        });
      });
    });

    // 2. Gastos — salen de caja
    (State.gastos || []).forEach(g => {
      if (g.estado !== 'pagado') return;
      const fmt = g.moneda === 'USD' ? State.fmtUSD(g.monto) : State.fmtARS(g.monto);
      entries.push({
        _ts: g.fechaISO || g.fecha,
        tipo: 'gasto', icon: 'ti-arrow-down-circle', color: 'var(--red)',
        titulo: g.motivo,
        sub: g.caja + (g.responsable ? ' · ' + g.responsable : ''),
        montoFmt: fmt,
        dir: '−', dirColor: 'var(--red)',
        _revertKey: `gasto:${g.id}`,
      });
    });

    // 3. Cambios de cueva
    (State.cambios || []).forEach(c => {
      const t = { 'ars-usd':'ARS → USD','ars-usdt':'ARS → USDT','usd-ars':'USD → ARS','usdt-ars':'USDT → ARS','usd-usdt':'USD → USDT' }[c.tipo] || c.tipo;
      entries.push({
        _ts: c.fechaISO || c.fecha,
        tipo: 'cueva', icon: 'ti-arrows-exchange', color: 'var(--purple)',
        titulo: `Cambio ${t}`,
        sub: `${c.origenP}·${c.origenB} → ${c.destinoP}·${c.destinoB}`,
        montoFmt: `${c.entrega.toLocaleString('es-AR')} → ${c.recibe.toLocaleString('es-AR')}`,
        dir: '⇄', dirColor: 'var(--purple)',
        _revertKey: `cueva:${c.id}`,
      });
    });

    // 4. Pagos de compras a proveedores
    (State.lotePagos || []).forEach(p => {
      if (!p.montoUsd && !p.montoUsdt) return;
      const lote = (State.lotesCompra || []).find(l => l.id === p.loteId);
      const monto = p.moneda === 'USDT' ? p.montoUsdt : p.montoUsd;
      const fmt = p.moneda === 'USDT' ? monto.toLocaleString('es-AR') + ' USDT' : State.fmtUSD(monto);
      entries.push({
        _ts: p.fecha || '',
        tipo: 'proveedor', icon: 'ti-truck', color: 'var(--amber)',
        titulo: `Compra proveedor${lote?.nombre ? ' · ' + lote.nombre : ''}`,
        sub: `${p.persona}·${p.bolsillo}${p.notas ? ' · ' + p.notas : ''}`,
        montoFmt: fmt,
        dir: '−', dirColor: 'var(--amber)',
        _revertKey: `lote:${p.id}:${p.persona}:${p.bolsillo}:${monto}:${p.moneda}`,
      });
    });

    // 5. Movimientos entre cajas
    const TIPO_LABEL = { pasada_manos:'Pasada de manos', retiro_banco:'Retiro bancario', deposito_banco:'Depósito a banco', otro:'Otro' };
    (this._movimientos || []).forEach(m => {
      const fmt = m.moneda === 'ARS' ? State.fmtARS(m.monto) : m.moneda === 'USDT' ? m.monto.toLocaleString('es-AR') + ' USDT' : State.fmtUSD(m.monto);
      entries.push({
        _ts: m.creado_en,
        tipo: 'movimiento', icon: 'ti-arrows-exchange', color: 'var(--blue)',
        titulo: TIPO_LABEL[m.tipo] || m.tipo,
        sub: `${m.origenP ? m.origenP+'·'+m.origen_bolsillo : '—'} → ${m.destinoP ? m.destinoP+'·'+m.destino_bolsillo : '—'}${m.descripcion ? ' · '+m.descripcion : ''}`,
        montoFmt: fmt,
        dir: '⇄', dirColor: 'var(--blue)',
        _movId: m.id, _comprobanteUrl: m.comprobante_url,
        _revertKey: `movimiento:${m.id}`,
      });
    });

    // Ordenar por fecha desc — intentamos parsear, sino queda al final
    entries.sort((a, b) => {
      const ta = a._ts ? new Date(a._ts).getTime() : 0;
      const tb = b._ts ? new Date(b._ts).getTime() : 0;
      return tb - ta;
    });

    return entries;
  },

  _movimientosHTML() {
    const entries = this._buildLedger();
    if (!entries.length) {
      return `<div style="text-align:center;padding:40px;color:var(--text-secondary)"><i class="ti ti-arrows-exchange" style="font-size:32px;display:block;margin-bottom:8px"></i>No hay movimientos registrados aún.</div>`;
    }

    const BADGE = {
      venta:      `<span class="badge b-green"  style="font-size:9px">Venta</span>`,
      gasto:      `<span class="badge b-red"    style="font-size:9px">Gasto</span>`,
      cueva:      `<span class="badge b-purple" style="font-size:9px">Cambio</span>`,
      proveedor:  `<span class="badge b-amber"  style="font-size:9px">Proveedor</span>`,
      movimiento: `<span class="badge b-blue"   style="font-size:9px">Movimiento</span>`,
    };

    return `<div style="display:flex;flex-direction:column;gap:8px">
      ${entries.map(e => {
        const fechaFmt = e._ts ? (() => { try { return new Date(e._ts).toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'}); } catch(_){return e._ts;} })() : '—';
        const rk = e._revertKey ? encodeURIComponent(e._revertKey) : '';
        return `<div class="card" style="margin-bottom:0;display:flex;align-items:flex-start;gap:12px;padding:10px 14px">
          <div style="width:34px;height:34px;border-radius:9px;background:${e.color}22;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px">
            <i class="ti ${e.icon}" style="font-size:16px;color:${e.color}"></i>
          </div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px">
              ${BADGE[e.tipo]||''}
              <span style="font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px">${e.titulo}</span>
            </div>
            <div style="font-size:10px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.sub}</div>
            <div style="font-size:10px;color:var(--text-tertiary);margin-top:2px">${fechaFmt}</div>
          </div>
          <div style="text-align:right;flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            <div style="font-size:13px;font-weight:800;color:${e.dirColor}">${e.dir} ${e.montoFmt}</div>
            <div style="display:flex;gap:4px;align-items:center">
              ${e._movId !== undefined ? (e._comprobanteUrl
                ? `<button onclick="Cajas.verComprobante('${e._comprobanteUrl}')" style="font-size:9px;padding:2px 6px;border:1px solid var(--border-strong);border-radius:5px;background:transparent;color:var(--text-secondary);cursor:pointer"><i class="ti ti-photo"></i></button>`
                : `<button onclick="Cajas.adjuntarComprobante(${e._movId})" style="font-size:9px;padding:2px 6px;border:1px solid var(--border);border-radius:5px;background:transparent;color:var(--text-tertiary);cursor:pointer"><i class="ti ti-upload"></i></button>`
              ) : ''}
              ${rk ? `<button onclick="Cajas.revertirMovimiento('${rk}')" style="font-size:9px;padding:2px 6px;border:1px solid var(--red);border-radius:5px;background:transparent;color:var(--red);cursor:pointer" title="Revertir este movimiento"><i class="ti ti-arrow-back-up"></i></button>` : ''}
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  },

  // ── Modal nuevo movimiento ─────────────────────────────────

  abrirModalMovimiento() {
    const personaOpts = State.personas.map(p => `<option value="${p}">${p}</option>`).join('');
    const bolsilloOpts = ['ARS cash','ARS transferencia','USD cash','USD transferencia','USDT']
      .map(b => `<option value="${b}">${b}</option>`).join('');
    const sep = (label) => `<div style="font-size:10px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 6px">${label}</div>`;

    const overlay = document.createElement('div');
    overlay.id = 'caja-mov-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(6px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(440px,96vw);max-height:90vh;overflow-y:auto">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
          <div style="font-size:14px;font-weight:700"><i class="ti ti-arrows-exchange"></i> Nuevo movimiento</div>
          <button onclick="document.getElementById('caja-mov-overlay').remove()" style="background:none;border:none;color:var(--text-secondary);font-size:18px;cursor:pointer;line-height:1">✕</button>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:4px">

          ${sep('Tipo de movimiento')}
          <select id="cmov-tipo" onchange="Cajas._onTipoChange()" style="font-size:13px;padding:9px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);width:100%">
            <option value="pasada_manos">🔄 Pasada de manos entre personas</option>
            <option value="retiro_banco">🏦 Retiro bancario a efectivo</option>
            <option value="deposito_banco">🏦 Depósito de efectivo al banco</option>
            <option value="otro">📝 Otro</option>
          </select>

          ${sep('Origen')}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Persona</label>
              <select id="cmov-origen-p" style="font-size:12px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);width:100%">
                ${personaOpts}
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Bolsillo</label>
              <select id="cmov-origen-b" style="font-size:12px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);width:100%">
                ${bolsilloOpts}
              </select>
            </div>
          </div>

          <div id="cmov-destino-wrap">
            ${sep('Destino')}
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <div>
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Persona</label>
                <select id="cmov-destino-p" style="font-size:12px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);width:100%">
                  ${personaOpts}
                </select>
              </div>
              <div>
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Bolsillo</label>
                <select id="cmov-destino-b" style="font-size:12px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);width:100%">
                  ${bolsilloOpts}
                </select>
              </div>
            </div>
          </div>

          ${sep('Monto')}
          <div style="display:grid;grid-template-columns:1fr 120px;gap:8px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Monto</label>
              <input type="number" id="cmov-monto" min="0" step="0.01" placeholder="0" style="width:100%;font-size:16px;font-weight:700;padding:9px 12px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Moneda</label>
              <select id="cmov-moneda" style="font-size:12px;padding:9px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);width:100%">
                <option value="ARS">ARS</option>
                <option value="USD">USD</option>
                <option value="USDT">USDT</option>
              </select>
            </div>
          </div>

          ${sep('Descripción (opcional)')}
          <textarea id="cmov-desc" rows="2" placeholder="Ej: Franco le pasa plata a Lautaro para compra..." style="width:100%;font-size:12px;padding:9px 12px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);resize:none;font-family:inherit"></textarea>

          ${sep('Comprobante (opcional)')}
          <label for="cmov-file" style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;cursor:pointer">
            <i class="ti ti-upload" style="font-size:16px;color:var(--text-secondary)"></i>
            <span id="cmov-file-label" style="font-size:12px;color:var(--text-secondary)">Adjuntar imagen o captura</span>
          </label>
          <input type="file" id="cmov-file" accept="image/*,application/pdf" style="display:none" onchange="Cajas._onFileChange(this)">

        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('caja-mov-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" id="cmov-btn-guardar" onclick="Cajas.guardarMovimiento()"><i class="ti ti-check"></i> Registrar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    this._onTipoChange();
    setTimeout(() => document.getElementById('cmov-monto')?.focus(), 80);
  },

  _onTipoChange() {
    const tipo = document.getElementById('cmov-tipo')?.value;
    const destinoWrap = document.getElementById('cmov-destino-wrap');
    if (!destinoWrap) return;
    // retiro_banco: origen = transferencia, destino = mismo usuario cash
    const mostrarDestino = tipo !== 'retiro_banco' && tipo !== 'deposito_banco';
    destinoWrap.style.display = mostrarDestino ? '' : 'none';
    // sincronizar bolsillos según tipo
    if (tipo === 'retiro_banco') {
      const ob = document.getElementById('cmov-origen-b');
      if (ob) ob.value = 'ARS transferencia';
    }
    if (tipo === 'deposito_banco') {
      const ob = document.getElementById('cmov-origen-b');
      if (ob) ob.value = 'ARS cash';
    }
  },

  _onFileChange(input) {
    const label = document.getElementById('cmov-file-label');
    if (label && input.files[0]) label.textContent = input.files[0].name;
  },

  async guardarMovimiento() {
    const tipo     = document.getElementById('cmov-tipo')?.value;
    const origenP  = document.getElementById('cmov-origen-p')?.value;
    const origenB  = document.getElementById('cmov-origen-b')?.value;
    const monto    = parseFloat(document.getElementById('cmov-monto')?.value);
    const moneda   = document.getElementById('cmov-moneda')?.value || 'ARS';
    const desc     = document.getElementById('cmov-desc')?.value.trim();
    const file     = document.getElementById('cmov-file')?.files[0];

    if (!monto || monto <= 0) { toast('Ingresá un monto válido.'); return; }
    if (!origenP) { toast('Seleccioná persona origen.'); return; }

    const tieneDestino = tipo === 'pasada_manos' || tipo === 'otro';
    const destinoP = tieneDestino ? document.getElementById('cmov-destino-p')?.value : null;
    const destinoB = tieneDestino ? document.getElementById('cmov-destino-b')?.value : null;

    // Para retiro/depósito el destino es el mismo usuario con bolsillo opuesto
    let destinoPFinal = destinoP, destinoBFinal = destinoB;
    // El retiro/depósito no cambia de moneda: si sacás de USD transferencia,
    // entra a USD cash. Antes estaba fijo en ARS y mezclaba monedas.
    const monedaOrigen = origenB?.startsWith('USD') ? 'USD' : origenB === 'USDT' ? 'USDT' : 'ARS';
    if (tipo === 'retiro_banco') {
      destinoPFinal = origenP;
      destinoBFinal = monedaOrigen === 'USD' ? 'USD cash' : monedaOrigen === 'USDT' ? 'USDT' : 'ARS cash';
    } else if (tipo === 'deposito_banco') {
      destinoPFinal = origenP;
      destinoBFinal = monedaOrigen === 'USD' ? 'USD transferencia' : monedaOrigen === 'USDT' ? 'USDT' : 'ARS transferencia';
    }

    if (origenP === destinoPFinal && origenB === destinoBFinal) {
      toast('El origen y el destino son la misma caja: no hay nada que mover.'); return;
    }
    // La moneda tiene que coincidir con el bolsillo, si no se mezclan pesos y dólares
    const monedaBolsillo = origenB?.startsWith('USD') ? 'USD' : origenB === 'USDT' ? 'USDT' : 'ARS';
    if (moneda !== monedaBolsillo) {
      toast(`El bolsillo "${origenB}" es en ${monedaBolsillo} pero elegiste ${moneda}. Corregí la moneda.`); return;
    }
    const saldoOrigen = State.cajas[origenP]?.[origenB] || 0;
    if (monto > saldoOrigen + 0.005) {
      const fmt = monedaBolsillo === 'ARS' ? State.fmtARS(saldoOrigen) : State.fmtUSD(saldoOrigen);
      if (!confirm(`${origenP} · ${origenB} tiene ${fmt} y estás moviendo más que eso.\n\nEl saldo va a quedar en negativo. ¿Confirmás?`)) return;
    }

    const btn = document.getElementById('cmov-btn-guardar');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

    try {
      // 1. Guardar movimiento en DB
      const mov = await DB.crearMovimientoCaja({
        tipo, descripcion: desc, origenPersona: origenP, origenBolsillo: origenB,
        destinoPersona: destinoPFinal, destinoBolsillo: destinoBFinal,
        monto, moneda, creadoPor: State.currentUser || null,
      });

      // 2. Actualizar saldos automáticamente
      await this._aplicarSaldos({ tipo, origenP, origenB, destinoPFinal, destinoBFinal, monto, moneda, desc });

      // 3. Subir comprobante si hay
      if (file && mov?.id) {
        try { await DB.subirComprobanteCaja(mov.id, file); } catch(e) { console.warn('Comprobante no subido:', e); }
      }

      document.getElementById('caja-mov-overlay')?.remove();
      toast('Movimiento registrado.');
      this._tab = 'movimientos';
      this._movimientos = await DB.listarMovimientosCaja(200);
      App.goTo('cajas');
    } catch(e) {
      console.error(e);
      toast('Error al guardar el movimiento.');
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-check"></i> Registrar'; }
    }
  },

  async _aplicarSaldos({ tipo, origenP, origenB, destinoPFinal, destinoBFinal, monto, moneda, desc }) {
    // Este movimiento pasa por el motor central de cajas (State), igual que las
    // ventas y los gastos. Antes escribía los saldos por su cuenta, y eso traía
    // tres problemas: no quedaba asentado en el libro, podía pisarse con otra
    // escritura simultánea, y usaba Math.max(0, ...) al restar del origen —
    // o sea que si el origen no tenía saldo suficiente, la diferencia se
    // perdía y el destino igual recibía todo: plata creada de la nada.
    const ref = {
      tipo: tipo === 'retiro_banco' ? 'retiro_banco'
          : tipo === 'deposito_banco' ? 'deposito_banco' : 'movimiento',
      descripcion: desc || null,
    };

    // Origen y destino iguales: no hay movimiento real que aplicar.
    if (origenP === destinoPFinal && origenB === destinoBFinal) return;

    if (origenP && origenB) {
      await State.debitarCaja(origenP, origenB, monto,
        { ...ref, descripcion: ref.descripcion || `Sale hacia ${destinoPFinal || '—'} · ${destinoBFinal || '—'}` });
    }
    if (destinoPFinal && destinoBFinal) {
      await State.acreditarCaja(destinoPFinal, destinoBFinal, monto,
        { ...ref, descripcion: ref.descripcion || `Viene de ${origenP} · ${origenB}` });
    }
  },

  // ── Revertir movimiento ─────────────────────────────────────

  async revertirMovimiento(encodedKey) {
    const key = decodeURIComponent(encodedKey);
    const [tipo, ...parts] = key.split(':');

    if (tipo === 'gasto') {
      const [id] = parts;
      const g = State.gastos.find(x => x.id == id);
      if (!g) return;
      if (!confirm(`¿Revertir el gasto "${g.motivo}" por ${g.moneda === 'USD' ? State.fmtUSD(g.monto) : State.fmtARS(g.monto)}?\nEl monto volverá a la caja ${g.caja}.`)) return;
      await Gastos.deleteGasto(id);
      this._movimientos = await DB.listarMovimientosCaja(200);
      this._tab = 'movimientos';
      App.goTo('cajas');

    } else if (tipo === 'movimiento') {
      const [id] = parts;
      const m = (this._movimientos || []).find(x => x.id == id);
      if (!m) return;
      if (!confirm(`¿Revertir este movimiento (${m.monto.toLocaleString('es-AR')} ${m.moneda})?\nSe devolverá el dinero al origen y se quitará del destino.`)) return;
      // Revertir: sumar al origen, restar del destino
      // Por el motor central, sin recortar en 0: el reverso tiene que devolver
      // exactamente lo mismo que se movió, aunque el saldo quede negativo.
      const refRev = { tipo: 'movimiento', descripcion: 'Reverso de un movimiento entre cajas' };
      if (m.origenP && m.origen_bolsillo) {
        await State.acreditarCaja(m.origenP, m.origen_bolsillo, m.monto, refRev);
      }
      if (m.destinoP && m.destino_bolsillo) {
        await State.debitarCaja(m.destinoP, m.destino_bolsillo, m.monto, refRev);
      }
      await supa.from('caja_movimientos').delete().eq('id', id);
      this._movimientos = await DB.listarMovimientosCaja(200);
      this._tab = 'movimientos';
      App.goTo('cajas');
      toast('Movimiento revertido. Los saldos fueron restaurados.');

    } else if (tipo === 'cueva') {
      const [id] = parts;
      await Cueva.deleteOp(id);

    } else if (tipo === 'venta') {
      const [ventaId, pagoId, persona, bolsillo, monto] = parts;
      if (!confirm(`¿Revertir el pago de esta venta (${State.fmtUSD(Number(monto))}) de la caja ${persona}-${bolsillo}?\nEl monto volverá a la caja pero la venta seguirá registrada.`)) return;
      // Sacar de la caja lo que había entrado por ese pago, por el motor central
      await State.debitarCaja(persona, bolsillo, Number(monto),
        { tipo: 'pago_eliminado', referencia: ventaId, descripcion: `Se revirtió un pago de la venta #${ventaId}` });
      // Eliminar el pago puntual
      await supa.from('venta_pagos').delete().eq('id', pagoId);
      const v = State.ventas.find(x => x.id == ventaId);
      if (v) v.pagos = v.pagos.filter(p => p.id != pagoId);
      this._movimientos = await DB.listarMovimientosCaja(200);
      this._tab = 'movimientos';
      App.goTo('cajas');
      toast('Pago revertido. La venta sigue activa pero sin ese cobro.');

    } else if (tipo === 'lote') {
      const [pagoId, persona, bolsillo, monto, moneda] = parts;
      if (!confirm(`¿Revertir este pago a proveedor (${moneda === 'USDT' ? Number(monto).toLocaleString('es-AR')+' USDT' : State.fmtUSD(Number(monto))}) de la caja ${persona}-${bolsillo}?\nEl monto volverá a la caja.`)) return;
      // Acreditar la caja por el motor central, para que quede en el libro
      await State.acreditarCaja(persona, bolsillo, Number(monto),
        { tipo: 'proveedor', referencia: pagoId, descripcion: 'Se revirtió un pago a proveedor' });
      await DB.eliminarLotePago(pagoId);
      State.lotePagos = State.lotePagos.filter(p => p.id != pagoId);
      this._movimientos = await DB.listarMovimientosCaja(200);
      this._tab = 'movimientos';
      App.goTo('cajas');
      toast('Pago a proveedor revertido. El monto fue devuelto a la caja.');

    } else {
      toast('Este tipo de movimiento no se puede revertir desde aquí.');
    }
  },

  // ── Comprobante ─────────────────────────────────────────────

  async verComprobante(path) {
    const url = await DB.getComprobanteCajaUrl(path);
    if (!url) { toast('No se pudo obtener el comprobante.'); return; }
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;cursor:zoom-out';
    overlay.innerHTML = `<img src="${url}" style="max-width:100%;max-height:90vh;border-radius:8px;object-fit:contain">`;
    overlay.onclick = () => overlay.remove();
    document.body.appendChild(overlay);
  },

  async adjuntarComprobante(movId) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*,application/pdf';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        await DB.subirComprobanteCaja(movId, file);
        toast('Comprobante adjuntado.');
        this._movimientos = await DB.listarMovimientosCaja(200);
        App.goTo('cajas');
      } catch(e) { toast('Error al subir el comprobante.'); }
    };
    input.click();
  },

  // ── Modal ajuste manual (existente) ─────────────────────────

  abrirModal(persona, bolsillo) {
    const actual = (State.cajas[persona] && State.cajas[persona][bolsillo]) || 0;
    const overlay = document.createElement('div');
    overlay.id = 'caja-edit-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(6px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    const isARS = bolsillo.startsWith('ARS');
    const isUSD = bolsillo.startsWith('USD');
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(360px,96vw);overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border)">
          <div style="font-size:14px;font-weight:700">Ajustar saldo</div>
          <div style="font-size:11px;color:var(--text-secondary)">${persona} · ${bolsillo}</div>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
          <div style="background:var(--bg-secondary);border-radius:8px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:11px;color:var(--text-secondary)">Saldo actual</span>
            <b style="font-size:15px">${isUSD ? State.fmtUSD(actual) : bolsillo==='USDT' ? actual+' USDT' : State.fmtARS(actual)}</b>
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Nuevo saldo</label>
            <input type="number" id="caja-nuevo-saldo" value="${actual}" step="${isUSD||bolsillo==='USDT'?'0.01':'1'}"
              style="width:100%;font-size:18px;font-weight:700;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
            ${[0.25,0.5,0.75,1,1.5,2].filter(m => isARS ? m >= 1 : true).slice(0,3).map(m =>
              `<button onclick="document.getElementById('caja-nuevo-saldo').value=(${actual}*${m}).toFixed(${isUSD||bolsillo==='USDT'?2:0})" style="font-size:10px;padding:5px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text-secondary);cursor:pointer">×${m}</button>`
            ).join('')}
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('caja-edit-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Cajas.guardarSaldo('${persona}','${bolsillo}')">✓ Guardar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    setTimeout(() => { const el = document.getElementById('caja-nuevo-saldo'); el?.focus(); el?.select(); }, 60);
  },

  async guardarSaldo(persona, bolsillo) {
    const input = document.getElementById('caja-nuevo-saldo');
    const nuevo = parseFloat(input?.value);
    if (isNaN(nuevo)) { toast('Ingresá un número válido.'); return; }
    document.getElementById('caja-edit-overlay')?.remove();
    if (!State.cajas[persona]) State.cajas[persona] = {};
    // Se guarda como diferencia contra el saldo actual, no como valor absoluto:
    // así el ajuste queda en el libro con su monto real y el motor central puede
    // revertirlo si la base no confirma la escritura.
    const actual = State.cajas[persona][bolsillo] || 0;
    const delta = nuevo - actual;
    if (!delta) { toast('El saldo no cambió.'); return; }
    await State.acreditarCaja(persona, bolsillo, delta,
      { tipo: 'ajuste', descripcion: `Ajuste manual: de ${actual} a ${nuevo}` });
    // Puede haber quedado en el valor previo si la base rechazó el cambio.
    const final = State.cajas[persona][bolsillo] || 0;
    Sheets.caja(persona, bolsillo, final);
    App.goTo('cajas');
    if (final === nuevo) toast(`Saldo de ${persona} — ${bolsillo} actualizado.`);
  }
};

window.Cajas = Cajas;
