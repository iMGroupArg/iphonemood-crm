<!-- Plan de implementación de la integración Mercado Libre → CRM.
     Revisado con Codex en 5 rondas (ronda 1 a 4: REVISE; ronda 5: APPROVED),
     el 2026-10-02. El esquema SQL que acompaña a este plan está en
     db/pendientes/meli_esquema_base.sql.

     Lo que Codex encontró y acá quedó corregido, por si sirve de registro:
       · REVOKE de anon/authenticated no cerraba nada (el permiso venía de PUBLIC)
       · Vercel Cron hace GET, el worker era sólo POST
       · los avisos de pago de MELI llegan como /collections/{id}, no /v1/payments/{id}
       · /v1/payments vive en api.mercadopago.com, no en api.mercadolibre.com
       · en Hobby el cron es diario, un worker por minuto no existía como opción
       · UPDATE ... ORDER BY ... LIMIT ... FOR UPDATE SKIP LOCKED no es SQL válido
-->

# Plan v5 (completo y autocontenido): Mercado Libre → CRM

Documento completo, no un diff: la v3 omitía requisitos ya acordados en v2 y no
era implementable sola.

Stack: Node CommonJS en Vercel **Hobby** (verificado), serverless sin estado,
varias instancias en paralelo, fetch nativo, sin dependencias nuevas.
Supabase/Postgres. **Sin service-role key**: el servidor entra por RPC
SECURITY DEFINER que validan `MELI_RPC_SECRET` (hash SHA-256 en `meli_config`).

Hechos verificados de MELI: access_token 6 h; refresh_token de un solo uso que
rota y del que sólo vale el último; refresh_token 6 meses; scope `offline_access`
obligatorio para recibirlo.

---

## 0. YA APLICADO EN EL SQL (verificado en el archivo, no planeado)

- `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` en todas las internas.
  Revocar sólo de anon/authenticated no hacía nada: el permiso venía de PUBLIC.
- Índice único `cajas(persona_id, bolsillo)` **precedido de un bloque DO que
  aborta con la lista de duplicados si los hay**, sin borrar nada.
- Creación de la fila de caja con `ON CONFLICT DO NOTHING` (hoy dentro de
  `meli_cuenta_asignar_caja`; la función `meli_asegurar_caja` que había acá se eliminó).
- `meli_orden_items_set`: `SELECT ... FOR UPDATE`.
- `meli__descontar_core` y `meli_reponer_stock`: `PERFORM 1 FROM meli_ordenes
  WHERE id=$1 FOR UPDATE` como **primera sentencia**, antes de leer ítems.

## 1. Límites de ejecución — medidos, no supuestos

**Tu punto 1.** Verificado: `vercel.json` no define `functions`, así que rige el
default del plan. El presupuesto de 25 s de v3 no tenía fundamento.

- Se declara `maxDuration` explícito en `vercel.json` para `api/meli/worker`.
- El presupuesto del worker es **el mínimo entre el 80 % del `maxDuration`
  efectivo y (duración del lease − margen)**. Sólo el porcentaje no alcanzaba:
  podía superar los 2 minutos del lease y hacer que otro worker reclamara el
  mismo trabajo mientras el primero seguía. Arranca en lote de **2**.
- Del presupuesto se **reserva un tramo final** para persistir resultados y
  devolver leases. Las consultas externas no pueden consumirlo todo: si se
  acaba el tramo de consultas, lo que queda se devuelve sin penalizar.
- Cada llamada externa recibe como timeout **el mínimo entre su propio límite y
  el tiempo que queda del presupuesto**, para que varios timeouts individuales
  no sumen más que el total.
- La pantalla dice **"procesamiento diario, sujeto a pendientes y reintentos"**,
  no promete una latencia que el plan no garantiza.
- El botón manual **llama repetidamente mientras queden pendientes elegibles**,
  con un guard que impide invocaciones superpuestas.

## 2. Leases de ingesta en tabla propia — sin órdenes fantasma

**Tu punto 2.** Crear la fila de orden vacía para tomar el lease generaba una
orden procesable sin ítems, y dejaba basura si MELI devolvía 404 o el vendedor
no coincidía.

- Tabla nueva `meli_ingesta_leases(cuenta_id, meli_order_id, lease_id,
  lease_hasta)`, PK `(cuenta_id, meli_order_id)`. RLS cerrada.
