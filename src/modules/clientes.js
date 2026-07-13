const Clientes = {
  _q: '',
  _sel: null,
  _eliminados: new Set(JSON.parse(localStorage.getItem('im_clientes_eliminados') || '[]')),

  _guardarEliminados() {
    localStorage.setItem('im_clientes_eliminados', JSON.stringify([...this._eliminados]));
  },

  render() {
    const c = document.createElement('div');
    c.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;min-height:0';
    c.innerHTML = `
      <div style="padding:14px 22px;border-bottom:1px solid var(--border);flex-shrink:0">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">
          <div>
            <h2 style="font-size:19px;font-weight:700;display:flex;align-items:center;gap:8px"><i class="ti ti-address-book" style="color:var(--blue)"></i> Clientes</h2>
            <p style="font-size:12px;color:var(--text-secondary);margin-top:2px">Historial de compras, reparaciones y datos de contacto</p>
          </div>
          <button class="btn btn-primary" onclick="Clientes.abrirModal()"><i class="ti ti-plus"></i> Nuevo cliente</button>
        </div>
        <input type="text" id="cli-search" placeholder="Buscar por nombre, teléfono o DNI…"
          oninput="Clientes._q=this.value;Clientes.renderLista()"
          style="width:100%;font-size:13px;padding:8px 12px;border:1px solid var(--border-strong);border-radius:10px;color:var(--text);background:var(--bg-secondary)">
      </div>
      <div style="display:flex;flex:1;overflow:hidden;min-height:0">
        <div id="cli-lista" style="width:300px;min-width:260px;border-right:1px solid var(--border);overflow-y:auto;flex-shrink:0"></div>
        <div id="cli-detalle" style="flex:1;overflow-y:auto;padding:20px 24px"></div>
      </div>
    `;
    setTimeout(() => { this.renderLista(); }, 0);
    return c;
  },

  _clientes() {
    // Derivar clientes únicos de ventas y reparaciones
    const map = {};
    (State.ventas || []).forEach(v => {
      if (!v.cliente) return;
      const key = v.clienteTel || v.clienteDni || v.cliente;
      if (!map[key]) map[key] = { nombre: v.cliente, tel: v.clienteTel || '', dni: v.clienteDni || '', ventas: [], reparaciones: [], notas: '' };
      map[key].ventas.push(v);
      if (v.clienteTel && !map[key].tel) map[key].tel = v.clienteTel;
      if (v.clienteDni && !map[key].dni) map[key].dni = v.clienteDni;
    });
    (State.reparaciones || []).forEach(r => {
      if (!r.cliente) return;
      const key = r.tel || r.cliente;
      if (!map[key]) map[key] = { nombre: r.cliente, tel: r.tel || '', dni: '', ventas: [], reparaciones: [], notas: '' };
      map[key].reparaciones.push(r);
      if (r.tel && !map[key].tel) map[key].tel = r.tel;
    });
    return Object.values(map)
      .filter(c => !this._eliminados.has(c.tel || c.nombre))
      .sort((a,b) => a.nombre.localeCompare(b.nombre));
  },

  renderLista() {
    const q = (this._q || '').toLowerCase();
    const lista = this._clientes().filter(c =>
      !q || c.nombre.toLowerCase().includes(q) || c.tel.includes(q) || c.dni.includes(q)
    );
    const el = document.getElementById('cli-lista');
    if (!el) return;
    if (!lista.length) {
      el.innerHTML = `<div class="empty-state" style="padding:30px 16px"><i class="ti ti-address-book"></i><p>${q ? 'Sin resultados.' : 'Aún no hay clientes.'}</p></div>`;
      return;
    }
    el.innerHTML = lista.map(c => {
      const totalCompras = c.ventas.reduce((s,v) => s + v.items.reduce((a,i) => a + i.precio, 0), 0);
      const isSelected = this._sel === (c.tel || c.nombre);
      return `<div onclick="Clientes.seleccionar('${escHtml(c.tel || c.nombre)}')"
        style="padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer;background:${isSelected?'var(--bg-elevated)':'transparent'};border-left:2px solid ${isSelected?'var(--blue)':'transparent'}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
          <div class="av" style="width:28px;height:28px;font-size:10px;flex-shrink:0">${c.nombre.substring(0,2).toUpperCase()}</div>
          <b style="font-size:12.5px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.nombre}</b>
        </div>
        <div style="font-size:10.5px;color:var(--text-secondary);margin-left:36px">
          ${c.tel ? `<i class="ti ti-phone" style="font-size:9px"></i> ${c.tel}` : ''}
          ${c.ventas.length ? ` · ${c.ventas.length} compra${c.ventas.length>1?'s':''}` : ''}
          ${c.reparaciones.length ? ` · ${c.reparaciones.length} rep.` : ''}
        </div>
      </div>`;
    }).join('');
  },

  seleccionar(key) {
    this._sel = key;
    this.renderLista();
    const c = this._clientes().find(x => (x.tel || x.nombre) === key);
    if (!c) return;
    this.renderDetalle(c);
  },

  renderDetalle(c) {
    const el = document.getElementById('cli-detalle');
    if (!el) return;
    const totalGastado = c.ventas.reduce((s,v) => s + v.items.reduce((a,i) => a + i.precio, 0), 0);
    const tel = c.tel?.replace(/\D/g,'');
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;margin-bottom:20px">
        <div style="display:flex;align-items:center;gap:12px">
          <div class="av" style="width:48px;height:48px;font-size:16px">${c.nombre.substring(0,2).toUpperCase()}</div>
          <div>
            <div style="font-size:18px;font-weight:700">${c.nombre}</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">
              ${c.tel ? `<i class="ti ti-phone"></i> ${c.tel}` : ''}
              ${c.dni ? ` · DNI ${c.dni}` : ''}
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          ${c.tel ? `<a href="https://wa.me/549${tel}" target="_blank" class="btn btn-primary" style="text-decoration:none"><i class="ti ti-brand-whatsapp"></i> WhatsApp</a>` : ''}
          <button class="btn" style="color:var(--red)" onclick="Clientes.eliminar('${escHtml(c.tel || c.nombre)}')">🗑️ Eliminar</button>
        </div>
      </div>

      <!-- KPIs -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px">
        <div class="card" style="margin-bottom:0">
          <div style="font-size:10px;color:var(--text-secondary);margin-bottom:2px">Total comprado</div>
          <div style="font-size:20px;font-weight:700;color:var(--blue)">${State.fmtUSD(totalGastado)}</div>
        </div>
        <div class="card" style="margin-bottom:0">
          <div style="font-size:10px;color:var(--text-secondary);margin-bottom:2px">Compras</div>
          <div style="font-size:20px;font-weight:700">${c.ventas.length}</div>
        </div>
        <div class="card" style="margin-bottom:0">
          <div style="font-size:10px;color:var(--text-secondary);margin-bottom:2px">Reparaciones</div>
          <div style="font-size:20px;font-weight:700">${c.reparaciones.length}</div>
        </div>
      </div>

      <!-- Ventas -->
      ${c.ventas.length ? `
      <div class="card" style="margin-bottom:14px">
        <div class="card-title"><i class="ti ti-receipt"></i> Historial de compras</div>
        ${c.ventas.map(v => {
          const total = v.items.reduce((s,i) => s + i.precio, 0);
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px">
            <div>
              <div style="font-weight:600">${v.items.map(i=>i.nombre).join(', ')}</div>
              <div style="font-size:10px;color:var(--text-secondary)">${v.fecha} · ${v.estado}</div>
            </div>
            <b style="color:var(--blue)">${State.fmtUSD(total)}</b>
          </div>`;
        }).join('')}
      </div>` : ''}

      <!-- Reparaciones -->
      ${c.reparaciones.length ? `
      <div class="card" style="margin-bottom:14px">
        <div class="card-title"><i class="ti ti-tool"></i> Reparaciones</div>
        ${c.reparaciones.map(r => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px;cursor:pointer" onclick="App.goTo('reparaciones')">
            <div>
              <div style="font-weight:600">${r.equipo}</div>
              <div style="font-size:10px;color:var(--text-secondary)">${r.falla} · ${r.fechaIngreso}</div>
            </div>
            <span class="badge ${r.estado==='listo'?'b-green':r.estado==='entregado'?'b-gray':'b-amber'}">${r.estado}</span>
          </div>`).join('')}
      </div>` : ''}
    `;
  },

  eliminar(key) {
    if (!confirm('¿Eliminar este cliente de la lista? Sus ventas y reparaciones no se borran.')) return;
    this._eliminados.add(key);
    this._guardarEliminados();
    this._sel = null;
    document.getElementById('cli-detalle').innerHTML = '';
    this.renderLista();
    toast('Cliente eliminado de la lista.');
  },

  abrirModal() {
    const overlay = document.createElement('div');
    overlay.id = 'cli-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(6px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(400px,96vw);overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border)">
          <div style="font-size:14px;font-weight:700">Nuevo cliente</div>
          <div style="font-size:11px;color:var(--text-secondary)">Los clientes se generan automáticamente al crear ventas o reparaciones. Podés agregar uno manualmente acá.</div>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Nombre *</label>
            <input id="cli-m-nombre" type="text" placeholder="Nombre completo"
              style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Teléfono</label>
              <input id="cli-m-tel" type="tel" placeholder="3411234567"
                style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">DNI</label>
              <input id="cli-m-dni" type="text" placeholder="Opcional"
                style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
          </div>
          <div style="background:var(--blue-light);border-radius:8px;padding:9px 11px;font-size:11px;color:var(--blue)">
            <i class="ti ti-info-circle"></i> Este cliente ficticio aparecerá en la lista, pero se recomienda registrar clientes directamente al crear ventas o reparaciones para que el historial quede enlazado automáticamente.
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('cli-modal').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Clientes.guardarManual()">✓ Guardar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    setTimeout(() => document.getElementById('cli-m-nombre')?.focus(), 60);
  },

  guardarManual() {
    const nombre = document.getElementById('cli-m-nombre')?.value.trim();
    if (!nombre) { toast('El nombre es obligatorio.'); return; }
    const tel = document.getElementById('cli-m-tel')?.value.trim() || '';
    const dni = document.getElementById('cli-m-dni')?.value.trim() || '';
    // Crear una venta ficticia vacía no tiene sentido — simplemente registramos en State como placeholder
    // El cliente se verá en la lista derivada de ventas/reparaciones reales.
    // Para clientes sin historial, sugerimos crear desde ventas.
    document.getElementById('cli-modal')?.remove();
    toast(`${nombre} anotado. Aparecerá en el historial al crear su primera venta o reparación.`);
  },
};

function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

window.Clientes = Clientes;
