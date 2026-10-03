// Banco de pruebas del motor de cajas.
// Carga state.js de verdad, con la base y el toast simulados, y corre
// los flujos reales de cada pantalla contra él.

import fs from 'node:fs';
import vm from 'node:vm';

const SRC = '/Users/francovelas/crm-complete/iphonemood-crm/src/modules/state.js';
const MODULOS = '/Users/francovelas/crm-complete/iphonemood-crm/src/modules/';

const BOLSILLOS = ['ARS cash', 'ARS transferencia', 'USD cash', 'USD transferencia', 'USDT'];
const monedaDe = b => (b.startsWith('ARS') ? 'ARS' : b === 'USDT' ? 'USDT' : 'USD');

// ── Arnés ────────────────────────────────────────────────────────────────
const redondear = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// "La base": saldos + libro + claves de idempotencia. Dos pestañas pueden
// compartir UNA misma base, que es justo el caso que antes perdía plata.
function nuevoServidor() {
  return { base: {}, libro: [], claves: new Map(), llamadas: 0, stock: {}, stockLlamadas: [] };
}

// Réplica fiel de public.caja_aplicar_delta: suma el delta sobre el saldo REAL
// de la base (no sobre lo que cree la pantalla), anota el libro y es idempotente
// por clave. Todo o nada.
function aplicarEnServidor(srv, persona, bolsillo, delta, ref, clave) {
  srv.llamadas++;
  const k = `${persona}||${bolsillo}`;
  delta = redondear(delta);
  if (clave && srv.claves.has(clave)) {
    const prev = srv.claves.get(clave);
    // Una clave CANCELADA (marca de caja_resolver_clave) rechaza al pedido atrasado.
    if (prev.cancelada) return { ok: false, motivo: 'clave_cancelada' };
    if (prev.k !== k || prev.delta !== delta) return { ok: false, motivo: 'rechazada' };
    return { ok: true, saldoPost: prev.saldoPost };
  }
  if (!(k in srv.base)) return { ok: false, motivo: 'rechazada' };
  const saldoPost = redondear(srv.base[k] + delta);
  srv.base[k] = saldoPost;
  srv.libro.push({ persona, bolsillo, delta, saldoPost, tipo: ref?.tipo || 'otro',
                   referencia: ref?.referencia, descripcion: ref?.descripcion, clave });
  if (clave) srv.claves.set(clave, { k, delta, saldoPost });
  return { ok: true, saldoPost };
}

// Réplica de public.caja_resolver_clave: 'aplicada' si existe; si no, deja la marca
// 'cancelada' (y un pedido atrasado con esa clave será rechazado).
function resolverEnServidor(srv, clave) {
  if (srv.claves.has(clave)) {
    const prev = srv.claves.get(clave);
    return prev.cancelada ? { estado: 'cancelada' } : { estado: 'aplicada', saldoPost: prev.saldoPost };
  }
  srv.claves.set(clave, { cancelada: true });
  return { estado: 'cancelada' };
}

// Réplica de public.caja_mover_atomico: valida las DOS patas antes de tocar nada;
// idempotente por clave (clave:o / clave:d); todo o nada.
function moverEnServidor(srv, origen, destino, ref, clave) {
  srv.llamadas++;
  const ko = `${origen.persona}||${origen.bolsillo}`, kd = `${destino.persona}||${destino.bolsillo}`;
  const mo = redondear(origen.monto), md = redondear(destino.monto);
  if (!clave || ko === kd || !(mo > 0) || !(md > 0)) return { ok: false, motivo: 'rechazada' };
  if (srv.claves.get(clave + ':o')?.cancelada) return { ok: false, motivo: 'rechazada' };   // traspaso cancelado: entero
  if (srv.claves.has(clave + ':o')) {
    const a = srv.claves.get(clave + ':o'), b = srv.claves.get(clave + ':d');
    if (a.k !== ko || b.k !== kd || a.delta !== -mo || b.delta !== md) return { ok: false, motivo: 'rechazada' };
    return { ok: true, saldoOrigen: a.saldoPost, saldoDestino: b.saldoPost };
  }
  if (!(ko in srv.base) || !(kd in srv.base)) return { ok: false, motivo: 'rechazada' };   // nada se toca
  const a = aplicarEnServidor(srv, origen.persona, origen.bolsillo, -mo, { ...ref, descripcion: origen.descripcion }, clave + ':o');
  const b = aplicarEnServidor(srv, destino.persona, destino.bolsillo, +md, { ...ref, descripcion: destino.descripcion }, clave + ':d');
  return { ok: true, saldoOrigen: a.saldoPost, saldoDestino: b.saldoPost };
}

// opciones:
//   servidor       base compartida entre pestañas (por defecto, una propia)
//   legacy         la migración no está corrida: aplicarDeltaCaja → 'rpc_ausente'
//   fallaEscritura (persona, bolsillo) => true  la base rechaza ese movimiento
//   fallaLedger    (solo camino viejo) el libro falla pero el saldo se guarda
//   red            'perdida' = se aplica pero la respuesta no llega; 'caida' = no llega nada
//   sinLectura     no se puede leer el saldo real tras un fallo de red
function nuevoEntorno(opciones = {}) {
  const { servidor = nuevoServidor(), modulos = [], dom = {}, dbExtra = {} } = opciones;
  // `cfg` es mutable a propósito: un test puede "correr la migración" a mitad de camino.
  const cfg = { legacy: false, fallaEscritura: null, fallaLedger: false, red: null, sinLectura: false, ...opciones };
  const base = servidor.base;     // saldos "en la base"
  const libro = servidor.libro;   // filas de caja_ledger
  const toasts = [];
  const almacen = {};   // localStorage simulado
  const contadores = { viejo: 0, rpc: 0, rpcMover: 0 };

  const DB = {
    // Réplica de public.stock_ajustar: resta/suma sobre el valor REAL de la fila en
    // la "base" (servidor.stock), no sobre la copia de la pantalla. La fila se siembra
    // la primera vez con lo que la pantalla tenía (= lo que cargó al abrir).
    async ajustarStock({ stockId, delta, tipo, detalle, imei = null, estadoDestino = null }) {
      servidor.stockLlamadas.push({ stockId, delta, tipo, imei });
      if (cfg.stockSinRpc) return { ok: false, definitivo: true, codigo: 'RPC_AUSENTE', mensaje: 'falta correr stock_ajustar en Supabase' };
      if (cfg.stockRed === 'caida') return { ok: false, definitivo: false, codigo: 'SIN_CONFIRMAR', mensaje: 'red' };
      let f = servidor.stock[stockId];
      if (!f) {
        const m = (ctx.window.State.stock || []).find(x => x.id === stockId || x.id == stockId);
        if (!m) return { ok: false, definitivo: true, codigo: 'STOCK_INEXISTENTE', mensaje: 'STOCK_INEXISTENTE' };
        f = servidor.stock[stockId] = { cantidad: m.cantidad ?? 0, imeis: m.imeis ? [...m.imeis] : [], estado: m.estadoInventario || 'disponible' };
      }
      const unidades = Math.max(f.imeis.length, f.cantidad || 0);
      if (delta < 0) {
        if (unidades + delta < 0) return { ok: false, definitivo: true, codigo: 'STOCK_INSUFICIENTE', mensaje: 'STOCK_INSUFICIENTE' };
        if (imei) {
          if (!f.imeis.includes(imei)) return { ok: false, definitivo: true, codigo: 'IMEI_NO_ESTA', mensaje: 'IMEI_NO_ESTA' };
          f.imeis = f.imeis.filter(x => x !== imei);
        } else if (f.imeis.length) return { ok: false, definitivo: true, codigo: 'IMEI_REQUERIDO', mensaje: 'IMEI_REQUERIDO' };
      } else if (imei) f.imeis = [...f.imeis, imei];
      f.cantidad = unidades + delta;
      const u = Math.max(f.imeis.length, f.cantidad);
      f.estado = estadoDestino || (u <= 0 ? 'vendido' : (delta > 0 && f.estado === 'vendido' ? 'disponible' : f.estado));
      if (cfg.stockRed === 'perdida') return { ok: false, definitivo: false, codigo: 'SIN_CONFIRMAR', mensaje: 'red' };
      return { ok: true, cantidad: f.cantidad, imeis: [...f.imeis], estado: f.estado, unidades: u };
    },
    // Camino nuevo (atómico)
    async aplicarDeltaCaja(persona, bolsillo, delta, ref, clave) {
      contadores.rpc++; cfg.ultimaClave = clave;
      if (cfg.legacy) return { ok: false, motivo: 'rpc_ausente' };
      if (cfg.fallaEscritura && cfg.fallaEscritura(persona, bolsillo)) return { ok: false, motivo: 'rechazada' };
      if (cfg.red === 'caida') return { ok: false, motivo: 'red' };
      const r = aplicarEnServidor(servidor, persona, bolsillo, delta, ref, clave);
      if (r.ok && cfg.red === 'perdida') return { ok: false, motivo: 'red' };
      return r;
    },
    // DOS cajas, todo o nada (réplica de public.caja_mover_atomico)
    async moverCajaAtomico(origen, destino, ref, clave) {
      contadores.rpcMover++; cfg.ultimaClave = clave;
      if (cfg.legacy) return { ok: false, motivo: 'rpc_ausente' };
      if (cfg.fallaEscritura && (cfg.fallaEscritura(origen.persona, origen.bolsillo) || cfg.fallaEscritura(destino.persona, destino.bolsillo)))
        return { ok: false, motivo: 'rechazada' };
      if (cfg.red === 'caida') return { ok: false, motivo: 'red' };
      const r = moverEnServidor(servidor, origen, destino, ref, clave);
      if (r.ok && cfg.red === 'perdida') return { ok: false, motivo: 'red' };
      return r;
    },
    // Cierra la duda por la clave. `sinResolver` = tampoco hay red para preguntar.
    async resolverClaveCaja(clave) {
      if (cfg.sinResolver) return null;
      return resolverEnServidor(servidor, clave);
    },
    async leerSaldoCaja(persona, bolsillo) {
      if (cfg.sinLectura) return null;
      const k = `${persona}||${bolsillo}`;
      return k in base ? base[k] : null;
    },
    // Camino viejo (solo respaldo): saldo absoluto + libro aparte
    async actualizarSaldoCaja(persona, bolsillo, saldo) {
      contadores.viejo++;
      if (cfg.fallaEscritura && cfg.fallaEscritura(persona, bolsillo)) return false;
      base[`${persona}||${bolsillo}`] = saldo;
      return true;
    },
    async registrarMovimientoCaja(mov) {
      if (cfg.fallaLedger) return false;
      libro.push({ ...mov });
      return true;
    },
  };

  // state.js declara su propio toast(), que escribe en #toast del DOM.
  // Se simula el elemento para capturar los avisos tal como los ve el usuario.
  const elToast = { set innerHTML(v) { toasts.push(v); }, classList: { add() {}, remove() {} } };

  Object.assign(DB, dbExtra);
  // DOM genérico: cualquier id existe; `value` sale del mapa `dom` de la prueba.
  const elGenerico = id => ({
    get value() { return dom[id] ?? ''; }, set value(v) { dom[id] = v; },
    get checked() { return !!dom[id]; }, files: [],
    innerHTML: '', textContent: '', style: {}, classList: { add() {}, remove() {} },
    remove() {}, focus() {}, select() {},
  });
  const ctx = {
    DB,
    document: { getElementById: id => (id === 'toast' ? elToast : elGenerico(id)), createElement: () => elGenerico('x'), body: { appendChild() {} } },
    localStorage: { getItem: k => (k in almacen ? almacen[k] : null),
                    setItem: (k, v) => { if (cfg.sinAlmacen) throw new Error('QuotaExceeded'); almacen[k] = String(v); } },
    confirm: () => true,
    Sheets: new Proxy({}, { get: () => () => {} }),
    Auth: { usuario: { nombre: 'Test' } },
    Reportes: { NICHOS: [] },
    App: { goTo() {} },
    window: {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
    Date,
    Math,
    Number,
    JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'state.js' });
  const State = ctx.window.State;
  for (const m of modulos) vm.runInContext(fs.readFileSync(MODULOS + m, 'utf8'), ctx, { filename: m });

  // Siembra los saldos de arranque igual que la migración: el saldo va a la
  // base Y al libro como fila 'saldo_inicial' (el "punto 0"). Sin esto el
  // cuadre arrancaría torcido por el saldo previo, que es justo lo que la
  // migración evita. `soloPantalla` siembra únicamente la memoria de esta
  // pestaña (la base ya tiene lo suyo): así se arma una pestaña "vieja".
  const sembrar = (cajas, { soloPantalla = false } = {}) => {
    State.cajas = JSON.parse(JSON.stringify(cajas));
    if (soloPantalla) return;
    for (const [persona, bolsillos] of Object.entries(cajas)) {
      for (const [bolsillo, saldo] of Object.entries(bolsillos)) {
        base[`${persona}||${bolsillo}`] = saldo;
        libro.push({ persona, bolsillo, delta: saldo, tipo: 'saldo_inicial' });
      }
    }
  };

  return { State, base, libro, toasts, sembrar, contadores, servidor, cfg, mod: ctx.window, dom, almacen };
}

// ── Aserciones ───────────────────────────────────────────────────────────
let ok = 0, fail = 0, conocidos = 0;
const casos = [];
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; casos.push(['PASA', nombre, '']); }
  else { fail++; casos.push(['FALLA', nombre, detalle]); }
}

// Daño YA CONOCIDO de otra pantalla, todavía sin arreglar (hoy no valida la
// divisa). Se mide igual y se muestra, pero no tumba la corrida: si algún día se
// arregla, pasa a PASA solo. Cualquier OTRA falla sí hace que el comando termine
// con error.
function checkConocido(nombre, cond, detalle = '') {
  if (cond) { ok++; casos.push(['PASA', nombre + '  (¡ya no es un problema conocido!)', '']); }
  else { conocidos++; casos.push(['CONOCIDO', nombre, detalle]); }
}

// Solo los movimientos reales, sin las filas de saldo inicial del punto 0.
const movs = libro => libro.filter(m => m.tipo !== 'saldo_inicial');

// Invariante maestro del libro: suma de deltas == saldo en la base.
function cuadra(base, libro) {
  const suma = {};
  libro.forEach(m => {
    const k = `${m.persona}||${m.bolsillo}`;
    suma[k] = (suma[k] || 0) + m.delta;
  });
  const malas = [];
  for (const k of new Set([...Object.keys(base), ...Object.keys(suma)])) {
    const dif = (base[k] || 0) - (suma[k] || 0);
    if (Math.abs(dif) > 0.01) malas.push(`${k}: base=${base[k] || 0} libro=${suma[k] || 0} dif=${dif}`);
  }
  return malas;
}

