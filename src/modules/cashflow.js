const CashFlow = {
  // Mes que se está mirando. Antes esta pantalla no filtraba NADA: llamaba a
  // State.resultadoComercialMes() y State.resultadoFinancieroMes() sin
  // argumento, que suman toda la historia del negocio, y las listaba bajo un
  // título que decía "Movimientos del período". Los KPIs mostraban el
  // acumulado desde el día uno como si fuera el mes en curso.
  mesActual: new Date().toISOString().slice(0, 7),

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

  cambiarMes(m) {
    this.mesActual = m;
    const host = document.getElementById('cashflow-body');
    if (host) host.innerHTML = this.contenido();
  },

  // Mismo criterio de resultado que Ventas, Dashboard y el cierre de mes:
  // el margen es precio − costo, y el diferencial de tarjeta va aparte.
  datos() {
    const mes = this.mesActual;
    const blue = State.refBlue || 1;
    const ventas = State.ventas.filter(v => (v.fechaISO || '').slice(0, 7) === mes);
    const gastos = State.gastos.filter(g => g.mesCierre === mes);
    const cambios = State.cambiosEnPeriodo({ tipo: 'mes-especifico', mes });

    const res = ventas.map(v => Ventas.resultadoVenta(v));
    const cobradoUSD    = res.reduce((s, r) => s + r.cobrado, 0);
    const margenUSD     = res.reduce((s, r) => s + r.margenBruto - r.quebranto, 0);
    const diferencialUSD = res.reduce((s, r) => s + r.diferencial, 0);
    const gastosARS     = gastos.reduce((a, g) => a + State.gastoEnUSD(g), 0) * blue;
    const spreadARS     = cambios.reduce((s, c) => s + State.calcSpreadARS(c), 0);

    return {
      mes, blue, ventas, gastos, cambios,
      ingresosARS: cobradoUSD * blue,
      gastosARS,
      resultComercialARS: margenUSD * blue,
      resultFinancieroARS: spreadARS + diferencialUSD * blue,
    };
  },

  contenido() {
    const d = this.datos();
    const filas = [
      ...d.ventas.map(v => ({
        fecha: v.fechaISO || v.fecha, orden: v.fechaISO || '',
        concepto: `Venta #${v.id} — ${v.cliente}`, badge: 'b-blue', tipo: 'Venta',
        monto: `+${State.fmtUSD(v.items.reduce((s, i) => s + i.precio, 0))}`, color: 'var(--green)',
      })),
      ...d.gastos.map(g => ({
        fecha: g.fecha, orden: g.fechaISO || '',
        concepto: g.motivo, badge: 'b-amber', tipo: 'Gasto',
        monto: `-${g.moneda === 'USD' ? State.fmtUSD(g.monto) : State.fmtARS(g.monto)}`, color: 'var(--red)',
      })),
      ...d.cambios.map(c => {
        const s = State.calcSpreadARS(c);
        return {
          fecha: c.fechaISO ? c.fechaISO.slice(0, 10) : c.fecha, orden: c.fechaISO || '',
          concepto: `Cambio ${Cueva.typeObj(c.tipo).label}`, badge: 'b-purple', tipo: 'Cambio',
          monto: `${s >= 0 ? '+' : ''}${State.fmtARS(s)} (spread)`, color: s >= 0 ? 'var(--green)' : 'var(--red)',
        };
      }),
    ].sort((a, b) => String(b.orden).localeCompare(String(a.orden)));

    return `
      <div class="kpi-row" style="grid-template-columns:repeat(4,1fr);padding:0 0 14px 0;border:none">
        <div class="kpi"><label>Cobrado por ventas</label><div class="val" style="color:var(--green)">${State.fmtARS(d.ingresosARS)}</div><div class="sub">${d.ventas.length} venta(s) del mes</div></div>
        <div class="kpi"><label>Egresos (gastos)</label><div class="val" style="color:var(--red)">${State.fmtARS(d.gastosARS)}</div><div class="sub">${d.gastos.length} gasto(s) del mes</div></div>
        <div class="kpi"><label>Resultado comercial</label><div class="val">${d.resultComercialARS >= 0 ? '+' : ''}${State.fmtUSD(d.resultComercialARS / d.blue)}</div><div class="sub">margen: precio − costo</div></div>
        <div class="kpi"><label>Resultado financiero</label><div class="val" style="color:var(--purple)">${d.resultFinancieroARS >= 0 ? '+' : ''}${State.fmtARS(d.resultFinancieroARS)}</div><div class="sub">tarjeta + spread cueva</div></div>
      </div>
      <div class="card">
        <div class="card-title"><i class="ti ti-list"></i> Movimientos de ${d.mes}</div>
        ${filas.length ? `
          <table><thead><tr><th>Fecha</th><th>Concepto</th><th>Tipo</th><th>Monto</th></tr></thead>
          <tbody>
            ${filas.map(f => `<tr><td>${f.fecha}</td><td>${f.concepto}</td><td><span class="badge ${f.badge}">${f.tipo}</span></td><td style="color:${f.color}">${f.monto}</td></tr>`).join('')}
          </tbody></table>
        ` : `<div class="empty-state"><i class="ti ti-calendar-off"></i>No hay movimientos cargados en este mes</div>`}
      </div>
    `;
  },

  render() {
    const c = document.createElement('div');
    c.className = 'body-pad';
    c.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <label style="font-size:12px;color:var(--text-secondary)">Mes</label>
        <select onchange="CashFlow.cambiarMes(this.value)" style="font-size:12px;padding:6px 10px;border:1px solid var(--border-strong);border-radius:8px">
          ${this.ultimosMeses(12).map(m => `<option value="${m.value}" ${m.value === this.mesActual ? 'selected' : ''}>${m.label}</option>`).join('')}
        </select>
      </div>
      <div id="cashflow-body">${this.contenido()}</div>
    `;
    return c;
  }
};


window.CashFlow = CashFlow;
