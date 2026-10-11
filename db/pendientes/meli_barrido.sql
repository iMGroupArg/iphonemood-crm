-- ============================================================================
--  meli_barrido.sql  (script 10)  — BARRIDO DE VENTAS RECIENTES de Mercado Libre
--
--  PROBLEMA: las órdenes entran SOLO cuando Mercado Libre manda un aviso. Si el aviso no llega (caso Lattafa
--  #2000018883051330 y otras), la venta no entra nunca y nadie se entera. El barrido le pregunta a Mercado
--  Libre qué órdenes se actualizaron desde el último punto cubierto y ENCOLA un aviso por cada una que falta o
--  quedó atrasada; el procesamiento lo hace la tubería de siempre (lease por orden, idempotencia). Este script NO
--  crea ni modifica órdenes, ni toca stock, ni cajas: solo encola avisos y lleva la cuenta de lo cubierto.
--  Plan y revisión: docs/meli-ventas-envios-plan.md, sección 5.
--
--  QUÉ HACE:
--   1) Cola SIN duplicados: un aviso pendiente (y libre) por cuenta+tópico+recurso. Los duplicados que ya existen
--      se cierran (se conserva el más viejo). meli_notificacion_registrar (la que usa el webhook) pasa a ignorar un
--      aviso igual a uno ya pendiente, en vez de agregar otro.
--   2) meli_notificacion_resultado / _devolver: si el aviso A se reintenta o se devuelve y ya hay un aviso B
--      pendiente del mismo recurso, A queda absorbido por B (no choca con el índice).
--   3) meli_barrido_estado (hasta cuándo está cubierto) y meli_barridos (cada corrida, con su lease).
--   4) RPC del servidor (con el secreto): cuentas, iniciar, avanzar, reparar, cerrar.
--
--  REQUISITOS: scripts 3 y 7 corridos. Idempotente (se puede correr varias veces).
-- ============================================================================

DO $$
BEGIN
  IF to_regprocedure('public.meli_notificacion_reclamar(text,integer)') IS NULL
     OR to_regprocedure('public.meli_cuenta_info(text,bigint)') IS NULL THEN
    RAISE EXCEPTION 'Faltan los scripts 3 (meli_esquema_base.sql) y/o 7 (meli_vincular.sql). Correrlos antes que este.';
  END IF;
END $$;

BEGIN;

-- ── 0 · Candado de la cola ─────────────────────────────────────────────────
-- Todo lo que puede crear un aviso "pendiente y libre" (webhook, barrido, reparación, reintento o devolución de un
-- aviso) toma ANTES este candado de la transacción (número fijo). Sin él, en Postgres real aparecían deadlocks entre el
-- barrido (inserta de a muchos) y un worker que reintenta un aviso: ambos se esperan por la misma entrada del índice
-- único (lo detectó el banco de concurrencia). Con el candado esas escrituras se hacen de a una; cada una dura
-- milisegundos. Reclamar NO lo toma: solo saca avisos de la cola (les pone lease) y no choca con nadie.

-- ── 1 · Cola sin duplicados ────────────────────────────────────────────────
-- Duplicados pendientes y libres que ya existen: se cierra todo menos el más viejo.
UPDATE public.meli_notificaciones n
   SET estado = 'descartada', procesada_en = NOW(), lease_id = NULL, lease_hasta = NULL,
       motivo = 'duplicado de otro aviso pendiente del mismo recurso'
  FROM (SELECT id, row_number() OVER (PARTITION BY meli_user_id, topico, recurso ORDER BY id) AS rn
          FROM public.meli_notificaciones
         WHERE estado = 'pendiente' AND lease_id IS NULL) d
 WHERE n.id = d.id AND d.rn > 1;

-- Un aviso en proceso (con lease) queda FUERA del índice: mientras se procesa puede entrar otro pendiente, así una
-- actualización que llega durante el proceso no se pierde.
CREATE UNIQUE INDEX IF NOT EXISTS meli_notificaciones_pendiente_unica
  ON public.meli_notificaciones (meli_user_id, topico, recurso)
  WHERE estado = 'pendiente' AND lease_id IS NULL;

