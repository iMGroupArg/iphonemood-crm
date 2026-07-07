// ============================================================
// CUENTA CORRIENTE — deudas y cobros
// ============================================================

const CuentaCorriente = {
  _vista: 'lista',      // 'lista' | 'detalle'
  _clienteActual: null, // { key, nombre, tel, ventasAbiertas, deudasManuales }

  isMobile() { return window.innerWidth <= 768; },

  // ── Helpers de cálculo ───────────────────────────────────────────────────────

  saldoVenta(v) {
    const total  = v.items.reduce((s, i) => s + i.precio, 0);
    const pagado = v.pagos.reduce((s, p) => s + p.monto, 0);
    return Math.max(0, total - pagado);
  },

  saldoDeuda(d) { return Math.max(0, d.monto - d.montoPagado); },

  toUSD(monto, moneda) {
    if (moneda === 'ARS') return monto / (State.refBlue || 1);
    return monto; // USD o USDT ya están en USD
  },

  totalSaldoCliente(c) {
    return c.ventasAbiertas.reduce((s, v) => s + this.saldoVenta(v), 0)
         + c.deudasManuales.filter(d => d.estado === 'activa')
             .reduce((s, d) => s + this.toUSD(this.saldoDeuda(d), d.moneda), 0);
  },

  antiguedadDias(v) {
    const d = new Date(v.fechaISO || v.fecha);
    return Math.floor((Date.now() - d) / 86400000);
  },

  // Agrupa ventas abiertas + deudas manuales por cliente (key = tel || nombre)
  getClientesConDeuda() {
    const map = {};

    const key = (nombre, tel) => tel ? `tel:${tel}` : `nom:${nombre}`;

    // Ventas con saldo pendiente
    (State.ventas || []).forEach(v => {
      if (v.estado === 'cerrada') return;
      const saldo = this.saldoVenta(v);
      if (saldo <= 0) return;
      const k = key(v.cliente, v.clienteTel);
      if (!map[k]) map[k] = { key: k, nombre: v.cliente, tel: v.clienteTel, ventasAbiertas: [], deudasManuales: [] };
      map[k].ventasAbiertas.push(v);
    });

    // Deudas manuales activas
    (State.deudas || []).forEach(d => {
      if (d.estado !== 'activa') return;
      if (this.saldoDeuda(d) <= 0) return;
      const k = key(d.cliente, d.clienteTel);
      if (!map[k]) map[k] = { key: k, nombre: d.cliente, tel: d.clienteTel, ventasAbiertas: [], deudasManuales: [] };
      map[k].deudasManuales.push(d);
    });

    return Object.values(map).sort((a, b) => this.totalSaldoCliente(b) - this.totalSaldoCliente(a));
  },

  totalCuentasPorCobrar() {
    return this.getClientesConDeuda().reduce((s, c) => s + this.totalSaldoCliente(c), 0);
  },

  // ── Render principal ─────────────────────────────────────────────────────────

  render() {
    const host = document.createElement('div');
    host.id = 'cc-view-host';
    host.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;min-height:0';
    host.appendChild(this._vista === 'detalle' && this._clienteActual
      ? this._renderDetalle()
      : this._renderLista());
    return host;
  },

  // ── Vista lista ───────────────────────────────────────────────────────────────

  _renderLista() {
    const clientes = this.getClientesConDeuda();
    const totalCC  = clientes.reduce((s, c) => s + this.totalSaldoCliente(c), 0);
    const mob      = this.isMobile();

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;min-height:0';

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'padding:16px 16px 0;display:flex;align-items:center;gap:10px;flex-shrink:0';
    const headerTxt = document.createElement('div');
    headerTxt.style.cssText = 'flex:1';
    headerTxt.innerHTML = `
      <h2 style="font-size:${mob?'18px':'20px'};font-weight:700;margin:0">Cuenta Corriente</h2>
      <div style="font-size:13px;color:var(--text-secondary);margin-top:2px">${clientes.length} cliente${clientes.length !== 1 ? 's' : ''} con saldo pendiente</div>`;
    const btnNuevaDeuda = document.createElement('button');
    btnNuevaDeuda.style.cssText = `display:flex;align-items:center;gap:6px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius);padding:${mob?'8px 12px':'9px 16px'};font-size:14px;font-weight:600;cursor:pointer`;
    btnNuevaDeuda.innerHTML = `<i class="ti ti-plus"></i>${mob ? '' : ' Deuda manual'}`;
    btnNuevaDeuda.addEventListener('click', () => this.openNuevaDeuda());
    header.appendChild(headerTxt);
    header.appendChild(btnNuevaDeuda);
    wrap.appendChild(header);

    // KPIs
    const kpis = document.createElement('div');
    kpis.style.cssText = `display:flex;gap:${mob?'8px':'12px'};padding:12px 16px;flex-shrink:0`;
    kpis.innerHTML = `
      <div style="flex:1;background:var(--bg-elevated);border-radius:var(--radius);padding:${mob?'10px':'14px'};border:1px solid var(--border)">
        <div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px">Total a cobrar</div>
        <div style="font-size:${mob?'18px':'22px'};font-weight:700;color:var(--amber)">USD ${totalCC.toFixed(2)}</div>
      </div>
      <div style="flex:1;background:var(--bg-elevated);border-radius:var(--radius);padding:${mob?'10px':'14px'};border:1px solid var(--border)">
        <div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px">Clientes</div>
        <div style="font-size:${mob?'18px':'22px'};font-weight:700">${clientes.length}</div>
      </div>
      <div style="flex:1;background:var(--bg-elevated);border-radius:var(--radius);padding:${mob?'10px':'14px'};border:1px solid var(--border)">
        <div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px">Ventas abiertas</div>
        <div style="font-size:${mob?'18px':'22px'};font-weight:700">${clientes.reduce((s,c)=>s+c.ventasAbiertas.length,0)}</div>
      </div>`;
    wrap.appendChild(kpis);

    // Contenido
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow-y:auto;min-height:0;padding:0 16px 24px';

    if (!clientes.length) {
      body.innerHTML = `<div style="text-align:center;padding:60px 20px;color:var(--text-secondary)"><i class="ti ti-check-circle" style="font-size:40px;display:block;margin-bottom:8px"></i>No hay deudas pendientes</div>`;
    } else if (mob) {
      clientes.forEach(c => body.appendChild(this._cardCliente(c)));
    } else {
      body.appendChild(this._tablaClientes(clientes));
    }
    wrap.appendChild(body);
    return wrap;
  },

  _cardCliente(c) {
    const saldo = this.totalSaldoCliente(c);
    const dias  = c.ventasAbiertas.length ? Math.max(...c.ventasAbiertas.map(v => this.antiguedadDias(v))) : 0;
    const color = dias > 30 ? 'var(--red)' : dias > 15 ? 'var(--amber)' : 'var(--text-secondary)';

    const el = document.createElement('div');
    el.style.cssText = 'background:var(--bg-elevated);border-radius:var(--radius);padding:14px;border:1px solid var(--border);margin-bottom:8px;cursor:pointer';
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-weight:600;font-size:15px">${c.nombre}</div>
          ${c.tel ? `<div style="font-size:12px;color:var(--text-secondary)">${c.tel}</div>` : ''}
        </div>
        <div style="text-align:right">
          <div style="font-weight:700;font-size:16px;color:var(--amber)">USD ${saldo.toFixed(2)}</div>
          ${dias > 0 ? `<div style="font-size:11px;color:${color}">${dias}d atraso</div>` : ''}
        </div>
      </div>
      <div style="margin-top:8px;display:flex;gap:6px;font-size:12px">
        ${c.ventasAbiertas.length ? `<span style="background:var(--bg);border:1px solid var(--border);border-radius:20px;padding:2px 8px">${c.ventasAbiertas.length} venta${c.ventasAbiertas.length>1?'s':''}</span>` : ''}
        ${c.deudasManuales.length ? `<span style="background:var(--bg);border:1px solid var(--border);border-radius:20px;padding:2px 8px">${c.deudasManuales.length} deuda${c.deudasManuales.length>1?'s':''}</span>` : ''}
      </div>`;
    el.addEventListener('click', () => this.verDetalle(c));
    return el;
  },

  _tablaClientes(clientes) {
    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:14px';
    table.innerHTML = `<thead>
      <tr style="border-bottom:1px solid var(--border)">
        <th style="padding:10px 8px;text-align:left;font-size:12px;color:var(--text-secondary);font-weight:600">CLIENTE</th>
        <th style="padding:10px 8px;text-align:left;font-size:12px;color:var(--text-secondary);font-weight:600">CONTACTO</th>
        <th style="padding:10px 8px;text-align:center;font-size:12px;color:var(--text-secondary);font-weight:600">VENTAS</th>
        <th style="padding:10px 8px;text-align:right;font-size:12px;color:var(--text-secondary);font-weight:600">SALDO USD</th>
        <th style="padding:10px 8px;text-align:center;font-size:12px;color:var(--text-secondary);font-weight:600">ANTIGÜEDAD</th>
        <th style="padding:10px 8px;text-align:right;font-size:12px;color:var(--text-secondary);font-weight:600"></th>
      </tr>
    </thead><tbody id="cc-tbody"></tbody>`;

    const tbody = table.querySelector('#cc-tbody');
    clientes.forEach(c => {
      const saldo = this.totalSaldoCliente(c);
      const dias  = c.ventasAbiertas.length ? Math.max(...c.ventasAbiertas.map(v => this.antiguedadDias(v))) : 0;
      const color = dias > 30 ? 'var(--red)' : dias > 15 ? 'var(--amber)' : 'var(--text-secondary)';
      const tr = document.createElement('tr');
      tr.style.cssText = 'border-bottom:1px solid var(--border);cursor:pointer;transition:background .1s';
      tr.onmouseover  = () => tr.style.background = 'var(--bg-elevated)';
      tr.onmouseout   = () => tr.style.background = '';
      tr.innerHTML = `
        <td style="padding:12px 8px;font-weight:600">${c.nombre}</td>
        <td style="padding:12px 8px;color:var(--text-secondary)">${c.tel || '—'}</td>
        <td style="padding:12px 8px;text-align:center">${c.ventasAbiertas.length + c.deudasManuales.length}</td>
        <td style="padding:12px 8px;text-align:right;font-weight:700;color:var(--amber)">USD ${saldo.toFixed(2)}</td>
        <td style="padding:12px 8px;text-align:center;color:${color}">${dias > 0 ? `${dias}d` : '—'}</td>
        <td style="padding:12px 8px;text-align:right">
          <button data-k="${c.key}" class="cc-ver-btn" style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 12px;font-size:12px;cursor:pointer">Ver</button>
        </td>`;
      tbody.appendChild(tr);
    });

    table.querySelectorAll('.cc-ver-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const c = clientes.find(x => x.key === btn.dataset.k);
        if (c) this.verDetalle(c);
      });
    });
    table.querySelectorAll('tr[style]').forEach((tr, i) => {
      tr.addEventListener('click', () => this.verDetalle(clientes[i]));
    });

    return table;
  },

  // ── Vista detalle ────────────────────────────────────────────────────────────

  verDetalle(c) {
    this._clienteActual = c;
    this._vista = 'detalle';
    this._rerender();
  },

  _renderDetalle() {
    const c   = this._clienteActual;
    const mob = this.isMobile();
    const saldoTotal = this.totalSaldoCliente(c);

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;min-height:0';

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'padding:16px;display:flex;align-items:center;gap:12px;flex-shrink:0;border-bottom:1px solid var(--border)';

    const btnBack = document.createElement('button');
    btnBack.style.cssText = 'background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;color:var(--text);font-size:14px;padding:6px 12px;display:flex;align-items:center;gap:6px;font-family:var(--font);flex-shrink:0';
    btnBack.innerHTML = '<i class="ti ti-arrow-left"></i> Volver';
    btnBack.addEventListener('click', () => {
      this._vista = 'lista';
      this._clienteActual = null;
      this._rerender();
    });
    header.appendChild(btnBack);

    const headerInfo = document.createElement('div');
    headerInfo.style.cssText = 'flex:1;min-width:0;display:flex;align-items:center;gap:8px';
    const headerTexts = document.createElement('div');
    headerTexts.style.cssText = 'min-width:0';
    headerTexts.innerHTML = `
      <div style="font-weight:700;font-size:${mob?'16px':'18px'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.nombre}</div>
      ${c.tel ? `<div style="font-size:12px;color:var(--text-secondary)">${c.tel}</div>` : ''}`;
    const btnEditar = document.createElement('button');
    btnEditar.title = 'Editar nombre';
    btnEditar.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:16px;padding:4px;display:flex;align-items:center;flex-shrink:0';
    btnEditar.innerHTML = '<i class="ti ti-pencil"></i>';
    btnEditar.addEventListener('click', () => this.openEditarCliente(c));
    headerInfo.appendChild(headerTexts);
    headerInfo.appendChild(btnEditar);
    header.appendChild(headerInfo);

    const headerSaldo = document.createElement('div');
    headerSaldo.style.cssText = 'text-align:right;flex-shrink:0';
    headerSaldo.innerHTML = `
      <div style="font-size:${mob?'18px':'20px'};font-weight:700;color:var(--amber)">USD ${saldoTotal.toFixed(2)}</div>
      <div style="font-size:11px;color:var(--text-secondary)">saldo total</div>`;
    header.appendChild(headerSaldo);
    wrap.appendChild(header);

    // Acciones
    const acciones = document.createElement('div');
    acciones.style.cssText = 'padding:12px 16px;display:flex;gap:8px;flex-shrink:0;flex-wrap:wrap;border-bottom:1px solid var(--border)';

    const btnPago = document.createElement('button');
    btnPago.style.cssText = 'display:flex;align-items:center;gap:6px;background:var(--green);color:#000;border:none;border-radius:var(--radius);padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer';
    btnPago.innerHTML = '<i class="ti ti-cash"></i> Registrar pago';
    btnPago.addEventListener('click', () => this.openRegistrarPago(c));
    acciones.appendChild(btnPago);

    const btnDeuda = document.createElement('button');
    btnDeuda.style.cssText = 'display:flex;align-items:center;gap:6px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer';
    btnDeuda.innerHTML = '<i class="ti ti-plus"></i> Deuda manual';
    btnDeuda.addEventListener('click', () => this.openNuevaDeuda(c));
    acciones.appendChild(btnDeuda);

    if (c.tel) {
      const btnWapp = document.createElement('button');
      btnWapp.style.cssText = 'display:flex;align-items:center;gap:6px;background:#25d366;color:#fff;border:none;border-radius:var(--radius);padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer';
      btnWapp.innerHTML = `<i class="ti ti-brand-whatsapp"></i>${mob ? '' : ' WhatsApp'}`;
      btnWapp.addEventListener('click', () => this._enviarWhatsapp(c, saldoTotal));
      acciones.appendChild(btnWapp);
    }
    wrap.appendChild(acciones);

    // Cuerpo scrolleable
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow-y:auto;min-height:0;padding:0 16px 24px';

    // Ventas abiertas
    if (c.ventasAbiertas.length) {
      body.appendChild(this._seccion('Ventas abiertas', c.ventasAbiertas.map(v => this._cardVenta(v)).join('')));
    }

    // Deudas manuales
    if (c.deudasManuales.length) {
      body.appendChild(this._seccion('Deudas manuales', c.deudasManuales.map(d => this._cardDeudaManual(d)).join('')));
    }

    // Historial de pagos en deudas manuales
    const pagosDeudas = (State.deudaPagos || []).filter(p =>
      c.deudasManuales.some(d => d.id === p.deudaId)
    );
    const pagosVentas = c.ventasAbiertas.flatMap(v => v.pagos.map(p => ({ ...p, ventaId: v.id, fecha: v.fecha })));

    if (pagosDeudas.length + pagosVentas.length > 0) {
      const items = [
        ...pagosVentas.map(p => `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px">
          <div><span style="color:var(--text-secondary)">Venta #${p.ventaId}</span> · ${p.persona} · ${p.bolsillo}</div>
          <div style="font-weight:600;color:var(--green)">+USD ${p.monto.toFixed(2)}</div>
        </div>`),
        ...pagosDeudas.map(p => `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px">
          <div><span style="color:var(--text-secondary)">${p.fecha}</span> · ${p.persona || ''} · ${p.bolsillo || ''}</div>
          <div style="font-weight:600;color:var(--green)">+${p.moneda} ${p.monto.toFixed(2)}</div>
        </div>`)
      ];
      body.appendChild(this._seccion('Historial de pagos', items.join('')));
    }

    // Botones de comprobante en ventas (eventos directos sin setTimeout)
    wrap.querySelectorAll('[data-comprobante]').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = c.ventasAbiertas.find(x => x.id === Number(btn.dataset.comprobante));
        if (v) this.generarComprobante(v, c);
      });
    });

    wrap.appendChild(body);
    return wrap;
  },

  _seccion(titulo, html) {
    const el = document.createElement('div');
    el.style.cssText = 'margin-top:16px';
    el.innerHTML = `<div style="font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">${titulo}</div>${html}`;
    return el;
  },

  _cardVenta(v) {
    const total  = v.items.reduce((s, i) => s + i.precio, 0);
    const pagado = v.pagos.reduce((s, p) => s + p.monto, 0);
    const saldo  = Math.max(0, total - pagado);
    const dias   = this.antiguedadDias(v);
    const color  = dias > 30 ? 'var(--red)' : dias > 15 ? 'var(--amber)' : 'var(--text-secondary)';
    return `
      <div style="background:var(--bg-elevated);border-radius:var(--radius);padding:12px;border:1px solid var(--border);margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-weight:600;font-size:14px">Venta #${v.id}</div>
            <div style="font-size:12px;color:var(--text-secondary)">${v.fecha} · ${v.items.map(i=>i.nombre).join(', ')}</div>
          </div>
          <div style="text-align:right">
            <div style="font-weight:700;color:var(--amber)">USD ${saldo.toFixed(2)}</div>
            <div style="font-size:11px;color:${color}">${dias}d</div>
          </div>
        </div>
        <div style="margin-top:8px;display:flex;gap:6px;font-size:12px;justify-content:space-between;align-items:center">
          <span style="color:var(--text-secondary)">Total: USD ${total.toFixed(2)} · Pagado: USD ${pagado.toFixed(2)}</span>
          <button data-comprobante="${v.id}" style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 10px;font-size:11px;cursor:pointer;display:flex;align-items:center;gap:4px"><i class="ti ti-file-text" style="font-size:13px"></i>Comprobante</button>
        </div>
      </div>`;
  },

  _cardDeudaManual(d) {
    const saldo    = this.saldoDeuda(d);
    const saldoUSD = this.toUSD(saldo, d.moneda);
    const esARS    = d.moneda === 'ARS';
    return `
      <div style="background:var(--bg-elevated);border-radius:var(--radius);padding:12px;border:1px solid var(--border);margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-weight:600;font-size:14px">${d.descripcion}</div>
            ${d.concepto ? `<div style="font-size:12px;color:var(--text-secondary)">${d.concepto}</div>` : ''}
          </div>
          <div style="text-align:right">
            <div style="font-weight:700;color:var(--amber)">${d.moneda} ${saldo.toLocaleString('es-AR', {maximumFractionDigits:2})}</div>
            ${esARS ? `<div style="font-size:11px;color:var(--text-secondary)">≈ USD ${saldoUSD.toFixed(2)}</div>` : ''}
            <div style="font-size:11px;color:var(--text-secondary)">${d.moneda} ${d.monto.toLocaleString('es-AR', {maximumFractionDigits:2})} total</div>
          </div>
        </div>
        ${d.notas ? `<div style="margin-top:6px;font-size:12px;color:var(--text-secondary)">${d.notas}</div>` : ''}
      </div>`;
  },

  _enviarWhatsapp(c, saldoTotal) {
    const msg = encodeURIComponent(
      `Hola ${c.nombre}! Te recordamos que tenés un saldo pendiente de USD ${saldoTotal.toFixed(2)} con iPhoneMood. Cualquier consulta estamos a disposición!`
    );
    window.open(`https://wa.me/${(c.tel || '').replace(/\D/g, '')}?text=${msg}`, '_blank');
  },

  // ── Modal: Editar nombre/teléfono del cliente ────────────────────────────────

  openEditarCliente(c) {
    const mob = this.isMobile();
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:400;display:flex;align-items:center;justify-content:center';

    const box = document.createElement('div');
    box.style.cssText = mob
      ? 'background:var(--bg-elevated);border-radius:16px;width:calc(100% - 32px);padding:24px'
      : 'background:var(--bg-elevated);border-radius:var(--radius-lg);width:400px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.4)';

    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <h3 style="margin:0;font-size:17px;font-weight:700">Editar cliente</h3>
        <button id="cc-edit-close" style="background:none;border:none;cursor:pointer;font-size:22px;color:var(--text-secondary);display:flex;align-items:center"><i class="ti ti-x"></i></button>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Nombre *</label>
          <input id="cc-edit-nombre" value="${c.nombre}" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:15px;box-sizing:border-box;font-family:var(--font)">
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Teléfono</label>
          <input id="cc-edit-tel" value="${c.tel || ''}" inputmode="tel" placeholder="Ej: 3413001234" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:15px;box-sizing:border-box;font-family:var(--font)">
        </div>
        <div id="cc-edit-error" style="display:none;color:var(--red);font-size:13px"></div>
        <button id="cc-edit-guardar" style="background:var(--blue);color:#fff;border:none;border-radius:var(--radius);padding:12px;font-size:15px;font-weight:700;cursor:pointer">Guardar cambios</button>
      </div>`;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    box.querySelector('#cc-edit-close').addEventListener('click', close);

    box.querySelector('#cc-edit-guardar').addEventListener('click', async () => {
      const nuevoNombre = box.querySelector('#cc-edit-nombre').value.trim();
      const nuevoTel    = box.querySelector('#cc-edit-tel').value.trim();
      const errEl       = box.querySelector('#cc-edit-error');

      if (!nuevoNombre) { errEl.textContent = 'El nombre no puede estar vacío'; errEl.style.display = 'block'; return; }
      errEl.style.display = 'none';

      const btn = box.querySelector('#cc-edit-guardar');
      btn.disabled = true;
      btn.textContent = 'Guardando...';

      try {
        await this._actualizarNombreCliente(c, nuevoNombre, nuevoTel);
        close();
        // Reconstruir la referencia del cliente con los nuevos datos
        const clientes = this.getClientesConDeuda();
        const nuevaKey = nuevoTel ? `tel:${nuevoTel}` : `nom:${nuevoNombre}`;
        this._clienteActual = clientes.find(x => x.key === nuevaKey) || null;
        if (!this._clienteActual) this._vista = 'lista';
        this._rerender();
        State.showToast?.('Cliente actualizado');
      } catch (e) {
        errEl.textContent = 'Error: ' + e.message;
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Guardar cambios';
      }
    });

    // Foco automático en nombre
    setTimeout(() => box.querySelector('#cc-edit-nombre').focus(), 50);
  },

  async _actualizarNombreCliente(c, nuevoNombre, nuevoTel) {
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.__APP_CONFIG__;
    const supa2 = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Obtener IDs de las deudas manuales de este cliente
    const ids = c.deudasManuales.map(d => d.id);
    if (ids.length) {
      const { error } = await supa2.from('deudas_manuales')
        .update({ cliente: nuevoNombre, cliente_tel: nuevoTel || null })
        .in('id', ids);
      if (error) throw error;
    }

    // Actualizar en memoria
    c.deudasManuales.forEach(d => {
      const dm = (State.deudas || []).find(x => x.id === d.id);
      if (dm) { dm.cliente = nuevoNombre; dm.clienteTel = nuevoTel || ''; }
      d.cliente = nuevoNombre;
      d.clienteTel = nuevoTel || '';
    });
    c.nombre = nuevoNombre;
    c.tel    = nuevoTel || '';
  },

  // ── Modal: Nueva deuda manual ────────────────────────────────────────────────

  openNuevaDeuda(clientePrefill = null) {
    const mob = this.isMobile();
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:400;display:flex;align-items:flex-end;justify-content:center';

    const box = document.createElement('div');
    box.style.cssText = mob
      ? 'background:var(--bg-elevated);border-radius:16px 16px 0 0;width:100%;max-height:90vh;overflow-y:auto;padding:20px 16px 32px'
      : 'background:var(--bg-elevated);border-radius:var(--radius-lg);width:480px;padding:24px;max-height:85vh;overflow-y:auto;align-self:center;box-shadow:0 20px 60px rgba(0,0,0,.4)';

    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <h3 style="margin:0;font-size:17px;font-weight:700">Nueva deuda manual</h3>
        <button id="cc-close-modal" style="background:none;border:none;cursor:pointer;font-size:22px;color:var(--text-secondary);display:flex;align-items:center"><i class="ti ti-x"></i></button>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Cliente *</label>
          <input id="cc-nd-cliente" placeholder="Nombre del cliente" value="${clientePrefill?.nombre || ''}" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Teléfono</label>
          <input id="cc-nd-tel" placeholder="Ej: 3413001234" value="${clientePrefill?.tel || ''}" inputmode="tel" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Descripción *</label>
          <input id="cc-nd-desc" placeholder="Ej: Seña iPhone 15 Pro" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box">
        </div>
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:10px">
          <div>
            <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Moneda</label>
            <select id="cc-nd-moneda" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:14px">
              <option value="USD">USD</option>
              <option value="ARS">ARS</option>
            </select>
          </div>
          <div>
            <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Monto *</label>
            <input id="cc-nd-monto" type="number" placeholder="0" inputmode="decimal" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box">
          </div>
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Notas</label>
          <textarea id="cc-nd-notas" placeholder="Detalles adicionales..." rows="2" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:14px;resize:vertical;box-sizing:border-box;font-family:var(--font)"></textarea>
        </div>
        <div id="cc-nd-error" style="display:none;color:var(--red);font-size:13px;margin-top:-4px"></div>
        <button id="cc-nd-guardar" style="background:var(--blue);color:#fff;border:none;border-radius:var(--radius);padding:12px;font-size:15px;font-weight:700;cursor:pointer;margin-top:4px">Guardar deuda</button>
      </div>`;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('cc-close-modal').addEventListener('click', close);

    document.getElementById('cc-nd-guardar').addEventListener('click', async () => {
      const nombre = document.getElementById('cc-nd-cliente').value.trim();
      const tel    = document.getElementById('cc-nd-tel').value.trim();
      const desc   = document.getElementById('cc-nd-desc').value.trim();
      const moneda = document.getElementById('cc-nd-moneda').value;
      const monto  = parseFloat(document.getElementById('cc-nd-monto').value);
      const notas  = document.getElementById('cc-nd-notas').value.trim();
      const errEl  = document.getElementById('cc-nd-error');

      if (!nombre) { errEl.textContent = 'Ingresá el nombre del cliente'; errEl.style.display = 'block'; return; }
      if (!desc)   { errEl.textContent = 'Ingresá una descripción'; errEl.style.display = 'block'; return; }
      if (!monto || monto <= 0) { errEl.textContent = 'Ingresá un monto válido'; errEl.style.display = 'block'; return; }
      errEl.style.display = 'none';

      const btn = document.getElementById('cc-nd-guardar');
      btn.disabled = true;
      btn.textContent = 'Guardando...';

      try {
        await this._guardarDeudaManual({ nombre, tel, desc, moneda, monto, notas });
        close();
        // Si hay detalle abierto, actualizar la referencia del cliente
        if (this._clienteActual) {
          const key = tel ? `tel:${tel}` : `nom:${nombre}`;
          const clientes = this.getClientesConDeuda();
          this._clienteActual = clientes.find(c => c.key === key) || null;
          if (!this._clienteActual) this._vista = 'lista';
        }
        this._rerender();
        State.showToast?.('Deuda guardada correctamente');
      } catch (e) {
        errEl.textContent = 'Error al guardar: ' + e.message;
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Guardar deuda';
      }
    });
  },

  async _guardarDeudaManual({ nombre, tel, desc, moneda, monto, notas }) {
    const { createClient } = supabase;
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.__APP_CONFIG__;
    const supa2 = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    const { data, error } = await supa2.from('deudas_manuales').insert({
      cliente: nombre, cliente_tel: tel || null, descripcion: desc,
      moneda, monto, notas: notas || null, estado: 'activa'
    }).select().single();
    if (error) throw error;

    State.deudas = State.deudas || [];
    State.deudas.unshift({
      id: data.id, cliente: nombre, clienteTel: tel || '',
      descripcion: desc, concepto: null, moneda, monto,
      montoPagado: 0, estado: 'activa', notas: notas || '', creadoEn: data.creado_en
    });
  },

  // ── Modal: Registrar pago ────────────────────────────────────────────────────

  openRegistrarPago(c) {
    const mob = this.isMobile();

    // Opciones de a qué aplicar el pago
    const opciones = [
      ...c.ventasAbiertas.map(v => ({
        tipo: 'venta', id: v.id,
        label: `Venta #${v.id} — ${v.items.map(i=>i.nombre).join(', ')} — USD ${this.saldoVenta(v).toFixed(2)} pendiente`
      })),
      ...c.deudasManuales.filter(d => d.estado === 'activa').map(d => ({
        tipo: 'deuda', id: d.id,
        label: `Deuda: ${d.descripcion} — ${d.moneda} ${this.saldoDeuda(d).toFixed(2)} pendiente`
      }))
    ];

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:400;display:flex;align-items:flex-end;justify-content:center';

    const box = document.createElement('div');
    box.style.cssText = mob
      ? 'background:var(--bg-elevated);border-radius:16px 16px 0 0;width:100%;max-height:90vh;overflow-y:auto;padding:20px 16px 32px'
      : 'background:var(--bg-elevated);border-radius:var(--radius-lg);width:480px;padding:24px;max-height:85vh;overflow-y:auto;align-self:center;box-shadow:0 20px 60px rgba(0,0,0,.4)';

    const personasOpts = (State.personas || []).map(p => `<option value="${p}">${p}</option>`).join('');
    const bolsillos = ['ARS cash','ARS transferencia','USD cash','USD transferencia','USDT'];
    const bolsillosOpts = bolsillos.map(b => `<option value="${b}">${b}</option>`).join('');
    const aplicarOpts = opciones.map((o, i) => `<option value="${i}">${o.label}</option>`).join('');

    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <h3 style="margin:0;font-size:17px;font-weight:700">Registrar pago — ${c.nombre}</h3>
        <button id="cc-close-pago" style="background:none;border:none;cursor:pointer;font-size:22px;color:var(--text-secondary);display:flex;align-items:center"><i class="ti ti-x"></i></button>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Aplicar a</label>
          <select id="cc-p-aplicar" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:14px">${aplicarOpts}</select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:10px">
          <div>
            <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Moneda</label>
            <select id="cc-p-moneda" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:14px">
              <option value="USD">USD</option>
              <option value="ARS">ARS</option>
            </select>
          </div>
          <div>
            <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Monto *</label>
            <input id="cc-p-monto" type="number" placeholder="0" inputmode="decimal" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Persona (caja)</label>
            <select id="cc-p-persona" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:14px">${personasOpts}</select>
          </div>
          <div>
            <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Bolsillo</label>
            <select id="cc-p-bolsillo" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:14px">${bolsillosOpts}</select>
          </div>
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Notas</label>
          <input id="cc-p-notas" placeholder="Opcional" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box">
        </div>
        <div id="cc-p-error" style="display:none;color:var(--red);font-size:13px"></div>
        <button id="cc-p-guardar" style="background:var(--green);color:#000;border:none;border-radius:var(--radius);padding:12px;font-size:15px;font-weight:700;cursor:pointer">Confirmar pago</button>
      </div>`;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('cc-close-pago').addEventListener('click', close);

    document.getElementById('cc-p-guardar').addEventListener('click', async () => {
      const idx     = parseInt(document.getElementById('cc-p-aplicar').value);
      const moneda  = document.getElementById('cc-p-moneda').value;
      const monto   = parseFloat(document.getElementById('cc-p-monto').value);
      const persona = document.getElementById('cc-p-persona').value;
      const bolsillo= document.getElementById('cc-p-bolsillo').value;
      const notas   = document.getElementById('cc-p-notas').value.trim();
      const errEl   = document.getElementById('cc-p-error');

      if (!monto || monto <= 0) { errEl.textContent = 'Ingresá un monto válido'; errEl.style.display = 'block'; return; }
      errEl.style.display = 'none';

      const btn = document.getElementById('cc-p-guardar');
      btn.disabled = true;
      btn.textContent = 'Guardando...';

      try {
        const opcion = opciones[idx];
        if (opcion.tipo === 'deuda') {
          await this._pagarDeudaManual(opcion.id, monto, moneda, persona, bolsillo, notas);
        } else {
          await this._pagarVenta(opcion.id, monto, moneda, persona, bolsillo);
        }

        // Acreditar caja en memoria
        State.acreditarCaja(persona, bolsillo, monto);

        close();
        // Refrescar cliente actual
        const clientes = this.getClientesConDeuda();
        const key = c.tel ? `tel:${c.tel}` : `nom:${c.nombre}`;
        this._clienteActual = clientes.find(x => x.key === key) || null;
        if (!this._clienteActual) this._vista = 'lista';
        this._rerender();
        State.showToast?.('Pago registrado correctamente');
      } catch (e) {
        errEl.textContent = 'Error: ' + e.message;
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Confirmar pago';
      }
    });
  },

  async _pagarDeudaManual(deudaId, monto, moneda, persona, bolsillo, notas) {
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.__APP_CONFIG__;
    const supa2 = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Insertar pago
    const { error: e1 } = await supa2.from('deuda_pagos').insert({
      deuda_id: deudaId, monto, moneda, persona, bolsillo, notas: notas || null
    });
    if (e1) throw e1;

    // Actualizar monto_pagado en la deuda
    const deuda = (State.deudas || []).find(d => d.id === deudaId);
    if (!deuda) return;
    const nuevoPagado = (deuda.montoPagado || 0) + monto;
    const { error: e2 } = await supa2.from('deudas_manuales').update({
      monto_pagado: nuevoPagado,
      estado: nuevoPagado >= deuda.monto ? 'pagada' : 'activa'
    }).eq('id', deudaId);
    if (e2) throw e2;

    // Actualizar en memoria
    deuda.montoPagado = nuevoPagado;
    if (nuevoPagado >= deuda.monto) deuda.estado = 'pagada';

    State.deudaPagos = State.deudaPagos || [];
    State.deudaPagos.push({ deudaId, monto, moneda, persona, bolsillo, fecha: new Date().toLocaleDateString('es-AR') });
  },

  async _pagarVenta(ventaId, monto, moneda, persona, bolsillo) {
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.__APP_CONFIG__;
    const supa2 = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    const personaId = DB.personaId(persona);
    if (!personaId) throw new Error('Persona no encontrada');

    const montoUSD = moneda === 'ARS' ? monto / (State.refBlue || 1) : monto;

    const { error } = await supa2.from('venta_pagos').insert({
      venta_id: ventaId, persona_id: personaId, bolsillo,
      monto: montoUSD, es_tarjeta: false
    });
    if (error) throw error;

    // Actualizar en memoria
    const v = (State.ventas || []).find(x => x.id === ventaId);
    if (v) {
      v.pagos.push({ persona, bolsillo, monto: montoUSD, esTarjeta: false, diferencialArs: 0 });
      // Cerrar si saldo cubierto
      const total = v.items.reduce((s, i) => s + i.precio, 0);
      const pagado = v.pagos.reduce((s, p) => s + p.monto, 0);
      if (pagado >= total) {
        await supa2.from('ventas').update({ estado: 'cerrada' }).eq('id', ventaId);
        v.estado = 'cerrada';
      }
    }
  },

  // ── Comprobante PDF (impresión) ───────────────────────────────────────────────

  generarComprobante(v, c) {
    const total  = v.items.reduce((s, i) => s + i.precio, 0);
    const pagado = v.pagos.reduce((s, p) => s + p.monto, 0);
    const saldo  = Math.max(0, total - pagado);
    const fecha  = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const num    = String(v.id).padStart(4, '0');

    const win = window.open('', '_blank', 'width=600,height=700');
    win.document.write(`<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8">
<title>Comprobante de seña — ${c.nombre}</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; padding:40px; color:#111; background:#fff; font-size:14px; }
.logo-row { display:flex; align-items:center; gap:14px; margin-bottom:8px; }
.logo-box { width:48px; height:48px; background:#0a84ff; border-radius:12px; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:20px; color:#fff; flex-shrink:0; }
.shop-name { font-size:20px; font-weight:700; }
.shop-sub  { font-size:12px; color:#666; }
.divider   { border:none; border-top:1px solid #e0e0e0; margin:16px 0; }
.header-meta { display:flex; justify-content:space-between; margin-bottom:16px; }
.meta-label { font-size:11px; color:#888; text-transform:uppercase; letter-spacing:.4px; }
.meta-val   { font-size:15px; font-weight:600; margin-top:2px; }
table { width:100%; border-collapse:collapse; margin:12px 0; }
th { font-size:11px; color:#888; text-transform:uppercase; letter-spacing:.4px; text-align:left; padding:8px 0; border-bottom:1px solid #e0e0e0; }
td { padding:10px 0; border-bottom:1px solid #f0f0f0; font-size:13px; }
.right { text-align:right; }
.total-row td { font-weight:700; font-size:15px; border-top:2px solid #111; border-bottom:none; padding-top:12px; }
.saldo-box { background:#fff8e1; border:1px solid #ffe082; border-radius:8px; padding:14px 16px; margin-top:20px; display:flex; justify-content:space-between; align-items:center; }
.saldo-label { font-size:13px; color:#666; }
.saldo-val   { font-size:20px; font-weight:800; color:#f59e0b; }
.footer { margin-top:32px; font-size:11px; color:#aaa; text-align:center; }
@media print { body { padding:20px; } }
</style>
</head><body>
<div class="logo-row">
  <div class="logo-box">iM</div>
  <div><div class="shop-name">iPhoneMood</div><div class="shop-sub">Rosario, Argentina</div></div>
</div>
<h2 style="font-size:18px;font-weight:700;margin-bottom:16px">Comprobante de seña</h2>
<hr class="divider">
<div class="header-meta">
  <div><div class="meta-label">Comprobante N°</div><div class="meta-val">#${num}</div></div>
  <div><div class="meta-label">Fecha</div><div class="meta-val">${fecha}</div></div>
</div>
<div style="margin-bottom:16px">
  <div class="meta-label">Cliente</div>
  <div class="meta-val">${c.nombre}</div>
  ${c.tel ? `<div style="font-size:12px;color:#666;margin-top:2px">${c.tel}</div>` : ''}
</div>
<hr class="divider">
<table>
  <thead><tr><th>Producto</th><th class="right">Precio USD</th></tr></thead>
  <tbody>
    ${v.items.map(i => `<tr><td>${i.nombre}</td><td class="right">USD ${i.precio.toFixed(2)}</td></tr>`).join('')}
  </tbody>
  <tfoot>
    <tr class="total-row"><td>Total</td><td class="right">USD ${total.toFixed(2)}</td></tr>
  </tfoot>
</table>
${v.pagos.length ? `
<div style="margin-top:16px">
  <div class="meta-label" style="margin-bottom:8px">Pagos recibidos</div>
  ${v.pagos.map(p => `<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0">
    <span style="color:#555">${p.persona} · ${p.bolsillo}</span>
    <span style="font-weight:600">USD ${p.monto.toFixed(2)}</span>
  </div>`).join('')}
</div>` : ''}
<div class="saldo-box">
  <div><div class="saldo-label">Saldo pendiente</div><div style="font-size:12px;color:#aaa;margin-top:2px">A abonar al retirar</div></div>
  <div class="saldo-val">USD ${saldo.toFixed(2)}</div>
</div>
<div class="footer">Este comprobante acredita el pago parcial de los productos detallados.<br>iPhoneMood no se responsabiliza por pérdida o daño de este documento.</div>
<script>window.onload = () => { window.print(); }<\/script>
</body></html>`);
    win.document.close();
  },

  // ── Re-render ────────────────────────────────────────────────────────────────

  _rerender() {
    const host = document.getElementById('cc-view-host');
    if (!host) return;
    host.innerHTML = '';
    host.appendChild(this.render());
  },
};

// ── Registro en App ──────────────────────────────────────────────────────────

window.CuentaCorriente = CuentaCorriente;
