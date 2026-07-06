-- =====================================================================
-- Cuenta Corriente — deudas manuales y sus pagos
-- Ejecutar en Supabase → SQL Editor
-- =====================================================================

-- Deudas manuales (no ligadas a ventas/reparaciones)
CREATE TABLE IF NOT EXISTS deudas_manuales (
  id             SERIAL PRIMARY KEY,
  cliente        TEXT NOT NULL,
  cliente_tel    TEXT,
  descripcion    TEXT NOT NULL,
  concepto       TEXT,
  moneda         TEXT NOT NULL DEFAULT 'USD' CHECK (moneda IN ('USD','ARS')),
  monto          DECIMAL(12,2) NOT NULL CHECK (monto > 0),
  monto_pagado   DECIMAL(12,2) NOT NULL DEFAULT 0,
  estado         TEXT NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa','pagada','cancelada')),
  notas          TEXT,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pagos aplicados a deudas manuales
CREATE TABLE IF NOT EXISTS deuda_pagos (
  id             SERIAL PRIMARY KEY,
  deuda_id       INTEGER REFERENCES deudas_manuales(id) ON DELETE CASCADE,
  monto          DECIMAL(12,2) NOT NULL,
  moneda         TEXT NOT NULL DEFAULT 'USD',
  persona        TEXT,
  bolsillo       TEXT,
  notas          TEXT,
  fecha          DATE NOT NULL DEFAULT CURRENT_DATE,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE deudas_manuales ENABLE ROW LEVEL SECURITY;
ALTER TABLE deuda_pagos     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_deudas_manuales" ON deudas_manuales;
DROP POLICY IF EXISTS "admin_deuda_pagos"     ON deuda_pagos;

CREATE POLICY "admin_deudas_manuales" ON deudas_manuales
  USING (is_authorized_user()) WITH CHECK (is_authorized_user());

CREATE POLICY "admin_deuda_pagos" ON deuda_pagos
  USING (is_authorized_user()) WITH CHECK (is_authorized_user());
