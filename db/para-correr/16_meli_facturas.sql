-- ============================================================================
--  meli_facturas.sql  (script 16) — CONTROL de facturas de Mercado Libre (Fase 1)
--
--  QUÉ HACE: registra, por cada orden de Mercado Libre, si ya tiene factura:
--      pendiente  → (por defecto; una orden sin fila es "pendiente")
--      emitida    → con tipo (A/B/C/E/M), punto de venta, número y fecha del comprobante
--      no_corresponde → con un motivo de una LISTA CERRADA
--  El CRM NO emite facturas ni habla con ARCA: solo anota la que emitiste vos.
--
--  REGLAS (innegociables)
--   · Solo hay un emisor (Franco Ezequiel Velas): la tabla no tiene ninguna columna de emisor.
--   · No se guarda NADA del comprador (ni DNI/CUIT, ni nombre, ni dirección). El motivo es un código de una lista
--     cerrada, sin texto libre, justamente para que nadie pegue un dato personal en un historial que no se borra.
--   · No hay importes: lo que se factura es lo de la orden y este script no lo toca.
--   · Un comprobante (tipo + punto de venta + número) corresponde a UNA sola orden. Si una factura cubre varias
--     ventas, las demás se marcan "no corresponde" con el motivo `factura_global_de_otro_periodo`.
--   · Retención fiscal: NO se borra nada, nunca (ni a los 180 días, ni con DELETE, ni con TRUNCATE).
--   · "Reabrir" vuelve la orden a pendiente pero NO anula el comprobante ante ARCA; el número queda en el historial.
--   · Cancelar o revertir la orden NO cambia ni borra su factura.
--
--  CÓMO ESCRIBE EL CRM: solo con meli_factura_marcar(...). Nadie escribe las tablas directamente.
--  Cada fila tiene `version`: la pantalla manda la que vio (`p_version_esperada`); si otra persona cambió la fila
--  mientras tanto, la base responde FACTURA_CAMBIO_RECARGAR y no pisa nada.
--
--  REQUISITOS: script 3 (meli_ordenes) y la función is_authorized_user() del CRM. Idempotente (se puede correr varias
--  veces). No cambia ningún dato existente.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.meli_ordenes') IS NULL OR to_regprocedure('public.is_authorized_user()') IS NULL THEN
    RAISE EXCEPTION 'Falta el script 3 (meli_esquema_base) o la función is_authorized_user(). Correrlos antes que este.';
  END IF;
END $$;

-- Si alguna de las dos tablas ya existe (por una corrida anterior de ESTE script), tiene que tener la estructura
-- esperada: `CREATE TABLE IF NOT EXISTS` no corrige una tabla distinta.
DO $$
BEGIN
  IF to_regclass('public.meli_facturas') IS NOT NULL AND (
       SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'meli_facturas'
          AND column_name IN ('orden_id', 'estado', 'tipo', 'pto_venta', 'numero', 'emitida_el', 'motivo', 'version', 'marcada_por', 'marcada_uid', 'marcada_en')) <> 11 THEN
    RAISE EXCEPTION 'public.meli_facturas ya existe con otra estructura: no se toca. Revisar a mano antes de seguir.';
  END IF;
  IF to_regclass('public.meli_facturas_historial') IS NOT NULL AND (
       SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'meli_facturas_historial'
          AND column_name IN ('id', 'orden_id', 'version', 'estado_anterior', 'estado_nuevo', 'numero_anterior', 'numero_nuevo', 'marcada_por', 'marcada_uid', 'creado_en')) <> 10 THEN
    RAISE EXCEPTION 'public.meli_facturas_historial ya existe con otra estructura: no se toca. Revisar a mano antes de seguir.';
  END IF;
END $$;

BEGIN;

