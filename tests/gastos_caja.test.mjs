// Registrar gasto: la caja se elige a propósito, sigue a la moneda y a la persona, y nada raro llega a DB.crearGasto.
import fs from 'node:fs'; import vm from 'node:vm'; import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url).pathname;
let campos = {}, toasts = [], creados = 0;
const ctx = { localStorage: { getItem: () => null, setItem() {} }, console, window: {},
  toast: m => toasts.push(m), Sheets: { gasto() {} },
  document: { getElementById: id => (id in campos ? { value: campos[id], set innerHTML(v) { campos[id + '#html'] = v; }, options: [] } : null) } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(root + 'src/modules/state.js', 'utf8') + '\nthis.State=State;', ctx);
vm.runInContext(fs.readFileSync(root + 'src/modules/gastos.js', 'utf8') + '\nthis.Gastos=Gastos;', ctx);
ctx.toast = m => toasts.push(m); // state.js define su propio toast: se reemplaza para leer los avisos
ctx.DB = { crearGasto: async () => { creados++; return 'g1'; }, eliminarGasto: async () => true };
const S = ctx.State, G = ctx.Gastos;
S.personas = ['Franco', 'Angel', 'Raro <b>'];
S.cajas = { Franco: { 'ARS cash': 5, 'ARS Mercado Pago': 100, 'USD cash': 1, USDT: 1 }, Angel: { 'ARS cash': 1 }, 'Raro <b>': {} };
let debitos = 0; S.debitarCaja = async () => { debitos++; return true; };
const lista = (m, p) => [...G._bolsillosPara(m, p)];
let ok = 0, fallas = 0; const t = (n, f) => { try { f(); ok++; } catch (e) { fallas++; console.log('FALLA', n, '\n  ', e.message); } };
const ta = async (n, f) => { try { await f(); ok++; } catch (e) { fallas++; console.log('FALLA', n, '\n  ', e.message); } };

t('ARS sin persona: incluye Mercado Pago, sin dólares', () => { const l = lista('ARS'); assert.ok(l.includes('ARS Mercado Pago')); assert.ok(!l.some(b => /USD/.test(b))); });
t('USD: dólares y USDT, sin pesos', () => { const l = lista('USD'); assert.ok(l.includes('USDT') && l.includes('USD cash')); assert.ok(!l.some(b => b.startsWith('ARS'))); });
t('ARS de Franco incluye Mercado Pago', () => assert.ok(lista('ARS', 'Franco').includes('ARS Mercado Pago')));
t('ARS de Angel NO incluye el Mercado Pago de Franco', () => assert.ok(!lista('ARS', 'Angel').includes('ARS Mercado Pago')));
t('los 5 de siempre siguen disponibles para cualquiera', () => assert.ok(lista('ARS', 'Angel').includes('ARS transferencia')));
t('nombres con HTML salen escapados en las opciones', () => {
  S.cajas.Franco['ARS </option><option selected>ARS cash'] = 1;
  const h = G._opcionesBolsillo('ARS', 'Franco'); assert.ok(!h.includes('</option><option selected>'), h); assert.ok(h.includes('&lt;/option&gt;'));
  delete S.cajas.Franco['ARS </option><option selected>ARS cash'];
});
const guardar = async (c) => { campos = { 'gf-motivo': 'Adelanto', 'gf-monto': '14519.71', 'gf-caja-persona': 'Franco', 'gf-caja-bolsillo': 'ARS Mercado Pago', 'gf-moneda': 'ARS', 'gf-cat': 'x', 'gf-resp': 'Franco', ...c }; toasts = []; creados = 0; debitos = 0; await G.save(); };
G.catObj = () => ({ nombre: 'x' }); G.close = () => {}; G.renderChips = G.renderKpis = G.renderTable = () => {}; S.gastos = []; S.fmtARS = n => '$' + n; S.fmtUSD = n => 'U$' + n;
const rechaza = (n, c, re) => ta(n, async () => { await guardar(c); assert.equal(creados, 0, 'no debe crear el gasto'); assert.equal(debitos, 0); assert.match(toasts.join('|'), re); });
await ta('caso feliz: Franco · ARS Mercado Pago', async () => { await guardar({}); assert.equal(creados, 1); assert.equal(debitos, 1); assert.match(toasts.at(-1), /Franco · ARS Mercado Pago/); });
await rechaza('monto negativo', { 'gf-monto': '-100' }, /mayor a cero/);
await rechaza('monto cero', { 'gf-monto': '0' }, /mayor a cero/);
await rechaza('monto vacío', { 'gf-monto': '' }, /mayor a cero/);
await rechaza('monto NaN', { 'gf-monto': 'abc' }, /mayor a cero/);
await rechaza('monto con 3 decimales', { 'gf-monto': '0.001' }, /2 decimales/);
await rechaza('sin caja elegida', { 'gf-caja-bolsillo': '' }, /Elegí de qué caja/);
await rechaza('sin persona', { 'gf-caja-persona': '' }, /Elegí de qué caja/);
await rechaza('moneda desconocida', { 'gf-moneda': 'EUR' }, /Moneda no válida/);
await rechaza('persona inexistente', { 'gf-caja-persona': 'Nadie' }, /no existe/);
await rechaza('caja de otra persona', { 'gf-caja-persona': 'Angel' }, /no tiene la caja/);
await rechaza('pesos contra caja en dólares', { 'gf-caja-bolsillo': 'USD cash' }, /es en USD/);
await rechaza('dólares contra caja en pesos', { 'gf-moneda': 'USD' }, /es en ARS/);
await ta('USD contra USDT sí se permite', async () => { await guardar({ 'gf-moneda': 'USD', 'gf-caja-bolsillo': 'USDT', 'gf-monto': '10' }); assert.equal(creados, 1); });
await ta('toast no inyecta HTML de la persona/caja', async () => { S.cajas['Raro <b>'] = { 'ARS cash': 1 }; await guardar({ 'gf-caja-persona': 'Raro <b>', 'gf-caja-bolsillo': 'ARS cash' }); assert.ok(!/<b>/.test(toasts.at(-1)), toasts.at(-1)); });
console.log(`${ok} ok, ${fallas} fallas`); process.exit(fallas ? 1 : 0);
