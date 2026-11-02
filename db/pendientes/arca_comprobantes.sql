-- ============================================================================
--  arca_comprobantes.sql — FACTURAS ELECTRÓNICAS (ARCA) emitidas por el CRM para las ventas de Mercado Libre
--
--  QUÉ HACE: crea
--    · meli_comprobantes: UNA factura por orden, con su número, importe, CAE y los datos que ARCA exige del receptor.
--    · arca_tickets: el ticket de acceso de ARCA (dura 12 h y ARCA NO entrega otro mientras hay uno vigente), con un candado
--      para que dos instancias del servidor no lo pidan a la vez.
--    · Las funciones que usa el SERVIDOR (con el secreto compartido, igual que Mercado Libre): reservar el número, anotar el CAE,
--      anotar un rechazo y manejar el ticket. El navegador no escribe nada de esto.
--
--  REGLAS (innegociables)
--   · Un solo emisor: no hay columna de emisor (sale de la variable ARCA_CUIT del servidor).
--   · El importe sale de la orden: la base lo compara con el bruto de la orden y rechaza cualquier otro (IMPORTE_NO_COINCIDE).
--     Solo órdenes en pesos con bruto conocido.
--   · UNA factura por orden (índice único) y UN número por comprobante (ambiente + tipo + punto de venta + número).
--   · Numeración serializada con candado por punto de venta: dos órdenes a la vez nunca reciben el mismo número. Si una
--     reserva quedó sin respuesta de ARCA ('reservado'), NADIE emite en ese punto de venta hasta resolverla (NUMERACION_PENDIENTE):
--     primero se consulta a ARCA con FECompConsultar y se la autoriza o se la rechaza. Así un corte de red nunca duplica una factura.
--   · Una factura autorizada no se modifica ni se borra (retención fiscal): sin UPDATE, sin DELETE, sin TRUNCATE.
--   · Los datos del receptor (tipo y número de documento) forman parte del comprobante por obligación legal; no se guardan en
--     ningún otro lado ni se copian a otras tablas.
--   · El ticket (token y firma) es secreto: la tabla está cerrada, solo lo lee y lo escribe el servidor con el secreto.
--
--  REQUISITOS: script 3 (meli_ordenes, meli_secreto_ok) y script 16 (meli_facturas). Idempotente. No cambia ningún dato.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.meli_ordenes') IS NULL OR to_regprocedure('public.meli_secreto_ok(text)') IS NULL
     OR to_regprocedure('public.is_authorized_user()') IS NULL OR to_regclass('public.meli_facturas') IS NULL THEN
    RAISE EXCEPTION 'Faltan los scripts 3 (meli_esquema_base) y 16 (meli_facturas) o is_authorized_user(). Correrlos antes que este.';
  END IF;
END $$;

BEGIN;

-- ── 1 · Ticket de acceso (WSAA) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.arca_tickets (
  ambiente    TEXT        NOT NULL CHECK (ambiente IN ('homologacion', 'produccion')),
  cuit        TEXT        NOT NULL CHECK (cuit ~ '^[0-9]{11}$'),
  token       TEXT,
  sign        TEXT,
  expira      TIMESTAMPTZ,
  lease_id    UUID,
  lease_hasta TIMESTAMPTZ,
  PRIMARY KEY (ambiente, cuit)
);
COMMENT ON TABLE public.arca_tickets IS 'Ticket de acceso de ARCA (secreto). Cerrada: solo el servidor, con el secreto compartido.';

