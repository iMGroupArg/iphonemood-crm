-- 0_controles_previos.sql — SOLO LECTURA (SELECT). Correr cada consulta por separado
-- en el SQL Editor de Supabase ANTES del archivo 1.

-- (A) Cajas duplicadas. Tiene que dar 0 filas. Si da filas, NO seguir.
SELECT persona_id, bolsillo, count(*) AS filas, array_agg(saldo) AS saldos
  FROM public.cajas
 GROUP BY persona_id, bolsillo
HAVING count(*) > 1;

-- (B) CHECKs de ventas.estado. Sin filas = nada que cambiar. Si lista alguno que no
--     mencione 'anulada', avisar antes del primer "Revertir".
SELECT conname, pg_get_constraintdef(oid) AS definicion
  FROM pg_constraint
 WHERE conrelid = 'public.ventas'::regclass AND contype = 'c';

-- (C) Tipos. Todo uuid, salvo ventas.id y venta_items.venta_id que son bigint.
select table_name, column_name, data_type from information_schema.columns
 where table_schema='public' and (table_name,column_name) in (
  ('stock','id'),('personas','id'),('cajas','persona_id'),('stock_movimientos','stock_id'),
  ('venta_items','stock_id'),('caja_ledger','persona_id'),('venta_pagos','persona_id'),
  ('ventas','id'),('venta_items','venta_id'));

-- (D) Columnas NOT NULL sin default. Solo deben aparecer columnas de esta lista:
--  ventas(cliente,estado,tipo_venta,fecha_venta,meli_orden_id,meli_cotizacion)
--  venta_items(venta_id,stock_id,imei,nombre,costo_usd,precio_usd,es_regalo)
--  venta_pagos(venta_id,persona_id,bolsillo,monto,es_tarjeta,diferencial_ars,cotizacion_diferencial)
--  cajas(persona_id,bolsillo,saldo)
--  caja_ledger(persona_id,persona,bolsillo,delta,saldo_post,tipo,referencia,descripcion,creado_por)
--  stock_movimientos(stock_id,tipo,detalle,cantidad_antes,cantidad_despues,usuario_nombre,datos)
-- Si aparece otra, pegame el resultado antes de seguir.
select table_name, column_name from information_schema.columns
 where table_schema='public'
   and table_name in ('ventas','venta_items','venta_pagos','cajas','caja_ledger','stock_movimientos')
   and is_nullable='NO' and column_default is null and column_name<>'id'
 order by 1,2;
