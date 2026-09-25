const Stock = {
  currentTab: 'all',
  currentView: 'productos', // 'productos' | 'historial'
  currentGroup: 'dispositivos', // 'dispositivos' | 'accesorios' | 'perfumeria'
  currentEstado: 'todos', // 'todos' | 'disponible' | 'vendido' | 'reservado' | 'en_reparacion'
  currentCondicion: 'todos', // 'todos' | 'nuevo' | 'usado'
  CAT_LABELS: { iphone:'iPhone', android:'Android', mac:'Mac', ipad:'iPad', watch:'Watch', audio:'Audio', gaming:'Gaming', perfumeria:'Perfumería', decant:'Decant', combo:'Combo', accesorio:'Accesorio', repuesto:'Repuesto', herramienta:'Herramienta', otro:'Otro' },
  CAT_CLASS: { iphone:'b-blue', android:'b-teal', mac:'b-blue', ipad:'b-blue', watch:'b-blue', audio:'b-purple', gaming:'b-purple', perfumeria:'b-green', decant:'b-teal', combo:'b-green', accesorio:'b-purple', repuesto:'b-amber', herramienta:'b-amber', otro:'b-gray' },
  CATS_IMEI: ['iphone','android','mac','ipad'],
  // Rubros donde el producto se identifica por su NOMBRE y no por un modelo de
  // catálogo. En ellos, modelo/color/storage guardan otra cosa (en perfumería,
  // marca/categoría/concentración; en repuestos, el modelo compatible).
  //
  // Esta es la lista CANÓNICA: `Proveedores.CATS_NOMBRE_LIBRE` la lee de acá.
  // La landing tiene la suya (`CATS_IDENT_NOMBRE` en precios.html) porque es una
  // página suelta que no importa módulos: si se agrega un rubro acá, hay que
  // sumarlo allá también o vuelve a fusionar productos distintos en una tarjeta.
  CATS_NOMBRE_LIBRE: ['perfumeria','decant','combo','accesorio','repuesto','herramienta','gaming','otro'],
  // `combo` queda AFUERA a propósito: esta lista activa los campos de marca /
  // categoría olfativa / concentración, y un combo es un paquete de varios
  // productos distintos — esos tres campos no le aplican. Solo necesita
  // nombre libre y precio, que es lo que da `CATS_NOMBRE_LIBRE`.
  CATS_PERFUME: ['perfumeria','decant'],
  // Rubros cuyo precio se carga y se publica EN PESOS, no en dólares. Mismo
  // nombre que `RUBROS_EN_PESOS` en precios.js a propósito: la landing muestra
  // `precio_ars` tal cual para estos, así que multiplicarlo por el blue del día
  // hacía que los perfumes se encarecieran solos cuando se movía el dólar.
  RUBROS_EN_PESOS: ['perfumeria','decant','combo'],
  esPrecioEnPesos(cat) { return this.RUBROS_EN_PESOS.includes(cat); },

  // Acepta "85800", "85.800", "$ 85.800" y "85.800,50".
  parseARS(v) {
    let t = String(v ?? '').replace(/[^\d.,-]/g, '').trim();
    if (!t) return 0;
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    else if (/\.\d{3}(\D|$)/.test(t)) t = t.replace(/\./g, '');
    const n = parseFloat(t);
    return isFinite(n) && n > 0 ? n : 0;
  },
  esNombreLibre(cat) { return this.CATS_NOMBRE_LIBRE.includes(cat); },
  esPerfume(cat) { return this.CATS_PERFUME.includes(cat); },
  // Agrupación de rubros para las pestañas grandes del panel
  GRUPOS: {
    dispositivos: { label: 'Dispositivos', icon: 'ti-device-mobile', cats: ['iphone','android','mac','ipad','watch','audio'] },
    accesorios: { label: 'Accesorios', icon: 'ti-plug', cats: ['accesorio'] },
    perfumeria: { label: 'Perfumería', icon: 'ti-droplet', cats: ['perfumeria', 'decant', 'combo'] },
    gaming: { label: 'Gaming', icon: 'ti-device-gamepad-2', cats: ['gaming'] },
    taller: { label: 'Taller', icon: 'ti-tool', cats: ['herramienta','repuesto'] },
  },
  // 'eliminado' lo escribe ventas.js (línea ~2685) cuando se anula una venta
  // con trade-in: el equipo que había entrado en canje se da de baja. Faltaba
  // acá, así que la columna Estado mostraba literalmente "undefined".
  ESTADO_INV_LABEL: { disponible:'Disponible', vendido:'Vendido', reservado:'Reservado', en_reparacion:'En reparación', eliminado:'Dado de baja' },
  ESTADO_INV_CLASS: { disponible:'b-green', vendido:'b-gray', reservado:'b-amber', en_reparacion:'b-purple', eliminado:'b-red' },
  TIPO_MOV_LABEL: { alta:'Alta', baja:'Eliminado', baja_venta:'Baja por venta', ajuste_cantidad:'Ajuste de cantidad', imei_agregado:'IMEI agregado', imei_quitado:'IMEI quitado', edicion:'Edición', precio:'Cambio de precio', trade_in:'Trade-In Recibido' },
  TIPO_MOV_CLASS: { alta:'b-green', baja:'b-red', baja_venta:'b-red', ajuste_cantidad:'b-amber', imei_agregado:'b-blue', imei_quitado:'b-gray', edicion:'b-purple', precio:'b-amber', trade_in:'b-green' },
  pendingImeis: [],

  // El stock real de un producto se calcula en State.getStock (compartido con
  // Ventas, Dashboard y Reparaciones, para que todos los módulos coincidan).
  stockReal(p) { return State.getStock(p); },

  // ── Catálogo dinámico ────────────────────────────────────────────
  // Las listas fijas (MODELOS_POR_CAT, SPECS_POR_MODELO) son el punto de partida,
  // pero lo que realmente hay en el stock manda: si entra por Proveedores un
  // iPhone 17 Lavanda 256GB, o cualquier modelo/color que no estaba en la lista,
  // aparece solo en los filtros y en los desplegables del formulario.

  // Valores distintos que existen hoy en el stock para un campo.
  _valoresEnStock(campo, filtro = () => true) {
    return [...new Set(
      State.stock.filter(filtro).map(p => String(p[campo] || '').trim()).filter(Boolean)
    )];
  },

  // Modelos de una categoría: los del catálogo fijo (en su orden) + los que
  // aparezcan en el stock real y no estuvieran en la lista.
  modelosParaCat(cat) {
    const fijos = this.MODELOS_POR_CAT[cat] || [];
    const extras = this._valoresEnStock('modelo', p => p.cat === cat)
      .filter(m => !fijos.some(f => f.toLowerCase() === m.toLowerCase()))
      .sort((a, b) => a.localeCompare(b, 'es'));
    return [...fijos, ...extras];
  },

  // Lo mismo para todas las categorías de un grupo, agrupado por categoría.
  modelosPorCatDelGrupo(grupo) {
    const cats = this.GRUPOS[grupo]?.cats || [];
    const out = {};
    cats.forEach(c => { const m = this.modelosParaCat(c); if (m.length) out[c] = m; });
    return out;
  },

  // ── ORDEN DE LA TABLA ────────────────────────────────────────────
  // El stock venía en el orden que lo devuelve la base, o sea mezclado: tres
  // iPhone 16 Pro Max, un 14, un 16, un 14 Pro Max… Se ordena solo, sin que el
  // usuario tenga que elegir nada: primero por rubro (en el orden en que están
  // las solapas), después por modelo del más nuevo al más viejo, y dentro del
  // mismo modelo por capacidad y color.

  // Posición del rubro dentro del grupo, para que iPhone vaya antes que iPad.
  _rankCat(cat) {
    const cats = this.GRUPOS[this.currentGroup]?.cats || [];
    const i = cats.indexOf(cat);
    return i >= 0 ? i : cats.length;
  },

  // Posición del modelo. MODELOS_POR_CAT está del más viejo al más nuevo, así
  // que se invierte: el iPhone 17 Pro Max primero y el 11 último. Un modelo que
  // no esté en el catálogo va al final del rubro, no mezclado en el medio.
  _rankModelo(p) {
    const lista = this.MODELOS_POR_CAT[p.cat] || [];
    if (!lista.length) return 0;
    const i = lista.findIndex(m => m.toLowerCase() === String(p.modelo || '').toLowerCase());
    return i >= 0 ? (lista.length - 1 - i) : lista.length;
  },

  // "128GB" → 128, "1TB" → 1024. Para ordenar capacidades de menor a mayor.
  _rankStorage(storage) {
    const m = String(storage || '').match(/(\d+(?:[.,]\d+)?)\s*(GB|TB)/i);
    if (!m) return 0;
    const n = parseFloat(m[1].replace(',', '.'));
    return m[2].toUpperCase() === 'TB' ? n * 1024 : n;
  },

  ordenarProductos(rows) {
    const txt = (a, b) => String(a || '').localeCompare(String(b || ''), 'es', { numeric: true });
    return [...rows].sort((a, b) => {
      const porCat = this._rankCat(a.cat) - this._rankCat(b.cat);
      if (porCat) return porCat;

      // En perfumería, accesorios y demás no hay catálogo de modelos: ahí lo
      // que agrupa es la marca (y el nombre, que es la identidad del producto).
      if (this.esNombreLibre(a.cat)) {
        return txt(a.modelo, b.modelo) || txt(a.nombre, b.nombre);
      }

      const porModelo = this._rankModelo(a) - this._rankModelo(b);
      if (porModelo) return porModelo;
      const porStorage = this._rankStorage(a.storage) - this._rankStorage(b.storage);
      if (porStorage) return porStorage;
      return txt(a.color, b.color) || txt(a.nombre, b.nombre);
    });
  },

  // ¿De este producto HAY? Cuenta lo disponible, reservado y en reparación con
  // unidades; no lo vendido ni lo que quedó en cero.
  hayUnidades(p) {
    return (p.estadoInventario || 'disponible') !== 'vendido' && this.stockReal(p) > 0;
  },

  // Modelos para el DESPLEGABLE DE FILTRO: solo los que hoy tenés en stock.
  // Ojo, no confundir con modelosParaCat(), que sí trae el catálogo completo
  // porque es la lista para CARGAR un producto nuevo. Filtrar por un modelo que
  // no tenés no sirve para nada: el filtro mostraba las 57 opciones del catálogo
  // aunque tuvieras 6 modelos.
  modelosConStockPorCatDelGrupo(grupo) {
    const cats = this.GRUPOS[grupo]?.cats || [];
    const out = {};
    cats.forEach(c => {
      const modelos = this._valoresEnStock('modelo', p => p.cat === c && this.hayUnidades(p));
      if (modelos.length) out[c] = modelos.sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
    });
    return out;
  },

  // Productos del grupo actualmente seleccionado (Dispositivos / Accesorios / Perfumería)
  productosDelGrupo(grupo) {
    const cats = this.GRUPOS[grupo]?.cats || [];
    return State.stock.filter(p => cats.includes(p.cat));
  },

  render() {
    const c = document.createElement('div');
    c.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;min-height:0';
    const mobile = this.isMobile();
    c.innerHTML = `
      <div style="padding:${mobile?'10px 14px':'16px 22px'};border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;${mobile?'margin-bottom:8px':'margin-bottom:14px'}">
          <h2 style="font-size:${mobile?'16px':'19px'};font-weight:700;display:flex;align-items:center;gap:6px"><i class="ti ti-box" style="color:var(--blue)"></i> Stock</h2>
          <div style="display:flex;gap:6px">
            ${mobile ? '' : `<button class="btn" onclick="Stock.exportarExcel()"><i class="ti ti-file-spreadsheet"></i> Exportar</button>`}
            <button class="btn btn-primary" onclick="Stock.openDrawer('new')"><i class="ti ti-plus"></i> ${mobile?'Agregar':'Agregar producto'}</button>
          </div>
        </div>
        <div id="stock-kpis"></div>
      </div>

      <div style="padding:${mobile?'8px 12px':'10px 22px'};border-bottom:1px solid var(--border);display:flex;gap:4px" id="stock-view-tabs"></div>
      <div id="stock-view-host" style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0;position:relative"></div>
      <div id="stock-drawer-host"></div>
    `;
    setTimeout(() => this.renderView(), 0);
    return c;
  },

  isMobile() { return window.innerWidth <= 900; },

  renderKpis() {
    const grupo = this.productosDelGrupo(this.currentGroup);
    const mobile = this.isMobile();

    if (mobile) {
      // Tira compacta de estadísticas en una sola línea
      let stats;
      if (this.currentGroup === 'taller') {
        const herramientas = grupo.filter(p => p.cat === 'herramienta');
        const repuestos = grupo.filter(p => p.cat === 'repuesto');
        const valorTotal = grupo.reduce((a,p) => a + p.costoUSD * Math.max(this.stockReal(p), 1), 0);
        stats = [
          { label: 'Herr.', val: herramientas.length, color: 'var(--amber)' },
          { label: 'Repuestos', val: repuestos.length, color: 'var(--blue)' },
          { label: 'Valor', val: State.fmtUSD(valorTotal), color: 'var(--green)' },
        ];
      } else {
        const total = grupo.length;
        const disponibles = grupo.filter(p => (p.estadoInventario||'disponible') === 'disponible' && this.stockReal(p) > 0).length;
        const valorDisponible = grupo.filter(p => (p.estadoInventario||'disponible')!=='vendido').reduce((a,p)=>a + p.costoUSD * this.stockReal(p), 0);
        stats = [
          { label: 'Total', val: total, color: 'var(--blue)' },
          { label: 'Disponibles', val: disponibles, color: 'var(--green)' },
          { label: 'Inventario', val: State.fmtUSD(valorDisponible), color: 'var(--text)' },
        ];
      }
      document.getElementById('stock-kpis').innerHTML = `
        <div style="display:flex;gap:0;overflow-x:auto;-webkit-overflow-scrolling:touch">
          ${stats.map((s, i) => `
            <div style="flex:1;min-width:80px;padding:6px 10px;${i>0?'border-left:1px solid var(--border)':''}">
              <div style="font-size:10px;color:var(--text-secondary);margin-bottom:2px">${s.label}</div>
              <div style="font-size:16px;font-weight:700;color:${s.color}">${s.val}</div>
            </div>
          `).join('')}
        </div>
      `;
      return;
    }

    // Desktop: cards completas
    let kpis;
    if (this.currentGroup === 'taller') {
      const herramientas = grupo.filter(p => p.cat === 'herramienta');
      const repuestos    = grupo.filter(p => p.cat === 'repuesto');
      const valorHerr    = herramientas.reduce((a,p) => a + p.costoUSD * Math.max(this.stockReal(p), 1), 0);
      const valorRep     = repuestos.reduce((a,p) => a + p.costoUSD * Math.max(this.stockReal(p), 1), 0);
      const unidadesRep  = repuestos.reduce((a,p) => a + this.stockReal(p), 0);
      kpis = [
        ['Herramientas', herramientas.length + ' ítems', '🔧', 'var(--amber)', 'rgba(255,214,10,.12)'],
        ['Valor herramientas', State.fmtUSD(valorHerr), '💵', 'var(--amber)', 'rgba(255,214,10,.12)'],
        ['Repuestos', repuestos.length + ' tipos · ' + unidadesRep + ' uds', '🔩', 'var(--blue)', 'var(--blue-light)'],
        ['Valor repuestos', State.fmtUSD(valorRep), '💰', 'var(--blue)', 'var(--blue-light)'],
        ['Total activos taller', State.fmtUSD(valorHerr + valorRep), '🏪', 'var(--green)', 'var(--green-light)'],
      ];
    } else {
      const total = grupo.length;
      const disponibles = grupo.filter(p => (p.estadoInventario||'disponible') === 'disponible' && this.stockReal(p) > 0).length;
      // Mismo criterio que la pestaña "Vendido" de abajo: antes el KPI sumaba
      // además todo lo que tuviera 0 unidades, y los dos números no coincidían.
      const vendidos = grupo.filter(p => (p.estadoInventario||'disponible') === 'vendido').length;
      const enPie = grupo.filter(p => (p.estadoInventario||'disponible') !== 'vendido');
      const valorDisponible = enPie.reduce((a,p)=>a + p.costoUSD * this.stockReal(p), 0);
      // Cuánto entraría si se vendiera lo que HAY. Los vendidos quedan afuera:
      // antes se les contaba 1 unidad a cada uno, así que este número crecía solo
      // mes a mes con el histórico de ventas y no significaba nada.
      const valorVendidoPotencial = enPie.reduce((a,p)=>{
        const precioUSD = p.cotiz ? p.precioARS / p.cotiz : 0;
        return a + precioUSD * this.stockReal(p);
      }, 0);
      document.getElementById('stock-kpis').innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px" class="stock-kpi-grid">
          <!-- Card unificada: Total / Disponibles / Vendidos -->
          <div class="card" style="padding:12px 16px;margin-bottom:0;display:flex;align-items:stretch;gap:0;min-height:76px">
            ${[
              ['Total', total, 'var(--blue)'],
              ['Disponibles', disponibles, 'var(--green)'],
              ['Vendidos', vendidos, 'var(--text-secondary)'],
            ].map(([label, val, color], i) => `
              <div style="flex:1;${i>0?'border-left:1px solid var(--border);padding-left:14px;':''}padding-right:14px">
                <div style="font-size:10px;color:var(--text-secondary);margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em">${label}</div>
                <div style="font-size:22px;font-weight:700;color:${color}">${val}</div>
              </div>
            `).join('')}
          </div>
          <!-- Valor Disponible -->
          <div class="card" style="padding:12px 14px;margin-bottom:0;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;min-height:76px">
            <div><label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Valor Disponible</label><div style="font-size:19px;font-weight:700;color:var(--blue)">${State.fmtUSD(valorDisponible)}</div></div>
            <div style="width:34px;height:34px;border-radius:8px;background:var(--blue-light);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px">💰</div>
          </div>
          <!-- Valor de Venta -->
          <div class="card" style="padding:12px 14px;margin-bottom:0;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;min-height:76px">
            <div><label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Valor de Venta</label><div style="font-size:19px;font-weight:700;color:var(--green)">${State.fmtUSD(valorVendidoPotencial)}</div></div>
            <div style="width:34px;height:34px;border-radius:8px;background:var(--green-light);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px">💵</div>
          </div>
        </div>
      `;
      return;
    }

    // Taller: layout original de 5 cards
    document.getElementById('stock-kpis').innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px" class="stock-kpi-grid">
        ${kpis.map(([label,val,emoji,color,bg]) => `
          <div class="card" style="padding:12px 14px;margin-bottom:0;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;min-height:90px">
            <div style="min-width:0;flex:1"><label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">${label}</label><div style="font-size:19px;font-weight:700;color:${color};word-break:break-word">${val}</div></div>
            <div style="width:34px;height:34px;border-radius:8px;background:${bg};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px">${emoji}</div>
          </div>
        `).join('')}
      </div>
    `;
  },

  renderView() {
    this.renderKpis();
    document.getElementById('stock-view-tabs').innerHTML = `
      <button class="btn btn-sm ${this.currentView==='productos'?'btn-primary':''}" onclick="Stock.setView('productos')"><i class="ti ti-box"></i> Productos</button>
      <button class="btn btn-sm ${this.currentView==='historial'?'btn-primary':''}" onclick="Stock.setView('historial')"><i class="ti ti-history"></i> Historial de movimientos</button>
    `;
    const host = document.getElementById('stock-view-host');
    const mobile = this.isMobile();
    const px = mobile ? '10px 12px' : '10px 22px';
    const pxS = mobile ? '8px 12px' : '12px 22px';
    // Filtros de perfumería: los mismos criterios que la landing pública —
    // familia, marca y tamaño — y ofreciendo SOLO los valores que hoy tienen
    // stock, no el catálogo entero. Filtrar por algo que no tenés no sirve.
    const opt = (v, label) => `<option value="${State.esc(v)}">${State.esc(label ?? v)}</option>`;
    const extraSelects = this.currentGroup === 'perfumeria' ? `
      <select id="pf-cat" onchange="Stock.onPerfumeFilterChange()" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:8px;max-width:130px">
        <option value="">Familia</option>
        ${this.valoresPerfumeEnStock('color').map(c => opt(c)).join('')}
      </select>
      <select id="pf-marca" onchange="Stock.renderTable()" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:8px;max-width:140px">
        <option value="">Marca</option>
        ${this.valoresPerfumeEnStock('modelo').map(m => opt(m)).join('')}
      </select>
      <select id="pf-ml" onchange="Stock.renderTable()" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:8px;max-width:100px">
        <option value="">Tamaño</option>
        ${this.mlEnStock().map(ml => opt(ml, this.fmtMl(ml) + ' ml')).join('')}
      </select>
      <select id="pf-conc" onchange="Stock.renderTable()" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:8px;max-width:100px">
        <option value="">Conc.</option>
        ${this.valoresPerfumeEnStock('storage').map(c => opt(c)).join('')}
      </select>
    ` : `
      <select id="stock-filter-modelo" onchange="Stock.onModeloFilterChange()" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:8px;max-width:160px">
        <option value="">Todos los modelos</option>
        ${Object.entries(this.modelosConStockPorCatDelGrupo(this.currentGroup)).map(([cat,modelos])=>`<optgroup label="${this.CAT_LABELS[cat]||cat}">${modelos.map(m=>`<option value="${State.esc(m)}">${State.esc(m)}</option>`).join('')}</optgroup>`).join('')}
      </select>
      <select id="stock-filter-color" onchange="Stock.renderTable()" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:8px;max-width:140px">
        <option value="">Todos los colores</option>
      </select>
    `;

    if (this.currentView === 'productos') {
      if (mobile) {
        // Mobile: filas apiladas (comportamiento original)
        host.innerHTML = `
          <div style="padding:${px};border-bottom:1px solid var(--border);display:flex;gap:4px;overflow-x:auto;-webkit-overflow-scrolling:touch;white-space:nowrap;flex-shrink:0" id="stock-grupo-tabs"></div>
          <div style="padding:${px};border-bottom:1px solid var(--border);display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;white-space:nowrap;flex-shrink:0;align-items:center" id="stock-estado-tabs"></div>
          <div style="padding:${pxS};border-bottom:1px solid var(--border);display:flex;gap:0;overflow-x:auto;-webkit-overflow-scrolling:touch;white-space:nowrap;flex-shrink:0;align-items:center" id="stock-tabs-wrap">
            <div style="display:flex;gap:4px;align-items:center" id="stock-condicion-tabs"></div>
            <div style="width:1px;background:var(--border);height:20px;margin:0 8px;flex-shrink:0" id="stock-tabs-divider"></div>
            <div style="display:flex;gap:4px" id="stock-tabs"></div>
          </div>
          <div style="padding:8px 12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;flex-shrink:0">
            <input type="text" id="stock-search" placeholder="Buscar..." oninput="Stock.renderTable()" style="font-size:12px;padding:6px 10px;border:1px solid var(--border-strong);border-radius:8px;flex:1;min-width:120px">
            ${extraSelects}
          </div>
          <div id="stock-seleccion-bar" style="display:none"></div>
          <div class="body-pad" style="padding:0;overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1;min-height:0">
            <table class="stock-table-desktop"><thead><tr>
              <th style="width:34px"><input type="checkbox" id="stock-check-todos" onchange="Stock.toggleTodos(this.checked)" title="Seleccionar todo lo filtrado"></th>
              <th>Producto</th><th>Color</th><th>Batería</th><th>Costo USD</th><th>Precio venta USD</th><th>Margen</th><th>Stock</th><th>IMEI</th><th>Estado</th><th></th>
            </tr></thead><tbody id="stock-tbody"></tbody></table>
            <div class="stock-cards-mobile" id="stock-cards"></div>
          </div>
        `;
      } else {
        // Desktop: 2 filas compactas aprovechando el espacio horizontal
        host.innerHTML = `
          <!-- Fila 1: Grupos (izq) + Estado (der) -->
          <div style="padding:8px 22px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:0;flex-shrink:0;min-height:0">
            <div style="display:flex;gap:4px;flex-shrink:0;overflow-x:auto;-webkit-overflow-scrolling:touch" id="stock-grupo-tabs"></div>
            <div style="width:1px;background:var(--border);height:22px;margin:0 14px;flex-shrink:0"></div>
            <div style="display:flex;gap:2px;overflow-x:auto;-webkit-overflow-scrolling:touch;flex:1;align-items:center" id="stock-estado-tabs"></div>
          </div>
          <!-- Fila 2: Condición + Subcats (izq) + Búsqueda/dropdowns (der) -->
          <div style="padding:8px 22px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:nowrap">
            <div style="display:flex;gap:0;align-items:center;flex-shrink:0" id="stock-tabs-wrap">
              <div style="display:flex;gap:4px;align-items:center" id="stock-condicion-tabs"></div>
              <div style="width:1px;background:var(--border);height:20px;margin:0 8px;flex-shrink:0" id="stock-tabs-divider"></div>
              <div style="display:flex;gap:4px" id="stock-tabs"></div>
            </div>
            <div style="flex:1"></div>
            <input type="text" id="stock-search" placeholder="Buscar..." oninput="Stock.renderTable()" style="font-size:12px;padding:5px 10px;border:1px solid var(--border-strong);border-radius:8px;width:180px;flex-shrink:0">
            ${extraSelects}
          </div>
          <div id="stock-seleccion-bar" style="display:none"></div>
          <div class="body-pad" style="padding:0;overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1;min-height:0">
            <table class="stock-table-desktop"><thead><tr>
              <th style="width:34px"><input type="checkbox" id="stock-check-todos" onchange="Stock.toggleTodos(this.checked)" title="Seleccionar todo lo filtrado"></th>
              <th>Producto</th><th>Color</th><th>Batería</th><th>Costo USD</th><th>Precio venta USD</th><th>Margen</th><th>Stock</th><th>IMEI</th><th>Estado</th><th></th>
            </tr></thead><tbody id="stock-tbody"></tbody></table>
            <div class="stock-cards-mobile" id="stock-cards"></div>
          </div>
        `;
      }
      this.renderGrupoTabs();
      this.renderEstadoTabs();
      this.renderCondicionTabs();
      this.renderTabs();
      this._actualizarColoresDisponibles();
      this.renderTable();
    } else {
      host.innerHTML = `<div class="body-pad" style="overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1;min-height:0" id="historial-general-host"></div>`;
      this.renderHistorialGeneral();
    }
  },

  setView(v) { this.currentView = v; this.renderView(); },

  renderGrupoTabs() {
    const mobile = this.isMobile();
    document.getElementById('stock-grupo-tabs').innerHTML = Object.entries(this.GRUPOS).map(([k,g]) => {
      const count = this.productosDelGrupo(k).length;
      const active = this.currentGroup === k;
      return `<button onclick="Stock.setGrupo('${k}')" style="display:inline-flex;align-items:center;gap:5px;padding:${mobile?'6px 10px':'8px 14px'};border-radius:8px;border:1.5px solid ${active?'var(--blue)':'var(--border)'};background:${active?'var(--blue-light)':'var(--bg)'};color:${active?'var(--blue)':'var(--text-secondary)'};font-size:${mobile?'12px':'12.5px'};font-weight:${active?'600':'400'};cursor:pointer;white-space:nowrap;flex-shrink:0">
        <i class="ti ${g.icon}"></i> ${g.label} <span style="background:${active?'#fff':'var(--bg-secondary)'};padding:1px 5px;border-radius:10px;font-size:10px">${count}</span>
      </button>`;
    }).join('');
  },
  setGrupo(g) {
    this.currentGroup = g;
    this.currentTab = 'all';
    this.currentEstado = 'todos';
    this.currentCondicion = 'todos';
    // La selección era de productos del grupo anterior: si no se limpia, la barra
    // azul sigue ofreciendo "Editar precio" sobre productos que ya no se ven.
    this._sel.clear();
    // renderView() rearma toda la barra de filtros. Antes no se llamaba, así que
    // los filtros de Perfumería (categoría/concentración/marca) no aparecían nunca
    // si entrabas por Dispositivos, y un filtro de modelo del grupo anterior
    // quedaba aplicado dejando la tabla vacía sin motivo visible.
    this.renderView();
  },

  // Marcas de perfumería: las del catálogo + las que ya existan en el stock.
  marcasPerfumeria() {
    const out = {};
    Object.entries(this.PERFUME_MARCAS).forEach(([cat, marcas]) => { out[cat] = [...marcas]; });
    const conocidas = Object.values(this.PERFUME_MARCAS).flat().map(m => m.toLowerCase());
    const extras = this._valoresEnStock('modelo', p => this.esPerfume(p.cat))
      .filter(m => !conocidas.includes(m.toLowerCase()))
      .sort((a, b) => a.localeCompare(b, 'es'));
    if (extras.length) out['Otras'] = extras;
    return out;
  },

  renderEstadoTabs() {
    const grupo = this.productosDelGrupo(this.currentGroup);
    // 'eliminado' va al final y SOLO si hay alguno: sin esto esos productos no
    // se podían aislar, y el total no cerraba (86 ≠ 38 disponibles + 44 vendidos,
    // los 4 que faltaban eran justamente estos).
    const estados = ['todos', 'disponible', 'reservado', 'en_reparacion', 'vendido'];
    if (grupo.some(p => p.estadoInventario === 'eliminado')) estados.push('eliminado');
    document.getElementById('stock-estado-tabs').innerHTML = estados.map(e => {
      const count = e === 'todos' ? grupo.length : grupo.filter(p => (p.estadoInventario||'disponible') === e).length;
      const label = e === 'todos' ? 'Todos' : this.ESTADO_INV_LABEL[e];
      const active = this.currentEstado === e;
      return `<span onclick="Stock.setEstadoFiltro('${e}')" style="cursor:pointer;font-size:12px;padding:5px 11px;border-radius:20px;border-bottom:2px solid ${active?'var(--blue)':'transparent'};color:${active?'var(--blue)':'var(--text-secondary)'};font-weight:${active?'600':'400'};display:inline-flex;align-items:center;gap:5px">${label} <span style="background:var(--bg-secondary);padding:1px 6px;border-radius:10px;font-size:10px">${count}</span></span>`;
    }).join('');
  },
  setEstadoFiltro(e) { this.currentEstado = e; this.renderEstadoTabs(); this.renderTable(); },

  renderCondicionTabs() {
    const grupo = this.productosDelGrupo(this.currentGroup);
    const counts = {
      todos: grupo.length,
      nuevo: grupo.filter(p => this.condicionDe(p) === 'nuevo').length,
      usado: grupo.filter(p => this.condicionDe(p) === 'usado').length,
      sindato: grupo.filter(p => this.condicionDe(p) === 'sindato').length,
    };
    const labels = { todos: '📦 Todos', nuevo: '✨ Nuevo / Sellado', usado: '🔄 Usado' };
    // El chip de "sin dato" solo aparece si hay productos así, y desaparece solo
    // cuando se termina de completar el campo.
    if (counts.sindato > 0) labels.sindato = '❓ Sin estado cargado';
    document.getElementById('stock-condicion-tabs').innerHTML = Object.entries(labels).map(([key, label]) => {
      const active = this.currentCondicion === key;
      return `<button onclick="Stock.setCondicionFiltro('${key}')" style="cursor:pointer;font-size:11px;padding:4px 9px;border-radius:14px;border:1px solid ${active?'var(--blue)':'var(--border-strong)'};background:${active?'var(--blue-light)':'transparent'};color:${active?'var(--blue)':'var(--text-secondary)'};font-weight:${active?'600':'400'};display:inline-flex;align-items:center;gap:4px;white-space:nowrap">${label} <span style="font-size:10px;opacity:.75">${counts[key]}</span></button>`;
    }).join('');
  },
  setCondicionFiltro(c) { this.currentCondicion = c; this.renderCondicionTabs(); this.renderTable(); },

  // Nuevo / usado / sin dato. Antes "usado" era simplemente "todo lo que no dice
  // Nuevo / Sellado", así que los productos con el campo vacío se afirmaban como
  // usados — y hasta ahora el campo ni siquiera se podía cargar en accesorios,
  // perfumería o repuestos. Sin dato es su propia categoría: no se inventa.
  condicionDe(p) {
    const e = (p.estadoProducto || '').trim();
    if (!e) return 'sindato';
    return e === 'Nuevo / Sellado' ? 'nuevo' : 'usado';
  },

  renderTabs() {
    const catsDelGrupo = this.GRUPOS[this.currentGroup]?.cats || [];
    const cats = ['all', ...catsDelGrupo.filter(c => State.stock.some(s => s.cat === c))];
    const showSubcats = cats.length > 2;
    const divider = document.getElementById('stock-tabs-divider');
    if (divider) divider.style.display = showSubcats ? '' : 'none';
    document.getElementById('stock-tabs').innerHTML = showSubcats ? cats.map(c => {
      const count = c === 'all' ? this.productosDelGrupo(this.currentGroup).length : State.stock.filter(s => s.cat === c).length;
      const label = c === 'all' ? 'Todos' : (this.CAT_LABELS[c] || c);
      return `<button class="btn btn-sm ${this.currentTab===c?'btn-primary':''}" onclick="Stock.setTab('${c}')">${label} (${count})</button>`;
    }).join('') : '';
  },
  setTab(c) { this.currentTab = c; this.renderTabs(); this._actualizarColoresDisponibles(); this.renderTable(); },

  actualizarMarcasPerfume() {
    const cat = document.getElementById('f-pf-cat')?.value || '';
    const marcaSelect = document.getElementById('f-pf-marca');
    if (!marcaSelect) return;
    const prev = marcaSelect.value;
    marcaSelect.innerHTML = '<option value="">— Elegir —</option>';
    const todas = this.marcasPerfumeria();
    const fuentes = cat ? { [cat]: todas[cat] || [] } : todas;
    Object.entries(fuentes).forEach(([grupo, marcas]) => {
      const og = document.createElement('optgroup');
      og.label = grupo;
      marcas.forEach(m => { const opt = document.createElement('option'); opt.value = m; opt.textContent = m; if (m === prev) opt.selected = true; og.appendChild(opt); });
      marcaSelect.appendChild(og);
    });
  },

  // Al elegir una familia, la lista de marcas se acota a las de esa familia
  // que además tengan stock. Si la marca elegida ya no aplica, se limpia sola.
  onPerfumeFilterChange() {
    const cat = document.getElementById('pf-cat')?.value || '';
    const marcaSelect = document.getElementById('pf-marca');
    if (!marcaSelect) return;
    const prev = marcaSelect.value;
    const marcas = [...new Set(State.stock
      .filter(p => this.esPerfume(p.cat) && this.hayUnidades(p) && (!cat || (p.color || '') === cat))
      .map(p => String(p.modelo || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    marcaSelect.innerHTML = '<option value="">Marca</option>' +
      marcas.map(m => `<option value="${State.esc(m)}" ${m === prev ? 'selected' : ''}>${State.esc(m)}</option>`).join('');
    this.renderTable();
  },

  onModeloFilterChange() {
    this._actualizarColoresDisponibles();
    this.renderTable();
  },

  _actualizarColoresDisponibles() {
    const colorSelect = document.getElementById('stock-filter-color');
    if (!colorSelect) return;
    const modeloFiltro = document.getElementById('stock-filter-modelo')?.value || '';
    const catsDelGrupo = this.GRUPOS[this.currentGroup]?.cats || [];
    // Mismo criterio que el filtro de modelos: solo colores de lo que hay.
    const colores = [...new Set(
      State.stock
        .filter(s => catsDelGrupo.includes(s.cat) && s.color && this.hayUnidades(s)
                  && (!modeloFiltro || (s.modelo || '').toLowerCase() === modeloFiltro.toLowerCase()))
        .map(s => s.color)
    )].sort((a, b) => a.localeCompare(b, 'es'));
    const valorActual = colorSelect.value;
    colorSelect.innerHTML = `<option value="">Todos los colores</option>` +
      colores.map(c => `<option value="${State.esc(c)}" ${c === valorActual ? 'selected' : ''}>${State.esc(c)}</option>`).join('');
  },

  // ── Selección múltiple para editar precios en lote ────────────────
  _sel: new Set(),
  _ultimosFiltrados: [],

  toggleUno(id, activo) {
    if (activo) this._sel.add(String(id)); else this._sel.delete(String(id));
    this.pintarBarraSeleccion();
  },

  toggleTodos(activo) {
    this._ultimosFiltrados.forEach(p => {
      if (activo) this._sel.add(String(p.id)); else this._sel.delete(String(p.id));
    });
    document.querySelectorAll('.stock-check').forEach(c => { c.checked = activo; });
    this.pintarBarraSeleccion();
  },

  limpiarSeleccion() {
    this._sel.clear();
    document.querySelectorAll('.stock-check').forEach(c => { c.checked = false; });
    const t = document.getElementById('stock-check-todos'); if (t) t.checked = false;
    this.pintarBarraSeleccion();
  },

  _seleccionados() {
    return State.stock.filter(p => this._sel.has(String(p.id)));
  },

  pintarBarraSeleccion() {
    const bar = document.getElementById('stock-seleccion-bar');
    if (!bar) return;
    const sel = this._seleccionados();
    if (!sel.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
    const nombres = [...new Set(sel.map(p => p.nombre))];
    bar.style.display = 'block';
    bar.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 22px;background:var(--blue-light);border-bottom:1px solid rgba(10,132,255,.3)">
        <b style="font-size:13px;color:var(--blue)">${sel.length} producto(s) seleccionado(s)</b>
        <span style="font-size:11.5px;color:var(--text-secondary)">${State.esc(nombres.slice(0,2).join(' · '))}${nombres.length>2?` y ${nombres.length-2} más`:''}</span>
        <div style="flex:1"></div>
        <button class="btn btn-sm btn-primary" onclick="Stock.abrirPrecioLote()"><i class="ti ti-tag"></i> Editar precio</button>
        <button class="btn btn-sm" onclick="Stock.limpiarSeleccion()">Limpiar</button>
      </div>`;
  },

  abrirPrecioLote() {
    const sel = this._seleccionados();
    if (!sel.length) return;
    // La edición en lote respeta la moneda del rubro, igual que el formulario:
    // si TODO lo seleccionado se vende en pesos (perfumería, decants, combos),
    // el precio se pide y se guarda en pesos. Si no, en dólares como siempre.
    // Con una selección mezclada no hay moneda correcta: se avisa y se corta.
    const enPesos = sel.filter(p => this.esPrecioEnPesos(p.cat)).length;
    if (enPesos > 0 && enPesos < sel.length) {
      toast('Elegí productos de un solo tipo: los perfumes se cotizan en pesos y el resto en dólares.');
      return;
    }
    this._loteEnPesos = enPesos === sel.length;
    const moneda = this._loteEnPesos ? 'ARS' : 'USD';
    const precios = [...new Set(sel.map(p => this._loteEnPesos
      ? Math.round(p.precioARS || 0)
      : (p.cotiz ? +(p.precioARS / p.cotiz).toFixed(2) : 0)))];
    const sugerido = precios.length === 1 ? precios[0] : '';
    const costoMax = Math.max(...sel.map(p => p.costoUSD || 0));
    const host = document.getElementById('stock-modal-host') || document.body;
    const div = document.createElement('div');
    div.id = 'precio-lote-overlay';
    div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:600;padding:20px';
    div.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(400px,96vw);overflow:hidden" onclick="event.stopPropagation()">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border)">
          <div style="font-size:14px;font-weight:700">Editar precio de ${sel.length} producto(s)</div>
          <div style="font-size:11px;color:var(--text-secondary)">Costo más alto de la selección: USD ${costoMax}</div>
        </div>
        <div style="padding:18px">
          <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Nuevo precio de venta (${moneda})</label>
          <input type="text" inputmode="decimal" id="pl-precio" value="${sugerido}" placeholder="0"
            oninput="Stock._previewPrecioLote()"
            style="width:100%;font-size:17px;font-weight:700;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          <div id="pl-preview" style="font-size:11.5px;color:var(--text-secondary);margin-top:8px;min-height:32px"></div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('precio-lote-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" id="pl-guardar" onclick="Stock.guardarPrecioLote()"><i class="ti ti-check"></i> Aplicar a los ${sel.length}</button>
        </div>
      </div>`;
    div.addEventListener('click', e => { if (e.target === div) div.remove(); });
    host.appendChild(div);
    this._previewPrecioLote();
    setTimeout(() => document.getElementById('pl-precio')?.select(), 60);
  },

  _previewPrecioLote() {
    const el = document.getElementById('pl-preview');
    if (!el) return;
    const sel = this._seleccionados();
    const valor = this.parseARS(document.getElementById('pl-precio')?.value);
    if (!valor) { el.innerHTML = 'Ingresá el precio que querés dejar en los productos elegidos.'; return; }

    if (this._loteEnPesos) {
      // En pesos el precio se guarda tal cual; el margen se mide contra el
      // costo de cada producto pasado a pesos por SU propia cotización.
      const margenes = sel.map(p => {
        const costoARS = (p.costoUSD || 0) * (p.cotiz || State.refBlue);
        return costoARS > 0 ? Math.round(((valor - costoARS) / costoARS) * 100) : 0;
      });
      const minP = Math.min(...margenes), maxP = Math.max(...margenes);
      const bajoP = margenes.some(m => m < 0);
      el.innerHTML = `Quedan a <b>${State.fmtARS(valor)}</b>, tal cual, sin convertir por el dólar.<br>
        Margen resultante: <b style="color:${bajoP?'var(--red)':'var(--green)'}">${minP===maxP ? (minP>=0?'+':'')+minP+'%' : `${minP}% a ${maxP}%`}</b>
        ${bajoP ? ' <span style="color:var(--red)">— alguno queda por debajo del costo</span>' : ''}`;
      return;
    }

    const usd = valor;
    const margenes = sel.map(p => p.costoUSD > 0 ? Math.round(((usd - p.costoUSD) / p.costoUSD) * 100) : 0);
    const min = Math.min(...margenes), max = Math.max(...margenes);
    const bajo = margenes.some(m => m < 0);
    // El ARS que se guarda sale de la cotización de CADA producto, no del blue de
    // hoy: mostrar "al blue de hoy" era mentirle al usuario sobre lo que se graba.
    const arsList = sel.map(p => Math.round(usd * (p.cotiz || State.refBlue)));
    const arsMin = Math.min(...arsList), arsMax = Math.max(...arsList);
    const enARS = arsMin === arsMax
      ? State.fmtARS(arsMin)
      : `${State.fmtARS(arsMin)} a ${State.fmtARS(arsMax)}`;
    el.innerHTML = `Quedan a <b>${State.fmtUSD(usd)}</b> (${enARS} según la cotización guardada de cada producto).<br>
      Margen resultante: <b style="color:${bajo?'var(--red)':'var(--green)'}">${min===max ? (min>=0?'+':'')+min+'%' : `${min}% a ${max}%`}</b>
      ${bajo ? ' <span style="color:var(--red)">— alguno queda por debajo del costo</span>' : ''}`;
  },

  async guardarPrecioLote() {
    const valor = this.parseARS(document.getElementById('pl-precio')?.value);
    if (!(valor > 0)) { toast('Ingresá un precio válido.'); return; }
    const usd = valor;
    const sel = this._seleccionados();
    if (!sel.length) return;
    const btn = document.getElementById('pl-guardar');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }

    let ok = 0, fallaron = [];
    for (const p of sel) {
      // Se respeta la cotización guardada de cada producto: así el precio en
      // dólares queda exacto y no se altera su histórico.
      const cotiz = p.cotiz || State.refBlue;
      // Se capturan ANTES de pisar p.precioARS unas líneas más abajo, o el
      // movimiento del historial diría "85.800 → 85.800".
      const anteriorARS = p.precioARS || 0;
      const anteriorUSD = anteriorARS / cotiz;
      // En los rubros en pesos el número va tal cual, sin pasar por el dólar.
      const nuevoARS = this._loteEnPesos ? Math.round(valor) : Math.round(usd * cotiz);
      const guardado = await DB.actualizarPrecioStock(p.id, nuevoARS);
      if (guardado) {
        p.precioARS = nuevoARS;
        ok++;
        // Cambiar el precio de a uno dejaba rastro y en lote no: justo al revés
        // de lo que conviene auditar.
        const unidades = this.stockReal(p);
        const antesTxt = this._loteEnPesos ? State.fmtARS(anteriorARS) : State.fmtUSD(anteriorUSD);
        const despuesTxt = this._loteEnPesos ? State.fmtARS(nuevoARS) : State.fmtUSD(usd);
        await DB.registrarMovimientoStock(p.id, 'precio',
          `Precio de venta en lote: ${antesTxt} → ${despuesTxt} (${sel.length} productos)`,
          unidades, unidades);
      } else { fallaron.push(p.nombre); }
    }

    document.getElementById('precio-lote-overlay')?.remove();
    this.limpiarSeleccion();
    this.renderKpis(); this.renderTable();
    if (fallaron.length) toast(`${ok} actualizado(s). No se pudo con: ${[...new Set(fallaron)].join(', ')}`);
    else toast(`Precio actualizado en ${ok} producto(s).`);
  },

  renderTable() {
    const q = (document.getElementById('stock-search')?.value || '').toLowerCase();
    const modeloFiltro = document.getElementById('stock-filter-modelo')?.value || '';
    const colorFiltro = document.getElementById('stock-filter-color')?.value || '';
    const pfCat = document.getElementById('pf-cat')?.value || '';
    const pfConc = document.getElementById('pf-conc')?.value || '';
    const pfMarca = document.getElementById('pf-marca')?.value || '';
    const pfMl = parseFloat(document.getElementById('pf-ml')?.value) || 0;
    const catsDelGrupo = this.GRUPOS[this.currentGroup]?.cats || [];
    let rows = State.stock.filter(s => {
      if (!catsDelGrupo.includes(s.cat)) return false;
      if (this.currentTab !== 'all' && s.cat !== this.currentTab) return false;
      if (this.currentEstado !== 'todos' && (s.estadoInventario||'disponible') !== this.currentEstado) return false;
      if (this.currentCondicion !== 'todos' && this.condicionDe(s) !== this.currentCondicion) return false;
      if (q && !s.nombre.toLowerCase().includes(q)) return false;
      if (modeloFiltro && (s.modelo || '').toLowerCase() !== modeloFiltro.toLowerCase()) return false;
      if (colorFiltro && (s.color || '') !== colorFiltro) return false;
      // Filtros exclusivos de perfumería (color=categoria, storage=concentracion, modelo=marca)
      if (pfCat && (s.color || '') !== pfCat) return false;
      if (pfConc && (s.storage || '') !== pfConc) return false;
      if (pfMarca && (s.modelo || '') !== pfMarca) return false;
      if (pfMl && this.mlDe(s) !== pfMl) return false;
      return true;
    });
    const tbody = document.getElementById('stock-tbody');
    const cardsHost = document.getElementById('stock-cards');
    if (!tbody) return;
    rows = this.ordenarProductos(rows);
    this._ultimosFiltrados = rows;   // lo que ve el usuario, para "seleccionar todo"

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="11"><div class="empty-state"><i class="ti ti-box"></i>Sin productos que coincidan</div></td></tr>`;
      if (cardsHost) cardsHost.innerHTML = `<div class="empty-state"><i class="ti ti-box"></i>Sin productos que coincidan</div>`;
      // Igual hay que repintar: si no, la barra de selección queda colgada con
      // productos que el filtro actual ya no muestra.
      this.pintarBarraSeleccion();
      const todosVacio = document.getElementById('stock-check-todos');
      if (todosVacio) todosVacio.checked = false;
      return;
    }

    const filaTabla = (p) => {
      const stock = this.stockReal(p);
      const costoARS = p.costoUSD * p.cotiz;
      // Sin costo o sin cotización el margen no existe (daba NaN o Infinity, y en
      // las tarjetas de mobile se veía "-100%" en los equipos sin tasar).
      const margin = costoARS > 0 ? Math.round(((p.precioARS - costoARS) / costoARS) * 100) : null;
      const precioUSD = p.cotiz ? (p.precioARS / p.cotiz) : 0;
      const esIMEI = this.CATS_IMEI.includes(p.cat);
      const detalleStock = esIMEI ? `${stock} <span style="font-size:9px;color:var(--text-secondary)">(${(p.imeis||[]).length} IMEI)</span>` : `${stock}`;
      const estadoInv = p.estadoInventario || 'disponible';
      const statusBadge = `<span class="badge ${this.ESTADO_INV_CLASS[estadoInv]}">${this.ESTADO_INV_LABEL[estadoInv]}</span>`;
      return { stock, margin, precioUSD, esIMEI, detalleStock, statusBadge };
    };

    tbody.innerHTML = rows.map(p => {
      const { margin, precioUSD, esIMEI, detalleStock, statusBadge } = filaTabla(p);
      return `<tr>
        <td style="text-align:center"><input type="checkbox" class="stock-check" value="${p.id}" ${this._sel.has(String(p.id))?'checked':''} onchange="Stock.toggleUno('${p.id}', this.checked)"></td>
        <td>
          <b>${State.esc(p.nombre)}</b>
          ${p.cat === 'repuesto' && p.modelo ? `<div style="font-size:10px;color:var(--amber)"><i class="ti ti-device-mobile" style="font-size:9px"></i> ${State.esc(p.modelo)}</div>` : ''}
          ${p.notas ? `<div style="font-size:10px;color:var(--text-secondary)">${State.esc(p.notas)}</div>` : ''}
        </td>
        <td style="font-size:11.5px">${State.esc(p.color) || '—'}</td>
        <td style="font-size:11.5px">${p.bateriaPct != null ? `<span style="color:${p.bateriaPct>=80?'var(--green)':p.bateriaPct>=60?'var(--amber)':'var(--red)'}">${p.bateriaPct}%</span>` : '—'}</td>
        <td>USD ${p.costoUSD}</td>
        <td>${precioUSD ? State.fmtUSD(precioUSD) + `<div style="font-size:10px;color:var(--text-secondary)">${State.fmtARS(p.precioARS)}</div>` : '<span style="color:var(--text-secondary)">—</span>'}</td>
        <td style="color:${margin >= 0 ? 'var(--green)' : 'var(--red)'}">${(precioUSD && margin != null) ? (margin>=0?'+':'') + margin + '%' : '—'}</td>
        <td>${detalleStock}</td>
        <td style="font-size:10.5px;color:var(--text-secondary)">${esIMEI ? (p.imeis||[]).map(i => State.esc(i)).join('<br>') || '—' : '—'}</td>
        <td>${statusBadge}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm" onclick="Stock.openDrawer('edit','${p.id}')" title="Editar">✏️</button>
          ${this.stockReal(p) > 1 ? `<button class="btn btn-sm" onclick="Stock.separarUnidades('${p.id}')" title="Separar en unidades individuales" style="margin-left:4px">✂️</button>` : ''}
        </td>
      </tr>`;
    }).join('');

    if (cardsHost) {
      cardsHost.innerHTML = rows.map(p => {
        const { margin, precioUSD, detalleStock, statusBadge } = filaTabla(p);
        return `<div class="stock-card" onclick="Stock.openDrawer('edit','${p.id}')">
          <div class="stock-card-top">
            <div style="min-width:0;flex:1">
              <div class="stock-card-name">${State.esc(p.nombre)}</div>
              <span class="badge ${this.CAT_CLASS[p.cat]||'b-gray'}" style="margin-top:4px">${this.CAT_LABELS[p.cat]||p.cat}</span>
              ${p.cat === 'repuesto' && p.modelo ? `<div style="font-size:10.5px;color:var(--amber);margin-top:3px"><i class="ti ti-device-mobile" style="font-size:9px"></i> ${State.esc(p.modelo)}</div>` : ''}
              ${this.esPerfume(p.cat) ? `<div style="font-size:10.5px;color:var(--text-secondary);margin-top:3px">${State.esc([p.modelo,p.storage,p.color].filter(Boolean).join(' · '))}</div>` : ''}
            </div>
            ${statusBadge}
          </div>
          <div class="stock-card-grid">
            <div><label>Costo</label><span>USD ${p.costoUSD}</span></div>
            <div><label>Venta</label><span>${State.fmtUSD(precioUSD)}</span></div>
            <div><label>Margen</label><span style="color:${margin >= 0 ? 'var(--green)' : 'var(--red)'}">${(precioUSD && margin != null) ? (margin>=0?'+':'') + margin + '%' : '—'}</span></div>
            <div><label>Stock</label><span>${detalleStock}</span></div>
          </div>
          <div class="stock-card-bottom">
            <span><i class="ti ti-truck"></i> ${State.esc(p.proveedor)}</span>
            <span><i class="ti ti-user"></i> ${State.esc(p.custodio) || 'Sin asignar'}</span>
          </div>
          ${p.notas ? `<div class="stock-card-notas">${State.esc(p.notas)}</div>` : ''}
        </div>`;
      }).join('');
    }
    // La selección sobrevive a los filtros: repintamos la barra con lo que quede
    this.pintarBarraSeleccion();
    const todos = document.getElementById('stock-check-todos');
    if (todos) todos.checked = rows.length > 0 && rows.every(p => this._sel.has(String(p.id)));
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
          <td>${State.esc(nombrePorId[m.stock_id]) || '(producto eliminado)'}</td>
          <td><span class="badge ${this.TIPO_MOV_CLASS[m.tipo]||'b-gray'}">${this.TIPO_MOV_LABEL[m.tipo]||m.tipo}</span></td>
          <td style="font-size:11.5px;color:var(--text-secondary)">${State.esc(m.detalle) || '—'}</td>
          <td style="font-size:11.5px">${m.cantidad_antes ?? '—'} → ${m.cantidad_despues ?? '—'}</td>
          <td style="font-size:11.5px">${State.esc(m.usuario_nombre) || '—'}</td>
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
    host.innerHTML = movs.map(m => {
      let extraLink = '';
      if (m.tipo === 'trade_in' && m.datos?.ventaId) {
        extraLink = `<a href="#" onclick="event.preventDefault();document.getElementById('historial-producto-host').closest('.drawer').querySelector('.close-btn')?.click();setTimeout(()=>Ventas.viewSale(${m.datos.ventaId}),200)" style="font-size:11px;color:var(--green);text-decoration:underline;margin-left:6px">Ver venta #${m.datos.ventaId}</a>`;
      }
      return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-size:11.5px">
        <div>
          <span class="badge ${this.TIPO_MOV_CLASS[m.tipo]||'b-gray'}">${this.TIPO_MOV_LABEL[m.tipo]||m.tipo}</span>
          <span style="color:var(--text-secondary);margin-left:6px">${State.esc(m.detalle)}</span>${extraLink}
        </div>
        <div style="text-align:right;color:var(--text-secondary)">
          <div>${this.fmtFechaHora(m.creado_en)}</div>
          <div>${m.usuario_nombre || ''}</div>
        </div>
      </div>
    `;
    }).join('');
  },

  fmtFechaHora(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit' }) + ' ' + d.toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' });
  },

  CAT_ICONS: { iphone:'ti-device-mobile', android:'ti-device-mobile', mac:'ti-device-laptop', ipad:'ti-device-ipad', watch:'ti-device-watch', audio:'ti-headphones', gaming:'ti-device-gamepad-2', perfumeria:'ti-droplet', decant:'ti-flask', combo:'ti-gift', accesorio:'ti-plug', repuesto:'ti-components', herramienta:'ti-tool', otro:'ti-box' },
  MODELOS_POR_CAT: {
    iphone: ['iPhone 11','iPhone 12','iPhone 12 Pro','iPhone 12 Pro Max','iPhone 13','iPhone 13 Mini','iPhone 13 Pro','iPhone 13 Pro Max','iPhone 14','iPhone 14 Plus','iPhone 14 Pro','iPhone 14 Pro Max','iPhone 15','iPhone 15 Plus','iPhone 15 Pro','iPhone 15 Pro Max','iPhone 16','iPhone 16 Plus','iPhone 16 Pro','iPhone 16 Pro Max','iPhone 16e','iPhone 17','iPhone 17 Plus','iPhone 17 Pro','iPhone 17 Pro Max','iPhone 18','iPhone 18 Plus','iPhone 18 Pro','iPhone 18 Pro Max'],
    android: ['Samsung Galaxy S23','Samsung Galaxy S24','Samsung Galaxy S24+','Samsung Galaxy S24 Ultra','Samsung Galaxy A54','Samsung Galaxy A34','Motorola G84','Motorola G54','Motorola Edge 40','Xiaomi 13'],
    mac: ['MacBook Air M1','MacBook Air M2','MacBook Air M3','MacBook Pro 14" M3','MacBook Pro 16" M3','Mac Mini M2','iMac M3'],
    ipad: ['iPad 9ª gen','iPad 10ª gen','iPad Air M2','iPad Mini 6ª gen','iPad Pro 11"','iPad Pro 13"'],
    watch: ['Apple Watch SE','Apple Watch Series 9','Apple Watch Ultra 2'],
    audio: ['AirPods 2','AirPods 3','AirPods Pro 2','AirPods Max','Beats Studio Pro'],
  },
  STORAGE_OPCIONES: ['32GB','64GB','128GB','256GB','512GB','1TB','2TB'],
  COLOR_OPCIONES: ['Negro','Blanco','Azul','Verde','Rosa','Rojo','Titanio Natural','Titanio Azul','Titanio Negro','Plata','Dorado','Gris Espacial','Otro'],

  SPECS_POR_MODELO: {
    // ── iPhone ──────────────────────────────────────────────────
    'iPhone 11':          { s:['64GB','128GB','256GB'],          c:['Negro','Blanco','Rojo','Verde','Amarillo','Violeta'] },
    'iPhone 12':          { s:['64GB','128GB','256GB'],          c:['Negro','Blanco','Rojo','Azul','Verde','Violeta'] },
    'iPhone 12 Pro':      { s:['128GB','256GB','512GB'],         c:['Plata','Grafito','Dorado','Azul Pacífico'] },
    'iPhone 12 Pro Max':  { s:['128GB','256GB','512GB'],         c:['Plata','Grafito','Dorado','Azul Pacífico'] },
    'iPhone 13':          { s:['128GB','256GB','512GB'],         c:['Medianoche','Blanco Estrella','Rojo','Azul','Rosa','Verde'] },
    'iPhone 13 Mini':     { s:['128GB','256GB','512GB'],         c:['Medianoche','Blanco Estrella','Rojo','Azul','Rosa','Verde'] },
    'iPhone 13 Pro':      { s:['128GB','256GB','512GB','1TB'],   c:['Grafito','Dorado','Plata','Sierra Azul','Verde Alpino'] },
    'iPhone 13 Pro Max':  { s:['128GB','256GB','512GB','1TB'],   c:['Grafito','Dorado','Plata','Sierra Azul','Verde Alpino'] },
    'iPhone 14':          { s:['128GB','256GB','512GB'],         c:['Medianoche','Blanco Estrella','Rojo','Azul','Amarillo','Morado'] },
    'iPhone 14 Plus':     { s:['128GB','256GB','512GB'],         c:['Medianoche','Blanco Estrella','Rojo','Azul','Amarillo','Morado'] },
    'iPhone 14 Pro':      { s:['128GB','256GB','512GB','1TB'],   c:['Negro Espacial','Plata','Dorado','Morado Profundo'] },
    'iPhone 14 Pro Max':  { s:['128GB','256GB','512GB','1TB'],   c:['Negro Espacial','Plata','Dorado','Morado Profundo'] },
    'iPhone 15':          { s:['128GB','256GB','512GB'],         c:['Negro','Rosa','Amarillo','Verde','Azul'] },
    'iPhone 15 Plus':     { s:['128GB','256GB','512GB'],         c:['Negro','Rosa','Amarillo','Verde','Azul'] },
    'iPhone 15 Pro':      { s:['128GB','256GB','512GB','1TB'],   c:['Titanio Negro','Titanio Blanco','Titanio Azul','Titanio Natural'] },
    'iPhone 15 Pro Max':  { s:['256GB','512GB','1TB'],           c:['Titanio Negro','Titanio Blanco','Titanio Azul','Titanio Natural'] },
    'iPhone 16':          { s:['128GB','256GB','512GB'],         c:['Negro','Blanco','Azul','Verde Azulado','Rosa','Ultramarino'] },
    'iPhone 16 Plus':     { s:['128GB','256GB','512GB'],         c:['Negro','Blanco','Azul','Verde Azulado','Rosa','Ultramarino'] },
    'iPhone 16 Pro':      { s:['128GB','256GB','512GB','1TB'],   c:['Titanio Negro','Titanio Blanco','Titanio Desierto','Titanio Natural'] },
    'iPhone 16 Pro Max':  { s:['256GB','512GB','1TB'],           c:['Titanio Negro','Titanio Blanco','Titanio Desierto','Titanio Natural'] },
    'iPhone 16e':         { s:['128GB','256GB','512GB'],         c:['Negro','Blanco'] },
    'iPhone 17':          { s:['128GB','256GB','512GB'],         c:['Negro','Blanco','Azul Neblina','Lavanda','Salvia'] },
    'iPhone 17 Plus':     { s:['128GB','256GB','512GB'],         c:['Negro','Blanco','Azul Neblina','Lavanda','Salvia'] },
    'iPhone 17 Pro':      { s:['256GB','512GB','1TB','2TB'],     c:['Naranja Cósmico','Azul Profundo','Plata'] },
    'iPhone 17 Pro Max':  { s:['256GB','512GB','1TB','2TB'],     c:['Naranja Cósmico','Azul Profundo','Plata'] },
    // iPhone 18 — capacidades según el patrón de la generación anterior.
    // Los colores NO están puestos a propósito: no los tengo confirmados, y un
    // color inventado termina dentro del nombre del producto y le rompe a la
    // landing la búsqueda de la foto por convención de nombre. Mientras tanto
    // caen a la lista genérica y se suman solos los que se vayan cargando.
    'iPhone 18':          { s:['128GB','256GB','512GB'] },
    'iPhone 18 Plus':     { s:['128GB','256GB','512GB'] },
    'iPhone 18 Pro':      { s:['256GB','512GB','1TB','2TB'] },
    'iPhone 18 Pro Max':  { s:['256GB','512GB','1TB','2TB'] },
    // ── Mac ─────────────────────────────────────────────────────
    'MacBook Air M1':     { s:['256GB','512GB','1TB','2TB'],     c:['Plata','Gris Espacial','Dorado'] },
    'MacBook Air M2':     { s:['256GB','512GB','1TB','2TB'],     c:['Plata','Gris Espacial','Dorado','Medianoche'] },
    'MacBook Air M3':     { s:['256GB','512GB','1TB','2TB'],     c:['Plata','Gris Espacial','Dorado','Medianoche'] },
    'MacBook Pro 14" M3': { s:['512GB','1TB','2TB'],             c:['Plata','Negro Espacial'] },
    'MacBook Pro 16" M3': { s:['512GB','1TB','2TB'],             c:['Plata','Negro Espacial'] },
    'Mac Mini M2':        { s:['256GB','512GB','1TB','2TB'],     c:['Plata'] },
    'iMac M3':            { s:['256GB','512GB','1TB','2TB'],     c:['Plata','Azul','Verde','Rosa','Amarillo','Naranja','Violeta'] },
    // ── iPad ────────────────────────────────────────────────────
    'iPad 9ª gen':        { s:['64GB','256GB'],                  c:['Plata','Gris Espacial'] },
    'iPad 10ª gen':       { s:['64GB','256GB'],                  c:['Plata','Azul','Rosa','Amarillo'] },
    'iPad Air M2':        { s:['128GB','256GB','512GB','1TB'],   c:['Plata','Azul','Violeta','Rosa'] },
    'iPad Mini 6ª gen':   { s:['64GB','256GB'],                  c:['Plata','Gris Espacial','Rosa','Violeta'] },
    'iPad Pro 11"':       { s:['256GB','512GB','1TB','2TB'],     c:['Plata','Negro Espacial'] },
    'iPad Pro 13"':       { s:['256GB','512GB','1TB','2TB'],     c:['Plata','Negro Espacial'] },
  },

  // Todos los modelos conocidos (catálogo fijo + los que existan en el stock).
  todosLosModelos() {
    return [...new Set(Object.keys(this.MODELOS_POR_CAT).flatMap(c => this.modelosParaCat(c)))];
  },

  // Ejemplo de nombre según el rubro. En perfumería marca el formato estándar:
  // Marca + producto + concentración + ml, todo en el nombre.
  placeholderNombre(cat) {
    if (cat === 'perfumeria') return 'ej: Armaf Club de Nuit Intense Man EDP 105ml';
    if (cat === 'decant') return 'ej: Lattafa Asad EDP 5ml (decant)';
    if (cat === 'combo') return 'ej: Combo 3 decants Árabes 5ml';
    if (cat === 'repuesto') return 'ej: Batería, Pantalla, Flex de carga…';
    if (cat === 'herramienta') return 'ej: Pistola de calor, iSclack, destornillador pentalobe…';
    if (cat === 'gaming') return 'ej: PlayStation 5 Slim Digital 1TB';
    return 'ej: Cargador 20W, Vidrio templado…';
  },

  specsParaModelo(modelo) {
    // Cada campo cae por separado: así se puede declarar un modelo con las
    // capacidades confirmadas y dejar los colores en la lista genérica hasta
    // saberlos, en vez de tener que inventarlos para completar la entrada.
    const decl = this.SPECS_POR_MODELO[modelo] || {};
    const base = { s: decl.s || this.STORAGE_OPCIONES, c: decl.c || this.COLOR_OPCIONES };
    if (!modelo) return base;
    // Sumamos storages y colores que ya existan en el stock para ese modelo: así
    // un color cargado a mano una vez queda disponible para la próxima.
    const esDelModelo = p => String(p.modelo || '').toLowerCase() === String(modelo).toLowerCase();
    const mezclar = (fijos, campo) => {
      const extras = this._valoresEnStock(campo, esDelModelo)
        .filter(v => !fijos.some(f => f.toLowerCase() === v.toLowerCase()))
        .sort((a, b) => a.localeCompare(b, 'es'));
      return [...fijos, ...extras];
    };
    return { s: mezclar(base.s, 'storage'), c: mezclar(base.c, 'color') };
  },
  ESTADO_OPCIONES: ['Nuevo / Sellado','Excelente','Muy bueno','Bueno','Con detalles'],
  GRADO_OPCIONES: ['Sin grado','A+','A','B','C'],
  RAM_OPCIONES: ['8GB','16GB','18GB','24GB','32GB','36GB'],

  PERFUME_CATEGORIAS: ['Árabe', 'Nicho', 'Diseñador'],
  PERFUME_CONCENTRACIONES: ['EDP', 'EDT', 'EDC', 'Parfum', 'Elixir', 'Otro'],
  // Tamaños habituales. El selector suma además los que ya existan en el stock,
  // así ninguno queda afuera aunque no esté en esta lista.
  ML_OPCIONES: [2, 3, 5, 10, 15, 20, 30, 50, 60, 75, 80, 90, 100, 105, 110, 115, 120, 125, 150, 200],

  // ── MILILITROS ──────────────────────────────────────────────────
  // El tamaño vive DENTRO DEL NOMBRE ("Teriaq 100ml"), no en una columna
  // aparte. No es por comodidad: es de donde los lee la landing (`mlDe()` en
  // precios.js) para juntar los tamaños de un mismo aroma en una sola ficha.
  // Guardarlo en otro lado sería un tercer lugar para sincronizar, que es el
  // error que ya nos costó caro con modelo/color/storage.
  // Las expresiones son las MISMAS que usa precios.js, a propósito.
  RE_ML_LEER: /(\d+[.,]?\d*)\s*ml/i,
  RE_ML_QUITAR: /\b\d+[.,]?\d*\s*ml\b/gi,

  mlDe(p) {
    const m = String(p?.nombre || '').match(this.RE_ML_LEER);
    return m ? parseFloat(m[1].replace(',', '.')) : 0;
  },
  // El nombre sin el tamaño, para poder editarlo aparte del selector.
  nombreSinMl(nombre) {
    return String(nombre || '').replace(this.RE_ML_QUITAR, ' ').replace(/\s{2,}/g, ' ').trim();
  },
  fmtMl(ml) { return String(ml).replace('.', ','); },

  // ── FORMATO ESTÁNDAR DE PERFUMERÍA ──────────────────────────────
  // "Marca Producto Concentración Tamaño" (ej: Armaf Club de Nuit EDP 105ml).
  //
  // Importa que el nombre NO contradiga a los campos. Ya pasó: dos filas
  // decían "Club de nuit intense man EDP 100ml" pero una tenía storage=EDT.
  // Eran dos fragancias distintas con precios distintos, y como compartían
  // nombre exacto compartían también la URL en la web: una quedaba inalcanzable.
  _escRegex(t) { return String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); },

  // La concentración que aparece escrita dentro del nombre, si hay alguna.
  concEnNombre(nombre) {
    const m = String(nombre || '').match(/\b(EDP|EDT|EDC|Parfum|Elixir)\b/i);
    if (!m) return '';
    const hit = m[1].toLowerCase();
    return this.PERFUME_CONCENTRACIONES.find(c => c.toLowerCase() === hit) || m[1];
  },

  // El producto "pelado": sin la marca, sin la concentración y sin el tamaño.
  productoPerfume(nombre, marca) {
    let n = this.nombreSinMl(nombre);
    if (marca) n = n.replace(new RegExp('^\\s*' + this._escRegex(marca) + '\\b\\s*', 'i'), '');
    n = n.replace(/\b(EDP|EDT|EDC|Parfum|Elixir)\b/gi, ' ');
    return n.replace(/\s{2,}/g, ' ').trim();
  },

  nombreEstandarPerfume(producto, marca, conc, ml) {
    return [marca, producto, conc, ml ? `${this.fmtMl(ml)}ml` : ''].filter(Boolean).join(' ');
  },

  // Tamaños que hoy hay en el stock de perfumería, de menor a mayor.
  mlEnStock() {
    const vals = State.stock
      .filter(p => this.esPerfume(p.cat) && this.hayUnidades(p))
      .map(p => this.mlDe(p))
      .filter(Boolean);
    return [...new Set(vals)].sort((a, b) => a - b);
  },

  // Valores de un campo de perfumería que existen hoy en el stock. Igual que
  // la landing: el filtro ofrece solo lo que realmente hay, no el catálogo.
  valoresPerfumeEnStock(campo) {
    return [...new Set(State.stock
      .filter(p => this.esPerfume(p.cat) && this.hayUnidades(p))
      .map(p => String(p[campo] || '').trim())
      .filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  },
  PERFUME_MARCAS: {
    'Árabe': ['Armaf', 'Lattafa', 'Ard Al Zaafaran', 'Arabian Oud', 'Ajmal', 'Rasasi', 'Orientica', 'Al Haramain', 'Swiss Arabian', 'Afnan', 'Paris Corner', 'Maison Asrar', 'My Perfumes', 'Fragrance World', 'FA Paris', 'Otoori', 'Abdul Samad Al Qurashi', 'Nabeel', 'Al-Rehab', 'Khadlaj', 'Maison Alhambra', 'Emper', 'Asdaaf', 'Al Wataniah', 'Surrati', 'Zahoor Al Madina'],
    'Nicho': ['Amouage', 'Creed', 'Maison Francis Kurkdjian', 'Byredo', 'Le Labo', 'Nishane', 'Initio', 'Xerjoff', 'Orto Parisi', 'Memo Paris', 'Mancera', 'Montale', 'By Kilian', 'Diptyque', 'Serge Lutens', 'Penhaligon\'s', 'Nasomatto', 'Acqua di Parma', 'Histoires de Parfums', 'Juliette Has a Gun'],
    'Diseñador': ['Dior', 'Chanel', 'Tom Ford', 'YSL', 'Givenchy', 'Paco Rabanne', 'Versace', 'Dolce & Gabbana', 'Burberry', 'Gucci', 'Valentino', 'Armani', 'Hugo Boss', 'Calvin Klein', 'Davidoff', 'Jean Paul Gaultier', 'Issey Miyake', 'Hermès', 'Thierry Mugler', 'Carolina Herrera', 'Viktor & Rolf', 'Narciso Rodriguez', 'Cartier', 'Bulgari', 'Montblanc', 'Lacoste', 'Ralph Lauren'],
  },

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
    const esPhone = ['iphone','android'].includes(p.cat);
    const cantidadDeclarada = p.cantidadDeclarada ?? p.cantidad ?? (esIMEI ? 0 : 1);
    const estadoProductoInicial = p.estadoProducto || (mode === 'new' ? 'Nuevo / Sellado' : '');
    // Cotización con la que trabaja el formulario. El campo de precio en USD y
    // el campo oculto de cotización TIENEN que usar la misma: al guardar se
    // recompone `precioARS = precioUSD × cotiz`, y si el precio en USD se
    // dibuja vacío mientras la cotización cae al blue, guardar deja el precio
    // en CERO sin avisar. Pasaba con cualquier producto con `cotizacion` NULL
    // o 0 en la base (`Number(null)` da 0 al cargar el stock).
    const cotizForm = p.cotiz || State.refBlue;
    const precioEnPesos = this.esPrecioEnPesos(p.cat);
    // El tamaño se lee del nombre, y la lista suma los que ya existan en el
    // stock para que no falte ninguno aunque no esté en ML_OPCIONES.
    const mlActual = this.esPerfume(p.cat) ? this.mlDe(p) : 0;
    const mlOpciones = [...new Set([...this.ML_OPCIONES, ...this.mlEnStock()])].sort((a, b) => a - b);
    const modelosCat = this.modelosParaCat(p.cat);
    const todosModelos = this.todosLosModelos();
    const modeloEsLibre = !!p.modelo && !modelosCat.includes(p.modelo);
    const modeloRepuestoLibre = !!p.modelo && !todosModelos.includes(p.modelo);

    host.innerHTML = `
      <div class="drawer-bg" style="position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;justify-content:flex-end;z-index:100" onclick="if(event.target===this) Stock.closeDrawer()">
        <div style="width:440px;max-width:94vw;background:var(--bg);border-left:1px solid var(--border);display:flex;flex-direction:column;height:100%" onclick="event.stopPropagation()">

          <div style="padding:16px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
            <h3 style="font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px"><i class="ti ${this.CAT_ICONS[p.cat]||'ti-box'}" style="color:var(--blue)" id="drawer-icon"></i> ${mode==='new'?'Agregar producto':'Editar producto'}</h3>
            <div style="display:flex;align-items:center;gap:6px">
              <button type="button" onclick="Stock.toggleDestacado()" id="destacado-btn" title="Destacar en catálogo" style="background:none;border:none;cursor:pointer;font-size:18px;color:${p.destacado?'#854F0B':'var(--text-secondary)'}"><i class="ti ti-star${p.destacado?'-filled':''}" id="destacado-icon"></i></button>
              <button class="btn btn-sm" onclick="Stock.closeDrawer()">✕</button>
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
                  <div class="hint" style="font-size:10px;color:var(--text-secondary);margin-top:4px" id="cantidad-hint">${esIMEI ? 'Para dispositivos con IMEI, la cantidad se determina por los IMEIs cargados (1 IMEI = 1 dispositivo).' : 'Cantidad de unidades que tenés.'}</div>
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
                    <input type="text" id="f-imei-input" placeholder="123456789012345" inputmode="numeric" style="flex:1;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;font-family:monospace" onkeydown="if(event.key==='Enter'){event.preventDefault();Stock.addImei();}">
                    <button type="button" class="btn btn-sm" onclick="Stock.addImei()" title="Agregar IMEI">+ Agregar</button>
                    <button type="button" id="imei-scan-btn" class="btn btn-sm" onclick="Stock.abrirEscaner()" title="Escanear código de barras" style="font-size:16px;padding:6px 10px;display:${esPhone?'inline-flex':'none'}">📷</button>
                  </div>
                  <div class="hint" style="font-size:10px;color:var(--text-secondary);margin-top:4px">Podés dejarlo vacío. Es independiente de la cantidad — vas completando IMEIs a medida que los identificás.</div>
                </div>

                <div id="f-serie-wrap" style="margin-bottom:12px;display:${p.cat==='mac'?'block':'none'}">
                  <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Número de Serie *</label>
                  <input type="text" id="f-numero-serie" value="${p.numeroSerie||''}" placeholder="C02ABC123XYZ" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;font-family:monospace">
                </div>

                <div id="f-modelo-wrap" style="display:${['iphone','android','mac','ipad','watch','audio'].includes(p.cat)?'block':'none'};margin-bottom:12px">
                  <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Modelo *</label>
                  <select id="f-modelo" onchange="Stock.toggleModeloOtro();Stock._actualizarSpecsDropdowns(this.value==='__otro__'?'':this.value)" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                    <option value="">Seleccionar modelo</option>
                    ${modelosCat.map(m => `<option value="${State.esc(m)}" ${p.modelo===m?'selected':''}>${State.esc(m)}</option>`).join('')}
                    <option value="__otro__" ${modeloEsLibre ? 'selected':''}>Otro (escribir)</option>
                  </select>
                  <input type="text" id="f-modelo-otro" value="${modeloEsLibre ? State.esc(p.modelo) : ''}" placeholder="Escribí el modelo" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;margin-top:6px;display:${modeloEsLibre ? 'block':'none'}">
                </div>

                <div id="f-nombre-libre-wrap" style="display:${this.esNombreLibre(p.cat)?'block':'none'};margin-bottom:12px">
                  <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Nombre ${p.cat==='herramienta'?'de la herramienta':p.cat==='repuesto'?'del repuesto':'del producto'} *</label>
                  <input type="text" id="f-nombre-libre" oninput="Stock.previewNombrePerfume()" value="${this.esNombreLibre(p.cat) ? State.esc(this.esPerfume(p.cat) ? this.nombreSinMl(p.nombre) : (p.nombre||'')) : ''}" placeholder="${this.placeholderNombre(p.cat)}" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                  <div id="f-nombre-preview" style="font-size:10px;margin-top:4px;display:none"></div>
                </div>

                <!-- CONTENIDO DEL COMBO — un ítem por renglón -->
                <div id="f-combo-wrap" style="display:${p.cat==='combo'?'block':'none'};margin-bottom:12px">
                  <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">¿Qué incluye el combo?</label>
                  <textarea id="f-combo-items" rows="4" placeholder="Un producto por renglón, por ejemplo:&#10;Decant Lattafa Asad 5ml&#10;Decant Dior Sauvage 5ml&#10;Armaf Club de Nuit 105ml" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;font-family:inherit;resize:vertical">${State.esc(p.comboItems||'')}</textarea>
                  <div class="hint" style="font-size:10px;color:var(--text-secondary);margin-top:3px">Se muestra como lista en la landing. Ojo: vender el combo <strong>no descuenta</strong> estos productos del stock, eso se hace a mano.</div>
                </div>

                <!-- CAMPOS ESPECÍFICOS DE PERFUMERÍA / DECANT -->
                <div id="f-perfume-wrap" style="display:${this.esPerfume(p.cat)?'block':'none'};margin-bottom:12px">
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
                    <div>
                      <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Categoría</label>
                      <select id="f-pf-cat" onchange="Stock.actualizarMarcasPerfume();Stock.previewNombrePerfume()" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                        <option value="">— Elegir —</option>
                        ${this.PERFUME_CATEGORIAS.map(c=>`<option ${p.color===c?'selected':''}>${c}</option>`).join('')}
                      </select>
                    </div>
                    <div>
                      <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Concentración</label>
                      <select id="f-pf-conc" onchange="Stock.previewNombrePerfume()" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                        <option value="">— Elegir —</option>
                        ${this.PERFUME_CONCENTRACIONES.map(c=>`<option ${p.storage===c?'selected':''}>${c}</option>`).join('')}
                      </select>
                    </div>
                  </div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                    <div>
                      <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Marca</label>
                      <select id="f-pf-marca" onchange="Stock.previewNombrePerfume()" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                        <option value="">— Elegir —</option>
                        ${Object.entries(this.marcasPerfumeria()).map(([grupo, marcas])=>
                          `<optgroup label="${State.esc(grupo)}">${marcas.map(m=>`<option value="${State.esc(m)}" ${p.modelo===m?'selected':''}>${State.esc(m)}</option>`).join('')}</optgroup>`
                        ).join('')}
                      </select>
                    </div>
                    <div>
                      <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Tamaño (ml)</label>
                      <select id="f-pf-ml" onchange="Stock.onMlChange();Stock.previewNombrePerfume()" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                        <option value="">— Elegir —</option>
                        ${mlOpciones.map(ml => `<option value="${ml}" ${ml === mlActual ? 'selected' : ''}>${State.esc(this.fmtMl(ml))} ml</option>`).join('')}
                        <option value="__otro__" ${mlActual && !mlOpciones.includes(mlActual) ? 'selected' : ''}>Otro (escribir)</option>
                      </select>
                      <input type="text" id="f-pf-ml-otro" inputmode="decimal" oninput="Stock.previewNombrePerfume()" placeholder="ej: 7,5" value="${mlActual && !mlOpciones.includes(mlActual) ? mlActual : ''}" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;margin-top:6px;display:${mlActual && !mlOpciones.includes(mlActual) ? 'block' : 'none'}">
                      <div class="hint" style="font-size:10px;color:var(--text-secondary);margin-top:3px">Se agrega solo al final del nombre.</div>
                    </div>
                  </div>
                </div>

                <div id="f-modelo-repuesto-wrap" style="display:${p.cat==='repuesto'?'block':'none'};margin-bottom:12px">
                  <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Modelo compatible <span style="font-weight:400;color:var(--text-secondary)">(opcional)</span></label>
                  <select id="f-modelo-repuesto" onchange="Stock.toggleModeloRepuestoOtro()" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                    <option value="">— Universal / sin modelo específico —</option>
                    <optgroup label="iPhone">
                      ${this.modelosParaCat('iphone').map(m => `<option value="${State.esc(m)}" ${p.modelo===m?'selected':''}>${State.esc(m)}</option>`).join('')}
                    </optgroup>
                    <optgroup label="Android / Otra marca">
                      ${this.modelosParaCat('android').map(m => `<option value="${State.esc(m)}" ${p.modelo===m?'selected':''}>${State.esc(m)}</option>`).join('')}
                    </optgroup>
                    <optgroup label="iPad / Mac">
                      ${[...this.modelosParaCat('ipad'), ...this.modelosParaCat('mac')].map(m => `<option value="${State.esc(m)}" ${p.modelo===m?'selected':''}>${State.esc(m)}</option>`).join('')}
                    </optgroup>
                    <option value="__otro__" ${modeloRepuestoLibre ? 'selected' : ''}>Otra marca / modelo (escribir)</option>
                  </select>
                  <input type="text" id="f-modelo-repuesto-otro" placeholder="ej: Samsung Galaxy A54, Motorola G84…" value="${modeloRepuestoLibre ? State.esc(p.modelo) : ''}" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;margin-top:6px;display:${modeloRepuestoLibre ? 'block' : 'none'}">
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

                <!-- El estado va para TODOS los rubros. Antes vivía adentro del bloque
                     de batería (solo iPhone/Android/iPad) y del de Mac, así que en
                     accesorios, perfumería, repuestos, audio y watch no había forma de
                     cargarlo: quedaban con el campo vacío, y tanto la pestaña
                     Nuevo/Usado de acá como la web pública los daban por usados. -->
                <div id="f-estado-wrap" style="margin-bottom:12px">
                  <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Estado del Producto *</label>
                  <select id="f-estado" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                    <option value="">Seleccionar</option>
                    ${this.ESTADO_OPCIONES.map(e=>`<option ${estadoProductoInicial===e?'selected':''}>${State.esc(e)}</option>`).join('')}
                  </select>
                </div>

                <div id="f-bateria-wrap" style="display:${['iphone','android','ipad'].includes(p.cat)?'block':'none'};margin-bottom:12px">
                  <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Batería %</label>
                  <input type="number" id="f-bateria" value="${p.bateriaPct??''}" placeholder="85" min="0" max="100" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
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
                  <input type="hidden" id="f-cotiz" value="${cotizForm}">
                </div>

                <div id="f-precio-usd-wrap" style="margin-bottom:12px;display:${precioEnPesos ? 'none' : 'block'}"><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Precio de Venta Sugerido (USD) *</label>
                  <input type="number" id="f-precio-usd" value="${p.precioARS ? (p.precioARS / cotizForm).toFixed(2) : ''}" placeholder="1000" oninput="Stock.updatePricePreview()" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                  <div class="hint" style="font-size:10px;color:var(--text-secondary);margin-top:3px" id="precio-ars-preview">${p.precioARS ? '≈ ' + State.fmtARS(p.precioARS) + ' a la cotización indicada — se precarga al crear una venta' : 'Se precargará al crear una venta'}</div>
                </div>

                <!-- Perfumería, decants y combos se venden EN PESOS: el precio se
                     carga tal cual y se publica tal cual, sin pasar por el dólar. -->
                <div id="f-precio-ars-wrap" style="margin-bottom:12px;display:${precioEnPesos ? 'block' : 'none'}"><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Precio de Venta (ARS) *</label>
                  <input type="text" inputmode="decimal" id="f-precio-ars" value="${p.precioARS ? State.esc(Math.round(p.precioARS).toLocaleString('es-AR')) : ''}" placeholder="85.800" oninput="Stock.updatePrecioARSPreview()" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                  <div class="hint" style="font-size:10px;color:var(--text-secondary);margin-top:3px" id="precio-usd-preview"></div>
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

            <div style="margin-bottom:12px">
              <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">🖼️ Imagen pública (URL)</label>
              <input type="url" id="f-imagen-url" value="${p.imagenUrl||''}" placeholder="https://…jpg" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px" oninput="Stock._previewImagen(this.value)">
              <div class="hint" style="font-size:10px;color:var(--text-secondary);margin-top:3px">Se muestra en la página pública de precios.</div>
              <div id="f-imagen-preview" style="margin-top:8px;display:${p.imagenUrl?'block':'none'}">
                <img src="${p.imagenUrl||''}" style="width:80px;height:80px;object-fit:contain;border-radius:8px;border:1px solid var(--border-strong)">
              </div>
            </div>

            ${mode === 'edit' ? `
              <div style="margin-top:6px">
                <div class="card-title" style="margin-bottom:8px"><i class="ti ti-history"></i> Historial de este producto</div>
                <div id="historial-producto-host" style="max-height:180px;overflow-y:auto"></div>
              </div>
            ` : ''}

          </div>
          <div style="padding:13px 18px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">
            ${mode === 'edit' ? `<button class="btn" style="color:var(--red);margin-right:auto" onclick="Stock.deleteProduct('${id}')">🗑️ Eliminar</button>` : ''}
            <button class="btn" onclick="Stock.closeDrawer()">Cancelar</button>
            <button class="btn btn-primary" onclick="Stock.save(${mode==='edit'?`'${id}'`:'null'})">✓ Guardar</button>
          </div>
        </div>
      </div>
    `;
    this.pendingImeis = [...(p.imeis || [])];
    this._destacado = !!p.destacado;
    this.renderImeiChips();
    setTimeout(() => {
      this.updatePricePreview();
      this.updatePrecioARSPreview();
      this.previewNombrePerfume();
      if (['iphone','android','mac','ipad'].includes(p.cat) && p.modelo && !['','__otro__'].includes(p.modelo)) {
        this._actualizarSpecsDropdowns(p.modelo, p.storage || '', p.color || '');
      }
    }, 0);
    if (mode === 'edit') this.renderHistorialProducto(id);
  },

  toggleModeloOtro() {
    const sel = document.getElementById('f-modelo');
    const otroInput = document.getElementById('f-modelo-otro');
    if (!sel || !otroInput) return;
    otroInput.style.display = sel.value === '__otro__' ? 'block' : 'none';
    this._actualizarSpecsDropdowns(sel.value === '__otro__' ? '' : sel.value);
  },

  _actualizarSpecsDropdowns(modelo, storageActual = '', colorActual = '') {
    const specs = this.specsParaModelo(modelo);
    const storageSel = document.getElementById('f-storage');
    const colorSel = document.getElementById('f-color');
    if (storageSel) {
      storageSel.innerHTML = '<option value="">Seleccionar</option>' +
        specs.s.map(s => `<option value="${State.esc(s)}" ${s === storageActual ? 'selected' : ''}>${State.esc(s)}</option>`).join('');
    }
    if (colorSel) {
      colorSel.innerHTML = '<option value="">Seleccionar color</option>' +
        specs.c.map(c => `<option value="${State.esc(c)}" ${c === colorActual ? 'selected' : ''}>${State.esc(c)}</option>`).join('') +
        '<option value="Otro">Otro</option>';
    }
  },

  // Muestra cómo va a quedar guardado el perfume y avisa si el nombre escrito
  // contradice a los campos elegidos. No bloquea: solo lo hace visible, con un
  // botón para dejarlo en el formato estándar de una.
  previewNombrePerfume() {
    const host = document.getElementById('f-nombre-preview');
    if (!host) return;
    const cat = document.getElementById('f-cat')?.value || '';
    if (!this.esPerfume(cat)) { host.style.display = 'none'; return; }

    const escrito = document.getElementById('f-nombre-libre')?.value || '';
    const marca   = document.getElementById('f-pf-marca')?.value || '';
    const conc    = document.getElementById('f-pf-conc')?.value || '';
    const ml      = this._mlDelFormulario();
    if (!escrito.trim()) { host.style.display = 'none'; return; }

    const finalNombre = [this.nombreSinMl(escrito), ml ? `${this.fmtMl(ml)}ml` : ''].filter(Boolean).join(' ');
    const estandar = this.nombreEstandarPerfume(this.productoPerfume(escrito, marca), marca, conc, ml);

    // El aviso que de verdad importa: el nombre dice una concentración y el
    // campo dice otra. Así nacieron dos perfumes distintos con el mismo nombre.
    const concNombre = this.concEnNombre(escrito);
    const avisos = [];
    if (concNombre && conc && concNombre.toLowerCase() !== conc.toLowerCase()) {
      avisos.push(`El nombre dice <b>${State.esc(concNombre)}</b> pero elegiste <b>${State.esc(conc)}</b>.`);
    }
    if (marca && !new RegExp('^\\s*' + this._escRegex(marca) + '\\b', 'i').test(escrito)) {
      avisos.push(`El nombre no empieza con la marca <b>${State.esc(marca)}</b>.`);
    }

    const yaEstandar = finalNombre.trim().toLowerCase() === estandar.trim().toLowerCase();
    host.style.display = 'block';
    host.innerHTML = `
      <div style="color:var(--text-secondary)">Se guarda como: <b style="color:var(--text)">${State.esc(finalNombre)}</b></div>
      ${avisos.length ? `<div style="color:var(--red);margin-top:3px">⚠️ ${avisos.join(' ')}</div>` : ''}
      ${!yaEstandar && estandar ? `<button type="button" onclick="Stock.aplicarFormatoPerfume()" style="margin-top:4px;background:none;border:none;padding:0;color:var(--blue);font-size:10px;cursor:pointer;text-decoration:underline">Usar formato estándar: ${State.esc(estandar)}</button>` : ''}`;
  },

  // Reescribe el campo de nombre con el formato estándar armado desde los
  // campos. El tamaño no se escribe acá: se pega solo al guardar.
  aplicarFormatoPerfume() {
    const inp = document.getElementById('f-nombre-libre');
    if (!inp) return;
    const marca = document.getElementById('f-pf-marca')?.value || '';
    const conc  = document.getElementById('f-pf-conc')?.value || '';
    inp.value = this.nombreEstandarPerfume(this.productoPerfume(inp.value, marca), marca, conc, 0);
    this.previewNombrePerfume();
  },

  // El tamaño tiene su campo libre para los frascos raros (7,5ml y demás):
  // sin esto, elegir "Otro" sería un callejón sin salida.
  onMlChange() {
    const sel = document.getElementById('f-pf-ml');
    const otro = document.getElementById('f-pf-ml-otro');
    if (!sel || !otro) return;
    otro.style.display = sel.value === '__otro__' ? 'block' : 'none';
    if (sel.value === '__otro__') otro.focus(); else otro.value = '';
  },

  // Tamaño elegido en el formulario, salga del desplegable o del campo libre.
  _mlDelFormulario() {
    const sel = document.getElementById('f-pf-ml')?.value || '';
    const val = sel === '__otro__'
      ? (document.getElementById('f-pf-ml-otro')?.value || '')
      : sel;
    const n = parseFloat(String(val).replace(',', '.'));
    return n > 0 ? n : 0;
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

  _previewImagen(url) {
    const wrap = document.getElementById('f-imagen-preview');
    if (!wrap) return;
    if (url) {
      wrap.style.display = 'block';
      // Convierte Google Drive al formato thumbnail directo
      let src = url;
      const m = url.match(/drive\.google\.com\/file\/d\/([^/?#]+)/) ||
                url.match(/drive\.google\.com\/open\?id=([^&]+)/) ||
                url.match(/drive\.google\.com\/uc\?.*id=([^&]+)/);
      if (m) src = `https://drive.google.com/thumbnail?id=${m[1]}&sz=w200`;
      wrap.querySelector('img').src = src;
    } else {
      wrap.style.display = 'none';
    }
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
    if (countEl) countEl.textContent = `(${this.pendingImeis.length} cargado${this.pendingImeis.length !== 1 ? 's' : ''})`;
    // La cantidad SOLO sube si hay más IMEIs que unidades declaradas (no puede
    // haber 3 IMEIs y 2 equipos). Nunca la baja: antes cargar el primer IMEI de
    // un lote de 5 dejaba la cantidad en 1 y se perdían 4 unidades en silencio,
    // justo el flujo que el texto de ayuda recomienda ("vas completando IMEIs a
    // medida que los identificás").
    const cantEl = document.getElementById('f-cantidad');
    if (cantEl) {
      const declarada = parseInt(cantEl.value, 10) || 0;
      if (this.pendingImeis.length > declarada) cantEl.value = this.pendingImeis.length;
    }
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

  _scanStream: null,
  _scanInterval: null,

  _loadZXing() {
    return new Promise((resolve, reject) => {
      if (window.ZXing) { resolve(window.ZXing); return; }
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/@zxing/library@0.20.0/umd/index.min.js';
      s.onload = () => resolve(window.ZXing);
      s.onerror = reject;
      document.head.appendChild(s);
    });
  },

  async _decodeImageConZXing(dataUrl) {
    const ZXing = await this._loadZXing();
    const reader = new ZXing.MultiFormatReader();
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = dataUrl; });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const luminance = new ZXing.RGBLuminanceSource(imageData.data, canvas.width, canvas.height);
    const binaryBitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminance));
    const result = reader.decode(binaryBitmap);
    return result.getText();
  },

  abrirEscaner() {
    const overlay = document.createElement('div');
    overlay.id = 'imei-scan-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:20px;box-sizing:border-box';
    overlay.innerHTML = `
      <div style="color:#fff;font-size:15px;font-weight:700;text-align:center">Escanear IMEI</div>
      <div id="imei-preview-wrap" style="display:none;position:relative;width:min(360px,90vw)">
        <img id="imei-preview-img" style="width:100%;border-radius:10px;display:block">
        <div id="imei-decode-status" style="margin-top:8px;text-align:center;color:#fff;font-size:13px"></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;align-items:center;width:min(360px,90vw)">
        <label style="display:flex;align-items:center;justify-content:center;gap:8px;padding:14px 24px;background:#00e0a0;color:#000;font-weight:700;font-size:15px;border-radius:10px;cursor:pointer;width:100%;box-sizing:border-box">
          📷 Sacar foto del código de barras
          <input type="file" accept="image/*" capture="environment" id="imei-foto-input" style="display:none" onchange="Stock._procesarFotoImei(this)">
        </label>
        <div style="color:#aaa;font-size:12px">— o ingresá manualmente —</div>
        <div style="display:flex;gap:8px;width:100%">
          <input id="imei-scan-manual" type="text" inputmode="numeric" placeholder="Escribí el IMEI..." style="flex:1;padding:10px 12px;border-radius:8px;border:none;font-size:14px;font-family:monospace;min-width:0">
          <button onclick="Stock._agregarImeiEscaneado(document.getElementById('imei-scan-manual').value)" style="padding:10px 14px;border-radius:8px;background:#00e0a0;color:#000;font-weight:700;border:none;cursor:pointer">✓ OK</button>
        </div>
      </div>
      <button onclick="Stock.cerrarEscaner()" style="padding:8px 24px;border-radius:8px;background:#555;color:#fff;border:none;cursor:pointer;font-size:14px">✕ Cerrar</button>
    `;
    document.body.appendChild(overlay);
  },

  async _procesarFotoImei(input) {
    const file = input.files[0];
    if (!file) return;
    const dataUrl = await new Promise(r => {
      const fr = new FileReader();
      fr.onload = e => r(e.target.result);
      fr.readAsDataURL(file);
    });

    const previewWrap = document.getElementById('imei-preview-wrap');
    const previewImg = document.getElementById('imei-preview-img');
    const statusEl = document.getElementById('imei-decode-status');
    if (previewImg) previewImg.src = dataUrl;
    if (previewWrap) previewWrap.style.display = 'block';
    if (statusEl) statusEl.textContent = 'Analizando imagen...';

    // Intentar primero con BarcodeDetector nativo (Chrome desktop/Android)
    if ('BarcodeDetector' in window) {
      try {
        const img = new Image();
        await new Promise(r => { img.onload = r; img.src = dataUrl; });
        const detector = new BarcodeDetector({ formats: ['code_128','ean_13','itf','qr_code','pdf417','code_39','aztec','data_matrix'] });
        const barcodes = await detector.detect(img);
        if (barcodes.length > 0) {
          const raw = barcodes[0].rawValue.replace(/\D/g, '');
          if (raw.length >= 14 && raw.length <= 16) { this._agregarImeiEscaneado(raw); return; }
        }
      } catch (_) {}
    }

    // Fallback: ZXing sobre la imagen estática
    try {
      if (statusEl) statusEl.textContent = 'Cargando decodificador...';
      const texto = await this._decodeImageConZXing(dataUrl);
      const raw = texto.replace(/\D/g, '');
      if (raw.length >= 14 && raw.length <= 16) {
        this._agregarImeiEscaneado(raw);
      } else {
        if (statusEl) statusEl.innerHTML = `<span style="color:#f90">No se encontró código de barras.<br>Intentá de nuevo más cerca o con mejor luz.</span>`;
      }
    } catch (err) {
      if (statusEl) statusEl.innerHTML = `<span style="color:#f90">No se pudo leer el código.<br>Intentá de nuevo o cargá el IMEI manualmente.</span>`;
    }
  },

  _agregarImeiEscaneado(valor) {
    const v = (valor || '').trim().replace(/\D/g, '');
    if (!v) { toast('Valor inválido'); return; }
    if (this.pendingImeis.includes(v)) { toast('Ese IMEI ya está cargado.'); return; }
    this.pendingImeis.push(v);
    this.renderImeiChips();
    this.cerrarEscaner();
    toast('✅ IMEI escaneado: ' + v);
  },

  cerrarEscaner() {
    clearInterval(this._scanInterval);
    this._scanInterval = null;
    if (this._scanStream) {
      this._scanStream.getTracks().forEach(t => t.stop());
      this._scanStream = null;
    }
    document.getElementById('imei-scan-overlay')?.remove();
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

  // En los rubros en pesos el precio es el dato principal; el dólar se muestra
  // solo como referencia para saber contra qué costo se está comparando.
  updatePrecioARSPreview() {
    const el = document.getElementById('precio-usd-preview');
    if (!el) return;
    const ars = this.parseARS(document.getElementById('f-precio-ars')?.value);
    const cotiz = parseFloat(document.getElementById('f-cotiz')?.value) || State.refBlue;
    el.textContent = ars
      ? `≈ ${State.fmtUSD(ars / cotiz)} a la cotización del producto — es el precio que ve el cliente en la web`
      : 'Se publica tal cual en la web, sin convertir por el dólar del día.';
  },

  toggleFields() {
    const cat = document.getElementById('f-cat')?.value;
    if (!cat) return;
    const esIMEI = this.CATS_IMEI.includes(cat);
    const tieneModeloFijo = ['iphone','android','mac','ipad','watch','audio'].includes(cat);
    const esLibre = this.esNombreLibre(cat);
    const tieneStorageColor = ['iphone','android','mac','ipad'].includes(cat);
    const tieneBateria = ['iphone','android','ipad'].includes(cat);
    const esMac = cat === 'mac';

    const set = (id, display) => { const el = document.getElementById(id); if (el) el.style.display = display; };
    set('f-imei-wrap', esIMEI ? 'block' : 'none');
    const esPhone = ['iphone','android'].includes(cat);
    const scanBtn = document.getElementById('imei-scan-btn');
    if (scanBtn) scanBtn.style.display = esPhone ? 'inline-flex' : 'none';
    set('f-serie-wrap', esMac ? 'block' : 'none');
    set('f-modelo-wrap', tieneModeloFijo ? 'block' : 'none');
    set('f-nombre-libre-wrap', esLibre ? 'block' : 'none');
    set('f-combo-wrap', cat === 'combo' ? 'block' : 'none');
    set('f-perfume-wrap', this.esPerfume(cat) ? 'block' : 'none');
    this.previewNombrePerfume();
    set('f-modelo-repuesto-wrap', cat === 'repuesto' ? 'block' : 'none');
    set('f-specs-grid', tieneStorageColor ? 'grid' : 'none');
    set('f-bateria-wrap', tieneBateria ? 'block' : 'none');
    set('f-mac-extra-wrap', esMac ? 'block' : 'none');
    set('f-caracteristicas-wrap', esIMEI ? 'block' : 'none');
    const enPesos = this.esPrecioEnPesos(cat);
    set('f-precio-usd-wrap', enPesos ? 'none' : 'block');
    set('f-precio-ars-wrap', enPesos ? 'block' : 'none');
    this.updatePrecioARSPreview();

    // Refrescar lista de modelos si cambió la categoría
    const modeloSelect = document.getElementById('f-modelo');
    if (modeloSelect && tieneModeloFijo) {
      const actual = modeloSelect.value;
      modeloSelect.innerHTML = `<option value="">Seleccionar modelo</option>` +
        this.modelosParaCat(cat).map(m=>`<option value="${State.esc(m)}" ${actual===m?'selected':''}>${State.esc(m)}</option>`).join('') +
        `<option value="__otro__">Otro (escribir)</option>`;
      if (tieneStorageColor) this._actualizarSpecsDropdowns(actual !== '__otro__' ? actual : '');
    }

    const cantidadHint = document.getElementById('cantidad-hint');
    if (cantidadHint) cantidadHint.textContent = esIMEI
      ? 'Cantidad de unidades que tenés, sepas o no todavía los IMEIs de cada una.'
      : 'Cantidad de unidades en stock.';
  },

  async save(id) {
    const saveBtn = document.querySelector('#stock-drawer-host button.btn-primary');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = 'Guardando...'; }
    const restoreBtn = () => { if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '✓ Guardar'; } };

    try {
    const cat = document.getElementById('f-cat').value;
    const esIMEI = this.CATS_IMEI.includes(cat);
    const tieneModeloFijo = ['iphone','android','mac','ipad','watch','audio'].includes(cat);
    const esLibre = this.esNombreLibre(cat);

    // Resolver el modelo (de la lista o "otro" escrito a mano)
    let modelo = '';
    let storage = '';
    let color = '';
    if (this.esPerfume(cat)) {
      modelo = document.getElementById('f-pf-marca')?.value || '';
      storage = document.getElementById('f-pf-conc')?.value || '';
      color = document.getElementById('f-pf-cat')?.value || '';
    } else if (tieneModeloFijo) {
      const modeloSel = document.getElementById('f-modelo')?.value || '';
      modelo = modeloSel === '__otro__' ? (document.getElementById('f-modelo-otro')?.value.trim() || '') : modeloSel;
      storage = document.getElementById('f-storage')?.value || '';
      color = document.getElementById('f-color')?.value || '';
    } else if (cat === 'repuesto') {
      const modeloSel = document.getElementById('f-modelo-repuesto')?.value || '';
      modelo = modeloSel === '__otro__' ? (document.getElementById('f-modelo-repuesto-otro')?.value.trim() || '') : modeloSel;
    } else {
      storage = document.getElementById('f-storage')?.value || '';
      color = document.getElementById('f-color')?.value || '';
    }
    const nombreLibre = esLibre ? (document.getElementById('f-nombre-libre')?.value.trim() || '') : '';

    if (tieneModeloFijo && !modelo) { toast('Seleccioná o escribí el modelo del producto.'); restoreBtn(); return; }
    if (esLibre && !nombreLibre) { toast('Completá el nombre del producto.'); restoreBtn(); return; }
    if (cat === 'mac' && !document.getElementById('f-numero-serie')?.value.trim()) { toast('Completá el número de serie.'); restoreBtn(); return; }

    // Armamos el nombre final que se muestra en toda la app
    // En perfumería el tamaño se guarda pegado al nombre ("Teriaq 100ml"):
    // es de ahí de donde la landing lo lee para agrupar los tamaños de un
    // mismo aroma. El usuario escribe el nombre sin el tamaño y lo elige aparte.
    let nombre = esLibre ? nombreLibre : [modelo, storage, color].filter(Boolean).join(' ');
    if (this.esPerfume(cat)) {
      const ml = this._mlDelFormulario();
      nombre = [this.nombreSinMl(nombre), ml ? `${this.fmtMl(ml)}ml` : ''].filter(Boolean).join(' ');
    }

    const costoUSD = parseFloat(document.getElementById('f-costo').value) || 0;
    const cotiz = parseFloat(document.getElementById('f-cotiz').value) || State.refBlue;
    // En perfumería/decant/combo el precio se carga EN PESOS y se guarda tal
    // cual. En el resto sigue siendo USD × cotización, como siempre.
    const enPesos = this.esPrecioEnPesos(cat);
    const precioUSD = parseFloat(document.getElementById('f-precio-usd')?.value) || 0;
    const precioARSDirecto = enPesos ? Math.round(this.parseARS(document.getElementById('f-precio-ars')?.value)) : 0;
    if (!nombre || !costoUSD) { toast('Completá los campos obligatorios: producto y costo.'); restoreBtn(); return; }

    const cantidadNueva = parseInt(document.getElementById('f-cantidad').value, 10) || 0;
    const precioReventa = parseFloat(document.getElementById('f-precio-reventa')?.value) || null;
    const precioMayorista = parseFloat(document.getElementById('f-precio-mayorista')?.value) || null;
    const costoReparacion = parseFloat(document.getElementById('f-costo-reparacion')?.value) || 0;
    const bateriaPct = document.getElementById('f-bateria')?.value ? parseInt(document.getElementById('f-bateria').value, 10) : null;
    const ciclosBateria = document.getElementById('f-ciclos')?.value ? parseInt(document.getElementById('f-ciclos').value, 10) : null;
    const ram = document.getElementById('f-ram')?.value || '';
    const estadoProducto = document.getElementById('f-estado')?.value || '';
    const grado = document.getElementById('f-grado')?.value || 'Sin grado';
    const estadoInventario = document.getElementById('f-estado-inventario')?.value || 'disponible';
    const esim = document.getElementById('f-esim')?.checked || false;
    const tieneCaja = document.getElementById('f-caja')?.checked || false;
    const numeroSerie = document.getElementById('f-numero-serie')?.value.trim() || '';

    const existing = id ? State.stock.find(x => x.id === id) : null;
    const cantidadAntes = existing ? this.stockReal(existing) : 0;

    const obj = {
      cat, nombre, costoUSD, cotiz,
      precioARS: enPesos ? precioARSDirecto : Math.round(precioUSD * cotiz),
      proveedor: document.getElementById('f-prov').value,
      custodio: document.getElementById('f-custodio').value,
      notas: document.getElementById('f-notas').value,
      precioReventa, precioMayorista, costoReparacion,
      cantidad: cantidadNueva, cantidadDeclarada: cantidadNueva,
      modelo, storage, color, bateriaPct, ciclosBateria, ram, estadoProducto, grado,
      esim, tieneCaja, numeroSerie, destacado: !!this._destacado, estadoInventario,
      imagenUrl: document.getElementById('f-imagen-url')?.value.trim() || '',
      // Solo tiene sentido en combos; en el resto se guarda vacío.
      comboItems: cat === 'combo' ? (document.getElementById('f-combo-items')?.value.trim() || '') : ''
    };
    // Siempre explícito: si un producto pasa de un rubro con IMEI a uno sin IMEI,
    // hay que borrar el array. Antes la clave no se tocaba, el array viejo
    // sobrevivía en memoria y getStock() seguía contando unidades fantasma hasta
    // recargar la página. (undefined es la convención para "rubro sin IMEI").
    obj.imeis = esIMEI ? [...this.pendingImeis] : undefined;

    toast('Guardando producto...');

    // Para dispositivos con IMEI en alta nueva: crear un registro por cada IMEI
    const imeisParaCrear = (!id && esIMEI && this.pendingImeis.length > 0) ? [...this.pendingImeis] : null;

    if (imeisParaCrear) {
      // Alta múltiple: un registro por IMEI
      const creados = [];
      const fallados = [];
      let ultimoMotivo = '';
      for (const imeiVal of imeisParaCrear) {
        const objImei = { ...obj, imeis: [imeiVal], cantidad: 1, cantidadDeclarada: 1 };
        const { id: newId, error, camposOmitidos } = await DB.guardarProductoStock(objImei, null);
        if (error) {
          console.error(error);
          ultimoMotivo = error.message || error.hint || '';
          fallados.push(imeiVal);
          continue;
        }
        objImei.id = newId;
        State.stock.push(objImei);
        await DB.registrarMovimientoStock(newId, 'alta', `Producto agregado: ${nombre} (IMEI: ${imeiVal})`, 0, 1);
        if (camposOmitidos?.length) this._avisarCamposOmitidos(camposOmitidos);
        Sheets.stock(objImei);
        creados.push(imeiVal);
      }
      // Si no entró ninguno, el drawer se queda abierto con todo cargado: antes
      // se cerraba igual avisando "0 dispositivos agregados" y se perdía la carga.
      if (!creados.length) {
        toast(ultimoMotivo
          ? `No se pudo agregar ningún dispositivo: ${ultimoMotivo}`
          : 'No se pudo agregar ningún dispositivo. Revisá la conexión e intentá de nuevo.');
        restoreBtn();
        return;
      }
      if (fallados.length) {
        // Los que sí entraron ya están guardados: sacamos de la lista los que
        // fallaron para que el usuario pueda reintentar solo con esos.
        this.pendingImeis = [...fallados];
        this.renderImeiChips();
        toast(`${creados.length} agregado(s). Quedaron sin guardar: ${fallados.join(', ')}.`);
        restoreBtn();
        this.renderKpis();
        this.renderTable();
        return;
      }
      toast(`${creados.length} dispositivo${creados.length !== 1 ? 's' : ''} agregado${creados.length !== 1 ? 's' : ''} al stock.`);
    } else {
      // Alta simple o edición
      const { id: newId, error, camposOmitidos } = await DB.guardarProductoStock(obj, id);
      if (camposOmitidos?.length) this._avisarCamposOmitidos(camposOmitidos);
      if (error) {
        // Mostrar el motivo real (ej: el candado de IMEI duplicado de la base)
        // en vez de un mensaje genérico que no dice qué corregir.
        const motivo = error.message || error.hint || '';
        toast(motivo ? `No se pudo guardar: ${motivo}` : 'Hubo un problema guardando el producto.');
        console.error(error);
        restoreBtn();
        return;
      }

      const finalId = id || newId;
      const cantidadDespues = this.stockReal(obj);

      if (id) {
        const idx = State.stock.findIndex(x => x.id === id);
        if (idx >= 0) State.stock[idx] = { ...State.stock[idx], ...obj };
        else State.stock.push({ ...obj, id: finalId });
        await DB.registrarMovimientoStock(finalId, 'edicion', `Producto editado: ${nombre}`, cantidadAntes, cantidadDespues);
        toast('Producto actualizado.');
      } else {
        obj.id = newId;
        State.stock.push(obj);
        await DB.registrarMovimientoStock(finalId, 'alta', `Producto agregado: ${nombre}`, 0, cantidadDespues);
        toast('Producto agregado al stock.');
      }
      Sheets.stock(obj);
    }

    this.closeDrawer();
    this.renderKpis();
    this.renderTable();
    } catch (err) {
      console.error('Error al guardar producto:', err);
      toast('Error al guardar. Revisá la conexión e intentá de nuevo.');
      restoreBtn();
    }
  },

  // Nombres lindos para avisar qué no se pudo guardar cuando la base todavía no
  // tiene alguna columna nueva.
  CAMPO_LABEL: {
    precio_reventa:'precio de reventa', precio_mayorista:'precio mayorista',
    costo_reparacion:'costo de reparación', bateria_pct:'batería %',
    ciclos_bateria:'ciclos de batería', ram:'RAM', esim:'eSIM', tiene_caja:'tiene caja',
    numero_serie:'número de serie', destacado:'destacado', imagen_url:'imagen',
    combo_items:'contenido del combo',
  },
  _avisarCamposOmitidos(campos) {
    const nombres = campos.map(c => this.CAMPO_LABEL[c] || c);
    toast(`⚠️ Se guardó, pero la base no aceptó: ${nombres.join(', ')}. Falta correr la migración.`);
  },

  async deleteProduct(id) {
    const p = State.stock.find(x => x.id === id);
    if (!p) return;
    if (!confirm(`¿Eliminar "${p.nombre}" del stock? Esta acción no se puede deshacer.`)) return;
    // El movimiento se registra ANTES del borrado: después, el producto ya no
    // existe y la fila del historial queda huérfana o la rechaza la base.
    // Antes eliminar no dejaba ningún rastro de quién ni cuándo.
    const unidades = this.stockReal(p);
    const detalle = [
      `Producto eliminado: ${p.nombre}`,
      unidades ? `${unidades} unidad(es) dadas de baja` : null,
      (p.imeis || []).length ? `IMEIs: ${p.imeis.join(', ')}` : null,
    ].filter(Boolean).join(' · ');
    await DB.registrarMovimientoStock(id, 'baja', detalle, unidades, 0);
    await DB.eliminarProductoStock(id);
    State.stock = State.stock.filter(x => x.id !== id);
    this.closeDrawer();
    this.renderKpis();
    this.renderTable();
    toast('Producto eliminado del stock.');
  },

  closeDrawer() { document.getElementById('stock-drawer-host').innerHTML = ''; },

  async separarUnidades(id) {
    const p = State.stock.find(x => x.id === id);
    if (!p) return;
    const cant = this.stockReal(p);
    if (cant < 2) return toast('Este producto ya tiene una sola unidad.');

    const confirmar = confirm(
      `¿Separar "${p.nombre}" en ${cant} unidades individuales?\n\n` +
      `Se crearán ${cant} filas independientes (1 unidad cada una) y se eliminará el lote actual.\n` +
      `Luego podés editar cada una para agregar IMEI, batería o color distinto.`
    );
    if (!confirmar) return;

    toast('Separando unidades...');
    // Los IMEIs ya identificados se reparten de a uno entre las unidades nuevas.
    // Antes todas se creaban con imeis:[] y, como después se borra el lote
    // original, los IMEIs cargados desaparecían para siempre.
    const imeisOriginales = [...(p.imeis || [])];
    const creadas = [];
    try {
      for (let i = 1; i <= cant; i++) {
        const imeiUnidad = imeisOriginales[i - 1] ? [imeisOriginales[i - 1]] : [];
        const nueva = {
          ...p,
          id: undefined,
          cantidad: 1,
          cantidadDeclarada: 1,
          imeis: this.CATS_IMEI.includes(p.cat) ? imeiUnidad : undefined,
          notas: p.notas ? `${p.notas} (unidad ${i}/${cant})` : `Unidad ${i}/${cant}`,
        };
        const { id: newId, error } = await DB.guardarProductoStock(nueva, null);
        if (error) { toast(`Error creando unidad ${i}.`); console.error(error); continue; }
        nueva.id = newId;
        State.stock.push(nueva);
        creadas.push(newId);
        await DB.registrarMovimientoStock(newId, 'alta',
          `Separado de lote: ${p.nombre} (unidad ${i}/${cant})${imeiUnidad.length ? ` — IMEI ${imeiUnidad[0]}` : ''}`, 0, 1);
      }

      // Si no se pudo crear ninguna, NO se borra el lote: mejor dejar todo como
      // estaba que quedarse sin el lote y sin las unidades.
      if (!creadas.length) {
        toast('No se pudo crear ninguna unidad. El lote quedó como estaba.');
        return;
      }

      // Si solo entraron algunas, el lote NO se borra: se le descuenta lo que ya
      // salió como unidad suelta y se queda con los IMEIs que no se repartieron.
      // Borrarlo entero acá haría desaparecer las unidades que fallaron.
      if (creadas.length < cant) {
        const restantes = cant - creadas.length;
        const imeisRestantes = imeisOriginales.slice(creadas.length);
        await DB.registrarMovimientoStock(id, 'ajuste_cantidad',
          `Separación parcial: salieron ${creadas.length} unidad(es), quedan ${restantes} en el lote`, cant, restantes);
        if (p.imeis) { p.imeis = imeisRestantes; await DB.actualizarImeisStock(id, imeisRestantes); }
        p.cantidad = restantes;
        p.cantidadDeclarada = restantes;
        await DB.actualizarCantidadStock(id, restantes);
        toast(`⚠️ Se separaron ${creadas.length} de ${cant}. El resto quedó en el lote original.`);
        return;
      }

      // El movimiento del lote original va ANTES del borrado: después el
      // producto ya no existe y la base rechaza (o deja huérfana) esa fila.
      await DB.registrarMovimientoStock(id, 'ajuste_cantidad',
        `Lote separado en ${creadas.length} unidades individuales${imeisOriginales.length ? ` (IMEIs repartidos: ${imeisOriginales.join(', ')})` : ''}`,
        cant, 0);
      await DB.eliminarProductoStock(id);
      State.stock = State.stock.filter(x => x.id !== id);

      toast(`✅ ${creadas.length} unidades creadas. Editá cada una para agregar sus detalles.`);
    } catch (err) {
      console.error('Error al separar unidades:', err);
      toast('Hubo un error al separar. Intentá de nuevo.');
    } finally {
      // En finally para que también repinte cuando se corta antes por una
      // separación parcial: ahí ya hay unidades nuevas que mostrar.
      this.renderKpis();
      this.renderTable();
    }
  },

  // Intenta hacer coincidir un nombre libre con los modelos oficiales (case-insensitive)
  _normalizarModelo(nombre) {
    if (!nombre) return nombre;
    const todos = Object.values(this.MODELOS_POR_CAT).flat();
    const match = todos.find(m => m.toLowerCase() === nombre.toLowerCase().trim());
    return match || nombre;
  },

  exportarExcel() {
    if (typeof XLSX === 'undefined') { toast('No se pudo cargar el módulo de exportación. Revisá tu conexión a internet.'); return; }

    // Se exporta lo que estás viendo (grupo + filtros aplicados). Antes salía
    // siempre el inventario entero, sin importar cómo hubieras filtrado.
    const filtrados = this._ultimosFiltrados?.length ? this._ultimosFiltrados : State.stock;
    const filas = filtrados.map(p => {
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
    toast(`Inventario exportado a Excel (${filas.length} producto/s).`);
  }
};


window.Stock = Stock;
