-- ============================================================================
--  arca_automatico.sql — FACTURACIÓN AUTOMÁTICA: factura al aprobarse el pago y nota de crédito al cancelarse la venta
--
--  QUÉ HACE: guarda dos INTERRUPTORES (apagados por defecto) y la cola de reintentos de la automatización:
--    · factura_auto: el servidor emite la factura de las ventas de Mercado Libre PAGADAS desde el momento en que se enciende
--      (nunca de las anteriores: para ponerse al día está la pantalla «Emitir facturas pendientes»).
--    · nota_auto: el servidor emite la nota de crédito TOTAL cuando una venta ya facturada pasa a CANCELADA en Mercado Libre.
--  Los reembolsos parciales, las devoluciones y las mediaciones NO son automáticos: quedan para el botón de nota de crédito.
--
--  REGLAS (innegociables)
--   · Los interruptores nacen APAGADOS y los cambia una persona autorizada con arca_auto_config_guardar (queda quién y cuándo).
--   · Cada encendido queda ATADO al ambiente con el que se encendió (homologación o producción): si después se cambia de ambiente la automatización
--     NO sigue sola, hay que volver a encenderla (y «desde» se reinicia). Así lo probado en pruebas nunca factura de golpe en producción.
--   · «desde» se compara con la FECHA DE LA VENTA en Mercado Libre (no con la hora en que la orden entró al CRM): una venta vieja que llega tarde NO se factura sola.
--   · Lo que se factura o se anula sale de la misma base y de las mismas funciones que el botón (script 20 y 22): una factura por orden, una
--     nota total por factura, importe y receptor de la orden. Esta tabla solo decide CUÁNDO intentarlo y cuántas veces.
--   · Reintentos ACOTADOS: 5 min, 15 min, 1 h, 3 h y 12 h; al sexto fallo deja de intentar y queda en la lista de pendientes con su error.
--   · Una factura que quedó reservada o sin confirmar se sigue resolviendo aunque la orden ya esté cancelada (se concilia con ARCA con lo guardado).
--   · Cada falla y cada nota emitida deja un aviso visible en el CRM hasta que alguien lo marca como visto.
--
--  REQUISITOS: scripts 20 (comprobantes), 21 (control anual) y 22 (notas de crédito). Idempotente. No cambia ningún dato existente.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.meli_notas_credito') IS NULL OR to_regclass('public.meli_comprobantes') IS NULL
     OR to_regprocedure('public.meli_secreto_ok(text)') IS NULL OR to_regprocedure('public.is_authorized_user()') IS NULL THEN
    RAISE EXCEPTION 'Faltan los scripts 20, 21 y 22. Correrlos antes que este.';
  END IF;
END $$;

BEGIN;

