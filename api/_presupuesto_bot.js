// POST /api/presupuesto-bot — el bot de WhatsApp pide un presupuesto del MISMO tipo que los que arma el CRM.
//
// No es una función de Vercel por sí sola (el plan Hobby permite 12 y ya están usadas): la atiende api/catalogo.js cuando entra por
// /api/presupuesto-bot (reescritura en vercel.json, `_f=presupuesto`). Plan y contrato: docs/presupuesto-bot-plan.md.
//
// El bot manda SOLO referencias (la unidad del catálogo, el canje, el contacto). El precio, el dólar, las cuotas y el vencimiento los
// pone el CRM con sus propios datos, dentro de la función de la base `presupuesto_bot_crear`, que valida todo y es idempotente.
//
// Dos secretos, a propósito:
//   · BOT_PRESUPUESTO_KEY (+ BOT_PRESUPUESTO_KEY_NEXT durante una rotación, + BOT_PRESUPUESTO_KEY_TEST para pruebas): la que tiene el bot.
//     Solo abre ESTE endpoint. Distinta de BOT_CATALOGO_KEY.
//   · PRESUPUESTO_RPC_SECRET: la que este servidor le manda a la base. Está solo en Vercel: si la del bot se filtra, no sirve para llamar
//     a la base directamente.
//
// Privacidad: ni el cuerpo ni el contacto ni el nombre se escriben en los logs.

const crypto = require('crypto');
const { limitar } = require('./_ratelimit.js');
const { SUPABASE_URL, SUPABASE_ANON } = require('./_catalogo.js');

const BASE_PUBLICA = process.env.PUBLIC_BASE_URL || 'https://iphonemood.com';
const MAX_CUERPO = 4096;
const TIMEOUT_MS = 8000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAVES_PERMITIDAS = new Set(['unidad', 'cantidad', 'canje', 'cliente', 'contacto_tipo', 'contacto_valor', 'canal', 'idempotencia']);
const CLAVES_CANJE = new Set(['modelo', 'storage', 'estado', 'bateria_pct', 'valor_usd']);

// Comparación en tiempo constante (se comparan los hashes: siempre 32 bytes, así no se delata el largo de la clave real).
function coincide(recibida, esperada) {
  if (!esperada || !recibida || typeof recibida !== 'string') return false;
  const a = crypto.createHash('sha256').update(recibida).digest();
  const b = crypto.createHash('sha256').update(esperada).digest();
  return crypto.timingSafeEqual(a, b);
}

function claveDelPedido(req) {
  const h = req.headers || {};
  const propio = h['x-bot-presupuesto-key'];
  if (typeof propio === 'string' && propio.trim()) return propio.trim();
  const auth = h.authorization;
  if (typeof auth === 'string' && auth.trim()) {
    const m = auth.trim().match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : auth.trim();
  }
  return '';
}

// 'real' | 'prueba' | null. Se comparan TODAS (no se corta en la primera) para que el tiempo no diga cuál coincidió.
function modoDe(recibida) {
  const real = coincide(recibida, process.env.BOT_PRESUPUESTO_KEY);
  const siguiente = coincide(recibida, process.env.BOT_PRESUPUESTO_KEY_NEXT);
  const prueba = coincide(recibida, process.env.BOT_PRESUPUESTO_KEY_TEST);
  if (real || siguiente) return 'real';
  if (prueba) return 'prueba';
  return null;
}

class ErrorCuerpo extends Error {}

