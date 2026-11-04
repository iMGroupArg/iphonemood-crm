-- ============================================================================
--  arca_atrasadas.sql — FACTURAS ATRASADAS: ponerse al día con las ventas de Mercado Libre que nunca se facturaron
--
--  QUÉ HACE: da al servidor y a la pantalla «Emitir facturas atrasadas» dos consultas:
--    · arca_atrasadas_resumen  (usuario autorizado): cuántas ventas hay por facturar en un rango de fechas, por cuánto y por mes. No cambia nada.
--    · arca_atrasadas_siguientes (solo el servidor, con la clave compartida): las próximas ventas a facturar, de la más vieja a la más nueva, y cuántas están bloqueadas.
--    · arca_atrasada_reservar (solo el servidor): reserva el número de UNA factura revalidando, bajo bloqueo, que la venta siga siendo elegible.
--  La emisión en sí usa las MISMAS funciones del botón «Factura» (script 20: una factura por orden, importe y receptor de la orden): esta consulta
--  solo decide QUÉ ventas toca emitir. No emite ni anula nada por sí sola.
--
--  QUÉ VENTAS ENTRAN: las PAGADAS de Mercado Libre, en pesos, dentro del rango de fechas de la venta (hora de Argentina), que
--    · no tienen factura autorizada ni en curso en ese ambiente,
--    · en producción, tampoco una factura cargada a mano ni la marca «no corresponde» (control de facturas),
--    · no están canceladas, revertidas, cerradas a mano ni «en revisión» (devoluciones, reclamos).
--  Las que quedaron rechazadas hace menos de 30 minutos y las que otro proceso está emitiendo ahora NO se vuelven a ofrecer (no se insiste en bucle).
--
--  REQUISITOS: scripts 16 (control de facturas), 20 (comprobantes) y 12 (cerrar a mano) y la función is_authorized_user(). Idempotente.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.meli_comprobantes') IS NULL OR to_regclass('public.meli_facturas') IS NULL OR to_regprocedure('public.is_authorized_user()') IS NULL THEN
    RAISE EXCEPTION 'Faltan los scripts 16 (meli_facturas) o 20 (arca_comprobantes) o is_authorized_user(). Correrlos antes que este.';
  END IF;
END $$;

BEGIN;

