# Plan: CRM como app en el celular (dashboard, stock y Mercado Libre)

Pedido de Franco (2026-10-23): mejorar el uso y el responsive del CRM. Tres frentes, con dos imágenes de referencia:
1. **Dashboard móvil**, tomando como guía la imagen 1 (tablero de finanzas).
2. **Stock móvil** que se vea y se use "como aplicación, no como web", tomando la imagen 2 (lista de tarjetas).
3. **Módulo de Mercado Libre**: más responsive y agradable en el celular.

Este documento es un PLAN. No se construyó nada todavía. Franco irá sumando cosas a mirar; se agregan acá.
Las referencias son ideas de organización y de interacción (barra inferior, tarjeta de saldo, chips, tarjetas con acción),
no un diseño para copiar: se mantiene la identidad actual del CRM (paleta clara tipo Apple, azul `#0071E3`).

## 1. Qué hay hoy (verificado en el código)

- **Estilo**: `src/css/main.css`, 642 líneas, mobile-first, tokens claros tipo Apple. Puntos de corte en CSS: 480, 768 y 1023 px.
- **Navegación en celular**: una hamburguesa abre un menú lateral con **21 destinos**. No hay barra inferior.
- **Los puntos de corte no coinciden**: el CSS corta en 768/1023, pero en JS `isMobile()` es 768 (ventas, gastos, cuenta corriente),
  **900 (stock)** y 1024 (reparaciones). Entre 768 y 1023 px (tablets y celulares grandes en horizontal) cada pantalla decide distinto.
- **Estilos escritos dentro del HTML de cada módulo** (inline): stock.js 281, meli-ordenes.js 89, meli.js 48, meli-vincular.js 45,
  dashboard.js 36. Para forzar el celular, el CSS usa parches del tipo `[style*="grid-template-columns:1fr 1fr"] { ... !important }`.
- **Dashboard** (`dashboard.js`, 429 líneas): ~14 indicadores en filas fijas de 5, auto y 4 columnas, 3 gráficos (Chart.js) y 4 tarjetas
  (saldo de cajas, alertas, últimas ventas, reparaciones). En celular se fuerzan a 2 columnas: queda largo y todo pesa igual.
- **Stock** (`stock.js`, 2328 líneas): ya tiene una rama móvil con tarjetas (`.stock-card`), pero arriba apila **3 filas de pestañas con
  scroll horizontal + buscador + selectores** antes de ver el primer producto. Costo, margen, proveedor y custodio compiten en cada tarjeta.
- **Mercado Libre**: `meli.js` (cuenta, conexión, sonda, barrido), `meli-ordenes.js` (tablas) y `meli-vincular.js` (lista de publicaciones),
  con la forma de una pantalla de escritorio: muchos botones técnicos a la vista, tablas, tres bloques apilados.

## 2. Base común (fase 1): lo que se construye una sola vez

- **Barra inferior** (solo en celular): **Inicio · Ventas · Stock · Mercado Libre · Más**. "Más" abre una hoja con los otros destinos agrupados
  (como hoy el menú lateral) y un acceso a "Nueva venta". La barra, la hoja y el menú lateral salen de **un único listado de navegación**
  para que no se desincronicen. *(Propuesta de Codex: Inicio · Stock · Mercado Libre · Más; decide Franco, ver preguntas.)*
- **Componentes por clase** en `main.css`, reutilizables: tarjeta de saldo (`.balance-card`), chips de filtro (`.chip`), tarjeta de lista
  (`.item-card`), barra de filtros (`.filter-bar`), **hoja inferior** (`.bottom-sheet`: título, cierre visible, Esc, foco contenido,
  fondo inactivo, scroll interno) y botón flotante.
- **Un solo criterio de "celular"**: unificar en `< 1024 px` (hoy hay 4). Es un cambio de fondo: se hace de forma que el escritorio ≥ 1024 px
  quede **idéntico**.
- Altura táctil mínima 44 px, respeto de `safe-area-inset-bottom` (barra y avisos flotantes por encima de la barra inferior).
- **Migrar de inline a clases pantalla por pantalla**, sin tocar los parches globales hasta que no quede nadie que los use.
- **Página de prueba sin login** (`tests/` o `docs/`, solo para desarrollo): carga el CSS y los módulos reales con datos de ejemplo
  (stock, ventas, cajas, órdenes) y adaptadores simulados de `DB`, `supa` y `fetch`, **sin conectarse a Supabase**. Permite ver y capturar cada
  pantalla en 360/390/430, 768/900/1023 y 1024/1440 px. *A verificar al empezar: los módulos son globales y se pueden cargar sueltos sin
  `app.js`; falta confirmar qué necesitan de `supabase-config.js`.*

## 3. Dashboard móvil

Qué se toma de la imagen 1: una tarjeta grande de saldo arriba, accesos rápidos, pestañas segmentadas, y una cosa a la vez.

- **Tarjeta principal**: "Equivalente total en caja" (ya se calcula como `equivalenteTotalARS`), con el desglose ARS / USD / USDT
  y la cotización de referencia. Es plata disponible HOY, y se separa visualmente de los resultados del período.
- **Período**: chips Hoy · Semana · Mes y una hoja para mes específico o rango (hoy son controles sueltos).
- **Accesos rápidos**: Nueva venta · Stock (los dos que más se usan; a confirmar con Franco).
- **Pestañas segmentadas**: Resumen · Ventas · Cajas · Pendientes. En cada una, lo que corresponde, no los 14 indicadores juntos.
- **Indicadores**: los 4 principales a la vista (ventas del período, resultado comercial, resultado financiero, por cobrar), en tarjetas
  compactas; el resto bajo "Ver más indicadores".
