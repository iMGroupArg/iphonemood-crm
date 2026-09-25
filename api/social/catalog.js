// GET /api/social/catalog — catálogo para que ChatGPT arme placas de Instagram.
//
// Filtros opcionales:
//   ?available=true|false   disponibilidad (unidades > 0)
//   ?generation=16          generación parseada de `modelo`
//   ?model=pro max          coincidencia parcial, sin distinguir mayúsculas
//
// Orden: generación más nueva primero, después Pro Max > Pro > Plus > base > Mini.

const { limitar } = require('../_ratelimit.js');
const { ordenar, aProducto, designContext, contexto, puertaDeEntrada, cabeceras } = require('../_social.js');

module.exports = async function handler(req, res) {
  if (!puertaDeEntrada(req, res, limitar)) return;

  let q;
  try { q = new URL(req.url, 'http://localhost').searchParams; }
  catch { q = new URLSearchParams(); }

  let ctx;
  try {
    ctx = await contexto();
  } catch (e) {
    // Nunca un catálogo a medias: si la lectura falla, que se note.
    console.error('social/catalog: falló la carga —', e.message);
    res.status(502).json({ error: 'No se pudo consultar el catálogo' });
    return;
  }

  let items = ctx.filas.map(p => aProducto(p, ctx));

  const disp = (q.get('available') || '').trim().toLowerCase();
  if (disp === 'true' || disp === '1')  items = items.filter(p => p.available);
  if (disp === 'false' || disp === '0') items = items.filter(p => !p.available);

  const gen = q.get('generation');
  if (gen != null && gen !== '') {
    const n = Number(gen);
    if (isFinite(n)) items = items.filter(p => p.generation === n);
  }

  const modelo = (q.get('model') || '').trim().toLowerCase();
  if (modelo) items = items.filter(p => (p.model || '').toLowerCase().includes(modelo));

  cabeceras(res);
  res.status(200).json({
    updated_at: new Date().toISOString(),
    exchange_rate_ars: ctx.tipoCambio,
    design_context: designContext(ctx.financiacion),
    count: items.length,
    products: ordenar(items),
  });
};
