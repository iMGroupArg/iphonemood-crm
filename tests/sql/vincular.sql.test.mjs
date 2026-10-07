// Banco de pruebas de db/pendientes/meli_vincular.sql (script 7) contra un Postgres REAL (pglite).
//
//   cd tests/sql && npm run test:vincular
//
// Carga los archivos reales en el orden de corrida:
//   caja_aplicar_delta → stock_a_pedido → meli_esquema_base → meli_vincular → meli_ventas_migration
// sobre un esquema mínimo, y con los PRIVILEGIOS POR DEFECTO DE SUPABASE (ALL para anon y authenticated
// sobre toda tabla nueva): sin eso, una prueba de "el navegador no puede escribir" no probaría nada.
//
// La función meli_procesar_orden es de Ventas+Cueva. Para probar el contrato que se les pasa (llamar a
// meli__revalidar_orden tras bloquear la orden y recargar `o`), se le aplica ESE parche en memoria: el
// archivo real no se toca.
//
// LÍMITE: pglite tiene UNA conexión. Los bloqueos entre transacciones (esperas, deadlocks, doble INSERT simultáneo,
// ingesta contra vinculación) NO se prueban acá. PENDIENTE y obligatorio antes de desplegar: un banco con DOS
// conexiones sobre un Postgres real (embedded-postgres, que descarga binarios y necesita OK de Franco).
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AQUI, SQL, SECRETO, ventasConParche, baseNueva, comoRol, nuevoStock, nuevaOrden } from './lib/base_meli.mjs';
export { SECRETO, ventasConParche, baseNueva, nuevoStock, nuevaOrden };

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };

const SIN = 'Hay ítems sin publicación vinculada';
const CANT = 'Hay ítems con cantidad inválida';
const vincular = (db, { cuenta, item = 'MLA100100001', variacion = null, stock, version = null, titulo = 'Perfume X', cantidad = 10, usuario = 'franco@x.com', secreto = SECRETO }) =>
  db.query(`SELECT public.meli_publicacion_vincular($1,$2,$3,$4,$5,$6,$7,$8,$9) AS v`, [secreto, cuenta, item, variacion, stock, version, titulo, cantidad, usuario]).then(r => r.rows[0].v);
const desvincular = (db, { cuenta, item = 'MLA100100001', variacion = null, version, usuario = 'franco@x.com', secreto = SECRETO }) =>
  db.query(`SELECT public.meli_publicacion_desvincular($1,$2,$3,$4,$5,$6) AS v`, [secreto, cuenta, item, variacion, version, usuario]).then(r => r.rows[0].v);
const pub = async (db, cuenta, item = 'MLA100100001', variacion = null) =>
  (await db.query(`SELECT * FROM public.meli_publicaciones WHERE cuenta_id=$1 AND meli_item_id=$2 AND COALESCE(meli_variacion_id,'')=COALESCE($3,'')`, [cuenta, item, variacion])).rows[0];
const ordenDe_ = async (db, id) => (await db.query(`SELECT * FROM public.meli_ordenes WHERE id=$1`, [id])).rows[0];
const itemsDe = async (db, id) => (await db.query(`SELECT * FROM public.meli_orden_items WHERE orden_id=$1 ORDER BY id`, [id])).rows;
const revalidar = (db, id) => db.query(`SELECT * FROM public.meli__revalidar_orden($1)`, [id]).then(r => r.rows[0]);

console.log('\n══ Vincular publicaciones de Mercado Libre (Postgres en WebAssembly) ══\n');

// ── 1. Corre limpio, dos veces, y en cualquier orden ─────────────────────
{
  const { db } = await baseNueva();
  const e1 = await falla(() => db.exec(SQL('meli_vincular.sql')));
  const e2 = await falla(() => db.exec(SQL('meli_vincular.sql')));
  check('El script 7 corre dos veces más sin romper (idempotente)', !e1 && !e2, `${e1} | ${e2}`);
  const e3 = await falla(() => db.exec(SQL('meli_esquema_base.sql')));
  const { rows: pol } = await db.query(`SELECT policyname, cmd FROM pg_policies WHERE tablename='meli_publicaciones' ORDER BY 1`);
  check('Re-correr el script 3 DESPUÉS del 7 no reabre la escritura: la política sigue siendo sólo de lectura', !e3 && pol.length === 1 && pol[0].cmd === 'SELECT' && pol[0].policyname === 'meli_publicaciones_lectura', JSON.stringify({ e3, pol }));
}
{
  const db = new PGlite({ extensions: { pgcrypto } });
  const e = await falla(() => db.exec(SQL('meli_vincular.sql')));
  check('Sin el script 3 frena con un mensaje claro', e && e.includes('meli_esquema_base.sql'), e);
}

