// Banco de CONCURRENCIA de "cerrar a mano" (script 12): un Postgres REAL (embedded-postgres) y VARIAS CONEXIONES a la vez.
//
//   cd tests/sql && node cerrar_manual.concurrencia.test.mjs
//
// Lo que pglite (una sola conexión) no puede probar:
//   1. Cerrar a mano contra Procesar de la MISMA orden, a la vez, con tiempos al azar: gana UNO. Nunca una orden cerrada Y
//      procesada; el stock se descontó si y solo si se procesó; una sola venta por orden procesada.
//   2. Cerrar ESPERA el candado de la orden (se mira con pg_blocking_pids) y después procede.
//   3. Dos cierres a la vez: los dos responden ok, uno solo cierra de verdad.
//   4. Esfuerzo: procesar, cerrar y reabrir mezclados sobre muchas órdenes con 5 conexiones: cero deadlocks y cuadra el stock.
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
const CLAIMS = JSON.stringify({ email: 'franco@x.com' });

async function arrancar() {
  let ultimo = null;
  for (let intento = 0; intento < 5; intento++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cierre-'));
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
  await admin.query(SQL('meli_cerrar_manual.sql'));
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

console.log('\n══ Cerrar a mano bajo concurrencia (Postgres real, varias conexiones) ══\n');
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

  // Una orden lista para procesar: stock de 5, vínculo y una orden de 1 unidad.
  const lista = async () => {
    const item = 'MLA' + String(++nItem).padStart(9, '0');
    const s = await nuevoStock(admin, { nombre: 'Perfume ' + item, cantidad: 5 });
    await admin.query(`SELECT public.meli_publicacion_vincular($1,$2,$3,NULL,$4,NULL,'t',10,'franco@x.com')`, [SECRETO, cu.id, item, s]);
    const id = await nuevaOrden(ctx, [{ item, cant: 1, precio: 100000, stock: s }]);
    return { id, s };
  };
  const procesar = (c, id) => c.query(`SELECT public.meli_procesar_orden($1, 1000) AS r`, [id]);
  const cerrar = (c, id, m = 'ya_cargada') => c.query(`SELECT public.meli_orden_cerrar_manual($1,$2,NULL,NULL) AS r`, [id, m]);
  const reabrir = (c, id) => c.query(`SELECT public.meli_orden_reabrir_cierre($1) AS r`, [id]);
  const estadoDe = async (id, s) => ({
    o: (await admin.query(`SELECT procesada, stock_descontado, venta_id, cerrada_manual_en FROM public.meli_ordenes WHERE id=$1`, [id])).rows[0],
    q: (await admin.query(`SELECT cantidad FROM public.stock WHERE id=$1`, [s])).rows[0].cantidad,
    v: (await admin.query(`SELECT count(*)::int n FROM public.ventas WHERE meli_orden_id=$1`, [id])).rows[0].n,
  });

  // ── 1 · Cerrar contra Procesar, a la vez ────────────────────────────────
  {
    let ambos = 0, malStock = 0, procGano = 0, cierreGano = 0, errs = 0, motivosRaros = 0;
    for (let i = 0; i < 60; i++) {
      const { id, s } = await lista();
      const rp = (async () => { await dormir(azar(10)); return procesar(c1, id).then(() => ({ ok: true }), (e) => ({ ok: false, e })); })();
      const rc = (async () => { await dormir(azar(10)); return cerrar(c2, id).then(() => ({ ok: true }), (e) => ({ ok: false, e })); })();
      const [a, b] = await Promise.all([rp, rc]);
      const e = await estadoDe(id, s);
      const cerrada = !!e.o.cerrada_manual_en;
      if (cerrada && e.o.procesada) ambos++;
      if ((e.o.procesada && (e.q !== 4 || e.v !== 1 || !e.o.stock_descontado)) || (!e.o.procesada && (e.q !== 5 || e.v !== 0 || e.o.stock_descontado))) malStock++;
      if (a.ok && e.o.procesada) { procGano++; if (b.ok || !String(b.e && b.e.message).includes('ORDEN_YA_PROCESADA')) motivosRaros++; }
      else if (b.ok && cerrada) { cierreGano++; if (a.ok || !String(a.e && a.e.message).includes('ORDEN_CERRADA_MANUAL')) motivosRaros++; }
      else errs++;
    }
    check(`1 Cerrar y Procesar de la misma orden a la vez, 60 veces (procesar ganó ${procGano}, cerrar ganó ${cierreGano}): nunca cerrada Y procesada`, ambos === 0 && errs === 0, JSON.stringify({ ambos, errs }));
    check('1 … el stock se descontó SI Y SOLO SI se procesó (una unidad y una venta); si se cerró, el stock y las ventas quedaron intactos', malStock === 0, String(malStock));
    check('1 … el perdedor siempre recibió el motivo correcto (ORDEN_YA_PROCESADA al cerrar, ORDEN_CERRADA_MANUAL al procesar) y hubo ganadores de los dos lados', motivosRaros === 0 && procGano > 0 && cierreGano > 0, JSON.stringify({ motivosRaros, procGano, cierreGano }));
  }

  // ── 2 · Cerrar espera el candado de la orden ──────────────────────────────
  {
    const { id, s } = await lista();
    await admin.query('BEGIN');
    await admin.query(`SELECT 1 FROM public.meli_ordenes WHERE id=$1 FOR UPDATE`, [id]);
    const lanzada = cerrar(c3, id).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));
    const espera = await esperaCandado(c4, c3.pid);
    await admin.query('COMMIT');
    const r = await lanzada;
    check('2 Cerrar ESPERA el candado de la orden mientras otra transacción la tiene (no corre en paralelo) y después cierra', espera && r.ok === true, JSON.stringify({ espera, r: r.ok }));
    // Mientras Procesar tiene la orden, cerrar espera y al final falla con ORDEN_YA_PROCESADA
    const o2 = await lista();
    await c1.query('BEGIN');
    await c1.query(`SELECT public.meli_procesar_orden($1, 1000)`, [o2.id]);
    const l2 = cerrar(c3, o2.id).then(() => ({ ok: true }), (e) => ({ ok: false, e }));
    const esp2 = await esperaCandado(c4, c3.pid);
    await c1.query('COMMIT');
    const r2 = await l2;
    const e2 = await estadoDe(o2.id, o2.s);
    check('2 Procesar en curso: cerrar espera, y cuando Procesar termina recibe ORDEN_YA_PROCESADA (la venta queda, la orden NO queda cerrada)', esp2 && r2.ok === false && String(r2.e.message).includes('ORDEN_YA_PROCESADA') && e2.o.procesada && !e2.o.cerrada_manual_en && e2.q === 4, JSON.stringify({ esp2, msg: r2.e && r2.e.message }));
  }

  // ── 3 · Dos cierres a la vez ──────────────────────────────────────────────
  {
    let mal = 0, errs = 0;
    for (let i = 0; i < 30; i++) {
      const { id } = await lista();
      const [a, b] = await Promise.all([
        cerrar(c1, id, 'ya_cargada').then((r) => r.rows[0].r, (e) => { errs++; anotar('cierre doble', e); return null; }),
        cerrar(c2, id, 'descartada').then((r) => r.rows[0].r, (e) => { errs++; anotar('cierre doble', e); return null; }),
      ]);
      if (!a || !b || (!!a.ya_cerrada === !!b.ya_cerrada)) mal++;
    }
    check('3 Dos cierres de la misma orden a la vez, 30 veces: los dos responden ok y UNO solo la cierra de verdad (el otro "ya cerrada")', mal === 0 && errs === 0, JSON.stringify({ mal, errs }));
  }

  // ── 4 · Esfuerzo: procesar, cerrar y reabrir mezclados ─────────────────────
  {
    const N = 120, ordenes = [];
    for (let i = 0; i < N; i++) ordenes.push(await lista());
    let deadlocks = 0, errs = 0;
    const accion = (c) => async () => {
      const x = ordenes[azar(N)];
      const q = azar(3);
      try {
        if (q === 0) await procesar(c, x.id);
        else if (q === 1) await cerrar(c, x.id, azar(2) ? 'ya_cargada' : 'descartada');
        else await reabrir(c, x.id);
      } catch (e) {
        const m = String(e.message);
        if (e.code === '40P01') { deadlocks++; errs++; anotar('esfuerzo', e); }
        else if (!/ORDEN_CERRADA_MANUAL|ORDEN_YA_PROCESADA|ORDEN_NO_PROCESADA/.test(m)) { errs++; anotar('esfuerzo', e); }
      }
    };
    const fin = Date.now() + 20000;
    await Promise.all([c1, c2, c3, c4, c5].map(async (c) => { const f = accion(c); while (Date.now() < fin) { await f(); await dormir(1); } }));
    let incoherentes = 0, procesadas = 0, descontado = 0;
    for (const x of ordenes) {
      const e = await estadoDe(x.id, x.s);
      if (e.o.cerrada_manual_en && (e.o.procesada || e.o.stock_descontado || e.v)) incoherentes++;
      if (e.o.procesada) { procesadas++; if (e.q !== 4 || e.v !== 1) incoherentes++; } else if (e.q !== 5 || e.v !== 0) incoherentes++;
      descontado += 5 - e.q;
    }
    check(`4 Esfuerzo 20 s con 5 conexiones (procesar, cerrar y reabrir mezclados sobre ${N} órdenes): CERO deadlocks y cero errores inesperados`, deadlocks === 0 && errs === 0, JSON.stringify({ deadlocks, errs, ejemplos: errores.slice(0, 3) }));
    check(`4 … y todo cuadra: ninguna orden cerrada Y procesada; ${procesadas} procesadas = ${descontado} unidades descontadas = ${procesadas} ventas`, incoherentes === 0 && descontado === procesadas, JSON.stringify({ incoherentes, procesadas, descontado }));
    const colgadas = (await admin.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)).rows[0].n;
    check('4 … y no queda ninguna conexión esperando un candado', colgadas === 0, String(colgadas));
  }
  check('Ningún error inesperado en todo el banco', errores.length === 0, errores.slice(0, 5).join(' | '));
} finally {
  clearTimeout(reloj);
  await limpiar();
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
