const Stock = {
  currentTab: 'all',
  currentView: 'productos', // 'productos' | 'historial'
  currentGroup: 'dispositivos', // 'dispositivos' | 'accesorios' | 'perfumeria'
  currentEstado: 'todos', // 'todos' | 'disponible' | 'vendido' | 'reservado' | 'en_reparacion'
  CAT_LABELS: { iphone:'iPhone', android:'Android', mac:'Mac', ipad:'iPad', watch:'Watch', audio:'Audio', perfumeria:'Perfumería', accesorio:'Accesorio', repuesto:'Repuesto', herramienta:'Herramienta', otro:'Otro' },
  CAT_CLASS: { iphone:'b-blue', android:'b-teal', mac:'b-blue', ipad:'b-blue', watch:'b-blue', audio:'b-purple', perfumeria:'b-green', accesorio:'b-purple', repuesto:'b-amber', herramienta:'b-amber', otro:'b-gray' },
  CATS_IMEI: ['iphone','android','mac','ipad'],
  // Agrupación de rubros para las pestañas grandes del panel
  GRUPOS: {
    dispositivos: { label: 'Dispositivos', icon: 'ti-device-mobile', cats: ['iphone','android','mac','ipad','watch','audio'] },
    accesorios: { label: 'Accesorios', icon: 'ti-plug', cats: ['accesorio'] },
    perfumeria: { label: 'Perfumería', icon: 'ti-droplet', cats: ['perfumeria'] },
    taller: { label: 'Taller', icon: 'ti-tool', cats: ['herramienta','repuesto'] },
  },
  ESTADO_INV_LABEL: { disponible:'Disponible', vendido:'Vendido', reservado:'Reservado', en_reparacion:'En reparación' },
  ESTADO_INV_CLASS: { disponible:'b-green', vendido:'b-gray', reservado:'b-amber', en_reparacion:'b-purple' },
  TIPO_MOV_LABEL: { alta:'Alta', baja_venta:'Baja por venta', ajuste_cantidad:'Ajuste de cantidad', imei_agregado:'IMEI agregado', imei_quitado:'IMEI quitado', edicion:'Edición' },
  TIPO_MOV_CLASS: { alta:'b-green', baja_venta:'b-red', ajuste_cantidad:'b-amber', imei_agregado:'b-blue', imei_quitado:'b-gray', edicion:'b-purple' },
  pendingImeis: [],

  // El stock real de un producto se calcula en State.getStock (compartido con
  // Ventas, Dashboard y Reparaciones, para que todos los módulos coincidan).
  stockReal(p) { return State.getStock(p); },

  // Productos del grupo actualmente seleccionado (Dispositivos / Accesorios / Perfumería)
  productosDelGrupo(grupo) {
    const cats = this.GRUPOS[grupo]?.cats || [];
    return State.stock.filter(p => cats.includes(p.cat));
  },

  render() {
    const c = document.createElement('div');
    c.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;min-height:0';
    c.innerHTML = `
      <div style="padding:16px 22px;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:14px">
          <div>
            <h2 style="font-size:19px;font-weight:700;display:flex;align-items:center;gap:8px"><i class="ti ti-box" style="color:var(--blue)"></i> Inventario</h2>
            <p style="font-size:12px;color:var(--text-secondary);margin-top:2px">Gestión de stock de dispositivos, accesorios y perfumería</p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn" onclick="Stock.exportarExcel()"><i class="ti ti-file-spreadsheet"></i> Exportar a Excel</button>
            <button class="btn btn-primary" onclick="Stock.openDrawer('new')"><i class="ti ti-plus"></i> Agregar producto</button>
          </div>
        </div>
        <div id="stock-kpis" style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px" class="stock-kpi-grid"></div>
      </div>

      <div style="padding:10px 22px;border-bottom:1px solid var(--border);display:flex;gap:4px" id="stock-view-tabs"></div>
      <div id="stock-view-host" style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0"></div>
      <div id="stock-drawer-host"></div>
    `;
    setTimeout(() => this.renderView(), 0);
    return c;
  },

  isMobile() { return window.innerWidth <= 900; },

  renderKpis() {
    const grupo = this.productosDelGrupo(this.currentGroup);

    let kpis;
    if (this.currentGroup === 'taller') {
      const herramientas = grupo.filter(p => p.cat === 'herramienta');
      const repuestos    = grupo.filter(p => p.cat === 'repuesto');
      const valorHerr    = herramientas.reduce((a,p) => a + p.costoUSD * Math.max(this.stockReal(p), 1), 0);
      const valorRep     = repuestos.reduce((a,p) => a + p.costoUSD * Math.max(this.stockReal(p), 1), 0);
      const unidadesRep  = repuestos.reduce((a,p) => a + this.stockReal(p), 0);
      kpis = [
        ['Herramientas', herramientas.length + ' ítems', 'ti-tool', 'var(--amber)', 'rgba(255,214,10,.12)'],
        ['Valor herramientas', State.fmtUSD(valorHerr), 'ti-currency-dollar', 'var(--amber)', 'rgba(255,214,10,.12)'],
        ['Repuestos', repuestos.length + ' tipos · ' + unidadesRep + ' uds', 'ti-components', 'var(--blue)', 'var(--blue-light)'],
        ['Valor repuestos', State.fmtUSD(valorRep), 'ti-currency-dollar', 'var(--blue)', 'var(--blue-light)'],
        ['Total activos taller', State.fmtUSD(valorHerr + valorRep), 'ti-building-store', 'var(--green)', 'var(--green-light)'],
      ];
    } else {
      const total = grupo.length;
      const disponibles = grupo.filter(p => (p.estadoInventario||'disponible') === 'disponible' && this.stockReal(p) > 0).length;
      const vendidos = grupo.filter(p => p.estadoInventario === 'vendido' || this.stockReal(p) === 0).length;
      const valorDisponible = grupo.filter(p => (p.estadoInventario||'disponible')!=='vendido').reduce((a,p)=>a + p.costoUSD * this.stockReal(p), 0);
      const valorVendidoPotencial = grupo.reduce((a,p)=>{
        const precioUSD = p.cotiz ? p.precioARS / p.cotiz : 0;
        return a + precioUSD * Math.max(this.stockReal(p), p.estadoInventario==='vendido'?1:0);
      }, 0);
      kpis = [
        ['Total', total, 'ti-box', 'var(--blue)', 'var(--blue-light)'],
        ['Disponibles', disponibles, 'ti-circle-check', 'var(--green)', 'var(--green-light)'],
        ['Vendidos', vendidos, 'ti-trending-up', 'var(--text)', 'var(--bg-secondary)'],
        ['Valor Disponible', State.fmtUSD(valorDisponible), 'ti-currency-dollar', 'var(--blue)', 'var(--blue-light)'],
        ['Valor de Venta', State.fmtUSD(valorVendidoPotencial), 'ti-cash', 'var(--green)', 'var(--green-light)'],
      ];
    }

    document.getElementById('stock-kpis').innerHTML = kpis.map(([label,val,icon,color,bg]) => `
      <div class="card" style="padding:12px 14px;margin-bottom:0;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;min-height:90px">
        <div style="min-width:0;flex:1"><label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">${label}</label><div style="font-size:19px;font-weight:700;color:${color};word-break:break-word">${val}</div></div>
        <div style="width:34px;height:34px;border-radius:8px;background:${bg};display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="ti ${icon}" style="color:${color};font-size:17px"></i></div>
      </div>
    `).join('');
  },

  renderView() {
    this.renderKpis();
    document.getElementById('stock-view-tabs').innerHTML = `
      <button class="btn btn-sm ${this.currentView==='productos'?'btn-primary':''}" onclick="Stock.setView('productos')"><i class="ti ti-box"></i> Productos</button>
      <button class="btn btn-sm ${this.currentView==='historial'?'btn-primary':''}" onclick="Stock.setView('historial')"><i class="ti ti-history"></i> Historial de movimientos</button>
    `;
    const host = document.getElementById('stock-view-host');
    if (this.currentView === 'productos') {
      host.innerHTML = `
        <div style="padding:10px 22px;border-bottom:1px solid var(--border);display:flex;gap:4px;flex-wrap:wrap" id="stock-grupo-tabs"></div>
        <div style="padding:10px 22px;border-bottom:1px solid var(--border);display:flex;gap:6px;flex-wrap:wrap;align-items:center" id="stock-estado-tabs"></div>
        <div style="padding:12px 22px;border-bottom:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap" id="stock-tabs-wrap">
          <div style="display:flex;gap:4px;flex-wrap:wrap" id="stock-tabs"></div>
        </div>
        <div style="padding:0 22px 12px;display:flex;gap:8px;flex-wrap:wrap">
          <input type="text" id="stock-search" placeholder="Buscar producto..." oninput="Stock.renderTable()" style="font-size:12px;padding:6px 10px;border:1px solid var(--border-strong);border-radius:8px;flex:1;min-width:160px">
          <select id="stock-filter-prov" onchange="Stock.renderTable()" style="font-size:12px;padding:6px 10px;border:1px solid var(--border-strong);border-radius:8px">
            <option value="">Todos los proveedores</option>
            <option>Gonza</option><option>Proveedor perfumería</option><option>Proveedor accesorios</option>
          </select>
        </div>
        <div class="body-pad" style="padding-top:0">
          <table class="stock-table-desktop"><thead><tr>
            <th>Producto</th><th>Color</th><th>Batería</th><th>Costo USD</th><th>Precio venta USD</th><th>Margen</th><th>Stock</th><th>IMEI</th><th>Estado</th><th></th>
          </tr></thead><tbody id="stock-tbody"></tbody></table>
          <div class="stock-cards-mobile" id="stock-cards"></div>
        </div>
      `;
      this.renderGrupoTabs();
      this.renderEstadoTabs();
      this.renderTabs();
      this.renderTable();
    } else {
      host.innerHTML = `<div class="body-pad" id="historial-general-host"></div>`;
      this.renderHistorialGeneral();
    }
  },

  setView(v) { this.currentView = v; this.renderView(); },

  renderGrupoTabs() {
    document.getElementById('stock-grupo-tabs').innerHTML = Object.entries(this.GRUPOS).map(([k,g]) => {
      const count = this.productosDelGrupo(k).length;
      const active = this.currentGroup === k;
      return `<button onclick="Stock.setGrupo('${k}')" style="display:flex;align-items:center;gap:6px;padding:8px 14px;border-radius:8px;border:1.5px solid ${active?'var(--blue)':'var(--border)'};background:${active?'var(--blue-light)':'var(--bg)'};color:${active?'var(--blue)':'var(--text-secondary)'};font-size:12.5px;font-weight:${active?'600':'400'};cursor:pointer">
        <i class="ti ${g.icon}"></i> ${g.label} <span style="background:${active?'#fff':'var(--bg-secondary)'};padding:1px 6px;border-radius:10px;font-size:10.5px">${count}</span>
      </button>`;
    }).join('');
  },
  setGrupo(g) { this.currentGroup = g; this.currentTab = 'all'; this.currentEstado = 'todos'; this.renderKpis(); this.renderGrupoTabs(); this.renderEstadoTabs(); this.renderTabs(); this.renderTable(); },

  renderEstadoTabs() {
    const grupo = this.productosDelGrupo(this.currentGroup);
    const estados = ['todos', 'disponible', 'reservado', 'en_reparacion', 'vendido'];
    document.getElementById('stock-estado-tabs').innerHTML = estados.map(e => {
      const count = e === 'todos' ? grupo.length : grupo.filter(p => (p.estadoInventario||'disponible') === e).length;
      const label = e === 'todos' ? 'Todos' : this.ESTADO_INV_LABEL[e];
      const active = this.currentEstado === e;
      return `<span onclick="Stock.setEstadoFiltro('${e}')" style="cursor:pointer;font-size:12px;padding:5px 11px;border-radius:20px;border-bottom:2px solid ${active?'var(--blue)':'transparent'};color:${active?'var(--blue)':'var(--text-secondary)'};font-weight:${active?'600':'400'};display:inline-flex;align-items:center;gap:5px">${label} <span style="background:var(--bg-secondary);padding:1px 6px;border-radius:10px;font-size:10px">${count}</span></span>`;
    }).join('');
  },
  setEstadoFiltro(e) { this.currentEstado = e; this.renderEstadoTabs(); this.renderTable(); },
  setEstadoFiltro(e) { this.currentEstado = e; this.renderEstadoTabs(); this.renderTable(); },

  renderTabs() {
    const catsDelGrupo = this.GRUPOS[this.currentGroup]?.cats || [];
    const cats = ['all', ...catsDelGrupo.filter(c => State.stock.some(s => s.cat === c))];
    document.getElementById('stock-tabs').innerHTML = cats.map(c => {
      const count = c === 'all' ? this.productosDelGrupo(this.currentGroup).length : State.stock.filter(s => s.cat === c).length;
      const label = c === 'all' ? 'Todos' : (this.CAT_LABELS[c] || c);
      return `<button class="btn btn-sm ${this.currentTab===c?'btn-primary':''}" onclick="Stock.setTab('${c}')">${label} (${count})</button>`;
    }).join('');
  },
  setTab(c) { this.currentTab = c; this.renderTabs(); this.renderTable(); },

  renderTable() {
    const q = (document.getElementById('stock-search')?.value || '').toLowerCase();
    const prov = document.getElementById('stock-filter-prov')?.value || '';
    const catsDelGrupo = this.GRUPOS[this.currentGroup]?.cats || [];
    let rows = State.stock.filter(s => {
      if (!catsDelGrupo.includes(s.cat)) return false;
      if (this.currentTab !== 'all' && s.cat !== this.currentTab) return false;
      if (this.currentEstado !== 'todos' && (s.estadoInventario||'disponible') !== this.currentEstado) return false;
      if (q && !s.nombre.toLowerCase().includes(q)) return false;
      if (prov && s.proveedor !== prov) return false;
      return true;
    });
    const tbody = document.getElementById('stock-tbody');
    const cardsHost = document.getElementById('stock-cards');
    if (!tbody) return;

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state"><i class="ti ti-box"></i>Sin productos que coincidan</div></td></tr>`;
      if (cardsHost) cardsHost.innerHTML = `<div class="empty-state"><i class="ti ti-box"></i>Sin productos que coincidan</div>`;
      return;
    }

    const filaTabla = (p) => {
      const stock = this.stockReal(p);
      const costoARS = p.costoUSD * p.cotiz;
      const margin = Math.round(((p.precioARS - costoARS) / costoARS) * 100);
      const precioUSD = p.cotiz ? (p.precioARS / p.cotiz) : 0;
      const esIMEI = this.CATS_IMEI.includes(p.cat);
      const detalleStock = esIMEI ? `${stock} <span style="font-size:9px;color:var(--text-secondary)">(${(p.imeis||[]).length} IMEI)</span>` : `${stock}`;
      const estadoInv = p.estadoInventario || 'disponible';
      const statusBadge = `<span class="badge ${this.ESTADO_INV_CLASS[estadoInv]}">${this.ESTADO_INV_LABEL[estadoInv]}</span>`;
      return { stock, margin, precioUSD, esIMEI, detalleStock, statusBadge };
    };

    tbody.innerHTML = rows.map(p => {
      const { margin, precioUSD, detalleStock, statusBadge } = filaTabla(p);
      return `<tr>
        <td>
          <b>${p.nombre.replace(/ ?${p.color||'XXXXXXX'}/,'').replace(/ ?${p.storage||'XXXXXXX'}/,'').trim()}</b>
          ${p.cat === 'repuesto' && p.modelo ? `<div style="font-size:10px;color:var(--amber)"><i class="ti ti-device-mobile" style="font-size:9px"></i> ${p.modelo}</div>` : ''}
          ${p.notas ? `<div style="font-size:10px;color:var(--text-secondary)">${p.notas}</div>` : ''}
        </td>
        <td style="font-size:11.5px">${p.color||'—'}</td>
        <td style="font-size:11.5px">${p.bateriaPct != null ? `<span style="color:${p.bateriaPct>=80?'var(--green)':p.bateriaPct>=60?'var(--amber)':'var(--red)'}">${p.bateriaPct}%</span>` : '—'}</td>
        <td>USD ${p.costoUSD}</td>
        <td>${precioUSD ? State.fmtUSD(precioUSD) + `<div style="font-size:10px;color:var(--text-secondary)">${State.fmtARS(p.precioARS)}</div>` : '<span style="color:var(--text-secondary)">—</span>'}</td>
        <td style="color:${margin>=0?'var(--green)':'var(--red)'}">${precioUSD ? (margin>=0?'+':'') + margin + '%' : '—'}</td>
        <td>${detalleStock}</td>
        <td style="font-size:10.5px;color:var(--text-secondary)">${esIMEI ? (p.imeis||[]).join('<br>') || '—' : '—'}</td>
        <td>${statusBadge}</td>
        <td><button class="btn btn-sm" onclick="Stock.openDrawer('edit','${p.id}')"><i class="ti ti-edit"></i></button></td>
      </tr>`;
    }).join('');

    if (cardsHost) {
      cardsHost.innerHTML = rows.map(p => {
        const { margin, precioUSD, detalleStock, statusBadge } = filaTabla(p);
        return `<div class="stock-card" onclick="Stock.openDrawer('edit','${p.id}')">
          <div class="stock-card-top">
            <div style="min-width:0;flex:1">
              <div class="stock-card-name">${p.nombre}</div>
              <span class="badge ${this.CAT_CLASS[p.cat]||'b-gray'}" style="margin-top:4px">${this.CAT_LABELS[p.cat]||p.cat}</span>
              ${p.cat === 'repuesto' && p.modelo ? `<div style="font-size:10.5px;color:var(--amber);margin-top:3px"><i class="ti ti-device-mobile" style="font-size:9px"></i> ${p.modelo}</div>` : ''}
            </div>
            ${statusBadge}
          </div>
          <div class="stock-card-grid">
            <div><label>Costo</label><span>USD ${p.costoUSD}</span></div>
            <div><label>Venta</label><span>${State.fmtUSD(precioUSD)}</span></div>
            <div><label>Margen</label><span style="color:${margin>=0?'var(--green)':'var(--red)'}">${margin>=0?'+':''}${margin}%</span></div>
            <div><label>Stock</label><span>${detalleStock}</span></div>
          </div>
          <div class="stock-card-bottom">
            <span><i class="ti ti-truck"></i> ${p.proveedor}</span>
            <span><i class="ti ti-user"></i> ${p.custodio||'Sin asignar'}</span>
          </div>
          ${p.notas ? `<div class="stock-card-notas">${p.notas}</div>` : ''}
        </div>`;
      }).join('');
    }
  },

  // ===== HISTORIAL =====

  async renderHistorialGeneral() {
    const host = document.getElementById('historial-general-host');
    host.innerHTML = `<div class="empty-state"><i class="ti ti-loader-2"></i>Cargando historial...</div>`;
    const movs = await DB.listarMovimientosStock(null);
    if (!movs.length) { host.innerHTML = `<div class="empty-state"><i class="ti ti-history"></i>Todavía no hay movimientos registrados</div>`; return; }
    const nombrePorId = {};
    State.stock.forEach(p => nombrePorId[p.id] = p.nombre);
    host.innerHTML = `
      <table><thead><tr><th>Fecha</th><th>Producto</th><th>Tipo</th><th>Detalle</th><th>Cantidad</th><th>Usuario</th></tr></thead>
      <tbody>
        ${movs.map(m => `<tr>
          <td style="white-space:nowrap;font-size:11.5px">${this.fmtFechaHora(m.creado_en)}</td>
          <td>${nombrePorId[m.stock_id] || '(producto eliminado)'}</td>
          <td><span class="badge ${this.TIPO_MOV_CLASS[m.tipo]||'b-gray'}">${this.TIPO_MOV_LABEL[m.tipo]||m.tipo}</span></td>
          <td style="font-size:11.5px;color:var(--text-secondary)">${m.detalle || '—'}</td>
          <td style="font-size:11.5px">${m.cantidad_antes ?? '—'} → ${m.cantidad_despues ?? '—'}</td>
          <td style="font-size:11.5px">${m.usuario_nombre || '—'}</td>
        </tr>`).join('')}
      </tbody></table>
    `;
  },

  async renderHistorialProducto(stockId) {
    const host = document.getElementById('historial-producto-host');
    if (!host) return;
    host.innerHTML = `<div class="empty-state" style="padding:20px"><i class="ti ti-loader-2"></i>Cargando...</div>`;
    const movs = await DB.listarMovimientosStock(stockId);
    if (!movs.length) { host.innerHTML = `<div class="hint" style="font-size:11.5px;color:var(--text-secondary);padding:8px 0">Sin movimientos registrados todavía para este producto.</div>`; return; }
    host.innerHTML = movs.map(m => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-size:11.5px">
        <div>
          <span class="badge ${this.TIPO_MOV_CLASS[m.tipo]||'b-gray'}">${this.TIPO_MOV_LABEL[m.tipo]||m.tipo}</span>
          <span style="color:var(--text-secondary);margin-left:6px">${m.detalle || ''}</span>
        </div>
        <div style="text-align:right;color:var(--text-secondary)">
          <div>${this.fmtFechaHora(m.creado_en)}</div>
          <div>${m.usuario_nombre || ''}</div>
        </div>
      </div>
    `).join('');
  },

  fmtFechaHora(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit' }) + ' ' + d.toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' });
  },

  CAT_ICONS: { iphone:'ti-device-mobile', android:'ti-device-mobile', mac:'ti-device-laptop', ipad:'ti-device-ipad', watch:'ti-device-watch', audio:'ti-headphones', perfumeria:'ti-droplet', accesorio:'ti-plug', repuesto:'ti-components', herramienta:'ti-tool', otro:'ti-box' },
  MODELOS_POR_CAT: {
    iphone: ['iPhone 11','iPhone 12','iPhone 12 Pro','iPhone 13','iPhone 13 Pro','iPhone 14','iPhone 14 Pro','iPhone 14 Pro Max','iPhone 15','iPhone 15 Plus','iPhone 15 Pro','iPhone 15 Pro Max','iPhone 16','iPhone 16 Pro','iPhone 16 Pro Max','iPhone 17','iPhone 17 Pro','iPhone 17 Pro Max'],
    android: ['Samsung Galaxy S23','Samsung Galaxy S24','Samsung Galaxy S24+','Samsung Galaxy S24 Ultra','Samsung Galaxy A54','Samsung Galaxy A34','Motorola G84','Motorola G54','Motorola Edge 40','Xiaomi 13'],
    mac: ['MacBook Air M1','MacBook Air M2','MacBook Air M3','MacBook Pro 14" M3','MacBook Pro 16" M3','Mac Mini M2','iMac M3'],
    ipad: ['iPad 9ª gen','iPad 10ª gen','iPad Air M2','iPad Mini 6ª gen','iPad Pro 11"','iPad Pro 13"'],
    watch: ['Apple Watch SE','Apple Watch Series 9','Apple Watch Ultra 2'],
    audio: ['AirPods 2','AirPods 3','AirPods Pro 2','AirPods Max','Beats Studio Pro'],
  },
  STORAGE_OPCIONES: ['32GB','64GB','128GB','256GB','512GB','1TB','2TB'],
  COLOR_OPCIONES: ['Negro','Blanco','Azul','Verde','Rosa','Rojo','Titanio Natural','Titanio Azul','Titanio Negro','Plata','Dorado','Gris Espacial','Otro'],
  ESTADO_OPCIONES: ['Nuevo / Sellado','Excelente','Muy bueno','Bueno','Con detalles'],
  GRADO_OPCIONES: ['Sin grado','A+','A','B','C'],
  RAM_OPCIONES: ['8GB','16GB','18GB','24GB','32GB','36GB'],

  // ===== FORMULARIO =====

  openDrawer(mode, id) {
    const existing = mode === 'edit' ? State.stock.find(x => x.id === id) : null;
    const p = existing || {
      cat: 'iphone', nombre: '', costoUSD: '', cotiz: State.refBlue, precioARS: '', proveedor: 'Gonza', custodio: '', notas: '',
      imeis: [], cantidad: 0, cantidadDeclarada: 1, precioReventa: null, precioMayorista: null, costoReparacion: 0,
      modelo: '', storage: '', color: '', bateriaPct: null, ciclosBateria: null, ram: '', estadoProducto: '', grado: 'Sin grado',
      esim: false, tieneCaja: false, numeroSerie: '', destacado: false
    };
    const host = document.getElementById('stock-drawer-host');
    const esIMEI = this.CATS_IMEI.includes(p.cat);
    const cantidadDeclarada = p.cantidadDeclarada ?? p.cantidad ?? (esIMEI ? 0 : 1);

    host.innerHTML = `
      <div class="drawer-bg" style="position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;justify-content:flex-end;z-index:100" onclick="if(event.target===this) Stock.closeDrawer()">
        <div style="width:440px;max-width:94vw;background:var(--bg);border-left:1px solid var(--border);display:flex;flex-direction:column;height:100%" onclick="event.stopPropagation()">

          <div style="padding:16px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
            <h3 style="font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px"><i class="ti ${this.CAT_ICONS[p.cat]||'ti-box'}" style="color:var(--blue)" id="drawer-icon"></i> ${mode==='new'?'Agregar producto':'Editar producto'}</h3>
            <div style="display:flex;align-items:center;gap:6px">
              <button type="button" onclick="Stock.toggleDestacado()" id="destacado-btn" title="Destacar en catálogo" style="background:none;border:none;cursor:pointer;font-size:18px;color:${p.destacado?'#854F0B':'var(--text-secondary)'}"><i class="ti ti-star${p.destacado?'-filled':''}" id="destacado-icon"></i></button>
              <button class="btn btn-sm" onclick="Stock.closeDrawer()"><i class="ti ti-x"></i></button>
            </div>
          </div>

          <div style="flex:1;overflow-y:auto;padding:16px 18px">

            <!-- SECCIÓN: IDENTIFICACIÓN DEL PRODUCTO -->
            <div style="border:1px solid var(--border);border-radius:10px;margin-bottom:12px;overflow:hidden">
              <div onclick="Stock.toggleSection('sec-id')" style="background:var(--bg-secondary);padding:10px 14px;display:flex;justify-content:space-between;align-items:center;cursor:pointer">
                <span style="font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:7px"><i class="ti ti-device-mobile"></i> Identificación del Producto</span>
                <i class="ti ti-chevron-up" id="arr-sec-id"></i>
              </div>
              <div id="sec-id" style="padding:14px">

                <div style="margin-bottom:12px"><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:6px">Categoría *</label>
                  <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px" id="cat-grid">
                    ${Object.entries(this.CAT_LABELS).map(([k,v]) => `
                      <div onclick="Stock.selectCat('${k}')" data-cat="${k}" class="cat-opt" style="border:1.5px solid ${p.cat===k?'var(--blue)':'var(--border)'};background:${p.cat===k?'var(--blue-light)':'var(--bg)'};border-radius:8px;padding:8px 4px;text-align:center;cursor:pointer">
                        <i class="ti ${this.CAT_ICONS[k]}" style="font-size:18px;color:${p.cat===k?'var(--blue)':'var(--text-secondary)'};display:block;margin-bottom:3px"></i>
                        <span style="font-size:9.5px;color:${p.cat===k?'var(--blue)':'var(--text-secondary)'};font-weight:${p.cat===k?'600':'400'}">${v}</span>
                      </div>`).join('')}
                  </div>
                </div>

                <input type="hidden" id="f-cat" value="${p.cat}">

                <div style="margin-bottom:12px;background:var(--bg-secondary);border-radius:8px;padding:12px">
                  <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Cantidad de Unidades *</label>
                  <div style="display:flex;align-items:center;gap:8px">
                    <button type="button" onclick="Stock.bumpQty(-1)" style="width:32px;height:32px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg);cursor:pointer;font-size:16px">−</button>
                    <input type="number" id="f-cantidad" value="${cantidadDeclarada}" min="0" style="width:100%;text-align:center;font-size:13px;font-weight:600;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                    <button type="button" onclick="Stock.bumpQty(1)" style="width:32px;height:32px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg);cursor:pointer;font-size:16px">+</button>
                  </div>
                  <div class="hint" style="font-size:10px;color:var(--text-secondary);margin-top:4px" id="cantidad-hint">Cantidad de unidades que tenés, sepas o no todavía los IMEIs de cada una.</div>
                </div>

                <div style="margin-bottom:12px"><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Estado de inventario</label>
                  <select id="f-estado-inventario" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                    <option value="disponible" ${(p.estadoInventario||'disponible')==='disponible'?'selected':''}>Disponible</option>
                    <option value="reservado" ${p.estadoInventario==='reservado'?'selected':''}>Reservado</option>
                    <option value="en_reparacion" ${p.estadoInventario==='en_reparacion'?'selected':''}>En reparación</option>
                    <option value="vendido" ${p.estadoInventario==='vendido'?'selected':''}>Vendido</option>
                  </select>
                  <div class="hint" style="font-size:10px;color:var(--text-secondary);margin-top:3px">Se marca "Vendido" automáticamente cuando una venta agota el stock. Podés ajustarlo manualmente si lo necesitás (ej: marcar como Reservado).</div>
                </div>

                <div id="f-imei-wrap" style="margin-bottom:12px;display:${esIMEI?'block':'none'}">
                  <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">IMEI <span style="font-weight:400">(opcional)</span> <span style="font-weight:400" id="imei-count">(${(p.imeis||[]).length} cargados)</span></label>
                  <div id="imei-chips-wrap" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px"></div>
                  <div style="display:flex;gap:6px">
                    <input type="text" id="f-imei-input" placeholder="123456789012345" style="flex:1;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;font-family:monospace" onkeydown="if(event.key==='Enter'){event.preventDefault();Stock.addImei();}">
                    <button type="button" class="btn btn-sm" onclick="Stock.addImei()"><i class="ti ti-plus"></i> Agregar</button>
                  </div>
                  <div class="hint" style="font-size:10px;color:var(--text-secondary);margin-top:4px">Podés dejarlo vacío. Es independiente de la cantidad — vas completando IMEIs a medida que los identificás.</div>
                </div>

                <div id="f-serie-wrap" style="margin-bottom:12px;display:${p.cat==='mac'?'block':'none'}">
                  <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Número de Serie *</label>
                  <input type="text" id="f-numero-serie" value="${p.numeroSerie||''}" placeholder="C02ABC123XYZ" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;font-family:monospace">
                </div>

                <div id="f-modelo-wrap" style="display:${['iphone','android','mac','ipad','watch','audio'].includes(p.cat)?'block':'none'};margin-bottom:12px">
                  <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Modelo *</label>
                  <select id="f-modelo" onchange="Stock.toggleModeloOtro()" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                    <option value="">Seleccionar modelo</option>
                    ${(this.MODELOS_POR_CAT[p.cat]||[]).map(m => `<option ${p.modelo===m?'selected':''}>${m}</option>`).join('')}
                    <option value="__otro__" ${p.modelo && !(this.MODELOS_POR_CAT[p.cat]||[]).includes(p.modelo) ? 'selected':''}>Otro (escribir)</option>
                  </select>
                  <input type="text" id="f-modelo-otro" value="${p.modelo && !(this.MODELOS_POR_CAT[p.cat]||[]).includes(p.modelo) ? p.modelo : ''}" placeholder="Escribí el modelo" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;margin-top:6px;display:${p.modelo && !(this.MODELOS_POR_CAT[p.cat]||[]).includes(p.modelo) ? 'block':'none'}">
                </div>

                <div id="f-nombre-libre-wrap" style="display:${['perfumeria','accesorio','repuesto','herramienta','otro'].includes(p.cat)?'block':'none'};margin-bottom:12px">
                  <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Nombre ${p.cat==='herramienta'?'de la herramienta':p.cat==='repuesto'?'del repuesto':'del producto'} *</label>
                  <input type="text" id="f-nombre-libre" value="${['perfumeria','accesorio','repuesto','herramienta','otro'].includes(p.cat) ? (p.nombre||'') : ''}" placeholder="${p.cat==='herramienta'?'ej: Pistola de calor, iSclack, destornillador pentalobe…':p.cat==='repuesto'?'ej: Batería, Pantalla, Flex de carga…':'ej: Dior Sauvage 100ml'}" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                </div>

                <div id="f-modelo-repuesto-wrap" style="display:${p.cat==='repuesto'?'block':'none'};margin-bottom:12px">
                  <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Modelo compatible <span style="font-weight:400;color:var(--text-secondary)">(opcional)</span></label>
                  <select id="f-modelo-repuesto" onchange="Stock.toggleModeloRepuestoOtro()" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                    <option value="">— Universal / sin modelo específico —</option>
                    <optgroup label="iPhone">
                      ${this.MODELOS_POR_CAT.iphone.map(m => `<option value="${m}" ${p.modelo===m?'selected':''}>${m}</option>`).join('')}
                    </optgroup>
                    <optgroup label="Android / Otra marca">
                      ${this.MODELOS_POR_CAT.android.map(m => `<option value="${m}" ${p.modelo===m?'selected':''}>${m}</option>`).join('')}
                    </optgroup>
                    <optgroup label="iPad / Mac">
                      ${[...this.MODELOS_POR_CAT.ipad, ...this.MODELOS_POR_CAT.mac].map(m => `<option value="${m}" ${p.modelo===m?'selected':''}>${m}</option>`).join('')}
                    </optgroup>
                    <option value="__otro__" ${p.modelo && !Object.values(this.MODELOS_POR_CAT).flat().includes(p.modelo) && p.modelo !== '' ? 'selected' : ''}>Otra marca / modelo (escribir)</option>
                  </select>
                  <input type="text" id="f-modelo-repuesto-otro" placeholder="ej: Samsung Galaxy A54, Motorola G84…" value="${p.modelo && !Object.values(this.MODELOS_POR_CAT).flat().includes(p.modelo) && p.modelo !== '' ? p.modelo : ''}" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;margin-top:6px;display:${p.modelo && !Object.values(this.MODELOS_POR_CAT).flat().includes(p.modelo) && p.modelo !== '' ? 'block' : 'none'}">
                </div>

                <div id="f-specs-grid" style="display:${['iphone','android','mac','ipad'].includes(p.cat)?'grid':'none'};grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
                  <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Storage</label>
                    <select id="f-storage" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                      <option value="">Seleccionar</option>
                      ${this.STORAGE_OPCIONES.map(s=>`<option ${p.storage===s?'selected':''}>${s}</option>`).join('')}
                    </select>
                  </div>
                  <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Color</label>
                    <select id="f-color" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                      <option value="">Seleccionar</option>
                      ${this.COLOR_OPCIONES.map(c=>`<option ${p.color===c?'selected':''}>${c}</option>`).join('')}
                    </select>
                  </div>
                </div>

                <div id="f-bateria-wrap" style="display:${['iphone','android','ipad'].includes(p.cat)?'grid':'none'};grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
                  <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Batería %</label>
                    <input type="number" id="f-bateria" value="${p.bateriaPct??''}" placeholder="85" min="0" max="100" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                  </div>
                  <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Estado del Producto</label>
                    <select id="f-estado" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                      <option value="">Seleccionar</option>
                      ${this.ESTADO_OPCIONES.map(e=>`<option ${p.estadoProducto===e?'selected':''}>${e}</option>`).join('')}
                    </select>
                  </div>
                </div>

                <div id="f-mac-extra-wrap" style="display:${p.cat==='mac'?'block':'none'};margin-bottom:12px">
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                    <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Ciclos de Batería</label>
                      <input type="number" id="f-ciclos" value="${p.ciclosBateria??''}" placeholder="250" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                    </div>
                    <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">RAM</label>
                      <select id="f-ram" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                        <option value="">Seleccionar</option>
                        ${this.RAM_OPCIONES.map(r=>`<option ${p.ram===r?'selected':''}>${r}</option>`).join('')}
                      </select>
                    </div>
                  </div>
                  <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin:10px 0 4px">Estado del Producto</label>
                  <select id="f-estado-mac" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                    <option value="">Seleccionar</option>
                    ${this.ESTADO_OPCIONES.map(e=>`<option ${p.estadoProducto===e?'selected':''}>${e}</option>`).join('')}
                  </select>
                </div>

                <div id="f-caracteristicas-wrap" style="display:${esIMEI?'block':'none'};background:var(--bg-secondary);border-radius:8px;padding:12px">
                  <div style="font-size:10px;color:var(--text-secondary);font-weight:600;text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px">Características</div>
                  <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
                    <div style="display:flex;align-items:center;gap:6px">
                      <label style="font-size:11px;color:var(--text-secondary);font-weight:600">Grado</label>
                      <select id="f-grado" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:8px">
                        ${this.GRADO_OPCIONES.map(g=>`<option ${p.grado===g?'selected':''}>${g}</option>`).join('')}
                      </select>
                    </div>
                    <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer"><input type="checkbox" id="f-esim" ${p.esim?'checked':''} style="width:14px;height:14px"> eSIM</label>
                    <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer"><input type="checkbox" id="f-caja" ${p.tieneCaja?'checked':''} style="width:14px;height:14px"> Tiene Caja</label>
                  </div>
                </div>

              </div>
            </div>

            <!-- SECCIÓN: PRECIOS -->
            <div style="border:1px solid var(--border);border-radius:10px;margin-bottom:12px;overflow:hidden">
              <div onclick="Stock.toggleSection('sec-precios')" style="background:var(--bg-secondary);padding:10px 14px;display:flex;justify-content:space-between;align-items:center;cursor:pointer">
                <span style="font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:7px"><i class="ti ti-currency-dollar"></i> Precios</span>
                <i class="ti ti-chevron-up" id="arr-sec-precios"></i>
              </div>
              <div id="sec-precios" style="padding:14px">

                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
                  <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Precio de Compra (USD) *</label>
                    <input type="number" id="f-costo" value="${p.costoUSD||''}" placeholder="800" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                  </div>
                  <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Cotización usada</label>
                    <input type="number" id="f-cotiz" value="${p.cotiz||State.refBlue}" oninput="Stock.updatePricePreview()" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                  </div>
                </div>

                <div style="margin-bottom:12px"><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Precio de Venta Sugerido (USD) *</label>
                  <input type="number" id="f-precio-usd" value="${p.precioARS && p.cotiz ? (p.precioARS / p.cotiz).toFixed(2) : ''}" placeholder="1000" oninput="Stock.updatePricePreview()" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                  <div class="hint" style="font-size:10px;color:var(--text-secondary);margin-top:3px" id="precio-ars-preview">${p.precioARS ? '≈ ' + State.fmtARS(p.precioARS) + ' a la cotización indicada — se precarga al crear una venta' : 'Se precargará al crear una venta'}</div>
                </div>

                <button type="button" onclick="Stock.toggleAdvancedPrices()" style="background:none;border:none;color:var(--blue);font-size:11.5px;cursor:pointer;display:flex;align-items:center;gap:4px;padding:0;margin-bottom:10px"><i class="ti ti-chevron-down" id="adv-prices-arrow"></i> Mostrar precios avanzados</button>
                <div id="adv-prices-wrap" style="display:none">
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
                    <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Precio Reventa (USD)</label><input type="number" id="f-precio-reventa" value="${p.precioReventa||''}" placeholder="opcional" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px"><div class="hint" style="font-size:10px;color:var(--text-secondary);margin-top:3px">Catálogo de revendedores</div></div>
                    <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Precio Mayorista (USD)</label><input type="number" id="f-precio-mayorista" value="${p.precioMayorista||''}" placeholder="opcional" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px"><div class="hint" style="font-size:10px;color:var(--text-secondary);margin-top:3px">Venta por volumen</div></div>
                  </div>
                  <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Costo de Reparación previa (USD)</label><input type="number" id="f-costo-reparacion" value="${p.costoReparacion||0}" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px"><div class="hint" style="font-size:10px;color:var(--text-secondary);margin-top:3px">Si el equipo se reparó antes de ponerlo a la venta</div></div>
                </div>

              </div>
            </div>

            <!-- LOGÍSTICA Y NOTAS -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
              <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Proveedor</label>
                <select id="f-prov" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                  ${['Gonza','Proveedor perfumería','Proveedor accesorios','Otro'].map(x=>`<option ${p.proveedor===x?'selected':''}>${x}</option>`).join('')}
                </select>
              </div>
              <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Custodio</label>
                <select id="f-custodio" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                  <option value="">Sin asignar</option>
                  ${State.personas.map(x=>`<option ${p.custodio===x?'selected':''}>${x}</option>`).join('')}
                </select>
              </div>
            </div>

            <div style="margin-bottom:12px"><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Notas</label>
              <textarea id="f-notas" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;height:50px;resize:none">${p.notas||''}</textarea>
            </div>

            ${mode === 'edit' ? `
              <div style="margin-top:6px">
                <div class="card-title" style="margin-bottom:8px"><i class="ti ti-history"></i> Historial de este producto</div>
                <div id="historial-producto-host" style="max-height:180px;overflow-y:auto"></div>
              </div>
            ` : ''}

          </div>
          <div style="padding:13px 18px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">
            ${mode === 'edit' ? `<button class="btn" style="color:var(--red);margin-right:auto" onclick="Stock.deleteProduct('${id}')"><i class="ti ti-trash"></i> Eliminar</button>` : ''}
            <button class="btn" onclick="Stock.closeDrawer()">Cancelar</button>
            <button class="btn btn-primary" onclick="Stock.save(${mode==='edit'?`'${id}'`:'null'})"><i class="ti ti-check"></i> Guardar</button>
          </div>
        </div>
      </div>
    `;
    this.pendingImeis = [...(p.imeis || [])];
    this._destacado = !!p.destacado;
    this.renderImeiChips();
    setTimeout(() => this.updatePricePreview(), 0);
    if (mode === 'edit') this.renderHistorialProducto(id);
  },

  toggleModeloOtro() {
    const sel = document.getElementById('f-modelo');
    const otroInput = document.getElementById('f-modelo-otro');
    if (!sel || !otroInput) return;
    otroInput.style.display = sel.value === '__otro__' ? 'block' : 'none';
  },

  toggleModeloRepuestoOtro() {
    const sel = document.getElementById('f-modelo-repuesto');
    const input = document.getElementById('f-modelo-repuesto-otro');
    if (!sel || !input) return;
    input.style.display = sel.value === '__otro__' ? 'block' : 'none';
    if (sel.value !== '__otro__') input.value = '';
  },

  selectCat(cat) {
    document.getElementById('f-cat').value = cat;
    document.querySelectorAll('.cat-opt').forEach(el => {
      const isSel = el.dataset.cat === cat;
      el.style.border = `1.5px solid ${isSel ? 'var(--blue)' : 'var(--border)'}`;
      el.style.background = isSel ? 'var(--blue-light)' : 'var(--bg)';
      const icon = el.querySelector('i'), label = el.querySelector('span');
      icon.style.color = isSel ? 'var(--blue)' : 'var(--text-secondary)';
      label.style.color = isSel ? 'var(--blue)' : 'var(--text-secondary)';
      label.style.fontWeight = isSel ? '600' : '400';
    });
    document.getElementById('drawer-icon').className = `ti ${this.CAT_ICONS[cat]||'ti-box'}`;
    this.toggleFields();
  },

  toggleSection(id) {
    const body = document.getElementById(id);
    const arrow = document.getElementById('arr-' + id);
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    arrow.className = open ? 'ti ti-chevron-down' : 'ti ti-chevron-up';
  },

  toggleDestacado() {
    this._destacado = !this._destacado;
    const icon = document.getElementById('destacado-icon');
    const btn = document.getElementById('destacado-btn');
    icon.className = `ti ti-star${this._destacado ? '-filled' : ''}`;
    btn.style.color = this._destacado ? '#854F0B' : 'var(--text-secondary)';
  },

  toggleAdvancedPrices() {
    const wrap = document.getElementById('adv-prices-wrap');
    const arrow = document.getElementById('adv-prices-arrow');
    const open = wrap.style.display === 'none';
    wrap.style.display = open ? 'block' : 'none';
    arrow.className = open ? 'ti ti-chevron-up' : 'ti ti-chevron-down';
  },

  renderImeiChips() {
    const host = document.getElementById('imei-chips-wrap');
    const countEl = document.getElementById('imei-count');
    if (!host) return;
    host.innerHTML = this.pendingImeis.map((imei, i) => `
      <span style="display:inline-flex;align-items:center;gap:5px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:11px;font-family:monospace">
        ${imei}
        <button type="button" onclick="Stock.removeImei(${i})" style="background:none;border:none;cursor:pointer;color:var(--red);font-size:13px;line-height:1;padding:0">×</button>
      </span>
    `).join('') || `<span style="font-size:11px;color:var(--text-secondary)">Sin IMEIs cargados todavía</span>`;
    if (countEl) countEl.textContent = `(${this.pendingImeis.length} cargados)`;
  },

  addImei() {
    const input = document.getElementById('f-imei-input');
    if (!input) return;
    const valor = input.value.trim();
    if (!valor) return;
    if (this.pendingImeis.includes(valor)) { toast('Ese IMEI ya está cargado en este producto.'); return; }
    this.pendingImeis.push(valor);
    input.value = '';
    this.renderImeiChips();
  },

  removeImei(index) {
    this.pendingImeis.splice(index, 1);
    this.renderImeiChips();
  },

  bumpQty(delta) {
    const inp = document.getElementById('f-cantidad');
    if (!inp) return;
    const current = parseInt(inp.value, 10) || 0;
    inp.value = Math.max(0, current + delta);
  },

  updatePricePreview() {
    const cotiz = parseFloat(document.getElementById('f-cotiz')?.value) || 0;
    const precioUSD = parseFloat(document.getElementById('f-precio-usd')?.value) || 0;
    const el = document.getElementById('precio-ars-preview');
    if (!el) return;
    el.textContent = (cotiz && precioUSD) ? `≈ ${State.fmtARS(precioUSD * cotiz)} a la cotización indicada — se precarga al crear una venta` : 'Se precargará al crear una venta';
  },

  toggleFields() {
    const cat = document.getElementById('f-cat')?.value;
    if (!cat) return;
    const esIMEI = this.CATS_IMEI.includes(cat);
    const tieneModeloFijo = ['iphone','android','mac','ipad','watch','audio'].includes(cat);
    const esLibre = ['perfumeria','accesorio','repuesto','herramienta','otro'].includes(cat);
    const tieneStorageColor = ['iphone','android','mac','ipad'].includes(cat);
    const tieneBateria = ['iphone','android','ipad'].includes(cat);
    const esMac = cat === 'mac';

    const set = (id, display) => { const el = document.getElementById(id); if (el) el.style.display = display; };
    set('f-imei-wrap', esIMEI ? 'block' : 'none');
    set('f-serie-wrap', esMac ? 'block' : 'none');
    set('f-modelo-wrap', tieneModeloFijo ? 'block' : 'none');
    set('f-nombre-libre-wrap', esLibre ? 'block' : 'none');
    set('f-modelo-repuesto-wrap', cat === 'repuesto' ? 'block' : 'none');
    set('f-specs-grid', tieneStorageColor ? 'grid' : 'none');
    set('f-bateria-wrap', tieneBateria ? 'grid' : 'none');
    set('f-mac-extra-wrap', esMac ? 'block' : 'none');
    set('f-caracteristicas-wrap', esIMEI ? 'block' : 'none');

    // Refrescar lista de modelos si cambió la categoría
    const modeloSelect = document.getElementById('f-modelo');
    if (modeloSelect && tieneModeloFijo) {
      const actual = modeloSelect.value;
      modeloSelect.innerHTML = `<option value="">Seleccionar modelo</option>` +
        (this.MODELOS_POR_CAT[cat]||[]).map(m=>`<option ${actual===m?'selected':''}>${m}</option>`).join('') +
        `<option value="__otro__">Otro (escribir)</option>`;
    }

    const cantidadHint = document.getElementById('cantidad-hint');
    if (cantidadHint) cantidadHint.textContent = esIMEI
      ? 'Cantidad de unidades que tenés, sepas o no todavía los IMEIs de cada una.'
      : 'Cantidad de unidades en stock.';
  },

  async save(id) {
    const cat = document.getElementById('f-cat').value;
    const esIMEI = this.CATS_IMEI.includes(cat);
    const tieneModeloFijo = ['iphone','android','mac','ipad','watch','audio'].includes(cat);
    const esLibre = ['perfumeria','accesorio','repuesto','herramienta','otro'].includes(cat);

    // Resolver el modelo (de la lista o "otro" escrito a mano)
    let modelo = '';
    if (tieneModeloFijo) {
      const modeloSel = document.getElementById('f-modelo')?.value || '';
      modelo = modeloSel === '__otro__' ? (document.getElementById('f-modelo-otro')?.value.trim() || '') : modeloSel;
    } else if (cat === 'repuesto') {
      const modeloSel = document.getElementById('f-modelo-repuesto')?.value || '';
      modelo = modeloSel === '__otro__' ? (document.getElementById('f-modelo-repuesto-otro')?.value.trim() || '') : modeloSel;
    }
    const nombreLibre = esLibre ? (document.getElementById('f-nombre-libre')?.value.trim() || '') : '';
    const storage = document.getElementById('f-storage')?.value || '';
    const color = document.getElementById('f-color')?.value || '';

    if (tieneModeloFijo && !modelo) { toast('Seleccioná o escribí el modelo del producto.'); return; }
    if (esLibre && !nombreLibre) { toast('Completá el nombre del producto.'); return; }
    if (cat === 'mac' && !document.getElementById('f-numero-serie')?.value.trim()) { toast('Completá el número de serie.'); return; }

    // Armamos el nombre final que se muestra en toda la app
    const nombre = esLibre ? nombreLibre : [modelo, storage, color].filter(Boolean).join(' ');

    const costoUSD = parseFloat(document.getElementById('f-costo').value) || 0;
    const cotiz = parseFloat(document.getElementById('f-cotiz').value) || State.refBlue;
    const precioUSD = parseFloat(document.getElementById('f-precio-usd').value) || 0;
    if (!nombre || !costoUSD) { toast('Completá los campos obligatorios: producto y costo.'); return; }

    const cantidadNueva = parseInt(document.getElementById('f-cantidad').value, 10) || 0;
    const precioReventa = parseFloat(document.getElementById('f-precio-reventa')?.value) || null;
    const precioMayorista = parseFloat(document.getElementById('f-precio-mayorista')?.value) || null;
    const costoReparacion = parseFloat(document.getElementById('f-costo-reparacion')?.value) || 0;
    const bateriaPct = document.getElementById('f-bateria')?.value ? parseInt(document.getElementById('f-bateria').value, 10) : null;
    const ciclosBateria = document.getElementById('f-ciclos')?.value ? parseInt(document.getElementById('f-ciclos').value, 10) : null;
    const ram = document.getElementById('f-ram')?.value || '';
    const estadoProducto = document.getElementById('f-estado')?.value || document.getElementById('f-estado-mac')?.value || '';
    const grado = document.getElementById('f-grado')?.value || 'Sin grado';
    const estadoInventario = document.getElementById('f-estado-inventario')?.value || 'disponible';
    const esim = document.getElementById('f-esim')?.checked || false;
    const tieneCaja = document.getElementById('f-caja')?.checked || false;
    const numeroSerie = document.getElementById('f-numero-serie')?.value.trim() || '';

    const existing = id ? State.stock.find(x => x.id === id) : null;
    const cantidadAntes = existing ? this.stockReal(existing) : 0;

    const obj = {
      cat, nombre, costoUSD, cotiz,
      precioARS: Math.round(precioUSD * cotiz),
      proveedor: document.getElementById('f-prov').value,
      custodio: document.getElementById('f-custodio').value,
      notas: document.getElementById('f-notas').value,
      precioReventa, precioMayorista, costoReparacion,
      cantidad: cantidadNueva, cantidadDeclarada: cantidadNueva,
      modelo, storage, color, bateriaPct, ciclosBateria, ram, estadoProducto, grado,
      esim, tieneCaja, numeroSerie, destacado: !!this._destacado, estadoInventario
    };
    if (esIMEI) {
      obj.imeis = [...this.pendingImeis];
    }

    toast('Guardando producto...');
    const { id: newId, error } = await DB.guardarProductoStock(obj, id);
    if (error) { toast('Hubo un problema guardando el producto.'); console.error(error); return; }

    const finalId = id || newId;
    const cantidadDespues = this.stockReal(obj);

    if (id) {
      const idx = State.stock.findIndex(x => x.id === id);
      State.stock[idx] = { ...State.stock[idx], ...obj };
      await DB.registrarMovimientoStock(finalId, 'edicion', `Producto editado: ${nombre}`, cantidadAntes, cantidadDespues);
      toast('Producto actualizado.');
    } else {
      obj.id = newId;
      State.stock.push(obj);
      await DB.registrarMovimientoStock(finalId, 'alta', `Producto agregado: ${nombre}`, 0, cantidadDespues);
      toast('Producto agregado al stock.');
    }
    Sheets.stock(obj);
    this.closeDrawer();
    this.renderView();
  },

  async deleteProduct(id) {
    const p = State.stock.find(x => x.id === id);
    if (!p) return;
    if (!confirm(`¿Eliminar "${p.nombre}" del stock? Esta acción no se puede deshacer.`)) return;
    await DB.eliminarProductoStock(id);
    State.stock = State.stock.filter(x => x.id !== id);
    this.closeDrawer();
    this.renderView();
    toast('Producto eliminado del stock.');
  },

  closeDrawer() { document.getElementById('stock-drawer-host').innerHTML = ''; },

  exportarExcel() {
    if (typeof XLSX === 'undefined') { toast('No se pudo cargar el módulo de exportación. Revisá tu conexión a internet.'); return; }

    const filas = State.stock.map(p => {
      const stock = this.stockReal(p);
      const costoARS = p.costoUSD * p.cotiz;
      const margin = costoARS ? Math.round(((p.precioARS - costoARS) / costoARS) * 100) : 0;
      const precioUSD = p.cotiz ? +(p.precioARS / p.cotiz).toFixed(2) : 0;
      return {
        'Producto': p.nombre,
        'Rubro': this.CAT_LABELS[p.cat] || p.cat,
        'Modelo': p.modelo || '',
        'Storage': p.storage || '',
        'Color': p.color || '',
        'IMEIs': p.imeis ? p.imeis.join(', ') : '',
        'Cantidad': stock,
        'Estado inventario': this.ESTADO_INV_LABEL[p.estadoInventario || 'disponible'],
        'Costo USD': p.costoUSD,
        'Cotización': p.cotiz,
        'Precio venta USD': precioUSD,
        'Precio venta ARS': p.precioARS,
        'Precio reventa USD': p.precioReventa || '',
        'Precio mayorista USD': p.precioMayorista || '',
        'Margen %': margin,
        'Proveedor': p.proveedor || '',
        'Custodio': p.custodio || '',
        'Notas': p.notas || ''
      };
    });

    const ws = XLSX.utils.json_to_sheet(filas);
    ws['!cols'] = [
      { wch: 32 }, { wch: 12 }, { wch: 18 }, { wch: 10 }, { wch: 14 }, { wch: 40 },
      { wch: 10 }, { wch: 16 }, { wch: 11 }, { wch: 11 }, { wch: 14 }, { wch: 14 },
      { wch: 14 }, { wch: 16 }, { wch: 10 }, { wch: 18 }, { wch: 14 }, { wch: 30 }
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Inventario');

    const fecha = new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `iPhoneMood-Inventario-${fecha}.xlsx`);
    toast('Inventario exportado a Excel.');
  }
};


window.Stock = Stock;
