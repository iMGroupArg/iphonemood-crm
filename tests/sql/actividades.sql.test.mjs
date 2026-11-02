// Banco de pruebas de db/pendientes/actividades.sql (script 15) contra un Postgres REAL (pglite).
//
//   cd tests/sql && node actividades.sql.test.mjs
//
// Carga los scripts reales en el orden de corrida (1 → 2 → 3 → 7 → 4 → 12 → 15) con los PRIVILEGIOS POR DEFECTO de Supabase.
// LÍMITE: pglite tiene UNA conexión; las carreras (transferir vs revertir, doble transferencia, etc.) se prueban en
// actividades.concurrencia.test.mjs con Postgres real y varias conexiones.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { SQL, SECRETO, baseNueva, comoRol, nuevoStock, nuevaOrden } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };
const q = async (db, sql, p = []) => (await db.query(sql, p)).rows;

const nueva = async ({ con15 = true } = {}) => {
  const c = await baseNueva();
  await c.db.exec(SQL('meli_cerrar_manual.sql'));
  const { rows: [pe] } = await c.db.query(`SELECT persona_id FROM public.cajas WHERE bolsillo = 'ARS Mercado Pago' LIMIT 1`);
  c.persona = pe.persona_id;
  await c.db.query(`INSERT INTO public.cajas (persona_id, bolsillo, saldo) VALUES ($1,'ARS transferencia',0), ($1,'USD cash',0)`, [c.persona]);
  if (con15) await c.db.exec(SQL('actividades.sql'));
  return c;
};
const vincular = (db, cuenta, item, stock) => db.query(`SELECT public.meli_publicacion_vincular($1,$2,$3,NULL,$4,NULL,'t',10,'franco@x.com') AS v`, [SECRETO, cuenta, item, stock]);
let n = 0;
async function ordenLista(ctx) {
  const item = 'MLA' + String(++n + 700).padStart(9, '0');
  const s = await nuevoStock(ctx.db, { nombre: 'Perfume ' + item, cantidad: 5 });
  await vincular(ctx.db, ctx.cuentaId, item, s);
  return { id: await nuevaOrden(ctx, [{ item, cant: 1, precio: 100000, stock: s }]), s };
}
const procesar = (db, id) => q(db, `SELECT public.meli_procesar_orden($1, 1000) AS r`, [id]).then(x => x[0].r);
const acreditar = (db, id) => q(db, `SELECT public.meli_acreditar_orden($1, NULL, false) AS r`, [id]).then(x => x[0].r);
const revertir = (db, id) => q(db, `SELECT public.meli_revertir_orden($1, 'prueba') AS r`, [id]).then(x => x[0].r);
const acreditada = async (ctx) => { const o = await ordenLista(ctx); await procesar(ctx.db, o.id); await acreditar(ctx.db, o.id); return o; };
const act = async (db, ordenId) => (await q(db, `SELECT * FROM public.actividades WHERE origen_orden_id = $1`, [ordenId]))[0];
const saldo = async (db, bolsillo) => Number((await q(db, `SELECT saldo FROM public.cajas WHERE bolsillo = $1`, [bolsillo]))[0].saldo);
const total = async (db) => Number((await q(db, `SELECT COALESCE(sum(saldo),0) s FROM public.cajas`))[0].s);
const libro = async (db) => (await q(db, `SELECT count(*)::int n FROM public.caja_ledger`))[0].n;
const intentoActual = async (db, id) => { const f = (await q(db, `SELECT intento FROM public.actividades WHERE id=$1`, [id]))[0]; return f ? f.intento : 1; };
const transferir = async (db, id, persona, bolsillo = 'ARS transferencia', nota = null, intento) =>
  q(db, `SELECT public.actividad_transferir($1,$2,$3,$4,$5) AS r`, [id, intento === undefined ? await intentoActual(db, id) : intento, persona, bolsillo, nota]).then(x => x[0].r);
