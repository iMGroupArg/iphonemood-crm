# Ajuste de pago de Mercado Libre: diseño SQL (para Deploy-infra)

Estado: **DISEÑO, no hay código de guardado escrito.** Lo único construido es la herramienta de solo lectura `comparar`
(`api/_meli_comparar.js`, rama `claude/meli-comparar`). Todo lo de abajo toca plata: va por Deploy-infra + Codex + «desplegá» de Franco.

## 1. El problema (CAUSA CONFIRMADA el 14/11)

Lo que llega de verdad a la cuenta = `net_received_amount` del pago **+ el envío que pagó el comprador** (`shipping_amount`). El CRM guarda solo
`net_received_amount` (`api/_meli_ingesta.js` línea ~62: `transaction_details.net_received_amount`; `resumenPago` ni siquiera guarda `shipping_amount`).
El crédito de envío aparece ~1 minuto después de aprobarse el pago, cuando se genera el envío («Monto ajustado» en el histórico del pago de Mercado Pago), y
**no cambia** `net_received_amount` ni `pagos_version`: por eso las relecturas (11/11 y 12/11) no cambiaron nada. Desglose de Mercado Pago de la Qahwa:
venta 62.690,50 − retención IIBB 940,36 − envíos 8.290 (= «Costo de envío» +4.887,86 que pagó el comprador − «Cargo por envío» −13.177,86) − cargo por vender 9.604,72 = **43.855,42**.

| Orden | Bruto | Neto guardado (net_received) | Envío del comprador | Llega de verdad | Costo de canal guardado → real |
|---|---|---|---|---|---|
| 2000018981569144 (Fakhar) | 55.791,00 | 31.967,66 | +6.148,81 | **38.116,47** | 23.823,34 → 17.674,53 |
| 2000019315185954 (Qahwa) | 62.690,50 | 38.967,56 | +4.887,86 | **43.855,42** | 23.722,94 → 18.835,08 |

Consecuencias: «Llega», margen y profit por debajo de lo real; la acreditación toma el neto viejo (la caja queda corta contra el banco); el costo de canal
(`bruto − neto`) queda **sobreestimado**. (La versión anterior de este documento suponía lo contrario —que tras releer la comisión quedaba subestimada—: con el
crédito de envío incluido, `bruto − llega_real` ES el costo de canal real, así que no hay ese problema.) Qahwa además: `estado_envio` NULL (la ingesta lee el envío
**solo** cuando llega un aviso `shipments`; en una relectura por `orders_v2` no) y `fecha_liberacion` 1/12 en el CRM vs «a recibir el 14/11» en Mercado Pago.

Hechos del esquema actual que condicionan el diseño (verificados en `db/para-correr/`):
- `meli_ingresar_orden` (3_meli_esquema_base.sql ~1670): acepta el bloque de pago si `pagos_version >=` la guardada (iguales
  se aceptan); si la orden está procesada/acreditada y el neto **confirmado** cambia, deja `revisar = true` con el motivo
  «Los importes cambiaron DESPUÉS de procesarse o acreditarse (neto X → Y): revisar la venta y la caja». **No reescribe la venta ni la caja.**
- `meli_acreditar_orden` (4_meli_ventas_migration.sql 294): bloquea `orden → ventas → caja`; toma `o.neto` (o `p_monto_real`);
  exige `revisar = false` y `financiera_completa`; calcula `costo_canal_usd = total_usd − monto/cot`.
- Trigger `meli__actividad_crear` (15_actividades.sql): al acreditar, crea la actividad «transferir lo acreditado» por `monto_acreditado`.
  Orden de bloqueos de Actividades: `orden → actividad → cajas`.
- `comision_envio` = `bruto − neto` (solo si `cobrado_aprobado >= bruto`), recalculada en la base.

## 2. Qué se construye (en orden)

1. **`comparar`** (hecho, solo lectura): lista las órdenes cuyo pago vivo difiere de lo guardado. Se usa para dimensionar.
2. **Acción `releer`** del worker (sin SQL nuevo, escribe solo por el camino normal `procesarOrden → meli_ingresar_orden`).
3. **Script SQL nuevo** (este diseño): `pagos_leidos_en`, tabla de ajustes, «Aplicar ajuste», neto = lo que llega (net_received + envío del comprador, con lo que `bruto − neto` ya es el costo de canal real), guarda de frescura.
4. **Pantalla**: «Releer pago», aviso de ajuste, botón «Aplicar ajuste».
5. **Barrido**: reparación que reencola también órdenes completas no liberadas/no acreditadas.

