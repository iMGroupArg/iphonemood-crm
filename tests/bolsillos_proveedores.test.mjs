// Pago al proveedor y demás flujos de proveedores: las cajas que se ofrecen son las que EXISTEN (p. ej. «ARS Mercado Pago»), no una lista fija de 5.
// Corre state.js y proveedores.js reales con DOM y base simulados.
import assert from 'node:assert';   // modo no estricto: los arreglos creados dentro del vm no comparten prototipo
import fs from 'node:fs';
import vm from 'node:vm';

const RAIZ = new URL('../', import.meta.url).pathname;
const leer = ruta => fs.readFileSync(RAIZ + ruta, 'utf8');
let n = 0;
async function caso(nombre, fn) { n++; await fn(); console.log(`ok ${n} - ${nombre}`); }

// Un elemento de pantalla mínimo: un <select> tiene `options` leídas de su innerHTML.
function entorno(modulos = []) {
  const els = {};
  const nuevoEl = id => {
    const e = { id, files: [], style: {}, classList: { add() {}, remove() {} }, remove() {}, focus() {}, select() {}, addEventListener() {}, dispatchEvent() {},
      _html: '', _valor: undefined,
      get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); this._valor = undefined; },
      get options() { return [...this._html.matchAll(/<option(?:\s+value="([^"]*)")?[^>]*>([^<]*)/g)].map(m => ({ value: m[1] ?? m[2] })); },
      get value() { return this._valor !== undefined ? this._valor : (this.options[0]?.value ?? ''); },
      set value(v) { this._valor = v; },
      textContent: '' };
    return e;
  };
  const el = id => (els[id] ||= nuevoEl(id));
  const toasts = [];
  const ctx = {
    DB: { async guardarLotePago(...a) { ctx.__guardados.push(a); return true; }, async actualizarEstadoLote() { return true; } },
    __guardados: [],
    document: {
      getElementById: id => (id === 'toast' ? { set innerHTML(v) { toasts.push(v); }, classList: { add() {}, remove() {} } } : el(id)),
      createElement: () => nuevoEl('creado'),
      body: { appendChild(o) { els.__overlay = o; } },
      querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem() {} },
    confirm: () => true, Sheets: new Proxy({}, { get: () => () => {} }), supa: {}, Auth: { usuario: { nombre: 'Test' } },
    Reportes: { NICHOS: [] }, App: { goTo() {} }, window: {}, setTimeout: () => 0, clearTimeout() {}, Event: class {}, console, Date, Math, Number, JSON, String, Promise, Error, Object, Array, Set,
  };
  vm.createContext(ctx);
  vm.runInContext(leer('src/modules/state.js'), ctx, { filename: 'state.js' });
  for (const m of modulos) vm.runInContext(leer('src/modules/' + m), ctx, { filename: m });
  const State = ctx.window.State;
  State.personas = ['Franco', 'Angel'];
  State.cajas = {
    Franco: { 'ARS cash': 5, 'ARS transferencia': 6, 'ARS Mercado Pago': 1422260.74, 'USD cash': 7, 'USD transferencia': 8, USDT: 9 },
    Angel: { 'ARS cash': 1, 'ARS transferencia': 1, 'USD cash': 1, 'USD transferencia': 1, USDT: 1 },
  };
  State.refBlue = 1590;
  return { State, ctx, el, els, toasts, mod: ctx.window };
}
const valores = html => [...String(html).matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);

// ── El helper común y proveedores ──
await caso('State.bolsillosPara: pesos = solo bolsillos en pesos, con «ARS Mercado Pago» solo de quien lo tiene', () => {
  const { State } = entorno();
  assert.deepEqual(State.bolsillosPara(['ARS'], 'Franco'), ['ARS cash', 'ARS transferencia', 'ARS Mercado Pago']);
  assert.deepEqual(State.bolsillosPara(['ARS'], 'Angel'), ['ARS cash', 'ARS transferencia']);   // Angel no tiene esa caja: no se ofrece
  assert.deepEqual(State.bolsillosPara(['USD'], 'Franco'), ['USD cash', 'USD transferencia']);
  assert.deepEqual(State.bolsillosPara(['USDT'], 'Franco'), ['USDT']);
  assert.deepEqual(State.bolsillosPara(['USD', 'USDT'], 'Franco'), ['USD cash', 'USD transferencia', 'USDT']);
  assert.equal(State.bolsillosPara(null, 'Franco').length, 6);
  assert.equal(State.bolsillosPara(null, 'Angel').length, 5);
  assert.ok(State.bolsillosPara(['ARS'], '').includes('ARS Mercado Pago'));                       // sin persona elegida: todas las que existen
});

