// Avisos push en el navegador (compartido por el CRM y la página de seguimiento). Global: window.Push.
//
//   Push.estado()                → { soportado, ios, instalada, permiso, suscripta, motivo }
//   Push.activar(guardar)        → pide permiso (DEBE llamarse desde un toque del usuario), suscribe y llama guardar({endpoint, p256dh, auth})
//   Push.desactivar(borrar)      → cancela la suscripción y llama borrar(endpoint)
//
// iPhone/iPad (iOS 16.4+): el permiso sólo se puede pedir con la app INSTALADA en la pantalla de inicio (Compartir → Agregar a inicio) y desde un toque.
// Si dice "No permitir", iOS no vuelve a preguntar: hay que reactivarlo en Ajustes.

(function () {
  'use strict';
  const ES_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const instalada = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  const base64urlABytes = (s) => {
    const b = (s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b); const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  };

  async function registro() {
    if (!('serviceWorker' in navigator)) return null;
    try { return await navigator.serviceWorker.register('/sw.js'); } catch { return null; }
  }
  async function suscripcionActual() {
    try { const r = await navigator.serviceWorker.getRegistration('/'); return r ? await r.pushManager.getSubscription() : null; } catch { return null; }
  }
  async function claveServidor() {
    try { const r = await fetch('/api/push/clave', { cache: 'no-store' }); const j = await r.json(); return j && j.clave ? String(j.clave) : null; } catch { return null; }
  }

  // Por qué no se puede (o null si se puede). Sirve para mostrar el mensaje justo.
  function motivo() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      return ES_IOS && !instalada() ? 'ios_sin_instalar' : 'no_soportado';
    }
    if (ES_IOS && !instalada()) return 'ios_sin_instalar';
    if (Notification.permission === 'denied') return 'bloqueado';
    return null;
  }

  async function estado() {
    const m = motivo();
    const s = m === 'no_soportado' || m === 'ios_sin_instalar' ? null : await suscripcionActual();
    return { soportado: m !== 'no_soportado', ios: ES_IOS, instalada: instalada(), permiso: ('Notification' in window) ? Notification.permission : 'denied', suscripta: !!s, motivo: m };
  }

  // La suscripción que ya tiene ESTE navegador (o null). Que exista NO quiere decir que esté atada a una reparación o a un usuario: eso lo dice el servidor.
  async function suscripcion() { return suscripcionActual(); }

  async function activar(guardar) {
    const m = motivo();
    if (m) return { ok: false, motivo: m };
    const clave = await claveServidor();
    if (!clave) return { ok: false, motivo: 'sin_servidor' };
    const permiso = await Notification.requestPermission();          // tiene que venir de un toque
    if (permiso !== 'granted') return { ok: false, motivo: permiso === 'denied' ? 'bloqueado' : 'cancelado' };
    const reg = (await registro()) && await navigator.serviceWorker.ready;
    if (!reg) return { ok: false, motivo: 'sin_servidor' };
    let sub = await reg.pushManager.getSubscription();
    // Una suscripción hecha con OTRA clave (por ejemplo tras rotarla) no sirve: se rehace.
    if (sub) {
      const k = sub.options && sub.options.applicationServerKey;
      if (k && new Uint8Array(k).toString() !== base64urlABytes(clave).toString()) { await sub.unsubscribe(); sub = null; }
    }
    let creada = false;
    if (!sub) { sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64urlABytes(clave) }); creada = true; }
    const j = sub.toJSON();
    const r = await guardar({ endpoint: j.endpoint, p256dh: j.keys && j.keys.p256dh, auth: j.keys && j.keys.auth });
    // Si el servidor la rechaza, sólo se cancela la suscripción que ESTA llamada acaba de crear: una que ya existía puede estar sirviendo a otras reparaciones.
    if (r && r.ok === false) { if (creada) { try { await sub.unsubscribe(); } catch { /* ya estaba */ } } return { ok: false, motivo: (r && r.motivo) || 'rechazada' }; }
    return { ok: true, endpoint: j.endpoint };
  }

  // `borrar(endpoint)` borra del servidor y puede devolver { restantes }: si todavía quedan otras reparaciones atadas a este teléfono, la suscripción del
  // navegador NO se cancela (seguiría sirviendo a las otras).
  async function desactivar(borrar) {
    const s = await suscripcionActual();
    if (!s) return { ok: true };
    const endpoint = s.endpoint;
    let restantes = 0;
    try { const r = await borrar(endpoint); restantes = (r && Number(r.restantes)) || 0; } catch { /* si falla el borrado del servidor igual se cancela acá: el próximo envío recibe 410 y se limpia solo */ }
    if (restantes > 0) return { ok: true, restantes };
    try { await s.unsubscribe(); } catch { /* ya estaba */ }
    return { ok: true, restantes: 0 };
  }

  // Registrar el service worker hace que el sitio se pueda instalar como app. En la TIENDA (visitantes anónimos) no se registra al cargar para no sumarle trabajo a la
  // página: sólo cuando la persona usa los avisos o si ya abrió la tienda instalada como app (`data-registro="al-usar"` en la etiqueta <script>).
  const alUsar = typeof document !== 'undefined' && document.currentScript && document.currentScript.dataset && document.currentScript.dataset.registro === 'al-usar';
  if (!alUsar || instalada()) registro();

  window.Push = { estado, activar, desactivar, suscripcion, motivo, esIOS: ES_IOS, instalada, registrar: registro };
})();