- `meli_lease_tomar(secreto, cuenta_id, meli_order_id)`:
  `INSERT ... ON CONFLICT (cuenta_id, meli_order_id) DO UPDATE SET
  lease_id=gen_random_uuid(), lease_hasta=now()+'2 min'
  WHERE meli_ingesta_leases.lease_hasta < now() RETURNING lease_id`.
  Devuelve vacío si otra instancia lo tiene: el aviso queda pendiente.
  **`meli_ordenes` no se toca hasta que haya datos reales.**
- `meli_lease_soltar(secreto, cuenta_id, meli_order_id, lease_id)` tras una
  ingesta exitosa o un descarte.
- El UPSERT de orden **verifica `cuenta_id`**: una instancia de otra cuenta no
  puede reclamar ni pisar una orden existente.

## 3. Lista blanca de recursos — corregida

**Tu punto 3.** Error real: MELI manda los avisos de pago como
`resource: "/collections/{id}"`, y mi regex sólo aceptaba `/v1/payments/{id}`.
Habría rechazado todas las notificaciones de pago reales.

| tópico | `resource` aceptado | qué se consulta |
|---|---|---|
| `orders_v2` | `^/orders/(\d+)$` | `GET api.mercadolibre.com/orders/{id}` |
| `payments` | `^/collections/(\d+)$` **y** `^/v1/payments/(\d+)$` | `GET api.mercadopago.com/v1/payments/{id}` |
| `shipments` | `^/shipments/(\d+)$` | `GET api.mercadolibre.com/shipments/{id}` |

- **La ruta del aviso no determina el host.** Se extrae sólo el id numérico y la
  URL la arma el servidor desde una tabla fija tópico → host + ruta.
- Se rechaza URL absoluta, `//host`, `..`, parámetros extra, tópico desconocido.
- `fetch` con `redirect: 'error'`.
- Tras consultar: se verifica que `order.seller.id` coincida con el
  `meli_user_id` de la cuenta y que el pago pertenezca a esa orden. Si no, se
  descarta y se registra el intento.
- Antes de salir a producción se prueba con el payload documentado de cada tópico.

## 4. Reglas financieras — nada inferido

**Tu punto 4.** "Comparar contra `transaction_amount_refunded`" no es
determinista: intervienen comisiones, envío y reversos.

- **Hasta verificar con respuestas reales** (pago aprobado, devolución parcial,
  devolución total, contracargo) **no se aplica ninguna resta inferida**: se
  conservan los importes originales y la orden se marca `revisar`. El cálculo
  definitivo se documenta recién con esas respuestas en la mano.
- Suman los pagos `status='approved'`. Un aprobado pendiente de liberación
  suma al neto; lo que define disponibilidad es `money_release_date`.
- Si **algún** pago aprobado no tiene `money_release_date`, `fecha_liberacion`
  queda `NULL` y la orden marca "liberación incompleta".
- **Si falla CUALQUIER consulta necesaria**, `financiera_completa = false`,
  aunque se conserven los importes anteriores. Esa actualización **respeta el
  lease**, para que un worker atrasado no invalide un resultado nuevo.
- Flag `financiera_ok` en la RPC distingue "no se pudo consultar" (no se tocan
  los campos) de "respuesta válida cuyo valor es NULL" (se escribe el NULL).
- Mientras `financiera_completa = false`, la acreditación está bloqueada en la
  UI **y** en la RPC.
- **Verificación con credenciales reales antes de terminar:** que el token de la
  cuenta conectada pueda leer esos campos en Mercado Pago.

## 5. Refresco de tokens

**Tu punto 5.** La generación no identificaba una persistencia exitosa.

- `meli_tokens_tomar` devuelve `access_token`, `refresh_token`,
  `token_expira_en`, `activa`, `requiere_reconexion`, `refresh_ambiguo` y, si
  corresponde, `lease_id`. No entrega permiso si la cuenta está inactiva,
  requiere reconexión o quedó en estado ambiguo.
- `meli_tokens_guardar(secreto, cuenta_id, lease_id, ...)` escribe sólo si el
  lease coincide, **persiste `ultimo_refresh_guardado_id = lease_id`** en la
  MISMA actualización, y **devuelve si aplicó**.
- Ante respuesta perdida, se compara `ultimo_refresh_guardado_id` con el lease
  usado: eso sí distingue "ya se guardó" de "nunca se guardó". La `generacion`
  queda sólo para invalidar operaciones anteriores.
