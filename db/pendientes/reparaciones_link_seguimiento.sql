-- ============================================================================
--  reparaciones_link_seguimiento.sql — da link de seguimiento a las reparaciones que no lo tienen
--  La pantalla de una reparación dice "aún no tiene link de seguimiento" cuando token_seguimiento está vacío.
--  Pone el valor por defecto para las reparaciones nuevas y rellena SOLO las que no tienen (no toca los links existentes).
--  Idempotente. Probado en Postgres local con la columna: texto con vacíos, uuid con NULL, inexistente y de tipo raro (frena).
-- ============================================================================

DO $$
DECLARE v_tipo text;
BEGIN
  SELECT data_type INTO v_tipo FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'reparaciones' AND column_name = 'token_seguimiento';
  IF v_tipo IS NULL THEN
    ALTER TABLE public.reparaciones ADD COLUMN token_seguimiento text;
    v_tipo := 'text';
  END IF;
  IF v_tipo = 'uuid' THEN
    ALTER TABLE public.reparaciones ALTER COLUMN token_seguimiento SET DEFAULT gen_random_uuid();
    UPDATE public.reparaciones SET token_seguimiento = gen_random_uuid() WHERE token_seguimiento IS NULL;
  ELSIF v_tipo IN ('text', 'character varying') THEN
    ALTER TABLE public.reparaciones ALTER COLUMN token_seguimiento SET DEFAULT replace(gen_random_uuid()::text, '-', '');
    UPDATE public.reparaciones SET token_seguimiento = replace(gen_random_uuid()::text, '-', '')
     WHERE token_seguimiento IS NULL OR btrim(token_seguimiento) = '';
  ELSE
    RAISE EXCEPTION 'token_seguimiento tiene un tipo inesperado (%): no se toca nada.', v_tipo;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS reparaciones_token_seguimiento_unico
  ON public.reparaciones (token_seguimiento) WHERE token_seguimiento IS NOT NULL;

SELECT count(*) AS total, count(token_seguimiento) AS con_link, count(*) - count(token_seguimiento) AS sin_link FROM public.reparaciones;