// ═════════════════════════════════════════════════════════════════════════
// 1. Transferencia entre personas, mismo bolsillo (el caso del ejemplo)
// ═════════════════════════════════════════════════════════════════════════
{
  const { State, base, libro, sembrar } = nuevoEntorno();
  sembrar({ Lautaro: { 'ARS transferencia': 500000 }, Franco: { 'ARS transferencia': 0 } });
  await State.debitarCaja('Lautaro', 'ARS transferencia', 200000, { tipo: 'movimiento' });
  await State.acreditarCaja('Franco', 'ARS transferencia', 200000, { tipo: 'movimiento' });

  check('Lautaro ARS transf → Franco ARS transf: origen queda en 300.000',
    State.cajas.Lautaro['ARS transferencia'] === 300000, `dio ${State.cajas.Lautaro['ARS transferencia']}`);
  check('… destino queda en 200.000',
    State.cajas.Franco['ARS transferencia'] === 200000, `dio ${State.cajas.Franco['ARS transferencia']}`);
  check('… total ARS conservado (no se crea ni desaparece plata)',
    State.cajas.Lautaro['ARS transferencia'] + State.cajas.Franco['ARS transferencia'] === 500000);
  check('… quedaron 2 filas en el libro', movs(libro).length === 2, `hay ${movs(libro).length}`);
  check('… el libro cuadra contra la base', cuadra(base, libro).length === 0, cuadra(base, libro).join(' | '));
}

// ═════════════════════════════════════════════════════════════════════════
// 2. Las 5 monedas: transferencia entre personas en cada bolsillo
// ═════════════════════════════════════════════════════════════════════════
for (const b of BOLSILLOS) {
  const { State, base, libro, sembrar } = nuevoEntorno();
  sembrar({ Lautaro: { [b]: 1000 }, Franco: { [b]: 0 } });
  await State.debitarCaja('Lautaro', b, 400, { tipo: 'movimiento' });
  await State.acreditarCaja('Franco', b, 400, { tipo: 'movimiento' });
  check(`Transferencia ${b} (${monedaDe(b)}): saldos y libro correctos`,
    State.cajas.Lautaro[b] === 600 && State.cajas.Franco[b] === 400 &&
    movs(libro).length === 2 && cuadra(base, libro).length === 0);
}

// ═════════════════════════════════════════════════════════════════════════
// 3. moverCaja: retiro bancario y depósito (misma persona, misma moneda)
// ═════════════════════════════════════════════════════════════════════════
{
  const { State, base, libro, sembrar } = nuevoEntorno();
  sembrar({ Franco: { 'ARS transferencia': 100000, 'ARS cash': 5000 } });
  await State.moverCaja('Franco', 'ARS transferencia', 30000, 'Franco', 'ARS cash', 30000,
    { tipo: 'retiro_banco' });
  check('Retiro bancario ARS: banco 70.000 / efectivo 35.000',
    State.cajas.Franco['ARS transferencia'] === 70000 && State.cajas.Franco['ARS cash'] === 35000,
    JSON.stringify(State.cajas.Franco));
  check('Retiro bancario: el libro cuadra', cuadra(base, libro).length === 0);

  await State.moverCaja('Franco', 'ARS cash', 5000, 'Franco', 'ARS transferencia', 5000,
    { tipo: 'deposito_banco' });
  check('Depósito ARS: banco 75.000 / efectivo 30.000',
    State.cajas.Franco['ARS transferencia'] === 75000 && State.cajas.Franco['ARS cash'] === 30000,
    JSON.stringify(State.cajas.Franco));
  check('Total ARS de Franco intacto tras retiro + depósito',
    State.cajas.Franco['ARS transferencia'] + State.cajas.Franco['ARS cash'] === 105000);
}

// ═════════════════════════════════════════════════════════════════════════
// 4. Cueva: cambio legítimo de moneda (montos distintos a cada lado)
// ═════════════════════════════════════════════════════════════════════════
{
  const { State, base, libro, sembrar } = nuevoEntorno();
  sembrar({ Franco: { 'ARS cash': 1075000, 'USD cash': 0 } });
  const entrega = 1075000, cotiz = 1075, recibe = entrega / cotiz;  // 1000 USD
  await State.debitarCaja('Franco', 'ARS cash', entrega, { tipo: 'cueva' });
  await State.acreditarCaja('Franco', 'USD cash', recibe, { tipo: 'cueva' });
  check('Cueva ARS→USD: sale 1.075.000 ARS, entra 1.000 USD (no 1.075.000 USD)',
    State.cajas.Franco['ARS cash'] === 0 && State.cajas.Franco['USD cash'] === 1000,
    JSON.stringify(State.cajas.Franco));
  check('Cueva: el libro cuadra', cuadra(base, libro).length === 0);
}

// ═════════════════════════════════════════════════════════════════════════
// 5. Venta cobrada en ARS: el motor recibe el monto YA convertido
// ═════════════════════════════════════════════════════════════════════════
{
  const { State, base, libro, sembrar } = nuevoEntorno();
  sembrar({ Franco: { 'ARS cash': 0, 'USD cash': 0 } });
  const pagoUSD = 800, cotiz = 1075;
  // réplica de ventas.js:1624-1627
  const aARS = 'ARS cash'.startsWith('ARS') ? pagoUSD * cotiz : pagoUSD;
  await State.acreditarCaja('Franco', 'ARS cash', aARS, { tipo: 'venta' });
  const aUSD = 'USD cash'.startsWith('ARS') ? pagoUSD * cotiz : pagoUSD;
  await State.acreditarCaja('Franco', 'USD cash', aUSD, { tipo: 'venta' });
  check('Venta USD 800 a bolsillo ARS: entran 860.000 ARS',
    State.cajas.Franco['ARS cash'] === 860000, `dio ${State.cajas.Franco['ARS cash']}`);
  check('Venta USD 800 a bolsillo USD: entran 800 USD',
    State.cajas.Franco['USD cash'] === 800, `dio ${State.cajas.Franco['USD cash']}`);
  check('Venta: el libro cuadra', cuadra(base, libro).length === 0);
}

// ═════════════════════════════════════════════════════════════════════════
// 6. Carreras DENTRO de una pestaña: la cola no debe perder movimientos
// ═════════════════════════════════════════════════════════════════════════
{
  const { State, base, libro, sembrar } = nuevoEntorno();
  sembrar({ Franco: { 'ARS cash': 0 } });
  await Promise.all(Array.from({ length: 50 }, (_, i) =>
    State.acreditarCaja('Franco', 'ARS cash', 100, { tipo: 'venta', referencia: i })));
  check('50 cobros simultáneos a la misma caja: quedan 5.000 (ninguno se pierde)',
    State.cajas.Franco['ARS cash'] === 5000, `dio ${State.cajas.Franco['ARS cash']}`);
  check('50 cobros simultáneos: 50 filas en el libro', movs(libro).length === 50, `hay ${movs(libro).length}`);
  check('50 cobros simultáneos: el libro cuadra', cuadra(base, libro).length === 0);
}

// ═════════════════════════════════════════════════════════════════════════
// 7. Si la base rechaza la escritura, la pantalla vuelve atrás y no anota
// ═════════════════════════════════════════════════════════════════════════
{
  const { State, base, libro, toasts, sembrar } = nuevoEntorno({ fallaEscritura: () => true });
  sembrar({ Franco: { 'ARS cash': 1000 } });
  await State.debitarCaja('Franco', 'ARS cash', 300, { tipo: 'gasto' });
  check('Escritura rechazada: el saldo en pantalla vuelve a 1.000',
    State.cajas.Franco['ARS cash'] === 1000, `dio ${State.cajas.Franco['ARS cash']}`);
  check('Escritura rechazada: no se anota nada en el libro', movs(libro).length === 0);
  check('Escritura rechazada: avisa al usuario', toasts.some(t => t.includes('NO se aplicó')));
}

// ═════════════════════════════════════════════════════════════════════════
// 8. Camino VIEJO (migración sin correr): si falla SOLO el libro, el saldo se guarda pero avisa
// ═════════════════════════════════════════════════════════════════════════
{
  const { State, toasts, sembrar } = nuevoEntorno({ fallaLedger: true, legacy: true });
  sembrar({ Franco: { 'ARS cash': 1000 } });
  await State.debitarCaja('Franco', 'ARS cash', 300, { tipo: 'gasto' });
  check('Libro caído: el saldo igual se aplica', State.cajas.Franco['ARS cash'] === 700);
  check('Libro caído: avisa que no quedó anotado',
    toasts.some(t => t.includes('no quedó anotado en el libro')), JSON.stringify(toasts));
}

// ═════════════════════════════════════════════════════════════════════════
// 9. Ajuste manual como delta (cajas.js:836)
// ═════════════════════════════════════════════════════════════════════════
{
  const { State, base, libro, sembrar } = nuevoEntorno();
  sembrar({ Franco: { 'USD cash': 1000 } });
  const nuevo = 1250, actual = State.cajas.Franco['USD cash'];
  await State.acreditarCaja('Franco', 'USD cash', nuevo - actual, { tipo: 'ajuste' });
  check('Ajuste manual 1000→1250: saldo 1250 y libro con delta +250',
    State.cajas.Franco['USD cash'] === 1250 && movs(libro)[0].delta === 250,
    `saldo ${State.cajas.Franco['USD cash']}, delta ${movs(libro)[0]?.delta}`);
  check('Ajuste manual: el libro cuadra', cuadra(base, libro).length === 0);
}

// ═════════════════════════════════════════════════════════════════════════
// 10. Reverso exacto: cada operación debe poder deshacerse sin dejar resto
// ═════════════════════════════════════════════════════════════════════════
{
  const { State, base, libro, sembrar } = nuevoEntorno();
  sembrar({ Franco: { 'USD cash': 1000 }, Lautaro: { 'USD cash': 0 } });
  await State.debitarCaja('Franco', 'USD cash', 333.33, { tipo: 'proveedor' });
  await State.acreditarCaja('Lautaro', 'USD cash', 333.33, { tipo: 'proveedor' });
  await State.acreditarCaja('Franco', 'USD cash', 333.33, { tipo: 'proveedor' });
  await State.debitarCaja('Lautaro', 'USD cash', 333.33, { tipo: 'proveedor' });
  check('Movimiento + reverso con decimales: vuelve exacto a 1000 / 0',
    State.cajas.Franco['USD cash'] === 1000 && State.cajas.Lautaro['USD cash'] === 0,
    JSON.stringify(State.cajas));
  check('Movimiento + reverso: el libro cuadra', cuadra(base, libro).length === 0);
}

// ═════════════════════════════════════════════════════════════════════════
// 11. REGLA DE DIVISAS: origen y destino de una transferencia
// ═════════════════════════════════════════════════════════════════════════
// Una transferencia (no un cambio de moneda) exige mismo bolsillo-moneda a
// ambos lados. Acá se prueba el daño concreto cuando no se valida.
{
  const { State, sembrar } = nuevoEntorno();
  sembrar({ Lautaro: { 'ARS transferencia': 500000 }, Franco: { 'USD cash': 0 } });
  await State.debitarCaja('Lautaro', 'ARS transferencia', 500000, { tipo: 'movimiento' });
  await State.acreditarCaja('Franco', 'USD cash', 500000, { tipo: 'movimiento' });
  check('ARS transf → USD cash SIN validar: crea USD de la nada (debe bloquearse antes)',
    State.cajas.Franco['USD cash'] === 500000,
    `Franco quedó con USD ${State.cajas.Franco['USD cash']} — 500 millones de pesos de aire`);
}

// ═════════════════════════════════════════════════════════════════════════
// 12. Daño concreto de cada pantalla que hoy NO valida la divisa
// ═════════════════════════════════════════════════════════════════════════
// Cada caso replica la aritmética exacta del módulo. Un caso "EXPUESTO"
// significa que el motor hizo lo que le pidieron: el error está en la
// pantalla que le pasó un monto en la moneda equivocada.
const REF_BLUE = 1075;

async function dania(nombre, cajas, fn, esperado) {
  const { State, sembrar } = nuevoEntorno();
  sembrar(cajas);
  await fn(State);
  const real = JSON.stringify(State.cajas);
  checkConocido(nombre, real === JSON.stringify(esperado), `quedó ${real}, debería ser ${JSON.stringify(esperado)}`);
}

// A) cajas.js guardarMovimiento — valida la moneda contra el ORIGEN, nunca
//    contra el DESTINO. Transferir ARS a un bolsillo USD pasa el control.
await dania('cajas.js · transferir ARS transf → USD cash debería ser imposible',
  { Lautaro: { 'ARS transferencia': 500000 }, Franco: { 'USD cash': 0 } },
  async S => {
    await S.debitarCaja('Lautaro', 'ARS transferencia', 500000, { tipo: 'movimiento' });
    await S.acreditarCaja('Franco', 'USD cash', 500000, { tipo: 'movimiento' });
  },
  { Lautaro: { 'ARS transferencia': 500000 }, Franco: { 'USD cash': 0 } });

// B) gastos.js save — 'Moneda' y 'Caja que paga' son listas independientes.
await dania('gastos.js · gasto de 50.000 ARS pagado desde USD cash',
  { Franco: { 'USD cash': 3000 } },
  async S => { await S.debitarCaja('Franco', 'USD cash', 50000, { tipo: 'gasto' }); },
  { Franco: { 'USD cash': 3000 - 50000 / REF_BLUE } });   // debería descontar ~46,51 USD

// C) cuentacorriente.js:918 — el monto ya viene convertido a USD y se
//    acredita igual en un bolsillo ARS.
await dania('cuentacorriente.js · cobro de 100.000 ARS a bolsillo ARS cash',
  { Franco: { 'ARS cash': 0 } },
  async S => { await S.acreditarCaja('Franco', 'ARS cash', 100000 / REF_BLUE, { tipo: 'cuenta_corriente' }); },
  { Franco: { 'ARS cash': 100000 } });

// D) adelantos.js:229 — a.moneda nunca se compara con el bolsillo elegido.
await dania('adelantos.js · adelanto de 500.000 ARS cobrado desde USD cash',
  { Franco: { 'USD cash': 2000 } },
  async S => { await S.debitarCaja('Franco', 'USD cash', 500000, { tipo: 'adelanto' }); },
  { Franco: { 'USD cash': 2000 - 500000 / REF_BLUE } });

