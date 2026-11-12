// Otros selectores de caja (adelantos, reparaciones, cuenta corriente, gastos) usan el helper común State.opcionesBolsillo.
// Corre los módulos reales con DOM y base simulados.
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
    const e = { id, files: [], style: {}, classList: { add() {}, remove() {} }, remove() {}, focus() {}, select() {}, addEventListener() {}, appendChild() {}, dispatchEvent() {},
      _html: '', _valor: undefined,
      get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); this._valor = undefined; },
      get options() { return [...this._html.matchAll(/<option(?:\s+value="([^"]*)")?[^>]*>([^<]*)/g)].map(m => ({ value: m[1] ?? m[2] })); },
      get value() { return this._valor !== undefined ? this._valor : (this.options[0]?.value ?? ''); },
      set value(v) { this._valor = v; },
      textContent: '' };
    return e;
  };
  const el = id => (els[id] ||= nuevoEl(id));
  const creados = [];
  const toasts = [];
  const ctx = {
    DB: { async guardarLotePago(...a) { ctx.__guardados.push(a); return true; }, async actualizarEstadoLote() { return true; } },
    __guardados: [],
    document: {
      getElementById: id => (id === 'toast' ? { set innerHTML(v) { toasts.push(v); }, classList: { add() {}, remove() {} } } : el(id)),
      createElement: () => { const e = nuevoEl('creado'); creados.push(e); return e; },
      body: { appendChild(o) { els.__overlay = o; } },
      querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem() {} },
    confirm: () => true, Sheets: new Proxy({}, { get: () => () => {} }), supa: {}, Auth: { usuario: { nombre: 'Test' } },
    Reportes: { NICHOS: [] }, App: { goTo() {} }, window: {}, setTimeout: () => 0, clearTimeout() {}, Event: class { constructor(t) { this.type = t; } }, console, Date, Math, Number, JSON, String, Promise, Error, Object, Array, Set,
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
  return { State, ctx, el, els, creados, toasts, mod: ctx.window };
}
const valores = html => [...String(html).matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);

// ── Otros lugares ──
// Los onchange están escritos dentro del HTML: se sacan del texto y se EJECUTAN en el entorno, con `this` = el selector de persona.
function onchangeDe(html, id) {
  const m = html.match(new RegExp(`id="${id}"[^>]*?onchange="([^"]*)"`));
  assert.ok(m, `el selector ${id} no tiene onchange`);
  return m[1];
}
function correr(ctx, codigo, esto) { ctx.__esto = esto; vm.runInContext(`(function(){${codigo}}).call(__esto)`, ctx); }

await caso('Adelantos · cobrar: incluye «ARS Mercado Pago» de Franco y, al cambiar a Angel, desaparece (se ejecuta el selector)', () => {
  const { State, ctx, els, el, mod } = entorno(['adelantos.js']);
  State.adelantos = [{ id: 3, socio: 'Angel', motivo: 'x', fecha: '2026-11-01', monto: 1000, moneda: 'ARS' }];
  mod.Adelantos.openCobrar(3);
  const html = els['adelantos-modal-host'].innerHTML;
  assert.ok(valores(html.slice(html.indexOf('id="cob-bolsillo"'))).includes('ARS Mercado Pago'), 'arranca con la primera persona (Franco)');
  const codigo = onchangeDe(html, 'cob-persona');
  el('cob-persona').value = 'Angel';
  correr(ctx, codigo, el('cob-persona'));
  assert.deepEqual(valores(el('cob-bolsillo').innerHTML), ['ARS cash', 'ARS transferencia', 'USD cash', 'USD transferencia', 'USDT']);
  el('cob-persona').value = 'Franco';
  correr(ctx, codigo, el('cob-persona'));
  assert.ok(valores(el('cob-bolsillo').innerHTML).includes('ARS Mercado Pago'));
});

await caso('Reparaciones · seña: «ARS Mercado Pago» disponible y sigue a la persona (se ejecuta el selector)', () => {
  const { ctx, els, el, mod } = entorno(['reparaciones.js']);
  mod.Reparaciones.openAddPagoModal();
  const html = els.__overlay.innerHTML;
  assert.ok(valores(html.slice(html.indexOf('id="rep-p-bolsillo"'))).includes('ARS Mercado Pago'));
  const codigo = onchangeDe(html, 'rep-p-persona');
  el('rep-p-persona').value = 'Angel';
  correr(ctx, codigo, el('rep-p-persona'));
  assert.ok(!valores(el('rep-p-bolsillo').innerHTML).includes('ARS Mercado Pago'));
  assert.equal(valores(el('rep-p-bolsillo').innerHTML).length, 5);
});

await caso('Reparaciones · entrega: la caja de cobro sale de la persona y sigue a la persona (se renderiza y se ejecuta el selector)', async () => {
  const { State, ctx, els, el, mod } = entorno(['reparaciones.js']);
  State.reparaciones = [{ id: 'R1', equipo: 'iPhone', cliente: 'Ana', precioFinal: 100, pagos: [] }];
  mod.Reparaciones.currentId = 'R1';
  await mod.Reparaciones.entregarYCobrar();
  const html = els.__overlay.innerHTML;
  assert.ok(valores(html.slice(html.indexOf('id="rep-e-bolsillo"'))).includes('ARS Mercado Pago'));
  const codigo = onchangeDe(html, 'rep-e-persona');
  el('rep-e-persona').value = 'Angel';
  correr(ctx, codigo, el('rep-e-persona'));
  assert.ok(!valores(el('rep-e-bolsillo').innerHTML).includes('ARS Mercado Pago'));
});