- **Las escrituras de error también validan lease y generación.**
  `meli_marcar_reconexion` y la que setea `refresh_ambiguo` escriben sólo si el
  `lease_id` sigue siendo el vigente **y** la `generacion` no cambió. Sin eso,
  un refresh viejo que falla tarde podía bloquear una cuenta que ya se había
  reconectado bien.
- `refresh_ambiguo` (timeout o error de red en el intercambio) **bloquea todo
  refresco automático** aunque venza el lease. Sale sólo por reconexión, que
  además limpia la bandera e invalida el lease vigente.
- **Caso irreducible, explícito:** si la instancia muere DESPUÉS de recibir los
  tokens y ANTES de persistirlos, no puede escribir ni siquiera la bandera de
  ambigüedad. Mitigación: la persistencia del resultado ya recibido se reintenta
  de forma acotada (3 veces, inmediato) antes de soltar; si aun así se pierde,
  la recuperación es la reconexión manual. No hay forma de evitarlo del todo y
  el plan no finge que la haya.
- Timeouts en **todas** las llamadas externas, incluidas las de Supabase.

## 6. Cola, worker y devolución de leases

**Tu punto 6.**

- Reclamo con CTE (el `UPDATE ... ORDER BY ... LIMIT ... FOR UPDATE SKIP LOCKED`
  de v2 no es SQL válido):

```sql
WITH candidatos AS (
  SELECT id FROM meli_notificaciones
   WHERE procesada_en IS NULL
     AND (lease_hasta IS NULL OR lease_hasta < now())
     AND proximo_intento <= now()
   ORDER BY recibida_en LIMIT p_limite
   FOR UPDATE SKIP LOCKED)
UPDATE meli_notificaciones n
   SET lease_id = gen_random_uuid(), lease_hasta = now() + interval '2 minutes',
       intentos = n.intentos + 1
  FROM candidatos c WHERE n.id = c.id
RETURNING n.id, n.lease_id, n.meli_user_id, n.topico, n.recurso;
```

- `proximo_intento TIMESTAMPTZ NOT NULL DEFAULT now()`.
- **`meli_notificacion_devolver(secreto, ids[], lease_ids[])`**: libera leases
  de trabajos **no iniciados** cuando se agota el presupuesto, sin contarlos
  como fallo y sin aplicarles backoff. "Se devuelven sin tocar" de v3 era
  ambiguo: ya habían sido modificados al reclamarlos.
- **"Orden persistida" no es "trabajo completado".** La notificación se marca
  `procesada_en` sólo cuando la ingesta aplicó **y** el enriquecimiento
  financiero quedó completo. Si la orden se guardó parcial porque falló una
  consulta de pago, el aviso **queda pendiente con backoff** y se reintenta: si
  no, una orden podía quedarse con `financiera_completa=false` para siempre
  esperando un aviso que nunca iba a llegar.
- **Resultado terminal para descartes legítimos.** Vendedor ajeno, tópico
  desconocido, recurso inexistente (404 definitivo) y orden de otra cuenta se
  marcan `descartada` con motivo, y **no se reintentan nunca más**. Sin esto, un
  aviso que nunca va a poder procesarse se reintentaría eternamente.
- Tope de intentos: pasado el límite, el aviso pasa a `fallida` y aparece en la
  pantalla para que alguien lo mire, en vez de seguir girando.
- Tras ingesta exitosa se suelta el lease de orden.
- **Sin coalescencia**: se reclama un conjunto fijo de IDs y se completan sólo
  esos. Reprocesar es inofensivo (la ingesta es idempotente); perder un aviso no.
- Backoff exponencial sobre `proximo_intento`. Pantalla con pendientes,
  fallidas, intentos y último error.

## 7. Ingesta transaccional

- `meli_ingresar_orden(secreto, cuenta_id, lease_id, orden, items)`: una sola
  transacción que **primero bloquea la fila de `meli_ingesta_leases` con
  `FOR UPDATE`**, verifica identidad del lease y que no esté vencido, y
  **mantiene ese bloqueo hasta el final de la transacción**. Verificar sin
  bloquear dejaba una ventana para que otro worker reclamara el lease entre la
  validación y la escritura. Después hace UPSERT de la orden (verificando
  `cuenta_id`) y reemplaza ítems.
