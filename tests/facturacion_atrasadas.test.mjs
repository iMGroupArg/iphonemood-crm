// Pruebas de la emisión de facturas ATRASADAS (api/_facturacion_atrasadas.js). Sin red ni base: la base y la emisión son simuladas.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { correrAtrasadas, validarPedido } = require('../api/_facturacion_atrasadas.js');
const { ErrorArca } = require('../api/_arca.js');

let n = 0, fallos = 0;
async function caso(nombre, fn) { n++; try { await fn(); console.log(`ok ${n} - ${nombre}`); } catch (e) { fallos++; console.log(`NO OK ${n} - ${nombre}\n   ${e.stack?.split('\n').slice(0, 3).join(' | ')}`); } }

const AHORA = new Date('2026-11-04T10:00:00-03:00');
const PEDIDO = { desde: '2026-10-01', hasta: '2026-10-31', fecha: '2026-10-31', pto_venta: 4 };
const ENV = { ARCA_MODO: 'produccion', ARCA_CONFIRMA_PRODUCCION: 'SI', ARCA_CUIT: '20301234567', ARCA_PTO_VTA: '3', ARCA_CERT: 'c', ARCA_KEY: 'k' };
const codigo = (e, c) => e instanceof ErrorArca && e.codigo === c;

// rpc simulado: devuelve la lista pedida y registra los argumentos.
const armar = ({ ordenes = ['1', '2', '3'], restantes = ordenes.length, bloqueadas = 0, resultados = {} } = {}) => {
  const rpcs = [], emisiones = [];
  const rpc = async (nombre, args) => { rpcs.push({ nombre, args }); return { ordenes, restantes, bloqueadas }; };
  const emitir = async (o) => {
    emisiones.push(o);
    const r = resultados[o.orden];
    if (r instanceof Error) throw r;
    return r || { estado: 'emitida', numero: 100 + emisiones.length, ptoVenta: 4 };
  };
  return { rpc, emitir, rpcs, emisiones };
};
const correr = (extra = {}, p = PEDIDO) => correrAtrasadas({ pedido: p, env: ENV, ahora: () => AHORA, limite: Date.now() + 60000, meliGet: () => {}, ...extra });

await caso('validarPedido: acepta un pedido correcto y devuelve los datos limpios', () => {
  assert.deepEqual({ ...validarPedido(PEDIDO, AHORA) }, { desde: '2026-10-01', hasta: '2026-10-31', fecha: '2026-10-31', pto: 4 });
});
await caso('validarPedido: rechaza rangos y fechas inválidos, futuras o de otro año', () => {
  const malos = [
    [{ ...PEDIDO, desde: '2026-10-31', hasta: '2026-10-01' }, 'RANGO_INVALIDO'], [{ ...PEDIDO, desde: '2026-13-01' }, 'RANGO_INVALIDO'], [{ ...PEDIDO, hasta: '2026-02-30' }, 'RANGO_INVALIDO'],
    [{ ...PEDIDO, desde: undefined }, 'RANGO_INVALIDO'], [{ ...PEDIDO, fecha: 'ayer' }, 'FECHA_INVALIDA'], [{ ...PEDIDO, fecha: '2026-11-05' }, 'FECHA_FUTURA'],
    [{ ...PEDIDO, fecha: '2025-12-31' }, 'FECHA_OTRO_ANIO'], [{ ...PEDIDO, pto_venta: 0 }, 'PUNTO_DE_VENTA_INVALIDO'], [{ ...PEDIDO, pto_venta: 100000 }, 'PUNTO_DE_VENTA_INVALIDO'],
    [{ ...PEDIDO, pto_venta: '4.5' }, 'PUNTO_DE_VENTA_INVALIDO'], [{ ...PEDIDO, pto_venta: 'x' }, 'PUNTO_DE_VENTA_INVALIDO'],
  ];
  for (const [p, c] of malos) assert.throws(() => validarPedido(p, AHORA), (e) => codigo(e, c), JSON.stringify(p));
  assert.doesNotThrow(() => validarPedido({ ...PEDIDO, fecha: '2026-11-04' }, AHORA));          // hoy sí
});
await caso('La fecha «hoy» se mide en Argentina: a las 22:00 del 4/11 (01:00 UTC del 5/11) todavía es el 4/11', () => {
  const tarde = new Date('2026-11-05T01:00:00Z');
  assert.doesNotThrow(() => validarPedido({ ...PEDIDO, fecha: '2026-11-04' }, tarde));
  assert.throws(() => validarPedido({ ...PEDIDO, fecha: '2026-11-05' }, tarde), (e) => codigo(e, 'FECHA_FUTURA'));
});

