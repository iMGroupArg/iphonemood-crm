---
name: placa-instagram
description: Generar la placa (imagen) de una story o post de Instagram desde la plantilla HTML de la marca, pasarla a PNG y subirla al bucket contenido. Fase 2: usala cuando el entorno tenga navegador sin pantalla y acceso al bucket.
---

# Placa de Instagram (Fase 2)

**Estado: preparada, todavía no activa.** Hace falta la plantilla `contenido/plantillas/` (se hace en la Fase 2 con Franco, siguiendo la identidad visual de la landing) y el bucket `contenido` público.

## Cuando esté activa
1. Elegí la plantilla según el formato: story 1080×1920 o post 1080×1350.
2. Completala con datos de la base: foto del producto (bucket `products`, misma convención que `precios.js`), nombre, capacidad (`storage_label`), "desde USD X", cuota.
   - **Nada escrito a mano que no salga de la base.**
3. Pasala a PNG con Playwright: `npx playwright screenshot --viewport-size=1080,1920 file://.../placa.html placa.png`.
4. Subila al bucket `contenido` con un nombre estable (`<clave>.png`). Esa `imagen_url` va en el `payload`.
5. Mirá el PNG antes de proponer: que el texto no se corte y que la foto se vea. Si algo falla, proponé la pieza sin imagen y registrá el `hallazgo`.