- Versiones separadas: `meli_last_updated` (orden), `pagos_version`,
  `envio_version`. Cada bloque se descarta sólo ante una versión más vieja que
  la guardada para ese bloque. Timestamps iguales no se rechazan.
- No reemplaza ítems si la orden ya está procesada o con stock descontado:
  registra la discrepancia en `motivo_revisar`.
- Ítems con `cantidad <= 0` se guardan con `stock_id = NULL` y marcan `revisar`,
  conservando el payload crudo.
- `meli_orden_registrar` y `meli_orden_items_set` quedan internas, llamadas sólo
  desde acá.

## 8. OAuth

- **`POST /api/meli/conectar`**, por `fetch` autenticado desde el CRM (token de
  Supabase + `usuarios_autorizados`, igual que `api/bandeja.js`). Genera nonce
  opaco, lo guarda con `meli_state_crear`, pone cookie
  `HttpOnly; Secure; SameSite=Lax; Path=/api/meli; Max-Age=600`, responde
  `{ authorization_url }` con `Cache-Control: no-store`. **El cliente navega.**
  El JWT nunca va por query; el navegador nunca ve `MELI_RPC_SECRET`.
- **`GET /api/meli/callback`**: compara `state` con la cookie, lo consume con
  `meli_state_consumir` (`DELETE ... WHERE nonce=$1 AND vence_en > now()
  RETURNING usuario_email`), **re-verifica que ese usuario siga autorizado**,
  borra la cookie, maneja `?error=access_denied`. `redirect_uri` fija e idéntica
  byte a byte en autorización e intercambio. Redirige a ruta fija con
  `?meli=ok|error`.
- `meli_cuenta_conectar(...)` devuelve `cuenta_id`, conserva `persona_id` y
  `bolsillo` en reconexión, limpia `ultimo_error`, `requiere_reconexion` y
  `refresh_ambiguo`, e incrementa `generacion`.
- La asignación de caja es un paso aparte, `meli_cuenta_asignar_caja`, gateado
  con `is_authorized_user()`. Hasta entonces la cuenta figura "pendiente de
  asignar caja" y la acreditación no se habilita. Esa misma función crea la fila de
  `cajas` con `INSERT … ON CONFLICT` si falta; no hay una función aparte para eso
  (`meli_asegurar_caja` existió en una versión anterior y se ELIMINÓ por no usarse).

## 9. Webhook

- **`POST /api/meli/webhook?k=<MELI_WEBHOOK_PATH_SECRET>`** — secreto de path
  propio y rotable, como defensa adicional, no como sustituto.
- Valida tópico contra la lista blanca, tamaño máximo del cuerpo y estructura.
- Resuelve la cuenta con `meli_cuenta_por_user_id(secreto, user_id)`, **sólo si
  `activa`**. Si no es una cuenta nuestra, se descarta sin tocar nada.
- **No llama a MELI**: sólo encola. Devuelve **200 si la notificación se
  persistió; 5xx si la escritura falló**, para que MELI reenvíe. Objetivo por
  debajo de 500 ms.
- Rate limit con `api/_ratelimit.js`, que es **por instancia, best effort** — su
  propio archivo lo documenta. No es una garantía y el plan no lo presenta como
  tal. No se pone un límite bajo por IP: MELI manda ráfagas legítimas.
  **Encolar difiere el abuso hacia el worker, no lo elimina**; por eso el worker
  también está protegido y acotado por presupuesto.

## 10. Worker

**Vercel Cron hace GET, no POST.** Con un worker sólo-POST, el drenaje diario
habría recibido 405 y no habría corrido nunca. Dos métodos, un solo cuerpo:

- **`POST /api/meli/worker`** — sesión autorizada del CRM (el drenaje del
  navegador y el botón manual).
- **`GET /api/meli/worker`** — acepta **exclusivamente**
  `Authorization: Bearer <CRON_SECRET>`. Es el que usa el cron diario.
- Los dos delegan en la misma función de procesamiento. Se prueba la invocación
  del cron, no se asume.
- Tres drenajes, porque en Hobby el cron es diario: el CRM abierto llamándolo
  cada 60 s, el botón manual (que repite mientras haya pendientes, sin
  superponerse), y el cron diario como piso.

## 11. Pantalla del CRM

