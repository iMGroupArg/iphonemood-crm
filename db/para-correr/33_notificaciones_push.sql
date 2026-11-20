-- ============================================================================
--  notificaciones_push.sql  (script 33) — AVISOS PUSH AL CELULAR: equipo (venta nueva) y clientes (reparación lista)
--
--  QUÉ HACE
--    · push_suscripciones: los teléfonos/navegadores que aceptaron recibir avisos (endpoint + claves que entrega el navegador).
--      tipo 'equipo' (staff del CRM) o 'cliente' (atada a UNA reparación, por su link de seguimiento).
--    · push_cola / push_envios: los avisos por enviar (uno por venta nueva y uno por reparación que pasa a "listo", sin duplicar) y a quién
--      ya se le mandó cada uno (un reintento NO repite a quien ya lo recibió).
--    · Disparadores en ventas (alta) y reparaciones (estado → listo): sólo ENCOLAN; nunca pueden romper una venta ni una reparación.
--    · RPC del NAVEGADOR: suscribir (equipo: sesión del CRM; cliente: el token de su link), consultar si ESE teléfono ya está suscripto, mandarse un aviso de PRUEBA (equipo) y darse de baja.
--    · RPC del SERVIDOR (con el secreto de Mercado Libre, igual que meli_*): tomar avisos pendientes (ya con texto y destinatarios) y anotar el
--      resultado. El envío lo hace api/meli/worker.js (?modo=push); no hay funciones nuevas de Vercel.
--    · Reloj: cada minuto, SÓLO si hay algo por enviar, llama al worker (misma clave de la bóveda que el script 24: «disparador_secret»).
--
--  REGLAS
--    · NACE APAGADO (push_config.activo = false): apagado no se encola ni se envía nada. Se enciende con
--          UPDATE public.push_config SET valor = 'true' WHERE clave = 'activo';
--    · Las tablas están cerradas al navegador (sin políticas, sin permisos): todo pasa por las funciones de abajo.
--    · Sólo se aceptan endpoints https de los servicios de push conocidos (el servidor les hace un POST: no puede apuntar a una red interna).
--    · Al entregar/rechazar una reparación se borran las suscripciones de su cliente (menos datos guardados).
--
--  REQUISITOS: script 3 (meli_secreto_ok) y las tablas ventas, venta_items y reparaciones. Idempotente.
-- ============================================================================

DO $$
BEGIN
  IF to_regprocedure('public.meli_secreto_ok(text)') IS NULL THEN
    RAISE EXCEPTION 'Falta el script 3 (meli_esquema_base). Correrlo antes que este.';
  END IF;
  IF to_regclass('public.ventas') IS NULL OR to_regclass('public.venta_items') IS NULL OR to_regclass('public.reparaciones') IS NULL THEN
    RAISE EXCEPTION 'Faltan las tablas ventas, venta_items o reparaciones.';
  END IF;
  IF to_regprocedure('public.is_authorized_user()') IS NULL THEN
    RAISE EXCEPTION 'Falta la función is_authorized_user().';
  END IF;
END $$;


