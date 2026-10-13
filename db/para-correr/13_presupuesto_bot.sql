-- ============================================================================
--  presupuesto_bot.sql  (script 13) — PRESUPUESTOS CREADOS POR EL BOT
--
--  El bot de WhatsApp le pasa al cliente un presupuesto del MISMO tipo que los que arma el CRM: misma tabla `presupuestos`,
--  mismo formato de datos, mismo link (precios.html?presupuesto=<token>) y misma página. Plan, revisión de Codex y contrato
--  para el bot: docs/presupuesto-bot-plan.md.
--
--  QUÉ HACE
--   1) Columnas nuevas en `presupuestos` (todas con valor por defecto: el CRM actual sigue funcionando igual):
--      origen ('crm'|'bot'), canal, contacto (solo teléfono), contacto_borrar_en, idempotencia, payload_hash.
--   2) Dos tablas internas CERRADAS (sin acceso para el navegador): presupuesto_bot_config (secreto hasheado y topes) y
--      presupuesto_bot_uso (contador diario).
--   3) presupuesto_bot_crear(...): crea el presupuesto. El bot manda SOLO referencias (la unidad, el canje); el precio, el
--      dólar, las cuotas y el vencimiento los pone el CRM con sus propios datos. Valida todo, es idempotente y respeta
--      los topes sin carreras.
--   4) Limpieza de teléfonos vencidos (180 días): al crear, al abrir la lista del CRM y desde el cron diario.
--
--  SEGURIDAD
--   · Ningún dato interno (contacto, canal, origen, idempotencia, huella) sale por el link público: lo garantiza el
--     script 11 (lista permitida en presupuesto_por_token), que tiene que estar corrido ANTES.
--   · La función de creación exige un secreto compartido (su SHA-256 está en presupuesto_bot_config). Sin secreto cargado,
--     queda cerrada. El secreto va en Vercel como PRESUPUESTO_RPC_SECRET (no en el chat ni en git).
--
--  REQUISITOS: scripts 6, 8 y 11 corridos (catálogo de modelos, último precio de canje y la lista permitida del link).
--  Idempotente (se puede correr varias veces). No cambia ningún presupuesto existente.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.presupuestos') IS NULL OR to_regclass('public.configuracion') IS NULL THEN
    RAISE EXCEPTION 'Falta la tabla presupuestos o configuracion.';
  END IF;
  IF to_regclass('public.catalogo_modelos_publico') IS NULL OR to_regclass('public.canje_ultimo_precio_publico') IS NULL THEN
    RAISE EXCEPTION 'Faltan los scripts 6 y/o 8 (catalogo_modelos_publico y canje_ultimo_precio_publico). Correrlos antes que este.';
  END IF;
  IF to_regprocedure('public.presupuesto__publico_producto(jsonb)') IS NULL
     OR to_regprocedure('public.presupuesto_por_token(text)') IS NULL
     OR position('presupuesto__publico_producto' IN pg_get_functiondef(to_regprocedure('public.presupuesto_por_token(text)'))) = 0
     OR position('to_jsonb' IN pg_get_functiondef(to_regprocedure('public.presupuesto_por_token(text)'))) > 0 THEN
    RAISE EXCEPTION 'Falta el script 11, o la función presupuesto_por_token volvió a la versión vieja que devuelve la fila entera: correr (otra vez) el script 11 ANTES, para que el contacto nunca salga por el link.';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

BEGIN;

