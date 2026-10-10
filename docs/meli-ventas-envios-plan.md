# Mercado Libre dentro del CRM: Ventas, Envíos y barrido de ventas recientes

Análisis de complejidad y plan por fases. **Solo análisis: no se implementó nada, no se escribió en la base y no se desplegó.**
Pedido por Franco vía Moderador (09/10/2026), con dos capturas del panel de MELI como modelo.

> **Regla de lectura.** Todo lo que diga "la API devuelve X" y no esté en el código del repo está marcado **[NV] = no verificado**:
> la documentación de MELI respondió 403 a todo acceso automatizado, y lo que sé de los campos viene de conocimiento general de la API.
> La **Fase 0** existe justamente para verificarlo con datos reales *antes* de diseñar columnas.

---

## 1. Qué ya tenemos

| Pieza | Estado hoy |
|---|---|
| `meli_ordenes` | `meli_order_id`, `estado`, `estado_envio`, `comprador` (**nickname**; además `payload_orden.buyer.id`, un id numérico de MELI), `fecha_orden`, `moneda`, `bruto`, `neto`, `comision_envio` (= bruto − neto, **comisión + envío juntos**), `pago_id`, `fecha_liberacion`, banderas de proceso, `payload_orden`/`payload_pago` (resúmenes, sin mail ni documento). |
| `meli_orden_items` | `meli_item_id`, `meli_variacion_id`, `titulo`, `cantidad`, `precio_unitario`, `stock_id` (vínculo). |
| Ingesta | Por **avisos**: webhook → cola → worker → `GET /orders/{id}` + `GET /v1/payments/{id}`. Ya enruta el tópico `shipments` y guarda **solo** `estado_envio` (`shipment.status`) y la versión del envío. |
| Lectura desde el CRM | El navegador lee `meli_ordenes`/`meli_orden_items`/`meli_notificaciones` con políticas `SELECT` para cualquier usuario activo (`is_authorized_user()`); no escribe. |
| Servidor | Vercel Hobby: **12 de 12 funciones usadas**, cron **diario**, `maxDuration` 30 s. |

### Lo que falta para lo que muestran las capturas

| Dato de la captura | ¿Lo tenemos? | Falta |
|---|---|---|
| Producto, cantidad, precio del producto | Sí (items) | Solo mostrarlo |
| Fecha, estado de la venta | Sí | Mostrarlo (traducir estados) |
| **Nombre del comprador** | No (solo nickname) | [NV] ver 5; decidir si se guarda |
| **Cargo por venta** | No separado | Ver 2 |
| **Envíos** (costo para el vendedor) | No separado | Ver 2 |
| **Impuestos** | No | Ver 2 |
| Total / "podrás usar este dinero desde" | `neto` y `fecha_liberacion` | Mostrarlos |
| **Número de seguimiento** | No | Tabla de envíos |
| **Panel Envíos** (hoy / próximos / en tránsito / finalizadas) | Solo `estado_envio` suelto | Tabla de envíos con subestado y fechas |
| **Búsqueda de ventas cuyo aviso no llegó** | **No existe** | Fase 1 |

---

## 2. ¿Alcanza `fee_details` para el desglose?

**Probablemente no [NV].** `calcularFinanzas` calcula `comision_envio = bruto − neto` y registra una `diferencia_sin_explicar` contra la suma de `fee_details` del cobrador; el comentario del código dice que casi toda orden con envío de MELI tiene un costo de envío que no aparece en `fee_details`. Ese código **suma los cargos sin clasificar su tipo**, así que no prueba qué cubre `fee_details`: es una sospecha que la Fase 0 confirma o descarta mirando una orden real con envío.

Fuentes candidatas para cada línea **[todas NV]**:

| Línea | Fuente probable | Comentario |
|---|---|---|
| Precio del producto | `order_items[].unit_price × quantity` | Ya lo guardamos |
| Cargo por venta | `order_items[].sale_fee × quantity` (o `fee_details` tipo comisión) | `sale_fee` no lo guardamos hoy |
| Envíos | `GET /shipments/{id}/costs` (costo del vendedor) | Requiere un pedido más por orden |
| Impuestos | Pago de MP: `charges_details` (tipo impuesto/retención) | `fee_details` es el esquema viejo; `charges_details` puede ser el que trae impuestos |

