// ============================================================
// REPORTES — cierre de mes
// Calcula exactamente la planilla de control del negocio:
//   volumen, unidades, ganancia bruta, rentabilidad, ticket promedio,
//   diferencial de tarjeta, diferencial de tipo de cambio y ganancia neta.
// ============================================================

const Reportes = {
  _mes: null,     // 'AAAA-MM'
  _nicho: '',     // '' = todos los rubros

  DISPOSITIVOS: ['iphone', 'android', 'mac', 'ipad', 'watch'],

  // Nichos de mercado — cada categoría del stock cae en uno.
  NICHOS: [
    { id: 'dispositivos', label: 'Dispositivos', emoji: '📱', cats: ['iphone','android','mac','ipad','watch'] },
    { id: 'audio',        label: 'Audio',        emoji: '🎧', cats: ['audio'] },
    { id: 'accesorios',   label: 'Accesorios',   emoji: '🔌', cats: ['accesorio'] },
    { id: 'perfumeria',   label: 'Perfumería',   emoji: '💧', cats: ['perfumeria','decant'] },
    { id: 'taller',       label: 'Taller / repuestos', emoji: '🔧', cats: ['repuesto','herramienta'] },
    { id: 'otros',        label: 'Otros',        emoji: '📦', cats: ['otro'] },
  ],

  nichoDe(item) {
    const p = State.stock.find(s => s.id === item.stockId);
    const cat = p?.cat || null;
    const n = this.NICHOS.find(x => x.cats.includes(cat));
    return n ? n.id : 'otros';
  },

  mesActual() {
    const h = new Date();
    return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}`;
  },

  // Meses con actividad, del más nuevo al más viejo
  mesesDisponibles() {
    const set = new Set();
    (State.ventas || []).forEach(v => {
      const f = State.parseFecha(v.fechaISO);
      if (f) set.add(`${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}`);
    });
    set.add(this.mesActual());
    return [...set].sort().reverse();
  },

  ventasDelMes(mes) {
    return (State.ventas || []).filter(v => {
      const f = State.parseFecha(v.fechaISO);
      if (!f) return false;
      return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}` === mes;
    });
  },

  esDispositivo(item) {
    const p = State.stock.find(s => s.id === item.stockId);
    return p ? this.DISPOSITIVOS.includes(p.cat) : false;
  },

  // ── El cálculo ────────────────────────────────────────────
  calcular(mes, nicho = '') {
    // Con un nicho elegido, el análisis se hace SOLO sobre los ítems de ese
    // rubro. Los importes que son de la venta entera (recargo de tarjeta, lo
    // que quedó sin cobrar) se prorratean según cuánto pesa el nicho dentro
    // de esa venta: si perfumería fue el 20% de la venta, se le imputa el 20%.
    const todas = this.ventasDelMes(mes);
    const ventas = nicho
      ? todas.filter(v => v.items.some(i => this.nichoDe(i) === nicho))
      : todas;
    const enNicho = i => !nicho || this.nichoDe(i) === nicho;

    // Volumen: TODO lo vendido, sin importar el rubro.
    // Unidades: solo equipos (dispositivos) y sin contar los regalados,
    // que es lo que hace comparable el ticket promedio entre meses.
    let volumen = 0, unidades = 0, costoTotal = 0;
    const porNicho = {};
    this.NICHOS.forEach(n => porNicho[n.id] = { ...n, volumen: 0, costo: 0, unidades: 0, ventas: new Set() });

    ventas.forEach(v => {
      v.items.forEach(i => {
        if (!enNicho(i)) return;
        const n = porNicho[this.nichoDe(i)];
        const uds = i.cantidad || 1;
        volumen    += i.precio;
        costoTotal += (i.costo || 0);
        n.volumen  += i.precio;
        n.costo    += (i.costo || 0);
        if (!i.regalo) {
          n.unidades += uds;
          if (this.esDispositivo(i)) unidades += uds;
        }
        n.ventas.add(v.id);
      });
    });

    const nichos = Object.values(porNicho)
      .map(n => ({
        ...n,
        ventas: n.ventas.size,
        ganancia: n.volumen - n.costo,
        rentabilidad: n.volumen > 0 ? ((n.volumen - n.costo) / n.volumen) * 100 : 0,
        participacion: volumen > 0 ? (n.volumen / volumen) * 100 : 0,
      }))
      .filter(n => n.volumen !== 0 || n.unidades !== 0)
      .sort((a, b) => b.volumen - a.volumen);

    // Ganancia bruta: sobre TODA la venta (dispositivos + accesorios),
    // porque los accesorios también dejan margen.
    const res = ventas.map(v => {
      const r = Ventas.resultadoVenta(v);
      if (!nicho) return r;
      // Peso del nicho dentro de la venta
      const totalVenta = v.items.reduce((a, i) => a + i.precio, 0);
      const totalNicho = v.items.filter(enNicho).reduce((a, i) => a + i.precio, 0);
      const peso = totalVenta > 0 ? totalNicho / totalVenta : 0;
      const costoNicho = v.items.filter(enNicho).reduce((a, i) => a + (i.costo || 0), 0);
      return {
        ...r,
        margenBruto: totalNicho - costoNicho,
        diferencial: r.diferencial * peso,
        quebranto:   r.quebranto   * peso,
        pendiente:   r.pendiente   * peso,
      };
    });
    const gananciaBruta = res.reduce((s, r) => s + r.margenBruto, 0);
    const sinCobrar     = res.reduce((s, r) => s + r.quebranto, 0);
    const porCobrar     = res.reduce((s, r) => s + r.pendiente, 0);
    const difTarjeta    = res.reduce((s, r) => s + r.diferencial, 0);

    // Diferencial de tipo de cambio: spread de las operaciones de cueva del mes
    const cambios = (State.cambios || []).filter(c => {
      if (c.tipo !== 'ars-usd') return false;
      const f = State.parseFecha(c.fechaISO);
      if (!f) return false;
      return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}` === mes;
    });
    // El spread de cueva no pertenece a ningún rubro: solo se cuenta en la
    // vista general, si no lo estaríamos imputando a un negocio que no lo generó.
    const difCambio = nicho ? 0
      : cambios.reduce((s, c) => s + State.calcSpreadARS(c), 0) / (State.refBlue || 1);

    const rentabilidad  = volumen > 0 ? (gananciaBruta / volumen) * 100 : 0;
    const ticketProm    = unidades > 0 ? volumen / unidades : 0;
    const gananciaNeta  = gananciaBruta + difTarjeta + difCambio - sinCobrar;

    return {
      mes, nicho, ventas, cantidadVentas: ventas.length,
      volumen, unidades, costoTotal, nichos,
      gananciaBruta, rentabilidad, ticketProm,
      difTarjeta, difCambio, sinCobrar, porCobrar, gananciaNeta,
      opsCambio: cambios.length,
    };
  },

  // ── Pantalla ──────────────────────────────────────────────
  render() {
    if (!this._mes) this._mes = this.mesActual();
    const r = this.calcular(this._mes, this._nicho);
    const c = document.createElement('div');
    c.className = 'body-pad';

    const nombreMes = (() => {
      const [a, m] = this._mes.split('-').map(Number);
      return new Date(a, m - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    })();

    const fila = (label, detalle, valor, color, destacar) => `
      <tr style="border-top:1px solid var(--border)${destacar ? ';background:var(--green-light)' : ''}">
        <td style="padding:11px 14px;font-weight:${destacar ? '700' : '600'};${destacar ? 'color:var(--green)' : ''}">${label}</td>
        <td style="padding:11px 14px;font-size:12px;color:var(--text-secondary)">${detalle}</td>
        <td style="padding:11px 14px;text-align:right;font-weight:700;font-size:${destacar ? '16' : '14'}px;color:${color};white-space:nowrap">${valor}</td>
      </tr>`;

    c.innerHTML = `
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:16px">
        <div>
          <label style="font-size:10px;color:var(--text-secondary);display:block;margin-bottom:3px">Mes a cerrar</label>
          <select id="rep-mes" onchange="Reportes.cambiarMes(this.value)"
            style="font-size:13px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg);color:var(--text);min-width:180px">
            ${this.mesesDisponibles().map(m => {
              const [a, mm] = m.split('-').map(Number);
              const txt = new Date(a, mm - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
              return `<option value="${m}" ${m === this._mes ? 'selected' : ''}>${txt}</option>`;
            }).join('')}
          </select>
        </div>
        <div>
          <label style="font-size:10px;color:var(--text-secondary);display:block;margin-bottom:3px">Tipo de negocio</label>
          <select id="rep-nicho" onchange="Reportes.cambiarNicho(this.value)"
            style="font-size:13px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg);color:var(--text);min-width:180px">
            <option value="">Todos los rubros</option>
            ${this.NICHOS.map(n => `<option value="${n.id}" ${this._nicho===n.id?'selected':''}>${n.emoji} ${n.label}</option>`).join('')}
          </select>
        </div>
        <div style="flex:1"></div>
        <button class="btn" onclick="Reportes.exportarExcel()"><i class="ti ti-file-spreadsheet"></i> Exportar Excel</button>
        <button class="btn" onclick="Reportes.imprimir()"><i class="ti ti-printer"></i> Imprimir / PDF</button>
      </div>

      <div class="card" style="padding:0;overflow-x:auto">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border)">
          <div style="font-size:15px;font-weight:700;text-transform:capitalize">Cierre de ${nombreMes}</div>
          <div style="font-size:12px;color:var(--text-secondary)">${r.cantidadVentas} venta(s) en el período${
            this._nicho ? ` · solo <b>${this.NICHOS.find(n=>n.id===this._nicho)?.label}</b>` : ''}</div>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13.5px;min-width:640px">
          <thead>
            <tr style="background:var(--bg-secondary);text-align:left">
              <th style="padding:9px 14px;font-weight:600">Ítem</th>
              <th style="padding:9px 14px;font-weight:600">Detalle</th>
              <th style="padding:9px 14px;font-weight:600;text-align:right">Valor</th>
            </tr>
          </thead>
          <tbody>
            ${fila('Volumen vendido', 'Suma de todo lo vendido (todos los rubros)', State.fmtUSD(r.volumen), 'var(--blue)')}
            ${fila('Unidades', 'Equipos vendidos (no regalados)', String(r.unidades), 'var(--text)')}
            ${fila('Ganancias brutas', 'Precio venta − costo', State.fmtUSD(r.gananciaBruta), r.gananciaBruta >= 0 ? 'var(--green)' : 'var(--red)')}
            ${fila('Rentabilidad', 'Ganancia bruta ÷ volumen vendido', r.rentabilidad.toFixed(1) + '%', r.rentabilidad >= 0 ? 'var(--green)' : 'var(--red)')}
            ${fila('Ticket promedio', 'Volumen vendido ÷ unidades de equipo', State.fmtUSD(r.ticketProm), 'var(--text)')}
            ${fila('Diferencial con tarjeta', 'Suma de todos los diferenciales con tarjeta', State.fmtUSD(r.difTarjeta), 'var(--purple)')}
            ${fila('Diferencial por tipo de cambio', `Spread de ${r.opsCambio} operación(es) de cueva`, State.fmtUSD(r.difCambio), r.difCambio >= 0 ? 'var(--green)' : 'var(--red)')}
            ${r.sinCobrar > 0.005 ? fila('Sin cobrar (ventas cerradas)', 'Descuentos y comisiones que se comieron margen', '− ' + State.fmtUSD(r.sinCobrar), 'var(--red)') : ''}
            ${fila('Ganancia neta', 'Bruta + tarjeta + tipo de cambio' + (r.sinCobrar > 0.005 ? ' − sin cobrar' : ''), State.fmtUSD(r.gananciaNeta), r.gananciaNeta >= 0 ? 'var(--green)' : 'var(--red)', true)}
          </tbody>
        </table>
      </div>

      <div class="card" style="padding:0;overflow-x:auto;margin-top:14px">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border)">
          <div style="font-size:15px;font-weight:700">Detalle por nicho de mercado</div>
          <div style="font-size:12px;color:var(--text-secondary)">Mismo análisis, abierto por rubro</div>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:720px">
          <thead>
            <tr style="background:var(--bg-secondary);text-align:left">
              <th style="padding:9px 14px;font-weight:600">Nicho</th>
              <th style="padding:9px 14px;font-weight:600;text-align:right">Volumen</th>
              <th style="padding:9px 14px;font-weight:600;text-align:right">% del total</th>
              <th style="padding:9px 14px;font-weight:600;text-align:right">Unidades</th>
              <th style="padding:9px 14px;font-weight:600;text-align:right">Costo</th>
              <th style="padding:9px 14px;font-weight:600;text-align:right">Ganancia</th>
              <th style="padding:9px 14px;font-weight:600;text-align:right">Rentab.</th>
            </tr>
          </thead>
          <tbody>
            ${r.nichos.length ? r.nichos.map(n => `
              <tr style="border-top:1px solid var(--border)">
                <td style="padding:10px 14px;font-weight:600">${n.emoji} ${n.label}</td>
                <td style="padding:10px 14px;text-align:right;white-space:nowrap">${State.fmtUSD(n.volumen)}</td>
                <td style="padding:10px 14px;text-align:right;color:var(--text-secondary)">${n.participacion.toFixed(1)}%</td>
                <td style="padding:10px 14px;text-align:right">${n.unidades}</td>
                <td style="padding:10px 14px;text-align:right;color:var(--text-secondary);white-space:nowrap">${State.fmtUSD(n.costo)}</td>
                <td style="padding:10px 14px;text-align:right;font-weight:700;white-space:nowrap;color:${n.ganancia>=0?'var(--green)':'var(--red)'}">${n.ganancia>=0?'+':''}${State.fmtUSD(n.ganancia)}</td>
                <td style="padding:10px 14px;text-align:right;color:${n.rentabilidad>=0?'var(--green)':'var(--red)'}">${n.rentabilidad.toFixed(1)}%</td>
              </tr>`).join('') : `<tr><td colspan="7" style="padding:24px;text-align:center;color:var(--text-secondary)">Sin ventas en el período.</td></tr>`}
          </tbody>
          ${r.nichos.length ? `<tfoot>
            <tr style="border-top:2px solid var(--border-strong);background:var(--bg-secondary);font-weight:700">
              <td style="padding:10px 14px">Total</td>
              <td style="padding:10px 14px;text-align:right;white-space:nowrap">${State.fmtUSD(r.volumen)}</td>
              <td style="padding:10px 14px;text-align:right">100%</td>
              <td style="padding:10px 14px;text-align:right">${r.nichos.reduce((a,n)=>a+n.unidades,0)}</td>
              <td style="padding:10px 14px;text-align:right;white-space:nowrap">${State.fmtUSD(r.costoTotal)}</td>
              <td style="padding:10px 14px;text-align:right;white-space:nowrap;color:${r.gananciaBruta>=0?'var(--green)':'var(--red)'}">${r.gananciaBruta>=0?'+':''}${State.fmtUSD(r.gananciaBruta)}</td>
              <td style="padding:10px 14px;text-align:right">${r.rentabilidad.toFixed(1)}%</td>
            </tr>
          </tfoot>` : ''}
        </table>
      </div>

      ${this._nicho ? `<div style="background:var(--blue-light);border:1px solid rgba(10,132,255,.3);border-radius:10px;padding:10px 14px;font-size:12.5px;color:var(--blue);margin-top:12px">
        Estás viendo solo <b>${this.NICHOS.find(n=>n.id===this._nicho)?.label}</b>. En las ventas mixtas, el recargo de tarjeta y lo no cobrado se reparten según cuánto pesó este rubro en cada venta. El diferencial por tipo de cambio no se incluye: no pertenece a ningún rubro.
      </div>` : ''}

      ${r.porCobrar > 0.005 ? `<div style="background:var(--amber-light);border:1px solid var(--amber);border-radius:10px;padding:10px 14px;font-size:12.5px;color:var(--amber);margin-top:12px">
        <b>${State.fmtUSD(r.porCobrar)} por cobrar</b> en ventas todavía abiertas del mes. No está descontado de la ganancia: es plata que te deben.
      </div>` : ''}

      <div style="font-size:11px;color:var(--text-secondary);margin-top:12px">
        <i class="ti ti-info-circle"></i> El volumen incluye todos los rubros. Las unidades cuentan solo equipos (sin los regalados), para que el ticket promedio sea comparable entre meses.
      </div>
    `;
    return c;
  },

  cambiarMes(m) { this._mes = m; App.goTo('reportes'); },
  cambiarNicho(n) { this._nicho = n; App.goTo('reportes'); },

  exportarExcel() {
    if (typeof XLSX === 'undefined') { toast('No se pudo cargar el módulo de exportación.'); return; }
    const r = this.calcular(this._mes, this._nicho);
    const n = x => Number(x.toFixed(2));

    const resumen = [
      { 'Ítem': 'Volumen vendido',               'Detalle': 'Suma de todos los dispositivos vendidos',        'Valor (USD)': n(r.volumen) },
      { 'Ítem': 'Unidades',                      'Detalle': 'Todos los equipos vendidos (no regalados)',      'Valor (USD)': r.unidades },
      { 'Ítem': 'Ganancias brutas',              'Detalle': 'Precio venta − costo',                           'Valor (USD)': n(r.gananciaBruta) },
      { 'Ítem': 'Rentabilidad',                  'Detalle': 'Ganancia bruta ÷ volumen vendido',               'Valor (USD)': n(r.rentabilidad) + '%' },
      { 'Ítem': 'Ticket promedio',               'Detalle': 'Volumen vendido ÷ unidades',                     'Valor (USD)': n(r.ticketProm) },
      { 'Ítem': 'Diferencial con tarjeta',       'Detalle': 'Suma de todos los diferenciales con tarjeta',    'Valor (USD)': n(r.difTarjeta) },
      { 'Ítem': 'Diferencial por tipo de cambio','Detalle': `Spread de ${r.opsCambio} operación(es) de cueva`,'Valor (USD)': n(r.difCambio) },
      { 'Ítem': 'Sin cobrar (ventas cerradas)',  'Detalle': 'Descuentos y comisiones que se comieron margen', 'Valor (USD)': -n(r.sinCobrar) },
      { 'Ítem': 'GANANCIA NETA',                 'Detalle': 'Bruta + tarjeta + tipo de cambio − sin cobrar',  'Valor (USD)': n(r.gananciaNeta) },
      { 'Ítem': 'Por cobrar (ventas abiertas)',  'Detalle': 'No descontado — plata que te deben',             'Valor (USD)': n(r.porCobrar) },
    ];

    // Detalle venta por venta, para poder auditar de dónde sale cada número
    const detalle = r.ventas.map(v => {
      const x = Ventas.resultadoVenta(v);
      return {
        'Venta': v.id, 'Fecha': v.fecha, 'Cliente': v.cliente, 'Vendedor': v.vendedor || '',
        'Estado': v.estado === 'cerrada' ? 'Cerrada' : 'Abierta',
        'Ítems': v.items.map(i => i.nombre + (i.regalo ? ' (regalo)' : '')).join(' · '),
        'Total venta': n(x.total), 'Costo': n(x.costo), 'Cobrado': n(x.cobrado),
        'Ganancia bruta': n(x.margenBruto), 'Diferencial tarjeta': n(x.diferencial),
        'Sin cobrar': n(x.quebranto), 'Pendiente': n(x.pendiente), 'Ganancia real': n(x.margenReal),
      };
    });

    const nichos = r.nichos.map(x => ({
      'Nicho':          x.label,
      'Volumen (USD)':  n(x.volumen),
      '% del total':    n(x.participacion),
      'Unidades':       x.unidades,
      'Costo (USD)':    n(x.costo),
      'Ganancia (USD)': n(x.ganancia),
      'Rentabilidad %': n(x.rentabilidad),
      'Ventas':         x.ventas,
    }));

    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.json_to_sheet(resumen);
    ws1['!cols'] = [{ wch: 32 }, { wch: 52 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'Resumen');
    if (nichos.length) {
      const wsN = XLSX.utils.json_to_sheet(nichos);
      wsN['!cols'] = [{wch:22},{wch:15},{wch:12},{wch:10},{wch:14},{wch:16},{wch:15},{wch:9}];
      XLSX.utils.book_append_sheet(wb, wsN, 'Por nicho');
    }
    if (detalle.length) {
      const ws2 = XLSX.utils.json_to_sheet(detalle);
      ws2['!cols'] = [{wch:8},{wch:10},{wch:24},{wch:16},{wch:10},{wch:44},{wch:12},{wch:12},{wch:12},{wch:14},{wch:16},{wch:12},{wch:12},{wch:14}];
      XLSX.utils.book_append_sheet(wb, ws2, 'Detalle de ventas');
    }
    const suf = this._nicho ? `-${this._nicho}` : '';
    XLSX.writeFile(wb, `iPhoneMood-Cierre-${this._mes}${suf}.xlsx`);
    toast('Reporte exportado.');
  },

  imprimir() { window.print(); },
};

window.Reportes = Reportes;
export default Reportes;
