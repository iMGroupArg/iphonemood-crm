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
// compararOrden directo: por defecto el comprador no pagó envío (receiver_cost 0); cada prueba puede pasar el suyo
const CO = (f, v, e = {}) => C.compararOrden(f, v, { receiver_cost: 0, ...e });
const resp = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
const futuro = () => new Date(Date.now() + 3600_000).toISOString();

// ── Mundo simulado ──
const PERSONALES = ['Juanita', 'Pérez', 'Siempreviva', '12345678', 'juanita@correo.com', 'jperez_nick', 'TOKEN-SECRETO'];
let guardadas, vivos, llamadas, log429, ordenesVivas, enviosVivos, costosVivos, rutasVivas;
const fila = (id, o = {}) => ({
  id, meli_order_id: String(2000000000000000 + id), estado: 'paid', procesada: true, acreditado: false, venta_id: 7,
  bruto: 55791, neto: 31967.66, cobrado_aprobado: 55791, pago_id: String(900 + id), fecha_liberacion: '2026-10-30T12:00:00Z', monto_acreditado: null,
  payload_pago: { pagos: [{ id: 900 + id, status: 'approved', transaction_amount: 55791, net_received_amount: 31967.66 }] },
  comprador: 'jperez_nick', total_orden: '55791', paid_orden: '55791', ...o,
});

const pagoVivo = (o = {}) => ({ status: 'approved', transaction_amount: 55791, transaction_details: { net_received_amount: 31967.66 }, money_release_date: '2026-10-30T12:00:00.000-04:00',
  transaction_amount_refunded: 0, payer: { email: 'juanita@correo.com', identification: { number: '12345678' } }, ...o });
function reiniciar() {
  guardadas = []; vivos = {}; llamadas = []; log429 = null; ordenesVivas = {}; enviosVivos = {}; costosVivos = {}; rutasVivas = {};
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
    const m = url.match(/\/v1\/payments\/(\d+)(\?|$)/);
    if (m) { if (log429 && log429(Number(m[1]))) return resp(429, {}); return vivos[m[1]] ? resp(200, vivos[m[1]]) : resp(404, { message: 'detalle Juanita Pérez' }); }
    const ruta = url.replace(/^https:\/\/api\.(mercadolibre|mercadopago)\.com/, '');
    if (rutasVivas[ruta]) return resp(200, rutasVivas[ruta]);
    if (/^\/orders\/\d+\/|\/v1\/payments\/\d+\/refunds/.test(ruta)) return resp(404, { message: 'no existe' });
    const c = url.match(/\/shipments\/(\d+)\/costs/);
    if (c) return costosVivos[c[1]] ? resp(200, costosVivos[c[1]]) : resp(404, {});
    const e = url.match(/\/shipments\/(\d+)$/);
    if (e) return enviosVivos[e[1]] ? resp(200, enviosVivos[e[1]]) : resp(404, {});
    const o = url.match(/\/orders\/(\d+)/);
    if (o) return resp(200, ordenesVivas[o[1]] || { id: Number(o[1]), total_amount: 55791, buyer: { nickname: 'jperez_nick' } });
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
  check('Igual todo → null (no se marca)', CO(g, v()) === null);
  check('Un centavo de diferencia en el neto SÍ se marca (sin tolerancia)', CO(g, v({ neto: 31967.67 })).dif_neto === 0.01);
  check('Ruido de coma flotante no cuenta (0,1+0,2 vs 0,3)', CO(fila(11, { neto: 0.3, cobrado_aprobado: 0.3 }), v({ monto: 0.1 + 0.2, neto: 0.1 + 0.2 })) === null);
  check('El neto del campo NUEVO distinto (amounts.collector.net_received) se informa aparte', (() => { const d = CO(g, v({ neto_nuevo: 38000 })); return d.motivos.join() === 'NETO_NUEVO_DISTINTO' && d.dif_neto_campo_nuevo === 6032.34 && d.dif_neto === null; })());
  check('NUMERIC como texto de la base ("31967.66") se compara bien', CO(fila(12, { neto: '31967.66', cobrado_aprobado: '55791.00' }), v()) === null);
  check('Un pago devuelto / con reintegro se marca', CO(g, v({ estado: 'refunded' })).motivos.includes('PAGO_NO_APROBADO') && CO(g, v({ reintegrado: 100 })).motivos.includes('HAY_REINTEGRO'));
  check('La liberación que cambió de día se marca', CO(g, v({ liberacion: '2026-11-05' })).motivos.includes('LIBERACION_DISTINTA'));
  check('Dos pagos aprobados: se suman (cobrado y neto)', CO(fila(13, { neto: 100, cobrado_aprobado: 200, fecha_liberacion: null }), [{ ok: true, estado: 'approved', monto: 120, reintegrado: 0, neto: 60, neto_nuevo: null, liberacion: null }, { ok: true, estado: 'approved', monto: 80, reintegrado: 0, neto: 40, neto_nuevo: null, liberacion: null }]) === null);
  check('Un pago que no se pudo consultar se informa (no se inventa «sin cambios»)', CO(g, [{ ok: false, inexistente: false }]).motivos.includes('PAGO_NO_CONSULTADO') && CO(g, [{ ok: false, inexistente: true }]).motivos.includes('PAGO_INEXISTENTE'));
  check('Orden sin pagos guardados: se informa', CO(fila(14, { pago_id: null, payload_pago: null }), []).motivos.includes('SIN_PAGOS_GUARDADOS'));
  check('idsDePago: junta los pagos leídos y los aprobados, sin repetir y solo con ids numéricos', C.idsDePago({ pago_id: '5, 6', payload_pago: { pagos: [{ id: 5 }, { id: 7 }, { id: '../x' }] } }).join() === '5,7,6');
}


