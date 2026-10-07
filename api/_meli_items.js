// Adaptador de los AVISOS (publicaciones) de Mercado Libre.
//
// Todo lo que depende de la forma exacta de la API de Mercado Libre vive ACÁ, para que si la forma
// cambia (o resulta distinta de la que se conoce) se arregle en un solo archivo. Los nombres de campo
// NO se pudieron verificar contra la documentación (devuelve 403 a acceso automático): por eso el
// parseo es tolerante y falla con códigos claros. La primera llamada real es la verificación.
//
// Plan y razones: docs/meli-vincular-plan.md (aprobado por Codex en 4 rondas).
//
// Lo que se conoce y se usa:
//   · Listado:  GET /users/{seller}/items/search?status=…&limit=…&offset=…  →  { results:[ids], paging:{total} }
//   · Detalle en lote: dos formas posibles. Se prueba una y, si falla por forma o por 4xx, la otra:
//       "items": GET /items?ids=A,B,C&attributes=…        → [ { code, body } … ]
//       "bulk":  GET /items/bulk?ids=A,B,C&attributes=…   → [ { id, status_code, body } … ]
//   · Aviso con variaciones: body.variations[] con id, available_quantity, price, attribute_combinations[].
//
// Todo lo que sale de acá hacia el navegador está SANEADO: ids como cadenas validadas, textos sin
// caracteres de control y acotados, URLs con hostname verificado. Nada de tokens ni de cuerpos de error.

const ID_ITEM = /^ML[A-Z]\d{5,15}$/;
const ID_NUM  = /^\d{1,20}$/;

const ATRIBUTOS = ['id', 'title', 'price', 'status', 'available_quantity', 'seller_id', 'permalink', 'thumbnail', 'variations'];
const ESTADOS_LISTADO = ['active', 'paused'];
const ESTADOS_CONOCIDOS = ['active', 'paused', 'closed', 'under_review', 'inactive'];

const DOMINIOS_PERMALINK = ['mercadolibre.com.ar'];
const DOMINIOS_MINIATURA = ['mlstatic.com'];

const MAX_TITULO = 200;
const MAX_ETIQUETA = 120;
const MAX_VARIACIONES = 200;

class ErrorItems extends Error {
  constructor(codigo, mensaje) { super(mensaje || codigo); this.codigo = codigo; }
}

// ── Validadores ─────────────────────────────────────────────────────────────
const idItemValido = (s) => typeof s === 'string' && ID_ITEM.test(s);
const idNumValido  = (s) => typeof s === 'string' && ID_NUM.test(s);

// Los ids numéricos de Mercado Libre pueden venir como número o como cadena. Como número sólo se aceptan
// si son enteros seguros: más allá de 2^53 JSON.parse ya perdió dígitos y compararíamos otro id.
function idComoCadena(x) {
  if (typeof x === 'string') return ID_NUM.test(x) ? x : null;
  if (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) return String(x);
  return null;
}

// Texto para mostrar: sin caracteres de control NI de formato (los de dirección de texto, como U+202E,
// sirven para disfrazar un título), recortado, nunca null.
function texto(x, max) {
  if (typeof x !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return x.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function numero(x) {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x < 1e12 ? x : null;
}

// Devuelve la URL normalizada si es https (o http de un host permitido, que se sube a https) y su
// hostname es EXACTAMENTE un dominio permitido o un subdominio suyo (no basta con "contiene").
function urlPermitida(url, dominios, { subirAHttps = false } = {}) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 600) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.username || u.password) return null;
  if (u.protocol === 'http:' && subirAHttps) u.protocol = 'https:';
  if (u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase();
  if (!dominios.some((d) => h === d || h.endsWith('.' + d))) return null;
  return u.href;
}

// ── Saneo de un aviso ───────────────────────────────────────────────────────
function etiquetaDe(v) {
  const comb = Array.isArray(v.attribute_combinations) ? v.attribute_combinations.slice(0, 10) : [];
  const partes = comb.map((c) => {
    if (!c || typeof c !== 'object') return '';
    const nombre = texto(c.name, 40), valor = texto(c.value_name, 60);
    return nombre && valor ? `${nombre}: ${valor}` : (valor || nombre);
  }).filter(Boolean);
  return partes.join(', ').slice(0, MAX_ETIQUETA);
}

