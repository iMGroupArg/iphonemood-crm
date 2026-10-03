-- ============================================================================
--  MERCADO LIBRE → VENTAS Y CAJAS  (parte de Ventas+Cueva)
--
--  PENDIENTE DE CORRER. Orden obligatorio (acordado con Deploy-infra):
--     1) caja_aplicar_delta.sql        (cajas atómicas e idempotentes)
--     2) stock_a_pedido.sql            (de Stock; el orden respecto de 3 no importa, repite su ADD COLUMN)
--     3) meli_esquema_base.sql         (tablas meli_*; esta migración las necesita por las FK)
--     4) ESTE ARCHIVO
--     5) stock_ajustar_rpc.sql
--
--  ANTES DE CORRER NADA (solo lectura, en el SQL Editor de Supabase, EN ESTE ORDEN)
--
--   (A) ¿Hay cajas duplicadas? (persona + bolsillo repetidos). Tiene que dar 0 filas.
--       Si da filas, NO seguir: hay que reconciliarlas a mano (dos filas con saldos
--       distintos; elegir una por nuestra cuenta haría desaparecer plata). caja_aplicar_delta.sql
--       y meli_esquema_base.sql crean un índice único y se frenan con este mismo chequeo.
--
--         SELECT persona_id, bolsillo, count(*) AS filas, array_agg(saldo) AS saldos
--           FROM public.cajas
--          GROUP BY persona_id, bolsillo
--         HAVING count(*) > 1;
--
--   (B) ¿Algún CHECK de ventas.estado no admite 'anulada'? Hay que mirarlo ANTES del
--       primer «Revertir»: si no admite 'anulada', revertir falla (y deshace todo, sin
--       dejar nada a medias). Si lista un CHECK que no menciona 'anulada', agregar el
--       valor a ese CHECK antes de usar Revertir.
--
--         SELECT conname, pg_get_constraintdef(oid) AS definicion
--           FROM pg_constraint
--          WHERE conrelid = 'public.ventas'::regclass AND contype = 'c';
--
--       Sin filas = no hay CHECKs en ventas, no hay nada que cambiar.
--
--  QUÉ HACE
--  Tres funciones, UNA transacción cada una, idempotentes, que convierten una orden
--  de Mercado Libre en venta + stock + caja SIN pasos sueltos desde el navegador
--  (en pasos separados, si la pestaña muere después de guardar el saldo, reintentar
--  acredita dos veces):
--
--    meli_procesar_orden(orden, cotización)   descuenta stock y crea la venta (ABIERTA, sin cobro)
--    meli_acreditar_orden(orden, monto?, final?)   acredita la caja cuando MELI libera la plata,
--                                              registra el cobro y deja explícito el costo del canal
--    meli_revertir_orden(orden, motivo)       deshace todo (cancelación/devolución, manual)
--
--  REGLAS (las que no se pueden romper)
--   · Una venta de Mercado Libre NO se borra nunca: FK ON DELETE RESTRICT en las dos
--     puntas. Una orden revertida deja la venta en estado 'anulada' (el CRM la filtra).
--   · El importe que entra a la caja es en PESOS exactos (monto_acreditado). La venta
--     queda en dólares con la cotización CONGELADA al procesar (ventas.meli_cotizacion):
--     la devaluación entre venta y liberación no se contabiliza como comisión.
--   · costo_canal_usd = total de la venta − lo realmente cobrado = comisión + envío de
--     Mercado Libre. Es un concepto EXPLÍCITO: no es quebranto ni deuda del cliente.
--   · Acreditar exige financiera_completa = TRUE, revisar = FALSE, neto y fecha de
--     liberación conocidos, fecha de liberación ya cumplida y la cuenta con persona y
--     bolsillo asignados. `neto` NULL nunca se toma como 0.
--   · Devoluciones y contracargos NO se restan por inferencia: la orden queda en
--     `revisar` y alguien la resuelve a mano con meli_revertir_orden.
--   · Moneda distinta de ARS: no se procesa.
--   · Todo corre con SECURITY DEFINER y search_path fijo; se revoca de PUBLIC (no
--     alcanza con anon/authenticated: heredan de PUBLIC) y se otorga SOLO a authenticated.
--     Cada función exige is_authorized_user().
--   · Orden de bloqueos: la fila de la orden primero (FOR UPDATE), después las filas de
--     stock (dentro de meli__descontar_core / meli_reponer_stock), después la venta y por
--     último las cajas (dentro de _caja_aplicar_delta): orden → stock → venta → caja. Es el mismo orden que usan la ingesta y el
--     descuento de Deploy-infra, así que no hay ciclo posible.
--
--  QUÉ NO HACE
--   · No toca la UI ni el código del navegador (eso va en ventas.js / meli.js).
--   · No verifica que `ventas.estado` admita el valor 'anulada': si hubiera un CHECK
--     sobre esa columna, ver el chequeo (1) del final antes de usar meli_revertir_orden.
-- ============================================================================

