// Pruebas de la sonda de solo lectura (api/_meli_sonda.js, atendida por api/meli/worker.js), con Mercado Libre y
// Supabase SIMULADOS. Lo que importa: sale la FORMA de las respuestas y NINGÚN dato de una persona; solo se hacen GET;
// nunca se pide nada de facturación; y no hace falta ninguna escritura en la base.
//
//   node tests/meli_sonda.test.mjs
import { createRequire } from 'node:module';

process.env.MELI_RPC_SECRET = 'secreto-rpc-de-prueba-0123456789abcdef';
process.env.MELI_APP_ID = '123456';
process.env.MELI_CLIENT_SECRET = 'client-secret-de-prueba';
process.env.SUPABASE_ANON_KEY = 'anon-de-prueba';

const require = createRequire(import.meta.url);
const RAIZ = new URL('..', import.meta.url).pathname;
const worker = require(RAIZ + 'api/meli/worker.js');
const S = require(RAIZ + 'api/_meli_sonda.js');

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const resp = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

// Datos de personas plantados a propósito: NINGUNO puede aparecer en la salida.
const PERSONALES = ['Juanita', 'Pérez', 'Siempreviva', '12345678', 'juanita@correo.com', '1155550101', 'ABC123456', 'Rosario', 'Santa Fe', 'jperez_nick'];
const ENVIO = { id: 4444, status: 'ready_to_ship', substatus: 'printed', logistic_type: 'xd_drop_off', tracking_number: 'ABC123456', tracking_method: 'Correo Argentino',
  lead_time: { estimated_delivery_time: { date: '2026-10-14T00:00:00Z' }, cost: 5500 },
  shipping_option: { estimated_delivery_time: { date: '2026-10-14T00:00:00Z' }, estimated_delivery_limit: { date: '2026-10-16T00:00:00Z' } },
  status_history: { date_shipped: null, date_ready_to_ship: '2026-10-10T10:00:00Z' },
  receiver_address: { receiver_name: 'Juanita Pérez', address_line: 'Av. Siempreviva 742', city: { name: 'Rosario' }, state: { name: 'Santa Fe' }, receiver_phone: '1155550101', comment: 'dejar con el portero' },
  '123456789': { dinamica: true } };
const PAGO = { id: 3333, status: 'approved', status_detail: 'accredited', transaction_amount: 65990, currency_id: 'ARS',
  payer: { email: 'juanita@correo.com', identification: { type: 'DNI', number: '12345678' } },
  transaction_details: { net_received_amount: 40945.59 },
  fee_details: [{ type: 'mercadopago_fee', amount: 1000, fee_payer: 'collector' }],
  charges_details: [{ name: 'Juanita cobro', type: 'tax', amounts: { original: 120 } }] };
const ORDEN = { id: 2000018883051330, status: 'paid', total_amount: 65990, currency_id: 'ARS',
  buyer: { id: 99, nickname: 'jperez_nick', first_name: 'Juanita', last_name: 'Pérez', email: 'juanita@correo.com' },
  order_items: [{ item: { id: 'MLA3483031562', title: 'Perfume Lattafa Khamrah' }, quantity: 1, unit_price: 65990, sale_fee: 9000 }],
  payments: [{ id: 3333, status: 'approved' }], shipping: { id: 4444 } };

const llamadas = [];
let mundo;
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  llamadas.push({ url, metodo: (opts.method || 'GET') });
  if (url.includes('/auth/v1/user')) return resp(200, { email: 'franco@x.com' });
  if (url.includes('/rest/v1/usuarios_autorizados')) return resp(200, [{ activo: true }]);
  if (url.includes('/rest/v1/rpc/')) {
    const n = url.split('/rpc/')[1];
    return mundo.rpc[n] || resp(404, { message: 'sin simular ' + n });
  }
  const ruta = url.replace(/^https:\/\/api\.(mercadolibre|mercadopago)\.com/, '');
  const clave = Object.keys(mundo.api).find((k) => ruta.startsWith(k));
  return clave ? mundo.api[clave] : resp(404, { error: 'not_found', message: 'detalle Juanita Pérez' });
};

