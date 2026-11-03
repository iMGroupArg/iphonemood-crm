-- ============================================================================
--  arca_reloj.sql — RELOJ DE LA FACTURACIÓN AUTOMÁTICA DENTRO DE SUPABASE (cada 5 minutos)
--
--  QUÉ HACE: programa en Supabase una llamada cada 5 minutos a  https://iphonemood.com/api/meli/worker?modo=frecuente  (el modo liviano del worker:
--  procesa los avisos de Mercado Libre y corre la facturación automática, sin el barrido pesado). Reemplaza al reloj de GitHub Actions, que no arrancó.
--
--  REGLAS
--   · La clave del reloj NO está en este archivo ni en el repositorio: vive en la bóveda de Supabase (vault) con el nombre «disparador_secret» y
--     debe ser IGUAL a la variable DISPARADOR_SECRET de Vercel. Se carga en un segundo paso, aparte (ver abajo).
--   · Sin la clave cargada, la función NO llama a nada (no falla ni gasta).
--   · La función que hace la llamada queda cerrada al navegador y a service_role: solo la ejecuta la propia programación de Supabase.
--   · No cambia ningún dato del CRM. Idempotente: se puede correr más de una vez (reemplaza la tarea, no la duplica).
--
--  REQUISITOS: script 23 (arca_automatico). Las extensiones pg_cron y pg_net (y la bóveda) las activa este script; si Supabase se negara, se
--  activan desde Database → Extensions y se vuelve a correr.
--
--  DESPUÉS DE CORRERLO
--   1. Cargar la clave en la bóveda (una línea aparte que se arma con la clave nueva; no va en el repositorio).
--   2. A los ~10 minutos, comprobar que el reloj llama bien (solo lectura):
--        SELECT id, status_code, created FROM net._http_response ORDER BY id DESC LIMIT 5;      -- tiene que mostrar 200
--        SELECT status, start_time FROM cron.job_run_details ORDER BY runid DESC LIMIT 5;       -- tiene que mostrar succeeded
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.arca_auto_config') IS NULL THEN
    RAISE EXCEPTION 'Falta el script 23 (arca_automatico). Correrlo antes que este.';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

BEGIN;

-- Lee la clave de la bóveda y llama al worker. Devuelve el id de la llamada (para mirar su respuesta en net._http_response) o NULL si no hay clave.
CREATE OR REPLACE FUNCTION public.arca_reloj_llamar()
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_clave TEXT; v_id BIGINT;
BEGIN
  SELECT s.decrypted_secret INTO v_clave FROM vault.decrypted_secrets s WHERE s.name = 'disparador_secret' ORDER BY s.created_at DESC LIMIT 1;
  IF v_clave IS NULL OR v_clave = '' THEN RETURN NULL; END IF;
  SELECT net.http_get(url := 'https://iphonemood.com/api/meli/worker?modo=frecuente',
                      headers := jsonb_build_object('Authorization', 'Bearer ' || v_clave),
                      timeout_milliseconds := 60000) INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.arca_reloj_llamar() FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON FUNCTION public.arca_reloj_llamar() FROM service_role;
  END IF;
END $$;

-- La tarea: cada 5 minutos. Si ya existía, se reemplaza.
DO $$
BEGIN
  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'arca-reloj';
  PERFORM cron.schedule('arca-reloj', '*/5 * * * *', 'SELECT public.arca_reloj_llamar()');
END $$;

COMMIT;

-- Verificación (solo lectura): tiene que dar dos filas con ✅.
SELECT 'tarea programada cada 5 minutos' AS control,
       CASE WHEN EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = 'arca-reloj' AND j.schedule = '*/5 * * * *' AND j.active)
             AND to_regprocedure('public.arca_reloj_llamar()') IS NOT NULL THEN '✅' ELSE '❌' END AS resultado
UNION ALL
SELECT 'la función queda cerrada al navegador',
       CASE WHEN NOT has_function_privilege('anon', 'public.arca_reloj_llamar()', 'EXECUTE')
             AND NOT has_function_privilege('authenticated', 'public.arca_reloj_llamar()', 'EXECUTE') THEN '✅' ELSE '❌' END;