const revisionActual = async (db, id) => { const f = (await q(db, `SELECT revision FROM public.actividades WHERE id=$1`, [id]))[0]; return f ? f.revision : 1; };
const marcar = async (db, id, nota = null, rev) => q(db, `SELECT public.actividad_marcar_hecha($1,$2,$3) AS r`, [id, rev === undefined ? await revisionActual(db, id) : rev, nota]).then(x => x[0].r);
const reabrir = async (db, id, rev) => q(db, `SELECT public.actividad_reabrir($1,$2) AS r`, [id, rev === undefined ? await revisionActual(db, id) : rev]).then(x => x[0].r);
const anular = async (db, id, rev) => q(db, `SELECT public.actividad_anular($1,$2) AS r`, [id, rev === undefined ? await revisionActual(db, id) : rev]).then(x => x[0].r);
const compensar = async (db, id, nota = null, intento) =>
  q(db, `SELECT public.actividad_compensar($1,$2,$3) AS r`, [id, intento === undefined ? await intentoActual(db, id) : intento, nota]).then(x => x[0].r);
const crear = (db, ...a) => q(db, `SELECT public.actividad_crear($1,$2,$3,$4,$5) AS r`, a).then(x => x[0].r);

console.log('\n══ Actividades: transferir lo que libera Mercado Libre (Postgres en WebAssembly) ══\n');

// ── 1 · Instalación ─────────────────────────────────────────────────────────
{
  const c = await nueva({ con15: false });
  const res = await c.db.exec(SQL('actividades.sql'));
  const e2 = await falla(() => c.db.exec(SQL('actividades.sql')));
  check('El script 15 corre dos veces seguidas sin romper (idempotente)', !e2, e2);
  const tabla = (await c.db.exec(SQL('actividades.sql'))).pop().rows;
  check('La tabla de verificación sale toda en ✅ (6 controles)', tabla.length === 6 && tabla.every(x => x.resultado === '✅'), JSON.stringify(tabla.map(x => [x.id, x.resultado])));
  const sin = new PGlite({ extensions: { pgcrypto } });
  const e3 = await falla(() => sin.exec(SQL('actividades.sql')));
  check('Sin los scripts previos frena con un mensaje claro', e3 && e3.includes('Faltan los scripts 1, 3, 4'), e3);
}

// ── 2 · Una actividad por orden acreditada, creada en la misma transacción ─
{
  const c = await nueva();
  const o = await ordenLista(c);
  await procesar(c.db, o.id);
  check('Procesar (sin acreditar) NO crea actividad', (await act(c.db, o.id)) === undefined);
  await acreditar(c.db, o.id);
  const a = await act(c.db, o.id);
  check('Al acreditar se crea UNA actividad pendiente con el monto confirmado, la caja de origen y la clave de la orden',
    a && a.tipo === 'meli_transferir' && a.estado === 'pendiente' && Number(a.monto) === 85000 && a.moneda === 'ARS' && a.origen_bolsillo === 'ARS Mercado Pago'
    && a.origen_persona_id === c.persona && a.clave_unica === 'meli-transf-' + o.id && a.movio_plata === false, JSON.stringify(a));
  const hoyAR = (await q(c.db, `SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date d`))[0].d.toISOString().slice(0, 10);
  check('La fecha objetivo es el día de la acreditación en hora de Argentina', a.fecha_objetivo.toISOString().slice(0, 10) === hoyAR, String(a.fecha_objetivo));
  await acreditar(c.db, o.id);
  for (let i = 0; i < 3; i++) await c.db.query(`UPDATE public.meli_ordenes SET actualizado_en = now(), revisar = false WHERE id = $1`, [o.id]);
  check('Acreditar de nuevo y UPDATEs repetidos de la orden NO crean otra actividad ni la tocan', (await q(c.db, `SELECT count(*)::int n FROM public.actividades`))[0].n === 1);
}

