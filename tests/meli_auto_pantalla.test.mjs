// Pruebas de la tarjeta de facturación automática (src/modules/meli-facturas.js): interruptores, pendientes y avisos. Sin red ni navegador.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let n = 0, fallos = 0;
async function caso(nombre, fn) { n++; try { await fn(); console.log(`ok ${n} - ${nombre}`); } catch (e) { fallos++; console.log(`NO OK ${n} - ${nombre}\n   ${e && e.message}`); } }
const fuente = fs.readFileSync(new URL('../src/modules/meli-facturas.js', import.meta.url), 'utf8');
function cargar({ estado, checks = {}, confirma = true, respuesta = { data: { ok: true } }, modo = 'homologacion' }) {
  const llamadas = [], toasts = [], confirmaciones = [], els = {};
  const State = { esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), facturacionAuto: estado, meliOrdenes: [] };
  const ctx = { State, console, toast: m => toasts.push(m), confirm: (t) => { confirmaciones.push(t); return confirma; }, Meli: { _token: async () => 'tok' }, fetch: async () => ({ json: async () => ({ modo }) }), document: { getElementById: id => (id in checks ? (els[id] = els[id] || { checked: checks[id] }) : null) },
    supa: { rpc: async (fn, args) => { llamadas.push({ fn, args }); return fn === 'arca_auto_estado' ? { data: estado, error: null } : respuesta; } }, MeliOrdenes: { pintar() {} } };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(fuente, ctx);
  return { M: ctx.MeliFacturas, State, llamadas, toasts, confirmaciones, els };
}
const base = { factura_auto: false, nota_auto: false, desde: null, pendientes: [], avisos: [] };

