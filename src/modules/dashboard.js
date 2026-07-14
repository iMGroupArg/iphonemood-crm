const Dashboard = {
  periodo: 'mes', // hoy | semana | mes | rango
  fechaDesde: null,
  fechaHasta: null,
  charts: {}, // referencias a instancias de Chart.js para poder destruirlas al re-renderizar

  // Devuelve un Set de fechas ISO (YYYY-MM-DD) que entran en el rango actual
  _enPeriodo(fechaISO) {
    if (!fechaISO) return true;
    const f = new Date(fechaISO); f.setHours(0,0,0,0);
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    if (this.periodo === 'hoy') return f.getTime() === hoy.getTime();
    if (this.periodo === 'semana') { const d = new Date(hoy); d.setDate(d.getDate()-6); return f >= d; }
    if (this.periodo === 'mes') { const d = new Date(hoy); d.setDate(d.getDate()-29); return f >= d; }
    if (this.periodo === 'rango') {
      const desde = this.fechaDesde ? new Date(this.fechaDesde) : null;
      const hasta = this.fechaHasta ? new Date(this.fechaHasta) : null;
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
    let dias = 30;
    if (this.periodo === 'hoy') dias = 1;
    else if (this.periodo === 'semana') dias = 7;
    else if (this.periodo === 'mes') dias = 30;
    const arr = [];
    for (let i = dias - 1; i >= 0; i--) {
      const d = new Date(hoy);
      d.setDate(d.getDate() - i);
      arr.push(d);
    }
    return arr;
  },

  render() {
    const container = document.createElement('div');
    container.className = 'body-pad';

    const ventas = this.ventasDelPeriodo();
    const PERIODO_LABEL = { hoy: 'hoy', semana: 'esta semana', mes: 'este mes', rango: 'en el rango' };

    // Resultados comerciales solo del período
    const resultComercial = ventas.reduce((a, v) => {
      const totalVenta = v.items.reduce((s, i) => s + i.precio, 0);
      const totalCosto = v.items.reduce((s, i) => s + (i.costo||0), 0);
      return a + (totalVenta - totalCosto) * State.refBlue;
    }, 0);

    // Spread de cueva y diferencial de tarjeta: son globales (no dependen del período de ventas)
    const spreadCueva = State.resultadoFinancieroMes();
    const diferencialTarjetaUSD = ventas.reduce((s, v) => {
      const totalVenta = v.items.reduce((a, i) => a + i.precio, 0);
      const totalPagado = (v.pagos||[]).reduce((a, p) => a + p.monto, 0) + (v.tradeIn?.valor||0);
      return s + Math.max(0, totalPagado - totalVenta);
    }, 0);
    const diferencialTarjetaARS = diferencialTarjetaUSD * State.refBlue;
    const resultFinanciero = spreadCueva + diferencialTarjetaARS;
    const totalResultado = resultComercial + resultFinanciero;

    const totalVentasUSD = ventas.reduce((a, v) => a + v.items.reduce((s, i) => s + i.precio, 0), 0);
    const repActivas = State.reparaciones.filter(r => !['entregado', 'rechazado', 'no_reparable'].includes(r.estado)).length;
    const repListas = State.reparaciones.filter(r => r.estado === 'listo').length;
    const stockCritico = State.stock.filter(s => State.getStockStatus(s) !== 'ok').length;

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
    const ventasAbiertas = ventas.filter(v => v.estado === 'abierta').length;
    const ticketPromedio = ventas.length ? totalVentasUSD / ventas.length : 0;

    let totalARSenCajas = 0, totalUSDenCajas = 0, totalUSDTenCajas = 0;
    Object.values(State.cajas).forEach(c => {
      totalARSenCajas += (c['ARS cash'] || 0) + (c['ARS transferencia'] || 0);
      totalUSDenCajas += (c['USD cash'] || 0) + (c['USD transferencia'] || 0);
      totalUSDTenCajas += (c['USDT'] || 0);
    });
    const equivalenteTotalARS = totalARSenCajas + totalUSDenCajas * State.refBlue + totalUSDTenCajas * State.refUsdt;

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

      <div class="kpi-row" style="grid-template-columns:repeat(4,1fr);padding:0 0 14px 0;border:none">
        <div class="kpi"><label>Ventas del período</label><div class="val">${State.fmtUSD(totalVentasUSD)}</div><div class="sub">${ventas.length} ventas · ticket prom. ${State.fmtUSD(ticketPromedio)}</div></div>
        <div class="kpi"><label>Resultado comercial</label><div class="val" style="color:${resultComercial>=0?'var(--green)':'var(--red)'}">${resultComercial>=0?'+':''}${State.fmtUSD(resultComercial / State.refBlue)}</div><div class="sub">margen sobre ventas del período</div></div>
        <div class="kpi"><label>Resultado financiero</label><div class="val" style="color:${resultFinanciero>=0?'var(--green)':'var(--red)'}">${resultFinanciero>=0?'+':''}${State.fmtUSD(resultFinanciero / State.refBlue)}</div><div class="sub">spread cueva + diferencial tarjeta</div></div>
        <div class="kpi"><label>Resultado total</label><div class="val" style="color:var(--blue)">${totalResultado>=0?'+':''}${State.fmtUSD(totalResultado / State.refBlue)}</div><div class="sub">comercial + financiero</div></div>
      </div>

      <div class="kpi-row" style="grid-template-columns:repeat(4,1fr);padding:0 0 14px 0;border:none">
        <div class="kpi"><label>Equivalente total en caja</label><div class="val">${State.fmtUSD(equivalenteTotalARS / State.refBlue)}</div><div class="sub">ARS + USD + USDT a cotización actual</div></div>
        <div class="kpi"><label>Ventas con saldo pendiente</label><div class="val" style="color:${ventasAbiertas?'var(--amber)':'var(--green)'}">${ventasAbiertas}</div><div class="sub">requieren seguimiento de cobro</div></div>
        <div class="kpi"><label>Stock con alerta</label><div class="val" style="color:${stockCritico?'var(--red)':'var(--green)'}">${stockCritico}</div><div class="sub">productos bajos o agotados</div></div>
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
              const ars = (c['ARS cash']||0)+(c['ARS transferencia']||0);
              const usd = (c['USD cash']||0)+(c['USD transferencia']||0);
              const usdt = c['USDT']||0;
              return `<tr><td><div style="display:flex;align-items:center;gap:6px"><div class="av">${p.substring(0,2).toUpperCase()}</div>${p}</div></td><td>${State.fmtARS(ars)}</td><td>${State.fmtUSD(usd)}</td><td>${usdt.toLocaleString('es-AR')}</td></tr>`;
            }).join('')}
            <tr style="font-weight:600"><td>Total</td><td>${State.fmtARS(totalARSenCajas)}</td><td>${State.fmtUSD(totalUSDenCajas)}</td><td>${totalUSDTenCajas.toLocaleString('es-AR')}</td></tr>
          </table>
        </div>

        <div class="card">
          <div class="card-title"><i class="ti ti-alert-triangle"></i> Alertas</div>
          <table>
            <tr><th>Tipo</th><th>Detalle</th></tr>
            ${stockCritico > 0 ? `<tr><td><span class="badge b-red">Stock</span></td><td>${stockCritico} producto(s) con stock bajo o agotado</td></tr>` : ''}
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
              return `<tr><td>${v.cliente}</td><td>${(v.items[0]?.nombre || '—').substring(0,28)}${v.items.length>1?` +${v.items.length-1}`:''}</td><td>${State.fmtUSD(total)}</td><td><span class="badge ${v.estado==='cerrada'?'b-green':'b-amber'}">${v.estado==='cerrada'?'Cerrada':'Abierta'}</span></td></tr>`;
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

  renderPeriodoSelector() {
    const opciones = [['hoy', 'Hoy'], ['semana', 'Esta semana'], ['mes', 'Este mes'], ['rango', 'Rango libre']];
    document.getElementById('periodo-selector').innerHTML = opciones.map(([k, l]) =>
      `<button class="btn btn-sm ${this.periodo===k?'btn-primary':''}" onclick="Dashboard.setPeriodo('${k}')">${l}</button>`
    ).join('');
    document.getElementById('rango-custom').style.display = this.periodo === 'rango' ? 'flex' : 'none';
  },

  setPeriodo(p) {
    this.periodo = p;
    if (p !== 'rango') App.goTo('dashboard');
    else this.renderPeriodoSelector();
  },

  aplicarRango() {
    this.fechaDesde = document.getElementById('dash-desde').value;
    this.fechaHasta = document.getElementById('dash-hasta').value;
    if (this.fechaDesde && this.fechaHasta) {
      const ms = new Date(this.fechaHasta) - new Date(this.fechaDesde);
      this.periodo = 'rango';
      this._rangoDias = Math.max(1, Math.round(ms / 86400000) + 1);
    }
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
    const ctxEvol = document.getElementById('chart-evolucion');
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

    const ctxMB = document.getElementById('chart-monto-beneficio');
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

    const ctxP = document.getElementById('chart-personas');
    if (ctxP) {
      const equivPorPersona = State.personas.map(p => {
        const c = State.cajas[p] || {};
        return (c['ARS cash']||0) + (c['ARS transferencia']||0) + ((c['USD cash']||0)+(c['USD transferencia']||0))*State.refBlue + (c['USDT']||0)*State.refUsdt;
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
