-- Blog para posicionamiento en Google.
--
-- Por qué una tabla y no archivos en el repo: Franco tiene que poder escribir,
-- corregir y despublicar un artículo desde el CRM, sin esperar un deploy. Los
-- artículos son contenido, no código.
--
-- El texto se guarda en `cuerpo` con un markdown reducido (##, ###, listas,
-- **negrita**, [link](url), > cita). El servidor lo convierte a HTML al
-- servir la página: escapando primero y aplicando el formato después, así lo
-- que se escribe en el CRM nunca puede inyectar etiquetas en la página.

CREATE TABLE IF NOT EXISTS public.blog_posts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- El slug es la dirección pública: /blog/<slug>. Es UNIQUE porque si dos
  -- artículos comparten dirección, uno tapa al otro.
  slug           text UNIQUE NOT NULL,
  titulo         text NOT NULL,
  -- Resumen de una o dos frases. Es lo que Google muestra debajo del título
  -- en los resultados y lo que aparece en la vista previa de WhatsApp.
  bajada         text,
  cuerpo         text NOT NULL DEFAULT '',
  -- Nombre del archivo en el bucket `products` (los del blog van con el
  -- prefijo blog-). Se guarda el nombre, no la URL: así el tamaño de la
  -- imagen se decide al servirla.
  imagen         text,
  imagen_alt     text,
  autor          text NOT NULL DEFAULT 'iPhone Mood',
  etiquetas      text[] NOT NULL DEFAULT '{}',
  estado         text NOT NULL DEFAULT 'borrador'
                 CHECK (estado IN ('borrador', 'publicado')),
  -- Fecha que ve el lector y que se le declara a Google. Se completa al
  -- publicar; queda fija aunque después se corrija una falta de ortografía.
  publicado_en   timestamptz,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS blog_posts_slug_idx ON public.blog_posts (slug);
CREATE INDEX IF NOT EXISTS blog_posts_publicado_idx
  ON public.blog_posts (publicado_en DESC) WHERE estado = 'publicado';

-- `actualizado_en` a mano se olvida. Lo pone la base en cada UPDATE.
CREATE OR REPLACE FUNCTION public.blog_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.actualizado_en := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS blog_posts_touch ON public.blog_posts;
CREATE TRIGGER blog_posts_touch BEFORE UPDATE ON public.blog_posts
  FOR EACH ROW EXECUTE FUNCTION public.blog_touch();

ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;

-- Escribir y ver borradores: solo el CRM.
DROP POLICY IF EXISTS "auth_all_blog" ON public.blog_posts;
CREATE POLICY "auth_all_blog" ON public.blog_posts
  FOR ALL USING (public.is_authorized_user());

-- ── Lectura pública ──
-- Va por vista y no abriendo la tabla al rol anónimo, igual que stock_publico.
-- La diferencia importa: un borrador a medio escribir NO tiene que ser
-- accesible desde afuera, ni siquiera adivinando el slug.
DROP VIEW IF EXISTS public.blog_publico;
CREATE VIEW public.blog_publico
WITH (security_invoker = false) AS
SELECT
  b.slug, b.titulo, b.bajada, b.cuerpo, b.imagen, b.imagen_alt,
  b.autor, b.etiquetas, b.publicado_en, b.actualizado_en
FROM public.blog_posts b
WHERE b.estado = 'publicado'
  AND b.publicado_en IS NOT NULL
  AND b.publicado_en <= now();

GRANT SELECT ON public.blog_publico TO anon, authenticated;