// E) reparaciones.js:941 — no hay selector de moneda; el monto es ARS.
await dania('reparaciones.js · cobro de 80.000 (ARS) a bolsillo USD cash',
  { Franco: { 'USD cash': 500 } },
  async S => { await S.acreditarCaja('Franco', 'USD cash', 80000, { tipo: 'reparacion' }); },
  { Franco: { 'USD cash': 500 + 80000 / REF_BLUE } });

// F) proveedores.js confirmarDevolucion:1596 — monto en USD a cualquier bolsillo.
await dania('proveedores.js · devolución de USD 500 acreditada en ARS cash',
  { Franco: { 'ARS cash': 0 } },
  async S => { await S.acreditarCaja('Franco', 'ARS cash', 500, { tipo: 'proveedor' }); },
  { Franco: { 'ARS cash': 500 * REF_BLUE } });

// G) proveedores.js — el costo debita en la moneda del bolsillo pero un
//    reverso acredita montoUsd: sale ARS y vuelve USD.
await dania('proveedores.js · costo de 107.500 ARS y su reverso deben cerrar en 0',
  { Franco: { 'ARS cash': 200000 } },
  async S => {
    await S.debitarCaja('Franco', 'ARS cash', 107500, { tipo: 'proveedor' });   // _confirmarCosto
    await S.acreditarCaja('Franco', 'ARS cash', 107500 / REF_BLUE, { tipo: 'proveedor' }); // reverso ~1631
  },
  { Franco: { 'ARS cash': 200000 } });

// ═════════════════════════════════════════════════════════════════════════
//  FASE 2 · movimientos atómicos (public.caja_aplicar_delta)
// ═════════════════════════════════════════════════════════════════════════

// 13. EL BUG ORIGINAL: dos pestañas moviendo la MISMA caja a la vez.
//     Con el camino viejo (saldo absoluto) la que escribe última pisa a la otra.
//     Con el atómico no se pierde ni un peso.
async function dosPestanasMismaCaja(legacy) {
  const servidor = nuevoServidor();
  const A = nuevoEntorno({ servidor, legacy });
  const B = nuevoEntorno({ servidor, legacy });
  A.sembrar({ Franco: { 'ARS cash': 1000 } });
  B.sembrar({ Franco: { 'ARS cash': 1000 } }, { soloPantalla: true });   // misma foto inicial
  await Promise.all([
    ...Array.from({ length: 20 }, (_, i) => A.State.acreditarCaja('Franco', 'ARS cash', 100, { tipo: 'venta', referencia: `A${i}` })),
    ...Array.from({ length: 20 }, (_, i) => B.State.acreditarCaja('Franco', 'ARS cash', 50, { tipo: 'venta', referencia: `B${i}` })),
  ]);
  return { servidor, A, B, esperado: 1000 + 20 * 100 + 20 * 50 };
}
{
  const m = await dosPestanasMismaCaja(false);
  check('2 pestañas, misma caja, 40 cobros simultáneos: la base queda en el total exacto',
    m.servidor.base['Franco||ARS cash'] === m.esperado, `base=${m.servidor.base['Franco||ARS cash']} esperado=${m.esperado}`);
  check('2 pestañas: 40 asientos en el libro y el libro cuadra',
    movs(m.servidor.libro).length === 40 && cuadra(m.servidor.base, m.servidor.libro).length === 0,
    `asientos=${movs(m.servidor.libro).length} ${cuadra(m.servidor.base, m.servidor.libro).join(' | ')}`);
  check('2 pestañas: nunca se usó el camino viejo (saldo absoluto)',
    m.A.contadores.viejo === 0 && m.B.contadores.viejo === 0);

  const v = await dosPestanasMismaCaja(true);
  check('CONTROL: con el camino viejo las mismas 2 pestañas SÍ pierden plata (el test mide algo real)',
    v.servidor.base['Franco||ARS cash'] < v.esperado,
    `base=${v.servidor.base['Franco||ARS cash']} esperado=${v.esperado}`);
}

// 14. Una pestaña "vieja" se corrige sola: manda el saldo real de la base.
{
  const servidor = nuevoServidor();
  const A = nuevoEntorno({ servidor });
  const B = nuevoEntorno({ servidor });
  A.sembrar({ Franco: { 'USD cash': 1000 } });
  B.sembrar({ Franco: { 'USD cash': 1000 } }, { soloPantalla: true });
  await A.State.acreditarCaja('Franco', 'USD cash', 500, { tipo: 'venta' });   // A lo sabe; B no
  await B.State.debitarCaja('Franco', 'USD cash', 100, { tipo: 'gasto' });
  check('Pestaña desactualizada: tras mover, muestra el saldo REAL (1.400), no el que adivinaba (900)',
    B.State.cajas.Franco['USD cash'] === 1400, `mostró ${B.State.cajas.Franco['USD cash']}`);
  check('… y la base quedó en 1.400', servidor.base['Franco||USD cash'] === 1400);
}

// 15. Atómico: si la base rechaza, no cambia NADA (ni saldo ni libro)
{
  const { State, base, libro, toasts, sembrar } = nuevoEntorno({ fallaEscritura: () => true });
  sembrar({ Franco: { 'ARS cash': 1000 } });
  const antes = libro.length;
  const r = await State.debitarCaja('Franco', 'ARS cash', 300, { tipo: 'gasto' });
  check('Rechazo: devuelve false', r === false);
  check('Rechazo: la base sigue en 1.000 y el libro sin filas nuevas', base['Franco||ARS cash'] === 1000 && libro.length === antes);
  check('Rechazo: avisa "NO se aplicó"', toasts.some(t => t.includes('NO se aplicó')));
}

// 16. Caída de red: NO se adivina — se le pregunta a la base por la clave del movimiento
{
  // a) Se aplicó pero la respuesta se perdió → la base lo confirma → es un ÉXITO
  const { State, base, toasts, sembrar } = nuevoEntorno({ red: 'perdida' });
  sembrar({ Franco: { 'ARS cash': 1000 } });
  const r = await State.debitarCaja('Franco', 'ARS cash', 300, { tipo: 'gasto' });
  check('Respuesta perdida + se aplicó: la base lo confirma por la clave y el resultado es true (no se deshace nada)',
    r === true && State.cajas.Franco['ARS cash'] === 700 && base['Franco||ARS cash'] === 700, `r=${r} pantalla=${State.cajas.Franco['ARS cash']}`);
  check('… sin avisos de error', !toasts.some(t => t.includes('NO se aplicó')), JSON.stringify(toasts));
}
{
  // b) NO llegó nada → la base lo CANCELA → false definitivo, y el pedido viejo que llegue tarde se rechaza
  const { State, base, toasts, sembrar, cfg, servidor } = nuevoEntorno({ red: 'caida' });
  sembrar({ Franco: { 'ARS cash': 1000 } });
  const r = await State.debitarCaja('Franco', 'ARS cash', 300, { tipo: 'gasto' });
  check('Pedido que no llegó: la base lo cancela → false y avisa "NO se aplicó"',
    r === false && State.cajas.Franco['ARS cash'] === 1000 && toasts.some(t => t.includes('NO se aplicó')), JSON.stringify(toasts));
  const tarde = aplicarEnServidor(servidor, 'Franco', 'ARS cash', -300, { tipo: 'gasto' }, cfg.ultimaClave);
  check('… y si ese pedido viejo llega TARDE a la base, lo rechaza: nunca se aplica después de haber dicho que no',
    tarde.ok === false && base['Franco||ARS cash'] === 1000, JSON.stringify(tarde));
}
{
  // c) Sin red para nada: queda guardado como pendiente, no se adivina
  const e = nuevoEntorno({ red: 'perdida', sinResolver: true });
  e.sembrar({ Franco: { 'ARS cash': 1000 } });
  const r = await e.State.debitarCaja('Franco', 'ARS cash', 300, { tipo: 'gasto' });
  const pend = JSON.parse(e.almacen['im_caja_pendientes'] || '[]');
  check('Sin red para preguntar: false, la pantalla vuelve al saldo anterior y avisa que queda pendiente',
    r === false && e.State.cajas.Franco['ARS cash'] === 1000 && e.toasts.some(t => t.includes('Queda pendiente')), JSON.stringify(e.toasts));
  check('… y el movimiento dudoso queda guardado en el navegador con su clave',
    pend.length === 1 && pend[0].claveResolver && pend[0].descripcion.includes('Franco'), JSON.stringify(pend));

  // Vuelve la conexión: se cierra la duda. Este SÍ se había aplicado → avisa para corregir la operación
  e.cfg.sinResolver = false;
  const quedan = await e.State.resolverPendientesCaja();
  check('Al volver la conexión se resuelve el pendiente: avisa que SÍ se había aplicado y la lista queda vacía',
    quedan === 0 && e.toasts.some(t => t.includes('SÍ se había aplicado')) && JSON.parse(e.almacen['im_caja_pendientes']).length === 0, JSON.stringify(e.toasts));
}
{
  // c2) Dos dudas a la vez (dos movimientos sin red al mismo tiempo): las dos quedan en la lista
  const e = nuevoEntorno({ red: 'perdida', sinResolver: true });
  e.sembrar({ Franco: { 'ARS cash': 1000, 'USD cash': 1000 } });
  await Promise.all([
    e.State.debitarCaja('Franco', 'ARS cash', 100, { tipo: 'gasto' }),
    e.State.debitarCaja('Franco', 'USD cash', 50, { tipo: 'gasto' }),
  ]);
  check('Dos dudas de red a la vez: las DOS quedan anotadas (ninguna pisa a la otra)',
    JSON.parse(e.almacen['im_caja_pendientes'] || '[]').length === 2, e.almacen['im_caja_pendientes']);
}
{
  // c3) El navegador no deja guardar (cuota/privado): la lista sigue en memoria y se avisa
  const e = nuevoEntorno({ red: 'perdida', sinResolver: true, sinAlmacen: true });
  e.sembrar({ Franco: { 'ARS cash': 1000 } });
  await e.State.debitarCaja('Franco', 'ARS cash', 100, { tipo: 'gasto' });
  check('Sin poder guardar en el navegador: queda en memoria (1 pendiente) y avisa que el recordatorio no se pudo guardar',
    e.State._leerPendientesCaja().length === 1 && e.toasts.some(t => t.includes('no dejó guardar')), JSON.stringify(e.toasts));
  e.cfg.sinResolver = false;
  const quedan = await e.State.resolverPendientesCaja();
  check('… y al volver la red se resuelve igual', quedan === 0);
}
{
  // d) Sin red para nada, y el pedido NUNCA llegó: al volver, se cancela y queda confirmado como no aplicado
  const e = nuevoEntorno({ red: 'caida', sinResolver: true });
  e.sembrar({ Franco: { 'ARS cash': 1000 } });
  await e.State.debitarCaja('Franco', 'ARS cash', 300, { tipo: 'gasto' });
  e.cfg.sinResolver = false;
  await e.State.resolverPendientesCaja();
  check('Pendiente cuyo pedido nunca llegó: al volver la red se cancela, avisa "NO se aplicó" y la caja no se movió',
    e.toasts.some(t => t.includes('NO se aplicó (quedó cancelado)')) && e.base['Franco||ARS cash'] === 1000, JSON.stringify(e.toasts));
  const sinPendientes = await e.State.resolverPendientesCaja();
  check('Sin pendientes, resolverPendientesCaja no hace nada', sinPendientes === 0);
}
{
  // e) Un traspaso: duda resuelta por la clave de la 1ª pata
  const { State, base, sembrar } = nuevoEntorno({ red: 'perdida' });
  sembrar({ Lautaro: { 'ARS cash': 1000 }, Franco: { 'ARS cash': 0 } });
  const r = await State.moverCaja('Lautaro', 'ARS cash', 400, 'Franco', 'ARS cash', 400, { tipo: 'movimiento' });
  check('Traspaso con respuesta perdida pero aplicado: la base lo confirma → true y los saldos reales (600 / 400)',
    r === true && State.cajas.Lautaro['ARS cash'] === 600 && State.cajas.Franco['ARS cash'] === 400, JSON.stringify(State.cajas));
}
{
  const { State, base, sembrar, cfg, servidor } = nuevoEntorno({ red: 'caida' });
  sembrar({ Lautaro: { 'ARS cash': 1000 }, Franco: { 'ARS cash': 0 } });
  const r = await State.moverCaja('Lautaro', 'ARS cash', 400, 'Franco', 'ARS cash', 400, { tipo: 'movimiento' });
  const tarde = moverEnServidor(servidor, { persona: 'Lautaro', bolsillo: 'ARS cash', monto: 400 }, { persona: 'Franco', bolsillo: 'ARS cash', monto: 400 }, {}, cfg.ultimaClave);
  check('Traspaso que no llegó → cancelado; si el viejo llega tarde se rechaza ENTERO y ninguna caja se mueve',
    r === false && tarde.ok === false && base['Lautaro||ARS cash'] === 1000 && base['Franco||ARS cash'] === 0, JSON.stringify([r, tarde, base]));
}

// 17. Migración sin correr: cae al camino viejo, avisa UNA sola vez, sigue andando…
//     y en cuanto se corre la migración pasa SOLO al camino atómico (no queda pegado).
{
  const { State, base, libro, toasts, sembrar, contadores, cfg } = nuevoEntorno({ legacy: true });
  sembrar({ Franco: { 'ARS cash': 1000 } });
  await State.acreditarCaja('Franco', 'ARS cash', 100, { tipo: 'venta' });
  await State.acreditarCaja('Franco', 'ARS cash', 100, { tipo: 'venta' });
  await State.debitarCaja('Franco', 'ARS cash', 50, { tipo: 'gasto' });
  check('Sin migración: los movimientos igual se aplican (1.150) y el libro cuadra',
    base['Franco||ARS cash'] === 1150 && cuadra(base, libro).length === 0);
  check('Sin migración: avisa de la migración una sola vez',
    toasts.filter(t => t.includes('caja_aplicar_delta')).length === 1, JSON.stringify(toasts));
  check('Sin migración: el camino viejo se usó las 3 veces', contadores.viejo === 3, `viejo=${contadores.viejo}`);

  cfg.legacy = false;                                           // ← "se corrió la migración" con la pestaña abierta
  const viejoAntes = contadores.viejo;
  await State.acreditarCaja('Franco', 'ARS cash', 25, { tipo: 'venta' });
  check('Tras correr la migración la MISMA pestaña pasa sola al camino atómico (no queda pegada al viejo)',
    contadores.viejo === viejoAntes && base['Franco||ARS cash'] === 1175, `viejo ${viejoAntes}→${contadores.viejo}, base=${base['Franco||ARS cash']}`);
}
// El camino viejo parte del saldo REAL de la base, no del que recuerda la pestaña
{
  const servidor = nuevoServidor();
  const A = nuevoEntorno({ servidor, legacy: true });
  A.sembrar({ Franco: { 'ARS cash': 1000 } });
  servidor.base['Franco||ARS cash'] = 1500;                      // otra pestaña ya había sumado 500
  await A.State.acreditarCaja('Franco', 'ARS cash', 10, { tipo: 'venta' });
  check('Camino viejo: no pisa lo que otra pestaña ya había sumado (1.510, no 1.010)',
    servidor.base['Franco||ARS cash'] === 1510, `base=${servidor.base['Franco||ARS cash']}`);
}
{
  const { State, base, toasts, sembrar } = nuevoEntorno({ legacy: true, sinLectura: true });
  sembrar({ Franco: { 'ARS cash': 1000 } });
  const r = await State.acreditarCaja('Franco', 'ARS cash', 10, { tipo: 'venta' });
  check('Camino viejo sin poder leer el saldo real: no mueve plata a ciegas',
    r === false && base['Franco||ARS cash'] === 1000 && toasts.some(t => t.includes('NO se aplicó')));
}

