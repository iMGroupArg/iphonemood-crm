// Vista previa correcta al compartir un link por WhatsApp / redes.
//
// El problema: WhatsApp, Facebook e Instagram leen las etiquetas og: con un
// bot que NO ejecuta JavaScript. En precios.html la foto del producto la
// resuelve el navegador después de cargar, así que el bot solo alcanzaba a
// ver el og:image fijo del HTML — el logo — para cualquier producto.
//
// Esta función devuelve el MISMO precios.html pero con og:title/description/
// image ya reemplazados según lo que se está compartiendo. Solo se activa
// cuando el link trae ?p= o ?presupuesto=; la home y el resto siguen siendo
// estáticos y no pagan esta latencia.
const { limitar } = require('./_ratelimit.js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://oqvmiozafgogfcclwseu.supabase.co';
// La clave anónima va como respaldo igual que la URL de arriba. No es un
// secreto: es exactamente la misma que el sitio le entrega a cualquier
// visitante en /config.js, y lo único que habilita es leer lo que ya es
// público (la vista `stock_publico` y un presupuesto por su token). Lo que
// protege los datos es RLS en la base, no esconder esta cadena.
// La variable de entorno, si está definida, tiene prioridad.
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9xdm1pb3phZmdvZ2ZjY2x3c2V1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4MTg4MDQsImV4cCI6MjA5NzM5NDgwNH0.egzH4uyVJ0W1mj0dTJuJGIWTXXnur9B4z_f12Z8V1lQ';

// ── Copia de la lógica de slug de precios.html ──
// Tiene que dar EXACTAMENTE lo mismo que `slugify`/`slugProd` de la landing:
// si se cambia una, hay que cambiar la otra o la vista previa deja de
// encontrar el producto (y cae al logo, que es el comportamiento de antes).
const CATS_IDENT_NOMBRE = new Set(['perfumeria','decant','combo','accesorio','repuesto','herramienta','gaming','otro']);

function slugify(s) {
  return (s || '').toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
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
function nombreCandidatos(p) {
  const modelo = slugify(identidadProd(p));
  if (!modelo) return [];
  const color = usaNombre(p) ? '' : slugify(p.color);
  const sto = usaNombre(p) ? '' : slugify(p.storage);
  const base = [];
  if (color && sto) base.push(`${modelo}-${sto}-${color}`);
  if (color) base.push(`${modelo}-${color}`);
  base.push(modelo);
  const sinTamano = modelo.replace(/-\d+(?:-\d+)?-?ml\b/g, '').replace(/-+$/, '');
  if (sinTamano && sinTamano !== modelo) base.push(sinTamano);
  const cat = slugify(p.categoria);
  const nombres = cat ? [...base.map(n => `${cat}-${n}`), ...base] : base;
  return nombres.flatMap(n => [`${n}.png`, `${n}.jpg`]);
}

async function supa(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return r.ok ? r.json() : null;
}

// Devuelve la URL pública de la foto, o null si no hay ninguna subida.
async function fotoDe(p, archivos) {
  const cands = nombreCandidatos(p);
  const hit = cands.find(c => archivos.has(c.toLowerCase()));
  return hit ? `${SUPABASE_URL}/storage/v1/object/public/products/${hit}` : null;
}

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Reemplaza el valor de una meta ya existente, sin agregar duplicados.
function setMeta(html, prop, valor) {
  const re = new RegExp(`(<meta property="${prop}" content=")[^"]*(">)`);
  return re.test(html) ? html.replace(re, `$1${esc(valor)}$2`) : html;
}

module.exports = async function handler(req, res) {
  if (!limitar(req, res, { max: 120, ventanaMs: 60_000 })) return;

  const url = new URL(req.url, `https://${req.headers.host}`);
  const origen = `https://${req.headers.host}`;

  // El HTML base se pide al propio sitio: /precios.html sirve el archivo
  // estático sin pasar por acá, así que no hay bucle.
  let html;
  try {
    const r = await fetch(`${origen}/precios.html`);
    html = await r.text();
  } catch {
    res.status(302).setHeader('Location', '/precios.html').end();
    return;
  }

  try {
    if (!SUPABASE_ANON) throw new Error('sin anon key');
    const slug = url.searchParams.get('p');
    const token = url.searchParams.get('presupuesto');

    let titulo = null, desc = null, foto = null;

    if (slug || token) {
      const lista = await supa('/storage/v1/object/list/products', {
        method: 'POST', body: JSON.stringify({ prefix: '', limit: 1000 }),
      });
      const archivos = new Set((lista || []).map(f => (f.name || '').toLowerCase()));

      if (slug) {
        const filas = await supa('/rest/v1/stock_publico?select=*') || [];
        const p = filas.find(x => slugProd(x) === slug);
        if (p) {
          titulo = `${p.nombre || p.modelo} — iPhone Mood`;
          desc = `USD ${p.precio_usd}. ${[p.storage, p.color, p.estado_producto].filter(Boolean).join(' · ')}. Stock real con precios actualizados.`;
          foto = await fotoDe(p, archivos);
        }
      } else if (token) {
        const pres = await supa('/rest/v1/rpc/presupuesto_por_token', {
          method: 'POST', body: JSON.stringify({ p_token: token }),
        });
        if (pres && pres.producto) {
          const prod = pres.producto, ti = pres.trade_in;
          const saldo = Math.max(0, (prod.precio_usd || 0) - (ti ? ti.valor_usd || 0 : 0));
          titulo = `Presupuesto: ${prod.nombre} — iPhone Mood`;
          desc = ti
            ? `Entregando tu ${ti.modelo}, tu saldo queda en USD ${saldo}. Mirá el detalle y las cuotas.`
            : `USD ${saldo}. Mirá el detalle y las formas de pago.`;
          foto = await fotoDe(prod, archivos);
        }
      }
    }

    if (titulo) {
      html = setMeta(html, 'og:title', titulo);
      html = html.replace(/(<title>)[^<]*(<\/title>)/, `$1${esc(titulo)}$2`);
    }
    if (desc) html = setMeta(html, 'og:description', desc);
    if (foto) {
      html = setMeta(html, 'og:image', foto);
      // `summary_large_image` hace que la foto salga grande en vez de miniatura.
      html = html.replace(/(<meta name="twitter:card" content=")[^"]*(">)/, '$1summary_large_image$2');
    }
  } catch (e) {
    // Cualquier problema: se sirve la página tal cual, con el logo. Nunca
    // se rompe el link por culpa de la vista previa.
    console.error('compartir:', e.message);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // 5 min en el CDN: los bots de WhatsApp cachean igual, y si cambia el
  // stock la próxima vista previa ya sale con el dato nuevo.
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  res.status(200).send(html);
};
