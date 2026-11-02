-- ============================================================================
--  arca_control_anual.sql — CONTROL DE FACTURACIÓN ANUAL (seguimiento interno del tope de monotributo)
--
--  QUÉ HACE: suma lo facturado en los últimos 12 meses con las facturas de ARCA emitidas desde el CRM (solo PRODUCCIÓN y solo las
--  autorizadas; las de prueba no cuentan) más un monto «facturado fuera del CRM» que carga una persona autorizada, y lo compara con
--  el límite anual que se configura. NO bloquea ni frena ninguna factura: es un tablero para controlar.
--
--  REGLAS
--   · El límite y el monto externo los guarda una persona autorizada con arca_control_config_guardar; cada cambio queda en un historial
--     que no se modifica ni se borra (quién, cuándo, valor anterior y nuevo).
--   · Las notas de crédito se restarán cuando exista ese paso (hoy solo hay Factura C).
--   · Ventana móvil de 12 meses contra la fecha del comprobante (hora de Argentina).
--
--  REQUISITOS: script 20 (meli_comprobantes) y la función is_authorized_user(). Idempotente. No cambia ningún dato existente.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.meli_comprobantes') IS NULL OR to_regprocedure('public.is_authorized_user()') IS NULL THEN
    RAISE EXCEPTION 'Falta el script 20 (arca_comprobantes) o is_authorized_user(). Correrlos antes que este.';
  END IF;
END $$;

BEGIN;

