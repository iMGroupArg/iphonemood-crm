-- ============================================================================
--  presupuesto_bot_disponibilidad.sql  (script 18) — el bot cuenta TODAS las unidades idénticas del stock
--
--  PROBLEMA: presupuesto_bot_crear medía la disponibilidad sobre UNA sola fila del stock. Un iPhone con IMEI es una fila por
--  unidad: con dos iguales en stock y cantidad 2, el bot respondía UNIDAD_NO_DISPONIBLE aunque el CRM lo ofrece como "(2 u.)".
--
--  QUÉ HACE: reemplaza solamente la función presupuesto_bot_crear (mismo nombre, mismos argumentos, mismos permisos). La única
--  diferencia: la disponibilidad suma las filas idénticas del stock, con la misma clave y los mismos filtros que el CRM
--  (Presupuestos.equiposDisponibles): nombre | modelo | capacidad | color | precio en USD redondeado, sin distinguir mayúsculas.
--  Cada fila aporta lo que tenga cargado (IMEI o cantidad, el mayor). Lo demás queda igual.
--
--  REQUISITOS: script 13 corrido (si no, frena con un mensaje). Idempotente. No cambia ningún dato.
-- ============================================================================

DO $$
BEGIN
  IF to_regprocedure('public.presupuesto_bot_crear(text,uuid,integer,jsonb,text,text,text,text,text,text)') IS NULL
     OR to_regclass('public.presupuesto_bot_config') IS NULL THEN
    RAISE EXCEPTION 'Falta el script 13 (presupuesto_bot). Correrlo antes que este.';
  END IF;
END $$;

BEGIN;

CREATE OR REPLACE FUNCTION public.presupuesto_bot_crear(
  p_secreto text, p_unidad uuid, p_cantidad integer, p_canje jsonb,
  p_cliente text, p_contacto_tipo text, p_contacto_valor text, p_canal text, p_idem text, p_modo text DEFAULT 'real')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_cant      integer;
  v_disp      integer;      -- unidades disponibles del MISMO equipo (todas las filas idénticas del stock)
  v_canje     jsonb := '[]'::jsonb;
  v_el        jsonb;
  v_clave     text;
  v_cliente   text;
  v_ctipo     text;
  v_cval      text;
  v_hash      text;
  v_idem      text;
  v_ahora     timestamptz;
  v_tope_dia  numeric;
  v_constr    text;
  v_origen    text;
  ex          public.presupuestos%ROWTYPE;
  u           public.stock%ROWTYPE;
  v_unit      integer;
  v_cot       numeric;
  v_pagos     jsonb;
  v_pagos_txt text;
  v_ref       integer;
  v_tope      numeric;
  v_total_ti  integer := 0;
  v_equipos   jsonb := '[]'::jsonb;
  v_eq        jsonb;
  v_hoy       date;
  v_n         integer;
  v_token     text;
  v_vence     timestamptz;
  v_producto  jsonb;
  v_trade     jsonb;
  v_ret_dias  numeric;
  v_modelo    text;
  v_cap       text;
  v_estado    text;