-- ─── 1 · Tablas ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_config (clave TEXT PRIMARY KEY, valor TEXT NOT NULL);
INSERT INTO public.push_config (clave, valor) VALUES ('activo', 'false') ON CONFLICT (clave) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.push_suscripciones (
  id             BIGSERIAL PRIMARY KEY,
  endpoint       TEXT NOT NULL,
  p256dh         TEXT NOT NULL,
  auth           TEXT NOT NULL,
  tipo           TEXT NOT NULL CHECK (tipo IN ('equipo', 'cliente')),
  usuario_email  TEXT,
  reparacion_id  TEXT,
  activa         BOOLEAN NOT NULL DEFAULT TRUE,
  fallos         INTEGER NOT NULL DEFAULT 0,
  creada_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_ok      TIMESTAMPTZ,
  CONSTRAINT push_sus_endpoint CHECK (length(endpoint) <= 1000
    AND endpoint ~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|updates-autopush\.(stage\.)?mozaws\.net|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/'),
  CONSTRAINT push_sus_claves CHECK (p256dh ~ '^[A-Za-z0-9_-]{87}$' AND auth ~ '^[A-Za-z0-9_-]{22}$'),
  CONSTRAINT push_sus_destino CHECK ((tipo = 'equipo' AND usuario_email IS NOT NULL AND reparacion_id IS NULL)
                                  OR (tipo = 'cliente' AND reparacion_id IS NOT NULL AND usuario_email IS NULL))
);
-- Un teléfono del equipo es UNA fila; un teléfono de cliente tiene UNA fila por reparación que sigue (puede seguir varias a la vez).
CREATE UNIQUE INDEX IF NOT EXISTS push_sus_equipo_unica ON public.push_suscripciones (endpoint) WHERE tipo = 'equipo';
CREATE UNIQUE INDEX IF NOT EXISTS push_sus_cliente_unica ON public.push_suscripciones (endpoint, reparacion_id) WHERE tipo = 'cliente';
CREATE INDEX IF NOT EXISTS push_sus_endpoint ON public.push_suscripciones (endpoint);
CREATE INDEX IF NOT EXISTS push_sus_tipo ON public.push_suscripciones (tipo) WHERE activa;
CREATE INDEX IF NOT EXISTS push_sus_reparacion ON public.push_suscripciones (reparacion_id) WHERE reparacion_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.push_cola (
  id              BIGSERIAL PRIMARY KEY,
  tipo            TEXT NOT NULL CHECK (tipo IN ('venta_nueva', 'reparacion_lista', 'prueba')),
  ref             TEXT NOT NULL,
  enviar_desde    TIMESTAMPTZ NOT NULL DEFAULT now(),
  estado          TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'en_curso', 'enviado', 'sin_destinos', 'fallido', 'descartado')),
  intentos        INTEGER NOT NULL DEFAULT 0,       -- reintentos REALES (un destinatario falló y se vuelve a probar)
  reclamos        INTEGER NOT NULL DEFAULT 0,       -- veces que una corrida tomó el aviso (si nunca termina, se abandona)
  reclamo_id      UUID,                              -- quién lo tiene ahora: sólo esa corrida puede informar el resultado
  reclamado_hasta TIMESTAMPTZ,
  ultimo_error    TEXT,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  cerrado_en      TIMESTAMPTZ,
  UNIQUE (tipo, ref)
);
CREATE INDEX IF NOT EXISTS push_cola_pendientes ON public.push_cola (enviar_desde) WHERE estado IN ('pendiente', 'en_curso');

CREATE TABLE IF NOT EXISTS public.push_envios (
  evento_id      BIGINT NOT NULL REFERENCES public.push_cola(id) ON DELETE CASCADE,
  suscripcion_id BIGINT NOT NULL REFERENCES public.push_suscripciones(id) ON DELETE CASCADE,
  estado         TEXT NOT NULL CHECK (estado IN ('ok', 'baja', 'error')),
  hecho_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (evento_id, suscripcion_id)
);

