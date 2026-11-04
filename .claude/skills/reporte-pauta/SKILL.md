---
name: reporte-pauta
description: Reporte diario de Meta Ads: leer resultados, reportar el gasto a la mesa y proponer ajustes o campañas dentro de las reglas del tope. Usala en la corrida diaria del agente de Pauta.
---

# Reporte de pauta

1. **Sin `META_TOKEN_LECTURA`** (Fase 1):
   - registrá `info` "Meta todavía no conectado";
   - los lunes proponé 1 o 2 campañas `pendiente` basadas en stock y directiva, para que Franco las cargue a mano;
   - terminá.
2. **Con token**, leé de la Graph API (sólo `GET`): `act_<id>/insights` del mes, por campaña, con `spend`, `impressions`, `reach`, `frequency`, `ctr` y `actions` (conversaciones de mensajería). Leé también los presupuestos diarios de las campañas activas.
3. **Reportá el gasto** (siempre, antes de cualquier ajuste):
   ```bash
   echo '{"gasto_al_dia": 123456.78, "gasto_proyectado": 400000}' | node agentes/mesa.mjs pauta -
   ```
   `gasto_proyectado` = gasto del mes + suma de presupuestos diarios activos × días que quedan del mes, contando hoy.
4. **Ajustes**: pasá presupuesto de las campañas con peor costo por consulta a las de mejor costo, con 3 días de datos como mínimo.
   - Cada movimiento es un `ajuste_presupuesto` con `auto: true`, `payload.incremento_diario_ars` y `campana_id`.
   - La base decide si queda automático.
   - **Las bajadas van primero.**
5. **Campañas nuevas**: `campana` con `pedir_codex: true`. Sólo con productos que tengan stock para toda la duración.
6. **Lunes**: `informe` `pauta-semanal-<semana>` con costo por consulta, qué se movió y por qué.
   - Recordá que una consulta no es una venta.
   - Si cruzás con `ventas`, decí que es una estimación.
