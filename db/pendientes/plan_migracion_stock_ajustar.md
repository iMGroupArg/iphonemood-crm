# Plan v2: migrar 2 llamadas de stock a `stock_ajustar` (revisado tras ronda 1 de Codex)

## Cambios respecto de la v1, con el motivo

**ABANDONO el cambio de orden en (B).** Codex tiene razón: reordenar no hace seguras dos
peticiones independientes, solo mueve el riesgo de "vínculo sin descuento" a "descuento sin
vínculo", que es peor (la unidad desaparece del inventario sin que nada la reclame).
Y compensar con +1 ante un error de TRANSPORTE es peligroso: el error no prueba que la
escritura no ocurrió, así que se podría reponer una unidad efectivamente vendida.

**El estado final correcto es una RPC que vincule y descuente en UNA transacción.**
Eso es de Deploy-infra y lo voy a pedir como seguimiento. No bloquea esta migración porque
lo de abajo ya es una mejora estricta sobre lo que hay hoy.

## A) Helper en src/modules/supabase-config.js

### A.0 — Clasificación de resultados (regla transversal, ronda 2)

Tres resultados, NUNCA dos. Un fallo no prueba que no se escribió:

    { ok:true, fila }                      UNA fila devuelta -> escritura CONFIRMADA
    { ok:false, confirmado:true,  error }  rechazo IDENTIFICABLE de la base -> NO escribió
    { ok:false, confirmado:false, error }  INCIERTO -> no se sabe si escribió

`confirmado:true` SOLO ante un rechazo identificable de Postgres (código de error conocido de la
RPC en error.message: STOCK_INSUFICIENTE, IMEI_REQUERIDO, ESTADO_INCONSISTENTE, STOCK_INEXISTENTE,
IMEI_NO_ESTA, DELTA_INVALIDO, 'no autorizado'). La mera presencia de `error.message` NO alcanza.

Caen en INCIERTO: excepciones de red/transporte, timeouts, y respuestas con CERO o MÁS DE UNA fila
(una respuesta inválida no demuestra que la escritura se revirtió).

**Ante INCIERTO nunca se compensa, nunca se reintenta solo, y el mensaje al usuario dice
VERIFICAR, no CORREGIR.**

    async ajustarStock({ stockId, delta, tipo, detalle, imei = null, estadoDestino = null })

- llama supa.rpc('stock_ajustar', {...}), incluye p_imei / p_estado_destino SOLO si vienen
- **valida que vuelva EXACTAMENTE UNA fila**; si vuelven 0 o más de 1 -> { ok:false }
- distingue tres resultados, no dos:
    { ok:true, fila }                       escritura confirmada
    { ok:false, error, confirmado:true }    la base rechazó (error.message con el código) -> NO escribió
    { ok:false, error, confirmado:false }   error de transporte -> resultado INCIERTO, no compensar

Helper separado `refrescarFilaStock(item, fila)`:
- actualiza `cantidad`, `cantidadDeclarada` y `estadoInventario` juntos desde la fila confirmada
- usa `fila.cantidad` para ambos contadores (`cantidad` y `cantidadDeclarada`) y
  `fila.estado_inventario` para el estado
- **PRESERVA LA CONVENCIÓN DE `imeis`**: la carga usa arreglo para rubros con IMEI y `undefined`
  para el resto. Solo asigna `fila.imeis` si `Array.isArray(item.imeis)`. Nunca convierte
  `undefined` en `[]`.
  Motivo (lo encontró Codex): `State.getStock()` toma la rama de IMEI cuando `p.imeis` es un
  arreglo AUNQUE ESTÉ VACÍO, y varios guards del código son `if (!item.imeis)`. Convertir un
  accesorio a `[]` rompería silenciosamente esos guards — por ejemplo la devolución de
  repuestos de (C) dejaría de devolver accesorios.
  Dentro de esa rama, normalizar `fila.imeis === null` a `[]`: la RPC puede devolver el arreglo
  nulo y un producto con IMEI debe conservar su representación como arreglo.