## 3. SQL

### 3.1 Esquema

```sql
ALTER TABLE public.meli_ordenes ADD COLUMN IF NOT EXISTS pagos_leidos_en TIMESTAMPTZ;   -- cuándo se leyó el pago POR ÚLTIMA VEZ de Mercado Pago (bloque aceptado)

CREATE TABLE IF NOT EXISTS public.meli_ajustes_pago (
  id              BIGSERIAL PRIMARY KEY,
  orden_id        BIGINT NOT NULL REFERENCES public.meli_ordenes(id),
  estado          TEXT   NOT NULL DEFAULT 'detectado' CHECK (estado IN ('detectado','aplicado','descartado')),
  cobrado_antes   NUMERIC(18,2), cobrado_despues NUMERIC(18,2),
  neto_antes      NUMERIC(18,2) NOT NULL, neto_despues NUMERIC(18,2) NOT NULL,
  delta_neto      NUMERIC(18,2) GENERATED ALWAYS AS (neto_despues - neto_antes) STORED,
  detectado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  aplicado_en     TIMESTAMPTZ, aplicado_por TEXT, nota TEXT,
  acreditada_al_detectar BOOLEAN NOT NULL,           -- ¿la orden ya había entrado a caja cuando se detectó?
  UNIQUE (orden_id, neto_antes, neto_despues)         -- idempotencia de la detección: el mismo cambio no se registra dos veces
);
-- RLS: lectura para autorizados (is_authorized_user()), NINGUNA política de escritura (todo por RPC SECURITY DEFINER, search_path fijo, REVOKE de PUBLIC).
```

### 3.2 `meli_ingresar_orden` (cambio chico)

- Cuando se **acepta** el bloque financiero (`v_aplica_fin`): `pagos_leidos_en = now()`.
- En el bloque que hoy calcula `v_dneto` (neto confirmado distinto en una orden procesada/acreditada): además de `revisar` + motivo,
  `INSERT INTO meli_ajustes_pago (orden_id, cobrado_antes, cobrado_despues, neto_antes, neto_despues, acreditada_al_detectar) … ON CONFLICT DO NOTHING`.
  Se inserta con la fila de la orden **ya bloqueada** (la ingesta la bloquea FOR UPDATE antes) → no agrega orden de bloqueo nuevo.
- **El neto pasa a ser LO QUE LLEGA:** la ingesta (`api/_meli_ingesta.js`) suma por pago aprobado `net_received_amount + shipping_amount` (campo a verificar con
  `desglose`: en el pago vivo de Fakhar/Qahwa debe aparecer 6.148,81 / 4.887,86 como `shipping_amount`; si apareciera en otro campo se cambia solo ese nombre). Se guarda también
  `shipping_amount` en `resumenPago`/`payload_pago` para auditar. Con eso `comision_envio = bruto − neto` (fórmula actual, sin tocar la SQL) pasa a ser el costo de canal real
  (Fakhar 17.674,53; Qahwa 18.835,08) y `acreditar` toma `o.neto` = lo que llega (equivale a `monto_real = llega_real`). `cobrado_aprobado` sigue siendo `transaction_amount`.
- La ingesta debe **leer el envío también en una relectura por `orders_v2`** (hoy solo con aviso `shipments`): `GET /shipments/{id}` (estado, tipo logístico) y, si hace falta,
  `/shipments/{id}/costs`, con el mismo tope de pedidos y manejo de 429. Sin eso Qahwa seguiría con `estado_envio` NULL.
- `financiera_completa` / el invariante de la línea ~1901 no cambian.

### 3.3 `meli_ajuste_aplicar(p_ajuste_id BIGINT, p_nota TEXT)` — SECURITY DEFINER, `is_authorized_user()`

**Orden de bloqueos (el mismo que el resto, sin ciclos):** `meli_ordenes` (la de la orden) → `meli_ajustes_pago` (la fila) → `ventas` → `actividades`
(la `meli_transferir` de la orden, si existe) → `cajas` (vía `_caja_aplicar_delta`). Verificación de que no hay ciclo: `meli_acreditar_orden` toma
orden → ventas → caja; las funciones de Actividades toman orden → actividad → cajas; ninguna toma actividad ANTES que ventas. A confirmar en el banco
de concurrencia (embedded-postgres) con acreditar y transferir corriendo a la vez.

