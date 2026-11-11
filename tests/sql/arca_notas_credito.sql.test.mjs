// Banco de pruebas de db/pendientes/arca_notas_credito.sql (script 22) contra un Postgres REAL (pglite).
//   cd tests/sql && node arca_notas_credito.sql.test.mjs
// LÍMITE: pglite tiene UNA conexión; las carreras entre conexiones se cubren por el orden común de bloqueos y los candados de intento.
import { baseNueva, SQL, SECRETO, nuevaOrden, comoRol } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };
const PREPARAR = `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;
  GRANT USAGE ON SCHEMA public TO service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;`;
const SCRIPT = SQL('arca_notas_credito.sql');
async function nueva() {
  const c = await baseNueva({ conVentas: false, sin7: true });
  await c.db.exec(PREPARAR); await c.db.exec(SQL('meli_facturas.sql')); await c.db.exec(SQL('arca_comprobantes.sql'));
  await c.db.exec(SQL('arca_control_anual.sql')); await c.db.exec(SCRIPT); await c.db.exec(SQL('arca_nc_otro_pv.sql'));
  return c;
}
const q = (db, sql, args = []) => db.query(sql, args).then((x) => x.rows);
const ordenId = async (ctx, bruto = 100000) => {
  const id = await nuevaOrden(ctx, [{ item: 'MLA1', precio: bruto }], { bruto, neto: bruto - 1000 });
  return (await q(ctx.db, `SELECT meli_order_id m FROM public.meli_ordenes WHERE id=$1`, [id]))[0].m;
};
// Una factura AUTORIZADA para la orden (usa las funciones del script 20).
async function facturada(ctx, { amb = 'homologacion', pv = 1, ultimo = 0, bruto = 100000, dt = 96, dn = '43577502' } = {}) {
  const o = await ordenId(ctx, bruto);
  const r = (await q(ctx.db, `SELECT public.arca_comprobante_reservar($1,$2,$3,$4,$5,$6,$7,$8,$9) r`, [SECRETO, o, amb, pv, ultimo, Math.round(bruto * 100), dt, dn, 5]))[0].r;
  await q(ctx.db, `SELECT public.arca_comprobante_autorizar($1,$2,$3,$4,$5,$6)`, [SECRETO, r.intento, r.numero, '74123456789012', '2026-11-12', '2026-11-02']);
  return o;
}
const reservar = (db, o, a = {}) => q(db, `SELECT public.arca_nc_reservar($1,$2,$3,$4,$5,$6,$7) r`, [a.secreto ?? SECRETO, o, a.amb ?? 'homologacion', a.pv ?? 1, a.ultimo ?? 0, a.motivo ?? 'devolucion', a.usuario ?? 'franco@x.com']).then((x) => x[0].r);
const autorizar = (db, i, n, cae = '75123456789012') => q(db, `SELECT public.arca_nc_autorizar($1,$2,$3,$4,$5,$6) r`, [SECRETO, i, n, cae, '2026-11-12', '2026-11-02']).then((x) => x[0].r);
const rechazar = (db, i, n, e = 'no') => q(db, `SELECT public.arca_nc_rechazar($1,$2,$3,$4) r`, [SECRETO, i, n, e]).then((x) => x[0].r);
const estado = (db, o, amb = 'homologacion') => q(db, `SELECT public.arca_nc_estado($1,$2,$3) r`, [SECRETO, o, amb]).then((x) => x[0].r);
const tomar = (db, o, amb = 'homologacion') => q(db, `SELECT public.arca_nc_conciliar_tomar($1,$2,$3) r`, [SECRETO, o, amb]).then((x) => x[0].r);
const vencer = (db) => db.query(`UPDATE public.meli_notas_credito SET trabajo_hasta = now() - interval '11 minutes' WHERE trabajo_hasta IS NOT NULL`);