- `meli_cuentas_estado` (sin tokens, filtrada por `is_authorized_user()`):
  conectada, token vigente, requiere reconexión, refresh ambiguo, caja asignada.
- Botón "Conectar" → `POST /api/meli/conectar`. Botón "Asignar caja".
- Cola: pendientes, fallidas, intentos, último error, botón "Procesar
  pendientes".
- Texto explícito: **cubre desde la fecha de conexión en adelante**;
  procesamiento diario sujeto a pendientes y reintentos.

## 12. Puesta en marcha

Configurar tópicos (`orders_v2`, `payments`, `shipments`) y URL del webhook en
la app de MELI. Probar recepción con una orden real. Verificar con credenciales
reales el acceso a Mercado Pago.

**Fuera de alcance, anotado como pendiente visible:** sincronización del
histórico y reconciliación periódica de avisos nunca recibidos.

## Pruebas antes de dar por terminado

Refresh concurrente; reconexión durante un refresh; muerte tras rotar el token;
timeout ambiguo (debe bloquear, no reintentar); respuesta de guardado perdida
(debe distinguirse por `ultimo_refresh_guardado_id`); webhook duplicado; worker
interrumpido con lease vencido; presupuesto agotado con leases devueltos sin
penalizar; dos pagos donde sólo uno tiene fecha de liberación; devolución
parcial; actualización financiera sin cambio de `order.last_updated`; intento de
reemplazar ítems de una orden procesada; OAuth cruzado entre navegadores;
`resource` malicioso y `resource` de pago en formato `/collections/{id}`;
y verificación por REST de que `anon` no puede ejecutar ninguna función interna.


---

# Implementación — desvíos del plan v5 y hallazgos de la revisión de código

Escrito el 2026-10-02, al implementar. El plan de arriba fue aprobado por Codex; lo que sigue
es lo que cambió o se descubrió DESPUÉS, y por qué.

## Desvíos respecto del plan v5 (decididos al escribir el código)

1. **La conciliación de comisiones NO marca `revisar`.** El plan decía marcar `revisar` si
   `bruto − neto` no cuadra con las comisiones declaradas. No se hizo: `revisar` también frena
   `meli__descontar_core`, y casi toda orden con envío de Mercado Libre tiene un costo de envío
   que no figura en `fee_details`, así que se frenaría el stock por una cuestión de comisiones que
   no tiene relación. La diferencia queda en la columna visible `meli_ordenes.diferencia_comision`
   (y en `payload_pago.conciliacion`). Codex lo revisó y lo consideró razonable, pidiendo una señal
   visible, que es esa columna.
2. **El scope `offline_access` no se manda en la URL de autorización.** Se supone configurado en
   la aplicación de Mercado Libre (no se pudo leer la documentación para confirmarlo). En su lugar,
   el callback exige que la respuesta traiga `refresh_token` y, si no lo trae, NO guarda la cuenta
   (que moriría a las 6 horas) y avisa que falta habilitar `offline_access` en la app.
3. **El secreto del path del webhook (`MELI_WEBHOOK_PATH_SECRET`) sólo se exige si está cargado.**
   Se generó pero NO se cargó en Vercel: hay que registrar primero la URL con `?k=...` en la app
   de Mercado Libre; si se exigiera antes, todos los avisos reales darían 401.
4. **El drenaje principal es el CRM abierto** (`src/modules/meli.js`, una vez por minuto), no un
   cron, porque en el plan Hobby el cron es sólo diario.

## Lo que encontró la revisión de código de Codex (5 rondas) y quedó corregido

- `Number(null)` es 0: un importe ausente se leía como cero y como dato completo.
- Una escritura de Mercado Libre vieja podía pisar una nueva: faltaban versiones por bloque
  (orden / pagos / envío), y una versión entrante DESCONOCIDA se aceptaba siempre.
- Los ítems se reemplazaban aunque llegara una orden vieja; la comparación de órdenes cerradas
  contaba filas (y `EXCEPT` descarta duplicados: hace falta `EXCEPT ALL`).
- Un refresh abandonado a mitad del intercambio podía reintentarse: ahora se marca "iniciado"
  ANTES de llamar a Mercado Libre y la base lo declara ambiguo si el lease vence sin concluir.