// 18. moverCaja = UNA función atómica de la base: o se mueven las dos patas o ninguna
{
  const { State, base, toasts, sembrar, contadores } = nuevoEntorno();
  sembrar({ Lautaro: { 'ARS cash': 1000 }, Franco: { 'ARS cash': 0 } });
  const r = await State.moverCaja('Lautaro', 'ARS cash', 400, 'Franco', 'ARS cash', 400, { tipo: 'movimiento' });
  check('moverCaja exitoso: true, saldos 600 / 400 y UN solo pedido a la base',
    r === true && base['Franco||ARS cash'] === 400 && base['Lautaro||ARS cash'] === 600 && contadores.rpcMover === 1 && contadores.rpc === 0,
    JSON.stringify({ base, mover: contadores.rpcMover, delta: contadores.rpc }));
  check('moverCaja: la pantalla muestra los saldos reales que devolvió la base',
    State.cajas.Franco['ARS cash'] === 400 && State.cajas.Lautaro['ARS cash'] === 600);
}
{
  const { State, base, libro, toasts, sembrar } = nuevoEntorno({ fallaEscritura: (p) => p === 'Franco' });
  sembrar({ Lautaro: { 'ARS cash': 1000 }, Franco: { 'ARS cash': 0 } });
  const antes = libro.length;
  const r = await State.moverCaja('Lautaro', 'ARS cash', 400, 'Franco', 'ARS cash', 400, { tipo: 'movimiento' });
  check('moverCaja con el DESTINO rechazado: false y el ORIGEN tampoco se mueve (antes quedaba debitado)',
    r === false && base['Lautaro||ARS cash'] === 1000 && base['Franco||ARS cash'] === 0 && libro.length === antes, JSON.stringify(base));
  check('moverCaja rechazado: la pantalla vuelve a los dos saldos de antes y avisa que no se movió nada',
    State.cajas.Lautaro['ARS cash'] === 1000 && State.cajas.Franco['ARS cash'] === 0 && toasts.some(t => t.includes('no se movió nada')), JSON.stringify(toasts));
}
{
  const { State, base, sembrar } = nuevoEntorno({ fallaEscritura: (p) => p === 'Lautaro' });
  sembrar({ Lautaro: { 'ARS cash': 1000 }, Franco: { 'ARS cash': 0 } });
  const r = await State.moverCaja('Lautaro', 'ARS cash', 400, 'Franco', 'ARS cash', 400, { tipo: 'movimiento' });
  check('moverCaja con el ORIGEN rechazado: false y el destino NO recibe plata de la nada',
    r === false && base['Franco||ARS cash'] === 0 && base['Lautaro||ARS cash'] === 1000, JSON.stringify(base));
}
{
  // Sin la migración los traspasos se BLOQUEAN: con dos pedidos sueltos, si el 2º falla la plata queda debitada
  const { State, base, sembrar, toasts, contadores } = nuevoEntorno({ legacy: true });
  sembrar({ Lautaro: { 'ARS cash': 1000 }, Franco: { 'ARS cash': 0 } });
  const r = await State.moverCaja('Lautaro', 'ARS cash', 400, 'Franco', 'ARS cash', 400, { tipo: 'movimiento' });
  check('Sin migración: el traspaso se bloquea (false), no se mueve NADA y avisa por qué',
    r === false && base['Franco||ARS cash'] === 0 && base['Lautaro||ARS cash'] === 1000 && contadores.viejo === 0 &&
    toasts.some(t => t.includes('bloqueados hasta correr la migración')), JSON.stringify([base, toasts]));
}
{
  // Cambio de moneda con montos distintos (como Cueva) y traspasos simultáneos en sentido contrario
  const { State, base, sembrar } = nuevoEntorno();
  sembrar({ Franco: { 'ARS cash': 1075000, 'USD cash': 0 }, Lautaro: { 'ARS cash': 0 } });
  const r = await State.moverCaja('Franco', 'ARS cash', 1075000, 'Franco', 'USD cash', 1000, { tipo: 'cueva' });
  check('Cambio de moneda por moverCaja: sale 1.075.000 ARS y entran 1.000 USD',
    r === true && base['Franco||ARS cash'] === 0 && base['Franco||USD cash'] === 1000, JSON.stringify(base));
  const rs = await Promise.all([
    State.moverCaja('Franco', 'USD cash', 100, 'Lautaro', 'ARS cash', 100, { tipo: 'movimiento' }),
    State.moverCaja('Lautaro', 'ARS cash', 40, 'Franco', 'USD cash', 40, { tipo: 'movimiento' }),
  ]);
  check('Dos traspasos simultáneos en sentido contrario: los dos se aplican y el total se conserva',
    rs.every(x => x === true) && base['Franco||USD cash'] + base['Lautaro||ARS cash'] === 1000, JSON.stringify(base));
}

// 19. Cada movimiento viaja con SU clave de idempotencia (única y no vacía)
{
  const { State, libro, sembrar } = nuevoEntorno();
  sembrar({ Franco: { 'ARS cash': 0 } });
  await Promise.all(Array.from({ length: 30 }, () => State.acreditarCaja('Franco', 'ARS cash', 10, { tipo: 'venta' })));
  const claves = movs(libro).map(m => m.clave);
  check('30 movimientos → 30 claves distintas y no vacías',
    claves.every(Boolean) && new Set(claves).size === 30, `${new Set(claves).size} distintas`);
}

// 20. Idempotencia en la base: repetir la MISMA clave no suma dos veces; otra caja u otro monto con esa clave se rechaza
{
  const srv = nuevoServidor();
  srv.base['Franco||ARS cash'] = 1000;
  const r1 = aplicarEnServidor(srv, 'Franco', 'ARS cash', 100, {}, 'k1');
  const r2 = aplicarEnServidor(srv, 'Franco', 'ARS cash', 100, {}, 'k1');
  check('Misma clave dos veces: se aplica una sola (1.100) y devuelve el mismo saldo',
    srv.base['Franco||ARS cash'] === 1100 && r1.saldoPost === 1100 && r2.saldoPost === 1100 && srv.libro.length === 1);
  const r3 = aplicarEnServidor(srv, 'Franco', 'ARS cash', 999, {}, 'k1');
  check('Misma clave con otro monto: rechazada', r3.ok === false && srv.base['Franco||ARS cash'] === 1100);
}

// 21. DB.aplicarDeltaCaja REAL (supabase-config.js) contra un cliente simulado:
//     reintento con la misma clave, errores lógicos que no se reintentan, función ausente.
{
  const fuente = fs.readFileSync('/Users/francovelas/crm-complete/iphonemood-crm/src/modules/supabase-config.js', 'utf8');
  const llamadas = [];
  let guion = [];                                   // respuestas que va devolviendo supa.rpc
  const fakeSupa = {
    rpc: async (nombre, args) => { llamadas.push({ nombre, args }); const r = guion.shift(); if (r instanceof Error) throw r; return r; },
  };
  const ctxDB = {
    window: { __APP_CONFIG__: { SUPABASE_URL: 'x', SUPABASE_ANON_KEY: 'y' } },
    supabase: { createClient: () => fakeSupa },
    console: { log() {}, warn() {}, error() {} },
    Auth: { usuario: { nombre: 'Franco' } }, State: {}, toast() {},
    Date, Math, Number, JSON, String, Promise, Error,
  };
  vm.createContext(ctxDB);
  vm.runInContext(fuente + '\nthis.__DB = DB;', ctxDB, { filename: 'supabase-config.js' });
  const DBreal = ctxDB.__DB;
  DBreal.personasMap = { Franco: 'uuid-franco' };

  const ok = (saldo) => ({ data: saldo, error: null, status: 200 });
  const rojo = (code, status = 400) => ({ data: null, error: { message: 'x', code }, status });

  guion = [ok('1100.50')]; llamadas.length = 0;
  let r = await DBreal.aplicarDeltaCaja('Franco', 'ARS cash', 100.5, { tipo: 'venta', referencia: 7 }, 'clave-1');
  check('DB real: éxito devuelve el saldo como número', r.ok === true && r.saldoPost === 1100.5, JSON.stringify(r));
  check('DB real: manda delta, tipo, referencia como texto y la clave',
    llamadas[0].nombre === 'caja_aplicar_delta' && llamadas[0].args.p_delta === 100.5 &&
    llamadas[0].args.p_referencia === '7' && llamadas[0].args.p_clave === 'clave-1' && llamadas[0].args.p_persona_id === 'uuid-franco',
    JSON.stringify(llamadas[0]));

  guion = [rojo('', 0), ok(900)]; llamadas.length = 0;
  r = await DBreal.aplicarDeltaCaja('Franco', 'ARS cash', -100, {}, 'clave-2');
  check('DB real: error de red → reintenta UNA vez con la MISMA clave y confirma',
    r.ok === true && llamadas.length === 2 && llamadas[0].args.p_clave === 'clave-2' && llamadas[1].args.p_clave === 'clave-2',
    JSON.stringify({ r, n: llamadas.length }));

  guion = [new Error('Failed to fetch'), new Error('Failed to fetch')]; llamadas.length = 0;
  r = await DBreal.aplicarDeltaCaja('Franco', 'ARS cash', -100, {}, 'clave-3');
  check('DB real: la red cae dos veces → "red" (sin confirmar), 2 intentos', r.ok === false && r.motivo === 'red' && llamadas.length === 2);

  guion = [rojo('P0001')]; llamadas.length = 0;
  r = await DBreal.aplicarDeltaCaja('Franco', 'ARS cash', -100, {}, 'clave-4');
  check('DB real: rechazo lógico de la base → "rechazada" y NO se reintenta', r.motivo === 'rechazada' && llamadas.length === 1);

  guion = [rojo('PGRST202', 404)]; llamadas.length = 0;
  r = await DBreal.aplicarDeltaCaja('Franco', 'ARS cash', -100, {}, 'clave-5');
  check('DB real: función inexistente → "rpc_ausente" y NO se reintenta', r.motivo === 'rpc_ausente' && llamadas.length === 1);

  guion = [rojo('', 503), ok(5)]; llamadas.length = 0;
  r = await DBreal.aplicarDeltaCaja('Franco', 'ARS cash', 5, {}, 'clave-6');
  check('DB real: un 503 del servidor también se trata como ambiguo y se reintenta', r.ok === true && llamadas.length === 2);

  // Caso de la revisión: el 1er intento queda incierto (pudo aplicarse) y el
  // reintento cae con un rechazo "definitivo". NO se puede declarar "no se aplicó".
  guion = [rojo('', 0), rojo('42501', 403)]; llamadas.length = 0;
  r = await DBreal.aplicarDeltaCaja('Franco', 'ARS cash', 5, {}, 'clave-8');
  check('DB real: incierto + rechazo en el reintento → "red" (sin confirmar), NUNCA "rechazada"', r.motivo === 'red' && llamadas.length === 2, JSON.stringify(r));
  guion = [rojo('', 502), rojo('PGRST202', 404)]; llamadas.length = 0;
  r = await DBreal.aplicarDeltaCaja('Franco', 'ARS cash', 5, {}, 'clave-9');
  check('DB real: incierto + "función inexistente" en el reintento → "red", no cae al camino viejo', r.motivo === 'red', JSON.stringify(r));

  // Traspaso de dos patas
  guion = [{ data: [{ saldo_origen: '600', saldo_destino: '400' }], error: null, status: 200 }]; llamadas.length = 0;
  DBreal.personasMap.Lautaro = 'uuid-lautaro';
  r = await DBreal.moverCajaAtomico({ persona: 'Franco', bolsillo: 'ARS cash', monto: 400, descripcion: 'sale' },
                                   { persona: 'Lautaro', bolsillo: 'ARS cash', monto: 400, descripcion: 'entra' }, { tipo: 'movimiento', referencia: 3 }, 'tr-1');
  check('DB real traspaso: manda las dos patas, la clave y las descripciones; devuelve los dos saldos',
    r.ok && r.saldoOrigen === 600 && r.saldoDestino === 400 && llamadas[0].nombre === 'caja_mover_atomico' &&
    llamadas[0].args.p_clave === 'tr-1' && llamadas[0].args.p_origen_persona === 'uuid-franco' && llamadas[0].args.p_destino_persona === 'uuid-lautaro' &&
    llamadas[0].args.p_monto_origen === 400 && llamadas[0].args.p_desc_origen === 'sale' && llamadas[0].args.p_desc_destino === 'entra' && llamadas[0].args.p_referencia === '3',
    JSON.stringify([r, llamadas[0]]));
  guion = [rojo('', 0), { data: [{ saldo_origen: 1, saldo_destino: 2 }], error: null, status: 200 }]; llamadas.length = 0;
  r = await DBreal.moverCajaAtomico({ persona: 'Franco', bolsillo: 'ARS cash', monto: 1 }, { persona: 'Lautaro', bolsillo: 'ARS cash', monto: 1 }, {}, 'tr-2');
  check('DB real traspaso: error de red → reintenta con la MISMA clave', r.ok && llamadas.length === 2 && llamadas[0].args.p_clave === llamadas[1].args.p_clave);
  llamadas.length = 0;
  r = await DBreal.moverCajaAtomico({ persona: 'Franco', bolsillo: 'ARS cash', monto: 1 }, { persona: 'Fantasma', bolsillo: 'ARS cash', monto: 1 }, {}, 'tr-3');
  check('DB real traspaso: persona desconocida → rechazada sin llamar a la base', r.motivo === 'rechazada' && llamadas.length === 0);

  llamadas.length = 0;
  r = await DBreal.aplicarDeltaCaja('Fantasma', 'ARS cash', 5, {}, 'clave-7');
  check('DB real: persona desconocida → rechazada sin llamar a la base', r.motivo === 'rechazada' && llamadas.length === 0);
}

