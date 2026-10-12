# Presupuestos creados por el bot: análisis del lado del CRM (sin implementar)

Fecha: 2026-10-12. Pedido de Angel (Sesión C, tarea 3). Solo lectura del código del CRM.

## Estado y decisiones de Franco (actualizado 2026-10-12)
- Franco APROBÓ avanzar: primero se limita el link público (seguridad) y después se arma el endpoint del bot. Todavía NO se construyó nada: Deploy-infra está haciendo el plan, que revisa Codex antes de construir.
- Requisito de Franco: los presupuestos que cree el bot deben ser del MISMO tipo que los creados desde la web/CRM: mismo link `precios.html?presupuesto=<token>`, misma página para el cliente y misma lista en el CRM (con etiqueta "Bot").
- Datos de contacto del cliente: se guarda lo mínimo (contacto y canal) y se borra a los 180 días.
- Lo que el bot puede tener listo mientras tanto: pedir el id por unidad (se agrega al catálogo) y preparar el pedido con la forma de la sección 4. Los detalles finales del contrato (nombres de campos, clave nueva, límites) se confirman cuando el plan esté aprobado; hasta entonces todo lo de la sección 4 es PROPUESTA.

## 1. Cómo se guarda hoy un presupuesto manual
- Tabla `presupuestos` (db/migrations/20260820_presupuestos.sql): `id`, `token` único, `creado_en`, `vence_en` (NULL = no vence), `cliente` (solo nombre, texto), `producto` (JSON: nombre, modelo, storage, color, categoría, estado, cantidad, precio_unitario_usd, precio_usd total, servicios), `trade_in` (JSON: equipos[] con modelo/storage/color/estado/bateria_pct/valor_usd, valor_usd total, efectivo opcional), `cotizacion` (dólar blue del día), `pagos_cfg` (coeficientes de financiación), `notas`.
- Lo crea la pantalla src/modules/presupuestos.js (`guardar()`): `insert` directo desde el navegador del usuario logueado. La política de la tabla solo permite leer/escribir a usuarios autorizados.
- Token: 16 bytes de crypto.getRandomValues en hexadecimal (32 caracteres). Caduca según `vence_en`; el formulario usa 7 días por defecto.

## 2. Qué hace precios.html?presupuesto=<token>
- Llama a la función de base `presupuesto_por_token(token)` (ejecutable por la clave pública). Devuelve la fila SIN el id; si venció, no devuelve nada y la página dice "ya no está disponible".
- Congela precio, dólar blue y coeficientes al crear: no recalcula con el dólar de hoy.
- Cuotas (en el navegador, con los coeficientes congelados): saldo = precio − canje − efectivo (mínimo 0); lista en pesos = saldo × cotización × lista_factor; cada cuota = lista × coeficiente del plan / cantidad de cuotas; contado en pesos = saldo × cotización × contado_factor.
- Vigencia: "Válido hasta <fecha>". El "48 hs" del bot hoy no existe en el CRM: tendría que pedirse como vencimiento de 2 días.

## 3. Qué soporta
- Canje con varios equipos, efectivo (con concepto), servicios ya hechos, cantidad, nombre del cliente, notas.
- Datos del cliente: solo el nombre, visible para cualquiera que tenga el link. No hay teléfono ni contacto en la tabla. Las `notas` también se muestran en la página pública.

## 4. Propuesta de endpoint (sin implementar)
- POST /api/presupuesto-bot con clave propia (BOT_PRESUPUESTO_KEY), distinta de la del catálogo. Solo crea.
- Escritura: hoy el servidor no tiene clave de escritura de Supabase (decisión de seguridad). Se propone una función de base SECURITY DEFINER que exija un secreto compartido (hash guardado), como ya hace Mercado Libre.
- El bot manda solo referencias: unidad (id de stock), canje[] (modelo, almacenamiento, batería, valor estimado en USD), contacto, canal, clave de idempotencia. El CRM calcula precio, cotización, coeficientes y vencimiento con su lógica.
- Validaciones: la unidad existe, está disponible, tiene precio y es un equipo; el canje: modelo y capacidad existentes en `catalogo_modelos_publico`, batería de 1 a 100, valor > 0 y bajo un tope (comparable con el último precio vendido de ese modelo, vista del script 8); límite por minuto y tope diario contado en la base; idempotencia con columna única (un reintento devuelve el mismo link).
- Respuesta: { token, link, vence_en }. Errores con la forma de /api/catalogo: { error } con 401, 405, 429 o 502. Sin respuestas parciales.
- En el CRM: columnas nuevas `origen` (crm/bot), `canal`, `contacto`; etiqueta "Bot" en la lista.
- Catálogo: agregar `id` por unidad (la vista stock_publico ya lo tiene).

## 5. Cambios, riesgos y orden
Riesgo previo a todo: `presupuesto_por_token` devuelve la fila entera (menos el id). Si se agrega un teléfono de contacto, saldría en el link público. Primero hay que limitar la función a una lista permitida de campos.
Otros riesgos: el bot puede crear una oferta de precio con un canje inflado (de ahí el tope); datos personales de contacto (guardar lo mínimo, con plazo de borrado); límite de 12 funciones de Vercel al tope (colgar el endpoint de una función existente por reescritura); spam (tope diario).
Orden: 1) restringir la función pública; 2) migración (columnas, índice de idempotencia, función de creación con secreto); 3) endpoint; 4) id en el catálogo; 5) etiqueta y contacto en la lista del CRM. Cada parte es de complejidad baja, salvo la función con sus validaciones (media). Plan revisado por Codex antes de construir.
