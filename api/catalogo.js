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

const crypto = require('crypto');
const { limitar } = require('./_ratelimit.js');
const { supa, cond, catsDe, usaNombre, productosPublicados } = require('./_catalogo.js');

const CLAVE = process.env.BOT_CATALOGO_KEY;

// Comparación en tiempo constante. Se hashean los dos lados antes de comparar
// por dos razones: `timingSafeEqual` explota si los buffers miden distinto, y
// comparar los hashes (siempre 32 bytes) evita que el tiempo de respuesta
// delate el largo de la clave real.
function claveValida(recibida) {
  if (!recibida || typeof recibida !== 'string') return false;
  const a = crypto.createHash('sha256').update(recibida).digest();
  const b = crypto.createHash('sha256').update(CLAVE).digest();
  return crypto.timingSafeEqual(a, b);
}

// El bot arma el "GB" él mismo, así que la capacidad viaja como número pelado.
//
// OJO con el 1TB: sacar el sufijo a lo bruto lo convertiría en "1" y el cliente
// leería "1GB" en vez de 1TB. Hay un iPhone 13 Pro Dorado de 1TB en stock, no es
// hipotético. Por eso se convierte a GB en vez de recortar texto.
//
// Si el formato no se reconoce se devuelve crudo: es preferible que el bot vea
// algo raro a que nosotros inventemos un número.
function capacidadEnGB(storage) {
  if (storage == null) return null;
  const s = String(storage).trim();
  if (!s) return null;

  const m = s.match(/^(\d+(?:[.,]\d+)?)\s*(TB|GB|MB)?$/i);
  if (!m) return s;

  const n = parseFloat(m[1].replace(',', '.'));
  if (!isFinite(n)) return s;

  const unidad = (m[2] || 'GB').toUpperCase();
  const gb = unidad === 'TB' ? n * 1024 : unidad === 'MB' ? n / 1024 : n;
  return String(Math.round(gb));
}

// `storage` NO significa almacenamiento en todos los rubros: en perfumería y
// decant guarda la concentración (EDP/EDT), y en repuestos el modelo compatible.
// Convertir eso a GB sería destruir el dato. `usaNombre()` es el mismo helper
// que ya usan la landing y el CRM para distinguir los rubros de nombre libre.
function capacidadDe(p) {
  return usaNombre(p) ? (p.storage ?? null) : capacidadEnGB(p.storage);
}

// El tipo de cambio que el CRM actualiza a diario. El bot arma TODOS los precios
// a partir de él, así que sin este dato su catálogo queda vacío: si no se puede
// leer, es mejor un 502 honesto que una respuesta que el bot va a descartar.
async function tipoCambio() {
  const d = await supa('/rest/v1/configuracion?select=valor&clave=eq.ref_blue');
  const n = Number(d && d[0] && d[0].valor);
  if (!isFinite(n) || n <= 0) throw new Error('ref_blue inválido o ausente');
  return n;
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
  if (!CLAVE) {
    console.error('Falta la variable de entorno BOT_CATALOGO_KEY.');
    res.status(500).json({ error: 'El catálogo no está configurado en el servidor.' });
    return;
  }

  if (!claveValida(req.headers['x-catalogo-key'])) {
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

  let cotiz;
  try {
    cotiz = await tipoCambio();
  } catch (e) {
    console.error('catalogo: no se pudo leer el tipo de cambio —', e.message);
    res.status(502).json({ error: 'No se pudo leer el tipo de cambio' });
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
  res.setHeader('Vary', 'x-catalogo-key');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({
    actualizado: new Date().toISOString(),
    tipoCambio: cotiz,
    productos,
  });
};