// ═════════════════════════════════════════════════════════════════════════
//  PANTALLAS REALES · ninguna da por hecho lo que la caja no confirmó
//  (cada caso corre el código de la pantalla de verdad, con la base simulada)
// ═════════════════════════════════════════════════════════════════════════

// 22. CUEVA: guardar una operación
const cuevaDom = () => ({
  'cf-entrega': '1075000', 'cf-recibe': '1000', 'cf-cotiz': '1075',
  'cf-origen-p': 'Franco', 'cf-origen-b': 'ARS cash', 'cf-destino-p': 'Franco', 'cf-destino-b': 'USD cash',
});
{
  const creados = [];
  const e = nuevoEntorno({ modulos: ['cueva.js'], dom: cuevaDom(),
    dbExtra: { async crearCambio(op) { creados.push(op); return 77; } } });
  e.sembrar({ Franco: { 'ARS cash': 1075000, 'USD cash': 0 } });
  e.mod.Cueva.renderTable = () => {}; e.mod.Cueva.opType = 'ars-usd'; e.State.cambios = [];
  await e.mod.Cueva.save();
  check('Cueva guardar OK: sale 1.075.000 ARS, entran 1.000 USD y SE registra la operación',
    e.base['Franco||ARS cash'] === 0 && e.base['Franco||USD cash'] === 1000 && creados.length === 1 && e.State.cambios.length === 1,
    JSON.stringify({ base: e.base, creados: creados.length }));
}
{
  const creados = [];
  const e = nuevoEntorno({ modulos: ['cueva.js'], dom: cuevaDom(), fallaEscritura: (p, b) => b === 'USD cash',
    dbExtra: { async crearCambio(op) { creados.push(op); return 77; } } });
  e.sembrar({ Franco: { 'ARS cash': 1075000, 'USD cash': 0 } });
  e.mod.Cueva.renderTable = () => {}; e.mod.Cueva.opType = 'ars-usd'; e.State.cambios = [];
  await e.mod.Cueva.save();
  check('Cueva con el DESTINO rechazado: NO se registra la operación y NO se debita el origen (antes: plata debitada y operación "hecha")',
    creados.length === 0 && e.State.cambios.length === 0 && e.base['Franco||ARS cash'] === 1075000 && e.base['Franco||USD cash'] === 0,
    JSON.stringify({ base: e.base, creados: creados.length }));
}
{
  const e = nuevoEntorno({ modulos: ['cueva.js'], fallaEscritura: (p, b) => b === 'ARS cash',
    dbExtra: { async eliminarCambio() { e.borrados = (e.borrados || 0) + 1; } } });
  e.sembrar({ Franco: { 'ARS cash': 0, 'USD cash': 1000 } });
  e.mod.Cueva.renderTable = () => {}; e.mod.Cueva.close = () => {};
  e.State.cambios = [{ id: 5, tipo: 'ars-usd', entrega: 1075000, recibe: 1000, origenP: 'Franco', origenB: 'ARS cash', destinoP: 'Franco', destinoB: 'USD cash' }];
  await e.mod.Cueva.deleteOp(5);
  check('Cueva eliminar con la reversión rechazada: la operación NO se borra',
    e.State.cambios.length === 1 && !e.borrados && e.base['Franco||USD cash'] === 1000, JSON.stringify(e.base));
}

// 23. GASTOS: guardar un gasto pagado
const gastoDom = () => ({ 'gf-motivo': 'Alquiler', 'gf-monto': '400', 'gf-caja-persona': 'Franco', 'gf-caja-bolsillo': 'USD cash',
  'gf-moneda': 'USD', 'gf-cat': 'c1', 'gf-resp': 'Franco' });
{
  const e = nuevoEntorno({ modulos: ['gastos.js'], dom: gastoDom(), dbExtra: { async crearGasto() { return 9; }, async eliminarGasto(id) { e.eliminados.push(id); } } });
  e.eliminados = [];
  e.sembrar({ Franco: { 'USD cash': 1000 } });
  Object.assign(e.mod.Gastos, { close() {}, renderChips() {}, renderKpis() {}, renderTable() {} });
  e.State.categoriasGasto = [{ id: 'c1', nombre: 'Varios', color: '#888' }]; e.State.gastos = [];
  await e.mod.Gastos.save();
  check('Gasto OK: la caja baja a 600 y el gasto queda registrado',
    e.base['Franco||USD cash'] === 600 && e.State.gastos.length === 1, JSON.stringify(e.base));
}
{
  const e = nuevoEntorno({ modulos: ['gastos.js'], dom: gastoDom(), fallaEscritura: () => true,
    dbExtra: { async crearGasto() { return 9; }, async eliminarGasto(id) { e.eliminados.push(id); } } });
  e.eliminados = [];
  e.sembrar({ Franco: { 'USD cash': 1000 } });
  Object.assign(e.mod.Gastos, { close() {}, renderChips() {}, renderKpis() {}, renderTable() {} });
  e.State.categoriasGasto = [{ id: 'c1', nombre: 'Varios', color: '#888' }]; e.State.gastos = [];
  await e.mod.Gastos.save();
  check('Gasto con la caja rechazando: NO queda un gasto "pagado" sin plata debitada (se deshace el alta)',
    e.State.gastos.length === 0 && e.eliminados.includes(9) && e.base['Franco||USD cash'] === 1000, JSON.stringify({ g: e.State.gastos.length, el: e.eliminados }));
}
{
  const e = nuevoEntorno({ modulos: ['gastos.js'], fallaEscritura: () => true, dbExtra: { async eliminarGasto(id) { e.eliminados.push(id); } } });
  e.eliminados = [];
  e.sembrar({ Franco: { 'USD cash': 600 } });
  Object.assign(e.mod.Gastos, { close() {}, renderChips() {}, renderKpis() {}, renderTable() {} });
  e.State.gastos = [{ id: 9, motivo: 'Alquiler', caja: 'Franco-USD cash', monto: 400, estado: 'pagado' }];
  await e.mod.Gastos.deleteGasto(9);
  check('Eliminar gasto con la devolución rechazada: el gasto NO se borra',
    e.State.gastos.length === 1 && e.eliminados.length === 0, JSON.stringify(e.State.gastos.length));
}

// 24. VENTAS: confirmar una venta con dos cobros en dos cajas
const ventaBase = () => ({
  cliente: 'Cliente', clienteTel: '', clienteDni: '', clienteEmail: '', tipoVenta: 'minorista', vendedor: 'Franco',
  fechaVenta: '2026-10-02', tradeIn: null, deudaVenta: null, comisionVendedor: 0,
  items: [{ nombre: 'iPhone 15', precio: 1000, costo: 800, stockId: 1, imei: null }],
  pagos: [{ persona: 'Franco', bolsillo: 'USD cash', monto: 600 }, { persona: 'Lautaro', bolsillo: 'USD cash', monto: 400 }],
});
{
  const servidor = nuevoServidor();
  const { e } = (() => {
    const ee = nuevoEntorno({ servidor, modulos: ['stock.js', 'ventas.js'], fallaEscritura: (p) => p === 'Lautaro',
      dbExtra: { async crearVenta() { ee.ventasCreadas++; return 500; }, async actualizarImeisStock() { return true; }, async actualizarCantidadStock() { return true; }, async actualizarEstadoInventario() { return true; } } });
    ee.ventasCreadas = 0; return { e: ee };
  })();
  e.sembrar({ Franco: { 'USD cash': 0 }, Lautaro: { 'USD cash': 0 } });
  Object.assign(e.State, { stock: [{ id: 1, nombre: 'iPhone 15', cat: 'iphone', cantidad: 1, cantidadDeclarada: 1, costoUSD: 800, estadoInventario: 'disponible' }], ventas: [], garantias: [] });
  Object.assign(e.mod.Ventas, { closeModal() {}, renderList() {}, draft: ventaBase() });
  await e.mod.Ventas._confirmSale();
  check('Venta con el 2º cobro rechazado: NO se crea la venta',
    e.ventasCreadas === 0 && e.State.ventas.length === 0, `creadas=${e.ventasCreadas}`);
  check('… el 1er cobro (que sí había entrado) se DESHACE solo: las dos cajas quedan en 0',
    e.base['Franco||USD cash'] === 0 && e.base['Lautaro||USD cash'] === 0, JSON.stringify(e.base));
  check('… y el stock vuelve a estar (el equipo no se pierde por una venta que no se hizo)',
    e.State.stock[0].cantidad === 1, `cantidad=${e.State.stock[0].cantidad}`);
  check('… y avisa que la venta NO se guardó', e.toasts.some(t => t.includes('La venta NO se guardó')), JSON.stringify(e.toasts));
}
{
  // El escenario exacto de la revisión: un cobro rechazado + la venta falla DESPUÉS → no se "devuelve" plata que nunca entró
  const ee = nuevoEntorno({ modulos: ['stock.js', 'ventas.js'], fallaEscritura: (p) => p === 'Lautaro',
    dbExtra: { async crearVenta() { ee.ventasCreadas++; return null; }, async actualizarImeisStock() { return true; }, async actualizarCantidadStock() { return true; }, async actualizarEstadoInventario() { return true; } } });
  ee.ventasCreadas = 0;
  ee.sembrar({ Franco: { 'USD cash': 50 }, Lautaro: { 'USD cash': 50 } });
  Object.assign(ee.State, { stock: [{ id: 1, nombre: 'iPhone 15', cat: 'iphone', cantidad: 1, cantidadDeclarada: 1, costoUSD: 800, estadoInventario: 'disponible' }], ventas: [], garantias: [] });
  Object.assign(ee.mod.Ventas, { closeModal() {}, renderList() {}, draft: ventaBase() });
  await ee.mod.Ventas._confirmSale();
  check('Cobro rechazado en Lautaro: su caja NO pierde 400 que nunca recibió (antes se le "revertía" igual)',
    ee.base['Lautaro||USD cash'] === 50 && ee.base['Franco||USD cash'] === 50, JSON.stringify(ee.base));
}
{
  // Todo bien en caja pero la base de ventas falla: se revierten SOLO los cobros que entraron
  const ee = nuevoEntorno({ modulos: ['stock.js', 'ventas.js'],
    dbExtra: { async crearVenta() { ee.ventasCreadas++; return null; }, async actualizarImeisStock() { return true; }, async actualizarCantidadStock() { return true; }, async actualizarEstadoInventario() { return true; } } });
  ee.ventasCreadas = 0;
  ee.sembrar({ Franco: { 'USD cash': 50 }, Lautaro: { 'USD cash': 50 } });
  Object.assign(ee.State, { stock: [{ id: 1, nombre: 'iPhone 15', cat: 'iphone', cantidad: 1, cantidadDeclarada: 1, costoUSD: 800, estadoInventario: 'disponible' }], ventas: [], garantias: [] });
  Object.assign(ee.mod.Ventas, { closeModal() {}, renderList() {}, draft: ventaBase() });
  await ee.mod.Ventas._confirmSale();
  check('Venta que no se pudo guardar con los cobros ya en caja: se devuelven los dos y las cajas quedan como estaban',
    ee.base['Franco||USD cash'] === 50 && ee.base['Lautaro||USD cash'] === 50 && ee.State.stock[0].cantidad === 1, JSON.stringify(ee.base));
}
{
  const ee = nuevoEntorno({ modulos: ['stock.js', 'ventas.js'],
    dbExtra: { async crearVenta() { return 500; }, async actualizarImeisStock() { return true; }, async actualizarCantidadStock() { return true; }, async actualizarEstadoInventario() { return true; } } });
  ee.sembrar({ Franco: { 'USD cash': 50 }, Lautaro: { 'USD cash': 50 } });
  Object.assign(ee.State, { stock: [{ id: 1, nombre: 'iPhone 15', cat: 'iphone', cantidad: 1, cantidadDeclarada: 1, costoUSD: 800, estadoInventario: 'disponible' }], ventas: [], garantias: [] });
  Object.assign(ee.mod.Ventas, { closeModal() {}, renderList() {}, draft: ventaBase() });
  await ee.mod.Ventas._confirmSale();
  check('Venta OK: los dos cobros entran (650 / 450) y la venta queda guardada',
    ee.base['Franco||USD cash'] === 650 && ee.base['Lautaro||USD cash'] === 450 && ee.State.ventas.length === 1 && cuadra(ee.base, ee.libro).length === 0,
    JSON.stringify(ee.base));
}

// 25. VENTAS: eliminar un pago y anular una venta
{
  const borrados = [];
  const ee = nuevoEntorno({ modulos: ['stock.js', 'ventas.js'], fallaEscritura: () => true,
    dbExtra: { async eliminarPagoVenta(id) { borrados.push(id); return true; }, async actualizarEstadoVenta() {} } });
  ee.sembrar({ Franco: { 'USD cash': 600 } });
  Object.assign(ee.mod.Ventas, { renderList() {}, viewSale() {} });
  ee.State.ventas = [{ id: 7, estado: 'cerrada', items: [{ precio: 600 }], pagos: [{ id: 3, persona: 'Franco', bolsillo: 'USD cash', monto: 600 }] }];
  await ee.mod.Ventas.eliminarPago(7, 3);
  check('Eliminar pago con la caja rechazando: el pago NO se borra (antes se borraba y la plata quedaba en la caja)',
    borrados.length === 0 && ee.State.ventas[0].pagos.length === 1, JSON.stringify({ borrados }));
}
{
  const anuladas = [], stockEscrito = [];
  const ee = nuevoEntorno({ modulos: ['stock.js', 'ventas.js'], fallaEscritura: (p) => p === 'Lautaro',
    dbExtra: { async anularVenta(id) { anuladas.push(id); return true; }, async actualizarCantidadStock() { stockEscrito.push(1); return true; },
               async cancelarDeudaDeVenta() { return []; },
               async actualizarImeisStock() { return true; }, async actualizarEstadoInventario() { return true; }, async buscarStockTradeInDeVenta() { return []; } } });
  ee.sembrar({ Franco: { 'USD cash': 600 }, Lautaro: { 'USD cash': 400 } });
  Object.assign(ee.mod.Ventas, { renderList() {}, closeModal() {} });
  Object.assign(ee.State, { stock: [{ id: 1, nombre: 'iPhone', cantidad: 0, cantidadDeclarada: 0, estadoInventario: 'vendido' }] });
  ee.State.ventas = [{ id: 7, estado: 'cerrada', cliente: 'x', items: [{ precio: 1000, stockId: 1 }],
    pagos: [{ id: 21, persona: 'Franco', bolsillo: 'USD cash', monto: 600 }, { id: 22, persona: 'Lautaro', bolsillo: 'USD cash', monto: 400 }] }];
  await ee.mod.Ventas.anular(7);
  check('Anular con una caja que no devuelve: la venta NO se anula ni se toca el stock; la caja que sí pudo, devolvió (Franco 0, Lautaro 400)',
    anuladas.length === 0 && ee.State.ventas.length === 1 && stockEscrito.length === 0 && ee.State.stock[0].cantidad === 0 &&
    ee.base['Franco||USD cash'] === 0 && ee.base['Lautaro||USD cash'] === 400, JSON.stringify({ anuladas, base: ee.base, stock: ee.State.stock[0] }));
  // El usuario repite «Anular» cuando la caja vuelve: la 1ª NO se devuelve otra vez.
  ee.cfg.fallaEscritura = null;
  await ee.mod.Ventas.anular(7);
  check('… al repetir «Anular»: Franco NO se devuelve dos veces (queda en 0), Lautaro vuelve (0), la venta se anula y el stock se repone UNA vez',
    ee.base['Franco||USD cash'] === 0 && ee.base['Lautaro||USD cash'] === 0 && anuladas.length === 1 && ee.State.ventas.length === 0 &&
    ee.State.stock[0].cantidad === 1 && cuadra(ee.base, ee.libro).length === 0, JSON.stringify({ base: ee.base, anuladas, st: ee.State.stock[0] }));
}

