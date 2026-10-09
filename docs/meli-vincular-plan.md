# Mercado Libre — pantalla "Vincular publicaciones" (PLAN v3)

> **ESTADO (2026-10-09): CONSTRUIDA y probada.** Código revisado por Codex (3 rondas + confirmaciones), pruebas con Postgres real
> (pglite, una conexión) y **con varias conexiones a la vez** (`tests/sql/vincular.concurrencia.test.mjs`, `npm run test:concurrencia`,
> 42 checks: espera real verificada con `pg_blocking_pids`, esfuerzo con dos avisos en orden cruzado, mutaciones que producen deadlocks
> y se detectan). El requisito "concurrencia obligatoria antes de desplegar" quedó **cumplido**; Codex aprobó el banco.
> **Riesgo que NO cubre:** la competencia por las últimas unidades de stock contra ventas locales o reposiciones (el esfuerzo usa stock
> abundante y sólo actores de Mercado Libre). Es previo a esta función y lo cubre `stock_ajustar`, no esta pantalla.
> Motor de las pruebas de concurrencia: PostgreSQL 18 (beta) vía `embedded-postgres`; Supabase corre otra versión.

Estado: **plan v3, corregido tras la revisión de Codex (rondas 1 y 2: REVISE)**; la ronda 3 aportó los puntos de esta versión.
Pedido por el moderador el 2026-10-07; Franco pidió construirla. Autor: Deploy-infra.

## Por qué va primero

Una orden de Mercado Libre trae un item (`MLA…`, a veces una variación). Para descontar stock hay que saber **qué fila de `stock`** es.
Ese vínculo vive en `meli_publicaciones` (`cuenta_id, meli_item_id, meli_variacion_id → stock_id`) y **ninguna pantalla lo crea**.
Sin vínculo, `meli_ingresar_orden` deja el item con `stock_id NULL`, la orden en `revisar` y `meli_procesar_orden` la rechaza (`ITEMS_SIN_VINCULAR`).

Negocio (Franco): **perfumería** (no iPhone, no "a pedido"), publicaciones **sin SKU**. El tamaño vive dentro del `nombre` del stock
("Teriaq 100ml"): **cada tamaño es una fila de stock distinta**.

## Diseño (v3: corrige las rondas 1 y 2 de Codex)

La v1 re-resolvía las órdenes abiertas **al vincular** con `stock FOR SHARE` y después `orden FOR UPDATE`: orden inverso al de procesar → deadlock posible, y una orden que
se estuviera ingresando quedaba fuera. La v2 sacó eso, pero dejaba una ventana entre revalidar y descontar. **v3:**

### El vínculo vigente se aplica al procesar, y queda congelado hasta que el descuento confirma

- `meli__revalidar_orden(orden)` (**interna**, `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`, probado con esos roles). Con la orden ya bloqueada `FOR UPDATE`:
  1. Si la orden está procesada o descontada → no hace nada (se revisa **después** de obtener el lock).
  2. Lee los vínculos de sus ítems **con `SELECT … FROM meli_publicaciones … ORDER BY id FOR SHARE`**. Ese lock se **mantiene hasta el final de la transacción**:
     cualquier cambio o desvinculación de ese aviso (que toma `FOR UPDATE` sobre la misma fila) **espera a que el descuento termine**. Esto cierra la ventana: lo que se descuenta es
     exactamente el vínculo que se leyó. Si el cambio llega después, la orden ya está procesada y no se toca (histórico).
  3. Recalcula `stock_id` de cada ítem **exclusivamente con los valores que devolvió esa misma lectura bloqueada** (una sola sentencia: `UPDATE meli_orden_items … FROM (SELECT … FOR SHARE) …`),
     **sin volver a consultar `meli_publicaciones`**: bajo READ COMMITTED una segunda consulta podría ver un vínculo insertado después, que no quedó congelado. Las claves **ausentes** se conservan como NULL
     (autoritativo; también NULL si el vínculo tiene `stock_id` NULL o `cantidad <= 0`). **Si queda algún ítem sin stock, el helper AGREGA el motivo `Hay ítems sin publicación vinculada`
     (con `meli_agregar_motivo`) y pone `revisar = TRUE`**, no sólo quita motivos.
  4. Quita del motivo, **por frase exacta**, `Hay ítems sin publicación vinculada` (si ya no queda ningún ítem sin vincular) y `Hay ítems con cantidad inválida` (si todas las cantidades son > 0),
     con el helper puro `meli_quitar_motivo(texto, frase)` (separador ` · `, el mismo de `meli_agregar_motivo`). Sólo si el motivo queda vacío pone `revisar = FALSE`.
     **Cualquier otro motivo se conserva y la orden sigue en revisar.** Devuelve la fila de la orden **ya actualizada**.
