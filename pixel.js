// Meta Pixel de la landing pública (lado navegador).
//
// Es un archivo propio y no el snippet que da Meta porque ese snippet es un
// <script> inline, y la CSP de /precios no permite 'unsafe-inline' (ver el
// comentario de precios.js). Hace lo mismo que el snippet, sin el inline.
//
// ─── ENTREGADO DORMIDO ───
// Con PIXEL_ID vacío NO se carga nada de Facebook, no hay ninguna request y
// `imTrack` devuelve null. Para activarlo hace falta, ANTES de poner el número:
//   a) que Franco acepte que el texto buscado viaja en la URL (?q=), o que se
//      deje de guardar `q` en la URL: Meta lee la URL de la página por su
//      cuenta, aunque los eventos no lleven el texto;
//   b) que Franco desactive en Meta la "coincidencia avanzada automática" y los
//      "eventos configurados automáticamente";
//   c) probar el loader real contra la CSP del dominio real (leer la consola
//      buscando violaciones) — que alcancen connect.facebook.net y
//      www.facebook.com es una suposición hasta probarlo.
//
// ─── CONTRATO CON LA API DE CONVERSIONES (otra sesión) ───
// Cada evento arma un envelope { event_name, event_id, event_time, params } que:
//   · va al navegador con fbq(..., { eventID }),
//   · se agrega a window.imEventos (para quien se registre tarde: leer el
//     arreglo al arrancar y después escuchar),
//   · se publica como CustomEvent 'im:evento' en document.
// El envelope se publica aunque fbq esté bloqueado, para que la ruta del
// servidor no dependa del navegador. El servidor debe reusar nombre e ID
// EXACTOS (y conservar el ID en los reintentos), y apuntar al mismo Pixel
// (window.imPixelId). event_time va en segundos Unix.
//
// Privacidad: los params nunca llevan nombre, teléfono ni texto libre del
// cliente. Los que salen: content_name/ids/type, value, currency, num_items
// (carrito) e intent (clic en WhatsApp). Meta igual recibe IP e identificadores del navegador (es inherente).
(function () {
  'use strict';

  const PIXEL_ID = '';

  // Los presupuestos llevan un token privado del cliente en la URL: ahí el
  // píxel no se carga, ni siquiera dormido a medias.
  // URLSearchParams y no una regex: el sitio lee el token con URLSearchParams, que
  // decodifica (?%70resupuesto=... también cuenta). Una regex lo dejaría pasar.
  const privada = new URLSearchParams(location.search).has('presupuesto');
  const activo = !!PIXEL_ID && !privada;

  // imTrack SIEMPRE existe, así precios.js no tiene que preguntar si cargó.
  if (!activo) {
    window.imTrack = () => null;
    window.imIntencion = () => [];
    return;
  }

  window.imPixelId = PIXEL_ID;
  window.imEventos = [];
  let bloqueado = false;   // el loader falló (adblock): se deja de intentar

  // Stub de fbq (el mismo que arma Meta), definido ANTES de pedir el loader
  // para que los eventos tempranos queden en cola.
  if (!window.fbq) {
    const n = window.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!window._fbq) window._fbq = n;
    n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
  }

  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://connect.facebook.net/en_US/fbevents.js';
  // Un bloqueador falla de forma asíncrona: try/catch no lo atrapa. Se corta
  // acá para que la cola no crezca sin fin, y el sitio sigue sin enterarse.
  s.onerror = () => { bloqueado = true; };
  document.head.appendChild(s);

  // Sin detección automática de botones ni metadatos de la página.
  window.fbq('set', 'autoConfig', false, PIXEL_ID);
  window.fbq('init', PIXEL_ID);

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 3 | 8)).toString(16);
      }));

  // Anti doble clic. La clave es nombre + clave del llamador, así dos productos
  // distintos, o un estándar y un custom de la misma intención, no se pisan.
  const visto = new Map();
  const VENTANA_MS = 1000;

  window.imTrack = function (nombre, params, { custom = false, clave = '' } = {}) {
    try {
      const k = nombre + '|' + clave;
      const ahora = Date.now();
      if (visto.has(k) && ahora - visto.get(k) < VENTANA_MS) return null;
      visto.set(k, ahora);

      const envelope = {
        event_name: nombre,
        event_id: uuid(),
        event_time: Math.floor(ahora / 1000),
        params: params || {},
      };
      window.imEventos.push(envelope);
      document.dispatchEvent(new CustomEvent('im:evento', { detail: envelope }));
      if (!bloqueado) {
        window.fbq(custom ? 'trackCustom' : 'track', nombre, envelope.params,
                   { eventID: envelope.event_id });
      }
      return envelope;
    } catch (e) { return null; }
  };

  // Intención del cliente → eventos. Una sola tabla, para que el mapeo se lea
  // de un vistazo y no quede repartido en ifs. Un envío puede producir uno
  // estándar y uno custom: tienen nombres distintos y cada uno su event_id.
  //
  // OJO: miden "mandó la consulta a WhatsApp", no turno confirmado ni compra.
  // TradeInCompleted, por ejemplo, es "terminó el formulario de canje".
  const INTENCIONES = {
    turno:        [['Schedule', false],         ['AppointmentRequested', true]],
    disponibilidad: [['Contact', false],        ['AvailabilityRequested', true]],
    duda:         [['Contact', false]],
    reserva:      [['InitiateCheckout', false], ['ReservationStarted', true]],
    canje:        [['Lead', false],             ['TradeInCompleted', true]],
    financiacion: [['Lead', false],             ['FinancingCalculated', true]],
    espera:       [['Lead', false],             ['AvailabilityRequested', true]],
  };

  window.imIntencion = function (intencion, params, clave) {
    return (INTENCIONES[intencion] || [])
      .map(([nombre, custom]) => window.imTrack(nombre, params, { custom, clave: 'int:' + intencion + ':' + (clave || '') }))
      .filter(Boolean);
  };

  window.imTrack('PageView');
})();
