-- Corrección de los dos artículos que quedaron desactualizados.
--
-- 1) El del evento del 9 de septiembre estaba escrito en futuro sobre algo que
--    ya pasó, llamaba "iPhone Fold" al plegable (se llama iPhone Duo) y
--    prometía un resumen posterior que ya existe. Se reescribe como repaso
--    posterior al evento y se enlazan los cuatro artículos nuevos.
-- 2) El de iOS 27 decía que "llega a mediados de septiembre". Salió el 14 de
--    septiembre. Además faltaba el dato más importante para un lector de
--    acá: Siri AI arranca sólo en inglés y el español llega más adelante.
--
-- NO se toca `publicado_en` a propósito: los artículos se publicaron el 29 de
-- agosto y sigue siendo verdad. La base actualiza `actualizado_en` sola, que
-- es lo que la página le declara a Google como fecha de modificación.

UPDATE public.blog_posts SET
  bajada = $art$El evento ya pasó y casi todo lo que era rumor se confirmó. Repasamos qué anunció Apple el 9 de septiembre, en qué le erramos los que veníamos siguiendo las filtraciones, y qué cambió para los precios en Argentina.$art$,
  cuerpo = $art$> **Actualizado.** Este artículo se escribió antes del evento. Lo dejamos publicado y lo corregimos después de la keynote: abajo está lo que Apple terminó anunciando y en qué acertaron y fallaron los rumores.

El **miércoles 9 de septiembre de 2026** Apple hizo su keynote de otoño en el Apple Park, en Cupertino, bajo el lema *"Surprise and shine"*. Fue la **primera keynote de John Ternus como CEO**, después de que Tim Cook pasara a presidir el directorio el 1 de septiembre.

## Qué anunció Apple

- **iPhone 18 Pro y iPhone 18 Pro Max**, con el chip **A20 Pro**, el primero de 2 nanómetros en un teléfono. Salieron a la venta el 18 de septiembre en más de 60 países, a USD 1.199 y USD 1.299.
- **iPhone Duo**, el primer plegable de Apple. Pantalla interior de 7,6 pulgadas y exterior de 5,4. Desde USD 1.999.
- **No hubo iPhone 18 "a secas".** Apple partió el lanzamiento en dos y dejó los modelos más accesibles para 2027.

## En qué acertaron los rumores y en qué no

Lo que veníamos contando antes del evento salió casi todo bien, pero con dos correcciones que vale la pena marcar:

| Lo que se decía | Lo que pasó |
| --- | --- |
| iPhone 18 Pro con A20 Pro de 2 nm | Confirmado |
| Un plegable tipo libro, 5,5" exterior y 7,6" interior | Confirmado, con 5,4" exterior |
| Se llamaría *iPhone Fold* o *iPhone Ultra* | **Se llama iPhone Duo** |
| Touch ID en vez de Face ID, sin teleobjetivo | Confirmado |
| No habría iPhone 18 a secas en septiembre | Confirmado |

El nombre fue el error más repetido: durante meses todo el mundo lo llamó Fold. Terminó siendo Duo.

## Qué significa esto para vos, que estás mirando un iPhone hoy

Acá va la parte práctica, que es la que en general nadie escribe.

**1. Los modelos que ya estaban en la calle se acomodaron de precio.** Es lo que pasa todos los años, sin excepción: cuando entra la generación nueva, la anterior baja. No se derrumba —los iPhone sostienen valor mucho mejor que cualquier otro teléfono— pero se acomoda. El iPhone 17 tocó su precio más bajo después del anuncio.

