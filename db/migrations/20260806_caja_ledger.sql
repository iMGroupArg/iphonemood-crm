-- ============================================================================
--  LIBRO DE MOVIMIENTOS DE CAJA  ("punto 0")
--
--  Hoy la base guarda SOLO el saldo final de cada caja. Si un saldo queda
--  mal, no hay forma de reconstruirlo. Esto agrega el libro mayor: cada
--  entrada y salida queda registrada con su origen.
--
--  El "punto 0" es una foto de los saldos de hoy. A partir de ahí se cumple
--  siempre esta regla:
--
--      suma de todos los movimientos de una caja  =  saldo actual de esa caja
--
--  Si algún día deja de cumplirse, sabemos que algo se escribió mal, y la
--  última consulta de este archivo te lo muestra.
--
--  Ejecutar UNA sola vez, entero.
-- ============================================================================

BEGIN;

-- ─── 1 · La tabla ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.caja_ledger (
  id          BIGSERIAL PRIMARY KEY,
  persona_id  UUID REFERENCES public.personas(id) ON DELETE SET NULL,
  persona     TEXT NOT NULL,              -- copia del nombre, sobrevive al borrado
  bolsillo    TEXT NOT NULL,
  delta       NUMERIC(18,2) NOT NULL,     -- positivo entra, negativo sale
  saldo_post  NUMERIC(18,2),              -- saldo que quedó después del movimiento
  tipo        TEXT NOT NULL DEFAULT 'otro',
                                          -- saldo_inicial | venta | venta_anulada
                                          -- | pago_eliminado | gasto | reparacion
                                          -- | cueva | proveedor | cuenta_corriente
                                          -- | movimiento | ajuste | otro
  referencia  TEXT,                       -- nro de venta, gasto, reparación, etc.
  descripcion TEXT,
  creado_por  TEXT,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_caja_ledger_caja
  ON public.caja_ledger (persona, bolsillo, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_caja_ledger_ref
  ON public.caja_ledger (tipo, referencia);


-- ─── 2 · Permisos (mismo criterio que el resto del CRM) ──────

ALTER TABLE public.caja_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "caja_ledger_all" ON public.caja_ledger;
CREATE POLICY "caja_ledger_all" ON public.caja_ledger
  USING (public.is_authorized_user())
  WITH CHECK (public.is_authorized_user());


-- ─── 3 · PUNTO 0: foto de los saldos actuales ────────────────
--     Solo se inserta si el libro está vacío, así correr esto dos
--     veces por error no duplica el punto de partida.

INSERT INTO public.caja_ledger
  (persona_id, persona, bolsillo, delta, saldo_post, tipo, descripcion)
SELECT c.persona_id,
       p.nombre,
       c.bolsillo,
       c.saldo,
       c.saldo,
       'saldo_inicial',
       'Punto 0 — saldo al iniciar el libro de movimientos'
FROM public.cajas c
JOIN public.personas p ON p.id = c.persona_id
WHERE NOT EXISTS (SELECT 1 FROM public.caja_ledger);

COMMIT;


-- ============================================================================
--  VERIFICACIÓN
-- ============================================================================

-- A) El punto 0 que quedó grabado
SELECT persona, bolsillo, saldo_post AS saldo_inicial
FROM public.caja_ledger
WHERE tipo = 'saldo_inicial'
ORDER BY persona, bolsillo;

-- B) CONTROL DE CUADRE — guardá esta consulta.
--    Compara la suma del libro contra el saldo real de cada caja.
--    Mientras "diferencia" sea 0, las cajas están sanas.
SELECT p.nombre                         AS persona,
       c.bolsillo,
       c.saldo                          AS saldo_real,
       COALESCE(l.suma, 0)              AS suma_movimientos,
       c.saldo - COALESCE(l.suma, 0)    AS diferencia
FROM public.cajas c
JOIN public.personas p ON p.id = c.persona_id
LEFT JOIN (
  SELECT persona, bolsillo, SUM(delta) AS suma
  FROM public.caja_ledger GROUP BY persona, bolsillo
) l ON l.persona = p.nombre AND l.bolsillo = c.bolsillo
ORDER BY ABS(c.saldo - COALESCE(l.suma, 0)) DESC, p.nombre;
