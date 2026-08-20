-- ============================================================================
--  OPCIONAL — Redondear los saldos de caja a centavos
--
--  Hoy algunos saldos quedaron con toda la precisión del cálculo,
--  por ejemplo 146534.43770491815 en vez de 146534.44.
--  El libro guarda 2 decimales, así que la comparación arrastra
--  una diferencia de milésimas de centavo.
--
--  Esto ajusta los saldos a 2 decimales y deja el cuadre exacto en 0.
--  El mayor ajuste es de 0,23 centavos: no cambia la plata.
--
--  De acá en adelante el CRM ya redondea solo, así que esto se corre
--  una única vez.
-- ============================================================================

BEGIN;

-- Ver qué se va a ajustar (antes de tocar nada)
SELECT p.nombre AS persona, c.bolsillo,
       c.saldo                         AS saldo_actual,
       ROUND(c.saldo, 2)               AS saldo_redondeado,
       ROUND(c.saldo, 2) - c.saldo     AS ajuste
FROM public.cajas c
JOIN public.personas p ON p.id = c.persona_id
WHERE c.saldo <> ROUND(c.saldo, 2)
ORDER BY ABS(ROUND(c.saldo, 2) - c.saldo) DESC;

-- Aplicar
UPDATE public.cajas
   SET saldo = ROUND(saldo, 2)
 WHERE saldo <> ROUND(saldo, 2);

COMMIT;


-- ─── Control de cuadre: ahora tiene que dar 0 en todas ───
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