-- Cerradas al navegador: sin políticas y sin permisos (Supabase da ALL a anon/authenticated por defecto: se quita).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['push_config', 'push_suscripciones', 'push_cola', 'push_envios'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN EXECUTE format('REVOKE ALL ON public.%I FROM service_role', t); END IF;
  END LOOP;
END $$;
REVOKE ALL ON SEQUENCE public.push_suscripciones_id_seq, public.push_cola_id_seq FROM PUBLIC, anon, authenticated;


-- ─── 2 · Interruptor ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.push__activo() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT COALESCE((SELECT valor = 'true' FROM public.push_config WHERE clave = 'activo'), FALSE) $$;


-- ─── 3 · Disparadores: sólo encolan, nunca rompen la operación ───────────────
CREATE OR REPLACE FUNCTION public.push__encolar_venta() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  BEGIN
    IF public.push__activo() THEN
      -- 30 s de margen: el CRM carga la venta y después sus renglones; el texto se arma recién al enviar.
      INSERT INTO public.push_cola (tipo, ref, enviar_desde) VALUES ('venta_nueva', NEW.id::TEXT, now() + interval '30 seconds') ON CONFLICT (tipo, ref) DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'push: no se pudo encolar la venta %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.push__reparacion_estado() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  BEGIN
    IF NEW.estado = 'listo' AND OLD.estado IS DISTINCT FROM 'listo' AND public.push__activo() THEN
      INSERT INTO public.push_cola (tipo, ref, enviar_desde) VALUES ('reparacion_lista', NEW.id::TEXT, now()) ON CONFLICT (tipo, ref) DO NOTHING;
    END IF;
    -- Terminó el trámite: se borran las suscripciones de ese cliente (menos datos guardados).
    IF NEW.estado IN ('entregado', 'rechazado', 'no_reparable') AND OLD.estado IS DISTINCT FROM NEW.estado THEN
      DELETE FROM public.push_suscripciones WHERE tipo = 'cliente' AND reparacion_id = NEW.id::TEXT;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'push: no se pudo procesar el estado de la reparación %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;

REVOKE EXECUTE ON FUNCTION public.push__activo(), public.push__encolar_venta(), public.push__reparacion_estado() FROM PUBLIC, anon, authenticated;   -- push__destinos se cierra más abajo

DROP TRIGGER IF EXISTS push_venta_nueva ON public.ventas;
CREATE TRIGGER push_venta_nueva AFTER INSERT ON public.ventas FOR EACH ROW EXECUTE FUNCTION public.push__encolar_venta();
DROP TRIGGER IF EXISTS push_reparacion_estado ON public.reparaciones;
CREATE TRIGGER push_reparacion_estado AFTER UPDATE OF estado ON public.reparaciones FOR EACH ROW EXECUTE FUNCTION public.push__reparacion_estado();


-- ─── 4 · RPC del navegador ───────────────────────────────────────────────────
-- Todas toman un candado por endpoint (pg_advisory_xact_lock): dos llamadas simultáneas sobre el mismo teléfono se turnan y no pueden saltearse
-- las comprobaciones (tipo del teléfono, límite de dispositivos por reparación).

-- Equipo: sesión del CRM (usuario autorizado).
CREATE OR REPLACE FUNCTION public.push_suscribir_equipo(p_endpoint TEXT, p_p256dh TEXT, p_auth TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_email TEXT := lower(COALESCE(auth.jwt() ->> 'email', ''));
BEGIN
  IF NOT public.is_authorized_user() OR v_email = '' THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('push_ep:' || p_endpoint));
  DELETE FROM public.push_suscripciones WHERE endpoint = p_endpoint AND tipo = 'cliente';   -- el mismo teléfono ahora es del equipo
  INSERT INTO public.push_suscripciones (endpoint, p256dh, auth, tipo, usuario_email) VALUES (p_endpoint, p_p256dh, p_auth, 'equipo', v_email)
    ON CONFLICT (endpoint) WHERE tipo = 'equipo'
    DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, usuario_email = EXCLUDED.usuario_email, activa = TRUE, fallos = 0;
  RETURN jsonb_build_object('ok', TRUE);
END $$;

-- Cliente: el token de su link de seguimiento (sólo mientras la reparación sigue en curso).
CREATE OR REPLACE FUNCTION public.push_suscribir_cliente(p_token TEXT, p_endpoint TEXT, p_p256dh TEXT, p_auth TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_rep RECORD; v_n INTEGER;
BEGIN
  IF p_token IS NULL OR btrim(p_token) = '' THEN RETURN jsonb_build_object('ok', FALSE, 'motivo', 'token'); END IF;
  SELECT r.id::TEXT AS id, r.estado INTO v_rep FROM public.reparaciones r WHERE r.token_seguimiento = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', FALSE, 'motivo', 'token'); END IF;
  IF v_rep.estado NOT IN ('ingresado', 'diagnosticado', 'en_reparacion') THEN RETURN jsonb_build_object('ok', FALSE, 'motivo', 'estado'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('push_ep:' || p_endpoint));
  PERFORM pg_advisory_xact_lock(hashtext('push_rep:' || v_rep.id));
  IF EXISTS (SELECT 1 FROM public.push_suscripciones WHERE endpoint = p_endpoint AND tipo = 'equipo') THEN RETURN jsonb_build_object('ok', FALSE, 'motivo', 'dispositivo_del_equipo'); END IF;
  SELECT count(*) INTO v_n FROM public.push_suscripciones WHERE tipo = 'cliente' AND reparacion_id = v_rep.id AND endpoint <> p_endpoint;
  IF v_n >= 5 THEN RETURN jsonb_build_object('ok', FALSE, 'motivo', 'limite'); END IF;
  INSERT INTO public.push_suscripciones (endpoint, p256dh, auth, tipo, reparacion_id) VALUES (p_endpoint, p_p256dh, p_auth, 'cliente', v_rep.id)
    ON CONFLICT (endpoint, reparacion_id) WHERE tipo = 'cliente'
    DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, activa = TRUE, fallos = 0;
  RETURN jsonb_build_object('ok', TRUE);
END $$;

-- ¿Este teléfono ya recibe avisos de ESTA reparación? (la pantalla no puede fiarse de que el navegador tenga "alguna" suscripción)
CREATE OR REPLACE FUNCTION public.push_estado_cliente(p_token TEXT, p_endpoint TEXT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object('suscripta', EXISTS (
    SELECT 1 FROM public.push_suscripciones s JOIN public.reparaciones r ON r.id::TEXT = s.reparacion_id
     WHERE r.token_seguimiento = p_token AND btrim(COALESCE(p_token, '')) <> '' AND s.endpoint = p_endpoint AND s.tipo = 'cliente' AND s.activa))
$$;

-- ¿Este teléfono es del equipo y está activo para MI usuario?
CREATE OR REPLACE FUNCTION public.push_estado_equipo(p_endpoint TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_email TEXT := lower(COALESCE(auth.jwt() ->> 'email', ''));
BEGIN
  IF NOT public.is_authorized_user() OR v_email = '' THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  RETURN jsonb_build_object('suscripta', EXISTS (SELECT 1 FROM public.push_suscripciones WHERE endpoint = p_endpoint AND tipo = 'equipo' AND activa AND usuario_email = v_email));
END $$;

-- Aviso de prueba al PROPIO teléfono del equipo (para comprobar que quedó bien configurado). Uno cada 30 segundos por teléfono.
CREATE OR REPLACE FUNCTION public.push_probar(p_endpoint TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_email TEXT := lower(COALESCE(auth.jwt() ->> 'email', '')); v_id BIGINT;
BEGIN
  IF NOT public.is_authorized_user() OR v_email = '' THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  SELECT id INTO v_id FROM public.push_suscripciones WHERE endpoint = p_endpoint AND tipo = 'equipo' AND activa AND usuario_email = v_email;
  IF v_id IS NULL THEN RETURN jsonb_build_object('ok', FALSE, 'motivo', 'no_suscripto'); END IF;
  IF EXISTS (SELECT 1 FROM public.push_cola WHERE tipo = 'prueba' AND split_part(ref, '-', 1) = v_id::TEXT AND creado_en > now() - interval '30 seconds') THEN
    RETURN jsonb_build_object('ok', FALSE, 'motivo', 'muy_seguido');
  END IF;
  INSERT INTO public.push_cola (tipo, ref, enviar_desde) VALUES ('prueba', v_id::TEXT || '-' || (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT::TEXT, now());
  RETURN jsonb_build_object('ok', TRUE);
END $$;

-- Baja: quien tiene el endpoint (sólo lo conoce el propio teléfono, es la "llave") borra todo lo de ese teléfono.
CREATE OR REPLACE FUNCTION public.push_baja(p_endpoint TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.push_suscripciones WHERE endpoint = p_endpoint;
  RETURN jsonb_build_object('ok', TRUE);
END $$;

-- Baja de UNA reparación (el cliente deja de recibir avisos de esa, pero sigue con las otras). Devuelve cuántas le quedan a ese teléfono:
-- si queda 0, la pantalla cancela también la suscripción del navegador.
CREATE OR REPLACE FUNCTION public.push_baja_cliente(p_token TEXT, p_endpoint TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_id TEXT; v_resto INTEGER;
BEGIN
  IF p_token IS NOT NULL AND btrim(p_token) <> '' THEN
    SELECT r.id::TEXT INTO v_id FROM public.reparaciones r WHERE r.token_seguimiento = p_token;
    IF v_id IS NOT NULL THEN DELETE FROM public.push_suscripciones WHERE endpoint = p_endpoint AND tipo = 'cliente' AND reparacion_id = v_id; END IF;
  END IF;
  SELECT count(*) INTO v_resto FROM public.push_suscripciones WHERE endpoint = p_endpoint AND tipo = 'cliente';
  RETURN jsonb_build_object('ok', TRUE, 'restantes', v_resto);
END $$;


-- ─── 5 · RPC del servidor (con el secreto) ───────────────────────────────────
-- Quiénes tienen que recibir un aviso y todavía no lo recibieron (el reintento y la segunda corrida nunca repiten a quien ya lo tiene).
CREATE OR REPLACE FUNCTION public.push__destinos(p_evento_id BIGINT)
RETURNS TABLE (id BIGINT, endpoint TEXT, p256dh TEXT, auth TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.endpoint, s.p256dh, s.auth
    FROM public.push_cola c
    JOIN public.push_suscripciones s ON s.activa AND (
         (c.tipo = 'venta_nueva'      AND s.tipo = 'equipo')
      OR (c.tipo = 'reparacion_lista' AND s.tipo = 'cliente' AND s.reparacion_id = c.ref)
      OR (c.tipo = 'prueba'           AND s.tipo = 'equipo'  AND s.id::TEXT = split_part(c.ref, '-', 1)))
   WHERE c.id = p_evento_id
     AND NOT EXISTS (SELECT 1 FROM public.push_envios e WHERE e.evento_id = c.id AND e.suscripcion_id = s.id)
   ORDER BY s.id
$$;

-- Toma hasta p_limite avisos listos y los RECLAMA con un identificador propio (sólo esa corrida puede informar el resultado). Devuelve cada uno con su
-- texto y sus destinatarios pendientes. Un aviso sin destinatarios se cierra acá.
CREATE OR REPLACE FUNCTION public.push_tomar_pendientes(p_secreto TEXT, p_limite INTEGER DEFAULT 3, p_segundos INTEGER DEFAULT 120)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  ev RECORD; v RECORD; r RECORD; d JSONB; v_out JSONB := '[]'::JSONB; v_msg JSONB; v_claim UUID;
  v_total NUMERIC; v_n INTEGER; v_primero TEXT; v_cuerpo TEXT; v_activo BOOLEAN;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'SECRETO_INVALIDO'; END IF;
  v_activo := public.push__activo();
  p_limite := LEAST(GREATEST(COALESCE(p_limite, 3), 1), 10);
  p_segundos := LEAST(GREATEST(COALESCE(p_segundos, 120), 30), 600);

  FOR ev IN
    SELECT * FROM public.push_cola
     WHERE ((estado = 'pendiente' AND enviar_desde <= now()) OR (estado = 'en_curso' AND reclamado_hasta < now())) AND (v_activo OR tipo = 'prueba')   -- la prueba funciona aunque el interruptor esté apagado
     ORDER BY enviar_desde, id LIMIT p_limite FOR UPDATE SKIP LOCKED
  LOOP
    IF ev.intentos >= 5 OR ev.reclamos >= 20 THEN
      UPDATE public.push_cola SET estado = 'fallido', cerrado_en = now(), reclamado_hasta = NULL, reclamo_id = NULL, ultimo_error = COALESCE(ultimo_error, 'demasiados intentos') WHERE id = ev.id;
      CONTINUE;
    END IF;
    v_msg := NULL;

    IF ev.tipo = 'venta_nueva' THEN
      SELECT v2.id, v2.cliente, v2.estado, v2.creado_en INTO v FROM public.ventas v2 WHERE v2.id::TEXT = ev.ref;
      IF NOT FOUND OR lower(COALESCE(v.estado, '')) IN ('anulada', 'cancelada') THEN
        UPDATE public.push_cola SET estado = 'descartado', cerrado_en = now() WHERE id = ev.id; CONTINUE;
      END IF;
      SELECT COALESCE(sum(i.precio_usd), 0), count(*), (array_agg(i.nombre ORDER BY i.id))[1] INTO v_total, v_n, v_primero FROM public.venta_items i WHERE i.venta_id::TEXT = ev.ref;
      -- Todavía sin renglones (el CRM los carga justo después): se espera un poco más, hasta 5 minutos desde la venta.
      IF v_n = 0 AND now() - v.creado_en < interval '5 minutes' THEN
        UPDATE public.push_cola SET enviar_desde = now() + interval '30 seconds' WHERE id = ev.id; CONTINUE;
      END IF;
      v_cuerpo := left(btrim(COALESCE(NULLIF(btrim(v.cliente), ''), 'Cliente')) || ' · USD ' || round(v_total)::TEXT
                  || CASE WHEN v_primero IS NOT NULL THEN ' · ' || left(v_primero, 60) || CASE WHEN v_n > 1 THEN ' +' || (v_n - 1) ELSE '' END ELSE '' END, 200);
      v_msg := jsonb_build_object('titulo', 'Venta nueva 🎉', 'cuerpo', v_cuerpo, 'url', '/login', 'tag', 'venta-' || ev.ref);

    ELSIF ev.tipo = 'reparacion_lista' THEN
      SELECT r2.id::TEXT AS id, r2.equipo, r2.token_seguimiento, r2.estado INTO r FROM public.reparaciones r2 WHERE r2.id::TEXT = ev.ref;
      IF NOT FOUND OR r.estado <> 'listo' THEN
        UPDATE public.push_cola SET estado = 'descartado', cerrado_en = now() WHERE id = ev.id; CONTINUE;
      END IF;
      v_msg := jsonb_build_object('titulo', 'Tu reparación está lista ✅',
        'cuerpo', left('Tu ' || COALESCE(NULLIF(btrim(r.equipo), ''), 'equipo') || ' ya se puede retirar. ¡Gracias por confiar en iPhoneMood!', 200),
        'url', '/seguimiento.html?t=' || r.token_seguimiento, 'tag', 'reparacion-' || ev.ref);

    ELSIF ev.tipo = 'prueba' THEN
      v_msg := jsonb_build_object('titulo', 'Aviso de prueba ✅', 'cuerpo', 'Si ves esto, los avisos de iPhoneMood funcionan en este dispositivo.', 'url', '/login', 'tag', 'prueba');
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', x.id, 'endpoint', x.endpoint, 'p256dh', x.p256dh, 'auth', x.auth) ORDER BY x.id), '[]'::JSONB) INTO d FROM public.push__destinos(ev.id) x;
    IF jsonb_array_length(d) = 0 THEN
      UPDATE public.push_cola SET estado = CASE WHEN EXISTS (SELECT 1 FROM public.push_envios e WHERE e.evento_id = ev.id) THEN 'enviado' ELSE 'sin_destinos' END, cerrado_en = now(), reclamado_hasta = NULL, reclamo_id = NULL WHERE id = ev.id;
      CONTINUE;
    END IF;
    v_claim := gen_random_uuid();
    UPDATE public.push_cola SET estado = 'en_curso', reclamos = reclamos + 1, reclamo_id = v_claim, reclamado_hasta = now() + make_interval(secs => p_segundos) WHERE id = ev.id;
    v_out := v_out || jsonb_build_object('evento_id', ev.id, 'reclamo', v_claim, 'tipo', ev.tipo, 'mensaje', v_msg, 'destinos', d);
  END LOOP;
  RETURN v_out;
END $$;

-- El servidor informa qué pasó con cada destinatario: [{id, estado: ok|baja|reintentar|error}], con el identificador de reclamo que recibió.
-- Si el reclamo ya no es el vigente (la corrida tardó y otra retomó el aviso) NO se anota nada. Los destinatarios que no se alcanzaron a intentar
-- (se acabó el tiempo) quedan pendientes y el aviso vuelve a la cola sin gastar un reintento.
CREATE OR REPLACE FUNCTION public.push_resultado(p_secreto TEXT, p_evento_id BIGINT, p_reclamo UUID, p_resultados JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE x JSONB; v_id BIGINT; v_est TEXT; v_ev public.push_cola%ROWTYPE; v_reint BOOLEAN := FALSE; v_pend INTEGER;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'SECRETO_INVALIDO'; END IF;
  IF p_resultados IS NULL OR jsonb_typeof(p_resultados) <> 'array' OR jsonb_array_length(p_resultados) > 200 THEN RAISE EXCEPTION 'RESULTADOS_INVALIDOS'; END IF;
  SELECT * INTO v_ev FROM public.push_cola WHERE id = p_evento_id FOR UPDATE;
  IF NOT FOUND OR v_ev.estado <> 'en_curso' OR v_ev.reclamo_id IS DISTINCT FROM p_reclamo OR p_reclamo IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'motivo', 'reclamo_vencido');
  END IF;

  FOR x IN SELECT * FROM jsonb_array_elements(p_resultados) LOOP
    v_id := (x ->> 'id')::BIGINT; v_est := x ->> 'estado';
    IF v_est = 'ok' THEN
      INSERT INTO public.push_envios (evento_id, suscripcion_id, estado) VALUES (p_evento_id, v_id, 'ok') ON CONFLICT DO NOTHING;
      UPDATE public.push_suscripciones SET ultimo_ok = now(), fallos = 0 WHERE id = v_id;
    ELSIF v_est = 'baja' THEN
      DELETE FROM public.push_suscripciones WHERE id = v_id;                      -- el servicio de push dice que ya no existe
    ELSIF v_est = 'error' THEN
      INSERT INTO public.push_envios (evento_id, suscripcion_id, estado) VALUES (p_evento_id, v_id, 'error') ON CONFLICT DO NOTHING;
      UPDATE public.push_suscripciones SET fallos = fallos + 1, activa = (fallos + 1 < 3) WHERE id = v_id;
    ELSE
      v_reint := TRUE;
      UPDATE public.push_suscripciones SET fallos = fallos + 1, activa = (fallos + 1 < 8) WHERE id = v_id;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_pend FROM public.push__destinos(p_evento_id);
  IF v_pend = 0 THEN
    UPDATE public.push_cola SET estado = 'enviado', cerrado_en = now(), reclamado_hasta = NULL, reclamo_id = NULL WHERE id = p_evento_id;
    RETURN jsonb_build_object('ok', TRUE, 'reintento', FALSE);
  END IF;
  IF v_reint THEN
    IF v_ev.intentos + 1 >= 5 THEN
      UPDATE public.push_cola SET estado = 'fallido', intentos = intentos + 1, cerrado_en = now(), reclamado_hasta = NULL, reclamo_id = NULL, ultimo_error = 'sin respuesta del servicio de push' WHERE id = p_evento_id;
      RETURN jsonb_build_object('ok', TRUE, 'reintento', FALSE);
    END IF;
    UPDATE public.push_cola SET estado = 'pendiente', intentos = intentos + 1, reclamado_hasta = NULL, reclamo_id = NULL,
           enviar_desde = now() + make_interval(mins => (ARRAY[1, 2, 5, 15, 60])[LEAST(v_ev.intentos + 1, 5)]) WHERE id = p_evento_id;
  ELSE
    -- Quedaron destinatarios sin intentar (no alcanzó el tiempo): vuelve pronto, sin contar como reintento.
    UPDATE public.push_cola SET estado = 'pendiente', reclamado_hasta = NULL, reclamo_id = NULL, enviar_desde = now() + interval '20 seconds' WHERE id = p_evento_id;
  END IF;
  RETURN jsonb_build_object('ok', TRUE, 'reintento', TRUE);
END $$;


-- ─── 6 · Permisos ────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.push_suscribir_equipo(TEXT, TEXT, TEXT), public.push_suscribir_cliente(TEXT, TEXT, TEXT, TEXT), public.push_baja(TEXT), public.push_baja_cliente(TEXT, TEXT),
  public.push_estado_cliente(TEXT, TEXT), public.push_estado_equipo(TEXT), public.push_probar(TEXT), public.push__destinos(BIGINT),
  public.push_tomar_pendientes(TEXT, INTEGER, INTEGER), public.push_resultado(TEXT, BIGINT, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_suscribir_equipo(TEXT, TEXT, TEXT), public.push_estado_equipo(TEXT), public.push_probar(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.push_suscribir_cliente(TEXT, TEXT, TEXT, TEXT), public.push_baja(TEXT), public.push_baja_cliente(TEXT, TEXT), public.push_estado_cliente(TEXT, TEXT) TO anon, authenticated;
-- Del servidor: usa la clave anon + el secreto (como meli_*); sin el secreto fallan en la primera línea.
GRANT EXECUTE ON FUNCTION public.push_tomar_pendientes(TEXT, INTEGER, INTEGER), public.push_resultado(TEXT, BIGINT, UUID, JSONB) TO anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE EXECUTE ON FUNCTION public.push__activo(), public.push__encolar_venta(), public.push__reparacion_estado(), public.push__destinos(BIGINT) FROM service_role;
  END IF;
END $$;


-- ─── 7 · Reloj: cada minuto, sólo si hay algo por enviar ─────────────────────
-- Usa la MISMA clave de la bóveda que el script 24 («disparador_secret», igual a DISPARADOR_SECRET de Vercel). Sin clave o sin nada por enviar,
-- no llama a nada. Si el proyecto no tiene pg_cron / pg_net (o el script 24 sin correr), esta parte se omite con un aviso y el resto queda listo.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net')
     AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'supabase_vault') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
    CREATE EXTENSION IF NOT EXISTS supabase_vault;

    EXECUTE $f$
      CREATE OR REPLACE FUNCTION public.push_reloj_llamar() RETURNS BIGINT
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $b$
      DECLARE v_clave TEXT; v_id BIGINT;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM public.push_cola WHERE ((estado = 'pendiente' AND enviar_desde <= now()) OR (estado = 'en_curso' AND reclamado_hasta < now())) AND (public.push__activo() OR tipo = 'prueba')) THEN RETURN NULL; END IF;
        SELECT s.decrypted_secret INTO v_clave FROM vault.decrypted_secrets s WHERE s.name = 'disparador_secret' ORDER BY s.created_at DESC LIMIT 1;
        IF v_clave IS NULL OR v_clave = '' THEN RETURN NULL; END IF;
        SELECT net.http_get(url := 'https://iphonemood.com/api/meli/worker?modo=push', headers := jsonb_build_object('Authorization', 'Bearer ' || v_clave),
                            timeout_milliseconds := 30000) INTO v_id;
        RETURN v_id;
      END $b$ $f$;
    REVOKE ALL ON FUNCTION public.push_reloj_llamar() FROM PUBLIC, anon, authenticated;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN REVOKE ALL ON FUNCTION public.push_reloj_llamar() FROM service_role; END IF;

    PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'push-reloj';
    PERFORM cron.schedule('push-reloj', '* * * * *', 'SELECT public.push_reloj_llamar()');
    -- Limpieza diaria: avisos cerrados de más de 60 días y suscripciones que fallaron seguido.
    PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'push-limpieza';
    PERFORM cron.schedule('push-limpieza', '17 5 * * *',
      $q$DELETE FROM public.push_cola WHERE estado IN ('enviado','sin_destinos','fallido','descartado') AND cerrado_en < now() - interval '60 days';
         DELETE FROM public.push_suscripciones WHERE NOT activa AND creada_en < now() - interval '30 days'$q$);
  ELSE
    RAISE NOTICE 'pg_cron / pg_net / vault no están disponibles: el reloj de avisos no se programó (el resto quedó instalado).';
  END IF;
END $$;


-- ─── Verificación (solo lectura): todas tienen que dar ✅ ─────────────────────
SELECT 'tablas cerradas al navegador' AS control,
       CASE WHEN NOT has_table_privilege('anon', 'public.push_suscripciones', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.push_suscripciones', 'SELECT')
             AND NOT has_table_privilege('anon', 'public.push_cola', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.push_cola', 'INSERT')
             AND NOT has_table_privilege('anon', 'public.push_envios', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.push_config', 'UPDATE') THEN '✅' ELSE '❌' END AS resultado
UNION ALL SELECT 'disparadores instalados',
       CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'push_venta_nueva' AND NOT tgisinternal) AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'push_reparacion_estado' AND NOT tgisinternal) THEN '✅' ELSE '❌' END
UNION ALL SELECT 'el navegador sólo puede suscribirse y darse de baja',
       CASE WHEN has_function_privilege('authenticated', 'public.push_suscribir_equipo(text,text,text)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.push_suscribir_equipo(text,text,text)', 'EXECUTE')
             AND has_function_privilege('anon', 'public.push_suscribir_cliente(text,text,text,text)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.push__encolar_venta()', 'EXECUTE')
             AND NOT has_function_privilege('authenticated', 'public.push__reparacion_estado()', 'EXECUTE') THEN '✅' ELSE '❌' END
UNION ALL SELECT 'nace APAGADO (se enciende a mano)', CASE WHEN EXISTS (SELECT 1 FROM public.push_config WHERE clave = 'activo') THEN '✅' ELSE '❌' END
UNION ALL SELECT 'reloj cada minuto programado',
       CASE WHEN to_regclass('cron.job') IS NOT NULL
             AND ((xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM cron.job WHERE jobname = 'push-reloj' AND schedule = '* * * * *' AND active$q$, false, true, '')))[1]::text)::int > 0
            THEN '✅' ELSE '❌' END;
