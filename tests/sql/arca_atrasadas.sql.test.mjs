// Banco de pruebas de db/pendientes/arca_atrasadas.sql (facturas atrasadas) contra Postgres real (pglite).
//   cd tests/sql && node arca_atrasadas.sql.test.mjs
import { baseNueva, SQL, SECRETO, nuevaOrden, comoRol } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };
const PREPARAR = `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;`;
const SCRIPT = SQL('arca_atrasadas.sql');
const q = (db, sql, args = []) => db.query(sql, args).then((x) => x.rows);

async function nueva() {
  const c = await baseNueva();
  await c.db.exec(PREPARAR);
  for (const f of ['meli_cerrar_manual.sql', 'meli_facturas.sql', 'arca_comprobantes.sql']) await c.db.exec(SQL(f));
  return c;
}
let n = 0;
// Crea una orden con la fecha de venta (hora de Argentina) y el estado indicados.
async function orden(ctx, { cuando, estado = 'paid', bruto = 100000, moneda = 'ARS', revisar = false } = {}) {
  const id = await nuevaOrden(ctx, [{ item: 'MLA1', precio: bruto }], { bruto, neto: bruto * 0.85 });
  const m = String(6000000000000 + (++n));
  await q(ctx.db, `UPDATE public.meli_ordenes SET meli_order_id=$2, estado=$3, fecha_orden=$4::timestamptz, moneda=$5, revisar=$6 WHERE id=$1`, [id, m, estado, cuando, moneda, revisar]);
  return m;
}
const comprobante = (ctx, ord, { amb = 'produccion', estado = 'autorizado', num = null, trabajo = null, actualizado = null } = {}) => q(ctx.db,
  `INSERT INTO public.meli_comprobantes (orden_id, ambiente, cbte_tipo, pto_venta, numero, estado, importe_centavos, doc_tipo, doc_nro, cond_iva, cae, cae_vto, fecha_cbte, trabajo_hasta, actualizado_en)
   VALUES ($1,$2,11,4,$3,$4,10000000,99,'0',5,$5,$6,$7,$8, COALESCE($9::timestamptz, now()))`,
  [ord, amb, estado === 'rechazado' ? null : (num ?? ++n), estado, estado === 'autorizado' ? '74123456789012' : null, estado === 'autorizado' ? '2026-12-01' : null, estado === 'autorizado' ? '2026-10-31' : null, trabajo, actualizado]);
const resumen = (ctx, d, h, amb = 'produccion') => q(ctx.db, `SELECT public.arca_atrasadas_resumen($1::date,$2::date,$3) r`, [d, h, amb]).then((x) => x[0].r);
const siguientes = (ctx, d, h, lim = 10, amb = 'produccion', sec = SECRETO) => q(ctx.db, `SELECT public.arca_atrasadas_siguientes($1,$2,$3::date,$4::date,$5) r`, [sec, amb, d, h, lim]).then((x) => x[0].r);

console.log('\n══ Facturas atrasadas (Postgres en WebAssembly) ══\n');
const ctx = await nueva();
const { db } = ctx;
{
  const vacia = await baseNueva();
  check('Sin los scripts 16 y 20 frena con un mensaje claro', (await falla(() => vacia.db.exec(SCRIPT)))?.includes('Faltan los scripts'));
  const e = await falla(() => db.exec(SCRIPT)), e2 = await falla(() => db.exec(SCRIPT));
  check('El script corre dos veces sin romper (idempotente)', !e && !e2, `${e} | ${e2}`);
  const res = await db.exec(SCRIPT); const t = res[res.length - 1].rows;
  check('La verificación sale toda en ✅', t.length === 2 && t.every((x) => x.resultado === '✅'), JSON.stringify(t));
}