// ── 2. Vincular ──────────────────────────────────────────────────────────
{
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const s = await nuevoStock(db);
  const v = await vincular(db, { cuenta: cuentaId, stock: s });
  const p = await pub(db, cuentaId);
  check('Vincular un aviso nuevo devuelve la versión 1 y guarda stock, título, cantidad y quién', v === 1 && p.stock_id === s && p.version === 1 && p.titulo_meli === 'Perfume X' && p.cantidad_publicada === 10 && p.vinculado_por === 'franco@x.com' && p.vinculado_en, JSON.stringify(p));
  const h = (await db.query(`SELECT * FROM public.meli_vinculos_historial`)).rows;
  check('… y deja una fila de historial (anterior NULL, nuevo = el stock)', h.length === 1 && h[0].stock_anterior === null && h[0].stock_nuevo === s && h[0].usuario === 'franco@x.com', JSON.stringify(h));
  const s2 = await nuevoStock(db, { nombre: 'Otro 50ml' });
  const v2 = await vincular(db, { cuenta: cuentaId, stock: s2, version: 1 });
  const p2 = await pub(db, cuentaId);
  check('Cambiar el vínculo con la versión correcta: versión 2 y el stock nuevo', v2 === 2 && p2.stock_id === s2, JSON.stringify(p2));
  const h2 = (await db.query(`SELECT * FROM public.meli_vinculos_historial ORDER BY id`)).rows;
  check('… el historial guarda anterior y nuevo', h2.length === 2 && h2[1].stock_anterior === s && h2[1].stock_nuevo === s2);
  const e1 = await falla(() => vincular(db, { cuenta: cuentaId, stock: s, version: 1 }));
  const e2 = await falla(() => vincular(db, { cuenta: cuentaId, stock: s, version: null }));
  check('Cambiar con una versión vieja (o sin versión sobre uno existente): VINCULO_CAMBIO_CONCURRENTE', e1?.includes('VINCULO_CAMBIO_CONCURRENTE') && e2?.includes('VINCULO_CAMBIO_CONCURRENTE'), `${e1} | ${e2}`);
  check('… y no cambió nada', (await pub(db, cuentaId)).stock_id === s2 && (await pub(db, cuentaId)).version === 2);
  const e3 = await falla(() => vincular(db, { cuenta: cuentaId, item: 'MLA200200001', stock: s, version: 1 }));
  check('Mandar una versión para un aviso que todavía no tiene fila: VINCULO_CAMBIO_CONCURRENTE', e3?.includes('VINCULO_CAMBIO_CONCURRENTE'), e3);
}
{
  // Variaciones: cada una es una fila distinta; NULL y '' son lo mismo
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const a = await nuevoStock(db, { nombre: 'Teriaq 5ml' }), b = await nuevoStock(db, { nombre: 'Teriaq 10ml' }), c = await nuevoStock(db, { nombre: 'Teriaq 100ml' });
  await vincular(db, { cuenta: cuentaId, item: 'MLA300300001', variacion: '111', stock: a });
  await vincular(db, { cuenta: cuentaId, item: 'MLA300300001', variacion: '222', stock: b });
  await vincular(db, { cuenta: cuentaId, item: 'MLA400400001', variacion: '', stock: c });
  const n = (await db.query(`SELECT count(*)::int n FROM public.meli_publicaciones`)).rows[0].n;
  check('Dos variaciones del mismo aviso son dos vínculos, cada una con su stock', n === 3 && (await pub(db, cuentaId, 'MLA300300001', '111')).stock_id === a && (await pub(db, cuentaId, 'MLA300300001', '222')).stock_id === b);
  check('Variación vacía se guarda como NULL (un aviso sin variaciones)', (await pub(db, cuentaId, 'MLA400400001', null)).meli_variacion_id === null);
  const e = await falla(() => vincular(db, { cuenta: cuentaId, item: 'MLA400400001', variacion: null, stock: c, version: null }));
  check('… y volver a vincularlo "como nuevo" (NULL) choca con la fila existente, no la duplica', e?.includes('VINCULO_CAMBIO_CONCURRENTE') && (await db.query(`SELECT count(*)::int n FROM public.meli_publicaciones WHERE meli_item_id='MLA400400001'`)).rows[0].n === 1, e);
}

// ── 3. Desvincular ───────────────────────────────────────────────────────
{
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const s = await nuevoStock(db);
  await vincular(db, { cuenta: cuentaId, stock: s });
  const e0 = await falla(() => desvincular(db, { cuenta: cuentaId, version: 7 }));
  const v = await desvincular(db, { cuenta: cuentaId, version: 1 });
  const p = await pub(db, cuentaId);
  check('Desvincular con la versión equivocada: VINCULO_CAMBIO_CONCURRENTE', e0?.includes('VINCULO_CAMBIO_CONCURRENTE'), e0);
  check('Desvincular CONSERVA la fila: stock NULL y versión 2', v === 2 && p && p.stock_id === null && p.version === 2, JSON.stringify(p));
  const v2 = await desvincular(db, { cuenta: cuentaId, version: 2 });
  check('Desvincular otra vez es idempotente: no sube la versión ni agrega historial', v2 === 2 && (await db.query(`SELECT count(*)::int n FROM public.meli_vinculos_historial`)).rows[0].n === 2);
  const e1 = await falla(() => desvincular(db, { cuenta: cuentaId, item: 'MLA999900001', version: 1 }));
  check('Desvincular algo que nunca existió: VINCULO_INEXISTENTE', e1?.includes('VINCULO_INEXISTENTE'), e1);
  const v3 = await vincular(db, { cuenta: cuentaId, stock: s, version: 2 });
  check('Volver a vincular después de desvincular sigue la versión (3), no la reinicia', v3 === 3 && (await pub(db, cuentaId)).stock_id === s);
}

