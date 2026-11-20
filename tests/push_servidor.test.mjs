// Pruebas del envío de avisos push desde el servidor (api/_push.js y el modo ?modo=push del worker), sin red:
// la base y los servicios de push están simulados.   node tests/push_servidor.test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const W = require('../api/_webpush.js');

process.env.MELI_RPC_SECRET = 'x'.repeat(40); process.env.MELI_APP_ID = '1'; process.env.MELI_CLIENT_SECRET = 'y'.repeat(30);
process.env.CRON_SECRET = 'cron-secreto-de-prueba-0123456789'; process.env.DISPARADOR_SECRET = 'disparador-secreto-de-prueba-0123456789';
const claves = W.generarClavesVapid();
process.env.VAPID_PUBLIC_KEY = claves.publica; process.env.VAPID_PRIVATE_KEY = claves.privada; process.env.VAPID_SUBJECT = 'mailto:prueba@iphonemood.com';

const P = require('../api/_push.js');
const handler = require('../api/meli/worker.js');
const conectar = require('../api/meli/conectar.js');

let n = 0, fallos = 0;
async function caso(nombre, fn) { n++; try { await fn(); console.log(`ok ${n} - ${nombre}`); } catch (e) { fallos++; console.log(`NO OK ${n} - ${nombre}\n   ${e && e.message}`); } }

const telefono = () => {
  const ua = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); const jwk = ua.privateKey.export({ format: 'jwk' });
  return { priv: jwk.d, p256dh: W.b64u(Buffer.concat([Buffer.from([4]), W.deB64u(jwk.x), W.deB64u(jwk.y)])), auth: W.b64u(crypto.randomBytes(16)) };
};
const destino = (id, t, host = 'fcm.googleapis.com') => ({ id, endpoint: `https://${host}/fcm/send/${id}`, p256dh: t.p256dh, auth: t.auth });
const evento = (id, destinos, tipo = 'venta_nueva') => ({ evento_id: id, reclamo: `reclamo-${id}`, tipo, mensaje: { titulo: 'Venta nueva 🎉', cuerpo: 'Martín · USD 1840', url: '/login', tag: `venta-${id}` }, destinos });

console.log('\n══ Avisos push: servidor ══\n');

await caso('Sin claves VAPID no se hace nada (y no se le pide nada a la base)', async () => {
  let llamadas = 0;
  const r = await P.correrPush({ rpc: async () => { llamadas++; return []; }, env: {} });
  assert.equal(r.omitido, 'sin_config'); assert.equal(llamadas, 0);
  assert.equal(P.configuracion({ VAPID_PUBLIC_KEY: claves.publica, VAPID_PRIVATE_KEY: 'basura' }), null);
});
await caso('Con claves: toma los avisos, los envía a cada destinatario e informa el resultado a la base', async () => {
  const t1 = telefono(), t2 = telefono(), t3 = telefono(), anotado = [];
  const estados = { 1: 'ok', 2: 'baja', 3: 'reintentar' };
  const rpc = async (nombre, args) => {
    if (nombre === 'push_tomar_pendientes') return [evento(7, [destino(1, t1), destino(2, t2), destino(3, t3)])];
    anotado.push([nombre, args]); return { ok: true };
  };
  const enviarImpl = async (sub, msg, opc) => { assert.equal(msg.titulo, 'Venta nueva 🎉'); assert.equal(opc.ttl, 3600); assert.equal(opc.asunto, 'mailto:prueba@iphonemood.com'); return { estado: estados[Number(sub.endpoint.split('/').pop())] }; };
  const r = await P.correrPush({ rpc, enviarImpl });
  assert.deepEqual([r.eventos, r.enviados, r.bajas, r.reintentos, r.errores], [1, 1, 1, 1, 0]);
  assert.equal(anotado.length, 1); assert.equal(anotado[0][0], 'push_resultado'); assert.equal(anotado[0][1].p_evento_id, 7);
  assert.equal(anotado[0][1].p_reclamo, 'reclamo-7');   // la base sólo acepta el resultado de quien tiene el reclamo
  assert.deepEqual(anotado[0][1].p_resultados, [{ id: 1, estado: 'ok' }, { id: 2, estado: 'baja' }, { id: 3, estado: 'reintentar' }]);
});
await caso('La reparación lista dura 24 h en el servicio de push; la venta, 1 h', async () => {
  const t = telefono(); const ttls = [];
  const rpc = async (n) => (n === 'push_tomar_pendientes' ? [evento(1, [destino(1, t)], 'venta_nueva'), evento(2, [destino(2, t)], 'reparacion_lista')] : {});
  await P.correrPush({ rpc, enviarImpl: async (s, m, o) => { ttls.push(o.ttl); return { estado: 'ok' }; } });
  assert.deepEqual(ttls, [3600, 86400]);
});
await caso('Con muchos destinatarios se manda de a pocos a la vez (no todos de golpe)', async () => {
  const t = telefono(); let activos = 0, maximo = 0;
  const ev = evento(1, Array.from({ length: 20 }, (_, i) => destino(i + 1, t)));
  const r = await P.enviarAviso(ev, P.configuracion(), { simultaneos: 6, enviarImpl: async () => { activos++; maximo = Math.max(maximo, activos); await new Promise((x) => setTimeout(x, 5)); activos--; return { estado: 'ok' }; } });
  assert.equal(r.length, 20); assert.ok(maximo <= 6 && maximo > 1, `máximo simultáneo ${maximo}`);
});
await caso('Con poco tiempo NO se empieza a enviar a más destinatarios: sólo se informan los que se alcanzaron a intentar', async () => {
  const t = telefono(); let enviados = 0;
  const ev = evento(1, Array.from({ length: 10 }, (_, i) => destino(i + 1, t)));
  const r = await P.enviarAviso(ev, P.configuracion(), { simultaneos: 1, minimoMs: 3000, restanteMs: () => (enviados >= 3 ? 500 : 100000), enviarImpl: async () => { enviados++; return { estado: 'ok' }; } });
  assert.equal(r.length, 3); assert.deepEqual(r.map((x) => x.id), [1, 2, 3]);
});
await caso('Sin tiempo para terminar, no empieza otro aviso (queda reclamado y otra corrida lo retoma)', async () => {
  const t = telefono(); let enviados = 0;
  const rpc = async (n) => (n === 'push_tomar_pendientes' ? [evento(1, [destino(1, t)]), evento(2, [destino(2, t)])] : {});
  const r = await P.correrPush({ rpc, enviarImpl: async () => { enviados++; return { estado: 'ok' }; }, restanteMs: () => (enviados >= 1 ? 100 : 100000) });
  assert.equal(r.omitido, 'sin_tiempo'); assert.equal(r.eventos, 1);
});
await caso('Si la base devuelve algo que no es una lista, falla con claridad (no envía nada)', async () => {
  await assert.rejects(() => P.correrPush({ rpc: async () => ({ raro: true }), enviarImpl: async () => { throw new Error('no debía enviar'); } }), /RESPUESTA_INVALIDA/);
});
await caso('Un fallo al anotar el resultado no tira el envío ya hecho', async () => {
  const t = telefono();
  const rpc = async (n) => { if (n === 'push_tomar_pendientes') return [evento(1, [destino(1, t)])]; throw Object.assign(new Error('caída'), { codigo: 'RPC' }); };
  const r = await P.correrPush({ rpc, enviarImpl: async () => ({ estado: 'ok' }) });
  assert.equal(r.enviados, 1);
});

