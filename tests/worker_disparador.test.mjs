// Pruebas de la autenticación del GET del worker (api/meli/worker.js): cada modo acepta SOLO su secreto. Sin red: los casos que pasan la
// autenticación no se prueban acá (hablarían con Mercado Libre y la base); se prueban solo los rechazos y que el modo frecuente no use CRON_SECRET.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.MELI_RPC_SECRET = 'x'.repeat(40); process.env.MELI_APP_ID = '1'; process.env.MELI_CLIENT_SECRET = 'y'.repeat(30);
process.env.CRON_SECRET = 'cron-secreto-de-prueba-0123456789'; process.env.DISPARADOR_SECRET = 'disparador-secreto-de-prueba-0123456789';
const handler = require('../api/meli/worker.js');

let n = 0, fallos = 0;
async function caso(nombre, fn) { n++; try { await fn(); console.log(`ok ${n} - ${nombre}`); } catch (e) { fallos++; console.log(`NO OK ${n} - ${nombre}\n   ${e && e.message}`); } }
const llamar = async ({ url, auth, method = 'GET' }) => {
  const r = { code: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ method, url, headers: auth ? { authorization: `Bearer ${auth}` } : {}, body: null, socket: { remoteAddress: '1.2.3.4' } }, r);
  return r;
};

await caso('El modo frecuente sin secreto → 401', async () => { assert.equal((await llamar({ url: '/api/meli/worker?modo=frecuente' })).code, 401); });
await caso('El modo frecuente con un secreto equivocado → 401', async () => { assert.equal((await llamar({ url: '/api/meli/worker?modo=frecuente', auth: 'otro-secreto-cualquiera-0123456789' })).code, 401); });
await caso('El modo frecuente NO acepta el CRON_SECRET (cada secreto sirve solo para su modo)', async () => { assert.equal((await llamar({ url: '/api/meli/worker?modo=frecuente', auth: process.env.CRON_SECRET })).code, 401); });
await caso('El GET normal (cron diario) NO acepta el DISPARADOR_SECRET', async () => { assert.equal((await llamar({ url: '/api/meli/worker', auth: process.env.DISPARADOR_SECRET })).code, 401); });
await caso('Sin DISPARADOR_SECRET cargado el modo frecuente queda cerrado, aunque se mande vacío', async () => {
  const guardado = process.env.DISPARADOR_SECRET; delete process.env.DISPARADOR_SECRET;
  try { assert.equal((await llamar({ url: '/api/meli/worker?modo=frecuente', auth: '' })).code, 401); assert.equal((await llamar({ url: '/api/meli/worker?modo=frecuente', auth: 'undefined' })).code, 401); }
  finally { process.env.DISPARADOR_SECRET = guardado; }
});
await caso('Un modo desconocido se trata como el GET normal (pide CRON_SECRET)', async () => { assert.equal((await llamar({ url: '/api/meli/worker?modo=otro', auth: process.env.DISPARADOR_SECRET })).code, 401); });
await caso('Los métodos que no son GET/POST se rechazan', async () => { assert.equal((await llamar({ url: '/api/meli/worker', method: 'DELETE' })).code, 405); });
console.log(`\n${n - fallos}/${n} ok`); process.exit(fallos ? 1 : 0);