## B) src/modules/ventas.js ~566 — Ventas.asignarStockReal

**Orden: se mantiene como está** (vincular -> descontar). Cambios:

1. **Arreglar `DB.vincularItemVentaAStock`** (supabase-config.js ~896): hoy devuelve `true`
   aunque el UPDATE afecte CERO filas, porque solo mira `error` y no `data`. Pasar a
   `.select('id')` y exigir que vuelva una fila. (Es el mismo bug que ya se había corregido en
   `actualizarPrecioStock` con `count !== 0` y se reintrodujo acá.)
2. Rama `cerrada`: reemplazar las tres líneas (descontarStock + actualizarImeisStock +
   actualizarCantidadStock) por **una** `ajustarStock({ delta:-1, imei, tipo:'baja_venta',
   detalle:'Vendido — Venta #<id>' })` y refrescar memoria desde el resultado.
3. **Quitar el `DB.registrarMovimientoStock` de la rama cerrada**: la RPC ya inserta el
   movimiento dentro de su transacción. Mantener los dos duplicaría el movimiento en el
   historial. (La rama abierta SÍ conserva su movimiento, porque ahí no se llama a la RPC.)
4. Si el descuento falla (confirmado o incierto): **se conserva el vínculo ya confirmado**, la
   función devuelve un resultado de FALLO PARCIAL, y **NO se ejecutan la nota cruzada ni el
   mensaje de venta exitosa**. No se muta memoria. El vínculo sin descuento es un estado VISIBLE
   (el item aparece vinculado en la venta) y corregible a mano, a diferencia de hoy, donde la
   escritura absoluta pisa en silencio.
   - CONFIRMADO: mensaje con el código real de la RPC, indicando qué corregir.
   - INCIERTO: mensaje de VERIFICAR el stock antes de tocar nada. Sin compensación.

   **CONTRATO CON EL CONSUMIDOR — `Ventas._confirmarAsignar` (ventas.js).** Hoy hace
   `const ok = await this.asignarStockReal(...); if (!ok) return;`. Si `asignarStockReal` pasa a
   devolver un objeto, `!{ ok:false }` es **false** en JavaScript y el flujo seguiría como si
   todo hubiera salido bien: cerraría el modal y mostraría la venta como completa. Hay que
   adaptar el consumidor EN EL MISMO CAMBIO. Resultado estructurado:

       { ok:true }                                        todo salió
       { ok:false, parcial:true, confirmado, mensaje }    vínculo hecho, descuento o reserva NO
       { ok:false, parcial:false, mensaje }               no se hizo nada (validaciones previas)

   Con `parcial:true` (falla el descuento de la rama cerrada **o** la reserva de la abierta):
   el modal se cierra y se refresca la venta — porque el vínculo SÍ quedó y hay que verlo —,
   se muestra el aviso del fallo, y NO se corren la nota cruzada ni el mensaje de éxito.
   Como el ítem ya quedó vinculado, la guarda `if (it.stockId)` del arranque impide repetir la
   asignación como si no hubiera pasado nada: el reintento avisa que ya está vinculado, que es
   el comportamiento correcto (lo que falta es el descuento, no el vínculo).
5. Rama `abierta`: hoy ignora el resultado de `DB.actualizarEstadoInventario`. **Ese helper
   tampoco sirve como está**: devuelve `true` mirando solo `error`, así que da `true` con CERO
   filas afectadas (mismo bug que `vincularItemVentaAStock`). Hay que arreglarlo para que exija
   exactamente una fila, y recién entonces:
   - actualizar `p.estadoInventario` en memoria SOLO después de confirmar la escritura
   - si falla, NO registrar el movimiento que afirma que quedó reservado, y avisar

## C) src/modules/reparaciones.js ~1073 — devolver repuestos al cancelar

