// Banco de pruebas de db/pendientes/meli_facturas.sql (script 16) contra un Postgres REAL (pglite).
//
//   cd tests/sql && node facturas_meli.sql.test.mjs
//
// Carga el script 3 real (meli_ordenes) y después el 16. Prueba: cada transición permitida y prohibida, la versión
// optimista, el comprobante único, el historial, las protecciones (no se borra, no se vacía), los permisos reales
// (anon, authenticated autorizado y dado de baja, service_role) y que el esquema no pueda guardar datos del comprador.
// LÍMITE: pglite tiene UNA conexión; las carreras se prueban en facturas_meli.concurrencia.test.mjs.
import { baseNueva, SQL, nuevaOrden } from './lib/base_meli.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 400); } };
// Igual, pero devuelve el error entero (código, detalle, nombre de la restricción).
const fallaDet = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const SCRIPT = SQL('meli_facturas.sql');
// Como Supabase: existe service_role (salta RLS) y recibe todo lo nuevo por defecto.
const PREPARAR = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  END $$;
  GRANT USAGE ON SCHEMA public TO service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;`;
const nueva = async (script = SCRIPT) => {
  const c = await baseNueva({ conVentas: false, sin7: true });
  await c.db.exec(PREPARAR);
  await c.db.exec(script);
  return c;
};
const claims = (db, o) => db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify(o)]);
const COMO_FRANCO = { email: 'franco@x.com', sub: '11111111-1111-1111-1111-111111111111', user_metadata: { full_name: 'Franco V' } };
const como = async (db, rol, jwt, fn) => {
  await claims(db, jwt || {});
  await db.query(`SET ROLE ${rol}`);
  try { return await fn(); } finally { await db.query('RESET ROLE'); await claims(db, COMO_FRANCO); }
};
const marcar = (db, orden, estado, o = {}) =>
  db.query(`SELECT public.meli_factura_marcar($1,$2,$3,$4,$5,$6,$7,$8) AS r`,
    [orden, estado, o.tipo ?? null, o.pto ?? null, o.num ?? null, o.fecha ?? null, o.motivo ?? null, o.ver ?? null]).then((x) => x.rows[0].r);
const emitir = (db, orden, num = 1234, o = {}) => marcar(db, orden, 'emitida', { tipo: 'C', pto: 3, num, fecha: '2026-10-01', ...o });
const fila = async (db, orden) => (await db.query(`SELECT * FROM public.meli_facturas WHERE orden_id=$1`, [orden])).rows[0];
const hist = async (db, orden) => (await db.query(`SELECT * FROM public.meli_facturas_historial WHERE orden_id=$1 ORDER BY id`, [orden])).rows;
const cuenta = async (db, t = 'meli_facturas') => (await db.query(`SELECT count(*)::int n FROM public.${t}`)).rows[0].n;
const ordenNueva = async (ctx) => {
  const id = await nuevaOrden(ctx, [{ item: 'MLA1', cant: 1, precio: 1000 }]);
  return (await ctx.db.query(`SELECT meli_order_id m FROM public.meli_ordenes WHERE id=$1`, [id])).rows[0].m;
};
const hoyAR = async (db, dias = 0) => (await db.query(`SELECT ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date + $1::int)::text d`, [dias])).rows[0].d;

console.log('\n══ Facturas de Mercado Libre — control (Postgres en WebAssembly) ══\n');

// ── 1 · Corre limpio, dos veces; exige sus requisitos; la tabla de verificación sale en ✅ ──
{
  const ctx = await nueva(); const { db } = ctx;
  const e = await falla(() => db.exec(SCRIPT)), e2 = await falla(() => db.exec(SCRIPT));
  check('El script 16 corre dos veces más sin romper (idempotente)', !e && !e2, `${e} | ${e2}`);
  const vacia = await baseNueva({ conVentas: false, sin7: true });
  await vacia.db.exec('DROP TABLE public.meli_ordenes CASCADE');
  const e3 = await falla(() => vacia.db.exec(SCRIPT));
  check('Sin meli_ordenes frena con un mensaje claro', e3 && e3.includes('Falta el script 3'), e3);
  const res = await db.exec(SCRIPT);
  const tabla = res[res.length - 1].rows;
  check('La tabla de verificación sale toda en ✅ (11 controles)', tabla.length === 11 && tabla.every((x) => x.resultado === '✅'), JSON.stringify(tabla.map((x) => [x.id, x.resultado])));
}

// ── 1b · Correr el script de nuevo con DATOS: nada cambia (ni filas, ni historial, ni permisos) y todo sigue funcionando ──
{
  const ctx = await nueva(); const { db } = ctx;
  const a = await ordenNueva(ctx), b = await ordenNueva(ctx), c = await ordenNueva(ctx), d = await ordenNueva(ctx);
  await emitir(db, a, 11); await marcar(db, b, 'no_corresponde', { motivo: 'exenta_o_no_gravada' });
  await emitir(db, c, 12); await marcar(db, c, 'pendiente', { ver: 1 }); await emitir(db, d, 13, { tipo: 'B', pto: 5 });
  const foto = async () => JSON.stringify({
    f: (await db.query(`SELECT * FROM public.meli_facturas ORDER BY orden_id`)).rows,
    h: (await db.query(`SELECT * FROM public.meli_facturas_historial ORDER BY id`)).rows,
    perm: (await db.query(`SELECT r, t, p, has_table_privilege(r, t, p) h FROM unnest(ARRAY['anon','authenticated','service_role']) r, unnest(ARRAY['public.meli_facturas','public.meli_facturas_historial']) t, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p ORDER BY 1,2,3`)).rows,
    fn: (await db.query(`SELECT r, has_function_privilege(r, 'public.meli_factura_marcar(text,text,text,integer,integer,date,text,bigint)', 'EXECUTE') h FROM unnest(ARRAY['anon','authenticated','service_role']) r ORDER BY 1`)).rows,
  });
  const antes = await foto();
  await db.exec(SCRIPT); await db.exec(SCRIPT);
  const res = await db.exec(SCRIPT);
  check('Correr el script 3 veces más SOBRE DATOS (emitidas, reabierta, no corresponde, con historial) no cambia NADA: filas, historial ni permisos', antes === await foto());
  check('… la tabla de verificación sigue toda en ✅ y las operaciones siguen funcionando (reabrir y volver a emitir)', res[res.length - 1].rows.every((x) => x.resultado === '✅') && (await marcar(db, d, 'pendiente', { ver: 1 })).ok === true && (await emitir(db, d, 14, { ver: 2 })).ok === true);
  // Una versión vieja de la función (otra lista de argumentos) no sobrevive.
  await db.query(`CREATE FUNCTION public.meli_factura_marcar(p_orden text, p_estado text, p_numero text, p_emitida_el date, p_motivo text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$`);
  const res2 = await db.exec(SCRIPT);
  const n = (await db.query(`SELECT count(*)::int n FROM pg_proc WHERE proname='meli_factura_marcar'`)).rows[0].n;
  check('Si había una versión VIEJA de la función (otros argumentos), el script la elimina: queda una sola', n === 1 && res2[res2.length - 1].rows.every((x) => x.resultado === '✅'), String(n));
  // Una tabla preexistente con otra estructura frena el script en vez de seguir.
  const ajena = await baseNueva({ conVentas: false, sin7: true });
  await ajena.db.exec(`CREATE TABLE public.meli_facturas (orden_id text primary key, estado text)`);
  const e = await falla(() => ajena.db.exec(SCRIPT));
  check('Si ya existe una tabla meli_facturas con OTRA estructura, el script frena con un mensaje claro y no toca nada', e && e.includes('otra estructura'), e);
  // Nombres correctos pero tipo, columna de más o restricciones de menos: también frena.
  const variantes = {
    'una columna con otro tipo (numero como texto)': (db) => db.exec(`ALTER TABLE public.meli_facturas DROP CONSTRAINT meli_facturas_coherente_ck; DROP INDEX public.meli_facturas_comprobante_unico; ALTER TABLE public.meli_facturas ALTER COLUMN numero TYPE text USING numero::text; ALTER TABLE public.meli_facturas ADD CONSTRAINT meli_facturas_coherente_ck CHECK (true)`),
    'una columna de más': (db) => db.exec(`ALTER TABLE public.meli_facturas ADD COLUMN comprador text`),
    'sin la regla de coherencia': (db) => db.exec(`ALTER TABLE public.meli_facturas DROP CONSTRAINT meli_facturas_coherente_ck`),
    'sin la clave foránea': (db) => db.exec(`ALTER TABLE public.meli_facturas DROP CONSTRAINT meli_facturas_orden_id_fkey`),
    'historial con una columna de otro tipo': (db) => db.exec(`ALTER TABLE public.meli_facturas_historial ALTER COLUMN numero_nuevo TYPE bigint`),
    'historial con una columna de más': (db) => db.exec(`ALTER TABLE public.meli_facturas_historial ADD COLUMN dni text`),
  };
  const pasan = [];
  for (const [que, mod] of Object.entries(variantes)) {
    const v = await nueva(); await mod(v.db);
    const ev = await falla(() => v.db.exec(SCRIPT));
    if (!ev?.includes('otra estructura')) pasan.push(`${que}: ${ev}`);
  }
  check(`Las ${Object.keys(variantes).length} variantes de una tabla preexistente casi igual (tipo, columna de más, restricción de menos) frenan el script`, pasan.length === 0, pasan.join(' | '));
  // Una política ajena se detecta en la verificación.
  await db.query(`CREATE POLICY ajena ON public.meli_facturas FOR SELECT TO anon USING (true)`);
  const res3 = await db.exec(SCRIPT);
  const t3 = res3[res3.length - 1].rows;
  check('Una política de lectura AJENA (por ejemplo para anon) la delata el control 16.10 en ❌', t3.find((x) => x.id === '16.10')?.resultado === '❌', JSON.stringify(t3.map((x) => [x.id, x.resultado])));
}

// ── 2 · Sin fila = pendiente; marcar pendiente no crea nada ─────────────────
{
  const ctx = await nueva(); const { db } = ctx; const o = await ordenNueva(ctx);
  check('Una orden sin fila no aparece en la tabla (se considera pendiente)', await fila(db, o) === undefined);
  const r = await marcar(db, o, 'pendiente');
  check('Marcar "pendiente" una orden sin fila: sin_cambios y NO crea fila ni historial', r.sin_cambios === true && r.version === null && await cuenta(db) === 0 && await cuenta(db, 'meli_facturas_historial') === 0, JSON.stringify(r));
}

// ── 3 · Emitida con datos válidos ──────────────────────────────────────────
{
  const ctx = await nueva(); const { db } = ctx; const o = await ordenNueva(ctx);
  await claims(db, COMO_FRANCO);
  const r = await emitir(db, o, 1234);
  const f = await fila(db, o), h = await hist(db, o);
  check('Emitida: queda con tipo, punto de venta, número y fecha; versión 1; quién (su email verificado) y su identidad estable', r.ok === true && r.version === 1 && f.estado === 'emitida' && f.tipo === 'C' && f.pto_venta === 3 && f.numero === 1234 && f.emitida_el.toISOString().startsWith('2026-10-01') && f.marcada_por === 'franco@x.com' && f.marcada_uid === '11111111-1111-1111-1111-111111111111', JSON.stringify(f));
  check('… y el historial tiene la alta (sin estado anterior)', h.length === 1 && h[0].estado_anterior === null && h[0].estado_nuevo === 'emitida' && h[0].numero_nuevo === 1234 && Number(h[0].version) === 1, JSON.stringify(h));
  const hoy = await emitir(db, await ordenNueva(ctx), 5, { fecha: await hoyAR(db) });
  check('La fecha de HOY (hora de Argentina) se acepta', hoy.ok === true);
  const t = await emitir(db, await ordenNueva(ctx), 7, { tipo: 'a' });
  check('El tipo se normaliza a mayúscula', t.ok === true);
}

// ── 4 · Validaciones: se rechazan y NO queda nada escrito ───────────────────
{
  const ctx = await nueva(); const { db } = ctx; const o = await ordenNueva(ctx);
  const mal = async (cod, fn) => { const e = await falla(fn); return e?.includes(cod) ? null : `${cod}: ${e}`; };
  const manana = await hoyAR(db, 1), ayer = await hoyAR(db, -1);
  const casos = [
    ['ESTADO_INVALIDO', () => marcar(db, o, 'rara')], ['ESTADO_INVALIDO', () => marcar(db, o, null)],
    ['TIPO_INVALIDO', () => emitir(db, o, 1, { tipo: 'Z' })], ['TIPO_INVALIDO', () => emitir(db, o, 1, { tipo: null })], ['TIPO_INVALIDO', () => emitir(db, o, 1, { tipo: '  ' })],
    ['PUNTO_VENTA_INVALIDO', () => emitir(db, o, 1, { pto: 0 })], ['PUNTO_VENTA_INVALIDO', () => emitir(db, o, 1, { pto: 100000 })], ['PUNTO_VENTA_INVALIDO', () => emitir(db, o, 1, { pto: null })],
    ['NUMERO_INVALIDO', () => emitir(db, o, 0)], ['NUMERO_INVALIDO', () => emitir(db, o, 100000000)], ['NUMERO_INVALIDO', () => emitir(db, o, null)],
    ['FECHA_INVALIDA', () => emitir(db, o, 1, { fecha: manana })], ['FECHA_INVALIDA', () => emitir(db, o, 1, { fecha: null })],
    ['DATOS_SOBRANTES', () => emitir(db, o, 1, { motivo: 'no_es_venta_real' })],
    ['MOTIVO_INVALIDO', () => marcar(db, o, 'no_corresponde')], ['MOTIVO_INVALIDO', () => marcar(db, o, 'no_corresponde', { motivo: 'El cliente se llama Juan Pérez, DNI 12.345.678' })],
    ['MOTIVO_INVALIDO', () => marcar(db, o, 'no_corresponde', { motivo: '' })],
    ['DATOS_SOBRANTES', () => marcar(db, o, 'no_corresponde', { motivo: 'no_es_venta_real', num: 5 })], ['DATOS_SOBRANTES', () => marcar(db, o, 'no_corresponde', { motivo: 'no_es_venta_real', tipo: 'C' })],
    ['DATOS_SOBRANTES', () => marcar(db, o, 'pendiente', { num: 5 })], ['DATOS_SOBRANTES', () => marcar(db, o, 'pendiente', { motivo: 'no_es_venta_real' })],
    ['ORDEN_INEXISTENTE', () => emitir(db, 'NO-EXISTE', 1)], ['ORDEN_INEXISTENTE', () => emitir(db, null, 1)], ['ORDEN_INEXISTENTE', () => emitir(db, '   ', 1)],
  ];
  const fallos = []; for (const [cod, fn] of casos) { const m = await mal(cod, fn); if (m) fallos.push(m); }
  check(`${casos.length} entradas inválidas se rechazan, cada una con su código`, fallos.length === 0, fallos.join(' | '));
  check('… y no quedó nada escrito (ni fila ni historial)', await cuenta(db) === 0 && await cuenta(db, 'meli_facturas_historial') === 0);
  check('Ayer y los motivos de la lista cerrada se aceptan', (await emitir(db, o, 1, { fecha: ayer })).ok === true);
  for (const m of ['no_es_venta_real', 'cancelada_o_devuelta', 'factura_global_de_otro_periodo', 'exenta_o_no_gravada', 'otro_ver_nota_interna']) {
    const x = await marcar(db, await ordenNueva(ctx), 'no_corresponde', { motivo: m });
    if (x.ok !== true) check('Motivo de la lista: ' + m, false, JSON.stringify(x));
  }
  check('Los 5 motivos de la lista cerrada se aceptan', await cuenta(db) === 6);
}

// ── 5 · Idempotencia: repetir lo mismo no cambia nada ───────────────────────
{
  const ctx = await nueva(); const { db } = ctx; const o = await ordenNueva(ctx);
  await emitir(db, o, 10);
  const antes = await fila(db, o);
  await claims(db, { email: 'franco@x.com', sub: '22222222-2222-2222-2222-222222222222', user_metadata: { full_name: 'Otra persona' } });
  const r = await emitir(db, o, 10);
  const despues = await fila(db, o);
  check('Repetir la misma factura: sin_cambios; NO cambia quién, cuándo ni la versión; el historial no crece', r.sin_cambios === true && despues.marcada_por === antes.marcada_por && String(despues.marcada_en) === String(antes.marcada_en) && Number(despues.version) === Number(antes.version) && (await hist(db, o)).length === 1, JSON.stringify(r));
  const o2 = await ordenNueva(ctx);
  await marcar(db, o2, 'no_corresponde', { motivo: 'no_es_venta_real' });
  const r2 = await marcar(db, o2, 'no_corresponde', { motivo: 'no_es_venta_real' });
  check('Repetir el mismo "no corresponde": sin_cambios', r2.sin_cambios === true && (await hist(db, o2)).length === 1);
  const r3 = await marcar(db, o2, 'pendiente', { ver: 1 }); const r4 = await marcar(db, o2, 'pendiente');
  check('Reabrir dos veces seguidas: la segunda es sin_cambios', r3.ok === true && r3.estado === 'pendiente' && r4.sin_cambios === true && (await hist(db, o2)).length === 2, JSON.stringify([r3, r4]));
}

// ── 6 · Transiciones prohibidas: hay que REABRIR primero ────────────────────
{
  const ctx = await nueva(); const { db } = ctx; const o = await ordenNueva(ctx); const o2 = await ordenNueva(ctx);
  await emitir(db, o, 20); await marcar(db, o2, 'no_corresponde', { motivo: 'no_es_venta_real' });
  const prohibidas = [
    ['emitida → otro número', () => emitir(db, o, 21, { ver: 1 })], ['emitida → otra fecha', () => emitir(db, o, 20, { ver: 1, fecha: '2026-10-02' })],
    ['emitida → no corresponde', () => marcar(db, o, 'no_corresponde', { motivo: 'no_es_venta_real', ver: 1 })],
    ['no corresponde → emitida', () => emitir(db, o2, 22, { ver: 1 })], ['no corresponde → otro motivo', () => marcar(db, o2, 'no_corresponde', { motivo: 'exenta_o_no_gravada', ver: 1 })],
  ];
  const mal = [];
  for (const [que, fn] of prohibidas) { const e = await falla(fn); if (!e?.includes('FACTURA_YA_REGISTRADA')) mal.push(`${que}: ${e}`); }
  check('Las 5 transiciones directas se rechazan con FACTURA_YA_REGISTRADA', mal.length === 0, mal.join(' | '));
  const f = await fila(db, o), f2 = await fila(db, o2);
  check('… y las filas quedan exactamente como estaban (versión 1, mismos datos)', f.numero === 20 && Number(f.version) === 1 && f2.motivo === 'no_es_venta_real' && Number(f2.version) === 1, JSON.stringify([f, f2]));
}

// ── 7 · Reabrir: vuelve a pendiente, limpia el comprobante y el historial lo conserva ──
{
  const ctx = await nueva(); const { db } = ctx; const o = await ordenNueva(ctx);
  await emitir(db, o, 30);
  const r = await marcar(db, o, 'pendiente', { ver: 1 });
  const f = await fila(db, o);
  check('Reabrir: queda pendiente, sin tipo, punto de venta, número ni fecha; versión 2', r.ok === true && r.version === 2 && f.estado === 'pendiente' && f.tipo === null && f.pto_venta === null && f.numero === null && f.emitida_el === null && f.motivo === null, JSON.stringify(f));
  const r2 = await emitir(db, o, 31, { ver: 2 });
  const h = await hist(db, o);
  check('Volver a emitir con otro número: versión 3', r2.ok === true && r2.version === 3);
  check('El historial conserva TODO: alta (30), reapertura (30 → nada) y el nuevo (31), con lo anterior y lo nuevo', h.length === 3 && h[0].numero_nuevo === 30 && h[1].numero_anterior === 30 && h[1].estado_nuevo === 'pendiente' && h[1].numero_nuevo === null && h[2].estado_anterior === 'pendiente' && h[2].numero_nuevo === 31, JSON.stringify(h.map((x) => [x.estado_anterior, x.numero_anterior, x.estado_nuevo, x.numero_nuevo])));
  const o2 = await ordenNueva(ctx);
  await marcar(db, o2, 'no_corresponde', { motivo: 'cancelada_o_devuelta' });
  const r3 = await marcar(db, o2, 'pendiente', { ver: 1 });
  check('También se reabre un "no corresponde" (y el motivo queda en el historial)', r3.ok && (await hist(db, o2))[1].motivo_anterior === 'cancelada_o_devuelta');
}

// ── 8 · Versión optimista: una pantalla vieja no pisa ───────────────────────
{
  const ctx = await nueva(); const { db } = ctx; const o = await ordenNueva(ctx);
  await emitir(db, o, 40);                                   // A ve la versión 1
  await marcar(db, o, 'pendiente', { ver: 1 });              // B reabre (v2)
  await emitir(db, o, 41, { ver: 2 });                       // B registra otro número (v3)
  const e = await falla(() => marcar(db, o, 'pendiente', { ver: 1 }));   // A reabre con lo que vio
  const f = await fila(db, o);
  check('Una acción vieja ("reabrir" con la versión 1) NO borra la factura nueva: FACTURA_CAMBIO_RECARGAR', e?.includes('FACTURA_CAMBIO_RECARGAR') && f.numero === 41 && f.estado === 'emitida' && Number(f.version) === 3, `${e} ${JSON.stringify(f)}`);
  const o2 = await ordenNueva(ctx);
  const e2 = await falla(() => emitir(db, o2, 42, { ver: 5 }));
  check('Sin fila pero la pantalla creía ver una versión: FACTURA_CAMBIO_RECARGAR y no se crea nada', e2?.includes('FACTURA_CAMBIO_RECARGAR') && await fila(db, o2) === undefined, e2);
  await marcar(db, o2, 'no_corresponde', { motivo: 'no_es_venta_real' });
  const e3 = await falla(() => marcar(db, o2, 'pendiente'));
  check('Hay fila pero la pantalla no mandó versión (NULL): FACTURA_CAMBIO_RECARGAR', e3?.includes('FACTURA_CAMBIO_RECARGAR'), e3);
  const e4 = await falla(() => marcar(db, o2, 'pendiente', { ver: 99 }));
  check('Una versión de otra época: FACTURA_CAMBIO_RECARGAR', e4?.includes('FACTURA_CAMBIO_RECARGAR'), e4);
  check('Un reintento idéntico con versión vieja es un éxito sin cambios (no molesta al usuario)', (await emitir(db, o, 41, { ver: 1 })).sin_cambios === true);
}

// ── 9 · Un comprobante ↔ una orden ───────────────────────────────────────────
{
  const ctx = await nueva(); const { db } = ctx; const a = await ordenNueva(ctx), b = await ordenNueva(ctx), c = await ordenNueva(ctx);
  await emitir(db, a, 50);
  const ed = await fallaDet(() => emitir(db, b, 50));
  check('El MISMO comprobante (C 0003-00000050) en otra orden: NUMERO_REPETIDO, y el detalle dice EXACTAMENTE en cuál orden está', String(ed?.message).includes('NUMERO_REPETIDO') && ed?.detail === 'ya está en la orden ' + a, `${ed?.message} | ${ed?.detail}`);
  check('… y no queda nada a medias: sin fila ni historial para la segunda orden', await fila(db, b) === undefined && (await hist(db, b)).length === 0);
  check('Otro TIPO con el mismo punto de venta y número es otro comprobante: se acepta', (await emitir(db, b, 50, { tipo: 'B' })).ok === true);
  check('Otro punto de venta con el mismo número también', (await emitir(db, c, 50, { pto: 4 })).ok === true);
  // Reabrir libera el número: la corrección legítima (se anotó en la orden equivocada).
  await marcar(db, a, 'pendiente', { ver: 1 });
  const d = await ordenNueva(ctx);
  const r = await emitir(db, d, 50);
  check('Si se reabre la orden equivocada, el número se puede anotar en la correcta (queda en el historial de las dos)', r.ok === true && (await hist(db, a)).some((h) => h.numero_nuevo === 50) && (await hist(db, d)).some((h) => h.numero_nuevo === 50));
  const x = await db.query(`SELECT count(*)::int n FROM public.meli_facturas WHERE estado='emitida' AND tipo='C' AND pto_venta=3 AND numero=50`);
  check('… y en la tabla viva ese comprobante está en UNA sola orden', x.rows[0].n === 1);
  // Una violación de OTRO índice único NO se disfraza de NUMERO_REPETIDO: se propaga tal cual (23505 con su propio nombre).
  const ctx2 = await nueva(); const db2 = ctx2.db;   // base limpia: el índice de prueba no puede chocar con filas anteriores
  await db2.query(`CREATE UNIQUE INDEX meli_facturas_prueba_otro_indice ON public.meli_facturas (pto_venta, numero) WHERE estado = 'emitida'`);
  const x1 = await ordenNueva(ctx2), x2 = await ordenNueva(ctx2);
  await emitir(db2, x1, 777);
  const eo = await fallaDet(() => emitir(db2, x2, 777, { tipo: 'A' }));
  check('Otro índice único que se viole (mismo punto de venta y número, distinto tipo) se propaga como 23505 con SU nombre y NO se llama NUMERO_REPETIDO',
    eo?.code === '23505' && eo?.constraint === 'meli_facturas_prueba_otro_indice' && !String(eo?.message).includes('NUMERO_REPETIDO'), `${eo?.code} ${eo?.constraint} ${eo?.message}`);
  check('… y esa segunda orden no quedó con nada', await fila(db2, x2) === undefined && (await hist(db2, x2)).length === 0);
  const r5 = await marcar(db, await ordenNueva(ctx), 'no_corresponde', { motivo: 'factura_global_de_otro_periodo' });
  check('La excepción documentada: "no corresponde" por factura global (sin número)', r5.ok === true);
}

// ── 10 · Reglas de la tabla directamente (como el dueño): los CHECK no dejan pasar NULL ───────────
{
  const ctx = await nueva(); const { db } = ctx; const o = await ordenNueva(ctx);
  const ins = (estado, tipo, pto, num, fecha, motivo) => falla(() => db.query(
    `INSERT INTO public.meli_facturas (orden_id, estado, tipo, pto_venta, numero, emitida_el, motivo, marcada_por) VALUES ($1,$2,$3,$4,$5,$6,$7,'x')`, [o, estado, tipo, pto, num, fecha, motivo]));
  const malos = {
    'emitida sin número': ['emitida', 'C', 3, null, '2026-10-01', null], 'emitida sin tipo': ['emitida', null, 3, 1, '2026-10-01', null],
    'emitida sin punto de venta': ['emitida', 'C', null, 1, '2026-10-01', null], 'emitida sin fecha': ['emitida', 'C', 3, 1, null, null],
    'emitida con tipo Z': ['emitida', 'Z', 3, 1, '2026-10-01', null], 'emitida con número 0': ['emitida', 'C', 3, 0, '2026-10-01', null],
    'emitida con motivo': ['emitida', 'C', 3, 1, '2026-10-01', 'no_es_venta_real'],
    'no_corresponde sin motivo': ['no_corresponde', null, null, null, null, null], 'no_corresponde con motivo libre': ['no_corresponde', null, null, null, null, 'Juan Pérez DNI 1'],
    'no_corresponde con número': ['no_corresponde', null, null, 5, null, 'no_es_venta_real'],
    'pendiente con número': ['pendiente', null, null, 5, null, null], 'pendiente con motivo': ['pendiente', null, null, null, null, 'no_es_venta_real'],
    'estado raro': ['rara', null, null, null, null, null],
  };
  const pasan = []; for (const [k, v] of Object.entries(malos)) { const e = await ins(...v); if (!e) pasan.push(k); }
  check(`${Object.keys(malos).length} combinaciones incoherentes (con NULL incluidos) las rechaza la propia tabla`, pasan.length === 0, 'pasaron: ' + pasan.join(', '));
  const eN = await falla(() => db.query(`INSERT INTO public.meli_facturas (orden_id, estado, marcada_por) VALUES ($1, NULL, 'x')`, [o]));
  const eO = await falla(() => db.query(`INSERT INTO public.meli_facturas (orden_id, estado, marcada_por) VALUES ('NO-EXISTE', 'pendiente', 'x')`));
  check('Estado NULL y una orden que no existe también se rechazan (FK)', eN?.includes('null value') && eO?.includes('foreign key'), `${eN} | ${eO}`);
}

// ── 11 · Protecciones: no se borra, no se vacía, el historial no se toca ────
{
  const ctx = await nueva(); const { db } = ctx; const o = await ordenNueva(ctx);
  await emitir(db, o, 60);
  const e1 = await falla(() => db.query(`DELETE FROM public.meli_facturas WHERE orden_id=$1`, [o]));
  const e2 = await falla(() => db.query(`TRUNCATE public.meli_facturas`));
  const e3 = await falla(() => db.query(`TRUNCATE public.meli_facturas_historial`));
  const e4 = await falla(() => db.query(`UPDATE public.meli_facturas_historial SET numero_nuevo = 1`));
  const e5 = await falla(() => db.query(`DELETE FROM public.meli_facturas_historial`));
  const e6 = await falla(() => db.query(`UPDATE public.meli_facturas SET orden_id = 'otra' WHERE orden_id=$1`, [o]));
  check('Ni siquiera el dueño puede borrar ni vaciar las facturas, ni tocar el historial, ni cambiar a qué orden pertenece', e1?.includes('FACTURA_NO_SE_BORRA') && e2?.includes('FACTURA_NO_SE_BORRA') && e3?.includes('HISTORIAL_INMUTABLE') && e4?.includes('HISTORIAL_INMUTABLE') && e5?.includes('HISTORIAL_INMUTABLE') && e6?.includes('FACTURA_ORDEN_INMUTABLE'), [e1, e2, e3, e4, e5, e6].join(' | '));
  const e7 = await falla(() => db.query(`DELETE FROM public.meli_ordenes WHERE meli_order_id=$1`, [o]));
  check('Una orden con factura registrada no se puede borrar (la clave foránea lo impide)', e7?.includes('foreign key') || e7?.includes('violates'), e7);
  const n = await cuenta(db, 'meli_facturas_historial');
  await db.query(`UPDATE public.meli_facturas SET marcada_por = marcada_por WHERE orden_id=$1`, [o]);
  check('Un UPDATE que no cambia nada no deja rastro en el historial', await cuenta(db, 'meli_facturas_historial') === n);
  check('Todo sigue en su lugar', await cuenta(db) === 1 && n === 1);
}

// ── 12 · Permisos reales: anon, authenticated (autorizado y dado de baja), service_role ──
{
  const ctx = await nueva(); const { db } = ctx; const o = await ordenNueva(ctx); const o2 = await ordenNueva(ctx);
  await emitir(db, o, 70);
  const ANON = null;
  const e1 = await falla(() => como(db, 'anon', ANON, () => db.query(`SELECT * FROM public.meli_facturas`)));
  const e2 = await falla(() => como(db, 'anon', ANON, () => marcar(db, o2, 'no_corresponde', { motivo: 'no_es_venta_real' })));
  check('anon: no puede ni leer las tablas ni ejecutar la función (permission denied)', e1?.includes('permission denied') && e2?.includes('permission denied'), `${e1} | ${e2}`);
  const lee = await como(db, 'authenticated', COMO_FRANCO, () => db.query(`SELECT orden_id FROM public.meli_facturas`));
  const leeH = await como(db, 'authenticated', COMO_FRANCO, () => db.query(`SELECT orden_id FROM public.meli_facturas_historial`));
  check('Un usuario autorizado del CRM lee las facturas y el historial', lee.rows.length === 1 && leeH.rows.length === 1);
  const vacio = await como(db, 'authenticated', { email: 'baja@x.com' }, () => db.query(`SELECT orden_id FROM public.meli_facturas`));
  const sinJwt = await como(db, 'authenticated', {}, () => db.query(`SELECT orden_id FROM public.meli_facturas`));
  check('Un usuario dado de baja, o sin identidad, ve 0 filas (la seguridad por filas filtra)', vacio.rows.length === 0 && sinJwt.rows.length === 0);
  const e3 = await falla(() => como(db, 'authenticated', { email: 'baja@x.com' }, () => marcar(db, o2, 'no_corresponde', { motivo: 'no_es_venta_real' })));
  const e4 = await falla(() => como(db, 'authenticated', {}, () => marcar(db, o2, 'no_corresponde', { motivo: 'no_es_venta_real' })));
  check('… y no puede escribir con la función: "no autorizado" (también sin identidad)', e3?.includes('no autorizado') && e4?.includes('no autorizado'), `${e3} | ${e4}`);
  const escrituras = {
    INSERT: `INSERT INTO public.meli_facturas (orden_id, estado, marcada_por) VALUES ('${o2}', 'pendiente', 'x')`,
    UPDATE: `UPDATE public.meli_facturas SET estado = 'pendiente'`, DELETE: `DELETE FROM public.meli_facturas`,
    TRUNCATE: `TRUNCATE public.meli_facturas`, 'INSERT historial': `INSERT INTO public.meli_facturas_historial (orden_id, version, estado_nuevo, marcada_por) VALUES ('x', 1, 'pendiente', 'x')`,
    'UPDATE historial': `UPDATE public.meli_facturas_historial SET orden_id = 'x'`, 'DELETE historial': `DELETE FROM public.meli_facturas_historial`,
  };
  const pasan = [];
  for (const rol of ['authenticated', 'service_role']) for (const [k, q] of Object.entries(escrituras)) {
    const e = await falla(() => como(db, rol, COMO_FRANCO, () => db.query(q)));
    if (!e?.includes('permission denied')) pasan.push(`${rol} ${k}: ${e}`);
  }
  check('authenticated y service_role NO pueden escribir las tablas directamente (7 formas cada uno)', pasan.length === 0, pasan.join(' | '));
  const e5 = await falla(() => como(db, 'service_role', COMO_FRANCO, () => db.query(`SELECT * FROM public.meli_facturas`)));
  const e6 = await falla(() => como(db, 'service_role', COMO_FRANCO, () => marcar(db, o2, 'no_corresponde', { motivo: 'no_es_venta_real' })));
  check('service_role (aunque salte la seguridad por filas) no puede leer ni usar la función', e5?.includes('permission denied') && e6?.includes('permission denied'), `${e5} | ${e6}`);
  const e7 = await falla(() => como(db, 'authenticated', COMO_FRANCO, () => db.query(`SELECT public.meli__factura_historial()`)));
  const e8 = await falla(() => como(db, 'authenticated', COMO_FRANCO, () => db.query(`SELECT nextval('public.meli_facturas_historial_id_seq')`)));
  check('Las funciones internas y la secuencia del historial no las toca el CRM', e7?.includes('permission denied') && e8?.includes('permission denied'), `${e7} | ${e8}`);
  const o3 = await ordenNueva(ctx);
  const sucio = { email: 'franco@x.com', sub: '33333333-3333-3333-3333-333333333333', user_metadata: { full_name: 'Juan Pérez DNI 12345678 Calle Falsa 123', name: 'Juan Pérez DNI 12345678' } };
  await como(db, 'authenticated', sucio, () => marcar(db, o3, 'no_corresponde', { motivo: 'no_es_venta_real' }));
  const f3 = await fila(db, o3), h3 = await hist(db, o3);
  check('El nombre del perfil (user_metadata, que cada usuario puede editar) NO se guarda: ni en la fila ni en el historial; solo el email verificado', f3.marcada_por === 'franco@x.com' && h3[0].marcada_por === 'franco@x.com' && !JSON.stringify([f3, h3]).includes('12345678'), JSON.stringify([f3, h3]));
  const ok1 = await como(db, 'authenticated', COMO_FRANCO, () => marcar(db, o2, 'no_corresponde', { motivo: 'no_es_venta_real' }));
  check('Un usuario autorizado SÍ puede marcar con la función', ok1.ok === true);
  const f = await fila(db, o2);
  check('… y se anota con su nombre e identidad del token, no con lo que quiera pasar la pantalla', f.marcada_por === 'franco@x.com' && f.marcada_uid === '11111111-1111-1111-1111-111111111111', JSON.stringify(f));
}

// ── 13 · La orden no se toca; revertidas y canceladas se pueden marcar; el rollback es conjunto ──
{
  const ctx = await nueva(); const { db } = ctx; const o = await ordenNueva(ctx);
  await db.query(`UPDATE public.meli_ordenes SET estado = 'cancelled' WHERE meli_order_id=$1`, [o]);
  const foto = async () => (await db.query(`SELECT md5(t::text) h FROM public.meli_ordenes t WHERE meli_order_id=$1`, [o])).rows[0].h;
  const antes = await foto();
  const r = await emitir(db, o, 80);
  await marcar(db, o, 'pendiente', { ver: 1 });
  check('Se puede anotar la factura de una orden cancelada (puede existir y anularse), y la ORDEN no se modifica en nada', r.ok === true && antes === await foto());
  const o2 = await ordenNueva(ctx);
  await db.exec('BEGIN');
  await emitir(db, o2, 81);
  const dentro = await cuenta(db, 'meli_facturas_historial');
  await db.exec('ROLLBACK');
  check('Si la transacción se deshace, se deshacen juntos la factura y su historial', dentro > 0 && await fila(db, o2) === undefined && (await hist(db, o2)).length === 0);
}

// ── 14 · Privacidad: el esquema no tiene dónde guardar datos del comprador ni importes ───────────
{
  const ctx = await nueva(); const { db } = ctx;
  const cols = (await db.query(`SELECT column_name c FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('meli_facturas','meli_facturas_historial')`)).rows.map((x) => x.c);
  const prohibidas = cols.filter((c) => /comprador|buyer|dni|cuit|cuil|doc|direcc|domicilio|address|nombre|name|mail|tel|emisor|importe|monto|total|bruto|neto|precio|nota|texto|detalle|comentario/i.test(c));
  check('Ninguna columna de comprador, documento, dirección, emisor, importe ni texto libre', prohibidas.length === 0 && cols.length > 10, prohibidas.join(', '));
  const sp = (await db.query(`SELECT pg_get_functiondef('public.meli_factura_marcar(text,text,text,integer,integer,date,text,bigint)'::regprocedure) d`)).rows[0].d;
  check('La función no recibe comprador, documento ni importe (solo orden, estado, tipo, punto de venta, número, fecha, motivo y versión)', !/comprador|dni|cuit|importe|monto/i.test(sp.slice(0, sp.indexOf('AS $'))) && sp.indexOf('AS $') > 0);
}

// ── 15 · MUTACIONES: si se saca una defensa, las pruebas correspondientes tienen que fallar ──────
{
  const escenarios = {
    'comprobante único': async (db, ctx) => { const a = await ordenNueva(ctx), b = await ordenNueva(ctx); await emitir(db, a, 90); return !!(await falla(() => emitir(db, b, 90))); },
    'versión optimista': null,
    'transición directa prohibida': async (db, ctx) => { const a = await ordenNueva(ctx); await emitir(db, a, 92); return !!(await falla(() => emitir(db, a, 93, { ver: 1 }))); },
    'historial': async (db, ctx) => { const a = await ordenNueva(ctx); await emitir(db, a, 94); return (await hist(db, a)).length === 1; },
    'no se borra': async (db, ctx) => { const a = await ordenNueva(ctx); await emitir(db, a, 95); return !!(await falla(() => db.query(`DELETE FROM public.meli_facturas`))); },
    'solo lectura para el CRM': async (db, ctx) => { const a = await ordenNueva(ctx); await emitir(db, a, 96); return !!(await falla(() => como(db, 'authenticated', COMO_FRANCO, () => db.query(`DELETE FROM public.meli_facturas`)))); },
  };
  const quitar = {
    'comprobante único': (s) => s.replace(/CREATE UNIQUE INDEX IF NOT EXISTS meli_facturas_comprobante_unico[\s\S]*?;\n/, ''),
    'versión optimista': (s) => s.replace("IF p_version_esperada IS DISTINCT FROM v_ver THEN", 'IF FALSE THEN'),
    'transición directa prohibida': (s) => s.replace("IF p_estado <> 'pendiente' AND v_actual <> 'pendiente' THEN", 'IF FALSE THEN'),
    'historial': (s) => s.replace(/CREATE TRIGGER meli_facturas_historial_tg[\s\S]*?;\n/, ''),
    'no se borra': (s) => s.replace(/CREATE TRIGGER meli_facturas_proteger_tg[\s\S]*?;\n/, ''),
    'solo lectura para el CRM': (s) => s.replace('REVOKE ALL ON TABLE public.meli_facturas, public.meli_facturas_historial FROM PUBLIC, anon, authenticated;', ''),
  };
  // 'versión optimista': la mutación debe dejar pasar la acción vieja (la fila termina "pendiente" aunque la versión era otra).
  escenarios['versión optimista'] = async (db, ctx) => {
    const a = await ordenNueva(ctx); await emitir(db, a, 91); await marcar(db, a, 'pendiente', { ver: 1 }); await emitir(db, a, 97, { ver: 2 });
    return !!(await falla(() => marcar(db, a, 'pendiente', { ver: 1 })));
  };
  for (const [nombre, esc] of Object.entries(escenarios)) {
    const real = await nueva(); const buena = await esc(real.db, real);
    const mutado = quitar[nombre](SCRIPT);
    let detectada = false;
    if (mutado === SCRIPT) { check(`Mutación «${nombre}»: no se pudo aplicar al script`, false, 'el texto a quitar no existe'); continue; }
    try {
      const m = await nueva(mutado);
      const sigueBien = await esc(m.db, m);
      detectada = buena === true && sigueBien === false;
    } catch (e) { detectada = false; }
    check(`Mutación «${nombre}»: con la defensa el escenario se cumple y SIN ella el banco lo detecta`, detectada, `con defensa=${buena}`);
  }
}

// ── 16 · El paquete: lo que se corre es lo que se probó ────────────────────────────────────────
{
  const fs = await import('node:fs'); const path = await import('node:path'); const { AQUI } = await import('./lib/base_meli.mjs');
  const p16 = fs.readFileSync(path.join(AQUI, '../../db/para-correr/16_meli_facturas.sql'), 'utf8');
  check('db/para-correr/16_… es IDÉNTICO a db/pendientes/meli_facturas.sql (lo que se corre es lo que se probó)', p16 === SCRIPT);
}

console.log(`\n${ok} bien, ${fail} mal`);
process.exit(fail ? 1 : 0);
