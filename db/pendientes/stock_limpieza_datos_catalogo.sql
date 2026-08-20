-- ============================================================================
--  PENDIENTE — limpieza de datos del catálogo de stock
--
--  Origen: la conversación de la landing pública contó, sobre la vista
--  `stock_publico` (186 filas, 185 con unidades > 0), dos problemas de datos
--  que ensucian tanto la web como los filtros del CRM.
--
--  NADA DE ESTE ARCHIVO SE CORRIÓ. Son escrituras sobre producción: leelas,
--  corré primero los SELECT de control y recién después los UPDATE.
--
--  ORDEN: primero el PASO 1 (recategorizar) y después el PASO 2 (rellenar
--  estado), porque el relleno se apoya en que las categorías ya estén bien.
--
--  El lado de código ya está arreglado (18-08-2026, src/modules/stock.js):
--  el campo "Estado del producto" ahora se puede cargar en TODOS los rubros
--  —antes solo existía en iPhone/Android/iPad y Mac, que es exactamente por
--  qué hay 70 filas vacías y ninguna es un iPhone—, los productos nuevos
--  arrancan en 'Nuevo / Sellado', y la pestaña Nuevo/Usado ya no da por usado
--  lo que simplemente no tiene el dato: ahora tiene su propio chip.
-- ============================================================================


-- ──────────────────────────────────────────────────────────────
-- PASO 0 — Foto antes de tocar nada (guardá la salida)
-- ──────────────────────────────────────────────────────────────
SELECT categoria,
       count(*) FILTER (WHERE coalesce(estado_producto,'') = '') AS sin_estado,
       count(*) AS total
FROM public.stock
WHERE estado_inventario = 'disponible'
GROUP BY categoria
ORDER BY sin_estado DESC;


-- ──────────────────────────────────────────────────────────────
-- PASO 1 — 7 filas marcadas como 'ipad' que no son iPads
--
--   DECIDIDO por Franco (18-08-2026):
--     · PlayStations → categoría nueva 'gaming' (ya creada en stock.js
--       y proveedores.js; falta que la landing la sume a su lista CATS)
--     · Termos y vasos Stanley → 'otro'
--   Incluye también la PlayStation que ya estaba en 'otro', para que
--   las dos consolas queden juntas en 'gaming'.
-- ──────────────────────────────────────────────────────────────

-- Control: mirá qué filas agarra cada UPDATE antes de correrlos
SELECT id, nombre, categoria
FROM public.stock
WHERE nombre ILIKE '%playstation%'
   OR (categoria = 'ipad' AND (nombre ILIKE '%stanley%' OR nombre ILIKE '%quentcher%'));

-- 1a. PlayStations (la de 'ipad' y la de 'otro') → 'gaming'
UPDATE public.stock
   SET categoria = 'gaming'
 WHERE nombre ILIKE '%playstation%'
   AND categoria IN ('ipad', 'otro');

-- 1b. Stanley → 'otro'
UPDATE public.stock
   SET categoria = 'otro'
 WHERE categoria = 'ipad'
   AND (nombre ILIKE '%stanley%' OR nombre ILIKE '%quentcher%');

-- Después: que no haya quedado ningún "iPad" que no sea iPad
SELECT id, nombre FROM public.stock WHERE categoria = 'ipad' AND nombre NOT ILIKE '%ipad%';


-- ──────────────────────────────────────────────────────────────
-- PASO 2 — 70 filas sin estado_producto
--
--   Reparto contado por la landing: accesorio 32/129, perfumeria 19/19,
--   repuesto 8/8, ipad 7/7 (son las del PASO 1), audio 3/3, otro 1/1.
--   iPhone: 0 de 18 — los únicos que sí estaban completos, porque eran los
--   únicos que tenían el campo en el formulario.
--
--   Se rellenan con 'Nuevo / Sellado' SOLO los rubros donde eso es cierto por
--   definición del negocio: perfume cerrado, accesorio, repuesto, herramienta.
--   NO se tocan iphone/android/mac/ipad/watch: ahí "nuevo" o "usado" es un
--   dato real de cada equipo y hay que cargarlo a mano desde el CRM
--   (Stock → chip "❓ Sin estado cargado" te los filtra).
-- ──────────────────────────────────────────────────────────────

