// Pruebas de «comparar» (api/_meli_comparar.js, atendida por api/meli/worker.js): contrasta lo guardado de cada orden contra
// Mercado Pago EN VIVO, con la base y Mercado Pago SIMULADOS. Lo que importa: detecta el ajuste de pago (caso Fakhar/Qahwa),
// no marca lo que coincide, SOLO hace GET a Mercado Pago/Libre y a la base (la única RPC es la de siempre para el token), no escribe NADA de negocio, respeta tope/pausa/429/cursor y no deja salir datos de personas.
//
//   node tests/meli_comparar.test.mjs
import { createRequire } from 'node:module';

process.env.MELI_RPC_SECRET = 'secreto-rpc-de-prueba-0123456789abcdef';
process.env.MELI_APP_ID = '123456';
process.env.MELI_CLIENT_SECRET = 'client-secret-de-prueba';
process.env.SUPABASE_ANON_KEY = 'anon-de-prueba';

const require = createRequire(import.meta.url);
const RAIZ = new URL('..', import.meta.url).pathname;
const worker = require(RAIZ + 'api/meli/worker.js');
const C = require(RAIZ + 'api/_meli_comparar.js');

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const resp = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
const futuro = () => new Date(Date.now() + 3600_000).toISOString();

// ── Mundo simulado ──
const PERSONALES = ['Juanita', 'Pérez', 'Siempreviva', '12345678', 'juanita@correo.com', 'jperez_nick', 'TOKEN-SECRETO'];
let guardadas, vivos, llamadas, log429;
const fila = (id, o = {}) => ({
  id, meli_order_id: String(2000000000000000 + id), estado: 'paid', procesada: true, acreditado: false, venta_id: 7,
  bruto: 55791, neto: 31967.66, cobrado_aprobado: 55791, pago_id: String(900 + id), fecha_liberacion: '2026-10-30T12:00:00Z', monto_acreditado: null,
  payload_pago: { pagos: [{ id: 900 + id, status: 'approved', transaction_amount: 55791, net_received_amount: 31967.66 }] },
  comprador: 'jperez_nick', ...o,
});
const pagoVivo = (o = {}) => ({ status: 'approved', transaction_amount: 55791, transaction_details: { net_received_amount: 31967.66 }, money_release_date: '2026-10-30T12:00:00.000-04:00',
  transaction_amount_refunded: 0, payer: { email: 'juanita@correo.com', identification: { number: '12345678' } }, ...o });
