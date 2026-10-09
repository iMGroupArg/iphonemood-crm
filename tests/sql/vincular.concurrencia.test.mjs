// Banco de CONCURRENCIA de la vinculación de publicaciones: un Postgres REAL (embedded-postgres) y VARIAS CONEXIONES a la vez.
// pglite tiene una sola conexión y no puede probar esperas ni deadlocks; esto sí.
//
//   cd tests/sql && npm run test:concurrencia
//
// Carga los archivos reales de db/pendientes en el orden de corrida (3 → 7 → 4 con el esquema mínimo de lib/base_meli.mjs) y
// prueba, mirando pg_stat_activity para comprobar que la segunda conexión REALMENTE ESPERA (no sólo que "tarda"):
//   1. cambiar / desvincular DURANTE un Procesar → espera, y la orden se descuenta con el vínculo que leyó.
//   2. aparición de un vínculo nuevo durante un Procesar → no se descuenta con nada desactualizado.
//   3. doble INSERT del mismo aviso nuevo → uno gana, el otro VINCULO_CAMBIO_CONCURRENTE (y con ROLLBACK, el otro entra).
//   4. vincular contra la ingesta de una orden nueva (usa la función real meli_ingresar_orden).
//   5. la pantalla (meli_orden_revalidar) contra una orden ocupada → espera 3 s y devuelve "ocupada".
//   6. dos Procesar de la MISMA orden a la vez → el segundo espera y responde "ya procesada" (una venta, un descuento).
//   7. vincular contra el cambio de un producto a "a pedido", en los DOS sentidos → nunca queda un a pedido vinculado.
//   8. la pantalla contra la ingesta de la MISMA orden.
//   9. ESFUERZO, con un aviso y con DOS avisos en orden cruzado: procesos de Procesar, cambios y desvinculaciones de vínculo y
//      revalidaciones de la pantalla, TODOS a la vez: cero deadlocks, cero errores inesperados, progreso real durante la
//      concurrencia (no sólo en el barrido final) y el stock cuadra exacto con lo que dice cada orden.
//
// LÍMITE HONESTO: el motor es PostgreSQL 18 (versión beta que trae embedded-postgres); Supabase corre otra versión. Cubre la
// semántica de bloqueos de Postgres, no es idéntico a producción.
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
  for (const f of ['caja_aplicar_delta.sql', 'stock_a_pedido.sql', 'meli_esquema_base.sql', 'meli_vincular.sql']) await admin.query(SQL(f));
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
// ¿Terminó la consulta lanzada dentro del plazo? (para probar que NO se bloquea, mientras la otra transacción sigue abierta)
async function terminaPronto(e, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (e.hecho) return true; await dormir(25); }
  return e.hecho;
}
// Lanza una consulta SIN esperarla y devuelve { fin, estado() } para saber si ya terminó y cómo.
function lanzar(c, sql, params) {
  const e = { hecho: false, ok: null, err: null };
  e.fin = c.query(sql, params).then((r) => { e.hecho = true; e.ok = r; }, (er) => { e.hecho = true; e.err = er; });
  return e;
}

const vincular = (c, { cuenta, item, variacion = null, stock, version = null }) =>
  c.query(`SELECT public.meli_publicacion_vincular($1,$2,$3,$4,$5,$6,'t',10,'franco@x.com') AS v`, [SECRETO, cuenta, item, variacion, stock, version]);
const desvincular = (c, { cuenta, item, variacion = null, version }) =>
  c.query(`SELECT public.meli_publicacion_desvincular($1,$2,$3,$4,$5,'franco@x.com') AS v`, [SECRETO, cuenta, item, variacion, version]);
const pub = async (c, cuenta, item) => (await c.query(`SELECT stock_id, version FROM public.meli_publicaciones WHERE cuenta_id=$1 AND meli_item_id=$2 AND meli_variacion_id IS NULL`, [cuenta, item])).rows[0];
const cantidad = async (c, id) => (await c.query(`SELECT cantidad FROM public.stock WHERE id=$1`, [id])).rows[0].cantidad;
const ordenDe = async (c, id) => (await c.query(`SELECT * FROM public.meli_ordenes WHERE id=$1`, [id])).rows[0];
const itemsDe = async (c, id) => (await c.query(`SELECT * FROM public.meli_orden_items WHERE orden_id=$1 ORDER BY id`, [id])).rows;
const procesar = (c, id) => c.query(`SELECT public.meli_procesar_orden($1, 1000) AS r`, [id]);

console.log('\n══ Vinculación bajo concurrencia (Postgres real, varias conexiones) ══\n');

