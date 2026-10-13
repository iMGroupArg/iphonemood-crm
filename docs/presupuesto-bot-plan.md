# Presupuestos creados por el bot — plan de construcción (lado del CRM / base / servidor)

Fecha: 2026-10-12. Pedido: Angel (bot) vía Moderador; **Franco aprobó avanzar** ("presupuestos creados por el bot").
Base: `docs/analisis-presupuesto-bot.md`. Esto es el PLAN; revisado por Codex **antes** de construir (salvo el paso 1, ya hecho y probado).
**Sin escribir en la base ni desplegar**: cada SQL lo corre Franco; cada deploy necesita su "desplegá".

## 0. Requisitos de Franco (los que mandan)
1. El bot le pasa al cliente presupuestos **del mismo tipo** que los creados en la web/CRM: mismo link `precios.html?presupuesto=<token>`, **mismo formato de datos**, misma página.
2. En el CRM se ven en **la misma lista**, con etiqueta **"Bot"**.
3. Seguridad: lo que el bot guarda y no es público (contacto, canal, origen…) **nunca** sale por el link.

## 1. Paso 1 — restringir la función pública (urgente, HECHO y probado) → script 11
`presupuesto_por_token(token)` hoy devuelve `to_jsonb(p) - 'id'`: **toda la fila**. Si se agrega un teléfono, saldría en el link.
* `db/para-correr/11_presupuesto_por_token_lista.sql`: devuelve una **lista permitida** de 8 campos de nivel superior — `cliente, producto, trade_in, cotizacion, pagos_cfg, creado_en, vence_en, notas` — que es exactamente lo que leen `precios.js` (renderPresupuesto/abrirPresupuesto) y `api/compartir.js` (confirmado por la sesión de Precios). `token` e `id` no salen (la página toma el token de la URL).
* **También por dentro** (revisión de Codex): `producto` y `trade_in` son JSON y antes salían enteros; ahora salen filtrados por una lista permitida de claves, la que lee la página: `producto` = nombre, modelo, storage, color, categoria, estado_producto, cantidad, precio_usd, precio_unitario_usd, servicios (solo textos); `trade_in` = modelo, storage, color, estado, bateria_pct, valor_usd, equipos[] (esos 6 campos) y efectivo (monto_usd, concepto). Así, ni siquiera un dato guardado adentro por error (un costo, un IMEI, un contacto) puede salir. `pagos_cfg` sale entero: es copia de `configuracion.pagos_config`, que la landing ya lee pública.
* Misma forma que antes: las 8 claves siempre presentes (null si vacías); vencido/inexistente → NULL; mismos permisos; presupuestos de formato viejo (canje suelto, sin `equipos`, financiación vieja) siguen saliendo bien.
* Refuerzo: se le quitan a `anon` los permisos de tabla sobre `presupuestos` (ya estaba cerrada por seguridad de filas; la landing solo usa la función).
* Tabla de verificación ✅/❌ al final (6 controles). Prueba: `tests/sql/presupuesto_token.test.mjs` (20): muestra el riesgo ANTES (el teléfono sale), y DESPUÉS que sale lo mismo de siempre, sin ninguna columna interna ni las futuras, **ni secretos anidados** en producto/canje/equipos/efectivo (ni objetos o listas metidos adentro de una clave permitida: solo pasan valores simples), con formatos viejos y con formas raras.
* No requiere cambiar código: se puede correr hoy, antes que todo lo demás.

