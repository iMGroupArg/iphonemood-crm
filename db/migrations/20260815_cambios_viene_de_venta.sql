-- Marca las operaciones de cueva cuya plata YA viene de una venta cargada.
--
-- Problema que resuelve: cuando se cobra una venta en ARS a una cotización
-- propia y después esos mismos pesos se pasan a dólares cargándolos como
-- operación de cueva, la misma plata queda valuada dos veces con dos varas
-- distintas. La venta ya la midió contra su cotización; la cueva la vuelve a
-- medir contra el dólar blue e inventa una ganancia o una pérdida que no
-- existe.
--
-- Con esta marca activada, el spread de esa operación se mide contra la
-- cotización de la venta (columna cotiz_ref) en vez del blue.
--
-- Las filas existentes quedan en FALSE: nada de lo ya cargado cambia de valor.
-- Es importante que sea así — el campo cotiz_ref venía guardándose para todas
-- las operaciones con el blue del momento, sin que nadie lo eligiera, así que
-- interpretarlo retroactivamente movería números de meses ya cerrados.

ALTER TABLE public.cambios
  ADD COLUMN IF NOT EXISTS viene_de_venta boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.cambios.viene_de_venta IS
  'true = la plata de esta operación proviene de una venta ya cargada; su spread se mide contra cotiz_ref (la cotización de esa venta), no contra el blue.';