// ── De punta a punta por el worker (?modo=push), con la base y el servicio de push simulados ──
const llamar = async ({ url, auth, method = 'GET', headers = {} }) => {
  const r = { code: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ method, url, headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers }, body: null, socket: { remoteAddress: '1.2.3.4' } }, r);
  return r;
};
await caso('El worker en modo push, con su secreto, envía el aviso CIFRADO al servicio de push y anota el resultado en la base', async () => {
  const tel = telefono(), original = globalThis.fetch, vistos = { push: null, resultado: null };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/rpc/push_tomar_pendientes')) return new Response(JSON.stringify([evento(9, [destino(5, tel)])]), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('/rest/v1/rpc/push_resultado')) { vistos.resultado = JSON.parse(opts.body); return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }); }
    if (u.startsWith('https://fcm.googleapis.com/')) { vistos.push = { u, opts }; return new Response('', { status: 201 }); }
    throw new Error('llamada inesperada: ' + u);
  };
  try {
    const r = await llamar({ url: '/api/meli/worker?modo=push', auth: process.env.DISPARADOR_SECRET });
    assert.equal(r.code, 200); assert.equal(r.body.push.enviados, 1);
    assert.equal(vistos.resultado.p_secreto, process.env.MELI_RPC_SECRET); assert.deepEqual(vistos.resultado.p_resultados, [{ id: 5, estado: 'ok' }]);
    assert.match(vistos.push.opts.headers.Authorization, /^vapid t=.+, k=/);
    assert.equal(JSON.parse(W.descifrar(vistos.push.opts.body, tel.priv, tel.p256dh, tel.auth)).cuerpo, 'Martín · USD 1840');
  } finally { globalThis.fetch = original; }
});
await caso('Si la base falla, el worker responde 502 sin detalles y no enciende nada más', async () => {
  const original = globalThis.fetch; globalThis.fetch = async () => new Response('{"message":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } });
  try { const r = await llamar({ url: '/api/meli/worker?modo=push', auth: process.env.DISPARADOR_SECRET }); assert.equal(r.code, 502); assert.deepEqual(r.body, { error: 'No se pudieron enviar los avisos' }); }
  finally { globalThis.fetch = original; }
});

// ── Clave pública ────────────────────────────────────────────────────────
await caso('GET /api/push/clave devuelve la clave PÚBLICA (nunca la privada) y se puede guardar en caché', async () => {
  const r = await llamar({ url: '/api/meli/conectar?_f=push' }).catch(() => null);
  const res = { code: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await conectar({ method: 'GET', url: '/api/meli/conectar?_f=push', query: { _f: 'push' }, headers: {}, socket: { remoteAddress: '5.6.7.8' } }, res);
  assert.equal(res.code, 200); assert.equal(res.body.clave, claves.publica); assert.ok(!JSON.stringify(res.body).includes(claves.privada)); assert.match(res.headers['Cache-Control'], /public/);
});
await caso('Sin claves configuradas la clave pública es null (la pantalla no ofrece los avisos)', async () => {
  const g1 = process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PUBLIC_KEY;
  const res = { code: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  try { await conectar({ method: 'GET', url: '/api/meli/conectar?_f=push', query: { _f: 'push' }, headers: {}, socket: { remoteAddress: '5.6.7.9' } }, res); assert.equal(res.body.clave, null); }
  finally { process.env.VAPID_PUBLIC_KEY = g1; }
});
await caso('Otro método que no sea GET → 405', async () => {
  const res = { code: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await conectar({ method: 'POST', url: '/api/meli/conectar?_f=push', query: { _f: 'push' }, headers: {}, socket: { remoteAddress: '5.6.7.10' } }, res);
  assert.equal(res.code, 405);
});

console.log(`\n${n - fallos}/${n} ok`); process.exit(fallos ? 1 : 0);