## 2. Paso 2 — columnas y función de creación → script 12 (a escribir, tras la revisión)
### 2.1 Columnas nuevas en `presupuestos` (todas con valor por defecto: el CRM actual sigue funcionando sin tocarlo)
| Columna | Para qué |
|---|---|
| `origen text NOT NULL DEFAULT 'crm' CHECK (origen IN ('crm','bot'))` | la etiqueta "Bot" de la lista |
| `canal text CHECK (canal IN ('whatsapp','instagram','mercadolibre','web','otro'))` | por dónde llegó la consulta |
| `contacto text CHECK (contacto ~ '^\+?[0-9]{8,15}$')` | **solo el teléfono**, normalizado (sin espacios ni signos) |
| `contacto_borrar_en timestamptz` | cuándo se borra el contacto (creado + 180 días) |
| `idempotencia text` + índice único parcial `WHERE idempotencia IS NOT NULL` | un reintento devuelve el MISMO link |
| `payload_hash text` | huella de lo pedido, para detectar una clave de idempotencia reusada con otro pedido |
No se agrega "creado por": `origen` + `canal` alcanzan.

### 2.2 Tablas internas (cerradas: RLS sin políticas, sin permisos para anon/authenticated)
* `presupuesto_bot_config(clave, valor)`: `rpc_secret_sha256`, `dias_validez` (=2, el "48 hs" del bot), `tope_diario` (=40), `tope_por_minuto` (=5), `canje_tope_pct` (=100), `canje_max_equipos` (=3), `contacto_retencion_dias` (=180). Se cambian con SQL, sin desplegar.
* `presupuesto_bot_uso(dia date PRIMARY KEY, n int)`: contador diario (día de Argentina).

