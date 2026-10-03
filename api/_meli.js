// Núcleo compartido de la integración con Mercado Libre.
//
// Plan completo y el porqué de cada decisión: docs/meli-plan-implementacion.md
// (revisado con Codex en cinco rondas). Esquema: db/pendientes/meli_esquema_base.sql.
//
// Reglas que este archivo hace cumplir, todas salidas de esa revisión:
//
//   · El servidor NO usa service-role key. Entra a la base por RPC SECURITY
//     DEFINER que validan MELI_RPC_SECRET. Si el secreto se filtrara, el daño
//     queda acotado a esas operaciones, no a la base entera.
//   · Los tokens de Mercado Libre viven en base, nunca en variables de entorno:
//     el refresh token es de UN SOLO USO y rota en cada refresco, así que una
//     variable estática se invalidaría sola.
//   · Cada llamada externa tiene timeout, y ese timeout nunca supera el tiempo
//     que le queda al presupuesto global de la función.
//   · Los hosts salen de una tabla fija. La ruta que trae un aviso NO decide a
//     qué servidor se le pregunta.

const crypto = require('crypto');
const { SUPABASE_URL, SUPABASE_ANON } = require('./_catalogo.js');

const RPC_SECRET    = process.env.MELI_RPC_SECRET;
const APP_ID        = process.env.MELI_APP_ID;
const CLIENT_SECRET = process.env.MELI_CLIENT_SECRET;

// Fija e idéntica en la autorización y en el intercambio de código: si difieren
// ni en un carácter, Mercado Libre rechaza el intercambio.
const REDIRECT_URI = 'https://iphonemood.com/api/meli/callback';

// Tabla fija de hosts. Una URL absoluta, "//host" o una ruta con ".." que venga
// en un aviso no puede mandar el pedido a otro servidor.
const HOSTS = {
  ml: 'https://api.mercadolibre.com',
  mp: 'https://api.mercadopago.com',
};
const AUTH_URL = 'https://auth.mercadolibre.com.ar/authorization';

const TIMEOUT_MS = 8000;

function configurado() { return !!(RPC_SECRET && APP_ID && CLIENT_SECRET); }

// ── Presupuesto de tiempo ───────────────────────────────────────────────────
// Varios timeouts individuales pueden sumar más que el límite de la función.
// Con un presupuesto compartido, cada pedido recibe el MENOR entre su propio
// límite y lo que queda.
function presupuesto(ms) { return presupuestoHasta(Date.now() + ms); }

// Con deadline ABSOLUTO. Un handler tiene que fijar su límite al EMPEZAR (antes
// de autenticar, que ya gasta tiempo) y repartirlo desde ahí; si cada tramo
// arranca su propio reloj, la suma se pasa del tiempo real de la función.
//
// `hastaFinal` (opcional) es el deadline del TRAMO DE CIERRE, posterior a `hasta`.
// Se adjunta como `.final` para que quien recibe sólo `pres` (el manejo de tokens
// llega por meliGet → tokenDe → refrescar) también pueda acotar sus escrituras de
// cierre al deadline real, en vez de abrir un reloj propio que se pase.
function presupuestoHasta(hasta, hastaFinal) {
  const p = { hasta, restante: () => hasta - Date.now() };
  if (hastaFinal) p.final = presupuestoHasta(hastaFinal);
  return p;
}

// Tiempo mínimo para ARRANCAR un intercambio de refresh. Con menos, el timeout
// recortado del pedido a Mercado Libre se cumpliría aunque Mercado Libre sí
// hubiera rotado el token, y se fabricaría un caso ambiguo por pura falta de
// tiempo. Si no alcanza, es mejor no empezar.
const MIN_PARA_REFRESCAR_MS = 3000;

class ErrorMeli extends Error {
  constructor(codigo, mensaje, extra = {}) { super(mensaje || codigo); this.codigo = codigo; Object.assign(this, extra); }
}

async function fetchJson(url, opts = {}, pres) {
  const propio = opts.timeoutMs || TIMEOUT_MS;
  const ms = pres ? Math.min(propio, pres.restante()) : propio;
  if (ms <= 0) throw new ErrorMeli('SIN_TIEMPO', 'se agotó el presupuesto de tiempo');

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    // redirect:'error' — una redirección inesperada no nos puede llevar a otro host.
    const r = await fetch(url, { ...opts, signal: ctl.signal, redirect: 'error' });
    let json = null;
    try { json = await r.json(); } catch { /* cuerpo vacío o no-JSON */ }
    return { status: r.status, ok: r.ok, json };
  } finally {
    clearTimeout(t);
  }
}