-- Control: esto es lo que se va a tocar
SELECT categoria, count(*)
FROM public.stock
WHERE coalesce(estado_producto,'') = ''
  AND categoria IN ('perfumeria','decant','accesorio','repuesto','herramienta','audio','otro')
GROUP BY categoria ORDER BY 2 DESC;

UPDATE public.stock
   SET estado_producto = 'Nuevo / Sellado'
 WHERE coalesce(estado_producto,'') = ''
   AND categoria IN ('perfumeria','decant','accesorio','repuesto','herramienta','audio','otro');

-- Lo que queda sin estado después: son equipos, hay que cargarlos uno por uno
SELECT id, nombre, categoria
FROM public.stock
WHERE coalesce(estado_producto,'') = ''
  AND estado_inventario = 'disponible'
ORDER BY categoria, nombre;


-- ============================================================================
--  PASO 3 (v2) — Unificar el formato del nombre en perfumería
--
--  ⚠️ REEMPLAZA la versión anterior del paso 3. NO corras aquella:
--  el SELECT de control mostró una fila que rompe el parseo por barras.
--
--  Lo que se vio en los datos reales:
--    · La mayoría tiene 4 partes:  "ARMAF | Club de nuit Intense Man | EDT | 100ml"
--    · Pero al menos una tiene 3:  "Acqua Di Gio PROFONDO | EDT | 100ml"
--      (sin marca adelante — la marca sería Armani). Con el parseo viejo esa
--      fila habría quedado con modelo='Acqua Di Gio Profondo' y storage='100ml',
--      o sea la marca y la concentración mal cargadas.
--    · Las 16 con barras tienen modelo, color y storage en NULL. La versión
--      anterior tampoco completaba `color` (la categoría olfativa), así que
--      igual habrían quedado fuera del filtro de Perfumería del panel.
--
--  FORMATO ESTÁNDAR:  Marca Producto Concentración Tamaño
--                     ej: Armaf Club de Nuit Intense Man EDP 105ml
--  Campos internos:   modelo = marca · color = categoría · storage = concentración
--
--  ⚠️ AVISAR A LA LANDING ANTES: resuelve las fotos por convención de nombre
--  (docs/fotos-productos.md), así que al cambiar el nombre cambia el archivo
--  que busca.
-- ============================================================================


-- ──────────────────────────────────────────────────────────────
-- 3.0 — DIAGNÓSTICO: cuántas partes tiene cada fila
--       Correlo primero. Todo lo que NO diga 4 hay que mirarlo a mano.
-- ──────────────────────────────────────────────────────────────
SELECT array_length(string_to_array(nombre,'|'),1) AS partes,
       count(*) AS filas,
       string_agg(nombre, ' ;; ') AS ejemplos
FROM public.stock
WHERE categoria IN ('perfumeria','decant') AND nombre LIKE '%|%'
GROUP BY 1 ORDER BY 1;


-- ──────────────────────────────────────────────────────────────
-- 3.1 — Las de 4 partes: parseo automático
--
--   La marca se busca contra la tabla oficial del CRM (Stock.PERFUME_MARCAS,
--   73 marcas) y se guarda con la GRAFÍA DEL CATÁLOGO, no con initcap.
--   Importa: initcap convertiría 'YSL' en 'Ysl', 'FA Paris' en 'Fa Paris' y
--   "Penhaligon's" en "Penhaligon'S" — y después el desplegable de marcas del
--   panel mostraría la marca duplicada, una por cada grafía.
--
--   La categoría olfativa sale del mismo JOIN. Si una marca no está en la
--   tabla, marca y categoría quedan marcadas para revisar a mano.
-- ──────────────────────────────────────────────────────────────