// 2b. Casos que Codex marcó: zona horaria, pagos que vuelven a pendiente, datos que aparecen/desaparecen, muchos pagos, total vivo
{
  const g = fila(20);
  const v = (o = {}) => [{ ok: true, id: 920, estado: 'approved', monto: 55791, reintegrado: 0, neto: 31967.66, neto_nuevo: null, liberacion: '2026-10-30', ...o }];
  const mismoInstante = (a, b) => CO(fila(21, { fecha_liberacion: a }), [{ ok: true, estado: 'approved', monto: 55791, reintegrado: 0, neto: 31967.66, neto_nuevo: null, liberacion: C.resumenVivo({ money_release_date: b }).liberacion }]);
  check('El MISMO instante escrito en dos zonas no da días distintos (22:00 -04:00 = 02:00Z del día siguiente)', mismoInstante('2026-10-31T02:00:00+00:00', '2026-10-30T22:00:00.000-04:00') === null);
  check('Un instante que SÍ cae en otro día de Argentina se marca (03:00Z = 00:00 del 31 AR vs 02:59Z = 23:59 del 30)', mismoInstante('2026-10-31T03:00:00Z', '2026-10-31T02:59:00Z').motivos.includes('LIBERACION_DISTINTA'));
  check('Todos los pagos vivos pasaron a pendiente: se marca (ya no es «sin cambios» aunque no haya aprobados que sumar)', (() => { const d = CO(fila(22, { cobrado_aprobado: 200, neto: 100 }), [{ ok: true, id: 922, estado: 'pending', monto: 200, reintegrado: 0, neto: 100, neto_nuevo: null, liberacion: null }]); return d && d.motivos.includes('COBRADO_VIVO_NO_DISPONIBLE') && d.motivos.includes('NETO_VIVO_NO_DISPONIBLE') && d.motivos.includes('ESTADO_PAGO_CAMBIO'); })());
  check('El estado de un pago que cambió respecto de lo guardado se marca aunque los importes coincidan', CO(g, v({ estado: 'in_process' })) !== null && CO(g, v({ estado: 'in_process' })).motivos.includes('ESTADO_PAGO_CAMBIO'));
  check('Neto guardado vacío y neto vivo con dato → se marca (NETO_GUARDADO_FALTA), no «sin cambios»', CO(fila(23, { neto: null }), v()).motivos.includes('NETO_GUARDADO_FALTA'));
  check('Cobrado guardado vacío y vivo con dato → COBRADO_GUARDADO_FALTA', CO(fila(24, { cobrado_aprobado: null }), v()).motivos.includes('COBRADO_GUARDADO_FALTA'));
  check('Liberación que aparece (antes sin fecha) o desaparece (había y ya no) se marca', CO(fila(25, { fecha_liberacion: null }), v()).motivos.includes('LIBERACION_APARECE') && CO(g, v({ liberacion: null })).motivos.includes('LIBERACION_DESAPARECE'));
  check('Datos que faltan en AMBOS lados no son una diferencia (orden aún sin pago aprobado)', CO(fila(26, { neto: null, cobrado_aprobado: null, fecha_liberacion: null, payload_pago: null, pago_id: '926' }), [{ ok: true, id: 926, estado: 'pending', monto: 1, reintegrado: 0, neto: null, neto_nuevo: null, liberacion: null }]) === null);
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
  check('Dos aprobados, uno con fecha y otro sin: la liberación de la orden es null (como en la ingesta) → sin falsa «aparece»', CO(g, dosPagos('2026-10-30', null)) === null);
  check('Si guardada tenía fecha y a un pago se le va la fecha (el otro conserva el máximo): se marca LIBERACION_DESAPARECE (no «sin cambios»)', CO({ ...g, fecha_liberacion: '2026-10-30T12:00:00Z' }, dosPagos('2026-10-30', null)).motivos.includes('LIBERACION_DESAPARECE'));
  check('Con todas las fechas: se toma la máxima y se compara', CO({ ...g, fecha_liberacion: '2026-11-02T12:00:00Z' }, dosPagos('2026-10-30', '2026-11-02')) === null);
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


// 7. DESGLOSE de una orden: todos los montos con su fuente, y las fuentes que coinciden con la diferencia buscada
{
  reiniciar();
  const ID = '2000018981569144';
  guardadas = [fila(1, { meli_order_id: ID, bruto: 55791, neto: 31967.66, cobrado_aprobado: 55791, pago_id: '184173189868', payload_pago: { pagos: [{ id: 184173189868, status: 'approved' }] }, paid_orden: '55791', total_orden: '55791' })];
  ordenesVivas[ID] = { id: Number(ID), status: 'paid', total_amount: 55791, paid_amount: 61939.81, buyer: { nickname: 'jperez_nick', first_name: 'Juanita' },
    order_items: [{ item: { id: 'MLA1', title: 'Perfume' }, quantity: 1, unit_price: 55791, sale_fee: 8000 }],
    payments: [{ id: 184173189868, status: 'approved', transaction_amount: 55791, total_paid_amount: 61939.81, shipping_cost: 6148.81, overpaid_amount: 0, taxes_amount: 0, coupon_amount: 0 }], shipping: { id: 48258555523 } };
  vivos['184173189868'] = pagoVivo({ transaction_amount: 55791, shipping_amount: 6148.81, coupon_amount: 0, transaction_details: { net_received_amount: 31967.66, total_paid_amount: 61939.81 }, amounts: { collector: { net_received: 38116.47 } },
    charges_details: [{ name: 'mercadopago_fee', type: 'fee', amounts: { original: 2500.5 } }, { name: 'Juanita cobro', type: 'fee', amounts: { original: 1 } }], fee_details: [{ type: 'mercadopago_fee', amount: 2500.5, fee_payer: 'collector' }], date_approved: '2026-10-10T10:00:00.000-04:00' });
  enviosVivos['48258555523'] = { id: 48258555523, status: 'delivered', substatus: 'delivered', logistic_type: 'self_service', receiver_address: { receiver_name: 'Juanita Pérez', address_line: 'Av. Siempreviva 742' }, tracking_number: 'ABC123456', shipping_option: { cost: 6148.81 } };
  costosVivos['48258555523'] = { gross_amount: 12297.62, senders: [{ cost: 6148.81, compensation: 0, discount: { rate: 0.5 } }], receiver: { cost: 6148.81, save: 0 }, 'Juanita': { x: 1 } };
  const r = await pedir({ accion: 'desglose', cuenta: 1, orden: ID, buscar: 6148.81 });
  const b = r.body, t = JSON.stringify(b);
  check('Desglose: responde 200 con la orden, el pago y el envío', r.code === 200 && b.ok && b.orden_viva && b.pagos_vivos.length === 1 && b.envio, t.slice(0, 300));
  check('Orden viva: total 55.791, pagó 61.939,81 → el comprador pagó de más 6.148,81, y el pago de la orden trae shipping_cost', b.orden_viva.total_amount === 55791 && b.orden_viva.paid_amount === 61939.81 && b.orden_viva.pagos[0].shipping_cost === 6148.81);
  check('Pago vivo: transaction_amount 55.791, total_paid_amount 61.939,81, shipping_amount 6.148,81, neto del campo viejo 31.967,66 y del nuevo 38.116,47', (() => { const p = b.pagos_vivos[0]; return p.transaction_amount === 55791 && p.total_paid_amount === 61939.81 && p.shipping_amount === 6148.81 && p.net_received_amount === 31967.66 && p.net_received_collector === 38116.47; })());
  check('Envío: tipo logístico y TODOS los números del costo (receptor y emisor, anidados)', b.envio.tipo_logistico === 'self_service' && b.envio.costos.receptor.cost === 6148.81 && b.envio.costos.emisores[0]['discount.rate'] === 0.5 && b.envio.costos.gross_amount === 12297.62);
  check('Los cargos del pago salen por tipo y nombre; un nombre que no es de cargo sale como <otro>', b.pagos_vivos[0].cargos_por_tipo_y_nombre['fee:mercadopago_fee'] === 2500.5 && b.pagos_vivos[0].cargos_por_tipo_y_nombre['fee:<otro>'] === 1);
  check('Fuentes que COINCIDEN con 6.148,81 (lo buscado): paid−total, shipping_cost, total_paid−transaction, shipping_amount, costo del envío, receptor.cost, emisor.cost…',
    ['orden: paid_amount − total_amount', 'orden.pagos[184173189868].shipping_cost', 'pago[184173189868].shipping_amount', 'envio/costos.receptor.cost'].every((f) => b.coincidencias.includes(f)), JSON.stringify(b.coincidencias));
  check('El neto del campo nuevo menos el del viejo también aparece como candidato (6.148,81)', b.candidatos.some((c) => c.fuente.includes('neto(campo nuevo)') && c.monto === 6148.81 && c.coincide));
  check('Lo guardado se informa al lado (neto, cobrado, paid y total guardados)', b.guardado.neto === 31967.66 && b.guardado.cobrado_aprobado === 55791 && b.guardado.paid_orden_guardado === 55791 && b.guardado.total_orden_guardado === 55791);
  check('NINGÚN dato personal (nombre, dirección, seguimiento, apodo, mail, documento) ni el token', PERSONALES.concat(['ABC123456', 'Av. Siempreviva']).every((p) => !t.includes(p)), PERSONALES.filter((p) => t.includes(p)).join());
  const mp = llamadas.filter((c) => /mercadopago\.com|mercadolibre\.com/.test(c.url));
  check('Solo GET, y a lo sumo orden + pagos + envío + costos (4 pedidos aquí)', mp.length === 4 && mp.every((c) => c.metodo === 'GET'), JSON.stringify(mp.map((c) => c.url)));
  const sin = await pedir({ accion: 'desglose', cuenta: 1, orden: ID });
  check('Sin «buscar» no marca coincidencias pero igual lista los candidatos', sin.body.coincidencias.length === 0 && sin.body.candidatos.length > 0);
  check('Entradas inválidas: orden con caracteres raros, monto buscado no numérico', (await pedir({ accion: 'desglose', cuenta: 1, orden: '../x' })).body.error === 'ORDEN_INVALIDA' && (await pedir({ accion: 'desglose', cuenta: 1, orden: ID, buscar: 'abc' })).body.error === 'BUSCAR_INVALIDO');
  check('Una orden que no existe en la base: ORDEN_NO_ENCONTRADA y no se consulta Mercado Pago', (await (async () => { llamadas.length = 0; const x = await pedir({ accion: 'desglose', cuenta: 1, orden: '2000000000000999' }); return x.body.error === 'ORDEN_NO_ENCONTRADA' && !llamadas.some((c) => /mercadopago|mercadolibre/.test(c.url)); })()));
}
{
  reiniciar();
  const ID = '2000018981569144';
  guardadas = [fila(1, { meli_order_id: ID, pago_id: '184173189868', payload_pago: null })];
  vivos['184173189868'] = pagoVivo();
  ordenesVivas[ID] = { id: Number(ID), total_amount: 55791, paid_amount: 55791, payments: [{ id: 184173189868 }], shipping: { id: 48258555523 } };
  costosVivos['48258555523'] = { gross_amount: 100 };
  // el envío no existe (404) y los costos sí: se informa el error y se sigue con lo demás
  const r = await pedir({ accion: 'desglose', cuenta: 1, orden: ID });
  check('Si un recurso falla (el envío da 404) se informa en errores y el resto del desglose sale igual', r.body.ok && r.body.errores.includes('envio:HTTP_404') && r.body.envio.costos.gross_amount === 100 && r.body.pagos_vivos.length === 1, JSON.stringify(r.body.errores));
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, o) => (/\/v1\/payments\//.test(String(url)) ? resp(429, {}) : orig(url, o));
  const r2 = await pedir({ accion: 'desglose', cuenta: 1, orden: ID });
  globalThis.fetch = orig;
  check('Un 429 deja el desglose marcado como INCOMPLETO (no se da por completo)', r2.body.incompleto === true && r2.body.errores.some((x) => /MELI_LIMITANDO/.test(x)));
}
{
  // 8. Orden con el comprador pagando de MÁS (según lo guardado): aparece en la lista aunque el pago vivo coincida
  reiniciar();
  guardadas = [fila(1, { paid_orden: '61939.81', total_orden: '55791' })];
  vivos['901'] = pagoVivo();
  const r = await pedir({ accion: 'comparar', cuenta: 1, desde: '2026-10-01' });
  const d = r.body.diferencias[0];
  check('Comparar: una orden donde el comprador pagó de más (paid 61.939,81 vs total 55.791) se marca EXTRA_PAGADO_POR_EL_COMPRADOR con el importe', d && d.motivos.includes('EXTRA_PAGADO_POR_EL_COMPRADOR') && d.extra_pagado_por_el_comprador === 6148.81, JSON.stringify(r.body));
  check('Y una orden con paid = total no se marca por eso', CO(fila(40, { paid_orden: '55791', total_orden: '55791' }), [{ ok: true, id: 940, estado: 'approved', monto: 55791, reintegrado: 0, neto: 31967.66, neto_nuevo: null, liberacion: '2026-10-30' }]) === null);
}


// 9. Rastreo de montos: ¿en qué recurso aparece el neto real (38.116,47) o el extra (6.148,81)? + recursos exploratorios
{
  reiniciar();
  const ID = '2000018981569144';
  guardadas = [fila(1, { meli_order_id: ID, pago_id: '184173189868', payload_pago: null })];
  ordenesVivas[ID] = { id: Number(ID), total_amount: 55791, paid_amount: 55791, payments: [{ id: 184173189868, status: 'approved' }], shipping: { id: 48258555523 } };
  vivos['184173189868'] = pagoVivo({ transaction_details: { net_received_amount: 31967.66 }, amounts: { collector: { net_received: 38116.47 } }, payer: { identification: { number: '12345678' } } });
  costosVivos['48258555523'] = { gross_amount: 12297.62, senders: [{ cost: 6148.81 }], receiver: { cost: 0 } };
  rutasVivas['/orders/' + ID + '/discounts'] = { details: [{ items: [{ amount: 6148.81 }] }], 'Juanita': 'x' };
  const r = await pedir({ accion: 'desglose', cuenta: 1, orden: ID, buscar: [38116.47, 6148.81], explorar: true });
  const b = r.body, t = JSON.stringify(b);
  const h = (rec, ruta) => b.hallazgos.find((x) => x.recurso.includes(rec) && x.ruta === ruta);
  check('Rastreo: encuentra 38.116,47 en el pago, en el campo amounts.collector.net_received', h('184173189868', 'amounts.collector.net_received') && h('184173189868', 'amounts.collector.net_received').buscado === 38116.47, JSON.stringify(b.hallazgos));
  check('Rastreo: encuentra 6.148,81 en el costo del envío (senders[0].cost) y en un recurso exploratorio (discounts)', h('envio_costos', 'senders[0].cost') && b.hallazgos.some((x) => x.recurso.includes('/discounts') && x.ruta === 'details[0].items[0].amount'), JSON.stringify(b.hallazgos));
  check('Rastreo: solo salen rutas y el valor buscado (nada más del JSON); ningún dato personal', PERSONALES.concat(['12345678']).every((p) => !t.includes(p)));
  check('Exploratorios: los que existen se marcan leídos y los que dan 404 se informan sin romper', b.explorados.some((x) => x.ruta.endsWith('/discounts') && x.leido) && b.explorados.some((x) => x.ruta.endsWith('/shipments') && !x.leido) && b.errores.some((x) => x.includes('/refunds') && x.includes('HTTP_404')));
  check('Todo sigue siendo GET y las rutas exploratorias son fijas (discounts, shipments, refunds): nada de facturación ni del comprador', llamadas.filter((c) => /mercadopago|mercadolibre/.test(c.url)).every((c) => c.metodo === 'GET') && !llamadas.some((c) => /billing|\/users\/|buyer/i.test(c.url)));
  const sin = await pedir({ accion: 'desglose', cuenta: 1, orden: ID, buscar: [38116.47] });
  check('Sin «explorar» NO se piden los recursos exploratorios', sin.body.explorados.length === 0 && !llamadas.slice(-8).some((c) => /discounts|refunds/.test(c.url)));
  check('Hasta 5 montos a buscar; uno no numérico se rechaza', (await pedir({ accion: 'desglose', cuenta: 1, orden: ID, buscar: [1, 'x'] })).body.error === 'BUSCAR_INVALIDO');
  check('hallar(): coincide en centavos con texto numérico y con el signo cambiado; no devuelve nada si no hay objetivos coincidentes', (() => { const x = C.hallar({ a: '6148.81', b: [{ c: -6148.81 }], d: 6148.82 }, [6148.81]); return x.length === 2 && x[0].ruta === 'a' && x[1].ruta === 'b[0].c'; })());
}


// 10. LO QUE LLEGA = REGLA VERIFICADA contra el «Total» del cobro en el panel de Mercado Libre:
//     llega_real = Σ net_received_amount + máx(0, receiver.cost del envío − Σ shipping_amount de los pagos aprobados)
{
  reiniciar();
  guardadas = [
    fila(1, { meli_order_id: '2000018981569144', bruto: 55791, neto: 31967.66, cobrado_aprobado: 55791, pago_id: '184173189868', payload_pago: null, envio_id: '48258555523' }),
    fila(2, { meli_order_id: '2000019315185954', bruto: 62690.5, neto: 38967.56, cobrado_aprobado: 62690.5, pago_id: '186494543871', payload_pago: null, fecha_liberacion: '2026-12-01T12:00:00Z', envio_id: '48416791041' }),
  ];
  // Fakhar y Qahwa: el pago NO trae el envío (shipping_amount 0): el comprador lo pagó aparte y Mercado Libre lo suma al «Total»
  vivos['184173189868'] = pagoVivo({ transaction_amount: 55791, shipping_amount: 0, transaction_details: { net_received_amount: 31967.66 } });
  vivos['186494543871'] = pagoVivo({ transaction_amount: 62690.5, shipping_amount: 0, transaction_details: { net_received_amount: 38967.56 }, money_release_date: '2026-11-14T12:00:00.000-04:00' });
  costosVivos['48258555523'] = { gross_amount: 12297.62, senders: [{ cost: 6148.81 }], receiver: { cost: 6148.81, save: 0 }, 'Juanita': { x: 1 } };
  costosVivos['48416791041'] = { gross_amount: 9775.72, senders: [{ cost: 4887.86 }], receiver: { cost: 4887.86 } };
  const r = await pedir({ accion: 'comparar', cuenta: 1, desde: '2026-10-01' });
  const f = r.body.diferencias.find((d) => d.orden === '2000018981569144'), q = r.body.diferencias.find((d) => d.orden === '2000019315185954');
  check('Fakhar: llega real 38.116,47 = neto 31.967,66 + envío del comprador 6.148,81 (receiver.cost, shipping_amount 0); diferencia +6.148,81', f && f.envio_pagado_por_el_comprador === 6148.81 && f.costo_envio_comprador === 6148.81 && f.llega_real_vivo === 38116.47 && f.dif_llega_real === 6148.81, JSON.stringify(f));
  check('Qahwa: llega real 43.855,42 = 38.967,56 + 4.887,86; diferencia +4.887,86', q && q.llega_real_vivo === 43855.42 && q.dif_llega_real === 4887.86, JSON.stringify(q));
  check('Costo de canal: Fakhar 23.823,34 guardado → 17.674,53 real; Qahwa 23.722,94 → 18.835,08', f.costo_canal_guardado === 23823.34 && f.costo_canal_real === 17674.53 && q.costo_canal_guardado === 23722.94 && q.costo_canal_real === 18835.08, JSON.stringify({ f: [f.costo_canal_guardado, f.costo_canal_real], q: [q.costo_canal_guardado, q.costo_canal_real] }));
  check('Motivos: envío pagado por el comprador + llega real distinto (el neto NO cambió → sin NETO_DISTINTO); Qahwa además la liberación', f.motivos.includes('ENVIO_PAGADO_POR_EL_COMPRADOR') && f.motivos.includes('LLEGA_REAL_DISTINTO') && !f.motivos.includes('NETO_DISTINTO') && q.motivos.includes('LIBERACION_DISTINTA'), JSON.stringify(q.motivos));
  check('Cada orden con envío cuesta UN pedido más (el costo del envío): 2 órdenes × (1 pago + 1 costo) = 4 consultas', r.body.pagos_consultados === 4 && llamadas.filter((l) => /\/shipments\/\d+\/costs/.test(l.url)).length === 2, String(r.body.pagos_consultados));
  check('Ni nombres ni otros datos personales salen (el receptor trae una clave con un nombre: no sale)', !PERSONALES.some((p) => JSON.stringify(r.body).includes(p)));

  // Si el envío ya venía cobrado DENTRO del pago (shipping_amount = receiver.cost), net_received_amount ya lo incluye: crédito 0
  reiniciar();
  guardadas = [fila(1, { neto: 40000, envio_id: '500', pago_id: '901', payload_pago: null }), fila(2, { neto: 40000, envio_id: '501', pago_id: '902', payload_pago: null }), fila(3, { neto: 40000, envio_id: '502', pago_id: '903', payload_pago: null })];
  vivos['901'] = pagoVivo({ shipping_amount: 7990, transaction_details: { net_received_amount: 40000 } });
  vivos['902'] = pagoVivo({ shipping_amount: 7990, transaction_details: { net_received_amount: 40000 } });
  vivos['903'] = pagoVivo({ shipping_amount: 5000, transaction_details: { net_received_amount: 40000 } });
  costosVivos['500'] = { receiver: { cost: 7990 } }; costosVivos['501'] = { receiver: { cost: 7990 } }; costosVivos['502'] = { receiver: { cost: 6000 } };
  const r2_ = await pedir({ accion: 'comparar', cuenta: 1, desde: '2026-10-01' });
  const x3 = r2_.body.diferencias.find((d) => d.orden.endsWith('3'));
  check('Envío ya incluido en el pago (shipping_amount 7.990 = receiver.cost 7.990): crédito 0, llega = neto, sin diferencia (2 órdenes sin cambios)', r2_.body.sin_cambios === 2 && r2_.body.diferencias.length === 1, JSON.stringify(r2_.body));
  check('Parte del envío dentro del pago (5.000 de 6.000): el crédito es la diferencia, máx(0, 6.000 − 5.000) = 1.000', x3 && x3.envio_pagado_por_el_comprador === 1000 && x3.llega_real_vivo === 41000 && x3.dif_llega_real === 1000, JSON.stringify(x3));
  check('Crédito nunca negativo: shipping_amount mayor que receiver.cost → 0', C.creditoEnvioComprador([{ envio_comprador: 9000 }], 7000).credito === 0);

  // Flex: $499 exactos de crédito = bonificación que se acredita aparte; NO suma a lo que llega ni es diferencia
  reiniciar();
  guardadas = [fila(1, { neto: 20000, envio_id: '600', pago_id: '911', payload_pago: null }), fila(2, { neto: 20000, envio_id: '601', pago_id: '912', payload_pago: null })];
  vivos['911'] = pagoVivo({ shipping_amount: 0, transaction_details: { net_received_amount: 20000 } });
  vivos['912'] = pagoVivo({ shipping_amount: 0, transaction_details: { net_received_amount: 20000 } });
  costosVivos['600'] = { receiver: { cost: 499 } }; costosVivos['601'] = { receiver: { cost: 499 } };
  const rf = await pedir({ accion: 'comparar', cuenta: 1, desde: '2026-10-01' });
  check('Flex +499: no es diferencia en lo que llega (sin cambios) y se informa aparte con su total y las órdenes', rf.body.sin_cambios === 2 && rf.body.diferencias.length === 0 && rf.body.bonificaciones_flex.total === 998 && rf.body.bonificaciones_flex.ordenes === 2 && rf.body.bonificaciones_flex.lista[0].monto === 499, JSON.stringify(rf.body));
  const df = CO(fila(60, { neto: 20000 }), [{ ok: true, id: 1, estado: 'approved', monto: 1, envio_comprador: 0, reintegrado: 0, neto: 19000, neto_nuevo: null, liberacion: '2026-10-30' }], { receiver_cost: 499 });
  check('Flex con otra diferencia real (neto cambió): la orden figura y lleva bonificacion_flex 499 con llega = neto', df && df.bonificacion_flex === 499 && df.llega_real_vivo === 19000 && df.motivos.includes('NETO_DISTINTO'), JSON.stringify(df));

  // 46 órdenes que coinciden con el panel: todas +0 (mezcla de «sin envío», «envío dentro del pago» y «receiver 0»)
  reiniciar();
  guardadas = []; const regalo = [];
  for (let i = 1; i <= 46; i++) {
    const cfg = i % 3;          // 0: sin envío en la orden · 1: envío dentro del pago · 2: receiver.cost 0 (envío gratis)
    guardadas.push(fila(i, { neto: 30000 + i, envio_id: cfg === 0 ? null : String(700 + i), pago_id: String(1000 + i), payload_pago: null }));
    vivos[String(1000 + i)] = pagoVivo({ shipping_amount: cfg === 1 ? 3000 : 0, transaction_details: { net_received_amount: 30000 + i } });
    if (cfg === 1) costosVivos[String(700 + i)] = { receiver: { cost: 3000 } }; else if (cfg === 2) costosVivos[String(700 + i)] = { receiver: { cost: 0 } };
    regalo.push(i);
  }
  let cur = null, tot = { rev: 0, dif: 0, sc: 0 }, vueltas = 0;
  for (;;) {
    const rr = await pedir({ accion: 'comparar', cuenta: 1, desde: '2026-10-01', ...(cur ? { cursor: cur } : {}) });
    tot.rev += rr.body.revisadas; tot.dif += rr.body.con_diferencia; tot.sc += rr.body.sin_cambios; vueltas++;
    if (rr.body.completo || vueltas > 10) break;
    cur = rr.body.cursor;
  }
  check('46 órdenes que coinciden con el panel: todas «sin cambios» (+0), ninguna diferencia', tot.rev === 46 && tot.sc === 46 && tot.dif === 0, JSON.stringify(tot));

  // Si receiver.cost NO se pudo leer: la orden queda incompleta; NO se afirma llega real ni diferencia
  reiniciar();
  guardadas = [fila(1, { neto: 20000, envio_id: '800', pago_id: '921', payload_pago: null }), fila(2, { neto: 20000, envio_id: '801', pago_id: '922', payload_pago: null })];
  vivos['921'] = pagoVivo({ shipping_amount: 0, transaction_details: { net_received_amount: 20000 } });
  vivos['922'] = pagoVivo({ shipping_amount: 0, transaction_details: { net_received_amount: 20000 } });
  costosVivos['801'] = { gross_amount: 5 };          // el envío 800 da 404; el 801 no trae «receiver»
  const rn = await pedir({ accion: 'comparar', cuenta: 1, desde: '2026-10-01' });
  check('receiver.cost no leído (404 o sin receiver): llega_real null, motivo ENVIO_COSTOS_NO_CONSULTADOS y sin diferencia afirmada', rn.body.diferencias.length === 2 && rn.body.diferencias.every((d) => d.llega_real_vivo === null && d.dif_llega_real === null && d.motivos.includes('ENVIO_COSTOS_NO_CONSULTADOS')), JSON.stringify(rn.body.diferencias));
  // un 429 en el costo del envío corta y la orden no cuenta
  reiniciar();
  guardadas = [fila(1, { neto: 20000, envio_id: '810', pago_id: '931', payload_pago: null })];
  vivos['931'] = pagoVivo({ shipping_amount: 0, transaction_details: { net_received_amount: 20000 } });
  const f0 = globalThis.fetch; globalThis.fetch = async (u, o) => (/\/shipments\/810\/costs/.test(String(u)) ? resp(429, {}) : f0(u, o));
  const r429 = await pedir({ accion: 'comparar', cuenta: 1, desde: '2026-10-01' });
  globalThis.fetch = f0;
  check('429 al pedir el costo del envío: corta con MELI_LIMITANDO y la orden NO cuenta como revisada', r429.body.cortado === 'MELI_LIMITANDO' && r429.body.revisadas === 0 && r429.body.completo === false, JSON.stringify(r429.body));

  // La diferencia verificada no tiene excepciones por envío, y sin envío nada cambia
  const ok1 = CO(fila(50, { neto: 38116.47, cobrado_aprobado: 55791, bruto: 55791 }), [{ ok: true, id: 950, estado: 'approved', monto: 55791, envio_comprador: 0, reintegrado: 0, neto: 31967.66, neto_nuevo: null, liberacion: '2026-10-30' }], { receiver_cost: 6148.81 });
  check('Si lo guardado ya incluye el envío (38.116,47): llega real coincide → NO se marca LLEGA_REAL_DISTINTO, pero el neto del pago (31.967,66) sí difiere → NETO_DISTINTO', ok1 && ok1.motivos.includes('NETO_DISTINTO') && ok1.dif_neto === -6148.81 && ok1.dif_llega_real === null, JSON.stringify(ok1));
  check('Sin envío (receiver_cost 0) llega real = neto', (() => { const d = CO(fila(51, { neto: 100 }), [{ ok: true, id: 951, estado: 'approved', monto: 55791, envio_comprador: null, reintegrado: 0, neto: 90, neto_nuevo: null, liberacion: '2026-10-30' }], { receiver_cost: 0 }); return d.llega_real_vivo === 90 && d.envio_pagado_por_el_comprador === null && d.motivos.includes('NETO_DISTINTO'); })());
  check('Con receiver_cost > 0 y shipping_amount ausente en un pago aprobado NO se afirma (null)', C.creditoEnvioComprador([{ envio_comprador: null }], 500) === null);

  // desglose: resumen con la regla
  reiniciar();
  guardadas = [fila(2, { meli_order_id: '2000019315185954', bruto: 62690.5, neto: 38967.56, cobrado_aprobado: 62690.5, pago_id: '186494543871', payload_pago: null, fecha_liberacion: '2026-12-01T12:00:00Z', envio_id: '48416791041' })];
  vivos['186494543871'] = pagoVivo({ transaction_amount: 62690.5, shipping_amount: 0, transaction_details: { net_received_amount: 38967.56 } });
  const ID = '2000019315185954';
  ordenesVivas[ID] = { id: Number(ID), total_amount: 62690.5, paid_amount: 67578.36, payments: [{ id: 186494543871, status: 'approved', transaction_amount: 62690.5, shipping_cost: 4887.86 }], shipping: { id: 48416791041 } };
  costosVivos['48416791041'] = { gross_amount: 9775.72, senders: [{ cost: 4887.86 }], receiver: { cost: 4887.86 } };
  const d = await pedir({ accion: 'desglose', cuenta: 1, orden: ID, buscar: [4887.86, 43855.42] });
  check('Desglose: resumen «llega real» = 38.967,56 + 4.887,86 = 43.855,42 (regla verificada) y costo de canal real 18.835,08', d.body.resumen && d.body.resumen.llega_real === 43855.42 && d.body.resumen.costo_envio_comprador === 4887.86 && d.body.resumen.costo_canal_real === 18835.08 && d.body.resumen.costo_canal_guardado === 23722.94 && d.body.coincidencias.includes('envio/costos.receptor.cost'), JSON.stringify({ r: d.body.resumen, c: d.body.coincidencias }));
  check('Desglose: el 43.855,42 aparece en los hallazgos solo si algún recurso lo trae (aquí ninguno → ningún hallazgo con ese valor)', !d.body.hallazgos.some((h) => h.buscado === 43855.42));
  delete costosVivos['48416791041'];
  const d2 = await pedir({ accion: 'desglose', cuenta: 1, orden: ID });
  check('Desglose: si receiver.cost no se pudo leer NO hay resumen («llega real» no se afirma) y se informa', d2.body.resumen === null && d2.body.errores.includes('resumen:COSTO_ENVIO_NO_LEIDO'), JSON.stringify({ r: d2.body.resumen, e: d2.body.errores }));
  ordenesVivas[ID].shipping = { id: 48416791041 }; costosVivos['48416791041'] = { receiver: { cost: 499 } };
  const d3 = await pedir({ accion: 'desglose', cuenta: 1, orden: ID });
  check('Desglose Flex ($499): bonificacion_flex aparte y llega real = neto', d3.body.resumen && d3.body.resumen.bonificacion_flex === 499 && d3.body.resumen.llega_real === 38967.56, JSON.stringify(d3.body.resumen));
}

// 10c. Revisión de Codex: envío no guardado, shipping_amount ausente, cobertura del aprobado
{
  reiniciar();
  // (1) orden guardada SIN envío en lo guardado pero la orden suelta VIVA tiene envío: se lee su costo (no se da por «sin envío»)
  const ID = '2000000000009001';
  guardadas = [fila(1, { meli_order_id: ID, neto: 20000, pago_id: '951', payload_pago: null, envio_id: null })];
  vivos['951'] = pagoVivo({ shipping_amount: 0, transaction_details: { net_received_amount: 20000 } });
  ordenesVivas[ID] = { id: Number(ID), total_amount: 55791, paid_amount: 55791, payments: [{ id: 951 }], shipping: { id: 9100 } };
  costosVivos['9100'] = { receiver: { cost: 1234.5 } };
  const rs = await pedir({ accion: 'comparar', cuenta: 1, desde: '2026-10-01', orden: ID });
  const ds = rs.body.diferencias[0];
  check('Orden suelta con envío vivo y no guardado: se consulta su costo y se afirma llega real = 20.000 + 1.234,50', ds && ds.llega_real_vivo === 21234.5 && ds.dif_llega_real === 1234.5 && rs.body.pagos_consultados === 2 && llamadas.some((l) => /\/shipments\/9100\/costs/.test(l.url)), JSON.stringify(rs.body));
  // (1b) sin payload_orden guardado (ni total) el envío es DESCONOCIDO: no se afirma «sin envío»
  reiniciar();
  guardadas = [fila(1, { neto: 20000, pago_id: '952', payload_pago: null, envio_id: null, total_orden: null, paid_orden: null })];
  vivos['952'] = pagoVivo({ shipping_amount: 0, transaction_details: { net_received_amount: 20000 } });
  const rd = await pedir({ accion: 'comparar', cuenta: 1, desde: '2026-10-01' });
  check('Sin la orden guardada (ni envío ni total): la orden NO queda «sin cambios»; llega real sin afirmar y motivo ENVIO_COSTOS_NO_CONSULTADOS', rd.body.sin_cambios === 0 && rd.body.diferencias[0].llega_real_vivo === null && rd.body.diferencias[0].motivos.includes('ENVIO_COSTOS_NO_CONSULTADOS'), JSON.stringify(rd.body.diferencias));
  // (3) receiver.cost > 0 y shipping_amount ausente en un aprobado: no se puede calcular → no es «sin cambios»
  const d3 = CO(fila(80, { neto: 100, cobrado_aprobado: 1000, bruto: 1000 }), [{ ok: true, id: 980, estado: 'approved', monto: 1000, envio_comprador: null, reintegrado: 0, neto: 100, neto_nuevo: null, liberacion: '2026-10-30' }], { receiver_cost: 600 });
  check('receiver.cost 600 y shipping_amount ausente: la orden queda marcada LLEGA_REAL_NO_CALCULABLE (no «sin cambios») y no afirma llega real', d3 && d3.motivos.includes('LLEGA_REAL_NO_CALCULABLE') && d3.llega_real_vivo === null && d3.dif_llega_real === null, JSON.stringify(d3));
  // (4) un aprobado PARCIAL no tapa el rechazo
  const pgx = (id, estado, monto) => ({ ok: true, id, estado, monto, envio_comprador: 0, reintegrado: 0, neto: monto * 0.9, neto_nuevo: null, liberacion: '2026-10-30' });
  const d4 = CO(fila(81, { neto: 90, cobrado_aprobado: 100, bruto: 1000 }), [pgx(1, 'rejected', 900), pgx(2, 'approved', 100)]);
  check('rejected + approved que NO cubre el bruto (100 de 1.000): se sigue marcando PAGO_NO_APROBADO', d4 && d4.motivos.includes('PAGO_NO_APROBADO'), JSON.stringify(d4));
  const d4b = CO(fila(82, { neto: 900, cobrado_aprobado: 1000, bruto: 1000 }), [pgx(1, 'rejected', 1000), pgx(2, 'approved', 1000)]);
  check('rejected + approved que cubre el bruto: no se marca', d4b === null || !d4b.motivos.includes('PAGO_NO_APROBADO'), JSON.stringify(d4b));
}

// 10d. Orden suelta con el total leído bien: NO es «TOTAL_ORDEN_NO_CONSULTADO» (con envío guardado, o sin envío vivo)
{
  for (const [titulo, envioGuardado, envioVivo] of [['envío guardado y vivo', '9200', { id: 9200 }], ['sin envío ni guardado ni vivo', null, null]]) {
    reiniciar();
    const ID = '2000000000009100';
    guardadas = [fila(1, { meli_order_id: ID, neto: 20000, pago_id: '961', payload_pago: null, envio_id: envioGuardado })];
    vivos['961'] = pagoVivo({ shipping_amount: 0, transaction_details: { net_received_amount: 20000 } });
    ordenesVivas[ID] = { id: Number(ID), total_amount: 55791, paid_amount: 55791, payments: [{ id: 961 }], shipping: envioVivo };
    if (envioGuardado) costosVivos[envioGuardado] = { receiver: { cost: 0 } };
    const rr = await pedir({ accion: 'comparar', cuenta: 1, desde: '2026-10-01', orden: ID });
    check(`Orden suelta, total leído bien (${titulo}): queda «sin cambios», sin TOTAL_ORDEN_NO_CONSULTADO`, rr.body.sin_cambios === 1 && rr.body.diferencias.length === 0, JSON.stringify(rr.body));
  }
}

// 10b. PAGO_NO_APROBADO: un intento rechazado seguido de otro aprobado que cubre la orden NO es problema (falso positivo real)
{
  const pg = (id, estado, extra = {}) => ({ ok: true, id, estado, monto: 1000, envio_comprador: 0, reintegrado: 0, neto: 900, neto_nuevo: null, liberacion: '2026-10-30', ...extra });
  const base = (vivosX) => CO(fila(70, { neto: 900, cobrado_aprobado: 1000, bruto: 1000 }), vivosX, { receiver_cost: 0 });
  check('rejected + approved (neto vivo = guardado): NO se marca PAGO_NO_APROBADO', base([pg(1, 'rejected'), pg(2, 'approved')]) === null || !base([pg(1, 'rejected'), pg(2, 'approved')]).motivos.includes('PAGO_NO_APROBADO'), JSON.stringify(base([pg(1, 'rejected'), pg(2, 'approved')])));
  const solo = base([pg(1, 'refunded')]);
  check('Un único pago devuelto (orden cancelada): SÍ se marca PAGO_NO_APROBADO', solo && solo.motivos.includes('PAGO_NO_APROBADO'), JSON.stringify(solo));
  const soloRech = base([pg(1, 'rejected')]);
  check('Solo rechazado, sin ningún aprobado que cubra la orden: SÍ se marca', soloRech && soloRech.motivos.includes('PAGO_NO_APROBADO'), JSON.stringify(soloRech));
  const mixto = base([pg(1, 'approved'), pg(2, 'refunded')]);
  check('approved + refunded: SÍ se marca (un devuelto nunca se ignora)', mixto && mixto.motivos.includes('PAGO_NO_APROBADO'), JSON.stringify(mixto));
  const cancel = base([pg(1, 'cancelled'), pg(2, 'approved')]);
  check('cancelled + approved: se sigue marcando (solo se ignoran los rechazados)', cancel && cancel.motivos.includes('PAGO_NO_APROBADO'), JSON.stringify(cancel));
}


// 11. RETENCIONES (Ingresos Brutos «por falta de alta» por provincia): parte NORMAL del costo de canal, se muestran separadas y NO marcan diferencia
{
  reiniciar();
  guardadas = [fila(1, { meli_order_id: '2000018981569144' }), fila(2, { meli_order_id: '2000019315185954' }), fila(3)];
  const cargos = (iibb, n) => [{ type: 'tax', name: n, amounts: { original: iibb } }, { type: 'fee', name: 'mercadopago_fee', amounts: { original: 100 } }, { type: 'tax', name: 'Juanita cobro', amounts: { original: 5 } }];
  vivos['901'] = pagoVivo({ charges_details: cargos(836.87, 'tax_iibb-santa-cruz') });
  vivos['902'] = pagoVivo({ charges_details: cargos(940.36, 'tax_iibb-neuquen') });
  vivos['903'] = pagoVivo({ charges_details: [] });
  const r = await pedir({ accion: 'comparar', cuenta: 1, desde: '2026-10-01' });
  const ret = r.body.retenciones;
  check('Las retenciones se suman POR NOMBRE de cargo (provincia) sobre TODAS las órdenes revisadas, con total y cantidad de órdenes con retención', ret && ret.por_cargo['tax_iibb-santa-cruz'] === 836.87 && ret.por_cargo['tax_iibb-neuquen'] === 940.36 && ret.ordenes_con_retencion === 2 && ret.total === 1787.23, JSON.stringify(ret));
  check('Un cargo cuyo nombre no es de vocabulario de cargos (un nombre de persona) sale como <otro>, no con su texto', ret.por_cargo['<otro>'] === 10 && !JSON.stringify(r.body).includes('Juanita'));
  check('La retención NO marca la orden como «con diferencia» (es costo de canal normal): las 3 coinciden', r.body.con_diferencia === 0 && r.body.sin_cambios === 3 && r.body.diferencias.length === 0, JSON.stringify(r.body.con_diferencia));
  check('Los cargos que no son impuestos (mercadopago_fee) no cuentan como retención', !('fee:mercadopago_fee' in ret.por_cargo) && !('mercadopago_fee' in ret.por_cargo));
  const ID = '2000018981569144';
  ordenesVivas[ID] = { id: Number(ID), total_amount: 55791, paid_amount: 55791, payments: [{ id: 901 }], shipping: null };
  const d = await pedir({ accion: 'desglose', cuenta: 1, orden: ID });
  check('Desglose: retenciones separadas por cargo de esa orden', d.body.retenciones['tax_iibb-santa-cruz'] === 836.87, JSON.stringify(d.body.retenciones));
}
{
  reiniciar();
  guardadas = [fila(1)];
  vivos['901'] = pagoVivo({ status: 'pending', charges_details: [{ type: 'tax', name: 'tax_iibb-neuquen', amounts: { original: 50 } }] });
  const r = await pedir({ accion: 'comparar', cuenta: 1, desde: '2026-10-01' });
  check('Un pago pendiente (no aprobado) no suma retenciones', r.body.retenciones.total === 0 && r.body.retenciones.ordenes_con_retencion === 0);
}


// 12. Correcciones de Codex: identificadores fuera de las hojas numéricas, neto del campo nuevo con envío, vocabulario fiscal
{
  check('hojasNumericas: solo campos que son MONTOS; user_id, teléfono, código postal, número, lat/lon NO salen', (() => { const h = C.hojasNumericas({ cost: 10, save: 2, user_id: 123456789, phone: 1155550101, zip_code: 2000, tracking_number: 5551, latitude: -32.9, discount: { rate: 0.5, id: 77 }, receiver_id: 9 }); return Object.keys(h).sort().join() === 'cost,discount.rate,save'; })());
  const g = fila(60, { neto: 110, cobrado_aprobado: 1000, bruto: 1000, fecha_liberacion: null });
  const d = CO(g, [{ ok: true, id: 960, estado: 'approved', monto: 1000, envio_comprador: 0, reintegrado: 0, neto: 100, neto_nuevo: 100, liberacion: null }], { receiver_cost: 10 });
  check('Guardado 110 con net_received_amount vivo 100 y crédito de envío 10 (llega = 110 = guardado): el cambio del NETO (−10) SE VE igual (NETO_DISTINTO), aunque lo que llega no difiera', d && d.motivos.includes('NETO_DISTINTO') && d.dif_neto === -10 && d.dif_llega_real === null, JSON.stringify(d));
  const d2 = CO(fila(61, { neto: 100, cobrado_aprobado: 1000, bruto: 1000, fecha_liberacion: null }), [{ ok: true, id: 961, estado: 'approved', monto: 1000, envio_comprador: 10, reintegrado: 0, neto: 100, neto_nuevo: 95, liberacion: null }]);
  check('Pero un neto del campo nuevo que de verdad no coincide con nada SÍ se marca', d2 && d2.motivos.includes('NETO_NUEVO_DISTINTO'), JSON.stringify(d2));
  reiniciar();
  guardadas = [fila(1)];
  vivos['901'] = pagoVivo({ charges_details: [{ type: 'fee', name: 'impuesto_provincial', amounts: { original: 33 } }, { type: 'tax', name: 'impuesto-municipal.2', amounts: { original: 7 } }] });
  const r = await pedir({ accion: 'comparar', cuenta: 1, desde: '2026-10-01' });
  check('Vocabulario fiscal unificado: «impuesto_provincial» (aunque no sea tipo tax) y nombres con guion/punto/dígito suman como retención', r.body.retenciones.por_cargo.impuesto_provincial === 33 && r.body.retenciones.por_cargo['impuesto-municipal.2'] === 7, JSON.stringify(r.body.retenciones));
}


// 13. Desglose: el resumen «llega real» solo con TODOS los pagos; retenciones solo de pagos aprobados
{
  reiniciar();
  const ID = '2000018981569144';
  guardadas = [fila(1, { meli_order_id: ID, bruto: 1000, neto: 400, pago_id: '601,602', payload_pago: null })];
  ordenesVivas[ID] = { id: Number(ID), total_amount: 1000, paid_amount: 1000, payments: [{ id: 601 }, { id: 602 }], shipping: null };
  vivos['601'] = pagoVivo({ transaction_amount: 500, transaction_details: { net_received_amount: 420 } });
  // el pago 602 no existe en Mercado Pago (404)
  const r = await pedir({ accion: 'desglose', cuenta: 1, orden: ID });
  check('Si un pago de la orden no se pudo leer, NO se emite «llega real» ni costo de canal (una suma parcial parecería el total) y se avisa', r.body.resumen === null && r.body.errores.includes('resumen:PAGOS_INCOMPLETOS') && r.body.errores.some((x) => x.includes('pago_602')), JSON.stringify({ r: r.body.resumen, e: r.body.errores }));
  vivos['602'] = pagoVivo({ transaction_amount: 500, transaction_details: { net_received_amount: 400 }, shipping_amount: 20 });
  const ok2 = await pedir({ accion: 'desglose', cuenta: 1, orden: ID });
  check('Con los dos pagos leídos sí: llega real = 420 + 400 = 820 (orden sin envío: shipping_amount 20 ya va dentro del pago, crédito 0) y costo de canal 1000 − 820 = 180', ok2.body.resumen && ok2.body.resumen.llega_real === 820 && ok2.body.resumen.costo_canal_real === 180, JSON.stringify(ok2.body.resumen));
  vivos['602'] = pagoVivo({ status: 'rejected', transaction_amount: 500, transaction_details: { net_received_amount: 400 }, charges_details: [{ type: 'tax', name: 'tax_iibb-neuquen', amounts: { original: 99 } }] });
  vivos['601'] = pagoVivo({ transaction_amount: 500, transaction_details: { net_received_amount: 420 }, charges_details: [{ type: 'tax', name: 'tax_iibb-neuquen', amounts: { original: 10 } }] });
  const ret = await pedir({ accion: 'desglose', cuenta: 1, orden: ID });
  check('Retenciones del desglose: solo de pagos APROBADOS (el rechazado con 99 no suma): igual que comparar', ret.body.retenciones['tax_iibb-neuquen'] === 10, JSON.stringify(ret.body.retenciones));
}


// 14. Totales solo con TODOS los pagos (comparar y desglose)
{
  const dosPagos = (v2) => [{ ok: true, id: 701, estado: 'approved', monto: 500, envio_comprador: 0, reintegrado: 0, neto: 400, neto_nuevo: null, liberacion: null }, v2];
  const g = fila(70, { neto: 800, cobrado_aprobado: 1000, bruto: 1000, fecha_liberacion: null, payload_pago: { pagos: [{ id: 701, status: 'approved' }, { id: 702, status: 'approved' }] } });
  const d = CO(g, dosPagos({ ok: false, id: 702, inexistente: false }));
  check('comparar: con un pago sin leer NO hay «llega real», diferencia ni costo de canal (una suma parcial parecería el total); solo PAGO_NO_CONSULTADO', d && d.motivos.join() === 'PAGO_NO_CONSULTADO' && d.llega_real_vivo === null && d.dif_llega_real === null && d.dif_neto === null && d.costo_canal_real === null && d.neto_vivo === null && d.cobrado_vivo === null, JSON.stringify(d));
  const d2 = CO(g, dosPagos({ ok: true, id: 702, estado: 'approved', monto: 500, envio_comprador: 0, reintegrado: 0, neto: 400, neto_nuevo: null, liberacion: null }));
  check('…y con los dos pagos leídos el mismo caso da 800 = 800: sin diferencia', d2 === null);
  const d3 = CO(g, dosPagos({ ok: true, id: 702, estado: 'approved', monto: 500, envio_comprador: 0, reintegrado: 0, neto: 400, neto_nuevo: null, liberacion: null }).map((x) => x), { truncado: true });
  check('Con más pagos de los que se revisan (truncado): tampoco se afirma ningún total', d3 && d3.llega_real_vivo === null && d3.motivos.includes('PAGOS_NO_REVISADOS_TODOS') && d3.costo_canal_real === null, JSON.stringify(d3));
  reiniciar();
  const ID = '2000018981569144';
  guardadas = [fila(1, { meli_order_id: ID, bruto: 2000, neto: 640, pago_id: '801', payload_pago: null })];
  ordenesVivas[ID] = { id: Number(ID), total_amount: 2000, paid_amount: 2000, payments: Array.from({ length: 25 }, (_, i) => ({ id: 800 + i + 1 })), shipping: null };
  for (let i = 1; i <= 25; i++) vivos[String(800 + i)] = pagoVivo({ transaction_amount: 80, transaction_details: { net_received_amount: 80 } });
  const r = await pedir({ accion: 'desglose', cuenta: 1, orden: ID });
  check('Desglose: una orden con 25 pagos (más del tope de 20; solo 1 guardado) NO emite llega real parcial: resumen null y se avisa PAGOS_INCOMPLETOS', r.body.resumen === null && r.body.errores.includes('resumen:PAGOS_INCOMPLETOS') && r.body.retenciones_incompletas === true, JSON.stringify({ r: r.body.resumen, e: r.body.errores }));
  reiniciar();
  guardadas = [fila(1, { meli_order_id: ID, bruto: 1000, neto: 400, pago_id: '601', payload_pago: null })];
  vivos['601'] = pagoVivo({ transaction_amount: 500, transaction_details: { net_received_amount: 400 } });
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, o) => (new RegExp('/orders/' + ID + '$').test(String(url)) ? resp(500, {}) : orig(url, o));
  const r2 = await pedir({ accion: 'desglose', cuenta: 1, orden: ID });
  globalThis.fetch = orig;
  check('Desglose: si /orders/{id} falla (no se pueden descubrir pagos nuevos) NO se emite el resumen aunque los pagos guardados respondan', r2.body.resumen === null && r2.body.errores.includes('orden:HTTP_500') && r2.body.errores.includes('resumen:PAGOS_INCOMPLETOS'), JSON.stringify(r2.body.errores));
}