-- El webhook: un aviso igual a uno ya pendiente no agrega otro (devuelve el id del que ya está).
CREATE OR REPLACE FUNCTION public.meli_notificacion_registrar(
  p_secreto TEXT, p_user_id TEXT, p_topico TEXT, p_recurso TEXT, p_payload JSONB)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id BIGINT;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  PERFORM pg_advisory_xact_lock(7770001);
  INSERT INTO meli_notificaciones (meli_user_id, topico, recurso, payload)
  VALUES (p_user_id, p_topico, p_recurso, p_payload)
  ON CONFLICT (meli_user_id, topico, recurso) WHERE estado = 'pendiente' AND lease_id IS NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM meli_notificaciones
     WHERE meli_user_id = p_user_id AND topico = p_topico AND recurso = p_recurso
       AND estado = 'pendiente' AND lease_id IS NULL
     ORDER BY id LIMIT 1;
  END IF;
  RETURN v_id;
END; $$;

-- ── 2 · Resultado y devolución, a prueba del índice ─────────────────────────
-- Cuando el aviso A vuelve a quedar "pendiente y libre" (reintento o devolución) puede chocar con un aviso B
-- pendiente del mismo recurso que entró mientras A se procesaba. Si ya existe B, A queda absorbido por B (B va a
-- consultar la orden entera igual). Si B aparece justo en el medio, el choque se atrapa y se resuelve igual.
CREATE OR REPLACE FUNCTION public.meli_notificacion_resultado(
  p_secreto TEXT, p_id BIGINT, p_lease_id UUID,
  p_ok BOOLEAN, p_terminal BOOLEAN DEFAULT FALSE, p_motivo TEXT DEFAULT NULL,
  p_max_intentos INT DEFAULT 8)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ok BOOLEAN;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  -- Solo el reintento puede dejar un aviso "pendiente y libre": ahí se toma el candado de la cola.
  IF NOT COALESCE(p_ok, FALSE) AND NOT COALESCE(p_terminal, FALSE) THEN PERFORM pg_advisory_xact_lock(7770001); END IF;

  BEGIN
    UPDATE meli_notificaciones n
       SET estado = CASE
             WHEN p_ok           THEN 'procesada'
             WHEN p_terminal     THEN 'descartada'
             WHEN n.intentos >= p_max_intentos THEN 'fallida'
             WHEN EXISTS (SELECT 1 FROM meli_notificaciones o
                           WHERE o.id <> n.id AND o.meli_user_id IS NOT DISTINCT FROM n.meli_user_id
                             AND o.topico IS NOT DISTINCT FROM n.topico AND o.recurso IS NOT DISTINCT FROM n.recurso
                             AND o.estado = 'pendiente' AND o.lease_id IS NULL) THEN 'descartada'
             ELSE 'pendiente' END,
           procesada_en = CASE WHEN p_ok THEN NOW() ELSE n.procesada_en END,
           error  = CASE WHEN p_ok THEN NULL ELSE p_motivo END,
           motivo = p_motivo,
           lease_id = NULL, lease_hasta = NULL,
           -- backoff exponencial, tope 1 hora
           proximo_intento = CASE WHEN p_ok OR p_terminal THEN n.proximo_intento
             ELSE NOW() + LEAST(INTERVAL '1 hour',
                                (POWER(2, LEAST(n.intentos, 10)) || ' seconds')::INTERVAL) END
     WHERE n.id = p_id AND n.lease_id = p_lease_id
    RETURNING TRUE INTO v_ok;
  EXCEPTION WHEN unique_violation THEN
    UPDATE meli_notificaciones n
       SET estado = 'descartada', procesada_en = NOW(), lease_id = NULL, lease_hasta = NULL,
           error = p_motivo, motivo = COALESCE(p_motivo, 'absorbido por otro aviso pendiente del mismo recurso')
     WHERE n.id = p_id AND n.lease_id = p_lease_id
    RETURNING TRUE INTO v_ok;
  END;

  RETURN COALESCE(v_ok, FALSE);
END; $$;

