# Mercado Libre — chequeo corto (después del primer refresco del token, y cuando haga falta)

El token de acceso de Mercado Libre dura **6 horas**; después se renueva solo con un permiso de **un solo uso**.
Si esa renovación falla, la cuenta queda como "Hay que reconectar" y **no entra ninguna venta** hasta reconectarla.
Este chequeo tarda 2 minutos. Hacerlo **al día siguiente de conectar** y después de cada deploy.

## 1. Lo que mira Franco en la pantalla (CRM → Mercado Libre)

| Qué mirar | Bien | Mal → qué hacer |
|---|---|---|
| Tarjeta de la cuenta | **Conectada** (verde) y su caja (`Franco · ARS Mercado Pago`) | **"Hay que reconectar"** (rojo) → botón **Conectar Mercado Libre** y volver a autorizar. Avisar a Deploy-infra *antes*: hay que saber por qué falló el renovado |
| Texto rojo bajo el nombre de la cuenta (`ultimo_error`) | No hay | Copiar el texto exacto y pasarlo |
| Avisos de ventas | Pendientes **0**, fallidos **0** (o bajando) | **Fallidos > 0** → anotar cuántos y el motivo que muestra la lista; no reintentar a ciegas |
| "Procesar pendientes" | Corre sin error | Un aviso rojo o "No se pudo procesar" → pasar el texto |
| Órdenes → pestaña **En revisión** | Vacía, o sólo con el motivo esperado | Cualquier motivo que no se entienda → pasarlo (no procesar esa orden) |
| Vincular publicaciones | Los avisos que se venden figuran **Vinculado → producto** | "Sin vincular" en algo que se vende → vincularlo antes de que entre la venta |

## 2. Lo que verifica Deploy-infra (sin acceso a `meli_*`, sólo con la clave pública)

Todo de **sólo lectura**. No se escribe nada.

1. **Las tablas siguen cerradas:** `meli_cuentas`, `meli_config`, `meli_ordenes`, `meli_publicaciones`, `meli_vinculos_historial`… devuelven `[]` con la clave pública (con una cuenta conectada, ese 0 sí prueba el cierre).
2. **Los tokens no se exponen:** pedir `access_token` a la vista `meli_cuentas_estado` da error de columna inexistente.
3. **El webhook sigue exigiendo el secreto:** sin `?k=` → 401, con uno malo → 401, con el correcto → 200 "ignorado".
4. **El sitio y los endpoints responden:** `/` y `/login` 200; `/api/meli/worker` y `/api/catalogo` 401.
5. **El código publicado es el esperado:** `meli.js` con `DB.personasMap`; `precios.js` según lo que Franco haya aprobado publicar.
6. **Vercel:** `vercel ls --prod` — el último deployment es el esperado y está *Ready*; `vercel env ls production` — siguen `MELI_*`, `CRON_SECRET`, `MELI_WEBHOOK_PATH_SECRET`.

## 3. Lo que NO se puede ver desde afuera (y cómo se cubre)

- **Si el refresco del token funcionó:** sólo se ve en la tarjeta de la cuenta (punto 1). Es el chequeo más importante.
- **Los avisos que llegaron al webhook:** sólo se ven en "Avisos de ventas" de la pantalla.
- **Lo que hay en `meli_ordenes`:** sólo lo ve Franco logueado, en la pestaña de órdenes. Para que Deploy-infra ayude con una orden concreta, Franco pega lo que muestra la pantalla (bruto, neto, liberación, motivo).

## 4. Si aparece "Hay que reconectar"

1. **No reconectar de inmediato** sin avisar: un refresco "ambiguo" puede significar que Mercado Libre rotó el permiso y no llegó a guardarse; reconectar lo arregla, pero hay que dejar anotada la hora para entender la causa.
2. Reconectar (Conectar Mercado Libre). Se conserva la caja asignada.
3. Pasar a Deploy-infra: hora aproximada, el texto de `ultimo_error` y si había un deploy reciente.
