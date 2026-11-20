-- ============================================================================
--  meli_flex_bonificaciones.sql — BONIFICACIONES FLEX SUELTAS de Mercado Libre (script 33)
--
--  QUÉ HACE: Mercado Libre suma al «Total» de ciertas ventas Flex una bonificación por envío (cashback, hoy $499) pero la acredita como un movimiento
--  APARTE, con un código propio (`cashback_…`). La orden se acredita por su neto (como siempre) y la bonificación entra a la caja por este camino.
--  Hasta ahora las bonificaciones solo podían entrar DENTRO de un adelanto (meli_adelanto_acreditar con p_incluir_flex). Este script agrega:
--    · meli_flex_bonificaciones: el registro de las bonificaciones sueltas ya acreditadas (una fila por código de Mercado Libre).
--    · meli_flex_acreditar: acredita a la caja de la cuenta de Mercado Libre una lista de bonificaciones (código + monto), todo o nada.
--      Con p_simular = true solo valida y devuelve el PLAN (cuenta, caja, total, cuáles ya estaban) sin escribir nada: es lo que muestra la confirmación.
--    · meli_flex_estado: lo que ve la pantalla (bonificaciones ya registradas; con una lista de órdenes devuelve TODAS las pedidas, sin truncar).
--
--  REGLAS (innegociables)
--   · La identidad de una bonificación es su `referencia`: el código real de Mercado Libre (`cashback_…`) si se lo tiene, o —cuando comparar la ve en la venta pero el código
--     no está a mano— `flex-<número de orden>` (así lo decidió Franco). Para que dos nombres no dejen entrar DOS veces la misma bonificación: UNA sola bonificación suelta por
--     orden (índice único por orden; la ORDEN es obligatoria en toda operación, también con un código) y `flex-<orden>` exige que la orden informada sea exactamente esa.
--   · La caja donde entra la plata la confirma quien mira la pantalla: la simulación devuelve persona y bolsillo y la acreditación real los exige iguales (CAJA_CAMBIO si
--     entre medio se reasignó la caja de la cuenta). Sin simular, p_persona_esperada y p_bolsillo_esperado son obligatorios.
--   · La plata entra con la MISMA clave de caja que usa el adelanto — 'meli-flex-' || referencia — y la clave es única en el libro de cajas: una
--     bonificación NUNCA entra dos veces, ni repitiendo la llamada, ni por dos caminos.
--   · Un código que ya figura en un adelanto (meli_adelanto_ops) NO se acredita por acá: se acredita por su adelanto (evita el doble camino). La exclusión entre los dos
--     caminos está SERIALIZADA: un bloqueo de la referencia (pg_advisory_xact_lock) lo toman esta función y un disparador sobre meli_adelanto_ops (registrar un adelanto con
--     una bonificación ya acreditada suelta se frena; el disparador es por sentencia y toma los bloqueos en orden). Un adelanto guarda sus bonificaciones por código, sin la orden: para acreditar algo NUEVO
--     hay que confirmar expresamente (p_sin_adelanto_confirmado) que no está ya dentro de un adelanto, y la simulación informa cuántas hay en adelantos. Residual: un código `cashback_…` de un adelanto y `flex-<orden>` de la misma venta son nombres distintos para la misma
--     plata y la base no puede unirlos (el adelanto no guarda la orden): quien los carga no debe usar los dos caminos para la misma bonificación. Tampoco se detecta un adelanto registrado DESPUÉS con otro código para la misma bonificación ya acreditada suelta.
--   · Un código ya acreditado por acá con el MISMO monto y cuenta es «ya acreditada» (no mueve nada); con otro monto u otra cuenta, error (todo o nada).
--   · Si la clave ya está en el libro de cajas por cualquier otro motivo, se frena (REFERENCIA_YA_EN_CAJA): se resuelve a mano.
--   · Monto: hoy la bonificación es de $499; cualquier otro monto se frena (MONTO_FLEX_INUSUAL) salvo que se pida expresamente (p_otros_montos). Tope: 200
--     operaciones y $100.000 por llamada.
--   · La caja es la de la cuenta de Mercado Libre (la ÚNICA activa con caja asignada, o la que se indique). Las órdenes informadas deben ser de esa cuenta.
--   · Todo o nada: si una operación falla, no entra ninguna. Orden de bloqueos: caja → libro (clave) → fila de la bonificación, siempre el mismo, y antes de
--     mover plata se registran TODAS las filas (en orden de código); así dos llamadas con lotes distintos no se traban entre sí.
--   · Solo personas autorizadas del CRM. La tabla está cerrada: se lee y escribe únicamente con estas funciones. No se borra ni se modifica nada existente.
--
--  REQUISITOS: scripts 3 (meli_esquema_base), 4 (meli_ventas_migration), 1 (caja_aplicar_delta) y 27 (meli_adelantos), e is_authorized_user().
--  Idempotente.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.meli_cuentas') IS NULL OR to_regclass('public.meli_ordenes') IS NULL OR to_regclass('public.meli_adelanto_ops') IS NULL
     OR to_regprocedure('public._caja_aplicar_delta(uuid,text,numeric,text,text,text,text,text)') IS NULL
     OR to_regprocedure('public.is_authorized_user()') IS NULL THEN
    RAISE EXCEPTION 'Faltan los scripts 1, 3, 4 y 27 (cajas, Mercado Libre y adelantos) o is_authorized_user(). Correrlos antes que este.';
  END IF;
