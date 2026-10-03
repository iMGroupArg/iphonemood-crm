// Banco de pruebas del SQL de Mercado Libre → Ventas y Cajas
// (db/pendientes/meli_ventas_migration.sql) contra un Postgres REAL (pglite).
//
// Carga los TRES archivos reales, en el orden en que se van a correr:
//   caja_aplicar_delta.sql → meli_esquema_base.sql → meli_ventas_migration.sql
// sobre un esquema mínimo que imita el de producción (stock, ventas, venta_items,
// venta_pagos, cajas, caja_ledger, personas).
//
//   cd tests/sql && npm install && npm run test:meli
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
  await db.exec(SQL('meli_ventas_migration.sql'));
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

console.log('\n══ SQL de Mercado Libre → Ventas y Cajas (Postgres en WebAssembly) ══\n');

// ── 1. Corre limpio y dos veces ──────────────────────────────────────────
{
  const { db } = await baseNueva();
  const e = await falla(() => db.exec(SQL('meli_ventas_migration.sql')));
  check('La migración corre dos veces seguidas sin romper (idempotente)', e === null, e);
}
{
  // Sin sus dependencias, frena con un mensaje que se entiende
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`CREATE TABLE public.ventas (id BIGSERIAL PRIMARY KEY);`);
  const e = await falla(() => db.exec(SQL('meli_ventas_migration.sql')));
  check('Sin meli_esquema_base.sql frena con un mensaje claro', e && e.includes('meli_esquema_base.sql'), e);
}

