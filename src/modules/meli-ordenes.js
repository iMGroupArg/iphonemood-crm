// Órdenes de Mercado Libre: procesar (stock + venta), acreditar (cuando MELI libera la
// plata) y revertir (cancelación / devolución, siempre a mano).
//
// Todo el movimiento de stock y de plata lo hacen tres funciones de la base
// (db/pendientes/meli_ventas_migration.sql), cada una en UNA transacción e idempotente:
// este módulo solo las llama y muestra el resultado. NUNCA toca saldos ni stock por su
// cuenta, y NO hay montos editables de la orden: bruto y neto los pone el servidor leyendo
// Mercado Libre. Lo único que se carga a mano es la cotización (al procesar) y, si hace
// falta, el monto que de verdad llegó (al acreditar).
//
// MODO OBSERVACIÓN: las órdenes se registran solas, pero convertirlas en venta, descontar
// stock y tocar la caja es un botón por orden hasta que haya confianza.
const MeliOrdenes = {
  _filtro: 'pendientes',
  _limite: 60,

  ERRORES: {
    COTIZACION_INVALIDA: 'La cotización tiene que ser mayor a cero.',
    ORDEN_INEXISTENTE: 'La orden ya no existe. Actualizá la pantalla.',
    ORDEN_REVERTIDA: 'Esta orden ya fue revertida.',
    ORDEN_EN_REVISION: 'La orden está en revisión: hay que resolver el motivo antes de procesarla o acreditarla.',
    ORDEN_NO_PAGADA: 'La orden todavía no figura como pagada en Mercado Libre.',
    ORDEN_NO_PROCESADA: 'La orden todavía no se procesó.',
    ORDEN_SIN_ITEMS: 'La orden no tiene productos.',
    ITEMS_SIN_VINCULAR: 'Hay productos sin vincular a una fila del stock. Vinculá las publicaciones primero.',
    MONEDA_NO_SOPORTADA: 'La orden no está en pesos: no se puede procesar automáticamente.',
    BRUTO_DESCONOCIDO: 'No se conoce el importe de la venta.',
    FINANCIERA_INCOMPLETA: 'Todavía faltan datos del pago en Mercado Libre. Esperá a que se completen.',
    IMPORTES_INCOMPLETOS: 'Faltan importes o la fecha de liberación. Esperá a que se completen.',
    TODAVIA_NO_LIBERADA: 'Mercado Libre todavía no liberó esta plata.',
    CUENTA_SIN_CAJA: 'La cuenta de Mercado Libre no tiene una caja asignada (pantalla Mercado Libre → Asignar caja).',
    MONTO_INVALIDO: 'El monto no es válido.',
    MONTO_MAYOR_AL_BRUTO: 'El monto es mayor al total de la venta: revisá lo que cargaste.',
    MONTO_MENOR_AL_NETO: 'El monto es menor al que informó Mercado Libre. Si es lo que de verdad llegó y no va a llegar más, tildá «liquidación final».',
    VENTA_SIN_COTIZACION: 'La venta no tiene cotización guardada.',
    ACREDITACION_SIN_DATOS: 'No se sabe en qué caja entró la plata: revisalo a mano.',
    'no autorizado': 'Tu usuario no está autorizado.',
  },
  _msgError(error) {
    const m = String(error?.message || error || '');
    for (const k of Object.keys(this.ERRORES)) if (m.includes(k)) return this.ERRORES[k];
    return m ? `No se pudo completar: ${State.esc(m)}` : 'No se pudo completar.';
  },

  render() { return ''; },

  async cargar() {
    await DB.cargarMeliOrdenes();
    this.pintar();
  },

  pintar() {
    const root = document.getElementById('meli-ordenes-root');
    if (!root) return;
    root.innerHTML = this._vista();
  },

  _estadoDe(o) {
    if (o.revertidaEn) return { clave: 'cerradas', txt: 'Revertida', clase: 'b-gray' };
    if (o.revisar) return { clave: 'revision', txt: 'Revisar', clase: 'b-red' };
    if (!o.procesada) return { clave: 'pendientes', txt: 'Para procesar', clase: 'b-amber' };
    if (o.acreditado) return { clave: 'cerradas', txt: 'Acreditada', clase: 'b-green' };
    if (!o.financieraCompleta) return { clave: 'acreditar', txt: 'Esperando datos del pago', clase: 'b-amber' };
    if (o.fechaLiberacion && new Date(o.fechaLiberacion) > new Date()) return { clave: 'acreditar', txt: 'Se libera ' + this._dia(o.fechaLiberacion), clase: 'b-blue' };
    return { clave: 'acreditar', txt: 'Lista para acreditar', clase: 'b-green' };
  },
  _dia(iso) { try { return new Date(iso).toLocaleDateString('es-AR'); } catch { return '—'; } },
  _ars(n) { return n === null || n === undefined ? '—' : State.fmtARS(n); },

  _vista() {
    const e = s => State.esc(s == null ? '' : String(s));
    if (State.meliError) {
      return `<div class="card" style="font-size:13px;color:var(--text-secondary)">No se pudieron leer las órdenes de Mercado Libre. Si es la primera vez, falta correr la migración
        (db/pendientes/meli_esquema_base.sql y meli_ventas_migration.sql).</div>`;
    }
    const todas = State.meliOrdenes || [];
    const pend = State.meliPendienteLiberar();
    const FILTROS = { pendientes: 'Para procesar', acreditar: 'Para acreditar', revision: 'En revisión', cerradas: 'Cerradas', todas: 'Todas' };
    const cuenta = k => k === 'todas' ? todas.length : todas.filter(o => this._estadoDe(o).clave === k).length;
    const lista = (this._filtro === 'todas' ? todas : todas.filter(o => this._estadoDe(o).clave === this._filtro));
    const visibles = lista.slice(0, this._limite);

    const tabs = Object.entries(FILTROS).map(([k, t]) =>
      `<button class="btn btn-sm ${this._filtro === k ? 'btn-primary' : ''}" onclick="MeliOrdenes.filtrar('${k}')">${t} (${cuenta(k)})</button>`).join('');

    const tarjetas = visibles.map(o => {
      const est = this._estadoDe(o);
      const items = (o.items || []).map(i => `${i.cantidad || 1}× ${e(i.titulo || 'producto')}`).join(', ');
      const retenido = (o.bruto !== null && o.neto !== null && o.financieraCompleta) ? this._ars(o.bruto - o.neto) : '—';
      let acciones = '';
      if (!o.revertidaEn && !o.revisar && !o.procesada) {
        acciones = `
          <input type="number" id="meliord-cot-${o.id}" value="${Math.round(State.refBlue || 0)}" min="1" step="1" title="Cotización ARS por USD, se congela en la venta"
            style="width:90px;font-size:12px;padding:6px 8px;border:1px solid var(--border-strong);border-radius:8px">
          <button class="btn btn-primary btn-sm" onclick="MeliOrdenes.procesar(${o.id}, this)"><i class="ti ti-player-play"></i> Procesar</button>`;
      } else if (!o.revertidaEn && !o.revisar && o.procesada && !o.acreditado && o.financieraCompleta && o.neto !== null
                 && o.fechaLiberacion && new Date(o.fechaLiberacion) <= new Date()) {
        acciones = `
          <input type="number" id="meliord-monto-${o.id}" value="${o.neto}" min="0" step="0.01" title="Lo que REALMENTE llegó a la cuenta de Mercado Pago"
            style="width:120px;font-size:12px;padding:6px 8px;border:1px solid var(--border-strong);border-radius:8px">
          <label style="font-size:11px;display:flex;align-items:center;gap:4px" title="Marcalo solo si llegó menos que el neto informado y ya no va a llegar más">
            <input type="checkbox" id="meliord-fin-${o.id}"> liquidación final</label>
          <button class="btn btn-primary btn-sm" onclick="MeliOrdenes.acreditar(${o.id}, this)"><i class="ti ti-check"></i> Confirmar acreditación</button>`;
      }
      if (o.procesada && !o.revertidaEn) {
        acciones += `<button class="btn btn-sm" style="color:var(--red)" onclick="MeliOrdenes.revertir(${o.id}, this)"><i class="ti ti-arrow-back-up"></i> Revertir</button>`;
      }
      return `
        <div class="card" style="margin-bottom:8px">
          <div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap">
            <div style="flex:1;min-width:220px">
              <div style="font-size:13px;font-weight:600">Orden ${e(o.orderId)} · ${e(o.comprador || 'comprador')}</div>
              <div style="font-size:11.5px;color:var(--text-secondary)">${this._dia(o.fechaOrden)} · ${items || 'sin productos'}</div>
            </div>
            <span class="badge ${est.clase}">${est.txt}</span>
          </div>
          <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:8px;font-size:12px">
            <span>Venta <b>${this._ars(o.bruto)}</b></span>
            <span>Llega <b>${this._ars(o.neto)}</b></span>
            <span title="Comisión + envío de Mercado Libre">Se queda MELI <b>${retenido}</b></span>
            <span>Libera <b>${o.fechaLiberacion ? this._dia(o.fechaLiberacion) : '—'}</b></span>
            ${o.acreditado ? `<span>Acreditado <b>${this._ars(o.montoAcreditado)}</b></span>` : ''}
            ${o.ventaId ? `<span>Venta #${o.ventaId}</span>` : ''}
          </div>
          ${o.revisar ? `<div style="font-size:12px;color:var(--red);margin-top:6px"><i class="ti ti-alert-triangle"></i> ${e(o.motivoRevisar || 'Hay que revisar esta orden')}</div>` : ''}
          ${acciones ? `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px">${acciones}</div>` : ''}
        </div>`;
    }).join('');

    return `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
        <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;flex:1">Ventas de Mercado Libre</h3>
        <button class="btn btn-sm" onclick="MeliOrdenes.cargar()"><i class="ti ti-refresh"></i> Actualizar</button>
      </div>
      <div class="card" style="margin-bottom:10px;display:flex;gap:24px;flex-wrap:wrap">
        <div><div style="font-size:22px;font-weight:600;color:var(--amber)">${this._ars(pend.ars)}</div>
          <div style="font-size:11.5px;color:var(--text-secondary)">a liberar (${pend.ordenes} orden${pend.ordenes === 1 ? '' : 'es'}${pend.sinDato ? `, ${pend.sinDato} sin importe confirmado` : ''})</div></div>
        <div style="font-size:11.5px;color:var(--text-secondary);max-width:520px;line-height:1.5">
          Plata ya vendida que Mercado Libre todavía no depositó. No está en las cajas hasta que confirmes la acreditación.
          «Procesar» descuenta el stock y crea la venta; «Confirmar acreditación» mueve la plata a la caja cuando Mercado Libre la libera.</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${tabs}</div>
      ${tarjetas || '<div class="card" style="font-size:13px;color:var(--text-secondary)">No hay órdenes en esta vista.</div>'}
      ${lista.length > visibles.length ? `<button class="btn btn-sm" onclick="MeliOrdenes.verMas()">Ver más (${lista.length - visibles.length} más)</button>` : ''}`;
  },

  filtrar(k) { this._filtro = k; this._limite = 60; this.pintar(); },
  verMas() { this._limite += 60; this.pintar(); },

  // ── Acciones: cada una es UNA llamada a la base, que decide todo en una transacción ──
  async _llamar(boton, fn, args, okTexto) {
    const btn = boton || null;
    if (btn) btn.disabled = true;
    try {
      const { data, error } = await supa.rpc(fn, args);
      if (error) { toast(this._msgError(error)); return null; }
      if (data && data.ok === false) { toast(`No se pudo: ${State.esc(data.motivo || 'la orden quedó en revisión')}`); await this._recargar(); return null; }
      if (okTexto) toast(okTexto(data));
      await this._recargar();
      return data;
    } catch (err) {
      // Sin respuesta: NO se sabe si se aplicó. Es seguro mirar de nuevo: las tres
      // funciones son idempotentes, así que repetir el botón no duplica nada.
      console.error(fn, err);
      toast('Se cortó la conexión y no se sabe si se aplicó. Actualizá la pantalla antes de volver a intentar: repetirlo no duplica nada.');
      return null;
    } finally {
      if (btn) btn.disabled = false;
    }
  },
  async _recargar() {
    // Stock, ventas y cajas cambiaron en la base: se vuelve a leer todo.
    await DB.cargarTodo();
    this.pintar();
    if (typeof App !== 'undefined' && App.actualizarBadges) App.actualizarBadges();
  },

  async procesar(id, btn) {
    const cot = parseFloat(document.getElementById(`meliord-cot-${id}`)?.value);
    if (!(cot > 0)) { toast('Ingresá la cotización (ARS por dólar).'); return; }
    if (!confirm(`¿Procesar esta orden?\n\nSe descuenta el stock y se crea la venta con la cotización $${cot.toLocaleString('es-AR')} (queda fija).`)) return;
    await this._llamar(btn, 'meli_procesar_orden', { p_orden_id: id, p_cotizacion: cot },
      d => d.ya_procesada ? 'La orden ya estaba procesada.' : `Orden procesada: venta #${d.venta_id} creada y stock descontado.`);
  },

  async acreditar(id, btn) {
    const o = (State.meliOrdenes || []).find(x => x.id === id);
    if (!o) return;
    const monto = parseFloat(document.getElementById(`meliord-monto-${id}`)?.value);
    const final = !!document.getElementById(`meliord-fin-${id}`)?.checked;
    if (!(monto > 0)) { toast('Ingresá el monto que llegó a la cuenta.'); return; }
    if (!confirm(`¿Confirmar que llegaron ${State.fmtARS(monto)} a la cuenta de Mercado Pago?\n\nSe acredita en la caja y la venta queda cobrada.${final ? '\n\nSe toma como liquidación FINAL.' : ''}`)) return;
    // Si coincide con el neto informado no se manda: así la base usa SU neto (sin redondeos del campo).
    const args = { p_orden_id: id, p_monto_real: (o.neto !== null && Math.abs(monto - o.neto) < 0.005) ? null : monto, p_liquidacion_final: final };
    await this._llamar(btn, 'meli_acreditar_orden', args,
      d => d.ya_acreditada ? 'La orden ya estaba acreditada.' : `Acreditados ${State.fmtARS(d.monto)} en la caja. Costo de Mercado Libre: ${State.fmtUSD(d.costo_canal_usd)}.`);
  },

  async revertir(id, btn) {
    const o = (State.meliOrdenes || []).find(x => x.id === id);
    const motivo = prompt('¿Por qué se revierte esta orden? (cancelación, devolución…)');
    if (motivo === null) return;
    if (!confirm(`¿Revertir la orden ${o?.orderId || ''} ENTERA?\n\nSe repone el stock${o?.acreditado ? ', se saca de la caja lo que había entrado' : ''} y la venta queda anulada. No hay devolución parcial.`)) return;
    await this._llamar(btn, 'meli_revertir_orden', { p_orden_id: id, p_motivo: motivo || null },
      d => d.ya_revertida ? 'La orden ya estaba revertida.' : 'Orden revertida: stock repuesto' + (d.caja_devuelta ? ' y plata devuelta de la caja.' : '.'));
  },
};

window.MeliOrdenes = MeliOrdenes;
