# Avisos push al celular (equipo y clientes)

Pedido de Franco (2026-11-20): que el CRM y la página de seguimiento se puedan **instalar como app sin tienda** y que quien acepte reciba avisos que mandamos nosotros.
Primeros avisos: **venta nueva** (al equipo) y **reparación lista** (al cliente de esa reparación).

## Cómo funciona
- **App sin tienda:** es una PWA. El CRM (`/login`) y la página de seguimiento tienen manifiesto + `sw.js`; se instalan con «Agregar a pantalla de inicio» (iPhone) o «Instalar» (Chrome).
- **Aviso:** la base (script 34) deja un renglón en `push_cola` cuando entra una venta (con 30 s de margen para que el CRM cargue los renglones) o una reparación pasa a «listo».
  El reloj de Supabase llama cada minuto a `/api/meli/worker?modo=push` **sólo si hay algo por enviar**; el worker pide los avisos pendientes a la base (que ya trae texto y destinatarios), los cifra (Web Push, RFC 8291/8292, sin librerías) y los manda al servicio de push de cada navegador. Después anota el resultado.
- **Sin funciones nuevas de Vercel** (seguimos en 12): el envío vive en `api/_push.js`, detrás del worker; la clave pública sale por `/api/push/clave` (reescritura a `conectar.js?_f=push`).
- **Equipo:** menú del usuario → «Avisos en este dispositivo» → Activar. Hay botón de **aviso de prueba**.
- **Cliente:** en su link de seguimiento aparece «Avisame cuando esté lista» mientras la reparación está en curso. Un mismo teléfono puede seguir varias reparaciones (una fila por reparación) y la pantalla pregunta al servidor si ESE teléfono ya está atado a ESA reparación. Al entregarse la reparación se borran sus suscripciones.
- **Envío sin repetidos:** cada toma de un aviso lleva un identificador de reclamo; sólo esa corrida puede informar el resultado, y lo que no alcanzó a enviarse por falta de tiempo vuelve a la cola sin gastar un reintento.

## Qué dice la plataforma (verificado en la web el 2026-11-20)
- **iPhone/iPad:** iOS 16.4+ y **sólo con la app instalada** en la pantalla de inicio; el permiso se pide con un toque; si dice «No permitir», iOS no vuelve a preguntar (hay que ir a Ajustes).
- **Android/Chrome:** funciona instalada o no, sin tienda.
- **Argentina:** la restricción de Apple a las apps web aplica a la Unión Europea, no a nosotros.

## Puesta en marcha (paso manual de Franco, en este orden)
1. **Claves** (una sola vez, en tu compu): `node db/scripts/generar_vapid.mjs` → cargar `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT` en Vercel (Production). La privada no va a ningún archivo ni al chat.
2. **Base:** correr `db/para-correr/34_notificaciones_push.sql` en el SQL Editor de Supabase (requiere el script 3). Las 5 verificaciones tienen que dar ✅ (si el proyecto no tiene `pg_cron`/`pg_net`, la del reloj da ❌ y hay que activarlos en Database → Extensions y volver a correr). Después, volver a correr el script 26 (control 26.9: los agentes no heredan permisos de funciones nuevas).
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
`tests/webpush.test.mjs` (cifrado contra el ejemplo oficial del RFC), `tests/push_servidor.test.mjs`, `tests/sw_push_cliente.test.mjs`, `tests/sql/push.sql.test.mjs` (pglite, 83), `tests/sql/push.concurrencia.test.mjs` (Postgres real con 12 conexiones: límite de 5 teléfonos, equipo-contra-cliente y reclamos) y `tests/worker_disparador.test.mjs`.
**No se pudo probar con un teléfono real ni con el servicio de push de verdad** (el navegador de pruebas no permite service workers): el paso 5 de arriba es la prueba de punta a punta.

## Pendiente / mejoras
- Re-suscripción automática si el navegador cambia la suscripción (`pushsubscriptionchange`).
- Más avisos: orden de Mercado Libre para procesar, liberación de plata, pago recibido. Cada uno es un tipo nuevo en `push_cola` + su texto en `push_tomar_pendientes`.
- Avisos a clientes sobre cambios de estado intermedios (hoy sólo «lista»).

## Avisos a clientes de la tienda («novedades y ofertas»)

- **Tienda como app:** `precios.html` enlaza `tienda.webmanifest` y carga `push.js` (con `data-registro="al-usar"`: el service worker no se registra al cargar, para no restarle velocidad a la tienda) y `avisos-web.js`.
- **Invitación amable (`avisos-web.js`):** no pide el permiso del navegador hasta que la persona toca «Sí, activar avisos». Aparece a los ~4 s (o al empezar a scrollear) con un botón grande de aceptar y una cruz chica, y nunca con un producto o el Plan canje abierto. Cerrarla la silencia 7 días (30 la segunda vez). En iPhone explica los 3 pasos de «Agregar a pantalla de inicio». Siempre se puede activar o dar de baja desde «🔔 Avisos de novedades» al pie.
- **Base (script 34):** suscripción anónima `tipo='visitante'`, inactiva hasta que llega el aviso de bienvenida (si falla, se borra). RPC `push_suscribir_visitante`, `push_estado_visitante`, `push_baja_visitante` (anon) y `push_difundir`, `push_difusiones_resumen` (sólo el CRM autenticado). Máximo 1 difusión cada 20 h (`push_config.difusion_horas_min`), título ≤60 y texto ≤140, enlaces sólo a este sitio.
- **CRM:** pantalla «Avisos a clientes» (`src/modules/avisos-clientes.js`): plantillas, vista previa, confirmación antes de enviar e historial.
- **Pruebas:** `tests/avisos_web.test.mjs`, sección 6d de `tests/sql/push.sql.test.mjs`.

### Instalación más fácil (rama claude/avisos-ios-facil)
- **iPhone (Safari):** guía de 2 pasos con íconos y una flecha animada que señala el botón Compartir. Apple no permite instalar ni pedir avisos sin ese paso: no hay forma de saltearlo.
- **iPhone dentro de Instagram/Facebook/TikTok:** esos navegadores internos no pueden instalar; se muestra «Abrila en Safari» con botón «Copiar enlace».
- **App ya instalada, sin avisos:** al segundo de abrirla se ofrece «Último paso: Activar avisos».
- **Android:** el service worker se registra ~2,5 s después de cargar para que Chrome ofrezca instalar; el botón «📲 Instalar la tienda como app» (un toque) aparece cuando Chrome lo permite.