// 26a. Redondeo: un movimiento de +1,125 entra como +1,13 y al deshacerlo vuelve −1,13 exacto (no −1,12)
{
  const { State, base, sembrar } = nuevoEntorno({ fallaEscritura: (p) => p === 'B' });
  sembrar({ A: { 'ARS cash': 100 }, B: { 'ARS cash': 100 } });
  const r = await State.moverVarias([
    { persona: 'A', bolsillo: 'ARS cash', delta: 1.125, ref: { tipo: 'venta' } },
    { persona: 'B', bolsillo: 'ARS cash', delta: 5, ref: { tipo: 'venta' } },
  ]);
  check('moverVarias con +1,125 y un rechazo después: A vuelve a 100,00 exacto (antes quedaba en 100,01)',
    r === false && base['A||ARS cash'] === 100, `A=${base['A||ARS cash']}`);
}

// 26. moverVarias: todo o nada, y el modo de reversión
{
  const { State, base, libro, sembrar } = nuevoEntorno({ fallaEscritura: (p) => p === 'C' });
  sembrar({ A: { 'ARS cash': 100 }, B: { 'ARS cash': 100 }, C: { 'ARS cash': 100 } });
  const r = await State.moverVarias([
    { persona: 'A', bolsillo: 'ARS cash', delta: +10, ref: { tipo: 'venta' } },
    { persona: 'B', bolsillo: 'ARS cash', delta: +20, ref: { tipo: 'venta' } },
    { persona: 'C', bolsillo: 'ARS cash', delta: +30, ref: { tipo: 'venta' } },
  ]);
  check('moverVarias con la 3ª rechazada: false y A y B vuelven a 100 (todo o nada)',
    r === false && base['A||ARS cash'] === 100 && base['B||ARS cash'] === 100 && base['C||ARS cash'] === 100, JSON.stringify(base));
  check('moverVarias: el libro sigue cuadrando tras deshacer', cuadra(base, libro).length === 0, cuadra(base, libro).join(' | '));
}
{
  const { State, base, sembrar, toasts } = nuevoEntorno({ fallaEscritura: (p) => p === 'B' });
  sembrar({ A: { 'ARS cash': 100 }, B: { 'ARS cash': 100 }, C: { 'ARS cash': 100 } });
  const r = await State.moverVarias([
    { persona: 'A', bolsillo: 'ARS cash', delta: -10, ref: { tipo: 'reverso' } },
    { persona: 'B', bolsillo: 'ARS cash', delta: -20, ref: { tipo: 'reverso' } },
    { persona: 'C', bolsillo: 'ARS cash', delta: -30, ref: { tipo: 'reverso' } },
  ], { atomico: false });
  check('moverVarias en modo reversión: aplica todo lo que se puede (A y C), devuelve false y avisa cuál falló',
    r === false && base['A||ARS cash'] === 90 && base['C||ARS cash'] === 70 && base['B||ARS cash'] === 100 &&
    toasts.some(t => t.includes('1 de 3') && t.includes('B')), JSON.stringify([base, toasts]));
}

// 27. La plata se movió pero el REGISTRO no se pudo guardar → se deshace el movimiento
const convDom = () => ({ 'conv-monto': '1000', 'conv-pct': '2', 'conv-p-origen': 'Franco', 'conv-b-origen': 'USD cash',
  'conv-p-dest': 'Franco', 'conv-b-dest': 'USDT', 'conv-fecha': '2026-10-02', 'conv-notas': '' });
{
  const e = nuevoEntorno({ modulos: ['proveedores.js'], dom: convDom(), dbExtra: { async guardarLotePago() { return false; } } });
  e.sembrar({ Franco: { 'USD cash': 5000, 'USDT': 0 } });
  Object.assign(e.mod.Proveedores, { renderKpis() {}, renderContent() {} });
  await e.mod.Proveedores._confirmarConversion(1);
  check('Conversión a USDT cuyo registro en el lote falla: la plata VUELVE a su caja (5.000 / 0) y avisa',
    e.base['Franco||USD cash'] === 5000 && e.base['Franco||USDT'] === 0 && e.toasts.some(t => t.includes('se devolvió la plata')),
    JSON.stringify([e.base, e.toasts]));
  check('… y el libro cuadra después del reverso', cuadra(e.base, e.libro).length === 0, cuadra(e.base, e.libro).join(' | '));
}
{
  const e = nuevoEntorno({ modulos: ['proveedores.js'], dom: convDom(), dbExtra: { async guardarLotePago() { return true; } } });
  e.sembrar({ Franco: { 'USD cash': 5000, 'USDT': 0 } });
  Object.assign(e.mod.Proveedores, { renderKpis() {}, renderContent() {} });
  await e.mod.Proveedores._confirmarConversion(1);
  check('Conversión OK: salen 1.000 USD y entran 980 USDT (comisión 2%) en una sola operación',
    e.base['Franco||USD cash'] === 4000 && e.base['Franco||USDT'] === 980, JSON.stringify(e.base));
}
{
  const e = nuevoEntorno({ modulos: ['proveedores.js'], dom: convDom(), fallaEscritura: (p, b) => b === 'USDT',
    dbExtra: { async guardarLotePago() { e.lotes = (e.lotes || 0) + 1; return true; } } });
  e.sembrar({ Franco: { 'USD cash': 5000, 'USDT': 0 } });
  Object.assign(e.mod.Proveedores, { renderKpis() {}, renderContent() {} });
  await e.mod.Proveedores._confirmarConversion(1);
  check('Conversión con la pata USDT rechazada: no se anota en el lote y los USD NO salen de la caja',
    !e.lotes && e.base['Franco||USD cash'] === 5000 && e.base['Franco||USDT'] === 0, JSON.stringify(e.base));
}
{
  const e = nuevoEntorno({ modulos: ['reparaciones.js'], dom: { 'rep-p-monto': '80000', 'rep-p-persona': 'Franco', 'rep-p-bolsillo': 'ARS cash' },
    dbExtra: { async agregarPagoReparacion() { return false; } } });
  e.sembrar({ Franco: { 'ARS cash': 0 } });
  Object.assign(e.mod.Reparaciones, { renderDetail() {}, currentId: 'R1' });
  e.State.reparaciones = [{ id: 'R1', pagos: [] }];
  await e.mod.Reparaciones.submitAddPago();
  check('Cobro de reparación que no se pudo guardar: la plata se saca de la caja y el pago NO queda en la orden',
    e.base['Franco||ARS cash'] === 0 && e.State.reparaciones[0].pagos.length === 0 && e.toasts.some(t => t.includes('se sacó la plata')),
    JSON.stringify([e.base, e.toasts]));
}
{
  const e = nuevoEntorno({ modulos: ['reparaciones.js'], dom: { 'rep-p-monto': '80000', 'rep-p-persona': 'Franco', 'rep-p-bolsillo': 'ARS cash' },
    fallaEscritura: () => true, dbExtra: { async agregarPagoReparacion() { e.guardados = (e.guardados || 0) + 1; return true; } } });
  e.sembrar({ Franco: { 'ARS cash': 0 } });
  Object.assign(e.mod.Reparaciones, { renderDetail() {}, currentId: 'R1' });
  e.State.reparaciones = [{ id: 'R1', pagos: [] }];
  await e.mod.Reparaciones.submitAddPago();
  check('Cobro de reparación con la caja rechazando: no se anota ningún pago',
    !e.guardados && e.State.reparaciones[0].pagos.length === 0);
}

// 28. Anular una venta: si la venta no se puede borrar de la base, NO se toca el stock y se puede repetir sin devolver dos veces
{
  let borradoOk = false, stockEscrito = 0;
  const e = nuevoEntorno({ modulos: ['stock.js', 'ventas.js'],
    dbExtra: { async anularVenta() { return borradoOk; }, async cancelarDeudaDeVenta() { return []; },
               async actualizarCantidadStock() { stockEscrito++; return true; }, async actualizarImeisStock() { return true; },
               async actualizarEstadoInventario() { return true; }, async buscarStockTradeInDeVenta() { return []; } } });
  e.sembrar({ Franco: { 'USD cash': 600 } });
  Object.assign(e.mod.Ventas, { renderList() {}, closeModal() {} });
  Object.assign(e.State, { stock: [{ id: 1, nombre: 'iPhone', cantidad: 0, cantidadDeclarada: 0, estadoInventario: 'vendido' }] });
  e.State.ventas = [{ id: 7, estado: 'cerrada', cliente: 'x', items: [{ precio: 600, stockId: 1 }], pagos: [{ id: 31, persona: 'Franco', bolsillo: 'USD cash', monto: 600 }] }];
  await e.mod.Ventas.anular(7);
  check('Anular y la base no borra la venta: la plata ya volvió, el stock NO se tocó todavía y el aviso dice que se puede repetir sin duplicar',
    e.base['Franco||USD cash'] === 0 && stockEscrito === 0 && e.State.ventas.length === 1 && e.toasts.some(t => t.includes('la plata no se devuelve dos veces')), JSON.stringify(e.toasts));
  borradoOk = true;
  await e.mod.Ventas.anular(7);
  check('… al repetir: la caja sigue en 0 (no se devolvió dos veces), la venta se borra y el stock se repone una vez',
    e.base['Franco||USD cash'] === 0 && e.State.ventas.length === 0 && e.State.stock[0].cantidad === 1 && cuadra(e.base, e.libro).length === 0,
    JSON.stringify({ base: e.base, st: e.State.stock[0] }));
  // Lo mismo después de RECARGAR: pantalla nueva (sin lo que la anterior recordaba), misma base.
  const srv = e.servidor;
  let borrado2 = false;
  const r = nuevoEntorno({ servidor: srv, modulos: ['stock.js', 'ventas.js'],
    dbExtra: { async anularVenta() { return borrado2; }, async cancelarDeudaDeVenta() { return []; }, async actualizarCantidadStock() { return true; },
               async actualizarImeisStock() { return true; }, async actualizarEstadoInventario() { return true; }, async buscarStockTradeInDeVenta() { return []; } } });
  r.sembrar({ Franco: { 'USD cash': 0 } }, { soloPantalla: true });
  Object.assign(r.mod.Ventas, { renderList() {}, closeModal() {} });
  r.State.stock = [{ id: 2, nombre: 'otro', cantidad: 0, cantidadDeclarada: 0, estadoInventario: 'vendido' }];
  r.State.ventas = [{ id: 8, estado: 'cerrada', cliente: 'y', items: [{ precio: 500, stockId: 2 }], pagos: [{ id: 91, persona: 'Franco', bolsillo: 'USD cash', monto: 500 }] }];
  srv.base['Franco||USD cash'] = 500;   // la base ya tiene el cobro de esta venta
  await r.mod.Ventas.anular(8);       // devuelve 500, no puede borrar
  const trasPrimero = srv.base['Franco||USD cash'];
  // «recarga»: otra pantalla, misma base y misma venta
  const r2 = nuevoEntorno({ servidor: srv, modulos: ['stock.js', 'ventas.js'],
    dbExtra: { async anularVenta() { return true; }, async cancelarDeudaDeVenta() { return []; }, async actualizarCantidadStock() { return true; },
               async actualizarImeisStock() { return true; }, async actualizarEstadoInventario() { return true; }, async buscarStockTradeInDeVenta() { return []; } } });
  r2.sembrar({ Franco: { 'USD cash': trasPrimero } }, { soloPantalla: true });
  Object.assign(r2.mod.Ventas, { renderList() {}, closeModal() {} });
  r2.State.stock = [{ id: 2, nombre: 'otro', cantidad: 0, cantidadDeclarada: 0, estadoInventario: 'vendido' }];
  r2.State.ventas = [{ id: 8, estado: 'cerrada', cliente: 'y', items: [{ precio: 500, stockId: 2 }], pagos: [{ id: 91, persona: 'Franco', bolsillo: 'USD cash', monto: 500 }] }];
  await r2.mod.Ventas.anular(8);
  check('Anular, recargar la página y repetir: la caja baja UNA sola vez (500 → 0, no −500)',
    trasPrimero === 0 && srv.base['Franco||USD cash'] === 0 && r2.State.ventas.length === 0, JSON.stringify({ trasPrimero, base: srv.base }));
}