// Ventas de prueba (la fecha es la de la VENTA, hora de Argentina = UTC-3)
const A = await orden(ctx, { cuando: '2026-10-10T12:00:00-03:00', bruto: 100000 });
const B = await orden(ctx, { cuando: '2026-10-31T23:30:00-03:00', bruto: 250000 });        // último minuto de octubre
const C = await orden(ctx, { cuando: '2026-11-01T00:30:00-03:00', bruto: 90000 });         // ya es noviembre
const D = await orden(ctx, { cuando: '2026-10-05T12:00:00-03:00', estado: 'cancelled' });
const E = await orden(ctx, { cuando: '2026-10-08T12:00:00-03:00', revisar: true });
const F = await orden(ctx, { cuando: '2026-10-09T12:00:00-03:00' }); await comprobante(ctx, F);
const G = await orden(ctx, { cuando: '2026-10-12T12:00:00-03:00' }); await comprobante(ctx, G, { estado: 'reservado', trabajo: new Date(Date.now() + 120000).toISOString() });
const H = await orden(ctx, { cuando: '2026-10-14T12:00:00-03:00' }); await q(db, `INSERT INTO public.meli_facturas (orden_id, estado, tipo, pto_venta, numero, emitida_el, marcada_por, marcada_uid) VALUES ($1,'emitida','C',1,5,'2026-10-14','x','u')`, [H]);
const I = await orden(ctx, { cuando: '2026-10-15T12:00:00-03:00' }); await q(db, `INSERT INTO public.meli_facturas (orden_id, estado, motivo, marcada_por, marcada_uid) VALUES ($1,'no_corresponde','no_es_venta_real','x','u')`, [I]);
const J = await orden(ctx, { cuando: '2026-10-16T12:00:00-03:00' }); await q(db, `UPDATE public.meli_ordenes SET cerrada_manual_en=now(), cerrada_manual_motivo='descartada' WHERE meli_order_id=$1`, [J]);
const K = await orden(ctx, { cuando: '2026-10-17T12:00:00-03:00' }); await q(db, `UPDATE public.meli_ordenes SET revertida_en=now() WHERE meli_order_id=$1`, [K]);
const L = await orden(ctx, { cuando: '2026-10-18T12:00:00-03:00', moneda: 'USD' });

