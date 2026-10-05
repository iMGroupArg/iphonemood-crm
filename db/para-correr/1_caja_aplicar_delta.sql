-- ============================================================================
--  CAJAS · FASE 2: movimientos ATÓMICOS (saldo = saldo + delta + asiento)
--
--  PENDIENTE DE CORRER. Pegar entero en Supabase → SQL Editor → Run.
--  Es seguro correrlo dos veces (todo es IF NOT EXISTS / CREATE OR REPLACE).
--  Va todo en UNA transacción: o queda entero o no queda nada, y nunca hay un
--  momento en que las funciones existan con permisos de más.
--
--  EL PROBLEMA QUE RESUELVE
--  Hasta hoy el navegador hace "leer saldo → sumar en JavaScript → escribir el
--  saldo nuevo". Si hay dos pestañas (o dos personas) tocando la misma caja, la
--  que escribe última pisa a la otra y esa plata desaparece en silencio.
--  Además el saldo y el asiento del libro eran dos escrituras separadas, y un
--  traspaso entre dos cajas eran dos pedidos sueltos: si el segundo fallaba, la
--  plata quedaba debitada y nunca acreditada.
--
--  LA SOLUCIÓN
--  Tres funciones en la base. Cada una, en UNA transacción:
--     · caja_aplicar_delta  → mueve UNA caja: bloquea la fila, le SUMA el delta
--       (nunca escribe un saldo absoluto), anota el asiento y devuelve el saldo
--       real que quedó.
--     · caja_mover_atomico  → mueve DOS cajas a la vez (origen y destino) con
--       los dos asientos. Si cualquiera de las dos patas falla, no se mueve nada.
--     · caja_resolver_clave → CIERRA una duda. Si el navegador no recibió la
--       respuesta de un movimiento (se cortó la red), no sabe si se aplicó. Esta
--       función lo averigua por su clave: si se aplicó, lo informa; si NO se
--       aplicó, lo CANCELA de forma definitiva, de modo que aunque ese pedido
--       viejo llegara tarde, la base ya no lo acepta. Así "no se aplicó" nunca
--       queda como una suposición.
--  Dos movimientos simultáneos sobre la misma caja se hacen en fila y los dos
--  cuentan.
--
--  IDEMPOTENCIA (respuesta perdida)
--  Cada movimiento viaja con una `clave` única. Si la respuesta se pierde por
--  la red y el navegador reintenta con la MISMA clave, la base no lo aplica de
--  nuevo: devuelve el resultado de la primera vez. Si alguien reutiliza una
--  clave con otros datos (otra caja u otro monto), la base lo rechaza.
--
--  PERMISOS
--  En Postgres toda función nueva nace con EXECUTE para PUBLIC, y anon /
--  authenticated lo heredan. Por eso se revoca de PUBLIC, anon y authenticated
--  (revocar solo de los dos últimos NO sirve) y recién después se da permiso a
--  `authenticated` en las funciones públicas, que además verifican
--  is_authorized_user() adentro. Las internas (_caja_*) no tienen permiso para
--  nadie: solo las llaman otras funciones SECURITY DEFINER del proyecto (por
--  ejemplo las de Mercado Libre).
--
--  ENDURECIMIENTO
--  Las funciones SECURITY DEFINER corren con los permisos del dueño. Por eso:
--  todas las tablas van con el esquema explícito (public.cajas…), y el
--  search_path lleva pg_temp EXPLÍCITAMENTE AL FINAL, para que nadie pueda
--  "tapar" una tabla con una temporal del mismo nombre.
-- ============================================================================

BEGIN;

-- ─── 0 · Chequeo previo: ¿hay cajas duplicadas? ──────────────────────────────
-- Las funciones asumen UNA fila por (persona, bolsillo). Si hubiera duplicadas,
-- un UPDATE tocaría varias filas a la vez y duplicaría el movimiento. Se frena
-- acá con un mensaje claro, antes de crear nada (y se deshace todo).
DO $$
DECLARE v_dup INTEGER;
BEGIN
  SELECT count(*) INTO v_dup FROM (
    SELECT 1 FROM public.cajas GROUP BY persona_id, bolsillo HAVING count(*) > 1
  ) d;
  IF v_dup > 0 THEN
    RAISE EXCEPTION
      'Hay % cajas duplicadas (misma persona y bolsillo). Resolverlas antes de seguir: select persona_id, bolsillo, count(*) from cajas group by 1,2 having count(*) > 1', v_dup;
  END IF;
