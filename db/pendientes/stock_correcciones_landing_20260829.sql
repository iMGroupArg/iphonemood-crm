-- ============================================================================
--  Tres correcciones de datos que encontró la conversación de la landing
--  consultando `stock_publico` el 2026-08-29. NADA DE ESTO ESTÁ CORRIDO.
--
--  Correr los SELECT de control primero, y recién después cada UPDATE.
-- ============================================================================


-- ──────────────────────────────────────────────────────────────
-- 1 — Un decant quedó cargado como 'gaming'
--
--     "Khamrah dukhan 5ML" aparece bajo el rubro Gaming en la web, junto a
--     las PlayStation, y queda fuera del agrupado por aroma de perfumería.
--     No lo causó la migración de rubros: aquel UPDATE filtraba por
--     nombre ILIKE '%playstation%'. Se cargó así a mano.
-- ──────────────────────────────────────────────────────────────

SELECT id, nombre, categoria, modelo, storage
FROM public.stock
WHERE categoria = 'gaming' AND nombre NOT ILIKE '%playstation%';

-- UPDATE (revisá el SELECT: tiene que devolver SOLO el Khamrah)
-- UPDATE public.stock
--    SET categoria = 'decant'
--  WHERE categoria = 'gaming' AND nombre NOT ILIKE '%playstation%';


-- ──────────────────────────────────────────────────────────────
-- 2 — Cuatro decants con la marca equivocada
--
--     Están como Lattafa y son Armaf. Dos efectos: no salen cuando el
--     cliente filtra por Armaf, y se quedan SIN FOTO — la landing la busca
--     por marca + nombre, así que "lattafa-club-de-nuit-woman…" no matchea
--     el archivo "armaf-club-de-nuit-woman-edt-105ml.png". Son los últimos
--     4 productos de perfumería sin foto, de 47.
--
--     Los frascos de 100/105 ml de esos mismos aromas ya están bien.
-- ──────────────────────────────────────────────────────────────

SELECT id, nombre, modelo AS marca, storage, color
FROM public.stock
WHERE modelo = 'Lattafa'
  AND (nombre ILIKE '%club de nuit%' OR nombre ILIKE '%odyssey%' OR nombre ILIKE '%mandar%');

-- UPDATE (revisá que sean exactamente los 4 decants de arriba)
-- UPDATE public.stock
--    SET modelo = 'Armaf'
--  WHERE modelo = 'Lattafa'
--    AND (nombre ILIKE '%club de nuit%' OR nombre ILIKE '%odyssey%' OR nombre ILIKE '%mandar%');


-- ──────────────────────────────────────────────────────────────
-- 3 — "Odyssey Mandarin Sky 100ml" duplicado
--
--     Dos filas idénticas. OJO: puede ser un duplicado de carga (hay que
--     borrar una) o dos unidades cargadas por separado (hay que fusionarlas
--     sumando las cantidades). Mirá `cantidad` y `creado_en` antes de decidir.
-- ──────────────────────────────────────────────────────────────

SELECT id, nombre, modelo, storage, color, cantidad, precio_ars, costo_usd, creado_en
FROM public.stock
WHERE nombre ILIKE '%odyssey%' AND nombre ILIKE '%100%'
ORDER BY creado_en;

-- Si son dos unidades del mismo producto, lo correcto es sumar y borrar una.
-- Reemplazá los ids por los que devuelva el SELECT de arriba:
--
-- UPDATE public.stock SET cantidad = cantidad + 1 WHERE id = 'ID_QUE_SE_QUEDA';
-- DELETE FROM public.stock WHERE id = 'ID_QUE_SE_BORRA';


-- ──────────────────────────────────────────────────────────────
-- 4 — Control: ¿existen filas con la cotización vacía?
--
--     Motiva el arreglo de `stock.js` del 2026-08-29: abrir y guardar un
--     producto con `cotizacion` NULL o 0 dejaba `precio_ars` en CERO sin
--     avisar (el campo de precio en USD se dibujaba vacío y al guardar se
--     recomponía como 0 × cotización). Ya no pasa, pero conviene saber si
--     hay filas así, porque quedan fuera de `stock_publico` — o sea,
--     invisibles en la web sin que nadie se entere.
-- ──────────────────────────────────────────────────────────────

SELECT count(*) AS filas_sin_cotizacion
FROM public.stock
WHERE cotizacion IS NULL OR cotizacion = 0;

SELECT id, nombre, categoria, precio_ars, cotizacion
FROM public.stock
WHERE cotizacion IS NULL OR cotizacion = 0
ORDER BY categoria, nombre;