// ── 3 · Transferir: mueve la plata Y marca, en una transacción ───────────────
{
  const c = await nueva();
  const o = await acreditada(c); const a = await act(c.db, o.id);
  const t0 = await total(c.db);
  const r = await transferir(c.db, a.id, c.persona, 'ARS transferencia', 'a la cuenta de la empresa');
  const d = await act(c.db, o.id);
  check('Transferir: sale de «ARS Mercado Pago» y entra a «ARS transferencia» por el MISMO monto (el total de plata no cambia)',
    r.ok && await saldo(c.db, 'ARS Mercado Pago') === 0 && await saldo(c.db, 'ARS transferencia') === 85000 && await total(c.db) === t0, JSON.stringify([r, t0]));
  check('La actividad queda hecha, con plata movida, destino, quién y cuándo, y la nota',
    d.estado === 'hecha' && d.movio_plata && d.destino_bolsillo === 'ARS transferencia' && d.destino_persona_id === c.persona && d.hecha_en && d.hecha_por && d.nota === 'a la cuenta de la empresa', JSON.stringify(d));
  const l = await q(c.db, `SELECT clave, delta FROM public.caja_ledger WHERE clave LIKE 'act-%' ORDER BY clave`);
  check('El libro tiene las dos patas con la clave de la actividad (con su token NO adivinable: act-<uuid>-t1)', l.length === 2 && l[0].clave === `act-${a.token}-t1:d` && l[1].clave === `act-${a.token}-t1:o`, JSON.stringify(l));
  const n1 = await libro(c.db);
  const r2 = await transferir(c.db, a.id, c.persona);
  check('Transferir otra vez a la MISMA caja: «ya hecha», sin mover plata de nuevo', r2.ya_hecha === true && await libro(c.db) === n1 && await saldo(c.db, 'ARS transferencia') === 85000, JSON.stringify(r2));
  check('Transferir a OTRA caja una actividad ya transferida: error, nada se mueve', /ACTIVIDAD_YA_TRANSFERIDA_A_OTRA_CAJA/.test(await falla(() => transferir(c.db, a.id, c.persona, 'ARS cash')) || ''));
  check('«Solo marcar» una actividad ya transferida: error (no responde éxito)', /ACTIVIDAD_YA_TRANSFERIDA/.test(await falla(() => marcar(c.db, a.id)) || ''));
  check('Reabrir una actividad que movió plata: error (hay que compensar)', /ACTIVIDAD_YA_TRANSFERIDA/.test(await falla(() => reabrir(c.db, a.id)) || ''));
  check('Anular una actividad ya hecha: error', /ACTIVIDAD_NO_ANULABLE/.test(await falla(() => anular(c.db, a.id)) || ''));
}

// ── 4 · Validaciones del traspaso: nada se mueve y la actividad sigue pendiente ─
{
  const c = await nueva();
  const o = await acreditada(c); const a = await act(c.db, o.id);
  const intento = async (persona, bolsillo) => ({ err: await falla(() => transferir(c.db, a.id, persona, bolsillo)), n: await libro(c.db) });
  const base = await libro(c.db);
  const casos = [
    ['destino igual al origen', c.persona, 'ARS Mercado Pago', /DESTINO_IGUAL_ORIGEN/],
    ['caja en dólares', c.persona, 'USD cash', /CAJA_NO_EN_PESOS/],
    ['caja que no existe', c.persona, 'ARS inventada', /CAJA_DESTINO_INEXISTENTE/],
    ['persona nula', null, 'ARS transferencia', /DESTINO_INCOMPLETO/],
    ['bolsillo vacío', c.persona, '  ', /DESTINO_INCOMPLETO/],
  ];
  for (const [txt, p, b, re] of casos) {
    const r = await intento(p, b);
    check(`Transferir con ${txt}: se rechaza y el libro no cambia`, re.test(r.err || '') && r.n === base, String(r.err));
  }
  check('… y la actividad sigue pendiente', (await act(c.db, o.id)).estado === 'pendiente');
  // saldo insuficiente: se vació la caja de origen por fuera
  await c.db.query(`UPDATE public.cajas SET saldo = 1000 WHERE bolsillo = 'ARS Mercado Pago'`);
  const e = await falla(() => transferir(c.db, a.id, c.persona));
  check('Saldo insuficiente en la caja de origen: error SALDO_INSUFICIENTE, ningún asiento y la actividad sigue pendiente',
    /SALDO_INSUFICIENTE/.test(e || '') && await libro(c.db) === base && (await act(c.db, o.id)).estado === 'pendiente' && await saldo(c.db, 'ARS Mercado Pago') === 1000, String(e));
  const e2 = await falla(() => transferir(c.db, 999999, c.persona));
  check('Una actividad inexistente da ACTIVIDAD_INEXISTENTE', /ACTIVIDAD_INEXISTENTE/.test(e2 || ''));
}

