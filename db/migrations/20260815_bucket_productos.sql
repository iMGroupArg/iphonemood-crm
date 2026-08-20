-- Bucket público con las fotos de catálogo de la landing (precios.html).
--
-- Por qué público y no privado como `comprobantes`: estas fotos las tiene que
-- poder ver cualquier visitante de la landing sin estar logueado. Un bucket
-- privado obligaría a firmar cada URL desde el navegador, y la anon key no
-- puede hacerlo. No hay nada sensible acá: son fotos de producto.
--
-- Cómo las usa la landing: NO se guarda la URL en cada artículo del stock.
-- precios.html arma la dirección sola a partir del modelo/color/storage y va
-- probando de más específico a más genérico:
--
--   iphone-17-pro-256gb-naranja-cosmico.png   ← modelo + storage + color
--   iphone-17-pro-naranja-cosmico.png         ← modelo + color
--   iphone-17-pro.png                         ← modelo solo (comodín)
--
-- Reglas para el nombre del archivo: todo en minúscula, sin acentos y con
-- guiones en lugar de espacios. "iPhone 17 Pro" + "Naranja Cósmico" queda
-- `iphone-17-pro-naranja-cosmico.png`. Si no existe ninguna, la landing
-- muestra el emoji de la categoría, igual que antes.
--
-- El campo `imagen_url` del stock sigue funcionando y tiene PRIORIDAD sobre
-- todo esto: sirve para la foto real de un usado puntual (rayones, caja).

INSERT INTO storage.buckets (id, name, public)
VALUES ('productos', 'productos', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Los DROP van antes de cada CREATE para que este archivo se pueda correr
-- más de una vez sin el error "policy already exists". Correrlo dos veces
-- deja exactamente el mismo resultado que correrlo una.

-- Lectura anónima: es lo que permite que la landing muestre las fotos sin login.
DROP POLICY IF EXISTS "public_read_productos" ON storage.objects;
CREATE POLICY "public_read_productos" ON storage.objects
  FOR SELECT USING (bucket_id = 'productos');

-- Subir/reemplazar/borrar sigue requiriendo estar logueado en el CRM.
DROP POLICY IF EXISTS "auth_insert_productos" ON storage.objects;
CREATE POLICY "auth_insert_productos" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'productos' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "auth_update_productos" ON storage.objects;
CREATE POLICY "auth_update_productos" ON storage.objects
  FOR UPDATE USING (bucket_id = 'productos' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "auth_delete_productos" ON storage.objects;
CREATE POLICY "auth_delete_productos" ON storage.objects
  FOR DELETE USING (bucket_id = 'productos' AND auth.role() = 'authenticated');