CREATE OR REPLACE FUNCTION public.meli_notificacion_devolver(
  p_secreto TEXT, p_ids BIGINT[], p_lease_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n INTEGER := 0; v_filas INTEGER; d RECORD;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  PERFORM pg_advisory_xact_lock(7770001);
  FOR d IN SELECT x.id, x.lease_id FROM unnest(p_ids, p_lease_ids) AS x(id, lease_id) ORDER BY x.id LOOP
    BEGIN
      UPDATE meli_notificaciones n
         SET lease_id = NULL, lease_hasta = NULL,
             intentos = GREATEST(n.intentos - 1, 0),            -- no se le cobra el intento
             estado = CASE WHEN EXISTS (SELECT 1 FROM meli_notificaciones o
                                         WHERE o.id <> n.id AND o.meli_user_id IS NOT DISTINCT FROM n.meli_user_id
                                           AND o.topico IS NOT DISTINCT FROM n.topico AND o.recurso IS NOT DISTINCT FROM n.recurso
                                           AND o.estado = 'pendiente' AND o.lease_id IS NULL)
                           THEN 'descartada' ELSE n.estado END,
             procesada_en = CASE WHEN EXISTS (SELECT 1 FROM meli_notificaciones o
                                         WHERE o.id <> n.id AND o.meli_user_id IS NOT DISTINCT FROM n.meli_user_id
                                           AND o.topico IS NOT DISTINCT FROM n.topico AND o.recurso IS NOT DISTINCT FROM n.recurso
                                           AND o.estado = 'pendiente' AND o.lease_id IS NULL)
                                 THEN NOW() ELSE n.procesada_en END
       WHERE n.id = d.id AND n.lease_id = d.lease_id;
      GET DIAGNOSTICS v_filas = ROW_COUNT;
    EXCEPTION WHEN unique_violation THEN
      UPDATE meli_notificaciones n
         SET estado = 'descartada', procesada_en = NOW(), lease_id = NULL, lease_hasta = NULL,
             motivo = 'absorbido por otro aviso pendiente del mismo recurso'
       WHERE n.id = d.id AND n.lease_id = d.lease_id;
      GET DIAGNOSTICS v_filas = ROW_COUNT;
    END;
    v_n := v_n + v_filas;
  END LOOP;
  RETURN v_n;
END; $$;

-- ── 3 · Tablas ─────────────────────────────────────────────────────────────
-- Hasta cuándo está cubierto: todo lo actualizado antes de `cubierto_hasta` ya está encolado (o procesado).
CREATE TABLE IF NOT EXISTS public.meli_barrido_estado (
  cuenta_id        BIGINT PRIMARY KEY REFERENCES public.meli_cuentas(id) ON DELETE CASCADE,
  cubierto_hasta   TIMESTAMPTZ,
  ultimo_ok_en     TIMESTAMPTZ,
  ultimo_error     TEXT,
  ultimo_error_en  TIMESTAMPTZ,
  ultimo_estado    TEXT,                       -- de la última corrida: completo | parcial | fallido
  ultimo_aproximado BOOLEAN NOT NULL DEFAULT FALSE,   -- la última corrida no pudo verificarse del todo
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.meli_barrido_estado
  ADD COLUMN IF NOT EXISTS ultimo_estado TEXT,
  ADD COLUMN IF NOT EXISTS ultimo_aproximado BOOLEAN NOT NULL DEFAULT FALSE;

-- Cada corrida. `barrido_id` es el lease: todas las escrituras de una corrida lo exigen, así una corrida atrasada
-- cuyo lease venció no puede cerrar ni mover lo cubierto de una posterior.
CREATE TABLE IF NOT EXISTS public.meli_barridos (
  id            BIGSERIAL PRIMARY KEY,
  cuenta_id     BIGINT NOT NULL REFERENCES public.meli_cuentas(id) ON DELETE CASCADE,
  barrido_id    UUID   NOT NULL,
  estado        TEXT   NOT NULL DEFAULT 'en_curso'
                CHECK (estado IN ('en_curso', 'completo', 'parcial', 'fallido', 'vencido')),
  origen        TEXT   NOT NULL CHECK (origen IN ('cron', 'boton')),
  iniciado_por  TEXT,
  desde         TIMESTAMPTZ NOT NULL,
  hasta         TIMESTAMPTZ NOT NULL,
  cursor_en     TIMESTAMPTZ NOT NULL,
  lease_hasta   TIMESTAMPTZ NOT NULL,
  rebanadas     INTEGER NOT NULL DEFAULT 0,
  encontradas   INTEGER NOT NULL DEFAULT 0,
  encoladas     INTEGER NOT NULL DEFAULT 0,
  reparadas     INTEGER NOT NULL DEFAULT 0,
  aproximado    BOOLEAN NOT NULL DEFAULT FALSE,
  error         TEXT,
  iniciado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  terminado_en  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS meli_barridos_uno_en_curso ON public.meli_barridos (cuenta_id) WHERE estado = 'en_curso';
CREATE INDEX IF NOT EXISTS meli_barridos_cuenta_fecha ON public.meli_barridos (cuenta_id, iniciado_en DESC);

ALTER TABLE public.meli_barrido_estado ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meli_barridos       ENABLE ROW LEVEL SECURITY;
-- Lectura para el CRM (la pantalla muestra hasta cuándo está verificado); escritura SOLO por las RPC de abajo.
DROP POLICY IF EXISTS "meli_barrido_estado_lectura" ON public.meli_barrido_estado;
CREATE POLICY "meli_barrido_estado_lectura" ON public.meli_barrido_estado FOR SELECT USING (public.is_authorized_user());
DROP POLICY IF EXISTS "meli_barridos_lectura" ON public.meli_barridos;
CREATE POLICY "meli_barridos_lectura" ON public.meli_barridos FOR SELECT USING (public.is_authorized_user());

-- Supabase da ALL a anon y authenticated sobre toda tabla nueva: se cierra todo y se abre solo la lectura.
REVOKE ALL ON public.meli_barrido_estado FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.meli_barridos       FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.meli_barrido_estado TO authenticated;
GRANT SELECT ON public.meli_barridos       TO authenticated;
REVOKE ALL ON SEQUENCE public.meli_barridos_id_seq FROM PUBLIC, anon, authenticated;

-- ── 4 · RPC del servidor (todas exigen el secreto) ──────────────────────────
-- Cuentas que se pueden barrer: activas, conectadas y sin pedido de reconexión.
CREATE OR REPLACE FUNCTION public.meli_barrido_cuentas(p_secreto TEXT)
RETURNS TABLE (id BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  RETURN QUERY SELECT c.id FROM meli_cuentas c
   WHERE c.activa AND NOT c.requiere_reconexion AND NOT c.refresh_ambiguo AND c.refresh_token IS NOT NULL
   ORDER BY c.id;
END; $$;

-- Empieza una corrida. Devuelve { ok:true, barrido_id, desde, hasta, tanda_parcial } o { ok:false, motivo }.
--   · Una sola corrida por cuenta a la vez (índice parcial + bloqueo de la cuenta).
--   · Una corrida cuyo lease venció se marca 'vencido' y deja de molestar.
--   · Por botón: no más de una cada p_espera_boton_seg segundos.
--   · Desde: el último punto cubierto menos 2 h de solape, y como mucho 48 h atrás; la primera vez, la fecha de
--     conexión de la cuenta (como máximo p_inicial_dias atrás). Hasta: como mucho 7 días después del desde (tandas).
CREATE OR REPLACE FUNCTION public.meli_barrido_iniciar(
  p_secreto TEXT, p_cuenta_id BIGINT, p_origen TEXT, p_usuario TEXT DEFAULT NULL,
  p_inicial_dias INTEGER DEFAULT 30, p_espera_boton_seg INTEGER DEFAULT 120)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c        public.meli_cuentas%ROWTYPE;
  est      public.meli_barrido_estado%ROWTYPE;
  ult      public.meli_barridos%ROWTYPE;
  v_ahora  TIMESTAMPTZ := date_trunc('milliseconds', clock_timestamp());   -- en milisegundos: así el servidor (JavaScript) ida y vuelta sin perder precisión
  v_desde  TIMESTAMPTZ;
  v_hasta  TIMESTAMPTZ;
  v_lease  UUID := gen_random_uuid();
  v_ultimo TIMESTAMPTZ;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF p_origen NOT IN ('cron', 'boton') THEN RAISE EXCEPTION 'ORIGEN_INVALIDO'; END IF;

  SELECT * INTO c FROM meli_cuentas WHERE id = p_cuenta_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'motivo', 'CUENTA_INEXISTENTE'); END IF;

  IF NOT c.activa OR c.requiere_reconexion OR c.refresh_ambiguo OR c.refresh_token IS NULL THEN
    INSERT INTO meli_barrido_estado (cuenta_id, ultimo_error, ultimo_error_en)
    VALUES (p_cuenta_id, 'RECONEXION', v_ahora)
    ON CONFLICT (cuenta_id) DO UPDATE SET ultimo_error = 'RECONEXION', ultimo_error_en = v_ahora, actualizado_en = v_ahora;
    RETURN jsonb_build_object('ok', false, 'motivo', 'CUENTA_BLOQUEADA');
  END IF;

  UPDATE meli_barridos SET estado = 'vencido', terminado_en = v_ahora, error = COALESCE(error, 'se perdió el lease')
   WHERE cuenta_id = p_cuenta_id AND estado = 'en_curso' AND lease_hasta < v_ahora;

  IF EXISTS (SELECT 1 FROM meli_barridos WHERE cuenta_id = p_cuenta_id AND estado = 'en_curso') THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'EN_CURSO');
  END IF;

  IF p_origen = 'boton' THEN
    SELECT max(iniciado_en) INTO v_ultimo FROM meli_barridos WHERE cuenta_id = p_cuenta_id AND origen = 'boton';
    IF v_ultimo IS NOT NULL AND v_ultimo > v_ahora - make_interval(secs => p_espera_boton_seg) THEN
      RETURN jsonb_build_object('ok', false, 'motivo', 'MUY_PRONTO',
        'espera_seg', CEIL(EXTRACT(EPOCH FROM (v_ultimo + make_interval(secs => p_espera_boton_seg) - v_ahora))));
    END IF;
  END IF;

  SELECT * INTO est FROM meli_barrido_estado WHERE cuenta_id = p_cuenta_id;
  IF est.cubierto_hasta IS NULL THEN
    -- Como máximo hasta 1 hora atrás: una cuenta recién conectada no puede tener una ventana vacía (desde = hasta).
    v_desde := date_trunc('milliseconds', LEAST(GREATEST(c.creado_en, v_ahora - make_interval(days => GREATEST(p_inicial_dias, 1))), v_ahora - INTERVAL '1 hour'));
  ELSE
    v_desde := LEAST(est.cubierto_hasta - INTERVAL '2 hours', v_ahora - INTERVAL '48 hours');
  END IF;

  -- REANUDAR: si la última corrida terminada quedó a medias (parcial o fallida) y avanzó, esta sigue desde donde llegó.
  -- Sin esto, una corrida cortada siempre en el tramo de relleno (las 48 h de atrás) repetiría el mismo tramo y nunca
  -- llegaría a lo más nuevo.
  SELECT * INTO ult FROM meli_barridos
   WHERE cuenta_id = p_cuenta_id AND estado IN ('completo', 'parcial', 'fallido') ORDER BY id DESC LIMIT 1;
  IF FOUND AND ult.estado IN ('parcial', 'fallido') AND ult.cursor_en > ult.desde AND ult.cursor_en > v_desde
     AND ult.iniciado_en > v_ahora - INTERVAL '48 hours' AND ult.cursor_en < v_ahora THEN
    v_desde := date_trunc('milliseconds', ult.cursor_en);
  END IF;
  v_hasta := LEAST(v_desde + INTERVAL '7 days', v_ahora);

  INSERT INTO meli_barridos (cuenta_id, barrido_id, origen, iniciado_por, desde, hasta, cursor_en, lease_hasta)
  VALUES (p_cuenta_id, v_lease, p_origen, p_usuario, v_desde, v_hasta, v_desde, v_ahora + INTERVAL '3 minutes');

  RETURN jsonb_build_object('ok', true, 'barrido_id', v_lease, 'desde', v_desde, 'hasta', v_hasta,
                            'tanda_parcial', v_hasta < v_ahora, 'primera_vez', est.cubierto_hasta IS NULL,
                            'reanuda', v_desde > LEAST(COALESCE(est.cubierto_hasta, v_ahora) - INTERVAL '2 hours', v_ahora - INTERVAL '48 hours'));
END; $$;

-- Una rebanada de tiempo [p_desde, p_hasta) ya recorrida en Mercado Libre: encola un aviso por cada orden que FALTA
-- o está ATRASADA (su última actualización en Mercado Libre es posterior a la que tenemos). Exige que la rebanada
-- empiece donde terminó la anterior (sin saltos) y que el lease siga vigente. Todo en una transacción: o se encolan
-- las órdenes Y avanza el cursor, o ninguna de las dos cosas.
CREATE OR REPLACE FUNCTION public.meli_barrido_avanzar(
  p_secreto TEXT, p_cuenta_id BIGINT, p_barrido_id UUID,
  p_desde TIMESTAMPTZ, p_hasta TIMESTAMPTZ, p_ordenes JSONB, p_aproximado BOOLEAN DEFAULT FALSE)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b        public.meli_barridos%ROWTYPE;
  v_n      INTEGER;
  v_total  INTEGER;
  v_user   TEXT;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;

  SELECT * INTO b FROM meli_barridos
   WHERE cuenta_id = p_cuenta_id AND barrido_id = p_barrido_id AND estado = 'en_curso' FOR UPDATE;
  IF NOT FOUND OR b.lease_hasta < clock_timestamp() THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'LEASE_PERDIDO');
  END IF;
  IF p_desde IS DISTINCT FROM b.cursor_en OR p_hasta IS NULL OR p_hasta <= p_desde OR p_hasta > b.hasta THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'CURSOR_FUERA_DE_ORDEN');
  END IF;
  IF p_ordenes IS NULL OR jsonb_typeof(p_ordenes) <> 'array' OR jsonb_array_length(p_ordenes) > 2000 THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'ORDENES_INVALIDAS');
  END IF;

  SELECT meli_user_id INTO v_user FROM meli_cuentas WHERE id = p_cuenta_id;
  v_total := jsonb_array_length(p_ordenes);
  PERFORM pg_advisory_xact_lock(7770001);

  WITH o AS (
    SELECT DISTINCT ON (e->>'id') e->>'id' AS id,
           CASE WHEN e->>'last_updated' ~ '^\d{4}-\d{2}-\d{2}T' THEN (e->>'last_updated')::timestamptz END AS lu
      FROM jsonb_array_elements(p_ordenes) e
     WHERE e->>'id' ~ '^\d{1,20}$'
     ORDER BY e->>'id', 2 DESC NULLS LAST),
  necesarias AS (
    SELECT o.id FROM o
      LEFT JOIN meli_ordenes m ON m.cuenta_id = p_cuenta_id AND m.meli_order_id = o.id
     WHERE m.id IS NULL OR m.meli_last_updated IS NULL
        OR (o.lu IS NOT NULL AND m.meli_last_updated < o.lu))
  INSERT INTO meli_notificaciones (meli_user_id, topico, recurso, payload)
  SELECT v_user, 'orders_v2', '/orders/' || n.id,
         jsonb_build_object('topic', 'orders_v2', 'resource', '/orders/' || n.id, 'user_id', v_user, 'origen', 'barrido')
    FROM necesarias n
  ON CONFLICT (meli_user_id, topico, recurso) WHERE estado = 'pendiente' AND lease_id IS NULL DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE meli_barridos
     SET cursor_en = p_hasta, rebanadas = rebanadas + 1, encontradas = encontradas + v_total,
         encoladas = encoladas + v_n, aproximado = aproximado OR COALESCE(p_aproximado, FALSE),
         lease_hasta = clock_timestamp() + INTERVAL '3 minutes'
   WHERE id = b.id;

  RETURN jsonb_build_object('ok', true, 'encontradas', v_total, 'encoladas', v_n);