// ── 5 · «Solo marcar», reabrir y anular ─────────────────────────────────────
{
  const c = await nueva();
  const o = await acreditada(c); const a = await act(c.db, o.id);
  const n0 = await libro(c.db);
  const r = await marcar(c.db, a.id, 'lo hice desde la app del banco');
  const d = await act(c.db, o.id);
  check('Solo marcar: queda hecha SIN mover plata (cajas y libro intactos)', r.ok && r.movio_plata === false && d.estado === 'hecha' && d.movio_plata === false && await libro(c.db) === n0 && await saldo(c.db, 'ARS Mercado Pago') === 85000);
  check('Marcar otra vez: «ya hecha» (idempotente)', (await marcar(c.db, a.id)).ya_hecha === true);
  check('Transferir una ya marcada sin mover: error ACTIVIDAD_YA_MARCADA_SIN_MOVER (nunca éxito de transferencia)', /ACTIVIDAD_YA_MARCADA_SIN_MOVER/.test(await falla(() => transferir(c.db, a.id, c.persona)) || ''));
  check('Reabrir una marcada sin mover: vuelve a pendiente', (await reabrir(c.db, a.id)).ok === true && (await act(c.db, o.id)).estado === 'pendiente');
  check('Reabrir una pendiente: «ya pendiente»', (await reabrir(c.db, a.id)).ya_pendiente === true);
  check('Después de reabrir, transferir funciona', (await transferir(c.db, a.id, c.persona)).ok === true && await saldo(c.db, 'ARS transferencia') === 85000);
  const o2 = await acreditada(c); const a2 = await act(c.db, o2.id);
  check('Anular una pendiente', (await anular(c.db, a2.id)).ok === true && (await act(c.db, o2.id)).estado === 'anulada');
  check('Anular de nuevo: «ya anulada»; marcar o transferir una anulada: error', (await anular(c.db, a2.id)).ya_anulada === true
    && /ACTIVIDAD_ANULADA/.test(await falla(() => marcar(c.db, a2.id)) || '') && /ACTIVIDAD_ANULADA/.test(await falla(() => transferir(c.db, a2.id, c.persona)) || ''));
}

// ── 6 · Revertir la orden ───────────────────────────────────────────────────
{
  const c = await nueva();
  // a) actividad pendiente → se anula con la reversión
  const o1 = await acreditada(c); const a1 = await act(c.db, o1.id);
  await revertir(c.db, o1.id);
  const d1 = await act(c.db, o1.id);
  check('Revertir una orden con la actividad PENDIENTE: la actividad queda anulada con nota y la plata vuelve', d1.estado === 'anulada' && /revirtió/.test(d1.nota || '') && await saldo(c.db, 'ARS Mercado Pago') === 0);
  // b) transferida por el CRM → la reversión se rechaza y NO queda nada a medias
  const o2 = await acreditada(c); const a2 = await act(c.db, o2.id);
  await transferir(c.db, a2.id, c.persona);
  const stock2 = (await q(c.db, `SELECT sum(cantidad)::int s FROM public.stock`))[0].s, l2 = await libro(c.db), tot2 = await total(c.db);
  const e = await falla(() => revertir(c.db, o2.id));
  const ord = (await q(c.db, `SELECT revertida_en FROM public.meli_ordenes WHERE id=$1`, [o2.id]))[0];
  check('Revertir una orden YA TRANSFERIDA por el CRM: error ORDEN_YA_TRANSFERIDA y nada cambia (ni stock, ni caja, ni libro, ni orden)',
    /ORDEN_YA_TRANSFERIDA/.test(e || '') && ord.revertida_en === null && (await q(c.db, `SELECT sum(cantidad)::int s FROM public.stock`))[0].s === stock2 && await libro(c.db) === l2 && await total(c.db) === tot2, String(e));
  // c) compensar → pendiente de nuevo → ahora sí se puede revertir
  const comp = await compensar(c.db, a2.id, 'me equivoqué de caja');
  const d2 = await act(c.db, o2.id);
  check('Compensar: traspaso inverso (la plata vuelve a «ARS Mercado Pago»), actividad pendiente, sin destino y con el intento subido', comp.ok && d2.estado === 'pendiente' && d2.movio_plata === false && d2.destino_bolsillo === null && d2.intento === 2 && await saldo(c.db, 'ARS Mercado Pago') === 85000 && await saldo(c.db, 'ARS transferencia') === 0, JSON.stringify(d2));
  await revertir(c.db, o2.id);
  check('Con la transferencia compensada, revertir la orden funciona y anula la actividad', (await act(c.db, o2.id)).estado === 'anulada' && await saldo(c.db, 'ARS Mercado Pago') === 0);
  // d) hecha sin mover plata → la reversión pasa y queda nota
  const o3 = await acreditada(c); const a3 = await act(c.db, o3.id);
  await marcar(c.db, a3.id);
  await revertir(c.db, o3.id);
  const d3 = await act(c.db, o3.id);
  check('Revertir con la actividad hecha SIN mover plata: pasa; la actividad sigue hecha con una nota', d3.estado === 'hecha' && /revirtió/.test(d3.nota || ''));
  check('Una actividad de una orden revertida no se puede reabrir', /ORDEN_REVERTIDA/.test(await falla(() => reabrir(c.db, a3.id)) || ''));
}

