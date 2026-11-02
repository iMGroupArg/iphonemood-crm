// Banco de CONCURRENCIA de las actividades (script 15): un Postgres REAL (embedded-postgres) y VARIAS CONEXIONES a la vez.
// pglite tiene una sola conexión y no puede probar esperas ni deadlocks; esto sí.
//
//   cd tests/sql && node actividades.concurrencia.test.mjs
//
// Carga los archivos reales de db/pendientes en el orden de corrida (1 → 2 → 3 → 7 → 4 → 12 → 15). En cada carrera se mira
// pg_stat_activity + pg_blocking_pids para comprobar que la segunda conexión REALMENTE ESPERA a la primera (no sólo "tarda"):
//   1. dos «transferir» de la MISMA actividad → la plata se mueve UNA vez; la segunda responde «ya hecha».
//   2. transferir ‖ revertir la orden → revertir espera y después falla con ORDEN_YA_TRANSFERIDA (nada a medias).
//   3. revertir ‖ transferir → transferir espera y después falla (la actividad quedó anulada); la plata vuelve entera.
//   4. transferir ‖ «solo marcar» (en los dos sentidos) → gana uno solo; el otro recibe un error, nunca un éxito falso.
//   5. dos actividades que comparten saldo → una sola transfiere; la otra SALDO_INSUFICIENTE; el saldo nunca queda negativo.
//   6. acreditar ‖ revertir → revertir espera, y al final la actividad queda anulada y las cajas en cero.
//   7. ESFUERZO: transferir, marcar, reabrir, compensar y revertir mezclados desde 4 conexiones: cero deadlocks, cero errores
//      inesperados, y los invariantes de plata se cumplen (libro = saldos, nada negativo, total = lo acreditado y no revertido).
//
// LÍMITE HONESTO: el motor es PostgreSQL 18 (beta de embedded-postgres); Supabase corre otra versión. Cubre la semántica
// de bloqueos de Postgres, no es idéntico a producción.
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
const CLAIMS = JSON.stringify({ email: 'franco@x.com' });

async function arrancar() {
  let ultimo = null;
  for (let intento = 0; intento < 5; intento++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-actividades-'));
    const port = 55000 + Math.floor(Math.random() * 3000);
    const srv = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'x', port, persistent: false, onLog: () => {}, onError: () => {} });
    try {
      await srv.initialise(); await srv.start();
      const conectar = async () => {
        const c = new pg.Client({ host: 'localhost', port, user: 'postgres', password: 'x', database: 'postgres' });
        await c.connect();
        await c.query(`SELECT set_config('request.jwt.claims', '${CLAIMS}', false)`);
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
  await admin.query(SQL('actividades.sql'));
}

async function esperaCandado(observador, pid, bloqueador, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await observador.query(`SELECT wait_event_type, pg_blocking_pids(pid) AS b FROM pg_stat_activity WHERE pid = $1`, [pid]);
    const f = r.rows[0];
    if (f && f.wait_event_type === 'Lock' && f.b.length > 0 && (bloqueador === undefined || f.b.includes(bloqueador))) return true;
    await dormir(40);
  }
  return false;
}
function lanzar(c, sql, params) {
  const e = { hecho: false, ok: null, err: null };
  e.fin = c.query(sql, params).then((r) => { e.hecho = true; e.ok = r; }, (er) => { e.hecho = true; e.err = er; });
  return e;
}
const msg = (e) => (e && e.message) || '';

