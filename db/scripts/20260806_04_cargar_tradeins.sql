-- PASO 2 — CARGA AUTOMÁTICA DE LOS TRADE-IN FALTANTES
--
-- Corré esto DESPUÉS de revisar el listado del paso 1.
-- Da de alta en stock todos los equipos recibidos en parte de pago
-- que todavía no estén cargados.
--
-- Criterios:
--   * precio_ars = 0  -> entra SIN TASAR, no se publica en la web
--                        hasta que le pongas precio desde el CRM.
--   * costo_usd       -> el valor que le reconociste al cliente.
--   * cotizacion      -> la del día de la venta si quedó registrada;
--                        si no, 1600 (ajustá el valor si preferís otro).
--   * No duplica: saltea los que ya tienen ese IMEI en stock, y saltea
--                 los que ya fueron cargados por este mismo script.

INSERT INTO stock (
  categoria, nombre, modelo, storage, color,
  costo_usd, cotizacion, precio_ars,
  cantidad, imeis,
  proveedor, notas,
  bateria_pct, estado_producto, grado, estado_inventario
)
SELECT
  COALESCE(NULLIF(v.trade_in_data->>'cat', ''), 'iphone'),
  TRIM(CONCAT_WS(' ',
    COALESCE(v.trade_in_data->>'modelo', v.trade_in_modelo),
    NULLIF(v.trade_in_data->>'storage', ''),
    NULLIF(v.trade_in_data->>'color', '')
  )),
  COALESCE(v.trade_in_data->>'modelo', v.trade_in_modelo),
  NULLIF(v.trade_in_data->>'storage', ''),
  NULLIF(v.trade_in_data->>'color', ''),
  v.trade_in_valor,
  1600,
  0,
  1,
  CASE
    WHEN COALESCE(v.trade_in_data->>'imei', '') <> ''
    THEN ARRAY[v.trade_in_data->>'imei']
    ELSE ARRAY[]::text[]
  END,
  'Trade-In',
  CONCAT('Trade-in de venta #', v.id, ' — ', v.cliente,
         ' (cargado a mano el ', CURRENT_DATE, ')'),
  NULLIF(v.trade_in_data->>'bateriaPct', '')::numeric,
  NULLIF(v.trade_in_data->>'estadoProducto', ''),
  COALESCE(NULLIF(v.trade_in_data->>'grado', ''), 'Sin grado'),
  'disponible'
FROM ventas v
WHERE (v.trade_in_modelo IS NOT NULL OR v.trade_in_data IS NOT NULL)
  AND v.trade_in_valor > 0
  -- no volver a cargar los que ya están por IMEI
  AND NOT EXISTS (
    SELECT 1 FROM stock s
    WHERE COALESCE(v.trade_in_data->>'imei', '') <> ''
      AND s.imeis @> ARRAY[v.trade_in_data->>'imei']
  )
  -- no volver a cargar si este script ya lo dio de alta
  AND NOT EXISTS (
    SELECT 1 FROM stock s2
    WHERE s2.proveedor = 'Trade-In'
      AND s2.notas LIKE CONCAT('Trade-in de venta #', v.id, ' —%')
  );

-- Verificación: lista todo lo que quedó cargado como Trade-In
SELECT id, nombre, cantidad, imeis, costo_usd, precio_ars, estado_inventario, notas
FROM stock
WHERE proveedor = 'Trade-In'
ORDER BY creado_en DESC;
