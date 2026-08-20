-- PASO 3 — Borrar el iPhone 16 duplicado
--
-- Se cargó dos veces (20:51:28 y 20:52:15), mismo IMEI 350470399181735.
-- Esto borra SOLO la segunda copia, por id exacto. La primera queda.

DELETE FROM stock
WHERE id = '63ba2a72-89e9-454d-a2b2-ed9d423ad190';

-- Verificación: tiene que quedar UNA sola fila
SELECT id, nombre, imeis, costo_usd, cotizacion, precio_ars, creado_en
FROM stock
WHERE proveedor = 'Trade-In'
ORDER BY creado_en;


-- ─────────────────────────────────────────────────────────────
-- OPCIONAL — Ajustar la cotización a mano
--
-- No hace falta para que los precios salgan bien (ver explicación),
-- pero si querés dejarla igual a la del día de la venta, descomentá
-- las 3 líneas de abajo y poné el valor que quieras.
-- ─────────────────────────────────────────────────────────────

-- UPDATE stock
--    SET cotizacion = 1565          -- <- poné acá la cotización que quieras
--  WHERE id = 'ffbc5499-7b38-493a-9419-0928dffe6623';


-- Si más adelante querés cambiarle la cotización a TODOS los trade-in
-- que cargó el script masivo (los que quedaron en 1600):
--
-- UPDATE stock
--    SET cotizacion = 1565          -- <- valor deseado
--  WHERE proveedor = 'Trade-In' AND cotizacion = 1600 AND precio_ars = 0;
