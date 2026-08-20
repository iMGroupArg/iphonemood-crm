-- ============================================================
-- GARANTÍA AUTOMÁTICA POR VENTA
-- Ejecutar en Supabase → SQL Editor
-- ============================================================
--
-- Problema que resuelve: el resumen de garantías de una venta (y el recibo
-- PDF, y el listado por vencer) siempre mostraba 0, en TODAS las ventas —
-- no era un bug de cálculo, era que ningún punto del flujo de venta llegaba
-- a guardar la fecha de garantía. El catálogo de categorías en Panel →
-- Garantías existía, pero no estaba conectado a nada.
--
-- Regla acordada con Franco: equipos nuevos = 365 días (garantía oficial),
-- usados = 60 días (garantía del comercio). Eso se define UNA vez en Panel →
-- Garantías, marcando cada categoría con su tipo; después la venta la asigna
-- sola según la condición del producto (columna `estado_producto` en stock).

-- Conecta una categoría del catálogo con la condición del producto vendido.
ALTER TABLE public.garantias
  ADD COLUMN IF NOT EXISTS tipo text; -- 'nuevo' | 'usado' | null (categorías manuales, sin auto-asignación)

-- Guarda la garantía asignada a cada ítem vendido, calculada con la fecha
-- real de la venta. Sin FK a garantias(id): no se conoce el tipo exacto de
-- esa columna desde acá y una migración que falla por tipos incompatibles
-- es peor que no tener la referencia.
ALTER TABLE public.venta_items
  ADD COLUMN IF NOT EXISTS garantia_id bigint,
  ADD COLUMN IF NOT EXISTS garantia_dias integer,
  ADD COLUMN IF NOT EXISTS garantia_inicio date,
  ADD COLUMN IF NOT EXISTS garantia_fin date;

-- Nada de esto es retroactivo: las ventas ya cargadas quedan sin garantía
-- asignada (como estaban). Solo las ventas nuevas, después de correr esta
-- migración Y de marcar el tipo en Panel → Garantías, la calculan sola.