await caso('State.opcionesBolsillo escapa los nombres (texto y value)', () => {
  const { State } = entorno();
  State.cajas.Franco['ARS "caja" <b>x</b>'] = 1;
  const html = State.opcionesBolsillo(['ARS'], 'Franco');
  assert.ok(html.includes('ARS &quot;caja&quot; &lt;b&gt;x&lt;/b&gt;') && !html.includes('<b>x</b>'), html);
});

await caso('Pago al proveedor: en pesos, desde Franco, ofrece «ARS Mercado Pago»; al cambiar a Angel desaparece; en USDT solo USDT', () => {
  const { mod, el } = entorno(['proveedores.js']);
  mod.Proveedores._cuentaLote = () => ({ restante: 0, usdtLote: 0 });
  mod.Proveedores.modalPago(7);
  el('pago-persona').value = 'Franco';
  el('pago-moneda').value = 'ARS';
  mod.Proveedores._onPagoMonedaChange();
  assert.deepEqual(valores(el('pago-bolsillo').innerHTML), ['ARS cash', 'ARS transferencia', 'ARS Mercado Pago']);
  el('pago-persona').value = 'Angel';
  mod.Proveedores._onPagoMonedaChange();
  assert.deepEqual(valores(el('pago-bolsillo').innerHTML), ['ARS cash', 'ARS transferencia']);
  el('pago-moneda').value = 'USDT';
  mod.Proveedores._onPagoMonedaChange();
  assert.deepEqual(valores(el('pago-bolsillo').innerHTML), ['USDT']);
  el('pago-moneda').value = 'USD';
  mod.Proveedores._onPagoMonedaChange();
  assert.deepEqual(valores(el('pago-bolsillo').innerHTML), ['USD cash', 'USD transferencia']);
});

await caso('Pago al proveedor: cambiar la persona recalcula la lista (el selector avisa) y se conserva la caja elegida si sigue valiendo', () => {
  const { mod, els, el } = entorno(['proveedores.js']);
  mod.Proveedores._cuentaLote = () => ({ restante: 0, usdtLote: 0 });
  mod.Proveedores.modalPago(7);
  assert.ok(/id="pago-persona" onchange="Proveedores\._onPagoMonedaChange\(\)"/.test(els.__overlay.innerHTML), 'la persona dispara el recálculo');
  el('pago-moneda').value = 'ARS'; el('pago-persona').value = 'Franco';
  mod.Proveedores._onPagoMonedaChange();
  el('pago-bolsillo').value = 'ARS Mercado Pago';
  mod.Proveedores._onPagoMonedaChange();                                     // misma persona y moneda: no se pierde la elección
  assert.equal(el('pago-bolsillo').value, 'ARS Mercado Pago');
});

await caso('Pagar $107.273,16 desde «Franco · ARS Mercado Pago»: sale esa suma, de esa caja, y el pago queda anotado con el bolsillo', async () => {
  const { State, ctx, mod, el } = entorno(['proveedores.js']);
  const debitos = [];
  State.debitarCaja = async (p, b, m, ref) => { debitos.push({ p, b, m, ref }); State.cajas[p][b] = State.cent(State.cajas[p][b] - m); return true; };
  mod.Proveedores.renderKpis = () => {}; mod.Proveedores.renderContent = () => {};
  Object.entries({ 'pago-moneda': 'ARS', 'pago-monto': '107273.16', 'pago-persona': 'Franco', 'pago-bolsillo': 'ARS Mercado Pago', 'pago-fecha': '2026-11-12', 'pago-notas': '' })
    .forEach(([k, v]) => { el(k).value = v; });
  await mod.Proveedores._confirmarPago(7);
  assert.equal(debitos.length, 1);
  assert.deepEqual([debitos[0].p, debitos[0].b, debitos[0].m], ['Franco', 'ARS Mercado Pago', 107273.16]);
  assert.equal(State.cajas.Franco['ARS Mercado Pago'], State.cent(1422260.74 - 107273.16));
  const [loteId, pago] = ctx.__guardados[0];
  assert.equal(loteId, 7);
  assert.equal(pago.bolsillo, 'ARS Mercado Pago'); assert.equal(pago.moneda, 'ARS'); assert.equal(pago.persona, 'Franco');
  assert.ok(Math.abs(pago.montoUsd - 107273.16 / 1590) < 1e-9, 'el equivalente en USD sigue la convención del CRM (monto / blue)');
});

