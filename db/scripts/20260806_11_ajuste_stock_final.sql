-- ============================================================================
--  AJUSTE DE STOCK — ARCHIVO ÚNICO
--  iPhoneMood · contra el relevamiento físico del 30-07-2026
--
--  Corré TODO de una vez (seleccionar todo → Run).
--
--  Va dentro de una transacción: si algo falla, NO queda nada a medias,
--  se deshace todo solo y podés volver a intentar.
--
--  Punto de partida : 43 equipos disponibles
--  Resultado esperado: 33 equipos disponibles
--                      (30 relevados + 3 vendidos con venta pendiente,
--                       menos el 16 Pro que entra al cargar su venta)
-- ============================================================================

BEGIN;


-- ─────────────────────────────────────────────────────────────
--  1 · CORREGIR IMEIs MAL TIPEADOS
-- ─────────────────────────────────────────────────────────────

-- iPhone 16 Pro Max Titanio Desierto: empezaba con 6 en lugar de 3
UPDATE stock SET imeis = ARRAY['359447962894861']
 WHERE imeis @> ARRAY['659447962894861'];

-- iPhone 17 Pro Plata: tenía un dígito repetido (16 en vez de 15)
-- y además figuraban 2 unidades cuando hay 1.
UPDATE stock SET imeis = ARRAY['350332842726146'], cantidad = 1
 WHERE id = '643ab38e-f6be-4100-85ad-9d8fca31d2b6';

-- iPhone 15 Negro: tenía un dígito de más
UPDATE stock SET imeis = ARRAY['351698479040533']
 WHERE imeis @> ARRAY['3516984791140533'];


-- ─────────────────────────────────────────────────────────────
--  2 · COMPLETAR IMEIs QUE FALTABAN
--      Equipos que ya estaban cargados pero sin número de serie.
-- ─────────────────────────────────────────────────────────────

-- iPhone 17 Pro Max Silver x2 (nuevos)
UPDATE stock SET imeis = ARRAY['350015752735310','356977601099285'], cantidad = 2
 WHERE id = '5d99cf70-a82f-437f-9d0b-d3c802b0ddc3';

-- iPhone 15 Blue x2 (nuevos)
UPDATE stock SET imeis = ARRAY['359641639704277','350795428192570'], cantidad = 2
 WHERE id = '0342909b-995e-45e0-a2dc-3a34ee4bcef4';

-- iPhone 16 Pro Max Titanio Natural
UPDATE stock SET imeis = ARRAY['358594369490586'], cantidad = 1
 WHERE id = 'd2bb30af-65e3-49cc-85df-837af635ccbb';

-- iPhone 14 Violeta
UPDATE stock SET imeis = ARRAY['359462811796316'], cantidad = 1
 WHERE id = '226ebf5d-a67e-4b79-bd8c-a033ba779507';

-- iPhone 14 Amarillo
UPDATE stock SET imeis = ARRAY['356691197458603'], cantidad = 1
 WHERE id = 'cd66d6b2-af4f-4dce-b1bf-637069541049';


-- ─────────────────────────────────────────────────────────────
--  3 · RESERVAR LOS VENDIDOS CON VENTA PENDIENTE
--      No se borran: quedan identificados por IMEI para que los
--      selecciones al registrar la venta y se descuenten solos.
-- ─────────────────────────────────────────────────────────────

-- Los 2 iPhone 17 Pro de las cajas fotografiadas
UPDATE stock
   SET imeis    = ARRAY['355175312068134','353621848757478'],
       cantidad = 2,
       notas    = 'Lote #2 — RESERVADOS: vendidos, falta cargar la venta'
 WHERE id = '980ad369-ce5d-48e8-8143-c8fda0246137';

-- El iPhone 13 Rosa de batería 100% (los otros dos, de 86%, sí están)
UPDATE stock
   SET notas = 'RESERVADO: vendido, falta cargar la venta'
 WHERE imeis @> ARRAY['355939491030201'];


-- ─────────────────────────────────────────────────────────────
--  4 · DAR DE ALTA LOS CANJES QUE FALTABAN
--      Con el costo real que le reconociste a cada cliente.
--      Los otros 5 canjes ya estaban cargados a mano.
-- ─────────────────────────────────────────────────────────────

-- Venta #39 · Marina Borda · iPhone 16 Pro Max · USD 830 · queda EN STOCK
INSERT INTO stock (categoria, nombre, modelo, storage, color,
                   costo_usd, cotizacion, precio_ars, cantidad, imeis,
                   proveedor, notas, bateria_pct, estado_producto, grado, estado_inventario)
SELECT 'iphone', 'iPhone 16 Pro Max 256GB Titanio Desierto', 'iPhone 16 Pro Max', '256GB', 'Titanio Desierto',
       830, 1600, 0, 1, ARRAY['352864977343634'],
       'Trade-In', 'Trade-in de venta #39 — Marina Borda', 98, 'Excelente', 'Sin grado', 'disponible'
WHERE NOT EXISTS (SELECT 1 FROM stock WHERE imeis @> ARRAY['352864977343634']);

-- Venta #44 · Kiara Guzmán · iPhone 15 Pro Max · USD 540 · el de TU OFICINA
INSERT INTO stock (categoria, nombre, modelo, storage, color,
                   costo_usd, cotizacion, precio_ars, cantidad, imeis,
                   proveedor, notas, bateria_pct, estado_producto, grado, estado_inventario)
