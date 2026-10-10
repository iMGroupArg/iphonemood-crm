-- Encola UNA orden de Mercado Libre para que el worker la consulte y la registre (venta Lattafa Khamrah Dukhan).
-- Es lo mismo que haría el aviso de Mercado Libre si hubiera llegado: el worker consulta la orden con el token de
-- la cuenta y la guarda por la vía de siempre (idempotente). NO descuenta stock, NO toca cajas, NO procesa la venta:
-- eso sigue siendo el botón "Procesar" de la pantalla.
--
-- Correr en el SQL Editor de Supabase. Es seguro repetirlo: si ya hay un aviso pendiente para esa orden, no agrega otro.
-- Después, en el CRM → Mercado Libre → "Procesar pendientes" (o esperar un minuto con la pestaña abierta).

INSERT INTO public.meli_notificaciones (meli_user_id, topico, recurso, payload, estado)
SELECT c.meli_user_id, 'orders_v2', '/orders/2000018883051330',
       jsonb_build_object('topic', 'orders_v2', 'resource', '/orders/2000018883051330',
                          'user_id', c.meli_user_id, 'origen', 'manual (aviso que no llego)'),
       'pendiente'
  FROM public.meli_cuentas c
 WHERE c.activa
   AND (SELECT count(*) FROM public.meli_cuentas WHERE activa) = 1          -- solo si hay UNA cuenta activa
   AND NOT EXISTS (SELECT 1 FROM public.meli_notificaciones n
                    WHERE n.recurso = '/orders/2000018883051330' AND n.estado = 'pendiente');

-- Verificación: debe haber 1 fila pendiente (o ninguna, si la orden ya se procesó después).
SELECT id, meli_user_id, topico, recurso, estado, recibida_en
  FROM public.meli_notificaciones
 WHERE recurso = '/orders/2000018883051330'
 ORDER BY id DESC;
