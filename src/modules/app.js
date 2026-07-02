import './supabase-config.js';
import './state.js';
import './dashboard.js';
import './stock.js';
import './ventas.js';
import './reparaciones.js';
import './gastos.js';
import './cueva.js';
import './cajas.js';
import './cashflow.js';
import './panel.js';

const App = {
  PAGES: {
    dashboard: { title: 'Panel general', module: Dashboard },
    ventas: { title: 'Ventas', module: Ventas },
    stock: { title: 'Stock', module: Stock },
    reparaciones: { title: 'Reparaciones', module: Reparaciones },
    gastos: { title: 'Gastos', module: Gastos },
    cueva: { title: 'Cueva / cambio de divisas', module: Cueva },
    cajas: { title: 'Cajas', module: Cajas },
    cashflow: { title: 'Cash flow', module: CashFlow },
    panel: { title: 'Panel de control', module: Panel },
  },

  async init() {
    const session = await Auth.obtenerSesionActual();
    if (!session) {
      this.mostrarLogin();
      return;
    }
    await this.validarYArrancar(session);

    // Si el login redirige y vuelve a esta misma página, Supabase dispara este evento
    Auth.escucharCambiosDeSesion(async (event, session) => {
      if (event === 'SIGNED_IN' && session) {
        await this.validarYArrancar(session);
      }
      if (event === 'SIGNED_OUT') {
        window.location.reload();
      }
    });
  },

  mostrarLogin(mensaje) {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app-shell').style.display = 'none';
    if (mensaje) document.getElementById('login-status').textContent = mensaje;
  },

  async validarYArrancar(session) {
    const email = session.user.email;
    const statusEl = document.getElementById('login-status');
    if (statusEl) statusEl.textContent = 'Verificando acceso...';

    const autorizado = await Auth.emailEstaAutorizado(email);
    if (!autorizado) {
      this.mostrarLogin(`El usuario ${email} no tiene acceso autorizado a iPhoneMood. Pedile al administrador que lo agregue desde el Panel de control.`);
      document.getElementById('login-google-btn').innerHTML = `<i class="ti ti-logout"></i> Probar con otra cuenta`;
      document.getElementById('login-google-btn').onclick = () => Auth.cerrarSesion();
      return;
    }

    Auth.usuario = {
      email,
      nombre: autorizado.nombre || session.user.user_metadata?.full_name || email.split('@')[0],
      avatarUrl: session.user.user_metadata?.avatar_url || ''
    };

    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-shell').style.display = 'flex';
    document.getElementById('user-avatar').textContent = Auth.usuario.nombre.substring(0, 2).toUpperCase();
    document.getElementById('user-name').textContent = Auth.usuario.nombre;
    document.getElementById('user-email-full').textContent = Auth.usuario.email;

    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => this.goTo(item.dataset.page));
    });

    const container = document.getElementById('pages');
    container.innerHTML = `<div class="empty-state" style="margin:auto"><i class="ti ti-loader-2" style="font-size:32px"></i><div style="margin-top:8px">Cargando datos desde la base...</div></div>`;
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.justifyContent = 'center';
    container.style.flex = '1';

    try {
      await DB.cargarTodo();
    } catch (err) {
      console.error('Error cargando datos de Supabase', err);
      container.innerHTML = `<div class="empty-state" style="margin:auto"><i class="ti ti-alert-triangle"></i>No se pudo conectar con la base de datos. Revisá tu conexión a internet y recargá la página.</div>`;
      return;
    }

    document.getElementById('topbar-blue').textContent = State.refBlue;
    document.getElementById('topbar-usdt').textContent = State.refUsdt;
    this.goTo('dashboard');

    // Si la página se recargó sola mientras había una venta a medio cargar
    // (por ejemplo, el navegador descargó la pestaña por inactividad), avisamos
    // con un banner FIJO (no un toast que desaparece solo) para que no se pierda
    // aunque el usuario tarde en volver a mirar la pantalla.
    this.chequearBorradorVentaPendiente();
  },

  chequearBorradorVentaPendiente() {
    const borradorPendiente = Ventas.hayBorradorPendiente();
    const tieneAlgo = borradorPendiente && borradorPendiente.draft && (borradorPendiente.draft.items?.length || borradorPendiente.draft.cliente);
    const existing = document.getElementById('borrador-venta-banner');
    if (existing) existing.remove();
    if (!tieneAlgo) return;

    const banner = document.createElement('div');
    banner.id = 'borrador-venta-banner';
    banner.style.cssText = 'background:var(--amber-light);border-bottom:2px solid var(--amber);padding:10px 20px;display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;font-size:12.5px;color:var(--amber-dark);flex-shrink:0';
    const items = borradorPendiente.draft.items?.length || 0;
    banner.innerHTML = `
      <span><i class="ti ti-alert-triangle"></i> Tenés una venta sin terminar para <b>${borradorPendiente.draft.cliente || 'un cliente'}</b> (${items} ítem(s)). La página se reinició antes de que la confirmaras.</span>
      <button class="btn btn-sm btn-primary" onclick="App.continuarVentaPendiente()">Continuar venta</button>
      <button class="btn btn-sm" onclick="App.descartarVentaPendiente()">Descartar</button>
    `;
    // Lo insertamos como primer hijo de .main (la columna vertical: topbar + contenido),
    // antes de la topbar — así empuja todo hacia abajo en vez de romper el layout horizontal.
    const main = document.querySelector('.main');
    if (main) main.insertBefore(banner, main.firstChild);
  },

  continuarVentaPendiente() {
    document.getElementById('borrador-venta-banner')?.remove();
    this.goTo('ventas');
    setTimeout(() => Ventas.openNew(), 100);
  },

  descartarVentaPendiente() {
    Ventas.borrarBorrador();
    document.getElementById('borrador-venta-banner')?.remove();
  },

  toggleUserMenu() {
    const dd = document.getElementById('user-menu-dropdown');
    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  },

  toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebar-overlay').classList.toggle('show');
  },
  closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('show');
  },

  goTo(pageKey) {
    const page = this.PAGES[pageKey];
    if (!page) return;
    document.getElementById('page-title').textContent = page.title;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === pageKey));
    const container = document.getElementById('pages');
    container.innerHTML = '';
    container.className = '';
    const pageEl = document.createElement('div');
    pageEl.style.flex = '1';
    pageEl.style.display = 'flex';
    pageEl.style.flexDirection = 'column';
    pageEl.style.overflow = 'hidden';
    pageEl.appendChild(page.module.render());
    container.appendChild(pageEl);
    container.style.display = 'flex';
    container.style.flex = '1';
    container.style.flexDirection = 'column';
    container.style.overflow = 'hidden';
    this.closeSidebar();
    document.getElementById('user-menu-dropdown').style.display = 'none';
  }
};