// ── Base de datos: sólo por RPC ─────────────────────────────────────────────
async function rpc(nombre, args = {}, pres) {
  if (!RPC_SECRET) throw new ErrorMeli('SIN_CONFIG', 'falta MELI_RPC_SECRET');
  const r = await fetchJson(`${SUPABASE_URL}/rest/v1/rpc/${nombre}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON,
      Authorization: `Bearer ${SUPABASE_ANON}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_secreto: RPC_SECRET, ...args }),
  }, pres);
  if (!r.ok) {
    const msg = (r.json && (r.json.message || r.json.hint)) || `HTTP ${r.status}`;
    throw new ErrorMeli('RPC', `${nombre}: ${msg}`, { status: r.status });
  }
  return r.json;
}

// Las funciones TABLE devuelven un array; las escalares, el valor pelado.
const primera = (x) => (Array.isArray(x) ? x[0] : x);

// ── Tokens ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function pedirToken(params, pres) {
  return fetchJson(`${HOSTS.ml}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: APP_ID, client_secret: CLIENT_SECRET, ...params }).toString(),
  }, pres);
}

// Devuelve un access token vigente para la cuenta, refrescándolo si hace falta.
//
// La base entrega el permiso de refrescar a UNA sola instancia a la vez (lease).
// Las demás esperan un momento y vuelven a leer. Esto importa porque el refresh
// token de Mercado Libre es de un solo uso: dos refrescos simultáneos queman el
// token y dejan la cuenta afuera hasta que alguien la reconecte a mano.
async function tokenDe(cuentaId, pres) {
  for (let intento = 0; intento < 4; intento++) {
    const t = primera(await rpc('meli_tokens_tomar', { p_cuenta_id: cuentaId }, pres));

    // Cuenta rota: no se insiste. Reintentar contra un refresh ya consumido sólo
    // empeora las cosas.
    if (!t.activa || t.requiere_reconexion || t.refresh_ambiguo) {
      throw new ErrorMeli('CUENTA_BLOQUEADA',
        t.refresh_ambiguo ? 'el último refresco quedó ambiguo: hay que reconectar'
                          : 'la cuenta requiere reconexión');
    }

    if (t.debe_refrescar) return refrescar(cuentaId, t, pres);

    const vigente = t.token_expira_en && new Date(t.token_expira_en).getTime() > Date.now() + 30_000;
    if (vigente) return t.access_token;

    // Otra instancia está refrescando: espera acotada y se vuelve a leer.
    await sleep(Math.min(400, Math.max(0, pres ? pres.restante() : 400)));
  }
  throw new ErrorMeli('TOKEN_NO_DISPONIBLE', 'no se pudo obtener un token vigente');
}

async function refrescar(cuentaId, t, pres) {
  // Las escrituras de cierre (marcar, abortar, persistir) usan el deadline FINAL
  // si lo hay; si no hay presupuesto (callback, scripts) se rigen por el timeout
  // propio de cada pedido.
  const fin = (pres && pres.final) || undefined;

  if (pres && pres.restante() < MIN_PARA_REFRESCAR_MS) {
    throw new ErrorMeli('REFRESH_TRANSITORIO', 'no queda tiempo suficiente para refrescar sin riesgo');
  }

  // Se deja constancia en la base ANTES de llamar a Mercado Libre. Si la
  // instancia muere después de que Mercado Libre rotó el token y antes de poder
  // anotar nada (ni siquiera "ambiguo"), esta marca es lo único que queda: al
  // vencer el lease, la base ve "iniciado sin concluir" y bloquea el refresco en
  // vez de entregárselo a otra instancia, que usaría un refresh ya consumido.
  let iniciado = false;
  try {
    iniciado = await rpc('meli_refresh_iniciar', {
      p_cuenta_id: cuentaId, p_lease_id: t.lease_id, p_generacion: t.generacion,
    }, pres);
  } catch { /* si ni eso se pudo, NO se arriesga el intercambio */ }
  if (!iniciado) throw new ErrorMeli('REFRESH_TRANSITORIO', 'no se pudo reservar el refresco (lease perdido)');

  // Esa RPC pudo haberse comido el tiempo que quedaba. Se vuelve a comprobar
  // ANTES de mandar nada: si ya no alcanza, el intercambio NO se inició y hay que
  // levantar la marca. Sin esta segunda comprobación, el pedido fallaba por falta
  // de tiempo sin haber salido nunca, y se lo trataba como un timeout de red.
  if (pres && pres.restante() < MIN_PARA_REFRESCAR_MS) {
    await rpc('meli_refresh_abortar', { p_cuenta_id: cuentaId, p_lease_id: t.lease_id }, fin).catch(() => {});
    throw new ErrorMeli('REFRESH_TRANSITORIO', 'se agotó el tiempo antes de iniciar el intercambio');
  }

  let resp;
  try {
    resp = await pedirToken({ grant_type: 'refresh_token', refresh_token: t.refresh_token }, pres);
  } catch (e) {
    // SIN_TIEMPO se lanza ANTES de enviar el pedido (fetchJson lo corta si no
    // queda presupuesto): Mercado Libre nunca se enteró, el token no se rotó. Es
    // un intercambio NO iniciado, no un timeout ambiguo. Marcar la cuenta como
    // ambigua por esto obligaría a reconectar sin que haya pasado nada.
    if (e && e.codigo === 'SIN_TIEMPO') {
      await rpc('meli_refresh_abortar', { p_cuenta_id: cuentaId, p_lease_id: t.lease_id }, fin).catch(() => {});
      throw new ErrorMeli('REFRESH_TRANSITORIO', 'se agotó el tiempo antes de enviar el intercambio');
    }
    // Timeout o error de red: NO sabemos si Mercado Libre llegó a rotar el
    // refresh token. Reintentar a ciegas lo quemaría. Se marca el estado
    // ambiguo, que bloquea todo refresco automático hasta reconectar.
    await rpc('meli_marcar_ambiguo', {
      p_cuenta_id: cuentaId, p_lease_id: t.lease_id, p_generacion: t.generacion,
      p_error: `intercambio sin respuesta: ${e.name || 'error'}`,
    }, fin).catch(() => {});
    throw new ErrorMeli('REFRESH_AMBIGUO', 'el refresco no respondió: no se reintenta solo');
  }

  if (!resp.ok) {
    const err = resp.json && resp.json.error;
    // Definitivo: el token ya se usó o venció. Reintentar no lo arregla.
    if (resp.status === 400 || resp.status === 401 || err === 'invalid_grant') {
      await rpc('meli_marcar_reconexion', {
        p_cuenta_id: cuentaId, p_lease_id: t.lease_id, p_generacion: t.generacion,
        p_error: `refresh rechazado: ${err || resp.status}`,
      }, fin).catch(() => {});
      throw new ErrorMeli('REFRESH_INVALIDO', 'Mercado Libre rechazó el refresh token: hay que reconectar');
    }
    // Transitorio (5xx, 429): sí hubo respuesta, así que el token no se rotó.
    // Se levanta la marca de "iniciado" (si no, el próximo intento lo tomaría por
    // un intercambio abandonado y bloquearía la cuenta sin necesidad).
    await rpc('meli_refresh_abortar', { p_cuenta_id: cuentaId, p_lease_id: t.lease_id }, fin).catch(() => {});
    throw new ErrorMeli('REFRESH_TRANSITORIO', `Mercado Libre respondió ${resp.status}`);
  }

  const { access_token, refresh_token, expires_in } = resp.json || {};
  if (!access_token) throw new ErrorMeli('REFRESH_INVALIDO', 'la respuesta no trae access_token');

  // Ya recibimos tokens NUEVOS y el refresh viejo quedó consumido. Persistirlos
  // es lo único que importa ahora: se reintenta de forma acotada, y con un
  // presupuesto PROPIO. Usar el del llamador, que a esta altura puede estar casi
  // agotado, haría fallar justo la escritura que no se puede perder.
  // Acotado al deadline FINAL del llamador si lo hay: un presupuesto propio de 7 s
  // abierto en el segundo 19 se iría hasta el 26 y se pasaría del cierre del
  // worker. El intercambio usó `pres`, que termina antes del tramo reservado, así
  // que acá siempre queda ese tramo disponible.
  const presPersistir = fin || presupuesto(7000);
  for (let i = 0; i < 3; i++) {
    try {
      const aplico = await rpc('meli_tokens_guardar', {
        p_cuenta_id: cuentaId, p_lease_id: t.lease_id,
        p_access: access_token, p_refresh: refresh_token || null,
        p_expira_seg: Number(expires_in) || 21600,
      }, presPersistir);
      if (aplico) return access_token;

      // Dijo "no apliqué": o el lease cambió (reconexión) o un intento anterior
      // SÍ entró y se perdió su respuesta. `ultimo_refresh_guardado_id` es lo
      // único que distingue una cosa de la otra.
      const yaEstaba = await rpc('meli_refresh_ya_guardado', { p_cuenta_id: cuentaId, p_lease_id: t.lease_id }, presPersistir);
      if (yaEstaba) return access_token;
      break;                       // el lease ya no es nuestro: no pisar nada
    } catch {
      /* se reintenta */
    }
  }

  // Caso irreducible, documentado en el plan: recibimos tokens y no pudimos
  // guardarlos. El refresh viejo ya no sirve y el nuevo se perdió. Se devuelve el
  // access token para que ESTE pedido siga, pero la cuenta va a pedir reconexión
  // en el próximo refresco. No hay forma de evitarlo del todo.
  console.error(`meli: tokens recibidos y NO persistidos (cuenta ${cuentaId}): hará falta reconectar`);
  return access_token;
}

// ── Pedidos a las APIs ──────────────────────────────────────────────────────
// `ruta` la arma el llamador a partir de un id numérico validado. Se exige que
// empiece con "/" y no contenga "//" ni ".." como última defensa.
function rutaSegura(ruta) {
  if (typeof ruta !== 'string' || ruta[0] !== '/' || ruta.includes('//') || ruta.includes('..')) {
    throw new ErrorMeli('RUTA_INVALIDA', 'ruta rechazada');
  }
  return ruta;
}

async function get(host, cuentaId, ruta, pres) {
  const token = await tokenDe(cuentaId, pres);
  return fetchJson(`${HOSTS[host]}${rutaSegura(ruta)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  }, pres);
}
const meliGet = (cuentaId, ruta, pres) => get('ml', cuentaId, ruta, pres);
// Los pagos viven en Mercado Pago, NO en api.mercadolibre.com.
const mpGet   = (cuentaId, ruta, pres) => get('mp', cuentaId, ruta, pres);

