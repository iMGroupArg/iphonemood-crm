// Banco de pruebas de db/pendientes/meli_adelantos.sql (script 27): acreditar por adelanto de Mercado Pago. Base y helpers copiados de meli.sql.test.mjs.
// (Original: Banco de pruebas del SQL de Mercado Libre → Ventas y Cajas
// (db/pendientes/meli_ventas_migration.sql) contra un Postgres REAL (pglite).
//
// Carga los TRES archivos reales, en el orden en que se van a correr:
//   caja_aplicar_delta.sql → meli_esquema_base.sql → meli_vincular.sql → meli_ventas_migration.sql
// sobre un esquema mínimo que imita el de producción (stock, ventas, venta_items,
// venta_pagos, cajas, caja_ledger, personas).
//
//   cd tests/sql && node meli_adelantos.sql.test.mjs
//
// NO cubre dos conexiones simultáneas (pglite tiene una sola): los bloqueos de fila
// dependen de Postgres y hay que probarlos con dos sesiones antes de producción.
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

async function baseNueva() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
      $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    CREATE TABLE public.personas (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre TEXT NOT NULL);
    CREATE TABLE public.cajas (id BIGSERIAL PRIMARY KEY, persona_id UUID REFERENCES public.personas(id),
      bolsillo TEXT NOT NULL, saldo NUMERIC(18,2) NOT NULL DEFAULT 0, actualizado_en TIMESTAMPTZ DEFAULT now());
    CREATE TABLE public.usuarios_autorizados (email TEXT PRIMARY KEY, activo BOOLEAN DEFAULT true);
    CREATE OR REPLACE FUNCTION public.is_authorized_user() RETURNS boolean
    LANGUAGE sql SECURITY DEFINER STABLE AS $$
      SELECT EXISTS (SELECT 1 FROM public.usuarios_autorizados
                      WHERE email = (auth.jwt() ->> 'email') AND activo = true) $$;
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
  await db.exec(SQL('caja_aplicar_delta.sql'));
  await db.exec(SQL('meli_esquema_base.sql'));
  await db.exec(SQL('meli_vincular.sql'));       // script 7: vínculos publicación ↔ stock (da meli__revalidar_orden)
  await db.exec(SQL('meli_ventas_migration.sql'));
  await db.exec(SQL('meli_adelantos.sql'));
  await db.exec(`SELECT set_config('request.jwt.claims', '{"email":"franco@x.com"}', false)`);

  const { rows: [p] } = await db.query(`INSERT INTO public.personas (nombre) VALUES ('Franco') RETURNING id`);
  await db.query(`INSERT INTO public.cajas (persona_id, bolsillo, saldo) VALUES ($1,'ARS Mercado Pago',0)`, [p.id]);
  await db.query(`INSERT INTO public.caja_ledger (persona_id, persona, bolsillo, delta, saldo_post, tipo)
                  SELECT persona_id, 'Franco', bolsillo, saldo, saldo, 'saldo_inicial' FROM public.cajas`);
  const { rows: [c] } = await db.query(
    `INSERT INTO public.meli_cuentas (meli_user_id, nickname, persona_id, bolsillo) VALUES ('999','FRANCO',$1,'ARS Mercado Pago') RETURNING id`, [p.id]);
  return { db, pid: p.id, cuentaId: c.id };
}