- **`meli_procesar_orden` (Ventas+Cueva)** llama al helper justo después de bloquear la orden y **recarga su variable `o`** con lo que devuelve (si no, `o.revisar` quedaría viejo y lanzaría
  `ORDEN_EN_REVISION`, deshaciendo todo). Se coordina con Ventas+Cueva. **Se prueba Procesar directamente sobre una orden sin vincular, sin revalidación previa de la pantalla.**
- **Revalidar desde la pantalla** (para que Franco vea "lista para procesar" sin tocar nada): RPC **por orden** `meli_orden_revalidar(orden)` (`authenticated` + `is_authorized_user()`,
  `SET LOCAL lock_timeout = '3s'`, devuelve estado claro si la orden está ocupada). **No hay RPC masiva**: la pantalla llama una por una (transacciones separadas), **sólo para las órdenes afectadas**
  (las abiertas con ítems de ese aviso, leídas por RLS), con un tope por acción (50); el resto se hace al volver a abrir. Los locks no se acumulan entre órdenes.

### Protocolo de bloqueos (único)

`lease → orden → vínculo (publicación) → stock`. Procesar (revalida y descuenta): `orden → vínculo(SHARE) → stock`. Reponer y revertir: `orden → stock` (por stock_id), sin vínculos: no revalidan, el histórico no se reescribe. **Vincular/desvincular: `vínculo(UPDATE) → stock(SHARE)`, nunca orden.**
Importante: el `INSERT … ON CONFLICT` dispara el trigger `BEFORE INSERT` (que toma `stock FOR SHARE`) **antes** de bloquear la fila existente → orden `stock → vínculo`, inverso al de procesar.
Por eso la RPC **no usa ON CONFLICT**: hace primero `SELECT … FROM meli_publicaciones WHERE clave FOR UPDATE`, **después** `SELECT … FROM stock FOR SHARE`, y recién entonces `UPDATE` (si la fila existe) o `INSERT`
(si no existe, no hay fila que otro pueda tener tomada). El caso "no existía y aparece justo" falla seguro: procesar vio "sin vínculo" → `revisar`, nunca un stock equivocado.
**Dos usuarios que vinculan por primera vez el mismo aviso:** ven la clave ausente, y el segundo `INSERT` termina en `23505` sobre **`meli_publicaciones_unica`**. La RPC captura **esa** violación
(comprobando el nombre del índice, no cualquier `23505`) y la traduce a `VINCULO_CAMBIO_CONCURRENTE`, **sin sobrescribir al ganador y sin reintentar dentro de la misma transacción**: reintentar con los
locks de stock ya tomados reintroduciría el orden `stock → vínculo`. La pantalla recarga y el usuario decide.
Nadie toma una orden estando bloqueado por un vínculo o por un stock.

### Semántica de cambiar y desvincular

- **Cambiar:** las órdenes abiertas pasan al nuevo stock en su próxima revalidación (antes de procesar siempre). Procesadas/descontadas **no** cambian.
- **Desvincular = `UPDATE stock_id = NULL` + `version + 1`** (la fila **se conserva**: así la versión no se reinicia al recrear y siempre hay una fila que bloquear). Las órdenes abiertas de ese aviso quedan sin vincular
  (`revisar`) hasta que se vuelva a vincular. No se conserva el stock viejo: desvincular suele corregir un error y descontar del producto equivocado es peor que esperar.
  **La pantalla avisa antes: "N órdenes pendientes quedarán sin vincular"**, contando **órdenes distintas** de esa cuenta/aviso/variación **excluyendo procesadas y descontadas**.
