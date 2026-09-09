-- Primera tanda de artículos del blog — semana del 1 de septiembre de 2026.
--
-- Entran como BORRADOR a propósito. Franco los lee en el CRM (Blog), corrige
-- lo que quiera y recién ahí toca Publicar. Nada de esto sale a la web sola.
--
-- Antes de correr esto hay que haber corrido db/migrations/20260829_blog.sql.
--
-- Los datos de actualidad están chequeados contra la fuente el 29/8/2026:
--   · Evento del 9/9: apple.com/apple-events + MacRumors 26/8/2026
--   · Ternus CEO desde el 1/9: newsroom de Apple, 20/4/2026
--   · Aranceles: Decreto 333, Infobae 20/5/2026
--   · IMEI: enacom.gob.ar/imei
-- Lo que es rumor está escrito COMO rumor. Si algo cambia después del evento,
-- hay que editar la nota: una nota vieja que afirma algo falso hace más daño
-- que no tenerla.

INSERT INTO public.blog_posts (slug, titulo, bajada, etiquetas, estado, cuerpo) VALUES

-- ─────────────────────────────────────────────────────────────────────────
('evento-apple-9-de-septiembre-2026-iphone-18-pro-y-el-primer-plegable',
 'Evento de Apple del 9 de septiembre: iPhone 18 Pro y el primer plegable',
 'Apple confirmó la fecha de su keynote de septiembre. Te contamos qué está confirmado, qué es rumor y qué significa para los precios de los iPhone que ya están en la calle.',
 ARRAY['Novedades','iPhone','Apple'],
 'borrador',
$art$
Apple confirmó lo único que hasta ahora era una fecha tentativa: el **miércoles 9 de septiembre de 2026** hace su keynote de otoño en el Apple Park, en Cupertino. La invitación llegó con el lema *"Surprise and shine"*.

Si estás en Argentina, la transmisión arranca a las **14:00 hora de Buenos Aires** (10 de la mañana en California). Se ve gratis desde el sitio de Apple, desde YouTube y desde la app Apple TV.

## Lo que está confirmado

Poco, y conviene decirlo así. Apple nunca anuncia el contenido de una keynote antes de la keynote. De boca de Apple hay exactamente cuatro cosas:

- La fecha: 9 de septiembre de 2026.
- La hora: 10 AM hora del Pacífico.
- El lugar: Apple Park, Cupertino.
- El lema: "Surprise and shine".

Hay una quinta que sí es oficial y que le da un peso distinto a este evento: **es la primera keynote de John Ternus como CEO**. Apple anunció en abril que Tim Cook pasa a ser presidente ejecutivo del directorio y que Ternus asume como CEO a partir del 1 de septiembre. Ternus entró a Apple en 2001 y venía manejando toda la ingeniería de hardware. Es decir: el tipo que va a subir al escenario es el que estuvo atrás de los productos de los últimos quince años.

## Lo que se da por hecho (pero es rumor)

Todo lo demás sale de filtraciones de la cadena de suministro y de periodistas especializados. Es información que suele acertar, pero **no es oficial hasta el 9**:

- **iPhone 18 Pro y iPhone 18 Pro Max**, con el nuevo chip A20 Pro fabricado en 2 nanómetros.
- **El primer iPhone plegable de la historia**, que la mayoría de los rumores llama *iPhone Fold* o *iPhone Ultra*. Sería de tipo libro: una pantalla exterior de alrededor de 5,5 pulgadas y una interior de unas 7,6, con una experiencia parecida a la de un iPad cuando se abre. Se habla de que usaría Touch ID en vez de Face ID y de que no tendría teleobjetivo.
- **No habría iPhone 18 "a secas" en septiembre.** Este es el cambio más raro del año: Apple estaría partiendo el lanzamiento en dos, dejando los modelos más accesibles (iPhone 18, iPhone Air 2, iPhone 18e) para la primavera del hemisferio norte de 2027.

## Qué significa esto para vos, que estás mirando un iPhone hoy

Acá va la parte práctica, que es la que en general nadie escribe.

**1. Los modelos que ya están en la calle se acomodan de precio.** Es lo que pasa todos los años, sin excepción: cuando entra la generación nueva, la anterior baja. No se derrumba —los iPhone sostienen valor mucho mejor que cualquier otro teléfono— pero se acomoda. Si estás mirando un iPhone 16 o un 17, las semanas posteriores al evento suelen ser un buen momento.

**2. Si estás por vender el tuyo, conviene antes que después.** La misma lógica al revés. El valor de reventa de tu equipo actual es más alto hoy que en octubre. Si venías pensando en cambiarlo, adelantarlo unas semanas te juega a favor. En [nuestro plan canje](/#canje) tomamos tu usado como parte de pago y te cotizamos el saldo en el momento.

**3. Un plegable de primera generación no es para cualquiera.** Vale decirlo aunque no nos convenga: los productos de primera generación de Apple casi siempre tienen una segunda versión bastante mejor. El primer Apple Watch, el primer HomePod, el primer Vision Pro. Si necesitás un teléfono confiable para los próximos cuatro años, la línea Pro es una apuesta más segura que el plegable.

## Cómo seguirlo

El 9 a las 14:00 se puede ver en vivo. Nosotros vamos a publicar acá el resumen con lo que realmente importa —modelos, memorias, y sobre todo qué pasa con los precios de los equipos usados y sellados que tenemos— en las horas siguientes al evento.

Mientras tanto, si querés ver qué hay disponible hoy con precio actualizado, está todo en [nuestro catálogo](/).
$art$),

-- ─────────────────────────────────────────────────────────────────────────
('ios-27-cuando-llega-y-que-iphone-lo-reciben',
 'iOS 27: cuándo llega y qué iPhone lo van a recibir',
 'La próxima versión de iOS llega a mediados de septiembre con una Siri rehecha de cero. Te contamos qué modelos quedan adentro, cuáles quedan afuera y si conviene actualizar apenas salga.',
 ARRAY['iOS','iPhone','Guías'],
 'borrador',
$art$
Apple mostró **iOS 27** en la WWDC de junio y la beta para desarrolladores está dando vueltas desde el 8 de junio. La versión final llega, como todos los años, **a mediados de septiembre**, junto con los iPhone nuevos.

Si tenés un iPhone y no seguís el tema de cerca, hay tres preguntas que importan: si tu modelo lo va a recibir, qué cambia de verdad, y si conviene apurarse a actualizar.

## Qué iPhone lo reciben

Según lo que se sabe hasta hoy, **iOS 27 mantiene exactamente la misma lista de compatibles que iOS 26**: funciona desde el **iPhone 11 en adelante**, más el iPhone SE de segunda generación (el de 2020) y el de tercera (2022).

Eso deja adentro:

- iPhone 11, 11 Pro y 11 Pro Max
- iPhone 12, 12 mini, 12 Pro y 12 Pro Max
- iPhone 13, 13 mini, 13 Pro y 13 Pro Max
- iPhone 14, 14 Plus, 14 Pro y 14 Pro Max
- iPhone 15, 15 Plus, 15 Pro y 15 Pro Max
- iPhone 16, 16 Plus, 16e, 16 Pro y 16 Pro Max
- iPhone 17 y toda su línea
- iPhone SE (2020) y SE (2022)

Y deja afuera al **iPhone XR, XS y XS Max**, que ya se habían quedado sin iOS 26.

Un detalle importante: que un iPhone reciba la actualización no significa que reciba *todas* las funciones. Las que dependen de Apple Intelligence necesitan modelos más nuevos y suficiente memoria. Esa distinción viene siendo la letra chica de las últimas tres versiones de iOS.

## Qué cambia de verdad

La novedad grande es **Siri**. Apple la rehízo desde cero: pasa a tener app propia y puede acceder a tus mensajes, tus fotos y tu correo para completar tareas usando tu contexto personal. También se integran asistentes de terceros.

El resto son mejoras acumuladas más que cambios de fondo: rendimiento, funciones nuevas de seguridad infantil, mejoras en la búsqueda de Mail y en Mapas.

Si venís de iOS 26, el salto visual es menor que el del año pasado —el rediseño *Liquid Glass* ya lo trajo iOS 26—. Lo que cambia es el asistente.

## ¿Conviene actualizar el primer día?

Nuestra recomendación, después de ver esto cada septiembre durante años:

**Si tu iPhone es de los últimos tres años, actualizá tranquilo**, pero esperá una o dos semanas. No porque iOS vaya a romper nada, sino porque las apps de terceros —el banco, Mercado Pago, la app del laburo— tardan unos días en actualizarse para la versión nueva. Esperar una semana te ahorra el bug tonto.

**Si tu iPhone es un 11 o un 12**, pensalo un poco más. Va a andar, pero es el modelo más viejo de la lista y las primeras versiones de un iOS nuevo suelen ir más pesadas hasta el .1 o el .2. Si el teléfono te anda bien hoy, no hay apuro.

**Antes de actualizar, en cualquier caso:** hacé una copia de seguridad en iCloud o en la computadora, y fijate que tengas al menos 10 GB libres. La mitad de los problemas de actualización que vemos en el mostrador son falta de espacio.

## Un chequeo que vale la pena hacer ahora

Andá a **Ajustes → General → Información** y mirá la versión que tenés. Si estás muy atrasado —iOS 24, iOS 25— no vas a poder saltar directo a iOS 27 sin pasar por actualizaciones intermedias, y conviene ir haciéndolo con tiempo.

Y aprovechá para mirar **Ajustes → General → Información → Batería**. Si el estado máximo de la batería bajó del 80%, la actualización te va a hacer notar más el problema: el sistema nuevo pide un poco más, y una batería gastada se apaga sola cuando le exigen.

---

Si tu iPhone ya no da para más y estás pensando en cambiarlo, en [nuestro catálogo](/) tenés el stock real con precio actualizado, y te tomamos el tuyo en parte de pago.
$art$),

-- ─────────────────────────────────────────────────────────────────────────
('por-que-bajo-el-precio-del-iphone-en-argentina-2026',
 'Por qué bajó el precio del iPhone en Argentina y qué conviene comprar ahora',
 'Desde enero de 2026 los celulares importados entran sin arancel. Explicamos qué cambió realmente, cuánto se achicó la brecha con Estados Unidos y en qué casos sigue conviniendo el usado.',
 ARRAY['Argentina','Precios','iPhone'],
 'borrador',
$art$
Durante años, comprar un iPhone en Argentina fue de las peores operaciones del mundo: el mismo equipo podía costar hasta tres veces y media lo que valía en Estados Unidos. Eso cambió, y bastante. Vale entender por qué, porque cambia la cuenta que conviene hacer.

## Qué pasó, en criollo

Fueron dos movimientos, no uno:

**Primero, el Decreto 333.** Bajó el arancel de importación de celulares del **16% al 8%**.

**Después, la suspensión total.** Desde el **15 de enero de 2026**, los celulares importados entran al país **sin pagar arancel**.

A eso se suma la baja de otros impuestos internos que pesaban sobre la electrónica. El resultado combinado es que la brecha con Estados Unidos, que era descomunal, quedó en el orden del **30%** según los números que difundió el propio Gobierno en mayo de 2026.

Un 30% de diferencia sigue siendo mucho para cualquier país normal. Pero comparado con pagar el triple, es otro mundo.

## Los números concretos

Para que no quede en abstracto, estos eran los precios de lista en tiendas oficiales **a mayo de 2026** (y conviene tomarlos como referencia histórica, no como el precio de hoy: se mueven):

- iPhone 17, 256 GB: alrededor de **$2.300.000**
- iPhone 17 Pro, 256 GB: alrededor de **$3.200.000**
- iPhone 17 Pro Max, 256 GB: alrededor de **$3.400.000**

En la tienda de Estados Unidos, un iPhone 17 Pro Max arrancaba en USD 1.199.

## Entonces, ¿ya no conviene el usado?

Acá es donde la respuesta honesta es "depende", y te explicamos de qué.

**Cuándo conviene el sellado nuevo:** si vas a un modelo de última generación, lo pensás usar cuatro o cinco años, y querés garantía de fábrica sin discusión. La brecha se achicó lo suficiente como para que la diferencia contra el usado ya no sea escandalosa en los modelos tope.

**Cuándo sigue conviniendo el usado:** en todo lo demás, y por dos razones.

La primera es la más obvia: un iPhone de una o dos generaciones atrás, en buen estado, sigue costando bastante menos que el modelo del año, y para el 90% de la gente hace exactamente lo mismo. Un iPhone 14 en 2026 saca fotos excelentes, corre iOS 27 y va a seguir recibiendo actualizaciones por años.

La segunda es menos obvia: **la baja de aranceles no cambió lo que ya estaba en el país**. Los equipos usados que circulan hoy en Argentina se compraron en otro momento y con otra estructura de costos. El mercado de usados se acomoda más lento que el de nuevos.

## Lo que sí cambió para el que compra usado

Hay un efecto secundario bueno: con menos brecha de precio, **el mercado informal pierde atractivo** y aparece más oferta formal. Eso es bueno para vos aunque compres usado, porque te da con qué comparar.

Y hay uno para tener cuidado: cuando bajan los precios oficiales, aparecen publicaciones de usados que no bajaron y que ya no tienen sentido. **Antes de cerrar cualquier compra de un usado, mirá cuánto sale ese mismo modelo sellado hoy.** Si la diferencia es menor al 25 o 30%, no vale la pena el usado.

## Cómo lo hacemos nosotros

Publicamos [todo el stock con el precio actualizado](/), sin "consultar por privado". Está el precio en pesos, el estado de cada equipo, la capacidad, el color y, en los usados, el porcentaje de batería.

También podés [entregar tu equipo actual](/#canje) como parte de pago: te cotizamos el usado y pagás solo la diferencia. En muchos casos es la forma más barata de pasar a un modelo más nuevo sin poner toda la plata de una.

Estamos en Granadero Baigorria, con oficina, seguridad y monitoreo. Si querés ver el equipo antes de pagar, se puede.
$art$),

-- ─────────────────────────────────────────────────────────────────────────
('como-saber-si-un-iphone-usado-es-original-y-no-esta-bloqueado',
 'Cómo saber si un iPhone usado es original y no está bloqueado: 6 chequeos antes de pagar',
 'La guía que usamos nosotros para revisar cada equipo. Seis chequeos que se hacen en cinco minutos y te evitan comprar un iPhone robado, con piezas cambiadas o bloqueado por iCloud.',
 ARRAY['Guías','iPhone','Comprar usado'],
 'borrador',
$art$
Comprar un iPhone usado en Argentina puede ser una excelente operación o un dolor de cabeza caro. La diferencia casi siempre está en cinco minutos de revisión que la mayoría de la gente no hace, muchas veces por vergüenza a desconfiar.

Esta es la lista que usamos nosotros con cada equipo que entra. Hacela vos también, aunque compres en un local. Un vendedor serio no se ofende: al contrario.

## 1. El IMEI, en la base de ENACOM

Este es el chequeo que **no se puede saltear nunca**, porque es el único que te dice si el equipo fue denunciado por robo.

Marcá `*#06#` en el teclado del teléfono. Aparece el IMEI en pantalla (son 15 dígitos). Anotalo y entrá a **[enacom.gob.ar/imei](https://www.enacom.gob.ar/imei)** desde tu propio teléfono, ahí mismo.

Si el IMEI figura reportado por robo o extravío, **no lo compres**. No hay precio que lo justifique: un equipo bloqueado no funciona con ninguna línea argentina y no hay forma de desbloquearlo.

Chequeá además que el IMEI de la pantalla coincida con el que figura en **Ajustes → General → Información** y con el de la caja, si la tiene.

## 2. Que sea el modelo que dicen que es

En **Ajustes → General → Información** mirá:

- **Nombre del modelo**: tiene que decir exactamente el modelo que estás comprando.
- **Número de modelo**: si empieza con **M** es un equipo nuevo de fábrica; si empieza con **F** es refabricado por Apple (refurbished, que no es malo pero vale menos); si empieza con **N** es un reemplazo por garantía.
- **Capacidad**: que sea la que te dijeron. Es de los datos que más se "estiran" en las publicaciones.

## 3. La salud de la batería

**Ajustes → General → Información → Batería** (en versiones anteriores: Ajustes → Batería → Estado de la batería).

Ahí sale el **estado máximo** en porcentaje. La referencia rápida:

- **Más de 90%**: muy bien.
- **Entre 85% y 90%**: normal en un equipo de dos o tres años.
- **Entre 80% y 85%**: usable, pero contá el costo de cambiarla en el corto plazo.
- **Menos de 80%**: hay que cambiarla. Descontalo del precio.

Si dice **"Servicio"** o directamente no muestra el porcentaje, la batería no es original o el equipo tiene un problema. Preguntá.

## 4. Piezas y servicio: el chequeo que casi nadie hace

Este es el más importante después del IMEI, y es el que separa a un equipo sano de uno "arreglado con lo que había".

En **Ajustes → General → Información**, bajá hasta el final. Si el iPhone tiene piezas cambiadas por repuestos no originales, aparece una sección que dice **"Piezas y servicio"** listando qué se cambió: pantalla, batería, cámara.

Que aparezca no siempre es descalificante —una pantalla original cambiada en un servicio oficial también puede figurar— pero **tenés derecho a saberlo y a que se refleje en el precio**. Si no aparece nada, mejor todavía.

## 5. Que no esté bloqueado por iCloud

Este es el error más caro y más común. Un iPhone con la cuenta del dueño anterior todavía activa es un pisapapeles: no se puede configurar y no hay forma de sacarlo.

La única prueba válida: **que el vendedor borre el equipo delante tuyo** desde Ajustes → General → Transferir o restablecer iPhone → Borrar contenidos y ajustes, y que arranque en la pantalla de "Hola".

Si al encenderlo pide una cuenta de iCloud que no es la tuya, el equipo está bloqueado. **No lo compres bajo ninguna promesa de que "después se destraba".**

Ojo con la variante: que te lo entreguen ya borrado pero sin haberlo desvinculado de la cuenta. Por eso el paso correcto es que lo borre **delante tuyo**, no que llegue borrado.

## 6. Lo físico, en dos minutos

Con el equipo en la mano:

- **Face ID**: probalo registrando tu propia cara. Si falla, casi siempre significa cámara frontal o pantalla cambiadas por repuesto no original, y no tiene arreglo barato.
- **Todas las cámaras**: abrí la app y probá gran angular, teleobjetivo y frontal. Sacá una foto con cada una.
- **Pantalla**: poné un fondo blanco y uno negro a pantalla completa y buscá manchas, líneas o zonas más oscuras.
- **Botones y micrófono**: subí y bajá volumen, probá el botón lateral, y grabá una nota de voz para escuchar el micrófono y el parlante.
- **Carga**: enchufalo un minuto y fijate que cargue.

---

## Un resumen para llevar en el bolsillo

1. IMEI con `*#06#` → chequealo en ENACOM.
2. Modelo y capacidad en Ajustes → General → Información.
3. Salud de la batería (menos de 80% = descuento).
4. "Piezas y servicio": que no haya repuestos no originales sin declarar.
5. Que lo borren delante tuyo y arranque en "Hola".
6. Face ID, cámaras, pantalla, botones, carga.

Si el vendedor se pone incómodo con cualquiera de estos seis puntos, esa es toda la información que necesitás.

---

En [iPhone Mood](/) hacemos esta revisión con cada equipo antes de publicarlo, y el estado y el porcentaje de batería están escritos en la ficha de cada producto. Estamos en Granadero Baigorria con oficina física: podés venir, revisarlo con esta misma lista en la mano, y recién ahí decidir.
$art$)
ON CONFLICT (slug) DO NOTHING;
