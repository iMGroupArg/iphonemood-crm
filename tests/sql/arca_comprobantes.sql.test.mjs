// Banco de pruebas de db/pendientes/arca_comprobantes.sql contra un Postgres REAL (pglite).
//
//   cd tests/sql && node arca_comprobantes.sql.test.mjs
//
// Carga el script 3 real, el 16 y el de comprobantes. Prueba: numeración (reserva, último de ARCA, rechazo que libera el número),
// el candado de numeración pendiente, que el importe tenga que coincidir con la orden, una factura por orden, idempotencia,
// inmodificabilidad de lo autorizado, permisos reales (anon/authenticated) y el ticket con su candado.
// LÍMITE: pglite tiene UNA conexión; las carreras reales quedan para un banco de concurrencia.
import { baseNueva, SQL, SECRETO, nuevaOrden, comoRol } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };

const PREPARAR = `
  DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;
  GRANT USAGE ON SCHEMA public TO service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;`;
const SCRIPT = SQL('arca_comprobantes.sql');
const nueva = async () => {
  const c = await baseNueva({ conVentas: false, sin7: true });
  await c.db.exec(PREPARAR);
  await c.db.exec(SQL('meli_facturas.sql'));
  await c.db.exec(SCRIPT);
  return c;
};
const ordenId = async (ctx, bruto = 100000) => {
  const id = await nuevaOrden(ctx, [{ item: 'MLA1', cant: 1, precio: bruto }], { bruto, neto: bruto - 1000 });
  return (await ctx.db.query(`SELECT meli_order_id m FROM public.meli_ordenes WHERE id=$1`, [id])).rows[0].m;
};
const reservar = (db, orden, o = {}) => db.query(
  `SELECT public.arca_comprobante_reservar($1,$2,$3,$4,$5,$6,$7,$8,$9) r`,
  [o.secreto ?? SECRETO, orden, o.amb ?? 'homologacion', o.pv ?? 1, o.ultimo ?? 0, o.importe ?? 10000000, o.dt ?? 99, o.dn ?? '0', o.cond ?? 5]).then((x) => x.rows[0].r);
const autorizar = (db, intento, numero, cae = '74123456789012', o = {}) => db.query(
  `SELECT public.arca_comprobante_autorizar($1,$2,$3,$4,$5,$6) r`, [o.secreto ?? SECRETO, intento, numero, cae, '2026-11-12', '2026-11-02']).then((x) => x.rows[0].r);
const rechazar = (db, intento, numero, e = 'ARCA rechazó') => db.query(`SELECT public.arca_comprobante_rechazar($1,$2,$3,$4) r`, [SECRETO, intento, numero, e]).then((x) => x.rows[0].r);
const estado = (db, orden, amb = 'homologacion') => db.query(`SELECT public.arca_comprobante_estado($1,$2,$3) r`, [SECRETO, orden, amb]).then((x) => x.rows[0].r);
const tomar = (db, orden, amb = 'homologacion') => db.query(`SELECT public.arca_comprobante_conciliar_tomar($1,$2,$3) r`, [SECRETO, orden, amb]).then((x) => x.rows[0].r);
const fila = async (db, orden, amb = 'homologacion') => (await db.query(`SELECT * FROM public.meli_comprobantes WHERE orden_id=$1 AND ambiente=$2`, [orden, amb])).rows[0];
// Hace como que pasaron 3 minutos: vence el candado del intento.
const vencer = (db) => db.query(`UPDATE public.meli_comprobantes SET trabajo_hasta = now() - interval '1 second' WHERE trabajo_hasta IS NOT NULL`);

console.log('\n══ Comprobantes de ARCA (Postgres en WebAssembly) ══\n');

// ── 1 · Corre limpio y repetido; exige sus requisitos ──
{
  const ctx = await nueva(); const { db } = ctx;
  const e = await falla(() => db.exec(SCRIPT));
  check('El script corre dos veces más sin romper (idempotente)', !e, e);
  const vacia = await baseNueva({ conVentas: false, sin7: true });
  const e2 = await falla(() => vacia.db.exec(SCRIPT));
  check('Sin el script 16 frena con un mensaje claro', e2 && e2.includes('Faltan los scripts'), e2);
  const res = await db.exec(SCRIPT); const t = res[res.length - 1].rows;
  check('La verificación sale toda en ✅', t.length === 2 && t.every((x) => x.resultado === '✅'), JSON.stringify(t));
}