SELECT 'iphone', 'iPhone 15 Pro Max 256GB Titanio Natural', 'iPhone 15 Pro Max', '256GB', 'Titanio Natural',
       540, 1600, 0, 1, ARRAY['354379771684487'],
       'Trade-In', 'Trade-in de venta #44 — Kiara Guzmán', 88, 'Con detalles', 'C', 'disponible'
WHERE NOT EXISTS (SELECT 1 FROM stock WHERE imeis @> ARRAY['354379771684487']);

-- Venta #41 · Morena Eva Quartero · iPhone 15 Pro Max · USD 670 · el que VENDISTE
INSERT INTO stock (categoria, nombre, modelo, storage, color,
                   costo_usd, cotizacion, precio_ars, cantidad, imeis,
                   proveedor, notas, bateria_pct, estado_producto, grado, estado_inventario)
SELECT 'iphone', 'iPhone 15 Pro Max 256GB Titanio Natural', 'iPhone 15 Pro Max', '256GB', 'Titanio Natural',
       670, 1600, 0, 1, ARRAY[]::text[],
       'Trade-In', 'Trade-in de venta #41 — Morena Eva Quartero · RESERVADO: vendido, falta cargar la venta',
       85, 'Con detalles', 'Sin grado', 'disponible'
WHERE NOT EXISTS (SELECT 1 FROM stock WHERE notas LIKE 'Trade-in de venta #41 —%');


-- ─────────────────────────────────────────────────────────────
--  5 · DAR DE BAJA LO VENDIDO QUE NUNCA SE DESCONTÓ
--      Son 8 unidades, confirmadas ausentes en el conteo físico
--      y sin venta pendiente.
--
--      NO se borran: se marcan como VENDIDO. El efecto es el mismo
--      (la web pública consulta solo estado 'disponible', y el selector
--      de ventas del CRM excluye los vendidos), pero además:
--        · no rompe el vínculo con los renglones de las ventas
--          (venta_items guarda el stock_id de cada producto vendido)
--        · queda el historial y se puede revertir
-- ─────────────────────────────────────────────────────────────

UPDATE stock SET estado_inventario = 'vendido', cantidad = 0,
       notas = COALESCE(NULLIF(notas,''),'') || ' · Baja por ajuste 31-07-2026 (vendido sin descontar)'
 WHERE imeis @> ARRAY['353621841928399'];                              -- 17 Pro Plata

UPDATE stock SET estado_inventario = 'vendido', cantidad = 0,
       notas = COALESCE(NULLIF(notas,''),'') || ' · Baja por ajuste 31-07-2026 (vendido sin descontar)'
 WHERE id IN (
   '186a5fba-3e0c-4272-afb1-d94b642a3d35',   -- 17 Pro Lote #4 (2 u.)
   '558f6323-2d68-4f47-ad25-09bf7c90fd59',   -- 17 Pro Azul Profundo
   '005cc0b5-f635-4fd2-ba4c-c9c531bd42f2',   -- 17 Pro Azul Profundo
   'd4fb4142-a500-4b36-8f47-c91dd40ab827',   -- 17 Pro Max Plata Lote #3
   'd3d0329d-8341-4463-a4fc-62ddb3521fdd',   -- 14 Medianoche
   '393335e5-566f-48a9-961c-b15089eb1064'    -- 14 Pro Max 128GB
 );


COMMIT;


-- ============================================================================
--  VERIFICACIÓN — mirá estos 3 resultados
-- ============================================================================

-- A) Total de equipos disponibles. Tiene que dar 33.
SELECT sum(GREATEST(coalesce(array_length(imeis,1),0), cantidad)) AS equipos_disponibles
FROM stock
WHERE categoria = 'iphone'
  AND estado_inventario = 'disponible'
  AND nombre NOT ILIKE '%cargador%'
  AND nombre NOT ILIKE '%funda%'
  AND nombre NOT ILIKE '%templado%'
  AND nombre NOT ILIKE '%bateria%';

-- B) Los 4 que quedan reservados esperando que cargues su venta.
SELECT nombre, imeis, costo_usd, notas
FROM stock WHERE notas ILIKE '%RESERVADO%' ORDER BY nombre;

-- C) Los que todavía no tienen costo cargado.
SELECT nombre, imeis, bateria_pct, costo_usd
FROM stock WHERE notas ILIKE '%COSTO PENDIENTE%' ORDER BY nombre;


-- ============================================================================
--  DESPUÉS DE ESTO
--
--  1) Cargá las 4 ventas pendientes en el CRM:
--       · iPhone 17 Pro  IMEI 355175312068134
--       · iPhone 17 Pro  IMEI 353621848757478
--       · iPhone 13 Rosa IMEI 355939491030201
--       · iPhone 15 Pro Max (el de la venta #41, sin IMEI)
--
--  2) ANTES de cargar la venta de los 17 Pro, borrá el iPhone 15 Negro:
--       DELETE FROM stock WHERE imeis @> ARRAY['351698479040533'];
--     Está cargado a mano y lo tomaste en parte de pago por esa venta.
--     Si no lo borrás, el candado de IMEI único va a rechazar el canje.
-- ============================================================================
