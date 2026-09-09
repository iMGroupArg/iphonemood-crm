const RAILWAY = 'https://bot-comercial-iphone-mood-production.up.railway.app';
const SUPABASE_URL = 'https://oqvmiozafgogfcclwseu.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9xdm1pb3phZmdvZ2ZjY2x3c2V1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4MTg4MDQsImV4cCI6MjA5NzM5NDgwNH0.egzH4uyVJ0W1mj0dTJuJGIWTXXnur9B4z_f12Z8V1lQ';

// Credenciales del bot: viven en variables de entorno de Vercel, no en el
// código. Antes estaban escritas acá mismo y el repositorio es público en
// GitHub, así que quedaban expuestas a cualquiera.
const INBOX_USER = process.env.INBOX_USER;
const INBOX_PASSWORD = process.env.INBOX_PASSWORD;

// Confirma que el token sea de un usuario real Y que esté en la lista de
// autorizados del CRM. Antes solo se validaba lo primero: cualquier cuenta
// de Google (el signup del proyecto está abierto) alcanzaba para entrar a
// la bandeja de WhatsApp, sin pasar por `usuarios_autorizados`.
async function usuarioAutorizado(token) {
  if (!token) return false;
  try {
    const ures = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
    });
    if (!ures.ok) return false;
    const user = await ures.json();
    const email = user?.email;
    if (!email) return false;

    // Se consulta con el token del propio usuario (no con el anon key solo):
    // la política RLS "usuarios_autorizados_select_own" solo deja ver la
    // propia fila, que es exactamente lo que hace falta acá.
    const qres = await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios_autorizados?select=activo&email=eq.${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY } }
    );
    if (!qres.ok) return false;
    const rows = await qres.json();
    return rows.some(r => r.activo === true);
  } catch {
    return false;
  }
}

const { limitar } = require('./_ratelimit.js');

module.exports = async function handler(req, res) {
  // Antes de todo, incluso de mirar el token: el objetivo es frenar la
  // fuerza bruta de tokens y el martilleo del proxy desde un mismo origen.
  if (!limitar(req, res, { max: 120, ventanaMs: 60_000 })) return;

  if (!INBOX_USER || !INBOX_PASSWORD) {
    console.error('Faltan las variables de entorno INBOX_USER / INBOX_PASSWORD.');
    res.status(500).json({ error: 'La bandeja no está configurada en el servidor.' });
    return;
  }

  const token = req.headers['x-crm-token'];
  const autorizado = await usuarioAutorizado(token);
  if (!autorizado) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  // Ruta after /api/bandeja → /bandeja/api/...
  // Se sanea a mano: antes un ".." en la URL podía escaparse fuera de
  // /bandeja/api hacia cualquier otra ruta del servidor de Railway.
  const rawSub = (req.url || '').replace(/^\/api\/bandeja/, '') || '/';
  const [rawPath, rawQuery] = rawSub.split('?');
  const cleanPath = rawPath
    .split('/')
    .filter(seg => seg !== '' && seg !== '.' && seg !== '..')
    .join('/');
  const sub = '/' + cleanPath + (rawQuery ? `?${rawQuery}` : '');
  const target = `${RAILWAY}/bandeja/api${sub}`;

  const headers = {
    Authorization: `Basic ${Buffer.from(`${INBOX_USER}:${INBOX_PASSWORD}`).toString('base64')}`,
    'Content-Type': 'application/json',
  };

  const opts = { method: req.method, headers };
  if (req.method === 'POST') {
    opts.body = JSON.stringify(req.body);
  }

  try {
    const upstream = await fetch(target, opts);
    const ctype = upstream.headers.get('content-type') || 'application/json';

    // Los adjuntos (audio, imágenes) son binarios: leerlos como texto los corrompe.
    if (!ctype.includes('application/json')) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', ctype);
      res.setHeader('Content-Length', buf.length);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      const disp = upstream.headers.get('content-disposition');
      if (disp) res.setHeader('Content-Disposition', disp);
      res.status(upstream.status).send(buf);
      return;
    }

    const text = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    // La respuesta cambia según el usuario que la pidió, así que se marca como
    // no cacheable en vez de heredar el `public` que Vercel pone por defecto.
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(upstream.status).send(text);
  } catch (e) {
    res.status(502).json({ error: 'proxy error', detail: e.message });
  }
};
