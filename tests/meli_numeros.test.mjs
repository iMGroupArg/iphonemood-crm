// api/_meli_numeros.js: guardar pack_id/shipping.id de cada orden y completar las viejas. De MEJOR ESFUERZO: nada de esto puede romper la ingesta.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { idNum, numerosDeOrden, guardarNumeros, rellenar } = require('../api/_meli_numeros.js');

let n = 0, fallos = 0;
async function caso(nombre, fn) { n++; try { await fn(); console.log(`ok ${n} - ${nombre}`); } catch (e) { fallos++; console.log(`NO OK ${n} - ${nombre}\n   ${e && e.message}`); } }
const sinEspera = () => Promise.resolve();
const leer = (ruta) => fs.readFileSync(new URL('../' + ruta, import.meta.url), 'utf8');

await caso('numerosDeOrden: toma pack_id y shipping.id; lo raro o ausente es null', () => {
  assert.deepEqual(numerosDeOrden({ pack_id: 2000016191459325, shipping: { id: 48595749791 } }), { pack: '2000016191459325', envio: '48595749791' });
  assert.deepEqual(numerosDeOrden({ pack_id: null, shipping: null }), { pack: null, envio: null });
  assert.deepEqual(numerosDeOrden({ pack_id: '<x>', shipping: { id: 'abc' } }), { pack: null, envio: null });
  assert.deepEqual(numerosDeOrden(null), { pack: null, envio: null });
});
await caso('guardarNumeros: llama a la función con ids validados y devuelve true', async () => {
  const llamadas = []; const rpc = async (nombre, args) => { llamadas.push({ nombre, args }); return { ok: true }; };
  assert.equal(await guardarNumeros({ rpc, orden: '2000019701976556', pack: '2000016191459325', envio: '48595749791' }), true);
  assert.deepEqual(llamadas, [{ nombre: 'meli_orden_ml_numeros_set', args: { p_orden_id: '2000019701976556', p_pack: '2000016191459325', p_envio: '48595749791' } }]);
});
await caso('guardarNumeros: si la base falla (script sin correr) devuelve false y NO lanza', async () => {
  assert.equal(await guardarNumeros({ rpc: async () => { throw new Error('PGRST202'); }, orden: '1', pack: '2', envio: '3' }), false);
  assert.equal(await guardarNumeros({ rpc: async () => ({ ok: false }), orden: '1', pack: '2', envio: '3' }), false);
});
await caso('guardarNumeros: una orden inválida ni siquiera llama a la base', async () => {
  let llamo = false; assert.equal(await guardarNumeros({ rpc: async () => { llamo = true; }, orden: 'x; DROP', pack: '1', envio: '2' }), false); assert.equal(llamo, false);
});
await caso('guardarNumeros: pack/envío inválidos viajan como null (no se inventa nada)', async () => {
  let args; await guardarNumeros({ rpc: async (_, a) => { args = a; return { ok: true }; }, orden: '5', pack: 'zzz', envio: '' }); assert.deepEqual([args.p_pack, args.p_envio], [null, null]);
});