END; $$;

-- Reparación DESDE LA BASE (no consulta a Mercado Libre): vuelve a encolar (a) avisos que quedaron 'fallida' en los
-- últimos 7 días y (b) órdenes de los últimos p_dias días con datos de pago incompletos que no están en revisión,
-- si no se les encoló un aviso en las últimas p_horas horas. Cubre cambios de pago que no mueven la fecha de la
-- orden y órdenes que quedaron fuera de la ventana de búsqueda.
CREATE OR REPLACE FUNCTION public.meli_barrido_reparar(
  p_secreto TEXT, p_cuenta_id BIGINT, p_barrido_id UUID,
  p_limite INTEGER DEFAULT 20, p_dias INTEGER DEFAULT 60, p_horas INTEGER DEFAULT 3)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b        public.meli_barridos%ROWTYPE;
  v_user   TEXT;
  v_a      INTEGER := 0;
  v_b      INTEGER := 0;
  v_lim    INTEGER := LEAST(GREATEST(COALESCE(p_limite, 20), 1), 100);
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  SELECT * INTO b FROM meli_barridos
   WHERE cuenta_id = p_cuenta_id AND barrido_id = p_barrido_id AND estado = 'en_curso' FOR UPDATE;
  IF NOT FOUND OR b.lease_hasta < clock_timestamp() THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'LEASE_PERDIDO');
  END IF;
  SELECT meli_user_id INTO v_user FROM meli_cuentas WHERE id = p_cuenta_id;
  PERFORM pg_advisory_xact_lock(7770001);

  -- (a) avisos fallidos recientes que nadie volvió a encolar
  INSERT INTO meli_notificaciones (meli_user_id, topico, recurso, payload)
  SELECT f.meli_user_id, f.topico, f.recurso,
         jsonb_build_object('topic', f.topico, 'resource', f.recurso, 'user_id', f.meli_user_id, 'origen', 'barrido (reparacion)')
    FROM (SELECT DISTINCT ON (n.topico, n.recurso) n.meli_user_id, n.topico, n.recurso, n.id
            FROM meli_notificaciones n
           WHERE n.meli_user_id = v_user AND n.estado = 'fallida' AND n.recibida_en > NOW() - INTERVAL '7 days'
             AND NOT EXISTS (SELECT 1 FROM meli_notificaciones m
                              WHERE m.meli_user_id = n.meli_user_id AND m.topico = n.topico AND m.recurso = n.recurso AND m.id > n.id)
           ORDER BY n.topico, n.recurso, n.id DESC
           LIMIT v_lim) f
  ON CONFLICT (meli_user_id, topico, recurso) WHERE estado = 'pendiente' AND lease_id IS NULL DO NOTHING;
  GET DIAGNOSTICS v_a = ROW_COUNT;

  -- (b) órdenes con datos de pago incompletos
  IF v_a < v_lim THEN
    INSERT INTO meli_notificaciones (meli_user_id, topico, recurso, payload)
    SELECT v_user, 'orders_v2', '/orders/' || x.meli_order_id,
           jsonb_build_object('topic', 'orders_v2', 'resource', '/orders/' || x.meli_order_id, 'user_id', v_user, 'origen', 'barrido (reparacion)')
      FROM (SELECT m.meli_order_id FROM meli_ordenes m
             WHERE m.cuenta_id = p_cuenta_id AND NOT m.financiera_completa AND NOT m.revisar
               AND m.estado IS DISTINCT FROM 'cancelled'
               AND COALESCE(m.fecha_orden, m.creado_en) > NOW() - make_interval(days => GREATEST(p_dias, 1))
               AND NOT EXISTS (SELECT 1 FROM meli_notificaciones n
                                WHERE n.meli_user_id = v_user AND n.topico = 'orders_v2' AND n.recurso = '/orders/' || m.meli_order_id
                                  AND n.recibida_en > NOW() - make_interval(hours => GREATEST(p_horas, 1)))
             ORDER BY m.actualizado_en
             LIMIT v_lim - v_a) x
    ON CONFLICT (meli_user_id, topico, recurso) WHERE estado = 'pendiente' AND lease_id IS NULL DO NOTHING;
    GET DIAGNOSTICS v_b = ROW_COUNT;
  END IF;

  UPDATE meli_barridos SET reparadas = reparadas + v_a + v_b, lease_hasta = clock_timestamp() + INTERVAL '3 minutes' WHERE id = b.id;
  RETURN jsonb_build_object('ok', true, 'reparadas', v_a + v_b);