// 29. Reversiones con clave estable: el registro falla DESPUÉS de devolver la plata y se repite
{
  // 29a. Eliminar un pago de una venta
  let borrarOk = false;
  const e = nuevoEntorno({ modulos: ['stock.js', 'ventas.js'], dbExtra: { async eliminarPagoVenta() { return borrarOk; }, async actualizarEstadoVenta() {} } });
  e.sembrar({ Franco: { 'USD cash': 600 } });
  Object.assign(e.mod.Ventas, { renderList() {}, viewSale() {} });
  e.State.ventas = [{ id: 7, estado: 'cerrada', items: [{ precio: 600 }], pagos: [{ id: 3, persona: 'Franco', bolsillo: 'USD cash', monto: 600 }] }];
  await e.mod.Ventas.eliminarPago(7, 3);
  check('Eliminar pago y el registro no se borra: la plata salió UNA vez, el pago sigue y el aviso dice que se repite sin duplicar',
    e.base['Franco||USD cash'] === 0 && e.State.ventas[0].pagos.length === 1 && e.toasts.some(t => t.includes('no se descuenta dos veces')), JSON.stringify({ base: e.base, t: e.toasts }));
  borrarOk = true;
  await e.mod.Ventas.eliminarPago(7, 3);
  check('… al repetir: la caja sigue en 0 (NO −600) y el pago se borra',
    e.base['Franco||USD cash'] === 0 && e.State.ventas[0].pagos.length === 0, JSON.stringify(e.base));
}
{
  // 29b. Eliminar un gasto
  let borrarOk = false;
  const e = nuevoEntorno({ modulos: ['gastos.js'], dbExtra: { async eliminarGasto() { return borrarOk; } } });
  e.sembrar({ Franco: { 'USD cash': 100 } });
  Object.assign(e.mod.Gastos, { close() {}, renderChips() {}, renderKpis() {}, renderTable() {} });
  e.State.gastos = [{ id: 5, motivo: 'Luz', caja: 'Franco-USD cash', monto: 40, estado: 'pagado', moneda: 'USD' }];
  await e.mod.Gastos.deleteGasto(5);
  const tras1 = e.base['Franco||USD cash'];
  borrarOk = true;
  await e.mod.Gastos.deleteGasto(5);
  check('Eliminar gasto: si el registro no se borra y se repite, la plata vuelve UNA vez (100 → 140, no 180)',
    tras1 === 140 && e.base['Franco||USD cash'] === 140 && e.State.gastos.length === 0, JSON.stringify({ tras1, base: e.base }));
}
{
  // 29c. Deshacer una operación de cueva
  let borrarOk = false;
  const e = nuevoEntorno({ modulos: ['cueva.js'], dbExtra: { async eliminarCambio() { return borrarOk; } } });
  e.sembrar({ Franco: { 'USD cash': 0, 'ARS cash': 1000000 } });
  Object.assign(e.mod.Cueva, { close() {}, renderTable() {} });
  e.State.cambios = [{ id: 11, entrega: 100, recibe: 100000, origenP: 'Franco', origenB: 'USD cash', destinoP: 'Franco', destinoB: 'ARS cash' }];
  await e.mod.Cueva.deleteOp(11);
  const tras1 = JSON.stringify(e.base);
  borrarOk = true;
  await e.mod.Cueva.deleteOp(11);
  check('Deshacer cueva: si el registro no se borra y se repite, las dos cajas se mueven UNA vez',
    tras1 === JSON.stringify({ 'Franco||USD cash': 100, 'Franco||ARS cash': 900000 }) && JSON.stringify(e.base) === tras1 && e.State.cambios.length === 0, JSON.stringify({ tras1, base: e.base }));
}
{
  // 29d. Reparación: cancelar, repetir tras fallo al marcar la orden
  let marcaOk = false, stockEscrito = 0, limpiezas = 0;
  const e = nuevoEntorno({ modulos: ['reparaciones.js'], dbExtra: { async limpiarMovimientosReparacion() { limpiezas++; return true; },
    async actualizarReparacion() { return marcaOk; }, async actualizarCantidadStock() { stockEscrito++; return true; } } });
  e.sembrar({ Franco: { 'ARS cash': 80000 } });
  Object.assign(e.mod.Reparaciones, { renderList() {}, renderDetail() {}, currentId: 'R1' });
  e.State.stock = [{ id: 4, nombre: 'pantalla', cantidad: 2 }];
  e.State.reparaciones = [{ id: 'R1', estado: 'en_curso', pagos: [{ id: 1, persona: 'Franco', bolsillo: 'ARS cash', monto: 50000 }, { id: 2, persona: 'Franco', bolsillo: 'ARS cash', monto: 30000 }],
    repuestos: [{ fromStock: true, stockId: 4, nombre: 'pantalla' }] }];
  await e.mod.Reparaciones.cancelarConReversion();
  check('Cancelar reparación y no se puede marcar la orden: la plata volvió, el stock NO se tocó y la orden sigue en curso',
    e.base['Franco||ARS cash'] === 0 && stockEscrito === 0 && limpiezas === 0 && e.State.stock[0].cantidad === 2 && e.State.reparaciones[0].estado === 'en_curso' && e.State.reparaciones[0].pagos.length === 2,
    JSON.stringify({ base: e.base, stockEscrito, o: e.State.reparaciones[0] }));
  marcaOk = true;
  await e.mod.Reparaciones.cancelarConReversion();
  check('… al repetir: la caja sigue en 0 (no se devolvió dos veces), el stock sube UNA vez (3) y la orden queda rechazada',
    e.base['Franco||ARS cash'] === 0 && e.State.stock[0].cantidad === 3 && e.State.reparaciones[0].estado === 'rechazado' && stockEscrito === 1,
    JSON.stringify({ base: e.base, st: e.State.stock[0], o: e.State.reparaciones[0] }));
}
{
  // 29e. Una clave estable CANCELADA (la base dudó y la cerró): el reintento usa una clave nueva y la plata se mueve igual
  const e = nuevoEntorno({ modulos: ['gastos.js'], dbExtra: { async eliminarGasto() { return true; } } });
  e.sembrar({ Franco: { 'USD cash': 100 } });
  Object.assign(e.mod.Gastos, { close() {}, renderChips() {}, renderKpis() {}, renderTable() {} });
  e.servidor.claves.set('gasto-eliminar-5', { cancelada: true });
  e.State.gastos = [{ id: 5, motivo: 'Luz', caja: 'Franco-USD cash', monto: 40, estado: 'pagado', moneda: 'USD' }];
  await e.mod.Gastos.deleteGasto(5);
  check('Reversión cuya clave estable había quedado cancelada: se reintenta con una clave nueva y la plata vuelve (100 → 140)',
    e.base['Franco||USD cash'] === 140 && e.State.gastos.length === 0, JSON.stringify({ base: e.base, t: e.toasts }));
}

{
  // 29f. «Eliminar pago» fallido y después «Anular»: el mismo pago NO se saca dos veces (misma clave)
  let borrarOk = false, anulada = false;
  const e = nuevoEntorno({ modulos: ['stock.js', 'ventas.js'], dbExtra: { async eliminarPagoVenta() { return borrarOk; }, async actualizarEstadoVenta() {},
    async anularVenta() { anulada = true; return true; }, async cancelarDeudaDeVenta() { return []; }, async actualizarCantidadStock() { return true; },
    async actualizarImeisStock() { return true; }, async actualizarEstadoInventario() { return true; }, async buscarStockTradeInDeVenta() { return []; } } });
  e.sembrar({ Franco: { 'USD cash': 1100 } });
  Object.assign(e.mod.Ventas, { renderList() {}, viewSale() {}, closeModal() {} });
  e.State.stock = [];
  e.State.ventas = [{ id: 7, estado: 'cerrada', items: [{ precio: 100 }], pagos: [{ id: 3, persona: 'Franco', bolsillo: 'USD cash', monto: 100 }] }];
  await e.mod.Ventas.eliminarPago(7, 3);      // debita 100 y no puede borrar el registro
  await e.mod.Ventas.anular(7);               // anular el mismo pago: NO debe sacarlo de nuevo
  check('Eliminar pago fallido y luego Anular la venta: el pago sale de la caja UNA vez (1100 → 1000, no 900)',
    e.base['Franco||USD cash'] === 1000 && anulada, JSON.stringify(e.base));
}
{
  // 29g. Reparación: un cobro NUEVO e idéntico después de una cancelación fallida NO hereda la clave del viejo
  let marcaOk = false;
  const e = nuevoEntorno({ modulos: ['reparaciones.js'], dbExtra: { async limpiarMovimientosReparacion() { return true; },
    async actualizarReparacion() { return marcaOk; }, async actualizarCantidadStock() { return true; }, async agregarPagoReparacion() { return 99; } } });
  e.sembrar({ Franco: { 'ARS cash': 100 } });
  Object.assign(e.mod.Reparaciones, { renderList() {}, renderDetail() {}, currentId: 'R1' });
  e.State.reparaciones = [{ id: 'R1', estado: 'en_curso', pagos: [{ id: 1, persona: 'Franco', bolsillo: 'ARS cash', monto: 100 }], repuestos: [] }];
  await e.mod.Reparaciones.cancelarConReversion();      // devuelve 100 (caja 0); no puede marcar la orden
  // «recarga»: la orden sigue activa, sin pagos; llega un cobro nuevo idéntico (id 99)
  e.State.reparaciones[0].pagos = [{ id: 99, persona: 'Franco', bolsillo: 'ARS cash', monto: 100 }];
  e.servidor.base['Franco||ARS cash'] = 100;            // el cobro nuevo entró a la caja
  marcaOk = true;
  await e.mod.Reparaciones.cancelarConReversion();
  check('Cobro nuevo idéntico tras una cancelación fallida: la 2ª cancelación SÍ lo saca de la caja (queda en 0)',
    e.base['Franco||ARS cash'] === 0 && e.State.reparaciones[0].estado === 'rechazado', JSON.stringify(e.base));
}
{
  // 29h. Reparación: el stock se repone ANTES de borrar los repuestos de la base, y si falla se avisa
  const orden = [];
  const e = nuevoEntorno({ modulos: ['reparaciones.js'], dbExtra: { async limpiarMovimientosReparacion() { orden.push('limpiar'); return true; },
    async actualizarReparacion() { orden.push('marcar'); return true; }, async actualizarCantidadStock() { orden.push('stock'); return false; } } });
  e.sembrar({ Franco: { 'ARS cash': 0 } });
  Object.assign(e.mod.Reparaciones, { renderList() {}, renderDetail() {}, currentId: 'R1' });
  e.State.stock = [{ id: 4, nombre: 'pantalla', cantidad: 2 }];
  e.State.reparaciones = [{ id: 'R1', estado: 'en_curso', pagos: [], repuestos: [{ fromStock: true, stockId: 4, nombre: 'pantalla' }] }];
  await e.mod.Reparaciones.cancelarConReversion();
  check('Cancelar reparación: orden de pasos marcar → stock → limpiar, y si el stock no se guarda avisa (cantidad vuelve a 2)',
    orden.join(',') === 'marcar,stock,limpiar' && e.State.stock[0].cantidad === 2 && e.toasts.some(t => t.includes('sumale 1 a mano')), JSON.stringify({ orden, t: e.toasts }));
}
{
  // 29h2. Reparación: si la limpieza falló y se repite «Cancelar», el stock NO se suma de nuevo
  let limpiaOk = false;
  const e = nuevoEntorno({ modulos: ['reparaciones.js'], dbExtra: { async limpiarMovimientosReparacion() { return limpiaOk; },
    async actualizarReparacion() { return true; }, async actualizarCantidadStock() { return true; } } });
  e.sembrar({ Franco: { 'ARS cash': 0 } });
  Object.assign(e.mod.Reparaciones, { renderList() {}, renderDetail() {}, currentId: 'R1' });
  e.State.stock = [{ id: 4, nombre: 'pantalla', cantidad: 2 }];
  e.State.reparaciones = [{ id: 'R1', estado: 'en_curso', pagos: [], repuestos: [{ fromStock: true, stockId: 4, nombre: 'pantalla' }] }];
  await e.mod.Reparaciones.cancelarConReversion();
  limpiaOk = true;
  await e.mod.Reparaciones.cancelarConReversion();
  check('Cancelar reparación con la limpieza fallida y repetir: el stock sube UNA vez (3, no 4)', e.State.stock[0].cantidad === 3, JSON.stringify(e.State.stock[0]));
}
{
  // 29i. Anular: si la deuda a plazos no se pudo cancelar tras borrar la venta, se avisa
  const e = nuevoEntorno({ modulos: ['stock.js', 'ventas.js'], dbExtra: { async anularVenta() { return true; }, async cancelarDeudaDeVenta() { return null; },
    async actualizarCantidadStock() { return true; }, async actualizarImeisStock() { return true; }, async actualizarEstadoInventario() { return true; }, async buscarStockTradeInDeVenta() { return []; } } });
  e.sembrar({ Franco: { 'USD cash': 100 } });
  Object.assign(e.mod.Ventas, { renderList() {}, closeModal() {} });
  e.State.stock = [];
  e.State.ventas = [{ id: 9, estado: 'cerrada', items: [{ precio: 100 }], pagos: [{ id: 5, persona: 'Franco', bolsillo: 'USD cash', monto: 100 }] }];
  await e.mod.Ventas.anular(9);
  check('Anular con la deuda a plazos que no se pudo cancelar: avisa que sigue cobrable', e.toasts.some(t => t.includes('sigue cobrable')), JSON.stringify(e.toasts));
}

{
  // 29j. Proveedores: los dos caminos de reverso comparten clave y piden el MISMO importe; cancelar incluye devoluciones
  let estadoOk = true;
  const e = nuevoEntorno({ modulos: ['proveedores.js'], dbExtra: { async eliminarLotePago() { return false; }, async actualizarEstadoLote() { return estadoOk; }, async eliminarProveedorCredito() { return true; } } });
  e.sembrar({ Franco: { 'ARS cash': 500000, 'USD cash': 1000 } });
  e.State.refBlue = 1000;
  Object.assign(e.mod.Proveedores, { renderContent() {}, renderKpis() {} });
  e.State.lotesCompra = [{ id: 1, estado: 'pendiente' }];
  e.State.proveedorCreditos = [];
  e.State.lotePagos = [
    { id: 10, loteId: 1, tipo: 'pago_proveedor', moneda: 'ARS', montoUsd: 100, montoUsdt: 0, persona: 'Franco', bolsillo: 'ARS cash' },
    { id: 11, loteId: 1, tipo: 'devolucion', moneda: 'USD', montoUsd: 50, montoUsdt: 0, persona: 'Franco', bolsillo: 'USD cash' },
  ];
  await e.mod.Proveedores.revertirMovimientoLote(1, 10);   // devuelve 100.000 ARS; el borrado del pago falla
  const tras1 = e.base['Franco||ARS cash'];
  await e.mod.Proveedores.cancelarLote(1);                 // misma clave, mismo importe: NO se devuelve de nuevo; la devolución USD sí se descuenta
  check('Revertir un pago de lote (falla el borrado) y luego cancelar la orden: el pago ARS vuelve UNA vez (600.000) y la devolución se descuenta (USD 950)',
    tras1 === 600000 && e.base['Franco||ARS cash'] === 600000 && e.base['Franco||USD cash'] === 950, JSON.stringify({ tras1, base: e.base, t: e.toasts }));
}