// ── 7 · Una transferencia deshecha puede hacerse de nuevo (la clave no se «come») ─
{
  const c = await nueva();
  const o = await acreditada(c); const a = await act(c.db, o.id);
  await transferir(c.db, a.id, c.persona);
  await compensar(c.db, a.id);
  const r = await transferir(c.db, a.id, c.persona);
  const claves = (await q(c.db, `SELECT clave FROM public.caja_ledger WHERE clave LIKE 'act-%' ORDER BY clave`)).map(x => x.clave);
  check('Transferir de nuevo tras compensar MUEVE la plata de verdad (claves del intento 2, con token) y el libro cuadra',
    r.ok && await saldo(c.db, 'ARS transferencia') === 85000 && await saldo(c.db, 'ARS Mercado Pago') === 0 && claves.some(k => k.startsWith(`act-${a.token}-t2`)) && claves.some(k => k.startsWith(`act-${a.token}-c1`)), JSON.stringify(claves));
  // compensar sin saldo en la caja de la empresa
  await c.db.query(`UPDATE public.cajas SET saldo = 100 WHERE bolsillo = 'ARS transferencia'`);
  const e = await falla(() => compensar(c.db, a.id));
  check('Compensar sin saldo suficiente en la caja de la empresa: SALDO_INSUFICIENTE y nada cambia', /SALDO_INSUFICIENTE/.test(e || '') && (await act(c.db, o.id)).movio_plata === true);
  check('Compensar una actividad que no movió plata: error', /ACTIVIDAD_SIN_TRANSFERENCIA/.test(await falla(async () => { const o2 = await acreditada(c); await compensar(c.db, (await act(c.db, o2.id)).id); }) || ''));
}

// ── 7b · Reintentos tardíos: un pedido de un intento anterior NO se ejecuta ──
{
  const c = await nueva();
  const o = await acreditada(c); const a = await act(c.db, o.id);
  await transferir(c.db, a.id, c.persona, 'ARS transferencia', null, 1);
  await compensar(c.db, a.id, null, 1);                       // ahora intento = 2, pendiente
  const n0 = await libro(c.db);
  const e1 = await falla(() => transferir(c.db, a.id, c.persona, 'ARS transferencia', null, 1));
  check('Un reintento atrasado de «transferir» del intento 1 (después de compensar) se RECHAZA: ACTIVIDAD_DESACTUALIZADA y no mueve nada', /ACTIVIDAD_DESACTUALIZADA/.test(e1 || '') && await libro(c.db) === n0 && await saldo(c.db, 'ARS transferencia') === 0, String(e1));
  const r2 = await compensar(c.db, a.id, null, 1);
  check('Reintentar la compensación del intento 1 que YA se aplicó: «ya compensada», sin tocar nada', r2.ya_compensada === true && await libro(c.db) === n0);
  await transferir(c.db, a.id, c.persona, 'ARS transferencia', null, 2);   // nueva transferencia (intento 2)
  const n1 = await libro(c.db);
  const e3 = await falla(() => compensar(c.db, a.id, null, 1));
  check('Un reintento viejo de «compensar» (intento 1) NO deshace la transferencia NUEVA (intento 2): ACTIVIDAD_DESACTUALIZADA', /ACTIVIDAD_DESACTUALIZADA/.test(e3 || '') && await libro(c.db) === n1 && (await act(c.db, o.id)).movio_plata === true && await saldo(c.db, 'ARS transferencia') === 85000, String(e3));
  check('Sin indicar el intento, las dos funciones exigen el dato', /INTENTO_REQUERIDO/.test(await falla(() => transferir(c.db, a.id, c.persona, 'ARS transferencia', null, null)) || '') && /INTENTO_REQUERIDO/.test(await falla(() => compensar(c.db, a.id, null, null)) || ''));
  check('Repetir la transferencia vigente (mismo intento): «ya hecha»', (await transferir(c.db, a.id, c.persona, 'ARS transferencia', null, 2)).ya_hecha === true);
}

