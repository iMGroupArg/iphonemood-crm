-- ============================================================
-- ULTIMOS 3 EQUIPOS QUE FALTAN DAR DE ALTA
--
-- Estan fisicamente en el local pero no existian en el sistema,
-- y no vienen de ningun canje registrado.
--
-- La columna costo_usd es obligatoria en la base (no admite vacio),
-- asi que los dos sin costo entran en 0 y quedan marcados en las
-- notas con "COSTO PENDIENTE" para que los encuentres facil.
-- ============================================================


-- ── 1) iPhone 13 Midnight 128GB · NUEVO · bateria 100% ──
--     Costo confirmado: USD 483.75
INSERT INTO stock (categoria, nombre, modelo, storage, color,
                   costo_usd, cotizacion, precio_ars, cantidad, imeis,
                   proveedor, notas, bateria_pct, estado_producto, grado, estado_inventario)
SELECT 'iphone', 'iPhone 13 128GB Medianoche', 'iPhone 13', '128GB', 'Medianoche',
       483.75, 1600, 0, 1, ARRAY['355163568751354'],
       'Otro', 'Alta por relevamiento 30-07-2026', 100, 'Nuevo / Sellado', 'Sin grado', 'disponible'
WHERE NOT EXISTS (SELECT 1 FROM stock WHERE imeis @> ARRAY['355163568751354']);


-- ── 2) iPhone 15 Blue 128GB · USADO · bateria 89% ──
--     COSTO PENDIENTE (entra en 0)
INSERT INTO stock (categoria, nombre, modelo, storage, color,
                   costo_usd, cotizacion, precio_ars, cantidad, imeis,
                   proveedor, notas, bateria_pct, estado_producto, grado, estado_inventario)
SELECT 'iphone', 'iPhone 15 128GB Azul', 'iPhone 15', '128GB', 'Azul',
       0, 1600, 0, 1, ARRAY['357394514270889'],
       'Otro', 'COSTO PENDIENTE — cargar a mano. Alta por relevamiento 30-07-2026',
       89, 'Excelente', 'Sin grado', 'disponible'
WHERE NOT EXISTS (SELECT 1 FROM stock WHERE imeis @> ARRAY['357394514270889']);


-- ── 3) iPhone 13 Midnight 128GB · USADO · bateria 100% ──
--     COSTO PENDIENTE (entra en 0)
INSERT INTO stock (categoria, nombre, modelo, storage, color,
                   costo_usd, cotizacion, precio_ars, cantidad, imeis,
                   proveedor, notas, bateria_pct, estado_producto, grado, estado_inventario)
SELECT 'iphone', 'iPhone 13 128GB Medianoche', 'iPhone 13', '128GB', 'Medianoche',
       0, 1600, 0, 1, ARRAY['359888179897181'],
       'Otro', 'COSTO PENDIENTE — cargar a mano. Alta por relevamiento 30-07-2026',
       100, 'Excelente', 'Sin grado', 'disponible'
WHERE NOT EXISTS (SELECT 1 FROM stock WHERE imeis @> ARRAY['359888179897181']);


-- ── Los que quedan con costo pendiente ──
-- Guardá esta consulta: te muestra siempre qué falta valorizar.
SELECT nombre, imeis, bateria_pct, estado_producto, costo_usd
FROM stock
WHERE notas LIKE '%COSTO PENDIENTE%'
ORDER BY nombre;
