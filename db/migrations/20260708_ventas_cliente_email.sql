-- Agregar columna email de cliente a la tabla ventas
-- Ejecutar en Supabase → SQL Editor

ALTER TABLE public.ventas ADD COLUMN IF NOT EXISTS cliente_email TEXT;
