const Bandeja = {
  actual: null,
  _timerLista: null,
  _timerChat: null,
  filtro: '',
  filtroEstado: 'todos', // todos | espera | asesor | mio | cerradas
  asignaciones: {}, // `platform:userId` -> nombre persona
  cerradas: {}, // `platform:userId` -> true

  // ── render principal ────────────────────────────────────────────────────────
  render() {
    this.destroy();
    const c = document.createElement('div');
    c.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden;width:100%';
    c.innerHTML = `
      <style>
        #bdj-wrap { display:flex; height:calc(100dvh - 56px); gap:0; overflow:hidden; }

        /* ── Panel izquierdo ── */
        #bdj-izq { width:clamp(260px, 28%, 360px); min-width:0; border-right:1px solid var(--border); display:flex; flex-direction:column; background:var(--bg-elevated); flex-shrink:0; }
        #bdj-busq { padding:10px 12px 0; }
        #bdj-busq input { width:100%; border:1px solid var(--border-strong); border-radius:18px; padding:8px 14px; font-size:13px; background:var(--bg); color:var(--text); outline:none; box-sizing:border-box; }
        #bdj-busq input:focus { border-color:var(--blue); }
        #bdj-filtros { display:flex; gap:4px; padding:8px 12px; border-bottom:1px solid var(--border); overflow-x:auto; scrollbar-width:none; }
        #bdj-filtros::-webkit-scrollbar { display:none; }
        .bdj-ftab { font-size:11px; font-weight:600; padding:4px 10px; border-radius:12px; border:1px solid var(--border-strong); background:none; color:var(--text-secondary); cursor:pointer; white-space:nowrap; }
        .bdj-ftab.activo { background:var(--blue); color:#fff; border-color:var(--blue); }
        #bdj-lista { flex:1; overflow-y:auto; }
        .bdj-conv { padding:10px 14px; border-bottom:1px solid var(--border); cursor:pointer; display:flex; gap:10px; align-items:flex-start; transition:background .1s; }
        .bdj-conv:hover { background:var(--bg-secondary); }
        .bdj-conv.activa { background:rgba(var(--blue-rgb,0,122,255),.08); border-left:3px solid var(--blue); padding-left:11px; }
        .bdj-avatar { width:38px; height:38px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:700; color:#fff; flex-shrink:0; margin-top:1px; }
        .bdj-conv-body { flex:1; min-width:0; }
        .bdj-conv .top { display:flex; align-items:center; gap:5px; margin-bottom:2px; }
        .bdj-conv .nom { font-weight:600; font-size:13px; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .bdj-conv .hora { font-size:10px; color:var(--text-secondary); flex-shrink:0; }
        .bdj-conv .prev { font-size:11.5px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .bdj-conv .asig-tag { font-size:10px; color:var(--blue); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .bdj-badge { font-size:9.5px; font-weight:700; padding:2px 7px; border-radius:10px; color:#fff; flex-shrink:0; }
        .bdj-badge.asesor { background:var(--red,#e0245e); }
        .bdj-badge.espera { background:var(--amber,#f5a623); }

        /* ── Panel chat ── */
        #bdj-chat { flex:1; display:flex; flex-direction:column; min-width:0; }
        #bdj-head { padding:11px 16px; background:var(--bg-elevated); border-bottom:1px solid var(--border); display:flex; align-items:center; gap:10px; flex-shrink:0; }
        #bdj-head-info { flex:1; min-width:0; }
        #bdj-head .nom { font-weight:600; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        #bdj-head-sub { font-size:11px; color:var(--text-secondary); margin-top:1px; }
        #bdj-msgs { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:8px; background:var(--bg); }
        .bdj-msg { max-width:72%; padding:9px 13px; border-radius:12px; font-size:13.5px; line-height:1.45; white-space:pre-wrap; word-wrap:break-word; }
        .bdj-msg.cliente { background:var(--bg-elevated); border:1px solid var(--border); align-self:flex-start; border-bottom-left-radius:4px; }
        .bdj-msg.bot { background:rgba(52,199,89,.12); border:1px solid rgba(52,199,89,.25); align-self:flex-end; border-bottom-right-radius:4px; }
        .bdj-msg.humano { background:rgba(0,122,255,.12); border:1px solid rgba(0,122,255,.25); align-self:flex-end; border-bottom-right-radius:4px; }
        .bdj-msg .rol { display:block; font-size:10px; font-weight:700; opacity:.55; margin-bottom:4px; text-transform:uppercase; letter-spacing:.04em; }
        .bdj-msg .hora-msg { display:block; font-size:10px; color:var(--text-secondary); text-align:right; margin-top:4px; }
        .bdj-media { margin-bottom:6px; }
        .bdj-media audio { width:250px; max-width:100%; height:38px; display:block; }
        .bdj-media img { max-width:100%; width:230px; border-radius:9px; display:block; cursor:zoom-in; background:var(--bg-secondary); }
        .bdj-media a { color:inherit; text-decoration:none; }
        .bdj-media-load { font-size:12px; opacity:.6; padding:5px 0; }
        .bdj-media-err { font-size:12px; color:var(--red); padding:5px 0; }
        @media (max-width:600px) { .bdj-media audio, .bdj-media img { width:100%; } }
        .bdj-loading { display:flex; gap:5px; align-items:center; padding:12px 16px; }
        .bdj-loading span { width:7px; height:7px; border-radius:50%; background:var(--text-secondary); animation:bdj-bounce .9s infinite; opacity:.4; }
        .bdj-loading span:nth-child(2) { animation-delay:.15s; }
        .bdj-loading span:nth-child(3) { animation-delay:.3s; }
        @keyframes bdj-bounce { 0%,80%,100%{transform:translateY(0);opacity:.4} 40%{transform:translateY(-5px);opacity:1} }
        #bdj-barra { padding:10px 14px; background:var(--bg-elevated); border-top:1px solid var(--border); display:flex; gap:10px; align-items:flex-end; flex-shrink:0; }
        #bdj-barra textarea { flex:1; resize:none; border:1px solid var(--border-strong); border-radius:14px; padding:10px 14px; font-size:14px; font-family:inherit; height:44px; max-height:140px; background:var(--bg); color:var(--text); outline:none; line-height:1.4; }
        #bdj-barra textarea:focus { border-color:var(--blue); }
        #bdj-enviar { background:var(--blue,#007aff); color:#fff; border:none; border-radius:50%; width:44px; height:44px; font-size:20px; cursor:pointer; flex-shrink:0; display:flex; align-items:center; justify-content:center; transition:opacity .15s; }
        #bdj-enviar:disabled { opacity:.35; }
        .bdj-vacio { padding:60px 20px; text-align:center; color:var(--text-secondary); font-size:14px; }
        .bdj-vacio.bdj-error { color:var(--orange, #ff9500); font-weight:600; line-height:1.5; }
        #bdj-estado { font-size:11.5px; color:var(--text-secondary); flex-shrink:0; }
        .bdj-assign-wrap { position:relative; }
        .bdj-assign-btn { font-size:11px; padding:4px 10px; border-radius:10px; border:1px solid var(--border-strong); background:none; color:var(--text-secondary); cursor:pointer; white-space:nowrap; }
        .bdj-assign-btn.asignado { color:var(--blue); border-color:var(--blue); }
        .bdj-assign-menu { position:absolute; right:0; top:calc(100% + 4px); background:var(--bg-elevated); border:1px solid var(--border-strong); border-radius:10px; min-width:160px; z-index:50; box-shadow:0 4px 16px rgba(0,0,0,.2); overflow:hidden; }
        .bdj-assign-opt { padding:9px 14px; font-size:13px; cursor:pointer; }
        .bdj-assign-opt:hover { background:var(--bg-secondary); }
        .bdj-assign-opt.activo { color:var(--blue); font-weight:600; }

        /* ── Tablet ── */
        @media (max-width:900px) {
          #bdj-izq { width:240px; }
          .bdj-msg { max-width:85%; }
        }

        /* ── Mobile ── */
        @media (max-width:600px) {
          #bdj-wrap { position:relative; }
          #bdj-izq { width:100%; position:absolute; inset:0; z-index:1; }
          #bdj-chat { position:absolute; inset:0; z-index:2; display:none; }
          #bdj-wrap.enchat #bdj-izq { display:none; }
          #bdj-wrap.enchat #bdj-chat { display:flex; }
          #bdj-volver { display:flex !important; }
          .bdj-msg { max-width:88%; font-size:14px; }
          #bdj-barra textarea { font-size:16px; }
        }
      </style>
      <div id="bdj-wrap">
        <div id="bdj-izq">
          <div id="bdj-busq"><input id="bdj-q" type="text" placeholder="🔍 Buscar conversación…" autocomplete="off"></div>
          <div id="bdj-filtros">
            <button class="bdj-ftab activo" data-f="todos" onclick="Bandeja._setFiltro('todos')">Todos</button>
            <button class="bdj-ftab" data-f="espera" onclick="Bandeja._setFiltro('espera')">En espera</button>
            <button class="bdj-ftab" data-f="asesor" onclick="Bandeja._setFiltro('asesor')">Asesor</button>
            <button class="bdj-ftab" data-f="mio" onclick="Bandeja._setFiltro('mio')">Mis chats</button>
            <button class="bdj-ftab" data-f="cerradas" onclick="Bandeja._setFiltro('cerradas')">Cerradas</button>
          </div>
          <div id="bdj-lista"><div class="bdj-vacio">Cargando…</div></div>
        </div>
        <div id="bdj-chat">
          <div id="bdj-head">
            <button id="bdj-volver" style="display:none;background:none;border:none;font-size:20px;cursor:pointer;color:var(--text)" title="Volver" onclick="Bandeja._volverLista()">←</button>
            <div id="bdj-head-info">
              <div class="nom" id="bdj-chatnom">Elegí una conversación</div>
              <div id="bdj-head-sub"></div>
            </div>
            <button class="btn btn-sm" id="bdj-bot-btn" style="display:none" onclick="Bandeja.retomarBot()">🤖 Retomar bot</button>
            <button id="bdj-cerrar-btn" style="display:none;font-size:11px;padding:4px 10px;border-radius:10px;border:1px solid var(--border-strong);background:none;color:var(--text-secondary);cursor:pointer;white-space:nowrap" onclick="Bandeja._toggleCerrar()">✓ Cerrar</button>
            <div class="bdj-assign-wrap" id="bdj-assign-wrap" style="display:none">
              <button class="bdj-assign-btn" id="bdj-assign-btn" onclick="Bandeja._toggleAssignMenu()">👤 Asignar</button>
              <div class="bdj-assign-menu" id="bdj-assign-menu" style="display:none"></div>
            </div>
            <span id="bdj-estado"></span>
          </div>
          <div id="bdj-msgs"><div class="bdj-vacio">Elegí una conversación para verla.</div></div>
          <div id="bdj-barra" style="display:none">
            <textarea id="bdj-texto" placeholder="Escribí tu respuesta…" rows="1" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();Bandeja.enviar()}" oninput="this.style.height='44px';this.style.height=Math.min(this.scrollHeight,140)+'px'"></textarea>
            <button id="bdj-enviar" title="Enviar" onclick="Bandeja.enviar()"><i class="ti ti-send"></i></button>
          </div>
        </div>
      </div>`;

    setTimeout(() => { this._bindBusqueda(); this._bindClickOutside(); }, 0);
    this._cargarAsignaciones().then(() => this.cargarLista());
    this._timerLista = setInterval(() => this.cargarLista(), 5000);
    return c;
  },

  destroy() {
    clearInterval(this._timerLista);
    clearInterval(this._timerChat);
    // Cada adjunto abierto crea un object URL que el navegador retiene hasta
    // que se lo libera; sin esto una jornada larga con muchos audios iba
    // acumulando memoria en la pestaña.
    Object.values(this._mediaCache || {}).forEach(u => URL.revokeObjectURL(u));
    this._mediaCache = {};
    this._firmaChat = null;
    this.actual = null;
    this._clickOutside && document.removeEventListener('click', this._clickOutside);
  },

  // ── Asignaciones (Supabase) ──────────────────────────────────────────────────
  async _cargarAsignaciones() {
    try {
      const { data } = await supa.from('bandeja_asignaciones').select('*');
      this.asignaciones = {};
      this.cerradas = {};
      (data || []).forEach(r => {
        this.asignaciones[`${r.platform}:${r.user_id}`] = r.asignado_a;
        if (r.cerrada) this.cerradas[`${r.platform}:${r.user_id}`] = true;
      });
    } catch { /* tabla puede no existir todavía */ }
  },

  async _toggleCerrar() {
    if (!this.actual) return;
    const key = `${this.actual.platform}:${this.actual.userId}`;
    const estaCerrada = !!this.cerradas[key];
    if (estaCerrada) {
      delete this.cerradas[key];
    } else {
      this.cerradas[key] = true;
    }
    await supa.from('bandeja_asignaciones').upsert({
      platform: this.actual.platform, user_id: this.actual.userId,
      asignado_a: this.asignaciones[key] || null,
      cerrada: !estaCerrada, updated_at: new Date().toISOString(),
    }, { onConflict: 'platform,user_id' });
    this._actualizarCerrarBtn();
    this.cargarLista();
    toast(estaCerrada ? 'Conversación reabierta' : 'Conversación cerrada ✓', 'success');
  },

  _actualizarCerrarBtn() {
    const key = this.actual ? `${this.actual.platform}:${this.actual.userId}` : null;
    const cerrada = key ? !!this.cerradas[key] : false;
    const btn = document.getElementById('bdj-cerrar-btn');
    if (btn) {
      btn.textContent = cerrada ? '↩ Reabrir' : '✓ Cerrar';
      btn.style.color = cerrada ? 'var(--green)' : 'var(--text-secondary)';
      btn.style.borderColor = cerrada ? 'var(--green)' : 'var(--border-strong)';
    }
  },

  async _asignar(persona) {
    if (!this.actual) return;
    const key = `${this.actual.platform}:${this.actual.userId}`;
    const anterior = this.asignaciones[key];
    if (persona) {
      this.asignaciones[key] = persona;
      await supa.from('bandeja_asignaciones').upsert({
        platform: this.actual.platform, user_id: this.actual.userId,
        asignado_a: persona, updated_at: new Date().toISOString(),
      }, { onConflict: 'platform,user_id' });
    } else {
      delete this.asignaciones[key];
      await supa.from('bandeja_asignaciones').delete()
        .eq('platform', this.actual.platform).eq('user_id', this.actual.userId);
    }
    this._toggleAssignMenu(false);
    this._actualizarAssignBtn();
    this.cargarLista();
  },

  _actualizarAssignBtn() {
    const key = this.actual ? `${this.actual.platform}:${this.actual.userId}` : null;
    const asig = key ? this.asignaciones[key] : null;
    const btn = document.getElementById('bdj-assign-btn');
    if (btn) {
      btn.textContent = asig ? `👤 ${asig}` : '👤 Asignar';
      btn.className = 'bdj-assign-btn' + (asig ? ' asignado' : '');
    }
    const sub = document.getElementById('bdj-head-sub');
    if (sub) sub.textContent = asig ? `Asignado a ${asig}` : '';
  },

  _toggleAssignMenu(force) {
    const menu = document.getElementById('bdj-assign-menu');
    if (!menu) return;
    const show = force !== undefined ? force : menu.style.display === 'none';
    if (show) {
      const key = this.actual ? `${this.actual.platform}:${this.actual.userId}` : null;
      const actual = key ? this.asignaciones[key] : null;
      const personas = State.personas || [];
      menu.innerHTML = `
        <div class="bdj-assign-opt${!actual ? ' activo' : ''}" onclick="Bandeja._asignar(null)">Sin asignar</div>
        ${personas.map(p => `<div class="bdj-assign-opt${actual===p?' activo':''}" onclick="Bandeja._asignar('${p}')">${p}</div>`).join('')}
      `;
    }
    menu.style.display = show ? 'block' : 'none';
  },

  _bindClickOutside() {
    this._clickOutside = (e) => {
      if (!e.target.closest('.bdj-assign-wrap')) {
        document.getElementById('bdj-assign-menu')?.style && (document.getElementById('bdj-assign-menu').style.display = 'none');
      }
    };
    document.addEventListener('click', this._clickOutside);
  },

  // ── Filtros ───────────────────────────────────────────────────────────────────
  _setFiltro(f) {
    this.filtroEstado = f;
    document.querySelectorAll('.bdj-ftab').forEach(el => el.classList.toggle('activo', el.dataset.f === f));
    this.cargarLista();
  },

  _usuarioActual() {
    return Auth?.usuario?.nombre || Auth?.usuario?.email || null;
  },

  // ── API helpers ──────────────────────────────────────────────────────────────
  async _token() {
    try {
      const { data } = await supa.auth.getSession();
      return data?.session?.access_token || '';
    } catch { return ''; }
  },
  async _api(path, opts = {}) {
    const token = await this._token();
    const r = await fetch('/api/bandeja' + path, {
      headers: { 'Content-Type': 'application/json', 'x-crm-token': token },
      ...opts,
    });
    // Un 401 (sesión vencida) o un 429 (límite de pedidos) devuelven JSON
    // válido con forma {error:"..."}. Antes se devolvía ese cuerpo sin mirar
    // el status, así que el llamador leía `data.conversaciones` como undefined
    // y pintaba "Sin conversaciones": la bandeja se veía vacía y normal cuando
    // en realidad no había podido leer nada.
    if (!r.ok) {
      const e = new Error('bandeja HTTP ' + r.status);
      e.status = r.status;
      e.motivo = r.status === 401 ? 'sesion' : r.status === 429 ? 'limite' : 'servidor';
      throw e;
    }
    return r.json();
  },

  _msgError(e) {
    if (e?.motivo === 'sesion') return 'Se venció tu sesión. Cerrá y volvé a entrar para ver la bandeja.';
    if (e?.motivo === 'limite') return 'Demasiados pedidos seguidos. Esperá unos segundos y probá de nuevo.';
    return 'No se pudo conectar con la bandeja. Reintentando…';
  },

  // Con la sesión vencida no tiene sentido seguir preguntando cada 5 segundos
  // con un token muerto: se frena el refresco hasta que la persona vuelva a entrar.
  _frenarSiSesionVencida(e) {
    if (e?.motivo !== 'sesion') return;
    clearInterval(this._timerLista);
    clearInterval(this._timerChat);
  },

  // ── lista conversaciones ─────────────────────────────────────────────────────
  async cargarLista() {
    const qs = this.filtro ? '?q=' + encodeURIComponent(this.filtro) : '';
    let data;
    try {
      data = await this._api('/conversaciones' + qs);
    } catch (e) {
      const cont = document.getElementById('bdj-lista');
      const estado = document.getElementById('bdj-estado');
      if (cont) cont.innerHTML = `<div class="bdj-vacio bdj-error">${this._esc(this._msgError(e))}</div>`;
      if (estado) estado.textContent = '';
      this._frenarSiSesionVencida(e);
      return;
    }

    const cont = document.getElementById('bdj-lista');
    const estado = document.getElementById('bdj-estado');
    if (!cont) return;

    let convs = data.conversaciones || [];

    // Aplicar filtro de estado
    const yo = this._usuarioActual();
    if (this.filtroEstado === 'cerradas') {
      convs = convs.filter(c => !!this.cerradas[`${c.platform}:${c.userId}`]);
    } else {
      // En todos los demás tabs, excluir cerradas
      convs = convs.filter(c => !this.cerradas[`${c.platform}:${c.userId}`]);
      if (this.filtroEstado === 'espera') convs = convs.filter(c => c.esperandoRespuesta && !c.pausado);
      else if (this.filtroEstado === 'asesor') convs = convs.filter(c => c.pausado);
      else if (this.filtroEstado === 'mio') convs = convs.filter(c => this.asignaciones[`${c.platform}:${c.userId}`] === yo);
    }

    if (!convs.length) {
      cont.innerHTML = `<div class="bdj-vacio">${this.filtro || this.filtroEstado !== 'todos' ? 'Sin resultados.' : 'Sin conversaciones.'}</div>`;
      if (estado) estado.textContent = '';
      return;
    }

    const pend = (data.conversaciones || []).filter(c => c.pausado || c.esperandoRespuesta).length;
    if (estado) estado.textContent = pend ? `${pend} por atender` : 'al día ✓';

    cont.innerHTML = convs.map(c => {
      const activa = this.actual?.userId === c.userId && this.actual?.platform === c.platform ? ' activa' : '';
      let badge = '';
      if (c.pausado) badge = '<span class="bdj-badge asesor">ASESOR</span>';
      else if (c.esperandoRespuesta) badge = '<span class="bdj-badge espera">espera</span>';
      const nom = this._esc(c.nombre || ('+' + c.userId));
      const prev = this._esc((c.ultimoRol === 'cliente' ? '' : c.ultimoRol === 'humano' ? 'Vos: ' : 'Bot: ') + (c.ultimoTexto || ''));
      const key = `${c.platform}:${c.userId}`;
      const asig = this.asignaciones[key];
      const asigTag = asig ? `<div class="asig-tag">👤 ${this._esc(asig)}</div>` : '';
      const color = this._avatarColor(c.nombre || c.userId);
      const inicial = (c.nombre || c.userId || '?')[0].toUpperCase();
      return `<div class="bdj-conv${activa}" data-p="${this._esc(c.platform)}" data-u="${this._esc(c.userId)}" data-n="${this._esc(c.nombre||'')}">
        <div class="bdj-avatar" style="background:${color}">${inicial}</div>
        <div class="bdj-conv-body">
          <div class="top"><span class="nom">${nom}</span>${badge}<span class="hora">${this._hace(c.ultimaActividad)}</span></div>
          <div class="prev">${prev}</div>
          ${asigTag}
        </div>
      </div>`;
    }).join('');

    cont.querySelectorAll('.bdj-conv').forEach(el =>
      el.addEventListener('click', () => this.abrir(el.dataset.p, el.dataset.u, el.dataset.n)));
  },

  // ── chat ─────────────────────────────────────────────────────────────────────
  async cargarChat() {
    if (!this.actual) return;
    const msgs = document.getElementById('bdj-msgs');
    if (!msgs) return;

    // Mostrar indicador de carga solo la primera vez (cuando está vacío o con el placeholder)
    const esPrimera = msgs.querySelector('.bdj-vacio') || msgs.children.length === 0;
    if (esPrimera) {
      msgs.innerHTML = `<div class="bdj-loading"><span></span><span></span><span></span></div>`;
    }

    let data;
    try {
      data = await this._api(`/conversacion?platform=${encodeURIComponent(this.actual.platform)}&userId=${encodeURIComponent(this.actual.userId)}`);
    } catch (e) {
      msgs.innerHTML = `<div class="bdj-vacio bdj-error">${this._esc(this._msgError(e))}</div>`;
      this._firmaChat = null;
      this._frenarSiSesionVencida(e);
      return;
    }

    const nom = document.getElementById('bdj-chatnom');
    const btnBot = document.getElementById('bdj-bot-btn');
    if (!document.getElementById('bdj-msgs')) return;

    if (nom) nom.textContent = data.nombre || ('+' + this.actual.userId);
    if (btnBot) btnBot.style.display = data.pausado ? 'inline-block' : 'none';
    this._actualizarAssignBtn();
    this._actualizarCerrarBtn();

    // No repintar si nada cambió: repintar corta el audio que se esté escuchando.
    const lista = data.mensajes || [];
    const firma = JSON.stringify(lista.map(m => [m.rol, m.texto, m.en, m.media?.id]));
    if (firma === this._firmaChat && !esPrimera) return;

    // Si hay un audio sonando, esperar a que termine antes de repintar.
    const sonando = [...msgs.querySelectorAll('audio')].some(a => !a.paused && !a.ended);
    if (sonando && !esPrimera) return;

    this._firmaChat = firma;

    const abajo = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
    msgs.innerHTML = lista.map(m => {
      const rolLabel = m.rol === 'cliente' ? 'Cliente' : m.rol === 'humano' ? 'Vos (equipo)' : 'Bot';
      return `<div class="bdj-msg ${m.rol}">
        <span class="rol">${rolLabel}</span>${this._mediaHTML(m)}${this._esc(m.texto)}<span class="hora-msg">${this._horaFull(m.en)}</span>
      </div>`;
    }).join('') || '<div class="bdj-vacio">Sin mensajes aún.</div>';
    if (abajo || esPrimera) msgs.scrollTop = msgs.scrollHeight;
    this._hidratarMedia(msgs);
  },

  // ── adjuntos (audios / imágenes de WhatsApp) ─────────────────────────────────
  _mediaHTML(m) {
    const md = m.media;
    if (!md || !md.id) return '';
    const tipo = (md.tipo || '').toLowerCase();
    const nombre = md.nombre || 'archivo';
    const clase = tipo === 'audio' ? 'audio' : (tipo === 'imagen' || tipo === 'image') ? 'imagen' : 'archivo';
    const carga = clase === 'audio' ? '🎤 Cargando audio…'
                : clase === 'imagen' ? '🖼️ Cargando imagen…'
                : `📎 ${this._esc(nombre)}`;
    return `<div class="bdj-media" data-mid="${this._esc(md.id)}" data-mtipo="${clase}" data-mnom="${this._esc(nombre)}">
      <div class="bdj-media-load">${carga}</div>
    </div>`;
  },

  async _mediaURL(id) {
    this._mediaCache = this._mediaCache || {};
    if (this._mediaCache[id]) return this._mediaCache[id];
    const token = await this._token();
    const r = await fetch('/api/bandeja/media/' + encodeURIComponent(id), { headers: { 'x-crm-token': token } });
    if (!r.ok) throw new Error('media HTTP ' + r.status);
    const url = URL.createObjectURL(await r.blob());
    this._mediaCache[id] = url;
    return url;
  },

  async _hidratarMedia(cont) {
    for (const el of cont.querySelectorAll('.bdj-media[data-mid]')) {
      if (el.dataset.listo) continue;
      el.dataset.listo = '1';
      const nom = el.dataset.mnom || 'archivo';
      try {
        const url = await this._mediaURL(el.dataset.mid);
        if (el.dataset.mtipo === 'audio') {
          el.innerHTML = `<audio controls preload="metadata"></audio>`;
          el.querySelector('audio').src = url;
        } else if (el.dataset.mtipo === 'imagen') {
          el.innerHTML = `<a target="_blank" rel="noopener"><img alt="${this._esc(nom)}" loading="lazy"></a>`;
          el.querySelector('a').href = url;
          el.querySelector('img').src = url;
        } else {
          el.innerHTML = `<a download="${this._esc(nom)}">📎 ${this._esc(nom)}</a>`;
          el.querySelector('a').href = url;
        }
      } catch {
        el.innerHTML = `<div class="bdj-media-err">⚠️ No se pudo cargar el adjunto</div>`;
        el.dataset.listo = '';
      }
    }
  },

  abrir(platform, userId, nombre) {
    this.actual = { platform, userId, nombre };
    const wrap = document.getElementById('bdj-wrap');
    if (wrap) wrap.classList.add('enchat');
    const barra = document.getElementById('bdj-barra');
    if (barra) barra.style.display = 'flex';
    document.getElementById('bdj-assign-wrap')?.style && (document.getElementById('bdj-assign-wrap').style.display = 'block');
    const cerrarBtn = document.getElementById('bdj-cerrar-btn');
    if (cerrarBtn) cerrarBtn.style.display = 'block';
    this._actualizarCerrarBtn();
    this.cargarChat();
    this.cargarLista();
    clearInterval(this._timerChat);
    this._timerChat = setInterval(() => this.cargarChat(), 4000);
  },

  // ── acciones ─────────────────────────────────────────────────────────────────
  async enviar() {
    const ta = document.getElementById('bdj-texto');
    const btn = document.getElementById('bdj-enviar');
    const texto = ta?.value.trim();
    if (!texto || !this.actual) return;
    btn.disabled = true;
    try {
      const r = await this._api('/responder', {
        method: 'POST',
        body: JSON.stringify({ platform: this.actual.platform, userId: this.actual.userId, texto }),
      });
      if (r.ok) { ta.value = ''; ta.style.height = '44px'; this.cargarChat(); this.cargarLista(); }
      else toast('No se pudo enviar: ' + (r.error || ''));
    } catch (e) {
      toast(e?.motivo ? this._msgError(e) : 'Error de conexión');
      this._frenarSiSesionVencida(e);
    }
    btn.disabled = false;
    ta?.focus();
  },

  async retomarBot() {
    if (!this.actual) return;
    try {
      await this._api('/retomar-bot', { method: 'POST', body: JSON.stringify(this.actual) });
    } catch (e) {
      toast(this._msgError(e));
      this._frenarSiSesionVencida(e);
      return;
    }
    this.cargarChat();
    this.cargarLista();
  },

  _volverLista() {
    document.getElementById('bdj-wrap')?.classList.remove('enchat');
    this.actual = null;
    clearInterval(this._timerChat);
  },

  _bindBusqueda() {
    let busqTimer;
    document.getElementById('bdj-q')?.addEventListener('input', e => {
      this.filtro = e.target.value.trim();
      clearTimeout(busqTimer);
      busqTimer = setTimeout(() => this.cargarLista(), 250);
    });
  },

  // ── utilidades ────────────────────────────────────────────────────────────────
  _esc(s = '') {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
  _horaFull(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const hoy = new Date();
      const ayer = new Date(hoy); ayer.setDate(hoy.getDate() - 1);
      const hora = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      if (d.toDateString() === hoy.toDateString()) return `hoy ${hora}`;
      if (d.toDateString() === ayer.toDateString()) return `ayer ${hora}`;
      return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }) + ` ${hora}`;
    } catch { return ''; }
  },
  _hace(iso) {
    if (!iso) return '';
    try {
      const s = (Date.now() - new Date(iso).getTime()) / 1000;
      if (s < 60) return 'recién';
      if (s < 3600) return Math.floor(s / 60) + 'm';
      const d = new Date(iso);
      const hoy = new Date();
      const ayer = new Date(hoy); ayer.setDate(hoy.getDate() - 1);
      if (d.toDateString() === hoy.toDateString()) return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      if (d.toDateString() === ayer.toDateString()) return 'ayer';
      return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
    } catch { return ''; }
  },
  _avatarColor(nombre = '') {
    const colors = ['#007aff','#34c759','#ff9500','#ff3b30','#af52de','#5ac8fa','#ff2d55','#4cd964','#ff6b35','#5856d6'];
    let h = 0;
    for (let i = 0; i < nombre.length; i++) h = (h * 31 + nombre.charCodeAt(i)) & 0xffffffff;
    return colors[Math.abs(h) % colors.length];
  },
};

window.Bandeja = Bandeja;
export default Bandeja;
