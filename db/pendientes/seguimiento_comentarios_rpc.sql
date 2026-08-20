-- ============================================================================
--  PENDIENTE DE APLICAR — no está corrido en Supabase todavía.
--
--  PROBLEMA
--  La página de seguimiento de reparaciones (seguimiento.html) está diseñada
--  con un token secreto por reparación: `get_reparacion_publica(p_token)` es
--  SECURITY DEFINER y solo devuelve la reparación de quien tiene el link.
--
--  Pero el chat de esa misma página consulta la tabla `seguimiento_comentarios`
--  DIRECTO con la anon key (funciones `cargarMensajes` y `enviarMensaje` de
--  seguimiento.html). Resultado: el token no protege nada del chat.
--
--    · LECTURA sin login: VERIFICADO el 15-08-2026 pegándole a la API REST
--      con la anon key — devuelve los comentarios de todas las reparaciones.
--    · ESCRITURA sin login: NO verificado (no quisimos hacer pruebas de
--      escritura contra la base de producción). Es muy probable que esté
--      abierta, porque `enviarMensaje` hace un INSERT con la anon key desde
--      una página sin login y hoy funciona. Confirmalo en
--      Supabase → Authentication → Policies → seguimiento_comentarios
--      antes de dar por hecho el alcance del problema.
--
--  SOLUCIÓN
--  Mover el chat al mismo esquema de token que ya usa el resto de la página:
--  dos RPC SECURITY DEFINER que reciben el token, y cerrar el acceso directo
--  a la tabla.
--
--  APLICAR EN DOS PASOS (en este orden, si no se rompe el chat):
--    1. Correr este archivo en Supabase → SQL Editor.
--    2. Cambiar seguimiento.html para que use las RPC (ver abajo).
-- ============================================================================


-- ──────────────────────────────────────────────────────────────
-- 1. Leer los comentarios de UNA reparación, con su token
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_comentarios_publicos(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rep_id reparaciones.id%TYPE;
BEGIN
  -- Token vacío no matchea nada: si alguna reparación tuviera el token en ''
  -- (dato viejo o mal migrado), un p_token vacío la abriría.
  IF p_token IS NULL OR btrim(p_token) = '' THEN
    RETURN '[]'::json;
  END IF;

  SELECT r.id INTO v_rep_id
  FROM reparaciones r
  WHERE r.token_seguimiento = p_token;

  IF NOT FOUND THEN
    RETURN '[]'::json;
  END IF;

  RETURN COALESCE(
    (SELECT json_agg(c ORDER BY c.creado_en)
     FROM (
       SELECT id, autor, es_tecnico, texto, creado_en
       FROM seguimiento_comentarios
       WHERE reparacion_id = v_rep_id
     ) c),
    '[]'::json
  );
END;
$$;


-- ──────────────────────────────────────────────────────────────
-- 2. Escribir un comentario en UNA reparación, con su token
--
--    El cliente no elige `reparacion_id` ni `es_tecnico`: los pone la
--    función. Así no puede escribir en la reparación de otro ni hacerse
--    pasar por el técnico.
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.agregar_comentario_publico(
  p_token  TEXT,
  p_autor  TEXT,
  p_texto  TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rep_id reparaciones.id%TYPE;
BEGIN
  IF p_token IS NULL OR btrim(p_token) = '' THEN
    RETURN FALSE;
  END IF;

  IF p_texto IS NULL OR btrim(p_texto) = '' THEN
    RETURN FALSE;
  END IF;

  SELECT r.id INTO v_rep_id
  FROM reparaciones r
  WHERE r.token_seguimiento = p_token;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  INSERT INTO seguimiento_comentarios (reparacion_id, autor, es_tecnico, texto)
  VALUES (
    v_rep_id,
    COALESCE(NULLIF(btrim(p_autor), ''), 'Cliente'),
    FALSE,
    left(btrim(p_texto), 2000)
  );

  RETURN TRUE;
END;
$$;


GRANT EXECUTE ON FUNCTION public.get_comentarios_publicos(TEXT)              TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agregar_comentario_publico(TEXT,TEXT,TEXT)  TO anon, authenticated;


-- ──────────────────────────────────────────────────────────────
-- 3. Cerrar el acceso anónimo directo a la tabla
--
--    OJO: la política que hoy deja leer/escribir `seguimiento_comentarios`
--    sin login NO está en ningún archivo de db/migrations/ — se creó a mano
--    en el dashboard. Mirá el nombre real en:
--       Supabase → Authentication → Policies → seguimiento_comentarios
--    y reemplazá el nombre de abajo si no coincide.
--
--    Correr esto SOLO después de haber cambiado seguimiento.html.
-- ──────────────────────────────────────────────────────────────

-- DROP POLICY IF EXISTS "seguimiento_comentarios_publico" ON public.seguimiento_comentarios;

-- Y dejar la política estándar del CRM (solo usuarios autorizados),
-- para que el técnico siga viendo y escribiendo desde el panel:
--
-- ALTER TABLE public.seguimiento_comentarios ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "seguimiento_comentarios_all" ON public.seguimiento_comentarios
--   USING (public.is_authorized_user())
--   WITH CHECK (public.is_authorized_user());


-- ──────────────────────────────────────────────────────────────
-- 4. Cambios en seguimiento.html (después de correr lo de arriba)
--
--    Se referencian por nombre de función y no por número de línea porque el
--    archivo se edita en paralelo y las líneas se corren.
--
--    En `cargarMensajes()` — reemplazar el .from('seguimiento_comentarios')
--    entero por:
--
--      const { data } = await supa.rpc('get_comentarios_publicos', { p_token: token });
--      return data || [];
--
--    En `enviarMensaje()` — reemplazar el .insert({...}) por:
--
--      const { data: ok, error } = await supa.rpc('agregar_comentario_publico', {
--        p_token: token,
--        p_autor: nombre,
--        p_texto: texto,
--      });
--
--    (`token` es la misma variable que ya se usa para get_reparacion_publica.)
--
--    OJO con el manejo de error: la RPC devuelve `false` cuando el token no
--    existe, sin tirar error. O sea que `error` puede venir null y la
--    operación igual haber fallado. Chequear las dos cosas:
--
--      if (error || ok === false) { ...mostrar el fallo... }
-- ──────────────────────────────────────────────────────────────