function reiniciar() {
  guardadas = []; vivos = {}; llamadas = []; log429 = null;
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    llamadas.push({ url, metodo: opts.method || 'GET', auth: (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '' });
    if (url.includes('/auth/v1/user')) return resp(200, { email: 'franco@x.com' });
    if (url.includes('/rest/v1/usuarios_autorizados')) return resp(200, [{ activo: true }]);
    if (url.includes('/rest/v1/meli_ordenes')) {
      const q = new URL(url).searchParams;
      let f = guardadas.slice();
      const cur = q.get('id'); if (cur) f = f.filter((x) => x.id > Number(String(cur).replace('gt.', '')));
      const mo = q.get('meli_order_id'); if (mo) f = f.filter((x) => x.meli_order_id === mo.replace('eq.', ''));
      return resp(200, f.sort((a, b) => a.id - b.id).slice(0, Number(q.get('limit'))));
    }
    if (url.includes('/rest/v1/rpc/')) {
      const n = url.split('/rpc/')[1];
      if (n.startsWith('meli_tokens_tomar')) return resp(200, [{ access_token: 'TOKEN-SECRETO', refresh_token: 'x', token_expira_en: futuro(), activa: true, requiere_reconexion: false, refresh_ambiguo: false, debe_refrescar: false }]);
      return resp(404, { message: 'sin simular ' + n });
    }
    const m = url.match(/\/v1\/payments\/(\d+)/);
    if (m) { if (log429 && log429(Number(m[1]))) return resp(429, {}); return vivos[m[1]] ? resp(200, vivos[m[1]]) : resp(404, { message: 'detalle Juanita Pérez' }); }
    const o = url.match(/\/orders\/(\d+)/);
    if (o) return resp(200, { id: Number(o[1]), total_amount: 55791, buyer: { nickname: 'jperez_nick' } });
    return resp(404, {});
  };
}
let nIp = 0;
async function pedir(body, { token = 'tok-usuario' } = {}) {
  const res = { code: null, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  await worker({ method: 'POST', body, headers: { 'x-crm-token': token, 'x-forwarded-for': `10.9.0.${++nIp % 250}` }, socket: {}, url: '/api/meli/worker' }, res);
  return res;
}

console.log('\n══ «Comparar»: lo guardado contra Mercado Pago en vivo (solo lectura) ══\n');

// 1. El caso real: pagos ajustados hacia arriba después de la venta
{
  reiniciar();
  guardadas = [
    fila(1, { meli_order_id: '2000018981569144', bruto: 55791, neto: 31967.66, cobrado_aprobado: 55791, pago_id: '184173189868',
              payload_pago: { pagos: [{ id: 184173189868, status: 'approved' }] } }),
    fila(2, { meli_order_id: '2000019315185954', bruto: 62690.5, neto: 38967.56, cobrado_aprobado: 62690.5, pago_id: '186494543871', fecha_liberacion: '2026-11-14T12:00:00Z',
              payload_pago: { pagos: [{ id: 186494543871, status: 'approved' }] } }),
    fila(3),                                                            // una sin cambios
  ];
  vivos['184173189868'] = pagoVivo({ transaction_amount: 61939.81, transaction_details: { net_received_amount: 38116.47 } });
  vivos['186494543871'] = pagoVivo({ transaction_amount: 67578.36, transaction_details: { net_received_amount: 43855.42 }, money_release_date: '2026-11-14T12:00:00.000-04:00' });
  vivos['903'] = pagoVivo();
  const r = await pedir({ accion: 'comparar', cuenta: 1, desde: '2026-10-01' });
  const b = r.body, t = JSON.stringify(b);
  const f = b.diferencias.find((d) => d.orden === '2000018981569144'), q = b.diferencias.find((d) => d.orden === '2000019315185954');
  check('Responde 200 y revisa las 3 órdenes: 2 con diferencia, 1 sin cambios', r.code === 200 && b.ok && b.revisadas === 3 && b.con_diferencia === 2 && b.sin_cambios === 1, t);
  check('Fakhar: cobrado +6.148,81 y neto +6.148,81 (iguales, centavo por centavo)', f && f.dif_cobrado === 6148.81 && f.dif_neto === 6148.81 && f.cobrado_vivo === 61939.81 && f.neto_vivo === 38116.47, JSON.stringify(f));
  check('Qahwa: cobrado +4.887,86 y neto +4.887,86', q && q.dif_cobrado === 4887.86 && q.dif_neto === 4887.86 && q.neto_vivo === 43855.42, JSON.stringify(q));
  check('Los motivos dicen qué cambió y el resumen trae estado de proceso', f.motivos.includes('COBRADO_DISTINTO') && f.motivos.includes('NETO_DISTINTO') && f.procesada === true && f.acreditado === false && f.tiene_venta === true, JSON.stringify(f));
  check('Termina completo y sin cursor (no había más órdenes)', b.completo === true && b.cursor === null && b.cortado === null, t);
  check('La orden sin cambios no figura en la lista', !b.diferencias.some((d) => d.orden === String(2000000000000003)));
  check('NINGÚN dato personal ni el token salen (comprador, mail, documento, apodo, mensaje de error de MP)', PERSONALES.every((p) => !t.includes(p)), PERSONALES.filter((p) => t.includes(p)).join());
  const mp = llamadas.filter((c) => /mercadopago\.com|mercadolibre\.com/.test(c.url));
  check('Todo lo que se pide a Mercado Pago/Libre es GET', mp.length === 3 && mp.every((c) => c.metodo === 'GET'), JSON.stringify(mp));
  const base = llamadas.filter((c) => c.url.includes('/rest/v1/'));
  check('A la base: la lectura de meli_ordenes es un GET con el token del USUARIO; la ÚNICA RPC es la de siempre para obtener el token de la cuenta (meli_tokens_tomar); ninguna escritura de negocio',
    base.filter((c) => c.metodo !== 'GET').every((c) => /\/rpc\/meli_tokens_tomar/.test(c.url)) && base.some((c) => c.url.includes('meli_ordenes') && c.metodo === 'GET' && c.auth === 'Bearer tok-usuario')
    && !base.some((c) => /\/rpc\/(?!meli_tokens_tomar)/.test(c.url)), JSON.stringify(base));
  check('Nunca se pide facturación, el comprador ni otra tabla', !llamadas.some((c) => /billing|\/users\/|facturas|ventas|cajas/.test(c.url)));
}

// 2. Qué cuenta como diferencia (módulo)
{
  const g = fila(10);
  const v = (o = {}) => [{ ok: true, estado: 'approved', monto: 55791, reintegrado: 0, neto: 31967.66, neto_nuevo: null, liberacion: '2026-10-30', ...o }];
  check('Igual todo → null (no se marca)', C.compararOrden(g, v()) === null);
  check('Un centavo de diferencia en el neto SÍ se marca (sin tolerancia)', C.compararOrden(g, v({ neto: 31967.67 })).dif_neto === 0.01);
  check('Ruido de coma flotante no cuenta (0,1+0,2 vs 0,3)', C.compararOrden(fila(11, { neto: 0.3, cobrado_aprobado: 0.3 }), v({ monto: 0.1 + 0.2, neto: 0.1 + 0.2 })) === null);
  check('El neto del campo NUEVO distinto (amounts.collector.net_received) se informa aparte', (() => { const d = C.compararOrden(g, v({ neto_nuevo: 38000 })); return d.motivos.join() === 'NETO_NUEVO_DISTINTO' && d.dif_neto_campo_nuevo === 6032.34 && d.dif_neto === null; })());
  check('NUMERIC como texto de la base ("31967.66") se compara bien', C.compararOrden(fila(12, { neto: '31967.66', cobrado_aprobado: '55791.00' }), v()) === null);
  check('Un pago devuelto / con reintegro se marca', C.compararOrden(g, v({ estado: 'refunded' })).motivos.includes('PAGO_NO_APROBADO') && C.compararOrden(g, v({ reintegrado: 100 })).motivos.includes('HAY_REINTEGRO'));
  check('La liberación que cambió de día se marca', C.compararOrden(g, v({ liberacion: '2026-11-05' })).motivos.includes('LIBERACION_DISTINTA'));
  check('Dos pagos aprobados: se suman (cobrado y neto)', C.compararOrden(fila(13, { neto: 100, cobrado_aprobado: 200, fecha_liberacion: null }), [{ ok: true, estado: 'approved', monto: 120, reintegrado: 0, neto: 60, neto_nuevo: null, liberacion: null }, { ok: true, estado: 'approved', monto: 80, reintegrado: 0, neto: 40, neto_nuevo: null, liberacion: null }]) === null);
  check('Un pago que no se pudo consultar se informa (no se inventa «sin cambios»)', C.compararOrden(g, [{ ok: false, inexistente: false }]).motivos.includes('PAGO_NO_CONSULTADO') && C.compararOrden(g, [{ ok: false, inexistente: true }]).motivos.includes('PAGO_INEXISTENTE'));
  check('Orden sin pagos guardados: se informa', C.compararOrden(fila(14, { pago_id: null, payload_pago: null }), []).motivos.includes('SIN_PAGOS_GUARDADOS'));
  check('idsDePago: junta los pagos leídos y los aprobados, sin repetir y solo con ids numéricos', C.idsDePago({ pago_id: '5, 6', payload_pago: { pagos: [{ id: 5 }, { id: 7 }, { id: '../x' }] } }).join() === '5,7,6');
}


// 2b. Casos que Codex marcó: zona horaria, pagos que vuelven a pendiente, datos que aparecen/desaparecen, muchos pagos, total vivo
{
  const g = fila(20);
  const v = (o = {}) => [{ ok: true, id: 920, estado: 'approved', monto: 55791, reintegrado: 0, neto: 31967.66, neto_nuevo: null, liberacion: '2026-10-30', ...o }];
  const mismoInstante = (a, b) => C.compararOrden(fila(21, { fecha_liberacion: a }), [{ ok: true, estado: 'approved', monto: 55791, reintegrado: 0, neto: 31967.66, neto_nuevo: null, liberacion: C.resumenVivo({ money_release_date: b }).liberacion }]);
  check('El MISMO instante escrito en dos zonas no da días distintos (22:00 -04:00 = 02:00Z del día siguiente)', mismoInstante('2026-10-31T02:00:00+00:00', '2026-10-30T22:00:00.000-04:00') === null);
  check('Un instante que SÍ cae en otro día de Argentina se marca (03:00Z = 00:00 del 31 AR vs 02:59Z = 23:59 del 30)', mismoInstante('2026-10-31T03:00:00Z', '2026-10-31T02:59:00Z').motivos.includes('LIBERACION_DISTINTA'));
  check('Todos los pagos vivos pasaron a pendiente: se marca (ya no es «sin cambios» aunque no haya aprobados que sumar)', (() => { const d = C.compararOrden(fila(22, { cobrado_aprobado: 200, neto: 100 }), [{ ok: true, id: 922, estado: 'pending', monto: 200, reintegrado: 0, neto: 100, neto_nuevo: null, liberacion: null }]); return d && d.motivos.includes('COBRADO_VIVO_NO_DISPONIBLE') && d.motivos.includes('NETO_VIVO_NO_DISPONIBLE') && d.motivos.includes('ESTADO_PAGO_CAMBIO'); })());
  check('El estado de un pago que cambió respecto de lo guardado se marca aunque los importes coincidan', C.compararOrden(g, v({ estado: 'in_process' })) !== null && C.compararOrden(g, v({ estado: 'in_process' })).motivos.includes('ESTADO_PAGO_CAMBIO'));
  check('Neto guardado vacío y neto vivo con dato → se marca (NETO_GUARDADO_FALTA), no «sin cambios»', C.compararOrden(fila(23, { neto: null }), v()).motivos.includes('NETO_GUARDADO_FALTA'));
  check('Cobrado guardado vacío y vivo con dato → COBRADO_GUARDADO_FALTA', C.compararOrden(fila(24, { cobrado_aprobado: null }), v()).motivos.includes('COBRADO_GUARDADO_FALTA'));
  check('Liberación que aparece (antes sin fecha) o desaparece (había y ya no) se marca', C.compararOrden(fila(25, { fecha_liberacion: null }), v()).motivos.includes('LIBERACION_APARECE') && C.compararOrden(g, v({ liberacion: null })).motivos.includes('LIBERACION_DESAPARECE'));
  check('Datos que faltan en AMBOS lados no son una diferencia (orden aún sin pago aprobado)', C.compararOrden(fila(26, { neto: null, cobrado_aprobado: null, fecha_liberacion: null, payload_pago: null, pago_id: '926' }), [{ ok: true, id: 926, estado: 'pending', monto: 1, reintegrado: 0, neto: null, neto_nuevo: null, liberacion: null }]) === null);
}
{
  reiniciar();
  const muchos = Array.from({ length: 25 }, (_, i) => ({ id: 5000 + i, status: 'approved' }));
  guardadas = [fila(1, { payload_pago: { pagos: muchos }, pago_id: '5000,5024,5100', cobrado_aprobado: 25, neto: 25 })];
  for (let i = 0; i < 25; i++) vivos[String(5000 + i)] = pagoVivo({ transaction_amount: 1, transaction_details: { net_received_amount: 1 } });
  const r = await C.comparar({ cuentaId: 1, token: 't', desde: '2026-10-01', tope: 5 }, { restante: () => 20_000 }, { dormir: async () => {}, pausaMs: 0 });
  check('Una orden con más pagos de los que se revisan NO se descarta en silencio: se revisan hasta el tope por orden y se informa PAGOS_NO_REVISADOS_TODOS', r.diferencias.length === 1 && r.diferencias[0].motivos.includes('PAGOS_NO_REVISADOS_TODOS')
    && llamadas.filter((c) => /v1\/payments/.test(c.url)).length === C.MAX_PAGOS_POR_ORDEN, JSON.stringify({ r: r.diferencias, n: llamadas.length }));
}
{
  reiniciar();
  guardadas = [fila(1, { meli_order_id: '2000018981569144', pago_id: '184173189868', payload_pago: null })];
  vivos['184173189868'] = pagoVivo();
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, o) => (/\/orders\/2000018981569144/.test(String(url)) ? resp(500, {}) : orig(url, o));
  const r = await pedir({ accion: 'comparar', cuenta: 1, orden: '2000018981569144' });
  check('Orden suelta: si falla /orders/{id} (500) NO se da por «sin cambios»: se informa TOTAL_ORDEN_NO_CONSULTADO', r.body.diferencias.length === 1 && r.body.diferencias[0].motivos.includes('TOTAL_ORDEN_NO_CONSULTADO'), JSON.stringify(r.body));
  globalThis.fetch = async (url, o) => (/\/orders\/2000018981569144/.test(String(url)) ? resp(429, {}) : orig(url, o));
  const r2 = await pedir({ accion: 'comparar', cuenta: 1, orden: '2000018981569144' });
  check('Orden suelta: un 429 en /orders/{id} corta (MELI_LIMITANDO) y no se da por completa', r2.body.cortado === 'MELI_LIMITANDO' && r2.body.completo === false && r2.body.revisadas === 0, JSON.stringify(r2.body));
}

