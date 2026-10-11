// Banco de CONCURRENCIA del barrido (script 10): un Postgres REAL (embedded-postgres) y VARIAS CONEXIONES a la vez.
//
//   cd tests/sql && node barrido.concurrencia.test.mjs
//
// Prueba lo que pglite (una sola conexión) no puede:
//   1. dos corridas a la vez sobre la misma cuenta (cron + botón): UNA sola gana, la otra espera y recibe EN_CURSO.
//   2. avanzar contra cerrar: lo "cubierto" nunca pasa de lo que realmente quedó encolado.
//   3. el webhook (registrar) contra el reintento / la devolución de un aviso en proceso: nunca un error, nunca dos
//      pendientes libres iguales, y nunca se pierde la actualización.
//   4. muchos registrar iguales a la vez: una sola fila pendiente.
//   5. el barrido contra el worker (reclamar / resultado) a la vez: cero deadlocks y cero errores.
// LÍMITE HONESTO: PostgreSQL 18 beta (el que trae embedded-postgres); Supabase corre otra versión.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SQL, SECRETO, ESQUEMA_MINIMO, ventasConParche } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const azar = (n) => Math.floor(Math.random() * n);
const CLAIMS = JSON.stringify({ email: 'franco@x.com' });

async function arrancar() {
  let ultimo = null;
  for (let intento = 0; intento < 5; intento++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-barrido-'));
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
  await admin.query(SQL('meli_barrido.sql'));
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

const rpc = async (c, fn, args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(',');
  return (await c.query(`SELECT public.${fn}(${ph}) AS r`, args)).rows[0].r;
};
const errores = [];
const anotar = (donde, e) => errores.push(`${donde}: ${e.code || ''} ${String(e.message).slice(0, 120)}`);

console.log('\n══ Barrido bajo concurrencia (Postgres real, varias conexiones) ══\n');

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
  let n = 0;
  const cuentaNueva = async () => (await admin.query(`INSERT INTO public.meli_cuentas (meli_user_id, nickname, persona_id, bolsillo, refresh_token, access_token, creado_en)
      VALUES ($1,$2,$3,'ARS Mercado Pago','r','a', now() - interval '5 days') RETURNING id`, [`7${++n}`, `C${n}`, p.id])).rows[0].id;
  const [c1, c2, c3, c4, c5, c6] = await Promise.all([nueva(), nueva(), nueva(), nueva(), nueva(), nueva()]);

  // ── 1 · Dos corridas a la vez: una sola gana ───────────────────────────
  {
    const cuenta = await cuentaNueva();
    let dobles = 0, ningunaGano = 0, errs = 0, esperas = 0;
    for (let i = 0; i < 40; i++) {
      const orig = i % 2 ? 'cron' : 'boton';
      const a = rpc(c1, 'meli_barrido_iniciar', [SECRETO, cuenta, 'cron', null, 30, 0]).catch((e) => { errs++; anotar('iniciar', e); return null; });
      const b = rpc(c2, 'meli_barrido_iniciar', [SECRETO, cuenta, orig, null, 30, 0]).catch((e) => { errs++; anotar('iniciar', e); return null; });
      const [ra, rb] = await Promise.all([a, b]);
      const ganadoras = [ra, rb].filter((x) => x && x.ok === true);
      if (ganadoras.length > 1) dobles++;
      if (ganadoras.length === 0) ningunaGano++;
      const otra = [ra, rb].find((x) => x && x.ok === false);
      if (otra && otra.motivo !== 'EN_CURSO') errs++;
      if (ganadoras[0]) await rpc(c3, 'meli_barrido_cerrar', [SECRETO, cuenta, ganadoras[0].barrido_id, false, 'X']);
    }
    check('1 Dos corridas simultáneas (cron + botón) 40 veces: UNA sola gana siempre, la otra recibe EN_CURSO, cero errores', dobles === 0 && ningunaGano === 0 && errs === 0, JSON.stringify({ dobles, ningunaGano, errs }));
    const enCurso = (await admin.query(`SELECT count(*)::int n FROM public.meli_barridos WHERE cuenta_id=$1 AND estado='en_curso'`, [cuenta])).rows[0].n;
    check('1 … y no queda ninguna corrida colgada en curso', enCurso === 0, String(enCurso));

    // La segunda espera de verdad (se bloquea contra el bloqueo de la cuenta)
    await admin.query('BEGIN');
    await admin.query(`SELECT 1 FROM public.meli_cuentas WHERE id=$1 FOR UPDATE`, [cuenta]);
    const lanzada = rpc(c4, 'meli_barrido_iniciar', [SECRETO, cuenta, 'cron', null, 30, 120]);
    const espera = await esperaCandado(c5, c4.pid);
    await admin.query('COMMIT');
    const rr = await lanzada;
    check('1 Iniciar una corrida ESPERA si la cuenta está bloqueada por otra transacción (no corre en paralelo) y después procede', espera && rr.ok === true, JSON.stringify({ espera, rr }));
    await rpc(c3, 'meli_barrido_cerrar', [SECRETO, cuenta, rr.barrido_id, false, 'X']);
  }

  // ── 2 · Avanzar contra cerrar: lo cubierto nunca pasa de lo encolado ──────────
  {
    const cuenta = await cuentaNueva();
    let invalidos = 0, errs = 0, avanzaGano = 0, cerroPrimero = 0;
    for (let i = 0; i < 60; i++) {
      await admin.query(`DELETE FROM public.meli_barrido_estado WHERE cuenta_id=$1`, [cuenta]);
      await admin.query(`DELETE FROM public.meli_notificaciones`);
      await admin.query(`UPDATE public.meli_barridos SET estado='vencido' WHERE cuenta_id=$1 AND estado='en_curso'`, [cuenta]);
      const t = await rpc(c1, 'meli_barrido_iniciar', [SECRETO, cuenta, 'cron', null, 30, 0]);
      const mitad = new Date((Date.parse(t.desde) + Date.parse(t.hasta)) / 2).toISOString();
      const ord = JSON.stringify([{ id: String(9000 + i), last_updated: t.desde }]);
      const lanzar = async (f, ms) => { await dormir(ms); return f().catch((e) => { errs++; anotar('av/cerrar', e); return null; }); };
      const [av, ce] = await Promise.all([
        lanzar(() => rpc(c2, 'meli_barrido_avanzar', [SECRETO, cuenta, t.barrido_id, t.desde, mitad, ord, false]), azar(8)),
        lanzar(() => rpc(c3, 'meli_barrido_cerrar', [SECRETO, cuenta, t.barrido_id, true, null]), azar(8)),
      ]);
      const encolada = (await admin.query(`SELECT count(*)::int n FROM public.meli_notificaciones WHERE recurso = $1`, ['/orders/' + (9000 + i)])).rows[0].n;
      const est = (await admin.query(`SELECT cubierto_hasta FROM public.meli_barrido_estado WHERE cuenta_id=$1`, [cuenta])).rows[0];
      const cubierto = est && est.cubierto_hasta ? new Date(est.cubierto_hasta).getTime() : null;
      if (!av || !ce) continue;
      if (av.ok) {
        avanzaGano++;
        // Si avanzar entró, la orden está encolada. Y si cerrar vio ese avance, lo cubierto llega a `mitad` y no más.
        if (encolada !== 1) invalidos++;
        if (ce.ok && cubierto !== null && cubierto > Date.parse(mitad)) invalidos++;
      } else {
        cerroPrimero++;
        // Si cerrar entró primero, avanzar fue rechazado: NO hay orden encolada y lo cubierto no se movió.
        if (encolada !== 0 || cubierto !== null) invalidos++;
      }
      if (av.ok && ce.ok && ce.estado !== 'fallido' && (cubierto === null || cubierto < Date.parse(mitad))) invalidos++;
    }
    check(`2 Avanzar y cerrar a la vez 60 veces (avanzar ganó ${avanzaGano}, cerrar primero ${cerroPrimero}): lo cubierto nunca pasa de lo encolado y no hay errores`, invalidos === 0 && errs === 0 && avanzaGano > 0 && cerroPrimero > 0, JSON.stringify({ invalidos, errs, avanzaGano, cerroPrimero }));
  }

  // ── 3 · El webhook contra el reintento / la devolución del aviso en proceso ─────
  {
    let errs = 0, dobles = 0, sinPendiente = 0, rondas = 0;
    for (const variante of ['resultado', 'devolver']) {
      for (let i = 0; i < 80; i++) {
        rondas++;
        const rec = `/orders/${variante === 'resultado' ? 100 : 200}${i}`;
        await admin.query(`INSERT INTO public.meli_notificaciones (meli_user_id, topico, recurso) VALUES ('71','orders_v2',$1)`, [rec]);
        const [A] = (await c1.query(`SELECT * FROM public.meli_notificacion_reclamar($1, 50)`, [SECRETO])).rows.filter((x) => x.recurso === rec);
        const reg = async () => { await dormir(azar(6)); return rpc(c2, 'meli_notificacion_registrar', [SECRETO, '71', 'orders_v2', rec, '{}']).catch((e) => { errs++; anotar('registrar', e); }); };
        const dev = async () => {
          await dormir(azar(6));
          return (variante === 'resultado'
            ? rpc(c3, 'meli_notificacion_resultado', [SECRETO, A.id, A.lease_id, false, false, 'HTTP 502', 8])
            : rpc(c3, 'meli_notificacion_devolver', [SECRETO, [A.id], [A.lease_id]])).catch((e) => { errs++; anotar(variante, e); });
        };
        await Promise.all([reg(), dev()]);
        const libres = (await admin.query(`SELECT count(*)::int n FROM public.meli_notificaciones WHERE recurso=$1 AND estado='pendiente' AND lease_id IS NULL`, [rec])).rows[0].n;
        if (libres > 1) dobles++;
        if (libres === 0) sinPendiente++;
        await admin.query(`DELETE FROM public.meli_notificaciones WHERE recurso=$1`, [rec]);
      }
    }
    check(`3 Webhook contra reintento y contra devolución (${rondas} rondas con tiempos al azar): cero errores, nunca dos pendientes libres, y SIEMPRE queda uno pendiente (no se pierde la actualización)`, errs === 0 && dobles === 0 && sinPendiente === 0, JSON.stringify({ errs, dobles, sinPendiente }));
  }

  // ── 4 · Muchos avisos iguales a la vez: una sola fila pendiente ──────────────
  {
    let errs = 0, mal = 0;
    const cons = [c1, c2, c3, c4, c5, c6];
    for (let i = 0; i < 40; i++) {
      const rec = `/orders/400${i}`;
      const ids = await Promise.all(cons.map((c) => rpc(c, 'meli_notificacion_registrar', [SECRETO, '71', 'orders_v2', rec, '{}']).catch((e) => { errs++; anotar('registrar x6', e); return null; })));
      const filas = (await admin.query(`SELECT id FROM public.meli_notificaciones WHERE recurso=$1`, [rec])).rows;
      if (filas.length !== 1 || ids.some((x) => String(x) !== String(filas[0].id))) mal++;
    }
    check('4 Seis avisos iguales a la vez, 40 veces: una sola fila y todos reciben ese mismo id', errs === 0 && mal === 0, JSON.stringify({ errs, mal }));
  }

  // ── 5 · El barrido contra el worker: cero deadlocks ──────────────────────────
  {
    const cuenta = await cuentaNueva();
    await admin.query(`DELETE FROM public.meli_notificaciones`);
    let errs = 0, deadlocks = 0, rondas = 0;
    const fin = Date.now() + 25000;
    const parar = () => Date.now() > fin;
    const anota = (d) => (e) => { errs++; if (e.code === '40P01') deadlocks++; anotar(d, e); };
    const barrido = (async () => {
      while (!parar()) {
        rondas++;
        const t = await rpc(c1, 'meli_barrido_iniciar', [SECRETO, cuenta, 'cron', null, 30, 0]).catch(anota('iniciar'));
        if (!t || !t.ok) continue;
        const ords = JSON.stringify(Array.from({ length: 30 }, (_, k) => ({ id: String(50000 + (rondas * 7 + k) % 80), last_updated: t.desde })));
        await rpc(c1, 'meli_barrido_avanzar', [SECRETO, cuenta, t.barrido_id, t.desde, t.hasta, ords, false]).catch(anota('avanzar'));
        await rpc(c1, 'meli_barrido_reparar', [SECRETO, cuenta, t.barrido_id, 20, 60, 3]).catch(anota('reparar'));
        await rpc(c1, 'meli_barrido_cerrar', [SECRETO, cuenta, t.barrido_id, true, null]).catch(anota('cerrar'));
      }
    })();
    const worker = async (c) => {
      while (!parar()) {
        const lote = (await c.query(`SELECT * FROM public.meli_notificacion_reclamar($1, 3)`, [SECRETO]).catch(anota('reclamar')))?.rows || [];
        for (const a of lote) {
          const r = azar(4);
          if (r === 0) await rpc(c, 'meli_notificacion_resultado', [SECRETO, a.id, a.lease_id, true, false, null, 8]).catch(anota('resultado ok'));
          else if (r === 1) await rpc(c, 'meli_notificacion_resultado', [SECRETO, a.id, a.lease_id, false, false, 'x', 8]).catch(anota('resultado reintento'));
          else if (r === 2) await rpc(c, 'meli_notificacion_devolver', [SECRETO, [a.id], [a.lease_id]]).catch(anota('devolver'));
          else await rpc(c, 'meli_notificacion_resultado', [SECRETO, a.id, a.lease_id, false, true, 'terminal', 8]).catch(anota('resultado terminal'));
        }
        await c.query(`UPDATE public.meli_notificaciones SET proximo_intento = now() WHERE estado='pendiente'`).catch(() => {});
        await dormir(2);
      }
    };
    const webhook = (async () => { let k = 0; while (!parar()) { await rpc(c4, 'meli_notificacion_registrar', [SECRETO, '7' + n, 'orders_v2', `/orders/${50000 + (k++ % 80)}`, '{}']).catch(anota('webhook')); await dormir(1); } })();
    await Promise.all([barrido, worker(c2), worker(c3), webhook]);
    check(`5 Barrido + 2 workers + webhook a la vez durante 25 s (${rondas} corridas): CERO deadlocks y cero errores inesperados`, errs === 0 && deadlocks === 0 && rondas > 20, JSON.stringify({ errs, deadlocks, rondas, ejemplos: errores.slice(0, 3) }));
    const libres = (await admin.query(`SELECT count(*)::int n, count(DISTINCT recurso)::int d FROM public.meli_notificaciones WHERE estado='pendiente' AND lease_id IS NULL`)).rows[0];
    check('5 … y al final no hay dos pendientes libres iguales', libres.n === libres.d, JSON.stringify(libres));
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