let seq = 0;
// Una orden ya ingresada: pagada, completa, liberada, con sus ítems. `opts` pisa lo que haga falta.
async function nuevaOrden(ctx, { items = [{ cant: 1, precio: 100000, stock: {} }], bruto, neto = 85000, opts = {} } = {}) {
  const { db, cuentaId } = ctx;
  const stocks = [];
  for (const it of items) {
    const { rows: [s] } = await db.query(
      `INSERT INTO public.stock (nombre, categoria, cantidad, imeis, estado_inventario, costo_usd)
       VALUES ($1,'perfumeria',$2,$3,'disponible',$4) RETURNING id`,
      [it.stock.nombre || 'Perfume X 100ml', it.stock.cantidad ?? 5, it.stock.imeis || [], it.stock.costo ?? 30]);
    stocks.push(s.id);
  }
  const total = bruto ?? items.reduce((a, i) => a + i.cant * i.precio, 0);
  const o = { estado: 'paid', moneda: 'ARS', comprador: 'comprador1', revisar: false, financiera_completa: true,
              fecha_liberacion: "now() - interval '1 day'", ...opts };
  const { rows: [r] } = await db.query(
    `INSERT INTO public.meli_ordenes (cuenta_id, meli_order_id, estado, comprador, fecha_orden, moneda, bruto, neto, comision_envio,
        pago_id, fecha_liberacion, revisar, financiera_completa, neto_confirmado)
     VALUES ($1,$2,$3,$4, now(), $5, $6::numeric, $7::numeric, $6::numeric - $7::numeric, 'p1', ${o.fecha_liberacion}, $8, $9, $7::numeric) RETURNING id`,
    [cuentaId, `ORD-${++seq}`, o.estado, o.comprador, o.moneda, total, neto, o.revisar, o.financiera_completa]);
  for (let i = 0; i < items.length; i++) {
    await db.query(`INSERT INTO public.meli_orden_items (orden_id, meli_item_id, titulo, cantidad, precio_unitario, stock_id)
                    VALUES ($1,$2,'t',$3,$4,$5)`, [r.id, `MLA${i}`, items[i].cant, items[i].precio, stocks[i]]);
    // El vínculo VIGENTE (lo que procesar relee): sin él, revalidar dejaría el ítem sin vincular.
    if (!opts.sinVinculo) {
      await db.query(`INSERT INTO public.meli_publicaciones (cuenta_id, meli_item_id, meli_variacion_id, stock_id)
                      VALUES ($1,$2,NULL,$3) ON CONFLICT DO NOTHING`, [cuentaId, `MLA${i}`, stocks[i]]);
    }
  }
  return { id: r.id, stocks, total };
}
const procesar = (db, id, cot = 1000) => db.query(`SELECT public.meli_procesar_orden($1,$2) AS r`, [id, cot]).then(x => x.rows[0].r);
const acreditar = (db, id, monto = null, fin = false) => db.query(`SELECT public.meli_acreditar_orden($1,$2,$3) AS r`, [id, monto, fin]).then(x => x.rows[0].r);
const revertir = (db, id, m = 'cancelada') => db.query(`SELECT public.meli_revertir_orden($1,$2) AS r`, [id, m]).then(x => x.rows[0].r);
const caja = async db => Number((await db.query(`SELECT saldo FROM cajas WHERE bolsillo='ARS Mercado Pago'`)).rows[0].saldo);
const cuadra = async db => {
  const { rows } = await db.query(`SELECT (c.saldo - coalesce(l.suma,0))::float AS dif FROM cajas c JOIN personas p ON p.id=c.persona_id
    LEFT JOIN (SELECT persona,bolsillo,sum(delta) suma FROM caja_ledger GROUP BY 1,2) l ON l.persona=p.nombre AND l.bolsillo=c.bolsillo`);
  return rows.every(r => Math.abs(r.dif) < 0.005);
};


