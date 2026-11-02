-- ============================================================================
--  presupuesto_por_token_lista.sql  (script 11) — PASO 1, por seguridad
--
--  PROBLEMA: presupuesto_por_token(token) devuelve to_jsonb(p) - 'id': la fila ENTERA menos el id. Es la función
--  pública (la usa la landing con la clave anónima). Hoy la fila solo tiene datos que el cliente puede ver, pero el
--  próximo paso (presupuestos creados por el bot) agrega columnas con contacto, canal, origen, idempotencia: con la
--  función como está, el teléfono del cliente saldría en el link público.
--
--  ARREGLO: la función devuelve una LISTA PERMITIDA de campos. Lo que no está en la lista no sale, tampoco lo que se
--  agregue a la tabla en el futuro. La lista es EXACTAMENTE lo que lee la página (precios.js, renderPresupuesto) y
--  la vista previa de WhatsApp (api/compartir.js):
--      cliente, producto, trade_in, cotizacion, pagos_cfg, creado_en, vence_en, notas
--  `token` e `id` NO salen (la página toma el token de la URL y no lee d.token ni d.id).
--
--  TAMBIÉN POR DENTRO: producto y trade_in son JSON y antes salían ENTEROS: cualquier clave que alguien guardara adentro
--  (un costo, un IMEI, un contacto) habría salido por el link. Ahora salen filtrados por una lista permitida de claves,
--  que es exactamente lo que lee la página:
--      producto : nombre, modelo, storage, color, categoria, estado_producto, cantidad, precio_usd, precio_unitario_usd,
--                 servicios (solo textos)
--      trade_in : modelo, storage, color, estado, bateria_pct, valor_usd, equipos[] (modelo, storage, color, estado,
--                 bateria_pct, valor_usd) y efectivo (monto_usd, concepto)
--  pagos_cfg sale entero: es una COPIA de configuracion.pagos_config, que la landing ya lee pública (nunca lleva datos
--  de una persona).
--
--  La respuesta mantiene la misma forma: las 8 claves siempre presentes (null cuando el campo está vacío), igual que
--  antes. Vencido o inexistente: NULL, igual que antes. Mismos permisos que antes. Idempotente.
--  No cambia ningún dato.
-- ============================================================================

-- Ayudantes internos (no los ejecuta nadie más que la función de abajo, que corre con los permisos de su dueño).
CREATE OR REPLACE FUNCTION public.presupuesto__filtrar(j jsonb, claves text[])
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  -- Solo pasan valores SIMPLES (texto, número, verdadero/falso, nulo): una clave permitida con un objeto o una lista
  -- adentro (por ejemplo nombre = {"contacto": …}) se descarta entera.
  SELECT CASE WHEN jsonb_typeof(j) = 'object'
              THEN COALESCE((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(j) e
                              WHERE e.key = ANY (claves) AND jsonb_typeof(e.value) IN ('string', 'number', 'boolean', 'null')), '{}'::jsonb)
         END
$$;

CREATE OR REPLACE FUNCTION public.presupuesto__publico_producto(j jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT public.presupuesto__filtrar(j, ARRAY['nombre','modelo','storage','color','categoria','estado_producto','cantidad','precio_usd','precio_unitario_usd'])
         || CASE WHEN jsonb_typeof(j -> 'servicios') = 'array'
                 THEN jsonb_build_object('servicios', COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(j -> 'servicios') x WHERE jsonb_typeof(x) = 'string'), '[]'::jsonb))
                 ELSE '{}'::jsonb END
$$;