-- Control: revisá nombre_nuevo, marca, categoria y concentracion fila por fila.
-- Prestá atención a las que digan '⚠️ marca desconocida'.
WITH marcas(marca, categoria) AS (VALUES
    ('Armaf', 'Árabe'),
    ('Lattafa', 'Árabe'),
    ('Ard Al Zaafaran', 'Árabe'),
    ('Arabian Oud', 'Árabe'),
    ('Ajmal', 'Árabe'),
    ('Rasasi', 'Árabe'),
    ('Orientica', 'Árabe'),
    ('Al Haramain', 'Árabe'),
    ('Swiss Arabian', 'Árabe'),
    ('Afnan', 'Árabe'),
    ('Paris Corner', 'Árabe'),
    ('Maison Asrar', 'Árabe'),
    ('My Perfumes', 'Árabe'),
    ('Fragrance World', 'Árabe'),
    ('FA Paris', 'Árabe'),
    ('Otoori', 'Árabe'),
    ('Abdul Samad Al Qurashi', 'Árabe'),
    ('Nabeel', 'Árabe'),
    ('Al-Rehab', 'Árabe'),
    ('Khadlaj', 'Árabe'),
    ('Maison Alhambra', 'Árabe'),
    ('Emper', 'Árabe'),
    ('Asdaaf', 'Árabe'),
    ('Al Wataniah', 'Árabe'),
    ('Surrati', 'Árabe'),
    ('Zahoor Al Madina', 'Árabe'),
    ('Amouage', 'Nicho'),
    ('Creed', 'Nicho'),
    ('Maison Francis Kurkdjian', 'Nicho'),
    ('Byredo', 'Nicho'),
    ('Le Labo', 'Nicho'),
    ('Nishane', 'Nicho'),
    ('Initio', 'Nicho'),
    ('Xerjoff', 'Nicho'),
    ('Orto Parisi', 'Nicho'),
    ('Memo Paris', 'Nicho'),
    ('Mancera', 'Nicho'),
    ('Montale', 'Nicho'),
    ('By Kilian', 'Nicho'),
    ('Diptyque', 'Nicho'),
    ('Serge Lutens', 'Nicho'),
    ('Penhaligon''s', 'Nicho'),
    ('Nasomatto', 'Nicho'),
    ('Acqua di Parma', 'Nicho'),
    ('Histoires de Parfums', 'Nicho'),
    ('Juliette Has a Gun', 'Nicho'),
    ('Dior', 'Diseñador'),
    ('Chanel', 'Diseñador'),
    ('Tom Ford', 'Diseñador'),
    ('YSL', 'Diseñador'),
    ('Givenchy', 'Diseñador'),
    ('Paco Rabanne', 'Diseñador'),
    ('Versace', 'Diseñador'),
    ('Dolce & Gabbana', 'Diseñador'),
    ('Burberry', 'Diseñador'),
    ('Gucci', 'Diseñador'),
    ('Valentino', 'Diseñador'),
    ('Armani', 'Diseñador'),
    ('Hugo Boss', 'Diseñador'),
    ('Calvin Klein', 'Diseñador'),
    ('Davidoff', 'Diseñador'),
    ('Jean Paul Gaultier', 'Diseñador'),
    ('Issey Miyake', 'Diseñador'),
    ('Hermès', 'Diseñador'),
    ('Thierry Mugler', 'Diseñador'),
    ('Carolina Herrera', 'Diseñador'),
    ('Viktor & Rolf', 'Diseñador'),
    ('Narciso Rodriguez', 'Diseñador'),
    ('Cartier', 'Diseñador'),
    ('Bulgari', 'Diseñador'),
    ('Montblanc', 'Diseñador'),
    ('Lacoste', 'Diseñador'),
    ('Ralph Lauren', 'Diseñador')
),
partes AS (
  SELECT id, nombre,
         trim(split_part(nombre,'|',1))        AS marca_raw,
         trim(split_part(nombre,'|',2))        AS producto,
         upper(trim(split_part(nombre,'|',3))) AS concentracion,
         lower(trim(split_part(nombre,'|',4))) AS tamanio
  FROM public.stock
  WHERE categoria IN ('perfumeria','decant')
    AND array_length(string_to_array(nombre,'|'),1) = 4
)
SELECT p.id, p.nombre,
       concat_ws(' ', COALESCE(m.marca, p.marca_raw), p.producto, p.concentracion, p.tamanio) AS nombre_nuevo,
       COALESCE(m.marca, p.marca_raw) AS marca,
       m.categoria,
       p.concentracion,
       CASE WHEN m.marca IS NULL THEN '⚠️ marca desconocida' ELSE 'ok' END AS control
