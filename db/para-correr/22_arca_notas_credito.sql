-- ============================================================================
--  arca_notas_credito.sql — NOTAS DE CRÉDITO C (anulan una factura por su total) emitidas por el CRM
--
--  QUÉ HACE: crea meli_notas_credito (UNA nota de crédito TOTAL por factura autorizada), las funciones del servidor para reservar el número,
--  anotar el CAE o el rechazo (misma mecánica que las facturas: intentos con candado, numeración propia del tipo 13, ventana de seguridad)
--  y actualiza arca_control_anual() para RESTAR las notas de crédito del total facturado.
--
--  REGLAS (innegociables)
--   · Solo se emite contra una factura AUTORIZADA, del mismo ambiente y punto de venta, y por el MISMO importe y receptor que la factura.
--     Una nota de crédito por factura (total): no hay notas parciales ni se reparten importes.
--   · Queda asociada a la factura (CbtesAsoc). El motivo es de una lista cerrada y se guarda quién la pidió.
--   · Una nota de crédito autorizada no se modifica ni se borra. La factura original tampoco cambia.
--   · Las de homologación (pruebas) no cuentan en el control anual.
--
--  REQUISITOS: scripts 20 (comprobantes) y 21 (control anual). Idempotente. No cambia ningún dato existente.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.meli_comprobantes') IS NULL OR to_regprocedure('public.arca_control_anual()') IS NULL
     OR to_regprocedure('public.meli_secreto_ok(text)') IS NULL THEN
    RAISE EXCEPTION 'Faltan los scripts 20 (arca_comprobantes) y 21 (arca_control_anual). Correrlos antes que este.';
  END IF;
END $$;

BEGIN;

CREATE TABLE IF NOT EXISTS public.meli_notas_credito (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  comprobante_id  BIGINT      NOT NULL UNIQUE REFERENCES public.meli_comprobantes (id),   -- la factura que anula (una nota total por factura)
  orden_id        TEXT        NOT NULL,
  ambiente        TEXT        NOT NULL CHECK (ambiente IN ('homologacion', 'produccion')),
  pto_venta       INTEGER     NOT NULL CHECK (pto_venta BETWEEN 1 AND 99999),
  numero          INTEGER     CHECK (numero BETWEEN 1 AND 99999999),
  estado          TEXT        NOT NULL CHECK (estado IN ('reservado', 'autorizado', 'rechazado')),
  importe_centavos BIGINT     NOT NULL CHECK (importe_centavos > 0),
  doc_tipo        INTEGER     NOT NULL CHECK (doc_tipo IN (80, 86, 96, 99)),
  doc_nro         TEXT        NOT NULL CHECK (doc_nro ~ '^[0-9]{1,20}$'),
  cond_iva        INTEGER     NOT NULL CHECK (cond_iva BETWEEN 1 AND 99),
  motivo          TEXT        NOT NULL CHECK (motivo IN ('devolucion', 'cancelacion', 'error_de_facturacion')),
  creado_por      TEXT        NOT NULL,
  ultimo_solicitante TEXT,                                -- quién pidió el último intento (creado_por conserva a quien la pidió primero)
  cae             TEXT        CHECK (cae ~ '^[0-9]{10,20}$'),
  cae_vto         DATE,
  fecha_cbte      DATE,
  intento_id      UUID        NOT NULL DEFAULT gen_random_uuid(),
  trabajo_hasta   TIMESTAMPTZ,
  intentos        INTEGER     NOT NULL DEFAULT 1,
  ultimo_error    TEXT,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meli_nc_coherente_ck CHECK (
       (estado = 'reservado'  AND numero IS NOT NULL AND cae IS NULL)
    OR (estado = 'autorizado' AND numero IS NOT NULL AND cae IS NOT NULL AND cae_vto IS NOT NULL AND fecha_cbte IS NOT NULL)
    OR (estado = 'rechazado'  AND numero IS NULL     AND cae IS NULL)),
  CONSTRAINT meli_nc_consumidor_ck CHECK (doc_tipo <> 99 OR doc_nro = '0')
);
COMMENT ON TABLE public.meli_notas_credito IS 'Notas de crédito C (tipo 13) que anulan una factura por su total. Una por factura. Autorizada = inmodificable. No se borra nunca.';
CREATE UNIQUE INDEX IF NOT EXISTS meli_nc_numero_unico ON public.meli_notas_credito (ambiente, pto_venta, numero) WHERE numero IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS meli_nc_intento_unico ON public.meli_notas_credito (intento_id);
CREATE INDEX IF NOT EXISTS meli_nc_pendientes ON public.meli_notas_credito (ambiente, pto_venta) WHERE estado = 'reservado';
CREATE INDEX IF NOT EXISTS meli_nc_orden ON public.meli_notas_credito (orden_id);