### 2.3 `presupuesto_bot_crear(p_secreto, p_unidad uuid, p_cantidad int, p_canje jsonb, p_cliente text, p_contacto text, p_canal text, p_idem text)` → `{ ok, token, vence_en, reutilizado }`
`SECURITY DEFINER`, `search_path` fijo, `REVOKE … FROM PUBLIC` y `GRANT` a `anon, authenticated` (el secreto la protege, como las de Mercado Libre). Errores con códigos estables (`RAISE EXCEPTION 'CODIGO'`).
**El bot manda solo referencias.** Precio, dólar, cuotas y vencimiento los pone el CRM, con su propia lógica:
* **Unidad:** existe en `stock`, `estado_inventario = 'disponible'`, categoría de equipo (`iphone, android, mac, ipad`), `precio_ars > 0`, `cotizacion > 0`, **no a pedido**, y con unidades ≥ la cantidad pedida (`GREATEST(array_length(imeis), cantidad)`). Si no: `UNIDAD_NO_DISPONIBLE`. Cantidad 1–5.
* **Producto (foto congelada, igual que el CRM):** `{nombre, modelo, storage, color, categoria, estado_producto, cantidad, precio_unitario_usd = ROUND(precio_ars/cotizacion), precio_usd = unitario × cantidad, servicios: []}`. `precio_usd` es el TOTAL (regla de la página).
* **`cotizacion`** = `configuracion.ref_blue` (> 0 y finito, si no `SIN_COTIZACION`); **`pagos_cfg`** = `configuracion.pagos_config`: la **misma fuente** que usa el CRM al guardar. Se **valida su estructura**, no solo que sea JSON: objeto; `contado_factor` y `lista_factor` (si vienen) números finitos > 0; con bloque `promo` u `otros` (formato nuevo) cuyas `cuotas` sean una lista; **la misma regla que usa la página** (`cuotasDe`): una cuota es publicable si `mostrar !== false` y `coef` es un número > 0; toda cuota publicable debe tener `n` ∈ {3, 6, 9, 12}; y tiene que haber **al menos una cuota publicable válida** (listas vacías o todas ocultas se rechazan). Si no cumple: `SIN_FINANCIACION_VALIDA` (el bot deriva a una persona; no crea un presupuesto sin cuotas). Un `{"promo": true}` no pasa. Además **`precio_unitario_usd` redondeado ≥ 1** (un `precio_ars` positivo puede dar 0 USD).
* **Canje (0 a 3 equipos):** cada uno `{modelo, storage, estado, bateria_pct, valor_usd}` (**sin `color`**: era texto libre público; sale vacío) con: `modelo` y `storage` existentes en `catalogo_modelos_publico` (modelo igual; storage dentro de `capacidades`); `estado` ∈ la lista del CRM (`Nuevo / Sellado, Excelente, Muy bueno, Bueno, Con detalles`); batería entera 1–100; `valor_usd` entero > 0; **tope:** `valor_usd ≤ último precio vendido × canje_tope_pct / 100` (con `canje_tope_pct = 100` es el 100 %) (vista `canje_ultimo_precio_publico`, ventas de equipo usado de los últimos 60 días). **Sin referencia de precio** (nadie vendió ese modelo/capacidad en 60 días) → `CANJE_SIN_REFERENCIA`: el bot deriva a una persona (no se inventa un tope). Y el **total del canje tiene que ser MENOR que el precio** del equipo (si no, el saldo sería cero y el cliente se llevaría el equipo gratis): `CANJE_MAYOR_AL_PRECIO`. Salida con la misma forma que el CRM: `{equipos:[…], modelo, storage, color, estado, bateria_pct (del primero), valor_usd (SUMA)}`; sin canje: `trade_in = NULL`.
* **Forma del pedido validada en la propia función** (no solo en el endpoint, que podría saltearse llamando a la base): tipos, largos máximos, claves permitidas (una clave desconocida → `CUERPO_INVALIDO`), tratamiento de `NULL`, canje como lista de objetos.
* **Cliente:** nombre opcional, hasta 60 caracteres, solo letras/espacios/guiones/apóstrofes (se muestra en la página pública). **`notas` queda en NULL** (la página las muestra públicas: el bot no puede escribir texto libre ahí).
* **Contacto y canal:** teléfono normalizado y validado; canal de la lista. Se guardan en columnas de nivel superior, **nunca** adentro de los JSON.
* **Vencimiento:** `now() + dias_validez` (2 días), fijado por el CRM; el bot no lo pide.
* **Token:** 32 caracteres hexadecimales generados en la base (`gen_random_uuid()` sin guiones, 122 bits).
* **Idempotencia** (clave opaca obligatoria `^[A-Za-z0-9_-]{8,64}$`; se **rechaza una clave con 8 o más dígitos seguidos**, para que nunca contenga un teléfono: el contrato pide un identificador aleatorio, no uno derivado del contacto):
  * Se busca **primero**, justo después de validar el secreto y **antes** de revalidar stock, precios o topes: así un reintento no falla porque la unidad se vendió o cambió la configuración.
  * La **huella** (`payload_hash`, SHA-256) es del pedido **normalizado**: unidad, cantidad (con su valor por defecto aplicado), canje ordenado y con claves en orden, nombre y contacto normalizados, canal. No incluye precios derivados.
  * Existe con la misma huella y vigente → devuelve **el mismo link** (`reutilizado: true`), sin gastar cupo. Misma clave y otra huella → `IDEMPOTENCIA_CONFLICTO` (409). Existe pero **vencido** → `IDEMPOTENCIA_VENCIDA` (409): el bot usa una clave nueva.
  * Carrera de dos pedidos iguales a la vez: índice único + se atrapa **esa** restricción (no cualquier otra) y se compara la huella del ganador; contador y alta en el mismo sub-bloque, así el perdedor no consume cupo.
* **Topes en la base, sin carreras:** la creación toma un **candado de la transacción** (`pg_advisory_xact_lock`) que serializa «contar + insertar» — sin él, varios pedidos con claves distintas verían el mismo conteo por minuto y todos insertarían. Dentro: `tope_por_minuto` (presupuestos del bot del último minuto) y `tope_diario` (contador atómico `INSERT … ON CONFLICT DO UPDATE … WHERE n < tope`); si se pasa: `DEMASIADOS_PEDIDOS` / `TOPE_DIARIO`. Los pedidos que fallan por validación no gastan cupo. Se prueba con Postgres real y **claves distintas** a la vez.
* **Limpieza de contactos vencidos, efectiva aunque nadie use el bot:** índice parcial sobre `contacto_borrar_en` (`WHERE contacto IS NOT NULL`) y borrado **por lotes de 500**. Se dispara desde tres lugares: al crear un presupuesto, al abrir la lista del CRM (`presupuestos_limpiar_contactos()`, que **exige usuario autorizado del CRM** y se concede solo a `authenticated`) y **en el cron diario** que ya existe (el `GET` del worker llama a una variante con secreto): así el plazo de 180 días se cumple aunque nadie abra el CRM ni escriba el bot.

