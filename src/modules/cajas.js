const Cajas = {
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
      <!-- Consolidado top -->
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

      <!-- Cajas por persona -->
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;margin-bottom:18px">
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
                <i class="ti ti-pencil" style="font-size:12px;color:var(--text-tertiary)"></i>
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
      </div>

      <div style="font-size:11px;color:var(--text-secondary);margin-top:4px"><i class="ti ti-info-circle"></i> Tocá cualquier saldo para ajustarlo. Para agregar o renombrar personas, andá a Panel de control → Cajas y personas.</div>
    `;
    return c;
  },

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
          <button class="btn btn-primary" onclick="Cajas.guardarSaldo('${persona}','${bolsillo}')"><i class="ti ti-check"></i> Guardar</button>
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
