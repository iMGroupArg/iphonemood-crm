// Avisos de la tienda (precios.html): invitar, con buenos modales, a recibir «novedades y ofertas» y poder instalar la tienda como app.
//
// Principios (que el cliente no se sienta molestado):
//   · NUNCA se pide el permiso del navegador de entrada: primero una invitación propia que explica qué se manda y cada cuánto, con «Ahora no» igual de visible.
//   · Aparece una sola vez y recién cuando la persona mostró interés (leyó un rato o scrolleó). Si dice que no, no vuelve por 30 días (90 si dice que no dos veces).
//   · Si ya está suscripta, o el navegador las tiene bloqueadas, no se insiste.
//   · En iPhone, donde los avisos sólo andan con la app instalada, se explica el paso en vez de fallar en silencio.
//   · Para darse de baja basta un toque, desde el 🔔 al pie de la página. Sólo se guarda el identificador del navegador (sin nombre, mail ni teléfono).
// Usa window.Push (push.js) y `supa` (precios.js). Todo lo que pasa en la base está en el script 34 (push_suscribir_visitante / push_baja_visitante).

(function () {
  'use strict';

  const CLAVE = 'im_avisos_v1';
  const DIA = 24 * 3600 * 1000;

  // ── Decisiones (puras, probadas en tests/avisos_web.test.mjs) ──────────────
  const logica = {
    // Memoria en el navegador de la persona (localStorage); si no se puede usar, se trabaja sin memoria.
    leer(almacen) { try { return JSON.parse(almacen.getItem(CLAVE)) || {}; } catch { return {}; } },
    guardar(almacen, m) { try { almacen.setItem(CLAVE, JSON.stringify(m)); } catch { /* sin almacenamiento: no pasa nada */ } },
    descartar(m, ahora) { const n = (m.n || 0) + 1; return { ...m, n, hasta: ahora + (n >= 2 ? 90 : 30) * DIA }; },
    // ¿Corresponde mostrar la invitación AHORA?
    debeOfrecer({ estado, memoria, ahora, tiempoMs, scroll, modalAbierto, instalada }) {
      if (!estado) return false;
      if (estado.motivo === 'no_soportado' && !estado.ios) return false;       // sin soporte: no se ofrece lo que no se puede
      if (estado.motivo === 'bloqueado') return false;                         // dijo que no en el navegador: no se insiste
      if (memoria && memoria.ok) return false;                                 // ya se suscribió
      if (memoria && memoria.hasta && ahora < memoria.hasta) return false;     // dijo «ahora no» hace poco
      if (modalAbierto) return false;                                          // está mirando un producto o el Plan canje
      return tiempoMs >= 25000 || scroll >= 0.35 || (!!instalada && tiempoMs >= 6000);
    },
    textoMotivo(motivo) {
      return ({
        bloqueado: 'Los avisos están bloqueados en este navegador. Activalos desde la configuración del sitio (el candado junto a la dirección) o desde los Ajustes del teléfono.',
        cancelado: 'Está bien, no pasa nada. Si cambiás de idea, tocá 🔔 Avisos al final de la página.',
        no_soportado: 'Este navegador no permite recibir avisos. Podés seguir mirando la tienda como siempre.',
        ocupado: 'Ahora no pudimos activar los avisos. Probá de nuevo más tarde.',
      })[motivo] || 'Ahora no pudimos activar los avisos. Probá de nuevo en un rato.';
    },
  };

  if (typeof window === 'undefined' || typeof document === 'undefined') { module.exports = { logica }; return; }

  // ── Interfaz ───────────────────────────────────────────────────────────────
  const estilos = `
.av-card{position:fixed;left:12px;right:12px;bottom:calc(92px + env(safe-area-inset-bottom));z-index:450;background:#fff;color:#1D1D1F;border:1px solid #E8E8ED;border-radius:20px;box-shadow:0 12px 40px rgba(0,0,0,.18);padding:16px 16px 14px;font-family:var(--font,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);transform:translateY(16px);opacity:0;transition:transform .28s ease,opacity .28s ease}
.av-card.av-ver{transform:none;opacity:1}
@media (min-width:760px){.av-card{left:auto;right:24px;bottom:96px;width:380px}}
@media (prefers-reduced-motion:reduce){.av-card{transition:none}}
.av-fila{display:flex;gap:12px;align-items:flex-start}
.av-ico{flex:none;width:42px;height:42px;border-radius:12px;background:#0071E3;color:#fff;display:flex;align-items:center;justify-content:center;font-size:21px}
.av-t{font-size:15.5px;font-weight:700;letter-spacing:-.2px;line-height:1.25}
.av-s{font-size:13px;color:#6E6E73;line-height:1.5;margin-top:4px}
.av-pasos{margin:8px 0 0 18px;padding:0;font-size:13px;line-height:1.55;color:#1D1D1F}
.av-x{position:absolute;top:8px;right:10px;border:0;background:none;font-size:20px;line-height:1;color:#86868B;cursor:pointer;padding:6px}
.av-botones{display:flex;gap:8px;margin-top:12px}
.av-btn{flex:1;min-height:44px;border-radius:12px;border:1px solid #D2D2D7;background:#fff;color:#1D1D1F;font:inherit;font-size:14.5px;font-weight:600;cursor:pointer}
.av-btn.av-pri{background:#0071E3;border-color:#0071E3;color:#fff}
.av-btn:disabled{opacity:.6;cursor:default}
.av-link{display:block;margin-top:10px;font-size:12.5px;color:#0071E3;background:none;border:0;padding:0;cursor:pointer;font:inherit;font-size:12.5px}
.av-pie a{color:inherit;font-size:11px}`;

  let tarjeta = null, instalable = null, cerrarTimer = null;
  const almacen = (() => { try { return window.localStorage; } catch { return { getItem() { return null; }, setItem() {} }; } })();
  const t0 = Date.now();

  function el(tag, attrs = {}, hijos = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === 'texto') n.textContent = v; else if (k === 'al') n.addEventListener('click', v); else n.setAttribute(k, v); }
    for (const h of [].concat(hijos)) if (h) n.appendChild(h);
    return n;
  }
  function inyectarEstilos() { if (document.getElementById('av-estilos')) return; const s = el('style', { id: 'av-estilos' }); s.textContent = estilos; document.head.appendChild(s); }

  function cerrar(recordar) {
    if (!tarjeta) return;
    if (recordar) logica.guardar(almacen, logica.descartar(logica.leer(almacen), Date.now()));
    clearTimeout(cerrarTimer);
    const t = tarjeta; tarjeta = null; t.classList.remove('av-ver'); setTimeout(() => t.remove(), 300);
  }
  function mostrar(titulo, texto, botones, extra) {
    inyectarEstilos();
    const t = el('div', { class: 'av-card', role: 'dialog', 'aria-live': 'polite', 'aria-label': 'Avisos de iPhone Mood' }, [
      el('button', { class: 'av-x', type: 'button', 'aria-label': 'Cerrar', texto: '×', al: () => cerrar(botones && botones.recordarAlCerrar) }),
      el('div', { class: 'av-fila' }, [
        el('div', { class: 'av-ico', 'aria-hidden': 'true', texto: '🔔' }),
        el('div', {}, [el('div', { class: 'av-t', texto: titulo }), el('div', { class: 'av-s', texto: texto }), extra && extra.pasos
          ? el('ol', { class: 'av-pasos' }, extra.pasos.map((p) => el('li', { texto: p }))) : null]),
      ]),
      botones && botones.lista && botones.lista.length ? el('div', { class: 'av-botones' }, botones.lista.map((b) => el('button', { type: 'button', class: 'av-btn' + (b.pri ? ' av-pri' : ''), texto: b.txt, al: b.fn }))) : null,
      extra && extra.instalar && instalable ? el('button', { type: 'button', class: 'av-link', texto: '📲 Instalar la tienda como app', al: instalarApp }) : null,
    ]);
    if (tarjeta) tarjeta.remove();
    tarjeta = t; document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('av-ver'));
    return t;
  }

  function instalarApp() {
    if (!instalable) return;
    instalable.prompt(); instalable.userChoice.finally(() => { instalable = null; });
  }

  async function estado() { return window.Push ? window.Push.estado() : { soportado: false, motivo: 'no_soportado', ios: false }; }

  async function confirmadoEnServidor() {
    try {
      const sub = await window.Push.suscripcion();
      if (!sub || typeof supa === 'undefined') return false;
      const { data } = await supa.rpc('push_estado_visitante', { p_endpoint: sub.endpoint });
      return !!(data && (data.suscripta || data.pendiente));
    } catch { return false; }
  }

  async function suscribir() {
    mostrar('Activando…', 'Un segundo, estamos preparando los avisos.', { lista: [] });
    const r = await window.Push.activar(async ({ endpoint, p256dh, auth }) => {
      if (typeof supa === 'undefined') return { ok: false, motivo: 'sin_servidor' };
      const { data, error } = await supa.rpc('push_suscribir_visitante', { p_endpoint: endpoint, p_p256dh: p256dh, p_auth: auth });
      return error ? { ok: false, motivo: 'rechazada' } : (data && data.ok ? { ok: true } : { ok: false, motivo: (data && data.motivo) || 'rechazada' });
    });
    if (r.ok) {
      logica.guardar(almacen, { ...logica.leer(almacen), ok: true });
      mostrar('¡Listo! ✅', 'Te mandamos un aviso de bienvenida. Si no lo ves en un minuto, revisá que las notificaciones estén permitidas para este sitio.', { lista: [{ txt: 'Perfecto', pri: true, fn: () => cerrar(false) }] });
      cerrarTimer = setTimeout(() => cerrar(false), 9000);
      return;
    }
    if (r.motivo === 'cancelado') logica.guardar(almacen, logica.descartar(logica.leer(almacen), Date.now()));
    mostrar(r.motivo === 'cancelado' ? 'Sin problema' : 'No se pudo activar', logica.textoMotivo(r.motivo), { lista: [{ txt: 'Entendido', pri: true, fn: () => cerrar(false) }] });
  }

  async function darDeBaja() {
    await window.Push.desactivar(async (endpoint) => { const { data } = await supa.rpc('push_baja_visitante', { p_endpoint: endpoint }); return data; });
    logica.guardar(almacen, { ...logica.leer(almacen), ok: false });
    mostrar('Listo, sin avisos', 'No te vamos a mandar más avisos. Cuando quieras, los reactivás desde 🔔 Avisos al final de la página.', { lista: [{ txt: 'Entendido', pri: true, fn: () => cerrar(false) }] });
    cerrarTimer = setTimeout(() => cerrar(false), 7000);
  }

  // La invitación (o la guía para iPhone, o el estado si ya está suscripta).
  async function abrir(manual) {
    const e = await estado();
    if (e.motivo === 'ios_sin_instalar') {
      mostrar('Avisos en iPhone', 'En iPhone los avisos funcionan con la tienda guardada como app. Son 3 pasos y tardás 20 segundos:', { lista: [{ txt: 'Entendido', pri: true, fn: () => cerrar(false) }], recordarAlCerrar: !manual },
        { pasos: ['Tocá el botón Compartir (el cuadrado con la flecha hacia arriba).', 'Elegí «Agregar a pantalla de inicio».', 'Abrí iPhone Mood desde el ícono nuevo y tocá 🔔 Avisos al final de la página.'] });
      return;
    }
    if (e.motivo === 'no_soportado') { if (manual) mostrar('Avisos', logica.textoMotivo('no_soportado'), { lista: [{ txt: 'Entendido', pri: true, fn: () => cerrar(false) }] }); return; }
    if (e.motivo === 'bloqueado') { if (manual) mostrar('Avisos bloqueados', logica.textoMotivo('bloqueado'), { lista: [{ txt: 'Entendido', pri: true, fn: () => cerrar(false) }] }); return; }
    if (e.suscripta && await confirmadoEnServidor()) {
      mostrar('Estás recibiendo avisos ✅', 'Te contamos cuando entra stock nuevo o hay ofertas. Como mucho uno por día.', { lista: [{ txt: 'Dejar de recibirlos', fn: darDeBaja }, { txt: 'Cerrar', pri: true, fn: () => cerrar(false) }] });
      return;
    }
    mostrar('¿Te avisamos cuando haya novedades?', 'Stock nuevo y ofertas de iPhone Mood, directo a tu celular. Como mucho 1 aviso por día y te podés dar de baja cuando quieras.',
      { lista: [{ txt: 'Ahora no', fn: () => cerrar(true) }, { txt: 'Sí, avisame', pri: true, fn: suscribir }], recordarAlCerrar: true }, { instalar: true });
  }

  // ── Cuándo se ofrece sola ───────────────────────────────────────────────────
  let scrollMax = 0, ofrecida = false, reloj = null;
  function intentarOfrecer() {
    if (ofrecida || tarjeta) return;
    const modalAbierto = !!document.querySelector('.modal-overlay.open, .cj.open, .cj-open');
    estado().then((e) => {
      if (!logica.debeOfrecer({ estado: e, memoria: logica.leer(almacen), ahora: Date.now(), tiempoMs: Date.now() - t0, scroll: scrollMax, modalAbierto, instalada: window.Push && window.Push.instalada && window.Push.instalada() })) return;
      ofrecida = true; clearInterval(reloj); abrir(false);
    }).catch(() => {});
  }
  function alScroll() {
    const alto = document.documentElement.scrollHeight - window.innerHeight;
    if (alto > 0) scrollMax = Math.max(scrollMax, window.scrollY / alto);
  }

  function iniciar() {
    if (!window.Push) return;
    // 🔔 al pie de la página: siempre se puede activar o dar de baja desde acá.
    const pie = document.querySelector('footer');
    if (pie) {
      const p = el('div', { class: 'av-pie', style: 'margin-top:6px' }, [el('a', { href: '#avisos', texto: '🔔 Avisos de novedades', al: (ev) => { ev.preventDefault(); abrir(true); } })]);
      pie.appendChild(p);
    }
    window.addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); instalable = ev; });
    window.addEventListener('appinstalled', () => { instalable = null; });
    window.addEventListener('scroll', alScroll, { passive: true });
    if (!logica.leer(almacen).ok) reloj = setInterval(intentarOfrecer, 3000);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && tarjeta) cerrar(false); });
  }

  window.AvisosWeb = { abrir, _logica: logica };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
