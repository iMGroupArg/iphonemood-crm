# Contrato v2 — el bot crea presupuestos en el CRM

Para Angel (bot de WhatsApp). Versión 2 (13/10/2026), con las 8 correcciones que pidió y las decisiones de Franco.
**Estado:** construido y probado en local; falta que Franco corra el SQL (script 13) y diga "desplegá". Hasta entonces el endpoint no existe.

## 1. Cómo se usa
`POST https://iphonemood.com/api/presupuesto-bot` con la clave en el header `x-bot-presupuesto-key: <clave>` (o `Authorization: Bearer <clave>`). Cuerpo JSON de hasta 4 KB:

```json
{
  "unidad": "<id del producto, tal cual viene en /api/catalogo>",
  "cantidad": 1,
  "canje": [
    { "modelo": "iPhone 12", "storage": "128GB", "estado": "Muy bueno", "bateria_pct": 88, "valor_usd": 250 }
  ],
  "cliente": "Juan",
  "contacto_tipo": "telefono",
  "contacto_valor": "+5491155550123",
  "canal": "whatsapp",
  "idempotencia": "b3f1c2d4-7a90-4e1b-9c55-0d2f8a6e1c34"
}
```
* **Obligatorios:** `unidad`, `canal`, `idempotencia`. El resto es opcional.
* **El bot NO manda precio, cotización, cuotas, vencimiento ni color.** Todo eso lo pone el CRM (un campo que no está en la lista da `400`).
* `unidad`: el `id` que ahora trae cada producto de `/api/catalogo`.
* `cantidad`: 1 a 5 (por defecto 1).
* `canal`: `whatsapp`, `instagram`, `mercadolibre`, `web` u `otro`.
* `cliente`: nombre opcional (solo letras, espacios, apóstrofe, punto y guion; hasta 60). **Aparece en la página pública del presupuesto.**
* **Contacto (nuevo):** `contacto_tipo` = `telefono` o `instagram`, con `contacto_valor`. Van juntos o ninguno de los dos.
  * `telefono`: formato **internacional E.164**, con `+` y de 8 a 15 dígitos (`+5491155550123`). Se aceptan espacios, guiones, puntos y paréntesis, que se quitan.
  * `instagram`: `@usuario` o el id numérico (letras, números, punto y guion bajo, hasta 30). Se guarda sin `@` y en minúscula.
  * **Nunca** sale en la página ni en la vista previa. Se borra solo a los **180 días**.
* **Canje** (hasta 3 equipos): `modelo`, `storage`, `bateria_pct` (1 a 100) y `valor_usd` son obligatorios; **`estado` es opcional** (si viene: `Nuevo / Sellado`, `Excelente`, `Muy bueno`, `Bueno` o `Con detalles`).
  * `valor_usd` lo manda el bot (su planilla). El CRM lo acota: **entero entre 50 y 2.500 USD por equipo**, **no más del 100 % del último precio al que se vendió ese modelo y capacidad usados** (ventas de los últimos 60 días), y **el total del canje tiene que ser menor que el precio del equipo**.
  * `modelo`, `storage` y `estado` se comparan **sin distinguir mayúsculas, tildes ni espacios** ("128 GB" = "128GB") y se guardan con el nombre oficial. El vocabulario exacto viene en **`canje_modelos`** de `/api/catalogo`: `[{ "modelo": "iPhone 15", "capacidades": ["128GB", "256GB"] }, …]`.
* `idempotencia`: un identificador **aleatorio** (por ejemplo un UUID) que el bot reutiliza **solo** para reintentar el mismo pedido. **No** debe derivarse del teléfono (se rechaza una clave con 8 o más dígitos seguidos). Se guarda como hash.

## 2. Respuesta
`200`:
```json
{ "token": "…32 hex…", "link": "https://iphonemood.com/precios.html?presupuesto=<token>", "vence_en": "2026-10-15T12:00:00.000Z", "reutilizado": false, "modo": "real" }
```
* El `link` es **el mismo tipo de link** que arma el CRM; la página, el formato de los datos y la vista previa de WhatsApp son los mismos.
* `vence_en`: lo fija el CRM: **2 días** (el "48 hs" del bot). Se lo muestra al cliente tal cual.
* `reutilizado: true`: era un reintento del mismo pedido; devuelve **el mismo link** sin crear otro ni gastar cupo (aunque entretanto la unidad se haya vendido).

## 3. Errores — qué hacer con cada uno
Formato: `{ "error": "CODIGO", "detalle"?: {…} }`. Nada de texto interno.

