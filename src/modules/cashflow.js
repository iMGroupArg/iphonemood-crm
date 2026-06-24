const CashFlow = {
  render() {
    const c = document.createElement('div');
    c.className = 'body-pad';
    const ventasIngresos = State.ventas.reduce((a, v) => a + v.pagos.reduce((s, p) => s + p.monto, 0), 0) * State.refBlue;
    const gastosEgresos = State.gastos.filter(g => g.moneda === 'ARS').reduce((a, g) => a + g.monto, 0);
    const resultComercial = State.resultadoComercialMes();
    const resultFinanciero = State.resultadoFinancieroMes();

    c.innerHTML = `
      <div class="kpi-row" style="grid-template-columns:repeat(4,1fr);padding:0 0 14px 0;border:none">
        <div class="kpi"><label>Ingresos por ventas</label><div class="val" style="color:var(--green)">${State.fmtARS(ventasIngresos)}</div></div>
        <div class="kpi"><label>Egresos (gastos)</label><div class="val" style="color:var(--red)">${State.fmtARS(gastosEgresos)}</div></div>
        <div class="kpi"><label>Resultado comercial</label><div class="val">${resultComercial>=0?'+':''}${State.fmtUSD(resultComercial/State.refBlue)}</div></div>
        <div class="kpi"><label>Resultado financiero</label><div class="val" style="color:var(--purple)">${resultFinanciero>=0?'+':''}${State.fmtARS(resultFinanciero)}</div></div>
      </div>
      <div class="card">
        <div class="card-title"><i class="ti ti-list"></i> Movimientos del período</div>
        <table><thead><tr><th>Fecha</th><th>Concepto</th><th>Tipo</th><th>Monto</th></tr></thead>
        <tbody>
          ${State.ventas.map(v => `<tr><td>${v.fecha}</td><td>Venta #${v.id} — ${v.cliente}</td><td><span class="badge b-blue">Venta</span></td><td style="color:var(--green)">+${State.fmtUSD(v.items.reduce((s,i)=>s+i.precio,0))}</td></tr>`).join('')}
          ${State.gastos.map(g => `<tr><td>${g.fecha}</td><td>${g.motivo}</td><td><span class="badge b-amber">Gasto</span></td><td style="color:var(--red)">-${g.moneda==='USD'?State.fmtUSD(g.monto):State.fmtARS(g.monto)}</td></tr>`).join('')}
          ${State.cambios.map(c => `<tr><td>${c.fecha}</td><td>Cambio ${Cueva.typeObj(c.tipo).label}</td><td><span class="badge b-purple">Cambio</span></td><td style="color:${State.calcSpreadARS(c)>=0?'var(--green)':'var(--red)'}">${State.calcSpreadARS(c)>=0?'+':''}${State.fmtARS(State.calcSpreadARS(c))} (spread)</td></tr>`).join('')}
        </tbody></table>
      </div>
    `;
    return c;
  }
};


window.CashFlow = CashFlow;