### 2.4 Secreto y endurecimiento de las funciones
`presupuesto_bot_secreto_ok(p)`: SHA-256 del secreto guardado en `presupuesto_bot_config` (mismo patrón que `meli_secreto_ok`; sin secreto cargado, cerrado). Garantías concretas: la comprobación es `IF presupuesto_bot_secreto_ok(p) IS NOT TRUE THEN RAISE …` (un NULL no pasa); el ayudante **no es ejecutable** por `PUBLIC`, `anon` ni `authenticated` (solo lo llaman las funciones, que corren con permisos de su dueño); todos los objetos van **calificados** (`public.`, `extensions.`) con `search_path` fijo en esquemas donde esos roles no pueden escribir; las tablas internas cerradas (RLS sin políticas y sin permisos). Los secretos son **aleatorios de alta entropía** (`openssl rand -base64 32`); **rotación**: se cambia el hash en `presupuesto_bot_config` y el valor en Vercel y se redespliega (para `BOT_PRESUPUESTO_KEY`, solo Vercel + avisarle a Angel). **Dos claves distintas, a propósito:**
* `BOT_PRESUPUESTO_KEY` (la que tiene el bot): solo abre el endpoint. Distinta de `BOT_CATALOGO_KEY`.
* `PRESUPUESTO_RPC_SECRET` (solo en Vercel): lo que el endpoint le manda a la base. Si la del bot se filtra, no sirve para llamar a la función de la base directamente.
Franco genera ambos valores y los carga en Vercel; en el chat solo viaja el hash del segundo.

## 3. Paso 3 — endpoint (sin función nueva de Vercel)
`POST /api/presupuesto-bot`, colgado de `api/catalogo.js` por una reescritura en `vercel.json` (`/api/presupuesto-bot` → `/api/catalogo?_f=presupuesto`), la misma técnica que ya usa `/api/meli/publicaciones`. **12 de 12 funciones: sigue en 12.** La lógica va en un módulo `api/_presupuesto_bot.js`.
* El despacho por `_f` va **antes** del guard de solo-GET de `catalogo.js` (con prueba), así que no cambia el comportamiento del catálogo.
* Solo POST (405 con `Allow`), clave `x-bot-presupuesto-key` o `Authorization: Bearer` contra `BOT_PRESUPUESTO_KEY` (comparación en tiempo constante, como `_auth.js`). 401 sin clave. Límite por minuto por instancia (best effort; el real es el de la base).
* Cuerpo JSON ≤ 4 KB: `{ unidad, cantidad?, canje[]?, cliente?, contacto?, canal, idempotencia }`. Se validan formato y tipos **antes** de llamar a la base; campos desconocidos se rechazan (400).
* Respuesta 200: `{ token, link, vence_en, reutilizado }`, con `link = https://iphonemood.com/precios.html?presupuesto=<token>`. Errores `{ error: "CODIGO" }` con 400/401/404/405/409/422/429/502; nunca mensajes de la base ni de Supabase.
* **No se registran** teléfono ni nombre en los logs.
* Sin respuestas parciales: o se creó o no.

