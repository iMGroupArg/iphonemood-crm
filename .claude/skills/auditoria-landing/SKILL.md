---
name: auditoria-landing
description: Auditoría semanal de la landing iphonemood.com: fotos faltantes, disponibilidad inventada, links, SEO y velocidad. Usala en la corrida semanal del agente de Landing.
---

# Auditoría de la landing

1. **Fotos.**
   - Por cada producto de `stock_publico`, resolvé la foto con la misma convención de `precios.js` / `api/_social.js` (bucket `products`).
   - Si faltan, armá **una** `tarea` con la lista exacta de nombres de archivo esperados. Clave: `landing-fotos-<semana>`.
2. **Disponibilidad inventada.**
   - Buscá en `precios.html` y en la `configuracion` pública (banner, secciones) textos que nombren modelos o colores.
   - Contrastalos con `stock_publico`. Ejemplo conocido: la sección del iPhone 18. Franco decidió dejar sus 4 colores, así que no lo vuelvas a marcar.
3. **Técnica.**
   - `curl -sI` a `/`, `/precios`, `/blog`, `/sitemap.xml`, `/robots.txt`.
   - Revisá los links del sitemap (no más de 50).
   - Corré PageSpeed sin clave: `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://iphonemood.com&strategy=mobile`.
4. **Informe** `landing-auditoria-<fecha>`, con lo nuevo respecto de la semana anterior arriba.
5. Si un arreglo es de código, no lo hagas en esta corrida: proponé una `tarea` "¿Arreglo X?" y esperá el OK.