END $$;

-- Mismo nombre de índice que usa el esquema de Mercado Libre, para que sean
-- el mismo índice y no dos.
CREATE UNIQUE INDEX IF NOT EXISTS cajas_persona_bolsillo_unica
  ON public.cajas (persona_id, bolsillo);


-- ─── 1 · Clave de idempotencia en el libro ───────────────────────────────────
ALTER TABLE public.caja_ledger ADD COLUMN IF NOT EXISTS clave TEXT;

-- Único solo cuando hay clave: los asientos viejos (sin clave) no se tocan.
CREATE UNIQUE INDEX IF NOT EXISTS caja_ledger_clave_unica
  ON public.caja_ledger (clave) WHERE clave IS NOT NULL;


-- ─── 2 · Una caja: la función interna (sin permisos para nadie) ──────────────
--
--  Orden de las operaciones (importa):
--     a) se RESERVA la fila del libro (con la clave, si hay): si la clave ya
--        existía, nada de lo de abajo se ejecuta y se devuelve lo de la primera
--        vez. Con dos pedidos simultáneos de la misma clave, el segundo espera
--        acá a que el primero termine y recién ahí ve que ya está.
--     b) se suma el delta a la caja (fila bloqueada hasta el final),
--     c) se completa el saldo_post del asiento.
--  Si cualquier paso falla se deshace TODO, la reserva incluida.
CREATE OR REPLACE FUNCTION public._caja_aplicar_delta(
  p_persona_id  UUID,
  p_bolsillo    TEXT,
  p_delta       NUMERIC,
  p_tipo        TEXT,
  p_referencia  TEXT,
  p_descripcion TEXT,
  p_creado_por  TEXT,
  p_clave       TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_delta     NUMERIC := round(p_delta, 2);   -- el libro guarda centavos
  v_saldo     NUMERIC;
  v_filas     INTEGER;
  v_nombre    TEXT;
  v_asiento   BIGINT;
  v_previo    RECORD;
BEGIN
  IF p_persona_id IS NULL OR COALESCE(btrim(p_bolsillo), '') = '' THEN
    RAISE EXCEPTION 'Caja inválida: falta la persona o el bolsillo';
  END IF;
  IF v_delta IS NULL OR v_delta = 'NaN'::numeric OR v_delta = 0 THEN
    RAISE EXCEPTION 'Monto inválido: el movimiento tiene que ser distinto de cero';
  END IF;

  SELECT nombre INTO v_nombre FROM public.personas WHERE id = p_persona_id;
  IF v_nombre IS NULL THEN
    RAISE EXCEPTION 'No existe la persona %', p_persona_id;
  END IF;

  -- a) Reservar el asiento. saldo_post queda vacío hasta el paso c.
  IF p_clave IS NOT NULL THEN
    INSERT INTO public.caja_ledger
      (persona_id, persona, bolsillo, delta, saldo_post, tipo, referencia,
       descripcion, creado_por, clave)
    VALUES
      (p_persona_id, v_nombre, p_bolsillo, v_delta, NULL,
       COALESCE(p_tipo, 'otro'), p_referencia, p_descripcion,
       COALESCE(p_creado_por, auth.jwt() ->> 'email', 'Desconocido'), p_clave)
    ON CONFLICT (clave) WHERE clave IS NOT NULL DO NOTHING
    RETURNING id INTO v_asiento;

    IF v_asiento IS NULL THEN
      -- Esta clave ya se aplicó antes. Devolver lo de la primera vez, salvo que
      -- se la esté reutilizando para otra cosa.
      SELECT persona_id, bolsillo, delta, saldo_post, tipo INTO v_previo
        FROM public.caja_ledger WHERE clave = p_clave;
      -- La clave fue CANCELADA (ver caja_resolver_clave): el movimiento original
      -- comprobadamente nunca se aplicó. Se avisa con un texto propio para que quien
      -- llame pueda reintentar con una clave nueva sin riesgo de duplicar.
      IF v_previo.tipo = 'clave_cancelada' THEN
        RAISE EXCEPTION 'clave_cancelada: la clave % fue cancelada porque el movimiento no llegó a aplicarse', p_clave;
      END IF;
      IF v_previo.persona_id IS DISTINCT FROM p_persona_id
         OR v_previo.bolsillo <> p_bolsillo
         OR v_previo.delta <> v_delta THEN
        RAISE EXCEPTION 'La clave % ya se usó con otra caja u otro monto', p_clave;
      END IF;
      RETURN v_previo.saldo_post;
    END IF;
  ELSE
    INSERT INTO public.caja_ledger
      (persona_id, persona, bolsillo, delta, saldo_post, tipo, referencia,
       descripcion, creado_por)
    VALUES
      (p_persona_id, v_nombre, p_bolsillo, v_delta, NULL,
       COALESCE(p_tipo, 'otro'), p_referencia, p_descripcion,
       COALESCE(p_creado_por, auth.jwt() ->> 'email', 'Desconocido'))
    RETURNING id INTO v_asiento;
  END IF;

  -- b) Sumar el delta. La fila queda bloqueada hasta el final de la
  --    transacción: otro movimiento sobre la misma caja espera acá y después
  --    suma sobre el saldo ya actualizado. Nunca se escribe un saldo absoluto.
  UPDATE public.cajas
     SET saldo = saldo + v_delta, actualizado_en = now()
   WHERE persona_id = p_persona_id AND bolsillo = p_bolsillo
  RETURNING saldo INTO v_saldo;
  GET DIAGNOSTICS v_filas = ROW_COUNT;

  IF v_filas = 0 THEN
    RAISE EXCEPTION 'No existe la caja "%" de esa persona', p_bolsillo;
  ELSIF v_filas > 1 THEN
    RAISE EXCEPTION 'Caja duplicada ("%"): se frena para no mover plata dos veces', p_bolsillo;
  END IF;

  -- c) Completar el asiento con el saldo que quedó.
  UPDATE public.caja_ledger SET saldo_post = v_saldo WHERE id = v_asiento;

  RETURN v_saldo;