console.log('\n══ Notas de crédito C (Postgres en WebAssembly) ══\n');
{
  const ctx = await nueva(); const { db } = ctx;
  check('El script corre dos veces más sin romper (idempotente)', !(await falla(() => db.exec(SCRIPT))) && !(await falla(() => db.exec(SCRIPT))));
  const vacia = await baseNueva({ conVentas: false, sin7: true });
  check('Sin los scripts 20 y 21 frena con un mensaje claro', (await falla(() => vacia.db.exec(SCRIPT)))?.includes('Faltan los scripts 20'));
  const res = await db.exec(SCRIPT); const t = res[res.length - 1].rows;
  check('La verificación sale toda en ✅', t.length === 2 && t.every((x) => x.resultado === '✅'), JSON.stringify(t));
}
{
  const ctx = await nueva(); const { db } = ctx;
  const sin = await ordenId(ctx);
  check('Sin factura → FACTURA_NO_AUTORIZADA', (await falla(() => reservar(db, sin)))?.includes('FACTURA_NO_AUTORIZADA'));
  check('El estado de una orden sin factura es sin_factura', (await estado(db, sin)).estado === 'sin_factura');
  const o = await facturada(ctx, { ultimo: 5 });
  check('Estado: hay factura y todavía no hay nota', (await estado(db, o)).estado === 'ninguna');
  check('Motivo fuera de la lista', (await falla(() => reservar(db, o, { motivo: 'x' })))?.includes('MOTIVO_INVALIDO'));
  check('Usuario vacío', (await falla(() => reservar(db, o, { usuario: ' ' })))?.includes('USUARIO_INVALIDO'));
  check('Punto de venta inválido de la nota: se rechaza y NO se escribe nada', (await falla(() => reservar(db, o, { pv: 0, ultimo: 0 })))?.includes('PUNTO_DE_VENTA_INVALIDO') && (await q(db, `SELECT count(*)::int n FROM public.meli_notas_credito`))[0].n === 0);
  const r = await reservar(db, o, { ultimo: 2 });
  check('Reserva con numeración PROPIA (último 2 → 3), mismo importe, receptor y punto de venta de la factura, con la factura asociada',
    r.numero === 3 && Number(r.importe_centavos) === 10000000 && r.doc_tipo === 96 && r.doc_nro === '43577502' && r.pto_venta === 1 && r.factura_numero === 6 && r.factura_fecha === '2026-11-02', JSON.stringify(r));
  check('Reservar otra vez la misma → NOTA_CREDITO_YA_EXISTE', (await falla(() => reservar(db, o, { ultimo: 2 })))?.includes('NOTA_CREDITO_YA_EXISTE'));
  const o2 = await facturada(ctx, { ultimo: 6 });
  check('Con una nota sin resolver en el punto de venta, otra no puede reservar (NUMERACION_PENDIENTE)', (await falla(() => reservar(db, o2, { ultimo: 2 })))?.includes('NUMERACION_PENDIENTE'));
  check('Autorizar con número distinto al reservado', (await falla(() => autorizar(db, r.intento, 9)))?.includes('NUMERO_DISTINTO_AL_RESERVADO'));
  check('Autorizar con CAE inválido', (await falla(() => q(db, `SELECT public.arca_nc_autorizar($1,$2,$3,'abc','2026-11-12','2026-11-02')`, [SECRETO, r.intento, 3])))?.includes('CAE_INVALIDO'));
  check('Autorizar con intento desconocido', (await falla(() => autorizar(db, '00000000-0000-4000-8000-000000000000', 3)))?.includes('INTENTO_NO_VIGENTE'));
  const au = await autorizar(db, r.intento, 3);
  check('Autorizar deja la nota autorizada y libera el candado', au.estado === 'autorizado' && (await q(db, `SELECT estado, cae, trabajo_hasta FROM public.meli_notas_credito WHERE orden_id=$1`, [o]))[0].trabajo_hasta === null);
  check('Autorizar de nuevo con el mismo CAE es idempotente; con otro, no', (await autorizar(db, r.intento, 3)).sin_cambios === true && (await falla(() => autorizar(db, r.intento, 3, '75999999999999')))?.includes('OTRO_CAE'));
  const e = await estado(db, o);
  check('Estado: autorizada con su número y CAE', e.estado === 'autorizado' && e.numero === 3 && e.cae === '75123456789012');
  check('Una autorizada no se rechaza', (await falla(() => rechazar(db, r.intento, 3)))?.includes('NOTA_NO_RESERVADA'));
  check('Ni se modifica, borra o vacía', /INMODIFICABLE/.test(String(await falla(() => db.query(`UPDATE public.meli_notas_credito SET importe_centavos=1`)))) && /NO_SE_BORRA/.test(String(await falla(() => db.query(`DELETE FROM public.meli_notas_credito`)))) && /NO_SE_BORRA/.test(String(await falla(() => db.query(`TRUNCATE public.meli_notas_credito`)))));
  check('Tampoco otra nota para la misma factura (una por factura)', (await falla(() => reservar(db, o, { ultimo: 3 })))?.includes('NOTA_CREDITO_YA_EXISTE'));
  const o3 = await facturada(ctx, { ultimo: 7 });
  const r3 = await reservar(db, o3, { ultimo: 3 });
  check('La siguiente nota recibe el 4', r3.numero === 4, JSON.stringify(r3));
}
{ // intentos, ventana y reintento
  const ctx = await nueva(); const { db } = ctx;
  const o = await facturada(ctx);
  const r = await reservar(db, o, { usuario: 'franco@x.com' });
  check('Mientras el intento está vigente nadie más lo concilia (en_curso)', (await tomar(db, o)).en_curso === true);
  await db.query(`UPDATE public.meli_notas_credito SET trabajo_hasta = now() - interval '3 minutes'`);
  check('A los 3 minutos todavía NO (ventana de seguridad de 10)', (await tomar(db, o)).en_curso === true);
  await vencer(db);
  const t = await tomar(db, o);
  check('Pasados los 10 minutos se toma con intento NUEVO y los datos guardados', t.tomado === true && t.intento !== r.intento && t.numero === 1 && t.doc_nro === '43577502' && t.factura_numero === 1, JSON.stringify(t));
  check('El intento viejo ya no puede autorizar ni rechazar', (await falla(() => autorizar(db, r.intento, 1)))?.includes('INTENTO_NO_VIGENTE') && (await falla(() => rechazar(db, r.intento, 1)))?.includes('INTENTO_NO_VIGENTE'));
  const rej = await rechazar(db, t.intento, 1, 'ARCA dijo que no');
  const f = (await q(db, `SELECT estado, numero, ultimo_error, creado_por, ultimo_solicitante, intentos FROM public.meli_notas_credito`))[0];
  check('Rechazar libera el número y guarda el motivo', rej.estado === 'rechazado' && f.numero === null && f.ultimo_error === 'ARCA dijo que no', JSON.stringify(f));
  const r2 = await reservar(db, o, { usuario: 'otra@x.com', motivo: 'cancelacion' });
  const f2 = (await q(db, `SELECT creado_por, ultimo_solicitante, intentos, motivo FROM public.meli_notas_credito`))[0];
  check('Reintentar: intento nuevo, creado_por conserva al primero y ultimo_solicitante a quien reintentó', r2.numero === 1 && r2.intento !== t.intento && f2.creado_por === 'franco@x.com' && f2.ultimo_solicitante === 'otra@x.com' && f2.intentos === 2 && f2.motivo === 'cancelacion', JSON.stringify(f2));
}
{ // ambientes
  const ctx = await nueva(); const { db } = ctx;
  const o = await facturada(ctx, { amb: 'homologacion' });
  check('Una factura de PRUEBA no habilita una nota de PRODUCCIÓN', (await falla(() => reservar(db, o, { amb: 'produccion' })))?.includes('FACTURA_NO_AUTORIZADA'));
  check('El estado en producción es sin_factura', (await estado(db, o, 'produccion')).estado === 'sin_factura');
}
{ // secreto y permisos
  const ctx = await nueva(); const { db } = ctx;
  const o = await facturada(ctx);
  check('Sin el secreto correcto no se reserva', (await falla(() => reservar(db, o, { secreto: 'secreto-equivocado-0123456789' })))?.includes('no autorizado'));
  const r = await reservar(db, o);
  check('Sin el secreto no se autoriza', (await falla(() => q(db, `SELECT public.arca_nc_autorizar($1,$2,$3,$4,$5,$6)`, ['x'.repeat(30), r.intento, 1, '75123456789012', '2026-11-12', '2026-11-02'])))?.includes('no autorizado'));
  for (const rol of ['anon', 'authenticated']) {
    const w = await falla(() => comoRol(db, rol, 'franco@x.com', () => db.query(`INSERT INTO public.meli_notas_credito (comprobante_id, orden_id, ambiente, pto_venta, numero, estado, importe_centavos, doc_tipo, doc_nro, cond_iva, motivo, creado_por) VALUES (1,'X','homologacion',1,9,'reservado',1,99,'0',5,'devolucion','x')`)));
    check(`${rol} no puede escribir la tabla`, w && /permission denied/i.test(w), w);
  }
  check('anon no lee las notas', /permission denied/i.test(String(await falla(() => comoRol(db, 'anon', null, () => db.query(`SELECT id FROM public.meli_notas_credito`))))));
  const lee = await comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`SELECT numero, estado, importe_centavos, motivo, creado_por, cae FROM public.meli_notas_credito`));
  check('Un usuario autorizado lee la nota (sin documento)', lee.rows.length === 1 && lee.rows[0].estado === 'reservado');
  for (const col of ['doc_nro', 'doc_tipo', 'intento_id', 'cond_iva']) {
    const d = await falla(() => comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`SELECT ${col} FROM public.meli_notas_credito`)));
    check(`…pero NO puede leer ${col}`, d && /permission denied/i.test(d), d);
  }
  check('…ni con select *', /permission denied/i.test(String(await falla(() => comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`SELECT * FROM public.meli_notas_credito`))))));
  const baja = await comoRol(db, 'authenticated', 'baja@x.com', () => db.query(`SELECT count(*)::int n FROM public.meli_notas_credito`));
  check('Uno dado de baja no ve ninguna', baja.rows[0].n === 0);
  check('service_role tampoco toca la tabla', /permission denied/i.test(String(await falla(() => comoRol(db, 'service_role', null, () => db.query(`SELECT * FROM public.meli_notas_credito`))))));
}
{
  const ctx2 = await nueva(); const db = ctx2.db; // factura de OTRO punto de venta (script 28): la nota sale en el punto configurado, con su numeración, asociada a la factura
    const o4 = await facturada(ctx2, { pv: 4, ultimo: 9, bruto: 50000 });
    const r4 = await reservar(db, o4, { pv: 2, ultimo: 7 });
    const e4 = await estado(db, o4);
    check('Factura del pto 4, nota en el pto 2: numeración del pto 2 (7→8), asociada a la factura del pto 4', r4.numero === 8 && r4.pto_venta === 2 && r4.factura_pto_venta === 4 && r4.factura_numero === 10 && e4.pto_venta === 2 && e4.factura_pto_venta === 4, JSON.stringify([r4, e4]));
    // Codex: una nota RECHAZADA en el pto 2 se reintenta en el pto 3 → la fila pasa al pto 3 (numeración del 3) y no queda en el 2
    const i4 = r4.intento;
    await q(db, `SELECT public.arca_nc_rechazar($1,$2,$3,'prueba')`, [SECRETO, i4, 8]);
    const r5 = await reservar(db, o4, { pv: 3, ultimo: 20 });
    const fila5 = (await q(db, `SELECT pto_venta, numero, estado FROM public.meli_notas_credito WHERE orden_id=$1`, [o4]))[0];
    check('Reintento tras rechazo en otro punto: la fila se mueve al pto 3 con número 21', r5.pto_venta === 3 && r5.numero === 21 && fila5.pto_venta === 3 && fila5.numero === 21 && fila5.estado === 'reservado', JSON.stringify([r5, fila5]));
    check('…y una reservada NO puede cambiar de punto de venta a mano', (await falla(() => q(db, `UPDATE public.meli_notas_credito SET pto_venta = 9 WHERE orden_id=$1`, [o4])))?.includes('DATOS_FIJOS'));
  
}
console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
