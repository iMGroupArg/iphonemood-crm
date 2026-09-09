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

  // Trabajos que el equipo ya lleva hechos y que se le aclaran al cliente en el
  // presupuesto. No es una lista cerrada: abajo hay un campo libre.
  //
  // Es información que conviene decir de frente. Un usado al que se le cambió
  // la batería vale MÁS que uno al que no, pero si el cliente se entera después
  // suena a algo que se le ocultó. Dicho en el presupuesto, juega a favor.
  SERVICIOS: [
    'Batería nueva',
    'Pantalla nueva',
    'Vidrio trasero nuevo',
    'Cámara reparada',
    'Puerto de carga reparado',
    'Limpieza y mantenimiento',
  ],

  // Cómo se llama la plata que el cliente pone de entrada. No cambia ninguna
  // cuenta — es solo cómo se lee en el presupuesto que recibe.
  CONCEPTOS_EFECTIVO: ['Efectivo en USD', 'Efectivo en pesos', 'Transferencia', 'Seña ya entregada'],

  // Qué cuenta como "equipo" en el desplegable de venta. Cargadores, fundas,
  // baterías y repuestos NO van: el stock guarda una fila por unidad física,
  // así que el mismo cargador aparecía diez veces y tapaba a los iPhone.
  CATS_EQUIPO: ['iphone', 'android', 'mac', 'ipad'],

  // Orden natural de un equipo: primero la generación, después la variante.
  // Hace falta porque el orden alfabético es inservible acá — pone el
  // "iPhone 13" después del "iPhone 17 Pro" y mezcla las líneas.
  ordenModelo(modelo) {
    const s = String(modelo || '').toLowerCase();
    const gen = parseInt((s.match(/iphone\s*(\d+)/) || [])[1], 10);
    if (!gen) return 1e6; // lo que no es iPhone (Mac, iPad, Android) va al final
    let v = 0;
    if (/\bpro max\b/.test(s)) v = 4;
    else if (/\bpro\b/.test(s)) v = 3;
    else if (/\bplus\b/.test(s)) v = 2;
    else if (/\bmini\b/.test(s) || /\d+e\b/.test(s)) v = 1;
    return gen * 10 + v;
  },

  // Catálogo de canje: iPhone 13 en adelante, que es lo que Franco toma.
  // Sale de Stock.SPECS_POR_MODELO para no mantener dos listas de modelos.
  modelosCanje() {
    return Object.keys((window.Stock || {}).SPECS_POR_MODELO || {})
      .filter(m => /^iPhone/i.test(m) && this.ordenModelo(m) >= 130)
      .sort((a, b) => this.ordenModelo(a) - this.ordenModelo(b));
  },

  // Capacidades y colores REALES con los que salió ese modelo.
  // A propósito NO se usa Stock.specsParaModelo(): esa mezcla lo que haya
  // cargado en el stock, y acá el punto es justamente no ofrecer un color que
  // ese modelo nunca tuvo. Sin modelo elegido, se cae a las listas generales.
  specsCanje(modelo) {
    const S = window.Stock || {};
    const base = (S.SPECS_POR_MODELO || {})[modelo];
    return base || { s: S.STORAGE_OPCIONES || [], c: S.COLOR_OPCIONES || [] };
  },

  // Equipos vendibles, sin repetidos y ordenados por modelo.
  equiposDisponibles() {
    const vivos = (State.stock || []).filter(p =>
      this.CATS_EQUIPO.includes(p.cat) &&
      (p.estadoInventario || 'disponible') === 'disponible' &&
      Number(p.precioARS) > 0 && Number(p.cotiz) > 0);

    // Se colapsan las filas idénticas en una sola opción, contando unidades.
    // La fila que queda es una real del stock, así que el id sigue sirviendo.
    const vistos = new Map();
    vivos.forEach(p => {
      const usd = Math.round(p.precioARS / p.cotiz);
      const k = [p.nombre, p.modelo, p.storage, p.color, usd].join('|').toLowerCase();
      const prev = vistos.get(k);
      if (prev) { prev.unidades++; return; }
      // La etiqueta suma capacidad y color si el nombre no los trae ya: sin eso
      // dos iPhone 15 del mismo precio y distinto color se ven idénticos en el
      // desplegable, que es exactamente lo confuso que había que sacar.
      const yaEsta = t => !t || p.nombre.toLowerCase().includes(String(t).toLowerCase());
      const extra = [p.storage, p.color].filter(t => t && !yaEsta(t)).join(' · ');
      const etiqueta = p.nombre + (extra ? ` ${extra}` : '');
      vistos.set(k, { id: p.id, nombre: p.nombre, etiqueta, modelo: p.modelo, usd, unidades: 1 });
    });

    return [...vistos.values()].sort((a, b) =>
      this.ordenModelo(a.modelo || a.nombre) - this.ordenModelo(b.modelo || b.nombre) ||
      String(a.nombre).localeCompare(String(b.nombre), 'es'));
  },

  render() {
    const c = document.createElement('div');
    c.style.cssText = 'flex:1;overflow-y:auto;padding:18px 22px';
    c.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px">
        <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.4px">Presupuestos con canje</h3>
        <button class="btn btn-primary" onclick="Presupuestos.nuevo()">+ Nuevo presupuesto</button>
      </div>
      <div style="background:var(--blue-light);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:11.5px;color:var(--blue)">
        <i class="ti ti-info-circle"></i> El link que se genera muestra el equipo, lo que el cliente entrega (equipo usado, dinero o las dos cosas), el saldo y todas las cuotas. Los valores quedan fijos: si cambia el dólar o el precio, el presupuesto ya enviado no se altera.
      </div>
      <div id="pres-barra"></div>
      <div id="pres-lista"></div>`;
    setTimeout(() => this.cargar(), 0);
    return c;
  },

  // Tokens marcados con la casilla. Se guarda el token y no el índice de la
  // fila: la lista se vuelve a pedir después de cada borrado y los índices se
  // corren, así que un índice guardado terminaría apuntando a otro presupuesto.
  _sel: new Set(),

  async cargar() {
    this.lista = await DB.listarPresupuestos();
    // Sobreviven solo los que todavía existen: si dos personas borran a la vez,
    // la selección no puede quedar apuntando a algo que ya no está.
    const vivos = new Set(this.lista.map(p => p.token));
    this._sel = new Set([...this._sel].filter(t => vivos.has(t)));
    this.renderLista();
    this.renderBarra();
  },

  esVencido(p) { return !!(p.vence_en && new Date(p.vence_en) < new Date()); },

  // ── Selección múltiple ──
  toggleSel(token, marcado) {
    if (marcado) this._sel.add(token); else this._sel.delete(token);
    this.pintarFila(token);
    this.renderBarra();
  },

  // Solo se repinta la fila que cambió, no la lista entera: volver a dibujar
  // todo con cada clic hace saltar el scroll justo cuando se está marcando de
  // a varios, que es exactamente lo que esta pantalla vino a facilitar.
  pintarFila(token) {
    const el = document.getElementById(`pres-card-${token}`);
    if (!el) return;
    el.style.boxShadow = this._sel.has(token) ? 'inset 0 0 0 1.5px var(--blue)' : '';
  },

  marcarTodos(marcado) {
    this._sel = marcado ? new Set(this.lista.map(p => p.token)) : new Set();
    this.renderLista();
    this.renderBarra();
  },

  marcarVencidos() {
    const vencidos = this.lista.filter(p => this.esVencido(p)).map(p => p.token);
    if (!vencidos.length) { toast('No hay presupuestos vencidos.'); return; }
    this._sel = new Set(vencidos);
    this.renderLista();
    this.renderBarra();
    toast(`${vencidos.length} vencido${vencidos.length > 1 ? 's' : ''} marcado${vencidos.length > 1 ? 's' : ''}.`);
  },

  renderBarra() {
    const cont = document.getElementById('pres-barra');
    if (!cont) return;
    const n = this._sel.size;
    const hayVencidos = this.lista.some(p => this.esVencido(p));

    if (!n) {
      // Sin nada marcado la barra no ocupa lugar, salvo el atajo de vencidos,
      // que es el motivo real por el que uno entra a limpiar esta pantalla.
      cont.innerHTML = this.lista.length && hayVencidos
        ? `<div style="margin-bottom:10px">
             <button class="btn btn-sm" onclick="Presupuestos.marcarVencidos()">
               <i class="ti ti-clock-x"></i> Marcar los vencidos
             </button>
           </div>`
        : '';
      return;
    }

    cont.innerHTML = `
      <div style="position:sticky;top:0;z-index:5;background:var(--blue-light);border-radius:10px;
                  padding:10px 12px;margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <strong style="font-size:13px;color:var(--blue)">${n} seleccionado${n > 1 ? 's' : ''}</strong>
        <div style="flex:1"></div>
        ${hayVencidos ? `<button class="btn btn-sm" onclick="Presupuestos.marcarVencidos()">Solo los vencidos</button>` : ''}
        <button class="btn btn-sm" onclick="Presupuestos.marcarTodos(true)">Marcar todos (${this.lista.length})</button>
        <button class="btn btn-sm" onclick="Presupuestos.marcarTodos(false)">Quitar selección</button>
        <button class="btn btn-sm btn-red" onclick="Presupuestos.eliminarSeleccionados()">
          <i class="ti ti-trash"></i> Eliminar ${n}
        </button>
      </div>`;
  },

  async eliminarSeleccionados() {
    const tokens = [...this._sel];
    if (!tokens.length) return;
    if (!confirm(`Se eliminan ${tokens.length} presupuesto${tokens.length > 1 ? 's' : ''}. Los links dejan de funcionar. ¿Seguro?`)) return;

    const { error, borrados } = await DB.eliminarPresupuestos(tokens);
    if (error) { toast('No se pudieron eliminar: ' + (error.message || '')); console.error(error); return; }

    this._sel = new Set();
    await this.cargar();
    toast(`${borrados} presupuesto${borrados === 1 ? '' : 's'} eliminado${borrados === 1 ? '' : 's'}.`);
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
      const saldo = Math.max(0, (Number(prod.precio_usd) || 0)
        - (ti ? Number(ti.valor_usd) || 0 : 0)
        - (Number(ti?.efectivo?.monto_usd) || 0));
      const vencido = this.esVencido(p);
      const marcado = this._sel.has(p.token);
      return `<div class="card" id="pres-card-${p.token}" style="margin-bottom:10px;display:flex;align-items:center;gap:14px;flex-wrap:wrap${marcado ? ';box-shadow:inset 0 0 0 1.5px var(--blue)' : ''}">
        <label style="display:flex;align-items:center;cursor:pointer;padding:2px" title="Seleccionar">
          <input type="checkbox" ${marcado ? 'checked' : ''}
                 onchange="Presupuestos.toggleSel('${p.token}',this.checked)"
                 style="width:17px;height:17px;cursor:pointer;accent-color:var(--blue)">
        </label>
        <div style="flex:1;min-width:200px">
          <div style="font-size:13px;font-weight:700">${State.esc(prod.nombre || 'Equipo')}${Number(prod.cantidad) > 1 ? ` <span class="badge b-blue">× ${Number(prod.cantidad)}</span>` : ''}</div>
          <div style="font-size:11.5px;color:var(--text-secondary);margin-top:2px">
            ${p.cliente ? State.esc(p.cliente) + ' · ' : ''}${ti && ti.modelo ? `canje ${(ti.equipos && ti.equipos.length > 1) ? `${ti.equipos.length} equipos` : State.esc(ti.modelo)} U$D ${ti.valor_usd} · ` : ''}${ti?.efectivo ? `${State.esc(ti.efectivo.concepto)} U$D ${ti.efectivo.monto_usd} · ` : ''}saldo <strong>U$D ${saldo}</strong>
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
    // Ya no se corta si el stock está vacío: siempre queda la opción de cargar
    // el equipo a mano, que es justamente para lo que no está en stock.
    const disponibles = this.equiposDisponibles();

    this.draft = { productoId: disponibles[0]?.id || '__manual', cliente: '', diasValidez: 7,
                   ti: { activo: true, modelo: '', storage: '', color: '', estado: 'Excelente', bateria: '', valor: '' },
                   ef: { activo: false, monto: '', concepto: '' } };
    // Un solo equipo de entrada; se agregan más con el botón.
    this._canjes = [this._canjeVacio()];
    this.abrirModal(disponibles);
  },

  abrirModal(disponibles) {
    const d = this.draft;
    const ESTADOS = this.ESTADOS_CANJE;
    const MODELOS = this.modelosCanje();
    const inp = 'width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px';
    const lbl = 'font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px';

    const html = `
      <div style="margin-bottom:12px">
        <label style="${lbl}">Equipo que se lleva *</label>
        <div style="display:grid;grid-template-columns:1fr 96px;gap:10px;align-items:end">
          <select id="pr-producto" style="${inp}" onchange="Presupuestos.cambioProducto()">
            ${disponibles.map(p => `<option value="${p.id}">${State.esc(p.etiqueta)} — U$D ${p.usd}${p.unidades > 1 ? ` (${p.unidades} u.)` : ''}</option>`).join('')}
            <option value="__manual"${disponibles.length ? '' : ' selected'}>Otro equipo — lo cargo a mano</option>
          </select>
          <div>
            <label style="${lbl}">Cantidad</label>
            <input id="pr-cant" type="number" min="1" max="99" step="1" value="1"
                   style="${inp};text-align:center;font-weight:700" oninput="Presupuestos.recalcular()">
          </div>
        </div>
        <!-- Para presupuestar algo que todavía no entró al stock: un equipo
             que se va a encargar, o uno que se está por recibir. -->
        <div id="pr-manual" style="display:${disponibles.length ? 'none' : 'grid'};grid-template-columns:2fr 1fr;gap:10px;margin-top:8px">
          <input id="pr-manual-nombre" placeholder="ej: iPhone 16 Pro Max 256GB Titanio Negro" style="${inp}">
          <input id="pr-manual-precio" type="number" min="0" placeholder="Precio U$D" style="${inp}" oninput="Presupuestos.recalcular()">
        </div>
      </div>
      <div style="margin-bottom:12px">
        <label style="${lbl}">Servicio incluido</label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;margin-bottom:6px">
          ${this.SERVICIOS.map((sv, i) => `
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
              <input type="checkbox" class="pr-serv" value="${State.esc(sv)}" id="pr-serv-${i}"> ${State.esc(sv)}
            </label>`).join('')}
        </div>
        <input id="pr-serv-otro" placeholder="Otro trabajo hecho (opcional)" style="${inp}">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div><label style="${lbl}">Cliente</label><input id="pr-cliente" placeholder="ej: Facundo" style="${inp}"></div>
        <div><label style="${lbl}">Validez (días)</label><input id="pr-dias" type="number" min="1" value="7" style="${inp}"></div>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:12px;margin-bottom:10px">
        <label style="display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;cursor:pointer">
          <input type="checkbox" id="pr-ti-on" checked onchange="Presupuestos.toggleTI(this.checked)"> Entrega uno o más equipos en parte de pago
        </label>
      </div>
      <div id="pr-ti-wrap"></div>

      <div style="border-top:1px solid var(--border);padding-top:12px;margin-bottom:10px">
        <label style="display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;cursor:pointer">
          <input type="checkbox" id="pr-ef-on" onchange="Presupuestos.toggleEf(this.checked)"> Entrega dinero a cuenta
        </label>
      </div>
      <div id="pr-ef-wrap" style="display:none">
        <div style="display:grid;grid-template-columns:1fr 1.4fr;gap:10px;margin-bottom:12px">
          <div><label style="${lbl}">Monto (U$D) *</label>
            <input id="pr-ef-monto" type="number" min="0" placeholder="300" style="${inp};font-size:15px;font-weight:700" oninput="Presupuestos.recalcular()">
          </div>
          <div><label style="${lbl}">Concepto</label>
            <select id="pr-ef-concepto" style="${inp}">
              ${this.CONCEPTOS_EFECTIVO.map(c => `<option>${State.esc(c)}</option>`).join('')}
            </select>
          </div>
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
    setTimeout(() => { this._pintarCanjes(); this.recalcular(); }, 30);
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

  // Al elegir el modelo, Capacidad y Color se rearman con lo que ese modelo
  // realmente tuvo. "Otro modelo…" abre el campo libre y vuelve a las listas
  // generales, para no perder la posibilidad de tomar un equipo viejo o Android.
  // Puede entregar más de un equipo. Los bloques se dibujan desde
  // this._canjes, que es la fuente de verdad: antes de agregar o quitar uno se
  // leen los campos a memoria, así lo ya escrito no se pierde al redibujar.
  _canjeVacio() {
    return { modelo: '', modeloOtro: '', storage: '', color: '', estado: 'Excelente', bateria: '', valor: '' };
  },

  // Vuelca a memoria lo que hay escrito en pantalla. Se llama SIEMPRE antes de
  // redibujar: sin esto, agregar un segundo equipo borraría lo cargado en el
  // primero.
  _leerCanjes() {
    this._canjes = (this._canjes || []).map((c, i) => ({
      modelo:     document.getElementById(`pr-ti-modelo-${i}`)?.value ?? c.modelo,
      modeloOtro: document.getElementById(`pr-ti-modelo-otro-${i}`)?.value ?? c.modeloOtro,
      storage:    document.getElementById(`pr-ti-storage-${i}`)?.value ?? c.storage,
      color:      document.getElementById(`pr-ti-color-${i}`)?.value ?? c.color,
      estado:     document.getElementById(`pr-ti-estado-${i}`)?.value ?? c.estado,
      bateria:    document.getElementById(`pr-ti-bat-${i}`)?.value ?? c.bateria,
      valor:      document.getElementById(`pr-ti-valor-${i}`)?.value ?? c.valor,
    }));
    return this._canjes;
  },

  _pintarCanjes() {
    const w = document.getElementById('pr-ti-wrap');
    if (!w) return;
    const inp = 'width:100%;font-size:12px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:8px';
    const lbl = 'font-size:11px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:4px';
    const MODELOS = this.modelosCanje();
    const lista = this._canjes && this._canjes.length ? this._canjes : (this._canjes = [this._canjeVacio()]);
    const varios = lista.length > 1;

    w.innerHTML = lista.map((c, i) => `
      <div style="${varios ? 'border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:10px' : ''}">
        ${varios ? `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <strong style="font-size:11.5px;color:var(--text-secondary)">Equipo ${i + 1}</strong>
          <button class="btn btn-sm" style="color:var(--red)" onclick="Presupuestos.quitarCanje(${i})">Quitar</button>
        </div>` : ''}
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;margin-bottom:10px">
          <div><label style="${lbl}">Modelo que entrega *</label>
            <select id="pr-ti-modelo-${i}" style="${inp}" onchange="Presupuestos.cambioModeloTI(${i})">
              <option value="">Elegí el modelo…</option>
              ${MODELOS.map(m => `<option${m === c.modelo ? ' selected' : ''}>${State.esc(m)}</option>`).join('')}
              <option value="__otro"${c.modelo === '__otro' ? ' selected' : ''}>Otro modelo…</option>
            </select>
            <input id="pr-ti-modelo-otro-${i}" placeholder="ej: Samsung S23 / iPhone 12"
                   value="${State.esc(c.modeloOtro || '')}"
                   style="${inp};display:${c.modelo === '__otro' ? 'block' : 'none'};margin-top:6px">
          </div>
          <div><label style="${lbl}">Capacidad</label>
            <select id="pr-ti-storage-${i}" style="${inp}"></select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px">
          <div><label style="${lbl}">Color</label><select id="pr-ti-color-${i}" style="${inp}"></select></div>
          <div><label style="${lbl}">Estado</label>
            <select id="pr-ti-estado-${i}" style="${inp}">
              ${this.ESTADOS_CANJE.map(e => `<option${e === (c.estado || 'Excelente') ? ' selected' : ''}>${e}</option>`).join('')}
            </select>
          </div>
          <div><label style="${lbl}">Batería %</label>
            <input id="pr-ti-bat-${i}" type="number" min="0" max="100" placeholder="91"
                   value="${State.esc(c.bateria || '')}" style="${inp}"></div>
        </div>
        <div style="margin-bottom:${varios ? '2px' : '12px'}">
          <label style="${lbl}">Cotización que le das (U$D) *</label>
          <input id="pr-ti-valor-${i}" type="number" min="0" placeholder="550" value="${State.esc(c.valor || '')}"
                 style="${inp};font-size:15px;font-weight:700" oninput="Presupuestos.recalcular()">
        </div>
      </div>`).join('') + `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <button class="btn btn-sm" onclick="Presupuestos.agregarCanje()"><i class="ti ti-plus"></i> Agregar otro equipo</button>
        ${varios ? `<span style="font-size:11.5px;color:var(--text-secondary)">Total del canje: <strong>U$D ${this._canjesValidos().reduce((a, c) => a + c.valor_usd, 0)}</strong></span>` : ''}
      </div>`;

    // Capacidad y color dependen del modelo, así que se llenan después de
    // existir el <select>.
    lista.forEach((_, i) => this.cambioModeloTI(i, { silencioso: true }));
  },

  agregarCanje() {
    this._leerCanjes();
    this._canjes.push(this._canjeVacio());
    this._pintarCanjes();
    this.recalcular();
  },

  quitarCanje(i) {
    this._leerCanjes();
    this._canjes.splice(i, 1);
    if (!this._canjes.length) this._canjes = [this._canjeVacio()];
    this._pintarCanjes();
    this.recalcular();
  },

  // Los equipos con modelo y cotización cargados. Un bloque a medio llenar no
  // cuenta: es el que todavía se está escribiendo.
  _canjesValidos() {
    return this._leerCanjes().map(c => {
      const modelo = (c.modelo === '__otro' ? (c.modeloOtro || '') : (c.modelo || '')).trim();
      const valor = parseFloat(c.valor) || 0;
      if (!modelo || !(valor > 0)) return null;
      return {
        modelo, storage: c.storage || '', color: c.color || '',
        estado: c.estado || '', bateria_pct: parseInt(c.bateria) || null,
        valor_usd: valor,
      };
    }).filter(Boolean);
  },

  // Capacidad y color se recargan con las que ese modelo REALMENTE tuvo.
  // "Otro modelo…" abre el campo libre y vuelve a las listas generales, para no
  // perder la posibilidad de tomar un equipo viejo o Android.
  cambioModeloTI(i = 0, { silencioso = false } = {}) {
    const selM = document.getElementById(`pr-ti-modelo-${i}`);
    if (!selM) return;
    const otro = selM.value === '__otro';
    const libre = document.getElementById(`pr-ti-modelo-otro-${i}`);
    if (libre) libre.style.display = otro ? 'block' : 'none';

    const guardado = (this._canjes || [])[i] || {};
    const specs = this.specsCanje(otro ? '' : selM.value);
    const llenar = (id, vals, previo) => {
      const el = document.getElementById(id);
      if (!el) return;
      const antes = el.value || previo || '';
      el.innerHTML = `<option value=""></option>` + vals.map(v => `<option>${State.esc(v)}</option>`).join('');
      // Si el color/capacidad que ya estaba también existe en el modelo nuevo
      // se respeta; si ese modelo no lo tuvo, queda vacío y hay que elegir.
      if (antes && vals.some(v => v === antes)) el.value = antes;
    };
    llenar(`pr-ti-storage-${i}`, specs.s || [], guardado.storage);
    llenar(`pr-ti-color-${i}`, specs.c || [], guardado.color);
    if (!silencioso) this.recalcular();
  },

  toggleTI(on) {
    const w = document.getElementById('pr-ti-wrap');
    if (w) w.style.display = on ? 'block' : 'none';
    this.recalcular();
  },

  toggleEf(on) {
    const w = document.getElementById('pr-ef-wrap');
    if (w) w.style.display = on ? 'block' : 'none';
    this.recalcular();
  },

  // Lo que el cliente pone en plata. Los dos caminos son independientes: puede
  // entregar solo el equipo, solo plata, o las dos cosas.
  _efectivo() {
    if (!document.getElementById('pr-ef-on')?.checked) return null;
    const monto = parseFloat(document.getElementById('pr-ef-monto')?.value) || 0;
    if (!(monto > 0)) return null;
    return { monto_usd: monto, concepto: document.getElementById('pr-ef-concepto')?.value || 'Efectivo' };
  },

  _serviciosElegidos() {
    const marcados = [...document.querySelectorAll('.pr-serv:checked')].map(c => c.value);
    const otro = document.getElementById('pr-serv-otro')?.value.trim();
    if (otro) marcados.push(otro);
    return marcados;
  },

  // Cuántas unidades del mismo equipo. Se acota entre 1 y 99: el campo es un
  // <input number>, así que en el celular se puede escribir cualquier cosa.
  _cantidad() {
    const n = parseInt(document.getElementById('pr-cant')?.value, 10);
    return Math.min(99, Math.max(1, Number.isFinite(n) ? n : 1));
  },

  ESTADOS_CANJE: ['Nuevo / Sellado', 'Excelente', 'Muy bueno', 'Bueno', 'Con detalles'],

  cambioProducto() {
    const manual = document.getElementById('pr-producto')?.value === '__manual';
    const w = document.getElementById('pr-manual');
    if (w) w.style.display = manual ? 'grid' : 'none';
    if (manual) document.getElementById('pr-manual-nombre')?.focus();
    this.recalcular();
  },

  // Devuelve el equipo elegido del stock, o uno armado con lo que se escribió
  // a mano. En los dos casos tiene la misma forma, así que el resto del
  // presupuesto no necesita saber de dónde salió.
  _productoElegido() {
    const id = document.getElementById('pr-producto')?.value;
    if (id === '__manual') {
      const nombre = document.getElementById('pr-manual-nombre')?.value.trim() || '';
      const usd = parseFloat(document.getElementById('pr-manual-precio')?.value) || 0;
      if (!nombre || !(usd > 0)) return null;
      // `cotiz: 1` hace que `precioARS / cotiz` dé el precio en dólares tal
      // cual se escribió, sin inventar una conversión.
      return { id: null, nombre, cat: 'iphone', estadoProducto: '',
               modelo: '', storage: '', color: '', precioARS: usd, cotiz: 1, _manual: true };
    }
    return (State.stock || []).find(p => String(p.id) === String(id));
  },

  recalcular() {
    const box = document.getElementById('pr-preview');
    if (!box) return;
    const p = this._productoElegido();
    if (!p) { box.textContent = '—'; return; }
    const unit = Math.round(p.precioARS / p.cotiz);
    const cant = this._cantidad();
    const precio = unit * cant;
    const conTI = document.getElementById('pr-ti-on')?.checked;
    const canjes = conTI ? this._canjesValidos() : [];
    const valorTI = canjes.reduce((a, c) => a + c.valor_usd, 0);
    const ef = this._efectivo();
    const saldo = Math.max(0, precio - valorTI - (ef?.monto_usd || 0));
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between"><span>Equipo${cant > 1 ? ` × ${cant}` : ''}</span><strong>U$D ${precio}</strong></div>
      ${cant > 1 ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:-2px">U$D ${unit} cada uno</div>` : ''}
      ${canjes.map(c => `<div style="display:flex;justify-content:space-between;color:var(--green)"><span>Canje · ${State.esc(c.modelo)}</span><strong>− U$D ${c.valor_usd}</strong></div>`).join('')}
      ${conTI && !canjes.length ? `<div style="display:flex;justify-content:space-between;color:var(--text-secondary)"><span>Canje</span><span>falta cargarlo</span></div>` : ''}
      ${ef ? `<div style="display:flex;justify-content:space-between;color:var(--green)"><span>${State.esc(ef.concepto)}</span><strong>− U$D ${ef.monto_usd}</strong></div>` : ''}
      <div style="display:flex;justify-content:space-between;border-top:1px solid var(--border);margin-top:6px;padding-top:6px;font-size:14px">
        <strong>Saldo a abonar</strong><strong>U$D ${saldo}</strong></div>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:4px">≈ ${State.fmtARS(saldo * State.refBlue)} al blue de hoy ($${State.refBlue.toLocaleString('es-AR')})</div>`;
  },

  async guardar() {
    const p = this._productoElegido();
    if (!p) {
      const manual = document.getElementById('pr-producto')?.value === '__manual';
      toast(manual ? 'Cargá el nombre del equipo y su precio en dólares.' : 'Elegí el equipo.');
      return;
    }
    const conTI = document.getElementById('pr-ti-on')?.checked;
    const canjes = conTI ? this._canjesValidos() : [];
    if (conTI && !canjes.length) { toast('Cargá el modelo que entrega y su cotización.'); return; }
    if (conTI && canjes.length !== (this._canjes || []).length) {
      // Un bloque a medio llenar es casi siempre un olvido, no una decisión.
      if (!confirm('Hay un equipo de canje sin modelo o sin cotización. Se va a ignorar. ¿Seguir?')) return;
    }
    const valorTotalTI = canjes.reduce((a, c) => a + c.valor_usd, 0);

    const efec = this._efectivo();
    // El monto se pide solo si la casilla está tildada: tildarla y dejarla
    // vacía es un olvido, no "sin efectivo".
    if (document.getElementById('pr-ef-on')?.checked && !efec) {
      toast('Cargá cuánto dinero entrega, o destildá la opción.'); return;
    }

    const cant = this._cantidad();
    // Se puede presupuestar más de lo que hay —un pedido se encarga— pero
    // conviene que sea una decisión y no un cero de más en el teclado.
    const idSel = document.getElementById('pr-producto')?.value;
    const disp = this.equiposDisponibles().find(d => String(d.id) === String(idSel));
    if (disp && cant > disp.unidades) {
      if (!confirm(`Estás presupuestando ${cant} unidades y hay ${disp.unidades} en stock. ¿Seguir igual?`)) return;
    }

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
        // `precio_usd` es SIEMPRE el total de la operación, no el unitario.
        // Todo lo que lee el presupuesto después —la página pública, la vista
        // previa de WhatsApp— resta el canje contra este número, así que si
        // acá fuera el precio de uno solo, un presupuesto por dos equipos
        // mostraría la mitad del saldo. El unitario va aparte, para mostrarlo.
        cantidad: cant,
        precio_unitario_usd: Math.round(p.precioARS / p.cotiz),
        precio_usd: Math.round(p.precioARS / p.cotiz) * cant,
        // Va dentro de `producto` y no en una columna nueva porque es una
        // característica del equipo cotizado, y queda congelado con el resto.
        servicios: this._serviciosElegidos(),
      },
      // `trade_in` es TODO lo que el cliente entrega en parte de pago: el equipo
      // usado, plata, o las dos cosas. El efectivo va acá adentro y no en una
      // columna nueva a propósito: una columna obligaría a correr un SQL antes
      // de publicar, y si ese paso se saltea, guardar un presupuesto falla del
      // todo. Así la función anda apenas se deploya.
      trade_in: (canjes.length || efec) ? {
        // `equipos` es la lista completa. Los campos sueltos de afuera son el
        // PRIMER equipo y el TOTAL, y quedan a propósito: todo lo que ya lee
        // presupuestos —la página pública, la vista previa de WhatsApp— resta
        // `valor_usd` contra el precio. Si acá no estuviera la suma, un canje
        // de dos equipos descontaría solo uno.
        ...(canjes.length ? {
          equipos: canjes,
          modelo: canjes[0].modelo,
          storage: canjes[0].storage,
          color: canjes[0].color,
          estado: canjes[0].estado,
          bateria_pct: canjes[0].bateria_pct,
          valor_usd: valorTotalTI,
        } : { valor_usd: 0 }),
        ...(efec ? { efectivo: efec } : {}),
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