| Estado | Códigos | Qué significa | Qué hace el bot |
|---|---|---|---|
| **401** | `NO_AUTORIZADO` | Clave mala o ausente | **Error de configuración: alertar a una persona.** No caer a texto en silencio. |
| **500** | `NO_CONFIGURADO`, `CONFIGURACION_INVALIDA` | Falta algo del lado del servidor | Alertar al equipo. Mientras tanto, texto como hoy. |
| **400** | `CUERPO_INVALIDO` | El pedido tiene mal la forma (campo de más, tipo, formato, rango) | **Definitivo.** Es un bug del bot: arreglar. Mientras tanto, texto como hoy. |
| **404** | `UNIDAD_VENDIDA`, `UNIDAD_NO_DISPONIBLE` (reservada u otro estado), `UNIDAD_INEXISTENTE` | La unidad ya no se puede presupuestar | **Definitivo.** Refrescar el catálogo y ofrecer otra; si no, texto. |
| **409** | `IDEMPOTENCIA_CONFLICTO` (misma clave, otro pedido), `IDEMPOTENCIA_VENCIDA` | | **Definitivo.** Usar una clave NUEVA para un pedido distinto o para uno vencido. |
| **422** | `CANJE_MODELO_INEXISTENTE`, `CANJE_CAPACIDAD_INEXISTENTE`, `CANJE_ESTADO_INVALIDO`, `CANJE_BATERIA_INVALIDA`, `CANJE_VALOR_INVALIDO`, `CANJE_VALOR_FUERA_DE_RANGO`, `CANJE_SIN_REFERENCIA`, `CANJE_SOBRE_EL_TOPE`, `CANJE_MAYOR_AL_PRECIO` | El canje no se puede presupuestar así | **Definitivo.** Si trae `detalle` (`recibido`, `validos`, `modelo`, `minimo`, `maximo`), usarlo para corregir. Si no hay corrección posible: **mandar el presupuesto en texto como hoy** (decisión de Franco). |
| **429** | `TOPE_DIARIO`, `DEMASIADOS_PEDIDOS` | Se pasó el cupo (60 por día / 5 por minuto) | **Reintentable** con el header `Retry-After` (segundos). Mientras espera, texto como hoy. |
| **502** | `ERROR_INTERNO`, `SIN_COTIZACION`, `SIN_FINANCIACION_VALIDA` | Falla del servidor o datos del CRM sin completar | **Reintentable** (pocas veces, con espera). Si sigue, texto como hoy. |

Regla simple: **422 y 404 no se reintentan** (el mismo pedido dará lo mismo); **429 y 502 sí** (con espera); **401 es una alerta**, nunca un "mandar en texto" silencioso.

## 4. Clave de PRUEBA
`BOT_PRESUPUESTO_KEY_TEST`: una clave aparte para que Angel pruebe **sin crear presupuestos reales**:
* Los presupuestos de prueba salen con `"modo": "prueba"`, **duran 30 minutos**, **no guardan el contacto ni el nombre**, **no cuentan en el cupo de los reales** (tienen su propio tope de 100 por día) y se **borran solos a las 24 horas**.
* El CRM **no los muestra** en la lista de presupuestos.
* Usan la unidad, el precio y las cuotas reales, y el link abre la misma página.

## 5. Rotación de la clave (la hace Franco en Vercel)
Durante el cambio valen **dos claves a la vez**: así no se corta el bot.
1. Franco genera una clave nueva (`openssl rand -base64 32`) y la carga en Vercel como **`BOT_PRESUPUESTO_KEY_NEXT`** (Production). Se redespliega (o se "Redeploy" desde Vercel). Ahora valen la vieja y la nueva.
2. Se le pasa la clave nueva a Angel y él la pone en el bot (Railway). Se verifica que el bot ande con la nueva.
3. Franco copia el valor de la nueva a **`BOT_PRESUPUESTO_KEY`** y **borra `BOT_PRESUPUESTO_KEY_NEXT`**. Se redespliega. La vieja deja de valer.
4. Si algo sale mal entre el 1 y el 3, basta con borrar `BOT_PRESUPUESTO_KEY_NEXT`: la vieja sigue funcionando.
`PRESUPUESTO_RPC_SECRET` (la que el servidor le manda a la base) es otra cosa y no la toca el bot; si se rota hay que cambiar su hash en la base (script 13) y el valor en Vercel a la vez.

## 6. Qué ve el cliente y qué no
* La página pública muestra: producto, canje, saldo, cuotas, vigencia y —si el bot lo mandó— el nombre. **Nunca** el contacto, el canal ni el origen (lo garantiza el script 11).
* Cualquier presupuesto con canje (del CRM o del bot) ahora aclara en la página: "Es un valor estimado: se confirma, o se ajusta, cuando nuestro equipo revisa tu equipo en persona".
* El link `…/precios.html?presupuesto=<token>` sale con `X-Robots-Tag: noindex`, no figura en el sitemap y el token es aleatorio de 122 bits.
* **Promo Macro:** la página muestra la promo **congelada** en el presupuesto hasta `vence_en`. La configuración de la promo hoy solo tiene un texto de vigencia (no una fecha), así que el CRM **no** puede cortar las cuotas Macro antes de `vence_en`. Si Franco quiere eso, hay que agregar una fecha de fin a la promo en el panel.

## 7. Topes y valores (se cambian con un UPDATE, sin desplegar)
60 presupuestos por día · 5 por minuto · vencimiento 2 días · cantidad 1 a 5 · canje: 3 equipos, 50–2.500 USD, ≤ 100 % del último precio vendido · contacto 180 días · pruebas: 30 minutos, 100 por día, 24 h de retención.