{
  // 29k. Sin la migración, una reversión con clave estable se BLOQUEA (el camino viejo no es idempotente)
  const e = nuevoEntorno({ legacy: true, modulos: ['gastos.js'], dbExtra: { async eliminarGasto() { return true; } } });
  e.sembrar({ Franco: { 'USD cash': 100 } });
  Object.assign(e.mod.Gastos, { close() {}, renderChips() {}, renderKpis() {}, renderTable() {} });
  e.State.gastos = [{ id: 5, motivo: 'Luz', caja: 'Franco-USD cash', monto: 40, estado: 'pagado', moneda: 'USD' }];
  await e.mod.Gastos.deleteGasto(5);
  check('Sin la migración: eliminar un gasto (clave estable) NO mueve plata ni borra el gasto, y explica por qué',
    e.base['Franco||USD cash'] === 100 && e.State.gastos.length === 1 && e.toasts.some(t => t.includes('necesita la migración')), JSON.stringify({ b: e.base, t: e.toasts }));
}

// 31. STOCK POR DELTA en ventas.js (stock_ajustar): no pisa lo que movió otro, y no se reintenta a ciegas
const entornoVenta = (extra = {}, cfg = {}) => {
  const e = nuevoEntorno({ modulos: ['stock.js', 'ventas.js'], ...cfg,
    dbExtra: { async crearVenta() { return 500; }, async actualizarImeisStock() { return true; }, async actualizarCantidadStock() { return true; },
               async actualizarEstadoInventario() { return true; }, async cancelarDeudaDeVenta() { return []; }, async buscarStockTradeInDeVenta() { return []; },
               async anularVenta() { return true; }, ...extra } });
  e.sembrar({ Franco: { 'USD cash': 0 }, Lautaro: { 'USD cash': 0 } });
  Object.assign(e.mod.Ventas, { closeModal() {}, renderList() {}, draft: ventaBase() });
  return e;
};
{
  // a) Mercado Libre (o la otra pestaña) descuenta en la base mientras esta pantalla tiene la copia vieja
  const e = entornoVenta();
  Object.assign(e.State, { stock: [{ id: 1, nombre: 'iPhone 15', cat: 'iphone', cantidad: 5, cantidadDeclarada: 5, costoUSD: 800, estadoInventario: 'disponible' }], ventas: [], garantias: [] });
  e.servidor.stock[1] = { cantidad: 4, imeis: [], estado: 'disponible' };     // alguien ya había descontado: la base tiene 4
  await e.mod.Ventas._confirmSale();
  check('Stock por delta: la base tenía 4 (alguien descontó) y esta venta la deja en 3, NO en 4 como habría escrito la copia vieja',
    e.servidor.stock[1].cantidad === 3, JSON.stringify(e.servidor.stock));
  check('… y la pantalla se refresca con lo que respondió la base: cantidad y cantidadDeclarada en 3',
    e.State.stock[0].cantidad === 3 && e.State.stock[0].cantidadDeclarada === 3 && e.State.getStock(e.State.stock[0]) === 3, JSON.stringify(e.State.stock[0]));
}
{
  // b) Última unidad: la base la deja en 0 y 'vendido'; la pantalla lo refleja
  const e = entornoVenta();
  Object.assign(e.State, { stock: [{ id: 1, nombre: 'iPhone 15', cat: 'iphone', cantidad: 1, cantidadDeclarada: 1, costoUSD: 800, estadoInventario: 'disponible' }], ventas: [], garantias: [] });
  await e.mod.Ventas._confirmSale();
  check('Última unidad: la base queda en 0 y vendido, y la pantalla igual', e.servidor.stock[1].estado === 'vendido' && e.State.stock[0].estadoInventario === 'vendido' && e.State.getStock(e.State.stock[0]) === 0,
    JSON.stringify({ srv: e.servidor.stock, st: e.State.stock[0] }));
}
{
  // c) Con IMEI: sale ese IMEI del arreglo de la base
  const e = entornoVenta();
  e.mod.Ventas.draft.items = [{ nombre: 'iPhone 15', precio: 1000, costo: 800, stockId: 1, imei: '111' }];
  Object.assign(e.State, { stock: [{ id: 1, nombre: 'iPhone 15', cat: 'iphone', cantidad: 2, cantidadDeclarada: 2, imeis: ['111', '222'], costoUSD: 800, estadoInventario: 'disponible' }], ventas: [], garantias: [] });
  await e.mod.Ventas._confirmSale();
  check('Venta con IMEI: la base saca el 111, queda el 222 y la pantalla lo muestra', JSON.stringify(e.servidor.stock[1].imeis) === '["222"]' && JSON.stringify(e.State.stock[0].imeis) === '["222"]',
    JSON.stringify({ srv: e.servidor.stock, st: e.State.stock[0] }));
}
{
  // d) La base rechaza (no alcanza): la venta sigue, se avisa por qué, y nada se descuenta
  const e = entornoVenta();
  Object.assign(e.State, { stock: [{ id: 1, nombre: 'iPhone 15', cat: 'iphone', cantidad: 1, cantidadDeclarada: 1, costoUSD: 800, estadoInventario: 'disponible' }], ventas: [], garantias: [] });
  e.servidor.stock[1] = { cantidad: 0, imeis: [], estado: 'vendido' };      // en la base ya se vendió
  await e.mod.Ventas._confirmSale();
  check('Stock agotado en la base: la venta se guarda, avisa "no alcanza el stock" y no descuenta de más',
    e.State.ventas.length === 1 && e.toasts.some(t => t.includes('no alcanza el stock')) && e.servidor.stock[1].cantidad === 0, JSON.stringify({ t: e.toasts, srv: e.servidor.stock }));
}
{
  // e) Respuesta perdida: NO se reintenta y se avisa que no se pudo confirmar
  const e = entornoVenta({}, { stockRed: 'perdida' });
  Object.assign(e.State, { stock: [{ id: 1, nombre: 'iPhone 15', cat: 'iphone', cantidad: 3, cantidadDeclarada: 3, costoUSD: 800, estadoInventario: 'disponible' }], ventas: [], garantias: [] });
  await e.mod.Ventas._confirmSale();
  check('Respuesta de stock perdida: UN solo pedido (sin reintento), la base quedó en 2 (se aplicó) y se avisa "no se pudo CONFIRMAR"',
    e.servidor.stockLlamadas.length === 1 && e.servidor.stock[1].cantidad === 2 && e.toasts.some(t => t.includes('CONFIRMAR')), JSON.stringify({ n: e.servidor.stockLlamadas.length, srv: e.servidor.stock, t: e.toasts }));
}
{
  // f) Falta la función en Supabase: mensaje claro, la venta no descuenta a ciegas
  const e = entornoVenta({}, { stockSinRpc: true });
  Object.assign(e.State, { stock: [{ id: 1, nombre: 'iPhone 15', cat: 'iphone', cantidad: 3, cantidadDeclarada: 3, costoUSD: 800, estadoInventario: 'disponible' }], ventas: [], garantias: [] });
  await e.mod.Ventas._confirmSale();
  check('Sin stock_ajustar en Supabase: avisa que falta correrla y la copia en pantalla NO se toca (3)',
    e.toasts.some(t => t.includes('falta correr stock_ajustar')) && e.State.stock[0].cantidad === 3, JSON.stringify({ t: e.toasts, st: e.State.stock[0] }));
}
{
  // g) La venta no se pudo guardar: la unidad vuelve por delta (+1 sobre el valor real de la base)
  const e = entornoVenta({ async crearVenta() { return null; } });
  Object.assign(e.State, { stock: [{ id: 1, nombre: 'iPhone 15', cat: 'iphone', cantidad: 5, cantidadDeclarada: 5, costoUSD: 800, estadoInventario: 'disponible' }], ventas: [], garantias: [] });
  e.servidor.stock[1] = { cantidad: 4, imeis: [], estado: 'disponible' };    // Mercado Libre ya había descontado una
  await e.mod.Ventas._confirmSale();
  check('Venta que no se guardó: el stock vuelve a 4 (lo que tenía la base antes de este intento), no a 5',
    e.servidor.stock[1].cantidad === 4 && e.State.stock[0].cantidad === 4, JSON.stringify({ srv: e.servidor.stock, st: e.State.stock[0] }));
}
{
  // h) Anular: repone UNA vez por delta; y si otra pestaña ya la había anulado, esta NO repone
  let yaBorrada = false;
  const e = entornoVenta({ async anularVenta() { return yaBorrada ? 'ya_borrada' : true; } });
  Object.assign(e.State, { stock: [{ id: 1, nombre: 'iPhone 15', cat: 'iphone', cantidad: 0, cantidadDeclarada: 0, costoUSD: 800, estadoInventario: 'vendido' }], garantias: [] });
  e.servidor.stock[1] = { cantidad: 0, imeis: [], estado: 'vendido' };
  e.State.ventas = [{ id: 7, estado: 'cerrada', cliente: 'x', items: [{ precio: 600, stockId: 1 }], pagos: [{ id: 31, persona: 'Franco', bolsillo: 'USD cash', monto: 0.01 }] }];
  e.servidor.base['Franco||USD cash'] = 0.01;
  await e.mod.Ventas.anular(7);
  check('Anular: la base sube de 0 a 1, pasa de vendido a disponible y la pantalla igual',
    e.servidor.stock[1].cantidad === 1 && e.servidor.stock[1].estado === 'disponible' && e.State.stock[0].cantidad === 1 && e.State.stock[0].estadoInventario === 'disponible', JSON.stringify({ srv: e.servidor.stock, st: e.State.stock[0] }));
  // otra pestaña con la misma venta cargada
  e.State.ventas = [{ id: 7, estado: 'cerrada', cliente: 'x', items: [{ precio: 600, stockId: 1 }], pagos: [{ id: 31, persona: 'Franco', bolsillo: 'USD cash', monto: 0.01 }] }];
  yaBorrada = true;
  await e.mod.Ventas.anular(7);
  check('Anular una venta que otra pestaña ya anuló: NO repone otra vez (la base sigue en 1) y avisa que se concilie a mano',
    e.servidor.stock[1].cantidad === 1 && e.toasts.some(t => t.includes('NO se tocó')), JSON.stringify({ srv: e.servidor.stock, t: e.toasts }));
}
{
  // i) Anular un producto que quedó 'reservado' para esa venta: se repone y se libera la reserva
  const e = entornoVenta();
  Object.assign(e.State, { stock: [{ id: 1, nombre: 'iPhone 15', cat: 'iphone', cantidad: 0, cantidadDeclarada: 0, costoUSD: 800, estadoInventario: 'reservado' }], garantias: [] });
  e.servidor.stock[1] = { cantidad: 0, imeis: [], estado: 'reservado' };
  e.State.ventas = [{ id: 7, estado: 'abierta', cliente: 'x', items: [{ precio: 600, stockId: 1 }], pagos: [{ id: 31, persona: 'Franco', bolsillo: 'USD cash', monto: 0.01 }] }];
  e.servidor.base['Franco||USD cash'] = 0.01;
  await e.mod.Ventas.anular(7);
  check('Anular con el producto reservado para esa venta: la reserva se libera (disponible)', e.servidor.stock[1].estado === 'disponible' && e.State.stock[0].estadoInventario === 'disponible', JSON.stringify(e.servidor.stock));
}

// 30. Altas: si el registro no se puede crear, NO se toca la caja (o se deshace)
{
  const e = nuevoEntorno({ modulos: ['gastos.js'], dom: { 'gf-motivo': 'Alquiler', 'gf-monto': '50', 'gf-caja-persona': 'Franco', 'gf-caja-bolsillo': 'USD cash', 'gf-moneda': 'USD', 'gf-cat': 'x', 'gf-resp': 'Franco' },
    dbExtra: { async crearGasto() { return null; } } });
  e.sembrar({ Franco: { 'USD cash': 100 } });
  Object.assign(e.mod.Gastos, { close() {}, renderChips() {}, renderKpis() {}, renderTable() {}, mesActual: '2026-10' });
  e.State.gastos = [];
  await e.mod.Gastos.save();
  check('Alta de gasto cuyo registro no se crea: la caja NO se toca y no queda gasto', e.base['Franco||USD cash'] === 100 && e.State.gastos.length === 0 && e.servidor.llamadas === 0);
}
{
  const e = nuevoEntorno({ modulos: ['cueva.js'], dom: { 'cf-entrega': '100', 'cf-recibe': '100000', 'cf-cotiz': '1000', 'cf-origen-p': 'Franco', 'cf-origen-b': 'USD cash', 'cf-destino-p': 'Franco', 'cf-destino-b': 'ARS cash' },
    dbExtra: { async crearCambio() { return null; } } });
  e.sembrar({ Franco: { 'USD cash': 100, 'ARS cash': 0 } });
  Object.assign(e.mod.Cueva, { close() {}, renderTable() {}, opType: 'usd-ars' });
  e.State.cambios = [];
  await e.mod.Cueva.save();
  check('Alta de cueva cuyo registro no se crea: el movimiento de caja se deshace (100 / 0) y no queda operación',
    e.base['Franco||USD cash'] === 100 && e.base['Franco||ARS cash'] === 0 && e.State.cambios.length === 0 && cuadra(e.base, e.libro).length === 0, JSON.stringify(e.base));
}
{
  const e = nuevoEntorno({ modulos: ['adelantos.js'], dom: { 'cob-persona': 'Franco', 'cob-bolsillo': 'USD cash', 'cob-fecha': '2026-10-02' },
    dbExtra: { async cobrarAdelanto() { return false; } } });
  e.sembrar({ Franco: { 'USD cash': 100 } });
  Object.assign(e.mod.Adelantos, { closeModal() {} });
  e.State.adelantos = [{ id: 1, monto: 30, moneda: 'USD', estado: 'pendiente', concepto: 'x' }];
  await e.mod.Adelantos.confirmarCobro(1);
  check('Cobro de adelanto que no se puede marcar: la plata vuelve a la caja (100) y el adelanto sigue pendiente',
    e.base['Franco||USD cash'] === 100 && e.State.adelantos[0].estado === 'pendiente', JSON.stringify(e.base));
}

// ── Salida ───────────────────────────────────────────────────────────────
const w = Math.max(...casos.map(c => c[1].length));
casos.forEach(([est, n, d]) => {
  const marca = est === 'PASA' ? '  ok  ' : est === 'CONOCIDO' ? ' CONOC' : ' FALLA';
  console.log(`${marca} │ ${n.padEnd(w)} ${d ? '│ ' + d : ''}`);
});
console.log(`\n${ok} pasan, ${fail} fallan, ${conocidos} problemas conocidos de otras pantallas (sin arreglar)`);
process.exitCode = fail ? 1 : 0;
