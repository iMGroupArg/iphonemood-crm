<!-- Plan de diseño (SIN implementar): conversiones USD→USDT con sobrante.
     Dueño: Ventas+Cueva. v2 = v1 + revisión de Codex (REVISE, 9 hallazgos, todos incorporados abajo).
     Estado: para OK de Franco. Nada de esto se escribe en código antes del OK. -->

# Plan (v2): conversiones USD → USDT con sobrante

## 1. El problema, con el caso real
Franco compró un lote de **8.790 USDT**. En la vida real: cambió **10.000 USD**, comisión 3 % (**300 USD**), recibió **9.700 USDT**, pagó **8.790** y le **sobraron 910 USDT**.

El CRM solo registra la conversión **dentro del lote** y asume que se convierte **justo lo que el lote usa**. Consecuencias hoy:
1. Angel quedó con 1.210 USD de más, la caja USDT con 910 de menos y el lote con 263,70 «sin pagar».
2. La comisión que se carga al lote (263,70) no es la justa: lo justo es **271,86** (300 × 8.790 ÷ 9.700); los otros **28,14** son costo del sobrante y hoy no figuran en ningún lado.
3. El costo del lote toma **solo la primera** conversión: una segunda se ignora.
4. Los 910 USDT sobrantes se usan después **a 1,00**, sin su sobrecosto.

**Hallazgos de la revisión (errores que ya existen, independientes del sobrante):**
- **«Resta pagar» y el saldo a favor mezclan deuda con el proveedor y costo de la mercadería.** `restante = costoTotal − pagado` (proveedores.js:277) y `costoTotal` incluye la **comisión y los envíos**, que NO se le deben al proveedor. Resultado: todo lote con conversión muestra una deuda falsa igual a la comisión (en el caso real, 271,86 «pendientes» con el proveedor pagado entero), y el cálculo del **excedente → saldo a favor** (línea 2006) y del **crédito aplicado** (2030) usa la misma cuenta equivocada: pagar de más 100 no se reconoce como 100 de crédito.
- **Capital → «pedidos en tránsito»** (capital.js:65) suma el `montoUsd` de TODOS los movimientos de lotes sin recibir: incluye las **conversiones** (plata que solo cambió de caja y ya está en las cajas USDT), **suma las devoluciones** en vez de restarlas y **no excluye los lotes cancelados** (que devuelven la plata pero conservan las filas). Los créditos generados además se cuentan en otra línea de Capital.

## 2. Lo que se quiere (pedido de Franco)
1. Separar «**USD convertidos en total**» de «**USDT que usa este lote**».
2. **Prorratear la comisión** al lote (271,86).
3. Dejar el **sobrante en la caja USDT con su costo real** (~1,0309 USD por USDT).
4. Permitir **varias conversiones por lote**.
5. Que el **próximo lote use el sobrante a ese costo**.

## 3. Definiciones de contabilidad
- 1 USDT = 1 USD **nominal** (como están cargados los precios de ítems y los pagos en USDT). **Costo real** de un USDT = USD pagados ÷ USDT recibidos (10.000 ÷ 9.700 = 1,030928…). **Sobrecosto** de un USDT = costo real − 1.
- **Costo de adquisición del lote** (lo que vale la mercadería) = Σ ítems + **sobrecosto de los USDT que ese lote usó** + envíos/costos adicionales/diferencial.
- **Saldo con el proveedor** (lo que se le debe) = Σ ítems − (pagos al proveedor + crédito aplicado − devoluciones). **No** incluye comisión ni envíos (esos se pagan a terceros). Es lo que decide «saldado», «excedente» y crédito.
- Todo en **centavos enteros** antes de repartir; el sobrante de centavos va al último concepto. Las columnas de dinero son `numeric(10,2)`.

## 4. Diseño por fases (cada una se publica sola)

### Fase 0 — Arreglos de lectura, sin base de datos (1 día)
a) **Separar los dos conceptos** con dos funciones únicas: `costoAdquisicion(lote)` y `saldoProveedor(lote)`. «Resta pagar», «Pagado», crédito por excedente (`convertirExcedenteACredito`), «usar saldo a favor» (`modalUsarCredito`) y la sugerencia de pago pasan a `saldoProveedor`; el costo por unidad en la recepción sigue usando `costoAdquisicion`.
   *Cambio de comportamiento visible (decisión de Franco, §7):* lotes con envío o comisión dejan de mostrar «resta» falso; si alguna vez se pagó de más al proveedor para «poner verde» el lote, ese exceso ahora aparece como excedente que se puede guardar como crédito.