// ── 2 · Numeración ──
{
  const ctx = await nueva(); const { db } = ctx;
  const a = await ordenId(ctx), b = await ordenId(ctx), c = await ordenId(ctx);
  const r1 = await reservar(db, a, { ultimo: 7 });
  check('Reserva: último de ARCA 7 → número 8, estado reservado, con intento', r1.numero === 8 && r1.estado === 'reservado' && !!r1.intento, JSON.stringify(r1));
  const e0 = await falla(() => reservar(db, a, { ultimo: 7 }));
  check('Reservar otra vez la MISMA orden y ambiente → COMPROBANTE_YA_EXISTE (no consume otro número)', e0 && e0.includes('COMPROBANTE_YA_EXISTE'), e0);
  const e = await falla(() => reservar(db, b, { ultimo: 7 }));
  check('Con una reserva sin resolver, ninguna otra orden puede reservar (NUMERACION_PENDIENTE)', e && e.includes('NUMERACION_PENDIENTE'), e);
  await autorizar(db, r1.intento, 8);
  const r2 = await reservar(db, b, { ultimo: 7 });
  check('Autorizada la primera, la siguiente recibe el 9 aunque ARCA aún diga 7', r2.numero === 9, JSON.stringify(r2));
  await autorizar(db, r2.intento, 9, '74123456789013');
  const r3 = await reservar(db, c, { ultimo: 20 });
  check('Si ARCA está más adelante (20), se sigue desde ARCA: 21', r3.numero === 21, JSON.stringify(r3));
  const otroPv = await ordenId(ctx);
  const r4 = await reservar(db, otroPv, { ultimo: 0, pv: 2 });
  check('Otro punto de venta tiene su propia numeración (pendiente en el 1 no lo frena)', r4.numero === 1, JSON.stringify(r4));
}

// ── 3 · Importe, moneda y receptor ──
{
  const ctx = await nueva(); const { db } = ctx;
  const a = await ordenId(ctx, 123456.78);
  check('Importe distinto al de la orden → IMPORTE_NO_COINCIDE', (await falla(() => reservar(db, a, { importe: 12345679 })))?.includes('IMPORTE_NO_COINCIDE'));
  const r = await reservar(db, a, { importe: 12345678 });
  check('Importe exacto en centavos (123456.78 → 12345678) reserva', r.estado === 'reservado' && Number(r.importe_centavos) === 12345678, JSON.stringify(r));
  const b = await ordenId(ctx);
  await rechazar(db, r.intento, r.numero);
  check('Receptor inválido: consumidor final con documento ≠ 0', (await falla(() => reservar(db, b, { dt: 99, dn: '123' })))?.includes('RECEPTOR_INVALIDO'));
  check('Receptor inválido: tipo de documento desconocido', (await falla(() => reservar(db, b, { dt: 55, dn: '123' })))?.includes('RECEPTOR_INVALIDO'));
  check('Receptor inválido: documento con letras', (await falla(() => reservar(db, b, { dt: 96, dn: '12ab' })))?.includes('RECEPTOR_INVALIDO'));
  check('Condición frente al IVA fuera de rango', (await falla(() => reservar(db, b, { cond: 0 })))?.includes('CONDICION_IVA_INVALIDA'));
  const ok96 = await reservar(db, b, { dt: 96, dn: '43577502', cond: 5 });
  const fb = await fila(db, b);
  check('DNI válido reserva y guarda documento y condición', ok96.estado === 'reservado' && fb.doc_nro === '43577502' && fb.cond_iva === 5, JSON.stringify(fb));
  check('Orden inexistente', (await falla(() => reservar(db, 'NO-EXISTE')))?.includes('ORDEN_INEXISTENTE'));
  await rechazar(db, ok96.intento, ok96.numero);
  await db.query(`UPDATE public.meli_ordenes SET moneda='USD' WHERE meli_order_id=$1`, [b]);
  check('Orden en otra moneda: MONEDA_NO_SOPORTADA', (await falla(() => reservar(db, b)))?.includes('MONEDA_NO_SOPORTADA'));
  await db.query(`UPDATE public.meli_ordenes SET moneda='ARS', estado='cancelled' WHERE meli_order_id=$1`, [b]);
  check('Orden no pagada: ORDEN_NO_FACTURABLE', (await falla(() => reservar(db, b)))?.includes('ORDEN_NO_FACTURABLE'));
}

