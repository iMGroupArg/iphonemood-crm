-- ============================================================================
--  catalogo_modelos_publico — modelos, capacidades y colores DECLARADOS, para la landing
--
--  PENDIENTE DE CORRER. Probado sobre Postgres real (pglite) con
--  tests/sql/catalogo.sql.test.mjs, que además compara esta tabla contra
--  Stock.SPECS_POR_MODELO (src/modules/stock.js) y falla si difieren. Pedido por
--  Precios/landing (asistente de Plan Canje); escrito por Deploy-infra.
--
--  QUÉ EXPONE (a `anon`, de sólo lectura)
--    catalogo_modelos_publico(modelo, orden, capacidades, colores) — una fila por modelo,
--    sólo iPhone por ahora. Son valores DECLARADOS, no "oficiales". Nada de costos,
--    proveedores, IMEI, stock ni precios: ninguna de esas tablas se toca desde acá.
--      · orden        1 = la generación más NUEVA (iPhone 18 → 1, 17 → 2, …). Todos los
--                     modelos de una generación comparten el número: listar con
--                     ORDER BY orden, modelo (desempate determinista).
--      · capacidades  orden creciente por tamaño real (… 512GB, 1TB, 2TB).
--      CONTRATO DE LA LANDING (descarta la fila entera si falla): orden entero; modelo de 1 a 60
--      caracteres; capacidades y colores de hasta 30 elementos y 40 caracteres por elemento. La
--      vista los garantiza ella misma (aunque lo sumado desde el CRM se pase) y el test lo vigila.
--      · colores      SÓLO lo declarado: la lista del código + lo que Franco sumó a
--                     propósito desde el CRM (configuracion.catalogo_specs). NUNCA lo que
--                     aparece cargado en el stock (hay cargas erróneas). Sin "Otro", sin
--                     duplicados (sin distinguir mayúsculas; queda la primera grafía).
--                     `{}` es válido: iPhone 18 y 18 Plus no tienen color declarado.
--
--  DE DÓNDE SALEN LOS DECLARADOS
--  Viven en el código (SPECS_POR_MODELO), que la base no ve. Se SIEMBRAN acá, en
--  catalogo_modelos_base, y un test avisa si el código y esta tabla se separan. Para
--  agregar un modelo o un color al código: cambiar stock.js, correr
--  `node tests/sql/catalogo.sql.test.mjs` (dice qué filas faltan) y actualizar la siembra
--  de abajo. Lo que se suma desde el CRM (catalogo_specs) entra solo, sin tocar esto —
--  pero sólo para modelos que ya estén en la tabla base.
--
--  SEGURIDAD
--  · La tabla base queda CERRADA: RLS sin políticas y sin permisos para anon/authenticated.
--  · La vista es del dueño (security_invoker = false), que es lo que le permite leer la
--    tabla base y UNA clave de `configuracion` (catalogo_specs) sin abrirle nada a anon.
--    `configuracion` NO se abre ni se toca su política: anon sigue leyendo lo que ya leía.
--  · Un catalogo_specs con JSON inválido o con forma rara se IGNORA (no rompe la vista).
--  · Las funciones auxiliares son PURAS (no leen ninguna tabla), están en su propio esquema
--    `catalogo_aux` para NO quedar expuestas como RPC de la API, y tienen cotas de tamaño. Tienen
--    que ser ejecutables por anon: Postgres chequea el permiso de las funciones que llama una
--    vista con el usuario que consulta (el dueño de la vista sólo vale para las TABLAS). Se
--    descubrió probándolo: cerrarlas rompía la vista para anon con "permission denied".
--  · El rol que corre el archivo tiene que saltear RLS (postgres, en el SQL Editor): se verifica.
--  · La landing tiene que pedir `order=orden,modelo`: la vista no garantiza el orden de entrega.
--  Re-ejecutable: la siembra reemplaza la tabla entera dentro de la transacción, así que
--  este archivo es la única fuente. No editar catalogo_modelos_base a mano.
-- ============================================================================

BEGIN;

-- ── Guardas ─────────────────────────────────────────────────────────────────
-- Si otra sesión tiene tomada la tabla base, mejor fallar a los 3 segundos que dejar
-- esperando (y haciendo esperar a la landing) a todo el que lea la vista.
SET LOCAL lock_timeout = '3s';