END $$;

BEGIN;

CREATE TABLE IF NOT EXISTS public.meli_flex_bonificaciones (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referencia     TEXT          NOT NULL,                                   -- el código de Mercado Libre (cashback_…)
  cuenta_id      BIGINT        NOT NULL REFERENCES public.meli_cuentas (id),
  orden_id       TEXT          NOT NULL,                                   -- la venta a la que corresponde: una sola bonificación suelta por orden; sin clave foránea a propósito
  monto          NUMERIC(18,2) NOT NULL CHECK (monto > 0),
  acreditado_en  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  acreditado_por TEXT          NOT NULL,
  CONSTRAINT meli_flex_bonificaciones_ref_ck   CHECK (referencia ~ '^[A-Za-z0-9_-]{1,60}$'),
  CONSTRAINT meli_flex_bonificaciones_orden_ck CHECK (orden_id ~ '^[0-9]{1,20}$'),
  CONSTRAINT meli_flex_bonificaciones_flexorden_ck CHECK (referencia NOT LIKE 'flex-%' OR orden_id = substr(referencia, 6))          -- «flex-<orden>» solo para esa orden
);
CREATE UNIQUE INDEX IF NOT EXISTS meli_flex_bonificaciones_ref   ON public.meli_flex_bonificaciones (referencia);
CREATE UNIQUE INDEX IF NOT EXISTS meli_flex_bonificaciones_orden ON public.meli_flex_bonificaciones (orden_id);          -- una bonificación suelta por orden

