-- Expone el precio en PESOS en la vista pública.
--
-- El problema que resuelve: la vista solo publicaba `precio_usd`, calculado
-- como ROUND(precio_ars / cotizacion). La landing lo volvía a pesos
-- multiplicando por el blue DE HOY. Resultado: el precio en pesos de un
-- perfume se movía solo cada vez que se movía el dólar, aunque el perfume se
-- compre y se venda en pesos y su costo no siga al dólar.
--
-- Además el redondeo a dólares enteros dejaba un escalón de precio enorme:
-- con el blue a 1580, el mínimo que se podía subir o bajar un perfume era
-- $1.580. No se podía poner $9.500: quedaba en $9.480.
--
-- Con `precio_ars` publicado, la landing usa el número tal cual se cargó en
-- el CRM para los rubros que se venden en pesos (perfumería, decants y
-- combos), y sigue usando el dólar para los equipos.
--
-- `precio_usd` NO se saca: los equipos lo siguen usando y las fichas y
-- presupuestos lo muestran.
--
-- DROP + CREATE, no CREATE OR REPLACE: REPLACE no puede insertar una columna
-- en el medio de la lista (error 42P16 "cannot change name of view column").
-- Los dos van en la misma transacción, así que la vista nunca queda ausente
-- para la landing.

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
  ROUND(s.precio_ars::numeric)::int AS precio_ars,
  GREATEST(
    COALESCE(array_length(s.imeis, 1), 0),
    COALESCE(s.cantidad, 0)
  )::int AS unidades
FROM public.stock s
WHERE s.estado_inventario = 'disponible'
  AND COALESCE(s.precio_ars, 0) > 0
  AND COALESCE(s.cotizacion, 0) > 0;

GRANT SELECT ON public.stock_publico TO anon, authenticated;
