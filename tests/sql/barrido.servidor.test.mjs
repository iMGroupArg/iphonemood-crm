// Prueba del módulo del servidor (api/_meli_barrido.js + el worker) contra la BASE REAL (pglite, con los scripts 3, 7, 4 y 10)
// y un Mercado Libre SIMULADO que hace lo que hace la búsqueda real: filtra por fechas, pagina con límite y offset, e informa
// `paging.total`. Así lo que se prueba es la combinación de verdad: el JavaScript y las funciones SQL juntos.
//
//   cd tests/sql && node barrido.servidor.test.mjs
import { createRequire } from 'node:module';
import { SQL, SECRETO, baseNueva } from './lib/base_meli.mjs';

process.env.MELI_RPC_SECRET = SECRETO;
process.env.MELI_APP_ID = '123456';
process.env.MELI_CLIENT_SECRET = 'client-secret-de-prueba';
process.env.SUPABASE_ANON_KEY = 'anon-de-prueba';
process.env.CRON_SECRET = 'cron-de-prueba';

const require = createRequire(import.meta.url);
const RAIZ = new URL('../../', import.meta.url).pathname;
const B = require(RAIZ + 'api/_meli_barrido.js');
const M = require(RAIZ + 'api/_meli.js');
const worker = require(RAIZ + 'api/meli/worker.js');

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const resp = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

// ── Mundo simulado ─────────────────────────────────────────────────────
let db = null, cuentaId = null;
const mundo = { ordenes: [], modo: 'normal', llamadas: [], alBuscar: null, status: 200, quitarUna: false };
const TABLAS = new Set(['meli_cuenta_info', 'meli_barrido_cuentas', 'meli_tokens_tomar']);

async function puenteRpc(nombre, args) {
  if (nombre === 'meli_tokens_tomar') return [{ access_token: 'T', refresh_token: 'r', token_expira_en: new Date(Date.now() + 3600e3).toISOString(), activa: true, requiere_reconexion: false, refresh_ambiguo: false, debe_refrescar: false, lease_id: null, generacion: 1 }];
  const claves = Object.keys(args);
  const lista = claves.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const valores = claves.map((k) => (args[k] !== null && typeof args[k] === 'object') ? JSON.stringify(args[k]) : args[k]);
  const sql = TABLAS.has(nombre) ? `SELECT * FROM public.${nombre}(${lista})` : `SELECT public.${nombre}(${lista}) AS r`;
  const { rows } = await db.query(sql, valores);
  return TABLAS.has(nombre) ? rows : rows[0].r;
}

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.includes('/rest/v1/rpc/')) {
    const nombre = url.split('/rpc/')[1];
    try { return resp(200, await puenteRpc(nombre, JSON.parse(opts.body))); }
    catch (e) { return resp(400, { message: String(e.message) }); }
  }
  if (url.startsWith('https://api.mercadolibre.com/orders/search')) {
    const u = new URL(url);
    mundo.llamadas.push(u);
    if (mundo.alBuscar) await mundo.alBuscar(u);
    if (mundo.status !== 200) return resp(mundo.status, { message: 'detalle interno' });
    const desde = Date.parse(u.searchParams.get('order.date_last_updated.from'));
    const hasta = Date.parse(u.searchParams.get('order.date_last_updated.to'));
    const lim = Number(u.searchParams.get('limit')), off = Number(u.searchParams.get('offset') || 0);
    let lista = mundo.ordenes.filter((o) => Date.parse(o.last_updated) >= desde && (mundo.modo === 'sinHasta' || Date.parse(o.last_updated) <= hasta))
      .sort((a, b) => Date.parse(a.last_updated) - Date.parse(b.last_updated));
    const total = lista.length;
    let pagina = lista.slice(off, off + lim);
    if (mundo.quitarUna && pagina.length) pagina = pagina.slice(1);
    if (mundo.duplicar && pagina.length > 1) pagina = [pagina[0], pagina[0], ...pagina.slice(2)];          // un id repetido: el conteo coincide pero falta una orden
    if (mundo.invalida && pagina.length) pagina = [{ ...pagina[0], id: 'no-es-un-id' }, ...pagina.slice(1)];          // la búsqueda "pierde" una orden: el total no coincide
    return resp(200, { paging: { total, offset: off, limit: lim }, results: pagina.map((o) => ({ id: Number(o.id), last_updated: o.last_updated, status: 'paid', buyer: { nickname: 'dato_personal' } })) });
  }
  return resp(404, {});
};

