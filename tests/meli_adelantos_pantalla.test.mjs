// Pruebas de la pantalla de adelantos de Mercado Pago (src/modules/meli-adelantos.js). Sin red ni navegador: DOM y supa simulados.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let n = 0, fallos = 0;
async function caso(nombre, fn) { n++; try { await fn(); console.log(`ok ${n} - ${nombre}`); } catch (e) { fallos++; console.log(`NO OK ${n} - ${nombre}\n   ${e && e.message}`); } }
const fuente = fs.readFileSync(new URL('../src/modules/meli-adelantos.js', import.meta.url), 'utf8');
const json = (x) => JSON.parse(JSON.stringify(x));

function cargar({ estado = [], campos = {}, confirma = true, rpc = {} } = {}) {
  const llamadas = [], toasts = [], confirmaciones = [];
  const State = { esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), fmtARS: v => '$' + Number(v).toFixed(2), meliAdelantos: estado };
  const ctx = {
    State, console, toast: m => toasts.push(m), confirm: (t) => { confirmaciones.push(t); return confirma; },
    document: { getElementById: id => (id in campos ? { value: campos[id], checked: campos[id] === true } : null), createElement: () => ({ style: {}, remove() {} }), body: { appendChild() {} } },
    supa: { rpc: async (fn, args) => { llamadas.push({ fn, args: json(args) }); return rpc[fn] || { data: { ok: true }, error: null }; } },
    MeliOrdenes: { pintar() {}, _recargar: async () => {} },
  };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(fuente, ctx);
  return { M: ctx.MeliAdelantos, State, llamadas, toasts, confirmaciones };
}
const op = (o = {}) => ({ id: 1, tipo: 'pago', orden: '2000019000000001', monto: 40000, resultado: null, procesada: true, acreditada: false, revertida: false, revisar: false, neto: 40000, ...o });
const adelanto = (ops, o = {}) => ({ id: 7, fecha: '2026-11-03T18:08:00Z', total_adelantado: 123499, costo: 600, recibido: 122899, ops, ...o });

