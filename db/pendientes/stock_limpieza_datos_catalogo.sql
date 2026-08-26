-- ============================================================================
--  ✅ APLICADO EL 2026-08-27 — no queda nada que correr acá.
--
--  Se conserva por los SELECT de control, que sirven para volver a verificar
--  que el catálogo siga sano. Los UPDATE ya se corrieron en producción:
--  PlayStations → rubro `gaming`, Stanley → `otro`, y 70 filas sin
--  `estado_producto` rellenadas con 'Nuevo / Sellado'.
--
--  Origen (histórico) — limpieza de datos del catálogo de stock
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
--  PASO 3 — YA NO HACE FALTA. NO CORRER NADA DE ACÁ.
--
--  Verificado en producción el 2026-08-27:
--
--    SELECT count(*) FILTER (WHERE nombre LIKE '%|%') ...  → 0 filas
--
--    total | sin_marca | sin_familia | sin_concentracion | sin_tamano
--       53 |         0 |           0 |                 0 |          0
--
--  O sea: los 53 perfumes y decants tienen el nombre normalizado (sin las
--  barras del formato viejo "MARCA | Producto | EDP | 100ml"), y los tres
--  campos cargados — modelo=marca, color=familia olfativa, storage=
--  concentración — más el tamaño dentro del nombre.
--
--  Se borró de acá el parseo por barras y la tabla de 73 marcas: filtraban
--  por `nombre LIKE '%|%'`, así que hoy no tocarían ninguna fila, pero dejar
--  250 líneas de SQL muerto en un archivo de pendientes es una invitación a
--  correrlo por error.
--
--  Si en el futuro vuelve a entrar un perfume con el formato viejo, el
--  archivo está en el historial de git.
--
--  FORMATO ESTÁNDAR vigente para cargar perfumes (desde el CRM ya sale así):
--      nombre  = Marca Producto Concentración Tamaño
--                ej: "Armaf Club de Nuit Intense Man EDP 105ml"
--      modelo  = marca          · color = familia · storage = concentración
--  El tamaño va DENTRO del nombre: es de ahí de donde lo leen el selector de
--  ml del panel de Stock y el selector de tamaños de la landing.
-- ============================================================================


-- Control de salud de perfumería. Las cuatro columnas tienen que dar 0.
SELECT
  count(*) AS total,
  count(*) FILTER (WHERE coalesce(modelo,'')  = '') AS sin_marca,
  count(*) FILTER (WHERE coalesce(color,'')   = '') AS sin_familia,
  count(*) FILTER (WHERE coalesce(storage,'') = '') AS sin_concentracion,
  count(*) FILTER (WHERE nombre !~* '\d+\s*ml') AS sin_tamano_en_el_nombre
FROM public.stock
WHERE categoria IN ('perfumeria','decant');