const q = async (c, sql, p = []) => (await c.query(sql, p)).rows;
let nItem = 0;
async function acreditada(admin, ctx) {
  const item = 'MLA' + String(++nItem + 5000).padStart(9, '0');
  const s = await nuevoStock(admin, { nombre: 'Perfume ' + item, cantidad: 50 });
  await admin.query(`SELECT public.meli_publicacion_vincular($1,$2,$3,NULL,$4,NULL,'t',10,'franco@x.com')`, [SECRETO, ctx.cuentaId, item, s]);
  const id = await nuevaOrden({ db: admin, cuentaId: ctx.cuentaId }, [{ item, cant: 1, precio: 100000, stock: s }]);
  await admin.query(`SELECT public.meli_procesar_orden($1, 1000)`, [id]);
  await admin.query(`SELECT public.meli_acreditar_orden($1, NULL, false)`, [id]);
  const a = (await q(admin, `SELECT * FROM public.actividades WHERE origen_orden_id=$1`, [id]))[0];
  return { orden: id, act: a.id, stock: s };
}
const act = async (c, id) => (await q(c, `SELECT * FROM public.actividades WHERE id=$1`, [id]))[0];
const saldo = async (c, b) => Number((await q(c, `SELECT saldo FROM public.cajas WHERE bolsillo=$1`, [b]))[0].saldo);
const intentoDe = async (c, id) => (await q(c, `SELECT intento FROM public.actividades WHERE id=$1`, [id]))[0].intento;
const transferir = async (c, id, persona) => c.query(`SELECT public.actividad_transferir($1,$2,$3,'ARS transferencia',NULL) AS r`, [id, await intentoDe(c, id), persona]);
const revisionDe = async (c, id) => (await q(c, `SELECT revision FROM public.actividades WHERE id=$1`, [id]))[0].revision;
const marcar = async (c, id) => c.query(`SELECT public.actividad_marcar_hecha($1,$2,NULL) AS r`, [id, await revisionDe(c, id)]);
const revertir = (c, id) => c.query(`SELECT public.meli_revertir_orden($1,'prueba') AS r`, [id]);
const reiniciarCajas = async (admin) => { await admin.query(`UPDATE public.cajas SET saldo = 0`); await admin.query(`DELETE FROM public.caja_ledger`); };

console.log('\n══ Actividades bajo concurrencia (Postgres real, varias conexiones) ══\n');

let srv = null, dir = null, conectar = null;
const conexiones = [];
const errores = [];
const conn = async () => { const c = await conectar(); conexiones.push(c); return c; };
async function limpiar() {
  for (const c of conexiones) { try { await c.end(); } catch { /* ya cerrada */ } }
  try { if (srv) await srv.stop(); } catch { /* ya detenido */ }
  try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sin acceso */ }
}
const reloj = setTimeout(() => { console.error('\nTIEMPO MÁXIMO (300 s): el banco se colgó. Errores vistos: ' + (errores.slice(0, 6).join(' | ') || '(ninguno)')); limpiar().finally(() => process.exit(2)); }, 300000);