**Diseño para no engañar:** las líneas se guardan *además* de `neto`. Reglas: (a) cada línea es `NULL` ("no disponible") si su fuente falta, nunca 0; (b) **"Otros / sin explicar" = precio − cargo − envío − impuestos − neto solo cuando las tres líneas y `neto` se conocen**; si falta alguna, no se calcula y se dice "no se puede cerrar el desglose"; (c) el total mostrado es `neto` **únicamente** si la orden está completa (`financiera_completa`), sin `revisar` (devolución, contracargo, mediación, moneda ≠ ARS) y con datos recientes; si no, se marca **"provisorio"** con el motivo. El código ya conserva importes originales en devoluciones y suma solo pagos aprobados, así que mostrar `neto` sin esas condiciones sí podría inducir a error.

---

## 3. ¿Qué trae `/shipments/{id}`? **[NV]**

Lo que se conoce de la API (a confirmar en Fase 0):
`status` (pending, handling, ready_to_ship, shipped, delivered, not_delivered, cancelled), `substatus` (por ejemplo ready_to_print, printed, in_hub…), `tracking_number`, `tracking_method` / `shipping_method`, `logistic_type` (correo/punto de despacho, Flex, Full…), `date_created`, `last_updated`, plazo estimado de entrega y **límite de despacho** (de ahí sale "a despachar hoy"), y datos del destinatario (`receiver_address`: nombre, ciudad, provincia, dirección, CP).

Lo que ya hace el código: pide `/shipments/{id}`, toma `status` y `last_updated`, y llega a la(s) orden(es) por `order_id` o por `/shipments/{id}/orders`. Hay que **ampliar lo que se guarda**, no cambiar el camino.

**Tópicos y permisos de la app.** El tópico `shipments` ya está en la lista blanca del webhook. Lo que **no puedo verificar desde acá** es (a) si Franco lo tildó en las notificaciones de la app de MELI y (b) los permisos de la app: nuestro código no manda `scope` en la URL de autorización, pero eso no prueba cómo los fija MELI **[NV]**. Que leer envíos entre en los permisos ya otorgados, y que un cambio de permisos exija reconectar la cuenta, son suposiciones **[NV]** que la Fase 0 revela (si la sonda recibe 403 en envíos, es permisos).

---

## 4. Datos personales: lo mínimo

Las capturas muestran DNI, dirección y nombre. Propuesta, de lo más a lo menos restrictivo:

| Dato | Decisión |
|---|---|
| DNI/CUIT del comprador (endpoint de facturación) | **Nunca.** No se llama a ese endpoint. |
| Dirección completa, teléfono, mail, comentarios del destinatario | **No se guardan.** |
| Nombre del comprador | **Solo si Franco lo pide y la API lo entrega sin permisos extra.** Se guarda como un único campo de texto. Si no, queda el nickname que ya tenemos. |
| Localidad y provincia | Se guardan (sirven para "a despachar" y para estadística). |
| Código de seguimiento, método/transportista, estados, fechas | Se guardan, **pero** junto a comprador/orden/localidad el seguimiento permite identificar a la persona: se trata como dato personal a efectos de retención y acceso. |

* **Tablas cerradas como las demás:** RLS activo, escritura solo por RPC con secreto, lectura por política `SELECT`. El modelo de usuarios de este CRM es de **un solo nivel** (cualquier usuario activo de `usuarios_autorizados` ve lo mismo que hoy ve de las órdenes). No hay roles, así que "qué ve cada usuario" = *todos los activos ven todo lo guardado*; por eso conviene guardar poco. Si Franco quiere que el nombre lo vea solo él, hay que crear un concepto de rol que hoy no existe (suma tamaño **M**).
* **Retención propuesta (decisión de Franco):** nombre, localidad, provincia y seguimiento se anonimizan a los 180 días de entregado, cancelado o no entregado. Se implementa en dos partes desde la Fase 2: (1) `meli_envios` guarda `cerrado_en` (cuándo pasó a estado final) y `vence_en`; la ingesta **no vuelve a poblar** datos de un envío ya vencido; (2) una **limpieza periódica** (RPC `meli_envios_vencer`, llamada por el cron diario) anonimiza los vencidos aunque nadie los vuelva a consultar. Hasta que Franco decida el plazo, nada de esto se activa.
* **Pruebas:** (1) **lista positiva** de campos que se persisten (lo que no está en la lista no se guarda, en vez de buscar claves "sensibles"); (2) validar **formato** de los valores de texto libre — hoy el webhook guarda `sent` como cadena de hasta 40 caracteres sin validar su forma; (3) la sonda y los logs de error no devuelven valores. Un test de nombres de clave solo no alcanza. `resumenPago` ya excluye mail y documento a propósito y se mantiene.

