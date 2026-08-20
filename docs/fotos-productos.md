# Fotos de producto de la landing

`precios.html` no toma la foto de cada artículo del stock: la busca sola en el
bucket público `products` de Supabase Storage, armando el nombre a partir de
los datos del producto. En la mayoría de los rubros usa categoría + modelo +
storage + color; en perfumería y repuestos usa el nombre completo (ver abajo).

## Antes de empezar

Correr una vez en el SQL editor de Supabase:
`db/migrations/20260818_bucket_products.sql`

Eso crea el bucket `productos` como público y deja la lectura anónima abierta
(subir y borrar sigue requiriendo estar logueado).

## Cómo se arma el nombre

Todo en minúscula, sin acentos, con guiones en lugar de espacios y de barras.
"iPhone 17 Pro" + "Naranja Cósmico" → `iphone-17-pro-naranja-cosmico`.

La landing prueba de más específico a más genérico y se queda con la primera
que exista:

| Orden | Patrón | Ejemplo |
|---|---|---|
| 1 | `categoria-modelo-storage-color` | `repuesto-iphone-14-128gb-negro.png` |
| 2 | `categoria-modelo-color` | `repuesto-iphone-14-negro.png` |
| 3 | `categoria-modelo` | `repuesto-iphone-14.png` |
| 4 | `modelo-storage-color` | `iphone-14-128gb-negro.png` |
| 5 | `modelo-color` | `iphone-14-negro.png` |
| 6 | `modelo` | `iphone-14.png` |
| 7 | — | emoji de la categoría |

Se acepta `.png` y `.jpg`; conviene `.png` porque conserva el fondo
transparente de las fotos de prensa.

**Perfumería, gaming y otros rubros de nombre libre usan `nombre`, no `modelo`.** En esos dos rubros el
CRM reutiliza los campos: en perfumería `modelo` es la MARCA, `color` la familia
olfativa (Árabe/Nicho/Diseñador) y `storage` la concentración (EDP/EDT); en
repuestos `modelo` es el equipo compatible, no la pieza. Por eso ahí el nombre
del archivo sale del nombre completo del producto
(`club-de-nuit-intense-man-edp-100ml.png`, `vidrio-camara-iphone-13.png`) y no
se le agregan color ni storage.

**El prefijo de categoría existe para desambiguar** cuando dos rubros comparten
nombre de modelo. Se prueba antes que el nombre pelado.

**El comodín sin tamaño** es el último recurso de la cadena: de `khamrah-5ml.png`
se cae a `khamrah.png`. Pensado para decants, donde la misma fragancia se vende
en varios volúmenes con la misma foto.

**El campo `imagen_url` del stock se ignora** (decisión de Franco, 2026-08-18):
la única fuente de fotos es el bucket. Sin foto en el bucket → emoji.

## Con qué conviene empezar

Con los nombres de **modelo solo**: cada uno cubre todos los artículos de ese
modelo sin importar el color. Las variantes por color son opcionales y se
pueden agregar después, de a una, sin tocar nada más.

Lista generada del stock disponible al 2026-08-18 (80 tarjetas, sobre 185 filas de stock):

### iphone
- `iphone-14.png` — 2 artículos
    - `iphone-14-amarillo.png` (opcional, por color)
    - `iphone-14-rojo.png` (opcional, por color)
- `iphone-14-pro-max.png` — 1 artículo
    - `iphone-14-pro-max-negro-espacial.png` (opcional, por color)
- `iphone-15.png` — 1 artículo
- `iphone-16-pro-max.png` — 3 artículos
    - `iphone-16-pro-max-titanio-desierto.png` (opcional, por color)
    - `iphone-16-pro-max-titanio-natural.png` (opcional, por color)
    - `iphone-16-pro-max-titanio-negro.png` (opcional, por color)
- `iphone-17-pro.png` — 3 artículos
    - `iphone-17-pro-naranja-cosmico.png` (opcional, por color)
    - `iphone-17-pro-plata.png` (opcional, por color)
- `iphone-17-pro-max.png` — 2 artículos
    - `iphone-17-pro-max-azul-profundo.png` (opcional, por color)
    - `iphone-17-pro-max-plata.png` (opcional, por color)