END;
$$;


-- ─── 3 · Una caja: la función pública (la que llama el CRM) ──────────────────
CREATE OR REPLACE FUNCTION public.caja_aplicar_delta(
  p_persona_id  UUID,
  p_bolsillo    TEXT,
  p_delta       NUMERIC,
  p_tipo        TEXT DEFAULT 'otro',
  p_referencia  TEXT DEFAULT NULL,
  p_descripcion TEXT DEFAULT NULL,
  p_creado_por  TEXT DEFAULT NULL,
  p_clave       TEXT DEFAULT NULL)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_authorized_user() THEN
    RAISE EXCEPTION 'no autorizado';
  END IF;
  RETURN public._caja_aplicar_delta(
    p_persona_id, p_bolsillo, p_delta, p_tipo, p_referencia,
    p_descripcion, p_creado_por, p_clave);
END;
$$;


-- ─── 4 · DOS cajas: traspaso atómico ─────────────────────────────────────────
--
--  Mueve plata de una caja a otra (con montos distintos si hay cambio de
--  moneda, como en Cueva) en UNA transacción: o salen y entran las dos patas, o
--  no pasa nada. Antes eran dos pedidos sueltos y, si el segundo fallaba, la
--  plata quedaba debitada y nunca acreditada.
--
--  Las dos filas se bloquean en un orden fijo (persona, bolsillo) para que dos
--  traspasos en sentido contrario (A→B y B→A) no se traben entre sí.
--  La clave es OBLIGATORIA: cada pata usa clave:o y clave:d, así reintentar el
--  traspaso entero con la misma clave no lo repite.
CREATE OR REPLACE FUNCTION public._caja_mover_atomico(
  p_origen_persona   UUID,
  p_origen_bolsillo  TEXT,
  p_destino_persona  UUID,
  p_destino_bolsillo TEXT,
  p_monto_origen     NUMERIC,
  p_monto_destino    NUMERIC,
  p_tipo             TEXT,
  p_referencia       TEXT,
  p_desc_origen      TEXT,
  p_desc_destino     TEXT,
  p_creado_por       TEXT,
  p_clave            TEXT)
