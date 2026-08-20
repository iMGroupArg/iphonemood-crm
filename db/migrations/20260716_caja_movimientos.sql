-- Movimientos entre cajas / retiros
-- Ejecutar en Supabase > SQL Editor

CREATE TABLE IF NOT EXISTS caja_movimientos (
  id            BIGSERIAL PRIMARY KEY,
  tipo          TEXT NOT NULL,                  -- 'pasada_manos' | 'retiro_banco' | 'deposito_banco' | 'otro'
  descripcion   TEXT,
  -- Origen
  origen_persona_id  UUID REFERENCES personas(id),
  origen_bolsillo    TEXT,
  -- Destino (puede ser null en retiro)
  destino_persona_id UUID REFERENCES personas(id),
  destino_bolsillo   TEXT,
  -- Monto
  monto         NUMERIC(18,2) NOT NULL,
  moneda        TEXT NOT NULL DEFAULT 'ARS',   -- 'ARS' | 'USD' | 'USDT'
  -- Comprobante
  comprobante_url TEXT,
  -- Meta
  creado_por    TEXT,
  creado_en     TIMESTAMPTZ DEFAULT NOW()
);

-- Índice para listar rápido
CREATE INDEX IF NOT EXISTS idx_caja_mov_creado ON caja_movimientos(creado_en DESC);

-- RLS: solo usuarios autenticados
ALTER TABLE caja_movimientos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_caja_movimientos" ON caja_movimientos
  FOR ALL USING (auth.role() = 'authenticated');

-- Storage bucket para comprobantes (ejecutar también si no existe)
INSERT INTO storage.buckets (id, name, public)
VALUES ('comprobantes', 'comprobantes', false)
ON CONFLICT (id) DO NOTHING;

-- Policy de storage
CREATE POLICY "auth_upload_comprobantes" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'comprobantes' AND auth.role() = 'authenticated');

CREATE POLICY "auth_read_comprobantes" ON storage.objects
  FOR SELECT USING (bucket_id = 'comprobantes' AND auth.role() = 'authenticated');