-- ── 2 · Comprobantes ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.meli_comprobantes (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  orden_id        TEXT        NOT NULL UNIQUE REFERENCES public.meli_ordenes (meli_order_id),   -- NO ACTION: una orden facturada no se borra
  ambiente        TEXT        NOT NULL CHECK (ambiente IN ('homologacion', 'produccion')),
  cbte_tipo       INTEGER     NOT NULL CHECK (cbte_tipo = 11),                                 -- Factura C
  pto_venta       INTEGER     NOT NULL CHECK (pto_venta BETWEEN 1 AND 99999),
  numero          INTEGER     CHECK (numero BETWEEN 1 AND 99999999),                           -- NULL cuando está rechazado (el número queda libre)
  estado          TEXT        NOT NULL CHECK (estado IN ('reservado', 'autorizado', 'rechazado')),
  importe_centavos BIGINT     NOT NULL CHECK (importe_centavos > 0),
  doc_tipo        INTEGER     NOT NULL CHECK (doc_tipo IN (80, 86, 96, 99)),                  -- CUIT, CUIL, DNI, consumidor final
  doc_nro         TEXT        NOT NULL CHECK (doc_nro ~ '^[0-9]{1,20}$'),
  cae             TEXT        CHECK (cae ~ '^[0-9]{10,20}$'),
  cae_vto         DATE,
  fecha_cbte      DATE,
  intentos        INTEGER     NOT NULL DEFAULT 1,
  ultimo_error    TEXT,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meli_comprobantes_coherente_ck CHECK (
       (estado = 'reservado'  AND numero IS NOT NULL AND cae IS NULL)
    OR (estado = 'autorizado' AND numero IS NOT NULL AND cae IS NOT NULL AND cae_vto IS NOT NULL AND fecha_cbte IS NOT NULL)
    OR (estado = 'rechazado'  AND numero IS NULL     AND cae IS NULL)),
  CONSTRAINT meli_comprobantes_consumidor_ck CHECK (doc_tipo <> 99 OR doc_nro = '0')
);
COMMENT ON TABLE public.meli_comprobantes IS
  'Facturas C emitidas por el CRM. Una por orden. Se escribe solo con arca_comprobante_*. Autorizada = inmodificable. No se borra nunca.';
CREATE UNIQUE INDEX IF NOT EXISTS meli_comprobantes_numero_unico
  ON public.meli_comprobantes (ambiente, cbte_tipo, pto_venta, numero) WHERE numero IS NOT NULL;
CREATE INDEX IF NOT EXISTS meli_comprobantes_pendientes ON public.meli_comprobantes (ambiente, pto_venta, cbte_tipo) WHERE estado = 'reservado';

CREATE OR REPLACE FUNCTION public.arca__comprobante_proteger()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' THEN RAISE EXCEPTION 'COMPROBANTE_NO_SE_BORRA' USING ERRCODE = '42501'; END IF;
  IF OLD.estado = 'autorizado' THEN RAISE EXCEPTION 'COMPROBANTE_AUTORIZADO_INMODIFICABLE' USING ERRCODE = '42501'; END IF;
  IF NEW.orden_id IS DISTINCT FROM OLD.orden_id OR NEW.ambiente IS DISTINCT FROM OLD.ambiente
     OR NEW.cbte_tipo IS DISTINCT FROM OLD.cbte_tipo OR NEW.pto_venta IS DISTINCT FROM OLD.pto_venta THEN
    RAISE EXCEPTION 'COMPROBANTE_DATOS_FIJOS' USING ERRCODE = '42501';
  END IF;
  NEW.actualizado_en := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS meli_comprobantes_proteger_tg ON public.meli_comprobantes;
CREATE TRIGGER meli_comprobantes_proteger_tg BEFORE UPDATE OR DELETE ON public.meli_comprobantes
  FOR EACH ROW EXECUTE FUNCTION public.arca__comprobante_proteger();
DROP TRIGGER IF EXISTS meli_comprobantes_truncate_tg ON public.meli_comprobantes;
CREATE TRIGGER meli_comprobantes_truncate_tg BEFORE TRUNCATE ON public.meli_comprobantes
  FOR EACH STATEMENT EXECUTE FUNCTION public.arca__comprobante_proteger();

-- ── 3 · Permisos de las tablas ──────────────────────────────────────────────
ALTER TABLE public.arca_tickets      ENABLE ROW LEVEL SECURITY;   -- sin políticas: cerrada
ALTER TABLE public.meli_comprobantes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meli_comprobantes_leer ON public.meli_comprobantes;
CREATE POLICY meli_comprobantes_leer ON public.meli_comprobantes FOR SELECT TO authenticated USING (public.is_authorized_user());
REVOKE ALL ON TABLE public.arca_tickets, public.meli_comprobantes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.meli_comprobantes TO authenticated;
REVOKE ALL ON FUNCTION public.arca__comprobante_proteger() FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON TABLE public.arca_tickets, public.meli_comprobantes FROM service_role;
    REVOKE ALL ON FUNCTION public.arca__comprobante_proteger() FROM service_role;
  END IF;
