// «Procesar» no factura salvo que la facturación automática de ventas esté ENCENDIDA, y el botón «Factura» pide confirmar.
// Motivo: Mercado Libre (punto de venta 2) ya factura cada venta; el CRM la duplicaba al procesar aunque el interruptor estuviera apagado.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let n = 0, fallos = 0;
async function caso(nombre, fn) { n++; try { await fn(); console.log(`ok ${n} - ${nombre}`); } catch (e) { fallos++; console.log(`NO OK ${n} - ${nombre}\n   ${e && e.message}`); } }

const src = fs.readFileSync(new URL('../src/modules/meli-ordenes.js', import.meta.url), 'utf8');
function cargar({ auto, facturas = [], confirma = true }) {
  const toasts = [], llamadas = [], confirmaciones = [];
  const orden = { id: 5, orderId: '2000000000005', items: [{ stock_id: 1, cantidad: 1 }] };
  const ctx = {
    State: { esc: (s) => String(s), meliOrdenes: [orden], meliFacturas: facturas, facturacionAuto: auto, meliError: false },
    toast: (t) => toasts.push(t), console, window: { Meli: { _token: async () => 'tok' } },
    confirm: (t) => { confirmaciones.push(t); return confirma; }, supa: {}, App: {},
    DB: { cargarMeliOrdenes: async () => {} },
    document: { getElementById: (id) => id === 'meliord-cot-5' ? { value: '1500' } : id === 'meliord-ok-5' ? { checked: true } : null },
    fetch: async (url, op) => { llamadas.push(JSON.parse(op.body)); return { ok: true, status: 200, json: async () => ({ estado: 'emitida', numero: 1, ptoVenta: 3 }) }; },
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(src.replace(/^const MeliOrdenes/m, 'var MeliOrdenes'), ctx);
  const M = ctx.MeliOrdenes;
  // Procesar con todo lo previo simulado: lo único que importa es qué pasa DESPUÉS de procesar.
  M._firmas = { 5: M._firma(orden) };
  M._revalidarOrden = async () => ({ ok: true });
  M._llamar = async () => ({ ya_procesada: false, venta_id: 77 });
  M.pintar = () => {}; M.cerrarCuadro = () => {};
  return { M, toasts, llamadas, confirmaciones };
}

await caso('Procesar con la automática APAGADA no llama a ARCA', async () => {
  const { M, llamadas } = cargar({ auto: { factura_auto: false, nota_auto: false } });
  await M.procesar(5, null); assert.equal(llamadas.length, 0);
});
await caso('Procesar sin poder leer el interruptor (null) no factura', async () => {
  const { M, llamadas } = cargar({ auto: null });
  await M.procesar(5, null); assert.equal(llamadas.length, 0);
});
await caso('Procesar con solo las notas encendidas (factura_auto falso) no factura', async () => {
  const { M, llamadas } = cargar({ auto: { factura_auto: false, nota_auto: true } });
  await M.procesar(5, null); assert.equal(llamadas.length, 0);
});
await caso('Procesar con la automática de facturas ENCENDIDA sigue facturando (sin preguntar)', async () => {
  const { M, llamadas, confirmaciones } = cargar({ auto: { factura_auto: true } });
  await M.procesar(5, null);
  assert.equal(llamadas.length, 1); assert.equal(llamadas[0].accion, 'arca_emitir'); assert.equal(confirmaciones.length, 0);
});
await caso('Procesar una orden ya procesada no factura aunque la automática esté encendida', async () => {
  const { M, llamadas } = cargar({ auto: { factura_auto: true } });
  M._llamar = async () => ({ ya_procesada: true });
  await M.procesar(5, null); assert.equal(llamadas.length, 0);
});
await caso('Botón «Factura»: pide confirmar con el aviso de Mercado Libre (punto de venta 2)', async () => {
  const { M, confirmaciones } = cargar({ auto: null });
  await M.facturar(5);
  assert.equal(confirmaciones.length, 1);
  assert.match(confirmaciones[0], /ya fue facturada por Mercado Libre \(punto de venta 2\)/);
  assert.match(confirmaciones[0], /¿Emitir otra factura igual\?/);
});
await caso('Botón «Factura»: si se cancela la confirmación NO llama a ARCA', async () => {
  const { M, llamadas } = cargar({ auto: null, confirma: false });
  await M.facturar(5); assert.equal(llamadas.length, 0);
});
await caso('Botón «Factura»: si se acepta, emite', async () => {
  const { M, llamadas } = cargar({ auto: null, confirma: true });
  await M.facturar(5); assert.equal(llamadas.length, 1); assert.deepEqual(llamadas[0], { accion: 'arca_emitir', orden: '2000000000005' });
});
await caso('Botón «Factura»: si el CRM ya emitió una para esa orden, solo verifica y NO pregunta', async () => {
  const { M, llamadas, confirmaciones } = cargar({ auto: null, facturas: [{ orden_id: '2000000000005', estado: 'emitida' }] });
  await M.facturar(5); assert.equal(confirmaciones.length, 0); assert.equal(llamadas.length, 1);
});
await caso('Botón «Factura»: una emitida de OTRA orden no evita la pregunta', async () => {
  const { M, confirmaciones } = cargar({ auto: null, facturas: [{ orden_id: '2000000000999', estado: 'emitida' }] });
  await M.facturar(5); assert.equal(confirmaciones.length, 1);
});
await caso('Botón «Factura»: una fila pendiente (no emitida) no evita la pregunta', async () => {
  const { M, confirmaciones } = cargar({ auto: null, facturas: [{ orden_id: '2000000000005', estado: 'pendiente' }] });
  await M.facturar(5); assert.equal(confirmaciones.length, 1);
});
await caso('El automático (auto=true) nunca pregunta', async () => {
  const { M, confirmaciones, llamadas } = cargar({ auto: { factura_auto: true } });
  await M.facturar(5, null, true); assert.equal(confirmaciones.length, 0); assert.equal(llamadas.length, 1);
});

console.log(`${n - fallos} pasan, ${fallos} fallan de ${n}`);
process.exit(fallos ? 1 : 0);
