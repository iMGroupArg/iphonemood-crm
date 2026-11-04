-- ============================================================================
--  agentes.sql  (script 24) — MESA DE CONTROL DE LA RED DE AGENTES
--
--  QUÉ HACE
--   · Cuatro tablas nuevas, de solo lectura para el CRM (escritura SOLO por funciones):
--       agente_propuestas  lo que un agente propone (post, story, campaña, ajuste de pauta, tarea) o informa
--                          (informe, cierre, PR, nota de blog, alerta). Las propuestas esperan el OK de Franco.
--       agente_bitacora    qué hizo cada corrida de cada agente.
--       agente_directivas  las prioridades de la semana que escribe el CEO y leen los demás.
--       pauta_config       el tope mensual de pauta (fila única) y el último gasto que reportó el agente de Pauta.
--   · Dos roles sin login (Franco les pone contraseña aparte, NUNCA en el repo):
--       agentes_revisor  el de Codex: solo lee y deja su veredicto (revision_codex). Nada más.
--   · Rol `agentes_ro`:
--       - LEE el negocio solo a través de las vistas del esquema `agentes` (lista cerrada, sin secretos: no ve
--         cuentas de Mercado Libre, ARCA, usuarios, presupuestos con su token ni la tabla configuracion entera).
--       - ESCRIBE solo con las funciones agentes.* (proponer, registrar, directiva, revisión de Codex, reporte de
--         pauta, borrador de blog). No puede tocar cajas, ventas, stock ni gastos.
--       - NO PUEDE APROBAR NADA: aprobar y rechazar exigen un usuario logueado y autorizado del CRM, y un trigger
--         vuelve a exigirlo en la tabla. Importa porque el agente del bot lee mensajes de clientes (texto ajeno).
--   · Tope de pauta en la base: un aumento pedido como automático queda 'auto' solo si (a) el gasto proyectado lo
--     midió el EJECUTOR con datos de Meta (el que reporta el propio agente es informativo y no habilita nada),
--     (b) gasto proyectado + reservas vivas del mes + este ajuste entra en el tope, y (c) es para este mes. Si no,
--     queda 'pendiente' (decide Franco). Bajar presupuesto puede ser automático. Una objeción de Codex o un cambio de
--     tope devuelven los aumentos automáticos a 'pendiente'. Hasta la Fase 2 (ejecutor) NINGÚN aumento es automático.
--   · Cierra un agujero heredado: en Supabase toda función nueva nace ejecutable por PUBLIC, y una conexión SQL directa
--     puede inventarse el JWT (request.jwt.claims) y pasar is_authorized_user(). Este script le saca a PUBLIC la
--     ejecución de las funciones de `public` y se la devuelve a cada rol que ya la tenía, MENOS a los dos roles de
--     agentes. Volver a correr este script después de cualquier migración que cree funciones nuevas.
--
--  REQUISITOS: is_authorized_user() y usuarios_autorizados (RLS base). blog_posts es opcional (sin ella, el
--  borrador de blog avisa). Idempotente: se puede correr de nuevo. No cambia ningún dato existente.
-- ============================================================================

DO $$
BEGIN
  IF to_regprocedure('public.is_authorized_user()') IS NULL OR to_regclass('public.usuarios_autorizados') IS NULL THEN
    RAISE EXCEPTION 'Falta la seguridad base (is_authorized_user / usuarios_autorizados). Correr las migraciones de RLS antes que este.';
  END IF;
END $$;

BEGIN;

-- ── 0 · Rol de los agentes ──────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentes_ro') THEN
    CREATE ROLE agentes_ro NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentes_revisor') THEN
    CREATE ROLE agentes_revisor NOLOGIN;
  END IF;
END $$;
ALTER ROLE agentes_ro SET statement_timeout = '30s';
ALTER ROLE agentes_ro SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE agentes_revisor SET statement_timeout = '30s';
ALTER ROLE agentes_revisor SET idle_in_transaction_session_timeout = '60s';

-- ── 1 · Tablas ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agente_propuestas (
  id               BIGSERIAL PRIMARY KEY,
  agente           TEXT        NOT NULL,
  tipo             TEXT        NOT NULL,
  titulo           TEXT        NOT NULL,
  resumen          TEXT,
  payload          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  estado           TEXT        NOT NULL,
  programada_para  TIMESTAMPTZ,
  monto_extra_ars  NUMERIC(14,2),            -- ajuste de pauta: gasto EXTRA proyectado hasta fin de mes (lo calcula la base)
  clave_unica      TEXT,
  revision         INTEGER     NOT NULL DEFAULT 1,
  revision_codex   TEXT        NOT NULL DEFAULT 'no_aplica',
  codex_texto      TEXT,
  creada_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  decidida_por     TEXT,
  decidida_en      TIMESTAMPTZ,
  motivo           TEXT,
  leida_en         TIMESTAMPTZ,
  resultado        JSONB,
  ejecutada_en     TIMESTAMPTZ,
  reserva_mes      DATE,                     -- ajuste de pauta: mes (1er día, hora AR) al que pertenece la reserva
  auto_vence_en    TIMESTAMPTZ,              -- un 'auto' vale solo hasta fin de ese mes; el ejecutor no lo usa después
  CONSTRAINT agente_prop_agente_ck  CHECK (agente IN ('ceo', 'bot', 'landing', 'contenido', 'pauta', 'finanzas')),
  CONSTRAINT agente_prop_tipo_ck    CHECK (tipo IN ('post', 'story', 'campana', 'ajuste_presupuesto', 'tarea',
                                                    'informe', 'cierre', 'pr', 'blog', 'alerta')),
  CONSTRAINT agente_prop_estado_ck  CHECK (estado IN ('pendiente', 'aprobada', 'rechazada', 'auto', 'ejecutada', 'error', 'informativa')),
  CONSTRAINT agente_prop_info_ck    CHECK ((tipo IN ('informe', 'cierre', 'pr', 'blog', 'alerta')) = (estado = 'informativa')),
  CONSTRAINT agente_prop_auto_ck    CHECK (estado <> 'auto' OR tipo = 'ajuste_presupuesto'),
  CONSTRAINT agente_prop_decid_ck   CHECK (estado NOT IN ('aprobada', 'rechazada') OR (decidida_por IS NOT NULL AND decidida_en IS NOT NULL)),
  CONSTRAINT agente_prop_codex_ck   CHECK (revision_codex IN ('pendiente', 'aprobado', 'objeciones', 'no_aplica')),
  CONSTRAINT agente_prop_titulo_ck  CHECK (length(btrim(titulo)) BETWEEN 1 AND 200),
  CONSTRAINT agente_prop_resumen_ck CHECK (resumen IS NULL OR length(resumen) <= 4000),
  CONSTRAINT agente_prop_codext_ck  CHECK (codex_texto IS NULL OR length(codex_texto) <= 8000),
  CONSTRAINT agente_prop_motivo_ck  CHECK (motivo IS NULL OR length(motivo) <= 500),
  CONSTRAINT agente_prop_payload_ck CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 100000),
  CONSTRAINT agente_prop_clave_uq   UNIQUE (clave_unica)
);
ALTER TABLE public.agente_propuestas ADD COLUMN IF NOT EXISTS reserva_mes DATE;
ALTER TABLE public.agente_propuestas ADD COLUMN IF NOT EXISTS auto_vence_en TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS agente_prop_estado_ix ON public.agente_propuestas (estado, creada_en DESC);

