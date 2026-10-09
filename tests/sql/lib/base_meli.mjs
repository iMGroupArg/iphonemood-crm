// Base común de los bancos de pruebas de Mercado Libre contra Postgres real (pglite): esquema mínimo + los archivos
// REALES de db/pendientes en el orden de corrida, con los privilegios por defecto de Supabase.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AQUI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');   // tests/sql
export const SQL = f => fs.readFileSync(path.join(AQUI, '../../db/pendientes/', f), 'utf8');
export const SECRETO = 'secreto-de-prueba-para-vincular-0123456789';   // sólo para estas pruebas


// El parche que se le propone a Ventas+Cueva (una línea + recargar `o`), aplicado SÓLO a meli_procesar_orden.
export function ventasConParche(sql) {
  if (sql.includes('o := public.meli__revalidar_orden(o.id);')) return sql;   // Ventas+Cueva ya lo aplicó en su archivo
  const ini = sql.indexOf('FUNCTION public.meli_procesar_orden');
  const marca = "  SELECT * INTO o FROM public.meli_ordenes WHERE id = p_orden_id FOR UPDATE;\n  IF NOT FOUND THEN RAISE EXCEPTION 'ORDEN_INEXISTENTE'; END IF;\n";
  const i = sql.indexOf(marca, ini);
  if (ini < 0 || i < 0) throw new Error('No encuentro el lugar del parche en meli_procesar_orden');
  const fin = i + marca.length;
  return sql.slice(0, fin) + '  o := public.meli__revalidar_orden(o.id);\n' + sql.slice(fin);
}

// Esquema mínimo que imita el de producción (tablas, roles, auth.jwt, is_authorized_user) y los privilegios por defecto
// de Supabase. Lo usan pglite (una conexión) y el banco de concurrencia (Postgres real, varias conexiones).
export const ESQUEMA_MINIMO = `
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
    -- Como Supabase: toda tabla y secuencia nueva en public nace con todo para anon y authenticated.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
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
      modelo TEXT, storage TEXT, color TEXT, estado_producto TEXT, bateria_pct INT, imagen_url TEXT, combo_items JSONB,
      precio_ars NUMERIC, cotizacion NUMERIC, costo_usd NUMERIC(18,2) DEFAULT 0,
      cantidad INTEGER DEFAULT 0, imeis TEXT[] DEFAULT '{}', estado_inventario TEXT DEFAULT 'disponible');
    CREATE TABLE public.stock_movimientos (id BIGSERIAL PRIMARY KEY, stock_id UUID, tipo TEXT, detalle TEXT,
      cantidad_antes INT, cantidad_despues INT, usuario_nombre TEXT, datos JSONB, creado_en TIMESTAMPTZ DEFAULT now());
    CREATE TABLE public.reparacion_repuestos (id BIGSERIAL PRIMARY KEY);
    CREATE TABLE public.configuracion (clave TEXT PRIMARY KEY, valor TEXT);
    CREATE TABLE public.ventas (id BIGSERIAL PRIMARY KEY, cliente TEXT, vendedor_id UUID, estado TEXT, tipo_venta TEXT,
      fecha_venta DATE, creado_en TIMESTAMPTZ DEFAULT now());
    CREATE TABLE public.venta_items (id BIGSERIAL PRIMARY KEY, venta_id BIGINT REFERENCES public.ventas(id) ON DELETE CASCADE,
      stock_id UUID, imei TEXT, nombre TEXT, costo_usd NUMERIC, precio_usd NUMERIC, es_regalo BOOLEAN DEFAULT false);
    CREATE TABLE public.venta_pagos (id BIGSERIAL PRIMARY KEY, venta_id BIGINT REFERENCES public.ventas(id) ON DELETE CASCADE,
      persona_id UUID, bolsillo TEXT, monto NUMERIC, es_tarjeta BOOLEAN DEFAULT false, diferencial_ars NUMERIC DEFAULT 0, cotizacion_diferencial NUMERIC);
    INSERT INTO public.usuarios_autorizados VALUES ('franco@x.com', true), ('baja@x.com', false);
`;

