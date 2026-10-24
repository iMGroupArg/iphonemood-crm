-- ============================================================================
--  meli_agrupar_stock.sql  (script 19) — MISMO PRODUCTO, DISTINTO COSTO: se vincula como uno solo
--
--  PEDIDO (Franco, 2026-10-10): artículos con el mismo nombre cargados en filas distintas de Stock (con costo
--  distinto) tienen que poder vincularse como UN solo artículo en Mercado Libre. Decisiones:
--    1. La unidad sale de la fila MÁS VIEJA hacia la más nueva (FIFO, por stock.creado_en).
--    2. Stock queda en filas separadas; el margen NO se mezcla: cada unidad vendida lleva el costo de SU fila.
--
--  QUÉ HACE
--    · meli__nombre_norm(texto): nombre en minúsculas, sin tildes y con espacios colapsados (para agrupar).
--    · meli__repartir_fifo(orden): para cada ítem vinculado, reparte la cantidad entre las filas del mismo
--      producto (mismo nombre normalizado y misma categoría; sin IMEI, sin "a pedido", disponibles), de la
--      más vieja a la más nueva, y deja UNA LÍNEA POR FILA CONSUMIDA en meli_orden_items. Descontar, reponer,
--      revertir y la venta (que toma el costo de cada fila) siguen trabajando por stock_id, sin cambios.
--    · meli_ingresar_orden: SÓLO cambia cómo compara los ítems cuando Mercado Libre vuelve a informar una orden ya procesada
--      (ahora por TOTALES por publicación: una orden repartida tiene más líneas que el aviso y se veía "distinta"). Se
--      reescribe a partir de la función que está en la base y, si su texto no es el esperado, frena sin tocar nada.
--    · meli__descontar_core: la misma de siempre (copia de la del script 7) + una llamada al reparto, bajo el
--      bloqueo de la orden y antes del chequeo de faltante.
--
--  REQUISITOS: scripts 3 y 7 corridos. Idempotente. ⚠ NO volver a correr el script 7 DESPUÉS de este: el 7
--  trae la versión anterior de meli__descontar_core y deshace el reparto (si hace falta, correr el 19 de nuevo).
-- ============================================================================

DO $$
BEGIN
  IF to_regprocedure('public.meli__descontar_core(bigint)') IS NULL
     OR to_regprocedure('public.meli__revalidar_orden(bigint)') IS NULL THEN
    RAISE EXCEPTION 'Faltan los scripts 3 y 7 (Mercado Libre y vincular publicaciones). Correrlos antes.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'stock' AND column_name = 'creado_en') THEN
    RAISE EXCEPTION 'stock no tiene la columna creado_en: no se puede saber cuál carga es la más vieja.';
  END IF;
END $$;


