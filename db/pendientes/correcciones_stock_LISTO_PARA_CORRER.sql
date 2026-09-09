-- ============================================================================
--  Correcciones de datos del stock — verificadas contra la base EN VIVO
--  el 2026-08-29. Los tres problemas siguen ahí.
--
--  Corré primero el SELECT de cada punto y mirá que devuelva lo que dice.
--  Recién después el UPDATE que está abajo.
-- ============================================================================


-- ══ 1 ══ Un decant quedó cargado como "Gaming"
--
-- "Khamrah dukhan 5ML" aparece en la web junto a las PlayStation, y queda
-- afuera del agrupado por aroma de perfumería.
--
-- Este SELECT tiene que devolver UNA sola fila: el Khamrah.

SELECT id, nombre, categoria, modelo, storage
FROM public.stock
WHERE categoria = 'gaming' AND nombre NOT ILIKE '%playstation%';

-- Si devolvió solo el Khamrah, corré esto:
UPDATE public.stock
   SET categoria = 'decant'
 WHERE categoria = 'gaming' AND nombre NOT ILIKE '%playstation%';


-- ══ 2 ══ Cuatro decants con la marca equivocada
--
-- Están cargados como Lattafa y son Armaf. Dos consecuencias: no aparecen
-- cuando el cliente filtra por Armaf, y se quedan SIN FOTO — la web busca la
-- imagen por marca + nombre, así que "lattafa-club-de-nuit-woman…" no
-- encuentra el archivo "armaf-club-de-nuit-woman…".
--
-- Tiene que devolver CUATRO filas: Club de nuit woman 5ml y 10ml, y
-- Odyssey Mandarín sky 5ML y 10ML.

SELECT id, nombre, modelo AS marca, storage, estado_inventario
FROM public.stock
WHERE modelo = 'Lattafa'
  AND (nombre ILIKE '%club de nuit%' OR nombre ILIKE '%odyssey%' OR nombre ILIKE '%mandar%');

-- Si son esos cuatro, corré esto:
UPDATE public.stock
   SET modelo = 'Armaf'
 WHERE modelo = 'Lattafa'
   AND (nombre ILIKE '%club de nuit%' OR nombre ILIKE '%odyssey%' OR nombre ILIKE '%mandar%');


-- ══ 3 ══ "Odyssey Mandarin Sky 100ml" aparece DOS VECES en la web
--
-- ESTE NO TIENE UPDATE AUTOMÁTICO: hay que decidir.
--
-- Son dos filas del mismo perfume pero con DISTINTO precio y distinta
-- cantidad — 9 unidades a $81.810 y 3 unidades a $78.000. O sea que no es un
-- duplicado de carga: parecen dos compras en momentos distintos.
--
-- El problema es que en la web el mismo perfume sale dos veces con dos
-- precios, y eso queda mal.
--
-- Mirá el SELECT y decidí:

SELECT id, nombre, modelo, storage, cantidad, precio_ars, costo_usd, creado_en
FROM public.stock
WHERE nombre ILIKE '%odyssey%' AND nombre ILIKE '%100%'
ORDER BY creado_en;

-- OPCIÓN A — unificar en una sola fila de 12 unidades al precio que elijas.
-- Reemplazá los ids y el precio por los que correspondan:
--
--   UPDATE public.stock
--      SET cantidad = 12, precio_ars = 81810
--    WHERE id = 'ID_DE_LA_FILA_QUE_SE_QUEDA';
--
--   DELETE FROM public.stock WHERE id = 'ID_DE_LA_OTRA_FILA';
--
-- OPCIÓN B — dejarlas separadas y solo emparejar el precio, para que en la
-- web no salgan dos precios distintos del mismo perfume:
--
--   UPDATE public.stock
--      SET precio_ars = 81810
--    WHERE nombre ILIKE '%odyssey%' AND nombre ILIKE '%100%';


-- ══ 4 ══ Control: filas invisibles en la web
--
-- Una fila con la cotización en cero o vacía queda FUERA de la vista pública:
-- está cargada en el CRM pero no se ve en la web, y nadie se entera.
-- Si esto devuelve 0, está todo bien.

SELECT count(*) AS filas_invisibles
FROM public.stock
WHERE cotizacion IS NULL OR cotizacion = 0;

SELECT id, nombre, categoria, precio_ars, cotizacion
FROM public.stock
WHERE cotizacion IS NULL OR cotizacion = 0
ORDER BY categoria, nombre;
