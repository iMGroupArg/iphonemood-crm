const Dashboard = {
  periodo: 'mes', // hoy | semana | mes | mes-especifico | rango
  periodoMes: null,
  fechaDesde: null,
  fechaHasta: null,
  _mostrarRango: false,
  charts: {}, // referencias a instancias de Chart.js para poder destruirlas al re-renderizar

  // Devuelve un Set de fechas ISO (YYYY-MM-DD) que entran en el rango actual
  _enPeriodo(fechaISO) {
    if (!fechaISO) return true;
    const f = State.parseFecha(fechaISO) || new Date(0); f.setHours(0,0,0,0);
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    if (this.periodo === 'hoy') return f.getTime() === hoy.getTime();
    if (this.periodo === 'semana') { const d = new Date(hoy); d.setDate(d.getDate()-6); return f >= d; }
    if (this.periodo === 'mes') return f.getFullYear() === hoy.getFullYear() && f.getMonth() === hoy.getMonth();
    if (this.periodo === 'mes-especifico') return fechaISO.slice(0, 7) === this.periodoMes;
    if (this.periodo === 'rango') {
      const desde = this.fechaDesde ? State.parseFecha(this.fechaDesde) : null;
      const hasta = this.fechaHasta ? State.parseFecha(this.fechaHasta) : null;
      if (desde) desde.setHours(0,0,0,0);
      if (hasta) hasta.setHours(23,59,59,999);
      if (desde && f < desde) return false;
      if (hasta && f > hasta) return false;
      return true;
    }
    return true;
  },

  ventasDelPeriodo() {
    return State.ventas.filter(v => this._enPeriodo(v.fechaISO));
  },

  getDiasRango() {
    const hoy = new Date();
    const arr = [];
    if (this.periodo === 'hoy') {
      arr.push(new Date(hoy));
    } else if (this.periodo === 'semana') {
      for (let i = 6; i >= 0; i--) { const d = new Date(hoy); d.setDate(d.getDate()-i); arr.push(d); }
    } else if (this.periodo === 'mes') {
      const y = hoy.getFullYear(), m = hoy.getMonth();
      const diasMes = hoy.getDate();
      for (let i = 1; i <= diasMes; i++) arr.push(new Date(y, m, i));
    } else if (this.periodo === 'mes-especifico' && this.periodoMes) {
      // Un mes pasado elegido en el desplegable: el mes COMPLETO, de 1 al
      // último día. Sin esta rama caía al `else` de abajo y los gráficos
      // armaban los últimos 30 días desde hoy: los KPIs mostraban agosto y
      // los gráficos seguían con los días de septiembre, así que ninguna
      // venta caía dentro del rango y las series salían todas en cero.
      const [y, m] = this.periodoMes.split('-').map(Number);
      const ultimoDia = new Date(y, m, 0).getDate();   // día 0 del mes siguiente
      for (let i = 1; i <= ultimoDia; i++) arr.push(new Date(y, m - 1, i));
    } else {
      for (let i = 29; i >= 0; i--) { const d = new Date(hoy); d.setDate(d.getDate()-i); arr.push(d); }
    }
    return arr;
  },

  render() {
    const container = document.createElement('div');
    container.className = 'body-pad';

    const ventas = this.ventasDelPeriodo();
    const PERIODO_LABEL = { hoy: 'hoy', semana: 'esta semana', mes: 'este mes', rango: 'en el rango' };

    // Resultados comerciales solo del período — mismo criterio que Ventas
    // (ver Ventas.resultadoVenta()). "Comercial" es el margen de la venta en
    // sí: precio − costo, descontando lo que quedó sin cobrar en ventas
    // cerradas. El recargo de tarjeta NO va acá: es un efecto de la forma de
    // pago, no del producto, y se muestra en "Resultado financiero" junto al
    // spread de cueva — antes se sumaba en los dos lados a la vez (adentro
    // de margenReal, y de nuevo como diferencialTarjeta), duplicando esa
    // plata en el "Resultado total" y descuadrando contra el panel de Ventas.
    let diferencialTarjetaUSD = 0;
    const resultComercialUSD = ventas.reduce((a, v) => {
      const r = Ventas.resultadoVenta(v);
      diferencialTarjetaUSD += r.diferencial;
      return a + r.margenComercial;
    }, 0);
    const resultComercial = resultComercialUSD * State.refBlue;

    // Spread de cueva filtrado al mismo período — misma función que usa
    // Ventas (State.cambiosEnPeriodo), para que las dos pantallas den
    // siempre el mismo número ante el mismo período elegido.
    const periodoCueva = {
      tipo: this.periodo, mes: this.periodoMes,
      desde: this.fechaDesde, hasta: this.fechaHasta,
    };
    const cambiosPeriodo = State.cambiosEnPeriodo(periodoCueva);
    const spreadCuevaARS = State.spreadCuevaDelPeriodo(periodoCueva);
    const diferencialTarjetaARS = diferencialTarjetaUSD * State.refBlue;
    const resultFinanciero = spreadCuevaARS + diferencialTarjetaARS;
    const totalResultado = resultComercial + resultFinanciero;

    // Pasivo adelantos socios
    const adelantosPend = (State.adelantos || []).filter(a => a.estado === 'pendiente');
    const pasivoAdelantos = adelantosPend.reduce((s, a) => s + (a.moneda === 'USD' ? a.monto : a.monto / State.refBlue), 0);

    // Pendiente de cobro — TOTAL, no acotado al período: es plata que se debe
    // hoy, sin importar cuándo se vendió. Usa la misma fuente de verdad que
    // la pantalla Cuenta Corriente (ventas abiertas + deudas manuales), en vez
    // de recalcularlo acá.
    const clientesConDeudaCC = CuentaCorriente.getClientesConDeuda().length;
    const totalPorCobrarCC = CuentaCorriente.totalCuentasPorCobrar();

    const totalVentasUSD = ventas.reduce((a, v) => a + v.items.reduce((s, i) => s + i.precio, 0), 0);
    const repActivas = State.reparaciones.filter(r => !['entregado', 'rechazado', 'no_reparable'].includes(r.estado)).length;
    const repListas = State.reparaciones.filter(r => r.estado === 'listo').length;
    const stockCritico = State.modelosConUltimaUnidad().length;

    // KPIs reparaciones del período
    const ahora = new Date();
    const repPeriodo = State.reparaciones.filter(r => {
      if (!r.fecha) return false;
      const [d, m, y] = (r.fecha.includes('/') ? r.fecha.split('/') : [1, 1, ahora.getFullYear()]);
      return this._enPeriodo(new Date(y||ahora.getFullYear(), (m||1)-1, d||1).toISOString());
    });
    const ingresosRepPeriodo = repPeriodo.reduce((sum, r) => {
      return sum + (r.pagos || []).reduce((s, p) => s + (p.monto || 0), 0);
    }, 0);
    const entregadasConFecha = State.reparaciones.filter(r => r.estado === 'entregado' && r.fechaEntrega && r.fecha);
    const diasPromedio = entregadasConFecha.length ? Math.round(
      entregadasConFecha.reduce((sum, r) => {
        const parseDate = str => { const [d,m,y] = str.split('/'); return new Date(y||ahora.getFullYear(),(m||1)-1,d||1); };
        return sum + Math.max(0, (parseDate(r.fechaEntrega) - parseDate(r.fecha)) / 86400000);
      }, 0) / entregadasConFecha.length
    ) : null;
    const ventasAbiertas = ventas.filter(v => v.estado === 'abierta' && v.tipoVenta !== 'mercadolibre').length;
    const ticketPromedio = ventas.length ? totalVentasUSD / ventas.length : 0;

    let totalARSenCajas = 0, totalUSDenCajas = 0, totalUSDTenCajas = 0;
    Object.values(State.cajas).forEach(c => {
      totalARSenCajas += State.saldosPorMoneda(c).ARS;
      const sm = State.saldosPorMoneda(c);
      totalUSDenCajas += sm.USD;
      totalUSDTenCajas += sm.USDT;
    });
    const equivalenteTotalARS = totalARSenCajas + totalUSDenCajas * State.refBlue + totalUSDTenCajas * State.refUsdt;

    // En el celular se dibuja otra pantalla (tarjeta de saldo, pestañas, hojas), pero con los MISMOS números:
    // se calcularon arriba, una sola vez, y acá sólo se pasan.
    if (window.Movil) {   // mismo estilo en celular y en escritorio (cambia la distribución, ver movil.css)
      return this._renderMovil(container, {
        ventas, resultComercial, resultFinanciero, totalResultado, adelantosPend, pasivoAdelantos,
        clientesConDeudaCC, totalPorCobrarCC, totalVentasUSD, ticketPromedio, repActivas, repListas, stockCritico,
        repPeriodo, ingresosRepPeriodo, diasPromedio, entregadas: entregadasConFecha.length, ventasAbiertas,
        totalARSenCajas, totalUSDenCajas, totalUSDTenCajas, equivalenteTotalARS,
      });
    }

    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px">
        <div style="display:flex;gap:6px;flex-wrap:wrap" id="periodo-selector"></div>
        <div id="rango-custom" style="display:none;gap:6px;align-items:center;flex-wrap:wrap">
          <input type="date" id="dash-desde" style="font-size:12px;padding:6px 9px;border:1px solid var(--border-strong);border-radius:8px">
          <span style="font-size:11px;color:var(--text-secondary)">a</span>
          <input type="date" id="dash-hasta" style="font-size:12px;padding:6px 9px;border:1px solid var(--border-strong);border-radius:8px">
          <button class="btn btn-sm btn-primary" onclick="Dashboard.aplicarRango()">Aplicar</button>
        </div>
      </div>

      <div class="kpi-row" style="grid-template-columns:repeat(5,1fr);padding:0 0 14px 0;border:none">
        <div class="kpi"><label>Ventas del período</label><div class="val">${State.fmtUSD(totalVentasUSD)}</div><div class="sub">${ventas.length} ventas · ticket prom. ${State.fmtUSD(ticketPromedio)}</div></div>
        <div class="kpi"><label>Resultado comercial</label><div class="val" style="color:${resultComercial>=0?'var(--green)':'var(--red)'}">${resultComercial>=0?'+':''}${State.fmtUSD(resultComercial / State.refBlue)}</div><div class="sub">margen sobre ventas del período</div></div>
        <div class="kpi"><label>Resultado financiero</label><div class="val" style="color:${resultFinanciero>=0?'var(--green)':'var(--red)'}">${resultFinanciero>=0?'+':''}${State.fmtUSD(resultFinanciero / State.refBlue)}</div><div class="sub">spread cueva + diferencial tarjeta</div></div>
        <div class="kpi"><label>Resultado total</label><div class="val" style="color:var(--blue)">${totalResultado>=0?'+':''}${State.fmtUSD(totalResultado / State.refBlue)}</div><div class="sub">comercial + financiero</div></div>
        <div class="kpi" style="cursor:pointer" onclick="App.goTo('adelantos')">
          <label>Adelantos pendientes</label>
          <div class="val" style="color:${pasivoAdelantos>0?'var(--amber)':'var(--text)'}">${pasivoAdelantos>0?'-':''}${State.fmtUSD(pasivoAdelantos)}</div>
          <div class="sub">${adelantosPend.length > 0 ? `${adelantosPend.length} pendiente${adelantosPend.length>1?'s':''} · clic para ver` : 'Sin deuda con socios'}</div>
        </div>
      </div>

      <div class="kpi-row" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));padding:0 0 14px 0;border:none">
        <div class="kpi"><label>Equivalente total en caja</label><div class="val">${State.fmtUSD(equivalenteTotalARS / State.refBlue)}</div><div class="sub">ARS + USD + USDT a cotización actual</div></div>
        <div class="kpi" style="cursor:pointer" onclick="App.goTo('cuentacorriente')">
          <label>Pendiente de cobro</label>
          <div class="val" style="color:${totalPorCobrarCC>0?'var(--amber)':'var(--text)'}">${State.fmtUSD(totalPorCobrarCC)}</div>
          <div class="sub">${clientesConDeudaCC>0 ? `${clientesConDeudaCC} cliente${clientesConDeudaCC>1?'s':''} · clic para ver` : 'Sin cuentas abiertas'}</div>
        </div>
        ${(() => { const ml = State.meliPendienteLiberar(); return ml.ordenes ? `
        <div class="kpi" style="cursor:pointer" onclick="App.goTo('meli')">
          <label>A liberar de Mercado Libre</label>
          <div class="val" style="color:var(--amber)">${State.fmtARS(ml.ars)}</div>
          <div class="sub">${ml.ordenes} orden${ml.ordenes>1?'es':''}${ml.sinDato ? ` · ${ml.sinDato} sin importe confirmado` : ''} · plata en camino</div>
        </div>` : ''; })()}
        <div class="kpi"><label>Ventas con saldo pendiente</label><div class="val" style="color:${ventasAbiertas?'var(--amber)':'var(--green)'}">${ventasAbiertas}</div><div class="sub">requieren seguimiento de cobro</div></div>
        <div class="kpi"><label>Stock con alerta</label><div class="val" style="color:${stockCritico?'var(--red)':'var(--green)'}">${stockCritico}</div><div class="sub">modelos con la última unidad</div></div>
        <div class="kpi"><label>Reparaciones del período</label><div class="val">${repPeriodo.length}</div><div class="sub">${repActivas} activa(s) · ${repListas} lista(s)</div></div>
      </div>

      <div style="font-size:11px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px"><i class="ti ti-tool" style="margin-right:4px"></i>Reparaciones</div>
      <div class="kpi-row" style="grid-template-columns:repeat(4,1fr);padding:0 0 14px 0;border:none">
        <div class="kpi"><label>Órdenes activas</label><div class="val" style="color:${repActivas?'var(--blue)':'var(--text-secondary)'}">${repActivas}</div><div class="sub">en proceso ahora</div></div>
        <div class="kpi"><label>Listas para entregar</label><div class="val" style="color:${repListas?'var(--green)':'var(--text-secondary)'}">${repListas}</div><div class="sub">${repListas?'pendientes de retiro':'al día'}</div></div>
        <div class="kpi"><label>Ingresos reparaciones</label><div class="val">${State.fmtUSD(ingresosRepPeriodo)}</div><div class="sub">pagos cobrados en el período</div></div>
        <div class="kpi"><label>Días promedio resolución</label><div class="val">${diasPromedio !== null ? diasPromedio + ' d' : '—'}</div><div class="sub">${entregadasConFecha.length} reparacion(es) entregadas</div></div>
      </div>

      <div class="card">
        <div class="card-title"><i class="ti ti-chart-line"></i> Evolución de ventas — monto y beneficio</div>
        <div style="position:relative;height:240px"><canvas id="chart-evolucion"></canvas></div>
      </div>

      <div style="display:grid;grid-template-columns:1.3fr 1fr;gap:14px" class="dash-grid-2">
        <div class="card">
          <div class="card-title"><i class="ti ti-chart-bar"></i> Monto vendido vs beneficio por día</div>
          <div style="position:relative;height:220px"><canvas id="chart-monto-beneficio"></canvas></div>
        </div>
        <div class="card">
          <div class="card-title"><i class="ti ti-chart-pie"></i> Distribución de saldo por persona</div>
          <div style="position:relative;height:220px"><canvas id="chart-personas"></canvas></div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px" class="dash-grid-2">
        <div class="card">
          <div class="card-title"><i class="ti ti-wallet"></i> Saldo consolidado de cajas</div>
          <table>
            <tr><th>Persona</th><th>ARS</th><th>USD</th><th>USDT</th></tr>
            ${State.personas.map(p => {
              const c = State.cajas[p] || {};
              const sm = State.saldosPorMoneda(c);
              const ars = sm.ARS, usd = sm.USD, usdt = sm.USDT;
              return `<tr><td><div style="display:flex;align-items:center;gap:6px"><div class="av">${p.substring(0,2).toUpperCase()}</div>${p}</div></td><td>${State.fmtARS(ars)}</td><td>${State.fmtUSD(usd)}</td><td>${usdt.toLocaleString('es-AR')}</td></tr>`;
            }).join('')}
            <tr style="font-weight:600"><td>Total</td><td>${State.fmtARS(totalARSenCajas)}</td><td>${State.fmtUSD(totalUSDenCajas)}</td><td>${totalUSDTenCajas.toLocaleString('es-AR')}</td></tr>
          </table>
        </div>

        <div class="card">
          <div class="card-title"><i class="ti ti-alert-triangle"></i> Alertas</div>
          <table>
            <tr><th>Tipo</th><th>Detalle</th></tr>
            ${stockCritico > 0 ? `<tr><td><span class="badge b-red">Stock</span></td><td>${stockCritico} modelo(s) con la última unidad disponible</td></tr>` : ''}
            ${repListas > 0 ? `<tr><td><span class="badge b-green">Reparación</span></td><td>${repListas} equipo(s) listo(s) para entregar</td></tr>` : ''}
            ${repActivas > 0 ? `<tr><td><span class="badge b-amber">Reparación</span></td><td>${repActivas} orden(es) en curso</td></tr>` : ''}
            ${ventasAbiertas > 0 ? `<tr><td><span class="badge b-amber">Venta</span></td><td>${ventasAbiertas} venta(s) con saldo pendiente</td></tr>` : ''}
            ${(stockCritico===0 && repListas===0 && repActivas===0 && ventasAbiertas===0) ? '<tr><td colspan="2" style="color:var(--text-secondary)">Sin alertas por el momento</td></tr>' : ''}
          </table>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px" class="dash-grid-2">
        <div class="card">
          <div class="card-title"><i class="ti ti-receipt"></i> Últimas ventas</div>
          <table>
            <tr><th>Cliente</th><th>Detalle</th><th>Total</th><th>Estado</th></tr>
            ${State.ventas.slice(0, 5).map(v => {
              const total = v.items.reduce((s, i) => s + i.precio, 0);
              return `<tr><td>${State.esc(v.cliente)}</td><td>${(v.items[0]?.nombre || '—').substring(0,28)}${v.items.length>1?` +${v.items.length-1}`:''}</td><td>${State.fmtUSD(total)}</td><td><span class="badge ${v.estado==='cerrada'?'b-green':'b-amber'}">${v.estado==='cerrada'?'Cerrada':'Abierta'}</span></td></tr>`;
            }).join('') || '<tr><td colspan="4" style="color:var(--text-secondary)">Todavía no hay ventas cargadas</td></tr>'}
          </table>
        </div>
        <div class="card">
          <div class="card-title"><i class="ti ti-tool"></i> Reparaciones activas</div>
          <table>
            <tr><th>Equipo</th><th>Cliente</th><th>Estado</th></tr>
            ${State.reparaciones.filter(r=>!['entregado','rechazado','no_reparable'].includes(r.estado)).slice(0,5).map(r => `
              <tr><td>${r.equipo}</td><td>${r.cliente}</td><td><span class="badge b-blue">${Reparaciones.ESTADO_LABEL[r.estado]}</span></td></tr>
            `).join('') || '<tr><td colspan="3" style="color:var(--text-secondary)">No hay reparaciones activas</td></tr>'}
          </table>
        </div>
      </div>
    `;

    setTimeout(() => {
      this.renderPeriodoSelector();
      this.renderCharts();
    }, 0);

    return container;
  },

  // ═══════════ CELULAR ═══════════
  _tabM: 'resumen',

  _etqPeriodoM() {
    if (this.periodo === 'hoy') return 'Hoy';
    if (this.periodo === 'semana') return 'Esta semana';
    if (this.periodo === 'mes') return 'Este mes';
    if (this.periodo === 'mes-especifico' && this.periodoMes) {
      const [y, m] = this.periodoMes.split('-').map(Number);
      return new Date(y, m - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    }
    if (this.periodo === 'rango' && this.fechaDesde && this.fechaHasta) return `${this.fechaDesde.slice(5)} → ${this.fechaHasta.slice(5)}`;
    return 'Este mes';
  },

  _renderMovil(container, d) {
    const esc = !(window.Movil && Movil.activo());   // escritorio: todo a la vista, sin pestañas
    container.className = 'm-dash' + (esc ? ' escritorio' : '');
    const e = (x) => State.esc(String(x ?? ''));
    const fU = (n) => State.fmtUSD(n);
    const sg = (n) => (n >= 0 ? '+' : '');
    const nombre = e(((window.Auth && Auth.usuario && Auth.usuario.nombre) || '').split(' ')[0]);
    const etqPer = e(this._etqPeriodoM());
    const rapido = this.periodo === 'hoy' || this.periodo === 'semana' || this.periodo === 'mes';
    const kpi = (etq, valor, sub, color, onclick) => `
      <div class="m-kpi${onclick ? ' tap' : ''}" ${onclick ? `onclick="${onclick}" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}"` : ''}>
        <label>${etq}</label><div class="v" ${color ? `style="color:${color}"` : ''}>${valor}</div><div class="s">${sub}</div>
      </div>`;
    const ml = State.meliPendienteLiberar();

    const principales = [
      kpi('Ventas del período', fU(d.totalVentasUSD), `${d.ventas.length} ventas · ticket prom. ${fU(d.ticketPromedio)}`),
      kpi('Resultado total', `${sg(d.totalResultado)}${fU(d.totalResultado / State.refBlue)}`, 'comercial + financiero', 'var(--blue)'),
      kpi('Resultado comercial', `${sg(d.resultComercial)}${fU(d.resultComercial / State.refBlue)}`, 'margen sobre ventas del período', d.resultComercial >= 0 ? 'var(--green)' : 'var(--red)'),
      kpi('Resultado financiero', `${sg(d.resultFinanciero)}${fU(d.resultFinanciero / State.refBlue)}`, 'spread cueva + diferencial tarjeta', d.resultFinanciero >= 0 ? 'var(--green)' : 'var(--red)'),
    ].join('');

    const masIndicadores = [
      kpi('Pendiente de cobro', fU(d.totalPorCobrarCC), d.clientesConDeudaCC > 0 ? `${d.clientesConDeudaCC} cliente${d.clientesConDeudaCC > 1 ? 's' : ''} · tocá para ver` : 'Sin cuentas abiertas', d.totalPorCobrarCC > 0 ? 'var(--amber)' : '', "App.goTo('cuentacorriente')"),
      kpi('Adelantos pendientes', `${d.pasivoAdelantos > 0 ? '-' : ''}${fU(d.pasivoAdelantos)}`, d.adelantosPend.length > 0 ? `${d.adelantosPend.length} pendiente${d.adelantosPend.length > 1 ? 's' : ''} · tocá para ver` : 'Sin deuda con socios', d.pasivoAdelantos > 0 ? 'var(--amber)' : '', "App.goTo('adelantos')"),
      ml.ordenes ? kpi('A liberar de Mercado Libre', State.fmtARS(ml.ars), `${ml.ordenes} orden${ml.ordenes > 1 ? 'es' : ''}${ml.sinDato ? ` · ${ml.sinDato} sin importe confirmado` : ''} · plata en camino`, 'var(--amber)', "App.goTo('meli')") : '',
      kpi('Ventas con saldo pendiente', d.ventasAbiertas, 'requieren seguimiento de cobro', d.ventasAbiertas ? 'var(--amber)' : 'var(--green)'),
      kpi('Stock con alerta', d.stockCritico, 'modelos con la última unidad', d.stockCritico ? 'var(--red)' : 'var(--green)', "App.goTo('stock')"),
      kpi('Reparaciones del período', d.repPeriodo.length, `${d.repActivas} activa(s) · ${d.repListas} lista(s)`),
      kpi('Órdenes activas', d.repActivas, 'en proceso ahora', d.repActivas ? 'var(--blue)' : 'var(--text-secondary)', "App.goTo('reparaciones')"),
      kpi('Listas para entregar', d.repListas, d.repListas ? 'pendientes de retiro' : 'al día', d.repListas ? 'var(--green)' : 'var(--text-secondary)'),
      kpi('Ingresos reparaciones', fU(d.ingresosRepPeriodo), 'pagos cobrados en el período'),
      kpi('Días promedio resolución', d.diasPromedio !== null ? d.diasPromedio + ' d' : '—', `${d.entregadas} reparacion(es) entregadas`),
    ].join('');

    // Últimas ventas
    const ultimas = State.ventas.slice(0, 5).map((v) => {
      const total = v.items.reduce((s, i) => s + i.precio, 0);
      const abierta = v.estado === 'abierta';
      return `<button type="button" class="m-item" onclick="Dashboard.abrirVentaMovil(${v.id})">
        <span class="m-item-ico ${abierta ? 'ambar' : 'verde'}"><i class="ti ti-receipt"></i></span>
        <span class="m-item-cuerpo"><span class="m-item-t">${e(v.cliente)}</span>
          <span class="m-item-s" style="display:block">${e((v.items[0]?.nombre || '—').substring(0, 34))}${v.items.length > 1 ? ` +${v.items.length - 1}` : ''}</span></span>
        <span class="m-item-der"><span class="m-item-precio" style="display:block">${fU(total)}</span>
          <span class="m-item-sub">${abierta ? 'saldo pendiente' : 'cobrada'}</span></span>
      </button>`;
    }).join('') || '<div class="m-vacio">Todavía no hay ventas cargadas</div>';

    // Cajas por persona
    const cajas = State.personas.map((p) => {
      const sm = State.saldosPorMoneda(State.cajas[p] || {});
      return `<div class="m-item" style="cursor:default">
        <span class="m-item-ico"><b style="font-size:15px">${e(p.substring(0, 2).toUpperCase())}</b></span>
        <span class="m-item-cuerpo"><span class="m-item-t">${e(p)}</span>
          <span class="m-item-s" style="display:block">${State.fmtARS(sm.ARS)} · ${sm.USDT.toLocaleString('es-AR')} USDT</span></span>
        <span class="m-item-der"><span class="m-item-precio" style="display:block">${fU(sm.USD)}</span><span class="m-item-sub">en dólares</span></span>
      </div>`;
    }).join('');

    // Pendientes: alertas + reparaciones activas
    const alerta = (ico, color, titulo, sub, destino) => `<button type="button" class="m-item" onclick="App.goTo('${destino}')">
      <span class="m-item-ico ${color}"><i class="ti ${ico}"></i></span>
      <span class="m-item-cuerpo"><span class="m-item-t">${titulo}</span><span class="m-item-s" style="display:block">${sub}</span></span>
      <i class="ti ti-chevron-right" style="color:var(--text-tertiary)"></i></button>`;
    const alertas = [
      d.stockCritico > 0 ? alerta('ti-box', 'rojo', `${d.stockCritico} modelo(s) con la última unidad`, 'Stock', 'stock') : '',
      d.repListas > 0 ? alerta('ti-circle-check', 'verde', `${d.repListas} equipo(s) listo(s) para entregar`, 'Reparación', 'reparaciones') : '',
      d.repActivas > 0 ? alerta('ti-tool', 'ambar', `${d.repActivas} orden(es) en curso`, 'Reparación', 'reparaciones') : '',
      d.ventasAbiertas > 0 ? alerta('ti-receipt', 'ambar', `${d.ventasAbiertas} venta(s) con saldo pendiente`, 'Venta', 'ventas') : '',
    ].join('') || '<div class="m-vacio">Sin alertas por el momento</div>';
    const reps = State.reparaciones.filter((r) => !['entregado', 'rechazado', 'no_reparable'].includes(r.estado)).slice(0, 5).map((r) =>
      `<button type="button" class="m-item" onclick="App.goTo('reparaciones')">
        <span class="m-item-ico"><i class="ti ti-device-mobile"></i></span>
        <span class="m-item-cuerpo"><span class="m-item-t">${e(r.equipo)}</span><span class="m-item-s" style="display:block">${e(r.cliente)}</span></span>
        <span class="badge b-blue">${e(Reparaciones.ESTADO_LABEL[r.estado] || r.estado)}</span></button>`).join('') || '<div class="m-vacio">No hay reparaciones activas</div>';

    const t = this._tabM;
    const panel = (k, html) => `<div data-panel="${k}" style="display:${esc || t === k ? 'flex' : 'none'};flex-direction:column;gap:14px">${html}</div>`;
    container.innerHTML = `
      <section class="m-hero" aria-label="Saldo en cajas">
        <div class="m-hero-sup"><span>Hola${nombre ? ', ' + nombre : ''} 👋</span>
          <button type="button" class="m-hero-per" onclick="Dashboard.abrirPeriodoMovil()">${etqPer} ▾</button></div>
        <div class="m-hero-etq">Equivalente total en caja</div>
        <div class="m-hero-monto">${fU(d.equivalenteTotalARS / State.refBlue)}</div>
        <div class="m-hero-sub"><span>${State.fmtARS(d.totalARSenCajas)}</span><span>${fU(d.totalUSDenCajas)}</span><span>${d.totalUSDTenCajas.toLocaleString('es-AR')} USDT</span></div>
        <div class="m-hero-delta">Resultado ${etqPer.toLowerCase()}: <b>${sg(d.totalResultado)}${fU(d.totalResultado / State.refBlue)}</b></div>
      </section>
      <div class="m-acciones">
        <button type="button" class="m-accion" onclick="App.goTo('ventas');setTimeout(()=>Ventas.openNew(),50)"><i class="ti ti-plus"></i> Nueva venta</button>
        <button type="button" class="m-accion" onclick="App.goTo('stock')"><i class="ti ti-box"></i> Stock</button>
      </div>
      <div class="m-chips" role="group" aria-label="Período">
        ${[['hoy', 'Hoy'], ['semana', 'Semana'], ['mes', 'Mes']].map(([k, l]) => `<button type="button" class="m-chip azul ${this.periodo === k ? 'activo' : ''}" onclick="Dashboard.setPeriodo('${k}')">${l}</button>`).join('')}
        <button type="button" class="m-chip azul ${rapido ? '' : 'activo'}" onclick="Dashboard.abrirPeriodoMovil()">${rapido ? 'Otro período…' : etqPer}</button>
      </div>
      <div class="m-seg" role="tablist">
        ${[['resumen', 'Resumen'], ['ventas', 'Ventas'], ['cajas', 'Cajas'], ['pendientes', 'Pendientes']].map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${t === k}" class="${t === k ? 'activo' : ''}" onclick="Dashboard.tabMovil('${k}')">${l}</button>`).join('')}
      </div>
      ${panel('resumen', `
        <div class="m-kpis">${principales}</div>
        <details class="m-mas-ind"${esc ? ' open' : ''}><summary>Ver más indicadores</summary><div class="m-kpis">${masIndicadores}</div></details>
        <div class="m-card"><h3><i class="ti ti-chart-line"></i> Evolución de ventas</h3><div style="position:relative;height:230px"><canvas id="chart-evolucion"></canvas></div></div>`)}
      ${panel('ventas', `
        <div class="m-sec">Últimas ventas <small role="button" tabindex="0" onclick="App.goTo('ventas')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}">Ver todas</small></div>
        <div class="m-list">${ultimas}</div>
        <div class="m-card"><h3><i class="ti ti-chart-bar"></i> Monto vendido vs beneficio por día</h3><div style="position:relative;height:230px"><canvas id="chart-monto-beneficio"></canvas></div></div>`)}
      ${panel('cajas', `
        <div class="m-sec">Saldo por persona <small role="button" tabindex="0" onclick="App.goTo('cajas')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}">Ver cajas</small></div>
        <div class="m-list">${cajas}</div>
        <div class="m-card"><h3><i class="ti ti-chart-pie"></i> Distribución de saldo por persona</h3><div style="position:relative;height:230px"><canvas id="chart-personas"></canvas></div></div>`)}
      ${panel('pendientes', `
        <div class="m-sec">Alertas</div><div class="m-list">${alertas}</div>
        <div class="m-sec">Reparaciones activas <small role="button" tabindex="0" onclick="App.goTo('reparaciones')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}">Ver todas</small></div><div class="m-list">${reps}</div>`)}
    `;
    setTimeout(() => this.renderCharts(), 0);
    return container;
  },

  // Desde Inicio se abre la venta tocada, ya dentro de la pantalla Ventas (misma estética y botón Atrás coherente).
  abrirVentaMovil(id) {
    App.goTo('ventas');
    setTimeout(() => Ventas.viewSale(id), 80);
  },

  tabMovil(k) {
    this._tabM = k;
    document.querySelectorAll('.m-seg button').forEach((b) => { const on = b.dataset.tab === k; b.classList.toggle('activo', on); b.setAttribute('aria-selected', on); });
    document.querySelectorAll('[data-panel]').forEach((p) => { p.style.display = p.dataset.panel === k ? 'flex' : 'none'; });
    this.renderCharts();   // el gráfico de esa pestaña se arma ahora que está a la vista
  },

  // Hoja para elegir un período que no está en los chips: mes puntual o rango de fechas.
  abrirPeriodoMovil() {
    const meses = Ventas._mesesDisponibles().map((m) => {
      const [y, mo] = m.split('-');
      return [m, new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('es-AR', { month: 'short', year: '2-digit' })];
    });
    const cuerpo = `
      <div class="m-mas-etq">Mes puntual</div>
      <div class="m-chips" style="flex-wrap:wrap;overflow:visible;margin:0 0 14px;padding:0">
        ${meses.map(([m, l]) => `<button type="button" class="m-chip azul ${this.periodo === 'mes-especifico' && this.periodoMes === m ? 'activo' : ''}" data-mes="${m}">${l}</button>`).join('') || '<span class="m-vacio">Sin meses con ventas</span>'}
      </div>
      <div class="m-mas-etq">Rango de fechas</div>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px">
        <input type="date" id="dash-desde" value="${this.fechaDesde || ''}" style="flex:1"><span style="color:var(--text-secondary)">a</span>
        <input type="date" id="dash-hasta" value="${this.fechaHasta || ''}" style="flex:1">
      </div>`;
    const h = Sheet.abrir({ titulo: 'Período', cuerpo, pie: '<button type="button" class="btn btn-primary" data-aplicar>Aplicar rango</button>' });
    h.cuerpo.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-mes]');
      if (b) { const m = b.dataset.mes; h.cerrar(); setTimeout(() => this.setPeriodoMes(m), 280); }
    });
    h.el.querySelector('[data-aplicar]').addEventListener('click', () => {
      const desde = document.getElementById('dash-desde').value, hasta = document.getElementById('dash-hasta').value;
      if (!desde || !hasta) { if (typeof toast === 'function') toast('Elegí las dos fechas antes de aplicar.'); return; }
      h.cerrar(); setTimeout(() => this.aplicarRango(desde, hasta), 280);
    });
  },

  renderPeriodoSelector() {
    const opciones = [['hoy', 'Hoy'], ['semana', 'Esta semana'], ['mes', 'Este mes'], ['rango', 'Rango libre']];
    const mostrarRango = this._mostrarRango || this.periodo === 'rango';
    // Mismo selector de mes que usa Ventas, con la misma lista de meses:
    // eligiendo el mismo mes en las dos pantallas, el filtro es idéntico
    // y los números tienen que coincidir siempre.
    const mesesOpts = Ventas._mesesDisponibles().map(m => {
      const [y, mo] = m.split('-');
      const label = new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('es-AR', { month: 'short', year: '2-digit' });
      return `<option value="${m}" ${this.periodoMes === m ? 'selected' : ''}>${label}</option>`;
    }).join('');
    const selector = document.getElementById('periodo-selector');
    if (!selector) return;
    selector.innerHTML = opciones.map(([k, l]) =>
      `<button class="btn btn-sm ${(k === 'rango' ? mostrarRango : this.periodo === k) ? 'btn-primary' : ''}" onclick="Dashboard.setPeriodo('${k}')">${l}</button>`
    ).join('')
    + `<select id="dash-mes-selector" onchange="Dashboard.setPeriodoMes(this.value)" style="font-size:12px;padding:6px 9px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg-secondary);color:var(--text);${this.periodo === 'mes-especifico' ? 'border-color:var(--blue);outline:none' : ''}">
        <option value="">Mes específico…</option>
        ${mesesOpts}
      </select>`;
    document.getElementById('rango-custom').style.display = mostrarRango ? 'flex' : 'none';
  },

  setPeriodo(p) {
    if (p === 'rango') {
      // Solo mostramos los campos de fecha: el filtro no cambia hasta que
      // se apliquen las dos fechas (ver aplicarRango). Antes, con solo
      // tocar el botón, el período ya quedaba en 'rango' con las fechas
      // vacías — y como filtro vacío equivale a "sin filtro", mostraba
      // TODO el historial (no solo el mes que se quería ver) sin avisar.
      this._mostrarRango = true;
      this.renderPeriodoSelector();
      return;
    }
    this._mostrarRango = false;
    this.periodo = p;
    this.periodoMes = null;
    App.goTo('dashboard');
  },

  setPeriodoMes(mes) {
    if (!mes) return;
    this.periodo = 'mes-especifico';
    this.periodoMes = mes;
    this._mostrarRango = false;
    App.goTo('dashboard');
  },

  aplicarRango(desde, hasta) {
    // En el celular las fechas vienen de la hoja, que ya se cerró cuando se aplica.
    this.fechaDesde = desde !== undefined ? desde : document.getElementById('dash-desde').value;
    this.fechaHasta = hasta !== undefined ? hasta : document.getElementById('dash-hasta').value;
    if (!this.fechaDesde || !this.fechaHasta) {
      if (typeof toast === 'function') toast('Elegí las dos fechas antes de aplicar.');
      return;
    }
    const ms = new Date(this.fechaHasta) - new Date(this.fechaDesde);
    this.periodo = 'rango';
    this._rangoDias = Math.max(1, Math.round(ms / 86400000) + 1);
    this._mostrarRango = false;
    App.goTo('dashboard');
  },

  construirSerieDiaria() {
    const dias = this.periodo === 'rango' && this._rangoDias
      ? Array.from({ length: this._rangoDias }, (_, i) => { const d = new Date(this.fechaDesde); d.setDate(d.getDate() + i); return d; })
      : this.getDiasRango();

    const n = dias.length;
    const labels = dias.map(d => d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }));

    const montosPorDia = new Array(n).fill(0);
    const beneficiosPorDia = new Array(n).fill(0);

    // Clave ISO para cada día del rango
    const isoKeys = dias.map(d => d.toISOString().slice(0, 10));

    this.ventasDelPeriodo().forEach(v => {
      if (!v.fechaISO) return;
      const key = v.fechaISO.slice(0, 10);
      const idx = isoKeys.indexOf(key);
      if (idx === -1) return;
      const monto = v.items.reduce((s, i) => s + i.precio, 0);
      const costo = v.items.reduce((s, i) => s + (i.costo || 0), 0);
      montosPorDia[idx] += monto * State.refBlue;
      beneficiosPorDia[idx] += (monto - costo) * State.refBlue;
    });

    return { labels, montos: montosPorDia, beneficios: beneficiosPorDia };
  },

  renderCharts() {
    Object.values(this.charts).forEach(c => c && c.destroy());
    this.charts = {};

    const serie = this.construirSerieDiaria();
    // Un canvas dentro de una pestaña oculta mide 0 y el gráfico queda mal dimensionado: se arma al mostrarse.
    const visible = (id) => { const e = document.getElementById(id); return e && e.offsetParent !== null ? e : null; };
    const ctxEvol = visible('chart-evolucion');
    if (ctxEvol) {
      this.charts.evolucion = new Chart(ctxEvol, {
        type: 'line',
        data: {
          labels: serie.labels,
          datasets: [
            { label: 'Monto vendido', data: serie.montos, borderColor: '#0A84FF', backgroundColor: 'rgba(24,95,165,0.08)', fill: true, tension: 0.35, pointRadius: 2 },
            { label: 'Beneficio', data: serie.beneficios, borderColor: '#30D158', backgroundColor: 'rgba(59,109,17,0.08)', fill: true, tension: 0.35, pointRadius: 2 },
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } },
          scales: {
            y: { ticks: { callback: v => '$' + (v / 1000).toFixed(0) + 'k', font: { size: 10 }, color: '#AEAEB2' }, grid: { color: 'rgba(255,255,255,.08)' } },
            x: { ticks: { font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, grid: { display: false } }
          }
        }
      });
    }

    const ctxMB = visible('chart-monto-beneficio');
    if (ctxMB) {
      this.charts.montoBeneficio = new Chart(ctxMB, {
        type: 'bar',
        data: {
          labels: serie.labels,
          datasets: [
            { label: 'Monto vendido', data: serie.montos, backgroundColor: 'rgba(10,132,255,.15)', borderColor: '#0A84FF', borderWidth: 1 },
            { label: 'Beneficio', data: serie.beneficios, backgroundColor: 'rgba(48,209,88,.15)', borderColor: '#30D158', borderWidth: 1 },
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } },
          scales: {
            y: { ticks: { callback: v => '$' + (v / 1000).toFixed(0) + 'k', font: { size: 10 }, color: '#AEAEB2' }, grid: { color: 'rgba(255,255,255,.08)' } },
            x: { ticks: { font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }, grid: { display: false } }
          }
        }
      });
    }

    const ctxP = visible('chart-personas');
    if (ctxP) {
      const equivPorPersona = State.personas.map(p => {
        const c = State.cajas[p] || {};
        const sm = State.saldosPorMoneda(c);
        return sm.ARS + sm.USD*State.refBlue + sm.USDT*State.refUsdt;
      });
      const colores = ['#0A84FF', '#30D158', '#854F0B', '#3C3489', '#085041'];
      this.charts.personas = new Chart(ctxP, {
        type: 'doughnut',
        data: {
          labels: State.personas,
          datasets: [{ data: equivPorPersona, backgroundColor: colores.slice(0, State.personas.length), borderWidth: 2, borderColor: 'rgba(0,0,0,.3)' }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
            tooltip: { callbacks: { label: ctx => `${ctx.label}: ${State.fmtUSD(ctx.raw / State.refBlue)}` } }
          }
        }
      });
    }
  }
};


window.Dashboard = Dashboard;
