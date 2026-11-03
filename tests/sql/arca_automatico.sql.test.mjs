// Banco de pruebas de db/pendientes/arca_automatico.sql (script 23) contra un Postgres REAL (pglite).
//   cd tests/sql && node arca_automatico.sql.test.mjs
import { baseNueva, SQL, SECRETO, nuevaOrden, comoRol } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };
const PREPARAR = `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;
  GRANT USAGE ON SCHEMA public TO service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;`;
const SCRIPT = SQL('arca_automatico.sql');
async function nueva() {
  const c = await baseNueva({ conVentas: false, sin7: true });
  await c.db.exec(PREPARAR);
  for (const f of ['meli_facturas.sql', 'arca_comprobantes.sql', 'arca_control_anual.sql', 'arca_notas_credito.sql']) await c.db.exec(SQL(f));
  await c.db.exec(SCRIPT);
  return c;
}
const q = (db, sql, args = []) => db.query(sql, args).then((x) => x.rows);
const ordenId = async (ctx, estado = 'paid') => {
  const id = await nuevaOrden(ctx, [{ item: 'MLA1', precio: 100000 }]);
  await q(ctx.db, `UPDATE public.meli_ordenes SET estado=$2, meli_order_id=(4000000000000+id)::text WHERE id=$1`, [id, estado]);
  return (await q(ctx.db, `SELECT meli_order_id m FROM public.meli_ordenes WHERE id=$1`, [id]))[0].m;
};
const cand = (db, amb = 'homologacion', lim = 10) => q(db, `SELECT public.arca_auto_candidatos($1,$2,$3) r`, [SECRETO, amb, lim]).then((x) => x[0].r);
const conf = (db, f, n) => q(db, `SELECT public.arca_auto_config_guardar($1,$2) r`, [f, n]).then((x) => x[0].r);
const reg = (db, o, tipo, estado, err = null, amb = 'homologacion') => q(db, `SELECT public.arca_auto_registrar($1,$2,$3,$4,$5,$6) r`, [SECRETO, o, tipo, amb, estado, err]).then((x) => x[0].r);
const facturada = async (ctx, o) => {
  const r = (await q(ctx.db, `SELECT public.arca_comprobante_reservar($1,$2,'homologacion',1,0,10000000,96,'43577502',5) r`, [SECRETO, o]))[0].r;
  await q(ctx.db, `SELECT public.arca_comprobante_autorizar($1,$2,$3,'74123456789012','2026-12-01','2026-11-02')`, [SECRETO, r.intento, r.numero]);
  return r;
};

