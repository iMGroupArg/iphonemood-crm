-- Contenido de un combo de perfumería.
--
-- Un combo es un paquete que se vende a un precio: puede ser 5 decants, 3
-- perfumes completos, o una mezcla. `combo_items` guarda qué incluye, un
-- ítem por renglón, en texto libre.
--
-- Por qué texto y no una tabla con referencias al stock: la versión enlazada
-- (que descontaría cada componente al vender el combo) toca Stock, Ventas y
-- Caja. Se descartó por ahora a propósito. OJO CON ESTO: vender un combo NO
-- descuenta sus componentes del inventario, hay que hacerlo a mano.
--
-- Es nullable y sin default: los productos que no son combo lo dejan en NULL
-- y nada cambia para ellos.

ALTER TABLE stock ADD COLUMN IF NOT EXISTS combo_items text;

-- La vista pública tiene que exponerlo para que la landing lo muestre.
-- Se recrea igual que en 20260815_stock_vista_publica.sql, sumando la columna.
--
-- DROP + CREATE, no CREATE OR REPLACE: REPLACE no puede insertar una columna
-- en el medio de la lista (error 42P16 "cannot change name of view column").
-- Al fallar, TODO el script se revertía, incluido el ALTER TABLE de arriba.
-- El DROP y el CREATE corren juntos en la misma transacción, así que la vista
-- nunca queda ausente para la landing.
DROP VIEW IF EXISTS public.stock_publico;
CREATE VIEW public.stock_publico
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
  GREATEST(
    COALESCE(array_length(s.imeis, 1), 0),
    COALESCE(s.cantidad, 0)
  )::int AS unidades
FROM public.stock s
WHERE s.estado_inventario = 'disponible'
  AND COALESCE(s.precio_ars, 0) > 0
  AND COALESCE(s.cotizacion, 0) > 0;

GRANT SELECT ON public.stock_publico TO anon, authenticated;
