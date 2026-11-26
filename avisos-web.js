// Avisos de la tienda (precios.html): invitar, con buenos modales, a recibir «novedades y ofertas» y poder instalar la tienda como app.
//
// Principios (invitar rápido, sin engañar):
//   · NUNCA se pide el permiso del navegador de entrada: primero una invitación propia que explica qué se manda y cada cuánto.
//   · Aparece a los pocos segundos (o al empezar a scrollear), con un botón grande de aceptar y una cruz chica. Si la cierra, vuelve a los 7 días (30 si la cierra dos veces).
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
    descartar(m, ahora) { const n = (m.n || 0) + 1; return { ...m, n, hasta: ahora + (n >= 2 ? 30 : 7) * DIA }; },
    // ¿Corresponde mostrar la invitación AHORA?
    debeOfrecer({ estado, memoria, ahora, tiempoMs, scroll, modalAbierto, instalada }) {
      if (!estado) return false;
      if (estado.motivo === 'no_soportado' && !estado.ios) return false;       // sin soporte: no se ofrece lo que no se puede
      if (estado.motivo === 'bloqueado') return false;                         // dijo que no en el navegador: no se insiste
      if (memoria && memoria.ok) return false;                                 // ya se suscribió
      if (memoria && memoria.hasta && ahora < memoria.hasta) return false;     // dijo «ahora no» hace poco
      if (modalAbierto) return false;                                          // está mirando un producto o el Plan canje
      return tiempoMs >= 4000 || scroll >= 0.1 || (!!instalada && tiempoMs >= 1000);   // ya instalada: es el «último paso», se ofrece enseguida
    },
    // iPhone/iPad dentro de Instagram, Facebook, TikTok, etc.: esos navegadores internos NO pueden guardar la tienda como app.
    embebido(ua) { return /Instagram|FBAN|FBAV|FB_IAB|TikTok|musical_ly|Line\/|Snapchat|Twitter|LinkedInApp|GSA\//i.test(ua || ''); },
    // Safari de iPhone (no Chrome/Firefox/Edge de iOS, no iPad): ahí el botón Compartir está abajo al centro y se puede señalar.
    safariIphone(ua) { return /iPhone/.test(ua || '') && /Safari/.test(ua || '') && !/CriOS|FxiOS|EdgiOS|OPiOS|Instagram|FBAN|FBAV/i.test(ua || ''); },
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
.av-x{position:absolute;top:2px;right:4px;border:0;background:none;font-size:15px;line-height:1;color:#B0B0B6;cursor:pointer;padding:10px}
.av-botones{display:flex;gap:8px;margin-top:12px}
.av-btn{flex:1;min-height:44px;border-radius:12px;border:1px solid #D2D2D7;background:#fff;color:#1D1D1F;font:inherit;font-size:14.5px;font-weight:600;cursor:pointer}
.av-btn.av-pri{background:#0071E3;border-color:#0071E3;color:#fff}
.av-btn:disabled{opacity:.6;cursor:default}
.av-link{display:block;margin-top:10px;font-size:12.5px;color:#0071E3;background:none;border:0;padding:0;cursor:pointer;font:inherit;font-size:12.5px}
.av-pie a{color:inherit;font-size:11px}
.av-pasos2{margin-top:4px}
.av-paso{display:flex;gap:10px;align-items:center;margin-top:10px;font-size:13.5px;line-height:1.4}
.av-num{flex:none;width:26px;height:26px;border-radius:50%;background:#F5F5F7;border:1px solid #D2D2D7;font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center}
.av-paso svg{flex:none;width:28px;height:28px;color:#0071E3}
.av-flecha{position:fixed;left:50%;bottom:calc(6px + env(safe-area-inset-bottom));z-index:451;margin-left:-16px;width:32px;height:32px;color:#0071E3;pointer-events:none;animation:av-rebote 1s ease-in-out infinite}
@keyframes av-rebote{0%,100%{transform:translateY(-6px)}50%{transform:translateY(4px)}}
@media (prefers-reduced-motion:reduce){.av-flecha{animation:none}}
.av-inst{display:none;width:100%;margin-top:8px;min-height:44px;border-radius:12px;border:1px solid #0071E3;background:#fff;color:#0071E3;font:inherit;font-size:14.5px;font-weight:600;cursor:pointer}
.av-inst.av-on{display:block}`;

  let tarjeta = null, instalable = null, cerrarTimer = null;
  const almacen = (() => { try { return window.localStorage; } catch { return { getItem() { return null; }, setItem() {} }; } })();
  const t0 = Date.now();

  function el(tag, attrs = {}, hijos = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === 'texto') n.textContent = v; else if (k === 'al') n.addEventListener('click', v); else n.setAttribute(k, v); }
    for (const h of [].concat(hijos)) if (h) n.appendChild(h);
    return n;
  }
  const NS = 'http://www.w3.org/2000/svg';
  function icono(tipo) {
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    const d = { compartir: ['M12 15V3', 'M8 7l4-4 4 4', 'M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1'],
      agregar: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M12 8v8', 'M8 12h8'],
      flecha: ['M12 4v14', 'M6 13l6 6 6-6'], safari: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M15.5 8.5l-2 5-5 2 2-5z'] }[tipo] || [];
    d.forEach((x) => { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', x); svg.appendChild(p); });
    return svg;
  }
  function paso(n, tipo, texto) { return el('div', { class: 'av-paso' }, [el('span', { class: 'av-num', texto: String(n) }), tipo ? icono(tipo) : null, el('span', { texto })]); }
  let flecha = null;
  function quitarFlecha() { if (flecha) { flecha.remove(); flecha = null; } }
  function inyectarEstilos() { if (document.getElementById('av-estilos')) return; const s = el('style', { id: 'av-estilos' }); s.textContent = estilos; document.head.appendChild(s); }

  function cerrar(recordar) {
    if (!tarjeta) return;
    if (recordar) logica.guardar(almacen, logica.descartar(logica.leer(almacen), Date.now()));
    clearTimeout(cerrarTimer); quitarFlecha();
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
      extra && extra.nodos ? el('div', { class: 'av-pasos2' }, extra.nodos) : null,
      botones && botones.lista && botones.lista.length ? el('div', { class: 'av-botones' }, botones.lista.map((b) => el('button', { type: 'button', class: 'av-btn' + (b.pri ? ' av-pri' : ''), texto: b.txt, al: b.fn }))) : null,
      extra && extra.instalar ? el('button', { type: 'button', class: 'av-inst' + (instalable ? ' av-on' : ''), texto: '📲 Instalar la tienda como app', al: instalarApp }) : null,
    ]);
    if (tarjeta) tarjeta.remove();
    tarjeta = t; document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('av-ver'));
    return t;
  }

  function instalarApp() {
    if (!instalable) return;
    instalable.prompt(); instalable.userChoice.finally(() => { instalable = null; document.querySelectorAll('.av-inst').forEach((b) => b.classList.remove('av-on')); });
  }

  function copiarEnlace(ev) {
    const url = location.origin + '/', b = ev && ev.currentTarget;
    const listo = () => { if (b) b.textContent = '¡Enlace copiado! Pegalo en Safari'; };
    try { navigator.clipboard.writeText(url).then(listo, () => { if (b) b.textContent = url; }); } catch { if (b) b.textContent = url; }
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
      mostrar('¡Listo! ✅', 'Te mandamos un aviso de bienvenida. Si no lo ves en un minuto, revisá que las notificaciones estén permitidas para este sitio.', { lista: [{ txt: 'Perfecto', pri: true, fn: () => cerrar(false) }] }, { instalar: true });
      if (!instalable) cerrarTimer = setTimeout(() => cerrar(false), 9000);
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
      const ua = navigator.userAgent || '';
      const cerrarBtn = { txt: 'Entendido', pri: true, fn: () => cerrar(false) };
      if (logica.embebido(ua)) {
        // Instagram, Facebook, TikTok…: su navegador interno no puede guardar la tienda. Hay que pasarse a Safari.
        mostrar('Abrila en Safari', 'Desde acá no se puede instalar. Pasate a Safari en dos toques:', { lista: [{ txt: 'Copiar enlace', pri: true, fn: copiarEnlace }, { txt: 'Cerrar', fn: () => cerrar(!manual) }], recordarAlCerrar: !manual },
          { nodos: [paso(1, null, 'Tocá los tres puntitos ⋯ (o el ícono de brújula) del navegador.'), paso(2, 'safari', 'Elegí «Abrir en Safari».')] });
        return;
      }
      mostrar('Instalá la tienda y recibí avisos', 'En iPhone se hace en 2 pasos (20 segundos). Después abrís iPhone Mood desde el ícono nuevo y ahí activás los avisos con un toque.',
        { lista: [cerrarBtn], recordarAlCerrar: !manual },
        { nodos: [paso(1, 'compartir', 'Tocá Compartir' + (logica.safariIphone(ua) ? ' (la flecha de abajo señala el botón).' : ' en la barra del navegador.')), paso(2, 'agregar', 'Elegí «Agregar a pantalla de inicio» y confirmá.')] });
      if (logica.safariIphone(ua)) { quitarFlecha(); flecha = el('div', { class: 'av-flecha', 'aria-hidden': 'true' }, [icono('flecha')]); document.body.appendChild(flecha); }
      return;
    }
    if (e.instalada && !e.suscripta && e.motivo === null) {
      mostrar('¡Ya tenés la app! Un último paso', 'Activá los avisos para enterarte primero de stock nuevo y ofertas. Como mucho 1 por día.', { lista: [{ txt: 'Activar avisos', pri: true, fn: suscribir }], recordarAlCerrar: true });
      return;
    }
    if (e.motivo === 'no_soportado') { if (manual) mostrar('Avisos', logica.textoMotivo('no_soportado'), { lista: [{ txt: 'Entendido', pri: true, fn: () => cerrar(false) }] }); return; }
    if (e.motivo === 'bloqueado') { if (manual) mostrar('Avisos bloqueados', logica.textoMotivo('bloqueado'), { lista: [{ txt: 'Entendido', pri: true, fn: () => cerrar(false) }] }); return; }
    if (e.suscripta && await confirmadoEnServidor()) {
      mostrar('Estás recibiendo avisos ✅', 'Te contamos cuando entra stock nuevo o hay ofertas. Como mucho uno por día.', { lista: [{ txt: 'Dejar de recibirlos', fn: darDeBaja }, { txt: 'Cerrar', pri: true, fn: () => cerrar(false) }] });
      return;
    }
    mostrar('¿Querés enterarte primero?', 'Stock nuevo y ofertas de iPhone Mood, directo a tu celular. Como mucho 1 aviso por día; te das de baja cuando quieras.',
      { lista: [{ txt: 'Sí, activar avisos', pri: true, fn: suscribir }], recordarAlCerrar: true }, { instalar: true });
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
    window.addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); instalable = ev; document.querySelectorAll('.av-inst').forEach((b) => b.classList.add('av-on')); });
    // Android: se registra el service worker poco después de cargar (sin trabajo extra) para que Chrome ofrezca instalar con un toque.
    if (!window.Push.esIOS) setTimeout(() => { try { window.Push.registrar(); } catch { /* sin service worker no hay instalación: los avisos igual se piden al tocar */ } }, 2500);
    window.addEventListener('appinstalled', () => { instalable = null; });
    window.addEventListener('scroll', alScroll, { passive: true });
    if (!logica.leer(almacen).ok) reloj = setInterval(intentarOfrecer, 3000);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && tarjeta) cerrar(false); });
  }

  window.AvisosWeb = { abrir, _logica: logica };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
