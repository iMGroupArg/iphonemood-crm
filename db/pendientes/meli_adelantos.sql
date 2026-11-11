-- ============================================================================
--  meli_adelantos.sql — ACREDITAR POR ADELANTO de Mercado Pago (script 27)
--
--  QUÉ HACE: cuando Mercado Pago ADELANTA la plata de ventas que todavía no se liberan, el dinero entra a la cuenta ese mismo día, pero el CRM no
--  puede acreditar esas ventas hasta su fecha de liberación (meli_acreditar_orden responde TODAVIA_NO_LIBERADA). Este script agrega:
--    · meli_adelantos / meli_adelanto_ops: el adelanto (fecha, total adelantado, costo, lo recibido) y la lista de operaciones que cubrió
--      (una por orden, con el monto REAL que pagó Mercado Pago; y las bonificaciones de Flex, que no son de ninguna orden).
--    · meli_adelanto_registrar: carga el adelanto y COMPRUEBA que las operaciones sumen exactamente el total adelantado.
--    · meli_adelanto_acreditar: acredita, sin esperar la fecha de liberación, las órdenes del adelanto que YA están procesadas; las que no, quedan
--      pendientes y se pueden acreditar después con el mismo botón. Misma lógica de plata que meli_acreditar_orden (venta cerrada, pago en dólares
--      a la cotización congelada, caja, misma clave de idempotencia): una orden acreditada por adelanto NO se acredita de nuevo en su fecha normal.
--    · meli_adelanto_estado: lo que muestra la pantalla.
--
--  REGLAS (innegociables)
--   · El monto acreditado de cada orden es el que PAGÓ Mercado Pago, y tiene que ser igual al neto de la orden en el CRM: si difiere, esa orden NO
--     se acredita sola (MONTO_DISTINTO_AL_NETO) y se resuelve a mano. Nada se redondea ni se reparte.
--   · Un adelanto no se puede cargar dos veces (misma fecha y total) y una orden no puede estar en dos adelantos.
--   · Solo órdenes procesadas, no revertidas, no en revisión, con importes completos. Las demás se saltan con su motivo.
--   · El COSTO del adelanto NO lo crea este script: se carga como gasto en el CRM; acá solo se anota para controlar que total - costo = lo recibido.
--   · Las bonificaciones de Flex (tipo 'flex') solo entran a la caja si se pide expresamente (p_incluir_flex), una vez cada una (clave estable).
--   · Cada orden se acredita en su propia sub-transacción: si una falla, las demás siguen y la falla queda informada.
--   · Solo personas autorizadas del CRM. Las tablas están cerradas: se lee y escribe únicamente con estas funciones.
--
--  REQUISITOS: script 3 (meli_esquema_base), script 4 (meli_ventas_migration: meli_acreditar_orden, ventas, caja) y is_authorized_user().
--  Idempotente. No cambia ningún dato existente.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.meli_ordenes') IS NULL OR to_regprocedure('public.meli_acreditar_orden(bigint,numeric,boolean)') IS NULL
     OR to_regprocedure('public._caja_aplicar_delta(uuid,text,numeric,text,text,text,text,text)') IS NULL
     OR to_regprocedure('public.is_authorized_user()') IS NULL THEN
    RAISE EXCEPTION 'Faltan los scripts 3 y 4 (Mercado Libre → Ventas y Cajas) o is_authorized_user(). Correrlos antes que este.';
  END IF;
END $$;

BEGIN;

CREATE TABLE IF NOT EXISTS public.meli_adelantos (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fecha             TIMESTAMPTZ  NOT NULL,
  total_adelantado  NUMERIC(18,2) NOT NULL CHECK (total_adelantado > 0),
  costo             NUMERIC(18,2) NOT NULL CHECK (costo >= 0),
  recibido          NUMERIC(18,2) NOT NULL,
  nota              TEXT,
  creado_por        TEXT         NOT NULL,
  creado_en         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT meli_adelantos_recibido_ck CHECK (recibido = total_adelantado - costo)
);
CREATE UNIQUE INDEX IF NOT EXISTS meli_adelantos_unico ON public.meli_adelantos (fecha, total_adelantado);