Pasos (una sola transacción; o pasa todo o nada):
1. `SELECT … FROM meli_ordenes WHERE id = (SELECT orden_id FROM meli_ajustes_pago WHERE id = p_ajuste_id) FOR UPDATE`; luego la fila del ajuste `FOR UPDATE`.
2. Si `estado = 'aplicado'` → devuelve `{ya_aplicado: true}` (idempotente: doble clic o reintento). Si `descartado` → error `AJUSTE_DESCARTADO`.
3. Valida: orden no revertida; `delta_neto <> 0`; el **neto actual** de la orden = `neto_despues` del ajuste (si volvió a cambiar, `AJUSTE_DESACTUALIZADO`: hay que releer y mirar el nuevo).
4. Si la orden estaba **acreditada**: delta de caja = `delta_neto` en `acreditado_persona_id / acreditado_bolsillo`:
   `PERFORM _caja_aplicar_delta(persona, bolsillo, delta_neto, 'meli_ajuste', meli_order_id, descripción, usuario, 'meli-ajuste-' || ajuste.id)`
   — la **clave idempotente por ajuste** hace que un reintento no mueva la caja dos veces (mismo patrón que `'meli-acreditar-' || id`).
   Si `delta_neto < 0` y dejaría la caja en negativo: error `CAJA_INSUFICIENTE` (la persona decide a mano).
   `monto_acreditado := monto_acreditado + delta_neto`.
5. **Venta** (bloqueada): se registra el cobro adicional como `venta_pagos` por `delta_neto / meli_cotizacion` (tope: nunca más que el total de la venta menos lo ya
   cobrado) y `costo_canal_usd = round(total_usd − cobrado_total_usd, 2)`, **igual que acreditar**. Si la venta ya está cerrada, queda cerrada.
6. **Actividad «transferir»** (bloqueada): si existe, está `pendiente` y `NOT movio_plata` → se actualiza su `monto` a `monto_acreditado`. Si ya movió plata
   (`movio_plata`) → se crea una **segunda actividad** `meli_transferir` por el `delta_neto` con `clave_unica = 'meli-ajuste-transf-' || ajuste.id` (ON CONFLICT DO NOTHING).
7. Cierre: `neto_confirmado = neto` ya está; se quita de `motivo_revisar` solo el motivo «Los importes cambiaron DESPUÉS…» (con `meli_quitar_motivo`) y `revisar := (motivo restante <> '')`;
   `meli_ajustes_pago` → `aplicado`, `aplicado_en`, `aplicado_por`, `nota`.
8. Devuelve `{ok, monto_acreditado_nuevo, delta, ya_aplicado:false}`.

`meli_ajuste_descartar(p_ajuste_id, p_nota)`: orden → ajuste FOR UPDATE; solo si `detectado`; marca `descartado` y quita el motivo; **no mueve plata**.

Dónde NO se reescribe historia: ni `bruto`, ni la venta, ni la caja se tocan hasta que una persona aprueba «Aplicar ajuste»; hasta entonces la orden queda en revisión con el aviso.

### 3.4 Guarda de frescura (`pagos_leidos_en`) en procesar y acreditar

En `meli_procesar_orden` y `meli_acreditar_orden`, justo después del bloqueo de la orden:
```sql
IF COALESCE((SELECT valor FROM meli_config WHERE clave = 'exigir_pago_reciente'), 'false') = 'true'
   AND (o.pagos_leidos_en IS NULL OR o.pagos_leidos_en < now() - interval '10 minutes') THEN
  RAISE EXCEPTION 'PAGO_SIN_RELEER';
END IF;
```
La pantalla ante `PAGO_SIN_RELEER` llama a `releer` y reintenta (sin pedirle nada al usuario). **Despliegue en dos pasos** para no frenar a nadie: (1) columna + seteo en la ingesta
+ `releer` + pantalla; (2) recién entonces `exigir_pago_reciente = true`. Con la bandera en `false` el comportamiento es el de hoy.

### 3.5 Barrido: red de seguridad

