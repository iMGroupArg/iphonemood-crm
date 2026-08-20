-- Estado del producto en los items de una orden de compra.
-- Hasta ahora todo lo que entraba por Proveedores se daba de alta como
-- "Nuevo / Sellado" fijo, aunque al proveedor se le compraran equipos usados.
-- Con esta columna el estado se elige al cargar la orden y viaja al stock.
ALTER TABLE public.lote_items
  ADD COLUMN IF NOT EXISTS estado_producto TEXT DEFAULT 'Nuevo / Sellado';