CREATE OR REPLACE FUNCTION public.arca__nc_proteger()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' THEN RAISE EXCEPTION 'NOTA_CREDITO_NO_SE_BORRA' USING ERRCODE = '42501'; END IF;
  IF OLD.estado = 'autorizado' THEN RAISE EXCEPTION 'NOTA_CREDITO_AUTORIZADA_INMODIFICABLE' USING ERRCODE = '42501'; END IF;
  IF NEW.comprobante_id IS DISTINCT FROM OLD.comprobante_id OR NEW.orden_id IS DISTINCT FROM OLD.orden_id OR NEW.ambiente IS DISTINCT FROM OLD.ambiente
     OR NEW.pto_venta IS DISTINCT FROM OLD.pto_venta OR NEW.creado_por IS DISTINCT FROM OLD.creado_por THEN
    RAISE EXCEPTION 'NOTA_CREDITO_DATOS_FIJOS' USING ERRCODE = '42501';
  END IF;
  NEW.actualizado_en := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS meli_nc_proteger_tg ON public.meli_notas_credito;
CREATE TRIGGER meli_nc_proteger_tg BEFORE UPDATE OR DELETE ON public.meli_notas_credito FOR EACH ROW EXECUTE FUNCTION public.arca__nc_proteger();
DROP TRIGGER IF EXISTS meli_nc_truncate_tg ON public.meli_notas_credito;
CREATE TRIGGER meli_nc_truncate_tg BEFORE TRUNCATE ON public.meli_notas_credito FOR EACH STATEMENT EXECUTE FUNCTION public.arca__nc_proteger();

ALTER TABLE public.meli_notas_credito ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meli_nc_leer ON public.meli_notas_credito;
CREATE POLICY meli_nc_leer ON public.meli_notas_credito FOR SELECT TO authenticated USING (public.is_authorized_user());
REVOKE ALL ON TABLE public.meli_notas_credito FROM PUBLIC, anon, authenticated;
-- El CRM lee la nota SIN el documento del receptor ni el identificador de intento (que es el candado).
GRANT SELECT (id, comprobante_id, orden_id, ambiente, pto_venta, numero, estado, importe_centavos, motivo, creado_por, ultimo_solicitante, cae, cae_vto, fecha_cbte, intentos, creado_en, actualizado_en)
  ON TABLE public.meli_notas_credito TO authenticated;
REVOKE ALL ON FUNCTION public.arca__nc_proteger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.meli_notas_credito_id_seq FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON TABLE public.meli_notas_credito FROM service_role;
    REVOKE ALL ON FUNCTION public.arca__nc_proteger() FROM service_role;
    REVOKE ALL ON SEQUENCE public.meli_notas_credito_id_seq FROM service_role;
  END IF;
END $$;