// ── 4. Qué stock se puede vincular ───────────────────────────────────────
{
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const casos = [
    ['a pedido', await nuevoStock(db, { cantidad: 0, aPedido: true }), 'A_PEDIDO_NO_SE_VINCULA'],
    ['con IMEIs', await nuevoStock(db, { categoria: 'accesorio', imeis: ['123'], cantidad: 1 }), 'STOCK_CON_IMEI'],
    ['de rubro iPhone (aunque no tenga IMEI cargado)', await nuevoStock(db, { categoria: 'iphone', cantidad: 1 }), 'STOCK_CON_IMEI'],
    ['de rubro Android en mayúsculas', await nuevoStock(db, { categoria: 'Android', cantidad: 1 }), 'STOCK_CON_IMEI'],
    ['eliminado', await nuevoStock(db, { estado: 'eliminado' }), 'STOCK_INEXISTENTE'],
    ['inexistente', '00000000-0000-0000-0000-000000000000', 'STOCK_INEXISTENTE'],
    ['nulo', null, 'STOCK_INEXISTENTE'],
  ];
  for (const [que, id, esperado] of casos) {
    const e = await falla(() => vincular(db, { cuenta: cuentaId, stock: id }));
    check(`Un stock ${que} se rechaza con ${esperado}`, e?.includes(esperado), e);
  }
  check('… y no quedó ninguna fila ni historial', (await db.query(`SELECT count(*)::int n FROM public.meli_publicaciones`)).rows[0].n === 0 && (await db.query(`SELECT count(*)::int n FROM public.meli_vinculos_historial`)).rows[0].n === 0);
  const ok1 = await nuevoStock(db, { cantidad: 0, estado: 'vendido' });
  const e = await falla(() => vincular(db, { cuenta: cuentaId, stock: ok1 }));
  check('Un stock de perfumería con 0 unidades y "vendido" SÍ se puede vincular (se repone después)', e === null, e);
  for (const [que, args, esperado] of [
    ['item inválido', { item: 'XYZ' }, 'ITEM_INVALIDO'], ['item con comilla', { item: "MLA1'; DROP" }, 'ITEM_INVALIDO'], ['item vacío', { item: '' }, 'ITEM_INVALIDO'],
    ['variación inválida', { item: 'MLA500500001', variacion: 'abc' }, 'VARIACION_INVALIDA'], ['cuenta inexistente', { cuenta: 99999, item: 'MLA500500001' }, 'CUENTA_INEXISTENTE'],
  ]) {
    const e = await falla(() => vincular(db, { cuenta: cuentaId, stock: ok1, ...args }));
    check(`Entrada inválida (${que}): ${esperado}`, e?.includes(esperado), e);
  }
  const eS = await falla(() => vincular(db, { cuenta: cuentaId, stock: ok1, item: 'MLA600600001', secreto: 'secreto-equivocado-0123456789abcdef' }));
  const eN = await falla(() => vincular(db, { cuenta: cuentaId, stock: ok1, item: 'MLA600600001', secreto: null }));
  check('Secreto falso o ausente: "no autorizado", sin efectos', eS?.includes('no autorizado') && eN?.includes('no autorizado') && !(await pub(db, cuentaId, 'MLA600600001')));
}