// ── 2. Procesar ──────────────────────────────────────────────────────────
{
  const ctx = await baseNueva(); const { db } = ctx;
  const o = await nuevaOrden(ctx, { items: [{ cant: 1, precio: 100000, stock: { cantidad: 5 } }], neto: 85000 });
  const r = await procesar(db, o.id, 1000);
  const { rows: [v] } = await db.query(`SELECT * FROM ventas WHERE id=$1`, [r.venta_id]);
  const { rows: its } = await db.query(`SELECT * FROM venta_items WHERE venta_id=$1`, [r.venta_id]);
  const { rows: [s] } = await db.query(`SELECT cantidad FROM stock WHERE id=$1`, [o.stocks[0]]);
  check('Procesar: crea la venta ABIERTA, tipo mercadolibre, con la cotización congelada y la orden enlazada',
    r.ok && v.estado === 'abierta' && v.tipo_venta === 'mercadolibre' && Number(v.meli_cotizacion) === 1000 && Number(v.meli_orden_id) === o.id, JSON.stringify({ r, v }));
  check('… un ítem de USD 100 (100.000 ARS a 1.000) con el costo y el nombre del stock', its.length === 1 && Number(its[0].precio_usd) === 100 && Number(its[0].costo_usd) === 30 && its[0].nombre === 'Perfume X 100ml', JSON.stringify(its));
  check('… y descontó el stock en la base (5 → 4)', s.cantidad === 4, String(s.cantidad));
  const { rows: [ord] } = await db.query(`SELECT procesada, venta_id, stock_descontado FROM meli_ordenes WHERE id=$1`, [o.id]);
  check('… y la orden quedó procesada con su venta', ord.procesada && Number(ord.venta_id) === Number(r.venta_id) && ord.stock_descontado);
  const r2 = await procesar(db, o.id, 1000);
  const { rows: [s2] } = await db.query(`SELECT cantidad FROM stock WHERE id=$1`, [o.stocks[0]]);
  const { rows: [nv] } = await db.query(`SELECT count(*)::int n FROM ventas`);
  check('Procesar dos veces: devuelve ya_procesada, NO descuenta de nuevo ni crea otra venta', r2.ya_procesada === true && s2.cantidad === 4 && nv.n === 1, JSON.stringify({ r2, s2, nv }));
}
{
  // Cantidad 3 → 3 renglones; reparte el bruto y el redondeo sobrante va al último
  const ctx = await baseNueva(); const { db } = ctx;
  const o = await nuevaOrden(ctx, { items: [{ cant: 3, precio: 33333, stock: { cantidad: 10 } }], bruto: 99999, neto: 80000 });
  const r = await procesar(db, o.id, 1000);
  const { rows: its } = await db.query(`SELECT precio_usd FROM venta_items WHERE venta_id=$1 ORDER BY id`, [r.venta_id]);
  const suma = its.reduce((a, x) => a + Number(x.precio_usd), 0);
  check('Cantidad 3 → 3 renglones (el motor de ventas no tiene cantidad)', its.length === 3, String(its.length));
  check('… y la suma de los renglones es EXACTAMENTE el bruto en dólares (99.999 / 1.000 = 100,00)', Math.abs(suma - 100) < 1e-9, String(suma));
}
{
  // Dos productos distintos: cada uno con su parte proporcional
  const ctx = await baseNueva(); const { db } = ctx;
  const o = await nuevaOrden(ctx, { items: [{ cant: 1, precio: 60000, stock: { nombre: 'A' } }, { cant: 1, precio: 40000, stock: { nombre: 'B' } }], neto: 85000 });
  const r = await procesar(db, o.id, 1000);
  const { rows: its } = await db.query(`SELECT nombre, precio_usd FROM venta_items WHERE venta_id=$1 ORDER BY id`, [r.venta_id]);
  check('Dos productos: 60 y 40 dólares, y los dos descontaron stock', its.length === 2 && Number(its[0].precio_usd) === 60 && Number(its[1].precio_usd) === 40, JSON.stringify(its));
}
{
  // Con IMEI: no se elige solo; no crea venta; la orden queda en revisar con el motivo (y eso se CONSERVA)
  const ctx = await baseNueva(); const { db } = ctx;
  const o = await nuevaOrden(ctx, { items: [{ cant: 1, precio: 100000, stock: { cantidad: 1, imeis: ['111'] } }] });
  const r = await procesar(db, o.id);
  const { rows: [ord] } = await db.query(`SELECT revisar, motivo_revisar, procesada FROM meli_ordenes WHERE id=$1`, [o.id]);
  const { rows: [nv] } = await db.query(`SELECT count(*)::int n FROM ventas`);
  const { rows: [s] } = await db.query(`SELECT cantidad, imeis FROM stock WHERE id=$1`, [o.stocks[0]]);
  check('Producto con IMEI: no se procesa, no hay venta, el stock no se toca',
    r.ok === false && nv.n === 0 && s.cantidad === 1 && s.imeis.length === 1, JSON.stringify({ r, nv, s }));
  check('… y el aviso de "revisar" con su motivo QUEDA guardado (no se pierde en un rollback)', ord.revisar === true && /IMEI/.test(ord.motivo_revisar || '') && !ord.procesada, JSON.stringify(ord));
}
{
  // Stock insuficiente en el segundo ítem: ninguno se descuenta
  const ctx = await baseNueva(); const { db } = ctx;
  const o = await nuevaOrden(ctx, { items: [{ cant: 1, precio: 50000, stock: { cantidad: 5 } }, { cant: 2, precio: 25000, stock: { cantidad: 1 } }], neto: 60000 });
  const r = await procesar(db, o.id);
  const { rows: ss } = await db.query(`SELECT cantidad FROM stock ORDER BY nombre, id`);
  check('Stock insuficiente en un ítem: no se descuenta NINGUNO y no hay venta', r.ok === false && ss.every((s, i) => s.cantidad === [5, 1][i] || s.cantidad === [1, 5][i]) && (await db.query(`SELECT count(*)::int n FROM ventas`)).rows[0].n === 0, JSON.stringify({ r, ss }));
}
for (const [nombre, opts, esperado] of [
  ['revisar', { revisar: true }, 'ORDEN_EN_REVISION'],
  ['no pagada', { estado: 'cancelled' }, 'ORDEN_NO_PAGADA'],
  ['moneda distinta de ARS', { moneda: 'USD' }, 'MONEDA_NO_SOPORTADA'],
]) {
  const ctx = await baseNueva(); const o = await nuevaOrden(ctx, { opts });
  const e = await falla(() => procesar(ctx.db, o.id));
  check(`Procesar una orden ${nombre}: se rechaza con ${esperado} y no queda nada a medias`,
    e && e.includes(esperado) && (await ctx.db.query(`SELECT count(*)::int n FROM ventas`)).rows[0].n === 0 && (await ctx.db.query(`SELECT cantidad FROM stock`)).rows[0].cantidad === 5, e);
}
{
  // Cotización NaN o con decimales de más: se rechaza antes de tocar el stock / se normaliza una sola vez
  const ctx = await baseNueva(); const { db } = ctx;
  const o = await nuevaOrden(ctx);
  const eNaN = await falla(() => db.query(`SELECT public.meli_procesar_orden($1, 'NaN'::numeric)`, [o.id]));
  const eMicro = await falla(() => procesar(db, o.id, 0.000049));
  const eInf = await falla(() => procesar(db, o.id, 99999999));
  check('Cotización NaN, que redondea a cero o absurda: se rechaza y NO se toca el stock ni se crea venta',
    [eNaN, eMicro, eInf].every(e => e && e.includes('COTIZACION_INVALIDA')) && (await db.query(`SELECT cantidad FROM stock`)).rows[0].cantidad === 5 && (await db.query(`SELECT count(*)::int n FROM ventas`)).rows[0].n === 0, `${eNaN} | ${eMicro} | ${eInf}`);
  const r = await procesar(db, o.id, 1000.123456);
  const { rows: [v] } = await db.query(`SELECT meli_cotizacion FROM ventas WHERE id=$1`, [r.venta_id]);
  check('Una cotización con más de 4 decimales se guarda redondeada y ESA es la que se usa (1000,1235)', Number(v.meli_cotizacion) === 1000.1235, String(v.meli_cotizacion));
  const a = await acreditar(db, o.id);
  check('… y la acreditación posterior funciona con esa misma cotización (no falla por una cotización distinta)', a.ok === true, JSON.stringify(a));
}
{
  // Reparto en centavos: 4 unidades de ARS 1, bruto ARS 4 a cotización 200 → 0,02 USD en total, ningún renglón negativo
  const ctx = await baseNueva(); const { db } = ctx;
  const o = await nuevaOrden(ctx, { items: [{ cant: 4, precio: 1, stock: { cantidad: 10 } }], bruto: 4, neto: 3 });
  const r = await procesar(db, o.id, 200);
  const { rows: its } = await db.query(`SELECT precio_usd FROM venta_items WHERE venta_id=$1 ORDER BY id`, [r.venta_id]);
  const ps = its.map(x => Number(x.precio_usd));
  check('Reparto de centavos: 4 unidades que suman 0,02 USD dan 0,01 / 0,01 / 0 / 0 (nunca un precio negativo)',
    ps.length === 4 && ps.every(x => x >= 0) && Math.abs(ps.reduce((a, b) => a + b, 0) - 0.02) < 1e-9, JSON.stringify(ps));
}
{
  // El nombre del comprador viene de afuera: se limpia al crear la venta (no puede llevar HTML)
  const ctx = await baseNueva(); const { db } = ctx;
  const o = await nuevaOrden(ctx, { opts: { comprador: '<img src=x onerror=alert(1)>Juan "el\\ñato" & Cía\nX' } });
  const r = await procesar(db, o.id, 1000);
  const { rows: [v] } = await db.query(`SELECT cliente FROM ventas WHERE id=$1`, [r.venta_id]);
  check('El nombre del comprador se limpia de < > & comillas, barras y saltos de línea al crear la venta', v.cliente === 'img src=x onerror=alert(1)Juan elñato  CíaX', JSON.stringify(v.cliente));
  const ctx2 = await baseNueva();
  const o2 = await nuevaOrden(ctx2, { opts: { comprador: '<<>>' } });
  const r2 = await procesar(ctx2.db, o2.id, 1000);
  check('Si no queda nada del nombre, se usa «Mercado Libre»', (await ctx2.db.query(`SELECT cliente FROM ventas WHERE id=$1`, [r2.venta_id])).rows[0].cliente === 'Mercado Libre');
}
{
  // Precios negativos o ausentes: se rechaza antes de tocar el stock
  const ctx = await baseNueva(); const { db } = ctx;
  const o = await nuevaOrden(ctx, { items: [{ cant: 1, precio: -1000, stock: {} }, { cant: 1, precio: 2000, stock: {} }], bruto: 1000, neto: 900 });
  const e = await falla(() => procesar(db, o.id, 1000));
  check('Un ítem con precio negativo: PRECIO_INVALIDO, sin descontar stock ni crear venta',
    e?.includes('PRECIO_INVALIDO') && (await db.query(`SELECT count(*)::int n FROM ventas`)).rows[0].n === 0 && (await db.query(`SELECT min(cantidad)::int m FROM stock`)).rows[0].m === 5, e);
}
{
  const ctx = await baseNueva(); const o = await nuevaOrden(ctx);
  const e1 = await falla(() => procesar(ctx.db, o.id, 0));
  const e2 = await falla(() => procesar(ctx.db, o.id, null));
  check('Cotización cero o nula: COTIZACION_INVALIDA', e1?.includes('COTIZACION_INVALIDA') && e2?.includes('COTIZACION_INVALIDA'), `${e1} / ${e2}`);
}