await caso('Cuenta corriente · registrar pago: ofrece «ARS Mercado Pago», sigue a la persona y el rótulo/cotización siguen a la caja elegida', () => {
  const { State, ctx, creados, el, mod } = entorno(['cuentacorriente.js']);
  const CC = mod.CuentaCorriente;
  assert.ok(CC && CC.openRegistrarPago, 'el módulo se cargó');
  CC.isMobile = () => false;
  ['cc-close-pago', 'cc-p-guardar', 'cc-p-monto', 'cc-cotiz-wrap', 'cc-p-monto-label'].forEach(el);
  const eventos = [];
  el('cc-p-bolsillo').dispatchEvent = e => eventos.push(e);
  CC.openRegistrarPago({ nombre: 'Cliente', ventasAbiertas: [], deudasManuales: [] });
  const html = creados.map(c => c.innerHTML).find(h => h.includes('id="cc-p-bolsillo"'));
  assert.ok(html, 'se armó el modal');
  assert.ok(valores(html.slice(html.indexOf('id="cc-p-bolsillo"'))).includes('ARS Mercado Pago'));
  assert.ok(eventos.length >= 1, 'al abrir se dispara el change inicial de la caja (rótulo y cotización según la caja elegida)');
  // cambiar a Angel: desaparece Mercado Pago (se ejecuta el selector del texto)
  const codigoPersona = onchangeDe(html, 'cc-p-persona');
  el('cc-p-persona').value = 'Angel';
  correr(ctx, codigoPersona, el('cc-p-persona'));
  assert.ok(!valores(el('cc-p-bolsillo').innerHTML).includes('ARS Mercado Pago'));
  assert.ok(eventos.length >= 2, 'y se vuelve a avisar el cambio de caja');
  // el change de la caja ajusta rótulo y cotización: una caja en dólares → «Monto en USD» y sin cotización
  const codigoCaja = onchangeDe(html, 'cc-p-bolsillo');
  el('cc-p-bolsillo').value = 'USD cash';
  correr(ctx, codigoCaja, el('cc-p-bolsillo'));
  assert.equal(el('cc-p-monto-label').textContent, 'Monto en USD');
  assert.equal(el('cc-cotiz-wrap').style.display, 'none');
  el('cc-p-bolsillo').value = 'ARS transferencia';
  correr(ctx, codigoCaja, el('cc-p-bolsillo'));
  assert.equal(el('cc-p-monto-label').textContent, 'Monto en ARS');
  assert.equal(el('cc-cotiz-wrap').style.display, 'block');
});

await caso('Cuenta corriente: si la primera persona solo tiene cajas en dólares, al abrir ya queda el rótulo en USD (no «Monto en ARS» con una caja en dólares)', () => {
  const { State, ctx, creados, el, mod } = entorno(['cuentacorriente.js']);
  const CC = mod.CuentaCorriente; CC.isMobile = () => false;
  State.personas = ['Lautaro']; State.cajas = { Lautaro: { 'USD cash': 5 } };
  ['cc-close-pago', 'cc-p-guardar', 'cc-p-monto', 'cc-cotiz-wrap', 'cc-p-monto-label'].forEach(el);
  // el selector real toma sus opciones del HTML del modal; el evento 'change' que recibe corre el onchange que está escrito en ese mismo HTML
  let tipo = null;
  el('cc-p-bolsillo').dispatchEvent = e => {
    tipo = e.type;
    const h = creados.map(c => c.innerHTML).find(x => x.includes('id="cc-p-bolsillo"'));
    el('cc-p-bolsillo').value = valores(h.slice(h.indexOf('id="cc-p-bolsillo"')))[0];   // la caja elegida al abrir = la primera opción
    correr(ctx, onchangeDe(h, 'cc-p-bolsillo'), el('cc-p-bolsillo'));
  };
  CC.openRegistrarPago({ nombre: 'Cliente', ventasAbiertas: [], deudasManuales: [] });
  assert.equal(tipo, 'change', 'al abrir se despacha el evento change de la caja');
  assert.equal(el('cc-p-bolsillo').value, 'USD cash');
  assert.equal(el('cc-p-monto-label').textContent, 'Monto en USD', 'y el rótulo queda en USD apenas se abre');
  assert.equal(el('cc-cotiz-wrap').style.display, 'none');
});

await caso('Lo que NO cambia a propósito: cobros de ventas (ventas.js), alta de persona y conversión USD→USDT siguen con su lista fija', () => {
  const ventas = leer('src/modules/ventas.js');
  assert.equal((ventas.match(/<option>ARS cash<\/option><option>ARS transferencia<\/option><option>USD cash<\/option><option>USD transferencia<\/option><option>USDT<\/option>/g) || []).length, 2);
  assert.ok(leer('src/modules/supabase-config.js').includes("const bolsillos = ['ARS cash', 'ARS transferencia', 'USD cash', 'USD transferencia', 'USDT'];"));
});

console.log(`${n} casos pasan`);
