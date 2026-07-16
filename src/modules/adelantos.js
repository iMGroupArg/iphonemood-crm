const Adelantos = {

  render() {
    const c = document.createElement('div');
    const pendientes = (State.adelantos || []).filter(a => a.estado === 'pendiente');
    const cobrados   = (State.adelantos || []).filter(a => a.estado === 'cobrado');
    const totalPendARS = pendientes.filter(a => a.moneda === 'ARS').reduce((s, a) => s + a.monto, 0);
    const totalPendUSD = pendientes.filter(a => a.moneda === 'USD').reduce((s, a) => s + a.monto, 0);
    const totalPendEquivUSD = totalPendUSD + totalPendARS / State.refBlue;

    c.innerHTML = `
      <!-- KPIs -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:16px 22px 0" class="adelantos-kpi-grid">
        <div class="card" style="margin-bottom:0;border-color:var(--amber);background:var(--amber-light)">
          <div style="font-size:10px;color:var(--amber);font-weight:600;margin-bottom:3px">DEUDA PENDIENTE (ARS)</div>
          <div style="font-size:20px;font-weight:700;color:var(--amber)">${State.fmtARS(totalPendARS)}</div>
        </div>
        <div class="card" style="margin-bottom:0;border-color:var(--amber);background:var(--amber-light)">
          <div style="font-size:10px;color:var(--amber);font-weight:600;margin-bottom:3px">DEUDA PENDIENTE (USD)</div>
          <div style="font-size:20px;font-weight:700;color:var(--amber)">${State.fmtUSD(totalPendUSD)}</div>
        </div>
        <div class="card" style="margin-bottom:0">
          <div style="font-size:10px;color:var(--text-secondary);margin-bottom:3px">Total equiv. USD</div>
          <div style="font-size:20px;font-weight:700">${State.fmtUSD(totalPendEquivUSD)}</div>
          <div style="font-size:10px;color:var(--text-secondary);margin-top:2px">a blue $${State.refBlue.toLocaleString('es-AR')}</div>
        </div>
      </div>

      <!-- Barra acción -->
      <div style="padding:14px 22px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border)">
        <div style="font-size:12px;color:var(--text-secondary)">${pendientes.length} adelanto${pendientes.length!==1?'s':''} pendiente${pendientes.length!==1?'s':''} · ${cobrados.length} cobrado${cobrados.length!==1?'s':''}</div>
        <button class="btn btn-primary" onclick="Adelantos.openNew()"><i class="ti ti-plus"></i> Registrar adelanto</button>
      </div>

      <!-- Lista pendientes -->
      ${pendientes.length ? `
      <div style="padding:16px 22px 4px">
        <div style="font-size:11px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">
          <i class="ti ti-clock"></i> Pendientes de cobro
        </div>
        <div style="display:flex;flex-direction:column;gap:8px" id="adelantos-pendientes">
          ${pendientes.map(a => this._cardHTML(a)).join('')}
        </div>
      </div>` : `
      <div style="text-align:center;padding:32px;color:var(--text-secondary)">
        <i class="ti ti-circle-check" style="font-size:32px;display:block;margin-bottom:8px;color:var(--green)"></i>
        <div style="font-size:13px;font-weight:600;color:var(--green)">Sin adelantos pendientes</div>
        <div style="font-size:12px;margin-top:4px">El negocio no le debe nada a ningún socio.</div>
      </div>`}

      <!-- Lista cobrados (colapsable) -->
      ${cobrados.length ? `
      <div style="padding:16px 22px">
        <details>
          <summary style="font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.06em;cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px">
            <i class="ti ti-chevron-right" style="font-size:12px;transition:transform .2s" id="adelantos-chevron"></i>
            Historial cobrados (${cobrados.length})
          </summary>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
            ${cobrados.map(a => this._cardHTML(a)).join('')}
          </div>
        </details>
      </div>` : ''}

      <div id="adelantos-modal-host"></div>
    `;
    return c;
  },

  _cardHTML(a) {
    const pendiente = a.estado === 'pendiente';
    const montoFmt = a.moneda === 'USD' ? State.fmtUSD(a.monto) : State.fmtARS(a.monto);
    const equivFmt = a.moneda === 'ARS'
      ? `≈ ${State.fmtUSD(a.monto / State.refBlue)}`
      : `≈ ${State.fmtARS(a.monto * State.refBlue)}`;
    return `<div class="card" style="margin-bottom:0;display:flex;align-items:flex-start;gap:14px;${pendiente?'border-color:var(--amber)':'opacity:.65'}">
      <div style="width:36px;height:36px;border-radius:10px;background:${pendiente?'var(--amber-light)':'var(--bg-secondary)'};display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <i class="ti ti-user-dollar" style="font-size:17px;color:${pendiente?'var(--amber)':'var(--text-secondary)'}"></i>
      </div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:3px">
          <span style="font-size:13px;font-weight:700">${a.motivo}</span>
          <span class="badge ${pendiente?'b-amber':'b-green'}">${pendiente?'Pendiente':'Cobrado'}</span>
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px">
          ${a.socio} · ${a.fecha}${a.fechaCobro ? ` → cobrado ${a.fechaCobro}` : ''}
          ${a.notas ? ` · ${a.notas}` : ''}
        </div>
        <div style="display:flex;align-items:baseline;gap:8px">
          <span style="font-size:15px;font-weight:800;color:${pendiente?'var(--amber)':'var(--text)'}">${montoFmt}</span>
          <span style="font-size:10px;color:var(--text-secondary)">${equivFmt}</span>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
        ${pendiente ? `<button class="btn btn-sm btn-primary" onclick="Adelantos.openCobrar('${a.id}')"><i class="ti ti-check"></i> Cobrar</button>` : ''}
        <button class="btn btn-sm" onclick="Adelantos.openEdit('${a.id}')">✏️</button>
      </div>
    </div>`;
  },

  // ── Modal nuevo adelanto ────────────────────────────────────────

  openNew() {
    const host = document.getElementById('adelantos-modal-host');
    const personaOpts = State.personas.map(p => `<option value="${p}">${p}</option>`).join('');
    host.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(6px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)Adelantos.closeModal()">
        <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(420px,96vw);overflow:hidden" onclick="event.stopPropagation()">
          <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
            <div style="font-size:14px;font-weight:700"><i class="ti ti-user-dollar"></i> Nuevo adelanto</div>
            <button onclick="Adelantos.closeModal()" style="background:none;border:none;color:var(--text-secondary);font-size:18px;cursor:pointer">✕</button>
          </div>
          <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Socio que adelantó</label>
              <select id="ad-socio" style="width:100%;font-size:13px;padding:9px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">${personaOpts}</select>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Motivo / descripción</label>
              <input type="text" id="ad-motivo" placeholder="Ej: Pago de factura proveedor, compra insumos..." style="width:100%;font-size:13px;padding:9px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
            <div style="display:grid;grid-template-columns:1fr 100px;gap:8px">
              <div>
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Monto</label>
                <input type="number" id="ad-monto" min="0" step="0.01" placeholder="0" style="width:100%;font-size:16px;font-weight:700;padding:9px 12px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
              </div>
              <div>
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Moneda</label>
                <select id="ad-moneda" style="width:100%;font-size:12px;padding:9px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                  <option value="ARS">ARS</option>
                  <option value="USD">USD</option>
                </select>
              </div>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Fecha</label>
              <input type="date" id="ad-fecha" value="${new Date().toISOString().slice(0,10)}" style="width:100%;font-size:13px;padding:9px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Notas (opcional)</label>
              <input type="text" id="ad-notas" placeholder="Referencia, factura, contexto..." style="width:100%;font-size:13px;padding:9px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
          </div>
          <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
            <button class="btn" onclick="Adelantos.closeModal()">Cancelar</button>
            <button class="btn btn-primary" onclick="Adelantos.guardar()"><i class="ti ti-check"></i> Registrar</button>
          </div>
        </div>
      </div>`;
    setTimeout(() => document.getElementById('ad-motivo')?.focus(), 80);
  },

  async guardar() {
    const socio  = document.getElementById('ad-socio')?.value;
    const motivo = document.getElementById('ad-motivo')?.value.trim();
    const monto  = parseFloat(document.getElementById('ad-monto')?.value);
    const moneda = document.getElementById('ad-moneda')?.value || 'ARS';
    const fecha  = document.getElementById('ad-fecha')?.value;
    const notas  = document.getElementById('ad-notas')?.value.trim();

    if (!motivo) { toast('Ingresá una descripción.'); return; }
    if (!monto || monto <= 0) { toast('Ingresá un monto válido.'); return; }

    const { data, error } = await DB.crearAdelanto({ socio, motivo, monto, moneda, fecha, notas });
    if (error) { toast('Error al guardar.'); console.error(error); return; }

    State.adelantos.unshift({ id: data.id, socio, motivo, monto, moneda, fecha, notas: notas||'', estado: 'pendiente', fechaCobro: null, cajaDebito: null });
    this.closeModal();
    App.goTo('adelantos');
    toast(`Adelanto de ${socio} registrado. El negocio le debe ${moneda} ${monto.toLocaleString('es-AR')}.`);
  },

  // ── Modal cobrar ────────────────────────────────────────────────

  openCobrar(id) {
    const a = (State.adelantos || []).find(x => x.id == id);
    if (!a) return;
    const host = document.getElementById('adelantos-modal-host');
    const montoFmt = a.moneda === 'USD' ? State.fmtUSD(a.monto) : State.fmtARS(a.monto);
    const personaOpts = State.personas.map(p => `<option>${p}</option>`).join('');
    const bolsilloOpts = ['ARS cash','ARS transferencia','USD cash','USD transferencia','USDT']
      .map(b => `<option>${b}</option>`).join('');
    host.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(6px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)Adelantos.closeModal()">
        <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(400px,96vw);overflow:hidden" onclick="event.stopPropagation()">
          <div style="padding:14px 18px;border-bottom:1px solid var(--border)">
            <div style="font-size:14px;font-weight:700"><i class="ti ti-check"></i> Cobrar adelanto</div>
          </div>
          <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
            <div style="background:var(--amber-light);border:1px solid var(--amber);border-radius:10px;padding:12px 14px">
              <div style="font-size:12px;font-weight:700;color:var(--amber);margin-bottom:4px">${a.socio} adelantó</div>
              <div style="font-size:15px;font-weight:800">${montoFmt}</div>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${a.motivo} · ${a.fecha}</div>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">De qué caja sale el dinero</label>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <select id="cob-persona" style="font-size:12px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">${personaOpts}</select>
                <select id="cob-bolsillo" style="font-size:12px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">${bolsilloOpts}</select>
              </div>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Fecha de cobro</label>
              <input type="date" id="cob-fecha" value="${new Date().toISOString().slice(0,10)}" style="width:100%;font-size:13px;padding:9px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
          </div>
          <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
            <button class="btn" onclick="Adelantos.closeModal()">Cancelar</button>
            <button class="btn btn-primary" onclick="Adelantos.confirmarCobro('${a.id}')"><i class="ti ti-check"></i> Confirmar cobro</button>
          </div>
        </div>
      </div>`;
  },

  async confirmarCobro(id) {
    const a = (State.adelantos || []).find(x => x.id == id);
    if (!a) return;
    const persona  = document.getElementById('cob-persona')?.value;
    const bolsillo = document.getElementById('cob-bolsillo')?.value;
    const fecha    = document.getElementById('cob-fecha')?.value;
    const cajaDebito = `${persona}-${bolsillo}`;

    // Debitar la caja
    const actual = State.cajas[persona]?.[bolsillo] || 0;
    const nuevo  = Math.max(0, actual - a.monto);
    State.cajas[persona][bolsillo] = nuevo;
    await DB.actualizarSaldoCaja(persona, bolsillo, nuevo);

    // Marcar cobrado
    await DB.cobrarAdelanto(id, fecha, cajaDebito);
    const idx = State.adelantos.findIndex(x => x.id == id);
    if (idx !== -1) {
      State.adelantos[idx] = { ...State.adelantos[idx], estado: 'cobrado', fechaCobro: fecha, cajaDebito };
    }

    this.closeModal();
    App.goTo('adelantos');
    toast(`Cobro registrado. Se debitaron ${a.moneda} ${a.monto.toLocaleString('es-AR')} de ${cajaDebito}.`);
  },

  // ── Modal editar / eliminar ─────────────────────────────────────

  openEdit(id) {
    const a = (State.adelantos || []).find(x => x.id == id);
    if (!a) return;
    const host = document.getElementById('adelantos-modal-host');
    const montoFmt = a.moneda === 'USD' ? State.fmtUSD(a.monto) : State.fmtARS(a.monto);
    host.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(6px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)Adelantos.closeModal()">
        <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(380px,96vw);overflow:hidden" onclick="event.stopPropagation()">
          <div style="padding:14px 18px;border-bottom:1px solid var(--border)">
            <div style="font-size:14px;font-weight:700">Detalle del adelanto</div>
          </div>
          <div style="padding:18px;display:flex;flex-direction:column;gap:8px;font-size:13px">
            ${this._detRow('Socio', a.socio)}
            ${this._detRow('Motivo', a.motivo)}
            ${this._detRow('Monto', `<b>${montoFmt}</b>`)}
            ${this._detRow('Fecha', a.fecha)}
            ${this._detRow('Estado', `<span class="badge ${a.estado==='pendiente'?'b-amber':'b-green'}">${a.estado==='pendiente'?'Pendiente':'Cobrado'}</span>`)}
            ${a.fechaCobro ? this._detRow('Fecha cobro', a.fechaCobro) : ''}
            ${a.cajaDebito ? this._detRow('Caja', a.cajaDebito) : ''}
            ${a.notas ? this._detRow('Notas', a.notas) : ''}
          </div>
          <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:space-between">
            <button class="btn" style="color:var(--red)" onclick="Adelantos.eliminar('${a.id}')">🗑️ Eliminar</button>
            <button class="btn" onclick="Adelantos.closeModal()">Cerrar</button>
          </div>
        </div>
      </div>`;
  },

  _detRow(label, val) {
    return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="color:var(--text-secondary)">${label}</span><span>${val}</span></div>`;
  },

  async eliminar(id) {
    const a = (State.adelantos || []).find(x => x.id == id);
    if (!confirm('¿Eliminar este adelanto? Si ya estaba cobrado, el saldo de la caja NO se revierte automáticamente.')) return;
    await DB.eliminarAdelanto(id);
    State.adelantos = State.adelantos.filter(x => x.id != id);
    this.closeModal();
    App.goTo('adelantos');
    toast('Adelanto eliminado.');
  },

  closeModal() {
    const host = document.getElementById('adelantos-modal-host');
    if (host) host.innerHTML = '';
  },
};

window.Adelantos = Adelantos;