// Valida la forma ANTES de molestar a la base. La base vuelve a validar todo (esto es solo cortesía y primera defensa).
function armarPedido(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ErrorCuerpo();
  for (const k of Object.keys(b)) if (!CLAVES_PERMITIDAS.has(k)) throw new ErrorCuerpo();
  if (typeof b.unidad !== 'string' || !UUID.test(b.unidad)) throw new ErrorCuerpo();
  if (typeof b.idempotencia !== 'string' || b.idempotencia.length > 64) throw new ErrorCuerpo();
  if (typeof b.canal !== 'string') throw new ErrorCuerpo();
  // Fuera de rango no se manda a la base: un entero que no entra en un `integer` de Postgres daría un error 22003 que se vería como falla del servidor.
  if (b.cantidad !== undefined && b.cantidad !== null && (!Number.isSafeInteger(b.cantidad) || b.cantidad < 1 || b.cantidad > 1000)) throw new ErrorCuerpo();
  if (b.cliente !== undefined && b.cliente !== null && (typeof b.cliente !== 'string' || b.cliente.length > 80)) throw new ErrorCuerpo();
  for (const k of ['contacto_tipo', 'contacto_valor']) {
    if (b[k] !== undefined && b[k] !== null && (typeof b[k] !== 'string' || b[k].length > 60)) throw new ErrorCuerpo();
  }
  let canje = null;
  if (b.canje !== undefined && b.canje !== null) {
    if (!Array.isArray(b.canje) || b.canje.length > 10) throw new ErrorCuerpo();
    canje = b.canje.map((e) => {
      if (!e || typeof e !== 'object' || Array.isArray(e)) throw new ErrorCuerpo();
      for (const k of Object.keys(e)) if (!CLAVES_CANJE.has(k)) throw new ErrorCuerpo();
      for (const k of ['bateria_pct', 'valor_usd']) if (e[k] !== undefined && (!Number.isSafeInteger(e[k]) || e[k] < 0 || e[k] > 1e6)) throw new ErrorCuerpo();
      return e;
    });
  }
  return {
    p_unidad: b.unidad, p_cantidad: b.cantidad ?? null, p_canje: canje, p_cliente: b.cliente ?? null,
    p_contacto_tipo: b.contacto_tipo ?? null, p_contacto_valor: b.contacto_valor ?? null, p_canal: b.canal, p_idem: b.idempotencia,
  };
}

// Código de la base → estado HTTP. Los 422 y 404 son DEFINITIVOS (reintentar igual no sirve); 429 y 502 son REINTENTABLES.
const ESTADOS = {
  CUERPO_INVALIDO: 400,
  UNIDAD_INEXISTENTE: 404, UNIDAD_VENDIDA: 404, UNIDAD_NO_DISPONIBLE: 404,
  IDEMPOTENCIA_CONFLICTO: 409, IDEMPOTENCIA_VENCIDA: 409,
  CANJE_MODELO_INEXISTENTE: 422, CANJE_CAPACIDAD_INEXISTENTE: 422, CANJE_ESTADO_INVALIDO: 422, CANJE_BATERIA_INVALIDA: 422,
  CANJE_VALOR_INVALIDO: 422, CANJE_VALOR_FUERA_DE_RANGO: 422, CANJE_SIN_REFERENCIA: 422, CANJE_SOBRE_EL_TOPE: 422, CANJE_MAYOR_AL_PRECIO: 422,
  TOPE_DIARIO: 429, DEMASIADOS_PEDIDOS: 429,
  SIN_COTIZACION: 502, SIN_FINANCIACION_VALIDA: 502,
};

// Segundos hasta la medianoche de Argentina (UTC−3, sin horario de verano): cuándo se renueva el cupo diario.
function segundosHastaMedianoche(ahora = Date.now()) {
  const ar = new Date(ahora - 3 * 3600 * 1000);
  const sig = Date.UTC(ar.getUTCFullYear(), ar.getUTCMonth(), ar.getUTCDate() + 1);
  return Math.max(60, Math.ceil((sig - (ahora - 3 * 3600 * 1000)) / 1000));
}

function sanearDetalle(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const o = {};
  const txt = (x, max) => (typeof x === 'string' ? x.slice(0, max) : undefined);
  if (txt(d.recibido, 60) !== undefined) o.recibido = txt(d.recibido, 60);
  if (txt(d.modelo, 60) !== undefined) o.modelo = txt(d.modelo, 60);
  if (Array.isArray(d.validos)) o.validos = d.validos.filter((x) => typeof x === 'string').slice(0, 60).map((x) => x.slice(0, 40));
  for (const k of ['minimo', 'maximo']) if (Number.isFinite(d[k])) o[k] = d[k];
  return Object.keys(o).length ? o : null;
}

