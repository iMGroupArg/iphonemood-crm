// Banco de CONCURRENCIA de la creación de presupuestos por el bot (script 13): un Postgres REAL (embedded-postgres) con VARIAS
// CONEXIONES a la vez. pglite tiene una sola conexión y no puede probar carreras.
//
//   cd tests/sql && node presupuesto_bot.concurrencia.test.mjs
//
//   1. Mismo pedido (misma clave) desde varias conexiones a la vez: UN solo presupuesto, todos reciben el mismo link, y el cupo del
//      día se gasta UNA vez.
//   2. Muchos pedidos DISTINTOS a la vez: el tope por minuto nunca se pasa (exactamente 5 entran).
//   3. Muchos pedidos distintos a la vez con tope diario 7: nunca se pasa (exactamente 7 entran) y el contador coincide con las filas.
//   4. Esfuerzo: creación + lectura del link + limpieza de teléfonos a la vez: cero deadlocks y cero errores inesperados.
// LÍMITE HONESTO: PostgreSQL 18 beta (el de embedded-postgres); Supabase corre otra versión.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AQUI, SQL, ESQUEMA_MINIMO } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const azar = (n) => Math.floor(Math.random() * n);
const SECRETO = 'secreto-de-prueba-del-bot-0123456789abcdef';
const MIGRACION = fs.readFileSync(path.join(AQUI, '../../db/migrations/20260820_presupuestos.sql'), 'utf8');
const PAGOS = { contado_factor: 1, lista_factor: 1.45, promo: { titulo: 'P', vigencia: 'x', cuotas: [{ n: 3, mostrar: true, coef: 1.2 }] } };

async function arrancar() {
  let ultimo = null;
  for (let intento = 0; intento < 5; intento++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-presbot-'));
    const port = 55000 + Math.floor(Math.random() * 3000);
    const srv = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'x', port, persistent: false, onLog: () => {}, onError: () => {} });
    try {
      await srv.initialise(); await srv.start();
      const conectar = async () => {
        const c = new pg.Client({ host: 'localhost', port, user: 'postgres', password: 'x', database: 'postgres' });
        await c.connect();
        await c.query(`SELECT set_config('request.jwt.claims', '{"email":"franco@x.com"}', false)`);
        await c.query(`SET deadlock_timeout = '100ms'`);
        c.pid = (await c.query('SELECT pg_backend_pid() AS p')).rows[0].p;
        return c;
      };
      return { srv, dir, conectar };
    } catch (e) { ultimo = e; try { await srv.stop(); } catch { /* no había arrancado */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sin acceso */ } }
  }
  throw new Error('No se pudo arrancar Postgres: ' + (ultimo && ultimo.message));
}

const errores = [];
const anotar = (donde, e) => errores.push(`${donde}: ${e.code || ''} ${String(e.message).slice(0, 120)}`);
const codigo = (e) => (String((e && e.message) || '').match(/[A-Z_]{6,}/) || [''])[0];