// 15. Ronda 4: hallar() sin valores ni identificadores; retenciones incompletas; envío parcial
{
  const x = C.hallar({ payer: { identification: { number: 12345678 } }, amounts: { collector: { net_received: 38116.47 } }, phone_number: 38116.47, extra: [{ total_amount: 38116.47 }] }, [12345678, 38116.47]);
  check('hallar(): devuelve solo la RUTA y a qué monto buscado corresponde (sin el valor del JSON) y nunca un campo identificador (documento, teléfono)', x.length === 2 && x.every((h) => !('valor' in h)) && x.some((h) => h.ruta === 'amounts.collector.net_received') && x.some((h) => h.ruta === 'extra[0].total_amount') && !x.some((h) => /identification|phone/.test(h.ruta)), JSON.stringify(x));
  reiniciar();
  guardadas = [fila(1, { pago_id: '701,702', payload_pago: null }), fila(2, { pago_id: '703', payload_pago: null })];
  vivos['701'] = pagoVivo({ charges_details: [{ type: 'tax', name: 'tax_iibb-neuquen', amounts: { original: 50 } }], shipping_amount: 20 });
  // el pago 702 no existe → la orden 1 no se pudo leer completa
  vivos['703'] = pagoVivo({ charges_details: [{ type: 'tax', name: 'tax_iibb-neuquen', amounts: { original: 7 } }] });
  const r = await pedir({ accion: 'comparar', cuenta: 1, desde: '2026-10-01' });
  const ret = r.body.retenciones;
  check('Las retenciones de una orden con un pago sin leer NO se suman (parcial) y se cuenta como incompleta: el total no se presenta como completo', ret.por_cargo['tax_iibb-neuquen'] === 7 && ret.total === 7 && ret.incompletas === 1 && ret.ordenes_con_retencion === 1, JSON.stringify(ret));
  const d = r.body.diferencias.find((x) => x.motivos.includes('PAGO_INEXISTENTE'));
  check('Y esa orden no expone totales parciales: ni llega real, ni envío del comprador (20), ni costo de canal', d && d.llega_real_vivo === null && d.envio_pagado_por_el_comprador === null && d.costo_canal_real === null, JSON.stringify(d));
}


