-- El bucket definitivo de fotos de catálogo es `products` (creado a mano desde
-- el panel el 2026-08-18). El `productos` que creó la migración anterior no
-- abría en el panel de Franco y quedó descartado; este archivo le da permisos
-- al bueno y limpia el viejo. Se puede correr más de una vez.

-- 1. Lectura anónima sobre `products`: sin esto, la landing no puede armar el
--    índice de qué fotos existen (aunque el bucket sea público, listar
--    archivos pasa por RLS).
DROP POLICY IF EXISTS "public_read_products" ON storage.objects;
CREATE POLICY "public_read_products" ON storage.objects
  FOR SELECT USING (bucket_id = 'products');

-- Subir/reemplazar/borrar por API sigue pidiendo login (desde el panel de
-- Supabase siempre se puede, el panel no pasa por estas políticas).
DROP POLICY IF EXISTS "auth_insert_products" ON storage.objects;
CREATE POLICY "auth_insert_products" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'products' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "auth_update_products" ON storage.objects;
CREATE POLICY "auth_update_products" ON storage.objects
  FOR UPDATE USING (bucket_id = 'products' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "auth_delete_products" ON storage.objects;
CREATE POLICY "auth_delete_products" ON storage.objects
  FOR DELETE USING (bucket_id = 'products' AND auth.role() = 'authenticated');

-- 2. Limpieza del bucket viejo `productos` (está vacío, verificado 2026-08-18)
--    y de sus cuatro políticas, que ya no apuntan a nada.
DROP POLICY IF EXISTS "public_read_productos" ON storage.objects;
DROP POLICY IF EXISTS "auth_insert_productos" ON storage.objects;
DROP POLICY IF EXISTS "auth_update_productos" ON storage.objects;
DROP POLICY IF EXISTS "auth_delete_productos" ON storage.objects;
DELETE FROM storage.buckets WHERE id = 'productos';
