// GET /api/social/products/:id — un producto puntual, misma forma que en el
// catálogo. El `id` es el de `stock_publico`, el mismo que trae /social/catalog.

const { limitar } = require('../../_ratelimit.js');
const { aProducto, designContext, contexto, puertaDeEntrada, cabeceras } = require('../../_social.js');

module.exports = async function handler(req, res) {
  if (!puertaDeEntrada(req, res, limitar)) return;

  const id = (req.query && req.query.id) ? String(req.query.id) : '';
  if (!id) {
    res.status(400).json({ error: 'Falta el id del producto' });
    return;
  }

  let ctx;
  try {
    ctx = await contexto();
  } catch (e) {
    console.error('social/products: falló la carga —', e.message);
    res.status(502).json({ error: 'No se pudo consultar el catálogo' });
    return;
  }

  const fila = ctx.filas.find(p => String(p.id) === id);
  if (!fila) {
    // 404 y no una respuesta vacía: un producto que se vendió o se despublicó
    // tiene que distinguirse de uno que existe pero sin datos.
    res.status(404).json({ error: 'Producto no encontrado o no publicado' });
    return;
  }

  cabeceras(res);
  res.status(200).json({
    updated_at: new Date().toISOString(),
    exchange_rate_ars: ctx.tipoCambio,
    design_context: designContext(ctx.financiacion),
    product: aProducto(fila, ctx),
  });
};
