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

  async _post(ruta) {
    const token = await this._token();
    const r = await fetch(ruta, { method: 'POST', headers: { 'x-crm-token': token, 'Content-Type': 'application/json' } });
    let json = null;
    try { json = await r.json(); } catch { /* sin cuerpo */ }
    return { ok: r.ok, status: r.status, json };
  },

  // ── Pantalla ──
  render() {
    const c = document.createElement('div');
    c.style.cssText = 'flex:1;overflow-y:auto;padding:16px';
    c.innerHTML = '<div id="meli-root"></div><div id="meli-ordenes-root" style="margin-top:24px"></div>';
    setTimeout(() => { this.cargar(); if (window.MeliOrdenes) MeliOrdenes.cargar(); }, 0);
    return c;
  },

  async cargar() {
    await Promise.all([this._cargarCuentas(), this._cargarCola()]);
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
        ? `${e(State.personasIdToNombre[c.persona_id] || 'persona')} · ${e(c.bolsillo || '—')}`
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
      </div>`;
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
    const nombres = Object.keys(State.personasMap || {});
    if (!nombres.length) { toast('No hay personas cargadas.'); return; }
    const persona = prompt('¿De quién es esta cuenta? Escribí el nombre exacto:\n\n' + nombres.join('\n'));
    if (!persona) return;
    const pid = State.personasMap[persona.trim()];
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