**2. Si estás por vender el tuyo, conviene antes que después.** La misma lógica al revés: el valor de reventa de tu equipo baja a medida que pasan los meses. En [nuestro plan canje](/#canje) tomamos tu usado como parte de pago y te cotizamos el saldo en el momento.

**3. Un plegable de primera generación no es para cualquiera.** Vale decirlo aunque no nos convenga: los productos de primera generación de Apple casi siempre tienen una segunda versión bastante mejor. El primer Apple Watch, el primer HomePod, el primer Vision Pro. Si necesitás un teléfono confiable para los próximos cuatro años, la línea Pro es una apuesta más segura que el plegable.

## Seguí leyendo

Después del evento escribimos el detalle de cada cosa:

- [iPhone 18 Pro y Pro Max: qué cambió de verdad](/blog/iphone-18-pro-y-pro-max-que-cambio-de-verdad)
- [iPhone Duo: así es el primer plegable de Apple](/blog/iphone-duo-el-primer-plegable-de-apple)
- [iPhone 18 Pro en Argentina: cuánto va a salir y cuándo llega](/blog/iphone-18-pro-precio-argentina-y-cuando-llega)
- [Salió el iPhone 18: por qué ahora conviene el 17 o el 16](/blog/salio-el-iphone-18-por-que-ahora-conviene-el-17-o-el-16)

Y si querés ver qué hay disponible hoy con precio actualizado, está todo en [nuestro catálogo](/).$art$
WHERE slug = 'evento-apple-9-de-septiembre-2026-iphone-18-pro-y-el-primer-plegable';

UPDATE public.blog_posts SET
  bajada = $art$iOS 27 salió el 14 de septiembre con una Siri rehecha de cero, que por ahora sólo habla inglés. Te contamos qué modelos quedaron adentro, cuáles afuera y si conviene actualizar ya.$art$,
  cuerpo = $art$**iOS 27 salió el 14 de septiembre de 2026**, unos días antes de que llegaran a la calle el iPhone 18 Pro y el Pro Max.

Si tenés un iPhone y no seguís el tema de cerca, hay tres preguntas que importan: si tu modelo lo recibió, qué cambia de verdad, y si conviene apurarse a actualizar.

## Qué iPhone lo reciben

**iOS 27 mantiene exactamente la misma lista de compatibles que iOS 26**: funciona desde el **iPhone 11 en adelante**, más el iPhone SE de segunda generación (el de 2020) y el de tercera (2022).

Eso deja adentro:

- iPhone 11, 11 Pro y 11 Pro Max
- iPhone 12, 12 mini, 12 Pro y 12 Pro Max
- iPhone 13, 13 mini, 13 Pro y 13 Pro Max
- iPhone 14, 14 Plus, 14 Pro y 14 Pro Max
- iPhone 15, 15 Plus, 15 Pro y 15 Pro Max
- iPhone 16, 16 Plus, 16e, 16 Pro y 16 Pro Max
- iPhone 17 y toda su línea
- iPhone 18 Pro, 18 Pro Max y iPhone Duo, que vienen con iOS 27 de fábrica
- iPhone SE (2020) y SE (2022)

Y deja afuera al **iPhone XR, XS y XS Max**, que ya se habían quedado sin iOS 26.

Un detalle importante: que un iPhone reciba la actualización no significa que reciba *todas* las funciones. **Las de Apple Intelligence piden un iPhone 15 Pro o superior.** Esa distinción viene siendo la letra chica de las últimas tres versiones de iOS.

## Qué cambia de verdad

La novedad grande es **Siri**. Apple la rehízo desde cero: pasa a tener app propia y puede acceder a tus mensajes, tus fotos y tu correo para completar tareas usando tu contexto personal.

Ahora, la letra chica que conviene saber antes de entusiasmarse:

- **Siri AI está en versión beta** dentro de iOS 27.
- **Arranca sólo en inglés.** Apple dijo que el español llega más adelante este año, sin fecha exacta. Si tenés el teléfono en español, por ahora vas a seguir con la Siri de siempre.
- **Algunas funciones tienen límite de uso diario**, porque corren en los servidores de Apple y no en el teléfono.
- **Personalizar la voz de Siri** sólo está disponible en los modelos más nuevos: iPhone 18 Pro, 18 Pro Max, Duo, 17 Pro, 17 Pro Max y Air.

El resto son mejoras acumuladas más que cambios de fondo: rendimiento, funciones nuevas de seguridad infantil, mejoras en la búsqueda de Mail y en Mapas.

Si venís de iOS 26, el salto visual es menor que el del año pasado —el rediseño *Liquid Glass* ya lo trajo iOS 26—. Lo que cambia es el asistente, y todavía no en tu idioma.

## ¿Conviene actualizar?

Nuestra recomendación, después de ver esto cada septiembre durante años:

**Si tu iPhone es de los últimos tres años, actualizá tranquilo.** Ya pasaron las primeras semanas, que son las que suelen traer el bug tonto de alguna app de terceros —el banco, Mercado Pago, la app del laburo—. A esta altura ya están todas al día.

**Si tu iPhone es un 11 o un 12**, pensalo un poco más. Va a andar, pero es el modelo más viejo de la lista y las primeras versiones de un iOS nuevo suelen ir más pesadas hasta el .1 o el .2. Si el teléfono te anda bien hoy, no hay apuro.

**Antes de actualizar, en cualquier caso:** hacé una copia de seguridad en iCloud o en la computadora, y fijate que tengas al menos 10 GB libres. La mitad de los problemas de actualización que vemos en el mostrador son falta de espacio.

## Un chequeo que vale la pena hacer ahora

Andá a **Ajustes → General → Información** y mirá la versión que tenés. Si estás muy atrasado —iOS 24, iOS 25— no vas a poder saltar directo a iOS 27 sin pasar por actualizaciones intermedias, y conviene ir haciéndolo con tiempo.

Y aprovechá para mirar **Ajustes → General → Información → Batería**. Si el estado máximo de la batería bajó del 80%, la actualización te va a hacer notar más el problema: el sistema nuevo pide un poco más, y una batería gastada se apaga sola cuando le exigen.

---

Si tu iPhone ya no da para más y estás pensando en cambiarlo, en [nuestro catálogo](/) tenés el stock real con precio actualizado, y te tomamos el tuyo en parte de pago.$art$
WHERE slug = 'ios-27-cuando-llega-y-que-iphone-lo-reciben';

-- Control: los dos tienen que figurar como actualizados hoy.
SELECT slug, publicado_en::date AS publicado, actualizado_en::date AS actualizado,
       length(cuerpo) AS largo
FROM public.blog_posts
WHERE slug IN ('evento-apple-9-de-septiembre-2026-iphone-18-pro-y-el-primer-plegable',
               'ios-27-cuando-llega-y-que-iphone-lo-reciben');
