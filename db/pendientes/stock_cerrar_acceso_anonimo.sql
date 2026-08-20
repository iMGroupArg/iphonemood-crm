-- ✅ RESUELTO el 18-08-2026: Franco borró la política `public_read_stock`.
-- Verificado con la anon key: stock crudo devuelve 0 filas, stock_publico sigue
-- sirviendo (188) y la landing responde 200. Se conserva como registro.

-- ============================================================================
--  PENDIENTE — este es el paso que REALMENTE tapa la fuga.
--
--  ESTADO al 15-08-2026:
--    ✅ Vista `stock_publico` creada  (db/migrations/20260815_stock_vista_publica.sql)
--    ✅ precios.html ya consulta la vista, verificado en local: 186 equipos,
--       581 unidades, ninguna columna sensible llega al navegador
--    ❌ La tabla `stock` SIGUE siendo legible sin login
--
--  O sea: hoy la landing ya no pide los datos sensibles, pero cualquiera que
--  le pegue directo a la API REST con la anon key los sigue viendo. Hasta que
--  no corras esto, la fuga está abierta.
-- ============================================================================


-- ──────────────────────────────────────────────────────────────
-- PASO 1 — Averiguar el nombre real de la política
--
--    La política que deja leer `stock` sin login se creó a mano en el
--    dashboard, así que no sabemos cómo se llama. Esto lo dice:
-- ──────────────────────────────────────────────────────────────

SELECT policyname, cmd, roles, qual
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'stock';


-- ──────────────────────────────────────────────────────────────
-- PASO 2 — Borrar la que deja leer al rol `anon`
--
--    De la lista de arriba, la que hay que borrar es la que tenga
--    `{anon}` (o `{public}`) en la columna `roles` y `SELECT` en `cmd`.
--    NO borres `stock_all`: esa es la del CRM, la necesitan los usuarios
--    logueados para trabajar.
--
--    Reemplazá NOMBRE_REAL por el que te devolvió el paso 1:
-- ──────────────────────────────────────────────────────────────

-- DROP POLICY IF EXISTS "NOMBRE_REAL" ON public.stock;


-- ──────────────────────────────────────────────────────────────
-- PASO 3 — Verificar
--
--    a) La vista tiene que seguir devolviendo los ~186 equipos:
--         SELECT count(*) FROM public.stock_publico;
--
--    b) La landing tiene que seguir mostrando el catálogo.
--
--    c) Y la tabla tiene que quedar cerrada. Desde una terminal, con la
--       anon key (la misma que está en config.js) — tiene que dar 0 filas:
--
--         curl -s -H "apikey: TU_ANON_KEY" -H "Authorization: Bearer TU_ANON_KEY" \
--           "https://oqvmiozafgogfcclwseu.supabase.co/rest/v1/stock?select=costo_usd&limit=1"
--
--       Si sigue devolviendo datos, quedó otra política abierta: volvé al paso 1.
--
--    Si algo se rompe, se deshace volviendo a crear la política que borraste
--    (guardate la salida del paso 1 antes de borrar nada).
-- ──────────────────────────────────────────────────────────────
