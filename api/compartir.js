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
// Slug y consultas vienen del módulo compartido: tenerlo copiado acá ya hizo
// que se desincronizara una vez (le faltaba el arreglo del apóstrofe que sí
// tenía la landing, así que "Bade'e" no encontraba su foto).
const { slugify, usaNombre, identidadProd, cond, slugProd,
        productosPublicados } = require('./_catalogo.js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://oqvmiozafgogfcclwseu.supabase.co';
// La clave anónima va como respaldo igual que la URL de arriba. No es un
// secreto: es exactamente la misma que el sitio le entrega a cualquier
// visitante en /config.js, y lo único que habilita es leer lo que ya es
// público (la vista `stock_publico` y un presupuesto por su token). Lo que
// protege los datos es RLS en la base, no esconder esta cadena.
// La variable de entorno, si está definida, tiene prioridad.
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9xdm1pb3phZmdvZ2ZjY2x3c2V1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4MTg4MDQsImV4cCI6MjA5NzM5NDgwNH0.egzH4uyVJ0W1mj0dTJuJGIWTXXnur9B4z_f12Z8V1lQ';

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
//
// Se pide redimensionada a 600px y no el original. Los archivos del bucket son
// PNG de 1200x1200 de hasta 1,2 MB, y WhatsApp descarta la vista previa cuando
// la imagen pesa de más: el link terminaba sin foto, que es justo lo que esta
// función existe para arreglar. A 600px quedan entre 185 y 280 KB.
//
// `resize=contain` es obligatorio: pidiendo solo `width` la foto sale
// aplastada. Y no se fuerza WebP a propósito — el endpoint devuelve PNG a
// quien no lo pida, y los robots de las redes no siempre lo soportan.
const OG_ANCHO = 600;

async function fotoDe(p, archivos) {
  const cands = nombreCandidatos(p);
  const hit = cands.find(c => archivos.has(c.toLowerCase()));
  if (!hit) return null;
  return `${SUPABASE_URL}/storage/v1/render/image/public/products/${encodeURIComponent(hit)}`
       + `?width=${OG_ANCHO}&resize=contain`;
}

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Reemplaza el valor de una meta ya existente, sin agregar duplicados.
// Inserta o reemplaza una etiqueta <meta name="..."> (distinta de las og:,
// que van por `property`).
function setMetaName(html, nombre, valor) {
  const re = new RegExp(`(<meta name="${nombre}" content=")[^"]*(">)`);
  if (re.test(html)) return html.replace(re, `$1${esc(valor)}$2`);
  return html.replace('</head>', `<meta name="${nombre}" content="${esc(valor)}">\n</head>`);
}

function setCanonical(html, url) {
  const re = /<link rel="canonical"[^>]*>/;
  const tag = `<link rel="canonical" href="${esc(url)}">`;
  return re.test(html) ? html.replace(re, tag) : html.replace('</head>', tag + '\n</head>');
}

// Bloque de contenido para los buscadores. Va en <noscript>: quien tiene
// JavaScript ve la ficha real, y quien no lo ejecuta —incluidos los robots
// que no renderizan— lee exactamente lo mismo en texto. No es texto oculto:
// es la misma información que muestra la página.
function bloqueSeo(p, foto) {
  const detalle = [p.storage, p.color, p.estado_producto].filter(Boolean).join(' · ');
  return `<noscript><article>
  <h1>${esc(p.nombre || p.modelo)}</h1>
  ${foto ? `<img src="${esc(foto)}" alt="${esc(p.nombre || p.modelo)}" width="600" height="600">` : ''}
  <p><strong>USD ${esc(p.precio_usd)}</strong></p>
  ${detalle ? `<p>${esc(detalle)}</p>` : ''}
  <p>Disponible en iPhone Mood, Granadero Baigorria. Aceptamos tu usado en parte de pago y financiamos en cuotas.</p>
  <p><a href="/">Ver todo el catálogo</a></p>
</article></noscript>`;
}

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

    let titulo = null, desc = null, foto = null, prodSeo = null;

    if (slug || token) {
      const lista = await supa('/storage/v1/object/list/products', {
        method: 'POST', body: JSON.stringify({ prefix: '', limit: 1000 }),
      });
      const archivos = new Set((lista || []).map(f => (f.name || '').toLowerCase()));

      if (slug) {
        // Solo entre los rubros publicados: si la web no muestra accesorios,
        // la ficha de un accesorio tampoco existe para el visitante, y
        // anunciarla en Google lo llevaría a una página que no la tiene.
        const filas = await productosPublicados();
        const p = filas.find(x => slugProd(x) === slug);
        if (p) {
          prodSeo = p;
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
          const cant = Math.max(1, Number(prod.cantidad) || 1);
          titulo = `Presupuesto: ${prod.nombre}${cant > 1 ? ` × ${cant}` : ''} — iPhone Mood`;
          const nEq = (ti && Array.isArray(ti.equipos)) ? ti.equipos.length : (ti && ti.modelo ? 1 : 0);
          desc = nEq > 1
            ? `Entregando tus ${nEq} equipos, tu saldo queda en USD ${saldo}. Mirá el detalle y las cuotas.`
            : (ti && ti.modelo
              ? `Entregando tu ${ti.modelo}, tu saldo queda en USD ${saldo}. Mirá el detalle y las cuotas.`
              : `USD ${saldo}. Mirá el detalle y las formas de pago.`);
          foto = await fotoDe(prod, archivos);
        }
      }
    }

    if (titulo) {
      html = setMeta(html, 'og:title', titulo);
      html = html.replace(/(<title>)[^<]*(<\/title>)/, `$1${esc(titulo)}$2`);
    }
    if (desc) {
      html = setMeta(html, 'og:description', desc);
      // La misma frase como meta description: es la que Google muestra
      // debajo del título en los resultados.
      html = setMetaName(html, 'description', desc);
    }
    if (foto) {
      html = setMeta(html, 'og:image', foto);
      // `summary_large_image` hace que la foto salga grande en vez de miniatura.
      html = html.replace(/(<meta name="twitter:card" content=")[^"]*(">)/, '$1summary_large_image$2');
    }

    if (prodSeo) {
      // Dirección oficial de esta ficha: evita que el mismo producto se
      // indexe dos veces por llegar con parámetros distintos.
      html = setCanonical(html, `${origen}/?p=${encodeURIComponent(slug)}`);
      // El contenido, en texto, para el que no ejecuta JavaScript.
      html = html.replace(/<body([^>]*)>/, `<body$1>\n${bloqueSeo(prodSeo, foto)}`);
    }

    // Un presupuesto lleva el precio que se le dio a UN cliente. El link es
    // secreto, pero si alguno se filtra no queremos que Google lo publique.
    if (token) {
      html = setMetaName(html, 'robots', 'noindex, nofollow');
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
