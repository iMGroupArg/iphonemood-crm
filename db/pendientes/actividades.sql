-- ============================================================================
--  actividades.sql  (script 15) — ACTIVIDADES: "TRANSFERIR LO QUE LIBERA MERCADO LIBRE A LA CUENTA DE LA EMPRESA"
--
--  QUÉ HACE
--   · Tabla `actividades` (tareas con estado). Escritura SOLO por funciones; lectura para usuarios autorizados.
--   · Cuando una orden de Mercado Libre pasa a "acreditada" (meli_acreditar_orden), un trigger crea UNA actividad
--     'meli_transferir' (clave meli-transf-<orden>) en la MISMA transacción. No se reescribe meli_acreditar_orden.
--   · Funciones: actividad_transferir (mueve la plata entre cajas Y marca hecha, en una transacción),
--     actividad_marcar_hecha (solo marca), actividad_reabrir, actividad_anular, actividad_compensar (deshace una
--     transferencia con un traspaso inverso), actividad_crear (manual).
--   · Revertir una orden cuya plata ya se transfirió por el CRM queda BLOQUEADO (ORDEN_YA_TRANSFERIDA) hasta
--     compensar. Una actividad pendiente de una orden revertida pasa a 'anulada'.
--
--  REGLAS DE BLOQUEO (mismo orden que acreditar / revertir: orden → … → caja, nunca al revés)
--   orden (FOR UPDATE) → actividad (FOR UPDATE) → las dos cajas (orden fijo persona, bolsillo).
--
--  ATOMICIDAD: si el INSERT de la actividad fallara, la acreditación entera se deshace (caja, pago, venta). Es la
--  política elegida: silenciar el error perdería actividades.
--
--  REQUISITOS: scripts 1 (caja_aplicar_delta), 3, 4 y 12 corridos. Idempotente. No cambia ningún dato existente;
--  las órdenes acreditadas ANTES de este script no generan actividad solas.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.meli_ordenes') IS NULL
     OR to_regprocedure('public._caja_mover_atomico(uuid,text,uuid,text,numeric,numeric,text,text,text,text,text,text)') IS NULL
     OR to_regprocedure('public.meli_acreditar_orden(bigint,numeric,boolean)') IS NULL
     OR to_regprocedure('public.meli_orden_cerrar_manual(bigint,text,bigint,text)') IS NULL THEN
    RAISE EXCEPTION 'Faltan los scripts 1, 3, 4 y/o 12 (caja_aplicar_delta, meli_esquema_base, meli_ventas_migration, meli_cerrar_manual). Correrlos antes que este.';
  END IF;
END $$;

BEGIN;