export async function baseNueva({ conVentas = true, base3 = null, sin7 = false } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(ESQUEMA_MINIMO);
  await db.exec(SQL('caja_aplicar_delta.sql'));
  await db.exec(SQL('stock_a_pedido.sql'));
  await db.exec(base3 ?? SQL('meli_esquema_base.sql'));
  if (!sin7) await db.exec(SQL('meli_vincular.sql'));
  // El hash sembrado es el del secreto REAL; para probar se pone el de uno de prueba (nunca se lee el real).
  await db.query(`UPDATE public.meli_config SET valor = $1 WHERE clave = 'rpc_secret_sha256'`,
    [crypto.createHash('sha256').update(SECRETO).digest('hex')]);
  if (conVentas) await db.exec(ventasConParche(SQL('meli_ventas_migration.sql')));
  await db.exec(`SELECT set_config('request.jwt.claims', '{"email":"franco@x.com"}', false)`);
  const { rows: [p] } = await db.query(`INSERT INTO public.personas (nombre) VALUES ('Franco') RETURNING id`);
  await db.query(`INSERT INTO public.cajas (persona_id, bolsillo, saldo) VALUES ($1,'ARS Mercado Pago',0)`, [p.id]);
  const { rows: [c] } = await db.query(
    `INSERT INTO public.meli_cuentas (meli_user_id, nickname, persona_id, bolsillo) VALUES ('999','FRANCO',$1,'ARS Mercado Pago') RETURNING id`, [p.id]);
  return { db, cuentaId: c.id };
}

export const comoRol = async (db, rol, email, fn) => {
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [email ? JSON.stringify({ email }) : '{}']);
  await db.query(`SET ROLE ${rol}`);
  try { return await fn(); } finally {
    await db.query('RESET ROLE');
    await db.query(`SELECT set_config('request.jwt.claims', '{"email":"franco@x.com"}', false)`);
  }
};

export const nuevoStock = async (db, { nombre = 'Perfume X 100ml', categoria = 'perfumeria', cantidad = 5, imeis = [], estado = 'disponible', aPedido = false } = {}) =>
  (await db.query(`INSERT INTO public.stock (nombre, categoria, cantidad, imeis, estado_inventario, a_pedido, costo_usd)
                   VALUES ($1,$2,$3,$4,$5,$6,30) RETURNING id`, [nombre, categoria, cantidad, imeis, estado, aPedido])).rows[0].id;

// Una orden ya ingresada, con ítems que pueden no tener stock todavía.
let seq = 0;
export async function nuevaOrden(ctx, items, { revisar = false, motivo = null, neto = 85000, bruto = 100000 } = {}) {
  const { db, cuentaId } = ctx;
  const { rows: [r] } = await db.query(
    `INSERT INTO public.meli_ordenes (cuenta_id, meli_order_id, estado, comprador, fecha_orden, moneda, bruto, neto, comision_envio,
        pago_id, fecha_liberacion, revisar, motivo_revisar, financiera_completa, neto_confirmado)
     VALUES ($1,$2,'paid','c', now(),'ARS',$3::numeric,$4::numeric,$3::numeric - $4::numeric,'p1', now() - interval '1 day', $5,$6,true,$4::numeric) RETURNING id`,
    [cuentaId, `ORD-${++seq}`, bruto, neto, revisar, motivo]);
  for (const it of items) {
    await db.query(`INSERT INTO public.meli_orden_items (orden_id, meli_item_id, meli_variacion_id, titulo, cantidad, precio_unitario, stock_id)
                    VALUES ($1,$2,$3,'t',$4,$5,$6)`, [r.id, it.item, it.var ?? null, it.cant ?? 1, it.precio ?? bruto, it.stock ?? null]);
  }
  return r.id;
}