`meli_barrido_reparar` (10_meli_barrido.sql ~409): agregar una tercera pasada (c) que reencola `orders_v2` de órdenes pagadas, no canceladas, de los últimos `p_dias` con
`(NOT acreditado OR fecha_liberacion > now())` y `pagos_leidos_en IS NULL OR < now() - p_horas`, con el mismo `ON CONFLICT DO NOTHING`, el mismo `LIMIT` y sin repetir
dentro de `p_horas`. Son pocas órdenes (las que todavía pueden cambiar). No relee las ya liberadas y acreditadas hace tiempo (ahí se usa `comparar` a demanda).

## 4. Capa de aplicación (sin SQL)

- Worker `accion: 'releer'` `{cuenta, orden}` (sesión): corre `procesarOrden` (lease, relee `/orders/{id}` y TODOS sus pagos) y devuelve `{neto, cobrado, comision_envio, pagos_leidos_en, ajuste_detectado}` leyendo la fila.
- Pantalla (`meli-ordenes.js`): botón «Releer pago» por orden; antes del cuadro de Procesar y de Acreditar se llama a `releer` y, si el neto/cobrado cambió respecto de lo mostrado,
  el cuadro dice «El pago cambió: neto 31.967,66 → 38.116,47 (+6.148,81)» y la confirmación es sobre el número nuevo; en una orden con ajuste detectado: «Ajuste de pago: +6.148,81. Qué es: …» con **Aplicar ajuste** / **Descartar**.
- Ventas: «comisión estimada» sigue siendo `(bruto − neto) / cotización`, pero con el neto ya = lo que llega (neto + envío del comprador) deja de estar sobreestimada; misma regla de estimada/real.

## 5. Tests propuestos

SQL (pglite + embedded-postgres para concurrencia, como `tests/sql/`):
1. Ingesta con un pago que trae `shipping_amount` (net_received_amount 31.967,66 + shipping_amount 6.148,81; transaction_amount 55.791 no cambia) en orden **no procesada**: `neto` = 38.116,47, sin ajuste ni `revisar`.
2. Idem en orden **acreditada**: `revisar = true` + motivo + fila en `meli_ajustes_pago` (única: reenviar la misma ingesta no duplica); caja/venta/`monto_acreditado` **intactos**.
3. `comision_envio = bruto − neto` con el neto ya incluyendo el envío del comprador: Fakhar 55.791 − 38.116,47 = 17.674,53 (antes 23.823,34); sin `shipping_amount` el neto y la comisión no cambian (regresión: todas las órdenes existentes).
4. `meli_ajuste_aplicar`: acreditada → caja +6.148,81 en la caja donde entró, `monto_acreditado` nuevo, venta con pago adicional y `costo_canal_usd` recalculado, actividad pendiente con monto nuevo; `revisar` baja solo si no quedan otros motivos.
5. Idempotencia: doble llamada = un solo movimiento de caja (clave `meli-ajuste-<id>`); llamada concurrente (dos conexiones) = un movimiento.
6. Actividad ya transferida (`movio_plata`) → se crea la segunda actividad por el delta (única por `clave_unica`).
7. `AJUSTE_DESACTUALIZADO` si el neto volvió a cambiar; `CAJA_INSUFICIENTE` si delta negativo y no alcanza; ajuste descartado no mueve nada.
8. Orden de bloqueos: acreditar / transferir / ajustar / ingesta corriendo juntos sin deadlock (banco de concurrencia).
9. Guarda de frescura: bandera apagada = igual que hoy; encendida y lectura vieja → `PAGO_SIN_RELEER`; con `releer` previo pasa.
10. Barrido (c): reencola completas no liberadas/no acreditadas, respeta tope y anti-repetición, no toca las acreditadas y liberadas.
JS: `releer` (lease, solo GET a MP, devuelve importes), pantalla (cuadro «el pago cambió», botones), Ventas (comisión = bruto − neto, con el neto ya incluyendo el envío del comprador).

## 6. Decisiones de Franco (resueltas) y lo que falta

