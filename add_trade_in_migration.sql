-- Trade-in columns para ventas
-- Ejecutar en Supabase → SQL Editor

ALTER TABLE public.ventas ADD COLUMN IF NOT EXISTS trade_in_modelo TEXT;
ALTER TABLE public.ventas ADD COLUMN IF NOT EXISTS trade_in_valor DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.ventas ADD COLUMN IF NOT EXISTS trade_in_data JSONB;
