// Banco de pruebas de db/pendientes/arca_control_anual.sql (control de facturación anual) contra Postgres real (pglite).
//   cd tests/sql && node arca_control_anual.sql.test.mjs
import { baseNueva, SQL, nuevaOrden, comoRol } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };
const PREPARAR = `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;`;
const SCRIPT = SQL('arca_control_anual.sql');
const ctx = await baseNueva({ conVentas: false, sin7: true });
const { db } = ctx;
await db.exec(PREPARAR); await db.exec(SQL('meli_facturas.sql')); await db.exec(SQL('arca_comprobantes.sql')); await db.exec(SCRIPT);

// Inserta comprobantes ya hechos (como si el servidor los hubiera emitido) con la fecha y el ambiente pedidos.
let n = 0;
async function comprobante({ amb = 'produccion', estado = 'autorizado', dias = 0, centavos = 10000000, pv = 1 }) {
  const id = await nuevaOrden(ctx, [{ item: 'MLA1', precio: 1000 }]);
  const ord = (await db.query(`SELECT meli_order_id m FROM public.meli_ordenes WHERE id=$1`, [id])).rows[0].m;
  const num = estado === 'rechazado' ? null : ++n;
  await db.query(
    `INSERT INTO public.meli_comprobantes (orden_id, ambiente, cbte_tipo, pto_venta, numero, estado, importe_centavos, doc_tipo, doc_nro, cond_iva, cae, cae_vto, fecha_cbte)
     VALUES ($1,$2,11,$3,$4,$5,$6,99,'0',5,$7,$8,$9)`,
    [ord, amb, pv, num, estado, centavos, estado === 'autorizado' ? '74123456789012' : null, estado === 'autorizado' ? '2026-12-01' : null,
     estado === 'autorizado' ? (await db.query(`SELECT ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - $1::int)::text d`, [dias])).rows[0].d : null]);
}
const anual = () => db.query(`SELECT public.arca_control_anual() r`).then((x) => x.rows[0].r);
const guardar = (l, f) => db.query(`SELECT public.arca_control_config_guardar($1,$2) r`, [l, f]).then((x) => x.rows[0].r);