// 16. Ronda 5: pagos con demasiados cargos no se presentan como completos
{
  reiniciar();
  guardadas = [fila(1)];
  vivos['901'] = pagoVivo({ charges_details: Array.from({ length: 101 }, () => ({ type: 'tax', name: 'tax_iibb-neuquen', amounts: { original: 1 } })) });
  const r = await pedir({ accion: 'comparar', cuenta: 1, desde: '2026-10-01' });
  check('Un pago con más de 100 cargos NO suma una retención parcial: se cuenta como orden incompleta (y como error de lectura)', r.body.retenciones.total === 0 && r.body.retenciones.incompletas === 1 && r.body.con_error === 1, JSON.stringify(r.body.retenciones));
  guardadas = [fila(1)];
  vivos['901'] = pagoVivo({ charges_details: Array.from({ length: 100 }, () => ({ type: 'tax', name: 'tax_iibb-neuquen', amounts: { original: 1 } })) });
  const r2 = await pedir({ accion: 'comparar', cuenta: 1, desde: '2026-10-01' });
  check('Con exactamente 100 cargos sí es completa y suma los 100', r2.body.retenciones.total === 100 && r2.body.retenciones.incompletas === 0);
}


// 17. Ronda 6: el desglose y las retenciones usan el MISMO límite de cargos
{
  reiniciar();
  const ID = '2000018981569144';
  guardadas = [fila(1, { meli_order_id: ID, pago_id: '901', payload_pago: null })];
  ordenesVivas[ID] = { id: Number(ID), total_amount: 55791, paid_amount: 55791, payments: [{ id: 901 }], shipping: null };
  vivos['901'] = pagoVivo({ charges_details: Array.from({ length: 60 }, (_, i) => ({ type: 'fee', name: 'mercadopago_fee', amounts: { original: 1 } })).concat([{ type: 'tax', name: 'tax_iibb-neuquen', amounts: { original: 5 } }]) });
  const r = await pedir({ accion: 'desglose', cuenta: 1, orden: ID });
  check('Desglose con 61 cargos (entre 31 y 100): se listan TODOS (el cargo 61 también) y coincide con lo que suma comparar', r.body.pagos_vivos[0].cargos_por_tipo_y_nombre['fee:mercadopago_fee'] === 60 && r.body.pagos_vivos[0].cargos_por_tipo_y_nombre['tax:tax_iibb-neuquen'] === 5 && r.body.retenciones['tax_iibb-neuquen'] === 5 && r.body.resumen !== null, JSON.stringify(r.body.pagos_vivos[0].cargos_por_tipo_y_nombre));
  vivos['901'] = pagoVivo({ charges_details: Array.from({ length: 101 }, () => ({ type: 'fee', name: 'mercadopago_fee', amounts: { original: 1 } })) });
  const r2 = await pedir({ accion: 'desglose', cuenta: 1, orden: ID });
  check('Con más de 100 cargos el desglose NO emite el resumen (cargos truncados) y lo avisa', r2.body.resumen === null && r2.body.pagos_vivos[0].cargos_truncados === true && r2.body.errores.includes('resumen:PAGOS_INCOMPLETOS'));
}


