// Banco de CONCURRENCIA de las facturas de Mercado Libre (script 16): un Postgres REAL (embedded-postgres) y VARIAS CONEXIONES a la vez.
//
//   cd tests/sql && node facturas_meli.concurrencia.test.mjs
//
// Lo que pglite (una sola conexión) no puede probar, con INTERCALADOS FORZADOS (se mira pg_blocking_pids, no se confía en el azar):
//   1. Dos personas anotan la MISMA orden a la vez: gana una; la otra recibe FACTURA_CAMBIO_RECARGAR (sin fila) o
//      FACTURA_YA_REGISTRADA; nunca se pisan ni se duplica el historial.
//   2. El mismo comprobante en dos órdenes a la vez: la segunda ESPERA el índice único y falla con NUMERO_REPETIDO si la
//      primera confirma, o entra si la primera se deshace.
//   3. Dos «reabrir» con la misma versión: una reabre, la otra es sin_cambios; la reapertura vieja no borra lo nuevo.
//   4. Anotar contra Procesar de la MISMA orden: se esperan sin deadlock en los dos órdenes.
//   5. Esfuerzo: anotar, reabrir y procesar mezclados con 5 conexiones: cero deadlocks, todo cuadra con el historial.
// LÍMITE HONESTO: PostgreSQL 18 beta (el de embedded-postgres); Supabase corre otra versión.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SQL, SECRETO, ESQUEMA_MINIMO, ventasConParche, nuevoStock, nuevaOrden } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const azar = (n) => Math.floor(Math.random() * n);
const CLAIMS = JSON.stringify({ email: 'franco@x.com', sub: '11111111-1111-1111-1111-111111111111', user_metadata: { full_name: 'Franco V' } });

async function arrancar() {
  let ultimo = null;
  for (let intento = 0; intento < 5; intento++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-facturas-'));
    const port = 55000 + Math.floor(Math.random() * 3000);
    const srv = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'x', port, persistent: false, onLog: () => {}, onError: () => {} });
    try {
      await srv.initialise(); await srv.start();
      const conectar = async () => {
        const c = new pg.Client({ host: 'localhost', port, user: 'postgres', password: 'x', database: 'postgres' });
        await c.connect();
        await c.query(`SELECT set_config('request.jwt.claims', '${CLAIMS}', false)`);
        await c.query(`SET deadlock_timeout = '100ms'`);
        c.pid = (await c.query('SELECT pg_backend_pid() AS p')).rows[0].p;
        return c;
      };
      return { srv, dir, conectar };
    } catch (e) { ultimo = e; try { await srv.stop(); } catch { /* no había arrancado */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sin acceso */ } }
  }
  throw new Error('No se pudo arrancar Postgres: ' + (ultimo && ultimo.message));
}
async function cargarEsquema(admin) {
  await admin.query(ESQUEMA_MINIMO);
  await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions');
  for (const f of ['caja_aplicar_delta.sql', 'stock_a_pedido.sql', 'meli_esquema_base.sql', 'meli_vincular.sql']) await admin.query(SQL(f));
  await admin.query(`UPDATE public.meli_config SET valor = $1 WHERE clave = 'rpc_secret_sha256'`, [crypto.createHash('sha256').update(SECRETO).digest('hex')]);
  await admin.query(ventasConParche(SQL('meli_ventas_migration.sql')));
  await admin.query(SQL('meli_facturas.sql'));
}
async function esperaCandado(observador, pid, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const f = (await observador.query(`SELECT wait_event_type, pg_blocking_pids(pid) AS b FROM pg_stat_activity WHERE pid = $1`, [pid])).rows[0];
    if (f && f.wait_event_type === 'Lock' && f.b.length > 0) return true;
    await dormir(30);
  }
  return false;
}

const errores = [];
const anotar = (donde, e) => errores.push(`${donde}: ${e.code || ''} ${String(e.message).slice(0, 120)}`);
let nItem = 0;
const msg = (x) => String((x && x.e && x.e.message) || '');