- **Control de cambios concurrentes:** `meli_publicaciones.version INTEGER NOT NULL DEFAULT 1`; cambiar/desvincular exigen `p_version_esperada`; si no coincide → `VINCULO_CAMBIO_CONCURRENTE`
  (la pantalla recarga). **Historial** insert-only `meli_vinculos_historial(cuenta, item, variación, stock_anterior, stock_nuevo, usuario, en)`.
- `vinculado_por` sale **sólo de `emailAutorizado` (servidor)**, nunca del cuerpo de la petición.

### Lecturas por RLS

`GRANT SELECT` **explícito** para `authenticated` en `meli_ordenes`, `meli_orden_items`, `meli_publicaciones`, `meli_vinculos_historial` (con sus políticas SELECT), y se prueba el conteo con un
usuario autorizado real (rol `authenticated` con claims), no con el dueño.

## (a) Endpoint — `api/meli/publicaciones.js`

- **GET** `?cuenta=<id>[&offset=<n>][&estado=active|paused]` o **`?item=<MLA…>`** (consulta directa de un aviso por id: para llegar desde una orden aunque el aviso
  ya esté cerrado y no aparezca en el listado). Autenticación como `worker.js` POST: `x-crm-token` → `emailAutorizado`; `limitar()`; `Cache-Control: no-store`.
- **Deadline absoluto `t0` al entrar**, con reserva para el refresco del token y la persistencia (patrón de `_meli.js`: `presupuestoHasta`). Una página de 20 items por llamada.
- Listado: `GET /users/{id}/items/search?status=…&limit=20&offset=…` (`offset` ≤ 950; el tope de la API es 1000: si `paging.total > 1000` se avisa y se indica que hace falta
  `search_type=scan`, fuera de alcance de la v1) y después los **detalles en lote**.
- **Contrato con MELI aislado en un adaptador** (`api/_meli_items.js`) que acepta **las dos formas** del lote: `GET /items?ids=` con elementos `{code, body}` y
  `GET /items/bulk` con elementos `{id, status_code, body}` (Codex indica que desde octubre de 2026 se usa `/items/bulk` con atributos `body.*`; **no pude verificarlo**, la
  documentación devuelve 403). Se usa una constante para elegir y la **primera llamada real decide**. Errores **por elemento** se informan como error de ese elemento,
  no como "aviso desaparecido". Ids siempre como **strings**.
- `meli_user_id` sale de la base (por id de cuenta), no del navegador. `cuenta` entero positivo ≤ 2^31; se comprueba que exista y esté activa.
- Respuesta **saneada**: `{id, titulo≤200, precio, estado, cantidad, permalink, miniatura, variaciones:[{id, etiqueta, cantidad, precio}]}`. URLs validadas con `new URL()`:
  `permalink` sólo con hostname `mercadolibre.com.ar` o sufijo `.mercadolibre.com.ar`; `miniatura` sólo `https:` con hostname `mlstatic.com` o sufijo `.mlstatic.com`. Sin tokens
  ni cuerpos de error de MELI. Parseo tolerante: forma inesperada → `RESPUESTA_INESPERADA`.
- Validación estricta de entradas: tipos, parámetros repetidos (se rechazan), longitudes, regex de ids (`^ML[A-Z]\d{5,15}$`, variación `^\d{1,20}$`), `stock_id` UUID.

## (b) Selector de producto del stock

- La pantalla consulta `stock` con columnas mínimas: `id, nombre, categoria, cantidad, estado_inventario, a_pedido, imeis` (`State.stock` no trae `a_pedido` ni `imeis`
  de rubros sin IMEI; no se toca ese mapeo compartido).
- **Vendible físico:** `a_pedido = false` **y** `categoria ∉ (iphone, android, mac, ipad)` **y** `imeis` vacío **y** `estado_inventario ≠ 'eliminado'`. Por defecto sólo
  `perfumeria` y `decant`, con interruptor "mostrar otros rubros". Se permiten filas con stock 0 o `vendido` (con etiqueta).