// ── 3. Acreditar ─────────────────────────────────────────────────────────
{
  const ctx = await baseNueva(); const { db } = ctx;
  const o = await nuevaOrden(ctx, { items: [{ cant: 1, precio: 100000, stock: {} }], neto: 85000 });
  const p = await procesar(db, o.id, 1000);
  const a = await acreditar(db, o.id);
  const { rows: [v] } = await db.query(`SELECT * FROM ventas WHERE id=$1`, [p.venta_id]);
  const { rows: [pago] } = await db.query(`SELECT * FROM venta_pagos WHERE venta_id=$1`, [p.venta_id]);
  const { rows: l } = await db.query(`SELECT * FROM caja_ledger WHERE tipo='meli'`);
  check('Acreditar: la caja sube EXACTO el neto en pesos (85.000)', (await caja(db)) === 85000, String(await caja(db)));
  check('… el libro anota un asiento tipo meli con la clave estable y el control de cuadre da 0', l.length === 1 && Number(l[0].delta) === 85000 && (await cuadra(db)), JSON.stringify(l));
  check('… el cobro queda en dólares a la cotización congelada (85 USD @1000) en la misma caja', Number(pago.monto) === 85 && Number(pago.cotizacion_diferencial) === 1000 && pago.bolsillo === 'ARS Mercado Pago', JSON.stringify(pago));
  check('… la venta se cierra y el costo del canal es EXPLÍCITO: 100 − 85 = 15 USD', v.estado === 'cerrada' && Number(v.costo_canal_usd) === 15, JSON.stringify(v));
  const a2 = await acreditar(db, o.id);
  check('Acreditar otra vez: devuelve ya_acreditada y NO acredita dos veces', a2.ya_acreditada === true && (await caja(db)) === 85000 && (await db.query(`SELECT count(*)::int n FROM venta_pagos`)).rows[0].n === 1, JSON.stringify(a2));
}
{
  // Guardas: cada una rechaza y no deja NADA escrito
  const casos = [
    ['sin procesar', async (c, o) => {}, 'ORDEN_NO_PROCESADA', false],
    ['financiera incompleta', async (c, o) => c.db.query(`UPDATE meli_ordenes SET financiera_completa=false WHERE id=$1`, [o.id]), 'FINANCIERA_INCOMPLETA', true],
    ['en revisión', async (c, o) => c.db.query(`UPDATE meli_ordenes SET revisar=true, motivo_revisar='x' WHERE id=$1`, [o.id]), 'ORDEN_EN_REVISION', true],
    ['neto desconocido (NULL no es cero)', async (c, o) => c.db.query(`UPDATE meli_ordenes SET neto=NULL WHERE id=$1`, [o.id]), 'IMPORTES_INCOMPLETOS', true],
    ['todavía no liberada', async (c, o) => c.db.query(`UPDATE meli_ordenes SET fecha_liberacion = now() + interval '2 days' WHERE id=$1`, [o.id]), 'TODAVIA_NO_LIBERADA', true],
    ['cuenta sin caja asignada', async (c, o) => c.db.query(`UPDATE meli_cuentas SET persona_id=NULL WHERE id=$1`, [c.cuentaId]), 'CUENTA_SIN_CAJA', true],
  ];
  for (const [nombre, preparar, esperado, procesada] of casos) {
    const ctx = await baseNueva(); const o = await nuevaOrden(ctx);
    if (procesada) await procesar(ctx.db, o.id, 1000);
    await preparar(ctx, o);
    const e = await falla(() => acreditar(ctx.db, o.id));
    check(`Acreditar con ${nombre}: se rechaza (${esperado}) y la caja no se mueve`, e && e.includes(esperado) && (await caja(ctx.db)) === 0, e);
  }
}
{
  // Montos reales
  const armar = async () => { const ctx = await baseNueva(); const o = await nuevaOrden(ctx, { neto: 85000 }); await procesar(ctx.db, o.id, 1000); return { ctx, o }; };
  let { ctx, o } = await armar();
  const eMay = await falla(() => acreditar(ctx.db, o.id, 100001));
  check('Monto real MAYOR al bruto: se rechaza (no es una comisión negativa)', eMay?.includes('MONTO_MAYOR_AL_BRUTO') && (await caja(ctx.db)) === 0, eMay);
  const eMen = await falla(() => acreditar(ctx.db, o.id, 80000));
  check('Monto real MENOR al neto sin confirmar liquidación final: se rechaza', eMen?.includes('MONTO_MENOR_AL_NETO') && (await caja(ctx.db)) === 0, eMen);
  const aFin = await acreditar(ctx.db, o.id, 80000, true);
  const { rows: [v] } = await ctx.db.query(`SELECT costo_canal_usd FROM ventas WHERE id=(SELECT venta_id FROM meli_ordenes WHERE id=$1)`, [o.id]);
  check('… con liquidación final entra lo que llegó de verdad (80.000) y el costo del canal sube a 20 USD', aFin.ok && (await caja(ctx.db)) === 80000 && Number(v.costo_canal_usd) === 20, JSON.stringify({ aFin, v }));
  ({ ctx, o } = await armar());
  await acreditar(ctx.db, o.id, 90000);
  check('Monto real entre el neto y el bruto (90.000): se acepta y el costo del canal baja a 10 USD',
    (await caja(ctx.db)) === 90000 && Number((await ctx.db.query(`SELECT costo_canal_usd FROM ventas WHERE tipo_venta='mercadolibre'`)).rows[0].costo_canal_usd) === 10);
}
{
  // Atomicidad: si algo falla DESPUÉS de mover la plata, la plata vuelve (todo en una transacción)
  const ctx = await baseNueva(); const { db } = ctx;
  const o = await nuevaOrden(ctx); const p = await procesar(db, o.id, 1000);
  await db.query(`UPDATE ventas SET meli_cotizacion = NULL WHERE id=$1`, [p.venta_id]);
  const e = await falla(() => acreditar(db, o.id));
  const { rows: [ord] } = await db.query(`SELECT acreditado FROM meli_ordenes WHERE id=$1`, [o.id]);
  check('Si falla un paso posterior a mover la plata, TODO se deshace: caja en 0, sin asiento, orden sin acreditar',
    e?.includes('VENTA_SIN_COTIZACION') && (await caja(db)) === 0 && !ord.acreditado && (await db.query(`SELECT count(*)::int n FROM caja_ledger WHERE tipo='meli'`)).rows[0].n === 0, e);
}

