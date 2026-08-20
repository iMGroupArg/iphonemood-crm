-- ============================================================
-- CIERRE DE STOCK contra el relevamiento del 30-07-2026
--
-- Corré las partes EN ORDEN, una por vez, mirando el resultado.
-- Objetivo: dejar el sistema en los 30 equipos relevados
--           + 2 iPhone 17 Pro reservados para la venta pendiente.
-- ============================================================


-- ════════ PARTE 1 · Corregir IMEIs mal tipeados ════════
-- (no borra nada)

UPDATE stock SET imeis = ARRAY['359447962894861']
 WHERE imeis @> ARRAY['659447962894861'];          -- 16 Pro Max Desert: 6 -> 3

UPDATE stock SET imeis = ARRAY['350332842726146'], cantidad = 1
 WHERE id = '643ab38e-f6be-4100-85ad-9d8fca31d2b6'; -- 17 Pro Plata: digito repetido + sobraba 1 u.

UPDATE stock SET imeis = ARRAY['351698479040533']
 WHERE imeis @> ARRAY['3516984791140533'];          -- 15 Negro: digito de mas


-- ════════ PARTE 2 · Completar IMEIs faltantes ════════
-- Equipos que ya estaban cargados, pero sin numero de serie.

UPDATE stock SET imeis = ARRAY['350015752735310','356977601099285'], cantidad = 2
 WHERE id = '5d99cf70-a82f-437f-9d0b-d3c802b0ddc3';  -- 17 Pro Max Silver x2

UPDATE stock SET imeis = ARRAY['359641639704277','350795428192570'], cantidad = 2
 WHERE id = '0342909b-995e-45e0-a2dc-3a34ee4bcef4';  -- iPhone 15 Blue x2

UPDATE stock SET imeis = ARRAY['358594369490586'], cantidad = 1
 WHERE id = 'd2bb30af-65e3-49cc-85df-837af635ccbb';  -- 16 Pro Max Natural

UPDATE stock SET imeis = ARRAY['359462811796316'], cantidad = 1
 WHERE id = '226ebf5d-a67e-4b79-bd8c-a033ba779507';  -- 14 Violeta

UPDATE stock SET imeis = ARRAY['356691197458603'], cantidad = 1
 WHERE id = 'cd66d6b2-af4f-4dce-b1bf-637069541049';  -- 14 Amarillo


-- ════════ PARTE 3 · Reservar los 2 iPhone 17 Pro vendidos ════════
-- Son los de las cajas fotografiadas, vendidos ayer y aun sin cargar.
-- Quedan identificados para que puedas seleccionarlos por IMEI
-- cuando registres la venta (y ahi se descuenten solos).

UPDATE stock
   SET imeis = ARRAY['355175312068134','353621848757478'],
       cantidad = 2,
       notas = 'Lote #2 — RESERVADOS: vendidos, falta cargar la venta'
 WHERE id = '980ad369-ce5d-48e8-8143-c8fda0246137';

-- El iPhone 13 Rosa de bateria 100% tambien se vendio y falta cargarlo.
-- (Los otros dos Rosa, de 86%, son los que si estan en el local.)
UPDATE stock
   SET notas = 'RESERVADO: vendido, falta cargar la venta'
 WHERE imeis @> ARRAY['355939491030201'];


-- ════════ PARTE 4 · Canjes faltantes ════════
-- ⚠️ NO se hace aca. Usar el archivo 7_canjes_faltantes.sql.
--    La version generica de esta parte duplicaba equipos: los canjes
--    de las ventas #9, #18 y #20 no guardaron IMEI, y ya estaban
--    cargados a mano en el stock.


-- ════════ PARTE 5 · Dar de baja lo vendido ════════
-- ⚠️ ESTO BORRA. Correr solo despues de revisar la Parte 4.

-- Vendido y YA cargado en el sistema (no hay venta pendiente por el):
DELETE FROM stock WHERE imeis @> ARRAY['353621841928399'];  -- 17 Pro Plata

-- OJO: el 13 Rosa 355939491030201 NO se borra. Se vendio pero la venta
-- esta pendiente de cargar, asi que queda reservado (ver Parte 3).

-- Unidades sin IMEI que no corresponden a nada fisico
-- (vendidas y nunca descontadas; no hay mercaderia por llegar):
DELETE FROM stock WHERE id = '186a5fba-3e0c-4272-afb1-d94b642a3d35'; -- 2 u. 17 Pro  Lote #4
DELETE FROM stock WHERE id = '558f6323-2d68-4f47-ad25-09bf7c90fd59'; -- 17 Pro Azul Profundo
DELETE FROM stock WHERE id = '005cc0b5-f635-4fd2-ba4c-c9c531bd42f2'; -- 17 Pro Azul Profundo
DELETE FROM stock WHERE id = 'd4fb4142-a500-4b36-8f47-c91dd40ab827'; -- 17 Pro Max Plata Lote #3
DELETE FROM stock WHERE id = 'd3d0329d-8341-4463-a4fc-62ddb3521fdd'; -- 14 Medianoche
DELETE FROM stock WHERE id = '393335e5-566f-48a9-961c-b15089eb1064'; -- 14 Pro Max 128GB


-- ════════ VERIFICACION FINAL ════════
-- Esperado: 30 relevadas + 3 reservadas (2 x 17 Pro + 1 x 13 Rosa) = 33
SELECT
  sum(GREATEST(coalesce(array_length(imeis,1),0), cantidad)) AS unidades,
  count(*) AS filas
FROM stock WHERE categoria = 'iphone' AND nombre NOT ILIKE '%cargador%';

SELECT nombre, cantidad, imeis, costo_usd, proveedor, notas
FROM stock WHERE categoria='iphone' ORDER BY nombre;