BEGIN
  IF public.presupuesto_bot_secreto_ok(p_secreto) IS NOT TRUE THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF p_modo IS NULL OR p_modo NOT IN ('real', 'prueba') THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;
  v_origen := CASE p_modo WHEN 'prueba' THEN 'bot_prueba' ELSE 'bot' END;

  -- ── La forma del pedido, validada acá y no solo en el endpoint ────────────
  IF p_idem IS NULL OR p_idem !~ '^[A-Za-z0-9_-]{8,64}$' OR p_idem ~ '[0-9]{8}' THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;   -- sin 8 dígitos seguidos: nunca un teléfono
  IF p_unidad IS NULL THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;
  v_cant := COALESCE(p_cantidad, 1);
  IF v_cant < 1 OR v_cant > public.presupuesto_bot__cfg('cantidad_max', 5) THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;
  IF p_canal IS NULL OR p_canal NOT IN ('whatsapp', 'instagram', 'mercadolibre', 'web', 'otro') THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;

  v_cliente := NULLIF(btrim(COALESCE(p_cliente, '')), '');
  IF v_cliente IS NOT NULL AND v_cliente !~ '^[A-Za-zÀ-ÿ''’. -]{1,60}$' THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;

  -- Contacto: tipo y valor juntos. Teléfono en formato internacional (E.164) o usuario / id de Instagram. En modo prueba no se guarda.
  v_ctipo := NULLIF(btrim(COALESCE(p_contacto_tipo, '')), '');
  v_cval  := NULLIF(btrim(COALESCE(p_contacto_valor, '')), '');
  IF (v_ctipo IS NULL) <> (v_cval IS NULL) THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;
  IF v_ctipo IS NOT NULL THEN
    IF v_ctipo NOT IN ('telefono', 'instagram') THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;
    IF v_ctipo = 'telefono' THEN
      v_cval := regexp_replace(v_cval, '[\s().-]', '', 'g');
      IF v_cval !~ '^\+[1-9][0-9]{7,14}$' THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;
    ELSE
      v_cval := lower(regexp_replace(v_cval, '^@', ''));
      IF v_cval !~ '^[a-z0-9._]{1,30}$' THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;
    END IF;
  END IF;

  IF p_canje IS NOT NULL AND jsonb_typeof(p_canje) NOT IN ('array', 'null') THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;
  IF p_canje IS NOT NULL AND jsonb_typeof(p_canje) = 'array' THEN
    IF jsonb_array_length(p_canje) > public.presupuesto_bot__cfg('canje_max_equipos', 3) THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;
    FOR v_el IN SELECT * FROM jsonb_array_elements(p_canje) LOOP
      IF jsonb_typeof(v_el) <> 'object' THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;
      FOR v_clave IN SELECT jsonb_object_keys(v_el) LOOP
        IF v_clave NOT IN ('modelo', 'storage', 'estado', 'bateria_pct', 'valor_usd') THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;
      END LOOP;
      -- Obligatorias: modelo, storage, bateria_pct y valor_usd. `estado` es OPCIONAL (si viene, se valida más abajo). Las comparaciones
      -- son IS DISTINCT FROM: una clave ausente daría NULL y un IF con NULL no rechaza.
      IF NOT (v_el ? 'modelo' AND v_el ? 'storage' AND v_el ? 'bateria_pct' AND v_el ? 'valor_usd')
         OR jsonb_typeof(v_el -> 'modelo') IS DISTINCT FROM 'string' OR length(btrim(v_el ->> 'modelo')) NOT BETWEEN 1 AND 60
         OR jsonb_typeof(v_el -> 'storage') IS DISTINCT FROM 'string' OR length(btrim(v_el ->> 'storage')) NOT BETWEEN 1 AND 20
         OR (v_el ? 'estado' AND jsonb_typeof(v_el -> 'estado') NOT IN ('string', 'null'))
         OR jsonb_typeof(v_el -> 'bateria_pct') IS DISTINCT FROM 'number' OR (v_el ->> 'bateria_pct') !~ '^[0-9]{1,3}$'
         OR jsonb_typeof(v_el -> 'valor_usd') IS DISTINCT FROM 'number' OR (v_el ->> 'valor_usd') !~ '^[0-9]{1,6}$' THEN
        RAISE EXCEPTION 'CUERPO_INVALIDO';
      END IF;
      v_canje := v_canje || jsonb_build_object('modelo', btrim(v_el ->> 'modelo'), 'storage', btrim(v_el ->> 'storage'),
                   'estado', COALESCE(NULLIF(btrim(v_el ->> 'estado'), ''), ''), 'bateria_pct', (v_el ->> 'bateria_pct')::int, 'valor_usd', (v_el ->> 'valor_usd')::int);
    END LOOP;
  END IF;

  -- La clave de idempotencia se guarda como HASH, nunca en texto (si el bot mandara una con un teléfono, no sobrevive a la limpieza).
  v_idem := encode(extensions.digest(p_idem, 'sha256'), 'hex');
  -- La huella del pedido NORMALIZADO (sin precios derivados): sirve para saber si un reintento es el mismo pedido.
  v_hash := encode(extensions.digest(jsonb_build_object('u', p_unidad, 'c', v_cant, 'k', v_canje, 'n', v_cliente, 'ct', v_ctipo, 'cv', v_cval, 'a', p_canal, 'm', p_modo)::text, 'sha256'), 'hex');

  -- ── Idempotencia: PRIMERO, antes de mirar stock, precios o topes ──────────
  SELECT * INTO ex FROM public.presupuestos WHERE idempotencia = v_idem;
  IF FOUND THEN
    IF ex.payload_hash IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'IDEMPOTENCIA_CONFLICTO'; END IF;
    IF ex.vence_en IS NOT NULL AND ex.vence_en <= now() THEN RAISE EXCEPTION 'IDEMPOTENCIA_VENCIDA'; END IF;
    RETURN jsonb_build_object('ok', true, 'token', ex.token, 'vence_en', ex.vence_en, 'reutilizado', true, 'modo', p_modo);
  END IF;

  -- ── A partir de acá se serializa: contar + insertar sin carreras ───────────
  PERFORM pg_advisory_xact_lock(7770002);
  v_ahora := clock_timestamp();                                               -- la hora se toma DESPUÉS de esperar el candado
  v_hoy := (v_ahora AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
  SELECT * INTO ex FROM public.presupuestos WHERE idempotencia = v_idem;       -- otro pedido igual pudo terminar mientras esperábamos
  IF FOUND THEN
    IF ex.payload_hash IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'IDEMPOTENCIA_CONFLICTO'; END IF;
    IF ex.vence_en IS NOT NULL AND ex.vence_en <= now() THEN RAISE EXCEPTION 'IDEMPOTENCIA_VENCIDA'; END IF;
    RETURN jsonb_build_object('ok', true, 'token', ex.token, 'vence_en', ex.vence_en, 'reutilizado', true, 'modo', p_modo);
  END IF;

  -- Limpieza por lotes (el plazo se cumple aunque nadie abra el CRM): teléfonos vencidos y presupuestos de prueba viejos.
  -- SKIP LOCKED y en orden: dos limpiezas a la vez nunca se esperan entre sí.
  UPDATE public.presupuestos SET contacto = NULL, contacto_tipo = NULL, contacto_borrar_en = NULL
   WHERE id IN (SELECT id FROM public.presupuestos WHERE contacto IS NOT NULL AND contacto_borrar_en < v_ahora ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED);
  DELETE FROM public.presupuestos
   WHERE id IN (SELECT id FROM public.presupuestos WHERE origen = 'bot_prueba'
                  AND creado_en < v_ahora - make_interval(hours => public.presupuesto_bot__cfg('prueba_retencion_horas', 24)::int)
                ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED);

  -- ── La unidad: tres respuestas distintas para que el bot refresque su catálogo ──
  SELECT * INTO u FROM public.stock WHERE id = p_unidad;
  IF NOT FOUND OR u.estado_inventario IS NOT DISTINCT FROM 'eliminado' THEN RAISE EXCEPTION 'UNIDAD_INEXISTENTE'; END IF;
  IF u.estado_inventario IS NOT DISTINCT FROM 'vendido' THEN RAISE EXCEPTION 'UNIDAD_VENDIDA'; END IF;
  IF u.estado_inventario IS DISTINCT FROM 'disponible'
     OR COALESCE(u.categoria, '') NOT IN ('iphone', 'android', 'mac', 'ipad')               -- igual que el CRM: la categoría exacta
     OR COALESCE(u.a_pedido, FALSE)
     OR COALESCE(u.precio_ars, 0) <= 0 OR COALESCE(u.cotizacion, 0) <= 0 THEN
    RAISE EXCEPTION 'UNIDAD_NO_DISPONIBLE';
  END IF;
  v_unit := ROUND(u.precio_ars::numeric / u.cotizacion::numeric)::int;
  IF v_unit < 1 THEN RAISE EXCEPTION 'UNIDAD_NO_DISPONIBLE'; END IF;
  -- Cuántas unidades hay DEL MISMO EQUIPO: se suman todas las filas idénticas del stock (típico: un iPhone con IMEI es una
  -- fila por unidad). Es la misma clave y los mismos filtros con los que el CRM arma su lista (Presupuestos.equiposDisponibles):
  -- nombre | modelo | capacidad | color | precio en USD (redondeado), sin distinguir mayúsculas; vacío y NULL son lo mismo.
  -- Cada fila aporta lo que tenga cargado (IMEI o cantidad, el mayor).
  SELECT COALESCE(sum(GREATEST(COALESCE(array_length(s.imeis, 1), 0), COALESCE(s.cantidad, 0))), 0)::int INTO v_disp
    FROM public.stock s
   WHERE s.estado_inventario IS NOT DISTINCT FROM 'disponible'
     AND COALESCE(s.categoria, '') IN ('iphone', 'android', 'mac', 'ipad')
     AND NOT COALESCE(s.a_pedido, FALSE)
     AND COALESCE(s.precio_ars, 0) > 0 AND COALESCE(s.cotizacion, 0) > 0
     AND lower(COALESCE(s.nombre, '') || '|' || COALESCE(s.modelo, '') || '|' || COALESCE(s.storage, '') || '|' || COALESCE(s.color, '')
               || '|' || ROUND(s.precio_ars::numeric / s.cotizacion::numeric)::int)
       = lower(COALESCE(u.nombre, '') || '|' || COALESCE(u.modelo, '') || '|' || COALESCE(u.storage, '') || '|' || COALESCE(u.color, '')
               || '|' || v_unit);
  IF v_disp < v_cant THEN RAISE EXCEPTION 'UNIDAD_NO_DISPONIBLE'; END IF;

  -- ── Dólar y financiación: las MISMAS fuentes que usa el CRM al guardar ─────
  SELECT CASE WHEN valor ~ '^[0-9]+(\.[0-9]+)?$' THEN valor::numeric END INTO v_cot FROM public.configuracion WHERE clave = 'ref_blue';
  IF v_cot IS NULL OR v_cot <= 0 THEN RAISE EXCEPTION 'SIN_COTIZACION'; END IF;
  SELECT valor INTO v_pagos_txt FROM public.configuracion WHERE clave = 'pagos_config';
  BEGIN
    v_pagos := v_pagos_txt::jsonb;
  EXCEPTION WHEN others THEN v_pagos := NULL;
  END;
  IF v_pagos IS NULL OR public.presupuesto_bot__financiacion_ok(v_pagos) IS NOT TRUE THEN RAISE EXCEPTION 'SIN_FINANCIACION_VALIDA'; END IF;

  -- ── El canje: los nombres se comparan sin distinguir mayúsculas, tildes ni espacios y se guardan con el nombre del catálogo ──
  v_equipos := '[]'::jsonb;
  FOR v_el IN SELECT * FROM jsonb_array_elements(v_canje) LOOP
    SELECT c.modelo INTO v_modelo FROM public.catalogo_modelos_publico c
     WHERE public.presupuesto_bot__norm(c.modelo) = public.presupuesto_bot__norm(v_el ->> 'modelo') ORDER BY c.orden LIMIT 1;
    IF v_modelo IS NULL THEN
      RAISE EXCEPTION 'CANJE_MODELO_INEXISTENTE' USING DETAIL = jsonb_build_object('recibido', v_el ->> 'modelo',
        'validos', (SELECT COALESCE(jsonb_agg(modelo ORDER BY orden, modelo), '[]'::jsonb) FROM public.catalogo_modelos_publico))::text;
    END IF;
    SELECT cap INTO v_cap FROM public.catalogo_modelos_publico c, unnest(c.capacidades) AS cap
     WHERE c.modelo = v_modelo AND public.presupuesto_bot__norm(cap) = public.presupuesto_bot__norm(v_el ->> 'storage') LIMIT 1;
    IF v_cap IS NULL THEN
      RAISE EXCEPTION 'CANJE_CAPACIDAD_INEXISTENTE' USING DETAIL = jsonb_build_object('recibido', v_el ->> 'storage', 'modelo', v_modelo,
        'validos', (SELECT to_jsonb(capacidades) FROM public.catalogo_modelos_publico WHERE modelo = v_modelo))::text;
    END IF;
    v_estado := v_el ->> 'estado';
    IF v_estado <> '' THEN
      SELECT e INTO v_estado FROM unnest(ARRAY['Nuevo / Sellado', 'Excelente', 'Muy bueno', 'Bueno', 'Con detalles']) AS e
       WHERE public.presupuesto_bot__norm(e) = public.presupuesto_bot__norm(v_el ->> 'estado') LIMIT 1;
      IF v_estado IS NULL THEN RAISE EXCEPTION 'CANJE_ESTADO_INVALIDO'; END IF;
    END IF;
    IF (v_el ->> 'bateria_pct')::int NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'CANJE_BATERIA_INVALIDA'; END IF;
    IF (v_el ->> 'valor_usd')::int < 1 THEN RAISE EXCEPTION 'CANJE_VALOR_INVALIDO'; END IF;
    IF (v_el ->> 'valor_usd')::int < public.presupuesto_bot__cfg('canje_valor_min', 50)
       OR (v_el ->> 'valor_usd')::int > public.presupuesto_bot__cfg('canje_valor_max', 2500) THEN
      RAISE EXCEPTION 'CANJE_VALOR_FUERA_DE_RANGO' USING DETAIL = jsonb_build_object('minimo', public.presupuesto_bot__cfg('canje_valor_min', 50),
        'maximo', public.presupuesto_bot__cfg('canje_valor_max', 2500))::text;
    END IF;
    SELECT precio_usd INTO v_ref FROM public.canje_ultimo_precio_publico WHERE modelo = v_modelo AND storage = v_cap;
    IF v_ref IS NULL THEN RAISE EXCEPTION 'CANJE_SIN_REFERENCIA'; END IF;
    v_tope := floor(v_ref * public.presupuesto_bot__cfg('canje_tope_pct', 100) / 100);
    IF (v_el ->> 'valor_usd')::int > v_tope THEN RAISE EXCEPTION 'CANJE_SOBRE_EL_TOPE'; END IF;
    v_total_ti := v_total_ti + (v_el ->> 'valor_usd')::int;
    v_equipos := v_equipos || jsonb_build_object('modelo', v_modelo, 'storage', v_cap, 'color', '',
                   'estado', COALESCE(v_estado, ''), 'bateria_pct', (v_el ->> 'bateria_pct')::int, 'valor_usd', (v_el ->> 'valor_usd')::int);
  END LOOP;
  IF jsonb_array_length(v_canje) > 0 AND (v_total_ti IS NULL OR v_total_ti >= v_unit * v_cant) THEN RAISE EXCEPTION 'CANJE_MAYOR_AL_PRECIO'; END IF;

  -- ── Topes (el conteo del minuto y el alta están serializados por el candado) ───
  SELECT count(*) INTO v_n FROM public.presupuestos WHERE origen = v_origen AND creado_en > v_ahora - interval '1 minute';
  IF v_n >= public.presupuesto_bot__cfg('tope_por_minuto', 5) THEN RAISE EXCEPTION 'DEMASIADOS_PEDIDOS'; END IF;

  -- ── Se arma el presupuesto con el MISMO formato que guarda el CRM ──────────
  v_token := replace(gen_random_uuid()::text, '-', '');
  v_vence := v_ahora + CASE WHEN p_modo = 'prueba' THEN make_interval(mins => public.presupuesto_bot__cfg('prueba_vence_min', 30)::int)
                            ELSE make_interval(days => public.presupuesto_bot__cfg('dias_validez', 2)::int) END;
  v_ret_dias := public.presupuesto_bot__cfg('contacto_retencion_dias', 180);
  -- Mismos valores que el CRM al armar el producto (supabase-config.js): modelo, capacidad, color y estado vacíos son '' y no NULL.
  v_producto := jsonb_build_object('nombre', u.nombre, 'modelo', COALESCE(u.modelo, ''), 'storage', COALESCE(u.storage, ''), 'color', COALESCE(u.color, ''),
                  'categoria', u.categoria, 'estado_producto', COALESCE(u.estado_producto, ''), 'cantidad', v_cant,
                  'precio_unitario_usd', v_unit, 'precio_usd', v_unit * v_cant, 'servicios', '[]'::jsonb);
  IF jsonb_array_length(v_canje) > 0 THEN
    v_eq := v_equipos -> 0;
    v_trade := jsonb_build_object('equipos', v_equipos, 'modelo', v_eq -> 'modelo', 'storage', v_eq -> 'storage', 'color', v_eq -> 'color',
                 'estado', v_eq -> 'estado', 'bateria_pct', v_eq -> 'bateria_pct', 'valor_usd', v_total_ti);
  END IF;
  IF p_modo = 'prueba' THEN v_ctipo := NULL; v_cval := NULL; v_cliente := NULL; END IF;     -- una prueba nunca guarda un contacto ni un nombre (el nombre saldría por el link público)

  -- Contador diario y alta en el MISMO sub-bloque: si el alta falla, el cupo no se gasta.
  BEGIN
    v_tope_dia := CASE WHEN p_modo = 'prueba' THEN public.presupuesto_bot__cfg('tope_prueba_diario', 100) ELSE public.presupuesto_bot__cfg('tope_diario', 60) END;
    -- El tope se aplica TAMBIÉN al primer presupuesto del día (con tope 0 no se crea ninguno).
    INSERT INTO public.presupuesto_bot_uso AS uso (dia, modo, n) SELECT v_hoy, p_modo, 1 WHERE v_tope_dia >= 1
      ON CONFLICT (dia, modo) DO UPDATE SET n = uso.n + 1 WHERE uso.n < v_tope_dia
      RETURNING n INTO v_n;
    IF v_n IS NULL THEN RAISE EXCEPTION 'TOPE_DIARIO'; END IF;

    INSERT INTO public.presupuestos (token, creado_en, vence_en, cliente, producto, trade_in, cotizacion, pagos_cfg, notas,
                                     origen, canal, contacto_tipo, contacto, contacto_borrar_en, idempotencia, payload_hash)
    VALUES (v_token, v_ahora, v_vence, v_cliente, v_producto, v_trade, v_cot, v_pagos, NULL,
            v_origen, p_canal, v_ctipo, v_cval, CASE WHEN v_cval IS NOT NULL THEN v_ahora + make_interval(days => v_ret_dias::int) END, v_idem, v_hash);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constr = CONSTRAINT_NAME;
    IF v_constr IS DISTINCT FROM 'presupuestos_idempotencia_unica' THEN RAISE; END IF;      -- cualquier otro choque (el token es aleatorio) NO se disfraza
    -- La clave de idempotencia: el pedido igual ya está. Se devuelve ese.
    SELECT * INTO ex FROM public.presupuestos WHERE idempotencia = v_idem;
    IF NOT FOUND THEN RAISE EXCEPTION 'ERROR_INTERNO'; END IF;
    IF ex.payload_hash IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'IDEMPOTENCIA_CONFLICTO'; END IF;
    RETURN jsonb_build_object('ok', true, 'token', ex.token, 'vence_en', ex.vence_en, 'reutilizado', true, 'modo', p_modo);
  END;

  RETURN jsonb_build_object('ok', true, 'token', v_token, 'vence_en', v_vence, 'reutilizado', false, 'modo', p_modo);
END; $$;

-- Los permisos no cambian (CREATE OR REPLACE los conserva); se repiten por si acaso.
REVOKE ALL ON FUNCTION public.presupuesto_bot_crear(text, uuid, integer, jsonb, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.presupuesto_bot_crear(text, uuid, integer, jsonb, text, text, text, text, text, text) TO anon, authenticated;

COMMIT;

-- ============================================================================
--  VERIFICACIÓN (solo lectura; sale como tabla al final). Tiene que verse TODO en ✅.
-- ============================================================================
SELECT id, control, CASE WHEN ok THEN '✅' ELSE '❌' END AS resultado
FROM (
  SELECT '18.1' AS id, 'presupuesto_bot_crear ahora cuenta las filas idénticas del stock' AS control,
         position('v_disp' IN pg_get_functiondef(to_regprocedure('public.presupuesto_bot_crear(text,uuid,integer,jsonb,text,text,text,text,text,text)'))) > 0 AS ok
  UNION ALL SELECT '18.2', 'Sigue habiendo UNA sola versión de la función',
         (SELECT count(*) = 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'presupuesto_bot_crear')
  UNION ALL SELECT '18.3', 'Los permisos siguen igual: anon y authenticated la ejecutan, PUBLIC no',
         has_function_privilege('anon', 'public.presupuesto_bot_crear(text,uuid,integer,jsonb,text,text,text,text,text,text)', 'EXECUTE')
         AND has_function_privilege('authenticated', 'public.presupuesto_bot_crear(text,uuid,integer,jsonb,text,text,text,text,text,text)', 'EXECUTE')
         AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                          WHERE p.oid = 'public.presupuesto_bot_crear(text,uuid,integer,jsonb,text,text,text,text,text,text)'::regprocedure
                            AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
) t
ORDER BY id;