CREATE TABLE IF NOT EXISTS public.agente_bitacora (
  id         BIGSERIAL PRIMARY KEY,
  agente     TEXT        NOT NULL,
  corrida    TEXT,
  nivel      TEXT        NOT NULL DEFAULT 'info',
  mensaje    TEXT        NOT NULL,
  datos      JSONB,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agente_bit_agente_ck  CHECK (agente IN ('ceo', 'bot', 'landing', 'contenido', 'pauta', 'finanzas')),
  CONSTRAINT agente_bit_nivel_ck   CHECK (nivel IN ('info', 'hallazgo', 'error')),
  CONSTRAINT agente_bit_mensaje_ck CHECK (length(btrim(mensaje)) BETWEEN 1 AND 2000),
  CONSTRAINT agente_bit_corrida_ck CHECK (corrida IS NULL OR length(corrida) <= 100),
  CONSTRAINT agente_bit_datos_ck   CHECK (datos IS NULL OR pg_column_size(datos) <= 50000)
);
CREATE INDEX IF NOT EXISTS agente_bit_creado_ix ON public.agente_bitacora (creado_en DESC);

CREATE TABLE IF NOT EXISTS public.agente_directivas (
  semana          DATE PRIMARY KEY,             -- siempre un lunes
  texto           TEXT        NOT NULL,
  prioridades     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  creada_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizada_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agente_dir_lunes_ck CHECK (extract(isodow FROM semana) = 1),
  CONSTRAINT agente_dir_texto_ck CHECK (length(btrim(texto)) BETWEEN 1 AND 6000),
  CONSTRAINT agente_dir_prio_ck  CHECK (jsonb_typeof(prioridades) = 'array' AND pg_column_size(prioridades) <= 20000)
);

CREATE TABLE IF NOT EXISTS public.pauta_config (
  id                     SMALLINT PRIMARY KEY DEFAULT 1,
  tope_mensual_ars       NUMERIC(14,2) NOT NULL DEFAULT 0,   -- 0 = sin ajustes automáticos
  gasto_al_dia_ars       NUMERIC(14,2),
  gasto_proyectado_ars   NUMERIC(14,2),                      -- gasto del mes + presupuestos diarios activos × días que quedan
  reporte_en             TIMESTAMPTZ,
  reporte_mes            DATE,                               -- primer día del mes del reporte (hora de Argentina)
  reporte_fuente         TEXT,                               -- 'agente' (informativo) | 'ejecutor' (medido en Meta, habilita automáticos)
  tope_actualizado_por   TEXT,
  tope_actualizado_en    TIMESTAMPTZ,
  CONSTRAINT pauta_config_unica_ck CHECK (id = 1),
  CONSTRAINT pauta_config_tope_ck  CHECK (tope_mensual_ars >= 0 AND tope_mensual_ars <= 10000000000),
  CONSTRAINT pauta_config_gasto_ck CHECK ((gasto_al_dia_ars IS NULL OR gasto_al_dia_ars >= 0)
                                          AND (gasto_proyectado_ars IS NULL OR gasto_proyectado_ars >= 0))
);
ALTER TABLE public.pauta_config ADD COLUMN IF NOT EXISTS reporte_fuente TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pauta_config_fuente_ck') THEN
    ALTER TABLE public.pauta_config ADD CONSTRAINT pauta_config_fuente_ck CHECK (reporte_fuente IS NULL OR reporte_fuente IN ('agente', 'ejecutor'));
  END IF;
END $$;
INSERT INTO public.pauta_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Lectura: solo usuarios autorizados del CRM. Escritura directa: nadie (todo por funciones).
ALTER TABLE public.agente_propuestas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agente_bitacora   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agente_directivas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pauta_config      ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agente_propuestas_lectura ON public.agente_propuestas;
DROP POLICY IF EXISTS agente_bitacora_lectura   ON public.agente_bitacora;
DROP POLICY IF EXISTS agente_directivas_lectura ON public.agente_directivas;
DROP POLICY IF EXISTS pauta_config_lectura      ON public.pauta_config;
CREATE POLICY agente_propuestas_lectura ON public.agente_propuestas FOR SELECT TO authenticated USING (public.is_authorized_user());
CREATE POLICY agente_bitacora_lectura   ON public.agente_bitacora   FOR SELECT TO authenticated USING (public.is_authorized_user());
CREATE POLICY agente_directivas_lectura ON public.agente_directivas FOR SELECT TO authenticated USING (public.is_authorized_user());
CREATE POLICY pauta_config_lectura      ON public.pauta_config      FOR SELECT TO authenticated USING (public.is_authorized_user());
REVOKE ALL ON public.agente_propuestas, public.agente_bitacora, public.agente_directivas, public.pauta_config FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.agente_propuestas, public.agente_bitacora, public.agente_directivas, public.pauta_config TO authenticated;
REVOKE ALL ON SEQUENCE public.agente_propuestas_id_seq, public.agente_bitacora_id_seq FROM PUBLIC, anon, authenticated;

