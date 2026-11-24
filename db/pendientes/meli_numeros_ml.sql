-- ════════════════════════════════════════════════════════════════════════════════════════
--  35_meli_numeros_ml.sql — el MISMO número de venta que muestra Mercado Libre
--
--  El CRM muestra «Orden 2000019701976556»; Mercado Libre muestra «#2000016191459325 | #48595749791». Verificado con una orden real:
--  el primero es el pack_id y el segundo el shipping.id. Este script agrega, en meli_ordenes, columnas NUEVAS y VACÍAS para guardarlos.
--
--  QUÉ HACE (nada se borra ni se renombra; meli_order_id sigue siendo LA clave y se sigue deduplicando por él):
--    · ml_pack_id, ml_shipment_id (TEXT, nullable, solo dígitos) y ml_numeros_leidos_en (cuándo se leyeron de Mercado Libre).
--    · Un índice para buscar por cada número.
--    · ml_shipment_id se completa ACÁ con lo que el CRM ya tenía guardado (payload_orden → shipping.id): sin llamar a Mercado Libre.
--    · meli_orden_ml_numeros_set: la usa el servidor para guardar pack y envío de UNA orden (solo estas 3 columnas; no toca stock,
--      facturas, caja ni la liquidación). meli_ordenes_sin_numeros: lista las órdenes que todavía no se leyeron (para completar las viejas).
--  No cambia ninguna función existente. Idempotente: se puede correr de nuevo.
--  REQUISITOS: script 3 (meli_ordenes, meli_secreto_ok).
-- ════════════════════════════════════════════════════════════════════════════════════════
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.meli_ordenes') IS NULL OR to_regprocedure('public.meli_secreto_ok(text)') IS NULL THEN
    RAISE EXCEPTION 'Falta el script 3 (meli_esquema_base): meli_ordenes o meli_secreto_ok(). Correrlo antes que este.';
  END IF;
END $$;

-- ── 1 · Columnas nuevas (todas nullable) ────────────────────────────────────────────────
ALTER TABLE public.meli_ordenes ADD COLUMN IF NOT EXISTS ml_pack_id TEXT;
ALTER TABLE public.meli_ordenes ADD COLUMN IF NOT EXISTS ml_shipment_id TEXT;
ALTER TABLE public.meli_ordenes ADD COLUMN IF NOT EXISTS ml_numeros_leidos_en TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meli_ordenes_ml_numeros_ck' AND conrelid = 'public.meli_ordenes'::regclass) THEN
    ALTER TABLE public.meli_ordenes ADD CONSTRAINT meli_ordenes_ml_numeros_ck
      CHECK ((ml_pack_id IS NULL OR ml_pack_id ~ '^[0-9]{1,20}$') AND (ml_shipment_id IS NULL OR ml_shipment_id ~ '^[0-9]{1,20}$'));
  END IF;
END $$;

-- ── 2 · Índices para buscar por cualquiera de los dos números ───────────────────────────────
CREATE INDEX IF NOT EXISTS meli_ordenes_ml_pack_idx     ON public.meli_ordenes (ml_pack_id)     WHERE ml_pack_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS meli_ordenes_ml_shipment_idx ON public.meli_ordenes (ml_shipment_id) WHERE ml_shipment_id IS NOT NULL;
-- Para listar rápido las que faltan leer.
CREATE INDEX IF NOT EXISTS meli_ordenes_ml_sin_leer_idx ON public.meli_ordenes (id DESC) WHERE ml_numeros_leidos_en IS NULL;

-- ── 3 · El envío ya estaba guardado en el detalle crudo de cada orden: se copia (solo donde está vacío y es un número) ──
UPDATE public.meli_ordenes
   SET ml_shipment_id = payload_orden -> 'shipping' ->> 'id'
 WHERE ml_shipment_id IS NULL
   AND payload_orden -> 'shipping' ->> 'id' ~ '^[0-9]{1,20}$';