BEGIN;

-- ─── 0 · Guardas: que lo que necesitamos ya exista ──────────────────────────
DO $$
BEGIN
  IF to_regclass('public.meli_ordenes') IS NULL THEN
    RAISE EXCEPTION 'Falta meli_esquema_base.sql: correrlo ANTES de este archivo (necesita meli_ordenes)';
  END IF;
  IF to_regprocedure('public._caja_aplicar_delta(uuid,text,numeric,text,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'Falta caja_aplicar_delta.sql: correrlo ANTES de este archivo';
  END IF;
  IF to_regprocedure('public.meli__descontar_core(bigint)') IS NULL
     OR to_regprocedure('public.meli_reponer_stock(bigint)') IS NULL
     OR to_regprocedure('public.meli_agregar_motivo(text,text)') IS NULL THEN
    RAISE EXCEPTION 'meli_esquema_base.sql está incompleto o desactualizado (faltan funciones de stock o de motivos)';
  END IF;
END $$;


-- ─── 1 · Columnas y claves ──────────────────────────────────────────────────
ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS tipo_venta       TEXT,                 -- ya la escribe el CRM; por si faltara
  ADD COLUMN IF NOT EXISTS meli_orden_id    BIGINT,
  ADD COLUMN IF NOT EXISTS meli_cotizacion  NUMERIC(18,4),        -- ARS por USD, congelada al procesar
  ADD COLUMN IF NOT EXISTS costo_canal_usd  NUMERIC(18,2);        -- comisión + envío de MELI, en USD

ALTER TABLE public.meli_ordenes
  ADD COLUMN IF NOT EXISTS revertida_en         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acreditado_persona_id UUID,            -- la caja donde entró, para poder sacarla de ahí
  ADD COLUMN IF NOT EXISTS acreditado_bolsillo   TEXT;

-- Una orden ↔ una venta, y la venta NO se puede borrar mientras exista la orden
-- (DB.anularVenta hace DELETE: con esto falla en vez de borrar historia de plata).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ventas_meli_orden_fk') THEN
    ALTER TABLE public.ventas
      ADD CONSTRAINT ventas_meli_orden_fk
      FOREIGN KEY (meli_orden_id) REFERENCES public.meli_ordenes(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meli_ordenes_venta_fk') THEN
    ALTER TABLE public.meli_ordenes
      ADD CONSTRAINT meli_ordenes_venta_fk
      FOREIGN KEY (venta_id) REFERENCES public.ventas(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ventas_meli_orden_unica
  ON public.ventas (meli_orden_id) WHERE meli_orden_id IS NOT NULL;


-- ─── 2 · Procesar: descontar stock y crear la venta ─────────────────────────
--
--  Devuelve JSONB:
--    {ok:true,  venta_id, total_usd}            se procesó
--    {ok:true,  ya_procesada:true, venta_id}    ya estaba hecha (reintento seguro)
--    {ok:false, motivo, revisar}                no se pudo descontar el stock (IMEI, stock
--                                               insuficiente…): la orden queda en `revisar`
--                                               con el motivo; NO se crea la venta.
--  Todo lo demás son excepciones con nombre (no se escribe nada).
CREATE OR REPLACE FUNCTION public.meli_procesar_orden(p_orden_id BIGINT, p_cotizacion NUMERIC)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o            public.meli_ordenes%ROWTYPE;
  v_venta      BIGINT;
  v_suma       NUMERIC;
  v_total_usd  NUMERIC;
  v_sin_stock  INTEGER;
  v_fecha      DATE;
  v_cot        NUMERIC;       -- la cotización NORMALIZADA: la única que se usa en todo
  v_cents      BIGINT;
  v_cargado    NUMERIC;
BEGIN
  IF NOT public.is_authorized_user() THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501';
  END IF;
  -- La cotización se normaliza UNA vez a la precisión con que se guarda (4 decimales)
  -- y esa es la que usan el precio de los ítems, la columna meli_cotizacion y el cobro
  -- de la acreditación: si no, los tres podían diferir. Se rechaza NaN (pasa los
  -- controles de <= 0), infinito, valores que redondean a cero y absurdos.
  IF p_cotizacion IS NULL OR p_cotizacion = 'NaN'::numeric THEN
    RAISE EXCEPTION 'COTIZACION_INVALIDA';
  END IF;
  v_cot := round(p_cotizacion, 4);
  IF v_cot <= 0 OR v_cot > 1000000 THEN
    RAISE EXCEPTION 'COTIZACION_INVALIDA';
  END IF;

  -- Bloqueo de la orden ANTES de leer nada: ingesta, descuento, acreditación y
  -- reversión compiten por este mismo candado.
  SELECT * INTO o FROM public.meli_ordenes WHERE id = p_orden_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDEN_INEXISTENTE'; END IF;

  -- Revertida primero: una orden revertida tiene venta (anulada) y procesada = TRUE,
  -- y NO debe responder "ya procesada" como si siguiera viva.
  IF o.revertida_en IS NOT NULL THEN RAISE EXCEPTION 'ORDEN_REVERTIDA'; END IF;
  IF o.procesada AND o.venta_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'ya_procesada', true, 'venta_id', o.venta_id);
  END IF;
  IF o.revisar THEN
    RAISE EXCEPTION 'ORDEN_EN_REVISION' USING DETAIL = COALESCE(o.motivo_revisar, '');
  END IF;
  IF lower(COALESCE(o.estado, '')) <> 'paid' THEN RAISE EXCEPTION 'ORDEN_NO_PAGADA'; END IF;
  IF COALESCE(o.moneda, 'ARS') <> 'ARS' THEN RAISE EXCEPTION 'MONEDA_NO_SOPORTADA'; END IF;
  IF o.bruto IS NULL OR o.bruto <= 0 THEN RAISE EXCEPTION 'BRUTO_DESCONOCIDO'; END IF;

  SELECT count(*) FILTER (WHERE i.stock_id IS NULL OR i.cantidad <= 0),
         COALESCE(sum(i.precio_unitario * i.cantidad), 0)
    INTO v_sin_stock, v_suma
    FROM public.meli_orden_items i WHERE i.orden_id = o.id;
  IF NOT EXISTS (SELECT 1 FROM public.meli_orden_items WHERE orden_id = o.id) THEN
    RAISE EXCEPTION 'ORDEN_SIN_ITEMS';
  END IF;
  -- Un precio negativo o ausente rompe el reparto proporcional: se frena ANTES de tocar el stock.
  IF EXISTS (SELECT 1 FROM public.meli_orden_items
              WHERE orden_id = o.id AND (precio_unitario IS NULL OR precio_unitario < 0)) THEN
    RAISE EXCEPTION 'PRECIO_INVALIDO';
  END IF;
  IF v_sin_stock > 0 THEN RAISE EXCEPTION 'ITEMS_SIN_VINCULAR'; END IF;

  -- Stock, por delta y atómico. Si no se puede (IMEI, stock insuficiente) la función
  -- NO falla: deja la orden en `revisar` con el motivo y vuelve. Eso hay que
  -- CONSERVARLO, así que acá no se levanta excepción (se perdería el aviso).
  PERFORM 1 FROM public.meli__descontar_core(o.id);
  SELECT * INTO o FROM public.meli_ordenes WHERE id = p_orden_id;
  IF NOT o.stock_descontado THEN
    RETURN jsonb_build_object('ok', false, 'revisar', o.revisar,
      'motivo', COALESCE(o.motivo_revisar, 'No se pudo descontar el stock'));
  END IF;

  v_total_usd := round(o.bruto / v_cot, 2);
  v_cents := round(v_total_usd * 100)::BIGINT;
  v_fecha := (COALESCE(o.fecha_orden, now()) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;

  -- El nombre del comprador viene de FUERA (Mercado Libre) y el CRM lo pinta en muchas
  -- pantallas: se limpia acá, en el origen, de todo lo que pueda ser HTML o control
  -- (< > & comillas, acentos graves, saltos de línea) y se acota el largo.
  INSERT INTO public.ventas (cliente, estado, tipo_venta, fecha_venta, meli_orden_id, meli_cotizacion)
  VALUES (COALESCE(NULLIF(btrim(left(regexp_replace(COALESCE(o.comprador, ''), '[<>&"''`\\[:cntrl:]]', '', 'g'), 80)), ''), 'Mercado Libre'), 'abierta', 'mercadolibre',
          v_fecha, o.id, v_cot)
  RETURNING id INTO v_venta;

  -- Un renglón por UNIDAD (el motor de ventas no tiene cantidad). El total en dólares se
  -- reparte en CENTAVOS ENTEROS proporcionalmente al precio de cada unidad: cada una
  -- recibe el piso de su parte y los centavos que sobran van de a uno a las primeras.
  -- Así ningún precio puede dar negativo y la suma es EXACTAMENTE el total.
  -- Orden fijo (ítem, unidad): reintentos y auditorías ven siempre lo mismo.
  WITH u AS (
    SELECT i.stock_id, i.titulo, COALESCE(i.precio_unitario, 0) AS p,
           row_number() OVER (ORDER BY i.id, g.n) AS rn
      FROM public.meli_orden_items i
     CROSS JOIN LATERAL generate_series(1, i.cantidad) AS g(n)
     WHERE i.orden_id = o.id),
  tot AS (SELECT count(*) AS cnt, COALESCE(sum(p), 0) AS suma FROM u),
  base AS (
    SELECT u.*, CASE WHEN tot.suma > 0 THEN floor(v_cents * u.p / tot.suma)
                     ELSE floor(v_cents::numeric / NULLIF(tot.cnt, 0)) END AS c
      FROM u CROSS JOIN tot),
  resto AS (SELECT v_cents - COALESCE(sum(c), 0) AS r FROM base)
  INSERT INTO public.venta_items (venta_id, stock_id, imei, nombre, costo_usd, precio_usd, es_regalo)
  SELECT v_venta, b.stock_id, NULL, COALESCE(s.nombre, b.titulo, 'Producto Mercado Libre'),
         COALESCE(s.costo_usd, 0),
         (b.c + CASE WHEN b.rn <= (SELECT r FROM resto) THEN 1 ELSE 0 END) / 100.0,
         FALSE
    FROM base b
    JOIN public.stock s ON s.id = b.stock_id
   ORDER BY b.rn;

  SELECT COALESCE(sum(precio_usd), 0) INTO v_cargado FROM public.venta_items WHERE venta_id = v_venta;
  IF v_cargado = 0 AND v_cents > 0 THEN RAISE EXCEPTION 'ORDEN_SIN_ITEMS'; END IF;
  IF v_cargado <> v_total_usd THEN RAISE EXCEPTION 'REPARTO_INCONSISTENTE'; END IF;

  UPDATE public.meli_ordenes
     SET procesada = TRUE, venta_id = v_venta, actualizado_en = now()
   WHERE id = o.id;

  RETURN jsonb_build_object('ok', true, 'venta_id', v_venta, 'total_usd', v_total_usd);
END;
$$;


-- ─── 3 · Acreditar: entra la plata a la caja y se registra el cobro ─────────
--
--  p_monto_real  lo que REALMENTE llegó a la cuenta de Mercado Pago, confirmado a mano.
--                NULL = se toma el neto informado por MELI.
--  p_liquidacion_final  confirma que llegó MENOS que el neto y que ya no va a llegar más
--                (si no, se rechaza: un monto menor casi siempre es un error de carga).
--
--  Un monto MAYOR al bruto se rechaza (MONTO_MAYOR_AL_BRUTO): no es una comisión
--  negativa, es un dato mal cargado o un caso para revisar.
--  Idempotente: si ya estaba acreditada devuelve {ok:true, ya_acreditada:true}.
CREATE OR REPLACE FUNCTION public.meli_acreditar_orden(
  p_orden_id           BIGINT,
  p_monto_real         NUMERIC DEFAULT NULL,
  p_liquidacion_final  BOOLEAN DEFAULT FALSE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o            public.meli_ordenes%ROWTYPE;
  v_persona    UUID;
  v_bolsillo   TEXT;
  v_monto      NUMERIC;
  v_cot        NUMERIC;
  v_total_usd  NUMERIC;
  v_cobrado    NUMERIC;
  v_usuario    TEXT;
BEGIN
  IF NOT public.is_authorized_user() THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO o FROM public.meli_ordenes WHERE id = p_orden_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDEN_INEXISTENTE'; END IF;

  IF o.acreditado AND o.revertida_en IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'ya_acreditada', true, 'venta_id', o.venta_id, 'monto', o.monto_acreditado);
  END IF;
  IF o.revertida_en IS NOT NULL THEN RAISE EXCEPTION 'ORDEN_REVERTIDA'; END IF;
  IF NOT o.procesada OR o.venta_id IS NULL THEN RAISE EXCEPTION 'ORDEN_NO_PROCESADA'; END IF;
  IF o.revisar THEN RAISE EXCEPTION 'ORDEN_EN_REVISION' USING DETAIL = COALESCE(o.motivo_revisar, ''); END IF;
  IF NOT o.financiera_completa THEN RAISE EXCEPTION 'FINANCIERA_INCOMPLETA'; END IF;
  IF o.neto IS NULL OR o.bruto IS NULL OR o.fecha_liberacion IS NULL THEN
    RAISE EXCEPTION 'IMPORTES_INCOMPLETOS';
  END IF;
  IF o.fecha_liberacion > now() THEN RAISE EXCEPTION 'TODAVIA_NO_LIBERADA'; END IF;

  SELECT c.persona_id, c.bolsillo INTO v_persona, v_bolsillo
    FROM public.meli_cuentas c WHERE c.id = o.cuenta_id;
  IF v_persona IS NULL OR COALESCE(btrim(v_bolsillo), '') = '' THEN
    RAISE EXCEPTION 'CUENTA_SIN_CAJA';
  END IF;

  v_monto := round(COALESCE(p_monto_real, o.neto), 2);
  IF v_monto IS NULL OR v_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF v_monto > o.bruto THEN RAISE EXCEPTION 'MONTO_MAYOR_AL_BRUTO'; END IF;
  IF v_monto < o.neto AND NOT COALESCE(p_liquidacion_final, FALSE) THEN
    RAISE EXCEPTION 'MONTO_MENOR_AL_NETO';
  END IF;

  v_usuario := COALESCE(
    NULLIF(auth.jwt() -> 'user_metadata' ->> 'full_name', ''),
    NULLIF(auth.jwt() ->> 'email', ''), 'Desconocido');

  -- Orden de bloqueos: orden → ventas → caja (la venta se bloquea ANTES de mover la plata).
  SELECT v.meli_cotizacion INTO v_cot FROM public.ventas v WHERE v.id = o.venta_id FOR UPDATE;
  IF v_cot IS NULL OR v_cot <= 0 THEN RAISE EXCEPTION 'VENTA_SIN_COTIZACION'; END IF;
  SELECT COALESCE(sum(precio_usd), 0) INTO v_total_usd FROM public.venta_items WHERE venta_id = o.venta_id;

  -- Lo cobrado en dólares, a la cotización CONGELADA. Nunca más que el total: el
  -- redondeo de centavos no puede inventar un cobro de más.
  v_cobrado := LEAST(round(v_monto / v_cot, 2), v_total_usd);

  -- La fila de caja tiene que existir (la función de saldo solo hace UPDATE). Va DESPUÉS
  -- de bloquear la venta, para no tomar la caja antes que ella.
  INSERT INTO public.cajas (persona_id, bolsillo, saldo)
  VALUES (v_persona, v_bolsillo, 0)
  ON CONFLICT (persona_id, bolsillo) DO NOTHING;

  -- La plata y el estado de la orden en la MISMA transacción: o pasa todo o nada.
  -- La clave es estable: aunque algo la repitiera, no entra dos veces.
  PERFORM public._caja_aplicar_delta(v_persona, v_bolsillo, v_monto, 'meli', o.meli_order_id,
            'Acreditación Mercado Libre — orden ' || o.meli_order_id, v_usuario,
            'meli-acreditar-' || o.id);

  INSERT INTO public.venta_pagos (venta_id, persona_id, bolsillo, monto, es_tarjeta, diferencial_ars, cotizacion_diferencial)
  VALUES (o.venta_id, v_persona, v_bolsillo, v_cobrado, FALSE, 0, v_cot);

  UPDATE public.ventas
     SET estado = 'cerrada', costo_canal_usd = round(v_total_usd - v_cobrado, 2)
   WHERE id = o.venta_id;

  UPDATE public.meli_ordenes
     SET acreditado = TRUE, monto_acreditado = v_monto, acreditado_en = now(),
         acreditado_persona_id = v_persona, acreditado_bolsillo = v_bolsillo,
         actualizado_en = now()
   WHERE id = o.id;

  RETURN jsonb_build_object('ok', true, 'venta_id', o.venta_id, 'monto', v_monto,
                            'cobrado_usd', v_cobrado, 'costo_canal_usd', round(v_total_usd - v_cobrado, 2));
END;
$$;


-- ─── 4 · Revertir: cancelación / devolución, SIEMPRE manual ─────────────────
--
--  v1: revierte la orden ENTERA (no hay devolución parcial). Saca de la caja lo que
--  entró (en la MISMA caja donde entró), repone el stock y deja la venta 'anulada'
--  (nunca se borra). Idempotente.
CREATE OR REPLACE FUNCTION public.meli_revertir_orden(p_orden_id BIGINT, p_motivo TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o          public.meli_ordenes%ROWTYPE;
  v_usuario  TEXT;
BEGIN
  IF NOT public.is_authorized_user() THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO o FROM public.meli_ordenes WHERE id = p_orden_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDEN_INEXISTENTE'; END IF;

  IF o.revertida_en IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'ya_revertida', true, 'venta_id', o.venta_id);
  END IF;
  IF NOT o.procesada OR o.venta_id IS NULL THEN RAISE EXCEPTION 'ORDEN_NO_PROCESADA'; END IF;

  v_usuario := COALESCE(
    NULLIF(auth.jwt() -> 'user_metadata' ->> 'full_name', ''),
    NULLIF(auth.jwt() ->> 'email', ''), 'Desconocido');

  -- Orden de bloqueos: orden → stock → venta → caja (el mismo de todo el archivo).
  IF o.stock_descontado THEN
    PERFORM 1 FROM public.meli_reponer_stock(o.id);
  END IF;
  PERFORM 1 FROM public.ventas WHERE id = o.venta_id FOR UPDATE;

  IF o.acreditado THEN
    IF o.acreditado_persona_id IS NULL OR o.acreditado_bolsillo IS NULL OR COALESCE(o.monto_acreditado, 0) <= 0 THEN
      RAISE EXCEPTION 'ACREDITACION_SIN_DATOS';
    END IF;
    PERFORM public._caja_aplicar_delta(o.acreditado_persona_id, o.acreditado_bolsillo, -o.monto_acreditado,
              'meli_reverso', o.meli_order_id,
              'Reverso de la orden de Mercado Libre ' || o.meli_order_id, v_usuario,
              'meli-revertir-' || o.id);
  END IF;

  UPDATE public.ventas SET estado = 'anulada' WHERE id = o.venta_id;

  UPDATE public.meli_ordenes
     SET revertida_en = now(), revisar = FALSE,
         motivo_revisar = public.meli_agregar_motivo(motivo_revisar,
                            'Revertida por ' || v_usuario || COALESCE(': ' || NULLIF(btrim(p_motivo), ''), '')),
         actualizado_en = now()
   WHERE id = o.id;

  RETURN jsonb_build_object('ok', true, 'venta_id', o.venta_id, 'caja_devuelta', o.acreditado);
END;
$$;


-- ─── 5 · Permisos ───────────────────────────────────────────────────────────
-- Postgres le da EXECUTE a PUBLIC por defecto y anon/authenticated lo heredan: hay
-- que revocar de PUBLIC. Cada función además se defiende con is_authorized_user().
REVOKE EXECUTE ON FUNCTION public.meli_procesar_orden(BIGINT, NUMERIC)            FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.meli_acreditar_orden(BIGINT, NUMERIC, BOOLEAN)  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.meli_revertir_orden(BIGINT, TEXT)               FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.meli_procesar_orden(BIGINT, NUMERIC)            TO authenticated;
GRANT  EXECUTE ON FUNCTION public.meli_acreditar_orden(BIGINT, NUMERIC, BOOLEAN)  TO authenticated;
GRANT  EXECUTE ON FUNCTION public.meli_revertir_orden(BIGINT, TEXT)               TO authenticated;

COMMIT;

-- ============================================================================
--  VERIFICACIÓN (después de correr)
--  (1) ¿Hay un CHECK sobre ventas.estado que no admita 'anulada'?
--        SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--         WHERE conrelid = 'public.ventas'::regclass AND contype = 'c';
--      Si lista algo sobre estado sin 'anulada', agregar el valor antes de revertir órdenes.
--  (2) Las tres funciones existen y NO las ve anon:
--        SELECT proname, proacl FROM pg_proc WHERE proname LIKE 'meli_%_orden';
--  (3) Probar el ciclo completo con UNA orden real en modo observación: procesar →
--      mirar stock y venta → (cuando MELI libere) acreditar → mirar caja y libro →
--      revertir. El control de cuadre de Cajas tiene que seguir dando 0.
-- ============================================================================