CREATE TABLE IF NOT EXISTS public.arca_auto_config (
  id              SMALLINT    PRIMARY KEY CHECK (id = 1),
  factura_auto    BOOLEAN     NOT NULL DEFAULT FALSE,
  nota_auto       BOOLEAN     NOT NULL DEFAULT FALSE,
  desde           TIMESTAMPTZ,                       -- desde cuándo se factura sola (se fija al encender factura_auto)
  ambiente        TEXT        CHECK (ambiente IN ('homologacion', 'produccion')),   -- ambiente con el que se encendió; NULL = apagada
  actualizado_por TEXT,
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.arca_auto_config ADD COLUMN IF NOT EXISTS ambiente TEXT CHECK (ambiente IN ('homologacion', 'produccion'));
INSERT INTO public.arca_auto_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.arca_auto_config_historial (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  factura_auto  BOOLEAN NOT NULL, nota_auto BOOLEAN NOT NULL, desde TIMESTAMPTZ, ambiente TEXT,
  cambiado_por  TEXT NOT NULL, creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.arca_auto_config_historial ADD COLUMN IF NOT EXISTS ambiente TEXT;

CREATE TABLE IF NOT EXISTS public.arca_auto_intentos (
  orden_id        TEXT        NOT NULL,
  tipo            TEXT        NOT NULL CHECK (tipo IN ('factura', 'nota')),
  ambiente        TEXT        NOT NULL CHECK (ambiente IN ('homologacion', 'produccion')),
  intentos        INTEGER     NOT NULL DEFAULT 0,
  proximo_intento TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_error    TEXT,
  resuelto_en     TIMESTAMPTZ,
  aviso           TEXT        CHECK (aviso IN ('nota_emitida', 'nota_emitida_venta_procesada', 'fallo')),
  aviso_visto     BOOLEAN     NOT NULL DEFAULT FALSE,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (orden_id, tipo, ambiente)
);
CREATE INDEX IF NOT EXISTS arca_auto_intentos_abiertos ON public.arca_auto_intentos (ambiente, proximo_intento) WHERE resuelto_en IS NULL;

CREATE OR REPLACE FUNCTION public.arca__auto_historial_proteger()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'HISTORIAL_INMUTABLE' USING ERRCODE = '42501'; END $$;
DROP TRIGGER IF EXISTS arca_auto_historial_proteger_tg ON public.arca_auto_config_historial;
CREATE TRIGGER arca_auto_historial_proteger_tg BEFORE UPDATE OR DELETE ON public.arca_auto_config_historial FOR EACH ROW EXECUTE FUNCTION public.arca__auto_historial_proteger();
DROP TRIGGER IF EXISTS arca_auto_historial_truncate_tg ON public.arca_auto_config_historial;
CREATE TRIGGER arca_auto_historial_truncate_tg BEFORE TRUNCATE ON public.arca_auto_config_historial FOR EACH STATEMENT EXECUTE FUNCTION public.arca__auto_historial_proteger();

ALTER TABLE public.arca_auto_config           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arca_auto_config_historial ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arca_auto_intentos         ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS arca_auto_config_leer ON public.arca_auto_config;
CREATE POLICY arca_auto_config_leer ON public.arca_auto_config FOR SELECT TO authenticated USING (public.is_authorized_user());
DROP POLICY IF EXISTS arca_auto_historial_leer ON public.arca_auto_config_historial;
CREATE POLICY arca_auto_historial_leer ON public.arca_auto_config_historial FOR SELECT TO authenticated USING (public.is_authorized_user());
DROP POLICY IF EXISTS arca_auto_intentos_leer ON public.arca_auto_intentos;
CREATE POLICY arca_auto_intentos_leer ON public.arca_auto_intentos FOR SELECT TO authenticated USING (public.is_authorized_user());
REVOKE ALL ON TABLE public.arca_auto_config, public.arca_auto_config_historial, public.arca_auto_intentos FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.arca_auto_config, public.arca_auto_config_historial, public.arca_auto_intentos TO authenticated;
REVOKE ALL ON FUNCTION public.arca__auto_historial_proteger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.arca_auto_config_historial_id_seq FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON TABLE public.arca_auto_config, public.arca_auto_config_historial, public.arca_auto_intentos FROM service_role;
    REVOKE ALL ON FUNCTION public.arca__auto_historial_proteger() FROM service_role;
    REVOKE ALL ON SEQUENCE public.arca_auto_config_historial_id_seq FROM service_role;
  END IF;
END $$;

-- ── Interruptores: los cambia una persona autorizada ───────────────────────
DROP FUNCTION IF EXISTS public.arca_auto_config_guardar(BOOLEAN, BOOLEAN);
DROP FUNCTION IF EXISTS public.arca_auto_config_guardar(BOOLEAN, BOOLEAN, TEXT);
-- p_ambiente: el ambiente con el que el servidor está corriendo AHORA (la pantalla lo pregunta). Obligatorio si se enciende algo.
CREATE FUNCTION public.arca_auto_config_guardar(p_factura BOOLEAN, p_nota BOOLEAN, p_ambiente TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_old public.arca_auto_config%ROWTYPE; v_quien TEXT := COALESCE(NULLIF(auth.jwt() ->> 'email', ''), 'desconocido'); v_desde TIMESTAMPTZ; v_amb TEXT;
BEGIN
  IF public.is_authorized_user() IS NOT TRUE THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  IF p_factura IS NULL OR p_nota IS NULL THEN RAISE EXCEPTION 'VALOR_INVALIDO'; END IF;
  IF (p_factura OR p_nota) AND (p_ambiente IS NULL OR p_ambiente NOT IN ('homologacion', 'produccion')) THEN RAISE EXCEPTION 'AMBIENTE_INVALIDO'; END IF;
  SELECT * INTO v_old FROM public.arca_auto_config WHERE id = 1 FOR UPDATE;
  v_amb := CASE WHEN p_factura OR p_nota THEN p_ambiente ELSE NULL END;
  IF v_old.factura_auto = p_factura AND v_old.nota_auto = p_nota AND v_old.ambiente IS NOT DISTINCT FROM v_amb THEN RETURN jsonb_build_object('ok', TRUE, 'sin_cambios', TRUE); END IF;
  -- «desde»: al ENCENDER la factura automática (o al cambiar de ambiente estando encendida) se fija la fecha; solo se facturan solas las ventas posteriores.
  v_desde := CASE WHEN p_factura AND (NOT v_old.factura_auto OR v_old.ambiente IS DISTINCT FROM v_amb) THEN now() WHEN p_factura THEN v_old.desde ELSE v_old.desde END;
  UPDATE public.arca_auto_config SET factura_auto = p_factura, nota_auto = p_nota, desde = v_desde, ambiente = v_amb, actualizado_por = v_quien, actualizado_en = now() WHERE id = 1;
  INSERT INTO public.arca_auto_config_historial (factura_auto, nota_auto, desde, ambiente, cambiado_por) VALUES (p_factura, p_nota, v_desde, v_amb, v_quien);
  RETURN jsonb_build_object('ok', TRUE);
END $$;

-- ── Funciones del servidor (con el secreto compartido) ─────────────────────
DROP FUNCTION IF EXISTS public.arca_auto_config(TEXT);
CREATE FUNCTION public.arca_auto_config(p_secreto TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.arca_auto_config%ROWTYPE;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  SELECT * INTO c FROM public.arca_auto_config WHERE id = 1;
  RETURN jsonb_build_object('factura_auto', c.factura_auto, 'nota_auto', c.nota_auto, 'desde', c.desde, 'ambiente', c.ambiente);
END $$;

-- Reclama un trabajo por 3 minutos de forma EXCLUSIVA: devuelve TRUE solo a quien lo logra. El INSERT ... ON CONFLICT serializa a los que llegan a la vez y el
-- WHERE de la actualización se evalúa contra la fila ya reclamada por el ganador, así que el segundo recibe FALSE. Dos corridas nunca atienden lo mismo.
DROP FUNCTION IF EXISTS public.arca__auto_reclamar(TEXT, TEXT, TEXT);
CREATE FUNCTION public.arca__auto_reclamar(p_orden TEXT, p_tipo TEXT, p_ambiente TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n INTEGER;
BEGIN
  INSERT INTO public.arca_auto_intentos AS i (orden_id, tipo, ambiente, proximo_intento) VALUES (p_orden, p_tipo, p_ambiente, now() + interval '3 minutes')
  ON CONFLICT (orden_id, tipo, ambiente) DO UPDATE SET proximo_intento = now() + interval '3 minutes', actualizado_en = now()
   WHERE i.resuelto_en IS NULL AND i.intentos < 6 AND i.proximo_intento <= now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;
REVOKE ALL ON FUNCTION public.arca__auto_reclamar(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- Qué hay para hacer ahora (máximo p_limite), RECLAMADO para esta corrida. Orden: 1) facturas reservadas sin confirmar (se concilian aunque la orden ya esté
-- cancelada), 2) notas de crédito (reservadas sin confirmar y nuevas por cancelación), 3) notas ya autorizadas cuyo aviso no se registró, 4) facturas
-- nuevas de ventas PAGADAS cuya FECHA DE VENTA es posterior al encendido. Solo para el ambiente con el que se encendió.
DROP FUNCTION IF EXISTS public.arca_auto_candidatos(TEXT, TEXT, INTEGER);
CREATE FUNCTION public.arca_auto_candidatos(p_secreto TEXT, p_ambiente TEXT, p_limite INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cfg public.arca_auto_config%ROWTYPE; v_res JSONB := '[]'::jsonb; v_n INTEGER := 0; r RECORD;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF p_ambiente NOT IN ('homologacion', 'produccion') THEN RAISE EXCEPTION 'AMBIENTE_INVALIDO'; END IF;
  IF p_limite IS NULL OR p_limite NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'LIMITE_INVALIDO'; END IF;
  SELECT * INTO cfg FROM public.arca_auto_config WHERE id = 1;
  -- Encendida para OTRO ambiente: no se hace nada hasta volver a encenderla en este.
  IF cfg.ambiente IS DISTINCT FROM p_ambiente THEN RETURN v_res; END IF;

  IF cfg.factura_auto THEN
    FOR r IN SELECT c.orden_id FROM public.meli_comprobantes c
              WHERE c.ambiente = p_ambiente AND c.estado = 'reservado' AND (c.trabajo_hasta IS NULL OR c.trabajo_hasta < now() - interval '8 minutes')
                AND NOT EXISTS (SELECT 1 FROM public.arca_auto_intentos i WHERE i.orden_id = c.orden_id AND i.tipo = 'factura' AND i.ambiente = p_ambiente
                                  AND i.resuelto_en IS NULL AND (i.intentos >= 6 OR i.proximo_intento > now()))
              ORDER BY c.creado_en LIMIT p_limite - v_n FOR UPDATE OF c SKIP LOCKED LOOP
      IF public.arca__auto_reclamar(r.orden_id, 'factura', p_ambiente) THEN
        v_res := v_res || jsonb_build_array(jsonb_build_object('orden', r.orden_id, 'tipo', 'factura')); v_n := v_n + 1;
      END IF;
    END LOOP;
  END IF;

  IF cfg.nota_auto AND v_n < p_limite THEN
    FOR r IN SELECT c.orden_id FROM public.meli_comprobantes c JOIN public.meli_ordenes o ON o.meli_order_id = c.orden_id
              LEFT JOIN public.meli_notas_credito n ON n.comprobante_id = c.id
              WHERE c.ambiente = p_ambiente AND c.estado = 'autorizado'
                AND ((o.estado = 'cancelled' AND (n.id IS NULL OR n.estado = 'rechazado')) OR (n.estado = 'reservado' AND (n.trabajo_hasta IS NULL OR n.trabajo_hasta < now() - interval '8 minutes')))
                AND NOT EXISTS (SELECT 1 FROM public.arca_auto_intentos i WHERE i.orden_id = c.orden_id AND i.tipo = 'nota' AND i.ambiente = p_ambiente
                                  AND i.resuelto_en IS NULL AND (i.intentos >= 6 OR i.proximo_intento > now()))
              ORDER BY c.creado_en LIMIT p_limite - v_n FOR UPDATE OF c SKIP LOCKED LOOP
      IF public.arca__auto_reclamar(r.orden_id, 'nota', p_ambiente) THEN
        v_res := v_res || jsonb_build_array(jsonb_build_object('orden', r.orden_id, 'tipo', 'nota')); v_n := v_n + 1;
      END IF;
    END LOOP;
  END IF;

  -- Notas AUTOMÁTICAS ya autorizadas cuyo resultado (y el aviso de revertir la venta) no llegó a anotarse: se completa el registro, sin emitir nada.
  IF cfg.nota_auto AND v_n < p_limite THEN
    FOR r IN SELECT n.orden_id FROM public.meli_notas_credito n
              WHERE n.ambiente = p_ambiente AND n.estado = 'autorizado' AND (n.creado_por LIKE 'automático%' OR n.ultimo_solicitante LIKE 'automático%')
                AND NOT EXISTS (SELECT 1 FROM public.arca_auto_intentos i WHERE i.orden_id = n.orden_id AND i.tipo = 'nota' AND i.ambiente = p_ambiente AND i.resuelto_en IS NOT NULL)
                AND NOT EXISTS (SELECT 1 FROM public.arca_auto_intentos i WHERE i.orden_id = n.orden_id AND i.tipo = 'nota' AND i.ambiente = p_ambiente AND i.resuelto_en IS NULL AND i.proximo_intento > now())
              ORDER BY n.creado_en LIMIT p_limite - v_n LOOP
      IF public.arca__auto_reclamar(r.orden_id, 'nota', p_ambiente) THEN
        v_res := v_res || jsonb_build_array(jsonb_build_object('orden', r.orden_id, 'tipo', 'registro')); v_n := v_n + 1;
      END IF;
    END LOOP;
  END IF;

  IF cfg.factura_auto AND cfg.desde IS NOT NULL AND v_n < p_limite THEN
    FOR r IN SELECT o.meli_order_id FROM public.meli_ordenes o
              WHERE o.estado = 'paid' AND COALESCE(o.moneda, 'ARS') = 'ARS' AND o.bruto > 0 AND COALESCE(o.fecha_orden, o.creado_en) >= cfg.desde
                AND NOT EXISTS (SELECT 1 FROM public.meli_comprobantes c WHERE c.orden_id = o.meli_order_id AND c.ambiente = p_ambiente AND c.estado IN ('reservado', 'autorizado'))
                AND NOT EXISTS (SELECT 1 FROM public.meli_facturas f WHERE f.orden_id = o.meli_order_id AND f.estado IN ('emitida', 'no_corresponde'))
                AND NOT EXISTS (SELECT 1 FROM public.arca_auto_intentos i WHERE i.orden_id = o.meli_order_id AND i.tipo = 'factura' AND i.ambiente = p_ambiente
                                  AND i.resuelto_en IS NULL AND (i.intentos >= 6 OR i.proximo_intento > now()))
                AND NOT EXISTS (SELECT 1 FROM public.arca_auto_intentos i WHERE i.orden_id = o.meli_order_id AND i.tipo = 'factura' AND i.ambiente = p_ambiente AND i.resuelto_en IS NOT NULL)
              ORDER BY COALESCE(o.fecha_orden, o.creado_en) LIMIT p_limite - v_n LOOP
      IF public.arca__auto_reclamar(r.meli_order_id, 'factura', p_ambiente) THEN
        v_res := v_res || jsonb_build_array(jsonb_build_object('orden', r.meli_order_id, 'tipo', 'factura')); v_n := v_n + 1;
      END IF;
    END LOOP;
  END IF;
  RETURN v_res;
END $$;

-- ── Reservas AUTOMÁTICAS: comprueban, en la MISMA transacción que reserva el número, que la automatización sigue encendida para este ambiente y que la
-- venta sigue siendo elegible (factura: pagada y de fecha posterior al encendido; nota: cancelada). Si no, AUTO_NO_ELEGIBLE y no se escribe nada.
DROP FUNCTION IF EXISTS public.arca_auto_reservar_factura(TEXT, TEXT, TEXT, INTEGER, INTEGER, BIGINT, INTEGER, TEXT, INTEGER);
CREATE FUNCTION public.arca_auto_reservar_factura(p_secreto TEXT, p_orden TEXT, p_ambiente TEXT, p_pto_venta INTEGER, p_ultimo_arca INTEGER,
  p_importe_centavos BIGINT, p_doc_tipo INTEGER, p_doc_nro TEXT, p_cond_iva INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cfg public.arca_auto_config%ROWTYPE; o public.meli_ordenes%ROWTYPE;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('orden|' || p_orden, 0));
  SELECT * INTO cfg FROM public.arca_auto_config WHERE id = 1 FOR SHARE;
  SELECT * INTO o FROM public.meli_ordenes WHERE meli_order_id = p_orden FOR SHARE;
  IF NOT FOUND OR NOT cfg.factura_auto OR cfg.ambiente IS DISTINCT FROM p_ambiente OR cfg.desde IS NULL
     OR o.estado IS DISTINCT FROM 'paid' OR COALESCE(o.fecha_orden, o.creado_en) < cfg.desde THEN
    RAISE EXCEPTION 'AUTO_NO_ELEGIBLE';
  END IF;
  RETURN public.arca_comprobante_reservar(p_secreto, p_orden, p_ambiente, p_pto_venta, p_ultimo_arca, p_importe_centavos, p_doc_tipo, p_doc_nro, p_cond_iva);
END $$;

DROP FUNCTION IF EXISTS public.arca_auto_reservar_nota(TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT);
CREATE FUNCTION public.arca_auto_reservar_nota(p_secreto TEXT, p_orden TEXT, p_ambiente TEXT, p_pto_venta INTEGER, p_ultimo_arca INTEGER, p_motivo TEXT, p_usuario TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cfg public.arca_auto_config%ROWTYPE; o public.meli_ordenes%ROWTYPE;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('orden|' || p_orden, 0));
  SELECT * INTO cfg FROM public.arca_auto_config WHERE id = 1 FOR SHARE;
  SELECT * INTO o FROM public.meli_ordenes WHERE meli_order_id = p_orden FOR SHARE;
  IF NOT FOUND OR NOT cfg.nota_auto OR cfg.ambiente IS DISTINCT FROM p_ambiente OR o.estado IS DISTINCT FROM 'cancelled' OR p_motivo IS DISTINCT FROM 'cancelacion' THEN
    RAISE EXCEPTION 'AUTO_NO_ELEGIBLE';
  END IF;
  RETURN public.arca_nc_reservar(p_secreto, p_orden, p_ambiente, p_pto_venta, p_ultimo_arca, p_motivo, p_usuario);
END $$;

-- Anota el resultado de un intento. p_estado: 'emitida' | 'en_curso' | 'pendiente_verificar' | 'rechazada' | 'error'. Reintentos acotados.
DROP FUNCTION IF EXISTS public.arca_auto_registrar(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION public.arca_auto_registrar(p_secreto TEXT, p_orden TEXT, p_tipo TEXT, p_ambiente TEXT, p_estado TEXT, p_error TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v public.arca_auto_intentos%ROWTYPE; v_proc BOOLEAN; v_aviso TEXT; v_espera INTERVAL;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF p_tipo NOT IN ('factura', 'nota') OR p_ambiente NOT IN ('homologacion', 'produccion') THEN RAISE EXCEPTION 'DATOS_INVALIDOS'; END IF;
  IF p_estado NOT IN ('emitida', 'en_curso', 'pendiente_verificar', 'rechazada', 'error') THEN RAISE EXCEPTION 'ESTADO_INVALIDO'; END IF;
  INSERT INTO public.arca_auto_intentos (orden_id, tipo, ambiente) VALUES (p_orden, p_tipo, p_ambiente) ON CONFLICT DO NOTHING;
  SELECT * INTO v FROM public.arca_auto_intentos WHERE orden_id = p_orden AND tipo = p_tipo AND ambiente = p_ambiente FOR UPDATE;
  IF v.resuelto_en IS NOT NULL THEN RETURN jsonb_build_object('estado', 'ya_resuelto'); END IF;

  IF p_estado = 'emitida' THEN
    SELECT COALESCE(procesada, FALSE) INTO v_proc FROM public.meli_ordenes WHERE meli_order_id = p_orden;
    v_aviso := CASE WHEN p_tipo = 'nota' AND v_proc THEN 'nota_emitida_venta_procesada' WHEN p_tipo = 'nota' THEN 'nota_emitida' ELSE NULL END;
    UPDATE public.arca_auto_intentos SET resuelto_en = now(), ultimo_error = NULL, aviso = v_aviso, aviso_visto = (v_aviso IS NULL), actualizado_en = now()
     WHERE orden_id = p_orden AND tipo = p_tipo AND ambiente = p_ambiente;
    RETURN jsonb_build_object('estado', 'resuelto', 'aviso', v_aviso);
  END IF;

  -- «en curso» (otro proceso la está resolviendo) no cuenta como falla: se vuelve a mirar en 5 minutos.
  IF p_estado = 'en_curso' THEN
    UPDATE public.arca_auto_intentos SET proximo_intento = now() + interval '5 minutes', actualizado_en = now() WHERE orden_id = p_orden AND tipo = p_tipo AND ambiente = p_ambiente;
    RETURN jsonb_build_object('estado', 'en_curso');
  END IF;

  v_espera := CASE v.intentos WHEN 0 THEN interval '5 minutes' WHEN 1 THEN interval '15 minutes' WHEN 2 THEN interval '1 hour' WHEN 3 THEN interval '3 hours' ELSE interval '12 hours' END;
  UPDATE public.arca_auto_intentos SET intentos = v.intentos + 1, proximo_intento = now() + v_espera, ultimo_error = left(COALESCE(p_error, p_estado), 300),
         aviso = CASE WHEN v.intentos + 1 >= 6 THEN 'fallo' ELSE aviso END, aviso_visto = CASE WHEN v.intentos + 1 >= 6 THEN FALSE ELSE aviso_visto END, actualizado_en = now()
   WHERE orden_id = p_orden AND tipo = p_tipo AND ambiente = p_ambiente;
  RETURN jsonb_build_object('estado', CASE WHEN v.intentos + 1 >= 6 THEN 'sin_mas_intentos' ELSE 'reintentara' END, 'intentos', v.intentos + 1);
END $$;

-- ── Lo que ve el CRM: interruptores, pendientes que fallaron y avisos sin ver ──
DROP FUNCTION IF EXISTS public.arca_auto_estado();
CREATE FUNCTION public.arca_auto_estado()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.arca_auto_config%ROWTYPE;
BEGIN
  IF public.is_authorized_user() IS NOT TRUE THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.arca_auto_config WHERE id = 1;
  RETURN jsonb_build_object('factura_auto', c.factura_auto, 'nota_auto', c.nota_auto, 'desde', c.desde, 'ambiente', c.ambiente, 'actualizado_por', c.actualizado_por,
    'pendientes', COALESCE((SELECT jsonb_agg(jsonb_build_object('orden', i.orden_id, 'tipo', i.tipo, 'ambiente', i.ambiente, 'intentos', i.intentos, 'error', i.ultimo_error,
                                                               'sin_mas_intentos', i.intentos >= 6) ORDER BY i.actualizado_en DESC)
                              FROM public.arca_auto_intentos i WHERE i.resuelto_en IS NULL AND i.intentos > 0), '[]'::jsonb),
    'avisos', COALESCE((SELECT jsonb_agg(jsonb_build_object('orden', i.orden_id, 'tipo', i.tipo, 'ambiente', i.ambiente, 'aviso', i.aviso, 'error', i.ultimo_error, 'en', i.actualizado_en) ORDER BY i.actualizado_en DESC)
                          FROM public.arca_auto_intentos i WHERE i.aviso IS NOT NULL AND NOT i.aviso_visto), '[]'::jsonb));
END $$;

DROP FUNCTION IF EXISTS public.arca_auto_aviso_visto(TEXT, TEXT, TEXT);
CREATE FUNCTION public.arca_auto_aviso_visto(p_orden TEXT, p_tipo TEXT, p_ambiente TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF public.is_authorized_user() IS NOT TRUE THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  UPDATE public.arca_auto_intentos SET aviso_visto = TRUE, actualizado_en = now() WHERE orden_id = p_orden AND tipo = p_tipo AND ambiente = p_ambiente AND aviso IS NOT NULL;
  RETURN jsonb_build_object('ok', TRUE);
END $$;

REVOKE ALL ON FUNCTION public.arca_auto_config(TEXT), public.arca_auto_candidatos(TEXT, TEXT, INTEGER), public.arca_auto_registrar(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT),
  public.arca_auto_config_guardar(BOOLEAN, BOOLEAN, TEXT), public.arca_auto_estado(), public.arca_auto_aviso_visto(TEXT, TEXT, TEXT),
  public.arca_auto_reservar_factura(TEXT, TEXT, TEXT, INTEGER, INTEGER, BIGINT, INTEGER, TEXT, INTEGER), public.arca_auto_reservar_nota(TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arca_auto_config(TEXT), public.arca_auto_candidatos(TEXT, TEXT, INTEGER), public.arca_auto_registrar(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT),
  public.arca_auto_reservar_factura(TEXT, TEXT, TEXT, INTEGER, INTEGER, BIGINT, INTEGER, TEXT, INTEGER), public.arca_auto_reservar_nota(TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arca_auto_config_guardar(BOOLEAN, BOOLEAN, TEXT), public.arca_auto_estado(), public.arca_auto_aviso_visto(TEXT, TEXT, TEXT) TO authenticated;

COMMIT;

-- Verificación (solo lectura): tiene que dar dos filas con ✅.
SELECT 'tablas y funciones' AS control,
       CASE WHEN to_regclass('public.arca_auto_config') IS NOT NULL AND to_regclass('public.arca_auto_intentos') IS NOT NULL
             AND to_regprocedure('public.arca_auto_candidatos(text,text,integer)') IS NOT NULL THEN '✅' ELSE '❌' END AS resultado
UNION ALL
SELECT 'interruptores apagados y cerradas al navegador',
       CASE WHEN (SELECT NOT factura_auto AND NOT nota_auto FROM public.arca_auto_config WHERE id = 1)
             AND NOT has_table_privilege('anon', 'public.arca_auto_intentos', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.arca_auto_config', 'UPDATE') THEN '✅' ELSE '❌' END;