// ── 4 · Autorizar, rechazar y reintentar ──
{
  const ctx = await nueva(); const { db } = ctx;
  const a = await ordenId(ctx);
  const ra = await reservar(db, a, { ultimo: 3 });
  check('CAE inválido se rechaza', (await falla(() => autorizar(db, ra.intento, 4, 'abc')))?.includes('CAE_INVALIDO'));
  check('Autorizar con un número que no es el reservado se rechaza', (await falla(() => autorizar(db, ra.intento, 5)))?.includes('NUMERO_DISTINTO_AL_RESERVADO'));
  check('Autorizar con un intento desconocido se rechaza', (await falla(() => autorizar(db, '00000000-0000-4000-8000-000000000000', 4)))?.includes('INTENTO_NO_VIGENTE'));
  const au = await autorizar(db, ra.intento, 4);
  const f = await fila(db, a);
  check('Autorizar deja estado autorizado con CAE y fecha, y libera el candado', au.estado === 'autorizado' && f.estado === 'autorizado' && f.cae === '74123456789012' && f.numero === 4 && f.trabajo_hasta === null, JSON.stringify(f));
  check('Autorizar de nuevo con el mismo CAE es idempotente', (await autorizar(db, ra.intento, 4)).sin_cambios === true);
  check('Autorizar con OTRO CAE se rechaza', (await falla(() => autorizar(db, ra.intento, 4, '74999999999999')))?.includes('OTRO_CAE'));
  check('El estado de la orden muestra lo autorizado', (await estado(db, a)).estado === 'autorizado' && (await estado(db, a)).cae === '74123456789012');
  check('Reservar una orden ya autorizada no emite otra (COMPROBANTE_YA_EXISTE)', (await falla(() => reservar(db, a, { ultimo: 3 })))?.includes('COMPROBANTE_YA_EXISTE'));
  check('Una autorizada no se rechaza', (await falla(() => rechazar(db, ra.intento, 4)))?.includes('COMPROBANTE_NO_RESERVADO'));
  check('Una autorizada no se modifica ni con SQL directo', (await falla(() => db.query(`UPDATE public.meli_comprobantes SET importe_centavos=1 WHERE orden_id=$1`, [a])))?.includes('INMODIFICABLE'));
  check('No se borra', (await falla(() => db.query(`DELETE FROM public.meli_comprobantes`)))?.includes('NO_SE_BORRA'));
  check('No se vacía', (await falla(() => db.query(`TRUNCATE public.meli_comprobantes`)))?.includes('NO_SE_BORRA'));
  check('En homologación NO se marca el control de facturas (no tiene valor fiscal)', (await db.query(`SELECT count(*)::int n FROM public.meli_facturas`)).rows[0].n === 0);

  const b = await ordenId(ctx);
  const rb = await reservar(db, b, { ultimo: 3 });
  const rej = await rechazar(db, rb.intento, rb.numero, 'ARCA dijo que no');
  const fb = await fila(db, b);
  check('Rechazar libera el número (queda NULL) y guarda el motivo', rej.estado === 'rechazado' && fb.numero === null && fb.ultimo_error === 'ARCA dijo que no', JSON.stringify(fb));
  const rb2 = await reservar(db, b, { ultimo: 3 });
  const fb2 = await fila(db, b);
  check('Reintentar tras un rechazo reserva de nuevo (mismo siguiente número), con INTENTO nuevo y cuenta el intento', rb2.estado === 'reservado' && rb2.numero === rb.numero && rb2.intento !== rb.intento && fb2.intentos === 2, JSON.stringify(fb2));
  check('El intento viejo ya no sirve para autorizar ni rechazar', (await falla(() => autorizar(db, rb.intento, rb2.numero)))?.includes('INTENTO_NO_VIGENTE') && (await falla(() => rechazar(db, rb.intento, rb2.numero)))?.includes('INTENTO_NO_VIGENTE'));
  const c = await ordenId(ctx);
  await rechazar(db, rb2.intento, rb2.numero);
  const rc = await reservar(db, c, { ultimo: 3 });
  check('El número liberado lo puede tomar otra orden (sin chocar con el índice único)', rc.numero === 5, JSON.stringify(rc));
  const d = await ordenId(ctx);
  const dup = await falla(() => db.query(
    `INSERT INTO public.meli_comprobantes (orden_id, ambiente, cbte_tipo, pto_venta, numero, estado, importe_centavos, doc_tipo, doc_nro, cond_iva)
     VALUES ($1,'homologacion',11,1,5,'reservado',100,99,'0',5)`, [d]));
  check('Número duplicado imposible a nivel tabla (índice único)', dup && /meli_comprobantes_numero_unico|duplicate/i.test(dup), dup);
}