-- ── Funciones del servidor (con el secreto compartido) ─────────────────────
DROP FUNCTION IF EXISTS public.arca_nc_estado(TEXT, TEXT, TEXT);
CREATE FUNCTION public.arca_nc_estado(p_secreto TEXT, p_orden TEXT, p_ambiente TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n public.meli_notas_credito%ROWTYPE; f public.meli_comprobantes%ROWTYPE;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  SELECT * INTO f FROM public.meli_comprobantes WHERE orden_id = p_orden AND ambiente = p_ambiente;
  IF NOT FOUND OR f.estado <> 'autorizado' THEN RETURN jsonb_build_object('estado', 'sin_factura'); END IF;
  SELECT * INTO n FROM public.meli_notas_credito WHERE comprobante_id = f.id;
  IF NOT FOUND THEN RETURN jsonb_build_object('estado', 'ninguna', 'factura_numero', f.numero); END IF;
  RETURN jsonb_build_object('estado', n.estado, 'numero', n.numero, 'pto_venta', n.pto_venta, 'cae', n.cae, 'importe_centavos', n.importe_centavos, 'factura_numero', f.numero);
END $$;

DROP FUNCTION IF EXISTS public.arca_nc_conciliar_tomar(TEXT, TEXT, TEXT);
CREATE FUNCTION public.arca_nc_conciliar_tomar(p_secreto TEXT, p_orden TEXT, p_ambiente TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n public.meli_notas_credito%ROWTYPE; v UUID := gen_random_uuid();
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  SELECT n2.* INTO n FROM public.meli_notas_credito n2 WHERE n2.orden_id = p_orden AND n2.ambiente = p_ambiente FOR UPDATE;
  IF NOT FOUND OR n.estado <> 'reservado' THEN RETURN jsonb_build_object('tomado', FALSE, 'estado', COALESCE(n.estado, 'ninguna')); END IF;
  -- Misma ventana de seguridad que las facturas: 10 minutos desde que empezó el intento.
  IF n.trabajo_hasta IS NOT NULL AND n.trabajo_hasta > now() - interval '8 minutes' THEN RETURN jsonb_build_object('tomado', FALSE, 'estado', 'reservado', 'en_curso', TRUE); END IF;
  UPDATE public.meli_notas_credito SET intento_id = v, trabajo_hasta = now() + interval '2 minutes' WHERE id = n.id;
  RETURN jsonb_build_object('tomado', TRUE, 'intento', v, 'numero', n.numero, 'pto_venta', n.pto_venta, 'importe_centavos', n.importe_centavos, 'doc_tipo', n.doc_tipo, 'doc_nro', n.doc_nro);
END $$;

-- Reserva el número de la nota de crédito para anular la factura AUTORIZADA de la orden en ese ambiente. p_ultimo_arca = último tipo 13 según ARCA.
DROP FUNCTION IF EXISTS public.arca_nc_reservar(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT);
CREATE FUNCTION public.arca_nc_reservar(p_secreto TEXT, p_orden TEXT, p_ambiente TEXT, p_ultimo_arca INTEGER, p_motivo TEXT, p_usuario TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f public.meli_comprobantes%ROWTYPE; n public.meli_notas_credito%ROWTYPE; v_num INTEGER; v_max INTEGER; v_nuevo BOOLEAN := TRUE; v_intento UUID := gen_random_uuid();
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF p_ambiente NOT IN ('homologacion', 'produccion') THEN RAISE EXCEPTION 'AMBIENTE_INVALIDO'; END IF;
  IF p_ultimo_arca IS NULL OR p_ultimo_arca < 0 OR p_ultimo_arca >= 99999999 THEN RAISE EXCEPTION 'ULTIMO_ARCA_INVALIDO'; END IF;
  IF p_motivo IS NULL OR p_motivo NOT IN ('devolucion', 'cancelacion', 'error_de_facturacion') THEN RAISE EXCEPTION 'MOTIVO_INVALIDO'; END IF;
  IF p_usuario IS NULL OR btrim(p_usuario) = '' THEN RAISE EXCEPTION 'USUARIO_INVALIDO'; END IF;

  -- Orden común de bloqueos: 1) la orden, 2) el punto de venta de las notas, 3) las filas.
  PERFORM pg_advisory_xact_lock(hashtextextended('orden|' || p_orden, 0));
  SELECT * INTO f FROM public.meli_comprobantes WHERE orden_id = p_orden AND ambiente = p_ambiente;
  IF NOT FOUND OR f.estado <> 'autorizado' THEN RAISE EXCEPTION 'FACTURA_NO_AUTORIZADA'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_ambiente || '|' || f.pto_venta::text || '|13', 0));

  SELECT * INTO n FROM public.meli_notas_credito WHERE comprobante_id = f.id FOR UPDATE;
  IF FOUND THEN
    IF n.estado IN ('autorizado', 'reservado') THEN RAISE EXCEPTION 'NOTA_CREDITO_YA_EXISTE'; END IF;
    v_nuevo := FALSE;      -- estaba rechazada: se vuelve a intentar con un número nuevo
  END IF;
  IF EXISTS (SELECT 1 FROM public.meli_notas_credito x WHERE x.ambiente = p_ambiente AND x.pto_venta = f.pto_venta AND x.estado = 'reservado' AND x.comprobante_id <> f.id) THEN
    RAISE EXCEPTION 'NUMERACION_PENDIENTE';
  END IF;
  SELECT COALESCE(max(x.numero), 0) INTO v_max FROM public.meli_notas_credito x WHERE x.ambiente = p_ambiente AND x.pto_venta = f.pto_venta;
  v_num := GREATEST(p_ultimo_arca, v_max) + 1;
  IF v_num > 99999999 THEN RAISE EXCEPTION 'NUMERACION_AGOTADA'; END IF;

  IF v_nuevo THEN
    INSERT INTO public.meli_notas_credito (comprobante_id, orden_id, ambiente, pto_venta, numero, estado, importe_centavos, doc_tipo, doc_nro, cond_iva, motivo, creado_por, ultimo_solicitante, intento_id, trabajo_hasta)
    VALUES (f.id, p_orden, p_ambiente, f.pto_venta, v_num, 'reservado', f.importe_centavos, f.doc_tipo, f.doc_nro, f.cond_iva, p_motivo, left(btrim(p_usuario), 200), left(btrim(p_usuario), 200), v_intento, now() + interval '2 minutes');
  ELSE
    UPDATE public.meli_notas_credito SET estado = 'reservado', numero = v_num, motivo = p_motivo, ultimo_solicitante = left(btrim(p_usuario), 200), intento_id = v_intento, trabajo_hasta = now() + interval '2 minutes',
           intentos = intentos + 1, ultimo_error = NULL WHERE id = n.id;
  END IF;
  RETURN jsonb_build_object('estado', 'reservado', 'intento', v_intento, 'numero', v_num, 'pto_venta', f.pto_venta, 'importe_centavos', f.importe_centavos,
    'doc_tipo', f.doc_tipo, 'doc_nro', f.doc_nro, 'cond_iva', f.cond_iva, 'factura_numero', f.numero, 'factura_fecha', f.fecha_cbte);
