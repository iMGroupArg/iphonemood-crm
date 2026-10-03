// GET /api/meli/callback — destino del redirect de OAuth de Mercado Libre.
//
// Llega SIN sesión (es un redirect del navegador desde Mercado Libre), así que
// no se puede confiar en quién es: toda la confianza sale del `state`, que se
// compara con la cookie (ata el flujo al navegador que lo inició) y se consume
// de forma atómica (un solo uso).
//
// Termina siempre en una redirección a una RUTA FIJA del CRM, con un código de
// resultado genérico. Nunca se arma el destino con datos del pedido.

const { limitar } = require('../_ratelimit.js');
const M = require('../_meli.js');

const DESTINO = '/login';

function volver(res, resultado, motivo) {
  // Se borra la cookie en cualquier desenlace.
  res.setHeader('Set-Cookie', 'meli_state=; HttpOnly; Secure; SameSite=Lax; Path=/api/meli; Max-Age=0');
  res.setHeader('Cache-Control', 'no-store');
  const q = new URLSearchParams({ meli: resultado });
  if (motivo) q.set('motivo', motivo);
  res.statusCode = 302;
  res.setHeader('Location', `${DESTINO}?${q.toString()}`);
  res.end();
}

function cookieDe(req, nombre) {
  const raw = req.headers.cookie || '';
  for (const parte of raw.split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nombre) return parte.slice(i + 1).trim();
  }
  return '';
}

module.exports = async function handler(req, res) {
  if (!limitar(req, res, { max: 30, ventanaMs: 60_000 })) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }
  if (!M.configurado()) return volver(res, 'error', 'sin_config');

  const url = new URL(req.url, 'http://localhost');
  // Parámetros repetidos se rechazan: es la forma clásica de colar uno distinto.
  for (const k of ['code', 'state', 'error']) {
    if (url.searchParams.getAll(k).length > 1) return volver(res, 'error', 'parametros');
  }

  // El usuario dijo que no en la pantalla de Mercado Libre.
  if (url.searchParams.get('error')) return volver(res, 'error', 'denegado');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return volver(res, 'error', 'parametros');

  // 1) El state tiene que coincidir con la cookie: ata el flujo a ESTE navegador.
  //    Alguien que consiga un `state` ajeno sin la cookie correspondiente no pasa.
  if (!M.comparar(state, cookieDe(req, 'meli_state'))) return volver(res, 'error', 'navegador');

  const pres = M.presupuesto(9000);
  try {
    // 2) Consumo atómico y de un solo uso. NULL = no existía, ya se usó o venció.
    const email = await M.rpc('meli_state_consumir', { p_nonce: state }, pres);
    if (!email) return volver(res, 'error', 'state');

    // 3) Quien inició la conexión pudo haber sido dado de baja entre que apretó
    //    el botón y volvió de Mercado Libre.
    const sigue = await M.rpc('meli_usuario_autorizado', { p_email: email }, pres);
    if (!sigue) return volver(res, 'error', 'no_autorizado');

    // 4) Intercambio de código. `redirect_uri` idéntica a la de la autorización.
    const t = await M.pedirToken({
      grant_type: 'authorization_code', code, redirect_uri: M.REDIRECT_URI,
    }, pres);
    if (!t.ok || !t.json || !t.json.access_token) return volver(res, 'error', 'intercambio');

    // Sin refresh token la integración muere a las 6 horas. En vez de guardar una
    // cuenta que va a dejar de andar sola, se corta acá y se dice por qué: casi
    // seguro falta habilitar "offline_access" en la configuración de la app.
    if (!t.json.refresh_token) return volver(res, 'error', 'sin_refresh');

    // 5) Quién es la cuenta.
    const me = await M.fetchJson(`${M.HOSTS.ml}/users/me`, {
      headers: { Authorization: `Bearer ${t.json.access_token}`, Accept: 'application/json' },
    }, pres);
    if (!me.ok || !me.json || !me.json.id) return volver(res, 'error', 'usuario');

    // 6) Alta o reconexión. La RPC conserva persona/bolsillo si ya existían.
    await M.rpc('meli_cuenta_conectar', {
      p_user_id: String(me.json.id),
      p_nickname: me.json.nickname || null,
      p_access: t.json.access_token,
      p_refresh: t.json.refresh_token,
      p_expira_seg: Number(t.json.expires_in) || 21600,
    }, pres);

    return volver(res, 'ok');
  } catch (e) {
    console.error('meli/callback:', e.codigo || '', e.message);
    return volver(res, 'error', 'servidor');
  }
};