ALTER TABLE public.meli_flex_bonificaciones ENABLE ROW LEVEL SECURITY;     -- sin políticas: cerrada; se usa solo meli_flex_estado
REVOKE ALL ON TABLE public.meli_flex_bonificaciones FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.meli_flex_bonificaciones_id_seq FROM PUBLIC, anon, authenticated;
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['service_role', 'agentes_ro', 'agentes_revisor'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.meli_flex_bonificaciones FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.meli_flex_bonificaciones_id_seq FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- ── Acreditar (o simular) una lista de bonificaciones ────────────────────────
--  p_ops: arreglo JSON de { "referencia": "cashback_…" | "flex-<orden>", "monto": 499, "orden": "2000…" (obligatoria con flex-<orden>, informativa con un código) }.
DROP FUNCTION IF EXISTS public.meli_flex_acreditar(JSONB, BIGINT, BOOLEAN, BOOLEAN);
DROP FUNCTION IF EXISTS public.meli_flex_acreditar(JSONB, BIGINT, BOOLEAN, BOOLEAN, UUID, TEXT);
DROP FUNCTION IF EXISTS public.meli_flex_acreditar(JSONB, BIGINT, BOOLEAN, BOOLEAN, UUID, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.meli_flex_acreditar(JSONB, BIGINT, BOOLEAN, BOOLEAN, UUID, TEXT, BOOLEAN, TEXT);
CREATE FUNCTION public.meli_flex_acreditar(p_ops JSONB, p_cuenta_id BIGINT DEFAULT NULL, p_otros_montos BOOLEAN DEFAULT FALSE, p_simular BOOLEAN DEFAULT FALSE, p_persona_esperada UUID DEFAULT NULL, p_bolsillo_esperado TEXT DEFAULT NULL, p_sin_adelanto_confirmado BOOLEAN DEFAULT FALSE, p_huella_adelantos TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r RECORD; v_usuario TEXT; v_cuenta BIGINT; v_persona UUID; v_bolsillo TEXT; v_activa BOOLEAN; v_nombre TEXT; v_n INTEGER; v_total NUMERIC;
  v_dup TEXT; v_raros TEXT; v_adel TEXT; v_ledger TEXT; v_ordenes TEXT; v_otra TEXT; v_cuentas INTEGER; v_prev RECORD;
  v_huella TEXT; v_nuevas INTEGER := 0; v_ya INTEGER := 0; v_monto_nuevo NUMERIC := 0; v_detalle JSONB := '[]'::jsonb; v_id BIGINT;
  v_montos_ok NUMERIC[] := ARRAY[499]::NUMERIC[];                       -- la bonificación Flex vigente; otro monto pide confirmación expresa
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  IF p_ops IS NULL OR jsonb_typeof(p_ops) <> 'array' OR jsonb_array_length(p_ops) = 0 OR jsonb_array_length(p_ops) > 200 THEN RAISE EXCEPTION 'OPERACIONES_INVALIDAS'; END IF;

  CREATE TEMP TABLE IF NOT EXISTS _flex_ops (referencia TEXT, monto NUMERIC, orden TEXT) ON COMMIT DROP;
  DELETE FROM _flex_ops WHERE TRUE;
  FOR r IN SELECT value AS e FROM jsonb_array_elements(p_ops) LOOP
    IF jsonb_typeof(r.e) <> 'object' OR COALESCE(r.e ->> 'referencia', '') !~ '^[A-Za-z0-9_-]{1,60}$'
       OR COALESCE(r.e ->> 'monto', '') !~ '^[0-9]{1,12}(\.[0-9]{1,2})?$' OR (r.e ->> 'monto')::NUMERIC <= 0
       OR COALESCE(r.e ->> 'orden', '') !~ '^[0-9]{1,20}$'          -- la ORDEN es obligatoria: la identidad real de la bonificación es la venta (una por orden)
       OR ((r.e ->> 'referencia') LIKE 'flex-%' AND (r.e ->> 'orden') IS DISTINCT FROM substr(r.e ->> 'referencia', 6)) THEN
      RAISE EXCEPTION 'OPERACION_INVALIDA';
    END IF;
    INSERT INTO _flex_ops VALUES (r.e ->> 'referencia', (r.e ->> 'monto')::NUMERIC, r.e ->> 'orden');
  END LOOP;

  SELECT string_agg(DISTINCT referencia, ', ') INTO v_dup FROM (SELECT referencia FROM _flex_ops GROUP BY referencia HAVING count(*) > 1) d;
  IF v_dup IS NOT NULL THEN RAISE EXCEPTION 'OPERACIONES_REPETIDAS' USING DETAIL = v_dup; END IF;
  SELECT string_agg(DISTINCT orden, ', ') INTO v_dup FROM (SELECT orden FROM _flex_ops WHERE orden IS NOT NULL GROUP BY orden HAVING count(*) > 1) d;
  IF v_dup IS NOT NULL THEN RAISE EXCEPTION 'ORDENES_REPETIDAS' USING DETAIL = v_dup; END IF;
  SELECT sum(monto), count(*) INTO v_total, v_n FROM _flex_ops;
  IF v_total > 100000 THEN RAISE EXCEPTION 'TOTAL_EXCESIVO' USING DETAIL = format('el total %s supera el tope de 100000 por llamada', v_total); END IF;
  IF NOT COALESCE(p_otros_montos, FALSE) THEN
    SELECT string_agg(referencia || '=' || monto, ', ') INTO v_raros FROM _flex_ops WHERE NOT (monto = ANY (v_montos_ok));
    IF v_raros IS NOT NULL THEN RAISE EXCEPTION 'MONTO_FLEX_INUSUAL' USING DETAIL = v_raros; END IF;
  END IF;

  -- La cuenta (y su caja): la indicada, o la ÚNICA activa con caja asignada.
  IF p_cuenta_id IS NULL THEN
    SELECT count(*), min(c.id) INTO v_cuentas, v_cuenta FROM public.meli_cuentas c
     WHERE COALESCE(c.activa, FALSE) AND c.persona_id IS NOT NULL AND COALESCE(btrim(c.bolsillo), '') <> '';
    IF v_cuentas <> 1 THEN RAISE EXCEPTION 'CUENTA_REQUERIDA'; END IF;
  ELSE
    v_cuenta := p_cuenta_id;
  END IF;
  SELECT c.persona_id, c.bolsillo, c.activa INTO v_persona, v_bolsillo, v_activa FROM public.meli_cuentas c WHERE c.id = v_cuenta FOR SHARE;
  IF NOT FOUND OR v_persona IS NULL OR COALESCE(btrim(v_bolsillo), '') = '' THEN RAISE EXCEPTION 'CUENTA_SIN_CAJA'; END IF;
  IF NOT COALESCE(v_activa, FALSE) THEN RAISE EXCEPTION 'CUENTA_INACTIVA'; END IF;
  SELECT nombre INTO v_nombre FROM public.personas WHERE id = v_persona;
  -- La caja que se está por acreditar tiene que ser la que se mostró en la confirmación (entre la simulación y la acreditación alguien pudo reasignarla).
  IF NOT COALESCE(p_simular, FALSE) AND (p_persona_esperada IS NULL OR COALESCE(btrim(p_bolsillo_esperado), '') = '') THEN RAISE EXCEPTION 'CAJA_ESPERADA_REQUERIDA'; END IF;
  IF (p_persona_esperada IS NOT NULL AND p_persona_esperada IS DISTINCT FROM v_persona) OR (p_bolsillo_esperado IS NOT NULL AND p_bolsillo_esperado IS DISTINCT FROM v_bolsillo) THEN
    RAISE EXCEPTION 'CAJA_CAMBIO' USING DETAIL = 'la caja de la cuenta ya no es la que se confirmó: hay que volver a revisar';
  END IF;

  -- Las órdenes informadas (solo informativas): tienen que existir y ser de ESTA cuenta.
  SELECT string_agg(o.orden, ', ') INTO v_ordenes FROM _flex_ops o WHERE o.orden IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.meli_ordenes m WHERE m.meli_order_id = o.orden);
  IF v_ordenes IS NOT NULL THEN RAISE EXCEPTION 'ORDEN_INEXISTENTE' USING DETAIL = v_ordenes; END IF;
  SELECT string_agg(o.orden, ', ') INTO v_otra FROM _flex_ops o JOIN public.meli_ordenes m ON m.meli_order_id = o.orden WHERE m.cuenta_id <> v_cuenta;
  IF v_otra IS NOT NULL THEN RAISE EXCEPTION 'ORDEN_DE_OTRA_CUENTA' USING DETAIL = v_otra; END IF;

  v_usuario := COALESCE(NULLIF(auth.jwt() -> 'user_metadata' ->> 'full_name', ''), NULLIF(auth.jwt() ->> 'email', ''), 'Desconocido');

  IF NOT COALESCE(p_simular, FALSE) THEN
    -- PRIMERO la caja (siempre la misma fila, antes que cualquier clave del libro): quien llegue segundo espera acá, sin haber reservado nada.
    INSERT INTO public.cajas (persona_id, bolsillo, saldo) VALUES (v_persona, v_bolsillo, 0) ON CONFLICT (persona_id, bolsillo) DO NOTHING;
    PERFORM 1 FROM public.cajas WHERE persona_id = v_persona AND bolsillo = v_bolsillo FOR UPDATE;
  END IF;

  -- Bloqueo por referencia (en orden): lo comparte el disparador de meli_adelanto_ops, así registrar un adelanto con este código y acreditarlo suelto no se cruzan.
  IF NOT COALESCE(p_simular, FALSE) THEN
    FOR r IN SELECT referencia FROM _flex_ops ORDER BY referencia LOOP PERFORM pg_advisory_xact_lock(hashtextextended('meli-flex-ref:' || r.referencia, 0)); END LOOP;
  END IF;
  -- Un adelanto guarda sus bonificaciones por CÓDIGO (no por orden): la base no puede saber si el cashback de una orden ya entró dentro de un adelanto con otro nombre. Por eso, para acreditar
  -- algo NUEVO hace falta que quien opera lo confirme expresamente (la simulación informa cuántas bonificaciones y qué monto ya hay en adelantos, para decidir con ese dato).
  IF NOT COALESCE(p_simular, FALSE) AND NOT COALESCE(p_sin_adelanto_confirmado, FALSE)
     AND EXISTS (SELECT 1 FROM _flex_ops o WHERE NOT EXISTS (SELECT 1 FROM public.meli_flex_bonificaciones b WHERE b.referencia = o.referencia)) THEN
    RAISE EXCEPTION 'ADELANTO_NO_VERIFICADO' USING DETAIL = 'falta confirmar que estas bonificaciones no están ya dentro de un adelanto';
  END IF;
  -- HUELLA de las bonificaciones que hoy están dentro de adelantos (cantidad, monto y último id): la simulación la devuelve y la acreditación exige la MISMA. Si entre la revisión y la
  -- acreditación se registró un adelanto, la huella cambia y hay que volver a revisar (el operador decidió sobre una lista que ya no es la actual).
  SELECT md5(count(*)::text || '|' || COALESCE(sum(x.monto), 0)::text || '|' || COALESCE(max(x.id), 0)::text) INTO v_huella FROM public.meli_adelanto_ops x WHERE x.tipo = 'flex';
  IF NOT COALESCE(p_simular, FALSE) AND p_huella_adelantos IS DISTINCT FROM v_huella
     AND EXISTS (SELECT 1 FROM _flex_ops o WHERE NOT EXISTS (SELECT 1 FROM public.meli_flex_bonificaciones b WHERE b.referencia = o.referencia)) THEN
    RAISE EXCEPTION 'ADELANTOS_CAMBIARON' USING DETAIL = 'las bonificaciones dentro de adelantos cambiaron desde la revisión: hay que volver a revisar';
  END IF;
  -- Una sola bonificación suelta por orden: si la orden ya tiene una con OTRA referencia, se frena.
  SELECT string_agg(o.orden, ', ') INTO v_otra FROM _flex_ops o JOIN public.meli_flex_bonificaciones b ON b.orden_id = o.orden AND b.referencia <> o.referencia;
  IF v_otra IS NOT NULL THEN RAISE EXCEPTION 'ORDEN_CON_OTRA_BONIFICACION' USING DETAIL = v_otra; END IF;

  -- Un código que ya está en un adelanto se acredita por su adelanto; uno que ya está en el libro de cajas (y no es una acreditación suelta nuestra) se frena.
  SELECT string_agg(o.referencia, ', ') INTO v_adel FROM _flex_ops o WHERE EXISTS (SELECT 1 FROM public.meli_adelanto_ops x WHERE x.tipo = 'flex' AND x.referencia = o.referencia);
  IF v_adel IS NOT NULL THEN RAISE EXCEPTION 'REFERENCIA_EN_ADELANTO' USING DETAIL = v_adel; END IF;
  SELECT string_agg(o.referencia, ', ') INTO v_ledger FROM _flex_ops o
   WHERE EXISTS (SELECT 1 FROM public.caja_ledger l WHERE l.clave = 'meli-flex-' || o.referencia)
     AND NOT EXISTS (SELECT 1 FROM public.meli_flex_bonificaciones b WHERE b.referencia = o.referencia);
  IF v_ledger IS NOT NULL THEN RAISE EXCEPTION 'REFERENCIA_YA_EN_CAJA' USING DETAIL = v_ledger; END IF;

  -- Fase 1: se registran TODAS las filas (en orden de código); las que ya estaban se comparan (mismo monto y cuenta, o error).
  CREATE TEMP TABLE IF NOT EXISTS _flex_nuevas (referencia TEXT, monto NUMERIC) ON COMMIT DROP;
  DELETE FROM _flex_nuevas WHERE TRUE;
  FOR r IN SELECT referencia, monto, orden FROM _flex_ops ORDER BY referencia LOOP
    SELECT b.cuenta_id, b.monto, b.orden_id INTO v_prev FROM public.meli_flex_bonificaciones b WHERE b.referencia = r.referencia;
    IF FOUND THEN
      IF v_prev.monto <> r.monto OR v_prev.cuenta_id <> v_cuenta THEN RAISE EXCEPTION 'REFERENCIA_CON_OTRO_MONTO' USING DETAIL = r.referencia; END IF;
      IF v_prev.orden_id IS DISTINCT FROM r.orden THEN RAISE EXCEPTION 'REFERENCIA_CON_OTRA_ORDEN' USING DETAIL = r.referencia; END IF;
      v_ya := v_ya + 1;
      v_detalle := v_detalle || jsonb_build_array(jsonb_build_object('referencia', r.referencia, 'monto', r.monto, 'resultado', 'ya_acreditada'));
      CONTINUE;
    END IF;
    v_nuevas := v_nuevas + 1; v_monto_nuevo := v_monto_nuevo + r.monto;
    v_detalle := v_detalle || jsonb_build_array(jsonb_build_object('referencia', r.referencia, 'monto', r.monto,
                   'resultado', CASE WHEN COALESCE(p_simular, FALSE) THEN 'se_acreditaria' ELSE 'acreditada' END));
    IF NOT COALESCE(p_simular, FALSE) THEN
      INSERT INTO public.meli_flex_bonificaciones (referencia, cuenta_id, orden_id, monto, acreditado_por) VALUES (r.referencia, v_cuenta, r.orden, r.monto, v_usuario)
        ON CONFLICT (referencia) DO NOTHING RETURNING id INTO v_id;
      IF v_id IS NULL THEN RAISE EXCEPTION 'REFERENCIA_CON_OTRO_MONTO' USING DETAIL = r.referencia; END IF;       -- la registró otra sesión entre medio: se reintenta la llamada completa
      v_id := NULL;
      INSERT INTO _flex_nuevas VALUES (r.referencia, r.monto);
    END IF;
  END LOOP;

  -- Fase 2: recién ahora se mueve la plata (la caja ya está bloqueada y todas las filas registradas), en orden de código y con la clave que comparte con el adelanto.
  IF NOT COALESCE(p_simular, FALSE) THEN
    FOR r IN SELECT referencia, monto FROM _flex_nuevas ORDER BY referencia LOOP
      PERFORM public._caja_aplicar_delta(v_persona, v_bolsillo, r.monto, 'meli', r.referencia, 'Bonificación Flex por envío (suelta)', v_usuario, 'meli-flex-' || r.referencia);
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ok', true, 'simulado', COALESCE(p_simular, FALSE), 'cuenta_id', v_cuenta, 'persona_id', v_persona, 'persona', v_nombre, 'bolsillo', v_bolsillo,
                            'acreditadas', v_nuevas, 'monto', v_monto_nuevo, 'ya_acreditadas', v_ya, 'detalle', v_detalle,
                            'en_adelantos', (SELECT jsonb_build_object('cantidad', count(*), 'monto', COALESCE(sum(x.monto), 0), 'huella', v_huella,
                                              -- el detalle identificable (código · monto · adelanto), para contrastarlo con la fuente de Mercado Libre antes de confirmar; tope 2000 y, si hay más, 'truncada' = true (la pantalla no deja confirmar)
                                              'lista', COALESCE((SELECT jsonb_agg(jsonb_build_object('referencia', y.referencia, 'monto', y.monto, 'adelanto_id', y.adelanto_id) ORDER BY y.id DESC)
                                                                   FROM (SELECT z.id, z.referencia, z.monto, z.adelanto_id FROM public.meli_adelanto_ops z WHERE z.tipo = 'flex' ORDER BY z.id DESC LIMIT 2000) y), '[]'::jsonb),
                                              'truncada', count(*) > 2000)
                               FROM public.meli_adelanto_ops x WHERE x.tipo = 'flex'));
END;
$$;

-- ── Exclusión con el registro de adelantos ──────────────────────────────────
--  Registrar un adelanto con una bonificación (tipo 'flex') cuyo código ya se acreditó suelto se frena; y el bloqueo de la referencia es el mismo que toma meli_flex_acreditar.
CREATE OR REPLACE FUNCTION public.meli_flex_ref_en_adelanto()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE r RECORD;
BEGIN
  -- Por SENTENCIA y con las referencias ORDENADAS (el mismo orden que usa meli_flex_acreditar): dos registros de adelantos, o un adelanto y una suelta, no se cruzan aunque
  -- traigan los códigos en distinto orden. Como se ejecuta DESPUÉS de insertar, lo que mira (las bonificaciones sueltas) ya está confirmado por quien tenía el bloqueo.
  FOR r IN SELECT DISTINCT n.referencia FROM nuevas n WHERE n.tipo = 'flex' AND n.referencia IS NOT NULL ORDER BY n.referencia LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('meli-flex-ref:' || r.referencia, 0));
  END LOOP;
  IF EXISTS (SELECT 1 FROM nuevas n JOIN public.meli_flex_bonificaciones b ON b.referencia = n.referencia WHERE n.tipo = 'flex') THEN
    RAISE EXCEPTION 'REFERENCIA_YA_ACREDITADA_SUELTA' USING DETAIL = (SELECT string_agg(DISTINCT n.referencia, ', ') FROM nuevas n JOIN public.meli_flex_bonificaciones b ON b.referencia = n.referencia WHERE n.tipo = 'flex');
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.meli_flex_ref_en_adelanto() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS meli_flex_ref_en_adelanto ON public.meli_adelanto_ops;
CREATE TRIGGER meli_flex_ref_en_adelanto AFTER INSERT ON public.meli_adelanto_ops REFERENCING NEW TABLE AS nuevas FOR EACH STATEMENT EXECUTE FUNCTION public.meli_flex_ref_en_adelanto();

