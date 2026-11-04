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

## Modo cierre
- Totales del mes por SQL:
  - ventas en USD;
  - costo de lo vendido;
  - margen bruto;
  - gastos por categoría;
  - diferencial de tarjeta;
  - operaciones de cueva.

  **No es el número oficial**: es el control cruzado contra lo que mostrará CRM → Reportes.
- **Doble control**: pasale a Codex (skill `segunda-opinion-codex`) el mismo pedido y las mismas vistas, sin tus resultados, para que calcule por su cuenta. Compará:
  - si coinciden dentro de la tolerancia, `estado_control = "listo"`;
  - si no, `"revisar"`, con las dos cifras y dónde difieren.
- Proponé un `cierre` con clave `finanzas-cierre-<AAAA-MM>`. Lleva la lista de pendientes que Franco resuelve antes de "Confirmar cierre", y `payload` con totales, diferencias y `estado_control`.
- Si un control es grave (una caja con diferencia grande, plata de Mercado Libre trabada), creá además una `alerta`.