END $$;

-- ── 4 · Ticket: leer, tomar el candado, guardar, soltar ─────────────────────
DROP FUNCTION IF EXISTS public.arca_ticket_leer(TEXT, TEXT, TEXT);
CREATE FUNCTION public.arca_ticket_leer(p_secreto TEXT, p_ambiente TEXT, p_cuit TEXT)
RETURNS TABLE (token TEXT, sign TEXT, expira TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  RETURN QUERY SELECT t.token, t.sign, t.expira FROM public.arca_tickets t
   WHERE t.ambiente = p_ambiente AND t.cuit = p_cuit AND t.expira > now() + interval '30 seconds';
END $$;

-- Devuelve un id si ESTA instancia puede pedir un ticket nuevo; NULL si otra lo está pidiendo (o ya hay uno vigente).
DROP FUNCTION IF EXISTS public.arca_ticket_lease_tomar(TEXT, TEXT, TEXT);
CREATE FUNCTION public.arca_ticket_lease_tomar(p_secreto TEXT, p_ambiente TEXT, p_cuit TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v UUID := gen_random_uuid(); r UUID;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF p_ambiente NOT IN ('homologacion', 'produccion') OR p_cuit !~ '^[0-9]{11}$' THEN RAISE EXCEPTION 'DATOS_INVALIDOS'; END IF;
  INSERT INTO public.arca_tickets AS t (ambiente, cuit, lease_id, lease_hasta)
  VALUES (p_ambiente, p_cuit, v, now() + interval '60 seconds')
  ON CONFLICT (ambiente, cuit) DO UPDATE SET lease_id = v, lease_hasta = now() + interval '60 seconds'
   WHERE (t.lease_hasta IS NULL OR t.lease_hasta < now()) AND (t.expira IS NULL OR t.expira <= now() + interval '30 seconds')
  RETURNING lease_id INTO r;
  RETURN r;
END $$;

DROP FUNCTION IF EXISTS public.arca_ticket_guardar(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ);
CREATE FUNCTION public.arca_ticket_guardar(p_secreto TEXT, p_ambiente TEXT, p_cuit TEXT, p_lease UUID, p_token TEXT, p_sign TEXT, p_expira TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n INTEGER;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF p_token IS NULL OR p_sign IS NULL OR p_expira IS NULL OR p_expira <= now() THEN RAISE EXCEPTION 'TICKET_INVALIDO'; END IF;
  UPDATE public.arca_tickets SET token = p_token, sign = p_sign, expira = p_expira, lease_id = NULL, lease_hasta = NULL
   WHERE ambiente = p_ambiente AND cuit = p_cuit AND lease_id = p_lease;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

DROP FUNCTION IF EXISTS public.arca_ticket_lease_soltar(TEXT, TEXT, TEXT, UUID);
CREATE FUNCTION public.arca_ticket_lease_soltar(p_secreto TEXT, p_ambiente TEXT, p_cuit TEXT, p_lease UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  UPDATE public.arca_tickets SET lease_id = NULL, lease_hasta = NULL WHERE ambiente = p_ambiente AND cuit = p_cuit AND lease_id = p_lease;
END $$;

-- ── 5 · Comprobantes: reservar el número, autorizar, rechazar ───────────────
--  arca_comprobante_reservar: devuelve {estado, numero, ...}.
--    · 'autorizado' → ya estaba hecha (idempotente): no se emite otra.
--    · 'reservado'  → hay un intento SIN RESPUESTA: el servidor tiene que consultar a ARCA ese número antes de hacer nada.
--    · 'reservado' recién creado → emitir con ese número. p_ultimo_arca = último autorizado según ARCA (FECompUltimoAutorizado).
DROP FUNCTION IF EXISTS public.arca_comprobante_reservar(TEXT, TEXT, TEXT, INTEGER, INTEGER, BIGINT, INTEGER, TEXT);
CREATE FUNCTION public.arca_comprobante_reservar(
  p_secreto TEXT, p_orden TEXT, p_ambiente TEXT, p_pto_venta INTEGER, p_ultimo_arca INTEGER,
  p_importe_centavos BIGINT, p_doc_tipo INTEGER, p_doc_nro TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o public.meli_ordenes%ROWTYPE; c public.meli_comprobantes%ROWTYPE; v_num INTEGER; v_max INTEGER; v_nuevo BOOLEAN := TRUE;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF p_ambiente NOT IN ('homologacion', 'produccion') THEN RAISE EXCEPTION 'AMBIENTE_INVALIDO'; END IF;
  IF p_pto_venta IS NULL OR p_pto_venta NOT BETWEEN 1 AND 99999 THEN RAISE EXCEPTION 'PUNTO_VENTA_INVALIDO'; END IF;
  IF p_ultimo_arca IS NULL OR p_ultimo_arca < 0 OR p_ultimo_arca >= 99999999 THEN RAISE EXCEPTION 'ULTIMO_ARCA_INVALIDO'; END IF;
  IF p_doc_tipo IS NULL OR p_doc_tipo NOT IN (80, 86, 96, 99) OR p_doc_nro IS NULL OR p_doc_nro !~ '^[0-9]{1,20}$'
     OR (p_doc_tipo = 99 AND p_doc_nro <> '0') THEN RAISE EXCEPTION 'RECEPTOR_INVALIDO'; END IF;

  -- Candado por punto de venta: todo lo que sigue es de a una orden por vez.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_ambiente || '|' || p_pto_venta::text || '|11', 0));

  SELECT * INTO o FROM public.meli_ordenes WHERE meli_order_id = p_orden FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDEN_INEXISTENTE'; END IF;
  IF COALESCE(o.moneda, 'ARS') <> 'ARS' THEN RAISE EXCEPTION 'MONEDA_NO_SOPORTADA'; END IF;
  IF o.bruto IS NULL OR o.bruto <= 0 THEN RAISE EXCEPTION 'BRUTO_DESCONOCIDO'; END IF;
  IF round(o.bruto * 100)::BIGINT <> p_importe_centavos THEN RAISE EXCEPTION 'IMPORTE_NO_COINCIDE'; END IF;

  SELECT * INTO c FROM public.meli_comprobantes WHERE orden_id = p_orden FOR UPDATE;
  IF FOUND THEN
    IF c.estado IN ('autorizado', 'reservado') THEN
      RETURN jsonb_build_object('estado', c.estado, 'numero', c.numero, 'cae', c.cae, 'cae_vto', c.cae_vto, 'fecha_cbte', c.fecha_cbte,
                                'pto_venta', c.pto_venta, 'importe_centavos', c.importe_centavos, 'doc_tipo', c.doc_tipo, 'doc_nro', c.doc_nro, 'nuevo', FALSE);
    END IF;
    v_nuevo := FALSE;      -- estaba rechazado: se vuelve a intentar con un número nuevo
    IF c.ambiente <> p_ambiente OR c.pto_venta <> p_pto_venta THEN RAISE EXCEPTION 'COMPROBANTE_DATOS_FIJOS'; END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.meli_comprobantes x
              WHERE x.ambiente = p_ambiente AND x.pto_venta = p_pto_venta AND x.cbte_tipo = 11 AND x.estado = 'reservado' AND x.orden_id <> p_orden) THEN
    RAISE EXCEPTION 'NUMERACION_PENDIENTE';
  END IF;

  SELECT COALESCE(max(x.numero), 0) INTO v_max FROM public.meli_comprobantes x
   WHERE x.ambiente = p_ambiente AND x.pto_venta = p_pto_venta AND x.cbte_tipo = 11;
  v_num := GREATEST(p_ultimo_arca, v_max) + 1;
  IF v_num > 99999999 THEN RAISE EXCEPTION 'NUMERACION_AGOTADA'; END IF;

  IF v_nuevo THEN
    INSERT INTO public.meli_comprobantes (orden_id, ambiente, cbte_tipo, pto_venta, numero, estado, importe_centavos, doc_tipo, doc_nro)
    VALUES (p_orden, p_ambiente, 11, p_pto_venta, v_num, 'reservado', p_importe_centavos, p_doc_tipo, p_doc_nro);
  ELSE
    UPDATE public.meli_comprobantes SET estado = 'reservado', numero = v_num, importe_centavos = p_importe_centavos,
           doc_tipo = p_doc_tipo, doc_nro = p_doc_nro, intentos = intentos + 1, ultimo_error = NULL
     WHERE id = c.id;
  END IF;
  RETURN jsonb_build_object('estado', 'reservado', 'numero', v_num, 'pto_venta', p_pto_venta, 'importe_centavos', p_importe_centavos,
                            'doc_tipo', p_doc_tipo, 'doc_nro', p_doc_nro, 'nuevo', TRUE);
END $$;

-- Anota el CAE y deja la orden como "factura emitida" en el control (script 16). Idempotente con el mismo CAE.
DROP FUNCTION IF EXISTS public.arca_comprobante_autorizar(TEXT, TEXT, TEXT, DATE, DATE);
CREATE FUNCTION public.arca_comprobante_autorizar(p_secreto TEXT, p_orden TEXT, p_cae TEXT, p_cae_vto DATE, p_fecha_cbte DATE)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.meli_comprobantes%ROWTYPE; f public.meli_facturas%ROWTYPE;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF p_cae IS NULL OR p_cae !~ '^[0-9]{10,20}$' OR p_cae_vto IS NULL OR p_fecha_cbte IS NULL THEN RAISE EXCEPTION 'CAE_INVALIDO'; END IF;
  SELECT * INTO c FROM public.meli_comprobantes WHERE orden_id = p_orden;
  IF NOT FOUND THEN RAISE EXCEPTION 'COMPROBANTE_INEXISTENTE'; END IF;
  -- Mismo orden de bloqueos que arca_comprobante_reservar (primero el candado del punto de venta, después la fila): sin esperas cruzadas.
  PERFORM pg_advisory_xact_lock(hashtextextended(c.ambiente || '|' || c.pto_venta::text || '|11', 0));
  SELECT * INTO c FROM public.meli_comprobantes WHERE orden_id = p_orden FOR UPDATE;
  IF c.estado = 'autorizado' THEN
    IF c.cae = p_cae THEN RETURN jsonb_build_object('estado', 'autorizado', 'numero', c.numero, 'sin_cambios', TRUE); END IF;
    RAISE EXCEPTION 'COMPROBANTE_YA_AUTORIZADO_CON_OTRO_CAE';
  END IF;
  IF c.estado <> 'reservado' THEN RAISE EXCEPTION 'COMPROBANTE_NO_RESERVADO'; END IF;
  UPDATE public.meli_comprobantes SET estado = 'autorizado', cae = p_cae, cae_vto = p_cae_vto, fecha_cbte = p_fecha_cbte, ultimo_error = NULL WHERE id = c.id;

  -- Control de facturas (script 16): solo las facturas de PRODUCCIÓN cuentan como emitidas; las de homologación no tienen valor fiscal.
  IF c.ambiente = 'produccion' THEN
    SELECT * INTO f FROM public.meli_facturas WHERE orden_id = p_orden FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.meli_facturas (orden_id, estado, tipo, pto_venta, numero, emitida_el, marcada_por, marcada_uid)
      VALUES (p_orden, 'emitida', 'C', c.pto_venta, c.numero, p_fecha_cbte, 'ARCA automático', 'arca');
    ELSIF f.estado = 'emitida' THEN
      IF f.tipo IS DISTINCT FROM 'C' OR f.pto_venta IS DISTINCT FROM c.pto_venta OR f.numero IS DISTINCT FROM c.numero THEN
        RAISE EXCEPTION 'CONTROL_DE_FACTURAS_YA_TIENE_OTRA';
      END IF;
    ELSE
      UPDATE public.meli_facturas SET estado = 'emitida', tipo = 'C', pto_venta = c.pto_venta, numero = c.numero, emitida_el = p_fecha_cbte,
             motivo = NULL, version = f.version + 1, marcada_por = 'ARCA automático', marcada_uid = 'arca', marcada_en = now()
       WHERE orden_id = p_orden;
    END IF;
  END IF;
  RETURN jsonb_build_object('estado', 'autorizado', 'numero', c.numero);
END $$;

-- ARCA dijo que NO (o consultada la reserva, ese número no existe): el número queda libre. Solo desde 'reservado'.
DROP FUNCTION IF EXISTS public.arca_comprobante_rechazar(TEXT, TEXT, TEXT);
CREATE FUNCTION public.arca_comprobante_rechazar(p_secreto TEXT, p_orden TEXT, p_error TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.meli_comprobantes%ROWTYPE;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  SELECT * INTO c FROM public.meli_comprobantes WHERE orden_id = p_orden FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'COMPROBANTE_INEXISTENTE'; END IF;
  IF c.estado = 'rechazado' THEN RETURN jsonb_build_object('estado', 'rechazado', 'sin_cambios', TRUE); END IF;
  IF c.estado <> 'reservado' THEN RAISE EXCEPTION 'COMPROBANTE_NO_RESERVADO'; END IF;
  UPDATE public.meli_comprobantes SET estado = 'rechazado', numero = NULL, ultimo_error = left(COALESCE(p_error, 'rechazado'), 300) WHERE id = c.id;
  RETURN jsonb_build_object('estado', 'rechazado');
END $$;

-- Lo único que el servidor necesita saber de la orden para facturar: a qué cuenta pertenece, el bruto exacto en centavos y que
-- esté pagada. NADA del comprador. Solo órdenes en pesos y pagadas.
DROP FUNCTION IF EXISTS public.arca_orden_para_facturar(TEXT, TEXT);
CREATE FUNCTION public.arca_orden_para_facturar(p_secreto TEXT, p_orden TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o public.meli_ordenes%ROWTYPE;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  SELECT * INTO o FROM public.meli_ordenes WHERE meli_order_id = p_orden;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDEN_INEXISTENTE'; END IF;
  IF COALESCE(o.moneda, 'ARS') <> 'ARS' THEN RAISE EXCEPTION 'MONEDA_NO_SOPORTADA'; END IF;
  IF o.estado IS DISTINCT FROM 'paid' THEN RAISE EXCEPTION 'ORDEN_NO_FACTURABLE'; END IF;
  IF o.bruto IS NULL OR o.bruto <= 0 THEN RAISE EXCEPTION 'BRUTO_DESCONOCIDO'; END IF;
  RETURN jsonb_build_object('cuenta_id', o.cuenta_id, 'bruto_centavos', round(o.bruto * 100)::BIGINT, 'moneda', 'ARS');
END $$;

REVOKE ALL ON FUNCTION
  public.arca_ticket_leer(TEXT, TEXT, TEXT), public.arca_ticket_lease_tomar(TEXT, TEXT, TEXT),
  public.arca_ticket_guardar(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ), public.arca_ticket_lease_soltar(TEXT, TEXT, TEXT, UUID),
  public.arca_comprobante_reservar(TEXT, TEXT, TEXT, INTEGER, INTEGER, BIGINT, INTEGER, TEXT),
  public.arca_comprobante_autorizar(TEXT, TEXT, TEXT, DATE, DATE), public.arca_comprobante_rechazar(TEXT, TEXT, TEXT), public.arca_orden_para_facturar(TEXT, TEXT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.arca_ticket_leer(TEXT, TEXT, TEXT), public.arca_ticket_lease_tomar(TEXT, TEXT, TEXT),
  public.arca_ticket_guardar(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ), public.arca_ticket_lease_soltar(TEXT, TEXT, TEXT, UUID),
  public.arca_comprobante_reservar(TEXT, TEXT, TEXT, INTEGER, INTEGER, BIGINT, INTEGER, TEXT),
  public.arca_comprobante_autorizar(TEXT, TEXT, TEXT, DATE, DATE), public.arca_comprobante_rechazar(TEXT, TEXT, TEXT), public.arca_orden_para_facturar(TEXT, TEXT)
TO anon, authenticated;

COMMIT;

-- Verificación (solo lectura): tiene que dar dos filas con ✅.
SELECT 'tablas y funciones' AS control,
       CASE WHEN to_regclass('public.meli_comprobantes') IS NOT NULL AND to_regclass('public.arca_tickets') IS NOT NULL
             AND to_regprocedure('public.arca_comprobante_reservar(text,text,text,integer,integer,bigint,integer,text)') IS NOT NULL THEN '✅' ELSE '❌' END AS resultado
UNION ALL
SELECT 'tablas cerradas al navegador',
       CASE WHEN NOT has_table_privilege('anon', 'public.arca_tickets', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.arca_tickets', 'SELECT')
             AND NOT has_table_privilege('anon', 'public.meli_comprobantes', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.meli_comprobantes', 'INSERT') THEN '✅' ELSE '❌' END;
