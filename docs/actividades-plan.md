# Actividades: transferir lo que libera Mercado Libre a la cuenta de la empresa

Plan breve (Ventas+Cueva, 2026-10-13). Para revisión de Codex antes de construir. Nada se publica sin pedido de Franco.

## Pedido
Mercado Libre deposita en una cuenta de Mercado Pago personal. Esa plata hay que pasarla a la cuenta de la empresa. Franco quiere (1) un aviso de cuándo se libera, (2) una sección «Actividades» con checks («Transferir $X de Mercado Pago a la cuenta de la empresa») que se tilde como hecho. Decisiones de Franco: la cuenta de la empresa es la caja **«ARS transferencia» de la persona «Franco»** (confirmado por captura de Cajas: la misma persona tiene también la caja «ARS Mercado Pago», de donde sale la plata); la transferencia no tiene costo ni impuesto; quiere además un email diario (F4, después).

## Cómo encaja con lo que ya existe
* Al **confirmar la acreditación** (`meli_acreditar_orden`), la plata entra a la caja `ARS Mercado Pago` (la caja de la cuenta de MELI) y la orden queda con `acreditado`, `monto_acreditado`, `acreditado_en`, `acreditado_persona_id`, `acreditado_bolsillo`.
* Si Franco la transfiere afuera y el CRM no se entera, esa caja queda con plata que ya no está. Por eso el tilde puede **registrar el traspaso** entre cajas, no solo marcar.
* Traspaso entre cajas ya existe y es atómico e idempotente: `caja_mover_atomico` (clave de idempotencia).

## Diseño

### Tabla `actividades` (genérica)
`id`, `tipo` (`'meli_transferir'` | `'manual'`), `titulo`, `monto` NUMERIC NULL, `moneda` TEXT NULL, `fecha_objetivo` DATE, `estado` (`'pendiente'|'hecha'|'anulada'`), `clave_unica` TEXT UNIQUE NULL, `origen_orden_id` BIGINT NULL (FK a `meli_ordenes` ON DELETE RESTRICT), `origen_persona_id` UUID NULL, `origen_bolsillo` TEXT NULL, `destino_persona_id` UUID NULL, `destino_bolsillo` TEXT NULL, `movio_plata` BOOLEAN DEFAULT FALSE, `nota` TEXT, `creada_en`, `hecha_en`, `hecha_por`. CHECKs: estado válido; `hecha` exige `hecha_en` y `hecha_por`; `movio_plata` exige destino. RLS: lectura solo para usuarios autorizados, SIN escritura directa de la tabla desde el navegador: todo por funciones.

### Creación automática SIN tocar las funciones de plata
Un **trigger AFTER UPDATE** sobre `meli_ordenes` (misma transacción, SECURITY DEFINER): cuando `acreditado` pasa de falso a verdadero inserta la actividad `meli_transferir` con clave `meli-transf-<orden id>` (`ON CONFLICT DO NOTHING`), monto = `monto_acreditado`, origen = caja donde entró, fecha_objetivo = día de la acreditación. Así no se reescribe `meli_acreditar_orden` (plata real) y no se duplica su cuerpo en otro archivo.
* **Una actividad por orden acreditada.** La pantalla las AGRUPA por día (un solo «marcar todas las de este día», que ejecuta una por una). Una por día con suma obligaría a un upsert con suma que se rompe si el día ya estaba tildado.
* **Reversión:** un trigger BEFORE UPDATE sobre `meli_ordenes` cuando `revertida_en` deja de ser nulo: si la actividad está pendiente → `anulada`; si ya movió plata (`hecha` y `movio_plata`) → **se rechaza revertir** con `ORDEN_YA_TRANSFERIDA` (revertir sacaría la plata de `ARS Mercado Pago`, que ya no la tiene; hay que corregirlo a mano); si está `hecha` sin movimiento → queda como está y se agrega nota.