END $$;

DROP FUNCTION IF EXISTS public.arca_nc_autorizar(TEXT, UUID, INTEGER, TEXT, DATE, DATE);
CREATE FUNCTION public.arca_nc_autorizar(p_secreto TEXT, p_intento UUID, p_numero INTEGER, p_cae TEXT, p_cae_vto DATE, p_fecha_cbte DATE)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n public.meli_notas_credito%ROWTYPE;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF p_cae IS NULL OR p_cae !~ '^[0-9]{10,20}$' OR p_cae_vto IS NULL OR p_fecha_cbte IS NULL THEN RAISE EXCEPTION 'CAE_INVALIDO'; END IF;
  SELECT * INTO n FROM public.meli_notas_credito WHERE intento_id = p_intento;
  IF NOT FOUND THEN RAISE EXCEPTION 'INTENTO_NO_VIGENTE'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('orden|' || n.orden_id, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(n.ambiente || '|' || n.pto_venta::text || '|13', 0));
  SELECT * INTO n FROM public.meli_notas_credito WHERE intento_id = p_intento FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INTENTO_NO_VIGENTE'; END IF;
  IF n.estado = 'autorizado' THEN
    IF n.cae = p_cae AND n.numero = p_numero THEN RETURN jsonb_build_object('estado', 'autorizado', 'numero', n.numero, 'sin_cambios', TRUE); END IF;
    RAISE EXCEPTION 'NOTA_YA_AUTORIZADA_CON_OTRO_CAE';
  END IF;
  IF n.estado <> 'reservado' THEN RAISE EXCEPTION 'NOTA_NO_RESERVADA'; END IF;
  IF n.numero IS DISTINCT FROM p_numero THEN RAISE EXCEPTION 'NUMERO_DISTINTO_AL_RESERVADO'; END IF;
  UPDATE public.meli_notas_credito SET estado = 'autorizado', cae = p_cae, cae_vto = p_cae_vto, fecha_cbte = p_fecha_cbte, ultimo_error = NULL, trabajo_hasta = NULL WHERE id = n.id;
  RETURN jsonb_build_object('estado', 'autorizado', 'numero', n.numero);
END $$;

