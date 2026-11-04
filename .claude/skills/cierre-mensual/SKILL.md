---
name: cierre-mensual
description: Controles financieros de los lunes y preparación del cierre del mes (día 1) con doble control de Codex. Usala en las corridas del agente de Finanzas.
---

# Controles y cierre mensual

**Modo control (lunes)** y **modo cierre (día 1, sobre el mes anterior)**. En los dos, sólo se lee.

Las vistas no traen texto libre (descripciones, notas), JSON ni datos personales. Clasificá por categoría, caja, tipo y referencia. Si para un control hace falta una descripción, dejá una `tarea` para Franco con los ids, en vez de adivinar.

## Controles (mirá antes las columnas reales de cada vista)
1. **Cuadre**: por caja, `saldo` contra la suma de `delta` en `caja_ledger`. Diferencias de más de USD 1 o $1.000, salvo las cajas marcadas como excluidas del control: esas se cuentan aparte.
2. **Ventas abiertas** (`estado = 'abierta'`) con más de 30 días, y deudas vencidas en `deudas_manuales`.
3. **Gastos fijos**: cada fila de `gastos_fijos_plantilla` tiene que tener su gasto del mes en `gastos`.
4. **Gastos sin categoría o sin caja**.
5. **Mercado Libre**: órdenes procesadas sin acreditar con fecha de liberación vencida, y acreditadas con la actividad de transferir pendiente.
6. **Cotización**: `cotizaciones` (columnas `nombre`, `valor`: `ref_blue` / `ref_usdt`) sin actualizar hace más de 7 días.
7. **Cierres**: que exista `cierres_mensuales` del mes anterior (en modo control, a partir del día 5).
8. **Transferencias entre cajas** (`caja_movimientos`): las del período por `tipo` (pasada de manos, retiro y depósito de banco, otro), con caja de origen → destino, moneda y monto.
   - Totales por tipo y por caja.
   - Marcá las que no tienen comprobante (`comprobante_url` vacío) y las de montos grandes (más de USD 500 o $500.000).
   - **Límite conocido:** un movimiento revertido se borra de `caja_movimientos`, y el libro (`caja_ledger`) no guarda el id del movimiento. No se puede conciliar uno por uno. Compará, por caja y por día, la suma de los movimientos contra las líneas del libro de tipo `movimiento`; si no coinciden, listá la caja, el día y la diferencia como "a revisar" (no como error seguro).
9. **Gastos del mes, en detalle** (`gastos` + `categorias_gasto`): por categoría y por caja, en ARS y en USD por separado.
   - Comparación con el mes anterior por categoría (sube o baja más de 30%).
   - Los 10 gastos más grandes (id, fecha, categoría, caja, monto).
   - Gastos fijos: la plantilla se vincula con cada gasto por el motivo, que las vistas no muestran. Contá los gastos marcados `es_fijo` del mes contra las filas activas de `gastos_fijos_plantilla` y compará los totales por moneda. Si no coinciden, dejá una `tarea` para Franco con los ids de la plantilla, sin adivinar cuál falta.
10. **Sueldos de socios y adelantos**, por socio y siempre por separado (sin calcular un "neto a pagar"):
   - **Sueldo registrado**: los gastos con `es_sueldo_socio` del mes (`mes_cierre`). El CRM los carga como pagados al confirmar el reparto.
   - **Adelantos** (`adelantos_socios`) del mes: `pendiente` y `cobrado`, con monto y moneda.
   - El CRM **no** descuenta los adelantos del reparto. Mostrá las tres cosas una al lado de la otra, en su moneda, y señalá a Franco los adelantos pendientes para que decida cómo se descuentan. **El reparto lo decide Franco en Gastos → cierre**: no proponés montos de sueldo ni conviertes monedas para compensar.
11. **Inversores** (`inversores` activos + `inversor_pagos`): por inversor, la cuota del mes (`cuota_mensual_usd`), lo pagado con `mes_referencia` de ese mes y lo pendiente.
   - Marcá los que quedaron sin pagar o pagados de menos, y los pagos sin `mes_referencia`.
   - Total pagado a inversores en el mes y acumulado.

## El detalle del mes (los dos modos)
- En modo control (lunes) se mira el **mes en curso hasta hoy**, para ir armando el cierre de a poco: cada lunes el detalle del mes queda más completo y los pendientes, más cortos.
- En el `payload` del informe va el detalle por sección: `transferencias`, `gastos`, `sueldos` (por socio), `inversores` (por inversor) y `pendientes`.
- Arriba del `resumen` van los números que Franco necesita para cerrar: margen del mes hasta hoy, gastos totales, sueldos registrados y adelantos pendientes por socio, y lo pendiente con inversores.

## Modo cierre
- Totales del mes por SQL:
  - ventas en USD;
  - costo de lo vendido;
  - margen bruto;
  - gastos por categoría;
  - diferencial de tarjeta;
  - operaciones de cueva.
  - transferencias entre cajas (por tipo; no cambian el resultado, pero tienen que cuadrar);
  - sueldos de socios y adelantos, por socio;
  - pagos a inversores: cuota, pagado y pendiente, por inversor.

  **No es el número oficial**: es el control cruzado contra lo que mostrará CRM → Reportes.
- **Doble control**: pasale a Codex (skill `segunda-opinion-codex`) el mismo pedido y las mismas vistas, sin tus resultados, para que calcule por su cuenta. Compará:
  - si coinciden dentro de la tolerancia, `estado_control = "listo"`;
  - si no, `"revisar"`, con las dos cifras y dónde difieren.
- Proponé un `cierre` con clave `finanzas-cierre-<AAAA-MM>`. Lleva la lista de pendientes que Franco resuelve antes de "Confirmar cierre", y `payload` con totales, diferencias y `estado_control`.
- Si un control es grave (una caja con diferencia grande, plata de Mercado Libre trabada), creá además una `alerta`.