END; $$;

-- Cierra la corrida. Solo con el lease vigente. Lo cubierto avanza hasta donde llegó el cursor (rebanadas completas y
-- encoladas), aunque la corrida haya fallado a mitad de camino; no avanza si no hubo progreso.
CREATE OR REPLACE FUNCTION public.meli_barrido_cerrar(
  p_secreto TEXT, p_cuenta_id BIGINT, p_barrido_id UUID, p_ok BOOLEAN, p_error TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b          public.meli_barridos%ROWTYPE;
  v_avance   BOOLEAN;
  v_estado   TEXT;
  v_error    TEXT := LEFT(NULLIF(btrim(COALESCE(p_error, '')), ''), 300);
  v_cubierto TIMESTAMPTZ;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  SELECT * INTO b FROM meli_barridos
   WHERE cuenta_id = p_cuenta_id AND barrido_id = p_barrido_id AND estado = 'en_curso' FOR UPDATE;
  IF NOT FOUND OR b.lease_hasta < clock_timestamp() THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'LEASE_PERDIDO');
  END IF;

  v_avance := b.cursor_en > b.desde;
  v_estado := CASE WHEN NOT COALESCE(p_ok, FALSE) THEN 'fallido'
                   WHEN NOT v_avance THEN 'fallido'
                   WHEN b.cursor_en >= b.hasta THEN 'completo'
                   ELSE 'parcial' END;
  IF v_estado = 'fallido' AND v_error IS NULL THEN v_error := 'SIN_AVANCE'; END IF;

  UPDATE meli_barridos SET estado = v_estado, terminado_en = clock_timestamp(), error = CASE WHEN v_estado = 'fallido' THEN v_error END
   WHERE id = b.id;

  INSERT INTO meli_barrido_estado (cuenta_id, cubierto_hasta, ultimo_ok_en, ultimo_error, ultimo_error_en, ultimo_estado, ultimo_aproximado)
  VALUES (p_cuenta_id,
          CASE WHEN v_avance THEN b.cursor_en END,
          CASE WHEN v_estado IN ('completo', 'parcial') THEN clock_timestamp() END,
          CASE WHEN v_estado = 'fallido' THEN v_error END,
          CASE WHEN v_estado = 'fallido' THEN clock_timestamp() END,
          v_estado, b.aproximado)
  ON CONFLICT (cuenta_id) DO UPDATE SET
     cubierto_hasta  = CASE WHEN v_avance THEN GREATEST(meli_barrido_estado.cubierto_hasta, b.cursor_en)
                            ELSE meli_barrido_estado.cubierto_hasta END,
     ultimo_ok_en    = CASE WHEN v_estado IN ('completo', 'parcial') THEN clock_timestamp() ELSE meli_barrido_estado.ultimo_ok_en END,
     ultimo_error    = CASE WHEN v_estado = 'fallido' THEN v_error
                            WHEN v_estado IN ('completo', 'parcial') THEN NULL
                            ELSE meli_barrido_estado.ultimo_error END,
     ultimo_error_en = CASE WHEN v_estado = 'fallido' THEN clock_timestamp()
                            WHEN v_estado IN ('completo', 'parcial') THEN NULL
                            ELSE meli_barrido_estado.ultimo_error_en END,
     ultimo_estado   = v_estado,
     ultimo_aproximado = b.aproximado,
     actualizado_en  = clock_timestamp()
  RETURNING cubierto_hasta INTO v_cubierto;

  RETURN jsonb_build_object('ok', true, 'estado', v_estado, 'cubierto_hasta', v_cubierto,
    'desde', b.desde, 'hasta', b.hasta, 'rebanadas', b.rebanadas, 'encontradas', b.encontradas,
    'encoladas', b.encoladas, 'reparadas', b.reparadas, 'aproximado', b.aproximado);
