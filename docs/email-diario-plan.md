# Email diario (F4 de Actividades)

Plan breve (Ventas+Cueva, 2026-10-15). Para revisión de Codex antes de construir. Nada se publica sin pedido de Franco.

## Qué es
Un email por día, a la hora del cron que ya existe (09:00 UTC = 06:00 Argentina), solo si hay algo que avisar:
«Hoy se liberan $X en N órdenes · liberadas sin confirmar $Y (M) · tenés K transferencias pendientes por $Z». Sirve para enterarse sin abrir el CRM.

## Decisiones
* **Sin función nueva en Vercel** (seguimos en 12/12): el código vive en `api/_aviso_diario.js` (módulo, no endpoint) y lo llama el cron actual `api/meli/worker.js` (rama GET con `CRON_SECRET`), **antes** del barrido, con su propio plazo de 5 s, dentro de `try/catch`: un fallo del email jamás frena el barrido ni el drenaje.
* **Proveedor: Resend** (plan gratis: 100 mails/día, 3.000/mes). Franco crea la cuenta y carga `RESEND_API_KEY` y `AVISO_EMAIL_DESTINO` (y opcional `AVISO_EMAIL_DESDE`) en las variables de entorno de Vercel **él mismo**: yo nunca veo ni pido claves. Sin esas variables el aviso no hace nada (y lo dice en el log, sin error).
* **Remitente por defecto** `onboarding@resend.dev` (el sandbox de Resend solo entrega a la dirección de la cuenta de Franco: suficiente para un destinatario). Un dominio propio verificado es opcional y se cambia con `AVISO_EMAIL_DESDE`.
* **Datos que viajan:** SOLO importes y cantidades agregadas. Nada de compradores, usuarios de Mercado Libre, productos, números de orden ni de venta.
* **Los agregados los calcula la base** con funciones `SECURITY DEFINER` que validan el secreto compartido existente (`MELI_RPC_SECRET`, mismo patrón que el resto): el servidor no lee tablas ni usa service-role.
* **Un envío por día, aunque el cron se repita:** la base «reclama» el día (`aviso_diario_envios`, clave primaria por día): solo quien reclama envía; si el envío falla se marca `fallido` (se puede reintentar, el cron del día siguiente no lo recupera: es un aviso, no un registro); un reclamo colgado de más de 10 min se puede retomar. Además se manda `Idempotency-Key` a Resend (`iphonemood-aviso-<día>`) para que un reintento no duplique el mail.
* **No manda nada si no hay nada que decir** (todo en cero): sin spam.
* **Día = día de Argentina** (UTC−3).

## Script 17 (SQL, lo corre Franco; sin tocar nada existente)
* Tabla `aviso_diario_envios (dia date PK, estado reclamado|enviado|fallido, reclamado_en, enviado_en, intentos, error)`; sin acceso para `anon`/`authenticated`.
* `aviso_diario_resumen(p_secreto, p_dia)` → jsonb con: `liberan_hoy {ordenes, monto}` (procesadas, sin acreditar, sin revertir, no cerradas a mano, sin `revisar`, financiera completa, neto > 0, liberación = día), `sin_confirmar {ordenes, monto}` (mismo filtro, día anterior), `transferencias {cantidad, monto, mas_vieja}` (actividades `meli_transferir` pendientes), `sin_procesar {ordenes}` (no procesadas con liberación hoy o antes, sin revisar ni cerradas).
* `aviso_diario_reclamar(p_secreto, p_dia)` → boolean; `aviso_diario_confirmar(p_secreto, p_dia)`; `aviso_diario_fallo(p_secreto, p_dia, p_motivo)` (motivo acotado a un código corto, sin texto libre).
* Todas con `meli_secreto_ok`, `search_path` fijo, REVOKE de PUBLIC/anon/authenticated y EXECUTE solo para `anon` (el servidor usa la clave pública + el secreto, como las demás funciones del barrido).

## Módulo `api/_aviso_diario.js`
`enviarAvisoDiario({ ahora, pres, fetchImpl })` → `{ enviado, motivo }`:
1. Sin `RESEND_API_KEY` o `AVISO_EMAIL_DESTINO` válidos → `SIN_CONFIG` (no hace nada).
2. Pide el resumen a la base; si todo es cero → `NADA_QUE_AVISAR` (sin reclamar).
3. Reclama el día; si no lo logra → `YA_ENVIADO`.
4. Arma asunto y cuerpo (texto plano + HTML mínimo, todo escapado, solo números) y hace `POST https://api.resend.com/emails` con timeout acotado por el plazo, `redirect: 'error'` y la `Idempotency-Key`.
5. 2xx → confirma. 4xx/5xx/timeout/excepción → marca el fallo con un código corto (`HTTP_<estado>`, `TIMEOUT`, `RED`); nunca guarda el cuerpo de la respuesta.
Un error en cualquier paso devuelve `{ enviado:false, motivo }` y NUNCA tira hacia el cron.

## Prueba de envío (opcional, para configurar)
Acción `POST { accion: 'aviso_prueba' }` en el mismo worker, con la sesión del CRM: manda un mail marcado «[PRUEBA]» con los datos de hoy SIN reclamar el día. Botón «Enviar email de prueba» en la pantalla de Actividades. Límite: una prueba cada 2 min por instancia.

## Guía para Franco (cuando lleguemos)
1. Crear cuenta gratis en resend.com con su email. 2. Crear una API key («Sending access»). 3. En Vercel → Settings → Environment Variables: `RESEND_API_KEY` y `AVISO_EMAIL_DESTINO` (su email, el mismo de la cuenta). 4. Correr el script 17. 5. Redeploy (cuando él lo pida). 6. Apretar «Enviar email de prueba».

