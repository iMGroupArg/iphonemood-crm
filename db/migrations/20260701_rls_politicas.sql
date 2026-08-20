-- ============================================================
-- iPhoneMood CRM — Row Level Security (RLS)
-- Ejecutar en: Supabase Dashboard → SQL Editor
--
-- Modelo de seguridad:
--   • Acceso bloqueado para cualquiera sin sesión (anon key sola no alcanza)
--   • Usuarios autenticados con Google pueden verificar su propio acceso
--   • Solo usuarios en `usuarios_autorizados` (activo = true) pueden leer/escribir datos
-- ============================================================


-- ============================================================
-- 1. FUNCIÓN HELPER — verifica si el usuario activo está autorizado
--    SECURITY DEFINER: corre como superuser, evita el chicken-and-egg
--    de que RLS bloquee la propia consulta de autorización
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_authorized_user()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.usuarios_autorizados
    WHERE email = (auth.jwt() ->> 'email')
    AND activo = true
  )
$$;


-- ============================================================
-- 2. ACTIVAR RLS EN TODAS LAS TABLAS
-- ============================================================

ALTER TABLE public.personas              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cajas                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_movimientos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.garantias             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ventas                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.venta_items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.venta_pagos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.venta_notas           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reparaciones          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reparacion_repuestos  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reparacion_pagos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gastos                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gastos_fijos_plantilla ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categorias_gasto      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cambios               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cierres_mensuales     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usuarios_autorizados  ENABLE ROW LEVEL SECURITY;


-- ============================================================
-- 3. TABLA usuarios_autorizados — tratamiento especial
--
--    • SELECT propio: cualquier usuario autenticado puede ver
--      SU PROPIA fila (necesario para el login check)
--    • SELECT todos + escritura: solo usuarios ya autorizados
--      (necesario para el Panel de control)
-- ============================================================

-- Leer la propia fila (login check)
CREATE POLICY "usuarios_autorizados_select_own"
  ON public.usuarios_autorizados
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND email = (auth.jwt() ->> 'email')
  );

-- Leer todas las filas (Panel de control)
CREATE POLICY "usuarios_autorizados_select_all"
  ON public.usuarios_autorizados
  FOR SELECT
  USING (public.is_authorized_user());

-- Agregar / modificar / eliminar usuarios (Panel de control)
CREATE POLICY "usuarios_autorizados_insert"
  ON public.usuarios_autorizados
  FOR INSERT
  WITH CHECK (public.is_authorized_user());

CREATE POLICY "usuarios_autorizados_update"
  ON public.usuarios_autorizados
  FOR UPDATE
  USING (public.is_authorized_user());

CREATE POLICY "usuarios_autorizados_delete"
  ON public.usuarios_autorizados
  FOR DELETE
  USING (public.is_authorized_user());


-- ============================================================
-- 4. MACRO — política estándar para el resto de las tablas
--    Solo usuarios autorizados pueden leer y escribir
-- ============================================================

-- personas
CREATE POLICY "personas_all" ON public.personas
  USING (public.is_authorized_user())
  WITH CHECK (public.is_authorized_user());

-- cajas
CREATE POLICY "cajas_all" ON public.cajas
  USING (public.is_authorized_user())
  WITH CHECK (public.is_authorized_user());

-- stock
CREATE POLICY "stock_all" ON public.stock
  USING (public.is_authorized_user())
  WITH CHECK (public.is_authorized_user());

-- stock_movimientos
CREATE POLICY "stock_movimientos_all" ON public.stock_movimientos
  USING (public.is_authorized_user())
  WITH CHECK (public.is_authorized_user());

-- garantias
CREATE POLICY "garantias_all" ON public.garantias
  USING (public.is_authorized_user())
  WITH CHECK (public.is_authorized_user());

-- ventas
CREATE POLICY "ventas_all" ON public.ventas
  USING (public.is_authorized_user())
  WITH CHECK (public.is_authorized_user());

-- venta_items
CREATE POLICY "venta_items_all" ON public.venta_items
  USING (public.is_authorized_user())
  WITH CHECK (public.is_authorized_user());

-- venta_pagos
CREATE POLICY "venta_pagos_all" ON public.venta_pagos
  USING (public.is_authorized_user())
  WITH CHECK (public.is_authorized_user());

-- venta_notas
CREATE POLICY "venta_notas_all" ON public.venta_notas
  USING (public.is_authorized_user())
  WITH CHECK (public.is_authorized_user());

-- reparaciones
CREATE POLICY "reparaciones_all" ON public.reparaciones
  USING (public.is_authorized_user())
  WITH CHECK (public.is_authorized_user());

-- reparacion_repuestos
CREATE POLICY "reparacion_repuestos_all" ON public.reparacion_repuestos
  USING (public.is_authorized_user())
  WITH CHECK (public.is_authorized_user());

-- reparacion_pagos
CREATE POLICY "reparacion_pagos_all" ON public.reparacion_pagos
  USING (public.is_authorized_user())
  WITH CHECK (public.is_authorized_user());

-- gastos
CREATE POLICY "gastos_all" ON public.gastos
  USING (public.is_authorized_user())
  WITH CHECK (public.is_authorized_user());

-- gastos_fijos_plantilla
CREATE POLICY "gastos_fijos_plantilla_all" ON public.gastos_fijos_plantilla
  USING (public.is_authorized_user())
  WITH CHECK (public.is_authorized_user());

-- categorias_gasto
CREATE POLICY "categorias_gasto_all" ON public.categorias_gasto
  USING (public.is_authorized_user())
  WITH CHECK (public.is_authorized_user());

-- cambios
CREATE POLICY "cambios_all" ON public.cambios
  USING (public.is_authorized_user())
  WITH CHECK (public.is_authorized_user());

-- cierres_mensuales
CREATE POLICY "cierres_mensuales_all" ON public.cierres_mensuales
  USING (public.is_authorized_user())
  WITH CHECK (public.is_authorized_user());
