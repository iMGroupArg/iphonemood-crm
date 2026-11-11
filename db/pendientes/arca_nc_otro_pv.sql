-- Script 28: la nota de crédito se emite en el punto de venta CONFIGURADO y se asocia a la factura aunque sea de OTRO punto de venta
-- (por ejemplo, las facturas atrasadas del punto 4 se anulan con notas del punto 3). Antes la base rechazaba con PUNTO_DE_VENTA_DISTINTO.
-- Cambia 3 funciones (arca_nc_estado, arca_nc_conciliar_tomar, arca_nc_reservar). No toca datos. Idempotente. Requiere el script 22.
-- Las notas ya emitidas (todas en el punto de su factura) no cambian.

BEGIN;

-- Una nota RECHAZADA (sin número) puede reintentarse en otro punto de venta: es la única vez que se permite cambiarlo.
CREATE OR REPLACE FUNCTION public.arca__nc_proteger()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' THEN RAISE EXCEPTION 'NOTA_CREDITO_NO_SE_BORRA' USING ERRCODE = '42501'; END IF;
  IF OLD.estado = 'autorizado' THEN RAISE EXCEPTION 'NOTA_CREDITO_AUTORIZADA_INMODIFICABLE' USING ERRCODE = '42501'; END IF;
  IF NEW.comprobante_id IS DISTINCT FROM OLD.comprobante_id OR NEW.orden_id IS DISTINCT FROM OLD.orden_id OR NEW.ambiente IS DISTINCT FROM OLD.ambiente
     OR (NEW.pto_venta IS DISTINCT FROM OLD.pto_venta AND NOT (OLD.estado = 'rechazado' AND OLD.numero IS NULL)) OR NEW.creado_por IS DISTINCT FROM OLD.creado_por THEN
    RAISE EXCEPTION 'NOTA_CREDITO_DATOS_FIJOS' USING ERRCODE = '42501';
  END IF;
  NEW.actualizado_en := now();
  RETURN NEW;
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
  RETURN jsonb_build_object('estado', n.estado, 'numero', n.numero, 'pto_venta', n.pto_venta, 'cae', n.cae, 'importe_centavos', n.importe_centavos, 'factura_numero', f.numero, 'factura_pto_venta', f.pto_venta);
END $$;