## Riesgos
1. Plazo de 30 s del cron: el aviso va PRIMERO con 5 s propios y el resto queda para barrido y drenaje.
2. El cron de Hobby no garantiza la hora exacta (dentro de la hora) ni reintenta.
3. Fuga de datos: solo agregados; se prueba que el cuerpo no contenga nada de órdenes/compradores.
4. Duplicados: reclamo en base + `Idempotency-Key`.
5. El sandbox de Resend solo entrega al dueño de la cuenta: se documenta en la guía.

## Pruebas
SQL (pglite): agregados correctos por día de Argentina y filtros, secreto inválido, reclamo exclusivo/reintento/reclamo colgado, fallo y confirmación, permisos (anon sin acceso a la tabla). Módulo (node + `fetch` simulado): sin config, nada que avisar, ya enviado, éxito (cuerpo sin datos personales, escapado, cabecera de idempotencia), 4xx/5xx/timeout/excepción marcan fallo y no tiran, redirección rechazada, plazo agotado. Worker: el aviso corre antes del barrido, no frena el drenaje aunque falle o tarde.

## Ajustes tras la revisión de Codex (REVISAR, 9 puntos; MANDAN sobre lo de arriba)
1. **Mensaje inmutable:** al reclamar, la base guarda una instantánea del mensaje (asunto, texto, HTML; solo números) y la clave de idempotencia; cada reintento usa EXACTAMENTE esa instantánea (Resend exige el mismo contenido con la misma clave y la conserva 24 h). Sin recalcular entre intentos. La clave incluye el día y el tipo.
2. **Reclamo con dueño:** `aviso_diario_reclamar` devuelve un `lease_id` (uuid) y confirmar/fallar lo exigen; actualizaciones condicionales; `enviado` es terminal. Estados: `reclamado` (con vencimiento de 10 min), `enviado`, `fallido` (rechazo definitivo: 4xx, config inválida) e `incierto` (timeout, 5xx, red o «Resend aceptó pero falló confirmar»). Solo un `incierto` se reintenta, con la MISMA instantánea y dentro de las 24 h de la clave. Se guarda el id de Resend cuando exista. Si no se puede guardar el fallo, el lease vence solo.
3. **Sin promesa de recuperación automática:** el cron corre una vez por día y Vercel no reintenta: un aviso fallido SE PIERDE (es un aviso, no un registro). Queda la acción manual «Enviar aviso ahora» (reintento del día, ver 4).
4. **Una sola acción manual, sin modo «prueba» aparte:** `POST {accion:'aviso'}` con sesión intenta el aviso REAL de hoy (idempotente: si ya se envió responde «ya enviado hoy» y no manda nada). Cuota en la base (por día y tipo): como máximo 3 intentos por día, con 2 min entre intentos, global (no depende de la instancia). Un tipo `prueba` separado del `diario` (para poder probar la configuración sin gastar el aviso del día): máx. 3 por día, mismo cuidado, y el asunto dice «[PRUEBA]». Destinatario solo de configuración. Excedida la cuota responde 429.
5. **Secreto:** se reutiliza `MELI_RPC_SECRET` (mismo patrón que el resto). Se documenta el alcance: quien lo tenga puede llamar todas las RPC con secreto (incluidas las de tokens de Mercado Libre); no agrega exposición nueva. Rotarlo es cambiar la variable en Vercel y el hash en `meli_config`. Un secreto separado se evalúa solo si Franco lo pide (obliga a configurar una variable más).
6. **Plazo:** el aviso corre DESPUÉS del drenaje (el tramo final de 6 s entre los 24 s del presupuesto y los 30 s de la función) con un deadline absoluto desde `t0` (a lo sumo `t0+28 s`) compartido por las RPC y Resend, con `AbortController`; si no quedan 3 s, `SIN_TIEMPO`. No toca el tiempo del barrido ni del drenaje.
7. **Contrato de datos:** el mensaje se arma desde una lista explícita de campos numéricos validados (finitos, rango razonable) y fechas; nada de texto de la base. Logs solo con día, etapa, código y estado HTTP (nunca payload, respuesta cruda, dirección, secreto ni la excepción completa). El asunto NO lleva importes («iPhoneMood: avisos de Mercado Libre de hoy»).
8. **Direcciones:** `AVISO_EMAIL_DESTINO` y `AVISO_EMAIL_DESDE` se validan como UNA sola dirección simple (≤ 254, sin espacios, controles, comas, punto y coma ni `<>`); el remitente se arma como «iPhoneMood <dirección>». `to: [destino]`. Un 403 de Resend = `CONFIG_INVALIDA` (rechazo definitivo, sin reintentos automáticos). Se documenta que el sandbox de Resend solo entrega a la cuenta dueña.
9. **Agregados y horario:** «sin confirmar» = liberación con día AR `< p_dia` (todas las atrasadas, no solo ayer). `sin_procesar` aparece en el mail («hay N órdenes sin procesar cuya plata ya se libera») y SÍ dispara el envío. Día y hora de Argentina calculados desde UN solo instante (UTC−3). El mail lleva «datos al <día hora AR>». Se describe como «aceptado por Resend», sin prometer bandeja. Ventana real del cron de Hobby: 06:00–06:59.

Pruebas adicionales exigidas: aceptación de Resend seguida de timeout; confirmación fallida; fallo imposible de guardar; reclamos concurrentes con un lease viejo; instantánea inmutable entre reintentos; cuota de intentos; cambio de día a las 03:00 UTC; permisos con roles reales.