DROP FUNCTION IF EXISTS public.arca_nc_rechazar(TEXT, UUID, INTEGER, TEXT);
CREATE FUNCTION public.arca_nc_rechazar(p_secreto TEXT, p_intento UUID, p_numero INTEGER, p_error TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n public.meli_notas_credito%ROWTYPE;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  SELECT * INTO n FROM public.meli_notas_credito WHERE intento_id = p_intento FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INTENTO_NO_VIGENTE'; END IF;
  IF n.estado <> 'reservado' THEN RAISE EXCEPTION 'NOTA_NO_RESERVADA'; END IF;
  IF n.numero IS DISTINCT FROM p_numero THEN RAISE EXCEPTION 'NUMERO_DISTINTO_AL_RESERVADO'; END IF;
  UPDATE public.meli_notas_credito SET estado = 'rechazado', numero = NULL, trabajo_hasta = NULL, ultimo_error = left(COALESCE(p_error, 'rechazada'), 300) WHERE id = n.id;
  RETURN jsonb_build_object('estado', 'rechazado');
END $$;

REVOKE ALL ON FUNCTION
  public.arca_nc_estado(TEXT, TEXT, TEXT), public.arca_nc_conciliar_tomar(TEXT, TEXT, TEXT), public.arca_nc_reservar(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT),
  public.arca_nc_autorizar(TEXT, UUID, INTEGER, TEXT, DATE, DATE), public.arca_nc_rechazar(TEXT, UUID, INTEGER, TEXT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.arca_nc_estado(TEXT, TEXT, TEXT), public.arca_nc_conciliar_tomar(TEXT, TEXT, TEXT), public.arca_nc_reservar(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT),
  public.arca_nc_autorizar(TEXT, UUID, INTEGER, TEXT, DATE, DATE), public.arca_nc_rechazar(TEXT, UUID, INTEGER, TEXT)
TO anon, authenticated;

-- ── Control anual: las notas de crédito AUTORIZADAS de producción RESTAN del total ──
CREATE OR REPLACE FUNCTION public.arca_control_anual()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_hoy DATE := (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
  v_desde DATE; v_cfg public.arca_control_config%ROWTYPE; v_crm BIGINT; v_cant INTEGER; v_nc BIGINT; v_nc_cant INTEGER; v_meses JSONB;
BEGIN
  IF public.is_authorized_user() IS NOT TRUE THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  v_desde := (v_hoy - interval '12 months')::date;
  SELECT * INTO v_cfg FROM public.arca_control_config WHERE id = 1;
  SELECT COALESCE(sum(importe_centavos), 0)::BIGINT, count(*)::INTEGER INTO v_crm, v_cant
    FROM public.meli_comprobantes WHERE ambiente = 'produccion' AND estado = 'autorizado' AND fecha_cbte > v_desde AND fecha_cbte <= v_hoy;
  SELECT COALESCE(sum(importe_centavos), 0)::BIGINT, count(*)::INTEGER INTO v_nc, v_nc_cant
    FROM public.meli_notas_credito WHERE ambiente = 'produccion' AND estado = 'autorizado' AND fecha_cbte > v_desde AND fecha_cbte <= v_hoy;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('mes', m.mes, 'centavos', m.total, 'cantidad', m.cant) ORDER BY m.mes), '[]'::jsonb) INTO v_meses
    FROM (SELECT mes, sum(total)::BIGINT AS total, sum(cant)::INTEGER AS cant FROM (
            SELECT to_char(fecha_cbte, 'YYYY-MM') AS mes, importe_centavos AS total, 1 AS cant FROM public.meli_comprobantes
             WHERE ambiente = 'produccion' AND estado = 'autorizado' AND fecha_cbte > v_desde AND fecha_cbte <= v_hoy
            UNION ALL
            SELECT to_char(fecha_cbte, 'YYYY-MM'), -importe_centavos, 0 FROM public.meli_notas_credito
             WHERE ambiente = 'produccion' AND estado = 'autorizado' AND fecha_cbte > v_desde AND fecha_cbte <= v_hoy) u GROUP BY mes) m;
  RETURN jsonb_build_object('desde', v_desde, 'hasta', v_hoy, 'limite_centavos', v_cfg.limite_anual_centavos, 'fuera_crm_centavos', v_cfg.fuera_crm_centavos,
    'facturado_crm_centavos', v_crm, 'notas_credito_centavos', v_nc, 'notas_credito_cantidad', v_nc_cant,
    'total_centavos', v_crm - v_nc + v_cfg.fuera_crm_centavos, 'cantidad', v_cant, 'por_mes', v_meses,
    'actualizado_por', v_cfg.actualizado_por, 'actualizado_en', v_cfg.actualizado_en);
END $$;
REVOKE ALL ON FUNCTION public.arca_control_anual() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.arca_control_anual() TO authenticated;

COMMIT;

-- Verificación (solo lectura): tiene que dar dos filas con ✅.
SELECT 'tabla y funciones' AS control,
       CASE WHEN to_regclass('public.meli_notas_credito') IS NOT NULL AND to_regprocedure('public.arca_nc_reservar(text,text,text,integer,text,text)') IS NOT NULL THEN '✅' ELSE '❌' END AS resultado
UNION ALL
SELECT 'cerradas al navegador',
       CASE WHEN NOT has_table_privilege('anon', 'public.meli_notas_credito', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.meli_notas_credito', 'INSERT') THEN '✅' ELSE '❌' END;