const SCRIPT = SQL('meli_adelantos.sql');
const q = (db, sql, args = []) => db.query(sql, args).then((x) => x.rows);
const comoRol = async (db, rol, email, fn) => {
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [email ? JSON.stringify({ email }) : '{}']);
  await db.query(`SET ROLE ${rol}`);
  try { return await fn(); } finally { await db.query('RESET ROLE'); await db.query(`SELECT set_config('request.jwt.claims', '{"email":"franco@x.com"}', false)`); }
};
// Orden con número de Mercado Libre (solo dígitos), liberación en el FUTURO, procesada o no.
async function ordenAdel(ctx, { neto = 40000, procesada = true, libera = '10 days' } = {}) {
  const o = await nuevaOrden(ctx, { items: [{ cant: 1, precio: neto + 5000, stock: { cantidad: 5 } }], neto, opts: { fecha_liberacion: `now() + interval '${libera}'` } });
  const { rows: [r] } = await ctx.db.query(`UPDATE public.meli_ordenes SET meli_order_id = (5000000000000 + id)::text WHERE id = $1 RETURNING meli_order_id`, [o.id]);
  if (procesada) await procesar(ctx.db, o.id, 1650);
  return { id: o.id, orden: r.meli_order_id, neto };
}
const reg = (db, total, costo, ops, fecha = '2026-11-03T15:08:00-03:00') => q(db, `SELECT public.meli_adelanto_registrar($1,$2,$3,$4::jsonb,'prueba') r`, [fecha, total, costo, JSON.stringify(ops)]).then((x) => x[0].r);
const acr = (db, id, flex = false) => q(db, `SELECT public.meli_adelanto_acreditar($1,$2) r`, [id, flex]).then((x) => x[0].r);
const est = (db, id = null) => q(db, `SELECT public.meli_adelanto_estado($1) r`, [id]).then((x) => x[0].r);
const pago = (o, monto = o.neto) => ({ tipo: 'pago', orden: o.orden, monto });
const flex = (ref, monto = 499) => ({ tipo: 'flex', referencia: ref, monto });

