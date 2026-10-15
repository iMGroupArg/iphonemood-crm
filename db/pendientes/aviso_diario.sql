-- ============================================================================
--  aviso_diario.sql  (script 17) — EMAIL DIARIO: lo que se libera hoy, lo liberado sin confirmar y las transferencias pendientes
--
--  QUÉ HACE: da a la función diaria del servidor (cron de Vercel) lo mínimo para mandar UN email por día:
--   · aviso_diario_resumen    → SOLO números agregados (cantidades e importes) de las órdenes de Mercado Libre y de las
--                               actividades de transferencia. Nada de compradores, productos ni números de orden.
--   · aviso_diario_reclamar   → «reclama» el día (o el intento de prueba): solo quien reclama envía. Guarda una INSTANTÁNEA
--                               del mensaje: si hace falta reintentar, se manda exactamente lo mismo.
--   · aviso_diario_confirmar / aviso_diario_fallo → cierran el intento; los dos exigen el `lease_id` del reclamo.
--  Estados del día: reclamado (con vencimiento de 10 min) → enviado (terminal) | fallido (rechazo definitivo) | incierto
--  (se cortó, o «aceptado pero no se pudo confirmar»: solo un incierto se reintenta, con la MISMA instantánea).
--  Cuotas en la base (no dependen de la instancia del servidor): máximo 5 intentos por día para el aviso diario y 3 para
--  la prueba, con 2 minutos entre intentos.
--
--  SEGURIDAD: todas las funciones validan el secreto compartido (meli_secreto_ok) ANTES de leer o escribir; la tabla no es
--  accesible para anon ni authenticated. El secreto compartido es el mismo de todas las funciones de Mercado Libre: quien lo
--  tenga puede llamarlas (incluidas las de tokens): rotarlo = cambiar MELI_RPC_SECRET en Vercel y su hash en meli_config.
--
--  REQUISITOS: scripts 3, 4, 12 y 15 corridos. Idempotente. No cambia ningún dato existente.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.meli_ordenes') IS NULL OR to_regprocedure('public.meli_secreto_ok(text)') IS NULL
     OR to_regclass('public.actividades') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'meli_ordenes' AND column_name = 'cerrada_manual_en') THEN
    RAISE EXCEPTION 'Faltan los scripts 3, 4, 12 y/o 15 (meli_esquema_base, meli_ventas_migration, meli_cerrar_manual, actividades). Correrlos antes que este.';
  END IF;
END $$;

BEGIN;

-- ── 1 · Tabla ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.aviso_diario_envios (
  dia            DATE        NOT NULL,
  tipo           TEXT        NOT NULL,
  estado         TEXT        NOT NULL DEFAULT 'reclamado',
  lease_id       UUID,
  lease_vence    TIMESTAMPTZ,
  asunto         TEXT,
  cuerpo_texto   TEXT,
  cuerpo_html    TEXT,
  clave_idem     TEXT,
  clave_desde    TIMESTAMPTZ,   -- cuándo empezó a valer la clave de idempotencia (Resend la conserva 24 h)
  sobre_hash     TEXT,          -- huella del remitente+destinatario con que se armó el pedido (nunca la dirección)
  resend_id      TEXT,
  intentos       INTEGER     NOT NULL DEFAULT 0,
  ultimo_intento TIMESTAMPTZ,
  motivo         TEXT,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  enviado_en     TIMESTAMPTZ,
  PRIMARY KEY (dia, tipo),
  CONSTRAINT aviso_diario_tipo_ck   CHECK (tipo IN ('diario', 'prueba')),
  CONSTRAINT aviso_diario_estado_ck CHECK (estado IN ('reclamado', 'enviado', 'fallido', 'incierto')),
  CONSTRAINT aviso_diario_motivo_ck CHECK (motivo IS NULL OR motivo ~ '^[A-Z0-9_]{1,30}$'),
  CONSTRAINT aviso_diario_enviado_ck CHECK (estado <> 'enviado' OR enviado_en IS NOT NULL)
);
ALTER TABLE public.aviso_diario_envios ADD COLUMN IF NOT EXISTS clave_desde TIMESTAMPTZ;
ALTER TABLE public.aviso_diario_envios ADD COLUMN IF NOT EXISTS sobre_hash TEXT;
ALTER TABLE public.aviso_diario_envios ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.aviso_diario_envios FROM PUBLIC, anon, authenticated;