console.log('\n══ Presupuestos del bot bajo concurrencia (Postgres real, varias conexiones) ══\n');
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
  await admin.query(ESQUEMA_MINIMO);
  await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions');
  for (const f of ['catalogo_modelos_publico.sql', 'canje_ultimo_precio_publico.sql']) await admin.query(SQL(f));
  await admin.query(MIGRACION);
  for (const f of ['presupuesto_por_token_lista.sql', 'stock_a_pedido.sql', 'presupuesto_bot.sql']) await admin.query(SQL(f));
  await admin.query(`UPDATE public.presupuesto_bot_config SET valor = $1 WHERE clave = 'rpc_secret_sha256'`, [crypto.createHash('sha256').update(SECRETO).digest('hex')]);
  await admin.query(`INSERT INTO public.configuracion (clave, valor) VALUES ('ref_blue', '1500'), ('pagos_config', $1)`, [JSON.stringify(PAGOS)]);
  const { rows: [un] } = await admin.query(`INSERT INTO public.stock (nombre, categoria, modelo, storage, color, estado_producto, precio_ars, cotizacion, cantidad, estado_inventario, costo_usd)
    VALUES ('iPhone 15 128GB','iphone','iPhone 15','128GB','Negro','Nuevo / Sellado',1200000,1500,5,'disponible',500) RETURNING id`);
  const cons = await Promise.all(Array.from({ length: 8 }, nueva));
  let nIdem = 0;
  // Claves sin 8 dígitos seguidos (la función las rechaza): el número va en base 36 con una letra delante y el azar sin dígitos.
  const clave = () => `k${(++nIdem).toString(36)}x${crypto.randomBytes(5).toString('hex').replace(/[0-9]/g, (d) => 'ghijklmnop'[d])}`;
  const crear = (c, idem, extra = {}) => c.query(`SELECT public.presupuesto_bot_crear($1,$2,1,NULL,'Juan',$3,'whatsapp',$4) AS r`, [SECRETO, un.id, extra.tel ?? '+5491155550123', idem]).then((x) => ({ ok: true, r: x.rows[0].r }), (e) => ({ ok: false, e }));
  const filas = async () => (await admin.query(`SELECT count(*)::int n FROM public.presupuestos WHERE origen='bot'`)).rows[0].n;
  const uso = async () => (await admin.query(`SELECT COALESCE(sum(n),0)::int n FROM public.presupuesto_bot_uso`)).rows[0].n;
  const reset = async () => { await admin.query(`DELETE FROM public.presupuestos`); await admin.query(`DELETE FROM public.presupuesto_bot_uso`); };
  const cfg = (k, v) => admin.query(`UPDATE public.presupuesto_bot_config SET valor=$2 WHERE clave=$1`, [k, String(v)]);
  await cfg('tope_por_minuto', 1000); await cfg('tope_diario', 100000);

  // ── 1 · El mismo pedido desde varias conexiones ───────────────────────────
  {
    let mal = 0, errs = 0, reutilizados = 0;
    for (let i = 0; i < 40; i++) {
      await reset();
      const k = clave();
      const rs = await Promise.all(cons.slice(0, 4).map(async (c) => { await dormir(azar(6)); return crear(c, k); }));
      if (rs.some((x) => !x.ok)) { errs++; rs.filter((x) => !x.ok).forEach((x) => anotar('misma clave', x.e)); continue; }
      const tokens = new Set(rs.map((x) => x.r.token));
      reutilizados += rs.filter((x) => x.r.reutilizado).length;
      if (tokens.size !== 1 || await filas() !== 1 || await uso() !== 1 || rs.filter((x) => !x.r.reutilizado).length !== 1) mal++;
    }
    check('1 Cuatro conexiones piden el MISMO presupuesto (misma clave) a la vez, 40 veces: UNA fila, todas reciben el mismo link, el cupo del día se gasta UNA vez', mal === 0 && errs === 0, JSON.stringify({ mal, errs }));
    check(`1 … y en cada ronda exactamente una lo creó y las otras tres lo reutilizaron (${reutilizados} reutilizaciones)`, reutilizados === 120, String(reutilizados));
  }

  // ── 2 · Tope por minuto con claves distintas ───────────────────────────────
  {
    await cfg('tope_por_minuto', 5);
    let mal = 0, errs = 0;
    for (let i = 0; i < 12; i++) {
      await reset();
      const rs = await Promise.all(Array.from({ length: 8 }, (_, j) => (async () => { await dormir(azar(5)); return crear(cons[j], clave(), { tel: `+54911555${String(j).padStart(5, '0')}` }); })()));
      const creados = rs.filter((x) => x.ok).length, topes = rs.filter((x) => !x.ok && codigo(x.e) === 'DEMASIADOS_PEDIDOS').length;
      rs.filter((x) => !x.ok && codigo(x.e) !== 'DEMASIADOS_PEDIDOS').forEach((x) => { errs++; anotar('tope minuto', x.e); });
      if (creados !== 5 || topes !== 3 || await filas() !== 5) mal++;
    }
    check('2 Ocho pedidos DISTINTOS a la vez con tope 5 por minuto, 12 veces: entran EXACTAMENTE 5, 3 reciben DEMASIADOS_PEDIDOS, y nunca se pasa', mal === 0 && errs === 0, JSON.stringify({ mal, errs }));
  }

  // ── 3 · Tope diario con claves distintas ───────────────────────────────────
  {
    await cfg('tope_por_minuto', 1000); await cfg('tope_diario', 7);
    let mal = 0, errs = 0;
    for (let i = 0; i < 8; i++) {
      await reset();
      const rs = await Promise.all(Array.from({ length: 16 }, (_, j) => (async () => { await dormir(azar(5)); return crear(cons[j % 8], clave(), { tel: null }); })()));
      const creados = rs.filter((x) => x.ok).length, topes = rs.filter((x) => !x.ok && codigo(x.e) === 'TOPE_DIARIO').length;
      rs.filter((x) => !x.ok && codigo(x.e) !== 'TOPE_DIARIO').forEach((x) => { errs++; anotar('tope diario', x.e); });
      if (creados !== 7 || topes !== 9 || await filas() !== 7 || await uso() !== 7) mal++;
    }
    check('3 Dieciséis pedidos distintos a la vez con tope diario 7, 8 veces: entran EXACTAMENTE 7, el contador vale 7 y hay 7 filas', mal === 0 && errs === 0, JSON.stringify({ mal, errs }));
  }

  // ── 4 · Esfuerzo: crear + leer el link + limpiar teléfonos ─────────────────
  {
    await reset(); await cfg('tope_por_minuto', 100000); await cfg('tope_diario', 100000);
    let deadlocks = 0, errs = 0, creados = 0, lecturas = 0, limpiezas = 0;
    const anota = (d) => (e) => { errs++; if (e.code === '40P01') deadlocks++; anotar(d, e); };
    const fin = Date.now() + 20000, parar = () => Date.now() > fin;
    const tokens = [];
    const creador = async (c) => { while (!parar()) { const x = await crear(c, clave()); if (x.ok) { creados++; tokens.push(x.r.token); } else if (!['DEMASIADOS_PEDIDOS', 'TOPE_DIARIO'].includes(codigo(x.e))) anota('crear')(x.e); await dormir(1); } };
    const lector = async (c) => { while (!parar()) { const t = tokens[azar(Math.max(tokens.length, 1))]; if (t) { await c.query(`SELECT public.presupuesto_por_token($1)`, [t]).then(() => { lecturas++; }, anota('leer')); } await dormir(1); } };
    const limpiador = async (c) => { while (!parar()) { await admin.query(`UPDATE public.presupuestos SET contacto_borrar_en = now() - interval '1 day' WHERE id IN (SELECT id FROM public.presupuestos WHERE contacto IS NOT NULL LIMIT 5)`).catch(() => {});
      await c.query(`SELECT public.presupuestos_limpiar_contactos_cron($1)`, [SECRETO]).then(() => { limpiezas++; }, anota('limpiar')); await dormir(2); } };
    await Promise.all([creador(cons[0]), creador(cons[1]), creador(cons[2]), lector(cons[3]), lector(cons[4]), limpiador(cons[5]), limpiador(cons[6])]);
    const dup = (await admin.query(`SELECT count(*)::int n FROM (SELECT idempotencia FROM public.presupuestos GROUP BY 1 HAVING count(*) > 1) x`)).rows[0].n;
    check(`4 Esfuerzo 20 s (${creados} creados, ${lecturas} lecturas del link, ${limpiezas} limpiezas): CERO deadlocks y cero errores inesperados`, deadlocks === 0 && errs === 0 && creados > 50, JSON.stringify({ deadlocks, errs, creados, ejemplos: errores.slice(0, 3) }));
    check('4 … y el contador diario coincide con las filas creadas, sin claves repetidas', await uso() === await filas() && dup === 0, `${await uso()} ${await filas()} ${dup}`);
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
