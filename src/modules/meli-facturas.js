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
      if (typeof cliente.rpc === 'function') await this.cargarAnual(cliente);
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
  _pesos(centavos) { return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 2 }).format(Number(centavos || 0) / 100); },
  // Porcentaje del límite usado y color: amarillo desde 70 %, rojo desde 90 %. Sin límite configurado no hay porcentaje.
  estadoAnual(a) {
    const limite = Number(a && a.limite_centavos || 0), total = Number(a && a.total_centavos || 0);
    if (!(limite > 0)) return { pct: null, clase: 'b-gray', txt: 'Sin límite configurado' };
    const pct = Math.round((total / limite) * 1000) / 10;
    return { pct, clase: pct >= 90 ? 'b-red' : pct >= 70 ? 'b-amber' : 'b-green', txt: pct >= 100 ? 'Límite superado' : pct >= 90 ? 'Cerca del límite' : pct >= 70 ? 'Atención' : 'En rango' };
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
      <div style="margin-top:4px">Total <b>${e(this._pesos(a.total_centavos))}</b>${Number(a.limite_centavos) > 0 ? ` de <b>${e(this._pesos(a.limite_centavos))}</b>` : ''} · desde el CRM ${e(this._pesos(a.facturado_crm_centavos))} (${e(a.cantidad)} facturas) · fuera del CRM ${e(this._pesos(a.fuera_crm_centavos))}</div>
      ${barra}
      ${meses ? `<div style="font-size:11.5px;color:var(--text-secondary);line-height:1.6">${meses}</div>` : ''}
      <div style="font-size:11.5px;color:var(--text-secondary);margin-top:6px">Es un seguimiento interno: no bloquea ninguna factura. Cuenta solo las facturas reales (producción) autorizadas por ARCA desde el CRM; las de prueba no suman. Las notas de crédito se restarán cuando se agreguen.</div>
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
    return Number(ent) * 100 + Number((dec + '00').slice(0, 2));
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
    if (State.meliFacturasAusente) return this.tarjetaAnual();
    const n = State.meliFacturasError ? 0 : this.contar(ordenes);
    return this.tarjetaAnual() + `<div class="card" style="margin-bottom:10px;font-size:12px">${State.esc(this.TEXTO)}<p>${State.esc(this.REABRIR)}</p><p>Cancelar o revertir la orden no cambia su factura.</p>${State.meliFacturasError ? '<p>Control de facturas no disponible. Probá actualizar.</p>' : `${n > 0 ? `<p>${n} ventas de Mercado Libre sin factura <button class="btn btn-sm" onclick="MeliFacturas.filtrar(true)">Ver</button></p>` : ''}<button class="btn btn-sm ${this._soloSinFactura ? 'btn-primary' : ''}" onclick="MeliFacturas.filtrar()">Sin factura</button>`}</div>`;
  },
  filtrar(ver) { this._soloSinFactura = ver === true || !this._soloSinFactura; MeliOrdenes.filtrar('todas'); },
  async accion(btn) {
    const orden = btn.dataset.orden, estado = btn.dataset.estado;
    const version = this.de({ orderId: orden }).version ?? null;
    if (estado === 'pendiente') {
      if (confirm(`¿Reabrir la factura como pendiente? ${this.REABRIR}`)) await this.marcar(orden, estado, {}, btn, version);
      return;
    }
    const dialog = document.createElement('dialog');
    const e = s => State.esc(String(s));
    dialog.innerHTML = `<form><p>${e(this.TEXTO)}</p>${estado === 'emitida' ? `<label>Tipo de comprobante <select name="tipo">${['A', 'B', 'C', 'E', 'M'].map(t => `<option value="${t}">Factura ${t}</option>`).join('')}</select></label><label>Punto de venta <input name="pto_venta" type="number" min="1" max="99999" step="1" required></label><label>Número <input name="numero" type="number" min="1" max="99999999" step="1" required></label><label>Fecha de emisión <input name="emitida_el" type="date" max="${this.hoy()}" value="${this.hoy()}" required></label>` : `<label>Motivo <select name="motivo" required><option value="">Elegí un motivo</option>${Object.entries(this.MOTIVOS).map(([k, v]) => `<option value="${e(k)}">${e(v)}</option>`).join('')}</select></label>`}<button type="submit">Registrar</button><button type="button">Cancelar</button></form>`;
    dialog.querySelector('button[type="button"]').onclick = () => dialog.close();
    dialog.onclose = () => dialog.remove();
    dialog.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget, datos = Object.fromEntries(new FormData(form));
      if (estado === 'emitida') { datos.pto_venta = Number(datos.pto_venta); datos.numero = Number(datos.numero); }
      if (await this.marcar(orden, estado, datos, form.querySelector('button[type="submit"]'), version)) dialog.close();
    };
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
