-- Diagnóstico: por qué el Trade-In nunca entra al stock
-- Pegar en Supabase -> SQL Editor -> Run. Es solo lectura, no modifica nada.

-- 1) Columnas obligatorias (NOT NULL) de la tabla stock.
--    El trade-in se guarda con precio_ars = NULL y cantidad = 0.
--    Si precio_ars aparece acá con is_nullable = NO, esa es la causa.
SELECT column_name, is_nullable, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'stock' AND table_schema = 'public'
  AND is_nullable = 'NO'
ORDER BY column_name;

-- 2) Restricciones CHECK sobre stock (por ejemplo, valores permitidos
--    en estado_inventario: el trade-in usa 'en_reparacion').
SELECT con.conname AS restriccion, pg_get_constraintdef(con.oid) AS definicion
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace ns ON ns.oid = rel.relnamespace
WHERE rel.relname = 'stock' AND ns.nspname = 'public' AND con.contype IN ('c','f');

-- 3) Confirmación: cuántos trade-ins hay hoy en stock (esperado: 0)
SELECT count(*) AS trade_ins_en_stock FROM stock WHERE proveedor = 'Trade-In';