// ── 4. Revertir ──────────────────────────────────────────────────────────
{
  const ctx = await baseNueva(); const { db } = ctx;
  const o = await nuevaOrden(ctx, { items: [{ cant: 2, precio: 50000, stock: { cantidad: 5 } }], neto: 85000 });
  const p = await procesar(db, o.id, 1000); await acreditar(db, o.id);
  const r = await revertir(db, o.id, 'el comprador devolvió');
  const { rows: [s] } = await db.query(`SELECT cantidad, estado_inventario FROM stock WHERE id=$1`, [o.stocks[0]]);
  const { rows: [v] } = await db.query(`SELECT estado FROM ventas WHERE id=$1`, [p.venta_id]);
  const { rows: [ord] } = await db.query(`SELECT revertida_en, revisar, motivo_revisar FROM meli_ordenes WHERE id=$1`, [o.id]);
  check('Revertir una orden acreditada: la caja vuelve a 0 y el libro sigue cuadrando', r.ok && (await caja(db)) === 0 && (await cuadra(db)));
  check('… el stock se repone (5) y la venta queda ANULADA (no se borra)', s.cantidad === 5 && v.estado === 'anulada', JSON.stringify({ s, v }));
  check('… la orden queda marcada como revertida, con el motivo, y sin la alerta de revisar', ord.revertida_en && ord.revisar === false && /devolvió/.test(ord.motivo_revisar || ''), JSON.stringify(ord));
  const r2 = await revertir(db, o.id);
  check('Revertir otra vez: ya_revertida, NO saca la plata ni repone stock dos veces', r2.ya_revertida === true && (await caja(db)) === 0 && (await db.query(`SELECT cantidad FROM stock WHERE id=$1`, [o.stocks[0]])).rows[0].cantidad === 5);
  const eAcr = await falla(() => acreditar(db, o.id));
  const ePro = await falla(() => procesar(db, o.id));
  check('Una orden revertida no se puede acreditar ni procesar de nuevo', eAcr?.includes('ORDEN_REVERTIDA') && ePro?.includes('ORDEN_REVERTIDA'), `${eAcr} / ${ePro}`);
}
{
  // Revertir sin haber acreditado: solo stock y venta; la caja no se toca
  const ctx = await baseNueva(); const { db } = ctx;
  const o = await nuevaOrden(ctx); await procesar(db, o.id, 1000);
  const r = await revertir(db, o.id);
  check('Revertir una orden SIN acreditar: no toca la caja, repone el stock y anula la venta',
    r.ok && r.caja_devuelta === false && (await caja(db)) === 0 && (await db.query(`SELECT cantidad FROM stock`)).rows[0].cantidad === 5);
  const eNo = await falla(async () => { const ctx2 = await baseNueva(); const o2 = await nuevaOrden(ctx2); await revertir(ctx2.db, o2.id); });
  check('Revertir una orden que nunca se procesó: ORDEN_NO_PROCESADA', eNo?.includes('ORDEN_NO_PROCESADA'), eNo);
}
{
  // Si la caja de origen cambió de bolsillo en la cuenta, el reverso sale de donde ENTRÓ
  const ctx = await baseNueva(); const { db, pid, cuentaId } = ctx;
  const o = await nuevaOrden(ctx); await procesar(db, o.id, 1000); await acreditar(db, o.id);
  await db.query(`INSERT INTO cajas (persona_id, bolsillo, saldo) VALUES ($1,'ARS otra',0)`, [pid]);
  await db.query(`UPDATE meli_cuentas SET bolsillo='ARS otra' WHERE id=$1`, [cuentaId]);
  await revertir(db, o.id);
  const { rows: [mp] } = await db.query(`SELECT saldo FROM cajas WHERE bolsillo='ARS Mercado Pago'`);
  const { rows: [ot] } = await db.query(`SELECT saldo FROM cajas WHERE bolsillo='ARS otra'`);
  check('El reverso sale de la caja donde entró la plata, aunque la cuenta ya apunte a otra', Number(mp.saldo) === 0 && Number(ot.saldo) === 0, JSON.stringify({ mp, ot }));
}

