// Pruebas de las decisiones de avisos-web.js: cuándo se invita, cuánto se espera tras un «ahora no» y cómo se explican los motivos.
//   node tests/avisos_web.test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const RAIZ = new URL('..', import.meta.url).pathname;
let n = 0, fallos = 0;
function caso(nombre, fn) { n++; try { fn(); console.log(`ok ${n} - ${nombre}`); } catch (e) { fallos++; console.log(`NO OK ${n} - ${nombre}\n   ${e && e.message}`); } }

const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(RAIZ + 'avisos-web.js', 'utf8'), { module: mod, console });   // sin window: sólo exporta la lógica
const L = mod.exports.logica;
const DIA = 24 * 3600 * 1000, ahora = 1e12;
const ok = { soportado: true, motivo: null, suscripta: false, ios: false };
const base = { estado: ok, memoria: {}, ahora, tiempoMs: 20000, scroll: 0, modalAbierto: false, instalada: false };
const dec = (o) => L.debeOfrecer({ ...base, ...o });

caso('no molesta de entrada: sin tiempo ni scroll no se ofrece', () => assert.equal(dec({ tiempoMs: 2000 }), false));
caso('se ofrece a los 4 s', () => assert.equal(dec({ tiempoMs: 4000 }), true));
caso('se ofrece si ya empezó a scrollear', () => assert.equal(dec({ tiempoMs: 1000, scroll: 0.15 }), true));
caso('no se ofrece con un producto o el canje abierto', () => assert.equal(dec({ modalAbierto: true }), false));
caso('no se ofrece si ya está suscripta', () => assert.equal(dec({ memoria: { ok: true } }), false));
caso('no se insiste si el navegador las bloqueó', () => assert.equal(dec({ estado: { ...ok, motivo: 'bloqueado' } }), false));
caso('sin soporte (y no iPhone) no se ofrece', () => assert.equal(dec({ estado: { soportado: false, motivo: 'no_soportado', ios: false } }), false));
caso('iPhone sin instalar sí se ofrece (con la guía)', () => assert.equal(dec({ estado: { soportado: false, motivo: 'ios_sin_instalar', ios: true } }), true));
caso('estado desconocido no ofrece', () => assert.equal(dec({ estado: null }), false));

caso('cerrar la invitación espera 7 días y no vuelve antes', () => {
  const m = L.descartar({}, ahora);
  assert.equal(m.hasta, ahora + 7 * DIA);
  assert.equal(dec({ memoria: m, ahora: ahora + 6 * DIA }), false);
  assert.equal(dec({ memoria: m, ahora: ahora + 8 * DIA }), true);
});
caso('la segunda vez espera 30 días', () => {
  const m = L.descartar(L.descartar({}, ahora), ahora);
  assert.equal(m.n, 2); assert.equal(m.hasta, ahora + 30 * DIA);
});
caso('descartar no pisa «ya suscripta»', () => assert.equal(L.descartar({ ok: true }, ahora).ok, true));

caso('memoria: lee, guarda y tolera un almacén roto', () => {
  const datos = {}; const alm = { getItem: (k) => datos[k] ?? null, setItem: (k, v) => { datos[k] = v; } };
  L.guardar(alm, { n: 1 }); assert.equal(L.leer(alm).n, 1);
  assert.deepEqual({ ...L.leer({ getItem: () => 'no es json' }) }, {});
  L.guardar({ setItem() { throw new Error('lleno'); } }, { n: 1 });       // no explota
  assert.deepEqual({ ...L.leer({ getItem() { throw new Error('bloqueado'); } }) }, {});
});
caso('todos los motivos tienen un texto claro y ninguno culpa a la persona', () => {
  for (const m of ['bloqueado', 'cancelado', 'no_soportado', 'ocupado', 'otro']) assert.ok(L.textoMotivo(m).length > 20);
});
caso('la página enlaza el manifiesto y los dos scripts (push en modo «al usar»)', () => {
  const h = fs.readFileSync(RAIZ + 'precios.html', 'utf8');
  assert.match(h, /rel="manifest" href="\/tienda\.webmanifest"/);
  assert.match(h, /<script defer src="push\.js[^"]*" data-registro="al-usar">/);
  assert.match(h, /<script defer src="avisos-web\.js/);
  assert.ok(h.indexOf('avisos-web.js') > h.indexOf('precios.js'));
});
caso('el manifiesto es válido y apunta a íconos existentes', () => {
  const m = JSON.parse(fs.readFileSync(RAIZ + 'tienda.webmanifest', 'utf8'));
  assert.equal(m.display, 'standalone');
  for (const i of m.icons) assert.ok(fs.existsSync(RAIZ + i.src.slice(1)), i.src);
});

const UA_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const UA_INSTA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 320.0.0.12.108';
const UA_CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1';
const UA_FB = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]';
caso('detecta los navegadores internos de Instagram y Facebook, no Safari ni Chrome', () => {
  assert.equal(L.embebido(UA_INSTA), true); assert.equal(L.embebido(UA_FB), true);
  assert.equal(L.embebido(UA_SAFARI), false); assert.equal(L.embebido(UA_CHROME_IOS), false); assert.equal(L.embebido(undefined), false);
});
caso('la flecha al botón Compartir sólo se marca en Safari de iPhone', () => {
  assert.equal(L.safariIphone(UA_SAFARI), true);
  for (const ua of [UA_CHROME_IOS, UA_INSTA, UA_FB, 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1', 'Mozilla/5.0 (Linux; Android 14) Chrome/123 Mobile Safari/537.36']) assert.equal(L.safariIphone(ua), false, ua);
});
caso('con la app ya instalada se ofrece activar los avisos al segundo', () => {
  assert.equal(dec({ tiempoMs: 1500, instalada: true }), true);
  assert.equal(dec({ tiempoMs: 1500, instalada: false }), false);
});
console.log(`\n${n - fallos}/${n}`); process.exit(fallos ? 1 : 0);
