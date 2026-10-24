// Banco de CONCURRENCIA del reparto entre cargas del mismo producto (script 19): Postgres REAL (embedded-postgres) y VARIAS
// CONEXIONES a la vez. El reparto lee el stock SIN bloquearlo; si dos órdenes eligen la misma carga a la vez, la segunda tiene que
// perder la carrera con una excepción (se deshace todo, la orden queda lista para reintentar), nunca dejar stock negativo ni un deadlock.
//
//   cd tests/sql && node agrupar.concurrencia.test.mjs
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

// ── Servidor y conexiones ───────────────────────────────────────────────────
async function arrancar() {
  let ultimo = null;
  for (let intento = 0; intento < 5; intento++) {          // el puerto se elige al azar: si está ocupado se prueba otro
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-concurrencia-'));
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
  for (const f of ['caja_aplicar_delta.sql', 'stock_a_pedido.sql', 'meli_esquema_base.sql', 'meli_vincular.sql', 'meli_agrupar_stock.sql']) await admin.query(SQL(f));
  await admin.query(`UPDATE public.meli_config SET valor = $1 WHERE clave = 'rpc_secret_sha256'`, [crypto.createHash('sha256').update(SECRETO).digest('hex')]);
  await admin.query(ventasConParche(SQL('meli_ventas_migration.sql')));
}

let nCuenta = 0;
async function nuevaCuenta(admin, personaId) {
  const { rows: [c] } = await admin.query(`INSERT INTO public.meli_cuentas (meli_user_id, nickname, persona_id, bolsillo) VALUES ($1,$2,$3,'ARS Mercado Pago') RETURNING id`,
    [`9${++nCuenta}`, `CUENTA${nCuenta}`, personaId]);
  return c.id;
}

// ¿Está esa conexión esperando un candado AHORA, y lo tiene la conexión esperada? (se mira desde otra conexión; con
// pg_blocking_pids se confirma QUIÉN la bloquea, no sólo que espera)
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
async function terminaPronto(e, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (e.hecho) return true; await dormir(25); }
  return e.hecho;
}
function lanzar(c, sql, params) {
  const e = { hecho: false, ok: null, err: null };
  e.fin = c.query(sql, params).then((r) => { e.hecho = true; e.ok = r; }, (er) => { e.hecho = true; e.err = er; });
  return e;
}
const cantidad = async (c, id) => (await c.query(`SELECT cantidad FROM public.stock WHERE id=$1`, [id])).rows[0].cantidad;
const itemsDe = async (c, id) => (await c.query(`SELECT * FROM public.meli_orden_items WHERE orden_id=$1 ORDER BY id`, [id])).rows;
const DIA = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();

console.log('\n══ Reparto entre cargas bajo concurrencia (Postgres real, varias conexiones) ══\n');

