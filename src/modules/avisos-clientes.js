// Avisos a clientes: lo que el negocio le manda a quienes aceptaron «novedades y ofertas» en la tienda (precios.html).
//
// TODO lo importante lo decide la base (db/pendientes/notificaciones_push.sql, script 34): quién cuenta como suscripto (sólo los que
// recibieron la bienvenida), el máximo de UN aviso cada 20 horas, el largo del texto y que el enlace sólo pueda ir a iphonemood.com.
// Esta pantalla muestra eso, arma una vista previa del aviso y pide confirmación antes de mandar: un aviso no se puede deshacer.

const AvisosClientes = {
  _resumen: null,
  _error: null,

  PLANTILLAS: [
    { etq: 'Stock nuevo', titulo: 'Llegó stock nuevo 📱', cuerpo: 'Entraron equipos nuevos. Mirá los precios de hoy en la tienda.' },
    { etq: 'Oferta', titulo: 'Oferta de la semana 🔥', cuerpo: 'Precios especiales por tiempo limitado. Entrá y mirá cuáles son.' },
    { etq: 'Vuelve un modelo', titulo: 'Volvió a haber stock ✅', cuerpo: 'Ese modelo que estabas esperando ya está disponible.' },
  ],

  MOTIVOS: {
    apagado: 'Los avisos están apagados (interruptor general). Encendelos para poder mandar.',
    titulo: 'El título tiene que tener entre 1 y 60 letras.',
    cuerpo: 'El texto tiene que tener entre 1 y 140 letras.',
    url: 'El enlace no es válido: tiene que ser una dirección de la tienda (por ejemplo «/»).',
    muy_seguido: 'Ya se mandó un aviso hace poco. Para no molestar a la gente, hay un máximo de uno cada 20 horas.',
    sin_suscriptos: 'Todavía no hay personas suscriptas para mandarles el aviso.',
    NO_AUTORIZADO: 'Tu usuario no tiene permiso para mandar avisos.',
  },

  render() {
    const c = document.createElement('div');
    c.style.cssText = 'flex:1;overflow-y:auto;padding:18px 22px 40px';
    c.innerHTML = '<div id="avc-root"></div>';
    setTimeout(() => this.cargar(), 0);
    return c;
  },

  async cargar() {
    const { data, error } = await supa.rpc('push_difusiones_resumen');
    this._error = error ? 'No se pudo leer la información. Si es la primera vez, falta correr el script 34 en la base.' : null;
    this._resumen = error ? null : data;
    this.pintar();
  },

  _fecha(iso) { try { return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return '—'; } },

  pintar() {
    const root = document.getElementById('avc-root');
    if (!root) return;
    const e = (x) => State.esc(String(x ?? ''));
    const r = this._resumen;
    if (this._error || !r) { root.innerHTML = `<div class="card" style="color:var(--red);font-size:13px">${e(this._error || 'Cargando…')}</div>`; return; }
    const bloqueo = r.apagado ? this.MOTIVOS.apagado
      : r.disponible_desde ? `Podés mandar el próximo aviso a partir del ${this._fecha(r.disponible_desde)}.`
      : (!r.suscriptos ? this.MOTIVOS.sin_suscriptos : '');
    const estados = { enviado: ['Enviado', 'b-green'], pendiente: ['Saliendo…', 'b-amber'], en_curso: ['Saliendo…', 'b-amber'], fallido: ['No llegó', 'b-red'], sin_destinos: ['Sin destinatarios', 'b-gray'], descartado: ['Descartado', 'b-gray'] };
    root.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px">
        <h2 style="font-size:22px;font-weight:800;letter-spacing:-.5px;display:flex;align-items:center;gap:8px;flex:1"><i class="ti ti-bell-ringing" style="color:var(--blue)"></i> Avisos a clientes</h2>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-bottom:14px">
        <div class="card" style="margin:0">
          <div style="font-size:12px;color:var(--text-secondary);font-weight:600">Personas que reciben avisos</div>
          <div style="font-size:34px;font-weight:800;letter-spacing:-1px;margin-top:4px">${e(r.suscriptos)}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;line-height:1.45">Aceptaron «novedades y ofertas» en la tienda. Sólo cuentan las que ya recibieron el aviso de bienvenida. Se dan de baja solas cuando quieren.</div>
        </div>
        <div class="card" style="margin:0">
          <div style="font-size:12px;color:var(--text-secondary);font-weight:600">Reglas para no molestar</div>
          <ul style="font-size:12.5px;line-height:1.6;margin:6px 0 0 16px;color:var(--text)">
            <li>Como mucho <b>un aviso cada 20 horas</b>.</li>
            <li>Título hasta 60 letras y texto hasta 140.</li>
            <li>El enlace sólo puede abrir la tienda.</li>
            <li>Un aviso enviado <b>no se puede deshacer</b>.</li>
          </ul>
        </div>
      </div>

      <div class="card" style="margin:0 0 14px">
        <div style="font-size:15px;font-weight:700;margin-bottom:10px">Nuevo aviso</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
          <span style="font-size:12px;color:var(--text-secondary);align-self:center">Plantillas:</span>
          ${this.PLANTILLAS.map((p, i) => `<button type="button" class="btn btn-sm" data-pl="${i}">${e(p.etq)}</button>`).join('')}
        </div>
        <div style="display:grid;grid-template-columns:minmax(280px,1.2fr) minmax(240px,1fr);gap:18px;align-items:start">
          <div>
            <label style="font-size:12px;font-weight:600;color:var(--text-secondary)">Título <span id="avc-ct" style="font-weight:400"></span></label>
            <input type="text" id="avc-titulo" maxlength="60" placeholder="Ej.: Llegó stock nuevo 📱" style="width:100%;margin:4px 0 12px">
            <label style="font-size:12px;font-weight:600;color:var(--text-secondary)">Texto <span id="avc-cc" style="font-weight:400"></span></label>
            <textarea id="avc-cuerpo" maxlength="140" rows="3" placeholder="Ej.: Entraron iPhone 15 y 16. Mirá los precios de hoy." style="width:100%;margin:4px 0 12px;resize:vertical"></textarea>
            <label style="font-size:12px;font-weight:600;color:var(--text-secondary)">Qué abre al tocarlo</label>
            <select id="avc-url" style="width:100%;margin:4px 0 12px">
              <option value="/">La tienda (precios y stock)</option>
              <option value="/?canje=1">La tienda (empieza por Plan canje)</option>
            </select>
            <div id="avc-msg" style="font-size:12.5px;min-height:18px;margin-bottom:8px;color:var(--text-secondary)">${bloqueo ? e(bloqueo) : ''}</div>
            <button type="button" class="btn btn-primary" id="avc-enviar" style="min-height:42px" ${bloqueo ? 'disabled' : ''}><i class="ti ti-send"></i> Enviar a ${e(r.suscriptos)} ${r.suscriptos === 1 ? 'persona' : 'personas'}</button>
          </div>
          <div>
            <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:6px">Así lo van a ver</div>
            <div style="background:#2c2c2e;color:#fff;border-radius:18px;padding:12px 14px;max-width:340px;box-shadow:0 8px 24px rgba(0,0,0,.25)">
              <div style="display:flex;align-items:center;gap:8px;font-size:11px;opacity:.7;margin-bottom:6px"><img src="/assets/icon-192.png" alt="" width="18" height="18" style="border-radius:5px"> iPhone Mood · ahora</div>
              <div id="avc-pv-t" style="font-size:14px;font-weight:700;line-height:1.25">Tu título acá</div>
              <div id="avc-pv-c" style="font-size:13px;opacity:.9;margin-top:2px;line-height:1.35">Tu texto acá</div>
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="margin:0">
        <div style="font-size:15px;font-weight:700;margin-bottom:8px">Últimos avisos</div>
        ${(r.ultimas || []).length ? (r.ultimas || []).map((d) => {
          const [txt, cls] = estados[d.estado] || [d.estado, 'b-gray'];
          return `<div style="display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--border)">
            <div style="flex:1;min-width:0"><div style="font-size:13.5px;font-weight:700">${e(d.titulo)}</div><div style="font-size:12.5px;color:var(--text-secondary)">${e(d.cuerpo)}</div>
              <div style="font-size:11.5px;color:var(--text-tertiary);margin-top:2px">${e(this._fecha(d.creada_en))} · lo mandó ${e(String(d.creada_por).split('@')[0])} · llegó a ${e(d.recibidos)} de ${e(d.destinatarios)}</div></div>
            <span class="badge ${cls}">${e(txt)}</span></div>`;
        }).join('') : '<div style="font-size:13px;color:var(--text-secondary)">Todavía no mandaste ningún aviso.</div>'}
      </div>`;
    const $ = (id) => document.getElementById(id);
    const vista = () => {
      $('avc-pv-t').textContent = $('avc-titulo').value.trim() || 'Tu título acá';
      $('avc-pv-c').textContent = $('avc-cuerpo').value.trim() || 'Tu texto acá';
      $('avc-ct').textContent = `(${$('avc-titulo').value.length}/60)`; $('avc-cc').textContent = `(${$('avc-cuerpo').value.length}/140)`;
    };
    ['avc-titulo', 'avc-cuerpo'].forEach((id) => $(id).addEventListener('input', vista));
    root.querySelectorAll('[data-pl]').forEach((b) => b.addEventListener('click', () => { const p = this.PLANTILLAS[Number(b.dataset.pl)]; $('avc-titulo').value = p.titulo; $('avc-cuerpo').value = p.cuerpo; vista(); }));
    $('avc-enviar').addEventListener('click', () => this.enviar());
    vista();
  },

  async enviar() {
    const titulo = document.getElementById('avc-titulo').value.trim(), cuerpo = document.getElementById('avc-cuerpo').value.trim(), url = document.getElementById('avc-url').value;
    const msg = document.getElementById('avc-msg'), btn = document.getElementById('avc-enviar');
    if (!titulo || !cuerpo) { msg.textContent = 'Escribí el título y el texto.'; msg.style.color = 'var(--red)'; return; }
    const n = this._resumen ? this._resumen.suscriptos : 0;
    if (!confirm(`Vas a mandar este aviso a ${n} ${n === 1 ? 'persona' : 'personas'}:\n\n${titulo}\n${cuerpo}\n\nNo se puede deshacer, y hasta dentro de 20 horas no vas a poder mandar otro. ¿Lo mandamos?`)) return;
    btn.disabled = true; msg.style.color = 'var(--text-secondary)'; msg.textContent = 'Enviando…';
    const { data, error } = await supa.rpc('push_difundir', { p_titulo: titulo, p_cuerpo: cuerpo, p_url: url });
    if (error || !data || data.ok === false) {
      btn.disabled = false; msg.style.color = 'var(--red)';
      msg.textContent = (data && this.MOTIVOS[data.motivo]) || (error && this.MOTIVOS[String(error.message).match(/NO_AUTORIZADO/)?.[0]]) || 'No se pudo mandar el aviso. Probá de nuevo en un rato.';
      return;
    }
    toast(`Aviso en camino a ${data.destinatarios} personas`);
    await this.cargar();
  },

  destroy() { /* nada que limpiar */ },
};

window.AvisosClientes = AvisosClientes;
