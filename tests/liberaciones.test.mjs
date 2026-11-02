// node + vm, sin base ni navegador reales.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const fuente = fs.readFileSync(new URL('../src/modules/liberaciones.js', import.meta.url), 'utf8');
const AHORA = '2026-10-09T15:00:00-03:00';
const orden = extra => ({ procesada: true, acreditado: false, financieraCompleta: true,
  neto: 100.10, fechaLiberacion: '2026-10-09T14:00:00-03:00', ...extra });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function entorno({ almacen = new Map(), falla = false } = {}) {
  let tiempo = AHORA;
  const toasts = [], elementos = {};
  class Reloj extends Date { constructor(...args) { super(...(args.length ? args : [tiempo])); } }
  const ctx = { Date: Reloj, State: { meliOrdenes: [], esc, fmtARS: n => '$' + Math.round(n).toLocaleString('es-AR') },
    document: { getElementById: id => elementos[id] }, toast: t => toasts.push(t),
    sessionStorage: { getItem(k) { if (falla) throw Error('bloqueado'); return almacen.get(k); },
      setItem(k, v) { if (falla) throw Error('bloqueado'); almacen.set(k, v); } } };
  ctx.window = ctx;
  vm.createContext(ctx); vm.runInContext(fuente, ctx);
  return { ctx, L: ctx.Liberaciones, S: ctx.State, toasts, elementos, setTiempo: t => { tiempo = t; } };
}
const { L } = entorno();
const resumen = (os, ahora = AHORA) => L.resumen(os, new Date(ahora));
let casos = 0;
function test(nombre, fn) { fn(); casos++; console.log(`ok ${casos} · ${nombre}`); }
test('1. Hoy después de la hora', () => {
  const r = resumen([orden()]); assert.equal(r.hoy.ordenes, 1); assert.equal(r.hoy.yaLiberadas.ordenes, 1); assert.equal(r.hoy.yaLiberadas.monto, 100.1); assert.equal(L.cantidadBadge(r), 1);
});
test('2. Hoy antes de la hora', () => {
  const r = resumen([orden()], '2026-10-09T10:00:00-03:00'); assert.equal(r.hoy.ordenes, 1); assert.equal(r.hoy.yaLiberadas.ordenes, 0); assert.equal(r.hoy.pendientesHora.ordenes, 1); assert.equal(r.hoy.pendientesHora.monto, 100.1); assert.equal(L.cantidadBadge(r), 0);
});
test('3. Ayer y cambio de año AR', () => {
  assert.equal(resumen([orden({ fechaLiberacion: '2026-10-08T14:00:00-03:00' })]).atrasadas.ordenes, 1);
  assert.equal(resumen([orden({ fechaLiberacion: '2026-12-31T23:30:00-03:00' })], '2027-01-01T00:10:00-03:00').atrasadas.ordenes, 1);
});
test('4. Borde UTC pertenece al día anterior AR', () => {
  const r = resumen([orden({ fechaLiberacion: '2026-10-09T02:30:00Z' })], '2026-10-09T02:45:00Z'); assert.equal(r.hoy.ordenes, 1); assert.equal(r.atrasadas.ordenes, 0);
  assert.equal(resumen([orden({ fechaLiberacion: '2026-10-09T02:30:00Z' })]).atrasadas.ordenes, 1);
});
test('5. Exclusiones', () => {
  for (const extra of [{ acreditado: true }, { revertidaEn: 'x' }, { cerradaManualEn: 'x' }, { cerradaManual: { motivo: 'ya_cargada', en: '2026-10-08T12:00:00Z' } }, { revisar: true }, { procesada: false }, { neto: null }, { neto: 0 }, { neto: NaN }, { neto: Infinity }, { neto: '100' }, { neto: -1 }, { financieraCompleta: false }, { fechaLiberacion: 'inválida' }, { fechaLiberacion: null }, { fechaLiberacion: '2026-10-09T14:00:00' }]) {
    assert.equal(resumen([orden(extra)]).hoy.ordenes, 0, JSON.stringify(extra));
  }
  assert.equal(resumen([orden({ financieraCompleta: false })]).sinDato.ordenes, 1);
});
test('6. Neto nulo/ausente no suma y sinDato sigue su definición', () => {
  const r = resumen([orden(), orden({ neto: null }), orden({ neto: undefined })]); assert.equal(r.sinDato.ordenes, 2); assert.equal(r.hoy.monto, 100.1); assert.equal(r.hoy.ordenes, 1);
  assert.equal(resumen([orden({ neto: null, revisar: true })]).sinDato.ordenes, 1);
  for (const extra of [{ acreditado: true }, { revertidaEn: 'x' }, { cerradaManualEn: 'x' }, { cerradaManual: { motivo: 'ya_cargada', en: '2026-10-08T12:00:00Z' } }, { procesada: false }]) assert.equal(resumen([orden({ neto: null, ...extra })]).sinDato.ordenes, 0);
});
test('7. Centavos redondeados', () => {
  assert.equal(resumen([orden({ neto: 37757.26 }), orden()]).hoy.monto, 37857.36);
  assert.equal(resumen([orden({ neto: 0.1 }), orden({ neto: 0.2 })]).hoy.monto, 0.3);
});
test('8. Próximos días 1 y 3; excluye 4', () => {
  const r = resumen([10, 12, 13].map(d => orden({ fechaLiberacion: `2026-10-${d}T23:59:00-03:00` }))); assert.equal(r.proximas.ordenes, 2); assert.equal(r.proximas.monto, 200.2);
});
test('9. Sin procesar hoy/antes, sin revisión/cierre/reversión', () => {
  const os = [{}, { fechaLiberacion: '2026-10-08T14:00:00-03:00' }, { revisar: true }, { revertidaEn: 'x' }, { cerradaManualEn: 'x' }, { cerradaManual: { motivo: 'ya_cargada', en: '2026-10-08T12:00:00Z' } }, { fechaLiberacion: '2026-10-10T14:00:00-03:00' }].map(x => orden({ procesada: false, ...x })); assert.equal(resumen(os).sinProcesar.ordenes, 2);
});
test('10. Avisos exactos, combinaciones y concordancia', () => {
  const futura = orden({ fechaLiberacion: '2026-10-09T18:00:00-03:00' }), ayer = orden({ fechaLiberacion: '2026-10-08T14:00:00-03:00' });
  assert.equal(L.textoAviso(resumen([])), '');
  assert.equal(L.textoAviso(resumen([futura])), 'Hoy se liberan $100 en 1 orden.');
  assert.equal(L.textoAviso(resumen([ayer])), 'Tenés 1 liberada sin confirmar por $100.');
  assert.equal(L.textoAviso(resumen([orden(), ayer])), 'Hoy se liberan $100 en 1 orden. Tenés 2 liberadas sin confirmar por $200.');
  assert.equal(L.textoAviso(resumen([futura, futura])), 'Hoy se liberan $200 en 2 órdenes.');
});
test('11. Aviso una vez por día AR/pestaña, almacenamiento fallido y carga', () => {
  const almacen = new Map(), e = entorno({ almacen });
  e.L.avisoAlAbrir(); assert.equal(e.toasts.length, 0);
  e.S.meliOrdenes = [orden()]; e.S.meliError = true; e.L.avisoAlAbrir(); assert.equal(e.toasts.length, 0);
  e.S.meliError = false; e.L.avisoAlAbrir(); e.L.avisoAlAbrir(); assert.equal(e.toasts.length, 1);
  const recarga = entorno({ almacen }); recarga.S.meliOrdenes = [orden()]; recarga.L.avisoAlAbrir(); assert.equal(recarga.toasts.length, 0);
  e.setTiempo('2026-10-10T02:59:00Z'); e.L.avisoAlAbrir(); assert.equal(e.toasts.length, 1);
  e.setTiempo('2026-10-10T03:00:00Z'); e.L.avisoAlAbrir(); assert.equal(e.toasts.length, 2);
  const otra = entorno(); otra.S.meliOrdenes = [orden()]; otra.L.avisoAlAbrir(); assert.equal(otra.toasts.length, 1);
  const falla = entorno({ falla: true }); falla.S.meliOrdenes = [orden()]; falla.L.avisoAlAbrir(); falla.L.avisoAlAbrir(); assert.equal(falla.toasts.length, 1);
  const vacio = entorno(); vacio.S.meliOrdenes = [orden({ acreditado: true })]; vacio.L.avisoAlAbrir(); vacio.S.meliOrdenes = [orden()]; vacio.L.avisoAlAbrir(); assert.equal(vacio.toasts.length, 1);
});
test('12. Badge ausente/oculto/visible y error', () => {
  const e = entorno(); assert.doesNotThrow(() => e.L.actualizarBadge());
  const b = e.elementos['badge-meli'] = { style: {} }; e.L.actualizarBadge(); assert.equal(b.style.display, 'none');
  e.S.meliOrdenes = [orden(), orden()]; e.L.actualizarBadge(); assert.equal(b.style.display, 'inline-flex'); assert.equal(b.textContent, '2');
  e.S.meliError = true; e.L.actualizarBadge(); assert.equal(b.style.display, 'none');
});
test('13. Tarjeta textos exactos, líneas aisladas y escapado', () => {
  const e = entorno(); assert.equal(e.L.tarjetaHtml(), '');
  e.S.meliOrdenes = [orden(), orden({ fechaLiberacion: '2026-10-09T18:00:00-03:00' }), orden({ fechaLiberacion: '2026-10-10T14:00:00-03:00' }), orden({ procesada: false }), orden({ neto: null })];
  const html = e.L.tarjetaHtml();
  for (const texto of ['Liberaciones de Mercado Libre', 'Hoy se liberan <strong>$200</strong> (2 órdenes) · 1 todavía no llegaron a su hora', 'Liberadas sin confirmar: <strong>$100</strong> (1 orden) — confirmá la acreditación en cada orden', 'Próximos 3 días: <strong>$100</strong> (1 orden)', 'Hay 1 orden sin procesar cuya plata ya se libera: procesalas primero', '1 orden sin importe confirmado (no suman)']) assert.ok(html.includes(texto), texto);
  for (const extra of [{ neto: null }, { procesada: false }]) { e.S.meliOrdenes = [orden(extra)]; const h = e.L.tarjetaHtml(); assert.ok(h.includes('Liberaciones de Mercado Libre')); assert.ok(!h.includes('Hoy se liberan')); }
  e.S.meliOrdenes = [orden()]; e.S.fmtARS = () => '<img src=x onerror=alert(1)>'; assert.ok(e.L.tarjetaHtml().includes('&lt;img')); assert.ok(!e.L.tarjetaHtml().includes('<img'));
  e.L.avisoAlAbrir(); assert.ok(e.toasts[0].includes('&lt;img'));
});
test('14. Entrada profundamente congelada no se modifica', () => {
  const congelar = o => { if (o && typeof o === 'object') { Object.values(o).forEach(congelar); Object.freeze(o); } return o; };
  const os = congelar([orden(), orden({ neto: null }), orden({ procesada: false })]); const antes = JSON.stringify(os);
  assert.doesNotThrow(() => resumen(os)); assert.equal(JSON.stringify(os), antes);
  const e = entorno(); e.S.meliOrdenes = os; e.L.tarjetaHtml(); e.L.actualizarBadge(); e.L.avisoAlAbrir(); assert.strictEqual(e.S.meliOrdenes, os); assert.equal(JSON.stringify(os), antes);
});
test('15. El aviso suma las transferencias pendientes de Actividades (si el módulo está) y funciona sin él', () => {
  const e = entorno(); const futura = orden({ fechaLiberacion: '2026-10-09T18:00:00-03:00' });
  assert.equal(e.L.textoAviso(resumen([futura])), 'Hoy se liberan $100 en 1 orden.');
  e.ctx.window.Actividades = { textoPendientes: () => 'Tenés 2 transferencias pendientes por $170.000.' };
  assert.equal(e.L.textoAviso(resumen([futura])), 'Hoy se liberan $100 en 1 orden. Tenés 2 transferencias pendientes por $170.000.');
  e.ctx.window.Actividades = { textoPendientes: () => '' };
  assert.equal(e.L.textoAviso(resumen([futura])), 'Hoy se liberan $100 en 1 orden.');
  e.ctx.window.Actividades = { textoPendientes: () => { throw Error('no debe tirar el aviso'); } };
  assert.equal(e.L.textoAviso(resumen([futura])), 'Hoy se liberan $100 en 1 orden.');   // un fallo del otro módulo no rompe el aviso
});
console.log(`${casos} casos de liberaciones pasaron.`);