### Funciones (todas SECURITY DEFINER, `is_authorized_user()`, FOR UPDATE, idempotentes, REVOKE de PUBLIC/anon)
* `actividad_transferir(p_id, p_destino_persona UUID, p_destino_bolsillo TEXT, p_nota TEXT)`: bloquea la actividad; si ya `hecha` devuelve `ya_hecha`; si no `pendiente`, error; exige destino distinto del origen y bolsillo en pesos (`ARS…`); llama a `caja_mover_atomico` (origen = caja de la actividad, monto = monto, clave `actividad-transf-<id>`) y marca `hecha` con `movio_plata = true` **en la misma transacción**: o pasa todo o nada. Si el saldo de origen no alcanza, error claro y la actividad sigue pendiente.
* `actividad_marcar_hecha(p_id, p_nota)`: solo marca (sin mover plata); queda `movio_plata = false`.
* `actividad_reabrir(p_id)`: solo si `hecha` sin movimiento de plata (si movió plata se corrige con un traspaso a mano desde Cajas).
* `actividad_crear(p_titulo, p_fecha_objetivo, p_monto?, p_moneda?, p_nota?)` para actividades manuales; `actividad_anular(p_id)` si está pendiente.
* Un traspaso de pesos a pesos no cambia el total de plata: no toca cuenta corriente ni Capital (se prueba que Dashboard y Capital no cuenten doble).

### Pantalla
* Sección «Actividades» en el menú con **badge** = pendientes vencidas o de hoy. Agrupadas por día, con monto, orden de origen, y botón «Transferir…» (cuadro: destino predeterminado **Franco · ARS transferencia**, editable; el predeterminado se recuerda en `configuracion` clave `actividades_caja_empresa`; nota opcional; dos botones: **«Registrar traspaso en el CRM»** y **«Solo marcar como hecha»**).
* **Aviso al abrir el CRM**: «Hoy se liberan $X (N órdenes) · tenés N transferencias pendientes por $Y». «Se libera hoy» sale de `meli_ordenes.fecha_liberacion` (datos que la pantalla ya carga); es informativo y no crea actividades.
* La persona se llama «Franco» (confirmado en Cajas): origen y destino son la MISMA persona con bolsillos distintos («ARS Mercado Pago» → «ARS transferencia»); la validación «destino distinto del origen» compara persona + bolsillo.

## Fases
* **F1 (S, sin SQL):** «Hoy se liberan $X» y «Liberadas sin confirmar» (órdenes con fecha de liberación cumplida y sin acreditar) en la pantalla de Mercado Libre, en el aviso al abrir y en un badge. Solo datos ya cargados.
* **F2+F3 (M–L, un SQL = script 15):** tabla, triggers, funciones, pantalla Actividades, badge y aviso, traspaso atómico. Se construyen juntas para no dejar la caja desactualizada.
* **F4 (S–M, después):** email diario con Resend desde el cron existente (sin función nueva). La cuenta y las claves las carga Franco en Vercel; viajan solo importes y cantidades.

## Riesgos
1. Plata real: el traspaso va dentro de una función transaccional con clave idempotente; probar reintentos y dos sesiones.
2. Revertir una orden ya transferida → se bloquea con mensaje (decisión explícita); alternativa descartada: dejar saldo negativo en `ARS Mercado Pago`.
3. Trigger de creación: si fallara, deshace la acreditación; por eso es mínimo (`INSERT … ON CONFLICT DO NOTHING`) y se prueba con el banco real (pglite) antes de entregarlo.
4. Duplicar el concepto «a liberar» de Capital: queda como visualización; las actividades no entran en Capital.
5. Actividades históricas: las órdenes ya acreditadas antes de instalar el trigger no generan actividad (se puede crear una manual o hacer un relleno único con aprobación).

## Pruebas
Banco pglite (script 15 sobre 1, 4, 12): creación al acreditar, idempotencia, orden revertida con actividad pendiente / hecha sin plata / transferida, traspaso exitoso, saldo insuficiente, destino igual al origen, bolsillo en dólares rechazado, doble ejecución, `actividad_marcar_hecha` / `reabrir`, permisos (anon no ejecuta). Pantalla (`tests/cajas.test.mjs`): agrupación por día, badge, aviso, cuadro del tilde, errores traducidos, destino predeterminado.

