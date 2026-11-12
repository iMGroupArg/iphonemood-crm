# Facturas de Mercado Libre — Fase 1 (control en el CRM) — especificación para delegar

Fecha: 2026-10-13. Aprobado por Franco (plan en /Users/francovelas/.claude/plans/dazzling-tumbling-stardust.md). Fase 1 = SOLO CONTROL: el CRM no emite facturas ni habla con ARCA. Registra, por cada orden de Mercado Libre, si ya tiene factura y cuál.

## Reglas que mandan (innegociables)
- Emisor único y fijo: Franco Ezequiel Velas (titular de la cuenta). El CRM NO ofrece elegir otro emisor, ni por orden ni por factura.
- El CRM NUNCA edita importes ni descripción de producto: lo que se factura es lo de la orden. Esta fase ni siquiera muestra importes editables.
- NO se guarda DNI/CUIT, dirección ni nombre del comprador. Solo estado, número de comprobante, fecha, motivo y quién marcó.
- NO hay ninguna función que reparta ventas ni sugiera cómo agruparlas para quedar bajo un tope fiscal.
- Retención: el registro de comprobante (número, fecha) es fiscal; NO se borra a los 180 días (esa limpieza es de datos de envío/contacto).

## Qué se construye
1. Tabla `meli_facturas` (SQL: la escribe una sesión de Claude, NO Codex; ver "Contrato de datos"): una fila por orden.
2. Pantalla/Sección en CRM → Mercado Libre: en cada orden un chip de factura (Pendiente / Emitida / No corresponde) y acciones; filtro "Sin factura"; contador "N ventas sin factura".
3. Sin ARCA, sin plata, sin stock.

## Contrato de datos (lo define el SQL; la UI lo consume)
- Tabla `public.meli_facturas`: `orden_id` (text, PK, = meli_ordenes.meli_order_id), `estado` ('pendiente' | 'emitida' | 'no_corresponde'), `numero` (text, ej. "0003-00001234", solo si emitida), `emitida_el` (date, solo si emitida), `motivo` (text, obligatorio si no_corresponde, máx 200), `marcada_por`, `marcada_en`.
- Lectura: `supa.from('meli_facturas').select(...)` (solo usuarios autorizados). Escritura SOLO por la RPC `meli_factura_marcar(p_orden text, p_estado text, p_numero text, p_emitida_el date, p_motivo text)`; el navegador no escribe la tabla. Las órdenes sin fila se consideran 'pendiente'. Una orden revertida o descartada no cuenta como "sin factura".
- Validaciones de la UI (la base las repite): número con formato `NNNN-NNNNNNNN` (4 y 8 dígitos); fecha no futura; motivo obligatorio para no_corresponde; no se puede marcar 'emitida' sin número.

## Archivos
- NUEVOS: `src/modules/meli-facturas.js` (lógica pura + render + acciones), `tests/meli-facturas.test.mjs`.
- Engarces mínimos permitidos (1–3 líneas cada uno): `src/modules/meli-ordenes.js` (insertar el chip y botones en la tarjeta de cada orden), `src/modules/supabase-config.js` (cargar `State.meliFacturas` con `select`; y un `DB.marcarFactura` que llame a la RPC).
- NO tocar: state.js, capital.js, dashboard.js, cajas.js, ventas.js, proveedores.js, cualquier SQL, otros docs, tests de cajas.

## Comportamiento
- Chip "Factura pendiente" (ámbar), "Factura 0003-00001234" (verde), "Sin factura: <motivo>" (gris).
- Botones: "Marcar emitida…" (pide número y fecha), "No corresponde…" (pide motivo), "Reabrir" (vuelve a pendiente; avisa que se pierde el número).
- Aviso arriba de la lista de órdenes: "N ventas de Mercado Libre sin factura" (solo si N > 0; botón "Ver").
- Texto fijo visible: "El CRM no emite facturas: acá solo se registra la que emitiste. Tiene que ser a nombre de Franco Ezequiel Velas y por el importe real de la venta."
- Si la RPC falla: mostrar el error en castellano y NO cambiar el estado en pantalla (nada de estado optimista).
- Todo texto de Mercado Libre o del usuario se escapa con State.esc.

## Casos de prueba mínimos
1. Orden sin fila = pendiente. 2. Emitida con número válido. 3. Número inválido rechazado. 4. Fecha futura rechazada. 5. no_corresponde sin motivo rechazado. 6. Reabrir limpia número y fecha. 7. Revertida/descartada no cuenta como sin factura. 8. Contador de sin factura. 9. Error de RPC no cambia el estado. 10. Escape de HTML en motivo. 11. No existe ningún campo/acción para elegir emisor ni para editar importes. 12. No se guarda ni muestra DNI/CUIT/dirección.

## Entrega
Worktree aparte, pruebas pasando, UN commit local, sin push ni deploy ni la marca [deploy]. Revisa una sesión de Claude (Ventas+Cueva o Deploy-infra). El SQL (tabla, RPC, permisos) lo escribe Claude y debe estar probado antes de publicar la UI; la UI debe degradar sin romperse si la tabla todavía no existe.
