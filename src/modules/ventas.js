const Ventas = {
  step: 0,
  STEPS: ['Cliente', 'Trade-In', 'Ítems', 'Pagos', 'Confirm.'],
  draft: null,
  selectedStockIds: [],
  _selectedRegalo: {}, // id -> bool
  invMode: 'manual',
  manualCat: 'iphone',

  // Cuánto de un pago corresponde al precio de lista (sin el diferencial de tarjeta).
  // El diferencial es ganancia extra, no cubre el saldo de la venta en sí.
  montoSinDiferencial(p) {
    if (!p.esTarjeta) return p.monto;
    return Math.max(0, p.monto - (p.diferencialArs ? p.diferencialArs / (p.cotizacionDiferencial || State.refBlue) : 0));
  },

  periodoVentas: 'mes',
  periodoDesde: '', periodoHasta: '',
  isMobile() { return window.innerWidth <= 768; },

  render() {
    const c = document.createElement('div');
    c.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;min-height:0';
    const mobile = this.isMobile();
    c.innerHTML = `
      <div style="padding:${mobile?'8px 12px':'12px 22px'};border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px;flex-shrink:0">
        <div style="display:flex;gap:4px;overflow-x:auto;-webkit-overflow-scrolling:touch;white-space:nowrap" id="ventas-periodo-tabs"></div>
        <button class="btn btn-primary" style="flex-shrink:0" onclick="Ventas.openNew()"><i class="ti ti-plus"></i>${mobile?' Nueva':' Nueva venta'}</button>
      </div>
      <div id="ventas-rango-libre" style="display:none;padding:8px ${mobile?'12':'22'}px;border-bottom:1px solid var(--border);gap:8px;align-items:center;flex-wrap:wrap">
        <input type="date" id="ventas-desde" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:8px;flex:1">
        <span style="font-size:12px;color:var(--text-secondary)">hasta</span>
        <input type="date" id="ventas-hasta" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:8px;flex:1">
        <button class="btn btn-sm btn-primary" onclick="Ventas.aplicarRangoLibre()">Aplicar</button>
      </div>
      <div id="ventas-metricas" style="flex-shrink:0"></div>
      <div class="body-pad" style="padding:0;overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1;min-height:0" id="ventas-list-host"></div>
      <div id="venta-modal-host"></div>
    `;
    setTimeout(() => { this.renderPeriodoTabs(); this.renderMetricas(); this.renderList(); }, 0);
    return c;
  },

  ventasDelPeriodo() {
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    return State.ventas.filter(v => {
      if (!v.fechaISO) return true;
      const f = new Date(v.fechaISO); f.setHours(0,0,0,0);
      if (this.periodoVentas === 'hoy') return f.getTime() === hoy.getTime();
      if (this.periodoVentas === 'semana') { const d=new Date(hoy); d.setDate(d.getDate()-7); return f>=d; }
      if (this.periodoVentas === 'mes') return f.getFullYear()===hoy.getFullYear()&&f.getMonth()===hoy.getMonth();
      if (this.periodoVentas === 'libre') {
        const desde=this.periodoDesde?new Date(this.periodoDesde):null;
        const hasta=this.periodoHasta?new Date(this.periodoHasta):null;
        if (desde&&f<desde) return false;
        if (hasta&&f>hasta) return false;
        return true;
      }
      return true;
    });
  },

  renderPeriodoTabs() {
    const tabs=[['hoy','Hoy'],['semana','Esta semana'],['mes','Este mes'],['libre','Rango libre']];
    const el=document.getElementById('ventas-periodo-tabs');
    if (!el) return;
    el.innerHTML=tabs.map(([k,l])=>`<button class="btn btn-sm ${this.periodoVentas===k?'btn-primary':''}" onclick="Ventas.setPeriodo('${k}')">${l}</button>`).join('');
    const rangoEl=document.getElementById('ventas-rango-libre');
    if (rangoEl) rangoEl.style.display=this.periodoVentas==='libre'?'flex':'none';
  },

  setPeriodo(p) { this.periodoVentas=p; this.renderPeriodoTabs(); this.renderMetricas(); this.renderList(); },

  aplicarRangoLibre() {
    this.periodoDesde=document.getElementById('ventas-desde')?.value||'';
    this.periodoHasta=document.getElementById('ventas-hasta')?.value||'';
    this.renderMetricas(); this.renderList();
  },

  renderMetricas() {
    const el=document.getElementById('ventas-metricas');
    if (!el) return;
    const ventas=this.ventasDelPeriodo();

    const volumen = ventas.reduce((s,v) => s + v.items.reduce((a,i) => a + i.precio, 0), 0);
    const margenTotal = ventas.reduce((s,v) => s + v.items.reduce((a,i) => a + (i.precio - (i.costo||0)), 0), 0);
    const margenXEquipo = ventas.length ? margenTotal / ventas.length : 0;
    const diferencial = ventas.reduce((s,v) => {
      const totalVenta = v.items.reduce((a,i) => a + i.precio, 0);
      const totalPagado = (v.pagos||[]).reduce((a,p) => a + p.monto, 0) + (v.tradeIn?.valor||0);
      return s + Math.max(0, totalPagado - totalVenta);
    }, 0);
    const ticketProm = ventas.length ? volumen / ventas.length : 0;

    if (this.isMobile()) {
      // Tira compacta de 3 métricas clave + scrollable
      el.innerHTML = `
        <div style="display:flex;border-bottom:1px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch">
          <div style="flex:1;min-width:100px;padding:10px 12px;border-right:1px solid var(--border)">
            <div style="font-size:10px;color:var(--text-secondary);margin-bottom:2px">${ventas.length} venta(s)</div>
            <div style="font-size:15px;font-weight:700;color:var(--blue)">${State.fmtUSD(volumen)}</div>
            <div style="font-size:9px;color:var(--text-secondary)">Volumen</div>
          </div>
          <div style="flex:1;min-width:100px;padding:10px 12px;border-right:1px solid var(--border)">
            <div style="font-size:10px;color:var(--text-secondary);margin-bottom:2px">Margen</div>
            <div style="font-size:15px;font-weight:700;color:${margenTotal>=0?'var(--green)':'var(--red)'}">${State.fmtUSD(margenTotal)}</div>
            <div style="font-size:9px;color:var(--text-secondary)">x venta: ${State.fmtUSD(margenXEquipo)}</div>
          </div>
          <div style="flex:1;min-width:90px;padding:10px 12px">
            <div style="font-size:10px;color:var(--text-secondary);margin-bottom:2px">Ticket prom.</div>
            <div style="font-size:15px;font-weight:700;color:var(--text)">${State.fmtUSD(ticketProm)}</div>
            ${diferencial>0?`<div style="font-size:9px;color:var(--purple)">+${State.fmtUSD(diferencial)} tarjeta</div>`:'<div style="font-size:9px;color:var(--text-secondary)"> </div>'}
          </div>
        </div>`;
      return;
    }

    const kpis = [
      { label:'Volumen vendido',   val:State.fmtUSD(volumen),      sub:`${ventas.length} venta(s) en el período`, emoji:'💰', color:'var(--blue)' },
      { label:'Margen total',      val:State.fmtUSD(margenTotal),  sub:'Precio venta − costo',                    emoji: margenTotal>=0?'📈':'📉', color:margenTotal>=0?'var(--green)':'var(--red)' },
      { label:'Margen por venta',  val:State.fmtUSD(margenXEquipo),sub:'Margen total ÷ cantidad de ventas',       emoji: margenXEquipo>=0?'📊':'⚠️', color:margenXEquipo>=0?'var(--green)':'var(--red)' },
      { label:'Diferencial tarjeta',val:State.fmtUSD(diferencial), sub:'Ganancia financiera por recargo',         emoji:'💳', color:'var(--purple)' },
      { label:'Ticket promedio',   val:State.fmtUSD(ticketProm),   sub:'Volumen ÷ cantidad de ventas',            emoji:'🧾', color:'var(--text)' },
    ];
    el.style.cssText = 'padding:14px 22px;border-bottom:1px solid var(--border);display:grid;grid-template-columns:repeat(5,1fr);gap:10px';
    el.innerHTML = kpis.map(k=>`
      <div class="card" style="padding:12px 14px;margin-bottom:0;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;min-height:90px">
        <div style="min-width:0;flex:1">
          <label style="font-size:10.5px;color:var(--text-secondary);display:block;margin-bottom:3px">${k.label}</label>
          <div style="font-size:17px;font-weight:700;color:${k.color};word-break:break-word">${k.val}</div>
          <div style="font-size:10px;color:var(--text-secondary);margin-top:2px">${k.sub}</div>
        </div>
        <div style="width:36px;height:36px;border-radius:9px;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px">
          ${k.emoji}
        </div>
      </div>`).join('');
  },

  renderList() {
    const host=document.getElementById('ventas-list-host');
    if (!host) return;
    const ventas=this.ventasDelPeriodo();
    const TIPO={minorista:'Minorista',mayorista:'Mayorista',revendedor:'Revendedor'};
    if (!ventas.length) {
      host.innerHTML=`<div class="empty-state"><i class="ti ti-receipt-off"></i>Sin ventas en este período</div>`;
      return;
    }
    if (this.isMobile()) {
      host.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px;padding:10px 12px">` +
        ventas.map(v => {
          const total=v.items.reduce((s,i)=>s+i.precio,0);
          const pagado=v.pagos.reduce((s,p)=>s+p.monto,0)+(v.tradeIn?.valor||0);
          const saldo=total-pagado;
          const cerrada=v.estado==='cerrada';
          const itemsStr=v.items.map(i=>i.nombre).join(', ');
          return `<div class="card" style="margin-bottom:0;padding:12px 14px" onclick="Ventas.viewSale(${v.id})">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px">
              <div style="min-width:0">
                <div style="font-size:13px;font-weight:700">${v.cliente}</div>
                <div style="font-size:11px;color:var(--text-secondary);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${itemsStr}</div>
              </div>
              <div style="text-align:right;flex-shrink:0">
                <div style="font-size:15px;font-weight:700;color:var(--blue)">${State.fmtUSD(total)}</div>
                <div style="font-size:10px;color:var(--text-secondary)">${v.fecha}</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <span class="badge b-blue" style="font-size:10px">${TIPO[v.tipoVenta]||'Minorista'}</span>
              <span class="badge ${cerrada?'b-green':'b-amber'}" style="font-size:10px">${cerrada?'✓ Cerrada':'Abierta'}</span>
              ${saldo>0.5?`<span style="font-size:10px;color:var(--red);font-weight:600">Pendiente: ${State.fmtUSD(saldo)}</span>`:''}
              <span style="font-size:10px;color:var(--text-secondary);margin-left:auto">#${v.id}</span>
            </div>
          </div>`;
        }).join('') + `</div>`;
      return;
    }
    host.innerHTML = `<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;padding:0 16px 12px">
      <table><thead><tr>
        <th>#</th><th>Fecha</th><th>Cliente</th><th>Tipo</th><th>Ítems</th><th>Total</th><th>Pagos</th><th>Estado</th><th></th>
      </tr></thead><tbody>` +
      ventas.map(v=>{
        const total=v.items.reduce((s,i)=>s+i.precio,0);
        const cerrada=v.estado==='cerrada';
        const pagosHtml=v.pagos.length
          ? v.pagos.map(p=>`<div style="font-size:10.5px;color:var(--text-secondary);white-space:nowrap">${p.persona} · ${(p.bolsillo||'').replace('transferencia','transf.')}${p.esTarjeta?' <span class="badge b-purple" style="font-size:8px">Tarjeta</span>':''} — <b>${State.fmtUSD(p.monto)}</b></div>`).join('')
          : `<span style="font-size:10.5px;color:var(--text-secondary)">Sin pagos</span>`;
        return `<tr>
          <td style="font-weight:600">#${v.id}</td>
          <td style="font-size:11.5px">${v.fecha}</td>
          <td>${v.cliente}${v.clienteTel?`<div style="font-size:10px;color:var(--text-secondary)">${v.clienteTel}</div>`:''}</td>
          <td><span class="badge b-blue" style="font-size:10px">${TIPO[v.tipoVenta]||'Minorista'}</span></td>
          <td style="font-size:11.5px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${v.items.map(i=>i.nombre).join(', ')}</td>
          <td><b>${State.fmtUSD(total)}</b></td>
          <td style="min-width:160px">${pagosHtml}</td>
          <td>${this.estadoToggle(cerrada)}</td>
          <td><button class="btn btn-sm" onclick="Ventas.viewSale(${v.id})">👁️ Ver</button></td>
        </tr>`;
      }).join('') + `</tbody></table></div>`;
  },

  // Toggle visual de estado, como el de CocosCRM: dos píldoras, una resaltada según el estado actual.
  // Es informativo (no clickeable para cambiar estado directo) — el cambio de estado real
  // ocurre por el flujo normal de pagos/anulación, no tocando el toggle.
  estadoToggle(cerrada) {
    return `
      <span class="badge ${cerrada?'b-gray':'b-amber'}" style="opacity:${cerrada?'0.45':'1'}">Abierta</span>
      <span class="badge ${cerrada?'b-green':'b-gray'}" style="opacity:${cerrada?'1':'0.45'}">Cerrada</span>
    `;
  },

  DRAFT_KEY: 'iphonemood_venta_draft',

  // Guarda el borrador actual en localStorage — sobrevive a recargas de página,
  // a diferencia de la memoria de JavaScript que se pierde si el navegador
  // descarga la pestaña por inactividad.
  guardarBorrador() {
    if (!this.draft) return;
    try {
      localStorage.setItem(this.DRAFT_KEY, JSON.stringify({ draft: this.draft, step: this.step, guardadoEn: Date.now() }));
    } catch (e) { /* si falla el guardado local, no interrumpimos el flujo de venta */ }
  },
  borrarBorrador() {
    try { localStorage.removeItem(this.DRAFT_KEY); } catch (e) {}
  },
  hayBorradorPendiente() {
    try {
      const raw = localStorage.getItem(this.DRAFT_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      // Ignoramos borradores de más de 24hs, para no resucitar algo muy viejo por error
      if (Date.now() - (data.guardadoEn || 0) > 24 * 60 * 60 * 1000) { this.borrarBorrador(); return null; }
      return data;
    } catch (e) { return null; }
  },

  openNew() {
    const pendiente = this.hayBorradorPendiente();
    if (pendiente && pendiente.draft && (pendiente.draft.items?.length || pendiente.draft.cliente)) {
      this.mostrarRecuperarBorrador(pendiente);
      return;
    }
    this.draft = { cliente: '', clienteTel: '', clienteDni: '', clienteEmail: '', tipoVenta: 'minorista', vendedor: '', fechaVenta: new Date().toISOString().slice(0,10), tradeIn: null, items: [], pagos: [], comisionVendedor: 0 };
    this.step = 0;
    this.selectedStockIds = []; this._selectedRegalo = {};
    this.invMode = 'manual';
    this.showModal();
  },

  mostrarRecuperarBorrador(pendiente) {
    const host = document.getElementById('venta-modal-host');
    const minsAtras = Math.round((Date.now() - pendiente.guardadoEn) / 60000);
    host.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:200" onclick="if(event.target===this)Ventas.closeModal()">
        <div style="width:380px;max-width:92vw;background:var(--bg-elevated);border-radius:14px;padding:20px" onclick="event.stopPropagation()">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
            <h3 style="font-size:15px;font-weight:600">⚠️ Venta sin terminar</h3>
            <button onclick="Ventas.closeModal()" style="background:none;border:none;cursor:pointer;font-size:20px;color:var(--red);line-height:1;padding:0 2px">✕</button>
          </div>
          <p style="font-size:12.5px;color:var(--text-secondary);margin-bottom:14px">
            Había una venta en progreso para <b>${pendiente.draft.cliente || 'un cliente'}</b>
            (${pendiente.draft.items?.length || 0} ítem(s)), hace ${minsAtras < 1 ? 'menos de un minuto' : minsAtras + ' min'}.
            ¿Querés continuarla o empezar de cero?
          </p>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn" onclick="Ventas.descartarBorradorYEmpezarNueva()">Empezar de cero</button>
            <button class="btn btn-primary" onclick="Ventas.recuperarBorrador()">▶ Continuar</button>
          </div>
        </div>
      </div>
    `;
  },
  recuperarBorrador() {
    const pendiente = this.hayBorradorPendiente();
    if (!pendiente) { this.openNew(); return; }
    this.draft = pendiente.draft;
    this.step = pendiente.step || 0;
    this.selectedStockIds = []; this._selectedRegalo = {};
    this.invMode = 'manual';
    this.showModal();
    toast('Venta recuperada. Revisá los datos antes de continuar.');
  },
  descartarBorradorYEmpezarNueva() {
    this.borrarBorrador();
    this.draft = { cliente: '', clienteTel: '', clienteDni: '', clienteEmail: '', tipoVenta: 'minorista', vendedor: '', fechaVenta: new Date().toISOString().slice(0,10), tradeIn: null, items: [], pagos: [], comisionVendedor: 0 };
    this.step = 0;
    this.selectedStockIds = []; this._selectedRegalo = {};
    this.invMode = 'manual';
    this.showModal();
  },

  showModal() {
    const host = document.getElementById('venta-modal-host');
    const mobile = this.isMobile();
    const overlay = mobile
      ? 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:200;display:flex;flex-direction:column;justify-content:flex-end'
      : 'position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:200';
    const card = mobile
      ? 'display:flex;flex-direction:column;max-height:96dvh;background:var(--bg-elevated);border-radius:18px 18px 0 0;overflow:hidden'
      : 'width:600px;max-width:94vw;max-height:88vh;background:var(--bg-elevated);border-radius:14px;display:flex;flex-direction:column;overflow:hidden';
    host.innerHTML = `
      <div style="${overlay}" onkeydown="if(event.key==='Enter'){event.preventDefault();}">
        <div style="${card}">
          <div style="padding:${mobile?'10px 14px':'14px 20px'};border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
            <h3 style="font-size:${mobile?'14px':'15px'};font-weight:600">Nueva venta</h3>
            <button onclick="Ventas.closeModal()" style="background:none;border:none;cursor:pointer;color:var(--red);font-size:22px;line-height:1;padding:2px 6px;border-radius:6px;transition:background .15s" onmouseover="this.style.background='rgba(239,68,68,.12)'" onmouseout="this.style.background='none'">✕</button>
          </div>
          <div style="padding:${mobile?'10px 14px':'14px 20px'};border-bottom:1px solid var(--border);display:flex;gap:${mobile?'2px':'4px'};flex-shrink:0" id="venta-stepper"></div>
          <div style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:${mobile?'14px':'18px 20px'}" id="venta-step-body"></div>
          <div style="padding:${mobile?'10px 14px':'13px 20px'};border-top:1px solid var(--border);display:flex;justify-content:space-between;flex-shrink:0">
            <button class="btn" id="venta-btn-prev" onclick="Ventas.prevStep()">Anterior</button>
            <button class="btn btn-primary" id="venta-btn-next" onclick="Ventas.nextStep()">Siguiente</button>
          </div>
        </div>
      </div>
    `;
    this.renderStep();
  },
  closeModal() {
    document.getElementById('venta-modal-host').innerHTML = '';
    this.borrarBorrador();
  },

  renderStep() {
    const mobile = this.isMobile();
    document.getElementById('venta-stepper').innerHTML = this.STEPS.map((s, i) => {
      const done = i < this.step, active = i === this.step;
      return `<div style="flex:1;text-align:center">
        <div style="width:${mobile?'22px':'24px'};height:${mobile?'22px':'24px'};border-radius:50%;background:${done||active?'var(--blue)':'var(--bg-secondary)'};color:${done||active?'#fff':'var(--text-secondary)'};display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600">${done?'✓':i+1}</div>
        ${mobile?`<div style="font-size:8px;color:${active?'var(--blue)':'var(--text-secondary)'};margin-top:1px;font-weight:${active?'600':'400'}">${s}</div>` : `<div style="font-size:9.5px;color:${active?'var(--blue)':'var(--text-secondary)'};margin-top:2px;font-weight:${active?'600':'400'}">${s}</div>`}
      </div>`;
    }).join('');
    document.getElementById('venta-btn-prev').style.opacity = this.step === 0 ? '0.4' : '1';
    document.getElementById('venta-btn-next').textContent = this.step === 4 ? 'Confirmar venta' : 'Siguiente';

    const body = document.getElementById('venta-step-body');
    if (this.step === 0) body.innerHTML = this.stepCliente();
    else if (this.step === 1) body.innerHTML = this.stepTradeIn();
    else if (this.step === 2) body.innerHTML = this.stepItems();
    else if (this.step === 3) body.innerHTML = this.stepPagos();
    else body.innerHTML = this.stepConfirm();
  },

  _formRow(cols) {
    const mobile = this.isMobile();
    return `<div style="display:grid;grid-template-columns:${mobile?'1fr':cols};gap:10px;margin-bottom:10px">`;
  },
  _lbl(text) { return `<label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">${text}</label>`; },
  _inp(style='') { return `width:100%;font-size:${this.isMobile()?'14px':'12px'};padding:${this.isMobile()?'9px 10px':'7px 10px'};border:1px solid var(--border-strong);border-radius:8px;${style}`; },
  _sel(style='') { return `width:100%;font-size:${this.isMobile()?'14px':'12px'};padding:${this.isMobile()?'9px 10px':'7px 10px'};border:1px solid var(--border-strong);border-radius:8px;background:var(--bg-secondary);color:var(--text);${style}`; },

  _clientesGuardados() {
    const mapa = {};
    [...State.ventas].sort((a,b) => (b.id||0)-(a.id||0)).forEach(v => {
      const nombre = (v.cliente||'').trim();
      if (!nombre || nombre === 'Consumidor final') return;
      if (!mapa[nombre.toLowerCase()]) mapa[nombre.toLowerCase()] = { nombre, tel: v.clienteTel||'', dni: v.clienteDni||'', email: v.clienteEmail||'' };
    });
    return Object.values(mapa);
  },

  stepCliente() {
    const d = this.draft;
    return `
      <style>
        #vf-cliente-wrap { position:relative; }
        #vf-cliente-suggestions { position:absolute; top:100%; left:0; right:0; background:var(--card-bg,#1e1e1e); border:1px solid var(--border,#333); border-radius:8px; z-index:999; max-height:200px; overflow-y:auto; display:none; box-shadow:0 4px 16px rgba(0,0,0,.4); }
        #vf-cliente-suggestions div { padding:10px 14px; cursor:pointer; font-size:13px; border-bottom:1px solid var(--border,#2a2a2a); }
        #vf-cliente-suggestions div:last-child { border-bottom:none; }
        #vf-cliente-suggestions div:hover { background:var(--blue,.2); background-color:rgba(59,130,246,.15); }
        #vf-cliente-suggestions .sug-sub { font-size:11px; color:var(--text-secondary,#999); margin-top:2px; }
      </style>
      ${this._formRow('1fr 1fr')}
        <div>${this._lbl('Nombre del cliente')}<div id="vf-cliente-wrap"><input type="text" id="vf-cliente" value="${d.cliente||''}" placeholder="Consumidor final" style="${this._inp()}" autocomplete="off" oninput="Ventas._filtrarClientes(this.value)"><div id="vf-cliente-suggestions"></div></div></div>
        <div>${this._lbl('Teléfono')}<input type="text" id="vf-cliente-tel" value="${d.clienteTel||''}" placeholder="ej: 3413686909" style="${this._inp()}" inputmode="tel"></div>
      </div>
      ${this._formRow('1fr 1fr')}
        <div>${this._lbl('DNI')}<input type="text" id="vf-cliente-dni" value="${d.clienteDni||''}" placeholder="ej: 34139974" style="${this._inp()}" inputmode="numeric"></div>
        <div>${this._lbl('Email <span style="font-weight:400;color:var(--text-secondary)">(opcional)</span>')}<input type="email" id="vf-cliente-email" value="${d.clienteEmail||''}" placeholder="ej: cliente@gmail.com" style="${this._inp()}" inputmode="email"></div>
      </div>
      ${this._formRow('1fr 1fr 1fr')}
        <div>${this._lbl('Tipo de venta')}<select id="vf-tipo-venta" style="${this._sel()}">
          <option value="minorista" ${(d.tipoVenta||'minorista')==='minorista'?'selected':''}>Minorista</option>
          <option value="mayorista" ${d.tipoVenta==='mayorista'?'selected':''}>Mayorista</option>
          <option value="revendedor" ${d.tipoVenta==='revendedor'?'selected':''}>Revendedor</option>
        </select></div>
        <div>${this._lbl('Vendedor')}<select id="vf-vendedor" style="${this._sel()}">
          <option value="">Seleccionar</option>
          ${State.personas.map(p=>`<option ${d.vendedor===p?'selected':''}>${p}</option>`).join('')}
        </select></div>
        <div>${this._lbl('Fecha de venta')}<input type="date" id="vf-fecha-venta" value="${d.fechaVenta||new Date().toISOString().slice(0,10)}" max="${new Date().toISOString().slice(0,10)}" style="${this._inp()}"></div>
      </div>
    `;
  },

  _filtrarClientes(query) {
    const box = document.getElementById('vf-cliente-suggestions');
    if (!box) return;
    const q = query.trim().toLowerCase();
    if (!q) { box.style.display = 'none'; return; }
    const matches = this._clientesGuardados().filter(c => c.nombre.toLowerCase().includes(q)).slice(0, 8);
    if (!matches.length) { box.style.display = 'none'; return; }
    box.innerHTML = matches.map(c => `
      <div onclick="Ventas._seleccionarCliente(${JSON.stringify(c).replace(/"/g,'&quot;')})">
        ${c.nombre}
        ${c.tel || c.dni ? `<div class="sug-sub">${[c.tel, c.dni ? 'DNI: '+c.dni : ''].filter(Boolean).join(' · ')}</div>` : ''}
      </div>`).join('');
    box.style.display = 'block';
    // Cerrar al hacer click fuera
    const cerrar = (e) => { if (!box.contains(e.target) && e.target.id !== 'vf-cliente') { box.style.display='none'; document.removeEventListener('click', cerrar); } };
    document.addEventListener('click', cerrar);
  },

  _seleccionarCliente(c) {
    const inp = document.getElementById('vf-cliente');
    const tel = document.getElementById('vf-cliente-tel');
    const dni = document.getElementById('vf-cliente-dni');
    const email = document.getElementById('vf-cliente-email');
    if (inp) inp.value = c.nombre;
    if (tel && c.tel) tel.value = c.tel;
    if (dni && c.dni) dni.value = c.dni;
    if (email && c.email) email.value = c.email;
    const box = document.getElementById('vf-cliente-suggestions');
    if (box) box.style.display = 'none';
  },

  _TI_CATS: [
    { k:'iphone', label:'iPhone', icon:'ti-device-mobile' },
    { k:'android', label:'Android', icon:'ti-device-mobile' },
    { k:'mac', label:'Mac', icon:'ti-device-laptop' },
    { k:'ipad', label:'iPad', icon:'ti-device-ipad' },
    { k:'watch', label:'Apple Watch', icon:'ti-device-watch' },
    { k:'audio', label:'Audio', icon:'ti-headphones' },
    { k:'otro', label:'Personalizado', icon:'ti-box' },
  ],
  _tiCat: 'iphone',

  stepTradeIn() {
    const d = this.draft;
    const active = !!d.tradeIn;
    const cat = d.tradeIn?.cat || this._tiCat || 'iphone';
    const STORAGE = ['32GB','64GB','128GB','256GB','512GB','1TB','2TB'];
    const COLORES = ['Negro','Blanco','Azul','Verde','Rosa','Rojo','Titanio Natural','Titanio Azul','Titanio Negro','Plata','Dorado','Gris Espacial','Otro'];
    const ESTADO = ['Nuevo / Sellado','Excelente','Muy bueno','Bueno','Con detalles'];
    const GRADO = ['Sin grado','A+','A','B','C'];
    const modelos = Stock.MODELOS_POR_CAT[cat] || [];
    const hasSpecs = ['iphone','android','mac','ipad'].includes(cat);
    const hasBat = ['iphone','android','ipad'].includes(cat);
    const ti = d.tradeIn || {};

    const INPUT = 'width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg-secondary);color:var(--text)';
    const LABEL = 'font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px';

    return `
      <!-- Checkbox principal -->
      <label style="display:flex;align-items:flex-start;gap:10px;font-size:13px;cursor:pointer;background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:14px">
        <input type="checkbox" id="vf-ti-active" ${active?'checked':''} onchange="Ventas.toggleTI()" style="margin-top:2px;width:15px;height:15px;flex-shrink:0">
        <span><b>El cliente entrega un producto como parte de pago</b><br><span style="font-size:11px;color:var(--text-secondary)">Se descuenta del total y el equipo se suma al stock automáticamente.</span></span>
      </label>

      <div id="vf-ti-form" style="display:${active?'flex':'none'};flex-direction:column;gap:14px">

        <!-- Revisar antes de vender -->
        <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:12px 14px">
          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:12.5px">
            <input type="checkbox" id="vf-ti-revisar" ${ti.revisar?'checked':''} style="margin-top:2px;width:14px;height:14px;flex-shrink:0">
            <span><b>Mandar a revisar en servicio técnico antes de ponerlo a la venta</b><br>
            <span style="font-size:11px;color:var(--blue)">El equipo entra como "En revisión": no se puede vender ni aparece en el catálogo, y queda en Servicio técnico → A revisar hasta que lo marques disponible.</span></span>
          </label>
        </div>

        <!-- Categoría -->
        <div>
          <label style="${LABEL}">Categoría de Producto *</label>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px" id="ti-cat-grid">
            ${this._TI_CATS.map(c => `
              <div onclick="Ventas.tiSelectCat('${c.k}')" data-ticat="${c.k}"
                style="border:1.5px solid ${cat===c.k?'var(--blue)':'var(--border)'};background:${cat===c.k?'var(--blue-light)':'var(--bg)'};border-radius:8px;padding:8px 4px;text-align:center;cursor:pointer">
                <i class="ti ${c.icon}" style="font-size:18px;color:${cat===c.k?'var(--blue)':'var(--text-secondary)'};display:block;margin-bottom:3px"></i>
                <span style="font-size:9.5px;color:${cat===c.k?'var(--blue)':'var(--text-secondary)'};font-weight:${cat===c.k?'600':'400'}">${c.label}</span>
              </div>`).join('')}
          </div>
        </div>

        <div id="ti-detalle">
          ${this._tiDetalleHTML(cat, ti)}
        </div>

      </div>`;
  },

  _tiDetalleHTML(cat, ti={}) {
    const STORAGE = ['32GB','64GB','128GB','256GB','512GB','1TB','2TB'];
    const COLORES = ['Negro','Blanco','Azul','Verde','Rosa','Rojo','Titanio Natural','Titanio Azul','Titanio Negro','Plata','Dorado','Gris Espacial','Otro'];
    const ESTADO = ['Nuevo / Sellado','Excelente','Muy bueno','Bueno','Con detalles'];
    const GRADO = ['Sin grado','A+','A','B','C'];
    const modelos = Stock.MODELOS_POR_CAT[cat] || [];
    const hasSpecs = ['iphone','android','mac','ipad'].includes(cat);
    const hasBat = ['iphone','android','ipad'].includes(cat);
    const LABEL_ST = 'font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px';
    const INPUT_ST = 'width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg-secondary);color:var(--text)';
    const catLabel = this._TI_CATS.find(c=>c.k===cat)?.label || cat;

    return `
      <div style="font-size:13px;font-weight:700;margin-bottom:10px">Detalles del ${catLabel}</div>

      ${cat !== 'otro' ? `
      <!-- IMEI + Modelo -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div>
          <label style="${LABEL_ST}">IMEI <span style="font-weight:400">(Opcional)</span></label>
          <input type="text" id="vf-ti-imei" value="${ti.imei||''}" placeholder="123456789012345" style="${INPUT_ST};font-family:monospace">
          <div style="font-size:10px;color:var(--text-secondary);margin-top:3px">Podés dejarlo vacío. Se permite vender sin IMEI.</div>
        </div>
        <div>
          <label style="${LABEL_ST}">Modelo *</label>
          <select id="vf-ti-modelo" onchange="Ventas.tiToggleModeloOtro()" style="${INPUT_ST}">
            <option value="">Seleccionar modelo</option>
            ${modelos.map(m=>`<option ${ti.modelo===m?'selected':''}>${m}</option>`).join('')}
            <option value="__otro__" ${ti.modelo && !modelos.includes(ti.modelo)?'selected':''}>Otro (escribir)</option>
          </select>
          <input type="text" id="vf-ti-modelo-otro" value="${ti.modelo && !modelos.includes(ti.modelo)?ti.modelo:''}" placeholder="Escribí el modelo" style="${INPUT_ST};margin-top:6px;display:${ti.modelo && !modelos.includes(ti.modelo)?'block':'none'}">
        </div>
      </div>` : `
      <!-- Nombre libre -->
      <div style="margin-bottom:12px">
        <label style="${LABEL_ST}">Nombre del producto *</label>
        <input type="text" id="vf-ti-nombre-libre" value="${ti.modelo||''}" placeholder="ej: Auriculares Sony WH-1000XM5" style="${INPUT_ST}">
      </div>`}

      ${hasSpecs ? `
      <!-- Storage + Color -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div>
          <label style="${LABEL_ST}">Storage *</label>
          <select id="vf-ti-storage" style="${INPUT_ST}">
            <option value="">Seleccionar almacenamiento</option>
            ${STORAGE.map(s=>`<option ${ti.storage===s?'selected':''}>${s}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="${LABEL_ST}">Color *</label>
          <select id="vf-ti-color" style="${INPUT_ST}">
            <option value="">Seleccionar color</option>
            ${COLORES.map(c=>`<option ${ti.color===c?'selected':''}>${c}</option>`).join('')}
          </select>
        </div>
      </div>` : ''}

      ${hasBat ? `
      <!-- Batería + Estado -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div>
          <label style="${LABEL_ST}">Batería %</label>
          <input type="number" id="vf-ti-bateria" value="${ti.bateriaPct||''}" placeholder="85" min="0" max="100" style="${INPUT_ST}">
        </div>
        <div>
          <label style="${LABEL_ST}">Estado del Producto</label>
          <select id="vf-ti-estado" style="${INPUT_ST}">
            <option value="">Seleccionar</option>
            ${ESTADO.map(e=>`<option ${ti.estadoProducto===e?'selected':''}>${e}</option>`).join('')}
          </select>
        </div>
      </div>` : ''}

      <!-- Grado -->
      <div style="margin-bottom:12px">
        <label style="${LABEL_ST}">Grado estético</label>
        <select id="vf-ti-grado" style="${INPUT_ST}">
          ${GRADO.map(g=>`<option ${(ti.grado||'Sin grado')===g?'selected':''}>${g}</option>`).join('')}
        </select>
        <div style="font-size:10px;color:var(--text-secondary);margin-top:3px">Opcional. Califica el estado estético del equipo recibido (A+ excelente — C con marcas visibles).</div>
      </div>

      <!-- Valor tomado -->
      <div style="margin-bottom:12px">
        <label style="${LABEL_ST}">Valor en que se toma el producto *</label>
        <input type="number" id="vf-ti-valor" value="${ti.valor||''}" placeholder="ej: 500" style="${INPUT_ST}">
        <div style="font-size:10px;color:var(--text-secondary);margin-top:3px">Este valor se restará automáticamente del total de la venta</div>
      </div>

      <!-- Notas -->
      <div style="margin-bottom:12px">
        <label style="${LABEL_ST}">Notas del Producto</label>
        <textarea id="vf-ti-notas" placeholder="Describe el estado del producto, rayones, golpes, etc..." maxlength="200"
          style="${INPUT_ST};resize:vertical;min-height:70px">${ti.notas||''}</textarea>
        <div style="font-size:10px;color:var(--text-secondary);margin-top:3px">Máximo 200 caracteres</div>
      </div>

      <!-- Depósito -->
      <div>
        <label style="${LABEL_ST}"><i class="ti ti-building-warehouse" style="font-size:11px"></i> Depósito</label>
        <select id="vf-ti-custodio" style="${INPUT_ST}">
          ${State.personas.map(p=>`<option ${ti.custodio===p?'selected':''}>${p}</option>`).join('')}
        </select>
      </div>
    `;
  },

  tiSelectCat(cat) {
    this._tiCat = cat;
    // Actualizar grilla visual
    document.querySelectorAll('[data-ticat]').forEach(el => {
      const active = el.dataset.ticat === cat;
      el.style.borderColor = active ? 'var(--blue)' : 'var(--border)';
      el.style.background = active ? 'var(--blue-light)' : 'var(--bg)';
      el.querySelector('i').style.color = active ? 'var(--blue)' : 'var(--text-secondary)';
      el.querySelector('span').style.color = active ? 'var(--blue)' : 'var(--text-secondary)';
      el.querySelector('span').style.fontWeight = active ? '600' : '400';
    });
    // Re-render solo la sección de detalles
    document.getElementById('ti-detalle').innerHTML = this._tiDetalleHTML(cat, this.draft.tradeIn || {});
  },

  tiToggleModeloOtro() {
    const val = document.getElementById('vf-ti-modelo')?.value;
    const otro = document.getElementById('vf-ti-modelo-otro');
    if (otro) otro.style.display = val === '__otro__' ? 'block' : 'none';
  },

  toggleTI() {
    const active = document.getElementById('vf-ti-active').checked;
    document.getElementById('vf-ti-form').style.display = active ? 'flex' : 'none';
  },

  _leerTradeIn() {
    const active = document.getElementById('vf-ti-active')?.checked;
    if (!active) return null;
    const cat = this._tiCat || 'iphone';
    let modelo = '';
    if (cat === 'otro') {
      modelo = document.getElementById('vf-ti-nombre-libre')?.value.trim() || '';
    } else {
      const sel = document.getElementById('vf-ti-modelo')?.value;
      modelo = sel === '__otro__' ? (document.getElementById('vf-ti-modelo-otro')?.value.trim() || '') : (sel || '');
    }
    return {
      cat,
      modelo,
      imei: document.getElementById('vf-ti-imei')?.value.trim() || '',
      storage: document.getElementById('vf-ti-storage')?.value || '',
      color: document.getElementById('vf-ti-color')?.value || '',
      bateriaPct: parseFloat(document.getElementById('vf-ti-bateria')?.value) || null,
      estadoProducto: document.getElementById('vf-ti-estado')?.value || '',
      grado: document.getElementById('vf-ti-grado')?.value || 'Sin grado',
      valor: parseFloat(document.getElementById('vf-ti-valor')?.value) || 0,
      notas: document.getElementById('vf-ti-notas')?.value.trim() || '',
      custodio: document.getElementById('vf-ti-custodio')?.value || '',
      revisar: document.getElementById('vf-ti-revisar')?.checked || false,
    };
  },

  stepItems() {
    const d = this.draft;
    const total = d.items.reduce((s, i) => s + i.precio, 0) - (d.tradeIn?.valor || 0);
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <b>Ítems agregados</b><span style="font-size:14px;font-weight:600;color:var(--blue)">${State.fmtUSD(Math.max(0,total))}</span>
      </div>
      ${d.items.map((it, idx) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 10px;background:var(--bg-secondary);border-radius:8px;margin-bottom:5px;font-size:12px;gap:8px">
        <div style="flex:1;min-width:0">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${it.nombre}${it.regalo?` <span style="font-size:10px;color:var(--green)">🎁 regalo</span>`:''}</div>
          ${it.imei?`<div style="font-size:10px;color:var(--text-secondary);font-family:monospace">IMEI: ${it.imei}</div>`:''}
          ${it.regalo?`<div style="font-size:10px;color:var(--text-secondary)">Costo: USD ${it.costo||0} (impacta en margen)</div>`:''}
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
          ${it.regalo ? `<span style="font-size:12px;font-weight:600;color:var(--green)">Gratis</span>` : `<span style="font-size:10px;color:var(--text-secondary)">USD</span>
          <input type="number" value="${it.precio}" min="0" step="0.01"
            onchange="Ventas.editItemPrecio(${idx},this.value)"
            style="width:72px;font-size:12px;font-weight:600;padding:3px 6px;border:1px solid var(--border-strong);border-radius:6px;background:var(--bg);color:var(--text);text-align:right">`}
          <button onclick="Ventas.removeItem(${idx})" title="Quitar" style="background:none;border:none;cursor:pointer;font-size:17px;padding:2px 4px;border-radius:5px;opacity:0.75;line-height:1" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.75">🗑️</button>
        </div>
      </div>`).join('')}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0">
        <button class="btn ${this.invMode==='manual'?'btn-primary':''}" onclick="Ventas.setInvMode('manual')">Carga manual</button>
        <button class="btn ${this.invMode==='inventario'?'btn-primary':''}" onclick="Ventas.setInvMode('inventario')">Desde inventario</button>
      </div>
      <div id="vf-item-form">${this.invMode === 'manual' ? this.manualItemForm() : this.inventoryForm()}</div>
    `;
  },
  setInvMode(m) { this.invMode = m; this._invFiltro = ''; document.getElementById('venta-step-body').innerHTML = this.stepItems(); },

  manualItemForm() {
    const mobile = this.isMobile();
    const inp = `font-size:${mobile?'14px':'12px'};padding:${mobile?'9px 10px':'7px 10px'};border:1px solid var(--border-strong);border-radius:8px`;
    return `
      <div style="display:grid;grid-template-columns:${mobile?'1fr':'1fr 1fr'};gap:8px;margin-bottom:8px">
        <input type="text" id="vf-m-nombre" placeholder="Nombre del producto" style="width:100%;${inp}">
        <input type="number" id="vf-m-costo" placeholder="Costo USD" style="width:100%;${inp}" inputmode="decimal">
      </div>
      <input type="number" id="vf-m-precio" placeholder="Precio de venta (USD)" style="width:100%;${inp};margin-bottom:8px" inputmode="decimal">
      <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="Ventas.addManualItem()"><i class="ti ti-plus"></i> Agregar ítem</button>
    `;
  },
  addManualItem() {
    const nombre = document.getElementById('vf-m-nombre').value.trim();
    const precio = parseFloat(document.getElementById('vf-m-precio').value) || 0;
    const costo = parseFloat(document.getElementById('vf-m-costo').value) || 0;
    if (!nombre || !precio) { toast('Completá nombre y precio.'); return; }
    this.draft.items.push({ nombre, precio, costo, stockId: null, imei: null });
    document.getElementById('venta-step-body').innerHTML = this.stepItems();
    this.guardarBorrador();
  },

  _invFiltro: '',
  _invCatFiltro: 'todos',
  _invCondicion: 'todos', // 'todos' | 'nuevo' | 'usado'

  _CATS_ACCESORIO: ['accesorio', 'audio', 'repuesto', 'herramienta', 'perfumeria', 'decant', 'otro'],
  _CATS_DISPOSITIVO: ['iphone', 'android', 'mac', 'ipad', 'watch'],

  _INV_CHIPS: [
    { key:'todos',       label:'Todos' },
    { key:'iphone',      label:'🍎 iPhone' },
    { key:'android',     label:'🤖 Android' },
    { key:'mac',         label:'💻 Mac' },
    { key:'ipad',        label:'📱 iPad' },
    { key:'watch',       label:'⌚ Watch' },
    { key:'audio',       label:'🎧 Audio' },
    { key:'accesorio',   label:'🔌 Accesorios' },
    { key:'repuesto',    label:'🔧 Repuestos' },
    { key:'herramienta', label:'🛠 Herramientas' },
    { key:'perfumeria',  label:'🌸 Perfumería' },
    { key:'decant',      label:'🧪 Decants' },
    { key:'otro',        label:'📦 Otro' },
  ],

  inventoryForm() {
    return `
      <div style="display:flex;gap:6px;margin-bottom:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:2px;scrollbar-width:none">
        ${this._INV_CHIPS.map(c => `<button onclick="Ventas._invCatFiltro='${c.key}';Ventas._renderInvLista()"
          style="padding:5px 12px;border-radius:20px;border:1px solid ${this._invCatFiltro===c.key?'var(--blue)':'var(--border)'};background:${this._invCatFiltro===c.key?'var(--blue)':'var(--bg-secondary)'};color:${this._invCatFiltro===c.key?'#fff':'var(--text)'};font-size:12px;cursor:pointer;white-space:nowrap;flex-shrink:0">${c.label}</button>`).join('')}
      </div>
      <div style="display:flex;gap:6px;margin-bottom:8px">
        ${[{k:'todos',l:'Todos'},{k:'nuevo',l:'✨ Nuevo'},{k:'usado',l:'🔄 Usado'}].map(c=>`<button onclick="Ventas._invCondicion='${c.k}';Ventas._renderInvLista()"
          style="padding:4px 10px;border-radius:20px;border:1px solid ${this._invCondicion===c.k?'var(--blue)':'var(--border)'};background:${this._invCondicion===c.k?'var(--blue)':'var(--bg-secondary)'};color:${this._invCondicion===c.k?'#fff':'var(--text)'};font-size:11px;cursor:pointer;white-space:nowrap">${c.l}</button>`).join('')}
      </div>
      <input id="inv-buscar" type="search" placeholder="Buscar producto..." value="${this._invFiltro || ''}"
        oninput="Ventas._invFiltro=this.value;Ventas._renderInvLista()"
        style="width:100%;padding:9px 12px;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box;margin-bottom:8px;font-family:var(--font)">
      <div id="inv-lista">${this._invListaHTML()}</div>
    `;
  },
  _renderInvLista() {
    const el = document.getElementById('inv-lista');
    if (el) el.innerHTML = this._invListaHTML();
    // Re-render chips to update active state
    const form = document.getElementById('vf-item-form');
    if (form) {
      const chipBtns = form.querySelectorAll('button[onclick*="_invCatFiltro"]');
      chipBtns.forEach((btn, i) => {
        const active = this._INV_CHIPS[i] && this._invCatFiltro === this._INV_CHIPS[i].key;
        btn.style.borderColor = active ? 'var(--blue)' : 'var(--border)';
        btn.style.background = active ? 'var(--blue)' : 'var(--bg-secondary)';
        btn.style.color = active ? '#fff' : 'var(--text)';
      });
    }
  },
  _invListaHTML() {
    const q = (this._invFiltro || '').toLowerCase().trim();
    const cat = this._invCatFiltro || 'todos';
    const disponibles = State.stock.filter(s => {
      if (State.getStock(s) <= 0) return false;
      const estado = s.estadoInventario || 'disponible';
      if (estado === 'vendido' || estado === 'eliminado') return false;
      if (q && !s.nombre.toLowerCase().includes(q)) return false;
      if (cat !== 'todos') return s.cat === cat;
      return true;
    }).filter(s => {
      if (this._invCondicion === 'nuevo') return (s.estadoProducto || '') === 'Nuevo / Sellado';
      if (this._invCondicion === 'usado') return (s.estadoProducto || '') !== 'Nuevo / Sellado';
      return true;
    });
    return `
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px">${disponibles.length} producto${disponibles.length!==1?'s':''} con stock disponible</div>
      <div style="display:flex;flex-direction:column;gap:8px;max-height:240px;overflow-y:auto">
        ${disponibles.map(s => {
          const sel = this.selectedStockIds.includes(s.id);
          const precioUSD = s.precioARS && s.cotiz ? +(s.precioARS / s.cotiz).toFixed(2) : 0;
          const esAccesorio = this._CATS_ACCESORIO.includes(s.cat);
          return `<div style="border:${sel?'2px solid var(--blue)':'1px solid var(--border)'};background:${sel?'var(--blue-light)':'var(--bg)'};border-radius:8px;padding:9px 11px;font-size:11.5px">
            <div onclick="Ventas.toggleStockSel('${s.id}')" style="cursor:pointer;margin-bottom:${sel?'8px':'0'}">
              <b style="font-size:12px">${s.nombre}</b><br>
              <span style="color:var(--text-secondary)">Costo: USD ${s.costoUSD}${precioUSD ? ' · Precio sugerido: USD ' + precioUSD : ''}</span>
            </div>
            ${sel ? (()=>{ const esRegalo = !!this._selectedRegalo[s.id]; return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px">
              ${esAccesorio ? `<label style="display:flex;align-items:center;gap:5px;font-size:11px;cursor:pointer;padding:3px 8px;border-radius:6px;border:1px solid ${esRegalo?'var(--green)':'var(--border)'};background:${esRegalo?'rgba(34,197,94,.1)':'var(--bg-secondary)'}" onclick="event.stopPropagation()">
                <input type="checkbox" id="inv-regalo-${s.id}" ${esRegalo?'checked':''} onchange="Ventas._toggleRegalo('${s.id}',this.checked)" style="accent-color:var(--green);cursor:pointer">
                <span>🎁 Regalo (gratis)</span>
              </label>` : ''}
              <label style="font-size:10px;color:var(--text-secondary);white-space:nowrap">Precio (USD):</label>
              <input type="number" id="inv-precio-${s.id}" value="${esRegalo ? 0 : (precioUSD || '')}" min="0" step="0.01" placeholder="0"
                ${esRegalo ? 'disabled' : ''}
                style="font-size:13px;font-weight:700;padding:4px 8px;border:1px solid var(--border-strong);border-radius:6px;width:100px;color:var(--text);background:var(--bg-secondary);opacity:${esRegalo?'0.4':'1'}"
                onclick="event.stopPropagation()">
            </div>`; })() : ''}
          </div>`;
        }).join('')}
      </div>
      ${this.selectedStockIds.length ? `<button class="btn btn-green" style="width:100%;justify-content:center;margin-top:10px" onclick="Ventas.addStockItems()">✓ Agregar ${this.selectedStockIds.length} seleccionado(s)</button>` : ''}
    `;
  },
  _toggleRegalo(id, isRegalo) {
    this._selectedRegalo[id] = isRegalo;
    const precioInput = document.getElementById(`inv-precio-${id}`);
    if (precioInput) {
      precioInput.value = isRegalo ? '0' : '';
      precioInput.disabled = isRegalo;
      precioInput.style.opacity = isRegalo ? '0.4' : '1';
    }
  },
  toggleStockSel(id) {
    const i = this.selectedStockIds.indexOf(id);
    if (i >= 0) this.selectedStockIds.splice(i, 1); else this.selectedStockIds.push(id);
    this._renderInvLista();
  },
  addStockItems() {
    this.selectedStockIds.forEach(id => {
      const s = State.stock.find(x => x.id === id);
      if (!s) return;
      const imei = s.imeis && s.imeis.length ? s.imeis[0] : null;
      const esRegalo = !!this._selectedRegalo[id];
      const precioIngresado = parseFloat(document.getElementById(`inv-precio-${id}`)?.value);
      const precioUSD = esRegalo ? 0 : ((!isNaN(precioIngresado) && precioIngresado >= 0) ? precioIngresado : (s.precioARS && s.cotiz ? +(s.precioARS / s.cotiz).toFixed(2) : 0));
      this.draft.items.push({ nombre: s.nombre, precio: precioUSD, costo: s.costoUSD, stockId: id, imei, regalo: esRegalo || undefined });
    });
    this.selectedStockIds = []; this._selectedRegalo = {};
    document.getElementById('venta-step-body').innerHTML = this.stepItems();
    this.guardarBorrador();
  },
  editItemPrecio(idx, val) {
    const precio = parseFloat(val);
    if (isNaN(precio) || precio < 0) return;
    this.draft.items[idx].precio = precio;
    // Actualizar solo el total visible sin re-render completo
    const totalEl = document.querySelector('#venta-step-body b + span');
    const total = this.draft.items.reduce((s, i) => s + i.precio, 0);
    const totDiv = document.getElementById('venta-step-body').querySelector('span[style*="blue"]');
    if (totDiv) totDiv.textContent = State.fmtUSD(Math.max(0, total));
    this.guardarBorrador();
  },
  removeItem(idx) { this.draft.items.splice(idx, 1); document.getElementById('venta-step-body').innerHTML = this.stepItems(); this.guardarBorrador(); },

  stepPagos() {
    const d = this.draft;
    const total = d.items.reduce((s, i) => s + i.precio, 0);
    const pagado = d.pagos.reduce((s, p) => s + Ventas.montoSinDiferencial(p), 0) + (d.tradeIn?.valor || 0);
    const saldo = Math.max(0, total - pagado);
    return `
      <div style="display:flex;gap:16px;padding:10px 0;border-bottom:1px solid var(--border);margin-bottom:12px">
        <div><div style="font-size:11px;color:var(--text-secondary)">Total venta</div><div style="font-size:16px;font-weight:600">${State.fmtUSD(total)}</div></div>
        <div><div style="font-size:11px;color:var(--text-secondary)">Saldo restante</div><div style="font-size:16px;font-weight:600;color:${saldo>0?'var(--red)':'var(--green)'}">${State.fmtUSD(saldo)}</div></div>
      </div>
      ${d.tradeIn?.valor > 0 ? `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 10px;background:var(--bg-secondary);border:1px solid var(--green);border-radius:8px;margin-bottom:5px;font-size:12px">
        <span style="color:var(--green)">🔄 Trade-In: ${d.tradeIn.modelo||'Equipo'}</span>
        <span style="color:var(--green);font-weight:600">${State.fmtUSD(d.tradeIn.valor)}</span>
      </div>` : ''}
      ${d.pagos.map((p, idx) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 10px;background:var(--bg-secondary);border-radius:8px;margin-bottom:5px;font-size:12px">
        <span>${p.persona} — ${p.bolsillo} — ${p.bolsillo?.startsWith('ARS') ? `$${Math.round(p.monto*(State.refBlue||1)).toLocaleString('es-AR')} ARS <span style="color:var(--text-secondary);font-size:10px">(≈ ${State.fmtUSD(p.monto)})</span>` : State.fmtUSD(p.monto)}${p.esTarjeta?` <span class="badge b-purple" style="font-size:9px">Tarjeta +$${(p.diferencialArs||0).toLocaleString('es-AR')}</span>`:''}</span>
        <button onclick="Ventas.removePago(${idx})" title="Quitar pago" style="background:none;border:none;cursor:pointer;font-size:17px;padding:2px 4px;border-radius:5px;opacity:0.75;flex-shrink:0;line-height:1" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.75">🗑️</button>
      </div>`).join('')}
      <div style="display:grid;grid-template-columns:${this.isMobile()?'1fr':'1fr 1fr'};gap:8px;margin:10px 0">
        <select id="vf-pago-persona" style="${this._sel()}">
          ${State.personas.map(p=>`<option>${p}</option>`).join('')}
        </select>
        <select id="vf-pago-bolsillo" onchange="Ventas.toggleTarjetaWrap();Ventas.actualizarLabelMonto()" style="${this._sel()}">
          <option>ARS cash</option><option>ARS transferencia</option><option>USD cash</option><option>USD transferencia</option><option>USDT</option>
        </select>
      </div>
      <div style="margin-bottom:4px">
        <label id="vf-pago-monto-label" style="font-size:11px;color:var(--text-secondary);font-weight:600">Monto en ARS</label>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:4px">
        <input type="number" id="vf-pago-monto" value="" placeholder="0" oninput="Ventas.actualizarLabelMonto()" style="flex:1;${this._inp()}" inputmode="decimal">
        <button class="btn btn-primary" onclick="Ventas.addPago()"><i class="ti ti-plus"></i> Agregar pago</button>
      </div>
      <div id="vf-pago-equiv" style="font-size:11px;color:var(--text-secondary);margin-bottom:8px;min-height:16px"></div>
      <label style="display:flex;align-items:center;gap:7px;font-size:12.5px;cursor:pointer;margin-bottom:8px" id="vf-tarjeta-check-wrap">
        <input type="checkbox" id="vf-es-tarjeta" onchange="Ventas.toggleDiferencialWrap()"> Pago con tarjeta de crédito (posnet)
      </label>
      <div id="vf-diferencial-wrap" style="display:none;background:var(--purple-light);border-radius:8px;padding:10px 12px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--purple);margin-bottom:8px">
          <span>Precio de lista (a cubrir)</span><b>${State.fmtUSD(total)}</b>
        </div>
        <div style="display:grid;grid-template-columns:${this.isMobile()?'1fr':'1fr 1fr'};gap:8px;margin-bottom:8px">
          <div>
            <label style="font-size:11px;color:var(--purple);font-weight:600;display:block;margin-bottom:4px">Monto cargado en posnet (ARS)</label>
            <input type="number" id="vf-monto-posnet" placeholder="ej: 1420000" oninput="Ventas.actualizarDiferencialPreview()" style="width:100%;font-size:13px;font-weight:600;padding:8px 10px;border:1px solid var(--border-strong);border-radius:8px" inputmode="decimal">
          </div>
          <div>
            <label style="font-size:11px;color:var(--purple);font-weight:600;display:block;margin-bottom:4px">Comisión banco (coef.)</label>
            <input type="number" id="vf-coef-comision" placeholder="ej: 0.29" step="0.01" oninput="Ventas.actualizarDiferencialPreview()" style="width:100%;font-size:13px;font-weight:600;padding:8px 10px;border:1px solid var(--border-strong);border-radius:8px" inputmode="decimal">
          </div>
        </div>
        <div>
          <label style="font-size:11px;color:var(--purple);font-weight:600;display:block;margin-bottom:4px">Cotización del momento</label>
          <input type="number" id="vf-cotiz-tarjeta" value="${State.refBlue}" oninput="Ventas.actualizarDiferencialPreview()" style="width:100%;font-size:13px;font-weight:600;padding:8px 10px;border:1px solid var(--border-strong);border-radius:8px">
        </div>
        <div id="vf-diferencial-preview" style="margin-top:10px;padding-top:10px;border-top:1px solid #C9C5B855"></div>
      </div>
    `;
  },
  toggleTarjetaWrap() {
    const bolsillo = document.getElementById('vf-pago-bolsillo')?.value || '';
    const wrap = document.getElementById('vf-tarjeta-check-wrap');
    if (!wrap) return;
    const esTransferencia = bolsillo.includes('transferencia');
    wrap.style.display = esTransferencia ? 'flex' : 'none';
    if (!esTransferencia) {
      const chk = document.getElementById('vf-es-tarjeta');
      if (chk) chk.checked = false;
      this.toggleDiferencialWrap();
    }
  },
  toggleDiferencialWrap() {
    const chk = document.getElementById('vf-es-tarjeta');
    const wrap = document.getElementById('vf-diferencial-wrap');
    if (wrap) wrap.style.display = chk?.checked ? 'block' : 'none';
    if (chk?.checked) this.actualizarDiferencialPreview();
  },
  // Calcula: Neto ARS = Monto posnet − (Monto posnet × coeficiente) → Precio venta real USD = Neto ARS / Cotización
  calcularVentaTarjeta() {
    const total = Math.max(0, this.draft.items.reduce((s, i) => s + i.precio, 0) - (this.draft.tradeIn?.valor || 0));
    const montoPosnet = parseFloat(document.getElementById('vf-monto-posnet')?.value) || 0;
    const coef = parseFloat(document.getElementById('vf-coef-comision')?.value) || 0;
    const cotiz = parseFloat(document.getElementById('vf-cotiz-tarjeta')?.value) || State.refBlue;
    const netoArs = montoPosnet - (montoPosnet * coef);
    const precioVentaRealUSD = cotiz ? netoArs / cotiz : 0;
    const diferencialUSD = precioVentaRealUSD - total;
    return { total, montoPosnet, coef, cotiz, netoArs, precioVentaRealUSD, diferencialUSD };
  },
  actualizarDiferencialPreview() {
    const { total, montoPosnet, netoArs, precioVentaRealUSD, diferencialUSD } = this.calcularVentaTarjeta();
    const preview = document.getElementById('vf-diferencial-preview');
    if (!preview) return;
    if (!montoPosnet) {
      preview.innerHTML = `<span style="font-size:10.5px;color:var(--purple)">Completá el monto del posnet para calcular el precio de venta real.</span>`;
      return;
    }
    const filas = `
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--purple);padding:2px 0"><span>Neto después de comisión</span><b>$${netoArs.toLocaleString('es-AR', {maximumFractionDigits:0})}</b></div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--purple);padding:2px 0"><span>Precio de venta real</span><b>${State.fmtUSD(precioVentaRealUSD)}</b></div>
    `;
    if (diferencialUSD > 0.005) {
      preview.innerHTML = filas + `<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--green);font-weight:600;padding-top:4px">Diferencial ganado<span>+${State.fmtUSD(diferencialUSD)}</span></div>`;
    } else if (diferencialUSD < -0.005) {
      preview.innerHTML = filas + `<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--red);font-weight:600;padding-top:4px"><span><i class="ti ti-alert-triangle"></i> Falta cubrir</span><span>${State.fmtUSD(diferencialUSD)}</span></div>`;
    } else {
      preview.innerHTML = filas + `<div style="font-size:11px;color:var(--purple);padding-top:4px">Cubre exacto el precio de lista, sin diferencial.</div>`;
    }
  },
  actualizarLabelMonto() {
    const bolsillo = document.getElementById('vf-pago-bolsillo')?.value || '';
    const label    = document.getElementById('vf-pago-monto-label');
    const equiv    = document.getElementById('vf-pago-equiv');
    const input    = document.getElementById('vf-pago-monto');
    const esARS    = bolsillo.startsWith('ARS');
    if (label) label.textContent = esARS ? `Monto en ARS (blue: $${State.refBlue.toLocaleString('es-AR')})` : 'Monto en USD';
    if (equiv && input) {
      const val = parseFloat(input.value) || 0;
      equiv.textContent = esARS && val > 0 ? `≈ USD ${(val / State.refBlue).toFixed(2)}` : '';
    }
  },

  addPago() {
    const persona = document.getElementById('vf-pago-persona').value;
    const bolsillo = document.getElementById('vf-pago-bolsillo').value;
    const esTarjeta = document.getElementById('vf-es-tarjeta')?.checked || false;
    const esARS = bolsillo.startsWith('ARS');
    let montoIngresado = parseFloat(document.getElementById('vf-pago-monto').value) || 0;
    // Convertir siempre a USD para almacenar
    let monto = esARS ? montoIngresado / (State.refBlue || 1) : montoIngresado;
    let diferencialArs = 0;
    let cotizacionDiferencial = null;

    if (esTarjeta) {
      const { montoPosnet, netoArs, precioVentaRealUSD, diferencialUSD, cotiz } = this.calcularVentaTarjeta();
      if (!montoPosnet) { toast('Ingresá el monto cargado en el posnet.'); return; }
      monto = precioVentaRealUSD;
      diferencialArs = diferencialUSD > 0 ? diferencialUSD * cotiz : 0;
      cotizacionDiferencial = cotiz;
    }

    if (!monto) { toast('Ingresá un monto.'); return; }
    this.draft.pagos.push({ persona, bolsillo, monto, esTarjeta, diferencialArs, cotizacionDiferencial });
    document.getElementById('venta-step-body').innerHTML = this.stepPagos();
    this.guardarBorrador();
  },
  removePago(idx) { this.draft.pagos.splice(idx, 1); document.getElementById('venta-step-body').innerHTML = this.stepPagos(); this.guardarBorrador(); },

  stepConfirm() {
    const d = this.draft;
    const total = d.items.reduce((s, i) => s + i.precio, 0);
    const pagado = d.pagos.reduce((s, p) => s + Ventas.montoSinDiferencial(p), 0) + (d.tradeIn?.valor || 0);
    const saldo = Math.max(0, total - pagado);
    const pagosTarjeta = d.pagos.filter(p => p.esTarjeta);
    const totalDiferencialArs = pagosTarjeta.reduce((s, p) => s + (p.diferencialArs || 0), 0);
    return `
      <div style="margin-bottom:14px"><b>Cliente:</b> ${d.cliente || 'Consumidor final'} ${d.vendedor?`· Vendedor: ${d.vendedor}`:''}</div>
      <div style="margin-bottom:14px"><b>Ítems (${d.items.length})</b>
        ${d.items.map(i=>`<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0"><span>${i.nombre}${i.imei?`<br><span style="font-size:10px;color:var(--text-secondary);font-family:monospace">IMEI: ${i.imei}</span>`:''}</span><span>${State.fmtUSD(i.precio)}</span></div>`).join('')}
      </div>
      <div style="margin-bottom:14px"><b>Pagos</b>
        ${d.tradeIn?.valor > 0 ? `<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;color:var(--green)">🔄 Trade-In: ${d.tradeIn.modelo||'Equipo'}<span style="font-weight:600">${State.fmtUSD(d.tradeIn.valor)}</span></div>` : ''}
        ${d.pagos.map(p=>`<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">${p.persona} — ${p.bolsillo}${p.esTarjeta?' <span class="badge b-purple" style="font-size:9px">Tarjeta</span>':''}<span>${State.fmtUSD(p.monto)}</span></div>`).join('')}
      </div>
      ${(()=>{
        const totalPagado = d.pagos.reduce((s,p) => s + p.monto, 0) + (d.tradeIn?.valor||0);
        const costoRegalos = d.items.filter(i=>i.regalo).reduce((s,i) => s+(i.costo||0), 0);
        const diferencial = totalPagado - total;
        const diferencialReal = diferencial - costoRegalos;
        return pagosTarjeta.length ? `
        <div style="background:var(--purple-light);border-radius:8px;padding:10px 12px;margin-bottom:14px">
          <div style="font-size:11px;color:var(--purple);font-weight:600;margin-bottom:8px">💳 Detalle del diferencial</div>
          <div style="font-size:11px;color:var(--purple);padding:2px 0;display:flex;justify-content:space-between"><span>Precio pactado de venta</span><b>${State.fmtUSD(total)}</b></div>
          <div style="font-size:11px;color:var(--purple);padding:2px 0;display:flex;justify-content:space-between"><span>Total cobrado</span><b>${State.fmtUSD(totalPagado)}</b></div>
          ${costoRegalos > 0 ? `<div style="font-size:11px;color:var(--text-secondary);padding:2px 0;display:flex;justify-content:space-between"><span>Costo regalos incluidos</span><span>−${State.fmtUSD(costoRegalos)}</span></div>` : ''}
          <div style="height:1px;background:rgba(139,92,246,.3);margin:6px 0"></div>
          <div style="font-size:12px;color:${diferencialReal>=0?'var(--green)':'var(--red)'};font-weight:600;display:flex;justify-content:space-between"><span>Diferencial ganado</span><span>${diferencialReal>=0?'+':''}${State.fmtUSD(diferencialReal)}</span></div>
        </div>` : '';
      })()}
      <div style="margin-bottom:12px">
        <label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Comisión del vendedor (USD) <span style="font-weight:400">— opcional</span></label>
        <input type="number" id="vf-comision-vendedor" value="${d.comisionVendedor||''}" placeholder="0" oninput="Ventas.draft.comisionVendedor=parseFloat(this.value)||0" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
      </div>
      <div style="display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid var(--border);font-weight:600">Total<span>${State.fmtUSD(total)}</span></div>
      <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;color:${saldo>0?'var(--red)':'var(--green)'}">Saldo<span>${State.fmtUSD(saldo)}</span></div>
      ${totalDiferencialArs > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;color:var(--purple)">Diferencial de tarjeta<span>+$${totalDiferencialArs.toLocaleString('es-AR')}</span></div>` : ''}
      <div style="background:var(--blue-light);border-radius:8px;padding:10px 12px;margin-top:12px;font-size:12px;color:var(--blue)">
        La venta se guardará como: <b>${saldo > 0 ? 'Abierta' : 'Cerrada'}</b>
      </div>
    `;
  },

  nextStep() {
    try {
      if (this.step === 1 && document.getElementById('vf-ti-active')) {
        this.draft.tradeIn = this._leerTradeIn();
        if (this.draft.tradeIn) this._tiCat = this.draft.tradeIn.cat;
      }
      if (this.step === 0) {
        this.draft.cliente = document.getElementById('vf-cliente').value.trim() || 'Consumidor final';
        this.draft.clienteTel = document.getElementById('vf-cliente-tel')?.value.trim() || '';
        this.draft.clienteDni = document.getElementById('vf-cliente-dni')?.value.trim() || '';
        this.draft.clienteEmail = document.getElementById('vf-cliente-email')?.value.trim() || '';
        this.draft.tipoVenta = document.getElementById('vf-tipo-venta')?.value || 'minorista';
        this.draft.vendedor = document.getElementById('vf-vendedor').value;
        this.draft.fechaVenta = document.getElementById('vf-fecha-venta')?.value || new Date().toISOString().slice(0,10);
      }
      if (this.step === 2 && this.draft.items.length === 0) { toast('Agregá al menos un ítem.'); return; }
      if (this.step === 4) { this.confirmSale(); return; }
      this.step++;
      this.renderStep();
      this.guardarBorrador();
    } catch (err) {
      console.error('Error al avanzar de paso en el formulario de venta:', err);
      toast('Hubo un problema al avanzar. Revisá la consola (F12) para más detalle, o avisame el error.');
    }
  },
  prevStep() { if (this.step > 0) { this.step--; this.renderStep(); } },

  async confirmSale() {
    const d = this.draft;
    const total = d.items.reduce((s, i) => s + i.precio, 0);
    const pagado = d.pagos.reduce((s, p) => s + Ventas.montoSinDiferencial(p), 0) + (d.tradeIn?.valor || 0);
    // Tolerancia de hasta $0.50 USD para diferencias por conversión ARS
    const estado = (total - pagado) <= 0.5 ? 'cerrada' : 'abierta';

    toast('Guardando venta...');

    // Descontar stock de los ítems que vinieron de inventario (memoria + base de datos)
    const stockMovs = [];
    for (const it of d.items) {
      if (it.stockId) {
        const removed = State.descontarStock(it.stockId, it.imei);
        if (removed) {
          stockMovs.push(removed);
          const item = State.stock.find(s => s.id === it.stockId);
          if (item) {
            if (item.imeis) await DB.actualizarImeisStock(it.stockId, item.imeis);
            else await DB.actualizarCantidadStock(it.stockId, item.cantidad);
          }
        }
      }
    }

    // Ingresar el equipo del Trade-In al stock
    let savedTradeInId = null;
    if (d.tradeIn?.modelo && d.tradeIn?.valor > 0) {
      const ti = d.tradeIn;
      const imeis = ti.imei ? [ti.imei] : [];
      const estadoInv = ti.revisar ? 'en_reparacion' : 'disponible';
      const nombre = [ti.modelo, ti.storage, ti.color].filter(Boolean).join(' ') || ti.modelo;
      const tiObj = {
        cat: ti.cat || 'iphone', nombre, costoUSD: ti.valor,
        cantidad: imeis.length > 0 ? 0 : 1, imeis, cotiz: State.refBlue, precioARS: null,
        proveedor: 'Trade-In', custodio: ti.custodio || '',
        notas: [ti.notas, `Trade-in de venta a ${d.cliente}`].filter(Boolean).join(' | '),
        estadoInventario: estadoInv, grado: ti.grado || 'Sin grado',
        modelo: ti.modelo, storage: ti.storage || '', color: ti.color || '',
        bateriaPct: ti.bateriaPct || null, estadoProducto: ti.estadoProducto || '',
      };
      const { id: tiId, error: tiErr } = await DB.guardarProductoStock(tiObj, null);
      if (!tiErr && tiId) {
        tiObj.id = tiId;
        State.stock.push(tiObj);
        savedTradeInId = tiId;
      }
    }

    // Acreditar pagos en las cajas correspondientes (memoria + base de datos)
    d.pagos.forEach(p => {
      let montoEnBolsillo = p.monto;
      if (p.bolsillo.startsWith('ARS')) montoEnBolsillo = p.monto * State.refBlue;
      State.acreditarCaja(p.persona, p.bolsillo, montoEnBolsillo);
    });

    // Guardar la venta en Supabase
    const ventaId = await DB.crearVenta(d, estado);
    if (!ventaId) {
      // Revertir stock descontado
      for (const mov of stockMovs) {
        State.restaurarStock(mov.stockId, mov.imei);
        const item = State.stock.find(s => s.id === mov.stockId || s.id == mov.stockId);
        if (item) {
          if (item.imeis) await DB.actualizarImeisStock(mov.stockId, item.imeis);
          else await DB.actualizarCantidadStock(mov.stockId, item.cantidad);
          if (State.getStock(item) > 0 && item.estadoInventario !== 'disponible') {
            item.estadoInventario = 'disponible';
            await DB.actualizarEstadoInventario(mov.stockId, 'disponible');
          }
        }
      }
      // Revertir pagos acreditados
      d.pagos.forEach(p => {
        let montoEnBolsillo = p.monto;
        if (p.bolsillo.startsWith('ARS')) montoEnBolsillo = p.monto * State.refBlue;
        State.debitarCaja(p.persona, p.bolsillo, montoEnBolsillo);
      });
      toast('Hubo un problema guardando la venta. Probá de nuevo.');
      return;
    }

    if (savedTradeInId && d.tradeIn) {
      const ti = d.tradeIn;
      DB.registrarMovimientoStock(
        savedTradeInId, 'trade_in',
        `Recibido como trade-in de ${d.cliente} en venta #${ventaId}`,
        0, ti.imei ? 0 : 1,
        { ventaId, cliente: d.cliente, valor: ti.valor }
      );
    }

    const venta = {
      id: ventaId, fecha: 'Hoy', cliente: d.cliente, vendedor: d.vendedor,
      items: d.items, pagos: d.pagos.map(p => ({ id: p.id || null, caja: `${p.persona}-${p.bolsillo}`, monto: p.monto, persona: p.persona, bolsillo: p.bolsillo, esTarjeta: !!p.esTarjeta, diferencialArs: p.diferencialArs || 0, cotizacionDiferencial: p.cotizacionDiferencial || null })),
      estado, tradeIn: d.tradeIn, stockMovs
    };
    State.ventas.unshift(venta);

    // Respaldo en Google Sheets (no bloquea, falla en silencio si hay un problema)
    const costoTotal = d.items.reduce((s, i) => s + (i.costo || 0), 0);
    Sheets.venta(venta, total, costoTotal);

    this.closeModal();
    this.renderList();
    toast(`Venta #${venta.id} confirmada y guardada. Stock actualizado y pagos acreditados en las cajas correspondientes.`);
    if (d.clienteTel) this._sugerirWhatsappVenta(venta);
  },

  viewSale(id) {
    const v = State.ventas.find(x => x.id === id);
    if (!v) return;
    App.closeSidebar();
    const total = v.items.reduce((s, i) => s + i.precio, 0);
    const pagado = v.pagos.reduce((s, p) => s + p.monto, 0) + (v.tradeIn?.valor || 0);
    const saldo = pagado - total;
    const cerrada = v.estado === 'cerrada';
    const TIPO_LABEL = { minorista: 'Minorista', mayorista: 'Mayorista', revendedor: 'Revendedor' };

    // Separar ítems en dispositivos y accesorios
    const dispositivosCats = ['iphone','android','mac','ipad','watch'];
    const itemsDispositivos = v.items.filter(i => {
      const p = State.stock.find(s => s.id === i.stockId);
      return p ? dispositivosCats.includes(p.cat) : false;
    });
    const itemsAccesorios = v.items.filter(i => {
      const p = State.stock.find(s => s.id === i.stockId);
      return !p || !dispositivosCats.includes(p.cat);
    });

    const host = document.getElementById('venta-modal-host');
    host.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:${this.isMobile()?'flex-end':'center'};justify-content:center;z-index:200" onclick="if(event.target===this) Ventas.closeModal()">
        <div style="width:820px;max-width:${this.isMobile()?'100vw':'96vw'};max-height:${this.isMobile()?'95dvh':'92vh'};background:var(--bg-elevated);border-radius:${this.isMobile()?'18px 18px 0 0':'14px'};display:flex;flex-direction:column;overflow:hidden" onclick="event.stopPropagation()">

          <!-- HEADER -->
          <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;flex-shrink:0">
            <div>
              <h2 style="font-size:20px;font-weight:700">Venta #${v.id}</h2>
              <p style="font-size:12px;color:var(--text-secondary);margin-top:2px">${v.fecha}${v.tipoVenta ? ` · ${TIPO_LABEL[v.tipoVenta]||v.tipoVenta}` : ''}</p>
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              ${this.estadoToggle(cerrada)}
              <span style="font-size:20px;font-weight:700">${State.fmtUSD(total)}</span>
              <button class="btn btn-sm btn-primary" onclick="Ventas.generarRecibo(${id})"><i class="ti ti-download"></i> Recibo</button>
              <button class="btn btn-sm" onclick="Ventas.generarDetallePDF(${id})"><i class="ti ti-download"></i> Detalle PDF</button>
              <button onclick="Ventas.closeModal()" style="background:none;border:none;cursor:pointer;color:var(--red);font-size:22px;line-height:1;padding:2px 6px;border-radius:6px;transition:background .15s" onmouseover="this.style.background='rgba(239,68,68,.12)'" onmouseout="this.style.background='none'">✕</button>
            </div>
          </div>

          <!-- CUERPO SCROLLEABLE -->
          <div style="flex:1;overflow-y:auto;padding:18px 20px">

            <!-- RESUMEN GARANTÍAS -->
            ${(()=>{
              const garantiasActivas = v.items.filter(i => i.garantiaFin && new Date(i.garantiaFin) > new Date()).length;
              const vencenPronto = v.items.filter(i => { if (!i.garantiaFin) return false; const dias = (new Date(i.garantiaFin)-new Date())/86400000; return dias > 0 && dias <= 30; }).length;
              return `
              <div class="card" style="margin-bottom:14px">
                <div class="card-title"><i class="ti ti-shield"></i> Resumen de Garantías</div>
                <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
                  <div style="background:var(--bg-secondary);border-radius:8px;padding:12px;display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:11px;color:var(--text-secondary)">Total con Garantía</div><div style="font-size:22px;font-weight:700">${v.items.filter(i=>i.garantiaFin).length}</div></div><i class="ti ti-shield" style="font-size:24px;color:var(--blue);opacity:.4"></i></div>
                  <div style="background:var(--bg-secondary);border-radius:8px;padding:12px;display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:11px;color:var(--text-secondary)">Garantías Activas</div><div style="font-size:22px;font-weight:700;color:var(--green)">${garantiasActivas}</div></div><i class="ti ti-shield-check" style="font-size:24px;color:var(--green);opacity:.4"></i></div>
                  <div style="background:var(--bg-secondary);border-radius:8px;padding:12px;display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:11px;color:var(--text-secondary)">Vencen Pronto</div><div style="font-size:22px;font-weight:700;color:${vencenPronto>0?'var(--amber)':'var(--text)'}">${vencenPronto}</div></div><i class="ti ti-shield-exclamation" style="font-size:24px;color:${vencenPronto>0?'var(--amber)':'var(--text-secondary)'};opacity:.4"></i></div>
                </div>
              </div>`;
            })()}

            <!-- INFO CLIENTE -->
            <div class="card" style="margin-bottom:14px">
              <div class="card-title"><i class="ti ti-user"></i> Información del Cliente</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                <div><label style="font-size:11px;color:var(--text-secondary)">Nombre</label><div style="font-size:13px;font-weight:500">${v.cliente}</div></div>
                <div><label style="font-size:11px;color:var(--text-secondary)">Teléfono</label><div style="font-size:13px">${v.clienteTel||'—'}</div></div>
                <div><label style="font-size:11px;color:var(--text-secondary)">DNI</label><div style="font-size:13px">${v.clienteDni||'—'}</div></div>
                <div><label style="font-size:11px;color:var(--text-secondary)">Email</label><div style="font-size:13px">${v.clienteEmail ? `<a href="mailto:${v.clienteEmail}" style="color:var(--blue)">${v.clienteEmail}</a>` : '—'}</div></div>
                <div><label style="font-size:11px;color:var(--text-secondary)">Vendedor</label>
                  <div style="font-size:13px;font-weight:600">${v.vendedor||'—'}</div>
                  <div style="font-size:11px;color:var(--green)">Comisión: ${State.fmtUSD(v.comisionVendedor||0)}</div>
                </div>
              </div>
            </div>

            <!-- DISPOSITIVOS VENDIDOS -->
            ${itemsDispositivos.length ? `
            <div class="card" style="margin-bottom:14px">
              <div class="card-title"><i class="ti ti-device-mobile"></i> Dispositivos Vendidos</div>
              <table><thead><tr><th>Dispositivo</th><th>Condición</th><th>Identificador</th><th>Garantía</th><th>Precio Compra</th><th>Precio Venta</th><th>Profit</th><th>Comisión</th></tr></thead>
              <tbody>${itemsDispositivos.map(i => {
                const p = State.stock.find(s => s.id === i.stockId);
                const profit = i.precio - (i.costo||0);
                const diasRestantes = i.garantiaFin ? Math.max(0, Math.round((new Date(i.garantiaFin)-new Date())/86400000)) : null;
                const progreso = i.garantiaInicio && i.garantiaFin ? Math.min(100, Math.round((new Date()-new Date(i.garantiaInicio))/(new Date(i.garantiaFin)-new Date(i.garantiaInicio))*100)) : 0;
                return `<tr>
                  <td><b>${i.nombre}</b>${p?.notas?`<div style="font-size:10px;color:var(--text-secondary);font-style:italic">${p.notas}</div>`:''}</td>
                  <td><span class="badge b-amber">${p?.estadoProducto||'Usado'}</span></td>
                  <td style="font-family:monospace;font-size:11px">${i.imei||'—'}</td>
                  <td>${diasRestantes !== null ? `
                    <div style="font-size:11px;color:var(--green);font-weight:600">Garantía activa</div>
                    <div style="font-size:10px;color:var(--text-secondary)">${diasRestantes} días restantes</div>
                    <div style="height:4px;background:var(--border);border-radius:2px;margin-top:4px;width:80px"><div style="height:4px;background:var(--green);border-radius:2px;width:${100-progreso}%"></div></div>
                  ` : '—'}</td>
                  <td>${State.fmtUSD(i.costo||0)}</td>
                  <td><b>${State.fmtUSD(i.precio)}</b></td>
                  <td style="color:${profit>=0?'var(--green)':'var(--red)'}"><b>${profit>=0?'+':''}${State.fmtUSD(profit)}</b></td>
                  <td>${State.fmtUSD(v.comisionVendedor||0)}</td>
                </tr>`;
              }).join('')}</tbody></table>
            </div>` : ''}

            <!-- ACCESORIOS VENDIDOS -->
            ${itemsAccesorios.length ? `
            <div class="card" style="margin-bottom:14px">
              <div class="card-title"><i class="ti ti-box"></i> Accesorios Vendidos</div>
              <table><thead><tr><th>Accesorio</th><th>SKU</th><th>Cantidad</th><th>Precio Total</th><th>Profit</th><th>Comisión</th></tr></thead>
              <tbody>${itemsAccesorios.map(i => {
                const p = State.stock.find(s => s.id === i.stockId);
                const profit = i.precio - (i.costo||0);
                return `<tr>
                  <td>${i.nombre}${i.regalo?` <span style="font-size:10px;color:var(--green)">🎁 regalo</span>`:''}</td>
                  <td style="font-size:11px;color:var(--text-secondary)">${p?.storage||p?.notas||'N/A'}</td>
                  <td>1</td>
                  <td>${i.regalo?`<span style="color:var(--green)">Gratis</span>`:State.fmtUSD(i.precio)}</td>
                  <td style="color:${profit>=0?'var(--green)':'var(--red)'}">${profit>=0?'+':''}${State.fmtUSD(profit)}</td>
                  <td>$0</td>
                </tr>`;
              }).join('')}</tbody></table>
            </div>` : ''}

            <!-- TRADE-IN RECIBIDO -->
            ${v.tradeIn?.valor > 0 ? `
            <div class="card" style="margin-bottom:14px;border-left:3px solid var(--green)">
              <div class="card-title"><i class="ti ti-arrows-exchange"></i> Equipo Recibido como Trade-In</div>
              <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
                <div><label style="font-size:11px;color:var(--text-secondary)">Modelo</label><div style="font-size:13px;font-weight:600">${v.tradeIn.modelo||'—'}</div></div>
                <div><label style="font-size:11px;color:var(--text-secondary)">Color</label><div style="font-size:13px">${v.tradeIn.color||'—'}</div></div>
                <div><label style="font-size:11px;color:var(--text-secondary)">Storage</label><div style="font-size:13px">${v.tradeIn.storage||'—'}</div></div>
                <div><label style="font-size:11px;color:var(--text-secondary)">IMEI</label><div style="font-size:12px;font-family:monospace">${v.tradeIn.imei||'—'}</div></div>
                <div><label style="font-size:11px;color:var(--text-secondary)">Batería</label><div style="font-size:13px;color:var(--green)">${v.tradeIn.bateriaPct!=null?v.tradeIn.bateriaPct+'%':'—'}</div></div>
                <div><label style="font-size:11px;color:var(--text-secondary)">Estado</label><div style="font-size:13px">${v.tradeIn.estadoProducto||'—'}</div></div>
                <div><label style="font-size:11px;color:var(--text-secondary)">Grado</label><div style="font-size:13px">${v.tradeIn.grado||'—'}</div></div>
                <div><label style="font-size:11px;color:var(--text-secondary)">Valor tomado</label><div style="font-size:15px;font-weight:700;color:var(--green)">− ${State.fmtUSD(v.tradeIn.valor)}</div></div>
                ${v.tradeIn.notas?`<div style="grid-column:1/-1"><label style="font-size:11px;color:var(--text-secondary)">Notas</label><div style="font-size:12px;color:var(--text-secondary)">${v.tradeIn.notas}</div></div>`:''}
              </div>
            </div>` : ''}

            <!-- SUBTOTAL -->
            <div style="display:flex;justify-content:flex-end;margin-bottom:14px;gap:20px;flex-wrap:wrap">
              <div style="text-align:right">
                <div style="font-size:12px;color:var(--text-secondary)">Subtotal Dispositivos: ${State.fmtUSD(itemsDispositivos.reduce((s,i)=>s+i.precio,0))}</div>
                <div style="font-size:12px;color:var(--text-secondary)">Subtotal Accesorios: ${State.fmtUSD(itemsAccesorios.reduce((s,i)=>s+i.precio,0))}</div>
                <div style="font-size:16px;font-weight:700;margin-top:6px">Subtotal: ${State.fmtUSD(total)}</div>
                ${(()=>{ const pt = v.items.reduce((s,i)=>s+(i.precio-(i.costo||0)),0); return `<div style="font-size:12px;color:${pt>=0?'var(--green)':'var(--red)'}">Profit: ${pt>=0?'+':''}${State.fmtUSD(pt)}</div>`; })()}
              </div>
            </div>

            <!-- PAGOS -->
            <div class="card" style="margin-bottom:14px">
              <div class="card-title"><i class="ti ti-credit-card"></i> Pagos</div>
              ${(()=>{ const dif = pagado - total; return dif > 0.01 ? `<div style="display:flex;justify-content:space-between;align-items:center;background:rgba(139,92,246,0.08);border:1px solid var(--purple);border-radius:8px;padding:7px 12px;margin-bottom:10px;font-size:12px"><span style="color:var(--purple);font-weight:600"><i class="ti ti-credit-card"></i> Diferencial cobrado</span><span style="color:var(--purple);font-weight:700">+${State.fmtUSD(dif)}</span></div>` : ''; })()}
              <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px">
                <div><label style="font-size:11px;color:var(--text-secondary)">Total Venta</label><div style="font-size:17px;font-weight:700">${State.fmtUSD(total)}</div></div>
                <div><label style="font-size:11px;color:var(--text-secondary)">Total Pagos</label><div style="font-size:17px;font-weight:700">${State.fmtUSD(pagado)}</div></div>
                <div><label style="font-size:11px;color:var(--text-secondary)">Saldo</label><div style="font-size:17px;font-weight:700;color:${saldo>=0?'var(--green)':'var(--red)'}">${saldo>=0?'✓ Pagado':State.fmtUSD(-saldo)+' pendiente'}</div></div>
              </div>
              ${v.tradeIn?.valor > 0 ? `
                <div style="display:flex;justify-content:space-between;align-items:center;background:var(--bg-secondary);border:1px solid var(--green);border-radius:8px;padding:10px 12px;margin-bottom:6px">
                  <div style="display:flex;align-items:center;gap:10px">
                    <i class="ti ti-arrows-exchange" style="font-size:20px;color:var(--green)"></i>
                    <div>
                      <div style="font-size:12.5px;font-weight:600;color:var(--green)">Trade-In: ${v.tradeIn.modelo||'Equipo'}</div>
                      <div style="font-size:11px;color:var(--text-secondary)">${v.tradeIn.color||''} ${v.tradeIn.storage||''} ${v.tradeIn.bateriaPct!=null?'· '+v.tradeIn.bateriaPct+'%':''}</div>
                    </div>
                  </div>
                  <div style="font-size:13px;font-weight:600;color:var(--green)">${State.fmtUSD(v.tradeIn.valor)}</div>
                </div>` : ''}
              ${v.pagos.map(p => `
                <div style="display:flex;justify-content:space-between;align-items:center;background:var(--bg-secondary);border-radius:8px;padding:10px 12px;margin-bottom:6px">
                  <div style="display:flex;align-items:center;gap:10px">
                    <i class="ti ti-${p.bolsillo?.includes('USD')||p.bolsillo?.includes('USDT')?'currency-dollar':'building-bank'}" style="font-size:20px;color:var(--text-secondary)"></i>
                    <div>
                      <div style="font-size:12.5px;font-weight:600">${p.persona} — ${p.bolsillo}${p.esTarjeta?` <span class="badge b-purple" style="font-size:9px">Tarjeta</span>`:''}</div>
                      <div style="font-size:11px;color:var(--text-secondary)">${v.fecha}</div>
                    </div>
                  </div>
                  <div style="display:flex;align-items:center;gap:10px">
                    <div style="text-align:right">
                      <div style="font-size:13px;font-weight:600">${State.fmtUSD(p.monto)}</div>
                      ${p.bolsillo?.startsWith('ARS') ? `<div style="font-size:10px;color:var(--text-secondary)">$${Math.round(p.monto*(p.cotizacionDiferencial||State.refBlue)).toLocaleString('es-AR')} ARS @ $${(p.cotizacionDiferencial||State.refBlue).toLocaleString('es-AR')}</div>` : ''}
                    </div>
                    ${p.id ? `<button onclick="Ventas.eliminarPago(${id},${p.id})" title="Eliminar pago" style="background:none;border:none;cursor:pointer;font-size:17px;padding:4px;opacity:0.6;line-height:1" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6">🗑️</button>` : ''}
                  </div>
                </div>
              `).join('')}
            </div>

            <!-- NOTAS -->
            <div class="card" style="margin-bottom:14px">
              <div class="card-title"><i class="ti ti-notes"></i> Notas internas</div>
              <div id="venta-notas-list" style="margin-bottom:10px"></div>
              <div style="display:flex;gap:8px">
                <input type="text" id="venta-nota-input" placeholder="Escribir una nota..." style="flex:1;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
                <button class="btn btn-sm btn-primary" onclick="Ventas.agregarNota(${id})"><i class="ti ti-send"></i></button>
              </div>
            </div>

          </div>

          <!-- FOOTER -->
          <div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;flex-wrap:wrap;gap:8px">
            <button class="btn btn-sm" style="color:var(--red)" onclick="Ventas.anular(${id})">🗑️ Anular</button>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${v.clienteTel ? `<button class="btn btn-sm" onclick="Ventas._whatsappVenta(${id})" style="color:#25D366;border-color:#25D366"><i class="ti ti-brand-whatsapp"></i> WhatsApp</button>` : ''}
              ${!cerrada ? `<button class="btn btn-sm btn-primary" onclick="Ventas.abrirCobro(${id})"><i class="ti ti-cash"></i> Registrar cobro</button>` : ''}
              ${!cerrada ? `<button class="btn btn-sm" onclick="Ventas.cerrarVentaManual(${id})" style="color:var(--green);border-color:var(--green)"><i class="ti ti-lock"></i> Cerrar venta</button>` : ''}
              <button class="btn btn-sm" onclick="Ventas.closeModal()">Cerrar</button>
            </div>
          </div>
        </div>
      </div>
    `;
    this.cargarNotasVenta(id);
  },

  async cargarNotasVenta(ventaId) {
    const notas = await DB.cargarNotasVenta(ventaId);
    const list = document.getElementById('venta-notas-list');
    if (!list) return;
    if (!notas.length) { list.innerHTML = `<div style="font-size:11.5px;color:var(--text-secondary)">Sin notas todavía</div>`; return; }
    list.innerHTML = notas.map(n => `
      <div style="background:var(--bg-secondary);border-radius:8px;padding:8px 10px;margin-bottom:6px;font-size:12px">
        <div style="color:var(--text-secondary);font-size:10px;margin-bottom:3px">${n.usuario_nombre||''} · ${new Date(n.creado_en).toLocaleDateString('es-AR')}</div>
        ${n.texto}
      </div>
    `).join('');
    const v = State.ventas.find(x => x.id === ventaId);
    if (v) v.notas = notas;
  },

  async agregarNota(ventaId) {
    const input = document.getElementById('venta-nota-input');
    if (!input || !input.value.trim()) return;
    await DB.agregarNotaVenta(ventaId, input.value.trim());
    input.value = '';
    this.cargarNotasVenta(ventaId);
  },

  _abrirVentanaPDF(htmlContent, titulo) {
    const win = window.open('', '_blank', 'width=900,height=700');
    win.document.write(htmlContent);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 600);
  },

  generarRecibo(id) {
    const v = State.ventas.find(x => x.id === id);
    if (!v) return;
    const total = v.items.reduce((s, i) => s + i.precio, 0);
    const pagado = v.pagos.reduce((s, p) => s + p.monto, 0) + (v.tradeIn?.valor || 0);
    const saldo = pagado - total;
    const dispositivosCats = ['iphone','android','mac','ipad','watch'];
    const itemsDisp = v.items.filter(i => { const p = State.stock.find(s => s.id === i.stockId); return p ? dispositivosCats.includes(p.cat) : false; });
    const itemsAcc = v.items.filter(i => { const p = State.stock.find(s => s.id === i.stockId); return !p || !dispositivosCats.includes(p.cat); });

    const garantiasHTML = v.items.filter(i => i.garantiaFin).map(i =>
      `<li>${i.nombre} - Válida desde ${i.garantiaInicio||v.fecha} hasta ${i.garantiaFin}</li>`
    ).join('');

    const logoB64 = localStorage.getItem('im_logo_b64');
    const fuenteId = localStorage.getItem('im_fuente') || 'system';
    const fuenteObj = (Panel?.FUENTES || []).find(f => f.id === fuenteId);
    const fuenteStack = fuenteObj?.stack || 'Helvetica Neue, Arial, sans-serif';
    const gfontUrl = fuenteObj?.google ? `https://fonts.googleapis.com/css2?family=${fuenteObj.google}&display=swap` : null;
    const LOGO_HTML = logoB64
      ? `<img src="${logoB64}" style="width:54px;height:54px;object-fit:contain">`
      : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 245" width="44" height="54"><path d="M100,18 C86,4 64,7 61,22 C58,37 71,48 83,43 C76,56 60,60 48,82 C33,108 34,140 50,162 C62,180 80,190 96,190 C108,190 116,184 124,184 C132,184 140,190 154,190 C171,190 189,176 199,154 C173,141 173,105 199,93 C189,65 168,55 150,59 C140,61 132,69 124,69 C116,69 108,61 96,59 C87,57 79,48 83,35 C87,22 100,18 100,18 Z" fill="#1a1a1a"/><path d="M104,4 C104,4 117,-1 128,10 C139,21 131,40 118,38 C109,36 99,20 104,4 Z" fill="#1a1a1a"/></svg>`;
    const LOGO_FOOTER = logoB64
      ? `<img src="${logoB64}" style="width:22px;height:22px;object-fit:contain;opacity:0.3">`
      : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 245" width="22" height="27"><path d="M100,18 C86,4 64,7 61,22 C58,37 71,48 83,43 C76,56 60,60 48,82 C33,108 34,140 50,162 C62,180 80,190 96,190 C108,190 116,184 124,184 C132,184 140,190 154,190 C171,190 189,176 199,154 C173,141 173,105 199,93 C189,65 168,55 150,59 C140,61 132,69 124,69 C116,69 108,61 96,59 C87,57 79,48 83,35 C87,22 100,18 100,18 Z" fill="#1a1a1a"/><path d="M104,4 C104,4 117,-1 128,10 C139,21 131,40 118,38 C109,36 99,20 104,4 Z" fill="#1a1a1a"/></svg>`;

    const fmtFecha = (iso) => {
      if (!iso) return '—';
      const d = new Date(iso);
      if (isNaN(d)) return iso;
      return d.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' });
    };
    const fechaVentaFmt = v.fecha === 'Hoy' ? fmtFecha(new Date().toISOString()) : fmtFecha(v.fecha);
    const calcVencimiento = (fechaVenta, dias) => {
      if (!dias) return null;
      const base = fechaVenta && fechaVenta !== 'Hoy' ? new Date(fechaVenta) : new Date();
      base.setDate(base.getDate() + dias);
      return base;
    };
    const condiciones = State.condicionesGarantia || '';

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Recibo #${v.id}</title>
    ${gfontUrl ? `<link rel="stylesheet" href="${gfontUrl}">` : ''}
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: ${fuenteStack},'Helvetica Neue',Arial,sans-serif; font-size: 12px; color: #1a1a1a; background: #fff; }
      .page { max-width: 760px; margin: 0 auto; padding: 32px 36px; }

      /* ── HEADER ── */
      .header { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 20px; margin-bottom: 20px; border-bottom: 3px solid #1a1a1a; }
      .brand { display: flex; align-items: center; gap: 14px; }
      .brand-text { }
      .brand-name { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; line-height: 1; }
      .brand-addr { font-size: 10px; color: #666; margin-top: 5px; line-height: 1.5; }
      .header-right { display: flex; align-items: center; gap: 16px; }
      .numero-recibo { border: 1.5px solid #ccc; border-radius: 6px; padding: 10px 16px; font-size: 11px; color: #666; min-width: 150px; }
      .numero-recibo .num { font-size: 28px; font-weight: 800; color: #1a1a1a; line-height: 1.1; margin: 2px 0; }
      .recibo-badge { font-size: 30px; font-weight: 900; color: #c8c8c8; letter-spacing: 2px; }

      /* ── ACENTO ── */
      .accent-bar { background: #1a1a1a; color: #fff; padding: 8px 16px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-radius: 6px; }
      .accent-bar span { font-size: 11px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; }

      /* ── CLIENTE ── */
      .cliente-box { margin-bottom: 20px; padding: 14px 16px; background: #f7f7f7; border-radius: 8px; border-left: 4px solid #1a1a1a; }
      .cliente-box .label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #888; margin-bottom: 6px; }
      .cliente-box .nombre { font-size: 16px; font-weight: 700; }
      .cliente-box .datos { font-size: 11px; color: #555; margin-top: 4px; display: flex; gap: 18px; flex-wrap: wrap; }

      /* ── TABLA ── */
      .section-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #888; margin-bottom: 8px; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
      thead th { background: #1a1a1a; color: #fff; padding: 7px 10px; text-align: left; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
      thead th:last-child { text-align: right; }
      td { padding: 9px 10px; border-bottom: 1px solid #ebebeb; font-size: 11.5px; vertical-align: top; }
      td:last-child { text-align: right; font-weight: 700; }
      .garantia-chip { display: inline-block; background: #e8f5e9; color: #2e7d32; border-radius: 20px; padding: 2px 8px; font-size: 10px; font-weight: 600; margin-top: 3px; }
      .garantia-chip.vencida { background: #fce4e4; color: #b71c1c; }
      .imei-label { font-family: monospace; font-size: 10px; color: #888; margin-top: 2px; }

      /* ── TOTALES ── */
      .totales-wrap { display: flex; justify-content: flex-end; margin-bottom: 20px; }
      .totales-box { width: 280px; }
      .totales-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 11.5px; color: #555; }
      .totales-row.grand { font-size: 16px; font-weight: 800; color: #1a1a1a; border-top: 2px solid #1a1a1a; margin-top: 6px; padding-top: 8px; }

      /* ── PAGOS ── */
      .pagos-box { margin-bottom: 20px; }
      .pago-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #ebebeb; font-size: 11.5px; }
      .pago-row:last-child { border-bottom: none; }
      .pagos-resumen { display: flex; justify-content: flex-end; align-items: center; gap: 24px; margin-top: 10px; }
      .pagos-nums { text-align: right; font-size: 11.5px; }
      .estado-badge { padding: 7px 18px; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; border-radius: 5px; }
      .estado-badge.pagado { background: #1a1a1a; color: #fff; }
      .estado-badge.pendiente { background: #ff9800; color: #fff; }

      /* ── GARANTIAS ── */
      .garantias-block { margin-bottom: 20px; padding: 14px 16px; background: #f0f7ff; border-radius: 8px; border-left: 4px solid #1565c0; }
      .garantias-block .gtitle { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #1565c0; margin-bottom: 10px; }
      .garantia-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #dce8f5; font-size: 11.5px; }
      .garantia-item:last-child { border-bottom: none; }
      .garantia-dates { text-align: right; font-size: 10.5px; color: #444; }
      .garantia-dates .vence { font-weight: 700; color: #1565c0; font-size: 12px; }

      /* ── TYC ── */
      .tyc-block { margin-bottom: 20px; padding: 14px 16px; background: #fafafa; border: 1px solid #e0e0e0; border-radius: 8px; }
      .tyc-block .tyc-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #888; margin-bottom: 8px; }
      .tyc-block p { font-size: 10.5px; color: #555; line-height: 1.6; }

      /* ── FIRMA ── */
      .firma-section { display: flex; gap: 30px; margin-bottom: 20px; margin-top: 24px; }
      .firma-box { flex: 1; padding-top: 36px; border-top: 1.5px solid #1a1a1a; text-align: center; font-size: 10px; color: #888; }

      /* ── FOOTER ── */
      .footer { text-align: center; font-size: 9px; color: #aaa; padding-top: 12px; border-top: 1px solid #e0e0e0; display: flex; flex-direction: column; align-items: center; gap: 3px; }
      .footer svg { margin-bottom: 4px; opacity: 0.25; }

      @media print { .page { padding: 16px 20px; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
    </style></head><body><div class="page">

    <!-- HEADER -->
    <div class="header">
      <div class="brand">
        ${LOGO_HTML}
        <div class="brand-text">
          <div class="brand-name">iPhoneMood</div>
          <div class="brand-addr">Julio Argentino Roca 700, Granadero Baigorria, Santa Fe<br>Tel: +54 9 3413 66-2150 · iphonemood.ar@gmail.com</div>
        </div>
      </div>
      <div class="header-right">
        <div class="numero-recibo">
          <div>N° Recibo:</div>
          <div class="num">${v.id}</div>
          <div style="margin-top:6px">Fecha:</div>
          <div style="font-weight:700;color:#1a1a1a">${fechaVentaFmt}</div>
        </div>
        <div class="recibo-badge">RECIBO</div>
      </div>
    </div>

    <!-- BARRA ACENTO -->
    <div class="accent-bar">
      <span>Comprobante de venta — iPhoneMood Rosario</span>
      <span>Venta #${v.id} · ${v.estado === 'cerrada' ? 'Cerrada' : 'Abierta'}</span>
    </div>

    <!-- CLIENTE -->
    <div class="cliente-box">
      <div class="label">Recibido por</div>
      <div class="nombre">${v.cliente}</div>
      <div class="datos">
        ${v.clienteTel ? `<span>📞 ${v.clienteTel}</span>` : ''}
        ${v.clienteDni ? `<span>DNI: ${v.clienteDni}</span>` : ''}
        ${v.vendedor ? `<span>Vendedor: ${v.vendedor}</span>` : ''}
      </div>
    </div>

    <!-- ITEMS -->
    <div class="section-title">Detalle de Productos y Servicios</div>
    <table>
      <thead><tr>
        <th style="width:40px">Cant.</th>
        <th>Descripción</th>
        <th style="width:120px">Garantía</th>
        <th style="width:100px;text-align:right">Precio</th>
      </tr></thead>
      <tbody>
      ${v.items.map(i => {
        const stockItem = State.stock.find(s => s.id === i.stockId);
        const diasGar = i.garantiaDias || (i.garantiaFin ? Math.max(0, Math.round((new Date(i.garantiaFin)-new Date())/86400000)) : null);
        const hoy = new Date();
        const vence = i.garantiaFin ? new Date(i.garantiaFin) : (diasGar ? calcVencimiento(v.fecha, diasGar) : null);
        const activa = vence && vence >= hoy;
        return `<tr>
          <td style="text-align:center">1</td>
          <td>
            <div style="font-weight:600">${i.nombre}</div>
            ${i.imei ? `<div class="imei-label">IMEI: ${i.imei}</div>` : ''}
            ${stockItem?.estadoProducto ? `<div style="font-size:10px;color:#888">${stockItem.estadoProducto}</div>` : ''}
          </td>
          <td>
            ${vence ? `<span class="garantia-chip ${activa?'':'vencida'}">${activa ? 'Activa' : 'Vencida'}</span>` : '<span style="color:#bbb;font-size:11px">Sin garantía</span>'}
          </td>
          <td>USD ${i.precio.toFixed(2)}</td>
        </tr>`;
      }).join('')}
      ${v.tradeIn?.modelo ? `<tr>
        <td style="text-align:center">1</td>
        <td><div style="font-weight:600">Trade-In: ${v.tradeIn.modelo}</div><div style="font-size:10px;color:#888">Entregado como parte de pago</div></td>
        <td><span style="color:#bbb;font-size:11px">—</span></td>
        <td style="color:#b00000">- USD ${(v.tradeIn.valor||0).toFixed(2)}</td>
      </tr>` : ''}
      </tbody>
    </table>

    <!-- TOTALES -->
    <div class="totales-wrap">
      <div class="totales-box">
        <div class="totales-row"><span>Subtotal Dispositivos</span><span>USD ${itemsDisp.reduce((s,i)=>s+i.precio,0).toFixed(2)}</span></div>
        <div class="totales-row"><span>Subtotal Accesorios</span><span>USD ${itemsAcc.reduce((s,i)=>s+i.precio,0).toFixed(2)}</span></div>
        ${v.tradeIn?.valor ? `<div class="totales-row" style="color:#b00000"><span>Trade-In (descuento)</span><span>- USD ${v.tradeIn.valor.toFixed(2)}</span></div>` : ''}
        <div class="totales-row grand"><span>TOTAL</span><span>USD ${Math.max(0,total-(v.tradeIn?.valor||0)).toFixed(2)}</span></div>
      </div>
    </div>

    <!-- PAGOS -->
    <div class="pagos-box">
      <div class="section-title">Pagos Realizados</div>
      ${v.pagos.map(p => `
        <div class="pago-row">
          <span>${fechaVentaFmt} · ${p.bolsillo}</span>
          <span>${p.bolsillo?.startsWith('ARS') ? `$ ${(p.monto*(p.cotizacionDiferencial||State.refBlue)).toLocaleString('es-AR')} ARS (USD ${p.monto} @ $${(p.cotizacionDiferencial||State.refBlue).toLocaleString('es-AR')})` : `USD ${p.monto.toFixed(2)}`}</span>
        </div>`).join('')}
      <div class="pagos-resumen">
        <div class="pagos-nums">
          <div>Total pagado: <b>USD ${pagado.toFixed(2)}</b></div>
          ${saldo < -0.01 ? `<div style="color:#b00000">Saldo: <b>USD ${saldo.toFixed(2)}</b></div>` : ''}
        </div>
        <div class="estado-badge ${saldo <= 0.01 ? 'pagado' : 'pendiente'}">${saldo <= 0.01 ? 'PAGADO' : 'SALDO PENDIENTE'}</div>
      </div>
    </div>

    <!-- GARANTÍAS CON FECHAS -->
    ${v.items.some(i => i.garantiaDias || i.garantiaFin) ? `
    <div class="garantias-block">
      <div class="gtitle">🛡 Garantía incluida</div>
      ${v.items.filter(i => i.garantiaDias || i.garantiaFin).map(i => {
        const hoy = new Date();
        const vence = i.garantiaFin ? new Date(i.garantiaFin) : calcVencimiento(v.fecha, i.garantiaDias);
        const activa = vence && vence >= hoy;
        const diasRest = vence ? Math.max(0, Math.round((vence - hoy) / 86400000)) : 0;
        return `<div class="garantia-item">
          <span><b>${i.nombre}</b>${i.imei ? ` · IMEI ${i.imei}` : ''}</span>
          <div class="garantia-dates">
            <div>Desde: ${fechaVentaFmt}</div>
            <div class="vence">Vence: ${vence ? fmtFecha(vence.toISOString()) : '—'}</div>
            <div style="font-size:9.5px;color:${activa?'#388e3c':'#b71c1c'}">${activa ? `${diasRest} días restantes` : 'Garantía vencida'}</div>
          </div>
        </div>`;
      }).join('')}
    </div>` : ''}

    <!-- CONDICIONES DE GARANTIA -->
    ${condiciones ? `
    <div class="tyc-block">
      <div class="tyc-title">Términos y condiciones de garantía</div>
      <p>${condiciones.replace(/\n/g,'<br>')}</p>
    </div>` : ''}

    <!-- FIRMA -->
    <div class="firma-section">
      <div class="firma-box">Firma</div>
      <div class="firma-box">Aclaración</div>
      <div class="firma-box">DNI</div>
    </div>

    <!-- FOOTER -->
    <div class="footer">
      ${LOGO_FOOTER}
      <span>DOCUMENTO NO VÁLIDO COMO FACTURA</span>
      <span>Generado el ${new Date().toLocaleDateString('es-AR')} a las ${new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}</span>
      <span>Recibo N° ${v.id} · iPhoneMood · Granadero Baigorria, Santa Fe</span>
    </div>

    </div></body></html>`;
    this._abrirVentanaPDF(html, `Recibo_${v.id}`);
  },

  generarDetallePDF(id) {
    const v = State.ventas.find(x => x.id === id);
    if (!v) return;
    const total = v.items.reduce((s, i) => s + i.precio, 0);
    const pagado = v.pagos.reduce((s, p) => s + p.monto, 0);
    const saldo = pagado - total;
    const profitTotal = v.items.reduce((s,i)=>s+(i.precio-(i.costo||0)),0);
    const dispositivosCats = ['iphone','android','mac','ipad','watch'];
    const itemsDisp = v.items.filter(i => { const p = State.stock.find(s => s.id === i.stockId); return p ? dispositivosCats.includes(p.cat) : false; });
    const itemsAcc = v.items.filter(i => { const p = State.stock.find(s => s.id === i.stockId); return !p || !dispositivosCats.includes(p.cat); });

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Venta #${v.id}</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: Arial, sans-serif; font-size: 12px; color: #1a1a1a; padding: 20px; }
      .header { margin-bottom: 16px; }
      .header h1 { font-size: 22px; margin-bottom: 2px; }
      .header .sub { font-size: 11px; color: #666; }
      .section { margin-bottom: 16px; }
      .section h3 { font-size: 13px; border-bottom: 1px solid #ccc; padding-bottom: 4px; margin-bottom: 8px; }
      .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 20px; margin-bottom: 12px; }
      .info-grid div { font-size: 11px; }
      .info-grid span { color: #666; display: block; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 10px; font-size: 11px; }
      th { background: #1a1a1a; color: #fff; padding: 5px 7px; text-align: left; }
      td { padding: 5px 7px; border-bottom: 1px solid #e0e0e0; vertical-align: top; }
      .resumen { text-align: right; border-top: 1px solid #ccc; padding-top: 8px; }
      .resumen div { margin-bottom: 2px; }
      .footer { text-align: center; font-size: 9px; color: #aaa; margin-top: 20px; border-top: 1px solid #e0e0e0; padding-top: 8px; }
      @media print { body { padding: 10px; } }
    </style></head><body>
    <div class="header">
      <div style="font-size:16px;font-weight:bold">IPhoneMood</div>
      <h1>DETALLE DE VENTA</h1>
      <div class="sub">Venta #${v.id} · Fecha: ${v.fecha} · Estado: ${v.estado==='cerrada'?'Cerrada':'Abierta'}</div>
    </div>

    <div class="section">
      <h3>INFORMACIÓN DEL CLIENTE</h3>
      <div class="info-grid">
        <div><span>Cliente</span>${v.cliente}</div>
        ${v.clienteTel?`<div><span>Teléfono</span>${v.clienteTel}</div>`:''}
        ${v.clienteDni?`<div><span>DNI</span>${v.clienteDni}</div>`:''}
        <div><span>Vendedor</span>${v.vendedor||'—'}</div>
      </div>
    </div>

    ${itemsDisp.length ? `
    <div class="section">
      <h3>DISPOSITIVOS VENDIDOS</h3>
      <table><thead><tr><th>Dispositivo</th><th>Condición</th><th>Identificador</th><th>Garantía</th><th>P.Compra</th><th>P.Venta</th><th>Profit</th><th>Comisión</th></tr></thead>
      <tbody>${itemsDisp.map(i=>{
        const p=State.stock.find(s=>s.id===i.stockId);
        const dias=i.garantiaFin?Math.max(0,Math.round((new Date(i.garantiaFin)-new Date())/86400000)):null;
        const profit=i.precio-(i.costo||0);
        return `<tr><td><b>${i.nombre}</b>${p?.notas?`<br><small style="color:#666;font-style:italic">${p.notas}</small>`:''}</td><td>${p?.estadoProducto||'Usado'}</td><td style="font-family:monospace;font-size:10px">${i.imei||'—'}</td><td>${dias!==null?`${dias} días restantes`:'—'}</td><td>$${(i.costo||0).toFixed(2)}</td><td>$${i.precio}</td><td style="color:${profit>=0?'green':'red'}">${profit>=0?'+':''}$${profit.toFixed(2)}</td><td>$${(v.comisionVendedor||0).toFixed(2)}</td></tr>`;
      }).join('')}</tbody></table>
    </div>` : ''}

    ${itemsAcc.length ? `
    <div class="section">
      <h3>ACCESORIOS VENDIDOS</h3>
      <table><thead><tr><th>Accesorio</th><th>SKU</th><th>Cant.</th><th>P.Compra</th><th>P.Venta</th><th>Profit</th><th>Comisión</th></tr></thead>
      <tbody>${itemsAcc.map(i=>{
        const p=State.stock.find(s=>s.id===i.stockId);
        const profit=i.precio-(i.costo||0);
        return `<tr><td>${i.nombre}</td><td style="font-size:10px">${p?.storage||p?.notas||'N/A'}</td><td>1</td><td>$${(i.costo||0).toFixed(2)}</td><td>$${i.precio}</td><td style="color:${profit>=0?'green':'red'}">${profit>=0?'+':''}$${profit.toFixed(2)}</td><td>$0</td></tr>`;
      }).join('')}</tbody></table>
    </div>` : ''}

    <div class="section">
      <h3>PAGOS REGISTRADOS</h3>
      <table><thead><tr><th>Fecha</th><th>Método</th><th>Monto</th></tr></thead>
      <tbody>${v.pagos.map(p=>`<tr><td>${v.fecha}</td><td>${p.bolsillo}${p.esTarjeta?' (Tarjeta)':''}</td><td>${p.bolsillo?.startsWith('ARS')?`$ ${(p.monto*(p.cotizacionDiferencial||State.refBlue)).toLocaleString('es-AR')} ARS (USD ${p.monto} @ $${(p.cotizacionDiferencial||State.refBlue).toLocaleString('es-AR')})`:State.fmtUSD(p.monto)}</td></tr>`).join('')}</tbody>
      </table>
    </div>

    <div class="resumen">
      <div>Total Venta: <b>$${total.toFixed(2)} USD</b></div>
      <div style="color:${profitTotal>=0?'green':'red'}">Profit Total: ${profitTotal>=0?'+':''}$${profitTotal.toFixed(2)} USD</div>
      <div>Total Pagado: <b>$${pagado.toFixed(2)} USD</b></div>
      <div>Saldo: <b>$${saldo.toFixed(2)} USD</b></div>
      <div style="font-weight:bold;margin-top:4px">Ganancia Neta: ${profitTotal>=0?'+':''}$${profitTotal.toFixed(2)} USD</div>
    </div>

    <div class="footer">
      Generado el ${new Date().toLocaleDateString('es-AR')} a las ${new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}
    </div>
    </body></html>`;
    this._abrirVentanaPDF(html, `Venta_${v.id}`);
  },

  _sugerirWhatsappVenta(v) {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;bottom:80px;right:20px;background:var(--bg-elevated);border:1px solid #25D366;border-radius:var(--radius-lg);padding:12px 16px;z-index:9000;box-shadow:var(--shadow-md);max-width:300px';
    banner.innerHTML = `
      <div style="font-size:12px;font-weight:600;color:#25D366;margin-bottom:6px"><i class="ti ti-brand-whatsapp"></i> ¿Enviar recibo por WhatsApp?</div>
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px">Venta #${v.id} para <b>${v.cliente}</b></div>
      <div style="display:flex;gap:6px">
        <button onclick="this.closest('div[style]').remove()" style="flex:1;font-size:11px;padding:5px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text-secondary);cursor:pointer">No</button>
        <button onclick="Ventas._whatsappVenta(${v.id});this.closest('div[style]').remove()" style="flex:2;font-size:11px;padding:5px;border:none;border-radius:6px;background:#25D366;color:#fff;cursor:pointer;font-weight:600"><i class="ti ti-brand-whatsapp"></i> Enviar</button>
      </div>`;
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 12000);
  },

  _whatsappVenta(id) {
    const v = State.ventas.find(x => x.id === id);
    if (!v) return;
    const total = v.items.reduce((s, i) => s + i.precio, 0);
    const items = v.items.map(i => `• ${i.nombre} — USD ${i.precio.toFixed(0)}`).join('\n');
    const estado = v.estado === 'cerrada' ? '✅ Pagado' : '⏳ Saldo pendiente';
    const msg = `¡Hola ${v.cliente}! 🙌\n\nAcá va el resumen de tu compra en *iPhoneMood*:\n\n${items}\n\n💰 *Total: USD ${total.toFixed(0)}*\n${estado}\n\n¡Muchas gracias por elegirnos! 😊\n_iPhoneMood — Rosario_`;
    const tel = (v.clienteTel || '').replace(/\D/g, '');
    window.open(`https://wa.me/${tel ? '549' + tel : ''}?text=${encodeURIComponent(msg)}`, '_blank');
  },

  // ── Registrar cobro en ventas abiertas ────────────────
  abrirCobro(id) {
    const v = State.ventas.find(x => x.id === id);
    if (!v) return;
    const total = v.items.reduce((s, i) => s + i.precio, 0);
    const pagado = v.pagos.reduce((s, p) => s + p.monto, 0);
    const saldo = Math.max(0, total - pagado);
    const personaOpts = State.personas.map(p => `<option>${p}</option>`).join('');
    const overlay = document.createElement('div');
    overlay.id = 'cobro-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(6px);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:var(--radius-xl);width:min(400px,96vw);overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border)">
          <div style="font-size:14px;font-weight:700">Registrar cobro — Venta #${v.id}</div>
          <div style="font-size:11px;color:var(--text-secondary)">${v.cliente} · Saldo pendiente: <b style="color:var(--amber)">USD ${saldo.toFixed(2)}</b></div>
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
          <div>
            <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Monto (USD)</label>
            <input type="number" id="cobro-monto" value="${saldo.toFixed(2)}" min="0" step="0.01"
              style="width:100%;font-size:16px;font-weight:700;padding:9px 12px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Caja</label>
              <select id="cobro-persona" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">${personaOpts}</select>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px">Forma de pago</label>
              <select id="cobro-bolsillo" style="width:100%;font-size:13px;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border-strong);border-radius:8px;color:var(--text)">
                <option>ARS cash</option><option>ARS transferencia</option><option>USD cash</option><option>USD transferencia</option><option>USDT</option>
              </select>
            </div>
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
          <button class="btn" onclick="document.getElementById('cobro-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="Ventas.submitCobro(${id})"><i class="ti ti-cash"></i> Registrar cobro</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById('cobro-monto')?.select(), 60);
  },

  async submitCobro(id) {
    const monto = parseFloat(document.getElementById('cobro-monto')?.value) || 0;
    if (!monto) { toast('Ingresá un monto.'); return; }
    const persona  = document.getElementById('cobro-persona')?.value;
    const bolsillo = document.getElementById('cobro-bolsillo')?.value;
    const v = State.ventas.find(x => x.id === id);
    if (!v) { toast('Error: venta no encontrada.'); return; }
    document.getElementById('cobro-overlay')?.remove();
    const pago = { persona, bolsillo, monto, caja: `${persona}-${bolsillo}`, esTarjeta: false, diferencialArs: 0 };
    v.pagos.push(pago);
    let montoEnBolsillo = monto;
    if (bolsillo.startsWith('ARS')) montoEnBolsillo = monto * State.refBlue;
    State.acreditarCaja(persona, bolsillo, montoEnBolsillo);
    await DB.agregarPagoVenta(id, pago);
    const total = v.items.reduce((s, i) => s + i.precio, 0);
    const pagado = v.pagos.reduce((s, p) => s + p.monto, 0) + (v.tradeIn?.valor || 0);
    if (pagado >= total) {
      v.estado = 'cerrada';
      await DB.actualizarEstadoVenta(id, 'cerrada');
      toast(`Cobro registrado. Venta #${id} cerrada ✓`);
    } else {
      toast(`Cobro de USD ${monto.toFixed(2)} registrado en caja de ${persona}.`);
    }
    this.renderList();
    this.viewSale(id);
  },

  async cerrarVentaManual(id) {
    const v = State.ventas.find(x => x.id === id);
    if (!v) return;
    if (!confirm(`¿Marcar la venta #${id} como cerrada/pagada?`)) return;
    v.estado = 'cerrada';
    await DB.actualizarEstadoVenta(id, 'cerrada');
    toast(`Venta #${id} marcada como cerrada ✓`);
    this.renderList();
    this.viewSale(id);
  },

  async eliminarPago(ventaId, pagoId) {
    if (!confirm('¿Eliminar este pago? El saldo de la venta se actualizará y el monto se debitará de la caja.')) return;
    const v = State.ventas.find(x => x.id === ventaId);
    const pago = v?.pagos.find(p => p.id === pagoId);
    const ok = await DB.eliminarPagoVenta(pagoId);
    if (!ok) { toast('Error al eliminar el pago'); return; }
    if (v) {
      // Revertir el movimiento de caja
      if (pago) {
        let montoEnBolsillo = pago.monto;
        if (pago.bolsillo?.startsWith('ARS')) montoEnBolsillo = pago.monto * (pago.cotizacionDiferencial || State.refBlue);
        State.debitarCaja(pago.persona, pago.bolsillo, montoEnBolsillo);
      }
      v.pagos = v.pagos.filter(p => p.id !== pagoId);
      const total = v.items.reduce((s, i) => s + i.precio, 0);
      const pagado = v.pagos.reduce((s, p) => s + p.monto, 0) + (v.tradeIn?.valor || 0);
      const nuevoEstado = (total - pagado) <= 0.5 ? 'cerrada' : 'abierta';
      if (nuevoEstado !== v.estado) {
        v.estado = nuevoEstado;
        await DB.actualizarEstadoVenta(ventaId, nuevoEstado);
      }
    }
    toast('Pago eliminado ✓');
    this.renderList();
    this.viewSale(ventaId);
  },

  async anular(id) {
    const v = State.ventas.find(x => x.id === id);
    if (!v) return;
    if (!confirm(`¿Anular la venta #${v.id}? Esto revertirá el stock y los pagos en las cajas correspondientes.`)) return;
    // Revertir stock — si stockMovs no existe (ventas cargadas de DB), usar los items con stockId
    const movsARestaurar = (v.stockMovs && v.stockMovs.length)
      ? v.stockMovs
      : v.items.filter(i => i.stockId).map(i => ({ stockId: i.stockId, imei: i.imei || null }));
    for (const m of movsARestaurar) {
      State.restaurarStock(m.stockId, m.imei);
      const item = State.stock.find(s => s.id === m.stockId || s.id == m.stockId);
      if (item) {
        if (item.imeis) {
          await DB.actualizarImeisStock(m.stockId, item.imeis);
        } else {
          await DB.actualizarCantidadStock(m.stockId, item.cantidad);
        }
        // Siempre restaurar el estado a disponible si tiene stock
        if (State.getStock(item) > 0 && item.estadoInventario !== 'disponible') {
          item.estadoInventario = 'disponible';
          await DB.actualizarEstadoInventario(m.stockId, 'disponible');
        }
      }
    }
    // Revertir cajas usando la cotización original del pago, no la actual
    v.pagos.forEach(p => {
      let montoEnBolsillo = p.monto;
      if (p.bolsillo?.startsWith('ARS')) montoEnBolsillo = p.monto * (p.cotizacionDiferencial || State.refBlue);
      State.debitarCaja(p.persona, p.bolsillo, montoEnBolsillo);
    });
    await DB.anularVenta(id);
    State.ventas = State.ventas.filter(x => x.id !== id);
    this.closeModal();
    this.renderList();
    toast(`Venta #${id} anulada. Stock restaurado y pagos revertidos en las cajas de origen.`);
  }
};

window.Ventas = Ventas;