-- ── Lo que ve la pantalla ───────────────────────────────────────────────────
--  Las bonificaciones sueltas ya registradas: las de las órdenes indicadas (si se pasan) o las últimas.
DROP FUNCTION IF EXISTS public.meli_flex_estado(TEXT[]);
CREATE FUNCTION public.meli_flex_estado(p_ordenes TEXT[] DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  IF p_ordenes IS NOT NULL AND cardinality(p_ordenes) > 5000 THEN RAISE EXCEPTION 'DEMASIADAS_ORDENES'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('referencia', x.referencia, 'monto', x.monto, 'orden', x.orden_id, 'cuenta_id', x.cuenta_id,
                                        'acreditado_en', x.acreditado_en, 'acreditado_por', x.acreditado_por) ORDER BY x.id DESC)
      FROM (SELECT * FROM public.meli_flex_bonificaciones b
             WHERE p_ordenes IS NULL OR b.orden_id = ANY (p_ordenes) ORDER BY b.id DESC LIMIT CASE WHEN p_ordenes IS NULL THEN 500 ELSE 5000 END) x), '[]'::jsonb);          -- con una lista de órdenes se devuelven TODAS las pedidas (tope 5000 = el de la lista)
END;
$$;

REVOKE ALL ON FUNCTION public.meli_flex_acreditar(JSONB, BIGINT, BOOLEAN, BOOLEAN, UUID, TEXT, BOOLEAN, TEXT), public.meli_flex_estado(TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.meli_flex_acreditar(JSONB, BIGINT, BOOLEAN, BOOLEAN, UUID, TEXT, BOOLEAN, TEXT), public.meli_flex_estado(TEXT[]) TO authenticated;
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['service_role', 'agentes_ro', 'agentes_revisor'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.meli_flex_acreditar(JSONB, BIGINT, BOOLEAN, BOOLEAN, UUID, TEXT, BOOLEAN, TEXT), public.meli_flex_estado(TEXT[]) FROM %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;

-- Verificación (solo lectura): tiene que dar tres filas con ✅.
SELECT 'tabla y funciones' AS control,
       CASE WHEN to_regclass('public.meli_flex_bonificaciones') IS NOT NULL
             AND to_regprocedure('public.meli_flex_acreditar(jsonb,bigint,boolean,boolean,uuid,text,boolean,text)') IS NOT NULL
             AND to_regprocedure('public.meli_flex_estado(text[])') IS NOT NULL THEN '✅' ELSE '❌' END AS resultado
UNION ALL
SELECT 'tabla cerrada al navegador',
       CASE WHEN NOT has_table_privilege('anon', 'public.meli_flex_bonificaciones', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.meli_flex_bonificaciones', 'SELECT')
             AND NOT has_table_privilege('authenticated', 'public.meli_flex_bonificaciones', 'INSERT') THEN '✅' ELSE '❌' END
UNION ALL
SELECT 'funciones solo para usuarios autorizados',
       CASE WHEN NOT has_function_privilege('anon', 'public.meli_flex_acreditar(jsonb,bigint,boolean,boolean,uuid,text,boolean,text)', 'EXECUTE')
             AND NOT has_function_privilege('anon', 'public.meli_flex_estado(text[])', 'EXECUTE')
             AND has_function_privilege('authenticated', 'public.meli_flex_acreditar(jsonb,bigint,boolean,boolean,uuid,text,boolean,text)', 'EXECUTE')
             AND has_function_privilege('authenticated', 'public.meli_flex_estado(text[])', 'EXECUTE') THEN '✅' ELSE '❌' END;
