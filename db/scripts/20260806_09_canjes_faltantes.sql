-- ============================================================
-- CANJES QUE FALTAN CARGAR  (reemplaza la PARTE 4 del archivo 6)
--
-- De los 8 canjes que aparecen en las ventas, 5 ya estan en el stock
-- (cargados a mano en su momento). Solo faltan 3.
--
-- Los inserta uno por uno, con su costo real y su IMEI fisico,
-- para no duplicar nada.
-- ============================================================


-- ── 1) Venta #39 · Marina Borda · iPhone 16 Pro Max · USD 830 ──
-- Bateria 98% coincide con el equipo fisico IMEI 352864977343634.
-- Queda EN STOCK (esta en el local).
INSERT INTO stock (categoria, nombre, modelo, storage, color,
                   costo_usd, cotizacion, precio_ars, cantidad, imeis,
                   proveedor, notas, bateria_pct, estado_producto, grado, estado_inventario)
SELECT 'iphone', 'iPhone 16 Pro Max 256GB Titanio Desierto', 'iPhone 16 Pro Max', '256GB', 'Titanio Desierto',
       830, 1600, 0, 1, ARRAY['352864977343634'],
       'Trade-In', 'Trade-in de venta #39 — Marina Borda', 98, 'Excelente', 'Sin grado', 'disponible'
WHERE NOT EXISTS (SELECT 1 FROM stock WHERE imeis @> ARRAY['352864977343634']);


-- ── 2) Venta #44 · Kiara Guzmán · iPhone 15 Pro Max · USD 540 ──
-- Bateria 87%: es el que TENES EN LA OFICINA (relevado con 88%).
-- Queda EN STOCK.
INSERT INTO stock (categoria, nombre, modelo, storage, color,
                   costo_usd, cotizacion, precio_ars, cantidad, imeis,
                   proveedor, notas, bateria_pct, estado_producto, grado, estado_inventario)
SELECT 'iphone', 'iPhone 15 Pro Max 256GB Titanio Natural', 'iPhone 15 Pro Max', '256GB', 'Titanio Natural',
       540, 1600, 0, 1, ARRAY['354379771684487'],
       'Trade-In', 'Trade-in de venta #44 — Kiara Guzmán', 88, 'Con detalles', 'C', 'disponible'
WHERE NOT EXISTS (SELECT 1 FROM stock WHERE imeis @> ARRAY['354379771684487']);


-- ── 3) Venta #41 · Morena Eva Quartero · iPhone 15 Pro Max · USD 670 ──
-- Bateria 85%: es el que VENDISTE y falta cargar la venta.
-- Entra RESERVADO, sin IMEI (no lo tenemos).
INSERT INTO stock (categoria, nombre, modelo, storage, color,
                   costo_usd, cotizacion, precio_ars, cantidad, imeis,
                   proveedor, notas, bateria_pct, estado_producto, grado, estado_inventario)
SELECT 'iphone', 'iPhone 15 Pro Max 256GB Titanio Natural', 'iPhone 15 Pro Max', '256GB', 'Titanio Natural',
       670, 1600, 0, 1, ARRAY[]::text[],
       'Trade-In', 'Trade-in de venta #41 — Morena Eva Quartero · RESERVADO: vendido, falta cargar la venta',
       85, 'Con detalles', 'Sin grado', 'disponible'
WHERE NOT EXISTS (SELECT 1 FROM stock
                  WHERE notas LIKE 'Trade-in de venta #41 —%');


-- ── Verificacion ──
SELECT nombre, imeis, costo_usd, bateria_pct, notas
FROM stock WHERE proveedor = 'Trade-In' ORDER BY nombre;