await caso('Lectura de montos: punto, coma y miles', () => {
  const { M } = cargar({});
  assert.equal(M.parseMonto('47061.86'), '47061.86'); assert.equal(M.parseMonto('47.061,86'), '47061.86'); assert.equal(M.parseMonto('$ 1.528.390,94'), '1528390.94');
  assert.equal(M.parseMonto('499'), '499'); for (const mal of ['', '0', '-5', 'abc', '1.234.5', '1,2,3', '10.123']) assert.equal(M.parseMonto(mal), null, mal);
});
await caso('Lista pegada: pagos, bonificaciones Flex, encabezado ignorado y suma exacta', () => {
  const { M } = cargar({});
  const r = M.parseOps('numero_orden;monto\n2000019118778008;47061.86\n2000019128992502\t47.061,86\ncashback_3525790219;499\n\n');
  assert.deepEqual(json(r.ops), [{ tipo: 'pago', orden: '2000019118778008', monto: 47061.86 }, { tipo: 'pago', orden: '2000019128992502', monto: 47061.86 }, { tipo: 'flex', referencia: 'cashback_3525790219', monto: 499 }]);
  assert.equal(r.suma, 94622.72); assert.equal(r.errores.length, 0);
});
await caso('Líneas inválidas se informan con su número y no se cargan', () => {
  const { M } = cargar({});
  const r = M.parseOps('2000019118778008;abc\nXYZ123;50\ncashback_1;0');
  assert.equal(r.ops.length, 0); assert.equal(r.errores.length, 3); assert.match(r.errores[0], /Línea 1/);
});
await caso('Estado de cada operación', () => {
  const { M } = cargar({});
  const t = (o) => M.estadoOp(op(o)).clave;
  assert.equal(t({}), 'lista'); assert.equal(t({ procesada: false }), 'espera'); assert.equal(t({ revertida: true }), 'no'); assert.equal(t({ revisar: true }), 'no');
  assert.equal(t({ neto: 40001 }), 'no'); assert.equal(t({ acreditada: true }), 'lista'); assert.equal(t({ resultado: 'acreditada' }), 'hecha');
});
await caso('Sin el script 27 no muestra nada; con error real avisa; sin adelantos invita a cargar', () => {
  const a = cargar({ estado: null }); assert.equal(a.M.tarjetaHtml(), '');
  const b = cargar({ estado: null }); b.State.meliAdelantosError = true; assert.match(b.M.tarjetaHtml(), /no disponibles/);
  const c = cargar({ estado: [] }); assert.match(c.M.tarjetaHtml(), /Cargar adelanto/);
});
await caso('La tarjeta muestra totales, avance y lo que falta, y escapa todo', () => {
  const { M } = cargar({ estado: [adelanto([op({ orden: '2000019000000001' }), op({ id: 2, orden: '<img src=x onerror=1>', procesada: false }), op({ id: 3, resultado: 'acreditada' }), { id: 4, tipo: 'flex', referencia: 'cashback_<b>', monto: 499, resultado: null }])] });
  const h = M.tarjetaHtml();
  assert.match(h, /1 de 4 acreditadas/); assert.match(h, /Adelantado/); assert.match(h, /todavía sin procesar/); assert.match(h, /Acreditar 1 lista/); assert.match(h, /bonificación de Flex/);
  assert.ok(!/<img src=x/.test(h) && !/cashback_<b>/.test(h), 'sin HTML ejecutable');
});
await caso('Cargar: arma el pedido con fecha de Argentina y solo las operaciones válidas', async () => {
  const { M, llamadas, toasts } = cargar({ campos: { 'meliadel-fecha': '2026-11-03T15:08', 'meliadel-total': '1.000,50', 'meliadel-costo': '10', 'meliadel-ops': '2000019000000001;500,25\n2000019000000002;500,25', 'meliadel-nota': 'prueba' } });
  await M.guardar();
  assert.equal(llamadas[0].fn, 'meli_adelanto_registrar');
  assert.deepEqual(llamadas[0].args, { p_fecha: '2026-11-03T15:08:00-03:00', p_total: 1000.5, p_costo: 10, p_ops: [{ tipo: 'pago', orden: '2000019000000001', monto: 500.25 }, { tipo: 'pago', orden: '2000019000000002', monto: 500.25 }], p_nota: 'prueba' });
  assert.match(toasts[0], /Adelanto cargado/);
});
await caso('Cargar: si la suma no cierra, o faltan datos, NO llama a la base', async () => {
  const a = cargar({ campos: { 'meliadel-fecha': '2026-11-03T15:08', 'meliadel-total': '1000', 'meliadel-costo': '10', 'meliadel-ops': '2000019000000001;500' } });
  await a.M.guardar(); assert.equal(a.llamadas.length, 0); assert.match(a.toasts[0], /no suman/);
  const b = cargar({ campos: { 'meliadel-fecha': '', 'meliadel-total': '1000', 'meliadel-costo': '10', 'meliadel-ops': '2000019000000001;1000' } });
  await b.M.guardar(); assert.equal(b.llamadas.length, 0);
  const c = cargar({ campos: { 'meliadel-fecha': '2026-11-03T15:08', 'meliadel-total': '1000', 'meliadel-costo': '', 'meliadel-ops': '2000019000000001;1000' } });
  await c.M.guardar(); assert.equal(c.llamadas.length, 0);
});
await caso('Cargar: costo 0 es válido y los errores de la base salen en castellano', async () => {
  const a = cargar({ campos: { 'meliadel-fecha': '2026-11-03T15:08', 'meliadel-total': '1000', 'meliadel-costo': '0', 'meliadel-ops': '2000019000000001;1000' } });
  await a.M.guardar(); assert.equal(a.llamadas[0].args.p_costo, 0);
  const b = cargar({ campos: { 'meliadel-fecha': '2026-11-03T15:08', 'meliadel-total': '1000', 'meliadel-costo': '10', 'meliadel-ops': '2000019000000001;1000' }, rpc: { meli_adelanto_registrar: { data: null, error: { message: 'ORDEN_INEXISTENTE', details: '999' } } } });
  await b.M.guardar(); assert.match(b.toasts[0], /no existen en el CRM/);
});
await caso('Acreditar: pide confirmación, manda solo id y flex, y informa lo que quedó', async () => {
  const { M, llamadas, toasts, confirmaciones } = cargar({ campos: { 'meliadel-flex-7': true }, rpc: { meli_adelanto_acreditar: { data: { ok: true, acreditadas: 2, monto_acreditado: 81000, ya_acreditadas: 1, pendientes: 1, flex: 1, monto_flex: 499, detalle: [{ orden: 'x', resultado: 'pendiente', motivo: 'ORDEN_NO_PROCESADA' }] }, error: null } } });
  await M.acreditar({ dataset: { adelanto: '7', monto: '81000', n: '2' } });
  assert.deepEqual(llamadas[0], { fn: 'meli_adelanto_acreditar', args: { p_adelanto_id: 7, p_incluir_flex: true } });
  assert.match(confirmaciones[0], /2 órdenes/); assert.match(confirmaciones[0], /una sola vez/);
  assert.match(toasts[0], /Acreditadas 2 órdenes/); assert.match(toasts[0], /1 ya estaban acreditadas/); assert.match(toasts[0], /1 todavía sin procesar/);
});
await caso('Acreditar: sin confirmar o con un id raro no llama a la base', async () => {
  const a = cargar({ confirma: false }); await a.M.acreditar({ dataset: { adelanto: '7', monto: '1', n: '1' } }); assert.equal(a.llamadas.length, 0);
  const b = cargar({}); await b.M.acreditar({ dataset: { adelanto: '7; DROP', monto: '1', n: '1' } }); assert.equal(b.llamadas.length, 0);
});
await caso('Acreditar: un error de la base se informa y no rompe', async () => {
  const { M, toasts } = cargar({ rpc: { meli_adelanto_acreditar: { data: null, error: { message: 'no autorizado' } } } });
  await M.acreditar({ dataset: { adelanto: '7', monto: '1', n: '1' } }); assert.match(toasts[0], /No estás autorizado/);
});
console.log(`\n${n - fallos}/${n} ok`); process.exit(fallos ? 1 : 0);
