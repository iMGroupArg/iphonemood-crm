# Facturas de Mercado Libre — Fase 1: plan del SQL (script 16)

Fecha: 2026-10-13. Estado: PLAN, sin escribir ni correr nada. Contrato de datos: `docs/facturas-meli-f1-spec.md`.
Alcance: solo la base (tabla, historial, RPC, permisos, verificación). La pantalla la hace otra sesión.

## 1 · Objeto
Registrar, por cada orden de Mercado Libre, si tiene factura: `pendiente` (por defecto, sin fila), `emitida` (con número y fecha) o `no_corresponde` (con motivo). El CRM no emite nada, no edita importes, no guarda datos del comprador y no reparte ventas.

## 2 · Piezas
1. `public.meli_facturas` — una fila por orden.
   - `orden_id TEXT PRIMARY KEY REFERENCES meli_ordenes(meli_order_id)` (es UNIQUE en esa tabla). Sin ON DELETE CASCADE: el registro fiscal no debe desaparecer si borran una orden (NO ACTION).
   - `estado` ∈ pendiente | emitida | no_corresponde, `numero`, `emitida_el DATE`, `motivo`, `marcada_por`, `marcada_en`.
   - CHECK de coherencia por estado: emitida → `numero ~ '^[0-9]{4}-[0-9]{8}$'`, punto de venta ≠ 0000, comprobante ≠ 00000000, `emitida_el` no nulo, sin motivo; no_corresponde → motivo 1–200 sin caracteres de control, sin número ni fecha; pendiente → los tres nulos.
   - Índice único parcial sobre `numero` WHERE estado='emitida': un comprobante no puede estar en dos órdenes (error `NUMERO_REPETIDO`).
2. `public.meli_facturas_historial` — registro append-only de cada cambio (orden, estado anterior/nuevo, número, fecha, motivo, quién, cuándo). Lo llena un trigger AFTER INSERT/UPDATE de `meli_facturas`. Sin UPDATE ni DELETE para nadie (trigger que lo rechaza). Es lo que conserva el número cuando se "reabre" una factura.
3. Trigger BEFORE DELETE en `meli_facturas` que siempre falla (`FACTURA_NO_SE_BORRA`).
4. RPC `meli_factura_marcar(p_orden text, p_estado text, p_numero text, p_emitida_el date, p_motivo text) RETURNS jsonb`, SECURITY DEFINER, `search_path = public, pg_temp`, `is_authorized_user()` obligatorio.
   - Normaliza (btrim, '' → NULL) y valida lo mismo que los CHECK, con códigos propios: `ESTADO_INVALIDO`, `NUMERO_INVALIDO`, `FECHA_INVALIDA` (nula, futura —según la fecha de Argentina, `America/Argentina/Buenos_Aires`— o anterior a 2020-01-01), `MOTIVO_INVALIDO`, `ORDEN_INEXISTENTE`.
   - Bloquea la orden `FOR SHARE` y luego hace `INSERT ... ON CONFLICT (orden_id) DO UPDATE` con `WHERE` de transición, para que dos usuarios a la vez no se pisen.
   - Transiciones permitidas: (sin fila|pendiente) → emitida | no_corresponde; emitida|no_corresponde → pendiente ("reabrir"); repetir exactamente el mismo dato = idempotente (`ok`, `sin_cambios: true`). Cambiar de emitida directamente a otro número, o de emitida a no_corresponde, NO se permite: hay que reabrir primero (`FACTURA_YA_EMITIDA`). Es lo que obliga a que el cambio de número quede en el historial.
   - `marcada_por` sale del JWT (nombre completo o email), nunca de un parámetro.
   - Se puede marcar una orden revertida o cancelada (puede haber una factura emitida que luego se anula); lo que cambia es que la pantalla no la cuenta como "sin factura".
5. Permisos: RLS activada en ambas tablas; política SELECT solo `is_authorized_user()`; sin políticas de escritura. `REVOKE ALL` de PUBLIC, anon, authenticated (los privilegios por defecto de Supabase otorgan todo a los nuevos objetos) y `GRANT SELECT` a authenticated. La RPC: `REVOKE ... FROM PUBLIC, anon`, `GRANT ... TO authenticated`.
6. Script idempotente, con transacción, con guardas iniciales (`meli_ordenes` y `is_authorized_user` existen) y tabla de verificación final 16.1–16.n (todo ✅). No cambia ningún dato existente.

## 3 · Privacidad y retención
- Ninguna columna de comprador, DNI/CUIT ni dirección. El motivo es texto libre: se rechaza si contiene 7 o más dígitos seguidos (`MOTIVO_INVALIDO`) para que nadie pegue un DNI/CUIT ahí.
- No hay limpieza automática: ni los 180 días de contactos del bot ni nada de este script toca estas tablas.