let srv = null, dir = null, conectar = null;
const conexiones = [];
const conn = async () => { const c = await conectar(); conexiones.push(c); return c; };
async function limpiar() {
  for (const c of conexiones) { try { await c.end(); } catch { /* ya cerrada */ } }
  try { if (srv) await srv.stop(); } catch { /* ya detenido */ }
  try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sin acceso */ }
}
const reloj = setTimeout(() => { console.error('\nTIEMPO MÁXIMO (180 s): el banco se colgó. Limpiando.'); limpiar().finally(() => process.exit(2)); }, 180_000);
try {
  ({ srv, dir, conectar } = await arrancar());
  const admin = await conn();
  await admin.query(`ALTER DATABASE postgres SET deadlock_timeout = '100ms'`);
  await cargarEsquema(admin);
  const { rows: [p] } = await admin.query(`INSERT INTO public.personas (nombre) VALUES ('Franco') RETURNING id`);
  await admin.query(`INSERT INTO public.cajas (persona_id, bolsillo, saldo) VALUES ($1,'ARS Mercado Pago',0)`, [p.id]);
  await admin.query(`INSERT INTO public.usuarios_autorizados VALUES ('franco@x.com', true) ON CONFLICT DO NOTHING`);
  check(`Postgres real arrancado (versión ${(await admin.query('SHOW server_version')).rows[0].server_version}) y los scripts 3, 7 y 19 cargan sin errores`, true);
  const A = await conn(), B = await conn();

  // ── 1. Dos órdenes eligen la MISMA carga a la vez: la segunda espera y reparte sobre lo vigente ──
  {
    const cuenta = await nuevaCuenta(admin, p.id);
    const vieja = await nuevoStock(admin, { nombre: 'Perfume Carrera', cantidad: 2, costo: 20, creado: DIA(1) });
    const nueva = await nuevoStock(admin, { nombre: 'Perfume Carrera', cantidad: 2, costo: 28, creado: DIA(9) });
    const o1 = await nuevaOrden({ db: admin, cuentaId: cuenta }, [{ item: 'MLA100000001', stock: nueva, cant: 2 }]);
    const o2 = await nuevaOrden({ db: admin, cuentaId: cuenta }, [{ item: 'MLA100000002', stock: nueva, cant: 2 }]);
    await A.query('BEGIN');
    await A.query(`SELECT * FROM public.meli__descontar_core($1)`, [o1]);          // A descuenta de la vieja y todavía no confirma
    const e = lanzar(B, `SELECT * FROM public.meli__descontar_core($1)`, [o2]);    // B también elige la vieja (todavía ve 2)
    await dormir(400);
    check('1 La segunda orden ESPERA a la primera (misma carga)', !e.hecho);
    await A.query('COMMIT');
    await e.fin;
    check('1 …y cuando la primera confirma, la segunda sigue SIN error: ve la vieja en 0 y reparte sobre lo vigente (toma de la nueva)',
      !e.err && (await cantidad(admin, vieja)) === 0 && (await cantidad(admin, nueva)) === 0, e.err && e.err.message);
    const it2 = await itemsDe(admin, o2);
    check('1 …la segunda orden quedó con una línea de 2 unidades en la carga nueva y SIN marcar para revisar', it2.length === 1 && it2[0].stock_id === nueva && it2[0].cantidad === 2 && (await admin.query(`SELECT revisar FROM public.meli_ordenes WHERE id=$1`, [o2])).rows[0].revisar === false, JSON.stringify(it2));
  }

  // ── 2. ESFUERZO: muchas órdenes a la vez sobre varias cargas ──
  {
    const cuenta = await nuevaCuenta(admin, p.id);
    const FILAS = 4, POR_FILA = 3, NORD = 6, CANT = 2;                              // 12 unidades, 6 órdenes de 2
    const filas = [];
    for (let i = 0; i < FILAS; i++) filas.push(await nuevoStock(admin, { nombre: 'Perfume Esfuerzo', cantidad: POR_FILA, costo: 20 + i, creado: DIA(i + 1) }));
    const ordenes = [];
    for (let i = 0; i < NORD; i++) ordenes.push(await nuevaOrden({ db: admin, cuentaId: cuenta }, [{ item: `MLA2000000${i}`, stock: filas[FILAS - 1], cant: CANT }]));
    const cs = []; for (let i = 0; i < NORD; i++) cs.push(await conn());
    const errores = []; let deadlocks = 0, reintentos = 0;
    await Promise.all(cs.map(async (c, i) => {
      for (let intento = 0; intento < 40; intento++) {
        try {
          await c.query('BEGIN');
          await c.query(`SELECT * FROM public.meli__descontar_core($1)`, [ordenes[i]]);
          await c.query('COMMIT');
          return;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          if (e.code === '40P01') deadlocks++;
          if (/stock insuficiente al descontar/.test(e.message) || e.code === '40P01') { reintentos++; await dormir(10 + Math.random() * 30); continue; }
          errores.push(e.message); return;
        }
      }
      errores.push('sin éxito tras 40 intentos');
    }));
    check('2 ESFUERZO: cero deadlocks y cero errores inesperados', deadlocks === 0 && errores.length === 0, JSON.stringify({ deadlocks, errores: errores.slice(0, 3) }));
    let total = 0, negativos = 0;
    for (const f of filas) { const q = await cantidad(admin, f); total += q; if (q < 0) negativos++; }
    check(`2 El stock cuadra: las 12 unidades se vendieron exactas (queda ${total}) y ninguna carga quedó negativa`, total === 0 && negativos === 0, JSON.stringify({ total, negativos }));
    let cuadran = true;
    for (const o of ordenes) {
      const it = await itemsDe(admin, o);
      const suma = it.reduce((s, x) => s + x.cantidad, 0), sacadas = it.reduce((s, x) => s + (x.descontado_cantidad || 0), 0);
      if (suma !== CANT || sacadas !== CANT) cuadran = false;
    }
    check('2 Cada orden quedó con exactamente 2 unidades repartidas y descontadas (las líneas suman lo pedido)', cuadran);
    const mov = (await admin.query(`SELECT count(*)::int n, sum(cantidad_antes - cantidad_despues)::int u FROM public.stock_movimientos WHERE tipo='meli' AND stock_id = ANY($1)`, [filas])).rows[0];
    check(`2 El historial registra el descuento de cada unidad (${mov.u} unidades en ${mov.n} movimientos)`, mov.u === FILAS * POR_FILA, JSON.stringify(mov));
    console.log(`        (carreras perdidas y reintentadas: ${reintentos})`);
  }
  // ── 3. DOS productos en orden cruzado (la receta clásica del deadlock) ──
  {
    const cuenta = await nuevaCuenta(admin, p.id);
    const RONDAS = 25; let deadlocks = 0, otros = [], ok3 = 0;
    for (let r = 0; r < RONDAS; r++) {
      const g1 = [await nuevoStock(admin, { nombre: `Cruce Uno ${r}`, cantidad: 1, creado: DIA(1) }), await nuevoStock(admin, { nombre: `Cruce Uno ${r}`, cantidad: 1, creado: DIA(2) })];
      const g2 = [await nuevoStock(admin, { nombre: `Cruce Dos ${r}`, cantidad: 1, creado: DIA(1) }), await nuevoStock(admin, { nombre: `Cruce Dos ${r}`, cantidad: 1, creado: DIA(2) })];
      const x = await nuevaOrden({ db: admin, cuentaId: cuenta }, [{ item: `MLA3${r}0001`, stock: g1[1], cant: 1 }, { item: `MLA3${r}0002`, stock: g2[1], cant: 1 }]);
      const y = await nuevaOrden({ db: admin, cuentaId: cuenta }, [{ item: `MLA3${r}0003`, stock: g2[1], cant: 1 }, { item: `MLA3${r}0004`, stock: g1[1], cant: 1 }]);
      const corre = async (c, o) => {
        for (let i = 0; i < 20; i++) {
          try { await c.query('BEGIN'); await c.query(`SELECT * FROM public.meli__descontar_core($1)`, [o]); await c.query('COMMIT'); return; }
          catch (e) { await c.query('ROLLBACK').catch(() => {}); if (e.code === '40P01') { deadlocks++; await dormir(15); continue; } otros.push(e.message); return; }
        }
      };
      await Promise.all([corre(A, x), corre(B, y)]);
      const q = (await Promise.all([...g1, ...g2].map((id) => cantidad(admin, id))));
      if (q.every((n) => n === 0) || q.reduce((a, b) => a + b, 0) === 0) ok3++;
    }
    check(`3 Dos productos en orden cruzado, ${RONDAS} rondas: CERO deadlocks y cero errores`, deadlocks === 0 && otros.length === 0, JSON.stringify({ deadlocks, otros: otros.slice(0, 3) }));
    check(`3 …y en todas las rondas el stock cuadra (cada unidad se vendió una sola vez: ${ok3} de ${RONDAS})`, ok3 === RONDAS, String(ok3));
  }
  // ── 4. Procesar de verdad (revalida el vínculo y después descuenta): dos órdenes cuyos avisos están vinculados a cargas DISTINTAS
  //       del mismo producto. La revalidación deja un KEY SHARE (clave foránea) en cada carga; el bloqueo del reparto tiene que ser
  //       compatible con él (FOR NO KEY UPDATE) o las dos órdenes se esperan en círculo.
  {
    const cuenta = await nuevaCuenta(admin, p.id);
    const RONDAS = 25; let deadlocks = 0, otros = [], bien = 0;
    for (let r = 0; r < RONDAS; r++) {
      const X = await nuevoStock(admin, { nombre: `Cruce Procesar ${r}`, cantidad: 1, creado: DIA(1) });
      const Y = await nuevoStock(admin, { nombre: `Cruce Procesar ${r}`, cantidad: 1, creado: DIA(2) });
      await admin.query(`INSERT INTO public.meli_publicaciones (cuenta_id, meli_item_id, stock_id) VALUES ($1,$2,$3), ($1,$4,$5)`, [cuenta, `MLA4${r}A`, X, `MLA4${r}B`, Y]);
      const o1 = await nuevaOrden({ db: admin, cuentaId: cuenta }, [{ item: `MLA4${r}A`, cant: 1 }]);
      const o2 = await nuevaOrden({ db: admin, cuentaId: cuenta }, [{ item: `MLA4${r}B`, cant: 1 }]);
      const corre = async (c, o) => {
        for (let i = 0; i < 20; i++) {
          try { const res = (await c.query(`SELECT public.meli_procesar_orden($1, 1000) AS r`, [o])).rows[0].r; return res.ok === true; }
          catch (e) { if (e.code === '40P01') { deadlocks++; await dormir(15); continue; } otros.push(e.message); return false; }
        }
        return false;
      };
      const [a1, a2] = await Promise.all([corre(A, o1), corre(B, o2)]);
      const q = (await cantidad(admin, X)) + (await cantidad(admin, Y));
      if (a1 && a2 && q === 0) bien++;
    }
    check(`4 Procesar con vínculos a cargas distintas del mismo producto, ${RONDAS} rondas: CERO deadlocks y cero errores`, deadlocks === 0 && otros.length === 0, JSON.stringify({ deadlocks, otros: otros.slice(0, 3) }));
    check(`4 …y en todas las rondas se procesaron las dos órdenes y el stock cuadra (${bien} de ${RONDAS})`, bien === RONDAS, String(bien));
  }
  const colgadas = (await admin.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)).rows[0].n;
  check('Al terminar no queda ninguna conexión esperando un candado (nada colgado)', colgadas === 0, String(colgadas));
} finally {
  clearTimeout(reloj);
  await limpiar();
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