console.log('\n══ Facturación automática (Postgres en WebAssembly) ══\n');
{
  const ctx = await nueva(); const { db } = ctx;
  check('El script corre dos veces más sin romper (idempotente)', !(await falla(() => db.exec(SCRIPT))) && !(await falla(() => db.exec(SCRIPT))));
  const vacia = await baseNueva({ conVentas: false, sin7: true });
  check('Sin los scripts 20 a 22 frena con un mensaje claro', (await falla(() => vacia.db.exec(SCRIPT)))?.includes('Faltan los scripts'));
  const res = await db.exec(SCRIPT); const t = res[res.length - 1].rows;
  check('La verificación sale toda en ✅ (interruptores apagados, tablas cerradas)', t.length === 2 && t.every((x) => x.resultado === '✅'), JSON.stringify(t));
}
{
  const ctx = await nueva(); const { db } = ctx;
  const o = await ordenId(ctx);
  check('Apagado por defecto: no hay nada para hacer aunque haya una venta pagada', (await cand(db)).length === 0);
  check('La configuración por defecto está apagada', JSON.stringify(await q(db, `SELECT public.arca_auto_config($1) r`, [SECRETO]).then((x) => x[0].r)) === '{"desde":null,"nota_auto":false,"factura_auto":false}');
  check('Sin el secreto no se lee la configuración ni los candidatos', /no autorizado/.test(String(await falla(() => q(db, `SELECT public.arca_auto_config($1)`, ['x'.repeat(30)])))) && /no autorizado/.test(String(await falla(() => q(db, `SELECT public.arca_auto_candidatos($1,'homologacion',5)`, ['x'.repeat(30)])))));
  check('Valores nulos se rechazan', (await falla(() => conf(db, null, true)))?.includes('VALOR_INVALIDO'));
  await conf(db, true, false);
  const c1 = (await q(db, `SELECT desde FROM public.arca_auto_config`))[0].desde;
  check('Al encender la factura se fija «desde» y se anota en el historial con quién', c1 !== null && (await q(db, `SELECT cambiado_por FROM public.arca_auto_config_historial`))[0].cambiado_por === 'franco@x.com');
  check('Una venta pagada ANTERIOR al encendido NO se factura sola', (await cand(db)).length === 0);
  await q(db, `UPDATE public.meli_ordenes SET creado_en = now() + interval '1 minute' WHERE meli_order_id=$1`, [o]);
  const c = await cand(db);
  check('Una venta pagada posterior al encendido SÍ es candidata, aunque no esté procesada', c.length === 1 && c[0].orden === o && c[0].tipo === 'factura', JSON.stringify(c));
  const canc = await ordenId(ctx, 'cancelled'); await q(db, `UPDATE public.meli_ordenes SET creado_en = now() + interval '1 minute' WHERE meli_order_id=$1`, [canc]);
  check('Una venta cancelada ANTES de facturar no se factura', (await cand(db)).every((x) => x.orden !== canc));
  check('Límite inválido se rechaza', /LIMITE_INVALIDO/.test(String(await falla(() => cand(db, 'homologacion', 0)))));
  await conf(db, true, false);
  check('Encender de nuevo sin cambios no reinicia «desde»', (await q(db, `SELECT desde FROM public.arca_auto_config`))[0].desde.getTime() === c1.getTime());
  await conf(db, false, false); await conf(db, true, false);
  check('Apagar y volver a encender reinicia «desde»', (await q(db, `SELECT desde FROM public.arca_auto_config`))[0].desde.getTime() > c1.getTime());
}
{ // reintentos acotados
  const ctx = await nueva(); const { db } = ctx; await conf(db, true, false);
  const o = await ordenId(ctx); await q(db, `UPDATE public.meli_ordenes SET creado_en = now() + interval '1 minute'`);
  await reg(db, o, 'factura', 'error', 'MELI_BILLING: x');
  check('Tras una falla NO se reintenta de inmediato (espera 5 minutos)', (await cand(db)).length === 0);
  await q(db, `UPDATE public.arca_auto_intentos SET proximo_intento = now() - interval '1 second'`);
  check('Vencida la espera vuelve a ser candidata', (await cand(db)).length === 1);
  let r;
  for (let i = 0; i < 4; i++) { await reg(db, o, 'factura', 'rechazada', 'ARCA: x'); await q(db, `UPDATE public.arca_auto_intentos SET proximo_intento = now() - interval '1 second'`); }
  r = await reg(db, o, 'factura', 'error', 'otra');
  check('Al sexto fallo deja de intentar (sin_mas_intentos) y deja un aviso de fallo', r.estado === 'sin_mas_intentos' && (await q(db, `SELECT aviso, intentos FROM public.arca_auto_intentos`))[0].aviso === 'fallo', JSON.stringify(r));
  await q(db, `UPDATE public.arca_auto_intentos SET proximo_intento = now() - interval '1 second'`);
  check('Con 6 intentos ya no es candidata (aunque venza la espera)', (await cand(db)).length === 0);
  const est = await q(db, `SELECT public.arca_auto_estado() r`).then((x) => x[0].r);
  check('El CRM ve el pendiente con su error y sin más intentos, y el aviso sin ver', est.pendientes.length === 1 && est.pendientes[0].sin_mas_intentos === true && est.avisos.length === 1 && est.avisos[0].aviso === 'fallo', JSON.stringify(est));
  await q(db, `SELECT public.arca_auto_aviso_visto($1,'factura','homologacion')`, [o]);
  check('Marcar el aviso como visto lo saca de la lista', (await q(db, `SELECT public.arca_auto_estado() r`))[0].r.avisos.length === 0);
}
{ // resultado exitoso y en curso
  const ctx = await nueva(); const { db } = ctx; await conf(db, true, false);
  const o = await ordenId(ctx); await q(db, `UPDATE public.meli_ordenes SET creado_en = now() + interval '1 minute'`);
  await reg(db, o, 'factura', 'en_curso');
  check('«En curso» no cuenta como falla: se vuelve a mirar en 5 minutos (sin sumar intentos)', (await q(db, `SELECT intentos FROM public.arca_auto_intentos`))[0].intentos === 0 && (await cand(db)).length === 0);
  const r = await reg(db, o, 'factura', 'emitida');
  check('Emitida: queda resuelta y sin aviso para facturas', r.estado === 'resuelto' && r.aviso === null);
  check('Resuelta, ya no es candidata ni se reabre', (await cand(db)).length === 0 && (await reg(db, o, 'factura', 'error', 'x')).estado === 'ya_resuelto');
  check('Estado inválido se rechaza', (await falla(() => reg(db, o, 'factura', 'cualquiera')))?.includes('ESTADO_INVALIDO'));
}
{ // notas de crédito y conciliación
  const ctx = await nueva(); const { db } = ctx; await conf(db, false, true);
  const o = await ordenId(ctx); await facturada(ctx, o);
  check('Con la nota apagada o la orden pagada no hay nota candidata', (await cand(db)).length === 0);
  await q(db, `UPDATE public.meli_ordenes SET estado='cancelled' WHERE meli_order_id=$1`, [o]);
  const c = await cand(db);
  check('Venta facturada que pasa a CANCELADA → nota candidata', c.length === 1 && c[0].tipo === 'nota' && c[0].orden === o, JSON.stringify(c));
  await conf(db, false, false);
  check('Con el interruptor de nota apagado no hay nada', (await cand(db)).length === 0);
  await conf(db, false, true);
  await q(db, `UPDATE public.meli_ordenes SET procesada = true WHERE meli_order_id=$1`, [o]);
  const r = await reg(db, o, 'nota', 'emitida');
  check('Nota emitida de una venta YA PROCESADA: aviso para revertir el stock a mano', r.aviso === 'nota_emitida_venta_procesada', JSON.stringify(r));
  const o2 = await ordenId(ctx); await facturada(ctx, o2); await q(db, `UPDATE public.meli_ordenes SET estado='cancelled' WHERE meli_order_id=$1`, [o2]);
  const r2 = await reg(db, o2, 'nota', 'emitida');
  check('Nota emitida de una venta sin procesar: aviso simple', r2.aviso === 'nota_emitida', JSON.stringify(r2));
}
{ // factura reservada y orden cancelada en el medio
  const ctx = await nueva(); const { db } = ctx; await conf(db, true, true);
  const o = await ordenId(ctx);
  await q(db, `SELECT public.arca_comprobante_reservar($1,$2,'homologacion',1,0,10000000,96,'43577502',5)`, [SECRETO, o]);
  await q(db, `UPDATE public.meli_ordenes SET estado='cancelled' WHERE meli_order_id=$1`, [o]);
  check('Con el candado vigente de la factura reservada no se toca todavía', (await cand(db)).length === 0);
  await q(db, `UPDATE public.meli_comprobantes SET trabajo_hasta = now() - interval '11 minutes'`);
  const c = await cand(db);
  check('Factura reservada sin confirmar se sigue resolviendo AUNQUE la orden ya esté cancelada', c.length === 1 && c[0].tipo === 'factura' && c[0].orden === o, JSON.stringify(c));
}
{ // permisos
  const ctx = await nueva(); const { db } = ctx;
  for (const rol of ['anon']) {
    check(`${rol} no puede cambiar los interruptores ni ver el estado`, /permission denied/i.test(String(await falla(() => comoRol(db, rol, null, () => conf(db, true, true))))) && /permission denied/i.test(String(await falla(() => comoRol(db, rol, null, () => q(db, `SELECT public.arca_auto_estado()`))))));
  }
  check('Uno dado de baja no puede cambiar los interruptores', /no autorizado/.test(String(await falla(() => comoRol(db, 'authenticated', 'baja@x.com', () => conf(db, true, true))))));
  check('Un usuario autorizado sí', (await comoRol(db, 'authenticated', 'franco@x.com', () => conf(db, true, true))).ok === true);
  check('El navegador no escribe las tablas', /permission denied/i.test(String(await falla(() => comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`UPDATE public.arca_auto_config SET factura_auto = true`))))) && /permission denied/i.test(String(await falla(() => comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`INSERT INTO public.arca_auto_intentos (orden_id,tipo,ambiente) VALUES ('x','factura','homologacion')`))))));
  check('anon no puede llamar candidatos sin secreto válido (solo con el secreto)', /no autorizado/.test(String(await falla(() => comoRol(db, 'anon', null, () => q(db, `SELECT public.arca_auto_candidatos($1,'homologacion',5)`, ['x'.repeat(30)]))))));
  check('El historial no se modifica ni se borra', /HISTORIAL_INMUTABLE/.test(String(await falla(() => db.query(`UPDATE public.arca_auto_config_historial SET cambiado_por='x'`)))) && /HISTORIAL_INMUTABLE/.test(String(await falla(() => db.query(`DELETE FROM public.arca_auto_config_historial`)))));
}
console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