- Reconectar no limpiaba esa marca y dejaba la cuenta recién conectada declarada ambigua.
- Un `SIN_TIEMPO` anterior al envío se confundía con un timeout ambiguo y bloqueaba la cuenta.
- La reserva de tiempo para cerrar no era una reserva real; el reloj arrancaba después de autenticar.
- Un tópico `constructor` / `__proto__` / `toString` hacía explotar `parseAviso`; y `String()`
  sobre un JSON como `{"toString":null}` lanza una excepción, ambas con entrada que manda cualquiera.
- Un envío puede corresponder a varias órdenes (carrito): se resuelve la lista.
- La pantalla mostraba "Conectada" una cuenta bloqueada por refresh ambiguo.

## ⚠ Pendiente crítico que NO es de este módulo

Las ventas del local escriben la cantidad de stock como valor ABSOLUTO desde la copia en memoria del
navegador (`ventas.js` → `DB.actualizarCantidadStock` → `update({ cantidad })`). Si Mercado Libre
descontó mientras tanto, esa escritura lo borra: dos ventas, una unidad descontada. Ninguna RPC de
este esquema puede cerrarlo; hace falta que el cliente descuente por DELTA en la base. Es de
Stock/Ventas. Un comentario anterior de `meli_esquema_base.sql` afirmaba lo contrario y era falso;
está corregido.

## Lo que NO está verificado

- **El SQL sólo se ejecutó en pglite (Postgres en WebAssembly, UNA conexión).** Lo cargan los bancos
  de Ventas+Cueva (`tests/sql/meli.sql.test.mjs`, 48 checks) y de Stock (`tests/sql/stock.sql.test.mjs`).
  Nunca contra Supabase ni con dos sesiones simultáneas: los bloqueos, los leases y el orden de
  locks siguen verificados sólo por lectura (Codex). Corre en una transacción (todo o nada) para que
  un error no deje el esquema a medias.
- **Los nombres de campo de las respuestas de Mercado Libre y Mercado Pago** salen de lo que se
  conoce de las APIs, no de respuestas reales (la documentación devolvió 403). Falla del lado
  seguro (NULL, nunca 0), pero hay que contrastar con la primera orden real.

## Reglas financieras (2026-10-03, a pedido de Ventas+Cueva y tras revisión de Codex)

- **Cobertura.** Una orden está "cobrada" sólo si la suma de `transaction_amount` de sus pagos
  aprobados es **mayor o igual** al bruto. Comparación **estricta**, sin tolerancia (una versión
  tuvo 1 peso de tolerancia y declaraba completa una orden a la que le faltaba cobrar un peso).
  Sin cobertura **no hay comisión** (bruto − neto mediría lo que falta cobrar) y la orden no queda
  `financiera_completa`. Caso que lo motivó: bruto 1000, un pago aprobado de 600 (neto 500) y otro
  de 400 pendiente → antes daba "comisión 500", que no existe.
- **La base deriva, no confía.** `comision_envio` y `diferencia_comision` se calculan en SQL sobre
  la fila FINAL a partir de `bruto`, `neto`, `cobrado_aprobado` y `comision_declarada`. Antes la
  cobertura se verificaba en JavaScript contra el bruto que traía la última respuesta, pero el SQL
  puede conservar el bruto viejo si esa parte llegó desactualizada: un pago de 600 contra una orden
  que en la base valía 1000 quedaba "completa".
- **Invariante.** `financiera_completa` ⇒ bruto, neto, fecha de liberación y comisión no nulos.
- **Importes que cambian** en una orden ya procesada o acreditada → `revisar`, con el cambio en el
  motivo. Sólo si el valor viejo era CONOCIDO (que `neto` pase de NULL a un número no bloquea la
  acreditación), y el neto sólo cuenta como cambio si el viejo era CONFIRMADO (completo o ya
  acreditado): uno provisional —un pago aprobado de dos— que se completa es una evolución normal.
- **Moneda distinta de ARS** → `revisar`.
- **Motivos acumulativos.** `meli_agregar_motivo` conserva los anteriores: antes un motivo menor
  podía esconder una cancelación posterior.
- **No verificado con una orden real:** si `total_amount` incluye algo que el comprador no paga
  (un descuento financiado por Mercado Libre), el cobrado queda por debajo del bruto y la orden se
  ve incompleta sin serlo. Falla del lado seguro; `payload_pago.conciliacion.cobrado_aprobado` y la
  columna `cobrado_aprobado` sirven para calibrar con la primera orden real.