## Ajustes tras la revisión de Codex (REVISAR, 8 puntos; todos incorporados, MANDAN sobre lo de arriba)
1. **Orden de bloqueos:** todas las funciones de actividades MELI bloquean PRIMERO la orden (`meli_ordenes`, FOR UPDATE) y DESPUÉS la actividad, y revalidan bajo esos bloqueos que la orden esté acreditada, no revertida y no cerrada a mano. Luego las dos cajas, ordenadas por `(persona_id, bolsillo)`. Mismo orden que acreditar/revertir (orden → … → caja): sin deadlock entre transferir y revertir. Vale también para marcar, reabrir y anular. El trigger de reversión usa el bloqueo de orden que la reversión ya tiene y lee la actividad con `FOR UPDATE`.
2. **Saldo insuficiente:** `caja_mover_atomico` NO lo controla. `actividad_transferir` bloquea AMBAS cajas (orden estable), verifica que existan y que el origen alcance, y recién ahí mueve. Si no alcanza: error claro, actividad pendiente, ningún asiento.
3. **La reversión es terminal:** una orden revertida no se re-acredita; no hay ciclos. No se puede reabrir una actividad cuya orden esté revertida. Si algún día hicieran falta ciclos, habría que identificar la «generación» en todas las claves (fuera de alcance).
4. **Triggers precisos:** creación solo con `OLD.acreditado = false AND NEW.acreditado = true` y con los datos de acreditación guardados (`monto_acreditado`, `acreditado_persona_id`, `acreditado_bolsillo`), nunca el neto o la cuenta actuales; reversión solo con `OLD.revertida_en IS NULL AND NEW.revertida_en IS NOT NULL`. Ninguno vuelve a actualizar `meli_ordenes`. Conviven con la guarda del script 12 (esa es BEFORE y estos AFTER; la guarda sigue siendo el error prioritario). Se prueban los UPDATE intermedios de stock y los repetidos de la ingesta: no crean, anulan ni agregan notas de nuevo.
5. **Atomicidad declarada:** si el INSERT de la actividad fallara, la acreditación entera se deshace (caja, pago, venta). Es la política elegida (silenciar el error perdería actividades). Se agrega una prueba de fallo deliberado que confirma el rollback completo, y la inserción usa `ON CONFLICT (clave_unica) DO NOTHING`.
6. **Validaciones y permisos:** origen y destino deben ser cajas en pesos que existan (según el catálogo real de bolsillos), no nulas, distintas entre sí; monto finito y positivo; el MISMO monto normalizado en las dos patas; el destino efectivo queda guardado al completar; el autor sale del servidor. Invariantes: `movio_plata ⇒ estado = 'hecha'` y destino cargado. `search_path` fijo, RLS de lectura para autorizados, REVOKE de escritura directa (incluido `authenticated`), EXECUTE solo para las funciones públicas, helpers y funciones de trigger sin ejecución pública. Se prueban usuario autorizado, no autorizado y anon, con escrituras directas.
7. **«Solo marcar como hecha»** significa: «lo transferí afuera y NO quiero que el CRM mueva plata»; la caja `ARS Mercado Pago` queda con ese saldo y se avisa en el cuadro. Una transferencia ya registrada que se quiera deshacer se compensa con un traspaso inverso ligado a la actividad (nueva función `actividad_compensar`, que registra el movimiento y libera la marca `movio_plata`); mientras tanto la reversión de la orden sigue bloqueada. «Corregir a mano desde Cajas» solo no alcanza.
8. **Pruebas y operativa:** además del banco pglite, pruebas con DOS sesiones reales de PostgreSQL (transferir/revertir, acreditar/revertir, transferir/marcar, dos actividades que comparten saldo). Un segundo pedido sobre la misma actividad devuelve el resultado original o un conflicto explícito (nunca «éxito de transferencia» si ganó «solo marcar»). «Marcar todas» informa resultados parciales (cuáles se hicieron y cuáles no). Los días se agrupan en hora de Argentina. Los avisos excluyen órdenes revertidas o cerradas a mano. Órdenes ya acreditadas antes de instalar el trigger: no generan actividad solas; se crea una manual o, con aprobación de Franco, un relleno único (una actividad manual no reemplaza automáticamente una transferencia MELI vinculada).