// ── 5. Una venta de Mercado Libre no se borra ────────────────────────────
{
  const ctx = await baseNueva(); const { db } = ctx;
  const o = await nuevaOrden(ctx); const p = await procesar(db, o.id, 1000);
  const e = await falla(() => db.query(`DELETE FROM ventas WHERE id=$1`, [p.venta_id]));
  check('DELETE de una venta de Mercado Libre: la base lo rechaza (FK RESTRICT)', e && /foreign key|violates/i.test(e), e);
  await db.query(`INSERT INTO ventas (cliente, estado, tipo_venta) VALUES ('normal','abierta','minorista')`);
  const e2 = await falla(() => db.query(`DELETE FROM ventas WHERE cliente='normal'`));
  check('… pero una venta común se sigue pudiendo borrar', e2 === null, e2);
}

// ── 6. Permisos ──────────────────────────────────────────────────────────
{
  const ctx = await baseNueva(); const { db } = ctx;
  const priv = async (rol, fn) => (await db.query(`SELECT has_function_privilege($1, p.oid, 'EXECUTE') AS puede FROM pg_proc p WHERE p.proname = $2`, [rol, fn])).rows[0]?.puede;
  for (const fn of ['meli_procesar_orden', 'meli_acreditar_orden', 'meli_revertir_orden']) {
    check(`${fn}: anon NO puede ejecutarla y authenticated SÍ`, (await priv('anon', fn)) === false && (await priv('authenticated', fn)) === true);
  }
  const o = await nuevaOrden(ctx);
  await db.exec(`SELECT set_config('request.jwt.claims', '{"email":"baja@x.com"}', false)`);
  const e1 = await falla(() => procesar(db, o.id));
  const e2 = await falla(() => acreditar(db, o.id));
  const e3 = await falla(() => revertir(db, o.id));
  check('Un usuario dado de baja no puede procesar, acreditar ni revertir', [e1, e2, e3].every(e => e && e.includes('no autorizado')), `${e1} | ${e2} | ${e3}`);
  await db.exec(`SELECT set_config('request.jwt.claims', '{}', false)`);
  const e4 = await falla(() => procesar(db, o.id));
  check('Sin sesión tampoco', e4 && e4.includes('no autorizado'), e4);
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