{
  const r = await resumen(ctx, '2026-10-01', '2026-10-31');
  check('Producción, octubre: cuenta solo A y B (pagadas, sin factura, en el rango)', r.cantidad === 2, JSON.stringify(r));
  check('Suma el importe en centavos (A 100.000 + B 250.000)', Number(r.total_centavos) === 35000000, JSON.stringify(r));
  check('Lo vendido a las 23:30 del 31/10 (hora argentina) cuenta como octubre; a las 00:30 del 1/11 no', r.por_mes.length === 1 && r.por_mes[0].mes === '2026-10', JSON.stringify(r.por_mes));
  const rn = await resumen(ctx, '2026-11-01', '2026-11-30');
  check('Noviembre: solo la venta del 1/11 a las 00:30', rn.cantidad === 1 && Number(rn.total_centavos) === 9000000, JSON.stringify(rn));
  const rt = await resumen(ctx, '2026-10-01', '2026-11-30');
  check('Rango de dos meses: reparte por mes', rt.por_mes.map((m) => m.mes).join() === '2026-10,2026-11', JSON.stringify(rt.por_mes));
  const rh = await resumen(ctx, '2026-10-01', '2026-10-31', 'homologacion');
  // En pruebas el control de facturas (H emitida, I «no corresponde») no excluye, y la factura autorizada de producción (F) ni la reservada (G) tampoco: A, B, F, G, H, I.
  check('En pruebas (homologación) cuenta también F, G, H e I: las facturas de producción y del control no la excluyen', rh.cantidad === 6, JSON.stringify(rh));
  check('Cancelada, en revisión, revertida, cerrada a mano y en dólares no entran en ningún ambiente', ![D, E, J, K, L].length || (rh.cantidad === 6 && r.cantidad === 2));
}
{
  const s = await siguientes(ctx, '2026-10-01', '2026-10-31');
  check('Siguientes: de la más vieja a la más nueva (A antes que B)', s.ordenes[0] === A && s.ordenes[1] === B, JSON.stringify(s));
  const un = await siguientes(ctx, '2026-10-01', '2026-10-31', 1);
  check('Respeta el límite y cuenta cuántas faltan', un.ordenes.length === 1 && un.restantes === s.restantes, JSON.stringify(un));
  check('La reservada por otro proceso hace poco (G) no se vuelve a ofrecer', !s.ordenes.includes(G));
  check('...pero se cuenta como BLOQUEADA (no desaparece del conteo)', s.bloqueadas === 1, JSON.stringify(s));
  await q(db, `UPDATE public.meli_comprobantes SET trabajo_hasta = now() - interval '20 minutes' WHERE orden_id=$1`, [G]);
  const s2 = await siguientes(ctx, '2026-10-01', '2026-10-31');
  check('Una reserva abandonada (más de 8 minutos) vuelve a ofrecerse para resolverla', s2.ordenes.includes(G), JSON.stringify(s2));
  const Rr = await orden(ctx, { cuando: '2026-10-20T12:00:00-03:00' }); await comprobante(ctx, Rr, { estado: 'rechazado' });
  check('Una rechazada hace menos de 30 minutos no se ofrece (no se insiste en bucle)', !(await siguientes(ctx, '2026-10-01', '2026-10-31')).ordenes.includes(Rr));
  const sb = await siguientes(ctx, '2026-10-01', '2026-10-31');
  check('La rechazada reciente suma a las bloqueadas (G ya está liberada): 1', sb.bloqueadas === 1, JSON.stringify(sb));
  const Rv = await orden(ctx, { cuando: '2026-10-21T12:00:00-03:00' }); await comprobante(ctx, Rv, { estado: 'rechazado', actualizado: new Date(Date.now() - 2 * 3600e3).toISOString() });
  check('Una rechazada hace más de media hora se reintenta', (await siguientes(ctx, '2026-10-01', '2026-10-31')).ordenes.includes(Rv));
  await comprobante(ctx, A);
  check('Una vez autorizada la factura de A, deja de aparecer', !(await siguientes(ctx, '2026-10-01', '2026-10-31')).ordenes.includes(A));
  check('Una factura de producción no cuenta en pruebas: A sigue disponible en homologación', (await siguientes(ctx, '2026-10-01', '2026-10-31', 10, 'homologacion')).ordenes.includes(A));
}
{ // arca_atrasada_reservar: revalida la elegibilidad bajo bloqueo y después reserva con la misma función del botón
  const reservar = (ord, d = '2026-10-01', h = '2026-10-31', sec = SECRETO, importe = 10000000, pto = 4, ult = 0) => q(db,
    `SELECT public.arca_atrasada_reservar($1,$2,'homologacion',$3,$4,$5,99,'0',5,$6::date,$7::date) r`, [sec, ord, pto, ult, importe, d, h]).then((x) => x[0].r);
  const ok1 = await orden(ctx, { cuando: '2026-10-22T12:00:00-03:00', bruto: 100000 });
  const r = await reservar(ok1);
  check('Reserva una venta elegible (mismo resultado que el botón: número y intento)', Number(r.numero) === 1 && !!r.intento, JSON.stringify(r));
  check('La reserva queda guardada en el punto de venta pedido', (await q(db, `SELECT pto_venta, estado FROM public.meli_comprobantes WHERE orden_id=$1 AND ambiente='homologacion'`, [ok1]))[0].pto_venta === 4);
  const casos = [
    ['en revisión', `UPDATE public.meli_ordenes SET revisar=true WHERE meli_order_id=$1`], ['revertida', `UPDATE public.meli_ordenes SET revertida_en=now() WHERE meli_order_id=$1`],
    ['cerrada a mano', `UPDATE public.meli_ordenes SET cerrada_manual_en=now(), cerrada_manual_motivo='descartada' WHERE meli_order_id=$1`], ['cancelada', `UPDATE public.meli_ordenes SET estado='cancelled' WHERE meli_order_id=$1`],
    ['fuera del rango', `UPDATE public.meli_ordenes SET fecha_orden='2026-11-15T12:00:00-03:00' WHERE meli_order_id=$1`]];
  for (const [mot, sql] of casos) {
    const x = await orden(ctx, { cuando: '2026-10-23T12:00:00-03:00' }); await q(db, sql, [x]);
    const e = await falla(() => reservar(x));
    check(`No reserva una venta ${mot}`, /ATRASADA_NO_ELEGIBLE|ORDEN_NO_FACTURABLE/.test(e || '') && (await q(db, `SELECT 1 FROM public.meli_comprobantes WHERE orden_id=$1`, [x])).length === 0, String(e));
  }
  check('Una orden inexistente no se reserva', /ATRASADA_NO_ELEGIBLE/.test((await falla(() => reservar('9999999999')) || '')));
  check('Rango inválido', /RANGO_INVALIDO/.test((await falla(() => reservar(ok1, '2026-10-31', '2026-10-01')) || '')));
  check('Con una clave equivocada no responde', /no autorizado/.test((await falla(() => reservar(ok1, '2026-10-01', '2026-10-31', 'mala')) || '')));
  check('El importe tiene que coincidir con la orden (lo valida la reserva del botón)', /IMPORTE_NO_COINCIDE/.test((await falla(async () => reservar(await orden(ctx, { cuando: '2026-10-24T12:00:00-03:00', bruto: 5000 }), '2026-10-01', '2026-10-31', SECRETO, 1)) || '')));
  const viaAnon = await comoRol(db, 'anon', null, () => falla(() => reservar('9999999999')));
  check('El servidor (anon + clave) puede llamarla; un usuario sin clave no', /ATRASADA_NO_ELEGIBLE/.test(viaAnon || '') && /no autorizado/.test((await comoRol(db, 'authenticated', 'franco@x.com', () => falla(() => reservar(ok1, '2026-10-01', '2026-10-31', 'otra')))) || ''));
  check('service_role no la ejecuta', /permission denied/i.test(String(await falla(() => comoRol(db, 'service_role', null, () => reservar(ok1))))));
}
{
  for (const [d, h, cod] of [['2026-10-31', '2026-10-01', 'RANGO_INVALIDO'], ['2020-01-01', '2026-12-31', 'RANGO_INVALIDO'], [null, '2026-10-31', 'RANGO_INVALIDO']]) {
    check(`Rango inválido (${d}, ${h}) → ${cod}`, (await falla(() => resumen(ctx, d, h)))?.includes(cod) && (await falla(() => siguientes(ctx, d, h)))?.includes(cod));
  }
  check('Ambiente inválido', (await falla(() => resumen(ctx, '2026-10-01', '2026-10-31', 'otro')))?.includes('AMBIENTE_INVALIDO') && (await falla(() => siguientes(ctx, '2026-10-01', '2026-10-31', 10, 'otro')))?.includes('AMBIENTE_INVALIDO'));
  for (const l of [0, 11, null]) check(`Límite inválido (${l})`, (await falla(() => siguientes(ctx, '2026-10-01', '2026-10-31', l)))?.includes('LIMITE_INVALIDO'));
  check('Con una clave equivocada no responde', /no autorizado/.test(String(await falla(() => siguientes(ctx, '2026-10-01', '2026-10-31', 5, 'produccion', 'clave-mala')))));
}
{
  const aut = await comoRol(db, 'authenticated', 'franco@x.com', () => resumen(ctx, '2026-10-01', '2026-10-31'));
  check('Un usuario autorizado ve el resumen', typeof aut.cantidad === 'number');
  check('Uno dado de baja NO lo ve', /no autorizado/.test(String(await falla(() => comoRol(db, 'authenticated', 'baja@x.com', () => resumen(ctx, '2026-10-01', '2026-10-31'))))));
  check('anon no ve el resumen', /permission denied/i.test(String(await falla(() => comoRol(db, 'anon', null, () => resumen(ctx, '2026-10-01', '2026-10-31'))))));
  const viaAnon = await comoRol(db, 'anon', null, () => siguientes(ctx, '2026-10-01', '2026-10-31', 2));
  check('El servidor (anon + clave compartida) sí puede pedir las siguientes', Array.isArray(viaAnon.ordenes));
  check('service_role no toca ninguna de las dos', /permission denied/i.test(String(await falla(() => comoRol(db, 'service_role', null, () => resumen(ctx, '2026-10-01', '2026-10-31'))))));
  check('El resumen no cambia ningún dato (la función es de solo lectura)', (await q(db, `SELECT provolatile FROM pg_proc WHERE proname='arca_atrasadas_resumen'`))[0].provolatile === 's');
}
console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