// ── 5. Permisos con los roles reales ─────────────────────────────────────
{
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const s = await nuevoStock(db);
  await vincular(db, { cuenta: cuentaId, stock: s });
  const intentos = [
    ['INSERT', `INSERT INTO public.meli_publicaciones (cuenta_id, meli_item_id, stock_id) VALUES (${cuentaId}, 'MLA700700001', '${s}')`],
    ['UPDATE', `UPDATE public.meli_publicaciones SET stock_id = NULL`],
    ['DELETE', `DELETE FROM public.meli_publicaciones`],
    ['TRUNCATE', `TRUNCATE public.meli_publicaciones`],
    ['INSERT en el historial', `INSERT INTO public.meli_vinculos_historial (cuenta_id, meli_item_id) VALUES (${cuentaId}, 'MLA700700001')`],
  ];
  for (const rol of ['authenticated', 'anon']) {
    const res = [];
    for (const [que, q] of intentos) res.push([que, await falla(() => comoRol(db, rol, 'franco@x.com', () => db.query(q)))]);
    check(`${rol} NO puede escribir meli_publicaciones ni el historial (INSERT, UPDATE, DELETE, TRUNCATE)`, res.every(([, e]) => e && /permission denied/.test(e)), JSON.stringify(res.filter(([, e]) => !e || !/permission denied/.test(e))));
  }
  const lee = await comoRol(db, 'authenticated', 'franco@x.com', async () => (await db.query(`SELECT count(*)::int n FROM public.meli_publicaciones`)).rows[0].n);
  const leeBaja = await comoRol(db, 'authenticated', 'baja@x.com', async () => (await db.query(`SELECT count(*)::int n FROM public.meli_publicaciones`)).rows[0].n);
  const eAnon = await falla(() => comoRol(db, 'anon', null, () => db.query(`SELECT * FROM public.meli_publicaciones`)));
  check('authenticated autorizado LEE los vínculos; uno dado de baja ve 0; anon: permission denied', lee === 1 && leeBaja === 0 && eAnon?.includes('permission denied'), `${lee} ${leeBaja} ${eAnon}`);
  const hist = await comoRol(db, 'authenticated', 'franco@x.com', async () => (await db.query(`SELECT count(*)::int n FROM public.meli_vinculos_historial`)).rows[0].n);
  check('… y el historial también (lectura)', hist === 1, String(hist));
  // RPC con secreto: anon TIENE que poder ejecutarlas (así llama el servidor) y sin el secreto no hace nada
  const anonOk = await comoRol(db, 'anon', null, () => vincular(db, { cuenta: cuentaId, item: 'MLA800800001', stock: s }));
  const anonMal = await falla(() => comoRol(db, 'anon', null, () => vincular(db, { cuenta: cuentaId, item: 'MLA800900001', stock: s, secreto: 'otro-secreto-que-no-es-el-bueno-xx' })));
  check('Transporte del servidor: anon + secreto correcto vincula; anon + secreto malo "no autorizado" y sin efectos', anonOk === 1 && anonMal?.includes('no autorizado') && !(await pub(db, cuentaId, 'MLA800900001')), `${anonOk} ${anonMal}`);
  // internas
  const o = await nuevaOrden(ctx, [{ item: 'MLA100100001' }]);
  for (const rol of ['anon', 'authenticated']) {
    const e1 = await falla(() => comoRol(db, rol, 'franco@x.com', () => db.query(`SELECT * FROM public.meli__revalidar_orden($1)`, [o])));
    const e2 = await falla(() => comoRol(db, rol, 'franco@x.com', () => db.query(`SELECT public.meli_quitar_motivo('a','a')`)));
    const e3 = await falla(() => comoRol(db, rol, 'franco@x.com', () => db.query(`SELECT * FROM public.meli__descontar_core($1)`, [o])));
    check(`${rol} NO puede ejecutar meli__revalidar_orden, meli_quitar_motivo ni meli__descontar_core (internas)`, [e1, e2, e3].every(e => e && /permission denied/.test(e)), JSON.stringify([e1, e2, e3]));
  }
  const rv = await comoRol(db, 'authenticated', 'franco@x.com', async () => (await db.query(`SELECT public.meli_orden_revalidar($1) AS r`, [o])).rows[0].r);
  const eBaja = await falla(() => comoRol(db, 'authenticated', 'baja@x.com', () => db.query(`SELECT public.meli_orden_revalidar($1)`, [o])));
  const eAnon2 = await falla(() => comoRol(db, 'anon', null, () => db.query(`SELECT public.meli_orden_revalidar($1)`, [o])));
  check('meli_orden_revalidar: un usuario autorizado SÍ; uno dado de baja "no autorizado"; anon permission denied', rv?.ok === true && eBaja?.includes('no autorizado') && eAnon2?.includes('permission denied'), JSON.stringify({ rv, eBaja, eAnon2 }));
  // las RPC con secreto no son llamables sin secreto por authenticated tampoco
  const eAuth = await falla(() => comoRol(db, 'authenticated', 'franco@x.com', () => vincular(db, { cuenta: cuentaId, item: 'MLA801000001', stock: s, secreto: 'x' })));
  check('Un usuario logueado SIN el secreto tampoco puede vincular (el único camino es el servidor)', eAuth?.includes('no autorizado'), eAuth);
}

// ── 5a. Permisos exactos de las funciones y de las secuencias ────────────
{
  const ctx = await baseNueva(); const { db } = ctx;
  const f = async (n) => (await db.query(`SELECT has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
      EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE') pub
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='public' AND p.proname=$1`, [n])).rows[0];
  const r = {};
  for (const n of ['meli_publicacion_vincular', 'meli_publicacion_desvincular', 'meli_cuenta_info', 'meli_orden_revalidar', 'meli__revalidar_orden']) r[n] = await f(n);
  check('Las RPC con secreto: anon y authenticated SÍ, y PUBLIC ya NO (permisos exactos, no el valor por defecto)', ['meli_publicacion_vincular', 'meli_publicacion_desvincular', 'meli_cuenta_info'].every((n) => r[n].a && r[n].u && !r[n].pub), JSON.stringify(r));
  check('meli_orden_revalidar: sólo authenticated; la interna: nadie', !r.meli_orden_revalidar.a && r.meli_orden_revalidar.u && !r.meli_orden_revalidar.pub && !r.meli__revalidar_orden.a && !r.meli__revalidar_orden.u && !r.meli__revalidar_orden.pub, JSON.stringify(r));
  const e1 = await falla(() => comoRol(db, 'anon', null, () => db.query(`SELECT nextval('public.meli_vinculos_historial_id_seq')`)));
  const e2 = await falla(() => comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`SELECT nextval('public.meli_publicaciones_id_seq')`)));
  check('Las secuencias de estas dos tablas están cerradas para anon y authenticated', /permission denied/.test(e1 || '') && /permission denied/.test(e2 || ''), `${e1} | ${e2}`);
}

