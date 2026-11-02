# Especificación F1 (para delegar): «Hoy se liberan / Liberadas sin confirmar»

Dueño de la revisión: Ventas+Cueva. Quien construye trabaja en un worktree aparte y NO se autorrevisa: Ventas+Cueva revisa el resultado. Sin SQL, sin plata, sin deploy, sin push. No escribir en ningún mensaje de commit la marca de despliegue.

## Qué es
Un resumen calculado de las órdenes de Mercado Libre que el CRM YA tiene cargadas (`State.meliOrdenes`), para que Franco sepa cuándo se libera plata y qué liberada falta confirmar. No crea nada, no mueve plata, no guarda nada.

## Dónde se ve (tres lugares)
1. **Tarjeta** al tope de la pantalla de Mercado Libre.
2. **Badge** en el ítem «Mercado Libre» del menú.
3. **Aviso (toast) al abrir el CRM**, una vez por día y por pestaña.

## Archivos
**Nuevos (todo el código de F1 vive acá):**
* `src/modules/liberaciones.js` → expone `window.Liberaciones` con: `resumen(ordenes, ahora = new Date())`, `textoAviso(resumen)`, `cantidadBadge(resumen)`, `tarjetaHtml()`, `actualizarBadge()`, `avisoAlAbrir()`.
* `tests/liberaciones.test.mjs` → pruebas (node + `vm`, mismo estilo que `tests/cajas.test.mjs`, ejecutable con `node tests/liberaciones.test.mjs`; no editar `tests/cajas.test.mjs`).

**Editar SOLO con estas líneas (cada una es un agregado de 1 a 3 líneas, nada más):**
* `src/modules/app.js`: (a) `import './liberaciones.js';` junto a los otros imports de `meli-*.js`; (b) en `actualizarBadges()`, una línea final `window.Liberaciones?.actualizarBadge?.();`; (c) en `init`, justo después de `this.goTo('dashboard');`, `window.Liberaciones?.avisoAlAbrir?.();`.
* `crm.html` línea del ítem `data-page="meli"`: agregar `<span id="badge-meli" style="display:none;margin-left:auto;background:var(--amber);color:#000;border-radius:20px;font-size:10px;font-weight:700;padding:1px 6px;min-width:18px;align-items:center;justify-content:center"></span>` dentro del div (mismo formato que `badge-ventas`).
* `src/modules/meli-ordenes.js`: dentro de `_vista()`, justo ANTES del `<div class="card" style="margin-bottom:10px;display:flex;gap:24px...` de «a liberar», insertar `${window.Liberaciones ? window.Liberaciones.tarjetaHtml() : ''}`.

**NO tocar (otro trabajo en curso o plata):** `src/modules/state.js` (incluido `meliPendienteLiberar`), `capital.js`, `dashboard.js`, `cajas.js`, `supabase-config.js`, `ventas.js`, `proveedores.js`, cualquier `.sql`, `docs/`, `tests/cajas.test.mjs`, `tests/sql/*`. Cualquier otra cosa que parezca necesaria: parar y consultar.

## Datos que lee (solo lectura, de `State.meliOrdenes`)
`id`, `orderId`, `procesada`, `acreditado`, `revertidaEn`, `revisar`, `financieraCompleta`, `neto`, `fechaLiberacion` (ISO con zona), y `cerradaManualEn` (puede no existir todavía: `undefined` = no cerrada). Nada más. No leer comprador, productos ni importes de venta.

## Definiciones (todo en hora de Argentina = UTC−3 fijo, sin horario de verano)
* Día AR de un instante: `new Date(t − 3 h).toISOString().slice(0,10)`.
* **Candidata a acreditar:** `procesada` y no `acreditado` y no `revertidaEn` y no `cerradaManualEn` y no `revisar` y `financieraCompleta` y `neto` numérico finito > 0 y `fechaLiberacion` válida.
* `resumen(ordenes, ahora)` devuelve:
  * `hoy`: candidatas cuyo día AR de liberación = hoy AR → `{ ordenes: N, monto: Σ neto, yaLiberadas: cuántas con fechaLiberacion <= ahora, monto de esas, pendientes de hora: el resto }`.
  * `atrasadas`: candidatas con día AR de liberación < hoy AR → `{ ordenes, monto }`.
  * `proximas`: candidatas con día AR de liberación en mañana … +3 días → `{ ordenes, monto }`.
  * `sinProcesar`: órdenes NO procesadas, no revertidas, no cerradas a mano, sin `revisar`, con `fechaLiberacion` hoy o antes → solo `{ ordenes: N }` (aviso «hay N sin procesar que ya se liberan»).
  * `sinDato`: órdenes `procesada` no acreditadas ni revertidas ni cerradas con `neto` nulo o `financieraCompleta` falso → `{ ordenes: N }` (no se suman al monto: «sin importe confirmado»).
  * Montos en pesos redondeados a 2 decimales; NUNCA tratar un neto nulo como 0.