## 4. Pasos 4 y 5
* **Catálogo del bot:** agregar `id` (el de `stock_publico`, uuid de la unidad) a cada producto de `/api/catalogo`. Cambio de una línea; el bot lo usa como `unidad`.
* **CRM (lista de Presupuestos):** etiqueta **"Bot"** (y el canal) en cada fila con `origen = 'bot'`; el contacto se muestra solo en el CRM, nunca en el link; al abrir la lista se llama a `presupuestos_limpiar_contactos()`. El formulario actual no cambia (inserta con los valores por defecto: `origen = 'crm'`).

**Link y vista previa de WhatsApp:** el bot y el CRM comparten el mismo link (`/precios.html?presupuesto=<token>`, el que arma `copiarLink`). Las reescrituras de `vercel.json` para la vista previa dinámica (`api/compartir.js`) interceptan `/` y `/precios` con `?presupuesto`, no `/precios.html`: es un punto **ya existente** que afecta igual a los presupuestos del CRM. Se le pide a la sesión de Precios que verifique la vista previa con el link exacto; si falla, la corrección es una reescritura más para `/precios.html` (o pasar CRM y bot a `/precios?presupuesto=`), válida para los dos.

## 5. Retención del contacto (misma política que los datos de envío)
Solo teléfono, 180 días desde la creación; se borra el contacto (queda el presupuesto). La clave de idempotencia es opaca y **no puede contener un teléfono**, así que no lo conserva después de la limpieza. Motivo: minimización de datos de terceros; pasado el plazo en que el cliente puede retomar la compra, el teléfono solo suma riesgo. Plazo configurable en `presupuesto_bot_config`. Acceso: igual que el resto del CRM (todo usuario activo ve lo mismo).

## 6. Riesgos y cómo se cubren
| Riesgo | Cobertura |
|---|---|
| Teléfono o canal visibles en el link | Paso 1 (lista permitida) + columnas fuera de los JSON + test que lo prueba |
| El bot infla el canje para regalar un descuento | Tope vs último precio vendido, sin referencia → rechaza, total del canje ≤ precio, máx. 3 equipos |
| El bot pone un precio | No puede: solo manda la unidad; el precio sale del stock y el dólar de `configuracion` |
| Spam / abuso de la clave | Tope por minuto y diario en la base, idempotencia, clave aparte de la del catálogo, rotable |
| Clave del bot filtrada | No abre la base directamente (segundo secreto); solo puede crear con los topes |
| Reintentos del bot duplican presupuestos | Clave de idempotencia con índice único; no gasta cupo |
| Dos pedidos iguales simultáneos | Índice único + sub-bloque; probado con Postgres real (varias conexiones) |
| Texto libre público (`cliente`, `notas`) | Nombre filtrado, `notas` nunca desde el bot |
| Presupuesto de una unidad que se vende después | Igual que los del CRM: es una oferta con vencimiento (2 días), no una reserva |
| Límite de 12 funciones de Vercel | Endpoint colgado de `api/catalogo.js` |

## 7. Pruebas (todas antes de entregar)
* pglite sobre el esquema real (migración de presupuestos + scripts 6 y 8 para canje): validaciones una por una, forma idéntica a la que guarda el CRM (comparada campo a campo contra un presupuesto armado como lo hace `guardar()`), vencimiento, idempotencia, topes, limpieza de contactos, permisos (anon no escribe ni lee la tabla; secreto equivocado), y que `presupuesto_por_token` de un presupuesto del bot devuelve **solo** los 8 campos.
* Postgres real con varias conexiones: dos pedidos con la **misma** clave a la vez (un solo presupuesto, el segundo recibe el mismo link, el tope no se gasta dos veces); muchos pedidos con claves **distintas** a la vez (el tope por minuto y el diario **nunca se pasan**); reintento después de que la unidad se vendió (devuelve el mismo link); reintento de un presupuesto vencido (`IDEMPOTENCIA_VENCIDA`).
* Página y vista previa: un presupuesto del bot, leído por la función pública, trae todo lo que exigen `renderPresupuesto` y `api/compartir.js` (nombre, `precio_usd` total > 0, cotización > 0, cuotas); se compara contra uno armado como lo hace `guardar()`.
* Servidor: endpoint con la base real (pglite) y la clave: método, claves, validación de cuerpo, errores sin filtraciones, el 12 de funciones.
* Revisión de Codex del código antes de entregar.

