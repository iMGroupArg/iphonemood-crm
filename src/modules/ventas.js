const Ventas = {
  step: 0,
  STEPS: ['Cliente', 'Trade-In', 'Ítems', 'Pagos', 'Confirm.'],
  draft: null,
  selectedStockIds: [],
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

  render() {
    const c = document.createElement('div');
    c.innerHTML = `
      <div style="padding:12px 22px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;flex-shrink:0">
        <div style="display:flex;gap:4px;flex-wrap:wrap" id="ventas-periodo-tabs"></div>
        <button class="btn btn-primary" onclick="Ventas.openNew()"><i class="ti ti-plus"></i> Nueva venta</button>
      </div>
      <div id="ventas-rango-libre" style="display:none;padding:8px 22px;border-bottom:1px solid var(--border);gap:8px;align-items:center;flex-wrap:wrap">
        <input type="date" id="ventas-desde" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:8px">
        <span style="font-size:12px;color:var(--text-secondary)">hasta</span>
        <input type="date" id="ventas-hasta" style="font-size:12px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:8px">
        <button class="btn btn-sm btn-primary" onclick="Ventas.aplicarRangoLibre()">Aplicar</button>
      </div>
      <div id="ventas-metricas" style="padding:14px 22px;border-bottom:1px solid var(--border);display:grid;grid-template-columns:repeat(5,1fr);gap:10px"></div>
      <div class="body-pad" style="padding-top:0;overflow-y:auto">
        <table><thead><tr>
          <th>#</th><th>Fecha</th><th>Cliente</th><th>Tipo</th><th>Ítems</th><th>Total</th><th>Pagos</th><th>Estado</th><th></th>
        </tr></thead>
        <tbody id="ventas-tbody"></tbody></table>
      </div>
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
    const dispCats=['iphone','android','mac','ipad','watch'];

    const volumen=ventas.reduce((s,v)=>s+v.items.reduce((a,i)=>a+i.precio,0),0);
    const margenTotal=ventas.reduce((s,v)=>s+v.items.reduce((a,i)=>a+(i.precio-(i.costo||0)),0),0);

    // Margen por equipo: precio venta disp − (costo disp + costo accesorios), promediado
    const margenesXVenta=ventas.map(v=>{
      const disp=v.items.filter(i=>{const p=State.stock.find(s=>s.id===i.stockId);return p?dispCats.includes(p.cat):false;});
      const acc=v.items.filter(i=>{const p=State.stock.find(s=>s.id===i.stockId);return!p||!dispCats.includes(p.cat);});
      return disp.reduce((a,i)=>a+i.precio,0)-(disp.reduce((a,i)=>a+(i.costo||0),0)+acc.reduce((a,i)=>a+(i.costo||0),0));
    });
    const margenXEquipo=margenesXVenta.length?margenesXVenta.reduce((a,v)=>a+v,0)/margenesXVenta.length:0;

    const diferencial=ventas.reduce((s,v)=>s+(v.pagos||[]).filter(p=>p.esTarjeta).reduce((a,p)=>a+(p.diferencialArs?(p.diferencialArs/(p.cotizacionDiferencial||State.refBlue)):0),0),0);

    const kpis=[
      {label:'Volumen vendido',val:State.fmtUSD(volumen),sub:`${ventas.length} venta(s)`,icon:'ti-trending-up',color:'var(--blue)',bg:'var(--blue-light)'},
      {label:'Margen total',val:State.fmtUSD(margenTotal),sub:'precio venta − costo',icon:'ti-cash',color:margenTotal>=0?'var(--green)':'var(--red)',bg:margenTotal>=0?'var(--green-light)':'#FEE2E2'},
      {label:'Margen por equipo',val:State.fmtUSD(margenXEquipo),sub:'promedio (disp − todo)',icon:'ti-device-mobile',color:margenXEquipo>=0?'var(--green)':'var(--red)',bg:margenXEquipo>=0?'var(--green-light)':'#FEE2E2'},
      {label:'Diferencial tarjeta',val:State.fmtUSD(diferencial),sub:'ganancia financiera',icon:'ti-credit-card',color:'var(--purple)',bg:'var(--purple-light)'},
      {label:'Ticket promedio',val:ventas.length?State.fmtUSD(volumen/ventas.length):'USD 0',sub:'por venta',icon:'ti-receipt',color:'var(--text)',bg:'var(--bg-secondary)'},
    ];

    el.innerHTML=kpis.map(k=>`
      <div class="card" style="padding:12px 14px;margin-bottom:0;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;min-height:90px">
        <div style="min-width:0;flex:1">
          <label style="font-size:10.5px;color:var(--text-secondary);display:block;margin-bottom:3px">${k.label}</label>
          <div style="font-size:17px;font-weight:700;color:${k.color};word-break:break-word">${k.val}</div>
          <div style="font-size:10px;color:var(--text-secondary);margin-top:2px">${k.sub}</div>
        </div>
        <div style="width:32px;height:32px;border-radius:8px;background:${k.bg};display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="ti ${k.icon}" style="color:${k.color};font-size:16px"></i>
        </div>
      </div>`).join('');
  },

  renderList() {
    const tbody=document.getElementById('ventas-tbody');
    if (!tbody) return;
    const ventas=this.ventasDelPeriodo();
    const TIPO={minorista:'Minorista',mayorista:'Mayorista',revendedor:'Revendedor'};
    if (!ventas.length) { tbody.innerHTML=`<tr><td colspan="9"><div class="empty-state"><i class="ti ti-receipt-off"></i>Sin ventas en este período</div></td></tr>`; return; }
    tbody.innerHTML=ventas.map(v=>{
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
        <td><button class="btn btn-sm" onclick="Ventas.viewSale(${v.id})"><i class="ti ti-eye"></i> Ver</button></td>
      </tr>`;
    }).join('');
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
    this.draft = { cliente: '', clienteTel: '', clienteDni: '', tipoVenta: 'minorista', vendedor: '', tradeIn: null, items: [], pagos: [], comisionVendedor: 0 };
    this.step = 0;
    this.selectedStockIds = [];
    this.invMode = 'manual';
    this.showModal();
  },

  mostrarRecuperarBorrador(pendiente) {
    const host = document.getElementById('venta-modal-host');
    const minsAtras = Math.round((Date.now() - pendiente.guardadoEn) / 60000);
    host.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:200">
        <div style="width:380px;max-width:92vw;background:var(--bg-elevated);border-radius:14px;padding:20px" onclick="event.stopPropagation()">
          <h3 style="font-size:15px;font-weight:600;margin-bottom:8px"><i class="ti ti-alert-circle" style="color:var(--amber)"></i> Encontramos una venta sin terminar</h3>
          <p style="font-size:12.5px;color:var(--text-secondary);margin-bottom:14px">
            Parece que la página se recargó mientras estabas cargando una venta para <b>${pendiente.draft.cliente || 'un cliente'}</b>
            (${pendiente.draft.items?.length || 0} ítem(s)), hace ${minsAtras < 1 ? 'menos de un minuto' : minsAtras + ' min'}.
            ¿Querés continuarla donde la dejaste, o empezar una venta nueva?
          </p>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn" onclick="Ventas.descartarBorradorYEmpezarNueva()">Empezar de cero</button>
            <button class="btn btn-primary" onclick="Ventas.recuperarBorrador()"><i class="ti ti-history"></i> Continuar venta</button>
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
    this.selectedStockIds = [];
    this.invMode = 'manual';
    this.showModal();
    toast('Venta recuperada. Revisá los datos antes de continuar.');
  },
  descartarBorradorYEmpezarNueva() {
    this.borrarBorrador();
    this.draft = { cliente: '', clienteTel: '', clienteDni: '', tipoVenta: 'minorista', vendedor: '', tradeIn: null, items: [], pagos: [], comisionVendedor: 0 };
    this.step = 0;
    this.selectedStockIds = [];
    this.invMode = 'manual';
    this.showModal();
  },

  showModal() {
    const host = document.getElementById('venta-modal-host');
    host.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:200" onkeydown="if(event.key==='Enter'){event.preventDefault();}">
        <div style="width:600px;max-width:94vw;max-height:88vh;background:var(--bg-elevated);border-radius:14px;display:flex;flex-direction:column;overflow:hidden">
          <div style="padding:14px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
            <h3 style="font-size:15px;font-weight:600">Nueva venta</h3>
            <button class="btn btn-sm" onclick="Ventas.closeModal()"><i class="ti ti-x"></i></button>
          </div>
          <div style="padding:14px 20px;border-bottom:1px solid var(--border);display:flex;gap:4px" id="venta-stepper"></div>
          <div style="flex:1;overflow-y:auto;padding:18px 20px" id="venta-step-body"></div>
          <div style="padding:13px 20px;border-top:1px solid var(--border);display:flex;justify-content:space-between">
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
    document.getElementById('venta-stepper').innerHTML = this.STEPS.map((s, i) => {
      const done = i < this.step, active = i === this.step;
      const color = done || active ? 'var(--blue)' : 'var(--border-strong)';
      return `<div style="flex:1;text-align:center">
        <div style="width:24px;height:24px;border-radius:50%;background:${done||active?'var(--blue)':'var(--bg-secondary)'};color:${done||active?'#fff':'var(--text-secondary)'};display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600">${done?'✓':i+1}</div>
        <div style="font-size:9.5px;color:${active?'var(--blue)':'var(--text-secondary)'};margin-top:2px;font-weight:${active?'600':'400'}">${s}</div>
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

  stepCliente() {
    const d = this.draft;
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Nombre del cliente</label>
          <input type="text" id="vf-cliente" value="${d.cliente||''}" placeholder="Consumidor final si se deja vacío" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px"></div>
        <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Teléfono</label>
          <input type="text" id="vf-cliente-tel" value="${d.clienteTel||''}" placeholder="ej: 3413686909" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">DNI</label>
          <input type="text" id="vf-cliente-dni" value="${d.clienteDni||''}" placeholder="ej: 34139974" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px"></div>
        <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Tipo de venta</label>
          <select id="vf-tipo-venta" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
            <option value="minorista" ${(d.tipoVenta||'minorista')==='minorista'?'selected':''}>Minorista</option>
            <option value="mayorista" ${d.tipoVenta==='mayorista'?'selected':''}>Mayorista</option>
            <option value="revendedor" ${d.tipoVenta==='revendedor'?'selected':''}>Revendedor</option>
          </select></div>
      </div>
      <div><label style="font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px">Vendedor</label>
        <select id="vf-vendedor" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
          <option value="">Seleccionar</option>
          ${State.personas.map(p=>`<option ${d.vendedor===p?'selected':''}>${p}</option>`).join('')}
        </select></div>
    `;
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
      ${d.items.map((it, idx) => `<div style="display:flex;justify-content:space-between;padding:8px 10px;background:var(--bg-secondary);border-radius:8px;margin-bottom:5px;font-size:12px">
        <span>${it.nombre} — ${State.fmtUSD(it.precio)}</span>
        <button onclick="Ventas.removeItem(${idx})" style="background:none;border:none;cursor:pointer;color:var(--text-secondary)"><i class="ti ti-x"></i></button>
      </div>`).join('')}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0">
        <button class="btn ${this.invMode==='manual'?'btn-primary':''}" onclick="Ventas.setInvMode('manual')">Carga manual</button>
        <button class="btn ${this.invMode==='inventario'?'btn-primary':''}" onclick="Ventas.setInvMode('inventario')">Desde inventario</button>
      </div>
      <div id="vf-item-form">${this.invMode === 'manual' ? this.manualItemForm() : this.inventoryForm()}</div>
    `;
  },
  setInvMode(m) { this.invMode = m; document.getElementById('venta-step-body').innerHTML = this.stepItems(); },

  manualItemForm() {
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
        <input type="text" id="vf-m-nombre" placeholder="Nombre del producto" style="font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
        <input type="number" id="vf-m-costo" placeholder="Costo USD" style="font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
      </div>
      <input type="number" id="vf-m-precio" placeholder="Precio de venta (USD)" style="width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px;margin-bottom:8px">
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

  inventoryForm() {
    const disponibles = State.stock.filter(s => State.getStock(s) > 0);
    return `
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px">${disponibles.length} productos con stock disponible</div>
      <div style="display:flex;flex-direction:column;gap:8px;max-height:260px;overflow-y:auto">
        ${disponibles.map(s => {
          const sel = this.selectedStockIds.includes(s.id);
          const precioUSD = s.precioARS && s.cotiz ? +(s.precioARS / s.cotiz).toFixed(2) : 0;
          return `<div style="border:${sel?'2px solid var(--blue)':'1px solid var(--border)'};background:${sel?'var(--blue-light)':'var(--bg)'};border-radius:8px;padding:9px 11px;font-size:11.5px">
            <div onclick="Ventas.toggleStockSel('${s.id}')" style="cursor:pointer;margin-bottom:${sel?'8px':'0'}">
              <b style="font-size:12px">${s.nombre}</b><br>
              <span style="color:var(--text-secondary)">Costo: USD ${s.costoUSD}${precioUSD ? ' · Precio sugerido: USD ' + precioUSD : ''}</span>
            </div>
            ${sel ? `<div style="display:flex;align-items:center;gap:8px;margin-top:4px">
              <label style="font-size:10px;color:var(--text-secondary);white-space:nowrap">Precio venta (USD):</label>
              <input type="number" id="inv-precio-${s.id}" value="${precioUSD || ''}" min="0" step="0.01" placeholder="0"
                style="font-size:13px;font-weight:700;padding:4px 8px;border:1px solid var(--border-strong);border-radius:6px;width:110px;color:var(--text);background:var(--bg-secondary)"
                onclick="event.stopPropagation()">
            </div>` : ''}
          </div>`;
        }).join('')}
      </div>
      ${this.selectedStockIds.length ? `<button class="btn btn-green" style="width:100%;justify-content:center;margin-top:10px" onclick="Ventas.addStockItems()"><i class="ti ti-check"></i> Agregar ${this.selectedStockIds.length} seleccionado(s)</button>` : ''}
    `;
  },
  toggleStockSel(id) {
    const i = this.selectedStockIds.indexOf(id);
    if (i >= 0) this.selectedStockIds.splice(i, 1); else this.selectedStockIds.push(id);
    document.getElementById('vf-item-form').innerHTML = this.inventoryForm();
  },
  addStockItems() {
    this.selectedStockIds.forEach(id => {
      const s = State.stock.find(x => x.id === id);
      if (!s) return;
      const imei = s.imeis && s.imeis.length ? s.imeis[0] : null;
      // Leer precio ingresado por el usuario; si vacío usar el precio del stock en USD
      const precioIngresado = parseFloat(document.getElementById(`inv-precio-${id}`)?.value);
      const precioUSD = precioIngresado > 0 ? precioIngresado : (s.precioARS && s.cotiz ? +(s.precioARS / s.cotiz).toFixed(2) : 0);
      this.draft.items.push({ nombre: s.nombre, precio: precioUSD, costo: s.costoUSD, stockId: id, imei });
    });
    this.selectedStockIds = [];
    document.getElementById('venta-step-body').innerHTML = this.stepItems();
    this.guardarBorrador();
  },
  removeItem(idx) { this.draft.items.splice(idx, 1); document.getElementById('venta-step-body').innerHTML = this.stepItems(); this.guardarBorrador(); },

  stepPagos() {
    const d = this.draft;
    const total = Math.max(0, d.items.reduce((s, i) => s + i.precio, 0) - (d.tradeIn?.valor || 0));
    const pagado = d.pagos.reduce((s, p) => s + Ventas.montoSinDiferencial(p), 0);
    const saldo = Math.max(0, total - pagado);
    return `
      <div style="display:flex;gap:16px;padding:10px 0;border-bottom:1px solid var(--border);margin-bottom:12px">
        <div><div style="font-size:11px;color:var(--text-secondary)">Total venta</div><div style="font-size:16px;font-weight:600">${State.fmtUSD(total)}</div></div>
        <div><div style="font-size:11px;color:var(--text-secondary)">Saldo restante</div><div style="font-size:16px;font-weight:600;color:${saldo>0?'var(--red)':'var(--green)'}">${State.fmtUSD(saldo)}</div></div>
      </div>
      ${d.pagos.map((p, idx) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 10px;background:var(--bg-secondary);border-radius:8px;margin-bottom:5px;font-size:12px">
        <span>${p.persona} — ${p.bolsillo} — ${State.fmtUSD(p.monto)}${p.esTarjeta?` <span class="badge b-purple" style="font-size:9px">Tarjeta +$${(p.diferencialArs||0).toLocaleString('es-AR')}</span>`:''}</span>
        <button onclick="Ventas.removePago(${idx})" style="background:none;border:none;cursor:pointer"><i class="ti ti-x"></i></button>
      </div>`).join('')}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0">
        <select id="vf-pago-persona" style="font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
          ${State.personas.map(p=>`<option>${p}</option>`).join('')}
        </select>
        <select id="vf-pago-bolsillo" onchange="Ventas.toggleTarjetaWrap()" style="font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
          <option>ARS cash</option><option>ARS transferencia</option><option>USD cash</option><option>USD transferencia</option><option>USDT</option>
        </select>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input type="number" id="vf-pago-monto" value="${saldo.toFixed(2)}" style="flex:1;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px">
        <button class="btn btn-primary" onclick="Ventas.addPago()"><i class="ti ti-plus"></i> Agregar pago</button>
      </div>
      <label style="display:flex;align-items:center;gap:7px;font-size:12.5px;cursor:pointer;margin-bottom:8px" id="vf-tarjeta-check-wrap">
        <input type="checkbox" id="vf-es-tarjeta" onchange="Ventas.toggleDiferencialWrap()"> Pago con tarjeta de crédito (posnet)
      </label>
      <div id="vf-diferencial-wrap" style="display:none;background:var(--purple-light);border-radius:8px;padding:10px 12px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--purple);margin-bottom:8px">
          <span>Precio de lista (a cubrir)</span><b>${State.fmtUSD(total)}</b>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
          <div>
            <label style="font-size:11px;color:var(--purple);font-weight:600;display:block;margin-bottom:4px">Monto cargado en posnet (ARS)</label>
            <input type="number" id="vf-monto-posnet" placeholder="ej: 1420000" oninput="Ventas.actualizarDiferencialPreview()" style="width:100%;font-size:13px;font-weight:600;padding:8px 10px;border:1px solid var(--border-strong);border-radius:8px">
          </div>
          <div>
            <label style="font-size:11px;color:var(--purple);font-weight:600;display:block;margin-bottom:4px">Comisión banco (coef.)</label>
            <input type="number" id="vf-coef-comision" placeholder="ej: 0.29" step="0.01" oninput="Ventas.actualizarDiferencialPreview()" style="width:100%;font-size:13px;font-weight:600;padding:8px 10px;border:1px solid var(--border-strong);border-radius:8px">
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
  addPago() {
    const persona = document.getElementById('vf-pago-persona').value;
    const bolsillo = document.getElementById('vf-pago-bolsillo').value;
    const esTarjeta = document.getElementById('vf-es-tarjeta')?.checked || false;
    let monto = parseFloat(document.getElementById('vf-pago-monto').value) || 0;
    let diferencialArs = 0;
    let cotizacionDiferencial = null;

    if (esTarjeta) {
      const { montoPosnet, netoArs, precioVentaRealUSD, diferencialUSD, cotiz } = this.calcularVentaTarjeta();
      if (!montoPosnet) { toast('Ingresá el monto cargado en el posnet.'); return; }
      monto = precioVentaRealUSD; // lo que efectivamente cubre del precio de la venta
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
    const total = Math.max(0, d.items.reduce((s, i) => s + i.precio, 0) - (d.tradeIn?.valor || 0));
    const pagado = d.pagos.reduce((s, p) => s + Ventas.montoSinDiferencial(p), 0);
    const saldo = Math.max(0, total - pagado);
    const pagosTarjeta = d.pagos.filter(p => p.esTarjeta);
    const totalDiferencialArs = pagosTarjeta.reduce((s, p) => s + (p.diferencialArs || 0), 0);
    return `
      <div style="margin-bottom:14px"><b>Cliente:</b> ${d.cliente || 'Consumidor final'} ${d.vendedor?`· Vendedor: ${d.vendedor}`:''}</div>
      <div style="margin-bottom:14px"><b>Ítems (${d.items.length})</b>
        ${d.items.map(i=>`<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">${i.nombre}<span>${State.fmtUSD(i.precio)}</span></div>`).join('')}
      </div>
      <div style="margin-bottom:14px"><b>Pagos (${d.pagos.length})</b>
        ${d.pagos.map(p=>`<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">${p.persona} — ${p.bolsillo}${p.esTarjeta?' <span class="badge b-purple" style="font-size:9px">Tarjeta</span>':''}<span>${State.fmtUSD(p.monto)}</span></div>`).join('')}
      </div>
      ${pagosTarjeta.length ? `
      <div style="background:var(--purple-light);border-radius:8px;padding:10px 12px;margin-bottom:14px">
        <div style="font-size:11px;color:var(--purple);font-weight:600;margin-bottom:6px"><i class="ti ti-credit-card"></i> Detalle del cálculo de tarjeta</div>
        ${pagosTarjeta.map(p => {
          const cotiz = p.cotizacionDiferencial || State.refBlue;
          const precioVentaRealUSD = p.monto;
          return `
            <div style="font-size:11px;color:var(--purple);padding:2px 0;display:flex;justify-content:space-between"><span>Cotización usada</span><b>$${cotiz.toLocaleString('es-AR')}</b></div>
            <div style="font-size:11px;color:var(--purple);padding:2px 0;display:flex;justify-content:space-between"><span>Precio de venta real</span><b>${State.fmtUSD(precioVentaRealUSD)}</b></div>
            <div style="font-size:12px;color:var(--green);font-weight:600;padding-top:4px;display:flex;justify-content:space-between"><span>Diferencial ganado</span><span>+$${(p.diferencialArs||0).toLocaleString('es-AR')} (${State.fmtUSD((p.diferencialArs||0)/cotiz)})</span></div>
          `;
        }).join('<div style="height:1px;background:#fff;margin:6px 0"></div>')}
      </div>` : ''}
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
        this.draft.tipoVenta = document.getElementById('vf-tipo-venta')?.value || 'minorista';
        this.draft.vendedor = document.getElementById('vf-vendedor').value;
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
    const total = Math.max(0, d.items.reduce((s, i) => s + i.precio, 0) - (d.tradeIn?.valor || 0));
    const pagado = d.pagos.reduce((s, p) => s + Ventas.montoSinDiferencial(p), 0);
    const estado = pagado >= total ? 'cerrada' : 'abierta';

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
    if (!ventaId) { toast('Hubo un problema guardando la venta. Probá de nuevo.'); return; }

    const venta = {
      id: ventaId, fecha: 'Hoy', cliente: d.cliente, vendedor: d.vendedor,
      items: d.items, pagos: d.pagos.map(p => ({ caja: `${p.persona}-${p.bolsillo}`, monto: p.monto, persona: p.persona, bolsillo: p.bolsillo, esTarjeta: !!p.esTarjeta, diferencialArs: p.diferencialArs || 0, cotizacionDiferencial: p.cotizacionDiferencial || null })),
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
    const total = v.items.reduce((s, i) => s + i.precio, 0);
    const pagado = v.pagos.reduce((s, p) => s + p.monto, 0);
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
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:200" onclick="if(event.target===this) Ventas.closeModal()">
        <div style="width:820px;max-width:96vw;max-height:92vh;background:var(--bg-elevated);border-radius:14px;display:flex;flex-direction:column;overflow:hidden" onclick="event.stopPropagation()">

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
              <button class="btn btn-sm" onclick="Ventas.closeModal()"><i class="ti ti-x"></i></button>
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
                  <td>${i.nombre}</td>
                  <td style="font-size:11px;color:var(--text-secondary)">${p?.storage||p?.notas||'N/A'}</td>
                  <td>1</td>
                  <td>${State.fmtUSD(i.precio)}</td>
                  <td style="color:${profit>=0?'var(--green)':'var(--red)'}">${profit>=0?'+':''}${State.fmtUSD(profit)}</td>
                  <td>$0</td>
                </tr>`;
              }).join('')}</tbody></table>
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
              <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px">
                <div><label style="font-size:11px;color:var(--text-secondary)">Total Venta</label><div style="font-size:17px;font-weight:700">${State.fmtUSD(total)}</div></div>
                <div><label style="font-size:11px;color:var(--text-secondary)">Total Pagos</label><div style="font-size:17px;font-weight:700">${State.fmtUSD(pagado)}</div></div>
                <div><label style="font-size:11px;color:var(--text-secondary)">Saldo</label><div style="font-size:17px;font-weight:700;color:${saldo<=0?'var(--text)':'var(--red)'}">${State.fmtUSD(saldo)}</div></div>
              </div>
              ${v.pagos.map(p => `
                <div style="display:flex;justify-content:space-between;align-items:center;background:var(--bg-secondary);border-radius:8px;padding:10px 12px;margin-bottom:6px">
                  <div style="display:flex;align-items:center;gap:10px">
                    <i class="ti ti-${p.bolsillo?.includes('USD')||p.bolsillo?.includes('USDT')?'currency-dollar':'building-bank'}" style="font-size:20px;color:var(--text-secondary)"></i>
                    <div>
                      <div style="font-size:12.5px;font-weight:600">${p.persona} — ${p.bolsillo}${p.esTarjeta?` <span class="badge b-purple" style="font-size:9px">Tarjeta</span>`:''}</div>
                      <div style="font-size:11px;color:var(--text-secondary)">${v.fecha}</div>
                    </div>
                  </div>
                  <div style="text-align:right">
                    <div style="font-size:13px;font-weight:600">${State.fmtUSD(p.monto)}</div>
                    ${p.bolsillo?.startsWith('ARS')&&p.cotizacionDiferencial ? `<div style="font-size:10px;color:var(--text-secondary)">(USD ${p.monto} @ $${(p.cotizacionDiferencial||State.refBlue).toLocaleString('es-AR')})</div>` : ''}
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
            <button class="btn btn-sm" style="color:var(--red)" onclick="Ventas.anular(${id})"><i class="ti ti-trash"></i> Anular</button>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${v.clienteTel ? `<button class="btn btn-sm" onclick="Ventas._whatsappVenta(${id})" style="color:#25D366;border-color:#25D366"><i class="ti ti-brand-whatsapp"></i> WhatsApp</button>` : ''}
              ${!cerrada ? `<button class="btn btn-sm btn-primary" onclick="Ventas.abrirCobro(${id})"><i class="ti ti-cash"></i> Registrar cobro</button>` : ''}
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
    const pagado = v.pagos.reduce((s, p) => s + p.monto, 0);
    const saldo = pagado - total;
    const dispositivosCats = ['iphone','android','mac','ipad','watch'];
    const itemsDisp = v.items.filter(i => { const p = State.stock.find(s => s.id === i.stockId); return p ? dispositivosCats.includes(p.cat) : false; });
    const itemsAcc = v.items.filter(i => { const p = State.stock.find(s => s.id === i.stockId); return !p || !dispositivosCats.includes(p.cat); });

    const garantiasHTML = v.items.filter(i => i.garantiaFin).map(i =>
      `<li>${i.nombre} - Válida desde ${i.garantiaInicio||v.fecha} hasta ${i.garantiaFin}</li>`
    ).join('');

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Recibo #${v.id}</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: Arial, sans-serif; font-size: 12px; color: #1a1a1a; padding: 20px; }
      .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; }
      .logo { font-size: 24px; font-weight: bold; }
      .recibo-badge { font-size: 24px; font-weight: bold; color: #888; }
      .datos-negocio { font-size: 10px; color: #666; margin-top: 4px; }
      .recibido { display: flex; justify-content: space-between; margin-bottom: 16px; }
      .recibido-box { font-size: 12px; }
      .recibido-box div { margin-bottom: 4px; }
      .numero-recibo { border: 1px solid #ccc; padding: 8px 14px; font-size: 12px; min-width: 160px; }
      .numero-recibo .num { font-size: 22px; font-weight: bold; margin: 2px 0; }
      h3 { font-size: 13px; margin-bottom: 8px; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 11px; }
      th { background: #1a1a1a; color: #fff; padding: 6px 8px; text-align: left; }
      td { padding: 6px 8px; border-bottom: 1px solid #e0e0e0; vertical-align: top; }
      .totales { margin-left: auto; width: 260px; }
      .totales div { display: flex; justify-content: space-between; padding: 4px 0; }
      .total-final { font-size: 16px; font-weight: bold; border-top: 2px solid #1a1a1a; padding-top: 6px; margin-top: 4px; }
      .pagos-section { margin-bottom: 16px; }
      .pagos-totales { display: flex; justify-content: flex-end; gap: 40px; }
      .pagado-badge { background: #1a1a1a; color: #fff; padding: 6px 18px; font-weight: bold; text-align: center; }
      .mensaje { margin: 16px 0; font-style: italic; }
      .tyc { font-size: 10px; color: #555; margin-top: 12px; border-top: 1px solid #ccc; padding-top: 10px; }
      .tyc h4 { font-size: 11px; margin-bottom: 6px; }
      .garantias { margin-bottom: 12px; }
      .firma-section { display: flex; gap: 40px; margin-top: 24px; }
      .firma-box { flex: 1; border-top: 1px solid #1a1a1a; padding-top: 4px; font-size: 10px; color: #888; text-align: center; }
      .footer { text-align: center; font-size: 9px; color: #aaa; margin-top: 20px; border-top: 1px solid #e0e0e0; padding-top: 8px; }
      @media print { body { padding: 10px; } }
    </style></head><body>
    <div class="header">
      <div>
        <div class="logo">IPhoneMood</div>
        <div class="datos-negocio">Julio Argentino Roca 700, Granadero Baigorria, Santa Fe<br>Tel: +54 9 3413 66-2150 | Email: iphonemood.ar@gmail.com</div>
      </div>
      <div style="display:flex;align-items:center;gap:20px">
        <div class="numero-recibo">
          <div>N° Recibo:</div><div class="num">${v.id}</div>
          <div>Fecha:</div><div style="font-weight:bold">${v.fecha}</div>
        </div>
        <div class="recibo-badge">RECIBO</div>
      </div>
    </div>

    <div class="recibido">
      <div class="recibido-box">
        <div style="font-weight:bold;margin-bottom:6px">RECIBIDO POR:</div>
        <div><b>Cliente:</b> ${v.cliente}</div>
        ${v.clienteTel ? `<div><b>Teléfono:</b> ${v.clienteTel}</div>` : ''}
        ${v.clienteDni ? `<div><b>DNI:</b> ${v.clienteDni}</div>` : ''}
      </div>
    </div>

    <h3>DETALLE DE PRODUCTOS Y SERVICIOS</h3>
    ${itemsDisp.length ? `
    <table>
      <thead><tr><th>Cant.</th><th>Descripción</th><th>Identificador</th><th>Garantía</th><th>Precio Unit.</th><th>Subtotal</th></tr></thead>
      <tbody>${itemsDisp.map(i => {
        const diasRestantes = i.garantiaFin ? Math.max(0,Math.round((new Date(i.garantiaFin)-new Date())/86400000)) : null;
        return `<tr>
          <td>1</td><td>${i.nombre}</td>
          <td style="font-family:monospace;font-size:10px">${i.imei ? i.imei.substring(0,6)+'...'+i.imei.substring(i.imei.length-4) : '—'}</td>
          <td>${diasRestantes !== null ? `Garantía activa - ${diasRestantes} días restantes (${diasRestantes}d)` : '—'}</td>
          <td>$${i.precio} USD</td><td><b>$${i.precio} USD</b></td>
        </tr>`;
      }).join('')}</tbody>
    </table>` : ''}

    ${itemsAcc.length ? `
    <table>
      <thead><tr><th>Cant.</th><th>Descripción</th><th>SKU</th><th>Garantía</th><th>Precio Unit.</th><th>Subtotal</th></tr></thead>
      <tbody>${itemsAcc.map(i => {
        const p = State.stock.find(s => s.id === i.stockId);
        return `<tr><td>1</td><td>${i.nombre}</td><td style="font-size:10px">${p?.storage||p?.notas||'—'}</td><td>—</td><td>$${i.precio} USD</td><td><b>$${i.precio} USD</b></td></tr>`;
      }).join('')}</tbody>
    </table>` : ''}

    ${garantiasHTML ? `<div class="garantias"><h3>GARANTÍAS:</h3><ul>${garantiasHTML}</ul></div>` : ''}

    <div class="totales">
      <div><span>Subtotal Dispositivos:</span><span>$${itemsDisp.reduce((s,i)=>s+i.precio,0)} USD</span></div>
      <div><span>Subtotal Accesorios:</span><span>$${itemsAcc.reduce((s,i)=>s+i.precio,0)} USD</span></div>
      <div class="total-final"><span>TOTAL:</span><span>$${total} USD</span></div>
    </div>

    <div class="pagos-section">
      <h3>PAGOS REALIZADOS:</h3>
      ${v.pagos.map(p => `<div style="margin-bottom:4px">${v.fecha} - ${p.bolsillo}${p.bolsillo?.startsWith('ARS')?`: $ ${(p.monto*State.refBlue).toLocaleString('es-AR')} ARS (USD ${p.monto} @ $${(p.cotizacionDiferencial||State.refBlue).toLocaleString('es-AR')})`:`${State.fmtUSD(p.monto)}`}</div>`).join('')}
      <div class="pagos-totales" style="margin-top:8px">
        <div style="text-align:right">
          <div>Total Pagado: <b>$${pagado.toFixed(2)} USD</b></div>
          <div>Saldo: <b>$${saldo.toFixed(2)} USD</b></div>
        </div>
        <div class="pagado-badge">${saldo <= 0.01 ? 'PAGADO' : 'SALDO PENDIENTE'}</div>
      </div>
    </div>

    <div class="mensaje"><b>MENSAJE:</b><br>¡Muchas gracias por elegir a iPhoneMood! 🙌</div>

    <div class="tyc">
      <h4>TÉRMINOS Y CONDICIONES:</h4>
      ${State.garantias.map(g => `<p style="margin-bottom:6px">${g.tc || ''}</p>`).join('')}
    </div>

    <div class="firma-section">
      <div class="firma-box">Firma</div>
      <div class="firma-box">Aclaración</div>
      <div class="firma-box">DNI</div>
    </div>

    <div class="footer">
      DOCUMENTO NO VÁLIDO COMO FACTURA<br>
      Documento generado el ${new Date().toLocaleDateString('es-AR')} a las ${new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}<br>
      Recibo N° ${v.id} | IPhoneMood
    </div>
    </body></html>`;
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
    document.getElementById('cobro-overlay')?.remove();
    const v = State.ventas.find(x => x.id === id);
    if (!v) return;
    const pago = { persona, bolsillo, monto, caja: `${persona}-${bolsillo}`, esTarjeta: false, diferencialArs: 0 };
    v.pagos.push(pago);
    let montoEnBolsillo = monto;
    if (bolsillo.startsWith('ARS')) montoEnBolsillo = monto * State.refBlue;
    State.acreditarCaja(persona, bolsillo, montoEnBolsillo);
    await DB.agregarPagoVenta(id, pago);
    const total = v.items.reduce((s, i) => s + i.precio, 0);
    const pagado = v.pagos.reduce((s, p) => s + p.monto, 0);
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

  async anular(id) {
    const v = State.ventas.find(x => x.id === id);
    if (!v) return;
    if (!confirm(`¿Anular la venta #${v.id}? Esto revertirá el stock y los pagos en las cajas correspondientes.`)) return;
    // Revertir stock (memoria + base de datos)
    for (const m of (v.stockMovs || [])) {
      State.restaurarStock(m.stockId, m.imei);
      const item = State.stock.find(s => s.id === m.stockId);
      if (item) {
        if (item.imeis) await DB.actualizarImeisStock(m.stockId, item.imeis);
        else await DB.actualizarCantidadStock(m.stockId, item.cantidad);
      }
    }
    // Revertir cajas
    v.pagos.forEach(p => {
      let montoEnBolsillo = p.monto;
      if (p.bolsillo.startsWith('ARS')) montoEnBolsillo = p.monto * State.refBlue;
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
