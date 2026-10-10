// "Sonda" de solo lectura: muestra la FORMA de lo que devuelve Mercado Libre (qué campos hay y de qué tipo),
// NUNCA los valores. Sirve para dejar de adivinar los nombres de campo antes de diseñar Ventas y Envíos
// (ver docs/meli-ventas-envios-plan.md, Fase 0). No es una función de Vercel: la atiende api/meli/worker.js
// (POST con { accion: 'sonda', cuenta }, sesión del CRM).
//
// Garantías, y por qué:
//   · Solo GET a Mercado Libre/Pago, y solo a rutas armadas acá con ids numéricos validados. No guarda ni procesa
//     ventas, no encola avisos, no toca stock ni cajas. La base se usa solo para leer el user_id de la cuenta y el
//     token. Como cualquier llamada con token (publicaciones, worker), si el token venció se renueva por el flujo
//     normal y protegido (lease en la base): eso es parte de usar la cuenta, no de la sonda. Se corre con el mismo
//     presupuesto de tiempo con cierre reservado que el resto, para que una renovación nunca quede a medias.
//   · No llama a ningún recurso de facturación (documento del comprador): ni existe en esta lista.
//   · La salida es una LISTA POSITIVA: de cada respuesta salen los nombres de campo y su tipo. Un valor de
//     texto solo se muestra si el campo está en ENUMERADOS (estados, tipos) y además parece un código
//     (sin espacios ni acentos), de modo que un nombre o una dirección no pasan aunque el campo se llamara igual.
//   · Los errores de Mercado Libre se resumen en estado HTTP y un código corto; el mensaje no sale.

const M = require('./_meli.js');

// Campos cuyo valor es un código y no un dato de una persona.
const ENUMERADOS = new Set([
  'status', 'substatus', 'logistic_type', 'mode', 'shipping_mode', 'type', 'fee_payer', 'currency_id',
  'status_detail', 'payment_type', 'payment_method_id', 'payment_type_id', 'operation_type',
  'sub_status', 'listing_type_id', 'condition',
]);
// Un código de estado: palabras en minúscula unidas por guion bajo (ready_to_print), sin dígitos, mayúsculas,
// espacios ni símbolos. Un apodo, un mail o un token no tienen esa forma salvo casualidad.
const CODIGO = /^[a-z]{2,15}(_[a-z]{2,15}){0,3}$/;
// Los nombres de campo de Mercado Libre son snake_case en minúscula. Una clave con otra forma (un mail, un
// nombre, un id) pertenece a un mapa indexado por datos y no se nombra.
const CLAVE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_PROFUNDIDAD = 5;
const MAX_CLAVES = 60;

// Una clave que no es un identificador snake_case no se nombra: un objeto indexado por ids o mails los revelaría.
const claveSegura = (k) => CLAVE.test(k) ? k : '<clave dinámica>';

function forma(v, clave, nivel) {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (nivel >= MAX_PROFUNDIDAD) return `array[${v.length}]`;
    return { '[]': v.length, 'elemento': v.length ? forma(v[0], clave, nivel + 1) : 'vacío' };
  }
  const t = typeof v;
  if (t === 'string') {
    return (ENUMERADOS.has(clave) && CODIGO.test(v)) ? `string:${v}` : 'string';
  }
  if (t === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'object') {
    if (nivel >= MAX_PROFUNDIDAD) return 'object';
    const salida = {};
    const claves = Object.keys(v).slice(0, MAX_CLAVES);
    for (const k of claves) salida[claveSegura(k)] = forma(v[k], k, nivel + 1);
    if (Object.keys(v).length > MAX_CLAVES) salida['…'] = `${Object.keys(v).length - MAX_CLAVES} campos más`;
    return salida;
  }
  return t;
}

// Resumen de una respuesta HTTP: estado y, si falló, un código corto (nunca el mensaje).
function resumen(r, conForma = true) {
  const o = { http: r.status };
  if (!r.ok) {
    const e = r.json && typeof r.json.error === 'string' && /^[a-z_]{1,50}$/.test(r.json.error) ? r.json.error : null;
    if (e) o.error = e;
    return o;
  }
  if (conForma) o.forma = forma(r.json, '', 0);
  return o;
}