// ── 7c · Revisión de estado: un pedido viejo de marcar / reabrir / anular no pisa uno más nuevo ──
{
  const c = await nueva();
  const o = await acreditada(c); const a = await act(c.db, o.id);
  const r0 = a.revision;
  await marcar(c.db, a.id, null, r0);                                 // r0 → hecha (revisión sube)
  const d1 = await act(c.db, o.id);
  check('Cada cambio de estado sube la revisión', d1.revision === r0 + 1, JSON.stringify(d1.revision));
  check('Reintentar el «marcar» ya aplicado (revisión vieja): «ya hecha», sin error', (await marcar(c.db, a.id, null, r0)).ya_hecha === true);
  await reabrir(c.db, a.id, d1.revision);                              // vuelve a pendiente (revisión sube otra vez)
  const e1 = await falla(() => marcar(c.db, a.id, null, r0));
  check('Un «marcar» ATRASADO (de antes de reabrir) se rechaza: ACTIVIDAD_DESACTUALIZADA, la actividad sigue pendiente', /ACTIVIDAD_DESACTUALIZADA/.test(e1 || '') && (await act(c.db, o.id)).estado === 'pendiente', String(e1));
  const e2 = await falla(() => anular(c.db, a.id, r0));
  check('Un «anular» atrasado se rechaza y no oculta la tarea pendiente', /ACTIVIDAD_DESACTUALIZADA/.test(e2 || '') && (await act(c.db, o.id)).estado === 'pendiente');
  const rr = await reabrir(c.db, a.id, d1.revision);
  check('Reintentar un «reabrir» que YA se aplicó (revisión vieja, la actividad sigue pendiente): «ya pendiente», sin error', rr.ya_pendiente === true);
  await marcar(c.db, a.id);                                           // otro cambio posterior: hecha de nuevo
  const e3 = await falla(() => reabrir(c.db, a.id, d1.revision));
  check('Un «reabrir» atrasado que llega DESPUÉS de otro cambio se rechaza (ACTIVIDAD_DESACTUALIZADA) y la actividad sigue hecha', /ACTIVIDAD_DESACTUALIZADA/.test(e3 || '') && (await act(c.db, o.id)).estado === 'hecha', String(e3));
  await reabrir(c.db, a.id);
  const actual = await revisionActual(c.db, a.id);
  const an = await anular(c.db, a.id, actual);
  check('Con la revisión vigente, anular funciona; repetirlo con la revisión vieja da «ya anulada»', an.ok && (await anular(c.db, a.id, actual)).ya_anulada === true);
  check('Sin indicar la revisión las tres funciones exigen el dato', (await Promise.all([marcar(c.db, a.id, null, null), reabrir(c.db, a.id, null), anular(c.db, a.id, null)].map(p => falla(() => p)))).every(m => /REVISION_REQUERIDA/.test(m || '')));
  // la reversión de la orden (trigger) también sube la revisión
  const o2 = await acreditada(c); const a2 = await act(c.db, o2.id);
  await revertir(c.db, o2.id);
  check('La anulación hecha por la reversión de la orden también sube la revisión', (await act(c.db, o2.id)).revision > a2.revision);
}

// ── 7d · Instalar sobre una versión anterior: las firmas viejas se borran (no queda una sobrecarga que eluda la protección) ──
{
  const c = await nueva({ con15: false });
  await c.db.exec(`CREATE FUNCTION public.actividad_transferir(p_id BIGINT, p_persona UUID, p_bolsillo TEXT, p_nota TEXT) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
                   CREATE FUNCTION public.actividad_compensar(p_id BIGINT, p_nota TEXT) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
                   CREATE FUNCTION public.actividad_marcar_hecha(p_id BIGINT, p_nota TEXT) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
                   CREATE FUNCTION public.actividad_reabrir(p_id BIGINT) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
                   CREATE FUNCTION public.actividad_anular(p_id BIGINT) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;`);
  await c.db.exec(SQL('actividades.sql'));
  const viejas = (await q(c.db, `SELECT p.oid::regprocedure::text f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='public' AND p.proname ~ '^actividad_[a-z]' ORDER BY 1`)).map(r => r.f);
  check('Después de instalar, de cada función pública queda UNA sola firma (las anteriores se borraron)', viejas.length === 6, JSON.stringify(viejas));
}

