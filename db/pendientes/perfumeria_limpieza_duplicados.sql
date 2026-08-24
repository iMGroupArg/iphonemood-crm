-- Limpieza de perfumería — LOS 4 CASOS SON DISTINTOS, no todos son duplicados.
-- Revisar uno por uno antes de correr. Nada de esto es urgente: la landing
-- ya los maneja bien, esto es para que el stock quede prolijo.

-- ─────────────────────────────────────────────────────────────
-- 1. "Club de nuit intense man EDP 100ml" — NO ES DUPLICADO
--    Son dos productos reales: uno EDP (USD 55) y otro EDT (USD 61).
--    El error es el NOMBRE: los dos dicen "EDP", pero uno es EDT.
--    NO unificar precios: son fragancias distintas y valen distinto.
-- ─────────────────────────────────────────────────────────────
UPDATE stock
SET nombre = 'Club de nuit intense man EDT 100ml'
WHERE nombre = 'Club de nuit intense man EDP 100ml'
  AND storage = 'EDT';

-- ─────────────────────────────────────────────────────────────
-- 2 y 3. Khamrah Dukhan y Teriaq — SÍ son duplicados
--    Dos filas idénticas de 1 unidad cada una. Se consolidan en una
--    sola de 2 unidades. Se conserva la más vieja.
--    OJO: revisá antes si en realidad son dos lotes con costos
--    distintos, en cuyo caso conviene dejarlos separados.
-- ─────────────────────────────────────────────────────────────
WITH dups AS (
  SELECT nombre, MIN(creado_en) AS primera, SUM(cantidad) AS total
  FROM stock
  WHERE nombre IN ('Lattafa | Khamrah Dukhan | EDP | 100ml',
                   'Lattafa | Teriaq | EDP | 100ml')
    AND estado_inventario = 'disponible'
  GROUP BY nombre
  HAVING COUNT(*) > 1
)
UPDATE stock s SET cantidad = d.total
FROM dups d
WHERE s.nombre = d.nombre AND s.creado_en = d.primera;

DELETE FROM stock s
USING (
  SELECT nombre, MIN(creado_en) AS primera
  FROM stock
  WHERE nombre IN ('Lattafa | Khamrah Dukhan | EDP | 100ml',
                   'Lattafa | Teriaq | EDP | 100ml')
    AND estado_inventario = 'disponible'
  GROUP BY nombre
) k
WHERE s.nombre = k.nombre AND s.creado_en <> k.primera
  AND s.estado_inventario = 'disponible';

-- ─────────────────────────────────────────────────────────────
-- 4. "Club de nuit women 10ML" — mismo producto en DOS rubros
--    Una fila está como `perfumeria` y otra como `decant`, ambas de
--    10ml y 6 unidades. Un frasco de 10ml es un decant, así que la
--    de perfumería sobra. Se suman las unidades en la de decant.
-- ─────────────────────────────────────────────────────────────
UPDATE stock SET cantidad = cantidad + (
  SELECT COALESCE(SUM(cantidad), 0) FROM stock
  WHERE nombre = 'Club de nuit women 10ML' AND categoria = 'perfumeria'
    AND estado_inventario = 'disponible'
)
WHERE nombre = 'Club de nuit women 10ML' AND categoria = 'decant'
  AND estado_inventario = 'disponible';

DELETE FROM stock
WHERE nombre = 'Club de nuit women 10ML' AND categoria = 'perfumeria'
  AND estado_inventario = 'disponible';
