// Banco de pruebas de stock_ajustar y de los productos "a pedido" contra un Postgres
// REAL (pglite). Carga los archivos reales de db/pendientes/, en el orden de corrida:
//   stock_a_pedido.sql → meli_esquema_base.sql → stock_ajustar_rpc.sql
// sobre un esquema mínimo que imita el de producción.
//
//   cd tests/sql && npm run test:stock
//
// NO cubre dos conexiones simultáneas (pglite tiene una sola): los bloqueos de fila, el
// candado global de IMEI y los dos triggers de a_pedido dependen de Postgres y hay que
// probarlos con dos sesiones antes de producción.
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
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
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
    -- Mismas columnas que usa la vista pública vigente (20260829_precio_ars_publico.sql)
    CREATE TABLE public.stock (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre TEXT, categoria TEXT,
      modelo TEXT, storage TEXT, color TEXT, estado_producto TEXT, bateria_pct INT, imagen_url TEXT, combo_items JSONB,
      precio_ars NUMERIC, cotizacion NUMERIC, costo_usd NUMERIC(18,2) DEFAULT 0,
      cantidad INTEGER DEFAULT 0, imeis TEXT[] DEFAULT '{}', estado_inventario TEXT DEFAULT 'disponible');
    CREATE TABLE public.stock_movimientos (id BIGSERIAL PRIMARY KEY, stock_id UUID, tipo TEXT, detalle TEXT,
      cantidad_antes INT, cantidad_despues INT, usuario_nombre TEXT, datos JSONB, creado_en TIMESTAMPTZ DEFAULT now());
    CREATE TABLE public.reparacion_repuestos (id BIGSERIAL PRIMARY KEY);
    INSERT INTO public.usuarios_autorizados VALUES ('franco@x.com', true), ('baja@x.com', false);
  `);
  await db.exec(SQL('stock_a_pedido.sql'));
  await db.exec(SQL('meli_esquema_base.sql'));
  await db.exec(SQL('stock_ajustar_rpc.sql'));
  await db.exec(`SELECT set_config('request.jwt.claims', '{"email":"franco@x.com"}', false)`);
  const { rows: [p] } = await db.query(`INSERT INTO public.personas (nombre) VALUES ('Franco') RETURNING id`);
  await db.query(`INSERT INTO public.cajas (persona_id, bolsillo) VALUES ($1,'ARS Mercado Pago')`, [p.id]);
  const { rows: [c] } = await db.query(
    `INSERT INTO public.meli_cuentas (meli_user_id, nickname, persona_id, bolsillo) VALUES ('999','FRANCO',$1,'ARS Mercado Pago') RETURNING id`, [p.id]);
  return { db, cuentaId: c.id };
}

const nuevoStock = async (db, { nombre = 'Perfume X', categoria = 'perfumeria', cantidad = 5, imeis = [], estado = 'disponible', aPedido = false } = {}) =>
  (await db.query(`INSERT INTO stock (nombre, categoria, cantidad, imeis, estado_inventario, a_pedido, precio_ars, cotizacion)
                   VALUES ($1,$2,$3,$4,$5,$6,100000,1000) RETURNING id`, [nombre, categoria, cantidad, imeis, estado, aPedido])).rows[0].id;
const ajustar = (db, id, delta, { tipo = 'test', imei = null, destino = null } = {}) =>
  db.query(`SELECT * FROM stock_ajustar($1,$2,$3,'detalle',$4,$5)`, [id, delta, tipo, imei, destino]).then(x => x.rows[0]);
const fila = async (db, id) => (await db.query(`SELECT cantidad, imeis, estado_inventario FROM stock WHERE id=$1`, [id])).rows[0];
const movs = async (db, id) => (await db.query(`SELECT * FROM stock_movimientos WHERE stock_id=$1 ORDER BY id`, [id])).rows;

let seq = 0;
async function nuevaOrden(ctx, items) {   // items: [{ stock: uuid, cant }]
  const { db, cuentaId } = ctx;
  const { rows: [r] } = await db.query(
    `INSERT INTO meli_ordenes (cuenta_id, meli_order_id, estado, comprador, fecha_orden, moneda, bruto, neto, revisar, financiera_completa)
     VALUES ($1,$2,'paid','c', now(),'ARS',100000,85000,false,true) RETURNING id`, [cuentaId, `ORD-${++seq}`]);
  for (let i = 0; i < items.length; i++) {
    await db.query(`INSERT INTO meli_orden_items (orden_id, meli_item_id, titulo, cantidad, precio_unitario, stock_id)
                    VALUES ($1,$2,'t',$3,1000,$4)`, [r.id, `MLA${i}`, items[i].cant, items[i].stock]);
  }
  return r.id;
}
const descontar = (db, id) => db.query(`SELECT * FROM meli__descontar_core($1)`, [id]).then(x => x.rows);
const reponer = (db, id) => db.query(`SELECT * FROM meli_reponer_stock($1)`, [id]).then(x => x.rows);

console.log('\n══ stock_ajustar y productos "a pedido" (Postgres en WebAssembly) ══\n');

// ── 1. Idempotencia de los tres archivos ─────────────────────────────────
{
  const { db } = await baseNueva();
  const e1 = await falla(() => db.exec(SQL('stock_a_pedido.sql')));
  const e2 = await falla(() => db.exec(SQL('meli_esquema_base.sql')));
  const e3 = await falla(() => db.exec(SQL('stock_ajustar_rpc.sql')));
  check('Los tres archivos corren una SEGUNDA vez sin romper', !e1 && !e2 && !e3, `${e1} | ${e2} | ${e3}`);
}
{
  // El orden de corrida no importa: cada archivo agrega la columna por su cuenta
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`CREATE SCHEMA IF NOT EXISTS extensions; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    CREATE FUNCTION public.is_authorized_user() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE TABLE public.personas (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre TEXT);
    CREATE TABLE public.cajas (id BIGSERIAL PRIMARY KEY, persona_id UUID, bolsillo TEXT NOT NULL, saldo NUMERIC DEFAULT 0);
    CREATE TABLE public.usuarios_autorizados (email TEXT PRIMARY KEY, activo BOOLEAN DEFAULT true);
    CREATE TABLE public.stock (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre TEXT, categoria TEXT, modelo TEXT, storage TEXT,
      color TEXT, estado_producto TEXT, bateria_pct INT, imagen_url TEXT, combo_items JSONB, precio_ars NUMERIC, cotizacion NUMERIC,
      cantidad INTEGER DEFAULT 0, imeis TEXT[] DEFAULT '{}', estado_inventario TEXT);
    CREATE TABLE public.stock_movimientos (id BIGSERIAL PRIMARY KEY, stock_id UUID, tipo TEXT, detalle TEXT, cantidad_antes INT,
      cantidad_despues INT, usuario_nombre TEXT, datos JSONB);
    CREATE TABLE public.reparacion_repuestos (id BIGSERIAL PRIMARY KEY);`);
  const e = await falla(async () => {
    await db.exec(SQL('stock_ajustar_rpc.sql'));
    await db.exec(SQL('meli_esquema_base.sql'));
    await db.exec(SQL('stock_a_pedido.sql'));
  });
  check('En otro orden (ajustar → meli → a_pedido) también carga', e === null, e);
}

// ── 2. stock_ajustar SIN a pedido (regresión: no cambió nada) ────────────
{
  const { db } = await baseNueva();
  const id = await nuevoStock(db, { cantidad: 2 });
  const r1 = await ajustar(db, id, -1);
  check('Descontar 1: 2 → 1, sigue disponible', r1.cantidad === 1 && r1.estado_inventario === 'disponible' && r1.unidades === 1, JSON.stringify(r1));
  const r2 = await ajustar(db, id, -1);
  check('Descontar el último: 0 y pasa a vendido en la misma sentencia', r2.cantidad === 0 && r2.estado_inventario === 'vendido', JSON.stringify(r2));
  const e = await falla(() => ajustar(db, id, -1));
  check('Descontar sin unidades: STOCK_INSUFICIENTE', e?.includes('STOCK_INSUFICIENTE'), e);
  const r3 = await ajustar(db, id, +1);
  check('Reponer una fila vendida: vuelve a disponible', r3.cantidad === 1 && r3.estado_inventario === 'disponible', JSON.stringify(r3));
  const m = await movs(db, id);
  check('Cada ajuste dejó su movimiento (3 exitosos, el fallido no)', m.length === 3 && m[0].cantidad_antes === 2 && m[0].cantidad_despues === 1, JSON.stringify(m.map(x => [x.cantidad_antes, x.cantidad_despues])));
}
{
  const { db } = await baseNueva();
  const id = await nuevoStock(db, { categoria: 'iphone', cantidad: 2, imeis: ['A', 'B'] });
  const e1 = await falla(() => ajustar(db, id, -1));
  check('Fila con IMEIs, descontar sin decir cuál: IMEI_REQUERIDO', e1?.includes('IMEI_REQUERIDO'), e1);
  const r = await ajustar(db, id, -1, { imei: 'A' });
  check('Descontar el IMEI A lo saca del arreglo', r.imeis.length === 1 && r.imeis[0] === 'B' && r.unidades === 1, JSON.stringify(r));
  const r2 = await ajustar(db, id, +1, { imei: 'C' });
  check('Reponer el IMEI C lo agrega', r2.imeis.length === 2 && r2.imeis.includes('C'), JSON.stringify(r2));
}
{
  const { db } = await baseNueva();
  const id = await nuevoStock(db, { cantidad: 1 });
  const e1 = await falla(() => ajustar(db, id, -1, { destino: 'disponible' }));
  const e2 = await falla(() => ajustar(db, id, -1, { destino: 'quedó_en_cualquier_cosa' }));
  check('Estado destino incoherente (disponible con 0 unidades): ESTADO_INCONSISTENTE', e1?.includes('ESTADO_INCONSISTENTE'), e1);
  check('Estado destino fuera de la lista: ESTADO_INVALIDO', e2?.includes('ESTADO_INVALIDO'), e2);
}

// ── 3. stock_ajustar CON a pedido ────────────────────────────────────────
{
  const { db } = await baseNueva();
  const id = await nuevoStock(db, { cantidad: 0, aPedido: true });
  const r = await ajustar(db, id, -1);
  check('A pedido, 0 unidades: descontar NO falla ni da negativo; cantidad 0 y sigue disponible', r.cantidad === 0 && r.estado_inventario === 'disponible' && r.unidades === 0, JSON.stringify(r));
  const f = await fila(db, id);
  check('… y la fila en la base no cambió (0, disponible)', f.cantidad === 0 && f.estado_inventario === 'disponible', JSON.stringify(f));
  const m = await movs(db, id);
  check('… pero el movimiento SÍ quedó registrado, sin cambio de cantidad y marcado a_pedido', m.length === 1 && m[0].cantidad_antes === 0 && m[0].cantidad_despues === 0 && m[0].datos.a_pedido === true && m[0].datos.delta === -1, JSON.stringify(m));
  const r2 = await ajustar(db, id, +3);
  const m2 = await movs(db, id);
  check('Reponer a pedido: tampoco toca la cantidad, pero registra el movimiento', r2.cantidad === 0 && m2.length === 2 && m2[1].datos.delta === 3, JSON.stringify({ r2, m2: m2.length }));
  const e = await falla(() => ajustar(db, id, -1, { imei: 'X' }));
  check('A pedido con IMEI: A_PEDIDO_NO_ADMITE_IMEI y no se escribe nada', e?.includes('A_PEDIDO_NO_ADMITE_IMEI') && (await movs(db, id)).length === 2, e);
  const e2 = await falla(() => ajustar(db, id, -1, { destino: 'vendido' }));
  check('A pedido, pedir vendido: ESTADO_INCONSISTENTE (nunca se vende del todo)', e2?.includes('ESTADO_INCONSISTENTE'), e2);
  const r3 = await ajustar(db, id, +1, { destino: 'reservado' });
  check('A pedido, un estado destino distinto de vendido se respeta (reservado con 0 unidades)', r3.estado_inventario === 'reservado' && (await fila(db, id)).estado_inventario === 'reservado', JSON.stringify(r3));
  const r4 = await ajustar(db, id, -1);
  check('… y descontar después conserva ese estado (no lo pasa a vendido)', r4.estado_inventario === 'reservado', JSON.stringify(r4));
}
{
  // A pedido con unidades cargadas: tampoco las toca
  const { db } = await baseNueva();
  const id = await nuevoStock(db, { cantidad: 3, aPedido: true });
  const r = await ajustar(db, id, -10);
  check('A pedido con cantidad 3: descontar 10 NO falla ni resta (sigue 3)', r.cantidad === 3 && r.unidades === 3, JSON.stringify(r));
}

// ── 4. El CHECK de la columna ────────────────────────────────────────────
{
  const { db } = await baseNueva();
  const e1 = await falla(() => nuevoStock(db, { categoria: 'iphone', aPedido: true, cantidad: 0 }));
  const e2 = await falla(() => nuevoStock(db, { aPedido: true, cantidad: 0, imeis: ['1'] }));
  const e3 = await falla(() => nuevoStock(db, { categoria: 'IPhone', aPedido: true, cantidad: 0 }));
  const e4 = await falla(() => nuevoStock(db, { categoria: 'perfumeria', aPedido: true, cantidad: 0 }));
  const e5 = await falla(() => nuevoStock(db, { categoria: null, aPedido: true, cantidad: 0 }));
  check('CHECK: a pedido en un rubro con IMEI (iphone, también en mayúsculas) se rechaza', !!e1 && !!e3 && /stock_a_pedido_sin_imei/.test(e1), `${e1} | ${e3}`);
  check('CHECK: a pedido con IMEIs cargados se rechaza', !!e2 && /stock_a_pedido_sin_imei/.test(e2), e2);
  check('CHECK: a pedido en perfumería (o sin categoría) se acepta', e4 === null && e5 === null, `${e4} | ${e5}`);
  const id = await nuevoStock(db, { categoria: 'iphone', cantidad: 1, imeis: ['9'] });
  const e6 = await falla(() => db.query(`UPDATE stock SET a_pedido = true WHERE id=$1`, [id]));
  check('CHECK: marcar a pedido un iPhone con IMEI existente se rechaza', !!e6, e6);
}

// ── 5. Mercado Libre: descontar y reponer ────────────────────────────────
{
  const ctx = await baseNueva(); const { db } = ctx;
  const ped = await nuevoStock(db, { nombre: 'A pedido', cantidad: 0, aPedido: true });
  const norm = await nuevoStock(db, { nombre: 'Normal', cantidad: 5 });
  const o = await nuevaOrden(ctx, [{ stock: ped, cant: 2 }, { stock: norm, cant: 1 }]);
  const rows = await descontar(db, o);
  const fp = await fila(db, ped), fn = await fila(db, norm);
  const rp = rows.find(r => r.stock_id === ped), rn = rows.find(r => r.stock_id === norm);
  check('Orden con un producto a pedido (0 unidades) y uno normal: se descuenta, sin STOCK_INSUFICIENTE', rows.length === 2, JSON.stringify(rows));
  check('… el a pedido queda en 0 y disponible; el normal baja de 5 a 4', fp.cantidad === 0 && fp.estado_inventario === 'disponible' && fn.cantidad === 4, JSON.stringify({ fp, fn }));
  check('… el a pedido informa descontado = 0 y agotado = false; el normal, descontado = 1', rp.descontado === 0 && rp.agotado === false && rp.queda === 0 && rn.descontado === 1, JSON.stringify(rows));
  const mp = await movs(db, ped);
  check('… y deja el movimiento del a pedido sin variación de cantidad', mp.length === 1 && mp[0].cantidad_antes === 0 && mp[0].cantidad_despues === 0 && mp[0].tipo === 'meli' && mp[0].datos.a_pedido === true, JSON.stringify(mp));
  const rr = await reponer(db, o);
  const fp2 = await fila(db, ped), fn2 = await fila(db, norm);
  check('Reponer (cancelación): el a pedido sigue en 0, el normal vuelve a 5, y ambos tienen su movimiento', fp2.cantidad === 0 && fn2.cantidad === 5 && rr.length === 2 && rr.find(r => r.stock_id === ped).repuesto === 0 && (await movs(db, ped)).length === 2, JSON.stringify({ fp2, fn2, rr }));
}
{
  // Un normal sin stock sigue frenando la orden (la exención es SOLO del a pedido)
  const ctx = await baseNueva(); const { db } = ctx;
  const ped = await nuevoStock(db, { cantidad: 0, aPedido: true });
  const falta = await nuevoStock(db, { cantidad: 0 });
  const o = await nuevaOrden(ctx, [{ stock: ped, cant: 1 }, { stock: falta, cant: 1 }]);
  const rows = await descontar(db, o);
  const { rows: [ord] } = await db.query(`SELECT revisar, motivo_revisar, stock_descontado FROM meli_ordenes WHERE id=$1`, [o]);
  check('Un producto NORMAL sin stock sigue frenando la orden entera (revisar) aunque otro sea a pedido', rows.length === 0 && ord.revisar && /Stock insuficiente/.test(ord.motivo_revisar) && !ord.stock_descontado, JSON.stringify(ord));
  check('… y no se escribió ningún movimiento', (await movs(db, ped)).length === 0);
}
{
  // Orden normal de siempre: sin cambios
  const ctx = await baseNueva(); const { db } = ctx;
  const s = await nuevoStock(db, { cantidad: 1 });
  const o = await nuevaOrden(ctx, [{ stock: s, cant: 1 }]);
  const rows = await descontar(db, o);
  const f = await fila(db, s);
  check('Regresión: producto normal con 1 unidad → 0, vendido, agotado = true', f.cantidad === 0 && f.estado_inventario === 'vendido' && rows[0].agotado === true && rows[0].descontado === 1, JSON.stringify({ f, rows }));
}

{
  // Hallazgo de Codex: reponer tiene que devolver lo que el descuento sacó DE VERDAD, no mirar
  // la bandera de HOY. (A) Físico al descontar, a pedido al revertir.
  const ctx = await baseNueva(); const { db } = ctx;
  const s = await nuevoStock(db, { cantidad: 5 });
  const o = await nuevaOrden(ctx, [{ stock: s, cant: 1 }]);
  await descontar(db, o);
  const antes = (await fila(db, s)).cantidad;
  await db.query(`UPDATE stock SET a_pedido = true WHERE id=$1`, [s]);   // sin vínculo con MELI: el trigger lo permite
  const rr = await reponer(db, o);
  const f = await fila(db, s);
  check('Físico al descontar (5→4) y a pedido al revertir: la reposición SÍ devuelve la unidad (4→5)', antes === 4 && f.cantidad === 5 && rr[0].repuesto === 1, JSON.stringify({ antes, f, rr }));
  const mv = (await movs(db, s)).filter(m => m.tipo === 'meli_reverso');
  check('… y el movimiento de reverso dice 4→5', mv.length === 1 && mv[0].cantidad_antes === 4 && mv[0].cantidad_despues === 5, JSON.stringify(mv));
}
{
  // (B) A pedido al descontar, físico al revertir: NO se inventa stock.
  const ctx = await baseNueva(); const { db } = ctx;
  const s = await nuevoStock(db, { cantidad: 2, aPedido: true });
  const o = await nuevaOrden(ctx, [{ stock: s, cant: 1 }]);
  await descontar(db, o);
  await db.query(`UPDATE stock SET a_pedido = false WHERE id=$1`, [s]);
  const rr = await reponer(db, o);
  const f = await fila(db, s);
  check('A pedido al descontar y físico al revertir: NO inventa stock (sigue 2) y repuesto = 0', f.cantidad === 2 && rr[0].repuesto === 0, JSON.stringify({ f, rr }));
  check('… y el movimiento de reverso se registra igual, sin variación', (await movs(db, s)).filter(m => m.tipo === 'meli_reverso').length === 1);
}
{
  // El ítem recuerda lo descontado y lo olvida al reponer; y un segundo ciclo funciona
  const ctx = await baseNueva(); const { db } = ctx;
  const s = await nuevoStock(db, { cantidad: 5 });
  const o = await nuevaOrden(ctx, [{ stock: s, cant: 2 }]);
  await descontar(db, o);
  const d1 = (await db.query(`SELECT descontado_cantidad d FROM meli_orden_items WHERE orden_id=$1`, [o])).rows[0].d;
  await reponer(db, o);
  const d2 = (await db.query(`SELECT descontado_cantidad d FROM meli_orden_items WHERE orden_id=$1`, [o])).rows[0].d;
  const rr2 = await reponer(db, o);
  check('El ítem guarda lo descontado (2), lo borra al reponer, y reponer dos veces no suma dos veces', d1 === 2 && d2 === null && rr2.length === 0 && (await fila(db, s)).cantidad === 5, JSON.stringify({ d1, d2, rr2 }));
  await descontar(db, o);
  check('Y se puede volver a descontar y reponer (5→3→5)', (await fila(db, s)).cantidad === 3 && (await reponer(db, o)).length === 1 && (await fila(db, s)).cantidad === 5);
}
{
  // Un ítem descontado ANTES de existir la columna (NULL): se devuelve toda la cantidad
  const ctx = await baseNueva(); const { db } = ctx;
  const s = await nuevoStock(db, { cantidad: 5 });
  const o = await nuevaOrden(ctx, [{ stock: s, cant: 2 }]);
  await descontar(db, o);
  await db.query(`UPDATE meli_orden_items SET descontado_cantidad = NULL WHERE orden_id=$1`, [o]);
  await reponer(db, o);
  check('Ítem sin descontado_cantidad (legado): se devuelve la cantidad completa', (await fila(db, s)).cantidad === 5);
}

{
  // Hallazgo de Codex: reintentar el descuento de una orden YA descontada no la marca "revisar"
  const ctx = await baseNueva(); const { db } = ctx;
  const s = await nuevoStock(db, { cantidad: 1 });
  const o = await nuevaOrden(ctx, [{ stock: s, cant: 1 }]);
  await descontar(db, o);
  const otra = await descontar(db, o);   // el reintento: el stock ya está en 0
  const { rows: [ord] } = await db.query(`SELECT revisar, motivo_revisar, stock_descontado FROM meli_ordenes WHERE id=$1`, [o]);
  check('Reintentar el descuento de una orden ya descontada: no hace nada y NO la marca revisar', otra.length === 0 && ord.revisar === false && ord.motivo_revisar === null && ord.stock_descontado === true, JSON.stringify({ otra, ord }));
  check('… y el stock sigue donde estaba (0) con un solo movimiento', (await fila(db, s)).cantidad === 0 && (await movs(db, s)).length === 1);
}

// ── 6. Que a pedido no se vincule a Mercado Libre ────────────────────────
{
  const ctx = await baseNueva(); const { db, cuentaId } = ctx;
  const ped = await nuevoStock(db, { cantidad: 0, aPedido: true });
  const norm = await nuevoStock(db, { cantidad: 3 });
  const vincular = (stockId, item) => db.query(`INSERT INTO meli_publicaciones (cuenta_id, meli_item_id, stock_id) VALUES ($1,$2,$3)`, [cuentaId, item, stockId]);
  const e = await falla(() => vincular(ped, 'MLA1'));
  check('Vincular un producto a pedido a una publicación: A_PEDIDO_NO_SE_VINCULA', e?.includes('A_PEDIDO_NO_SE_VINCULA'), e);
  const e2 = await falla(() => vincular(norm, 'MLA2'));
  check('… y un producto normal se vincula sin problema', e2 === null, e2);
  const e3 = await falla(() => db.query(`UPDATE stock SET a_pedido = true WHERE id=$1`, [norm]));
  check('Marcar a pedido un producto que YA está vinculado: A_PEDIDO_VINCULADO_A_MELI', e3?.includes('A_PEDIDO_VINCULADO_A_MELI'), e3);
  check('… y la fila no quedó marcada', (await db.query(`SELECT a_pedido FROM stock WHERE id=$1`, [norm])).rows[0].a_pedido === false);
  const libre = await nuevoStock(db, { cantidad: 3 });
  const e4 = await falla(() => db.query(`UPDATE stock SET a_pedido = true WHERE id=$1`, [libre]));
  check('Marcar a pedido uno sin vínculo: se puede', e4 === null, e4);
  const e5 = await falla(() => db.query(`UPDATE meli_publicaciones SET stock_id=$1 WHERE meli_item_id='MLA2'`, [ped]));
  check('Re-vincular una publicación existente a un producto a pedido también se rechaza', e5?.includes('A_PEDIDO_NO_SE_VINCULA'), e5);
  const e6 = await falla(() => db.query(`DELETE FROM stock WHERE id=$1`, [norm]));
  check('Borrar un stock vinculado sigue funcionando (el vínculo pasa a NULL)', e6 === null && (await db.query(`SELECT stock_id FROM meli_publicaciones WHERE meli_item_id='MLA2'`)).rows[0].stock_id === null, e6);
}

// ── 7. La vista pública ──────────────────────────────────────────────────
{
  const { db } = await baseNueva();
  await nuevoStock(db, { nombre: 'Normal', cantidad: 2 });
  await nuevoStock(db, { nombre: 'A pedido', cantidad: 0, aPedido: true });
  await db.query(`SET ROLE anon`);
  const { rows } = await db.query(`SELECT * FROM stock_publico ORDER BY nombre`);
  await db.query(`RESET ROLE`);
  const cols = Object.keys(rows[0]);
  check('La vista pública la lee anon, tiene a_pedido y sigue con sus columnas (13 + a_pedido, última)',
    rows.length === 2 && cols.length === 14 && cols[13] === 'a_pedido' && cols.includes('combo_items') && cols.includes('precio_ars'), cols.join(','));
  check('… un a pedido con 0 unidades y disponible SÍ aparece, marcado', rows.find(r => r.nombre === 'A pedido').a_pedido === true && rows.find(r => r.nombre === 'A pedido').unidades === 0 && rows.find(r => r.nombre === 'Normal').a_pedido === false, JSON.stringify(rows.map(r => [r.nombre, r.a_pedido, r.unidades])));
  check('… y NO expone nada interno (sin costo, imeis, cantidad, estado_inventario)', !['costo_usd', 'imeis', 'cantidad', 'estado_inventario'].some(c => cols.includes(c)), cols.join(','));
}

// ── 8. Permisos de stock_ajustar ─────────────────────────────────────────
{
  const { db } = await baseNueva();
  const id = await nuevoStock(db, { cantidad: 3 });
  await db.query(`SET ROLE anon`);
  const e = await falla(() => ajustar(db, id, -1));
  await db.query(`RESET ROLE`);
  check('anon NO puede ejecutar stock_ajustar', e?.includes('permission denied'), e);
  await db.query(`SET ROLE authenticated`);
  const ok1 = await falla(() => ajustar(db, id, -1));
  await db.query(`RESET ROLE`);
  check('authenticated autorizado SÍ puede', ok1 === null, ok1);
  await db.exec(`SELECT set_config('request.jwt.claims', '{"email":"baja@x.com"}', false)`);
  await db.query(`SET ROLE authenticated`);
  const e2 = await falla(() => ajustar(db, id, -1));
  await db.query(`RESET ROLE`);
  check('Un usuario dado de baja no puede (no autorizado)', e2?.includes('no autorizado'), e2);
  const f = await fila(db, id);
  check('… y el stock quedó donde estaba (2)', f.cantidad === 2, JSON.stringify(f));
}

console.log(`\n${ok} pasan, ${fail} fallan de ${ok + fail}`);
process.exit(fail ? 1 : 0);