CREATE TABLE IF NOT EXISTS public.meli_adelanto_ops (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  adelanto_id   BIGINT       NOT NULL REFERENCES public.meli_adelantos (id),
  tipo          TEXT         NOT NULL CHECK (tipo IN ('pago', 'flex')),
  orden_id      TEXT         REFERENCES public.meli_ordenes (meli_order_id),   -- solo 'pago'
  referencia    TEXT,                                                           -- solo 'flex' (código de la bonificación)
  monto         NUMERIC(18,2) NOT NULL CHECK (monto > 0),
  acreditado_en TIMESTAMPTZ,
  resultado     TEXT,                                                           -- 'acreditada' | 'ya_acreditada' | 'flex_acreditada'
  CONSTRAINT meli_adelanto_ops_coherente_ck CHECK (
       (tipo = 'pago' AND orden_id IS NOT NULL AND referencia IS NULL)
    OR (tipo = 'flex' AND referencia IS NOT NULL AND orden_id IS NULL AND referencia ~ '^[A-Za-z0-9_-]{1,60}$'))
);
-- Una orden solo puede estar en UN adelanto; una bonificación, tampoco se repite.
CREATE UNIQUE INDEX IF NOT EXISTS meli_adelanto_ops_orden_unica ON public.meli_adelanto_ops (orden_id) WHERE tipo = 'pago';
CREATE UNIQUE INDEX IF NOT EXISTS meli_adelanto_ops_flex_unica ON public.meli_adelanto_ops (referencia) WHERE tipo = 'flex';
CREATE INDEX IF NOT EXISTS meli_adelanto_ops_adelanto ON public.meli_adelanto_ops (adelanto_id);

ALTER TABLE public.meli_adelantos    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meli_adelanto_ops ENABLE ROW LEVEL SECURITY;      -- sin políticas: cerradas; se usa solo meli_adelanto_estado
REVOKE ALL ON TABLE public.meli_adelantos, public.meli_adelanto_ops FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.meli_adelantos_id_seq, public.meli_adelanto_ops_id_seq FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON TABLE public.meli_adelantos, public.meli_adelanto_ops FROM service_role;
    REVOKE ALL ON SEQUENCE public.meli_adelantos_id_seq, public.meli_adelanto_ops_id_seq FROM service_role;
  END IF;
END $$;