let srv = null, dir = null, conectar = null;
const conexiones = [];
const errores = [];            // errores inesperados de las pruebas de esfuerzo
let abortar = false;           // se enciende al ver un deadlock: se corta el esfuerzo en lugar de seguir esperando
const conn = async () => { const c = await conectar(); conexiones.push(c); return c; };
async function limpiar() {
  for (const c of conexiones) { try { await c.end(); } catch { /* ya cerrada */ } }
  try { if (srv) await srv.stop(); } catch { /* ya detenido */ }
  try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sin acceso */ }
}
// Tiempo máximo del banco entero: una consulta colgada no puede dejarlo esperando para siempre ni dejar Postgres huérfano.
const reloj = setTimeout(() => { console.error('\nTIEMPO MÁXIMO (240 s): el banco se colgó. Errores vistos hasta ahora: ' + (errores.slice(0, 6).join(' | ') || '(ninguno)') + '. Limpiando.'); limpiar().finally(() => process.exit(2)); }, 240_000);
try {
  ({ srv, dir, conectar } = await arrancar());
  const admin = await conn();
  await admin.query(`ALTER DATABASE postgres SET deadlock_timeout = '100ms'`);   // detectar un deadlock en 0,1 s en vez de 1 s (sólo esta base de prueba)
  await cargarEsquema(admin);
  const { rows: [p] } = await admin.query(`INSERT INTO public.personas (nombre) VALUES ('Franco') RETURNING id`);
  await admin.query(`INSERT INTO public.cajas (persona_id, bolsillo, saldo) VALUES ($1,'ARS Mercado Pago',0)`, [p.id]);
  await admin.query(`INSERT INTO public.usuarios_autorizados VALUES ('franco@x.com', true) ON CONFLICT DO NOTHING`);
  const version = (await admin.query('SHOW server_version')).rows[0].server_version;
  check(`Postgres real arrancado (versión ${version}) y los scripts 3, 7 y 4 cargan sin errores`, true);
  const A = await conn(), B = await conn(), C = await conn();

  // ── 1. Cambiar o desvincular DURANTE un Procesar ──────────────────────────
  for (const caso of ['cambiar', 'desvincular']) {
    const cuenta = await nuevaCuenta(admin, p.id);
    const viejo = await nuevoStock(admin, { nombre: 'Viejo', cantidad: 5 }), nuevo = await nuevoStock(admin, { nombre: 'Nuevo', cantidad: 5 });
    await vincular(admin, { cuenta, item: 'MLA100000001', stock: viejo });
    const o = await nuevaOrden({ db: admin, cuentaId: cuenta }, [{ item: 'MLA100000001', cant: 1 }]);
    await A.query('BEGIN');
    const r = (await procesar(A, o)).rows[0].r;                       // A procesa y TODAVÍA no confirma: sostiene los candados
    const pedido = caso === 'cambiar'
      ? lanzar(B, `SELECT public.meli_publicacion_vincular($1,$2,'MLA100000001',NULL,$3,1,'t',10,'franco@x.com') AS v`, [SECRETO, cuenta, nuevo])
      : lanzar(B, `SELECT public.meli_publicacion_desvincular($1,$2,'MLA100000001',NULL,1,'franco@x.com') AS v`, [SECRETO, cuenta]);
    const espera = await esperaCandado(C, B.pid, A.pid);
    check(`1.${caso === 'cambiar' ? 'a' : 'b'} Mientras A procesa, ${caso} el vínculo hace ESPERAR a la otra conexión (pg_stat_activity: espera un candado que tiene A, confirmado con pg_blocking_pids) y no termina`, espera && !pedido.hecho && r.ok === true, JSON.stringify({ espera, hecho: pedido.hecho, r }));
    await A.query('COMMIT');
    await pedido.fin;
    const p2 = await pub(admin, cuenta, 'MLA100000001');
    const it = (await itemsDe(admin, o))[0];
    check(`1.${caso === 'cambiar' ? 'a' : 'b'} Al confirmar A, la otra conexión sigue y SE APLICA después: la orden quedó descontada del vínculo que A leyó (viejo=4) y el vínculo cambió (versión 2)`,
      !pedido.err && (await cantidad(admin, viejo)) === 4 && (await cantidad(admin, nuevo)) === 5 && it.stock_id === viejo && p2.version === 2 && (caso === 'cambiar' ? p2.stock_id === nuevo : p2.stock_id === null) && (await ordenDe(admin, o)).procesada === true,
      JSON.stringify({ err: pedido.err?.message, viejo: await cantidad(admin, viejo), nuevo: await cantidad(admin, nuevo), p2, item: it.stock_id }));
  }

  // ── 2. Aparece un vínculo nuevo durante un Procesar ───────────────────────
  {
    const cuenta = await nuevaCuenta(admin, p.id);
    const s = await nuevoStock(admin, { nombre: 'Aparece', cantidad: 5 });
    const o = await nuevaOrden({ db: admin, cuentaId: cuenta }, [{ item: 'MLA100000002', cant: 1 }]);   // todavía SIN vínculo
    await A.query('BEGIN');
    await A.query(`SELECT * FROM public.meli__revalidar_orden($1)`, [o]);       // A lee "no hay vínculo": no hay fila que bloquear
    const pedidoB = lanzar(B, `SELECT public.meli_publicacion_vincular($1,$2,'MLA100000002',NULL,$3,NULL,'t',10,'franco@x.com') AS v`, [SECRETO, cuenta, s]);
    const libre = await terminaPronto(pedidoB);                                    // B lo crea y confirma MIENTRAS A sigue abierta
    // A sigue con SU lectura vieja: descontar no puede usar un vínculo que no leyó
    const desc = await A.query(`SELECT * FROM public.meli__descontar_core($1)`, [o]);
    await A.query('COMMIT');
    const ord = await ordenDe(admin, o);
    check('2.a Crear un vínculo mientras A procesa NO se bloquea (no había fila que tomar) y A, con su lectura vieja, NO descuenta nada: la orden queda en revisar', libre && !pedidoB.err && desc.rows.length === 0 && (await cantidad(admin, s)) === 5 && ord.revisar === true && ord.stock_descontado === false, JSON.stringify({ libre, filas: desc.rows.length, ord: [ord.revisar, ord.stock_descontado, ord.motivo_revisar] }));
    const r = (await procesar(admin, o)).rows[0].r;
    check('2.b Después, un Procesar normal ve el vínculo ya confirmado, lo revalida y descuenta bien (falla seguro y se recupera, sin intervención)', r.ok === true && (await cantidad(admin, s)) === 4 && (await ordenDe(admin, o)).procesada === true, JSON.stringify(r));
  }

  // ── 3. Doble INSERT del mismo aviso nuevo ─────────────────────────────────
  for (const final of ['COMMIT', 'ROLLBACK']) {
    const cuenta = await nuevaCuenta(admin, p.id);
    const sA = await nuevoStock(admin, { nombre: 'A' }), sB = await nuevoStock(admin, { nombre: 'B' });
    await A.query('BEGIN');
    await vincular(A, { cuenta, item: 'MLA100000003', stock: sA });               // A inserta y todavía no confirma
    const pedido = lanzar(B, `SELECT public.meli_publicacion_vincular($1,$2,'MLA100000003',NULL,$3,NULL,'t',10,'franco@x.com') AS v`, [SECRETO, cuenta, sB]);
    const espera = await esperaCandado(C, B.pid, A.pid);
    check(`3.${final === 'COMMIT' ? 'a' : 'b'} El doble INSERT del mismo aviso nuevo: la segunda conexión ESPERA al índice único (candado visible)`, espera && !pedido.hecho, JSON.stringify({ espera, hecho: pedido.hecho }));
    await A.query(final);
    await pedido.fin;
    const filas = (await admin.query(`SELECT stock_id, version FROM public.meli_publicaciones WHERE cuenta_id=$1 AND meli_item_id='MLA100000003'`, [cuenta])).rows;
    const hist = (await admin.query(`SELECT count(*)::int n FROM public.meli_vinculos_historial WHERE cuenta_id=$1`, [cuenta])).rows[0].n;
    if (final === 'COMMIT') {
      check('3.a Si A confirma, la segunda recibe VINCULO_CAMBIO_CONCURRENTE (no sobrescribe al ganador): una sola fila, la de A, y UN solo registro de historial', pedido.err?.message.includes('VINCULO_CAMBIO_CONCURRENTE') && filas.length === 1 && filas[0].stock_id === sA && hist === 1, JSON.stringify({ err: pedido.err?.message, filas, hist }));
    } else {
      check('3.b Si A hace ROLLBACK, la segunda ENTRA: una sola fila, la de B', !pedido.err && filas.length === 1 && filas[0].stock_id === sB && hist === 1, JSON.stringify({ err: pedido.err?.message, filas, hist }));
    }
  }

  // ── 4. Vincular contra la INGESTA de una orden nueva ──────────────────────
  {
    const cuenta = await nuevaCuenta(admin, p.id);
    const viejo = await nuevoStock(admin, { nombre: 'Viejo4', cantidad: 5 }), nuevo = await nuevoStock(admin, { nombre: 'Nuevo4', cantidad: 5 });
    await vincular(admin, { cuenta, item: 'MLA100000004', stock: viejo });
    const ref = `ING-${Date.now()}`;
    const lease = (await admin.query(`SELECT public.meli_lease_tomar($1,$2,$3) AS l`, [SECRETO, cuenta, ref])).rows[0].l;
    const hoy = new Date().toISOString(), ayer = new Date(Date.now() - 86400000).toISOString();
    const orden = { meli_order_id: ref, estado: 'paid', estado_envio: 'shipped', comprador: 'comprador', fecha_orden: hoy, moneda: 'ARS', bruto: 100000, neto: 85000,
      comision_envio: 15000, pago_id: 'p1', fecha_liberacion: ayer, diferencia_comision: 0, cobrado_aprobado: 100000, comision_declarada: 15000, financiera_ok: true,
      financiera_completa: true, revisar: false, meli_last_updated: hoy, pagos_version: hoy, envio_version: hoy };
    const items = [{ meli_item_id: 'MLA100000004', titulo: 't', cantidad: 1, precio_unitario: 100000 }];
    await A.query('BEGIN');
    const id = (await A.query(`SELECT public.meli_ingresar_orden($1,$2,$3,$4::jsonb,$5::jsonb) AS id`, [SECRETO, cuenta, lease, JSON.stringify(orden), JSON.stringify(items)])).rows[0].id;
    const pedidoB4 = lanzar(B, `SELECT public.meli_publicacion_vincular($1,$2,'MLA100000004',NULL,$3,1,'t',10,'franco@x.com') AS v`, [SECRETO, cuenta, nuevo]);
    const libre4 = await terminaPronto(pedidoB4);                                  // B cambia el vínculo MIENTRAS la ingesta de A sigue abierta
    await A.query('COMMIT');
    check('4.a La ingesta de una orden nueva (función real meli_ingresar_orden) y un cambio de vínculo NO se bloquean entre sí: el cambio termina con la ingesta todavía sin confirmar', libre4 && !pedidoB4.err, JSON.stringify({ libre4, err: pedidoB4.err?.message }));
    const stale = (await itemsDe(admin, id))[0].stock_id;
    check('4.b La orden entró con el stock VIEJO (la ingesta leyó antes del cambio): es el caso de la carrera', stale === viejo, String(stale));
    const r = (await procesar(admin, id)).rows[0].r;
    check('4.c Pero al PROCESAR se revalida y se descuenta del vínculo VIGENTE (nuevo=4), no del viejo (sigue 5): nunca se descuenta con un vínculo desactualizado', r.ok === true && (await cantidad(admin, nuevo)) === 4 && (await cantidad(admin, viejo)) === 5 && (await itemsDe(admin, id))[0].stock_id === nuevo, JSON.stringify({ r, nuevo: await cantidad(admin, nuevo), viejo: await cantidad(admin, viejo) }));
  }

  // ── 5. La pantalla contra una orden ocupada ───────────────────────────────
  {
    const cuenta = await nuevaCuenta(admin, p.id);
    const s = await nuevoStock(admin, { nombre: 'Ocupada', cantidad: 5 });
    await vincular(admin, { cuenta, item: 'MLA100000005', stock: s });
    const o = await nuevaOrden({ db: admin, cuentaId: cuenta }, [{ item: 'MLA100000005', cant: 1 }]);
    await A.query('BEGIN');
    await procesar(A, o);                                                           // A tiene la orden bloqueada
    const t0 = Date.now();
    const pedido = lanzar(B, `SELECT public.meli_orden_revalidar($1) AS r`, [o]);
    const espera = await esperaCandado(C, B.pid, A.pid);
    await pedido.fin;                                                               // se corta sola a los 3 s (lock_timeout)
    const dur = Date.now() - t0;
    await A.query('COMMIT');
    check('5. La pantalla (meli_orden_revalidar) sobre una orden ocupada ESPERA y a los ~3 s devuelve {ok:false, ocupada:true} en lugar de colgarse', espera && !pedido.err && pedido.ok.rows[0].r.ok === false && pedido.ok.rows[0].r.ocupada === true && dur >= 2500 && dur < 8000, JSON.stringify({ espera, dur, r: pedido.ok?.rows[0]?.r, err: pedido.err?.message }));
  }

  // ── 6. Dos Procesar de la MISMA orden a la vez ───────────────────────────
  {
    const cuenta = await nuevaCuenta(admin, p.id);
    const s = await nuevoStock(admin, { nombre: 'Misma', cantidad: 5 });
    await vincular(admin, { cuenta, item: 'MLA100000007', stock: s });
    const o = await nuevaOrden({ db: admin, cuentaId: cuenta }, [{ item: 'MLA100000007', cant: 1 }]);
    await A.query('BEGIN');
    await procesar(A, o);
    const segundo = lanzar(B, `SELECT public.meli_procesar_orden($1, 1000) AS r`, [o]);
    const espera = await esperaCandado(C, B.pid, A.pid);
    await A.query('COMMIT');
    await segundo.fin;
    const ventas = (await admin.query(`SELECT count(*)::int n FROM public.ventas WHERE meli_orden_id = $1`, [o])).rows[0].n;
    const movs = (await admin.query(`SELECT count(*)::int n FROM public.stock_movimientos WHERE stock_id=$1 AND tipo='meli'`, [s])).rows[0].n;
    check('6. Dos Procesar de la MISMA orden: el segundo ESPERA a la primera (confirmado con pg_blocking_pids), después responde "ya procesada", y hay UNA venta, UN descuento (4) y UN movimiento',
      espera && !segundo.err && segundo.ok.rows[0].r.ya_procesada === true && ventas === 1 && movs === 1 && (await cantidad(admin, s)) === 4, JSON.stringify({ espera, err: segundo.err?.message, r: segundo.ok?.rows[0]?.r, ventas, movs }));
  }

  // ── 7. Vincular contra el cambio de un producto a "a pedido" ──────────────
  {
    const cuenta = await nuevaCuenta(admin, p.id);
    // (i) A marca a pedido (sin vínculo todavía) y no confirma; B intenta vincular ese producto
    const s1 = await nuevoStock(admin, { nombre: 'Pedido1', cantidad: 3 });
    await A.query('BEGIN');
    await A.query(`UPDATE public.stock SET a_pedido = true WHERE id = $1`, [s1]);
    const v1 = lanzar(B, `SELECT public.meli_publicacion_vincular($1,$2,'MLA100000008',NULL,$3,NULL,'t',10,'franco@x.com') AS v`, [SECRETO, cuenta, s1]);
    const e1 = await esperaCandado(C, B.pid, A.pid);
    await A.query('COMMIT');
    await v1.fin;
    const hay1 = await pub(admin, cuenta, 'MLA100000008');
    check('7.a Si A está marcando un producto "a pedido", vincularlo ESPERA a A y después se rechaza (A_PEDIDO_NO_SE_VINCULA): no queda ningún vínculo', e1 && v1.err?.message.includes('A_PEDIDO_NO_SE_VINCULA') && !hay1, JSON.stringify({ e1, err: v1.err?.message, hay1 }));
    // (ii) A vincula y no confirma; B intenta marcar ese producto a pedido
    const s2 = await nuevoStock(admin, { nombre: 'Pedido2', cantidad: 3 });
    await A.query('BEGIN');
    await vincular(A, { cuenta, item: 'MLA100000009', stock: s2 });
    const v2 = lanzar(B, `UPDATE public.stock SET a_pedido = true WHERE id = $1`, [s2]);
    const e2 = await esperaCandado(C, B.pid, A.pid);
    await A.query('COMMIT');
    await v2.fin;
    const marca = (await admin.query(`SELECT a_pedido FROM public.stock WHERE id=$1`, [s2])).rows[0].a_pedido;
    check('7.b Si A está vinculando un producto, marcarlo "a pedido" ESPERA a A y después se rechaza (A_PEDIDO_VINCULADO_A_MELI): nunca queda un producto a pedido con vínculo', e2 && v2.err?.message.includes('A_PEDIDO_VINCULADO_A_MELI') && marca === false && !!(await pub(admin, cuenta, 'MLA100000009')), JSON.stringify({ e2, err: v2.err?.message, marca }));
  }

  // ── 8. La pantalla contra la ingesta de la MISMA orden ────────────────────
  {
    const cuenta = await nuevaCuenta(admin, p.id);
    const s = await nuevoStock(admin, { nombre: 'Reingesta', cantidad: 5 });
    await vincular(admin, { cuenta, item: 'MLA100000010', stock: s });
    const ref = `REING-${Date.now()}`;
    const hoy = Date.now();
    const armar = (ms) => ({ meli_order_id: ref, estado: 'paid', estado_envio: 'shipped', comprador: 'c', fecha_orden: new Date(hoy).toISOString(), moneda: 'ARS', bruto: 100000, neto: 85000,
      comision_envio: 15000, pago_id: 'p1', fecha_liberacion: new Date(hoy - 86400000).toISOString(), diferencia_comision: 0, cobrado_aprobado: 100000, comision_declarada: 15000,
      financiera_ok: true, financiera_completa: true, revisar: false, meli_last_updated: new Date(hoy + ms).toISOString(), pagos_version: new Date(hoy + ms).toISOString(), envio_version: new Date(hoy + ms).toISOString() });
    const items = JSON.stringify([{ meli_item_id: 'MLA100000010', titulo: 't', cantidad: 1, precio_unitario: 100000 }]);
    const lease1 = (await admin.query(`SELECT public.meli_lease_tomar($1,$2,$3) AS l`, [SECRETO, cuenta, ref])).rows[0].l;
    const id = (await admin.query(`SELECT public.meli_ingresar_orden($1,$2,$3,$4::jsonb,$5::jsonb) AS id`, [SECRETO, cuenta, lease1, JSON.stringify(armar(0)), items])).rows[0].id;
    await admin.query(`SELECT public.meli_lease_soltar($1,$2,$3,$4)`, [SECRETO, cuenta, ref, lease1]);
    const lease2 = (await admin.query(`SELECT public.meli_lease_tomar($1,$2,$3) AS l`, [SECRETO, cuenta, ref])).rows[0].l;
    await A.query('BEGIN');
    await A.query(`SELECT public.meli_ingresar_orden($1,$2,$3,$4::jsonb,$5::jsonb)`, [SECRETO, cuenta, lease2, JSON.stringify(armar(5000)), items]);   // A re-ingresa la orden y no confirma
    const rev = lanzar(B, `SELECT public.meli_orden_revalidar($1) AS r`, [id]);
    const espera = await esperaCandado(C, B.pid, A.pid);
    await A.query('COMMIT');
    await rev.fin;
    check('8. La pantalla (revalidar) contra la ingesta de la MISMA orden: ESPERA a la ingesta (confirmado con pg_blocking_pids) y después sigue con la orden ya actualizada', espera && !rev.err && rev.ok.rows[0].r.ok === true, JSON.stringify({ espera, err: rev.err?.message, r: rev.ok?.rows[0]?.r }));
  }

  // ── 9. ESFUERZO: todo a la vez, con un aviso y con DOS avisos en orden cruzado ───
  // Cada ronda: los que cambian/desvinculan el vínculo y la pantalla arrancan PRIMERO y sin pausas, y recién después entran los procesos
  // de Procesar. Con dos avisos, las órdenes llevan sus ítems en orden cruzado (X,Y / Y,X): es lo que haría un deadlock si el orden
  // de bloqueos no fuera único. Además de "cero errores", se exige PROGRESO REAL durante la concurrencia (no sólo en el barrido final).
  // INSTRUMENTACIÓN SÓLO DE PRUEBA (no existe en la base real): una demora de unos milisegundos al actualizar stock y los ítems de una
  // orden. Sin ella cada transacción dura casi nada y casi nunca se solapan: se probó rompiendo a propósito el orden de bloqueos del
  // descuento y la prueba de esfuerzo seguía en verde. Con la demora, esa ruptura produce deadlocks y la prueba los atrapa.
  await admin.query(`
    CREATE OR REPLACE FUNCTION public.test_demora() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(TG_ARGV[0]::numeric); RETURN NEW; END $$;
    CREATE TRIGGER test_demora_stock BEFORE UPDATE ON public.stock FOR EACH ROW EXECUTE FUNCTION public.test_demora('0.004');
    CREATE TRIGGER test_demora_items BEFORE UPDATE ON public.meli_orden_items FOR EACH ROW EXECUTE FUNCTION public.test_demora('0.002');`);
  const permitido = (m) => m.includes('ORDEN_EN_REVISION') || m.includes('VINCULO_CAMBIO_CONCURRENTE');
  const registrar = (donde, e) => { if (!permitido(e.message)) { errores.push(`${donde}: [${e.code}] ${e.message.slice(0, 120)}`); if (e.code === '40P01') abortar = true; } };
  const totales = { cambios: 0, desvinculaciones: 0, conflictos: 0, revalidaciones: 0, enRevision: 0, cambiosDuranteProcesar: 0, procesadasEnConcurrencia: 0 };
  let nroAviso = 100;

  async function esfuerzo({ nombre, cantAvisos, rondas, NORD }) {
    const INICIAL = 3000;
    for (let ronda = 1; ronda <= rondas && !abortar; ronda++) {
      const cuenta = await nuevaCuenta(admin, p.id);
      const avisos = [];
      for (let k = 0; k < cantAvisos; k++) {
        const item = `MLA1000${String(++nroAviso).padStart(5, '0')}`;
        const sA = await nuevoStock(admin, { nombre: `${nombre} ${ronda}.${k} A`, cantidad: INICIAL }), sB = await nuevoStock(admin, { nombre: `${nombre} ${ronda}.${k} B`, cantidad: INICIAL });
        await vincular(admin, { cuenta, item, stock: sA });
        avisos.push({ item, sA, sB });
      }
      const ordenes = [];
      for (let i = 0; i < NORD; i++) {
        const orden = i % 2 === 0 ? avisos : [...avisos].reverse();                       // ítems en orden cruzado
        ordenes.push(await nuevaOrden({ db: admin, cuentaId: cuenta }, orden.map((a) => ({ item: a.item, cant: 1 }))));
      }
      const cola = [...ordenes]; const reintentos = new Map(); let sigue = true, fase = 'previa';
      const vinculadores = [];
      for (let k = 0; k < 3; k++) {
        const c = await conn();
        vinculadores.push((async () => {
          while (sigue && !abortar) {
            const av = avisos[Math.floor(Math.random() * avisos.length)];
            try {
              const act = (await pub(c, cuenta, av.item)) || { stock_id: null, version: null };
              if (act.stock_id && Math.random() < 0.25) { await desvincular(c, { cuenta, item: av.item, version: act.version }); totales.desvinculaciones++; }
              else { await vincular(c, { cuenta, item: av.item, stock: act.stock_id === av.sA ? av.sB : av.sA, version: act.version }); totales.cambios++; if (fase === 'procesando') totales.cambiosDuranteProcesar++; }
            } catch (e) { if (e.message.includes('VINCULO_CAMBIO_CONCURRENTE')) totales.conflictos++; else registrar('vincular', e); }
            await dormir(Math.random() * 4);
          }
        })());
      }
      const pantallas = [];
      for (let k = 0; k < 2; k++) {
        const c = await conn();
        pantallas.push((async () => {
          while (sigue && !abortar) {
            try {
              const ab = (await c.query(`SELECT id FROM public.meli_ordenes WHERE cuenta_id=$1 AND NOT procesada AND NOT stock_descontado ORDER BY random() LIMIT 1`, [cuenta])).rows;
              if (ab.length) { await c.query(`SELECT public.meli_orden_revalidar($1)`, [ab[0].id]); totales.revalidaciones++; }
            } catch (e) { registrar('revalidar', e); }
            await dormir(Math.random() * 3);
          }
        })());
      }
      await dormir(150);                                                                // los cambiadores ya están dando vueltas
      fase = 'procesando';
      const t0 = Date.now();
      const trabajadores = [];
      let procesadasAhora = 0;
      for (let k = 0; k < 8; k++) {
        const c = await conn();
        trabajadores.push((async () => {
          while (cola.length && !abortar) {
            const o = cola.shift();
            try { const r = (await procesar(c, o)).rows[0].r; if (r.ok) { procesadasAhora++; totales.procesadasEnConcurrencia++; } }
            catch (e) { if (e.message.includes('ORDEN_EN_REVISION')) { totales.enRevision++; const n = (reintentos.get(o) || 0) + 1; reintentos.set(o, n); if (n < 60) { cola.push(o); await dormir(2); } } else registrar('procesar', e); }
          }
        })());
      }
      await Promise.all(trabajadores);
      const antesDelBarrido = (await admin.query(`SELECT count(*)::int n FROM public.meli_ordenes WHERE cuenta_id=$1 AND procesada`, [cuenta])).rows[0].n;
      fase = 'cierre'; sigue = false;
      await Promise.all([...vinculadores, ...pantallas]);
      // barrido final: se asegura un vínculo por aviso y se procesa lo que haya quedado en revisión
      for (const av of avisos) {
        const act = (await pub(admin, cuenta, av.item)) || { stock_id: null, version: null };
        if (!act.stock_id) await vincular(admin, { cuenta, item: av.item, stock: av.sA, version: act.version });
      }
      const abiertas = abortar ? [] : (await admin.query(`SELECT id FROM public.meli_ordenes WHERE cuenta_id=$1 AND NOT procesada ORDER BY id`, [cuenta])).rows;
      for (const o of abiertas) { try { await procesar(admin, o.id); } catch (e) { registrar('barrido', e); } }
      const seg = ((Date.now() - t0) / 1000).toFixed(1);
      const rotulo = `${nombre} · ronda ${ronda}/${rondas}`;

      const proc = (await admin.query(`SELECT count(*)::int n FROM public.meli_ordenes WHERE cuenta_id=$1 AND procesada AND stock_descontado`, [cuenta])).rows[0].n;
      const malVentas = (await admin.query(`SELECT count(*)::int n FROM public.meli_ordenes o WHERE o.cuenta_id=$1 AND (SELECT count(*) FROM public.ventas v WHERE v.meli_orden_id = o.id) <> 1`, [cuenta])).rows[0].n;
      const malMovs = (await admin.query(`SELECT count(*)::int n FROM public.meli_ordenes o WHERE o.cuenta_id=$1 AND (SELECT count(*) FROM public.stock_movimientos m WHERE m.tipo='meli' AND m.datos->>'meli_order_id' = o.meli_order_id) <> (SELECT count(*) FROM public.meli_orden_items i WHERE i.orden_id = o.id)`, [cuenta])).rows[0].n;
      check(`9 ${rotulo} (${seg} s): las ${NORD} órdenes quedaron procesadas; CADA orden tiene exactamente UNA venta y TANTOS movimientos de stock como ítems (revisado orden por orden)`, proc === NORD && malVentas === 0 && malMovs === 0, JSON.stringify({ proc, malVentas, malMovs }));
      let cuadra = true; const detalle = [];
      for (const av of avisos) {
        const q = async (id) => (await admin.query(`SELECT count(*)::int n FROM public.meli_orden_items i JOIN public.meli_ordenes o ON o.id=i.orden_id WHERE o.cuenta_id=$1 AND i.stock_id=$2`, [cuenta, id])).rows[0].n;
        const nA = await q(av.sA), nB = await q(av.sB), qA = await cantidad(admin, av.sA), qB = await cantidad(admin, av.sB);
        if (nA + nB !== NORD || INICIAL - qA !== nA || INICIAL - qB !== nB) cuadra = false;
        detalle.push(`${av.item}: A -${INICIAL - qA}/${nA} órdenes, B -${INICIAL - qB}/${nB}`);
      }
      check(`9 ${rotulo}: EL STOCK CUADRA EXACTO con lo que dice cada orden (${detalle.join(' · ')})`, cuadra, detalle.join(' | '));
      const vers = (await admin.query(`SELECT COALESCE(sum(version),0)::int v FROM public.meli_publicaciones WHERE cuenta_id=$1`, [cuenta])).rows[0].v;
      const hist = (await admin.query(`SELECT count(*)::int n FROM public.meli_vinculos_historial WHERE cuenta_id=$1`, [cuenta])).rows[0].n;
      check(`9 ${rotulo}: el historial tiene un registro por cada cambio (la suma de versiones coincide)`, hist === vers, JSON.stringify({ hist, vers }));
      check(`9 ${rotulo}: PROGRESO REAL durante la concurrencia: ${antesDelBarrido} de ${NORD} órdenes ya estaban procesadas ANTES del barrido final (al menos el 90 %)`, antesDelBarrido >= Math.ceil(NORD * 0.9), JSON.stringify({ antesDelBarrido, procesadasAhora }));
    }
  }
  await esfuerzo({ nombre: 'Un aviso', cantAvisos: 1, rondas: 2, NORD: 300 });
  await esfuerzo({ nombre: 'Dos avisos cruzados', cantAvisos: 2, rondas: 3, NORD: 250 });
  check('9 ESFUERZO TOTAL (5 rondas): CERO deadlocks y cero errores inesperados', errores.length === 0, errores.slice(0, 5).join(' | '));
  check(`9 …y de verdad hubo cruce: ${totales.cambios} cambios (${totales.cambiosDuranteProcesar} mientras se procesaba) y ${totales.desvinculaciones} desvinculaciones de vínculo, ${totales.conflictos} choques de versión resueltos, ${totales.revalidaciones} revalidaciones de la pantalla, ${totales.procesadasEnConcurrencia} Procesar exitosos en pleno cruce y ${totales.enRevision} que chocaron con una orden desvinculada y se reintentaron`,
    totales.cambios >= 100 && totales.cambiosDuranteProcesar >= 20 && totales.revalidaciones >= 100 && totales.procesadasEnConcurrencia >= 1000, JSON.stringify(totales));
  const colgadas = (await admin.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)).rows[0].n;
  check('9 Al terminar no queda ninguna conexión esperando un candado (nada colgado)', colgadas === 0, String(colgadas));
  await admin.query(`DROP TRIGGER test_demora_stock ON public.stock; DROP TRIGGER test_demora_items ON public.meli_orden_items; DROP FUNCTION public.test_demora()`);
} finally {
  clearTimeout(reloj);
  await limpiar();
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