### accesorio
- `cargador-20w.png`
- `cargador-original-20w-usa.png`
- `funda-13-14.png`
- `funda-13-pro.png`
- `funda-13-pro-max.png`
- `funda-14-pro.png`
- `funda-14-pro-max.png`
- `funda-15.png`
- `funda-15-pro.png`
- `funda-15-pro-max.png`
- `funda-16.png`
- `funda-16-pro.png`
- `funda-16-pro-max.png`
- `funda-17.png`
- `funda-17-pro.png`
- `funda-17-pro-max.png`
- `templado-11.png`
- `templado-11-pro-max.png`
- `templado-12-pro-max.png`
- `templado-13-pro-13.png`
- `templado-13-pro-max.png`
- `templado-14-pro-14.png`
- `templado-14-pro-max.png`
- `templado-15-pro-15.png`
- `templado-15-pro-max.png`
- `templado-16.png`
- `templado-16-pro.png`
- `templado-16-pro-max.png`
- `templado-17.png`
- `templado-17-pro.png`
- `templado-17-pro-max.png`
- `usb-c-lightning.png`
- `usb-c-usb-c.png`

### audio
- `airpods-4.png`
- `jbl-flip-6.png`

### perfumeria — perfumes (18)
- `acqua-di-gio-profondo-edt-100ml.png`
- `armaf-club-de-nuit-intense-man-edt-100ml.png`
- `armaf-club-de-nuit-woman-edt-105ml.png`
- `armaf-odyssey-mandarinsky-edp-100ml.png`
- `barre-al-oud-honor-and-glory-edp-100ml.png`
- `club-de-nuit-intense-man-edp-100ml.png`
- `club-de-nuit-women-10ml.png`
- `lattafa-amethyst-edp-100ml.png`
- `lattafa-fakhar-gold-edp-100ml.png`
- `lattafa-khamrah-dukhan-edp-100ml.png`
- `lattafa-khamrah-edp-100ml.png`
- `lattafa-teriaq-edp-100ml.png`
- `lattafa-the-kingdom-edp-100ml.png`
- `lattafa-yara-candy-edp-100ml.png`
- `mandarin-sky-edp-100ml.png`
- `paco-rabanne-invictus-edt-100ml.png`
- `ralph-lauren-polo-red-edp-200ml.png`
- `rasasi-hawas-malibu-edp-100ml.png`

### decant — 32 productos, solo 16 fotos
Cada archivo cubre la versión de 5ml y la de 10ml de la misma fragancia: el
nombre va **sin el tamaño**. Si alguna vez querés diferenciarlas, subí también
`khamrah-5ml.png` y esa le gana a la genérica.

- `asad-bourbon.png`
- `badee-al-oud-amethyst.png`
- `black-orchid.png`
- `club-de-nuit-intence.png`
- `club-de-nuit-women.png`
- `fakhar-gold.png`
- `hawas-malibu.png`
- `his-confession.png`
- `khamrah.png`
- `khamrah-dukhan.png`
- `khamrah-qahwa.png`
- `mandarin-sky.png`
- `teriaq-intence.png`
- `the-kingdom.png`
- `yara-candy.png`
- `yata-moi.png`

### combo
Todavía no hay combos cargados. Cuando cargues uno, la foto sale del nombre
del combo (`combo-arabes-x3.png`).
### repuesto — YA NO SE PUBLICA
Desde el 2026-08-18 los repuestos no se muestran en la landing (son consumo
interno del taller). No hace falta subirles foto.


### gaming
- `playstation-5-digital-con-2-juegos.png`
- `playstation-5-slim-digital-1tb-2-juegos.png`

### otro
- `termo-stanley-legendary-1lt.png`
- `termo-stanley-legendary-classic-1-1lt.png`
- `vaso-stanley-quentcher-0-9lt.png`

> Corregido el 2026-08-18: las PlayStation pasaron al rubro nuevo `gaming` y
> los Stanley a `otro`. Ya no hay nada mal categorizado como iPad.

## Cosas raras que aparecieron en los datos

- **Los perfumes están cargados de dos formas distintas.** 3 usan los campos
  estructurados como corresponde (marca en `modelo`, familia en `color`,
  concentración en `storage`) y 16 tienen todo metido en `nombre` con barras.
  La landing maneja las dos formas, así que se ven bien igual, pero conviene
  emparejarlas desde el CRM.
- ~~Los Stanley y la PlayStation en `ipad`~~ — corregido el 2026-08-18.
