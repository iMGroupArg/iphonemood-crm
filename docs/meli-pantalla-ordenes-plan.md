# Pantalla de órdenes de Mercado Libre: cotización, verificación previa, cierre manual y detalle de venta

Plan breve (Ventas+Cueva, 2026-10-12). Solo pantalla (`src/modules/meli-ordenes.js`, `supabase-config.js`, `state.js`, `app.js`) más el script 12 de Deploy-infra (ya escrito, sin correr). Nada se despliega sin pedido de Franco.

## 1. Cotización sin valor precargado

- Hoy la casilla viene con `State.refBlue` (referencia manual de Franco, 1.570 desactualizada). La cotización queda congelada en la venta, así que no puede venir sola.
- Casilla vacía + dos atajos: «Blue de mercado hoy: N (hora)» y «Mi referencia: N». El valor de mercado sale de dolarapi, que ya consulta `App.actualizarCotizacion`: se guarda en `State.mercadoBlue = {valor, en}` (solo memoria). Solo se acepta un número finito > 0; ante respuesta inválida o falla se pone `null` y el atajo desaparece (no se queda un valor viejo).
- **Implementado así:** la tarjeta ya no tiene casilla; trae un botón «Procesar…» que abre el cuadro de verificación (punto 2), y la cotización vive dentro del cuadro. El botón «Procesar» del cuadro queda deshabilitado hasta que haya cotización finita > 0 Y la casilla tildada; `procesar()` vuelve a exigir las dos cosas y exige haber abierto el cuadro. Antes de llamar a la base se relee la orden y, si cambió el producto vinculado o la cantidad respecto de lo que se verificó, no se procesa y se pide volver a abrir el cuadro (si no se puede releer, tampoco se procesa).

## 2. Cuadro de verificación previa a Procesar

Reemplaza el `confirm()`. Es un cuadro con, por orden:
- Por cada producto vinculado: stock actual y stock que quedaría (`State.stock`), aviso rojo si quedaría negativo.
- Posibles ventas ya cargadas. Como `State.ventas` y sus ítems se leen sin paginar (pueden truncarse), al abrir el cuadro se **consulta de nuevo a la base** solo lo necesario: ventas no anuladas con fecha entre `fechaOrden − 3 días` y `+ 3 días` (límites inclusivos, fechas locales de Argentina) y los `venta_items` de esas ventas; se cruzan por `stock_id` con los productos de la orden. Se muestran número, fecha, cliente, total y tipo. Con candidatas: aviso ámbar.
- Si la consulta falla: «No se pudo revisar si ya está cargada» y la casilla sigue obligatoria. Sin candidatas: «Sin coincidencias en lo consultado», **nunca** «no está duplicada».
- Casilla obligatoria «Verifiqué que esta venta no está cargada a mano ni el stock ya bajado»; «Procesar» del cuadro queda deshabilitado hasta tildarla y hasta que haya cotización.
- Límites declarados: una venta cargada con producto manual o distinto no se detecta, y otra pestaña puede cargar la venta a mano justo después de la revisión (la base evita procesar DOS VECES LA MISMA orden, no cruzarla con una venta manual independiente). El cuadro avisa, no garantiza.

## 3. «Ya la cargué a mano» (cierre manual)

Se adopta tal cual el **script 12** de Deploy-infra (`db/pendientes/meli_cerrar_manual.sql`), sin parche mío:
- `meli_orden_cerrar_manual(orden, motivo 'ya_cargada'|'descartada', venta_id?, nota?)` y `meli_orden_reabrir_cierre(orden)`; columnas `cerrada_manual_en/por/motivo/nota/venta_id`. Solo cierra órdenes sin procesar, sin stock descontado, sin venta, sin acreditar y sin revertir. Una orden cerrada **no puede** procesarse, descontarse, acreditarse ni revertirse: lo garantiza un trigger de la base (cierre y protección se despliegan JUNTOS, en el mismo script). Errores por excepción: `ORDEN_CERRADA_MANUAL`, `ORDEN_YA_PROCESADA`, `VENTA_YA_ENLAZADA`, `VENTA_INEXISTENTE`, `NOTA_INVALIDA`…; la pantalla los traduce a mensajes claros (`_msgError`).
- La ingesta sigue actualizando importes de la orden cerrada y puede volver a marcarla `revisar`. Pantalla: **el cierre tiene precedencia** sobre `revisar` en estado, filtros y acciones; la orden vive en «Cerradas» con etiqueta («Cargada a mano» / «Descartada»), quién, cuándo, nota y venta enlazada; si MELI cambió algo importante (`revisar` verdadero) se muestra un aviso dentro de «Cerradas». Las cerradas se excluyen de la revalidación automática de la pantalla.
- «A liberar» y Capital: hoy una cerrada ya queda fuera porque no está procesada; además se excluye **explícitamente** `cerradaManualEn` en `State.meliPendienteLiberar` (función compartida con Capital y Dashboard) y se prueba en ARS y USD. Además, si falta la venta en memoria, hoy se convierte con `refBlue` en vez de la cotización congelada: no se toca ahora (fuera de este alcance), queda anotado.
- Botones «Ya la cargué a mano», «Descartar» y «Reabrir cierre». Cuadro que pide nota y, opcional, número de venta (validado contra `State.ventas`). El cierre de órdenes reales **no se hace** hasta que Franco confirme cuáles están cargadas a mano.
- **Carga tolerante y segura:** las columnas del cierre se piden en una consulta aparte, unidas por id, para TODOS los ids cargados. Solo si el error es de columna inexistente (script 12 sin correr) se sigue sin ellas y los botones nuevos no aparecen. Cualquier otro error (red, permisos) pone la pantalla en «estado del cierre desconocido»: se bloquean Procesar y los cierres hasta recargar, para que una orden cerrada nunca aparezca como procesable.
- La carga de ítems de la orden agrega `precio_unitario` (columna que ya existe; `null` se conserva).