const armar = ({ lista, respuestas = {}, rpcFalla = false, restante = 20000 }) => {
  const guardados = [], pedidos = []; let tiempo = restante;
  const rpc = async (nombre, args) => {
    if (rpcFalla) throw new Error('no existe');
    if (nombre === 'meli_ordenes_sin_numeros') return lista;
    if (nombre === 'meli_orden_ml_numeros_set') { guardados.push(args); return { ok: true }; }
    throw new Error('rpc inesperada ' + nombre);
  };
  const meliGet = async (cuenta, ruta) => { pedidos.push({ cuenta, ruta }); const id = ruta.split('/').pop(); const r = respuestas[id]; if (r instanceof Error) throw r; return r || { status: 200, ok: true, json: { id: Number(id), pack_id: null, shipping: { id: 9 } } }; };
  return { rpc, meliGet, guardados, pedidos, restanteMs: () => tiempo, bajar: (ms) => { tiempo -= ms; }, pres: {} };
};
await caso('rellenar: lee de Mercado Libre y guarda pack y envío de cada orden pendiente', async () => {
  const x = armar({ lista: [{ meli_order_id: '2000019701976556', cuenta_id: 1 }, { meli_order_id: '2000000000002', cuenta_id: 1 }],
    respuestas: { 2000019701976556: { status: 200, ok: true, json: { id: 1, pack_id: 2000016191459325, shipping: { id: 48595749791 } } } } });
  const r = await rellenar({ ...x, esperar: sinEspera });
  assert.equal(r.leidas, 2);
  assert.deepEqual(x.pedidos.map(p => p.ruta), ['/orders/2000019701976556', '/orders/2000000000002']);
  assert.deepEqual(x.guardados[0], { p_orden_id: '2000019701976556', p_pack: '2000016191459325', p_envio: '48595749791' });
  assert.equal(x.guardados[1].p_pack, null);          // una orden sin pack igual queda leída
});
await caso('rellenar: hace una pausa entre pedidos a Mercado Libre', async () => {
  const x = armar({ lista: [{ meli_order_id: '11', cuenta_id: 1 }, { meli_order_id: '12', cuenta_id: 1 }, { meli_order_id: '13', cuenta_id: 1 }] }); const pausas = [];
  await rellenar({ ...x, pausaMs: 250, esperar: async (ms) => { pausas.push(ms); } });
  assert.deepEqual(pausas, [250, 250, 250]);
});
await caso('rellenar: ante un 429 corta y no insiste', async () => {
  const x = armar({ lista: [{ meli_order_id: '21', cuenta_id: 1 }, { meli_order_id: '22', cuenta_id: 1 }], respuestas: { 21: { status: 429, ok: false, json: null } } });
  const r = await rellenar({ ...x, esperar: sinEspera }); assert.equal(r.cortado, 'limite'); assert.equal(x.pedidos.length, 1); assert.equal(x.guardados.length, 0);
});
await caso('rellenar: un error de red corta sin lanzar', async () => {
  const x = armar({ lista: [{ meli_order_id: '31', cuenta_id: 1 }], respuestas: { 31: new Error('red') } });
  const r = await rellenar({ ...x, esperar: sinEspera }); assert.equal(r.cortado, 'error'); assert.equal(x.guardados.length, 0);
});
await caso('rellenar: un 404 marca la orden como leída (no se reintenta para siempre); un 500 la deja pendiente', async () => {
  const x = armar({ lista: [{ meli_order_id: '41', cuenta_id: 1 }, { meli_order_id: '42', cuenta_id: 1 }],
    respuestas: { 41: { status: 404, ok: false, json: { message: 'x' } }, 42: { status: 500, ok: false, json: null } } });
  await rellenar({ ...x, esperar: sinEspera });
  assert.deepEqual(x.guardados, [{ p_orden_id: '41', p_pack: null, p_envio: null }]);
});
await caso('rellenar: script 35 sin correr → se omite sin error y sin tocar Mercado Libre', async () => {
  const x = armar({ lista: [], rpcFalla: true }); const r = await rellenar({ ...x, esperar: sinEspera });
  assert.deepEqual(r, { omitido: 'sin_script' }); assert.equal(x.pedidos.length, 0);
});
await caso('rellenar: sin tiempo suficiente no empieza; sin pendientes no pide nada', async () => {
  const a = armar({ lista: [{ meli_order_id: '51', cuenta_id: 1 }], restante: 1000 }); assert.deepEqual(await rellenar({ ...a, esperar: sinEspera }), { omitido: 'sin_tiempo' }); assert.equal(a.pedidos.length, 0);
  const b = armar({ lista: [] }); assert.deepEqual(await rellenar({ ...b, esperar: sinEspera }), { pendientes: 0, leidas: 0 });
});
await caso('rellenar: se corta entre órdenes si se agota el tiempo', async () => {
  const x = armar({ lista: [{ meli_order_id: '61', cuenta_id: 1 }, { meli_order_id: '62', cuenta_id: 1 }], restante: 5000 });
  const r = await rellenar({ ...x, esperar: async () => { x.bajar(3000); } }); assert.equal(r.leidas, 1); assert.equal(r.cortado, 'tiempo');
});
await caso('rellenar: respeta el tope por vuelta y avisa que quedan más', async () => {
  const lista = Array.from({ length: 3 }, (_, i) => ({ meli_order_id: String(70 + i), cuenta_id: 1 })); const x = armar({ lista });
  const r = await rellenar({ ...x, max: 3, esperar: sinEspera }); assert.equal(r.leidas, 3); assert.equal(r.quedan_mas, true);
});
await caso('rellenar: ignora filas con ids o cuenta inválidos', async () => {
  const x = armar({ lista: [{ meli_order_id: 'abc', cuenta_id: 1 }, { meli_order_id: '81', cuenta_id: 'x' }, { meli_order_id: '82', cuenta_id: 0 }] });
  const r = await rellenar({ ...x, esperar: sinEspera }); assert.equal(r.leidas, 0); assert.equal(x.pedidos.length, 0);
});
await caso('Conexión: la ingesta guarda los números DESPUÉS de ingresar la orden y sin depender del resultado', async () => {
  const s = leer('api/_meli_ingesta.js');
  assert.match(s, /require\('\.\/_meli_numeros\.js'\)/);
  const i = s.indexOf("await M.rpc('meli_ingresar_orden'"), j = s.indexOf('guardarNumeros({ rpc: M.rpc, orden: orderId'), k = s.indexOf("if (!fin.financiera_ok) return");
  assert.ok(i > 0 && j > i && k > j, 'orden de las llamadas');
});
await caso('Conexión: el ciclo del worker completa las viejas al final, en un try/catch propio, y no suma funciones', async () => {
  const w = leer('api/meli/worker.js');
  assert.match(w, /rellenarNumeros\(\{ rpc: M\.rpc, meliGet: M\.meliGet/);
  assert.ok(w.indexOf('rellenarNumeros({') > w.indexOf('correrPush({ rpc: M.rpc, pres: M.presupuestoHasta(limitePush'));
  assert.match(w, /meli\/worker \(números de Mercado Libre\)/);
});
await caso('El módulo no toca stock, facturas, caja ni liquidación', () => {
  const s = leer('api/_meli_numeros.js');
  assert.ok(!/meli_procesar|meli_acreditar|meli_descontar|arca_|caja|stock_|factura/i.test(s.replace(/\/\/.*$/gm, '')));
});
console.log(`${n - fallos} pasan, ${fallos} fallan de ${n}`);
process.exit(fallos ? 1 : 0);
