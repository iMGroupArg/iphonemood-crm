// ============================================================
// ESTADO CENTRAL — fuente única de verdad para toda la maqueta
// En la versión real esto vive en la base de datos + Sheets.
// ============================================================

const State = {
  refBlue: 1075,
  refBlueCompra: 1075,
  refUsdt: 1061,

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

  // TURNOS — se carga desde Supabase
  turnosSlots: [],
  turnosReservas: [],

  // CUENTA CORRIENTE — se carga desde Supabase
  deudas: [],
  deudaPagos: [],

  // CASH FLOW — log de movimientos para el módulo de cash flow
  movimientos: [],

  // ===== HELPERS =====
  fmtARS(n) { return '$' + Math.round(n).toLocaleString('es-AR'); },
  fmtUSD(n) { return 'USD ' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 }); },

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

  // Mueve saldo entre bolsillos (misma o distinta persona)
  moverCaja(personaOrigen, bolsilloOrigen, montoOrigen, personaDestino, bolsilloDestino, montoDestino) {
    if (!this.cajas[personaOrigen]) this.cajas[personaOrigen] = {};
    if (!this.cajas[personaDestino]) this.cajas[personaDestino] = {};
    this.cajas[personaOrigen][bolsilloOrigen] = (this.cajas[personaOrigen][bolsilloOrigen] || 0) - montoOrigen;
    this.cajas[personaDestino][bolsilloDestino] = (this.cajas[personaDestino][bolsilloDestino] || 0) + montoDestino;
    DB.actualizarSaldoCaja(personaOrigen, bolsilloOrigen, this.cajas[personaOrigen][bolsilloOrigen]);
    DB.actualizarSaldoCaja(personaDestino, bolsilloDestino, this.cajas[personaDestino][bolsilloDestino]);
  },

  acreditarCaja(persona, bolsillo, monto) {
    if (!this.cajas[persona]) this.cajas[persona] = {};
    this.cajas[persona][bolsillo] = (this.cajas[persona][bolsillo] || 0) + monto;
    DB.actualizarSaldoCaja(persona, bolsillo, this.cajas[persona][bolsillo]);
  },
  debitarCaja(persona, bolsillo, monto) {
    if (!this.cajas[persona]) this.cajas[persona] = {};
    this.cajas[persona][bolsillo] = (this.cajas[persona][bolsillo] || 0) - monto;
    DB.actualizarSaldoCaja(persona, bolsillo, this.cajas[persona][bolsillo]);
  },

  registrarMovimiento(tipo, descripcion, montoARS, signo) {
    this.movimientos.unshift({
      fecha: 'Hoy', tipo, descripcion, montoARS, signo, id: Date.now() + Math.random()
    });
  },

  // Descuenta del stock cuando se confirma una venta. Devuelve lo removido (para poder revertir si se anula).
  // Si el producto llega a 0 unidades, se marca automáticamente como 'vendido'.
  descontarStock(stockId, imei) {
    const item = this.stock.find(s => s.id === stockId);
    if (!item) return null;
    let removed = null;
    if (item.imeis && imei) {
      const idx = item.imeis.indexOf(imei);
      if (idx >= 0) { item.imeis.splice(idx, 1); removed = { stockId, imei }; }
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
    const item = this.stock.find(s => s.id === stockId);
    if (!item) return;
    if (item.imeis && imei) item.imeis.push(imei);
    else if (item.cantidad !== undefined) {
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

  // Spread de una operación de cambio, en ARS
  calcSpreadARS(op) {
    if (op.tipo === 'ars-usd') {
      const refRecibe = op.entrega / this.refBlue;
      return (op.recibe - refRecibe) * this.refBlue;
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
    return 0;
  },

  resultadoFinancieroMes() {
    return this.cambios.reduce((a, o) => a + this.calcSpreadARS(o), 0);
  },
  // Suma de diferenciales de tarjeta cobrados, convertidos a USD con la cotización
  // que tenía cada pago al momento de cobrarse (igual criterio que los gastos en ARS).
  resultadoDiferencialTarjetaMes() {
    let totalUSD = 0;
    this.ventas.forEach(v => {
      (v.pagos || []).forEach(p => {
        if (p.esTarjeta && p.diferencialArs) {
          const cotiz = p.cotizacionDiferencial || this.refBlue;
          totalUSD += p.diferencialArs / cotiz;
        }
      });
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
