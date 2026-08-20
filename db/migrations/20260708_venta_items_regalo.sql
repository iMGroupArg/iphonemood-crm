-- Marcar accesorios entregados como regalo en ventas
-- Ejecutar en Supabase → SQL Editor

ALTER TABLE public.venta_items ADD COLUMN IF NOT EXISTS es_regalo BOOLEAN NOT NULL DEFAULT FALSE;
