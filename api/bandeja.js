const RAILWAY = 'https://bot-comercial-iphone-mood-production.up.railway.app';
// Usuario/clave de la Bandeja del bot: vienen de variables de entorno (Vercel
// > Settings > Environment Variables), NUNCA hardcodeadas en el codigo - este
// repo es publico, cualquiera que lo lea se hubiera podido meter a la Bandeja
// sin loguearse. Mismos nombres que usa el bot en Railway (INBOX_USER /
// INBOX_PASSWORD), asi los dos lados usan literalmente la misma credencial.
const BANDEJA_USER = process.env.INBOX_USER || 'iphonemood';
const BASIC = Buffer.from(`${BANDEJA_USER}:${process.env.INBOX_PASSWORD || ''}`).toString('base64');
const SUPABASE_URL = 'https://oqvmiozafgogfcclwseu.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9xdm1pb3phZmdvZ2ZjY2x3c2V1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4MTg4MDQsImV4cCI6MjA5NzM5NDgwNH0.egzH4uyVJ0W1mj0dTJuJGIWTXXnur9B4z_f12Z8V1lQ';

async function verificarSesion(req) {
  const token = req.headers['x-crm-token'];
  if (!token) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
    });
    return r.ok;
  } catch { return false; }
}

module.exports = async function handler(req, res) {
  const autorizado = await verificarSesion(req);
  if (!autorizado) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  // path after /api/bandeja → forward to /bandeja/api/...
  const sub = (req.url || '').replace(/^\/api\/bandeja/, '') || '/';
  const target = `${RAILWAY}/bandeja/api${sub}`;

  const headers = {
    Authorization: `Basic ${BASIC}`,
    'Content-Type': 'application/json',
  };

  const opts = { method: req.method, headers };
  if (req.method === 'POST') {
    opts.body = JSON.stringify(req.body);
  }

  try {
    const upstream = await fetch(target, opts);
    const text = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    res.status(upstream.status).send(text);
  } catch (e) {
    res.status(502).json({ error: 'proxy error', detail: e.message });
  }
};