// ── Avisos del webhook ──────────────────────────────────────────────────────
// Lista blanca de tópicos y de formas de `resource`. Se extrae SÓLO el id
// numérico; la URL a consultar la arma el servidor. Mercado Libre manda los
// avisos de pago como "/collections/{id}", no "/v1/payments/{id}": se aceptan
// las dos formas.
const RECURSOS = {
  orders_v2: [/^\/orders\/(\d{1,20})$/],
  payments:  [/^\/collections\/(\d{1,20})$/, /^\/v1\/payments\/(\d{1,20})$/],
  shipments: [/^\/shipments\/(\d{1,20})$/],
};

function parseAviso(topico, recurso) {
  // Object.hasOwn y no un acceso directo: `RECURSOS['constructor']`, `['toString']`
  // o `['__proto__']` devuelven valores HEREDADOS que son verdaderos pero no se
  // pueden recorrer, y esto lanzaba un TypeError con una entrada que manda
  // cualquiera (el webhook no está autenticado).
  if (typeof topico !== 'string' || !Object.hasOwn(RECURSOS, topico)) return null;
  const reglas = RECURSOS[topico];
  if (typeof recurso !== 'string' || recurso.length > 64) return null;
  for (const re of reglas) {
    const m = recurso.match(re);
    if (m) return { topico, id: m[1] };
  }
  return null;
}

// ── Sesión del CRM ──────────────────────────────────────────────────────────
// Mismo criterio que api/bandeja.js: el token es de un usuario real Y está en la
// lista de autorizados. Devuelve el email, o null.
async function emailAutorizado(token, pres) {
  if (!token || typeof token !== 'string') return null;
  try {
    const u = await fetchJson(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON },
    }, pres);
    const email = u.ok && u.json && u.json.email;
    if (!email) return null;

    // Con el token del propio usuario: la política RLS "usuarios_autorizados_select_own"
    // deja ver sólo la fila propia, que es justo lo que hace falta.
    const q = await fetchJson(
      `${SUPABASE_URL}/rest/v1/usuarios_autorizados?select=activo&email=eq.${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON } }, pres);
    return (q.ok && Array.isArray(q.json) && q.json.some(r => r.activo === true)) ? email : null;
  } catch {
    return null;
  }
}

function comparar(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = {
  APP_ID, REDIRECT_URI, AUTH_URL, HOSTS, ErrorMeli,
  configurado, presupuesto, presupuestoHasta, fetchJson, rpc, primera,
  pedirToken, tokenDe, meliGet, mpGet, parseAviso, emailAutorizado, comparar,
};
