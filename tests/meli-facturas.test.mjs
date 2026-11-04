import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const leer = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const fuente = leer('src/modules/meli-facturas.js');
const mensajes = [], llamadas = [];
let respuesta = { data: { ok: true, orden_id: '123', estado: 'emitida', version: 1 } }, lectura = [], falloLectura = null;
const State = { meliOrdenes: [{ id: 7, orderId: '123' }], meliFacturas: [], esc: s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) };
const ctx = { State, console, toast: m => mensajes.push(m), alert: m => mensajes.push(m), DB: { marcarFactura: async args => { llamadas.push(args); return respuesta; } },
  supa: { from: tabla => { assert.equal(tabla, 'meli_facturas'); return { select: cols => { assert.equal(cols, 'orden_id,estado,tipo,pto_venta,numero,emitida_el,motivo,version,marcada_por,marcada_en'); return { in: (col, ids) => { assert.equal(col, 'orden_id'); assert.deepEqual(Array.from(ids), ['123']); return { limit: async () => ({ data: lectura, error: falloLectura }) }; } }; } }; } },
  MeliOrdenes: { pintar() {}, filtrar(k) { this.filtro = k; } }, confirm: () => true };
ctx.window = ctx; vm.createContext(ctx); vm.runInContext(fuente, ctx);
const M = ctx.MeliFacturas, o = State.meliOrdenes[0];
const datos = { tipo: 'C', pto_venta: 3, numero: 1234, emitida_el: '2020-01-01' };
const limpiar = () => { State.meliFacturas = []; State.meliFacturasError = false; State.meliFacturasAusente = false; };
let n = 0;
async function caso(nombre, fn) { limpiar(); await fn(); console.log(`ok ${++n} - ${nombre}`); }
await caso('Orden sin fila: pendiente', () => assert.equal(M.de(o).estado, 'pendiente'));
await caso('Emitida válida, enteros separados, versión null y formato', async () => {
  lectura = [{ orden_id: '123', estado: 'emitida', ...datos, version: 1 }];
  assert.equal(await M.marcar('123', 'emitida', datos), true);
  assert.deepEqual(JSON.parse(JSON.stringify(llamadas.at(-1))), { p_orden: '123', p_estado: 'emitida', p_tipo: 'C', p_pto_venta: 3, p_numero: 1234, p_emitida_el: '2020-01-01', p_motivo: null, p_version_esperada: null });
  assert.match(M.tarjeta(o), /Factura C 0003-00001234/);
  assert.equal(M.numero({ tipo: 'A', pto_venta: 99999, numero: 99999999 }), 'A 99999-99999999');
});
await caso('Tipos cerrados y límites enteros', async () => {
  for (const tipo of ['A', 'B', 'C', 'E', 'M']) assert.equal(M.validar('emitida', { ...datos, tipo }), null);
  for (const tipo of ['', 'D', 'c']) assert.ok(M.validar('emitida', { ...datos, tipo }));
  for (const [campo, max] of [['pto_venta', 99999], ['numero', 99999999]]) {
    for (const valor of [0, -1, 1.5, max + 1, '3', null, NaN, Infinity]) {
      const antes = llamadas.length;
      assert.equal(await M.marcar('123', 'emitida', { ...datos, [campo]: valor }), false);
      assert.equal(llamadas.length, antes);
    }
    for (const valor of [1, max]) assert.equal(M.validar('emitida', { ...datos, [campo]: valor }), null);
  }
});
await caso('Fecha futura e inexistente rechazadas; hoy Argentina', () => {
  assert.match(M.validar('emitida', { ...datos, emitida_el: '2999-01-01' }), /futura/);
  for (const fecha of ['2025-02-30', '2020-13-01', '', '2020-1-01']) assert.match(M.validar('emitida', { ...datos, emitida_el: fecha }), /válida/);
  const RealDate = Date;
  ctx.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-10-16T01:30:00Z'])); } };
  assert.equal(M.hoy(), '2026-10-15'); ctx.Date = RealDate;
});
await caso('Motivos cerrados, traducidos y desplegable sin texto libre', async () => {
  for (const motivo of ['', ' ', 'texto libre', '<img>', 'toString']) assert.ok(M.validar('no_corresponde', { motivo }));
  for (const [motivo, texto] of Object.entries(M.MOTIVOS)) {
    assert.equal(M.validar('no_corresponde', { motivo }), null);
    lectura = [{ orden_id: '123', estado: 'no_corresponde', motivo, version: 1 }];
    State.meliFacturas = [];
    assert.equal(await M.marcar('123', 'no_corresponde', { motivo }), true);
    assert.equal(llamadas.at(-1).p_motivo, motivo);
    assert.match(M.tarjeta(o), new RegExp(texto));
  }
  let dialog;
  ctx.document = { createElement: () => (dialog = { innerHTML: '', querySelector: () => ({}), showModal() {}, remove() {}, close() {} }), body: { append() {} } };
  await M.accion({ dataset: { orden: '123', estado: 'no_corresponde' } });
  assert.match(dialog.innerHTML, /<select name="motivo"/); assert.doesNotMatch(dialog.innerHTML, /<input|<textarea/);
  for (const motivo of Object.keys(M.MOTIVOS)) assert.match(dialog.innerHTML, new RegExp(`value="${motivo}"`));
});
await caso('«Marcar emitida» viene completo: Factura C, punto de venta 3 y el número siguiente al último registrado en ese punto', async () => {
  State.meliFacturas = [];
  assert.deepEqual({ ...M.sugerida() }, { tipo: 'C', pto_venta: 3, numero: '' });
  State.meliFacturas = [
    { orden_id: 'a', estado: 'emitida', tipo: 'C', pto_venta: 3, numero: 5 }, { orden_id: 'b', estado: 'emitida', tipo: 'C', pto_venta: 3, numero: 10 },
    { orden_id: 'c', estado: 'emitida', tipo: 'C', pto_venta: 1, numero: 900 }, { orden_id: 'd', estado: 'pendiente' }, { orden_id: 'e', estado: 'no_corresponde', motivo: 'x' },
  ];
  assert.deepEqual({ ...M.sugerida() }, { tipo: 'C', pto_venta: 3, numero: 11 });
  let dialog;
  ctx.document = { createElement: () => (dialog = { innerHTML: '', querySelector: () => ({}), showModal() {}, remove() {}, close() {} }), body: { append() {} } };
  await M.accion({ dataset: { orden: '123', estado: 'emitida' } });
  assert.match(dialog.innerHTML, /<option value="C" selected>Factura C<\/option>/); assert.match(dialog.innerHTML, /name="pto_venta"[^>]*value="3"/); assert.match(dialog.innerHTML, /name="numero"[^>]*value="11"/);
  assert.equal((dialog.innerHTML.match(/ selected>/g) || []).length, 1);
  State.meliFacturas = [{ orden_id: 'z', estado: 'emitida', tipo: 'C', pto_venta: 3, numero: 99999999 }];
  assert.equal(M.sugerida().numero, '');
});
await caso('Con la hoja del CRM (Sheet): usa su título, el formulario y el pie, envía el formulario y cierra al registrar', async () => {
  State.meliFacturas = [{ orden_id: '123', estado: 'pendiente', version: 4 }];
  const submit = {}, cancelar = {}, form = {}; let cerrada = false, abierta = null;
  const el = { querySelector: sel => sel === 'form' ? form : sel === '[data-cancelar]' ? cancelar : submit };
  ctx.Sheet = { abrir: o => { abierta = o; return { el, cerrar: () => { cerrada = true; } }; } };
  ctx.document = { createElement: () => { throw new Error('no debería crear un dialog'); } };
  ctx.FormData = class { *[Symbol.iterator]() { yield* Object.entries({ tipo: 'C', pto_venta: '3', numero: '12', emitida_el: '2020-01-01' }); } };
  respuesta = { data: { ok: true, orden_id: '123', estado: 'emitida', version: 5 } };
  lectura = [{ orden_id: '123', estado: 'emitida', ...datos, version: 5 }];
  try {
    await M.accion({ dataset: { orden: '123', estado: 'emitida' } });
    assert.equal(abierta.titulo, 'Marcar factura como emitida');
    assert.match(abierta.cuerpo, /<form id="dlg-factura">/); assert.match(abierta.cuerpo, /name="pto_venta"/);
    assert.match(abierta.pie, /type="submit" form="dlg-factura"/); assert.match(abierta.pie, /data-cancelar/);
    cancelar.onclick(); assert.equal(cerrada, true); cerrada = false;
    await form.onsubmit({ preventDefault() {}, currentTarget: form });
    assert.equal(llamadas.at(-1).p_pto_venta, 3); assert.equal(llamadas.at(-1).p_numero, 12); assert.equal(llamadas.at(-1).p_version_esperada, 4);
    assert.equal(cerrada, true); assert.equal(submit.disabled, false);
    await M.accion({ dataset: { orden: '123', estado: 'no_corresponde' } });
    assert.equal(abierta.titulo, 'La factura no corresponde'); assert.match(abierta.cuerpo, /<select name="motivo"/);
  } finally { delete ctx.Sheet; }
});
await caso('Atrasadas: el mes anterior se calcula desde la fecha de hoy (Argentina), también al cambiar de año', () => {
  const hoy = M.hoy; try {
    M.hoy = () => '2026-11-04'; assert.deepEqual({ ...M._mesAnterior() }, { desde: '2026-10-01', hasta: '2026-10-31' });
    M.hoy = () => '2027-01-15'; assert.deepEqual({ ...M._mesAnterior() }, { desde: '2026-12-01', hasta: '2026-12-31' });
    M.hoy = () => '2026-03-01'; assert.deepEqual({ ...M._mesAnterior() }, { desde: '2026-02-01', hasta: '2026-02-28' });
  } finally { M.hoy = hoy; }
});
await caso('Atrasadas: la tarjeta trae el mes anterior, el punto de venta 4 y muestra el resumen con el margen del límite anual', () => {
  const hoy = M.hoy; M.hoy = () => '2026-11-04'; State.atrasadas = null;
  try {
    let h = M.tarjetaAtrasadas();
    assert.match(h, /Emitir facturas atrasadas/); assert.match(h, /id="atr-desde"[^>]*value="2026-10-01"/); assert.match(h, /id="atr-hasta"[^>]*value="2026-10-31"/);
    assert.match(h, /id="atr-fecha"[^>]*max="2026-11-04"[^>]*value="2026-10-31"/); assert.match(h, /id="atr-pto"[^>]*value="4"/); assert.doesNotMatch(h, /Emitir \d+ facturas/);
    State.facturacionAnual = { limite_centavos: 4500000000, total_centavos: 3100000000 };
    State.atrasadas = { modo: 'produccion', resumen: { cantidad: 95, total_centavos: 900000000, por_mes: [{ mes: '2026-10', cantidad: 95, centavos: 900000000 }] } };
    h = M.tarjetaAtrasadas();
    assert.match(h, /<b>95<\/b> ventas sin factura/); assert.match(h, /Emitir 95 facturas/); assert.match(h, /PRODUCCIÓN/); assert.match(h, /Entra en el margen/); assert.doesNotMatch(h, /SUPERA/);
    State.atrasadas.resumen.total_centavos = 2000000000; h = M.tarjetaAtrasadas();
    assert.match(h, /⚠ SUPERA/);
    State.facturacionAnual = { limite_centavos: 0, total_centavos: 0 }; h = M.tarjetaAtrasadas();
    assert.match(h, /No hay límite anual configurado/);
    State.atrasadas.resumen = { cantidad: 0, total_centavos: 0, por_mes: [] }; assert.doesNotMatch(M.tarjetaAtrasadas(), /Emitir \d+ facturas/);
    State.atrasadas = { corriendo: true, resumen: { cantidad: 5, total_centavos: 100 }, modo: 'homologacion' };
    h = M.tarjetaAtrasadas(); assert.match(h, /Detener/); assert.doesNotMatch(h, /Emitir 5 facturas/);
    State.meliFacturasAusente = true; assert.equal(M.tarjetaAtrasadas(), '');
  } finally { M.hoy = hoy; State.atrasadas = null; State.facturacionAnual = null; State.meliFacturasAusente = false; }
});
await caso('Atrasadas: los textos del servidor se muestran escapados (nada de HTML)', () => {
  State.atrasadas = { mensaje: '<img src=x onerror=alert(1)>', modo: '<b>x</b>', resumen: { cantidad: 1, total_centavos: 1, por_mes: [{ mes: '<i>', cantidad: 1, centavos: 1 }] } };
  const h = M.tarjetaAtrasadas(); State.atrasadas = null;
  assert.doesNotMatch(h, /<img|<i>|<b>x<\/b>/);
});
await caso('Atrasadas: emitir pide confirmar, escribir la cantidad (10 o más en producción) y recorre el servidor hasta terminar', async () => {
  const pedidos = [], respuestas = [
    { estado: 'ok', emitidas: 4, omitidas: 0, quedan: 6 }, { estado: 'ok', emitidas: 4, omitidas: 1, quedan: 1 }, { estado: 'ok', emitidas: 1, omitidas: 0, quedan: 0 }];
  const el = { 'atr-desde': { value: '2026-10-01' }, 'atr-hasta': { value: '2026-10-31' }, 'atr-fecha': { value: '2026-10-31' }, 'atr-pto': { value: '4' }, 'atr-estado': { textContent: '' } };
  ctx.document = { getElementById: id => el[id] || null };
  ctx.fetch = async (url, o) => { pedidos.push(JSON.parse(o.body)); return { json: async () => (o.body.includes('arca_atrasadas') ? respuestas.shift() : {}) }; };
  const confirmaciones = [], preguntas = []; ctx.confirm = m => { confirmaciones.push(m); return true; }; ctx.prompt = m => { preguntas.push(m); return '10'; };
  State.atrasadas = { desde: '2026-10-01', hasta: '2026-10-31', fecha: '2026-10-31', pto: 4, consulta: { desde: '2026-10-01', hasta: '2026-10-31', fecha: '2026-10-31', pto: 4 }, modo: 'produccion', resumen: { cantidad: 10, total_centavos: 100000 } };
  lectura = []; mensajes.length = 0;
  try {
    await M.atrasadasEmitir({});
    const emisiones = pedidos.filter(p => p.accion === 'arca_atrasadas');
    assert.equal(emisiones.length, 3); assert.deepEqual({ ...emisiones[0] }, { accion: 'arca_atrasadas', desde: '2026-10-01', hasta: '2026-10-31', fecha: '2026-10-31', pto_venta: 4 });
    assert.match(confirmaciones[0], /EMITIR 10 facturas/); assert.match(confirmaciones[0], /REALES/); assert.match(confirmaciones[0], /Punto de venta 4/); assert.equal(preguntas.length, 1);
    assert.match(State.atrasadas.mensaje, /Listo: 9 facturas emitidas y 1 omitidas/); assert.equal(State.atrasadas.corriendo, false); assert.equal(State.atrasadas.resumen, null);
  } finally { State.atrasadas = null; delete ctx.fetch; delete ctx.prompt; ctx.confirm = () => true; delete ctx.document; }
});
await caso('Atrasadas: no emite si cambiaron los datos, si no confirman o si la cantidad escrita no coincide', async () => {
  let llamadasWorker = 0; const el = { 'atr-desde': { value: '2026-10-01' }, 'atr-hasta': { value: '2026-10-31' }, 'atr-fecha': { value: '2026-10-31' }, 'atr-pto': { value: '4' } };
  ctx.document = { getElementById: id => el[id] || null }; ctx.fetch = async () => { llamadasWorker++; return { json: async () => ({}) }; };
  const base = () => ({ desde: '2026-10-01', hasta: '2026-10-31', fecha: '2026-10-31', pto: 4, consulta: { desde: '2026-10-01', hasta: '2026-10-31', fecha: '2026-10-31', pto: 4 }, modo: 'produccion', resumen: { cantidad: 12, total_centavos: 1 } });
  try {
    State.atrasadas = base(); el['atr-pto'].value = '5'; await M.atrasadasEmitir({}); assert.equal(llamadasWorker, 0); assert.match(mensajes.at(-1), /Cambiaste los datos/); el['atr-pto'].value = '4';
    State.atrasadas = base(); ctx.confirm = () => false; await M.atrasadasEmitir({}); assert.equal(llamadasWorker, 0);
    State.atrasadas = base(); ctx.confirm = () => true; ctx.prompt = () => '11'; await M.atrasadasEmitir({}); assert.equal(llamadasWorker, 0); assert.match(mensajes.at(-1), /No coincide la cantidad/);
    State.atrasadas = base(); State.atrasadas.fecha = '2999-01-01'; State.atrasadas.consulta.fecha = '2999-01-01'; el['atr-fecha'].value = '2999-01-01'; await M.atrasadasEmitir({}); assert.equal(llamadasWorker, 0); assert.match(mensajes.at(-1), /fecha/i);
  } finally { State.atrasadas = null; delete ctx.fetch; delete ctx.prompt; ctx.confirm = () => true; delete ctx.document; }
});
await caso('Atrasadas: se detiene y avisa en la orden problemática; ante «detenido», error o corte de red no sigue', async () => {
  const el = { 'atr-desde': { value: '2026-10-01' }, 'atr-hasta': { value: '2026-10-31' }, 'atr-fecha': { value: '2026-10-31' }, 'atr-pto': { value: '4' } };
  ctx.document = { getElementById: id => el[id] || null };
  const correr = async (respuestas, modo = 'homologacion') => {
    let k = 0; ctx.fetch = async () => ({ json: async () => { const r = respuestas[Math.min(k++, respuestas.length - 1)]; if (r === 'RED') throw new Error('red'); return r; } });
    State.atrasadas = { desde: '2026-10-01', hasta: '2026-10-31', fecha: '2026-10-31', pto: 4, consulta: { desde: '2026-10-01', hasta: '2026-10-31', fecha: '2026-10-31', pto: 4 }, modo, resumen: { cantidad: 3, total_centavos: 1 } };
    await M.atrasadasEmitir({}); const msg = State.atrasadas.mensaje; State.atrasadas = null; return { msg, k };
  };
  try {
    let r = await correr([{ estado: 'ok', emitidas: 1, omitidas: 0, quedan: 2 }, { estado: 'detenido', emitidas: 0, omitidas: 0, quedan: 2, detenido: { orden: '77', estado: 'rechazada', mensaje: '10016: fecha' } }]);
    assert.match(r.msg, /SE DETUVO en la orden 77: 10016: fecha\. Emitidas 1/); assert.equal(r.k, 2);
    r = await correr([{ estado: 'error', codigo: 'FECHA_FUTURA', mensaje: 'La fecha no puede ser futura.' }]); assert.match(r.msg, /FECHA_FUTURA.*futura/); assert.equal(r.k, 1);
    r = await correr(['RED']); assert.match(r.msg, /No se pudo conectar/); assert.equal(r.k, 1);
    r = await correr([{ estado: 'ok', emitidas: 0, omitidas: 0, quedan: 3 }]); assert.match(r.msg, /No avanzó/); assert.equal(r.k, 1);
    r = await correr([{ estado: 'simulacion' }]); assert.match(r.msg, /simulación/);
  } finally { State.atrasadas = null; delete ctx.fetch; delete ctx.document; }
});
await caso('Atrasadas: si cambiás un campo después de consultar, el resumen se oculta y NO se puede emitir lo viejo con datos nuevos', async () => {
  const el = { 'atr-desde': { value: '2026-10-01' }, 'atr-hasta': { value: '2026-12-31' }, 'atr-fecha': { value: '2026-10-31' }, 'atr-pto': { value: '4' }, 'atr-emitir': { style: {} }, 'atr-resumen': { style: {} } };
  ctx.document = { getElementById: id => el[id] || null }; let worker = 0; ctx.fetch = async () => { worker++; return { json: async () => ({}) }; };
  State.atrasadas = { desde: '2026-10-01', hasta: '2026-10-31', fecha: '2026-10-31', pto: 4, modo: 'produccion', consulta: { desde: '2026-10-01', hasta: '2026-10-31', fecha: '2026-10-31', pto: 4 }, resumen: { cantidad: 1, total_centavos: 100 } };
  try {
    M.atrasadasCampo();                                      // el rango «hasta» pasó a fin de año: ya no es lo que se consultó
    assert.equal(State.atrasadas.resumen, null); assert.equal(State.atrasadas.consulta, null); assert.equal(el['atr-emitir'].style.display, 'none'); assert.equal(el['atr-resumen'].style.display, 'none');
    await M.atrasadasEmitir({}); assert.equal(worker, 0);
    // Si todo vuelve a coincidir con lo consultado, no se oculta nada.
    State.atrasadas = { consulta: { desde: '2026-10-01', hasta: '2026-12-31', fecha: '2026-10-31', pto: 4 }, resumen: { cantidad: 1 } }; el['atr-emitir'].style = {}; el['atr-resumen'].style = {};
    M.atrasadasCampo(); assert.ok(State.atrasadas.resumen); assert.equal(el['atr-emitir'].style.display, undefined);
  } finally { State.atrasadas = null; delete ctx.fetch; delete ctx.document; }
});
await caso('Atrasadas: se emite la copia FIJA de lo consultado, no lo que haya en los campos', async () => {
  const el = { 'atr-desde': { value: '2026-10-01' }, 'atr-hasta': { value: '2026-10-31' }, 'atr-fecha': { value: '2026-10-31' }, 'atr-pto': { value: '4' } };
  ctx.document = { getElementById: id => el[id] || null }; const pedidos = [];
  ctx.fetch = async (u, o) => { pedidos.push(JSON.parse(o.body)); return { json: async () => ({ estado: 'ok', emitidas: 1, omitidas: 0, quedan: 0 }) }; };
  State.atrasadas = { desde: 'X', hasta: 'Y', fecha: 'Z', pto: 99, modo: 'homologacion', consulta: { desde: '2026-10-01', hasta: '2026-10-31', fecha: '2026-10-31', pto: 4 }, resumen: { cantidad: 1, total_centavos: 1 } };
  try { await M.atrasadasEmitir({}); assert.deepEqual({ ...pedidos[0] }, { accion: 'arca_atrasadas', desde: '2026-10-01', hasta: '2026-10-31', fecha: '2026-10-31', pto_venta: 4 }); }
  finally { State.atrasadas = null; delete ctx.fetch; delete ctx.document; }
});
await caso('Atrasadas: una corrida «detenido» por ventas bloqueadas se muestra como detenida, no como «Listo»', async () => {
  const el = { 'atr-desde': { value: '2026-10-01' }, 'atr-hasta': { value: '2026-10-31' }, 'atr-fecha': { value: '2026-10-31' }, 'atr-pto': { value: '4' } };
  ctx.document = { getElementById: id => el[id] || null };
  ctx.fetch = async () => ({ json: async () => ({ estado: 'detenido', emitidas: 0, omitidas: 0, quedan: 3, detenido: { orden: null, estado: 'bloqueadas', mensaje: '2 venta(s) del rango tienen una factura rechazada hace poco.' } }) });
  State.atrasadas = { modo: 'homologacion', consulta: { desde: '2026-10-01', hasta: '2026-10-31', fecha: '2026-10-31', pto: 4 }, resumen: { cantidad: 3, total_centavos: 1 } };
  try { await M.atrasadasEmitir({}); assert.match(State.atrasadas.mensaje, /SE DETUVO/); assert.match(State.atrasadas.mensaje, /rechazada hace poco/); assert.doesNotMatch(State.atrasadas.mensaje, /Listo/); }
  finally { State.atrasadas = null; delete ctx.fetch; delete ctx.document; }
});
await caso('Atrasadas: «Detener» corta antes de la próxima tanda', async () => {
  const el = { 'atr-desde': { value: '2026-10-01' }, 'atr-hasta': { value: '2026-10-31' }, 'atr-fecha': { value: '2026-10-31' }, 'atr-pto': { value: '4' } };
  ctx.document = { getElementById: id => el[id] || null }; let tandas = 0;
  ctx.fetch = async () => ({ json: async () => { tandas++; M._atrParar = true; return { estado: 'ok', emitidas: 2, omitidas: 0, quedan: 5 }; } });
  State.atrasadas = { desde: '2026-10-01', hasta: '2026-10-31', fecha: '2026-10-31', pto: 4, consulta: { desde: '2026-10-01', hasta: '2026-10-31', fecha: '2026-10-31', pto: 4 }, modo: 'homologacion', resumen: { cantidad: 7, total_centavos: 1 } };
  try { await M.atrasadasEmitir({}); assert.equal(tandas, 1); assert.match(State.atrasadas.mensaje, /Detenido por vos\. Emitidas 2/); }
  finally { State.atrasadas = null; delete ctx.fetch; delete ctx.document; M._atrParar = false; }
});
await caso('Formulario convierte campos numéricos y conserva versión al abrir', async () => {
  State.meliFacturas = [{ orden_id: '123', estado: 'pendiente', version: 4 }];
  const submit = {}, cancel = {}, form = { querySelector: () => submit };
  let cerrado = false;
  const dialog = { querySelector: selector => selector === 'form' ? form : cancel, close() { cerrado = true; }, showModal() {} };
  ctx.document = { createElement: () => dialog, body: { append() {} } };
  ctx.FormData = class { *[Symbol.iterator]() { yield* Object.entries({ tipo: 'C', pto_venta: '0003', numero: '00001234', emitida_el: '2020-01-01' }); } };
  respuesta = { data: { ok: true, orden_id: '123', estado: 'emitida', version: 5 } };
  lectura = [{ orden_id: '123', estado: 'emitida', ...datos, version: 5 }];
  await M.accion({ dataset: { orden: '123', estado: 'emitida' } });
  State.meliFacturas[0].version = 5;
  await form.onsubmit({ preventDefault() {}, currentTarget: form });
  assert.equal(llamadas.at(-1).p_pto_venta, 3); assert.equal(llamadas.at(-1).p_numero, 1234);
  assert.equal(llamadas.at(-1).p_version_esperada, 4); assert.equal(cerrado, true); assert.equal(submit.disabled, false);
});
await caso('Reabrir requiere confirmación con aviso v2', async () => {
  State.meliFacturas = [{ orden_id: '123', estado: 'emitida', ...datos, version: 7 }];
  const antes = llamadas.length;
  ctx.confirm = mensaje => { assert.match(mensaje, /Reabrir NO anula.*historial/); return false; };
  await M.accion({ dataset: { orden: '123', estado: 'pendiente' } });
  assert.equal(llamadas.length, antes); ctx.confirm = () => true;
});
await caso('Reabrir limpia datos y envía versión existente', async () => {
  State.meliFacturas = [{ orden_id: '123', estado: 'emitida', ...datos, version: 8 }];
  lectura = [{ orden_id: '123', estado: 'pendiente', numero: null, tipo: null, pto_venta: null, emitida_el: null, motivo: null, version: 9 }];
  assert.equal(await M.marcar('123', 'pendiente', { ...datos, motivo: 'viejo' }), true);
  assert.deepEqual(JSON.parse(JSON.stringify(llamadas.at(-1))), { p_orden: '123', p_estado: 'pendiente', p_tipo: null, p_pto_venta: null, p_numero: null, p_emitida_el: null, p_motivo: null, p_version_esperada: 8 });
  assert.equal(M.de(o).numero, null); assert.equal(M.de(o).emitida_el, null);
});
await caso('Fila pendiente usa su versión y formulario conserva la versión leída', async () => {
  State.meliFacturas = [{ orden_id: '123', estado: 'pendiente', version: 9 }];
  await M.marcar('123', 'emitida', datos); assert.equal(llamadas.at(-1).p_version_esperada, 9);
  State.meliFacturas = [{ orden_id: '123', estado: 'pendiente', version: 11 }];
  await M.marcar('123', 'emitida', datos, null, 9); assert.equal(llamadas.at(-1).p_version_esperada, 9);
});
await caso('Transiciones cerradas y botones', async () => {
  for (const estado of ['emitida', 'no_corresponde']) {
    State.meliFacturas = [{ orden_id: '123', estado, ...datos, motivo: 'no_es_venta_real', version: 3 }];
    assert.match(M.tarjeta(o), /Reabrir/); assert.doesNotMatch(M.tarjeta(o), /Marcar emitida|No corresponde…/);
    const antes = llamadas.length;
    assert.equal(await M.marcar('123', 'emitida', datos), false);
    assert.equal(await M.marcar('123', 'no_corresponde', { motivo: 'no_es_venta_real' }), false);
    assert.equal(llamadas.length, antes);
  }
  assert.ok(M.validar('desconocido'));
});
await caso('Revertidas, canceladas y ambas formas de cierre manual excluidas', () => {
  for (const cambios of [{ revertidaEn: 'x' }, { cerradaManual: { motivo: 'descartada' } }, { cerradaManual: { motivo: 'ya_cargada' } }, { cerradaManualEn: 'x' }, { estado: 'cancelled' }, { estado: 'cancelada' }]) assert.equal(M.sinFactura({ ...o, ...cambios }), false);
  assert.equal(M.sinFactura(o), true);
  State.meliFacturas = [{ orden_id: '123', estado: 'emitida' }]; assert.equal(M.sinFactura(o), false);
});
await caso('Contador y filtro sin factura', () => {
  assert.equal(M.contar([o, { ...o, revertidaEn: 'x' }]), 1);
  assert.match(M.cabecera([o]), /1 ventas de Mercado Libre sin factura/); assert.doesNotMatch(M.cabecera([]), /0 ventas/);
  M.filtrar(true); assert.equal(ctx.MeliOrdenes.filtro, 'todas');
});
const errores = {
  FACTURA_CAMBIO_RECARGAR: /Otra persona.*Recargá/, FACTURA_YA_REGISTRADA: /Reabrila/, NUMERO_REPETIDO: /otra orden.*456/,
  ESTADO_INVALIDO: /estado.*válido/, TIPO_INVALIDO: /tipo.*válido/, PUNTO_VENTA_INVALIDO: /punto de venta.*válido/, NUMERO_INVALIDO: /número.*válido/,
  FECHA_INVALIDA: /fecha.*válida/, MOTIVO_INVALIDO: /motivo.*lista/, DATOS_SOBRANTES: /datos.*no corresponden/, ORDEN_INEXISTENTE: /orden no existe/,
};
for (const [message, texto] of Object.entries(errores)) await caso(`Error ${message}: castellano sin cambiar estado`, async () => {
  const previo = State.meliFacturas;
  respuesta = { error: { message, details: '456' } };
  assert.equal(await M.marcar('123', 'emitida', datos), false);
  assert.equal(State.meliFacturas, previo); assert.match(mensajes.at(-1), texto); assert.doesNotMatch(mensajes.at(-1), new RegExp(message));
});
await caso('No autorizado 42501 o mensaje; excepción y respuesta fallida sin mutar', async () => {
  const previo = State.meliFacturas;
  for (const error of [{ code: '42501' }, { message: 'no autorizado' }]) {
    respuesta = { error }; assert.equal(await M.marcar('123', 'emitida', datos), false); assert.match(mensajes.at(-1), /No estás autorizado/); assert.equal(State.meliFacturas, previo);
  }
  respuesta = { data: { ok: false } }; assert.equal(await M.marcar('123', 'emitida', datos), false); assert.equal(State.meliFacturas, previo);
  const db = ctx.DB.marcarFactura; ctx.DB.marcarFactura = async () => { throw Error('red'); };
  assert.equal(await M.marcar('123', 'emitida', datos), false); assert.equal(State.meliFacturas, previo); ctx.DB.marcarFactura = db;
});
await caso('sin_cambios es éxito y recarga desde la base', async () => {
  respuesta = { data: { ok: true, orden_id: '123', estado: 'emitida', version: 1, sin_cambios: true } };
  lectura = [{ orden_id: '123', estado: 'emitida', ...datos, version: 1 }];
  assert.equal(await M.marcar('123', 'emitida', datos), true); assert.equal(M.de(o).version, 1);
});
await caso('No hay estado optimista durante RPC ni durante recarga', async () => {
  const previo = State.meliFacturas, db = ctx.DB.marcarFactura;
  let resolver;
  ctx.DB.marcarFactura = () => new Promise(r => { resolver = r; });
  const pendiente = M.marcar('123', 'emitida', datos);
  assert.equal(State.meliFacturas, previo);
  assert.equal(await M.marcar('123', 'emitida', datos), false);
  resolver({ error: { message: 'FACTURA_CAMBIO_RECARGAR' } });
  assert.equal(await pendiente, false); assert.equal(State.meliFacturas, previo); ctx.DB.marcarFactura = db;
});
await caso('Escape HTML en motivo, comprobante e identificador', () => {
  State.meliFacturas = [{ orden_id: '123', estado: 'no_corresponde', motivo: '<img src=x onerror="alert(1)">' }];
  assert.doesNotMatch(M.tarjeta(o), /<img|onerror/);
  State.meliFacturas = [{ orden_id: '123', estado: 'emitida', tipo: '<img>', numero: '<img>', pto_venta: '<img>' }];
  assert.match(M.tarjeta(o), /&lt;img&gt;/); assert.doesNotMatch(M.tarjeta(o), /<img/);
  assert.match(M.tarjeta({ orderId: '" onclick="evil' }), /&quot;/);
});
await caso('Emisor fijo, textos v2, sin campos fiscales ajenos ni datos de identidad', () => {
  assert.match(M.cabecera([]), /Franco Ezequiel Velas/); assert.match(M.cabecera([]), /Reabrir NO anula el comprobante ante ARCA; el número queda en el historial./);
  assert.match(M.cabecera([]), /Cancelar o revertir la orden no cambia su factura./);
  assert.doesNotMatch(fuente, /p_importe|p_emisor|name="(?:importe|emisor)"|comprador|dni|cuit|direccion|dirección/i);
  assert.deepEqual(Object.keys(llamadas[0]).sort(), ['p_emitida_el','p_estado','p_motivo','p_numero','p_orden','p_pto_venta','p_tipo','p_version_esperada']);
});
await caso('Tabla ausente oculta sección; otros errores informan y recuperación funciona', async () => {
  for (const code of ['42P01', 'PGRST205']) {
    falloLectura = { code }; const previo = State.meliFacturas;
    assert.equal(await M.cargar(ctx.supa), false); assert.equal(State.meliFacturas, previo);
    assert.equal(M.cabecera([o]), ''); assert.equal(M.tarjeta(o), '');
  }
  falloLectura = { code: '42501' }; await M.cargar(ctx.supa); assert.match(M.cabecera([o]), /no disponible/); assert.doesNotMatch(M.tarjeta(o), /Marcar emitida/);
  falloLectura = null; await M.cargar(ctx.supa); assert.equal(State.meliFacturasError, false); assert.equal(State.meliFacturasAusente, false);
});
await caso('Engarces reales y vista de órdenes', () => {
  const ordenes = leer('src/modules/meli-ordenes.js');
  State.meliError = false; State.meliPendienteLiberar = () => ({ ars: 0, ordenes: 0 }); State.fmtARS = String;
  vm.runInContext(ordenes, ctx);
  State.meliOrdenes[0].comprador = 'NOMBRE PRIVADO'; M._soloSinFactura = false;
  // La pantalla de órdenes ya mostraba el usuario (apodo) del comprador por decisión de Franco; lo que se exige acá es que
  // el módulo de facturas no agregue ningún dato del comprador.
  assert.doesNotMatch(M.tarjeta(State.meliOrdenes[0]) + M.cabecera(State.meliOrdenes), /NOMBRE PRIVADO/);
  assert.match(ctx.MeliOrdenes._vista(), /Factura pendiente/); assert.match(ctx.MeliOrdenes._vista(), /Sin factura/);
  const db = leer('src/modules/supabase-config.js');
  assert.match(db, /finally \{ if \(window\.MeliFacturas\) await window\.MeliFacturas\.cargar\(supa\); \}/);
  for (const f of ['src/modules/supabase-config.js', 'src/modules/meli-ordenes.js']) { assert.doesNotThrow(() => new vm.Script(leer(f))); assert.doesNotMatch(leer(f), /^import /m); }
  assert.match(leer('src/modules/app.js'), /import '\.\/meli-facturas\.js';/);
  assert.match(db, /marcarFactura\(args\) \{ return supa.rpc\('meli_factura_marcar', args\); \}/);
  assert.match(ordenes, /o\.revertidaEn/); assert.match(ordenes, /o\.cerradaManual/); assert.match(leer('src/modules/meli-vincular.js'), /o\.cerradaManual/);
});
console.log(`${n} casos pasan`);
