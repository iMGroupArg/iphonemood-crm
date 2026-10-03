-- ============================================================================
--  MERCADO LIBRE → CRM · esquema base
--
--  PENDIENTE DE CORRER. Es la base de la que dependen Stock (vincular
--  publicaciones) y Ventas+Cueva (venta con bruto/neto/comisión). Leerlo antes
--  de construir encima.
--
--  Principio que ordena todo el archivo: los tokens de Mercado Libre NO pueden
--  ser legibles desde el navegador. La anon key se sirve pública en config.js,
--  así que cualquier tabla legible por `authenticated` es legible por cualquiera
--  que se registre. Por eso:
--
--    · `meli_cuentas` queda CERRADA: sin políticas, nadie la lee ni la escribe
--      desde el cliente. Ni el CRM.
--    · El CRM ve las cuentas por la vista `meli_cuentas_estado`, que no expone
--      ningún token.
--    · El servidor (Vercel) entra sólo por funciones RPC acotadas, cada una con
--      un secreto compartido. Se eligió esto en vez de poner la service-role key
--      en Vercel: si el secreto se filtra, el atacante puede hacer exactamente
--      estas cinco operaciones y nada más; con la service-role tendría la base
--      entera.
-- ============================================================================


-- search_path de TODAS las funciones: `public, pg_temp`, con pg_temp EXPLÍCITO y al
-- final. Con sólo `public`, Postgres igual busca primero en pg_temp, así que una
-- tabla temporal con el nombre de una real la taparía dentro de una función que
-- corre con los permisos del dueño. (Lo marcó la revisión de código.)
-- TODO EL ARCHIVO CORRE EN UNA TRANSACCIÓN: si algo falla a mitad, no queda
-- el esquema a medio crear. Es la razón por la que el control de tipos y el de
-- cajas duplicadas están al principio.
BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
--  0. GUARDA DE TIPOS
--
--  El esquema asume que `stock.id` y `personas.id` son UUID. Si alguno fuera
--  bigint, el CREATE TABLE de más abajo falla a mitad del script y queda todo
--  a medio crear. Mejor frenar acá con un mensaje que se entienda.
--  (Verificado el 2026-10-02 contra la base: los dos son UUID.)
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE t_stock TEXT; t_pers TEXT;
BEGIN
  SELECT data_type INTO t_stock FROM information_schema.columns
   WHERE table_schema='public' AND table_name='stock' AND column_name='id';
  SELECT data_type INTO t_pers FROM information_schema.columns
   WHERE table_schema='public' AND table_name='personas' AND column_name='id';

  IF t_stock IS DISTINCT FROM 'uuid' THEN
    RAISE EXCEPTION 'stock.id es % y este esquema espera uuid — ajustar meli_publicaciones y meli_orden_items antes de correr', COALESCE(t_stock,'(no existe)');
  END IF;
  IF t_pers IS DISTINCT FROM 'uuid' THEN
    RAISE EXCEPTION 'personas.id es % y este esquema espera uuid — ajustar meli_cuentas antes de correr', COALESCE(t_pers,'(no existe)');
  END IF;
END $$;


