-- ============================================================================
--  VINCULAR PUBLICACIONES DE MERCADO LIBRE CON EL STOCK  (script 7)
--
--  PENDIENTE DE CORRER. Plan aprobado por Codex en 4 rondas: docs/meli-vincular-plan.md.
--  Orden: DESPUÉS de meli_esquema_base.sql (3) y de stock_a_pedido.sql (2). Idempotente.
--
--  QUÉ HACE
--    · meli_publicaciones pasa a SOLO LECTURA para el navegador (antes: política FOR ALL).
--      Los vínculos los escribe el servidor con dos RPC protegidas por el secreto compartido:
--      meli_publicacion_vincular y meli_publicacion_desvincular (con versión y historial).
--    · meli__revalidar_orden(orden): aplica el vínculo VIGENTE a una orden que todavía no se
--      procesó. La llama meli_procesar_orden (Ventas+Cueva) y la pantalla, orden por orden,
--      vía meli_orden_revalidar.
--    · meli__descontar_core: el chequeo de faltante suma por producto (copia EXACTA de la de
--      meli_esquema_base.sql; un test verifica que no se separen).
--
--  PROTOCOLO DE BLOQUEOS (el único): lease → orden → vínculo → stock
--    · Procesar (revalida y descuenta): orden → vínculo (FOR SHARE, hasta el final) → stock.
--    · Vincular/desvincular: vínculo (FOR UPDATE) → stock (FOR SHARE). NUNCA toma una orden.
--      No usa ON CONFLICT: el trigger BEFORE INSERT toma el stock antes de bloquear la fila
--      del vínculo, y eso invertiría el orden. Se hace SELECT … FOR UPDATE, después el stock,
--      y recién entonces UPDATE (si existe) o INSERT (si no existe).
--    · Reponer/revertir: orden → stock; no tocan vínculos (el histórico no se reescribe).
--    Como Procesar mantiene FOR SHARE sobre los vínculos que leyó hasta que termina, cambiar o
--    desvincular ese aviso ESPERA al descuento: se descuenta exactamente el vínculo leído.
--
--  SEMÁNTICA: el vínculo vigente manda sobre las órdenes NO procesadas ni descontadas.
--    Desvincular deja las órdenes abiertas de ese aviso "sin vincular" (revisar). Las procesadas
--    o descontadas no se tocan nunca.
--
--  ⚠ ORDEN Y REPETICIÓN: si la base ya corrió meli_ventas_migration.sql (4), correr SÓLO este archivo NO actualiza
--    meli_procesar_orden: hay que volver a correr el 4 actualizado (trae la línea que llama a meli__revalidar_orden).
--    Hasta entonces Procesar sigue funcionando como antes (sin revalidar), y la pantalla de vincular también.
--
--  ERRORES (excepciones con nombre): no autorizado · CUENTA_INEXISTENTE · ITEM_INVALIDO ·
--    VARIACION_INVALIDA · STOCK_INEXISTENTE · A_PEDIDO_NO_SE_VINCULA · STOCK_CON_IMEI ·
--    VINCULO_CAMBIO_CONCURRENTE · VINCULO_INEXISTENTE · ORDEN_INEXISTENTE
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF to_regclass('public.meli_publicaciones') IS NULL OR to_regclass('public.meli_ordenes') IS NULL
     OR to_regclass('public.meli_orden_items') IS NULL THEN
    RAISE EXCEPTION 'Falta meli_esquema_base.sql: correrlo ANTES de este archivo';
  END IF;
  IF to_regprocedure('public.meli_secreto_ok(text)') IS NULL
     OR to_regprocedure('public.meli_agregar_motivo(text,text)') IS NULL
     OR to_regprocedure('public.meli__descontar_core(bigint)') IS NULL THEN
    RAISE EXCEPTION 'meli_esquema_base.sql está incompleto o desactualizado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'stock' AND column_name = 'a_pedido') THEN
    RAISE EXCEPTION 'Falta stock.a_pedido: correr stock_a_pedido.sql ANTES de este archivo';
  END IF;
END $$;


