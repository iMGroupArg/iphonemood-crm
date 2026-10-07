// Publicaciones de Mercado Libre y su vínculo con el stock.
//
//   GET    ?cuenta=<id>[&offset=<n>][&estado=active|paused]   lista los avisos de la cuenta (20 por página)
//   GET    ?cuenta=<id>&item=<MLA…>                            un aviso por id (para llegar desde una orden,
//                                                               aunque ya esté cerrado y no figure en el listado)
//   POST   {cuenta, item, variacion|null, stock_id, version|null}   vincula (o cambia el vínculo)
//   DELETE {cuenta, item, variacion|null, version}                  desvincula
//
// Siempre con sesión del CRM (`x-crm-token`, usuario activo en usuarios_autorizados). Los datos de Mercado Libre
// los trae ESTE servidor con el token de la cuenta: el navegador sólo manda ids y recibe una vista saneada, sin
// tokens. Al vincular se vuelve a consultar el aviso a Mercado Libre y se guarda lo que ÉL dice (título, cantidad),
// no lo que mande el navegador. `vinculado_por` sale de la sesión, nunca del cuerpo.
//
// Plan: docs/meli-vincular-plan.md. Esquema y RPC: db/pendientes/meli_vincular.sql.

const { limitar } = require('../_ratelimit.js');
const M = require('../_meli.js');
const I = require('../_meli_items.js');

// Debe coincidir con `functions` en vercel.json.
const MAX_DURATION_S = 30;
const PRESUPUESTO_MS = 24_000;     // lo que se puede gastar en TOTAL, contado desde que entra el handler
const RESERVA_MS = 4_000;          // tramo final reservado para guardar (RPC); las consultas se cortan antes
const POR_PAGINA = 20;
const TOPE_OFFSET = 950;           // la búsqueda de Mercado Libre llega hasta 1000 resultados
const MAX_CUERPO = 2_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Errores de la base que significan algo para el usuario → estado HTTP y código estable.
const ERRORES_RPC = {
  VINCULO_CAMBIO_CONCURRENTE: 409, VINCULO_INEXISTENTE: 404,
  A_PEDIDO_NO_SE_VINCULA: 422, STOCK_CON_IMEI: 422, STOCK_INEXISTENTE: 422,
  ITEM_INVALIDO: 400, VARIACION_INVALIDA: 400, CUENTA_INEXISTENTE: 404,
};

class ErrorEntrada extends Error {
  constructor(estado, codigo) { super(codigo); this.estado = estado; this.codigo = codigo; }
}

// Cuál de las dos formas del lote funcionó la última vez (por instancia; sólo es un atajo).
let formatoLote = 'items';

// ── Validación de entradas ──────────────────────────────────────────────────
function unico(q, clave) {
  const v = q[clave];
  if (Array.isArray(v)) throw new ErrorEntrada(400, 'PARAMETRO_REPETIDO');
  return v;
}

function cuentaDe(v) {
  if (typeof v === 'number' && Number.isInteger(v)) v = String(v);
  if (typeof v !== 'string' || !/^[1-9]\d{0,9}$/.test(v) || Number(v) > 2147483647) throw new ErrorEntrada(400, 'CUENTA_INVALIDA');
  return Number(v);
}

function versionDe(v, { obligatoria }) {
  if (v === null || v === undefined || v === '') {
    if (obligatoria) throw new ErrorEntrada(400, 'VERSION_REQUERIDA');
    return null;
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1_000_000_000) throw new ErrorEntrada(400, 'VERSION_INVALIDA');
  return v;
}

function variacionDe(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') v = Number.isSafeInteger(v) ? String(v) : null;
  if (!I.idNumValido(v)) throw new ErrorEntrada(400, 'VARIACION_INVALIDA');
  return v;
}

