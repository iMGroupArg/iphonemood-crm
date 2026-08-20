// Presupuestos con canje para mandarle al cliente por WhatsApp.
//
// Reemplaza el texto que Franco escribía a mano: elegís el equipo del stock,
// cargás qué entrega el cliente y cuánto se lo cotizás, y sale un link a una
// página visual con el saldo y todas las cuotas ya calculadas.
//
// Los números se CONGELAN al crear el presupuesto (precio, dólar y
// coeficientes de financiación). Es una oferta con validez: si mañana sube el
// blue, el número que el cliente recibió hoy no puede cambiarle solo.
const Presupuestos = {
  lista: [],
  draft: null,

  render() {
    const c = document.createElement('div');
    c.style.cssText = 'flex:1;overflow-y:auto;padding:18px 22px';
    c.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px">
        <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px">Presupuestos con canje</h3>
        <button class="btn btn-primary" onclick="Presupuestos.nuevo()">+ Nuevo presupuesto</button>
      </div>
      <div style="background:var(--blue-light);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:11.5px;color:var(--blue)">
        <i class="ti ti-info-circle"></i> El link que se genera muestra el equipo, el canje descontado, el saldo y todas las cuotas. Los valores quedan fijos: si cambia el dólar o el precio, el presupuesto ya enviado no se altera.
      </div>
      <div id="pres-lista"></div>`;
    setTimeout(() => this.cargar(), 0);
    return c;
  },

  async cargar() {
    this.lista = await DB.listarPresupuestos();
    this.renderLista();
  },

  renderLista() {
    const cont = document.getElementById('pres-lista');
    if (!cont) return;
    if (!this.lista.length) {
      cont.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-secondary);font-size:13px">Todavía no generaste ninguno.</div>`;
      return;
    }
    cont.innerHTML = this.lista.map(p => {
      const prod = p.producto || {};
      const ti = p.trade_in;
      const saldo = Math.max(0, (Number(prod.precio_usd) || 0) - (ti ? Number(ti.valor_usd) || 0 : 0));
      const vencido = p.vence_en && new Date(p.vence_en) < new Date();
      return `<div class="card" style="margin-bottom:10px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <div style="flex:1;min-width:200px">
          <div style="font-size:13px;font-weight:700">${State.esc(prod.nombre || 'Equipo')}</div>
          <div style="font-size:11.5px;color:var(--text-secondary);margin-top:2px">
            ${p.cliente ? State.esc(p.cliente) + ' · ' : ''}${ti ? `canje ${State.esc(ti.modelo || '')} U$D ${ti.valor_usd} · ` : ''}saldo <strong>U$D ${saldo}</strong>
          </div>
          <div style="font-size:10.5px;color:var(--text-secondary);margin-top:3px">
            ${DB.fmtFecha(p.creado_en)}${vencido ? ' · <span style="color:var(--red)">VENCIDO</span>' : ''}
          </div>
        </div>
        <button class="btn btn-sm" onclick="Presupuestos.copiarLink('${p.token}')">🔗 Copiar link</button>
        <button class="btn btn-sm" onclick="Presupuestos.eliminar('${p.token}')" title="Eliminar">🗑</button>
      </div>`;
    }).join('');
  },

  copiarLink(token) {
    const url = `${location.origin}/precios.html?presupuesto=${token}`;
    navigator.clipboard.writeText(url)
      .then(() => toast('🔗 Link copiado. Ya se lo podés mandar al cliente.'))
      .catch(() => prompt('Copiá este link:', url));
  },

  async eliminar(token) {
    if (!confirm('¿Eliminar este presupuesto? El link deja de funcionar.')) return;
    await DB.eliminarPresupuesto(token);
    await this.cargar();
    toast('Presupuesto eliminado.');
  },

  // ── Alta ──
  nuevo() {
    // Solo equipos disponibles y con precio: no tiene sentido presupuestar
    // algo que no se puede vender.
    const disponibles = (State.stock || []).filter(p =>
      (p.estadoInventario || 'disponible') === 'disponible' && Number(p.precioARS) > 0 && Number(p.cotiz) > 0);
    if (!disponibles.length) { toast('No hay equipos disponibles con precio cargado.'); return; }

    this.draft = { productoId: disponibles[0].id, cliente: '', diasValidez: 7,
                   ti: { activo: true, modelo: '', storage: '', color: '', estado: 'Excelente', bateria: '', valor: '' } };
    this.abrirModal(disponibles);
  },

  abrirModal(disponibles) {
    const d = this.draft;
    const ESTADOS = ['Nuevo / Sellado', 'Excelente', 'Muy bueno', 'Bueno', 'Con detalles'];
    const STORAGE = ['64GB', '128GB', '256GB', '512GB', '1TB'];
    const inp = 'width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px';
    const lbl = 'font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px';

    const html = `
      <div style="margin-bottom:12px">
        <label style="${lbl}">Equipo que se lleva *</label>
        <select id="pr-producto" style="${inp}" onchange="Presupuestos.recalcular()">
          ${disponibles.map(p => `<option value="${p.id}">${State.esc(p.nombre)} — U$D ${Math.round(p.precioARS / p.cotiz)}</option>`).join('')}
        </select>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div><label style="${lbl}">Cliente</label><input id="pr-cliente" placeholder="ej: Facundo" style="${inp}"></div>
        <div><label style="${lbl}">Validez (días)</label><input id="pr-dias" type="number" min="1" value="7" style="${inp}"></div>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:12px;margin-bottom:10px">
        <label style="display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;cursor:pointer">
          <input type="checkbox" id="pr-ti-on" checked onchange="Presupuestos.toggleTI(this.checked)"> Entrega un equipo en parte de pago
        </label>
      </div>
      <div id="pr-ti-wrap">
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;margin-bottom:10px">
          <div><label style="${lbl}">Modelo que entrega *</label><input id="pr-ti-modelo" placeholder="ej: iPhone 16" style="${inp}"></div>
          <div><label style="${lbl}">Capacidad</label>
            <select id="pr-ti-storage" style="${inp}"><option value=""></option>${STORAGE.map(s => `<option>${s}</option>`).join('')}</select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px">
          <div><label style="${lbl}">Color</label><input id="pr-ti-color" placeholder="ej: Negro" style="${inp}"></div>
          <div><label style="${lbl}">Estado</label>
            <select id="pr-ti-estado" style="${inp}">${ESTADOS.map(e => `<option${e === 'Excelente' ? ' selected' : ''}>${e}</option>`).join('')}</select>
          </div>
          <div><label style="${lbl}">Batería %</label><input id="pr-ti-bat" type="number" min="0" max="100" placeholder="91" style="${inp}"></div>
        </div>
        <div style="margin-bottom:12px">
          <label style="${lbl}">Cotización que le das (U$D) *</label>
          <input id="pr-ti-valor" type="number" min="0" placeholder="550" style="${inp};font-size:15px;font-weight:700" oninput="Presupuestos.recalcular()">
        </div>
      </div>
      <div id="pr-preview" style="background:var(--bg-secondary);border-radius:8px;padding:12px;font-size:12.5px"></div>`;

    // Se reusa el modal genérico del CRM si existe; si no, uno simple.
    if (typeof openModal === 'function') {
      openModal('Nuevo presupuesto', html, [
        { texto: 'Cancelar', clase: 'btn', accion: 'closeModal()' },
        { texto: 'Generar link', clase: 'btn btn-primary', accion: 'Presupuestos.guardar()' },
      ]);
    } else {
      this._modalSimple('Nuevo presupuesto', html);
    }
    setTimeout(() => this.recalcular(), 30);
  },

  _modalSimple(titulo, html) {
    const ov = document.createElement('div');
    ov.id = 'pr-modal';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = `<div style="background:var(--bg-elevated);border-radius:14px;max-width:560px;width:100%;max-height:90vh;overflow-y:auto;padding:20px">
      <h3 style="font-size:15px;font-weight:700;margin-bottom:14px">${titulo}</h3>
      ${html}
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
        <button class="btn" onclick="document.getElementById('pr-modal').remove()">Cancelar</button>
        <button class="btn btn-primary" onclick="Presupuestos.guardar()">Generar link</button>
      </div>
    </div>`;
    ov.onclick = e => { if (e.target === ov) ov.remove(); };
    document.body.appendChild(ov);
  },

  toggleTI(on) {
    const w = document.getElementById('pr-ti-wrap');
    if (w) w.style.display = on ? 'block' : 'none';
    this.recalcular();
  },

  _productoElegido() {
    const id = document.getElementById('pr-producto')?.value;
    return (State.stock || []).find(p => String(p.id) === String(id));
  },

  recalcular() {
    const box = document.getElementById('pr-preview');
    if (!box) return;
    const p = this._productoElegido();
    if (!p) { box.textContent = '—'; return; }
    const precio = Math.round(p.precioARS / p.cotiz);
    const conTI = document.getElementById('pr-ti-on')?.checked;
    const valorTI = conTI ? (parseFloat(document.getElementById('pr-ti-valor')?.value) || 0) : 0;
    const saldo = Math.max(0, precio - valorTI);
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between"><span>Equipo</span><strong>U$D ${precio}</strong></div>
      ${conTI ? `<div style="display:flex;justify-content:space-between;color:var(--green)"><span>Canje</span><strong>− U$D ${valorTI}</strong></div>` : ''}
      <div style="display:flex;justify-content:space-between;border-top:1px solid var(--border);margin-top:6px;padding-top:6px;font-size:14px">
        <strong>Saldo a abonar</strong><strong>U$D ${saldo}</strong></div>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:4px">≈ ${State.fmtARS(saldo * State.refBlue)} al blue de hoy ($${State.refBlue.toLocaleString('es-AR')})</div>`;
  },

  async guardar() {
    const p = this._productoElegido();
    if (!p) { toast('Elegí el equipo.'); return; }
    const conTI = document.getElementById('pr-ti-on')?.checked;
    const modelo = document.getElementById('pr-ti-modelo')?.value.trim();
    const valor = parseFloat(document.getElementById('pr-ti-valor')?.value);
    if (conTI && (!modelo || !(valor > 0))) { toast('Cargá el modelo que entrega y su cotización.'); return; }

    const dias = parseInt(document.getElementById('pr-dias')?.value) || 7;
    // Token largo y aleatorio: es lo único que protege el presupuesto, así
    // que tiene que ser imposible de adivinar probando.
    const token = [...crypto.getRandomValues(new Uint8Array(16))]
      .map(b => b.toString(16).padStart(2, '0')).join('');

    const fila = {
      token,
      cliente: document.getElementById('pr-cliente')?.value.trim() || null,
      vence_en: new Date(Date.now() + dias * 864e5).toISOString(),
      producto: {
        nombre: p.nombre, modelo: p.modelo, storage: p.storage, color: p.color,
        categoria: p.cat, estado_producto: p.estadoProducto,
        precio_usd: Math.round(p.precioARS / p.cotiz),
      },
      trade_in: conTI ? {
        modelo, storage: document.getElementById('pr-ti-storage')?.value || '',
        color: document.getElementById('pr-ti-color')?.value.trim() || '',
        estado: document.getElementById('pr-ti-estado')?.value || '',
        bateria_pct: parseInt(document.getElementById('pr-ti-bat')?.value) || null,
        valor_usd: valor,
      } : null,
      cotizacion: State.refBlue,
      pagos_cfg: (await DB.leerPagosConfig()) || {},
    };

    const { error } = await DB.crearPresupuesto(fila);
    if (error) { toast('No se pudo guardar el presupuesto.'); console.error(error); return; }

    document.getElementById('pr-modal')?.remove();
    if (typeof closeModal === 'function') closeModal();
    await this.cargar();
    this.copiarLink(token);
  },
};

window.Presupuestos = Presupuestos;
export default Presupuestos;
