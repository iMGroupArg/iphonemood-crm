-- Publica los 4 artículos del iPhone 18 (estaban en borrador desde el 23/09).
--
-- Hay que tocar las DOS columnas: la vista pública `blog_publico` exige
-- estado='publicado' Y publicado_en no nulo y no futuro. Con una sola no
-- aparecen.
--
-- Las fechas van escalonadas por minuto a propósito: el índice del blog
-- ordena por publicado_en descendente, así que el más nuevo queda arriba.
-- Se ordenan para que el lector entre por el resumen de qué cambió y termine
-- en el de "conviene el 17 o el 16", que es el que empuja al stock de hoy.
--
-- El `AND estado = 'borrador'` del final es un seguro: si alguno ya estaba
-- publicado, no le pisa la fecha original.

UPDATE public.blog_posts SET
  estado = 'publicado',
  publicado_en = CASE slug
    WHEN 'iphone-18-pro-y-pro-max-que-cambio-de-verdad'            THEN now()
    WHEN 'iphone-duo-el-primer-plegable-de-apple'                  THEN now() - interval '1 minute'
    WHEN 'iphone-18-pro-precio-argentina-y-cuando-llega'           THEN now() - interval '2 minutes'
    WHEN 'salio-el-iphone-18-por-que-ahora-conviene-el-17-o-el-16' THEN now() - interval '3 minutes'
  END
WHERE slug IN (
  'iphone-18-pro-y-pro-max-que-cambio-de-verdad',
  'iphone-duo-el-primer-plegable-de-apple',
  'iphone-18-pro-precio-argentina-y-cuando-llega',
  'salio-el-iphone-18-por-que-ahora-conviene-el-17-o-el-16'
) AND estado = 'borrador';

-- Control: tienen que quedar los 8 artículos, los 8 en 'publicado'.
SELECT estado, publicado_en::date AS fecha, slug
FROM public.blog_posts
ORDER BY publicado_en DESC NULLS LAST;