-- ── 1 · La tabla: una fila por orden ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.meli_facturas (
  orden_id    TEXT        PRIMARY KEY REFERENCES public.meli_ordenes (meli_order_id),   -- NO ACTION: una orden con factura no se borra
  estado      TEXT        NOT NULL,
  tipo        TEXT,        -- A | B | C | E | M   (solo emitida)
  pto_venta   INTEGER,     -- 1..99999            (solo emitida)
  numero      INTEGER,     -- 1..99999999         (solo emitida)
  emitida_el  DATE,        -- fecha del comprobante (solo emitida)
  motivo      TEXT,        -- código de la lista cerrada (solo no_corresponde)
  version     BIGINT      NOT NULL DEFAULT 1,
  marcada_por TEXT        NOT NULL,
  marcada_uid TEXT,        -- identidad estable (sub del token); el nombre/email es solo para mostrar
  marcada_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meli_facturas_estado_ck CHECK (estado IN ('pendiente', 'emitida', 'no_corresponde')),
  -- Cada estado exige sus datos y prohíbe los de los otros. Todo con IS [NOT] NULL explícito: un CHECK que da NULL pasa.
  CONSTRAINT meli_facturas_coherente_ck CHECK (
       (estado = 'pendiente'
          AND tipo IS NULL AND pto_venta IS NULL AND numero IS NULL AND emitida_el IS NULL AND motivo IS NULL)
    OR (estado = 'emitida'
          AND tipo IS NOT NULL AND tipo IN ('A', 'B', 'C', 'E', 'M')
          AND pto_venta IS NOT NULL AND pto_venta BETWEEN 1 AND 99999
          AND numero IS NOT NULL AND numero BETWEEN 1 AND 99999999
          AND emitida_el IS NOT NULL AND motivo IS NULL)
    OR (estado = 'no_corresponde'
          AND motivo IS NOT NULL
          AND motivo IN ('no_es_venta_real', 'cancelada_o_devuelta', 'factura_global_de_otro_periodo',
                         'exenta_o_no_gravada', 'otro_ver_nota_interna')
          AND tipo IS NULL AND pto_venta IS NULL AND numero IS NULL AND emitida_el IS NULL)
  )
);

COMMENT ON TABLE public.meli_facturas IS
  'Control de facturas de Mercado Libre (F1). Solo registra; no emite. Una orden sin fila es pendiente. Se escribe solo con meli_factura_marcar. No se borra nunca. Reabrir NO anula el comprobante ante ARCA; cancelar o revertir la orden no toca su factura.';

-- Un comprobante ↔ una orden. Solo cuenta mientras está emitida; si se reabre, el número queda libre (y en el historial).
CREATE UNIQUE INDEX IF NOT EXISTS meli_facturas_comprobante_unico
  ON public.meli_facturas (tipo, pto_venta, numero) WHERE estado = 'emitida';

