// ═════════════════════════════════════════════════════════════
//  CRM en el celular: barra inferior + hoja "Más" + hojas inferiores reutilizables.
//  Sólo actúa con la pantalla angosta (< 1024 px, el mismo corte que usa movil.css); en escritorio
//  no dibuja nada. El menú lateral sigue siendo la fuente de los destinos: la barra y "Más" se arman
//  leyéndolo, así no hay un segundo listado que se pueda desincronizar.
// ═════════════════════════════════════════════════════════════

const Sheet = {
  _actual: null,

  // Abre una hoja inferior. `cuerpo` puede ser HTML (texto) o un nodo. `pie` (opcional) es HTML con los botones.
  // Devuelve { el, cuerpo, cerrar }. Con `alta: true` ocupa casi toda la pantalla (formularios largos).
  abrir({ titulo = '', cuerpo = '', pie = '', alta = false, alCerrar = null } = {}) {
    // Si ya había una hoja, la nueva hereda su entrada de historial en vez de apilar otra.
    let hereda = false;
    if (this._actual) { hereda = !!this._actual._historial; this._actual._historial = false; this._quitar(this._actual, true); }

    const fondo = document.createElement('div');
    fondo.className = 'm-sheet-bg';
    const hoja = document.createElement('div');
    hoja.className = 'm-sheet' + (alta ? ' alta' : '');
    hoja.setAttribute('role', 'dialog');
    hoja.setAttribute('aria-modal', 'true');
    hoja.setAttribute('aria-label', titulo || 'Opciones');
    hoja.tabIndex = -1;
    hoja.innerHTML = `
      <div class="m-sheet-grab" aria-hidden="true"></div>
      <div class="m-sheet-head">
        <h2 class="m-sheet-titulo"></h2>
        <button type="button" class="m-sheet-x" aria-label="Cerrar">&#10005;</button>
      </div>
      <div class="m-sheet-cuerpo"></div>
      ${pie ? '<div class="m-sheet-pie"></div>' : ''}`;
    hoja.querySelector('.m-sheet-titulo').textContent = titulo;
    const zona = hoja.querySelector('.m-sheet-cuerpo');
    if (typeof cuerpo === 'string') zona.innerHTML = cuerpo; else if (cuerpo) zona.appendChild(cuerpo);
    if (pie) hoja.querySelector('.m-sheet-pie').innerHTML = pie;

    const h = { el: hoja, fondo, cuerpo: zona, alCerrar, opener: document.activeElement, cerrar: () => this.cerrar(h) };
    fondo.addEventListener('click', () => h.cerrar());
    hoja.querySelector('.m-sheet-x').addEventListener('click', () => h.cerrar());
    document.body.append(fondo, hoja);
    document.body.classList.add('m-hoja-abierta');
    const shell = document.getElementById('app-shell');
    if (shell) shell.inert = true;               // aria-modal solo no impide tocar la pantalla de atrás
    requestAnimationFrame(() => { fondo.classList.add('visible'); hoja.classList.add('visible'); hoja.focus({ preventScroll: true }); });
    // El botón "atrás" del celular cierra la hoja en vez de salir del CRM.
    if (!hereda) history.pushState({ movilHoja: true }, '');
    h._historial = true;
    this._actual = h;
    return h;
  },

  cerrar(h = this._actual) {
    if (!h || h._cerrando) return;
    // Si la hoja dejó una entrada en el historial, se retira por el mismo camino que usa "atrás".
    if (h._historial && history.state && history.state.movilHoja) { h._historial = false; h._cerrando = false; history.back(); return; }
    this._quitar(h, false);
  },

  _quitar(h, rapido) {
    if (!h || h._cerrando) return;
    h._cerrando = true;
    if (this._actual === h) this._actual = null;
    h.fondo.classList.remove('visible'); h.el.classList.remove('visible');
    const fin = () => {
      h.fondo.remove(); h.el.remove();
      if (!this._actual) {
        document.body.classList.remove('m-hoja-abierta');
        const shell = document.getElementById('app-shell');
        if (shell) shell.inert = false;
        const o = h.opener;
        if (o && document.contains(o) && o.getClientRects().length) o.focus({ preventScroll: true });
      }
      if (typeof h.alCerrar === 'function') { try { h.alCerrar(); } catch (e) { console.error(e); } }
    };
    if (rapido) fin(); else setTimeout(fin, 260);
  },
};