b) **Capital en tránsito** por lote = pagos al proveedor + crédito aplicado − devoluciones + costos pagados (+ sobrecosto imputado, Fase A), **menos lo ya contado como crédito generado**, y **solo para lotes sin recibir y NO cancelados**; **sin** filas de conversión. Valuación: USDT nominal; con el sobrecosto incluido en tránsito, Capital no «salta» al recibir el lote. (Que las cajas USDT se valúen a mercado `refUsdt/refBlue` es una política aparte, no se toca.)
c) Tests con el caso real y con envío, devolución, cancelado y crédito generado.

### Fase A — Conversión con sobrante dentro del lote (1,5–2 días; resuelve el dolor de hoy)
**Base** (un `.sql` idempotente, ADD COLUMN nullable en `lote_pagos`): `usdt_lote` («USDT que usa este lote») y `comision_lote_usd` (comisión imputada al lote). **Antes de habilitar el flujo, el cliente comprueba que las columnas existen** (si no, bloquea con aviso en vez de mover plata y fallar después).

**Modal «Conversión»:** USD a convertir (**total**), comisión %, [calc.] USDT recibidos, **«USDT que usa este lote»** (por defecto todos; > 0 y ≤ recibidos), cajas, fecha, notas. Vista previa en vivo: comisión total · **comisión que se carga a este lote** (comisión × usdt_lote ÷ recibidos, en centavos) · **sobrante N USDT a costo X** · «queda en la caja Y».

**Plata:** un solo traspaso de dos patas por los montos TOTALES (10.000 → 9.700), como hoy. La fila guarda `montoUsd=10.000`, `montoUsdt=9.700`, `comisionUsd=300`, `usdt_lote=8.790`, `comision_lote_usd=271,86`.

**Sobrecosto del lote** = helper único `_comisionDelLote(pagos)`. Compatibilidad **exacta** con lo cargado: las filas con `comision_lote_usd` NULL (históricas) siguen contando **solo la primera**, como hoy; cada fila nueva cuenta la suya (con `value == null ? null : Number(value)`: nunca `Number(null)`, y un **0 explícito** no cae al fallback). Se reemplazan **todas** las lecturas (siete búsquedas `find`: líneas 139, 272, 1010, 1461, 1563, 2003, 2027; la 346 se alimenta de la 272), se actualizan **las dos rutas** de datos (carga en supabase-config.js:232 y estado tras insertar, :1418) y el **pago sugerido** pasa a (Σ `usdt_lote` − lo ya pagado en USDT), para que reabrir el modal no sugiera pagar todo otra vez.

**Los 28,14 USD** de comisión del sobrante no se cargan a ningún lote en esta fase (se pueden registrar como gasto «comisión del sobrante», como el arreglo manual de hoy, o esperar a la Fase B).

**Cajas y revertir:** la lista de movimientos de Cajas y la reversión masiva ya usan montos totales de la conversión; se prueban igual que el resto.

### Fase B — Sobrante con costo propio, consumido a propósito (2–3 días; solo si Franco la quiere)
**Cambio respecto de v1 (por la revisión de Codex): se descarta el «costo promedio por caja».** Un promedio por caja exigiría seguir **todos** los movimientos de USDT (traspasos entre personas, gastos, cueva, retiros, ajustes) y no permite revertir una conversión sin dejar el costo en negativo cuando ya hubo consumos. En su lugar:

**«Tandas» de sobrante, atadas a cada conversión y elegidas al pagar:**
- **Base:** en `lote_pagos`: `usdt_sobrante_restante` (lo que de ese sobrante todavía no se usó), `costo_conv_usd` (sobrecosto imputado a un pago), `sobrante_de_pago_id` (de qué conversión salió el USDT de este pago), `usdt_de_sobrante`, y `clave` (única, idempotencia). Una función transaccional `proveedor_usar_sobrante(...)`.
- **Pago al proveedor en USDT:** el modal lista «Sobrantes disponibles: conversión #X (lote Y) — 910 USDT a 1,0309» con un campo «USDT que salen de ese sobrante» (sugerido: lo que corresponda). Al confirmar, el pago guarda `costo_conv_usd = usdt_de_sobrante × (costo − 1)` (a centavos) y el sobrante baja. Lo que no sale de un sobrante se paga a 1,00 (sin sobrecosto), igual que hoy.
- **Costo del lote:** `ítems + Σ comision_lote_usd (fila de conversión) + Σ costo_conv_usd (pagos) + envíos`. **Cada sobrecosto tiene un solo dueño:** la conversión imputa al lote **solo lo que ese lote usó** (`comision_lote_usd`), y el sobrante lo imputa al lote que lo **use** (`costo_conv_usd`); nunca ambos para el mismo USDT. Un campo explícito `modelo_costo` en la fila de conversión evita la ambigüedad entre las de Fase A (que quedan como están) y las nuevas.
- **Los sobrantes de la Fase A** no entran solos a la Fase B (su costo histórico no se puede asumir sin saber si ya se gastaron): se puede **sembrar a mano** un sobrante con su costo.
- **Revertir:** un pago devuelve a su tanda **exactamente** lo que consumió (cantidad y costo guardados en el pago, no recalculados con el valor de hoy). Una conversión **no se puede revertir si algo de su sobrante ya se usó** (dependencia exacta por tanda: hay que revertir antes esos pagos; el bloqueo ocurre **antes** de devolver el USD de origen).
- **Todo en una función transaccional con clave de operación** (mismo patrón que Mercado Libre y `caja_aplicar_delta`): `proveedor_convertir(...)` y `proveedor_pagar_usdt(...)` mueven las cajas, registran la fila del lote y ajustan la tanda **en una sola transacción**, con una clave que genera el cliente por intento. Así desaparecen las compensaciones, y una respuesta perdida o una pestaña cerrada se resuelve repitiendo con la misma clave. Cancelar/eliminar un lote usa la función de revertir por pago, **en orden inverso** (pagos antes que conversiones), con reintento seguro.
- **Costo por unidad en la recepción:** los costos manuales de logística siguen reemplazando al automático (decisión vigente; se muestra en pantalla).

## 5. Compatibilidad y despliegue
- **SQL primero, código después.** Fase 0: sin SQL. A: un archivo (columnas). B: un archivo (columnas + funciones).
- Sin migrar datos viejos; el lote de Franco ya se corrigió a mano (pasada de manos + gasto + pago).
- Cada fase: revisión de Codex, tests, commit local; **ningún push ni deploy sin OK de Franco**.

## 6. Pruebas previstas
- **Módulos** (`tests/cajas.test.mjs`): caso real completo (10.000 → 9.700, lote 8.790) con saldos exactos, comisión del lote 271,86 / sobrante 28,14, **proveedor saldado con 8.790** (sin «resta» falso), sobrepago y devolución → crédito correcto; dos conversiones en un lote; fila vieja NULL = hoy (incluida «solo la primera» en lotes históricos con 2 conversiones); **cero explícito**; guardar y recargar iguales; SQL sin correr (bloquea antes de mover plata); Capital en tránsito (cancelado, devolución, crédito generado); costos por unidad con ítems mixtos, ajuste manual y centavos indivisibles; reversión masiva y por pago.
- **SQL real** (pglite, Fase B): consumo parcial, tanda agotada con remanente de centavos, idempotencia (respuesta perdida, reintento), reversión de pago devolviendo lo exacto, bloqueo de revertir una conversión consumida, clave repetida con otro contenido.
- **Dos conexiones reales** (cuando exista un Postgres de prueba): consumo simultáneo de la misma tanda; consumo vs. reversión.

## 7. Decisiones que necesita de Franco
1. ¿Hacemos **0 + A** ahora y B después? (B corrige ~3 % del sobrante, 28 USD cada 910 USDT; vale si convierte seguido con sobrante.)
2. **Fase 0a** cambia lo que dice «Resta pagar» y el crédito: ¿de acuerdo con que «saldado» signifique «pagué al proveedor lo que me facturó» (sin comisión ni envío)?
3. Los **28,14 USD** del sobrante mientras no exista B: ¿gasto aparte o esperar?
4. Lotes históricos con **dos conversiones**: se dejan como están (propuesto) o se recalculan.
5. En Capital: ¿alcanza con el sobrante dentro de las cajas USDT, sin línea aparte? (Propuesto: sí; una línea aparte lo duplicaría.)

## 8. Riesgos y cómo se cubren
- Olvidar una de las 7 lecturas de conversión → un helper único + un test por cada sitio.
- Doble conteo del sobrecosto → un solo dueño por USDT (§4B) + test de lote mixto.
- Pago mal registrado tras mover plata → Fase A conserva el esquema actual con compensación y bloqueo previo si faltan columnas; Fase B pasa a función transaccional.
- Redondeo → centavos enteros antes de repartir y remanente al último concepto.
