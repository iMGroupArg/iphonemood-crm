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
    ORDEN_YA_PROCESADA: 'Esta orden ya se procesó (tiene venta y stock descontado): no se puede cerrar a mano. Si fue un error, usá «Revertir».',
    ORDEN_CERRADA_MANUAL: 'Esta orden está cerrada a mano: no se puede procesar ni acreditar. Reabrila primero si hace falta.',
    VENTA_YA_ENLAZADA: 'Esa venta ya está enlazada a otra orden de Mercado Libre.',
    VENTA_INEXISTENTE: 'No encuentro esa venta (o está anulada). Revisá el número.',
    VENTA_NO_APLICA: 'Solo «ya la cargué a mano» admite enlazar una venta.',
    NOTA_INVALIDA: 'La nota es muy larga (máximo 200 caracteres) o tiene caracteres raros.',
    MOTIVO_INVALIDO: 'No se pudo cerrar la orden: motivo inválido.',
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
    // Una orden que entró sin vínculo queda en «revisar»; si después se vincula el aviso, SOLO
    // vuelve a poder procesarse cuando se la revalida. Se hace una por una (cada llamada es su
    // propia transacción), con tope y con una pausa por orden para no repetir en cada repintado.
    if (await this._revalidarSinVincular()) { await DB.cargarMeliOrdenes(); this.pintar(); }
  },

  _ultimaReval: {},
  _revalidando: false,
  MOTIVO_SIN_VINCULO: 'sin publicación vinculada',
  async _revalidarSinVincular() {
    if (this._revalidando) return false;
    this._revalidando = true;
    let cambio = false;
    try {
      const ahora = Date.now();
      const candidatas = (State.meliOrdenes || []).filter(o => !o.procesada && !o.revertidaEn && !o.cerradaManual && o.revisar
        && String(o.motivoRevisar || '').includes(this.MOTIVO_SIN_VINCULO)
        && !(this._ultimaReval[o.id] && ahora - this._ultimaReval[o.id] < 30000)).slice(0, 20);
      for (const o of candidatas) {
        this._ultimaReval[o.id] = Date.now();
        const r = await this._revalidarOrden(o.id);
        if (r && r.ok === true && (r.revisar !== true || !r.sin_vincular)) cambio = true;
      }
    } finally { this._revalidando = false; }
    return cambio;
  },
  // Una llamada a la base (espera como máximo 3 s por la orden). Devuelve el JSON de la base, o
  // null si falló / no respondió (nunca tira).
  async _revalidarOrden(id) {
    try {
      const { data, error } = await supa.rpc('meli_orden_revalidar', { p_orden_id: id });
      if (error || !data || typeof data !== 'object') return null;
      return data;
    } catch (e) { console.warn('meli_orden_revalidar', e); return null; }
  },
  // Botón «Revalidar» de una orden en revisión.
  async revalidar(id, btn) {
    if (btn) btn.disabled = true;
    try {
      const r = await this._revalidarOrden(id);
      if (!r) toast('No se pudo revalidar la orden. Probá de nuevo.');
      else if (r.ok !== true) toast(r.ocupada ? 'Otra operación está usando esta orden. Probá de nuevo en unos segundos.' : 'No se pudo revalidar la orden.');
      else if (r.cerrada) toast('La orden ya está procesada: no cambia.');
      else if (r.revisar) toast('Sigue en revisión: ' + State.esc(r.motivo || 'revisar a mano') + (r.sin_vincular ? '. Falta vincular alguna publicación.' : ''));
      else toast('Lista: ya se puede procesar.');
      await DB.cargarMeliOrdenes();
      this.pintar();
    } finally { if (btn) btn.disabled = false; }
  },
  // «Vincular» abre la pantalla de vínculos de Deploy-infra en ESE aviso. Los identificadores
  // vienen de data-* (nunca se pegan dentro de código JavaScript).
  vincular(btn) {
    const item = btn?.dataset?.item;
    if (!item || !window.MeliVincular || typeof window.MeliVincular.abrir !== 'function') return;
    // El tercer dato (cuenta de la orden): la pantalla de vínculos cambia a esa cuenta antes de consultar.
    window.MeliVincular.abrir(item, btn.dataset.var || null, btn.dataset.cuenta || null);
  },

  pintar() {
    const root = document.getElementById('meli-ordenes-root');
    if (!root) return;
    root.innerHTML = this._vista();
    window.Liberaciones?.actualizarBadge?.();   // el badge del menú sale de los mismos datos que la tarjeta
  },

  _estadoDe(o) {
    // Cerrada a mano (script 12): ya cargada en Ventas o descartada. No se procesa ni se acredita.
    if (o.cerradaManual) return { clave: 'cerradas', txt: o.cerradaManual.motivo === 'ya_cargada' ? 'Ya cargada a mano' : 'Descartada', clase: 'b-gray' };
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
      // Cada producto con su vínculo: «→ Stock: nombre» o «Sin vincular» + botón (si la pantalla de
      // vínculos está cargada). Sin vincular = cantidad > 0 y sin fila de stock.
      const sinVincular = (o.items || []).some(i => (i.cantidad || 0) > 0 && !i.stock_id);
      const items = (o.items || []).map(i => {
        const base = `${i.cantidad || 1}× ${e(i.titulo || 'producto')}`;
        if (o.procesada || o.revertidaEn) return base;
        if (i.stock_id) {
          const nom = (State.stock || []).find(x => x.id === i.stock_id)?.nombre;
          return `${base} <span style="color:var(--green)">→ Stock: ${e(nom || 'producto')}</span>`;
        }
        if ((i.cantidad || 0) <= 0) return `${base} <span style="color:var(--red)">(cantidad inválida)</span>`;
        // El aviso se identifica por (cuenta, publicación, variación): se pasa la cuenta de la orden y la
        // pantalla de vínculos cambia a esa cuenta antes de consultar el aviso.
        const btnV = (window.MeliVincular && i.meli_item_id)
          ? ` <button class="btn btn-sm" data-item="${e(i.meli_item_id)}" data-var="${e(i.meli_variacion_id || '')}" data-cuenta="${e(o.cuentaId == null ? '' : o.cuentaId)}" onclick="MeliOrdenes.vincular(this)">Vincular</button>`
          : '';
        return `${base} <span style="color:var(--red)">Sin vincular</span>${btnV}`;
      }).join('<br>');
      const retenido = (o.bruto !== null && o.neto !== null && o.financieraCompleta) ? this._ars(o.bruto - o.neto) : '—';
      let acciones = '';
      if (o.cerradaManual) {
        // Cerrada a mano: sin Revalidar ni Procesar; solo se puede reabrir (abajo).
      } else if (!o.revertidaEn && !o.procesada && o.revisar) {
        acciones = `<button class="btn btn-sm" onclick="MeliOrdenes.revalidar(${o.id}, this)" title="Vuelve a mirar los vínculos de esta orden"><i class="ti ti-refresh"></i> Revalidar</button>`;
      } else if (!o.revertidaEn && !o.revisar && !o.procesada) {
        acciones = sinVincular
          ? `<span style="font-size:11.5px;color:var(--text-secondary)">Falta vincular una publicación para poder procesarla.</span>
             <button class="btn btn-primary btn-sm" disabled title="Falta vincular una publicación"><i class="ti ti-player-play"></i> Procesar</button>`
          : `
          <button class="btn btn-primary btn-sm" onclick="MeliOrdenes.abrirProcesar(${o.id})" title="Revisá stock y cotización antes de procesar"><i class="ti ti-player-play"></i> Procesar…</button>`;
      } else if (!o.revertidaEn && !o.revisar && o.procesada && !o.acreditado && o.financieraCompleta && o.neto !== null
                 && o.fechaLiberacion && new Date(o.fechaLiberacion) <= new Date()) {
        acciones = `
          <input type="number" id="meliord-monto-${o.id}" value="${o.neto}" min="0" step="0.01" title="Lo que REALMENTE llegó a la cuenta de Mercado Pago"
            style="width:120px;font-size:12px;padding:6px 8px;border:1px solid var(--border-strong);border-radius:8px">
          <label style="font-size:11px;display:flex;align-items:center;gap:4px" title="Marcalo solo si llegó menos que el neto informado y ya no va a llegar más">
            <input type="checkbox" id="meliord-fin-${o.id}"> liquidación final</label>
          <button class="btn btn-primary btn-sm" onclick="MeliOrdenes.acreditar(${o.id}, this)"><i class="ti ti-check"></i> Confirmar acreditación</button>`;
      }
      acciones += `<button class="btn btn-sm" onclick="MeliOrdenes.abrirDetalle(${o.id})"><i class="ti ti-list-details"></i> Detalle</button>`;
      if (State.meliCierre !== false && !o.revertidaEn && !o.procesada && !o.cerradaManual) {
        acciones += `<button class="btn btn-sm" onclick="MeliOrdenes.abrirCierre(${o.id}, 'ya_cargada')" title="La venta ya está cargada en Ventas: cierra la orden sin descontar stock ni mover plata"><i class="ti ti-check"></i> Ya la cargué a mano</button>
          <button class="btn btn-sm" onclick="MeliOrdenes.abrirCierre(${o.id}, 'descartada')" title="No tomar en cuenta esta orden"><i class="ti ti-ban"></i> Descartar</button>`;
      }
      if (o.cerradaManual && !o.procesada) {
        acciones += `<button class="btn btn-sm" onclick="MeliOrdenes.reabrirCierre(${o.id}, this)"><i class="ti ti-arrow-back-up"></i> Reabrir</button>`;
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
          ${o.cerradaManual ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:6px"><i class="ti ti-lock"></i> ${o.cerradaManual.motivo === 'ya_cargada' ? 'Ya cargada a mano' : 'Descartada'} por ${e(o.cerradaManual.por || '—')} el ${this._dia(o.cerradaManual.en)}${o.cerradaManual.ventaId ? ` · venta #${e(o.cerradaManual.ventaId)}` : ''}${o.cerradaManual.nota ? ` · ${e(o.cerradaManual.nota)}` : ''}. No descuenta stock ni mueve plata.</div>` : ''}
          ${o.revisar ? `<div style="font-size:12px;color:var(--red);margin-top:6px"><i class="ti ti-alert-triangle"></i> ${e(o.motivoRevisar || 'Hay que revisar esta orden')}</div>` : ''}
          ${acciones ? `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px">${acciones}</div>` : ''}
        </div>`;
    }).join('');

    return `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
        <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;flex:1">Ventas de Mercado Libre</h3>
        <button class="btn btn-sm" onclick="MeliOrdenes.cargar()"><i class="ti ti-refresh"></i> Actualizar</button>
      </div>
      ${window.Liberaciones ? window.Liberaciones.tarjetaHtml() : ''}
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
    if (window.Actividades?.cargar) await window.Actividades.cargar();   // acreditar crea una actividad: el badge tiene que verla
    this.pintar();
    if (typeof App !== 'undefined' && App.actualizarBadges) App.actualizarBadges();
  },

  async procesar(id, btn) {
    const cot = parseFloat(document.getElementById(`meliord-cot-${id}`)?.value);
    if (!(cot > 0) || !Number.isFinite(cot)) { toast('Ingresá la cotización (ARS por dólar).'); return; }
    // El cuadro de verificación reemplaza al confirm(): sin la casilla tildada no se procesa.
    if (!document.getElementById(`meliord-ok-${id}`)?.checked) { toast('Tildá la casilla de verificación antes de procesar.'); return; }
    // El botón queda deshabilitado durante las DOS llamadas (revisión previa + procesar).
    const tok = this._cuadroTok;
    const firmaVerificada = this._firmas[id];   // la del cuadro que el usuario vio, capturada ANTES de esperar nada
    if (firmaVerificada === undefined) { toast('Abrí «Procesar» desde la tarjeta de la orden para verificar antes de procesar.'); return; }
    if (btn) btn.disabled = true;
    try {
      // Revisión previa: es solo una comodidad (avisa antes de intentar). La garantía real está en
      // meli_procesar_orden, que vuelve a leer el vínculo vigente dentro de SU transacción.
      const r = await this._revalidarOrden(id);
      if (!r) { toast('No se pudo revisar la orden antes de procesarla. Probá de nuevo.'); return; }
      if (r.ok !== true) {
        toast(r.ocupada ? 'Otra operación está usando esta orden. Probá de nuevo en unos segundos.' : 'No se pudo revisar la orden antes de procesarla.');
        return;
      }
      if (!r.cerrada && (r.sin_vincular || r.revisar)) {
        toast(r.sin_vincular ? 'Falta vincular una publicación de esta orden: no se procesó.' : 'La orden sigue en revisión: ' + State.esc(r.motivo || 'revisar a mano'));
        await DB.cargarMeliOrdenes();
        this.pintar();
        return;
      }
      // Lo que se verificó en el cuadro tiene que ser lo que se va a procesar: si otra pestaña
      // cambió el vínculo de algún producto (o la cantidad) mientras el cuadro estaba abierto, se
      // vuelve a empezar con los datos nuevos.
      await DB.cargarMeliOrdenes();
      const actual = State.meliError ? null : (State.meliOrdenes || []).find(x => x.id === id);
      if (!actual) {
        toast('No se pudo confirmar el estado actual de la orden. Actualizá la pantalla y probá de nuevo.');
        this.pintar();
        return;
      }
      if (this._firma(actual) !== firmaVerificada) {
        toast('Cambió el producto vinculado de esta orden mientras revisabas. Volvé a abrir «Procesar» para verificar con los datos nuevos.');
        this.pintar();
        this.cerrarCuadro(tok);
        return;
      }
      await this._llamar(btn, 'meli_procesar_orden', { p_orden_id: id, p_cotizacion: cot },
        d => d.ya_procesada ? 'La orden ya estaba procesada.' : `Orden procesada: venta #${d.venta_id} creada y stock descontado.`);
    } finally { if (btn) btn.disabled = false; this.cerrarCuadro(tok); }
  },

  // ── Cuadro de verificación previa a «Procesar» ──────────────────────────────
  // Procesar SIEMPRE crea una venta nueva y baja el stock: si Franco ya cargó esa venta a mano
  // o ya bajó el stock por otro lado, se cuenta doble. El cuadro muestra stock actual y
  // resultante, busca ventas parecidas EN LA BASE (no en la copia de pantalla) y pide elegir la
  // cotización a conciencia. Avisa; no garantiza: la base solo impide procesar DOS VECES LA MISMA
  // orden, no cruzarla con una venta manual.
  MERCADO_VIGENTE_MS: 30 * 60 * 1000,
  _blueMercado() {
    const m = State.mercadoBlue;
    return (m && Number.isFinite(m.valor) && m.valor > 0 && Date.now() - m.en < this.MERCADO_VIGENTE_MS) ? m : null;
  },
  // Cada vez que se abre el cuadro cambia la «instancia»: una operación o búsqueda de un cuadro
  // anterior no puede cerrar ni escribir sobre uno nuevo. La «firma» es lo que el usuario vio y
  // verificó (producto vinculado y cantidad); si cambia antes de procesar, se vuelve a pedir.
  _cuadroTok: 0,
  _firmas: {},
  _firma(o) { return JSON.stringify((o?.items || []).map(i => [i.stock_id || null, i.cantidad || 0]).sort()); },
  cerrarCuadro(tok) {
    if (tok !== undefined && tok !== this._cuadroTok) return;   // ese cuadro ya no es el que está abierto
    document.getElementById('meliord-overlay')?.remove();
  },

  // ── Cerrar a mano (script 12): «ya la cargué a mano» y «descartar». No tocan stock, ventas ni caja ──
  abrirCierre(id, motivo) {
    const o = (State.meliOrdenes || []).find(x => x.id === id);
    if (!o || o.procesada || o.revertidaEn || o.cerradaManual || !['ya_cargada', 'descartada'].includes(motivo)) return;
    this.cerrarCuadro();
    const tok = ++this._cuadroTok;                    // la respuesta de un cierre solo cierra ESTE cuadro, no otro que se haya abierto después
    const e = s => State.esc(s == null ? '' : String(s));
    const ya = motivo === 'ya_cargada';
    const ov = document.createElement('div');
    ov.id = 'meliord-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:800;display:flex;align-items:center;justify-content:center;padding:20px';
    const inp = 'width:100%;font-size:13px;padding:7px 9px;border:1px solid var(--border-strong);border-radius:8px';
    ov.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(480px,96vw);max-height:90dvh;overflow:auto;padding:18px">
        <div style="font-size:15px;font-weight:700;margin-bottom:4px">${ya ? 'Ya la cargué a mano' : 'Descartar'} · orden ${e(o.orderId)}</div>
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:12px">
          ${ya ? 'La venta ya está cargada en Ventas. Esto cierra la orden <b>sin descontar stock, sin crear otra venta y sin mover plata</b>: la plata que Mercado Libre libere la cargás vos en la caja, como hasta ahora.'
               : 'La orden no se va a tomar en cuenta. <b>No descuenta stock, no crea venta y no mueve plata.</b>'}
          Si te equivocás, la podés reabrir.</div>
        ${ya ? `<label style="font-size:11px;font-weight:600;display:block;margin-bottom:4px">Número de la venta en Ventas (opcional)</label>
          <input type="number" id="meliord-cvta-${id}" min="1" step="1" style="${inp};margin-bottom:10px">` : ''}
        <label style="font-size:11px;font-weight:600;display:block;margin-bottom:4px">Nota (opcional)</label>
        <input type="text" id="meliord-cnota-${id}" maxlength="200" placeholder="${ya ? 'Ej.: cargada en Ventas el 5/10' : 'Ej.: no se toma en cuenta'}" style="${inp};margin-bottom:14px">
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-sm" onclick="MeliOrdenes.cerrarCuadro()">Cancelar</button>
          <button class="btn btn-primary btn-sm" onclick="MeliOrdenes.cerrarManual(${id}, '${motivo}', this, ${tok})">Confirmar</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
  },
  async cerrarManual(id, motivo, btn, tok) {
    if (!['ya_cargada', 'descartada'].includes(motivo)) return;
    const nota = document.getElementById(`meliord-cnota-${id}`)?.value.trim() || null;
    const vtxt = document.getElementById(`meliord-cvta-${id}`)?.value.trim() || '';
    let venta = null;
    if (vtxt) { if (!/^[0-9]{1,12}$/.test(vtxt)) { toast('El número de venta no es válido.'); return; } venta = Number(vtxt); }
    if (nota && nota.length > 200) { toast('La nota es muy larga (máximo 200 caracteres).'); return; }
    const r = await this._llamar(btn, 'meli_orden_cerrar_manual', { p_orden_id: id, p_motivo: motivo, p_venta_id: venta, p_nota: nota },
      d => (d && d.ya_cerrada) ? 'La orden ya estaba cerrada.' : (motivo === 'ya_cargada' ? 'Orden cerrada: ya estaba cargada a mano.' : 'Orden descartada.'));
    if (r) this.cerrarCuadro(tok);
  },
  async reabrirCierre(id, btn) {
    if (!confirm('¿Reabrir esta orden? Vuelve a «Para procesar» o «En revisión», según corresponda.')) return;
    await this._llamar(btn, 'meli_orden_reabrir_cierre', { p_orden_id: id }, () => 'Orden reabierta.');
  },

  async abrirProcesar(id) {
    const o0 = (State.meliOrdenes || []).find(x => x.id === id);
    if (o0 && o0.cerradaManual) { toast('Esta orden está cerrada a mano. Reabrila si hace falta procesarla.'); return; }
    const o = (State.meliOrdenes || []).find(x => x.id === id);
    if (!o || o.procesada || o.revertidaEn) return;
    this.cerrarCuadro();
    const tok = ++this._cuadroTok;
    this._firmas[id] = this._firma(o);
    const e = s => State.esc(s == null ? '' : String(s));
    const ov = document.createElement('div');
    ov.id = 'meliord-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:800;display:flex;align-items:center;justify-content:center;padding:20px';
    const mercado = this._blueMercado();
    // Se agrupa por fila de stock: dos publicaciones vinculadas a la MISMA fila bajan juntas.
    const baja = new Map();
    (o.items || []).filter(i => i.stock_id).forEach(i => baja.set(i.stock_id, (baja.get(i.stock_id) || 0) + (i.cantidad || 0)));
    const filasStock = [...baja.entries()].map(([sid, cant]) => {
      const r = (State.stock || []).find(x => x.id === sid);
      const hay = r ? Number(r.cantidad) : null;
      const queda = hay === null || !Number.isFinite(hay) ? null : hay - cant;
      return `<tr><td style="padding:3px 8px 3px 0">${e(r?.nombre || 'producto')}</td>
        <td style="padding:3px 8px">${hay === null ? '—' : hay}</td><td style="padding:3px 8px">−${e(cant)}</td>
        <td style="padding:3px 0 3px 8px;font-weight:600;${queda !== null && queda < 0 ? 'color:var(--red)' : ''}">${queda === null ? '—' : queda}${queda !== null && queda < 0 ? ' ⚠ quedaría negativo' : ''}</td></tr>`;
    }).join('');
    ov.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(560px,96vw);max-height:90dvh;overflow:auto;padding:18px">
        <div style="font-size:15px;font-weight:700;margin-bottom:2px">Procesar orden ${e(o.orderId)}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">${this._dia(o.fechaOrden)} · Venta ${this._ars(o.bruto)} · Llega ${this._ars(o.neto)}.
          Procesar descuenta el stock y crea la venta. No se puede editar después.</div>
        <div style="font-size:12px;font-weight:600;margin-bottom:4px">1 · Stock</div>
        <table style="font-size:12px;border-collapse:collapse;margin-bottom:12px"><tr style="color:var(--text-secondary)"><td style="padding:0 8px 3px 0">Producto</td><td style="padding:0 8px 3px">Hay ahora</td><td style="padding:0 8px 3px">Baja</td><td style="padding:0 0 3px 8px">Quedaría</td></tr>${filasStock || '<tr><td colspan="4">Sin productos vinculados.</td></tr>'}</table>
        <div style="font-size:12px;font-weight:600;margin-bottom:4px">2 · ¿Ya está cargada a mano?</div>
        <div id="meliord-cand-${id}" style="font-size:12px;margin-bottom:12px;color:var(--text-secondary)">Buscando ventas parecidas en la base…</div>
        <div style="font-size:12px;font-weight:600;margin-bottom:4px">3 · Cotización (pesos por dólar, queda fija en la venta)</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
          <input type="number" id="meliord-cot-${id}" value="" placeholder="Elegí o escribí" min="1" step="1" oninput="MeliOrdenes._cuadroCambio(${id})"
            style="width:120px;font-size:13px;padding:7px 9px;border:1px solid var(--border-strong);border-radius:8px">
          ${mercado ? `<button class="btn btn-sm" onclick="MeliOrdenes._ponerCot(${id}, ${Math.round(mercado.valor)})">Blue de mercado hoy: $${Math.round(mercado.valor).toLocaleString('es-AR')}</button>` : ''}
          ${State.refBlue > 0 ? `<button class="btn btn-sm" onclick="MeliOrdenes._ponerCot(${id}, ${Math.round(State.refBlue)})" title="Es la cotización de referencia que cargaste en Panel; puede estar desactualizada">Mi referencia: $${Math.round(State.refBlue).toLocaleString('es-AR')}</button>` : ''}
        </div>
        <label style="display:flex;gap:8px;align-items:flex-start;font-size:12.5px;margin-bottom:14px;cursor:pointer">
          <input type="checkbox" id="meliord-ok-${id}" onchange="MeliOrdenes._cuadroCambio(${id})" style="margin-top:2px">
          <span>Verifiqué que esta venta no está cargada a mano en Ventas y que el stock no se bajó por otro lado.</span></label>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-sm" onclick="MeliOrdenes.cerrarCuadro()">Cancelar</button>
          <button class="btn btn-primary btn-sm" id="meliord-go-${id}" disabled onclick="MeliOrdenes.procesar(${id}, this)"><i class="ti ti-player-play"></i> Procesar</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const res = await this._buscarCandidatas(o);
    if (tok !== this._cuadroTok) return;   // se abrió otro cuadro mientras buscaba
    const caja = document.getElementById(`meliord-cand-${id}`);
    if (!caja) return;
    if (!res.ok) {
      caja.innerHTML = '<span style="color:var(--amber)">No se pudo revisar si ya está cargada. Fijate en Ventas antes de tildar la casilla.</span>';
    } else if (!res.lista.length) {
      caja.textContent = 'Sin coincidencias en lo consultado (ventas con el mismo producto, 3 días antes y después de la orden). Esto no garantiza que no esté cargada: revisalo igual.';
    } else {
      caja.innerHTML = `<div style="color:var(--amber);margin-bottom:4px"><i class="ti ti-alert-triangle"></i> Puede estar cargada ya. Ventas con el mismo producto en fechas cercanas:</div>`
        + res.lista.map(v => `<div style="color:var(--text)">Venta #${e(v.ventaId)} · ${this._dia(v.fecha)} · ${e(v.cliente || 'sin cliente')} · ${e(v.tipo)} · ${v.items.map(i => `${e(i.nombre)} (USD ${e(i.precio)})`).join(', ')}</div>`).join('');
    }
  },
  // 'YYYY-MM-DD' del día en Argentina. Una fecha sin hora ya es el día; un instante se convierte.
  _diaAR(v) {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const t = Date.parse(v);
    if (!Number.isFinite(t)) return null;
    return new Date(t - 3 * 3600 * 1000).toISOString().slice(0, 10);   // Argentina = UTC−3 todo el año
  },
  _ponerCot(id, valor) {
    const el = document.getElementById(`meliord-cot-${id}`);
    if (el) el.value = valor;
    this._cuadroCambio(id);
  },
  // «Procesar» del cuadro solo se habilita con cotización válida Y la casilla tildada.
  _cuadroCambio(id) {
    const cot = parseFloat(document.getElementById(`meliord-cot-${id}`)?.value);
    const ok = !!document.getElementById(`meliord-ok-${id}`)?.checked;
    const go = document.getElementById(`meliord-go-${id}`);
    if (go) go.disabled = !(Number.isFinite(cot) && cot > 0 && ok);
  },
  // Ventas cargadas a mano (no de Mercado Libre, no anuladas) con algún producto de la orden en
  // ±3 días. Se consulta la base al abrir el cuadro: la copia en pantalla puede estar
  // desactualizada o truncada. → { ok, lista } ; ok:false si no se pudo (o si se truncó).
  async _buscarCandidatas(o) {
    const stockIds = [...new Set((o.items || []).map(i => i.stock_id).filter(Boolean))];
    if (!stockIds.length) return { ok: true, lista: [] };
    const t = Date.parse(o.fechaOrden);
    if (!Number.isFinite(t)) return { ok: false, lista: [] };
    const DIA = 86400000, TOPE = 500;
    // ±4 días en la consulta (colchón por zona horaria) y se filtra a ±3 al mostrar.
    const desde = new Date(t - 4 * DIA).toISOString(), hasta = new Date(t + 4 * DIA).toISOString();
    try {
      const v = await supa.from('ventas').select('id,cliente,tipo_venta,fecha_venta,creado_en,estado,meli_orden_id')
        .or(`and(fecha_venta.gte.${desde.slice(0, 10)},fecha_venta.lte.${hasta.slice(0, 10)}),and(creado_en.gte.${desde},creado_en.lte.${hasta})`)
        .limit(TOPE);
      if (v.error || !Array.isArray(v.data) || v.data.length >= TOPE) return { ok: false, lista: [] };
      const ventas = v.data.filter(x => x.estado !== 'anulada' && (x.meli_orden_id === null || x.meli_orden_id === undefined));
      const porId = new Map(ventas.map(x => [x.id, x]));
      const ids = [...porId.keys()];
      const lista = [];
      for (let k = 0; k < ids.length; k += 100) {
        const r = await supa.from('venta_items').select('venta_id,stock_id,nombre,precio_usd')
          .in('venta_id', ids.slice(k, k + 100)).in('stock_id', stockIds).limit(1000);
        if (r.error || !Array.isArray(r.data) || r.data.length >= 1000) return { ok: false, lista: [] };
        const porVenta = {};
        r.data.forEach(i => { (porVenta[i.venta_id] = porVenta[i.venta_id] || []).push({ nombre: i.nombre, precio: Number(i.precio_usd) }); });
        for (const [vid, its] of Object.entries(porVenta)) {
          const x = porId.get(Number(vid)) || porId.get(vid);
          if (!x) continue;
          const cuando = x.fecha_venta || (DB._utc ? DB._utc(x.creado_en) : x.creado_en);
          // Días calendario de Argentina (una fecha sin hora es de ese día): ±3 días inclusivos.
          const d1 = this._diaAR(cuando), d0 = this._diaAR(o.fechaOrden);
          if (!d1 || !d0) continue;
          if (Math.abs(Date.parse(d1 + 'T00:00:00Z') - Date.parse(d0 + 'T00:00:00Z')) > 3 * DIA) continue;
          lista.push({ ventaId: x.id, fecha: cuando, cliente: x.cliente, tipo: x.tipo_venta || 'minorista', items: its });
        }
      }
      return { ok: true, lista };
    } catch (err) {
      console.warn('No se pudo buscar ventas parecidas:', err);
      return { ok: false, lista: [] };
    }
  },

  // ── Detalle de venta (solo lectura) ─────────────────────────────────────────
  _ars2(n) { return n === null || n === undefined ? '—' : '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },
  // Qué parte de lo retenido se conoce. Los tres componentes (cargo por venta, envío, impuestos)
  // vienen de `extras` y HOY la base no los guarda, así que normalmente llegan en null: se
  // muestran «sin desglose todavía». NUNCA se reparte ni se infiere un componente a partir del
  // total retenido, y «Cuadra» solo se dice con los tres presentes y la suma exacta (±1 centavo).
  //   → { bruto, neto, confirmado, retenido, partes:[{clave,nombre,monto}], estado, diferencia?, restoSinDesglosar? }
  //     estado: 'incompleto' | 'sin_desglose' | 'parcial' | 'cuadra' | 'no_cuadra'
  _desglose(o, extras = {}) {
    const num = x => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x))) ? null : Number(x);
    const c = x => Math.round(x * 100) / 100;
    const bruto = num(o?.bruto), neto = num(o?.neto);
    const r = { bruto, neto, confirmado: false, retenido: null, partes: [], estado: 'incompleto' };
    // Sin importes confirmados (pagos pendientes, neto parcial, consulta fallida) no se calcula nada:
    // «bruto − neto» sería un número engañoso.
    if (!o?.financieraCompleta || bruto === null || neto === null) return r;
    r.confirmado = true;
    r.retenido = c(bruto - neto);
    r.partes = [['cargoVenta', 'Cargo por venta'], ['envio', 'Envíos'], ['impuestos', 'Impuestos']]
      .map(([clave, nombre]) => ({ clave, nombre, monto: num(extras?.[clave]) }));
    const conocidas = r.partes.filter(x => x.monto !== null);
    if (conocidas.length === 3) {
      r.diferencia = c(r.retenido - conocidas.reduce((a, x) => a + x.monto, 0));
      r.estado = Math.abs(r.diferencia) <= 0.01 ? 'cuadra' : 'no_cuadra';
    } else if (conocidas.length) {
      r.estado = 'parcial';
      r.restoSinDesglosar = c(r.retenido - conocidas.reduce((a, x) => a + x.monto, 0));
    } else {
      r.estado = 'sin_desglose';
    }
    return r;
  },
  // Cuando la base guarde los tres componentes se leen de acá; hoy no existen.
  _extrasDe(o) { return { cargoVenta: o?.cargoVenta ?? null, envio: o?.envioVendedor ?? null, impuestos: o?.impuestos ?? null }; },
  _faltaLiberar(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '—';
    const dias = Math.ceil((t - Date.now()) / 86400000);
    return dias > 0 ? `se libera ${this._dia(iso)} (en ${dias} día${dias === 1 ? '' : 's'})` : `liberada el ${this._dia(iso)}`;
  },
  cerrarDetalle() { document.getElementById('meliord-detalle')?.remove(); },
  abrirDetalle(id) {
    const o = (State.meliOrdenes || []).find(x => x.id === id);
    if (!o) return;
    this.cerrarDetalle();
    const e = s => State.esc(s == null ? '' : String(s));
    const est = this._estadoDe(o);
    const d = this._desglose(o, this._extrasDe(o));
    const fila = (t, v, extra = '') => `<tr><td style="padding:3px 12px 3px 0;color:var(--text-secondary)">${t}</td><td style="padding:3px 0;text-align:right;font-weight:600;${extra}">${v}</td></tr>`;
    const items = (o.items || []).map(i => {
      const nom = i.stock_id ? (State.stock || []).find(x => x.id === i.stock_id)?.nombre : null;
      return `<div style="padding:4px 0;border-bottom:1px solid var(--border)">${e(i.cantidad || 1)}× ${e(i.titulo || 'producto')}
        <span style="color:var(--text-secondary)">· ${i.precio_unitario === null || i.precio_unitario === undefined ? 'precio —' : this._ars2(Number(i.precio_unitario)) + ' c/u'}</span>
        ${nom ? `<span style="color:var(--green)">→ Stock: ${e(nom)}</span>` : '<span style="color:var(--amber)">sin vincular</span>'}</div>`;
    }).join('') || '<div style="color:var(--text-secondary)">Sin productos.</div>';

    let dinero;
    if (!d.confirmado) {
      dinero = `<div style="color:var(--amber);font-size:12.5px">Datos de pago incompletos: todavía no se puede confirmar cuánto se queda Mercado Libre.${o.bruto !== null && o.bruto !== undefined ? ` Venta informada: ${this._ars2(o.bruto)}.` : ''}</div>`;
    } else {
      const parteTxt = x => x.monto === null ? '<span style="color:var(--text-secondary);font-weight:400">sin desglose todavía</span>' : '−' + this._ars2(x.monto);
      dinero = `<table style="font-size:13px;border-collapse:collapse;width:100%">
        ${fila('Venta (lo que pagó el comprador)', this._ars2(d.bruto))}
        ${d.partes.map(x => fila(x.nombre, parteTxt(x))).join('')}
        ${d.estado === 'parcial' ? fila('Resto sin desglosar', '−' + this._ars2(d.restoSinDesglosar)) : ''}
        ${fila('Total que se queda Mercado Libre', '−' + this._ars2(d.retenido), 'border-top:1px solid var(--border)')}
        ${fila('Te llega', this._ars2(d.neto), 'color:var(--green)')}
      </table>
      <div style="font-size:11.5px;margin-top:6px;color:${d.estado === 'no_cuadra' ? 'var(--red)' : 'var(--text-secondary)'}">${
        d.estado === 'cuadra' ? '✓ Cuadra: venta − cargos = lo que te llega.'
        : d.estado === 'no_cuadra' ? `⚠ No cuadra: la suma de los tres conceptos difiere del total retenido por ${this._ars2(Math.abs(d.diferencia))}.`
        : d.estado === 'parcial' ? 'Desglose parcial: faltan conceptos, no se afirma que cuadre.'
        : 'Todavía no hay cargo por venta, envío ni impuestos guardados por separado: solo se conoce el total retenido.'}</div>`;
    }

    let venta = '';
    if (o.ventaId) {
      const v = (State.ventas || []).find(x => x.id === o.ventaId);
      const R = window.Ventas && typeof window.Ventas.resultadoVenta === 'function' ? window.Ventas : null;
      if (!v || !R || !(v.items || []).length) {
        venta = `<div style="font-size:12.5px;color:var(--text-secondary)">Venta #${e(o.ventaId)}: datos no disponibles en pantalla.</div>`;
      } else {
        const r = R.resultadoVenta(v);
        venta = `<table style="font-size:13px;border-collapse:collapse;width:100%">
          ${fila('Venta', '#' + e(o.ventaId))}
          ${fila('Cotización congelada', v.meliCotizacion ? '$' + Number(v.meliCotizacion).toLocaleString('es-AR') : '—')}
          ${fila('Costo de comisión y envío', o.acreditado ? State.fmtUSD(r.costoCanal) : 'se fija al acreditar')}
          ${fila(o.acreditado ? 'Margen comercial' : 'Margen provisorio (todavía sin descontar comisión y envío)', State.fmtUSD(r.margenComercial))}
        </table>`;
      }
    }

    const ov = document.createElement('div');
    ov.id = 'meliord-detalle';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:800;display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(560px,96vw);max-height:90dvh;overflow:auto;padding:18px">
        <div style="display:flex;gap:10px;align-items:flex-start">
          <div style="flex:1"><div style="font-size:15px;font-weight:700">Orden ${e(o.orderId)}</div>
            <div style="font-size:12px;color:var(--text-secondary)">${this._dia(o.fechaOrden)} · comprador ${e(o.comprador || '—')} · localidad —</div></div>
          <span class="badge ${est.clase}">${est.txt}</span>
        </div>
        <div style="font-size:12px;font-weight:600;margin:12px 0 4px">Productos</div>
        <div style="font-size:12.5px">${items}</div>
        <div style="font-size:12px;font-weight:600;margin:12px 0 4px">Dinero</div>
        ${dinero}
        <div style="font-size:12.5px;margin-top:8px">Liberación: <b>${o.fechaLiberacion ? this._faltaLiberar(o.fechaLiberacion) : '—'}</b></div>
        ${venta ? `<div style="font-size:12px;font-weight:600;margin:12px 0 4px">Venta en el CRM</div>${venta}` : ''}
        <div id="meliord-calc-${id}" style="font-size:12px;margin-top:12px"></div>
        <div style="display:flex;gap:8px;justify-content:space-between;margin-top:14px;flex-wrap:wrap">
          <button class="btn btn-sm" onclick="MeliOrdenes.verComoSeCalculo(${id}, this)">Ver cómo se calculó</button>
          <button class="btn btn-sm" onclick="MeliOrdenes.cerrarDetalle()">Cerrar</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
  },
  // Bajo demanda: lee SOLO el resumen del pago de esta orden (campos de importes, sin datos del comprador).
  async verComoSeCalculo(id, btn) {
    const caja = document.getElementById(`meliord-calc-${id}`);
    if (!caja) return;
    if (btn) btn.disabled = true;
    try {
      const r = await supa.from('meli_ordenes').select('payload_pago').eq('id', id).maybeSingle();
      if (r.error || !r.data) { caja.innerHTML = '<span style="color:var(--amber)">No se pudo leer el detalle del pago.</span>'; return; }
      const pp = r.data.payload_pago;
      const pagos = Array.isArray(pp?.pagos) ? pp.pagos : [];
      if (!pagos.length) { caja.innerHTML = '<span style="color:var(--text-secondary)">Todavía no hay datos del pago guardados.</span>'; return; }
      const n = x => (x === null || x === undefined || !Number.isFinite(Number(x))) ? '—' : this._ars2(Number(x));
      const co = pp.conciliacion || {};
      caja.innerHTML = `<div style="font-weight:600;margin-bottom:4px">Pago(s) informado(s) por Mercado Pago</div>`
        + pagos.map(p => `<div style="padding:3px 0;border-bottom:1px solid var(--border)">Pago ${State.esc(String(p.id ?? ''))} · ${State.esc(String(p.status ?? '—'))} · importe ${n(p.transaction_amount)} · te llega ${n(p.net_received_amount)}</div>`).join('')
        + `<div style="margin-top:6px;color:var(--text-secondary)">Cargos informados por Mercado Pago: <b>${n(co.declarada)}</b> (esto NO es el desglose de comisión, envío e impuestos). Diferencia sin explicar: <b>${n(co.diferencia_sin_explicar)}</b>. Cobrado aprobado: ${n(co.cobrado_aprobado)} · ${co.cubierto === true ? 'cubre el total de la orden' : co.cubierto === false ? 'NO cubre el total de la orden' : '—'}.</div>`;
    } catch (err) {
      console.warn('No se pudo leer el detalle del pago:', err);
      caja.innerHTML = '<span style="color:var(--amber)">No se pudo leer el detalle del pago.</span>';
    } finally { if (btn) btn.disabled = false; }
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