async function llamarBase(parametros) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/presupuesto_bot_crear`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_secreto: process.env.PRESUPUESTO_RPC_SECRET, ...parametros }),
      signal: ctl.signal,
      redirect: 'error',
    });
    let json = null;
    try { json = await r.json(); } catch { /* sin cuerpo */ }
    return { ok: r.ok, status: r.status, json };
  } finally {
    clearTimeout(t);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // El límite va PRIMERO, antes de mirar la clave: si fuera al revés, se podrían probar claves sin límite.
  if (!limitar(req, res, { max: 30, ventanaMs: 60_000, ambito: 'presupuesto-bot' })) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'METODO_NO_PERMITIDO' });
    return;
  }

  // Sin claves o sin el secreto de la base, el endpoint queda CERRADO (y se avisa: es un error de configuración, no del bot).
  if (!process.env.BOT_PRESUPUESTO_KEY || !process.env.PRESUPUESTO_RPC_SECRET) {
    console.error('presupuesto-bot: faltan BOT_PRESUPUESTO_KEY o PRESUPUESTO_RPC_SECRET.');
    res.status(500).json({ error: 'NO_CONFIGURADO' });
    return;
  }

  const modo = modoDe(claveDelPedido(req));
  if (!modo) { res.status(401).json({ error: 'NO_AUTORIZADO' }); return; }

  let pedido;
  try {
    // En BYTES (no en caracteres) y también el tamaño declarado del cuerpo original: serializar lo ya parseado le saca espacios y claves repetidas.
    let largo = 0;
    try { largo = Buffer.byteLength(JSON.stringify(req.body === undefined ? null : req.body), 'utf8'); } catch { largo = MAX_CUERPO + 1; }
    const declarado = Number((req.headers || {})['content-length']);
    if (largo > MAX_CUERPO || (Number.isFinite(declarado) && declarado > MAX_CUERPO * 2)) throw new ErrorCuerpo();
    pedido = armarPedido(req.body);
  } catch (e) {
    if (e instanceof ErrorCuerpo) { res.status(400).json({ error: 'CUERPO_INVALIDO' }); return; }
    throw e;
  }
  pedido.p_modo = modo;

  let r;
  try {
    r = await llamarBase(pedido);
  } catch (e) {
    console.error('presupuesto-bot: no se pudo llamar a la base —', e && e.name);
    res.status(502).json({ error: 'ERROR_INTERNO' });
    return;
  }

  if (r.ok && r.json && typeof r.json.token === 'string' && /^[0-9a-f]{32}$/.test(r.json.token)) {
    res.status(200).json({
      token: r.json.token,
      link: `${BASE_PUBLICA}/precios.html?presupuesto=${r.json.token}`,
      vence_en: r.json.vence_en,
      reutilizado: r.json.reutilizado === true,
      modo: r.json.modo === 'prueba' ? 'prueba' : 'real',
    });
    return;
  }

  // La base responde un error con { code, message: 'CODIGO', details? }. Solo se reenvían códigos CONOCIDOS; nada más sale al bot.
  const codigo = r.json && typeof r.json.message === 'string' ? r.json.message.trim() : '';
  if (codigo === 'no autorizado') {
    console.error('presupuesto-bot: la base rechazó PRESUPUESTO_RPC_SECRET (¿no coincide con el hash del script 13?).');
    res.status(500).json({ error: 'CONFIGURACION_INVALIDA' });
    return;
  }
  if (Object.prototype.hasOwnProperty.call(ESTADOS, codigo)) {
    const estado = ESTADOS[codigo];
    if (estado === 429) res.setHeader('Retry-After', String(codigo === 'TOPE_DIARIO' ? segundosHastaMedianoche() : 60));
    const salida = { error: codigo };
    // Lo recibido y lo válido (lista de modelos, capacidades, rango): son datos del catálogo, no datos de personas.
    // `recibido` es texto que mandó el bot: se acota. Solo salen estas claves y con estos tipos.
    if (r.json.details) { try { const d = sanearDetalle(JSON.parse(r.json.details)); if (d) salida.detalle = d; } catch { /* sin detalle */ } }
    res.status(estado).json(salida);
    return;
  }
  // Solo el estado y un código técnico YA VALIDADO (letras mayúsculas y guion bajo): el texto de la base puede traer datos de la persona.
  console.error('presupuesto-bot: respuesta inesperada de la base, estado', r.status, 'código', /^[A-Z_]{3,40}$/.test(codigo) ? codigo : 'DESCONOCIDO');
  res.status(502).json({ error: 'ERROR_INTERNO' });
};

module.exports.armarPedido = armarPedido;
module.exports.ESTADOS = ESTADOS;
module.exports.segundosHastaMedianoche = segundosHastaMedianoche;