// Lo cubierto NO se movió: sigue en el punto de partida de la prueba (hace ~1 h).
const sinMover = (e) => Math.abs(Date.now() - new Date(e.cubierto_hasta) - 3600e3) < 60000;
const hace = (h) => new Date(Date.now() - h * 3600e3).toISOString();
async function reiniciar({ conectadaHaceDias = 5, cubiertoHaceH = null } = {}) {
  ({ db, cuentaId } = await baseNueva());
  await db.query(`UPDATE public.meli_cuentas SET refresh_token='r', access_token='a', creado_en = now() - make_interval(days => $2) WHERE id=$1`, [cuentaId, conectadaHaceDias]);
  await db.exec(SQL('meli_barrido.sql'));
  if (cubiertoHaceH !== null) await db.query(`INSERT INTO public.meli_barrido_estado (cuenta_id, cubierto_hasta) VALUES ($1, now() - make_interval(hours => $2))`, [cuentaId, cubiertoHaceH]);
  Object.assign(mundo, { ordenes: [], modo: 'normal', llamadas: [], alBuscar: null, status: 200, quitarUna: false, duplicar: false, invalida: false });
}
const presUnico = (ms = 20000) => M.presupuestoHasta(Date.now() + ms - 3000, Date.now() + ms);
const correr = (extra = {}) => B.barrer({ cuentaId, origen: 'boton', usuario: 'franco@x.com', ...extra }, presUnico(), M.presupuestoHasta(Date.now() + 20000));
const estado = async () => (await db.query(`SELECT * FROM public.meli_barrido_estado WHERE cuenta_id=$1`, [cuentaId])).rows[0];
const pendientes = async () => (await db.query(`SELECT recurso FROM public.meli_notificaciones WHERE estado='pendiente' ORDER BY recurso`)).rows.map((r) => r.recurso);
const meliOrden = (id, h) => ({ id: String(id), last_updated: hace(h) });
const ordenEnCrm = (ref, lu) => db.query(`INSERT INTO public.meli_ordenes (cuenta_id, meli_order_id, estado, comprador, fecha_orden, moneda, bruto, neto, meli_last_updated, financiera_completa) VALUES ($1,$2,'paid','c', now(),'ARS',1000,800,$3,true)`, [cuentaId, String(ref), lu]);

console.log('\n══ Barrido: servidor + base real + Mercado Libre simulado ══\n');

// ── 1 · El caso Lattafa: MELI tiene una venta que el CRM no tiene ───────────────
{
  await reiniciar({ cubiertoHaceH: 3 });
  mundo.ordenes = [meliOrden('2000018883051330', 38), meliOrden('2000018747526358', 60)];
  await ordenEnCrm('2000018747526358', mundo.ordenes[1].last_updated);          // esta ya está al día
  const r = await correr();
  const urls = mundo.llamadas.map((u) => u.searchParams.toString());
  check('Encola la venta que faltaba y NO la que ya estaba al día', JSON.stringify(await pendientes()) === '["/orders/2000018883051330"]' && r.ok === true && r.estado === 'completo' && r.encoladas === 1, JSON.stringify([r, await pendientes()]));
  check('La búsqueda va por vendedor, ordenada por fecha, 50 por página y con filtro de fechas', mundo.llamadas.length === 2 && mundo.llamadas.every((u) => u.searchParams.get('seller') === '999' && u.searchParams.get('sort') === 'date_asc' && u.searchParams.get('limit') === '50' && u.searchParams.has('order.date_last_updated.from') && u.searchParams.has('order.date_last_updated.to')), urls.join(' | '));
  const e = await estado();
  check('Lo cubierto avanza hasta ahora y no hay error', Math.abs(Date.now() - new Date(e.cubierto_hasta)) < 15000 && e.ultimo_error === null && e.ultimo_ok_en !== null, JSON.stringify(e));
  const r2 = await correr({ origen: 'cron' });
  check('Repetir el barrido no duplica el aviso (ya está pendiente)', r2.ok === true && r2.encoladas === 0 && (await pendientes()).length === 1, JSON.stringify(r2));
  check('Sin filtraciones: el resultado no trae datos del comprador ni del token', !JSON.stringify(r).includes('dato_personal') && !JSON.stringify(r).includes('"T"'));
}