console.log('\n══ Facturas de Mercado Libre bajo concurrencia (Postgres real, varias conexiones) ══\n');
let srv = null, dir = null;
const conexiones = [];
const limpiar = async () => {
  for (const c of conexiones) { try { await c.end(); } catch { /* ya cerrada */ } }
  try { if (srv) await srv.stop(); } catch { /* ya parado */ }
  try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sin acceso */ }
};
const reloj = setTimeout(async () => { console.log(' FALLA │ el banco superó el tiempo máximo'); await limpiar(); process.exit(1); }, 9 * 60 * 1000);

try {
  const arr = await arrancar(); srv = arr.srv; dir = arr.dir;
  const nueva = async () => { const c = await arr.conectar(); conexiones.push(c); return c; };
  const admin = await nueva();
  await cargarEsquema(admin);
  const { rows: [p] } = await admin.query(`INSERT INTO public.personas (nombre) VALUES ('Franco') RETURNING id`);
  await admin.query(`INSERT INTO public.cajas (persona_id, bolsillo, saldo) VALUES ($1,'ARS Mercado Pago',0)`, [p.id]);
  const { rows: [cu] } = await admin.query(`INSERT INTO public.meli_cuentas (meli_user_id, nickname, persona_id, bolsillo) VALUES ('991','C',$1,'ARS Mercado Pago') RETURNING id`, [p.id]);
  const ctx = { db: admin, cuentaId: cu.id };
  const [c1, c2, c3, c4, c5] = await Promise.all([nueva(), nueva(), nueva(), nueva(), nueva()]);
  // Cada conexión es una persona distinta (email e identidad propios), para comprobar que el historial anota a quien corresponde.
  const PERSONAS = new Map();
  for (const [i, c] of [c1, c2, c3, c4, c5].entries()) {
    const email = `u${i + 1}@x.com`, sub = `0000000${i + 1}-0000-0000-0000-00000000000${i + 1}`;
    await admin.query(`INSERT INTO public.usuarios_autorizados (email, activo) VALUES ($1, true)`, [email]);
    await c.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email, sub, user_metadata: { full_name: 'Nombre ' + i } })]);
    PERSONAS.set(c, { email, sub });
  }

  // Una orden lista para procesar (con stock y vínculo): devuelve su id interno, su número de Mercado Libre y su stock.
  const lista = async () => {
    const item = 'MLA' + String(++nItem).padStart(9, '0');
    const s = await nuevoStock(admin, { nombre: 'Perfume ' + item, cantidad: 5 });
    await admin.query(`SELECT public.meli_publicacion_vincular($1,$2,$3,NULL,$4,NULL,'t',10,'franco@x.com')`, [SECRETO, cu.id, item, s]);
    const id = await nuevaOrden(ctx, [{ item, cant: 1, precio: 100000, stock: s }]);
    const m = (await admin.query(`SELECT meli_order_id m FROM public.meli_ordenes WHERE id=$1`, [id])).rows[0].m;
    return { id, m, s };
  };
  const marcar = (c, orden, estado, o = {}) =>
    c.query(`SELECT public.meli_factura_marcar($1,$2,$3,$4,$5,$6,$7,$8) AS r`,
      [orden, estado, o.tipo ?? null, o.pto ?? null, o.num ?? null, o.fecha ?? null, o.motivo ?? null, o.ver ?? null]).then((x) => ({ ok: true, r: x.rows[0].r }), (e) => ({ ok: false, e }));
  const emitir = (c, orden, num, o = {}) => marcar(c, orden, 'emitida', { tipo: 'C', pto: 3, num, fecha: '2026-10-01', ...o });
  const fila = async (m) => (await admin.query(`SELECT * FROM public.meli_facturas WHERE orden_id=$1`, [m])).rows[0];
  const hist = async (m) => (await admin.query(`SELECT * FROM public.meli_facturas_historial WHERE orden_id=$1 ORDER BY id`, [m])).rows;
  const procesar = (c, id) => c.query(`SELECT public.meli_procesar_orden($1, 1000) AS r`, [id]);

  // ── 1 · Dos personas anotan la MISMA orden, a la vez ───────────────────────
  {
    // 1a · Intercalado forzado: A inserta y todavía no confirma; B queda esperando la misma fila.
    const o = await lista();
    await c1.query('BEGIN');
    const rA = await emitir(c1, o.m, 100);
    const lanzada = emitir(c2, o.m, 101);
    const espera = await esperaCandado(c4, c2.pid);
    await c1.query('COMMIT');
    const rB = await lanzada;
    const f = await fila(o.m);
    check('1a A anota (sin confirmar) y B queda ESPERANDO la misma fila; al confirmar A, B recibe FACTURA_CAMBIO_RECARGAR y no pisa nada', rA.ok && espera && !rB.ok && msg(rB).includes('FACTURA_CAMBIO_RECARGAR') && f.numero === 100 && Number(f.version) === 1, JSON.stringify({ espera, a: rA.ok, b: msg(rB) }));
    check('1a … el historial tiene UNA sola entrada (la de A)', (await hist(o.m)).length === 1);
    // 1b · Con la fila ya creada: A reabre sin confirmar; B intenta cambiar el número con lo que veía.
    await c1.query('BEGIN');
    const rA2 = await marcar(c1, o.m, 'pendiente', { ver: 1 });
    const l2 = emitir(c2, o.m, 102, { ver: 1 });
    const esp2 = await esperaCandado(c4, c2.pid);
    await c1.query('COMMIT');
    const rB2 = await l2;
    const f2 = await fila(o.m);
    check('1b A reabre (sin confirmar) y B, con la versión vieja, espera la fila y después recibe FACTURA_CAMBIO_RECARGAR: la factura NO se pisa', rA2.ok && esp2 && !rB2.ok && msg(rB2).includes('FACTURA_CAMBIO_RECARGAR') && f2.estado === 'pendiente' && Number(f2.version) === 2, JSON.stringify({ esp2, b: msg(rB2), f2 }));
    // 1c · Azar: 40 veces, dos personas anotan números distintos a la vez sobre la misma orden nueva.
    let ganadores = 0, raros = 0, histMal = 0;
    for (let i = 0; i < 40; i++) {
      const x = await lista();
      const [a, b] = await Promise.all([
        (async () => { await dormir(azar(8)); return emitir(c1, x.m, 200 + i * 2); })(),
        (async () => { await dormir(azar(8)); return emitir(c2, x.m, 201 + i * 2); })(),
      ]);
      const fx = await fila(x.m);
      const oks = [a, b].filter((r) => r.ok && !r.r.sin_cambios).length;
      const perd = [a, b].find((r) => !r.ok);
      ganadores += oks === 1 ? 1 : 0;
      if (oks !== 1 || !perd || !/FACTURA_CAMBIO_RECARGAR|FACTURA_YA_REGISTRADA/.test(msg(perd))) { raros++; anotar('1c', perd ? perd.e : new Error('sin perdedor')); }
      if ((await hist(x.m)).length !== 1 || Number(fx.version) !== 1) histMal++;
    }
    check(`1c 40 carreras al azar sobre la misma orden: SIEMPRE un solo ganador (${ganadores}/40), el otro recibe el error correcto, el historial tiene 1 entrada`, ganadores === 40 && raros === 0 && histMal === 0, JSON.stringify({ ganadores, raros, histMal }));
  }

  // ── 2 · El mismo comprobante en dos órdenes, a la vez ──────────────────────
  {
    const a = await lista(), b = await lista();
    await c1.query('BEGIN');
    const rA = await emitir(c1, a.m, 300);
    const lanzada = emitir(c2, b.m, 300);
    const espera = await esperaCandado(c4, c2.pid);
    await c1.query('COMMIT');
    const rB = await lanzada;
    check('2a Mismo comprobante en otra orden mientras la primera no confirmó: la segunda ESPERA el índice único y al confirmar la primera recibe NUMERO_REPETIDO', rA.ok && espera && !rB.ok && msg(rB).includes('NUMERO_REPETIDO'), JSON.stringify({ espera, b: msg(rB) }));
    check('2a … la segunda orden no quedó con fila ni historial', await fila(b.m) === undefined && (await hist(b.m)).length === 0);
    const c = await lista(), d = await lista();
    await c1.query('BEGIN');
    const rC = await emitir(c1, c.m, 301);
    const l2 = emitir(c2, d.m, 301);
    const esp2 = await esperaCandado(c4, c2.pid);
    await c1.query('ROLLBACK');
    const rD = await l2;
    check('2b Si la primera se DESHACE, la que esperaba entra bien con ese comprobante', rC.ok && esp2 && rD.ok && (await fila(d.m)).numero === 301 && await fila(c.m) === undefined, JSON.stringify({ esp2, d: msg(rD) }));
    let mal = 0, doble = 0;
    for (let i = 0; i < 40; i++) {
      const x = await lista(), y = await lista();
      const [r1, r2] = await Promise.all([
        (async () => { await dormir(azar(8)); return emitir(c1, x.m, 400 + i); })(),
        (async () => { await dormir(azar(8)); return emitir(c2, y.m, 400 + i); })(),
      ]);
      const oks = [r1, r2].filter((r) => r.ok).length, perd = [r1, r2].find((r) => !r.ok);
      if (oks !== 1 || !perd || !msg(perd).includes('NUMERO_REPETIDO')) { mal++; if (perd) anotar('2c', perd.e); }
      const n = (await admin.query(`SELECT count(*)::int n FROM public.meli_facturas WHERE estado='emitida' AND tipo='C' AND pto_venta=3 AND numero=$1`, [400 + i])).rows[0].n;
      if (n !== 1) doble++;
    }
    check('2c 40 carreras al azar con el MISMO comprobante en dos órdenes: nunca queda duplicado, el que pierde recibe NUMERO_REPETIDO', mal === 0 && doble === 0, JSON.stringify({ mal, doble }));
  }

  // ── 3 · Dos «reabrir» con la misma versión ────────────────────────────────
  {
    let mal = 0;
    for (let i = 0; i < 30; i++) {
      const x = await lista(); await emitir(c1, x.m, 500 + i);
      const [a, b] = await Promise.all([
        (async () => { await dormir(azar(6)); return marcar(c1, x.m, 'pendiente', { ver: 1 }); })(),
        (async () => { await dormir(azar(6)); return marcar(c2, x.m, 'pendiente', { ver: 1 }); })(),
      ]);
      const f = await fila(x.m), h = await hist(x.m);
      const reaperturas = [a, b].filter((r) => r.ok && !r.r.sin_cambios).length, sinCambios = [a, b].filter((r) => r.ok && r.r.sin_cambios).length;
      if (reaperturas !== 1 || sinCambios !== 1 || f.estado !== 'pendiente' || Number(f.version) !== 2 || h.length !== 2) { mal++; anotar('3', new Error(JSON.stringify([a.ok, b.ok, msg(a), msg(b)]))); }
    }
    check('3 Dos «reabrir» a la vez con la misma versión, 30 veces: una reabre de verdad, la otra es sin_cambios; versión 2; historial de 2 entradas', mal === 0, String(mal));
    // Una reapertura vieja NO borra lo que otra persona registró después.
    const y = await lista(); await emitir(c1, y.m, 600);
    await marcar(c2, y.m, 'pendiente', { ver: 1 }); await emitir(c2, y.m, 601, { ver: 2 });
    const viejo = await marcar(c1, y.m, 'pendiente', { ver: 1 });
    const fy = await fila(y.m);
    check('3 … y una reapertura con la versión VIEJA (después de que otra persona reabrió y registró otro número) no borra el nuevo', !viejo.ok && msg(viejo).includes('FACTURA_CAMBIO_RECARGAR') && fy.numero === 601 && Number(fy.version) === 3, JSON.stringify({ v: msg(viejo), fy }));
  }

  // ── 4 · Anotar contra Procesar de la misma orden ───────────────────────────
  {
    // 4a · Procesar tiene la orden (FOR UPDATE): anotar espera y después entra. Sin deadlock.
    const o = await lista();
    await c1.query('BEGIN');
    await c1.query(`SELECT public.meli_procesar_orden($1, 1000)`, [o.id]);
    const lanzada = emitir(c2, o.m, 700);
    const espera = await esperaCandado(c4, c2.pid);
    await c1.query('COMMIT');
    const r = await lanzada;
    check('4a Procesar en curso: anotar la factura ESPERA la orden y después entra', espera && r.ok && (await fila(o.m)).numero === 700, JSON.stringify({ espera, r: msg(r) }));
    // 4b · Anotar tiene el KEY SHARE de la orden: Procesar espera, y después procesa bien.
    const o2 = await lista();
    await c1.query('BEGIN');
    const rA = await emitir(c1, o2.m, 701);
    const l2 = procesar(c2, o2.id).then(() => ({ ok: true }), (e) => ({ ok: false, e }));
    const esp2 = await esperaCandado(c4, c2.pid);
    await c1.query('COMMIT');
    const rP = await l2;
    const q = (await admin.query(`SELECT cantidad FROM public.stock WHERE id=$1`, [o2.s])).rows[0].cantidad;
    check('4b Anotando la factura (sin confirmar), Procesar ESPERA un instante y después procesa bien: venta creada, stock descontado, factura intacta', rA.ok && esp2 && rP.ok && q === 4 && (await fila(o2.m)).numero === 701, JSON.stringify({ esp2, p: msg(rP), q }));
  }

  // ── 5 · Esfuerzo: anotar, reabrir y procesar mezclados ─────────────────────
  {
    const N = 80, ordenes = [];
    for (let i = 0; i < N; i++) ordenes.push(await lista());
    let deadlocks = 0, errs = 0, contador = 1000;
    const esperados = /FACTURA_YA_REGISTRADA|FACTURA_CAMBIO_RECARGAR|NUMERO_REPETIDO|ORDEN_YA_PROCESADA/;
    const verDe = async (c, m) => { const x = await c.query(`SELECT version FROM public.meli_facturas WHERE orden_id=$1`, [m]); return x.rows[0] ? Number(x.rows[0].version) : null; };
    const hechas = new Map();   // `${orden}:${versión}` → email de la conexión que logró ESA operación
    const anotarOk = (c, m, r) => { if (r.ok && !r.r.sin_cambios) hechas.set(`${m}:${Number(r.r.version)}`, PERSONAS.get(c).email); };
    const accion = (c) => async () => {
      const x = ordenes[azar(N)];
      const q = azar(4);
      try {
        const ver = await verDe(c, x.m);
        if (q === 0) { const r = await emitir(c, x.m, azar(60) + 1, { ver, tipo: ['A', 'B', 'C'][azar(3)], pto: 3 + azar(2), fecha: ['2026-09-30', '2026-10-01', '2026-10-02'][azar(3)] }); anotarOk(c, x.m, r); if (!r.ok) throw r.e; }
        else if (q === 1) { const r = await marcar(c, x.m, 'no_corresponde', { motivo: 'no_es_venta_real', ver }); anotarOk(c, x.m, r); if (!r.ok) throw r.e; }
        else if (q === 2) { const r = await marcar(c, x.m, 'pendiente', { ver }); anotarOk(c, x.m, r); if (!r.ok) throw r.e; }
        else await procesar(c, x.id);
      } catch (e) {
        const m = String(e.message);
        if (e.code === '40P01') { deadlocks++; errs++; anotar('esfuerzo', e); }
        else if (!esperados.test(m) && !/ORDEN_NO_PROCESADA|ORDEN_CERRADA_MANUAL|ORDEN_YA_/.test(m)) { errs++; anotar('esfuerzo', e); }
      }
    };
    const fin = Date.now() + 20000;
    await Promise.all([c1, c2, c3, c4, c5].map(async (c) => { const f = accion(c); while (Date.now() < fin) { await f(); await dormir(1); } }));
    let incoherentes = 0, dup = 0, histMal = 0;
    for (const x of ordenes) {
      const f = await fila(x.m), h = await hist(x.m);
      if (!f) { if (h.length) histMal++; continue; }
      // La última entrada del historial es exactamente la fila actual, y las versiones suben de uno en uno.
      const u = h[h.length - 1];
      const mismaFecha = (a, b) => (a === null && b === null) || (a && b && a.getTime() === b.getTime());
      if (!u || u.estado_nuevo !== f.estado || u.tipo_nuevo !== f.tipo || u.pto_venta_nuevo !== f.pto_venta || u.numero_nuevo !== f.numero || !mismaFecha(u.emitida_el_nuevo, f.emitida_el)
          || u.motivo_nuevo !== f.motivo || u.marcada_por !== f.marcada_por || u.marcada_uid !== f.marcada_uid || Number(u.version) !== Number(f.version) || h.length !== Number(f.version)) histMal++;
      for (let i = 0; i < h.length; i++) {
        const pe = i === 0 ? null : h[i - 1];
        const ant = (k) => (pe ? pe[k + '_nuevo'] : null);
        if (h[i].estado_anterior !== (pe ? pe.estado_nuevo : null) || h[i].tipo_anterior !== ant('tipo') || h[i].pto_venta_anterior !== ant('pto_venta') || h[i].numero_anterior !== ant('numero')
            || h[i].motivo_anterior !== ant('motivo') || !mismaFecha(h[i].emitida_el_anterior, pe ? pe.emitida_el_nuevo : null)) incoherentes++;
        const quien = [...PERSONAS.values()].find((p) => p.email === h[i].marcada_por);
        if (!quien || quien.sub !== h[i].marcada_uid) incoherentes++;      // anotado a nombre de una persona real, con SU identidad
        if (Number(h[i].version) !== i + 1) incoherentes++;                // versiones consecutivas, sin saltos
        if (hechas.get(`${x.m}:${i + 1}`) !== h[i].marcada_por) incoherentes++;   // y esa entrada es de QUIEN logró la operación
      }
    }
    dup = (await admin.query(`SELECT count(*)::int n FROM (SELECT 1 FROM public.meli_facturas WHERE estado='emitida' GROUP BY tipo, pto_venta, numero HAVING count(*) > 1) t`)).rows[0].n;
    check(`5 Esfuerzo 20 s con 5 conexiones (anotar, no corresponde, reabrir y procesar mezclados sobre ${N} órdenes): CERO deadlocks y cero errores inesperados`, deadlocks === 0 && errs === 0, JSON.stringify({ deadlocks, errs, ejemplos: errores.slice(0, 3) }));
    check('5 … el historial cuadra con las filas: la última entrada es la fila vigente (todos los campos y quién), cada entrada parte exactamente de la anterior, anotada a su autor real, versión = cantidad de entradas', incoherentes === 0 && histMal === 0, JSON.stringify({ incoherentes, histMal }));
    check('5 … y no hay ningún comprobante repetido en dos órdenes', dup === 0, String(dup));
    const colgadas = (await admin.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)).rows[0].n;
    check('5 … y no queda ninguna conexión esperando un candado', colgadas === 0, String(colgadas));
  }
  check('Ningún error inesperado en todo el banco', errores.length === 0, errores.slice(0, 5).join(' | '));
} finally {
  clearTimeout(reloj);
  await limpiar();
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