await caso('En modo simulación no pide ni emite nada', async () => {
  const t = armar();
  const r = await correr({ rpc: t.rpc, emitir: t.emitir, env: { ...ENV, ARCA_MODO: 'simulacion' } });
  assert.equal(r.estado, 'simulacion'); assert.equal(t.rpcs.length, 0); assert.equal(t.emisiones.length, 0);
});
await caso('Pide a la base las ventas del rango en el ambiente del servidor y emite cada una con el punto de venta y la fecha elegidos', async () => {
  const t = armar({ ordenes: ['11', '12', '13'], restantes: 10 });
  const r = await correr({ rpc: t.rpc, emitir: t.emitir });
  assert.equal(t.rpcs[0].nombre, 'arca_atrasadas_siguientes');
  assert.deepEqual({ ...t.rpcs[0].args }, { p_ambiente: 'produccion', p_desde: '2026-10-01', p_hasta: '2026-10-31', p_limite: 4 });
  assert.deepEqual(t.emisiones.map((o) => o.orden), ['11', '12', '13']);
  for (const o of t.emisiones) {
    assert.equal(o.env.ARCA_PTO_VTA, '4'); assert.equal(o.env.ARCA_MODO, 'produccion');
    assert.equal(o.fechaComprobante.toISOString(), '2026-10-31T15:00:00.000Z');
    assert.equal(o.ahora(), AHORA);                       // el login sigue usando la hora real, no la fecha del comprobante
    assert.equal(o.reservarFn, 'arca_atrasada_reservar');  // la base REVALIDA la elegibilidad al reservar el número
    assert.deepEqual({ ...o.reservarExtra }, { p_desde: '2026-10-01', p_hasta: '2026-10-31' });
  }
  assert.equal(r.estado, 'ok'); assert.equal(r.emitidas, 3); assert.equal(r.quedan, 7); assert.equal(r.ptoVenta, 4); assert.equal(r.fecha, '2026-10-31'); assert.equal(r.detenido, null);
});
await caso('No toca la configuración del servidor: el punto de venta del env original queda en 3', async () => {
  const t = armar({ ordenes: ['1'] }); const env = { ...ENV };
  await correr({ rpc: t.rpc, emitir: t.emitir, env });
  assert.equal(env.ARCA_PTO_VTA, '3'); assert.equal(t.emisiones[0].env.ARCA_PTO_VTA, '4');
});
await caso('Las que ya estaban omitidas (ya no elegibles) se cuentan aparte y se sigue', async () => {
  const t = armar({ ordenes: ['1', '2', '3'], restantes: 3, resultados: { 2: { estado: 'omitida' } } });
  const r = await correr({ rpc: t.rpc, emitir: t.emitir });
  assert.equal(r.emitidas, 2); assert.equal(r.omitidas, 1); assert.equal(r.quedan, 0); assert.equal(r.estado, 'ok');
});
await caso('Ante el PRIMER rechazo de ARCA se detiene: no sigue con las demás y informa cuál fue', async () => {
  const t = armar({ ordenes: ['1', '2', '3'], resultados: { 2: { estado: 'rechazada', error: '10016: fecha fuera de rango' } } });
  const r = await correr({ rpc: t.rpc, emitir: t.emitir });
  assert.equal(r.estado, 'detenido'); assert.equal(r.emitidas, 1); assert.deepEqual(t.emisiones.map((o) => o.orden), ['1', '2']);
  assert.deepEqual({ ...r.detenido }, { orden: '2', estado: 'rechazada', mensaje: '10016: fecha fuera de rango' });
});
await caso('Una factura que quedó sin confirmar (pendiente_verificar) también detiene la corrida', async () => {
  const t = armar({ ordenes: ['1', '2'], resultados: { 1: { estado: 'pendiente_verificar', error: 'SIN_TIEMPO: …' } } });
  const r = await correr({ rpc: t.rpc, emitir: t.emitir });
  assert.equal(r.estado, 'detenido'); assert.equal(t.emisiones.length, 1); assert.equal(r.detenido.estado, 'pendiente_verificar');
});
await caso('«en_curso» (otro proceso emitiendo) detiene la corrida sin error', async () => {
  const t = armar({ ordenes: ['1', '2'], resultados: { 1: { estado: 'en_curso', mensaje: 'Otro proceso está resolviendo esta factura.' } } });
  const r = await correr({ rpc: t.rpc, emitir: t.emitir });
  assert.equal(r.estado, 'detenido'); assert.equal(t.emisiones.length, 1); assert.match(r.detenido.mensaje, /Otro proceso/);
});
await caso('Un error inesperado al emitir detiene la corrida y no filtra datos: solo código y mensaje corto', async () => {
  const t = armar({ ordenes: ['1', '2'], resultados: { 1: new ErrorArca('FALTA_DOCUMENTO', 'Falta el documento del comprador.') } });
  const r = await correr({ rpc: t.rpc, emitir: t.emitir });
  assert.equal(r.estado, 'detenido'); assert.equal(r.detenido.estado, 'error'); assert.equal(r.detenido.mensaje, 'FALTA_DOCUMENTO: Falta el documento del comprador.');
  const t2 = armar({ ordenes: ['1'], resultados: { 1: new Error('secreto-que-no-debe-salir') } });
  const r2 = await correr({ rpc: t2.rpc, emitir: t2.emitir });
  assert.equal(r2.detenido.mensaje, 'error inesperado'); assert.doesNotMatch(JSON.stringify(r2), /secreto-que-no-debe-salir/);
});
await caso('«sin_tiempo» termina la corrida sin marcar error', async () => {
  const t = armar({ ordenes: ['1', '2'], resultados: { 1: { estado: 'sin_tiempo' } } });
  const r = await correr({ rpc: t.rpc, emitir: t.emitir });
  assert.equal(r.estado, 'ok'); assert.equal(r.emitidas, 0); assert.equal(t.emisiones.length, 1);
});
await caso('Si ya no queda tiempo (menos de 14 s) no empieza ninguna emisión', async () => {
  const t = armar({ ordenes: ['1', '2'] });
  const r = await correr({ rpc: t.rpc, emitir: t.emitir, limite: Date.now() + 5000 });
  assert.equal(t.emisiones.length, 0); assert.equal(r.estado, 'ok'); assert.equal(r.emitidas, 0);
});
await caso('Sin ventas por facturar devuelve ok con cero y quedan 0', async () => {
  const t = armar({ ordenes: [], restantes: 0 });
  const r = await correr({ rpc: t.rpc, emitir: t.emitir });
  assert.equal(r.estado, 'ok'); assert.equal(r.emitidas, 0); assert.equal(r.quedan, 0); assert.equal(t.emisiones.length, 0);
});
await caso('Una respuesta de la base que no se entiende se corta con un error claro', async () => {
  await assert.rejects(() => correr({ rpc: async () => ({ algo: 1 }), emitir: async () => ({}) }), (e) => codigo(e, 'RESPUESTA_INVALIDA'));
  await assert.rejects(() => correr({ rpc: async () => null, emitir: async () => ({}) }), (e) => codigo(e, 'RESPUESTA_INVALIDA'));
});
await caso('Un pedido inválido se corta ANTES de llamar a la base', async () => {
  const t = armar();
  await assert.rejects(() => correr({ rpc: t.rpc, emitir: t.emitir }, { ...PEDIDO, fecha: '2027-01-01' }), (e) => codigo(e, 'FECHA_FUTURA'));
  assert.equal(t.rpcs.length, 0);
});
await caso('Si hay ventas BLOQUEADAS (reservadas por otro proceso o rechazadas hace poco) no emite nada y se detiene explicándolo', async () => {
  const t = armar({ ordenes: ['4', '5'], restantes: 2, bloqueadas: 1 });
  const r = await correr({ rpc: t.rpc, emitir: t.emitir });
  assert.equal(r.estado, 'detenido'); assert.equal(t.emisiones.length, 0); assert.equal(r.emitidas, 0); assert.equal(r.quedan, 3);
  assert.equal(r.detenido.estado, 'bloqueadas'); assert.match(r.detenido.mensaje, /1 venta\(s\).*30 minutos/);
});
await caso('Con cero pendientes pero bloqueadas, NO informa «terminó»: queda detenido con la cuenta de las que faltan', async () => {
  const t = armar({ ordenes: [], restantes: 0, bloqueadas: 2 });
  const r = await correr({ rpc: t.rpc, emitir: t.emitir });
  assert.equal(r.estado, 'detenido'); assert.equal(r.quedan, 2);
});
await caso('Una venta que dejó de ser elegible al reservar se cuenta como omitida (la base la rechazó con ATRASADA_NO_ELEGIBLE)', async () => {
  const t = armar({ ordenes: ['1'], resultados: { 1: { estado: 'omitida', mensaje: 'La venta ya no es elegible para facturar.' } } });
  const r = await correr({ rpc: t.rpc, emitir: t.emitir });
  assert.equal(r.omitidas, 1); assert.equal(r.emitidas, 0); assert.equal(r.estado, 'ok');
});
await caso('Una venta que dejó de estar pagada (ORDEN_NO_FACTURABLE) se omite y se sigue con las demás', async () => {
  const t = armar({ ordenes: ['1', '2'], restantes: 2, resultados: { 1: new Error('RPC: ORDEN_NO_FACTURABLE') } });
  const r = await correr({ rpc: t.rpc, emitir: t.emitir });
  assert.equal(r.estado, 'ok'); assert.equal(r.omitidas, 1); assert.equal(r.emitidas, 1); assert.equal(r.quedan, 0);
});
await caso('Con el ambiente de pruebas pide y emite en homologación', async () => {
  const t = armar({ ordenes: ['5'] });
  await correr({ rpc: t.rpc, emitir: t.emitir, env: { ...ENV, ARCA_MODO: 'homologacion' } });
  assert.equal(t.rpcs[0].args.p_ambiente, 'homologacion'); assert.equal(t.emisiones[0].env.ARCA_MODO, 'homologacion');
});
await caso('El máximo por corrida se pasa a la base (4 por defecto, configurable)', async () => {
  const t = armar({ ordenes: ['1'] });
  await correr({ rpc: t.rpc, emitir: t.emitir, maxPorCorrida: 2 });
  assert.equal(t.rpcs[0].args.p_limite, 2);
});

console.log(`\n${n - fallos}/${n} ok`); process.exit(fallos ? 1 : 0);