## 4. F1 «Detalle de venta» (solo pantalla)

Botón «Detalle» en cada tarjeta; abre un panel con:
- Cabecera: orden, fecha, estado, comprador = SOLO usuario (apodo). Localidad «—» hasta que exista el modelo de envíos. Nada de nombre, DNI, mail ni dirección. Solo se renderizan campos de una lista permitida, escapados; nunca se vuelca el JSON entero.
- Productos con su vínculo de stock, cantidades y precio unitario.
- Desglose del dinero, función pura `_desglose(o, extras)`: `Venta − Cargo por venta − Envío − Impuestos = Te llega`.
  · Solo se muestra «retenido» y «te llega» como confirmados si `financieraCompleta` y bruto y neto no son nulos. Si no (neto parcial, pagos pendientes, consulta fallida): «Datos de pago incompletos: todavía no se puede confirmar cuánto retiene Mercado Libre».
  · Con los datos de HOY solo se conoce bruto, neto y el total retenido; cargo por venta, envío e impuestos aparecen como «sin desglose todavía». No se reparte ni infiere.
  · `extras` (`cargoVenta`, `envio`, `impuestos`) es una entrada opcional para cuando existan esos datos. Con las tres partes se verifica que suman el retenido (± 1 centavo): «Cuadra» o «No cuadra por X»; con partes faltantes nunca se afirma que cuadra.
  · «Cargos informados por Mercado Pago» (`conciliacion.declarada`) se muestra con ese nombre exacto; NO es comisión, envío ni impuestos.
- Caso de prueba real, solo como fixture de test (Lattafa Khamrah, 8/10): precio 65.990,00; cargo por venta 18.952,89; envíos 8.290,00; impuestos 989,85; neto 37.757,26; suma de cargos 28.232,74 (42,8 %). Verificación: 65.990,00 − 18.952,89 − 8.290,00 − 989,85 = 37.757,26. Sin datos del comprador.
- Liberación: fecha y cuánto falta.
- Si la orden está procesada: venta #N, cotización congelada, costo del canal y margen con `Ventas.resultadoVenta`. Etiquetados **«provisorio hasta acreditar»** (el costo de canal definitivo se fija al acreditar; antes vale 0). Si falta la venta o sus ítems: «datos no disponibles».
- Datos extra bajo demanda: «Ver cómo se calculó» lee `payload_pago.conciliacion` de esa fila con la sesión, solo al abrir. No se agrega nada a la carga general.

## Orden de trabajo y pruebas

1) Cotización + cuadro de verificación (puro cliente). 2) Desglose y Detalle. 3) Cierre manual cuando Deploy-infra entregue la función (puedo dejar la pantalla lista con la carga tolerante antes).
Pruebas en `tests/cajas.test.mjs` (módulo `meli-ordenes.js`, ya cubierto en la sección 36): casilla vacía y atajos, Procesar deshabilitado, candidatas por producto/fecha, stock negativo, casilla obligatoria, desglose del caso Lattafa (cuadra) y variantes (falta una parte, no cuadra, neto nulo), carga tolerante sin columnas, cerradas fuera de «a liberar», botones que no aparecen sin columnas. SQL: banco pglite `tests/sql/meli.sql.test.mjs` con el parche de `meli_procesar_orden`.
Codex revisa este plan y después el código; commits locales con permiso de Franco.
