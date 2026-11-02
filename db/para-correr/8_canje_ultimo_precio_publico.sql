-- ============================================================================
--  canje_ultimo_precio_publico — último precio vendido de iPhone USADO, para el Plan Canje
--
--  PENDIENTE DE CORRER (script 8). Pedido por Precios/landing (decisión de Franco: el asistente de Plan Canje
--  muestra un valor estimado = precio público − 120 USD y, si el modelo no tiene usados publicados, usa el
--  último precio vendido). Orden: DESPUÉS de catalogo_modelos_publico.sql (6). Idempotente.
--
--  QUÉ EXPONE (a `anon`, sólo lectura)
--    canje_ultimo_precio_publico(modelo TEXT, storage TEXT, precio_usd INT) — como mucho UNA fila por
--    modelo + capacidad de iPhone USADO: el precio, en dólares enteros, de la venta más reciente.
--    Nada más: ni fecha, ni cliente, ni costo, ni vendedor, ni IMEI, ni id de venta o de producto.
--
--  REGLAS (cada una la verifica tests/sql/canje.sql.test.mjs)
--    · USADO = stock.estado_producto no nulo y distinto de 'Nuevo / Sellado'.
--    · Cuenta toda venta que NO esté anulada (las abiertas con seña también: el precio ya está pactado), con la
--      línea no regalada (es_regalo = false) y precio_usd > 0.
--    · "Más reciente" = mayor fecha_venta; desempate por id de venta y luego por id de línea (determinista).
--    · TOPE DE ANTIGÜEDAD de 60 días: si la última venta válida es más vieja, la fila NO sale (y el asistente cae a
--      WhatsApp). Las ventas sin fecha o con fecha futura no cuentan.
--    · modelo y capacidad tienen que existir en catalogo_modelos_publico: el modelo, y la capacidad entre las
--      capacidades de ESE modelo. Así coinciden letra por letra con lo que ya consume la landing, y quedan afuera
--      nombres raros, "Otro", storage nulo o mal cargado. Sólo iPhone (esa vista es sólo de iPhone).
--    · COTA DE CORDURA: 50 a 5000 USD. Un precio mal tipeado (1 USD, 99999) no debe volverse una estimación
--      pública: esa venta se ignora. La vista usa entonces la última venta VÁLIDA anterior; si no hay ninguna, la fila
--      no sale y el asistente cae a WhatsApp.
--
--  LO QUE HAY QUE SABER
--    · Es el precio REAL de la última venta de los últimos 60 días. Un modelo que no se vende hace más de 60 días
--      desaparece de la vista (por diseño: un precio viejo se mostraría con la misma seguridad que uno de la semana).
--    · Una sola venta determina el número de cada modelo+capacidad. Es información comercial: es lo que Franco
--      decidió publicar. Quien consulte seguido puede notar CUÁNDO cambia el número y correlacionarlo con una venta
--      que conozca; no revela clientes, fechas, costos, IMEI ni ids.
--    · Usa los datos ACTUALES del producto: si se edita su estado o modelo, o se borra el producto, el resultado cambia
--      (una venta vieja puede dejar de contar).
--    · No lleva índices nuevos: la vista se reevalúa en cada consulta (joins sobre venta_items). Con unos miles de
--      ventas es instantáneo; si crece, medir con EXPLAIN (ANALYZE, BUFFERS) antes de agregar índices a ciegas.
--
--  SEGURIDAD: la vista es del dueño (security_invoker = false), que es lo que le deja leer `ventas`, `venta_items` y
--  `stock` (con RLS cerrada) SIN abrirle nada a anon: `ventas` y `venta_items` siguen devolviendo 0 filas con la
--  clave pública. Las funciones auxiliares que usa son las puras de catalogo_aux, ejecutables por anon (script 6).
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF to_regclass('public.catalogo_modelos_publico') IS NULL THEN
    RAISE EXCEPTION 'Falta catalogo_modelos_publico.sql (script 6): correrlo ANTES de este archivo';
  END IF;
  IF to_regclass('public.ventas') IS NULL OR to_regclass('public.venta_items') IS NULL OR to_regclass('public.stock') IS NULL THEN
    RAISE EXCEPTION 'Faltan las tablas ventas, venta_items o stock';
  END IF;
  -- La vista corre con los permisos de QUIEN LA CREA: tiene que poder leer tablas con RLS.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Correr este archivo con el rol postgres (SQL Editor de Supabase): % no saltea RLS', current_user;
  END IF;