-- ── 0 · Versiones anteriores de las funciones (el cambio de firma deja la vieja como sobrecarga: se borra) ─
DROP FUNCTION IF EXISTS public.actividad_transferir(BIGINT, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.actividad_compensar(BIGINT, TEXT);
DROP FUNCTION IF EXISTS public.actividad_marcar_hecha(BIGINT, TEXT);
DROP FUNCTION IF EXISTS public.actividad_reabrir(BIGINT);
DROP FUNCTION IF EXISTS public.actividad_anular(BIGINT);

-- ── 1 · Tabla ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.actividades (
  id                 BIGSERIAL PRIMARY KEY,
  tipo               TEXT        NOT NULL,
  titulo             TEXT        NOT NULL,
  monto              NUMERIC(18,2),   -- igual que meli_ordenes.monto_acreditado: una acreditación válida nunca puede chocar con esto
  moneda             TEXT,
  fecha_objetivo     DATE        NOT NULL,
  estado             TEXT        NOT NULL DEFAULT 'pendiente',
  clave_unica        TEXT,
  origen_orden_id    BIGINT,
  origen_persona_id  UUID,
  origen_bolsillo    TEXT,
  destino_persona_id UUID,
  destino_bolsillo   TEXT,
  movio_plata        BOOLEAN     NOT NULL DEFAULT FALSE,
  intento            INTEGER     NOT NULL DEFAULT 1,    -- cada transferencia tras una compensación usa una clave nueva
  revision           INTEGER     NOT NULL DEFAULT 1,    -- sube con CADA cambio de estado: un pedido viejo no puede pisar uno más nuevo
  token              UUID        NOT NULL DEFAULT gen_random_uuid(),   -- parte NO adivinable de las claves de caja de esta actividad
  nota               TEXT,
  creada_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
  creada_por         TEXT,
  hecha_en           TIMESTAMPTZ,
  hecha_por          TEXT,
  CONSTRAINT actividades_tipo_ck    CHECK (tipo IN ('meli_transferir', 'manual')),
  CONSTRAINT actividades_estado_ck  CHECK (estado IN ('pendiente', 'hecha', 'anulada')),
  CONSTRAINT actividades_titulo_ck  CHECK (length(btrim(titulo)) BETWEEN 1 AND 200),
  CONSTRAINT actividades_monto_ck   CHECK (monto IS NULL OR monto > 0),
  CONSTRAINT actividades_moneda_ck  CHECK (moneda IS NULL OR moneda IN ('ARS', 'USD', 'USDT')),
  CONSTRAINT actividades_nota_ck    CHECK (nota IS NULL OR length(nota) <= 400),
  CONSTRAINT actividades_hecha_ck   CHECK (estado <> 'hecha' OR (hecha_en IS NOT NULL AND hecha_por IS NOT NULL)),
  CONSTRAINT actividades_movio_ck   CHECK (NOT movio_plata OR (estado = 'hecha' AND destino_persona_id IS NOT NULL
                                           AND destino_bolsillo IS NOT NULL AND origen_persona_id IS NOT NULL
                                           AND origen_bolsillo IS NOT NULL AND monto IS NOT NULL)),
  CONSTRAINT actividades_meli_ck    CHECK (tipo <> 'meli_transferir' OR (origen_orden_id IS NOT NULL AND origen_persona_id IS NOT NULL
                                           AND origen_bolsillo IS NOT NULL AND monto IS NOT NULL AND moneda = 'ARS')),
  CONSTRAINT actividades_orden_fk   FOREIGN KEY (origen_orden_id) REFERENCES public.meli_ordenes(id) ON DELETE RESTRICT,
  CONSTRAINT actividades_clave_uq   UNIQUE (clave_unica)
);
-- Una sola actividad de transferencia por orden (además de la clave).
CREATE UNIQUE INDEX IF NOT EXISTS actividades_una_por_orden
  ON public.actividades (origen_orden_id) WHERE tipo = 'meli_transferir';
CREATE INDEX IF NOT EXISTS actividades_estado_fecha ON public.actividades (estado, fecha_objetivo);
-- Si el script se corrió antes en una versión anterior, se deja la tabla como la versión vigente.
ALTER TABLE public.actividades ADD COLUMN IF NOT EXISTS token UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.actividades ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.actividades ALTER COLUMN monto TYPE NUMERIC(18,2);
ALTER TABLE public.actividades DROP CONSTRAINT IF EXISTS actividades_monto_ck;
ALTER TABLE public.actividades ADD CONSTRAINT actividades_monto_ck CHECK (monto IS NULL OR monto > 0);

-- Escritura directa cerrada para todos los roles de la API; lectura solo para usuarios autorizados.
ALTER TABLE public.actividades ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS actividades_lectura ON public.actividades;
CREATE POLICY actividades_lectura ON public.actividades FOR SELECT TO authenticated USING (public.is_authorized_user());
REVOKE ALL ON public.actividades FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.actividades TO authenticated;
REVOKE ALL ON SEQUENCE public.actividades_id_seq FROM PUBLIC, anon, authenticated;

-- La revisión sube sola con cada cambio de estado (desde cualquier camino: funciones y triggers de la orden).
CREATE OR REPLACE FUNCTION public.actividad__revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.estado IS DISTINCT FROM OLD.estado OR NEW.movio_plata IS DISTINCT FROM OLD.movio_plata OR NEW.intento IS DISTINCT FROM OLD.intento THEN
    NEW.revision := OLD.revision + 1;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS actividad_revision ON public.actividades;
CREATE TRIGGER actividad_revision BEFORE UPDATE ON public.actividades FOR EACH ROW EXECUTE FUNCTION public.actividad__revision();

-- ── 2 · Ayudas internas (sin ejecución pública) ────────────────────────────
CREATE OR REPLACE FUNCTION public.actividad__usuario() RETURNS TEXT
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(NULLIF(auth.jwt() -> 'user_metadata' ->> 'full_name', ''), NULLIF(auth.jwt() ->> 'email', ''), 'Desconocido')
$$;

CREATE OR REPLACE FUNCTION public.actividad__nota_ok(p_nota TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE v TEXT := NULLIF(btrim(COALESCE(p_nota, '')), '');
BEGIN
  IF v IS NOT NULL AND (length(v) > 200 OR v ~ '[[:cntrl:]]') THEN RAISE EXCEPTION 'NOTA_INVALIDA'; END IF;
  RETURN v;
END $$;

-- Bloquea en el orden de la casa: PRIMERO la orden (si la actividad viene de una), DESPUÉS la actividad.
-- Devuelve la actividad ya bloqueada y releída (puede haber cambiado mientras se esperaba).
CREATE OR REPLACE FUNCTION public.actividad__bloquear(p_id BIGINT) RETURNS public.actividades
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.actividades%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.actividades WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACTIVIDAD_INEXISTENTE'; END IF;
  IF a.origen_orden_id IS NOT NULL THEN
    PERFORM 1 FROM public.meli_ordenes WHERE id = a.origen_orden_id FOR UPDATE;
  END IF;
  SELECT * INTO a FROM public.actividades WHERE id = p_id FOR UPDATE;
  RETURN a;
END $$;

-- ── 3 · Triggers sobre meli_ordenes ────────────────────────────────────────
-- Crear la actividad al ACREDITAR: solo cuando acreditado pasa de no-verdadero a verdadero, con los datos
-- CONFIRMADOS de la acreditación. No vuelve a actualizar meli_ordenes.
CREATE OR REPLACE FUNCTION public.meli__actividad_crear() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO public.actividades (tipo, titulo, monto, moneda, fecha_objetivo, clave_unica, origen_orden_id,
                                  origen_persona_id, origen_bolsillo, creada_por)
  VALUES ('meli_transferir', left('Transferir lo acreditado de la orden ' || NEW.meli_order_id || ' a la cuenta de la empresa', 200),
          NEW.monto_acreditado, 'ARS',
          (COALESCE(NEW.acreditado_en, now()) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,
          'meli-transf-' || NEW.id, NEW.id, NEW.acreditado_persona_id, NEW.acreditado_bolsillo,
          public.actividad__usuario())
  ON CONFLICT (clave_unica) DO NOTHING;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS meli_actividad_crear ON public.meli_ordenes;
CREATE TRIGGER meli_actividad_crear
  AFTER UPDATE ON public.meli_ordenes
  FOR EACH ROW
  WHEN (OLD.acreditado IS NOT TRUE AND NEW.acreditado IS TRUE)
  EXECUTE FUNCTION public.meli__actividad_crear();

-- Al REVERTIR la orden: pendiente → anulada; transferida por el CRM → se rechaza la reversión; hecha sin mover plata →
-- queda y se agrega una nota. Corre BEFORE para poder frenar la reversión (la reversión ya tiene bloqueada la orden:
-- el orden de bloqueos es el mismo que el de las funciones de actividades).
CREATE OR REPLACE FUNCTION public.meli__actividad_reversion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.actividades%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.actividades WHERE origen_orden_id = NEW.id AND tipo = 'meli_transferir' FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF a.movio_plata THEN
    RAISE EXCEPTION 'ORDEN_YA_TRANSFERIDA' USING DETAIL = 'La plata ya se pasó a otra caja por la actividad ' || a.id || '. Compensala primero.';
  ELSIF a.estado = 'pendiente' THEN
    UPDATE public.actividades SET estado = 'anulada', nota = left(COALESCE(nota || ' · ', '') || 'Anulada: la orden se revirtió', 400) WHERE id = a.id;
  ELSIF a.estado = 'hecha' THEN
    UPDATE public.actividades SET nota = left(COALESCE(nota || ' · ', '') || 'La orden se revirtió después de marcarla hecha', 400) WHERE id = a.id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS meli_actividad_reversion ON public.meli_ordenes;
CREATE TRIGGER meli_actividad_reversion
  BEFORE UPDATE ON public.meli_ordenes
  FOR EACH ROW
  WHEN (OLD.revertida_en IS NULL AND NEW.revertida_en IS NOT NULL)
  EXECUTE FUNCTION public.meli__actividad_reversion();

-- ── 4 · Funciones públicas ─────────────────────────────────────────────────
-- Transferir: mueve la plata entre cajas Y marca la actividad en UNA transacción.
CREATE OR REPLACE FUNCTION public.actividad_transferir(
  p_id BIGINT, p_intento INTEGER, p_destino_persona UUID, p_destino_bolsillo TEXT, p_nota TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a        public.actividades%ROWTYPE;
  o        public.meli_ordenes%ROWTYPE;
  v_nota   TEXT := public.actividad__nota_ok(p_nota);
  v_user   TEXT := public.actividad__usuario();
  v_saldo  NUMERIC;
  v_clave  TEXT;
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  a := public.actividad__bloquear(p_id);

  -- El pedido dice qué intento vio la pantalla: un reintento atrasado (de antes de una compensación) no puede
  -- ejecutarse como si fuera nuevo ni deshacer lo que vino después.
  IF p_intento IS NULL THEN RAISE EXCEPTION 'INTENTO_REQUERIDO'; END IF;
  IF a.intento <> p_intento THEN RAISE EXCEPTION 'ACTIVIDAD_DESACTUALIZADA'; END IF;
  IF a.tipo <> 'meli_transferir' THEN RAISE EXCEPTION 'ACTIVIDAD_NO_TRANSFERIBLE'; END IF;
  IF a.estado = 'anulada' THEN RAISE EXCEPTION 'ACTIVIDAD_ANULADA'; END IF;
  IF a.estado = 'hecha' THEN
    IF a.movio_plata AND a.destino_persona_id IS NOT DISTINCT FROM p_destino_persona AND a.destino_bolsillo = p_destino_bolsillo THEN
      RETURN jsonb_build_object('ok', true, 'ya_hecha', true, 'movio_plata', true, 'monto', a.monto);
    ELSIF a.movio_plata THEN RAISE EXCEPTION 'ACTIVIDAD_YA_TRANSFERIDA_A_OTRA_CAJA';
    ELSE RAISE EXCEPTION 'ACTIVIDAD_YA_MARCADA_SIN_MOVER'; END IF;
  END IF;

  -- La orden tiene que seguir acreditada, sin revertir ni cerrar a mano (revalidado bajo el bloqueo).
  SELECT * INTO o FROM public.meli_ordenes WHERE id = a.origen_orden_id;
  IF NOT o.acreditado OR o.revertida_en IS NOT NULL OR o.cerrada_manual_en IS NOT NULL THEN RAISE EXCEPTION 'ORDEN_NO_TRANSFERIBLE'; END IF;

  IF p_destino_persona IS NULL OR COALESCE(btrim(p_destino_bolsillo), '') = '' THEN RAISE EXCEPTION 'DESTINO_INCOMPLETO'; END IF;
  -- Convención de TODO el CRM (State.monedaDeBolsillo): un bolsillo cuyo nombre empieza con «ARS» es de pesos.
  IF p_destino_bolsillo !~ '^ARS' OR a.origen_bolsillo !~ '^ARS' THEN RAISE EXCEPTION 'CAJA_NO_EN_PESOS'; END IF;
  IF p_destino_persona IS NOT DISTINCT FROM a.origen_persona_id AND p_destino_bolsillo = a.origen_bolsillo THEN RAISE EXCEPTION 'DESTINO_IGUAL_ORIGEN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cajas WHERE persona_id = p_destino_persona AND bolsillo = p_destino_bolsillo) THEN RAISE EXCEPTION 'CAJA_DESTINO_INEXISTENTE'; END IF;

  -- Las dos cajas, en orden fijo (persona, bolsillo); recién ahí se mira el saldo del origen.
  PERFORM 1 FROM public.cajas
   WHERE (persona_id, bolsillo) IN ((a.origen_persona_id, a.origen_bolsillo), (p_destino_persona, p_destino_bolsillo))
   ORDER BY persona_id, bolsillo FOR UPDATE;
  SELECT saldo INTO v_saldo FROM public.cajas WHERE persona_id = a.origen_persona_id AND bolsillo = a.origen_bolsillo;
  IF v_saldo IS NULL THEN RAISE EXCEPTION 'CAJA_ORIGEN_INEXISTENTE'; END IF;
  IF v_saldo < a.monto THEN RAISE EXCEPTION 'SALDO_INSUFICIENTE' USING DETAIL = 'La caja de origen tiene ' || v_saldo || ' y hay que mover ' || a.monto; END IF;

  v_clave := 'act-' || a.token || '-t' || a.intento;
  PERFORM * FROM public._caja_mover_atomico(
    a.origen_persona_id, a.origen_bolsillo, p_destino_persona, p_destino_bolsillo, a.monto, a.monto,
    'movimiento', o.meli_order_id,
    'Transferencia a la cuenta de la empresa (orden ' || o.meli_order_id || ')',
    'Transferencia desde Mercado Pago (orden ' || o.meli_order_id || ')', v_user, v_clave);

  UPDATE public.actividades
     SET estado = 'hecha', movio_plata = TRUE, destino_persona_id = p_destino_persona, destino_bolsillo = p_destino_bolsillo,
         hecha_en = now(), hecha_por = v_user, nota = COALESCE(v_nota, nota)
   WHERE id = a.id;
  RETURN jsonb_build_object('ok', true, 'movio_plata', true, 'monto', a.monto);
END $$;

-- Solo marcar: «lo transferí afuera y NO quiero que el CRM mueva plata».
CREATE OR REPLACE FUNCTION public.actividad_marcar_hecha(p_id BIGINT, p_revision INTEGER, p_nota TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.actividades%ROWTYPE; v_nota TEXT := public.actividad__nota_ok(p_nota); v_user TEXT := public.actividad__usuario();
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  a := public.actividad__bloquear(p_id);
  IF p_revision IS NULL THEN RAISE EXCEPTION 'REVISION_REQUERIDA'; END IF;
  -- Un reintento de algo que YA se aplicó se responde igual (idempotente); cualquier otro pedido viejo se rechaza.
  IF a.estado = 'hecha' AND NOT a.movio_plata AND a.revision >= p_revision THEN
    RETURN jsonb_build_object('ok', true, 'ya_hecha', true, 'movio_plata', false);
  END IF;
  IF a.revision <> p_revision THEN RAISE EXCEPTION 'ACTIVIDAD_DESACTUALIZADA'; END IF;
  IF a.estado = 'anulada' THEN RAISE EXCEPTION 'ACTIVIDAD_ANULADA'; END IF;
  IF a.estado = 'hecha' THEN
    IF a.movio_plata THEN RAISE EXCEPTION 'ACTIVIDAD_YA_TRANSFERIDA'; END IF;
    RETURN jsonb_build_object('ok', true, 'ya_hecha', true, 'movio_plata', false);
  END IF;
  UPDATE public.actividades SET estado = 'hecha', hecha_en = now(), hecha_por = v_user, nota = COALESCE(v_nota, nota) WHERE id = a.id;
  RETURN jsonb_build_object('ok', true, 'movio_plata', false);
END $$;

-- Reabrir: solo una actividad hecha SIN mover plata y cuya orden no se revirtió.
CREATE OR REPLACE FUNCTION public.actividad_reabrir(p_id BIGINT, p_revision INTEGER)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.actividades%ROWTYPE; r TIMESTAMPTZ;
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  a := public.actividad__bloquear(p_id);
  IF p_revision IS NULL THEN RAISE EXCEPTION 'REVISION_REQUERIDA'; END IF;
  IF a.estado = 'pendiente' AND a.revision >= p_revision AND a.revision > 1 THEN RETURN jsonb_build_object('ok', true, 'ya_pendiente', true); END IF;
  IF a.revision <> p_revision THEN RAISE EXCEPTION 'ACTIVIDAD_DESACTUALIZADA'; END IF;
  IF a.estado = 'pendiente' THEN RETURN jsonb_build_object('ok', true, 'ya_pendiente', true); END IF;
  IF a.estado <> 'hecha' THEN RAISE EXCEPTION 'ACTIVIDAD_NO_REABRIBLE'; END IF;
  IF a.movio_plata THEN RAISE EXCEPTION 'ACTIVIDAD_YA_TRANSFERIDA'; END IF;
  IF a.origen_orden_id IS NOT NULL THEN
    SELECT revertida_en INTO r FROM public.meli_ordenes WHERE id = a.origen_orden_id;
    IF r IS NOT NULL THEN RAISE EXCEPTION 'ORDEN_REVERTIDA'; END IF;
  END IF;
  UPDATE public.actividades SET estado = 'pendiente', hecha_en = NULL, hecha_por = NULL WHERE id = a.id;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Anular una pendiente.
CREATE OR REPLACE FUNCTION public.actividad_anular(p_id BIGINT, p_revision INTEGER)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.actividades%ROWTYPE;
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  a := public.actividad__bloquear(p_id);
  IF p_revision IS NULL THEN RAISE EXCEPTION 'REVISION_REQUERIDA'; END IF;
  IF a.estado = 'anulada' AND a.revision >= p_revision THEN RETURN jsonb_build_object('ok', true, 'ya_anulada', true); END IF;
  IF a.revision <> p_revision THEN RAISE EXCEPTION 'ACTIVIDAD_DESACTUALIZADA'; END IF;
  IF a.estado = 'anulada' THEN RETURN jsonb_build_object('ok', true, 'ya_anulada', true); END IF;
  IF a.estado <> 'pendiente' THEN RAISE EXCEPTION 'ACTIVIDAD_NO_ANULABLE'; END IF;
  UPDATE public.actividades SET estado = 'anulada' WHERE id = a.id;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Compensar: deshace una transferencia hecha por el CRM con un traspaso INVERSO y deja la actividad pendiente de nuevo.
CREATE OR REPLACE FUNCTION public.actividad_compensar(p_id BIGINT, p_intento INTEGER, p_nota TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a public.actividades%ROWTYPE; o public.meli_ordenes%ROWTYPE;
  v_nota TEXT := public.actividad__nota_ok(p_nota); v_user TEXT := public.actividad__usuario(); v_saldo NUMERIC;
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  a := public.actividad__bloquear(p_id);
  IF p_intento IS NULL THEN RAISE EXCEPTION 'INTENTO_REQUERIDO'; END IF;
  -- Reintento de una compensación que YA se aplicó (la actividad volvió a pendiente con el intento siguiente).
  IF a.intento = p_intento + 1 AND a.estado = 'pendiente' AND NOT a.movio_plata THEN
    RETURN jsonb_build_object('ok', true, 'ya_compensada', true, 'monto', a.monto);
  END IF;
  IF a.intento <> p_intento THEN RAISE EXCEPTION 'ACTIVIDAD_DESACTUALIZADA'; END IF;
  IF a.estado <> 'hecha' OR NOT a.movio_plata THEN RAISE EXCEPTION 'ACTIVIDAD_SIN_TRANSFERENCIA'; END IF;
  SELECT * INTO o FROM public.meli_ordenes WHERE id = a.origen_orden_id;

  PERFORM 1 FROM public.cajas
   WHERE (persona_id, bolsillo) IN ((a.origen_persona_id, a.origen_bolsillo), (a.destino_persona_id, a.destino_bolsillo))
   ORDER BY persona_id, bolsillo FOR UPDATE;
  SELECT saldo INTO v_saldo FROM public.cajas WHERE persona_id = a.destino_persona_id AND bolsillo = a.destino_bolsillo;
  IF v_saldo IS NULL THEN RAISE EXCEPTION 'CAJA_DESTINO_INEXISTENTE'; END IF;
  IF v_saldo < a.monto THEN RAISE EXCEPTION 'SALDO_INSUFICIENTE' USING DETAIL = 'La caja de la empresa tiene ' || v_saldo || ' y hay que devolver ' || a.monto; END IF;

  PERFORM * FROM public._caja_mover_atomico(
    a.destino_persona_id, a.destino_bolsillo, a.origen_persona_id, a.origen_bolsillo, a.monto, a.monto,
    'movimiento', o.meli_order_id, 'Se deshace la transferencia a la empresa (orden ' || o.meli_order_id || ')',
    'Vuelve a Mercado Pago la transferencia deshecha (orden ' || o.meli_order_id || ')', v_user,
    'act-' || a.token || '-c' || a.intento);

  UPDATE public.actividades
     SET estado = 'pendiente', movio_plata = FALSE, destino_persona_id = NULL, destino_bolsillo = NULL,
         hecha_en = NULL, hecha_por = NULL, intento = a.intento + 1,
         nota = left(COALESCE(v_nota, 'Transferencia deshecha por ' || v_user), 400)
   WHERE id = a.id;
  RETURN jsonb_build_object('ok', true, 'monto', a.monto);
END $$;

-- Actividad manual (recordatorio libre).
CREATE OR REPLACE FUNCTION public.actividad_crear(
  p_titulo TEXT, p_fecha_objetivo DATE, p_monto NUMERIC DEFAULT NULL, p_moneda TEXT DEFAULT NULL, p_nota TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id BIGINT; v_nota TEXT := public.actividad__nota_ok(p_nota); v_titulo TEXT := btrim(COALESCE(p_titulo, ''));
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501'; END IF;
  IF length(v_titulo) = 0 OR length(v_titulo) > 200 OR v_titulo ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'TITULO_INVALIDO'; END IF;
  IF p_fecha_objetivo IS NULL THEN RAISE EXCEPTION 'FECHA_INVALIDA'; END IF;
  IF p_monto IS NOT NULL AND (p_monto = 'NaN'::numeric OR p_monto <= 0) THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  INSERT INTO public.actividades (tipo, titulo, monto, moneda, fecha_objetivo, nota, creada_por)
  VALUES ('manual', v_titulo, round(p_monto, 2), p_moneda, p_fecha_objetivo, v_nota, public.actividad__usuario())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- ── 5 · Permisos ──────────────────────────────────────────────────────────
-- Se revoca de PUBLIC (anon y authenticated heredan de PUBLIC) y se otorga solo a authenticated lo que es público.
REVOKE ALL ON FUNCTION public.actividad__usuario()                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.actividad__nota_ok(TEXT)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.actividad__bloquear(BIGINT)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.meli__actividad_crear()              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.meli__actividad_reversion()          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.actividad__revision()                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.actividad_transferir(BIGINT, INTEGER, UUID, TEXT, TEXT)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.actividad_marcar_hecha(BIGINT, INTEGER, TEXT)                 FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.actividad_reabrir(BIGINT, INTEGER)                            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.actividad_anular(BIGINT, INTEGER)                             FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.actividad_compensar(BIGINT, INTEGER, TEXT)                    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.actividad_crear(TEXT, DATE, NUMERIC, TEXT, TEXT)     FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.actividad_transferir(BIGINT, INTEGER, UUID, TEXT, TEXT)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.actividad_marcar_hecha(BIGINT, INTEGER, TEXT)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.actividad_reabrir(BIGINT, INTEGER)                         TO authenticated;
GRANT EXECUTE ON FUNCTION public.actividad_anular(BIGINT, INTEGER)                          TO authenticated;
GRANT EXECUTE ON FUNCTION public.actividad_compensar(BIGINT, INTEGER, TEXT)                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.actividad_crear(TEXT, DATE, NUMERIC, TEXT, TEXT) TO authenticated;

COMMIT;

-- ============================================================================
--  VERIFICACIÓN (solo lectura; sale como tabla al final). Tiene que verse TODO en ✅.
-- ============================================================================
SELECT id, control, CASE WHEN ok THEN '✅' ELSE '❌' END AS resultado
FROM (
  SELECT '15.1' AS id, 'Existe la tabla actividades con seguridad por filas' AS control,
         COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.actividades'::regclass), false) AS ok
  UNION ALL SELECT '15.2', 'Los dos triggers sobre meli_ordenes existen (crear al acreditar, frenar/anular al revertir)',
         (SELECT count(*) = 2 FROM pg_trigger WHERE tgrelid = 'public.meli_ordenes'::regclass AND NOT tgisinternal
            AND tgname IN ('meli_actividad_crear', 'meli_actividad_reversion'))
  UNION ALL SELECT '15.3', 'Existen las 6 funciones públicas',
         (SELECT count(*) = 6 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname IN ('actividad_transferir', 'actividad_marcar_hecha', 'actividad_reabrir',
                                                        'actividad_anular', 'actividad_compensar', 'actividad_crear'))
  UNION ALL SELECT '15.4', 'Solo el CRM (authenticated) ejecuta las funciones públicas; anon y PUBLIC no',
         has_function_privilege('authenticated', 'public.actividad_transferir(bigint,integer,uuid,text,text)', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public.actividad_transferir(bigint,integer,uuid,text,text)', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public.actividad_crear(text,date,numeric,text,text)', 'EXECUTE')
  UNION ALL SELECT '15.5', 'authenticated solo puede LEER la tabla (nada de escritura directa)',
         has_table_privilege('authenticated', 'public.actividades', 'SELECT')
         AND NOT has_table_privilege('authenticated', 'public.actividades', 'INSERT')
         AND NOT has_table_privilege('authenticated', 'public.actividades', 'UPDATE')
         AND NOT has_table_privilege('authenticated', 'public.actividades', 'DELETE')
         AND NOT has_table_privilege('anon', 'public.actividades', 'SELECT')
  UNION ALL SELECT '15.6', 'Las ayudas internas y las funciones de trigger no las ejecuta ni anon ni authenticated',
         NOT has_function_privilege('authenticated', 'public.actividad__bloquear(bigint)', 'EXECUTE')
         AND NOT has_function_privilege('authenticated', 'public.meli__actividad_crear()', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public.meli__actividad_reversion()', 'EXECUTE')
) t
ORDER BY id;