// ── 5b. Datos de la cuenta para el endpoint ──────────────────────────────
{
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const r = (await db.query(`SELECT * FROM public.meli_cuenta_info($1,$2)`, [SECRETO, cuentaId])).rows;
  check('meli_cuenta_info devuelve el id de vendedor de Mercado Libre y si está activa', r.length === 1 && r[0].meli_user_id === '999' && r[0].activa === true, JSON.stringify(r));
  const r0 = (await db.query(`SELECT * FROM public.meli_cuenta_info($1,$2)`, [SECRETO, 987654])).rows;
  const e = await falla(() => db.query(`SELECT * FROM public.meli_cuenta_info($1,$2)`, ['otro-secreto-que-no-es-el-bueno-xx', cuentaId]));
  const anon = await comoRol(db, 'anon', null, async () => (await db.query(`SELECT * FROM public.meli_cuenta_info($1,$2)`, [SECRETO, cuentaId])).rows.length);
  check('… cuenta inexistente: 0 filas; secreto malo: "no autorizado"; anon con el secreto correcto sí (así llama el servidor)', r0.length === 0 && e?.includes('no autorizado') && anon === 1, `${r0.length} ${e} ${anon}`);
}

// ── 5c. Sobre la base TAL COMO QUEDÓ en producción (script 3 de antes de este cambio) ───
{
  // El archivo 3 actual ya trae las correcciones de este cambio; lo que corrió en producción NO. Esta prueba
  // carga esa versión vieja (tests/sql/fixtures) y encima el script 7: es el camino real de la migración.
  const viejo = fs.readFileSync(path.join(AQUI, 'fixtures/meli_esquema_base.aplicado_en_produccion.sql'), 'utf8');
  const ctx = await baseNueva({ base3: viejo }); const { db, cuentaId } = ctx;
  const { rows: pol } = await db.query(`SELECT policyname, cmd FROM pg_policies WHERE tablename='meli_publicaciones' ORDER BY 1`);
  check('Sobre la base de producción: el script 7 reemplaza la política FOR ALL vieja por la de sólo lectura', pol.length === 1 && pol[0].policyname === 'meli_publicaciones_lectura' && pol[0].cmd === 'SELECT', JSON.stringify(pol));
  const e = await comoRol(db, 'authenticated', 'franco@x.com', () => falla(() => db.query(`DELETE FROM public.meli_publicaciones`)));
  check('… y el navegador ya no puede borrar vínculos', e && /permission denied/.test(e), e);
  // el faltante sumado por producto llega a una base que corrió el script 3 viejo
  const s = await nuevoStock(db, { cantidad: 3 });
  await vincular(db, { cuenta: cuentaId, item: 'MLA100100001', stock: s });
  await vincular(db, { cuenta: cuentaId, item: 'MLA100100002', stock: s });
  const o = await nuevaOrden(ctx, [{ item: 'MLA100100001', cant: 2 }, { item: 'MLA100100002', cant: 2 }]);
  const r = (await db.query(`SELECT public.meli_procesar_orden($1, 1000) AS r`, [o])).rows[0].r;
  check('… y el arreglo del descuento (faltante sumado por producto) también llega: 2 + 2 con 3 disponibles no descuenta nada', r.ok === false && (await db.query(`SELECT cantidad FROM public.stock WHERE id=$1`, [s])).rows[0].cantidad === 3, JSON.stringify(r));
  const e2 = await falla(() => db.exec(SQL('meli_esquema_base.sql')));
  const e3 = await falla(() => db.exec(SQL('meli_vincular.sql')));
  const { rows: pol2 } = await db.query(`SELECT policyname FROM pg_policies WHERE tablename='meli_publicaciones'`);
  check('Y encima se puede correr el 3 NUEVO y el 7 otra vez sin romper, con la política sólo de lectura', !e2 && !e3 && pol2.length === 1 && pol2[0].policyname === 'meli_publicaciones_lectura', `${e2} | ${e3}`);
}