// ── 4b · Carreras entre procesos: el candado del intento ──
{
  const ctx = await nueva(); const { db } = ctx;
  const a = await ordenId(ctx);
  const r = await reservar(db, a, { ultimo: 0 });                           // el proceso 1 emite (tiene el candado)
  const t1 = await tomar(db, a);
  check('Mientras el proceso 1 trabaja, otro NO puede tomar la conciliación (en_curso)', t1.tomado === false && t1.en_curso === true, JSON.stringify(t1));
  await vencer(db);                                                         // pasan 2 minutos sin respuesta
  const t2 = await tomar(db, a);
  check('Vencido el candado, un segundo proceso la toma con intento NUEVO y datos guardados', t2.tomado === true && t2.intento !== r.intento && t2.numero === 1 && Number(t2.importe_centavos) === 10000000 && t2.doc_tipo === 99 && t2.cond_iva === 5, JSON.stringify(t2));
  check('El proceso 1 (intento viejo) ya no puede autorizar: no pisa al segundo', (await falla(() => autorizar(db, r.intento, 1)))?.includes('INTENTO_NO_VIGENTE'));
  check('El proceso 1 tampoco puede rechazar (no libera un número que ARCA pudo haber dado)', (await falla(() => rechazar(db, r.intento, 1)))?.includes('INTENTO_NO_VIGENTE'));
  check('El segundo, con su intento, sí autoriza', (await autorizar(db, t2.intento, 1, '74123456789099')).estado === 'autorizado');
  check('Una orden sin reserva no se puede tomar', (await tomar(db, await ordenId(ctx))).tomado === false);
}

// ── 4c · Pruebas (homologación) y producción no se mezclan ──
{
  const ctx = await nueva(); const { db } = ctx;
  const a = await ordenId(ctx);
  const h = await reservar(db, a, { amb: 'homologacion', ultimo: 5 });
  await autorizar(db, h.intento, 6);
  check('Una factura de prueba autorizada NO figura como emitida en producción', (await estado(db, a, 'produccion')).estado === 'ninguno');
  const p = await reservar(db, a, { amb: 'produccion', ultimo: 50 });
  check('La misma orden se puede facturar de verdad aunque ya tenga una de prueba (numeración propia)', p.numero === 51, JSON.stringify(p));
  check('Cada ambiente tiene su propia fila', (await db.query(`SELECT count(*)::int n FROM public.meli_comprobantes WHERE orden_id=$1`, [a])).rows[0].n === 2);
  check('Conciliar en un ambiente no toca el otro', (await tomar(db, a, 'produccion')).en_curso === true && (await estado(db, a, 'homologacion')).estado === 'autorizado');
}