const futuro = () => new Date(Date.now() + 3600_000).toISOString();
function reiniciar() {
  mundo = {
    rpc: {
      meli_cuenta_info: resp(200, [{ meli_user_id: '84973558', activa: true }]),
      meli_tokens_tomar: resp(200, [{ access_token: 'TOKEN-SECRETO', refresh_token: 'x', token_expira_en: futuro(), activa: true, requiere_reconexion: false, refresh_ambiguo: false, debe_refrescar: false, lease_id: 'l', generacion: 1 }]),
    },
    api: {
      '/orders/search': resp(200, { paging: { total: 3, limit: 5, offset: 0 }, results: [ORDEN] }),
      '/orders/2000018883051330': resp(200, ORDEN),
      '/v1/payments/3333': resp(200, PAGO),
      '/shipments/4444/costs': resp(200, { gross_amount: 9000, senders: [{ cost: 5500 }] }),
      '/shipments/4444': resp(200, ENVIO),
    },
  };
  llamadas.length = 0;
}
let n = 0;
async function pedir(body, { token = 'tok' } = {}) {
  const res = { code: null, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  await worker({ method: 'POST', body, headers: { 'x-crm-token': token, 'x-forwarded-for': `10.7.0.${++n % 250}` }, socket: {}, url: '/api/meli/worker' }, res);
  return res;
}

console.log('\n══ Sonda de solo lectura de Mercado Libre ══\n');

{
  reiniciar();
  const r = await pedir({ accion: 'sonda', cuenta: 1 });
  const texto = JSON.stringify(r.body);
  check('Responde 200 con los pasos de la sonda', r.code === 200 && r.body.ok === true && Array.isArray(r.body.pasos), JSON.stringify(r.code));
  const nombres = r.body.pasos.map((p) => p.paso);
  check('Pasa por búsqueda, orden, pago, envío y costos del envío', ['busqueda_por_actualizacion_48h', 'orden', 'pago', 'envio', 'envio_costos'].every((x) => nombres.includes(x)), nombres.join());
  check('NINGÚN dato de una persona aparece en la salida (nombre, apellido, dirección, DNI, mail, teléfono, seguimiento, ciudad, apodo)',
    PERSONALES.every((p) => !texto.includes(p)), PERSONALES.filter((p) => texto.includes(p)).join());
  check('Aparece la forma: nombres de campo y tipos', texto.includes('receiver_address') && texto.includes('"integer"') && texto.includes('sale_fee'));
  check('Los códigos de estado SÍ se muestran (status, substatus, tipo logístico)', texto.includes('string:ready_to_ship') && texto.includes('string:printed') && texto.includes('string:xd_drop_off'));
  check('El método de tracking ("Correo Argentino") no se muestra', !texto.includes('Correo'));
  check('Una clave numérica larga no se nombra', !texto.includes('123456789') && texto.includes('<clave dinámica>'));
  check('El paging informa el total de la búsqueda', JSON.stringify(r.body.pasos[0].paging) === JSON.stringify({ total: 3, limit: 5, offset: 0 }));
  check('Ni tokens ni el secreto de la base salen', !texto.includes('TOKEN-SECRETO') && !texto.includes(process.env.MELI_RPC_SECRET));
  const ml = llamadas.filter((c) => /api\.(mercadolibre|mercadopago)\.com/.test(c.url));
  check('Todo lo que se pide a Mercado Libre y Mercado Pago es GET', ml.length > 0 && ml.every((c) => c.metodo === 'GET'), JSON.stringify(ml));
  check('Nunca se pide facturación ni datos del comprador', !llamadas.some((c) => /billing|\/users\//i.test(c.url)));
  check('A lo sumo 7 pedidos a Mercado Libre', ml.length <= 7, String(ml.length));
  check('La única RPC es la de leer el usuario de la cuenta y el token (nada se escribe)',
    llamadas.filter((c) => c.url.includes('/rpc/')).every((c) => /meli_cuenta_info|meli_tokens_tomar/.test(c.url)));
}
{
  reiniciar();
  const a = await pedir({ accion: 'sonda', cuenta: 1 }, { token: 'x' });
  mundo.api = {};
  const b = await pedir({ accion: 'sonda', cuenta: 1 });
  const t = JSON.stringify(b.body);
  check('Si Mercado Libre contesta 404/403, solo salen el estado y un código corto, nunca el mensaje', b.code === 200 && !t.includes('Juanita') && b.body.pasos.some((p) => p.http === 404 && p.error === 'not_found'), t.slice(0, 300));
  const c = await pedir({ accion: 'sonda', cuenta: 'abc' });
  const d = await pedir({ accion: 'sonda', cuenta: -1 });
  const e = await pedir({ accion: 'sonda' });
  check('Una cuenta inválida da 400 y no consulta nada', c.code === 400 && d.code === 400 && e.code === 400);
}
{
  reiniciar();
  mundo.rpc.meli_cuenta_info = resp(200, [{ meli_user_id: '84973558', activa: false }]);
  const r = await pedir({ accion: 'sonda', cuenta: 1 });
  check('Una cuenta inactiva no se consulta', r.body.ok === false && r.body.error === 'CUENTA_INACTIVA_O_INEXISTENTE' && !llamadas.some((c) => /mercadolibre\.com/.test(c.url)));
}
{
  reiniciar();
  const r = await pedir({ accion: 'sonda', cuenta: 1, orden: '../../users/me' });
  check('Un id de orden con caracteres raros se ignora (se usa la orden de muestra) y no arma rutas raras', r.code === 200 && !llamadas.some((c) => /\.\./.test(c.url)));
  const s = S.forma({ a: [1, 2], b: { c: 'x' }, d: null, status: 'paid texto con espacios' }, '', 0);
  check('forma(): un valor de campo enumerado con espacios no se muestra', s.status === 'string' && s.a.elemento === 'integer' && s.d === 'null');
  const raro = S.forma({ status: 'TOKEN-SECRETO', substatus: 'jperez_nick99', type: 'ready_to_print', meta: { 'juanita@correo.com': 1, 'Juanita': 2, '99887766': 3, ok_campo: 4 } }, '', 0);
  check('Códigos: solo minúsculas con guion bajo; un token, un apodo con dígitos o un mail no salen', raro.status === 'string' && raro.substatus === 'string' && raro.type === 'string:ready_to_print');
  check('Claves: un mail, un nombre con mayúscula o un id no se nombran; un campo snake_case sí', !JSON.stringify(raro).includes('juanita') && !JSON.stringify(raro).includes('Juanita') && !JSON.stringify(raro).includes('99887766') && raro.meta.ok_campo === 'integer');
}
{
  // El drenaje de siempre sigue funcionando cuando el cuerpo no pide la sonda.
  reiniciar();
  mundo.rpc.meli_notificacion_reclamar = resp(200, []);
  const r = await pedir(undefined);
  check('Un POST sin cuerpo sigue drenando la cola como antes', r.code === 200 && r.body.reclamadas === 0, JSON.stringify(r.body));
}

{
  // ── Extensión: valores de listas, campos completos y conciliación de importes ──
  reiniciar();
  const ORD = (id, tot, fee) => ({ id, status: 'paid', date_created: '2026-10-08T23:06:00.000-03:00', total_amount: tot,
    buyer: { id: 99, nickname: 'jperez_nick', first_name: 'Juanita', last_name: 'Pérez' },
    order_items: [{ item: { id: 'MLA3483031562', title: 'Perfume Lattafa' }, quantity: 2, unit_price: tot / 2, sale_fee: fee }],
    payments: [{ id: 3333, status: 'approved' }], shipping: { id: 4444 } });
  mundo.api['/orders/search'] = resp(200, { paging: { total: 2, limit: 6, offset: 0 }, results: [ORD(2000018883051330, 1000, 150), ORD(2000018747526358, 500, 75)] });
  mundo.api['/v1/payments/3333'] = resp(200, { id: 3333, status: 'approved', transaction_amount: 1000, taxes_amount: 0, shipping_amount: 0,
    amounts: { collector: { net_received: 700 } }, money_release_date: '2026-10-21T10:00:00.000-04:00', fee_details: [],
    payer: { email: 'juanita@correo.com' },
    charges_details: [{ name: 'financing_fee', type: 'fee', amounts: { original: 100 } }, { name: 'mercadopago_fee', type: 'fee', amounts: { original: 100 } },
                      { name: 'tax_iibb', type: 'tax', amounts: { original: 50 } }] });
  mundo.api['/shipments/4444/costs'] = resp(200, { gross_amount: 600, senders: [{ cost: 50 }], receiver: { cost: 0 } });
  const r = await pedir({ accion: 'conciliar', cuenta: 1 });
  const t = JSON.stringify(r.body);
  const o = r.body.ordenes && r.body.ordenes[0];
  check('conciliar: responde las órdenes con importes', r.code === 200 && r.body.ok && r.body.ordenes.length === 2 && o.precio === 1000 && o.cargo_venta_sale_fee === 300, t.slice(0, 300));
  check('conciliar: cada cargo del pago sale por tipo y nombre, y los impuestos aparte', o.pagos[0].cargos_por_tipo_y_nombre['fee:financing_fee'] === 100 && o.pagos[0].cargos_por_tipo_y_nombre['tax:tax_iibb'] === 50 && o.impuestos_type_tax === 50);
  check('conciliar: informa el costo de envío del vendedor y el neto', o.envio.costo_vendedor_senders_cost === 50 && o.neto_total === 700);
  check('conciliar: dice qué fórmula cierra (cargos del pago + envío: 1000−250−50−700 = 0)', o.diferencia_con_todos_los_cargos_del_pago === 0 && o.diferencia_con_sale_fee === -100, JSON.stringify([o.diferencia_con_todos_los_cargos_del_pago, o.diferencia_con_sale_fee]));
  check('conciliar: envío con estado, subestado y campos de fecha (solo nombres)', o.envio.estado === 'ready_to_ship' && o.envio.subestado === 'printed' && o.envio.campos_de_fecha.includes('shipping_option.estimated_delivery_time') && o.envio.campos_de_fecha.some((x) => x.startsWith('status_history.')));
  check('conciliar: NINGÚN dato personal (nombre, mail, dirección, seguimiento, ciudad, apodo, teléfono)', PERSONALES.every((p) => !t.includes(p)), PERSONALES.filter((p) => t.includes(p)).join());
  const ml = llamadas.filter((c) => /api\.(mercadolibre|mercadopago)\.com/.test(c.url));
  check('conciliar: todo GET, nada de facturación, y no más de 1 + 6×(3 pagos + 3) pedidos', ml.every((c) => c.metodo === 'GET') && !llamadas.some((c) => /billing/i.test(c.url)) && ml.length <= 37, String(ml.length));
  check('conciliar: solo lee de la base (cuenta y token)', llamadas.filter((c) => c.url.includes('/rpc/')).every((c) => /meli_cuenta_info|meli_tokens_tomar/.test(c.url)));
  const sin = await pedir({ accion: 'conciliar', cuenta: 'x' });
  check('conciliar: cuenta inválida → 400', sin.code === 400);

  // El tipo de TODOS los cargos de una lista sale en "valores", y `name` solo se muestra dentro de charges_details.
  const f = S.forma({ charges_details: [{ type: 'fee', name: 'financing_fee' }, { type: 'tax', name: 'tax_iibb' }, { type: 'fee', name: 'x' }],
                      receiver_address: { name: 'juanita', type: 'forward' } }, '', 0);
  check('forma(): lista de cargos con los tipos y nombres de todos los elementos', JSON.stringify(f.charges_details.valores.type) === '["fee","tax"]' && f.charges_details.valores.name.includes('financing_fee'));
  check('forma(): "name" fuera de charges_details no se muestra', f.receiver_address.name === 'string' && !JSON.stringify(f).includes('juanita'));
  // Cargos con un nombre que no es de cargo, y fechas con basura: no se copian.
  const g = S.forma({ charges_details: [{ type: 'fee', name: 'juanita' }, { type: 'tax', name: 'rosario_tax' }] }, '', 0);
  check('forma(): el nombre de un cargo solo sale si usa vocabulario de cargos ("juanita" no, "rosario_tax" sí es vocabulario)', JSON.stringify(g.charges_details.valores.name) === '["<otro>","rosario_tax"]', JSON.stringify(g.charges_details.valores));
  {
    reiniciar();
    const conBasura = { ...ORD(2000018883051330, 1000, 150), date_created: 'jperez_nick@correo.com' };
    mundo.api['/orders/search'] = resp(200, { paging: { total: 1 }, results: [conBasura] });
    mundo.api['/v1/payments/3333'] = resp(200, { id: 3333, status: 'approved', transaction_amount: 1000, amounts: { collector: { net_received: 700 } },
      money_release_date: 'Juanita Pérez 12345678', charges_details: [{ name: 'juanita', type: 'fee', amounts: { original: 250 } }] });
    mundo.api['/shipments/4444/costs'] = resp(500, { error: 'internal' });
    const x = await pedir({ accion: 'conciliar', cuenta: 1 });
    const tx = JSON.stringify(x.body), oo = x.body.ordenes[0];
    check('conciliar: una fecha con basura no se copia (null) y nada personal sale', oo.fecha_creada === null && oo.pagos[0].fecha_liberacion === null && PERSONALES.every((p) => !tx.includes(p)) && !tx.includes('juanita'), tx.slice(0, 300));
    check('conciliar: si falla el costo de envío la orden queda "incompleta" y NINGUNA diferencia se calcula (no se toma como 0)',
      oo.incompleta === true && oo.diferencia_con_sale_fee === null && oo.diferencia_con_todos_los_cargos_del_pago === null && oo.diferencia_sin_envio_con_todos_los_cargos === null, tx.slice(0, 400));
  }
  {
    reiniciar();
    mundo.api['/orders/search'] = resp(200, { paging: { total: 1 }, results: [{ ...ORD(2000018883051330, 1000, 150), payments: [{ id: 3333 }, { id: 3334 }, { id: 3335 }, { id: 3336 }] }] });
    mundo.api['/v1/payments/333'] = resp(200, { id: 3333, status: 'approved', transaction_amount: 250, amounts: { collector: { net_received: 175 } }, charges_details: [] });
    mundo.api['/shipments/4444/costs'] = resp(200, { gross_amount: 0, senders: [{ cost: 0 }] });
    const y = await pedir({ accion: 'conciliar', cuenta: 1 });
    check('conciliar: una orden con más de 3 pagos queda incompleta (no se suma un total parcial)', y.body.ordenes[0].incompleta === true && y.body.ordenes[0].neto_total === null && y.body.ordenes[0].diferencia_con_sale_fee === null);
  }
  {
    // Se agota el tiempo ENTRE el envío y sus costos: no se pide el costo y la orden queda incompleta y parcial.
    reiniciar();
    mundo.api['/orders/search'] = resp(200, { paging: { total: 1 }, results: [ORD(2000018883051330, 1000, 150)] });
    mundo.api['/v1/payments/3333'] = resp(200, { id: 3333, status: 'approved', transaction_amount: 1000, amounts: { collector: { net_received: 700 } }, charges_details: [] });
    const lento = resp(200, ENVIO);
    mundo.api['/shipments/4444'] = lento;
    mundo.api['/shipments/4444/costs'] = resp(200, { gross_amount: 600, senders: [{ cost: 50 }] });
    const antes = globalThis.fetch;
    globalThis.fetch = async (url, opts) => { if (String(url).endsWith('/shipments/4444')) await new Promise((r) => setTimeout(r, 6600)); return antes(url, opts); };
    const pres = require(RAIZ + 'api/_meli.js').presupuestoHasta(Date.now() + 9000);
    const z = await S.conciliar({ cuentaId: 1 }, pres);
    globalThis.fetch = antes;
    const oz = z.ordenes[0];
    check('conciliar: si se agota el tiempo entre el envío y los costos NO se pide /costs, queda parcial/incompleta y sin diferencias',
      z.cortado === true && oz.parcial === true && oz.incompleta === true && oz.diferencia_con_sale_fee === null && !llamadas.some((c) => c.url.endsWith('/costs')), JSON.stringify(z).slice(0, 300));
  }
  const ancho = {}; for (let i = 0; i < 100; i++) ancho['campo_' + i] = 1;
  check('forma(): se listan hasta 150 campos por objeto (antes cortaba en 60)', Object.keys(S.forma(ancho, '', 0)).length === 100);
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