// ── 6. Revalidar una orden ───────────────────────────────────────────────
{
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const s = await nuevoStock(db);
  const o = await nuevaOrden(ctx, [{ item: 'MLA100100001' }], { revisar: true, motivo: SIN });
  await vincular(db, { cuenta: cuentaId, stock: s });
  const r = await revalidar(db, o);
  const it = await itemsDe(db, o);
  check('Orden sin vincular + vínculo nuevo: el ítem recibe el stock, se quita el motivo y revisar = false', it[0].stock_id === s && r.revisar === false && r.motivo_revisar === null, JSON.stringify({ it: it[0].stock_id, r: [r.revisar, r.motivo_revisar] }));
  check('… devuelve la fila YA actualizada (para que Ventas+Cueva recargue su variable)', r.id === o && r.revisar === false);
}
{
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const viejo = await nuevoStock(db, { nombre: 'Viejo' }), nuevo = await nuevoStock(db, { nombre: 'Nuevo' });
  await vincular(db, { cuenta: cuentaId, stock: nuevo });
  const o = await nuevaOrden(ctx, [{ item: 'MLA100100001', stock: viejo }]);
  await revalidar(db, o);
  check('Un stock_id VIEJO se reemplaza por el vínculo vigente (autoritativo)', (await itemsDe(db, o))[0].stock_id === nuevo);
}
{
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const s = await nuevoStock(db);
  const v = await vincular(db, { cuenta: cuentaId, stock: s });
  const o = await nuevaOrden(ctx, [{ item: 'MLA100100001', stock: s }]);
  await desvincular(db, { cuenta: cuentaId, version: v });
  const r = await revalidar(db, o);
  check('Desvincular → la orden abierta queda SIN stock, con el motivo AGREGADO y revisar = true', (await itemsDe(db, o))[0].stock_id === null && r.revisar === true && r.motivo_revisar === SIN, JSON.stringify([r.revisar, r.motivo_revisar]));
}
{
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const s = await nuevoStock(db);
  await vincular(db, { cuenta: cuentaId, stock: s });
  const o = await nuevaOrden(ctx, [{ item: 'MLA100100001' }], { revisar: true, motivo: `${SIN} · Moneda distinta de ARS` });
  const r = await revalidar(db, o);
  check('Con OTRO motivo además: se quita sólo el de vincular y la orden SIGUE en revisar', r.revisar === true && r.motivo_revisar === 'Moneda distinta de ARS', JSON.stringify([r.revisar, r.motivo_revisar]));
}
{
  // Cantidad inválida: nunca recibe stock; el motivo se limpia sólo cuando TODAS pasan a > 0
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const s = await nuevoStock(db);
  await vincular(db, { cuenta: cuentaId, stock: s });
  const o = await nuevaOrden(ctx, [{ item: 'MLA100100001', cant: 0 }], { revisar: true, motivo: SIN });
  const r1 = await revalidar(db, o);
  check('Ítem con cantidad 0: NO recibe stock aunque haya vínculo, y queda el motivo de cantidad inválida', (await itemsDe(db, o))[0].stock_id === null && r1.revisar === true && r1.motivo_revisar.includes(CANT) && !r1.motivo_revisar.includes(SIN), JSON.stringify([r1.revisar, r1.motivo_revisar]));
  await db.query(`UPDATE public.meli_orden_items SET cantidad = 2 WHERE orden_id = $1`, [o]);
  const r2 = await revalidar(db, o);
  check('Cuando la cantidad pasa a ser válida: recibe stock, se limpian AMBOS motivos y revisar = false', (await itemsDe(db, o))[0].stock_id === s && r2.revisar === false && r2.motivo_revisar === null, JSON.stringify([r2.revisar, r2.motivo_revisar]));
  const o2 = await nuevaOrden(ctx, [{ item: 'MLA100100001', cant: 1 }, { item: 'MLA100100001', cant: 0 }], { revisar: true, motivo: SIN });
  const r3 = await revalidar(db, o2);
  const its = await itemsDe(db, o2);
  check('Un ítem válido y otro con cantidad 0: el válido recibe stock, la orden sigue en revisar por la cantidad', its[0].stock_id === s && its[1].stock_id === null && r3.revisar === true && r3.motivo_revisar === CANT, JSON.stringify([r3.revisar, r3.motivo_revisar]));
}
{
  // Procesada o descontada: no se toca
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const viejo = await nuevoStock(db, { nombre: 'Viejo' }), nuevo = await nuevoStock(db, { nombre: 'Nuevo' });
  await vincular(db, { cuenta: cuentaId, stock: nuevo });
  const o1 = await nuevaOrden(ctx, [{ item: 'MLA100100001', stock: viejo }]);
  const o2 = await nuevaOrden(ctx, [{ item: 'MLA100100001', stock: viejo }]);
  await db.query(`UPDATE public.meli_ordenes SET stock_descontado = true WHERE id = $1`, [o1]);
  await db.query(`UPDATE public.meli_ordenes SET procesada = true WHERE id = $1`, [o2]);
  await revalidar(db, o1); await revalidar(db, o2);
  check('Una orden descontada y otra procesada NO se reescriben (conservan su stock histórico)', (await itemsDe(db, o1))[0].stock_id === viejo && (await itemsDe(db, o2))[0].stock_id === viejo);
}
{
  const ctx = await baseNueva(); const { db } = ctx;
  const o = await nuevaOrden(ctx, [{ item: 'MLA100100001' }], { revisar: true, motivo: null });
  const r = await revalidar(db, o);
  check('Una orden en revisar por una razón NO registrada en el motivo (motivo NULL) no se toca', r.revisar === true && r.motivo_revisar === SIN && true, JSON.stringify([r.revisar, r.motivo_revisar]));
  const o0 = await nuevaOrden(ctx, []);
  const r0 = await revalidar(db, o0);
  check('Una orden sin ítems no rompe ni se marca', r0.revisar === false && r0.motivo_revisar === null);
  const e = await falla(() => revalidar(db, 99999999));
  check('Una orden inexistente: ORDEN_INEXISTENTE', e?.includes('ORDEN_INEXISTENTE'), e);
}
{
  // revisar = true con motivo NULL y ningún cambio: no se pisa
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const s = await nuevoStock(db);
  await vincular(db, { cuenta: cuentaId, stock: s });
  const o = await nuevaOrden(ctx, [{ item: 'MLA100100001', stock: s }], { revisar: true, motivo: null });
  const r = await revalidar(db, o);
  check('Todo vinculado pero revisar = true SIN motivo registrado: se deja como está (no se inventa que está bien)', r.revisar === true && r.motivo_revisar === null, JSON.stringify([r.revisar, r.motivo_revisar]));
}
{
  // Revalidar es idempotente y aísla cuentas: el vínculo de OTRA cuenta no cuenta
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const { rows: [c2] } = await db.query(`INSERT INTO public.meli_cuentas (meli_user_id, nickname) VALUES ('888','OTRA') RETURNING id`);
  const s = await nuevoStock(db);
  await vincular(db, { cuenta: c2.id, stock: s });
  const o = await nuevaOrden(ctx, [{ item: 'MLA100100001' }]);
  await revalidar(db, o);
  check('El vínculo de OTRA cuenta con el mismo aviso no se usa', (await itemsDe(db, o))[0].stock_id === null);
  await vincular(db, { cuenta: cuentaId, stock: s });
  const a = await revalidar(db, o), b = await revalidar(db, o);
  check('Revalidar dos veces da lo mismo (idempotente)', a.revisar === b.revisar && a.motivo_revisar === b.motivo_revisar && (await itemsDe(db, o))[0].stock_id === s);
}

