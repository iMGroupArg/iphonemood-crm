---
name: plan-contenido-semanal
description: Armar el calendario semanal de Instagram (stories diarias + 3-4 posts) con stock y precios reales, y dejar cada pieza pendiente de aprobación. Usala en la corrida del domingo del agente de Contenido.
---

# Plan de contenido semanal

1. Leé la directiva y los datos:
   - `stock_publico`;
   - ingresos de los últimos 7 días (`stock_movimientos` de tipo alta/ingreso);
   - las notas del blog de la semana;
   - qué se publicó la semana anterior (`agente_propuestas` de `contenido`, aprobadas o ejecutadas).
2. **Mezcla de la semana:**
   - 7 a 14 stories: ingresos, "última unidad", canje, financiación, perfumería, detrás de escena;
   - 3 o 4 posts: un producto estrella, un carrusel de opciones por presupuesto, la nota del blog y prueba social.
3. **Precios y cuotas**: el mismo cálculo de `api/_social.js` (cuota del plan bancarizado publicado de más cuotas, ahorro de contado contra lista).
   - En USD con "desde" para equipos.
   - En pesos sólo para los rubros en pesos.
   - Nunca costos.
4. **Horarios** (hora de Argentina): stories a las 10:00, 13:00 y 19:30; posts a las 12:30 o 20:00. Cada pieza lleva `programada_para`.
5. **Cada pieza** es un `proponer`:
   - `tipo` `story` o `post`;
   - `clave` `contenido-<tipo>-<fecha>-<slug>`;
   - `payload` con `texto`, `productos` (ids), `formato`, `hashtags` e `imagen_url` cuando la placa ya está (skill `placa-instagram`).
   - Una de cada 5 lleva `pedir_codex: true`.
6. **Informe** `contenido-plan-<semana>` con el calendario resumido.

**Ajuste diario (8:00)**: para las piezas de hoy y mañana, si el producto ya no tiene stock, proponé reemplazarla con una `tarea` "Cambiar story X por Y" y registrá un `hallazgo`.
