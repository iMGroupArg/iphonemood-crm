# Veredicto final de Codex sobre el cálculo de ganancia (Ventas.resultadoVenta y rubro)

Solicitado por el Moderador. Rondas: 5 (REVISAR ×4, APROBADO en la quinta). Último commit revisado: `62f2acf` (2026-11-12 08:10:50 -0300), rama landing-rediseno-2026-08. Texto de Codex, sin cambios:

VEREDICTO: APROBADO

Revisión de la rama `landing-rediseno-2026-08`, hasta `62f2acf`.
Ambos hallazgos de la ronda 4 quedaron resueltos; reproduje el comportamiento anterior y el corregido.
No encontré regresiones ni discrepancias adicionales con Reportes para ventas con precios válidos, finitos y no negativos.

| Commit | Fecha y hora — UTC−03:00 |
|---|---|
| `5e669b5` | 2026-11-11 17:12:52 |
| `14495cd` | 2026-11-12 07:52:48 |
| `6858c09` | 2026-11-12 07:57:46 |
| `e147310` | 2026-11-12 07:57:46 |
| `3fab4cc` | 2026-11-12 08:00:13 |
| `62f2acf` | 2026-11-12 08:10:50 |

**Estado de los hallazgos previos**

- **P1, ronda 4 — RESUELTO.** Reproduje los 1.000 ítems de USD 1, 500 por rubro, comisión total USD 0,04. En `3fab4cc`, las 500 filas seleccionadas sumaban comisión **0** y profit **500**, contra **0,02 / 499,98** del resumen. Ahora suman **0,019999999999999858 / 499,97999999999547**: coinciden salvo punto flotante. Evidencia: [ventas.js:302](/Users/francovelas/crm-complete/iphonemood-crm/src/modules/ventas.js:302), aplicación en [ventas.js:337](/Users/francovelas/crm-complete/iphonemood-crm/src/modules/ventas.js:337) y [ventas.js:348](/Users/francovelas/crm-complete/iphonemood-crm/src/modules/ventas.js:348).
- **P2, ronda 4 — RESUELTO.** Venta de un único rubro, precio 0, costo 1 y canal 0,50: antes `_resultadoRubro` asignaba canal **0,50**; ahora asigna **0**, conservando costo **1**, igual que Reportes. La salida anticipada exige `W > 0`: [ventas.js:139](/Users/francovelas/crm-complete/iphonemood-crm/src/modules/ventas.js:139).
- **Pagos y trade-in completos en el resumen exportado por rubro — RESUELTO.** Se prorratean en [ventas.js:141](/Users/francovelas/crm-complete/iphonemood-crm/src/modules/ventas.js:141) y se exportan desde esa vista en [ventas.js:320](/Users/francovelas/crm-complete/iphonemood-crm/src/modules/ventas.js:320).
- **Recalcular la venta parcial producía diferencias de quebranto, diferencial y canal — RESUELTO.** Se distribuye el resultado completo: [ventas.js:150](/Users/francovelas/crm-complete/iphonemood-crm/src/modules/ventas.js:150).
- **Reparto por ítem distinto del resumen por rubro — RESUELTO.** El export utiliza proporción continua sobre el precio: [ventas.js:299](/Users/francovelas/crm-complete/iphonemood-crm/src/modules/ventas.js:299).
- **Umbral que ignoraba costos reales pequeños — RESUELTO.** Cualquier costo real positivo prevalece: [ventas.js:240](/Users/francovelas/crm-complete/iphonemood-crm/src/modules/ventas.js:240).
- **Caché de órdenes desactualizado — RESUELTO.** Consulta directa de la lista actual: [ventas.js:2969](/Users/francovelas/crm-complete/iphonemood-crm/src/modules/ventas.js:2969).
- **Arnés que podía cargar otro árbol — RESUELTO.** Rutas relativas al archivo de pruebas: [cajas.test.mjs:9](/Users/francovelas/crm-complete/iphonemood-crm/tests/cajas.test.mjs:9).

**Regresiones y hallazgos nuevos**

No encontré hallazgos nuevos bloqueantes. Contrasté 10.000 casos reproducibles con la regla de [reportes.js:113](/Users/francovelas/crm-complete/iphonemood-crm/src/modules/reportes.js:113): **0 discrepancias** en margen bruto, canal, diferencial, quebranto y pendiente.

Respecto de `3fab4cc`, **sin rubro no cambia nada más que la precisión de “Comisión canal” y “Profit” por fila**, de 4 a 6 decimales. `_vistaRubro` devuelve la venta original sin filtro; `resultadoVenta`, los resúmenes y los pagos exportados no fueron modificados en esta ronda. Las ventas comunes mantienen su cálculo.

Ejecuté `node tests/cajas.test.mjs`: **471 pasan, 0 fallan; 7 problemas conocidos de otras pantallas**.

**Riesgos residuales aceptables**

- Diferencias de punto flotante y presentación del resumen a 2 decimales.
- Seis decimales reducen el error acumulado; no garantizan igualdad matemática para cantidades ilimitadas de filas.
- La equivalencia presupone precios numéricos, finitos y no negativos. Ventas limita los pesos negativos a cero; Reportes suma precios directamente.
- El profit por ítem descuenta costo y comisión; el resultado final incorpora además diferencial y quebranto. No son magnitudes equivalentes en todas las ventas.