-- ── 2 · El historial: cada cambio, con lo anterior y lo nuevo (no se modifica ni se borra) ──
CREATE TABLE IF NOT EXISTS public.meli_facturas_historial (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  orden_id         TEXT        NOT NULL,   -- sin FK a propósito: el historial conserva el identificador pase lo que pase
  version          BIGINT      NOT NULL,   -- versión de la fila DESPUÉS del cambio
  estado_anterior  TEXT,                   -- NULL = no había fila
  tipo_anterior    TEXT, pto_venta_anterior INTEGER, numero_anterior INTEGER, emitida_el_anterior DATE, motivo_anterior TEXT,
  estado_nuevo     TEXT        NOT NULL,
  tipo_nuevo       TEXT, pto_venta_nuevo    INTEGER, numero_nuevo    INTEGER, emitida_el_nuevo    DATE, motivo_nuevo    TEXT,
  marcada_por      TEXT        NOT NULL,
  marcada_uid      TEXT,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meli_facturas_historial_orden ON public.meli_facturas_historial (orden_id, id);

COMMENT ON TABLE public.meli_facturas_historial IS
  'Historial append-only de meli_facturas: lo anterior y lo nuevo de cada cambio. Conserva el número cuando se reabre una factura. No se modifica ni se borra.';

-- ── 3 · Triggers: historial y protecciones ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.meli__factura_historial()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.meli_facturas_historial (
      orden_id, version, estado_anterior, tipo_anterior, pto_venta_anterior, numero_anterior, emitida_el_anterior, motivo_anterior,
      estado_nuevo, tipo_nuevo, pto_venta_nuevo, numero_nuevo, emitida_el_nuevo, motivo_nuevo, marcada_por, marcada_uid)
  VALUES (
      NEW.orden_id, NEW.version,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.estado END,    CASE WHEN TG_OP = 'UPDATE' THEN OLD.tipo END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.pto_venta END, CASE WHEN TG_OP = 'UPDATE' THEN OLD.numero END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.emitida_el END, CASE WHEN TG_OP = 'UPDATE' THEN OLD.motivo END,
      NEW.estado, NEW.tipo, NEW.pto_venta, NEW.numero, NEW.emitida_el, NEW.motivo, NEW.marcada_por, NEW.marcada_uid);
  RETURN NULL;
END; $$;

CREATE OR REPLACE FUNCTION public.meli__factura_proteger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_TABLE_NAME = 'meli_facturas_historial' THEN
    RAISE EXCEPTION 'HISTORIAL_INMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.orden_id IS DISTINCT FROM OLD.orden_id THEN RAISE EXCEPTION 'FACTURA_ORDEN_INMUTABLE' USING ERRCODE = '42501'; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'FACTURA_NO_SE_BORRA' USING ERRCODE = '42501';
END; $$;

DROP TRIGGER IF EXISTS meli_facturas_historial_tg ON public.meli_facturas;
CREATE TRIGGER meli_facturas_historial_tg AFTER INSERT ON public.meli_facturas
  FOR EACH ROW EXECUTE FUNCTION public.meli__factura_historial();
-- Al actualizar, solo deja rastro si algo cambió de verdad.
DROP TRIGGER IF EXISTS meli_facturas_historial_upd_tg ON public.meli_facturas;
CREATE TRIGGER meli_facturas_historial_upd_tg AFTER UPDATE ON public.meli_facturas
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION public.meli__factura_historial();

DROP TRIGGER IF EXISTS meli_facturas_proteger_tg ON public.meli_facturas;
CREATE TRIGGER meli_facturas_proteger_tg BEFORE UPDATE OR DELETE ON public.meli_facturas
  FOR EACH ROW EXECUTE FUNCTION public.meli__factura_proteger();
DROP TRIGGER IF EXISTS meli_facturas_truncate_tg ON public.meli_facturas;
CREATE TRIGGER meli_facturas_truncate_tg BEFORE TRUNCATE ON public.meli_facturas
  FOR EACH STATEMENT EXECUTE FUNCTION public.meli__factura_proteger();

DROP TRIGGER IF EXISTS meli_facturas_hist_proteger_tg ON public.meli_facturas_historial;
CREATE TRIGGER meli_facturas_hist_proteger_tg BEFORE UPDATE OR DELETE ON public.meli_facturas_historial
  FOR EACH ROW EXECUTE FUNCTION public.meli__factura_proteger();
DROP TRIGGER IF EXISTS meli_facturas_hist_truncate_tg ON public.meli_facturas_historial;
CREATE TRIGGER meli_facturas_hist_truncate_tg BEFORE TRUNCATE ON public.meli_facturas_historial
  FOR EACH STATEMENT EXECUTE FUNCTION public.meli__factura_proteger();

-- ── 4 · Permisos de las tablas ─────────────────────────────────────────────
-- Supabase da TODO a anon/authenticated sobre lo nuevo: se quita todo y se deja solo lectura para el CRM, filtrada
-- por is_authorized_user(). La escritura es SOLO por la función de abajo (que corre con los permisos del dueño).
ALTER TABLE public.meli_facturas           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meli_facturas_historial ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meli_facturas_leer ON public.meli_facturas;
CREATE POLICY meli_facturas_leer ON public.meli_facturas FOR SELECT TO authenticated USING (public.is_authorized_user());
DROP POLICY IF EXISTS meli_facturas_historial_leer ON public.meli_facturas_historial;
CREATE POLICY meli_facturas_historial_leer ON public.meli_facturas_historial FOR SELECT TO authenticated USING (public.is_authorized_user());

REVOKE ALL ON TABLE public.meli_facturas, public.meli_facturas_historial FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.meli_facturas_historial_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.meli_facturas, public.meli_facturas_historial TO authenticated;
REVOKE ALL ON FUNCTION public.meli__factura_historial() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.meli__factura_proteger()  FROM PUBLIC, anon, authenticated;

-- service_role (la llave de servidor de Supabase) se saltea RLS: esta fase no la necesita, así que tampoco la tiene.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON TABLE public.meli_facturas, public.meli_facturas_historial FROM service_role;
    REVOKE ALL ON SEQUENCE public.meli_facturas_historial_id_seq FROM service_role;
    REVOKE ALL ON FUNCTION public.meli__factura_historial() FROM service_role;
    REVOKE ALL ON FUNCTION public.meli__factura_proteger()  FROM service_role;
  END IF;
END $$;

-- ── 5 · La única forma de escribir ─────────────────────────────────────────
--  p_estado 'pendiente' = "reabrir" (borra el comprobante de la fila; queda en el historial).
--  p_version_esperada: la versión que vio la pantalla (NULL = la pantalla no veía ninguna fila para esa orden).
--  Devuelve {ok, orden_id, estado, version} (+ sin_cambios:true si no había nada que cambiar).
--  Errores: ESTADO_INVALIDO, TIPO_INVALIDO, PUNTO_VENTA_INVALIDO, NUMERO_INVALIDO, FECHA_INVALIDA, MOTIVO_INVALIDO,
--           DATOS_SOBRANTES, ORDEN_INEXISTENTE, FACTURA_YA_REGISTRADA (hay que reabrir antes de cambiarla),
--           FACTURA_CAMBIO_RECARGAR (otra persona cambió la fila), NUMERO_REPETIDO (ese comprobante ya está en otra orden).
DROP FUNCTION IF EXISTS public.meli_factura_marcar(TEXT, TEXT, TEXT, INTEGER, INTEGER, DATE, TEXT, BIGINT);
CREATE FUNCTION public.meli_factura_marcar(
  p_orden            TEXT,
  p_estado           TEXT,
  p_tipo             TEXT    DEFAULT NULL,
  p_pto_venta        INTEGER DEFAULT NULL,
  p_numero           INTEGER DEFAULT NULL,
  p_emitida_el       DATE    DEFAULT NULL,
  p_motivo           TEXT    DEFAULT NULL,
  p_version_esperada BIGINT  DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  f           public.meli_facturas%ROWTYPE;
  v_tipo      TEXT := upper(NULLIF(btrim(COALESCE(p_tipo, '')), ''));
  v_motivo    TEXT := NULLIF(btrim(COALESCE(p_motivo, '')), '');
  v_orden     TEXT := NULLIF(btrim(COALESCE(p_orden, '')), '');
  v_hoy       DATE := (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
  v_actual    TEXT;
  v_usuario   TEXT;
  v_uid       TEXT;
  v_cons      TEXT;
  v_otra      TEXT;
  v_igual     BOOLEAN;
  v_ver       BIGINT;     -- versión vigente (NULL si no hay fila)
BEGIN
  IF public.is_authorized_user() IS NOT TRUE THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501';
  END IF;

  -- Validación (la base repite lo que valida la pantalla). Lo que no corresponde a cada estado tiene que venir vacío.
  IF p_estado IS NULL OR p_estado NOT IN ('pendiente', 'emitida', 'no_corresponde') THEN RAISE EXCEPTION 'ESTADO_INVALIDO'; END IF;
  IF p_estado = 'emitida' THEN
    IF v_tipo IS NULL OR v_tipo NOT IN ('A', 'B', 'C', 'E', 'M') THEN RAISE EXCEPTION 'TIPO_INVALIDO'; END IF;
    IF p_pto_venta IS NULL OR p_pto_venta NOT BETWEEN 1 AND 99999 THEN RAISE EXCEPTION 'PUNTO_VENTA_INVALIDO'; END IF;
    IF p_numero IS NULL OR p_numero NOT BETWEEN 1 AND 99999999 THEN RAISE EXCEPTION 'NUMERO_INVALIDO'; END IF;
    IF p_emitida_el IS NULL OR p_emitida_el > v_hoy THEN RAISE EXCEPTION 'FECHA_INVALIDA'; END IF;
    IF v_motivo IS NOT NULL THEN RAISE EXCEPTION 'DATOS_SOBRANTES'; END IF;
  ELSIF p_estado = 'no_corresponde' THEN
    IF v_motivo IS NULL OR v_motivo NOT IN ('no_es_venta_real', 'cancelada_o_devuelta', 'factura_global_de_otro_periodo',
                                            'exenta_o_no_gravada', 'otro_ver_nota_interna') THEN
      RAISE EXCEPTION 'MOTIVO_INVALIDO';
    END IF;
    IF v_tipo IS NOT NULL OR p_pto_venta IS NOT NULL OR p_numero IS NOT NULL OR p_emitida_el IS NOT NULL THEN RAISE EXCEPTION 'DATOS_SOBRANTES'; END IF;
  ELSE
    IF v_tipo IS NOT NULL OR p_pto_venta IS NOT NULL OR p_numero IS NOT NULL OR p_emitida_el IS NOT NULL OR v_motivo IS NOT NULL THEN
      RAISE EXCEPTION 'DATOS_SOBRANTES';
    END IF;
  END IF;

  -- Orden de bloqueos: la orden (KEY SHARE: no se puede borrar mientras se anota; Procesar, que la toma FOR UPDATE,
  -- espera unos milisegundos y viceversa) → la fila de la factura → el historial. Procesar nunca toca facturas y esto
  -- nunca toma otra orden ni escribe la orden, así que no hay ciclo.
  IF v_orden IS NULL THEN RAISE EXCEPTION 'ORDEN_INEXISTENTE'; END IF;
  PERFORM 1 FROM public.meli_ordenes WHERE meli_order_id = v_orden FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDEN_INEXISTENTE'; END IF;

  -- Quién: SOLO el email verificado del token. `user_metadata` (el nombre) lo puede editar cada usuario y quedaría
  -- guardado para siempre en el historial: ahí podrían terminar datos de un comprador.
  v_usuario := COALESCE(left(NULLIF(btrim(auth.jwt() ->> 'email'), ''), 120), 'Desconocido');
  v_uid := left(NULLIF(btrim(auth.jwt() ->> 'sub'), ''), 64);

  SELECT * INTO f FROM public.meli_facturas WHERE orden_id = v_orden FOR UPDATE;
  v_actual := CASE WHEN FOUND THEN f.estado ELSE 'pendiente' END;
  v_ver    := CASE WHEN FOUND THEN f.version ELSE NULL END;

  -- Repetir exactamente lo ya registrado no cambia nada (ni quién, ni cuándo, ni la versión, ni el historial).
  v_igual := CASE
    WHEN p_estado = 'pendiente' THEN v_actual = 'pendiente'
    ELSE f.orden_id IS NOT NULL AND f.estado = p_estado
         AND f.tipo       IS NOT DISTINCT FROM v_tipo
         AND f.pto_venta  IS NOT DISTINCT FROM p_pto_venta
         AND f.numero     IS NOT DISTINCT FROM p_numero
         AND f.emitida_el IS NOT DISTINCT FROM p_emitida_el
         AND f.motivo     IS NOT DISTINCT FROM v_motivo
  END;
  IF v_igual THEN
    RETURN jsonb_build_object('ok', true, 'sin_cambios', true, 'orden_id', v_orden, 'estado', v_actual,
                              'version', v_ver);
  END IF;

  -- Transiciones: de pendiente a emitida / no_corresponde; de emitida / no_corresponde solo "reabrir" (a pendiente).
  IF p_estado <> 'pendiente' AND v_actual <> 'pendiente' THEN
    RAISE EXCEPTION 'FACTURA_YA_REGISTRADA' USING DETAIL = 'estado actual: ' || v_actual;
  END IF;

  -- La pantalla tiene que haber visto la versión vigente (o ninguna, si no había fila).
  IF p_version_esperada IS DISTINCT FROM v_ver THEN
    RAISE EXCEPTION 'FACTURA_CAMBIO_RECARGAR';
  END IF;

  BEGIN
    IF f.orden_id IS NULL THEN
      INSERT INTO public.meli_facturas (orden_id, estado, tipo, pto_venta, numero, emitida_el, motivo, marcada_por, marcada_uid)
      VALUES (v_orden, p_estado, v_tipo, p_pto_venta, p_numero, p_emitida_el, v_motivo, v_usuario, v_uid)
      ON CONFLICT (orden_id) DO NOTHING
      RETURNING * INTO f;
      IF NOT FOUND THEN RAISE EXCEPTION 'FACTURA_CAMBIO_RECARGAR'; END IF;   -- otra persona la creó justo antes
    ELSE
      UPDATE public.meli_facturas
         SET estado = p_estado, tipo = v_tipo, pto_venta = p_pto_venta, numero = p_numero, emitida_el = p_emitida_el,
             motivo = v_motivo, version = f.version + 1, marcada_por = v_usuario, marcada_uid = v_uid, marcada_en = now()
       WHERE orden_id = v_orden
      RETURNING * INTO f;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_cons = CONSTRAINT_NAME;
    IF v_cons IS DISTINCT FROM 'meli_facturas_comprobante_unico' THEN RAISE; END IF;
    SELECT x.orden_id INTO v_otra FROM public.meli_facturas x
     WHERE x.estado = 'emitida' AND x.tipo = v_tipo AND x.pto_venta = p_pto_venta AND x.numero = p_numero LIMIT 1;
    RAISE EXCEPTION 'NUMERO_REPETIDO' USING DETAIL = 'ya está en la orden ' || COALESCE(v_otra, '?');
  END;

  RETURN jsonb_build_object('ok', true, 'orden_id', v_orden, 'estado', f.estado, 'version', f.version);
END; $$;

-- Cualquier OTRA versión de la función (otra lista de argumentos) se elimina: una versión vieja, sin control de
-- versión, seguiría pudiendo escribir con sus propios permisos.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS firma FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'meli_factura_marcar'
              AND p.oid <> 'public.meli_factura_marcar(text,text,text,integer,integer,date,text,bigint)'::regprocedure LOOP
    EXECUTE 'DROP FUNCTION ' || r.firma;
  END LOOP;
END $$;

REVOKE EXECUTE ON FUNCTION public.meli_factura_marcar(TEXT, TEXT, TEXT, INTEGER, INTEGER, DATE, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.meli_factura_marcar(TEXT, TEXT, TEXT, INTEGER, INTEGER, DATE, TEXT, BIGINT) TO authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE EXECUTE ON FUNCTION public.meli_factura_marcar(TEXT, TEXT, TEXT, INTEGER, INTEGER, DATE, TEXT, BIGINT) FROM service_role;
  END IF;
END $$;

COMMIT;

-- ============================================================================
--  VERIFICACIÓN (solo lectura; sale como tabla al final). Tiene que verse TODO en ✅.
-- ============================================================================
SELECT id, control, CASE WHEN ok THEN '✅' ELSE '❌' END AS resultado
FROM (
  SELECT '16.1' AS id, 'Existen las dos tablas, con la seguridad por filas activada' AS control,
         to_regclass('public.meli_facturas') IS NOT NULL AND to_regclass('public.meli_facturas_historial') IS NOT NULL
         AND (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.meli_facturas'::regclass, 'public.meli_facturas_historial'::regclass)) AS ok
  UNION ALL SELECT '16.2', 'Están las reglas de coherencia y el comprobante único',
         (SELECT count(*) = 2 FROM pg_constraint WHERE conrelid = 'public.meli_facturas'::regclass AND conname IN ('meli_facturas_estado_ck', 'meli_facturas_coherente_ck'))
         AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'meli_facturas_comprobante_unico'
                        AND indexdef ILIKE '%UNIQUE%(tipo, pto_venta, numero)%WHERE%emitida%')
  UNION ALL SELECT '16.3', 'Están las protecciones (no se borra, no se vacía, el historial no se modifica)',
         (SELECT count(*) = 6 FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
            ('meli_facturas_historial_tg', 'meli_facturas_historial_upd_tg', 'meli_facturas_proteger_tg', 'meli_facturas_truncate_tg',
             'meli_facturas_hist_proteger_tg', 'meli_facturas_hist_truncate_tg'))
  UNION ALL SELECT '16.4', 'anon no puede hacer NADA con las tablas (ni leer)',
         NOT (SELECT bool_or(has_table_privilege('anon', t, p))
                FROM unnest(ARRAY['public.meli_facturas', 'public.meli_facturas_historial']) t,
                     unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p)
  UNION ALL SELECT '16.5', 'El CRM (authenticated) solo puede LEER las tablas',
         (SELECT bool_and(has_table_privilege('authenticated', t, 'SELECT'))
            FROM unnest(ARRAY['public.meli_facturas', 'public.meli_facturas_historial']) t)
         AND NOT (SELECT bool_or(has_table_privilege('authenticated', t, p))
                FROM unnest(ARRAY['public.meli_facturas', 'public.meli_facturas_historial']) t,
                     unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p)
         AND NOT has_sequence_privilege('authenticated', 'public.meli_facturas_historial_id_seq', 'USAGE')
  UNION ALL SELECT '16.6', 'service_role (llave de servidor) tampoco tiene acceso a las tablas ni a la función',
         NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
         OR NOT (SELECT bool_or(has_table_privilege('service_role', t, p))
                   FROM unnest(ARRAY['public.meli_facturas', 'public.meli_facturas_historial']) t,
                        unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p)
            AND NOT has_function_privilege('service_role', 'public.meli_factura_marcar(text,text,text,integer,integer,date,text,bigint)', 'EXECUTE')
  UNION ALL SELECT '16.7', 'Solo el CRM (authenticated) puede ejecutar meli_factura_marcar; anon y PUBLIC no',
         has_function_privilege('authenticated', 'public.meli_factura_marcar(text,text,text,integer,integer,date,text,bigint)', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public.meli_factura_marcar(text,text,text,integer,integer,date,text,bigint)', 'EXECUTE')
         AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                          WHERE p.oid = 'public.meli_factura_marcar(text,text,text,integer,integer,date,text,bigint)'::regprocedure
                            AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
  UNION ALL SELECT '16.8', 'Las funciones internas (historial y protecciones) no las puede ejecutar nadie desde afuera',
         NOT has_function_privilege('anon', 'public.meli__factura_historial()', 'EXECUTE')
         AND NOT has_function_privilege('authenticated', 'public.meli__factura_historial()', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public.meli__factura_proteger()', 'EXECUTE')
         AND NOT has_function_privilege('authenticated', 'public.meli__factura_proteger()', 'EXECUTE')
  UNION ALL SELECT '16.9', 'Ninguna factura emitida está sin número, ni dos órdenes comparten el mismo comprobante',
         NOT EXISTS (SELECT 1 FROM public.meli_facturas WHERE estado = 'emitida' AND (tipo IS NULL OR pto_venta IS NULL OR numero IS NULL OR emitida_el IS NULL))
         AND NOT EXISTS (SELECT 1 FROM public.meli_facturas WHERE estado = 'emitida' GROUP BY tipo, pto_venta, numero HAVING count(*) > 1)
  UNION ALL SELECT '16.10', 'No hay políticas de seguridad ajenas en las tablas (solo las dos de lectura)',
         NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('meli_facturas', 'meli_facturas_historial')
                        AND policyname NOT IN ('meli_facturas_leer', 'meli_facturas_historial_leer'))
  UNION ALL SELECT '16.11', 'Hay UNA sola versión de meli_factura_marcar (la que controla la versión)',
         (SELECT count(*) = 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'meli_factura_marcar')
) t
ORDER BY id;
