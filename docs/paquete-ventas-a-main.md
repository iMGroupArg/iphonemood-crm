# Paquete «Ventas» para main (preparado por Ventas+Cueva, 2026-11-12)

Estado: **listo, NO publicado**. Sin push, sin marca de despliegue. Veredicto de Codex: APROBADO en la 5ª ronda (`docs/veredicto-codex-resultadoventa.md`, último commit revisado `62f2acf`, 2026-11-12 08:10 -0300).

## Dónde está
Rama local `claude/ventas-orden-fecha-profit-real`, worktree `/Users/francovelas/crm-complete/worktrees/ventas-a-main-prueba`, basada en **origin/main 0fb313a** (merge del PR #4). 6 commits, sin conflictos:

| Commit (base main) | Equivale a (rama landing-rediseno-2026-08) | Qué es |
|---|---|---|
| b9f2892 | 5e669b5 | Ventas: orden por fecha, filtros, número de orden de ML, detalle limpio, profit real |
| 22f4911 | 14495cd | correcciones de la ronda 1 (export por rubro, centavos, umbral, caché) |
| 47897e9 | 6858c09 | resultado por rubro (reparte el resultado completo de la venta) |
| 228e72c | 3fab4cc | export: comisión por ítem con la proporción de Reportes |
| 804fd9a | 62f2acf | sin acumulación de redondeo; rubro único con precios en cero |
| 575073f | e147310 | ARNÉS de pruebas con rutas relativas (commit aparte, puede llevarse o no) |

## Archivos que toca (EXACTO)
1. `src/modules/ventas.js` (+234/−~70). Hunks por zona: encabezado (`_nicho`, ~l.61); NUEVOS `_diaLocal`, `_vistaRubro`, `_resultadoRubro` y `ventasDelPeriodo` reescrita (l.85–180); `resultadoVenta` (l.~236–255: `esMeli`, `costoCanalReal`, `canalEstimado`, `costoCanal`); export a Excel (l.~290–380: columnas `Orden ML`, `Canal`, comisión por ítem); `renderMetricas` (l.~440–455); lista de ventas (`#` con «ML <orden>» y tarjeta móvil, l.~543–562); `viewSale` detalle (l.~2232–2360: encabezado con número de orden, cliente sin filas vacías, tabla de accesorios, resumen en tablita); helpers al final (`_repartirCentavos`, `_comisionPorItem`, `_ordenDeVenta`, `_numeroMeli`, `_canalEstimado`, `_detalleMeli`, `_resumenMeliHtml`, l.~2959–3010).
2. `src/modules/meli-ordenes.js` — **solo 2 líneas (l.692–693 en main), la etiqueta del detalle de una orden procesada**:
   - `fila('Costo de comisión y envío', o.acreditado ? State.fmtUSD(r.costoCanal) : 'se fija al acreditar')` → `fila('Comisión y envío', … '≈ USD x (estimada)' | 'sin importes confirmados')`
   - `fila(o.acreditado ? 'Margen comercial' : 'Margen provisorio (todavía sin descontar comisión y envío)', …)` → `'Margen provisorio (con la comisión estimada)'` / `'(sin descontar comisión)'`.
   Si el adelanto de Mercado Libre toca esas mismas líneas (o `MeliOrdenes.abrirDetalle`), habrá choque: es chico y se resuelve a mano.
3. `tests/cajas.test.mjs` — secciones 45–48 nuevas (+ reescritas 45/46) y, en el commit aparte, 3 líneas de rutas relativas.
**No toca:** app.js, crm.html, supabase-config.js, state.js, reportes.js, ningún SQL ni api/.

## Requisitos / dependencias
- Sin SQL. Usa campos que main YA carga: `State.meliOrdenes[].{orderId, ventaId, financieraCompleta, bruto, neto, acreditado, revertidaEn}` (supabase-config.js l.360–367 de main) y `ventas.meliCotizacion/costoCanal` (l.182–183).
- Cambia el CÁLCULO de ganancia: `Ventas.resultadoVenta` incluye la comisión ESTIMADA de ML mientras no hay costo real. Consumidores (reportes.js, dashboard.js, cashflow.js, gastos.js) no se modifican y no descuentan dos veces (verificado por Codex).
- Mientras producción lleve parches por cherry-pick, revisar que `ventas.js` y `meli-ordenes.js` de producción no tengan cambios propios (Facturación/PDF/NC/adelanto) que este paquete pise: **diff entre el ventas.js de producción y el de origin/main 0fb313a** antes de aplicar.

## Pruebas sobre esa base
- Suites JS (todas con rutas relativas): arca 37, arca_diagnostico 12, facturacion_atrasadas 22, liberaciones 15, meli-facturas 49, meli 18, meli_auto_pantalla 13, meli_emitidas 9, meli_facturar_pantalla 13, meli_sonda 38, meli_vincular 63, meli_vincular_pantalla 85, portapapeles OK, presupuesto_bot_endpoint 40, worker_disparador 7 → **todas pasan**.
- `tests/cajas.test.mjs` con el arnés corregido, sobre la base de main: **448 pasan, 0 fallan**, PERO la suite se ABORTA en 2 secciones que no corresponden a este paquete (deuda, ver abajo). Sin esas dos secciones, verde.

## DEUDA que destapó el arnés corregido (NO se arregla en este paquete)
La suite de cajas de main incluía pruebas de arreglos que **solo existen en la rama landing-rediseno-2026-08** (y que, hasta hoy, la suite de main probaba contra la otra carpeta, por eso «pasaban»):
1. Sección **37 – GASTOS** (`e.mod.Gastos._opcionesBolsillo is not a function`): falta en main el commit **bcd8647** (el formulario de gastos: la caja que paga se elige a propósito y es de la misma moneda; aviso con la caja real). Es el arreglo del reporte de Angel Campos.
2. Sección **38 – FECHAS** (`DBr._utc is not a function`): falta en main el commit **d906d54** (las horas sin zona de `gastos.creado_en` se leen como UTC: un gasto de las 21:02 aparecía a las 00:02 del día siguiente).
Ambos son arreglos reales de producción que NO están publicados. Si Franco los quiere, son dos cherry-picks aparte (con su propia prueba); yo los preparo.