-- Cuántas ventas hay por facturar en el rango (fechas de la VENTA, hora de Argentina), por cuánto y por mes.
DROP FUNCTION IF EXISTS public.arca_atrasadas_resumen(DATE, DATE, TEXT);
CREATE FUNCTION public.arca_atrasadas_resumen(p_desde DATE, p_hasta DATE, p_ambiente TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_cant INTEGER; v_total BIGINT; v_meses JSONB;
BEGIN
  IF public.is_authorized_user() IS NOT TRUE THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  IF p_desde IS NULL OR p_hasta IS NULL OR p_desde > p_hasta OR p_hasta - p_desde > 800 THEN RAISE EXCEPTION 'RANGO_INVALIDO'; END IF;
  IF p_ambiente IS NULL OR p_ambiente NOT IN ('homologacion', 'produccion') THEN RAISE EXCEPTION 'AMBIENTE_INVALIDO'; END IF;

  SELECT count(*)::INTEGER, COALESCE(sum(round(o.bruto * 100)), 0)::BIGINT INTO v_cant, v_total
    FROM public.meli_ordenes o
   WHERE o.estado = 'paid' AND COALESCE(o.moneda, 'ARS') = 'ARS' AND o.bruto > 0
     AND o.revertida_en IS NULL AND o.cerrada_manual_en IS NULL AND o.revisar IS NOT TRUE
     AND (COALESCE(o.fecha_orden, o.creado_en) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN p_desde AND p_hasta
     AND NOT EXISTS (SELECT 1 FROM public.meli_comprobantes c WHERE c.orden_id = o.meli_order_id AND c.ambiente = p_ambiente AND c.estado IN ('autorizado', 'reservado'))
     AND (p_ambiente <> 'produccion' OR NOT EXISTS (SELECT 1 FROM public.meli_facturas f WHERE f.orden_id = o.meli_order_id AND f.estado IN ('emitida', 'no_corresponde')));

  SELECT COALESCE(jsonb_agg(jsonb_build_object('mes', m.mes, 'cantidad', m.cant, 'centavos', m.total) ORDER BY m.mes), '[]'::jsonb) INTO v_meses
    FROM (SELECT to_char((COALESCE(o.fecha_orden, o.creado_en) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM') AS mes, count(*)::INTEGER AS cant, sum(round(o.bruto * 100))::BIGINT AS total
            FROM public.meli_ordenes o
           WHERE o.estado = 'paid' AND COALESCE(o.moneda, 'ARS') = 'ARS' AND o.bruto > 0
             AND o.revertida_en IS NULL AND o.cerrada_manual_en IS NULL AND o.revisar IS NOT TRUE
             AND (COALESCE(o.fecha_orden, o.creado_en) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN p_desde AND p_hasta
             AND NOT EXISTS (SELECT 1 FROM public.meli_comprobantes c WHERE c.orden_id = o.meli_order_id AND c.ambiente = p_ambiente AND c.estado IN ('autorizado', 'reservado'))
             AND (p_ambiente <> 'produccion' OR NOT EXISTS (SELECT 1 FROM public.meli_facturas f WHERE f.orden_id = o.meli_order_id AND f.estado IN ('emitida', 'no_corresponde')))
           GROUP BY 1) m;
  RETURN jsonb_build_object('desde', p_desde, 'hasta', p_hasta, 'ambiente', p_ambiente, 'cantidad', v_cant, 'total_centavos', v_total, 'por_mes', v_meses);
END $$;

-- Las próximas ventas a facturar, de la más vieja a la más nueva (solo el servidor, con la clave compartida).
--   · `ordenes`: hasta p_limite ventas listas para emitir.  · `restantes`: cuántas faltan en total (sin contar las bloqueadas).
--   · `bloqueadas`: ventas del rango que TIENEN un problema reciente (factura reservada hace menos de 8 minutos por otro proceso, o rechazada hace menos
--     de 30): no se ofrecen para no insistir en bucle, pero se cuentan aparte para que el servidor DETENGA la corrida en vez de seguir como si nada.
DROP FUNCTION IF EXISTS public.arca_atrasadas_siguientes(TEXT, TEXT, DATE, DATE, INTEGER);
CREATE FUNCTION public.arca_atrasadas_siguientes(p_secreto TEXT, p_ambiente TEXT, p_desde DATE, p_hasta DATE, p_limite INTEGER)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ordenes JSONB; v_rest INTEGER; v_bloq INTEGER;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF p_desde IS NULL OR p_hasta IS NULL OR p_desde > p_hasta OR p_hasta - p_desde > 800 THEN RAISE EXCEPTION 'RANGO_INVALIDO'; END IF;
  IF p_ambiente IS NULL OR p_ambiente NOT IN ('homologacion', 'produccion') THEN RAISE EXCEPTION 'AMBIENTE_INVALIDO'; END IF;
  IF p_limite IS NULL OR p_limite NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'LIMITE_INVALIDO'; END IF;

  WITH base AS (
    SELECT o.meli_order_id, COALESCE(o.fecha_orden, o.creado_en) AS f, o.id,
           EXISTS (SELECT 1 FROM public.meli_comprobantes c WHERE c.orden_id = o.meli_order_id AND c.ambiente = p_ambiente AND (
                     (c.estado = 'reservado' AND c.trabajo_hasta IS NOT NULL AND c.trabajo_hasta >= now() - interval '8 minutes')
                  OR (c.estado = 'rechazado' AND c.actualizado_en > now() - interval '30 minutes'))) AS bloqueada
      FROM public.meli_ordenes o
     WHERE o.estado = 'paid' AND COALESCE(o.moneda, 'ARS') = 'ARS' AND o.bruto > 0
       AND o.revertida_en IS NULL AND o.cerrada_manual_en IS NULL AND o.revisar IS NOT TRUE
       AND (COALESCE(o.fecha_orden, o.creado_en) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN p_desde AND p_hasta
       AND NOT EXISTS (SELECT 1 FROM public.meli_comprobantes c WHERE c.orden_id = o.meli_order_id AND c.ambiente = p_ambiente AND c.estado = 'autorizado')
       AND (p_ambiente <> 'produccion' OR NOT EXISTS (SELECT 1 FROM public.meli_facturas f WHERE f.orden_id = o.meli_order_id AND f.estado IN ('emitida', 'no_corresponde')))
  )
  SELECT COALESCE((SELECT jsonb_agg(x.meli_order_id ORDER BY x.f, x.id) FROM (SELECT * FROM base WHERE NOT bloqueada ORDER BY f, id LIMIT p_limite) x), '[]'::jsonb),
         (SELECT count(*)::INTEGER FROM base WHERE NOT bloqueada),
         (SELECT count(*)::INTEGER FROM base WHERE bloqueada)
    INTO v_ordenes, v_rest, v_bloq;
  RETURN jsonb_build_object('ordenes', v_ordenes, 'restantes', v_rest, 'bloqueadas', v_bloq);
END $$;

-- Reserva el número de la factura de UNA venta, pero antes REVALIDA que siga siendo elegible para esta tanda (bajo el bloqueo de la orden): si mientras tanto
-- pasó a «en revisión», se revirtió, se cerró a mano, dejó de estar pagada o quedó fuera del rango, NO se emite. Después usa la misma reserva del botón «Factura».
DROP FUNCTION IF EXISTS public.arca_atrasada_reservar(TEXT, TEXT, TEXT, INTEGER, INTEGER, BIGINT, INTEGER, TEXT, INTEGER, DATE, DATE);
CREATE FUNCTION public.arca_atrasada_reservar(p_secreto TEXT, p_orden TEXT, p_ambiente TEXT, p_pto_venta INTEGER, p_ultimo_arca INTEGER, p_importe_centavos BIGINT,
                                              p_doc_tipo INTEGER, p_doc_nro TEXT, p_cond_iva INTEGER, p_desde DATE, p_hasta DATE)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o public.meli_ordenes%ROWTYPE;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF p_desde IS NULL OR p_hasta IS NULL OR p_desde > p_hasta THEN RAISE EXCEPTION 'RANGO_INVALIDO'; END IF;
  -- Mismo orden de bloqueos que arca_comprobante_reservar (primero la orden): los bloqueos de transacción se pueden repetir dentro de la misma transacción.
  PERFORM pg_advisory_xact_lock(hashtextextended('orden|' || p_orden, 0));
  SELECT * INTO o FROM public.meli_ordenes WHERE meli_order_id = p_orden FOR SHARE;
  IF NOT FOUND OR o.estado IS DISTINCT FROM 'paid' OR o.revertida_en IS NOT NULL OR o.cerrada_manual_en IS NOT NULL OR o.revisar IS TRUE
     OR (COALESCE(o.fecha_orden, o.creado_en) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date NOT BETWEEN p_desde AND p_hasta THEN
    RAISE EXCEPTION 'ATRASADA_NO_ELEGIBLE';
  END IF;
  RETURN public.arca_comprobante_reservar(p_secreto, p_orden, p_ambiente, p_pto_venta, p_ultimo_arca, p_importe_centavos, p_doc_tipo, p_doc_nro, p_cond_iva);
END $$;

REVOKE ALL ON FUNCTION public.arca_atrasadas_resumen(DATE, DATE, TEXT), public.arca_atrasadas_siguientes(TEXT, TEXT, DATE, DATE, INTEGER),
  public.arca_atrasada_reservar(TEXT, TEXT, TEXT, INTEGER, INTEGER, BIGINT, INTEGER, TEXT, INTEGER, DATE, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arca_atrasadas_resumen(DATE, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.arca_atrasadas_siguientes(TEXT, TEXT, DATE, DATE, INTEGER),
  public.arca_atrasada_reservar(TEXT, TEXT, TEXT, INTEGER, INTEGER, BIGINT, INTEGER, TEXT, INTEGER, DATE, DATE) TO anon, authenticated;

COMMIT;

-- Verificación (solo lectura): tiene que dar dos filas con ✅.
SELECT 'funciones creadas' AS control,
       CASE WHEN to_regprocedure('public.arca_atrasadas_resumen(date,date,text)') IS NOT NULL
             AND to_regprocedure('public.arca_atrasadas_siguientes(text,text,date,date,integer)') IS NOT NULL
             AND to_regprocedure('public.arca_atrasada_reservar(text,text,text,integer,integer,bigint,integer,text,integer,date,date)') IS NOT NULL THEN '✅' ELSE '❌' END AS resultado
UNION ALL
SELECT 'el resumen solo lo ve un usuario autorizado',
       CASE WHEN NOT has_function_privilege('anon', 'public.arca_atrasadas_resumen(date,date,text)', 'EXECUTE')
             AND has_function_privilege('authenticated', 'public.arca_atrasadas_resumen(date,date,text)', 'EXECUTE') THEN '✅' ELSE '❌' END;