// ── 2 · Rebanadas de 24 h: 48 h de ventana = 2 rebanadas, una orden en cada una ───
{
  await reiniciar({ cubiertoHaceH: 1 });
  mundo.ordenes = [meliOrden(1, 40), meliOrden(2, 5)];
  const r = await correr();
  const bar = (await db.query(`SELECT * FROM public.meli_barridos ORDER BY id DESC LIMIT 1`)).rows[0];
  check('Ventana de 48 h = 2 rebanadas, una orden en cada una, ambas encoladas', r.ok && bar.rebanadas === 2 && r.encoladas === 2, JSON.stringify(bar));
}

// ── 3 · Más de 50 en una rebanada: se parte a la mitad y no se pierde ninguna ─────
{
  await reiniciar({ cubiertoHaceH: 1 });
  mundo.ordenes = Array.from({ length: 130 }, (_, i) => meliOrden(5000 + i, 47 - (i * 0.15)));   // 130 órdenes en ~20 h
  const r = await correr();
  const aprox = (await db.query(`SELECT aproximado FROM public.meli_barridos ORDER BY id DESC LIMIT 1`)).rows[0].aproximado;
  check('130 órdenes en poco tiempo: se parten las rebanadas y se encolan las 130, sin aproximar', r.ok && (await pendientes()).length === 130 && aprox === false, `${(await pendientes()).length} ${aprox} ${JSON.stringify(r)}`);
  check('… hubo más de 2 búsquedas (se partió)', mundo.llamadas.length > 2, String(mundo.llamadas.length));
}

// ── 4 · MELI ignora el filtro "hasta": se detecta y se avisa como aproximado ───────
{
  await reiniciar({ cubiertoHaceH: 1 });
  mundo.modo = 'sinHasta';
  mundo.ordenes = [meliOrden(1, 40), meliOrden(2, 30), meliOrden(3, 2)];
  const r = await correr();
  const aprox = (await db.query(`SELECT aproximado FROM public.meli_barridos ORDER BY id DESC LIMIT 1`)).rows[0].aproximado;
  check('Si el filtro "hasta" no se aplica: igual se encolan todas, y la corrida queda marcada "aproximada" (no afirma cobertura exacta)', r.ok && (await pendientes()).length === 3 && aprox === true && r.aproximado === true, JSON.stringify([r, await pendientes()]));
}

// ── 5 · Verificación del total: si la búsqueda "pierde" una orden, NO se avanza ────
{
  await reiniciar({ cubiertoHaceH: 1 });
  mundo.ordenes = [meliOrden(1, 40), meliOrden(2, 30)];
  mundo.quitarUna = true;
  const r = await correr();
  const e = await estado();
  check('Total ≠ recibidas: la corrida falla (TOTAL_NO_COINCIDE), no se encola ni se avanza lo cubierto, y el error queda a la vista',
    r.ok === false && r.error === 'TOTAL_NO_COINCIDE' && (await pendientes()).length === 0 && sinMover(e) && e.ultimo_error === 'TOTAL_NO_COINCIDE', JSON.stringify([r, e]));
}