-- ── 2 · Resumen: SOLO agregados ─────────────────────────────────────────────
-- p_dia es el día de Argentina («hoy»). «Candidata» = procesada, sin acreditar, sin revertir, no cerrada a mano, sin
-- revisar, con los importes confirmados y neto > 0.
CREATE OR REPLACE FUNCTION public.aviso_diario_resumen(p_secreto TEXT, p_dia DATE)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_hoy  DATE := (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
  r      JSONB;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF p_dia IS NULL OR p_dia < v_hoy - 1 OR p_dia > v_hoy THEN RAISE EXCEPTION 'DIA_INVALIDO'; END IF;
  SELECT jsonb_build_object(
    'dia', p_dia,
    'liberan_hoy', jsonb_build_object(
      'ordenes', count(*) FILTER (WHERE c.dia_lib = p_dia),
      'monto',   COALESCE(sum(c.neto) FILTER (WHERE c.dia_lib = p_dia), 0)),
    'sin_confirmar', jsonb_build_object(
      'ordenes', count(*) FILTER (WHERE c.dia_lib < p_dia),
      'monto',   COALESCE(sum(c.neto) FILTER (WHERE c.dia_lib < p_dia), 0))
  ) INTO r
  FROM (
    SELECT o.neto, (o.fecha_liberacion AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS dia_lib
      FROM public.meli_ordenes o
     WHERE o.procesada AND NOT o.acreditado AND o.revertida_en IS NULL AND o.cerrada_manual_en IS NULL
       AND NOT o.revisar AND o.financiera_completa AND o.neto IS NOT NULL AND o.neto > 0 AND o.fecha_liberacion IS NOT NULL
  ) c;
  r := r || jsonb_build_object(
    'transferencias', (SELECT jsonb_build_object('cantidad', count(*), 'monto', COALESCE(sum(a.monto), 0),
                                                 'mas_vieja', min(a.fecha_objetivo))
                         FROM public.actividades a WHERE a.tipo = 'meli_transferir' AND a.estado = 'pendiente'),
    'sin_procesar', (SELECT jsonb_build_object('ordenes', count(*))
                       FROM public.meli_ordenes o
                      WHERE NOT o.procesada AND o.revertida_en IS NULL AND o.cerrada_manual_en IS NULL AND NOT o.revisar
                        AND o.fecha_liberacion IS NOT NULL
                        AND (o.fecha_liberacion AT TIME ZONE 'America/Argentina/Buenos_Aires')::date <= p_dia));
  RETURN r;
END $$;

-- ── 3 · Reclamar el día (o la prueba) ───────────────────────────────────────
-- Devuelve {ok:true, lease_id, asunto, texto, html, clave, sobre_hash} con la instantánea a enviar (la nueva, o la guardada si
-- el intento anterior quedó incierto), o {ok:false, motivo} con YA_ENVIADO | EN_CURSO | ESPERAR | CUOTA | VENTANA_VENCIDA |
-- NADA_QUE_AVISAR. p_crear = FALSE («hoy no hay nada que decir»): solo recupera una instantánea ya guardada; nunca crea una.
-- Una instantánea con más de 23 h ya no está protegida por la clave de idempotencia de Resend: no se reenvía (VENTANA_VENCIDA).
DROP FUNCTION IF EXISTS public.aviso_diario_reclamar(TEXT, DATE, TEXT, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.aviso_diario_reclamar(
  p_secreto TEXT, p_dia DATE, p_tipo TEXT, p_asunto TEXT, p_texto TEXT, p_html TEXT,
  p_sobre_hash TEXT, p_crear BOOLEAN DEFAULT TRUE)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_hoy   DATE := (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
  v_max   INTEGER;
  e       public.aviso_diario_envios%ROWTYPE;
  v_lease UUID := gen_random_uuid();
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF p_tipo IS NULL OR p_tipo NOT IN ('diario', 'prueba') THEN RAISE EXCEPTION 'TIPO_INVALIDO'; END IF;
  IF p_dia IS NULL OR p_dia < v_hoy - 1 OR p_dia > v_hoy THEN RAISE EXCEPTION 'DIA_INVALIDO'; END IF;
  IF COALESCE(length(p_asunto), 0) NOT BETWEEN 1 AND 200 OR COALESCE(length(p_texto), 0) NOT BETWEEN 1 AND 4000
     OR COALESCE(length(p_html), 0) NOT BETWEEN 1 AND 8000 THEN RAISE EXCEPTION 'MENSAJE_INVALIDO'; END IF;
  IF p_sobre_hash IS NULL OR p_sobre_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'SOBRE_INVALIDO'; END IF;
  v_max := CASE p_tipo WHEN 'diario' THEN 5 ELSE 3 END;

  -- Con p_crear = FALSE no se crea nada: solo se mira lo que ya hay.
  IF NOT COALESCE(p_crear, TRUE) THEN
    SELECT * INTO e FROM public.aviso_diario_envios WHERE dia = p_dia AND tipo = p_tipo FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'motivo', 'NADA_QUE_AVISAR'); END IF;
  ELSE
    INSERT INTO public.aviso_diario_envios (dia, tipo, estado) VALUES (p_dia, p_tipo, 'fallido')
    ON CONFLICT (dia, tipo) DO NOTHING;
    SELECT * INTO e FROM public.aviso_diario_envios WHERE dia = p_dia AND tipo = p_tipo FOR UPDATE;
  END IF;

  IF e.estado = 'enviado' THEN RETURN jsonb_build_object('ok', false, 'motivo', 'YA_ENVIADO'); END IF;
  IF e.estado = 'reclamado' AND e.lease_vence > now() THEN RETURN jsonb_build_object('ok', false, 'motivo', 'EN_CURSO'); END IF;
  -- Sin nada que decir hoy solo tiene sentido recuperar una instantánea guardada de un intento que pudo haber salido.
  IF NOT COALESCE(p_crear, TRUE) AND NOT (e.estado IN ('incierto', 'reclamado') AND e.asunto IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'NADA_QUE_AVISAR');
  END IF;
  IF e.estado IN ('incierto', 'reclamado') AND e.asunto IS NOT NULL AND e.clave_desde IS NOT NULL AND e.clave_desde < now() - interval '23 hours' THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'VENTANA_VENCIDA');
  END IF;
  IF e.intentos >= v_max THEN RETURN jsonb_build_object('ok', false, 'motivo', 'CUOTA'); END IF;
  IF e.ultimo_intento IS NOT NULL AND e.ultimo_intento > now() - interval '2 minutes' THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'ESPERAR');
  END IF;

  -- Instantánea: un intento anterior que pudo haber llegado (incierto, o un reclamo vencido) se reenvía IGUAL con la
  -- MISMA clave de idempotencia; un rechazo definitivo (o el primer intento) usa el mensaje nuevo y una clave nueva.
  IF e.estado IN ('incierto', 'reclamado') AND e.asunto IS NOT NULL THEN
    UPDATE public.aviso_diario_envios
       SET estado = 'reclamado', lease_id = v_lease, lease_vence = now() + interval '10 minutes',
           intentos = intentos + 1, ultimo_intento = now(), motivo = NULL
     WHERE dia = p_dia AND tipo = p_tipo;
  ELSE
    UPDATE public.aviso_diario_envios
       SET estado = 'reclamado', lease_id = v_lease, lease_vence = now() + interval '10 minutes',
           asunto = p_asunto, cuerpo_texto = p_texto, cuerpo_html = p_html, sobre_hash = p_sobre_hash, clave_desde = now(),
           clave_idem = 'iphonemood-aviso-' || p_tipo || '-' || p_dia::text || '-' || (e.intentos + 1)::text,
           intentos = intentos + 1, ultimo_intento = now(), motivo = NULL
     WHERE dia = p_dia AND tipo = p_tipo;
  END IF;
  SELECT * INTO e FROM public.aviso_diario_envios WHERE dia = p_dia AND tipo = p_tipo;
  RETURN jsonb_build_object('ok', true, 'lease_id', v_lease, 'asunto', e.asunto, 'texto', e.cuerpo_texto,
                            'html', e.cuerpo_html, 'clave', e.clave_idem, 'intento', e.intentos, 'sobre_hash', e.sobre_hash);
END $$;

-- ── 4 · Cerrar el intento (con el lease) ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.aviso_diario_confirmar(p_secreto TEXT, p_dia DATE, p_tipo TEXT, p_lease UUID, p_resend_id TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE n INTEGER;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  UPDATE public.aviso_diario_envios
     SET estado = 'enviado', enviado_en = now(), lease_id = NULL, lease_vence = NULL, motivo = NULL,
         resend_id = CASE WHEN p_resend_id ~ '^[A-Za-z0-9_-]{1,100}$' THEN p_resend_id ELSE NULL END
   WHERE dia = p_dia AND tipo = p_tipo AND lease_id = p_lease AND estado = 'reclamado';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

-- p_definitivo = TRUE → 'fallido' (Resend rechazó: no se reintenta solo); FALSE → 'incierto' (se reintenta con lo mismo).
CREATE OR REPLACE FUNCTION public.aviso_diario_fallo(p_secreto TEXT, p_dia DATE, p_tipo TEXT, p_lease UUID, p_definitivo BOOLEAN, p_motivo TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE n INTEGER;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  UPDATE public.aviso_diario_envios
     SET estado = CASE WHEN p_definitivo THEN 'fallido' ELSE 'incierto' END, lease_id = NULL, lease_vence = NULL,
         motivo = CASE WHEN p_motivo ~ '^[A-Z0-9_]{1,30}$' THEN p_motivo ELSE 'DESCONOCIDO' END
   WHERE dia = p_dia AND tipo = p_tipo AND lease_id = p_lease AND estado = 'reclamado';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

-- ── 5 · Permisos (mismo patrón que el resto de las funciones con secreto) ───
REVOKE ALL ON FUNCTION public.aviso_diario_resumen(TEXT, DATE)                                     FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aviso_diario_reclamar(TEXT, DATE, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aviso_diario_confirmar(TEXT, DATE, TEXT, UUID, TEXT)                 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aviso_diario_fallo(TEXT, DATE, TEXT, UUID, BOOLEAN, TEXT)            FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aviso_diario_resumen(TEXT, DATE)                                  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aviso_diario_reclamar(TEXT, DATE, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aviso_diario_confirmar(TEXT, DATE, TEXT, UUID, TEXT)              TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aviso_diario_fallo(TEXT, DATE, TEXT, UUID, BOOLEAN, TEXT)         TO anon, authenticated;

COMMIT;

-- ============================================================================
--  VERIFICACIÓN (solo lectura; sale como tabla al final). Tiene que verse TODO en ✅.
-- ============================================================================
SELECT id, control, CASE WHEN ok THEN '✅' ELSE '❌' END AS resultado
FROM (
  SELECT '17.1' AS id, 'Existe la tabla aviso_diario_envios, con seguridad por filas' AS control,
         COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.aviso_diario_envios'::regclass), false) AS ok
  UNION ALL SELECT '17.2', 'Anon y authenticated NO pueden leer ni escribir la tabla',
         NOT has_table_privilege('anon', 'public.aviso_diario_envios', 'SELECT')
         AND NOT has_table_privilege('authenticated', 'public.aviso_diario_envios', 'SELECT')
         AND NOT has_table_privilege('anon', 'public.aviso_diario_envios', 'INSERT')
         AND NOT has_table_privilege('authenticated', 'public.aviso_diario_envios', 'UPDATE')
  UNION ALL SELECT '17.3', 'Existen las 4 funciones (resumen, reclamar, confirmar, fallo)',
         to_regprocedure('public.aviso_diario_resumen(text,date)') IS NOT NULL
         AND to_regprocedure('public.aviso_diario_reclamar(text,date,text,text,text,text,text,boolean)') IS NOT NULL
         AND to_regprocedure('public.aviso_diario_confirmar(text,date,text,uuid,text)') IS NOT NULL
         AND to_regprocedure('public.aviso_diario_fallo(text,date,text,uuid,boolean,text)') IS NOT NULL
  UNION ALL SELECT '17.4', 'Sin el secreto correcto las funciones rechazan el pedido (la clave pública sola no alcanza)',
         NOT public.meli_secreto_ok('un-secreto-que-no-es-el-real-0123456789')
) t
ORDER BY id;
