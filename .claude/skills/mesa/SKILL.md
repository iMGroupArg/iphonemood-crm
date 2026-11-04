---
name: mesa
description: Cómo hablar con la mesa de control (leer el negocio, proponer, registrar en bitácora). Usala en TODA corrida de un agente de iPhoneMood antes de tocar la base.
---

# Mesa de control

Todo acceso a la base pasa por `node agentes/mesa.mjs`. **Nunca** uses `psql` ni armes SQL pegando texto: los textos de clientes y de la web pueden traer comillas armadas a propósito.

Preparación (una vez por corrida): `cd agentes && npm install --silent && cd ..`

## Leer
```bash
node agentes/mesa.mjs leer "SELECT fecha_venta, count(*) FROM ventas WHERE fecha_venta >= current_date - 7 GROUP BY 1 ORDER BY 1"
```
- Sólo `SELECT`/`WITH`, una consulta, transacción de sólo lectura, máximo 2000 filas.
- Las tablas se nombran sin esquema: son las vistas de `agentes`.
- Vistas disponibles: `ventas`, `venta_items`, `venta_pagos`, `gastos`, `cajas`, `caja_ledger`, `stock`, `stock_publico`, `cierres_mensuales`, `meli_ordenes`, `blog_posts`, `agente_propuestas`, `agente_bitacora`, `agente_directivas`, `pauta_config`, `cotizaciones` y otras.
- Si una vista no existe, esa tabla no está en la base: decilo, no la inventes.
- Para ver qué columnas tiene: `SELECT column_name FROM information_schema.columns WHERE table_schema='agentes' AND table_name='ventas'`.

## Escribir (JSON en un archivo, o `-` para stdin)
| acción | campos |
|---|---|
| `proponer` | `agente`, `tipo`, `titulo`, `resumen`, `payload` (objeto), `programada_para` (ISO con -03:00), `clave`, `auto`, `pedir_codex` |
| `registrar` | `agente`, `corrida`, `nivel` (`info`/`hallazgo`/`error`), `mensaje`, `datos` |
| `directiva` | `semana`, `texto`, `prioridades` (lista) — sólo el CEO |
| `codex` | `id`, `veredicto` (`aprobado`/`objeciones`), `texto` |
| `pauta` | `gasto_al_dia`, `gasto_proyectado` — sólo Pauta |
| `blog` | `slug`, `titulo`, `bajada`, `cuerpo`, `etiquetas`, `fuentes` — sólo Landing |

- Tipos que esperan a Franco: `post`, `story`, `campana`, `ajuste_presupuesto`, `tarea`.
- Tipos informativos: `informe`, `cierre`, `pr`, `blog`, `alerta`.
- **La `clave` es obligatoria en la práctica**: `<agente>-<qué>-<fecha>[-<detalle>]`. Repetir la corrida no duplica.
- Probar sin tocar la base: `MESA_ENSAYO=1 node agentes/mesa.mjs proponer archivo.json`.

## Al empezar y al terminar
1. Leé la directiva: `SELECT texto, prioridades FROM agente_directivas ORDER BY semana DESC LIMIT 1`.
2. Al final, registrá en la bitácora un `info` con qué hiciste (o un `error` con qué falló). Usá un `corrida` común, por ejemplo `<agente>-<fecha>-<hora>`.