-- ── 2 · Revisión y guardia de decisión ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.agente__guardia() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- Una propuesta nunca NACE decidida (ni por una escritura privilegiada).
  IF TG_OP = 'INSERT' THEN
    IF NEW.estado IN ('aprobada', 'rechazada', 'ejecutada', 'error') OR NEW.decidida_por IS NOT NULL THEN
      RAISE EXCEPTION 'PROPUESTA_NACE_DECIDIDA' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- Cualquier cambio de algo que Franco mira para decidir sube la revisión: una aprobación vieja no vale para lo nuevo.
  IF NEW.estado IS DISTINCT FROM OLD.estado OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.titulo IS DISTINCT FROM OLD.titulo OR NEW.resumen IS DISTINCT FROM OLD.resumen
     OR NEW.programada_para IS DISTINCT FROM OLD.programada_para OR NEW.monto_extra_ars IS DISTINCT FROM OLD.monto_extra_ars
     OR NEW.revision_codex IS DISTINCT FROM OLD.revision_codex OR NEW.codex_texto IS DISTINCT FROM OLD.codex_texto THEN
    NEW.revision := OLD.revision + 1;
  END IF;
  -- Aprobar o rechazar lo hace SOLO la persona autorizada de ESTA sesión (segunda llave, además de las funciones):
  -- decidida_por tiene que ser el email del JWT de la sesión, activo, y la conexión no puede ser de un agente.
  IF NEW.estado IN ('aprobada', 'rechazada') AND NEW.estado IS DISTINCT FROM OLD.estado THEN
    IF session_user IN ('agentes_ro', 'agentes_revisor')
       OR NEW.decidida_por IS NULL OR NEW.decidida_por IS DISTINCT FROM NULLIF(auth.jwt() ->> 'email', '')
       OR NOT EXISTS (SELECT 1 FROM public.usuarios_autorizados u WHERE u.email = NEW.decidida_por AND u.activo = true) THEN
      RAISE EXCEPTION 'DECISION_SIN_PERSONA_AUTORIZADA' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS agente_guardia ON public.agente_propuestas;
CREATE TRIGGER agente_guardia BEFORE INSERT OR UPDATE ON public.agente_propuestas FOR EACH ROW EXECUTE FUNCTION public.agente__guardia();

-- ── 3 · Ayudas internas ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.agente__hoy_ar() RETURNS DATE
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
$$;

