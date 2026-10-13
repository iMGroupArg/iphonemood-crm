-- ============================================================================
--  meli_cerrar_manual.sql  (script 12) — "YA LA CARGUÉ A MANO" y "DESCARTAR" para órdenes de Mercado Libre
--
--  PROBLEMA: una orden de Mercado Libre que ya se cargó a mano en Ventas (o que no hay que tomar en cuenta, como el
--  Armaf del 1/10) hoy no se puede cerrar sin procesarla, y "Procesar" SIEMPRE crea una venta nueva y descuenta
--  stock: se contaría DOBLE. Tampoco hay un estado "descartada" para órdenes (solo existe para avisos): la orden queda
--  para siempre en "Revisar" o "Para procesar".
--
--  QUÉ HACE: una acción que cierra la orden SIN tocar stock, ventas ni caja:
--    meli_orden_cerrar_manual(orden, motivo, venta_id?, nota?)   motivo = 'ya_cargada' | 'descartada'
--    meli_orden_reabrir_cierre(orden)                             deshace el cierre (por si fue un error)
--  Y una GUARDA en la base: una orden cerrada a mano NO se puede procesar, ni descontar, ni acreditar, ni revertir,
--  aunque alguien llegue a apretar el botón de otra pantalla o dos personas lo hagan a la vez: la base lo rechaza con
--  ORDEN_CERRADA_MANUAL y no queda nada a medias.
--
--  REGLAS
--   · Solo se cierra una orden SIN procesar, sin stock descontado, sin acreditar y sin revertir (si no: ORDEN_YA_PROCESADA).
--   · No toca stock, ventas ni cajas. `revisar` pasa a falso y el cierre queda con quién, cuándo, motivo y nota.
--   · "Ya cargada" admite enlazar la venta manual (venta_id): una venta ↔ una orden. No puede ser una venta que ya
--     creó Mercado Libre ni estar anulada.
--   · La ingesta sigue actualizando los importes de la orden cerrada (por si Mercado Libre la cancela o la devuelve),
--     pero nunca la reabre ni la procesa. Las pantallas deben mostrar "cerrada a mano" y, si Mercado Libre cambió algo
--     importante (`revisar` vuelve a verdadero), avisarlo.
--   · Orden de bloqueos: la fila de la orden primero (FOR UPDATE), después la venta (FOR SHARE): el mismo orden que
--     Procesar (orden → … → venta), así que no hay ciclo.
--
--  REQUISITOS: scripts 3, 7 y 4 corridos. Idempotente (se puede correr varias veces). No cambia ningún dato.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.meli_ordenes') IS NULL
     OR to_regprocedure('public.meli_procesar_orden(bigint,numeric)') IS NULL
     OR to_regprocedure('public.meli__revalidar_orden(bigint)') IS NULL
     OR to_regprocedure('public.meli_agregar_motivo(text,text)') IS NULL THEN
    RAISE EXCEPTION 'Faltan los scripts 3, 7 y/o 4 (meli_esquema_base, meli_vincular, meli_ventas_migration). Correrlos antes que este.';
  END IF;
END $$;

BEGIN;