console.log('\n══ Acreditar por adelanto de Mercado Pago (Postgres en WebAssembly) ══\n');
{
  const ctx = await baseNueva(); const { db } = ctx;
  check('El script corre dos veces más sin romper (idempotente)', !(await falla(() => db.exec(SCRIPT))) && !(await falla(() => db.exec(SCRIPT))));
  const res = await db.exec(SCRIPT); const t = res[res.length - 1].rows;
  check('La verificación sale toda en ✅ (3 controles)', t.length === 3 && t.every((x) => x.resultado === '✅'), JSON.stringify(t));
  const vacia = new PGlite({ extensions: { pgcrypto } }); await vacia.exec(`CREATE TABLE public.meli_ordenes (id BIGSERIAL PRIMARY KEY)`);
  check('Sin los scripts 3 y 4 frena con un mensaje claro', (await falla(() => vacia.exec(SCRIPT)))?.includes('Faltan los scripts 3 y 4'));
}
{ // validaciones del registro
  const ctx = await baseNueva(); const { db } = ctx;
  const a = await ordenAdel(ctx), b = await ordenAdel(ctx, { neto: 41000 });
  const ok2 = [pago(a), pago(b)];
  const e = (fn) => falla(fn);
  check('Suma que no cierra → SUMA_NO_CIERRA con la diferencia', /SUMA_NO_CIERRA/.test(String(await e(() => reg(db, 81001, 100, ok2)))) , '');
  check('Costo mayor o igual al total → COSTO_INVALIDO', /COSTO_INVALIDO/.test(String(await e(() => reg(db, 81000, 81000, ok2)))));
  check('Costo negativo o con más de 2 decimales → COSTO_INVALIDO', /COSTO_INVALIDO/.test(String(await e(() => reg(db, 81000, -1, ok2)))) && /COSTO_INVALIDO/.test(String(await e(() => reg(db, 81000, 1.005, ok2)))));
  check('Total inválido', /TOTAL_INVALIDO/.test(String(await e(() => reg(db, 0, 0, ok2)))));
  check('Fecha futura', /FECHA_INVALIDA/.test(String(await e(() => reg(db, 81000, 100, ok2, '2099-01-01T00:00:00Z')))));
  check('Sin operaciones o no es un arreglo', /OPERACIONES_INVALIDAS/.test(String(await e(() => reg(db, 81000, 100, [])))) && /OPERACIONES_INVALIDAS/.test(String(await e(() => q(db, `SELECT public.meli_adelanto_registrar(now(), 100, 1, '{"a":1}'::jsonb)`)))));
  check('Operación mal formada (monto negativo, tipo raro, orden con letras)', /OPERACION_INVALIDA/.test(String(await e(() => reg(db, 81000, 100, [pago(a, -1), pago(b)])))) && /OPERACION_INVALIDA/.test(String(await e(() => reg(db, 81000, 100, [{ tipo: 'otro', orden: a.orden, monto: 1 }])))) && /OPERACION_INVALIDA/.test(String(await e(() => reg(db, 81000, 100, [{ tipo: 'pago', orden: 'abc', monto: 1 }])))));
  check('Operaciones repetidas en la misma carga', /OPERACIONES_REPETIDAS/.test(String(await e(() => reg(db, 80000, 100, [pago(a), pago(a)])))));
  check('Orden que no existe en el CRM → ORDEN_INEXISTENTE', /ORDEN_INEXISTENTE/.test(String(await e(() => reg(db, 81000, 100, [pago(a), { tipo: 'pago', orden: '9999999999', monto: 41000 }])))));
  const r = await reg(db, 81000, 100, ok2);
  check('Carga válida: queda registrado y recibido = total − costo', r.ok === true && Number(r.recibido) === 80900, JSON.stringify(r));
  check('El mismo adelanto no se puede cargar dos veces', /ADELANTO_YA_REGISTRADO|OPERACION_YA_EN_OTRO_ADELANTO/.test(String(await e(() => reg(db, 81000, 100, ok2)))));
  const c = await ordenAdel(ctx, { neto: 41000 });
  check('Una orden ya incluida en otro adelanto no entra a un segundo', /OPERACION_YA_EN_OTRO_ADELANTO/.test(String(await e(() => reg(db, 81000, 100, [pago(a), pago(c)], '2026-11-04T10:00:00-03:00')))));
  check('Solo usuarios autorizados', /no autorizado/.test(String(await e(() => comoRol(db, 'authenticated', 'baja@x.com', () => reg(db, 41000, 10, [pago(c)], '2026-11-05T10:00:00-03:00'))))));
  check('anon no puede llamar ninguna', /permission denied/i.test(String(await e(() => comoRol(db, 'anon', null, () => reg(db, 41000, 10, [pago(c)], '2026-11-05T10:00:00-03:00'))))) && /permission denied/i.test(String(await e(() => comoRol(db, 'anon', null, () => acr(db, 1))))));
  check('Las tablas no se leen ni se escriben desde el navegador', /permission denied/i.test(String(await e(() => comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`SELECT * FROM public.meli_adelantos`))))) && /permission denied/i.test(String(await e(() => comoRol(db, 'authenticated', 'franco@x.com', () => db.query(`INSERT INTO public.meli_adelanto_ops (adelanto_id,tipo,orden_id,monto) VALUES (1,'pago','x',1)`))))));
  check('El núcleo interno no es llamable desde el navegador', /permission denied/i.test(String(await e(() => comoRol(db, 'authenticated', 'franco@x.com', () => q(db, `SELECT public.meli__acreditar_por_adelanto(1, 1, 'x')`))))));
}
{ // flujo completo
  const ctx = await baseNueva(); const { db } = ctx;
  const a = await ordenAdel(ctx, { neto: 40000 }), b = await ordenAdel(ctx, { neto: 41000 }), c = await ordenAdel(ctx, { neto: 42000, procesada: false });
  const antes = await caja(db);
  const r = await reg(db, 123499, 600, [pago(a), pago(b), pago(c), flex('cashback_111')]);
  check('Registrar NO mueve plata', (await caja(db)) === antes);
  const x = await acr(db, r.adelanto_id);
  check('Acredita las 2 procesadas aunque su liberación sea futura y deja la no procesada como pendiente (ORDEN_NO_PROCESADA)',
    x.acreditadas === 2 && x.pendientes === 1 && Number(x.monto_acreditado) === 81000 && x.detalle.some((d) => d.resultado === 'pendiente' && d.motivo === 'ORDEN_NO_PROCESADA'), JSON.stringify(x));
  check('La caja de Mercado Pago sube exactamente lo acreditado (81.000)', (await caja(db)) === antes + 81000);
  const { rows: [oa] } = await db.query(`SELECT acreditado, monto_acreditado, acreditado_persona_id FROM public.meli_ordenes WHERE id=$1`, [a.id]);
  const { rows: [va] } = await db.query(`SELECT v.estado FROM public.ventas v JOIN public.meli_ordenes o ON o.venta_id=v.id WHERE o.id=$1`, [a.id]);
  const { rows: pg } = await db.query(`SELECT p.monto FROM public.venta_pagos p JOIN public.meli_ordenes o ON o.venta_id=p.venta_id WHERE o.id=$1`, [a.id]);
  check('La orden queda acreditada, la venta cerrada y con su pago en dólares a la cotización congelada (40000/1650)', oa.acreditado === true && Number(oa.monto_acreditado) === 40000 && va.estado === 'cerrada' && pg.length === 1 && Number(pg[0].monto) === 24.24, JSON.stringify([oa, va, pg]));
  check('Los saldos de las cajas cuadran con el libro', await cuadra(db));
  const x2 = await acr(db, r.adelanto_id);
  check('Repetir el botón NO duplica nada (0 nuevas) y la caja no cambia', x2.acreditadas === 0 && x2.pendientes === 1 && (await caja(db)) === antes + 81000, JSON.stringify(x2));
  await procesar(db, c.id, 1650);
  const x3 = await acr(db, r.adelanto_id);
  check('Procesada la que faltaba, el mismo botón la acredita', x3.acreditadas === 1 && x3.pendientes === 0 && (await caja(db)) === antes + 123000, JSON.stringify(x3));
  check('Sin flex pedido, la bonificación NO entra a la caja', x3.flex === 0 && (await caja(db)) === antes + 123000);
  const e1 = await est(db, r.adelanto_id);
  check('El estado muestra todas las operaciones con su resultado', e1.length === 1 && e1[0].ops.length === 4 && e1[0].ops.filter((o) => o.resultado === 'acreditada').length === 3 && Number(e1[0].recibido) === 122899, JSON.stringify(e1[0]).slice(0, 300));
  // la acreditación de siempre, ya en su fecha, NO mueve plata dos veces
  await db.query(`UPDATE public.meli_ordenes SET fecha_liberacion = now() - interval '1 day' WHERE id=$1`, [a.id]);
  const n = await acreditar(db, a.id);
  check('Después, la acreditación normal responde «ya acreditada» y la caja no se mueve', n.ya_acreditada === true && (await caja(db)) === antes + 123000, JSON.stringify(n));
  check('El ledger tiene UNA sola entrada por orden', (await q(db, `SELECT count(*)::int n FROM public.caja_ledger WHERE referencia=$1 AND tipo='meli'`, [a.orden]))[0].n === 1);
  check('Los saldos siguen cuadrando', await cuadra(db));
}
{ // flex
  const ctx = await baseNueva(); const { db } = ctx;
  const a = await ordenAdel(ctx, { neto: 40000 });
  const r = await reg(db, 40998, 100, [pago(a), flex('cashback_1'), flex('cashback_2')]);
  const antes = await caja(db);
  const x = await acr(db, r.adelanto_id, true);
  check('Con flex pedido entran las dos bonificaciones (998) y la orden (40.000), una vez cada una', x.flex === 2 && Number(x.monto_flex) === 998 && (await caja(db)) === antes + 40998, JSON.stringify(x));
  const x2 = await acr(db, r.adelanto_id, true);
  check('Repetir no duplica la bonificación', x2.flex === 0 && (await caja(db)) === antes + 40998);
  check('Los saldos cuadran', await cuadra(db));
  const ctx2 = await baseNueva(); const b = await ordenAdel(ctx2, { neto: 40000 });
  await ctx2.db.query(`INSERT INTO public.meli_cuentas (meli_user_id, nickname, persona_id, bolsillo) VALUES ('1000','OTRA',$1,'ARS Mercado Pago')`, [ctx2.pid]);
  const r2 = await reg(ctx2.db, 40499, 100, [pago(b), flex('cashback_9')]);
  check('Con más de una cuenta de Mercado Libre no se adivina la caja de la bonificación (FLEX_CUENTA_AMBIGUA)', /FLEX_CUENTA_AMBIGUA/.test(String(await falla(() => acr(ctx2.db, r2.adelanto_id, true)))));
}
{ // casos que NO se acreditan
  const ctx = await baseNueva(); const { db } = ctx;
  const a = await ordenAdel(ctx, { neto: 40000 }), b = await ordenAdel(ctx, { neto: 41000 }), c = await ordenAdel(ctx, { neto: 42000 }), d = await ordenAdel(ctx, { neto: 43000 });
  await revertir(db, b.id, 'cancelada');
  await db.query(`UPDATE public.meli_ordenes SET revisar = true, motivo_revisar = 'x' WHERE id=$1`, [c.id]);
  const r = await reg(db, 40001 + 41000 + 42000 + 43000, 100, [pago(a, 40001), pago(b), pago(c), pago(d)]);
  const antes = await caja(db);
  const x = await acr(db, r.adelanto_id);
  const mot = Object.fromEntries(x.detalle.map((z) => [z.orden, z.motivo || z.resultado]));
  check('Monto de Mercado Pago distinto al neto → MONTO_DISTINTO_AL_NETO (no se acredita sola)', mot[a.orden] === 'MONTO_DISTINTO_AL_NETO', JSON.stringify(mot));
  check('Orden revertida → ORDEN_REVERTIDA', mot[b.orden] === 'ORDEN_REVERTIDA', JSON.stringify(mot));
  check('Orden en revisión → ORDEN_EN_REVISION', mot[c.orden] === 'ORDEN_EN_REVISION', JSON.stringify(mot));
  check('Una falla NO frena a las demás: la sana se acredita igual', mot[d.orden] === 'acreditada' && x.acreditadas === 1 && x.pendientes === 3 && (await caja(db)) === antes + 43000, JSON.stringify(x));
  check('Las que fallaron no movieron plata ni quedaron marcadas', (await q(db, `SELECT count(*)::int n FROM public.meli_ordenes WHERE id = ANY($1) AND acreditado AND revertida_en IS NULL`, [[a.id, c.id]]))[0].n === 0);
}
{ // ya acreditada por el camino normal antes de cargar el adelanto
  const ctx = await baseNueva(); const { db } = ctx;
  const a = await ordenAdel(ctx, { neto: 40000, libera: '-1 day' });
  await acreditar(db, a.id);
  const antes = await caja(db);
  const r = await reg(db, 40000, 100, [pago(a)]);
  const x = await acr(db, r.adelanto_id);
  check('Orden ya acreditada de antes: se reconoce («ya_acreditada») y NO se vuelve a mover plata', x.ya_acreditadas === 1 && x.acreditadas === 0 && (await caja(db)) === antes && x.detalle[0].monto_igual === true, JSON.stringify(x));
}
{ // permisos de acreditar / estado
  const ctx = await baseNueva(); const { db } = ctx;
  const a = await ordenAdel(ctx, { neto: 40000 }); const r = await reg(db, 40000, 100, [pago(a)]);
  check('Un usuario dado de baja no puede acreditar ni ver el estado', /no autorizado/.test(String(await falla(() => comoRol(db, 'authenticated', 'baja@x.com', () => acr(db, r.adelanto_id))))) && /no autorizado/.test(String(await falla(() => comoRol(db, 'authenticated', 'baja@x.com', () => est(db))))));
  check('Adelanto inexistente → ADELANTO_INEXISTENTE', /ADELANTO_INEXISTENTE/.test(String(await falla(() => acr(db, 99999)))));
  check('Un usuario autorizado del CRM sí puede acreditar', (await comoRol(db, 'authenticated', 'franco@x.com', () => acr(db, r.adelanto_id))).acreditadas === 1);
}
console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
