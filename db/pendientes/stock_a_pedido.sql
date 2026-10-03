-- ============================================================================
--  stock.a_pedido — productos "a pedido" (sin stock físico)
--
--  PENDIENTE DE CORRER EN PRODUCCIÓN. Probado sobre Postgres real (pglite) con
--  tests/sql/stock.sql.test.mjs. Pedido por Stock/Inventario; escrito por Deploy-infra.
--  Es idempotente: se puede correr dos veces.
--
--  SEMÁNTICA (cerrada con Stock)
--  Una fila con a_pedido = true no tiene unidades físicas: se consigue después de que
--  el cliente la pide. Sobre ella, descontar y reponer NO tocan la cantidad (nunca
--  falla por falta de stock ni queda negativa) pero SÍ dejan el movimiento. Nunca pasa
--  a 'vendido': conserva su estado, y 0 unidades + 'disponible' es lo correcto. Eso lo
--  implementan stock_ajustar (stock_ajustar_rpc.sql) y meli__descontar_core /
--  meli_reponer_stock (meli_esquema_base.sql). Acá van la columna, su CHECK y la vista.
--
--  Una fila a pedido no puede tener IMEI ni ser de un rubro con IMEI (iphone, android,
--  mac, ipad — la misma lista que CATS_IMEI en stock.js). Y no se vincula a Mercado
--  Libre: eso lo cierran dos triggers en meli_esquema_base.sql.
--
--  ORDEN: cualquiera respecto de los otros dos archivos. Cada uno repite el
--  ADD COLUMN IF NOT EXISTS para no depender de este.
-- ============================================================================

BEGIN;

ALTER TABLE public.stock ADD COLUMN IF NOT EXISTS a_pedido BOOLEAN NOT NULL DEFAULT FALSE;

-- Sin IMEI y sin rubro con IMEI. Se rechaza a nivel base porque el cliente se puede
-- saltear (guardarProductoStock manda la fila entera). `categoria` NULL pasa: un CHECK
-- sólo falla cuando da FALSE, y COALESCE lo vuelve '' que no está en la lista. Las
-- filas existentes tienen a_pedido = false, así que la validación no las toca.
ALTER TABLE public.stock DROP CONSTRAINT IF EXISTS stock_a_pedido_sin_imei;
ALTER TABLE public.stock ADD CONSTRAINT stock_a_pedido_sin_imei CHECK (
  NOT a_pedido
  OR (COALESCE(array_length(imeis, 1), 0) = 0
      AND lower(COALESCE(categoria, '')) NOT IN ('iphone', 'android', 'mac', 'ipad'))
);

-- Vista pública: se agrega `a_pedido` AL FINAL (CREATE OR REPLACE VIEW sólo admite
-- columnas nuevas al final). El resto es idéntico a la definición VIGENTE, la de
-- migrations/20260829_precio_ars_publico.sql (13 columnas, comprobadas contra la API el
-- 2026-10-03: ..., combo_items, precio_usd, precio_ars, unidades). OJO: NO copiar la de
-- 20260815_stock_vista_publica.sql, que es anterior y no tiene combo_items ni
-- precio_ars: reemplazar la vista con menos columnas aborta. Si alguien cambió la vista
-- después, este reemplazo tiene que reflejarlo antes de correrse.
-- Una fila a pedido con 0 unidades y 'disponible' SÍ se publica (el filtro es por
-- estado y precio, no por unidades).
CREATE OR REPLACE VIEW public.stock_publico
WITH (security_invoker = false) AS
SELECT
  s.id,
  s.nombre,
  s.categoria,
  s.modelo,
  s.storage,
  s.color,
  s.estado_producto,
  s.bateria_pct,
  s.imagen_url,
  s.combo_items,
  ROUND(s.precio_ars::numeric / NULLIF(s.cotizacion, 0)::numeric)::int AS precio_usd,
  ROUND(s.precio_ars::numeric)::int AS precio_ars,
  GREATEST(
    COALESCE(array_length(s.imeis, 1), 0),
    COALESCE(s.cantidad, 0)
  )::int AS unidades,
  COALESCE(s.a_pedido, FALSE) AS a_pedido
FROM public.stock s
WHERE s.estado_inventario = 'disponible'
  AND COALESCE(s.precio_ars, 0) > 0
  AND COALESCE(s.cotizacion, 0) > 0;

GRANT SELECT ON public.stock_publico TO anon, authenticated;

-- Pedido aparte por Stock: la devolución de un repuesto de reparación.
ALTER TABLE public.reparacion_repuestos ADD COLUMN IF NOT EXISTS devolucion_estado TEXT;

COMMIT;