// 20. URGENTE: para investigar PAGO_NO_APROBADO y HAY_REINTEGRO sin abrir cada orden
{
  reiniciar();
  guardadas = [fila(1, { meli_order_id: '2000000000000013' }), fila(2, { meli_order_id: '2000000000000014' })];
  vivos['901'] = pagoVivo({ status: 'refunded', status_detail: 'refunded', transaction_amount_refunded: 55791 });
  vivos['902'] = pagoVivo({ status: 'approved', status_detail: 'accredited', transaction_amount_refunded: 1500 });
  const r = await pedir({ accion: 'comparar', cuenta: 1, desde: '2026-10-01' });
  const a = r.body.diferencias.find((d) => d.orden === '2000000000000013'), b = r.body.diferencias.find((d) => d.orden === '2000000000000014');
  check('Un pago devuelto: PAGO_NO_APROBADO con el estado, el detalle y lo reintegrado por pago (id, estado, detalle, monto, reintegrado)', a.motivos.includes('PAGO_NO_APROBADO') && a.reintegrado_vivo === 55791 && JSON.stringify(a.pagos_vivos_resumen) === JSON.stringify([{ id: '901', estado: 'refunded', detalle_estado: 'refunded', monto: 55791, reintegrado: 55791 }]), JSON.stringify(a));
  check('Un pago aprobado con un reintegro parcial: HAY_REINTEGRO con el monto reintegrado (1.500) y su estado', b.motivos.includes('HAY_REINTEGRO') && !b.motivos.includes('PAGO_NO_APROBADO') && b.reintegrado_vivo === 1500 && b.pagos_vivos_resumen[0].estado === 'approved' && b.pagos_vivos_resumen[0].detalle_estado === 'accredited', JSON.stringify(b));
  check('Solo números y códigos: ningún dato personal en esos campos', !JSON.stringify(r.body).includes('Juanita') && !JSON.stringify(r.body).includes('juanita@correo.com'));
}


