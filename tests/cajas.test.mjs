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
// Consulta falsa estilo supabase-js: cualquier cadena de .select/.or/.in/.limit/.is/.eq termina en la respuesta.
const dormirTest = () => new Promise(r => setTimeout(r, 20));
// Como consultaFalsa pero respeta .eq('estado', X) / .neq('estado', X) sobre las filas (para la pantalla de actividades).
function consultaActividades(resp) {
  let filtro = null;
  const q = new Proxy({}, { get: (_, k) => {
    if (k === 'eq') return (c, v) => { filtro = r => r[c] === v; return q; };
    if (k === 'neq') return (c, v) => { filtro = r => r[c] !== v; return q; };
    if (k === 'then') return (ok, ko) => Promise.resolve(resp.error || !Array.isArray(resp.data) ? resp : { data: resp.data.filter(filtro || (() => true)), error: null }).then(ok, ko);
    return () => q;
  } });
  return q;
}
function consultaFalsa(resp) {
  const q = new Proxy({}, { get: (_, k) => (k === 'then' ? (ok, ko) => Promise.resolve(resp).then(ok, ko) : () => q) });
  return q;
}
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
    // ¿Están las columnas del script 14 (conversión con sobrante)? Por defecto sí; las pruebas lo cambian con cfg.columnasConversion.
    async columnasConversionListas() { return cfg.columnasConversion === undefined ? true : cfg.columnasConversion; },
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
    supa: { rpc: async (...a) => (cfg.supaRpc ? cfg.supaRpc(...a) : { data: null, error: { message: 'sin supa' } }),
            from: (...a) => (cfg.supaFrom ? cfg.supaFrom(...a) : consultaFalsa({ data: null, error: { message: 'sin supa' } })) },
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

  return { State, base, libro, toasts, sembrar, contadores, servidor, cfg, mod: ctx.window, dom, almacen, ctx };
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
  let marcaOk = false, limpiezas = 0;
  const e = nuevoEntorno({ modulos: ['reparaciones.js'], dbExtra: { async limpiarMovimientosReparacion() { limpiezas++; return true; },
    async actualizarReparacion() { return marcaOk; }, marcarRepuestosPendientes: async () => true, reclamarDevolucionRepuesto: async () => true, marcarDevolucionRepuesto: async () => true } });
  e.sembrar({ Franco: { 'ARS cash': 80000 } });
  Object.assign(e.mod.Reparaciones, { renderList() {}, renderDetail() {}, currentId: 'R1' });
  e.State.stock = [{ id: 4, nombre: 'pantalla', cantidad: 2 }];
  e.State.reparaciones = [{ id: 'R1', estado: 'en_curso', pagos: [{ id: 1, persona: 'Franco', bolsillo: 'ARS cash', monto: 50000 }, { id: 2, persona: 'Franco', bolsillo: 'ARS cash', monto: 30000 }],
    repuestos: [{ id: 91, fromStock: true, stockId: 4, nombre: 'pantalla' }] }];
  await e.mod.Reparaciones.cancelarConReversion();
  check('Cancelar reparación y no se puede marcar la orden: la plata volvió, el stock NO se tocó y la orden sigue en curso',
    e.base['Franco||ARS cash'] === 0 && e.servidor.stockLlamadas.length === 0 && limpiezas === 0 && e.State.stock[0].cantidad === 2 && e.State.reparaciones[0].estado === 'en_curso' && e.State.reparaciones[0].pagos.length === 2,
    JSON.stringify({ base: e.base, n: e.servidor.stockLlamadas.length, o: e.State.reparaciones[0] }));
  marcaOk = true;
  await e.mod.Reparaciones.cancelarConReversion();
  check('… al repetir: la caja sigue en 0 (no se devolvió dos veces), el stock sube UNA vez (3) y la orden queda rechazada',
    e.base['Franco||ARS cash'] === 0 && e.State.stock[0].cantidad === 3 && e.State.reparaciones[0].estado === 'rechazado' && e.servidor.stockLlamadas.length === 1,
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
    async actualizarReparacion() { return marcaOk; }, async actualizarCantidadStock() { return true; }, async agregarPagoReparacion() { return 99; },
    marcarRepuestosPendientes: async () => true, reclamarDevolucionRepuesto: async () => true, marcarDevolucionRepuesto: async () => true } });
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
  // 29h. Reparación: la orden se marca ANTES de tocar el stock y los repuestos se borran DESPUÉS de devolverlos
  let e, enMarca = -1, enLimpia = -1;
  e = nuevoEntorno({ modulos: ['reparaciones.js'], dbExtra: { async limpiarMovimientosReparacion() { enLimpia = e.servidor.stockLlamadas.length; return true; },
    async actualizarReparacion() { enMarca = e.servidor.stockLlamadas.length; return true; }, marcarRepuestosPendientes: async () => true, reclamarDevolucionRepuesto: async () => true, marcarDevolucionRepuesto: async () => true } });
  e.sembrar({ Franco: { 'ARS cash': 0 } });
  Object.assign(e.mod.Reparaciones, { renderList() {}, renderDetail() {}, currentId: 'R1' });
  e.State.stock = [{ id: 4, nombre: 'pantalla', cantidad: 2 }];
  e.State.reparaciones = [{ id: 'R1', estado: 'en_curso', pagos: [], repuestos: [{ id: 91, fromStock: true, stockId: 4, nombre: 'pantalla' }] }];
  await e.mod.Reparaciones.cancelarConReversion();
  check('Cancelar reparación: se marca la orden (0 ajustes de stock hechos), después se repone el stock y recién al final se limpian los repuestos',
    enMarca === 0 && enLimpia === 1 && e.State.stock[0].cantidad === 3, JSON.stringify({ enMarca, enLimpia, st: e.State.stock[0] }));
}
{
  // 29h2. Reparación: si la limpieza falló y se repite «Cancelar», el stock NO se suma de nuevo
  let limpiaOk = false;
  const e = nuevoEntorno({ modulos: ['reparaciones.js'], dbExtra: { async limpiarMovimientosReparacion() { return limpiaOk; },
    async actualizarReparacion() { return true; }, marcarRepuestosPendientes: async () => true, reclamarDevolucionRepuesto: async () => true, marcarDevolucionRepuesto: async () => true } });
  e.sembrar({ Franco: { 'ARS cash': 0 } });
  Object.assign(e.mod.Reparaciones, { renderList() {}, renderDetail() {}, currentId: 'R1' });
  e.State.stock = [{ id: 4, nombre: 'pantalla', cantidad: 2 }];
  e.State.reparaciones = [{ id: 'R1', estado: 'en_curso', pagos: [], repuestos: [{ id: 91, fromStock: true, stockId: 4, nombre: 'pantalla' }] }];
  await e.mod.Reparaciones.cancelarConReversion();
  limpiaOk = true;
  await e.mod.Reparaciones.cancelarConReversion();
  check('Cancelar reparación con la limpieza fallida y repetir: el stock sube UNA vez (3, no 4)', e.State.stock[0].cantidad === 3 && e.servidor.stockLlamadas.length === 1, JSON.stringify({ st: e.State.stock[0], n: e.servidor.stockLlamadas.length }));
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

// 32. MERCADO LIBRE en el CRM: costo del canal, totales por prefijo, cuenta corriente, bloqueos y pantalla
{
  const e = nuevoEntorno({ modulos: ['stock.js', 'ventas.js', 'cuentacorriente.js'] });
  const ml = { id: 50, estado: 'cerrada', tipoVenta: 'mercadolibre', meliOrdenId: 9, meliCotizacion: 1000, costoCanal: 15,
    items: [{ precio: 100, costo: 30 }], pagos: [{ monto: 85, persona: 'Franco', bolsillo: 'ARS Mercado Pago', cotizacionDiferencial: 1000 }] };
  const r = e.mod.Ventas.resultadoVenta(ml);
  check('Venta de Mercado Libre cerrada (100 USD, llegaron 85, costo del canal 15): NO hay quebranto y el margen comercial es 100−30−15 = 55',
    r.quebranto === 0 && r.costoCanal === 15 && r.margenComercial === 55 && r.margenReal === 55, JSON.stringify(r));
  const comun = e.mod.Ventas.resultadoVenta({ id: 51, estado: 'cerrada', items: [{ precio: 100, costo: 30 }], pagos: [{ monto: 85 }] });
  check('La misma venta SIN costo de canal sigue siendo quebranto de 15 (el cambio no altera las ventas comunes)', comun.quebranto === 15 && comun.margenComercial === 55 && comun.costoCanal === 0, JSON.stringify(comun));
  const abierta = e.mod.Ventas.resultadoVenta({ ...ml, estado: 'abierta', costoCanal: 0, pagos: [] });
  check('Venta de Mercado Libre abierta (sin acreditar): NO es plata que un cliente deba (pendiente 0, quebranto 0); el margen cuenta entero (70)',
    abierta.pendiente === 0 && abierta.quebranto === 0 && abierta.margenComercial === 70 && abierta.esMeli === true, JSON.stringify(abierta));
  const cv1 = e.mod.Ventas._cobroVisible({ tipoVenta: 'mercadolibre', estado: 'abierta', pagos: [] }, 100, 0);
  const cv2 = e.mod.Ventas._cobroVisible(ml, 100, 85);
  const cv3 = e.mod.Ventas._cobroVisible({ tipoVenta: 'minorista', estado: 'abierta', pagos: [] }, 100, 40);
  check('Saldo a mostrar: MELI sin acreditar = "a liberar" (no deuda); MELI acreditada con comisión 15 = pagada; venta común sigue debiendo 60',
    cv1.aLiberar === true && cv1.dif === 0 && cv2.dif === 0 && cv2.aLiberar === false && cv3.dif === -60, JSON.stringify({ cv1, cv2, cv3 }));

  e.State.ventas = [{ ...ml, estado: 'abierta', costoCanal: 0, pagos: [], cliente: 'c', clienteTel: '' }];
  check('Una venta de Mercado Libre abierta NO aparece como deuda en Cuenta Corriente', e.mod.CuentaCorriente.getClientesConDeuda().length === 0);
  e.State.ventas.push({ id: 52, estado: 'abierta', tipoVenta: 'minorista', cliente: 'Juan', clienteTel: '1', items: [{ precio: 100 }], pagos: [] });
  check('… pero una venta común abierta sí', e.mod.CuentaCorriente.getClientesConDeuda().length === 1);

  // Totales por prefijo: 'ARS Mercado Pago' entra en el total en pesos
  const sm = e.State.saldosPorMoneda({ 'ARS cash': 100, 'ARS transferencia': 50, 'ARS Mercado Pago': 1000, 'USD cash': 5, 'USDT': 7 });
  check('Los totales suman por prefijo: ARS = 100+50+1000 (incluye Mercado Pago), USD = 5, USDT = 7 (sin mezclar USDT en USD)', sm.ARS === 1150 && sm.USD === 5 && sm.USDT === 7, JSON.stringify(sm));
  e.State.cajas = { Franco: { 'ARS cash': 0, 'ARS Mercado Pago': 10 }, Lautaro: { 'ARS cash': 0 } };
  check('Un bolsillo nuevo aparece en la lista de bolsillos existentes (para Cueva, Cajas y Capital)', e.State.bolsillosExistentes().includes('ARS Mercado Pago') && e.State.bolsillosExistentes().length === 6);

  // Bloqueos: nada de cobrar, cerrar, borrar pagos ni anular una venta de Mercado Libre desde Ventas
  e.State.ventas = [{ ...ml, estado: 'abierta', pagos: [{ id: 1, monto: 1, persona: 'Franco', bolsillo: 'ARS Mercado Pago' }], items: [{ precio: 100, costo: 30 }] }];
  const antes = e.toasts.length;
  e.mod.Ventas.abrirCobro(50);
  await e.mod.Ventas.cerrarVentaManual(50);
  await e.mod.Ventas.eliminarPago(50, 1);
  await e.mod.Ventas.anular(50);
  check('Cobrar, cerrar, borrar un pago o anular una venta de Mercado Libre desde Ventas: bloqueado con aviso, y nada se movió',
    e.toasts.length - antes === 4 && e.toasts.slice(antes).every(t => t.includes('viene de Mercado Libre')) && e.State.ventas.length === 1 && e.servidor.llamadas === 0, JSON.stringify(e.toasts.slice(antes)));

  // Pendiente de liberar
  e.State.refBlue = 1000;
  e.State.meliOrdenes = [
    { id: 1, procesada: true, acreditado: false, revertidaEn: null, neto: 85000, financieraCompleta: true, ventaId: 50 },
    { id: 2, procesada: true, acreditado: false, revertidaEn: null, neto: null, financieraCompleta: false, ventaId: 50 },
    { id: 3, procesada: true, acreditado: true, revertidaEn: null, neto: 70000, financieraCompleta: true },
    { id: 4, procesada: true, acreditado: false, revertidaEn: '2026-10-01', neto: 70000, financieraCompleta: true },
    { id: 5, procesada: false, acreditado: false, revertidaEn: null, neto: 60000, financieraCompleta: true },
  ];
  const pl = e.State.meliPendienteLiberar();
  check('Pendiente de liberar: solo la orden procesada y sin acreditar/revertir (85.000 = 85 USD); la de neto desconocido NO suma 0, se cuenta aparte',
    pl.ars === 85000 && pl.usd === 85 && pl.ordenes === 2 && pl.sinDato === 1, JSON.stringify(pl));
}
{
  // La pantalla: llama a las funciones de la base con los argumentos correctos y traduce los errores
  const llamadas = [];
  const e = nuevoEntorno({ modulos: ['meli-ordenes.js'], dom: { 'meliord-monto-7': '85000', 'meliord-fin-7': false, 'meliord-cot-3': '1000', 'meliord-ok-3': true },
    dbExtra: { async cargarTodo() {}, async cargarMeliOrdenes() {} } });
  let respuesta = { data: { ok: true, ya_acreditada: false, monto: 85000, costo_canal_usd: 15 }, error: null };
  e.cfg.supaRpc = async (fn, args) => { llamadas.push({ fn, args }); return fn === 'meli_orden_revalidar' ? { data: { ok: true, revisar: false, sin_vincular: false, cerrada: false }, error: null } : respuesta; };
  e.State.meliOrdenes = [{ id: 7, orderId: 'ORD7', neto: 85000, bruto: 100000, procesada: true, acreditado: false, financieraCompleta: true, fechaLiberacion: '2020-01-01' }];
  await e.mod.MeliOrdenes.acreditar(7, null);
  check('Acreditar con el monto igual al neto informado: manda monto NULL (que la base use SU neto) y liquidación final falsa',
    llamadas.length === 1 && llamadas[0].fn === 'meli_acreditar_orden' && llamadas[0].args.p_monto_real === null && llamadas[0].args.p_liquidacion_final === false, JSON.stringify(llamadas));
  respuesta = { data: null, error: { message: 'MONTO_MENOR_AL_NETO' } };
  e.dom['meliord-monto-7'] = '80000';
  await e.mod.MeliOrdenes.acreditar(7, null);
  check('Un monto distinto se manda tal cual, y el error de la base se explica en castellano',
    llamadas[1].args.p_monto_real === 80000 && e.toasts.some(t => t.includes('liquidación final')), JSON.stringify({ l: llamadas[1], t: e.toasts }));
  respuesta = { data: { ok: false, motivo: 'Producto con IMEI: elegir la unidad a mano' }, error: null };
  e.State.meliOrdenes.push({ id: 3, orderId: 'ORD3', procesada: false, revisar: false });
  e.mod.MeliOrdenes._firmas[3] = e.mod.MeliOrdenes._firma(e.State.meliOrdenes.find(o => o.id === 3));   // como si se hubiera abierto el cuadro
  await e.mod.MeliOrdenes.procesar(3, null);
  check('Procesar una orden que la base deja en revisión: muestra el motivo (no dice que salió bien)',
    llamadas[3].fn === 'meli_procesar_orden' && llamadas[3].args.p_cotizacion === 1000 && e.toasts.some(t => t.includes('IMEI')), JSON.stringify({ l: llamadas[3], t: e.toasts }));
}

// 32b. CERRAR A MANO (script 12): «ya la cargué a mano» y «descartar» no procesan, no descuentan, no acreditan
{
  const llamadas = [];
  const e = nuevoEntorno({ modulos: ['meli-ordenes.js'], dom: { 'meliord-cnota-1': ' cargada el 5/10 ', 'meliord-cvta-1': '321', 'meliord-cnota-3': '', 'meliord-cvta-3': '12ab' },
    dbExtra: { async cargarTodo() {}, async cargarMeliOrdenes() {} } });
  let respuesta = { data: { ok: true, orden_id: 1, motivo: 'ya_cargada', venta_id: 321 }, error: null };
  e.cfg.supaRpc = async (fn, args) => { llamadas.push({ fn, args }); return respuesta; };
  const M = e.mod.MeliOrdenes;
  const cerr = { en: '2026-10-12T15:00:00Z', por: 'franco@x.com', motivo: 'ya_cargada', nota: 'ya estaba', ventaId: 55 };
  e.State.meliOrdenes = [
    { id: 1, orderId: 'ORD1', procesada: false, revisar: false, items: [{ cantidad: 1, stock_id: 's1', titulo: 'Perfume A' }], cuentaId: 1, bruto: 1000, neto: 800, financieraCompleta: true },
    { id: 2, orderId: 'ORD2', procesada: false, revisar: false, cerradaManual: cerr, items: [{ cantidad: 1, stock_id: 's1', titulo: 'Perfume A' }], cuentaId: 1 },
    { id: 3, orderId: 'ORD3', procesada: false, revisar: true, motivoRevisar: 'Hay ítems sin publicación vinculada', items: [{ cantidad: 1, titulo: 'Perfume B' }], cuentaId: 1 },
    { id: 4, orderId: 'ORD4', procesada: false, revisar: true, motivoRevisar: 'Mercado Libre la canceló', cerradaManual: { ...cerr, motivo: 'descartada', ventaId: null, nota: null }, items: [], cuentaId: 1 },
    { id: 5, orderId: 'ORD5', procesada: true, acreditado: false, revisar: false, financieraCompleta: true, items: [], cuentaId: 1 },
  ];
  M._filtro = 'todas';
  const v = M._vista();
  const tarjeta = (id) => { const i = v.indexOf(`Orden ORD${id} `); const j = v.indexOf('Orden ORD', i + 5); return v.slice(i, j < 0 ? undefined : j); };
  check('Una orden sin procesar y una en revisión ofrecen «Ya la cargué a mano» y «Descartar»', /abrirCierre\(1, 'ya_cargada'\)/.test(tarjeta(1)) && /abrirCierre\(1, 'descartada'\)/.test(tarjeta(1)) && /abrirCierre\(3, 'ya_cargada'\)/.test(tarjeta(3)), tarjeta(1).slice(-400));
  check('Una orden CERRADA a mano: etiqueta, quién y cuándo, la nota y la venta enlazada; sin Procesar, sin Revalidar y sin cerrar de nuevo; con «Reabrir»',
    tarjeta(2).includes('Ya cargada a mano') && tarjeta(2).includes('venta #55') && tarjeta(2).includes('ya estaba') && !/MeliOrdenes\.(abrirProcesar|revalidar|abrirCierre)\(2/.test(tarjeta(2)) && /MeliOrdenes\.reabrirCierre\(2/.test(tarjeta(2)), tarjeta(2).slice(-500));
  check('Una cerrada que Mercado Libre volvió a marcar para revisar muestra el aviso en rojo, y sigue sin poder procesarse', tarjeta(4).includes('Descartada') && tarjeta(4).includes('la canceló') && !/MeliOrdenes\.(abrirProcesar|revalidar)\(4/.test(tarjeta(4)));
  e.State.meliCierre = false;
  const vSin = M._vista();
  check('Si el script 12 no está corrido (sin las columnas del cierre), la pantalla NO ofrece «Ya la cargué a mano» ni «Descartar»', !/MeliOrdenes\.abrirCierre\(/.test(vSin) && /abrirDetalle\(1\)/.test(vSin));
  e.State.meliCierre = true;
  const cuenta = k => e.State.meliOrdenes.filter(o => M._estadoDe(o).clave === k).length;
  check('Las cerradas a mano van a la solapa «Cerradas»; no cuentan en «Para procesar» ni en «En revisión»', cuenta('cerradas') === 2 && cuenta('pendientes') === 1 && cuenta('revision') === 1 && M._estadoDe(e.State.meliOrdenes[1]).clave === 'cerradas');
  check('La solapa «a liberar» solo cuenta lo procesado y sin acreditar: las cerradas a mano no suman', e.State.meliPendienteLiberar().ordenes === 1);
  await M.cerrarManual(1, 'ya_cargada', null);
  check('«Ya la cargué a mano» llama a meli_orden_cerrar_manual con la orden, el motivo, la venta como NÚMERO y la nota sin espacios sobrantes',
    llamadas.length === 1 && llamadas[0].fn === 'meli_orden_cerrar_manual' && llamadas[0].args.p_orden_id === 1 && llamadas[0].args.p_motivo === 'ya_cargada' && llamadas[0].args.p_venta_id === 321 && llamadas[0].args.p_nota === 'cargada el 5/10', JSON.stringify(llamadas));
  await M.cerrarManual(3, 'ya_cargada', null);
  check('Un número de venta que no es un número se rechaza ANTES de llamar a la base', llamadas.length === 1 && e.toasts.some(t => t.includes('número de venta no es válido')), JSON.stringify(e.toasts));
  await M.cerrarManual(3, 'otra', null);
  check('Un motivo que no es ninguno de los dos no llama a la base', llamadas.length === 1);
  respuesta = { data: null, error: { message: 'ORDEN_YA_PROCESADA' } };
  e.dom['meliord-cvta-3'] = '';
  await M.cerrarManual(3, 'descartada', null);
  check('Si la base dice que ya está procesada, se explica en castellano (y se manda sin venta, porque descartar no la admite)', llamadas[1].args.p_motivo === 'descartada' && llamadas[1].args.p_venta_id === null && e.toasts.some(t => t.includes('ya se procesó')), JSON.stringify({ l: llamadas[1], t: e.toasts }));
  for (const [codigo, texto] of [['ORDEN_CERRADA_MANUAL', 'cerrada a mano'], ['VENTA_YA_ENLAZADA', 'ya está enlazada'], ['VENTA_INEXISTENTE', 'No encuentro esa venta'], ['NOTA_INVALIDA', 'La nota']]) {
    respuesta = { data: null, error: { message: codigo } };
    e.toasts.length = 0;
    await M.cerrarManual(1, 'ya_cargada', null);
    if (!e.toasts.some(t => t.includes(texto))) { check(`El error ${codigo} se explica en castellano`, false, JSON.stringify(e.toasts)); }
  }
  check('Los errores de la base (cerrada, venta ya enlazada, venta inexistente, nota) se explican en castellano', true);
  const antes = llamadas.length;
  e.toasts.length = 0;
  await M.abrirProcesar(2);
  check('Abrir «Procesar» de una orden cerrada a mano no abre nada: avisa que hay que reabrirla', e.toasts.some(t => t.includes('cerrada a mano')) && llamadas.length === antes);
  respuesta = { data: { ok: true, orden_id: 2, revisar: false }, error: null };
  const confirmOrig = e.cfg.confirm;
  await M.reabrirCierre(2, null);
}

// 33. TRADE-IN: el equipo que entra con la venta tiene que llegar al stock, o decir POR QUÉ no
{
  const tradeIn = { cat: 'iphone', modelo: 'iPhone 16 Pro Max', storage: '256GB', color: 'Dorado', valor: 800, imei: '351234567890123', bateriaPct: 90, estadoProducto: '', grado: 'Sin grado', notas: '', custodio: '', revisar: false };
  const armar = (guardar) => {
    const llamadas = [];
    const e = entornoVenta({ async guardarProductoStock(obj) { llamadas.push(JSON.parse(JSON.stringify(obj))); return guardar(obj, llamadas.length); },
      async actualizarNotasStock() { return true; }, async registrarMovimientoStock() {}, async darDeBajaProductoStock() { return true; } });
    e.sembrar({ Franco: { 'USD cash': 0 } });
    e.mod.Ventas.draft = { ...ventaBase(), items: [{ nombre: 'iPhone 17', precio: 1000, costo: 800, stockId: 1, imei: null }], tradeIn, pagos: [{ persona: 'Franco', bolsillo: 'USD cash', monto: 200 }] };
    Object.assign(e.State, { stock: [{ id: 1, nombre: 'iPhone 17', cat: 'iphone', cantidad: 5, cantidadDeclarada: 5, costoUSD: 800, estadoInventario: 'disponible' }], ventas: [], garantias: [] });
    return { e, llamadas };
  };
  {
    // a) Todo bien: el equipo entra al stock con su nota de venta
    const { e, llamadas } = armar(() => ({ id: 'ti-1', error: null }));
    await e.mod.Ventas._confirmSale();
    check('Trade-in OK: entra al stock (proveedor Trade-In, con su IMEI) y la venta lo recuerda', llamadas.length === 1 && llamadas[0].proveedor === 'Trade-In' && llamadas[0].imeis[0] === '351234567890123' && e.State.ventas[0].tradeInStockId === 'ti-1', JSON.stringify(llamadas));
  }
  {
    // b) El IMEI ya estaba en otro producto: el equipo entra IGUAL, sin IMEI, con el IMEI anotado, y avisa
    const { e, llamadas } = armar((obj, n) => n === 1 ? { id: null, error: { message: 'El IMEI 351234567890123 ya está cargado en otro producto del stock' } } : { id: 'ti-2', error: null });
    await e.mod.Ventas._confirmSale();
    check('IMEI repetido: se reintenta SIN IMEI, el equipo entra al stock con el IMEI en las notas y se avisa',
      llamadas.length === 2 && llamadas[1].imeis.length === 0 && /351234567890123/.test(llamadas[1].notas) && e.State.ventas[0].tradeInStockId === 'ti-2' && e.toasts.some(t => t.includes('SIN IMEI')), JSON.stringify({ llamadas, t: e.toasts }));
  }
  {
    // c) Otro error: la venta se guarda, el aviso trae el MOTIVO real y el detalle ofrece ingresarlo a mano
    let ok = false;
    const { e, llamadas } = armar(() => ok ? { id: 'ti-3', error: null } : { id: null, error: { message: 'new row for relation "stock" violates check constraint' } });
    await e.mod.Ventas._confirmSale();
    check('Error de la base al dar de alta el trade-in: la venta queda guardada y el aviso dice el motivo real',
      e.State.ventas.length === 1 && !e.State.ventas[0].tradeInStockId && e.toasts.some(t => t.includes('violates check constraint') && t.includes('Ingresar al stock')), JSON.stringify(e.toasts));
    check('… y la venta se reconoce como "sin el equipo en el stock" (para ofrecer el botón)', e.mod.Ventas._tradeInEnStock(e.State.ventas[0]) === false);
    ok = true; Object.assign(e.mod.Ventas, { viewSale() {} });
    await e.mod.Ventas.ingresarTradeInAlStock(e.State.ventas[0].id);
    check('«Ingresar al stock»: lo da de alta con la nota de la venta y la venta lo reconoce',
      e.mod.Ventas._tradeInEnStock(e.State.ventas[0]) === true && llamadas.length === 2 && e.State.stock.some(x => x.id === 'ti-3'), JSON.stringify({ n: llamadas.length }));
    await e.mod.Ventas.ingresarTradeInAlStock(e.State.ventas[0].id);
    check('Apretarlo otra vez no crea un segundo equipo', llamadas.length === 2 && e.toasts.some(t => t.includes('ya figura')), JSON.stringify(e.toasts.slice(-2)));
  }
}

// 34. CASO REAL (conversión USD→USDT con sobrante): el arreglo de hoy cuadra con los movimientos reales
{
  const { State, base, libro, sembrar } = nuevoEntorno();
  sembrar({ Angel: { 'USD cash': 10000 }, 'Tincho GMG': { 'USDT': 0 } });
  // Lo que Franco registró en el lote: conversión 8.790 USD → 8.526,30 USDT y pago de 8.526,30 USDT
  await State.moverCaja('Angel', 'USD cash', 8790, 'Tincho GMG', 'USDT', 8526.30, { tipo: 'proveedor', referencia: 'lote' });
  await State.debitarCaja('Tincho GMG', 'USDT', 8526.30, { tipo: 'proveedor', referencia: 'lote' });
  check('Antes del arreglo: Angel 1.210 USD de más (1.210) y Tincho 910 USDT de menos (0)', base['Angel||USD cash'] === 1210 && base['Tincho GMG||USDT'] === 0, JSON.stringify(base));
  // El arreglo: (1) pasada de manos 1.173,70 USD → USDT; (2) gasto de comisión 36,30 USD desde Angel; (3) pago adicional 263,70 USDT
  await State.moverCaja('Angel', 'USD cash', 1173.70, 'Tincho GMG', 'USDT', 1173.70, { tipo: 'movimiento' });
  await State.debitarCaja('Angel', 'USD cash', 36.30, { tipo: 'gasto' });
  await State.debitarCaja('Tincho GMG', 'USDT', 263.70, { tipo: 'proveedor', referencia: 'lote' });
  check('Después del arreglo: Angel en 0 (salieron los 10.000 USD) y Tincho GMG en 910 USDT',
    base['Angel||USD cash'] === 0 && base['Tincho GMG||USDT'] === 910, JSON.stringify(base));
  check('… y el libro de movimientos cuadra con los saldos (control de cuadre en 0)', cuadra(base, libro).length === 0, JSON.stringify(cuadra(base, libro)));
}

// 35. VARIANTE con el sobrante en la caja de Angel (USDT): Tincho queda en 0
{
  const { State, base, libro, sembrar } = nuevoEntorno();
  sembrar({ Angel: { 'USD cash': 1330, 'USDT': 659.4 }, 'Tincho GMG': { 'USDT': 0 } });
  // (1) sobrante: Angel USD cash → Angel USDT (misma persona, distinto bolsillo)
  const r1 = await State.moverCaja('Angel', 'USD cash', 910, 'Angel', 'USDT', 910, { tipo: 'movimiento' });
  // (2) lo que faltaba pagar: Angel USD cash → Tincho GMG USDT, y (3) pago al lote desde Tincho
  const r2 = await State.moverCaja('Angel', 'USD cash', 263.70, 'Tincho GMG', 'USDT', 263.70, { tipo: 'movimiento' });
  const r3 = await State.debitarCaja('Tincho GMG', 'USDT', 263.70, { tipo: 'proveedor', referencia: 'lote' });
  // (4) comisión del sobrante como gasto
  const r4 = await State.debitarCaja('Angel', 'USD cash', 36.30, { tipo: 'gasto' });
  check('Variante: las 4 operaciones se aplican (traspaso de la misma persona entre bolsillos incluido)', r1 && r2 && r3 && r4);
  check('Saldos finales: Angel USD cash 120, Angel USDT 1.569,40, Tincho GMG 0',
    base['Angel||USD cash'] === 120 && base['Angel||USDT'] === 1569.4 && base['Tincho GMG||USDT'] === 0, JSON.stringify(base));
  check('… y el libro cuadra con los saldos (control de cuadre en 0)', cuadra(base, libro).length === 0, JSON.stringify(cuadra(base, libro)));
}

// 36. PANTALLA DE ÓRDENES con vínculos: qué se muestra, cuándo se puede procesar y la revisión previa
{
  const llamadas = [];
  const e = nuevoEntorno({ modulos: ['meli-ordenes.js'], dom: { 'meliord-cot-1': '1000', 'meliord-cot-3': '1000', 'meliord-ok-1': true },
    dbExtra: { async cargarTodo() {}, async cargarMeliOrdenes() {} } });
  let rev = { data: { ok: true, revisar: false, motivo: null, cerrada: false, sin_vincular: false }, error: null };
  let proc = { data: { ok: true, venta_id: 77 }, error: null };
  e.cfg.supaRpc = async (fn, args) => { llamadas.push({ fn, args }); return fn === 'meli_orden_revalidar' ? rev : proc; };
  e.State.refBlue = 1000;
  e.State.stock = [{ id: 's1', nombre: 'Perfume Armaf 100ml' }];
  const orden = (id, items, extra = {}) => ({ id, orderId: 'O' + id, procesada: false, acreditado: false, revisar: false, items, bruto: 100000, neto: 85000, financieraCompleta: true, ...extra });
  e.State.meliOrdenes = [
    orden(1, [{ meli_item_id: 'MLA1', meli_variacion_id: null, titulo: 'Armaf', cantidad: 1, stock_id: 's1' }]),
    orden(2, [{ meli_item_id: 'MLA<img>', meli_variacion_id: 'V"1', titulo: '<b>Raro</b>', cantidad: 1, stock_id: null }]),
    orden(3, [{ meli_item_id: 'MLA3', titulo: 'X', cantidad: 1, stock_id: null }], { revisar: true, motivoRevisar: 'Hay ítems sin publicación vinculada' }),
  ];
  e.mod.MeliOrdenes._filtro = 'todas';
  const sinPantalla = e.mod.MeliOrdenes._vista();
  check('Una orden vinculada muestra «→ Stock: nombre» y tiene Procesar habilitado',
    sinPantalla.includes('→ Stock: Perfume Armaf 100ml') && /MeliOrdenes\.abrirProcesar\(1\)/.test(sinPantalla), sinPantalla.slice(0, 400));
  check('Una orden sin vincular dice «Sin vincular» y su Procesar está DESHABILITADO (no se puede llamar)',
    sinPantalla.includes('Sin vincular') && sinPantalla.includes('disabled title="Falta vincular una publicación"') && !/MeliOrdenes\.abrirProcesar\(2\)/.test(sinPantalla));
  check('Sin la pantalla de vínculos cargada no se ofrece el botón «Vincular»', !sinPantalla.includes('MeliOrdenes.vincular('));
  check('Una orden en revisión (aún no procesada) ofrece «Revalidar»', /MeliOrdenes\.revalidar\(3, this\)/.test(sinPantalla));
  e.mod.MeliVincular = { abrir: (...a) => { e.abierto = a; } };
  const conPantalla = e.mod.MeliOrdenes._vista();
  check('Con la pantalla de vínculos: botón «Vincular» con los identificadores en data-* ESCAPADOS (nunca dentro de código)',
    conPantalla.includes('data-item="MLA&lt;img&gt;"') && conPantalla.includes('data-var="V&quot;1"') && !conPantalla.includes('<b>Raro</b>'), conPantalla.slice(conPantalla.indexOf('Sin vincular') - 80, conPantalla.indexOf('Sin vincular') + 400));
  e.mod.MeliOrdenes.vincular({ dataset: { item: 'MLA9', var: 'V2', cuenta: '5' } });
  check('«Vincular» abre ESE aviso y esa variación, y le pasa la cuenta de la orden', JSON.stringify(e.abierto) === '["MLA9","V2","5"]', JSON.stringify(e.abierto));
  // Dos cuentas: la pantalla de vínculos tiene abierta la 1; una orden de la cuenta 2 NO ofrece el botón
  e.mod.MeliVincular._cuenta = 1;
  const ordenesOriginales = e.State.meliOrdenes;
  e.State.meliOrdenes = [
    orden(11, [{ meli_item_id: 'MLAX', titulo: 'De la cuenta 1', cantidad: 1, stock_id: null }], { cuentaId: 1 }),
    orden(12, [{ meli_item_id: 'MLAY', titulo: 'De la cuenta 2', cantidad: 1, stock_id: null }], { cuentaId: 2 }),
  ];
  const dosCuentas = e.mod.MeliOrdenes._vista();
  check('Con dos cuentas: cada orden ofrece «Vincular» con SU cuenta en data-cuenta (la pantalla de vínculos cambia de cuenta)',
    dosCuentas.includes('data-item="MLAX"') && dosCuentas.includes('data-cuenta="1"') && dosCuentas.includes('data-item="MLAY"') && dosCuentas.includes('data-cuenta="2"'), dosCuentas.slice(0, 300));
  e.mod.MeliVincular._cuenta = null;
  e.State.meliOrdenes = ordenesOriginales;

  // Procesar: la revisión previa nunca deja pasar a procesar si algo falla
  const intentar = async (r) => { llamadas.length = 0; rev = r; e.mod.MeliOrdenes._firmas[1] = e.mod.MeliOrdenes._firma(e.State.meliOrdenes.find(o => o.id === 1)); await e.mod.MeliOrdenes.procesar(1, { disabled: false }); return llamadas.map(l => l.fn).join(','); };
  check('Procesar con la revisión previa que falla (error de red): NO llama a procesar y avisa',
    (await intentar({ data: null, error: { message: 'x' } })) === 'meli_orden_revalidar' && e.toasts.some(t => t.includes('No se pudo revisar')));
  check('Con la orden ocupada por otra operación: NO procesa y pide reintentar',
    (await intentar({ data: { ok: false, ocupada: true }, error: null })) === 'meli_orden_revalidar' && e.toasts.some(t => t.includes('Otra operación')));
  check('Si la revisión dice que falta vincular: NO procesa',
    (await intentar({ data: { ok: true, revisar: true, sin_vincular: true, motivo: 'Hay ítems sin publicación vinculada', cerrada: false }, error: null })) === 'meli_orden_revalidar' && e.toasts.some(t => t.includes('Falta vincular')));
  check('Si sigue en revisión por otro motivo: NO procesa y muestra el motivo',
    (await intentar({ data: { ok: true, revisar: true, sin_vincular: false, motivo: 'Devolución', cerrada: false }, error: null })) === 'meli_orden_revalidar' && e.toasts.some(t => t.includes('Devolución')));
  check('Con todo en orden: revisa y DESPUÉS procesa, con la cotización indicada',
    (await intentar({ data: { ok: true, revisar: false, sin_vincular: false, cerrada: false }, error: null })) === 'meli_orden_revalidar,meli_procesar_orden' && llamadas[1].args.p_cotizacion === 1000);
  // Revalidación al abrir: solo las que están en revisión por falta de vínculo y no se repite enseguida
  llamadas.length = 0;
  e.mod.MeliOrdenes._ultimaReval = {};
  rev = { data: { ok: true, revisar: false, sin_vincular: false, cerrada: false, motivo: null }, error: null };
  const cambio = await e.mod.MeliOrdenes._revalidarSinVincular();
  check('Al abrir la lista se revalida SOLO la orden en revisión por falta de vínculo (la 3), y avisa que hubo cambios',
    llamadas.length === 1 && llamadas[0].args.p_orden_id === 3 && cambio === true, JSON.stringify(llamadas));
  llamadas.length = 0;
  await e.mod.MeliOrdenes._revalidarSinVincular();
  check('… y no la vuelve a revalidar dentro de los 30 segundos', llamadas.length === 0);
}

// 37. GASTOS: la caja que paga se elige a propósito y tiene que ser de la misma moneda
{
  const armar = (dom) => {
    const e = nuevoEntorno({ modulos: ['gastos.js'], dom: { 'gf-motivo': 'Nafta', 'gf-monto': '100', 'gf-cat': 'x', 'gf-resp': 'Angel', 'gf-moneda': 'USD', ...dom },
      dbExtra: { async crearGasto() { return 9; }, async eliminarGasto() { return true; } } });
    e.sembrar({ Angel: { 'USD cash': 1000, 'ARS cash': 500000 }, Padre: { 'USD cash': 800, 'ARS cash': 0 } });
    Object.assign(e.mod.Gastos, { close() {}, renderChips() {}, renderKpis() {}, renderTable() {}, mesActual: '2026-10', catObj: () => ({ nombre: 'x' }) });
    e.State.gastos = []; e.State.categoriasGasto = [{ id: 'x', nombre: 'x', color: '#000' }]; e.State.personas = ['Angel', 'Padre'];
    return e;
  };
  {
    const e = armar({ 'gf-caja-persona': '', 'gf-caja-bolsillo': '' });
    await e.mod.Gastos.save();
    check('Gasto sin elegir caja: no se guarda ni se toca ninguna caja, y pide elegirla', e.State.gastos.length === 0 && e.servidor.llamadas === 0 && e.toasts.some(t => t.includes('Elegí de qué caja')), JSON.stringify(e.toasts));
  }
  {
    const e = armar({ 'gf-moneda': 'ARS', 'gf-monto': '50000', 'gf-caja-persona': 'Angel', 'gf-caja-bolsillo': 'USD cash' });
    await e.mod.Gastos.save();
    check('Gasto de 50.000 ARS desde una caja en USD: se frena (antes descontaba 50.000 dólares) y no se guarda nada',
      e.State.gastos.length === 0 && e.base['Angel||USD cash'] === 1000 && e.toasts.some(t => t.includes('misma moneda')), JSON.stringify({ b: e.base, t: e.toasts }));
  }
  {
    const e = armar({ 'gf-caja-persona': 'Padre', 'gf-caja-bolsillo': 'USD cash' });
    await e.mod.Gastos.save();
    check('Gasto de 100 USD desde la caja de Padre: se descuenta de ESA caja (800 → 700) y no de otra',
      e.base['Padre||USD cash'] === 700 && e.base['Angel||USD cash'] === 1000 && e.State.gastos.length === 1, JSON.stringify(e.base));
    check('… y el aviso dice de qué caja salió y cuánto queda', e.toasts.some(t => t.includes('Padre · USD cash') && t.includes('queda')), JSON.stringify(e.toasts));
  }
  {
    const e = armar({ 'gf-caja-persona': 'Angel', 'gf-caja-bolsillo': 'USDT' });
    e.sembrar({ Angel: { 'USDT': 500 }, Padre: {} });
    await e.mod.Gastos.save();
    check('Un gasto en USD se puede pagar desde una caja USDT (1 a 1)', e.base['Angel||USDT'] === 400, JSON.stringify(e.base));
  }
  {
    // La lista de cajas sigue a la moneda
    const e = armar({});
    e.State.cajas = { Angel: { 'ARS cash': 1, 'ARS Mercado Pago': 1, 'USD cash': 1, 'USDT': 1 } };
    const ars = e.mod.Gastos._opcionesBolsillo('ARS'), usd = e.mod.Gastos._opcionesBolsillo('USD');
    check('Las cajas ofrecidas siguen a la moneda: ARS incluye «ARS Mercado Pago» y excluye USD; USD incluye USD cash y USDT',
      ars.includes('ARS Mercado Pago') && !ars.includes('USD cash') && usd.includes('USD cash') && usd.includes('USDT') && !usd.includes('ARS'), ars + ' | ' + usd);
  }
}

// 38. FECHAS: una hora sin zona horaria se toma como UTC (un gasto de las 21:02 no puede aparecer a las 00:02 del día siguiente)
{
  const fuente = fs.readFileSync('/Users/francovelas/crm-complete/iphonemood-crm/src/modules/supabase-config.js', 'utf8');
  const ctxDB = { window: { __APP_CONFIG__: { SUPABASE_URL: 'x', SUPABASE_ANON_KEY: 'y' } }, supabase: { createClient: () => ({}) },
    console: { log() {}, warn() {}, error() {} }, Auth: {}, State: {}, toast() {}, Date, Math, Number, JSON, String, Promise, Error };
  vm.createContext(ctxDB);
  vm.runInContext(fuente + '\nthis.__DB = DB;', ctxDB, { filename: 'supabase-config.js' });
  const DBr = ctxDB.__DB;
  const dia = iso => new Date(DBr._utc(iso)).toISOString();
  check('Hora sin zona (como la devuelve una columna timestamp): se toma como UTC → 2026-10-09T00:02 UTC = 21:02 del 8/10 en Argentina',
    dia('2026-10-09T00:02:11.5') === '2026-10-09T00:02:11.500Z' && dia('2026-10-09 00:02:11') === '2026-10-09T00:02:11.000Z');
  check('Una hora que YA trae zona no se toca (timestamptz)', DBr._utc('2026-10-09T00:02:11+00:00') === '2026-10-09T00:02:11+00:00' && DBr._utc('2026-10-09T00:02:11Z') === '2026-10-09T00:02:11Z' && DBr._utc('2026-10-08T21:02:11-03:00') === '2026-10-08T21:02:11-03:00');
  check('Una fecha sola ("2026-10-09") y los valores vacíos quedan como están', DBr._utc('2026-10-09') === '2026-10-09' && DBr._utc(null) === null && DBr._utc(undefined) === undefined);
}

// 39. PLAN CONVERSIONES · FASE 0: saldo con el proveedor ≠ costo de la mercadería, y Capital en tránsito sin doble conteo
{
  const armar = (lotes, items, pagos, creditos = []) => {
    const e = nuevoEntorno({ modulos: ['proveedores.js', 'capital.js'], dbExtra: { async guardarLotePago(loteId, p) { e.State.lotePagos.push({ id: Math.random(), loteId, ...p }); return true; }, async crearProveedorCredito(c) { e.creditosCreados.push(c); e.State.proveedorCreditos.push({ id: 99, tipo: 'generado', ...c }); return true; } } });
    e.creditosCreados = [];
    Object.assign(e.State, { lotesCompra: lotes, loteItems: items, lotePagos: pagos, proveedorCreditos: creditos, proveedores: [{ id: 1, nombre: 'P', activo: true }], stock: [], cajas: {}, activosFijos: [], inversores: [], inversorPagos: [], deudas: [], ventas: [] });
    e.State.refBlue = 1000; e.State.refUsdt = 1000;
    return e;
  };
  const lote = (estado = 'pagado') => [{ id: 1, proveedorId: 1, estado }];
  const item = (precio, cant = 1) => [{ loteId: 1, precioUsd: precio, cantidad: cant }];
  const pg = (tipo, montoUsd, extra = {}) => ({ id: Math.random(), loteId: 1, tipo, montoUsd, montoUsdt: extra.montoUsdt || 0, comisionUsd: extra.comisionUsd || 0, moneda: 'USDT', ...extra });
  // Caso real: ítems 8.790 USDT, conversión con comisión 263,70, pagos 8.526,30 + 263,70 = 8.790
  {
    const e = armar(lote(), item(8790), [pg('conversion', 8790, { montoUsdt: 8526.3, comisionUsd: 263.7 }), pg('pago_proveedor', 8526.3), pg('pago_proveedor', 263.7)]);
    const c = e.mod.Proveedores._cuentaLote(1);
    check('Caso real: pagados los 8.790 que facturó el proveedor, el lote queda SALDADO (antes mostraba 263,70 de deuda falsa)', c.restante === 0 && c.excedenteBruto === 0 && c.pagadoNeto === 8790, JSON.stringify(c));
    check('… y el costo de la mercadería sigue incluyendo la comisión (8.790 + 263,70 = 9.053,70)', c.costoAdquisicion === 9053.7, String(c.costoAdquisicion));
    const cap = e.mod.Capital.calcular();
    check('Capital en tránsito del caso real: 8.790 pagados + 263,70 de comisión = 9.053,70 (no 17.580 sumando la conversión)', Math.abs(cap.pedidosEnTransito - 9053.7) < 0.005, String(cap.pedidosEnTransito));
  }
  {
    const e = armar(lote(), item(8790), []);
    check('Sin pagos: se le debe todo (8.790)', e.mod.Proveedores._cuentaLote(1).restante === 8790);
  }
  {
    const e = armar(lote(), item(1000), [pg('envio', 50, { moneda: 'USD' }), pg('pago_proveedor', 1000)]);
    check('Un envío pagado aparte NO se le debe al proveedor: 1.000 pagados de 1.000 facturados = saldado', e.mod.Proveedores._cuentaLote(1).restante === 0);
  }
  {
    const e = armar(lote(), item(1000), [pg('credito_aplicado', 400), pg('pago_proveedor', 600)]);
    check('El saldo a favor aplicado cuenta como pagado (400 + 600 de 1.000 = saldado)', e.mod.Proveedores._cuentaLote(1).restante === 0);
  }
  {
    // Orden reducida de 9.000 a 8.000, ya se pagaron 9.000 y el proveedor devolvió 1.000: NO hay excedente
    const e = armar(lote(), item(8000), [pg('pago_proveedor', 9000), pg('devolucion', 1000)]);
    const c = e.mod.Proveedores._cuentaLote(1);
    check('Con devolución del proveedor: 9.000 pagados − 1.000 devueltos = 8.000 = lo facturado: sin excedente ni deuda (antes ofrecía guardar 1.000 como crédito, que ya había vuelto a caja)', c.restante === 0 && c.excedenteBruto === 0, JSON.stringify(c));
    const cap = e.mod.Capital.calcular();
    check('… y Capital en tránsito resta la devolución (8.000, no 10.000)', cap.pedidosEnTransito === 8000, String(cap.pedidosEnTransito));
  }
  {
    // Pagó de más de verdad: 100 de excedente → ese monto se ofrece como crédito, calculado contra los ítems
    const e = armar(lote(), item(1000), [pg('conversion', 1000, { montoUsdt: 970, comisionUsd: 30 }), pg('pago_proveedor', 1100)]);
    const c = e.mod.Proveedores._cuentaLote(1);
    check('Pago de más contra lo facturado: excedente 100 (aunque el costo con comisión sea 1.030)', c.excedenteBruto === 100 && c.restante === 0, JSON.stringify(c));
    e.mod.Proveedores.renderContent = () => {};
    await e.mod.Proveedores.convertirExcedenteACredito(1);
    check('«Guardar como saldo a favor» guarda 100 (no 70 = 1.100 − 1.030)', e.creditosCreados.length === 1 && e.creditosCreados[0].montoUsd === 100, JSON.stringify(e.creditosCreados));
    const cap = e.mod.Capital.calcular();
    check('Capital en tránsito tras ese excedente: 1.100 pagados − 100 guardados como crédito + 30 de comisión = 1.030', Math.abs(cap.pedidosEnTransito - 1030) < 0.005, String(cap.pedidosEnTransito));
  }
  // Modal de pago: lo sugerido sale de lo que falta pagar, no de lo convertido
  {
    const modalMonto = e => {
      let html = '';
      e.ctx.document.createElement = () => ({ set innerHTML(v) { html = v; }, get innerHTML() { return html; }, style: {}, classList: { add() {}, remove() {} }, remove() {}, querySelector: () => null });
      e.mod.Proveedores.modalPago(1);
      const m = html.match(/id="pago-monto"[^>]*?value="([^"]*)"/s);
      return m ? m[1] : null;
    };
    const e1 = armar(lote('pendiente'), item(1000), [pg('conversion', 1000, { montoUsdt: 970, comisionUsd: 30 })]);
    check('Modal de pago, primer pago con conversión: propone los USDT convertidos (970)', modalMonto(e1) === '970.00', String(modalMonto(e1)));
    const e2 = armar(lote('pendiente'), item(1000), [pg('conversion', 1000, { montoUsdt: 970, comisionUsd: 30 }), pg('pago_proveedor', 600)]);
    check('Modal de pago con 600 ya pagados: propone lo que falta (370, no 970 de nuevo)', modalMonto(e2) === '370.00', String(modalMonto(e2)));
    const e3 = armar(lote('pendiente'), item(1000), [pg('credito_aplicado', 400)]);
    check('Modal de pago sin conversión y con saldo a favor aplicado: propone 600', modalMonto(e3) === '600.00', String(modalMonto(e3)));
    const e4 = armar(lote(), item(1000), [pg('pago_proveedor', 1000)]);
    check('Modal de pago con el lote saldado: no propone nada', modalMonto(e4) === '', String(modalMonto(e4)));
  }
  // Devolución sobre un excedente que ya se guardó como saldo a favor: bloqueada
  {
    const e = armar(lote(), item(900), [pg('pago_proveedor', 1000)], [{ id: 1, proveedorId: 1, loteId: 1, tipo: 'generado', montoUsd: 100 }]);
    Object.assign(e.dom, { 'dev-persona': 'Franco', 'dev-bolsillo': 'USDT', 'dev-monto': '100', 'dev-notas': '' });
    e.sembrar({ Franco: { USDT: 0 } });
    const antes = e.contadores.llamadas ?? 0;
    await e.mod.Proveedores.confirmarDevolucion(1);
    check('Devolver 100 cuando esos 100 ya son saldo a favor: se bloquea y no entra plata a la caja', e.State.cajas.Franco.USDT === 0 && e.State.lotePagos.filter(p => p.tipo === 'devolucion').length === 0 && e.toasts.some(t => /saldo a favor/.test(t)), JSON.stringify(e.toasts));
    const e2 = armar(lote(), item(900), [pg('pago_proveedor', 1000)]);
    Object.assign(e2.dom, { 'dev-persona': 'Franco', 'dev-bolsillo': 'USDT', 'dev-monto': '100', 'dev-notas': '' });
    e2.sembrar({ Franco: { USDT: 0 } });
    e2.mod.Proveedores.renderKpis = () => {}; e2.mod.Proveedores.renderContent = () => {};
    await e2.mod.Proveedores.confirmarDevolucion(1);
    const e3 = armar(lote(), item(900), [pg('pago_proveedor', 1000)], [{ id: 1, proveedorId: 1, loteId: 1, tipo: 'generado', montoUsd: 100 }]);
    Object.assign(e3.dom, { 'dev-persona': 'Franco', 'dev-bolsillo': 'USDT', 'dev-monto': '0.005', 'dev-notas': '' });
    e3.sembrar({ Franco: { USDT: 0 } });
    await e3.mod.Proveedores.confirmarDevolucion(1);
    check('Devolver 0,005 con máximo 0 se bloquea (no se cuela por redondeo a 0,01)', e3.State.cajas.Franco.USDT === 0 && e3.State.lotePagos.filter(p => p.tipo === 'devolucion').length === 0, String(e3.State.cajas.Franco.USDT));
    check('Sin saldo a favor generado, la misma devolución de 100 sí se permite', e2.State.cajas.Franco.USDT === 100, String(e2.State.cajas.Franco?.USDT));
  }
  {
    const e = armar(lote(), item(900), [pg('pago_proveedor', 1000)], [{ id: 1, proveedorId: 1, loteId: 1, tipo: 'generado', montoUsd: 100 }]);
    const cap = e.mod.Capital.calcular();
    check('Pagó 1.000 de una orden de 900 y 100 ya son saldo a favor: en tránsito 900 (el crédito se cuenta en su línea, sin duplicar)', cap.pedidosEnTransito === 900, String(cap.pedidosEnTransito));
  }
  {
    const e = armar(lote('cancelado'), item(1000), [pg('conversion', 1000, { montoUsdt: 970, comisionUsd: 30 }), pg('pago_proveedor', 970)]);
    check('Un lote CANCELADO no cuenta en tránsito (devolvió la plata aunque conserve las filas)', e.mod.Capital.calcular().pedidosEnTransito === 0);
    const r = armar(lote('recibido'), item(1000), [pg('pago_proveedor', 1000)]);
    check('Un lote RECIBIDO tampoco', r.mod.Capital.calcular().pedidosEnTransito === 0);
  }
}

// 40. CUADRO PREVIO A PROCESAR (MELI): cotización sin precarga, stock actual/resultante, ventas parecidas, casilla obligatoria
{
  const llamadas = [];
  const e = nuevoEntorno({ modulos: ['meli-ordenes.js'], dbExtra: { async cargarTodo() {}, async cargarMeliOrdenes() {}, _utc: x => x } });
  e.cfg.supaRpc = async (fn, args) => { llamadas.push({ fn, args }); return fn === 'meli_orden_revalidar' ? { data: { ok: true, revisar: false, sin_vincular: false, cerrada: false }, error: null } : { data: { ok: true, venta_id: 5 }, error: null }; };
  e.State.refBlue = 1570;
  e.State.stock = [{ id: 's1', nombre: 'Lattafa Khamrah', cantidad: 3 }, { id: 's2', nombre: 'Armaf CDNIM', cantidad: 0 }];
  const orden = (id, items, extra = {}) => ({ id, orderId: '2000' + id, procesada: false, acreditado: false, revisar: false, items, bruto: 65990, neto: 37757.26, financieraCompleta: true, fechaOrden: '2026-10-08T15:00:00.000Z', ...extra });
  e.State.meliOrdenes = [orden(1, [{ meli_item_id: 'M1', titulo: 'Khamrah', cantidad: 1, stock_id: 's1' }]),
                         orden(2, [{ meli_item_id: 'M2', titulo: 'Armaf', cantidad: 1, stock_id: 's2' }])];
  // elementos persistentes para poder mirar lo que el cuadro escribe después de buscar
  const reg = {}; const original = e.ctx.document.getElementById;
  e.ctx.document.getElementById = id => reg[id] || original(id);
  let html = '';
  e.ctx.document.createElement = () => ({ id: '', style: {}, set innerHTML(v) { html = v; }, get innerHTML() { return html; }, remove() { delete reg['meliord-overlay']; } });
  e.ctx.document.body.appendChild = el => { reg['meliord-overlay'] = el; };
  reg['meliord-cand-1'] = { innerHTML: '', textContent: '' };

  // La tarjeta ya no trae casilla de cotización con valor
  e.mod.MeliOrdenes._filtro = 'todas';
  const tarjeta = e.mod.MeliOrdenes._vista();
  check('La tarjeta ya NO trae cotización precargada: solo el botón «Procesar…» que abre el cuadro', !tarjeta.includes('meliord-cot-') && /abrirProcesar\(1\)/.test(tarjeta));

  // Sin consulta a la base posible: el cuadro igual abre y lo dice
  e.cfg.supaFrom = () => consultaFalsa({ data: null, error: { message: 'caída' } });
  await e.mod.MeliOrdenes.abrirProcesar(1);
  check('Cuadro: casilla de cotización VACÍA (sin value) y botón Procesar deshabilitado', /id="meliord-cot-1" value=""/.test(html) && /id="meliord-go-1" disabled/.test(html), html.slice(0, 300));
  check('Cuadro: muestra stock actual (3), lo que baja (−1) y lo que quedaría (2)', /Lattafa Khamrah[\s\S]*?<td[^>]*>3<\/td>[\s\S]*?−1[\s\S]*?>2</.test(html), html.replace(/\s+/g, ' ').slice(300, 900));
  check('Cuadro: atajo «Mi referencia» con la de Franco; sin dato de mercado NO ofrece «Blue de mercado hoy»', html.includes('Mi referencia: $1.570') && !html.includes('Blue de mercado hoy'));
  check('Si no se pudo consultar la base: lo dice, no afirma que no hay duplicado', reg['meliord-cand-1'].innerHTML.includes('No se pudo revisar si ya está cargada'), reg['meliord-cand-1'].innerHTML);

  e.State.mercadoBlue = { valor: 1540, en: Date.now() };
  await e.mod.MeliOrdenes.abrirProcesar(1);
  check('Con el blue de mercado reciente aparece el atajo «Blue de mercado hoy: $1.540»', html.includes('Blue de mercado hoy: $1.540'));
  e.State.mercadoBlue = { valor: 1540, en: Date.now() - 31 * 60 * 1000 };
  await e.mod.MeliOrdenes.abrirProcesar(1);
  check('Un dato de mercado de hace más de 30 minutos NO se ofrece', !html.includes('Blue de mercado hoy'));
  e.State.mercadoBlue = { valor: NaN, en: Date.now() };
  await e.mod.MeliOrdenes.abrirProcesar(1);
  check('Un dato de mercado inválido NO se ofrece', !html.includes('Blue de mercado hoy'));

  // Stock que quedaría negativo
  reg['meliord-cand-2'] = { innerHTML: '', textContent: '' };
  await e.mod.MeliOrdenes.abrirProcesar(2);
  check('Stock que quedaría en −1: aviso rojo «quedaría negativo»', html.includes('quedaría negativo'));

  // Habilitación del botón: cotización válida Y casilla
  const btn = { disabled: true }; reg['meliord-go-1'] = btn;
  const cambiar = (cot, ok) => { e.dom['meliord-cot-1'] = cot; e.dom['meliord-ok-1'] = ok; e.mod.MeliOrdenes._cuadroCambio(1); return btn.disabled; };
  check('Botón Procesar: deshabilitado sin cotización, sin casilla, con cotización 0 o NaN', cambiar('', true) && cambiar('1540', false) && cambiar('0', true) && cambiar('abc', true));
  check('Botón Procesar: habilitado con cotización válida y la casilla tildada', cambiar('1540', true) === false);
  e.mod.MeliOrdenes._ponerCot(1, 1500);
  check('Un atajo escribe la cotización en la casilla', e.dom['meliord-cot-1'] === 1500);

  // procesar() exige la casilla aunque alguien llame directo
  llamadas.length = 0; e.dom['meliord-cot-1'] = '1540'; e.dom['meliord-ok-1'] = false;
  await e.mod.MeliOrdenes.procesar(1, { disabled: false });
  check('Procesar sin la casilla tildada NO llama a la base', llamadas.length === 0 && e.toasts.some(t => t.includes('casilla')));
  llamadas.length = 0; delete e.mod.MeliOrdenes._firmas[1]; e.dom['meliord-cot-1'] = '1540'; e.dom['meliord-ok-1'] = true;
  await e.mod.MeliOrdenes.procesar(1, { disabled: false });
  check('Procesar llamado directo, sin haber abierto el cuadro: NO procesa', !llamadas.some(l => l.fn === 'meli_procesar_orden') && e.toasts.some(t => t.includes('Abrí «Procesar»')));
  e.mod.MeliOrdenes._firmas[1] = e.mod.MeliOrdenes._firma(e.State.meliOrdenes.find(o => o.id === 1));
  e.dom['meliord-ok-1'] = true; e.dom['meliord-cot-1'] = '';
  await e.mod.MeliOrdenes.procesar(1, { disabled: false });
  check('Procesar sin cotización NO llama a la base', llamadas.length === 0);
  e.dom['meliord-cot-1'] = '1540';
  await e.mod.MeliOrdenes.procesar(1, { disabled: false });
  check('Con cotización y casilla: revisa y procesa con ESA cotización', llamadas.map(l => l.fn).join(',') === 'meli_orden_revalidar,meli_procesar_orden' && llamadas[1].args.p_cotizacion === 1540);

  // Búsqueda de ventas parecidas
  const o1 = e.State.meliOrdenes[0];
  const ventasBase = [
    { id: 10, cliente: 'Ana', tipo_venta: 'minorista', fecha_venta: '2026-10-07T12:00:00.000Z', creado_en: '2026-10-07T12:00:00.000Z', estado: null, meli_orden_id: null },
    { id: 11, cliente: 'Anulada', tipo_venta: 'minorista', fecha_venta: '2026-10-08T12:00:00.000Z', creado_en: '2026-10-08T12:00:00.000Z', estado: 'anulada', meli_orden_id: null },
    { id: 12, cliente: 'Otra orden MELI', tipo_venta: 'mercadolibre', fecha_venta: '2026-10-08T12:00:00.000Z', creado_en: '2026-10-08T12:00:00.000Z', estado: null, meli_orden_id: 9 },
    { id: 13, cliente: 'Lejos', tipo_venta: 'minorista', fecha_venta: '2026-10-12T20:00:00.000Z', creado_en: '2026-10-12T20:00:00.000Z', estado: null, meli_orden_id: null },
  ];
  const itemsBase = [{ venta_id: 10, stock_id: 's1', nombre: 'Khamrah', precio_usd: 40 }, { venta_id: 13, stock_id: 's1', nombre: 'Khamrah', precio_usd: 40 }, { venta_id: 11, stock_id: 's1', nombre: 'x', precio_usd: 1 }];
  e.cfg.supaFrom = t => consultaFalsa(t === 'ventas' ? { data: ventasBase, error: null } : { data: itemsBase.filter(i => ventasBase.some(v => v.id === i.venta_id)), error: null });
  const r1 = await e.mod.MeliOrdenes._buscarCandidatas(o1);
  check('Candidatas: solo la venta manual cercana con el mismo producto (excluye anulada, de MELI y la de 4 días después)', r1.ok && r1.lista.length === 1 && r1.lista[0].ventaId === 10, JSON.stringify(r1));
  reg['meliord-cand-1'] = { innerHTML: '', textContent: '' };
  await e.mod.MeliOrdenes.abrirProcesar(1);
  check('El cuadro avisa «Puede estar cargada ya» con la venta #10', reg['meliord-cand-1'].innerHTML.includes('Puede estar cargada ya') && reg['meliord-cand-1'].innerHTML.includes('#10'), reg['meliord-cand-1'].innerHTML);
  e.cfg.supaFrom = t => consultaFalsa({ data: [], error: null });
  reg['meliord-cand-1'] = { innerHTML: '', textContent: '' };
  await e.mod.MeliOrdenes.abrirProcesar(1);
  check('Sin candidatas: dice «Sin coincidencias en lo consultado» y aclara que no garantiza', reg['meliord-cand-1'].textContent.includes('Sin coincidencias en lo consultado') && reg['meliord-cand-1'].textContent.includes('no garantiza'));
  e.cfg.supaFrom = t => consultaFalsa({ data: new Array(500).fill(ventasBase[0]), error: null });
  const r2 = await e.mod.MeliOrdenes._buscarCandidatas(o1);
  check('Si la consulta devuelve el tope (puede estar truncada): NO se afirma nada (ok:false)', r2.ok === false);
  const r3 = await e.mod.MeliOrdenes._buscarCandidatas({ ...o1, fechaOrden: 'no es fecha' });
  check('Fecha de orden inválida: ok:false', r3.ok === false);
  const r4 = await e.mod.MeliOrdenes._buscarCandidatas({ ...o1, items: [] });
  check('Orden sin productos vinculados: sin candidatas y sin consultar', r4.ok && r4.lista.length === 0);

  // Fecha sin hora: días calendario de Argentina, ±3 inclusivos (orden del 8/10 20:00 AR = 23:00Z)
  const oTarde = { ...o1, fechaOrden: '2026-10-08T23:00:00.000Z' };
  e.cfg.supaFrom = t => consultaFalsa(t === 'ventas'
    ? { data: [{ id: 20, cliente: 'Borde', tipo_venta: 'minorista', fecha_venta: '2026-10-05', creado_en: '2026-10-05T12:00:00Z', estado: null, meli_orden_id: null },
               { id: 21, cliente: 'Fuera', tipo_venta: 'minorista', fecha_venta: '2026-10-04', creado_en: '2026-10-04T12:00:00Z', estado: null, meli_orden_id: null }], error: null }
    : { data: [{ venta_id: 20, stock_id: 's1', nombre: 'K', precio_usd: 1 }, { venta_id: 21, stock_id: 's1', nombre: 'K', precio_usd: 1 }], error: null });
  const r5 = await e.mod.MeliOrdenes._buscarCandidatas(oTarde);
  check('Una venta del 5/10 (fecha sin hora) SÍ es candidata de una orden del 8/10 a las 20:00 (3 días, inclusivo); la del 4/10 no', r5.ok && r5.lista.map(x => x.ventaId).join() === '20', JSON.stringify(r5));

  // Dos publicaciones vinculadas a la MISMA fila de stock bajan juntas
  e.State.stock = [{ id: 's1', nombre: 'Khamrah', cantidad: 1 }];
  e.State.meliOrdenes.push(orden(5, [{ meli_item_id: 'A', titulo: 'a', cantidad: 1, stock_id: 's1' }, { meli_item_id: 'B', titulo: 'b', cantidad: 1, stock_id: 's1' }]));
  e.cfg.supaFrom = () => consultaFalsa({ data: [], error: null });
  reg['meliord-cand-5'] = { innerHTML: '', textContent: '' };
  await e.mod.MeliOrdenes.abrirProcesar(5);
  check('Dos ítems de la misma fila de stock: UNA fila con baja −2 y «quedaría negativo» (no dos filas con 0)', (html.match(/<tr><td/g) || []).length === 1 && html.includes('−2') && html.includes('quedaría negativo'), html.replace(/\s+/g, ' ').slice(400, 900));

  // Si el vínculo cambia mientras el cuadro está abierto, NO se procesa lo viejo
  e.State.stock = [{ id: 's1', nombre: 'Khamrah', cantidad: 3 }, { id: 's2', nombre: 'Armaf', cantidad: 3 }];
  e.cfg.supaFrom = () => consultaFalsa({ data: [], error: null });
  await e.mod.MeliOrdenes.abrirProcesar(1);
  e.State.meliOrdenes.find(x => x.id === 1).items = [{ meli_item_id: 'M1', titulo: 'Khamrah', cantidad: 1, stock_id: 's2' }];   // otra pestaña lo revinculó
  llamadas.length = 0; e.dom['meliord-cot-1'] = '1540'; e.dom['meliord-ok-1'] = true;
  await e.mod.MeliOrdenes.procesar(1, { disabled: false });
  check('Vínculo cambiado con el cuadro abierto: NO llama a procesar y pide volver a verificar', !llamadas.some(l => l.fn === 'meli_procesar_orden') && e.toasts.some(t => t.includes('Cambió el producto vinculado')));
  e.State.meliOrdenes.find(x => x.id === 1).items = [{ meli_item_id: 'M1', titulo: 'Khamrah', cantidad: 1, stock_id: 's1' }];

  // Si no se puede releer la orden antes de procesar: NO se procesa
  await e.mod.MeliOrdenes.abrirProcesar(1);
  const dbCargar = e.ctx.DB.cargarMeliOrdenes;
  e.ctx.DB.cargarMeliOrdenes = async () => { e.State.meliError = true; e.State.meliOrdenes = []; };
  llamadas.length = 0; e.dom['meliord-cot-1'] = '1540'; e.dom['meliord-ok-1'] = true;
  await e.mod.MeliOrdenes.procesar(1, { disabled: false });
  check('Si falla la relectura de la orden: NO llama a procesar y avisa', !llamadas.some(l => l.fn === 'meli_procesar_orden') && e.toasts.some(t => t.includes('No se pudo confirmar el estado actual')));
  e.ctx.DB.cargarMeliOrdenes = dbCargar; e.State.meliError = false;
  e.State.meliOrdenes = [orden(1, [{ meli_item_id: 'M1', titulo: 'Khamrah', cantidad: 1, stock_id: 's1' }]), orden(2, [{ meli_item_id: 'M2', titulo: 'Armaf', cantidad: 1, stock_id: 's2' }]), orden(5, [{ meli_item_id: 'A', titulo: 'a', cantidad: 1, stock_id: 's1' }, { meli_item_id: 'B', titulo: 'b', cantidad: 1, stock_id: 's1' }])];

  // Un cuadro viejo no cierra al nuevo
  await e.mod.MeliOrdenes.abrirProcesar(1);
  const tokViejo = e.mod.MeliOrdenes._cuadroTok;
  await e.mod.MeliOrdenes.abrirProcesar(5);
  reg['meliord-overlay'] = { remove() { e.cerrado = true; } };
  e.cerrado = false;
  e.mod.MeliOrdenes.cerrarCuadro(tokViejo);
  check('Cerrar con la instancia vieja NO cierra el cuadro nuevo', e.cerrado === false);
  e.mod.MeliOrdenes.cerrarCuadro(e.mod.MeliOrdenes._cuadroTok);
  check('Cerrar con la instancia actual sí lo cierra', e.cerrado === true);
}

// 41. DETALLE DE VENTA de Mercado Libre: el desglose no inventa nada
{
  const e = nuevoEntorno({ modulos: ['meli-ordenes.js'], dbExtra: { async cargarTodo() {}, async cargarMeliOrdenes() {} } });
  const M = e.mod.MeliOrdenes;
  const lattafa = { id: 1, orderId: '2000018883051330', bruto: 65990, neto: 37757.26, financieraCompleta: true, comprador: 'USUARIO<b>x</b>', fechaOrden: '2026-10-08T15:00:00Z',
    procesada: false, acreditado: false, revisar: false, fechaLiberacion: '2099-01-01T00:00:00Z',
    items: [{ titulo: 'Khamrah <img src=x>', cantidad: 1, stock_id: 's1', precio_unitario: 65990 }] };
  const todas = { cargoVenta: 18952.89, envio: 8290, impuestos: 989.85 };
  let d = M._desglose(lattafa, todas);
  check('Caso real Lattafa con las tres partes: retenido 28.232,74 y CUADRA (65.990 − 18.952,89 − 8.290 − 989,85 = 37.757,26)', d.confirmado && d.retenido === 28232.74 && d.estado === 'cuadra', JSON.stringify(d));
  d = M._desglose(lattafa, { ...todas, impuestos: 900 });
  check('Si las tres partes no suman el retenido: «no_cuadra» con la diferencia (89,85)', d.estado === 'no_cuadra' && Math.abs(d.diferencia - 89.85) < 0.005, JSON.stringify(d));
  d = M._desglose(lattafa, { cargoVenta: 18952.89, envio: 8290 });
  check('Con dos de tres partes: «parcial», NUNCA «cuadra»; el resto queda como «sin desglosar» (no se le asigna a nadie)', d.estado === 'parcial' && Math.abs(d.restoSinDesglosar - 989.85) < 0.005, JSON.stringify(d));
  d = M._desglose(lattafa, {});
  check('Hoy (sin partes guardadas): «sin_desglose», solo el total retenido', d.estado === 'sin_desglose' && d.retenido === 28232.74 && d.partes.every(x => x.monto === null));
  d = M._desglose({ ...lattafa, financieraCompleta: false }, todas);
  check('Pagos sin confirmar (financieraCompleta falso): «incompleto», sin retenido ni «cuadra» aunque lleguen las partes', d.estado === 'incompleto' && d.retenido === null);
  d = M._desglose({ ...lattafa, neto: null }, todas);
  check('Neto nulo: «incompleto» (nunca se trata como 0)', d.estado === 'incompleto' && d.retenido === null);
  d = M._desglose({ ...lattafa, bruto: 1000, neto: 500, financieraCompleta: false }, {});
  check('Neto parcial de un pago aprobado con otro pendiente: no se presenta como cargos', d.estado === 'incompleto' && d.retenido === null);
  d = M._desglose(lattafa, { cargoVenta: '', envio: 'abc', impuestos: NaN });
  check('Partes vacías o no numéricas cuentan como desconocidas', d.estado === 'sin_desglose');

  // La pantalla
  let html = ''; const reg = {};
  const original = e.ctx.document.getElementById;
  e.ctx.document.getElementById = id => reg[id] || original(id);
  e.ctx.document.createElement = () => ({ id: '', style: {}, set innerHTML(v) { html = v; }, get innerHTML() { return html; }, remove() { html = ''; } });
  e.ctx.document.body.appendChild = () => {};
  e.State.stock = [{ id: 's1', nombre: 'Lattafa Khamrah' }];
  e.State.meliOrdenes = [lattafa];
  M.abrirDetalle(1);
  const txt = html.replace(/\s+/g, ' ');
  check('Detalle HOY: venta, «sin desglose todavía» ×3, total que se queda MELI 28.232,74 y te llega 37.757,26; no dice «Cuadra»',
    txt.includes('$65.990,00') && (txt.match(/sin desglose todavía/g) || []).length === 3 && txt.includes('−$28.232,74') && txt.includes('$37.757,26') && !txt.includes('✓ Cuadra'), txt.slice(0, 1500));
  check('Detalle: comprador y títulos ESCAPADOS, sin nombre/DNI/dirección y localidad «—»', !html.includes('<b>x</b>') && !html.includes('<img src=x>') && html.includes('localidad —'));
  check('Detalle: muestra precio unitario y el vínculo de stock', txt.includes('$65.990,00 c/u') && txt.includes('→ Stock: Lattafa Khamrah'));
  check('Detalle: liberación con cuánto falta', /se libera .* \(en \d+ días?\)/.test(txt));
  check('Detalle: sin venta, no aparece el bloque «Venta en el CRM»', !txt.includes('Venta en el CRM'));
  e.State.meliOrdenes = [{ ...lattafa, ...{ cargoVenta: 18952.89, envioVendedor: 8290, impuestos: 989.85 } }];
  M.abrirDetalle(1);
  check('Detalle con las tres partes guardadas: muestra cada una y «✓ Cuadra»', html.includes('−$18.952,89') && html.includes('−$8.290,00') && html.includes('−$989,85') && html.includes('✓ Cuadra'));
  e.State.meliOrdenes = [{ ...lattafa, financieraCompleta: false }];
  M.abrirDetalle(1);
  check('Detalle con datos de pago incompletos: lo dice y no calcula retenido', html.includes('Datos de pago incompletos') && !html.includes('Total que se queda'));

  // Orden procesada con su venta
  e.mod.Ventas = { resultadoVenta: () => ({ costoCanal: 0, margenComercial: 12.5 }) };
  e.State.ventas = [{ id: 9, meliCotizacion: 1540, items: [{ precio: 40 }] }];
  e.State.meliOrdenes = [{ ...lattafa, procesada: true, ventaId: 9 }];
  M.abrirDetalle(1);
  let t2 = html.replace(/\s+/g, ' ');
  check('Procesada y SIN acreditar: venta #9, cotización 1.540, costo «se fija al acreditar» y margen rotulado PROVISORIO', t2.includes('#9') && t2.includes('$1.540') && t2.includes('se fija al acreditar') && t2.includes('Margen provisorio'));
  e.mod.Ventas = { resultadoVenta: () => ({ costoCanal: 18.3, margenComercial: 9.1 }) };
  e.State.meliOrdenes = [{ ...lattafa, procesada: true, ventaId: 9, acreditado: true }];
  M.abrirDetalle(1);
  t2 = html.replace(/\s+/g, ' ');
  check('Acreditada: muestra el costo de comisión y envío real y «Margen comercial» (ya no provisorio)', t2.includes('USD 18,3') && t2.includes('Margen comercial') && !t2.includes('provisorio'));
  e.State.ventas = [];
  M.abrirDetalle(1);
  check('Procesada pero sin la venta en memoria: «datos no disponibles» (no inventa)', html.includes('datos no disponibles'));

  // «Ver cómo se calculó»
  e.State.meliOrdenes = [lattafa];
  M.abrirDetalle(1);
  reg['meliord-calc-1'] = { innerHTML: '' };
  e.cfg.supaFrom = () => consultaFalsa({ data: { payload_pago: { pagos: [{ id: 123, status: 'approved<script>', transaction_amount: 65990, net_received_amount: 37757.26, email: 'secreto@x.com', fee_details: [] }], conciliacion: { declarada: 0, diferencia_sin_explicar: 28232.74, cobrado_aprobado: 65990, cubierto: true } } }, error: null });
  await M.verComoSeCalculo(1, null);
  const c = reg['meliord-calc-1'].innerHTML;
  check('«Ver cómo se calculó»: muestra importes del pago y aclara que los cargos informados NO son el desglose; escapa y no vuelca campos personales', c.includes('$37.757,26') && c.includes('NO es el desglose') && c.includes('$28.232,74') && !c.includes('<script>') && !c.includes('secreto@x.com'), c);
  e.cfg.supaFrom = () => consultaFalsa({ data: null, error: { message: 'x' } });
  await M.verComoSeCalculo(1, null);
  check('Si falla la lectura del pago: lo dice', reg['meliord-calc-1'].innerHTML.includes('No se pudo leer el detalle del pago'));
  e.cfg.supaFrom = () => consultaFalsa({ data: { payload_pago: null }, error: null });
  await M.verComoSeCalculo(1, null);
  check('Sin payload de pago: dice que todavía no hay datos', reg['meliord-calc-1'].innerHTML.includes('Todavía no hay datos del pago'));
  // La tarjeta tiene el botón
  e.State.meliOrdenes = [lattafa]; M._filtro = 'todas';
  check('La tarjeta de cada orden tiene el botón «Detalle»', /MeliOrdenes\.abrirDetalle\(1\)/.test(M._vista()));
}

// 42. PLAN CONVERSIONES · FASE A: convertir de más, comisión prorrateada al lote, varias conversiones, filas viejas
{
  const filas = [];
  const mk = (dom, extraDom = {}, cfgx = {}) => {
    const e = nuevoEntorno({ modulos: ['proveedores.js', 'capital.js'], dom: { 'conv-monto': '10000', 'conv-pct': '3', 'conv-usdt-lote': '8790', 'conv-p-origen': 'Franco', 'conv-b-origen': 'USD cash',
      'conv-p-dest': 'Franco', 'conv-b-dest': 'USDT', 'conv-fecha': '2026-10-10', 'conv-notas': '', ...dom, ...extraDom },
      dbExtra: { async guardarLotePago(loteId, p) { e.filas.push(p); e.State.lotePagos.push({ id: Math.random(), loteId, ...p }); return true; } } });
    Object.assign(e.cfg, cfgx);
    e.filas = [];
    e.sembrar({ Franco: { 'USD cash': 20000, 'USDT': 0 } });
    Object.assign(e.mod.Proveedores, { renderKpis() {}, renderContent() {} });
    Object.assign(e.State, { lotesCompra: [{ id: 1, proveedorId: 1, estado: 'pagado' }], loteItems: [{ loteId: 1, precioUsd: 8790, cantidad: 1 }], lotePagos: [], proveedorCreditos: [],
      proveedores: [{ id: 1, nombre: 'P', activo: true }], activosFijos: [], inversores: [], inversorPagos: [], deudas: [], ventas: [] });
    e.State.refBlue = 1000; e.State.refUsdt = 1000;
    return e;
  };

  // Caso real: 10.000 USD, 3 %, el lote usa 8.790
  {
    const e = mk();
    await e.mod.Proveedores._confirmarConversion(1);
    const f = e.filas[0] || {};
    check('Caso real: salen 10.000 USD y entran 9.700 USDT (un solo traspaso por el TOTAL)', e.base['Franco||USD cash'] === 10000 && e.base['Franco||USDT'] === 9700, JSON.stringify(e.base));
    check('La fila guarda total 10.000 → 9.700, comisión 300, y para el lote: 8.790 USDT con comisión 271,86',
      f.montoUsd === 10000 && f.montoUsdt === 9700 && f.comisionUsd === 300 && f.usdtLote === 8790 && f.comisionLoteUsd === 271.86, JSON.stringify(f));
    check('… y el libro cuadra', cuadra(e.base, e.libro).length === 0, cuadra(e.base, e.libro).join(' | '));
    e.State.lotePagos.push({ id: 99, loteId: 1, tipo: 'pago_proveedor', montoUsd: 8790, montoUsdt: 8790, moneda: 'USDT' });
    const c = e.mod.Proveedores._cuentaLote(1);
    check('Con 8.790 pagados al proveedor el lote queda SALDADO y su costo incluye 271,86 de comisión (no 300)', c.restante === 0 && c.excedenteBruto === 0 && c.comision === 271.86 && c.costoAdquisicion === 9061.86, JSON.stringify(c));
    const cap = e.mod.Capital.calcular();
    check('Capital en tránsito: 8.790 pagados + 271,86 de comisión del lote = 9.061,86 (el sobrante queda en la caja USDT)', Math.abs(cap.pedidosEnTransito - 9061.86) < 0.005, String(cap.pedidosEnTransito));
  }
  // Vacío = todos
  {
    const e = mk({ 'conv-usdt-lote': '', 'conv-monto': '1000', 'conv-pct': '2' });
    await e.mod.Proveedores._confirmarConversion(1);
    const f = e.filas[0] || {};
    check('USDT del lote vacío = usa todos: usdtLote 980 y comisión del lote = la total (20)', f.usdtLote === 980 && f.comisionLoteUsd === 20, JSON.stringify(f));
  }
  // Validaciones: no se mueve plata
  for (const [txt, v] of [['más de lo recibido', '9700.01'], ['cero', '0'], ['negativo', '-5'], ['no numérico', 'abc']]) {
    const e = mk({ 'conv-usdt-lote': v });
    await e.mod.Proveedores._confirmarConversion(1);
    check(`USDT del lote ${txt}: NO se mueve plata ni se anota nada`, e.base['Franco||USD cash'] === 20000 && e.base['Franco||USDT'] === 0 && e.filas.length === 0 && e.toasts.length > 0, JSON.stringify([e.base, e.toasts]));
  }
  {
    const e = mk({ 'conv-pct': '100' });
    await e.mod.Proveedores._confirmarConversion(1);
    check('Comisión del 100 %: rechazada antes de mover nada', e.filas.length === 0 && e.base['Franco||USD cash'] === 20000);
  }
  // Columnas del script 14
  {
    const e = mk({}, {}, { columnasConversion: false });
    await e.mod.Proveedores._confirmarConversion(1);
    check('Con sobrante y SIN el script 14 corrido: bloquea ANTES de mover plata y nombra el script', e.filas.length === 0 && e.base['Franco||USD cash'] === 20000 && e.toasts.some(t => t.includes('script 14')), JSON.stringify(e.toasts));
    const u = mk({}, {}, { columnasConversion: null });
    await u.mod.Proveedores._confirmarConversion(1);
    check('Con sobrante y sin poder comprobar la base: tampoco mueve plata', u.filas.length === 0 && u.base['Franco||USD cash'] === 20000 && u.toasts.some(t => t.includes('No se pudo comprobar')));
    const n = mk({ 'conv-usdt-lote': '' }, {}, { columnasConversion: false });
    await n.mod.Proveedores._confirmarConversion(1);
    check('SIN sobrante y sin las columnas: sigue como siempre (se mueve y se anota SIN columnas nuevas)', n.base['Franco||USDT'] === 9700 && n.filas.length === 1 && n.filas[0].usdtLote == null && n.filas[0].comisionLoteUsd == null, JSON.stringify(n.filas));
  }
  // Hallazgos de Codex: doble clic, centavos, comisión negativa, excepción al registrar, sugerencia con otras monedas
  {
    const e = mk();
    await Promise.all([e.mod.Proveedores._confirmarConversion(1), e.mod.Proveedores._confirmarConversion(1)]);
    check('Doble clic en Confirmar: UNA sola conversión (un traspaso y un registro)', e.filas.length === 1 && e.base['Franco||USDT'] === 9700 && e.base['Franco||USD cash'] === 10000, JSON.stringify([e.filas.length, e.base]));
    await e.mod.Proveedores._confirmarConversion(1);
    check('Después de terminar, se puede volver a convertir (la guarda se libera)', e.filas.length === 2);
  }
  {
    const e = mk({ 'conv-monto': '12.43', 'conv-pct': '9.1', 'conv-usdt-lote': '9.95' });
    const r = e.mod.Proveedores._leerConversion();
    check('Prorrateo en centavos enteros: 12,43 USD a 9,1 % → comisión 1,13, recibe 11,30, el lote usa 9,95 → comisión del lote 1,00 (la mitad sube)', r.comisionUsd === 1.13 && r.montoUsdt === 11.3 && r.comisionLote === 1 && r.sobrante === 1.35, JSON.stringify(r));
    const real = mk().mod.Proveedores._leerConversion();
    check('El caso real sigue dando 271,86', real.comisionLote === 271.86 && real.sobrante === 910);
  }
  for (const pct of ['-3', 'abc', '100', '150']) {
    const e = mk({ 'conv-pct': pct });
    await e.mod.Proveedores._confirmarConversion(1);
    check(`Comisión «${pct}»: se rechaza ANTES de mover plata`, e.filas.length === 0 && e.base['Franco||USD cash'] === 20000 && e.toasts.some(t => t.includes('comisión')), JSON.stringify(e.toasts));
  }
  {
    const e = mk();
    e.ctx.DB.guardarLotePago = async () => { throw new Error('se cortó'); };
    await e.mod.Proveedores._confirmarConversion(1);
    check('Si registrar la conversión TIRA una excepción: la plata queda movida, NO se devuelve sola y se avisa que no se sabe si quedó anotada',
      e.base['Franco||USDT'] === 9700 && e.base['Franco||USD cash'] === 10000 && e.toasts.some(t => t.includes('no se sabe si quedó anotada')), JSON.stringify([e.base, e.toasts]));
    check('… y la guarda se libera para poder reintentar', e.mod.Proveedores._convEnCurso === false);
  }
  {
    const e = mk();
    let html = '';
    e.ctx.document.createElement = () => ({ id: '', style: {}, set innerHTML(v) { html = v; }, get innerHTML() { return html; }, remove() {} });
    const sug = () => { e.mod.Proveedores.modalPago(1); const m = html.match(/id="pago-monto"[^>]*?value="([^"]*)"/s); return m ? m[1] : null; };
    e.State.loteItems = [{ loteId: 1, precioUsd: 1000, cantidad: 1 }];
    e.State.lotePagos = [{ id: 1, loteId: 1, tipo: 'conversion', montoUsd: 520, montoUsdt: 500, comisionUsd: 20, usdtLote: 500, comisionLoteUsd: 20 },
                         { id: 2, loteId: 1, tipo: 'pago_proveedor', montoUsd: 300, montoUsdt: 300, moneda: 'USD' }];
    check('Un pago directo en USD NO gasta los USDT del lote: debe 700, sugiere 500 (no 200)', sug() === '500.00', String(sug()));
    e.State.lotePagos.push({ id: 3, loteId: 1, tipo: 'pago_proveedor', montoUsd: 500, montoUsdt: 500, moneda: 'USDT' });
    check('Agotados los USDT del lote (aunque aún se deba plata): NO sugiere nada, para no gastar el sobrante', sug() === '', String(sug()));
  }
  // Vista previa
  {
    const e = mk();
    const reg = {}; const orig = e.ctx.document.getElementById;
    e.ctx.document.getElementById = id => (id === 'conv-resumen' ? (reg[id] = reg[id] || { innerHTML: '' }) : orig(id));
    e.mod.Proveedores._calcConv();
    const t = reg['conv-resumen'].innerHTML.replace(/\s+/g, ' ');
    check('Vista previa: USDT del lote 8.790, comisión del lote 271,86, «Sobran 910.00 USDT» a 1,0309 y comisión de esa parte 28,14', t.includes('8790.00 USDT') && t.includes('271,86') && t.includes('910.00 USDT') && t.includes('1.0309') && t.includes('28,14'), t);
  }
  // Compatibilidad con lo ya cargado
  {
    const e = mk();
    const P = e.mod.Proveedores;
    const vieja = (extra = {}) => ({ tipo: 'conversion', montoUsd: 9000, montoUsdt: 8730, comisionUsd: 270, comisionPct: 3, ...extra });
    check('Dos conversiones VIEJAS (columnas NULL): cuenta solo la primera, como hoy', P._comisionDelLote([vieja(), vieja({ comisionUsd: 50 })]) === 270 && P._usdtDelLote([vieja(), vieja({ montoUsdt: 400 })]) === 8730);
    const nueva = (u, c, extra = {}) => ({ tipo: 'conversion', montoUsd: 10000, montoUsdt: 9700, comisionUsd: 300, usdtLote: u, comisionLoteUsd: c, ...extra });
    check('Una vieja + una nueva: la vieja entera + la parte de la nueva', P._comisionDelLote([vieja(), nueva(5000, 154.64)]) === 424.64 && P._usdtDelLote([vieja(), nueva(5000, 154.64)]) === 13730);
    check('Dos conversiones NUEVAS en un lote: se suman las dos', P._comisionDelLote([nueva(5000, 154.64), nueva(3790, 118.95)]) === 273.59 && P._usdtDelLote([nueva(5000, 154.64), nueva(3790, 118.95)]) === 8790);
    check('Un 0 explícito de comisión del lote es un valor: NO cae a la comisión total', P._comisionDelLote([nueva(5000, 0)]) === 0);
    check('Sin conversiones: 0 y 0', P._comisionDelLote([]) === 0 && P._usdtDelLote([]) === 0 && P._comisionDelLote(undefined) === 0);
    check('Un pago que no es conversión no cuenta', P._comisionDelLote([{ tipo: 'pago_proveedor', comisionUsd: 99, comisionLoteUsd: 5 }]) === 0);
    check('Resumen de la tarjeta: una conversión con sobrante dice cuánto usa el lote; varias lo suman',
      P._resumenConversion([nueva(8790, 271.86)]).includes('este lote usa 8790.00 USDT') && P._resumenConversion([nueva(5000, 154.64), nueva(3790, 118.95)]).includes('2 conversiones') && P._resumenConversion([]) === '');
  }
  // Pago sugerido: lo que usa el lote, no todo lo convertido
  {
    const e = mk();
    let html = '';
    e.ctx.document.createElement = () => ({ id: '', style: {}, set innerHTML(v) { html = v; }, get innerHTML() { return html; }, remove() {} });
    const sug = () => { e.mod.Proveedores.modalPago(1); const m = html.match(/id="pago-monto"[^>]*?value="([^"]*)"/s); return m ? m[1] : null; };
    e.State.lotePagos = [{ id: 1, loteId: 1, tipo: 'conversion', montoUsd: 10000, montoUsdt: 9700, comisionUsd: 300, usdtLote: 8790, comisionLoteUsd: 271.86 }];
    check('Pago sugerido tras convertir de más: 8.790 (lo que usa el lote), no los 9.700 convertidos', sug() === '8790.00', String(sug()));
    check('El aviso del modal dice cuántos USDT son para este lote y cuántos se convirtieron en total', /8790\.00 USDT<\/b> para este lote[^<]*\(convertidos en total: 9700\.00\)/.test(html), html.replace(/\s+/g, ' ').slice(html.indexOf('Conversión registrada') - 20, html.indexOf('Conversión registrada') + 260));
    e.State.lotePagos.push({ id: 2, loteId: 1, tipo: 'pago_proveedor', montoUsd: 5000, montoUsdt: 5000, moneda: 'USDT' });
    check('Tras pagar 5.000: sugiere lo que falta (3.790)', sug() === '3790.00', String(sug()));
    e.State.lotePagos.push({ id: 3, loteId: 1, tipo: 'pago_proveedor', montoUsd: 3790, montoUsdt: 3790, moneda: 'USDT' });
    check('Saldado: no sugiere nada', sug() === '', String(sug()));
  }
  // Recepción: la logística por unidad usa la comisión DEL LOTE
  {
    const e = mk();
    e.State.lotePagos = [{ id: 1, loteId: 1, tipo: 'conversion', montoUsd: 10000, montoUsdt: 9700, comisionUsd: 300, usdtLote: 8790, comisionLoteUsd: 271.86 }];
    let html = '';
    e.ctx.document.createElement = () => ({ id: '', style: {}, set innerHTML(v) { html = v; }, get innerHTML() { return html; }, remove() {} });
    e.mod.Proveedores.modalRecepcion(1);
    check('Recepción: la logística usa la comisión del lote (271,86), no la total (300)', html.includes('271,86') && !html.includes('300,00'), html.replace(/\s+/g, ' ').slice(0, 10));
  }
}

// 43. DB REAL (supabase-config.js) · conversión con sobrante: lectura, escritura y detección de las columnas
{
  const fuente = fs.readFileSync('/Users/francovelas/crm-complete/iphonemood-crm/src/modules/supabase-config.js', 'utf8');
  const mkDB = (supa, state = {}) => {
    const ctxDB = { window: { __APP_CONFIG__: { SUPABASE_URL: 'x', SUPABASE_ANON_KEY: 'y' } }, supabase: { createClient: () => supa },
      console: { log() {}, warn() {}, error() {} }, Auth: {}, State: state, toast() {}, Date, Math, Number, JSON, String, Promise, Error };
    vm.createContext(ctxDB);
    vm.runInContext(fuente + '\nthis.__DB = DB;', ctxDB, { filename: 'supabase-config.js' });
    return ctxDB.__DB;
  };
  const insertado = [];
  const supaOk = { from: t => ({ insert: r => { insertado.push({ t, r }); return { select: () => ({ single: async () => ({ data: { id: 7 }, error: null }) }) }; },
    select: () => ({ limit: async () => ({ error: null }) }) }) };
  const st = { lotePagos: [] };
  const D1 = mkDB(supaOk, st);
  check('Columnas presentes: columnasConversionListas() = true (y se recuerda)', (await D1.columnasConversionListas()) === true && D1._colsConversion === true);
  const supaSin = { from: () => ({ select: () => ({ limit: async () => ({ error: { code: '42703', message: 'column lote_pagos.usdt_lote does not exist' } }) }) }) };
  const D2 = mkDB(supaSin);
  check('Columnas ausentes (42703): false, y NO se recuerda (se vuelve a mirar si Franco corre el script)', (await D2.columnasConversionListas()) === false && D2._colsConversion !== true);
  const supaRed = { from: () => ({ select: () => ({ limit: async () => ({ error: { code: '', message: 'Failed to fetch' } }) }) }) };
  check('Error de red/permisos: null (no se sabe), nunca false', (await mkDB(supaRed).columnasConversionListas()) === null);
  const supaTira = { from: () => ({ select: () => ({ limit: async () => { throw new Error('boom'); } }) }) };
  check('Si la consulta tira: null', (await mkDB(supaTira).columnasConversionListas()) === null);

  await D1.guardarLotePago(1, { tipo: 'conversion', montoUsd: 10000, montoUsdt: 9700, comisionPct: 3, comisionUsd: 300, usdtLote: 8790, comisionLoteUsd: 271.86 });
  check('Guardar con sobrante: manda usdt_lote y comision_lote_usd y la pantalla queda con los mismos valores',
    insertado[0].r.usdt_lote === 8790 && insertado[0].r.comision_lote_usd === 271.86 && st.lotePagos[0].usdtLote === 8790 && st.lotePagos[0].comisionLoteUsd === 271.86, JSON.stringify([insertado[0], st.lotePagos[0]]));
  await D1.guardarLotePago(1, { tipo: 'conversion', montoUsd: 1000, montoUsdt: 980, comisionPct: 2, comisionUsd: 20, usdtLote: null, comisionLoteUsd: null });
  check('Guardar como siempre (sin los dos datos): NO manda las columnas nuevas (funciona sin el script 14)', !('usdt_lote' in insertado[1].r) && !('comision_lote_usd' in insertado[1].r) && st.lotePagos[1].usdtLote === null);
  await D1.guardarLotePago(1, { tipo: 'conversion', montoUsd: 1000, montoUsdt: 980, comisionPct: 2, comisionUsd: 20, usdtLote: 500, comisionLoteUsd: 0 });
  check('Comisión del lote 0 explícita: se manda (no se confunde con «sin dato»)', insertado[2].r.comision_lote_usd === 0 && st.lotePagos[2].comisionLoteUsd === 0);
  await D1.guardarLotePago(1, { tipo: 'conversion', montoUsd: 1000, montoUsdt: 980, comisionUsd: 20, usdtLote: 500 });
  check('Solo uno de los dos datos: no se manda ninguno (la base exige las dos o ninguna)', !('usdt_lote' in insertado[3].r));
}

// 44. PANTALLA DE ACTIVIDADES (actividades.js): carga, vista, cuadro del tilde y llamadas a la base
{
  const llamadas = [];
  const e = nuevoEntorno({ modulos: ['actividades.js'], dbExtra: { async cargarTodo() { e.recargas = (e.recargas || 0) + 1; } } });
  const A = e.mod.Actividades;
  e.ctx.DB.personasIdToNombre = { u1: 'Franco', u2: 'Socio' };
  e.State.cajas = { Franco: { 'ARS Mercado Pago': 85000, 'ARS transferencia': 0, 'USD cash': 5 }, Socio: { 'ARS cash': 10 } };
  const fila = (id, extra = {}) => ({ id, tipo: 'meli_transferir', titulo: 'Transferir lo acreditado de la orden ' + id, monto: '85000.00', moneda: 'ARS', fecha_objetivo: '2026-10-12', estado: 'pendiente',
    origen_orden_id: id, origen_persona_id: 'u1', origen_bolsillo: 'ARS Mercado Pago', destino_persona_id: null, destino_bolsillo: null, movio_plata: false, nota: null, hecha_en: null, hecha_por: null, ...extra });
  let tabla = { data: [fila(2), fila(1), fila(3, { fecha_objetivo: '2026-10-10' })], error: null };
  let config = { data: null, error: null };
  const upserts = [];
  e.cfg.supaFrom = t => t === 'actividades' ? consultaActividades(tabla)
    : { select: () => consultaFalsa(config), upsert: async (r) => { upserts.push(r); return { error: null }; } };
  let rpcResp = () => ({ data: { ok: true, monto: 85000 }, error: null });
  e.cfg.supaRpc = async (fn, args) => { llamadas.push({ fn, args }); return rpcResp(fn, args); };

  // Carga
  check('Cargar: lee las actividades y las deja con sus campos (monto numérico, fecha, estado)', (await A.cargar()) === true && A._lista.length === 3 && A._lista[0].monto === 85000 && A._lista[0].estado === 'pendiente' && A._lista[0].origenBolsillo === 'ARS Mercado Pago', JSON.stringify(A._lista[0]));
  tabla = { data: null, error: { code: '42P01', message: 'relation "public.actividades" does not exist' } };
  check('Tabla ausente (script 15 sin correr): lo dice aparte y no tira', (await A.cargar()) === false && A._sinTabla === true && A._error === false && A._vista().includes('script 15'));
  tabla = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.actividades' in the schema cache" } };
  await A.cargar();
  check('PGRST205 también se reconoce como «tabla ausente»', A._sinTabla === true);
  tabla = { data: null, error: { code: '', message: 'Failed to fetch' } };
  await A.cargar();
  check('Un error de red NO se confunde con «tabla ausente»: muestra «no se pudieron leer» y el botón Actualizar', A._sinTabla === false && A._error === true && A._vista().includes('No se pudieron leer') && A._vista().includes('Actualizar'));
  e.cfg.supaFrom = () => { throw new Error('boom'); };
  check('Si la consulta tira: no propaga, queda en error', (await A.cargar()) === false && A._error === true);
  e.cfg.supaFrom = t => t === 'actividades' ? consultaActividades(tabla)
    : { select: () => consultaFalsa(config), upsert: async (r) => { upserts.push(r); return { error: null }; } };
  tabla = { data: [fila(2), fila(1), fila(3, { fecha_objetivo: '2026-10-10' }), fila(4, { estado: 'hecha', movio_plata: true, destino_persona_id: 'u1', destino_bolsillo: 'ARS transferencia', hecha_por: 'Franco', fecha_objetivo: '2026-10-11' }),
    fila(5, { estado: 'hecha', fecha_objetivo: '2026-10-11', hecha_por: 'Franco' }), fila(6, { estado: 'anulada' }), fila(7, { tipo: 'manual', titulo: 'Llamar <b>al</b> contador', monto: null, moneda: null, origen_orden_id: null, origen_persona_id: null, origen_bolsillo: null })], error: null };
  await A.cargar();

  // Las pendientes se piden aparte: una pendiente vieja no queda fuera por el tope de las hechas
  check('Las pendientes y el resto se cargan juntos y ordenados por fecha (más reciente primero)', A._lista.map(a => a.id).join() === '2,1,4,5,6,7,3' || A._lista.length === 7, A._lista.map(a => a.id).join());
  {
    const mas = Array.from({ length: 1000 }, (_, i) => fila(100 + i, { fecha_objetivo: '2026-01-01' }));
    const guardado = tabla; tabla = { data: mas, error: null };
    await A.cargar();
    check('Con 1.000 pendientes (el tope) se avisa que se muestran las más recientes', A._pendientesTruncadas === true && A._vista().includes('Hay más de 1.000 pendientes'));
    tabla = guardado; await A.cargar();
    check('Con menos pendientes no hay aviso', A._pendientesTruncadas === false);
  }
  // Configuración: ausente ≠ falla
  {
    config = { data: null, error: { message: 'permiso denegado' } };
    A._cajaEmpresa = { persona: 'Socio', bolsillo: 'ARS cash' };
    await A.cargar();
    check('Si falla la lectura de la caja predeterminada se CONSERVA la anterior (no se pierde la preferencia)', A._configFalla === true && A._cajaEmpresa && A._cajaEmpresa.persona === 'Socio');
    A._cajaEmpresa = null; await A.cargar();
    const posibles = A._destinosPosibles('Franco', 'ARS Mercado Pago');
    check('Falla la lectura y no hay ninguna anterior: NO se elige «Franco · ARS transferencia» en silencio (obliga a elegir)', A._destinoPredeterminado(posibles) === null);
    config = { data: null, error: null }; await A.cargar();
    check('Configuración simplemente ausente: sí se usa «Franco · ARS transferencia»', A._configFalla === false && A._destinoPredeterminado(posibles)?.bolsillo === 'ARS transferencia');
  }

  // Aviso del menú
  check('Pendientes vencidas: las de hoy o anteriores (día de Argentina)', A.pendientesVencidas(A._lista, '2026-10-12').length === 4 && A.pendientesVencidas(A._lista, '2026-10-11').length === 1 && A.pendientesVencidas(A._lista, '2026-10-09').length === 0);
  check('El día de Argentina: 02:30 UTC del 13/10 es el 12/10', A._hoyAR(new Date('2026-10-13T02:30:00Z')) === '2026-10-12' && A._hoyAR(new Date('2026-10-13T03:00:00Z')) === '2026-10-13');
  const badge = { style: {}, textContent: '' }; const orig = e.ctx.document.getElementById;
  e.ctx.document.getElementById = id => id === 'badge-actividades' ? badge : orig(id);
  A.actualizarBadge();
  check('El badge muestra la cantidad de pendientes vencidas y se oculta en cero', badge.style.display === 'inline-flex' && String(badge.textContent) === String(A.pendientesVencidas().length));
  const guardada = A._lista; A._lista = []; A.actualizarBadge();
  check('Sin pendientes el badge se oculta', badge.style.display === 'none');
  A._lista = guardada;
  e.ctx.document.getElementById = orig;
  A.actualizarBadge();   // sin el elemento: no tira
  check('Sin el elemento del badge no tira', true);

  // Vista
  A._filtro = 'pendientes';
  let h = A._vista();
  check('Vista pendientes: agrupa por día y ofrece transferir las N del día (los dos del 12/10) con el total', h.includes('12/10/2026') && h.includes('10/10/2026') && /Transferir las 2 de este día \(\$170\.000,00\)/.test(h), h.slice(0, 600));
  check('Cada pendiente de transferencia tiene «Transferir…» y «Anular»; la manual «Marcar como hecha»', /abrirTransferir\(\[1\]\)/.test(h) && /Actividades\.anular\(1,/.test(h) && /Actividades\.marcar\(7,/.test(h));
  check('El título viene ESCAPADO (no se interpreta HTML)', !h.includes('<b>al</b>') && h.includes('&lt;b&gt;al&lt;/b&gt;'));
  check('Muestra «hoy» solo si es la fecha de hoy y «atrasadas» para las anteriores (con un reloj fijo)', (() => { const o = A._hoyAR; A._hoyAR = () => '2026-10-12'; const t = A._vista(); A._hoyAR = o; return t.includes('· hoy') && t.includes('· atrasadas'); })());
  A._filtro = 'hechas'; h = A._vista();
  check('Hechas: la que movió plata muestra destino y «Deshacer transferencia»; la que no, el aviso y «Reabrir»', h.includes('Socio') === false && /Franco · ARS transferencia/.test(h) && /Actividades\.compensar\(4,/.test(h) && /Actividades\.reabrir\(5,/.test(h) && h.includes('la caja de Mercado Pago conserva ese saldo'), h.slice(0, 500));
  A._filtro = 'anuladas'; h = A._vista();
  check('Anuladas: sin botones de acción', h.includes('Anulada') && !/onclick="Actividades\.(transferir|marcar|reabrir|compensar|anular)/.test(h));
  A._filtro = 'pendientes';

  // Cuadro del tilde
  const reg = {}; const getOrig = e.ctx.document.getElementById;
  e.ctx.document.getElementById = id => reg[id] || getOrig(id);
  let html = '';
  e.ctx.document.createElement = () => ({ id: '', style: {}, set innerHTML(v) { html = v; }, get innerHTML() { return html; }, remove() { html = ''; } });
  e.ctx.document.body.appendChild = () => {};
  A._cajaEmpresa = null;
  A.abrirTransferir([1]);
  let t = html.replace(/\s+/g, ' ');
  check('Cuadro: destinos = cajas en pesos de todas las personas SIN la de origen ni las de dólares; por defecto «Franco · ARS transferencia»',
    /value="Franco\|\|ARS transferencia" selected/.test(t) && t.includes('Socio · ARS cash') && !t.includes('ARS Mercado Pago</option>') && !t.includes('USD cash'), t.slice(0, 900));
  A._cajaEmpresa = { persona: 'Socio', bolsillo: 'ARS cash' };
  A.abrirTransferir([1]); t = html.replace(/\s+/g, ' ');
  check('La caja recordada en configuración manda sobre el valor por defecto', /value="Socio\|\|ARS cash" selected/.test(t));
  A._cajaEmpresa = { persona: 'Nadie', bolsillo: 'ARS cash' };
  A.abrirTransferir([1]); t = html.replace(/\s+/g, ' ');
  check('Si la recordada ya no existe, vuelve al valor por defecto', /value="Franco\|\|ARS transferencia" selected/.test(t));
  A._cajaEmpresa = null;
  e.State.cajas = { Franco: { 'ARS Mercado Pago': 1 }, Socio: { 'ARS cash': 1 } };
  A.abrirTransferir([1]); t = html.replace(/\s+/g, ' ');
  check('Sin «Franco · ARS transferencia» ni recordada: obliga a elegir («Elegí la caja…») y propone guardarla', t.includes('Elegí la caja…') && !/selected/.test(t.replace('Elegí la caja…', '')));
  e.State.cajas = { Franco: { 'ARS Mercado Pago': 85000, 'ARS transferencia': 0, 'USD cash': 5 }, Socio: { 'ARS cash': 10 } };
  const htmlAntes = html; A.abrirTransferir([6]);   // la anulada: no abre
  check('No abre el cuadro para una actividad que no está pendiente o no es de transferencia', html === htmlAntes || html === '');

  // Confirmar: transferir
  llamadas.length = 0; upserts.length = 0;
  e.dom['act-destino'] = 'Franco||ARS transferencia'; e.dom['act-nota'] = 'cuenta del banco'; e.dom['act-recordar'] = true;
  A.abrirTransferir([1]);
  await A.confirmar('transferir', { disabled: false });
  check('Transferir: llama a la base con el id de la persona (UUID), el bolsillo y la nota; guarda la caja como predeterminada y recarga',
    llamadas.length === 1 && llamadas[0].fn === 'actividad_transferir' && llamadas[0].args.p_id === 1 && llamadas[0].args.p_intento === 1 && llamadas[0].args.p_destino_persona === 'u1' && llamadas[0].args.p_destino_bolsillo === 'ARS transferencia' && llamadas[0].args.p_nota === 'cuenta del banco'
    && upserts.length === 1 && JSON.parse(upserts[0].valor).bolsillo === 'ARS transferencia' && e.recargas >= 1 && e.toasts.some(x => x.includes('Transferencia registrada')), JSON.stringify([llamadas, upserts]));
  llamadas.length = 0;
  A.abrirTransferir([1]);
  e.dom['act-destino'] = ''; await A.confirmar('transferir', null);
  check('Sin elegir destino: NO llama a la base', llamadas.length === 0 && e.toasts.some(x => x.includes('Elegí la caja')));
  e.dom['act-destino'] = 'Nadie||ARS cash'; await A.confirmar('transferir', null);
  check('Una persona que no existe: NO llama a la base', llamadas.length === 0);
  // Varias, con resultado parcial
  e.dom['act-destino'] = 'Franco||ARS transferencia'; e.dom['act-recordar'] = false; llamadas.length = 0;
  rpcResp = (fn, args) => args.p_id === 2 ? { data: null, error: { message: 'SALDO_INSUFICIENTE: poco' } } : { data: { ok: true }, error: null };
  A.abrirTransferir([1, 2, 3]);
  await A.confirmar('transferir', null);
  check('Varias a la vez: se hace una por una y se informa «2 de 3» identificando cuáles (#1, #3 hechas; #2 con su motivo)', llamadas.length === 3 && e.toasts.some(x => x.includes('2 de 3') && x.includes('#1, #3') && x.includes('#2 (') && x.includes('saldo suficiente')), JSON.stringify(e.toasts.slice(-2)));
  // Sin respuesta: se corta
  llamadas.length = 0;
  e.cfg.supaRpc = async (fn, args) => { llamadas.push({ fn, args }); throw new Error('red'); };
  A.abrirTransferir([1, 2, 3]);
  await A.confirmar('transferir', null);
  check('Si la llamada TIRA una excepción: NO sigue a ciegas con las demás y avisa que no se sabe', llamadas.length === 1 && e.toasts.some(x => x.includes('no se sabe si se aplicó')));
  // supabase-js NO tira ante una caída de red: devuelve {error, status: 0}
  for (const [txt, resp] of [['status 0', { data: null, error: { message: 'TypeError: Failed to fetch' }, status: 0 }], ['502 de pasarela', { data: null, error: { code: '', message: 'Bad Gateway' }, status: 502 }], ['mensaje de red sin código', { data: null, error: { message: 'NetworkError when attempting to fetch resource.' } }]]) {
    llamadas.length = 0;
    e.cfg.supaRpc = async (fn, args) => { llamadas.push({ fn, args }); return resp; };
    A.abrirTransferir([1, 2, 3]);
    await A.confirmar('transferir', null);
    check(`Respuesta de red fallida de supabase-js (${txt}): se corta el lote, la actividad queda INCIERTA y las demás NO se intentan`, llamadas.length === 1 && e.toasts.some(x => x.includes('INCIERTA: #1') && x.includes('No se intentaron: #2, #3')), JSON.stringify(e.toasts.slice(-1)));
  }
  llamadas.length = 0;
  e.cfg.supaRpc = async (fn, args) => { llamadas.push({ fn, args }); return { data: null, error: { code: 'P0001', message: 'SALDO_INSUFICIENTE' }, status: 400 }; };
  A.abrirTransferir([1]); await A.confirmar('transferir', null);
  check('Un rechazo de negocio (código P0001, 400) NO se confunde con «sin respuesta»', e.toasts.some(x => x.includes('No se pudo: #1') && !x.includes('INCIERTA')));
  e.cfg.supaRpc = async (fn, args) => { llamadas.push({ fn, args }); return rpcResp(fn, args); };
  rpcResp = () => ({ data: { ok: true }, error: null });
  // Doble clic
  llamadas.length = 0;
  let suelta; e.cfg.supaRpc = (fn, args) => { llamadas.push({ fn, args }); return new Promise(r => { suelta = () => r({ data: { ok: true }, error: null }); }); };
  A.abrirTransferir([1]);
  const p1 = A.confirmar('transferir', null); const p2 = A.confirmar('transferir', null);
  await dormirTest();
  suelta(); await p1; await p2;
  check('Doble clic: una sola llamada a la base', llamadas.length === 1, String(llamadas.length));
  e.cfg.supaRpc = async (fn, args) => { llamadas.push({ fn, args }); return rpcResp(fn, args); };
  // Solo marcar
  llamadas.length = 0; A.abrirTransferir([1]); await A.confirmar('marcar', null);
  check('«Solo marcar»: llama a actividad_marcar_hecha (con la revisión que se vio) y NO a transferir', llamadas.length === 1 && llamadas[0].fn === 'actividad_marcar_hecha' && llamadas[0].args.p_revision === 1);

  // Lo que se ejecuta es lo que se vio al abrir el cuadro (aunque la pantalla se recargue mientras tanto)
  A._lista.find(a => a.id === 1).intento = 1;
  A.abrirTransferir([1]);
  A._lista.find(a => a.id === 1).intento = 2; A._lista.find(a => a.id === 1).revision = 9;   // una recarga cambió los datos
  llamadas.length = 0; e.cfg.supaRpc = async (fn, args) => { llamadas.push({ fn, args }); return { data: { ok: true }, error: null }; };
  await A.confirmar('transferir', null);
  check('El intento que se manda es el del momento de abrir el cuadro, no el de una recarga posterior', llamadas[0].args.p_intento === 1, JSON.stringify(llamadas[0].args));
  A._lista.find(a => a.id === 1).intento = 1; A._lista.find(a => a.id === 1).revision = 1;
  rpcResp = () => ({ data: { ok: true }, error: null });
  e.cfg.supaRpc = async (fn, args) => { llamadas.push({ fn, args }); return rpcResp(fn, args); };

  // Otras acciones
  llamadas.length = 0;
  await A.marcar(7, null); await A.reabrir(5, null);
  check('Marcar y reabrir llaman a sus funciones, cada una con la revisión de la actividad', llamadas.map(l => l.fn).join() === 'actividad_marcar_hecha,actividad_reabrir' && llamadas.every(l => l.args.p_revision === 1));
  llamadas.length = 0; e.ctx.confirm = () => false;
  await A.anular(1, null); await A.compensar(4, null);
  check('Anular y deshacer transferencia piden confirmación: si se rechaza NO llaman a la base', llamadas.length === 0);
  e.ctx.confirm = () => true;
  await A.anular(1, null); await A.compensar(4, null);
  check('Con confirmación llaman a actividad_anular (con revisión) y actividad_compensar', llamadas.map(l => l.fn).join() === 'actividad_anular,actividad_compensar' && llamadas[0].args.p_revision === 1);
  check('«Deshacer transferencia» manda el intento que vio la pantalla', llamadas[1].args.p_intento === 1);
  A._lista.find(a => a.id === 4).intento = 3; llamadas.length = 0; await A.compensar(4, null);
  check('… y usa el de esa actividad (3), no uno fijo', llamadas[0].args.p_intento === 3);
  check('«Cambió desde que abriste» y «falta el intento» tienen mensaje propio', A._msgError({ message: 'ACTIVIDAD_DESACTUALIZADA' }).includes('cambió desde que abriste') && A._msgError({ message: 'INTENTO_REQUERIDO' }).includes('recargá'));
  check('La carga trae el intento de cada actividad', A._lista.every(a => Number.isInteger(a.intento) && a.intento >= 1));

  // Errores traducidos
  check('Los códigos de la base se traducen a castellano', A._msgError({ message: 'ORDEN_YA_TRANSFERIDA' }).includes('deshacé la transferencia') && A._msgError({ message: 'DESTINO_IGUAL_ORIGEN' }).includes('misma que la de origen') && A._msgError({ message: 'x<b>y' }).includes('&lt;b&gt;'));

  // Cargas simultáneas: la ÚLTIMA gana (una respuesta vieja que llega tarde no pisa la nueva)
  {
    const respuestas = [];
    const lenta = (rows) => new Proxy({}, { get: (_, k) => k === 'then' ? (ok, ko) => new Promise(r => respuestas.push(() => r({ data: rows, error: null }))).then(ok, ko) : () => lenta(rows) });
    const guardadoFrom = e.cfg.supaFrom, guardadaLista = A._lista;
    e.cfg.supaFrom = t => t === 'actividades' ? lenta([fila(500, { estado: 'pendiente' })].filter(() => true)) : { select: () => consultaFalsa({ data: null, error: null }) };
    const c1 = A.cargar();                       // la primera queda esperando
    e.cfg.supaFrom = t => t === 'actividades' ? lenta([fila(600, { estado: 'pendiente' })]) : { select: () => consultaFalsa({ data: null, error: null }) };
    const c2 = A.cargar();                       // la segunda es más nueva
    await dormirTest();
    respuestas.slice(2).forEach(f => f());       // se resuelve primero la NUEVA (sus dos consultas)…
    await c2;
    respuestas.slice(0, 2).forEach(f => f());    // …y recién después llega la vieja
    await c1;
    check('Dos cargas a la vez: queda la lista de la ÚLTIMA aunque la vieja llegue tarde', A._lista.some(a => a.id === 600) && !A._lista.some(a => a.id === 500), JSON.stringify(A._lista.map(a => a.id)));
    e.cfg.supaFrom = guardadoFrom; A._lista = guardadaLista;
  }

  // Aviso al abrir: transferencias pendientes
  A._lista = [{ id: 1, tipo: 'meli_transferir', estado: 'pendiente', monto: 85000 }, { id: 2, tipo: 'meli_transferir', estado: 'pendiente', monto: 85000 }, { id: 3, tipo: 'manual', estado: 'pendiente', monto: null }, { id: 4, tipo: 'meli_transferir', estado: 'hecha', monto: 1 }];
  check('textoPendientes: cuenta SOLO transferencias pendientes (no manuales ni hechas) con su total', A.textoPendientes() === 'Tenés 2 transferencias pendientes por $170.000.', A.textoPendientes());
  check('… en singular con una, y vacío sin ninguna', A.textoPendientes([{ tipo: 'meli_transferir', estado: 'pendiente', monto: 5 }]) === 'Tenés 1 transferencia pendiente por $5.' && A.textoPendientes([]) === '');
  // Cableado: la pantalla está conectada al menú y a la app
  const appJs = fs.readFileSync('/Users/francovelas/crm-complete/iphonemood-crm/src/modules/app.js', 'utf8'), crmHtml = fs.readFileSync('/Users/francovelas/crm-complete/iphonemood-crm/crm.html', 'utf8');
  check('Cableado: app.js importa actividades.js y la registra en PAGES; crm.html tiene el ítem del menú y su badge propio (distinto del de Mercado Libre)',
    /import '\.\/actividades\.js'/.test(appJs) && /actividades: \{ title: 'Actividades', module: Actividades \}/.test(appJs) && /data-page="actividades"/.test(crmHtml) && /id="badge-actividades"/.test(crmHtml) && /id="badge-meli"/.test(crmHtml));
  check('Cableado: el aviso de apertura espera a las actividades y el badge se actualiza con el resto', /Actividades\?\.cargar\?\.\(\)/.test(appJs) && /Actividades\?\.actualizarBadge\?\.\(\)/.test(appJs));

  // Email diario: botones
  {
    const pedidos = []; let respuesta = { status: 200, json: { enviado: true, motivo: null } };
    e.ctx.fetch = async (url, opts) => { pedidos.push({ url, opts }); return { status: respuesta.status, ok: respuesta.status < 300, json: async () => respuesta.json }; };
    e.ctx.supa.auth = { getSession: async () => ({ data: { session: { access_token: 'tok-sesion' } } }) };
    const btn = { disabled: false };
    await A.enviarEmail('aviso_prueba', btn);
    check('«Email de prueba»: POST al worker con el token de la sesión y la acción aviso_prueba', pedidos.length === 1 && pedidos[0].url === '/api/meli/worker' && pedidos[0].opts.headers['x-crm-token'] === 'tok-sesion' && JSON.parse(pedidos[0].opts.body).accion === 'aviso_prueba' && e.toasts.some(t => t.includes('prueba aceptado por Resend')) && btn.disabled === false);
    await A.enviarEmail('aviso', null);
    check('«Enviar aviso ahora» manda la acción aviso', JSON.parse(pedidos[1].opts.body).accion === 'aviso' && e.toasts.some(t => t.includes('Aviso aceptado por Resend')));
    const antes = pedidos.length; await A.enviarEmail('otra', null);
    check('Una acción desconocida no llama al servidor', pedidos.length === antes);
    for (const [motivo, status, texto] of [['SIN_CONFIG', 200, 'Falta configurar'], ['CUOTA', 429, 'máximo de intentos'], ['TIMEOUT', 200, 'no se sabe si salió'], ['HTTP_500', 200, 'HTTP_500'], ['YA_ENVIADO', 200, 'ya se había enviado']]) {
      respuesta = { status, json: { enviado: false, motivo } };
      await A.enviarEmail('aviso', null);
      check(`El motivo ${motivo} se explica en castellano`, e.toasts.some(t => t.includes(texto)), JSON.stringify(e.toasts.slice(-1)));
    }
    respuesta = { status: 200, json: { enviado: true, motivo: 'ACEPTADO_SIN_CONFIRMAR' } }; await A.enviarEmail('aviso', null);
    check('«Aceptado pero sin confirmar» se avisa tal cual (no como un éxito común)', e.toasts.slice(-1)[0].includes('no se pudo anotar en la base'), JSON.stringify(e.toasts.slice(-1)));
    respuesta = { status: 200, json: { enviado: true, motivo: null } }; await A.enviarEmail('aviso', null);
    check('El éxito común dice «aceptado por Resend» (no promete la bandeja)', e.toasts.slice(-1)[0].includes('aceptado por Resend'));
    for (const m of ['SOBRE_CAMBIO', 'VENTANA_VENCIDA']) { respuesta = { status: 200, json: { enviado: false, motivo: m } }; await A.enviarEmail('aviso', null); }
    check('Los motivos nuevos tienen mensaje propio', e.toasts.some(t => t.includes('Cambió la dirección')) && e.toasts.some(t => t.includes('más de 23 horas')));
    respuesta = { status: 401, json: {} }; await A.enviarEmail('aviso', null);
    check('Sin sesión autorizada (401) lo dice', e.toasts.some(t => t.includes('sesión no está autorizada')));
    e.ctx.fetch = async () => { throw new Error('red'); };
    check('Si el servidor no responde: avisa y el botón se rehabilita', (await A.enviarEmail('aviso', btn), btn.disabled === false && e.toasts.some(t => t.includes('No se pudo conectar'))));
    check('La pantalla trae los botones de email', A._vista().includes("enviarEmail('aviso_prueba'") && A._vista().includes("enviarEmail('aviso'"));
  }

  // Nueva actividad
  llamadas.length = 0;
  e.dom['act-titulo'] = '  '; await A.crear(null);
  check('Crear sin título: NO llama a la base', llamadas.length === 0);
  e.dom['act-titulo'] = 'Llamar al contador'; e.dom['act-fecha'] = ''; await A.crear(null);
  check('Crear sin fecha: NO llama a la base', llamadas.length === 0);
  e.dom['act-fecha'] = '2026-10-20'; e.dom['act-nota-nueva'] = ''; await A.crear(null);
  check('Crear: llama a actividad_crear con título, fecha, sin monto', llamadas.length === 1 && llamadas[0].fn === 'actividad_crear' && llamadas[0].args.p_titulo === 'Llamar al contador' && llamadas[0].args.p_fecha_objetivo === '2026-10-20' && llamadas[0].args.p_monto === null && llamadas[0].args.p_nota === null);
}

// 45. DETALLE DE UNA VENTA DE MERCADO LIBRE (ventas.js): cotización usada y comisión estimada hasta acreditar
{
  const e = nuevoEntorno({ modulos: ['ventas.js'] });
  const V = e.mod.Ventas;
  const venta = (extra = {}) => ({ id: 125, estado: 'abierta', tipoVenta: 'mercadolibre', meliOrdenId: 7, meliCotizacion: 1620, costoCanal: 0, items: [{ precio: 38.27, costo: 24 }], pagos: [], ...extra });
  const orden = (extra = {}) => ({ ventaId: 125, acreditado: false, revertidaEn: null, financieraCompleta: true, bruto: 61990, neto: 43187, ...extra });
  e.State.meliOrdenes = [orden()];
  const r = V.resultadoVenta(venta());
  const d = V._detalleMeli(venta(), r);
  check('Caso real #125: cotización 1.620 y Mercado Libre se queda ≈ (61.990 − 43.187) ÷ 1.620 = USD 11,61', d && d.cot === 1620 && d.estimado === 11.61, JSON.stringify(d));
  check('Trae el precio de Mercado Libre en pesos ($61.990), de donde sale el total en dólares', d.ars === 61990, JSON.stringify(d));
  check('El profit que se muestra (14,27) es ANTES de Mercado Libre; después queda ≈ 2,66 (provisorio)', Math.abs(r.margenReal - 14.27) < 0.005 && d.profitDespues === 2.66, JSON.stringify([r.margenReal, d]));
  check('Ya acreditada: no hay estimado (el costo real ya está en la venta)', V._detalleMeli(venta({ costoCanal: 11.6 }), r) !== null && (e.State.meliOrdenes = [orden({ acreditado: true })], V._detalleMeli(venta(), r).estimado === null));
  e.State.meliOrdenes = [orden({ financieraCompleta: false })];
  check('Datos de pago incompletos: no se estima (nunca se inventa)', V._detalleMeli(venta(), r).estimado === null);
  e.State.meliOrdenes = [orden({ neto: null })];
  check('Neto nulo: no se estima', V._detalleMeli(venta(), r).estimado === null);
  e.State.meliOrdenes = [orden({ revertidaEn: '2026-10-10T00:00:00Z' })];
  check('Orden revertida: no se estima', V._detalleMeli(venta(), r).estimado === null);
  e.State.meliOrdenes = [];
  check('Sin la orden en memoria: muestra la cotización pero no estima', V._detalleMeli(venta(), r).estimado === null && V._detalleMeli(venta(), r).cot === 1620);
  e.State.meliOrdenes = [orden()];
  check('Venta sin cotización guardada o que no es de Mercado Libre: no agrega nada', V._detalleMeli(venta({ meliCotizacion: null }), r) === null && V._detalleMeli({ id: 1, tipoVenta: 'minorista', items: [], pagos: [] }, r) === null);
}

// 46. COMISIÓN DE MERCADO LIBRE POR ÍTEM, EN DÓLARES (ventas.js): reparto exacto y detalle de la venta
{
  const e = nuevoEntorno({ modulos: ['ventas.js'] });
  const V = e.mod.Ventas;
  const suma = a => a.reduce((x, y) => x + y, 0);
  // Reparto: suma exacta, sin centavos perdidos ni inventados
  check('Reparto: 1.161 centavos entre 3 ítems iguales = 387 + 387 + 387 (suma exacta)', JSON.stringify(V._repartirCentavos(1161, [100, 100, 100])) === '[387,387,387]');
  check('Reparto: 1.000 centavos entre 3 ítems iguales: 334 + 333 + 333 (el centavo sobrante al primero) y la suma da 1.000', JSON.stringify(V._repartirCentavos(1000, [1, 1, 1])) === '[334,333,333]');
  check('Reparto proporcional: 1.161 centavos entre precios 3.827 y 4.073 → parte mayor al ítem más caro, suma exacta', (() => { const r = V._repartirCentavos(1161, [3827, 4073]); return suma(r) === 1161 && r[1] > r[0]; })());
  check('Sin pesos (todos en cero, p. ej. regalos): se reparte en partes iguales y la suma es exacta', JSON.stringify(V._repartirCentavos(101, [0, 0])) === '[51,50]');
  check('Un ítem recibe todo; total 0 da ceros; sin ítems da vacío', JSON.stringify(V._repartirCentavos(1161, [500])) === '[1161]' && JSON.stringify(V._repartirCentavos(0, [3, 4])) === '[0,0]' && V._repartirCentavos(50, []).length === 0);
  check('Un ítem con peso 0 (regalo) no recibe nada si hay otros con peso', JSON.stringify(V._repartirCentavos(777, [0, 5000, 5000])) === '[0,389,388]');
  // Propiedad: 3.000 casos al azar, la suma SIEMPRE es el total, nunca negativos y cada parte difiere del reparto ideal en menos de 1 centavo
  let malos = 0; const azar = (n) => Math.floor(Math.random() * n);
  for (let k = 0; k < 3000; k++) {
    const n = 1 + azar(6), pesos = Array.from({ length: n }, () => (azar(5) === 0 ? 0 : azar(2000000))), total = azar(5000000);
    const r = V._repartirCentavos(total, pesos), W = suma(pesos);
    if (suma(r) !== total || r.some(x => !Number.isInteger(x) || x < 0) || (W > 0 && r.some((x, i) => Math.abs(x - total * pesos[i] / W) >= 1))) malos++;
  }
  check('Propiedad (3.000 casos al azar): suma exacta, enteros no negativos y cada parte a menos de 1 centavo de lo ideal', malos === 0, String(malos));

  check('Números enormes (enteros seguros): la suma sigue siendo EXACTA, sin inventar un centavo (caso hallado por Codex)', (() => { const r = V._repartirCentavos(8084569317819639, [426256299594303, 277520753359598, 57451384435899]); return r.reduce((a, b) => a + BigInt(b), 0n) === 8084569317819639n; })());
  check('Pesos no válidos (Infinity, NaN, texto, negativos) cuentan como 0: nunca producen NaN', V._repartirCentavos(1000, [Infinity, 500, NaN, -3, 'x']).every(Number.isInteger) && V._repartirCentavos(1000, [Infinity, 500, NaN, -3, 'x']).reduce((a, b) => a + b, 0) === 1000);
  // Comisión por ítem
  const venta = (extra = {}) => ({ id: 125, estado: 'abierta', tipoVenta: 'mercadolibre', meliOrdenId: 7, meliCotizacion: 1620, costoCanal: 0,
    items: [{ nombre: 'A', precio: 38.27, costo: 24 }], pagos: [], ...extra });
  const orden = (extra = {}) => ({ ventaId: 125, acreditado: false, revertidaEn: null, financieraCompleta: true, bruto: 61990, neto: 43187, ...extra });
  e.State.meliOrdenes = [orden()];
  let v = venta(), r = V.resultadoVenta(v), c = V._comisionPorItem(v, r);
  check('Estimada (orden sin acreditar): toda la comisión (11,61) cae en el único ítem y se marca estimada', c && c.conocida && c.estimada && c.total === 11.61 && JSON.stringify(c.porItem) === '[11.61]', JSON.stringify(c));
  v = venta({ items: [{ nombre: 'A', precio: 38.27, costo: 24 }, { nombre: 'B', precio: 40.73, costo: 17.78 }, { nombre: 'Regalo', precio: 0, costo: 2, regalo: true }] });
  r = V.resultadoVenta(v); c = V._comisionPorItem(v, r);
  const sumaC = Math.round(suma(c.porItem) * 100);
  check('Varios ítems: la suma de las comisiones por ítem = la comisión total, SIN perder centavos; el regalo no paga comisión', sumaC === Math.round(c.total * 100) && c.porItem[2] === 0 && c.porItem[0] > 0 && c.porItem[1] > c.porItem[0], JSON.stringify(c));
  v = venta({ costoCanal: 11.5 }); r = V.resultadoVenta(v); e.State.meliOrdenes = [orden({ acreditado: true })];
  c = V._comisionPorItem(v, r);
  check('Acreditada: usa el costo REAL guardado en la venta (11,50), no estimado', c.conocida && !c.estimada && c.total === 11.5 && c.porItem[0] === 11.5, JSON.stringify(c));
  e.State.meliOrdenes = [orden({ financieraCompleta: false })];
  v = venta(); r = V.resultadoVenta(v); c = V._comisionPorItem(v, r);
  check('Sin importes confirmados: comisión DESCONOCIDA (no se inventa un cero) y las partes en 0', c && !c.conocida && c.total === 0 && c.porItem[0] === 0);
  check('Una venta que no es de Mercado Libre: null (sin comisión del canal)', V._comisionPorItem({ id: 9, tipoVenta: 'minorista', items: [{ precio: 10 }], pagos: [] }, V.resultadoVenta({ id: 9, tipoVenta: 'minorista', items: [{ precio: 10 }], pagos: [] })) === null);
  // Centavos: ítems con precios que no dividen parejo
  e.State.meliOrdenes = [orden({ bruto: 99990, neto: 70001.37 })];
  v = venta({ items: [{ nombre: 'A', precio: 10.01, costo: 1 }, { nombre: 'B', precio: 20.02, costo: 1 }, { nombre: 'C', precio: 30.03, costo: 1 }] }); r = V.resultadoVenta(v); c = V._comisionPorItem(v, r);
  check('Con precios que no dividen parejo la suma sigue siendo exacta', Math.round(suma(c.porItem) * 100) === Math.round(c.total * 100) && c.porItem.every(x => Math.round(x * 100) === x * 100), JSON.stringify(c));

  e.State.meliOrdenes = [orden({ bruto: 100.01 * 0 + 1000, neto: 999.99 })];
  const dup = { nombre: 'Khamrah', precio: 40.73, costo: 17.78, stockId: 's1' };
  const vDup = venta({ items: [dup, dup] }); const cDup = V._comisionPorItem(vDup, V.resultadoVenta(vDup));
  check('Un mismo ítem repetido (dos unidades iguales): las partes suman la comisión total una sola vez', Math.round(suma(cDup.porItem) * 100) === Math.round(cDup.total * 100), JSON.stringify(cDup));
  const vInf = venta({ items: [{ nombre: 'A', precio: 'Infinity', costo: 1 }, { nombre: 'B', precio: 40, costo: 1 }] }); e.State.meliOrdenes = [orden()];
  const cInf = V._comisionPorItem(vInf, V.resultadoVenta(vInf));
  check('Un precio infinito no anula la comisión de los demás ítems', Number.isFinite(suma(cInf.porItem)) && Math.round(suma(cInf.porItem) * 100) === Math.round(cInf.total * 100) && cInf.porItem[1] > 0, JSON.stringify(cInf));

  // El detalle en pantalla
  const reg = {}; const orig = e.ctx.document.getElementById;
  e.ctx.document.getElementById = id => reg[id] || orig(id);
  reg['venta-modal-host'] = { innerHTML: '', classList: { add() {}, remove() {} }, style: {} };
  e.State.stock = [{ id: 's1', cat: 'perfumeria', nombre: 'Khamrah', notas: '' }, { id: 's2', cat: 'iphone', nombre: 'iPhone', notas: '' }];
  e.ctx.App.closeSidebar = () => {}; e.ctx.DB.cargarNotasVenta = async () => [];
  const detalle = (vv) => { e.State.ventas = [vv]; reg['venta-modal-host'].innerHTML = ''; try { V.viewSale(vv.id); } catch (err) { return 'ERROR ' + err.message; } return reg['venta-modal-host'].innerHTML.replace(/\s+/g, ' '); };
  e.State.meliOrdenes = [orden()];
  let h = detalle(venta({ items: [{ nombre: 'Khamrah', precio: 40.73, costo: 17.78, stockId: 's1' }], tipoVenta: 'mercadolibre' }));
  check('Detalle (accesorio de Mercado Libre, estimada): columnas Costo | Comisión plataforma | Precio venta | Profit, comisión en dólares con «≈», profit NETO provisorio y nota explicativa',
    !h.startsWith('ERROR') && /<th>Costo<\/th><th>Comisión plataforma<\/th><th>Precio venta<\/th><th>Profit<\/th>/.test(h) && /≈ USD 11,61/.test(h) && h.includes('estimada hasta que se acredite') && /\+USD 11,34/.test(h) && !/<td>\$0<\/td>/.test(h), h.startsWith('ERROR') ? h : h.slice(h.indexOf('Accesorios Vendidos'), h.indexOf('Accesorios Vendidos') + 900));
  e.State.meliOrdenes = [orden({ acreditado: true })];
  h = detalle(venta({ items: [{ nombre: 'Khamrah', precio: 40.73, costo: 17.78, stockId: 's1' }], costoCanal: 11.5 }));
  check('Detalle acreditada: comisión real sin «≈» y sin nota de estimada', /<td>USD 11,5<\/td>|USD 11,50/.test(h) && !h.includes('estimada hasta que se acredite') && h.includes('repartida según el precio'));
  e.State.meliOrdenes = [orden({ financieraCompleta: false })];
  h = detalle(venta({ items: [{ nombre: 'Khamrah', precio: 40.73, costo: 17.78, stockId: 's1' }] }));
  check('Detalle sin importes confirmados: la comisión muestra «—» y el profit queda sin descontar nada', h.includes('<span title="Todavía no hay importes confirmados') && /\+USD 22,95/.test(h));
  h = detalle({ id: 300, estado: 'abierta', tipoVenta: 'minorista', items: [{ nombre: 'Khamrah', precio: 40.73, costo: 17.78, stockId: 's1' }], pagos: [], cliente: 'x' });
  check('Venta común: la comisión de accesorios sale en DÓLARES («USD 0»), nunca «$0», y el profit no cambia', /<td>USD 0<\/td>/.test(h) && !/<td>\$0<\/td>/.test(h) && /\+USD 22,95/.test(h) && !h.includes('repartida según el precio'));
  e.State.meliOrdenes = [orden()];
  h = detalle(venta({ items: [{ nombre: 'Khamrah', precio: 40.73, costo: 17.78, stockId: 's1' }, { nombre: 'iPhone MELI', precio: 100, costo: 90, stockId: 's2' }] }));
  e.State.meliOrdenes = [orden({ bruto: 61990, neto: 61980 })];
  const hDup = detalle(venta({ items: [dup, dup] }));
  check('Detalle con el mismo ítem repetido: la comisión por fila suma la total (USD 0,01 una sola vez: una fila 0,01 y la otra 0)', (hDup.match(/<td>≈ USD 0,01<\/td>/g) || []).length === 1 && (hDup.match(/<td>≈ USD 0<\/td>/g) || []).length === 1, (hDup.match(/<td>≈ USD [^<]*<\/td>/g) || []).join('|'));
  e.State.meliOrdenes = [orden()];
  check('Un dispositivo en una venta de Mercado Libre también lleva su parte de la comisión del canal (una celda por ítem)', (h.match(/<td>≈ USD/g) || []).length === 2, String((h.match(/<td>≈ USD/g) || []).length));
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

// 99. Reparaciones · una reparación recién creada trae su link de seguimiento (antes la tarjeta decía «aún no tiene link» hasta recargar)
{
  const fuente = fs.readFileSync('/Users/francovelas/crm-complete/iphonemood-crm/src/modules/supabase-config.js', 'utf8');
  const mkDB = (supa) => {
    const ctxDB = { window: { __APP_CONFIG__: { SUPABASE_URL: 'x', SUPABASE_ANON_KEY: 'y' } }, supabase: { createClient: () => supa },
      console: { log() {}, warn() {}, error() {} }, Auth: {}, State: {}, toast() {}, Date, Math, Number, JSON, String, Promise, Error };
    vm.createContext(ctxDB);
    vm.runInContext(fuente + '\nthis.__DB = DB;', ctxDB, { filename: 'supabase-config.js' });
    return ctxDB.__DB;
  };
  const pedido = [];
  const supaOk = { from: t => ({ insert: r => { pedido.push({ t, r }); return { select: c => { pedido.push({ cols: c }); return { single: async () => ({ data: { token_seguimiento: 'abc123' }, error: null }) }; } }; } }) };
  const tk = await mkDB(supaOk).crearReparacion({ id: 'R001', cliente: 'Ana', estado: 'ingresado' });
  check('Crear una reparación devuelve el link que generó la base y lo pide con select (sin leer otras columnas)', tk === 'abc123' && pedido.some(x => x.cols === 'token_seguimiento') && pedido[0].t === 'reparaciones');
  const supaFalla = { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'x' } }) }) }) }) };
  check('Si no se pudo leer el link, devuelve null (la pantalla sigue como antes y se arregla al recargar)', (await mkDB(supaFalla).crearReparacion({ id: 'R002' })) === null);
  const rep = fs.readFileSync('/Users/francovelas/crm-complete/iphonemood-crm/src/modules/reparaciones.js', 'utf8');
  check('La pantalla guarda ese link en la reparación nueva antes de mostrarla', /o\.tokenSeguimiento\s*=\s*await DB\.crearReparacion\(o\)/.test(rep));
}

// ── Salida ───────────────────────────────────────────────────────────────
const w = Math.max(...casos.map(c => c[1].length));
casos.forEach(([est, n, d]) => {
  const marca = est === 'PASA' ? '  ok  ' : est === 'CONOCIDO' ? ' CONOC' : ' FALLA';
  console.log(`${marca} │ ${n.padEnd(w)} ${d ? '│ ' + d : ''}`);
});
console.log(`\n${ok} pasan, ${fail} fallan, ${conocidos} problemas conocidos de otras pantallas (sin arreglar)`);
process.exitCode = fail ? 1 : 0;
