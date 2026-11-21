// Pruebas del service worker (sw.js) y de push.js con un navegador simulado: mostrar el aviso, abrir sólo direcciones del sitio,
// pedir permiso sólo cuando se puede y explicar el motivo cuando no.   node tests/sw_push_cliente.test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const RAIZ = new URL('..', import.meta.url).pathname;
const igual = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));   // objetos de otro contexto (vm): se comparan por contenido
let n = 0, fallos = 0;
async function caso(nombre, fn) { n++; try { await fn(); console.log(`ok ${n} - ${nombre}`); } catch (e) { fallos++; console.log(`NO OK ${n} - ${nombre}\n   ${e && e.message}`); } }

// ── service worker ───────────────────────────────────────────────────────
function cargarSW({ ventanas = [] } = {}) {
  const oyentes = {}, mostradas = [], abiertas = [], cerradas = [], enfocadas = [], navegadas = [];
  const self = {
    location: { origin: 'https://iphonemood.com' },
    addEventListener: (t, f) => { oyentes[t] = f; },
    skipWaiting: () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => ventanas.map((v) => ({ url: v, focus: async () => { enfocadas.push(v); }, navigate: async (u) => { navegadas.push(u); } })),
      openWindow: async (u) => { abiertas.push(u); },
    },
    registration: { showNotification: async (t, o) => { mostradas.push({ t, o }); } },
  };
  vm.runInNewContext(fs.readFileSync(RAIZ + 'sw.js', 'utf8'), { self, URL, String, JSON, Promise });
  const disparar = async (tipo, ev) => { let p; ev.waitUntil = (x) => { p = x; }; oyentes[tipo](ev); await p; };
  return { oyentes, mostradas, abiertas, enfocadas, navegadas, cerradas, disparar };
}

console.log('\n══ Avisos push: service worker y navegador ══\n');

await caso('Un aviso push se muestra con título, texto, ícono y la dirección a abrir', async () => {
  const sw = cargarSW();
  await sw.disparar('push', { data: { json: () => ({ titulo: 'Tu reparación está lista ✅', cuerpo: 'Tu iPhone 13 ya se puede retirar.', url: '/seguimiento.html?t=abc', tag: 'reparacion-5' }) } });
  assert.equal(sw.mostradas.length, 1);
  const { t, o } = sw.mostradas[0];
  assert.equal(t, 'Tu reparación está lista ✅'); assert.equal(o.body, 'Tu iPhone 13 ya se puede retirar.'); assert.equal(o.tag, 'reparacion-5');
  assert.equal(o.icon, '/assets/icon-192.png'); assert.equal(o.data.url, '/seguimiento.html?t=abc');
});
await caso('SIEMPRE muestra algo (iPhone no admite avisos silenciosos): mensaje vacío, roto o sin datos', async () => {
  for (const data of [null, { json: () => { throw new Error('no es json'); }, text: () => 'texto suelto' }, { json: () => ({}) }]) {
    const sw = cargarSW(); await sw.disparar('push', { data });
    assert.equal(sw.mostradas.length, 1);
    assert.ok(sw.mostradas[0].t.length > 0);
  }
});
await caso('Los textos se acotan (un aviso enorme no rompe la notificación)', async () => {
  const sw = cargarSW(); await sw.disparar('push', { data: { json: () => ({ titulo: 'T'.repeat(500), cuerpo: 'C'.repeat(2000), tag: 'x'.repeat(500) }) } });
  const { t, o } = sw.mostradas[0]; assert.ok(t.length <= 100 && o.body.length <= 300 && o.tag.length <= 80);
});
await caso('Al tocar el aviso se abre la dirección del sitio (ventana nueva si no hay ninguna abierta)', async () => {
  const sw = cargarSW(); let cerrada = false;
  await sw.disparar('notificationclick', { notification: { close: () => { cerrada = true; }, data: { url: '/seguimiento.html?t=abc' } } });
  assert.ok(cerrada); assert.deepEqual(sw.abiertas, ['https://iphonemood.com/seguimiento.html?t=abc']);
});
await caso('Si esa pantalla ya está abierta, se la trae al frente en vez de abrir otra', async () => {
  const sw = cargarSW({ ventanas: ['https://iphonemood.com/login', 'https://iphonemood.com/seguimiento.html?t=abc'] });
  await sw.disparar('notificationclick', { notification: { close() {}, data: { url: '/seguimiento.html?t=abc' } } });
  assert.deepEqual(sw.enfocadas, ['https://iphonemood.com/seguimiento.html?t=abc']); assert.equal(sw.abiertas.length, 0);
});
await caso('Con otra pantalla del sitio abierta, la lleva a la dirección del aviso', async () => {
  const sw = cargarSW({ ventanas: ['https://iphonemood.com/login'] });
  await sw.disparar('notificationclick', { notification: { close() {}, data: { url: '/login' } } });
  assert.ok(sw.enfocadas.length === 1);
});
await caso('Una dirección de OTRO sitio (o rara) NUNCA se abre: se abre la portada del propio sitio', async () => {
  for (const url of ['https://evil.com/robar', '//evil.com', 'javascript:alert(1)', 'http://iphonemood.com.evil.com/']) {
    const sw = cargarSW(); await sw.disparar('notificationclick', { notification: { close() {}, data: { url } } });
    assert.ok(sw.abiertas.every((u) => u.startsWith('https://iphonemood.com/')), `${url} → ${sw.abiertas}`);
  }
});

