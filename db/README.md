# Base de datos — Supabase

Proyecto Supabase: `oqvmiozafgogfcclwseu`

Nada de esto se corre solo. Todo se ejecuta **a mano**, pegándolo en
**Supabase Dashboard → SQL Editor → Run**. No hay herramienta de migraciones
automática en este proyecto.

---

## `migrations/` — cambios de esquema

Cambian la estructura de la base (tablas, columnas, funciones, políticas,
constraints). Nombradas `YYYYMMDD_descripcion.sql` por fecha de creación, que es
el orden en que se aplicaron. Casi todas usan `IF NOT EXISTS` / `CREATE OR
REPLACE`, así que volver a correrlas es inofensivo.

| Archivo | Qué hace |
|---|---|
| `20260701_rls_politicas.sql` | Row Level Security: bloquea todo sin sesión, solo `usuarios_autorizados` activos leen/escriben |
| `20260703_turnos.sql` | Módulo de turnos: `turnos_slots`, `turnos_reservas` |
| `20260703_proveedores_lotes.sql` | Módulo de proveedores: `proveedores`, `lotes`, `lote_items`, `lote_pagos` |
| `20260706_cuenta_corriente.sql` | `deudas_manuales` + `deuda_pagos` |
| `20260708_ventas_cliente_email.sql` | `ventas.cliente_email` |
| `20260708_stock_movimientos_datos.sql` | `stock_movimientos.datos` (JSONB) |
| `20260708_ventas_trade_in.sql` | `ventas.trade_in_modelo`, `trade_in_valor`, `trade_in_data` |
| `20260708_venta_items_regalo.sql` | `venta_items.es_regalo` |
| `20260715_rpc_seguimiento_presupuesto.sql` | Actualiza la RPC `get_reparacion_publica` (SECURITY DEFINER) |
| `20260716_caja_movimientos.sql` | `caja_movimientos` — pasadas de mano, retiros, depósitos |
| `20260806_adelantos_socios.sql` | `adelantos_socios` |
| `20260806_blindaje_imei.sql` | Candado único por IMEI: la base rechaza duplicados |
| `20260806_caja_ledger.sql` | Libro mayor de caja + "punto 0" (foto de saldos) |
| `20260815_bucket_productos.sql` | Bucket público `productos` con las fotos de catálogo de la landing |
| `20260815_stock_vista_publica.sql` | Vista `stock_publico`: la landing ya no lee la tabla `stock` ni sus columnas de costo |
| `20260815_cambios_viene_de_venta.sql` | Marca operaciones de cueva cuya plata ya viene de una venta (evita el doble conteo del diferencial de cambio) |

> `20260815_cambios_viene_de_venta` **está aplicada** — confirmado el 18-08-2026
> contra la API: las columnas `viene_de_venta` y `cotiz_ref` existen en
> `public.cambios` (contrastado contra una columna inventada, que sí da error
> 42703, así que la prueba distingue de verdad).

---

## `scripts/` — arreglos puntuales, ya ejecutados

Scripts de un solo uso, atados a un momento y a datos concretos (IDs, IMEIs,
fechas). **No volver a correrlos**: se guardan como registro de qué se tocó y
por qué, no para reutilizar.

**Ajuste de stock contra el relevamiento físico del 30-07-2026** (corrido el
06-08-2026, en orden `01` → `13`): diagnóstico de por qué los trade-in no
entraban al stock, recuperación del iPhone 16 perdido, carga de los trade-in
faltantes, limpieza de un duplicado, asignación de IMEIs, corrección de IMEIs
mal tipeados, alta de canjes y equipos faltantes, y el cierre final que dejó el
sistema en los 33 equipos reales. Cierra con el redondeo de saldos de caja a
centavos y un fix de la config de pagos.

`20260807_01_recategorizar_cargadores.sql` recategorizó 97 cargadores de
`iphone` a `accesorio` para que no aparecieran mezclados entre teléfonos en la
landing ni distorsionaran el reporte por nicho.