END; $$;

-- ── 5 · Permisos ───────────────────────────────────────────────────────────
-- Postgres da EXECUTE a PUBLIC por defecto: se revoca de PUBLIC. Cada función se defiende con el secreto.
REVOKE EXECUTE ON FUNCTION public.meli_barrido_cuentas(TEXT)                                              FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.meli_barrido_iniciar(TEXT, BIGINT, TEXT, TEXT, INTEGER, INTEGER)       FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.meli_barrido_avanzar(TEXT, BIGINT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, JSONB, BOOLEAN) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.meli_barrido_reparar(TEXT, BIGINT, UUID, INTEGER, INTEGER, INTEGER)    FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.meli_barrido_cerrar(TEXT, BIGINT, UUID, BOOLEAN, TEXT)                 FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.meli_barrido_cuentas(TEXT)                                              TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.meli_barrido_iniciar(TEXT, BIGINT, TEXT, TEXT, INTEGER, INTEGER)       TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.meli_barrido_avanzar(TEXT, BIGINT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, JSONB, BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.meli_barrido_reparar(TEXT, BIGINT, UUID, INTEGER, INTEGER, INTEGER)    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.meli_barrido_cerrar(TEXT, BIGINT, UUID, BOOLEAN, TEXT)                 TO anon, authenticated;

COMMIT;

-- ============================================================================
--  VERIFICACIÓN (solo lectura; sale como tabla al final). Tiene que verse TODO en ✅.
-- ============================================================================
SELECT id, control, CASE WHEN ok THEN '✅' ELSE '❌' END AS resultado
FROM (
  SELECT '10.1' AS id, 'Existe el índice que impide dos avisos pendientes iguales' AS control,
         to_regclass('public.meli_notificaciones_pendiente_unica') IS NOT NULL AS ok
  UNION ALL SELECT '10.2', 'Existen las dos tablas del barrido, con seguridad por filas activada',
         (SELECT count(*) = 2 AND bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.meli_barrido_estado'::regclass, 'public.meli_barridos'::regclass))
  UNION ALL SELECT '10.3', 'Existen las 5 funciones del barrido',
         (SELECT count(*) = 5 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN
            ('meli_barrido_cuentas', 'meli_barrido_iniciar', 'meli_barrido_avanzar', 'meli_barrido_reparar', 'meli_barrido_cerrar'))
  UNION ALL SELECT '10.4', 'El navegador (anon y authenticated) NO puede escribir las tablas del barrido',
         NOT has_table_privilege('anon', 'public.meli_barridos', 'INSERT, UPDATE, DELETE')
         AND NOT has_table_privilege('authenticated', 'public.meli_barridos', 'INSERT, UPDATE, DELETE')
         AND NOT has_table_privilege('anon', 'public.meli_barrido_estado', 'INSERT, UPDATE, DELETE')
         AND NOT has_table_privilege('authenticated', 'public.meli_barrido_estado', 'INSERT, UPDATE, DELETE')
  UNION ALL SELECT '10.5', 'El registro de avisos (webhook) ya ignora un aviso igual a uno pendiente',
         position('ON CONFLICT' IN pg_get_functiondef(to_regprocedure('public.meli_notificacion_registrar(text,text,text,text,jsonb)'))) > 0
  UNION ALL SELECT '10.6', 'No queda ningún par de avisos pendientes iguales',
         NOT EXISTS (SELECT 1 FROM public.meli_notificaciones WHERE estado = 'pendiente' AND lease_id IS NULL
                      GROUP BY meli_user_id, topico, recurso HAVING count(*) > 1)
) t
ORDER BY id;