const Movil = {
  _mq: window.matchMedia('(max-width: 1023px)'),
  PRINCIPALES: [
    ['dashboard', 'Inicio', 'ti-home-2'],
    ['ventas', 'Ventas', 'ti-receipt'],
    ['stock', 'Stock', 'ti-box'],
    ['meli', 'Mercado Libre', 'ti-shopping-cart'],
  ],
  // Avisos de las pantallas que quedan dentro de "Más": se suman en su insignia.
  BADGES_MAS: ['badge-reparaciones', 'badge-cc', 'badge-adelantos', 'badge-actividades'],
  _barra: null,
  _pagina: 'dashboard',

  activo() { return this._mq.matches; },

  iniciar() {
    if (this._barra) return;
    const barra = document.createElement('nav');
    barra.className = 'm-tabbar';
    barra.setAttribute('aria-label', 'Navegación principal');
    barra.innerHTML = this.PRINCIPALES.map(([k, etq, ico]) => `
      <button type="button" class="m-tab" data-tab="${k}" aria-label="${etq}">
        <span class="m-tab-ico"><i class="ti ${ico}"></i></span><span class="m-tab-etq">${etq}</span>
        <span class="m-badge" hidden></span>
      </button>`).join('') + `
      <button type="button" class="m-tab" data-tab="mas" aria-label="Más opciones" aria-haspopup="dialog">
        <span class="m-tab-ico"><i class="ti ti-layout-grid"></i></span><span class="m-tab-etq">Más</span>
        <span class="m-badge" hidden></span>
      </button>`;
    barra.addEventListener('click', (ev) => {
      const b = ev.target.closest('.m-tab'); if (!b) return;
      if (b.dataset.tab === 'mas') return this.abrirMas();
      App.goTo(b.dataset.tab);
    });
    document.body.appendChild(barra);
    this._barra = barra;
    this._mq.addEventListener('change', () => this._aplicar());
    this._aplicar();
    // Los avisos viven en el menú lateral: se espejan cuando cambian.
    const sb = document.getElementById('sidebar');
    if (sb) new MutationObserver(() => this._pedirBadges()).observe(sb, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style'] });
    // "Atrás" del celular con una hoja abierta: la cierra.
    window.addEventListener('popstate', () => { if (Sheet._actual) { const h = Sheet._actual; h._historial = false; Sheet._quitar(h, false); } });
    document.addEventListener('keydown', (ev) => {
      const h = Sheet._actual; if (!h) return;
      if (ev.key === 'Escape') { ev.preventDefault(); h.cerrar(); return; }
      if (ev.key !== 'Tab') return;
      const f = [...h.el.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((e) => !e.disabled && !e.hidden && e.getClientRects().length);
      if (!f.length) { ev.preventDefault(); h.el.focus(); return; }
      const a = document.activeElement;
      if (ev.shiftKey && (a === f[0] || !h.el.contains(a))) { ev.preventDefault(); f[f.length - 1].focus(); }
      else if (!ev.shiftKey && (a === f[f.length - 1] || !h.el.contains(a))) { ev.preventDefault(); f[0].focus(); }
    });
    this.sincronizar(this._pagina);
  },

  _aplicar() { if (this._barra) this._barra.hidden = !this.activo(); },

  // Lo llama App.goTo cada vez que cambia la pantalla.
  sincronizar(pagina) {
    this._pagina = pagina || this._pagina;
    if (!this._barra) return;
    const principal = this.PRINCIPALES.some(([k]) => k === this._pagina);
    this._barra.querySelectorAll('.m-tab').forEach((b) => {
      const on = b.dataset.tab === (principal ? this._pagina : 'mas');
      b.classList.toggle('activo', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    this._pedirBadges();
  },

  _raf: 0,
  _pedirBadges() { if (this._raf) return; this._raf = requestAnimationFrame(() => { this._raf = 0; this._badges(); }); },
  _num(id) {
    const e = document.getElementById(id);
    if (!e || e.style.display === 'none') return 0;
    const n = parseInt(String(e.textContent).replace(/\D/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  },
  _badges() {
    if (!this._barra) return;
    const valores = { ventas: this._num('badge-ventas'), meli: this._num('badge-meli'), mas: this.BADGES_MAS.reduce((s, id) => s + this._num(id), 0) };
    this._barra.querySelectorAll('.m-tab').forEach((b) => {
      const n = valores[b.dataset.tab] || 0, el = b.querySelector('.m-badge');
      el.hidden = n <= 0; el.textContent = n > 99 ? '99+' : String(n);
    });
  },

  // Hoja "Más": los destinos que no están en la barra, agrupados como en el menú lateral.
  abrirMas() {
    const esc = (s) => State.esc(String(s));
    const principales = new Set(this.PRINCIPALES.map(([k]) => k));
    const grupos = [...document.querySelectorAll('#sidebar .nav-group')].map((g) => {
      const etq = (g.querySelector('.nav-label')?.textContent || '').trim();
      const items = [...g.querySelectorAll('.nav-item')].filter((i) => !principales.has(i.dataset.page)).map((i) => {
        const ico = (i.querySelector('i')?.className.match(/ti-[a-z0-9-]+/) || ['ti-circle'])[0];
        // el texto del ítem sin el aviso numérico que lleva adentro
        const copia = i.cloneNode(true); copia.querySelectorAll('span, i').forEach((n) => n.remove());
        const badge = this._num((i.querySelector('span[id^="badge-"]') || {}).id);
        return { page: i.dataset.page, etq: copia.textContent.trim(), ico, badge };
      });
      return { etq, items };
    }).filter((g) => g.items.length);

    const html = grupos.map((g) => `
      <div class="m-mas-grupo">
        <div class="m-mas-etq">${esc(g.etq)}</div>
        <div class="m-mas-grid">${g.items.map((i) => `
          <button type="button" class="m-mas-item" data-page="${esc(i.page)}">
            <i class="ti ${esc(i.ico)}"></i><span>${esc(i.etq)}</span>
            ${i.badge ? `<span class="m-badge">${i.badge > 99 ? '99+' : i.badge}</span>` : ''}
          </button>`).join('')}
        </div>
      </div>`).join('') + `
      <div class="m-mas-acciones">
        <button type="button" class="btn btn-primary" data-accion="venta"><i class="ti ti-plus"></i> Venta rápida</button>
        <button type="button" class="btn" data-accion="salir"><i class="ti ti-logout"></i> Cerrar sesión</button>
      </div>`;

    const h = Sheet.abrir({ titulo: 'Más', cuerpo: html, alta: true });
    h.cuerpo.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-page]');
      if (t) { h.cerrar(); setTimeout(() => App.goTo(t.dataset.page), 60); return; }
      const a = ev.target.closest('[data-accion]');
      if (!a) return;
      if (a.dataset.accion === 'venta') { h.cerrar(); setTimeout(() => { App.goTo('ventas'); setTimeout(() => Ventas.openNew(), 50); }, 60); }
      if (a.dataset.accion === 'salir') { h.cerrar(); Auth.cerrarSesion(); }
    });
    return h;
  },
};

window.Sheet = Sheet;
window.Movil = Movil;
