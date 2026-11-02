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
  `SELECT public.arca_comprobante_reservar($1,$2,$3,$4,$5,$6,$7,$8) r`,
  [o.secreto ?? SECRETO, orden, o.amb ?? 'homologacion', o.pv ?? 1, o.ultimo ?? 0, o.importe ?? 10000000, o.dt ?? 99, o.dn ?? '0']).then((x) => x.rows[0].r);
const autorizar = (db, orden, cae = '74123456789012', o = {}) => db.query(
  `SELECT public.arca_comprobante_autorizar($1,$2,$3,$4,$5) r`, [o.secreto ?? SECRETO, orden, cae, '2026-11-12', '2026-11-02']).then((x) => x.rows[0].r);
const rechazar = (db, orden, e = 'ARCA rechazó') => db.query(`SELECT public.arca_comprobante_rechazar($1,$2,$3) r`, [SECRETO, orden, e]).then((x) => x.rows[0].r);
const fila = async (db, orden) => (await db.query(`SELECT * FROM public.meli_comprobantes WHERE orden_id=$1`, [orden])).rows[0];

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
  check('Reserva: último de ARCA 7 → número 8, estado reservado, nuevo', r1.numero === 8 && r1.estado === 'reservado' && r1.nuevo === true, JSON.stringify(r1));
  const r1b = await reservar(db, a, { ultimo: 7 });
  check('Reservar otra vez la MISMA orden devuelve la reserva existente (no consume otro número)', r1b.numero === 8 && r1b.nuevo === false, JSON.stringify(r1b));
  const e = await falla(() => reservar(db, b, { ultimo: 7 }));
  check('Con una reserva sin resolver, ninguna otra orden puede reservar (NUMERACION_PENDIENTE)', e && e.includes('NUMERACION_PENDIENTE'), e);
  await autorizar(db, a);
  const r2 = await reservar(db, b, { ultimo: 7 });
  check('Autorizada la primera, la siguiente recibe el 9 aunque ARCA aún diga 7', r2.numero === 9, JSON.stringify(r2));
  await autorizar(db, b, '74123456789013');
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
  check('Importe exacto en centavos (123456.78 → 12345678) reserva', r.estado === 'reservado' && r.importe_centavos === 12345678, JSON.stringify(r));
  const b = await ordenId(ctx);
  await rechazar(db, a); // libera el punto de venta
  check('Receptor inválido: consumidor final con documento ≠ 0', (await falla(() => reservar(db, b, { dt: 99, dn: '123' })))?.includes('RECEPTOR_INVALIDO'));
  check('Receptor inválido: tipo de documento desconocido', (await falla(() => reservar(db, b, { dt: 55, dn: '123' })))?.includes('RECEPTOR_INVALIDO'));
  check('Receptor inválido: documento con letras', (await falla(() => reservar(db, b, { dt: 96, dn: '12ab' })))?.includes('RECEPTOR_INVALIDO'));
  const ok96 = await reservar(db, b, { dt: 96, dn: '30111222' });
  check('DNI válido reserva', ok96.estado === 'reservado' && ok96.doc_nro === '30111222', JSON.stringify(ok96));
  check('Orden inexistente', (await falla(() => reservar(db, 'NO-EXISTE')))?.includes('ORDEN_INEXISTENTE'));
  await db.query(`UPDATE public.meli_ordenes SET moneda='USD' WHERE meli_order_id=$1`, [b]);
  await rechazar(db, b);
  check('Orden en otra moneda: MONEDA_NO_SOPORTADA', (await falla(() => reservar(db, b)))?.includes('MONEDA_NO_SOPORTADA'));
}

// ── 4 · Autorizar, rechazar y reintentar ──
{
  const ctx = await nueva(); const { db } = ctx;
  const a = await ordenId(ctx);
  await reservar(db, a, { ultimo: 3 });
  check('CAE inválido se rechaza', (await falla(() => autorizar(db, a, 'abc')))?.includes('CAE_INVALIDO'));
  const au = await autorizar(db, a);
  const f = await fila(db, a);
  check('Autorizar deja estado autorizado con CAE y fecha', au.estado === 'autorizado' && f.estado === 'autorizado' && f.cae === '74123456789012' && f.numero === 4, JSON.stringify(f));
  check('Autorizar de nuevo con el mismo CAE es idempotente', (await autorizar(db, a)).sin_cambios === true);
  check('Autorizar con OTRO CAE se rechaza', (await falla(() => autorizar(db, a, '74999999999999')))?.includes('OTRO_CAE'));
  check('Reservar una orden ya autorizada devuelve lo emitido (no emite otra)', (await reservar(db, a, { ultimo: 3 })).estado === 'autorizado');
  check('Una autorizada no se rechaza', (await falla(() => rechazar(db, a)))?.includes('COMPROBANTE_NO_RESERVADO'));
  check('Una autorizada no se modifica ni con SQL directo', (await falla(() => db.query(`UPDATE public.meli_comprobantes SET importe_centavos=1 WHERE orden_id=$1`, [a])))?.includes('INMODIFICABLE'));
  check('No se borra', (await falla(() => db.query(`DELETE FROM public.meli_comprobantes`)))?.includes('NO_SE_BORRA'));
  check('No se vacía', (await falla(() => db.query(`TRUNCATE public.meli_comprobantes`)))?.includes('NO_SE_BORRA'));
  check('En homologación NO se marca el control de facturas (no tiene valor fiscal)', (await db.query(`SELECT count(*)::int n FROM public.meli_facturas`)).rows[0].n === 0);

  const b = await ordenId(ctx);
  const rb = await reservar(db, b, { ultimo: 3 });
  const rej = await rechazar(db, b, 'ARCA dijo que no');
  const fb = await fila(db, b);
  check('Rechazar libera el número (queda NULL) y guarda el motivo', rej.estado === 'rechazado' && fb.numero === null && fb.ultimo_error === 'ARCA dijo que no', JSON.stringify(fb));
  const rb2 = await reservar(db, b, { ultimo: 3 });
  const fb2 = await fila(db, b);
  check('Reintentar tras un rechazo reserva de nuevo (mismo siguiente número) y cuenta el intento', rb2.estado === 'reservado' && rb2.numero === rb.numero && fb2.intentos === 2, JSON.stringify(fb2));
  const c = await ordenId(ctx);
  await rechazar(db, b);
  const rc = await reservar(db, c, { ultimo: 3 });
  check('El número liberado lo puede tomar otra orden (sin chocar con el índice único)', rc.numero === 5, JSON.stringify(rc));
  const d = await ordenId(ctx);
  const dup = await falla(() => db.query(
    `INSERT INTO public.meli_comprobantes (orden_id, ambiente, cbte_tipo, pto_venta, numero, estado, importe_centavos, doc_tipo, doc_nro)
     VALUES ($1,'homologacion',11,1,5,'reservado',100,99,'0')`, [d]));
  check('Número duplicado imposible a nivel tabla (índice único)', dup && /meli_comprobantes_numero_unico|duplicate/i.test(dup), dup);
}

