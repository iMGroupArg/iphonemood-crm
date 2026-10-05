-- ============================================================================
--  stock_ajustar — descuento y reposición de stock POR DELTA, atómicos
--
--  PENDIENTE DE CORRER EN PRODUCCIÓN. Probada sobre Postgres real (pglite, UNA sola
--  conexión) con tests/sql/stock.sql.test.mjs, y revisada de forma estática (ver al
--  final). NO probada con dos sesiones simultáneas: los bloqueos y el candado de IMEI
--  dependen de eso. Pedido por Stock/Inventario; escrito por Deploy-infra.
--
--  QUÉ ARREGLA
--  El cliente del CRM descuenta stock leyendo la cantidad de SU copia en memoria,
--  restando uno y escribiendo el valor ABSOLUTO (`update({ cantidad })`). Si algo
--  tocó esa fila mientras tanto —otra pestaña, otro usuario, un descuento de
--  Mercado Libre— esa escritura lo borra: dos ventas, una unidad descontada.
--  Eran siete llamadas que escribían así, repartidas en tres módulos (ventas.js,
--  reparaciones.js y stock.js). Stock/Inventario ya migró TODAS a esta función
--  (commits fb37730 y b00619e): ya no queda ninguna escritura absoluta de stock en
--  ningún módulo. `separarUnidades` (stock.js), que primero se creyó que no migraba
--  porque no es un ajuste por delta, quedó resuelta: la ruta parcial descuenta por delta
--  el IMEI de la unidad realmente creada (antes descontaba por posición del lote, y si
--  fallaba la del medio descontaba el IMEI equivocado).
--  Esta función hace el descuento/reposición DENTRO de la base, bajo el bloqueo de
--  la fila, así que dos llamadas simultáneas se ordenan en vez de pisarse. Para
--  que sirva hay que cambiar esas llamadas del cliente a `stock_ajustar`: la
--  función sola no arregla nada.
--
--  QUÉ NO ARREGLA
--  `guardarProductoStock` manda la fila entera (con `cantidad` e `imeis`). Ahí el
--  valor absoluto es correcto cuando el usuario fija la cantidad a propósito, pero
--  si alguien tiene el drawer abierto cuando otro descuenta, guardar cualquier
--  campo repone la unidad. Eso necesita que el drawer no mande `cantidad` cuando
--  el usuario no la tocó. No lo resuelve esta función.
--
--  CONTRATO
--    supa.rpc('stock_ajustar', {
--      p_stock_id, p_delta, p_tipo, p_detalle,
--      p_imei, p_estado_destino                       // los dos últimos, opcionales
--    })  →  [{ cantidad, imeis, estado_inventario, unidades }]   (valores NUEVOS)
--
--    · p_delta < 0 descuenta, p_delta > 0 repone. Cero se rechaza.
--    · Con p_imei, p_delta tiene que ser -1 o +1 (un IMEI es una unidad):
--      descontar saca ese IMEI del arreglo; reponer lo agrega.
--    · Las UNIDADES de una fila son GREATEST(array_length(imeis,1), cantidad), no
--      `cantidad` sola. Si el control mirara sólo `cantidad`, una fila con IMEIs
--      quedaría en cero y 'vendido' con el IMEI todavía adentro.
--    · estado_inventario pasa a 'vendido' cuando las unidades quedan en 0, y a
--      'disponible' cuando se repone una fila que estaba 'vendido'. Misma sentencia.
--    · p_estado_destino (opcional) fija el estado en ESA misma sentencia, para que
--      "reponer y liberar una reserva" sea atómico en vez de dos escrituras con una
--      ventana en el medio. Valores permitidos: disponible, reservado, vendido,
--      en_reparacion ('eliminado' es un borrado lógico y no se fija desde acá). La
--      regla de coherencia es: 'vendido' ⇔ unidades en 0. Pedir 'vendido' con
--      unidades, o cualquier otro estado con 0 unidades, se rechaza en vez de
--      corregirlo en silencio. Esa equivalencia se exige al estado que se PIDE, no
--      es un invariante global de la tabla: sin p_estado_destino la función
--      conserva el estado actual (salvo los dos casos de arriba), así que una fila que
--      ya venía inconsistente —'vendido' con unidades, o estado NULL— sigue igual.
--      Un p_estado_destino vacío o de puros espacios se toma como "no se pidió": NO
--      da ESTADO_INVALIDO.
--      Uso previsto (Stock): al ANULAR una venta, por cada ítem con stockId, reponer
--      +1 y, si esa fila estaba 'reservado' por esa venta (venta_items.stock_id es el
--      vínculo), pasar p_estado_destino := 'disponible'. Esta función NO verifica que
--      la reserva fuera de esa venta: eso lo decide el cliente.
--    · FILAS "A PEDIDO" (stock.a_pedido = true; semántica cerrada con Stock). Sobre
--      una fila así, descontar y reponer NO tocan la cantidad: ni
--      STOCK_INSUFICIENTE ni negativos ni CANTIDAD_FUERA_DE_RANGO. SÍ dejan el
--      movimiento (cantidad_antes = cantidad_despues, y datos.a_pedido = true).
--      Nunca pasan a 'vendido': el estado se conserva (una fila a pedido en 0
--      unidades y 'disponible' es lo correcto, y la regla 'vendido' ⇔ 0 unidades no
--      se le aplica). Un p_estado_destino distinto de 'vendido' se respeta tal cual;
--      pedir 'vendido' da ESTADO_INCONSISTENTE. Con p_imei se rechaza
--      (A_PEDIDO_NO_ADMITE_IMEI): una fila a pedido no tiene unidades físicas. La
--      devolución trae `unidades` calculado como en las demás filas (no es stock real).
--      Reponer sobre una fila a pedido que estuviera 'vendido' (anómala) tampoco la
--      pasa a 'disponible': se conserva el estado, como pidió Stock.
--    · Deja el movimiento en stock_movimientos, en la misma transacción.
--    · UNA LLAMADA POR TRANSACCIÓN. Orden de bloqueos: candado global de IMEIs (sólo
--      al reponer un IMEI) y después la fila. Con una sola llamada no hay ciclo
--      posible. Si alguna vez se encadenan varias en una misma transacción (por
--      ejemplo desde otra función SQL), un descuento que ya tiene la fila A y una
--      reposición que toma el candado global y espera esa misma fila A pueden
--      trabarse en deadlock; Postgres aborta una de las dos. Una transacción
--      compuesta tiene que tomar el candado global ANTES de bloquear cualquier fila.
--    · Un arreglo de IMEIs con elementos NULL o vacíos se LIMPIA al leer: las
--      unidades que mostraba antes la fila pueden bajar por esa limpieza además
--      del delta, porque esos elementos contaban como unidades que no eran reales.
--    · Sólo para usuarios autorizados del CRM.
--
--  ERRORES — son excepciones, así que no se puede confundir un fallo con un éxito
--  vacío, y no se escribe NADA (la función es una sola transacción). En supabase-js
--  llegan como `error.message`:
--      STOCK_INEXISTENTE    el id no existe
--      STOCK_INSUFICIENTE   no alcanzan las unidades (el detalle trae `unidades=N`)
--      IMEI_NO_ESTA         se pidió descontar un IMEI que la fila no tiene
--      IMEI_REQUERIDO       la fila tiene IMEIs y se descontó sin decir cuál
--      IMEI_DELTA_UNO       con p_imei, el delta no es -1 ni +1
--      DELTA_INVALIDO       delta nulo, cero o fuera de ±1.000.000
--      CANTIDAD_FUERA_DE_RANGO   la suma superaría el máximo de un INTEGER
--      IMEIS_INVALIDOS      el arreglo de IMEIs es multidimensional
--      AISLAMIENTO_NO_SOPORTADO   se repuso un IMEI fuera de READ COMMITTED
--      ESTADO_INVALIDO     p_estado_destino no es uno de los permitidos
--      ESTADO_INCONSISTENTE  se pidió 'vendido' con unidades, o otro estado con 0
--                           (en una fila a pedido: se pidió 'vendido', sin más)
--      A_PEDIDO_NO_ADMITE_IMEI  se pasó p_imei sobre una fila a pedido
--      TIPO_REQUERIDO       falta el tipo del movimiento
--      no autorizado        el usuario no está en usuarios_autorizados
--    Un IMEI repetido lo rechaza el trigger stock_imei_unico (ya existente).
--
--  DECISIÓN QUE PUEDE RELAJARSE
--  IMEI_REQUERIDO: descontar SIN IMEI de una fila que tiene IMEIs es ambiguo
--  (¿cuál unidad salió?). State.descontarStock lo hacía igual y bajaba sólo la
--  cantidad, dejando el IMEI adentro: ése es el fantasma. Acá se rechaza. Si algún
--  flujo legítimo lo necesita, se cambia esa línea; no se hizo por defecto.
-- ============================================================================