CREATE TABLE IF NOT EXISTS public.arca_control_config (
  id                    SMALLINT    PRIMARY KEY CHECK (id = 1),
  limite_anual_centavos BIGINT      NOT NULL DEFAULT 0 CHECK (limite_anual_centavos BETWEEN 0 AND 99999999999900),
  fuera_crm_centavos    BIGINT      NOT NULL DEFAULT 0 CHECK (fuera_crm_centavos BETWEEN 0 AND 99999999999900),
  actualizado_por       TEXT,
  actualizado_en        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.arca_control_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.arca_control_config_historial (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  limite_anterior_centavos BIGINT, limite_nuevo_centavos BIGINT NOT NULL,
  fuera_anterior_centavos  BIGINT, fuera_nuevo_centavos  BIGINT NOT NULL,
  cambiado_por             TEXT        NOT NULL,
  creado_en                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.arca__control_historial_proteger()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'HISTORIAL_INMUTABLE' USING ERRCODE = '42501'; END $$;
DROP TRIGGER IF EXISTS arca_control_historial_proteger_tg ON public.arca_control_config_historial;
CREATE TRIGGER arca_control_historial_proteger_tg BEFORE UPDATE OR DELETE ON public.arca_control_config_historial
  FOR EACH ROW EXECUTE FUNCTION public.arca__control_historial_proteger();
DROP TRIGGER IF EXISTS arca_control_historial_truncate_tg ON public.arca_control_config_historial;
CREATE TRIGGER arca_control_historial_truncate_tg BEFORE TRUNCATE ON public.arca_control_config_historial
  FOR EACH STATEMENT EXECUTE FUNCTION public.arca__control_historial_proteger();

ALTER TABLE public.arca_control_config           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arca_control_config_historial ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS arca_control_config_leer ON public.arca_control_config;
CREATE POLICY arca_control_config_leer ON public.arca_control_config FOR SELECT TO authenticated USING (public.is_authorized_user());
DROP POLICY IF EXISTS arca_control_historial_leer ON public.arca_control_config_historial;
CREATE POLICY arca_control_historial_leer ON public.arca_control_config_historial FOR SELECT TO authenticated USING (public.is_authorized_user());
REVOKE ALL ON TABLE public.arca_control_config, public.arca_control_config_historial FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.arca_control_config, public.arca_control_config_historial TO authenticated;
REVOKE ALL ON FUNCTION public.arca__control_historial_proteger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.arca_control_config_historial_id_seq FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON TABLE public.arca_control_config, public.arca_control_config_historial FROM service_role;
    REVOKE ALL ON FUNCTION public.arca__control_historial_proteger() FROM service_role;
    REVOKE ALL ON SEQUENCE public.arca_control_config_historial_id_seq FROM service_role;
  END IF;
END $$;

-- Lo facturado en los últimos 12 meses y su comparación con el límite. Solo usuarios autorizados.
-- Si el script 22 (notas de crédito) ya está instalado, su versión de esta función RESTA las notas de crédito: este script NO la pisa.
DO $fn$
BEGIN
  IF to_regclass('public.meli_notas_credito') IS NULL THEN
    EXECUTE $def$
CREATE OR REPLACE FUNCTION public.arca_control_anual()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_hoy DATE := (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
  v_desde DATE; v_cfg public.arca_control_config%ROWTYPE; v_crm BIGINT; v_cant INTEGER; v_meses JSONB;
BEGIN
  IF public.is_authorized_user() IS NOT TRUE THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  v_desde := (v_hoy - interval '12 months')::date;      -- la ventana es (desde, hoy]
  SELECT * INTO v_cfg FROM public.arca_control_config WHERE id = 1;
  SELECT COALESCE(sum(importe_centavos), 0)::BIGINT, count(*)::INTEGER INTO v_crm, v_cant
    FROM public.meli_comprobantes WHERE ambiente = 'produccion' AND estado = 'autorizado' AND fecha_cbte > v_desde AND fecha_cbte <= v_hoy;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('mes', m.mes, 'centavos', m.total, 'cantidad', m.cant) ORDER BY m.mes), '[]'::jsonb) INTO v_meses
    FROM (SELECT to_char(fecha_cbte, 'YYYY-MM') AS mes, sum(importe_centavos)::BIGINT AS total, count(*)::INTEGER AS cant
            FROM public.meli_comprobantes WHERE ambiente = 'produccion' AND estado = 'autorizado' AND fecha_cbte > v_desde AND fecha_cbte <= v_hoy
           GROUP BY 1) m;
  RETURN jsonb_build_object('desde', v_desde, 'hasta', v_hoy, 'limite_centavos', v_cfg.limite_anual_centavos, 'fuera_crm_centavos', v_cfg.fuera_crm_centavos,
    'facturado_crm_centavos', v_crm, 'total_centavos', v_crm + v_cfg.fuera_crm_centavos, 'cantidad', v_cant, 'por_mes', v_meses,
    'actualizado_por', v_cfg.actualizado_por, 'actualizado_en', v_cfg.actualizado_en);
END $$;


    $def$;
    REVOKE ALL ON FUNCTION public.arca_control_anual() FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.arca_control_anual() TO authenticated;
  END IF;
END $fn$;

-- Guarda el límite anual y lo facturado fuera del CRM (en centavos). Deja el cambio en el historial.
DROP FUNCTION IF EXISTS public.arca_control_config_guardar(BIGINT, BIGINT);
CREATE FUNCTION public.arca_control_config_guardar(p_limite_centavos BIGINT, p_fuera_centavos BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_old public.arca_control_config%ROWTYPE; v_quien TEXT := COALESCE(NULLIF(auth.jwt() ->> 'email', ''), 'desconocido');
BEGIN
  IF public.is_authorized_user() IS NOT TRUE THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  IF p_limite_centavos IS NULL OR p_limite_centavos NOT BETWEEN 0 AND 99999999999900 THEN RAISE EXCEPTION 'LIMITE_INVALIDO'; END IF;
  IF p_fuera_centavos IS NULL OR p_fuera_centavos NOT BETWEEN 0 AND 99999999999900 THEN RAISE EXCEPTION 'MONTO_EXTERNO_INVALIDO'; END IF;
  SELECT * INTO v_old FROM public.arca_control_config WHERE id = 1 FOR UPDATE;
  IF v_old.limite_anual_centavos = p_limite_centavos AND v_old.fuera_crm_centavos = p_fuera_centavos THEN RETURN jsonb_build_object('ok', TRUE, 'sin_cambios', TRUE); END IF;
  UPDATE public.arca_control_config SET limite_anual_centavos = p_limite_centavos, fuera_crm_centavos = p_fuera_centavos, actualizado_por = v_quien, actualizado_en = now() WHERE id = 1;
  INSERT INTO public.arca_control_config_historial (limite_anterior_centavos, limite_nuevo_centavos, fuera_anterior_centavos, fuera_nuevo_centavos, cambiado_por)
  VALUES (v_old.limite_anual_centavos, p_limite_centavos, v_old.fuera_crm_centavos, p_fuera_centavos, v_quien);
  RETURN jsonb_build_object('ok', TRUE);
END $$;

REVOKE ALL ON FUNCTION public.arca_control_config_guardar(BIGINT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.arca_control_config_guardar(BIGINT, BIGINT) TO authenticated;

COMMIT;

-- Verificación (solo lectura): tiene que dar dos filas con ✅.
SELECT 'tablas y funciones' AS control,
       CASE WHEN to_regclass('public.arca_control_config') IS NOT NULL AND to_regprocedure('public.arca_control_anual()') IS NOT NULL
             AND to_regprocedure('public.arca_control_config_guardar(bigint,bigint)') IS NOT NULL THEN '✅' ELSE '❌' END AS resultado
UNION ALL
SELECT 'el navegador no escribe la configuración',
       CASE WHEN NOT has_table_privilege('authenticated', 'public.arca_control_config', 'UPDATE') AND NOT has_table_privilege('anon', 'public.arca_control_config', 'SELECT') THEN '✅' ELSE '❌' END;