CREATE OR REPLACE FUNCTION public.presupuesto__publico_trade_in(j jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT public.presupuesto__filtrar(j, ARRAY['modelo','storage','color','estado','bateria_pct','valor_usd'])
         || CASE WHEN jsonb_typeof(j -> 'equipos') = 'array'
                 THEN jsonb_build_object('equipos', COALESCE((SELECT jsonb_agg(public.presupuesto__filtrar(x, ARRAY['modelo','storage','color','estado','bateria_pct','valor_usd']))
                                                                FROM jsonb_array_elements(j -> 'equipos') x WHERE jsonb_typeof(x) = 'object'), '[]'::jsonb))
                 ELSE '{}'::jsonb END
         || CASE WHEN jsonb_typeof(j -> 'efectivo') = 'object'
                 THEN jsonb_build_object('efectivo', public.presupuesto__filtrar(j -> 'efectivo', ARRAY['monto_usd','concepto']))
                 ELSE '{}'::jsonb END
$$;

REVOKE ALL ON FUNCTION public.presupuesto__filtrar(jsonb, text[])      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.presupuesto__publico_producto(jsonb)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.presupuesto__publico_trade_in(jsonb)     FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.presupuesto_por_token(p_token text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'cliente',    p.cliente,
           'producto',   public.presupuesto__publico_producto(p.producto),
           'trade_in',   public.presupuesto__publico_trade_in(p.trade_in),
           'cotizacion', p.cotizacion,
           'pagos_cfg',  p.pagos_cfg,
           'creado_en',  p.creado_en,
           'vence_en',   p.vence_en,
           'notas',      p.notas)
  FROM public.presupuestos p
  WHERE p.token = p_token
    AND (p.vence_en IS NULL OR p.vence_en > now())
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.presupuesto_por_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.presupuesto_por_token(text) TO anon, authenticated;

-- Refuerzo: la tabla ya está cerrada por seguridad de filas (la política solo deja pasar a usuarios autorizados), pero
-- Supabase le da por defecto permisos de tabla al rol anónimo. Se le quitan: la landing solo usa la función de arriba,
-- que corre con los permisos de su dueño. El CRM (authenticated) no cambia.
REVOKE ALL ON public.presupuestos FROM PUBLIC, anon;

-- ============================================================================
--  VERIFICACIÓN (solo lectura; sale como tabla). Tiene que verse TODO en ✅.
-- ============================================================================
SELECT id, control, CASE WHEN ok THEN '✅' ELSE '❌' END AS resultado
FROM (
  SELECT '11.1' AS id, 'La función ya no devuelve la fila entera (no usa to_jsonb de la fila)' AS control,
         position('to_jsonb' IN pg_get_functiondef(to_regprocedure('public.presupuesto_por_token(text)'))) = 0 AS ok
  UNION ALL SELECT '11.2', 'La función arma las 8 claves permitidas y ninguna más',
         (SELECT bool_and(position('''' || k || '''' IN d) > 0)
            FROM (SELECT pg_get_functiondef(to_regprocedure('public.presupuesto_por_token(text)')) AS d) f,
                 unnest(ARRAY['cliente','producto','trade_in','cotizacion','pagos_cfg','creado_en','vence_en','notas']) AS k)
  UNION ALL SELECT '11.3', 'La función no nombra ni el id, ni el token, ni contacto, canal u origen',
         (SELECT bool_and(position('''' || k || '''' IN d) = 0)
            FROM (SELECT pg_get_functiondef(to_regprocedure('public.presupuesto_por_token(text)')) AS d) f,
                 unnest(ARRAY['id','token','contacto','canal','origen','idempotencia']) AS k)
  UNION ALL SELECT '11.3b', 'El producto y el canje salen filtrados por dentro (ayudantes internos, no ejecutables por el público)',
         position('presupuesto__publico_producto' IN pg_get_functiondef(to_regprocedure('public.presupuesto_por_token(text)'))) > 0
         AND position('presupuesto__publico_trade_in' IN pg_get_functiondef(to_regprocedure('public.presupuesto_por_token(text)'))) > 0
         AND NOT has_function_privilege('anon', 'public.presupuesto__publico_producto(jsonb)', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public.presupuesto__publico_trade_in(jsonb)', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public.presupuesto__filtrar(jsonb, text[])', 'EXECUTE')
  UNION ALL SELECT '11.4', 'La landing (anon) y el CRM (authenticated) la pueden ejecutar; PUBLIC no',
         has_function_privilege('anon', 'public.presupuesto_por_token(text)', 'EXECUTE')
         AND has_function_privilege('authenticated', 'public.presupuesto_por_token(text)', 'EXECUTE')
         AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.presupuesto_por_token(text)') AND proacl::text ~ '(^\{|,)=X')
  UNION ALL SELECT '11.5', 'La tabla presupuestos está cerrada al público (seguridad por filas activa y anon sin permisos)',
         (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.presupuestos'::regclass)
         AND NOT has_table_privilege('anon', 'public.presupuestos', 'SELECT')
         AND has_table_privilege('authenticated', 'public.presupuestos', 'SELECT, INSERT, UPDATE, DELETE')
) t
ORDER BY id;
