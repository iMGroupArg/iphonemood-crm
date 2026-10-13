// Actividades: tareas con estado. La primera: «Transferir lo que libera Mercado Libre a la cuenta de la empresa».
//
// Todo lo que toca plata o estado lo hacen funciones de la base (db/pendientes/actividades.sql, script 15), cada una en
// UNA transacción e idempotente: este módulo solo las llama y muestra el resultado. NUNCA escribe la tabla ni mueve
// saldos por su cuenta. La actividad de transferencia la crea la base sola cuando se confirma la acreditación de una orden.
//
// Dos caminos al tildar: «Registrar traspaso en el CRM» (la plata pasa de la caja de Mercado Pago a la de la empresa y la
// tarea queda hecha, todo junto) o «Solo marcar como hecha» (no mueve plata: lo hiciste afuera y el CRM no se entera).
const Actividades = {
  _filtro: 'pendientes',
  _lista: [],
  _cargada: false,
  _error: false,
  _sinTabla: false,
  _cajaEmpresa: null,      // { persona, bolsillo } recordada en configuración
  _configFalla: false,
  _pendientesTruncadas: false,
  _seleccion: [],          // [{ id, intento }] fijados al abrir el cuadro: lo que el usuario vio es lo que se ejecuta
  CLAVE_CONFIG: 'actividades_caja_empresa',

  ERRORES: {
    ACTIVIDAD_DESACTUALIZADA: 'Esta actividad cambió desde que abriste la pantalla (por ejemplo, otra persona la deshizo o la volvió a transferir). Actualizá y mirá cómo quedó antes de repetir.',
    INTENTO_REQUERIDO: 'Falta actualizar la pantalla: recargá el CRM e intentá de nuevo.',
    ACTIVIDAD_INEXISTENTE: 'La actividad ya no existe. Actualizá la pantalla.',
    ACTIVIDAD_NO_TRANSFERIBLE: 'Esta actividad no es una transferencia: solo se puede marcar.',
    ACTIVIDAD_ANULADA: 'La actividad está anulada (por ejemplo, porque se revirtió la orden).',
    ACTIVIDAD_YA_TRANSFERIDA: 'La plata de esta actividad ya se pasó a otra caja. Si fue un error, usá «Deshacer transferencia».',
    ACTIVIDAD_YA_TRANSFERIDA_A_OTRA_CAJA: 'Esta actividad ya se transfirió a OTRA caja. Actualizá la pantalla.',
    ACTIVIDAD_YA_MARCADA_SIN_MOVER: 'Esta actividad ya se marcó como hecha sin mover plata. Si querés que el CRM mueva la plata, reabrila primero.',
    ACTIVIDAD_NO_REABRIBLE: 'Esta actividad no se puede reabrir.',
    ACTIVIDAD_NO_ANULABLE: 'Solo se puede anular una actividad pendiente.',
    ACTIVIDAD_SIN_TRANSFERENCIA: 'Esta actividad no movió plata, no hay nada que deshacer.',
    ORDEN_NO_TRANSFERIBLE: 'La orden de Mercado Libre ya no está acreditada (o fue revertida o cerrada): no se puede transferir.',
    ORDEN_REVERTIDA: 'La orden de Mercado Libre se revirtió: esta actividad no se puede reabrir.',
    ORDEN_YA_TRANSFERIDA: 'La plata de esa orden ya se transfirió por una actividad: deshacé la transferencia antes de revertir la orden.',
    SALDO_INSUFICIENTE: 'La caja de origen no tiene saldo suficiente para esta transferencia.',
    DESTINO_INCOMPLETO: 'Elegí la caja de destino.',
    DESTINO_IGUAL_ORIGEN: 'La caja de destino es la misma que la de origen.',
    CAJA_NO_EN_PESOS: 'La transferencia es en pesos: elegí una caja en pesos.',
    CAJA_DESTINO_INEXISTENTE: 'La caja de destino no existe.',
    CAJA_ORIGEN_INEXISTENTE: 'La caja de origen no existe.',
    NOTA_INVALIDA: 'La nota es demasiado larga (200 como máximo) o tiene caracteres no permitidos.',
    TITULO_INVALIDO: 'El título tiene que tener entre 1 y 200 caracteres.',
    FECHA_INVALIDA: 'Elegí una fecha.',
    MONTO_INVALIDO: 'El monto no es válido.',
    'no autorizado': 'Tu usuario no está autorizado.',
  },
  _msgError(error) {
    const m = String(error?.message || error || '');
    for (const k of Object.keys(this.ERRORES)) if (m.includes(k)) return this.ERRORES[k];
    return m ? `No se pudo completar: ${State.esc(m)}` : 'No se pudo completar.';
  },

  // ── Fechas (hora de Argentina = UTC−3 fijo) ─────────────────────────────────
  _hoyAR(ahora = new Date()) { return new Date(ahora.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10); },
  _dia(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
  },
  _ars(n) { return n === null || n === undefined ? '—' : '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },

  // ── Carga ───────────────────────────────────────────────────────────────────
  // Nunca tira: ante cualquier error deja la lista como estaba y marca el estado. Si la tabla todavía no existe
  // (script 15 sin correr) lo dice aparte.
  async cargar() {
    try {
      // Las PENDIENTES se piden aparte y sin competir con las hechas: una pendiente vieja nunca puede quedar fuera por el
      // tope. Del resto (hechas y anuladas) se traen las 300 más recientes.
      const TOPE_PEND = 1000;
      const [pend, resto] = await Promise.all([
        supa.from('actividades').select('*').eq('estado', 'pendiente').order('fecha_objetivo', { ascending: false }).order('id', { ascending: false }).limit(TOPE_PEND),
        supa.from('actividades').select('*').neq('estado', 'pendiente').order('fecha_objetivo', { ascending: false }).order('id', { ascending: false }).limit(300),
      ]);
      const r = pend.error ? pend : resto;
      if (pend.error || resto.error) {
        const t = `${r.error.code || ''} ${r.error.message || ''}`.toLowerCase();
        this._sinTabla = t.includes('42p01') || t.includes('pgrst205') || (t.includes('relation') && t.includes('does not exist')) || t.includes('schema cache');
        this._error = !this._sinTabla;
        this._lista = [];
        return false;
      }
      this._pendientesTruncadas = (pend.data || []).length >= TOPE_PEND;
      this._sinTabla = false; this._error = false;
      this._lista = [...(pend.data || []), ...(resto.data || [])].map(a => ({
        id: a.id, tipo: a.tipo, titulo: a.titulo, monto: a.monto === null ? null : Number(a.monto), moneda: a.moneda, fechaObjetivo: a.fecha_objetivo,
        estado: a.estado, ordenId: a.origen_orden_id, origenPersonaId: a.origen_persona_id, origenBolsillo: a.origen_bolsillo,
        destinoPersonaId: a.destino_persona_id, destinoBolsillo: a.destino_bolsillo, movioPlata: !!a.movio_plata, nota: a.nota || '',
        hechaEn: a.hecha_en, hechaPor: a.hecha_por, intento: Number(a.intento) || 1, revision: Number(a.revision) || 1,
      })).sort((x, y) => String(y.fechaObjetivo).localeCompare(String(x.fechaObjetivo)) || y.id - x.id);
      this._cargada = true;
      State.actividades = this._lista;
      // La caja predeterminada: «no hay ninguna guardada» es distinto de «no se pudo leer». Si falla la lectura se
      // conserva la anterior y, sin ninguna, el cuadro obliga a elegir (nunca cambia el destino en silencio).
      try {
        const c = await supa.from('configuracion').select('valor').eq('clave', this.CLAVE_CONFIG).maybeSingle();
        if (c && c.error) this._configFalla = true;
        else { this._configFalla = false; this._cajaEmpresa = c && c.data && c.data.valor ? JSON.parse(c.data.valor) : null; }
      } catch { this._configFalla = true; }
      return true;
    } catch (e) {
      console.warn('No se pudieron leer las actividades:', e);
      this._error = true; this._lista = [];
      return false;
    }
  },

  render() {
    const c = document.createElement('div');
    c.style.cssText = 'flex:1;min-height:0;overflow-y:auto;padding:16px 22px 24px';
    c.innerHTML = '<div id="actividades-root"></div>';
    this.cargar().then(() => { this.pintar(); this.actualizarBadge(); });
    return c;
  },
  pintar() {
    const root = document.getElementById('actividades-root');
    if (root) root.innerHTML = this._vista();
  },

  // ── Aviso en el menú ────────────────────────────────────────────────────────
  // Pendientes de transferir con fecha de hoy o anterior.
  pendientesVencidas(lista = this._lista, hoy = this._hoyAR()) {
    return (lista || []).filter(a => a.estado === 'pendiente' && String(a.fechaObjetivo || '').slice(0, 10) <= hoy);
  },
  actualizarBadge() {
    const el = document.getElementById('badge-actividades');
    if (!el) return;
    const n = this.pendientesVencidas().length;
    if (n > 0) { el.textContent = n; el.style.display = 'inline-flex'; } else el.style.display = 'none';
  },

  // ── Vista ───────────────────────────────────────────────────────────────────
  _origenNombre(a) { return (window.DB || DB).personasIdToNombre?.[a.origenPersonaId] || ''; },
  _destinoNombre(a) { return (window.DB || DB).personasIdToNombre?.[a.destinoPersonaId] || ''; },
  _vista() {
    const e = s => State.esc(s == null ? '' : String(s));
    if (this._sinTabla) {
      return `<div class="card" style="font-size:13px;color:var(--text-secondary)">Falta correr el script 15 (actividades) en la base de datos para usar esta pantalla.</div>`;
    }
    if (this._error) {
      return `<div class="card" style="font-size:13px;color:var(--text-secondary)">No se pudieron leer las actividades. Probá de nuevo con «Actualizar».
        <div style="margin-top:8px"><button class="btn btn-sm" onclick="Actividades.recargar()"><i class="ti ti-refresh"></i> Actualizar</button></div></div>`;
    }
    const FILTROS = { pendientes: 'Pendientes', hechas: 'Hechas', anuladas: 'Anuladas' };
    const claveEstado = { pendiente: 'pendientes', hecha: 'hechas', anulada: 'anuladas' };
    const cuenta = k => this._lista.filter(a => claveEstado[a.estado] === k).length;
    const tabs = Object.entries(FILTROS).map(([k, t]) =>
      `<button class="btn btn-sm ${this._filtro === k ? 'btn-primary' : ''}" onclick="Actividades.filtrar('${k}')">${t} (${cuenta(k)})</button>`).join('');
    const visibles = this._lista.filter(a => claveEstado[a.estado] === this._filtro);
    const hoy = this._hoyAR();

    // Agrupadas por día (hora de Argentina), del más reciente al más viejo.
    const porDia = new Map();
    visibles.forEach(a => { const d = String(a.fechaObjetivo || '').slice(0, 10); (porDia.get(d) || porDia.set(d, []).get(d)).push(a); });
    const dias = [...porDia.keys()].sort((x, y) => y.localeCompare(x));
    const grupos = dias.map(d => {
      const items = porDia.get(d);
      const transferibles = items.filter(a => a.estado === 'pendiente' && a.tipo === 'meli_transferir');
      const totalDia = transferibles.reduce((s, a) => s + (a.monto || 0), 0);
      const vencida = this._filtro === 'pendientes' && d < hoy;
      return `
        <div style="margin-bottom:14px">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
            <div style="font-size:12px;font-weight:700;color:${vencida ? 'var(--red)' : 'var(--text-secondary)'}">${this._dia(d)}${d === hoy ? ' · hoy' : vencida ? ' · atrasadas' : ''}</div>
            ${transferibles.length > 1 ? `<button class="btn btn-sm" onclick="Actividades.abrirTransferir([${transferibles.map(a => a.id).join(',')}])">Transferir las ${transferibles.length} de este día (${this._ars(totalDia)})</button>` : ''}
          </div>
          ${items.map(a => this._tarjeta(a, e)).join('')}
        </div>`;
    }).join('');

    return `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
        <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;flex:1">Actividades</h3>
        <button class="btn btn-sm" onclick="Actividades.abrirNueva()"><i class="ti ti-plus"></i> Nueva actividad</button>
        <button class="btn btn-sm" onclick="Actividades.recargar()"><i class="ti ti-refresh"></i> Actualizar</button>
      </div>
      ${this._pendientesTruncadas ? '<div class="card" style="font-size:12px;color:var(--amber);margin-bottom:10px">Hay más de 1.000 pendientes: se muestran las más recientes. Resolvé las viejas para ver el resto.</div>' : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">${tabs}</div>
      ${grupos || '<div class="card" style="font-size:13px;color:var(--text-secondary)">No hay actividades en esta vista.</div>'}`;
  },

  _tarjeta(a, e) {
    const badge = a.estado === 'pendiente' ? ['b-amber', 'Pendiente'] : a.estado === 'hecha' ? ['b-green', a.movioPlata ? 'Transferida' : 'Hecha'] : ['b-gray', 'Anulada'];
    let acciones = '';
    if (a.estado === 'pendiente') {
      if (a.tipo === 'meli_transferir') acciones += `<button class="btn btn-primary btn-sm" onclick="Actividades.abrirTransferir([${a.id}])"><i class="ti ti-arrows-exchange"></i> Transferir…</button>`;
      else acciones += `<button class="btn btn-primary btn-sm" onclick="Actividades.marcar(${a.id}, this)"><i class="ti ti-check"></i> Marcar como hecha</button>`;
      acciones += `<button class="btn btn-sm" onclick="Actividades.anular(${a.id}, this)">Anular</button>`;
    } else if (a.estado === 'hecha') {
      if (a.movioPlata) acciones += `<button class="btn btn-sm" style="color:var(--red)" onclick="Actividades.compensar(${a.id}, this)">Deshacer transferencia</button>`;
      else acciones += `<button class="btn btn-sm" onclick="Actividades.reabrir(${a.id}, this)">Reabrir</button>`;
    }
    const destino = a.movioPlata ? ` → ${e(this._destinoNombre(a))} · ${e(a.destinoBolsillo)}` : '';
    return `
      <div class="card" style="margin-bottom:8px">
        <div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap">
          <div style="flex:1;min-width:220px">
            <div style="font-size:13px;font-weight:600">${e(a.titulo)}</div>
            <div style="font-size:11.5px;color:var(--text-secondary)">${a.monto !== null ? `<b>${this._ars(a.monto)}</b> · ` : ''}${a.tipo === 'meli_transferir' ? `${e(this._origenNombre(a))} · ${e(a.origenBolsillo)}${destino}` : 'Actividad manual'}${a.estado === 'hecha' && a.hechaPor ? ` · hecha por ${e(a.hechaPor)}` : ''}</div>
            ${a.nota ? `<div style="font-size:11.5px;margin-top:4px">${e(a.nota)}</div>` : ''}
            ${a.estado === 'hecha' && !a.movioPlata && a.tipo === 'meli_transferir' ? '<div style="font-size:11.5px;color:var(--amber);margin-top:4px">Marcada sin mover plata en el CRM: la caja de Mercado Pago conserva ese saldo.</div>' : ''}
          </div>
          <span class="badge ${badge[0]}">${badge[1]}</span>
        </div>
        ${acciones ? `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px">${acciones}</div>` : ''}
      </div>`;
  },

  filtrar(k) { this._filtro = k; this.pintar(); },
  async recargar() { await this.cargar(); this.pintar(); this.actualizarBadge(); },

  // ── Llamadas a la base ──────────────────────────────────────────────────────
  // → { ok:true, data } | { ok:false, mensaje, sinRespuesta }
  async _rpc(fn, args) {
    try {
      const { data, error, status } = await supa.rpc(fn, args);
      if (error) {
        // supabase-js NO tira ante una caída de red: devuelve {error, status: 0}. Un 5xx de pasarela tampoco prueba que no
        // se aplicó. En esos casos no se sabe: se avisa distinto y el lote se corta.
        const txt = String(error.message || '');
        const incierto = status === 0 || status >= 500 || (!error.code && /fetch|network|timed? ?out|abort|failed to|econn/i.test(txt));
        if (incierto) return { ok: false, sinRespuesta: true, mensaje: 'Se cortó la conexión y no se sabe si se aplicó. Actualizá la pantalla antes de volver a intentar: repetirlo no mueve la plata dos veces.' };
        return { ok: false, mensaje: this._msgError(error) };
      }
      if (data && data.ok === false) return { ok: false, mensaje: this._msgError(data.motivo || '') };
      return { ok: true, data };
    } catch (err) {
      // Sin respuesta: NO se sabe si se aplicó. Las funciones son idempotentes, pero hay que mirar antes de repetir.
      console.error(fn, err);
      return { ok: false, sinRespuesta: true, mensaje: 'Se cortó la conexión y no se sabe si se aplicó. Actualizá la pantalla antes de volver a intentar: repetirlo no mueve la plata dos veces.' };
    }
  },
  async _refrescar() {
    // La plata de las cajas pudo cambiar en la base: se vuelve a leer todo.
    await DB.cargarTodo();
    await this.cargar();
    this.pintar();
    this.actualizarBadge();
    if (typeof App !== 'undefined' && App.actualizarBadges) App.actualizarBadges();
  },
  async _simple(btn, fn, args, ok) {
    if (btn) btn.disabled = true;
    try {
      const r = await this._rpc(fn, args);
      toast(r.ok ? ok(r.data) : r.mensaje);
      await this._refrescar();
      return r.ok;
    } finally { if (btn) btn.disabled = false; }
  },
  _rev(id) { return (this._lista.find(x => x.id === id) || {}).revision ?? null; },
  marcar(id, btn) { return this._simple(btn, 'actividad_marcar_hecha', { p_id: id, p_revision: this._rev(id), p_nota: null }, () => 'Actividad marcada como hecha.'); },
  reabrir(id, btn) { return this._simple(btn, 'actividad_reabrir', { p_id: id, p_revision: this._rev(id) }, () => 'Actividad reabierta.'); },
  anular(id, btn) {
    if (!confirm('¿Anular esta actividad?')) return Promise.resolve(false);
    return this._simple(btn, 'actividad_anular', { p_id: id, p_revision: this._rev(id) }, () => 'Actividad anulada.');
  },
  compensar(id, btn) {
    const a = this._lista.find(x => x.id === id);
    if (!a) return Promise.resolve(false);
    if (!confirm(`¿Deshacer la transferencia de ${this._ars(a.monto)}?\n\nLa plata vuelve a «${a.origenBolsillo}» y la actividad queda pendiente de nuevo.`)) return Promise.resolve(false);
    return this._simple(btn, 'actividad_compensar', { p_id: id, p_intento: a.intento ?? null, p_nota: null }, d => d.ya_compensada ? 'La transferencia ya estaba deshecha.' : `Transferencia deshecha: ${this._ars(d.monto)} volvieron a Mercado Pago.`);
  },

  // ── Cuadro del tilde ────────────────────────────────────────────────────────
  _personaId(nombre) {
    const mapa = (window.DB || DB).personasIdToNombre || {};
    const par = Object.entries(mapa).find(([, n]) => n === nombre);
    return par ? par[0] : null;
  },
  // Cajas en pesos que pueden ser destino: de todas las personas, bolsillos que empiezan con ARS, menos el origen.
  _destinosPosibles(origenNombre, origenBolsillo) {
    const out = [];
    Object.entries(State.cajas || {}).forEach(([persona, bols]) => Object.keys(bols || {}).forEach(b => {
      if (/^ARS/.test(b) && !(persona === origenNombre && b === origenBolsillo)) out.push({ persona, bolsillo: b });
    }));
    return out;
  },
  // El predeterminado: el recordado en configuración si sigue existiendo; si no, «Franco · ARS transferencia» si existe.
  _destinoPredeterminado(posibles) {
    const buscar = x => x && posibles.find(p => p.persona === x.persona && p.bolsillo === x.bolsillo);
    if (this._configFalla && !this._cajaEmpresa) return null;   // no se pudo leer la preferencia: que elija
    return buscar(this._cajaEmpresa) || buscar({ persona: 'Franco', bolsillo: 'ARS transferencia' }) || null;
  },
  cerrarCuadro() { document.getElementById('actividades-overlay')?.remove(); },

  abrirTransferir(ids) {
    const sel = (ids || []).map(id => this._lista.find(a => a.id === id)).filter(a => a && a.estado === 'pendiente' && a.tipo === 'meli_transferir');
    if (!sel.length) return;
    this.cerrarCuadro();
    this._seleccion = sel.map(a => ({ id: a.id, intento: a.intento, revision: a.revision }));
    const e = s => State.esc(s == null ? '' : String(s));
    const total = sel.reduce((s, a) => s + (a.monto || 0), 0);
    const origenNombre = this._origenNombre(sel[0]), origenBolsillo = sel[0].origenBolsillo;
    const posibles = this._destinosPosibles(origenNombre, origenBolsillo);
    const pred = this._destinoPredeterminado(posibles);
    const ov = document.createElement('div');
    ov.id = 'actividades-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:800;display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(520px,96vw);max-height:90dvh;overflow:auto;padding:18px">
        <div style="font-size:15px;font-weight:700;margin-bottom:2px">${sel.length > 1 ? `Transferir ${sel.length} actividades` : 'Transferir a la cuenta de la empresa'}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">${this._ars(total)} desde <b>${e(origenNombre)} · ${e(origenBolsillo)}</b></div>
        <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">CAJA DE LA EMPRESA (destino)</label>
        <select id="act-destino" style="width:100%;font-size:13px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:8px;margin-bottom:6px">
          ${pred ? '' : '<option value="">Elegí la caja…</option>'}
          ${posibles.map(p => `<option value="${e(p.persona)}||${e(p.bolsillo)}" ${pred && pred.persona === p.persona && pred.bolsillo === p.bolsillo ? 'selected' : ''}>${e(p.persona)} · ${e(p.bolsillo)}</option>`).join('')}
        </select>
        <label style="display:flex;gap:6px;align-items:center;font-size:12px;margin-bottom:10px"><input type="checkbox" id="act-recordar" ${pred ? '' : 'checked'}> Usar esta caja como predeterminada</label>
        <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">NOTA (opcional)</label>
        <input id="act-nota" type="text" maxlength="200" placeholder="Ej.: cuenta bancaria destino" style="width:100%;font-size:13px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:8px;margin-bottom:12px">
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:14px">
          <b>Registrar traspaso en el CRM:</b> la plata sale de «${e(origenBolsillo)}» y entra a la caja elegida, y la actividad queda hecha. Si falta saldo en origen no pasa nada.<br>
          <b>Solo marcar como hecha:</b> no mueve plata. Usalo si la transferencia ya la hiciste afuera y el CRM no tiene que moverla; la caja de Mercado Pago conserva ese saldo.</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
          <button class="btn btn-sm" onclick="Actividades.cerrarCuadro()">Cancelar</button>
          <button class="btn btn-sm" onclick="Actividades.confirmar('marcar', this)">Solo marcar como hecha</button>
          <button class="btn btn-primary btn-sm" onclick="Actividades.confirmar('transferir', this)">Registrar traspaso en el CRM</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
  },

  _confirmando: false,
  // Ejecuta de a una (cada una es su propia transacción) con lo que el usuario VIO al abrir el cuadro (id, intento y revisión
  // fijados entonces) e informa qué actividades se hicieron, cuáles fallaron, cuáles quedaron inciertas y cuáles no se intentaron.
  async confirmar(modo, btn) {
    if (this._confirmando) return;
    const sel = this._seleccion.slice();
    if (!sel.length) return;
    const nota = (document.getElementById('act-nota')?.value || '').trim() || null;
    let destino = null;
    if (modo === 'transferir') {
      const v = document.getElementById('act-destino')?.value || '';
      const [persona, bolsillo] = v.split('||');
      const personaId = persona ? this._personaId(persona) : null;
      if (!persona || !bolsillo || !personaId) { toast('Elegí la caja de destino.'); return; }
      destino = { persona, bolsillo, personaId };
    }
    this._confirmando = true;
    if (btn) btn.disabled = true;
    const hechas = [], fallidas = [], inciertas = [], noIntentadas = [];
    try {
      for (let i = 0; i < sel.length; i++) {
        const s = sel[i];
        const r = modo === 'transferir'
          ? await this._rpc('actividad_transferir', { p_id: s.id, p_intento: s.intento ?? null, p_destino_persona: destino.personaId, p_destino_bolsillo: destino.bolsillo, p_nota: nota })
          : await this._rpc('actividad_marcar_hecha', { p_id: s.id, p_revision: s.revision ?? null, p_nota: nota });
        if (r.ok) hechas.push(s.id);
        else if (r.sinRespuesta) { inciertas.push(s.id); noIntentadas.push(...sel.slice(i + 1).map(x => x.id)); break; }   // no se sigue a ciegas
        else fallidas.push({ id: s.id, mensaje: r.mensaje });
      }
      if (modo === 'transferir' && hechas.length && document.getElementById('act-recordar')?.checked) await this._guardarPredeterminada(destino);
      const num = ids => ids.map(i => '#' + i).join(', ');
      if (!fallidas.length && !inciertas.length) {
        toast(modo === 'transferir' ? (hechas.length === 1 ? 'Transferencia registrada.' : `${hechas.length} transferencias registradas.`) : (hechas.length === 1 ? 'Actividad marcada como hecha.' : `${hechas.length} actividades marcadas como hechas.`));
      } else {
        const partes = [`${hechas.length} de ${sel.length} se hicieron${hechas.length ? ` (${num(hechas)})` : ''}.`];
        if (fallidas.length) partes.push(`No se pudo: ${fallidas.map(f => `${'#' + f.id} (${f.mensaje})`).join(' · ')}.`);
        if (inciertas.length) partes.push(`INCIERTA: ${num(inciertas)} — se cortó la conexión y no se sabe si se aplicó; mirá la actividad antes de repetir.`);
        if (noIntentadas.length) partes.push(`No se intentaron: ${num(noIntentadas)}.`);
        toast(partes.join(' '));
      }
      this.cerrarCuadro();
      await this._refrescar();
    } finally { this._confirmando = false; if (btn) btn.disabled = false; }
  },
  async _guardarPredeterminada(destino) {
    try {
      const { error } = await supa.from('configuracion').upsert({ clave: this.CLAVE_CONFIG, valor: JSON.stringify({ persona: destino.persona, bolsillo: destino.bolsillo }) });
      if (!error) this._cajaEmpresa = { persona: destino.persona, bolsillo: destino.bolsillo };
    } catch (e) { console.warn('No se pudo guardar la caja predeterminada:', e); }
  },

  // ── Actividad manual ────────────────────────────────────────────────────────
  abrirNueva() {
    this.cerrarCuadro();
    const ov = document.createElement('div');
    ov.id = 'actividades-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:800;display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(460px,96vw);padding:18px">
        <div style="font-size:15px;font-weight:700;margin-bottom:12px">Nueva actividad</div>
        <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">QUÉ HAY QUE HACER</label>
        <input id="act-titulo" type="text" maxlength="200" style="width:100%;font-size:13px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:8px;margin-bottom:10px">
        <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">PARA CUÁNDO</label>
        <input id="act-fecha" type="date" value="${this._hoyAR()}" style="font-size:13px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:8px;margin-bottom:10px">
        <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">NOTA (opcional)</label>
        <input id="act-nota-nueva" type="text" maxlength="200" style="width:100%;font-size:13px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:8px;margin-bottom:14px">
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-sm" onclick="Actividades.cerrarCuadro()">Cancelar</button>
          <button class="btn btn-primary btn-sm" onclick="Actividades.crear(this)">Crear</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
  },
  async crear(btn) {
    const titulo = (document.getElementById('act-titulo')?.value || '').trim();
    const fecha = document.getElementById('act-fecha')?.value || '';
    const nota = (document.getElementById('act-nota-nueva')?.value || '').trim() || null;
    if (!titulo) { toast('Escribí qué hay que hacer.'); return; }
    if (!fecha) { toast('Elegí una fecha.'); return; }
    if (btn) btn.disabled = true;
    try {
      const r = await this._rpc('actividad_crear', { p_titulo: titulo, p_fecha_objetivo: fecha, p_monto: null, p_moneda: null, p_nota: nota });
      toast(r.ok ? 'Actividad creada.' : r.mensaje);
      if (r.ok) { this.cerrarCuadro(); await this.cargar(); this.pintar(); this.actualizarBadge(); }
    } finally { if (btn) btn.disabled = false; }
  },
};

window.Actividades = Actividades;
