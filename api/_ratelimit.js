// Límite de peticiones simple, en memoria, por IP + ruta (ventana deslizante).
//
// Honestidad sobre el alcance: en Vercel cada instancia serverless tiene su
// propia memoria, así que el contador no es global — un atacante repartido
// entre instancias puede superar el número nominal. Para un límite duro haría
// falta un almacén compartido (Upstash/Redis), que hoy no está en el stack.
// Aun así, esta capa corta en seco el caso real: un mismo origen martillando
// un endpoint (fuerza bruta de token en /api/bandeja, scraping del proxy).
const ventanas = new Map();
const MAXIMO_ENTRADAS = 5000; // tope de IPs recordadas, para no crecer sin fin

function limitar(req, res, { max = 60, ventanaMs = 60_000 } = {}) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || 'desconocida';
  const clave = `${ip}`;
  const ahora = Date.now();

  let marcas = ventanas.get(clave) || [];
  marcas = marcas.filter(t => ahora - t < ventanaMs);

  if (marcas.length >= max) {
    const retry = Math.ceil((ventanaMs - (ahora - marcas[0])) / 1000);
    res.setHeader('Retry-After', String(retry));
    res.status(429).json({ error: 'Demasiadas peticiones. Probá de nuevo en un rato.' });
    return false;
  }

  marcas.push(ahora);
  ventanas.set(clave, marcas);
  if (ventanas.size > MAXIMO_ENTRADAS) {
    // se descarta la entrada más vieja; suficiente para acotar memoria
    ventanas.delete(ventanas.keys().next().value);
  }
  return true;
}

module.exports = { limitar };
