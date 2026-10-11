// Pantalla "Mercado Libre": conectar cuentas, asignarles caja y ver la cola.
//
// Plan y razones de cada decisión: docs/meli-plan-implementacion.md.
//
// Los tokens de Mercado Libre NO llegan nunca al navegador. Esta pantalla lee la
// vista `meli_cuentas_estado` (que no los expone) y todo lo demás pasa por los
// endpoints de /api/meli/*, que corren en el servidor.
//
// DRENAJE DE LA COLA. El equipo está en el plan Hobby de Vercel, donde el cron
// sólo puede ser diario, así que el trabajo de procesar los avisos lo hace este
// módulo: mientras el CRM está abierto, llama al worker cada ~60 s (esté o no
// abierta esta pantalla). Si nadie abre el CRM, un aviso puede tardar hasta un
// día en procesarse, y la pantalla lo dice. Con el plan Pro basta agregar un
// cron por minuto y esto deja de ser necesario.

const Meli = {
  _cuentas: [],
  _cola: { pendientes: 0, fallidas: 0, recientes: [] },
  _drenando: false,
  _hayCuentas: null,       // se averigua una vez y se reverifica de vez en cuando
  _ticks: 0,
  _msg: null,              // resultado de volver de Mercado Libre

  MOTIVOS: {
    denegado:       'Cancelaste la autorización en Mercado Libre.',
    navegador:      'La conexión se tiene que terminar en el mismo navegador donde se inició. Probá de nuevo desde acá.',
    state:          'El enlace de conexión venció o ya se usó. Probá de nuevo.',
    no_autorizado:  'Tu usuario ya no está autorizado en el CRM.',
    intercambio:    'Mercado Libre no aceptó la autorización. Probá de nuevo.',
    sin_refresh:    'Mercado Libre no entregó el permiso de renovación, así que la conexión se caería a las 6 horas. Falta habilitar "offline_access" en la configuración de la aplicación de Mercado Libre.',
    usuario:        'No se pudo identificar la cuenta de Mercado Libre.',
    parametros:     'La respuesta de Mercado Libre vino incompleta. Probá de nuevo.',
    sin_config:     'La integración no está configurada en el servidor.',
    servidor:       'Falló algo del lado del servidor. Probá de nuevo en un rato.',
  },

  // ── Token del CRM (el mismo mecanismo que la Bandeja) ──
  async _token() {
    try {
      const { data } = await supa.auth.getSession();
      return data?.session?.access_token || '';
    } catch { return ''; }
  },

  async _post(ruta, cuerpo) {
    const token = await this._token();
    const r = await fetch(ruta, { method: 'POST', headers: { 'x-crm-token': token, 'Content-Type': 'application/json' },
      ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}) });
    let json = null;
    try { json = await r.json(); } catch { /* sin cuerpo */ }
    return { ok: r.ok, status: r.status, json };
  },

  // ── Pantalla ──
  render() {
    const c = document.createElement('div');
    c.style.cssText = 'flex:1;overflow-y:auto;padding:16px';
    c.innerHTML = '<div id="meli-root"></div><div id="meli-vincular-root" style="margin-top:24px"></div><div id="meli-ordenes-root" style="margin-top:24px"></div>';
    setTimeout(() => { this.cargar(); if (window.MeliVincular) MeliVincular.cargar(); if (window.MeliOrdenes) MeliOrdenes.cargar(); }, 0);
    return c;
  },

  async cargar() {
    await Promise.all([this._cargarCuentas(), this._cargarCola(), this._cargarBarrido()]);
    this.pintar();
  },

  async _cargarCuentas() {
    const { data, error } = await supa.from('meli_cuentas_estado').select('*').order('id');
    if (error) { console.error('meli: no se pudieron leer las cuentas', error); this._cuentas = []; this._errorLectura = true; return; }
    this._errorLectura = false;
    this._cuentas = data || [];
    this._hayCuentas = this._cuentas.some((x) => x.conectada && !x.requiere_reconexion);
  },

  async _cargarCola() {
    const cont = async (estado) => {
      const { count } = await supa.from('meli_notificaciones')
        .select('id', { count: 'exact', head: true }).eq('estado', estado);
      return count || 0;
    };
    const [pendientes, fallidas] = await Promise.all([cont('pendiente'), cont('fallida')]);
    const { data } = await supa.from('meli_notificaciones')
      .select('id,topico,recurso,estado,intentos,motivo,error,recibida_en')
      .in('estado', ['pendiente', 'fallida'])
      .order('recibida_en', { ascending: false }).limit(10);
    this._cola = { pendientes, fallidas, recientes: data || [] };
  },

  // Hasta cuándo está verificado con Mercado Libre (script 10). Si todavía no se corrió, la tarjeta lo dice.
  async _cargarBarrido() {
    const { data, error } = await supa.from('meli_barrido_estado').select('*');
    if (error) { this._barrido = { disponible: false }; return; }
    const { count } = await supa.from('meli_ordenes').select('id', { count: 'exact', head: true })
      .eq('financiera_completa', false).eq('revisar', false);
    this._barrido = { disponible: true, estados: data || [], incompletas: count || 0 };
  },

  pintar() {
    const root = document.getElementById('meli-root');
    if (!root) return;
    root.innerHTML = this._vista();
  },

  _vista() {
    const e = (s) => State.esc(s == null ? '' : String(s));

    const aviso = this._msg
      ? `<div class="card" style="margin-bottom:12px;border-left:3px solid ${this._msg.ok ? 'var(--green)' : 'var(--red)'}">
           <div style="font-size:13px">${e(this._msg.texto)}</div></div>`
      : '';

    const filas = this._cuentas.map((c) => {
      let estado, clase;
      // Cualquiera de estas tres deja la cuenta SIN poder refrescar el token: el
      // servidor la bloquea, así que acá no puede verse como "Conectada". El
      // refresco ambiguo es el caso traicionero: no hubo ningún error visible,
      // sólo que no se sabe si Mercado Libre alcanzó a rotar el token.
      if (c.requiere_reconexion || c.refresh_ambiguo || c.activa === false) { estado = 'Hay que reconectar'; clase = 'b-red'; }
      else if (!c.conectada)     { estado = 'Sin conectar'; clase = 'b-amber'; }
      else if (!c.persona_id || !c.bolsillo) { estado = 'Falta asignar caja'; clase = 'b-amber'; }
      else                       { estado = 'Conectada'; clase = 'b-green'; }

      const caja = c.persona_id
        ? `${e(DB.personasIdToNombre[c.persona_id] || 'persona')} · ${e(c.bolsillo || '—')}`
        : 'Sin caja asignada';

      return `
        <div class="card" style="margin-bottom:8px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <div style="flex:1;min-width:200px">
            <div style="font-size:14px;font-weight:600">${e(c.nickname || 'Cuenta ' + c.meli_user_id)}</div>
            <div style="font-size:11.5px;color:var(--text-secondary)">ID ${e(c.meli_user_id)} · ${caja}</div>
            ${c.ultimo_error ? `<div style="font-size:11.5px;color:var(--red);margin-top:3px">${e(c.ultimo_error)}</div>` : ''}
          </div>
          <span class="badge ${clase}">${estado}</span>
          <button class="btn btn-sm" onclick="Meli.asignarCaja(${c.id})">${c.persona_id ? 'Cambiar caja' : 'Asignar caja'}</button>
        </div>`;
    }).join('');

    const cola = this._cola;
    const recientes = cola.recientes.map((n) => `
      <div style="display:flex;gap:8px;font-size:11.5px;padding:5px 0;border-top:1px solid var(--border)">
        <span class="badge ${n.estado === 'fallida' ? 'b-red' : 'b-amber'}">${e(n.estado)}</span>
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${e(n.topico)} ${e(n.recurso)} · ${n.intentos} intento(s)${n.motivo ? ' · ' + e(n.motivo) : ''}
        </span>
      </div>`).join('');

    return `
      ${aviso}
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;flex:1">
          Cuentas de Mercado Libre (${this._cuentas.length})
        </h3>
        <button class="btn btn-primary btn-sm" id="meli-btn-conectar" onclick="Meli.conectar()">
          <i class="ti ti-plug-connected"></i> Conectar Mercado Libre
        </button>
      </div>
      ${this._errorLectura
        ? `<div class="card" style="margin-bottom:12px;color:var(--red);font-size:13px">
             No se pudieron leer las cuentas. Si es la primera vez, falta correr la migración de la base
             (db/pendientes/meli_esquema_base.sql).</div>` : ''}
      ${filas || (this._errorLectura ? '' : '<div class="card" style="margin-bottom:12px;font-size:13px;color:var(--text-secondary)">Todavía no hay ninguna cuenta conectada.</div>')}

      <div style="display:flex;align-items:center;gap:10px;margin:20px 0 10px;flex-wrap:wrap">
        <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px;flex:1">
          Avisos de ventas
        </h3>
        <button class="btn btn-sm" id="meli-btn-procesar" onclick="Meli.procesarAhora()">
          <i class="ti ti-refresh"></i> Procesar pendientes
        </button>
      </div>
      ${this._vistaBarrido()}
      <div class="card" style="margin-bottom:8px">
        <div style="display:flex;gap:24px;flex-wrap:wrap">
          <div><div style="font-size:22px;font-weight:600">${cola.pendientes}</div>
               <div style="font-size:11.5px;color:var(--text-secondary)">pendientes</div></div>
          <div><div style="font-size:22px;font-weight:600;color:${cola.fallidas ? 'var(--red)' : 'inherit'}">${cola.fallidas}</div>
               <div style="font-size:11.5px;color:var(--text-secondary)">fallidos (revisar)</div></div>
        </div>
        ${recientes ? `<div style="margin-top:10px">${recientes}</div>` : ''}
      </div>
      <div style="font-size:11.5px;color:var(--text-secondary);line-height:1.5">
        Se registran las ventas <b>desde la fecha de conexión en adelante</b>; no se trae el historial anterior.
        Los avisos se procesan mientras el CRM está abierto y una vez por día aunque no lo esté:
        si nadie abre el CRM, una venta puede tardar hasta un día en aparecer.
      </div>
      <div class="card" style="margin-top:14px">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <div style="flex:1;min-width:220px;font-size:12px;color:var(--text-secondary);line-height:1.5">
            <b style="color:var(--text)">Diagnóstico de datos (solo lectura).</b> Pregunta a Mercado Libre qué campos
            trae una venta, su pago y su envío y muestra <b>solo los nombres de los campos, no los datos</b>.
            No guarda ni cambia ventas, stock ni cajas (si el acceso a Mercado Libre venció, se renueva solo, como siempre).
            "Conciliar importes" muestra además los importes de las últimas 6 ventas, sin datos de compradores.</div>
          <button class="btn btn-sm" id="meli-btn-sonda" onclick="Meli.sonda()"><i class="ti ti-stethoscope"></i> Ejecutar diagnóstico</button>
          <button class="btn btn-sm" id="meli-btn-conciliar" onclick="Meli.sonda('conciliar')" title="Importes de las últimas 6 ventas y si la cuenta cierra"><i class="ti ti-calculator"></i> Conciliar importes</button>
        </div>
        <div id="meli-sonda-salida" style="margin-top:10px"></div>
      </div>`;
  },

  // Diagnóstico de solo lectura: la forma de las respuestas de Mercado Libre, sin valores (api/_meli_sonda.js).
  async sonda(modo) {
    const cuenta = this._cuentas.find((c) => c.conectada && c.activa !== false && !c.requiere_reconexion);
    const out = document.getElementById('meli-sonda-salida');
    if (!cuenta) { toast('No hay una cuenta conectada para consultar.'); return; }
    const btns = ['meli-btn-sonda', 'meli-btn-conciliar'].map((i) => document.getElementById(i)).filter(Boolean);
    btns.forEach((b) => { b.disabled = true; });
    if (out) out.textContent = 'Consultando…';
    try {
      const token = await this._token();
      const r = await fetch('/api/meli/worker', {
        method: 'POST', headers: { 'x-crm-token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accion: modo === 'conciliar' ? 'conciliar' : 'sonda', cuenta: cuenta.id }),
      });
      let json = null;
      try { json = await r.json(); } catch { /* sin cuerpo */ }
      if (!out) return;
      if (!r.ok || !json) { out.textContent = 'No se pudo ejecutar el diagnóstico (HTTP ' + r.status + ').'; return; }
      const texto = JSON.stringify(json, null, 2);
      out.innerHTML = '<div style="font-size:11.5px;color:var(--text-secondary);margin-bottom:6px">Copiá este texto y pasáselo a quien lo pidió. No contiene datos de compradores (solo campos, códigos de estado e importes).</div>'
        + '<textarea readonly style="width:100%;height:220px;font-family:monospace;font-size:11px;padding:8px;border:1px solid var(--border);border-radius:8px"></textarea>';
      out.querySelector('textarea').value = texto;   // value, no innerHTML: el texto nunca se interpreta como HTML
    } catch {
      if (out) out.textContent = 'No se pudo ejecutar el diagnóstico.';
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  },

  // Dos datos SEPARADOS, porque encontrar ventas no es lo mismo que tenerlas cargadas:
  //   1) hasta cuándo se verificó con Mercado Libre; 2) cuánto de lo encontrado ya se cargó (pendientes, fallidos, incompletas).
  _vistaBarrido() {
    const e = (s) => State.esc(s == null ? '' : String(s));
    const b = this._barrido;
    const nCuentas = this._cuentas.filter((c) => c.conectada && !c.requiere_reconexion && c.activa !== false).length;
    const cola = this._cola;
    if (!b || !b.disponible) {
      return `<div class="card" style="margin-bottom:8px;font-size:12.5px;color:var(--text-secondary)">
        <b style="color:var(--text)">Buscar ventas recientes</b> todavía no está disponible: falta correr el script 10 en la base.</div>`;
    }
    const hace = (iso) => {
      const h = (Date.now() - new Date(iso).getTime()) / 3600000;
      if (!Number.isFinite(h)) return '';
      return h < 1 ? 'hace menos de 1 hora' : h < 48 ? `hace ${Math.round(h)} h` : `hace ${Math.round(h / 24)} días`;
    };
    const cuando = (iso) => new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const MOTIVOS = {
      RECONEXION: 'La cuenta pide reconectarse.', MELI_LIMITANDO: 'Mercado Libre pidió esperar.', SIN_AVANCE: 'No se pudo avanzar.',
      RESPUESTA_SIN_TOTAL: 'Mercado Libre respondió algo inesperado.', TOTAL_NO_COINCIDE: 'La búsqueda no cerró; se reintenta.',
      BASE_NO_RESPONDE: 'La base no respondió.',
    };
    const filas = this._cuentas.filter((c) => c.conectada).map((c) => {
      const st = b.estados.find((x) => x.cuenta_id === c.id) || {};
      const falla = st.ultimo_error ? (MOTIVOS[st.ultimo_error] || 'La última búsqueda falló.') : null;
      const viejo = !st.ultimo_ok_en || (Date.now() - new Date(st.ultimo_ok_en).getTime()) > 36 * 3600000;
      const color = (falla || viejo) ? 'var(--red)' : 'var(--green)';
      const parcial = st.ultimo_estado === 'parcial';
      return `<div style="font-size:12.5px;margin-top:6px">
        <b>${e(c.nickname || 'Cuenta')}</b>: ${st.cubierto_hasta
          ? `ventas verificadas con Mercado Libre hasta el <span style="color:${color};font-weight:600">${e(cuando(st.cubierto_hasta))}</span> (última búsqueda ${e(hace(st.ultimo_ok_en || st.cubierto_hasta))})`
          : '<span style="color:var(--red);font-weight:600">todavía no se buscó</span>'}
        ${parcial ? '<div style="color:var(--amber)">Cobertura parcial: la última búsqueda se cortó por tiempo. Apretá de nuevo (en 2 minutos) o se completa sola mañana.</div>' : ''}
        ${st.ultimo_aproximado ? '<div style="color:var(--amber)">Búsqueda aproximada: Mercado Libre no permitió verificarla del todo.</div>' : ''}
        ${falla ? `<div style="color:var(--red)">${e(falla)}</div>` : ''}
        ${!falla && viejo && st.ultimo_ok_en ? '<div style="color:var(--red)">Hace más de 36 horas que no se busca.</div>' : ''}
      </div>`;
    }).join('');
    return `<div class="card" style="margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <div style="flex:1;min-width:220px;font-size:12px;color:var(--text-secondary);line-height:1.5">
          <b style="color:var(--text)">Verificación con Mercado Libre.</b> Los avisos pueden no llegar. Esto le pregunta a Mercado Libre qué ventas
          hay y trae las que falten (no las procesa: eso sigue siendo el botón de cada orden).</div>
        <button class="btn btn-sm btn-primary" id="meli-btn-barrido" ${nCuentas ? '' : 'disabled'} onclick="Meli.buscarVentas()">
          <i class="ti ti-search"></i> Buscar ventas recientes</button>
      </div>
      ${filas}
      <div style="font-size:12.5px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
        <b>Datos cargados:</b> ${Number(cola.pendientes)} aviso(s) pendiente(s) de procesar ·
        <span style="color:${cola.fallidas ? 'var(--red)' : 'inherit'}">${Number(cola.fallidas)} fallido(s)</span> ·
        <span style="color:${b.incompletas ? 'var(--amber)' : 'inherit'}">${Number(b.incompletas)} orden(es) con datos de pago incompletos</span>
      </div>
    </div>`;
  },

  async buscarVentas() {
    if (this._buscando) return;
    const cuenta = this._cuentas.find((c) => c.conectada && !c.requiere_reconexion && c.activa !== false);
    if (!cuenta) { toast('No hay una cuenta conectada.'); return; }
    this._buscando = true;
    const btn = document.getElementById('meli-btn-barrido');
    if (btn) btn.disabled = true;
    try {
      toast('Buscando ventas en Mercado Libre…');
      const r = await this._post('/api/meli/worker', { accion: 'barrido', cuenta: cuenta.id });
      const ultimo = r.json || {};
      if (!r.ok) { toast(r.status === 401 ? 'Tu sesión no está autorizada.' : 'No se pudo buscar ventas.'); return; }
      if (ultimo.motivo === 'MUY_PRONTO') { toast(`Esperá ${Number(ultimo.espera_seg) || 120} segundos para volver a buscar.`); return; }
      if (ultimo.motivo === 'EN_CURSO') { toast('Ya hay una búsqueda en curso.'); return; }
      if (ultimo.motivo === 'CUENTA_BLOQUEADA') { toast('La cuenta pide reconectarse.'); return; }
      if (ultimo.ok === true) {
        const n = Number(ultimo.encoladas) || 0;
        if (ultimo.estado === 'parcial') {
          toast(`Se buscó solo una parte${n ? ` (${n} venta(s) encontradas)` : ''}; el resto sigue en la próxima búsqueda, en 2 minutos o mañana solo.`);
        } else if (ultimo.aproximado) {
          toast(`Búsqueda terminada, pero aproximada${n ? ` (${n} venta(s) encontradas)` : ''}: Mercado Libre no permitió verificarla del todo.`);
        } else {
          toast(n ? `Se encontraron ${n} venta(s) que faltaban. Procesando los avisos…` : 'No se encontraron ventas nuevas para cargar.');
        }
        await this._drenar(true);
      } else {
        toast('La búsqueda no terminó. Mirá el estado debajo.');
      }
    } catch {
      toast('No se pudo buscar ventas.');
    } finally {
      this._buscando = false;
      await this.cargar();
    }
  },

  // ── Acciones ──
  async conectar() {
    const btn = document.getElementById('meli-btn-conectar');
    if (btn) btn.disabled = true;
    try {
      const r = await this._post('/api/meli/conectar');
      if (!r.ok || !r.json?.authorization_url) {
        toast(r.status === 401 ? 'Tu sesión no está autorizada.' : 'No se pudo iniciar la conexión.');
        return;
      }
      // El servidor ya dejó la cookie que ata este flujo a ESTE navegador.
      window.location.href = r.json.authorization_url;
    } catch {
      toast('No se pudo iniciar la conexión.');
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  async asignarCaja(cuentaId) {
    // Los mapas de personas viven en DB (supabase-config.js), no en State.
    const mapa = DB.personasMap || {};
    const nombres = Object.keys(mapa);
    if (!nombres.length) { toast('No hay personas cargadas.'); return; }
    const persona = prompt('¿De quién es esta cuenta? Escribí el nombre exacto:\n\n' + nombres.join('\n'));
    if (!persona) return;
    const nombre = persona.trim();
    const pid = Object.hasOwn(mapa, nombre) ? mapa[nombre] : null;   // hasOwn: "constructor" no es una persona
    if (!pid) { toast('No encontré a esa persona.'); return; }
    const bolsillo = prompt('Nombre exacto del bolsillo donde se acredita (el que empieza con ARS se trata como pesos):', 'ARS Mercado Pago');
    if (!bolsillo || !bolsillo.trim()) return;

    const { error } = await supa.rpc('meli_cuenta_asignar_caja', {
      p_cuenta_id: cuentaId, p_persona_id: pid, p_bolsillo: bolsillo.trim(),
    });
    if (error) { console.error(error); toast('No se pudo asignar la caja.'); return; }
    toast('Caja asignada.');
    await this.cargar();
  },

  async procesarAhora() {
    const btn = document.getElementById('meli-btn-procesar');
    if (btn) btn.disabled = true;
    try {
      const r = await this._drenar(true);
      toast(r === null ? 'Ya se está procesando.' : `Procesados: ${r.procesadas} · Para reintentar: ${r.reintentos} · Descartados: ${r.descartadas}`);
    } finally {
      if (btn) btn.disabled = false;
      await this.cargar();
    }
  },

  // ── Drenaje ──
  // Llama al worker repetidamente mientras haya trabajo, sin invocaciones
  // superpuestas. Tope de vueltas para que un trabajo que no avanza no lo deje
  // dando vueltas para siempre.
  async _drenar(manual) {
    if (this._drenando) return null;
    this._drenando = true;
    const total = { procesadas: 0, reintentos: 0, descartadas: 0, devueltas: 0 };
    try {
      for (let i = 0; i < (manual ? 8 : 3); i++) {
        const r = await this._post('/api/meli/worker');
        if (!r.ok || !r.json) break;
        for (const k of Object.keys(total)) total[k] += r.json[k] || 0;
        // Nada reclamado = cola vacía. Los reintentos quedan con espera y no se
        // reclaman de nuevo enseguida, así que el bucle termina solo.
        if (!r.json.reclamadas) break;
      }
    } catch (e) {
      console.error('meli: error drenando la cola', e);
    } finally {
      this._drenando = false;
    }
    return total;
  },

  // Se llama una vez por minuto desde el temporizador de más abajo.
  async _tick() {
    if (!window.Auth?.usuario) return;
    if (document.hidden) return;                  // pestaña en segundo plano: no gastar pedidos

    // ¿Hay alguna cuenta conectada? Si no, no hay nada que procesar. Se
    // reverifica cada 10 minutos por si se conectó una.
    if (this._hayCuentas === null || this._ticks % 10 === 0) await this._cargarCuentas().catch(() => {});
    this._ticks++;
    if (!this._hayCuentas) return;

    await this._drenar(false);
  },

  destroy() { /* el drenaje es global, no depende de esta pantalla */ },
};

window.Meli = Meli;

// Drenaje global: corre mientras el CRM está abierto, en cualquier pantalla.
setInterval(() => Meli._tick(), 60_000);

// Resultado de volver de Mercado Libre. El callback redirige a /login?meli=ok|error;
// se lee una vez, se limpia la URL y se muestra cuando el CRM ya arrancó.
(function leerResultado() {
  try {
    const q = new URLSearchParams(location.search);
    const r = q.get('meli');
    if (!r) return;
    Meli._msg = r === 'ok'
      ? { ok: true, texto: 'Cuenta de Mercado Libre conectada. Ahora asignale una caja.' }
      : { ok: false, texto: (Object.hasOwn(Meli.MOTIVOS, q.get('motivo') || '') && Meli.MOTIVOS[q.get('motivo')])
                            || 'No se pudo conectar la cuenta.' };
    q.delete('meli'); q.delete('motivo');
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : ''));

    // Cuando el CRM termina de arrancar, se lleva al usuario a esta pantalla.
    const espera = setInterval(() => {
      if (window.Auth?.usuario && window.App?.goTo) {
        clearInterval(espera);
        window.App.goTo('meli');
      }
    }, 500);
    setTimeout(() => clearInterval(espera), 30_000);
  } catch { /* sin resultado que mostrar */ }
})();
