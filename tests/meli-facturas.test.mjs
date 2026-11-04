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
