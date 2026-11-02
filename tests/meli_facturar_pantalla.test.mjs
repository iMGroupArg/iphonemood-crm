// Pruebas del botón/automatismo de factura en la pantalla de órdenes (src/modules/meli-ordenes.js). Sin red ni navegador:
// se carga el módulo con un DOM y un fetch simulados.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let n = 0, fallos = 0;
async function caso(nombre, fn) { n++; try { await fn(); console.log(`ok ${n} - ${nombre}`); } catch (e) { fallos++; console.log(`NO OK ${n} - ${nombre}\n   ${e && e.message}`); } }

const src = fs.readFileSync(new URL('../src/modules/meli-ordenes.js', import.meta.url), 'utf8');
function cargar({ respuesta, ordenes = [{ id: 5, orderId: '2000000000005' }] }) {
  const toasts = [], llamadas = [];
  const ctx = {
    State: { esc: (s) => String(s), meliOrdenes: ordenes }, toast: (t) => toasts.push(t), console,
    window: { Meli: { _token: async () => 'tok' } }, document: { getElementById: () => null }, supa: {}, DB: {}, App: {},
    fetch: async (url, op) => { llamadas.push({ url, body: JSON.parse(op.body), headers: op.headers }); const r = respuesta; if (r instanceof Error) throw r; return { ok: r.ok !== false, status: r.status || 200, json: async () => r.json }; },
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(src.replace(/^const MeliOrdenes/m, 'var MeliOrdenes'), ctx);
  return { M: ctx.MeliOrdenes, toasts, llamadas };
}

await caso('Solo viaja el número de la orden al servidor (nada de importes ni documento)', async () => {
  const { M, llamadas } = cargar({ respuesta: { json: { estado: 'emitida', numero: 7, ptoVenta: 1 } } });
  await M.facturar(5);
  assert.deepEqual(llamadas[0].body, { accion: 'arca_emitir', orden: '2000000000005' });
  assert.equal(llamadas[0].headers['x-crm-token'], 'tok');
});
await caso('Emitida: avisa punto de venta y número', async () => {
  const { M, toasts } = cargar({ respuesta: { json: { estado: 'emitida', numero: 7, ptoVenta: 3 } } });
  await M.facturar(5); assert.match(toasts[0], /emitida: punto de venta 3, N\.º 7/);
});
await caso('Ya emitida: lo dice y no suena a nueva', async () => {
  const { M, toasts } = cargar({ respuesta: { json: { estado: 'emitida', numero: 7, ptoVenta: 3, yaEstaba: true } } });
  await M.facturar(5); assert.match(toasts[0], /ya emitida/);
});
await caso('Simulación en automático no molesta; manual lo aclara', async () => {
  const a = cargar({ respuesta: { json: { estado: 'simulacion' } } }); await a.M.facturar(5, null, true); assert.equal(a.toasts.length, 0);
  const b = cargar({ respuesta: { json: { estado: 'simulacion' } } }); await b.M.facturar(5); assert.match(b.toasts[0], /simulación/);
});
await caso('Pendiente de verificar: explica que la venta está bien y que no se duplica', async () => {
  const { M, toasts } = cargar({ respuesta: { json: { estado: 'pendiente_verificar' } } });
  await M.facturar(5); assert.match(toasts[0], /La venta está bien/); assert.match(toasts[0], /no se duplica/);
});
await caso('Rechazada: muestra el motivo', async () => {
  const { M, toasts } = cargar({ respuesta: { json: { estado: 'rechazada', error: '10015: Documento inválido' } } });
  await M.facturar(5); assert.match(toasts[0], /10015: Documento inválido/);
});
await caso('Errores conocidos salen en castellano; el resto, mensaje genérico', async () => {
  const a = cargar({ respuesta: { json: { estado: 'error', codigo: 'FALTA_DOCUMENTO' } } }); await a.M.facturar(5); assert.match(a.toasts[0], /documento del comprador/);
  const b = cargar({ respuesta: { json: { estado: 'error', codigo: 'XXXX' } } }); await b.M.facturar(5); assert.match(b.toasts[0], /La venta quedó bien/);
});
await caso('Sin conexión o HTTP malo: la venta queda bien y se puede reintentar', async () => {
  const a = cargar({ respuesta: new Error('red') }); await a.M.facturar(5); assert.match(a.toasts[0], /La venta quedó bien/);
  const b = cargar({ respuesta: { ok: false, status: 502, json: null } }); await b.M.facturar(5); assert.match(b.toasts[0], /HTTP 502/);
});
await caso('Orden desconocida: no llama al servidor', async () => {
  const { M, llamadas } = cargar({ respuesta: { json: {} }, ordenes: [] }); await M.facturar(5); assert.equal(llamadas.length, 0);
});
console.log(`\n${n - fallos}/${n} ok`); process.exit(fallos ? 1 : 0);