// ── 7. Procesar directo (con el parche propuesto a Ventas+Cueva) ──────────
const procesar = (db, id) => db.query(`SELECT public.meli_procesar_orden($1, 1000) AS r`, [id]).then(x => x.rows[0].r);
{
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const s = await nuevoStock(db, { cantidad: 5 });
  const o = await nuevaOrden(ctx, [{ item: 'MLA100100001' }], { revisar: true, motivo: SIN });
  await vincular(db, { cuenta: cuentaId, stock: s });
  const r = await procesar(db, o);   // SIN revalidar antes desde la pantalla
  const { rows: [st] } = await db.query(`SELECT cantidad FROM public.stock WHERE id=$1`, [s]);
  check('PROCESAR directo sobre una orden que entró sin vincular (con revisar y todo): revalida, crea la venta y descuenta', r.ok === true && st.cantidad === 4 && (await ordenDe_(db, o)).procesada === true, JSON.stringify({ r, st }));
}
{
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const viejo = await nuevoStock(db, { nombre: 'Viejo', cantidad: 5 }), nuevo = await nuevoStock(db, { nombre: 'Nuevo', cantidad: 5 });
  await vincular(db, { cuenta: cuentaId, stock: nuevo });
  const o = await nuevaOrden(ctx, [{ item: 'MLA100100001', stock: viejo }]);   // entró con el stock de antes
  await procesar(db, o);
  const a = (await db.query(`SELECT cantidad FROM public.stock WHERE id=$1`, [viejo])).rows[0].cantidad;
  const b = (await db.query(`SELECT cantidad FROM public.stock WHERE id=$1`, [nuevo])).rows[0].cantidad;
  check('Si el vínculo cambió desde que entró la orden, PROCESAR descuenta del stock VIGENTE (no del viejo)', a === 5 && b === 4, `viejo=${a} nuevo=${b}`);
}
{
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const s = await nuevoStock(db, { cantidad: 5 });
  const o = await nuevaOrden(ctx, [{ item: 'MLA100100001' }], { revisar: true, motivo: SIN });
  const e = await falla(() => procesar(db, o));
  const { rows: [st] } = await db.query(`SELECT cantidad FROM public.stock WHERE id=$1`, [s]);
  check('PROCESAR una orden que sigue sin vincular se rechaza (ORDEN_EN_REVISION) y no toca stock ni crea venta', e?.includes('ORDEN_EN_REVISION') && st.cantidad === 5 && (await db.query(`SELECT count(*)::int n FROM public.ventas`)).rows[0].n === 0, e);
  const v = await vincular(db, { cuenta: cuentaId, stock: s });
  const o2 = await nuevaOrden(ctx, [{ item: 'MLA100100001', stock: s }]);
  await desvincular(db, { cuenta: cuentaId, version: v });
  const e2 = await falla(() => procesar(db, o2));
  check('Una orden que entró vinculada pero se desvinculó antes de procesar: se rechaza, no descuenta del producto de antes', e2?.includes('ORDEN_EN_REVISION') && (await db.query(`SELECT cantidad FROM public.stock WHERE id=$1`, [s])).rows[0].cantidad === 5, e2);
}
{
  // Dos avisos de la misma orden al MISMO stock, cantidades sumadas insuficientes: cero descuentos, cero ventas
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const s = await nuevoStock(db, { cantidad: 3 });
  await vincular(db, { cuenta: cuentaId, item: 'MLA100100001', stock: s });
  await vincular(db, { cuenta: cuentaId, item: 'MLA100200001', stock: s });
  const o = await nuevaOrden(ctx, [{ item: 'MLA100100001', cant: 2 }, { item: 'MLA100200001', cant: 2 }]);
  const r = await procesar(db, o);
  const { rows: [st] } = await db.query(`SELECT cantidad FROM public.stock WHERE id=$1`, [s]);
  const ord = await ordenDe_(db, o);
  check('Dos avisos al mismo stock (2 + 2 con 3 disponibles): NO se descuenta nada, NO hay venta y la orden queda en revisar con un motivo claro', r.ok === false && st.cantidad === 3 && ord.revisar === true && /Stock insuficiente/.test(ord.motivo_revisar) && (await db.query(`SELECT count(*)::int n FROM public.ventas`)).rows[0].n === 0, JSON.stringify({ r, st, motivo: ord.motivo_revisar }));
  const s2 = await nuevoStock(db, { nombre: 'Alcanza', cantidad: 4 });
  await vincular(db, { cuenta: cuentaId, item: 'MLA200100001', stock: s2 });
  await vincular(db, { cuenta: cuentaId, item: 'MLA200200001', stock: s2 });
  const o2 = await nuevaOrden(ctx, [{ item: 'MLA200100001', cant: 2 }, { item: 'MLA200200001', cant: 2 }]);
  const r2 = await procesar(db, o2);
  check('… y con 4 disponibles (2 + 2) sí se descuenta todo', r2.ok === true && (await db.query(`SELECT cantidad FROM public.stock WHERE id=$1`, [s2])).rows[0].cantidad === 0);
}
{
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const s = await nuevoStock(db, { cantidad: 5 });
  await vincular(db, { cuenta: cuentaId, stock: s });
  const o = await nuevaOrden(ctx, [{ item: 'MLA100100001', stock: s }]);
  await db.query(`SELECT * FROM public.meli__descontar_core($1)`, [o]);
  const otra = (await db.query(`SELECT * FROM public.meli__descontar_core($1)`, [o])).rows;
  check('Reintentar el descuento de una orden ya descontada sigue sin hacer nada (regresión)', otra.length === 0 && (await db.query(`SELECT cantidad FROM public.stock WHERE id=$1`, [s])).rows[0].cantidad === 4);
}

