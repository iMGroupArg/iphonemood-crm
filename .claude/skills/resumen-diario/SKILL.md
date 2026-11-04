---
name: resumen-diario
description: Resumen diario del CEO: números de ayer y de la semana, stock crítico, propuestas trabadas, errores y conflictos entre agentes. Usala en la corrida diaria del CEO.
---

# Resumen diario (CEO)

Seguí la skill `mesa` para leer y escribir.

1. **Ventas.** Las de ayer y las de los últimos 7 días contra los 7 anteriores: cantidad, USD y margen si está disponible.
   - Mirá antes las columnas reales de `ventas`, `venta_items` y `venta_pagos`.
   - Las ventas de Mercado Libre se distinguen por las columnas `meli_*` o `tipo_venta`.
2. **Stock crítico.**
   - Productos de `stock_publico` con 1 unidad.
   - Equipos de los modelos más vendidos de la semana sin unidades.
3. **Mesa.**
   - Propuestas `pendiente` de hace más de 24 h, agrupadas por agente.
   - `error` en la bitácora de las últimas 24 h.
   - Corridas que faltaron: un agente sin registro hoy cuando le tocaba.
4. **Conflictos.** Cruzá:
   - stories y posts aprobados o pendientes de las próximas 48 h contra el stock actual;
   - campañas activas o pendientes contra el stock;
   - lo último del blog contra el catálogo.
5. **Escribí** un `informe` con clave `ceo-diario-<AAAA-MM-DD>`.
   - Título: "Resumen del <día>".
   - `resumen`: máximo 15 líneas.
   - Los detalles van en `payload`.
   - Cerrá con las 3 líneas: qué está bien, qué preocupa y qué te necesita.
6. **Lunes**: además, `directiva` de la semana con 3 a 5 prioridades medibles (por ejemplo "vender 3 iPhone 15 usados", "subir las 20 fotos que faltan de perfumes").