FROM partes p
LEFT JOIN marcas m ON lower(m.marca) = lower(p.marca_raw)
-- Por posición: 'marca' existe como alias de salida y como columna de la tabla
-- de marcas, y ordenar por nombre ahí es ambiguo.
ORDER BY 7 DESC, 4, 3;

-- UPDATE (correr solo si el SELECT de arriba salió bien en TODAS las filas)
-- WITH marcas(marca, categoria) AS (VALUES
--     ('Armaf', 'Árabe'),
--     ('Lattafa', 'Árabe'),
--     ('Ard Al Zaafaran', 'Árabe'),
--     ('Arabian Oud', 'Árabe'),
--     ('Ajmal', 'Árabe'),
--     ('Rasasi', 'Árabe'),
--     ('Orientica', 'Árabe'),
--     ('Al Haramain', 'Árabe'),
--     ('Swiss Arabian', 'Árabe'),
--     ('Afnan', 'Árabe'),
--     ('Paris Corner', 'Árabe'),
--     ('Maison Asrar', 'Árabe'),
--     ('My Perfumes', 'Árabe'),
--     ('Fragrance World', 'Árabe'),
--     ('FA Paris', 'Árabe'),
--     ('Otoori', 'Árabe'),
--     ('Abdul Samad Al Qurashi', 'Árabe'),
--     ('Nabeel', 'Árabe'),
--     ('Al-Rehab', 'Árabe'),
--     ('Khadlaj', 'Árabe'),
--     ('Maison Alhambra', 'Árabe'),
--     ('Emper', 'Árabe'),
--     ('Asdaaf', 'Árabe'),
--     ('Al Wataniah', 'Árabe'),
--     ('Surrati', 'Árabe'),
--     ('Zahoor Al Madina', 'Árabe'),
--     ('Amouage', 'Nicho'),
--     ('Creed', 'Nicho'),
--     ('Maison Francis Kurkdjian', 'Nicho'),
--     ('Byredo', 'Nicho'),
--     ('Le Labo', 'Nicho'),
--     ('Nishane', 'Nicho'),
--     ('Initio', 'Nicho'),
--     ('Xerjoff', 'Nicho'),
--     ('Orto Parisi', 'Nicho'),
--     ('Memo Paris', 'Nicho'),
--     ('Mancera', 'Nicho'),
--     ('Montale', 'Nicho'),
--     ('By Kilian', 'Nicho'),
--     ('Diptyque', 'Nicho'),
--     ('Serge Lutens', 'Nicho'),
--     ('Penhaligon''s', 'Nicho'),
--     ('Nasomatto', 'Nicho'),
--     ('Acqua di Parma', 'Nicho'),
--     ('Histoires de Parfums', 'Nicho'),
--     ('Juliette Has a Gun', 'Nicho'),
--     ('Dior', 'Diseñador'),
--     ('Chanel', 'Diseñador'),
--     ('Tom Ford', 'Diseñador'),
--     ('YSL', 'Diseñador'),
--     ('Givenchy', 'Diseñador'),
--     ('Paco Rabanne', 'Diseñador'),
--     ('Versace', 'Diseñador'),
--     ('Dolce & Gabbana', 'Diseñador'),
--     ('Burberry', 'Diseñador'),
--     ('Gucci', 'Diseñador'),
--     ('Valentino', 'Diseñador'),
--     ('Armani', 'Diseñador'),
--     ('Hugo Boss', 'Diseñador'),
--     ('Calvin Klein', 'Diseñador'),
--     ('Davidoff', 'Diseñador'),
--     ('Jean Paul Gaultier', 'Diseñador'),
--     ('Issey Miyake', 'Diseñador'),
--     ('Hermès', 'Diseñador'),
--     ('Thierry Mugler', 'Diseñador'),
--     ('Carolina Herrera', 'Diseñador'),
--     ('Viktor & Rolf', 'Diseñador'),
--     ('Narciso Rodriguez', 'Diseñador'),
--     ('Cartier', 'Diseñador'),
--     ('Bulgari', 'Diseñador'),
--     ('Montblanc', 'Diseñador'),
--     ('Lacoste', 'Diseñador'),
--     ('Ralph Lauren', 'Diseñador')
-- ),
-- partes AS (
--   SELECT id,
--          trim(split_part(nombre,'|',1))        AS marca_raw,
--          trim(split_part(nombre,'|',2))        AS producto,
--          upper(trim(split_part(nombre,'|',3))) AS concentracion,
--          lower(trim(split_part(nombre,'|',4))) AS tamanio
--   FROM public.stock
--   WHERE categoria IN ('perfumeria','decant')
--     AND array_length(string_to_array(nombre,'|'),1) = 4
-- )
-- UPDATE public.stock s
--    SET nombre  = concat_ws(' ', COALESCE(m.marca, p.marca_raw), p.producto, p.concentracion, p.tamanio),
--        modelo  = COALESCE(m.marca, p.marca_raw),
--        storage = p.concentracion,
--        color   = COALESCE(NULLIF(s.color,''), m.categoria)
--   FROM partes p
--   LEFT JOIN marcas m ON lower(m.marca) = lower(p.marca_raw)
--  WHERE s.id = p.id;