* **Confirmar** (liberadas sin confirmar) = `atrasadas` + `hoy.yaLiberadas`.
* `cantidadBadge(r)` = cantidad de órdenes a confirmar (atrasadas.ordenes + hoy.yaLiberadas.ordenes). Si es 0, el badge se oculta (`display:none`); si no, `display:inline-flex` con el número. El elemento puede no existir: no tirar.

## Textos exactos (español rioplatense)
Tarjeta (se omite entera si todo es 0, salvo `sinDato`/`sinProcesar` > 0 que muestran solo su línea):
* Título: «Liberaciones de Mercado Libre».
* «Hoy se liberan **$X** (N orden/es)» + si hay hoy pendientes de hora: « · M todavía no llegaron a su hora».
* «Liberadas sin confirmar: **$Y** (M orden/es) — confirmá la acreditación en cada orden».
* «Próximos 3 días: **$Z** (K orden/es)».
* «Hay N orden/es sin procesar cuya plata ya se libera: procesalas primero».
* «N orden/es sin importe confirmado (no suman)».
* Concordancia: «1 orden» / «2 órdenes». Montos con `State.fmtARS`.
Aviso (toast): `textoAviso(r)` = «Hoy se liberan $X en N órdenes. Tenés M liberadas sin confirmar por $Y.» (cada oración solo si su cantidad > 0; si no hay nada que decir devuelve `''` y no se muestra nada). `avisoAlAbrir()` lo muestra a lo sumo UNA vez por día AR y por pestaña, recordándolo en `sessionStorage` (con `try/catch`: si falla, se muestra igual). Debe esperar a que `State.meliOrdenes` esté cargado (si está vacío o `State.meliError`, no avisar).
Todo texto que venga de datos se escapa con `State.esc`; en F1 solo hay números y fechas.

## Casos de prueba mínimos (`tests/liberaciones.test.mjs`)
1. Orden candidata liberada hoy a las 14:00 AR, ahora = 15:00 AR → `hoy.ordenes 1`, `yaLiberadas 1`, badge 1.
2. Misma orden pero ahora = 10:00 AR → `hoy 1`, `yaLiberadas 0`, `pendientes de hora 1`, badge 0.
3. Liberada ayer → `atrasadas`; liberada el 31/12 23:30 AR vista el 1/1 00:10 AR → `atrasadas` (día AR, no UTC).
4. Borde UTC: `2026-10-09T02:30:00Z` es el 8/10 23:30 AR → cuenta como 8/10.
5. Excluidas de candidatas: `acreditado`, `revertidaEn`, `cerradaManualEn`, `revisar`, no procesada, `neto` nulo/0/NaN, `financieraCompleta` falso (esta última cuenta en `sinDato`), `fechaLiberacion` inválida.
6. `neto` nulo nunca suma 0: `sinDato.ordenes` lo cuenta y el monto no cambia.
7. Suma de montos con centavos (`37757.26 + 100.10`) sin error de coma flotante.
8. `proximas`: mañana, +3 sí, +4 no.
9. `sinProcesar`: no procesada, liberación hoy, sin revisar → cuenta; con `revisar` → no.
10. `textoAviso`: todas las combinaciones (solo hoy, solo atrasadas, ambas, nada → `''`), plural/singular.
11. `avisoAlAbrir`: una sola vez por día con `sessionStorage` simulado; con `sessionStorage` que tira, igual muestra; con `State.meliError` o lista vacía no muestra.
12. `actualizarBadge`: elemento ausente no tira; 0 oculta; N muestra.
13. `tarjetaHtml`: todo en 0 → `''`; con datos contiene los textos exactos; escapado.
14. El módulo no modifica `State.meliOrdenes` ni ningún objeto recibido (congelar la entrada con `Object.freeze` profundo y comprobar que no tira).

## Entrega
Rama propia en un worktree; commits chicos (módulo + pruebas; luego los tres engarces de una línea); `node tests/liberaciones.test.mjs` y `node tests/cajas.test.mjs` pasando (el segundo sin cambios, solo para comprobar que no se rompió nada). Sin push. Ventas+Cueva revisa antes de integrar.

## Orden de commits (todo el trabajo de Actividades)
1. **F1** (Codex, worktree) → integra primero: son archivos nuevos y tres líneas de engarce.
2. **Script 15** (Ventas+Cueva): `db/pendientes/actividades.sql` + `db/para-correr/15_actividades.sql` + banco SQL (pglite y dos conexiones reales) + `tests/sql/package.json` + línea en `paquete.test.mjs`. Sin código de pantalla.
3. **Pantalla Actividades** (Ventas+Cueva): `src/modules/actividades.js`, cambios en `app.js`/`crm.html` (ítem del menú, badge propio, aviso) rebasados sobre F1, pruebas en `tests/cajas.test.mjs`.
4. **F4** email diario, después de aprobar un plan breve.
