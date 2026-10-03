// POST /api/meli/conectar — inicia la conexión de una cuenta de Mercado Libre.
//
// Es un POST con `fetch` autenticado (token del CRM en `x-crm-token`, igual que
// bandeja) y NO un enlace al que se navega: un enlace no manda ese header, y un
// `fetch` a un endpoint que redirige no sirve. El servidor devuelve la URL de
// autorización y es el navegador el que navega a ella.
//
// El `state` es un nonce OPACO guardado en base, no una firma. Una firma con
// timestamp demuestra que la emitimos nosotros pero no impide reusarla durante
// su ventana de validez; el nonce se consume una sola vez, de forma atómica.
// Además se ata al navegador con una cookie.

const crypto = require('crypto');
const { limitar } = require('../_ratelimit.js');
const M = require('../_meli.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!limitar(req, res, { max: 20, ventanaMs: 60_000 })) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }
  if (!M.configurado()) {
    console.error('meli/conectar: faltan variables de entorno de Mercado Libre.');
    res.status(500).json({ error: 'La integración no está configurada en el servidor.' });
    return;
  }

  const pres = M.presupuesto(8000);
  const email = await M.emailAutorizado(req.headers['x-crm-token'], pres);
  if (!email) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  const nonce = crypto.randomBytes(24).toString('base64url');
  try {
    await M.rpc('meli_state_crear', { p_nonce: nonce, p_usuario_email: email, p_minutos: 10 }, pres);
  } catch (e) {
    console.error('meli/conectar: no se pudo guardar el state —', e.message);
    res.status(502).json({ error: 'No se pudo iniciar la conexión' });
    return;
  }

  // Path acotado a /api/meli: la cookie no viaja al resto del sitio.
  res.setHeader('Set-Cookie',
    `meli_state=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/api/meli; Max-Age=600`);

  const url = new URL(M.AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', M.APP_ID);
  url.searchParams.set('redirect_uri', M.REDIRECT_URI);
  url.searchParams.set('state', nonce);

  res.status(200).json({ authorization_url: url.toString() });
};
