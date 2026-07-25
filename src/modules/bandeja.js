const Bandeja = {
  actual: null,
  _timerLista: null,
  _timerChat: null,
  filtro: '',

  // ── render principal ────────────────────────────────────────────────────────
  render() {
    this.destroy();
    const c = document.createElement('div');
    c.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden;width:100%';
    c.innerHTML = `
      <style>
        #bdj-wrap { display:flex; height:calc(100vh - 56px); gap:0; }
        #bdj-izq { width:320px; min-width:0; border-right:1px solid var(--border); display:flex; flex-direction:column; background:var(--bg-elevated); }
        #bdj-busq { padding:10px; border-bottom:1px solid var(--border); }
        #bdj-busq input { width:100%; border:1px solid var(--border-strong); border-radius:18px; padding:8px 14px; font-size:13px; background:var(--bg); color:var(--text); outline:none; }
        #bdj-busq input:focus { border-color:var(--blue); }
        #bdj-lista { flex:1; overflow-y:auto; }
        .bdj-conv { padding:11px 14px; border-bottom:1px solid var(--border); cursor:pointer; }
        .bdj-conv:hover { background:var(--bg-secondary); }
        .bdj-conv.activa { background:rgba(var(--blue-rgb,0,122,255),.08); border-left:3px solid var(--blue); }
        .bdj-conv .top { display:flex; align-items:center; gap:6px; margin-bottom:3px; }
        .bdj-conv .nom { font-weight:600; font-size:13.5px; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .bdj-conv .hora { font-size:10.5px; color:var(--text-secondary); flex-shrink:0; }
        .bdj-conv .prev { font-size:12px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .bdj-badge { font-size:10px; font-weight:700; padding:2px 7px; border-radius:10px; color:#fff; flex-shrink:0; }
        .bdj-badge.asesor { background:var(--red,#e0245e); }
        .bdj-badge.espera { background:var(--amber,#f5a623); }
        #bdj-chat { flex:1; display:flex; flex-direction:column; min-width:0; }
        #bdj-head { padding:11px 16px; background:var(--bg-elevated); border-bottom:1px solid var(--border); display:flex; align-items:center; gap:10px; }
        #bdj-head .nom { font-weight:600; font-size:14px; flex:1; }
        #bdj-msgs { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:6px; background:var(--bg); }
        .bdj-msg { max-width:76%; padding:8px 11px; border-radius:10px; font-size:13.5px; line-height:1.4; white-space:pre-wrap; word-wrap:break-word; }
        .bdj-msg.cliente { background:var(--bg-elevated); border:1px solid var(--border); align-self:flex-start; }
        .bdj-msg.bot { background:rgba(52,199,89,.12); border:1px solid rgba(52,199,89,.25); align-self:flex-end; }
        .bdj-msg.humano { background:rgba(0,122,255,.12); border:1px solid rgba(0,122,255,.25); align-self:flex-end; }
        .bdj-msg .rol { display:block; font-size:10px; font-weight:700; opacity:.6; margin-bottom:3px; text-transform:uppercase; }
        .bdj-msg .hora-msg { display:block; font-size:10px; color:var(--text-secondary); text-align:right; margin-top:3px; }
        #bdj-barra { padding:10px 12px; background:var(--bg-elevated); border-top:1px solid var(--border); display:flex; gap:8px; }
        #bdj-barra textarea { flex:1; resize:none; border:1px solid var(--border-strong); border-radius:12px; padding:9px 14px; font-size:13.5px; font-family:inherit; height:42px; max-height:120px; background:var(--bg); color:var(--text); outline:none; }
        #bdj-barra textarea:focus { border-color:var(--blue); }
        #bdj-enviar { background:var(--blue,#007aff); color:#fff; border:none; border-radius:50%; width:42px; height:42px; font-size:18px; cursor:pointer; flex-shrink:0; }
        #bdj-enviar:disabled { opacity:.4; }
        .bdj-vacio { padding:40px; text-align:center; color:var(--text-secondary); font-size:14px; }
        #bdj-estado { font-size:12px; color:var(--text-secondary); margin-left:auto; }
        @media (max-width:700px) {
          #bdj-wrap { position:relative; }
          #bdj-izq { width:100%; position:absolute; inset:0; z-index:1; }
          #bdj-chat { position:absolute; inset:0; z-index:2; display:none; }
          #bdj-wrap.enchat #bdj-izq { display:none; }
          #bdj-wrap.enchat #bdj-chat { display:flex; }
          #bdj-volver { display:flex !important; }
        }
      </style>
      <div id="bdj-wrap">
        <div id="bdj-izq">
          <div id="bdj-busq"><input id="bdj-q" type="text" placeholder="🔍 Buscar conversación…" autocomplete="off"></div>
          <div id="bdj-lista"><div class="bdj-vacio">Cargando…</div></div>
        </div>
        <div id="bdj-chat">
          <div id="bdj-head">
            <button id="bdj-volver" style="display:none;background:none;border:none;font-size:20px;cursor:pointer;color:var(--text)" title="Volver" onclick="Bandeja._volverLista()">←</button>
            <span class="nom" id="bdj-chatnom">Elegí una conversación</span>
            <button class="btn btn-sm" id="bdj-bot-btn" style="display:none" onclick="Bandeja.retomarBot()">🤖 Retomar bot</button>
            <span id="bdj-estado"></span>
          </div>
          <div id="bdj-msgs"><div class="bdj-vacio">Elegí una conversación para verla.</div></div>
          <div id="bdj-barra" style="display:none">
            <textarea id="bdj-texto" placeholder="Escribí tu respuesta…" rows="1" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();Bandeja.enviar()}" oninput="this.style.height='42px';this.style.height=Math.min(this.scrollHeight,120)+'px'"></textarea>
            <button id="bdj-enviar" title="Enviar" onclick="Bandeja.enviar()"><i class="ti ti-send"></i></button>
          </div>
        </div>
      </div>`;

    setTimeout(() => this._bindBusqueda(), 0);
    this.cargarLista();
    this._timerLista = setInterval(() => this.cargarLista(), 5000);
    return c;
  },

  destroy() {
    clearInterval(this._timerLista);
    clearInterval(this._timerChat);
    this.actual = null;
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
    return r.json();
  },

  // ── lista conversaciones ─────────────────────────────────────────────────────
  async cargarLista() {
    const qs = this.filtro ? '?q=' + encodeURIComponent(this.filtro) : '';
    let data;
    try { data = await this._api('/conversaciones' + qs); } catch { return; }

    const cont = document.getElementById('bdj-lista');
    const estado = document.getElementById('bdj-estado');
    if (!cont) return;

    if (!data.conversaciones?.length) {
      cont.innerHTML = `<div class="bdj-vacio">${this.filtro ? 'Sin resultados.' : 'Sin conversaciones.'}</div>`;
      if (estado) estado.textContent = '';
      return;
    }

    const pend = data.conversaciones.filter(c => c.pausado || c.esperandoRespuesta).length;
    if (estado) estado.textContent = pend ? `${pend} por atender` : 'al día ✓';

    cont.innerHTML = data.conversaciones.map(c => {
      const activa = this.actual?.userId === c.userId && this.actual?.platform === c.platform ? ' activa' : '';
      let badge = '';
      if (c.pausado) badge = '<span class="bdj-badge asesor">ASESOR</span>';
      else if (c.esperandoRespuesta) badge = '<span class="bdj-badge espera">espera</span>';
      const nom = this._esc(c.nombre || ('+' + c.userId));
      const prev = this._esc((c.ultimoRol === 'cliente' ? '' : c.ultimoRol === 'humano' ? 'Vos: ' : 'Bot: ') + (c.ultimoTexto || ''));
      return `<div class="bdj-conv${activa}" data-p="${this._esc(c.platform)}" data-u="${this._esc(c.userId)}" data-n="${this._esc(c.nombre||'')}">
        <div class="top"><span class="nom">${nom}</span>${badge}<span class="hora">${this._hace(c.ultimaActividad)}</span></div>
        <div class="prev">${prev}</div>
      </div>`;
    }).join('');

    cont.querySelectorAll('.bdj-conv').forEach(el =>
      el.addEventListener('click', () => this.abrir(el.dataset.p, el.dataset.u, el.dataset.n)));
  },

  // ── chat ─────────────────────────────────────────────────────────────────────
  async cargarChat() {
    if (!this.actual) return;
    let data;
    try {
      data = await this._api(`/conversacion?platform=${encodeURIComponent(this.actual.platform)}&userId=${encodeURIComponent(this.actual.userId)}`);
    } catch { return; }

    const nom = document.getElementById('bdj-chatnom');
    const btnBot = document.getElementById('bdj-bot-btn');
    const msgs = document.getElementById('bdj-msgs');
    if (!msgs) return;

    if (nom) nom.textContent = data.nombre || ('+' + this.actual.userId);
    if (btnBot) btnBot.style.display = data.pausado ? 'inline-block' : 'none';

    const abajo = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
    msgs.innerHTML = (data.mensajes || []).map(m => {
      const rolLabel = m.rol === 'cliente' ? 'Cliente' : m.rol === 'humano' ? 'Vos (equipo)' : 'Bot';
      return `<div class="bdj-msg ${m.rol}">
        <span class="rol">${rolLabel}</span>${this._esc(m.texto)}<span class="hora-msg">${this._hora(m.en)}</span>
      </div>`;
    }).join('');
    if (abajo) msgs.scrollTop = msgs.scrollHeight;
  },

  abrir(platform, userId, nombre) {
    this.actual = { platform, userId, nombre };
    const wrap = document.getElementById('bdj-wrap');
    if (wrap) wrap.classList.add('enchat');
    const barra = document.getElementById('bdj-barra');
    if (barra) barra.style.display = 'flex';
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
      if (r.ok) { ta.value = ''; ta.style.height = '42px'; this.cargarChat(); this.cargarLista(); }
      else toast('No se pudo enviar: ' + (r.error || ''));
    } catch { toast('Error de conexión'); }
    btn.disabled = false;
    ta?.focus();
  },

  async retomarBot() {
    if (!this.actual) return;
    await this._api('/retomar-bot', { method: 'POST', body: JSON.stringify(this.actual) });
    this.cargarChat();
    this.cargarLista();
  },

  _volverLista() {
    document.getElementById('bdj-wrap')?.classList.remove('enchat');
    this.actual = null;
    clearInterval(this._timerChat);
  },

  // solo el buscador necesita binding ya que los demás usan onclick inline
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
  _hora(iso) {
    try { return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
  },
  _hace(iso) {
    if (!iso) return '';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'recién';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  },
};

window.Bandeja = Bandeja;
export default Bandeja;
