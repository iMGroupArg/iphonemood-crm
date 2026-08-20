-- PASO 1 — LISTADO DE TODOS LOS TRADE-IN (solo lectura, no modifica nada)
--
-- Muestra cada equipo recibido en parte de pago, con sus datos, y avisa
-- si ya está en el stock o si falta cargarlo.
--
-- Pegar en Supabase -> SQL Editor -> Run.

SELECT
  v.id                                          AS venta,
  COALESCE(v.fecha_venta::text, v.creado_en::date::text) AS fecha,
  v.cliente,
  COALESCE(v.trade_in_data->>'modelo', v.trade_in_modelo) AS modelo,
  v.trade_in_data->>'storage'                   AS storage,
  v.trade_in_data->>'color'                     AS color,
  v.trade_in_data->>'imei'                      AS imei,
  v.trade_in_data->>'bateriaPct'                AS bateria,
  v.trade_in_data->>'estadoProducto'            AS estado,
  COALESCE(v.trade_in_data->>'grado', 'Sin grado') AS grado,
  v.trade_in_valor                              AS valor_usd,
  v.trade_in_data->>'notas'                     AS notas,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM stock s
      WHERE v.trade_in_data->>'imei' IS NOT NULL
        AND v.trade_in_data->>'imei' <> ''
        AND s.imeis @> ARRAY[v.trade_in_data->>'imei']
    ) THEN 'YA ESTA EN STOCK'
    ELSE 'FALTA CARGAR'
  END                                           AS situacion
FROM ventas v
WHERE v.trade_in_modelo IS NOT NULL
   OR v.trade_in_data IS NOT NULL
ORDER BY COALESCE(v.fecha_venta::text, v.creado_en::date::text) DESC;
