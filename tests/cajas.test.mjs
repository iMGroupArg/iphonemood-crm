// Banco de pruebas del motor de cajas.
// Carga state.js de verdad, con la base y el toast simulados, y corre
// los flujos reales de cada pantalla contra él.

import fs from 'node:fs';
import vm from 'node:vm';

const SRC = '/Users/francovelas/crm-complete/iphonemood-crm/src/modules/state.js';

const BOLSILLOS = ['ARS cash', 'ARS transferencia', 'USD cash', 'USD transferencia', 'USDT'];
const monedaDe = b => (b.startsWith('ARS') ? 'ARS' : b === 'USDT' ? 'USDT' : 'USD');

// ── Arnés ────────────────────────────────────────────────────────────────
function nuevoEntorno({ fallaEscritura = null, fallaLedger = false } = {}) {
  const base = {};          // saldos "en la base"
  const libro = [];         // filas de caja_ledger
  const toasts = [];

  const DB = {
    async actualizarSaldoCaja(persona, bolsillo, saldo) {
      if (fallaEscritura && fallaEscritura(persona, bolsillo)) return false;
      base[`${persona}||${bolsillo}`] = saldo;
      return true;
    },
    async registrarMovimientoCaja(mov) {
      if (fallaLedger) return false;
      libro.push({ ...mov });
      return true;
    },
  };

  // state.js declara su propio toast(), que escribe en #toast del DOM.
  // Se simula el elemento para capturar los avisos tal como los ve el usuario.
  const elToast = { set innerHTML(v) { toasts.push(v); }, classList: { add() {}, remove() {} } };

  const ctx = {
    DB,
    document: { getElementById: id => (id === 'toast' ? elToast : null) },
    localStorage: { getItem: () => null, setItem: () => {} },
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

  // Siembra los saldos de arranque igual que la migración: el saldo va a la
  // base Y al libro como fila 'saldo_inicial' (el "punto 0"). Sin esto el
  // cuadre arrancaría torcido por el saldo previo, que es justo lo que la
  // migración evita.
  const sembrar = cajas => {
    State.cajas = JSON.parse(JSON.stringify(cajas));
    for (const [persona, bolsillos] of Object.entries(cajas)) {
      for (const [bolsillo, saldo] of Object.entries(bolsillos)) {
        base[`${persona}||${bolsillo}`] = saldo;
        libro.push({ persona, bolsillo, delta: saldo, tipo: 'saldo_inicial' });
      }
    }
  };

  return { State, base, libro, toasts, sembrar };
}

// ── Aserciones ───────────────────────────────────────────────────────────
let ok = 0, fail = 0;
const casos = [];
function check(nombre, cond, detalle = '') {
  if (cond) { ok++; casos.push(['PASA', nombre, '']); }
  else { fail++; casos.push(['FALLA', nombre, detalle]); }
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
// 8. Si falla SOLO el libro, el saldo se guarda pero avisa (arreglo de hoy)
// ═════════════════════════════════════════════════════════════════════════
{
  const { State, toasts } = nuevoEntorno({ fallaLedger: true });
  State.cajas = { Franco: { 'ARS cash': 1000 } };
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
  const { State } = nuevoEntorno();
  State.cajas = { Lautaro: { 'ARS transferencia': 500000 }, Franco: { 'USD cash': 0 } };
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
  check(nombre, real === JSON.stringify(esperado), `quedó ${real}, debería ser ${JSON.stringify(esperado)}`);
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

// ── Salida ───────────────────────────────────────────────────────────────
const w = Math.max(...casos.map(c => c[1].length));
casos.forEach(([est, n, d]) => {
  console.log(`${est === 'PASA' ? '  ok  ' : ' FALLA'} │ ${n.padEnd(w)} ${d ? '│ ' + d : ''}`);
});
console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