-- ──────────────────────────────────────────────────────────────
-- 3.2 — Las que NO tienen 4 partes: a mano
--
--   Hoy se conoce una: "Acqua Di Gio PROFONDO | EDT | 100ml" → es de Armani
--   (categoría Diseñador). Si el diagnóstico 3.0 muestra otras, agregalas
--   al VALUES con el mismo criterio: id, nombre final, marca, categoría,
--   concentración.
-- ──────────────────────────────────────────────────────────────

-- Ver cuáles son y con qué id
SELECT id, nombre, array_length(string_to_array(nombre,'|'),1) AS partes
FROM public.stock
WHERE categoria IN ('perfumeria','decant')
  AND nombre LIKE '%|%'
  AND array_length(string_to_array(nombre,'|'),1) <> 4;

-- UPDATE a mano (completá el VALUES con los ids reales del SELECT de arriba)
-- UPDATE public.stock s
--    SET nombre = v.nombre_nuevo, modelo = v.marca,
--        color = v.categoria, storage = v.concentracion
--   FROM (VALUES
--     ('630a4fe1-6aca-4885-9ea5-d6eddd77ed62'::uuid,
--      'Armani Acqua Di Gio Profondo EDT 100ml', 'Armani', 'Diseñador', 'EDT')
--   ) AS v(id, nombre_nuevo, marca, categoria, concentracion)
--  WHERE s.id = v.id;


-- ──────────────────────────────────────────────────────────────
-- 3.3 — Las 3 que ya tienen los campos bien pero sin la marca en el nombre
--       (Club de nuit intense man / Mandarin sky / Barre al oud…)
--       Esta parte es segura: solo antepone el modelo al nombre.
-- ──────────────────────────────────────────────────────────────
SELECT id, nombre, modelo, concat_ws(' ', modelo, nombre) AS nombre_nuevo
FROM public.stock
WHERE categoria IN ('perfumeria','decant')
  AND nombre NOT LIKE '%|%'
  AND coalesce(modelo,'') <> ''
  AND nombre NOT ILIKE modelo || '%';

-- UPDATE (revisá el SELECT de arriba antes)
-- UPDATE public.stock
--    SET nombre = concat_ws(' ', modelo, nombre)
--  WHERE categoria IN ('perfumeria','decant')
--    AND nombre NOT LIKE '%|%'
--    AND coalesce(modelo,'') <> ''
--    AND nombre NOT ILIKE modelo || '%';


-- ──────────────────────────────────────────────────────────────
-- 3.4 — FOTO FINAL: no debería quedar ninguna barra ni ningún campo vacío
-- ──────────────────────────────────────────────────────────────
SELECT id, nombre, modelo AS marca, color AS categoria_olf, storage AS concentracion,
       CASE WHEN nombre LIKE '%|%' THEN '⚠️ quedó con barras'
            WHEN coalesce(modelo,'')='' OR coalesce(color,'')='' OR coalesce(storage,'')=''
            THEN '⚠️ campo sin cargar' ELSE 'ok' END AS control
FROM public.stock
WHERE categoria IN ('perfumeria','decant')
ORDER BY control DESC, modelo, nombre;