---

## 5. Barrido de ventas recientes (lo más importante)

**Problema real.** La ingesta es 100 % por avisos. Si un aviso no llega o se pierde (caso Lattafa #2000018883051330), esa venta **no entra nunca** y el CRM no tiene forma de saberlo. Una pantalla de Ventas construida sobre esto *parecería* completa sin serlo. Por eso el barrido va primero. Revisado con Codex (ronda 1): se corrigieron los huecos que siguen.

**Principio:** el barrido solo *descubre* qué órdenes hay que mirar; el procesamiento lo hace la tubería de siempre (lease por orden, idempotencia, presupuesto de tiempo). No se abre un camino nuevo de escritura de órdenes.

### 5.1 Qué se encola
Búsqueda: `GET /orders/search?seller={user_id}&order.date_last_updated.from=<desde>&order.date_last_updated.to=<hasta>&sort=date_asc&limit=50&offset=…` **[NV: nombres de parámetros, orden, límites]**. Se usa *última actualización* y no creación para recoger órdenes viejas que cambiaron (caso Armaf).
Se encola un aviso `orders_v2 /orders/{id}` cuando la orden:
* **no existe** en `meli_ordenes`; o
* existe con `meli_last_updated` anterior al de la búsqueda; o
* existe **incompleta o dudosa**: `financiera_completa = false`, `revisar`, o con una notificación `fallida`/vencida (la base ya admite repetir la misma versión para completar datos parciales, y una consulta de pagos fallida deja la orden parcial). 
Además, **cada barrido tiene un segundo paso que no consulta a MELI**: una RPC elige, de la propia base, hasta 20 órdenes por corrida de los últimos 60 días con `financiera_completa = false`, `revisar` sin resolver o con aviso `fallido`, y cuyo último intento sea anterior a un umbral, y las vuelve a encolar. Eso repara **pagos** que cambiaron sin mover el `last_updated` de la orden y órdenes incompletas que quedaron fuera de la ventana de búsqueda. Los cambios de **envío** los cubre la reconsulta de envíos abiertos (Fase 2).

### 5.2 Cola sin duplicados
`meli_notificacion_registrar` hoy inserta sin deduplicar. El índice único parcial cubre solo avisos en **estado pendiente y sin lease** (hay que exigir el estado `pendiente` explícito: `procesada_en IS NULL` también incluye fallidos y descartados) por cuenta, tópico y recurso: un aviso *en proceso* queda fuera del índice, así que se admite uno nuevo pendiente y una actualización recibida mientras se procesaba no se pierde. Como el índice también afecta al webhook, `meli_notificacion_registrar` pasa a insertar con `ON CONFLICT DO NOTHING` (un aviso ya pendiente equivale al nuevo: se va a consultar la orden entera igual). **Cierre de la carrera con el aviso en proceso:** si A está en proceso y entra B pendiente del mismo recurso, cuando A se reintenta o se devuelve su lease se libera y volvería a ser "pendiente", chocando con B en el índice (el `ON CONFLICT` del registrador no cubre esos `UPDATE`). Por eso `meli_notificacion_resultado` y `meli_notificacion_devolver` pasan a **fusionar/cerrar A de forma atómica** cuando ya existe B (A se marca absorbida por B; con B pendiente, consultar la orden otra vez cubre ambos). Todo en el mismo script SQL, con tests de las dos carreras (reintento de A con B existente, devolución de A con B existente) más webhook + barrido.

### 5.3 Ventana y cobertura (nada de "48 h fijas")
* Cada cuenta tiene un **watermark de cobertura continua** `cubierto_hasta` (en `meli_barridos`): hasta qué instante *todo* lo actualizado está encolado. Solo avanza cuando un barrido terminó **todas** sus páginas **y** dejó todo encolado de forma durable.
* `desde = cubierto_hasta − 2 h` (solape para la demora de indexación de MELI **[NV]**; el solape cubre demoras acotadas, no cualquier demora). Primer barrido: relleno inicial pedido a Franco (por defecto 30 días, en tandas).
* Si la interrupción es larga, se procesa **en tandas de hasta 7 días**, una por corrida, avanzando el watermark tanda por tanda. No se descarta historia en silencio; mientras haya tandas pendientes, la pantalla dice **"cobertura parcial hasta <fecha>"**.

### 5.4 Búsqueda sin saltos: rebanadas de tiempo, no offset
Paginar con offset sobre datos que cambian puede saltarse órdenes (una sale de la página al actualizarse y otra se corre detrás del offset), y el solape de 2 h no lo arregla. Por eso **no se pagina por offset a lo largo de la tanda**: el intervalo `[desde, hasta]` (fijado al empezar y guardado) se parte en **rebanadas de tiempo** (por ejemplo de 6 h) y de cada rebanada se piden páginas completas. Si una rebanada devuelve el tope de resultados que admite la búsqueda, se **parte a la mitad** y se repite. Una rebanada se da por cubierta solo si `ids vistos = total que informa la búsqueda` **[NV: que la respuesta informe el total y que ese total sea fiable]**; si no coincide, se reintenta y la tanda **no avanza el watermark**. El cursor persistido es la próxima rebanada pendiente (no un offset). La Fase 0 verifica qué garantiza la búsqueda (orden, total, tope) antes de dar por buena esta estrategia; si no se puede verificar `total`, la cobertura se declara "mejor esfuerzo" en la pantalla.

### 5.5 Candado de verdad
No un cooldown: un **lease** con el mismo patrón que `meli_lease_tomar` (propietario = `barrido_id` aleatorio, vencimiento corto, toma atómica por cuenta). Todas las escrituras del barrido (cursor, watermark, cierre) exigen su `barrido_id` vigente: un barrido atrasado cuyo lease venció no puede cerrar ni mover el watermark de uno posterior. Un barrido interrumpido se recupera cuando su lease vence. Además, mínimo 2 min entre barridos iniciados por botón.

### 5.6 La pantalla no certifica de más
Dos indicadores **separados**, porque encontrar ids no es lo mismo que tener los datos:
1. **"Última búsqueda completa en Mercado Libre"**: fecha de `cubierto_hasta`, y en rojo si el último barrido falló, la cuenta pide reconexión (no se muestra "0 ventas": se muestra "no se pudo consultar") o tiene más de 36 h.
2. **"Datos sincronizados"**: cuántos avisos quedan **pendientes**, cuántos **fallidos** y cuántas órdenes **incompletas**. Un barrido exitoso con 12 pendientes se muestra como "12 ventas encontradas, procesando", nunca como "todo al día".

### 5.7 Cron diario y capacidad (Hobby)
* El **cron** (una vez al día, a la hora que Vercel Hobby decida dentro de la franja) hace el barrido y **encola**. Eso entra holgado en el tiempo. Pero el worker procesa **2 avisos por corrida** (`LOTE = 2`, `worker.js`) con ~19 s útiles de consultas, y **el CRM solo drena mientras hay una pestaña visible** (`meli.js`: `_tick` sale si `document.hidden`). Sin nadie mirando, el cron no vacía una cola grande: la ve crecer, no la procesa.
* Para no depender del navegador: el cron, tras el barrido, drena con **el presupuesto que le queda** (barrido y drenaje con presupuestos separados, el barrido primero y topeado a ~8 s). Con volumen bajo de la tienda alcanza; si la cola supera lo que 1 corrida diaria puede drenar, la pantalla lo muestra (indicador 2) y se resuelve con el botón o abriendo el CRM.
* El **botón** "Buscar ventas recientes" es un POST (sesión) al mismo `worker`: hace la búsqueda y luego puede drenar un lote mayor mientras dure el presupuesto.
* **Sin funciones nuevas:** el barrido cuelga del `worker` existente (POST con acción / GET del cron).

**Riesgos del barrido:** demora de indexación de MELI **[NV]**; límites de búsqueda y de pedidos de la app **[NV]**; un barrido que falla queda en `meli_barridos` y a la vista, nunca en silencio.

---

## 6. Fases, tablas y esfuerzo (re-estimado tras la revisión)

| Fase | Contenido | Tablas / endpoint | Esfuerzo |
|---|---|---|---|
| **0. Sonda** | Acción de **solo lectura** del servidor (POST con sesión) que llama una vez a: una orden, su pago, `/shipments/{id}`, `/shipments/{id}/costs` y la búsqueda; devuelve **forma y tipos, nunca valores** (listas positivas de campos; sin logs con datos). Con casos de **múltiples pagos, devolución y envío compartido** si existen. Corrige los **[NV]**. Necesita el OK de Franco. | Ninguna tabla. Acción en `worker`. | **S–M** |
| **1. Barrido** | Todo el punto 5 + botón + cron + los dos indicadores. | Script SQL 10: `meli_barridos` (lease, intervalo, cursor, watermark, resultado), índice único parcial de avisos pendientes, RPC de encolado deduplicado, RPCs de lease. `worker` (acción + cron). Botón e indicadores en `meli.js`. Tests: pglite + **concurrencia real** (dos barridos a la vez, lease vencido, avance del watermark solo tras encolar todo). | **L** |
| **2. Envíos (modelo) y retención** | Antes que cualquier desglose: modelo del envío con **N órdenes por envío**, ingesta del tópico `shipments` ampliada y **retención aplicada desde la ingesta**. | `meli_envios` (clave `shipment_id`: estado, subestado, seguimiento, método/tipo logístico, límite de despacho, fecha estimada, localidad, provincia, `version`, costo del vendedor **una sola vez por envío**) y `meli_envio_ordenes` (puente). RPC de upsert con versión (no pisar con datos viejos). Reconsulta diaria de envíos **abiertos** (cron/botón) y limpieza de vencidos (cron). | **M–L** |
| **3. Ventas** | Lista y detalle; desglose (ver 2) con total = `neto` **solo si** la orden está completa, sin `revisar` y reciente; si no, "provisorio". Guardar `cargo_venta`, `impuestos` y la fuente de cada uno. El costo de envío viene de `meli_envios` y, si un envío cubre varias órdenes, se muestra una vez y **no se reparte** salvo que la API lo discrimine. | Columnas nuevas nulas en `meli_ordenes`; RPC de ingesta ampliada **compatible** con Ventas+Cueva. Pantalla leyendo directo con la sesión. | **M–L** |
| **4. Panel Envíos** | Pestañas (hoy / próximos / en tránsito / finalizadas) calculadas en el cliente con zona horaria Argentina; etiqueta impresa / a despachar hoy según subestado y límite de despacho. | Solo pantalla sobre `meli_envios`. | **M** |
| **5. Nombre del comprador** | Solo si Franco lo confirma y la API lo entrega sin permisos extra. | Campo en tabla cerrada, con la retención ya implementada en Fase 2. | **S** |

**Orden:** 0 → 1 → 2 → 3 → 4 (→ 5). El barrido va antes de cualquier pantalla; el modelo de envío antes del desglose de costos.
Correspondencia con lo que propuso Ventas+Cueva: su F1 (detalle, solo UI) se apoya en la Fase 3 sin esperar a la API para lo que ya está en base (producto, fecha, estado, `neto`, `fecha_liberacion`); su F2 (envío e impuestos) = Fases 0 y 2 y la parte de impuestos de la 3; su F3 (panel) = Fase 4; su F4 = integración final.
Cada fase se entrega con script SQL numerado (lo corre Franco), tests y revisión de Codex, como Vincular.

### Plan Hobby de Vercel
* **Funciones:** 12 de 12. Se evita crear funciones: el barrido y la sonda cuelgan del `worker`; las pantallas leen la base directo. Un endpoint extra se suma al despachador (`conectar.js` con `_f`), que ya hospeda `publicaciones`.
* **Cuándo pasar a Pro:** si hace falta algo que Hobby no da — frecuencia de cron menor a diaria (drenaje sin pestaña abierta), más de 30 s por invocación, o más de ~2 endpoints nuevos sobre el despachador. Es una decisión de costo de Franco; no se necesita para la Fase 0 ni la 1.
* **Tiempo:** 30 s por invocación; el barrido pagina y retoma desde el cursor guardado.

## 7. Riesgos de depender de la API de MELI
* Campos y límites **[NV]** hasta la Fase 0; el código ya falla del lado seguro (NULL, nunca 0).
* Tokens: access 6 h, refresh de un solo uso (dato de la implementación existente, a confirmar en la doc oficial **[NV]**); ya resuelto, pero el barrido agrega más llamadas que dependen de que la cuenta esté conectada. Si está en "reconectar", el barrido debe decirlo, no devolver "0 ventas".
* Límites de tasa de la app [NV]; el volumen de la tienda es bajo.
* Cambios de MELI sin aviso: por eso se guarda un resumen del payload (no el crudo con datos personales) y los tests usan respuestas simuladas por fase.
* Nuestro webhook no verifica firma (decisión del repo, partiendo de que MELI no firma los avisos **[NV]**): todo lo que se muestre sale de una consulta con nuestro token, nunca del aviso.

## 7b. Resultado de la sonda real (10/10/2026, cuenta IMSTORE_, solo forma de los campos)

Se ejecutó el diagnóstico en producción. **Todas las consultas dieron 200**: los permisos de la app alcanzan para órdenes, pagos, envíos, costos de envío y búsqueda. Lo que quedó **verificado** (ya no es [NV]):

| Tema | Resultado |
|---|---|
| Búsqueda | `GET /orders/search?seller=…&sort=date_asc&limit=5&order.date_last_updated.from=…` funciona y devuelve `paging {total, offset, limit}` y **las órdenes completas** en `results` (pagos, ítems, envío). En las últimas 48 h había 4 órdenes; en total (recientes) **14**. La estrategia de rebanadas con verificación de `total` (5.4) es viable. |
| `fee_details` | **Vacío** (0 elementos) en el pago real. Confirmado: **no sirve** para el desglose. Hoy `comision_declarada` queda en 0 y toda la retención aparece como "sin explicar". |
| Cargo por venta | `order_items[].sale_fee` (número, por unidad) existe, y `listing_type_id` (`gold_special`). |
| Impuestos | `charges_details[]` del pago de Mercado Pago: 3 cargos, con `type` (se vio `tax`), `name`, `rate`, `amounts.original`. `payments[].taxes_amount` también está en la orden. De los otros 2 cargos no se vio el `type`. |
| Envío (costo del vendedor) | `GET /shipments/{id}/costs`: `gross_amount`, `senders[].cost`, `senders[].discounts[]`, `senders[].charges`, `receiver.cost`. |
| Neto | `amounts.collector.net_received` en el pago. **Pendiente de confirmar** que `transaction_details.net_received_amount` (el que usa la ingesta) esté: el diagnóstico cortó el listado a 60 campos y dejó "6 campos más" sin mostrar. |
| Envío | `status`, `substatus` (venía `null` en uno entregado), `logistic_type` (`drop_off`), `tracking_number`, `tracking_method`, `status_history.date_*` (despacho, listo para enviar, entregado), `substatus_history[]`, `order_id`, `shipping_option` con `estimated_delivery_time/limit/final`, `estimated_schedule_limit`, `buffering`, `processing_time`, `shipping_method_id`, `name`, `cost`. Con `order_id` en el envío, el camino de la ingesta por aviso de envío ya funciona. |
| Falta | El **límite de despacho** ("a despachar hoy") no apareció: la muestra era un envío ya entregado. Hay que ver un envío en `ready_to_ship` para saber qué campo lo da. |
| Datos personales | La orden trae `buyer.first_name`, `last_name` y `billing_info.id`; el envío trae nombre, teléfono, dirección y coordenadas del destinatario. **Nada de eso se guarda hoy** (`resumenOrden` conserva solo id y apodo del comprador) y el plan sigue sin guardarlo. |

**Siguiente paso propuesto (otra pasada de la sonda, solo lectura):** (a) mostrar todos los campos (subir el tope de 60), (b) listar los `type` de **todos** los cargos de `charges_details`, (c) un modo "conciliación" que devuelva **solo importes** (precio, cargo por venta, cada cargo por tipo, costo de envío del vendedor, neto) de las últimas 6 órdenes y diga si `precio − cargo − impuestos − envío = neto`, y (d) estado y subestado de esos envíos y los nombres de los campos de fecha de `shipping_option`. Los importes son del negocio, no de compradores.

## 8. Preguntas para Franco
1. ¿Querés el **nombre** del comprador, o alcanza con el usuario (nickname) + localidad?
2. ¿Aceptás borrar nombre y localidad a los 180 días de entregado?
3. ¿Que cualquier usuario activo del CRM vea estos datos (como hoy con las órdenes), o querés que sea solo vos? (Lo segundo es trabajo extra.)
4. ¿Das el OK para correr la **Sonda** (Fase 0, solo lectura) sobre la cuenta real?
5. ¿Confirmás en el panel de MELI que el tópico **Envíos** (`shipments`) está tildado?