-- ─── 1 · Columnas, historial y permisos ─────────────────────────────────────
ALTER TABLE public.meli_publicaciones
  ADD COLUMN IF NOT EXISTS version       INTEGER NOT NULL DEFAULT 1,   -- sube con cada cambio: detecta ediciones concurrentes
  ADD COLUMN IF NOT EXISTS vinculado_por TEXT,                         -- sale del servidor (sesión), nunca del cuerpo de la petición
  ADD COLUMN IF NOT EXISTS vinculado_en  TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.meli_vinculos_historial (
  id               BIGSERIAL PRIMARY KEY,
  cuenta_id        BIGINT NOT NULL REFERENCES public.meli_cuentas(id) ON DELETE CASCADE,
  meli_item_id     TEXT   NOT NULL,
  meli_variacion_id TEXT,
  stock_anterior   UUID,          -- sin FK a propósito: el historial sobrevive al borrado del stock
  stock_nuevo      UUID,
  usuario          TEXT,
  en               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS meli_vinculos_historial_aviso
  ON public.meli_vinculos_historial (cuenta_id, meli_item_id, en DESC);

ALTER TABLE public.meli_vinculos_historial ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "meli_vinculos_historial_lectura" ON public.meli_vinculos_historial;
CREATE POLICY "meli_vinculos_historial_lectura" ON public.meli_vinculos_historial
  FOR SELECT USING (public.is_authorized_user());

-- meli_publicaciones: sólo lectura. Se reemplaza la política FOR ALL y se REVOCAN los privilegios
-- de escritura (también TRUNCATE y los de columna: revocar ALL sobre la tabla los quita).
DROP POLICY IF EXISTS "meli_publicaciones_all" ON public.meli_publicaciones;
DROP POLICY IF EXISTS "meli_publicaciones_lectura" ON public.meli_publicaciones;
CREATE POLICY "meli_publicaciones_lectura" ON public.meli_publicaciones
  FOR SELECT USING (public.is_authorized_user());

REVOKE ALL ON public.meli_publicaciones     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.meli_vinculos_historial FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.meli_publicaciones      TO authenticated;
GRANT SELECT ON public.meli_vinculos_historial TO authenticated;
-- La pantalla cuenta las órdenes afectadas leyendo estas dos (RLS ya las limita a usuarios autorizados):
-- el GRANT queda explícito en vez de depender de los privilegios por defecto del entorno.
GRANT SELECT ON public.meli_ordenes     TO authenticated;
GRANT SELECT ON public.meli_orden_items TO authenticated;

-- Las secuencias de estas tablas nacen con privilegios por defecto para anon y authenticated en Supabase:
-- no permiten insertar filas, pero tampoco hay motivo para dejarlas abiertas.
REVOKE ALL ON SEQUENCE public.meli_vinculos_historial_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.meli_publicaciones_id_seq      FROM PUBLIC, anon, authenticated;


-- ─── 2 · Quitar una frase de un motivo (pura) ───────────────────────────────
-- Los motivos se acumulan con meli_agregar_motivo, separados por ' · '. Quita los segmentos que
-- sean EXACTAMENTE la frase; NULL si no queda nada.
CREATE OR REPLACE FUNCTION public.meli_quitar_motivo(p_texto TEXT, p_frase TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT NULLIF(array_to_string(
           ARRAY(SELECT t.x FROM unnest(string_to_array(p_texto, ' · ')) WITH ORDINALITY AS t(x, n)
                  WHERE t.x IS DISTINCT FROM p_frase ORDER BY t.n), ' · '), '')
$$;


-- ─── 3 · Revalidar una orden (interna) ──────────────────────────────────────
-- Devuelve la fila YA ACTUALIZADA: quien la llama (meli_procesar_orden) tiene que RECARGAR su
-- variable con este retorno, si no `revisar` queda viejo y lanzaría ORDEN_EN_REVISION.
CREATE OR REPLACE FUNCTION public.meli__revalidar_orden(p_orden_id BIGINT)
RETURNS public.meli_ordenes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  o            public.meli_ordenes%ROWTYPE;
  v_sin_vinc   BOOLEAN;
  v_mala_cant  BOOLEAN;
  v_motivo     TEXT;
  c_sin  CONSTANT TEXT := 'Hay ítems sin publicación vinculada';
  c_cant CONSTANT TEXT := 'Hay ítems con cantidad inválida';
BEGIN
  -- La orden primero (si el que llama ya la tiene, esto no espera). Después se mira si sigue abierta.
  SELECT * INTO o FROM public.meli_ordenes WHERE id = p_orden_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDEN_INEXISTENTE'; END IF;
  IF o.procesada OR o.stock_descontado THEN RETURN o; END IF;   -- el histórico no se reescribe

  -- UNA sola sentencia: la lectura de los vínculos es bloqueante (FOR SHARE, hasta el final de la
  -- transacción) y de ahí salen TODOS los valores. No se vuelve a consultar meli_publicaciones: bajo
  -- READ COMMITTED una segunda consulta podría ver un vínculo recién insertado que no quedó congelado.
  -- Una clave ausente da NULL (sin vincular); cantidad <= 0 nunca recibe stock.
  WITH pub AS MATERIALIZED (
    SELECT p.meli_item_id AS item, COALESCE(p.meli_variacion_id, '') AS variacion, p.stock_id AS sid
      FROM public.meli_publicaciones p
     WHERE p.cuenta_id = o.cuenta_id
       AND EXISTS (SELECT 1 FROM public.meli_orden_items i
                    WHERE i.orden_id = o.id AND i.meli_item_id = p.meli_item_id
                      AND COALESCE(i.meli_variacion_id, '') = COALESCE(p.meli_variacion_id, ''))
     ORDER BY p.id
       FOR SHARE OF p
  )
  UPDATE public.meli_orden_items it
     SET stock_id = (SELECT CASE WHEN it.cantidad > 0 THEN pub.sid END
                       FROM pub
                      WHERE pub.item = it.meli_item_id
                        AND pub.variacion = COALESCE(it.meli_variacion_id, ''))
   WHERE it.orden_id = o.id;

  SELECT COALESCE(bool_or(i.cantidad > 0 AND i.stock_id IS NULL), FALSE),
         COALESCE(bool_or(i.cantidad IS NULL OR i.cantidad <= 0), FALSE)
    INTO v_sin_vinc, v_mala_cant
    FROM public.meli_orden_items i WHERE i.orden_id = o.id;

  -- Cada motivo se AGREGA si el problema existe y se QUITA (frase exacta) si ya no. Cualquier otro
  -- motivo se conserva intacto: la orden sigue en revisar mientras quede alguno.
  v_motivo := o.motivo_revisar;
  v_motivo := CASE WHEN v_sin_vinc  THEN public.meli_agregar_motivo(v_motivo, c_sin)
                   ELSE public.meli_quitar_motivo(v_motivo, c_sin) END;
  v_motivo := CASE WHEN v_mala_cant THEN public.meli_agregar_motivo(v_motivo, c_cant)
                   ELSE public.meli_quitar_motivo(v_motivo, c_cant) END;

  IF v_motivo IS DISTINCT FROM o.motivo_revisar THEN
    UPDATE public.meli_ordenes
       SET motivo_revisar = v_motivo, revisar = (v_motivo IS NOT NULL), actualizado_en = NOW()
     WHERE id = o.id;
  END IF;

  SELECT * INTO o FROM public.meli_ordenes WHERE id = p_orden_id;
  RETURN o;
END;
$$;


-- ─── 4 · Revalidar desde la pantalla (una orden por llamada) ────────────────
-- Sin RPC masiva: cada llamada es su propia transacción (los locks no se acumulan entre órdenes) y
-- espera como máximo 3 s por la orden.
CREATE OR REPLACE FUNCTION public.meli_orden_revalidar(p_orden_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE o public.meli_ordenes%ROWTYPE; v_sin BOOLEAN;
BEGIN
  IF NOT public.is_authorized_user() THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('lock_timeout', '3s', true);
  BEGIN
    o := public.meli__revalidar_orden(p_orden_id);
  EXCEPTION WHEN lock_not_available THEN
    RETURN jsonb_build_object('ok', false, 'ocupada', true);
  END;
  SELECT EXISTS (SELECT 1 FROM public.meli_orden_items i
                  WHERE i.orden_id = o.id AND i.cantidad > 0 AND i.stock_id IS NULL) INTO v_sin;
  RETURN jsonb_build_object('ok', true, 'revisar', o.revisar, 'motivo', o.motivo_revisar,
                            'cerrada', (o.procesada OR o.stock_descontado), 'sin_vincular', v_sin);
END;
$$;


-- ─── 5 · Vincular ───────────────────────────────────────────────────────────
-- Devuelve la versión NUEVA. p_version_esperada: NULL si el aviso no tiene fila todavía; si no, la
-- versión que vio el usuario. Si no coincide → VINCULO_CAMBIO_CONCURRENTE (la pantalla recarga).
CREATE OR REPLACE FUNCTION public.meli_publicacion_vincular(
  p_secreto TEXT, p_cuenta_id BIGINT, p_item_id TEXT, p_variacion_id TEXT, p_stock_id UUID,
  p_version_esperada INTEGER, p_titulo TEXT, p_cantidad INTEGER, p_usuario TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_var     TEXT    := NULLIF(btrim(p_variacion_id), '');
  v_titulo  TEXT    := left(NULLIF(btrim(p_titulo), ''), 300);
  v_cant    INTEGER := CASE WHEN p_cantidad BETWEEN 0 AND 1000000 THEN p_cantidad END;
  v_usuario TEXT    := left(NULLIF(btrim(p_usuario), ''), 200);
  v_pub     public.meli_publicaciones%ROWTYPE;
  v_existe  BOOLEAN;
  v_version INTEGER;
  v_ant     UUID;
  s         RECORD;
  v_constraint TEXT;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF p_item_id IS NULL OR p_item_id !~ '^ML[A-Z][0-9]{5,15}$' THEN RAISE EXCEPTION 'ITEM_INVALIDO'; END IF;
  IF v_var IS NOT NULL AND v_var !~ '^[0-9]{1,20}$' THEN RAISE EXCEPTION 'VARIACION_INVALIDA'; END IF;
  IF p_stock_id IS NULL THEN RAISE EXCEPTION 'STOCK_INEXISTENTE'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.meli_cuentas c WHERE c.id = p_cuenta_id) THEN
    RAISE EXCEPTION 'CUENTA_INEXISTENTE';
  END IF;

  -- 1) el vínculo (si existe), 2) el stock: vínculo → stock, como procesar (orden → vínculo → stock).
  SELECT * INTO v_pub FROM public.meli_publicaciones p
   WHERE p.cuenta_id = p_cuenta_id AND p.meli_item_id = p_item_id
     AND COALESCE(p.meli_variacion_id, '') = COALESCE(v_var, '')
     FOR UPDATE;
  v_existe := FOUND;

  IF v_existe THEN
    IF p_version_esperada IS DISTINCT FROM v_pub.version THEN RAISE EXCEPTION 'VINCULO_CAMBIO_CONCURRENTE'; END IF;
  ELSIF p_version_esperada IS NOT NULL THEN
    RAISE EXCEPTION 'VINCULO_CAMBIO_CONCURRENTE';
  END IF;

  SELECT st.categoria, st.imeis, st.estado_inventario, COALESCE(st.a_pedido, FALSE) AS a_pedido
    INTO s FROM public.stock st WHERE st.id = p_stock_id FOR SHARE;
  IF NOT FOUND OR s.estado_inventario = 'eliminado' THEN RAISE EXCEPTION 'STOCK_INEXISTENTE'; END IF;
  IF s.a_pedido THEN RAISE EXCEPTION 'A_PEDIDO_NO_SE_VINCULA'; END IF;
  IF lower(COALESCE(s.categoria, '')) IN ('iphone', 'android', 'mac', 'ipad')
     OR COALESCE(array_length(s.imeis, 1), 0) > 0 THEN
    RAISE EXCEPTION 'STOCK_CON_IMEI';
  END IF;

  IF v_existe THEN
    v_ant := v_pub.stock_id;
    UPDATE public.meli_publicaciones p
       SET stock_id = p_stock_id, titulo_meli = COALESCE(v_titulo, p.titulo_meli),
           cantidad_publicada = v_cant, version = p.version + 1,
           vinculado_por = v_usuario, vinculado_en = NOW(), actualizado_en = NOW()
     WHERE p.id = v_pub.id
    RETURNING p.version INTO v_version;
  ELSE
    v_ant := NULL;
    BEGIN
      INSERT INTO public.meli_publicaciones
        (cuenta_id, meli_item_id, meli_variacion_id, stock_id, titulo_meli, cantidad_publicada,
         version, vinculado_por, vinculado_en)
      VALUES (p_cuenta_id, p_item_id, v_var, p_stock_id, v_titulo, v_cant, 1, v_usuario, NOW())
      RETURNING version INTO v_version;
    EXCEPTION WHEN unique_violation THEN
      -- Dos usuarios vincularon por primera vez el mismo aviso. Sólo ESTE índice significa eso;
      -- cualquier otro 23505 se propaga. No se reintenta: con el stock ya tomado, volver a bloquear
      -- el vínculo invertiría el orden de bloqueos.
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'meli_publicaciones_unica' THEN RAISE EXCEPTION 'VINCULO_CAMBIO_CONCURRENTE'; END IF;
      RAISE;
    END;
  END IF;

  INSERT INTO public.meli_vinculos_historial (cuenta_id, meli_item_id, meli_variacion_id, stock_anterior, stock_nuevo, usuario)
  VALUES (p_cuenta_id, p_item_id, v_var, v_ant, p_stock_id, v_usuario);
  RETURN v_version;
END;
$$;


-- ─── 6 · Desvincular ────────────────────────────────────────────────────────
-- La fila se CONSERVA (stock_id = NULL, versión + 1): así la versión no se reinicia al volver a
-- vincular y siempre hay una fila que bloquear. Se permite aunque el aviso ya no exista en Mercado Libre.
-- Idempotente: si ya estaba desvinculado devuelve la versión actual sin cambios.
CREATE OR REPLACE FUNCTION public.meli_publicacion_desvincular(
  p_secreto TEXT, p_cuenta_id BIGINT, p_item_id TEXT, p_variacion_id TEXT,
  p_version_esperada INTEGER, p_usuario TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_var     TEXT := NULLIF(btrim(p_variacion_id), '');
  v_usuario TEXT := left(NULLIF(btrim(p_usuario), ''), 200);
  v_pub     public.meli_publicaciones%ROWTYPE;
  v_version INTEGER;
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  IF p_item_id IS NULL OR p_item_id !~ '^ML[A-Z][0-9]{5,15}$' THEN RAISE EXCEPTION 'ITEM_INVALIDO'; END IF;
  IF v_var IS NOT NULL AND v_var !~ '^[0-9]{1,20}$' THEN RAISE EXCEPTION 'VARIACION_INVALIDA'; END IF;

  SELECT * INTO v_pub FROM public.meli_publicaciones p
   WHERE p.cuenta_id = p_cuenta_id AND p.meli_item_id = p_item_id
     AND COALESCE(p.meli_variacion_id, '') = COALESCE(v_var, '')
     FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VINCULO_INEXISTENTE'; END IF;
  IF p_version_esperada IS DISTINCT FROM v_pub.version THEN RAISE EXCEPTION 'VINCULO_CAMBIO_CONCURRENTE'; END IF;
  IF v_pub.stock_id IS NULL THEN RETURN v_pub.version; END IF;

  UPDATE public.meli_publicaciones p
     SET stock_id = NULL, version = p.version + 1, vinculado_por = v_usuario,
         vinculado_en = NOW(), actualizado_en = NOW()
   WHERE p.id = v_pub.id
  RETURNING p.version INTO v_version;

  INSERT INTO public.meli_vinculos_historial (cuenta_id, meli_item_id, meli_variacion_id, stock_anterior, stock_nuevo, usuario)
  VALUES (p_cuenta_id, p_item_id, v_var, v_pub.stock_id, NULL, v_usuario);
  RETURN v_version;
END;
$$;


-- ─── 6b · Datos mínimos de una cuenta (para el endpoint) ────────────────────
-- El servidor necesita el id de vendedor de Mercado Libre de la cuenta para listar sus avisos y para
-- comprobar que un aviso es suyo. Sale de la base por id de cuenta, NUNCA del navegador.
CREATE OR REPLACE FUNCTION public.meli_cuenta_info(p_secreto TEXT, p_cuenta_id BIGINT)
RETURNS TABLE (meli_user_id TEXT, activa BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.meli_secreto_ok(p_secreto) THEN RAISE EXCEPTION 'no autorizado'; END IF;
  RETURN QUERY SELECT c.meli_user_id, c.activa FROM public.meli_cuentas c WHERE c.id = p_cuenta_id;
END;
$$;


-- ─── 7 · Descuento: faltante sumado por producto ────────────────────────────
-- COPIA EXACTA de meli__descontar_core en meli_esquema_base.sql (el test de sincronía lo verifica).
-- Está acá para que una base que ya corrió el script 3 reciba el arreglo.
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
  --
  -- Se SUMA por producto: dos avisos distintos de la misma orden pueden apuntar al MISMO
  -- stock, y comprobar cada ítem por separado dejaba pasar los dos aunque juntos no
  -- alcanzaran (el segundo descuento fallaba recién al ejecutarse, con una excepción en vez
  -- de un `revisar` claro). Acá se detecta antes y no se toca nada.
  SELECT string_agg(x.items, ', ') INTO v_faltante
    FROM (SELECT i.stock_id, sum(i.cantidad) AS necesita,
                 string_agg(DISTINCT i.meli_item_id, ', ') AS items
            FROM meli_orden_items i
           WHERE i.orden_id = p_orden_id AND i.stock_id IS NOT NULL
           GROUP BY i.stock_id) x
    JOIN stock s ON s.id = x.stock_id
   WHERE COALESCE(s.cantidad, 0) < x.necesita
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


-- ─── 8 · Permisos ───────────────────────────────────────────────────────────
-- Las RPC con secreto las llama el servidor con la anon key (como el resto de meli_*): anon tiene que
-- poder EJECUTARLAS, y sin el secreto correcto fallan en la primera línea, sin efectos.
-- (Postgres da EXECUTE a PUBLIC por defecto: se revoca y se otorga sólo a los dos roles de la API, para que los
-- permisos queden EXACTOS en vez de depender del valor por defecto.)
REVOKE EXECUTE ON FUNCTION public.meli_publicacion_vincular(TEXT, BIGINT, TEXT, TEXT, UUID, INTEGER, TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.meli_publicacion_desvincular(TEXT, BIGINT, TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.meli_cuenta_info(TEXT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.meli_publicacion_vincular(TEXT, BIGINT, TEXT, TEXT, UUID, INTEGER, TEXT, INTEGER, TEXT)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.meli_publicacion_desvincular(TEXT, BIGINT, TEXT, TEXT, INTEGER, TEXT)
  TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.meli_cuenta_info(TEXT, BIGINT) TO anon, authenticated;

-- La del navegador: sólo con sesión de usuario autorizado.
REVOKE EXECUTE ON FUNCTION public.meli_orden_revalidar(BIGINT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.meli_orden_revalidar(BIGINT) TO authenticated;

-- Internas: sólo las llama otra función SECURITY DEFINER (meli_procesar_orden, meli_orden_revalidar).
REVOKE EXECUTE ON FUNCTION public.meli__revalidar_orden(BIGINT)        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.meli_quitar_motivo(TEXT, TEXT)       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.meli__descontar_core(BIGINT)         FROM PUBLIC, anon, authenticated;

COMMIT;

-- ============================================================================
--  VERIFICACIÓN (después de correr; con la clave pública por REST)
--    GET  …/rest/v1/meli_publicaciones?select=*                 → []  (anon no lee)
--    POST …/rest/v1/rpc/meli_publicacion_vincular  (secreto falso) → 400 "no autorizado"
--    POST …/rest/v1/rpc/meli__revalidar_orden                    → 401/404 (cerrada)
--    POST …/rest/v1/meli_publicaciones (insert con la sesión de un usuario) → 401/403 (no escribe)
-- ============================================================================