---

## `pendientes/` — escritos, NO corridos

Arreglos de seguridad preparados el 15-08-2026 y todavía sin aplicar. Cada
archivo explica arriba el problema, y trae el cambio de frontend que hay que
hacer *después* de correr el SQL (si se hace al revés, se rompe la página).

| Archivo | Arregla |
|---|---|
| `stock_cerrar_acceso_anonimo.sql` | **La mitad del arreglo del stock ya está hecha** (vista creada + landing migrada). Falta borrar la política que deja leer `stock` sin login — hasta que se corra, los costos y los IMEI siguen accesibles vía API |
| `seguimiento_comentarios_rpc.sql` | El chat de seguimiento de reparaciones es legible sin token: cualquiera lee los comentarios de todas las reparaciones (y casi seguro puede escribir en la de otro cliente) |

Falta un tercer arreglo, de una línea y sin archivo propio: la RPC
`get_reparacion_publica` es `SECURITY DEFINER` pero **no fija `search_path`**.
Es el vector clásico de escalada de privilegios en Postgres. Al tocarla la
próxima vez, agregarle `SET search_path = public` debajo de `SECURITY DEFINER`
(las dos RPC nuevas de `pendientes/` ya lo traen).

---

## Tablas legibles sin login — cuáles son a propósito

Barrido de las 36 tablas de la app con la anon key (18-08-2026). Solo tres son
legibles sin sesión, y **no todas son un problema**:

| Tabla | ¿Es un problema? |
|---|---|
| `stock` | 🔴 **Sí.** 203 filas con costo, precio mayorista, proveedor, IMEI y series. Se cierra con `pendientes/stock_cerrar_acceso_anonimo.sql` |
| `seguimiento_comentarios` | 🔴 **Sí.** El token de reparación no protege el chat. Se cierra con `pendientes/seguimiento_comentarios_rpc.sql` |
| `configuracion` | ✅ **No, es a propósito.** |
| `stock_publico` | ✅ **No, es la vista pública del catálogo.** |

> ⚠️ **No cierres `configuracion` "por prolijidad".** `precios.html` lee de ahí
> `ref_blue` y `pagos_config` con la anon key: sin eso la landing no puede
> mostrar precios en pesos ni cuotas. Y no hay nada sensible — la cotización y
> los coeficientes de cuotas son justamente lo que el cliente tiene que ver.
> Si algún día se quiere ajustar, lo correcto es una política que deje leer
> solo esas dos claves, no cerrar la tabla.

Ojo con leer el barrido de más: las otras 32 tablas devolvieron 0 filas, y eso
**no distingue** "RLS la bloquea" de "está vacía". En las que sí o sí tienen
datos (ventas, personas, cajas, reparaciones) el 0 prueba que están bloqueadas.
En `inversores` o `activos_fijos` podría ser que estén vacías. Lo confirmado es
que ninguna filtra.

`comprobantes` devuelve 404: el código la referencia pero no existe en la base.

---

## Deriva entre estos archivos y la base real

Las políticas RLS que hoy dejan leer `stock`, `configuracion` y
`seguimiento_comentarios` sin login **no están en ningún archivo de acá** — se
crearon a mano en el dashboard de Supabase. O sea que correr
`migrations/20260701_rls_politicas.sql` en una base limpia **no** reproduce la
base actual.

Al tocar una política desde el dashboard, agregar también el SQL equivalente
como migración nueva.

---

## Al agregar una migración nueva

1. Crearla en `migrations/` como `YYYYMMDD_descripcion.sql`.
2. Escribirla idempotente (`IF NOT EXISTS`, `CREATE OR REPLACE`) para poder
   correrla dos veces sin romper nada.
3. Correrla en el SQL Editor de Supabase.
4. Agregar la fila a la tabla de arriba.
