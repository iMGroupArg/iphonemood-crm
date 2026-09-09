// Mapa del sitio para los buscadores.
//
// Se genera al vuelo en vez de mantenerlo a mano: el stock cambia todos los
// días y un sitemap escrito a mano queda desactualizado en una semana,
// mandando a Google a productos que ya se vendieron.
//
// Incluye la home, el blog con cada artículo publicado, y una entrada por
// producto publicado. NO incluye los presupuestos: llevan el precio
// personalizado de un cliente.
const { limitar } = require('./_ratelimit.js');
const { supa, slugProd, productosPublicados } = require('./_catalogo.js');

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

module.exports = async function handler(req, res) {
  if (!limitar(req, res, { max: 30, ventanaMs: 60_000 })) return;

  const base = 'https://iphonemood.com';
  const hoy = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: base + '/', prio: '1.0', freq: 'daily' },
    { loc: base + '/blog', prio: '0.7', freq: 'weekly' },
  ];

  // ── Artículos del blog ──
  // Van con su fecha real de publicación: a diferencia del stock, una nota no
  // cambia todos los días, y decirle a Google que sí la hace parecer contenido
  // reciclado.
  try {
    const notas = await supa('/rest/v1/blog_publico?select=slug,actualizado_en&order=publicado_en.desc&limit=500');
    for (const n of notas || []) {
      if (!n.slug) continue;
      urls.push({
        loc: `${base}/blog/${encodeURIComponent(n.slug)}`,
        prio: '0.7', freq: 'monthly',
        mod: (n.actualizado_en || '').slice(0, 10) || hoy,
      });
    }
  } catch (e) {
    console.error('sitemap blog:', e.message);
  }

  try {
    // Solo los rubros que la web publica hoy: ofrecerle a Google un accesorio
    // que la landing no muestra manda al visitante a una página que no tiene
    // lo que buscaba, y a Google cien URLs con el mismo contenido.
    const filas = await productosPublicados();
    // Un producto puede repetirse en varias filas (mismo modelo, distinta
    // unidad): el slug es el mismo, así que se publica una sola vez.
    const vistos = new Set();
    for (const p of filas) {
      const slug = slugProd(p);
      if (!slug || vistos.has(slug)) continue;
      vistos.add(slug);
      urls.push({ loc: `${base}/?p=${encodeURIComponent(slug)}`, prio: '0.8', freq: 'weekly' });
    }
  } catch (e) {
    // Sin stock igual se devuelve la home: un sitemap con una entrada es
    // mejor que un 500, que Google interpreta como sitio roto.
    console.error('sitemap:', e.message);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${esc(u.loc)}</loc>
    <lastmod>${u.mod || hoy}</lastmod>
    <changefreq>${u.freq}</changefreq>
    <priority>${u.prio}</priority>
  </url>`).join('\n')}
</urlset>`;

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  res.status(200).send(xml);
};