-- La vista corre con los permisos de QUIEN LA CREA. Para leer `configuracion` (que tiene RLS)
-- ese rol tiene que saltearla (en Supabase, `postgres` lo hace). Con otro rol la vista
-- NO fallaría: mostraría en silencio sólo lo declarado en el código. Por eso se frena acá.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Correr este archivo con el rol postgres (SQL Editor de Supabase): % no saltea RLS y la vista no podría leer catalogo_specs', current_user;
  END IF;
END $$;

-- ── Esquema de auxiliares (puras) y validación de texto ─────────────────────
-- Van en su propio esquema para que no queden como RPC de PostgREST (el prefijo `_` no
-- oculta nada): cualquiera con la anon key podría llamarlas con entradas arbitrarias. Sólo
-- se exponen los esquemas configurados en Supabase (por defecto `public`). La vista, en
-- cambio, SÍ puede usarlas: Postgres chequea USAGE y EXECUTE con el usuario que consulta
-- (no con el dueño de la vista), así que anon necesita ambos. Son puras: no leen ninguna tabla.
CREATE SCHEMA IF NOT EXISTS catalogo_aux;
GRANT USAGE ON SCHEMA catalogo_aux TO anon, authenticated;

-- Quita los blancos de los extremos COMO LO HACE JavaScript (`trim()`): no sólo el espacio,
-- también tabulaciones, saltos, el espacio de no separación (U+00A0), U+FEFF, etc. `btrim()`
-- sólo quita espacios: un color "\u00a0" pasaba como válido y la landing lo ve vacío.
CREATE OR REPLACE FUNCTION catalogo_aux.limpiar(p TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE
SET search_path = catalogo_aux, pg_temp AS $$
  SELECT regexp_replace(p, '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g')
$$;

-- ¿Sirve como texto para la landing? Sin blancos en los extremos, de 1 a `p_max` caracteres y
-- SIN caracteres fuera del plano básico (emojis…): JavaScript mide en unidades UTF-16 y un
-- emoji cuenta 2, mientras que length() de Postgres cuenta 1: 21 emojis pasaban de 40 sin
-- que esta validación lo notara. Un texto así se descarta (no tiene sentido como color, ni
-- como capacidad ni como modelo).
CREATE OR REPLACE FUNCTION catalogo_aux.texto_ok(p TEXT, p_max INT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE
SET search_path = catalogo_aux, pg_temp AS $$
  SELECT p IS NOT NULL
     AND p = catalogo_aux.limpiar(p)
     AND length(p) BETWEEN 1 AND p_max
     AND p !~ '[\U00010000-\U0010FFFF]'
$$;
GRANT EXECUTE ON FUNCTION catalogo_aux.limpiar(TEXT)        TO anon, authenticated;
GRANT EXECUTE ON FUNCTION catalogo_aux.texto_ok(TEXT, INT)  TO anon, authenticated;

-- ── Tabla base (sembrada desde el código) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.catalogo_modelos_base (
  modelo       TEXT PRIMARY KEY CHECK (catalogo_aux.texto_ok(modelo, 60)),   -- contrato de la landing
  categoria    TEXT NOT NULL,
  generacion   INTEGER NOT NULL,
  capacidades  TEXT[] NOT NULL DEFAULT '{}',
  colores      TEXT[] NOT NULL DEFAULT '{}'
);

-- Sin políticas: cerrada. ENABLE ROW LEVEL SECURITY pide un candado exclusivo sobre la tabla
-- (frena las lecturas de la vista hasta terminar la transacción), así que sólo se hace la
-- primera vez; las siguientes corridas no la tocan.
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.catalogo_modelos_base'::regclass) THEN
    ALTER TABLE public.catalogo_modelos_base ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;
REVOKE ALL ON public.catalogo_modelos_base FROM PUBLIC, anon, authenticated;

-- Siembra: se reemplaza todo en la misma transacción (nunca queda a medias). DELETE e
-- INSERT no bloquean las lecturas de la vista (MVCC): quien lee ve la versión anterior hasta
-- que esto confirma.
DELETE FROM public.catalogo_modelos_base;
INSERT INTO public.catalogo_modelos_base (modelo, categoria, generacion, capacidades, colores) VALUES
  ('iPhone 18', 'iphone', 18, ARRAY['128GB', '256GB', '512GB']::text[], '{}'::text[]),
  ('iPhone 18 Plus', 'iphone', 18, ARRAY['128GB', '256GB', '512GB']::text[], '{}'::text[]),
  ('iPhone 18 Pro', 'iphone', 18, ARRAY['256GB', '512GB', '1TB', '2TB']::text[], ARRAY['Negro', 'Plata', 'Glacier']::text[]),
  ('iPhone 18 Pro Max', 'iphone', 18, ARRAY['256GB', '512GB', '1TB', '2TB']::text[], ARRAY['Negro', 'Plata', 'Glacier']::text[]),
  ('iPhone 17', 'iphone', 17, ARRAY['128GB', '256GB', '512GB']::text[], ARRAY['Negro', 'Blanco', 'Azul Neblina', 'Lavanda', 'Salvia']::text[]),
  ('iPhone 17 Plus', 'iphone', 17, ARRAY['128GB', '256GB', '512GB']::text[], ARRAY['Negro', 'Blanco', 'Azul Neblina', 'Lavanda', 'Salvia']::text[]),
  ('iPhone 17 Pro', 'iphone', 17, ARRAY['256GB', '512GB', '1TB', '2TB']::text[], ARRAY['Naranja Cósmico', 'Azul Profundo', 'Plata']::text[]),
  ('iPhone 17 Pro Max', 'iphone', 17, ARRAY['256GB', '512GB', '1TB', '2TB']::text[], ARRAY['Naranja Cósmico', 'Azul Profundo', 'Plata']::text[]),
  ('iPhone 16', 'iphone', 16, ARRAY['128GB', '256GB', '512GB']::text[], ARRAY['Negro', 'Blanco', 'Azul', 'Verde Azulado', 'Rosa', 'Ultramarino']::text[]),
  ('iPhone 16 Plus', 'iphone', 16, ARRAY['128GB', '256GB', '512GB']::text[], ARRAY['Negro', 'Blanco', 'Azul', 'Verde Azulado', 'Rosa', 'Ultramarino']::text[]),
  ('iPhone 16 Pro', 'iphone', 16, ARRAY['128GB', '256GB', '512GB', '1TB']::text[], ARRAY['Titanio Negro', 'Titanio Blanco', 'Titanio Desierto', 'Titanio Natural']::text[]),
  ('iPhone 16 Pro Max', 'iphone', 16, ARRAY['256GB', '512GB', '1TB']::text[], ARRAY['Titanio Negro', 'Titanio Blanco', 'Titanio Desierto', 'Titanio Natural']::text[]),
  ('iPhone 16e', 'iphone', 16, ARRAY['128GB', '256GB', '512GB']::text[], ARRAY['Negro', 'Blanco']::text[]),
  ('iPhone 15', 'iphone', 15, ARRAY['128GB', '256GB', '512GB']::text[], ARRAY['Negro', 'Rosa', 'Amarillo', 'Verde', 'Azul']::text[]),
  ('iPhone 15 Plus', 'iphone', 15, ARRAY['128GB', '256GB', '512GB']::text[], ARRAY['Negro', 'Rosa', 'Amarillo', 'Verde', 'Azul']::text[]),
  ('iPhone 15 Pro', 'iphone', 15, ARRAY['128GB', '256GB', '512GB', '1TB']::text[], ARRAY['Titanio Negro', 'Titanio Blanco', 'Titanio Azul', 'Titanio Natural']::text[]),
  ('iPhone 15 Pro Max', 'iphone', 15, ARRAY['256GB', '512GB', '1TB']::text[], ARRAY['Titanio Negro', 'Titanio Blanco', 'Titanio Azul', 'Titanio Natural']::text[]),
  ('iPhone 14', 'iphone', 14, ARRAY['128GB', '256GB', '512GB']::text[], ARRAY['Medianoche', 'Blanco Estrella', 'Rojo', 'Azul', 'Amarillo', 'Morado']::text[]),
  ('iPhone 14 Plus', 'iphone', 14, ARRAY['128GB', '256GB', '512GB']::text[], ARRAY['Medianoche', 'Blanco Estrella', 'Rojo', 'Azul', 'Amarillo', 'Morado']::text[]),
  ('iPhone 14 Pro', 'iphone', 14, ARRAY['128GB', '256GB', '512GB', '1TB']::text[], ARRAY['Negro Espacial', 'Plata', 'Dorado', 'Morado Profundo']::text[]),
  ('iPhone 14 Pro Max', 'iphone', 14, ARRAY['128GB', '256GB', '512GB', '1TB']::text[], ARRAY['Negro Espacial', 'Plata', 'Dorado', 'Morado Profundo']::text[]),
  ('iPhone 13', 'iphone', 13, ARRAY['128GB', '256GB', '512GB']::text[], ARRAY['Medianoche', 'Blanco Estrella', 'Rojo', 'Azul', 'Rosa', 'Verde']::text[]),
  ('iPhone 13 Mini', 'iphone', 13, ARRAY['128GB', '256GB', '512GB']::text[], ARRAY['Medianoche', 'Blanco Estrella', 'Rojo', 'Azul', 'Rosa', 'Verde']::text[]),
  ('iPhone 13 Pro', 'iphone', 13, ARRAY['128GB', '256GB', '512GB', '1TB']::text[], ARRAY['Grafito', 'Dorado', 'Plata', 'Sierra Azul', 'Verde Alpino']::text[]),
  ('iPhone 13 Pro Max', 'iphone', 13, ARRAY['128GB', '256GB', '512GB', '1TB']::text[], ARRAY['Grafito', 'Dorado', 'Plata', 'Sierra Azul', 'Verde Alpino']::text[]),
  ('iPhone 12', 'iphone', 12, ARRAY['64GB', '128GB', '256GB']::text[], ARRAY['Negro', 'Blanco', 'Rojo', 'Azul', 'Verde', 'Violeta']::text[]),
  ('iPhone 12 Pro', 'iphone', 12, ARRAY['128GB', '256GB', '512GB']::text[], ARRAY['Plata', 'Grafito', 'Dorado', 'Azul Pacífico']::text[]),
  ('iPhone 12 Pro Max', 'iphone', 12, ARRAY['128GB', '256GB', '512GB']::text[], ARRAY['Plata', 'Grafito', 'Dorado', 'Azul Pacífico']::text[]),
  ('iPhone 11', 'iphone', 11, ARRAY['64GB', '128GB', '256GB']::text[], ARRAY['Negro', 'Blanco', 'Rojo', 'Verde', 'Amarillo', 'Violeta']::text[]);


-- ── Auxiliares (puras) ─────────────────────────────────────────────────────
--
-- COTAS (el JSON de catalogo_specs lo escribe una persona, pero esto lo evalúa cada consulta
-- de la landing): texto de hasta 100.000 caracteres, 200 elementos por lista, 40 caracteres
-- por elemento. Lo que excede se IGNORA (la vista sigue andando con lo declarado).
-- JSON tolerante: texto inválido, vacío, demasiado grande o NULL → NULL. Si la clave se guardó
-- dos veces codificada (un JSON string que contiene JSON), se decodifica una vez más.
CREATE OR REPLACE FUNCTION catalogo_aux.json_seguro(p TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE
SET search_path = catalogo_aux, pg_temp AS $$
DECLARE j JSONB;
BEGIN
  IF p IS NULL OR length(p) > 100000 THEN RETURN NULL; END IF;
  j := p::jsonb;
  IF jsonb_typeof(j) = 'string' THEN
    IF length(j #>> '{}') > 100000 THEN RETURN NULL; END IF;
    j := (j #>> '{}')::jsonb;
  END IF;
  RETURN j;
EXCEPTION WHEN others THEN
  RETURN NULL;
END; $$;

-- Tamaño en GB de '128GB' / '1TB' / '1,5 TB'. NULL si no se entiende o es absurdo
-- (más de 9 dígitos enteros, más de 3 decimales, o más de 40 caracteres).
CREATE OR REPLACE FUNCTION catalogo_aux.gb(p TEXT)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE
SET search_path = catalogo_aux, pg_temp AS $$
  SELECT CASE WHEN m IS NULL THEN NULL
              ELSE replace(m[1], ',', '.')::numeric * CASE WHEN m[2] = 'TB' THEN 1024 ELSE 1 END END
    FROM (SELECT CASE WHEN length(p) <= 40
                      THEN regexp_match(upper(catalogo_aux.limpiar(p)), '^(\d{1,9}(?:[.,]\d{1,3})?)\s*(GB|TB)$') END AS m) q
$$;

-- Une la lista declarada con la sumada a mano (un JSON array): la declarada primero,
-- después la sumada; sin vacíos, sin "Otro", sin repetidos (sin distinguir mayúsculas,
-- queda la primera grafía). Se ignoran: un elemento que no sea texto, uno que no pase
-- texto_ok(…, 40) (vacío tras limpiar blancos, de más de 40 caracteres o con emojis), y una lista de entrada de más de 200 elementos (entera). Un `p_extra` que no sea
-- array se ignora. La SALIDA tiene como máximo 30 elementos (los primeros: lo declarado
-- manda sobre lo sumado): es el contrato de la landing, que descarta la fila entera si una
-- lista trae más.
CREATE OR REPLACE FUNCTION catalogo_aux.unir(p_base TEXT[], p_extra JSONB)
RETURNS TEXT[] LANGUAGE sql STABLE
SET search_path = catalogo_aux, pg_temp AS $$
  SELECT COALESCE(array_agg(f.v ORDER BY f.ord), '{}'::text[])
    FROM (
     SELECT d.v, d.ord, row_number() OVER (ORDER BY d.ord) AS rn
      FROM (
      SELECT DISTINCT ON (lower(u.v)) u.v, u.ord
        FROM (
          SELECT catalogo_aux.limpiar(t.x) AS v, t.n AS ord
            FROM unnest(CASE WHEN cardinality(p_base) <= 200 THEN p_base ELSE '{}'::text[] END)
                 WITH ORDINALITY AS t(x, n)
          UNION ALL
          SELECT catalogo_aux.limpiar(e.x #>> '{}'), 1000000 + e.n
            FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(p_extra) = 'array' AND jsonb_array_length(p_extra) <= 200
                        THEN p_extra ELSE '[]'::jsonb END)
                 WITH ORDINALITY AS e(x, n)
           WHERE jsonb_typeof(e.x) = 'string'
        ) u
       WHERE catalogo_aux.texto_ok(u.v, 40) AND lower(u.v) <> 'otro'
       ORDER BY lower(u.v), u.ord
      ) d
    ) f
   WHERE f.rn <= 30
$$;

CREATE OR REPLACE FUNCTION catalogo_aux.capacidades(p_base TEXT[], p_extra JSONB)
RETURNS TEXT[] LANGUAGE sql STABLE
SET search_path = catalogo_aux, pg_temp AS $$
  SELECT COALESCE(array_agg(c.v ORDER BY catalogo_aux.gb(c.v) NULLS LAST, c.v), '{}'::text[])
    FROM unnest(catalogo_aux.unir(p_base, p_extra)) AS c(v)
$$;

-- Ejecutables a propósito (ver arriba): son puras, no tocan datos.
GRANT EXECUTE ON FUNCTION catalogo_aux.json_seguro(TEXT)            TO anon, authenticated;
GRANT EXECUTE ON FUNCTION catalogo_aux.gb(TEXT)                     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION catalogo_aux.unir(TEXT[], JSONB)          TO anon, authenticated;
GRANT EXECUTE ON FUNCTION catalogo_aux.capacidades(TEXT[], JSONB)   TO anon, authenticated;


-- ── La vista pública ────────────────────────────────────────────────────────
-- `extra` se evalúa UNA vez (MATERIALIZED: si no, Postgres puede repetir el parseo por cada
-- fila y columna). Si la clave catalogo_specs no existe, es NULL y la vista muestra sólo lo
-- declarado en la tabla base.
CREATE OR REPLACE VIEW public.catalogo_modelos_publico
WITH (security_invoker = false) AS
WITH extra AS MATERIALIZED (
  SELECT catalogo_aux.json_seguro(
           (SELECT c.valor FROM public.configuracion c WHERE c.clave = 'catalogo_specs' LIMIT 1)) AS j
)
SELECT b.modelo,
       dense_rank() OVER (ORDER BY b.generacion DESC)::int                          AS orden,
       catalogo_aux.capacidades(b.capacidades, e.j -> b.modelo -> 's')              AS capacidades,
       catalogo_aux.unir(b.colores,            e.j -> b.modelo -> 'c')              AS colores
  FROM public.catalogo_modelos_base b
 CROSS JOIN extra e
 WHERE b.categoria = 'iphone'
   AND catalogo_aux.texto_ok(b.modelo, 60);

GRANT SELECT ON public.catalogo_modelos_publico TO anon, authenticated;

COMMIT;

-- ============================================================================
--  VERIFICACIÓN (después de correr, desde la landing o con la anon key)
--    curl -s "$SUPABASE_URL/rest/v1/catalogo_modelos_publico?select=*&order=orden,modelo&limit=3" \
--         -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
--      → 3 filas de iPhone 18, con columnas EXACTAMENTE: modelo, orden, capacidades, colores.
--    Y que lo cerrado siga cerrado (las dos tienen que dar 401/403 o []):
--      …/rest/v1/catalogo_modelos_base?select=*    …/rest/v1/configuracion?clave=eq.catalogo_specs
--    En el SQL Editor:  SELECT count(*), min(orden), max(orden) FROM catalogo_modelos_publico;
--      → 29 filas (hoy), orden de 1 a 8.
-- ============================================================================