console.log('\n══ Control de facturación anual (Postgres en WebAssembly) ══\n');
{
  const e = await falla(() => db.exec(SCRIPT)), e2 = await falla(() => db.exec(SCRIPT));
  check('El script corre dos veces más sin romper (idempotente)', !e && !e2, `${e} | ${e2}`);
  const vacia = await baseNueva({ conVentas: false, sin7: true });
  check('Sin el script 20 frena con un mensaje claro', (await falla(() => vacia.db.exec(SCRIPT)))?.includes('Falta el script 20'));
  const res = await db.exec(SCRIPT); const t = res[res.length - 1].rows;
  check('La verificación sale toda en ✅', t.length === 2 && t.every((x) => x.resultado === '✅'), JSON.stringify(t));
}
{
  const a0 = await anual();
  check('Sin datos: todo en cero y límite sin configurar', Number(a0.total_centavos) === 0 && Number(a0.limite_centavos) === 0 && a0.cantidad === 0 && a0.por_mes.length === 0, JSON.stringify(a0));
  await comprobante({ dias: 1, centavos: 10000000 });          // ayer: 100.000
  await comprobante({ dias: 40, centavos: 5000050 });          // hace 40 días: 50.000,50
  await comprobante({ dias: 364, centavos: 2000000 });         // dentro de los 12 meses
  await comprobante({ dias: 400, centavos: 9900000 });         // fuera de la ventana
  await comprobante({ amb: 'homologacion', dias: 1, centavos: 7700000 });   // prueba: no cuenta
  await comprobante({ estado: 'reservado', centavos: 6600000 }).catch(() => {});
  await comprobante({ estado: 'rechazado', centavos: 5500000 });
  const a = await anual();
  check('Suma solo producción autorizada dentro de los 12 meses (100.000 + 50.000,50 + 20.000)', Number(a.facturado_crm_centavos) === 17000050 && a.cantidad === 3, JSON.stringify(a));
  check('Las de prueba (homologación) no cuentan', Number(a.facturado_crm_centavos) !== 17000050 + 7700000);
  check('Una factura fuera de la ventana (400 días) no cuenta', a.por_mes.every((m) => Number(m.centavos) !== 9900000));
  check('Reparte por mes y la suma de los meses da el total', a.por_mes.reduce((s, m) => s + Number(m.centavos), 0) === 17000050 && a.por_mes.every((m) => /^\d{4}-\d{2}$/.test(m.mes)), JSON.stringify(a.por_mes));
}
{
  check('Configurar límite y monto externo', (await guardar(900000000, 25000000)).ok === true);
  const a = await anual();
  check('El total suma lo facturado en el CRM más lo externo', Number(a.total_centavos) === 17000050 + 25000000 && Number(a.limite_centavos) === 900000000 && a.actualizado_por === 'franco@x.com', JSON.stringify(a));
  check('Guardar lo mismo no repite el historial', (await guardar(900000000, 25000000)).sin_cambios === true);
  await guardar(950000000, 25000000);
  const h = (await db.query(`SELECT * FROM public.arca_control_config_historial ORDER BY id`)).rows;
  check('Cada cambio deja historial con lo anterior y lo nuevo y quién', h.length === 2 && Number(h[1].limite_anterior_centavos) === 900000000 && Number(h[1].limite_nuevo_centavos) === 950000000 && h[1].cambiado_por === 'franco@x.com', JSON.stringify(h));
  check('El historial no se modifica', (await falla(() => db.query(`UPDATE public.arca_control_config_historial SET cambiado_por='x'`)))?.includes('HISTORIAL_INMUTABLE'));
  check('El historial no se borra ni se vacía', (await falla(() => db.query(`DELETE FROM public.arca_control_config_historial`)))?.includes('HISTORIAL_INMUTABLE') && (await falla(() => db.query(`TRUNCATE public.arca_control_config_historial`)))?.includes('HISTORIAL_INMUTABLE'));
  for (const [l, f, cod] of [[-1, 0, 'LIMITE_INVALIDO'], [null, 0, 'LIMITE_INVALIDO'], [0, -5, 'MONTO_EXTERNO_INVALIDO'], [0, null, 'MONTO_EXTERNO_INVALIDO'], ['100000000000000', 0, 'LIMITE_INVALIDO']]) {
    check(`Valor inválido (${l}, ${f}) → ${cod}`, (await falla(() => guardar(l, f)))?.includes(cod));
  }
}
{
  const aut = await comoRol(db, 'authenticated', 'franco@x.com', () => anual());
  check('Un usuario autorizado ve el control', Number(aut.limite_centavos) === 950000000);
  check('Uno dado de baja NO lo ve', /no autorizado/.test(String(await falla(() => comoRol(db, 'authenticated', 'baja@x.com', () => anual())))));
  check('Uno dado de baja NO puede guardar', /no autorizado/.test(String(await falla(() => comoRol(db, 'authenticated', 'baja@x.com', () => guardar(1, 1))))));
  check('anon no puede llamar ninguna de las dos', /permission denied/i.test(String(await falla(() => comoRol(db, 'anon', null, () => anual())))) && /permission denied/i.test(String(await falla(() => comoRol(db, 'anon', null, () => guardar(1, 1))))));
  check('El navegador no escribe la configuración con SQL directo', /permission denied/i.test(String(await falla(() => comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`UPDATE public.arca_control_config SET limite_anual_centavos=1`))))));
  const lee = await comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`SELECT limite_anual_centavos FROM public.arca_control_config`));
  check('Pero sí la puede leer', lee.rows.length === 1);
  check('service_role no toca las tablas', /permission denied/i.test(String(await falla(() => comoRol(db, 'service_role', null, () => db.query(`SELECT * FROM public.arca_control_config`))))));
}
console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