-- ── 1 · Columnas ───────────────────────────────────────────────────────────
ALTER TABLE public.presupuestos
  ADD COLUMN IF NOT EXISTS origen             text NOT NULL DEFAULT 'crm',
  ADD COLUMN IF NOT EXISTS canal              text,
  ADD COLUMN IF NOT EXISTS contacto           text,
  ADD COLUMN IF NOT EXISTS contacto_borrar_en timestamptz,
  ADD COLUMN IF NOT EXISTS idempotencia       text,
  ADD COLUMN IF NOT EXISTS payload_hash       text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'presupuestos_origen_ck') THEN
    ALTER TABLE public.presupuestos ADD CONSTRAINT presupuestos_origen_ck CHECK (origen IN ('crm', 'bot'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'presupuestos_canal_ck') THEN
    ALTER TABLE public.presupuestos ADD CONSTRAINT presupuestos_canal_ck
      CHECK (canal IS NULL OR canal IN ('whatsapp', 'instagram', 'mercadolibre', 'web', 'otro'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'presupuestos_contacto_ck') THEN
    ALTER TABLE public.presupuestos ADD CONSTRAINT presupuestos_contacto_ck
      CHECK (contacto IS NULL OR contacto ~ '^\+?[0-9]{8,15}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'presupuestos_bot_ck') THEN
    -- Un presupuesto del bot siempre trae su clave de idempotencia y la huella de lo pedido.
    ALTER TABLE public.presupuestos ADD CONSTRAINT presupuestos_bot_ck
      CHECK (origen = 'crm' OR (idempotencia IS NOT NULL AND payload_hash IS NOT NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS presupuestos_idempotencia_unica ON public.presupuestos (idempotencia) WHERE idempotencia IS NOT NULL;
CREATE INDEX IF NOT EXISTS presupuestos_contacto_vence ON public.presupuestos (contacto_borrar_en) WHERE contacto IS NOT NULL;
CREATE INDEX IF NOT EXISTS presupuestos_bot_creado ON public.presupuestos (creado_en) WHERE origen = 'bot';

-- ── 2 · Tablas internas (cerradas) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.presupuesto_bot_config (
  clave text PRIMARY KEY,
  valor text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.presupuesto_bot_uso (
  dia date PRIMARY KEY,
  n   integer NOT NULL DEFAULT 0
);
ALTER TABLE public.presupuesto_bot_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.presupuesto_bot_uso    ENABLE ROW LEVEL SECURITY;
-- Sin políticas, y se quitan los permisos que Supabase da por defecto: nadie las lee ni las escribe desde el navegador.
REVOKE ALL ON public.presupuesto_bot_config FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.presupuesto_bot_uso    FROM PUBLIC, anon, authenticated;

-- Valores por defecto (decididos con Franco). Se cambian con un UPDATE en el SQL Editor, sin desplegar.
INSERT INTO public.presupuesto_bot_config (clave, valor) VALUES
  ('dias_validez', '2'),                  -- "48 hs" del bot
  ('tope_diario', '40'),
  ('tope_por_minuto', '5'),
  ('canje_tope_pct', '100'),              -- tope del canje: 100 % del último precio vendido
  ('canje_max_equipos', '3'),
  ('cantidad_max', '5'),
  ('contacto_retencion_dias', '180')
ON CONFLICT (clave) DO NOTHING;

-- Hash (SHA-256) del secreto que el servidor le manda a la base. NO es el secreto: publicarlo no compromete nada.
-- El secreto va en Vercel como PRESUPUESTO_RPC_SECRET. Para rotarlo: nuevo secreto → nuevo hash acá → nuevo valor en Vercel.
INSERT INTO public.presupuesto_bot_config (clave, valor)
  VALUES ('rpc_secret_sha256', '103072efc57fc56122a1f05e41d65d9fc6b3e386b75cd6d620e245f1c4f94f25')
  ON CONFLICT (clave) DO NOTHING;

-- ── 3 · Ayudantes internos (no ejecutables por nadie más que las funciones de abajo) ─────────────────────
CREATE OR REPLACE FUNCTION public.presupuesto_bot_secreto_ok(p_secreto text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_hash text;
BEGIN
  IF p_secreto IS NULL OR length(p_secreto) < 20 THEN RETURN FALSE; END IF;
  SELECT valor INTO v_hash FROM public.presupuesto_bot_config WHERE clave = 'rpc_secret_sha256';
  IF v_hash IS NULL THEN RETURN FALSE; END IF;                 -- sin secreto cargado, cerrado
  RETURN encode(extensions.digest(p_secreto, 'sha256'), 'hex') = v_hash;
END; $$;

CREATE OR REPLACE FUNCTION public.presupuesto_bot__cfg(p_clave text, p_defecto numeric)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((SELECT CASE WHEN valor ~ '^[0-9]+(\.[0-9]+)?$' THEN valor::numeric END
                     FROM public.presupuesto_bot_config WHERE clave = p_clave), p_defecto)
$$;

-- ¿Sirve la configuración de financiación para calcular cuotas? Es la MISMA regla que usa la página (`cuotasDe`): una cuota
-- se publica si `mostrar` no es falso y su coeficiente es un número > 0. Toda cuota publicable tiene que tener n ∈ {3,6,9,12}.
-- Tiene que haber al menos una cuota publicable, en el bloque `promo` o en `otros` (formato nuevo).
CREATE OR REPLACE FUNCTION public.presupuesto_bot__financiacion_ok(j jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  k text; c jsonb; v_publicables int := 0;
BEGIN
  IF jsonb_typeof(j) IS DISTINCT FROM 'object' THEN RETURN FALSE; END IF;
  FOREACH k IN ARRAY ARRAY['contado_factor', 'lista_factor'] LOOP
    IF j ? k AND (jsonb_typeof(j -> k) IS DISTINCT FROM 'number' OR (j ->> k)::numeric <= 0) THEN RETURN FALSE; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['promo', 'otros'] LOOP
    IF j ? k AND jsonb_typeof(j -> k) = 'object' THEN
      IF jsonb_typeof(j -> k -> 'cuotas') IS DISTINCT FROM 'array' THEN RETURN FALSE; END IF;
      FOR c IN SELECT * FROM jsonb_array_elements(j -> k -> 'cuotas') LOOP
        IF jsonb_typeof(c) IS DISTINCT FROM 'object' THEN RETURN FALSE; END IF;
        -- La página publica una cuota si `mostrar !== false` y `coef != null && coef > 0` (con la coerción de JavaScript). Acá se
        -- exige que la cuota visible tenga un coeficiente que NO dependa de esa coerción: número, o ausente / null (no se publica).
        IF (c -> 'mostrar') IS DISTINCT FROM 'false'::jsonb THEN
          IF c ? 'coef' AND jsonb_typeof(c -> 'coef') NOT IN ('number', 'null') THEN RETURN FALSE; END IF;
          IF jsonb_typeof(c -> 'coef') = 'number' AND (c ->> 'coef')::numeric > 0 THEN
            -- Publicable: `n` es obligatorio y entero entre los permitidos (sin n, la página calcula NaN o divide por cero).
            IF jsonb_typeof(c -> 'n') IS DISTINCT FROM 'number' OR (c ->> 'n') !~ '^(3|6|9|12)$' THEN RETURN FALSE; END IF;
            v_publicables := v_publicables + 1;
          END IF;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN v_publicables >= 1;
END; $$;

-- ── 4 · Crear un presupuesto desde el bot ───────────────────────────────────
--   Devuelve { ok:true, token, vence_en, reutilizado }. Todos los errores son excepciones con un código estable.
CREATE OR REPLACE FUNCTION public.presupuesto_bot_crear(
  p_secreto text, p_unidad uuid, p_cantidad integer, p_canje jsonb,
  p_cliente text, p_contacto text, p_canal text, p_idem text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_cant      integer;
  v_canje     jsonb := '[]'::jsonb;
  v_el        jsonb;
  v_clave     text;
  v_cliente   text;
  v_tel       text;
  v_hash      text;
  v_idem      text;
  v_ahora     timestamptz;
  v_tope_dia  numeric;
  v_constr    text;
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
BEGIN
  IF public.presupuesto_bot_secreto_ok(p_secreto) IS NOT TRUE THEN RAISE EXCEPTION 'no autorizado'; END IF;

  -- ── La forma del pedido, validada acá y no solo en el endpoint ────────────
  IF p_idem IS NULL OR p_idem !~ '^[A-Za-z0-9_-]{8,64}$' OR p_idem ~ '[0-9]{8}' THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;   -- sin 8 dígitos seguidos: nunca un teléfono
  IF p_unidad IS NULL THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;
  v_cant := COALESCE(p_cantidad, 1);
  IF v_cant < 1 OR v_cant > public.presupuesto_bot__cfg('cantidad_max', 5) THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;
  IF p_canal IS NULL OR p_canal NOT IN ('whatsapp', 'instagram', 'mercadolibre', 'web', 'otro') THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;

  v_cliente := NULLIF(btrim(COALESCE(p_cliente, '')), '');
  IF v_cliente IS NOT NULL AND v_cliente !~ '^[A-Za-zÀ-ÿ''’. -]{1,60}$' THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;

  v_tel := NULLIF(regexp_replace(COALESCE(p_contacto, ''), '[^0-9+]', '', 'g'), '');
  IF v_tel IS NOT NULL AND v_tel !~ '^\+?[0-9]{8,15}$' THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;

  IF p_canje IS NOT NULL AND jsonb_typeof(p_canje) NOT IN ('array', 'null') THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;
  IF p_canje IS NOT NULL AND jsonb_typeof(p_canje) = 'array' THEN
    IF jsonb_array_length(p_canje) > public.presupuesto_bot__cfg('canje_max_equipos', 3) THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;
    FOR v_el IN SELECT * FROM jsonb_array_elements(p_canje) LOOP
      IF jsonb_typeof(v_el) <> 'object' THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;
      FOR v_clave IN SELECT jsonb_object_keys(v_el) LOOP
        IF v_clave NOT IN ('modelo', 'storage', 'estado', 'bateria_pct', 'valor_usd') THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;
      END LOOP;
      -- Las CINCO claves son obligatorias (una ausente daría NULL y un IF con NULL no rechaza) y cada tipo se compara con IS DISTINCT FROM.
      IF NOT (v_el ? 'modelo' AND v_el ? 'storage' AND v_el ? 'estado' AND v_el ? 'bateria_pct' AND v_el ? 'valor_usd')
         OR jsonb_typeof(v_el -> 'modelo') IS DISTINCT FROM 'string' OR length(btrim(v_el ->> 'modelo')) NOT BETWEEN 1 AND 60
         OR jsonb_typeof(v_el -> 'storage') IS DISTINCT FROM 'string' OR length(btrim(v_el ->> 'storage')) NOT BETWEEN 1 AND 20
         OR jsonb_typeof(v_el -> 'estado') IS DISTINCT FROM 'string'
         OR jsonb_typeof(v_el -> 'bateria_pct') IS DISTINCT FROM 'number' OR (v_el ->> 'bateria_pct') !~ '^[0-9]{1,3}$'
         OR jsonb_typeof(v_el -> 'valor_usd') IS DISTINCT FROM 'number' OR (v_el ->> 'valor_usd') !~ '^[0-9]{1,6}$' THEN
        RAISE EXCEPTION 'CUERPO_INVALIDO';
      END IF;
      v_canje := v_canje || jsonb_build_object('modelo', btrim(v_el ->> 'modelo'), 'storage', btrim(v_el ->> 'storage'),
                   'estado', v_el ->> 'estado', 'bateria_pct', (v_el ->> 'bateria_pct')::int, 'valor_usd', (v_el ->> 'valor_usd')::int);
    END LOOP;
  END IF;

  -- La clave de idempotencia se guarda como HASH, nunca en texto: así, aunque el bot mande una que contenga un teléfono, el teléfono no
  -- sobrevive en la base cuando se borra el contacto a los 180 días.
  v_idem := encode(extensions.digest(p_idem, 'sha256'), 'hex');

  -- La huella del pedido NORMALIZADO (sin precios derivados): sirve para saber si un reintento es el mismo pedido.
  v_hash := encode(extensions.digest(jsonb_build_object('u', p_unidad, 'c', v_cant, 'k', v_canje, 'n', v_cliente, 't', v_tel, 'a', p_canal)::text, 'sha256'), 'hex');

  -- ── Idempotencia: PRIMERO, antes de mirar stock, precios o topes ──────────
  SELECT * INTO ex FROM public.presupuestos WHERE idempotencia = v_idem;
  IF FOUND THEN
    IF ex.payload_hash IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'IDEMPOTENCIA_CONFLICTO'; END IF;
    IF ex.vence_en IS NOT NULL AND ex.vence_en <= now() THEN RAISE EXCEPTION 'IDEMPOTENCIA_VENCIDA'; END IF;
    RETURN jsonb_build_object('ok', true, 'token', ex.token, 'vence_en', ex.vence_en, 'reutilizado', true);
  END IF;

  -- ── A partir de acá se serializa: contar + insertar sin carreras ───────────
  PERFORM pg_advisory_xact_lock(7770002);
  v_ahora := clock_timestamp();                                               -- la hora se toma DESPUÉS de esperar el candado
  v_hoy := (v_ahora AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
  SELECT * INTO ex FROM public.presupuestos WHERE idempotencia = v_idem;       -- otro pedido igual pudo terminar mientras esperábamos
  IF FOUND THEN
    IF ex.payload_hash IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'IDEMPOTENCIA_CONFLICTO'; END IF;
    IF ex.vence_en IS NOT NULL AND ex.vence_en <= now() THEN RAISE EXCEPTION 'IDEMPOTENCIA_VENCIDA'; END IF;
    RETURN jsonb_build_object('ok', true, 'token', ex.token, 'vence_en', ex.vence_en, 'reutilizado', true);
  END IF;

  -- Teléfonos vencidos, por lotes (el plazo se cumple aunque nadie abra el CRM). SKIP LOCKED y en orden: dos limpiezas a la vez nunca se
  -- esperan entre sí (con un UPDATE común, dos pasadas que toman las mismas filas en distinto orden terminaban en deadlock: lo detectó el banco de concurrencia).
  UPDATE public.presupuestos SET contacto = NULL, contacto_borrar_en = NULL
   WHERE id IN (SELECT id FROM public.presupuestos WHERE contacto IS NOT NULL AND contacto_borrar_en < v_ahora ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED);

  -- ── La unidad ─────────────────────────────────────────────────────────────
  SELECT * INTO u FROM public.stock WHERE id = p_unidad;
  IF NOT FOUND
     OR u.estado_inventario IS DISTINCT FROM 'disponible'
     OR COALESCE(u.categoria, '') NOT IN ('iphone', 'android', 'mac', 'ipad')               -- igual que el CRM: la categoría exacta
     OR COALESCE(u.a_pedido, FALSE)
     OR COALESCE(u.precio_ars, 0) <= 0 OR COALESCE(u.cotizacion, 0) <= 0
     OR GREATEST(COALESCE(array_length(u.imeis, 1), 0), COALESCE(u.cantidad, 0)) < v_cant THEN
    RAISE EXCEPTION 'UNIDAD_NO_DISPONIBLE';
  END IF;
  v_unit := ROUND(u.precio_ars::numeric / u.cotizacion::numeric)::int;
  IF v_unit < 1 THEN RAISE EXCEPTION 'UNIDAD_NO_DISPONIBLE'; END IF;

  -- ── Dólar y financiación: las MISMAS fuentes que usa el CRM al guardar ─────
  SELECT CASE WHEN valor ~ '^[0-9]+(\.[0-9]+)?$' THEN valor::numeric END INTO v_cot FROM public.configuracion WHERE clave = 'ref_blue';
  IF v_cot IS NULL OR v_cot <= 0 THEN RAISE EXCEPTION 'SIN_COTIZACION'; END IF;
  SELECT valor INTO v_pagos_txt FROM public.configuracion WHERE clave = 'pagos_config';
  BEGIN
    v_pagos := v_pagos_txt::jsonb;
  EXCEPTION WHEN others THEN v_pagos := NULL;
  END;
  IF v_pagos IS NULL OR public.presupuesto_bot__financiacion_ok(v_pagos) IS NOT TRUE THEN RAISE EXCEPTION 'SIN_FINANCIACION_VALIDA'; END IF;

  -- ── El canje ──────────────────────────────────────────────────────────────
  FOR v_el IN SELECT * FROM jsonb_array_elements(v_canje) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.catalogo_modelos_publico WHERE modelo = v_el ->> 'modelo') THEN RAISE EXCEPTION 'CANJE_MODELO_INEXISTENTE'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.catalogo_modelos_publico WHERE modelo = v_el ->> 'modelo' AND (v_el ->> 'storage') = ANY (capacidades)) THEN RAISE EXCEPTION 'CANJE_CAPACIDAD_INEXISTENTE'; END IF;
    IF (v_el ->> 'estado') NOT IN ('Nuevo / Sellado', 'Excelente', 'Muy bueno', 'Bueno', 'Con detalles') THEN RAISE EXCEPTION 'CANJE_ESTADO_INVALIDO'; END IF;
    IF (v_el ->> 'bateria_pct')::int NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'CANJE_BATERIA_INVALIDA'; END IF;
    IF (v_el ->> 'valor_usd')::int < 1 THEN RAISE EXCEPTION 'CANJE_VALOR_INVALIDO'; END IF;
    SELECT precio_usd INTO v_ref FROM public.canje_ultimo_precio_publico WHERE modelo = v_el ->> 'modelo' AND storage = v_el ->> 'storage';
    IF v_ref IS NULL THEN RAISE EXCEPTION 'CANJE_SIN_REFERENCIA'; END IF;
    v_tope := floor(v_ref * public.presupuesto_bot__cfg('canje_tope_pct', 100) / 100);
    IF (v_el ->> 'valor_usd')::int > v_tope THEN RAISE EXCEPTION 'CANJE_SOBRE_EL_TOPE'; END IF;
    v_total_ti := v_total_ti + (v_el ->> 'valor_usd')::int;
    v_equipos := v_equipos || jsonb_build_object('modelo', v_el ->> 'modelo', 'storage', v_el ->> 'storage', 'color', '',
                   'estado', v_el ->> 'estado', 'bateria_pct', (v_el ->> 'bateria_pct')::int, 'valor_usd', (v_el ->> 'valor_usd')::int);
  END LOOP;
  IF jsonb_array_length(v_canje) > 0 AND (v_total_ti IS NULL OR v_total_ti >= v_unit * v_cant) THEN RAISE EXCEPTION 'CANJE_MAYOR_AL_PRECIO'; END IF;

  -- ── Topes (el conteo del minuto y el alta están serializados por el candado) ───
  SELECT count(*) INTO v_n FROM public.presupuestos WHERE origen = 'bot' AND creado_en > v_ahora - interval '1 minute';
  IF v_n >= public.presupuesto_bot__cfg('tope_por_minuto', 5) THEN RAISE EXCEPTION 'DEMASIADOS_PEDIDOS'; END IF;

  -- ── Se arma el presupuesto con el MISMO formato que guarda el CRM ──────────
  v_token := replace(gen_random_uuid()::text, '-', '');
  v_vence := v_ahora + make_interval(days => public.presupuesto_bot__cfg('dias_validez', 2)::int);
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

  -- Contador diario y alta en el MISMO sub-bloque: si el alta falla, el cupo no se gasta.
  BEGIN
    v_tope_dia := public.presupuesto_bot__cfg('tope_diario', 40);
    -- El tope se aplica TAMBIÉN al primer presupuesto del día (con tope 0 no se crea ninguno).
    INSERT INTO public.presupuesto_bot_uso AS uso (dia, n) SELECT v_hoy, 1 WHERE v_tope_dia >= 1
      ON CONFLICT (dia) DO UPDATE SET n = uso.n + 1 WHERE uso.n < v_tope_dia
      RETURNING n INTO v_n;
    IF v_n IS NULL THEN RAISE EXCEPTION 'TOPE_DIARIO'; END IF;

    INSERT INTO public.presupuestos (token, creado_en, vence_en, cliente, producto, trade_in, cotizacion, pagos_cfg, notas,
                                     origen, canal, contacto, contacto_borrar_en, idempotencia, payload_hash)
    VALUES (v_token, v_ahora, v_vence, v_cliente, v_producto, v_trade, v_cot, v_pagos, NULL,
            'bot', p_canal, v_tel, CASE WHEN v_tel IS NOT NULL THEN v_ahora + make_interval(days => v_ret_dias::int) END, v_idem, v_hash);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constr = CONSTRAINT_NAME;
    IF v_constr IS DISTINCT FROM 'presupuestos_idempotencia_unica' THEN RAISE; END IF;      -- cualquier otro choque (el token es aleatorio) NO se disfraza
    -- La clave de idempotencia: el pedido igual ya está. Se devuelve ese.
    SELECT * INTO ex FROM public.presupuestos WHERE idempotencia = v_idem;
    IF NOT FOUND THEN RAISE EXCEPTION 'ERROR_INTERNO'; END IF;
    IF ex.payload_hash IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'IDEMPOTENCIA_CONFLICTO'; END IF;
    RETURN jsonb_build_object('ok', true, 'token', ex.token, 'vence_en', ex.vence_en, 'reutilizado', true);
  END;

  RETURN jsonb_build_object('ok', true, 'token', v_token, 'vence_en', v_vence, 'reutilizado', false);
END; $$;

-- ── 5 · Limpieza de teléfonos vencidos ──────────────────────────────────────
-- Para el CRM: al abrir la lista de presupuestos. Exige usuario autorizado.
CREATE OR REPLACE FUNCTION public.presupuestos_limpiar_contactos()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_n integer;
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  UPDATE public.presupuestos SET contacto = NULL, contacto_borrar_en = NULL
   WHERE id IN (SELECT id FROM public.presupuestos WHERE contacto IS NOT NULL AND contacto_borrar_en < now() ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END; $$;

-- Para el cron diario (con el secreto del servidor).
CREATE OR REPLACE FUNCTION public.presupuestos_limpiar_contactos_cron(p_secreto text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_n integer;
BEGIN
  IF public.presupuesto_bot_secreto_ok(p_secreto) IS NOT TRUE THEN RAISE EXCEPTION 'no autorizado'; END IF;
  UPDATE public.presupuestos SET contacto = NULL, contacto_borrar_en = NULL
   WHERE id IN (SELECT id FROM public.presupuestos WHERE contacto IS NOT NULL AND contacto_borrar_en < now() ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END; $$;

-- ── 6 · Permisos ───────────────────────────────────────────────────────────
-- Postgres da EXECUTE a PUBLIC por defecto: se revoca de PUBLIC. Los ayudantes no los ejecuta nadie más que las funciones.
REVOKE ALL ON FUNCTION public.presupuesto_bot_secreto_ok(text)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.presupuesto_bot__cfg(text, numeric)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.presupuesto_bot__financiacion_ok(jsonb)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.presupuesto_bot_crear(text, uuid, integer, jsonb, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.presupuestos_limpiar_contactos()                 FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.presupuestos_limpiar_contactos_cron(text)        FROM PUBLIC;
-- Las dos con secreto las llama el servidor con la clave pública (rol anon): el secreto es lo que las protege.
GRANT EXECUTE ON FUNCTION public.presupuesto_bot_crear(text, uuid, integer, jsonb, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.presupuestos_limpiar_contactos_cron(text)     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.presupuestos_limpiar_contactos()              TO authenticated;

-- Última comprobación, ADENTRO de la transacción: si el link público no está protegido, nada de este script queda aplicado.
DO $$
BEGIN
  IF position('to_jsonb' IN pg_get_functiondef(to_regprocedure('public.presupuesto_por_token(text)'))) > 0
     OR position('presupuesto__publico_producto' IN pg_get_functiondef(to_regprocedure('public.presupuesto_por_token(text)'))) = 0 THEN
    RAISE EXCEPTION 'presupuesto_por_token no está protegida (script 11): se deshace todo.';
  END IF;
END $$;

COMMIT;

-- ============================================================================
--  VERIFICACIÓN (solo lectura; sale como tabla al final). Tiene que verse TODO en ✅.
-- ============================================================================
SELECT id, control, CASE WHEN ok THEN '✅' ELSE '❌' END AS resultado
FROM (
  SELECT '13.1' AS id, 'presupuestos tiene las 6 columnas nuevas' AS control,
         (SELECT count(*) = 6 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'presupuestos'
             AND column_name IN ('origen', 'canal', 'contacto', 'contacto_borrar_en', 'idempotencia', 'payload_hash')) AS ok
  UNION ALL SELECT '13.2', 'Hay un secreto cargado y los topes por defecto',
         (SELECT count(*) = 8 FROM public.presupuesto_bot_config WHERE clave IN
            ('rpc_secret_sha256', 'dias_validez', 'tope_diario', 'tope_por_minuto', 'canje_tope_pct', 'canje_max_equipos', 'cantidad_max', 'contacto_retencion_dias'))
  UNION ALL SELECT '13.3', 'Las tablas internas están cerradas (seguridad por filas y sin permisos para anon/authenticated)',
         (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.presupuesto_bot_config'::regclass, 'public.presupuesto_bot_uso'::regclass))
         AND NOT has_table_privilege('anon', 'public.presupuesto_bot_config', 'SELECT')
         AND NOT has_table_privilege('authenticated', 'public.presupuesto_bot_config', 'SELECT')
         AND NOT has_table_privilege('anon', 'public.presupuesto_bot_uso', 'SELECT')
         AND NOT has_table_privilege('authenticated', 'public.presupuesto_bot_uso', 'SELECT')
  UNION ALL SELECT '13.4', 'Existen las funciones de creación y de limpieza',
         to_regprocedure('public.presupuesto_bot_crear(text,uuid,integer,jsonb,text,text,text,text)') IS NOT NULL
         AND to_regprocedure('public.presupuestos_limpiar_contactos()') IS NOT NULL
         AND to_regprocedure('public.presupuestos_limpiar_contactos_cron(text)') IS NOT NULL
  UNION ALL SELECT '13.5', 'Los ayudantes (secreto, configuración, financiación) no los puede ejecutar el navegador',
         NOT has_function_privilege('anon', 'public.presupuesto_bot_secreto_ok(text)', 'EXECUTE')
         AND NOT has_function_privilege('authenticated', 'public.presupuesto_bot_secreto_ok(text)', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public.presupuesto_bot__cfg(text,numeric)', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public.presupuesto_bot__financiacion_ok(jsonb)', 'EXECUTE')
  UNION ALL SELECT '13.6', 'La limpieza del CRM la ejecuta solo un usuario con sesión (no anon)',
         has_function_privilege('authenticated', 'public.presupuestos_limpiar_contactos()', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public.presupuestos_limpiar_contactos()', 'EXECUTE')
  UNION ALL SELECT '13.7', 'El link público sigue mostrando solo la lista permitida (script 11): ningún dato interno sale',
         position('presupuesto__publico_producto' IN pg_get_functiondef(to_regprocedure('public.presupuesto_por_token(text)'))) > 0
         AND position('contacto' IN pg_get_functiondef(to_regprocedure('public.presupuesto_por_token(text)'))) = 0
  UNION ALL SELECT '13.8', 'Existe el índice que impide repetir una clave de idempotencia',
         to_regclass('public.presupuestos_idempotencia_unica') IS NOT NULL
) t
ORDER BY id;
