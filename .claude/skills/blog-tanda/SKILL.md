---
name: blog-tanda
description: Escribir la tanda semanal de 4 notas del blog (novedades de Apple, iPhone, guías de compra) como borradores con fuentes citadas. Usala cuando le toque al agente de Landing.
---

# Tanda de blog (4 notas)

1. Mirá qué hay ya publicado: `leer` con `{"vista":"blog_posts","columnas":["slug","titulo","estado","publicado_en"],"orden":"creado_en","limite":40}`. No repitas temas.
2. Buscá en la web las novedades de la semana (Apple Newsroom, soporte de Apple, medios serios).
   - **Cada dato lleva su fuente.**
   - Los rumores se escriben como rumores ("según reportes de…").
3. Cada nota tiene:
   - entre 500 y 900 palabras;
   - el markdown reducido de `api/blog.js` (`##`, listas, `**negrita**`, `[link](url)`, `> cita`);
   - un cierre que lleve a la tienda sin prometer stock. Si mencionás un equipo concreto, chequeá `stock_publico`.
4. Una de las cuatro es "evergreen": una guía de compra o de cuidado de batería, o una comparativa entre modelos que sí hay en stock.
5. Cargá cada nota:
   ```bash
   node agentes/mesa.mjs blog nota.json
   ```
   El JSON lleva `slug`, `titulo`, `bajada`, `cuerpo`, `etiquetas` y `fuentes`. Queda como borrador y avisa en la mesa sola. Franco la revisa y publica desde CRM → Blog.
