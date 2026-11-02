-- ============================================================================
--  lote_pagos_conversion_lote.sql  (script 14) — CONVERSIÓN USD → USDT CON SOBRANTE DENTRO DE UN LOTE
--
--  PROBLEMA: el CRM registra la conversión dentro del lote y asume que se convierte JUSTO lo que el lote usa. Si Franco
--  cambia 10.000 USD y el lote usa 8.790 USDT, la comisión que se carga al lote (300) es de más y los 910 USDT que
--  sobran no tienen cómo figurar. Plan: docs/plan-conversiones-con-sobrante.md (Fase A).
--
--  QUÉ HACE: dos columnas nuevas, NULAS, en lote_pagos (solo para filas tipo 'conversion'):
--    usdt_lote          cuántos USDT de lo recibido usa ESTE lote            (> 0 y <= monto_usdt)
--    comision_lote_usd  la parte de la comisión total que se carga a ESTE lote (>= 0 y <= comision_usd)
--  Las filas viejas quedan en NULL y el CRM las lee como hasta hoy (solo la primera conversión del lote cuenta).
--  Una fila nueva trae las dos o ninguna. No cambia ningún dato existente. No toca cajas ni stock.
--
--  REQUISITO: la tabla lote_pagos (db/migrations/20260703_proveedores_lotes.sql). Idempotente (se puede correr varias veces).
--  ORDEN: este script ANTES de publicar el código que usa las columnas. Si falta, el CRM no deja registrar una
--  conversión con sobrante (avisa antes de mover plata); las conversiones sin sobrante siguen como siempre.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.lote_pagos') IS NULL THEN
    RAISE EXCEPTION 'Falta la tabla lote_pagos (db/migrations/20260703_proveedores_lotes.sql). Correrla antes que este script.';
  END IF;
END $$;

BEGIN;

ALTER TABLE public.lote_pagos
  ADD COLUMN IF NOT EXISTS usdt_lote          numeric(10,2),
  ADD COLUMN IF NOT EXISTS comision_lote_usd  numeric(10,2);

-- Se recrea siempre: así correr el script de nuevo deja la versión vigente de la regla.
ALTER TABLE public.lote_pagos DROP CONSTRAINT IF EXISTS lote_pagos_conversion_lote_ck;
-- Todo o nada, y solo en conversiones: con sobrante, lo del lote nunca supera lo recibido ni lo cobrado.
ALTER TABLE public.lote_pagos ADD CONSTRAINT lote_pagos_conversion_lote_ck CHECK (
      (usdt_lote IS NULL AND comision_lote_usd IS NULL)
      OR (tipo = 'conversion'
          AND usdt_lote IS NOT NULL AND comision_lote_usd IS NOT NULL
          AND monto_usdt IS NOT NULL AND comision_usd IS NOT NULL   -- sin totales no hay tope que comparar
          AND usdt_lote > 0 AND usdt_lote <= monto_usdt
          AND comision_lote_usd >= 0 AND comision_lote_usd <= comision_usd));

COMMIT;

-- ============================================================================
--  VERIFICACIÓN (solo lectura; sale como tabla al final). Tiene que verse TODO en ✅.
-- ============================================================================
SELECT id, control, CASE WHEN ok THEN '✅' ELSE '❌' END AS resultado
FROM (
  SELECT '14.1' AS id, 'lote_pagos tiene las dos columnas nuevas' AS control,
         (SELECT count(*) = 2 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'lote_pagos'
             AND column_name IN ('usdt_lote', 'comision_lote_usd')) AS ok
  UNION ALL SELECT '14.2', 'Existe la regla que impide valores incoherentes (todo o nada, solo conversiones, topes)',
         EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lote_pagos_conversion_lote_ck' AND conrelid = 'public.lote_pagos'::regclass)
) t
ORDER BY id;