// ── push.js ──────────────────────────────────────────────────────────────
function cargarPush({ ios = false, instalada = false, soportado = true, permiso = 'default', suscripcion = null, clave = 'A'.repeat(87), respuestaPermiso = 'granted' } = {}) {
  const log = { subs: [], reg: 0 };
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'P'.repeat(87), auth: 'a'.repeat(22) } }), unsubscribe: async () => { log.baja = true; } };
  const reg = { pushManager: { getSubscription: async () => suscripcion, subscribe: async (o) => { log.subs.push(o); return sub; } } };
  const nav = { userAgent: ios ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)' : 'Mozilla/5.0 (Linux; Android 14) Chrome/124', platform: ios ? 'iPhone' : 'Linux armv8l', maxTouchPoints: 5, standalone: instalada,
    ...(soportado ? { serviceWorker: { register: async () => { log.reg++; return reg; }, ready: Promise.resolve(reg), getRegistration: async () => reg } } : {}) };
  // En un navegador real `window` ES el objeto global: Notification, PushManager y navigator son globales.
  const ctx = { navigator: nav, matchMedia: () => ({ matches: instalada }), atob: (x) => Buffer.from(x, 'base64').toString('binary'), fetch: async () => ({ json: async () => ({ clave }) }), Uint8Array, console };
  if (soportado) { ctx.PushManager = function () {}; ctx.Notification = { permission: permiso, requestPermission: async () => { log.pidio = true; return respuestaPermiso; } }; }
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(fs.readFileSync(RAIZ + 'push.js', 'utf8'), ctx);
  const win = ctx;
  return { P: win.Push, log };
}
await caso('Android/Chrome con todo en orden: se puede activar, pide permiso, suscribe con la clave del servidor y guarda', async () => {
  const { P, log } = cargarPush(); let guardado = null;
  const r = await P.activar(async (d) => { guardado = d; return { ok: true }; });
  assert.equal(r.ok, true); assert.ok(log.pidio); assert.equal(log.subs[0].userVisibleOnly, true); assert.equal(guardado.endpoint, 'https://fcm.googleapis.com/fcm/send/x'); assert.equal(guardado.p256dh.length, 87);
});
await caso('iPhone SIN instalar: no se pide permiso (Apple no lo permite) y se explica el motivo', async () => {
  const { P, log } = cargarPush({ ios: true, instalada: false });
  assert.equal((await P.estado()).motivo, 'ios_sin_instalar');
  const r = await P.activar(async () => ({ ok: true })); igual(r, { ok: false, motivo: 'ios_sin_instalar' }); assert.ok(!log.pidio);
});
await caso('iPhone con la app instalada: sí se puede', async () => {
  const { P } = cargarPush({ ios: true, instalada: true });
  const r = await P.activar(async () => ({ ok: true })); assert.equal(r.ok, true);
});
await caso('Navegador sin soporte → "no_soportado"; permiso ya bloqueado → "bloqueado" (sin volver a preguntar)', async () => {
  assert.equal((await cargarPush({ soportado: false }).P.estado()).motivo, 'no_soportado');
  const { P, log } = cargarPush({ permiso: 'denied' });
  assert.equal((await P.activar(async () => ({ ok: true }))).motivo, 'bloqueado'); assert.ok(!log.pidio);
});
await caso('Si la persona toca "No permitir" no se guarda nada', async () => {
  const { P, log } = cargarPush({ respuestaPermiso: 'denied' }); let guardo = false;
  const r = await P.activar(async () => { guardo = true; return { ok: true }; });
  igual(r, { ok: false, motivo: 'bloqueado' }); assert.ok(!guardo && log.subs.length === 0);
});
await caso('Sin clave en el servidor no se pide permiso ni se suscribe', async () => {
  const { P, log } = cargarPush({ clave: null }); igual(await P.activar(async () => ({ ok: true })), { ok: false, motivo: 'sin_servidor' }); assert.ok(!log.pidio);
});
await caso('Si el servidor rechaza la suscripción (por ejemplo token inválido), se cancela en el teléfono también', async () => {
  const { P, log } = cargarPush(); const r = await P.activar(async () => ({ ok: false, motivo: 'token' }));
  igual(r, { ok: false, motivo: 'token' }); assert.ok(log.baja);
});
await caso('Si el servidor rechaza y la suscripción YA existía (sirve a otras reparaciones), NO se cancela en el teléfono', async () => {
  const { P, log } = cargarPush({ suscripcion: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', options: {}, toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'P'.repeat(87), auth: 'a'.repeat(22) } }), unsubscribe: async () => { log.baja = true; } } });
  const r = await P.activar(async () => ({ ok: false, motivo: 'limite' }));
  igual(r, { ok: false, motivo: 'limite' }); assert.ok(!log.baja);
});
await caso('Desactivar con otras reparaciones todavía atadas NO cancela la suscripción del teléfono', async () => {
  const { P, log } = cargarPush({ suscripcion: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', unsubscribe: async () => { log.baja = true; } } });
  const r = await P.desactivar(async () => ({ restantes: 2 })); assert.equal(r.restantes, 2); assert.ok(!log.baja);
});
await caso('Desactivar cancela la suscripción y avisa al servidor para borrarla', async () => {
  const { P, log } = cargarPush({ suscripcion: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', unsubscribe: async () => { log.baja = true; } } }); let borrado = null;
  await P.desactivar(async (ep) => { borrado = ep; }); assert.equal(borrado, 'https://fcm.googleapis.com/fcm/send/x'); assert.ok(log.baja);
});

console.log(`\n${n - fallos}/${n} ok`); process.exit(fallos ? 1 : 0);
