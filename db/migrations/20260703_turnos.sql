-- ============================================================
-- MIGRACIÓN: Módulo de Turnos / Reservas
-- Ejecutar en Supabase → SQL Editor
-- ============================================================

-- Slots de disponibilidad (los crea el admin)
CREATE TABLE IF NOT EXISTS turnos_slots (
  id serial PRIMARY KEY,
  fecha date NOT NULL,
  hora_inicio time NOT NULL,
  hora_fin time NOT NULL,
  encargado text DEFAULT '',
  disponible boolean DEFAULT true,
  creado_en timestamptz DEFAULT now()
);

-- Reservas hechas por clientes
CREATE TABLE IF NOT EXISTS turnos_reservas (
  id serial PRIMARY KEY,
  slot_id int REFERENCES turnos_slots(id) ON DELETE SET NULL,
  nombre text NOT NULL,
  telefono text NOT NULL,
  email text DEFAULT '',
  equipo text DEFAULT '',
  comentarios text DEFAULT '',
  estado text DEFAULT 'pendiente',
  encargado text DEFAULT '',
  token uuid DEFAULT gen_random_uuid(),
  creado_en timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE turnos_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE turnos_reservas ENABLE ROW LEVEL SECURITY;

-- Admin: acceso completo
CREATE POLICY "admin_slots" ON turnos_slots FOR ALL USING (is_authorized_user());
CREATE POLICY "admin_reservas" ON turnos_reservas FOR ALL USING (is_authorized_user());

-- Público: ver slots disponibles (sin login)
CREATE POLICY "public_ver_slots" ON turnos_slots
  FOR SELECT USING (disponible = true AND fecha >= CURRENT_DATE);

-- Público: crear reservas (sin login)
CREATE POLICY "public_crear_reserva" ON turnos_reservas
  FOR INSERT WITH CHECK (true);
