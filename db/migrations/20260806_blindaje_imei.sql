-- ============================================================
-- BLINDAJE ANTI-DUPLICADOS POR IMEI
--
-- Corré este archivo entero de una vez. Hace dos cosas:
--   PARTE A: te muestra los problemas que hay hoy (solo lee)
--   PARTE B: instala un candado para que no se pueda volver a duplicar
--
-- Una vez instalado el candado, NINGUNA vía puede cargar dos veces
-- el mismo IMEI: ni un script, ni un doble clic, ni el CRM.
-- La base misma lo rechaza con un mensaje claro.
-- ============================================================


-- ─── PARTE A · Diagnóstico (solo lectura) ───────────────────

-- A1) IMEIs que aparecen en más de un producto
SELECT i.imei,
       count(*)                        AS en_cuantos_productos,
       array_agg(s.nombre)             AS productos,
       array_agg(s.id::text)           AS ids
FROM stock s, unnest(s.imeis) AS i(imei)
GROUP BY i.imei
HAVING count(*) > 1;

-- A2) IMEIs mal cargados (un IMEI válido tiene 15 dígitos)
SELECT s.id, s.nombre, i.imei, length(i.imei) AS digitos
FROM stock s, unnest(s.imeis) AS i(imei)
WHERE length(i.imei) <> 15
ORDER BY s.nombre;


-- ─── PARTE B · El candado ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.stock_imei_unico()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_dup text;
BEGIN
  -- Sin IMEIs no hay nada que revisar
  IF NEW.imeis IS NULL OR array_length(NEW.imeis, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  -- 1) Repetido dentro del mismo producto
  SELECT i INTO v_dup
  FROM unnest(NEW.imeis) AS i
  GROUP BY i
  HAVING count(*) > 1
  LIMIT 1;

  IF v_dup IS NOT NULL THEN
    RAISE EXCEPTION 'El IMEI % está cargado dos veces en este mismo producto', v_dup;
  END IF;

  -- 2) Repetido contra otro producto del stock
  SELECT i INTO v_dup
  FROM unnest(NEW.imeis) AS i
  WHERE EXISTS (
    SELECT 1 FROM public.stock s
    WHERE s.id IS DISTINCT FROM NEW.id
      AND s.imeis @> ARRAY[i]
  )
  LIMIT 1;

  IF v_dup IS NOT NULL THEN
    RAISE EXCEPTION 'El IMEI % ya está cargado en otro producto del stock', v_dup;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_imei_unico ON public.stock;

CREATE TRIGGER trg_stock_imei_unico
  BEFORE INSERT OR UPDATE OF imeis ON public.stock
  FOR EACH ROW
  EXECUTE FUNCTION public.stock_imei_unico();


-- ─── Comprobación final ─────────────────────────────────────
-- Tiene que devolver una fila con el trigger instalado.
SELECT tgname AS candado_instalado
FROM pg_trigger
WHERE tgname = 'trg_stock_imei_unico';