- **Sugerencias** (hasta 3, nunca automáticas): palabras en común entre título y `nombre`, **exigiendo el mismo tamaño en ml** cuando el título lo trae.
- Todo se **escapa** al renderizar (títulos, etiquetas, nombres).

## (c) Guardar — servidor + RPC con el patrón existente

- **POST** `/api/meli/publicaciones` `{cuenta, item, variacion|null, stock_id, version|null}` y **DELETE** (desvincular), mismo `x-crm-token`.
  1. El servidor consulta `GET /items/{item}` con el token de la cuenta: el aviso existe, `seller_id` es el de la cuenta, y:
     **si el aviso tiene variaciones, `variacion` es obligatoria y tiene que existir** (si no tiene, tiene que ser `null`). Se guarda la **cantidad de la variación elegida**.
  2. RPC `meli_publicacion_vincular(secreto, cuenta, item, variacion, stock_id, version_esperada, titulo, cantidad, usuario)`.
- **Desvincular se permite aunque el aviso o la variación ya no existan en MELI** (no consulta a MELI; vínculos locales viejos tienen que poder limpiarse).
- La RPC valida **bajo `FOR SHARE` de la fila de stock**: existe y no es `eliminado` (`STOCK_INEXISTENTE`), no es `a_pedido` (`A_PEDIDO_NO_SE_VINCULA`), sin IMEIs y de rubro sin IMEI
  (`STOCK_CON_IMEI`). Upsert idempotente por `(cuenta, item, COALESCE(variación,''))` + chequeo de `version`.
- Una fila de stock **puede** estar en varias publicaciones; la pantalla lo avisa.
- **Permisos exactos (transporte anon + secreto, igual que el resto de `meli_*`):** las RPC con secreto tienen `GRANT EXECUTE … TO anon, authenticated` y **fallan en la primera línea sin secreto
  válido**, sin efectos. `meli_orden_revalidar` (sin secreto, una orden por llamada): sólo `authenticated` + `is_authorized_user()`. La tabla `meli_publicaciones`: política **SELECT** para
  `is_authorized_user()` y `REVOKE INSERT, UPDATE, DELETE, TRUNCATE` de `PUBLIC, anon, authenticated`; se revisan también privilegios por columna y otras políticas permisivas existentes.

## Arreglo de una laguna preexistente en el descuento (la encontró la revisión)

`meli__descontar_core` comprueba el faltante **por ítem**, no **sumado por producto**: dos avisos distintos de la misma orden que apuntan al mismo stock podían pasar el
chequeo cada uno y fallar al descontar el segundo (la transacción se deshace, sin descuentos parciales, pero con una excepción en vez de un `revisar` claro). Se corrige
sumando por `stock_id` en el chequeo previo.

## (e) Cómo se ve en la orden

Cada ítem muestra "→ Stock: <nombre>" o una marca roja **"Sin vincular"** con botón **"Vincular"** (abre la pantalla en el aviso, por consulta directa por id). **Procesar** queda deshabilitado
con el motivo mientras haya ítems sin vincular. Esto vive en `meli-ordenes.js` (Ventas+Cueva): cambio mínimo, **lo aplica Ventas+Cueva o yo con su OK**. La pantalla nueva es un módulo propio
(`src/modules/meli-vincular.js`) montado desde `meli.js` con una línea.

## Archivos

| Pieza | Archivo |
|---|---|
| SQL (script **7**, idempotente) | `db/pendientes/meli_vincular.sql` |
| Endpoint | `api/meli/publicaciones.js`, adaptador `api/_meli_items.js`, `vercel.json` (`maxDuration`) |
| Pantalla | `src/modules/meli-vincular.js`, montaje en `meli.js`/`app.js` |
| Pruebas | `tests/sql/vincular.sql.test.mjs` (pglite) · `tests/meli_vincular.test.mjs` (endpoint con MELI simulado + pantalla en vm) |

## Pruebas planeadas