// ── 5b · Ids repetidos o inválidos y tramos que no se pueden verificar ────────────
{
  await reiniciar({ cubiertoHaceH: 1 });
  mundo.ordenes = [meliOrden(1, 40), meliOrden(2, 39)];
  mundo.duplicar = true;
  const r = await correr();
  check('Un id repetido en la respuesta (el conteo coincide pero falta una orden): NO se da por cubierto', r.ok === false && r.error === 'TOTAL_NO_COINCIDE' && sinMover(await estado()) && (await pendientes()).length === 0, JSON.stringify(r));
  await reiniciar({ cubiertoHaceH: 1 });
  mundo.ordenes = [meliOrden(1, 40), meliOrden(2, 39)];
  mundo.invalida = true;
  const r2 = await correr();
  check('Un id inválido en la respuesta: tampoco', r2.ok === false && r2.error === 'TOTAL_NO_COINCIDE' && sinMover(await estado()), JSON.stringify(r2));

  await reiniciar({ cubiertoHaceH: 1 });
  const base = Date.now() - 30 * 3600e3;
  mundo.ordenes = Array.from({ length: 1005 }, (_, i) => ({ id: String(700000 + i), last_updated: new Date(base + i * 1000).toISOString() }));   // 1005 en 17 minutos
  const r3 = await correr();
  check('1005 órdenes en pocos minutos (más que el tope de páginas): NO se da por cubierto, falla con TRAMO_NO_VERIFICABLE y lo cubierto no se mueve',
    r3.ok === false && r3.error === 'TRAMO_NO_VERIFICABLE' && sinMover(await estado()), JSON.stringify(r3));
}

// ── 6 · Errores de Mercado Libre: códigos estables, nada interno ──────────────────
{
  for (const [st, cod] of [[500, 'MELI_HTTP_500'], [429, 'MELI_LIMITANDO'], [403, 'MELI_HTTP_403']]) {
    await reiniciar({ cubiertoHaceH: 1 });
    mundo.status = st;
    const r = await correr();
    const e = await estado();
    check(`Mercado Libre responde ${st}: la corrida falla con "${cod}", sin avanzar, y no se filtra el mensaje`, r.ok === false && r.error === cod && e.ultimo_error === cod && sinMover(e) && !JSON.stringify(r).includes('detalle interno'), JSON.stringify([r, e]));
  }
}

// ── 7 · Se acaba el tiempo a mitad: lo hecho queda hecho ("parcial") ─────────────
{
  await reiniciar({ cubiertoHaceH: 1 });
  mundo.ordenes = [meliOrden(1, 40), meliOrden(2, 5)];
  let restante = 20000;
  const pres = { restante: () => restante, final: null };
  mundo.alBuscar = async () => { restante = 1000; };               // tras la primera búsqueda ya no queda tiempo
  const r = await B.barrer({ cuentaId, origen: 'boton' }, pres, M.presupuestoHasta(Date.now() + 20000));
  const e = await estado();
  check('Sin tiempo después de la primera rebanada: queda "parcial", lo cubierto llega hasta ahí (no más) y la primera orden quedó encolada',
    r.ok === true && r.estado === 'parcial' && r.cortadoPorTiempo === true && JSON.stringify(await pendientes()) === '["/orders/1"]' && new Date((await db.query(`SELECT cursor_en FROM public.meli_barridos ORDER BY id DESC LIMIT 1`)).rows[0].cursor_en) < new Date(hace(20)), JSON.stringify([r, e, await pendientes()]));
  mundo.alBuscar = null;
  await db.query(`UPDATE public.meli_barridos SET iniciado_en = now() - interval '10 minutes'`);
  const r2 = await correr();
  check('La corrida siguiente retoma desde ahí y termina', r2.ok && r2.estado === 'completo' && (await pendientes()).length === 2, JSON.stringify([r2, await pendientes()]));
}

