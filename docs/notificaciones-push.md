# Avisos push al celular (equipo y clientes)

Pedido de Franco (2026-11-20): que el CRM y la página de seguimiento se puedan **instalar como app sin tienda** y que quien acepte reciba avisos que mandamos nosotros.
Primeros avisos: **venta nueva** (al equipo) y **reparación lista** (al cliente de esa reparación).

## Cómo funciona
- **App sin tienda:** es una PWA. El CRM (`/login`) y la página de seguimiento tienen manifiesto + `sw.js`; se instalan con «Agregar a pantalla de inicio» (iPhone) o «Instalar» (Chrome).
- **Aviso:** la base (script 33) deja un renglón en `push_cola` cuando entra una venta (con 30 s de margen para que el CRM cargue los renglones) o una reparación pasa a «listo».
  El reloj de Supabase llama cada minuto a `/api/meli/worker?modo=push` **sólo si hay algo por enviar**; el worker pide los avisos pendientes a la base (que ya trae texto y destinatarios), los cifra (Web Push, RFC 8291/8292, sin librerías) y los manda al servicio de push de cada navegador. Después anota el resultado.
- **Sin funciones nuevas de Vercel** (seguimos en 12): el envío vive en `api/_push.js`, detrás del worker; la clave pública sale por `/api/push/clave` (reescritura a `conectar.js?_f=push`).
- **Equipo:** menú del usuario → «Avisos en este dispositivo» → Activar. Hay botón de **aviso de prueba**.
- **Cliente:** en su link de seguimiento aparece «Avisame cuando esté lista» mientras la reparación está en curso. Al entregarse la reparación se borran sus suscripciones.

## Qué dice la plataforma (verificado en la web el 2026-11-20)
- **iPhone/iPad:** iOS 16.4+ y **sólo con la app instalada** en la pantalla de inicio; el permiso se pide con un toque; si dice «No permitir», iOS no vuelve a preguntar (hay que ir a Ajustes).
- **Android/Chrome:** funciona instalada o no, sin tienda.
- **Argentina:** la restricción de Apple a las apps web aplica a la Unión Europea, no a nosotros.

## Puesta en marcha (paso manual de Franco, en este orden)
1. **Claves** (una sola vez, en tu compu): `node db/scripts/generar_vapid.mjs` → cargar `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT` en Vercel (Production). La privada no va a ningún archivo ni al chat.
2. **Base:** correr `db/para-correr/33_notificaciones_push.sql` en el SQL Editor de Supabase (requiere el script 3). Las 5 verificaciones tienen que dar ✅ (si el proyecto no tiene `pg_cron`/`pg_net`, la del reloj da ❌ y hay que activarlos en Database → Extensions y volver a correr). Después, volver a correr el script 26 (control 26.9: los agentes no heredan permisos de funciones nuevas).
3. **Clave del reloj:** es la misma «disparador_secret» del script 24 (bóveda). Si el reloj de facturación ya anda, no hay que hacer nada.
4. **Desplegar** (PR → OK de Franco → `main`).
5. **Probar en un teléfono:** instalar el CRM, menú del usuario → Avisos en este dispositivo → Activar → «Enviarme un aviso de prueba» (llega en menos de un minuto; funciona aunque el interruptor general esté apagado).
6. **Encender:** `UPDATE public.push_config SET valor = 'true' WHERE clave = 'activo';` (nace APAGADO: apagado no se encola ni se envía nada, así no hay una avalancha de avisos viejos al encenderlo).

## Seguridad y privacidad
- Las tablas de avisos están cerradas al navegador; todo pasa por funciones con permisos mínimos. El servidor usa el mismo secreto que `meli_*`.
- El servidor sólo le habla a servicios de push conocidos (https; FCM, Mozilla, Apple, Windows): nadie puede usarlo para pegarle a una red interna.
- Al cliente se le guardan sólo las claves del navegador y la reparación a la que quedó atado; se borran al entregar. Los avisos son **sólo** de transacciones propias (reparación lista): nada de promociones. Para promociones haría falta un permiso aparte y baja fácil.
- Un teléfono del equipo no se puede atar a una reparación de cliente (ni al revés).

## Pruebas
`tests/webpush.test.mjs` (cifrado contra el ejemplo oficial del RFC), `tests/push_servidor.test.mjs`, `tests/sw_push_cliente.test.mjs`, `tests/sql/push.sql.test.mjs` (pglite) y `tests/worker_disparador.test.mjs`.
**No se pudo probar con un teléfono real ni con el servicio de push de verdad** (el navegador de pruebas no permite service workers): el paso 5 de arriba es la prueba de punta a punta.

## Pendiente / mejoras
- Re-suscripción automática si el navegador cambia la suscripción (`pushsubscriptionchange`).
- Más avisos: orden de Mercado Libre para procesar, liberación de plata, pago recibido. Cada uno es un tipo nuevo en `push_cola` + su texto en `push_tomar_pendientes`.
- Avisos a clientes sobre cambios de estado intermedios (hoy sólo «lista»).