{
  const g = fila(30, { payload_pago: { pagos: [{ id: 3001, status: 'approved' }, { id: 3002, status: 'approved' }] }, cobrado_aprobado: 2, neto: 2, fecha_liberacion: null });
  const dosPagos = (l1, l2) => [{ ok: true, id: 3001, estado: 'approved', monto: 1, reintegrado: 0, neto: 1, neto_nuevo: null, liberacion: l1 }, { ok: true, id: 3002, estado: 'approved', monto: 1, reintegrado: 0, neto: 1, neto_nuevo: null, liberacion: l2 }];
  check('Dos aprobados, uno con fecha y otro sin: la liberación de la orden es null (como en la ingesta) → sin falsa «aparece»', C.compararOrden(g, dosPagos('2026-10-30', null)) === null);
  check('Si guardada tenía fecha y a un pago se le va la fecha (el otro conserva el máximo): se marca LIBERACION_DESAPARECE (no «sin cambios»)', C.compararOrden({ ...g, fecha_liberacion: '2026-10-30T12:00:00Z' }, dosPagos('2026-10-30', null)).motivos.includes('LIBERACION_DESAPARECE'));
  check('Con todas las fechas: se toma la máxima y se compara', C.compararOrden({ ...g, fecha_liberacion: '2026-11-02T12:00:00Z' }, dosPagos('2026-10-30', '2026-11-02')) === null);
}
{
  reiniciar();
  guardadas = [fila(1), fila(2)];
  for (const i of [1, 2]) vivos[String(900 + i)] = pagoVivo();
  const e = Object.assign(new Error('se agotó el presupuesto de tiempo'), { codigo: 'SIN_TIEMPO' });
  let k = 0;
  const mpGet = async () => { if (++k === 2) throw e; return { ok: true, status: 200, json: pagoVivo() }; };   // el tiempo se agota DURANTE el pedido de la 2.ª orden
  const r = await C.comparar({ cuentaId: 1, token: 't', desde: '2026-10-01' }, { restante: () => 20_000 }, { mpGet, dormir: async () => {}, pausaMs: 0 });
  check('Si el tiempo se agota DURANTE un pedido: corta con SIN_TIEMPO, esa orden NO cuenta y el cursor queda en la anterior', r.cortado === 'SIN_TIEMPO' && r.revisadas === 1 && r.cursor === '1' && r.completo === false && r.con_error === 0, JSON.stringify({ ...r, diferencias: undefined }));
  const r1 = await C.comparar({ cuentaId: 1, token: 't', desde: '2026-10-01', tope: 1 }, { restante: () => 20_000 }, { mpGet: async () => { throw e; }, dormir: async () => {}, pausaMs: 0 });
  check('Si se agota en el ÚLTIMO (único) pedido tampoco se da la orden por revisada ni por completa', r1.revisadas === 0 && r1.completo === false && r1.cortado === 'SIN_TIEMPO' && r1.cursor === null, JSON.stringify(r1));
  const r2 = await C.comparar({ cuentaId: 1, token: 't', orden: String(2000000000000001) }, { restante: () => 20_000 }, { mpGet: async () => ({ ok: true, status: 200, json: pagoVivo() }), meliGet: async () => { throw e; }, dormir: async () => {}, pausaMs: 0 });
  check('Orden suelta: si el tiempo se agota en /orders/{id} corta con SIN_TIEMPO y no es completa', r2.cortado === 'SIN_TIEMPO' && r2.completo === false && r2.revisadas === 0, JSON.stringify(r2));
}