END $$;

-- DROP y no CREATE OR REPLACE: reemplazar una vista conserva su DUEÑO y sus PERMISOS anteriores, y esta vista
-- corre con los permisos de su dueño. Recreándola, el dueño es siempre quien corre este archivo (postgres, verificado
-- arriba) y los permisos arrancan limpios. Nada depende de ella, así que borrarla es seguro.
DROP VIEW IF EXISTS public.canje_ultimo_precio_publico;
CREATE VIEW public.canje_ultimo_precio_publico
WITH (security_invoker = false) AS
SELECT DISTINCT ON (s.modelo, s.storage)
       s.modelo,
       s.storage,
       round(vi.precio_usd)::int AS precio_usd
  FROM public.venta_items vi
  JOIN public.ventas v ON v.id = vi.venta_id
  JOIN public.stock  s ON s.id = vi.stock_id
  JOIN public.catalogo_modelos_publico c
    ON c.modelo = s.modelo AND s.storage = ANY (c.capacidades)
 WHERE lower(COALESCE(s.categoria, '')) = 'iphone'
   AND s.estado_producto IS NOT NULL AND s.estado_producto <> 'Nuevo / Sellado'
   AND v.estado IS DISTINCT FROM 'anulada'
   AND COALESCE(vi.es_regalo, FALSE) = FALSE
   AND vi.precio_usd BETWEEN 50 AND 5000
   -- TOPE DE ANTIGÜEDAD: 60 días (aprobado por el dueño, vía la sesión de Precios). Fuera del plazo la fila no sale y el
   -- asistente cae a WhatsApp. Excluye también las ventas SIN fecha. Para cambiar el plazo: el número de abajo.
   -- (CURRENT_DATE es la fecha del servidor, en UTC: en el borde del plazo puede correrse un día respecto de Argentina.)
   AND v.fecha_venta >= CURRENT_DATE - 60
   -- Una fecha FUTURA (mal tipeada) no puede ser "la más reciente" y tapar a las ventas reales. Se tolera hasta MAÑANA
   -- (+1): el servidor está en UTC y entre las 21:00 y la medianoche argentina ya es el día siguiente. Más allá, no cuenta.
   AND v.fecha_venta <= CURRENT_DATE + 1
 ORDER BY s.modelo, s.storage, v.fecha_venta DESC NULLS LAST, v.id DESC, vi.id DESC;

-- Permisos EXACTOS: sólo lectura para los dos roles de la API y nada para nadie más (Supabase da todo por defecto a
-- anon y authenticated sobre objetos nuevos).
REVOKE ALL ON public.canje_ultimo_precio_publico FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.canje_ultimo_precio_publico TO anon, authenticated;

COMMIT;

-- ============================================================================
--  VERIFICACIÓN (después de correr; con la clave pública)
--    GET …/rest/v1/canje_ultimo_precio_publico?select=*&order=modelo,storage
--      → columnas EXACTAMENTE: modelo, storage, precio_usd (enteros entre 50 y 5000).
--    Y que lo cerrado siga cerrado (las tres tienen que devolver [] o 401):
--      …/rest/v1/ventas?select=*&limit=1   …/rest/v1/venta_items?select=*&limit=1   …/rest/v1/stock?select=*&limit=1
--    En el SQL Editor, dueño y permisos de la vista (dueño = postgres; permisos = sólo SELECT para anon y authenticated):
--      SELECT c.relowner::regrole AS dueno, c.relacl FROM pg_class c WHERE c.oid = 'public.canje_ultimo_precio_publico'::regclass;
-- ============================================================================