document.addEventListener('click', (e) => {
  const menu = document.getElementById('user-menu');
  const dd = document.getElementById('user-menu-dropdown');
  if (menu && dd && !menu.contains(e.target)) dd.style.display = 'none';
});

document.addEventListener('DOMContentLoaded', () => App.init());

// ── Búsqueda global ───────────────────────────────────────
const Search = {
  open() {
    document.getElementById('search-overlay').classList.add('open');
    const input = document.getElementById('search-input');
    input.value = '';
    document.getElementById('search-results').innerHTML = '';
    setTimeout(() => input.focus(), 60);
    document.addEventListener('keydown', Search._onKeydown);
  },

  close() {
    document.getElementById('search-overlay').classList.remove('open');
    document.removeEventListener('keydown', Search._onKeydown);
  },

  _onKeydown(e) {
    if (e.key === 'Escape') Search.close();
  },

  handleOverlayClick(e) {
    if (e.target === document.getElementById('search-overlay')) this.close();
  },

  onInput(q) {
    const container = document.getElementById('search-results');
    q = q.trim();
    if (q.length < 2) { container.innerHTML = ''; return; }
    const lower = q.toLowerCase();

    const ventas = (State.ventas || []).filter(v =>
      v.cliente?.toLowerCase().includes(lower) ||
      String(v.id).includes(lower)
    ).slice(0, 5);

    const stock = (State.stock || []).filter(p =>
      p.nombre?.toLowerCase().includes(lower) ||
      (p.imeis || []).some(i => i.toLowerCase().includes(lower))
    ).slice(0, 5);

    const reps = (State.reparaciones || []).filter(r =>
      r.cliente?.toLowerCase().includes(lower) ||
      r.equipo?.toLowerCase().includes(lower) ||
      String(r.id).includes(lower)
    ).slice(0, 5);

    if (!ventas.length && !stock.length && !reps.length) {
      container.innerHTML = `<div class="search-empty">Sin resultados para <b>"${q}"</b></div>`;
      return;
    }

    let html = '';

    if (ventas.length) {
      html += `<div class="search-section-label">Ventas</div>`;
      ventas.forEach(v => {
        const total = (v.items || []).reduce((s, i) => s + i.precio, 0);
        html += `<div class="search-item" onclick="Search._goVenta(${v.id})">
          <div class="search-item-icon ic-ventas"><i class="ti ti-receipt"></i></div>
          <div class="search-item-text">
            <div class="search-item-title">${v.cliente || '—'}</div>
            <div class="search-item-sub">#${v.id} · ${v.fecha} · USD ${total.toFixed(0)} · ${v.estado}</div>
          </div>
          <i class="ti ti-chevron-right search-arrow"></i>
        </div>`;
      });
    }

    if (stock.length) {
      if (ventas.length) html += `<div class="search-divider"></div>`;
      html += `<div class="search-section-label">Stock</div>`;
      stock.forEach(p => {
        const imeiMatch = (p.imeis || []).find(i => i.toLowerCase().includes(lower));
        const sub = imeiMatch
          ? `IMEI: ${imeiMatch}`
          : `${p.cat?.toUpperCase() || ''} · ${State.getStock(p)} uds · USD ${p.costoUSD}`;
        html += `<div class="search-item" onclick="Search._goStock(${p.id})">
          <div class="search-item-icon ic-stock"><i class="ti ti-box"></i></div>
          <div class="search-item-text">
            <div class="search-item-title">${p.nombre}</div>
            <div class="search-item-sub">${sub}</div>
          </div>
          <i class="ti ti-chevron-right search-arrow"></i>
        </div>`;
      });
    }

    if (reps.length) {
      if (ventas.length || stock.length) html += `<div class="search-divider"></div>`;
      html += `<div class="search-section-label">Reparaciones</div>`;
      reps.forEach(r => {
        html += `<div class="search-item" onclick="Search._goReparacion(${r.id})">
          <div class="search-item-icon ic-reparaciones"><i class="ti ti-tool"></i></div>
          <div class="search-item-text">
            <div class="search-item-title">${r.cliente} — ${r.equipo}</div>
            <div class="search-item-sub">#${r.id} · ${r.fechaIngreso} · ${r.estado}</div>
          </div>
          <i class="ti ti-chevron-right search-arrow"></i>
        </div>`;
      });
    }

    container.innerHTML = html;
  },

  _goVenta(id) {
    this.close();
    App.goTo('ventas');
    setTimeout(() => Ventas.viewSale(id), 80);
  },

  _goStock(id) {
    this.close();
    App.goTo('stock');
    setTimeout(() => Stock.openDrawer('edit', id), 80);
  },

  _goReparacion(id) {
    this.close();
    App.goTo('reparaciones');
    setTimeout(() => Reparaciones.select(id), 80);
  },
};

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    Search.open();
  }
});

window.App = App;
window.Search = Search;
