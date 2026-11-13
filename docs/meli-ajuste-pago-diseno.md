# Ajuste de pago de Mercado Libre: diseño SQL (para Deploy-infra)

Estado: **DISEÑO, no hay código de guardado escrito.** Lo único construido es la herramienta de solo lectura `comparar`
(`api/_meli_comparar.js`, rama `claude/meli-comparar`). Todo lo de abajo toca plata: va por Deploy-infra + Codex + «desplegá» de Franco.

## 1. El problema

Un pago de Mercado Pago puede cambiar **después** de la venta (ajuste de monto, envío o intereses a cargo del comprador,
devolución…). Caso real (Franco, capturas de Mercado Pago):

| Orden | Bruto CRM | Neto CRM | MP monto | MP total recibido | Diferencia (monto y neto) |
|---|---|---|---|---|---|
| 2000018981569144 | 55.791,00 | 31.967,66 | 61.939,81 | 38.116,47 | +6.148,81 (idénticas, centavo por centavo) |
| 2000019315185954 | 62.690,50 | 38.967,56 | 67.578,36 | 43.855,42 | +4.887,86 (idénticas) |

El CRM leyó el pago al ingresar la orden y nunca lo volvió a leer: las dos estaban «completas» (`financiera_completa`), y
ni el barrido (`order.date_last_updated` de la ORDEN, que no cambia) ni su reparación (solo `NOT financiera_completa`) las
reencolan. Mercado Pago probablemente no emite aviso por un «ajuste en el monto».

Consecuencias: «Llega», margen y profit por debajo de lo real; la acreditación toma el neto viejo; la comisión
(`bruto − neto`) queda **subestimada** apenas se relea (el neto incluye un extra que el bruto no tiene).

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
3. **Script SQL nuevo** (este diseño): `pagos_leidos_en`, tabla de ajustes, «Aplicar ajuste», comisión = cobrado − neto, guarda de frescura.
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
- `comision_envio` pasa a `round(cobrado_aprobado − neto, 2)` (con la misma condición de cobertura). Hoy es `bruto − neto`; son iguales mientras
  `cobrado = bruto` (todas las órdenes sin ajuste), y distintas justamente en el caso del ajuste, donde `bruto − neto` está mal.
  `diferencia_comision` sigue = `comision_envio − comision_declarada`. **Ojo:** `financiera_completa` / el invariante de la línea ~1901 no cambian.

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
- Ventas: «comisión estimada» = `(cobrado_aprobado − neto) / cotización` (hoy `(bruto − neto)`), con la misma regla de estimada/real.

## 5. Tests propuestos

SQL (pglite + embedded-postgres para concurrencia, como `tests/sql/`):
1. Ingesta con el pago que sube (cobrado 55.791→61.939,81; neto 31.967,66→38.116,47) en orden **no procesada**: se actualiza, sin ajuste ni `revisar`.
2. Idem en orden **acreditada**: `revisar = true` + motivo + fila en `meli_ajustes_pago` (única: reenviar la misma ingesta no duplica); caja/venta/`monto_acreditado` **intactos**.
3. `comision_envio = cobrado − neto` (23.823,34) con y sin ajuste; sin ajuste = `bruto − neto` (regresión: todas las órdenes existentes).
4. `meli_ajuste_aplicar`: acreditada → caja +6.148,81 en la caja donde entró, `monto_acreditado` nuevo, venta con pago adicional y `costo_canal_usd` recalculado, actividad pendiente con monto nuevo; `revisar` baja solo si no quedan otros motivos.
5. Idempotencia: doble llamada = un solo movimiento de caja (clave `meli-ajuste-<id>`); llamada concurrente (dos conexiones) = un movimiento.
6. Actividad ya transferida (`movio_plata`) → se crea la segunda actividad por el delta (única por `clave_unica`).
7. `AJUSTE_DESACTUALIZADO` si el neto volvió a cambiar; `CAJA_INSUFICIENTE` si delta negativo y no alcanza; ajuste descartado no mueve nada.
8. Orden de bloqueos: acreditar / transferir / ajustar / ingesta corriendo juntos sin deadlock (banco de concurrencia).
9. Guarda de frescura: bandera apagada = igual que hoy; encendida y lectura vieja → `PAGO_SIN_RELEER`; con `releer` previo pasa.
10. Barrido (c): reencola completas no liberadas/no acreditadas, respeta tope y anti-repetición, no toca las acreditadas y liberadas.
JS: `releer` (lease, solo GET a MP, devuelve importes), pantalla (cuadro «el pago cambió», botones), Ventas (comisión = cobrado − neto).

## 6. Decisiones que NO son técnicas (para Franco)

1. **Qué es el extra**: si es envío a cargo del comprador (Flex) o intereses, el dinero entra al vendedor 1:1. ¿Cuenta como ingreso de la venta, o compensa un costo de envío que el vendedor paga por fuera? Con la fórmula de arriba el profit
   sube por el extra (`costo_canal = total − neto/cot`); si es reembolso de un costo que se carga aparte, correspondería no contarlo. Hace falta el motivo del «ajuste en el monto» que muestra Mercado Pago.
2. **Factura**: el importe sale de `meli_ordenes.bruto` = `total_amount` (precio de los ítems), que el ajuste no cambia: hoy la factura NO cambia. Si el ajuste fuera un cambio de PRECIO, `total_amount` también cambiaría y una factura ya emitida
   requeriría nota de crédito + nueva factura. Decisión impositiva de Franco/contador según el motivo.
3. **Órdenes ya acreditadas con el neto viejo** (como estas dos): «Aplicar ajuste» crea la entrada por la diferencia; hay que decidir si se aplica una por una (recomendado) tras mirar la lista de `comparar`.