// ── 8. helper puro y sincronía de archivos ───────────────────────────────
{
  const { db } = await baseNueva({ conVentas: false });
  const q = async (t, f) => (await db.query(`SELECT public.meli_quitar_motivo($1,$2) AS r`, [t, f])).rows[0].r;
  check('meli_quitar_motivo: quita el segmento exacto, respeta el resto y su orden', await q(`A · ${SIN} · B`, SIN) === 'A · B' && await q(SIN, SIN) === null && await q(null, SIN) === null && await q('A · B', SIN) === 'A · B');
  check('… no quita una frase que sólo CONTIENE la buscada', await q(`${SIN} (MLA1)`, SIN) === `${SIN} (MLA1)` && await q('x', null) === 'x');
  const base = SQL('meli_esquema_base.sql'), v7 = SQL('meli_vincular.sql');
  const core = t => { const a = t.indexOf('CREATE OR REPLACE FUNCTION public.meli__descontar_core('); const b = t.indexOf('END;\n$$;', a) + 8; return t.slice(a, b); };
  check('SINCRONÍA: meli__descontar_core del script 7 es IDÉNTICA a la de meli_esquema_base.sql', core(base).length > 500 && core(base) === core(v7), `${core(base).length} vs ${core(v7).length}`);
  const sinCom = v7.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
  const vinc = sinCom.slice(sinCom.indexOf('FUNCTION public.meli_publicacion_vincular('), sinCom.indexOf('FUNCTION public.meli_publicacion_desvincular('));
  check('La RPC de vincular NO usa ON CONFLICT (invertiría el orden de bloqueos) y traduce el índice meli_publicaciones_unica', !/ON CONFLICT/i.test(vinc) && /meli_publicaciones_unica/.test(vinc) && /FOR UPDATE[\s\S]*FOR SHARE[\s\S]*INSERT INTO public\.meli_publicaciones/.test(vinc));
  const rev = sinCom.slice(sinCom.indexOf('FUNCTION public.meli__revalidar_orden('), sinCom.indexOf('FUNCTION public.meli_orden_revalidar('));
  check('La revalidación lee los vínculos UNA vez con FOR SHARE y no vuelve a consultar meli_publicaciones', (rev.match(/FROM public\.meli_publicaciones/g) || []).length === 1 && /FOR SHARE OF p/.test(rev));
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