{
  // El vencimiento REAL con M.fetchJson: (a) pedido colgado que se aborta (AbortError), (b) se vence leyendo el CUERPO (fetchJson se traga el AbortError y
  // devuelve json:null). El presupuesto simulado arranca con tiempo de sobra (la orden SÍ empieza) y se agota recién durante el pedido (se simula el AbortError; la espera real no se reproduce para no demorar la suite).
  const M = require(RAIZ + 'api/_meli.js');
  const abortoNombre = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const original = globalThis.fetch;
  const probar = async (modoFetch, opciones) => {
    let agotado = false, pedidos = 0;
    const pres = { restante: () => (agotado ? 0 : 5000) };
    globalThis.fetch = async () => {
      pedidos++;
      if (modoFetch === 'colgado') { agotado = true; throw abortoNombre(); }
      return { ok: true, status: 200, json: async () => { agotado = true; throw abortoNombre(); } };
    };
    try {
      const deps = { mpGet: (c, ruta, p) => M.fetchJson('https://api.mercadopago.com' + ruta, {}, p), meliGet: (c, ruta, p) => M.fetchJson('https://api.mercadolibre.com' + ruta, {}, p), dormir: async () => {}, pausaMs: 0 };
      if (opciones.soloOrden) deps.mpGet = async () => ({ ok: true, status: 200, json: pagoVivo() });
      const r = await C.comparar({ cuentaId: 1, token: 't', ...opciones.op }, pres, { ...deps, leer: async () => ({ ok: true, status: 200, json: opciones.filas }) });
      return { r, pedidos };
    } finally { globalThis.fetch = original; }
  };
  for (const [modo, rotulo] of [['colgado', 'el pedido falla con AbortError al vencer'], ['cuerpo', 'se vence leyendo el cuerpo']]) {
    const { r, pedidos } = await probar(modo, { op: { desde: '2026-10-01', tope: 5 }, filas: [fila(1), fila(2)] });
    check(`Presupuesto vence DURANTE el pago (${rotulo}): el pedido SÍ se hizo, corta con SIN_TIEMPO, la orden no cuenta y el cursor no avanza (ni completo)`,
      pedidos === 1 && r.cortado === 'SIN_TIEMPO' && r.revisadas === 0 && r.completo === false && r.cursor === null && r.con_error === 0, JSON.stringify({ ...r, pedidos }));
    const o = await probar(modo, { op: { orden: String(2000000000000001) }, filas: [fila(1)], soloOrden: true });
    check(`Presupuesto vence DURANTE /orders/{id} (${rotulo}), orden suelta: el pedido SÍ se hizo, SIN_TIEMPO y no es completa`,
      o.pedidos === 1 && o.r.cortado === 'SIN_TIEMPO' && o.r.completo === false && o.r.revisadas === 0, JSON.stringify({ ...o.r, pedidos: o.pedidos }));
  }
  // un timeout PROPIO del pedido (con presupuesto de sobra) es un pago no consultado: no traba la corrida
  const colgado = abortoNombre();
  const r3 = await C.comparar({ cuentaId: 1, token: 't', desde: '2026-10-01' }, { restante: () => 20_000 }, { mpGet: async () => { throw colgado; }, leer: async () => ({ ok: true, status: 200, json: [fila(1)] }), dormir: async () => {}, pausaMs: 0 });
  check('Un timeout propio de UN pedido (con tiempo de sobra) NO corta la corrida: la orden se informa con PAGO_NO_CONSULTADO y se sigue', r3.cortado === null && r3.revisadas === 1 && r3.con_error === 1 && r3.diferencias[0].motivos.includes('PAGO_NO_CONSULTADO') && r3.completo === true, JSON.stringify(r3));
  const r4 = await C.comparar({ cuentaId: 1, token: 't', desde: '2026-10-01' }, { restante: () => 20_000 }, { mpGet: async () => ({ ok: true, status: 200, json: null }), leer: async () => ({ ok: true, status: 200, json: [fila(1)] }), dormir: async () => {}, pausaMs: 0 });
  check('Una respuesta sin cuerpo con tiempo de sobra es un pago no consultado (no corta por tiempo)', r4.cortado === null && r4.revisadas === 1 && r4.con_error === 1);
}

