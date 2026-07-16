const Cajas = {
  _tab: 'cajas',   // 'cajas' | 'movimientos'
  _movimientos: [],

  render() {
    const c = document.createElement('div');
    c.className = 'body-pad';
    let totalARS = 0, totalUSD = 0, totalUSDT = 0;
    Object.values(State.cajas).forEach(caja => {
      totalARS  += (caja['ARS cash']||0) + (caja['ARS transferencia']||0);
      totalUSD  += (caja['USD cash']||0) + (caja['USD transferencia']||0);
      totalUSDT += caja['USDT'] || 0;
    });
    const equivalenteTotal = totalARS + totalUSD * State.refBlue + totalUSDT * State.refBlue;

    const BOLSILLO_ICON = {
      'ARS cash': 'ti-cash', 'ARS transferencia': 'ti-building-bank',
      'USD cash': 'ti-currency-dollar', 'USD transferencia': 'ti-transfer',
      'USDT': 'ti-currency-bitcoin'
    };

    c.innerHTML = `
      <!-- KPIs consolidados -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px" class="cajas-kpi-grid">
        <div class="card" style="margin-bottom:0">
          <div style="font-size:10px;color:var(--text-secondary);margin-bottom:3px">ARS total</div>
          <div style="font-size:20px;font-weight:700">${State.fmtARS(totalARS)}</div>
        </div>
        <div class="card" style="margin-bottom:0">
          <div style="font-size:10px;color:var(--text-secondary);margin-bottom:3px">USD total</div>
          <div style="font-size:20px;font-weight:700">${State.fmtUSD(totalUSD)}</div>
        </div>
        <div class="card" style="margin-bottom:0">
          <div style="font-size:10px;color:var(--text-secondary);margin-bottom:3px">USDT total</div>
          <div style="font-size:20px;font-weight:700">${totalUSDT.toLocaleString('es-AR')} <span style="font-size:12px;color:var(--text-secondary)">USDT</span></div>
        </div>
        <div class="card" style="margin-bottom:0;background:var(--blue-light);border-color:rgba(10,132,255,.3)">
          <div style="font-size:10px;color:var(--blue);margin-bottom:3px">Equivalente ARS (blue)</div>
          <div style="font-size:20px;font-weight:700;color:var(--blue)">${State.fmtARS(equivalenteTotal)}</div>
        </div>
      </div>

      <!-- Tabs + botón Nuevo movimiento -->
      <div style="display:flex;align-items:center;gap:0;margin-bottom:16px;border-bottom:1px solid var(--border)">
        <button onclick="Cajas.setTab('cajas')" style="padding:8px 16px;font-size:13px;font-weight:600;background:none;border:none;border-bottom:2px solid ${this._tab==='cajas'?'var(--blue)':'transparent'};color:${this._tab==='cajas'?'var(--blue)':'var(--text-secondary)'};cursor:pointer">
          <i class="ti ti-wallet"></i> Cajas
        </button>
        <button onclick="Cajas.setTab('movimientos')" style="padding:8px 16px;font-size:13px;font-weight:600;background:none;border:none;border-bottom:2px solid ${this._tab==='movimientos'?'var(--blue)':'transparent'};color:${this._tab==='movimientos'?'var(--blue)':'var(--text-secondary)'};cursor:pointer">
          <i class="ti ti-arrows-exchange"></i> Movimientos
        </button>
        <div style="flex:1"></div>
        <button class="btn btn-primary btn-sm" onclick="Cajas.abrirModalMovimiento()" style="margin-bottom:6px">
          <i class="ti ti-plus"></i> Nuevo movimiento
        </button>
      </div>

      <!-- Contenido de la pestaña activa -->
      <div id="cajas-tab-content">
        ${this._tab === 'cajas' ? this._cajasHTML(BOLSILLO_ICON) : this._movimientosHTML()}
      </div>

      <div style="font-size:11px;color:var(--text-secondary);margin-top:12px"><i class="ti ti-info-circle"></i> Tocá cualquier saldo para ajustarlo. Para agregar o renombrar personas, andá a Panel de control → Cajas y personas.</div>
    `;

    return c;
  },

  async setTab(t) {
    this._tab = t;
    if (t === 'movimientos') {
      this._movimientos = await DB.listarMovimientosCaja(200);
    }
    App.goTo('cajas');
  },

  _cajasHTML(BOLSILLO_ICON) {
    return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">
        ${State.personas.map(p => {
          const caja = State.cajas[p] || {};
          const arsEquiv = (caja['ARS cash']||0) + (caja['ARS transferencia']||0)
                         + ((caja['USD cash']||0)+(caja['USD transferencia']||0)) * State.refBlue
                         + (caja['USDT']||0) * State.refBlue;
          const usdEquiv = ((caja['ARS cash']||0) + (caja['ARS transferencia']||0)) / State.refBlueCompra
                         + (caja['USD cash']||0) + (caja['USD transferencia']||0)
                         + (caja['USDT']||0);
          return `<div class="card" style="margin-bottom:0">
            <div class="card-title" style="margin-bottom:14px">
              <div class="av" style="width:30px;height:30px;font-size:11px">${p.substring(0,2).toUpperCase()}</div>
              <span style="font-size:14px;font-weight:700">${p}</span>
            </div>
            ${['ARS cash','ARS transferencia','USD cash','USD transferencia','USDT'].map(b => {
              const val = caja[b] || 0;
              const fmt = b === 'USDT' ? val.toLocaleString('es-AR') + ' USDT'
                        : b.startsWith('ARS') ? State.fmtARS(val)
                        : State.fmtUSD(val);
              return `<div onclick="Cajas.abrirModal('${p}','${b}')"
                style="display:flex;align-items:center;gap:10px;padding:9px 8px;border-radius:8px;cursor:pointer;transition:background .12s"
                onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background='transparent'">
                <i class="ti ${BOLSILLO_ICON[b]}" style="font-size:16px;color:var(--text-secondary);width:18px;text-align:center;flex-shrink:0"></i>
                <span style="flex:1;font-size:12px;color:var(--text-secondary)">${b}</span>
                <b style="font-size:13px">${fmt}</b>
                ✏️
              </div>`;
            }).join('')}
            <div style="border-top:1px solid var(--border);margin-top:8px;padding-top:8px;display:flex;justify-content:space-between;align-items:center">
              <span style="font-size:11px;color:var(--text-secondary)">Equiv. ARS</span>
              <b style="color:var(--blue)">${State.fmtARS(arsEquiv)}</b>
            </div>
            <div style="margin-top:6px;display:flex;justify-content:space-between;align-items:center">
              <span style="font-size:11px;color:var(--text-secondary)">Equiv. USD</span>
              <b style="color:var(--text-secondary);font-size:12px">${State.fmtUSD(usdEquiv)}</b>
            </div>
          </div>`;
        }).join('')}
      </div>`;
  },

  _movimientosHTML() {
    const movs = this._movimientos || [];
    if (!movs.length) {
      return `<div style="text-align:center;padding:40px;color:var(--text-secondary)"><i class="ti ti-arrows-exchange" style="font-size:32px;display:block;margin-bottom:8px"></i>No hay movimientos registrados aún.</div>`;
    }
    const TIPO_LABEL = { pasada_manos:'Pasada de manos', retiro_banco:'Retiro bancario a efectivo', deposito_banco:'Depósito a banco', otro:'Otro' };
    const TIPO_ICON  = { pasada_manos:'ti-arrows-exchange', retiro_banco:'ti-building-bank', deposito_banco:'ti-building-bank', otro:'ti-cash' };
    const TIPO_COLOR = { pasada_manos:'var(--blue)', retiro_banco:'var(--amber)', deposito_banco:'var(--green)', otro:'var(--text-secondary)' };
    return `<div style="display:flex;flex-direction:column;gap:10px">
      ${movs.map(m => {
        const fmtMonto = m.moneda === 'ARS' ? State.fmtARS(m.monto)
                       : m.moneda === 'USDT' ? m.monto.toLocaleString('es-AR') + ' USDT'
                       : State.fmtUSD(m.monto);
        const fecha = new Date(m.creado_en).toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
        const origenStr = m.origenP ? `${m.origenP} · ${m.origen_bolsillo}` : '—';
        const destinoStr = m.destinoP ? `${m.destinoP} · ${m.destino_bolsillo}` : '—';
        return `<div class="card" style="margin-bottom:0;display:flex;align-items:flex-start;gap:14px">
          <div style="width:38px;height:38px;border-radius:10px;background:${TIPO_COLOR[m.tipo]}22;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px">
            <i class="ti ${TIPO_ICON[m.tipo]||'ti-cash'}" style="font-size:18px;color:${TIPO_COLOR[m.tipo]}"></i>
          </div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
              <span style="font-size:13px;font-weight:700">${TIPO_LABEL[m.tipo]||m.tipo}</span>
              <span style="font-size:14px;font-weight:800;color:${TIPO_COLOR[m.tipo]}">${fmtMonto}</span>
            </div>
            <div style="font-size:11px;color:var(--text-secondary);margin-bottom:2px">
              <i class="ti ti-arrow-right" style="font-size:10px"></i>
              ${origenStr} → ${destinoStr}
            </div>
            ${m.descripcion ? `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:2px">${m.descripcion}</div>` : ''}
            <div style="display:flex;align-items:center;gap:10px;margin-top:4px">
              <span style="font-size:10px;color:var(--text-tertiary)">${fecha}${m.creado_por ? ` · ${m.creado_por}` : ''}</span>
              ${m.comprobante_url
                ? `<button onclick="Cajas.verComprobante('${m.comprobante_url}')" style="font-size:10px;padding:2px 8px;border:1px solid var(--border-strong);border-radius:6px;background:transparent;color:var(--text-secondary);cursor:pointer"><i class="ti ti-photo"></i> Ver comprobante</button>`
                : `<button onclick="Cajas.adjuntarComprobante(${m.id})" style="font-size:10px;padding:2px 8px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text-tertiary);cursor:pointer"><i class="ti ti-upload"></i> Adjuntar comprobante</button>`}
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  },

  // ── Modal nuevo movimiento ─────────────────────────────────

  abrirModalMovimiento() {
    const personaOpts = State.personas.map(p => `<option value="${p}">${p}</option>`).join('');
    const bolsilloOpts = ['ARS cash','ARS transferencia','USD cash','USD transferencia','USDT']
      .map(b => `<option value="${b}">${b}</option>`).join('');
    const sep = (label) => `<div style="font-size:10px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 6px">${label}</div>`;

    const overlay = document.createElement('div');
    overlay.id = 'caja-mov-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(6px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(440px,96vw);max-height:90vh;overflow-y:auto">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
          <div style="font-size:14px;font-weight:700"><i class="ti ti-arrows-exchange"></i> Nuevo movimiento</div>
          <button onclick="document.getElementById('caja-mov-overlay').remove()" style="background:none;border:none;color:var(--text-secondary);font-size:18px;cursor:pointer;line-height:1">✕</button>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:4px">

          ${sep('Tipo de movimiento')}
          <select id="cmov-tipo" onchange="Cajas._onTipoChange()" style="font-size:13px;padding:9px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);width:100%">
            <option value="pasada_manos">🔄 Pasada de manos entre personas</option>
            <option value="retiro_banco">🏦 Retiro bancario a efectivo</option>
            <option value="deposito_banco">🏦 Depósito de efectivo al banco</option>
            <option value="otro">📝 Otro</option>
          </select>

          ${sep('Origen')}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Persona</label>
              <select id="cmov-origen-p" style="font-size:12px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);width:100%">
                ${personaOpts}
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Bolsillo</label>
              <select id="cmov-origen-b" style="font-size:12px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);width:100%">
                ${bolsilloOpts}
              </select>
            </div>
          </div>

          <div id="cmov-destino-wrap">
            ${sep('Destino')}
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <div>
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Persona</label>
                <select id="cmov-destino-p" style="font-size:12px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);width:100%">
                  ${personaOpts}
                </select>
              </div>
              <div>
                <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Bolsillo</label>
                <select id="cmov-destino-b" style="font-size:12px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);width:100%">
                  ${bolsilloOpts}
                </select>
              </div>
            </div>
          </div>

          ${sep('Monto')}
          <div style="display:grid;grid-template-columns:1fr 120px;gap:8px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Monto</label>
              <input type="number" id="cmov-monto" min="0" step="0.01" placeholder="0" style="width:100%;font-size:16px;font-weight:700;padding:9px 12px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Moneda</label>
              <select id="cmov-moneda" style="font-size:12px;padding:9px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);width:100%">
                <option value="ARS">ARS</option>
                <option value="USD">USD</option>
                <option value="USDT">USDT</option>
              </select>
            </div>
          </div>

          ${sep('Descripción (opcional)')}
          <textarea id="cmov-desc" rows="2" placeholder="Ej: Franco le pasa plata a Lautaro para compra..." style="width:100%;font-size:12px;padding:9px 12px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);resize:none;font-family:inherit"></textarea>

          ${sep('Comprobante (opcional)')}
          <label for="cmov-file" style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;cursor:pointer">
            <i class="ti ti-upload" style="font-size:16px;color:var(--text-secondary)"></i>
            <span id="cmov-file-label" style="font-size:12px;color:var(--text-secondary)">Adjuntar imagen o captura</span>
          </label>
          <input type="file" id="cmov-file" accept="image/*,application/pdf" style="display:none" onchange="Cajas._onFileChange(this)">

        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('caja-mov-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" id="cmov-btn-guardar" onclick="Cajas.guardarMovimiento()"><i class="ti ti-check"></i> Registrar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    this._onTipoChange();
    setTimeout(() => document.getElementById('cmov-monto')?.focus(), 80);
  },

  _onTipoChange() {
    const tipo = document.getElementById('cmov-tipo')?.value;
    const destinoWrap = document.getElementById('cmov-destino-wrap');
    if (!destinoWrap) return;
    // retiro_banco: origen = transferencia, destino = mismo usuario cash
    const mostrarDestino = tipo !== 'retiro_banco' && tipo !== 'deposito_banco';
    destinoWrap.style.display = mostrarDestino ? '' : 'none';
    // sincronizar bolsillos según tipo
    if (tipo === 'retiro_banco') {
      const ob = document.getElementById('cmov-origen-b');
      if (ob) ob.value = 'ARS transferencia';
    }
    if (tipo === 'deposito_banco') {
      const ob = document.getElementById('cmov-origen-b');
      if (ob) ob.value = 'ARS cash';
    }
  },

  _onFileChange(input) {
    const label = document.getElementById('cmov-file-label');
    if (label && input.files[0]) label.textContent = input.files[0].name;
  },

  async guardarMovimiento() {
    const tipo     = document.getElementById('cmov-tipo')?.value;
    const origenP  = document.getElementById('cmov-origen-p')?.value;
    const origenB  = document.getElementById('cmov-origen-b')?.value;
    const monto    = parseFloat(document.getElementById('cmov-monto')?.value);
    const moneda   = document.getElementById('cmov-moneda')?.value || 'ARS';
    const desc     = document.getElementById('cmov-desc')?.value.trim();
    const file     = document.getElementById('cmov-file')?.files[0];

    if (!monto || monto <= 0) { toast('Ingresá un monto válido.'); return; }
    if (!origenP) { toast('Seleccioná persona origen.'); return; }

    const tieneDestino = tipo === 'pasada_manos' || tipo === 'otro';
    const destinoP = tieneDestino ? document.getElementById('cmov-destino-p')?.value : null;
    const destinoB = tieneDestino ? document.getElementById('cmov-destino-b')?.value : null;

    // Para retiro/depósito el destino es el mismo usuario con bolsillo opuesto
    let destinoPFinal = destinoP, destinoBFinal = destinoB;
    if (tipo === 'retiro_banco') {
      destinoPFinal = origenP;
      destinoBFinal = 'ARS cash';
    } else if (tipo === 'deposito_banco') {
      destinoPFinal = origenP;
      destinoBFinal = 'ARS transferencia';
    }

    const btn = document.getElementById('cmov-btn-guardar');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

    try {
      // 1. Guardar movimiento en DB
      const mov = await DB.crearMovimientoCaja({
        tipo, descripcion: desc, origenPersona: origenP, origenBolsillo: origenB,
        destinoPersona: destinoPFinal, destinoBolsillo: destinoBFinal,
        monto, moneda, creadoPor: State.currentUser || null,
      });

      // 2. Actualizar saldos automáticamente
      await this._aplicarSaldos({ tipo, origenP, origenB, destinoPFinal, destinoBFinal, monto, moneda });

      // 3. Subir comprobante si hay
      if (file && mov?.id) {
        try { await DB.subirComprobanteCaja(mov.id, file); } catch(e) { console.warn('Comprobante no subido:', e); }
      }

      document.getElementById('caja-mov-overlay')?.remove();
      toast('Movimiento registrado.');
      this._tab = 'movimientos';
      this._movimientos = await DB.listarMovimientosCaja(200);
      App.goTo('cajas');
    } catch(e) {
      console.error(e);
      toast('Error al guardar el movimiento.');
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-check"></i> Registrar'; }
    }
  },

  async _aplicarSaldos({ tipo, origenP, origenB, destinoPFinal, destinoBFinal, monto, moneda }) {
    // Mapear moneda → bolsillo para actualizar origen y destino
    const bolsilloMoneda = { ARS: origenB, USD: origenB, USDT: 'USDT' };

    // Restar del origen
    if (origenP && origenB) {
      const actualOrigen = (State.cajas[origenP]?.[origenB] || 0) - monto;
      await DB.actualizarSaldoCaja(origenP, origenB, Math.max(0, actualOrigen));
      if (!State.cajas[origenP]) State.cajas[origenP] = {};
      State.cajas[origenP][origenB] = Math.max(0, actualOrigen);
    }

    // Sumar al destino
    if (destinoPFinal && destinoBFinal) {
      const actualDestino = (State.cajas[destinoPFinal]?.[destinoBFinal] || 0) + monto;
      await DB.actualizarSaldoCaja(destinoPFinal, destinoBFinal, actualDestino);
      if (!State.cajas[destinoPFinal]) State.cajas[destinoPFinal] = {};
      State.cajas[destinoPFinal][destinoBFinal] = actualDestino;
    }
  },

  // ── Comprobante ─────────────────────────────────────────────

  async verComprobante(path) {
    const url = await DB.getComprobanteCajaUrl(path);
    if (!url) { toast('No se pudo obtener el comprobante.'); return; }
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;cursor:zoom-out';
    overlay.innerHTML = `<img src="${url}" style="max-width:100%;max-height:90vh;border-radius:8px;object-fit:contain">`;
    overlay.onclick = () => overlay.remove();
    document.body.appendChild(overlay);
  },

  async adjuntarComprobante(movId) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*,application/pdf';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        await DB.subirComprobanteCaja(movId, file);
        toast('Comprobante adjuntado.');
        this._movimientos = await DB.listarMovimientosCaja(200);
        App.goTo('cajas');
      } catch(e) { toast('Error al subir el comprobante.'); }
    };
    input.click();
  },

  // ── Modal ajuste manual (existente) ─────────────────────────

  abrirModal(persona, bolsillo) {
    const actual = (State.cajas[persona] && State.cajas[persona][bolsillo]) || 0;
    const overlay = document.createElement('div');
    overlay.id = 'caja-edit-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(6px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    const isARS = bolsillo.startsWith('ARS');
    const isUSD = bolsillo.startsWith('USD');
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(360px,96vw);overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border)">
          <div style="font-size:14px;font-weight:700">Ajustar saldo</div>
          <div style="font-size:11px;color:var(--text-secondary)">${persona} · ${bolsillo}</div>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
          <div style="background:var(--bg-secondary);border-radius:8px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:11px;color:var(--text-secondary)">Saldo actual</span>
            <b style="font-size:15px">${isUSD ? State.fmtUSD(actual) : bolsillo==='USDT' ? actual+' USDT' : State.fmtARS(actual)}</b>
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Nuevo saldo</label>
            <input type="number" id="caja-nuevo-saldo" value="${actual}" step="${isUSD||bolsillo==='USDT'?'0.01':'1'}"
              style="width:100%;font-size:18px;font-weight:700;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
            ${[0.25,0.5,0.75,1,1.5,2].filter(m => isARS ? m >= 1 : true).slice(0,3).map(m =>
              `<button onclick="document.getElementById('caja-nuevo-saldo').value=(${actual}*${m}).toFixed(${isUSD||bolsillo==='USDT'?2:0})" style="font-size:10px;padding:5px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text-secondary);cursor:pointer">×${m}</button>`
            ).join('')}
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('caja-edit-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Cajas.guardarSaldo('${persona}','${bolsillo}')">✓ Guardar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    setTimeout(() => { const el = document.getElementById('caja-nuevo-saldo'); el?.focus(); el?.select(); }, 60);
  },

  async guardarSaldo(persona, bolsillo) {
    const input = document.getElementById('caja-nuevo-saldo');
    const nuevo = parseFloat(input?.value);
    if (isNaN(nuevo)) { toast('Ingresá un número válido.'); return; }
    document.getElementById('caja-edit-overlay')?.remove();
    if (!State.cajas[persona]) State.cajas[persona] = {};
    State.cajas[persona][bolsillo] = nuevo;
    await DB.actualizarSaldoCaja(persona, bolsillo, nuevo);
    Sheets.caja(persona, bolsillo, nuevo);
    App.goTo('cajas');
    toast(`Saldo de ${persona} — ${bolsillo} actualizado.`);
  }
};

window.Cajas = Cajas;