// ── 8 · Actividades manuales ────────────────────────────────────────────────
{
  const c = await nueva();
  const r = await crear(c.db, 'Pagar el alquiler', '2026-11-05', 150000, 'ARS', 'recordatorio');
  const m = (await q(c.db, `SELECT * FROM public.actividades WHERE id=$1`, [r.id]))[0];
  check('Crear una actividad manual', r.ok && m.tipo === 'manual' && m.estado === 'pendiente' && Number(m.monto) === 150000 && m.moneda === 'ARS' && m.clave_unica === null, JSON.stringify(m));
  const sin = await crear(c.db, 'Llamar al contador', '2026-11-06', null, null, null);
  check('Una manual sin monto ni moneda es válida', sin.ok === true);
  const malos = [['título vacío', ['  ', '2026-11-05']], ['título largo', ['x'.repeat(201), '2026-11-05']], ['título con salto de línea', ['a\nb', '2026-11-05']],
    ['fecha nula', ['ok', null]], ['monto negativo', ['ok', '2026-11-05', -5]], ['monto NaN', ['ok', '2026-11-05', 'NaN']], ['moneda inválida', ['ok', '2026-11-05', 5, 'EUR']], ['nota larga', ['ok', '2026-11-05', null, null, 'n'.repeat(201)]]];
  for (const [t, a] of malos) check(`Crear con ${t}: se rechaza`, !!(await falla(() => crear(c.db, ...[a[0], a[1], a[2] ?? null, a[3] ?? null, a[4] ?? null]))));
  check('Una manual no se puede «transferir»', /ACTIVIDAD_NO_TRANSFERIBLE/.test(await falla(() => transferir(c.db, r.id, c.persona)) || ''));
  check('Una manual se puede marcar, reabrir y anular', (await marcar(c.db, r.id)).ok && (await reabrir(c.db, r.id)).ok && (await anular(c.db, r.id)).ok);
}

// ── 8b · Una acreditación válida no puede chocar con los límites de la actividad ──
{
  const c = await nueva();
  const o = await ordenLista(c);
  await c.db.query(`UPDATE public.meli_ordenes SET meli_order_id = $2, bruto = 9999999999999.99, neto = 9999999999999.99 WHERE id = $1`, [o.id, '2000' + '9'.repeat(250)]);
  await c.db.query(`INSERT INTO public.actividades (tipo, titulo, monto, moneda, fecha_objetivo, clave_unica, origen_orden_id, origen_persona_id, origen_bolsillo, creada_por)
                    SELECT 'meli_transferir', left('Transferir ' || meli_order_id, 200), 9999999999999.99, 'ARS', current_date, 'x', id, $2, 'ARS Mercado Pago', 't' FROM public.meli_ordenes WHERE id = $1`, [o.id, c.persona]);
  const f = await act(c.db, o.id);
  check('La actividad admite un monto del tamaño de monto_acreditado (NUMERIC 18,2) y un id de orden larguísimo con el título truncado a 200', Number(f.monto) === 9999999999999.99 && f.titulo.length === 200);
}

// ── 9 · Si el INSERT de la actividad falla, la acreditación entera se deshace ─
{
  const c = await nueva();
  const o = await ordenLista(c); await procesar(c.db, o.id);
  await c.db.query(`ALTER TABLE public.actividades ADD CONSTRAINT prueba_rota CHECK (false) NOT VALID`);
  const caja0 = await saldo(c.db, 'ARS Mercado Pago'), l0 = await libro(c.db);
  const e = await falla(() => acreditar(c.db, o.id));
  const ord = (await q(c.db, `SELECT acreditado, acreditado_en FROM public.meli_ordenes WHERE id=$1`, [o.id]))[0];
  const v = (await q(c.db, `SELECT v.estado FROM public.ventas v JOIN public.meli_ordenes m ON m.venta_id = v.id WHERE m.id=$1`, [o.id]))[0];
  check('Fallo deliberado del INSERT: la acreditación entera se deshace (orden sin acreditar, caja y libro intactos, venta abierta, sin actividad)',
    !!e && ord.acreditado === false && await saldo(c.db, 'ARS Mercado Pago') === caja0 && await libro(c.db) === l0 && v.estado === 'abierta' && (await act(c.db, o.id)) === undefined, String(e));
  await c.db.query(`ALTER TABLE public.actividades DROP CONSTRAINT prueba_rota`);
  await acreditar(c.db, o.id);
  check('Sin el fallo, acreditar funciona y crea la actividad', !!(await act(c.db, o.id)));
}