await caso('Apagada por defecto y explica qué hace', () => {
  const { M } = cargar({ estado: base });
  const h = M.tarjetaAuto();
  assert.match(h, /Apagada/); assert.match(h, /desde que la encendés/); assert.match(h, /siguen manuales/);
});
await caso('Interruptores on/off: general y uno por función, con textos cortos y sin botón Guardar', () => {
  const { M } = cargar({ estado: base });
  let h = M.tarjetaAuto();
  assert.match(h, /role="switch" id="fauto-master"/); assert.match(h, /role="switch" id="fauto-factura"/); assert.match(h, /role="switch" id="fauto-nota"/);
  assert.match(h, /class="mf-pista"/); assert.doesNotMatch(h, /type="checkbox" id=|>Guardar</); assert.match(h, /Facturas de ventas nuevas/); assert.match(h, /Notas de crédito al cancelar/);
  assert.doesNotMatch(h, /fauto-master"[^>]*checked/); assert.match(h, />Apagada</);
  const m = cargar({ estado: { ...base, factura_auto: true } }); h = m.M.tarjetaAuto();
  assert.match(h, />Encendida</); assert.match(h, /fauto-master"[^>]*checked/); assert.match(h, /fauto-factura"[^>]*checked/); assert.doesNotMatch(h, /fauto-nota"[^>]*checked/);
  assert.match(h, /onchange="MeliFacturas\.maestroAuto\(this\)"/); assert.match(h, /id="fauto-factura"[^>]*onchange="MeliFacturas\.guardarAuto\(this\)"/);
});
await caso('Cada interruptor va con su texto a la izquierda y pegado a él (no flotando al otro extremo de la fila)', () => {
  const css = fs.readFileSync(new URL('../src/css/main.css', import.meta.url), 'utf8');
  const fila = /\.mf-sw\.mf-fila \{([^}]*)\}/.exec(css)[1], filas = /\.mf-filas \{([^}]*)\}/.exec(css)[1];
  assert.match(fila, /justify-content: flex-start/); assert.doesNotMatch(fila, /space-between/); assert.match(fila, /display: inline-flex/);
  assert.match(filas, /display: flex/); assert.match(filas, /flex-wrap: wrap/); assert.doesNotMatch(filas, /grid/);
  const { M } = cargar({ estado: base }); const h = M.tarjetaAuto();
  assert.match(h, /<label class="mf-sw mf-fila"><span>Facturas de ventas nuevas<\/span><input type="checkbox" role="switch" id="fauto-factura"/);
  assert.match(h, /<label class="mf-sw mf-fila"><span>Notas de crédito al cancelar<\/span><input type="checkbox" role="switch" id="fauto-nota"/);
});
await caso('Interruptor general: al encender prende los dos y guarda; al apagar apaga los dos y guarda sin pedir confirmación', async () => {
  const on = cargar({ estado: base, checks: { 'fauto-master': true, 'fauto-factura': false, 'fauto-nota': false } });
  const mOn = { checked: true }; await on.M.maestroAuto(mOn);
  assert.equal(on.els['fauto-factura'].checked, true); assert.equal(on.els['fauto-nota'].checked, true); assert.equal(on.confirmaciones.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(on.llamadas[0])), { fn: 'arca_auto_config_guardar', args: { p_factura: true, p_nota: true, p_ambiente: 'homologacion' } });
  const off = cargar({ estado: { ...base, factura_auto: true, nota_auto: true }, checks: { 'fauto-master': false, 'fauto-factura': true, 'fauto-nota': true } });
  const mOff = { checked: false }; await off.M.maestroAuto(mOff);
  assert.equal(off.els['fauto-factura'].checked, false); assert.equal(off.els['fauto-nota'].checked, false); assert.equal(off.confirmaciones.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(off.llamadas[0])), { fn: 'arca_auto_config_guardar', args: { p_factura: false, p_nota: false, p_ambiente: null } });
});
await caso('Si cancelás la confirmación o falla el guardado, la pantalla se repinta con lo que hay guardado (el interruptor vuelve atrás)', async () => {
  const llamadasSeccion = [];
  const a = cargar({ estado: base, checks: { 'fauto-factura': true, 'fauto-nota': false }, confirma: false });
  a.M.pintarSeccion = () => llamadasSeccion.push('repinta');
  await a.M.guardarAuto(a.els['fauto-factura']); assert.equal(a.llamadas.length, 0); assert.deepEqual(llamadasSeccion, ['repinta']);
  llamadasSeccion.length = 0;
  const b = cargar({ estado: base, checks: { 'fauto-factura': true, 'fauto-nota': false }, respuesta: { data: { ok: false } } });
  b.M.pintarSeccion = () => llamadasSeccion.push('repinta'); await b.M.guardarAuto({}); assert.deepEqual(llamadasSeccion, ['repinta']); assert.match(b.toasts[0], /No se pudo guardar/);
});
await caso('Sin la función en la base (script 23 sin correr) no muestra nada; con error real avisa', () => {
  const { M, State } = cargar({ estado: null });
  assert.equal(M.tarjetaAuto(), '');
  State.facturacionAutoError = true; assert.match(M.tarjetaAuto(), /no disponible/);
});
await caso('Encender pide confirmación y manda solo dos booleanos', async () => {
  const { M, llamadas, toasts } = cargar({ estado: base, checks: { 'fauto-factura': true, 'fauto-nota': false } });
  await M.guardarAuto();
  assert.deepEqual(JSON.parse(JSON.stringify(llamadas[0])), { fn: 'arca_auto_config_guardar', args: { p_factura: true, p_nota: false, p_ambiente: 'homologacion' } });
  assert.match(toasts[0], /actualizada/);
});
await caso('Al encender pregunta el ambiente real del servidor y lo dice en la confirmación (producción = comprobantes reales)', async () => {
  const { M, llamadas, confirmaciones } = cargar({ estado: base, checks: { 'fauto-factura': true, 'fauto-nota': true }, modo: 'produccion' });
  await M.guardarAuto();
  assert.match(confirmaciones[0], /PRODUCCIÓN \(comprobantes reales/); assert.match(confirmaciones[0], /atada a este ambiente/);
  assert.equal(llamadas[0].args.p_ambiente, 'produccion');
});
await caso('En simulación o sin respuesta del servidor NO se puede encender', async () => {
  const { M, llamadas, toasts } = cargar({ estado: base, checks: { 'fauto-factura': true, 'fauto-nota': false }, modo: null });
  await M.guardarAuto(); assert.equal(llamadas.length, 0); assert.match(toasts[0], /simulación o no responde/);
});
await caso('Muestra para qué ambiente está encendida y avisa que hay que volver a encenderla si cambia', () => {
  const { M } = cargar({ estado: { ...base, factura_auto: true, ambiente: 'homologacion', desde: '2026-11-03T10:00:00Z' } });
  const h = M.tarjetaAuto(); assert.match(h, /Encendida para: <b>PRUEBAS/); assert.match(h, /volver a encenderla/);
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