// ── 5 · Producción: el control de facturas (script 16) queda "emitida" ──
{
  const ctx = await nueva(); const { db } = ctx;
  const a = await ordenId(ctx);
  await reservar(db, a, { amb: 'produccion', ultimo: 99 });
  await autorizar(db, a);
  const f = (await db.query(`SELECT estado, tipo, pto_venta, numero FROM public.meli_facturas WHERE orden_id=$1`, [a])).rows[0];
  check('En producción la orden queda "emitida" en el control (C, punto de venta y número)', f && f.estado === 'emitida' && f.tipo === 'C' && f.pto_venta === 1 && f.numero === 100, JSON.stringify(f));
  const b = await ordenId(ctx);
  await db.query(`INSERT INTO public.meli_facturas (orden_id, estado, motivo, marcada_por) VALUES ($1,'no_corresponde','no_es_venta_real','x')`, [b]);
  await reservar(db, b, { amb: 'produccion', ultimo: 100 });
  await autorizar(db, b, '74123456789020');
  const fb = (await db.query(`SELECT estado, numero, version FROM public.meli_facturas WHERE orden_id=$1`, [b])).rows[0];
  check('Si el control la tenía como "no corresponde", pasa a emitida con versión nueva', fb.estado === 'emitida' && fb.numero === 101 && Number(fb.version) === 2, JSON.stringify(fb));
}

// ── 6 · Secreto y permisos reales ──
{
  const ctx = await nueva(); const { db } = ctx;
  const a = await ordenId(ctx);
  check('Sin el secreto correcto no se puede reservar', (await falla(() => reservar(db, a, { secreto: 'secreto-equivocado-0123456789' })))?.includes('no autorizado'));
  check('Sin el secreto no se puede autorizar', (await falla(() => autorizar(db, a, '74123456789012', { secreto: 'x'.repeat(30) })))?.includes('no autorizado'));
  await reservar(db, a);
  for (const rol of ['anon', 'authenticated']) {
    const e1 = await falla(() => comoRol(db, rol, 'franco@x.com', () => db.query(`INSERT INTO public.meli_comprobantes (orden_id, ambiente, cbte_tipo, pto_venta, numero, estado, importe_centavos, doc_tipo, doc_nro) VALUES ('X','homologacion',11,1,9,'reservado',1,99,'0')`)));
    check(`${rol} no puede escribir la tabla`, e1 && /permission denied/i.test(e1), e1);
    const e2 = await falla(() => comoRol(db, rol, 'franco@x.com', () => db.query(`SELECT * FROM public.arca_tickets`)));
    check(`${rol} no puede leer los tickets`, e2 && /permission denied/i.test(e2), e2);
  }
  const anon = await falla(() => comoRol(db, 'anon', null, () => db.query(`SELECT * FROM public.meli_comprobantes`)));
  check('anon no lee los comprobantes', anon && /permission denied/i.test(anon), anon);
  const aut = await comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`SELECT count(*)::int n FROM public.meli_comprobantes`));
  check('Un usuario autorizado del CRM sí los lee', aut.rows[0].n === 1);
  const baja = await comoRol(db, 'authenticated', 'baja@x.com', () => db.query(`SELECT count(*)::int n FROM public.meli_comprobantes`));
  check('Un usuario dado de baja no ve ninguno', baja.rows[0].n === 0);
  const sr = await falla(() => comoRol(db, 'service_role', null, () => db.query(`SELECT * FROM public.arca_tickets`)));
  check('service_role tampoco toca los tickets', sr && /permission denied/i.test(sr), sr);
  const rpc = await comoRol(db, 'anon', null, () => reservar(db, a));
  check('anon puede LLAMAR la función con el secreto (como Mercado Libre) y recibe lo ya reservado', rpc.estado === 'reservado');
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