- **Gráficos**: la evolución de ventas como gráfico principal; los otros dos bajo "Ver análisis", creados al abrir y destruidos al salir
  (Chart.js necesita ese ciclo para no perder memoria ni quedar mal dimensionado).
- **Listas** (últimas ventas, reparaciones activas, alertas): tarjetas con una acción clara, no mini-tablas.
- Cuidado de fondo: **no mezclar saldo disponible con resultado del período con plata retenida** (Mercado Libre "a liberar"):
  cada número lleva su etiqueta, su moneda y su período.

## 4. Stock móvil

Qué se toma de la imagen 2: encabezado simple, chips arriba, una tarjeta destacada y una lista de tarjetas con una acción a la derecha.

- **Encabezado fijo y compacto**: buscador siempre a la vista + **una sola fila de chips** de grupo (iPhone, Perfumería, ...).
  Estado, condición, subcategorías y los selectores pasan a un botón **"Filtros (N)"** que abre una hoja inferior con "Aplicar / Limpiar";
  los filtros activos quedan como chips que se pueden sacar. El primer producto aparece sin scrollear.
- **Tarjeta**: nombre y variante, disponibilidad, precio y estado a la vista. Costo, margen, IMEI, proveedor y custodio van al detalle.
- **Detalle y edición en hoja**: la edición larga ocupa casi toda la pantalla, conservando las validaciones y los guardados que ya existen.
- **Botón flotante "+"** para cargar producto; la selección múltiple pasa a una barra inferior de acciones.
- **Estado que sobrevive**: búsqueda, filtros y posición del scroll se guardan fuera del DOM, para que al volver de editar o cambiar de pantalla
  no se pierda dónde estabas (hoy se reconstruye todo).

## 5. Mercado Libre móvil

- **Reorganizar** los tres bloques apilados en **Órdenes · Publicaciones · Cuenta**, con Órdenes como entrada.
- **Órdenes como tarjetas**: comprador y producto, estado, neto y la próxima acción; las acciones secundarias van al detalle.
  "A liberar" se destaca aparte (no es plata disponible).
- **Procesar / acreditar** en una hoja con el resumen, la cotización, el impacto en stock y caja, y confirmación explícita.
- **Publicaciones / Vincular**: flujo publicación → buscar stock → revisar vínculo. El selector de stock (con los filtros por rubro ya hechos)
  pasa a una hoja inferior.
- **Cuenta**: conexión, cola, sonda, barrido y diagnóstico quedan en una sección "Herramientas", plegada por defecto. Las alertas
  relevantes (cuenta desconectada, órdenes para revisar) se muestran también en Órdenes.
- Intocable: las **transacciones y bloqueos** de procesar/acreditar. Solo se reorganiza la presentación, no la lógica; se corren las
  pruebas existentes de Mercado Libre (18 + 63 + 85) en cada paso.

## 6. Fases propuestas

| Fase | Contenido | Riesgo |
|---|---|---|
| 1 | Página de prueba sin login, capturas "antes" de cada pantalla y componentes base (CSS + hoja inferior) | Bajo: no cambia lo que ve nadie |
| 2 | Barra inferior + "Más" + unificar el criterio de celular + **dashboard** | Medio: toca la navegación de todo el CRM |
| 3 | **Stock** (encabezado, filtros en hoja, tarjeta, detalle) | Medio: pantalla grande y muy usada |
| 4 | **Mercado Libre** (Órdenes / Publicaciones / Cuenta) | Medio: hay plata de por medio; se cuida la lógica |

Cada fase termina con: revisión en celular (360/390/430 px), comparación de escritorio ≥ 1024 px sin cambios, pruebas existentes en verde,
revisión de código por Codex, y recién ahí se le pide a Franco publicar. Nada se publica sin su "desplegá".

## 7. Los 5 riesgos más grandes (de la revisión de Codex, verificados)

1. **Estilos inline y `!important` contra estilos nuevos**, con puntos de corte que se contradicen → migración acotada y capturas justo en los límites.
2. **Perder filtros, foco o borradores al volver a dibujar** una pantalla → estado explícito y restauración.
3. **Confundir saldo, resultado y dinero retenido** → etiquetas, moneda y período inequívocos.
4. **Duplicar operaciones de plata al cambiar los botones** → se conservan las transacciones y los bloqueos; se corren las pruebas.
5. **Hojas tapadas por el teclado o la barra inferior, y gráficos mal dimensionados** → pruebas en un celular real, safe areas y ciclo de vida de Chart.js.

## 8. Preguntas para Franco

1. **Barra inferior**: ¿qué cinco destinos? Propuesta: Inicio · Ventas · Stock · Mercado Libre · Más. Codex propone Inicio · Stock · Mercado Libre · Más.
2. **Quién lo usa en el celular** (Franco, Angel, Gonza) y para qué tareas: define qué va primero en el dashboard y en los accesos rápidos.
3. **Estética**: ¿mantenemos el estilo claro actual (blanco y gris, azul `#0071E3`) o querés el degradado azul de la imagen 1 en la tarjeta de saldo?
4. **Tablet / celular en horizontal** (768 a 1023 px): ¿se usa? Si no, el criterio "celular = menos de 1024 px" alcanza.
5. ¿Hay otras pantallas que mirar después de estas tres? Se suman a este plan antes de empezar.

## 9. Cómo se verifica (sin que nadie tenga que iniciar sesión)

La página de prueba con datos de ejemplo se abre en el navegador a los anchos de arriba. Se compara con las capturas "antes" y con el escritorio.
Las pruebas existentes (`tests/*.test.mjs`, 18 + 63 + 85 de Mercado Libre y las de cajas) tienen que seguir en verde. Lo que no se puede probar
acá (teclado abierto, rebote de iOS) se prueba en el celular de Franco con una vista previa y se deja asentado.