try {
  ({ srv, dir, conectar } = await arrancar());
  const admin = await conn();
  await admin.query(`ALTER DATABASE postgres SET deadlock_timeout = '100ms'`);
  await cargarEsquema(admin);
  const { rows: [p] } = await admin.query(`INSERT INTO public.personas (nombre) VALUES ('Franco') RETURNING id`);
  await admin.query(`INSERT INTO public.cajas (persona_id, bolsillo, saldo) VALUES ($1,'ARS Mercado Pago',0), ($1,'ARS transferencia',0)`, [p.id]);
  await admin.query(`INSERT INTO public.usuarios_autorizados VALUES ('franco@x.com', true) ON CONFLICT DO NOTHING`);
  const { rows: [cu] } = await admin.query(`INSERT INTO public.meli_cuentas (meli_user_id, nickname, persona_id, bolsillo) VALUES ('777','FRANCO',$1,'ARS Mercado Pago') RETURNING id`, [p.id]);
  const ctx = { cuentaId: cu.id };
  const version = (await admin.query('SHOW server_version')).rows[0].server_version;
  check(`Postgres real arrancado (versión ${version}) y los scripts 1, 3, 7, 4, 12 y 15 cargan sin errores`, true);
  const A = await conn(), B = await conn(), C = await conn();

  // ── 1. Dos transferencias de la MISMA actividad ───────────────────────────
  {
    const x = await acreditada(admin, ctx);
    await A.query('BEGIN');
    const rA = (await transferir(A, x.act, p.id)).rows[0].r;
    const pedido = lanzar(B, `SELECT public.actividad_transferir($1,1,$2,'ARS transferencia',NULL) AS r`, [x.act, p.id]);
    const espera = await esperaCandado(C, B.pid, A.pid);
    check('1.a Mientras A transfiere, la misma transferencia en B ESPERA a A (candado, confirmado con pg_blocking_pids) y no termina', espera && !pedido.hecho);
    await A.query('COMMIT'); await pedido.fin;
    const rB = pedido.ok && pedido.ok.rows[0].r;
    check('1.b Al confirmar A, B responde «ya hecha» y la plata se movió UNA sola vez (85.000 en la caja de la empresa)',
      rA.ok && !pedido.err && rB && rB.ya_hecha === true && await saldo(admin, 'ARS transferencia') === 85000 && await saldo(admin, 'ARS Mercado Pago') === 0, JSON.stringify({ rA, rB, e: msg(pedido.err) }));
    const patas = (await q(admin, `SELECT count(*)::int n FROM public.caja_ledger WHERE clave LIKE 'act-%'`))[0].n;
    check('1.c El libro tiene exactamente las 2 patas de UNA transferencia', patas === 2, String(patas));
  }
  await reiniciarCajas(admin);

  // ── 2. Transferir ‖ revertir la orden ─────────────────────────────────────
  {
    const x = await acreditada(admin, ctx);   // caja MP = 85000
    await A.query('BEGIN');
    await transferir(A, x.act, p.id);
    const pedido = lanzar(B, `SELECT public.meli_revertir_orden($1,'prueba') AS r`, [x.orden]);
    const espera = await esperaCandado(C, B.pid, A.pid);
    check('2.a Revertir la orden mientras A transfiere ESPERA a A (mismo orden de bloqueos: la orden primero)', espera && !pedido.hecho);
    await A.query('COMMIT'); await pedido.fin;
    const ord = (await q(admin, `SELECT revertida_en FROM public.meli_ordenes WHERE id=$1`, [x.orden]))[0];
    check('2.b Al confirmar A, la reversión falla con ORDEN_YA_TRANSFERIDA y NO queda nada a medias (orden sin revertir, plata en la caja de la empresa)',
      /ORDEN_YA_TRANSFERIDA/.test(msg(pedido.err)) && ord.revertida_en === null && await saldo(admin, 'ARS transferencia') === 85000 && await saldo(admin, 'ARS Mercado Pago') === 0, msg(pedido.err));
  }
  await reiniciarCajas(admin);

  // ── 3. Revertir ‖ transferir ──────────────────────────────────────────────
  {
    const x = await acreditada(admin, ctx);
    await A.query('BEGIN');
    await revertir(A, x.orden);
    const pedido = lanzar(B, `SELECT public.actividad_transferir($1,1,$2,'ARS transferencia',NULL) AS r`, [x.act, p.id]);
    const espera = await esperaCandado(C, B.pid, A.pid);
    check('3.a Transferir mientras A revierte la orden ESPERA a A', espera && !pedido.hecho);
    await A.query('COMMIT'); await pedido.fin;
    const d = await act(admin, x.act);
    check('3.b Al confirmar A, la transferencia falla (actividad anulada), la plata volvió entera y nada se movió a la empresa',
      !!pedido.err && /ACTIVIDAD_ANULADA|ORDEN_NO_TRANSFERIBLE/.test(msg(pedido.err)) && d.estado === 'anulada' && await saldo(admin, 'ARS Mercado Pago') === 0 && await saldo(admin, 'ARS transferencia') === 0, msg(pedido.err));
  }
  await reiniciarCajas(admin);

  // ── 4. Transferir ‖ solo marcar, en los dos sentidos ──────────────────────
  {
    const x = await acreditada(admin, ctx);
    await A.query('BEGIN'); await transferir(A, x.act, p.id);
    const pedido = lanzar(B, `SELECT public.actividad_marcar_hecha($1,$2,NULL) AS r`, [x.act, 1]);
    const espera = await esperaCandado(C, B.pid, A.pid);
    await A.query('COMMIT'); await pedido.fin;
    const d = await act(admin, x.act);
    check('4.a «Solo marcar» mientras A transfiere ESPERA y después se RECHAZA (ACTIVIDAD_DESACTUALIZADA: la actividad cambió desde que se vio; nunca un éxito falso); la actividad movió plata',
      espera && /ACTIVIDAD_DESACTUALIZADA|ACTIVIDAD_YA_TRANSFERIDA/.test(msg(pedido.err)) && d.movio_plata === true && await saldo(admin, 'ARS transferencia') === 85000, msg(pedido.err));
    await reiniciarCajas(admin);
    const y = await acreditada(admin, ctx);
    await A.query('BEGIN'); await marcar(A, y.act);
    const pedido2 = lanzar(B, `SELECT public.actividad_transferir($1,1,$2,'ARS transferencia',NULL) AS r`, [y.act, p.id]);
    const espera2 = await esperaCandado(C, B.pid, A.pid);
    await A.query('COMMIT'); await pedido2.fin;
    const d2 = await act(admin, y.act);
    check('4.b Transferir mientras A solo marca ESPERA y después falla con ACTIVIDAD_YA_MARCADA_SIN_MOVER; no se movió plata',
      espera2 && /ACTIVIDAD_YA_MARCADA_SIN_MOVER/.test(msg(pedido2.err)) && d2.movio_plata === false && d2.estado === 'hecha' && await saldo(admin, 'ARS transferencia') === 0 && await saldo(admin, 'ARS Mercado Pago') === 85000, msg(pedido2.err));
  }
  await reiniciarCajas(admin);

  // ── 5. Dos actividades que comparten saldo ────────────────────────────────
  {
    const x = await acreditada(admin, ctx), y = await acreditada(admin, ctx);   // caja MP = 170000
    await admin.query(`UPDATE public.cajas SET saldo = 85000 WHERE bolsillo = 'ARS Mercado Pago'`);   // alcanza para UNA sola
    await admin.query(`DELETE FROM public.caja_ledger`);
    await A.query('BEGIN'); await transferir(A, x.act, p.id);
    const pedido = lanzar(B, `SELECT public.actividad_transferir($1,1,$2,'ARS transferencia',NULL) AS r`, [y.act, p.id]);
    const espera = await esperaCandado(C, B.pid, A.pid);
    check('5.a La segunda transferencia ESPERA por la caja que tiene A (otra actividad, otra orden, misma caja)', espera && !pedido.hecho);
    await A.query('COMMIT'); await pedido.fin;
    check('5.b Al confirmar A, la segunda falla con SALDO_INSUFICIENTE: una sola transfirió y el saldo NUNCA quedó negativo',
      /SALDO_INSUFICIENTE/.test(msg(pedido.err)) && await saldo(admin, 'ARS Mercado Pago') === 0 && await saldo(admin, 'ARS transferencia') === 85000 && (await act(admin, y.act)).estado === 'pendiente', msg(pedido.err));
  }
  await reiniciarCajas(admin);

  // ── 6. Acreditar ‖ revertir ───────────────────────────────────────────────
  {
    const item = 'MLA' + String(++nItem + 5000).padStart(9, '0');
    const s = await nuevoStock(admin, { nombre: 'Perfume ' + item, cantidad: 50 });
    await admin.query(`SELECT public.meli_publicacion_vincular($1,$2,$3,NULL,$4,NULL,'t',10,'franco@x.com')`, [SECRETO, ctx.cuentaId, item, s]);
    const o = await nuevaOrden({ db: admin, cuentaId: ctx.cuentaId }, [{ item, cant: 1, precio: 100000, stock: s }]);
    await admin.query(`SELECT public.meli_procesar_orden($1, 1000)`, [o]);
    await A.query('BEGIN'); await A.query(`SELECT public.meli_acreditar_orden($1, NULL, false)`, [o]);
    const pedido = lanzar(B, `SELECT public.meli_revertir_orden($1,'prueba') AS r`, [o]);
    const espera = await esperaCandado(C, B.pid, A.pid);
    await A.query('COMMIT'); await pedido.fin;
    const a = (await q(admin, `SELECT * FROM public.actividades WHERE origen_orden_id=$1`, [o]))[0];
    check('6 Acreditar ‖ revertir: revertir espera, y al final la actividad queda anulada y las cajas en cero (sin duplicar ni perder)',
      espera && !pedido.err && a && a.estado === 'anulada' && await saldo(admin, 'ARS Mercado Pago') === 0 && await saldo(admin, 'ARS transferencia') === 0, msg(pedido.err));
  }
  await reiniciarCajas(admin);

  // ── 6b. Reintento tardío de «transferir» después de compensar y con otra conexión ──
  {
    const x = await acreditada(admin, ctx);
    await admin.query(`SELECT public.actividad_transferir($1,1,$2,'ARS transferencia',NULL)`, [x.act, p.id]);
    await admin.query(`SELECT public.actividad_compensar($1,1,NULL)`, [x.act]);
    const antes = await saldo(admin, 'ARS transferencia');
    await A.query('BEGIN'); await A.query(`SELECT public.actividad_transferir($1,2,$2,'ARS transferencia',NULL)`, [x.act, p.id]);   // transferencia nueva (intento 2), sin confirmar
    const retraso = lanzar(B, `SELECT public.actividad_transferir($1,1,$2,'ARS transferencia',NULL) AS r`, [x.act, p.id]);              // reintento atrasado del intento 1
    const espera = await esperaCandado(C, B.pid, A.pid);
    await A.query('COMMIT'); await retraso.fin;
    check('6b Un reintento atrasado (intento 1) que llega mientras se hace la transferencia nueva ESPERA y después se rechaza (ACTIVIDAD_DESACTUALIZADA): la plata se movió UNA vez',
      espera && /ACTIVIDAD_DESACTUALIZADA/.test(msg(retraso.err)) && await saldo(admin, 'ARS transferencia') === antes + 85000, msg(retraso.err));
  }
  await reiniciarCajas(admin);

  // ── 7. ESFUERZO ───────────────────────────────────────────────────────────
  {
    const N = 8;
    const ords = [];
    for (let i = 0; i < N; i++) ords.push(await acreditada(admin, ctx));
    const NEGOCIO = /ACTIVIDAD_|ORDEN_|SALDO_INSUFICIENTE|DESTINO_|CAJA_|FALTA_|NO_TRANSFERIBLE/;
    const stat = { ok: 0, negocio: 0, deadlock: 0, otros: 0, porOp: {} };
    const ops = [
      async (c, o) => c.query(`SELECT public.actividad_transferir($1,$2,$3,'ARS transferencia',NULL)`, [o.act, await intentoDe(c, o.act), p.id]),
      async (c, o) => c.query(`SELECT public.actividad_marcar_hecha($1,$2,NULL)`, [o.act, await revisionDe(c, o.act)]),
      async (c, o) => c.query(`SELECT public.actividad_reabrir($1,$2)`, [o.act, await revisionDe(c, o.act)]),
      async (c, o) => c.query(`SELECT public.actividad_compensar($1,$2,NULL)`, [o.act, await intentoDe(c, o.act)]),
      (c, o) => c.query(`SELECT public.meli_revertir_orden($1,'esfuerzo')`, [o.orden]),
    ];
    const nombres = ['transferir', 'marcar', 'reabrir', 'compensar', 'revertir'];
    const trabajador = async (c, veces) => {
      for (let k = 0; k < veces; k++) {
        const o = ords[Math.floor(Math.random() * ords.length)];
        const i = Math.floor(Math.random() * (k % 17 === 16 ? 5 : 4));   // revertir es raro (una de cada 17 vueltas)
        try { await ops[i](c, o); stat.ok++; stat.porOp[nombres[i]] = (stat.porOp[nombres[i]] || 0) + 1; }
        catch (e) {
          if (e.code === '40P01') { stat.deadlock++; errores.push('DEADLOCK ' + nombres[i]); }
          else if (NEGOCIO.test(msg(e))) stat.negocio++;
          else { stat.otros++; errores.push(nombres[i] + ': ' + msg(e)); }
        }
      }
    };
    const W = [await conn(), await conn(), await conn(), await conn()];
    for (let ronda = 0; ronda < 3; ronda++) await Promise.all(W.map((c) => trabajador(c, 60)));
    check(`7.a ESFUERZO (${stat.ok} operaciones OK, ${stat.negocio} rechazos de negocio esperados): CERO deadlocks y cero errores inesperados`, stat.deadlock === 0 && stat.otros === 0, errores.slice(0, 5).join(' | '));
    check(`7.b Hubo mezcla real: ${JSON.stringify(stat.porOp)}`, (stat.porOp.transferir || 0) >= 10 && (stat.porOp.marcar || 0) >= 10 && stat.ok >= 150, JSON.stringify(stat));
    // invariantes de plata
    const cajas = await q(admin, `SELECT bolsillo, saldo::numeric s FROM public.cajas`);
    const libro = await q(admin, `SELECT bolsillo, COALESCE(sum(delta),0)::numeric s FROM public.caja_ledger GROUP BY bolsillo`);
    const libroDe = (b) => Number((libro.find(x => x.bolsillo === b) || { s: 0 }).s);
    check('7.c El LIBRO cuadra con los saldos en cada caja', cajas.every(c => Math.abs(Number(c.s) - libroDe(c.bolsillo)) < 0.005), JSON.stringify([cajas, libro]));
    check('7.d Ninguna caja quedó negativa', cajas.every(c => Number(c.s) >= 0), JSON.stringify(cajas));
    const esperado = Number((await q(admin, `SELECT COALESCE(sum(monto_acreditado),0)::numeric s FROM public.meli_ordenes WHERE acreditado AND revertida_en IS NULL AND id = ANY($1)`, [ords.map(o => o.orden)]))[0].s);
    const totalCajas = cajas.reduce((a, c) => a + Number(c.s), 0);
    check(`7.e La plata total (${totalCajas}) = lo acreditado y NO revertido (${esperado}): transferir y compensar no crean ni pierden plata`, Math.abs(totalCajas - esperado) < 0.005);
    const acts = await q(admin, `SELECT a.*, o.revertida_en FROM public.actividades a JOIN public.meli_ordenes o ON o.id = a.origen_orden_id WHERE a.id = ANY($1)`, [ords.map(o => o.act)]);
    let incoherentes = [];
    for (const a of acts) {
      const claves = (await q(admin, `SELECT clave FROM public.caja_ledger WHERE clave LIKE $1`, [`act-${a.token}-%`])).map(x => x.clave);
      const tiene = (pref) => claves.filter(k => k.startsWith(pref)).length;
      if (a.movio_plata && (tiene(`act-${a.token}-t${a.intento}:o`) !== 1 || tiene(`act-${a.token}-t${a.intento}:d`) !== 1)) incoherentes.push(`#${a.id} dice movió plata pero el libro no lo muestra`);
      if (!a.movio_plata && a.intento > 1 && tiene(`act-${a.token}-c${a.intento - 1}:o`) !== 1) incoherentes.push(`#${a.id} fue compensada pero falta el asiento`);
      if (a.revertida_en && a.movio_plata) incoherentes.push(`#${a.id}: orden revertida con plata transferida`);
      if (a.revertida_en && a.estado === 'pendiente') incoherentes.push(`#${a.id}: orden revertida y actividad pendiente`);
    }
    check('7.f Cada actividad es coherente con el libro (movió plata ⇒ tiene sus dos asientos; compensada ⇒ asiento inverso; orden revertida ⇒ nunca con plata transferida ni pendiente)', incoherentes.length === 0, incoherentes.join(' | '));
  }
  const colgadas = (await admin.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)).rows[0].n;
  check('Al terminar no queda ninguna conexión esperando un candado (nada colgado)', colgadas === 0, String(colgadas));
} finally {
  clearTimeout(reloj);
  await limpiar();
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