## 4 · Pruebas (todas locales, nada en producción)
- `tests/sql/facturas_meli.sql.test.mjs` (pglite): cada transición permitida y prohibida, CHECK por estado, número repetido, fecha futura/antigua, motivo con 7 dígitos, historial (reabrir conserva el número), DELETE rechazado, permisos (anon y authenticated sin escritura directa; sin usuario autorizado → 42501), idempotencia, `marcada_por` ignora cualquier intento de pasarlo.
- `tests/sql/facturas_meli.concurrencia.test.mjs` (embedded-postgres, conexiones reales): dos usuarios marcan la misma orden a la vez (gana uno, el otro recibe `FACTURA_YA_EMITIDA` o `sin_cambios`); dos órdenes con el mismo número a la vez (una falla con `NUMERO_REPETIDO`); marcar mientras la orden se procesa/revierte no se bloquea cruzado (sin deadlock). Mutaciones: sin el índice único y sin la cláusula WHERE de transición, el banco tiene que fallar.

## 5 · Qué NO hace
No emite facturas ni habla con ARCA; no valida contra importes de la orden; no sugiere agrupar ventas ni topes fiscales; no ofrece emisor distinto de Franco Ezequiel Velas.

## 6 · Preguntas abiertas para la revisión
- ¿FK a `meli_ordenes(meli_order_id)` sin cascada es lo correcto, o conviene guardar el texto sin FK por si se purga alguna vez la orden?
- ¿Un comprobante por orden (índice único) puede ser demasiado estricto (carrito de varios paquetes con una sola factura)?
- ¿Bloquear `FOR SHARE` la orden vale la pena, o alcanza con el `ON CONFLICT`?
- Piso de fecha 2020-01-01 y regla de 7 dígitos en el motivo: ¿razonables?

## 7 · Cambios tras la revisión de Codex (ronda 1: VERDICT REVISE)
Aceptados, se incorporan al script:
- **Versión optimista.** `meli_facturas.version BIGINT NOT NULL DEFAULT 1`; la RPC recibe `p_version_esperada BIGINT` (NULL = la orden no tenía fila) y, si no coincide, responde `FACTURA_CAMBIO_RECARGAR`. Evita que una pantalla vieja pise o borre lo que otra persona registró. Cambia el contrato con la UI (un parámetro más y la versión en el `select`).
- **Transiciones cerradas.** Solo: sin fila|pendiente → emitida | no_corresponde, y emitida|no_corresponde → pendiente (reabrir). Rechazados sin reabrir: emitida→otro número, emitida→no_corresponde, no_corresponde→emitida, no_corresponde→otro motivo. Repetición exacta (campos normalizados, `IS NOT DISTINCT FROM`) = `sin_cambios`, no toca quién/cuándo/versión y no agrega historial. Si el `WHERE` del upsert no devuelve fila, se trata como error explícito, nunca como éxito. `unique_violation` se traduce a `NUMERO_REPETIDO` solo si el nombre del índice es el del número.
- **Privacidad.** Se elimina la regla de los 7 dígitos y el texto libre: el motivo pasa a un **catálogo cerrado** validado en la base (`no_es_venta_real`, `cancelada_o_devuelta`, `factura_global_de_otro_periodo`, `exenta_o_no_gravada`, `otro_ver_nota_interna`), sin observaciones libres. Nada del comprador, de payloads ni de respuestas de Mercado Libre llega a estas tablas.
- **Privilegios.** `REVOKE ALL` también a `service_role` y sobre secuencias; `EXECUTE` de las funciones de trigger revocado a PUBLIC/anon/authenticated/service_role; solo `SELECT` para authenticated (política `FOR SELECT TO authenticated`) y `EXECUTE` de la RPC pública; `IF public.is_authorized_user() IS NOT TRUE`; `search_path = ''` con todo calificado. La verificación 16.x comprueba los grants reales por catálogo, no por suposición.
- **Integridad.** `estado NOT NULL`; emitida exige `numero IS NOT NULL` y `emitida_el IS NOT NULL` (los CHECK dejan pasar NULL); `orden_id` inmutable; historial con valores anteriores y nuevos completos y `auth.uid()` además del nombre; historial solo ante cambios efectivos; bloqueo de TRUNCATE (trigger por sentencia) en ambas tablas; comentario en las tablas: reabrir no anula fiscalmente un comprobante y cancelar/revertir la orden no toca su factura.
- **Lock.** `FOR KEY SHARE` sobre la orden (orden → factura → historial), nunca se actualiza la orden desde el trigger.
- **Piso de fecha 2020 eliminado**: fecha obligatoria y no futura según Argentina.
- **Pruebas añadidas:** reapertura desactualizada, cambios de no_corresponde, idempotencia sin historial extra, rollback conjunto factura/historial, reutilización de un número tras reabrir, NULL en constraints, TRUNCATE, accesos con service_role; concurrencia con barreras y timeout (no solo dos promesas juntas).

Pendientes de decisión de Franco (no se resuelven desde el SQL):
1. **Tipo de comprobante** (A/B/C…): ¿F1 asume un único tipo (por ejemplo, todo Factura C) o se registra el tipo junto al número? Define la unicidad del comprobante.
2. **Comprobante repetido en otra orden:** ¿un número = una orden (índice único estricto), o puede una factura cubrir varias órdenes? Y si se reabre una y el número aparece en otra, ¿es una corrección legítima? Mi propuesta: estricto, y la corrección se hace reabriendo (queda en el historial).
3. **Motivo como catálogo cerrado** en lugar de texto libre (cambia el contrato y la UI de Codex; los textos de la lista son propuestos).
