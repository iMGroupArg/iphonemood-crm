CREATE TABLE IF NOT EXISTS adelantos_socios (
  id           BIGSERIAL PRIMARY KEY,
  socio        TEXT NOT NULL,
  motivo       TEXT NOT NULL,
  monto        NUMERIC(18,2) NOT NULL,
  moneda       TEXT NOT NULL DEFAULT 'ARS',
  fecha        DATE NOT NULL DEFAULT CURRENT_DATE,
  estado       TEXT NOT NULL DEFAULT 'pendiente',  -- 'pendiente' | 'cobrado'
  fecha_cobro  DATE,
  caja_debito  TEXT,   -- "persona-bolsillo" de donde salió al devolver
  notas        TEXT,
  creado_en    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_adelantos_estado ON adelantos_socios(estado);

ALTER TABLE adelantos_socios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_adelantos" ON adelantos_socios
  FOR ALL USING (auth.role() = 'authenticated');