- **SQL (Postgres real, pglite, una conexión), además de lo anterior:** Procesar directo sobre orden sin vincular; `meli__revalidar_orden` no ejecutable por `anon`/`authenticated`; cantidad 0 → positiva → vínculo → Procesar (se limpia el motivo de cantidad); orden que conserva OTRO motivo sigue en `revisar`; conteo de afectadas con rol `authenticated` real; desvincular conserva la fila y sube la versión; la RPC de vincular no usa `ON CONFLICT` (se verifica en el texto del SQL; el efecto del lock se prueba con **dos conexiones**, abajo). Y lo básico: vincular/cambiar/desvincular/idempotencia; versión y `VINCULO_CAMBIO_CONCURRENTE`; rechazos (a_pedido, IMEI, rubro IMEI, inexistente, eliminado);
  secreto falso sin efectos; tabla sin escritura para `anon`/`authenticated`; **revalidar:** NULL → stock, stock viejo → nuevo, desvincular → NULL + `revisar` (y el motivo se AGREGA), el motivo "cantidad inválida"
  **se limpia sólo cuando todas las cantidades pasan a ser > 0** (y se conserva mientras exista una inválida), `cantidad = 0` no recibe stock, doble `INSERT` → `VINCULO_CAMBIO_CONCURRENTE`, motivos múltiples, procesadas/descontadas **intactas**, error a mitad de la revalidación revierte todo; **dos avisos al mismo stock con
  cantidades sumadas insuficientes → cero descuentos y cero ventas**; historial; re-ejecutable dos veces; helper `meli_quitar_motivo`.
- **Endpoint (MELI simulado):** auth, validación, parámetros repetidos, ambas formas de lote (`items?ids=` y `bulk`), error por elemento, 429/timeout, ids grandes como string,
  títulos y URLs maliciosos, aviso de otro vendedor, variación inexistente, aviso con variaciones sin `variacion`, desvincular con aviso inexistente, `Cache-Control: no-store`,
  sin fuga de tokens ni de cuerpos de error, deadline.
- **Pantalla (vm):** filtro de vendible físico, sugerencias con mismo ml, una fila por variación, escape de HTML, aviso de órdenes afectadas, errores.
- **Concurrencia real (dos conexiones) — OBLIGATORIA antes de desplegar**, no opcional. pglite tiene una sola conexión, así que hace falta un Postgres de verdad: `embedded-postgres`
  (paquete npm de desarrollo en `tests/sql`, **descarga binarios de Postgres**: necesita el OK de Franco para instalarlo). Con barreras entre conexiones se prueba, verificando que la **segunda conexión realmente espera**
  y el resultado final: (1) cambiar/desvincular **durante** Procesar → espera y la orden se descuenta con el vínculo leído; (2) aparición de un vínculo nuevo durante Procesar → la orden queda en `revisar`, sin descuento;
  (3) doble INSERT del mismo aviso → una gana, la otra `VINCULO_CAMBIO_CONCURRENTE`; (4) vincular vs. ingesta de una orden nueva; (5) ausencia de deadlock en las intercalaciones anteriores. Si no se aprueba
  instalarlo, la pantalla puede construirse y commitearse, pero **no se despliega** sin esas pruebas (o sin que Franco acepte el riesgo por escrito).

## Riesgos que sólo se resuelven con datos reales

1. Formas exactas de la API de MELI (`items/search`, lote `items`/`bulk`, `variations`, `attribute_combinations`, `seller_id`): parseo tolerante + primera llamada real.
2. Límite de 1000 resultados de `items/search`.
3. Las sugerencias por texto pueden proponer mal: por eso nunca confirman solas.

## Consulta para Stock (su sesión no está viva; queda en `project_pendientes.md`)

1. ¿"Vendible físico" (sin a_pedido, sin IMEI, rubro ∉ iphone/android/mac/ipad, no eliminado) es la regla correcta? ¿Se puede vincular una fila con stock 0 o `vendido`?
2. ¿Dos publicaciones pueden apuntar al mismo stock?
3. Decants: ¿cada tamaño es siempre una fila propia? ¿Hay frascos "fraccionados" con otra lógica de descuento?
4. ¿Hay avisos que vendan packs o kits (multiplicador de unidades)? Hoy 1 unidad vendida = 1 unidad de stock.
5. ¿Algún estado (`reservado`, `en_reparacion`) que impida descontar por Mercado Libre aunque haya cantidad?