// 3. Tope de pagos, pausas, 429 y cursor
{
  reiniciar();
  const filas = Array.from({ length: 30 }, (_, i) => fila(i + 1, { payload_pago: { pagos: [{ id: 1001 + i * 2 }, { id: 1002 + i * 2 }] }, pago_id: '' }));
  const pausas = [];
  const dormir = async (ms) => { pausas.push(ms); };
  const pres = { restante: () => 20_000 };
  const base = { cuentaId: 1, token: 'tok-usuario', desde: '2026-10-01', tope: 40 };
  guardadas = filas;
  for (const f of filas) for (const p of f.payload_pago.pagos) vivos[p.id] = pagoVivo({ transaction_amount: 1, transaction_details: { net_received_amount: 1 } });
  // los guardados coinciden con lo vivo (monto 1 / neto 1) → sin diferencias
  guardadas = filas.map((f) => ({ ...f, neto: 2, cobrado_aprobado: 2 }));   // 2 pagos × 1 = 2
  const r1 = await C.comparar(base, pres, { dormir, pausaMs: 150 });
  check('Tope de 40 pagos por llamada: con 2 pagos por orden revisa 20 órdenes y corta con cursor', r1.ok && r1.revisadas === 20 && r1.pagos_consultados === 40 && r1.cortado === 'TOPE_DE_PAGOS' && r1.cursor === '20' && r1.completo === false, JSON.stringify({ ...r1, diferencias: undefined }));
  check('Hay una pausa entre pedidos (no entre el primero y la nada): 39 pausas de 150 ms', pausas.length === 39 && pausas.every((m) => m === 150), String(pausas.length));
  const r2 = await C.comparar({ ...base, cursor: r1.cursor }, pres, { dormir, pausaMs: 150 });
  check('Con el cursor sigue donde quedó: revisa las 10 restantes y termina', r2.revisadas === 10 && r2.completo === true && r2.cursor === null, JSON.stringify({ ...r2, diferencias: undefined }));
  check('Entre las dos llamadas no se repite ninguna orden ni se saltea ninguna (20 + 10 = 30)', r1.revisadas + r2.revisadas === 30);
}
{
  reiniciar();
  guardadas = [fila(1), fila(2), fila(3)];
  for (const i of [1, 2, 3]) vivos[String(900 + i)] = pagoVivo();
  log429 = (id) => id === 902;                                        // Mercado Pago limita en la 2.ª orden
  const r = await C.comparar({ cuentaId: 1, token: 't', desde: '2026-10-01' }, { restante: () => 20_000 }, { dormir: async () => {}, pausaMs: 0 });
  check('Ante un 429 corta (MELI_LIMITANDO), NO cuenta esa orden y el cursor apunta a la última completa', r.cortado === 'MELI_LIMITANDO' && r.revisadas === 1 && r.cursor === '1' && r.completo === false, JSON.stringify(r));
  check('No insiste después del 429: ningún pedido más a Mercado Pago', llamadas.filter((c) => /v1\/payments/.test(c.url)).length === 2);
}
{
  reiniciar();
  guardadas = [fila(1), fila(2)];
  for (const i of [1, 2]) vivos[String(900 + i)] = pagoVivo();
  let t = 20_000; const pres = { restante: () => (t -= 9000) };      // el tiempo se acaba enseguida
  const r = await C.comparar({ cuentaId: 1, token: 't', desde: '2026-10-01' }, pres, { dormir: async () => {}, pausaMs: 0 });
  check('Si se acaba el tiempo corta entre órdenes (SIN_TIEMPO) y devuelve lo hecho con cursor', r.cortado === 'SIN_TIEMPO' && r.completo === false && r.revisadas <= 1, JSON.stringify(r));
}
{
  reiniciar();
  guardadas = [fila(1)]; vivos['901'] = pagoVivo();
  const r = await C.comparar({ cuentaId: 1, token: 't', desde: '2026-10-01', tope: 1 }, { restante: () => 20_000 }, { dormir: async () => {}, pausaMs: 0 });
  check('Exactamente «tope» órdenes: pide seguir (TOPE_DE_ORDENES) y la llamada siguiente confirma que ya no hay más', r.cortado === 'TOPE_DE_ORDENES' && r.cursor === '1'
    && (await C.comparar({ cuentaId: 1, token: 't', desde: '2026-10-01', tope: 1, cursor: r.cursor }, { restante: () => 20_000 }, { dormir: async () => {}, pausaMs: 0 })).completo === true);
}