-- ── 4 · Guardar pack y envío de UNA orden (la llama el servidor con el secreto) ────────────────
--  Solo toca las 3 columnas nuevas. Un valor NULL no borra uno ya guardado (COALESCE). Idempotente.
DROP FUNCTION IF EXISTS public.meli_orden_ml_numeros_set(TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION public.meli_orden_ml_numeros_set(p_secreto TEXT, p_orden_id TEXT, p_pack TEXT, p_envio TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_id BIGINT;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF p_orden_id IS NULL OR p_orden_id !~ '^[0-9]{1,20}$' THEN RAISE EXCEPTION 'ORDEN_INVALIDA'; END IF;
  IF p_pack  IS NOT NULL AND p_pack  !~ '^[0-9]{1,20}$' THEN RAISE EXCEPTION 'PACK_INVALIDO'; END IF;
  IF p_envio IS NOT NULL AND p_envio !~ '^[0-9]{1,20}$' THEN RAISE EXCEPTION 'ENVIO_INVALIDO'; END IF;

  UPDATE public.meli_ordenes
     SET ml_pack_id = COALESCE(p_pack, ml_pack_id),
         ml_shipment_id = COALESCE(p_envio, ml_shipment_id),
         ml_numeros_leidos_en = now()
   WHERE meli_order_id = p_orden_id
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN jsonb_build_object('ok', FALSE, 'motivo', 'ORDEN_INEXISTENTE'); END IF;
  RETURN jsonb_build_object('ok', TRUE, 'orden', p_orden_id);
END $$;

-- ── 5 · Qué órdenes todavía no se leyeron (para completar las viejas de a poco) ──────────────
DROP FUNCTION IF EXISTS public.meli_ordenes_sin_numeros(TEXT, INTEGER);
CREATE FUNCTION public.meli_ordenes_sin_numeros(p_secreto TEXT, p_limite INTEGER DEFAULT 20)
RETURNS TABLE (meli_order_id TEXT, cuenta_id BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  RETURN QUERY
    SELECT o.meli_order_id, o.cuenta_id FROM public.meli_ordenes o
     WHERE o.ml_numeros_leidos_en IS NULL
     ORDER BY o.id DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limite, 20), 1), 100);
END $$;

-- ── 6 · Permisos: los usa el servidor con la clave pública + el secreto (igual que el resto de la familia meli_*) ──
REVOKE ALL ON FUNCTION public.meli_orden_ml_numeros_set(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.meli_ordenes_sin_numeros(TEXT, INTEGER)           FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.meli_orden_ml_numeros_set(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.meli_ordenes_sin_numeros(TEXT, INTEGER)           TO anon, authenticated;

COMMIT;

-- ── Verificación: tienen que salir 4 filas con ✅ ──────────────────────────────────────────────
SELECT 'columnas nuevas' AS control,
       CASE WHEN (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'meli_ordenes'
                   AND column_name IN ('ml_pack_id', 'ml_shipment_id', 'ml_numeros_leidos_en')) = 3 THEN '✅' ELSE '❌' END AS resultado
UNION ALL
SELECT 'índices de búsqueda',
       CASE WHEN (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'meli_ordenes'
                   AND indexname IN ('meli_ordenes_ml_pack_idx', 'meli_ordenes_ml_shipment_idx', 'meli_ordenes_ml_sin_leer_idx')) = 3 THEN '✅' ELSE '❌' END
UNION ALL
SELECT 'funciones creadas',
       CASE WHEN to_regprocedure('public.meli_orden_ml_numeros_set(text,text,text,text)') IS NOT NULL
             AND to_regprocedure('public.meli_ordenes_sin_numeros(text,integer)') IS NOT NULL THEN '✅' ELSE '❌' END
UNION ALL
SELECT 'funciones cerradas a PUBLIC',
       CASE WHEN NOT has_function_privilege('public', 'public.meli_orden_ml_numeros_set(text,text,text,text)', 'EXECUTE')
             AND NOT has_function_privilege('public', 'public.meli_ordenes_sin_numeros(text,integer)', 'EXECUTE') THEN '✅' ELSE '❌' END;