// 21. La diferencia verificada depende SOLO del net_received_amount (no de la estimación ni del campo nuevo)
{
  const g = fila(90, { neto: 1000, cobrado_aprobado: 1000, bruto: 1000, fecha_liberacion: null });
  const v = (o = {}) => [{ ok: true, id: 990, estado: 'approved', monto: 1000, envio_comprador: 0, reintegrado: 0, neto: 1000, neto_nuevo: null, liberacion: null, ...o }];
  const a = CO(g, v({ neto: 900, envio_comprador: 100 }));
  check('Guardado 1.000, neto vivo 900, envío 100 (la estimación daría 1.000): el cambio verificado de −100 NO se oculta', a && a.dif_neto === -100 && a.motivos.includes('NETO_DISTINTO'), JSON.stringify(a));
  const b = CO(g, v({ neto_nuevo: 800 }));
  check('Si el net_received_amount no cambió pero el «campo nuevo» sí: se informa aparte (NETO_NUEVO_DISTINTO, dif_neto_campo_nuevo) y dif_neto queda vacío', b && b.dif_neto === null && b.dif_neto_campo_nuevo === -200 && b.motivos.includes('NETO_NUEVO_DISTINTO') && !b.motivos.includes('NETO_DISTINTO'), JSON.stringify(b));
  check('reintegrado_vivo solo con lectura COMPLETA: con un pago caído o sin dato no hay subtotal', (() => {
    const r1 = CO(g, [{ ok: true, id: 1, estado: 'approved', monto: 500, envio_comprador: 0, reintegrado: 1500, neto: 500, neto_nuevo: null, liberacion: null }, { ok: false, id: 2 }]);
    const r2 = CO(g, [{ ok: true, id: 1, estado: 'approved', monto: 500, envio_comprador: 0, reintegrado: 1500, neto: 500, neto_nuevo: null, liberacion: null }, { ok: true, id: 2, estado: 'approved', monto: 500, envio_comprador: 0, reintegrado: 250, neto: 500, neto_nuevo: null, liberacion: null }]);
    return r1.reintegrado_vivo === null && r1.lectura_completa === false && r2.reintegrado_vivo === 1750 && r2.lectura_completa === true;
  })());
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