// 4. Una orden suelta: también el total vivo de la orden
{
  reiniciar();
  guardadas = [fila(1, { meli_order_id: '2000018981569144', bruto: 50000, pago_id: '184173189868', payload_pago: null })];
  vivos['184173189868'] = pagoVivo();
  const r = await pedir({ accion: 'comparar', cuenta: 1, orden: '2000018981569144' });
  check('Orden suelta con bruto guardado distinto del total vivo → TOTAL_ORDEN_DISTINTO con el total vivo', r.body.diferencias[0]?.motivos.includes('TOTAL_ORDEN_DISTINTO') && r.body.diferencias[0].total_orden_vivo === 55791, JSON.stringify(r.body));
  check('Y en esa corrida los pedidos a Mercado Libre/Pago siguen siendo GET', llamadas.filter((c) => /mercadopago|mercadolibre/.test(c.url)).every((c) => c.metodo === 'GET'));
}

// 5. Entradas inválidas y acceso
{
  reiniciar();
  const mal = async (b) => (await pedir(b));
  const a = await mal({ accion: 'comparar', cuenta: 1 });
  check('Sin «desde» ni «orden»: DESDE_INVALIDO y no consulta nada', a.body.ok === false && a.body.error === 'DESDE_INVALIDO' && !llamadas.some((c) => /meli_ordenes|payments/.test(c.url)));
  check('Fechas con basura se rechazan', (await mal({ accion: 'comparar', cuenta: 1, desde: '2026-10-01; drop' })).body.error === 'DESDE_INVALIDO' && (await mal({ accion: 'comparar', cuenta: 1, desde: '2026-10-01', hasta: 'x' })).body.error === 'HASTA_INVALIDO');
  check('Una orden o un cursor con caracteres raros se rechazan (no arman rutas ni filtros)', (await mal({ accion: 'comparar', cuenta: 1, orden: '../../users/me' })).body.error === 'ORDEN_INVALIDA' && (await mal({ accion: 'comparar', cuenta: 1, desde: '2026-10-01', cursor: '1 or 1=1' })).body.error === 'CURSOR_INVALIDO');
  check('Cuenta inválida da 400', (await mal({ accion: 'comparar', cuenta: 'abc', desde: '2026-10-01' })).code === 400 && (await mal({ accion: 'comparar', desde: '2026-10-01' })).code === 400);
  guardadas = []; llamadas.length = 0;
  const sin = await C.comparar({ cuentaId: 1, token: '', desde: '2026-10-01' }, { restante: () => 20_000 });
  check('Sin sesión: SIN_SESION, no consulta', sin.ok === false && sin.error === 'SIN_SESION' && llamadas.length === 0);
  const s401 = { code: null, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  globalThis.fetch = async (url) => (String(url).includes('/auth/v1/user') ? resp(401, {}) : resp(404, {}));
  await worker({ method: 'POST', body: { accion: 'comparar', cuenta: 1, desde: '2026-10-01' }, headers: { 'x-crm-token': 'malo', 'x-forwarded-for': '10.9.9.9' }, socket: {}, url: '/api/meli/worker' }, s401);
  check('Con un token que no es de un usuario autorizado: 401 y no se llega a comparar', s401.code === 401);
  reiniciar();
  const lec = await C.comparar({ cuentaId: 1, token: 't', desde: '2026-10-01' }, { restante: () => 20_000 }, { leer: async () => ({ ok: false, status: 401, json: null }) });
  check('Si la base no deja leer (403/401): LECTURA_401, sin tocar Mercado Pago', lec.ok === false && lec.error === 'LECTURA_401' && !llamadas.some((c) => /payments/.test(c.url)));
}

// 6. Contrato: el módulo no puede escribir (el archivo no contiene verbos de escritura)
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(RAIZ + 'api/_meli_comparar.js', 'utf8').replace(/\/\/.*$/gm, '');
  check('El módulo no llama rpc() él mismo ni usa POST/PUT/PATCH/DELETE ni inserta/actualiza (el token lo maneja M.mpGet/meliGet)', !/\brpc\(|method:\s*['"](POST|PUT|PATCH|DELETE)|\.insert\(|\.update\(|\.delete\(/i.test(src));
  check('El worker cablea la acción y no sube el número de funciones de Vercel (es un módulo _x.js)', fs.readFileSync(RAIZ + 'api/meli/worker.js', 'utf8').includes("accion === 'comparar'") && fs.existsSync(RAIZ + 'api/_meli_comparar.js'));
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exitCode = fail ? 1 : 0;