1. **Qué es el extra: RESUELTO.** Es el envío que pagó el comprador y entra al vendedor al liquidar. Cuenta como parte de lo que llega; el costo de canal real es `bruto − llega_real`.
2. **Factura:** el importe sale de `meli_ordenes.bruto` = `total_amount` (precio de los ítems), que este ajuste NO cambia: la factura no cambia. Si algún día se quisiera incluir el envío cobrado al comprador, es una decisión impositiva (contador).
3. **Órdenes ya acreditadas con el neto viejo** (como estas dos): «Aplicar ajuste» crea la entrada de caja por la diferencia (el crédito de envío); se aplican de a una tras ver la lista de `comparar`.
4. **Retenciones de Ingresos Brutos «por falta de alta»** (Santa Cruz −836,87 en Fakhar; Neuquén −940,36 en Qahwa; ~1,5 % de la venta): son NORMALES y van a seguir. Ya están dentro de
   `bruto − llega_real` (el costo de canal), por lo tanto **no se marcan como «diferencia»** (`comparar` no las compara) y se muestran APARTE, por nombre de cargo (la provincia sale en el
   nombre del cargo de Mercado Pago; el nombre exacto se confirma con una corrida real de `desglose`), sumadas sobre TODAS las órdenes revisadas.

## 7. Actualización periódica y resumen de retenciones (propuesta)

**Hoy, sin tocar guardado:** en «Comparar pagos» se elige el rango (atajos «Este mes» / «Mes anterior») y la pantalla muestra, además de las órdenes que difieren, la tabla de
retenciones/impuestos por cargo con su total y «Copiar retenciones» (se pega en una planilla para el contador). Con «Mes anterior» eso ES el resumen mensual por provincia.

**Recordatorio recurrente en Actividades (reutiliza el módulo existente, SQL chico):**
- Un tipo nuevo de actividad `meli_comparar_periodico` con `clave_unica = 'meli-comparar-' || periodo` (`'2026-11'` mensual, o `'2026-W46'` semanal; lo elige Franco: «una vez por semana o por mes»), `UNIQUE(clave_unica)` + `ON CONFLICT DO NOTHING` → idempotente.
- Se crea desde el cron diario que ya existe (`api/meli/worker.js`, GET con `CRON_SECRET`, junto al aviso diario) llamando una RPC `meli__actividad_periodica(p_periodo)` (SECURITY DEFINER, secreto de servicio como el resto): si la actividad del período no existe, la inserta
  con título «Correr “Comparar pagos” y revisar retenciones de <período>», `fecha_objetivo` = día 1 (o lunes), `movio_plata = false`. No toca plata ni órdenes.
- La actividad se cierra a mano («hecha») desde Actividades; la pantalla de Actividades puede ofrecer un enlace directo a «Mercado Libre → Comparar pagos». El aviso diario (email) ya suma las actividades pendientes: aparece solo ahí.
- Si se quiere avisar solo cuando hay algo: una segunda etapa puede guardar el resultado de la última comparación (tabla `meli_comparaciones`: período, órdenes con diferencia, total de la diferencia, retenciones por cargo) escrito por una RPC desde la propia pantalla al terminar; así el mail diario dice «hay 3 órdenes con diferencia (+$17.000) y retenciones por $12.400». Eso SÍ escribe: va con su propio diseño y Codex.

**Tests propuestos (SQL, pglite):** la RPC crea 1 actividad por período aunque se llame varias veces o en paralelo; períodos distintos crean actividades distintas; no crea nada sin secreto; no toca órdenes, ventas, stock ni cajas; el cron no falla si la RPC no existe (script sin correr) y lo informa.

## 8. Tarjeta de la orden: el mismo desglose que muestra Mercado Libre (Qahwa 2000019315185954)

Lo que muestra Mercado Libre en el detalle de la venta (la fuente buena) y lo que hoy muestra el CRM:

| Rubro | Mercado Libre | CRM hoy |
|---|---|---|
| Precio del producto | 62.690,50 | 62.690,50 |
| Cargo por venta | −9.604,72 | «sin desglose todavía» |
| Envíos | −8.290,00 | «sin desglose todavía» |
| Impuestos (retención IIBB) | −940,36 | «sin desglose todavía» |
| **Total** | **43.855,42** | «Te llega 38.967,56»; «se queda Mercado Libre −23.722,94» |
| Liberación | disponible; «a recibir el 14/nov» | `se libera 1/12/2026`; `estado_envio` NULL |

**Las cuentas cierran con los montos que ya expone la API (comprobado con los números reales de la Qahwa):**
- `net_received_amount` del pago (38.967,56) = precio 62.690,50 − cargo por venta 9.604,72 − **cargo bruto de envío 13.177,86** − impuestos 940,36.
- Envíos netos −8.290,00 = cargo bruto de envío −13.177,86 + **crédito de envío pagado por el comprador +4.887,86** (`shipping_amount` del pago).
- Total = 38.967,56 + 4.887,86 = **43.855,42**; costo de canal = precio − total = 18.835,08.

