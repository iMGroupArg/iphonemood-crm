-- Recupera el iPhone 16 recibido como trade-in que no llegó a entrar al stock.
-- Pegar en Supabase -> SQL Editor -> Run.
--
-- Datos tomados de la venta: iPhone 16 / Blanco / 128GB / IMEI 350470399181735
-- batería 89% / Excelente / valor tomado USD 540.
-- Entra con precio_ars = 0 (sin tasar), así NO se publica en la web
-- hasta que le pongas precio desde el CRM.

-- Protegido contra duplicados: si el IMEI ya está en stock, no inserta nada.
-- (Se puede correr varias veces sin riesgo.)
INSERT INTO stock (
  categoria, nombre, modelo, storage, color,
  costo_usd, cotizacion, precio_ars,
  cantidad, imeis,
  proveedor, notas,
  bateria_pct, estado_producto, grado, estado_inventario
)
SELECT
  'iphone',
  'iPhone 16 128GB Blanco',
  'iPhone 16',
  '128GB',
  'Blanco',
  540,        -- valor que le reconociste al cliente
  1565,       -- blue del momento de la venta
  0,          -- sin tasar: no aparece en la web hasta ponerle precio
  1,
  ARRAY['350470399181735'],
  'Trade-In',
  'Recuperado a mano: el alta automática falló por precio_ars obligatorio',
  89,
  'Excelente',
  'Sin grado',
  'disponible'
WHERE NOT EXISTS (
  SELECT 1 FROM stock WHERE imeis @> ARRAY['350470399181735']
);

-- Verificación: debería devolver 1 fila
SELECT id, nombre, cantidad, imeis, proveedor, precio_ars, estado_inventario
FROM stock WHERE proveedor = 'Trade-In';