-- ── Registrar el adelanto ───────────────────────────────────────────────────
--  p_ops: arreglo JSON de { "tipo": "pago"|"flex", "orden": "2000…" (pago) | "referencia": "cashback_…" (flex), "monto": 47061.86 }.
DROP FUNCTION IF EXISTS public.meli_adelanto_registrar(TIMESTAMPTZ, NUMERIC, NUMERIC, JSONB, TEXT);
CREATE FUNCTION public.meli_adelanto_registrar(p_fecha TIMESTAMPTZ, p_total NUMERIC, p_costo NUMERIC, p_ops JSONB, p_nota TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_usuario TEXT; v_id BIGINT; v_suma NUMERIC; v_n INTEGER; v_faltan TEXT; v_repetidas TEXT; v_otro TEXT; r RECORD;
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  IF p_fecha IS NULL OR p_fecha > now() + interval '1 day' THEN RAISE EXCEPTION 'FECHA_INVALIDA'; END IF;
  IF p_total IS NULL OR p_total <= 0 OR p_total <> round(p_total, 2) THEN RAISE EXCEPTION 'TOTAL_INVALIDO'; END IF;
  IF p_costo IS NULL OR p_costo < 0 OR p_costo <> round(p_costo, 2) OR p_costo >= p_total THEN RAISE EXCEPTION 'COSTO_INVALIDO'; END IF;
  IF p_ops IS NULL OR jsonb_typeof(p_ops) <> 'array' OR jsonb_array_length(p_ops) = 0 OR jsonb_array_length(p_ops) > 500 THEN RAISE EXCEPTION 'OPERACIONES_INVALIDAS'; END IF;

  CREATE TEMP TABLE IF NOT EXISTS _adelanto_ops (tipo TEXT, orden TEXT, referencia TEXT, monto NUMERIC) ON COMMIT DROP;
  DELETE FROM _adelanto_ops;
  FOR r IN SELECT value AS e FROM jsonb_array_elements(p_ops) LOOP
    IF jsonb_typeof(r.e) <> 'object' OR (r.e ->> 'tipo') NOT IN ('pago', 'flex')
       OR (r.e ->> 'monto') !~ '^[0-9]{1,12}(\.[0-9]{1,2})?$' OR (r.e ->> 'monto')::NUMERIC <= 0 THEN
      RAISE EXCEPTION 'OPERACION_INVALIDA';
    END IF;
    IF (r.e ->> 'tipo') = 'pago' AND COALESCE(r.e ->> 'orden', '') !~ '^[0-9]{1,20}$' THEN RAISE EXCEPTION 'OPERACION_INVALIDA'; END IF;
    IF (r.e ->> 'tipo') = 'flex' AND COALESCE(r.e ->> 'referencia', '') !~ '^[A-Za-z0-9_-]{1,60}$' THEN RAISE EXCEPTION 'OPERACION_INVALIDA'; END IF;
    INSERT INTO _adelanto_ops VALUES (r.e ->> 'tipo', r.e ->> 'orden', r.e ->> 'referencia', (r.e ->> 'monto')::NUMERIC);
  END LOOP;

  SELECT string_agg(DISTINCT COALESCE(orden, referencia), ', ') INTO v_repetidas FROM (
    SELECT tipo, orden, referencia FROM _adelanto_ops GROUP BY tipo, orden, referencia HAVING count(*) > 1) d;
  IF v_repetidas IS NOT NULL THEN RAISE EXCEPTION 'OPERACIONES_REPETIDAS' USING DETAIL = v_repetidas; END IF;

  SELECT sum(monto), count(*) INTO v_suma, v_n FROM _adelanto_ops;
  IF v_suma <> p_total THEN
    RAISE EXCEPTION 'SUMA_NO_CIERRA' USING DETAIL = format('las operaciones suman %s y el adelanto es %s (diferencia %s)', v_suma, p_total, round(v_suma - p_total, 2));
  END IF;

  SELECT string_agg(o.orden, ', ') INTO v_faltan FROM _adelanto_ops o
   WHERE o.tipo = 'pago' AND NOT EXISTS (SELECT 1 FROM public.meli_ordenes m WHERE m.meli_order_id = o.orden);
  IF v_faltan IS NOT NULL THEN RAISE EXCEPTION 'ORDEN_INEXISTENTE' USING DETAIL = v_faltan; END IF;

  SELECT string_agg(COALESCE(x.orden_id, x.referencia), ', ') INTO v_otro FROM public.meli_adelanto_ops x
   JOIN _adelanto_ops o ON (x.tipo = 'pago' AND o.tipo = 'pago' AND x.orden_id = o.orden) OR (x.tipo = 'flex' AND o.tipo = 'flex' AND x.referencia = o.referencia);
  IF v_otro IS NOT NULL THEN RAISE EXCEPTION 'OPERACION_YA_EN_OTRO_ADELANTO' USING DETAIL = v_otro; END IF;

  v_usuario := COALESCE(NULLIF(auth.jwt() -> 'user_metadata' ->> 'full_name', ''), NULLIF(auth.jwt() ->> 'email', ''), 'Desconocido');
  BEGIN
    INSERT INTO public.meli_adelantos (fecha, total_adelantado, costo, recibido, nota, creado_por)
    VALUES (p_fecha, p_total, p_costo, p_total - p_costo, left(NULLIF(btrim(COALESCE(p_nota, '')), ''), 300), v_usuario) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'ADELANTO_YA_REGISTRADO';
  END;
  INSERT INTO public.meli_adelanto_ops (adelanto_id, tipo, orden_id, referencia, monto)
  SELECT v_id, tipo, orden, referencia, monto FROM _adelanto_ops;
  RETURN jsonb_build_object('ok', true, 'adelanto_id', v_id, 'operaciones', v_n, 'recibido', p_total - p_costo);
END;
$$;

-- ── Núcleo: acredita UNA orden por adelanto (misma lógica de plata que meli_acreditar_orden, sin esperar la fecha de liberación) ──
DROP FUNCTION IF EXISTS public.meli__acreditar_por_adelanto(BIGINT, NUMERIC, TEXT);
CREATE FUNCTION public.meli__acreditar_por_adelanto(p_orden_id BIGINT, p_monto NUMERIC, p_usuario TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o public.meli_ordenes%ROWTYPE; v_persona UUID; v_bolsillo TEXT; v_cot NUMERIC; v_total_usd NUMERIC; v_cobrado NUMERIC; v_monto NUMERIC := round(p_monto, 2);
BEGIN
  SELECT * INTO o FROM public.meli_ordenes WHERE id = p_orden_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDEN_INEXISTENTE'; END IF;
  IF o.acreditado AND o.revertida_en IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'ya_acreditada', true, 'monto', o.monto_acreditado, 'monto_igual', o.monto_acreditado = v_monto);
  END IF;
  IF o.revertida_en IS NOT NULL THEN RAISE EXCEPTION 'ORDEN_REVERTIDA'; END IF;
  IF NOT o.procesada OR o.venta_id IS NULL THEN RAISE EXCEPTION 'ORDEN_NO_PROCESADA'; END IF;
  IF o.revisar THEN RAISE EXCEPTION 'ORDEN_EN_REVISION'; END IF;
  IF NOT o.financiera_completa THEN RAISE EXCEPTION 'FINANCIERA_INCOMPLETA'; END IF;
  IF o.neto IS NULL OR o.bruto IS NULL THEN RAISE EXCEPTION 'IMPORTES_INCOMPLETOS'; END IF;
  -- Lo que pagó Mercado Pago tiene que ser el neto de la orden: si no, se resuelve a mano (nada se redondea ni se reparte).
  IF v_monto IS NULL OR v_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF v_monto <> round(o.neto, 2) THEN RAISE EXCEPTION 'MONTO_DISTINTO_AL_NETO'; END IF;
  IF v_monto > o.bruto THEN RAISE EXCEPTION 'MONTO_MAYOR_AL_BRUTO'; END IF;

  SELECT c.persona_id, c.bolsillo INTO v_persona, v_bolsillo FROM public.meli_cuentas c WHERE c.id = o.cuenta_id;
  IF v_persona IS NULL OR COALESCE(btrim(v_bolsillo), '') = '' THEN RAISE EXCEPTION 'CUENTA_SIN_CAJA'; END IF;

  -- Orden de bloqueos: orden → ventas → caja (el mismo de meli_acreditar_orden).
  SELECT v.meli_cotizacion INTO v_cot FROM public.ventas v WHERE v.id = o.venta_id FOR UPDATE;
  IF v_cot IS NULL OR v_cot <= 0 THEN RAISE EXCEPTION 'VENTA_SIN_COTIZACION'; END IF;
  SELECT COALESCE(sum(precio_usd), 0) INTO v_total_usd FROM public.venta_items WHERE venta_id = o.venta_id;
  v_cobrado := LEAST(round(v_monto / v_cot, 2), v_total_usd);

  INSERT INTO public.cajas (persona_id, bolsillo, saldo) VALUES (v_persona, v_bolsillo, 0) ON CONFLICT (persona_id, bolsillo) DO NOTHING;
  -- MISMA clave de idempotencia que la acreditación normal: la plata entra una sola vez aunque después se intente por el camino de siempre.
  PERFORM public._caja_aplicar_delta(v_persona, v_bolsillo, v_monto, 'meli', o.meli_order_id,
            'Acreditación Mercado Libre por adelanto — orden ' || o.meli_order_id, p_usuario, 'meli-acreditar-' || o.id);
  INSERT INTO public.venta_pagos (venta_id, persona_id, bolsillo, monto, es_tarjeta, diferencial_ars, cotizacion_diferencial)
  VALUES (o.venta_id, v_persona, v_bolsillo, v_cobrado, FALSE, 0, v_cot);
  UPDATE public.ventas SET estado = 'cerrada', costo_canal_usd = round(v_total_usd - v_cobrado, 2) WHERE id = o.venta_id;
  UPDATE public.meli_ordenes SET acreditado = TRUE, monto_acreditado = v_monto, acreditado_en = now(),
         acreditado_persona_id = v_persona, acreditado_bolsillo = v_bolsillo, actualizado_en = now() WHERE id = o.id;
  RETURN jsonb_build_object('ok', true, 'ya_acreditada', false, 'monto', v_monto);
END;
$$;

-- ── Acreditar el adelanto ───────────────────────────────────────────────────
--  Recorre las operaciones del adelanto que faltan y acredita las que se pueden. Devuelve el resultado de cada una y los totales.
--  p_incluir_flex: además, entra a la caja la bonificación de Flex (una vez cada una). La caja es la de la ÚNICA cuenta conectada de Mercado Libre.
DROP FUNCTION IF EXISTS public.meli_adelanto_acreditar(BIGINT, BOOLEAN);
CREATE FUNCTION public.meli_adelanto_acreditar(p_adelanto_id BIGINT, p_incluir_flex BOOLEAN DEFAULT FALSE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  a public.meli_adelantos%ROWTYPE; r RECORD; v_usuario TEXT; v_res JSONB := '[]'::jsonb; v_r JSONB; v_motivo TEXT;
  v_acred INTEGER := 0; v_ya INTEGER := 0; v_pend INTEGER := 0; v_monto_acred NUMERIC := 0; v_flex INTEGER := 0; v_flex_monto NUMERIC := 0;
  v_persona UUID; v_bolsillo TEXT; v_cuentas INTEGER;
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  SELECT * INTO a FROM public.meli_adelantos WHERE id = p_adelanto_id FOR UPDATE;       -- una corrida por adelanto a la vez
  IF NOT FOUND THEN RAISE EXCEPTION 'ADELANTO_INEXISTENTE'; END IF;
  v_usuario := COALESCE(NULLIF(auth.jwt() -> 'user_metadata' ->> 'full_name', ''), NULLIF(auth.jwt() ->> 'email', ''), 'Desconocido');

  -- Órdenes en orden de id: bloqueos siempre en el mismo orden.
  FOR r IN SELECT op.id AS op_id, op.monto, m.id AS orden_pk, op.orden_id FROM public.meli_adelanto_ops op
            JOIN public.meli_ordenes m ON m.meli_order_id = op.orden_id
           WHERE op.adelanto_id = a.id AND op.tipo = 'pago' AND op.acreditado_en IS NULL ORDER BY m.id LOOP
    BEGIN
      v_r := public.meli__acreditar_por_adelanto(r.orden_pk, r.monto, v_usuario);
      UPDATE public.meli_adelanto_ops SET acreditado_en = now(), resultado = CASE WHEN (v_r ->> 'ya_acreditada')::BOOLEAN THEN 'ya_acreditada' ELSE 'acreditada' END WHERE id = r.op_id;
      IF (v_r ->> 'ya_acreditada')::BOOLEAN THEN
        v_ya := v_ya + 1;
        v_res := v_res || jsonb_build_array(jsonb_build_object('orden', r.orden_id, 'resultado', 'ya_acreditada', 'monto_igual', (v_r ->> 'monto_igual')::BOOLEAN));
      ELSE
        v_acred := v_acred + 1; v_monto_acred := v_monto_acred + r.monto;
        v_res := v_res || jsonb_build_array(jsonb_build_object('orden', r.orden_id, 'resultado', 'acreditada', 'monto', r.monto));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_motivo := substring(SQLERRM FROM '^[A-Z_]+');
      v_pend := v_pend + 1;
      v_res := v_res || jsonb_build_array(jsonb_build_object('orden', r.orden_id, 'resultado', 'pendiente', 'motivo', COALESCE(v_motivo, 'ERROR')));
    END;
  END LOOP;

  IF COALESCE(p_incluir_flex, FALSE) THEN
    SELECT count(*) INTO v_cuentas FROM public.meli_cuentas c WHERE COALESCE(c.activa, TRUE) AND c.persona_id IS NOT NULL AND COALESCE(btrim(c.bolsillo), '') <> '';
    IF v_cuentas <> 1 THEN RAISE EXCEPTION 'FLEX_CUENTA_AMBIGUA'; END IF;       -- sin una única cuenta no se adivina a qué caja entra
    SELECT c.persona_id, c.bolsillo INTO v_persona, v_bolsillo FROM public.meli_cuentas c WHERE COALESCE(c.activa, TRUE) AND c.persona_id IS NOT NULL AND COALESCE(btrim(c.bolsillo), '') <> '';
    INSERT INTO public.cajas (persona_id, bolsillo, saldo) VALUES (v_persona, v_bolsillo, 0) ON CONFLICT (persona_id, bolsillo) DO NOTHING;
    FOR r IN SELECT id, referencia, monto FROM public.meli_adelanto_ops WHERE adelanto_id = a.id AND tipo = 'flex' AND acreditado_en IS NULL ORDER BY id LOOP
      PERFORM public._caja_aplicar_delta(v_persona, v_bolsillo, r.monto, 'meli', r.referencia, 'Bonificación Flex por envío (adelanto ' || a.id || ')', v_usuario, 'meli-flex-' || r.referencia);
      UPDATE public.meli_adelanto_ops SET acreditado_en = now(), resultado = 'flex_acreditada' WHERE id = r.id;
      v_flex := v_flex + 1; v_flex_monto := v_flex_monto + r.monto;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ok', true, 'acreditadas', v_acred, 'monto_acreditado', v_monto_acred, 'ya_acreditadas', v_ya, 'pendientes', v_pend,
                            'flex', v_flex, 'monto_flex', v_flex_monto, 'detalle', v_res);
END;
$$;

-- ── Lo que ve la pantalla ───────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.meli_adelanto_estado(BIGINT);
CREATE FUNCTION public.meli_adelanto_estado(p_adelanto_id BIGINT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', a.id, 'fecha', a.fecha, 'total_adelantado', a.total_adelantado, 'costo', a.costo, 'recibido', a.recibido, 'nota', a.nota, 'creado_por', a.creado_por,
      'ops', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', op.id, 'tipo', op.tipo, 'orden', op.orden_id, 'referencia', op.referencia, 'monto', op.monto, 'resultado', op.resultado, 'acreditado_en', op.acreditado_en,
            'estado', m.estado, 'procesada', m.procesada, 'acreditada', m.acreditado, 'revertida', (m.revertida_en IS NOT NULL), 'revisar', m.revisar,
            'neto', m.neto, 'libera', m.fecha_liberacion) ORDER BY op.id)
          FROM public.meli_adelanto_ops op LEFT JOIN public.meli_ordenes m ON m.meli_order_id = op.orden_id WHERE op.adelanto_id = a.id), '[]'::jsonb))
      ORDER BY a.fecha DESC)
    FROM public.meli_adelantos a WHERE p_adelanto_id IS NULL OR a.id = p_adelanto_id), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.meli_adelanto_registrar(TIMESTAMPTZ, NUMERIC, NUMERIC, JSONB, TEXT), public.meli__acreditar_por_adelanto(BIGINT, NUMERIC, TEXT),
  public.meli_adelanto_acreditar(BIGINT, BOOLEAN), public.meli_adelanto_estado(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.meli_adelanto_registrar(TIMESTAMPTZ, NUMERIC, NUMERIC, JSONB, TEXT), public.meli_adelanto_acreditar(BIGINT, BOOLEAN),
  public.meli_adelanto_estado(BIGINT) TO authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON FUNCTION public.meli_adelanto_registrar(TIMESTAMPTZ, NUMERIC, NUMERIC, JSONB, TEXT), public.meli__acreditar_por_adelanto(BIGINT, NUMERIC, TEXT),
      public.meli_adelanto_acreditar(BIGINT, BOOLEAN), public.meli_adelanto_estado(BIGINT) FROM service_role;
  END IF;
END $$;

COMMIT;

-- Verificación (solo lectura): tiene que dar tres filas con ✅.
SELECT 'tablas y funciones' AS control,
       CASE WHEN to_regclass('public.meli_adelantos') IS NOT NULL AND to_regclass('public.meli_adelanto_ops') IS NOT NULL
             AND to_regprocedure('public.meli_adelanto_acreditar(bigint,boolean)') IS NOT NULL THEN '✅' ELSE '❌' END AS resultado
UNION ALL
SELECT 'tablas cerradas al navegador',
       CASE WHEN NOT has_table_privilege('anon', 'public.meli_adelantos', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.meli_adelanto_ops', 'SELECT')
             AND NOT has_table_privilege('authenticated', 'public.meli_adelantos', 'INSERT') THEN '✅' ELSE '❌' END
UNION ALL
SELECT 'funciones solo para usuarios autorizados',
       CASE WHEN NOT has_function_privilege('anon', 'public.meli_adelanto_acreditar(bigint,boolean)', 'EXECUTE')
             AND NOT has_function_privilege('authenticated', 'public.meli__acreditar_por_adelanto(bigint,numeric,text)', 'EXECUTE')
             AND has_function_privilege('authenticated', 'public.meli_adelanto_acreditar(bigint,boolean)', 'EXECUTE') THEN '✅' ELSE '❌' END;