CREATE OR REPLACE FUNCTION public.agente__texto_ok(p TEXT, p_max INTEGER, p_codigo TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE v TEXT := NULLIF(btrim(p), '');
BEGIN
  -- Se permiten saltos de línea y tabulaciones (los textos de Instagram los usan); el resto de controles, no.
  IF v IS NOT NULL AND (length(v) > p_max OR v ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]') THEN
    RAISE EXCEPTION '%', p_codigo;
  END IF;
  RETURN v;
END $$;

-- Nombre de columna que no se le muestra a un agente (por segmentos de snake_case: 'token_seguimiento', 'clave_desbloqueo').
CREATE OR REPLACE FUNCTION public.agente__columna_sensible(p_col TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  -- Además de secretos y datos personales, el texto libre (notas, observaciones, comentarios): ahí la gente anota
  -- de todo, incluida la clave de un equipo.
  SELECT lower(p_col) ~ '(^|_)(token|tokens|clave|claves|password|pass|contrasena|secret|secreto|secreta|pin|desbloqueo|hash|cuit|cuil|dni|documento|doc|telefono|tel|celular|whatsapp|email|mail|correo|direccion|domicilio|imei|imeis|serie|cbu|cvu|patron|firma|certificado|cert|llave|key)(_|$)'
$$;

-- Texto libre que escribe la gente (notas, descripciones, detalles, conceptos): ahí se anota de todo, incluida la clave
-- de un equipo o el teléfono de un cliente. Afuera de las vistas del negocio (en la mesa de los agentes sí queda).
CREATE OR REPLACE FUNCTION public.agente__texto_libre(p_col TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT lower(p_col) ~ '(^|_)(nota|notas|observacion|observaciones|comentario|comentarios|descripcion|descripciones|detalle|detalles|concepto|conceptos|mensaje|mensajes|texto|textos|motivo|razon|raw|crudo|respuesta|respuestas|cuerpo_mail|mail_body)(_|$)'
$$;

-- ── 4 · Esquema `agentes`: lo único que ven los roles de los agentes ────────
CREATE SCHEMA IF NOT EXISTS agentes;
REVOKE ALL ON SCHEMA agentes FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON SCHEMA agentes FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON SCHEMA agentes FROM authenticated'; END IF;
END $$;
GRANT USAGE ON SCHEMA agentes TO agentes_ro, agentes_revisor;

-- Vistas de lectura (lista cerrada de tablas). Las que no existen en esta base se saltean.
-- Las columnas se listan una por una y se DEJAN AFUERA las que por su nombre son secretos o datos personales
-- (tokens, claves, contraseñas, DNI/CUIT, teléfonos, emails, direcciones, IMEI, CBU). La verificación 24.10 lo controla.
-- Afuera A PROPÓSITO: usuarios_autorizados, configuracion entera, meli_cuentas*/meli_config (tokens), arca_* (certificados),
-- presupuestos (el token es lo único que protege cada presupuesto), clientes y turnos (datos personales), seguimiento_comentarios.
DO $$
DECLARE t TEXT; cols TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ventas', 'venta_items', 'venta_pagos', 'venta_notas', 'cambios', 'garantias',
    'gastos', 'categorias_gasto', 'gastos_fijos_plantilla', 'comprobantes',
    'cajas', 'caja_ledger', 'caja_movimientos', 'personas', 'cierres_mensuales',
    'deudas_manuales', 'deuda_pagos', 'adelantos_socios', 'inversores', 'inversor_pagos', 'activos_fijos',
    'stock', 'stock_movimientos', 'stock_publico', 'lotes_compra', 'lote_items', 'lote_pagos', 'proveedores', 'proveedor_creditos',
    'reparaciones', 'reparacion_pagos', 'meli_ordenes', 'meli_orden_items', 'actividades',
    'blog_posts', 'bandeja_asignaciones',
    'agente_propuestas', 'agente_bitacora', 'agente_directivas', 'pauta_config'
  ] LOOP
    EXECUTE format('DROP VIEW IF EXISTS agentes.%I', t);
    IF to_regclass('public.' || t) IS NOT NULL THEN
      SELECT string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum) INTO cols
        FROM pg_attribute a
       WHERE a.attrelid = to_regclass('public.' || t) AND a.attnum > 0 AND NOT a.attisdropped
         AND NOT public.agente__columna_sensible(a.attname)
         AND (t LIKE 'agente\_%' OR t IN ('pauta_config', 'blog_posts') OR NOT public.agente__texto_libre(a.attname))
         -- JSON de negocio (respuestas de Mercado Libre, datos de movimientos): puede traer de todo. Afuera, salvo la mesa.
         AND (t LIKE 'agente\_%' OR t = 'pauta_config' OR a.atttypid NOT IN ('json'::regtype, 'jsonb'::regtype));
      IF cols IS NOT NULL THEN
        EXECUTE format('CREATE VIEW agentes.%I AS SELECT %s FROM public.%I', t, cols, t);
      END IF;
    END IF;
  END LOOP;
  -- De configuracion, solo las cotizaciones de referencia y los planes de pago (lo que necesitan Finanzas y Contenido).
  DROP VIEW IF EXISTS agentes.cotizaciones;
  IF to_regclass('public.configuracion') IS NOT NULL THEN
    CREATE VIEW agentes.cotizaciones AS
      SELECT clave AS nombre, valor FROM public.configuracion WHERE clave IN ('ref_blue', 'ref_usdt', 'pagos_config');
  END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA agentes FROM PUBLIC;
GRANT SELECT ON ALL TABLES IN SCHEMA agentes TO agentes_ro, agentes_revisor;

-- ── 5 · Funciones de los agentes (las ejecuta SOLO agentes_ro) ──────────────
DROP FUNCTION IF EXISTS agentes.proponer(TEXT, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ, TEXT, BOOLEAN, BOOLEAN);
CREATE FUNCTION agentes.proponer(
  p_agente TEXT, p_tipo TEXT, p_titulo TEXT, p_resumen TEXT, p_payload JSONB,
  p_programada_para TIMESTAMPTZ DEFAULT NULL, p_clave TEXT DEFAULT NULL,
  p_auto BOOLEAN DEFAULT false, p_pedir_codex BOOLEAN DEFAULT false
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_titulo  TEXT := public.agente__texto_ok(p_titulo, 200, 'TITULO_INVALIDO');
  v_resumen TEXT := public.agente__texto_ok(p_resumen, 4000, 'RESUMEN_INVALIDO');
  v_clave   TEXT := NULLIF(btrim(p_clave), '');
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_info    BOOLEAN := p_tipo IN ('informe', 'cierre', 'pr', 'blog', 'alerta');
  v_estado  TEXT;
  v_extra   NUMERIC(14,2);
  v_inc     NUMERIC;
  v_dias    INTEGER;
  v_cfg     public.pauta_config%ROWTYPE;
  v_comp    NUMERIC;
  v_auto_no TEXT;
  v_hoy     DATE := public.agente__hoy_ar();
  v_mes     DATE := date_trunc('month', public.agente__hoy_ar())::date;
  v_vence   TIMESTAMPTZ := ((date_trunc('month', public.agente__hoy_ar()) + interval '1 month')::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires');
  v_permit  TEXT[];
  v_extra_k TEXT;
  v_id      BIGINT;
BEGIN
  IF p_agente IS NULL OR p_agente NOT IN ('ceo', 'bot', 'landing', 'contenido', 'pauta', 'finanzas') THEN RAISE EXCEPTION 'AGENTE_INVALIDO'; END IF;
  IF p_tipo IS NULL OR p_tipo NOT IN ('post', 'story', 'campana', 'ajuste_presupuesto', 'tarea', 'informe', 'cierre', 'pr', 'blog', 'alerta') THEN
    RAISE EXCEPTION 'TIPO_INVALIDO';
  END IF;
  IF v_titulo IS NULL THEN RAISE EXCEPTION 'TITULO_INVALIDO'; END IF;
  IF jsonb_typeof(v_payload) <> 'object' THEN RAISE EXCEPTION 'PAYLOAD_INVALIDO'; END IF;
  IF v_clave IS NOT NULL AND (length(v_clave) > 200 OR v_clave ~ '[[:cntrl:]]') THEN RAISE EXCEPTION 'CLAVE_INVALIDA'; END IF;
  IF p_auto AND p_tipo <> 'ajuste_presupuesto' THEN RAISE EXCEPTION 'AUTO_NO_PERMITIDO'; END IF;
  -- Lo que se puede EJECUTAR tiene campos cerrados: Franco ve en pantalla todos y cada uno, y nada más viaja oculto.
  v_permit := CASE p_tipo
    WHEN 'post'  THEN ARRAY['texto', 'imagen_url', 'productos', 'formato', 'hashtags', 'notas']
    WHEN 'story' THEN ARRAY['texto', 'imagen_url', 'productos', 'formato', 'hashtags', 'notas']
    WHEN 'campana' THEN ARRAY['campana_nombre', 'objetivo', 'publico', 'presupuesto_diario_ars', 'fecha_inicio', 'fecha_fin',
                              'productos', 'texto', 'imagen_url', 'notas']
    WHEN 'ajuste_presupuesto' THEN ARRAY['campana_id', 'campana_nombre', 'incremento_diario_ars', 'motivo']
    WHEN 'tarea' THEN ARRAY['detalle', 'lista', 'url']
    ELSE NULL END;
  IF v_permit IS NOT NULL THEN
    SELECT k INTO v_extra_k FROM jsonb_object_keys(v_payload) k WHERE k <> ALL (v_permit) LIMIT 1;
    IF v_extra_k IS NOT NULL THEN RAISE EXCEPTION 'PAYLOAD_CAMPO_DESCONOCIDO: %', left(v_extra_k, 60); END IF;
    IF p_programada_para IS NOT NULL AND (p_programada_para < now() - interval '1 day' OR p_programada_para > now() + interval '120 days') THEN
      RAISE EXCEPTION 'FECHA_INVALIDA';
    END IF;
  END IF;

  -- Idempotencia: la misma clave devuelve la propuesta que ya existe (una corrida repetida no duplica).
  IF v_clave IS NOT NULL THEN
    SELECT id INTO v_id FROM public.agente_propuestas WHERE clave_unica = v_clave;
    IF FOUND THEN RETURN jsonb_build_object('ok', true, 'id', v_id, 'existente', true); END IF;
  END IF;

  v_estado := CASE WHEN v_info THEN 'informativa' ELSE 'pendiente' END;

  IF p_tipo = 'ajuste_presupuesto' THEN
    BEGIN
      v_inc := (v_payload ->> 'incremento_diario_ars')::numeric;
    EXCEPTION WHEN others THEN RAISE EXCEPTION 'INCREMENTO_INVALIDO';
    END;
    IF v_inc IS NULL OR v_inc = 'NaN'::numeric OR abs(v_inc) > 100000000 THEN RAISE EXCEPTION 'INCREMENTO_INVALIDO'; END IF;
    -- Se normaliza a centavos ANTES de calcular y se guarda así: partir un ajuste en fracciones no esconde nada.
    v_inc := round(v_inc, 2);
    IF v_inc = 0 THEN RAISE EXCEPTION 'INCREMENTO_INVALIDO'; END IF;
    v_payload := v_payload || jsonb_build_object('incremento_diario_ars', v_inc);
    -- Días que quedan del mes contando hoy (hora de Argentina): lo que este ajuste puede llegar a gastar de más.
    v_dias  := ((date_trunc('month', v_hoy) + interval '1 month')::date - v_hoy);
    v_extra := round(greatest(v_inc, 0) * v_dias, 2);

    IF p_auto THEN
      SELECT * INTO v_cfg FROM public.pauta_config WHERE id = 1 FOR UPDATE;   -- serializa los ajustes automáticos
      IF p_programada_para IS NOT NULL AND date_trunc('month', p_programada_para AT TIME ZONE 'America/Argentina/Buenos_Aires')::date <> v_mes THEN
        v_auto_no := 'FUERA_DEL_MES';                                         -- la reserva es de ESTE mes
      ELSIF v_inc < 0 THEN
        v_estado := 'auto';                                                   -- bajar presupuesto nunca pasa el tope
      ELSIF NOT FOUND OR v_cfg.tope_mensual_ars <= 0 THEN
        v_auto_no := 'SIN_TOPE';
      ELSIF v_cfg.reporte_fuente IS DISTINCT FROM 'ejecutor' THEN
        -- El gasto que informa el propio agente no autoriza gastar: hace falta la medición del ejecutor (Fase 2).
        v_auto_no := 'SIN_MEDICION_CONFIABLE';
      ELSIF v_cfg.reporte_en IS NULL OR v_cfg.reporte_en < now() - interval '36 hours'
            OR v_cfg.reporte_mes IS DISTINCT FROM v_mes OR v_cfg.gasto_proyectado_ars IS NULL THEN
        v_auto_no := 'SIN_REPORTE_RECIENTE';
      ELSE
        -- Reservas vivas del mes: aumentos automáticos o aprobados que el ejecutor todavía no aplicó (no dependen de
        -- la fecha de ningún reporte), más los ya aplicados después de la última medición.
        SELECT COALESCE(sum(monto_extra_ars), 0) INTO v_comp FROM public.agente_propuestas
         WHERE tipo = 'ajuste_presupuesto' AND reserva_mes = v_mes
           AND (estado IN ('auto', 'aprobada') OR (estado = 'ejecutada' AND ejecutada_en >= v_cfg.reporte_en));
        IF v_cfg.gasto_proyectado_ars + v_comp + v_extra <= v_cfg.tope_mensual_ars THEN
          v_estado := 'auto';
        ELSE
          v_auto_no := 'SUPERA_TOPE';
        END IF;
      END IF;
    END IF;
  END IF;

  INSERT INTO public.agente_propuestas (agente, tipo, titulo, resumen, payload, estado, programada_para, monto_extra_ars,
                                        reserva_mes, auto_vence_en, clave_unica, revision_codex, resultado)
  VALUES (p_agente, p_tipo, v_titulo, v_resumen, v_payload, v_estado, p_programada_para, v_extra,
          CASE WHEN p_tipo = 'ajuste_presupuesto' THEN v_mes END, CASE WHEN v_estado = 'auto' THEN v_vence END, v_clave,
          CASE WHEN p_pedir_codex THEN 'pendiente' ELSE 'no_aplica' END,
          CASE WHEN v_auto_no IS NOT NULL THEN jsonb_build_object('auto_rechazado', v_auto_no) END)
  ON CONFLICT (clave_unica) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN   -- otra corrida la creó en el medio
    SELECT id INTO v_id FROM public.agente_propuestas WHERE clave_unica = v_clave;
    RETURN jsonb_build_object('ok', true, 'id', v_id, 'existente', true);
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'estado', v_estado, 'auto_rechazado', v_auto_no, 'monto_extra_ars', v_extra);
END $$;

DROP FUNCTION IF EXISTS agentes.revision_codex(BIGINT, TEXT, TEXT);
CREATE FUNCTION agentes.revision_codex(p_id BIGINT, p_veredicto TEXT, p_texto TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v public.agente_propuestas%ROWTYPE; v_texto TEXT := public.agente__texto_ok(p_texto, 8000, 'TEXTO_INVALIDO');
BEGIN
  IF p_veredicto IS NULL OR p_veredicto NOT IN ('aprobado', 'objeciones') THEN RAISE EXCEPTION 'VEREDICTO_INVALIDO'; END IF;
  SELECT * INTO v FROM public.agente_propuestas WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROPUESTA_INEXISTENTE'; END IF;
  IF v.estado NOT IN ('pendiente', 'auto', 'informativa') THEN RAISE EXCEPTION 'PROPUESTA_YA_DECIDIDA'; END IF;
  UPDATE public.agente_propuestas
     SET revision_codex = p_veredicto, codex_texto = v_texto,
         -- Una objeción de Codex frena lo automático: pasa a esperar a Franco.
         estado = CASE WHEN v.estado = 'auto' AND p_veredicto = 'objeciones' THEN 'pendiente' ELSE v.estado END,
         auto_vence_en = CASE WHEN v.estado = 'auto' AND p_veredicto = 'objeciones' THEN NULL ELSE v.auto_vence_en END
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END $$;

DROP FUNCTION IF EXISTS agentes.registrar(TEXT, TEXT, TEXT, TEXT, JSONB);
CREATE FUNCTION agentes.registrar(p_agente TEXT, p_corrida TEXT, p_nivel TEXT, p_mensaje TEXT, p_datos JSONB DEFAULT NULL) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id BIGINT;
BEGIN
  INSERT INTO public.agente_bitacora (agente, corrida, nivel, mensaje, datos)
  VALUES (p_agente, NULLIF(btrim(p_corrida), ''), COALESCE(p_nivel, 'info'), public.agente__texto_ok(p_mensaje, 2000, 'MENSAJE_INVALIDO'), p_datos)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

DROP FUNCTION IF EXISTS agentes.directiva(DATE, TEXT, JSONB);
CREATE FUNCTION agentes.directiva(p_semana DATE, p_texto TEXT, p_prioridades JSONB DEFAULT '[]'::jsonb) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_lunes DATE := date_trunc('week', COALESCE(p_semana, public.agente__hoy_ar()))::date;
        v_texto TEXT := public.agente__texto_ok(p_texto, 6000, 'TEXTO_INVALIDO');
BEGIN
  IF v_texto IS NULL THEN RAISE EXCEPTION 'TEXTO_INVALIDO'; END IF;
  INSERT INTO public.agente_directivas (semana, texto, prioridades)
  VALUES (v_lunes, v_texto, COALESCE(p_prioridades, '[]'::jsonb))
  ON CONFLICT (semana) DO UPDATE SET texto = EXCLUDED.texto, prioridades = EXCLUDED.prioridades, actualizada_en = now();
  RETURN jsonb_build_object('ok', true, 'semana', v_lunes);
END $$;

DROP FUNCTION IF EXISTS agentes.pauta_reporte(NUMERIC, NUMERIC);
CREATE FUNCTION agentes.pauta_reporte(p_gasto_al_dia NUMERIC, p_gasto_proyectado NUMERIC) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_gasto_al_dia IS NULL OR p_gasto_proyectado IS NULL OR p_gasto_al_dia = 'NaN'::numeric OR p_gasto_proyectado = 'NaN'::numeric
     OR p_gasto_al_dia < 0 OR p_gasto_proyectado < p_gasto_al_dia OR p_gasto_proyectado > 10000000000 THEN
    RAISE EXCEPTION 'GASTO_INVALIDO';
  END IF;
  UPDATE public.pauta_config
     SET gasto_al_dia_ars = round(p_gasto_al_dia, 2), gasto_proyectado_ars = round(p_gasto_proyectado, 2),
         reporte_en = now(), reporte_mes = date_trunc('month', public.agente__hoy_ar())::date,
         reporte_fuente = 'agente'                 -- informativo: NO habilita aumentos automáticos
   WHERE id = 1;
  RETURN jsonb_build_object('ok', true);
END $$;

DROP FUNCTION IF EXISTS agentes.blog_borrador(TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT);
CREATE FUNCTION agentes.blog_borrador(p_slug TEXT, p_titulo TEXT, p_bajada TEXT, p_cuerpo TEXT, p_etiquetas TEXT[], p_fuentes TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_slug TEXT := lower(btrim(COALESCE(p_slug, '')));
        v_titulo TEXT := public.agente__texto_ok(p_titulo, 200, 'TITULO_INVALIDO');
        v_bajada TEXT := public.agente__texto_ok(p_bajada, 400, 'BAJADA_INVALIDA');
        v_fuentes TEXT := public.agente__texto_ok(p_fuentes, 3000, 'FUENTES_INVALIDAS');
        v_nuevo BOOLEAN;
BEGIN
  IF to_regclass('public.blog_posts') IS NULL THEN RAISE EXCEPTION 'FALTA_BLOG'; END IF;
  IF v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(v_slug) > 120 THEN RAISE EXCEPTION 'SLUG_INVALIDO'; END IF;
  IF v_titulo IS NULL THEN RAISE EXCEPTION 'TITULO_INVALIDO'; END IF;
  IF p_cuerpo IS NULL OR length(btrim(p_cuerpo)) < 200 OR length(p_cuerpo) > 60000 THEN RAISE EXCEPTION 'CUERPO_INVALIDO'; END IF;
  -- Las notas de actualidad deben citar la fuente: sin fuentes no entra.
  IF v_fuentes IS NULL THEN RAISE EXCEPTION 'FALTAN_FUENTES'; END IF;
  -- SIEMPRE borrador: publicar lo hace Franco desde CRM → Blog. Si el slug ya existe (borrador o publicado), no se toca.
  EXECUTE 'INSERT INTO public.blog_posts (slug, titulo, bajada, cuerpo, etiquetas, estado, autor)
           VALUES ($1, $2, $3, $4, $5, ''borrador'', ''iPhone Mood'') ON CONFLICT (slug) DO NOTHING RETURNING true'
    INTO v_nuevo USING v_slug, v_titulo, v_bajada, p_cuerpo, COALESCE(p_etiquetas, '{}');
  IF NOT COALESCE(v_nuevo, false) THEN RETURN jsonb_build_object('ok', true, 'existente', true, 'slug', v_slug); END IF;
  PERFORM agentes.proponer('landing', 'blog', 'Nota de blog lista para revisar: ' || left(v_titulo, 150), v_bajada,
                           jsonb_build_object('slug', v_slug, 'fuentes', v_fuentes), NULL, 'blog-' || v_slug, false, false);
  RETURN jsonb_build_object('ok', true, 'slug', v_slug);
END $$;

-- ── 6 · Funciones de Franco (CRM, usuario logueado y autorizado) ────────────
CREATE OR REPLACE FUNCTION public.agente__usuario() RETURNS TEXT
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT NULLIF(auth.jwt() ->> 'email', '')
$$;

DROP FUNCTION IF EXISTS public.agente_aprobar(BIGINT, INTEGER, TEXT, TIMESTAMPTZ);
CREATE FUNCTION public.agente_aprobar(p_id BIGINT, p_revision INTEGER, p_texto TEXT DEFAULT NULL, p_programada_para TIMESTAMPTZ DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v public.agente_propuestas%ROWTYPE; v_texto TEXT := public.agente__texto_ok(p_texto, 2200, 'TEXTO_INVALIDO'); v_payload JSONB;
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v FROM public.agente_propuestas WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROPUESTA_INEXISTENTE'; END IF;
  IF p_revision IS DISTINCT FROM v.revision THEN RAISE EXCEPTION 'PROPUESTA_DESACTUALIZADA'; END IF;
  IF v.estado = 'informativa' THEN RAISE EXCEPTION 'PROPUESTA_INFORMATIVA'; END IF;
  IF v.estado <> 'pendiente' THEN RAISE EXCEPTION 'PROPUESTA_YA_DECIDIDA'; END IF;
  v_payload := v.payload;
  IF v_texto IS NOT NULL AND v_texto IS DISTINCT FROM v.payload ->> 'texto' THEN
    -- Se guarda el texto que propuso el agente, para que se vea qué corrigió Franco.
    v_payload := v_payload || jsonb_build_object('texto', v_texto)
                 || CASE WHEN v.payload ? 'texto_agente' THEN '{}'::jsonb ELSE jsonb_build_object('texto_agente', v.payload -> 'texto') END;
  END IF;
  UPDATE public.agente_propuestas
     SET estado = 'aprobada', decidida_por = public.agente__usuario(), decidida_en = now(), payload = v_payload,
         programada_para = COALESCE(p_programada_para, v.programada_para)
   WHERE id = p_id
  RETURNING revision INTO v.revision;
  RETURN jsonb_build_object('ok', true, 'revision', v.revision);
END $$;

DROP FUNCTION IF EXISTS public.agente_rechazar(BIGINT, INTEGER, TEXT);
CREATE FUNCTION public.agente_rechazar(p_id BIGINT, p_revision INTEGER, p_motivo TEXT DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v public.agente_propuestas%ROWTYPE; v_motivo TEXT := public.agente__texto_ok(p_motivo, 500, 'MOTIVO_INVALIDO');
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v FROM public.agente_propuestas WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROPUESTA_INEXISTENTE'; END IF;
  IF p_revision IS DISTINCT FROM v.revision THEN RAISE EXCEPTION 'PROPUESTA_DESACTUALIZADA'; END IF;
  IF v.estado = 'informativa' THEN RAISE EXCEPTION 'PROPUESTA_INFORMATIVA'; END IF;
  -- Un ajuste automático todavía no ejecutado también se puede frenar.
  IF v.estado NOT IN ('pendiente', 'auto') THEN RAISE EXCEPTION 'PROPUESTA_YA_DECIDIDA'; END IF;
  UPDATE public.agente_propuestas
     SET estado = 'rechazada', decidida_por = public.agente__usuario(), decidida_en = now(), motivo = v_motivo
   WHERE id = p_id
  RETURNING revision INTO v.revision;
  RETURN jsonb_build_object('ok', true, 'revision', v.revision);
END $$;

DROP FUNCTION IF EXISTS public.agente_marcar_leida(BIGINT);
CREATE FUNCTION public.agente_marcar_leida(p_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  UPDATE public.agente_propuestas SET leida_en = now() WHERE id = p_id AND estado = 'informativa' AND leida_en IS NULL;
  RETURN jsonb_build_object('ok', true);
END $$;

DROP FUNCTION IF EXISTS public.agente_pauta_tope(NUMERIC);
CREATE FUNCTION public.agente_pauta_tope(p_tope NUMERIC) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  IF p_tope IS NULL OR p_tope = 'NaN'::numeric OR p_tope < 0 OR p_tope > 10000000000 THEN RAISE EXCEPTION 'TOPE_INVALIDO'; END IF;
  UPDATE public.pauta_config
     SET tope_mensual_ars = round(p_tope, 2), tope_actualizado_por = public.agente__usuario(), tope_actualizado_en = now()
   WHERE id = 1;
  -- Con otro tope, los aumentos automáticos todavía no aplicados vuelven a esperar a Franco.
  UPDATE public.agente_propuestas
     SET estado = 'pendiente', auto_vence_en = NULL,
         resultado = COALESCE(resultado, '{}'::jsonb) || jsonb_build_object('auto_rechazado', 'TOPE_CAMBIADO')
   WHERE estado = 'auto' AND tipo = 'ajuste_presupuesto' AND monto_extra_ars > 0;
  RETURN jsonb_build_object('ok', true);
END $$;

-- ── 7 · Permisos ────────────────────────────────────────────────────────────
-- Se revoca de PUBLIC (anon, authenticated y agentes_ro heredan de PUBLIC) y se otorga a cada uno solo lo suyo.
REVOKE ALL ON FUNCTION public.agente__guardia()                           FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agente__hoy_ar()                            FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agente__texto_ok(TEXT, INTEGER, TEXT)       FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agente__usuario()                           FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agente__columna_sensible(TEXT)              FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agente__texto_libre(TEXT)                   FROM PUBLIC;
REVOKE ALL ON FUNCTION agentes.proponer(TEXT, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ, TEXT, BOOLEAN, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentes.revision_codex(BIGINT, TEXT, TEXT)        FROM PUBLIC;
REVOKE ALL ON FUNCTION agentes.registrar(TEXT, TEXT, TEXT, TEXT, JSONB)  FROM PUBLIC;
REVOKE ALL ON FUNCTION agentes.directiva(DATE, TEXT, JSONB)              FROM PUBLIC;
REVOKE ALL ON FUNCTION agentes.pauta_reporte(NUMERIC, NUMERIC)           FROM PUBLIC;
REVOKE ALL ON FUNCTION agentes.blog_borrador(TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agente_aprobar(BIGINT, INTEGER, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agente_rechazar(BIGINT, INTEGER, TEXT)     FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agente_marcar_leida(BIGINT)                FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agente_pauta_tope(NUMERIC)                 FROM PUBLIC;
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.agente__guardia(), public.agente__hoy_ar(), public.agente__texto_ok(TEXT, INTEGER, TEXT),
                      public.agente__columna_sensible(TEXT), public.agente__texto_libre(TEXT),
                      public.agente__usuario(), public.agente_aprobar(BIGINT, INTEGER, TEXT, TIMESTAMPTZ), public.agente_rechazar(BIGINT, INTEGER, TEXT),
                      public.agente_marcar_leida(BIGINT), public.agente_pauta_tope(NUMERIC) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.agente_aprobar(BIGINT, INTEGER, TEXT, TIMESTAMPTZ) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.agente_rechazar(BIGINT, INTEGER, TEXT)            TO authenticated;
    GRANT EXECUTE ON FUNCTION public.agente_marcar_leida(BIGINT)                       TO authenticated;
    GRANT EXECUTE ON FUNCTION public.agente_pauta_tope(NUMERIC)                        TO authenticated;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION agentes.proponer(TEXT, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ, TEXT, BOOLEAN, BOOLEAN) TO agentes_ro;
GRANT EXECUTE ON FUNCTION agentes.revision_codex(BIGINT, TEXT, TEXT)       TO agentes_revisor;   -- SOLO el revisor (Codex)
GRANT EXECUTE ON FUNCTION agentes.registrar(TEXT, TEXT, TEXT, TEXT, JSONB) TO agentes_ro;
GRANT EXECUTE ON FUNCTION agentes.directiva(DATE, TEXT, JSONB)             TO agentes_ro;
GRANT EXECUTE ON FUNCTION agentes.pauta_reporte(NUMERIC, NUMERIC)          TO agentes_ro;
GRANT EXECUTE ON FUNCTION agentes.blog_borrador(TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT) TO agentes_ro;

-- ── 8 · Funciones heredadas: PUBLIC → cada rol que ya las ejecutaba, menos los agentes ──
-- Toda función de `public` (salvo las de extensiones) que hoy ejecutan los agentes por herencia de PUBLIC: se otorga
-- EXPLÍCITAMENTE a cada rol que ya podía (anon, authenticated, service_role, postgres, …: nada cambia para ellos) y
-- recién después se revoca de PUBLIC. Una función de otro dueño que no se pueda tocar queda marcada por el control 24.9.
DO $$
DECLARE f RECORD; r RECORD; v_abiertas TEXT;
BEGIN
  FOR f IN
    SELECT p.oid, p.oid::regprocedure AS firma
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
       AND (has_function_privilege('agentes_ro', p.oid, 'EXECUTE') OR has_function_privilege('agentes_revisor', p.oid, 'EXECUTE'))
  LOOP
    BEGIN
      FOR r IN SELECT rolname FROM pg_roles
                WHERE rolname NOT LIKE 'pg\_%' AND rolname NOT IN ('agentes_ro', 'agentes_revisor')
                  AND has_function_privilege(oid, f.oid, 'EXECUTE')
      LOOP
        EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO %I', f.firma, r.rolname);
      END LOOP;
      EXECUTE format('REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC', f.firma);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'No se pudo cerrar % (otro dueño)', f.firma;
    END;
  END LOOP;
  -- Si quedó ALGUNA abierta, no se instala nada: una barrera a medias es peor que ninguna (todo el script se deshace).
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_abiertas
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     AND (has_function_privilege('agentes_ro', p.oid, 'EXECUTE') OR has_function_privilege('agentes_revisor', p.oid, 'EXECUTE'));
  IF v_abiertas IS NOT NULL THEN
    RAISE EXCEPTION 'FUNCIONES_SIN_CERRAR: %. Tienen otro dueño: avisar antes de seguir (no se instaló nada).', left(v_abiertas, 800);
  END IF;
END $$;

COMMIT;

-- ============================================================================
--  VERIFICACIÓN (solo lectura; sale como tabla al final). Tiene que verse TODO en ✅.
-- ============================================================================
SELECT id, control, CASE WHEN ok THEN '✅' ELSE '❌' END AS resultado
FROM (
  SELECT '24.1' AS id, 'Existen las 4 tablas de la mesa de control, con seguridad por filas' AS control,
         (SELECT count(*) = 4 FROM pg_class WHERE relrowsecurity AND oid IN (
            to_regclass('public.agente_propuestas'), to_regclass('public.agente_bitacora'),
            to_regclass('public.agente_directivas'), to_regclass('public.pauta_config'))) AS ok
  UNION ALL SELECT '24.2', 'El CRM (authenticated) solo LEE la mesa; anon no ve nada',
         has_table_privilege('authenticated', 'public.agente_propuestas', 'SELECT')
         AND NOT has_table_privilege('authenticated', 'public.agente_propuestas', 'INSERT')
         AND NOT has_table_privilege('authenticated', 'public.agente_propuestas', 'UPDATE')
         AND NOT has_table_privilege('authenticated', 'public.pauta_config', 'UPDATE')
         AND NOT has_table_privilege('anon', 'public.agente_propuestas', 'SELECT')
  UNION ALL SELECT '24.3', 'El rol agentes_ro existe y NO puede leer ni escribir directo cajas, ventas ni la mesa',
         EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentes_ro')
         AND NOT has_table_privilege('agentes_ro', 'public.agente_propuestas', 'UPDATE')
         AND NOT has_table_privilege('agentes_ro', 'public.agente_propuestas', 'SELECT')
         AND (to_regclass('public.cajas') IS NULL OR NOT has_table_privilege('agentes_ro', 'public.cajas', 'SELECT,UPDATE'))
         AND (to_regclass('public.ventas') IS NULL OR NOT has_table_privilege('agentes_ro', 'public.ventas', 'SELECT,UPDATE'))
  UNION ALL SELECT '24.4', 'agentes_ro NO puede aprobar, rechazar ni cambiar el tope',
         NOT has_function_privilege('agentes_ro', 'public.agente_aprobar(bigint,integer,text,timestamptz)', 'EXECUTE')
         AND NOT has_function_privilege('agentes_ro', 'public.agente_rechazar(bigint,integer,text)', 'EXECUTE')
         AND NOT has_function_privilege('agentes_ro', 'public.agente_pauta_tope(numeric)', 'EXECUTE')
  UNION ALL SELECT '24.5', 'Las funciones de los agentes las ejecuta SOLO agentes_ro (ni anon ni el CRM)',
         has_function_privilege('agentes_ro', 'agentes.proponer(text,text,text,text,jsonb,timestamptz,text,boolean,boolean)', 'EXECUTE')
         AND NOT has_function_privilege('authenticated', 'agentes.proponer(text,text,text,text,jsonb,timestamptz,text,boolean,boolean)', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'agentes.registrar(text,text,text,text,jsonb)', 'EXECUTE')
         AND NOT has_function_privilege('agentes_ro', 'agentes.revision_codex(bigint,text,text)', 'EXECUTE')
         AND has_function_privilege('agentes_revisor', 'agentes.revision_codex(bigint,text,text)', 'EXECUTE')
         AND NOT has_function_privilege('agentes_revisor', 'agentes.proponer(text,text,text,text,jsonb,timestamptz,text,boolean,boolean)', 'EXECUTE')
  UNION ALL SELECT '24.6', 'El trigger que exige persona autorizada para aprobar o rechazar existe',
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.agente_propuestas'::regclass AND tgname = 'agente_guardia' AND NOT tgisinternal)
  UNION ALL SELECT '24.7', 'Las vistas del esquema agentes existen y ninguna expone tablas con secretos',
         (SELECT count(*) >= 10 FROM pg_views WHERE schemaname = 'agentes')
         AND NOT EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'agentes'
                          AND (viewname IN ('usuarios_autorizados', 'configuracion', 'presupuestos', 'clientes')
                               OR viewname LIKE 'meli_cuenta%' OR viewname LIKE 'meli_config%' OR viewname LIKE 'arca%'))
  UNION ALL SELECT '24.8', 'El tope de pauta tiene su fila (arranca en 0 = sin ajustes automáticos)',
         EXISTS (SELECT 1 FROM public.pauta_config WHERE id = 1)
  UNION ALL SELECT '24.9', 'Los agentes no ejecutan NINGUNA función de public (ni las viejas del CRM con un JWT inventado)',
         NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
                        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
                        AND (has_function_privilege('agentes_ro', p.oid, 'EXECUTE') OR has_function_privilege('agentes_revisor', p.oid, 'EXECUTE')))
  UNION ALL SELECT '24.10', 'Ninguna vista del esquema agentes muestra columnas de secretos o datos personales',
         NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'agentes'
                      AND (public.agente__columna_sensible(column_name)
                           OR (public.agente__texto_libre(column_name) AND table_name NOT LIKE 'agente\_%' AND table_name NOT IN ('pauta_config', 'blog_posts'))
                           OR (data_type IN ('json', 'jsonb') AND table_name NOT LIKE 'agente\_%' AND table_name <> 'pauta_config')))
  UNION ALL SELECT '24.11', 'Los agentes no entran a los esquemas internos (auth, storage, vault, net, cron, supabase_functions)',
         NOT EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN (VALUES ('agentes_ro'), ('agentes_revisor')) r(rol)
                      WHERE n.nspname IN ('auth', 'storage', 'vault', 'net', 'cron', 'supabase_functions', 'graphql', 'realtime')
                        AND has_schema_privilege(r.rol, n.oid, 'USAGE'))
) t
ORDER BY id;