// ── 5 · Producción: coordinación con el control de facturas (script 16) ──
{
  const ctx = await nueva(); const { db } = ctx;
  const a = await ordenId(ctx);
  const ra = await reservar(db, a, { amb: 'produccion', ultimo: 99 });
  const pend = (await db.query(`SELECT estado, version FROM public.meli_facturas WHERE orden_id=$1`, [a])).rows[0];
  check('Al reservar en producción la fila del control queda tomada (pendiente) para que nadie la marque a mano', pend && pend.estado === 'pendiente');
  await autorizar(db, ra.intento, 100);
  const f = (await db.query(`SELECT estado, tipo, pto_venta, numero FROM public.meli_facturas WHERE orden_id=$1`, [a])).rows[0];
  check('Autorizada en producción: la orden queda "emitida" en el control (C, punto de venta y número)', f && f.estado === 'emitida' && f.tipo === 'C' && f.pto_venta === 1 && f.numero === 100, JSON.stringify(f));

  const b = await ordenId(ctx);
  await db.query(`INSERT INTO public.meli_facturas (orden_id, estado, tipo, pto_venta, numero, emitida_el, marcada_por) VALUES ($1,'emitida','C',3,40,'2026-10-01','Franco')`, [b]);
  check('Si la orden ya tiene una factura cargada a mano, NO se emite otra (FACTURA_MANUAL_YA_REGISTRADA)', (await falla(() => reservar(db, b, { amb: 'produccion', ultimo: 100 })))?.includes('FACTURA_MANUAL_YA_REGISTRADA'));
  check('…y no se reservó ningún número', (await db.query(`SELECT count(*)::int n FROM public.meli_comprobantes WHERE orden_id=$1`, [b])).rows[0].n === 0);
  const c = await ordenId(ctx);
  await db.query(`INSERT INTO public.meli_facturas (orden_id, estado, motivo, marcada_por) VALUES ($1,'no_corresponde','no_es_venta_real','x')`, [c]);
  check('Si el control la marcó "no corresponde", NO se emite (ORDEN_MARCADA_NO_CORRESPONDE)', (await falla(() => reservar(db, c, { amb: 'produccion', ultimo: 100 })))?.includes('ORDEN_MARCADA_NO_CORRESPONDE'));
  check('En homologación esas marcas no estorban', (await reservar(db, b, { amb: 'homologacion', ultimo: 0 })).estado === 'reservado');
}

// ── 6 · Secreto y permisos reales ──
{
  const ctx = await nueva(); const { db } = ctx;
  const a = await ordenId(ctx);
  check('Sin el secreto correcto no se puede reservar', (await falla(() => reservar(db, a, { secreto: 'secreto-equivocado-0123456789' })))?.includes('no autorizado'));
  const r = await reservar(db, a);
  check('Sin el secreto no se puede autorizar', (await falla(() => autorizar(db, r.intento, 1, '74123456789012', { secreto: 'x'.repeat(30) })))?.includes('no autorizado'));
  for (const rol of ['anon', 'authenticated']) {
    const e1 = await falla(() => comoRol(db, rol, 'franco@x.com', () => db.query(`INSERT INTO public.meli_comprobantes (orden_id, ambiente, cbte_tipo, pto_venta, numero, estado, importe_centavos, doc_tipo, doc_nro, cond_iva) VALUES ('X','homologacion',11,1,9,'reservado',1,99,'0',5)`)));
    check(`${rol} no puede escribir la tabla`, e1 && /permission denied/i.test(e1), e1);
    const e2 = await falla(() => comoRol(db, rol, 'franco@x.com', () => db.query(`SELECT * FROM public.arca_tickets`)));
    check(`${rol} no puede leer los tickets`, e2 && /permission denied/i.test(e2), e2);
  }
  const anon = await falla(() => comoRol(db, 'anon', null, () => db.query(`SELECT id FROM public.meli_comprobantes`)));
  check('anon no lee los comprobantes', anon && /permission denied/i.test(anon), anon);
  const aut = await comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`SELECT numero, estado, importe_centavos, cae FROM public.meli_comprobantes`));
  check('Un usuario autorizado del CRM lee el comprobante (sin documento)', aut.rows.length === 1 && aut.rows[0].numero === 1);
  const doc = await falla(() => comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`SELECT doc_nro FROM public.meli_comprobantes`)));
  check('…pero NO puede leer el documento del receptor (doc_nro)', doc && /permission denied/i.test(doc), doc);
  const tipo = await falla(() => comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`SELECT doc_tipo FROM public.meli_comprobantes`)));
  check('…ni el tipo de documento', tipo && /permission denied/i.test(tipo), tipo);
  const todo = await falla(() => comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`SELECT * FROM public.meli_comprobantes`)));
  check('…ni con select *', todo && /permission denied/i.test(todo), todo);
  const intento = await falla(() => comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`SELECT intento_id FROM public.meli_comprobantes`)));
  check('…ni el identificador de intento (es el candado)', intento && /permission denied/i.test(intento), intento);
  const baja = await comoRol(db, 'authenticated', 'baja@x.com', () => db.query(`SELECT count(*)::int n FROM public.meli_comprobantes`));
  check('Un usuario dado de baja no ve ninguno', baja.rows[0].n === 0);
  const sr = await falla(() => comoRol(db, 'service_role', null, () => db.query(`SELECT * FROM public.arca_tickets`)));
  check('service_role tampoco toca los tickets', sr && /permission denied/i.test(sr), sr);
  const rpc = await comoRol(db, 'anon', null, () => estado(db, a));
  check('anon puede LLAMAR las funciones con el secreto (como Mercado Libre)', rpc.estado === 'reservado');
}