-- ── 1 · Columnas ───────────────────────────────────────────────────────────
ALTER TABLE public.meli_ordenes
  ADD COLUMN IF NOT EXISTS cerrada_manual_en       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cerrada_manual_por      TEXT,
  ADD COLUMN IF NOT EXISTS cerrada_manual_motivo   TEXT,
  ADD COLUMN IF NOT EXISTS cerrada_manual_nota     TEXT,
  ADD COLUMN IF NOT EXISTS cerrada_manual_venta_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meli_ordenes_cierre_motivo_ck') THEN
    ALTER TABLE public.meli_ordenes ADD CONSTRAINT meli_ordenes_cierre_motivo_ck
      CHECK (cerrada_manual_motivo IS NULL OR cerrada_manual_motivo IN ('ya_cargada', 'descartada'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meli_ordenes_cierre_coherente_ck') THEN
    -- Todo o nada: o está cerrada (con fecha y motivo) o no tiene ningún dato de cierre.
    ALTER TABLE public.meli_ordenes ADD CONSTRAINT meli_ordenes_cierre_coherente_ck
      CHECK ((cerrada_manual_en IS NULL AND cerrada_manual_motivo IS NULL AND cerrada_manual_venta_id IS NULL)
          OR (cerrada_manual_en IS NOT NULL AND cerrada_manual_motivo IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meli_ordenes_cierre_venta_fk') THEN
    -- Si algún día se borra esa venta manual, el enlace se limpia y la orden sigue cerrada.
    ALTER TABLE public.meli_ordenes ADD CONSTRAINT meli_ordenes_cierre_venta_fk
      FOREIGN KEY (cerrada_manual_venta_id) REFERENCES public.ventas(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Una venta manual ↔ una sola orden de Mercado Libre.
CREATE UNIQUE INDEX IF NOT EXISTS meli_ordenes_cierre_venta_unica
  ON public.meli_ordenes (cerrada_manual_venta_id) WHERE cerrada_manual_venta_id IS NOT NULL;

-- ── 2 · La guarda: una orden cerrada a mano no se procesa ───────────────────
-- Corre dentro de la misma transacción que Procesar / descontar / acreditar / revertir: si alguna intenta cambiar lo que
-- toca stock, venta o caja de una orden cerrada, todo se deshace (el descuento de stock incluido).
CREATE OR REPLACE FUNCTION public.meli__orden_cerrada_guarda()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.procesada         IS DISTINCT FROM OLD.procesada
     OR NEW.stock_descontado IS DISTINCT FROM OLD.stock_descontado
     OR NEW.venta_id         IS DISTINCT FROM OLD.venta_id
     OR NEW.acreditado       IS DISTINCT FROM OLD.acreditado
     OR NEW.monto_acreditado IS DISTINCT FROM OLD.monto_acreditado
     OR NEW.revertida_en     IS DISTINCT FROM OLD.revertida_en THEN
    RAISE EXCEPTION 'ORDEN_CERRADA_MANUAL' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS meli_orden_cerrada_guarda ON public.meli_ordenes;
CREATE TRIGGER meli_orden_cerrada_guarda
  BEFORE UPDATE ON public.meli_ordenes
  FOR EACH ROW WHEN (OLD.cerrada_manual_en IS NOT NULL)
  EXECUTE FUNCTION public.meli__orden_cerrada_guarda();

-- ── 3 · Cerrar a mano ──────────────────────────────────────────────────────
--  Devuelve {ok:true, orden_id, motivo, venta_id} o {ok:true, ya_cerrada:true, motivo} si ya estaba cerrada.
CREATE OR REPLACE FUNCTION public.meli_orden_cerrar_manual(
  p_orden_id BIGINT, p_motivo TEXT, p_venta_id BIGINT DEFAULT NULL, p_nota TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o          public.meli_ordenes%ROWTYPE;
  v_usuario  TEXT;
  v_nota     TEXT := NULLIF(btrim(COALESCE(p_nota, '')), '');
BEGIN
  IF NOT public.is_authorized_user() THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501';
  END IF;
  IF p_motivo IS NULL OR p_motivo NOT IN ('ya_cargada', 'descartada') THEN RAISE EXCEPTION 'MOTIVO_INVALIDO'; END IF;
  IF v_nota IS NOT NULL AND (length(v_nota) > 200 OR v_nota ~ '[[:cntrl:]]') THEN RAISE EXCEPTION 'NOTA_INVALIDA'; END IF;
  IF p_venta_id IS NOT NULL AND p_motivo <> 'ya_cargada' THEN RAISE EXCEPTION 'VENTA_NO_APLICA'; END IF;

  SELECT * INTO o FROM public.meli_ordenes WHERE id = p_orden_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDEN_INEXISTENTE'; END IF;

  IF o.cerrada_manual_en IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'ya_cerrada', true, 'motivo', o.cerrada_manual_motivo);
  END IF;
  IF o.procesada OR o.venta_id IS NOT NULL OR o.stock_descontado OR o.acreditado OR o.revertida_en IS NOT NULL THEN
    RAISE EXCEPTION 'ORDEN_YA_PROCESADA';
  END IF;

  IF p_venta_id IS NOT NULL THEN
    PERFORM 1 FROM public.ventas WHERE id = p_venta_id AND estado IS DISTINCT FROM 'anulada' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'VENTA_INEXISTENTE'; END IF;
    IF EXISTS (SELECT 1 FROM public.ventas WHERE id = p_venta_id AND meli_orden_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM public.meli_ordenes x WHERE x.id <> o.id AND (x.venta_id = p_venta_id OR x.cerrada_manual_venta_id = p_venta_id)) THEN
      RAISE EXCEPTION 'VENTA_YA_ENLAZADA';
    END IF;
  END IF;

  v_usuario := COALESCE(
    NULLIF(auth.jwt() -> 'user_metadata' ->> 'full_name', ''),
    NULLIF(auth.jwt() ->> 'email', ''), 'Desconocido');

  UPDATE public.meli_ordenes
     SET cerrada_manual_en = now(), cerrada_manual_por = v_usuario, cerrada_manual_motivo = p_motivo,
         cerrada_manual_nota = v_nota, cerrada_manual_venta_id = p_venta_id,
         -- `motivo_revisar` NO se toca: son los motivos OPERATIVOS (por ejemplo, "falta vincular una publicación") y si se
         -- les agregara una frase del cierre, reabrir dejaría la orden en revisión por esa frase. El historial del
         -- cierre está en las columnas cerrada_manual_*.
         revisar = FALSE,
         actualizado_en = now()
   WHERE id = o.id;

  RETURN jsonb_build_object('ok', true, 'orden_id', o.id, 'motivo', p_motivo, 'venta_id', p_venta_id);
END; $$;

-- ── 4 · Deshacer el cierre ─────────────────────────────────────────────────
-- Vuelve a abrir la orden y recalcula si está en revisión (por ejemplo, si le falta vincular una publicación).
CREATE OR REPLACE FUNCTION public.meli_orden_reabrir_cierre(p_orden_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o public.meli_ordenes%ROWTYPE;
BEGIN
  IF NOT public.is_authorized_user() THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO o FROM public.meli_ordenes WHERE id = p_orden_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDEN_INEXISTENTE'; END IF;
  IF o.cerrada_manual_en IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'no_estaba_cerrada', true);
  END IF;

  UPDATE public.meli_ordenes
     SET cerrada_manual_en = NULL, cerrada_manual_por = NULL, cerrada_manual_motivo = NULL,
         cerrada_manual_nota = NULL, cerrada_manual_venta_id = NULL, actualizado_en = now(),
         -- Cerrar puso `revisar` en falso pero dejó los motivos: al reabrir vuelve a estar en revisión si todavía
         -- hay motivos (la revalidación de abajo solo recalcula cuando cambia el texto, así que se restituye acá).
         revisar = COALESCE(btrim(motivo_revisar), '') <> ''
   WHERE id = o.id;

  o := public.meli__revalidar_orden(o.id);
  RETURN jsonb_build_object('ok', true, 'orden_id', o.id, 'revisar', o.revisar);
END; $$;

-- ── 5 · Permisos ───────────────────────────────────────────────────────────
-- Se revoca de PUBLIC (anon y authenticated heredan de PUBLIC) y se otorga SOLO a authenticated; cada función
-- además exige is_authorized_user().
REVOKE EXECUTE ON FUNCTION public.meli_orden_cerrar_manual(BIGINT, TEXT, BIGINT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.meli_orden_reabrir_cierre(BIGINT)                    FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.meli_orden_cerrar_manual(BIGINT, TEXT, BIGINT, TEXT) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.meli_orden_reabrir_cierre(BIGINT)                    TO authenticated;
REVOKE ALL ON FUNCTION public.meli__orden_cerrada_guarda() FROM PUBLIC, anon, authenticated;

COMMIT;

-- ============================================================================
--  VERIFICACIÓN (solo lectura; sale como tabla al final). Tiene que verse TODO en ✅.
-- ============================================================================
SELECT id, control, CASE WHEN ok THEN '✅' ELSE '❌' END AS resultado
FROM (
  SELECT '12.1' AS id, 'meli_ordenes tiene las 5 columnas del cierre' AS control,
         (SELECT count(*) = 5 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'meli_ordenes'
             AND column_name IN ('cerrada_manual_en', 'cerrada_manual_por', 'cerrada_manual_motivo', 'cerrada_manual_nota', 'cerrada_manual_venta_id')) AS ok
  UNION ALL SELECT '12.2', 'Existe la guarda: una orden cerrada a mano no se procesa',
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'meli_orden_cerrada_guarda' AND tgrelid = 'public.meli_ordenes'::regclass AND NOT tgisinternal)
  UNION ALL SELECT '12.3', 'Existen las dos funciones (cerrar y reabrir)',
         to_regprocedure('public.meli_orden_cerrar_manual(bigint,text,bigint,text)') IS NOT NULL
         AND to_regprocedure('public.meli_orden_reabrir_cierre(bigint)') IS NOT NULL
  UNION ALL SELECT '12.4', 'Solo el CRM (authenticated) las puede ejecutar; anon y PUBLIC no',
         has_function_privilege('authenticated', 'public.meli_orden_cerrar_manual(bigint,text,bigint,text)', 'EXECUTE')
         AND has_function_privilege('authenticated', 'public.meli_orden_reabrir_cierre(bigint)', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public.meli_orden_cerrar_manual(bigint,text,bigint,text)', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public.meli_orden_reabrir_cierre(bigint)', 'EXECUTE')
  UNION ALL SELECT '12.5', 'Ninguna orden quedó cerrada Y procesada a la vez',
         NOT EXISTS (SELECT 1 FROM public.meli_ordenes WHERE cerrada_manual_en IS NOT NULL AND (procesada OR stock_descontado OR acreditado OR venta_id IS NOT NULL))
) t
ORDER BY id;
