---
name: mesa
description: Cómo hablar con la mesa de control (leer el negocio, proponer, registrar en bitácora). Usala en TODA corrida de un agente de iPhoneMood antes de tocar la base.
---

# Mesa de control

Todo acceso a la base pasa por `node agentes/mesa.mjs`. Es la **ventanilla**: funciones fijas por la API de Supabase, con la clave del agente (`AGENTES_CLAVE`).
- **No hay conexión SQL ni forma de mandar SQL**, a propósito: en Supabase una conexión directa podría mandar datos a internet.
- Si alguna vez tenés a mano una cadena de conexión o `psql`, no la uses. Registrá un `hallazgo`.

No hace falta instalar nada: usa el `fetch` de Node.

## Leer
```bash
node agentes/mesa.mjs vistas                       # qué vistas y columnas hay (empezá por acá)
echo '{"vista":"ventas","columnas":["id","fecha_venta","estado"],"columna_fecha":"fecha_venta","desde":"2026-10-27","hasta":"2026-11-03","orden":"fecha_venta","limite":500}' | node agentes/mesa.mjs leer -
```
- Campos de `leer`:
  - `vista` (obligatorio);
  - `columnas` (lista; sin ella, todas);
  - `filtros` (igualdad: `{"estado":"abierta"}`, o `null` para "vacío");
  - `columna_fecha` + `desde` (incluido) / `hasta` (excluido);
  - `orden`, `desc` (por defecto `true`) y `limite` (máximo 2000).
- **No hay agregaciones en la base**: traé las filas que hacen falta (sólo las columnas que usás) y sumá, agrupá o compará vos.
- Si una vista o columna no existe, la respuesta lo dice (`VISTA_INEXISTENTE`, `COLUMNA_INEXISTENTE`). No la inventes.
- Las vistas no traen secretos, datos personales, texto libre (descripciones, notas) ni JSON del negocio. Si algo hace falta, pedíselo a Franco como `tarea`.

## Escribir (JSON en un archivo, o `-` para stdin)
| acción | campos |
|---|---|
| `proponer` | `agente`, `tipo`, `titulo`, `resumen`, `payload` (objeto), `programada_para` (ISO con -03:00), `clave`, `auto`, `pedir_codex` |
| `registrar` | `agente`, `corrida`, `nivel` (`info`/`hallazgo`/`error`), `mensaje`, `datos` |
| `directiva` | `semana`, `texto`, `prioridades` (lista) — sólo el CEO |
| `pauta` | `gasto_al_dia`, `gasto_proyectado` — sólo Pauta |
| `blog` | `slug`, `titulo`, `bajada`, `cuerpo`, `etiquetas`, `fuentes` — sólo Landing |
| `codex` | `id`, `veredicto`, `texto` — **sólo desde la Mac** (`REVISOR_CLAVE`) |

- Tipos que esperan a Franco: `post`, `story`, `campana`, `ajuste_presupuesto`, `tarea`. Cada uno con campos de `payload` cerrados: si mandás uno de más, se rechaza.
- Tipos informativos: `informe`, `cierre`, `pr`, `blog`, `alerta`.
- **La `clave` (de idempotencia) es obligatoria en la práctica**: `<agente>-<qué>-<fecha>[-<detalle>]`. Repetir la corrida no duplica.
- Probar sin tocar la base: `MESA_ENSAYO=1 node agentes/mesa.mjs proponer archivo.json`.

## Al empezar y al terminar
1. Leé la directiva: `{"vista":"agente_directivas","orden":"semana","limite":1}`.
2. Al final, registrá en la bitácora un `info` con qué hiciste (o un `error` con qué falló). Usá un `corrida` común, por ejemplo `<agente>-<fecha>-<hora>`.
