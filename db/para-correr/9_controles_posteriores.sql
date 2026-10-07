-- ============================================================================
--  9_controles_posteriores.sql — SOLO LECTURA. Correr al FINAL, después de los scripts 3, 7, 4 y 8.
--
--  Una sola consulta: devuelve una tabla con una fila por control y una columna "resultado" con ✅ o ❌.
--  Tiene que verse TODO en ✅. Si alguna fila sale con ❌, no seguir: copiar la tabla entera y pasarla.
--
--  No modifica nada. Se puede correr las veces que haga falta.
--  (Verificada contra Postgres de prueba: sobre la base "como quedó en producción" más el orden de corrida real da
--   todo ✅, y sobre la base SIN correr los scripts da ❌ en las filas que corresponden: tests/sql/controles.test.mjs.)
-- ============================================================================

SELECT id, control, esperado, COALESCE(obtenido, '(no existe todavía)') AS obtenido,
       CASE WHEN COALESCE(ok, false) THEN '✅' ELSE '❌' END AS resultado
FROM (

  -- ── Script 3 (versión actual) ───────────────────────────────────────────
  SELECT '3.1' AS id, 'La cuenta de Mercado Libre sigue conectada, con su caja y sus tokens (re-correr el 3 no la borra)' AS control,
         '1 o más' AS esperado, count(*)::text AS obtenido, count(*) >= 1 AS ok
    FROM public.meli_cuentas
   WHERE persona_id IS NOT NULL AND access_token IS NOT NULL AND refresh_token IS NOT NULL

  UNION ALL
  SELECT '3.2', 'El descuento suma el faltante POR PRODUCTO (dos avisos de una orden al mismo stock)', 'true',
         (position('necesita' IN pg_get_functiondef(to_regprocedure('public.meli__descontar_core(bigint)'))) > 0)::text,
         position('necesita' IN pg_get_functiondef(to_regprocedure('public.meli__descontar_core(bigint)'))) > 0

  UNION ALL
  SELECT '3.3', 'meli_publicaciones tiene UNA sola política y es de sólo lectura', 'meli_publicaciones_lectura:SELECT',
         COALESCE(string_agg(policyname || ':' || cmd, ', '), '(ninguna)'),
         COALESCE(string_agg(policyname || ':' || cmd, ', '), '') = 'meli_publicaciones_lectura:SELECT'
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'meli_publicaciones'

  -- ── Script 7 ────────────────────────────────────────────────────────────
  UNION ALL
  SELECT '7.1', 'Existen las 6 funciones nuevas de vinculación', '6', count(*)::text, count(*) = 6
    FROM pg_proc WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('meli_publicacion_vincular', 'meli_publicacion_desvincular', 'meli_cuenta_info',
                     'meli_orden_revalidar', 'meli__revalidar_orden', 'meli_quitar_motivo')

  UNION ALL
  SELECT '7.2', 'meli_publicaciones: el navegador (usuario logueado) LEE pero NO puede escribir ni vaciar la tabla',
         'lee=true, inserta=false, actualiza=false, borra=false, vacía=false',
         'lee=' || has_table_privilege('authenticated', to_regclass('public.meli_publicaciones'), 'SELECT')
         || ', inserta=' || has_table_privilege('authenticated', to_regclass('public.meli_publicaciones'), 'INSERT')
         || ', actualiza=' || has_table_privilege('authenticated', to_regclass('public.meli_publicaciones'), 'UPDATE')
         || ', borra=' || has_table_privilege('authenticated', to_regclass('public.meli_publicaciones'), 'DELETE')
         || ', vacía=' || has_table_privilege('authenticated', to_regclass('public.meli_publicaciones'), 'TRUNCATE'),
         has_table_privilege('authenticated', to_regclass('public.meli_publicaciones'), 'SELECT')
         AND NOT has_table_privilege('authenticated', to_regclass('public.meli_publicaciones'), 'INSERT')
         AND NOT has_table_privilege('authenticated', to_regclass('public.meli_publicaciones'), 'UPDATE')
         AND NOT has_table_privilege('authenticated', to_regclass('public.meli_publicaciones'), 'DELETE')
         AND NOT has_table_privilege('authenticated', to_regclass('public.meli_publicaciones'), 'TRUNCATE')

  UNION ALL
  SELECT '7.3', 'La clave pública (anon) NO lee los vínculos ni el historial', 'false, false',
         has_table_privilege('anon', to_regclass('public.meli_publicaciones'), 'SELECT')::text || ', '
         || has_table_privilege('anon', to_regclass('public.meli_vinculos_historial'), 'SELECT')::text,
         NOT has_table_privilege('anon', to_regclass('public.meli_publicaciones'), 'SELECT')
         AND NOT has_table_privilege('anon', to_regclass('public.meli_vinculos_historial'), 'SELECT')

  UNION ALL
  SELECT '7.4', 'La función interna de revalidar está cerrada; la de la pantalla sólo para usuarios logueados', 'interna=false, pantalla(usuario)=true, pantalla(anon)=false',
         'interna=' || has_function_privilege('authenticated', to_regprocedure('public.meli__revalidar_orden(bigint)'), 'EXECUTE')
         || ', pantalla(usuario)=' || has_function_privilege('authenticated', to_regprocedure('public.meli_orden_revalidar(bigint)'), 'EXECUTE')
         || ', pantalla(anon)=' || has_function_privilege('anon', to_regprocedure('public.meli_orden_revalidar(bigint)'), 'EXECUTE'),
         NOT has_function_privilege('authenticated', to_regprocedure('public.meli__revalidar_orden(bigint)'), 'EXECUTE')
         AND NOT has_function_privilege('anon', to_regprocedure('public.meli__revalidar_orden(bigint)'), 'EXECUTE')
         AND has_function_privilege('authenticated', to_regprocedure('public.meli_orden_revalidar(bigint)'), 'EXECUTE')
         AND NOT has_function_privilege('anon', to_regprocedure('public.meli_orden_revalidar(bigint)'), 'EXECUTE')

  UNION ALL
  SELECT '7.5', 'Columnas nuevas de meli_publicaciones (versión, quién y cuándo vinculó)', '3', count(*)::text, count(*) = 3
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'meli_publicaciones'
     AND column_name IN ('version', 'vinculado_por', 'vinculado_en')

  UNION ALL
  SELECT '7.6', 'Las secuencias de los vínculos están cerradas para la clave pública y los usuarios', 'false, false',
         has_sequence_privilege('anon', to_regclass('public.meli_vinculos_historial_id_seq'), 'USAGE')::text || ', '
         || has_sequence_privilege('authenticated', to_regclass('public.meli_publicaciones_id_seq'), 'USAGE')::text,
         NOT has_sequence_privilege('anon', to_regclass('public.meli_vinculos_historial_id_seq'), 'USAGE')
         AND NOT has_sequence_privilege('authenticated', to_regclass('public.meli_publicaciones_id_seq'), 'USAGE')

  -- ── Script 4 (el de Ventas+Cueva) ───────────────────────────────────────
  UNION ALL
  SELECT '4.1', 'Procesar una orden revalida el vínculo ANTES de descontar (ya corrió el 4 actualizado)', 'true',
         (position('meli__revalidar_orden' IN pg_get_functiondef(to_regprocedure('public.meli_procesar_orden(bigint, numeric)'))) > 0)::text,
         position('meli__revalidar_orden' IN pg_get_functiondef(to_regprocedure('public.meli_procesar_orden(bigint, numeric)'))) > 0

  -- ── Script 8 (vista del último precio vendido) ──────────────────────────
  UNION ALL
  SELECT '8.1', 'La vista del último precio vendido existe y es del dueño correcto', 'postgres',
         COALESCE((SELECT c.relowner::regrole::text FROM pg_class c WHERE c.oid = to_regclass('public.canje_ultimo_precio_publico')), '(no existe todavía)'),
         COALESCE((SELECT c.relowner::regrole::text FROM pg_class c WHERE c.oid = to_regclass('public.canje_ultimo_precio_publico')), '') = 'postgres'

  UNION ALL
  SELECT '8.2', 'La vista: la clave pública y los usuarios sólo LEEN (nada de escribir)', 'anon lee, usuario lee, nadie escribe',
         CASE WHEN to_regclass('public.canje_ultimo_precio_publico') IS NULL THEN '(no existe todavía)'
              ELSE 'anon lee=' || has_table_privilege('anon', to_regclass('public.canje_ultimo_precio_publico'), 'SELECT')
                   || ', usuario lee=' || has_table_privilege('authenticated', to_regclass('public.canje_ultimo_precio_publico'), 'SELECT')
                   || ', escribe=' || (has_table_privilege('anon', to_regclass('public.canje_ultimo_precio_publico'), 'INSERT')
                                    OR has_table_privilege('anon', to_regclass('public.canje_ultimo_precio_publico'), 'UPDATE')
                                    OR has_table_privilege('anon', to_regclass('public.canje_ultimo_precio_publico'), 'DELETE')
                                    OR has_table_privilege('authenticated', to_regclass('public.canje_ultimo_precio_publico'), 'INSERT')
                                    OR has_table_privilege('authenticated', to_regclass('public.canje_ultimo_precio_publico'), 'UPDATE')
                                    OR has_table_privilege('authenticated', to_regclass('public.canje_ultimo_precio_publico'), 'DELETE')) END,
         to_regclass('public.canje_ultimo_precio_publico') IS NOT NULL
         AND has_table_privilege('anon', to_regclass('public.canje_ultimo_precio_publico'), 'SELECT')
         AND has_table_privilege('authenticated', to_regclass('public.canje_ultimo_precio_publico'), 'SELECT')
         AND NOT (has_table_privilege('anon', to_regclass('public.canje_ultimo_precio_publico'), 'INSERT')
               OR has_table_privilege('anon', to_regclass('public.canje_ultimo_precio_publico'), 'UPDATE')
               OR has_table_privilege('anon', to_regclass('public.canje_ultimo_precio_publico'), 'DELETE')
               OR has_table_privilege('authenticated', to_regclass('public.canje_ultimo_precio_publico'), 'INSERT')
               OR has_table_privilege('authenticated', to_regclass('public.canje_ultimo_precio_publico'), 'UPDATE')
               OR has_table_privilege('authenticated', to_regclass('public.canje_ultimo_precio_publico'), 'DELETE'))

) t
ORDER BY string_to_array(id, '.')::int[];
