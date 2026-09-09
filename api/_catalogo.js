// Lógica compartida por las funciones que sirven catálogo (`compartir` y
// `sitemap`).
//
// Vive en un archivo aparte porque antes estaba copiada en los dos, y ya se
// desincronizó una vez: el slug tiene que dar EXACTAMENTE lo mismo que
// `precios.js` o el sitemap manda a Google a páginas que no existen.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://oqvmiozafgogfcclwseu.supabase.co';
// No es un secreto: es la misma clave que el sitio le entrega a cualquier
// visitante en /config.js. Lo que protege los datos es RLS.
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9xdm1pb3phZmdvZ2ZjY2x3c2V1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4MTg4MDQsImV4cCI6MjA5NzM5NDgwNH0.egzH4uyVJ0W1mj0dTJuJGIWTXXnur9B4z_f12Z8V1lQ';

async function supa(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_ANON,
      Authorization: `Bearer ${SUPABASE_ANON}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

// Rubros que la landing publica hoy. Se elige desde el CRM (Panel → Landing
// pública) y se guarda en configuracion.landing_categorias.
//
// Es CLAVE respetarlo acá: si el sitemap ofrece un accesorio que la web no
// muestra, Google lo indexa, el visitante hace clic y aterriza en el catálogo
// general. Para Google eso son cien páginas con el mismo contenido, que es
// justo lo que hunde el posicionamiento en vez de mejorarlo.
const GRUPOS = { perfumeria: ['perfumeria', 'decant', 'combo'] };
const FALLBACK = ['iphone'];

function catsDe(id) { return GRUPOS[id] || [id]; }

async function catsPublicadas() {
  try {
    const d = await supa('/rest/v1/configuracion?select=valor&clave=eq.landing_categorias');
    const lista = d && d[0] ? JSON.parse(d[0].valor) : null;
    const base = Array.isArray(lista) && lista.length ? lista : FALLBACK;
    return new Set(base.flatMap(catsDe));
  } catch {
    return new Set(FALLBACK.flatMap(catsDe));
  }
}

// ── Slug: copia exacta del criterio de precios.js ──
const CATS_IDENT_NOMBRE = new Set(['perfumeria','decant','combo','accesorio','repuesto','herramienta','gaming','otro']);

function slugify(s) {
  return (s || '').toString().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’´`ʼ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function usaNombre(p) { return CATS_IDENT_NOMBRE.has(p.categoria) || !p.modelo; }
function identidadProd(p) { return (usaNombre(p) ? (p.nombre || p.modelo) : (p.modelo || p.nombre)) || ''; }
function cond(p) {
  const e = (p.estado_producto || '').toLowerCase();
  return (e.includes('sellado') || e.includes('sealed')) ? 'sellado' : (e.includes('nuevo') ? 'nuevo' : 'usado');
}
function slugProd(p) {
  const partes = usaNombre(p)
    ? [p.categoria, identidadProd(p), cond(p)]
    : [identidadProd(p), p.storage, p.color, cond(p)];
  return slugify(partes.filter(Boolean).join(' '));
}

// Productos que la web realmente muestra.
async function productosPublicados() {
  const [filas, cats] = await Promise.all([
    supa('/rest/v1/stock_publico?select=*'),
    catsPublicadas(),
  ]);
  return (filas || []).filter(p => cats.has(p.categoria));
}

module.exports = { SUPABASE_URL, SUPABASE_ANON, supa, catsDe, catsPublicadas,
                   slugify, usaNombre, identidadProd, cond, slugProd, productosPublicados };
