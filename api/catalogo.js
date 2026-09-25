// Catálogo para el bot de WhatsApp (repo aparte, corriendo en Railway).
//
// Reemplaza la planilla de Google Sheets que el bot leía antes y que ya no se
// mantiene. Devuelve EXACTAMENTE los productos que la web publica: se apoya en
// `productosPublicados()` de _catalogo.js en vez de rearmar el filtro acá.
// Ese archivo existe justamente porque la lógica ya estaba duplicada una vez y
// se desincronizó — si el bot ofreciera algo que la landing no muestra, o a
// otro precio, el cliente lo ve y nosotros nos enteramos tarde.
//
// Los datos salen de la vista `stock_publico`, no de la tabla `stock`, así que
// por construcción no puede filtrarse ni el costo de compra, ni el proveedor,
// ni los IMEI/números de serie: esas columnas no existen en la vista.
//
// Contrato cerrado con Angel (dev del bot) el 2026-09-09, ronda 2.

const { autorizado, hayClaveConfigurada } = require('./_auth.js');
const { limitar } = require('./_ratelimit.js');
const { supa, cond, catsDe, capacidadDe, productosPublicados } = require('./_catalogo.js');

// El tipo de cambio que el CRM actualiza a diario. El bot arma TODOS los precios
// a partir de él, así que sin este dato su catálogo queda vacío: si no se puede
// leer, es mejor un 502 honesto que una respuesta que el bot va a descartar.
async function tipoCambio() {
  const d = await supa('/rest/v1/configuracion?select=valor&clave=eq.ref_blue');
  const n = Number(d && d[0] && d[0].valor);
  if (!isFinite(n) || n <= 0) throw new Error('ref_blue inválido o ausente');
  return n;
}

// Coeficientes de financiación, tal como están cargados en el panel del CRM
// (Panel → Landing pública → Financiación con tarjeta). Son la MISMA fuente que
// usa la web para mostrar las cuotas, así que el bot y la landing no pueden
// mostrar números distintos.
//
// Cada nivel viaja con su `mostrar`: es el interruptor del panel. Cuando el
// dueño apaga un nivel, el bot deja de ofrecerlo sin que nadie toque código.
// Los niveles apagados viajan igual, con su coeficiente tal cual está — puede
// ser null o un valor raro, y no lo corregimos: `mostrar: false` ya dice que no
// se usa, y maquillarlo escondería un error de carga en vez de mostrarlo.
//
// El bloque va acá adentro y no en un endpoint aparte a pedido del bot: los
// precios y los coeficientes salen de la misma lectura, así que nunca quedan
// de dos momentos distintos.
function nivelesDe(bloque) {
  const cuotas = (bloque && Array.isArray(bloque.cuotas)) ? bloque.cuotas : [];
  const out = {};
  for (const n of [3, 6, 9, 12]) {
    const c = cuotas.find(x => Number(x && x.n) === n);
    out[String(n)] = {
      coef: (c && c.coef != null && isFinite(Number(c.coef))) ? Number(c.coef) : null,
      mostrar: !!(c && c.mostrar),
    };
  }
  return out;
}

async function financiacion() {
  const d = await supa('/rest/v1/configuracion?select=valor&clave=eq.pagos_config');
  const cfg = JSON.parse((d && d[0] && d[0].valor) || 'null');
  if (!cfg) throw new Error('pagos_config ausente');

  const lista = Number(cfg.lista_factor);
  // Sin el factor de lista no hay forma de calcular ni una cuota. El bot pidió
  // explícitamente que el bloque llegue siempre completo y que, si falta algo,
  // sea un error de lectura y no un número inventado: él cae a su copia en
  // caché, que es preferible a cotizar mal.
  if (!isFinite(lista) || lista <= 0) throw new Error('lista_factor inválido');

  return {
    coeficiente_lista: lista,
    vigenciaMacro: (cfg.promo && cfg.promo.vigencia) || null,
    bancarizadas: nivelesDe(cfg.otros),
    macro: nivelesDe(cfg.promo),
  };
}

module.exports = async function handler(req, res) {
  // El rate limit va PRIMERO, antes de mirar la clave: si fuera al revés, un
  // atacante podría probar claves sin límite.
  if (!limitar(req, res, { max: 60, ventanaMs: 60_000 })) return;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  // Sin variable de entorno el endpoint queda cerrado, nunca abierto.
  if (!hayClaveConfigurada()) {
    console.error('Falta la variable de entorno BOT_CATALOGO_KEY.');
    res.status(500).json({ error: 'El catálogo no está configurado en el servidor.' });
    return;
  }

  if (!autorizado(req)) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  // ?categoria=iphone — opcional. Sin el parámetro se devuelve todo lo que la
  // web publica. Se expande con `catsDe` para que ?categoria=perfumeria traiga
  // también decants y combos, igual que agrupa la landing.
  let pedida = '';
  try {
    pedida = (new URL(req.url, 'http://localhost').searchParams.get('categoria') || '')
      .trim().toLowerCase();
  } catch { /* URL rara: se ignora el filtro y se devuelve todo */ }

  let filas;
  try {
    filas = await productosPublicados();
  } catch (e) {
    // Nunca devolver catálogo parcial ni inventado: si Supabase falla, el bot
    // tiene que enterarse y decir "no puedo consultar ahora", no cotizar con
    // datos incompletos.
    console.error('catalogo: falló la consulta a Supabase —', e.message);
    res.status(502).json({ error: 'No se pudo consultar el catálogo' });
    return;
  }

  let cotiz, finan;
  try {
    [cotiz, finan] = await Promise.all([tipoCambio(), financiacion()]);
  } catch (e) {
    console.error('catalogo: no se pudo leer cotización/financiación —', e.message);
    res.status(502).json({ error: 'No se pudo leer el tipo de cambio o la financiación' });
    return;
  }

  if (pedida) {
    const permitidas = new Set(catsDe(pedida));
    filas = filas.filter(p => permitidas.has(p.categoria));
  }

  const productos = filas.map(p => ({
    nombre:      p.nombre,
    categoria:   p.categoria,
    modelo:      p.modelo,
    capacidad:   capacidadDe(p),
    color:       p.color,
    tipo:        cond(p),
    bateria_pct: p.bateria_pct,
    precio_usd:  p.precio_usd,   // CONTADO. El de lista lo calcula el bot (× 1,45)
    stock:       p.unidades,
  }));

  // `private`, no `public`: la respuesta está detrás de una clave, y el cache
  // compartido de Vercel indexa por URL sin mirar los headers. Con `public`,
  // una consulta autenticada quedaría cacheada en el borde y se le podría
  // servir a cualquiera que pegue a /api/catalogo SIN la clave.
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.setHeader('Vary', 'x-catalogo-key, Authorization');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({
    actualizado: new Date().toISOString(),
    tipoCambio: cotiz,
    financiacion: finan,
    productos,
  });
};