// ── 10 · Órdenes acreditadas ANTES del script no generan actividad ─────────
{
  const c = await nueva({ con15: false });
  const o = await acreditada(c);
  await c.db.exec(SQL('actividades.sql'));
  check('Una orden acreditada antes de instalar el script no genera actividad sola', (await q(c.db, `SELECT count(*)::int n FROM public.actividades`))[0].n === 0);
  await c.db.query(`UPDATE public.meli_ordenes SET actualizado_en = now() WHERE id = $1`, [o.id]);
  check('… ni siquiera con un UPDATE posterior de la orden', (await q(c.db, `SELECT count(*)::int n FROM public.actividades`))[0].n === 0);
}

// ── 11 · Permisos ───────────────────────────────────────────────────────────
{
  const c = await nueva();
  const o = await acreditada(c); const a = await act(c.db, o.id);
  const como = (rol, email, fn) => comoRol(c.db, rol, email, fn);
  check('anon no puede LEER la tabla', !!(await como('anon', null, () => falla(() => c.db.query(`SELECT * FROM public.actividades`)))) );
  check('anon no puede ejecutar ninguna función pública', (await Promise.all([
    como('anon', null, () => falla(() => transferir(c.db, a.id, c.persona))), como('anon', null, () => falla(() => marcar(c.db, a.id))),
    como('anon', null, () => falla(() => crear(c.db, 'x', '2026-11-05', null, null, null))), como('anon', null, () => falla(() => anular(c.db, a.id)))])).every(Boolean));
  check('Un usuario autenticado NO autorizado: no ve filas y las funciones dicen «no autorizado»',
    (await como('authenticated', 'baja@x.com', async () => (await q(c.db, `SELECT * FROM public.actividades`)).length)) === 0
    && /no autorizado/.test(await como('authenticated', 'baja@x.com', () => falla(() => marcar(c.db, a.id))) || ''));
  check('Un usuario autorizado LEE la tabla', (await como('authenticated', 'franco@x.com', async () => (await q(c.db, `SELECT * FROM public.actividades`)).length)) === 1);
  for (const [t, sql] of [['INSERT', `INSERT INTO public.actividades (tipo, titulo, fecha_objetivo) VALUES ('manual','x', current_date)`],
    ['UPDATE', `UPDATE public.actividades SET estado = 'hecha'`], ['DELETE', `DELETE FROM public.actividades`]]) {
    check(`Un usuario autorizado NO puede hacer ${t} directo sobre la tabla`, !!(await como('authenticated', 'franco@x.com', () => falla(() => c.db.query(sql)))));
  }
  check('authenticated no ejecuta las ayudas internas ni las funciones de trigger', (await Promise.all([
    como('authenticated', 'franco@x.com', () => falla(() => c.db.query(`SELECT public.actividad__bloquear($1)`, [a.id]))),
    como('authenticated', 'franco@x.com', () => falla(() => c.db.query(`SELECT public.actividad__usuario()`))),
    como('authenticated', 'franco@x.com', () => falla(() => c.db.query(`SELECT public.meli__actividad_crear()`)))])).every(Boolean));
  check('Los datos no cambiaron por los intentos fallidos', (await act(c.db, o.id)).estado === 'pendiente');
}

// ── 12 · Convivencia con «cerrar a mano» (script 12) ────────────────────────
{
  const c = await nueva();
  const o = await ordenLista(c);
  await q(c.db, `SELECT public.meli_orden_cerrar_manual($1,'descartada',NULL,NULL)`, [o.id]);
  const e = await falla(() => acreditar(c.db, o.id));
  check('Una orden cerrada a mano no se acredita (la guarda del script 12 sigue mandando) y no genera actividad', !!e && (await act(c.db, o.id)) === undefined, String(e));
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
