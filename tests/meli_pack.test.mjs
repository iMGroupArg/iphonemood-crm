// Lectura de pack_id y shipping.id de UNA orden (api/_meli_pack.js): solo lectura, tres valores de salida, ids validados.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../api/_meli.js');
const { leerPack, idNum } = require('../api/_meli_pack.js');

let n = 0, fallos = 0;
async function caso(nombre, fn) { n++; try { await fn(); console.log(`ok ${n} - ${nombre}`); } catch (e) { fallos++; console.log(`NO OK ${n} - ${nombre}\n   ${e && e.message}`); } }
const original = M.meliGet;
const simular = (resp) => { const llamadas = []; M.meliGet = async (cuenta, ruta) => { llamadas.push({ cuenta, ruta }); if (resp instanceof Error) throw resp; return resp; }; return llamadas; };

await caso('Devuelve SOLO orden, pack_id y envio_id (descarta comprador, importes y direcciones)', async () => {
  const ll = simular({ id: 2000019701976556, pack_id: 2000016191459325, shipping: { id: 48595749791, cost: 5000 }, buyer: { id: 1, nickname: 'X', email: 'a@b.c' }, total_amount: 99999, payments: [{ id: 1 }] });
  const r = await leerPack({ cuentaId: 1, orden: '2000019701976556' });
  assert.deepEqual(r, { ok: true, orden: '2000019701976556', pack_id: '2000016191459325', envio_id: '48595749791' });
  assert.deepEqual(Object.keys(r).sort(), ['envio_id', 'ok', 'orden', 'pack_id']);
  assert.equal(ll.length, 1); assert.equal(ll[0].ruta, '/orders/2000019701976556'); assert.equal(ll[0].cuenta, 1);
});
await caso('Sin pack_id ni envío: devuelve null (no inventa nada)', async () => {
  simular({ id: 2000000000001, pack_id: null, shipping: {} });
  assert.deepEqual(await leerPack({ cuentaId: 1, orden: 2000000000001 }), { ok: true, orden: '2000000000001', pack_id: null, envio_id: null });
  simular({ id: 2000000000002 });
  assert.deepEqual(await leerPack({ cuentaId: 1, orden: '2000000000002' }), { ok: true, orden: '2000000000002', pack_id: null, envio_id: null });
});
await caso('Valores raros en la respuesta no salen (solo dígitos)', async () => {
  simular({ id: 'abc', pack_id: '<script>', shipping: { id: { x: 1 } } });
  assert.deepEqual(await leerPack({ cuentaId: 1, orden: '2000000000003' }), { ok: true, orden: null, pack_id: null, envio_id: null });
});
for (const malo of ['', null, undefined, '12a', '../x', '2000/1', '1 2', '-5', '1'.repeat(21), { a: 1 }]) {
  await caso(`Orden inválida (${JSON.stringify(malo)}): no llama a Mercado Libre y falla con ORDEN_INVALIDA`, async () => {
    const ll = simular({ id: 1 });
    await assert.rejects(() => leerPack({ cuentaId: 1, orden: malo }), (e) => e.codigo === 'ORDEN_INVALIDA');
    assert.equal(ll.length, 0);
  });
}
await caso('Si Mercado Libre falla, el error sube (el worker responde 502 sin detalle)', async () => {
  simular(new Error('429'));
  await assert.rejects(() => leerPack({ cuentaId: 1, orden: '2000000000004' }), /429/);
});
await caso('idNum acepta solo dígitos de hasta 20', () => {
  assert.equal(idNum('123'), '123'); assert.equal(idNum(123), '123'); assert.equal(idNum('1e5'), null); assert.equal(idNum(''), null); assert.equal(idNum(null), null);
});
await caso('El módulo no escribe: no usa fetch ni RPC, solo meliGet', async () => {
  const src = fs.readFileSync(new URL('../api/_meli_pack.js', import.meta.url), 'utf8');
  assert.ok(!/fetch\(|\.rpc\(|rpc\(|mpGet|method:\s*['"](POST|PUT|PATCH|DELETE)/.test(src));
  assert.equal((src.match(/meliGet\(/g) || []).length, 1);
});
await caso('El worker enruta la acción «pack» y no suma funciones de Vercel', async () => {
  const w = fs.readFileSync(new URL('../api/meli/worker.js', import.meta.url), 'utf8');
  assert.match(w, /accion === 'pack'/); assert.match(w, /require\('\.\.\/_meli_pack\.js'\)/);
  const cuenta = (d) => fs.readdirSync(new URL('../api/' + d, import.meta.url), { withFileTypes: true });
  const raiz = cuenta('').filter(x => x.isFile() && x.name.endsWith('.js') && !x.name.startsWith('_')).length;
  const sub = fs.readdirSync(new URL('../api/', import.meta.url), { withFileTypes: true }).filter(x => x.isDirectory())
    .reduce((t, d) => t + cuenta(d.name).filter(x => x.isFile() && x.name.endsWith('.js') && !x.name.startsWith('_')).length, 0);
  assert.equal(raiz + sub, 11);
});
M.meliGet = original;
console.log(`${n - fallos} pasan, ${fallos} fallan de ${n}`);
process.exit(fallos ? 1 : 0);