DROP FUNCTION IF EXISTS public.arca_nc_conciliar_tomar(TEXT, TEXT, TEXT);
CREATE FUNCTION public.arca_nc_conciliar_tomar(p_secreto TEXT, p_orden TEXT, p_ambiente TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n public.meli_notas_credito%ROWTYPE; v UUID := gen_random_uuid(); v_fnum INTEGER; v_fpv INTEGER;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  SELECT n2.* INTO n FROM public.meli_notas_credito n2 WHERE n2.orden_id = p_orden AND n2.ambiente = p_ambiente FOR UPDATE;
  IF NOT FOUND OR n.estado <> 'reservado' THEN RETURN jsonb_build_object('tomado', FALSE, 'estado', COALESCE(n.estado, 'ninguna')); END IF;
  -- Misma ventana de seguridad que las facturas: 10 minutos desde que empezó el intento.
  IF n.trabajo_hasta IS NOT NULL AND n.trabajo_hasta > now() - interval '8 minutes' THEN RETURN jsonb_build_object('tomado', FALSE, 'estado', 'reservado', 'en_curso', TRUE); END IF;
  UPDATE public.meli_notas_credito SET intento_id = v, trabajo_hasta = now() + interval '2 minutes' WHERE id = n.id;
  SELECT numero, pto_venta INTO v_fnum, v_fpv FROM public.meli_comprobantes WHERE id = n.comprobante_id;
  RETURN jsonb_build_object('tomado', TRUE, 'intento', v, 'numero', n.numero, 'pto_venta', n.pto_venta, 'importe_centavos', n.importe_centavos, 'doc_tipo', n.doc_tipo, 'doc_nro', n.doc_nro, 'factura_numero', v_fnum, 'factura_pto_venta', v_fpv);
END $$;

DROP FUNCTION IF EXISTS public.arca_nc_reservar(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.arca_nc_reservar(TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT);
-- p_pto_venta = el punto de venta DE LA NOTA (el configurado, con el que se consultó el último número de ARCA). Puede ser distinto del de la factura:
-- ARCA permite asociar la nota a una factura de otro punto de venta. La numeración de las notas es la de ESTE punto de venta.
CREATE FUNCTION public.arca_nc_reservar(p_secreto TEXT, p_orden TEXT, p_ambiente TEXT, p_pto_venta INTEGER, p_ultimo_arca INTEGER, p_motivo TEXT, p_usuario TEXT)
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
  IF p_pto_venta IS NULL OR p_pto_venta < 1 OR p_pto_venta > 99999 THEN RAISE EXCEPTION 'PUNTO_DE_VENTA_INVALIDO'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_ambiente || '|' || p_pto_venta::text || '|13', 0));

  SELECT * INTO n FROM public.meli_notas_credito WHERE comprobante_id = f.id FOR UPDATE;
  IF FOUND THEN
    IF n.estado IN ('autorizado', 'reservado') THEN RAISE EXCEPTION 'NOTA_CREDITO_YA_EXISTE'; END IF;
    v_nuevo := FALSE;      -- estaba rechazada: se vuelve a intentar con un número nuevo
  END IF;
  IF EXISTS (SELECT 1 FROM public.meli_notas_credito x WHERE x.ambiente = p_ambiente AND x.pto_venta = p_pto_venta AND x.estado = 'reservado' AND x.comprobante_id <> f.id) THEN
    RAISE EXCEPTION 'NUMERACION_PENDIENTE';
  END IF;
  SELECT COALESCE(max(x.numero), 0) INTO v_max FROM public.meli_notas_credito x WHERE x.ambiente = p_ambiente AND x.pto_venta = p_pto_venta;
  v_num := GREATEST(p_ultimo_arca, v_max) + 1;
  IF v_num > 99999999 THEN RAISE EXCEPTION 'NUMERACION_AGOTADA'; END IF;

  IF v_nuevo THEN
    INSERT INTO public.meli_notas_credito (comprobante_id, orden_id, ambiente, pto_venta, numero, estado, importe_centavos, doc_tipo, doc_nro, cond_iva, motivo, creado_por, ultimo_solicitante, intento_id, trabajo_hasta)
    VALUES (f.id, p_orden, p_ambiente, p_pto_venta, v_num, 'reservado', f.importe_centavos, f.doc_tipo, f.doc_nro, f.cond_iva, p_motivo, left(btrim(p_usuario), 200), left(btrim(p_usuario), 200), v_intento, now() + interval '2 minutes');
  ELSE
    UPDATE public.meli_notas_credito SET estado = 'reservado', pto_venta = p_pto_venta, numero = v_num, motivo = p_motivo, ultimo_solicitante = left(btrim(p_usuario), 200), intento_id = v_intento, trabajo_hasta = now() + interval '2 minutes',
           intentos = intentos + 1, ultimo_error = NULL WHERE id = n.id;
  END IF;
  RETURN jsonb_build_object('estado', 'reservado', 'intento', v_intento, 'numero', v_num, 'pto_venta', p_pto_venta, 'factura_pto_venta', f.pto_venta, 'importe_centavos', f.importe_centavos,
    'doc_tipo', f.doc_tipo, 'doc_nro', f.doc_nro, 'cond_iva', f.cond_iva, 'factura_numero', f.numero, 'factura_fecha', f.fecha_cbte);
END $$;


REVOKE ALL ON FUNCTION
  public.arca_nc_estado(TEXT, TEXT, TEXT), public.arca_nc_conciliar_tomar(TEXT, TEXT, TEXT), public.arca_nc_reservar(TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.arca_nc_estado(TEXT, TEXT, TEXT), public.arca_nc_conciliar_tomar(TEXT, TEXT, TEXT), public.arca_nc_reservar(TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT)
TO anon, authenticated;

COMMIT;

-- Verificación (solo lectura): tiene que dar ✅.
SELECT 'nota de crédito en otro punto de venta' AS control,
       CASE WHEN pg_get_functiondef('public.arca_nc_reservar(text,text,text,integer,integer,text,text)'::regprocedure) NOT LIKE '%PUNTO_DE_VENTA_DISTINTO%'
             AND pg_get_functiondef('public.arca_nc_estado(text,text,text)'::regprocedure) LIKE '%factura_pto_venta%'
             AND pg_get_functiondef('public.arca_nc_conciliar_tomar(text,text,text)'::regprocedure) LIKE '%factura_pto_venta%' THEN '✅' ELSE '❌' END AS resultado;