RETURNS TABLE (saldo_origen NUMERIC, saldo_destino NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mo NUMERIC := round(p_monto_origen, 2);
  v_md NUMERIC := round(p_monto_destino, 2);
BEGIN
  IF COALESCE(btrim(p_clave), '') = '' THEN
    RAISE EXCEPTION 'El traspaso necesita una clave de operación';
  END IF;
  IF v_mo IS NULL OR v_md IS NULL OR v_mo = 'NaN'::numeric OR v_md = 'NaN'::numeric
     OR v_mo <= 0 OR v_md <= 0 THEN
    RAISE EXCEPTION 'Montos inválidos: origen y destino tienen que ser mayores que cero';
  END IF;
  IF p_origen_persona IS NOT DISTINCT FROM p_destino_persona
     AND p_origen_bolsillo = p_destino_bolsillo THEN
    RAISE EXCEPTION 'El origen y el destino son la misma caja';
  END IF;

  -- Bloqueo en orden fijo (evita el abrazo mortal entre traspasos opuestos).
  PERFORM 1 FROM public.cajas
   WHERE (persona_id, bolsillo) IN ((p_origen_persona, p_origen_bolsillo),
                                    (p_destino_persona, p_destino_bolsillo))
   ORDER BY persona_id, bolsillo
   FOR UPDATE;

  saldo_origen  := public._caja_aplicar_delta(
    p_origen_persona,  p_origen_bolsillo,  -v_mo, p_tipo, p_referencia,
    p_desc_origen,  p_creado_por, p_clave || ':o');
  saldo_destino := public._caja_aplicar_delta(
    p_destino_persona, p_destino_bolsillo, +v_md, p_tipo, p_referencia,
    p_desc_destino, p_creado_por, p_clave || ':d');
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.caja_mover_atomico(
  p_origen_persona   UUID,
  p_origen_bolsillo  TEXT,
  p_destino_persona  UUID,
  p_destino_bolsillo TEXT,
  p_monto_origen     NUMERIC,
  p_monto_destino    NUMERIC,
  p_clave            TEXT,
  p_tipo             TEXT DEFAULT 'movimiento',
  p_referencia       TEXT DEFAULT NULL,
  p_desc_origen      TEXT DEFAULT NULL,
  p_desc_destino     TEXT DEFAULT NULL,
  p_creado_por       TEXT DEFAULT NULL)
RETURNS TABLE (saldo_origen NUMERIC, saldo_destino NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_authorized_user() THEN
    RAISE EXCEPTION 'no autorizado';
  END IF;
  RETURN QUERY SELECT * FROM public._caja_mover_atomico(
    p_origen_persona, p_origen_bolsillo, p_destino_persona, p_destino_bolsillo,
    p_monto_origen, p_monto_destino, p_tipo, p_referencia,
    p_desc_origen, p_desc_destino, p_creado_por, p_clave);
END;
$$;



-- ─── 5 · Cerrar una duda: ¿se aplicó o no? ───────────────────────────────────
--
--  Devuelve 'aplicada' (con el saldo que quedó) o 'cancelada'. Si la clave no
--  existe se deja una marca 'clave_cancelada' en el libro con ESA clave: desde
--  ese momento un pedido atrasado que traiga la misma clave choca con la marca
--  y la base lo rechaza (mismo mecanismo que ya impide reutilizar una clave con
--  otro monto). Es la única forma de poder afirmar "no se aplicó" sin adivinar.
--  Para un traspaso se consulta la clave de la primera pata (clave || ':o'):
--  como las dos patas van en la misma transacción, o están las dos o ninguna.
--  La marca tiene delta 0 y no suma en ninguna caja.
CREATE OR REPLACE FUNCTION public._caja_resolver_clave(p_clave TEXT)
RETURNS TABLE (estado TEXT, saldo_post NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_fila RECORD;
BEGIN
  IF COALESCE(btrim(p_clave), '') = '' THEN
    RAISE EXCEPTION 'Falta la clave a resolver';
  END IF;

  INSERT INTO public.caja_ledger
    (persona, bolsillo, delta, saldo_post, tipo, descripcion, creado_por, clave)
  VALUES
    ('—', '—', 0, NULL, 'clave_cancelada',
     'Clave cancelada: el movimiento no llegó a aplicarse',
     COALESCE(auth.jwt() ->> 'email', 'Desconocido'), p_clave)
  ON CONFLICT (clave) WHERE clave IS NOT NULL DO NOTHING;

  SELECT l.tipo, l.saldo_post INTO v_fila
    FROM public.caja_ledger l WHERE l.clave = p_clave;

  estado     := CASE WHEN v_fila.tipo = 'clave_cancelada' THEN 'cancelada' ELSE 'aplicada' END;
  saldo_post := v_fila.saldo_post;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.caja_resolver_clave(p_clave TEXT)
RETURNS TABLE (estado TEXT, saldo_post NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_authorized_user() THEN
    RAISE EXCEPTION 'no autorizado';
  END IF;
  RETURN QUERY SELECT * FROM public._caja_resolver_clave(p_clave);
END;
$$;


-- ─── 6 · Permisos ────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._caja_aplicar_delta(UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._caja_mover_atomico(UUID, TEXT, UUID, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.caja_aplicar_delta(UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caja_aplicar_delta(UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT)
  TO authenticated;

REVOKE ALL ON FUNCTION public.caja_mover_atomico(UUID, TEXT, UUID, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caja_mover_atomico(UUID, TEXT, UUID, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
  TO authenticated;

REVOKE ALL ON FUNCTION public._caja_resolver_clave(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.caja_resolver_clave(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caja_resolver_clave(TEXT) TO authenticated;

COMMIT;


-- ============================================================================
--  VERIFICACIÓN (correr después, una por una)
-- ============================================================================

-- 1) Permisos: las internas (_caja_*) NO deben poder ejecutarse por anon ni
--    authenticated; las públicas solo por authenticated.
--      select p.proname, r.rolname, has_function_privilege(r.oid, p.oid, 'EXECUTE') as puede
--        from pg_proc p, pg_roles r
--       where p.proname in ('caja_aplicar_delta','_caja_aplicar_delta','caja_mover_atomico','_caja_mover_atomico','caja_resolver_clave','_caja_resolver_clave')
--         and r.rolname in ('anon','authenticated')
--       order by 1, 2;

-- 2) CONTROL DE CUADRE (el mismo de siempre): suma del libro = saldo real.
--    Tiene que seguir dando diferencia 0 después de usar las funciones.
--      select p.nombre as persona, c.bolsillo, c.saldo as saldo_real,
--             coalesce(l.suma,0) as suma_movimientos,
--             c.saldo - coalesce(l.suma,0) as diferencia
--        from cajas c join personas p on p.id = c.persona_id
--        left join (select persona, bolsillo, sum(delta) suma from caja_ledger group by 1,2) l
--          on l.persona = p.nombre and l.bolsillo = c.bolsillo
--       order by abs(c.saldo - coalesce(l.suma,0)) desc;

-- 3) Asientos reservados que quedaron sin saldo (no debería haber ninguno: una
--    reserva sin completar se deshace sola con la transacción):
--      select * from caja_ledger where saldo_post is null and tipo <> 'saldo_inicial';

-- 4) PRUEBA DE IDEMPOTENCIA (desde el SQL Editor no hay sesión de usuario, así
--    que se llama a la interna, que tiene permiso para el rol postgres). Reemplazar
--    el uuid por el de una persona real y un bolsillo que exista. Hacerlo y
--    DESHACER con el mismo monto en negativo; la segunda llamada con la misma
--    clave NO tiene que sumar de nuevo:
--      select public._caja_aplicar_delta('<uuid persona>', 'ARS cash', 1, 'otro', null, 'prueba', 'prueba', 'prueba-1');
--      select public._caja_aplicar_delta('<uuid persona>', 'ARS cash', 1, 'otro', null, 'prueba', 'prueba', 'prueba-1');  -- mismo saldo
--      select public._caja_aplicar_delta('<uuid persona>', 'ARS cash', -1, 'otro', null, 'deshacer prueba', 'prueba', 'prueba-2');

-- 5) PRUEBA DE CONCURRENCIA (la única que no se pudo automatizar: hacen falta dos
--    conexiones a la vez). Con una persona y un bolsillo de prueba, en DOS pestañas
--    del SQL Editor, casi al mismo tiempo:
--      PESTAÑA A (corre un transacción larga que sostiene el bloqueo ~15 segundos):
--        begin;
--        select public._caja_aplicar_delta('<uuid persona>', 'ARS cash', 1, 'otro', null, 'prueba A', 'prueba', 'conc-A');
--        select pg_sleep(15);
--        commit;
--      PESTAÑA B (arrancarla a los 2-3 segundos de la A):
--        select public._caja_aplicar_delta('<uuid persona>', 'ARS cash', 1, 'otro', null, 'prueba B', 'prueba', 'conc-B');
--    Resultado esperado: la B se queda ESPERANDO hasta que la A hace commit y recién
--    ahí contesta, con el saldo de antes MÁS 2 (no más 1). Después deshacer con dos
--    llamadas de -1 y otra clave cada una.
--    Segunda prueba, misma clave: repetir lo anterior pero con la MISMA clave en las
--    dos pestañas ('conc-A' en ambas): la B espera, y al contestar devuelve el mismo
--    saldo que la A (solo se aplicó una vez).
