// Autenticación compartida de los endpoints de datos (/api/catalogo y
// /api/social/*). Antes estaba copiada en cada uno.
//
// Se acepta la clave por DOS vías a propósito:
//
//   x-catalogo-key: <clave>          — la original, la que usa el bot de Angel
//   Authorization: Bearer <clave>    — la que mandan las Actions de ChatGPT
//
// El motivo del segundo: la autenticación "API Key" de un GPT manda
// `Authorization: Bearer` por defecto, y sólo manda un header propio si el
// usuario elige "Custom" y escribe el nombre exacto. Aceptar las dos evita una
// clase entera de 401 por configuración, sin bajar la seguridad: es la misma
// clave y la misma comparación, sólo cambia dónde viene escrita.

const crypto = require('crypto');

const CLAVE = process.env.BOT_CATALOGO_KEY;

// Comparación en tiempo constante. Se hashean los dos lados antes de comparar
// por dos razones: `timingSafeEqual` explota si los buffers miden distinto, y
// comparar hashes (siempre 32 bytes) evita que el tiempo de respuesta delate
// el largo de la clave real.
function coincide(recibida) {
  if (!CLAVE || !recibida || typeof recibida !== 'string') return false;
  const a = crypto.createHash('sha256').update(recibida).digest();
  const b = crypto.createHash('sha256').update(CLAVE).digest();
  return crypto.timingSafeEqual(a, b);
}

// Node baja los nombres de header a minúscula, así que no hace falta
// contemplar mayúsculas.
function claveDelPedido(req) {
  const h = req.headers || {};

  const propio = h['x-catalogo-key'];
  if (typeof propio === 'string' && propio.trim()) return propio.trim();

  const auth = h.authorization;
  if (typeof auth === 'string' && auth.trim()) {
    const m = auth.trim().match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : auth.trim();
  }
  return '';
}

function hayClaveConfigurada() { return !!CLAVE; }

function autorizado(req) { return coincide(claveDelPedido(req)); }

module.exports = { autorizado, hayClaveConfigurada };
