// Mercado Libre → «Comparar pagos con Mercado Pago»: contrasta lo GUARDADO de cada orden contra el pago EN VIVO y lista las que difieren.
// SOLO LECTURA: no hay ningún botón que escriba (ni ventas, ni cajas, ni stock, ni facturas). Usa la acción `comparar` del worker
// (api/_meli_comparar.js), en tandas siguiendo el cursor hasta completar. Sin datos del comprador: solo número de orden, producto, importes y estados.
//
// Por qué existe: un pago puede cambiar DESPUÉS de la venta (ajuste de monto, envío o intereses a cargo del comprador, devolución…) y el CRM se queda con el
// monto y el neto que leyó al ingresar la orden (docs/meli-ajuste-pago-diseno.md).

const MeliComparar = {
  DESDE_INICIAL: '2026-10-01',
  TOPE: 20,                       // órdenes por tanda (el servidor además topea los pagos)
  PAUSA_TANDA_MS: 400,            // respiro entre tandas
  MAX_SIN_AVANCE: 3,              // tandas seguidas sin revisar ninguna orden → se pausa (no se insiste a ciegas)
  LIMITE_FILAS: 100,

  _selDesde: '', _selHasta: '',     // lo ELEGIDO en los campos de fecha (para la próxima comparación); _desde/_hasta son el rango de la corrida en curso y no cambian a mitad
  _hasta: '',                     // exclusivo (opcional): «hasta» el día anterior; vacío = hasta hoy
  _est: 'inactivo',               // inactivo | corriendo | pausado | listo | error
  _desde: '',
  _cuentaId: null,
  _cursor: null,
  _rev: 0, _pagos: 0, _conErrores: 0, _total: null,
  _filas: [],
  _titulos: {},                   // orden → producto
  _msg: '', _msgTipo: '',
  _pedirPausa: false, _sinAvance: 0, _corrida: 0,
  _limite: 100,
  _ret: { total: 0, ordenes: 0, por_cargo: {}, incompletas: 0 },   // retenciones/impuestos de TODAS las órdenes revisadas (parte normal del costo de canal)
  _desg: null,                    // { orden, cargando, datos, error } — desglose de UNA orden

  MOTIVOS: {
    COBRADO_DISTINTO: 'El monto cobrado cambió',
    NETO_DISTINTO: 'Lo que llega a la cuenta cambió',
    NETO_NUEVO_DISTINTO: 'Lo que llega cambió (campo nuevo de Mercado Pago)',
    COBRADO_VIVO_NO_DISPONIBLE: 'Mercado Pago ya no informa el monto cobrado',
    COBRADO_GUARDADO_FALTA: 'Faltaba el monto cobrado y ahora Mercado Pago lo informa',
    NETO_VIVO_NO_DISPONIBLE: 'Mercado Pago ya no informa lo que llega',
    NETO_GUARDADO_FALTA: 'Faltaba lo que llega y ahora Mercado Pago lo informa',
    PAGO_NO_APROBADO: 'Un pago pasó a devuelto, cancelado o en disputa',
    ESTADO_PAGO_CAMBIO: 'Un pago cambió de estado',
    HAY_REINTEGRO: 'Tiene un reintegro',
    ENVIO_PAGADO_POR_EL_COMPRADOR: 'El comprador pagó el envío y el CRM no lo suma a lo que llega',
    LLEGA_REAL_DISTINTO: 'Lo que llega de verdad (neto + envío del comprador) es más de lo guardado',
    EXTRA_PAGADO_POR_EL_COMPRADOR: 'El comprador pagó más que el total de los ítems (envío o intereses a su cargo)',
    LIBERACION_DISTINTA: 'Cambió la fecha de liberación',
    LIBERACION_APARECE: 'Ahora hay fecha de liberación',
    LIBERACION_DESAPARECE: 'Ya no hay fecha de liberación',
    TOTAL_ORDEN_DISTINTO: 'Cambió el total de la orden',
    TOTAL_ORDEN_NO_CONSULTADO: 'No se pudo consultar el total de la orden',
    PAGOS_NO_REVISADOS_TODOS: 'Tiene más pagos de los que se revisan',
    PAGO_INEXISTENTE: 'Un pago ya no existe en Mercado Pago',
    PAGO_NO_CONSULTADO: 'No se pudo consultar un pago',
    SIN_PAGOS_GUARDADOS: 'No hay pagos guardados para comparar',
  },
  ERRORES: {
    SIN_SESION: 'Tu sesión venció: recargá el CRM.', CUENTA_INVALIDA: 'No hay una cuenta de Mercado Libre válida.',
    DESDE_INVALIDO: 'La fecha «desde» no es válida.', HASTA_INVALIDO: 'La fecha «hasta» no es válida.',
    CURSOR_INVALIDO: 'No se pudo seguir desde donde quedó: empezá de nuevo.',
  },

  _e(s) { return State.esc(String(s ?? '')); },
  _num(x) { return (x === null || x === undefined || x === '' || !Number.isFinite(Number(x))) ? null : Number(x); },
  _pesos(x) { const n = this._num(x); return n === null ? '—' : State.fmtARS(n); },
  _con(x) { const n = this._num(x); return n === null ? '—' : (n > 0 ? '+' : '') + State.fmtARS(n); },
  _dia(f) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(f || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : '—'; },
  _fechaValida(f) { return /^\d{4}-\d{2}-\d{2}$/.test(String(f || '')) && !isNaN(new Date(f + 'T00:00:00')); },

  _cuenta() {
    const cs = (window.Meli && Meli._cuentas) || [];
    return cs.find(c => c.conectada && c.activa !== false && !c.requiere_reconexion) || null;
  },

  async _post(cuerpo) {
    const token = window.Meli && Meli._token ? await Meli._token() : '';
    const r = await fetch('/api/meli/worker', { method: 'POST', headers: { 'x-crm-token': token || '', 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
    let json = null;
    try { json = await r.json(); } catch { /* sin cuerpo */ }
    return { ok: r.ok, status: r.status, json };
  },

  _aviso(texto, tipo = '') { this._msg = texto; this._msgTipo = tipo; },

  // ── Cuántas órdenes hay en el rango (para la barra de avance): una consulta de conteo con la sesión del usuario ──
  async _contar() {
    this._total = null;
    try {
      let q = supa.from('meli_ordenes').select('id', { count: 'exact', head: true })
        .eq('cuenta_id', this._cuentaId).gte('fecha_orden', this._desde + 'T00:00:00-03:00');
      if (this._hasta) q = q.lt('fecha_orden', this._hasta + 'T00:00:00-03:00');          // el mismo rango que usa el servidor
      const r = await q;
      if (!r.error && Number.isFinite(r.count)) this._total = r.count;
    } catch { /* sin total: la barra queda indeterminada */ }
  },

  // Producto de cada orden (título de la publicación; no hay datos del comprador): meli_orden_items con la sesión del usuario.
  async _cargarTitulos(ordenes) {
    const faltan = ordenes.filter(o => !(o in this._titulos));
    if (!faltan.length) return;
    try {
      for (let i = 0; i < faltan.length; i += 100) {
        const grupo = faltan.slice(i, i + 100);
        const o = await supa.from('meli_ordenes').select('id,meli_order_id').in('meli_order_id', grupo).limit(100);
        if (o.error) throw o.error;
        const porId = new Map((o.data || []).map(x => [x.id, String(x.meli_order_id)]));
        const it = await supa.from('meli_orden_items').select('orden_id,titulo').in('orden_id', [...porId.keys()]).limit(1000);
        if (it.error) throw it.error;
        const lista = {};
        (it.data || []).forEach(x => { const k = porId.get(x.orden_id); if (k && x.titulo) (lista[k] ||= []).push(x.titulo); });
        grupo.forEach(k => { this._titulos[k] = (lista[k] || []).join(' + '); });
      }
    } catch { /* sin producto: la tabla muestra «—» */ }
  },

  // ── Flujo ──
  async iniciar() {
    if (this._est === 'corriendo') return;
    const c = this._cuenta();
    if (!c) { toast('No hay una cuenta de Mercado Libre conectada.'); return; }
    const desde = (document.getElementById('mc-desde') || {}).value || this._selDesde || this.DESDE_INICIAL;
    if (!this._fechaValida(desde)) { toast('La fecha «desde» no es válida.'); return; }
    const hasta = (document.getElementById('mc-hasta') || {}).value || this._selHasta || '';
    if (hasta && (!this._fechaValida(hasta) || hasta <= desde)) { toast('La fecha «hasta» no es válida (tiene que ser posterior a «desde»).'); return; }
    this._reiniciar();
    this._cuentaId = c.id; this._desde = desde; this._hasta = hasta;
    this._est = 'corriendo';                  // se marca ANTES del primer await: un segundo clic durante el conteo no lanza otra corrida
    this.pintar();
    await this._contar();
    return this._correr();
  },

  // Vuelve a cero: otra corrida, otro rango. Nada del período anterior (cursor, filas, retenciones) puede mezclarse con el nuevo.
  _reiniciar() {
    this._est = 'inactivo'; this._cursor = null; this._rev = 0; this._pagos = 0; this._conErrores = 0; this._total = null;
    this._filas = []; this._titulos = {}; this._sinAvance = 0; this._limite = this.LIMITE_FILAS; this._desg = null;
    this._ret = { total: 0, ordenes: 0, por_cargo: {}, incompletas: 0 }; this._pedirPausa = false; this._aviso('');
  },

  // Guarda lo escrito en las fechas: la pantalla de Mercado Libre se vuelve a dibujar cada ~60 s y lo no guardado se perdería.
  cambiaRango() {
    if (this._est === 'corriendo') return;
    const d = (document.getElementById('mc-desde') || {}).value, h = (document.getElementById('mc-hasta') || {}).value;
    if (d !== undefined) this._selDesde = d;
    if (h !== undefined) this._selHasta = h;
  },

  // Atajos de rango (en hora argentina): este mes, mes anterior (para el resumen mensual de retenciones) o desde el 1/10.
  rango(cual) {
    const ar = new Date(Date.now() - 3 * 3600e3), y = ar.getUTCFullYear(), m = ar.getUTCMonth();
    const f = (yy, mm, dd) => `${yy}-${String(mm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    const mas = (yy, mm) => (mm > 11 ? [yy + 1, mm - 12] : [yy, mm]);
    if (this._est === 'corriendo') return;
    this._reiniciar(); this._desde = ''; this._hasta = '';   // otro rango = otra comparación (no se mezcla con el cursor ni los resultados anteriores)
    if (cual === 'octubre') { this._selDesde = this.DESDE_INICIAL; this._selHasta = ''; }
    else if (cual === 'mes') { const [y2, m2] = mas(y, m + 1); this._selDesde = f(y, m, 1); this._selHasta = f(y2, m2, 1); }
    else if (cual === 'anterior') { const [y0, m0] = m === 0 ? [y - 1, 11] : [y, m - 1]; this._selDesde = f(y0, m0, 1); this._selHasta = f(y, m, 1); }
    this.pintar();
  },

  reanudar() { if (this._est === 'pausado' || this._est === 'error') { this._pedirPausa = false; return this._correr(); } },
  pausar() { if (this._est === 'corriendo') { this._pedirPausa = true; this._aviso('Se pausa al terminar la tanda en curso…'); this.pintar(); } },

  async _correr() {
    const mia = ++this._corrida;
    this._est = 'corriendo'; this._aviso(''); this.pintar();          // OJO: no se borra _pedirPausa acá: un «Pausar» pedido durante el conteo inicial debe respetarse
    try {
      for (;;) {
        if (this._pedirPausa) { this._est = 'pausado'; this._aviso('En pausa. Podés reanudar cuando quieras.', 'info'); break; }
        const r = await this._post({ accion: 'comparar', cuenta: this._cuentaId, desde: this._desde, ...(this._hasta ? { hasta: this._hasta } : {}), cursor: this._cursor || undefined, tope: this.TOPE });
        if (mia !== this._corrida) return;
        if (!r.ok || !r.json) {
          this._est = 'pausado';
          this._aviso(r.status === 401 ? 'Tu sesión no está autorizada: recargá el CRM.' : `No se pudo consultar (error ${Number(r.status) || ''}). Reanudá para reintentar desde donde quedó.`, 'error');
          break;
        }
        const j = r.json;
        if (j.ok === false) { this._est = 'error'; this._aviso(this.ERRORES[j.error] || 'La comparación no se pudo hacer.', 'error'); break; }

        const nuevas = (j.diferencias || []).filter(d => !this._filas.some(f => f.orden === d.orden));
        this._filas.push(...nuevas);
        this._rev += Number(j.revisadas) || 0;
        this._pagos += Number(j.pagos_consultados) || 0;
        this._conErrores += Number(j.con_error) || 0;
        this._sumarRetenciones(j.retenciones);
        if (j.cursor) this._cursor = String(j.cursor);
        await this._cargarTitulos(nuevas.map(d => d.orden));
        if (mia !== this._corrida) return;

        if (j.completo) { this._est = 'listo'; this._aviso(''); break; }
        if (j.cortado === 'MELI_LIMITANDO') {
          this._est = 'pausado';
          this._aviso('Mercado Pago pidió esperar (muchos pedidos seguidos). Esperá un minuto y apretá «Reanudar»: sigue desde donde quedó.', 'aviso');
          break;
        }
        this._sinAvance = (Number(j.revisadas) || 0) === 0 ? this._sinAvance + 1 : 0;
        if (this._sinAvance >= this.MAX_SIN_AVANCE) {
          this._est = 'pausado';
          this._aviso('No se pudo avanzar (se agotó el tiempo varias veces seguidas). Reanudá en un momento.', 'aviso');
          break;
        }
        this.pintar();
        await new Promise(res => setTimeout(res, this.PAUSA_TANDA_MS));
      }
    } catch {
      if (mia === this._corrida) { this._est = 'pausado'; this._aviso('Se cortó la comunicación. Reanudá para seguir desde donde quedó.', 'error'); }
    }
    if (mia === this._corrida) this.pintar();
  },

  _sumarRetenciones(r) {
    if (!r || typeof r !== 'object') return;
    const R = this._ret;
    R.ordenes += Number(r.ordenes_con_retencion) || 0;
    R.incompletas += Number(r.incompletas) || 0;
    for (const [k, v] of Object.entries(r.por_cargo || {})) {
      const m = this._num(v); if (m === null) continue;
      R.por_cargo[k] = Math.round(((R.por_cargo[k] || 0) + m) * 100) / 100;
      R.total = Math.round((R.total + m) * 100) / 100;
    }
  },
  retencionesTsv() {
    const f = x => String(x).replace('.', ',');
    const filas = Object.entries(this._ret.por_cargo).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, f(v.toFixed(2))]);
    const aviso = this._ret.incompletas ? [[`AVISO: ${this._ret.incompletas} orden(es) no se pudieron revisar por completo; el total puede ser mayor`, '']] : [];
    return [['Cargo (retención o impuesto)', 'Monto'], ...filas, ['TOTAL', f(this._ret.total.toFixed(2))], ...aviso].map(r => r.join('\t')).join('\n');
  },
  async copiarRetenciones() {
    if (!Object.keys(this._ret.por_cargo).length && !this._ret.incompletas) { toast('No hay retenciones para copiar.'); return; }
    const ok = window.Portapapeles ? await window.Portapapeles.copiar(this.retencionesTsv()) : false;
    toast(ok ? 'Retenciones copiadas. Pegalas en una planilla.' : 'No se pudo copiar.');
  },

  // ── Datos para la tabla y las exportaciones ──
  ordenadas() {
    const mag = d => Math.abs(this._difNeto(d) ?? this._num(d.dif_cobrado) ?? this._num(d.extra_pagado_por_el_comprador) ?? 0);
    return this._filas.slice().sort((a, b) => mag(b) - mag(a) || String(a.orden).localeCompare(String(b.orden)));
  },
  _estadoTexto(d) {
    const t = [d.procesada ? 'Procesada' : 'Sin procesar', d.acreditado ? 'Acreditada' : 'Sin acreditar', d.tiene_venta ? 'Con venta' : 'Sin venta'];
    return t.join(' · ');
  },
  _motivosTexto(d) { return (d.motivos || []).map(m => this.MOTIVOS[m] || 'Otra diferencia').join('; '); },
  _difNeto(d) { return this._num(d.dif_llega_real) ?? this._num(d.dif_neto) ?? this._num(d.dif_neto_campo_nuevo); },   // lo que llega de verdad (neto + envío del comprador) vs lo guardado

  // Texto separado por tabuladores / CSV con ; (Excel en español): importes con coma decimal.
  _filasExport() {
    const n = x => { const v = this._num(x); return v === null ? '' : v.toFixed(2).replace('.', ','); };
    const cab = ['Orden', 'Producto', 'Cobrado guardado', 'Cobrado actual', 'Neto guardado', 'Neto actual (campo que usa el CRM)', 'Envío pagado por el comprador', 'Llega real (neto + envío)', 'Costo de canal guardado', 'Costo de canal real', 'Diferencia (lo que llega)', 'Procesada', 'Acreditada', 'Con venta', 'Liberación guardada', 'Liberación actual', 'Qué cambió'];
    const filas = this.ordenadas().map(d => [d.orden, this._titulos[d.orden] || '', n(d.cobrado_guardado), n(d.cobrado_vivo), n(d.neto_guardado), n(d.neto_vivo), n(d.envio_pagado_por_el_comprador), n(d.llega_real_vivo), n(d.costo_canal_guardado), n(d.costo_canal_real), n(this._difNeto(d)),
      d.procesada ? 'Sí' : 'No', d.acreditado ? 'Sí' : 'No', d.tiene_venta ? 'Sí' : 'No', this._dia(d.liberacion_guardada), this._dia(d.liberacion_viva), this._motivosTexto(d)]);
    return { cab, filas };
  },
  // Un texto que empieza con = + - @ (o tab/CR) se leería como fórmula en la planilla: se neutraliza con un apóstrofo. Un número («-6148,81») NO es texto: se deja.
  _seguro(v) {
    const t = String(v ?? '');
    return /^[=+\-@\t\r]/.test(t) && !/^-?\d+(,\d+)?$/.test(t) ? "'" + t : t;
  },
  csv() {
    const celda = v => {
      const t = this._seguro(v);
      return /[";\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const { cab, filas } = this._filasExport();
    return '﻿' + [cab.join(';'), ...filas.map(f => f.map(celda).join(';'))].join('\r\n') + '\r\n';
  },
  tsv() {
    const limpio = v => this._seguro(String(v ?? '').replace(/[\t\r\n]+/g, ' '));
    const { cab, filas } = this._filasExport();
    return [cab, ...filas].map(f => f.map(limpio).join('\t')).join('\n');
  },
  async copiar() {
    if (!this._filas.length) { toast('No hay nada para copiar.'); return; }
    const ok = window.Portapapeles ? await window.Portapapeles.copiar(this.tsv()) : false;
    toast(ok ? 'Lista copiada. Pegala en una planilla.' : 'No se pudo copiar: usá «Descargar para Excel».');
  },
  descargar() {
    if (!this._filas.length) { toast('No hay nada para descargar.'); return; }
    const hoy = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
    const blob = new Blob([this.csv()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `comparar-pagos-${hoy}.csv`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
  verMas() { this._limite += this.LIMITE_FILAS; this.pintar(); },

  // ── Desglose de UNA orden (solo lectura): cada monto que Mercado Libre/Pago expone, con su fuente, y cuáles coinciden con la diferencia ──
  async verDesglose(orden) {
    const d = this._filas.find(f => String(f.orden) === String(orden));
    if (!d || !this._cuentaId) return;
    const buscar = Math.abs(this._difNeto(d) ?? this._num(d.extra_pagado_por_el_comprador) ?? this._num(d.dif_cobrado) ?? 0) || undefined;
    this._desg = { orden: String(orden), cargando: true, datos: null, error: '' };
    this.pintar();
    const mia = this._desg;
    try {
      const r = await this._post({ accion: 'desglose', cuenta: this._cuentaId, orden: String(orden), buscar });
      if (this._desg !== mia) return;
      if (!r.ok || !r.json || r.json.ok === false) mia.error = r.status === 401 ? 'Tu sesión no está autorizada: recargá el CRM.' : (this.ERRORES[r.json && r.json.error] || 'No se pudo armar el desglose.');
      else mia.datos = r.json;
    } catch { if (this._desg === mia) mia.error = 'No se pudo armar el desglose.'; }
    if (this._desg === mia) { mia.cargando = false; this.pintar(); }
  },
  cerrarDesglose() { this._desg = null; this.pintar(); },
  _vistaDesglose() {
    const g = this._desg;
    if (!g) return '';
    const e = s => this._e(s);
    const caja = (cuerpo) => `<div class="mf-panel" id="mc-desglose"><div class="mf-cab"><b>Desglose de la orden ${e(g.orden)}</b><button class="btn btn-sm" onclick="MeliComparar.cerrarDesglose()">Cerrar</button></div>${cuerpo}</div>`;
    if (g.cargando) return caja('<p>Consultando a Mercado Libre y Mercado Pago…</p>');
    if (g.error) return caja(`<p style="color:var(--red)">${e(g.error)}</p>`);
    const d = g.datos || {};
    const fila = (r, v) => `<tr><td style="padding:2px 12px 2px 0">${e(r)}</td><td class="mf-der" style="padding:2px 0"><b>${e(v)}</b></td></tr>`;
    const P = x => this._pesos(x);
    const sec = (t, filas) => filas ? `<div style="margin-top:8px"><b>${e(t)}</b><table style="font-size:12px">${filas}</table></div>` : '';
    const gu = d.guardado || {}, ov = d.orden_viva, ev = d.envio;
    const cands = (d.candidatos || []);
    return caja(`
      ${d.incompleto ? `<p style="color:var(--amber)">El desglose quedó incompleto (${e((d.errores || []).join(', '))}). Probá de nuevo en un momento.</p>` : ((d.errores || []).length ? `<p style="color:var(--amber)">No se pudo leer: ${e(d.errores.join(', '))}.</p>` : '')}
      ${(d.coincidencias || []).length ? `<p style="color:var(--green)"><b>Coinciden con la diferencia (${e(this._pesos(d.buscar))}):</b> ${e(d.coincidencias.join(' · '))}</p>` : (d.buscar ? `<p>Ninguna fuente coincide con ${e(this._pesos(d.buscar))}.</p>` : '')}
      ${sec('Lo que el CRM tiene guardado', fila('Bruto (total de ítems)', P(gu.bruto)) + fila('Cobrado aprobado', P(gu.cobrado_aprobado)) + fila('Neto (lo que llega)', P(gu.neto)) + fila('Total / pagado de la orden al guardar', `${P(gu.total_orden_guardado)} / ${P(gu.paid_orden_guardado)}`) + fila('Acreditado', P(gu.monto_acreditado)))}
      ${d.resumen ? sec('Lo que llega de verdad (hoy)', fila('Neto — campo que usa el CRM', P(d.resumen.neto_campo_que_usa_el_crm)) + fila('+ Envío pagado por el comprador (shipping_amount)', P(d.resumen.envio_pagado_por_el_comprador)) + fila('= Llega real', P(d.resumen.llega_real)) + fila('Costo de canal real (bruto − llega real)', P(d.resumen.costo_canal_real)) + fila('Costo de canal guardado (bruto − neto)', P(d.resumen.costo_canal_guardado))) : ''}
      ${ov ? sec('Orden en Mercado Libre (hoy)', fila('Total de ítems (total_amount)', P(ov.total_amount)) + fila('Pagado por el comprador (paid_amount)', P(ov.paid_amount)) + fila('Cargo de venta (sale_fee)', P(ov.cargo_venta_sale_fee)) + (ov.pagos || []).map(p => fila(`Pago ${p.id}: cobrado / total pagado / envío a cargo`, `${P(p.transaction_amount)} / ${P(p.total_paid_amount)} / ${P(p.shipping_cost)}`)).join('')) : ''}
      ${(d.pagos_vivos || []).map(p => sec(`Pago ${p.id} en Mercado Pago (hoy) — ${p.estado || '—'}`,
        fila('Monto (transaction_amount)', P(p.transaction_amount)) + fila('Total pagado (total_paid_amount)', P(p.total_paid_amount)) + fila('Envío (shipping_amount)', P(p.shipping_amount))
        + fila('Neto — campo que usa el CRM', P(p.net_received_amount)) + fila('Neto — campo nuevo (amounts.collector)', P(p.net_received_collector))
        + Object.entries(p.cargos_por_tipo_y_nombre || {}).map(([k, v]) => fila('Cargo ' + k, P(v))).join('')
        + fila('Aprobado / actualizado / liberación', `${this._dia(p.aprobado)} / ${this._dia(p.actualizado)} / ${this._dia(p.liberacion)}`))).join('')}
      ${ev ? sec(`Envío (${ev.tipo_logistico || '—'}, ${ev.estado || '—'})`, fila('Costo declarado en el envío', P(ev.costo_declarado_en_envio))
        + (ev.costos ? fila('Costo total (gross_amount)', P(ev.costos.gross_amount)) + Object.entries(ev.costos.receptor || {}).map(([k, v]) => fila('Receptor · ' + k, P(v))).join('') + (ev.costos.emisores || []).map((s, i) => Object.entries(s).map(([k, v]) => fila(`Emisor ${i + 1} · ${k}`, P(v))).join('')).join('') : '')) : ''}
      ${cands.length ? sec('Todas las fuentes de montos «extra» (✔ = coincide con la diferencia)', cands.map(c => fila((c.coincide ? '✔ ' : '') + c.fuente, P(c.monto))).join('')) : ''}
      <div class="mf-nota">Solo lectura. Muestra importes y estados; no trae datos del comprador.</div>`);
  },

  // ── Pantalla ──
  pintar() { const r = document.getElementById('mc-raiz'); if (r) r.innerHTML = this._interior(); },
  vista() { return `<div class="card mf-card" id="mc-raiz">${this._interior()}</div>`; },

  _par(g, v, formato) {
    const a = this._num(g), b = this._num(v);
    if (a !== null && b !== null && Math.round(a * 100) === Math.round(b * 100)) return `<span>${this._e(formato(b))}</span>`;
    return `<span style="color:var(--text-secondary)">${this._e(formato(a))}</span> → <b>${this._e(formato(b))}</b>`;
  },

  _interior() {
    const e = s => this._e(s);
    const corriendo = this._est === 'corriendo';
    const hayCuenta = !!this._cuenta();
    const pct = this._total ? Math.min(100, Math.round((this._rev / this._total) * 100)) : null;
    const barra = (corriendo || this._rev > 0)
      ? `<div style="margin-top:10px">
          <div style="height:8px;border-radius:4px;background:var(--bg-elevated);overflow:hidden"><div id="mc-barra" style="height:100%;width:${pct === null ? 100 : pct}%;background:var(--blue);${pct === null && corriendo ? 'opacity:.4' : ''}"></div></div>
          <div style="font-size:11.5px;color:var(--text-secondary);margin-top:4px">${e(this._rev)}${this._total !== null ? ' de ' + e(this._total) : ''} orden(es) revisadas · ${e(this._pagos)} pago(s) consultados${pct !== null ? ' · ' + e(pct) + ' %' : ''}</div>
        </div>` : '';
    const colorAviso = { error: 'var(--red)', aviso: 'var(--amber)', info: 'var(--text-secondary)' }[this._msgTipo] || 'var(--text-secondary)';
    const botones = [];
    if (!corriendo) botones.push(`<button class="btn btn-sm btn-primary" id="mc-btn-iniciar" onclick="MeliComparar.iniciar()"${hayCuenta ? '' : ' disabled'}><i class="ti ti-scale"></i> ${this._est === 'inactivo' ? 'Comparar pagos' : 'Empezar de nuevo'}</button>`);
    if (corriendo) botones.push(`<button class="btn btn-sm" id="mc-btn-pausar" onclick="MeliComparar.pausar()"${this._pedirPausa ? ' disabled' : ''}><i class="ti ti-player-pause"></i> Pausar</button>`);
    if (this._est === 'pausado' || this._est === 'error') botones.push(`<button class="btn btn-sm btn-primary" id="mc-btn-reanudar" onclick="MeliComparar.reanudar()"><i class="ti ti-player-play"></i> Reanudar</button>`);
    const exportar = this._filas.length
      ? `<button class="btn btn-sm" id="mc-btn-copiar" onclick="MeliComparar.copiar()"><i class="ti ti-copy"></i> Copiar lista</button>
         <button class="btn btn-sm" id="mc-btn-excel" onclick="MeliComparar.descargar()"><i class="ti ti-file-spreadsheet"></i> Descargar para Excel</button>` : '';

    let cuerpo = '';
    if (this._est !== 'inactivo') {
      const lista = this.ordenadas(), visibles = lista.slice(0, this._limite);
      const sumaNeto = lista.reduce((t, d) => t + (this._difNeto(d) || 0), 0);
      const acre = lista.filter(d => d.acreditado).length;
      const resumen = this._est === 'listo' || this._filas.length
        ? `<div style="font-size:12.5px;margin-top:10px">${this._est === 'listo'
            ? (lista.length ? `Listo: <b>${e(lista.length)}</b> orden(es) con diferencia de ${e(this._rev)} revisadas.` : `Listo: las ${e(this._rev)} órdenes revisadas coinciden con Mercado Pago.`)
            : `<b>${e(lista.length)}</b> con diferencia hasta ahora.`}
            ${lista.length ? ` Diferencia total en lo que llega: <b>${e(this._con(Math.round(sumaNeto * 100) / 100))}</b> · ya acreditadas: <b>${e(acre)}</b>.` : ''}
            ${this._conErrores ? `<div style="color:var(--amber)">${e(this._conErrores)} orden(es) con pagos que no se pudieron consultar.</div>` : ''}</div>` : '';
      const cargos = Object.entries(this._ret.por_cargo).sort((a, b) => a[0].localeCompare(b[0]));
      const retenciones = (cargos.length || this._ret.incompletas)
        ? `<div class="mf-panel" id="mc-retenciones"><b>Retenciones e impuestos sufridos</b> (parte normal del costo de canal; no se marcan como diferencia)
            <table style="font-size:12px;margin-top:4px">${cargos.map(([k, v]) => `<tr><td style="padding:1px 14px 1px 0">${e(k)}</td><td class="mf-der"><b>${e(this._pesos(v))}</b></td></tr>`).join('')}
            <tr><td style="padding:3px 14px 1px 0"><b>Total</b> (${e(this._ret.ordenes)} orden(es) con retención)</td><td class="mf-der"><b>${e(this._pesos(this._ret.total))}</b></td></tr></table>
            ${this._ret.incompletas ? `<div style="color:var(--amber);font-size:11.5px">${e(this._ret.incompletas)} orden(es) no se pudieron revisar por completo (un pago sin leer o más pagos de los que se revisan): su retención NO está sumada, el total puede ser mayor.</div>` : ''}
            <div class="mf-acciones" style="justify-content:flex-start"><button class="btn btn-sm" id="mc-btn-copiar-ret" onclick="MeliComparar.copiarRetenciones()"><i class="ti ti-copy"></i> Copiar retenciones</button></div></div>` : '';
      const filas = visibles.map(d => {
        const dif = this._difNeto(d);
        const colorDif = dif === null ? 'inherit' : (dif > 0 ? 'var(--green)' : 'var(--red)');
        const lib = (d.liberacion_guardada || d.liberacion_viva)
          ? (d.liberacion_guardada === d.liberacion_viva ? e(this._dia(d.liberacion_viva)) : `<span style="color:var(--text-secondary)">${e(this._dia(d.liberacion_guardada))}</span> → <b>${e(this._dia(d.liberacion_viva))}</b>`) : '—';
        return `<tr>
          <td data-l="Orden" style="font-family:monospace">${e(d.orden)}</td>
          <td data-l="Producto">${e(this._titulos[d.orden] || '—')}</td>
          <td data-l="Cobrado" class="mf-der">${this._par(d.cobrado_guardado, d.cobrado_vivo, x => this._pesos(x))}</td>
          <td data-l="Llega" class="mf-der">${this._par(d.neto_guardado, d.llega_real_vivo ?? d.neto_vivo, x => this._pesos(x))}</td>
          <td data-l="Costo de canal" class="mf-der">${this._par(d.costo_canal_guardado, d.costo_canal_real, x => this._pesos(x))}</td>
          <td data-l="Diferencia" class="mf-der" style="color:${colorDif};font-weight:600">${e(this._con(dif))}</td>
          <td data-l="Estado">${e(this._estadoTexto(d))}</td>
          <td data-l="Liberación">${lib}</td>
          <td data-l="Qué cambió" style="font-size:11.5px">${e(this._motivosTexto(d))} <button class="btn btn-sm" onclick="MeliComparar.verDesglose('${String(d.orden).replace(/\D/g, '')}')" style="margin-left:4px">Ver desglose</button></td>
        </tr>`;
      }).join('');
      cuerpo = `${resumen}${retenciones}${lista.length ? `<div class="mf-tabla"><table style="min-width:980px"><thead><tr><th>Orden</th><th>Producto</th><th class="mf-der">Cobrado (guardado → actual)</th><th class="mf-der">Llega a la cuenta (guardado → real)</th><th class="mf-der">Costo de canal (guardado → real)</th><th class="mf-der">Diferencia</th><th>Estado</th><th>Liberación</th><th>Qué cambió</th></tr></thead><tbody>${filas}</tbody></table></div>
        ${lista.length > visibles.length ? `<div class="mf-acciones"><button class="btn btn-sm" onclick="MeliComparar.verMas()">Ver más (${e(lista.length - visibles.length)})</button><span></span></div>` : ''}` : ''}`;
    }

    return `
      <div class="mf-cab"><b>Comparar pagos con Mercado Pago</b><span>${corriendo ? 'Comparando…' : ''}</span></div>
      <div class="mf-nota">Solo lectura: no cambia ventas, cajas, stock ni facturas. Compara lo que el CRM guardó de cada orden (monto cobrado, lo que llega a la cuenta, estado y fecha de liberación) con lo que Mercado Pago informa hoy,
        y lista las que difieren (por ejemplo, un pago que se ajustó después de la venta). Mira solo el pago; no trae datos del comprador.</div>
      <div class="mf-filtros" style="grid-template-columns:repeat(2,minmax(150px,220px))">
        <label>Desde<input id="mc-desde" type="date" value="${e(this._selDesde || this.DESDE_INICIAL)}" onchange="MeliComparar.cambiaRango()"${corriendo ? ' disabled' : ''}></label>
        <label>Hasta (opcional, sin incluir ese día)<input id="mc-hasta" type="date" value="${e(this._selHasta || '')}" onchange="MeliComparar.cambiaRango()"${corriendo ? ' disabled' : ''}></label></div>
      ${corriendo ? '' : `<div class="mf-acciones" style="justify-content:flex-start;flex-wrap:wrap;margin-top:6px"><button class="btn btn-sm" onclick="MeliComparar.rango('mes')">Este mes</button><button class="btn btn-sm" onclick="MeliComparar.rango('anterior')">Mes anterior</button><button class="btn btn-sm" onclick="MeliComparar.rango('octubre')">Desde el 1/10</button></div>`}
      <div class="mf-acciones" style="justify-content:flex-start;flex-wrap:wrap">${botones.join('')}${exportar}</div>
      ${!hayCuenta ? '<div class="mf-nota" style="color:var(--amber)">No hay una cuenta de Mercado Libre conectada.</div>' : ''}
      ${(this._est === 'pausado' || this._est === 'error') ? `<div class="mf-nota">«Reanudar» sigue con el rango de esta comparación (${e(this._dia(this._desde))} → ${this._hasta ? e(this._dia(this._hasta)) : 'hoy'}); para otro rango, «Empezar de nuevo».</div>` : ''}
      ${this._msg ? `<div class="mf-nota" style="color:${colorAviso}">${e(this._msg)}</div>` : ''}
      ${barra}${cuerpo}${this._vistaDesglose()}`;
  },
};
window.MeliComparar = MeliComparar;
