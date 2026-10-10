# Vincular publicaciones: artículos con el mismo nombre y distinto costo

Pedido y decisiones de Franco (2026-10-10), para quien tenga la parte de base de datos de Mercado Libre.

## Qué se quiere
Hay artículos cargados en Stock en FILAS distintas con el mismo nombre y costo de carga distinto
(hoy: `KHAMRAH DUKHAN 100ML`, 2 filas de 2 unidades). En la pantalla "Vincular publicaciones" tienen
que poder vincularse **como un solo artículo**.

Decisiones de Franco:
1. **La unidad sale de la fila más vieja cargada hacia la más nueva** (FIFO).
2. **Stock queda en filas separadas** (no se fusionan). Lo importante: **el margen no se mezcla**: cada
   unidad vendida lleva el costo de la fila de la que salió.

## Por qué no alcanza con tocar la pantalla
`meli__descontar_core` descuenta de UNA fila por `stock_id`. Si el vínculo apuntara a una sola fila de las
dos, una orden podría marcar "stock insuficiente" aunque entre las dos filas alcance.

## Diseño propuesto (cambio mínimo; decide quien lo implemente)
`meli_orden_items` ya guarda UNA fila de stock por ítem (`stock_id`, `cantidad`), y descuento, reposición,
reversión y la venta con su costo ya trabajan por ese `stock_id`. Entonces, en vez de cambiar todo eso:

- El vínculo (`meli_publicaciones.stock_id`) sigue apuntando a UNA fila, como hoy: es el "representante".
- **Grupo** = filas vendibles con el mismo nombre normalizado (minúsculas, sin acentos, espacios
  colapsados) y la misma categoría, que no sean `a_pedido`, con IMEI ni `eliminado`.
- Al repartir una orden, un ítem de cantidad N se **reparte FIFO** entre las filas del grupo con stock,
  de la más vieja a la más nueva, y se escriben **tantas filas en `meli_orden_items` como filas consuma**
  (cada una con su `stock_id` y su cantidad). Así el costo y el margen quedan separados por fila sin tocar
  descontar/reponer/revertir.
- Si el grupo entero no alcanza: comportamiento de hoy (`revisar`, no se descuenta nada).

### Dónde repartir (a decidir)
(a) en `meli_ingresar_orden`, al registrar; (b) dentro de `meli__descontar_core`, bajo el bloqueo de la
orden, justo antes de descontar. **Recomendación: (b)**: el stock puede cambiar entre que entra la orden y
se descuenta (ventas locales), y repartir bajo el bloqueo evita asignar sobre un dato viejo. Las órdenes ya
descontadas no se reescriben. La reingesta de la misma orden tiene que ser idempotente.

### Dato a verificar primero
"Más vieja cargada" necesita una fecha de carga por fila de `stock`. No encontré en el repo cuál es la
columna real (puede ser `created_at`/`creado_en`). Si no existe: usar la fecha del primer movimiento de alta
en `stock_movimientos`, o agregar `creado_en DEFAULT now()` (las filas viejas quedarían sin fecha: definir el
desempate, p. ej. por ese primer movimiento y, si no hay, por id).

## Pruebas que tendrían que existir (pglite, `tests/sql/`)
- 2 filas mismo nombre (2 y 2 unidades, costos distintos), orden de 3: sale 2 de la más vieja y 1 de la nueva;
  `meli_orden_items` queda con 2 filas; reponer devuelve a las MISMAS filas.
- Orden que no alcanza entre las dos: `revisar`, nada descontado.
- Nombres con mayúsculas/acentos distintos agrupan; distinta categoría NO agrupa (decant vs perfume).
- Filas `a_pedido`, con IMEI o eliminadas no entran al grupo.
- Reingesta de la misma orden: misma asignación, sin descontar dos veces.
- El margen de cada línea de venta usa el costo de SU fila.

## Parte de la pantalla (la hace la sesión de la landing cuando el descuento esté listo)
En el selector, UNA opción por nombre con las unidades sumadas y "N cargas"; al elegirla vincula con la fila
más vieja con stock. En la lista de vínculos se muestra "→ Nombre (2 cargas, 4 u.)".
Los filtros por rubro ya están hechos (commit `eb4e7d7`).