-- ─── 1 · Nombre normalizado ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.meli__nombre_norm(p_nombre TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT btrim(regexp_replace(
           translate(lower(COALESCE(p_nombre, '')), 'áàäâãéèëêíìïîóòöôõúùüûñç', 'aaaaaeeeeiiiiooooouuuunc'),
           '\s+', ' ', 'g'))
$$;


-- ─── 2 · Reparto FIFO de una orden ──────────────────────────────────────────
-- Interna (la llama meli__descontar_core, que ya tiene la orden bloqueada). PRIMERO bloquea, en UN solo orden global
-- (por id), TODAS las filas de stock que la orden va a tocar: las vinculadas y las de su mismo producto. Así dos órdenes
-- que comparten un producto se ESPERAN en vez de repartir sobre datos que la otra está por cambiar (sin esto, la segunda
-- podía ver "stock insuficiente" aunque entre todas las cargas alcanzara) y no hay ciclos posibles. El bloqueo es FOR NO KEY
-- UPDATE (el mismo que toma un UPDATE de cantidad): es COMPATIBLE con el KEY SHARE que dejan las claves foráneas al cambiar
-- el stock_id de un ítem (revalidación del script 7), así que no puede cruzarse con ella. Recién con las filas bloqueadas se
-- leen las cantidades y se reparte. El descuento posterior (por stock_id) pide las mismas filas, en el mismo orden.
CREATE OR REPLACE FUNCTION public.meli__repartir_fifo(p_orden_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  it       RECORD;
  rep      RECORD;
  g        RECORD;
  v_usado  JSONB := '{}'::JSONB;      -- stock_id -> unidades ya asignadas en ESTA orden (dos ítems pueden compartir producto)
  v_ids    UUID[];
  v_cants  INTEGER[];
  v_resta  INTEGER;
  v_take   INTEGER;
  k        INTEGER;
  v_todas  UUID[];
BEGIN
  -- Paso 1: toda fila que la orden toca (las vinculadas, SIEMPRE) más las del mismo producto de cada una, bloqueadas en orden de id.
  -- Una fila vinculada reservada, en reparación o dada de baja, "a pedido", con IMEI o sin nombre no se agrupa: va sola. Una
  -- "vendido" (agotada: un descuento anterior la dejó en 0) SÍ: es justamente la que hay que reemplazar por otra carga.
  SELECT COALESCE(array_agg(DISTINCT x.id), ARRAY[]::UUID[]) INTO v_todas
    FROM (
      SELECT i.stock_id AS id
        FROM public.meli_orden_items i
       WHERE i.orden_id = p_orden_id AND i.stock_id IS NOT NULL
      UNION
      SELECT s2.id
        FROM public.meli_orden_items i
        JOIN public.stock r ON r.id = i.stock_id
        JOIN public.stock s2
          ON public.meli__nombre_norm(s2.nombre) = public.meli__nombre_norm(r.nombre)
         AND s2.categoria IS NOT DISTINCT FROM r.categoria
         AND NOT COALESCE(s2.a_pedido, FALSE)
         AND COALESCE(array_length(s2.imeis, 1), 0) = 0
         AND COALESCE(s2.estado_inventario, 'disponible') = 'disponible'
       WHERE i.orden_id = p_orden_id AND i.cantidad > 0
         AND NOT COALESCE(r.a_pedido, FALSE) AND COALESCE(array_length(r.imeis, 1), 0) = 0
         AND COALESCE(r.estado_inventario, 'disponible') IN ('disponible', 'vendido')
         AND public.meli__nombre_norm(r.nombre) <> ''
    ) x;
  IF array_length(v_todas, 1) > 1 THEN
    PERFORM 1 FROM public.stock WHERE id = ANY(v_todas) ORDER BY id FOR NO KEY UPDATE;
  END IF;

  -- Paso 2: con las filas bloqueadas, se leen las cantidades vigentes y se reparte.
  FOR it IN
    SELECT * FROM public.meli_orden_items
     WHERE orden_id = p_orden_id AND stock_id IS NOT NULL AND cantidad > 0
     ORDER BY id
  LOOP
    SELECT s.id, s.nombre, s.categoria,
           (COALESCE(s.a_pedido, FALSE) OR COALESCE(array_length(s.imeis, 1), 0) > 0
            OR COALESCE(s.estado_inventario, 'disponible') NOT IN ('disponible', 'vendido')
            OR public.meli__nombre_norm(s.nombre) = '') AS solo
      INTO rep FROM public.stock s WHERE s.id = it.stock_id;

    -- Sin fila, "a pedido", con IMEI, no disponible o sin nombre: no se agrupa (cada caso tiene su propio tratamiento).
    IF NOT FOUND OR rep.solo THEN
      v_usado := jsonb_set(v_usado, ARRAY[it.stock_id::TEXT], to_jsonb(COALESCE((v_usado ->> it.stock_id::TEXT)::INT, 0) + it.cantidad));
      CONTINUE;
    END IF;

    v_ids := ARRAY[]::UUID[]; v_cants := ARRAY[]::INTEGER[];
    v_resta := it.cantidad;

    FOR g IN
      SELECT s.id,
             GREATEST(COALESCE(s.cantidad, 0) - COALESCE((v_usado ->> s.id::TEXT)::INT, 0), 0) AS disp
        FROM public.stock s
       WHERE public.meli__nombre_norm(s.nombre) = public.meli__nombre_norm(rep.nombre)
         AND s.categoria IS NOT DISTINCT FROM rep.categoria
         AND NOT COALESCE(s.a_pedido, FALSE)
         AND COALESCE(array_length(s.imeis, 1), 0) = 0
         AND COALESCE(s.estado_inventario, 'disponible') = 'disponible'
       ORDER BY s.creado_en ASC NULLS LAST, s.id
    LOOP
      IF v_resta > 0 AND g.disp > 0 THEN
        v_take := LEAST(g.disp, v_resta);
        v_ids := v_ids || g.id; v_cants := v_cants || v_take;
        v_resta := v_resta - v_take;
      END IF;
    END LOOP;

    -- El grupo entero no alcanza, o la asignación es la misma que ya tiene el ítem (una sola carga): queda como está
    -- (si falta, el chequeo de faltante lo marca). Si la fila vinculada está agotada, otra carga la reemplaza.
    IF v_resta > 0 OR array_length(v_ids, 1) IS NULL OR (array_length(v_ids, 1) = 1 AND v_ids[1] = it.stock_id) THEN
      v_usado := jsonb_set(v_usado, ARRAY[it.stock_id::TEXT], to_jsonb(COALESCE((v_usado ->> it.stock_id::TEXT)::INT, 0) + it.cantidad));
      CONTINUE;
    END IF;

    -- La primera fila reemplaza al ítem; cada fila siguiente es una línea nueva, con los mismos datos del aviso.
    UPDATE public.meli_orden_items SET stock_id = v_ids[1], cantidad = v_cants[1] WHERE id = it.id;
    FOR k IN 2 .. array_length(v_ids, 1) LOOP
      INSERT INTO public.meli_orden_items (orden_id, meli_item_id, meli_variacion_id, titulo, cantidad, precio_unitario, stock_id)
      VALUES (it.orden_id, it.meli_item_id, it.meli_variacion_id, it.titulo, v_cants[k], it.precio_unitario, v_ids[k]);
    END LOOP;
    FOR k IN 1 .. array_length(v_ids, 1) LOOP
      v_usado := jsonb_set(v_usado, ARRAY[v_ids[k]::TEXT], to_jsonb(COALESCE((v_usado ->> v_ids[k]::TEXT)::INT, 0) + v_cants[k]));
    END LOOP;
  END LOOP;
END;
$$;


-- ─── 3 · Descuento: la de siempre + el reparto ──────────────────────────────
CREATE OR REPLACE FUNCTION public.meli__descontar_core(p_orden_id BIGINT)
RETURNS TABLE (stock_id UUID, descontado INTEGER, queda INTEGER, agotado BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE r RECORD; v_queda INTEGER; v_ped BOOLEAN; v_ya BOOLEAN; v_faltante TEXT; v_con_imei TEXT; v_order_ref TEXT;
BEGIN
  -- BLOQUEO PRIMERO, antes de leer un solo ítem. Si se leyeran los ítems antes,
  -- la ingesta podría estar reemplazándolos justo mientras los medimos. Ingesta,
  -- descuento y reversión compiten todos por este mismo bloqueo.
  SELECT stock_descontado INTO v_ya FROM meli_ordenes WHERE id = p_orden_id FOR UPDATE;

  -- Orden ya descontada (un reintento, o el servidor y el CRM llegaron los dos): no se
  -- vuelve a mirar nada. Si siguiera, el chequeo de abajo vería el stock YA descontado
  -- (por ejemplo 1 → 0), lo tomaría por "insuficiente" y marcaría `revisar` una orden
  -- que está bien. Tampoco toca los motivos de revisión que ya tenga.
  IF v_ya IS TRUE THEN RETURN; END IF;

  -- PRIMER FRENO — filas con IMEI no se tocan desde acá.
  --
  -- Las unidades reales de una fila son GREATEST(array_length(imeis,1), cantidad),
  -- no `cantidad` sola. Si se descontara `cantidad` en una fila con IMEIs,
  -- quedaría en cero y marcada 'vendido' con el IMEI todavía adentro, y el panel
  -- de Stock se contradiría consigo mismo.
  --
  -- Tampoco se saca un IMEI del array: MELI no dice qué unidad física salió, y
  -- elegir una al azar sería inventar. Esas órdenes se marcan para que alguien
  -- elija la unidad a mano.
  SELECT string_agg(DISTINCT i.meli_item_id, ', ') INTO v_con_imei
    FROM meli_orden_items i
    JOIN stock s ON s.id = i.stock_id
   WHERE i.orden_id = p_orden_id
     AND COALESCE(array_length(s.imeis, 1), 0) > 0;

  IF v_con_imei IS NOT NULL THEN
    UPDATE meli_ordenes SET
      revisar = TRUE,
      motivo_revisar = COALESCE(motivo_revisar,
        'Producto con IMEI: elegir la unidad a mano (' || v_con_imei || ')'),
      actualizado_en = NOW()
     WHERE id = p_orden_id;
    RETURN;
  END IF;

  -- REPARTO FIFO entre cargas del mismo producto (script 19). Si el aviso está vinculado a una fila y hay otras
  -- filas del MISMO producto (mismo nombre y categoría, con distinto costo de carga), la unidad sale de la fila
  -- más vieja hacia la más nueva y la orden queda con una línea por fila consumida: cada unidad conserva el costo
  -- de la fila de la que salió. Con una sola fila no cambia nada. Si el grupo entero no alcanza, no toca nada
  -- y el chequeo de abajo marca la orden para revisar, como siempre.
  PERFORM public.meli__repartir_fifo(p_orden_id);

  -- SEGUNDO FRENO — ¿alcanza el stock de TODOS los ítems? Si falta uno, no se
  -- descuenta ninguno: media orden descontada es peor que ninguna.
  --
  -- Se SUMA por producto: dos avisos distintos de la misma orden pueden apuntar al MISMO
  -- stock, y comprobar cada ítem por separado dejaba pasar los dos aunque juntos no
  -- alcanzaran (el segundo descuento fallaba recién al ejecutarse, con una excepción en vez
  -- de un `revisar` claro). Acá se detecta antes y no se toca nada.
  SELECT string_agg(x.items, ', ') INTO v_faltante
    FROM (SELECT i.stock_id, sum(i.cantidad) AS necesita,
                 string_agg(DISTINCT i.meli_item_id, ', ') AS items
            FROM meli_orden_items i
           WHERE i.orden_id = p_orden_id AND i.stock_id IS NOT NULL
           GROUP BY i.stock_id) x
    JOIN stock s ON s.id = x.stock_id
   WHERE COALESCE(s.cantidad, 0) < x.necesita
     -- Una fila "a pedido" no tiene stock físico que se agote: nunca falta.
     AND NOT COALESCE(s.a_pedido, FALSE);

  IF v_faltante IS NOT NULL THEN
    UPDATE meli_ordenes SET
      revisar = TRUE,
      motivo_revisar = COALESCE(motivo_revisar, 'Stock insuficiente para: ' || v_faltante),
      actualizado_en = NOW()
     WHERE id = p_orden_id;
    RETURN;
  END IF;

  -- Reclamo único: sólo una llamada pasa de acá.
  UPDATE meli_ordenes SET stock_descontado = TRUE, actualizado_en = NOW()
   WHERE id = p_orden_id AND stock_descontado = FALSE AND revisar = FALSE
  RETURNING meli_order_id INTO v_order_ref;
  IF NOT FOUND THEN RETURN; END IF;

  -- ORDER BY stock_id: cada vuelta bloquea una fila de stock (el UPDATE). Dos órdenes
  -- que comparten productos y los recorren en orden distinto se bloquean mutuamente:
  -- A tiene el producto 1 y espera el 2, B tiene el 2 y espera el 1. Con un orden común
  -- (y el mismo en la reposición) un ciclo es imposible. Lo marcó la revisión de código.
  FOR r IN
    SELECT i.id AS iid, i.stock_id AS sid, i.cantidad AS cant, i.meli_item_id AS item
      FROM meli_orden_items i
     WHERE i.orden_id = p_orden_id AND i.stock_id IS NOT NULL
     ORDER BY i.stock_id, i.meli_item_id
  LOOP
    -- "A pedido" (se lee ACÁ, ya bajo el bloqueo de la fila, no antes): no toca la
    -- cantidad ni el estado, y el movimiento igual queda. Si la bandera cambió desde
    -- el chequeo de arriba y ahora falta stock, la condición del WHERE no se cumple y
    -- salta la excepción de abajo (se deshace todo, como cualquier carrera perdida).
    UPDATE stock s
       SET cantidad = CASE WHEN COALESCE(s.a_pedido, FALSE) THEN s.cantidad
                           ELSE s.cantidad - r.cant END,
           estado_inventario = CASE WHEN COALESCE(s.a_pedido, FALSE) THEN s.estado_inventario
                                    WHEN s.cantidad - r.cant <= 0 THEN 'vendido'
                                    ELSE s.estado_inventario END
     WHERE s.id = r.sid
       AND (COALESCE(s.a_pedido, FALSE) OR COALESCE(s.cantidad, 0) >= r.cant)
    RETURNING s.cantidad, COALESCE(s.a_pedido, FALSE) INTO v_queda, v_ped;

    -- Carrera perdida: entre el chequeo y el descuento alguien vendió en el
    -- local. Se levanta excepción a propósito: la función corre en una sola
    -- transacción, así que esto deshace TAMBIÉN el reclamo de más arriba y la
    -- orden queda lista para reintentar, sin descuentos a medias.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'stock insuficiente al descontar (item %, fila %)', r.item, r.sid;
    END IF;

    -- El rastro va en la MISMA transacción que el descuento. Si se dejara para
    -- el navegador, un fallo del cliente dejaría stock descontado sin ninguna
    -- explicación en el historial del producto.
    INSERT INTO stock_movimientos
      (stock_id, tipo, detalle, cantidad_antes, cantidad_despues, usuario_nombre, datos)
    VALUES (
      r.sid, 'meli',
      'Venta de Mercado Libre (orden ' || COALESCE(v_order_ref, '?') || ')',
      CASE WHEN v_ped THEN COALESCE(v_queda, 0) ELSE v_queda + r.cant END,
      COALESCE(v_queda, 0), 'Mercado Libre',
      jsonb_build_object('meli_order_id', v_order_ref, 'meli_item_id', r.item,
                         'cantidad', r.cant, 'a_pedido', v_ped));

    -- Lo que se sacó de verdad queda en el ítem: es lo que va a devolver meli_reponer_stock.
    UPDATE meli_orden_items SET descontado_cantidad = CASE WHEN v_ped THEN 0 ELSE r.cant END
     WHERE id = r.iid;

    -- A pedido: `descontado` es 0 (no se sacó nada) y nunca figura agotado.
    stock_id := r.sid;
    descontado := CASE WHEN v_ped THEN 0 ELSE r.cant END;
    queda := COALESCE(v_queda, 0);
    agotado := (NOT v_ped) AND (v_queda <= 0);
    RETURN NEXT;
  END LOOP;
END;
$$;


-- ─── 4 · Reingesta de una orden ya repartida ───────────────────────────────
-- Cuando Mercado Libre vuelve a informar una orden ya procesada, meli_ingresar_orden compara los ítems que llegan con los
-- guardados, línea por línea. Una orden repartida entre cargas tiene MÁS líneas que el aviso original (la misma publicación
-- en dos líneas de 2 y 1), así que el mismo aviso parecía "ítems distintos" y la orden quedaba en Revisar sin que nada
-- hubiera cambiado. Se cambia SÓLO esa comparación: ahora se comparan los TOTALES por publicación y variación. Se reescribe
-- la función que está en la base (pg_get_functiondef), no una copia: si su texto no es el esperado, frena sin tocar nada.
DO $parche$
DECLARE
  v_def   TEXT;
  v_ini   INTEGER;
  v_fin   INTEGER;
  v_nuevo TEXT := $blk$    -- (script 19: totales por publicación) una orden repartida entre cargas tiene más líneas que el aviso
    IF EXISTS (
         SELECT it->>'meli_item_id', COALESCE(it->>'meli_variacion_id',''),
                sum(GREATEST(COALESCE((it->>'cantidad')::INT,0),0))::BIGINT
           FROM jsonb_array_elements(p_items) AS it GROUP BY 1, 2
         EXCEPT
         SELECT meli_item_id, COALESCE(meli_variacion_id,''), sum(cantidad)::BIGINT
           FROM meli_orden_items WHERE orden_id = v_id GROUP BY 1, 2)
       OR EXISTS (
         SELECT meli_item_id, COALESCE(meli_variacion_id,''), sum(cantidad)::BIGINT
           FROM meli_orden_items WHERE orden_id = v_id GROUP BY 1, 2
         EXCEPT
         SELECT it->>'meli_item_id', COALESCE(it->>'meli_variacion_id',''),
                sum(GREATEST(COALESCE((it->>'cantidad')::INT,0),0))::BIGINT
           FROM jsonb_array_elements(p_items) AS it GROUP BY 1, 2)
$blk$;
BEGIN
  v_def := pg_get_functiondef('public.meli_ingresar_orden(text,bigint,uuid,jsonb,jsonb)'::regprocedure);
  IF position('script 19: totales por publicación' IN v_def) > 0 THEN RETURN; END IF;   -- ya aplicado
  v_ini := position(E'    IF EXISTS (\n         SELECT it->>''meli_item_id''' IN v_def);
  v_fin := position(E'    THEN\n      UPDATE meli_ordenes SET revisar = TRUE,' IN v_def);
  IF v_ini = 0 OR v_fin <= v_ini THEN
    RAISE EXCEPTION 'meli_ingresar_orden no tiene el texto esperado: no se modificó nada. Avisar antes de seguir.';
  END IF;
  EXECUTE substr(v_def, 1, v_ini - 1) || v_nuevo || substr(v_def, v_fin);
END
$parche$;


-- ─── 5 · Permisos ───────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.meli__nombre_norm(TEXT)    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.meli__repartir_fifo(BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.meli__descontar_core(BIGINT) FROM PUBLIC, anon, authenticated;

-- Verificación
SELECT 'meli__repartir_fifo'  AS objeto, to_regprocedure('public.meli__repartir_fifo(bigint)') IS NOT NULL AS ok
UNION ALL SELECT 'ingesta compara totales', position('script 19: totales por publicación' IN pg_get_functiondef(to_regprocedure('public.meli_ingresar_orden(text,bigint,uuid,jsonb,jsonb)'))) > 0
UNION ALL SELECT 'descontar_core llama al reparto',
         position('meli__repartir_fifo' IN pg_get_functiondef(to_regprocedure('public.meli__descontar_core(bigint)'))) > 0;
