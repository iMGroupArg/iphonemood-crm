const Cajas = {
  render() {
    const c = document.createElement('div');
    c.className = 'body-pad';
    let totalARS = 0, totalUSD = 0, totalUSDT = 0;
    Object.values(State.cajas).forEach(caja => {
      totalARS += (caja['ARS cash']||0) + (caja['ARS transferencia']||0);
      totalUSD += (caja['USD cash']||0) + (caja['USD transferencia']||0);
      totalUSDT += caja['USDT']||0;
    });

    c.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px" class="dash-grid-2">
        ${State.personas.map(p => {
          const caja = State.cajas[p] || {};
          const arsEquiv = (caja['ARS cash']||0) + (caja['ARS transferencia']||0) + ((caja['USD cash']||0)+(caja['USD transferencia']||0))*State.refBlue + (caja['USDT']||0)*State.refUsdt;
          return `<div class="card">
            <div class="card-title"><div class="av">${p.substring(0,2).toUpperCase()}</div> ${p}</div>
            ${['ARS cash','ARS transferencia','USD cash','USD transferencia','USDT'].map(b => `
              <div onclick="Cajas.editarSaldo('${p}','${b}')" style="display:flex;justify-content:space-between;padding:8px 4px;border-bottom:1px solid var(--border);font-size:12.5px;cursor:pointer;border-radius:6px" onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background='transparent'">
                <span style="color:var(--text-secondary)">${b}</span><b>${b==='USDT' ? (caja[b]||0).toLocaleString('es-AR')+' USDT' : b.startsWith('ARS') ? State.fmtARS(caja[b]||0) : State.fmtUSD(caja[b]||0)}</b>
              </div>`).join('')}
            <div style="display:flex;justify-content:space-between;padding-top:8px;font-weight:600">Total ARS equiv.<span style="color:var(--blue)">${State.fmtARS(arsEquiv)}</span></div>
          </div>`;
        }).join('')}
      </div>
      <div class="card">
        <div class="card-title"><i class="ti ti-sum"></i> Consolidado total</div>
        <div style="display:flex;gap:24px;flex-wrap:wrap">
          <div><label style="font-size:11px;color:var(--text-secondary)">ARS total</label><div style="font-size:19px;font-weight:600">${State.fmtARS(totalARS)}</div></div>
          <div><label style="font-size:11px;color:var(--text-secondary)">USD total</label><div style="font-size:19px;font-weight:600">${State.fmtUSD(totalUSD)}</div></div>
          <div><label style="font-size:11px;color:var(--text-secondary)">USDT total</label><div style="font-size:19px;font-weight:600">${totalUSDT.toLocaleString('es-AR')}</div></div>
          <div style="margin-left:auto;text-align:right"><label style="font-size:11px;color:var(--text-secondary)">Equivalente ARS (blue)</label><div style="font-size:19px;font-weight:600;color:var(--blue)">${State.fmtARS(totalARS + totalUSD*State.refBlue + totalUSDT*State.refUsdt)}</div></div>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:10px"><i class="ti ti-info-circle"></i> Tocá cualquier saldo para ajustarlo manualmente. Para administrar personas (renombrar o eliminar), andá a Panel de control → Cajas y personas.</div>
    `;
    return c;
  },

  async editarSaldo(persona, bolsillo) {
    const actual = (State.cajas[persona] && State.cajas[persona][bolsillo]) || 0;
    const nuevoStr = prompt(`Ajustar saldo de ${persona} — ${bolsillo}:`, actual);
    if (nuevoStr === null) return;
    const nuevo = parseFloat(nuevoStr);
    if (isNaN(nuevo)) { alert('Ingresá un número válido.'); return; }
    State.cajas[persona][bolsillo] = nuevo;
    await DB.actualizarSaldoCaja(persona, bolsillo, nuevo);
    Sheets.caja(persona, bolsillo, nuevo);
    App.goTo('cajas');
    toast(`Saldo de ${persona} — ${bolsillo} ajustado a ${nuevo.toLocaleString('es-AR')}.`);
  }
};


window.Cajas = Cajas;
