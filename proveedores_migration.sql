-- ============================================================
-- MIGRACIÓN: Módulo de Proveedores y Lotes de Compra
-- Ejecutar en Supabase → SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS proveedores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre text NOT NULL,
  contacto text DEFAULT '',
  telefono text DEFAULT '',
  email text DEFAULT '',
  notas text DEFAULT '',
  activo boolean DEFAULT true,
  creado_en timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lotes_compra (
  id serial PRIMARY KEY,
  proveedor_id uuid REFERENCES proveedores(id) ON DELETE SET NULL,
  nombre text DEFAULT '',
  fecha_orden date NOT NULL DEFAULT CURRENT_DATE,
  fecha_llegada_esperada date,
  fecha_recepcion date,
  estado text NOT NULL DEFAULT 'programado', -- programado | pagado | recibido | cancelado
  notas text DEFAULT '',
  creado_en timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lote_items (
  id serial PRIMARY KEY,
  lote_id int REFERENCES lotes_compra(id) ON DELETE CASCADE,
  nombre text NOT NULL,
  cat text DEFAULT 'iphone',
  modelo text DEFAULT '',
  storage text DEFAULT '',
  color text DEFAULT '',
  cantidad int DEFAULT 1,
  precio_usd numeric(10,2) DEFAULT 0,
  grado text DEFAULT '',
  notas text DEFAULT ''
);

CREATE TABLE IF NOT EXISTS lote_pagos (
  id serial PRIMARY KEY,
  lote_id int REFERENCES lotes_compra(id) ON DELETE CASCADE,
  tipo text NOT NULL,           -- conversion | pago_proveedor | envio
  monto_usd numeric(10,2) DEFAULT 0,
  monto_usdt numeric(10,2) DEFAULT 0,
  comision_pct numeric(5,2) DEFAULT 0,
  comision_usd numeric(10,2) DEFAULT 0,
  moneda text DEFAULT 'USD',
  persona text DEFAULT '',
  bolsillo text DEFAULT '',
  persona_dest text DEFAULT '',
  bolsillo_dest text DEFAULT '',
  fecha date DEFAULT CURRENT_DATE,
  notas text DEFAULT '',
  creado_en timestamptz DEFAULT now()
);

-- RLS: misma política que el resto de la app
ALTER TABLE proveedores ENABLE ROW LEVEL SECURITY;
ALTER TABLE lotes_compra ENABLE ROW LEVEL SECURITY;
ALTER TABLE lote_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE lote_pagos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authorized_users_proveedores" ON proveedores FOR ALL USING (is_authorized_user());
CREATE POLICY "authorized_users_lotes" ON lotes_compra FOR ALL USING (is_authorized_user());
CREATE POLICY "authorized_users_lote_items" ON lote_items FOR ALL USING (is_authorized_user());
CREATE POLICY "authorized_users_lote_pagos" ON lote_pagos FOR ALL USING (is_authorized_user());
