-- ============================================================
-- SALDO A FAVOR CON PROVEEDORES
-- Ejecutar en Supabase → SQL Editor
-- ============================================================
--
-- Problema que resuelve: cuando queda plata a favor con un proveedor
-- (se pagó de más en un lote, o se dejó un anticipo), hasta ahora la
-- única forma de guardar ese número en el sistema era crear al
-- proveedor como si fuera una "persona" con su propia caja — lo que
-- mezcla esa plata con el efectivo real del negocio en el Dashboard,
-- en el listado de cajas y en selectores donde un proveedor no pinta
-- (vendedor de una venta, custodio de un trade-in, etc).
--
-- Esta tabla es una cuenta corriente CON el proveedor: un movimiento
-- 'generado' es crédito que se gana (sobrepago en un lote, o un ajuste
-- manual), un movimiento 'aplicado' es crédito que se usa como parte
-- del pago de un lote nuevo. El saldo a favor es la suma de los
-- 'generado' menos la suma de los 'aplicado'.

CREATE TABLE IF NOT EXISTS proveedor_creditos (
  id serial PRIMARY KEY,
  proveedor_id uuid REFERENCES proveedores(id) ON DELETE CASCADE,
  tipo text NOT NULL,              -- 'generado' | 'aplicado'
  monto_usd numeric(10,2) NOT NULL,
  lote_id int REFERENCES lotes_compra(id) ON DELETE SET NULL,  -- lote de origen (generado) o donde se aplicó (aplicado); null = ajuste manual
  fecha date DEFAULT CURRENT_DATE,
  notas text DEFAULT '',
  creado_en timestamptz DEFAULT now()
);

ALTER TABLE proveedor_creditos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authorized_users_proveedor_creditos" ON proveedor_creditos FOR ALL USING (is_authorized_user());