function cuerpoDe(req) {
  let b = req.body;
  if (typeof b === 'string') {
    if (b.length > MAX_CUERPO) throw new ErrorEntrada(413, 'CUERPO_GRANDE');
    try { b = JSON.parse(b); } catch { throw new ErrorEntrada(400, 'CUERPO_INVALIDO'); }
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ErrorEntrada(400, 'CUERPO_INVALIDO');
  let largo = 0;
  try { largo = JSON.stringify(b).length; } catch { /* imposible desde JSON */ }
  if (largo > MAX_CUERPO) throw new ErrorEntrada(413, 'CUERPO_GRANDE');
  return b;
}

// ── Mercado Libre ───────────────────────────────────────────────────────────
async function infoCuenta(cuentaId, presFinal) {
  const c = M.primera(await M.rpc('meli_cuenta_info', { p_cuenta_id: cuentaId }, presFinal));
  if (!c || !c.activa || !I.idNumValido(String(c.meli_user_id))) throw new ErrorEntrada(404, 'CUENTA_NO_ENCONTRADA');
  return c;
}

async function aviso(cuentaId, id, vendedor, pres) {
  const r = await M.meliGet(cuentaId, I.rutaItem(id), pres);
  if (r.status === 404) throw new ErrorEntrada(404, 'AVISO_NO_ENCONTRADO');
  if (!r.ok) throw new M.ErrorMeli('MELI_HTTP', `item: HTTP ${r.status}`, { status: r.status });
  const s = I.sanear(r.json);
  if (!s) throw new I.ErrorItems('RESPUESTA_INESPERADA', 'aviso con forma inesperada');
  // El aviso tiene que ser de ESTA cuenta: un id mal tipeado o ajeno nunca debe llegar a guardarse.
  if (s.item.vendedor !== String(vendedor)) throw new ErrorEntrada(404, 'AVISO_NO_ES_DE_LA_CUENTA');
  return s;
}

async function detalles(cuentaId, ids, pres) {
  const orden = formatoLote === 'items' ? ['items', 'bulk'] : ['bulk', 'items'];
  let ultimo = new I.ErrorItems('RESPUESTA_INESPERADA', 'lote sin respuesta');
  for (const f of orden) {
    const r = await M.meliGet(cuentaId, I.rutaLote(ids, f), pres);
    if (r.ok) {
      try { const el = I.parsearLote(r.json); formatoLote = f; return el; } catch (e) { ultimo = e; }
    } else {
      ultimo = new M.ErrorMeli('MELI_HTTP', `lote ${f}: HTTP ${r.status}`, { status: r.status });
      if (r.status === 429 || r.status >= 500) break;     // Mercado Libre caído o limitando: no insistir con otra forma
    }
  }
  throw ultimo;
}

// ── GET ─────────────────────────────────────────────────────────────────────
async function listar(req, pres, presFinal) {
  const cuentaId = cuentaDe(unico(req.query || {}, 'cuenta'));
  const item = unico(req.query || {}, 'item');
  const c = await infoCuenta(cuentaId, presFinal);

  if (item !== undefined) {
    if (!I.idItemValido(item)) throw new ErrorEntrada(400, 'ITEM_INVALIDO');
    const s = await aviso(cuentaId, item, c.meli_user_id, pres);
    return { total: 1, offset: 0, items: [I.publico(s.item)], errores: [] };
  }

  const estadoQ = unico(req.query || {}, 'estado');
  const estado = estadoQ === undefined ? 'active' : estadoQ;
  if (!I.ESTADOS_LISTADO.includes(estado)) throw new ErrorEntrada(400, 'ESTADO_INVALIDO');
  const offQ = unico(req.query || {}, 'offset');
  const offset = offQ === undefined ? 0 : (/^\d{1,4}$/.test(String(offQ)) ? Number(offQ) : NaN);
  if (!Number.isInteger(offset) || offset > TOPE_OFFSET) throw new ErrorEntrada(400, 'OFFSET_INVALIDO');

  const l = await M.meliGet(cuentaId, I.rutaListado(String(c.meli_user_id), estado, offset), pres);
  if (!l.ok) throw new M.ErrorMeli('MELI_HTTP', `listado: HTTP ${l.status}`, { status: l.status });
  const { ids, total } = I.parsearListado(l.json);

  const out = { total, offset, porPagina: POR_PAGINA, items: [], errores: [] };
  if (total > 1000) out.aviso = 'MAS_DE_1000';   // la búsqueda no pasa de 1000 resultados: haría falta search_type=scan
  if (ids.length === 0) return out;

  for (const el of await detalles(cuentaId, ids, pres)) {
    if (el.item) out.items.push(I.publico(el.item)); else out.errores.push({ id: el.id, motivo: el.motivo });
  }
  return out;
}

// ── POST / DELETE ───────────────────────────────────────────────────────────
async function vincular(req, pres, presFinal, email) {
  const b = cuerpoDe(req);
  const cuentaId = cuentaDe(b.cuenta);
  if (!I.idItemValido(b.item)) throw new ErrorEntrada(400, 'ITEM_INVALIDO');
  const variacion = variacionDe(b.variacion);
  if (typeof b.stock_id !== 'string' || !UUID.test(b.stock_id)) throw new ErrorEntrada(400, 'STOCK_INVALIDO');
  const version = versionDe(b.version, { obligatoria: false });

  const c = await infoCuenta(cuentaId, presFinal);
  const { item } = await aviso(cuentaId, b.item, c.meli_user_id, pres);

  // Con variaciones, hay que elegir UNA que exista; sin variaciones, no puede mandarse ninguna.
  let cantidad = item.cantidad;
  // Si alguna variación no se pudo leer no se puede saber si el aviso las tiene todas: no se guarda "sin
  // variaciones" ni una que no se encuentre (podría ser una de las ilegibles).
  if (item.incompleto && (variacion === null || !item.variaciones.some((x) => x.id === variacion))) {
    throw new ErrorEntrada(422, 'VARIACIONES_ILEGIBLES');
  }
  if (item.variaciones.length > 0) {
    if (variacion === null) throw new ErrorEntrada(422, 'VARIACION_REQUERIDA');
    const v = item.variaciones.find((x) => x.id === variacion);
    if (!v) throw new ErrorEntrada(422, 'VARIACION_INEXISTENTE');
    cantidad = v.cantidad;          // la cantidad de la VARIACIÓN elegida, no la del aviso entero
  } else if (variacion !== null) {
    throw new ErrorEntrada(422, 'AVISO_SIN_VARIACIONES');
  }

  const v = await M.rpc('meli_publicacion_vincular', {
    p_cuenta_id: cuentaId, p_item_id: item.id, p_variacion_id: variacion, p_stock_id: b.stock_id,
    p_version_esperada: version, p_titulo: item.titulo,
    p_cantidad: cantidad === null ? null : Math.trunc(cantidad), p_usuario: email,
  }, presFinal);
  return { ok: true, version: v };
}

async function desvincular(req, presFinal, email) {
  const b = cuerpoDe(req);
  const cuentaId = cuentaDe(b.cuenta);
  if (!I.idItemValido(b.item)) throw new ErrorEntrada(400, 'ITEM_INVALIDO');
  const variacion = variacionDe(b.variacion);
  const version = versionDe(b.version, { obligatoria: true });
  // NO consulta a Mercado Libre: un vínculo viejo de un aviso que ya no existe tiene que poder limpiarse.
  const v = await M.rpc('meli_publicacion_desvincular', {
    p_cuenta_id: cuentaId, p_item_id: b.item, p_variacion_id: variacion,
    p_version_esperada: version, p_usuario: email,
  }, presFinal);
  return { ok: true, version: v };
}

function codigoRpc(e) {
  if (!e || e.codigo !== 'RPC') return null;
  for (const k of Object.keys(ERRORES_RPC)) if (String(e.message).includes(k)) return k;
  return null;
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();                       // el reloj arranca ACÁ, antes de autenticar
  res.setHeader('Cache-Control', 'no-store');
  if (!limitar(req, res, { max: 60, ventanaMs: 60_000 })) return;

  if (!M.configurado()) {
    console.error('meli/publicaciones: faltan variables de entorno de Mercado Libre.');
    res.status(500).json({ error: 'No configurado' });
    return;
  }
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  const email = await M.emailAutorizado(req.headers['x-crm-token'], M.presupuesto(5000));
  if (!email) { res.status(401).json({ error: 'No autorizado' }); return; }

  const limite = t0 + PRESUPUESTO_MS;
  const presFinal = M.presupuestoHasta(limite);                    // incluye la reserva (guardar)
  const pres = M.presupuestoHasta(limite - RESERVA_MS, limite);    // sólo consultas, con el cierre adjunto

  try {
    let salida;
    if (req.method === 'GET') salida = await listar(req, pres, presFinal);
    else if (req.method === 'POST') salida = await vincular(req, pres, presFinal, email);
    else salida = await desvincular(req, presFinal, email);
    res.status(200).json(salida);
  } catch (e) {
    if (e instanceof ErrorEntrada) { res.status(e.estado).json({ error: e.codigo }); return; }
    const k = codigoRpc(e);
    if (k) { res.status(ERRORES_RPC[k]).json({ error: k }); return; }
    // Nada de lo que diga Mercado Libre o la base llega al navegador: sólo un código estable.
    console.error('meli/publicaciones:', e.codigo || '', e.message);
    if (e instanceof I.ErrorItems) { res.status(502).json({ error: e.codigo }); return; }
    if (e && e.codigo === 'CUENTA_BLOQUEADA') { res.status(409).json({ error: 'CUENTA_BLOQUEADA' }); return; }
    if (e && e.status === 429) { res.status(503).json({ error: 'MELI_LIMITANDO' }); return; }
    res.status(502).json({ error: 'NO_SE_PUDO_CONSULTAR' });
  }
};

module.exports.MAX_DURATION_S = MAX_DURATION_S;