// Devuelve { item, descartadas } o null si no es un aviso reconocible. `vendedor` es de uso interno del
// servidor (comprobar que el aviso es de la cuenta): `publico()` lo quita.
function sanear(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!idItemValido(raw.id)) return null;

  const variaciones = [];
  let descartadas = 0;
  if (raw.variations !== undefined && raw.variations !== null) {
    if (!Array.isArray(raw.variations)) return null;
    for (const v of raw.variations.slice(0, MAX_VARIACIONES)) {
      const id = v && typeof v === 'object' ? idComoCadena(v.id) : null;
      if (!id) { descartadas++; continue; }
      variaciones.push({ id, etiqueta: etiquetaDe(v) || `Variación ${id}`, cantidad: numero(v.available_quantity), precio: numero(v.price) });
    }
    if (raw.variations.length > MAX_VARIACIONES) descartadas += raw.variations.length - MAX_VARIACIONES;
  }

  const estado = typeof raw.status === 'string' ? raw.status : '';
  return {
    item: {
      id: raw.id,
      titulo: texto(raw.title, MAX_TITULO) || raw.id,
      precio: numero(raw.price),
      estado: ESTADOS_CONOCIDOS.includes(estado) ? estado : 'otro',
      cantidad: numero(raw.available_quantity),
      permalink: urlPermitida(raw.permalink, DOMINIOS_PERMALINK),
      miniatura: urlPermitida(raw.thumbnail, DOMINIOS_MINIATURA, { subirAHttps: true }),
      variaciones,
      // Distinguir "no tiene variaciones" de "tiene y no se pudieron leer todas": si se descartó alguna, el aviso
      // NO se puede vincular como "sin variaciones" (se guardaría un vínculo que nunca coincide con las órdenes).
      incompleto: descartadas > 0,
      vendedor: idComoCadena(raw.seller_id),
    },
    descartadas,
  };
}

const publico = (item) => { const { vendedor, ...resto } = item; return resto; };   // eslint-disable-line no-unused-vars

// ── Rutas (el servidor las arma; nada del navegador entra sin validar) ───────
function rutaListado(vendedor, estado, offset) {
  if (!idNumValido(vendedor)) throw new ErrorItems('VENDEDOR_INVALIDO');
  if (!ESTADOS_LISTADO.includes(estado)) throw new ErrorItems('ESTADO_INVALIDO');
  if (!Number.isInteger(offset) || offset < 0) throw new ErrorItems('OFFSET_INVALIDO');
  return `/users/${vendedor}/items/search?status=${estado}&limit=20&offset=${offset}`;
}

function rutaItem(id) {
  if (!idItemValido(id)) throw new ErrorItems('ITEM_INVALIDO');
  return `/items/${id}`;
}

function rutaLote(ids, formato) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20 || !ids.every(idItemValido)) throw new ErrorItems('IDS_INVALIDOS');
  if (formato === 'bulk') return `/items/bulk?ids=${ids.join(',')}&attributes=${ATRIBUTOS.map((a) => `body.${a}`).join(',')},id,status_code`;
  if (formato === 'items') return `/items?ids=${ids.join(',')}&attributes=${ATRIBUTOS.join(',')}`;
  throw new ErrorItems('FORMATO_INVALIDO');
}

// ── Respuestas ──────────────────────────────────────────────────────────────
function parsearListado(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.results)) throw new ErrorItems('RESPUESTA_INESPERADA', 'listado sin results');
  const ids = json.results.filter(idItemValido);
  const t = json.paging && json.paging.total;
  const total = Number.isSafeInteger(t) && t >= 0 ? t : ids.length;
  return { ids, total, descartados: json.results.length - ids.length };
}

// Acepta las dos formas del lote. Devuelve un elemento por aviso: { id, item, motivo }. Un fallo de UN
// aviso no es "el aviso desapareció": se informa como error de ese elemento.
function parsearLote(json) {
  if (!Array.isArray(json)) throw new ErrorItems('RESPUESTA_INESPERADA', 'lote no es un arreglo');
  return json.slice(0, 20).map((el) => {
    if (!el || typeof el !== 'object') return { id: null, item: null, motivo: 'FORMA_INESPERADA' };
    const codigo = el.code !== undefined ? el.code : el.status_code;
    const body = el.body;
    const idDe = idItemValido(el.id) ? el.id : (body && idItemValido(body.id) ? body.id : null);
    if (codigo !== 200) return { id: idDe, item: null, motivo: Number.isInteger(codigo) ? `HTTP_${codigo}` : 'FORMA_INESPERADA' };
    const s = sanear(body);
    if (!s) return { id: idDe, item: null, motivo: 'FORMA_INESPERADA' };
    return { id: s.item.id, item: s.item, motivo: null, descartadas: s.descartadas };
  });
}

module.exports = {
  ErrorItems, ID_ITEM, ESTADOS_LISTADO,
  idItemValido, idNumValido, idComoCadena, texto, numero, urlPermitida,
  sanear, publico, rutaListado, rutaItem, rutaLote, parsearListado, parsearLote,
};
