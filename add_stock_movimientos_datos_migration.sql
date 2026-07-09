-- Agregar columna datos JSONB a stock_movimientos para metadata extra (ej: trade-in)
-- Ejecutar en Supabase → SQL Editor

ALTER TABLE public.stock_movimientos ADD COLUMN IF NOT EXISTS datos JSONB;