BEGIN;

-- stock_movimientos.datos (JSONB): la crea db/migrations/20260708_stock_movimientos_datos.sql, que
-- NO está aplicada en producción (comprobado el 2026-10-05: la API responde "column
-- stock_movimientos.datos does not exist"). Estas funciones la escriben en cada movimiento, y
-- plpgsql no valida las columnas al crear la función sino al ejecutarla: sin esta línea el
-- script correría sin error y CADA descuento de stock fallaría. Idempotente.
ALTER TABLE public.stock_movimientos ADD COLUMN IF NOT EXISTS datos JSONB;

-- La versión de 5 parámetros (sin p_estado_destino), si alguien llegó a crearla. Dos
-- sobrecargas con valores por defecto no pueden convivir: una llamada que sirve para
-- las DOS firmas (por ejemplo sin p_estado_destino) es ambigua y PostgREST falla con
-- "could not choose the best candidate function". Si no existe, esto no hace nada.
-- No usa CASCADE a propósito: si algo dependiera de la firma vieja, aborta (y con él
-- toda la transacción) en vez de borrarlo en silencio.
DROP FUNCTION IF EXISTS public.stock_ajustar(UUID, INTEGER, TEXT, TEXT, TEXT);

-- La bandera "a pedido". La define stock_a_pedido.sql (junto con su CHECK y la vista
-- pública); se repite acá, idempotente, para que el orden de corrida no importe.
ALTER TABLE public.stock ADD COLUMN IF NOT EXISTS a_pedido BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION public.stock_ajustar(
  p_stock_id        UUID,
  p_delta           INTEGER,
  p_tipo            TEXT,
  p_detalle         TEXT,
  p_imei            TEXT DEFAULT NULL,   -- con DEFAULT van al FINAL: Postgres no admite un
  p_estado_destino  TEXT DEFAULT NULL    -- parámetro con default antes de uno sin default.
                                         -- Como el cliente llama por nombre, el orden no
                                         -- le afecta.
)
RETURNS TABLE (cantidad INTEGER, imeis TEXT[], estado_inventario TEXT, unidades INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
-- pg_temp va EXPLÍCITO y al final: con sólo `public`, Postgres busca igual primero en
-- pg_temp, y una tabla temporal llamada `stock` taparía a la real.
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
-- Las columnas de salida (cantidad, imeis, estado_inventario) se llaman igual que
-- las de la tabla `stock`. Además de calificar TODA referencia con el alias, esta
-- directiva resuelve cualquier choque a favor de la columna: es el error de
-- "column reference is ambiguous", que sólo explota al ejecutar.
DECLARE
  v_imei          TEXT := NULLIF(btrim(p_imei), '');
  v_destino       TEXT := NULLIF(btrim(p_estado_destino), '');
  v_cant          stock.cantidad%TYPE;
  v_imeis         stock.imeis%TYPE;
  v_estado        stock.estado_inventario%TYPE;
  v_a_pedido      BOOLEAN;
  v_unid_antes    INTEGER;
  v_cant_nueva    INTEGER;
  v_imeis_nuevos  stock.imeis%TYPE;
  v_estado_nuevo  TEXT;
  v_unid_nueva    INTEGER;
  v_usuario       TEXT;
BEGIN
  IF NOT public.is_authorized_user() THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501';
  END IF;
  -- Rango acotado del DELTA: abs(-2147483648) desborda INTEGER y fallaba con otro
  -- error antes de llegar a IMEI_DELTA_UNO. Esto acota el delta, pero NO evita que
  -- la SUMA desborde (cantidad=2147483647 y delta=+1): eso se controla aparte, más
  -- abajo, con CANTIDAD_FUERA_DE_RANGO. Un movimiento de stock real no se acerca.
  IF p_delta IS NULL OR p_delta = 0 OR p_delta NOT BETWEEN -1000000 AND 1000000 THEN
    RAISE EXCEPTION 'DELTA_INVALIDO';
  END IF;
  IF COALESCE(btrim(p_tipo), '') = '' THEN
    RAISE EXCEPTION 'TIPO_REQUERIDO';
  END IF;
  -- Lista cerrada. El cliente usa también 'eliminado', pero eso es un borrado lógico
  -- con otras consecuencias (sale del catálogo, del inventario y de los reportes) y
  -- no un ajuste de stock: no se puede fijar desde acá. Un estado nuevo se agrega acá.
  IF v_destino IS NOT NULL
     AND v_destino NOT IN ('disponible', 'reservado', 'vendido', 'en_reparacion') THEN
    RAISE EXCEPTION 'ESTADO_INVALIDO';
  END IF;
  IF v_imei IS NOT NULL AND p_delta NOT IN (-1, 1) THEN
    RAISE EXCEPTION 'IMEI_DELTA_UNO';
  END IF;

  -- Reponer un IMEI: se serializa con un candado global ANTES de tocar la fila.
  -- El trigger stock_imei_unico busca el IMEI en las OTRAS filas, pero una
  -- transacción no ve lo que otra todavía no confirmó: dos que repongan el mismo
  -- IMEI en productos distintos podían confirmar las dos. Con el candado, la
  -- segunda espera, y cuando sigue ya ve la primera confirmada y el trigger la
  -- rechaza. OJO: protege SÓLO a quienes entran por esta función; las escrituras
  -- directas a `stock` (guardarProductoStock, importaciones) siguen sin este
  -- candado. La solución completa requiere que TODAS las vías respeten global →
  -- fila antes del DML, o una tabla de unidades con UNIQUE(imei): no alcanza con
  -- agregar una línea al trigger. Ver la nota al final de este archivo. Orden de
  -- bloqueos: global primero, fila después, siempre.
  IF v_imei IS NOT NULL AND p_delta > 0 THEN
    -- La garantía exige READ COMMITTED: ahí, tras esperar el candado, la consulta del
    -- trigger vuelve a mirar los datos y ve la transacción anterior ya confirmada. En
    -- REPEATABLE READ esperar NO renueva el snapshot, y dos transacciones sobre filas
    -- distintas podían seguir sin verse. PostgREST usa READ COMMITTED; esto defiende
    -- la función frente a quien la llame por SQL con otro aislamiento.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'AISLAMIENTO_NO_SOPORTADO';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('stock_imei_unico'));
  END IF;

  -- Bloqueo de la fila ANTES de leer nada. Todo lo que sigue ve un estado estable:
  -- dos llamadas simultáneas se serializan acá.
  SELECT s.cantidad, s.imeis, s.estado_inventario, COALESCE(s.a_pedido, FALSE)
    INTO v_cant, v_imeis, v_estado, v_a_pedido
    FROM stock s
   WHERE s.id = p_stock_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'STOCK_INEXISTENTE';
  END IF;

  -- Una fila a pedido no tiene unidades físicas, así que no hay IMEI que mover. Va
  -- después del bloqueo de la fila (la bandera se lee ya estable).
  IF v_a_pedido AND v_imei IS NOT NULL THEN
    RAISE EXCEPTION 'A_PEDIDO_NO_ADMITE_IMEI';
  END IF;

  -- El arreglo tiene que ser unidimensional, y sus elementos NULL o vacíos NO son
  -- IMEIs: contarían como unidades fantasma (array_length los cuenta) y rompían la
  -- comparación `IMEI = ANY(arreglo)`, que con un NULL adentro da NULL y no FALSE.
  -- Se descartan al leer; el UPDATE de abajo escribe el arreglo ya limpio.
  IF array_ndims(v_imeis) > 1 THEN
    RAISE EXCEPTION 'IMEIS_INVALIDOS';
  END IF;
  v_imeis := array_remove(array_remove(v_imeis, NULL), '');

  v_unid_antes := GREATEST(COALESCE(array_length(v_imeis, 1), 0), COALESCE(v_cant, 0));

  -- La suma en BIGINT, y recién después se convierte: en INTEGER desbordaría con un
  -- error distinto del contrato ("integer out of range"). No deja cambios a medias
  -- (la transacción se revierte), pero tiene que fallar con un nombre propio.
  IF NOT v_a_pedido AND v_unid_antes::BIGINT + p_delta::BIGINT > 2147483647 THEN
    RAISE EXCEPTION 'CANTIDAD_FUERA_DE_RANGO';
  END IF;

  IF v_a_pedido THEN
    -- A PEDIDO: no se toca nada de lo físico. El movimiento igual queda registrado.
    v_cant_nueva   := v_cant;
    v_imeis_nuevos := v_imeis;
  ELSIF p_delta < 0 THEN
    -- DESCONTAR
    IF v_unid_antes + p_delta < 0 THEN
      RAISE EXCEPTION 'STOCK_INSUFICIENTE' USING DETAIL = 'unidades=' || v_unid_antes;
    END IF;

    IF v_imei IS NOT NULL THEN
      -- `IS NOT TRUE` y no `NOT (...)`: con un NULL en el arreglo la comparación daba
      -- NULL, la negación también, y el IF no entraba (se "descontaba" un IMEI que no
      -- estaba). Acá ya se limpiaron los NULL, pero esta forma no depende de eso.
      IF (v_imei = ANY (v_imeis)) IS NOT TRUE THEN
        RAISE EXCEPTION 'IMEI_NO_ESTA';
      END IF;
      v_imeis_nuevos := array_remove(v_imeis, v_imei);
    ELSE
      IF COALESCE(array_length(v_imeis, 1), 0) > 0 THEN
        RAISE EXCEPTION 'IMEI_REQUERIDO';
      END IF;
      v_imeis_nuevos := v_imeis;
    END IF;

    -- El delta se aplica sobre las UNIDADES, no sobre `cantidad`. Ya se verificó
    -- arriba que no queda negativa.
    v_cant_nueva := v_unid_antes + p_delta;
  ELSE
    -- REPONER
    IF v_imei IS NOT NULL THEN
      IF (v_imei = ANY (v_imeis)) IS TRUE THEN
        RAISE EXCEPTION 'IMEI duplicado: el IMEI % ya está en este producto', v_imei;
      END IF;
      v_imeis_nuevos := array_append(COALESCE(v_imeis, '{}'), v_imei);
    ELSE
      v_imeis_nuevos := v_imeis;
    END IF;
    -- Sobre las UNIDADES, no sobre `cantidad`: con cantidad=0 e imeis={A,B}, reponer
    -- una unidad sumando a `cantidad` daba cantidad=1 y las mismas 2 unidades: no se
    -- había repuesto nada, pero el movimiento decía que sí. Así `cantidad` queda
    -- siempre como el total, y cada llamada mueve las unidades EXACTAMENTE `delta`.
    v_cant_nueva := v_unid_antes + p_delta;
  END IF;

  v_unid_nueva := GREATEST(COALESCE(array_length(v_imeis_nuevos, 1), 0), v_cant_nueva);

  -- Coherencia del estado pedido: 'vendido' ⇔ unidades en 0. Se RECHAZA en vez de
  -- corregir en silencio: si un cliente pide 'disponible' y la fila queda en 0, el
  -- cliente tiene un error de lógica y tiene que enterarse, no recibir un 'vendido'
  -- que no pidió. Va ANTES del UPDATE, así que no deja nada escrito.
  IF v_destino IS NOT NULL AND v_a_pedido THEN
    -- A pedido: la regla 'vendido' ⇔ 0 unidades no rige (0 unidades y 'disponible' es
    -- lo normal), pero una fila a pedido nunca se vende del todo.
    IF v_destino = 'vendido' THEN
      RAISE EXCEPTION 'ESTADO_INCONSISTENTE'
        USING DETAIL = 'estado=vendido en una fila a pedido';
    END IF;
  ELSIF v_destino IS NOT NULL
     AND ((v_destino = 'vendido') <> (v_unid_nueva <= 0)) THEN
    RAISE EXCEPTION 'ESTADO_INCONSISTENTE'
      USING DETAIL = 'estado=' || v_destino || ' unidades=' || v_unid_nueva;
  END IF;

  v_estado_nuevo := CASE
    WHEN v_destino IS NOT NULL                 THEN v_destino     -- lo pidió el cliente, ya validado
    WHEN v_a_pedido                            THEN v_estado      -- a pedido: se conserva
    WHEN v_unid_nueva <= 0                     THEN 'vendido'
    WHEN p_delta > 0 AND v_estado = 'vendido'  THEN 'disponible'  -- sólo al REPONER
    ELSE v_estado
  END;

  UPDATE stock s
     SET cantidad          = v_cant_nueva,
         imeis             = v_imeis_nuevos,
         estado_inventario = v_estado_nuevo
   WHERE s.id = p_stock_id;

  -- El movimiento va en la MISMA transacción: no puede quedar stock cambiado sin
  -- su rastro, ni al revés. Cantidades en UNIDADES (lo que se ve como stock).
  v_usuario := COALESCE(
    NULLIF(auth.jwt() -> 'user_metadata' ->> 'full_name', ''),
    NULLIF(auth.jwt() -> 'user_metadata' ->> 'name', ''),
    NULLIF(auth.jwt() ->> 'email', ''),
    'Desconocido');

  INSERT INTO stock_movimientos
    (stock_id, tipo, detalle, cantidad_antes, cantidad_despues, usuario_nombre, datos)
  VALUES
    (p_stock_id, btrim(p_tipo), p_detalle, v_unid_antes, v_unid_nueva, v_usuario,
     jsonb_build_object('delta', p_delta, 'imei', v_imei,
                        'estado_antes', v_estado, 'estado_despues', v_estado_nuevo,
                        'a_pedido', v_a_pedido));

  RETURN QUERY SELECT v_cant_nueva::INTEGER, v_imeis_nuevos::TEXT[], v_estado_nuevo, v_unid_nueva;
END;
$$;

-- Postgres le da EXECUTE a PUBLIC por defecto, y anon/authenticated lo heredan de
-- ahí: revocar sólo de anon/authenticated no cierra nada. Hay que revocar de
-- PUBLIC. (La función igual se defiende con is_authorized_user(); esto es la
-- segunda cerradura.)
REVOKE EXECUTE ON FUNCTION public.stock_ajustar(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.stock_ajustar(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT) TO authenticated;

COMMIT;

-- ============================================================================
--  NOTA — la carrera de IMEI duplicado NO se cierra del todo acá
--
--  La revisión estática encontró (CRÍTICO) que el trigger `stock_imei_unico`
--  (db/migrations/20260806_blindaje_imei.sql) no resiste dos transacciones
--  simultáneas: busca el IMEI en las otras filas, pero no ve lo que otra todavía
--  no confirmó. Esta función se defiende tomando un candado global antes de
--  reponer un IMEI, pero sólo protege a quienes entran por ella.
--
--  Cerrarlo del todo NO es sólo agregar una línea al trigger. La revisión lo marcó:
--  un UPDATE directo bloquea su fila ANTES de entrar al trigger; si el trigger
--  entonces espera el candado global mientras una llamada a esta función lo tiene
--  y espera esa misma fila, hay deadlock. Para que sea correcto, TODAS las vías de
--  escritura de `imeis` tienen que respetar el mismo orden (candado global, luego
--  fila) ANTES del DML, o bien hay que cambiar el modelo: una tabla de unidades con
--  UNIQUE(imei), donde la base resuelve la unicidad sin candados ni triggers. Eso
--  último es lo sólido, y es un cambio de Stock sobre una migración ya aplicada.
--
--  ESTADO DE LA REVISIÓN: leída por Codex, estática, sin ejecución. Hallazgos que
--  esta versión corrige: reposición sin IMEI que no sumaba unidades, NULL dentro
--  del arreglo que dejaba descontar un IMEI inexistente, descuento que reactivaba
--  una fila 'vendido', desbordamiento de INTEGER, y search_path sin pg_temp.
-- ============================================================================
