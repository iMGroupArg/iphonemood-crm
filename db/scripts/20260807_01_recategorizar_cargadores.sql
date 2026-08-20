-- ============================================================
-- Recategoriza los cargadores de "iPhone" a "Accesorio"
--
-- Hoy los 97 "Cargador Original 20w. USA" están cargados con
-- categoria = 'iphone'. Eso hace que al filtrar "iPhone" en la landing
-- aparezcan cargadores de USD 50 mezclados entre teléfonos de USD 1000+,
-- y también distorsiona el reporte "por nicho de mercado" (Reportes),
-- que hoy les está sumando el volumen a Dispositivos en vez de a
-- Accesorios.
--
-- Solo toca esta fila por nombre exacto: no afecta ningún otro producto.
-- ============================================================

BEGIN;

-- Antes de aplicar: cuántas filas se van a mover
SELECT categoria, count(*) AS filas
FROM stock
WHERE nombre = 'Cargador Original 20w. USA'
GROUP BY categoria;

UPDATE stock
   SET categoria = 'accesorio'
 WHERE nombre = 'Cargador Original 20w. USA'
   AND categoria = 'iphone';

COMMIT;

-- Verificación: tiene que dar 0 filas bajo 'iphone' y el resto bajo 'accesorio'
SELECT categoria, count(*) AS filas
FROM stock
WHERE nombre = 'Cargador Original 20w. USA'
GROUP BY categoria;
