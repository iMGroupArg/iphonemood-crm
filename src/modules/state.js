// ============================================================
// ESTADO CENTRAL — fuente única de verdad para toda la maqueta
// En la versión real esto vive en la base de datos + Sheets.
// ============================================================

const State = {
  refBlue: 1075,
  refBlueCompra: 1075,
  refUsdt: 1061,
  _refUsdtCustomizado: false, // true cuando el usuario lo guardó en Panel

  personas: [], // se carga desde Supabase al iniciar

  // CAJAS: cada persona tiene varios "bolsillos" de saldo — se carga desde Supabase
  cajas: {},

  // STOCK — se carga desde Supabase
  stock: [],

  // VENTAS — se carga desde Supabase
  ventas: [],
  nextVentaId: 1,

  // REPARACIONES — se carga desde Supabase
  reparaciones: [],

  // GASTOS — se carga desde Supabase
  categoriasGasto: [],
  gastos: [],
  gastosFijosPlantilla: [],
  cierresMensuales: [],
  formasPago: ['Efectivo', 'Transferencia', 'Tarjeta de crédito', 'Tarjeta de débito', 'USDT'],

  // CUEVA — operaciones de cambio — se carga desde Supabase
  cambios: [],

  // GARANTÍAS configurables — se carga desde Supabase
  garantias: [],
  condicionesGarantia: localStorage.getItem('im_condiciones_garantia') || 'La garantía cubre defectos de fabricación y fallas de funcionamiento. No cubre daños por caídas, humedad, golpes, uso indebido o intervención de terceros no autorizados. Para hacer efectiva la garantía, presentar este recibo en el local.',

  // PROVEEDORES — se carga desde Supabase
  proveedores: [],
  lotesCompra: [],
  loteItems: [],
  lotePagos: [],
  // Cuenta corriente CON el proveedor: plata que nos debe (sobrepago en un
  // lote, o un anticipo), no plata que le debemos. Evita usar una "persona"
  // con caja como sustituto — eso mezclaría el crédito de un proveedor con
  // el efectivo real del negocio en el Dashboard y en selectores donde un
  // proveedor no pinta (vendedor, custodio de trade-in, etc).
  proveedorCreditos: [],

  // TURNOS — se carga desde Supabase
  turnosSlots: [],
  turnosReservas: [],

  // CUENTA CORRIENTE — se carga desde Supabase
  deudas: [],
  adelantos: [],
  deudaPagos: [],

  // CASH FLOW — log de movimientos para el módulo de cash flow
  movimientos: [],

  // ===== HELPERS =====
  // Convierte a Date respetando el día tal como se cargó.
  // Una fecha sola ("2026-07-30") la interpreta el navegador como medianoche
  // UTC; al leerla en hora argentina (UTC-3) caía en el día anterior y todo
  // aparecía corrido un día. Cuando no viene la hora, la armamos como local.
  parseFecha(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [a, m, d] = s.split('-').map(Number);
      return new Date(a, m - 1, d);
    }
    const d = new Date(s);
    return isNaN(d) ? null : d;
  },

  fmtARS(n) { return '$' + Math.round(n).toLocaleString('es-AR'); },
  fmtUSD(n) { return 'USD ' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 }); },

  // Escapa texto cargado por el usuario antes de meterlo en HTML. Sin esto, un
  // nombre o una nota con comillas o < rompe la fila de la tabla (y el nombre
  // del cliente viaja dentro de las notas de los trade-in).
  esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => (
      { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
    ));
  },

  // El stock real es el MÁXIMO entre la cantidad declarada y la cantidad de IMEIs
  // cargados (para productos que usan IMEI) — así nunca subestima lo que hay
  // físicamente aunque todavía no se hayan identificado todos los IMEIs uno por uno.
  getStock(p) {
    if (p.imeis) {
      const porIMEI = p.imeis.length;
      const declarada = p.cantidadDeclarada ?? p.cantidad ?? 0;
      return Math.max(porIMEI, declarada);
    }
    return p.cantidad || 0;
  },
  getStockStatus(p) {
    const s = this.getStock(p);
    if (s === 0) return 'out';
    if (s <= 1) return 'low';
    return 'ok';
  },

  // Modelos a los que les queda la última unidad.
  //
  // Antes se contaba producto por producto con getStockStatus() <= 1, pero como
  // acá una fila ES un equipo, prácticamente todo el inventario daba "crítico"
  // (más todos los vendidos, que tienen 0). Lo útil es agrupar por nombre y
  // avisar de los modelos que se están por agotar.
  modelosConUltimaUnidad() {
    const porNombre = {};
    this.stock.forEach(p => {
      if ((p.estadoInventario || 'disponible') === 'vendido') return;
      const unidades = this.getStock(p);
      if (unidades <= 0) return;
      porNombre[p.nombre] = (porNombre[p.nombre] || 0) + unidades;
    });
    return Object.entries(porNombre).filter(([, u]) => u <= 1).map(([nombre]) => nombre);
  },

  // Motor único de movimientos de caja. Todo lo que entra o sale pasa por acá,
  // así queda registrado en el libro mayor sin depender de que cada pantalla
  // se acuerde de anotarlo.
  //   ref = { tipo, referencia, descripcion }  (opcional)
  _colaCaja: {},   // una fila de espera por caja, para no pisar escrituras

  async _moverSaldo(persona, bolsillo, delta, ref) {
    if (!persona || !bolsillo || !delta) return;
    // Los movimientos de una misma caja se guardan DE A UNO. Sin esto, dos
    // pagos de la misma venta a la misma caja se disparaban en paralelo y la
    // base podía quedarse con el saldo del que terminara último, perdiendo el
    // otro. En pantalla se veía bien, y el descuadre aparecía al recargar.
    const clave = `${persona}||${bolsillo}`;
    const anterior = this._colaCaja[clave] || Promise.resolve();
    const turno = anterior
      .catch(() => {})
      .then(() => this._aplicarSaldo(persona, bolsillo, delta, ref));
    this._colaCaja[clave] = turno;
    return turno;
  },

  async _aplicarSaldo(persona, bolsillo, delta, ref) {
    if (!this.cajas[persona]) this.cajas[persona] = {};
    // Redondear a centavos: los saldos venían con toda la precisión del
    // cálculo (ej. 146534.43770491815) mientras el libro guarda 2 decimales.
    // Esa diferencia de milésimas se acumulaba movimiento a movimiento hasta
    // dar una alarma de descuadre falsa.
    const cent = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    delta = cent(delta);
    if (!delta) return;
    const previo = this.cajas[persona][bolsillo] || 0;
    const saldoPost = cent(previo + delta);
    this.cajas[persona][bolsillo] = saldoPost;

    // Si la base no confirma el guardado, volvemos atrás en pantalla y avisamos.
    // Antes se disparaba sin esperar respuesta: ante un fallo, la pantalla
    // mostraba un saldo y la base tenía otro, sin que nadie se enterara.
    const guardado = await DB.actualizarSaldoCaja(persona, bolsillo, saldoPost);
    if (!guardado) {
      this.cajas[persona][bolsillo] = previo;
      if (typeof toast === 'function') {
        toast(`⚠️ No se pudo guardar el saldo de ${persona} · ${bolsillo}. El movimiento NO se aplicó.`);
      }
      return;
    }

    // Se espera la escritura del libro: antes salía sin await y el error se
    // tragaba en silencio, así que un fallo dejaba el saldo movido y el libro
    // sin la fila — justo el descuadre que el libro existe para detectar.
    const anotado = await DB.registrarMovimientoCaja({
      persona, bolsillo, delta, saldoPost,
      tipo: ref?.tipo || 'otro',
      referencia: ref?.referencia,
      descripcion: ref?.descripcion,
    });
    if (!anotado && typeof toast === 'function') {
      toast(`⚠️ El saldo de ${persona} · ${bolsillo} se guardó, pero no quedó anotado en el libro. Revisá el control de cuadre.`);
    }
  },

  // Mueve saldo entre bolsillos (misma o distinta persona)
  async moverCaja(personaOrigen, bolsilloOrigen, montoOrigen, personaDestino, bolsilloDestino, montoDestino, ref) {
    const r = { tipo: 'movimiento', ...(ref || {}) };
    await this._moverSaldo(personaOrigen, bolsilloOrigen, -montoOrigen,
      { ...r, descripcion: r.descripcion || `Pasa a ${personaDestino} · ${bolsilloDestino}` });
    await this._moverSaldo(personaDestino, bolsilloDestino, +montoDestino,
      { ...r, descripcion: r.descripcion || `Viene de ${personaOrigen} · ${bolsilloOrigen}` });
  },

  acreditarCaja(persona, bolsillo, monto, ref) {
    return this._moverSaldo(persona, bolsillo, +monto, ref);
  },
  debitarCaja(persona, bolsillo, monto, ref) {
    return this._moverSaldo(persona, bolsillo, -monto, ref);
  },

  registrarMovimiento(tipo, descripcion, montoARS, signo) {
    this.movimientos.unshift({
      fecha: 'Hoy', tipo, descripcion, montoARS, signo, id: Date.now() + Math.random()
    });
  },

  // Descuenta del stock cuando se confirma una venta. Devuelve lo removido (para poder revertir si se anula).
  // Si el producto llega a 0 unidades, se marca automáticamente como 'vendido'.
  descontarStock(stockId, imei) {
    const item = this.stock.find(s => s.id === stockId || s.id == stockId);
    if (!item) return null;
    let removed = null;
    if (item.imeis && imei) {
      const idx = item.imeis.indexOf(imei);
      if (idx >= 0) {
        item.imeis.splice(idx, 1);
        // Antes solo se sacaba el IMEI y la cantidad quedaba intacta. Como
        // getStock() toma el MAYOR entre IMEIs y cantidad, el equipo seguía
        // figurando disponible para siempre. Hay que bajar las dos cosas.
        if (item.cantidad !== undefined) item.cantidad = Math.max(0, item.cantidad - 1);
        if (item.cantidadDeclarada !== undefined) item.cantidadDeclarada = Math.max(0, item.cantidadDeclarada - 1);
        removed = { stockId, imei };
      }
    } else if (item.cantidad !== undefined && item.cantidad > 0) {
      item.cantidad -= 1;
      if (item.cantidadDeclarada !== undefined) item.cantidadDeclarada = Math.max(0, item.cantidadDeclarada - 1);
      removed = { stockId, imei: null };
    }
    if (removed && this.getStock(item) === 0 && item.estadoInventario !== 'vendido') {
      item.estadoInventario = 'vendido';
      DB.actualizarEstadoInventario(stockId, 'vendido');
    }
    return removed;
  },
  restaurarStock(stockId, imei) {
    const item = this.stock.find(s => s.id === stockId || s.id == stockId);
    if (!item) return;
    if (item.imeis && imei) {
      item.imeis.push(imei);
      // Simétrico a descontarStock: al reponer un equipo con IMEI también
      // hay que devolver la unidad al contador.
      if (item.cantidad !== undefined) item.cantidad += 1;
      if (item.cantidadDeclarada !== undefined) item.cantidadDeclarada += 1;
    } else if (item.cantidad !== undefined) {
      item.cantidad += 1;
      if (item.cantidadDeclarada !== undefined) item.cantidadDeclarada += 1;
    }
    // Si vuelve a tener stock y estaba marcado como vendido, lo regresamos a disponible
    if (this.getStock(item) > 0 && item.estadoInventario === 'vendido') {
      item.estadoInventario = 'disponible';
      DB.actualizarEstadoInventario(stockId, 'disponible');
    }
  },

  // Convierte un gasto a USD usando la cotización que tenía vigente al momento de pagarlo
  // (guardada en cotizacionUsada). Si no la tiene (gastos viejos o ya en USD), usa la cotización actual.
  gastoEnUSD(g) {
    if (g.moneda === 'USD') return g.monto;
    const cotiz = g.cotizacionUsada || this.refBlue;
    return g.monto / cotiz;
  },

  // Contra qué cotización se mide una operación ARS→USD.
  //
  // Por defecto, el blue: es una operación de cueva común y la ganancia es
  // haber comprado los dólares por debajo del blue.
  //
  // Pero si la plata VIENE DE UNA VENTA ya cargada, esa venta ya la valuó con
  // su propia cotización, y volver a medirla contra el blue inventa una
  // ganancia o una pérdida sobre plata que ya estaba contada. En ese caso la
  // vara es la cotización de la venta (cotizRef): si se cambia a esa misma
  // cotización, el spread da cero, que es lo correcto — no se ganó ni se
  // perdió nada al convertir, la ganancia ya la registró la venta.
  //
  // Hace falta la marca explícita vieneDeVenta: cotizRef se venía guardando
  // en TODAS las operaciones con el blue del momento, sin que el usuario lo
  // eligiera, así que mirarlo solo a él cambiaría números de meses pasados.
  _refARSUSD(op) {
    return (op.vieneDeVenta && op.cotizRef) ? op.cotizRef : this.refBlue;
  },

  // Spread de una operación de cambio, en ARS
  calcSpreadARS(op) {
    if (op.tipo === 'ars-usd') {
      const ref = this._refARSUSD(op);
      const refRecibe = op.entrega / ref;
      return (op.recibe - refRecibe) * ref;
    }
    if (op.tipo === 'usd-ars') {
      return op.recibe - (op.entrega * this.refBlue);
    }
    if (op.tipo === 'usdt-ars') {
      return op.recibe - (op.entrega * this.refUsdt);
    }
    if (op.tipo === 'usd-usdt') {
      const refRecibe = op.entrega * (this.refBlue / this.refUsdt);
      return (op.recibe - refRecibe) * this.refUsdt;
    }
    if (op.tipo === 'ars-usdt') {
      const ref = op.cotizRef || this.refBlue;
      const refRecibe = op.entrega / ref;
      return (op.recibe - refRecibe) * ref;
    }
    return 0;
  },

  // Filtro único de operaciones de cueva por período. Ventas y Dashboard
  // tenían cada uno su propia versión de este filtro y daban resultados
  // distintos para el mismo período elegido en las dos pantallas:
  //   - Ventas solo contaba operaciones tipo 'ars-usd', ignorando las otras
  //     cuatro (usd-ars, usdt-ars, usd-usdt, ars-usdt) que también dejan
  //     ganancia o pérdida y que calcSpreadARS ya sabe calcular.
  //   - Ante una operación sin fecha, Ventas la contaba SIEMPRE (en
  //     cualquier período que se mirara) y Dashboard la excluía salvo que
  //     se estuviera viendo "hoy".
  // periodo = { tipo: 'hoy'|'semana'|'mes'|'mes-especifico'|'libre'|'todo',
  //             mes: 'AAAA-MM', desde: 'AAAA-MM-DD', hasta: 'AAAA-MM-DD' }
  cambiosEnPeriodo(periodo) {
    const TIPOS = ['ars-usd', 'usd-ars', 'usdt-ars', 'usd-usdt', 'ars-usdt'];
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    return (this.cambios || []).filter(c => {
      if (!TIPOS.includes(c.tipo)) return false;
      if (!c.fechaISO) return periodo.tipo === 'todo';
      const f = this.parseFecha(c.fechaISO) || new Date(0); f.setHours(0, 0, 0, 0);
      if (periodo.tipo === 'hoy') return f.getTime() === hoy.getTime();
      if (periodo.tipo === 'semana') { const d = new Date(hoy); d.setDate(d.getDate() - 6); return f >= d; }
      if (periodo.tipo === 'mes') return f.getFullYear() === hoy.getFullYear() && f.getMonth() === hoy.getMonth();
      if (periodo.tipo === 'mes-especifico') return c.fechaISO.slice(0, 7) === periodo.mes;
      if (periodo.tipo === 'libre') {
        const desde = periodo.desde ? this.parseFecha(periodo.desde) : null;
        const hasta = periodo.hasta ? this.parseFecha(periodo.hasta) : null;
        if (desde && f < desde) return false;
        if (hasta && f > hasta) return false;
        return true;
      }
      return true; // 'todo'
    });
  },

  spreadCuevaDelPeriodo(periodo) {
    return this.cambiosEnPeriodo(periodo).reduce((s, c) => s + this.calcSpreadARS(c), 0);
  },

  resultadoFinancieroMes(mes) {
    const ops = mes ? this.cambios.filter(o => (o.fechaISO || '').slice(0, 7) === mes) : this.cambios;
    return ops.reduce((a, o) => a + this.calcSpreadARS(o), 0);
  },
  // Diferencial financiero: lo cobrado en pagos menos el precio de lista de los items.
  // Captura tanto el recargo tarjeta como la diferencia de tipo de cambio.
  resultadoDiferencialTarjetaMes(mes) {
    const ventas = mes ? this.ventas.filter(v => (v.fechaISO || '').slice(0, 7) === mes) : this.ventas;
    let totalUSD = 0;
    ventas.forEach(v => {
      const totalVenta = (v.items || []).reduce((s, i) => s + i.precio, 0);
      const totalPagado = (v.pagos || []).reduce((s, p) => s + p.monto, 0) + (v.tradeIn?.valor || 0);
      totalUSD += Math.max(0, totalPagado - totalVenta);
    });
    return totalUSD;
  },
  resultadoComercialMes() {
    return this.ventas.reduce((a, v) => {
      const totalVenta = v.items.reduce((s, i) => s + i.precio, 0);
      const totalCosto = v.items.reduce((s, i) => s + i.costo, 0);
      return a + (totalVenta - totalCosto) * this.refBlue;
    }, 0);
  },
};

function toast(msg) {
  const el = document.getElementById('toast');
  el.innerHTML = msg;
  el.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}


window.State = State;
window.toast = toast;
