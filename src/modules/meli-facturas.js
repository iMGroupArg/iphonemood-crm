// Control de comprobantes externos: no emite ni modifica ventas.
const MeliFacturas = {
  _soloSinFactura: false,
  _ocupadas: new Set(),
  TEXTO: 'Las facturas de ARCA se emiten desde el botón «Factura» de cada venta procesada; acá también podés registrar una que emitiste por fuera. Siempre a nombre de Franco Ezequiel Velas y por el importe real de la venta.',
  REABRIR: 'Reabrir NO anula el comprobante ante ARCA; el número queda en el historial.',
  MOTIVOS: {
    no_es_venta_real: 'No es una venta real',
    cancelada_o_devuelta: 'Cancelada o devuelta',
    factura_global_de_otro_periodo: 'Factura global de otro período',
    exenta_o_no_gravada: 'Exenta o no gravada',
    otro_ver_nota_interna: 'Otro: ver nota interna',
  },
  de(orden) { return (State.meliFacturas || []).find(f => String(f.orden_id) === String(orden.orderId)) || { estado: 'pendiente' }; },
  sinFactura(o) { return !o.revertidaEn && !o.cerradaManual && !o.cerradaManualEn && !['cancelled', 'canceled', 'cancelada', 'cancelado'].includes(o.estado) && this.de(o).estado === 'pendiente'; },
  contar(ordenes) { return ordenes.filter(o => this.sinFactura(o)).length; },
  hoy() {
    const partes = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const p = tipo => partes.find(x => x.type === tipo).value;
    return `${p('year')}-${p('month')}-${p('day')}`;
  },
  numero(f) { return `${f.tipo} ${String(f.pto_venta).padStart(4, '0')}-${String(f.numero).padStart(8, '0')}`; },
  // Valores que ya vienen completos en «Marcar emitida» (se pueden corregir): Factura C, el punto de venta 3 y el número siguiente al último ya registrado en ese punto.
  PTO_VENTA_HABITUAL: 3,
  sugerida() {
    const pto = this.PTO_VENTA_HABITUAL;
    const ultimo = (State.meliFacturas || []).filter(f => f.estado === 'emitida' && Number(f.pto_venta) === pto && Number.isInteger(Number(f.numero))).reduce((m, f) => Math.max(m, Number(f.numero)), 0);
    return { tipo: 'C', pto_venta: pto, numero: ultimo > 0 && ultimo < 99999999 ? ultimo + 1 : '' };
  },
  validar(estado, datos = {}, hoy = this.hoy()) {
    const { tipo, pto_venta, numero, emitida_el, motivo } = datos;
    if (!['pendiente', 'emitida', 'no_corresponde'].includes(estado)) return 'El estado de factura no es válido.';
    if (estado === 'emitida') {
      if (!['A', 'B', 'C', 'E', 'M'].includes(tipo)) return 'Elegí un tipo de comprobante válido.';
      if (!Number.isInteger(pto_venta) || pto_venta < 1 || pto_venta > 99999) return 'Ingresá un punto de venta entero entre 1 y 99999.';
      if (!Number.isInteger(numero) || numero < 1 || numero > 99999999) return 'Ingresá un número entero entre 1 y 99999999.';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(emitida_el || '') || !Number.isFinite(Date.parse(emitida_el)) || new Date(emitida_el).toISOString().slice(0, 10) !== emitida_el) return 'Ingresá una fecha válida.';
      if (emitida_el > hoy) return 'La fecha de emisión no puede ser futura.';
    }
    if (estado === 'no_corresponde' && !Object.hasOwn(this.MOTIVOS, motivo)) return 'Elegí un motivo de la lista.';
    return null;
  },
  error(err = {}) {
    if (err.code === '42501' || /no autorizado/i.test(err.message || '')) return 'No estás autorizado para registrar facturas.';
    const mensajes = {
      FACTURA_CAMBIO_RECARGAR: 'Otra persona cambió la factura. Recargá y volvé a intentar.',
      FACTURA_YA_REGISTRADA: 'La factura ya está registrada. Reabrila antes de cambiarla.',
      FACTURA_EN_EMISION: 'La factura de esta venta se está emitiendo por ARCA en este momento. Esperá a que termine y recargá.',
      NUMERO_REPETIDO: 'Ese comprobante ya está registrado en otra orden.',
      ESTADO_INVALIDO: 'El estado de factura no es válido.', TIPO_INVALIDO: 'El tipo de comprobante no es válido.',
      PUNTO_VENTA_INVALIDO: 'El punto de venta no es válido.', NUMERO_INVALIDO: 'El número de comprobante no es válido.',
      FECHA_INVALIDA: 'La fecha de emisión no es válida o es futura.', MOTIVO_INVALIDO: 'Elegí un motivo de la lista.',
      DATOS_SOBRANTES: 'Hay datos que no corresponden al estado elegido.', ORDEN_INEXISTENTE: 'La orden no existe.',
    };
    const codigo = Object.keys(mensajes).find(k => (err.message || '').includes(k));
    // Los detalles se muestran como texto mediante alert, nunca como HTML.
    return codigo ? mensajes[codigo] + (codigo === 'NUMERO_REPETIDO' && err.details ? ` Detalle: ${err.details}` : '') : 'No se pudo registrar la factura. Actualizá antes de volver a intentar.';
  },
  async cargar(cliente) {
    try {
      const filas = [], ids = [...new Set((State.meliOrdenes || []).map(o => String(o.orderId)))];
      for (let k = 0; k < ids.length; k += 100) {
        const { data, error } = await cliente.from('meli_facturas').select('orden_id,estado,tipo,pto_venta,numero,emitida_el,motivo,version,marcada_por,marcada_en').in('orden_id', ids.slice(k, k + 100)).limit(100);
        if (error) throw error;
        filas.push(...(data || []));
      }
      State.meliFacturas = filas; State.meliFacturasError = false; State.meliFacturasAusente = false;
      if (typeof cliente.rpc === 'function') { await this.cargarAnual(cliente); await this.cargarAuto(cliente); }
      return true;
    } catch (error) {
      State.meliFacturasError = true;
      State.meliFacturasAusente = ['42P01', 'PGRST205'].includes(error.code);
      return false;
    }
  },
  tarjeta(orden) {
    const e = s => State.esc(String(s ?? ''));
    if (State.meliFacturasAusente) return '';
    if (State.meliFacturasError) return '<div style="font-size:12px">Control de facturas no disponible. Probá actualizar.</div>';
    const f = this.de(orden);
    const txt = f.estado === 'emitida' ? `Factura ${this.numero(f)}` : f.estado === 'no_corresponde' ? `Sin factura: ${Object.hasOwn(this.MOTIVOS, f.motivo) ? this.MOTIVOS[f.motivo] : 'Motivo no reconocido'}` : 'Factura pendiente';
    const clase = f.estado === 'emitida' ? 'b-green' : f.estado === 'no_corresponde' ? 'b-gray' : 'b-amber';
    const boton = (estado, texto) => `<button class="btn btn-sm" data-orden="${e(orden.orderId)}" data-estado="${estado}" onclick="MeliFacturas.accion(this)">${texto}</button>`;
    return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><span class="badge ${clase}">${e(txt)}</span>${f.estado === 'pendiente' ? boton('emitida', 'Marcar emitida…') + boton('no_corresponde', 'No corresponde…') : boton('pendiente', 'Reabrir')}</div>`;
  },
  // ── Control de facturación anual (seguimiento del tope de monotributo; NO bloquea nada) ──
  async cargarAnual(cliente) {
    try {
      const { data, error } = await cliente.rpc('arca_control_anual');
      if (error) throw error;
      State.facturacionAnual = data; State.facturacionAnualError = false;
    } catch (error) {
      State.facturacionAnual = null;
      State.facturacionAnualError = !['42883', 'PGRST202'].includes(error && error.code);   // función ausente = todavía no se corrió el script 21
    }
  },
  // ── Facturación automática (interruptores, pendientes y avisos) ──
  async cargarAuto(cliente) {
    try {
      const { data, error } = await cliente.rpc('arca_auto_estado');
      if (error) throw error;
      State.facturacionAuto = data; State.facturacionAutoError = false;
    } catch (error) {
      State.facturacionAuto = null;
      State.facturacionAutoError = !['42883', 'PGRST202'].includes(error && error.code);   // función ausente = todavía no se corrió el script 23
    }
  },
  AVISOS: {
    nota_emitida: 'Se emitió sola la nota de crédito porque la venta se canceló.',
    nota_emitida_venta_procesada: 'Se emitió sola la nota de crédito porque la venta se canceló. La venta SIGUE PROCESADA (stock y plata): revertila si corresponde.',
    fallo: 'No se pudo completar y dejó de intentar solo. Revisá el motivo y usá el botón de la venta.',
  },
  tarjetaAuto() {
    if (State.facturacionAutoError) return '<div class="card" style="margin-bottom:10px;font-size:12px">Facturación automática no disponible. Probá actualizar.</div>';
    const a = State.facturacionAuto;
    if (!a) return '';
    const e = s => State.esc(String(s ?? ''));
    const TIPO = { factura: 'Factura', nota: 'Nota de crédito' };
    const pend = (a.pendientes || []).map(p => `<div style="margin-top:4px">${e(TIPO[p.tipo] || p.tipo)} de la orden <b>${e(p.orden)}</b>${p.ambiente === 'homologacion' ? ' (prueba)' : ''}: ${p.sin_mas_intentos ? 'dejó de intentar solo' : `reintenta solo (intento ${e(p.intentos)})`} · ${e(p.error || 'sin detalle')}</div>`).join('');
    const avisos = (a.avisos || []).map(v => `<div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center"><span class="badge ${v.aviso === 'fallo' ? 'b-red' : 'b-amber'}">${e(TIPO[v.tipo] || v.tipo)} · orden ${e(v.orden)}</span><span>${e(this.AVISOS[v.aviso] || '')}${v.aviso === 'fallo' && v.error ? ' ' + e(v.error) : ''}</span><button class="btn btn-sm" data-orden="${e(v.orden)}" data-tipo="${e(v.tipo)}" data-amb="${e(v.ambiente)}" onclick="MeliFacturas.avisoVisto(this)">Entendido</button></div>`).join('');
    return `<div class="card" style="margin-bottom:10px;font-size:12.5px">
      <b>Facturación automática</b> <span class="badge ${a.factura_auto || a.nota_auto ? 'b-green' : 'b-gray'}">${a.factura_auto || a.nota_auto ? 'Encendida' : 'Apagada'}</span>
      <div style="font-size:11.5px;color:var(--text-secondary);margin:4px 0 8px;line-height:1.5">Apagada por defecto. Con el interruptor de facturas, el sistema emite solo la factura de cada venta <b>pagada desde el momento en que lo encendés</b> (no las anteriores), sin procesar la venta. Con el de notas, emite solo la nota de crédito total cuando una venta ya facturada se cancela en Mercado Libre. Reembolsos parciales, devoluciones y reclamos siguen manuales. Si falla, reintenta unas pocas veces y te avisa acá. En producción emite facturas reales.</div>
      <div style="display:flex;gap:18px;flex-wrap:wrap">
        <label><input type="checkbox" id="fauto-factura" ${a.factura_auto ? 'checked' : ''}> Facturar solas las ventas nuevas</label>
        <label><input type="checkbox" id="fauto-nota" ${a.nota_auto ? 'checked' : ''}> Emitir sola la nota de crédito al cancelarse</label>
        <button class="btn btn-sm btn-primary" onclick="MeliFacturas.guardarAuto(this)">Guardar</button>
      </div>
      ${a.ambiente ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:4px">Encendida para: <b>${e(this.NOMBRE_MODO[a.ambiente] || a.ambiente)}</b>${a.desde && a.factura_auto ? ' · factura sola desde ' + e(new Date(a.desde).toLocaleString('es-AR')) : ''}${a.actualizado_por ? ' · ' + e(a.actualizado_por) : ''}. Si el ambiente de ARCA cambia, hay que volver a encenderla.</div>` : ''}
      ${avisos}
      ${pend ? `<div style="margin-top:8px;font-size:12px"><b>Pendientes con problemas</b>${pend}</div>` : ''}
    </div>`;
  },
  async _modoArca() {
    try {
      const token = await window.Meli?._token?.();
      const r = await fetch('/api/meli/worker', { method: 'POST', headers: { 'x-crm-token': token || '', 'Content-Type': 'application/json' }, body: JSON.stringify({ accion: 'arca_modo' }) });
      const j = await r.json();
      return ['homologacion', 'produccion'].includes(j && j.modo) ? j.modo : null;
    } catch { return null; }
  },
  NOMBRE_MODO: { homologacion: 'PRUEBAS (homologación, sin valor fiscal)', produccion: 'PRODUCCIÓN (comprobantes reales ante ARCA)' },
  async guardarAuto(btn) {
    const f = !!document.getElementById('fauto-factura')?.checked, n = !!document.getElementById('fauto-nota')?.checked;
    const actual = State.facturacionAuto || {};
    if (btn) btn.disabled = true;
    try {
      let modo = null;
      if (f || n) {
        modo = await this._modoArca();
        if (!modo) { toast('La facturación con ARCA está en simulación o no responde: no se puede encender la automática.'); return; }
        const enciende = (f && !actual.factura_auto) || (n && !actual.nota_auto) || actual.ambiente !== modo;
        if (enciende && !confirm(`Vas a ENCENDER la facturación automática en ${this.NOMBRE_MODO[modo]}. Desde ahora el sistema emitirá solo ${f ? 'las facturas de las ventas pagadas nuevas ' : ''}${n ? 'las notas de crédito de las ventas que se cancelen ' : ''}. Queda atada a este ambiente: si cambiás de ambiente hay que volver a encenderla. ¿Continuar?`)) return;
      }
      const { data, error } = await supa.rpc('arca_auto_config_guardar', { p_factura: f, p_nota: n, p_ambiente: modo });
      if (error || !data || data.ok !== true) { toast('No se pudo guardar. Probá de nuevo.'); return; }
      await this.cargarAuto(supa);
      toast('Facturación automática actualizada.');
      if (window.MeliOrdenes && MeliOrdenes.pintar) MeliOrdenes.pintar();
    } catch { toast('No se pudo guardar. Probá de nuevo.'); } finally { if (btn) btn.disabled = false; }
  },
  async avisoVisto(btn) {
    const d = btn && btn.dataset ? btn.dataset : {};
    try {
      const { data, error } = await supa.rpc('arca_auto_aviso_visto', { p_orden: d.orden, p_tipo: d.tipo, p_ambiente: d.amb });
      if (error || !data || data.ok !== true) { toast('No se pudo marcar como visto.'); return; }
      await this.cargarAuto(supa);
      if (window.MeliOrdenes && MeliOrdenes.pintar) MeliOrdenes.pintar();
    } catch { toast('No se pudo marcar como visto.'); }
  },
  _pesos(centavos) { return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 2 }).format(Number(centavos || 0) / 100); },
  // Porcentaje del límite usado y color: amarillo desde 70 %, rojo desde 90 %. Sin límite configurado no hay porcentaje.
  estadoAnual(a) {
    const limite = Number(a && a.limite_centavos || 0), total = Number(a && a.total_centavos || 0);
    if (total < 0) return { pct: null, clase: 'b-amber', txt: 'Saldo negativo: hay notas de crédito de facturas de más de 12 meses. Revisalo con tu contador' };
    if (!(limite > 0)) return { pct: null, clase: 'b-gray', txt: 'Sin límite configurado' };
    const pct = Math.round((total / limite) * 1000) / 10;
    return { pct, clase: pct >= 90 ? 'b-red' : pct >= 70 ? 'b-amber' : 'b-green', txt: pct >= 100 ? 'Límite superado' : pct >= 90 ? 'Cerca del límite' : pct >= 70 ? 'Atención' : 'En rango' };
  },
  // ── Facturas atrasadas: ponerse al día con las ventas pagadas que nunca se facturaron (script 25 + acción 'arca_atrasadas' del worker) ──
  _atr() { return State.atrasadas || (State.atrasadas = {}); },
  _mesAnterior() {
    const [y, m] = this.hoy().split('-').map(Number), ultimo = new Date(Date.UTC(y, m - 1, 0)), pm = String(ultimo.getUTCMonth() + 1).padStart(2, '0');
    return { desde: `${ultimo.getUTCFullYear()}-${pm}-01`, hasta: `${ultimo.getUTCFullYear()}-${pm}-${String(ultimo.getUTCDate()).padStart(2, '0')}` };
  },
  tarjetaAtrasadas() {
    if (State.meliFacturasAusente || State.meliFacturasError) return '';
    const e = s => State.esc(String(s ?? '')), a = this._atr(), mes = this._mesAnterior();
    const v = { desde: a.desde || mes.desde, hasta: a.hasta || mes.hasta, fecha: a.fecha || mes.hasta, pto: a.pto || 4 };
    const r = a.resumen, an = State.facturacionAnual;
    let resumen = '';
    if (r) {
      const margen = an && Number(an.limite_centavos) > 0 ? Number(an.limite_centavos) - Number(an.total_centavos) : null;
      const pasa = margen !== null && Number(r.total_centavos) > margen;
      const meses = (r.por_mes || []).map(m => `${e(m.mes)}: <b>${e(this._pesos(m.centavos))}</b> (${e(m.cantidad)})`).join(' · ');
      resumen = `<div id="atr-resumen" style="margin-top:10px"><b>${e(r.cantidad)}</b> ventas sin factura por <b>${e(this._pesos(r.total_centavos))}</b> en <b>${e(this.NOMBRE_MODO[a.modo] || a.modo)}</b>${meses ? `<div style="font-size:11.5px;color:var(--text-secondary);margin-top:2px">${meses}</div>` : ''}
        ${margen === null ? '<div style="font-size:11.5px;color:var(--text-secondary);margin-top:4px">No hay límite anual configurado: no puedo compararlo con tu categoría.</div>'
          : `<div style="font-size:11.5px;margin-top:4px;color:${pasa ? 'var(--red)' : 'var(--text-secondary)'}">${pasa ? '⚠ SUPERA' : 'Entra en'} el margen que te queda en el límite anual (${e(this._pesos(margen))}).</div>`}</div>`;
    }
    const puedeEmitir = r && Number(r.cantidad) > 0 && !a.corriendo;
    return `<div class="card" style="margin-bottom:10px;font-size:12.5px"><details${a.abierta || r || a.corriendo || a.mensaje ? ' open' : ''} ontoggle="MeliFacturas._atr().abierta = this.open">
      <summary style="cursor:pointer;font-weight:600">Emitir facturas atrasadas</summary>
      <div style="font-size:11.5px;color:var(--text-secondary);margin:6px 0 10px;line-height:1.5">Emite la factura de las ventas pagadas que nunca se facturaron, de la más vieja a la más nueva, con el punto de venta y la fecha que elijas (por ejemplo un punto de venta aparte con el último día del mes). Solo toma ventas pagadas, sin factura, no canceladas ni «en revisión». Si algo falla se detiene y te avisa; volver a empezar no duplica nada.</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px">
        <label style="display:flex;flex-direction:column;gap:4px">Ventas desde<input id="atr-desde" type="date" value="${e(v.desde)}" oninput="MeliFacturas.atrasadasCampo()"></label>
        <label style="display:flex;flex-direction:column;gap:4px">Ventas hasta<input id="atr-hasta" type="date" value="${e(v.hasta)}" oninput="MeliFacturas.atrasadasCampo()"></label>
        <label style="display:flex;flex-direction:column;gap:4px">Punto de venta<input id="atr-pto" type="number" min="1" max="99999" step="1" value="${e(v.pto)}" oninput="MeliFacturas.atrasadasCampo()"></label>
        <label style="display:flex;flex-direction:column;gap:4px">Fecha de los comprobantes<input id="atr-fecha" type="date" max="${this.hoy()}" value="${e(v.fecha)}" oninput="MeliFacturas.atrasadasCampo()"></label>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button class="btn btn-sm" onclick="MeliFacturas.atrasadasVer(this)"${a.corriendo ? ' disabled' : ''}>Ver cuántas son</button>
        ${puedeEmitir ? `<button id="atr-emitir" class="btn btn-sm btn-primary" onclick="MeliFacturas.atrasadasEmitir(this)">Emitir ${e(r.cantidad)} facturas</button>` : ''}
        ${a.corriendo ? '<button class="btn btn-sm" onclick="MeliFacturas._atrParar = true">Detener</button>' : ''}
      </div>
      ${resumen}
      <div id="atr-estado" style="margin-top:8px;font-size:12px;line-height:1.5">${a.mensaje ? e(a.mensaje) : ''}</div>
    </details></div>`;
  },
  atrasadasCampo() {
    const a = this._atr(), g = id => document.getElementById(id) && document.getElementById(id).value;
    a.desde = g('atr-desde'); a.hasta = g('atr-hasta'); a.fecha = g('atr-fecha'); a.pto = g('atr-pto');
    // Si lo que está en pantalla ya no es lo que se consultó, el resumen deja de valer: se oculta y hay que volver a «Ver cuántas son».
    const c = a.consulta;
    if (c && (a.desde !== c.desde || a.hasta !== c.hasta || a.fecha !== c.fecha || Number(a.pto) !== Number(c.pto))) {
      a.resumen = null; a.consulta = null;
      for (const id of ['atr-emitir', 'atr-resumen']) { const el = document.getElementById(id); if (el && el.style) el.style.display = 'none'; }
    }
  },
  _atrDatos() {
    const g = id => (document.getElementById(id) || {}).value;
    return { desde: g('atr-desde'), hasta: g('atr-hasta'), fecha: g('atr-fecha'), pto_venta: Number(g('atr-pto')) };
  },
  _atrEstado(texto) { const a = this._atr(); a.mensaje = texto; const el = document.getElementById('atr-estado'); if (el) el.textContent = texto; },
  async _worker(cuerpo) {
    try {
      const token = await window.Meli?._token?.();
      const r = await fetch('/api/meli/worker', { method: 'POST', headers: { 'x-crm-token': token || '', 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
      return await r.json();
    } catch { return null; }
  },
  async atrasadasVer(btn) {
    const d = this._atrDatos(), a = this._atr();
    if (!d.desde || !d.hasta || d.desde > d.hasta) { toast('Revisá el rango de fechas de las ventas.'); return; }
    if (btn) btn.disabled = true;
    try {
      const modo = await this._modoArca();
      if (!modo) { toast('La facturación con ARCA está en simulación o no responde.'); return; }
      const { data, error } = await supa.rpc('arca_atrasadas_resumen', { p_desde: d.desde, p_hasta: d.hasta, p_ambiente: modo });
      if (error || !data) { toast(error && /RANGO_INVALIDO/.test(error.message || '') ? 'El rango de fechas no es válido.' : 'No se pudo calcular. ¿Falta correr el script 25?'); return; }
      Object.assign(a, { desde: d.desde, hasta: d.hasta, fecha: d.fecha, pto: d.pto_venta, modo, resumen: data, consulta: { desde: d.desde, hasta: d.hasta, fecha: d.fecha, pto: d.pto_venta }, mensaje: '', abierta: true });
      if (window.MeliOrdenes && MeliOrdenes.pintar) MeliOrdenes.pintar();
    } catch { toast('No se pudo calcular. Probá de nuevo.'); } finally { if (btn) btn.disabled = false; }
  },
  async atrasadasEmitir(btn) {
    const a = this._atr(), r = a.resumen, c = a.consulta, ui = this._atrDatos();
    if (!r || !c || !(Number(r.cantidad) > 0) || a.corriendo) return;
    // Se emite EXACTAMENTE lo que se consultó (copia fija), y solo si lo que hay en pantalla coincide con eso.
    if (ui.desde !== c.desde || ui.hasta !== c.hasta || ui.fecha !== c.fecha || ui.pto_venta !== Number(c.pto)) { toast('Cambiaste los datos: tocá «Ver cuántas son» otra vez antes de emitir.'); return; }
    const d = { desde: c.desde, hasta: c.hasta, fecha: c.fecha, pto_venta: Number(c.pto) };
    if (!d.fecha || d.fecha > this.hoy()) { toast('La fecha de los comprobantes no puede estar vacía ni ser futura.'); return; }
    const real = a.modo === 'produccion', n = Number(r.cantidad);
    if (!confirm(`Vas a EMITIR ${n} facturas por ${this._pesos(r.total_centavos)} en ${this.NOMBRE_MODO[a.modo] || a.modo}.\nPunto de venta ${d.pto_venta}, con fecha ${d.fecha}.\n${real ? 'Son comprobantes REALES, con validez fiscal: no se pueden borrar, solo anular con una nota de crédito.' : 'Son comprobantes de prueba, sin valor fiscal.'}\n¿Seguís?`)) return;
    if (real && n >= 10 && String(prompt(`Para confirmar escribí la cantidad de facturas (${n}):`) || '').trim() !== String(n)) { toast('No coincide la cantidad: no se emitió nada.'); return; }
    this._atrParar = false; a.corriendo = true; let emitidas = 0, omitidas = 0, final = '';
    if (window.MeliOrdenes && MeliOrdenes.pintar) MeliOrdenes.pintar();
    try {
      for (;;) {
        if (this._atrParar) { final = `Detenido por vos. Emitidas ${emitidas}. Cuando quieras, «Ver cuántas son» y seguís desde donde quedó.`; break; }
        const j = await this._worker({ accion: 'arca_atrasadas', ...d });
        if (!j) { final = `No se pudo conectar con el servidor. Emitidas ${emitidas}. Volvé a tocar «Ver cuántas son» y seguí (no se duplica nada).`; break; }
        if (j.estado === 'simulacion') { final = 'ARCA está en modo simulación: no se emitió nada.'; break; }
        if (j.estado === 'error') { final = `No se pudo emitir (${j.codigo || 'error'})${j.mensaje ? ': ' + j.mensaje : ''}. Emitidas ${emitidas}.`; break; }
        emitidas += Number(j.emitidas) || 0; omitidas += Number(j.omitidas) || 0;
        if (j.estado === 'detenido') { const dt = j.detenido || {}; final = `SE DETUVO en la orden ${dt.orden || '?'}: ${dt.mensaje || dt.estado || 'problema'}. Emitidas ${emitidas}. Revisalo antes de seguir.`; break; }
        this._atrEstado(`Emitiendo… ${emitidas} emitidas, quedan ${Number(j.quedan) || 0}.`);
        if (!(Number(j.quedan) > 0)) { final = `Listo: ${emitidas} facturas emitidas${omitidas ? ` y ${omitidas} omitidas (ya no correspondían)` : ''}.`; break; }
        if (!(Number(j.emitidas) + Number(j.omitidas) > 0)) { final = `No avanzó esta vez (poco tiempo del servidor). Emitidas ${emitidas}. Tocá «Ver cuántas son» y seguí.`; break; }
      }
    } finally {
      a.corriendo = false; a.mensaje = final || a.mensaje; a.resumen = null; a.consulta = null;
      try { await this.cargar(supa); } catch { /* se actualiza al recargar */ }
      if (window.MeliOrdenes && MeliOrdenes.pintar) MeliOrdenes.pintar();
      toast(a.mensaje || 'Terminó.');
    }
  },
  tarjetaAnual() {
    const a = State.facturacionAnual;
    if (State.facturacionAnualError) return '<div class="card" style="margin-bottom:10px;font-size:12px">Control de facturación anual no disponible. Probá actualizar.</div>';
    if (!a) return '';
    const e = s => State.esc(String(s ?? ''));
    const est = this.estadoAnual(a);
    const barra = est.pct === null ? '' : `<div style="height:8px;border-radius:4px;background:var(--border);margin:8px 0;overflow:hidden"><div style="height:100%;width:${Math.min(est.pct, 100)}%;background:var(--${est.clase === 'b-red' ? 'red' : est.clase === 'b-amber' ? 'amber' : 'green'})"></div></div>`;
    const meses = (a.por_mes || []).map(m => `<span style="white-space:nowrap">${e(m.mes)}: <b>${e(this._pesos(m.centavos))}</b> (${e(m.cantidad)})</span>`).join(' · ');
    const pesos = c => (Number(c || 0) / 100).toFixed(2);
    return `<div class="card" style="margin-bottom:10px;font-size:12.5px">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><b>Facturación de los últimos 12 meses</b><span class="badge ${est.clase}">${e(est.txt)}${est.pct === null ? '' : ' · ' + e(String(est.pct).replace('.', ',')) + ' %'}</span></div>
      <div style="margin-top:4px">Total <b>${e(this._pesos(a.total_centavos))}</b>${Number(a.limite_centavos) > 0 ? ` de <b>${e(this._pesos(a.limite_centavos))}</b>` : ''} · desde el CRM ${e(this._pesos(a.facturado_crm_centavos))} (${e(a.cantidad)} facturas)${Number(a.notas_credito_centavos) > 0 ? ` menos notas de crédito ${e(this._pesos(a.notas_credito_centavos))}` : ''} · fuera del CRM ${e(this._pesos(a.fuera_crm_centavos))}</div>
      ${barra}
      ${meses ? `<div style="font-size:11.5px;color:var(--text-secondary);line-height:1.6">${meses}</div>` : ''}
      <div style="font-size:11.5px;color:var(--text-secondary);margin-top:6px">Es un seguimiento interno: no bloquea ninguna factura. Cuenta solo las facturas reales (producción) autorizadas por ARCA desde el CRM; las de prueba no suman. Las notas de crédito autorizadas se restan.</div>
      <details style="margin-top:8px"><summary style="cursor:pointer">Configurar límite y facturado fuera del CRM</summary>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:flex-end">
          <label style="font-size:11.5px">Límite anual (ARS)<br><input type="number" id="fa-limite" min="0" step="0.01" value="${pesos(a.limite_centavos)}" style="width:160px;padding:6px 8px;border:1px solid var(--border-strong);border-radius:8px"></label>
          <label style="font-size:11.5px">Facturado fuera del CRM, últimos 12 meses (ARS)<br><input type="number" id="fa-fuera" min="0" step="0.01" value="${pesos(a.fuera_crm_centavos)}" style="width:160px;padding:6px 8px;border:1px solid var(--border-strong);border-radius:8px"></label>
          <button class="btn btn-sm btn-primary" onclick="MeliFacturas.guardarAnual(this)">Guardar</button>
        </div>
        ${a.actualizado_por ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:4px">Última actualización: ${e(a.actualizado_por)}</div>` : ''}
      </details></div>`;
  },
  // Pesos con hasta dos decimales → centavos enteros, sin errores de coma flotante. null si no es un monto válido.
  aCentavos(v) {
    const t = String(v ?? '').trim().replace(',', '.');
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(t)) return null;
    const [ent, dec = ''] = t.split('.');
    const c = Number(ent) * 100 + Number((dec + '00').slice(0, 2));
    return c <= 99999999999900 ? c : null;      // el mismo tope que la base
  },
  async guardarAnual(btn) {
    const limite = this.aCentavos(document.getElementById('fa-limite')?.value), fuera = this.aCentavos(document.getElementById('fa-fuera')?.value);
    if (limite === null || fuera === null) { toast('Ingresá montos válidos en pesos (hasta dos decimales).'); return; }
    if (btn) btn.disabled = true;
    try {
      const { data, error } = await supa.rpc('arca_control_config_guardar', { p_limite_centavos: limite, p_fuera_centavos: fuera });
      if (error || !data || data.ok !== true) { toast('No se pudo guardar. Probá de nuevo.'); return; }
      await this.cargarAnual(supa);
      toast('Control de facturación actualizado.');
      if (window.MeliOrdenes && MeliOrdenes.pintar) MeliOrdenes.pintar();
    } catch { toast('No se pudo guardar. Probá de nuevo.'); } finally { if (btn) btn.disabled = false; }
  },
  cabecera(ordenes) {
    if (State.meliFacturasAusente) return this.tarjetaAuto() + this.tarjetaAnual();
    const n = State.meliFacturasError ? 0 : this.contar(ordenes);
    return this.tarjetaAuto() + this.tarjetaAnual() + this.tarjetaAtrasadas() + `<div class="card" style="margin-bottom:10px;font-size:12px">${State.esc(this.TEXTO)}<p>${State.esc(this.REABRIR)}</p><p>Cancelar o revertir la orden no cambia su factura.</p>${State.meliFacturasError ? '<p>Control de facturas no disponible. Probá actualizar.</p>' : `${n > 0 ? `<p>${n} ventas de Mercado Libre sin factura <button class="btn btn-sm" onclick="MeliFacturas.filtrar(true)">Ver</button></p>` : ''}<button class="btn btn-sm ${this._soloSinFactura ? 'btn-primary' : ''}" onclick="MeliFacturas.filtrar()">Sin factura</button>`}</div>`;
  },
  filtrar(ver) { this._soloSinFactura = ver === true || !this._soloSinFactura; MeliOrdenes.filtrar('todas'); },
  async accion(btn) {
    const orden = btn.dataset.orden, estado = btn.dataset.estado;
    const version = this.de({ orderId: orden }).version ?? null;
    if (estado === 'pendiente') {
      if (confirm(`¿Reabrir la factura como pendiente? ${this.REABRIR}`)) await this.marcar(orden, estado, {}, btn, version);
      return;
    }
    const e = s => State.esc(String(s));
    const sug = this.sugerida();
    const campos = estado === 'emitida'
      ? `<label>Tipo de comprobante <select name="tipo">${['A', 'B', 'C', 'E', 'M'].map(t => `<option value="${t}"${t === sug.tipo ? ' selected' : ''}>Factura ${t}</option>`).join('')}</select></label><label>Punto de venta <input name="pto_venta" type="number" min="1" max="99999" step="1" value="${e(sug.pto_venta)}" required></label><label>Número <input name="numero" type="number" min="1" max="99999999" step="1" value="${e(sug.numero)}" required></label><label>Fecha de emisión <input name="emitida_el" type="date" max="${this.hoy()}" value="${this.hoy()}" required></label>`
      : `<label>Motivo <select name="motivo" required><option value="">Elegí un motivo</option>${Object.entries(this.MOTIVOS).map(([k, v]) => `<option value="${e(k)}">${e(v)}</option>`).join('')}</select></label>`;
    const titulo = estado === 'emitida' ? 'Marcar factura como emitida' : 'La factura no corresponde';
    const enviar = (cerrar, boton) => async event => {
      event.preventDefault();
      const form = event.currentTarget, datos = Object.fromEntries(new FormData(form));
      if (estado === 'emitida') { datos.pto_venta = Number(datos.pto_venta); datos.numero = Number(datos.numero); }
      if (await this.marcar(orden, estado, datos, boton(form), version)) cerrar();
    };
    // Con la hoja del CRM (la misma de «Filtros» y «Período»): hoja inferior en el celular y ventana centrada en escritorio.
    if (typeof Sheet !== 'undefined') {
      const h = Sheet.abrir({ titulo, cuerpo: `<div class="dlg-crm"><form id="dlg-factura"><p>${e(this.TEXTO)}</p><div class="dlg-campos">${campos}</div></form></div>`,
        pie: '<button type="button" class="btn" data-cancelar>Cancelar</button><button type="submit" form="dlg-factura" class="btn btn-primary">Registrar</button>' });
      h.el.querySelector('[data-cancelar]').onclick = () => h.cerrar();
      h.el.querySelector('form').onsubmit = enviar(() => h.cerrar(), () => h.el.querySelector('button[type="submit"]'));
      return;
    }
    const dialog = document.createElement('dialog'); dialog.className = 'dlg-crm';
    dialog.innerHTML = `<form><h3><i class="ti ti-file-invoice"></i> ${titulo}</h3><p>${e(this.TEXTO)}</p><div class="dlg-campos">${campos}</div><div class="dlg-acciones"><button type="button" class="btn">Cancelar</button><button type="submit" class="btn btn-primary">Registrar</button></div></form>`;
    dialog.querySelector('button[type="button"]').onclick = () => dialog.close();
    dialog.onclose = () => dialog.remove();
    dialog.querySelector('form').onsubmit = enviar(() => dialog.close(), form => form.querySelector('button[type="submit"]'));
    document.body.append(dialog); dialog.showModal();
  },
  async marcar(orden, estado, datos = {}, btn, version = this.de({ orderId: orden }).version ?? null) {
    const error = this.validar(estado, datos);
    if (error) { toast(error); return false; }
    const actual = this.de({ orderId: orden });
    if (actual.estado !== 'pendiente' && estado !== 'pendiente') { toast(this.error({ message: 'FACTURA_YA_REGISTRADA' })); return false; }
    if (this._ocupadas.has(orden)) return false;
    this._ocupadas.add(orden); if (btn) btn.disabled = true;
    try {
      const emitida = estado === 'emitida';
      const r = await DB.marcarFactura({ p_orden: String(orden), p_estado: estado, p_tipo: emitida ? datos.tipo : null, p_pto_venta: emitida ? datos.pto_venta : null, p_numero: emitida ? datos.numero : null, p_emitida_el: emitida ? datos.emitida_el : null, p_motivo: estado === 'no_corresponde' ? datos.motivo : null, p_version_esperada: version });
      if (r.error || r.data?.ok !== true) { alert(this.error(r.error || {})); return false; }
      const leida = await this.cargar(supa);
      MeliOrdenes.pintar();
      toast(leida ? 'Estado de factura registrado.' : 'La factura se registró, pero no se pudo actualizar la pantalla. Probá actualizar.');
      return true;
    } catch {
      toast('No se pudo registrar la factura. Se cortó la conexión: actualizá antes de volver a intentar.');
      return false;
    } finally { this._ocupadas.delete(orden); if (btn) btn.disabled = false; }
  },
};
window.MeliFacturas = MeliFacturas;
