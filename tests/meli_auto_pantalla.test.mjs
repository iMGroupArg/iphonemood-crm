// Pruebas de la tarjeta de facturación automática (src/modules/meli-facturas.js): interruptores, pendientes y avisos. Sin red ni navegador.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let n = 0, fallos = 0;
async function caso(nombre, fn) { n++; try { await fn(); console.log(`ok ${n} - ${nombre}`); } catch (e) { fallos++; console.log(`NO OK ${n} - ${nombre}\n   ${e && e.message}`); } }
const fuente = fs.readFileSync(new URL('../src/modules/meli-facturas.js', import.meta.url), 'utf8');
function cargar({ estado, checks = {}, confirma = true, respuesta = { data: { ok: true } } }) {
  const llamadas = [], toasts = [];
  const State = { esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), facturacionAuto: estado, meliOrdenes: [] };
  const ctx = { State, console, toast: m => toasts.push(m), confirm: () => confirma, document: { getElementById: id => (id in checks ? { checked: checks[id] } : null) },
    supa: { rpc: async (fn, args) => { llamadas.push({ fn, args }); return fn === 'arca_auto_estado' ? { data: estado, error: null } : respuesta; } }, MeliOrdenes: { pintar() {} } };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(fuente, ctx);
  return { M: ctx.MeliFacturas, State, llamadas, toasts };
}
const base = { factura_auto: false, nota_auto: false, desde: null, pendientes: [], avisos: [] };

await caso('Apagada por defecto y explica qué hace', () => {
  const { M } = cargar({ estado: base });
  const h = M.tarjetaAuto();
  assert.match(h, /Apagada/); assert.match(h, /desde el momento en que lo encendés/); assert.match(h, /siguen manuales/);
});
await caso('Sin la función en la base (script 23 sin correr) no muestra nada; con error real avisa', () => {
  const { M, State } = cargar({ estado: null });
  assert.equal(M.tarjetaAuto(), '');
  State.facturacionAutoError = true; assert.match(M.tarjetaAuto(), /no disponible/);
});
await caso('Encender pide confirmación y manda solo dos booleanos', async () => {
  const { M, llamadas, toasts } = cargar({ estado: base, checks: { 'fauto-factura': true, 'fauto-nota': false } });
  await M.guardarAuto();
  assert.deepEqual(JSON.parse(JSON.stringify(llamadas[0])), { fn: 'arca_auto_config_guardar', args: { p_factura: true, p_nota: false } });
  assert.match(toasts[0], /actualizada/);
});
await caso('Si no confirma, no se enciende nada', async () => {
  const { M, llamadas } = cargar({ estado: base, checks: { 'fauto-factura': true, 'fauto-nota': true }, confirma: false });
  await M.guardarAuto(); assert.equal(llamadas.length, 0);
});
await caso('Apagar no pide confirmación', async () => {
  const { M, llamadas } = cargar({ estado: { ...base, factura_auto: true }, checks: { 'fauto-factura': false, 'fauto-nota': false }, confirma: false });
  await M.guardarAuto(); assert.equal(llamadas[0].args.p_factura, false);
});
await caso('Pendientes y avisos: texto escapado, avisos claros y botón «Entendido»', () => {
  const { M } = cargar({ estado: { ...base, factura_auto: true, nota_auto: true, desde: '2026-11-03T10:00:00Z',
    pendientes: [{ orden: '1<b>', tipo: 'factura', ambiente: 'produccion', intentos: 3, error: '<img src=x onerror=1>', sin_mas_intentos: false }],
    avisos: [{ orden: '20001', tipo: 'nota', ambiente: 'produccion', aviso: 'nota_emitida_venta_procesada' }, { orden: '2', tipo: 'factura', ambiente: 'homologacion', aviso: 'fallo', error: '<script>x</script>' }] } });
  const h = M.tarjetaAuto();
  assert.ok(!/<img src=x/.test(h) && !/<script>/.test(h) && !/1<b>/.test(h), 'sin HTML ejecutable');
  assert.match(h, /SIGUE PROCESADA/); assert.match(h, /dejó de intentar solo/); assert.match(h, /Entendido/); assert.match(h, /Encendida/);
});
await caso('«Entendido» marca el aviso como visto', async () => {
  const { M, llamadas } = cargar({ estado: base });
  await M.avisoVisto({ dataset: { orden: '20001', tipo: 'nota', amb: 'produccion' } });
  assert.deepEqual(JSON.parse(JSON.stringify(llamadas[0])), { fn: 'arca_auto_aviso_visto', args: { p_orden: '20001', p_tipo: 'nota', p_ambiente: 'produccion' } });
});
console.log(`\n${n - fallos}/${n} ok`); process.exit(fallos ? 1 : 0);