**De dónde sale cada rubro (todo lectura; el desglose por orden de `comparar` ya trae estos números con su fuente para confirmarlo con una corrida real):**
- Precio: ítems de la orden (`order_items[].unit_price × quantity`). Cargo por venta: `order_items[].sale_fee × quantity` (hoy `conciliar` lo muestra como `cargo_venta_sale_fee`).
- Cargo bruto de envío: `charges_details` del pago (tipo/nombre de envío) o `/shipments/{id}/costs` (`gross_amount`/`senders[].cost`); crédito del comprador: `shipping_amount` del pago (o `receiver.cost` de los costos del envío). A confirmar cuál de las dos fuentes es la fija.
- Impuestos/retenciones: `charges_details` del pago con tipo `tax` (Ingresos Brutos «por falta de alta» por provincia: se muestran por nombre de cargo) y `taxes_amount`.
- Total que llega: `net_received_amount + shipping_amount` (campo a verificar con `desglose`).
- **Liberación real**: `money_release_date` VIGENTE del pago (relectura): hoy el CRM tiene la estimada al aprobar (1/12) y no se entera cuando Mercado Pago la adelanta (14/11 = 6/11 de entrega + 8 días). `desglose` ya muestra `money_release_date`, `money_release_status` y `money_release_schema`; `comparar` marca LIBERACION_DISTINTA.
- **Entrega**: `GET /shipments/{id}` (`status` = delivered, fecha de entrega). Hoy la ingesta lee el envío SOLO con un aviso `shipments` (para la Qahwa nunca llegó) → `estado_envio` NULL.

**Diseño (todo guardado de plata/ingesta → Deploy-infra + Codex; nada de esto está construido):**
1. Ingesta (`api/_meli_ingesta.js`): al guardar la orden, guardar también en `payload_orden.items[]` el `sale_fee` por ítem, y en `payload_pago.pagos[]`: `shipping_amount`, `taxes_amount` y `charges_details` resumidos por tipo y nombre (cargo de envío, cargo por venta, impuestos por provincia); neto = `net_received_amount + shipping_amount`. Así la tarjeta calcula el desglose SOLO con lo guardado, sin pedidos extra al abrirla.
2. Leer el envío también en relecturas por `orders_v2` (estado, fecha de entrega, y `/costs` solo si falta el cargo de envío) y **releer pago+envío de las órdenes pagadas no liberadas** (barrido (c) de la sección 3.5, con tope y sin repetir dentro de N horas): así el CRM se entera de la entrega y de la liberación real.
3. Tarjeta (`src/modules/meli-ordenes.js`, ya existe `_resumenMeliHtml`/detalle): mostrar cada rubro con su monto —Precio, Cargo por venta, Envíos (cargo bruto − crédito del comprador), Impuestos (retenciones por provincia)—, «Te llega» = total real (43.855,42), «Costo de canal» = precio − total (18.835,08), y la liberación real («se libera 14/11» o «ya disponible»). Si la orden todavía no tiene el desglose guardado, decir «releer pago» (botón) en vez de «sin desglose».
4. `comparar` ya marca las órdenes cuyo «llega real» vivo difiere de lo guardado (`LLEGA_REAL_DISTINTO`), la liberación distinta (`LIBERACION_DISTINTA`/`APARECE`/`DESAPARECE`) y muestra las retenciones aparte; en el futuro, cuando la ingesta guarde el desglose, también comparará cada rubro.
5. Tests: ingesta con el pago de la Qahwa (cargo venta 9.604,72; cargo envío 13.177,86; shipping_amount 4.887,86; tax 940,36; net_received 38.967,56) → neto guardado 43.855,42, comisión/costo de canal 18.835,08 y desglose por rubro que suma el total exacto en centavos; tarjeta muestra los 4 rubros y el total; liberación vigente; relectura de pagada-no-liberada actualiza la fecha (y la entrega); sin shipping_amount nada cambia.

Nota de privacidad: la página de ML de la venta también trae el documento y la condición fiscal del comprador; ninguna de estas herramientas ni este diseño los lee, guarda ni muestra.