1. Reemplazar `item.cantidad += 1` + `actualizarCantidadStock` por
   `ajustarStock({ delta:+1, tipo:'ajuste_cantidad', detalle:'Repuesto devuelto — reparación #<id>' })`,
   refrescando memoria desde el resultado.
2. NO mandar p_estado_destino: la RPC ya pasa 'vendido' -> 'disponible' al reponer.
3. Los casos que hoy se saltean EN SILENCIO (no se encontró `item`, o `item.imeis` existe)
   pasan a sumar un aviso explícito a la lista `avisos`, para que el usuario sepa qué quedó sin
   devolver en vez de asumir que se devolvió todo.
4. **El aviso actual «sumale 1 a mano» pasa a depender del tipo de fallo.** Hoy es peligroso:
   ante un resultado INCIERTO la RPC pudo haber repuesto la unidad, y sumar otra a mano duplica.
   - CONFIRMADO: «no se pudo devolver X — sumale 1 a mano»
   - INCIERTO: «no se pudo confirmar la devolución de X — **verificá el stock antes de ajustar**»
5. **Preservar la información para corregir a mano, también entre intentos.** Hoy hay dos
   pérdidas encadenadas:
   - `DB.limpiarMovimientosReparacion(o.id)` (reparaciones.js ~1081) borra TODOS los repuestos
     de stock de la orden, incluidos los que no se pudieron devolver.
   - `const stockYaRepuesto = o.estado === 'rechazado'` (~1063) hace que el SIGUIENTE intento
     saltee todas las devoluciones, porque la orden ya quedó rechazada.

   O sea: si falla el segundo repuesto de dos, se borra el rastro y el reintento no devuelve nada.

   **DÓNDE SE PERSISTE (decidido, ya no "lo defino al implementar"):** una columna nueva
   `devolucion_estado TEXT` en la tabla `reparacion_repuestos`, que es donde ya viven los
   repuestos (`de_stock`, `stock_id`, cargada en supabase-config.js ~189). Tres valores:

       'pendiente'  no se devolvió, y se CONFIRMÓ que no se escribió   -> se puede reintentar
       'devuelto'   devolución CONFIRMADA                              -> no se toca nunca más
       'incierto'   no se sabe si se escribió                          -> NUNCA se reintenta solo

   Se expone en el objeto del cliente como `devolucionEstado` junto a `fromStock`/`stockId`, así
   sobrevive a una recarga sin depender de ningún toast. **Requiere una migración de una línea:
   se la pido a Deploy-infra** (`ALTER TABLE reparacion_repuestos ADD COLUMN IF NOT EXISTS
   devolucion_estado TEXT`). Es la única dependencia externa de esta parte.

   **COMPORTAMIENTO EN INTENTOS POSTERIORES (explícito):**
   - Volver a tocar «Cancelar» reintenta el `+1` **SOLO** sobre los repuestos en `'pendiente'`.
   - **NUNCA** sobre los `'incierto'`: la RPC pudo haber repuesto la unidad y un segundo +1 la
     duplicaría. Esos se listan para verificación humana y no se tocan automáticamente.
   - **Tampoco** sobre los `'devuelto'`: que la limpieza de la fila haya fallado y el repuesto
     siga existiendo NO significa que falte devolverlo.
   - `limpiarMovimientosReparacion` pasa a recibir la lista de repuestos a borrar (solo los
     `'devuelto'`) en vez de borrar todos los de la orden.
   - **`rechazado` deja de usarse como comprobante de reposición.** `stockYaRepuesto` se
     reemplaza por el filtro sobre `devolucionEstado`, que es el dato que realmente responde la
     pregunta.

   **RECLAMAR ANTES DE ACTUAR (ronda 5).** Hay una ventana entre el `+1` y guardar su resultado:
   si la RPC repone y después falla guardar `'devuelto'` —o se recarga la página en el medio—, el
   repuesto queda en `'pendiente'` y el próximo «Cancelar» lo devuelve DOS VECES. Se cierra con el
   mismo patrón de reclamo que usa `meli_descontar_stock`:

       1. UPDATE reparacion_repuestos SET devolucion_estado='incierto'
           WHERE id=$1 AND devolucion_estado='pendiente' RETURNING id
       2. SOLO si devolvió una fila, llamar a stock_ajustar(+1)
       3. éxito             -> 'devuelto'
          rechazo CONFIRMADO -> vuelve a 'pendiente' (no se escribió, se puede reintentar)
          falla esa escritura -> queda 'incierto' (seguro: nunca se reintenta solo)

   El paso 1 es condicional y solo quien confirme que modificó una fila ejecuta la RPC, así dos
   pestañas tocando «Cancelar» a la vez no reponen dos veces.

   **INICIALIZACIÓN E IDENTIDAD (ronda 5).**
   - La columna arranca en `NULL`, y **`NULL` significa "sin devolución pendiente"**, no
     `'pendiente'`. Las órdenes ya rechazadas pueden tener sus repuestos devueltos o no, y no hay
     forma de saberlo: convertirlas en masa a `'pendiente'` haría que el primer «Cancelar»
     duplicara stock de reparaciones viejas. Se quedan en `NULL` y, si alguna hay que corregir,
     se hace a mano.
   - Los repuestos de una reparación ACTIVA también quedan en `NULL`: están consumidos, no hay
     nada que devolver hasta que se cancele.
   - `'pendiente'` lo escribe el flujo de cancelación al arrancar, sobre los `de_stock` de ESA
     orden. Ese es el único lugar que lo pone.
   - **Identidad: hay que cargar el `id` de `reparacion_repuestos` en el cliente.** Hoy el mapeo
     (supabase-config.js ~189) trae `nombre`, `costo`, `fromStock` y `stockId`, pero NO el `id`,
     y `stockId` no identifica cada repuesto (dos renglones pueden apuntar a la misma fila de
     stock). Sin el `id` no se puede ni persistir el estado ni borrar la fila correcta. Es el
     mismo agujero que ya tuve que tapar en `venta_items`.

   El REINTENTO AUTOMÁTICO (sin que nadie toque «Cancelar») sigue fuera de alcance.

