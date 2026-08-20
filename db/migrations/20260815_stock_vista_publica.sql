-- Vista pública del catálogo para la landing (precios.html).
--
-- APLICADA el 15-08-2026. Junto con el cambio de precios.html, que ahora
-- consulta `stock_publico` en vez de `stock`.
--
-- Por qué: la landing consultaba la tabla `stock` directo con la anon key,
-- que viaja al navegador. Eso dejaba a la vista de cualquiera el costo de
-- compra, el precio mayorista, el costo de reparación, el precio de reventa,
-- el proveedor, y los IMEI y números de serie de todo el inventario.
--
-- La vista expone solo columnas de catálogo, con el precio y las unidades
-- YA calculados: ningún dato de costo sale de la base, ni siquiera derivado.
--
-- El WHERE replica el filtro que antes hacía el JS: los equipos sin tasar
-- entran con precio_ars = 0 a propósito para no publicarse, y esa regla
-- ahora vive acá en vez de depender de que el frontend se acuerde.

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
  ROUND(s.precio_ars::numeric / NULLIF(s.cotizacion, 0)::numeric)::int AS precio_usd,
  GREATEST(
    COALESCE(array_length(s.imeis, 1), 0),
    COALESCE(s.cantidad, 0)
  )::int AS unidades
FROM public.stock s
WHERE s.estado_inventario = 'disponible'
  AND COALESCE(s.precio_ars, 0) > 0
  AND COALESCE(s.cotizacion, 0) > 0;

GRANT SELECT ON public.stock_publico TO anon, authenticated;