// ── Costo adicional y devolución ──
await caso('Costo adicional: «Pagado por» Franco ofrece «ARS Mercado Pago»; sin persona, todas las que existen', () => {
  const { mod, els, el } = entorno(['proveedores.js']);
  mod.Proveedores.modalCostoAdicional(7);
  assert.ok(valores(els.__overlay.innerHTML.slice(els.__overlay.innerHTML.indexOf('id="costo-bolsillo"'))).includes('ARS Mercado Pago'), 'sin persona: todas las existentes');
  assert.ok(/id="costo-persona" onchange="Proveedores\._syncCostoBolsillos\(\)"/.test(els.__overlay.innerHTML));
  el('costo-persona').value = 'Angel';
  mod.Proveedores._syncCostoBolsillos();
  assert.ok(!valores(el('costo-bolsillo').innerHTML).includes('ARS Mercado Pago'), 'Angel no la tiene');
  el('costo-persona').value = 'Franco';
  mod.Proveedores._syncCostoBolsillos();
  assert.ok(valores(el('costo-bolsillo').innerHTML).includes('ARS Mercado Pago'));
});

await caso('Devolución del proveedor: sale la caja de la persona, la elegida por defecto sigue siendo en DÓLARES y acredita USD 50 (no 50 pesos)', async () => {
  const { State, ctx, mod, els, el } = entorno(['proveedores.js']);
  mod.Proveedores._cuentaLote = () => ({ excedenteBruto: 50 });
  mod.Proveedores._modalDevolucion(7, 50);
  const html = els.__overlay.innerHTML;
  const opciones = valores(html.slice(html.indexOf('id="dev-bolsillo"')));
  assert.deepEqual(opciones, ['USD cash', 'USD transferencia', 'USDT', 'ARS cash', 'ARS transferencia', 'ARS Mercado Pago']);
  assert.deepEqual(valores(mod.Proveedores._bolsillosOpts('Angel')), ['USD cash', 'USD transferencia', 'USDT', 'ARS cash', 'ARS transferencia']);
  // se confirma SIN tocar la caja: lo elegido por defecto debe ser USD cash
  const acreditos = [];
  State.acreditarCaja = async (p, b, m) => { acreditos.push({ p, b, m }); return true; };
  mod.Proveedores.renderContent = () => {};
  el('dev-persona').value = 'Franco'; el('dev-monto').value = '50'; el('dev-notas').value = '';
  el('dev-bolsillo').innerHTML = mod.Proveedores._bolsillosOpts('Franco');   // lo que hace el selector de persona
  await mod.Proveedores.confirmarDevolucion(7);
  assert.deepEqual([acreditos[0]?.p, acreditos[0]?.b, acreditos[0]?.m], ['Franco', 'USD cash', 50]);
  assert.equal(ctx.__guardados[0][1].bolsillo, 'USD cash');
});

await caso('Devolución a una persona que solo tiene cajas en pesos: no queda ninguna elegida (no acredita USD 50 como pesos) y exige elegir', async () => {
  const { State, mod, el, toasts } = entorno(['proveedores.js']);
  State.cajas.Lautaro = { 'ARS cash': 10, 'ARS Mercado Pago': 20 };
  const opts = valores(mod.Proveedores._bolsillosOpts('Lautaro'));
  assert.deepEqual(opts, ['', 'ARS cash', 'ARS Mercado Pago']);                  // el primero es el «— Elegí la caja —»
  const acreditos = [];
  State.acreditarCaja = async (...a) => { acreditos.push(a); return true; };
  mod.Proveedores._cuentaLote = () => ({ excedenteBruto: 50 });
  el('dev-persona').value = 'Lautaro'; el('dev-monto').value = '50';
  el('dev-bolsillo').innerHTML = mod.Proveedores._bolsillosOpts('Lautaro');
  await mod.Proveedores.confirmarDevolucion(7);
  assert.equal(acreditos.length, 0, 'no se acreditó nada');
  assert.ok(toasts.some(t => /Completá todos los campos/.test(t)));
  assert.ok(!mod.Proveedores._bolsillosOpts('Franco').includes('Elegí la caja'), 'con cajas en dólares queda USD cash por defecto');
  assert.deepEqual(valores(mod.Proveedores._bolsillosOpts('Persona vacia')).slice(0, 1), ['USD cash']);   // sin cajas cargadas: los 5 de siempre, dólares primero
});

await caso('Solo se ofrecen las cajas que la persona tiene: una persona con una sola caja no recibe ofertas que la base rechazaría', () => {
  const { State } = entorno();
  State.cajas.Lautaro = { 'USD transferencia': 10 };
  assert.deepEqual(State.bolsillosPara(null, 'Lautaro'), ['USD transferencia']);
  assert.deepEqual(State.bolsillosPara(['ARS'], 'Lautaro'), []);
  State.cajas.Nuevo = {};                                  // todavía sin cajas cargadas: los 5 de siempre
  assert.deepEqual(State.bolsillosPara(['ARS'], 'Nuevo'), ['ARS cash', 'ARS transferencia']);
  assert.deepEqual(State.bolsillosPara(['ARS'], 'Persona sin entrada'), ['ARS cash', 'ARS transferencia']);
});

console.log(`${n} casos pasan`);