## D) Lo que NO resuelve este cambio (explícito, para no vender humo)

- El reintento AUTOMÁTICO de una devolución pendiente: hay que volver a tocar «Cancelar».
  Lo que sí queda resuelto es que la información para hacerlo no se pierde (C5).

- La atomicidad vínculo+descuento (hace falta la RPC combinada; se pide a Deploy-infra).
- La guarda de "reservado por otra venta" sigue mirando memoria local: no protege contra otra
  pestaña. La validación real tendría que estar en la base (la RPC es SECURITY DEFINER, así que
  las guardas del navegador se pueden eludir).
- La nota cruzada (`actualizarNotasStock`) concatena sobre una copia local y puede pisar notas
  concurrentes. Preexistente, no lo toco acá.
- Frescura entre pestañas: refrescar desde la respuesta corrige la operación actual, no el
  `State.stock` de otra pestaña abierta.

## E) Secuencia de deploy

La RPC NO está corrida en Supabase. Sin fallback a la escritura absoluta: si no existe, se avisa
y no se descuenta a ciegas. **NO se pushea a main (que deploya solo) hasta que el SQL esté corrido.**

## Preguntas para esta ronda
1. ¿Mantener el orden vincular->descontar y aceptar "vínculo sin descuento" como estado visible
   es defendible como paso intermedio, o conviene no tocar (B) hasta tener la RPC combinada?
2. ¿La distinción confirmado/incierto alcanza para no compensar mal?
3. ¿El tratamiento de `imeis` (solo asignar si ya era arreglo) cubre el riesgo que marcaste?
