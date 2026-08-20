-- Presupuestos con canje (trade-in) para mandarle al cliente por WhatsApp.
--
-- Franco los arma desde el CRM y comparte el link público:
--   https://iphonemood.com/precios.html?presupuesto=<token>
--
-- ── Por qué se guarda una FOTO de los números y no referencias ──
-- Un presupuesto es una oferta con validez. Si la página lo recalculara con
-- el precio y el dólar de HOY, el número que el cliente recibió el lunes
-- cambiaría solo el martes. Por eso se congelan al crearlo: el precio del
-- equipo, la cotización del dólar y la configuración de financiación. El
-- presupuesto muestra siempre lo que Franco ofreció, pase lo que pase
-- después con el stock o con el blue.

CREATE TABLE IF NOT EXISTS presupuestos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token       text UNIQUE NOT NULL,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  vence_en    timestamptz,                 -- NULL = sin vencimiento
  cliente     text,
  -- equipo que se lleva (foto del producto al momento de cotizar)
  producto    jsonb NOT NULL,              -- {nombre, modelo, storage, color, categoria, precio_usd, estado_producto}
  -- equipo que entrega, con la cotización que le dio Franco
  trade_in    jsonb,                       -- {modelo, storage, color, estado, bateria_pct, valor_usd}
  -- congelados al crear
  cotizacion  numeric NOT NULL,            -- dólar blue del día
  pagos_cfg   jsonb NOT NULL,              -- coeficientes de financiación vigentes
  notas       text
);

CREATE INDEX IF NOT EXISTS presupuestos_token_idx ON presupuestos (token);

ALTER TABLE presupuestos ENABLE ROW LEVEL SECURITY;

-- Solo el CRM (usuarios autorizados) puede crear, ver la lista y editar.
DROP POLICY IF EXISTS "auth_all_presupuestos" ON presupuestos;
CREATE POLICY "auth_all_presupuestos" ON presupuestos
  FOR ALL USING (public.is_authorized_user());

-- ── Lectura pública SOLO conociendo el token ──
-- No se abre la tabla al rol anónimo: se expone una función que recibe el
-- token y devuelve esa fila y nada más. Sin el token no hay forma de listar
-- ni de adivinar presupuestos ajenos. Es el mismo esquema que usa el
-- seguimiento de reparaciones.
CREATE OR REPLACE FUNCTION public.presupuesto_por_token(p_token text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT to_jsonb(p) - 'id'
  FROM public.presupuestos p
  WHERE p.token = p_token
    AND (p.vence_en IS NULL OR p.vence_en > now())
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.presupuesto_por_token(text) FROM public;
GRANT EXECUTE ON FUNCTION public.presupuesto_por_token(text) TO anon, authenticated;