// ── 7 · Ticket: candado y vigencia ──
{
  const ctx = await nueva(); const { db } = ctx;
  const tomar = () => db.query(`SELECT public.arca_ticket_lease_tomar($1,'homologacion','20111111112') l`, [SECRETO]).then((x) => x.rows[0].l);
  const leer = () => db.query(`SELECT * FROM public.arca_ticket_leer($1,'homologacion','20111111112')`, [SECRETO]).then((x) => x.rows);
  const guardar = (lease, exp) => db.query(`SELECT public.arca_ticket_guardar($1,'homologacion','20111111112',$2,'T','S',$3) g`, [SECRETO, lease, exp]).then((x) => x.rows[0].g);
  check('Sin ticket guardado, leer no devuelve nada', (await leer()).length === 0);
  const l1 = await tomar();
  check('La primera instancia obtiene el candado', !!l1);
  check('La segunda NO lo obtiene mientras la primera lo tiene', (await tomar()) === null);
  check('Guardar con un candado ajeno no hace nada', (await guardar('00000000-0000-4000-8000-000000000000', new Date(Date.now() + 3600e3).toISOString())) === false);
  check('Ticket ya vencido se rechaza', (await falla(() => guardar(l1, new Date(Date.now() - 1000).toISOString())))?.includes('TICKET_INVALIDO'));
  check('Guardar con el candado propio funciona', (await guardar(l1, new Date(Date.now() + 11 * 3600e3).toISOString())) === true);
  const t = await leer();
  check('Se lee el ticket vigente', t.length === 1 && t[0].token === 'T' && t[0].sign === 'S');
  check('Con un ticket vigente nadie más obtiene el candado (ARCA no da otro)', (await tomar()) === null);
  await db.query(`UPDATE public.arca_tickets SET expira = now() - interval '1 minute'`);
  check('Vencido el ticket, ya no se lee', (await leer()).length === 0);
  const l2 = await tomar();
  check('Vencido el ticket, se puede pedir uno nuevo', !!l2);
  await db.query(`SELECT public.arca_ticket_lease_soltar($1,'homologacion','20111111112',$2)`, [SECRETO, l2]);
  check('Soltar el candado permite que otra instancia lo tome', !!(await tomar()));
  check('El candado vencido se puede retomar', (await (async () => { await db.query(`UPDATE public.arca_tickets SET lease_hasta = now() - interval '1 second'`); return tomar(); })()) !== null);
  check('CUIT inválido se rechaza', (await falla(() => db.query(`SELECT public.arca_ticket_lease_tomar($1,'homologacion','123')`, [SECRETO])))?.includes('DATOS_INVALIDOS'));
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
