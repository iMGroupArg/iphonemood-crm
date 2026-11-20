// Banco de pruebas de db/pendientes/meli_flex_bonificaciones.sql (script 33): bonificaciones Flex SUELTAS de Mercado Libre, contra un Postgres REAL (pglite).
//   cd tests/sql && node meli_flex.sql.test.mjs
// NO cubre dos conexiones simultáneas (pglite tiene una sola): eso lo cubre meli_flex.concurrencia.test.mjs (Postgres real, varias conexiones).
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SQL = f => fs.readFileSync(path.join(AQUI, '../../db/pendientes/', f), 'utf8');
let ok = 0, fail = 0;
const check = (n, cond, det = '') => { cond ? ok++ : fail++; console.log(`${cond ? '  ok  ' : ' FALLA'} │ ${n}${cond ? '' : '  → ' + det}`); };
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message || e).slice(0, 300); } };
const q = (db, sql, args = []) => db.query(sql, args).then((x) => x.rows);

async function baseNueva({ cuentas = 1 } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE agentes_ro NOLOGIN; CREATE ROLE agentes_revisor NOLOGIN; CREATE ROLE service_role NOLOGIN;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, agentes_ro, agentes_revisor, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, agentes_ro, agentes_revisor, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, agentes_ro, agentes_revisor, service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
      $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    CREATE TABLE public.personas (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre TEXT NOT NULL);
    CREATE TABLE public.cajas (id BIGSERIAL PRIMARY KEY, persona_id UUID REFERENCES public.personas(id),
      bolsillo TEXT NOT NULL, saldo NUMERIC(18,2) NOT NULL DEFAULT 0, actualizado_en TIMESTAMPTZ DEFAULT now());
    CREATE TABLE public.usuarios_autorizados (email TEXT PRIMARY KEY, activo BOOLEAN DEFAULT true);
    CREATE OR REPLACE FUNCTION public.is_authorized_user() RETURNS boolean
    LANGUAGE sql SECURITY DEFINER STABLE AS $$
      SELECT EXISTS (SELECT 1 FROM public.usuarios_autorizados WHERE email = (auth.jwt() ->> 'email') AND activo = true) $$;
    CREATE TABLE public.caja_ledger (id BIGSERIAL PRIMARY KEY, persona_id UUID REFERENCES public.personas(id) ON DELETE SET NULL,
      persona TEXT NOT NULL, bolsillo TEXT NOT NULL, delta NUMERIC(18,2) NOT NULL, saldo_post NUMERIC(18,2),
      tipo TEXT NOT NULL DEFAULT 'otro', referencia TEXT, descripcion TEXT, creado_por TEXT, creado_en TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE public.stock (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre TEXT, categoria TEXT,
      cantidad INTEGER DEFAULT 0, imeis TEXT[] DEFAULT '{}', estado_inventario TEXT DEFAULT 'disponible', costo_usd NUMERIC(18,2) DEFAULT 0);
    CREATE TABLE public.stock_movimientos (id BIGSERIAL PRIMARY KEY, stock_id UUID, tipo TEXT, detalle TEXT,
      cantidad_antes INT, cantidad_despues INT, usuario_nombre TEXT, datos JSONB, creado_en TIMESTAMPTZ DEFAULT now());
    CREATE TABLE public.ventas (id BIGSERIAL PRIMARY KEY, cliente TEXT, vendedor_id UUID, estado TEXT, tipo_venta TEXT,
      fecha_venta DATE, creado_en TIMESTAMPTZ DEFAULT now());
    CREATE TABLE public.venta_items (id BIGSERIAL PRIMARY KEY, venta_id BIGINT REFERENCES public.ventas(id) ON DELETE CASCADE,
      stock_id UUID, imei TEXT, nombre TEXT, costo_usd NUMERIC, precio_usd NUMERIC, es_regalo BOOLEAN DEFAULT false);
    CREATE TABLE public.venta_pagos (id BIGSERIAL PRIMARY KEY, venta_id BIGINT REFERENCES public.ventas(id) ON DELETE CASCADE,
      persona_id UUID, bolsillo TEXT, monto NUMERIC, es_tarjeta BOOLEAN DEFAULT false, diferencial_ars NUMERIC DEFAULT 0, cotizacion_diferencial NUMERIC);
    INSERT INTO public.usuarios_autorizados VALUES ('franco@x.com', true), ('baja@x.com', false);
  `);
  for (const f of ['caja_aplicar_delta.sql', 'meli_esquema_base.sql', 'meli_vincular.sql', 'meli_ventas_migration.sql', 'meli_adelantos.sql']) await db.exec(SQL(f));
  await db.exec(SQL('meli_flex_bonificaciones.sql'));
  await db.exec(`SELECT set_config('request.jwt.claims', '{"email":"franco@x.com"}', false)`);
  const { rows: [p] } = await db.query(`INSERT INTO public.personas (nombre) VALUES ('Franco') RETURNING id`);
  await db.query(`INSERT INTO public.cajas (persona_id, bolsillo, saldo) VALUES ($1,'ARS Mercado Pago',0)`, [p.id]);
  await db.query(`INSERT INTO public.caja_ledger (persona_id, persona, bolsillo, delta, saldo_post, tipo) SELECT persona_id, 'Franco', bolsillo, saldo, saldo, 'saldo_inicial' FROM public.cajas`);
  const ids = [];
  for (let i = 0; i < cuentas; i++) {
    const { rows: [c] } = await db.query(`INSERT INTO public.meli_cuentas (meli_user_id, nickname, persona_id, bolsillo) VALUES ($1,$2,$3,'ARS Mercado Pago') RETURNING id`, [String(999 + i), 'CUENTA' + i, p.id]);
    ids.push(c.id);
  }
  return { db, pid: p.id, cuentaId: ids[0], cuentas: ids };
}
const ops = (n, desde = 1, monto = 499) => Array.from({ length: n }, (_, i) => ({ referencia: `cashback_${String(desde + i).padStart(4, '0')}`, monto }));
// Por defecto la caja esperada es la de la cuenta (como la pantalla, que la toma del plan simulado); `esperada` = [persona, bolsillo] la pisa (null = no la manda).
// La ORDEN es obligatoria en cada operación: si una operación no trae `orden` se le crea (y recuerda por referencia) una orden de la cuenta, para poder escribir los casos con códigos sueltos.
// `crudo` = no toca nada de lo que se manda (para probar justamente la falta de orden).
const ORDENES_AUTO = new WeakMap();
const huellaActual = async (db) => (await q(db, `SELECT md5(count(*)::text || '|' || COALESCE(sum(monto), 0)::text || '|' || COALESCE(max(id), 0)::text) h FROM public.meli_adelanto_ops WHERE tipo = 'flex'`))[0].h;
const acr = async (db, o, cuenta = null, otros = false, sim = false, esperada = undefined, { crudo = false, sinAdelanto = true, huella = undefined } = {}) => {
  if (huella === undefined && !sim) huella = await huellaActual(db);          // como la pantalla: la huella que devolvió la simulación

  let [pe, be] = esperada === undefined ? [undefined, undefined] : (esperada || [null, null]);
  const c = (await q(db, `SELECT id, persona_id, bolsillo FROM public.meli_cuentas WHERE ($1::bigint IS NULL AND activa) OR id = $1 ORDER BY id LIMIT 1`, [cuenta]))[0];
  if (esperada === undefined && !sim) { pe = c ? c.persona_id : null; be = c ? c.bolsillo : null; }
  const cOrd = c || (await q(db, `SELECT id FROM public.meli_cuentas ORDER BY id LIMIT 1`))[0];
  if (!crudo && Array.isArray(o) && cOrd) {
    const memo = ORDENES_AUTO.get(db) || new Map(); ORDENES_AUTO.set(db, memo);
    o = await Promise.all(o.map(async (x) => {
      if (!x || typeof x !== 'object' || x.orden !== undefined || typeof x.referencia !== 'string' || !x.referencia) return x;
      if (!memo.has(x.referencia)) memo.set(x.referencia, await ordenAuto(db, cOrd.id));
      return { ...x, orden: memo.get(x.referencia) };
    }));
  }
  return q(db, `SELECT public.meli_flex_acreditar($1::jsonb,$2,$3,$4,$5,$6,$7,$8) r`, [JSON.stringify(o), cuenta, otros, sim, pe ?? null, be ?? null, sinAdelanto, huella ?? null]).then((x) => x[0].r);
};
const saldo = async (db) => Number((await q(db, `SELECT saldo FROM public.cajas WHERE bolsillo='ARS Mercado Pago'`))[0].saldo);
const cuadra = async (db) => (await q(db, `SELECT (c.saldo - coalesce(l.suma,0))::float AS dif FROM public.cajas c JOIN public.personas p ON p.id=c.persona_id
  LEFT JOIN (SELECT persona,bolsillo,sum(delta) suma FROM public.caja_ledger GROUP BY 1,2) l ON l.persona=p.nombre AND l.bolsillo=c.bolsillo`)).every((r) => Math.abs(r.dif) < 0.005);
const nFilas = async (db) => (await q(db, `SELECT count(*)::int n FROM public.meli_flex_bonificaciones`))[0].n;
const nLibro = async (db) => (await q(db, `SELECT count(*)::int n FROM public.caja_ledger WHERE clave LIKE 'meli-flex-%'`))[0].n;
const comoRol = async (db, rol, email, fn) => {
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [email ? JSON.stringify({ email }) : '{}']);
  await db.query(`SET ROLE ${rol}`);
  try { return await fn(); } finally { await db.query('RESET ROLE'); await db.query(`SELECT set_config('request.jwt.claims', '{"email":"franco@x.com"}', false)`); }
};
const esperadaPorDefecto = async (db) => { const c = (await q(db, `SELECT persona_id, bolsillo FROM public.meli_cuentas WHERE activa ORDER BY id LIMIT 1`))[0]; return [c.persona_id, c.bolsillo]; };
let seq = 0;
const orden = async (db, cuenta) => (await q(db, `INSERT INTO public.meli_ordenes (cuenta_id, meli_order_id, estado, fecha_orden, moneda, bruto, neto) VALUES ($1,$2,'paid',now(),'ARS',1000,800) RETURNING meli_order_id`, [cuenta, String(7000000000000 + (++seq))]))[0].meli_order_id;

const ordenAuto = (db, cuenta) => orden(db, cuenta);

console.log('\n══ Bonificaciones Flex sueltas (script 33) ══\n');

{
  const { db } = await baseNueva();
  await db.exec(SQL('meli_flex_bonificaciones.sql'));
  check('El script se puede correr dos veces (idempotente)', true);
  const v = await q(db, `SELECT 'x' FROM (SELECT 1) t`);
  void v;
  const r = await db.query(`SELECT CASE WHEN to_regclass('public.meli_flex_bonificaciones') IS NOT NULL AND to_regprocedure('public.meli_flex_acreditar(jsonb,bigint,boolean,boolean,uuid,text,boolean,text)') IS NOT NULL THEN '✅' ELSE '❌' END AS r`);
  check('La verificación de tablas y funciones da ✅', r.rows[0].r === '✅');
}
{ // simular
  const { db } = await baseNueva();
  const r = await acr(db, ops(7), null, false, true);
  check('Simular devuelve el PLAN: caja de Franco · ARS Mercado Pago, 7 bonificaciones, $3.493 (7 × 499)', r.simulado === true && r.persona === 'Franco' && r.bolsillo === 'ARS Mercado Pago' && r.acreditadas === 7 && Number(r.monto) === 3493 && r.detalle.every((d) => d.resultado === 'se_acreditaria'), JSON.stringify(r));
  check('…y NO escribe nada: ni filas, ni libro, ni saldo', (await nFilas(db)) === 0 && (await nLibro(db)) === 0 && (await saldo(db)) === 0);
}
{ // acreditar
  const { db } = await baseNueva();
  const r = await acr(db, ops(7));
  check('Acreditar 7 bonificaciones de $499: entran exactamente $3.493 a la caja, 7 filas y 7 entradas con clave meli-flex-<código>', r.acreditadas === 7 && Number(r.monto) === 3493 && (await saldo(db)) === 3493 && (await nFilas(db)) === 7 && (await nLibro(db)) === 7);
  check('El libro y la caja cuadran; la clave de cada entrada es la que usa el adelanto', (await cuadra(db)) && (await q(db, `SELECT count(*)::int n FROM public.caja_ledger WHERE clave = 'meli-flex-cashback_0003'`))[0].n === 1);
  const r2 = await acr(db, ops(7));
  check('Repetir la misma llamada NO mueve nada: 0 acreditadas, 7 «ya_acreditada», saldo igual', r2.acreditadas === 0 && r2.ya_acreditadas === 7 && (await saldo(db)) === 3493 && (await nLibro(db)) === 7);
  const r3 = await acr(db, ops(8));
  check('Mezcla: 7 ya acreditadas + 1 nueva → entra solo la nueva ($499)', r3.acreditadas === 1 && r3.ya_acreditadas === 7 && (await saldo(db)) === 3992 && (await nFilas(db)) === 8);
  check('Los datos quedan: usuario, cuenta y fecha', (await q(db, `SELECT acreditado_por, cuenta_id, acreditado_en IS NOT NULL ok FROM public.meli_flex_bonificaciones LIMIT 1`)).every((x) => x.ok && x.acreditado_por && x.cuenta_id));
}
{ // todo o nada y otros montos
  const { db } = await baseNueva();
  await acr(db, ops(2));
  const e1 = await falla(() => acr(db, [{ referencia: 'cashback_0001', monto: 500 }, ...ops(3, 10)], null, true));
  check('Una referencia ya acreditada con OTRO monto → REFERENCIA_CON_OTRO_MONTO y no entra NINGUNA de las demás (todo o nada)', /REFERENCIA_CON_OTRO_MONTO/.test(String(e1)) && (await nFilas(db)) === 2 && (await saldo(db)) === 998, String(e1));
  const e2 = await falla(() => acr(db, [{ referencia: 'cashback_0050', monto: 450 }]));
  check('Un monto distinto de $499 se frena (MONTO_FLEX_INUSUAL) y no mueve plata', /MONTO_FLEX_INUSUAL/.test(String(e2)) && (await saldo(db)) === 998);
  const r = await acr(db, [{ referencia: 'cashback_0050', monto: 450 }], null, true);
  check('Con la confirmación expresa (p_otros_montos) el monto distinto entra', r.acreditadas === 1 && (await saldo(db)) === 1448);
  const e3 = await falla(() => acr(db, [{ referencia: 'cashback_0001', monto: 499 }, { referencia: 'cashback_0001', monto: 499 }]));
  check('Operaciones repetidas en la misma llamada → OPERACIONES_REPETIDAS', /OPERACIONES_REPETIDAS/.test(String(e3)));
}
{ // validaciones de formato
  const { db } = await baseNueva();
  const malos = [
    [{ referencia: 'cashback 1', monto: 499 }], [{ referencia: "x'; DROP TABLE cajas;--", monto: 499 }], [{ referencia: '', monto: 499 }], [{ monto: 499 }],
    [{ referencia: 'ok_1', monto: 0 }], [{ referencia: 'ok_1', monto: -499 }], [{ referencia: 'ok_1', monto: 499.123 }], [{ referencia: 'ok_1', monto: 'mil' }], [{ referencia: 'ok_1' }],
    [{ referencia: 'ok_1', monto: 499, orden: 'abc' }], ['texto'], [null],
  ];
  const res = []; for (const m of malos) res.push(await falla(() => acr(db, m, null, true)));
  check('Referencias o montos mal formados (espacios, inyección, vacío, cero, negativo, 3 decimales, texto, orden no numérica) → OPERACION_INVALIDA', res.every((x) => /OPERACION_INVALIDA/.test(String(x))), JSON.stringify(res));
  check('Lista vacía, no es lista, o más de 200 → OPERACIONES_INVALIDAS', (await Promise.all([[], { a: 1 }, ops(201)].map((o) => falla(() => acr(db, o))))).every((x) => /OPERACIONES_INVALIDAS/.test(String(x))));
  check('Tope de $100.000 por llamada → TOTAL_EXCESIVO', /TOTAL_EXCESIVO/.test(String(await falla(() => acr(db, [{ referencia: 'grande', monto: 100000.01 }], null, true)))));
  check('Nada de lo anterior movió plata ni dejó filas', (await saldo(db)) === 0 && (await nFilas(db)) === 0 && (await nLibro(db)) === 0);
  check('Un monto con coma decimal real (499.5) pasa el formato pero necesita confirmación (inusual)', /MONTO_FLEX_INUSUAL/.test(String(await falla(() => acr(db, [{ referencia: 'ok_2', monto: 499.5 }])))));
}
{ // adelanto: un solo camino por código
  const { db, cuentaId } = await baseNueva();
  const r = (await q(db, `SELECT public.meli_adelanto_registrar($1,$2,$3,$4::jsonb,'prueba',$5) r`, ['2026-11-03T15:08:00-03:00', 998, 10, JSON.stringify([{ tipo: 'flex', referencia: 'cashback_A1', monto: 499 }, { tipo: 'flex', referencia: 'cashback_A2', monto: 499 }]), cuentaId]))[0].r;
  const e = await falla(() => acr(db, [{ referencia: 'cashback_A1', monto: 499 }, ...ops(1, 77)]));
  check('Un código que ya está en un ADELANTO se frena (REFERENCIA_EN_ADELANTO): no se acredita por dos caminos y no entra ninguno de la lista', /REFERENCIA_EN_ADELANTO/.test(String(e)) && (await saldo(db)) === 0 && (await nFilas(db)) === 0, String(e));
  // Camino inverso: acreditada suelta y DESPUÉS registrada en un adelanto: el disparador lo frena al registrar (antes solo lo cuidaba la clave de caja compartida).
  await acr(db, [{ referencia: 'cashback_B1', monto: 499 }]);
  const eInv = await falla(() => q(db, `SELECT public.meli_adelanto_registrar($1,$2,$3,$4::jsonb,'prueba',$5) r`, ['2026-11-04T15:08:00-03:00', 499, 0.01, JSON.stringify([{ tipo: 'flex', referencia: 'cashback_B1', monto: 499 }]), cuentaId]));
  check('Camino inverso: acreditada suelta y luego incluida en un adelanto → se frena al registrar (REFERENCIA_YA_ACREDITADA_SUELTA); la plata entró UNA sola vez', /REFERENCIA_YA_ACREDITADA_SUELTA/.test(String(eInv)) && (await saldo(db)) === 499 && (await nLibro(db)) === 1, String(eInv));
  void r;
}
{ // libro
  const { db, pid } = await baseNueva();
  await q(db, `INSERT INTO public.caja_ledger (persona_id, persona, bolsillo, delta, saldo_post, tipo, clave) VALUES ($1,'Franco','ARS Mercado Pago',499,499,'meli','meli-flex-cashback_L1')`, [pid]);
  await q(db, `UPDATE public.cajas SET saldo = 499 WHERE bolsillo='ARS Mercado Pago'`);
  const e = await falla(() => acr(db, [{ referencia: 'cashback_L1', monto: 499 }]));
  check('Si la clave YA está en el libro de cajas por otro motivo → REFERENCIA_YA_EN_CAJA (no se duplica ni se asume nada)', /REFERENCIA_YA_EN_CAJA/.test(String(e)) && (await saldo(db)) === 499 && (await nFilas(db)) === 0, String(e));
}
{ // órdenes informadas
  const ctx = await baseNueva({ cuentas: 2 }); const { db, cuentas } = ctx;
  const ordenPropia = await orden(db, cuentas[0]), ordenAjena = await orden(db, cuentas[1]);
  const e1 = await falla(() => acr(db, [{ referencia: 'cashback_O1', monto: 499, orden: '1234567' }], cuentas[0]));
  check('Una orden informada que no existe → ORDEN_INEXISTENTE', /ORDEN_INEXISTENTE/.test(String(e1)));
  const e2 = await falla(() => acr(db, [{ referencia: 'cashback_O1', monto: 499, orden: ordenAjena }], cuentas[0]));
  check('Una orden de OTRA cuenta → ORDEN_DE_OTRA_CUENTA', /ORDEN_DE_OTRA_CUENTA/.test(String(e2)));
  const r = await acr(db, [{ referencia: 'cashback_O1', monto: 499, orden: ordenPropia }], cuentas[0]);
  const est = (await q(db, `SELECT public.meli_flex_estado($1::text[]) r`, [[ordenPropia]]))[0].r;
  check('Con una orden de la cuenta entra, queda ligada a la orden (informativo) y meli_flex_estado la devuelve', r.acreditadas === 1 && est.length === 1 && est[0].orden === ordenPropia && est[0].referencia === 'cashback_O1' && Number(est[0].monto) === 499, JSON.stringify(est));
  check('meli_flex_estado sin filtro devuelve las últimas; con otra orden, ninguna', (await q(db, `SELECT public.meli_flex_estado(NULL) r`))[0].r.length === 1 && (await q(db, `SELECT public.meli_flex_estado($1::text[]) r`, [[ordenAjena]]))[0].r.length === 0);
  const e3 = await falla(() => acr(db, ops(1, 90)));
  check('Con DOS cuentas activas y sin indicar cuál → CUENTA_REQUERIDA (no se adivina la caja)', /CUENTA_REQUERIDA/.test(String(e3)), String(e3));
}
{ // cuentas
  const { db, cuentaId } = await baseNueva();
  await q(db, `UPDATE public.meli_cuentas SET bolsillo = NULL WHERE id = $1`, [cuentaId]);
  check('Una cuenta sin caja asignada → CUENTA_SIN_CAJA (o ninguna cuenta válida)', /CUENTA_SIN_CAJA|CUENTA_REQUERIDA/.test(String(await falla(() => acr(db, ops(1), cuentaId)))));
  await q(db, `UPDATE public.meli_cuentas SET bolsillo = 'ARS Mercado Pago', activa = false WHERE id = $1`, [cuentaId]);
  check('Una cuenta inactiva → CUENTA_INACTIVA', /CUENTA_INACTIVA/.test(String(await falla(() => acr(db, ops(1), cuentaId)))));
  check('Una cuenta inexistente → CUENTA_SIN_CAJA', /CUENTA_SIN_CAJA/.test(String(await falla(() => acr(db, ops(1), 99999)))));
}
{ // permisos
  const { db, cuentaId } = await baseNueva();
  await acr(db, ops(1));
  const esp = await esperadaPorDefecto(db);          // se arma ANTES: dentro de un rol del navegador la tabla de cuentas está cerrada
  const oP = await orden(db, cuentaId);
  const hP = await huellaActual(db);
  const acrP = (n) => acr(db, [{ referencia: 'cashback_P' + n, monto: 499, orden: oP }], null, false, false, esp, { crudo: true, huella: hP });
  const sinPermiso = (rol, email, fn) => falla(() => comoRol(db, rol, email, fn));
  check('Un usuario dado de baja no puede acreditar ni ver el estado', /no autorizado/.test(String(await sinPermiso('authenticated', 'baja@x.com', () => acrP(5)))) && /no autorizado/.test(String(await sinPermiso('authenticated', 'baja@x.com', () => q(db, `SELECT public.meli_flex_estado(NULL)`)))));
  check('anon no puede ejecutar nada', /permission denied/.test(String(await sinPermiso('anon', null, () => acrP(5)))) && /permission denied/.test(String(await sinPermiso('anon', null, () => q(db, `SELECT public.meli_flex_estado(NULL)`)))));
  check('Los roles de los agentes y service_role no pueden ejecutar las funciones', (await Promise.all(['agentes_ro', 'agentes_revisor', 'service_role'].map((r) => sinPermiso(r, 'franco@x.com', () => acrP(5))))).every((x) => /permission denied/.test(String(x))));
  check('La tabla está cerrada: ni anon ni authenticated ni los agentes pueden leerla ni escribirla', (await Promise.all(['anon', 'authenticated', 'agentes_ro', 'agentes_revisor', 'service_role'].flatMap((r) => [
    sinPermiso(r, 'franco@x.com', () => q(db, `SELECT * FROM public.meli_flex_bonificaciones`)), sinPermiso(r, 'franco@x.com', () => q(db, `INSERT INTO public.meli_flex_bonificaciones (referencia, cuenta_id, monto, acreditado_por) VALUES ('x',1,1,'x')`))]))).every((x) => /permission denied/.test(String(x))));
  check('Un usuario autorizado del CRM sí puede acreditar y ver el estado', (await comoRol(db, 'authenticated', 'franco@x.com', () => acrP(5))).acreditadas === 1 && (await comoRol(db, 'authenticated', 'franco@x.com', () => q(db, `SELECT public.meli_flex_estado(NULL) r`)))[0].r.length === 2);
  const src = SQL('meli_flex_bonificaciones.sql');
  const sinComentarios = src.replace(/--.*$/gm, '');
  const deletes = [...sinComentarios.matchAll(/\bDELETE\s+FROM\s+(\S+)([^;]*);/gi)];
  check('El script no hace UPDATE; los únicos DELETE son de sus tablas temporales y llevan WHERE (pg_safeupdate no tiene nada que frenar); escribe solo su tabla, la fila de la caja y el libro por la función de siempre',
    !/\bUPDATE\s/i.test(sinComentarios) && deletes.length > 0 && deletes.every((m) => /^_flex_/.test(m[1]) && /\bWHERE\b/i.test(m[2])) && /INSERT INTO public\.cajas/.test(src));
  check('Las dos copias del script (db/pendientes y db/para-correr/33_) son idénticas', (() => { try { return fs.readFileSync(path.join(AQUI, '../../db/para-correr/33_meli_flex_bonificaciones.sql'), 'utf8') === src; } catch { return false; } })());
}

{ // caja esperada: lo que se confirmó en pantalla es lo que se acredita
  const { db, pid, cuentaId } = await baseNueva();
  const plan = await acr(db, ops(2), cuentaId, false, true);
  check('La simulación devuelve persona_id y bolsillo (lo que la pantalla muestra y después exige)', plan.persona_id === pid && plan.bolsillo === 'ARS Mercado Pago', JSON.stringify(plan));
  const sin = await falla(() => acr(db, ops(2), cuentaId, false, false, null));
  check('Acreditar de verdad SIN mandar la caja esperada → CAJA_ESPERADA_REQUERIDA y no entra nada', /CAJA_ESPERADA_REQUERIDA/.test(String(sin)) && (await saldo(db)) === 0 && (await nFilas(db)) === 0, String(sin));
  // entre la simulación y la acreditación alguien reasigna la caja de la cuenta
  const { rows: [p2] } = await db.query(`INSERT INTO public.personas (nombre) VALUES ('Otra') RETURNING id`);
  await db.query(`INSERT INTO public.cajas (persona_id, bolsillo, saldo) VALUES ($1,'ARS Mercado Pago',0)`, [p2.id]);
  await db.query(`UPDATE public.meli_cuentas SET persona_id = $1 WHERE id = $2`, [p2.id, cuentaId]);
  const cambio = await falla(() => acr(db, ops(2), cuentaId, false, false, [plan.persona_id, plan.bolsillo]));
  check('Si la caja de la cuenta cambió después de la simulación → CAJA_CAMBIO: no entra NADA ni en la caja vieja ni en la nueva', /CAJA_CAMBIO/.test(String(cambio)) && (await nFilas(db)) === 0 && (await nLibro(db)) === 0, String(cambio));
  const simCambio = await falla(() => acr(db, ops(2), cuentaId, false, true, [plan.persona_id, plan.bolsillo]));
  check('También la simulación con la caja esperada vieja avisa CAJA_CAMBIO', /CAJA_CAMBIO/.test(String(simCambio)));
  const otroBolsillo = await falla(() => acr(db, ops(2), cuentaId, false, false, [p2.id, 'USD']));
  check('Un bolsillo esperado distinto → CAJA_CAMBIO', /CAJA_CAMBIO/.test(String(otroBolsillo)));
  const plan2 = await acr(db, ops(2), cuentaId, false, true);
  const ok2 = await acr(db, ops(2), cuentaId, false, false, [plan2.persona_id, plan2.bolsillo]);
  check('Con la caja nueva confirmada entra, en la caja nueva y solo ahí', ok2.acreditadas === 2 && (await q(db, `SELECT saldo::float s FROM public.cajas WHERE persona_id = $1`, [p2.id]))[0].s === 998 && (await saldo(db)) === 0, JSON.stringify(ok2));
}
{ // flex-<orden>: carga por lista de órdenes (los 7 casos de la prueba real = $3.493)
  const { db, cuentaId } = await baseNueva();
  const os = []; for (let i = 0; i < 7; i++) os.push(await orden(db, cuentaId));
  const lista = os.map((o) => ({ referencia: 'flex-' + o, monto: 499, orden: o }));
  const plan = await acr(db, lista, cuentaId, false, true);
  check('7 órdenes por lista (flex-<orden>, $499): la simulación muestra 7 y $3.493 antes de confirmar y no escribe', plan.acreditadas === 7 && Number(plan.monto) === 3493 && (await nFilas(db)) === 0 && (await saldo(db)) === 0, JSON.stringify(plan));
  const real = await acr(db, lista, cuentaId, false, false, [plan.persona_id, plan.bolsillo]);
  check('Confirmada: entran $3.493, 7 filas ligadas a su orden, clave meli-flex-flex-<orden> única en el libro, la caja cuadra', real.acreditadas === 7 && (await saldo(db)) === 3493 && (await nFilas(db)) === 7 && (await nLibro(db)) === 7 && (await cuadra(db)) && (await q(db, `SELECT count(*)::int n FROM public.meli_flex_bonificaciones WHERE referencia = 'flex-' || orden_id`))[0].n === 7);
  const rep = await acr(db, lista, cuentaId, false, false, [plan.persona_id, plan.bolsillo]);
  check('Repetir la lista no mueve nada (7 ya acreditadas)', rep.acreditadas === 0 && rep.ya_acreditadas === 7 && (await saldo(db)) === 3493);
  const mal = await falla(() => acr(db, [{ referencia: 'flex-' + os[0], monto: 499, orden: os[1] }], cuentaId));
  const sinO = await falla(() => acr(db, [{ referencia: 'flex-' + os[0], monto: 499 }], cuentaId));
  check('flex-<orden> exige que la orden informada sea exactamente esa (sin orden o con otra → OPERACION_INVALIDA)', /OPERACION_INVALIDA/.test(String(mal)) && /OPERACION_INVALIDA/.test(String(sinO)));
  // una sola bonificación suelta por orden: un código distinto para la misma venta se frena
  const dos = await falla(() => acr(db, [{ referencia: 'cashback_OTRO', monto: 499, orden: os[0] }], cuentaId));
  check('Otra referencia (cashback_…) para una orden que ya tiene su bonificación → ORDEN_CON_OTRA_BONIFICACION (no entra dos veces la misma venta)', /ORDEN_CON_OTRA_BONIFICACION/.test(String(dos)) && (await saldo(db)) === 3493, String(dos));
  const ya = await falla(() => acr(db, [{ referencia: 'cashback_X1', monto: 499, orden: os[2] }, { referencia: 'cashback_X2', monto: 499, orden: os[2] }], cuentaId));
  check('Dos referencias para la misma orden en una llamada → ORDENES_REPETIDAS', /ORDENES_REPETIDAS/.test(String(ya)));
  const e = await falla(() => acr(db, [{ referencia: 'flex-1234567', monto: 499, orden: '1234567' }], cuentaId));
  check('flex-<orden> de una orden que no existe → ORDEN_INEXISTENTE', /ORDEN_INEXISTENTE/.test(String(e)));
}
{ // disparador: registrar un adelanto con una bonificación ya acreditada suelta se frena (exclusión de los dos caminos)
  const { db, cuentaId } = await baseNueva();
  await acr(db, [{ referencia: 'cashback_T1', monto: 499 }], cuentaId);
  const e = await falla(() => q(db, `SELECT public.meli_adelanto_registrar($1,$2,$3,$4::jsonb,'prueba',$5)`, ['2026-11-04T15:08:00-03:00', 499, 0.01, JSON.stringify([{ tipo: 'flex', referencia: 'cashback_T1', monto: 499 }]), cuentaId]));
  check('Registrar un adelanto con un código ya acreditado suelto → REFERENCIA_YA_ACREDITADA_SUELTA (nada se registra)', /REFERENCIA_YA_ACREDITADA_SUELTA/.test(String(e)) && (await q(db, `SELECT count(*)::int n FROM public.meli_adelantos`))[0].n === 0, String(e));
  const ok3 = await falla(() => q(db, `SELECT public.meli_adelanto_registrar($1,$2,$3,$4::jsonb,'prueba',$5)`, ['2026-11-04T15:08:00-03:00', 499, 0.01, JSON.stringify([{ tipo: 'flex', referencia: 'cashback_T2', monto: 499 }]), cuentaId]));
  check('Un código que NO se acreditó suelto sigue pudiendo registrarse en un adelanto', ok3 === null, String(ok3));
  check('El disparador no es ejecutable por el navegador', !(await q(db, `SELECT has_function_privilege('authenticated','public.meli_flex_ref_en_adelanto()','EXECUTE') x`))[0].x);
}

{ // identidad por ORDEN: sin orden no entra nada; reintento con otra orden no se acepta; confirmación de «no está en un adelanto»
  const { db, cuentaId } = await baseNueva();
  const o1 = await orden(db, cuentaId), o2 = await orden(db, cuentaId);
  const sinOrden = await falla(() => acr(db, [{ referencia: 'cashback_S1', monto: 499 }], cuentaId, false, false, undefined, { crudo: true }));
  check('Una operación SIN orden (aunque sea un código cashback_…) → OPERACION_INVALIDA: la identidad de la bonificación es la venta y no queda forma de entrar dos veces con dos nombres', /OPERACION_INVALIDA/.test(String(sinOrden)) && (await saldo(db)) === 0 && (await nFilas(db)) === 0, String(sinOrden));
  const sinConf = await falla(() => acr(db, [{ referencia: 'flex-' + o1, monto: 499, orden: o1 }], cuentaId, false, false, undefined, { crudo: true, sinAdelanto: false }));
  check('Sin confirmar que NO está ya dentro de un adelanto no se acredita nada nuevo (ADELANTO_NO_VERIFICADO)', /ADELANTO_NO_VERIFICADO/.test(String(sinConf)) && (await saldo(db)) === 0, String(sinConf));
  const plan = await acr(db, [{ referencia: 'flex-' + o1, monto: 499, orden: o1 }], cuentaId, false, true);
  check('La simulación NO exige esa confirmación e informa cuántas bonificaciones y qué monto ya hay en adelantos (en_adelantos)', plan.acreditadas === 1 && plan.en_adelantos && Number(plan.en_adelantos.cantidad) === 0, JSON.stringify(plan));
  await acr(db, [{ referencia: 'flex-' + o1, monto: 499, orden: o1 }], cuentaId, false, false, [plan.persona_id, plan.bolsillo], { crudo: true });
  const rep = await acr(db, [{ referencia: 'flex-' + o1, monto: 499, orden: o1 }], cuentaId, false, false, [plan.persona_id, plan.bolsillo], { crudo: true, sinAdelanto: false });
  check('Repetir una bonificación YA acreditada no pide la confirmación (no mueve nada)', rep.acreditadas === 0 && rep.ya_acreditadas === 1 && (await saldo(db)) === 499);
  // mismo código pero otra orden: no es la misma bonificación
  const otraOrden = await falla(() => acr(db, [{ referencia: 'flex-' + o1, monto: 499, orden: o2 }], cuentaId, false, false, undefined, { crudo: true }));
  const otraOrden2 = await falla(() => acr(db, [{ referencia: 'cashback_Z9', monto: 499, orden: o1 }], cuentaId, false, false, undefined, { crudo: true }));
  check('Un código ya acreditado reintentado con OTRA orden, y otro código para la orden ya acreditada, se frenan (OPERACION_INVALIDA / ORDEN_CON_OTRA_BONIFICACION)', /OPERACION_INVALIDA|REFERENCIA_CON_OTRA_ORDEN/.test(String(otraOrden)) && /ORDEN_CON_OTRA_BONIFICACION/.test(String(otraOrden2)) && (await saldo(db)) === 499, JSON.stringify([otraOrden, otraOrden2]));
  const cc = await acr(db, [{ referencia: 'cashback_Q1', monto: 499, orden: o2 }], cuentaId, false, false, undefined);
  const otra = await falla(() => acr(db, [{ referencia: 'cashback_Q1', monto: 499, orden: o1 }], cuentaId, false, false, undefined, { crudo: true }));
  check('Un código ya acreditado para una orden y reintentado informando OTRA orden → REFERENCIA_CON_OTRA_ORDEN (la base no lo da por «ya acreditado»)', cc.acreditadas === 1 && /REFERENCIA_CON_OTRA_ORDEN|ORDEN_CON_OTRA_BONIFICACION/.test(String(otra)), String(otra));
}
{ // el disparador toma los bloqueos en orden y no se rompe con varias bonificaciones en un mismo adelanto
  const { db, cuentaId } = await baseNueva();
  const e = await falla(() => q(db, `SELECT public.meli_adelanto_registrar($1,$2,$3,$4::jsonb,'prueba',$5)`, ['2026-11-04T15:08:00-03:00', 1497, 0.01, JSON.stringify([{ tipo: 'flex', referencia: 'cashback_B', monto: 499 }, { tipo: 'flex', referencia: 'cashback_A', monto: 499 }, { tipo: 'flex', referencia: 'cashback_C', monto: 499 }]), cuentaId]));
  check('Registrar un adelanto con varias bonificaciones en cualquier orden funciona (disparador por sentencia)', e === null, String(e));
  const plan = await acr(db, [{ referencia: 'cashback_N1', monto: 499, orden: await orden(db, cuentaId) }], cuentaId, false, true);
  check('La simulación informa las 3 bonificaciones que ya hay en adelantos ($1.497) y el DETALLE identificable (código, monto, adelanto) para contrastarlo', Number(plan.en_adelantos.cantidad) === 3 && Number(plan.en_adelantos.monto) === 1497 && plan.en_adelantos.lista.length === 3 && plan.en_adelantos.lista.every((x) => /^cashback_[ABC]$/.test(x.referencia) && Number(x.monto) === 499 && x.adelanto_id), JSON.stringify(plan.en_adelantos));
}

{ // lista de adelantos truncada: hay más de 2000 → se avisa
  const { db, cuentaId } = await baseNueva();
  const { rows: [a] } = await db.query(`INSERT INTO public.meli_adelantos (fecha, cuenta_id, total_adelantado, costo, recibido, creado_por) VALUES (now(), $1, 1000, 0, 1000, 'x') RETURNING id`, [cuentaId]);
  await db.query(`INSERT INTO public.meli_adelanto_ops (adelanto_id, tipo, referencia, monto) SELECT $1, 'flex', 'cashback_' || g, 499 FROM generate_series(1, 2001) g`, [a.id]);
  const plan = await acr(db, [{ referencia: 'cashback_NUEVO', monto: 499 }], cuentaId, false, true);
  check('Con más de 2.000 bonificaciones en adelantos la simulación devuelve 2.000 y marca truncada = true (para que la pantalla no deje confirmar)', Number(plan.en_adelantos.cantidad) === 2001 && plan.en_adelantos.lista.length === 2000 && plan.en_adelantos.truncada === true, JSON.stringify({ c: plan.en_adelantos.cantidad, l: plan.en_adelantos.lista.length, t: plan.en_adelantos.truncada }));
  const chico = await baseNueva();
  const p2 = await acr(chico.db, [{ referencia: 'cashback_NUEVO', monto: 499 }], chico.cuentaId, false, true);
  check('Con pocas (o ninguna) no está truncada', p2.en_adelantos.truncada === false);
}

{ // huella de adelantos: si entre la revisión y la acreditación se registró un adelanto, hay que revisar de nuevo
  const { db, cuentaId } = await baseNueva();
  const o1 = await orden(db, cuentaId);
  const plan = await acr(db, [{ referencia: 'flex-' + o1, monto: 499, orden: o1 }], cuentaId, false, true);
  check('La simulación devuelve la huella de los adelantos (texto)', typeof plan.en_adelantos.huella === 'string' && plan.en_adelantos.huella.length === 32, JSON.stringify(plan.en_adelantos));
  await q(db, `SELECT public.meli_adelanto_registrar($1,$2,$3,$4::jsonb,'prueba',$5)`, ['2026-11-04T15:08:00-03:00', 499, 0.01, JSON.stringify([{ tipo: 'flex', referencia: 'cashback_NUEVO1', monto: 499 }]), cuentaId]);
  const e = await falla(() => acr(db, [{ referencia: 'flex-' + o1, monto: 499, orden: o1 }], cuentaId, false, false, [plan.persona_id, plan.bolsillo], { crudo: true, huella: plan.en_adelantos.huella }));
  check('Con la huella vieja (se registró un adelanto mientras tanto) → ADELANTOS_CAMBIARON y no entra nada', /ADELANTOS_CAMBIARON/.test(String(e)) && (await saldo(db)) === 0 && (await nFilas(db)) === 0, String(e));
  const sinH = await falla(() => acr(db, [{ referencia: 'flex-' + o1, monto: 499, orden: o1 }], cuentaId, false, false, [plan.persona_id, plan.bolsillo], { crudo: true, huella: null }));
  check('Sin huella tampoco se acredita nada nuevo', /ADELANTOS_CAMBIARON/.test(String(sinH)) && (await saldo(db)) === 0, String(sinH));
  const plan2 = await acr(db, [{ referencia: 'flex-' + o1, monto: 499, orden: o1 }], cuentaId, false, true);
  const ok2 = await acr(db, [{ referencia: 'flex-' + o1, monto: 499, orden: o1 }], cuentaId, false, false, [plan2.persona_id, plan2.bolsillo], { crudo: true, huella: plan2.en_adelantos.huella });
  check('Con la huella nueva (revisando de nuevo) entra', ok2.acreditadas === 1 && (await saldo(db)) === 499);
  const rep2 = await acr(db, [{ referencia: 'flex-' + o1, monto: 499, orden: o1 }], cuentaId, false, false, [plan2.persona_id, plan2.bolsillo], { crudo: true, huella: 'cualquiera' });
  check('Repetir una bonificación ya acreditada no exige huella vigente (no mueve nada)', rep2.acreditadas === 0 && rep2.ya_acreditadas === 1);
}
{ // meli_flex_estado con una lista de órdenes devuelve TODAS las pedidas (sin el tope de 500)
  const { db, cuentaId } = await baseNueva();
  await q(db, `INSERT INTO public.meli_flex_bonificaciones (referencia, cuenta_id, orden_id, monto, acreditado_por) SELECT 'flex-' || (9000000000000 + g), $1, (9000000000000 + g)::text, 499, 'x' FROM generate_series(1, 700) g`, [cuentaId]);
  const pedidas = Array.from({ length: 700 }, (_, i) => String(9000000000000 + i + 1));
  const todas = (await q(db, `SELECT public.meli_flex_estado($1::text[]) r`, [pedidas]))[0].r;
  const sin = (await q(db, `SELECT public.meli_flex_estado(NULL) r`))[0].r;
  check('Con 700 órdenes pedidas devuelve las 700 (antes se cortaba en 500); sin lista, las últimas 500', todas.length === 700 && sin.length === 500, `${todas.length} ${sin.length}`);
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