-- ════════════════════════════════════════════════════════════════════════════
--  1. CUENTAS
--
--  Multi-cuenta desde el día 1 porque Franco va a abrir una segunda. Cada
--  cuenta de MELI apunta a una persona y a un bolsillo de caja, así se sabe a
--  quién le entra la plata sin tener que preguntarlo después.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.meli_cuentas (
  id              BIGSERIAL PRIMARY KEY,
  meli_user_id    TEXT        NOT NULL UNIQUE,   -- id de vendedor que devuelve MELI
  nickname        TEXT,
  persona_id      UUID        REFERENCES public.personas(id),
  bolsillo        TEXT,                          -- ej. 'ARS Mercado Pago'

  -- Tokens. Nunca salen de la base por otra vía que las RPC de abajo.
  access_token    TEXT,
  refresh_token   TEXT,
  token_expira_en TIMESTAMPTZ,

  -- Candado de refresco. El refresh token de MELI es de UN SOLO USO y rota:
  -- sólo vale el último emitido. Vercel corre varias instancias en paralelo,
  -- así que dos refrescos simultáneos queman el token y dejan la cuenta afuera
  -- hasta que Franco vuelva a autorizar a mano. Este campo es el que hace que
  -- sólo una instancia refresque a la vez.
  refrescando_hasta TIMESTAMPTZ,

  activa          BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Se marca cuando el refresh falla de forma definitiva: el CRM muestra
  -- "reconectar" en vez de fallar en silencio cada 6 horas.
  requiere_reconexion BOOLEAN NOT NULL DEFAULT FALSE,
  ultimo_error    TEXT,

  creado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lo único que el CRM necesita ver: qué cuentas hay y cómo están. Sin tokens.
-- DROP antes de crear: en una SEGUNDA corrida la vista ya existe con 12 columnas (la
-- parte 2 le agrega `refresh_ambiguo`), y CREATE OR REPLACE no puede reemplazarla por
-- esta versión de 11: "cannot drop columns from view". Nada depende de la vista.
DROP VIEW IF EXISTS public.meli_cuentas_estado;
CREATE OR REPLACE VIEW public.meli_cuentas_estado
WITH (security_invoker = false) AS
SELECT
  c.id,
  c.meli_user_id,
  c.nickname,
  c.persona_id,
  c.bolsillo,
  c.activa,
  c.requiere_reconexion,
  c.ultimo_error,
  (c.refresh_token IS NOT NULL)                      AS conectada,
  (c.token_expira_en IS NOT NULL
     AND c.token_expira_en > NOW())                  AS token_vigente,
  c.creado_en
FROM public.meli_cuentas c
-- La vista corre como dueña (security_invoker=false), así que sin este filtro
-- la leería CUALQUIER usuario registrado, no sólo los autorizados del CRM.
WHERE public.is_authorized_user();


-- ════════════════════════════════════════════════════════════════════════════
--  2. PUBLICACIONES  (publicación de MELI ↔ fila de stock)
--
--  En MELI hay sólo una PARTE del stock del CRM: MELI suele pedir factura por
--  producto, así que no se publica todo. Por eso el vínculo es explícito y
--  manual, no una regla automática.
--
--  `meli_variacion_id` existe por los decants: un mismo MLA puede tener 5ml y
--  10ml como variaciones, y cada una es otra fila de stock.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.meli_publicaciones (
  id                BIGSERIAL PRIMARY KEY,
  cuenta_id         BIGINT   NOT NULL REFERENCES public.meli_cuentas(id) ON DELETE CASCADE,
  meli_item_id      TEXT     NOT NULL,            -- MLA…
  meli_variacion_id TEXT,                         -- NULL si la publicación no tiene variaciones
  stock_id          UUID     REFERENCES public.stock(id) ON DELETE SET NULL,

  titulo_meli       TEXT,                         -- como figura en MELI, para la pantalla de vinculación
  cantidad_publicada INTEGER,                     -- cuánto hay ofrecido en MELI (para la fase 2)

  creado_en         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- OJO: un UNIQUE normal sobre (cuenta, item, variacion) NO evita duplicados
-- cuando la variación es NULL — en Postgres dos NULL no se consideran iguales,
-- así que se podría vincular dos veces la misma publicación sin variación.
-- Por eso el índice va sobre COALESCE.
CREATE UNIQUE INDEX IF NOT EXISTS meli_publicaciones_unica
  ON public.meli_publicaciones (cuenta_id, meli_item_id, COALESCE(meli_variacion_id, ''));

CREATE INDEX IF NOT EXISTS meli_publicaciones_stock ON public.meli_publicaciones (stock_id);

-- ── "A pedido" y Mercado Libre ───────────────────────────────────────────
-- Un producto a pedido (stock.a_pedido = true, definido por Stock) no tiene stock
-- físico: descontar y reponer no tocan su cantidad (ver meli__descontar_core y
-- meli_reponer_stock). Y NO se vincula a una publicación: la fase 2 empujaría a MELI
-- la cantidad de stock, y para una fila a pedido ese número no significa nada. La
-- columna se repite acá (idempotente) por si este archivo corre antes que
-- stock_a_pedido.sql.
ALTER TABLE public.stock ADD COLUMN IF NOT EXISTS a_pedido BOOLEAN NOT NULL DEFAULT FALSE;

-- Del lado de la publicación: no se puede apuntar a un producto a pedido. FOR SHARE
-- traba la fila de stock hasta que esta transacción termine, así una marcación
-- simultánea de a_pedido espera, y al seguir ve el vínculo (y lo rechaza el otro
-- trigger). Sin el bloqueo, las dos transacciones podrían confirmar sin verse.
CREATE OR REPLACE FUNCTION public.meli__publicacion_sin_a_pedido()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ped BOOLEAN;
BEGIN
  IF NEW.stock_id IS NULL THEN RETURN NEW; END IF;
  SELECT COALESCE(s.a_pedido, FALSE) INTO v_ped
    FROM public.stock s WHERE s.id = NEW.stock_id
     FOR SHARE;
  IF v_ped IS TRUE THEN
    RAISE EXCEPTION 'A_PEDIDO_NO_SE_VINCULA'
      USING DETAIL = 'El producto es a pedido: no se puede vincular a una publicación de Mercado Libre.';
  END IF;
  RETURN NEW;
END; $$;
REVOKE EXECUTE ON FUNCTION public.meli__publicacion_sin_a_pedido() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS meli_publicacion_sin_a_pedido ON public.meli_publicaciones;
CREATE TRIGGER meli_publicacion_sin_a_pedido
  BEFORE INSERT OR UPDATE OF stock_id ON public.meli_publicaciones
  FOR EACH ROW EXECUTE FUNCTION public.meli__publicacion_sin_a_pedido();

-- Del lado del stock: no se puede marcar a pedido un producto que ya está vinculado.
-- Sólo se dispara al PASAR a verdadero. Al desmarcarlo no hace falta nada.
CREATE OR REPLACE FUNCTION public.meli__stock_a_pedido_sin_vinculo()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- La garantía exige READ COMMITTED: al seguir tras esperar un bloqueo, la consulta de
  -- abajo vuelve a mirar los datos y ve el vínculo recién confirmado. En REPEATABLE
  -- READ conserva el snapshot viejo (el FOR SHARE de la otra transacción no modificó
  -- esta fila, así que ni siquiera hay error de serialización) y dejaría pasar la
  -- marca. PostgREST usa READ COMMITTED; esto defiende frente a SQL con otro nivel.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'AISLAMIENTO_NO_SOPORTADO';
  END IF;
  IF EXISTS (SELECT 1 FROM public.meli_publicaciones p WHERE p.stock_id = NEW.id) THEN
    RAISE EXCEPTION 'A_PEDIDO_VINCULADO_A_MELI'
      USING DETAIL = 'El producto está vinculado a una publicación de Mercado Libre: desvincularlo antes de marcarlo a pedido.';
  END IF;
  RETURN NEW;
END; $$;
REVOKE EXECUTE ON FUNCTION public.meli__stock_a_pedido_sin_vinculo() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS meli_stock_a_pedido_sin_vinculo ON public.stock;
CREATE TRIGGER meli_stock_a_pedido_sin_vinculo
  BEFORE UPDATE OF a_pedido ON public.stock
  FOR EACH ROW
  WHEN (NEW.a_pedido IS TRUE AND OLD.a_pedido IS DISTINCT FROM TRUE)
  EXECUTE FUNCTION public.meli__stock_a_pedido_sin_vinculo();


-- ════════════════════════════════════════════════════════════════════════════
--  3. NOTIFICACIONES  (la bandeja cruda del webhook)
--
--  MELI espera respuesta rápida y reenvía si tarda. El webhook sólo anota acá
--  y responde; procesar es otro paso. Además queda el registro de lo que MELI
--  mandó de verdad, que sirve cuando algo no cierra.
--
--  La notificación es un AVISO, nunca un dato: lo que se cree es lo que
--  devuelve `GET /orders/{id}` con nuestro token, no lo que vino en el cuerpo.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.meli_notificaciones (
  id             BIGSERIAL PRIMARY KEY,
  meli_user_id   TEXT,
  topico         TEXT,                            -- 'orders_v2', 'payments', …
  recurso        TEXT,                            -- '/orders/123…'
  payload        JSONB,
  recibida_en    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  procesada_en   TIMESTAMPTZ,
  error          TEXT
);

CREATE INDEX IF NOT EXISTS meli_notificaciones_pendientes
  ON public.meli_notificaciones (recibida_en) WHERE procesada_en IS NULL;


-- ════════════════════════════════════════════════════════════════════════════
--  4. ÓRDENES
--
--  Idempotente por id de orden: MELI reenvía la misma orden y la actualiza
--  (pasa de pagada a enviada a entregada), así que se hace UPSERT, nunca
--  INSERT a ciegas.
--
--  Se guardan bruto Y neto porque son dos números distintos y los dos importan:
--  el bruto es lo que pagó el cliente, el neto es lo que entra a la cuenta. La
--  diferencia es comisión + envío de Mercado Libre, y va como concepto
--  EXPLÍCITO: cargarla como quebranto distorsionaría el margen.
--
--  MODO OBSERVACIÓN: la orden se registra sola, pero convertirla en venta,
--  descontar stock y tocar caja es un botón por orden hasta que Franco confíe.
--  Por eso `procesada` arranca en false y nadie la mueve automáticamente.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.meli_ordenes (
  id                BIGSERIAL PRIMARY KEY,
  cuenta_id         BIGINT   NOT NULL REFERENCES public.meli_cuentas(id),
  meli_order_id     TEXT     NOT NULL UNIQUE,     -- la idempotencia vive acá
  estado            TEXT,                         -- paid, cancelled, …
  estado_envio      TEXT,

  comprador         TEXT,
  fecha_orden       TIMESTAMPTZ,

  moneda            TEXT     NOT NULL DEFAULT 'ARS',
  bruto             NUMERIC(18,2),                -- lo que pagó el comprador
  neto              NUMERIC(18,2),                -- net_received_amount de Mercado Pago
  comision_envio    NUMERIC(18,2),                -- bruto - neto, explícito

  pago_id           TEXT,
  fecha_liberacion  TIMESTAMPTZ,                  -- money_release_date

  -- Banderas de proceso. Cada una se reclama una sola vez, de forma atómica.
  stock_descontado  BOOLEAN  NOT NULL DEFAULT FALSE,
  procesada         BOOLEAN  NOT NULL DEFAULT FALSE,
  venta_id          BIGINT,                       -- la venta del CRM, cuando se crea

  -- Acreditación en caja. `acreditado` es la bandera que Ventas+Cueva reclama
  -- de forma atómica (UPDATE … WHERE acreditado=false RETURNING) ANTES de
  -- tocar la caja, para que dos clics no acrediten dos veces.
  -- `monto_acreditado` es lo que REALMENTE entró, confirmado a mano: puede no
  -- coincidir con `neto` si MELI descontó algo más.
  acreditado        BOOLEAN  NOT NULL DEFAULT FALSE,
  monto_acreditado  NUMERIC(18,2),
  acreditado_en     TIMESTAMPTZ,

  -- Cancelaciones y devoluciones se resuelven a mano, pero tienen que gritar.
  revisar           BOOLEAN  NOT NULL DEFAULT FALSE,
  motivo_revisar    TEXT,

  payload_orden     JSONB,                        -- respuesta cruda, para auditar
  payload_pago      JSONB,

  creado_en         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS meli_ordenes_pendientes
  ON public.meli_ordenes (fecha_orden DESC) WHERE procesada = FALSE;
CREATE INDEX IF NOT EXISTS meli_ordenes_revisar
  ON public.meli_ordenes (fecha_orden DESC) WHERE revisar = TRUE;
CREATE INDEX IF NOT EXISTS meli_ordenes_a_liberar
  ON public.meli_ordenes (fecha_liberacion) WHERE acreditado = FALSE;


-- ════════════════════════════════════════════════════════════════════════════
--  5. ÍTEMS DE LA ORDEN
--
--  Una orden de MELI puede traer varios productos. Sin esta tabla no se puede
--  descontar stock bien: habría que adivinar qué se vendió. No estaba en el
--  pedido original; se agrega porque sin ella el punto 1 del plan (descontar
--  stock al venderse) no se puede cumplir con más de un ítem por orden.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.meli_orden_items (
  id                BIGSERIAL PRIMARY KEY,
  orden_id          BIGINT   NOT NULL REFERENCES public.meli_ordenes(id) ON DELETE CASCADE,
  meli_item_id      TEXT     NOT NULL,
  meli_variacion_id TEXT,
  titulo            TEXT,
  cantidad          INTEGER  NOT NULL DEFAULT 1,
  precio_unitario   NUMERIC(18,2),

  -- Se resuelve contra meli_publicaciones al registrar. Si queda en NULL es que
  -- la publicación no estaba vinculada: la orden se marca `revisar` en vez de
  -- descontar de una fila equivocada.
  stock_id          UUID     REFERENCES public.stock(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS meli_orden_items_orden ON public.meli_orden_items (orden_id);

-- Cuántas unidades sacó DE VERDAD el descuento de este ítem (0 si era "a pedido"; NULL si
-- todavía no se descontó). Reponer devuelve EXACTAMENTE esto y no mira la bandera actual
-- del stock: si alguien cambia stock.a_pedido entre el descuento y la reversión, mirar la
-- bandera de hoy no repondría lo que se descontó (de físico a pedido) o inventaría stock
-- (de a pedido a físico). La escribe meli__descontar_core, bajo el bloqueo de la orden;
-- los ítems de una orden ya descontada no se reescriben (ver meli_ingresar_orden).
ALTER TABLE public.meli_orden_items ADD COLUMN IF NOT EXISTS descontado_cantidad INTEGER;


-- ════════════════════════════════════════════════════════════════════════════
--  6. RLS
--
--  Las cuatro tablas de datos las lee el CRM (usuario logueado y autorizado).
--  `meli_cuentas` NO: queda sin una sola política, o sea cerrada para todos los
--  roles del cliente. Se accede sólo por las RPC de abajo.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.meli_cuentas        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meli_publicaciones  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meli_notificaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meli_ordenes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meli_orden_items    ENABLE ROW LEVEL SECURITY;

-- meli_cuentas: SIN POLÍTICAS a propósito. Con RLS activo y cero políticas,
-- nadie lee ni escribe desde el cliente. No agregar ninguna.

DROP POLICY IF EXISTS "meli_publicaciones_all" ON public.meli_publicaciones;
CREATE POLICY "meli_publicaciones_all" ON public.meli_publicaciones
  USING (public.is_authorized_user()) WITH CHECK (public.is_authorized_user());

-- Órdenes e ítems: LECTURA para el CRM, escritura NO.
--
-- Una policy FOR ALL dejaría a cualquier usuario autorizado editar `bruto` o
-- `neto` a mano desde el navegador, que es justo lo contrario del principio
-- acordado: "toda orden real se registra completa, sin montos editables".
-- Los montos los pone el servidor leyendo MELI; lo único que el CRM cambia es
-- el estado del proceso, y eso pasa por las RPC de la sección 8, que validan
-- la transición entera en una sola sentencia.
DROP POLICY IF EXISTS "meli_ordenes_lectura" ON public.meli_ordenes;
CREATE POLICY "meli_ordenes_lectura" ON public.meli_ordenes
  FOR SELECT USING (public.is_authorized_user());

DROP POLICY IF EXISTS "meli_orden_items_lectura" ON public.meli_orden_items;
CREATE POLICY "meli_orden_items_lectura" ON public.meli_orden_items
  FOR SELECT USING (public.is_authorized_user());

DROP POLICY IF EXISTS "meli_notificaciones_lectura" ON public.meli_notificaciones;
CREATE POLICY "meli_notificaciones_lectura" ON public.meli_notificaciones
  FOR SELECT USING (public.is_authorized_user());

-- La vista de estado corre como dueña, así puede leer la tabla cerrada y
-- mostrar sólo lo que no es secreto.
GRANT SELECT ON public.meli_cuentas_estado TO authenticated;


-- ════════════════════════════════════════════════════════════════════════════
--  7. LA PUERTA DEL SERVIDOR
--
--  Todas las funciones comparan contra un secreto que vive en una variable de
--  entorno de Vercel (`MELI_RPC_SECRET`) y se guarda acá como hash, nunca en
--  claro. Si alguien lee la base, no se lleva el secreto.
--
--  Antes de correr este archivo, generar el secreto y poner su SHA-256 abajo:
--      openssl rand -base64 32          → va a Vercel como MELI_RPC_SECRET
--      printf '%s' "<ese valor>" | shasum -a 256
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.meli_config (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
ALTER TABLE public.meli_config ENABLE ROW LEVEL SECURITY;
-- Sin políticas: cerrada igual que meli_cuentas.

-- Hash del secreto ya generado y cargado en Vercel como MELI_RPC_SECRET.
-- Esto es el SHA-256, no el secreto: publicarlo no compromete nada.
INSERT INTO public.meli_config (clave, valor)
  VALUES ('rpc_secret_sha256', '94e64c31a1ef061d9093a9aa3c452ff227640c4e2f8c1a27e63c8ba35094b3c9')
  ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor;

CREATE OR REPLACE FUNCTION public.meli_secreto_ok(p_secreto TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_hash TEXT;
BEGIN
  IF p_secreto IS NULL OR length(p_secreto) < 20 THEN RETURN FALSE; END IF;
  SELECT valor INTO v_hash FROM meli_config WHERE clave = 'rpc_secret_sha256';
  IF v_hash IS NULL THEN RETURN FALSE; END IF;   -- sin secreto cargado, cerrado
  RETURN encode(digest(p_secreto, 'sha256'), 'hex') = v_hash;
END;
$$;
-- `digest` viene de pgcrypto; en Supabase ya está disponible:
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;


-- ── 7.1 Tomar tokens, reclamando el candado de refresco ──────────────────
--
-- Devuelve los tokens y, si hay que refrescar, reclama el candado de forma
-- atómica. `debe_refrescar` sale TRUE en UNA SOLA instancia: las demás reciben
-- FALSE y esperan. Esto es lo que impide quemar el refresh token rotativo.
--
-- (Esta versión la REEMPLAZA la de la parte 2, con la misma firma pero otro
-- RETURNS TABLE. En una segunda corrida, CREATE OR REPLACE no puede cambiar el tipo
-- de retorno de la que ya quedó creada: por eso se borra antes.)
DROP FUNCTION IF EXISTS public.meli_tokens_tomar(TEXT, BIGINT, INT);
CREATE OR REPLACE FUNCTION public.meli_tokens_tomar(
  p_secreto TEXT, p_cuenta_id BIGINT, p_margen_seg INT DEFAULT 600)
RETURNS TABLE (access_token TEXT, refresh_token TEXT, debe_refrescar BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v RECORD;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;

  SELECT * INTO v FROM meli_cuentas WHERE id = p_cuenta_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'cuenta inexistente'; END IF;

  -- ¿Hace falta refrescar y el candado está libre (o vencido por un intento
  -- que murió a mitad de camino)?
  IF (v.token_expira_en IS NULL OR v.token_expira_en < NOW() + (p_margen_seg || ' seconds')::INTERVAL)
     AND (v.refrescando_hasta IS NULL OR v.refrescando_hasta < NOW())
  THEN
    UPDATE meli_cuentas
       SET refrescando_hasta = NOW() + INTERVAL '60 seconds'
     WHERE id = p_cuenta_id;
    RETURN QUERY SELECT v.access_token, v.refresh_token, TRUE;
  ELSE
    RETURN QUERY SELECT v.access_token, v.refresh_token, FALSE;
  END IF;
END;
$$;

-- ── 7.2 Guardar los tokens nuevos y soltar el candado ────────────────────
CREATE OR REPLACE FUNCTION public.meli_tokens_guardar(
  p_secreto TEXT, p_cuenta_id BIGINT,
  p_access TEXT, p_refresh TEXT, p_expira_en_seg INT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  UPDATE meli_cuentas
     SET access_token    = p_access,
         refresh_token   = COALESCE(p_refresh, refresh_token),
         token_expira_en = NOW() + (p_expira_en_seg || ' seconds')::INTERVAL,
         refrescando_hasta = NULL,
         requiere_reconexion = FALSE,
         ultimo_error    = NULL,
         actualizado_en  = NOW()
   WHERE id = p_cuenta_id;
END;
$$;

-- ── 7.3 Marcar que la cuenta necesita reconectarse ───────────────────────
-- Cuando el refresh falla definitivamente (token vencido o ya usado), no sirve
-- reintentar: hay que avisarle a Franco que vuelva a autorizar.
CREATE OR REPLACE FUNCTION public.meli_marcar_reconexion(
  p_secreto TEXT, p_cuenta_id BIGINT, p_error TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  UPDATE meli_cuentas
     SET requiere_reconexion = TRUE, ultimo_error = p_error,
         refrescando_hasta = NULL, actualizado_en = NOW()
   WHERE id = p_cuenta_id;
END;
$$;

-- ── 7.4 Anotar la notificación del webhook ───────────────────────────────
CREATE OR REPLACE FUNCTION public.meli_notificacion_registrar(
  p_secreto TEXT, p_user_id TEXT, p_topico TEXT, p_recurso TEXT, p_payload JSONB)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_id BIGINT;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  INSERT INTO meli_notificaciones (meli_user_id, topico, recurso, payload)
  VALUES (p_user_id, p_topico, p_recurso, p_payload)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ── 7.5 Alta/actualización idempotente de la orden ───────────────────────
CREATE OR REPLACE FUNCTION public.meli_orden_registrar(
  p_secreto TEXT, p_cuenta_id BIGINT, p_orden JSONB)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_id BIGINT;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;

  INSERT INTO meli_ordenes (
    cuenta_id, meli_order_id, estado, estado_envio, comprador, fecha_orden,
    moneda, bruto, neto, comision_envio, pago_id, fecha_liberacion,
    revisar, motivo_revisar, payload_orden, payload_pago)
  VALUES (
    p_cuenta_id,
    p_orden->>'meli_order_id',
    p_orden->>'estado',
    p_orden->>'estado_envio',
    p_orden->>'comprador',
    (p_orden->>'fecha_orden')::TIMESTAMPTZ,
    COALESCE(p_orden->>'moneda', 'ARS'),
    (p_orden->>'bruto')::NUMERIC,
    (p_orden->>'neto')::NUMERIC,
    (p_orden->>'comision_envio')::NUMERIC,
    p_orden->>'pago_id',
    (p_orden->>'fecha_liberacion')::TIMESTAMPTZ,
    COALESCE((p_orden->>'revisar')::BOOLEAN, FALSE),
    p_orden->>'motivo_revisar',
    p_orden->'payload_orden',
    p_orden->'payload_pago')
  ON CONFLICT (meli_order_id) DO UPDATE SET
    estado           = EXCLUDED.estado,
    estado_envio     = EXCLUDED.estado_envio,
    bruto            = EXCLUDED.bruto,
    neto             = EXCLUDED.neto,
    comision_envio   = EXCLUDED.comision_envio,
    pago_id          = EXCLUDED.pago_id,
    fecha_liberacion = EXCLUDED.fecha_liberacion,
    -- Si una orden que YA se procesó pasa a cancelada o devuelta, hay plata y
    -- stock que ya se movieron: no se puede deshacer solo, tiene que verlo una
    -- persona. Por eso se fuerza `revisar` en ese caso puntual.
    revisar          = meli_ordenes.revisar
                       OR EXCLUDED.revisar
                       OR (meli_ordenes.procesada
                           AND lower(COALESCE(EXCLUDED.estado,'')) IN ('cancelled','refunded','invalid')),
    motivo_revisar   = CASE
                         WHEN meli_ordenes.procesada
                          AND lower(COALESCE(EXCLUDED.estado,'')) IN ('cancelled','refunded','invalid')
                         THEN COALESCE(meli_ordenes.motivo_revisar,
                                'La orden pasó a "' || EXCLUDED.estado || '" DESPUÉS de procesarse: revisar stock y caja')
                         ELSE COALESCE(EXCLUDED.motivo_revisar, meli_ordenes.motivo_revisar)
                       END,
    payload_orden    = EXCLUDED.payload_orden,
    payload_pago     = EXCLUDED.payload_pago,
    actualizado_en   = NOW()
    -- NO se tocan stock_descontado, procesada, acreditado ni venta_id:
    -- una reentrega de MELI no puede deshacer lo ya procesado.
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ── 7.6 Reemplazar los ítems de la orden ─────────────────────────────────
-- Se borran y reinsertan en la misma transacción. Seguro mientras el stock no
-- esté descontado; si ya lo está, no se tocan, para que una reentrega no
-- cambie lo que se descontó.
CREATE OR REPLACE FUNCTION public.meli_orden_items_set(
  p_secreto TEXT, p_orden_id BIGINT, p_items JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_desc BOOLEAN; v_n INTEGER;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;

  -- FOR UPDATE: sin el bloqueo se puede leer stock_descontado=false mientras
  -- otra transacción está descontando, y después reemplazar justo los ítems que
  -- justificaron ese descuento. El bloqueo serializa ingesta y procesamiento.
  SELECT stock_descontado INTO v_desc
    FROM meli_ordenes WHERE id = p_orden_id FOR UPDATE;
  IF v_desc THEN RETURN 0; END IF;

  DELETE FROM meli_orden_items WHERE orden_id = p_orden_id;

  INSERT INTO meli_orden_items
    (orden_id, meli_item_id, meli_variacion_id, titulo, cantidad, precio_unitario, stock_id)
  SELECT
    p_orden_id,
    it->>'meli_item_id',
    it->>'meli_variacion_id',
    it->>'titulo',
    COALESCE((it->>'cantidad')::INT, 1),
    (it->>'precio_unitario')::NUMERIC,
    pub.stock_id
  FROM jsonb_array_elements(p_items) AS it
  LEFT JOIN meli_publicaciones pub
    ON pub.cuenta_id = (SELECT cuenta_id FROM meli_ordenes WHERE id = p_orden_id)
   AND pub.meli_item_id = it->>'meli_item_id'
   AND COALESCE(pub.meli_variacion_id, '') = COALESCE(it->>'meli_variacion_id', '');
  -- El filtro por cuenta NO es opcional: la misma fila de stock puede estar
  -- publicada desde dos cuentas, y sin él se podría resolver contra el vínculo
  -- de la cuenta equivocada.

  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- Si algún ítem quedó sin fila de stock, la publicación no estaba vinculada:
  -- la orden se marca para revisar en vez de descontar de donde no corresponde.
  UPDATE meli_ordenes SET
    revisar = TRUE,
    motivo_revisar = COALESCE(motivo_revisar, 'Hay ítems sin publicación vinculada')
  WHERE id = p_orden_id
    AND EXISTS (SELECT 1 FROM meli_orden_items
                 WHERE orden_id = p_orden_id AND stock_id IS NULL);

  RETURN v_n;
END;
$$;

-- ── 7.7 Descontar stock, atómico y una sola vez ──────────────────────────
--
-- El descuento se hace ACÁ, en la base, y es atómico: dos descuentos de Mercado
-- Libre simultáneos (o uno contra una fila sin stock suficiente) no se pisan ni
-- dejan la cantidad en negativo. `stock_descontado` evita procesar la MISMA orden
-- dos veces.
--
-- ⚠ ESTO NO PROTEGE CONTRA LAS VENTAS DEL LOCAL. Lo corrigió la revisión de código
-- (Codex): una venta hecha en el CRM toma la cantidad de SU COPIA EN MEMORIA, le
-- resta uno y escribe el valor ABSOLUTO (ventas.js → DB.actualizarCantidadStock →
-- `update({ cantidad })`). Si este descuento corrió mientras tanto, esa escritura
-- lo borra: hubo dos ventas y se descontó una. El `WHERE cantidad >= …` de abajo
-- sólo ordena a quienes usan ESTA función; no puede arreglar a los que no la usan.
-- La solución real es que el cliente descuente por DELTA en la base y no por valor
-- absoluto — ver la nota "PENDIENTE CRÍTICO" al final de este archivo.
--
-- Cuando la fila queda en cero, `estado_inventario` pasa a 'vendido' en la
-- MISMA sentencia. Hoy eso lo hace el navegador; desde el servidor tiene que
-- ser atómico o quedaría un producto en cero figurando como disponible.
-- El cuerpo es INTERNO: no se otorga a nadie. Quién puede llamarlo lo deciden
-- los dos envoltorios de abajo — uno para el servidor (secreto) y otro para el
-- CRM (sesión). La lógica vive en un solo lugar para que no se desincronicen.
CREATE OR REPLACE FUNCTION public.meli__descontar_core(p_orden_id BIGINT)
RETURNS TABLE (stock_id UUID, descontado INTEGER, queda INTEGER, agotado BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE r RECORD; v_queda INTEGER; v_ped BOOLEAN; v_ya BOOLEAN; v_faltante TEXT; v_con_imei TEXT; v_order_ref TEXT;
BEGIN
  -- BLOQUEO PRIMERO, antes de leer un solo ítem. Si se leyeran los ítems antes,
  -- la ingesta podría estar reemplazándolos justo mientras los medimos. Ingesta,
  -- descuento y reversión compiten todos por este mismo bloqueo.
  SELECT stock_descontado INTO v_ya FROM meli_ordenes WHERE id = p_orden_id FOR UPDATE;

  -- Orden ya descontada (un reintento, o el servidor y el CRM llegaron los dos): no se
  -- vuelve a mirar nada. Si siguiera, el chequeo de abajo vería el stock YA descontado
  -- (por ejemplo 1 → 0), lo tomaría por "insuficiente" y marcaría `revisar` una orden
  -- que está bien. Tampoco toca los motivos de revisión que ya tenga.
  IF v_ya IS TRUE THEN RETURN; END IF;

  -- PRIMER FRENO — filas con IMEI no se tocan desde acá.
  --
  -- Las unidades reales de una fila son GREATEST(array_length(imeis,1), cantidad),
  -- no `cantidad` sola. Si se descontara `cantidad` en una fila con IMEIs,
  -- quedaría en cero y marcada 'vendido' con el IMEI todavía adentro, y el panel
  -- de Stock se contradiría consigo mismo.
  --
  -- Tampoco se saca un IMEI del array: MELI no dice qué unidad física salió, y
  -- elegir una al azar sería inventar. Esas órdenes se marcan para que alguien
  -- elija la unidad a mano.
  SELECT string_agg(DISTINCT i.meli_item_id, ', ') INTO v_con_imei
    FROM meli_orden_items i
    JOIN stock s ON s.id = i.stock_id
   WHERE i.orden_id = p_orden_id
     AND COALESCE(array_length(s.imeis, 1), 0) > 0;

  IF v_con_imei IS NOT NULL THEN
    UPDATE meli_ordenes SET
      revisar = TRUE,
      motivo_revisar = COALESCE(motivo_revisar,
        'Producto con IMEI: elegir la unidad a mano (' || v_con_imei || ')'),
      actualizado_en = NOW()
     WHERE id = p_orden_id;
    RETURN;
  END IF;

  -- SEGUNDO FRENO — ¿alcanza el stock de TODOS los ítems? Si falta uno, no se
  -- descuenta ninguno: media orden descontada es peor que ninguna.
  SELECT string_agg(i.meli_item_id, ', ') INTO v_faltante
    FROM meli_orden_items i
    JOIN stock s ON s.id = i.stock_id
   WHERE i.orden_id = p_orden_id AND COALESCE(s.cantidad, 0) < i.cantidad
     -- Una fila "a pedido" no tiene stock físico que se agote: nunca falta.
     AND NOT COALESCE(s.a_pedido, FALSE);

  IF v_faltante IS NOT NULL THEN
    UPDATE meli_ordenes SET
      revisar = TRUE,
      motivo_revisar = COALESCE(motivo_revisar, 'Stock insuficiente para: ' || v_faltante),
      actualizado_en = NOW()
     WHERE id = p_orden_id;
    RETURN;
  END IF;

  -- Reclamo único: sólo una llamada pasa de acá.
  UPDATE meli_ordenes SET stock_descontado = TRUE, actualizado_en = NOW()
   WHERE id = p_orden_id AND stock_descontado = FALSE AND revisar = FALSE
  RETURNING meli_order_id INTO v_order_ref;
  IF NOT FOUND THEN RETURN; END IF;

  -- ORDER BY stock_id: cada vuelta bloquea una fila de stock (el UPDATE). Dos órdenes
  -- que comparten productos y los recorren en orden distinto se bloquean mutuamente:
  -- A tiene el producto 1 y espera el 2, B tiene el 2 y espera el 1. Con un orden común
  -- (y el mismo en la reposición) un ciclo es imposible. Lo marcó la revisión de código.
  FOR r IN
    SELECT i.id AS iid, i.stock_id AS sid, i.cantidad AS cant, i.meli_item_id AS item
      FROM meli_orden_items i
     WHERE i.orden_id = p_orden_id AND i.stock_id IS NOT NULL
     ORDER BY i.stock_id, i.meli_item_id
  LOOP
    -- "A pedido" (se lee ACÁ, ya bajo el bloqueo de la fila, no antes): no toca la
    -- cantidad ni el estado, y el movimiento igual queda. Si la bandera cambió desde
    -- el chequeo de arriba y ahora falta stock, la condición del WHERE no se cumple y
    -- salta la excepción de abajo (se deshace todo, como cualquier carrera perdida).
    UPDATE stock s
       SET cantidad = CASE WHEN COALESCE(s.a_pedido, FALSE) THEN s.cantidad
                           ELSE s.cantidad - r.cant END,
           estado_inventario = CASE WHEN COALESCE(s.a_pedido, FALSE) THEN s.estado_inventario
                                    WHEN s.cantidad - r.cant <= 0 THEN 'vendido'
                                    ELSE s.estado_inventario END
     WHERE s.id = r.sid
       AND (COALESCE(s.a_pedido, FALSE) OR COALESCE(s.cantidad, 0) >= r.cant)
    RETURNING s.cantidad, COALESCE(s.a_pedido, FALSE) INTO v_queda, v_ped;

    -- Carrera perdida: entre el chequeo y el descuento alguien vendió en el
    -- local. Se levanta excepción a propósito: la función corre en una sola
    -- transacción, así que esto deshace TAMBIÉN el reclamo de más arriba y la
    -- orden queda lista para reintentar, sin descuentos a medias.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'stock insuficiente al descontar (item %, fila %)', r.item, r.sid;
    END IF;

    -- El rastro va en la MISMA transacción que el descuento. Si se dejara para
    -- el navegador, un fallo del cliente dejaría stock descontado sin ninguna
    -- explicación en el historial del producto.
    INSERT INTO stock_movimientos
      (stock_id, tipo, detalle, cantidad_antes, cantidad_despues, usuario_nombre, datos)
    VALUES (
      r.sid, 'meli',
      'Venta de Mercado Libre (orden ' || COALESCE(v_order_ref, '?') || ')',
      CASE WHEN v_ped THEN COALESCE(v_queda, 0) ELSE v_queda + r.cant END,
      COALESCE(v_queda, 0), 'Mercado Libre',
      jsonb_build_object('meli_order_id', v_order_ref, 'meli_item_id', r.item,
                         'cantidad', r.cant, 'a_pedido', v_ped));

    -- Lo que se sacó de verdad queda en el ítem: es lo que va a devolver meli_reponer_stock.
    UPDATE meli_orden_items SET descontado_cantidad = CASE WHEN v_ped THEN 0 ELSE r.cant END
     WHERE id = r.iid;

    -- A pedido: `descontado` es 0 (no se sacó nada) y nunca figura agotado.
    stock_id := r.sid;
    descontado := CASE WHEN v_ped THEN 0 ELSE r.cant END;
    queda := COALESCE(v_queda, 0);
    agotado := (NOT v_ped) AND (v_queda <= 0);
    RETURN NEXT;
  END LOOP;
END;
$$;


-- ── 7.8 Asegurar la fila de caja de una cuenta ───────────────────────────
--
-- `DB.actualizarSaldoCaja` es sólo UPDATE y no hace nada si la fila no existe:
-- la acreditación fallaría en silencio. Al conectar una cuenta se crea la fila
-- en cero si falta. Idempotente, se puede llamar siempre.
-- Requisito de la función de abajo: sin esta restricción, el ON CONFLICT no
-- tiene contra qué resolver.
--
-- ANTES de crearla hay que saber si ya hay duplicados: si los hay, el CREATE
-- INDEX falla a mitad del script. No se borran solos — dos filas de caja con la
-- misma persona y bolsillo tienen saldos y referencias que hay que reconciliar
-- a mano, y elegir una por nosotros sería hacer desaparecer plata.
DO $$
DECLARE v_dup TEXT;
BEGIN
  SELECT string_agg(persona_id::text || ' / ' || bolsillo, ', ')
    INTO v_dup
    FROM (SELECT persona_id, bolsillo FROM public.cajas
           GROUP BY persona_id, bolsillo HAVING count(*) > 1) d;
  IF v_dup IS NOT NULL THEN
    RAISE EXCEPTION 'Hay cajas duplicadas y hay que reconciliarlas a mano antes de seguir: %', v_dup;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS cajas_persona_bolsillo_unica
  ON public.cajas (persona_id, bolsillo);

-- (Acá había una función `meli_asegurar_caja(secreto, persona, bolsillo)`. Se SACÓ:
-- nada la llamaba. `meli_cuenta_asignar_caja` hace su propio INSERT ... ON CONFLICT
-- contra este índice único, y Ventas+Cueva también. Una función expuesta que nadie
-- usa es superficie de ataque sin ningún beneficio. Ojo: `INSERT ... WHERE NOT
-- EXISTS` no evita la carrera entre dos llamadas; hace falta el índice único y
-- ON CONFLICT para que la base lo resuelva, que es lo que se usa.)


-- ── 7.9 Las dos puertas al descuento ─────────────────────────────────────
-- `meli_descontar_stock(secreto, orden)` es para el SERVIDOR (valida el secreto).
-- `meli_descontar_stock_crm(orden)` valida la sesión del usuario, pero más abajo se
-- le REVOCA el permiso a `authenticated` (y a PUBLIC, y a anon): el navegador NO
-- puede llamarla. Sólo la llaman, desde adentro de su propia transacción, las RPC
-- de Ventas+Cueva (`meli_procesar_orden`, `meli_revertir_orden`), que corren como
-- SECURITY DEFINER y por eso sí tienen permiso. Una versión anterior de este
-- comentario decía que el botón "Procesar" del navegador la llamaba: era falso.
CREATE OR REPLACE FUNCTION public.meli_descontar_stock(p_secreto TEXT, p_orden_id BIGINT)
RETURNS TABLE (stock_id UUID, descontado INTEGER, queda INTEGER, agotado BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  RETURN QUERY SELECT * FROM meli__descontar_core(p_orden_id);
END; $$;

CREATE OR REPLACE FUNCTION public.meli_descontar_stock_crm(p_orden_id BIGINT)
RETURNS TABLE (stock_id UUID, descontado INTEGER, queda INTEGER, agotado BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado'; END IF;
  RETURN QUERY SELECT * FROM meli__descontar_core(p_orden_id);
END; $$;


-- ════════════════════════════════════════════════════════════════════════════
--  8. PIEZAS DE STOCK PARA LAS RPC DE VENTAS+CUEVA
--
--  Acá vivían también `meli_marcar_procesada`, `meli_acreditar_reclamar` y
--  `meli_acreditar_deshacer`. Se ELIMINARON: la revisión de Codex del lado de
--  Ventas+Cueva mostró que en pasos separados desde el navegador, si la pestaña
--  muere después de guardar el saldo, reintentar acredita dos veces. Eso pasa a
--  ser UNA RPC transaccional por operación (`meli_procesar_orden`,
--  `meli_acreditar_orden`, `meli_revertir_orden`), que escribe Ventas+Cueva
--  porque toca ventas y cajas.
--
--  Dejar las mías habría abierto un SEGUNDO camino para marcar `acreditado`,
--  que es exactamente cómo se desincronizan dos implementaciones de lo mismo.
--
--  Lo que queda son las piezas de stock, que esas RPC van a llamar adentro de
--  su transacción. No se otorgan a `authenticated`: la única puerta es la RPC
--  de ellos. Si necesitan llamarlas directo desde el navegador, es agregar el
--  GRANT, pero conviene que no.
-- ════════════════════════════════════════════════════════════════════════════

-- 8.1 Reponer stock de una orden cancelada que ya se había descontado.
-- Suma la cantidad, devuelve a 'disponible' lo que había quedado 'vendido' y
-- deja movimiento `meli_reverso`. Reclama la bandera al revés (true→false) para
-- que dos llamadas no repongan dos veces.
CREATE OR REPLACE FUNCTION public.meli_reponer_stock(p_orden_id BIGINT)
RETURNS TABLE (stock_id UUID, repuesto INTEGER, queda INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r RECORD; v_queda INTEGER; v_rep INTEGER; v_ref TEXT;
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado'; END IF;

  -- Mismo bloqueo que el descuento, antes de tocar ítems.
  PERFORM 1 FROM meli_ordenes WHERE id = p_orden_id FOR UPDATE;

  UPDATE meli_ordenes SET stock_descontado = FALSE, actualizado_en = NOW()
   WHERE id = p_orden_id AND stock_descontado = TRUE
  RETURNING meli_order_id INTO v_ref;
  IF NOT FOUND THEN RETURN; END IF;

  -- Mismo orden que meli__descontar_core (por stock_id), para que descontar y reponer
  -- nunca tomen las filas de stock en orden inverso entre sí.
  FOR r IN SELECT i.id AS iid, i.stock_id AS sid, i.cantidad AS cant, i.meli_item_id AS item,
                  i.descontado_cantidad AS desc_c
             FROM meli_orden_items i
            WHERE i.orden_id = p_orden_id AND i.stock_id IS NOT NULL
            ORDER BY i.stock_id, i.meli_item_id
  LOOP
    -- Se devuelve lo que el descuento sacó DE VERDAD (descontado_cantidad), no lo que
    -- diga hoy la bandera a_pedido de la fila. 0 = el descuento no tocó nada (era a pedido):
    -- no se suma nada y el estado queda como está, pero el movimiento igual se registra.
    -- NULL (ítem descontado antes de existir esa columna) = se devuelve toda la cantidad.
    v_rep := COALESCE(r.desc_c, r.cant);

    UPDATE stock s
       SET cantidad = CASE WHEN v_rep = 0 THEN s.cantidad
                           ELSE COALESCE(s.cantidad,0) + v_rep END,
           estado_inventario = CASE WHEN v_rep = 0 THEN s.estado_inventario
                                    WHEN s.estado_inventario = 'vendido' THEN 'disponible'
                                    ELSE s.estado_inventario END
     WHERE s.id = r.sid
    RETURNING s.cantidad INTO v_queda;

    INSERT INTO stock_movimientos
      (stock_id, tipo, detalle, cantidad_antes, cantidad_despues, usuario_nombre, datos)
    VALUES (r.sid, 'meli_reverso',
      'Reposición por cancelación en Mercado Libre (orden ' || COALESCE(v_ref,'?') || ')',
      COALESCE(v_queda, 0) - v_rep,
      COALESCE(v_queda, 0), 'Mercado Libre',
      jsonb_build_object('meli_order_id', v_ref, 'meli_item_id', r.item, 'cantidad', r.cant,
                         'repuesto', v_rep));

    -- Ya se devolvió: el ítem vuelve a "no descontado".
    UPDATE meli_orden_items SET descontado_cantidad = NULL WHERE id = r.iid;

    stock_id := r.sid; repuesto := v_rep;
    queda := COALESCE(v_queda, 0);
    RETURN NEXT;
  END LOOP;
END; $$;


-- Las RPC las llama el servidor con la anon key + el secreto. Sin el secreto
-- cualquier llamada muere en la primera línea.
GRANT EXECUTE ON FUNCTION
  public.meli_tokens_tomar(TEXT, BIGINT, INT),
  public.meli_tokens_guardar(TEXT, BIGINT, TEXT, TEXT, INT),
  public.meli_marcar_reconexion(TEXT, BIGINT, TEXT),
  public.meli_notificacion_registrar(TEXT, TEXT, TEXT, TEXT, JSONB),
  public.meli_orden_registrar(TEXT, BIGINT, JSONB),
  public.meli_orden_items_set(TEXT, BIGINT, JSONB),
  public.meli_descontar_stock(TEXT, BIGINT)
TO anon, authenticated;

-- Piezas internas: NO se otorgan. Las llaman las RPC de Ventas+Cueva desde
-- adentro de su transacción, que corren como SECURITY DEFINER y por lo tanto
-- tienen permiso. Así hay una sola puerta a cada operación.
-- (el REVOKE efectivo, de PUBLIC, está más abajo)



-- OJO — ESTO ES LO QUE DE VERDAD CIERRA LAS FUNCIONES INTERNAS.
-- Postgres otorga EXECUTE a PUBLIC por defecto al crear una función, y
-- `anon`/`authenticated` heredan de PUBLIC. Revocar sólo de ellos NO hace nada:
-- el permiso sigue viniendo por PUBLIC. Hay que revocar de PUBLIC.
-- Sin esto, `meli__descontar_core` —que no valida ni secreto ni sesión— quedaba
-- llamable por cualquiera vía PostgREST.
REVOKE EXECUTE ON FUNCTION public.meli_secreto_ok(TEXT)        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.meli__descontar_core(BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.meli_descontar_stock_crm(BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.meli_reponer_stock(BIGINT)   FROM PUBLIC, anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════════
--  CHEQUEO FINAL — las tres cosas que no pueden fallar
-- ════════════════════════════════════════════════════════════════════════════
-- 1) Los tokens NO se leen desde el cliente. Con la anon key, esto tiene que
--    devolver 0 filas o error de permisos:
--      SELECT count(*) FROM meli_cuentas;
--
-- 2) La vista de estado SÍ se lee, y no trae tokens:
--      SELECT * FROM meli_cuentas_estado;
--
-- 3) Las RPC rechazan sin secreto:
--      SELECT * FROM meli_tokens_tomar('cualquiera', 1);   -- debe dar "no autorizado"

-- ════════════════════════════════════════════════════════════════════════════
--  ⚠ PENDIENTE CRÍTICO — las ventas del local pueden pisar un descuento de MELI
-- ════════════════════════════════════════════════════════════════════════════
-- Este archivo decía antes que "el guardado del navegador no pisa el descuento
-- porque es una sentencia atómica". ERA FALSO, y la revisión de código lo mostró.
--
-- Lo que pasa hoy: el CRM carga el stock al abrir y lo guarda en memoria. Una venta
-- local descuenta SU copia (State.descontarStock) y escribe la cantidad ABSOLUTA
-- (DB.actualizarCantidadStock → update({ cantidad })). Ejemplo: el navegador cargó 5
-- unidades; Mercado Libre descuenta y deja 4; una venta local descuenta su copia de
-- 5 a 4 y escribe 4. Dos ventas, una sola unidad descontada.
--
-- Esto NO lo introduce la integración: dos usuarios con el CRM abierto ya se pisan
-- así hoy. Lo que hace es sumar un tercer actor (el webhook) que escribe sin que
-- ningún navegador se entere.
--
-- OJO: el modo manual (botón "Procesar") REDUCE la frecuencia pero NO es una
-- garantía. Recargar antes de apretar no alcanza: otra pestaña, u otro usuario,
-- puede tener el stock viejo en memoria y escribirlo después del descuento. Es un
-- bloqueo pendiente de Stock/Ventas, y no hay que usar el modo manual como excusa
-- para dejarlo para después. Con el procesamiento automático es inaceptable.
--
-- Solución de fondo, que es de Stock/Ventas y no de este archivo: que el cliente
-- descuente y reponga POR DELTA en la base (`cantidad = cantidad - 1 WHERE
-- cantidad >= 1`, con el movimiento y el cambio de estado en la misma sentencia),
-- igual que hace meli_descontar_stock. Sin eso, ninguna RPC de este archivo puede
-- cerrar el hueco.


-- ============================================================================
-- ============================================================================
--  PARTE 2 — ampliaciones del plan aprobado por Codex (ronda 5, 2026-10-02)
--
--  Va en el mismo archivo y corre a continuación: son las piezas que el plan de
--  OAuth, cola y worker necesita y que la parte 1 no tenía.
-- ============================================================================
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
--  9. COLUMNAS NUEVAS
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.meli_cuentas
  -- Invalida operaciones anteriores. Sube con cada reconexión.
  ADD COLUMN IF NOT EXISTS generacion INTEGER NOT NULL DEFAULT 1,
  -- Lease vigente de refresco. Sin esto, una instancia atrasada pisa a la que
  -- tomó el relevo.
  ADD COLUMN IF NOT EXISTS refresh_lease_id UUID,
  -- Qué lease logró persistir el último refresco. Es lo ÚNICO que distingue
  -- "ya se guardó" de "nunca se guardó" cuando se pierde la respuesta.
  ADD COLUMN IF NOT EXISTS ultimo_refresh_guardado_id UUID,
  -- Timeout o error de red en el intercambio: no sabemos si MELI rotó el token.
  -- Mientras esté en true NO se refresca automáticamente, ni aunque venza el
  -- lease: reintentar sobre un refresh posiblemente consumido lo quema.
  ADD COLUMN IF NOT EXISTS refresh_ambiguo BOOLEAN NOT NULL DEFAULT FALSE,
  -- Se pone ANTES de llamar a Mercado Libre y se levanta cuando el intercambio
  -- termina de forma conocida (guardado, rechazo definitivo, ambiguo declarado o
  -- respuesta transitoria). Si el lease vence con esto todavía puesto, la
  -- instancia murió a mitad del intercambio y no sabemos si Mercado Libre rotó el
  -- token: se bloquea, no se reintenta.
  ADD COLUMN IF NOT EXISTS refresh_iniciado_lease UUID;

ALTER TABLE public.meli_notificaciones
  ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'pendiente',
    -- pendiente | procesada | descartada | fallida
  ADD COLUMN IF NOT EXISTS intentos INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS proximo_intento TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS lease_id UUID,
  ADD COLUMN IF NOT EXISTS lease_hasta TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS motivo TEXT;

DROP INDEX IF EXISTS public.meli_notificaciones_pendientes;
CREATE INDEX IF NOT EXISTS meli_notificaciones_cola
  ON public.meli_notificaciones (proximo_intento)
  WHERE estado = 'pendiente';

ALTER TABLE public.meli_ordenes
  -- Versiones SEPARADAS. `order.last_updated` no protege lo financiero: un pago
  -- puede cambiar sin que la orden cambie de timestamp.
  ADD COLUMN IF NOT EXISTS meli_last_updated TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pagos_version     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS envio_version     TIMESTAMPTZ,
  -- Mientras sea false, los importes pueden estar incompletos: la acreditación
  -- queda bloqueada, acá y en la UI.
  ADD COLUMN IF NOT EXISTS financiera_completa BOOLEAN NOT NULL DEFAULT FALSE,
  -- bruto − neto − comisiones declaradas por Mercado Pago. Es la parte de lo
  -- retenido que NO se pudo explicar con fee_details (suele ser el costo de envío).
  -- Va en columna y no sólo en el payload para que se pueda ver y filtrar.
  ADD COLUMN IF NOT EXISTS diferencia_comision NUMERIC(18,2),
  -- Suma de transaction_amount de los pagos APROBADOS del bloque financiero aceptado.
  -- Se guarda para validar la COBERTURA (cobrado >= bruto) contra el bruto FINAL de
  -- la fila, no contra el que trajo la última respuesta: según qué bloques se
  -- acepten, el bruto puede ser el viejo, y una cobertura calculada en JavaScript
  -- contra el bruto nuevo no valdría. NULL = no se pudo afirmar.
  ADD COLUMN IF NOT EXISTS cobrado_aprobado NUMERIC(18,2),
  -- Comisiones que Mercado Pago declara en fee_details (a cargo del vendedor). Sirve
  -- para derivar diferencia_comision en la base, de la misma fila que bruto y neto.
  ADD COLUMN IF NOT EXISTS comision_declarada NUMERIC(18,2),
  -- El último neto con el que la orden estuvo FINANCIERAMENTE COMPLETA. Es la
  -- referencia para decidir si un neto posterior es un cambio real. NO se puede usar
  -- la bandera `financiera_completa` para eso: baja a false ante un fallo transitorio
  -- de consulta (conservando los importes), y entonces el neto confirmado "se
  -- olvidaba": con neto 850 confirmado, un fallo, y después un neto 800 completo, ninguna
  -- de las dos banderas estaba en true y el cambio pasaba sin marcar.
  ADD COLUMN IF NOT EXISTS neto_confirmado NUMERIC(18,2);


-- La vista de la parte 1 no podía mostrar `refresh_ambiguo` porque esa columna
-- se crea recién acá arriba. Se vuelve a definir con la columna agregada AL FINAL
-- (CREATE OR REPLACE VIEW sólo admite columnas nuevas al final). Sin esto, una
-- cuenta bloqueada por refresco ambiguo se vería "conectada" en la pantalla.
CREATE OR REPLACE VIEW public.meli_cuentas_estado
WITH (security_invoker = false) AS
SELECT
  c.id, c.meli_user_id, c.nickname, c.persona_id, c.bolsillo, c.activa,
  c.requiere_reconexion, c.ultimo_error,
  (c.refresh_token IS NOT NULL)                       AS conectada,
  (c.token_expira_en IS NOT NULL AND c.token_expira_en > NOW()) AS token_vigente,
  c.creado_en,
  c.refresh_ambiguo
FROM public.meli_cuentas c
WHERE public.is_authorized_user();

-- ════════════════════════════════════════════════════════════════════════════
--  10. OAUTH — nonce de un solo uso
--
--  El state no se firma: es un nonce opaco guardado acá y consumido de forma
--  atómica. Una firma con timestamp demuestra que la emitimos nosotros, pero no
--  impide reusarla durante su ventana de validez.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.meli_states (
  nonce          TEXT PRIMARY KEY,
  usuario_email  TEXT NOT NULL,
  vence_en       TIMESTAMPTZ NOT NULL,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.meli_states ENABLE ROW LEVEL SECURITY;
-- Sin políticas: cerrada. Sólo se toca por RPC.

CREATE OR REPLACE FUNCTION public.meli_state_crear(
  p_secreto TEXT, p_nonce TEXT, p_usuario_email TEXT, p_minutos INT DEFAULT 10)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  DELETE FROM meli_states WHERE vence_en < NOW();   -- limpieza oportunista
  INSERT INTO meli_states (nonce, usuario_email, vence_en)
  VALUES (p_nonce, p_usuario_email, NOW() + (p_minutos || ' minutes')::INTERVAL);
END; $$;

-- DELETE ... RETURNING: el consumo es atómico y de un solo uso. Si dos llegan
-- juntos, uno recibe la fila y el otro nada.
CREATE OR REPLACE FUNCTION public.meli_state_consumir(p_secreto TEXT, p_nonce TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_email TEXT;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  DELETE FROM meli_states
   WHERE nonce = p_nonce AND vence_en > NOW()
  RETURNING usuario_email INTO v_email;
  RETURN v_email;   -- NULL si no existía, ya se usó o venció
END; $$;


-- ════════════════════════════════════════════════════════════════════════════
--  11. CUENTAS — conectar, asignar caja, resolver desde el webhook
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.meli_cuenta_conectar(
  p_secreto TEXT, p_user_id TEXT, p_nickname TEXT,
  p_access TEXT, p_refresh TEXT, p_expira_seg INT)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id BIGINT;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;

  INSERT INTO meli_cuentas (meli_user_id, nickname, access_token, refresh_token,
                            token_expira_en, activa)
  VALUES (p_user_id, p_nickname, p_access, p_refresh,
          NOW() + (p_expira_seg || ' seconds')::INTERVAL, TRUE)
  ON CONFLICT (meli_user_id) DO UPDATE SET
    nickname        = COALESCE(EXCLUDED.nickname, meli_cuentas.nickname),
    access_token    = EXCLUDED.access_token,
    refresh_token   = EXCLUDED.refresh_token,
    token_expira_en = EXCLUDED.token_expira_en,
    activa          = TRUE,
    -- Reconectar limpia los tres estados de falla e invalida cualquier lease
    -- viejo subiendo la generación.
    requiere_reconexion = FALSE,
    refresh_ambiguo     = FALSE,
    ultimo_error        = NULL,
    refresh_lease_id    = NULL,
    -- Sin estas dos, reconectar durante un refresco abandonado dejaba la marca de
    -- "iniciado" puesta: al vencer el candado, meli_tokens_tomar declaraba AMBIGUOS
    -- los tokens recién conectados, que no tienen nada que ver con ese intento.
    refresh_iniciado_lease = NULL,
    refrescando_hasta   = NULL,
    generacion          = meli_cuentas.generacion + 1,
    actualizado_en      = NOW()
    -- persona_id y bolsillo NO se tocan: una reconexión no puede perder la
    -- caja que ya se había asignado.
  RETURNING id INTO v_id;

  RETURN v_id;
END; $$;

-- La asignación de caja es un paso APARTE, del CRM, porque recién ahí se sabe
-- de quién es la cuenta. Hasta que se asigne, la acreditación no se habilita.
CREATE OR REPLACE FUNCTION public.meli_cuenta_asignar_caja(
  p_cuenta_id BIGINT, p_persona_id UUID, p_bolsillo TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_authorized_user() THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF p_persona_id IS NULL OR COALESCE(btrim(p_bolsillo),'') = '' THEN
    RAISE EXCEPTION 'persona y bolsillo son obligatorios';
  END IF;

  INSERT INTO cajas (persona_id, bolsillo, saldo)
  VALUES (p_persona_id, p_bolsillo, 0)
  ON CONFLICT (persona_id, bolsillo) DO NOTHING;

  UPDATE meli_cuentas
     SET persona_id = p_persona_id, bolsillo = p_bolsillo, actualizado_en = NOW()
   WHERE id = p_cuenta_id;
  RETURN FOUND;
END; $$;

-- El webhook recibe user_id, las RPC piden cuenta_id. Devuelve NULL si no es
-- una cuenta nuestra o está inactiva: el aviso se descarta sin tocar nada.
CREATE OR REPLACE FUNCTION public.meli_cuenta_por_user_id(p_secreto TEXT, p_user_id TEXT)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id BIGINT;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  SELECT id INTO v_id FROM meli_cuentas
   WHERE meli_user_id = p_user_id AND activa = TRUE;
  RETURN v_id;
END; $$;

GRANT EXECUTE ON FUNCTION public.meli_cuenta_asignar_caja(BIGINT, UUID, TEXT) TO authenticated;

-- El callback de OAuth llega sin sesión (es un redirect de Mercado Libre), así
-- que no puede usar is_authorized_user(), que mira el JWT. Esta valida por email
-- que quien inició la conexión SIGA autorizado: pudo haber sido dado de baja
-- entre que apretó el botón y volvió de Mercado Libre.
CREATE OR REPLACE FUNCTION public.meli_usuario_autorizado(p_secreto TEXT, p_email TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  RETURN EXISTS (SELECT 1 FROM usuarios_autorizados
                  WHERE email = p_email AND activo = TRUE);
END; $$;
GRANT EXECUTE ON FUNCTION public.meli_usuario_autorizado(TEXT, TEXT) TO anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════════
--  12. TOKENS — versión final, con lease e identidad
--
--  Reemplazan a las de la parte 1. El problema que resuelven: el candado por
--  tiempo solo no alcanza. Una instancia atrasada podía escribir después de que
--  otra ya hubiera reconectado la cuenta, y dejarla bloqueada por un error que
--  ya no existía.
-- ════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.meli_tokens_tomar(TEXT, BIGINT, INT);
CREATE OR REPLACE FUNCTION public.meli_tokens_tomar(
  p_secreto TEXT, p_cuenta_id BIGINT, p_margen_seg INT DEFAULT 600)
RETURNS TABLE (access_token TEXT, refresh_token TEXT, token_expira_en TIMESTAMPTZ,
               activa BOOLEAN, requiere_reconexion BOOLEAN, refresh_ambiguo BOOLEAN,
               generacion INTEGER, lease_id UUID, debe_refrescar BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v RECORD; v_lease UUID;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;

  SELECT * INTO v FROM meli_cuentas WHERE id = p_cuenta_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'cuenta inexistente'; END IF;

  -- Cuenta rota: se devuelve el estado para que el llamador avise, pero NO se
  -- entrega permiso de refrescar. Insistir contra un refresh ya consumido sólo
  -- empeora las cosas.
  IF NOT v.activa OR v.requiere_reconexion OR v.refresh_ambiguo THEN
    RETURN QUERY SELECT v.access_token, v.refresh_token, v.token_expira_en,
                        v.activa, v.requiere_reconexion, v.refresh_ambiguo,
                        v.generacion, NULL::UUID, FALSE;
    RETURN;
  END IF;

  -- Un intercambio que se INICIÓ y nunca se concluyó, con el lease ya vencido:
  -- la instancia murió con Mercado Libre posiblemente ya habiendo rotado el
  -- token, y ni siquiera llegó a anotar "ambiguo". Entregarle el permiso a otra
  -- instancia la haría usar un refresh ya consumido. Se declara ambiguo acá.
  IF v.refresh_iniciado_lease IS NOT NULL
     AND (v.refrescando_hasta IS NULL OR v.refrescando_hasta < NOW())
  THEN
    UPDATE meli_cuentas
       SET refresh_ambiguo = TRUE, ultimo_error = 'refresco iniciado sin concluir',
           refresh_iniciado_lease = NULL, refrescando_hasta = NULL, refresh_lease_id = NULL,
           actualizado_en = NOW()
     WHERE id = p_cuenta_id;
    RETURN QUERY SELECT v.access_token, v.refresh_token, v.token_expira_en,
                        v.activa, v.requiere_reconexion, TRUE,
                        v.generacion, NULL::UUID, FALSE;
    RETURN;
  END IF;

  IF (v.token_expira_en IS NULL
      OR v.token_expira_en < NOW() + (p_margen_seg || ' seconds')::INTERVAL)
     AND (v.refrescando_hasta IS NULL OR v.refrescando_hasta < NOW())
  THEN
    v_lease := gen_random_uuid();
    UPDATE meli_cuentas
       SET refrescando_hasta = NOW() + INTERVAL '60 seconds', refresh_lease_id = v_lease
     WHERE id = p_cuenta_id;
    RETURN QUERY SELECT v.access_token, v.refresh_token, v.token_expira_en,
                        v.activa, v.requiere_reconexion, v.refresh_ambiguo,
                        v.generacion, v_lease, TRUE;
  ELSE
    RETURN QUERY SELECT v.access_token, v.refresh_token, v.token_expira_en,
                        v.activa, v.requiere_reconexion, v.refresh_ambiguo,
                        v.generacion, NULL::UUID, FALSE;
  END IF;
END; $$;

-- Devuelve si APLICÓ. Es lo que permite distinguir, cuando se pierde la
-- respuesta, entre "ya se había guardado" y "nunca se guardó": se reintenta y,
-- si dice false, se compara ultimo_refresh_guardado_id con el lease usado.
DROP FUNCTION IF EXISTS public.meli_tokens_guardar(TEXT, BIGINT, TEXT, TEXT, INT);
CREATE OR REPLACE FUNCTION public.meli_tokens_guardar(
  p_secreto TEXT, p_cuenta_id BIGINT, p_lease_id UUID,
  p_access TEXT, p_refresh TEXT, p_expira_seg INT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ok BOOLEAN;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;

  UPDATE meli_cuentas
     SET access_token    = p_access,
         refresh_token   = COALESCE(p_refresh, refresh_token),
         token_expira_en = NOW() + (p_expira_seg || ' seconds')::INTERVAL,
         refrescando_hasta = NULL,
         refresh_lease_id  = NULL,
         refresh_iniciado_lease = NULL,
         ultimo_refresh_guardado_id = p_lease_id,
         requiere_reconexion = FALSE,
         ultimo_error    = NULL,
         actualizado_en  = NOW()
   WHERE id = p_cuenta_id AND refresh_lease_id = p_lease_id
  RETURNING TRUE INTO v_ok;

  RETURN COALESCE(v_ok, FALSE);
END; $$;

-- ¿Fue este lease el que guardó el último refresco? Responde la pregunta
-- "¿perdí las credenciales o sólo perdí la respuesta?".
CREATE OR REPLACE FUNCTION public.meli_refresh_ya_guardado(
  p_secreto TEXT, p_cuenta_id BIGINT, p_lease_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v BOOLEAN;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  SELECT ultimo_refresh_guardado_id = p_lease_id INTO v
    FROM meli_cuentas WHERE id = p_cuenta_id;
  RETURN COALESCE(v, FALSE);
END; $$;

-- Las escrituras de ERROR también validan lease y generación. Sin eso, un
-- refresco viejo que falla tarde bloquea una cuenta que ya se reconectó bien.
DROP FUNCTION IF EXISTS public.meli_marcar_reconexion(TEXT, BIGINT, TEXT);
CREATE OR REPLACE FUNCTION public.meli_marcar_reconexion(
  p_secreto TEXT, p_cuenta_id BIGINT, p_lease_id UUID,
  p_generacion INTEGER, p_error TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ok BOOLEAN;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  UPDATE meli_cuentas
     SET requiere_reconexion = TRUE, ultimo_error = p_error,
         refrescando_hasta = NULL, refresh_lease_id = NULL, refresh_iniciado_lease = NULL,
         actualizado_en = NOW()
   WHERE id = p_cuenta_id
     AND refresh_lease_id = p_lease_id AND generacion = p_generacion
  RETURNING TRUE INTO v_ok;
  RETURN COALESCE(v_ok, FALSE);
END; $$;

CREATE OR REPLACE FUNCTION public.meli_marcar_ambiguo(
  p_secreto TEXT, p_cuenta_id BIGINT, p_lease_id UUID,
  p_generacion INTEGER, p_error TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ok BOOLEAN;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  UPDATE meli_cuentas
     SET refresh_ambiguo = TRUE, ultimo_error = p_error,
         refrescando_hasta = NULL, refresh_lease_id = NULL, refresh_iniciado_lease = NULL,
         actualizado_en = NOW()
   WHERE id = p_cuenta_id
     AND refresh_lease_id = p_lease_id AND generacion = p_generacion
  RETURNING TRUE INTO v_ok;
  RETURN COALESCE(v_ok, FALSE);
END; $$;


-- Se llama ANTES de pedirle el token nuevo a Mercado Libre. Devuelve false si el
-- lease ya no es el vigente o la generación cambió (reconexión): en ese caso NO
-- se debe hacer el intercambio.
CREATE OR REPLACE FUNCTION public.meli_refresh_iniciar(
  p_secreto TEXT, p_cuenta_id BIGINT, p_lease_id UUID, p_generacion INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ok BOOLEAN;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  UPDATE meli_cuentas SET refresh_iniciado_lease = p_lease_id, actualizado_en = NOW()
   WHERE id = p_cuenta_id AND refresh_lease_id = p_lease_id
     AND generacion = p_generacion AND NOT refresh_ambiguo
  RETURNING TRUE INTO v_ok;
  RETURN COALESCE(v_ok, FALSE);
END; $$;

-- Mercado Libre contestó con un error transitorio (5xx, 429): hubo respuesta, así
-- que el token NO se rotó. Se levanta la marca para que el próximo intento no lo
-- tome por un intercambio abandonado.
CREATE OR REPLACE FUNCTION public.meli_refresh_abortar(
  p_secreto TEXT, p_cuenta_id BIGINT, p_lease_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ok BOOLEAN;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  UPDATE meli_cuentas SET refresh_iniciado_lease = NULL, actualizado_en = NOW()
   WHERE id = p_cuenta_id AND refresh_iniciado_lease = p_lease_id
  RETURNING TRUE INTO v_ok;
  RETURN COALESCE(v_ok, FALSE);
END; $$;


-- ════════════════════════════════════════════════════════════════════════════
--  13. COLA — reclamo, resultado y devolución
-- ════════════════════════════════════════════════════════════════════════════

-- OJO: `UPDATE ... ORDER BY ... LIMIT ... FOR UPDATE SKIP LOCKED` NO es SQL
-- válido en Postgres. Va con CTE.
CREATE OR REPLACE FUNCTION public.meli_notificacion_reclamar(
  p_secreto TEXT, p_limite INT DEFAULT 2)
RETURNS TABLE (id BIGINT, lease_id UUID, meli_user_id TEXT, topico TEXT,
               recurso TEXT, intentos INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;

  -- El comando final es un SELECT sobre un CTE que hace el UPDATE. Es la forma
  -- que RETURN QUERY admite sin dudas; un UPDATE ... RETURNING pelado, en cambio,
  -- no es seguro que lo acepte y no hay dónde probarlo antes de correrlo.
  RETURN QUERY
  WITH candidatos AS (
    SELECT n.id FROM meli_notificaciones n
     WHERE n.estado = 'pendiente'
       AND (n.lease_hasta IS NULL OR n.lease_hasta < NOW())
       AND n.proximo_intento <= NOW()
     ORDER BY n.recibida_en
     LIMIT p_limite
     FOR UPDATE SKIP LOCKED),
  tomados AS (
    UPDATE meli_notificaciones n
       SET lease_id = gen_random_uuid(),
           lease_hasta = NOW() + INTERVAL '2 minutes',
           intentos = n.intentos + 1
      FROM candidatos c WHERE n.id = c.id
    RETURNING n.id, n.lease_id, n.meli_user_id, n.topico, n.recurso, n.intentos)
  SELECT t.id, t.lease_id, t.meli_user_id, t.topico, t.recurso, t.intentos
    FROM tomados t;
END; $$;

-- `ok=false` con `terminal=true` cierra el aviso para siempre (vendedor ajeno,
-- tópico desconocido, 404 definitivo): reintentarlo eternamente no lo va a
-- arreglar. Con `terminal=false` vuelve a la cola con backoff.
CREATE OR REPLACE FUNCTION public.meli_notificacion_resultado(
  p_secreto TEXT, p_id BIGINT, p_lease_id UUID,
  p_ok BOOLEAN, p_terminal BOOLEAN DEFAULT FALSE, p_motivo TEXT DEFAULT NULL,
  p_max_intentos INT DEFAULT 8)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ok BOOLEAN;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;

  UPDATE meli_notificaciones n
     SET estado = CASE
           WHEN p_ok           THEN 'procesada'
           WHEN p_terminal     THEN 'descartada'
           WHEN n.intentos >= p_max_intentos THEN 'fallida'
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

  RETURN COALESCE(v_ok, FALSE);
END; $$;

-- Devuelve leases de trabajos que NO se llegaron a empezar porque se acabó el
-- presupuesto. No cuentan como fallo ni reciben backoff: no hicieron nada mal.
CREATE OR REPLACE FUNCTION public.meli_notificacion_devolver(
  p_secreto TEXT, p_ids BIGINT[], p_lease_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n INTEGER;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  UPDATE meli_notificaciones n
     SET lease_id = NULL, lease_hasta = NULL,
         intentos = GREATEST(n.intentos - 1, 0)   -- no se le cobra el intento
    FROM unnest(p_ids, p_lease_ids) AS d(id, lease_id)
   WHERE n.id = d.id AND n.lease_id = d.lease_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END; $$;


-- ════════════════════════════════════════════════════════════════════════════
--  14. LEASES DE INGESTA — en tabla propia, sin órdenes fantasma
--
--  Antes el lease se tomaba creando la fila de la orden vacía, y eso dejaba una
--  orden sin ítems que podía aparecer como procesable, o basura si MELI devolvía
--  404 o un vendedor distinto. `meli_ordenes` no se toca hasta tener datos.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.meli_ingesta_leases (
  cuenta_id      BIGINT NOT NULL REFERENCES public.meli_cuentas(id) ON DELETE CASCADE,
  meli_order_id  TEXT   NOT NULL,
  lease_id       UUID   NOT NULL,
  lease_hasta    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (cuenta_id, meli_order_id)
);
ALTER TABLE public.meli_ingesta_leases ENABLE ROW LEVEL SECURITY;
-- Sin políticas: cerrada.

CREATE OR REPLACE FUNCTION public.meli_lease_tomar(
  p_secreto TEXT, p_cuenta_id BIGINT, p_meli_order_id TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_lease UUID;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  v_lease := gen_random_uuid();

  INSERT INTO meli_ingesta_leases (cuenta_id, meli_order_id, lease_id, lease_hasta)
  VALUES (p_cuenta_id, p_meli_order_id, v_lease, NOW() + INTERVAL '2 minutes')
  ON CONFLICT (cuenta_id, meli_order_id) DO UPDATE
     SET lease_id = v_lease, lease_hasta = NOW() + INTERVAL '2 minutes'
   WHERE meli_ingesta_leases.lease_hasta < NOW()
  RETURNING lease_id INTO v_lease;

  RETURN v_lease;   -- NULL si otra instancia lo tiene vigente
END; $$;

CREATE OR REPLACE FUNCTION public.meli_lease_soltar(
  p_secreto TEXT, p_cuenta_id BIGINT, p_meli_order_id TEXT, p_lease_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  DELETE FROM meli_ingesta_leases
   WHERE cuenta_id = p_cuenta_id AND meli_order_id = p_meli_order_id
     AND lease_id = p_lease_id;
END; $$;


GRANT EXECUTE ON FUNCTION
  public.meli_state_crear(TEXT, TEXT, TEXT, INT),
  public.meli_state_consumir(TEXT, TEXT),
  public.meli_cuenta_conectar(TEXT, TEXT, TEXT, TEXT, TEXT, INT),
  public.meli_cuenta_por_user_id(TEXT, TEXT),
  public.meli_tokens_tomar(TEXT, BIGINT, INT),
  public.meli_tokens_guardar(TEXT, BIGINT, UUID, TEXT, TEXT, INT),
  public.meli_refresh_ya_guardado(TEXT, BIGINT, UUID),
  public.meli_refresh_iniciar(TEXT, BIGINT, UUID, INTEGER),
  public.meli_refresh_abortar(TEXT, BIGINT, UUID),
  public.meli_marcar_reconexion(TEXT, BIGINT, UUID, INTEGER, TEXT),
  public.meli_marcar_ambiguo(TEXT, BIGINT, UUID, INTEGER, TEXT),
  public.meli_notificacion_reclamar(TEXT, INT),
  public.meli_notificacion_resultado(TEXT, BIGINT, UUID, BOOLEAN, BOOLEAN, TEXT, INT),
  public.meli_notificacion_devolver(TEXT, BIGINT[], UUID[]),
  public.meli_lease_tomar(TEXT, BIGINT, TEXT),
  public.meli_lease_soltar(TEXT, BIGINT, TEXT, UUID)
TO anon, authenticated;


-- Acumula un motivo de revisión sin perder los anteriores. Antes se usaba
-- COALESCE(motivo_viejo, motivo_nuevo), que CONSERVA siempre el viejo: una
-- cancelación posterior al procesamiento podía quedar escondida detrás de un
-- "ítems sin publicación vinculada" menor, y quien mira la lista veía el motivo
-- equivocado. Con esto el motivo nuevo va primero, el viejo se conserva detrás, y si
-- el texto ya estaba no se repite.
-- Es pura (no toca tablas) y la llama meli_ingresar_orden, que corre con los
-- permisos del dueño: por eso no hace falta darle EXECUTE a nadie.
CREATE OR REPLACE FUNCTION public.meli_agregar_motivo(p_viejo TEXT, p_nuevo TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_nuevo IS NULL OR p_nuevo = ''           THEN p_viejo
    WHEN p_viejo IS NULL OR p_viejo = ''           THEN p_nuevo
    WHEN position(p_nuevo IN p_viejo) > 0          THEN p_viejo
    ELSE p_nuevo || ' · ' || p_viejo
  END
$$;
REVOKE EXECUTE ON FUNCTION public.meli_agregar_motivo(TEXT, TEXT) FROM PUBLIC, anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════════
--  15. INGESTA TRANSACCIONAL DE ORDEN + ÍTEMS
--
--  UNA sola transacción. Antes eran dos llamadas (orden, después ítems) y si la
--  segunda fallaba quedaba una orden visible sin ítems.
--
--  Orden de bloqueos, que importa: primero la fila de `meli_ingesta_leases`
--  (FOR UPDATE, y se mantiene hasta el final), después la de la orden. Es el
--  mismo orden en que lo hacen el descuento y la reversión, así que no hay
--  forma de que dos de ellos se esperen mutuamente.
--
--  `p_orden` es un JSONB con:
--     meli_order_id, estado, estado_envio, comprador, fecha_orden, moneda, bruto,
--     meli_last_updated, pagos_version, envio_version,
--     financiera_ok   (true = se consultó bien; false = falló alguna consulta)
--     neto, comision_envio, pago_id, fecha_liberacion, revisar, motivo_revisar,
--     payload_orden, payload_pago
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.meli_ingresar_orden(
  p_secreto TEXT, p_cuenta_id BIGINT, p_lease_id UUID,
  p_orden JSONB, p_items JSONB)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_order_ref  TEXT := p_orden->>'meli_order_id';
  v_fin_ok     BOOLEAN := COALESCE((p_orden->>'financiera_ok')::BOOLEAN, FALSE);
  v_lu         TIMESTAMPTZ := (p_orden->>'meli_last_updated')::TIMESTAMPTZ;
  v_pv         TIMESTAMPTZ := (p_orden->>'pagos_version')::TIMESTAMPTZ;
  v_ev         TIMESTAMPTZ := (p_orden->>'envio_version')::TIMESTAMPTZ;
  v_ex         meli_ordenes%ROWTYPE;
  v_existe     BOOLEAN;
  v_aplica_orden BOOLEAN;
  v_aplica_fin   BOOLEAN;
  v_aplica_env   BOOLEAN;
  v_id         BIGINT;
  v_cerrada    BOOLEAN;
  -- Valores que ENTRAN, para decidir los motivos de revisión antes de escribir.
  v_bruto_in   NUMERIC := (p_orden->>'bruto')::NUMERIC;
  v_neto_in    NUMERIC := CASE WHEN v_fin_ok THEN (p_orden->>'neto')::NUMERIC END;
  v_motivo     TEXT;
  v_dbruto     BOOLEAN := FALSE;
  v_dneto      BOOLEAN := FALSE;
  v_txt        TEXT;
BEGIN
  IF NOT meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF v_order_ref IS NULL OR v_order_ref = '' THEN RAISE EXCEPTION 'orden sin id'; END IF;

  -- 1) El lease: se bloquea y se mantiene hasta el final. Verificar sin
  --    bloquear dejaba una ventana para que otro worker lo reclamara entre la
  --    validación y la escritura.
  PERFORM 1 FROM meli_ingesta_leases
   WHERE cuenta_id = p_cuenta_id AND meli_order_id = v_order_ref
     AND lease_id = p_lease_id AND lease_hasta > NOW()
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;     -- lease perdido: el aviso queda pendiente

  -- 2) Estado actual, CON BLOQUEO. Una orden de OTRA cuenta no se toca.
  --    Antes esto se leía sin bloquear, con el argumento de que el lease impide que
  --    otra ingesta la modifique. Es cierto, pero el lease sólo serializa ingestas
  --    ENTRE SÍ: no frena a alguien que procesa o acredita la orden desde el CRM. Con
  --    la lectura sin bloqueo, la secuencia "esta ingesta lee procesada=false → otro
  --    la procesa → esta ingesta acepta una cancelación" dejaba procesada=true con
  --    revisar=false, porque los motivos se decidieron con el estado anterior.
  --    Orden de bloqueos: lease primero, fila de la orden después; es el mismo orden
  --    en que lo hacen el descuento y la reversión, así que no hay ciclo posible.
  --    (Una orden NUEVA no tiene fila que bloquear; ahí el UPSERT resuelve la carrera.)
  SELECT * INTO v_ex FROM meli_ordenes WHERE meli_order_id = v_order_ref FOR UPDATE;
  v_existe := FOUND;
  IF v_existe AND v_ex.cuenta_id <> p_cuenta_id THEN
    RAISE EXCEPTION 'la orden % pertenece a otra cuenta', v_order_ref;
  END IF;

  -- 3) Qué bloques se ACEPTAN, decidido antes de escribir nada. Cada bloque tiene
  --    SU versión: un pago puede cambiar sin que la orden cambie de timestamp, y
  --    un envío viejo no puede pisar a uno nuevo. Timestamps IGUALES se aceptan:
  --    rechazarlos impediría completar una orden que entró incompleta.
  -- Regla: si YA hay una versión conocida guardada, la entrante tiene que ser
  -- CONOCIDA y mayor o igual. Antes un timestamp desconocido (`v_x IS NULL`) se
  -- aceptaba siempre, y un envío sin fecha podía reemplazar "delivered" por
  -- "shipped" dejando registrada la versión nueva. Un dato que no se puede
  -- ordenar contra lo guardado se RECHAZA (queda lo que había) en vez de adivinar.
  -- Si lo guardado no tiene versión, se acepta: no hay nada contra qué compararlo.
  v_aplica_orden := NOT v_existe OR v_ex.meli_last_updated IS NULL
                    OR (v_lu IS NOT NULL AND v_lu >= v_ex.meli_last_updated);
  v_aplica_fin   := v_fin_ok AND (NOT v_existe OR v_ex.pagos_version IS NULL
                    OR (v_pv IS NOT NULL AND v_pv >= v_ex.pagos_version));
  v_aplica_env   := (p_orden->>'estado_envio') IS NOT NULL
                    AND (NOT v_existe OR v_ex.envio_version IS NULL
                         OR (v_ev IS NOT NULL AND v_ev >= v_ex.envio_version));

  -- MOTIVOS DE REVISIÓN de ESTA ingesta, decididos acá y no dentro del UPSERT. Se
  -- acumulan con meli_agregar_motivo (el nuevo va primero, el viejo se conserva), así
  -- que se agregan de MENOR a MAYOR gravedad: lo último que se agrega queda primero en
  -- el texto. Sólo aplican a una orden que YA existía; el alta toma `revisar` del
  -- payload, que arma el servidor (incluye la moneda).
  IF v_existe THEN
    -- Devolución, contracargo o mediación, y sólo si ese bloque financiero se aceptó.
    IF v_aplica_fin AND COALESCE((p_orden->>'revisar')::BOOLEAN, FALSE) THEN
      v_motivo := meli_agregar_motivo(v_motivo, p_orden->>'motivo_revisar');
    END IF;

    -- Moneda distinta de ARS: la caja y las comisiones asumen pesos.
    IF v_aplica_orden AND upper(COALESCE(p_orden->>'moneda','ARS')) <> 'ARS' THEN
      v_motivo := meli_agregar_motivo(v_motivo,
        'La orden está en ' || (p_orden->>'moneda') || ', no en ARS: la caja y las comisiones asumen pesos');
    END IF;

    -- Importes que cambian en una orden YA procesada o acreditada (pedido de
    -- Ventas+Cueva): la venta ya se armó con los números viejos y reescribirlos en
    -- silencio la dejaría inconsistente. Reglas para no bloquear el flujo normal:
    --  · sólo cuenta si el valor viejo ERA CONOCIDO: una orden se procesa antes de que
    --    Mercado Pago confirme el pago (neto NULL), y marcarla cuando llega el neto
    --    bloquearía para siempre la acreditación, que exige revisar = false;
    --  · el neto sólo cuenta como CAMBIO si el viejo era CONFIRMADO (financiera_completa
    --    o ya acreditada). Uno provisional —un pago aprobado de dos— que se completa
    --    cuando entra el segundo es una evolución normal, no una anomalía;
    --  · sólo se considera un bloque si se ACEPTÓ: uno rechazado por versión vieja no
    --    cambia nada, y no se lo describe como si hubiera cambiado.
    IF v_ex.procesada OR v_ex.acreditado THEN
      v_dbruto := v_aplica_orden AND v_ex.bruto IS NOT NULL
                  AND v_bruto_in IS DISTINCT FROM v_ex.bruto;
      v_dneto  := v_aplica_fin AND v_ex.neto_confirmado IS NOT NULL
                  AND v_neto_in IS DISTINCT FROM v_ex.neto_confirmado;
      IF v_dbruto OR v_dneto THEN
        v_txt := '';
        IF v_dbruto THEN
          v_txt := 'bruto ' || v_ex.bruto::text || ' → ' || COALESCE(v_bruto_in::text, '—');
        END IF;
        IF v_dneto THEN
          v_txt := v_txt || CASE WHEN v_txt <> '' THEN ', ' ELSE '' END
                   || 'neto ' || v_ex.neto_confirmado::text || ' → ' || COALESCE(v_neto_in::text, '—');
        END IF;
        v_motivo := meli_agregar_motivo(v_motivo,
          'Los importes cambiaron DESPUÉS de procesarse o acreditarse (' || v_txt
          || '): revisar la venta y la caja');
      END IF;
    END IF;

    -- Lo más grave, último: una orden ya procesada que pasa a cancelada o devuelta.
    -- Hay plata y stock que ya se movieron y no se puede deshacer solo.
    IF v_aplica_orden AND v_ex.procesada
       AND lower(COALESCE(p_orden->>'estado','')) IN ('cancelled','refunded','invalid') THEN
      v_motivo := meli_agregar_motivo(v_motivo,
        'La orden pasó a "' || (p_orden->>'estado') || '" DESPUÉS de procesarse: revisar stock y caja');
    END IF;
  END IF;

  INSERT INTO meli_ordenes (
    cuenta_id, meli_order_id, estado, estado_envio, comprador, fecha_orden,
    moneda, bruto, meli_last_updated, pagos_version, envio_version,
    neto, comision_envio, pago_id, fecha_liberacion, diferencia_comision,
    cobrado_aprobado, comision_declarada,
    financiera_completa, revisar, motivo_revisar, payload_orden, payload_pago)
  VALUES (
    p_cuenta_id, v_order_ref, p_orden->>'estado', p_orden->>'estado_envio',
    p_orden->>'comprador', (p_orden->>'fecha_orden')::TIMESTAMPTZ,
    COALESCE(p_orden->>'moneda','ARS'), (p_orden->>'bruto')::NUMERIC,
    v_lu, CASE WHEN v_fin_ok THEN v_pv END, v_ev,
    CASE WHEN v_fin_ok THEN (p_orden->>'neto')::NUMERIC END,
    CASE WHEN v_fin_ok THEN (p_orden->>'comision_envio')::NUMERIC END,
    CASE WHEN v_fin_ok THEN p_orden->>'pago_id' END,
    CASE WHEN v_fin_ok THEN (p_orden->>'fecha_liberacion')::TIMESTAMPTZ END,
    CASE WHEN v_fin_ok THEN (p_orden->>'diferencia_comision')::NUMERIC END,
    CASE WHEN v_fin_ok THEN (p_orden->>'cobrado_aprobado')::NUMERIC END,
    CASE WHEN v_fin_ok THEN (p_orden->>'comision_declarada')::NUMERIC END,
    v_fin_ok AND COALESCE((p_orden->>'financiera_completa')::BOOLEAN, FALSE),
    COALESCE((p_orden->>'revisar')::BOOLEAN, FALSE), p_orden->>'motivo_revisar',
    p_orden->'payload_orden', CASE WHEN v_fin_ok THEN p_orden->'payload_pago' END)
  ON CONFLICT (meli_order_id) DO UPDATE SET
    -- Bloque ORDEN. Si llega una versión vieja, no se toca NADA de este bloque.
    estado        = CASE WHEN v_aplica_orden THEN EXCLUDED.estado ELSE meli_ordenes.estado END,
    bruto         = CASE WHEN v_aplica_orden THEN EXCLUDED.bruto ELSE meli_ordenes.bruto END,
    moneda        = CASE WHEN v_aplica_orden THEN COALESCE(EXCLUDED.moneda, meli_ordenes.moneda) ELSE meli_ordenes.moneda END,
    comprador     = CASE WHEN v_aplica_orden THEN COALESCE(EXCLUDED.comprador, meli_ordenes.comprador) ELSE meli_ordenes.comprador END,
    fecha_orden   = CASE WHEN v_aplica_orden THEN COALESCE(EXCLUDED.fecha_orden, meli_ordenes.fecha_orden) ELSE meli_ordenes.fecha_orden END,
    payload_orden = CASE WHEN v_aplica_orden THEN EXCLUDED.payload_orden ELSE meli_ordenes.payload_orden END,
    meli_last_updated = CASE WHEN v_aplica_orden
                             THEN COALESCE(EXCLUDED.meli_last_updated, meli_ordenes.meli_last_updated)
                             ELSE meli_ordenes.meli_last_updated END,

    -- Bloque ENVÍO: el estado y su versión se actualizan JUNTOS y condicionados a
    -- la versión del envío. Antes el estado dependía de la versión de la orden
    -- mientras que la versión del envío sólo guardaba el máximo: un envío viejo
    -- ("shipped") podía pisar a uno nuevo ("delivered") y dejar el timestamp nuevo.
    estado_envio  = CASE WHEN v_aplica_env THEN EXCLUDED.estado_envio ELSE meli_ordenes.estado_envio END,
    envio_version = CASE WHEN v_aplica_env THEN COALESCE(EXCLUDED.envio_version, meli_ordenes.envio_version)
                         ELSE meli_ordenes.envio_version END,

    -- Bloque FINANCIERO: importes, fecha, payload, bandera y versión, todos bajo
    -- la MISMA condición. Antes la bandera se aceptaba siempre: una respuesta
    -- vieja y completa podía habilitar la acreditación aunque los importes
    -- guardados fueran de una versión nueva e incompleta.
    -- Si la consulta FALLÓ (v_fin_ok=false) no se toca ningún importe; se
    -- conservan, pero `financiera_completa` baja a false. Si anduvo, se escribe
    -- tal cual vino, INCLUIDO un NULL legítimo (así se puede limpiar una fecha de
    -- liberación que pasó a ser desconocida; un COALESCE a ciegas lo impediría).
    neto             = CASE WHEN v_aplica_fin THEN EXCLUDED.neto ELSE meli_ordenes.neto END,
    comision_envio   = CASE WHEN v_aplica_fin THEN EXCLUDED.comision_envio ELSE meli_ordenes.comision_envio END,
    pago_id          = CASE WHEN v_aplica_fin THEN EXCLUDED.pago_id ELSE meli_ordenes.pago_id END,
    fecha_liberacion = CASE WHEN v_aplica_fin THEN EXCLUDED.fecha_liberacion ELSE meli_ordenes.fecha_liberacion END,
    diferencia_comision = CASE WHEN v_aplica_fin THEN EXCLUDED.diferencia_comision ELSE meli_ordenes.diferencia_comision END,
    cobrado_aprobado   = CASE WHEN v_aplica_fin THEN EXCLUDED.cobrado_aprobado ELSE meli_ordenes.cobrado_aprobado END,
    comision_declarada = CASE WHEN v_aplica_fin THEN EXCLUDED.comision_declarada ELSE meli_ordenes.comision_declarada END,
    payload_pago     = CASE WHEN v_aplica_fin THEN EXCLUDED.payload_pago ELSE meli_ordenes.payload_pago END,
    pagos_version    = CASE WHEN v_aplica_fin THEN COALESCE(EXCLUDED.pagos_version, meli_ordenes.pagos_version)
                            ELSE meli_ordenes.pagos_version END,
    financiera_completa = CASE
                            WHEN NOT v_fin_ok THEN FALSE            -- no se pudo consultar: bloquear, siempre
                            WHEN v_aplica_fin THEN EXCLUDED.financiera_completa
                            ELSE meli_ordenes.financiera_completa   -- dato viejo: no cambia lo que hay
                          END,

    -- La decisión de si marcar `revisar`, y con qué motivo, ya está tomada arriba en
    -- v_motivo (ver el bloque "MOTIVOS DE REVISIÓN"). `revisar` nunca se baja solo.
    revisar        = meli_ordenes.revisar OR v_motivo IS NOT NULL,
    motivo_revisar = meli_agregar_motivo(meli_ordenes.motivo_revisar, v_motivo),
    actualizado_en = NOW()
    -- NO se tocan stock_descontado, procesada, acreditado ni venta_id.
  RETURNING id INTO v_id;

  -- DERIVADOS, sobre la fila FINAL. La comisión y su diferencia se calculan acá, de
  -- los valores que quedaron guardados, y NO se confía en lo que calculó el servidor:
  -- según qué bloques se hayan aceptado (orden vieja con pagos nuevos, o al revés),
  -- el bruto de la fila puede no ser el que usó JavaScript para verificar la cobertura.
  -- Ejemplo: fila con bruto 1000; llega una versión VIEJA de la orden con bruto 600 y
  -- un bloque de pagos aceptable que cobró 600. JavaScript decía "completa"; la base
  -- conserva bruto 1000. Ahí NO hay comisión, y la orden NO está cobrada.
  -- Hay comisión sólo si los pagos aprobados CUBREN el bruto (cobrado >= bruto, exacto:
  -- NUMERIC no tiene error de redondeo). Si no cubren, bruto − neto mide lo que falta
  -- cobrar, no una comisión.
  UPDATE meli_ordenes
     SET comision_envio = CASE
           WHEN bruto IS NOT NULL AND neto IS NOT NULL
            AND cobrado_aprobado IS NOT NULL AND cobrado_aprobado >= bruto
           THEN round(bruto - neto, 2) END,
         diferencia_comision = CASE
           WHEN bruto IS NOT NULL AND neto IS NOT NULL
            AND cobrado_aprobado IS NOT NULL AND cobrado_aprobado >= bruto
           THEN round(bruto - neto - COALESCE(comision_declarada, 0), 2) END
   WHERE id = v_id;

  -- INVARIANTE: `financiera_completa` implica que bruto, neto, fecha de liberación y
  -- comisión existen. Como la comisión sólo existe si hay cobertura, esto también
  -- garantiza que una orden sin cobrar entero no queda completa. Se hace acá y no con
  -- un CHECK: un CHECK haría fallar la ingesta, y el aviso se reintentaría para
  -- siempre sin poder avanzar.
  UPDATE meli_ordenes
     SET financiera_completa = FALSE
   WHERE id = v_id AND financiera_completa
     AND (bruto IS NULL OR neto IS NULL OR fecha_liberacion IS NULL OR comision_envio IS NULL);

  -- El neto CONFIRMADO se actualiza sólo cuando la fila FINAL quedó completa (ya con la
  -- derivación y el invariante aplicados). Va DESPUÉS de decidir los motivos: la
  -- comparación de arriba se hizo contra el valor confirmado ANTERIOR.
  UPDATE meli_ordenes
     SET neto_confirmado = neto
   WHERE id = v_id AND financiera_completa AND neto_confirmado IS DISTINCT FROM neto;

  -- 4) Ítems. Se reemplazan SÓLO si se aceptó la versión de la orden: antes se
  --    borraban y reinsertaban aunque llegara una orden vieja, y podía quedar el
  --    estado actual combinado con cantidades o productos antiguos, que después
  --    se descuentan.
  IF p_items IS NULL OR NOT v_aplica_orden THEN RETURN v_id; END IF;

  SELECT (procesada OR stock_descontado) INTO v_cerrada FROM meli_ordenes WHERE id = v_id;

  IF v_cerrada THEN
    -- Orden ya procesada/descontada: no se reescribe el histórico. Se compara el
    -- CONTENIDO (producto, variación y cantidad), no la cantidad de filas.
    -- EXCEPT ALL y no EXCEPT: EXCEPT elimina duplicados, así que una fila
    -- (MLA1,'',1) y dos filas idénticas se veían iguales aunque la cantidad total
    -- vendida fuera distinta, y el esquema no impide filas repetidas.
    IF EXISTS (
         SELECT it->>'meli_item_id', COALESCE(it->>'meli_variacion_id',''),
                GREATEST(COALESCE((it->>'cantidad')::INT,0),0)
           FROM jsonb_array_elements(p_items) AS it
         EXCEPT ALL
         SELECT meli_item_id, COALESCE(meli_variacion_id,''), cantidad
           FROM meli_orden_items WHERE orden_id = v_id)
       OR EXISTS (
         SELECT meli_item_id, COALESCE(meli_variacion_id,''), cantidad
           FROM meli_orden_items WHERE orden_id = v_id
         EXCEPT ALL
         SELECT it->>'meli_item_id', COALESCE(it->>'meli_variacion_id',''),
                GREATEST(COALESCE((it->>'cantidad')::INT,0),0)
           FROM jsonb_array_elements(p_items) AS it)
    THEN
      UPDATE meli_ordenes SET revisar = TRUE,
        motivo_revisar = COALESCE(motivo_revisar,
          'Mercado Libre informa ítems distintos de los ya procesados: revisar')
       WHERE id = v_id;
    END IF;
    RETURN v_id;
  END IF;

  DELETE FROM meli_orden_items WHERE orden_id = v_id;

  -- Cantidad <= 0 o ausente: el ítem se conserva pero SIN fila de stock, así
  -- nunca es descontable, y la orden se marca para revisar.
  INSERT INTO meli_orden_items
    (orden_id, meli_item_id, meli_variacion_id, titulo, cantidad, precio_unitario, stock_id)
  SELECT v_id,
         it->>'meli_item_id', it->>'meli_variacion_id', it->>'titulo',
         GREATEST(COALESCE((it->>'cantidad')::INT, 0), 0),
         (it->>'precio_unitario')::NUMERIC,
         CASE WHEN COALESCE((it->>'cantidad')::INT, 0) > 0 THEN pub.stock_id END
    FROM jsonb_array_elements(p_items) AS it
    LEFT JOIN meli_publicaciones pub
      ON pub.cuenta_id = p_cuenta_id
     AND pub.meli_item_id = it->>'meli_item_id'
     AND COALESCE(pub.meli_variacion_id,'') = COALESCE(it->>'meli_variacion_id','');

  UPDATE meli_ordenes SET revisar = TRUE,
    motivo_revisar = COALESCE(motivo_revisar,
      CASE WHEN EXISTS (SELECT 1 FROM meli_orden_items WHERE orden_id = v_id AND cantidad <= 0)
           THEN 'Hay ítems con cantidad inválida'
           ELSE 'Hay ítems sin publicación vinculada' END)
   WHERE id = v_id
     AND EXISTS (SELECT 1 FROM meli_orden_items
                  WHERE orden_id = v_id AND (stock_id IS NULL OR cantidad <= 0));

  RETURN v_id;
END; $$;

GRANT EXECUTE ON FUNCTION public.meli_ingresar_orden(TEXT, BIGINT, UUID, JSONB, JSONB) TO anon, authenticated;

-- Las dos viejas pasan a ser internas: la ÚNICA entrada es meli_ingresar_orden.
-- Dejarlas abiertas sería un segundo camino que se saltea las versiones, el
-- lease y la verificación de cuenta.
REVOKE EXECUTE ON FUNCTION public.meli_orden_registrar(TEXT, BIGINT, JSONB)   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.meli_orden_items_set(TEXT, BIGINT, JSONB)   FROM PUBLIC, anon, authenticated;

COMMIT;