async function paso(nombre, fn) {
  try { return { paso: nombre, ...(await fn()) }; }
  catch (e) { return { paso: nombre, fallo: String(e && e.codigo || 'error').slice(0, 40) }; }
}

const idNum = (x) => (x !== null && x !== undefined && /^\d{1,20}$/.test(String(x))) ? String(x) : null;

// pres: presupuesto de tiempo del llamador. Devuelve { ok, pasos: [...] }.
async function sonda({ cuentaId, ordenId }, pres) {
  const pasos = [];

  const info = M.primera(await M.rpc('meli_cuenta_info', { p_cuenta_id: cuentaId }, pres));
  const uid = info && idNum(info.meli_user_id);
  if (!uid || info.activa === false) return { ok: false, error: 'CUENTA_INACTIVA_O_INEXISTENTE', pasos };

  const hace48h = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

  // 1 · Búsqueda por fecha de última actualización: confirma los nombres de parámetro y qué informa `paging`.
  let busq = null;
  pasos.push(await paso('busqueda_por_actualizacion_48h', async () => {
    busq = await M.meliGet(cuentaId,
      `/orders/search?seller=${uid}&sort=date_asc&limit=5&order.date_last_updated.from=${encodeURIComponent(hace48h)}`, pres);
    const o = resumen(busq);
    if (busq.ok && busq.json && busq.json.paging) {
      const p = busq.json.paging;
      o.paging = { total: Number.isFinite(p.total) ? p.total : null, limit: Number.isFinite(p.limit) ? p.limit : null,
                   offset: Number.isFinite(p.offset) ? p.offset : null };
    }
    return o;
  }));

  // 2 · Búsqueda simple (las más recientes): para tener una orden de muestra si la anterior vino vacía.
  let recientes = null;
  pasos.push(await paso('busqueda_recientes', async () => {
    recientes = await M.meliGet(cuentaId, `/orders/search?seller=${uid}&sort=date_desc&limit=5`, pres);
    const o = resumen(recientes, false);
    if (recientes.ok && recientes.json && recientes.json.paging) {
      o.total = Number.isFinite(recientes.json.paging.total) ? recientes.json.paging.total : null;
    }
    return o;
  }));

  // 3 · La orden de muestra: la pedida, o la primera con envío entre los resultados.
  let id = idNum(ordenId);
  if (!id) {
    const filas = [].concat((busq && busq.ok && busq.json && busq.json.results) || [],
                            (recientes && recientes.ok && recientes.json && recientes.json.results) || []);
    const conEnvio = filas.find((o) => o && o.shipping && idNum(o.shipping.id));
    id = idNum((conEnvio || filas[0] || {}).id);
  }
  if (!id) { pasos.push({ paso: 'orden', fallo: 'SIN_ORDEN_DE_MUESTRA' }); return { ok: true, pasos }; }

  let orden = null;
  pasos.push(await paso('orden', async () => {
    const r = await M.meliGet(cuentaId, `/orders/${id}`, pres);
    if (r.ok) orden = r.json;
    return resumen(r);
  }));
  if (!orden) return { ok: true, pasos };

  // 4 · El pago de la orden, en Mercado Pago.
  const pagoId = idNum(orden.payments && orden.payments[0] && orden.payments[0].id);
  if (pagoId) {
    pasos.push(await paso('pago', async () => resumen(await M.mpGet(cuentaId, `/v1/payments/${pagoId}`, pres))));
  } else {
    pasos.push({ paso: 'pago', fallo: 'LA_ORDEN_NO_TRAE_PAGOS' });
  }

  // 5 · El envío y sus costos.
  const envioId = idNum(orden.shipping && orden.shipping.id);
  if (envioId) {
    pasos.push(await paso('envio', async () => resumen(await M.meliGet(cuentaId, `/shipments/${envioId}`, pres))));
    pasos.push(await paso('envio_costos', async () => resumen(await M.meliGet(cuentaId, `/shipments/${envioId}/costs`, pres))));
  } else {
    pasos.push({ paso: 'envio', fallo: 'LA_ORDEN_NO_TRAE_ENVIO' });
  }

  return { ok: true, pasos };
}

module.exports = { sonda, forma, resumen, ENUMERADOS };