// ── 8 · Otra corrida toma la posta a mitad de camino: no se pisa nada ─────────────
{
  await reiniciar({ cubiertoHaceH: 1 });
  mundo.ordenes = [meliOrden(1, 40), meliOrden(2, 5)];
  let n = 0;
  mundo.alBuscar = async () => {
    if (++n !== 2) return;                                       // durante la segunda búsqueda, la corrida pierde el lease
    await db.query(`UPDATE public.meli_barridos SET lease_hasta = now() - interval '1 second' WHERE estado='en_curso'`);
    await db.query(`SELECT public.meli_barrido_iniciar($1,$2,'cron',null,30,120)`, [SECRETO, cuentaId]);
  };
  const r = await correr();
  const filas = (await db.query(`SELECT estado FROM public.meli_barridos ORDER BY id`)).rows.map((x) => x.estado);
  check('Perder el lease a mitad: la corrida atrasada se detiene (LEASE_PERDIDO) sin cerrar ni mover nada; la nueva sigue en curso', r.ok === false && r.motivo === 'LEASE_PERDIDO' && filas.join() === 'vencido,en_curso', JSON.stringify([r, filas]));
}

// ── 9 · No se puede empezar ───────────────────────────────────────────────
{
  await reiniciar({ cubiertoHaceH: 1 });
  await db.query(`UPDATE public.meli_cuentas SET requiere_reconexion = true WHERE id=$1`, [cuentaId]);
  const antes = mundo.llamadas.length;
  const b = await B.barrer({ cuentaId, origen: 'cron' }, presUnico(), M.presupuestoHasta(Date.now() + 20000));
  check('Cuenta que pide reconectar: { ok:false, motivo:CUENTA_BLOQUEADA } y no se llama a Mercado Libre', b.ok === false && b.motivo === 'CUENTA_BLOQUEADA' && mundo.llamadas.length === antes, JSON.stringify(b));
  await db.query(`UPDATE public.meli_cuentas SET requiere_reconexion = false WHERE id=$1`, [cuentaId]);
  const c = await correr();
  const d = await correr();
  check('Dos botones seguidos: el segundo recibe MUY_PRONTO con la espera', d.ok === false && d.motivo === 'MUY_PRONTO' && d.espera_seg > 0, JSON.stringify(d));
}

// ── 10 · Primera vez, cuenta recién conectada ─────────────────────────────
{
  await reiniciar({ conectadaHaceDias: 0 });
  mundo.ordenes = [meliOrden(1, 0.2)];
  const r = await correr();
  check('Cuenta conectada hace instantes: la ventana no es vacía y la corrida termina bien', r.ok === true && r.estado === 'completo', JSON.stringify(r));
}

// ── 11 · El cron: barre todas las cuentas y después drena; el botón por el worker ────
{
  await reiniciar({ cubiertoHaceH: 2 });
  mundo.ordenes = [meliOrden(2000018883051330, 3)];
  await db.query(`SELECT public.meli_notificacion_registrar($1,'999','orders_v2','/orders/777','{}'::jsonb)`, [SECRETO]);   // un aviso viejo en cola
  const llamar = async (req) => { const res = { code: null, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } }; await worker({ ...req, socket: {}, headers: { 'x-forwarded-for': '10.1.1.' + Math.floor(Math.random() * 250), ...(req.headers || {}) } }, res); return res; };
  const g = await llamar({ method: 'GET', headers: { authorization: 'Bearer cron-de-prueba' } });
  check('El cron (GET con CRON_SECRET): barre, deja la venta en cola y el resultado trae el informe del barrido', g.code === 200 && Array.isArray(g.body.barrido) && g.body.barrido[0].ok === true && g.body.barrido[0].encoladas === 1 && (await pendientes()).includes('/orders/2000018883051330'), JSON.stringify(g.body).slice(0, 300));
  const sin = await llamar({ method: 'GET', headers: {} });
  check('El GET sin el secreto del cron sigue cerrado (401)', sin.code === 401);
  const p = await llamar({ method: 'POST', headers: { 'x-crm-token': 'tok' }, body: { accion: 'barrido', cuenta: 'x' } });
  check('El botón con una cuenta inválida → 400 (antes de autenticar el cuerpo no se usa)', p.code === 401 || p.code === 400);
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