## 8. Orden y esfuerzo
| Paso | Qué | Esfuerzo | Quién corre |
|---|---|---|---|
| 1 | Script 11: lista permitida (**hecho**) | S | Franco, SQL Editor (puede correr hoy) |
| 2 | Script 12: columnas, tablas internas, funciones (validaciones, idempotencia, topes, limpieza) | **M–L** | Franco, SQL Editor |
| 3 | Endpoint + clave + reescritura | S–M | deploy con "desplegá" + 2 variables en Vercel |
| 4 | `id` en el catálogo del bot | S | mismo deploy |
| 5 | Etiqueta "Bot" + contacto en la lista del CRM + limpieza (lista y cron) | S | mismo deploy |
Cada parte con tests y Codex. El paso 1 es independiente y urgente; los demás van juntos.

## 9. Contrato propuesto para Angel (a confirmar)
`POST https://iphonemood.com/api/presupuesto-bot` con `x-bot-presupuesto-key: <clave>` y cuerpo:
```json
{ "unidad": "<id del catálogo>", "cantidad": 1,
  "canje": [{ "modelo": "iPhone 12", "storage": "128GB", "estado": "Muy bueno", "bateria_pct": 88, "valor_usd": 250 }],
  "cliente": "Juan", "contacto": "+5491155550123", "canal": "whatsapp", "idempotencia": "b3f1c2d4-7a90-4e1b-9c55-0d2f8a6e1c34" }
```
Respuesta `200 { "token": "…", "link": "https://iphonemood.com/precios.html?presupuesto=…", "vence_en": "…", "reutilizado": false }`.
Errores (`{ "error": "CODIGO" }`): 400 `CUERPO_INVALIDO` · 401 · 404 `UNIDAD_NO_DISPONIBLE` · 409 `IDEMPOTENCIA_CONFLICTO` / `IDEMPOTENCIA_VENCIDA` · 422 `CANJE_*` (`MODELO_INEXISTENTE`, `CAPACIDAD_INEXISTENTE`, `ESTADO_INVALIDO`, `BATERIA_INVALIDA`, `VALOR_INVALIDO`, `SOBRE_EL_TOPE`, `SIN_REFERENCIA`, `MAYOR_AL_PRECIO`) o `SIN_FINANCIACION_VALIDA` / `SIN_COTIZACION` (el bot deriva a una persona) · 429 `TOPE_DIARIO` / `DEMASIADOS_PEDIDOS` · 502.
`idempotencia` es un identificador aleatorio (por ejemplo un UUID) que el bot reutiliza **solo** para reintentar el mismo pedido; **no** debe derivarse del teléfono. El bot **no** manda precio, cotización, cuotas, vencimiento ni color. `storage` y `modelo` con el vocabulario del catálogo (`catalogo_modelos_publico`).

## 10. Decisiones que necesito de Franco / Angel
1. **Tope del canje:** ¿100 % del último precio vendido (propuesta) o menos (por ejemplo 85 %)? Es un seguro, no el precio: el bot sigue ofreciendo lo que estime.
2. **Sin referencia de precio** (nadie vendió ese modelo en 60 días): ¿rechazar y derivar a una persona (propuesta) o permitir hasta un tope fijo en USD?
3. **Topes:** 40 presupuestos por día y 5 por minuto (propuesta).
4. **Productos a pedido:** el bot **no** los presupuesta (propuesta). ¿Está bien?
5. **Contacto:** solo teléfono, 180 días. ¿Alguna otra cosa que Angel necesite guardar (por ejemplo, el nombre completo)?
6. **Cantidad:** el bot presupuesta de 1 a 5 unidades (propuesta).
