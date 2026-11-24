// Pantalla de órdenes: el número de venta (pack) de Mercado Libre es el principal, debajo (en chico) el de orden y el envío, y el buscador
// encuentra por cualquiera de los tres. Las órdenes se siguen identificando por meli_order_id.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let n = 0, fallos = 0;
async function caso(nombre, fn) { n++; try { await fn(); console.log(`ok ${n} - ${nombre}`); } catch (e) { fallos++; console.log(`NO OK ${n} - ${nombre}\n   ${e && e.message}`); } }
const src = fs.readFileSync(new URL('../src/modules/meli-ordenes.js', import.meta.url), 'utf8');

const ORDENES = [
  { id: 1, orderId: '2000019701976556', packId: '2000016191459325', envioId: '48595749791', comprador: 'GASA5341973', procesada: false, items: [], bruto: 51163, neto: 36825.09, financieraCompleta: true },
  { id: 2, orderId: '2000000000002', packId: null, envioId: '123456789', comprador: 'UNO', procesada: false, items: [] },
  { id: 3, orderId: '2000000000003', packId: null, envioId: null, comprador: 'DOS', procesada: true, acreditado: true, items: [] },
  { id: 4, orderId: '2000000000004', packId: '2000016191459325', envioId: '48595749792', comprador: 'MISMO PACK', procesada: false, items: [] },
];
function cargar(ordenes = ORDENES) {
  const raiz = { innerHTML: '' }; const buscador = { value: '', focus() { this.enfocado = true; }, setSelectionRange(a, b) { this.cursor = [a, b]; } };
  const ctx = {
    State: { esc: (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), meliOrdenes: ordenes, meliError: false,
      fmtARS: (x) => '$' + x, meliPendienteLiberar: () => ({ ars: 0, ordenes: 0, sinDato: 0 }), stock: [] },
    window: {}, toast() {}, console, supa: {}, DB: {}, App: {},
    document: { getElementById: (id) => id === 'meliord-buscar' ? buscador : id === 'meli-ordenes-root' ? raiz : null },
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(src.replace(/^const MeliOrdenes/m, 'var MeliOrdenes'), ctx);
  const M = ctx.MeliOrdenes; M._filtro = 'todas';
  const ver = () => M._vista();
  return { M, ver, buscador, raiz };
}
const titulos = (html) => [...html.matchAll(/font-weight:600">Orden ([0-9]+) ·/g)].map(m => m[1]);

await caso('Con pack: el número principal es el pack y debajo, en chico, el de orden y el envío', () => {
  const { ver } = cargar(); const h = ver();
  assert.match(h, /font-weight:600">Orden 2000016191459325 · GASA5341973/);
  assert.match(h, /font-size:11px[^>]*>Orden 2000019701976556 · Envío 48595749791</);
});
await caso('Sin pack pero con envío: principal = orden; debajo solo el envío', () => {
  const { ver } = cargar(); const h = ver();
  assert.match(h, /font-weight:600">Orden 2000000000002 · UNO/);
  assert.match(h, /font-size:11px[^>]*>Envío 123456789</);
});
await caso('Sin pack ni envío (script sin correr o orden vieja): se ve igual que antes, sin línea chica', () => {
  const { ver } = cargar(); const h = ver();
  assert.match(h, /font-weight:600">Orden 2000000000003 · DOS/);
  const bloque = h.slice(h.indexOf('Orden 2000000000003'), h.indexOf('Orden 2000000000003') + 400);
  assert.ok(!/font-size:11px[^>]*>(Orden|Envío)/.test(bloque.split('mo-nums')[0].split('11.5px')[0]), bloque);
});
await caso('Sin el script 35 (ninguna orden trae los campos): la pantalla funciona como siempre', () => {
  const { ver } = cargar(ORDENES.map(({ packId, envioId, ...o }) => o)); const h = ver();
  assert.deepEqual(titulos(h), ['2000019701976556', '2000000000002', '2000000000003', '2000000000004']);
  assert.ok(!/Envío /.test(h));
});
await caso('Buscador: por número de VENTA (pack) encuentra todas las órdenes de ese pack', () => {
  const { M, ver } = cargar(); M._buscar = '2000016191459325'; const h = ver();
  assert.deepEqual(titulos(h), ['2000016191459325', '2000016191459325']); assert.match(h, /2 resultados/);
});
await caso('Buscador: pegando «#2000016191459325» (con #) también encuentra', () => {
  const { M, ver } = cargar(); M._buscar = '#2000016191459325'; assert.equal(titulos(ver()).length, 2);
});
await caso('Buscador: por número de ORDEN encuentra esa orden', () => {
  const { M, ver } = cargar(); M._buscar = '2000019701976556'; const h = ver(); assert.deepEqual(titulos(h), ['2000016191459325']); assert.match(h, /1 resultado</);
});
await caso('Buscador: por número de ENVÍO encuentra esa orden', () => {
  const { M, ver } = cargar(); M._buscar = '48595749791'; assert.match(ver(), /Orden 2000016191459325/); assert.equal(titulos(ver()).length, 1);
});
await caso('Buscador: encuentra una orden aunque el filtro de estado sea otro (busca en todas)', () => {
  const { M, ver } = cargar(); M._filtro = 'pendientes'; M._buscar = '2000000000003'; assert.deepEqual(titulos(ver()), ['2000000000003']);
});
await caso('Buscador: con menos de 4 dígitos o sin dígitos no filtra (no es un resultado vacío por error)', () => {
  const { M, ver } = cargar(); for (const t of ['', '12', 'abc', '   ']) { M._buscar = t; assert.equal(titulos(ver()).length, 4, `«${t}»`); }
});
await caso('Buscador: un número que no existe muestra «0 resultados» y no rompe', () => {
  const { M, ver } = cargar(); M._buscar = '9999999999'; const h = ver(); assert.deepEqual(titulos(h), []); assert.match(h, /0 resultados/); assert.match(h, /No hay órdenes en esta vista/);
});
await caso('Buscador: el texto del buscador se escapa (no inyecta HTML)', () => {
  const { M, ver } = cargar(); M._buscar = '"><img src=x onerror=alert(1)>'; const h = ver(); assert.ok(!/<img src=x/.test(h));
});
await caso('buscar(): guarda el texto, vuelve a pintar y devuelve el cursor al buscador', () => {
  const { M, buscador } = cargar(); let pinto = 0; M.pintar = () => { pinto++; buscador.value = M._buscar; };
  M.buscar('20000161'); assert.equal(M._buscar, '20000161'); assert.equal(pinto, 1); assert.equal(buscador.enfocado, true); assert.deepEqual(buscador.cursor, [8, 8]);
});
await caso('Las acciones siguen usando el id interno de la orden (no el número que se ve)', () => {
  const { ver } = cargar(); const h = ver(); assert.match(h, /MeliOrdenes\.abrirProcesar\(1\)/); assert.match(h, /MeliOrdenes\.abrirDetalle\(4\)/);
});
await caso('Carga: pide ml_pack_id/ml_shipment_id solo si la columna existe y no corta la carga si falta', () => {
  const c = fs.readFileSync(new URL('../src/modules/supabase-config.js', import.meta.url), 'utf8');
  assert.match(c, /select\('ml_pack_id'\)\.limit\(1\)/); assert.match(c, /sondaNum\.error \? '' : ',ml_pack_id,ml_shipment_id'/);
  assert.match(c, /packId: o\.ml_pack_id \|\| null, envioId: o\.ml_shipment_id \|\| null/);
  assert.ok(!/sondaNum\.error[^;]*State\.meliError = true/.test(c));
});
console.log(`${n - fallos} pasan, ${fallos} fallan de ${n}`);
process.exit(fallos ? 1 : 0);
